use std::collections::BTreeMap;

use memvid_core::PutOptions;
use uuid::Uuid;

use crate::llm::tools::fastembed;
use crate::util::compact_whitespace;

use super::types::MemoryKind;

pub const MEMORY_TRACK: &str = "assistant-memory";
const MEMORY_SOURCE_TOOL: &str = "tool";
const ASSISTANT_MEMORY_TAG: &str = "assistant_memory";

const KEY_MEMORY_ID: &str = "memory_id";
const KEY_KIND: &str = "kind";
const KEY_IMPORTANCE: &str = "importance";
const KEY_SOURCE: &str = "source";
const KEY_CREATED_AT: &str = "created_at";
const KEY_UPDATED_AT: &str = "updated_at";
const KEY_EMBEDDING_MODEL: &str = "embedding_model";
const KEY_EMBEDDING_MODEL_REVISION: &str = "embedding_model_revision";
const KEY_EMBEDDING_DIMENSION: &str = "embedding_dimension";

#[derive(Debug, Clone)]
pub struct MemoryMetadata {
    pub memory_id: String,
    pub kind: MemoryKind,
    pub importance: f32,
    pub created_at: String,
    pub updated_at: String,
}

impl MemoryMetadata {
    pub fn new(kind: MemoryKind, importance: f32, now: String) -> Self {
        Self {
            memory_id: Uuid::new_v4().to_string(),
            kind,
            importance: importance.clamp(0.0, 1.0),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn from_extra_metadata(metadata: &BTreeMap<String, String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            memory_id: metadata.get(KEY_MEMORY_ID).cloned().unwrap_or_default(),
            kind: metadata
                .get(KEY_KIND)
                .map(|s| MemoryKind::from(s.as_str()))
                .unwrap_or_default(),
            importance: metadata
                .get(KEY_IMPORTANCE)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0.5),
            created_at: metadata
                .get(KEY_CREATED_AT)
                .cloned()
                .unwrap_or_else(|| now.clone()),
            updated_at: metadata.get(KEY_UPDATED_AT).cloned().unwrap_or(now),
        }
    }

    pub fn to_put_options(&self, text: &str) -> PutOptions {
        let title: String = compact_whitespace(text).chars().take(80).collect();

        let mut options = PutOptions::builder()
            .track(MEMORY_TRACK)
            .kind(self.kind.as_str())
            .uri(format!("memory://{}", self.memory_id))
            .title(title)
            .push_tag(ASSISTANT_MEMORY_TAG)
            .push_tag(self.kind.as_str())
            .label(MEMORY_SOURCE_TOOL)
            .enable_embedding(true)
            .auto_tag(false)
            .extract_dates(false)
            .extract_triplets(false)
            .instant_index(true)
            .build();
        options.extra_metadata = self.to_extra_metadata();
        options
    }

    pub fn to_extra_metadata(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            (KEY_MEMORY_ID.to_string(), self.memory_id.clone()),
            (KEY_KIND.to_string(), self.kind.as_str().to_string()),
            (KEY_IMPORTANCE.to_string(), self.importance.to_string()),
            (KEY_SOURCE.to_string(), MEMORY_SOURCE_TOOL.to_string()),
            (KEY_CREATED_AT.to_string(), self.created_at.clone()),
            (KEY_UPDATED_AT.to_string(), self.updated_at.clone()),
            (
                KEY_EMBEDDING_MODEL.to_string(),
                fastembed::EMBEDDED_MODEL_NAME.to_string(),
            ),
            (
                KEY_EMBEDDING_MODEL_REVISION.to_string(),
                fastembed::EMBEDDED_MODEL_REVISION.to_string(),
            ),
            (
                KEY_EMBEDDING_DIMENSION.to_string(),
                fastembed::EMBEDDED_MODEL_DIMENSIONS.to_string(),
            ),
        ])
    }
}
