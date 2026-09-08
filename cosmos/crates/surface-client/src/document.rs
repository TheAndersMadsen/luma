//! Independent verification of the immutable document carried by a task.
use crate::action::{Locator, Operation, Position, digest_text};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    pub id: Uuid,
    pub digest: String,
    pub expires_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audience: Option<Uuid>,
}

impl Reference {
    pub fn valid(&self) -> bool {
        !self.id.is_nil()
            && digest_text(&self.digest)
            && (1..=9_007_199_254_740_991).contains(&self.expires_at_ms)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Document,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    kind: Kind,
    pub text: String,
    pub explanation: String,
    pub version: String,
    pub task_id: Uuid,
    pub revision: u64,
}

impl std::fmt::Debug for Snapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Snapshot([REDACTED])")
    }
}

impl Snapshot {
    pub fn digest(&self) -> String {
        let canonical = serde_json::json!([
            "cosmos.document-snapshot",
            1,
            self.text,
            self.explanation,
            self.version,
            self.task_id,
            self.revision.to_string(),
        ]);
        format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()))
    }

    pub(crate) fn matches(
        &self,
        operation: &Operation,
        surface: Uuid,
        turn: Uuid,
        generation: u64,
        expires: i64,
    ) -> bool {
        let Operation::Open {
            locator: Locator::Snapshot { content, .. },
            version: Some(version),
            position,
            ..
        } = operation
        else {
            return false;
        };
        let plain = |text: &str| {
            !text.replace("\r\n", "\n").chars().any(|c| {
                (c < ' ' && c != '\t' && c != '\n')
                    || matches!(c, '\u{007f}' | '\u{2028}' | '\u{2029}')
            })
        };
        content.valid()
            && content.audience == Some(surface)
            && content.expires_at_ms == expires
            && content.digest == self.digest()
            && self.task_id == turn
            && self.revision == generation
            && self.version == *version
            && self.version == format!("{:x}", Sha256::digest(self.text.as_bytes()))
            && !self.text.trim().is_empty()
            && self.text.len() <= 8000
            && plain(&self.text)
            && self.explanation.len() <= 2000
            && plain(&self.explanation)
            && match position {
                None => true,
                Some(Position::Line { line }) => {
                    *line > 0
                        && *line as usize <= self.text.bytes().filter(|b| *b == b'\n').count() + 1
                }
                _ => false,
            }
            && serde_json::to_vec(self).is_ok_and(|bytes| bytes.len() <= 8192)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_snapshot_checks_body_reference_recipient_task_and_expiry_independently() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/fixtures/ambiance-document-snapshot-v1.json"
        ))
        .unwrap();
        let snapshot: Snapshot = serde_json::from_value(fixture["document"].clone()).unwrap();
        let operation: Operation = serde_json::from_value(fixture["operation"].clone()).unwrap();
        assert!(operation.valid());
        assert_eq!(operation.content_digest(), fixture["contentDigest"]);
        let matches = |document: &Snapshot, op: &Operation, surface, turn, generation, expiry| {
            document.matches(
                op,
                Uuid::from_u128(surface),
                Uuid::from_u128(turn),
                generation,
                expiry,
            )
        };
        assert!(matches(&snapshot, &operation, 3, 8, 2, 20000));
        for (surface, turn, generation, expiry) in [
            (4, 8, 2, 20000),
            (3, 9, 2, 20000),
            (3, 8, 3, 20000),
            (3, 8, 2, 20001),
        ] {
            assert!(!matches(
                &snapshot, &operation, surface, turn, generation, expiry
            ));
        }
        for key in ["text", "explanation", "version"] {
            let mut wire = fixture["document"].clone();
            wire[key] = "changed".into();
            let changed: Snapshot = serde_json::from_value(wire).unwrap();
            assert!(!matches(&changed, &operation, 3, 8, 2, 20000));
        }
        let mut unbound = operation.clone();
        if let Operation::Open {
            locator: Locator::Snapshot { content, .. },
            ..
        } = &mut unbound
        {
            content.audience = None;
        }
        assert!(!matches(&snapshot, &unbound, 3, 8, 2, 20000));
        assert!(!format!("{snapshot:?}").contains(&snapshot.text));
    }
}
