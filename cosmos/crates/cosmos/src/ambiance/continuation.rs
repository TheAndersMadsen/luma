//! Continuations. "Continue on my PC" is a new turn, not a session
//! migration: the destination inherits nothing and must hold its own
//! permissions. What the runtime remembers between the two turns is a
//! locator, a version digest and a place in the document — never the bytes,
//! never the captured screen text, and never the label, app name, path or
//! line number in a prompt.
use super::action::{Locator, Position, digest_text, text};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_APP_BYTES: usize = 64;
pub const MAX_LABEL_BYTES: usize = 120;

/// Where a document is and where in it the owner was. The source client
/// resolves the root id from its own copy of the owner's action policy; a
/// path outside every declared root is never sent.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentHandle {
    /// The origin's own application label.
    pub app: String,
    pub locator: Locator,
    /// What the destination will hash: the file's bytes or the URL's ETag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    /// What a person reads. It never reaches cognition.
    pub label: String,
}

impl std::fmt::Debug for DocumentHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DocumentHandle([REDACTED])")
    }
}

impl DocumentHandle {
    pub fn valid(&self) -> bool {
        text(&self.app, MAX_APP_BYTES)
            && self.locator.valid()
            && !matches!(self.locator, Locator::Snapshot { .. })
            && self.version.as_deref().is_none_or(digest_text)
            && self.position.as_ref().is_none_or(Position::valid)
            && text(&self.label, MAX_LABEL_BYTES)
    }
}

/// A document handle held runtime-side for one recent-context window. Its
/// class, source surface and lifetime live on the `RecentContext` row that
/// carries it, so there is one statement of each.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Continuation {
    pub id: Uuid,
    pub document: DocumentHandle,
}

impl std::fmt::Debug for Continuation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Continuation([REDACTED])")
    }
}

impl Continuation {
    pub fn valid(&self) -> bool {
        !self.id.is_nil() && self.document.valid()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ambiance_continuation_document_handle_is_bounded_and_redacted() {
        let handle: DocumentHandle = serde_json::from_value(serde_json::json!({
            "app": "Zed",
            "locator": {"scheme": "file", "rootId": "repo", "relative": "cosmos/src/state.rs"},
            "version": "7".repeat(64),
            "position": {"kind": "line", "line": 1710},
            "label": "state.rs"
        }))
        .unwrap();
        assert!(handle.valid());
        assert_eq!(format!("{handle:?}"), "DocumentHandle([REDACTED])");
        // A traversing or absolute relative path is not a locator.
        for relative in ["../secrets", "/etc/passwd", "a//b", ""] {
            let mut invalid = handle.clone();
            invalid.locator = Locator::File {
                root_id: "repo".into(),
                relative: relative.into(),
            };
            assert!(!invalid.valid(), "{relative}");
        }
        // Unknown fields never enter the handle.
        assert!(
            serde_json::from_value::<DocumentHandle>(serde_json::json!({
                "app": "Zed", "locator": {"scheme": "https", "url": "https://x.test/a"},
                "label": "a", "text": "the whole document"
            }))
            .is_err()
        );
    }
}
