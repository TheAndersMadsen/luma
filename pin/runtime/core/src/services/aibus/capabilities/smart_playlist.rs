use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use prost::Message as _;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use super::super::envelope::unwrap_plaintext_data_for_kid;
use crate::proto::aibus::{
    EncryptedSmartPlaylistRequest, EncryptedSmartPlaylistResponse, SmartPlaylistRequest,
    SmartPlaylistResponse, SongInfo,
};
use crate::proto::common::encryption::EncryptedData;
use crate::spotify::types::{MAX_QUERY_BYTES, MAX_SEARCH_RESULTS};
use crate::spotify::{
    SpotifyError, SpotifyQueryRequest, SpotifyQueryResponse, SpotifyService, SpotifyTrack,
};

const SMART_PLAYLIST_REQUEST_KID: &str = crate::tier_a::proto_kids::SMART_PLAYLIST_REQUEST;
const SMART_PLAYLIST_RESPONSE_KID: &str = crate::tier_a::proto_kids::SMART_PLAYLIST_RESPONSE;
const MAX_SMART_PLAYLIST_REQUEST_BYTES: usize = 64 * 1024;
const DEFAULT_TRACK_COUNT: usize = 5;
const MAX_PLAYBACK_HISTORY: usize = 100;
const MAX_HISTORY_ARTISTS: usize = 8;
const MAX_HISTORY_ARTIST_BYTES: usize = 256;
const MAX_ISRC_BYTES: usize = 32;
const MAX_RESPONSE_TITLE_BYTES: usize = 512;
const MAX_RESPONSE_ARTIST_BYTES: usize = 256;
const CATALOG_TIMEOUT: Duration = Duration::from_secs(4);

const MUSIC_NOT_READY: &str = "Music is not ready.";
const MUSIC_TEMPORARILY_UNAVAILABLE: &str = "Music search is temporarily unavailable.";
const MUSIC_INVALID_RESPONSE: &str = "Music search returned an invalid response.";

#[tonic::async_trait]
trait SmartPlaylistCatalog: Send + Sync {
    async fn query(
        &self,
        request: SpotifyQueryRequest,
    ) -> Result<SpotifyQueryResponse, SpotifyError>;
}

#[tonic::async_trait]
impl SmartPlaylistCatalog for SpotifyService {
    async fn query(
        &self,
        request: SpotifyQueryRequest,
    ) -> Result<SpotifyQueryResponse, SpotifyError> {
        SpotifyService::query(self, request).await
    }
}

/// Stock-compatible backend for ironman's AI-DJ request.
///
/// Humane's retired implementation asked an LLM to invent a short list of
/// `SongInfo` descriptors, which the music experience then resolved through
/// its catalog provider. Penumbra keeps the exact encrypted protobuf ABI but
/// uses a deterministic Spotify topic search. Playback history is treated as
/// an exclusion list, so a caller that supplies it does not immediately hear
/// the same title/artist combination again.
#[derive(Clone)]
pub struct SmartPlaylistHandler {
    catalog: Option<Arc<dyn SmartPlaylistCatalog>>,
}

impl SmartPlaylistHandler {
    pub fn new(spotify: Option<SpotifyService>) -> Self {
        Self {
            catalog: spotify.map(|service| Arc::new(service) as Arc<dyn SmartPlaylistCatalog>),
        }
    }

    #[cfg(test)]
    fn with_catalog(catalog: Arc<dyn SmartPlaylistCatalog>) -> Self {
        Self {
            catalog: Some(catalog),
        }
    }

    pub async fn encrypted_smart_playlist(
        &self,
        request: Request<EncryptedSmartPlaylistRequest>,
    ) -> Result<Response<EncryptedSmartPlaylistResponse>, Status> {
        let request = request.into_inner();
        let request_bytes = unwrap_plaintext_data_for_kid(
            &request.request,
            SMART_PLAYLIST_REQUEST_KID,
            MAX_SMART_PLAYLIST_REQUEST_BYTES,
        )?;
        let request = SmartPlaylistRequest::decode(request_bytes)
            .map_err(|_| Status::invalid_argument("bad SmartPlaylistRequest"))?;
        let validated = ValidatedSmartPlaylistRequest::try_from(request)?;

        // The topic and playback history may reflect personal taste. Log only
        // bounded counts and never the request text or track descriptors.
        info!(
            requested_tracks = validated.max_track_count,
            playback_history = validated.playback_history.len(),
            ">>> EncryptedSmartPlaylist"
        );

        let Some(catalog) = &self.catalog else {
            return Ok(encrypted_response(error_response(MUSIC_NOT_READY)));
        };

        // Fetch enough candidates to replace excluded history entries, while
        // retaining Spotify's bounded search-page contract and the stock
        // client's five-second RPC deadline.
        let query_limit = validated
            .max_track_count
            .saturating_add(validated.playback_history.len())
            .min(MAX_SEARCH_RESULTS)
            .max(validated.max_track_count);
        let query = SpotifyQueryRequest {
            kind: "generated".into(),
            primary: Some(validated.topic.clone()),
            secondary: None,
            ids: Vec::new(),
            limit: query_limit,
        };

        let result = match tokio::time::timeout(CATALOG_TIMEOUT, catalog.query(query)).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                let (kind, message) = smart_playlist_error(&error);
                warn!(error_kind = kind, "smart-playlist catalog request failed");
                return Ok(encrypted_response(error_response(message)));
            }
            Err(_) => {
                warn!(
                    error_kind = "timeout",
                    "smart-playlist catalog request failed"
                );
                return Ok(encrypted_response(error_response(
                    MUSIC_TEMPORARILY_UNAVAILABLE,
                )));
            }
        };

        let original_result_count = result.items.len();
        let excluded = validated
            .playback_history
            .into_iter()
            .collect::<HashSet<_>>();
        let mut candidates = result
            .items
            .into_iter()
            .filter(|track| !excluded.contains(&track_key(track)))
            .filter(valid_response_track)
            .take(validated.max_track_count)
            .collect::<Vec<_>>();

        if original_result_count > 0 && candidates.is_empty() && excluded.is_empty() {
            warn!("smart-playlist catalog returned no valid stock descriptors");
            return Ok(encrypted_response(error_response(MUSIC_INVALID_RESPONSE)));
        }

        let artist = unanimous_nonempty(candidates.iter().filter_map(|track| {
            track
                .artists
                .first()
                .map(String::as_str)
                .filter(|artist| !artist.is_empty())
        }));
        let album = unanimous_nonempty(
            candidates
                .iter()
                .map(|track| track.album.as_str())
                .filter(|album| !album.is_empty()),
        );
        let playlist = candidates
            .drain(..)
            .map(|track| SongInfo {
                song: track.title,
                artist: track.artists,
                // SpotifyTrack intentionally exposes only fields used by the
                // native provider ABI. Leave the proto2 ISRC absent instead of
                // inventing one or placing a Spotify ID in the wrong field.
                isrc: None,
            })
            .collect::<Vec<_>>();

        info!(
            returned_tracks = playlist.len(),
            "<<< EncryptedSmartPlaylist"
        );
        Ok(encrypted_response(SmartPlaylistResponse {
            playlist,
            error: None,
            artist,
            album,
        }))
    }
}

struct ValidatedSmartPlaylistRequest {
    topic: String,
    max_track_count: usize,
    playback_history: Vec<String>,
}

impl TryFrom<SmartPlaylistRequest> for ValidatedSmartPlaylistRequest {
    type Error = Status;

    fn try_from(request: SmartPlaylistRequest) -> Result<Self, Self::Error> {
        let topic = request.topic.trim().to_string();
        if !valid_text(&topic, MAX_QUERY_BYTES) {
            return Err(Status::invalid_argument("invalid smart-playlist topic"));
        }

        let max_track_count = match request.max_track_count {
            Some(value) if (1..=MAX_SEARCH_RESULTS as i32).contains(&value) => value as usize,
            Some(_) => {
                return Err(Status::invalid_argument(format!(
                    "smart-playlist track count must be between 1 and {MAX_SEARCH_RESULTS}",
                )))
            }
            None => DEFAULT_TRACK_COUNT,
        };

        if request.playback_history.len() > MAX_PLAYBACK_HISTORY {
            return Err(Status::invalid_argument(
                "smart-playlist playback history is too large",
            ));
        }
        let mut playback_history = Vec::with_capacity(request.playback_history.len());
        for track in &request.playback_history {
            validate_history_track(track)?;
            playback_history.push(song_key(track));
        }

        // Stock defined two providers (Azure=0, OpenAI=1). Both are accepted
        // for wire compatibility, but neither can select an arbitrary LLM in
        // this deterministic replacement. Unknown future enum values fail
        // closed rather than silently changing routing.
        if request
            .provider
            .is_some_and(|provider| !matches!(provider, 0 | 1))
        {
            return Err(Status::invalid_argument(
                "unsupported smart-playlist provider",
            ));
        }

        Ok(Self {
            topic,
            max_track_count,
            playback_history,
        })
    }
}

fn validate_history_track(track: &SongInfo) -> Result<(), Status> {
    if !valid_text(&track.song, MAX_RESPONSE_TITLE_BYTES) {
        return Err(Status::invalid_argument(
            "invalid smart-playlist playback history",
        ));
    }
    if track.artist.len() > MAX_HISTORY_ARTISTS
        || track
            .artist
            .iter()
            .any(|artist| !valid_text(artist, MAX_HISTORY_ARTIST_BYTES))
    {
        return Err(Status::invalid_argument(
            "invalid smart-playlist playback history",
        ));
    }
    if track.isrc.as_ref().is_some_and(|isrc| {
        isrc.is_empty()
            || isrc.len() > MAX_ISRC_BYTES
            || isrc
                .bytes()
                .any(|byte| !(byte.is_ascii_alphanumeric() || byte == b'-'))
    }) {
        return Err(Status::invalid_argument(
            "invalid smart-playlist playback history",
        ));
    }
    Ok(())
}

fn valid_response_track(track: &SpotifyTrack) -> bool {
    valid_text(&track.title, MAX_RESPONSE_TITLE_BYTES)
        && !track.artists.is_empty()
        && track.artists.len() <= MAX_HISTORY_ARTISTS
        && track
            .artists
            .iter()
            .all(|artist| valid_text(artist, MAX_RESPONSE_ARTIST_BYTES))
}

fn valid_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn song_key(song: &SongInfo) -> String {
    format!(
        "{}\u{1f}{}",
        normalize(&song.song),
        song.artist
            .iter()
            .map(|artist| normalize(artist))
            .collect::<Vec<_>>()
            .join("\u{1e}")
    )
}

fn track_key(track: &SpotifyTrack) -> String {
    song_key(&SongInfo {
        song: track.title.clone(),
        artist: track.artists.clone(),
        isrc: None,
    })
}

fn unanimous_nonempty<'a>(mut values: impl Iterator<Item = &'a str>) -> Option<String> {
    let first = values.next()?;
    if values.all(|value| value == first) {
        Some(first.to_string())
    } else {
        None
    }
}

fn smart_playlist_error(error: &SpotifyError) -> (&'static str, &'static str) {
    match error {
        SpotifyError::Disabled
        | SpotifyError::AcknowledgementRequired
        | SpotifyError::NotPaired
        | SpotifyError::Pairing
        | SpotifyError::AlreadyPaired => ("not_ready", MUSIC_NOT_READY),
        SpotifyError::InvalidRequest(_) => ("invalid_catalog_request", MUSIC_INVALID_RESPONSE),
        SpotifyError::RateLimited => ("rate_limited", MUSIC_TEMPORARILY_UNAVAILABLE),
        SpotifyError::Unavailable | SpotifyError::Persistence => {
            ("unavailable", MUSIC_TEMPORARILY_UNAVAILABLE)
        }
    }
}

fn error_response(message: &str) -> SmartPlaylistResponse {
    SmartPlaylistResponse {
        playlist: Vec::new(),
        error: Some(message.to_string()),
        artist: None,
        album: None,
    }
}

fn encrypted_response(response: SmartPlaylistResponse) -> Response<EncryptedSmartPlaylistResponse> {
    Response::new(EncryptedSmartPlaylistResponse {
        response: Some(EncryptedData::new(
            SMART_PLAYLIST_RESPONSE_KID,
            response.encode_to_vec(),
        )),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use tonic::Code;

    use super::*;
    use crate::spotify::SpotifyRankingProvenance;

    #[derive(Default)]
    struct MockCatalog {
        calls: AtomicUsize,
        requests: Mutex<Vec<SpotifyQueryRequest>>,
        response: Mutex<Option<Result<SpotifyQueryResponse, SpotifyError>>>,
    }

    struct PendingCatalog;

    #[tonic::async_trait]
    impl SmartPlaylistCatalog for PendingCatalog {
        async fn query(
            &self,
            _request: SpotifyQueryRequest,
        ) -> Result<SpotifyQueryResponse, SpotifyError> {
            std::future::pending().await
        }
    }

    impl MockCatalog {
        fn with_tracks(tracks: Vec<SpotifyTrack>) -> Arc<Self> {
            Arc::new(Self {
                response: Mutex::new(Some(Ok(SpotifyQueryResponse {
                    items: tracks,
                    collection_name: None,
                    is_user_playlist: false,
                    ranking_provenance: SpotifyRankingProvenance::NotRanked,
                }))),
                ..Default::default()
            })
        }

        fn with_error(error: SpotifyError) -> Arc<Self> {
            Arc::new(Self {
                response: Mutex::new(Some(Err(error))),
                ..Default::default()
            })
        }
    }

    #[tonic::async_trait]
    impl SmartPlaylistCatalog for MockCatalog {
        async fn query(
            &self,
            request: SpotifyQueryRequest,
        ) -> Result<SpotifyQueryResponse, SpotifyError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.requests.lock().unwrap().push(request);
            self.response.lock().unwrap().take().unwrap_or_else(|| {
                Ok(SpotifyQueryResponse {
                    items: Vec::new(),
                    collection_name: None,
                    is_user_playlist: false,
                    ranking_provenance: SpotifyRankingProvenance::NotRanked,
                })
            })
        }
    }

    fn stock_request(request: SmartPlaylistRequest) -> Request<EncryptedSmartPlaylistRequest> {
        Request::new(EncryptedSmartPlaylistRequest {
            request: Some(EncryptedData::new(
                SMART_PLAYLIST_REQUEST_KID,
                request.encode_to_vec(),
            )),
        })
    }

    fn decode_response(
        response: Response<EncryptedSmartPlaylistResponse>,
    ) -> SmartPlaylistResponse {
        let envelope = response.into_inner().response.unwrap();
        assert_eq!(
            envelope.encryption_information.unwrap().kid,
            SMART_PLAYLIST_RESPONSE_KID
        );
        SmartPlaylistResponse::decode(envelope.data.as_slice()).unwrap()
    }

    fn track(id: &str, title: &str, artists: &[&str], album: &str) -> SpotifyTrack {
        SpotifyTrack {
            id: id.into(),
            title: title.into(),
            artists: artists.iter().map(|artist| (*artist).into()).collect(),
            album: album.into(),
            duration_ms: 180_000,
            track_number: 1,
            disc_number: 1,
            explicit: false,
            popularity: None,
        }
    }

    #[test]
    fn protobuf_wire_layout_matches_stock_lite_classes() {
        let song = SongInfo {
            song: "x".into(),
            artist: vec!["a".into()],
            isrc: Some("i".into()),
        };
        assert_eq!(
            song.encode_to_vec(),
            [0x0a, 0x01, b'x', 0x12, 0x01, b'a', 0x1a, 0x01, b'i']
        );

        let request = SmartPlaylistRequest {
            topic: "m".into(),
            max_track_count: Some(5),
            playback_history: vec![song.clone()],
            provider: Some(1),
        };
        assert_eq!(
            request.encode_to_vec(),
            [
                0x0a, 0x01, b'm', 0x10, 0x05, 0x1a, 0x09, 0x0a, 0x01, b'x', 0x12, 0x01, b'a', 0x1a,
                0x01, b'i', 0x30, 0x01,
            ]
        );
        // Proto2-style optional enum presence must preserve explicit Azure=0.
        assert_eq!(
            SmartPlaylistRequest {
                topic: String::new(),
                max_track_count: None,
                playback_history: Vec::new(),
                provider: Some(0),
            }
            .encode_to_vec(),
            [0x30, 0x00]
        );

        assert_eq!(
            SmartPlaylistResponse {
                playlist: vec![song],
                error: Some("e".into()),
                artist: Some("r".into()),
                album: Some("b".into()),
            }
            .encode_to_vec(),
            [
                0x0a, 0x09, 0x0a, 0x01, b'x', 0x12, 0x01, b'a', 0x1a, 0x01, b'i', 0x12, 0x01, b'e',
                0x1a, 0x01, b'r', 0x22, 0x01, b'b',
            ]
        );
    }

    #[tokio::test]
    async fn generated_query_uses_topic_count_and_excludes_playback_history() {
        let catalog = MockCatalog::with_tracks(vec![
            track(
                "4uLU6hMCjMI75M1A2tKUQC",
                "Already Heard",
                &["Artist"],
                "Album",
            ),
            track(
                "0VjIjW4GlUZAMYd2vXMi3b",
                "Fresh Track",
                &["Artist"],
                "Album",
            ),
        ]);
        let handler = SmartPlaylistHandler::with_catalog(catalog.clone());
        let response = handler
            .encrypted_smart_playlist(stock_request(SmartPlaylistRequest {
                topic: "  late night synth  ".into(),
                max_track_count: Some(1),
                playback_history: vec![SongInfo {
                    song: "already   heard".into(),
                    artist: vec!["ARTIST".into()],
                    isrc: None,
                }],
                provider: Some(0),
            }))
            .await
            .unwrap();
        let response = decode_response(response);

        assert_eq!(response.error, None);
        assert_eq!(response.playlist.len(), 1);
        assert_eq!(response.playlist[0].song, "Fresh Track");
        assert_eq!(response.artist.as_deref(), Some("Artist"));
        assert_eq!(response.album.as_deref(), Some("Album"));

        let requests = catalog.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].kind, "generated");
        assert_eq!(requests[0].primary.as_deref(), Some("late night synth"));
        assert_eq!(requests[0].secondary, None);
        assert_eq!(requests[0].limit, 2);
    }

    #[tokio::test]
    async fn absent_count_uses_stock_five_track_default() {
        let catalog = MockCatalog::with_tracks(Vec::new());
        let handler = SmartPlaylistHandler::with_catalog(catalog.clone());
        let response = handler
            .encrypted_smart_playlist(stock_request(SmartPlaylistRequest {
                topic: "focus".into(),
                ..Default::default()
            }))
            .await
            .unwrap();
        assert!(decode_response(response).playlist.is_empty());
        assert_eq!(catalog.requests.lock().unwrap()[0].limit, 5);
    }

    #[tokio::test]
    async fn provider_failure_returns_decryptable_stock_error_without_details() {
        let catalog = MockCatalog::with_error(SpotifyError::NotPaired);
        let handler = SmartPlaylistHandler::with_catalog(catalog);
        let response = handler
            .encrypted_smart_playlist(stock_request(SmartPlaylistRequest {
                topic: "focus".into(),
                max_track_count: Some(5),
                ..Default::default()
            }))
            .await
            .unwrap();
        let response = decode_response(response);
        assert!(response.playlist.is_empty());
        assert_eq!(response.error.as_deref(), Some(MUSIC_NOT_READY));
        assert_eq!(response.artist, None);
        assert_eq!(response.album, None);
    }

    #[tokio::test(start_paused = true)]
    async fn catalog_timeout_finishes_inside_stock_deadline_with_safe_error() {
        let handler = SmartPlaylistHandler::with_catalog(Arc::new(PendingCatalog));
        let response = handler
            .encrypted_smart_playlist(stock_request(SmartPlaylistRequest {
                topic: "focus".into(),
                max_track_count: Some(5),
                ..Default::default()
            }))
            .await
            .unwrap();
        assert_eq!(
            decode_response(response).error.as_deref(),
            Some(MUSIC_TEMPORARILY_UNAVAILABLE)
        );
        assert!(CATALOG_TIMEOUT < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn disabled_handler_fails_closed_in_stock_response() {
        let handler = SmartPlaylistHandler::new(None);
        let response = handler
            .encrypted_smart_playlist(stock_request(SmartPlaylistRequest {
                topic: "focus".into(),
                ..Default::default()
            }))
            .await
            .unwrap();
        assert_eq!(
            decode_response(response).error.as_deref(),
            Some(MUSIC_NOT_READY)
        );
    }

    #[tokio::test]
    async fn invalid_kid_provider_count_and_history_never_reach_catalog() {
        let catalog = MockCatalog::with_tracks(Vec::new());
        let handler = SmartPlaylistHandler::with_catalog(catalog.clone());

        let wrong_kid = handler
            .encrypted_smart_playlist(Request::new(EncryptedSmartPlaylistRequest {
                request: Some(EncryptedData::new(
                    crate::tier_a::proto_kids::COMPLETION_REQUEST,
                    SmartPlaylistRequest::default().encode_to_vec(),
                )),
            }))
            .await
            .unwrap_err();
        assert_eq!(wrong_kid.code(), Code::InvalidArgument);

        for request in [
            SmartPlaylistRequest {
                topic: "focus".into(),
                max_track_count: Some(11),
                ..Default::default()
            },
            SmartPlaylistRequest {
                topic: "focus".into(),
                provider: Some(7),
                ..Default::default()
            },
            SmartPlaylistRequest {
                topic: "focus".into(),
                playback_history: vec![SongInfo {
                    song: "heard".into(),
                    artist: vec!["bad\nartist".into()],
                    isrc: None,
                }],
                ..Default::default()
            },
        ] {
            let error = handler
                .encrypted_smart_playlist(stock_request(request))
                .await
                .unwrap_err();
            assert_eq!(error.code(), Code::InvalidArgument);
        }

        assert_eq!(catalog.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn oversized_envelope_is_rejected_before_decode_or_catalog_access() {
        let catalog = MockCatalog::with_tracks(Vec::new());
        let handler = SmartPlaylistHandler::with_catalog(catalog.clone());
        let error = handler
            .encrypted_smart_playlist(Request::new(EncryptedSmartPlaylistRequest {
                request: Some(EncryptedData::new(
                    SMART_PLAYLIST_REQUEST_KID,
                    vec![0; MAX_SMART_PLAYLIST_REQUEST_BYTES + 1],
                )),
            }))
            .await
            .unwrap_err();
        assert_eq!(error.code(), Code::InvalidArgument);
        assert_eq!(catalog.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn request_limits_never_exceed_spotify_contract() {
        const { assert!(DEFAULT_TRACK_COUNT <= MAX_SEARCH_RESULTS) };
        const { assert!(MAX_SEARCH_RESULTS <= crate::spotify::types::MAX_COLLECTION_RESULTS) };

        for count in [1, MAX_SEARCH_RESULTS as i32] {
            assert!(
                ValidatedSmartPlaylistRequest::try_from(SmartPlaylistRequest {
                    topic: "focus".into(),
                    max_track_count: Some(count),
                    ..Default::default()
                })
                .is_ok()
            );
        }
        for count in [0, MAX_SEARCH_RESULTS as i32 + 1] {
            assert!(
                ValidatedSmartPlaylistRequest::try_from(SmartPlaylistRequest {
                    topic: "focus".into(),
                    max_track_count: Some(count),
                    ..Default::default()
                })
                .is_err()
            );
        }
    }
}
