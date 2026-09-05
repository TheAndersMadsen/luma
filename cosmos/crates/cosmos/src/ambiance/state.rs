use super::policy::{self, Candidate, Channel, PrivacyClass, SemanticIntent};
use crate::surface_registry::{Binding, Record};
use cosmos_core::AuthenticatedDeviceIdentity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const ACK_MS: i64 = 3_000;
pub const WORKER_LEASE_MS: i64 = 75_000;
pub const MAX_ACTIONS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    Unavailable,
    InvalidOrigin,
    InvalidRequest,
    Stale,
    Busy,
    PolicyBlocked,
    NotFound,
}
impl From<crate::surface_registry::RegistryError> for RuntimeError {
    fn from(_: crate::surface_registry::RegistryError) -> Self {
        Self::Unavailable
    }
}

/// Only verified owner HTTP adapters may construct this credential proof.
/// It is never serialized, returned, or logged.
pub struct BrowserProof {
    pub surface_id: Uuid,
    pub incarnation: Uuid,
    pub token_hash: String,
}
/// Pin adapters must retain AuthLayer evidence and recheck current pairing.
/// The device-ID parser alone does not authenticate this origin.
pub enum OriginProof {
    Browser(BrowserProof),
    Pin {
        device: AuthenticatedDeviceIdentity,
        surface_id: Uuid,
    },
}

pub enum RuntimeOperation {
    Begin {
        turn_id: Uuid,
        worker: Uuid,
        origin: OriginProof,
        request_digest: String,
        privacy_floor: PrivacyClass,
    },
    Propose {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
        intent: SemanticIntent,
        privacy: PrivacyClass,
    },
    Claim {
        action_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    Ack {
        action_id: Uuid,
        turn_id: Uuid,
        generation: u64,
        connection: BrowserProof,
        channel: Channel,
        content_digest: String,
    },
    Cancel {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    Finish {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    Poll {
        connection: BrowserProof,
    },
    Inspect {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    Sweep,
    Recover {
        worker: Uuid,
    },
}
#[derive(Clone, Debug)]
pub enum RuntimeResult {
    Begun(TurnFence),
    Proposed(Action),
    Dispatch(Action),
    Acknowledged(Action),
    Blocked,
    Cancelled,
    Finished,
    Swept,
    Recovered,
    Pending(Vec<Action>),
    Observed(Vec<Action>),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnFence {
    pub turn_id: Uuid,
    pub generation: u64,
    pub worker: Uuid,
    pub origin_surface: Uuid,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    pub fence: TurnFence,
    pub origin_incarnation: Uuid,
    pub origin_revision: u64,
    pub request_digest: String,
    pub privacy: PrivacyClass,
    pub lease_until_ms: i64,
    pub cancelled: bool,
    pub finished: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    Proposed,
    Dispatched,
    Acknowledged,
    Cancelled,
    OutcomeUnknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub id: Uuid,
    pub root_id: Uuid,
    pub turn_id: Uuid,
    pub generation: u64,
    pub worker: Uuid,
    pub surface_id: Uuid,
    pub channel: Channel,
    pub incarnation: Uuid,
    pub content_digest: String,
    pub intent: SemanticIntent,
    pub privacy: PrivacyClass,
    pub status: ActionStatus,
    pub deadline_ms: i64,
    pub display_expires_at_ms: i64,
    pub attempts: u8,
    pub fallbacks: Vec<Uuid>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeState {
    pub generation: u64,
    pub turn: Option<Turn>,
    pub actions: BTreeMap<Uuid, Action>,
}

/// Content-free event bodies. Never include request text, capability hashes,
/// device IDs, or model output. Candidate vectors explain deterministic routing.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RuntimeData {
    TurnBegan {
        turn_id: Uuid,
        generation: u64,
        origin: Uuid,
        request_digest: String,
        privacy: PrivacyClass,
    },
    Decision {
        turn_id: Uuid,
        generation: u64,
        action_id: Option<Uuid>,
        privacy: PrivacyClass,
        candidates: Vec<Candidate>,
    },
    ActionChanged {
        action_id: Uuid,
        turn_id: Uuid,
        generation: u64,
        status: ActionStatus,
        channel: Channel,
        surface_id: Uuid,
        incarnation: Uuid,
        content_digest: String,
        deadline_ms: i64,
        attempt: u8,
    },
    TurnCancelled {
        turn_id: Uuid,
        generation: u64,
    },
    TurnFinished {
        turn_id: Uuid,
        generation: u64,
    },
    PayloadCleared {
        action_id: Uuid,
        content_digest: String,
    },
    Repair {
        previous_action: Uuid,
        action_id: Uuid,
        surface_id: Uuid,
        candidates: Vec<Candidate>,
    },
}
fn action_event(action: &Action) -> RuntimeData {
    RuntimeData::ActionChanged {
        action_id: action.id,
        turn_id: action.turn_id,
        generation: action.generation,
        status: action.status,
        channel: action.channel,
        surface_id: action.surface_id,
        incarnation: action.incarnation,
        content_digest: action.content_digest.clone(),
        deadline_ms: action.deadline_ms,
        attempt: action.attempts,
    }
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn browser_record<'a>(
    records: &'a BTreeMap<Uuid, Record>,
    proof: &BrowserProof,
    now: i64,
) -> Result<&'a Record, RuntimeError> {
    let record = records
        .get(&proof.surface_id)
        .ok_or(RuntimeError::InvalidOrigin)?;
    let same = proof.token_hash.len() == record.token_hash.len()
        && proof
            .token_hash
            .bytes()
            .zip(record.token_hash.bytes())
            .fold(0u8, |a, (b, c)| a | (b ^ c))
            == 0;
    if !digest_valid(&proof.token_hash)
        || !same
        || proof.incarnation != record.incarnation
        || !matches!(record.binding, Binding::Browser)
        || record.revoked
        || record.left
        || now >= record.connection_expires_at
        || now >= record.lease_expires_at
        || !crate::surface_registry::known_browser_manifest(&record.approved_manifest)
    {
        return Err(RuntimeError::InvalidOrigin);
    }
    Ok(record)
}
impl RuntimeState {
    /// Due-time projection for the indexed maintenance queue. Policy remains
    /// in reconcile; this only schedules the next authoritative recheck.
    pub fn next_maintenance_ms(&self, records: &BTreeMap<Uuid, Record>) -> i64 {
        let mut due = i64::MAX;
        if let Some(turn) = self.turn.as_ref().filter(|t| !t.cancelled) {
            due = due.min(turn.lease_until_ms);
            if let Some(origin) = records.get(&turn.fence.origin_surface) {
                if matches!(origin.binding, Binding::Browser) {
                    due = due
                        .min(origin.lease_expires_at)
                        .min(origin.connection_expires_at);
                }
            } else {
                return 0;
            }
        }
        for action in self.actions.values() {
            if matches!(
                action.status,
                ActionStatus::Cancelled | ActionStatus::OutcomeUnknown
            ) {
                if !action.intent.text().is_empty() {
                    return 0;
                }
                continue;
            }
            due = due.min(action.display_expires_at_ms);
            if matches!(
                action.status,
                ActionStatus::Proposed | ActionStatus::Dispatched
            ) {
                due = due.min(action.deadline_ms);
            }
            if let Some(record) = records.get(&action.surface_id) {
                if matches!(record.binding, Binding::Browser) {
                    due = due
                        .min(record.lease_expires_at)
                        .min(record.connection_expires_at);
                }
            } else {
                return 0;
            }
        }
        due
    }

    /// Terminal payloads are erased before the transaction commits. A stock
    /// dispatch caller owns a separate one-use payload clone, never a replay.
    pub fn clear_terminal_payloads(&mut self) -> Vec<RuntimeData> {
        let mut events = Vec::new();
        for action in self.actions.values_mut() {
            if matches!(
                action.status,
                ActionStatus::Cancelled | ActionStatus::OutcomeUnknown
            ) && !action.intent.text().is_empty()
            {
                match &mut action.intent {
                    SemanticIntent::InformationalSpeech { text }
                    | SemanticIntent::VisualTextCard { text } => text.clear(),
                }
                events.push(RuntimeData::PayloadCleared {
                    action_id: action.id,
                    content_digest: action.content_digest.clone(),
                });
            }
        }
        events
    }
    fn fence(
        &self,
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
        now: i64,
    ) -> Result<&Turn, RuntimeError> {
        self.turn
            .as_ref()
            .filter(|t| {
                !t.cancelled
                    && t.fence.turn_id == turn_id
                    && t.fence.generation == generation
                    && t.fence.worker == worker
                    && self.generation == generation
                    && now < t.lease_until_ms
            })
            .ok_or(RuntimeError::Stale)
    }
    fn origin_valid(turn: &Turn, records: &BTreeMap<Uuid, Record>, now: i64) -> bool {
        records.get(&turn.fence.origin_surface).is_some_and(|r| {
            !r.revoked
                && match r.binding {
                    Binding::Browser => {
                        r.incarnation == turn.origin_incarnation && r.view(now).available
                    }
                    Binding::Pin { .. } => r.revision == turn.origin_revision,
                }
        })
    }
    /// Called inside both registry and runtime transactions. Ordinary visible
    /// heartbeats do not alter the origin incarnation or eligibility.
    pub fn reconcile(&mut self, records: &BTreeMap<Uuid, Record>, now: i64) -> Vec<RuntimeData> {
        let mut events = Vec::new();
        let mut repairs = Vec::new();
        let origin_valid = self.turn.as_ref().is_some_and(|t| {
            !t.cancelled && now < t.lease_until_ms && Self::origin_valid(t, records, now)
        });
        if !origin_valid {
            if let Some(turn) = self.turn.as_mut().filter(|t| !t.cancelled) {
                turn.cancelled = true;
                events.push(RuntimeData::TurnCancelled {
                    turn_id: turn.fence.turn_id,
                    generation: turn.fence.generation,
                });
            }
        }
        for action in self.actions.values_mut() {
            if matches!(
                action.status,
                ActionStatus::Cancelled | ActionStatus::OutcomeUnknown
            ) {
                continue;
            }
            let valid = origin_valid
                && now < action.display_expires_at_ms
                && self.turn.as_ref().is_some_and(|t| {
                    t.fence.generation == action.generation && t.privacy <= PrivacyClass::SharedRoom
                })
                && records.get(&action.surface_id).is_some_and(|r| {
                    r.incarnation == action.incarnation
                        && policy::candidate(
                            r,
                            self.turn.as_ref().unwrap().fence.origin_surface,
                            action.channel,
                            action.privacy,
                            now,
                        )
                        .blocker
                        .is_none()
                });
            if !valid {
                let repair = origin_valid
                    && now < action.display_expires_at_ms
                    && self
                        .turn
                        .as_ref()
                        .is_some_and(|t| t.privacy <= PrivacyClass::SharedRoom)
                    && action.channel == Channel::VisualCard
                    && matches!(
                        action.status,
                        ActionStatus::Proposed | ActionStatus::Dispatched
                    );
                action.status = if action.channel == Channel::AudioTts && action.attempts > 0 {
                    ActionStatus::OutcomeUnknown
                } else {
                    ActionStatus::Cancelled
                };
                events.push(action_event(action));
                if repair {
                    repairs.push(action.clone());
                }
            } else if action.status == ActionStatus::Proposed && now >= action.deadline_ms {
                action.status = if action.attempts > 0 {
                    ActionStatus::OutcomeUnknown
                } else {
                    ActionStatus::Cancelled
                };
                events.push(action_event(action));
                if action.channel == Channel::VisualCard {
                    repairs.push(action.clone());
                }
            } else if action.status == ActionStatus::Dispatched && now >= action.deadline_ms {
                if action.channel == Channel::VisualCard && action.attempts == 1 {
                    // Retry only on this exact surface/key. Poll reclaims under
                    // policy, then gives the same key another bounded deadline.
                    action.status = ActionStatus::Proposed;
                    action.deadline_ms = now.saturating_add(ACK_MS);
                } else {
                    action.status = ActionStatus::OutcomeUnknown;
                    if action.channel == Channel::VisualCard {
                        repairs.push(action.clone());
                    }
                }
                events.push(action_event(action));
            }
        }
        for previous in repairs {
            if self.actions.len() >= MAX_ACTIONS {
                continue;
            }
            let origin = self.turn.as_ref().unwrap().fence.origin_surface;
            let candidates: Vec<_> = previous
                .fallbacks
                .iter()
                .filter_map(|id| records.get(id))
                .map(|r| policy::candidate(r, origin, previous.channel, previous.privacy, now))
                .collect();
            if let Some(selected) = candidates.iter().find(|c| c.blocker.is_none()) {
                let mut action = previous.clone();
                action.id = Uuid::new_v4();
                action.surface_id = selected.surface_id;
                action.incarnation = records[&selected.surface_id].incarnation;
                action.status = ActionStatus::Proposed;
                action.attempts = 0;
                action.deadline_ms = now.saturating_add(ACK_MS);
                action.fallbacks.retain(|id| *id != selected.surface_id);
                events.push(RuntimeData::Repair {
                    previous_action: previous.id,
                    action_id: action.id,
                    surface_id: selected.surface_id,
                    candidates,
                });
                self.actions.insert(action.id, action);
            }
        }
        if let Some(turn) = self.turn.as_mut() {
            if !turn.cancelled
                && !turn.finished
                && !self.actions.is_empty()
                && records
                    .get(&turn.fence.origin_surface)
                    .is_some_and(|r| matches!(r.binding, Binding::Browser))
                && self
                    .actions
                    .values()
                    .all(|a| !matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched))
            {
                turn.finished = true;
                events.push(RuntimeData::TurnFinished {
                    turn_id: turn.fence.turn_id,
                    generation: turn.fence.generation,
                });
            }
        }
        events.extend(self.clear_terminal_payloads());
        events
    }
    fn claim(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        id: Uuid,
        generation: u64,
        worker: Uuid,
        now: i64,
    ) -> Result<(Action, RuntimeData), RuntimeError> {
        let action = self.actions.get(&id).ok_or(RuntimeError::NotFound)?;
        let turn = self.fence(action.turn_id, generation, worker, now)?;
        if turn.finished
            || action.generation != generation
            || action.worker != worker
            || action.status != ActionStatus::Proposed
            || !Self::origin_valid(turn, records, now)
        {
            return Err(RuntimeError::Stale);
        }
        let record = records
            .get(&action.surface_id)
            .ok_or(RuntimeError::PolicyBlocked)?;
        if record.incarnation != action.incarnation
            || policy::candidate(
                record,
                turn.fence.origin_surface,
                action.channel,
                action.privacy,
                now,
            )
            .blocker
            .is_some()
        {
            return Err(RuntimeError::PolicyBlocked);
        }
        let action = self.actions.get_mut(&id).unwrap();
        action.attempts += 1;
        action.deadline_ms = now.checked_add(ACK_MS).ok_or(RuntimeError::Unavailable)?;
        action.status = if action.channel == Channel::AudioTts {
            ActionStatus::OutcomeUnknown
        } else {
            ActionStatus::Dispatched
        };
        Ok((action.clone(), action_event(action)))
    }
    pub fn apply(
        &mut self,
        principal: &str,
        records: &BTreeMap<Uuid, Record>,
        operation: RuntimeOperation,
        now: i64,
    ) -> Result<(RuntimeResult, Vec<RuntimeData>), RuntimeError> {
        let mut events = self.reconcile(records, now);
        let result = match operation {
            RuntimeOperation::Begin {
                turn_id,
                worker,
                origin,
                request_digest,
                privacy_floor,
            } => {
                if turn_id.is_nil() || worker.is_nil() || !digest_valid(&request_digest) {
                    return Err(RuntimeError::InvalidRequest);
                }
                let record = match &origin {
                    OriginProof::Browser(proof) => {
                        let r = browser_record(records, proof, now)?;
                        if !r.visible
                            || !r.approved_manifest["authority"]["mayOriginate"]
                                .as_array()
                                .is_some_and(|a| a.iter().any(|v| v == "user.request"))
                        {
                            return Err(RuntimeError::InvalidOrigin);
                        }
                        r
                    }
                    OriginProof::Pin { device, surface_id } => {
                        let id = crate::surface_registry::pin_surface_id(
                            principal,
                            device.expose_for_authorization(),
                        );
                        records.get(surface_id).filter(|r| id == *surface_id && !r.revoked
                            && matches!(&r.binding, Binding::Pin { device_id } if device_id == device.expose_for_authorization())
                            && r.approved_manifest == crate::surface_registry::pin_manifest()).ok_or(RuntimeError::InvalidOrigin)?
                    }
                };
                if self
                    .turn
                    .as_ref()
                    .is_some_and(|t| !t.cancelled && !t.finished && now < t.lease_until_ms)
                {
                    return Err(RuntimeError::Busy);
                }
                self.generation = self
                    .generation
                    .checked_add(1)
                    .ok_or(RuntimeError::Unavailable)?;
                // Old terminal payloads are removed; the audit events remain.
                self.actions.clear();
                let fence = TurnFence {
                    turn_id,
                    generation: self.generation,
                    worker,
                    origin_surface: record.surface_id,
                };
                let privacy = privacy_floor.max(PrivacyClass::SharedRoom);
                self.turn = Some(Turn {
                    fence: fence.clone(),
                    origin_incarnation: record.incarnation,
                    origin_revision: record.revision,
                    request_digest: request_digest.clone(),
                    privacy,
                    lease_until_ms: now
                        .checked_add(WORKER_LEASE_MS)
                        .ok_or(RuntimeError::Unavailable)?,
                    cancelled: false,
                    finished: false,
                });
                events.push(RuntimeData::TurnBegan {
                    turn_id,
                    generation: self.generation,
                    origin: record.surface_id,
                    request_digest,
                    privacy,
                });
                RuntimeResult::Begun(fence)
            }
            RuntimeOperation::Propose {
                turn_id,
                generation,
                worker,
                intent,
                privacy,
            } => {
                let turn = self.fence(turn_id, generation, worker, now)?;
                if turn.finished || !Self::origin_valid(turn, records, now) {
                    return Err(RuntimeError::Stale);
                }
                if !intent.valid() || self.actions.len() >= MAX_ACTIONS {
                    return Err(RuntimeError::InvalidRequest);
                }
                let privacy = turn.privacy.max(privacy);
                if intent.channel() == Channel::VisualCard
                    && privacy <= PrivacyClass::SharedRoom
                    && self.actions.values().any(|a| {
                        a.channel == Channel::VisualCard
                            && matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched)
                    })
                {
                    return Err(RuntimeError::Busy);
                }
                let mut candidates: Vec<_> = records
                    .values()
                    .filter(|r| !r.revoked)
                    .map(|r| {
                        policy::candidate(
                            r,
                            turn.fence.origin_surface,
                            intent.channel(),
                            privacy,
                            now,
                        )
                    })
                    .collect();
                candidates.sort_by(|a, b| {
                    b.score()
                        .cmp(&a.score())
                        .then(a.surface_id.cmp(&b.surface_id))
                });
                let selected = candidates
                    .iter()
                    .find(|c| c.blocker.is_none())
                    .map(|c| c.surface_id);
                let fallbacks = candidates
                    .iter()
                    .filter(|c| c.blocker.is_none() && Some(c.surface_id) != selected)
                    .map(|c| c.surface_id)
                    .collect();
                let id = selected.map(|_| Uuid::new_v4());
                events.push(RuntimeData::Decision {
                    turn_id,
                    generation,
                    action_id: id,
                    privacy,
                    candidates,
                });
                self.turn.as_mut().unwrap().privacy = privacy;
                events.extend(self.reconcile(records, now));
                if let (Some(surface_id), Some(id)) = (selected, id) {
                    if intent.channel() == Channel::VisualCard {
                        for old in self.actions.values_mut().filter(|a| {
                            a.channel == Channel::VisualCard
                                && a.status == ActionStatus::Acknowledged
                        }) {
                            old.status = ActionStatus::Cancelled;
                            events.push(action_event(old));
                        }
                    }
                    let record = &records[&surface_id];
                    let content_digest = crate::surface_registry::hash(intent.text().as_bytes());
                    let action = Action {
                        id,
                        root_id: id,
                        turn_id,
                        generation,
                        worker,
                        surface_id,
                        channel: intent.channel(),
                        incarnation: record.incarnation,
                        content_digest,
                        intent,
                        privacy,
                        status: ActionStatus::Proposed,
                        deadline_ms: now.checked_add(ACK_MS).ok_or(RuntimeError::Unavailable)?,
                        display_expires_at_ms: now
                            .checked_add(60_000)
                            .ok_or(RuntimeError::Unavailable)?,
                        attempts: 0,
                        fallbacks,
                    };
                    self.actions.insert(id, action.clone());
                    RuntimeResult::Proposed(action)
                } else {
                    RuntimeResult::Blocked
                }
            }
            RuntimeOperation::Claim {
                action_id,
                generation,
                worker,
            } => {
                let (action, event) = self.claim(records, action_id, generation, worker, now)?;
                events.push(event);
                RuntimeResult::Dispatch(action)
            }
            RuntimeOperation::Ack {
                action_id,
                turn_id,
                generation,
                connection,
                channel,
                content_digest,
            } => {
                let record = browser_record(records, &connection, now)?;
                let action = self.actions.get(&action_id).ok_or(RuntimeError::NotFound)?;
                self.fence(turn_id, generation, action.worker, now)?;
                if action.turn_id != turn_id
                    || action.generation != generation
                    || action.surface_id != record.surface_id
                    || action.incarnation != connection.incarnation
                    || action.channel != channel
                    || channel != Channel::VisualCard
                    || action.content_digest != content_digest
                    || (action.status != ActionStatus::Acknowledged && now >= action.deadline_ms)
                    || !record.visible
                    || !matches!(
                        action.status,
                        ActionStatus::Dispatched | ActionStatus::Acknowledged
                    )
                {
                    return Err(RuntimeError::Stale);
                }
                let action = self.actions.get_mut(&action_id).unwrap();
                if action.status != ActionStatus::Acknowledged {
                    action.status = ActionStatus::Acknowledged;
                    events.push(action_event(action));
                }
                let result = RuntimeResult::Acknowledged(action.clone());
                let turn = self.turn.as_mut().unwrap();
                if records
                    .get(&turn.fence.origin_surface)
                    .is_some_and(|r| matches!(r.binding, Binding::Browser))
                    && !turn.finished
                    && self.actions.values().all(|a| {
                        !matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched)
                    })
                {
                    turn.finished = true;
                    events.push(RuntimeData::TurnFinished {
                        turn_id,
                        generation,
                    });
                }
                result
            }
            RuntimeOperation::Cancel {
                turn_id,
                generation,
                worker,
            } => {
                self.fence(turn_id, generation, worker, now)?;
                self.turn.as_mut().unwrap().cancelled = true;
                events.push(RuntimeData::TurnCancelled {
                    turn_id,
                    generation,
                });
                events.extend(self.reconcile(records, now));
                RuntimeResult::Cancelled
            }
            RuntimeOperation::Poll { connection } => {
                browser_record(records, &connection, now)?;
                let pending: Vec<_> = self
                    .actions
                    .values()
                    .filter(|a| {
                        a.surface_id == connection.surface_id
                            && a.incarnation == connection.incarnation
                            && a.status == ActionStatus::Proposed
                    })
                    .map(|a| (a.id, a.generation, a.worker))
                    .collect();
                for (id, generation, worker) in pending {
                    let (_, event) = self.claim(records, id, generation, worker, now)?;
                    events.push(event);
                }
                RuntimeResult::Pending(
                    self.actions
                        .values()
                        .filter(|a| {
                            a.surface_id == connection.surface_id
                                && a.incarnation == connection.incarnation
                        })
                        .cloned()
                        .collect(),
                )
            }
            RuntimeOperation::Sweep => RuntimeResult::Swept,
            RuntimeOperation::Finish {
                turn_id,
                generation,
                worker,
            } => {
                self.fence(turn_id, generation, worker, now)?;
                if self
                    .actions
                    .values()
                    .any(|a| matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched))
                {
                    return Err(RuntimeError::Busy);
                }
                let turn = self.turn.as_mut().unwrap();
                if !turn.finished {
                    turn.finished = true;
                    events.push(RuntimeData::TurnFinished {
                        turn_id,
                        generation,
                    });
                }
                RuntimeResult::Finished
            }
            RuntimeOperation::Inspect {
                turn_id,
                generation,
                worker,
            } => {
                self.fence(turn_id, generation, worker, now)?;
                RuntimeResult::Observed(
                    self.actions
                        .values()
                        .filter(|a| a.turn_id == turn_id && a.generation == generation)
                        .cloned()
                        .collect(),
                )
            }
            // A replica starting does not invalidate another replica. The
            // reconcile above only fences expired leases/current invalid state.
            RuntimeOperation::Recover { worker: _ } => RuntimeResult::Recovered,
        };
        events.extend(self.clear_terminal_payloads());
        Ok((result, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::surface_registry::{Mutation, hash, transition};

    fn browser(id: Uuid) -> Record {
        let (r, _) = transition(
            None,
            0,
            id,
            &Mutation::Approve {
                token_hash: hash(b"test capability"),
                incarnation: Uuid::new_v4(),
            },
            100,
        )
        .unwrap();
        transition(
            Some(&r),
            1,
            id,
            &Mutation::State {
                token_hash: r.token_hash.clone(),
                incarnation: r.incarnation,
                sequence: 1,
                visible: true,
            },
            100,
        )
        .unwrap()
        .0
    }
    fn proof(r: &Record) -> BrowserProof {
        BrowserProof {
            surface_id: r.surface_id,
            incarnation: r.incarnation,
            token_hash: r.token_hash.clone(),
        }
    }
    fn begin(state: &mut RuntimeState, records: &BTreeMap<Uuid, Record>, id: Uuid) -> TurnFence {
        let (result, _) = state
            .apply(
                "U:owner",
                records,
                RuntimeOperation::Begin {
                    turn_id: Uuid::new_v4(),
                    worker: Uuid::new_v4(),
                    origin: OriginProof::Browser(proof(&records[&id])),
                    request_digest: hash(b"request"),
                    privacy_floor: PrivacyClass::Public,
                },
                101,
            )
            .unwrap();
        let RuntimeResult::Begun(fence) = result else {
            panic!()
        };
        fence
    }
    fn propose(
        state: &mut RuntimeState,
        records: &BTreeMap<Uuid, Record>,
        fence: &TurnFence,
    ) -> Action {
        let (result, _) = state
            .apply(
                "U:owner",
                records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::VisualTextCard {
                        text: "A useful answer".into(),
                    },
                    privacy: PrivacyClass::Public,
                },
                102,
            )
            .unwrap();
        let RuntimeResult::Proposed(action) = result else {
            panic!()
        };
        action
    }
    fn poll(
        state: &mut RuntimeState,
        records: &BTreeMap<Uuid, Record>,
        id: Uuid,
        now: i64,
    ) -> Vec<Action> {
        let (result, _) = state
            .apply(
                "U:owner",
                records,
                RuntimeOperation::Poll {
                    connection: proof(&records[&id]),
                },
                now,
            )
            .unwrap();
        let RuntimeResult::Pending(actions) = result else {
            panic!()
        };
        actions
    }
    fn ack(action: &Action, record: &Record) -> RuntimeOperation {
        RuntimeOperation::Ack {
            action_id: action.id,
            turn_id: action.turn_id,
            generation: action.generation,
            connection: proof(record),
            channel: action.channel,
            content_digest: action.content_digest.clone(),
        }
    }

    #[test]
    fn ambiance_ack_is_exact_durable_order_and_duplicate_after_deadline_is_idempotent() {
        let id = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let proposed = propose(&mut state, &records, &fence);
        assert!(
            state
                .apply("U:owner", &records, ack(&proposed, &records[&id]), 103)
                .is_err()
        );
        let dispatched = poll(&mut state, &records, id, 103).remove(0);
        assert_eq!(dispatched.deadline_ms, 3103);
        assert_eq!(dispatched.display_expires_at_ms, 60102);
        let mut wrong = ack(&dispatched, &records[&id]);
        if let RuntimeOperation::Ack { generation, .. } = &mut wrong {
            *generation += 1;
        }
        assert!(state.apply("U:owner", &records, wrong, 104).is_err());
        let mut wrong = ack(&dispatched, &records[&id]);
        if let RuntimeOperation::Ack { content_digest, .. } = &mut wrong {
            *content_digest = hash(b"different");
        }
        assert!(state.apply("U:owner", &records, wrong, 104).is_err());
        let (_, events) = state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 104)
            .unwrap();
        assert!(matches!(
            events[0],
            RuntimeData::ActionChanged {
                status: ActionStatus::Acknowledged,
                ..
            }
        ));
        assert!(state.turn.as_ref().unwrap().finished);
        let (_, repeated) = state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 4104)
            .unwrap();
        assert!(repeated.is_empty());
        let next = begin(&mut state, &records, id);
        assert!(next.generation > fence.generation);
        assert!(
            state
                .apply(
                    "U:owner",
                    &records,
                    RuntimeOperation::Propose {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: fence.worker,
                        intent: SemanticIntent::VisualTextCard {
                            text: "late".into()
                        },
                        privacy: PrivacyClass::Public
                    },
                    105
                )
                .is_err()
        );
    }

    #[test]
    fn ambiance_heartbeat_does_not_cancel_but_hide_rotation_and_privacy_raise_do() {
        let id = Uuid::new_v4();
        let mut records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let action = propose(&mut state, &records, &fence);
        poll(&mut state, &records, id, 103);
        let old = &records[&id];
        let heartbeat = transition(
            Some(old),
            1,
            id,
            &Mutation::State {
                token_hash: old.token_hash.clone(),
                incarnation: old.incarnation,
                sequence: 2,
                visible: true,
            },
            104,
        )
        .unwrap()
        .0;
        records.insert(id, heartbeat);
        assert!(state.reconcile(&records, 104).is_empty());
        let (_, events) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::VisualTextCard {
                        text: "private service data".into(),
                    },
                    privacy: PrivacyClass::Private,
                },
                105,
            )
            .unwrap();
        assert!(events.iter().any(|e| matches!(
            e,
            RuntimeData::Decision {
                action_id: None,
                privacy: PrivacyClass::Private,
                ..
            }
        )));
        assert_eq!(state.actions[&action.id].status, ActionStatus::Cancelled);
        assert_eq!(state.turn.as_ref().unwrap().privacy, PrivacyClass::Private);
        records.get_mut(&id).unwrap().visible = false;
        state.reconcile(&records, 106);
        assert!(state.turn.as_ref().unwrap().cancelled);
        records.get_mut(&id).unwrap().visible = true;
        records.get_mut(&id).unwrap().incarnation = Uuid::new_v4();
        assert!(
            state
                .apply("U:owner", &records, ack(&action, &records[&id]), 107)
                .is_err()
        );
    }

    #[test]
    fn ambiance_same_key_retry_precedes_logged_fallback_and_never_claims_playback() {
        let id = Uuid::new_v4();
        let other = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id)), (other, browser(other))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let action = propose(&mut state, &records, &fence);
        assert_eq!(action.surface_id, id);
        let first = poll(&mut state, &records, id, 103).remove(0);
        let retry = poll(&mut state, &records, id, 3103).remove(0);
        assert_eq!(retry.id, first.id);
        assert_eq!(retry.attempts, 2);
        let events = state.reconcile(&records, 6103);
        assert!(events.iter().any(
            |e| matches!(e,RuntimeData::Repair{previous_action,..} if *previous_action==first.id)
        ));
        let replacement = poll(&mut state, &records, other, 6104).remove(0);
        assert_ne!(replacement.id, first.id);
        assert_eq!(replacement.surface_id, other);
        assert_eq!(
            state.actions[&first.id].status,
            ActionStatus::OutcomeUnknown
        );
    }

    #[test]
    fn ambiance_recovery_respects_live_worker_and_cancel_requires_own_fence() {
        let id = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let (_, events) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Recover {
                    worker: Uuid::new_v4(),
                },
                102,
            )
            .unwrap();
        assert!(events.is_empty());
        assert!(
            state
                .apply(
                    "U:owner",
                    &records,
                    RuntimeOperation::Cancel {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: Uuid::new_v4()
                    },
                    103
                )
                .is_err()
        );
        assert!(!state.turn.as_ref().unwrap().cancelled);
        let events = state.reconcile(&records, WORKER_LEASE_MS + 102);
        assert!(!events.is_empty());
        assert!(state.turn.as_ref().unwrap().cancelled);
    }

    #[test]
    fn ambiance_target_loss_and_unpolled_proposal_repair_but_origin_loss_does_not() {
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        let pin = crate::surface_registry::pin_surface_id("U:owner", "aabb");
        let pin_record = transition(
            None,
            0,
            pin,
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            100,
        )
        .unwrap()
        .0;
        let original = BTreeMap::from([
            (first, browser(first)),
            (second, browser(second)),
            (pin, pin_record),
        ]);
        for mode in ["hide", "revoke", "lease", "unpolled", "origin"] {
            let mut records = original.clone();
            let mut state = RuntimeState::default();
            let (RuntimeResult::Begun(fence), _) = state
                .apply(
                    "U:owner",
                    &records,
                    RuntimeOperation::Begin {
                        turn_id: Uuid::new_v4(),
                        worker: Uuid::new_v4(),
                        origin: OriginProof::Pin {
                            device: AuthenticatedDeviceIdentity::from_edge("aabb").unwrap(),
                            surface_id: pin,
                        },
                        request_digest: hash(b"request"),
                        privacy_floor: PrivacyClass::SharedRoom,
                    },
                    101,
                )
                .unwrap()
            else {
                panic!()
            };
            let action = propose(&mut state, &records, &fence);
            assert_eq!(action.surface_id, first);
            if mode != "unpolled" {
                poll(&mut state, &records, first, 103);
            }
            match mode {
                "hide" => records.get_mut(&first).unwrap().visible = false,
                "revoke" => records.get_mut(&first).unwrap().revoked = true,
                "lease" => records.get_mut(&first).unwrap().lease_expires_at = 104,
                "origin" => records.get_mut(&pin).unwrap().revoked = true,
                _ => {}
            }
            let events = state.reconcile(&records, if mode == "unpolled" { 3102 } else { 104 });
            let repaired = events
                .iter()
                .any(|e| matches!(e,RuntimeData::Repair{surface_id,..}if *surface_id==second));
            assert_eq!(repaired, mode != "origin", "{mode}");
            if repaired {
                let replacement = state.actions.values().find(|a| a.id != action.id).unwrap();
                assert_eq!(replacement.root_id, action.root_id);
                assert_eq!(replacement.content_digest, action.content_digest);
            }
        }
    }

    #[test]
    fn ambiance_single_card_and_origin_scoped_privacy_ceiling_are_hard_blockers() {
        let id = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        propose(&mut state, &records, &fence);
        let extra = RuntimeOperation::Propose {
            turn_id: fence.turn_id,
            generation: fence.generation,
            worker: fence.worker,
            intent: SemanticIntent::VisualTextCard {
                text: "another".into(),
            },
            privacy: PrivacyClass::Public,
        };
        assert!(matches!(
            state.apply("U:owner", &records, extra, 103),
            Err(RuntimeError::Busy)
        ));
        for class in [
            PrivacyClass::NearUser,
            PrivacyClass::Private,
            PrivacyClass::Sensitive,
        ] {
            let candidate = policy::candidate(&records[&id], id, Channel::VisualCard, class, 103);
            assert_eq!(candidate.blocker, Some(policy::Blocker::Privacy));
            assert_eq!(candidate.score(), 0);
        }
    }

    #[test]
    fn ambiance_acknowledged_payload_expires_and_retry_keeps_only_replacement_payload() {
        let id = Uuid::new_v4();
        let mut records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let action = propose(&mut state, &records, &fence);
        let dispatched = poll(&mut state, &records, id, 103).remove(0);
        state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 104)
            .unwrap();
        assert!(!state.actions[&action.id].intent.text().is_empty());
        records.get_mut(&id).unwrap().lease_expires_at = 100_000;
        let events = state.reconcile(&records, action.display_expires_at_ms);
        assert!(state.actions[&action.id].intent.text().is_empty());
        assert!(events.iter().any(
            |e| matches!(e,RuntimeData::PayloadCleared{action_id,..}if *action_id==action.id)
        ));
        assert_eq!(
            state.actions[&action.id].content_digest,
            action.content_digest
        );
        assert!(
            state
                .reconcile(&records, action.display_expires_at_ms + 1)
                .is_empty()
        );
    }
}
