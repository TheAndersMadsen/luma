//! NER post-processing — exact port of the stock Java semantics.
//!
//! Derived from operator-owned `NER.java` and `libner.so` analysis. The native
//! side emits one
//! `label::confidence::word` triplet per merged word; this module reproduces
//! `NER.processTokens` exactly: the per-token 0.75 gate (which counts `O`
//! tokens too), the label→slot map, the unsupported-entity punt, same-slot
//! concatenation, and the 0.85 average gate over non-`O` tokens. Divergence
//! from stock here would change which utterances resolve locally, so every
//! rule cites the decompiled origin and the golden tests pin the behavior.

use std::collections::BTreeMap;

/// Stock thresholds (NER.java: PER_TOKEN_THRESHOLD / MIN_AVERAGE_THRESHOLD).
const PER_TOKEN_THRESHOLD: f64 = 0.75;
const MIN_AVERAGE_THRESHOLD: f64 = 0.85;

/// Music slots the stock extractor can actually fill (everything else punts).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NerSlots {
    pub track: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    /// Mean confidence over non-`O` tokens — the value the 0.85 gate tested.
    pub average_confidence: f64,
}

impl NerSlots {
    pub fn is_empty(&self) -> bool {
        self.track.is_none()
            && self.artist.is_none()
            && self.album.is_none()
            && self.genre.is_none()
    }
}

/// Why an extraction produced no slots (content-free; safe to log).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NerRejection {
    /// `new|latest|newest|recent` — stock defers these to the cloud planner
    /// (NER.java:184) because the catalog rank changes over time.
    RecencyDefer,
    /// A parsed token (including `O`) fell below the 0.75 per-token gate.
    LowTokenConfidence,
    /// A token mapped to MusicDescriptor / DateTime / Playlist —
    /// UNSUPPORTED_NAMED_ENTITIES in stock; the extraction punts entirely.
    UnsupportedEntity,
    /// No token mapped to a supported slot.
    NoEntities,
    /// The non-`O` mean confidence fell below the 0.85 average gate.
    LowAverageConfidence,
}

impl NerRejection {
    pub const fn label(self) -> &'static str {
        match self {
            Self::RecencyDefer => "recency_defer",
            Self::LowTokenConfidence => "low_token_confidence",
            Self::UnsupportedEntity => "unsupported_entity",
            Self::NoEntities => "no_entities",
            Self::LowAverageConfidence => "low_average_confidence",
        }
    }
}

/// One parsed `label::confidence::word` triplet.
#[derive(Clone, Debug, PartialEq)]
pub struct NerToken {
    pub label: String,
    pub confidence: f64,
    pub value: String,
}

/// Parse the native `String[]` shape: `label::conf::word`. Tokens with fewer
/// than 2 fields are dropped (stock logs and skips them); a missing value
/// field yields an empty value, matching `split("::")` semantics.
pub fn parse_tokens(raw: &[String]) -> Vec<NerToken> {
    raw.iter()
        .filter_map(|entry| {
            let mut parts = entry.split("::");
            let label = parts.next()?.to_string();
            let confidence = parts.next()?;
            let confidence = confidence.parse::<f64>().unwrap_or(0.0);
            let value = parts.next().unwrap_or("").to_string();
            Some(NerToken {
                label,
                confidence,
                value,
            })
        })
        .collect()
}

/// Stock label→slot mapping (NER.java `mapNERToIntentRepr`). `None` = label
/// carries no slot (skipped); the three `Unsupported` targets punt the run.
enum SlotTarget {
    Track,
    Artist,
    Album,
    Genre,
    Unsupported,
    Skip,
}

fn slot_target(label: &str) -> SlotTarget {
    match label {
        "song_name" => SlotTarget::Track,
        "artist_name" => SlotTarget::Artist,
        "music_album" => SlotTarget::Album,
        "music_genre" => SlotTarget::Genre,
        "playlist_name" | "music_descriptor" | "date" | "time" | "timeofday" => {
            SlotTarget::Unsupported
        }
        _ => SlotTarget::Skip,
    }
}

/// Reproduce `NER.processTokens` over the normalized utterance + parsed
/// tokens. Success returns calibrated slots; rejection returns the closed-set
/// reason. The caller decides how a rejection feeds the chat-turn run (it never
/// blocks anything — the assist is fail-open).
pub fn extract_slots(
    normalized_utterance: &str,
    tokens: &[NerToken],
) -> Result<NerSlots, NerRejection> {
    // Recency phrasings defer to the planner (stock: regex on the whole
    // normalized utterance with word boundaries).
    if normalized_utterance
        .split_whitespace()
        .any(|word| matches!(word, "new" | "latest" | "newest" | "recent"))
    {
        return Err(NerRejection::RecencyDefer);
    }

    // Per-token gate: stock applies it to every parsed token with non-blank
    // type AND value — including `O` tokens.
    if tokens.iter().any(|token| {
        !token.label.trim().is_empty()
            && !token.value.trim().is_empty()
            && token.confidence < PER_TOKEN_THRESHOLD
    }) {
        return Err(NerRejection::LowTokenConfidence);
    }

    let mut slots: BTreeMap<&'static str, Vec<&str>> = BTreeMap::new();
    for token in tokens {
        match slot_target(&token.label) {
            SlotTarget::Track => slots.entry("track").or_default().push(&token.value),
            SlotTarget::Artist => slots.entry("artist").or_default().push(&token.value),
            SlotTarget::Album => slots.entry("album").or_default().push(&token.value),
            SlotTarget::Genre => slots.entry("genre").or_default().push(&token.value),
            SlotTarget::Unsupported => return Err(NerRejection::UnsupportedEntity),
            SlotTarget::Skip => {}
        }
    }

    if slots.is_empty() {
        return Err(NerRejection::NoEntities);
    }

    // Average gate over non-`O` tokens (unmapped non-O labels count too).
    let scored: Vec<f64> = tokens
        .iter()
        .filter(|token| token.label != "O")
        .map(|token| token.confidence)
        .collect();
    let average = if scored.is_empty() {
        0.0
    } else {
        scored.iter().sum::<f64>() / scored.len() as f64
    };
    if average < MIN_AVERAGE_THRESHOLD {
        return Err(NerRejection::LowAverageConfidence);
    }

    let joined = |key: &str| -> Option<String> {
        slots
            .get(key)
            .map(|values| values.join(" "))
            .filter(|value| !value.trim().is_empty())
    };
    Ok(NerSlots {
        track: joined("track"),
        artist: joined("artist"),
        album: joined("album"),
        genre: joined("genre"),
        average_confidence: average,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(entries: &[&str]) -> Vec<NerToken> {
        parse_tokens(&entries.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn confident_track_and_artist_fill_slots() {
        let tokens = toks(&[
            "O::0.99::play",
            "song_name::0.97::smooth",
            "song_name::0.96::criminal",
            "O::0.99::by",
            "artist_name::0.98::michael",
            "artist_name::0.97::jackson",
        ]);
        let slots = extract_slots("play smooth criminal by michael jackson", &tokens).unwrap();
        assert_eq!(slots.track.as_deref(), Some("smooth criminal"));
        assert_eq!(slots.artist.as_deref(), Some("michael jackson"));
        assert!(slots.album.is_none());
        assert!(slots.average_confidence > 0.95);
    }

    #[test]
    fn one_low_token_fails_the_whole_extraction_even_o() {
        // Stock's per-token gate counts `O` tokens: one uncertain token kills
        // the local path so the cloud planner sees the utterance instead.
        let tokens = toks(&["O::0.50::play", "song_name::0.97::thriller"]);
        assert_eq!(
            extract_slots("play thriller", &tokens),
            Err(NerRejection::LowTokenConfidence)
        );
    }

    #[test]
    fn playlist_and_descriptor_and_datetime_punt() {
        for label in [
            "playlist_name",
            "music_descriptor",
            "date",
            "time",
            "timeofday",
        ] {
            let tokens = toks(&[&format!("{label}::0.99::x"), "song_name::0.99::y"]);
            assert_eq!(
                extract_slots("play x y", &tokens),
                Err(NerRejection::UnsupportedEntity),
                "{label} must punt"
            );
        }
    }

    #[test]
    fn recency_words_defer_before_anything_else() {
        let tokens = toks(&["song_name::0.99::hits"]);
        for utterance in [
            "play the latest hits",
            "play new music",
            "play the newest album",
            "play recent songs",
        ] {
            assert_eq!(
                extract_slots(utterance, &tokens),
                Err(NerRejection::RecencyDefer),
                "{utterance}"
            );
        }
        // Substrings inside words must NOT trigger (word-boundary semantics).
        assert!(extract_slots("play renewal by artist", &tokens).is_ok());
    }

    #[test]
    fn average_gate_uses_only_non_o_tokens() {
        // Non-O tokens at 0.80 average: per-token gate passes (>=0.75) but
        // the 0.85 average gate rejects; O tokens' high confidence must not
        // rescue the mean.
        let tokens = toks(&[
            "O::0.99::play",
            "song_name::0.80::something",
            "artist_name::0.80::someone",
        ]);
        assert_eq!(
            extract_slots("play something someone", &tokens),
            Err(NerRejection::LowAverageConfidence)
        );
    }

    #[test]
    fn unparseable_and_short_tokens_are_dropped_like_stock() {
        let parsed = toks(&["justonefield", "song_name::notanumber::x", "a::0.9"]);
        // "justonefield" dropped (one field); bad confidence -> 0.0; missing
        // value -> empty string.
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].confidence, 0.0);
        assert_eq!(parsed[1].value, "");
    }

    #[test]
    fn no_supported_entities_is_a_clean_rejection() {
        let tokens = toks(&["O::0.99::what", "person::0.99::alice"]);
        assert_eq!(
            extract_slots("call alice", &tokens),
            Err(NerRejection::NoEntities)
        );
    }
}
