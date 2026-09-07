//! The confirmation ceremony. A command that changes something needs a
//! logged, unexpired, single-use grant for that exact action instance, and
//! the person who answers is standing at the machine that will act.
//!
//! Nothing here confers authority by position. The venue is the executing
//! installation, the description is composed by policy from the bound command
//! and the owner's own label, and the answer binds to the exact sentence the
//! owner read. The grant is fenced by `(turn_id, generation, worker)`, so a
//! restart mints a new worker, the fence rejects every operation on that turn,
//! and the grant is dropped: unconfirmed is denied.
use super::{
    ActionStatus, Channel, PrivacyClass, RuntimeData, RuntimeError, RuntimeState,
    action::{Attestation, Description, Risk},
};
use crate::surface_registry::Record;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// The clock starts at the confirm frame, not at the proposal: a Pin-origin
/// command would otherwise expire before the owner reached the Mac.
pub const GRANT_MS: i64 = 30_000;
/// At most one ceremony per principal is live, plus room for its own replay.
pub const MAX_GRANTS: usize = 4;

/// What the person answered, and what the platform proved about them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub granted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attestation: Option<Attestation>,
    pub decided_at_ms: i64,
}

/// How a ceremony ended, for the owner's own record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Granted,
    Declined,
    Expired,
    Voided,
}

/// One live ceremony. It is state of the runtime, not of a client: a client
/// holds only the description it was asked to render and the identifiers it
/// echoes back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub id: Uuid,
    pub action_id: Uuid,
    pub turn_id: Uuid,
    pub generation: u64,
    /// The process fence. `AmbianceRuntime::new` mints a fresh worker per
    /// process, so a restart voids every unconsumed grant.
    pub worker: Uuid,
    pub venue_surface: Uuid,
    pub venue_incarnation: Uuid,
    pub description: Description,
    pub description_digest: String,
    pub risk: Risk,
    /// The weakest actor evidence this ceremony accepts. Every Cosmos
    /// manifest declares `actor_unknown`, so a bare tap can never mint high.
    pub required: Attestation,
    pub requested_at_ms: i64,
    pub expires_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<Decision>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub consumed: bool,
}

impl Grant {
    pub fn live(&self, now: i64) -> bool {
        !self.consumed && now < self.expires_at_ms
    }

    /// A granted, unconsumed, unexpired answer with sufficient attestation.
    pub fn usable(&self, now: i64) -> bool {
        self.live(now)
            && self
                .decision
                .is_some_and(|decision| decision.granted && self.attested(&decision))
    }

    fn attested(&self, decision: &Decision) -> bool {
        decision
            .attestation
            .is_some_and(|attestation| attestation >= self.required)
    }
}

/// The attestation a bound risk demands. §4.2 computes authority from the
/// minimum of device, channel and actor trust; with `actor_unknown` declared
/// everywhere, only device-owner authentication can carry a high risk.
pub fn required_attestation(risk: Risk) -> Attestation {
    match risk {
        Risk::High => Attestation::DeviceOwnerAuth,
        Risk::Low | Risk::Moderate => Attestation::ForegroundTap,
    }
}

/// Whether this installation's approved manifest declares a ceremony venue
/// that can obtain this attestation. A television declares none at all.
pub fn venue_declares(record: &Record, required: Attestation) -> bool {
    if !crate::surface_registry::native_declares(record, Channel::ConfirmTap.as_str()) {
        return false;
    }
    let declared = &record.approved_manifest["capabilities"]["output"]
        [Channel::ConfirmTap.as_str()]["attestation"];
    serde_json::to_value(required)
        .ok()
        .zip(declared.as_array())
        .is_some_and(|(required, declared)| declared.contains(&required))
}

impl RuntimeState {
    /// The live grant for one action, if any.
    pub(super) fn grant_for(&self, action_id: Uuid, now: i64) -> Option<&Grant> {
        self.grants
            .values()
            .find(|grant| grant.action_id == action_id && grant.live(now))
    }

    /// Whether this action may be claimed: it needs no ceremony, or its own
    /// ceremony was answered with sufficient attestation and is unconsumed.
    pub(super) fn granted(&self, action_id: Uuid, now: i64) -> bool {
        self.actions.get(&action_id).is_some_and(|action| {
            !action.channel.needs_grant()
                || self
                    .grant_for(action_id, now)
                    .is_some_and(|grant| grant.usable(now))
        })
    }

    /// Mint the ceremony for one waiting action at the installation that will
    /// carry it out. The venue is the executing installation: no authority is
    /// conferred by position and no fifth permission is invented.
    pub(super) fn request_grant(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        venue: Uuid,
        incarnation: Uuid,
        now: i64,
    ) -> Result<Option<(Grant, Vec<RuntimeData>)>, RuntimeError> {
        let Some(turn) = self.turn.as_ref().filter(|t| !t.cancelled && !t.finished) else {
            return Ok(None);
        };
        if now >= turn.lease_until_ms {
            return Ok(None);
        }
        let fence = turn.fence.clone();
        let turn_privacy = turn.privacy;
        let Some(record) = records.get(&venue).filter(|r| !r.revoked) else {
            return Ok(None);
        };
        let Some(action) = self
            .actions
            .values()
            .find(|action| {
                action.surface_id == venue
                    && action.incarnation == incarnation
                    && action.status == ActionStatus::AwaitingGrant
                    && action.turn_id == fence.turn_id
                    && action.generation == fence.generation
                    && now < action.display_expires_at_ms
                    && self.grant_for(action.id, now).is_none()
            })
            .cloned()
        else {
            return Ok(None);
        };
        let super::SemanticIntent::DeviceAction { operation } = &action.intent else {
            return Ok(None);
        };
        let risk = operation.risk();
        let required = required_attestation(risk);
        if !venue_declares(record, required) || self.grants.len() >= MAX_GRANTS {
            return Ok(None);
        }
        let crate::surface_registry::Binding::Native { platform, .. } = &record.binding else {
            return Ok(None);
        };
        let description = operation.description(platform, action.privacy.max(turn_privacy));
        if !description.valid() {
            return Ok(None);
        }
        let grant = Grant {
            id: Uuid::new_v4(),
            action_id: action.id,
            turn_id: fence.turn_id,
            generation: fence.generation,
            worker: fence.worker,
            venue_surface: venue,
            venue_incarnation: incarnation,
            description_digest: description.content_digest(),
            description,
            risk,
            required,
            requested_at_ms: now,
            expires_at_ms: now.checked_add(GRANT_MS).ok_or(RuntimeError::Unavailable)?,
            decision: None,
            consumed: false,
        };
        let events = vec![RuntimeData::GrantRequested {
            fence,
            grant_id: grant.id,
            action_id: grant.action_id,
            venue_surface: venue,
            risk,
            expires_at_ms: grant.expires_at_ms,
        }];
        self.grants.insert(grant.id, grant.clone());
        Ok(Some((grant, events)))
    }

    /// The owner's answer. It binds to the exact sentence they read, to the
    /// exact action, and to the venue's current connection; anything else is
    /// stale, and a decline is exactly as easy as an accept.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn resolve_grant(
        &mut self,
        grant_id: Uuid,
        action_id: Uuid,
        venue: Uuid,
        incarnation: Uuid,
        granted: bool,
        attestation: Option<Attestation>,
        description_digest: &str,
        now: i64,
    ) -> Result<Vec<RuntimeData>, RuntimeError> {
        let grant = self.grants.get(&grant_id).ok_or(RuntimeError::NotFound)?;
        if grant.action_id != action_id
            || grant.venue_surface != venue
            || grant.venue_incarnation != incarnation
            || grant.description_digest != description_digest
            || grant.decision.is_some()
            || !grant.live(now)
        {
            return Err(RuntimeError::Stale);
        }
        // A grant is fenced by its own turn: a restart mints a new worker and
        // the fence rejects it, so an unconfirmed command is denied.
        self.fence(grant.turn_id, grant.generation, grant.worker, now)?;
        // With `actor_unknown` declared everywhere, a bare tap cannot mint a
        // high-risk authority. Weaker evidence than the ceremony asked for is
        // not an answer at all.
        if granted && attestation.is_none_or(|value| value < grant.required) {
            return Err(RuntimeError::Stale);
        }
        let dwell_ms = now.saturating_sub(grant.requested_at_ms);
        let grant = self.grants.get_mut(&grant_id).unwrap();
        grant.decision = Some(Decision {
            granted,
            attestation,
            decided_at_ms: now,
        });
        let mut events = vec![RuntimeData::GrantResolved {
            grant_id,
            action_id,
            venue_surface: venue,
            outcome: if granted {
                Outcome::Granted
            } else {
                Outcome::Declined
            },
            attestation,
            dwell_ms,
        }];
        if !granted {
            events.extend(self.revoke_action(
                action_id,
                super::action::RevokeReason::Cancelled,
                now,
            ));
        }
        Ok(events)
    }

    /// Consume the grant in the same transaction that claims its action.
    pub(super) fn consume_grant(&mut self, action_id: Uuid, now: i64) {
        let Some(id) = self
            .grants
            .values()
            .find(|grant| grant.action_id == action_id && grant.usable(now))
            .map(|grant| grant.id)
        else {
            return;
        };
        if let Some(grant) = self.grants.get_mut(&id) {
            grant.consumed = true;
        }
    }

    /// Drop every grant whose action, turn or process is gone. An unconsumed
    /// grant is void on restart, and the ledger says how it ended.
    pub(super) fn reconcile_grants(&mut self, now: i64) -> Vec<RuntimeData> {
        let live = self
            .turn
            .as_ref()
            .filter(|turn| !turn.cancelled)
            .map(|turn| turn.fence.clone());
        let mut events = Vec::new();
        let actions: Vec<(Uuid, ActionStatus)> = self
            .actions
            .values()
            .map(|action| (action.id, action.status))
            .collect();
        let mut retired = Vec::new();
        for grant in self.grants.values() {
            let fenced = live.as_ref().is_some_and(|fence| {
                fence.turn_id == grant.turn_id
                    && fence.generation == grant.generation
                    && fence.worker == grant.worker
            });
            let pending = actions.iter().any(|(id, status)| {
                *id == grant.action_id
                    && matches!(status, ActionStatus::AwaitingGrant | ActionStatus::Proposed)
            });
            if grant.consumed || (fenced && pending && now < grant.expires_at_ms) {
                continue;
            }
            retired.push((
                grant.id,
                grant.action_id,
                grant.venue_surface,
                if fenced && now >= grant.expires_at_ms {
                    Outcome::Expired
                } else {
                    Outcome::Voided
                },
                grant.decision.is_none(),
            ));
        }
        for (id, action_id, venue, outcome, unanswered) in retired {
            self.grants.remove(&id);
            if unanswered {
                events.push(RuntimeData::GrantResolved {
                    grant_id: id,
                    action_id,
                    venue_surface: venue,
                    outcome,
                    attestation: None,
                    dwell_ms: 0,
                });
            }
        }
        // Consumed grants are kept only until their own expiry, so a replayed
        // answer stays stale rather than becoming unknown.
        self.grants
            .retain(|_, grant| now < grant.expires_at_ms.saturating_add(GRANT_MS));
        events
    }
}

/// What a venue is asked to render, and the identifiers it echoes back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub grant_id: Uuid,
    pub action_id: Uuid,
    pub turn_id: Uuid,
    pub generation: u64,
    pub description: Description,
    pub description_digest: String,
    pub risk: Risk,
    pub attestation: Attestation,
    pub privacy: PrivacyClass,
    pub expires_at_ms: i64,
}

impl From<&Grant> for Request {
    fn from(grant: &Grant) -> Self {
        Self {
            grant_id: grant.id,
            action_id: grant.action_id,
            turn_id: grant.turn_id,
            generation: grant.generation,
            description: grant.description.clone(),
            description_digest: grant.description_digest.clone(),
            risk: grant.risk,
            attestation: grant.required,
            privacy: grant.description.class,
            expires_at_ms: grant.expires_at_ms,
        }
    }
}
