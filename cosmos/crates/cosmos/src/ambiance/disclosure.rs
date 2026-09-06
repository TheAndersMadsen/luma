//! Owner policy and one-use provider disclosure under the principal ledger lock.
//! Configuration and transport membership are never disclosure authority.
use super::{PrivacyClass, RuntimeData, RuntimeError, RuntimeState, TurnFence};
use crate::surface_registry::{Binding, Record};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const OWNER_APPROVAL: &str = "approve-speech-provider-disclosure-v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum Provider {
    AzureSpeech { region: String },
}
impl Provider {
    fn valid(&self) -> bool {
        let Self::AzureSpeech { region } = self;
        !region.is_empty()
            && region.len() <= 32
            && region
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    Transcription,
    Synthesis,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub provider: Provider,
    pub maximum_class: PrivacyClass,
    pub transcription: bool,
    pub synthesis: bool,
}
impl Policy {
    fn permits(&self, request: &Request) -> bool {
        self.provider == request.provider
            && request.privacy <= self.maximum_class
            && match request.purpose {
                Purpose::Transcription => self.transcription,
                Purpose::Synthesis => self.synthesis,
            }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub approval_revision: u64,
    pub revision: u64,
    pub policy: Option<Policy>,
}

/// Computed by the runtime from the actual provider payload and provenance.
/// This type is not an HTTP request body. Raw unclassified audio must use the
/// conservative Sensitive class until a runtime-owned transform can attest it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub provider: Provider,
    pub purpose: Purpose,
    pub payload_digest: String,
    pub content_digest: String,
    pub action_id: Option<Uuid>,
    pub privacy: PrivacyClass,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Disclosure {
    pub id: Uuid,
    pub policy_revision: u64,
    pub request: Request,
}

impl RuntimeState {
    /// Only a Pin bound to its authenticated device connection or a native
    /// installation bound to its signed connection can originate a turn whose
    /// reply text is disclosed to the speech provider. Browsers cannot.
    pub(super) fn disclosed_speech_origin(
        records: &BTreeMap<Uuid, Record>,
        turn: &super::state::Turn,
    ) -> bool {
        turn.pin_incarnation.is_some()
            || records
                .get(&turn.fence.origin_surface)
                .is_some_and(|r| matches!(r.binding, Binding::Native { .. }))
    }

    /// Disclosed synthesis plays on the origin itself or on a native surface
    /// approved for speech; the origin's policy still governs the disclosure.
    pub(super) fn disclosed_speech_target(
        records: &BTreeMap<Uuid, Record>,
        origin: Uuid,
        surface_id: Uuid,
    ) -> bool {
        surface_id == origin
            || records.get(&surface_id).is_some_and(|r| {
                !r.revoked
                    && matches!(r.binding, Binding::Native { .. })
                    && r.approved_manifest == crate::surface_registry::native_manifest()
            })
    }

    pub(super) fn disclosure_policy(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
    ) -> Result<Option<Approval>, RuntimeError> {
        let record = records
            .get(&surface)
            .filter(|r| {
                !r.revoked && matches!(r.binding, Binding::Pin { .. } | Binding::Native { .. })
            })
            .ok_or(RuntimeError::InvalidOrigin)?;
        Ok(self
            .disclosure_policies
            .get(&surface)
            .filter(|a| a.approval_revision == record.revision)
            .cloned())
    }

    pub(super) fn set_disclosure_policy(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<Policy>,
    ) -> Result<(Approval, Vec<RuntimeData>), RuntimeError> {
        let current = self.disclosure_policy(records, surface)?;
        if records[&surface].revision != approval_revision
            || current.as_ref().map_or(0, |a| a.revision) != expected_revision
        {
            return Err(RuntimeError::Stale);
        }
        if policy
            .as_ref()
            .is_some_and(|p| !p.provider.valid() || (!p.transcription && !p.synthesis))
        {
            return Err(RuntimeError::InvalidRequest);
        }
        let approval = Approval {
            approval_revision,
            revision: expected_revision
                .checked_add(1)
                .ok_or(RuntimeError::Unavailable)?,
            policy,
        };
        self.disclosure_policies.insert(surface, approval.clone());
        Ok((
            approval.clone(),
            vec![RuntimeData::DisclosurePolicyChanged {
                surface_id: surface,
                approval,
            }],
        ))
    }

    fn check_disclosure_request(
        &self,
        records: &BTreeMap<Uuid, Record>,
        fence: &TurnFence,
        request: &Request,
        now: i64,
        starting: bool,
    ) -> Result<(u64, PrivacyClass), RuntimeError> {
        let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
        if turn.finished
            || turn.voice_pending()
            || turn.fence.origin_surface != fence.origin_surface
            || !Self::disclosed_speech_origin(records, turn)
            || !self.origin_valid(turn, records, now)
        {
            return Err(RuntimeError::Stale);
        }
        if !request.provider.valid()
            || !super::state::digest_valid(&request.payload_digest)
            || !super::state::digest_valid(&request.content_digest)
        {
            return Err(RuntimeError::InvalidRequest);
        }
        match request.purpose {
            Purpose::Synthesis => {
                let action = request
                    .action_id
                    .and_then(|id| self.actions.get(&id))
                    .ok_or(RuntimeError::PolicyBlocked)?;
                if action.turn_id != fence.turn_id
                    || action.generation != fence.generation
                    || action.worker != fence.worker
                    || !Self::disclosed_speech_target(
                        records,
                        fence.origin_surface,
                        action.surface_id,
                    )
                    || action.channel != super::Channel::AudioTts
                    || action.status
                        != if starting {
                            super::ActionStatus::Proposed
                        } else {
                            super::ActionStatus::Dispatched
                        }
                    || action.content_digest != request.content_digest
                    || now >= action.display_expires_at_ms
                {
                    return Err(RuntimeError::Stale);
                }
            }
            Purpose::Transcription => {
                if turn.pin_incarnation.is_none()
                    || request.action_id.is_some()
                    || request.privacy != PrivacyClass::Sensitive
                    || !self.actions.is_empty()
                    || turn.analysis.is_some()
                {
                    return Err(RuntimeError::PolicyBlocked);
                }
            }
        }
        let privacy = turn.privacy.max(request.privacy);
        let mut effective = request.clone();
        effective.privacy = privacy;
        let approval = self
            .disclosure_policy(records, fence.origin_surface)?
            .ok_or(RuntimeError::PolicyBlocked)?;
        if !approval
            .policy
            .as_ref()
            .is_some_and(|p| p.permits(&effective))
        {
            return Err(RuntimeError::PolicyBlocked);
        }
        Ok((approval.revision, privacy))
    }

    pub(super) fn start_disclosure(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        fence: TurnFence,
        mut request: Request,
        id: Uuid,
        now: i64,
    ) -> Result<(Disclosure, Vec<RuntimeData>), RuntimeError> {
        if id.is_nil() {
            return Err(RuntimeError::InvalidRequest);
        }
        let (policy_revision, privacy) =
            self.check_disclosure_request(records, &fence, &request, now, true)?;
        let turn = self.turn.as_ref().unwrap();
        // One upload per purpose per turn. A lost result must not start another
        // provider call; no duplicate caller obtains the original capability.
        if turn
            .disclosures
            .iter()
            .any(|d| d.request.purpose == request.purpose || d.id == id)
        {
            return Err(RuntimeError::Busy);
        }
        // Policy, exact action claim and one-use disclosure commit together.
        // Stock dispatch remains outcome_unknown and cannot authorize this path.
        let mut events = Vec::new();
        if let Some(action_id) = request.action_id {
            let (_, claimed) = self.claim(
                records,
                action_id,
                fence.generation,
                fence.worker,
                now,
                true,
            )?;
            events.extend(claimed);
        }
        let turn = self.turn.as_mut().unwrap();
        turn.privacy = privacy;
        request.privacy = privacy;
        let disclosure = Disclosure {
            id,
            policy_revision,
            request,
        };
        turn.disclosures.push(disclosure.clone());
        events.push(RuntimeData::ProviderDisclosureStarted {
            fence,
            disclosure: disclosure.clone(),
        });
        Ok((disclosure, events))
    }

    pub(super) fn check_disclosure(
        &self,
        records: &BTreeMap<Uuid, Record>,
        fence: &TurnFence,
        disclosure: &Disclosure,
        now: i64,
    ) -> Result<(), RuntimeError> {
        let (revision, _) =
            self.check_disclosure_request(records, fence, &disclosure.request, now, false)?;
        if revision != disclosure.policy_revision
            || !self.turn.as_ref().unwrap().disclosures.iter().any(|d| {
                d.id == disclosure.id
                    && d.policy_revision == revision
                    && d.request == disclosure.request
            })
        {
            return Err(RuntimeError::Stale);
        }
        Ok(())
    }
}
