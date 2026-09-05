//! Principal-scoped suppression of recent dispatched speech, never a voiceprint.
//! The window starts at dispatch; stock transport cannot attest actual playback.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const WINDOW_MS: i64 = 30_000;
pub const MAX_WINDOWS: usize = 32;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub action_id: Uuid,
    pub fingerprint: String,
    pub expires_at_ms: i64,
    pub privacy: super::PrivacyClass,
}

/// Exact normalized utterance only. No fuzzy, speaker, or partial-sentence
/// inference: punctuation, case and whitespace are the only ignored features.
pub fn fingerprint(text: &str) -> String {
    let normalized = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ");
    crate::surface_registry::hash(format!("echo-v1\0{normalized}").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ambiance_echo_matches_normalized_utterances_without_fuzzy_matching() {
        assert_eq!(
            fingerprint("  Sådan, går det!"),
            fingerprint("sådan går det")
        );
        assert_ne!(
            fingerprint("turn on the light"),
            fingerprint("turn off the light")
        );
        assert_ne!(fingerprint("yes"), fingerprint("say yes again"));
    }
}
