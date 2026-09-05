use crate::surface_registry::{Binding, Record};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyClass {
    #[default]
    Public,
    SharedRoom,
    NearUser,
    Private,
    Sensitive,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Channel {
    #[serde(rename = "visual.card")]
    VisualCard,
    #[serde(rename = "audio.tts")]
    AudioTts,
}

/// Semantic proposals have no device-operation, permission, or grant fields.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SemanticIntent {
    InformationalSpeech { text: String },
    VisualTextCard { text: String },
}
impl SemanticIntent {
    pub fn text(&self) -> &str {
        match self {
            Self::InformationalSpeech { text } | Self::VisualTextCard { text } => text,
        }
    }
    pub fn channel(&self) -> Channel {
        match self {
            Self::InformationalSpeech { .. } => Channel::AudioTts,
            Self::VisualTextCard { .. } => Channel::VisualCard,
        }
    }
    pub fn valid(&self) -> bool {
        !self.text().trim().is_empty() && self.text().len() <= 4000
    }
}
impl std::fmt::Debug for SemanticIntent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SemanticIntent([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocker {
    Privacy,
    Capability,
    Unavailable,
}

/// Integer components are the complete published v1 scoring function. No
/// hints or learned preference are accepted from class-zero origins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub surface_id: Uuid,
    pub channel: Channel,
    pub blocker: Option<Blocker>,
    pub score_version: u8,
    pub shape_fit: i32,
    pub origin_affinity: i32,
    pub hint: i32,
    pub preference: i32,
}
impl Candidate {
    pub fn score(&self) -> i32 {
        self.shape_fit + self.origin_affinity + self.hint + self.preference
    }
}
pub fn candidate(
    record: &Record,
    origin: Uuid,
    channel: Channel,
    privacy: PrivacyClass,
    now: i64,
) -> Candidate {
    let capability = match (&record.binding, channel) {
        (Binding::Browser, Channel::VisualCard) => {
            crate::surface_registry::known_browser_manifest(&record.approved_manifest)
        }
        (Binding::Pin { .. }, Channel::AudioTts) => {
            record.surface_id == origin
                && record.approved_manifest == crate::surface_registry::pin_manifest()
        }
        _ => false,
    };
    let available = match record.binding {
        Binding::Browser => record.view(now).available,
        Binding::Pin { .. } => !record.revoked,
    };
    let blocker = if privacy > PrivacyClass::SharedRoom {
        Some(Blocker::Privacy)
    } else if !capability {
        Some(Blocker::Capability)
    } else if !available {
        Some(Blocker::Unavailable)
    } else {
        None
    };
    Candidate {
        surface_id: record.surface_id,
        channel,
        blocker,
        score_version: 1,
        shape_fit: if blocker.is_none() { 1000 } else { 0 },
        origin_affinity: if blocker.is_none() && record.surface_id == origin {
            10
        } else {
            0
        },
        hint: 0,
        preference: 0,
    }
}
