//! Screen context. A native installation may send bounded text from its own
//! screen with a request. That text is the owner's own data: the turn is at
//! least `private`, the reply can appear only on a personal surface, and the
//! text reaches cognition only under the owner's per-installation permission,
//! as a delimited untrusted block, never as instructions. Without the
//! permission the runtime says so on a personal surface and the text goes
//! nowhere.
use super::{PrivacyClass, RuntimeData, RuntimeError, RuntimeState, TurnFence};
use crate::surface_registry::{Binding, Record};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const OWNER_APPROVAL: &str = "approve-screen-context-v1";
pub const MAX_APP_BYTES: usize = 64;
pub const MAX_TEXT_BYTES: usize = 8000;

/// The owner's statement that this installation's own screen text may be
/// offered to cognition. The reply's class is at least `private`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub maximum_class: PrivacyClass,
}
impl Policy {
    fn valid(&self) -> bool {
        self.maximum_class == PrivacyClass::Private
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub approval_revision: u64,
    pub revision: u64,
    pub policy: Option<Policy>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Screen,
}

/// Bounded text from the origin's own screen, sent with a request. It is
/// data about what the owner is looking at; it never carries authority.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScreenContext {
    kind: Kind,
    pub app: String,
    pub text: String,
}

impl std::fmt::Debug for ScreenContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ScreenContext([REDACTED])")
    }
}

impl ScreenContext {
    pub fn new(app: String, text: String) -> Self {
        Self {
            kind: Kind::Screen,
            app,
            text,
        }
    }

    pub fn valid(&self) -> bool {
        !self.app.trim().is_empty()
            && self.app.len() <= MAX_APP_BYTES
            && !self.app.chars().any(char::is_control)
            && !self.text.trim().is_empty()
            && self.text.len() <= MAX_TEXT_BYTES
            && !self
                .text
                .chars()
                .any(|c| c.is_control() && !c.is_whitespace())
    }

    pub fn app_digest(&self) -> String {
        crate::surface_registry::hash(self.app.as_bytes())
    }

    pub fn bytes(&self) -> u32 {
        u32::try_from(self.text.len()).unwrap_or(u32::MAX)
    }
}

/// What the durable turn keeps of an offered screen context.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offered {
    pub app_digest: String,
    pub bytes: u32,
}

impl RuntimeState {
    pub(super) fn screen_context_policy(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
    ) -> Result<Option<Approval>, RuntimeError> {
        let record = records
            .get(&surface)
            .filter(|r| !r.revoked && matches!(r.binding, Binding::Native { .. }))
            .ok_or(RuntimeError::InvalidOrigin)?;
        Ok(self
            .screen_context_policies
            .get(&surface)
            .filter(|a| a.approval_revision == record.revision)
            .cloned())
    }

    fn screen_context_permitted(&self, records: &BTreeMap<Uuid, Record>, surface: Uuid) -> bool {
        self.screen_context_policy(records, surface)
            .ok()
            .flatten()
            .and_then(|approval| approval.policy)
            .is_some()
    }

    pub(super) fn set_screen_context_policy(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<Policy>,
    ) -> Result<(Approval, Vec<RuntimeData>), RuntimeError> {
        let current = self.screen_context_policy(records, surface)?;
        let record = &records[&surface];
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
        self.screen_context_policies
            .insert(surface, approval.clone());
        Ok((
            approval.clone(),
            vec![RuntimeData::ScreenContextPolicyChanged {
                surface_id: surface,
                approval,
            }],
        ))
    }

    /// Admit the origin's screen text to this turn's cognition: once per
    /// turn, for a turn already raised to `private` by that text, only while
    /// the origin holds the permission at its current approval revision and
    /// a personal surface exists to show the reply. `PolicyBlocked` means the
    /// permission is missing; the runtime then explains that instead.
    pub(super) fn offer_screen_context(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        fence: TurnFence,
        app_digest: String,
        bytes: u32,
        now: i64,
    ) -> Result<Vec<RuntimeData>, RuntimeError> {
        if !super::state::digest_valid(&app_digest) || bytes == 0 || bytes as usize > MAX_TEXT_BYTES
        {
            return Err(RuntimeError::InvalidRequest);
        }
        let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
        if turn.finished
            || turn.fence.origin_surface != fence.origin_surface
            || turn.screen_context.is_some()
            || turn.privacy != PrivacyClass::Private
            || !self.origin_valid(turn, records, now)
            || self.personal_surfaces(records, turn.privacy) == 0
        {
            return Err(RuntimeError::Stale);
        }
        if !self.screen_context_permitted(records, turn.fence.origin_surface) {
            return Err(RuntimeError::PolicyBlocked);
        }
        let turn = self.turn.as_mut().unwrap();
        turn.screen_context = Some(Offered {
            app_digest: app_digest.clone(),
            bytes,
        });
        Ok(vec![RuntimeData::ScreenContextOffered {
            fence,
            app_digest,
            bytes,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ambiance_screen_context_is_bounded_and_wire_shaped() {
        let context: ScreenContext = serde_json::from_value(serde_json::json!({
            "kind":"screen","app":"Settings","text":"Wi-Fi\nConnected to Home"
        }))
        .unwrap();
        assert!(context.valid());
        assert_eq!(context.bytes(), 23);
        assert_eq!(
            context.app_digest(),
            crate::surface_registry::hash(b"Settings")
        );
        assert_eq!(format!("{context:?}"), "ScreenContext([REDACTED])");
        assert_eq!(
            serde_json::to_value(&context).unwrap(),
            serde_json::json!({"kind":"screen","app":"Settings","text":"Wi-Fi\nConnected to Home"})
        );
        for invalid in [
            serde_json::json!({"kind":"clipboard","app":"Settings","text":"x"}),
            serde_json::json!({"app":"Settings","text":"x"}),
            serde_json::json!({"kind":"screen","app":"Settings","text":"x","url":"https://x.test"}),
        ] {
            assert!(serde_json::from_value::<ScreenContext>(invalid).is_err());
        }
        for (app, text) in [
            ("", "x"),
            (" ", "x"),
            ("x".repeat(MAX_APP_BYTES + 1).as_str(), "x"),
            ("Set\u{0000}tings", "x"),
            ("Settings", ""),
            ("Settings", " \n"),
            ("Settings", "x".repeat(MAX_TEXT_BYTES + 1).as_str()),
            ("Settings", "a\u{0007}b"),
        ] {
            assert!(!ScreenContext::new(app.into(), text.into()).valid());
        }
        assert!(ScreenContext::new("x".repeat(MAX_APP_BYTES), "\t".repeat(10) + "x").valid());
    }
}
