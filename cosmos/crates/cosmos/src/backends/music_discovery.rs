//! Grounded semantic music discovery.
//!
//! The model chooses the intent fields. This module owns current-web discovery
//! and active-provider verification. Only a provider-confirmed title and artist
//! may become a device `PlayMusic` action.

use super::music::MusicProvider;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

use super::{http, key};

const CENTER_URL_VAR: &str = "COSMOS_CENTER_MUSIC_QUERY_URL";
const DEFAULT_CENTER_URL: &str = "http://center:4000/api/internal/music/query";
const MAX_TEXT_CHARACTERS: usize = 200;
const MAX_CENTER_RESPONSE_BYTES: usize = 64 * 1024;
const DEFAULT_DISCOVERY_BUDGET: Duration = Duration::from_secs(16);
const SETTLEMENT_RESERVE: Duration = Duration::from_millis(1_500);
const PROVIDER_ATTEMPT_MAX: Duration = Duration::from_millis(4_500);
pub(crate) const PROVIDER_MAX: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MusicDiscoveryRequest {
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    pub criterion: String,
    #[serde(default = "current_timeframe")]
    pub timeframe: String,
    #[serde(default)]
    pub year: Option<u16>,
    #[serde(default)]
    pub context: Option<String>,
}

fn current_timeframe() -> String {
    "current".to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroundedMusicTrack {
    pub title: String,
    pub artist: String,
    pub provider: MusicProvider,
    pub ranking_provenance: String,
    pub discovery_provenance: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MusicDiscoveryError {
    InvalidRequest,
    NotConfigured,
    /// The wearer's music provider is not linked, or its sign-in lapsed.
    ProviderNotLinked,
    /// The provider cannot search yet: the Pin is not paired with Cosmos (a
    /// Spotify catalog is the Pin's own session), or the chosen provider
    /// cannot play on the Pin.
    ProviderNotReady,
    /// Spotify, the default provider, is turned off on the Pin (its switch in
    /// Center). Only Spotify's Pin session has that switch, so Center's 412
    /// always means Spotify (spotifyBridge.ts).
    ProviderDisabled,
    NoEvidence,
    Ambiguous,
    ProviderNoMatch,
    Deadline,
    Unavailable,
}

impl MusicDiscoveryError {
    const ALL: [Self; 10] = [
        Self::InvalidRequest,
        Self::NotConfigured,
        Self::ProviderNotLinked,
        Self::ProviderNotReady,
        Self::ProviderDisabled,
        Self::NoEvidence,
        Self::Ambiguous,
        Self::ProviderNoMatch,
        Self::Deadline,
        Self::Unavailable,
    ];

    pub fn observation(self) -> &'static str {
        match self {
            Self::InvalidRequest => "The music discovery request was invalid.",
            Self::NotConfigured => "Music discovery is not connected in this deployment.",
            Self::ProviderNotLinked => {
                "Your music provider isn't linked, or needs reconnecting. Link it in Center \
                 under Settings, Services, Music."
            }
            Self::ProviderNotReady => {
                "Music can't be looked up until your Pin is paired with Cosmos and a music \
                 provider that plays on the Pin is chosen in Center under Settings, Services, \
                 Music."
            }
            Self::ProviderDisabled => {
                "Spotify, your default music service, is turned off on your Pin. Turn it on, \
                 or choose another service and press Save, in Center under Settings, \
                 Services, Music."
            }
            Self::NoEvidence => "No well-supported answer was found for that music request.",
            Self::Ambiguous => "The available music evidence did not support one clear answer.",
            Self::ProviderNoMatch => {
                "A likely track was found, but it is not available on the active music provider."
            }
            Self::Deadline => "Music lookup took too long. Try again.",
            Self::Unavailable => "The music provider could not be reached. Try again shortly.",
        }
    }

    /// A short constant for metrics and logs.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::NotConfigured => "not_configured",
            Self::ProviderNotLinked => "provider_not_linked",
            Self::ProviderNotReady => "provider_not_ready",
            Self::ProviderDisabled => "provider_disabled",
            Self::NoEvidence => "no_evidence",
            Self::Ambiguous => "ambiguous",
            Self::ProviderNoMatch => "provider_no_match",
            Self::Deadline => "deadline",
            Self::Unavailable => "unavailable",
        }
    }
}

#[tonic::async_trait]
pub trait MusicDiscoveryBackend: Send + Sync {
    async fn discover(
        &self,
        request: MusicDiscoveryRequest,
        principal: &str,
        deadline: Option<Instant>,
    ) -> Result<GroundedMusicTrack, MusicDiscoveryError>;
}

/// Runtime adapter. Keeping it explicit makes the injected test adapter and
/// production web/provider path cross the same seam.
///
/// It holds the account store because the provider a track is verified
/// against is the account's own choice (`music_api`), read here rather than
/// asked of Center or the Pin.
pub struct ProductionMusicDiscovery {
    store: Option<crate::store::SharedStore>,
}

impl ProductionMusicDiscovery {
    pub fn new(store: Option<crate::store::SharedStore>) -> Self {
        Self { store }
    }
}

#[tonic::async_trait]
impl MusicDiscoveryBackend for ProductionMusicDiscovery {
    async fn discover(
        &self,
        request: MusicDiscoveryRequest,
        principal: &str,
        deadline: Option<Instant>,
    ) -> Result<GroundedMusicTrack, MusicDiscoveryError> {
        let started = std::time::Instant::now();
        let criterion = criterion_label(&request);
        let result = discover_production(
            request,
            principal,
            deadline.unwrap_or_else(|| Instant::now() + DEFAULT_DISCOVERY_BUDGET),
            self.store.as_ref(),
        )
        .await;
        let (provider, ranking, outcome) = match &result {
            Ok(track) => (
                track.provider.as_str(),
                ranking_label(&track.ranking_provenance),
                "grounded",
            ),
            Err(error) => ("none", "none", error.label()),
        };
        crate::metrics::record_music_discovery(
            criterion,
            provider,
            ranking,
            outcome,
            started.elapsed(),
        );
        result
    }
}

async fn discover_production(
    request: MusicDiscoveryRequest,
    principal: &str,
    deadline: Instant,
    store: Option<&crate::store::SharedStore>,
) -> Result<GroundedMusicTrack, MusicDiscoveryError> {
    validate_verification_request(&request)?;
    if principal.trim().is_empty()
        || principal.chars().count() > 512
        || principal.chars().any(char::is_control)
    {
        return Err(MusicDiscoveryError::InvalidRequest);
    }
    let admin_token = key("COSMOS_ADMIN_TOKEN").ok_or(MusicDiscoveryError::NotConfigured)?;
    let store = store.ok_or(MusicDiscoveryError::NotConfigured)?;
    let catalog = CenterProviderCatalog {
        url: key(CENTER_URL_VAR).unwrap_or_else(|| DEFAULT_CENTER_URL.to_owned()),
        provider: catalog_provider(store, principal).await?,
    };
    verify_researched_candidate(request, principal, &admin_token, deadline, &catalog).await
}

/// The provider the account plays from, as a catalog Center can search.
///
/// Apple Music can be linked but has no playback runtime on the Pin, so a
/// track verified against it could never play: the provider is not ready, not
/// a catalog miss. INFERRED. Stock verified only against TIDAL.
async fn catalog_provider(
    store: &crate::store::SharedStore,
    principal: &str,
) -> Result<MusicProvider, MusicDiscoveryError> {
    match crate::music_api::active_provider(store, principal).await {
        Ok(MusicProvider::AppleMusic) => Err(MusicDiscoveryError::ProviderNotReady),
        Ok(provider) => Ok(provider),
        Err(_) => Err(MusicDiscoveryError::Unavailable),
    }
}

async fn verify_researched_candidate(
    request: MusicDiscoveryRequest,
    principal: &str,
    admin_token: &str,
    deadline: Instant,
    provider_catalog: &dyn ProviderCatalog,
) -> Result<GroundedMusicTrack, MusicDiscoveryError> {
    validate_verification_request(&request)?;
    let title = request
        .title
        .as_deref()
        .ok_or(MusicDiscoveryError::InvalidRequest)?
        .trim();
    let artist = request
        .artist
        .as_deref()
        .ok_or(MusicDiscoveryError::InvalidRequest)?
        .trim();
    let candidate = Candidate {
        title: title.to_owned(),
        artist: artist.to_owned(),
        release_year: request.year.unwrap_or(2000),
        rationale: request.criterion.clone(),
        support: 100,
        sources: Vec::new(),
    };
    let provider_budget = stage_budget(deadline, SETTLEMENT_RESERVE, PROVIDER_MAX)?;
    let provider_deadline = tokio::time::Instant::now() + provider_budget;
    let provider_started = Instant::now();
    let verified = verify_candidates(
        &[candidate],
        provider_catalog,
        principal,
        admin_token,
        provider_deadline,
        "foreground_agent_web",
    )
    .await;
    crate::metrics::record_music_discovery_stage(
        "provider",
        result_outcome(&verified),
        provider_started.elapsed(),
    );
    match verified {
        Ok((track, index)) => {
            crate::metrics::record_music_discovery_resolution(1, Some(index), false, false);
            Ok(track)
        }
        Err(error) => {
            crate::metrics::record_music_discovery_resolution(1, None, false, false);
            Err(error)
        }
    }
}

fn result_outcome<T>(result: &Result<T, MusicDiscoveryError>) -> &'static str {
    result
        .as_ref()
        .map(|_| "ok")
        .unwrap_or_else(|error| error.label())
}

#[tonic::async_trait]
trait ProviderCatalog: Send + Sync {
    async fn query(
        &self,
        candidate: &Candidate,
        principal: &str,
        admin_token: &str,
    ) -> Result<CenterCatalogResponse, MusicDiscoveryError>;
}

/// Center's provider catalog, asked for one provider Cosmos chose.
struct CenterProviderCatalog {
    url: String,
    provider: MusicProvider,
}

#[tonic::async_trait]
impl ProviderCatalog for CenterProviderCatalog {
    async fn query(
        &self,
        candidate: &Candidate,
        principal: &str,
        admin_token: &str,
    ) -> Result<CenterCatalogResponse, MusicDiscoveryError> {
        let response =
            query_center(&self.url, candidate, principal, self.provider, admin_token).await?;
        // An answer from another provider's catalog verifies nothing here.
        if response.provider != self.provider {
            return Err(MusicDiscoveryError::Unavailable);
        }
        Ok(response)
    }
}

async fn verify_candidates(
    candidates: &[Candidate],
    catalog: &dyn ProviderCatalog,
    principal: &str,
    admin_token: &str,
    provider_deadline: tokio::time::Instant,
    discovery_provenance: &str,
) -> Result<(GroundedMusicTrack, usize), MusicDiscoveryError> {
    // The Pin's provider-backed catalog is live search, not a stable database
    // snapshot. A single exact candidate has occasionally been absent from one
    // YouTube Music result page and present in the next response under a second
    // later. Retry only that one already-researched candidate. Multiple
    // candidates already give the provider independent exact-match chances.
    let passes = if candidates.len() == 1 { 2 } else { 1 };
    let mut last_error = MusicDiscoveryError::ProviderNoMatch;
    for pass in 0..passes {
        for (index, candidate) in candidates.iter().enumerate() {
            let attempt_deadline =
                provider_deadline.min(tokio::time::Instant::now() + PROVIDER_ATTEMPT_MAX);
            let response = match tokio::time::timeout_at(
                attempt_deadline,
                catalog.query(candidate, principal, admin_token),
            )
            .await
            {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    last_error = error;
                    if candidates.len() == 1
                        && pass + 1 < passes
                        && matches!(
                            error,
                            MusicDiscoveryError::Deadline | MusicDiscoveryError::Unavailable
                        )
                    {
                        continue;
                    }
                    return Err(error);
                }
                Err(_) => {
                    last_error = MusicDiscoveryError::Deadline;
                    if candidates.len() == 1 && pass + 1 < passes {
                        continue;
                    }
                    return Err(MusicDiscoveryError::Deadline);
                }
            };
            if let Ok(track) = grounded_candidate(candidate, response, discovery_provenance) {
                return Ok((track, index));
            }
            last_error = MusicDiscoveryError::ProviderNoMatch;
        }
    }
    Err(last_error)
}

fn stage_budget(
    deadline: Instant,
    reserve: Duration,
    maximum: Duration,
) -> Result<Duration, MusicDiscoveryError> {
    let available = deadline
        .saturating_duration_since(Instant::now())
        .saturating_sub(reserve)
        .min(maximum);
    (!available.is_zero())
        .then_some(available)
        .ok_or(MusicDiscoveryError::Deadline)
}

fn criterion_label(request: &MusicDiscoveryRequest) -> &'static str {
    let value = normalized(&request.criterion);
    if value.contains("controvers") {
        "controversial"
    } else if value.contains("viral") {
        "viral"
    } else if value.contains("trend") {
        "trending"
    } else if value.contains("newest") || value.contains("latest") {
        "newest"
    } else if value.contains("underrated") {
        "underrated"
    } else if value.contains("similar") || value.contains("like") {
        "similar"
    } else if value.contains("mood") || value.contains("suitable") {
        "mood"
    } else if value.contains("top") || value.contains("best") || value.contains("most") {
        "top"
    } else if request.year.is_some() {
        "historical"
    } else {
        "other"
    }
}

fn ranking_label(value: &str) -> &'static str {
    match value {
        "not_ranked" => "not_ranked",
        _ => "invalid",
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Candidate {
    title: String,
    artist: String,
    release_year: u16,
    rationale: String,
    support: u8,
    #[serde(default)]
    sources: Vec<EvidenceSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct EvidenceSource {
    url: String,
    #[serde(default)]
    published_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct CenterCatalogResponse {
    provider: MusicProvider,
    ranking_provenance: String,
    #[serde(default)]
    items: Vec<CenterTrack>,
}

#[derive(Clone, Debug, Deserialize)]
struct CenterTrack {
    title: String,
    #[serde(default)]
    artists: Vec<String>,
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    let value = value.trim();
    !value.is_empty() && value.chars().count() <= maximum && !value.chars().any(char::is_control)
}

fn validate_request(request: &MusicDiscoveryRequest) -> Result<(), MusicDiscoveryError> {
    const TIMEFRAMES: [&str; 3] = ["current", "recent", "all_time"];
    if !bounded_text(&request.criterion, 80)
        || !TIMEFRAMES.contains(&request.timeframe.as_str())
        || request
            .year
            .is_some_and(|year| !(1900..=2100).contains(&year))
        || request
            .artist
            .as_deref()
            .is_some_and(|value| !bounded_text(value, 160))
        || request
            .context
            .as_deref()
            .is_some_and(|value| !bounded_text(value, 160))
        || (request.artist.is_none() && request.context.is_none())
    {
        return Err(MusicDiscoveryError::InvalidRequest);
    }
    Ok(())
}

fn validate_verification_request(
    request: &MusicDiscoveryRequest,
) -> Result<(), MusicDiscoveryError> {
    validate_request(request)?;
    if request
        .title
        .as_deref()
        .is_none_or(|value| !bounded_text(value, MAX_TEXT_CHARACTERS))
        || request
            .artist
            .as_deref()
            .is_none_or(|value| !bounded_text(value, MAX_TEXT_CHARACTERS))
    {
        return Err(MusicDiscoveryError::InvalidRequest);
    }
    Ok(())
}

fn catalog_query(candidate: &Candidate) -> String {
    let combined = format!("{} {}", candidate.title, candidate.artist);
    if combined.chars().count() <= 80 {
        combined
    } else if candidate.title.chars().count() <= 80 {
        candidate.title.clone()
    } else {
        candidate.title.chars().take(80).collect()
    }
}

async fn query_center(
    url: &str,
    candidate: &Candidate,
    principal: &str,
    provider: MusicProvider,
    admin_token: &str,
) -> Result<CenterCatalogResponse, MusicDiscoveryError> {
    let response = http()
        .post(url)
        .bearer_auth(admin_token)
        .json(&serde_json::json!({
            "principal": principal,
            "provider": provider,
            "query": catalog_query(candidate),
        }))
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(
                provider = provider.as_str(),
                timeout = error.is_timeout(),
                "Center's music catalog could not be reached"
            );
            MusicDiscoveryError::Unavailable
        })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let reason: String = response
            .bytes()
            .await
            .ok()
            .and_then(|body| serde_json::from_slice::<CenterRefusal>(&body).ok())
            .map(|refusal| {
                refusal
                    .error
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(160)
                    .collect()
            })
            .unwrap_or_default();
        let error = center_refusal(status);
        tracing::warn!(
            provider = provider.as_str(),
            status,
            reason = %reason,
            outcome = error.label(),
            "Center's music catalog refused the lookup"
        );
        return Err(error);
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json") {
        return Err(MusicDiscoveryError::Unavailable);
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| MusicDiscoveryError::Unavailable)?;
    if bytes.len() > MAX_CENTER_RESPONSE_BYTES {
        return Err(MusicDiscoveryError::Unavailable);
    }
    serde_json::from_slice(&bytes).map_err(|_| MusicDiscoveryError::Unavailable)
}

/// Center's own words for a refused catalog lookup. Logged, never spoken.
#[derive(Deserialize)]
struct CenterRefusal {
    #[serde(default)]
    error: String,
}

/// What a refused Center catalog lookup means for the wearer. Center answers
/// 401 when the provider account is missing or its sign-in lapsed ("Connect
/// YouTube Music in Center.", "Reconnect TIDAL in Center.", "Pair Spotify
/// with your Pin in Center."), 409 when the Pin is not paired ("Connect an Ai
/// Pin to Cosmos first.") or the provider cannot play on it, and 412 when
/// Spotify is turned off on the Pin. Anything else is an outage.
fn center_refusal(status: u16) -> MusicDiscoveryError {
    match status {
        401 => MusicDiscoveryError::ProviderNotLinked,
        409 => MusicDiscoveryError::ProviderNotReady,
        412 => MusicDiscoveryError::ProviderDisabled,
        _ => MusicDiscoveryError::Unavailable,
    }
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalized_title(value: &str) -> String {
    let value = normalized(value);
    [" feat ", " featuring "]
        .into_iter()
        .find_map(|marker| {
            value
                .split_once(marker)
                .map(|(title, _)| title.trim().to_owned())
        })
        .unwrap_or(value)
}

fn artist_credit_parts(value: &str) -> Vec<String> {
    let separators = [
        " feat. ",
        " feat ",
        " featuring ",
        " ft. ",
        " ft ",
        " with ",
        " and ",
        " & ",
        " x ",
    ];
    let mut remaining = value;
    let mut parts = Vec::new();
    loop {
        let lowered = remaining.to_ascii_lowercase();
        let split = separators
            .into_iter()
            .filter_map(|separator| {
                lowered
                    .find(separator)
                    .map(|index| (index, separator.len()))
            })
            .min_by_key(|(index, _)| *index);
        let Some((index, separator_len)) = split else {
            let part = normalized(remaining);
            if !part.is_empty() {
                parts.push(part);
            }
            return parts;
        };
        let part = normalized(&remaining[..index]);
        if !part.is_empty() {
            parts.push(part);
        }
        remaining = &remaining[index + separator_len..];
    }
}

fn contains_normalized_phrase(text: &str, phrase: &str) -> bool {
    format!(" {text} ").contains(&format!(" {phrase} "))
}

fn grounded_provider_artist(
    expected: &str,
    provider_title: &str,
    provider_artists: &[String],
) -> Option<String> {
    let expected_normalized = normalized(expected);
    if let Some(artist) = provider_artists
        .iter()
        .find(|artist| normalized(artist) == expected_normalized)
    {
        return Some(artist.clone());
    }
    let credits = artist_credit_parts(expected);
    if credits.len() < 2
        || provider_artists
            .first()
            .is_none_or(|artist| normalized(artist) != credits[0])
    {
        return None;
    }
    let title = normalized(provider_title);
    let artists = provider_artists
        .iter()
        .map(|artist| normalized(artist))
        .collect::<Vec<_>>();
    credits[1..]
        .iter()
        .all(|credit| {
            artists.iter().any(|artist| artist == credit)
                || contains_normalized_phrase(&title, credit)
        })
        .then(|| provider_artists[0].clone())
}

fn grounded_candidate(
    candidate: &Candidate,
    response: CenterCatalogResponse,
    discovery_provenance: &str,
) -> Result<GroundedMusicTrack, MusicDiscoveryError> {
    // Apple Music has no playback runtime on the Pin (see `catalog_provider`).
    if response.provider == MusicProvider::AppleMusic || response.ranking_provenance != "not_ranked"
    {
        return Err(MusicDiscoveryError::ProviderNoMatch);
    }
    let expected_title = normalized_title(&candidate.title);
    let track = response.items.into_iter().find_map(|track| {
        if normalized_title(&track.title) != expected_title {
            return None;
        }
        let artist = grounded_provider_artist(&candidate.artist, &track.title, &track.artists)?;
        Some((track, artist))
    });
    let Some((track, artist)) = track else {
        return Err(MusicDiscoveryError::ProviderNoMatch);
    };
    if !bounded_text(&track.title, MAX_TEXT_CHARACTERS) {
        return Err(MusicDiscoveryError::ProviderNoMatch);
    }
    Ok(GroundedMusicTrack {
        title: track.title,
        artist,
        provider: response.provider,
        ranking_provenance: response.ranking_provenance,
        discovery_provenance: discovery_provenance.to_owned(),
    })
}

pub fn observation(result: &GroundedMusicTrack) -> String {
    serde_json::json!({
        "status": "grounded",
        "track": {
            "title": result.title,
            "artist": result.artist,
        },
        "provider": result.provider,
        "ranking_provenance": result.ranking_provenance,
        "discovery_provenance": result.discovery_provenance,
    })
    .to_string()
}

pub fn play_music_arguments(observation: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(observation).ok()?;
    if value.get("status")?.as_str()? != "grounded" {
        return None;
    }
    let track = value.get("track")?;
    let title = track.get("title")?.as_str()?.trim();
    let artist = track.get("artist")?.as_str()?.trim();
    if title.is_empty() || artist.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "Artist": artist, "Track": title }).to_string())
}

/// A failed discovery, in the same machine-readable shape as a grounded one:
/// the metric label as `status` and the sentence the wearer hears as
/// `message`. The production evaluation reads `status` to tell an owner
/// action (link or turn on a provider, pair the Pin) from a regression.
pub fn failure_observation(error: MusicDiscoveryError) -> String {
    serde_json::json!({
        "status": error.label(),
        "message": error.observation(),
    })
    .to_string()
}

/// The failure a `music_discover` observation reports, or `None` for a
/// grounded result or text this module did not write.
pub fn failure(observation: &str) -> Option<MusicDiscoveryError> {
    let value: serde_json::Value = serde_json::from_str(observation).ok()?;
    let status = value.get("status")?.as_str()?;
    MusicDiscoveryError::ALL
        .into_iter()
        .find(|error| error.label() == status)
}

/// The sentence for a failed discovery. It is always this module's own
/// constant, never text carried in the observation.
pub fn spoken_failure(observation: &str) -> Option<&'static str> {
    failure(observation).map(MusicDiscoveryError::observation)
}
