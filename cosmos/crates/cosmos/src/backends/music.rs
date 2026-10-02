//! Catalog-backed music search using MusicBrainz, and where a played track's
//! cover art lives.
//!
//! Smart-playlist responses must name real recordings. A language model may
//! help phrase a search, but it is not a catalog and may invent tracks. This
//! adapter returns only MusicBrainz recording rows and carries a real ISRC when
//! the catalog has one.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{BackendError, http};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Track {
    pub title: String,
    pub artists: Vec<String>,
    pub isrc: String,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    recordings: Vec<Recording>,
}

#[derive(Deserialize)]
struct Recording {
    #[serde(default)]
    title: String,
    #[serde(default, rename = "artist-credit")]
    artist_credit: Vec<ArtistCredit>,
    #[serde(default)]
    isrcs: Vec<String>,
}

#[derive(Deserialize)]
struct ArtistCredit {
    #[serde(default)]
    name: String,
}

pub async fn search(query: &str, limit: usize) -> Result<Vec<Track>, BackendError> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Err(BackendError::NoResult);
    }
    let base = std::env::var("COSMOS_MUSICBRAINZ_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://musicbrainz.org".to_owned());
    let url = format!(
        "{}/ws/2/recording?query={}&fmt=json&limit={}",
        base.trim_end_matches('/'),
        super::places::encode(query),
        limit.clamp(1, 24),
    );
    let response: SearchResponse = http()
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "luma-cosmos/1.0 (music catalog search)",
        )
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    let tracks = response
        .recordings
        .into_iter()
        .filter_map(|recording| {
            let title = recording.title.trim().to_owned();
            if title.is_empty() {
                return None;
            }
            let artists = recording
                .artist_credit
                .into_iter()
                .map(|artist| artist.name.trim().to_owned())
                .filter(|artist| !artist.is_empty())
                .collect::<Vec<_>>();
            if artists.is_empty() {
                return None;
            }
            Some(Track {
                title,
                artists,
                isrc: recording.isrcs.into_iter().next().unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    if tracks.is_empty() {
        Err(BackendError::NoResult)
    } else {
        Ok(tracks)
    }
}

// ── Artwork ─────────────────────────────────────────────────────────────────
//
// Stock `Track.emitNotableEvent` records a TIDAL `albumArt` URL and
// `albumArtUuid`. The Luma providers record neither (`MusicHooks.kt:664-708`),
// so My Data and the dashboard ask here from the track's `provider` and
// `trackID`. A TIDAL cover is built from `albumArtUuid` where it is shown.

const SPOTIFY_OEMBED: &str = "https://open.spotify.com/oembed";
const MAX_OEMBED_BYTES: usize = 64 * 1024;
const MAX_ARTWORK_URL_CHARS: usize = 2048;

/// The oEmbed lookup refuses redirects, so the answer can only come from the
/// host asked, and gets less time than a tool call: a cover is decoration.
fn artwork_http() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .connect_timeout(Duration::from_secs(3))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

fn youtube_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn spotify_track_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// Only Spotify's image CDNs, over HTTPS with no credentials in the URL.
fn spotify_cover(value: &str) -> bool {
    if value.chars().count() > MAX_ARTWORK_URL_CHARS {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && (host == "i.scdn.co" || host.ends_with(".spotifycdn.com"))
}

/// The provider the Pin's music bridge plays from. Spotify when unset, as the
/// Pin's own `MusicConfig` defaults.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MusicProvider {
    #[default]
    Spotify,
    YoutubeMusic,
    Tidal,
    AppleMusic,
}

impl MusicProvider {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Spotify => "spotify",
            Self::YoutubeMusic => "youtube_music",
            Self::Tidal => "tidal",
            Self::AppleMusic => "apple_music",
        }
    }

    /// The provider a wire or path value names, if it is one.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        [
            Self::Spotify,
            Self::YoutubeMusic,
            Self::Tidal,
            Self::AppleMusic,
        ]
        .into_iter()
        .find(|provider| provider.as_str() == value)
    }
}

#[derive(Deserialize)]
struct OEmbed {
    #[serde(default)]
    thumbnail_url: String,
}

/// The cover of one track: YouTube Music's thumbnail by video id, Spotify's
/// through its public oEmbed. `NoResult` for anything else.
pub async fn artwork_url(provider: MusicProvider, id: &str) -> Result<String, BackendError> {
    artwork_url_from(SPOTIFY_OEMBED, provider, id).await
}

async fn artwork_url_from(
    oembed: &str,
    provider: MusicProvider,
    id: &str,
) -> Result<String, BackendError> {
    match provider {
        MusicProvider::YoutubeMusic if youtube_video_id(id) => {
            Ok(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))
        }
        MusicProvider::Spotify if spotify_track_id(id) => spotify_artwork(oembed, id).await,
        _ => Err(BackendError::NoResult),
    }
}

async fn spotify_artwork(oembed: &str, id: &str) -> Result<String, BackendError> {
    let mut response = artwork_http()
        .get(oembed)
        .query(&[("url", format!("https://open.spotify.com/track/{id}"))])
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_OEMBED_BYTES as u64)
    {
        return Err(BackendError::Unavailable);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| BackendError::Unavailable)?
    {
        if body.len() + chunk.len() > MAX_OEMBED_BYTES {
            return Err(BackendError::Unavailable);
        }
        body.extend_from_slice(&chunk);
    }
    let answer: OEmbed = serde_json::from_slice(&body).map_err(|_| BackendError::Unavailable)?;
    if spotify_cover(&answer.thumbnail_url) {
        Ok(answer.thumbnail_url)
    } else {
        Err(BackendError::NoResult)
    }
}
