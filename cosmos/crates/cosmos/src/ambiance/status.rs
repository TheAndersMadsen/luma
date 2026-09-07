//! Outcome-gated status for the turn's origin. The origin learns only what
//! the ledger committed: that its turn is being worked on, that an action
//! waits for another surface, that a surface of some kind showed or spoke the
//! reply, that nothing could take it, or that the outcome is unknown. A
//! shared origin never learns why nothing was eligible, and never a class
//! above its own ceiling: privacy suppression, capability misses and ordinary
//! re-routing all look the same from a shared surface.
use super::{ActionStatus, Channel, PrivacyClass, RoomProof, RuntimeError, RuntimeState};
use crate::surface_registry::Record;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Working,
    Waiting,
    Shown,
    Spoken,
    Nowhere,
    Unknown,
}

impl TurnState {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Shown | Self::Spoken | Self::Nowhere | Self::Unknown
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnStatus {
    pub turn_id: Uuid,
    pub generation: u64,
    pub state: TurnState,
    /// The surface an action waits for, showed or spoke the reply on, or
    /// whose outcome is unknown. The coordinator names only its kind.
    pub surface: Option<Uuid>,
    /// The class the status is expressed at: the turn's class capped by the
    /// origin's own ceiling, so a shared origin sees nothing above it.
    pub privacy: PrivacyClass,
}

impl RuntimeState {
    /// The current turn's status for this connection, if the connection is
    /// the turn's origin. Derived from committed state only.
    pub(super) fn turn_status(
        &self,
        records: &BTreeMap<Uuid, Record>,
        connection: &RoomProof,
        now: i64,
    ) -> Result<Option<TurnStatus>, RuntimeError> {
        let record = self.room_record(records, connection, now)?;
        let Some(turn) = self.turn.as_ref() else {
            return Ok(None);
        };
        if turn.fence.origin_surface != record.surface_id
            || turn.origin_incarnation != connection.incarnation()
        {
            return Ok(None);
        }
        let mut actions = self.actions.values().filter(|a| {
            a.turn_id == turn.fence.turn_id
                && a.generation == turn.fence.generation
                && !a.expression
        });
        let (state, surface) = if let Some(outcome) = &turn.outcome {
            let state = match outcome.channel {
                Channel::VisualCard => TurnState::Shown,
                Channel::AudioTts => TurnState::Spoken,
                // Only a device report may set an action-channel outcome, and
                // no report is accepted yet; an outcome the origin cannot name
                // is reported as one the runtime cannot confirm.
                Channel::ActionOpen
                | Channel::ActionRoute
                | Channel::ActionPlay
                | Channel::ActionRun
                | Channel::ConfirmTap => TurnState::Unknown,
            };
            (state, Some(outcome.surface_id))
        } else if let Some(pending) = actions
            .clone()
            .find(|a| matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched))
        {
            (TurnState::Waiting, Some(pending.surface_id))
        } else if let Some(unknown) = actions.find(|a| a.status == ActionStatus::OutcomeUnknown) {
            (TurnState::Unknown, Some(unknown.surface_id))
        } else if turn.finished || turn.cancelled {
            (TurnState::Nowhere, None)
        } else {
            (TurnState::Working, None)
        };
        let ceiling = self
            .personal_ceiling(records, record.surface_id)
            .unwrap_or(PrivacyClass::SharedRoom);
        Ok(Some(TurnStatus {
            turn_id: turn.fence.turn_id,
            generation: turn.fence.generation,
            state,
            surface,
            privacy: turn.privacy.min(ceiling),
        }))
    }
}
