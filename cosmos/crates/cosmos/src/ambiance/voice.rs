//! Local transcription intake is a pending phase, never a content classifier
//! or provider grant. Raw PCM and transcript text are not durable state.
use super::{
    InputStamp, OriginProof, PinProof, PrivacyClass, RuntimeData, RuntimeError, RuntimeOperation,
    RuntimeResult, RuntimeState, Turn, TurnFence,
};
use crate::surface_registry::{Binding as SurfaceBinding, Record, hash};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use tonic::Status;
use uuid::Uuid;

/// Deadline for pending local transcription, measured by the runtime clock.
/// A capture adapter still needs its own PCM byte/duration bounds.
pub const INTAKE_MS: i64 = 35_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    /// Approved source/session floor. Output selection never supplies this.
    pub source_floor: PrivacyClass,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub approval_revision: u64,
    pub revision: u64,
    pub policy: Option<Policy>,
}

/// Constructed only from the runtime-owned media connection and its observed
/// SFU publication. This is not a native request body or actor identification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub(super) media_owner: Uuid,
    pub(super) participant_sid: String,
    pub(super) track_sid: String,
}
impl Binding {
    fn valid(&self) -> bool {
        let id = |s: &str| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        };
        !self.media_owner.is_nil() && id(&self.participant_sid) && id(&self.track_sid)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intake {
    pub(super) id: Uuid,
    pub(super) binding: Binding,
    pub(super) stamp: InputStamp,
    pub(super) policy_revision: u64,
    pub(super) source_floor: PrivacyClass,
    pub(super) expires_at_ms: i64,
    pub(super) transcript_digest: Option<String>,
}
impl Intake {
    pub(super) fn source_digest(&self) -> Result<String, RuntimeError> {
        Ok(hash(
            &serde_json::to_vec(&(&self.stamp, &self.binding, self.policy_revision))
                .map_err(|_| RuntimeError::Unavailable)?,
        ))
    }
}

/// A one-use server-owned intake. Dropping it retires only the exact admitted
/// attempt, including an interrupted commit; retries never own this capability.
/// It grants no microphone subscription, cloud upload, or playback authority.
pub struct LocalVoice {
    pub(super) runtime: Arc<super::runtime::AmbianceRuntime>,
    pub(super) authenticated: crate::auth::AuthenticatedRequest,
    pub(super) connection: PinProof,
    pub(super) fence: TurnFence,
    pub(super) binding: Binding,
    pub(super) source_current: Arc<dyn Fn() -> bool + Send + Sync>,
    pub(super) deadline: std::time::Instant,
    pub(super) cancel: CancelVoice,
}

pub(super) struct CancelVoice {
    pub store: crate::store::SharedStore,
    pub principal: String,
    pub turn_id: Uuid,
    pub worker: Uuid,
    pub intake_id: Uuid,
    pub armed: bool,
}
impl Drop for CancelVoice {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let store = self.store.clone();
        let principal = self.principal.clone();
        let operation = RuntimeOperation::RetireVoice {
            turn_id: self.turn_id,
            worker: self.worker,
            intake_id: self.intake_id,
        };
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                store.runtime(&principal, operation),
            )
            .await;
        });
    }
}

impl LocalVoice {
    /// Revalidate before each local transform stage or PCM consumption. A
    /// failed pairing/Store check is failure, never a cached authorization.
    pub async fn check(&self) -> Result<(), Status> {
        if !(self.source_current)() {
            return Err(Status::failed_precondition("voice source is not current"));
        }
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            self.runtime
                .check_pin(&self.authenticated, self.connection.incarnation)
                .await?;
            self.runtime
                .store
                .runtime(
                    self.authenticated.principal.expose_for_authorization(),
                    RuntimeOperation::CheckVoice {
                        connection: self.connection.clone(),
                        fence: self.fence.clone(),
                        binding: self.binding.clone(),
                    },
                )
                .await
                .map_err(super::runtime::runtime_error)?;
            if !(self.source_current)() {
                return Err(Status::failed_precondition("voice source is not current"));
            }
            Ok(())
        })
        .await
        .map_err(|_| Status::unavailable("voice intake unavailable"))?
    }

    /// Only a trusted local-transcription adapter may call this with its own
    /// result. No HTTP/RPC adapter accepts a client-asserted transcript here.
    /// Publication presence is required through finalization. Cognition then
    /// uses the committed origin/privacy floor and current turn, pairing,
    /// approval and media-room checks; it does not require an open microphone.
    pub(super) async fn complete(mut self, transcript: String) -> Result<RuntimeResult, Status> {
        self.check().await?;
        let principal = self.authenticated.principal.expose_for_authorization();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            self.runtime.store.runtime(
                principal,
                RuntimeOperation::FinalizeVoice {
                    connection: self.connection.clone(),
                    fence: self.fence.clone(),
                    binding: self.binding.clone(),
                    transcript: transcript.clone(),
                },
            ),
        )
        .await
        .map_err(|_| Status::unavailable("voice intake unavailable"))?
        .map_err(super::runtime::runtime_error)?;
        let RuntimeResult::VoiceFinalized { privacy } = result else {
            return Err(Status::failed_precondition("voice input rejected"));
        };
        if !(self.source_current)() {
            return Err(Status::failed_precondition("voice source is not current"));
        }
        let result = self
            .runtime
            .cognize(
                principal,
                self.fence.clone(),
                transcript,
                privacy,
                Some(&self.authenticated),
            )
            .await?;
        self.cancel.armed = false;
        Ok(result)
    }

    /// Pending work is polled only after a current authority check. The total
    /// deadline includes those checks, so a stalled Store cannot retain audio
    /// or an inference future beyond this intake's local deadline.
    pub(super) async fn while_pending<T>(
        &self,
        work: impl std::future::Future<Output = Result<T, Status>>,
    ) -> Result<T, Status> {
        tokio::time::timeout_at(self.deadline.into(), async {
            self.check().await?;
            let mut changes = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                self.runtime
                    .store
                    .runtime_changes(self.authenticated.principal.expose_for_authorization()),
            )
            .await
            .map_err(|_| Status::unavailable("voice intake unavailable"))?
            .map_err(super::runtime::runtime_error)?;
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            tokio::pin!(work);
            loop {
                tokio::select! {
                    biased;
                    changed = changes.changed() => {
                        changed.map_err(|_| Status::unavailable("voice intake unavailable"))?;
                        self.check().await?;
                    }
                    _ = interval.tick() => self.check().await?,
                    result = &mut work => {
                        self.check().await?;
                        return result;
                    }
                }
            }
        })
        .await
        .map_err(|_| Status::deadline_exceeded("voice intake deadline exceeded"))?
    }
}

impl RuntimeState {
    pub(super) fn voice_policy(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
    ) -> Result<Option<Approval>, RuntimeError> {
        let record = records
            .get(&surface)
            .filter(|r| !r.revoked && matches!(r.binding, SurfaceBinding::Pin { .. }))
            .ok_or(RuntimeError::InvalidOrigin)?;
        Ok(self
            .voice_policies
            .get(&surface)
            .filter(|a| a.approval_revision == record.revision)
            .cloned())
    }

    pub(super) fn set_voice_policy(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<Policy>,
    ) -> Result<Approval, RuntimeError> {
        let current = self.voice_policy(records, surface)?;
        if records[&surface].revision != approval_revision
            || current.as_ref().map_or(0, |a| a.revision) != expected_revision
        {
            return Err(RuntimeError::Stale);
        }
        // Unknown actor/occupancy cannot be used to assert public capture.
        if policy
            .as_ref()
            .is_some_and(|p| p.source_floor < PrivacyClass::SharedRoom)
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
        self.voice_policies.insert(surface, approval.clone());
        Ok(approval)
    }

    pub(super) fn voice_valid(&self, turn: &Turn, now: i64) -> bool {
        let Some(intake) = turn.voice.as_ref() else {
            return true;
        };
        self.voice_policies
            .get(&turn.fence.origin_surface)
            .is_some_and(|a| {
                a.approval_revision == turn.origin_revision
                    && a.revision == intake.policy_revision
                    && a.policy
                        .as_ref()
                        .is_some_and(|p| p.source_floor == intake.source_floor)
            })
            && self
                .pin_connections
                .get(&turn.fence.origin_surface)
                .is_some_and(|c| {
                    Some(c.incarnation) == turn.pin_incarnation
                        && c.media_owner == Some(intake.binding.media_owner)
                })
            && (!turn.voice_pending() || now < intake.expires_at_ms)
    }

    pub(super) fn validate_voice_source(
        &self,
        connection: &PinProof,
        intake: &Intake,
        now: i64,
    ) -> Result<(), RuntimeError> {
        let current = self
            .pin_connections
            .get(&connection.surface_id)
            .filter(|c| c.incarnation == connection.incarnation)
            .ok_or(RuntimeError::Stale)?;
        let approval = self
            .voice_policies
            .get(&connection.surface_id)
            .filter(|a| a.approval_revision == current.approval_revision)
            .ok_or(RuntimeError::PolicyBlocked)?;
        if intake.id.is_nil() || !intake.binding.valid() || intake.transcript_digest.is_some() {
            return Err(RuntimeError::InvalidRequest);
        }
        if current.media_owner != Some(intake.binding.media_owner)
            || current.epoch != intake.stamp.epoch
            || approval.revision != intake.policy_revision
            || approval
                .policy
                .as_ref()
                .is_none_or(|p| p.source_floor != intake.source_floor)
            || now >= intake.expires_at_ms
            || intake.expires_at_ms > now.saturating_add(INTAKE_MS)
        {
            return Err(RuntimeError::Stale);
        }
        Ok(())
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Mirrors one atomic admission operation without a second request schema"
    )]
    pub(super) fn begin_voice(
        &mut self,
        principal: &str,
        records: &BTreeMap<Uuid, Record>,
        connection: PinProof,
        stamp: InputStamp,
        worker: Uuid,
        intake_id: Uuid,
        binding: Binding,
        now: i64,
    ) -> Result<(RuntimeResult, Vec<RuntimeData>), RuntimeError> {
        self.pin_record(principal, records, &connection, now)?;
        let approval = self
            .voice_policy(records, connection.surface_id)?
            .ok_or(RuntimeError::PolicyBlocked)?;
        let source_floor = approval
            .policy
            .as_ref()
            .ok_or(RuntimeError::PolicyBlocked)?
            .source_floor;
        let intake = Intake {
            id: intake_id,
            binding,
            stamp: stamp.clone(),
            policy_revision: approval.revision,
            source_floor,
            expires_at_ms: now
                .checked_add(INTAKE_MS)
                .ok_or(RuntimeError::Unavailable)?,
            transcript_digest: None,
        };
        let source_digest = intake.source_digest()?;
        let (result, mut events) = self.apply(
            principal,
            records,
            RuntimeOperation::Begin {
                turn_id: stamp.instance_id,
                worker,
                origin: OriginProof::VoicePin {
                    connection,
                    stamp,
                    intake: intake.clone(),
                },
                request_digest: source_digest.clone(),
                privacy_floor: source_floor,
            },
            now,
        )?;
        if let RuntimeResult::Begun(fence) = &result {
            events.push(RuntimeData::VoiceStarted {
                fence: fence.clone(),
                policy_revision: approval.revision,
                source_digest,
                source_floor,
                expires_at_ms: intake.expires_at_ms,
            });
        }
        Ok((result, events))
    }

    pub(super) fn check_voice(
        &self,
        principal: &str,
        records: &BTreeMap<Uuid, Record>,
        connection: &PinProof,
        fence: &TurnFence,
        binding: &Binding,
        now: i64,
    ) -> Result<&Intake, RuntimeError> {
        self.pin_record(principal, records, connection, now)?;
        let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
        if turn.finished
            || !turn.voice_pending()
            || !self.voice_valid(turn, now)
            || !self.origin_valid(turn, records, now)
            || fence.origin_surface != turn.fence.origin_surface
            || connection.surface_id != turn.fence.origin_surface
            || Some(connection.incarnation) != turn.pin_incarnation
        {
            return Err(RuntimeError::Stale);
        }
        turn.voice
            .as_ref()
            .filter(|v| v.binding == *binding)
            .ok_or(RuntimeError::Stale)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Revalidates every field of the existing admission fence in one transition"
    )]
    pub(super) fn finalize_voice(
        &mut self,
        principal: &str,
        records: &BTreeMap<Uuid, Record>,
        connection: &PinProof,
        fence: TurnFence,
        binding: &Binding,
        transcript: String,
        now: i64,
    ) -> Result<(RuntimeResult, Vec<RuntimeData>), RuntimeError> {
        let intake = self.check_voice(principal, records, connection, &fence, binding, now)?;
        if transcript.trim().is_empty() || transcript.len() > 4000 {
            return Err(RuntimeError::InvalidRequest);
        }
        let privacy = self
            .turn
            .as_ref()
            .unwrap()
            .privacy
            .max(intake.source_floor)
            .max(super::runtime::input_privacy(&transcript));
        // Transcript recognition is not a new input. Echo rejection consumes
        // the existing capture once, without a second high-water transition.
        if let Some(echo) = self.echoes.iter().find(|e| {
            now < e.expires_at_ms && e.fingerprint == super::echo::fingerprint(&transcript)
        }) {
            let event = RuntimeData::EchoRejected {
                request_id: fence.turn_id,
                origin: fence.origin_surface,
                action_id: echo.action_id,
                privacy: privacy.max(echo.privacy),
                stamp: Some(intake.stamp.clone()),
            };
            self.turn.as_mut().unwrap().cancelled = true;
            return Ok((
                RuntimeResult::EchoRejected,
                vec![
                    event,
                    RuntimeData::TurnCancelled {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                    },
                ],
            ));
        }
        let transcript_digest = hash(transcript.as_bytes());
        let turn = self.turn.as_mut().unwrap();
        turn.privacy = privacy;
        turn.voice.as_mut().unwrap().transcript_digest = Some(transcript_digest.clone());
        Ok((
            RuntimeResult::VoiceFinalized { privacy },
            vec![RuntimeData::VoiceFinalized {
                fence,
                transcript_digest,
                classifier_version: super::runtime::INPUT_CLASSIFIER_VERSION,
                privacy,
            }],
        ))
    }
}

#[cfg(test)]
#[path = "voice_tests.rs"]
mod tests;
