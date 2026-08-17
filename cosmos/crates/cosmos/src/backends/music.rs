//! Catalog-backed music search using MusicBrainz.
//!
//! Smart-playlist responses must name real recordings. A language model may
//! help phrase a search, but it is not a catalog and may invent tracks. This
//! adapter returns only MusicBrainz recording rows and carries a real ISRC when
//! the catalog has one.

use serde::Deserialize;

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
    let base = std::env::var("CARRY_MUSICBRAINZ_BASE_URL")
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
            "ai-pin-revival-cosmos/1.0 (music catalog search)",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_rows_require_a_title_and_artist() {
        let response: SearchResponse = serde_json::from_str(
            r#"{"recordings":[{"title":"Around the World","artist-credit":[{"name":"Daft Punk"}],"isrcs":["GBDUW0600009"]},{"title":"","artist-credit":[]}]}"#,
        )
        .unwrap();
        let recording = &response.recordings[0];
        assert_eq!(recording.title, "Around the World");
        assert_eq!(recording.artist_credit[0].name, "Daft Punk");
        assert_eq!(recording.isrcs[0], "GBDUW0600009");
    }
}
