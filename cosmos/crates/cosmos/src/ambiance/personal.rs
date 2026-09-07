//! Personal surfaces and private routing. Memory belongs to the runtime and is
//! retrieved by class; the reply's class then decides where it may appear.
//! Above `shared_room` only a personal surface the owner declared for that
//! class is eligible: it holds the card while connected, renders it only once
//! its unlocked foreground reports visible, and loses it the moment that
//! foreground goes away. Every shared surface is suppressed with a privacy
//! blocker, and what those surfaces express is the same understated
//! "heard, handled elsewhere" they show for any elsewhere-routed request.
use super::{ActionStatus, Channel, PrivacyClass, RuntimeData, RuntimeError, RuntimeState};
use crate::surface_registry::{Binding, Record};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const OWNER_APPROVAL: &str = "approve-private-display-v1";
/// A private card waits for its personal surface for five minutes.
pub const PRIVATE_DISPLAY_MS: i64 = 300_000;

/// The owner's statement that this surface may show private content while
/// the owner is present and it is unlocked. Cosmos cannot verify who is
/// looking; the UI says so. Sensitive content has no display ceiling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub maximum_class: PrivacyClass,
}
impl Policy {
    fn valid(&self) -> bool {
        matches!(
            self.maximum_class,
            PrivacyClass::NearUser | PrivacyClass::Private
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub approval_revision: u64,
    pub revision: u64,
    pub policy: Option<Policy>,
}

/// What a personal surface learns while something waits for it: that
/// something is waiting, what kind of thing it is, its class, its expiry and
/// which surface asked. It carries no content; the card or the command
/// arrives through the normal path once the surface reports its unlocked
/// foreground.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvitationKind {
    Card,
    Task,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub id: Uuid,
    pub kind: InvitationKind,
    pub origin_surface: Uuid,
    pub privacy: PrivacyClass,
    pub expires_at_ms: i64,
}

impl RuntimeState {
    pub(super) fn private_policy(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
    ) -> Result<Option<Approval>, RuntimeError> {
        let record = records
            .get(&surface)
            .filter(|r| !r.revoked && matches!(r.binding, Binding::Native { .. }))
            .ok_or(RuntimeError::InvalidOrigin)?;
        Ok(self
            .private_policies
            .get(&surface)
            .filter(|a| a.approval_revision == record.revision)
            .cloned())
    }

    /// The highest class the owner allowed this surface to show, if any.
    pub(super) fn personal_ceiling(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
    ) -> Option<PrivacyClass> {
        self.private_policy(records, surface)
            .ok()
            .flatten()
            .and_then(|approval| approval.policy)
            .map(|policy| policy.maximum_class)
    }

    /// Personal surfaces the owner declared for at least this class.
    pub(super) fn personal_surfaces(
        &self,
        records: &BTreeMap<Uuid, Record>,
        privacy: PrivacyClass,
    ) -> usize {
        records
            .values()
            .filter(|r| {
                !r.revoked
                    && self
                        .personal_ceiling(records, r.surface_id)
                        .is_some_and(|ceiling| privacy <= ceiling)
            })
            .count()
    }

    pub(super) fn set_private_policy(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<Policy>,
    ) -> Result<(Approval, Vec<RuntimeData>), RuntimeError> {
        let current = self.private_policy(records, surface)?;
        let record = &records[&surface];
        // A TV is a shared screen by construction; it never becomes personal.
        if policy.is_some()
            && matches!(&record.binding, Binding::Native { platform, .. } if platform == "android_tv")
        {
            return Err(RuntimeError::PolicyBlocked);
        }
        if record.revision != approval_revision
            || current.as_ref().map_or(0, |a| a.revision) != expected_revision
        {
            return Err(RuntimeError::Stale);
        }
        if policy.is_some_and(|p| !p.valid()) {
            return Err(RuntimeError::InvalidRequest);
        }
        let approval = Approval {
            approval_revision,
            revision: expected_revision
                .checked_add(1)
                .ok_or(RuntimeError::Unavailable)?,
            policy,
        };
        self.private_policies.insert(surface, approval.clone());
        Ok((
            approval.clone(),
            vec![RuntimeData::PrivateDisplayPolicyChanged {
                surface_id: surface,
                approval,
            }],
        ))
    }

    /// Whether the surface's own app currently reports a visible foreground
    /// on a current connection.
    pub(super) fn surface_visible(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
        now: i64,
    ) -> bool {
        let Some(record) = records.get(&surface) else {
            return false;
        };
        match record.binding {
            Binding::Browser => record.visible,
            Binding::Pin { .. } => false,
            Binding::Native { .. } => self
                .native_connections
                .get(&surface)
                .and_then(|state| state.connection.as_ref())
                .is_some_and(|connection| connection.current(record, now) && connection.visible),
        }
    }

    /// What is waiting for this surface: a private card proposed for it above
    /// the shared-room ceiling, or a device action of any class, in either
    /// case not yet dispatched because its foreground has not reported
    /// visible. A phone cannot begin an action in the background, so an
    /// action waits exactly the way a private card already does.
    pub(super) fn invitation_for(&self, surface: Uuid, now: i64) -> Option<Invitation> {
        let turn = self.turn.as_ref().filter(|t| !t.cancelled && !t.finished)?;
        self.actions
            .values()
            .find(|a| {
                a.surface_id == surface
                    && a.turn_id == turn.fence.turn_id
                    && now < a.display_expires_at_ms
                    && match a.channel {
                        Channel::VisualCard => {
                            a.privacy > PrivacyClass::SharedRoom
                                && a.status == ActionStatus::Proposed
                        }
                        channel if channel.is_action() => matches!(
                            a.status,
                            ActionStatus::Proposed | ActionStatus::AwaitingGrant
                        ),
                        _ => false,
                    }
            })
            .map(|a| Invitation {
                id: a.id,
                kind: if a.channel.is_action() {
                    InvitationKind::Task
                } else {
                    InvitationKind::Card
                },
                origin_surface: turn.fence.origin_surface,
                privacy: a.privacy,
                expires_at_ms: a.display_expires_at_ms,
            })
    }
}
