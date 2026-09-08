//! Immutable text carried with one authorized document task. Raw content is
//! process-local; durable actions hold the visual cache's expiring reference.
use super::{RuntimeError, TurnFence, action::Position, screen::ScreenContext};
use serde::Serialize;
use uuid::Uuid;

pub const MAX_WIRE_BYTES: usize = 8192;
pub const MAX_EXPLANATION_BYTES: usize = 2000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
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
    /// Only a full captured document whose original bytes match the named
    /// version can travel. A selection, a changed file or an ETag cannot be
    /// substituted for those bytes. No path is read by the server.
    pub fn from_context(
        context: &ScreenContext,
        explanation: String,
        fence: &TurnFence,
    ) -> Result<Self, RuntimeError> {
        let document = context
            .document
            .as_ref()
            .ok_or(RuntimeError::InvalidRequest)?;
        let version = document
            .version
            .as_ref()
            .ok_or(RuntimeError::InvalidRequest)?;
        if !context.valid()
            || !matches!(document.locator, super::action::Locator::File { .. })
            || crate::surface_registry::hash(context.text.as_bytes()) != *version
            || !plain_text(&context.text)
            || explanation.len() > MAX_EXPLANATION_BYTES
            || !plain_text(&explanation)
            || !position_exists(&context.text, document.position.as_ref())
            || fence.turn_id.is_nil()
            || !(1..=9_007_199_254_740_991).contains(&fence.generation)
        {
            return Err(RuntimeError::InvalidRequest);
        }
        let snapshot = Self {
            text: context.text.clone(),
            explanation,
            version: version.clone(),
            task_id: fence.turn_id,
            revision: fence.generation,
        };
        // Leave the existing 12 KiB room envelope unchanged. JSON escaping
        // counts toward the bound; truncation would change the document.
        if serde_json::to_vec(&snapshot)
            .map_err(|_| RuntimeError::InvalidRequest)?
            .len()
            > MAX_WIRE_BYTES - 32
        {
            return Err(RuntimeError::InvalidRequest);
        }
        Ok(snapshot)
    }

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
        crate::surface_registry::hash(canonical.to_string().as_bytes())
    }
}

pub fn plain_text(text: &str) -> bool {
    !text.replace("\r\n", "\n").chars().any(|c| {
        (c < ' ' && c != '\t' && c != '\n') || matches!(c, '\u{007f}' | '\u{2028}' | '\u{2029}')
    })
}

pub fn position_exists(text: &str, position: Option<&Position>) -> bool {
    match position {
        None => true,
        Some(Position::Line { line }) => {
            *line > 0 && *line as usize <= text.bytes().filter(|b| *b == b'\n').count() + 1
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambiance::{
        action::{Locator, Operation},
        continuation::DocumentHandle,
    };

    fn source() -> (ScreenContext, TurnFence) {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../contracts/fixtures/ambiance-document-snapshot-v1.json"
        ))
        .unwrap();
        let mut context = ScreenContext::new(
            "Text editor".into(),
            fixture["document"]["text"].as_str().unwrap().into(),
        );
        context.document = Some(DocumentHandle {
            app: "Text editor".into(),
            locator: Locator::File {
                root_id: "notes".into(),
                relative: "notes.txt".into(),
            },
            version: Some(fixture["document"]["version"].as_str().unwrap().into()),
            position: Some(Position::Line { line: 2 }),
            label: "notes.txt".into(),
        });
        (
            context,
            TurnFence {
                turn_id: Uuid::from_u128(8),
                generation: 2,
                worker: Uuid::from_u128(10),
                origin_surface: Uuid::from_u128(11),
            },
        )
    }

    #[test]
    fn ambiance_document_snapshot_binds_original_bytes_explanation_and_task_revision() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../contracts/fixtures/ambiance-document-snapshot-v1.json"
        ))
        .unwrap();
        let (context, fence) = source();
        let snapshot = Snapshot::from_context(
            &context,
            fixture["document"]["explanation"].as_str().unwrap().into(),
            &fence,
        )
        .unwrap();
        let operation: Operation = serde_json::from_value(fixture["operation"].clone()).unwrap();
        assert_eq!(operation.content_digest(), fixture["contentDigest"]);
        assert_eq!(
            snapshot.digest(),
            fixture["operation"]["locator"]["content"]["digest"]
        );
        let card = crate::ambiance::visual::Card::Document { snapshot };
        assert_eq!(card.value(), fixture["document"]);
        assert_eq!(format!("{card:?}"), "Card([REDACTED])");
        let mut changed = context.clone();
        changed.text.push_str("another source revision");
        assert!(Snapshot::from_context(&changed, String::new(), &fence).is_err());
        changed.text = context.text.replace("\r\n", "\n");
        assert!(
            Snapshot::from_context(&changed, String::new(), &fence).is_err(),
            "hash the source bytes, not normalized display text"
        );
        changed.text = "Second 🚀 line".into();
        assert!(
            Snapshot::from_context(&changed, String::new(), &fence).is_err(),
            "a selection is not a full document"
        );
        let explanation =
            Snapshot::from_context(&context, "A different explanation".into(), &fence).unwrap();
        assert_ne!(card.digest(), explanation.digest());
        let mut next = fence.clone();
        next.generation += 1;
        let next = Snapshot::from_context(&context, String::new(), &next).unwrap();
        assert_ne!(next.digest(), explanation.digest());
    }

    #[test]
    fn ambiance_document_snapshot_refuses_unsupported_content_position_and_wire_size() {
        let (context, fence) = source();
        for text in [
            "word\0word".into(),
            "word\rword".into(),
            "word\u{2028}word".into(),
            "\t".repeat(6000) + "x",
        ] {
            let mut changed = context.clone();
            changed.document.as_mut().unwrap().version =
                Some(crate::surface_registry::hash(text.as_bytes()));
            changed.document.as_mut().unwrap().position = Some(Position::Line { line: 1 });
            changed.text = text;
            assert!(Snapshot::from_context(&changed, String::new(), &fence).is_err());
        }
        for position in [
            Position::Line { line: 4 },
            Position::Page { page: 1 },
            Position::Fragment {
                value: "heading".into(),
            },
        ] {
            let mut changed = context.clone();
            changed.document.as_mut().unwrap().position = Some(position);
            assert!(Snapshot::from_context(&changed, String::new(), &fence).is_err());
        }
        assert!(
            Snapshot::from_context(&context, "a".repeat(MAX_EXPLANATION_BYTES + 1), &fence)
                .is_err()
        );
    }
}
