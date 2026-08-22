use serde::{Deserialize, Serialize};

use crate::config::MusicProvider;

/// The current Spotify Search endpoint accepts at most ten results per HTTP
/// request. This is deliberately separate from the stock music collection
/// size: albums, playlists and libraries may return a much larger queue.
pub const MAX_SEARCH_RESULTS: usize = 10;
pub const MAX_COLLECTION_RESULTS: usize = 100;
pub const MAX_QUERY_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SpotifyStatus {
    pub active_provider: MusicProvider,
    pub enabled: bool,
    pub experimental_acknowledged: bool,
    pub state: SpotifyState,
    pub device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub engine_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpotifyState {
    Disabled,
    NotConfigured,
    Pairing,
    Ready,
    Error,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateSpotifySettings {
    #[serde(default)]
    pub active_provider: Option<MusicProvider>,
    pub enabled: bool,
    pub experimental_acknowledged: bool,
    pub device_name: String,
    #[serde(default)]
    pub music_gateway_url: Option<String>,
    #[serde(default)]
    pub music_gateway_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MusicProviderStatus {
    pub active_provider: MusicProvider,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpotifyQueryRequest {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<String>,
    #[serde(default = "default_query_limit")]
    pub limit: usize,
}

fn default_query_limit() -> usize {
    MAX_SEARCH_RESULTS
}

impl SpotifyQueryRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        const KINDS: &[&str] = &[
            "track",
            "top_hits",
            "artist",
            "album",
            "album_artist",
            "album_id",
            "genre",
            "playlist",
            "featured",
            "favorites",
            "radio",
            "recommendations",
            "generated",
            "ids",
        ];
        if !KINDS.contains(&self.kind.as_str()) {
            return Err("unsupported query kind");
        }
        if self.limit == 0 || self.limit > MAX_COLLECTION_RESULTS {
            return Err("query limit must be between 1 and 100");
        }
        if self.ids.len() > MAX_COLLECTION_RESULTS {
            return Err("too many track identifiers");
        }
        for value in self
            .primary
            .iter()
            .chain(self.secondary.iter())
            .chain(self.ids.iter())
        {
            if value.is_empty()
                || value.len() > MAX_QUERY_BYTES
                || value.chars().any(char::is_control)
            {
                return Err("invalid query value");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpotifyPlaybackRequest {
    pub id: String,
    pub duration_ms: u64,
}

impl SpotifyPlaybackRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_music_track_id(&self.id) {
            return Err("invalid track identifier");
        }
        // Stock music searches only tracks. A generous ceiling still prevents
        // an attacker from allocating a multi-gigabyte declared WAV.
        if !(1_000..=30 * 60 * 1_000).contains(&self.duration_ms) {
            return Err("invalid track duration");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpotifySaveRequest {
    pub id: String,
}

impl SpotifySaveRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if valid_music_track_id(&self.id) {
            Ok(())
        } else {
            Err("invalid track identifier")
        }
    }
}

pub fn valid_spotify_id(value: &str) -> bool {
    value.len() == 22 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

pub fn valid_music_track_id(value: &str) -> bool {
    valid_spotify_id(value)
        || (value.len() <= 320
            && value.split_once(':').is_some_and(|(provider, id)| {
                matches!(provider, "youtube_music" | "tidal" | "apple_music")
                    && !id.is_empty()
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            }))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpotifyTrack {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: u64,
    pub track_number: u32,
    pub disc_number: u32,
    pub explicit: bool,
    /// Spotify's own 0-100 popularity score, when the surface that produced
    /// the track carried one. Absent — never zero — where it is unknown, so a
    /// genuinely unpopular track stays distinguishable from an unscored one.
    /// This is a diagnostic second opinion on ordering, not a selection input:
    /// a popularity-descending list is a provider ranking, a jumbled one is
    /// relevance order wearing a ranking's clothes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub popularity: Option<u32>,
}

/// Where a query result's ORDER came from.
///
/// The planner plays `rank == 1`, and the rank is the provider's array index,
/// so after the fact the played track alone cannot say whether it was the
/// artist's biggest hit or the first row of a relevance-ordered search. This
/// records the branch that produced the list, at the branch, so the question
/// is answerable from one trace line instead of a log line that has already
/// rotated away.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpotifyRankingProvenance {
    /// `/artists/{id}/top-tracks` — the provider's own popularity ordering.
    ProviderTopTracks,
    /// The degraded path: a track search for `artist:<name>` after the
    /// top-tracks call failed or while its backoff window is open. Search is
    /// relevance-ordered, so `rank == 1` is NOT the artist's biggest hit.
    SearchRelevanceFallback,
    /// Album, playlist, saved-track, explicit-id and plain-search results. The
    /// caller asked for a specific sequence, so popularity ranking is not a
    /// property of the result and no provenance claim is being made.
    NotRanked,
}

impl SpotifyRankingProvenance {
    /// The stable snake_case spelling, for log fields and the model-visible
    /// tool payload. Kept in lockstep with the `serde` rename above.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProviderTopTracks => "provider_top_tracks",
            Self::SearchRelevanceFallback => "search_relevance_fallback",
            Self::NotRanked => "not_ranked",
        }
    }

    /// `skip_serializing_if` predicate: a result that makes no ranking claim
    /// stays off the wire, so every existing response shape is unchanged and
    /// the field appears only where it carries information.
    pub const fn is_not_ranked(&self) -> bool {
        matches!(self, Self::NotRanked)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpotifyQueryResponse {
    pub items: Vec<SpotifyTrack>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_name: Option<String>,
    pub is_user_playlist: bool,
    #[serde(skip_serializing_if = "SpotifyRankingProvenance::is_not_ranked")]
    pub ranking_provenance: SpotifyRankingProvenance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpotifyPlaybackResponse {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpotifySaveResponse {
    pub ok: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_validation_keeps_search_and_collection_limits_separate() {
        let mut request = SpotifyQueryRequest {
            kind: "track".into(),
            primary: Some("Blue in Green".into()),
            secondary: None,
            ids: Vec::new(),
            limit: MAX_SEARCH_RESULTS,
        };
        assert!(request.validate().is_ok());
        request.limit = MAX_COLLECTION_RESULTS;
        assert!(request.validate().is_ok());
        request.limit = MAX_COLLECTION_RESULTS + 1;
        assert_eq!(
            request.validate(),
            Err("query limit must be between 1 and 100")
        );
    }

    fn provenance_probe(ranking: SpotifyRankingProvenance) -> serde_json::Value {
        serde_json::to_value(SpotifyQueryResponse {
            items: Vec::new(),
            collection_name: None,
            is_user_playlist: false,
            ranking_provenance: ranking,
        })
        .expect("query response serializes")
    }

    #[test]
    fn ranking_provenance_spellings_are_stable_snake_case() {
        // The trace is read by humans and grepped by tooling long after the
        // turn; renaming a variant silently rewrites history's vocabulary.
        for (ranking, expected) in [
            (
                SpotifyRankingProvenance::ProviderTopTracks,
                "provider_top_tracks",
            ),
            (
                SpotifyRankingProvenance::SearchRelevanceFallback,
                "search_relevance_fallback",
            ),
            (SpotifyRankingProvenance::NotRanked, "not_ranked"),
        ] {
            assert_eq!(ranking.as_str(), expected);
            // `as_str` and the serde spelling must not drift apart: one feeds
            // the log field, the other the HTTP surface.
            assert_eq!(
                serde_json::to_value(ranking).expect("provenance serializes"),
                serde_json::Value::String(expected.to_string()),
            );
        }
        // Only the "no claim made" variant may be omitted from the wire.
        assert!(SpotifyRankingProvenance::NotRanked.is_not_ranked());
        assert!(!SpotifyRankingProvenance::ProviderTopTracks.is_not_ranked());
        assert!(!SpotifyRankingProvenance::SearchRelevanceFallback.is_not_ranked());
    }

    #[test]
    fn unranked_results_keep_the_existing_wire_shape() {
        // Adding a field to a `Serialize` struct changes an API shape the
        // Center UI may read. A result that makes no ranking claim must stay
        // byte-identical to what shipped before.
        let unranked = provenance_probe(SpotifyRankingProvenance::NotRanked);
        assert_eq!(
            unranked,
            serde_json::json!({ "items": [], "is_user_playlist": false }),
        );
        assert_eq!(
            provenance_probe(SpotifyRankingProvenance::SearchRelevanceFallback),
            serde_json::json!({
                "items": [],
                "is_user_playlist": false,
                "ranking_provenance": "search_relevance_fallback",
            }),
        );
    }

    #[test]
    fn absent_popularity_survives_a_round_trip_as_absent() {
        // `None` must never serialize as `0`: an unscored track and a track
        // Spotify scores at zero are different facts, and the monotonicity
        // check is only honest if it can tell them apart.
        let track = SpotifyTrack {
            id: "4uLU6hMCjMI75M1A2tKUQC".into(),
            title: "Chicago".into(),
            artists: vec!["Michael Jackson".into()],
            album: "Xscape".into(),
            duration_ms: 213_573,
            track_number: 1,
            disc_number: 1,
            explicit: false,
            popularity: None,
        };
        let encoded = serde_json::to_value(&track).expect("track serializes");
        assert!(encoded.get("popularity").is_none());
        assert_eq!(
            serde_json::from_value::<SpotifyTrack>(encoded).expect("track deserializes"),
            track,
        );
    }

    #[test]
    fn playback_rejects_unbounded_wav_declarations() {
        let request = SpotifyPlaybackRequest {
            id: "4uLU6hMCjMI75M1A2tKUQC".into(),
            duration_ms: 31 * 60 * 1_000,
        };
        assert!(request.validate().is_err());
    }

    #[test]
    fn gateway_query_omits_absent_optional_operands() {
        let request = SpotifyQueryRequest {
            kind: "track".into(),
            primary: Some("One Dance".into()),
            secondary: None,
            ids: Vec::new(),
            limit: 1,
        };
        assert_eq!(
            serde_json::to_value(request).expect("query request serializes"),
            serde_json::json!({
                "kind": "track",
                "primary": "One Dance",
                "limit": 1,
            }),
        );
    }
}
