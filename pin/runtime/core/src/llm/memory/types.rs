use memvid_core::{FrameId, SearchHitMetadata};
use serde::{Deserialize, Serialize};

use crate::llm::memory::metadata::MemoryMetadata;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Preference,
    Fact,
    Project,
    Instruction,
    Relationship,
    #[default]
    Other,
}

impl MemoryKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Preference => "preference",
            Self::Fact => "fact",
            Self::Project => "project",
            Self::Instruction => "instruction",
            Self::Relationship => "relationship",
            Self::Other => "other",
        }
    }
}

impl From<&str> for MemoryKind {
    fn from(value: &str) -> Self {
        match value {
            "preference" => Self::Preference,
            "fact" => Self::Fact,
            "project" => Self::Project,
            "instruction" => Self::Instruction,
            "relationship" => Self::Relationship,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryRecord {
    pub id: FrameId,
    pub text: String,
    pub kind: String,
    pub importance: f32,
    pub created_at: String,
    pub updated_at: String,
}

impl MemoryRecord {
    pub fn from_metadata(id: FrameId, text: String, metadata: MemoryMetadata) -> Self {
        Self {
            id,
            text,
            kind: metadata.kind.as_str().to_string(),
            importance: metadata.importance,
            created_at: metadata.created_at,
            updated_at: metadata.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MemorySearchResult {
    pub id: FrameId,
    pub text: String,
    pub score: Option<f32>,
    pub updated_at: Option<String>,
}

impl MemorySearchResult {
    pub fn from_metadata(
        id: FrameId,
        text: String,
        score: Option<f32>,
        metadata: Option<&SearchHitMetadata>,
    ) -> Self {
        Self {
            id,
            text,
            score,
            updated_at: metadata
                .map(|metadata| {
                    MemoryMetadata::from_extra_metadata(&metadata.extra_metadata).updated_at
                })
                .or_else(|| metadata.and_then(|metadata| metadata.created_at.clone())),
        }
    }
}
