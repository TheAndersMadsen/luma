//! Request-scoped read-tool broker for the bounded agentic loop.
//!
//! The chat-turn loop owns loop control; this module supplies the
//! already-audited, read-only Penumbra providers. Native actions are never
//! executed here; they are returned to the stock Synapse dispatcher by
//! `UnderstandHandler`.

use std::time::Duration;

use serde_json::{json, Value};

use super::super::capabilities::food::{FoodRuntimeGate, FoodRuntimePermit};
use crate::config::LlmProvider;
use crate::db::Database;
use crate::external::brave_search::BraveSearchError;
use crate::external::google_maps::{GoogleMapsClient, RoutesTravelMode};
use crate::external::open_food_facts::{FoodNutrientKind, OpenFoodFactsClient};
use crate::external::osm::{OsmClient, OsmError, OsmOptions, PlaceSearchResult};
use crate::external::weather::WeatherClient;
use crate::external::web_search::WebSearch;
use crate::external::wikipedia::WikipediaClient;
use crate::llm::memory::{MemoryKind, MemoryService};
use crate::nearby::NearbyClient;
use crate::spotify::{SpotifyError, SpotifyQueryRequest, SpotifyService};
use crate::synapse::authority::runtime::{
    AgenticToolError, AgenticToolExecutor, AgenticToolOutput, AgenticToolRequest,
    AgenticWriteRequest, DeviceLockState,
};
use crate::synapse::catalog::{
    MusicCatalogKind, ReadToolInvocation, RouteMode, WriteToolInvocation,
};
use crate::tier_a::native_actions;

// GPT-5.6 continuation steps receive the accumulated trusted tool transcript
// and can take as long as the first planning step. A shorter continuation
// deadline made valid multi-tool runs fail after their first successful read.
// These are per-call circuit breakers, not a prescribed number of loop steps.
//
// The first retained-session request can consume every bounded bridge phase:
// device-to-host identity proof, Codex thread initialization, the interactive
// turn, and an interrupt acknowledgement when that turn reaches its deadline.
// Keep that composition explicit so changing one nested deadline cannot
// silently invert the outer device deadline again. Five additional seconds
// are reserved for TLS/HTTP transit and scheduling on the phone and host.
const MODEL_FIRST_TURN_BRIDGE_BOUND: Duration = crate::llm::CODEX_BRIDGE_IDENTITY_TIMEOUT
    .saturating_add(crate::llm::CODEX_THREAD_START_TIMEOUT)
    .saturating_add(crate::llm::CODEX_INTERACTIVE_CHAT_TIMEOUT)
    .saturating_add(crate::llm::CODEX_INTERRUPT_CLEANUP_TIMEOUT);
const MODEL_STEP_TRANSPORT_MARGIN: Duration = Duration::from_secs(5);
const MODEL_STEP_TIMEOUT: Duration =
    MODEL_FIRST_TURN_BRIDGE_BOUND.saturating_add(MODEL_STEP_TRANSPORT_MARGIN);
// Direct HTTP providers (DashScope/qwen, OpenAI, Gemini, Anthropic) return a
// step in seconds. Two attempts at this bound stay well inside the 75s runtime
// breaker and the stock request budget, so a hung provider still leaves room for
// a graceful terminal instead of a timeout apology.
const HTTP_PROVIDER_MODEL_STEP_TIMEOUT: Duration = Duration::from_secs(20);
const MUSIC_PROVIDER_TIMEOUT: Duration = Duration::from_secs(6);
const CURRENT_MUSIC_TTL: Duration = Duration::from_secs(60);
const MAX_TOOL_ITEMS: usize = 20;
const MAX_TOOL_TEXT_CHARS: usize = 1_024;
/// Importance stamped on a fact the user explicitly asked to remember. A
/// deliberate save outranks a passively inferred note; the score orders recall,
/// so an explicit request sits above the neutral midpoint without pinning the
/// top (reserved for the user marking something critical).
const DEFAULT_REMEMBERED_IMPORTANCE: f32 = 0.6;
const MAX_TOOL_LOCATION_BYTES: usize = 512;
// Bounds the knowledge extract handed to the model, and therefore what it can
// narrate for a "look up X" / "who is X" turn.
//
// History (do not lose this): the bound was introduced at 1024 because the
// then-current structural-grounding check (`safe_result_text` /
// `canonical_spoken_answer`) accepted at most 1024 bytes. A longer extract was
// never citable, so every knowledge answer failed grounding — observed
// on-device as roughly half of knowledge turns failing, selected by topic
// length. That grounding runtime was removed together with the legacy engine in
// the chat-turn redesign, so the citability constraint no longer exists and those
// two functions are gone.
//
// The value is retained on its own merits, not that removed constraint: a
// spoken answer should be concise, and the extract re-enters the model
// transcript (itself bounded by `MAX_TOOL_STEP_RESULT_BYTES`). Raising it
// trades spoken brevity and prompt budget for depth, so change it only on
// on-device evidence — not merely because the old grounding limit is gone.
const MAX_KNOWLEDGE_EXTRACT_BYTES: usize = 1_024;

// Web-search field bounds. A knowledge lookup spends the tool-result budget on
// ONE extract; a web search returns up to three results, so copying the 1 KiB
// extract bound would let a single observation reach ~12 KiB against the 4 KiB
// `MAX_TOOL_STEP_RESULT_BYTES`. `bounded_json` would then truncate it to a
// prefix that is, by its own comment, always invalid JSON. These are sized so
// three maximal results plus their JSON scaffolding stay inside that budget,
// and they are byte-counted because the budget is bytes.
const MAX_WEB_SNIPPET_BYTES: usize = 320;
const MAX_WEB_TITLE_BYTES: usize = 120;
const MAX_WEB_URL_BYTES: usize = 200;
const MAX_WEB_AGE_BYTES: usize = 32;

/// Per-attempt provider bound for one agentic model step.
///
/// The Codex path genuinely needs the multi-phase bridge bound (identity +
/// thread setup + interactive chat + cleanup). A direct HTTP provider
/// (openai-compatible/DashScope, OpenAI, Gemini, Anthropic) answers a single
/// step in seconds, so applying the Codex bound there lets ONE hung request
/// consume the entire stock request budget: two attempts at 50s exceed both the
/// 75s runtime breaker and the stock deadline, and the turn surfaces as "took
/// too long to respond" instead of an answer or a graceful decline. Bounding
/// those providers tightly makes a hang fail fast enough to leave budget for the
/// retry and a terminal operation.
pub(crate) fn model_step_timeout(provider: LlmProvider) -> Duration {
    match provider {
        LlmProvider::Codex => MODEL_STEP_TIMEOUT,
        _ => HTTP_PROVIDER_MODEL_STEP_TIMEOUT,
    }
}

#[derive(Clone)]
pub(in crate::services::aibus) struct AgenticExternalClients {
    pub(in crate::services::aibus) google_maps: GoogleMapsClient,
    pub(in crate::services::aibus) open_food_facts: OpenFoodFactsClient,
    pub(in crate::services::aibus) spotify: Option<SpotifyService>,
    pub(in crate::services::aibus) web_search: WebSearch,
}

impl AgenticExternalClients {
    pub(in crate::services::aibus) fn new(
        google_maps: GoogleMapsClient,
        open_food_facts: OpenFoodFactsClient,
        spotify: Option<SpotifyService>,
        web_search: WebSearch,
    ) -> Self {
        Self {
            google_maps,
            open_food_facts,
            spotify,
            web_search,
        }
    }
}

pub(in crate::services::aibus) struct AgenticReadToolBroker {
    utterance: String,
    context_texts: Vec<String>,
    location: Option<(f64, f64)>,
    device_lock_state: DeviceLockState,
    weather: WeatherClient,
    wikipedia: WikipediaClient,
    web_search: WebSearch,
    osm: OsmClient,
    nearby: NearbyClient,
    google_maps: GoogleMapsClient,
    open_food_facts: OpenFoodFactsClient,
    spotify: Option<SpotifyService>,
    food_runtime: Option<(FoodRuntimeGate, FoodRuntimePermit)>,
    db: Database,
    memory: Option<MemoryService>,
}

impl AgenticReadToolBroker {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::services::aibus) fn new(
        utterance: impl Into<String>,
        location: Option<(f64, f64)>,
        device_lock_state: DeviceLockState,
        weather: WeatherClient,
        http_client: reqwest::Client,
        osm_options: OsmOptions,
        nearby: NearbyClient,
        external: AgenticExternalClients,
        food_runtime: Option<(FoodRuntimeGate, FoodRuntimePermit)>,
        db: Database,
        memory: Option<MemoryService>,
    ) -> Self {
        Self {
            utterance: utterance.into(),
            context_texts: Vec::new(),
            location,
            device_lock_state,
            weather,
            wikipedia: WikipediaClient::new(http_client.clone()),
            osm: OsmClient::new(http_client, osm_options),
            nearby,
            web_search: external.web_search,
            google_maps: external.google_maps,
            open_food_facts: external.open_food_facts,
            spotify: external.spotify,
            food_runtime,
            db,
            memory,
        }
    }

    /// Accept bounded recent-conversation texts as additional grounding for
    /// read-only tool queries. Follow-up turns legitimately query entities
    /// resolved from context ("when did he die" -> the discussed person), so
    /// exact-span grounding must include the accepted context window. This is
    /// read-tool grounding only; it never adds mutation authority.
    pub(in crate::services::aibus) fn with_context_texts(
        mut self,
        context_texts: Vec<String>,
    ) -> Self {
        self.context_texts = context_texts;
        self
    }

    fn current_coordinates(&self) -> Result<(f64, f64), AgenticToolError> {
        self.location
            .filter(|(latitude, longitude)| valid_coordinates(*latitude, *longitude))
            .ok_or_else(|| AgenticToolError::new("current location is unavailable"))
    }

    fn require_current_coordinates(
        &self,
        latitude: f64,
        longitude: f64,
    ) -> Result<(), AgenticToolError> {
        let (current_latitude, current_longitude) = self.current_coordinates()?;
        if coordinates_match(latitude, current_latitude)
            && coordinates_match(longitude, current_longitude)
        {
            Ok(())
        } else {
            Err(AgenticToolError::new(
                "coordinates do not match the authenticated current location",
            ))
        }
    }

    fn require_user_span(&self, value: &str) -> Result<(), AgenticToolError> {
        if normalized_contains(&self.utterance, value)
            || self
                .context_texts
                .iter()
                .any(|context| normalized_contains(context, value))
        {
            Ok(())
        } else {
            Err(AgenticToolError::new(
                "this query text is not grounded in the user's request or the recent \
                 conversation; retry quoting the exact words the user or assistant used",
            ))
        }
    }

    /// Grounding for an open-web query, which cannot use [`Self::require_user_span`].
    ///
    /// That gate demands one contiguous word-bounded span, which is right for
    /// naming an entity to look up but wrong for a search: a usable query drops
    /// filler ("what's the latest news in Denmark" -> "latest Denmark news")
    /// and reorders terms, and every such query is refused before the provider
    /// is contacted. The model is then told to "try a narrower or different
    /// query", which is refused again.
    ///
    /// The invariant that actually matters is unchanged: no token may originate
    /// from provider text. Requiring every query token to appear in the
    /// utterance or in `context_texts` — order-free, subset allowed, superset
    /// forbidden — preserves it exactly, because `context_texts` holds only
    /// merged prior conversation turns and is fixed when the broker is built,
    /// so this run's own tool output can never reach it. The model still cannot
    /// introduce an entity the user never said.
    /// Grounded form of `value`: ungrounded tokens are DROPPED, not refused.
    ///
    /// Refusing taught the model nothing. The description already says not to
    /// add terms, and `.124` showed rewriting descriptions does not change the
    /// behaviour; measured on device, "who won the Tour de France this year"
    /// still produced a query with an added term and was refused outright, so
    /// the user got no answer.
    ///
    /// Filtering enforces the SAME invariant more strictly than refusing did:
    /// the provider receives only words the user actually said, and now that is
    /// structural rather than advisory. If nothing grounded survives, the call
    /// is still refused — an empty search is not an answer.
    fn grounded_query_tokens(&self, value: &str) -> Result<String, AgenticToolError> {
        let query = normalize_text(value);
        let grounded = |token: &str| {
            normalized_contains(&self.utterance, token)
                || self
                    .context_texts
                    .iter()
                    .any(|context| normalized_contains(context, token))
        };
        let kept: Vec<&str> = query
            .split_whitespace()
            .filter(|token| QUERY_STOPWORDS.contains(token) || grounded(token))
            .collect();
        let significant = kept.iter().any(|token| !QUERY_STOPWORDS.contains(token));
        if !significant {
            return Err(AgenticToolError::new(
                "this query has no searchable words from the user's request; retry using \
                 the words the user actually said",
            ));
        }
        Ok(kept.join(" "))
    }

    fn require_grounded_query_tokens(&self, value: &str) -> Result<(), AgenticToolError> {
        let query = normalize_text(value);
        let significant: Vec<&str> = query
            .split_whitespace()
            .filter(|token| !QUERY_STOPWORDS.contains(token))
            .collect();
        if significant.is_empty() {
            return Err(AgenticToolError::new(
                "this query has no searchable words from the user's request; retry using \
                 the words the user actually said",
            ));
        }

        let grounded = |token: &str| {
            normalized_contains(&self.utterance, token)
                || self
                    .context_texts
                    .iter()
                    .any(|context| normalized_contains(context, token))
        };
        if significant.iter().all(|token| grounded(token)) {
            Ok(())
        } else {
            Err(AgenticToolError::new(
                "this query text is not grounded in the user's request or the recent \
                 conversation; retry using only words the user or assistant already used",
            ))
        }
    }
}

/// Words allowed in a search query without appearing in the user's own words.
/// Deliberately tiny and closed: these contain no entity, so admitting them lets
/// the model phrase a query naturally without widening what it can search for.
const QUERY_STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from", "how",
    "in", "is", "it", "of", "on", "or", "s", "that", "the", "their", "there", "this", "to", "was",
    "were", "what", "when", "where", "which", "who", "why", "with",
];

// ─── Tool execution ─────────────────────────────────────────────────

#[tonic::async_trait]
impl AgenticToolExecutor for AgenticReadToolBroker {
    fn web_search_available(&self) -> bool {
        self.web_search.is_configured()
    }

    async fn execute(
        &self,
        request: AgenticToolRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        // This is deliberately the first branch in the broker. Locked or
        // unknown state must fail before cached coordinates are returned,
        // before GetCurrentLocation is staged, and before any provider is
        // contacted. The generic runtime applies the same authorization check;
        // this defense also covers resumed or independently invoked brokers.
        if request.invocation.requires_confirmed_unlock()
            && self.device_lock_state != DeviceLockState::Unlocked
        {
            if matches!(
                request.invocation,
                ReadToolInvocation::CurrentMusic(_)
                    | ReadToolInvocation::MemorySearch(_)
                    | ReadToolInvocation::FoodLookup(_)
            ) {
                return Ok(AgenticToolOutput::Result(unavailable(
                    request.invocation.name(),
                    "requires_unlocked_device",
                )));
            }
            return Err(AgenticToolError::new(
                "location tools require a confirmed unlocked device",
            ));
        }
        let result = match request.invocation {
            ReadToolInvocation::KnowledgeLookup(arguments) => {
                // Token gate, not the contiguous-span gate. "How tall is the
                // Eiffel Tower" makes the model query "Eiffel Tower height",
                // which is not a span of the request, so the span gate refused
                // it, the model retried with a literal span, and the provider
                // returned not_found. Measured on device as two wasted steps
                // and no answer — the user experiences "it didn't know".
                //
                // This is the same correction already applied to web_search
                // (.115), nearby_search (.119) and the music path (.129-.135):
                // an encyclopedia query legitimately drops filler and reorders
                // terms. The invariant is unchanged — every token must still
                // originate in the user's request or the recent conversation,
                // so nothing the user never said reaches the provider.
                self.require_grounded_query_tokens(&arguments.query)?;
                let mut lookup = self.wikipedia.lookup(&arguments.query).await;
                if lookup.as_ref().is_err_and(|error| error.is_transient()) {
                    lookup = self.wikipedia.lookup(&arguments.query).await;
                }
                match lookup {
                    Ok(reference) => json!({
                        "status": "ok",
                        "query": arguments.query,
                        "title": bounded_text(&reference.title),
                        "extract": bounded_knowledge_extract(&reference.extract),
                        "source_url": bounded_text(&reference.source_url)
                    }),
                    Err(error) => unavailable("knowledge_lookup", error.kind()),
                }
            }
            ReadToolInvocation::WebSearch(arguments) => {
                let grounded_query = self.grounded_query_tokens(&arguments.query)?;
                // No retry here any more: `WebSearch` already hedges across
                // providers and fails over between them, so an error out of it
                // means every configured provider failed. Repeating the whole
                // cascade would spend a second of the wearer's turn to be told
                // the same thing twice.
                let search = self.web_search.search(&grounded_query).await;
                match search {
                    Ok(found) => json!({
                        "status": "ok",
                        "query": arguments.query,
                        "results": found
                            .results
                            .iter()
                            .map(|result| json!({
                                "title": bounded_web_title(&result.title),
                                // Three results share one tool-result budget,
                                // so these are a third of what a single
                                // knowledge extract may use. Byte-counted,
                                // because the budget downstream is bytes and a
                                // char-counted bound lets one non-ASCII field
                                // spend it alone.
                                "snippet": bounded_web_snippet(&result.description),
                                "source_url": bounded_web_url(&result.source_url),
                                "age": result.age.as_deref().map(bounded_web_age)
                            }))
                            .collect::<Vec<_>>()
                    }),
                    // An empty result set is a truthful EMPTY answer, not an
                    // outage. Reporting it as unavailable makes the system
                    // prompt tell the model to answer from its own knowledge
                    // and not mention the failure — fabrication, on exactly the
                    // current-events questions this tool exists to ground.
                    Err(BraveSearchError::NotFound) => empty_result("web_search"),
                    Err(error) => unavailable("web_search", error.kind()),
                }
            }
            ReadToolInvocation::PlaceSearch(arguments) => {
                match resolve_selected_place(
                    &self.osm,
                    &arguments.query,
                    arguments.context.as_deref(),
                )
                .await
                {
                    Ok(Some(place)) => {
                        let label = place_weather_label(
                            place.name.as_deref(),
                            place.municipality.as_deref(),
                            place.country.as_deref(),
                            &place.display_name,
                        );
                        json!({
                            "status": "ok",
                            "query": arguments.query,
                            "context": arguments.context,
                            "place": {
                                "name": place.name.as_deref().map(bounded_text),
                                "label": label,
                                "display_name": bounded_text(&place.display_name),
                                "municipality": place.municipality.as_deref().map(bounded_text),
                                "country": place.country.as_deref().map(bounded_text),
                                "latitude": place.latitude,
                                "longitude": place.longitude
                            }
                        })
                    }
                    Ok(None) => unavailable("place_search", "ambiguous_result"),
                    Err(error) => unavailable("place_search", error.kind()),
                }
            }
            ReadToolInvocation::WeatherAtPlace(arguments) => {
                if !valid_coordinates(arguments.latitude, arguments.longitude) {
                    return Err(AgenticToolError::new("weather coordinates are invalid"));
                }
                match self
                    .weather
                    .current(arguments.latitude, arguments.longitude)
                    .await
                {
                    Ok(weather) => json!({
                        "status": "ok",
                        // Same temporal scope marker as current_weather: the
                        // provider has no forecast, so a future-time question
                        // must be declined rather than answered from these.
                        "valid_for": "present conditions only; no forecast available",
                        "location": arguments.location,
                        "latitude": arguments.latitude,
                        "longitude": arguments.longitude,
                        "summary": bounded_text(&weather.summary),
                        "temperature_celsius": weather.temperature_celsius,
                        "temperature_fahrenheit": weather.temperature_fahrenheit,
                        "uv_index": weather.uv_index,
                        "has_precipitation": weather.has_precipitation,
                        "precipitation_type": weather.precipitation_type.as_deref().map(bounded_text)
                    }),
                    Err(error) => unavailable("weather_at_place", error.kind()),
                }
            }
            ReadToolInvocation::CurrentLocation(_) => {
                if let Some((latitude, longitude)) = self.location {
                    json!({
                        "status": "ok",
                        "label": "current location",
                        "latitude": latitude,
                        "longitude": longitude,
                        "source": "authenticated_device_observation"
                    })
                } else {
                    return Ok(AgenticToolOutput::ExternalDevicePreflight {
                        action: native_actions::GET_CURRENT_LOCATION.to_string(),
                        arguments: json!({}),
                    });
                }
            }
            ReadToolInvocation::CurrentWeather(arguments) => {
                if let Some(location) = arguments.location.as_deref() {
                    if !is_current_location_label(location) {
                        return Err(AgenticToolError::new(
                            "weather location is not grounded as the current location",
                        ));
                    }
                }
                let (latitude, longitude) = self.current_coordinates()?;
                match self.weather.current(latitude, longitude).await {
                    Ok(weather) => json!({
                        "status": "ok",
                        // Explicit temporal scope. The provider returns PRESENT
                        // conditions only; without saying so the model answered
                        // "tomorrow"/"this weekend" from these numbers and stated a
                        // forecast it never had.
                        "valid_for": "present conditions only; no forecast available",
                        "location": "current location",
                        "latitude": latitude,
                        "longitude": longitude,
                        "summary": bounded_text(&weather.summary),
                        "temperature_celsius": weather.temperature_celsius,
                        "temperature_fahrenheit": weather.temperature_fahrenheit,
                        "uv_index": weather.uv_index,
                        "has_precipitation": weather.has_precipitation,
                        "precipitation_type": weather.precipitation_type.as_deref().map(bounded_text)
                    }),
                    Err(error) => unavailable("weather", error.kind()),
                }
            }
            ReadToolInvocation::ReverseGeocode(arguments) => {
                self.require_current_coordinates(arguments.latitude, arguments.longitude)?;
                match self
                    .osm
                    .reverse_geocode(arguments.latitude, arguments.longitude)
                    .await
                {
                    Ok(location) => json!({"status": "ok", "location": location}),
                    Err(error) => unavailable("reverse_geocode", error.kind()),
                }
            }
            ReadToolInvocation::NearbySearch(arguments) => {
                // An omitted query is grounded by construction: there is no
                // model-supplied text to attribute. Demanding a span for a
                // category the user never said made "what's nearby"
                // unsatisfiable — observed on device failing twice before the
                // model guessed a word that happened to appear.
                if !arguments.query.trim().is_empty() {
                    self.require_user_span(&arguments.query)?;
                }
                // Coordinates come from the device's authenticated current
                // location. If the caller supplied them, verify they match;
                // otherwise substitute the current fix directly.
                let (latitude, longitude) = match (arguments.latitude, arguments.longitude) {
                    (Some(latitude), Some(longitude)) => {
                        self.require_current_coordinates(latitude, longitude)?;
                        (latitude, longitude)
                    }
                    _ => self.current_coordinates()?,
                };
                let radius = f64::from(arguments.radius_m.unwrap_or(1_000));
                match self
                    .nearby
                    .search(latitude, longitude, radius, &arguments.query)
                    .await
                {
                    Ok(places) => {
                        let places = places
                            .into_iter()
                            .take(MAX_TOOL_ITEMS)
                            .map(|place| {
                                json!({
                                    "name": bounded_text(&place.name),
                                    "address": bounded_text(&place.formatted_address),
                                    "types": place.place_types.into_iter().take(8).map(|value| bounded_text(&value)).collect::<Vec<_>>(),
                                    "phone": nonempty_bounded(&place.phone_number),
                                    "description": nonempty_bounded(&place.place_description),
                                    "website": nonempty_bounded(&place.website_url),
                                    "rating": place.rating,
                                    "open_now": place.open_now,
                                    "latitude": place.location.as_ref().map(|location| location.latitude),
                                    "longitude": place.location.as_ref().map(|location| location.longitude)
                                })
                            })
                            .collect::<Vec<_>>();
                        json!({"status": "ok", "query": arguments.query, "places": places})
                    }
                    Err(error) => unavailable("nearby_search", error.kind()),
                }
            }
            ReadToolInvocation::MusicArtistTopTracks(arguments) => {
                let Some(spotify) = self.spotify.as_ref() else {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "music_artist_top_tracks",
                        "not_configured",
                    )));
                };
                let limit = usize::from(arguments.limit.unwrap_or(10)).min(MAX_TOOL_ITEMS);
                match tokio::time::timeout(
                    MUSIC_PROVIDER_TIMEOUT,
                    spotify.query(SpotifyQueryRequest {
                        kind: "artist".to_string(),
                        primary: Some(arguments.artist.clone()),
                        secondary: None,
                        ids: Vec::new(),
                        limit,
                    }),
                )
                .await
                {
                    // `ranking` is the ONLY provenance this payload carries.
                    // Rank-one selection is deterministic in Rust, not a model
                    // decision, so `popularity` and other per-track metadata
                    // stay out of a JSON that is resent on every music turn.
                    // Preferring the true popularity maximum over rank one is
                    // the deliberate follow-up, gated on measuring how often
                    // `search_relevance_fallback` actually fires.
                    Ok(Ok(response)) => json!({
                        "status": "ok",
                        "artist": arguments.artist,
                        "ranking": response.ranking_provenance.as_str(),
                        "tracks": response.items.into_iter().take(limit).enumerate().map(|(index, track)| json!({
                            "rank": index + 1,
                            "title": bounded_text(&track.title),
                            "artists": track.artists.into_iter().take(8).map(|value| bounded_text(&value)).collect::<Vec<_>>(),
                            "album": bounded_text(&track.album),
                            "duration_ms": track.duration_ms
                        })).collect::<Vec<_>>()
                    }),
                    Ok(Err(error)) => {
                        unavailable("music_artist_top_tracks", spotify_error_kind(&error))
                    }
                    Err(_) => unavailable("music_artist_top_tracks", "timeout"),
                }
            }
            ReadToolInvocation::MusicCatalogSearch(arguments) => {
                let Some(spotify) = self.spotify.as_ref() else {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "music_catalog_search",
                        "not_configured",
                    )));
                };
                let kind = match arguments.kind {
                    Some(MusicCatalogKind::Artist) => "artist",
                    Some(MusicCatalogKind::Album) => "album",
                    Some(MusicCatalogKind::Playlist) => "playlist",
                    Some(MusicCatalogKind::Track) | None => "track",
                };
                let limit = usize::from(arguments.limit.unwrap_or(10)).min(MAX_TOOL_ITEMS);
                match tokio::time::timeout(
                    MUSIC_PROVIDER_TIMEOUT,
                    spotify.query(SpotifyQueryRequest {
                        kind: kind.to_string(),
                        primary: Some(arguments.query.clone()),
                        secondary: None,
                        ids: Vec::new(),
                        limit,
                    }),
                )
                .await
                {
                    // Same contract as `music_artist_top_tracks` above: a
                    // `kind: artist` search reaches the same provider branch,
                    // so the same one-string provenance travels with it.
                    Ok(Ok(response)) => json!({
                        "status": "ok",
                        "query": arguments.query,
                        "ranking": response.ranking_provenance.as_str(),
                        "tracks": response.items.into_iter().take(limit).enumerate().map(|(index, track)| json!({
                            "rank": index + 1,
                            "title": bounded_text(&track.title),
                            "artists": track.artists.into_iter().take(8).map(|value| bounded_text(&value)).collect::<Vec<_>>(),
                            "album": bounded_text(&track.album),
                            "duration_ms": track.duration_ms
                        })).collect::<Vec<_>>()
                    }),
                    Ok(Err(error)) => {
                        unavailable("music_catalog_search", spotify_error_kind(&error))
                    }
                    Err(_) => unavailable("music_catalog_search", "timeout"),
                }
            }
            ReadToolInvocation::CurrentMusic(_) => {
                if self.device_lock_state != DeviceLockState::Unlocked {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "current_music",
                        "requires_unlocked_device",
                    )));
                }
                match self
                    .db
                    .recent_music_context(CURRENT_MUSIC_TTL.as_secs())
                    .await
                {
                    Ok(Some(track)) => json!({"status": "ok", "track": track}),
                    Ok(None) => json!({"status": "not_found"}),
                    Err(_) => unavailable("current_music", "local_state_unavailable"),
                }
            }
            ReadToolInvocation::Route(arguments) => {
                if !is_current_location_label(&arguments.origin) {
                    return Err(AgenticToolError::new(
                        "route origin must be the authenticated current location",
                    ));
                }
                let inferred_mode = match requested_route_mode(&self.utterance) {
                    Ok(mode) => mode,
                    Err(()) => {
                        return Ok(AgenticToolOutput::Result(unavailable(
                            "route",
                            "ambiguous_travel_mode",
                        )))
                    }
                };
                let requested_mode = arguments.mode.or(inferred_mode);
                if matches!(requested_mode, Some(RouteMode::Transit)) {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "route",
                        "transit_not_supported",
                    )));
                }
                let configured_mode = self.google_maps.routes_travel_mode();
                if requested_mode.is_some_and(|requested| {
                    !route_mode_matches_configuration(requested, configured_mode)
                }) {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "route",
                        "requested_mode_not_configured",
                    )));
                }
                let (latitude, longitude) = self.current_coordinates()?;
                match self
                    .google_maps
                    .compute_route(latitude, longitude, &arguments.destination)
                    .await
                {
                    Ok(route) => json!({
                        "status": "ok",
                        "origin": "current location",
                        "destination": arguments.destination,
                        "mode": configured_route_mode_name(configured_mode),
                        "summary": bounded_text(&route.summary),
                        "distance": route.total_distance.as_ref().map(|distance| json!({"text": bounded_text(&distance.text), "meters": distance.value})),
                        "duration": route.total_duration.as_ref().map(|duration| json!({"text": bounded_text(&duration.text), "seconds": duration.value})),
                        "steps": route.steps.into_iter().take(MAX_TOOL_ITEMS).map(|step| json!({
                            "instruction": bounded_text(&step.instruction),
                            "distance": step.distance.as_ref().map(|distance| bounded_text(&distance.text)),
                            "duration": step.duration.as_ref().map(|duration| bounded_text(&duration.text))
                        })).collect::<Vec<_>>()
                    }),
                    Err(error) => unavailable("route", error.kind()),
                }
            }
            ReadToolInvocation::FoodLookup(arguments) => {
                if self.device_lock_state != DeviceLockState::Unlocked {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "food_lookup",
                        "requires_unlocked_device",
                    )));
                }
                let Some((gate, permit)) = self.food_runtime.as_ref() else {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "food_lookup",
                        "device_gate_unavailable",
                    )));
                };
                self.require_user_span(&arguments.query)?;
                match gate
                    .run_while_enabled(*permit, self.open_food_facts.lookup(&arguments.query))
                    .await
                {
                    Some(Ok(products)) => json!({
                        "status": "ok",
                        "attribution": crate::external::open_food_facts::OPEN_FOOD_FACTS_ATTRIBUTION,
                        "products": products.into_iter().take(5).map(|product| json!({
                            "name": bounded_text(&product.item_name),
                            "brand": bounded_text(&product.brand),
                            "serving_size": bounded_text(&product.typical_serving_size),
                            "nutrients": product.nutrients.into_iter().take(MAX_TOOL_ITEMS).map(|nutrient| json!({
                                "kind": food_nutrient_name(nutrient.kind),
                                "value": nutrient.value
                            })).collect::<Vec<_>>()
                        })).collect::<Vec<_>>()
                    }),
                    Some(Err(error)) => unavailable("food_lookup", error.kind()),
                    None => unavailable("food_lookup", "device_gate_unavailable"),
                }
            }
            ReadToolInvocation::MemorySearch(arguments) => {
                if self.device_lock_state != DeviceLockState::Unlocked {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "memory_search",
                        "requires_unlocked_device",
                    )));
                }
                self.require_user_span(&arguments.query)?;
                let Some(memory) = self.memory.as_ref() else {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "memory_search",
                        "not_configured",
                    )));
                };
                match memory
                    .search(
                        arguments.query.clone(),
                        usize::from(arguments.limit.unwrap_or(5)).min(MAX_TOOL_ITEMS),
                    )
                    .await
                {
                    Ok(results) => json!({"status": "ok", "results": results}),
                    Err(_) => unavailable("memory_search", "local_state_unavailable"),
                }
            }
        };
        Ok(AgenticToolOutput::Result(result))
    }

    async fn execute_write(
        &self,
        request: AgenticWriteRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        // Same first-branch defense as `execute`: a write must never reach the
        // store on a locked or unknown-state device. The dispatcher gates this
        // too; this also covers resumed or independently invoked brokers.
        if request.invocation.requires_confirmed_unlock()
            && self.device_lock_state != DeviceLockState::Unlocked
        {
            return Ok(AgenticToolOutput::Result(unavailable(
                request.invocation.name(),
                "requires_unlocked_device",
            )));
        }
        let result = match request.invocation {
            WriteToolInvocation::RememberFact(arguments) => {
                // Anti-invention gate: every significant token of the remembered
                // text must be something the user actually said this turn (or in
                // accepted context). This is the exact grounding the read tools
                // use, applied to a write so the model cannot persist a "fact"
                // the user never stated. An ungrounded write is refused, not
                // silently stored.
                self.require_grounded_query_tokens(&arguments.content)?;
                let Some(memory) = self.memory.as_ref() else {
                    return Ok(AgenticToolOutput::Result(unavailable(
                        "remember_fact",
                        "not_configured",
                    )));
                };
                let kind = arguments
                    .kind
                    .as_deref()
                    .map(MemoryKind::from)
                    .unwrap_or_default();
                match memory
                    .remember(
                        arguments.content.clone(),
                        kind,
                        DEFAULT_REMEMBERED_IMPORTANCE,
                    )
                    .await
                {
                    Ok(record) => json!({
                        "status": "ok",
                        "tool": "remember_fact",
                        "remembered": bounded_text(&record.text),
                        "kind": record.kind,
                    }),
                    Err(_) => unavailable("remember_fact", "local_state_unavailable"),
                }
            }
        };
        Ok(AgenticToolOutput::Result(result))
    }
}

// ─── Result shaping and place helpers ───────────────────────────────

fn unavailable(tool: &str, reason: &str) -> Value {
    let mut result = json!({"status": "unavailable", "tool": tool, "reason": reason});
    // When an external capability could not be reached, contain the exact spoken
    // sentence the wearer should hear. Without it the model sees only
    // `tool: web_search, reason: provider_unavailable` — internal jargon it turns
    // into a generic "something went wrong", the failure the roadmap recorded
    // (item 0: "a genuinely failed web_search ends in a generic decline rather
    // than saying search was unavailable"). Putting the words in the OBSERVATION,
    // not the prompt, is this codebase's pattern: the guarantee lives in code the
    // model reads, not in phrasing it may or may not obey. Local/device-state
    // failures get no message and are left exactly as before.
    if let Some(message) = unavailable_wearer_message(tool) {
        result["message"] = json!(message);
    }
    result
}

/// The spoken-ready sentence for an external capability that could not be
/// reached, or `None` for tools whose failure the model already handles (local
/// state, device gates). Named per capability so the wearer hears *what* failed —
/// "web search", not the tool identifier.
fn unavailable_wearer_message(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "web_search" => "Web search is unavailable right now.",
        "knowledge_lookup" => "I couldn't reach the encyclopedia just now.",
        "place_search" | "reverse_geocode" => "I couldn't reach the places service just now.",
        "weather_at_place" | "weather" => "I couldn't reach the weather service just now.",
        "nearby_search" => "I couldn't look up nearby places just now.",
        "route" => "I couldn't work out directions just now.",
        _ => return None,
    })
}

/// A tool that ran correctly and found nothing. Distinct from [`unavailable`]:
/// the tool catalog treats `not_found` as a valid empty observation rather
/// than a failure, so the model reports the absence instead of being told to
/// fall back to its own knowledge.
fn empty_result(tool: &str) -> Value {
    json!({"status": "not_found", "tool": tool})
}

/// Byte-bounded prefix of `value`, never splitting a character.
///
/// The single byte-truncation primitive for this module: bounds by UTF-8 byte
/// length, cuts on a codepoint boundary, and appends no ellipsis. The named
/// wrappers below exist so each call site names *which* wire bound applies —
/// do not inline them into a bare `bounded_bytes(value, N)` call.
///
/// Not interchangeable with [`bounded_text`], which counts Unicode scalars.
fn bounded_bytes(value: &str, limit: usize) -> String {
    let mut end = 0;
    for (start, character) in value.char_indices() {
        let next = start + character.len_utf8();
        if next > limit {
            break;
        }
        end = next;
    }
    value[..end].to_string()
}

fn bounded_web_snippet(value: &str) -> String {
    bounded_bytes(value, MAX_WEB_SNIPPET_BYTES)
}

fn bounded_web_title(value: &str) -> String {
    bounded_bytes(value, MAX_WEB_TITLE_BYTES)
}

fn bounded_web_url(value: &str) -> String {
    bounded_bytes(value, MAX_WEB_URL_BYTES)
}

fn bounded_web_age(value: &str) -> String {
    bounded_bytes(value, MAX_WEB_AGE_BYTES)
}

fn spotify_error_kind(error: &SpotifyError) -> &'static str {
    match error {
        SpotifyError::Disabled => "disabled",
        SpotifyError::AcknowledgementRequired => "acknowledgement_required",
        SpotifyError::NotPaired => "not_paired",
        SpotifyError::Pairing => "pairing",
        SpotifyError::AlreadyPaired => "already_paired",
        SpotifyError::InvalidRequest(_) => "invalid_request",
        SpotifyError::RateLimited => "rate_limited",
        SpotifyError::Unavailable => "unavailable",
        SpotifyError::Persistence => "persistence_unavailable",
    }
}

/// Scalar-bounded prefix of `value`. Counts Unicode scalars, not bytes — see
/// [`bounded_bytes`] for the byte-bounded primitive. The two limits are both
/// 1_024 but in different units; they are deliberately separate helpers.
fn bounded_text(value: &str) -> String {
    value.chars().take(MAX_TOOL_TEXT_CHARS).collect()
}

fn bounded_knowledge_extract(value: &str) -> String {
    bounded_bytes(value, MAX_KNOWLEDGE_EXTRACT_BYTES)
}

fn place_weather_label(
    name: Option<&str>,
    municipality: Option<&str>,
    country: Option<&str>,
    display_name: &str,
) -> String {
    let primary = name
        .and_then(nonempty_bounded)
        .or_else(|| municipality.and_then(nonempty_bounded));
    let country = country.and_then(nonempty_bounded);
    match (primary, country) {
        (Some(primary), Some(country)) if !primary.eq_ignore_ascii_case(&country) => {
            bounded_location_text(&format!("{primary}, {country}"))
        }
        (Some(primary), _) => bounded_location_text(&primary),
        (None, Some(country)) => bounded_location_text(&country),
        (None, None) => bounded_location_text(display_name),
    }
}

fn place_provider_query(query: &str, context: Option<&str>) -> Option<String> {
    let query = query.trim();
    let context = context
        .map(str::trim)
        .filter(|context| !context.is_empty() && !context.eq_ignore_ascii_case(query));
    let combined = match context {
        Some(context) => format!("{query}, {context}"),
        None => query.to_string(),
    };
    (!combined.is_empty() && combined.len() <= MAX_TOOL_LOCATION_BYTES).then_some(combined)
}

/// Resolve an exact, provider-grounded place span with at most one fallback.
/// A knowledge title is useful as a disambiguator when it is itself geographic
/// (for example a country name), but a natural lookup can also resolve to a
/// topic title that Nominatim cannot parse. Every contextualized result must
/// retain both sides of that trusted relationship: its exact selected locality
/// and a provider-returned country explicitly present in the trusted title.
/// Otherwise retry only the exact selected place bytes and apply the same proof
/// to that one fallback. This prevents a same-named place in another country
/// from being accepted merely because it was Nominatim's first result.
///
/// A bare (uncontextualized) query must not silently accept the provider's
/// first limit-one result when the same name could refer to a different place
/// in another country. After a name match, issue a bounded counter-country
/// candidate probe: if a same-named place with different coordinates exists
/// in a well-known counter-country, reject the bare result as ambiguous.
async fn resolve_selected_place(
    osm: &OsmClient,
    selected: &str,
    context: Option<&str>,
) -> Result<Option<PlaceSearchResult>, OsmError> {
    let selected = selected.trim();
    let context = context.map(str::trim).filter(|value| !value.is_empty());
    let provider_query = place_provider_query(selected, context)
        .ok_or(OsmError::InvalidRequest("invalid place search query"))?;
    // A trusted context always requires country proof, even when the provider
    // query is identical to the selected place (for example a country name used
    // as both the user span and the knowledge context). Without this guard the
    // equal-context case fell through to the bare name check and accepted any
    // provider result whose name matched, regardless of the returned country.
    let has_context = context.is_some();
    let query_differs = provider_query != selected;
    match osm.search_place(&provider_query).await {
        Ok(place) if has_context && contextual_place_is_supported(selected, context, &place) => {
            return Ok(Some(place));
        }
        Ok(place)
            if !has_context
                && provider_place_matches_selected(
                    selected,
                    place.name.as_deref(),
                    place.municipality.as_deref(),
                ) =>
        {
            // A bare name match is not sufficient on its own: probe for
            // same-name candidates in a counter-country before accepting.
            if bare_place_candidate_is_unique(osm, selected, &place).await? {
                return Ok(Some(place));
            }
            return Ok(None);
        }
        Err(error) if !matches!(error, OsmError::NotFound) => {
            return Err(error);
        }
        _ => {}
    }
    // A fallback only reissues the bare selected text; when the initial
    // contextualized query already matched the selected string there is no
    // second query to attempt, so skip the redundant round-trip.
    if has_context && query_differs {
        match osm.search_place(selected).await {
            Ok(place) if contextual_place_is_supported(selected, context, &place) => {
                return Ok(Some(place));
            }
            Ok(_) => return Ok(None),
            Err(OsmError::NotFound) => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

/// Check whether a bare (uncontextualized) place candidate is unique by
/// probing for same-named places in a counter-country. Returns `true` when
/// no same-named place with different coordinates is found, `false` when
/// the bare name is ambiguous across countries.
async fn bare_place_candidate_is_unique(
    osm: &OsmClient,
    selected: &str,
    candidate: &PlaceSearchResult,
) -> Result<bool, OsmError> {
    let Some(country) = candidate
        .country
        .as_deref()
        .map(str::trim)
        .filter(|country| !country.is_empty())
    else {
        // No country in the result: cannot probe for same-name candidates
        // in other countries, so fail closed.
        return Ok(false);
    };
    let counter_country = if country.eq_ignore_ascii_case("united states")
        || country.eq_ignore_ascii_case("united states of america")
    {
        "France"
    } else {
        "United States"
    };
    let counter_query = format!("{selected}, {counter_country}");
    match osm.search_place(&counter_query).await {
        Ok(counter) => {
            let same_name = provider_place_matches_selected(
                selected,
                counter.name.as_deref(),
                counter.municipality.as_deref(),
            );
            let different_location = !coordinates_match(candidate.latitude, counter.latitude)
                || !coordinates_match(candidate.longitude, counter.longitude);
            Ok(!(same_name && different_location))
        }
        Err(OsmError::NotFound) => Ok(true),
        Err(error) => Err(error),
    }
}

fn contextual_place_is_supported(
    selected: &str,
    context: Option<&str>,
    place: &PlaceSearchResult,
) -> bool {
    context.is_some_and(|context| {
        place
            .country
            .as_deref()
            .is_some_and(|country| country_supported_in_context(context, country))
    }) && provider_place_matches_selected(
        selected,
        place.name.as_deref(),
        place.municipality.as_deref(),
    )
}

fn provider_place_matches_selected(
    selected: &str,
    name: Option<&str>,
    municipality: Option<&str>,
) -> bool {
    let selected = normalize_text(selected);
    !selected.is_empty()
        && [name, municipality]
            .into_iter()
            .flatten()
            .any(|candidate| normalize_text(candidate) == selected)
}

fn bounded_location_text(value: &str) -> String {
    bounded_bytes(value, MAX_TOOL_LOCATION_BYTES)
}

fn nonempty_bounded(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| bounded_text(value))
}

fn valid_coordinates(latitude: f64, longitude: f64) -> bool {
    latitude.is_finite()
        && longitude.is_finite()
        && (-90.0..=90.0).contains(&latitude)
        && (-180.0..=180.0).contains(&longitude)
}

fn coordinates_match(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-6
}

fn normalize_text(value: &str) -> String {
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

fn normalized_contains(haystack: &str, needle: &str) -> bool {
    let haystack = normalize_text(haystack);
    let needle = normalize_text(needle);
    !needle.is_empty() && format!(" {haystack} ").contains(&format!(" {needle} "))
}

/// The provider country must be grounded in the trusted context: either an
/// exact normalized match or a word-bounded occurrence that is NOT a component
/// of a longer compound sovereign name (South Sudan vs Sudan, Northern Ireland
/// vs Ireland, Guinea-Bissau vs Guinea, Democratic Republic of the Congo vs
/// Congo, etc.). A standalone occurrence with no adjacent directional/geographic
/// modifier and not embedded in a listed non-directional compound is accepted;
/// every other occurrence is rejected.
fn country_supported_in_context(context: &str, country: &str) -> bool {
    let context = normalize_text(context);
    let country = normalize_text(country);
    if country.is_empty() || context.is_empty() {
        return false;
    }
    if context == country {
        return true;
    }
    let padded = format!(" {context} ");
    if !padded.contains(&format!(" {country} ")) {
        return false;
    }
    // A bare country that is only a component of a longer non-directional
    // compound sovereign present in the context ("Congo" inside "Democratic
    // Republic of the Congo", "Guinea" inside "Guinea-Bissau") names a different
    // or ambiguous country and must be rejected. Directional compounds (South
    // Sudan, Northern Ireland) are covered by the standalone-modifier check
    // below; this list adds the compounds the modifier heuristic cannot see.
    for compound in COMPOUND_SOVEREIGN_NAMES {
        let compound = normalize_text(compound);
        if compound == country {
            continue;
        }
        if padded.contains(&format!(" {compound} "))
            && format!(" {compound} ").contains(&format!(" {country} "))
        {
            return false;
        }
    }
    let context_words: Vec<&str> = context.split_whitespace().collect();
    let country_words: Vec<&str> = country.split_whitespace().collect();
    let country_len = country_words.len();
    if country_len == 0 || context_words.len() < country_len {
        return false;
    }
    for start in 0..=context_words.len() - country_len {
        if &context_words[start..start + country_len] == country_words.as_slice() {
            let prefix = start.checked_sub(1).map(|i| context_words[i]);
            let suffix = context_words.get(start + country_len).copied();
            let adjacent_modifier = prefix
                .into_iter()
                .chain(suffix.into_iter())
                .any(is_sovereign_modifier);
            if !adjacent_modifier {
                return true;
            }
        }
    }
    false
}

fn is_sovereign_modifier(word: &str) -> bool {
    matches!(
        word,
        "south"
            | "north"
            | "northern"
            | "southern"
            | "east"
            | "west"
            | "eastern"
            | "western"
            | "new"
            | "equatorial"
            | "central"
            | "upper"
            | "lower"
            | "great"
    )
}

/// Non-directional compound sovereign names whose normalized form embeds a
/// *different* or ambiguous sovereign as a word-bounded run: "Congo" inside the
/// two Congo republics, "Guinea" inside "Guinea-Bissau" (hyphen normalized to a
/// space). The directional-modifier heuristic above cannot see these, so a bare
/// inner match must be rejected explicitly. Formal names of the *same* country
/// (e.g. "Republic of Ireland" == "Ireland") are deliberately excluded so they
/// keep matching. Values are stored pre-normalized (lowercase, single-spaced).
const COMPOUND_SOVEREIGN_NAMES: &[&str] = &[
    "guinea bissau",
    "democratic republic of the congo",
    "republic of the congo",
];

fn is_current_location_label(value: &str) -> bool {
    matches!(
        normalize_text(value).as_str(),
        "current location" | "my location" | "here" | "where i am"
    )
}

fn requested_route_mode(utterance: &str) -> Result<Option<RouteMode>, ()> {
    let candidates: &[(RouteMode, &[&str])] = &[
        (RouteMode::Walking, &["walking", "walk", "on foot"]),
        (RouteMode::Driving, &["driving", "drive", "by car"]),
        (RouteMode::Cycling, &["cycling", "bike", "bicycle"]),
        (
            RouteMode::Transit,
            &["transit", "by bus", "by train", "public transport"],
        ),
    ];
    let modes = candidates
        .iter()
        .filter_map(|(mode, terms)| {
            terms
                .iter()
                .any(|term| normalized_contains(utterance, term))
                .then_some(*mode)
        })
        .collect::<Vec<_>>();

    match modes.as_slice() {
        [] => Ok(None),
        [mode] => Ok(Some(*mode)),
        _ => Err(()),
    }
}

fn route_mode_matches_configuration(requested: RouteMode, configured: RoutesTravelMode) -> bool {
    matches!(
        (requested, configured),
        (RouteMode::Walking, RoutesTravelMode::Walk)
            | (RouteMode::Driving, RoutesTravelMode::Drive)
            | (RouteMode::Cycling, RoutesTravelMode::Bicycle)
    )
}

fn configured_route_mode_name(mode: RoutesTravelMode) -> &'static str {
    match mode {
        RoutesTravelMode::Walk => "walking",
        RoutesTravelMode::Drive => "driving",
        RoutesTravelMode::Bicycle => "cycling",
        RoutesTravelMode::TwoWheeler => "two_wheeler",
    }
}

fn food_nutrient_name(kind: FoodNutrientKind) -> &'static str {
    match kind {
        FoodNutrientKind::Calcium => "calcium",
        FoodNutrientKind::Calories => "calories",
        FoodNutrientKind::Cholesterol => "cholesterol",
        FoodNutrientKind::DietaryFiber => "dietary_fiber",
        FoodNutrientKind::Iron => "iron",
        FoodNutrientKind::MonounsaturatedFat => "monounsaturated_fat",
        FoodNutrientKind::PolyunsaturatedFat => "polyunsaturated_fat",
        FoodNutrientKind::Potassium => "potassium",
        FoodNutrientKind::Protein => "protein",
        FoodNutrientKind::SaturatedFat => "saturated_fat",
        FoodNutrientKind::Sodium => "sodium",
        FoodNutrientKind::Sugars => "sugars",
        FoodNutrientKind::TotalCarbs => "total_carbs",
        FoodNutrientKind::TotalFat => "total_fat",
        FoodNutrientKind::TransFat => "trans_fat",
        FoodNutrientKind::VitaminA => "vitamin_a",
        FoodNutrientKind::VitaminC => "vitamin_c",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::body::Body;

    // A knowledge extract must stay within MAX_KNOWLEDGE_EXTRACT_BYTES so a
    // verbose topic cannot blow out the spoken answer or the model transcript.
    // Historically this bound also satisfied a structural-grounding citability
    // check; that runtime was removed with the legacy engine, but the bound is
    // still enforced for brevity and prompt budget (see the constant's comment).
    // This guards the truncation behaviour itself, including the codepoint
    // boundary — the original regression truncated verbose topics into results
    // the answer could not use.
    #[test]
    fn knowledge_extract_stays_within_the_groundable_text_limit() {
        // Assert against the constant, not a literal: the original regression
        // was two numbers coupled only by a comment, and they drifted apart.
        let limit = super::MAX_KNOWLEDGE_EXTRACT_BYTES;
        let long = "a".repeat(5_000);
        let bounded = super::bounded_knowledge_extract(&long);
        assert!(
            bounded.len() <= limit,
            "bounded knowledge extract must be <= {limit} bytes, was {}",
            bounded.len()
        );
        assert!(!bounded.is_empty());
        // The extract also has to fit the model transcript bound it re-enters,
        // otherwise it would be truncated a second time, mid-word.
        assert!(
            limit <= crate::llm::tool_step::MAX_TOOL_STEP_RESULT_BYTES,
            "knowledge extract bound ({limit}) must fit the chat-turn tool-result bound ({})",
            crate::llm::tool_step::MAX_TOOL_STEP_RESULT_BYTES
        );

        // Multi-byte input must be truncated on a codepoint boundary.
        let multibyte = "é".repeat(2_000);
        let bounded_mb = super::bounded_knowledge_extract(&multibyte);
        assert!(bounded_mb.len() <= limit);
        // The property the comment actually names: a byte bound must cut on a
        // codepoint boundary, so every surviving char is a whole `é`. A naive
        // `value[..limit]` would split one. `from_utf8` on a String's own bytes
        // is unconditionally Ok and can never observe that split.
        assert!(
            bounded_mb.chars().all(|character| character == 'é'),
            "byte bound split a multi-byte codepoint"
        );

        // A short extract passes through unchanged.
        let short = "The sky is blue due to Rayleigh scattering.";
        assert_eq!(super::bounded_knowledge_extract(short), short);
    }

    /// `MAX_TOOL_TEXT_CHARS` and `MAX_KNOWLEDGE_EXTRACT_BYTES` are both 1_024,
    /// but one counts Unicode scalars and the other counts bytes. They are not
    /// interchangeable and the shared-looking names must never be consolidated
    /// into one helper: for multi-byte input the byte bound cuts roughly four
    /// times earlier. Coupling two bounds by eye is what produced the original
    /// grounding regression, so pin the divergence rather than trusting review.
    #[test]
    fn char_bounded_and_byte_bounded_text_are_not_interchangeable() {
        // 4 bytes per scalar, so the two bounds cannot coincide.
        let multibyte = "😀".repeat(2_000);

        let by_chars = super::bounded_text(&multibyte);
        let by_bytes = super::bounded_knowledge_extract(&multibyte);

        assert_eq!(
            by_chars.chars().count(),
            super::MAX_TOOL_TEXT_CHARS,
            "bounded_text must bound by Unicode scalar count"
        );
        assert!(
            by_bytes.len() <= super::MAX_KNOWLEDGE_EXTRACT_BYTES,
            "bounded_knowledge_extract must bound by byte length"
        );
        assert!(
            by_bytes.chars().count() < by_chars.chars().count(),
            "byte bound must cut earlier than the char bound on multi-byte input \
             ({} vs {} scalars) — if these ever match, one of them changed unit",
            by_bytes.chars().count(),
            by_chars.chars().count()
        );
        // Neither may split a codepoint. Asserting `from_utf8(s.as_bytes())`
        // would be vacuous — `String` already guarantees valid UTF-8, so that
        // call is unconditionally `Ok` and could never fail. The property that
        // actually matters is that each result is a codepoint-ALIGNED PREFIX of
        // the input, which is exactly what a byte bound can get wrong.
        assert!(
            multibyte.starts_with(by_chars.as_str()),
            "the char bound must return an aligned prefix, not a re-encoding"
        );
        assert!(
            multibyte.starts_with(by_bytes.as_str()),
            "the byte bound must cut on a codepoint boundary, not mid-scalar"
        );
    }
    use axum::extract::Request;
    use axum::http::{Response, StatusCode};
    use axum::routing::get;
    use axum::Router;

    use super::*;

    use crate::external::google_maps::GoogleMapsClient;
    use crate::external::open_food_facts::OpenFoodFactsClient;
    use crate::synapse::catalog::{
        CurrentWeatherArguments, EmptyArguments, NearbySearchArguments, RememberFactArguments,
        ReverseGeocodeArguments, RouteArguments,
    };

    fn restricted_test_broker(
        directory: &tempfile::TempDir,
        device_lock_state: DeviceLockState,
        location: Option<(f64, f64)>,
    ) -> AgenticReadToolBroker {
        let http = reqwest::Client::new();
        let osm_options = OsmOptions::default();
        AgenticReadToolBroker::new(
            "where am i; weather; what city; find coffee near me; directions to Tivoli",
            location,
            device_lock_state,
            WeatherClient::new(http.clone(), None),
            http.clone(),
            osm_options.clone(),
            NearbyClient::new(http.clone(), osm_options),
            AgenticExternalClients::new(
                GoogleMapsClient::disabled(http.clone()),
                OpenFoodFactsClient::disabled(http.clone()),
                None,
                // Unconfigured on purpose: the default test broker must behave
                // like a Pin with no search subscription.
                crate::external::web_search::WebSearch::new(
                    Vec::new(),
                    crate::external::web_search::WebSearchGeo::default(),
                ),
            ),
            None,
            Database::open(
                directory
                    .path()
                    .join(format!("{device_lock_state:?}.sqlite")),
            )
            .unwrap(),
            None,
        )
    }

    #[tokio::test]
    async fn remember_fact_refuses_a_locked_device() {
        let directory = tempfile::tempdir().unwrap();
        let broker = restricted_test_broker(&directory, DeviceLockState::Locked, None);
        let invocation = WriteToolInvocation::RememberFact(RememberFactArguments {
            content: "coffee near Tivoli".to_string(),
            kind: None,
        });
        let output = broker
            .execute_write(AgenticWriteRequest {
                call_id: "w-1",
                invocation: &invocation,
            })
            .await
            .expect("a locked write reports unavailable rather than erroring");
        match output {
            AgenticToolOutput::Result(value) => {
                assert_eq!(
                    value.get("status").and_then(Value::as_str),
                    Some("unavailable")
                );
                assert_eq!(
                    value.get("reason").and_then(Value::as_str),
                    Some("requires_unlocked_device")
                );
            }
            other => panic!("expected a result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn remember_fact_refuses_content_the_user_never_said() {
        // The write gate's whole purpose: the model cannot persist a "fact" that
        // is not grounded in the user's own words this turn. Ungrounded content
        // is refused before it can reach the store.
        let directory = tempfile::tempdir().unwrap();
        let broker = restricted_test_broker(&directory, DeviceLockState::Unlocked, None);
        let invocation = WriteToolInvocation::RememberFact(RememberFactArguments {
            content: "buy oat milk tomorrow".to_string(),
            kind: None,
        });
        let output = broker
            .execute_write(AgenticWriteRequest {
                call_id: "w-1",
                invocation: &invocation,
            })
            .await;
        assert!(
            output.is_err(),
            "ungrounded content must be refused, got {output:?}"
        );
    }

    #[tokio::test]
    async fn remember_fact_without_a_store_reports_not_configured() {
        // Grounded content on an unlocked device, but no memory service wired:
        // the write reports that cleanly rather than pretending it saved.
        let directory = tempfile::tempdir().unwrap();
        let broker = restricted_test_broker(&directory, DeviceLockState::Unlocked, None);
        let invocation = WriteToolInvocation::RememberFact(RememberFactArguments {
            content: "coffee near Tivoli".to_string(),
            kind: None,
        });
        let output = broker
            .execute_write(AgenticWriteRequest {
                call_id: "w-1",
                invocation: &invocation,
            })
            .await
            .expect("a grounded write without a store reports unavailable, not error");
        match output {
            AgenticToolOutput::Result(value) => {
                assert_eq!(
                    value.get("status").and_then(Value::as_str),
                    Some("unavailable")
                );
                assert_eq!(
                    value.get("reason").and_then(Value::as_str),
                    Some("not_configured")
                );
            }
            other => panic!("expected a result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn knowledge_queries_are_grounded_by_utterance_or_conversation_context() {
        let directory = tempfile::tempdir().unwrap();
        let broker = restricted_test_broker(&directory, DeviceLockState::Unlocked, None)
            .with_context_texts(vec![
                "tell me about Michael Jackson".to_string(),
                "Michael Jackson was the King of Pop.".to_string(),
            ]);

        // Grounded in the current utterance: allowed.
        assert!(broker.require_user_span("weather").is_ok());
        // Grounded only in the conversation context (a follow-up query for the
        // discussed entity): allowed.
        assert!(broker.require_user_span("Michael Jackson").is_ok());
        assert!(broker.require_user_span("king of pop").is_ok());
        // Grounded nowhere: rejected with the self-repair guidance.
        let rejection = broker.require_user_span("Elvis Presley").unwrap_err();
        assert!(rejection.to_string().contains("not grounded"));
        assert!(rejection.to_string().contains("quoting the exact words"));
    }

    #[test]
    fn three_maximal_web_results_fit_the_tool_result_budget() {
        // A knowledge lookup spends the budget on one extract; a web search
        // returns three results. Copying the extract bound let one observation
        // reach ~12 KiB against a 4 KiB budget, and the truncating bound below
        // it produces a prefix that is by construction invalid JSON — so the
        // model would receive garbage rather than a short answer.
        let long = "\u{e5}".repeat(4_096);
        let results: Vec<_> = (0..3)
            .map(|_| {
                json!({
                    "title": bounded_web_title(&long),
                    "snippet": bounded_web_snippet(&long),
                    "source_url": bounded_web_url(&long),
                    "age": Some(bounded_web_age(&long))
                })
            })
            .collect();
        let payload = json!({
            "status": "ok",
            "query": "a".repeat(512),
            "results": results
        });

        let encoded = serde_json::to_vec(&payload).unwrap();
        assert!(
            encoded.len() <= crate::llm::tool_step::MAX_TOOL_STEP_RESULT_BYTES,
            "3 maximal results must fit the tool-result budget, got {} bytes",
            encoded.len()
        );
    }

    #[test]
    fn web_field_bounds_never_split_a_character() {
        // Byte-counted bounds on multi-byte text must still yield valid UTF-8.
        let multibyte = "\u{1f680}".repeat(200);
        for bounded in [
            bounded_web_snippet(&multibyte),
            bounded_web_title(&multibyte),
            bounded_web_url(&multibyte),
            bounded_web_age(&multibyte),
        ] {
            assert!(bounded.chars().all(|character| character == '\u{1f680}'));
        }
        assert!(bounded_web_age(&multibyte).len() <= MAX_WEB_AGE_BYTES);
    }

    #[tokio::test]
    async fn a_web_query_may_reorder_and_drop_the_users_words_but_never_add_any() {
        // A search query is not a name. Demanding one contiguous span (which is
        // right for knowledge_lookup) refuses every usable search phrasing, and
        // the model is then told to try "a different query" — which is refused
        // again. Token containment keeps the invariant that matters: no token
        // may come from anywhere but the user or the prior conversation.
        let directory = tempfile::tempdir().unwrap();
        // The default test broker's utterance is a fixed multi-intent string;
        // the search phrasing rides in as conversation context, which the gate
        // treats identically to the utterance.
        let broker = restricted_test_broker(&directory, DeviceLockState::Unlocked, None)
            .with_context_texts(vec![
                "search the web for the latest news about the James Webb Space Telescope"
                    .to_string(),
            ]);

        for accepted in [
            "latest news about the James Webb Space Telescope",
            "James Webb Space Telescope news",
            "James Webb latest news",
            "the James Webb Space Telescope",
        ] {
            assert!(
                broker.require_grounded_query_tokens(accepted).is_ok(),
                "should accept {accepted:?}"
            );
        }

        for rejected in [
            // Adds an entity the user never said.
            "James Webb Space Telescope Hubble comparison",
            // Adds a date qualifier: plausible, but still not the user's words.
            "James Webb Space Telescope news January 2026",
            // Entirely unrelated.
            "Eurovision winner",
            // Nothing searchable left after stopwords.
            "what is the",
        ] {
            assert!(
                broker.require_grounded_query_tokens(rejected).is_err(),
                "should reject {rejected:?}"
            );
        }

        // The contiguous-span gate stays exactly as strict for the tools that
        // want a name rather than a query.
        assert!(broker.require_user_span("James Webb latest news").is_err());
    }

    #[tokio::test]
    async fn an_ungrounded_web_token_is_dropped_rather_than_failing_the_search() {
        // Fixture utterance:
        //   "where am i; weather; what city; find coffee near me; directions to Tivoli"
        //
        // Measured on device: the model added a term the user never said and the
        // search was refused outright, so the user got nothing. The description
        // already forbade this and the model did it anyway (.124 showed wording
        // changes do not move it), so the invariant is now enforced structurally.
        let directory = tempfile::tempdir().unwrap();
        let broker = restricted_test_broker(&directory, DeviceLockState::Unlocked, None);

        // The ungrounded token is removed; the grounded remainder still searches.
        let filtered = broker
            .grounded_query_tokens("Tivoli opening hours")
            .expect("a grounded remainder must survive");
        assert!(filtered.contains("tivoli"));
        assert!(
            !filtered.contains("opening"),
            "ungrounded token must be dropped: {filtered:?}"
        );
        assert!(
            !filtered.contains("hours"),
            "ungrounded token must be dropped: {filtered:?}"
        );

        // Nothing grounded left is still a refusal — an empty search is not an
        // answer, and must not silently reach the provider.
        assert!(broker.grounded_query_tokens("Statue of Liberty").is_err());
        assert!(broker.grounded_query_tokens("").is_err());

        // A fully grounded query is unchanged.
        let intact = broker.grounded_query_tokens("Tivoli directions").unwrap();
        assert!(intact.contains("tivoli") && intact.contains("directions"));
    }

    #[tokio::test]
    async fn a_derived_knowledge_query_grounds_but_a_foreign_one_does_not() {
        // Fifth appearance of the exact-span pattern. "How tall is the Eiffel
        // Tower" makes the model query "Eiffel Tower height": every token comes
        // from the request, but it is not one contiguous span, so the old gate
        // refused it and the retry-then-not_found cost two steps and produced
        // no answer.
        let directory = tempfile::tempdir().unwrap();
        let broker = restricted_test_broker(&directory, DeviceLockState::Unlocked, None);

        // The fixture utterance is:
        //   "where am i; weather; what city; find coffee near me; directions to Tivoli"
        //
        // Tokens drawn from it, reordered and with filler dropped, now ground —
        // this is the shape the span gate refused.
        assert!(broker
            .require_grounded_query_tokens("Tivoli directions")
            .is_ok());
        assert!(broker.require_grounded_query_tokens("coffee city").is_ok());

        // The invariant that must survive: a token the user never said is still
        // refused, so nothing invented reaches the provider.
        assert!(broker
            .require_grounded_query_tokens("Statue of Liberty")
            .is_err());
        assert!(broker
            .require_grounded_query_tokens("Tivoli opening hours")
            .is_err());
        assert!(broker.require_grounded_query_tokens("").is_err());

        // The strict span gate is unchanged for the tools that want a name:
        // the same reordered query it always refused, it still refuses.
        assert!(broker.require_user_span("Tivoli directions").is_err());
    }

    #[tokio::test]
    async fn a_bare_nearby_search_is_grounded_by_having_no_query() {
        // "what's nearby" names no kind of place, so any query the model could
        // supply is ungrounded by construction. Requiring one made the request
        // unsatisfiable: observed on device failing the gate twice before the
        // model guessed a word that happened to appear in the utterance.
        let directory = tempfile::tempdir().unwrap();
        let broker = restricted_test_broker(&directory, DeviceLockState::Unlocked, None);

        // The gate itself is deliberately unchanged — an empty span is still
        // not a span. The NearbySearch path skips it instead, so no other
        // caller is loosened.
        assert!(broker.require_user_span("").is_err());
        assert!(broker.require_user_span("sushi restaurants").is_err());

        // The path that matters: an omitted query is not refused for grounding.
        let omitted = broker
            .execute(AgenticToolRequest {
                call_id: "nearby-omitted",
                invocation: &ReadToolInvocation::NearbySearch(NearbySearchArguments {
                    query: String::new(),
                    latitude: None,
                    longitude: None,
                    radius_m: None,
                }),
            })
            .await;
        let refused_for_grounding = matches!(&omitted, Err(error)
            if error.to_string().contains("not grounded"));
        assert!(
            !refused_for_grounding,
            "an omitted nearby query must not be refused for grounding, got {omitted:?}"
        );

        // A supplied category the user never said is still refused.
        let invented = broker
            .execute(AgenticToolRequest {
                call_id: "nearby-invented",
                invocation: &ReadToolInvocation::NearbySearch(NearbySearchArguments {
                    query: "sushi restaurants".into(),
                    latitude: None,
                    longitude: None,
                    radius_m: None,
                }),
            })
            .await;
        assert!(
            matches!(&invented, Err(error) if error.to_string().contains("not grounded")),
            "an ungrounded category must still be refused, got {invented:?}"
        );
    }

    #[tokio::test]
    async fn ungrounded_queries_stay_rejected_without_context() {
        let directory = tempfile::tempdir().unwrap();
        let broker = restricted_test_broker(&directory, DeviceLockState::Unlocked, None);
        assert!(broker.require_user_span("Michael Jackson").is_err());
    }

    #[test]
    fn every_dynamic_model_step_gets_the_same_bounded_retry_budget() {
        // Codex keeps the multi-phase bridge bound it genuinely needs.
        assert_eq!(model_step_timeout(LlmProvider::Codex), MODEL_STEP_TIMEOUT);
        // Direct HTTP providers are bounded tightly: applying the Codex bound
        // let one hung request eat the whole stock budget and surface as
        // "took too long to respond" instead of an answer or a decline.
        for provider in [
            LlmProvider::OpenAiCompatible,
            LlmProvider::OpenAi,
            LlmProvider::Gemini,
            LlmProvider::Anthropic,
        ] {
            assert_eq!(
                model_step_timeout(provider),
                HTTP_PROVIDER_MODEL_STEP_TIMEOUT
            );
        }
        // The HTTP provider bound must fit inside the outer runtime breaker
        // with room left for tool work and a terminal step.
        assert!(
            HTTP_PROVIDER_MODEL_STEP_TIMEOUT
                < crate::services::aibus::understand::AGENTIC_RUNTIME_TIMEOUT
        );
        // 5 (identity) + 10 (thread/start) + 18 (interactive) + 2 (cleanup).
        // `thread/start` was 20s, which could not be reached inside an 18s
        // interactive window; tightening it to 10s lowers this composed bound
        // from 45s to 35s. These literals are a tripwire, not a target: they
        // exist so a change to any nested deadline has to be acknowledged here.
        assert_eq!(MODEL_FIRST_TURN_BRIDGE_BOUND, Duration::from_secs(35));
        assert_eq!(MODEL_STEP_TRANSPORT_MARGIN, Duration::from_secs(5));
        assert_eq!(MODEL_STEP_TIMEOUT, Duration::from_secs(40));
        assert_eq!(
            MODEL_FIRST_TURN_BRIDGE_BOUND,
            crate::llm::CODEX_BRIDGE_IDENTITY_TIMEOUT
                + crate::llm::CODEX_THREAD_START_TIMEOUT
                + crate::llm::CODEX_INTERACTIVE_CHAT_TIMEOUT
                + crate::llm::CODEX_INTERRUPT_CLEANUP_TIMEOUT,
        );
        assert_eq!(
            MODEL_STEP_TIMEOUT,
            MODEL_FIRST_TURN_BRIDGE_BOUND + MODEL_STEP_TRANSPORT_MARGIN,
        );
        assert!(MODEL_STEP_TIMEOUT < crate::services::aibus::understand::AGENTIC_RUNTIME_TIMEOUT);
        assert!(
            MODEL_STEP_TIMEOUT < crate::services::aibus::stock_deadline::HOOKED_IRONMAN_TIMEOUT
        );
    }

    /// The whole deadline hierarchy, asserted numerically in ONE place.
    ///
    /// Every bound on the agentic turn path is nested inside another, and the
    /// nesting used to be documented only in prose that had gone false (the
    /// bridge cap cited an "authoritative 20-second stock boundary" that does
    /// not exist — Ironman's own ceiling is 25s and our Hook raises it to 90s).
    /// Prose cannot fail. This test can: raising any one of these constants in
    /// isolation turns it red instead of silently inverting the hierarchy.
    #[test]
    fn the_agentic_deadline_hierarchy_is_strictly_nested() {
        use crate::services::aibus::stock_deadline::{HOOKED_IRONMAN_TIMEOUT, STOCK_TURN_DEADLINE};
        use crate::services::aibus::understand::{
            AGENTIC_LOOP_TIME_BUDGET, AGENTIC_RUNTIME_TIMEOUT,
        };
        use crate::synapse::chat_turn_loop::DEFAULT_GRACE_RESERVE;

        // Outer chain: stock ceiling > our stock-turn deadline > runtime
        // breaker > the loop's own wall-clock budget. Each gap is what lets the
        // inner layer finish and SPEAK before the outer one fires and replaces
        // its answer with a fixed apology.
        assert!(
            STOCK_TURN_DEADLINE < HOOKED_IRONMAN_TIMEOUT,
            "the stock turn deadline must land before the hooked Ironman ceiling"
        );
        assert!(
            AGENTIC_RUNTIME_TIMEOUT < STOCK_TURN_DEADLINE,
            "the runtime breaker must fire before the stock turn deadline"
        );
        assert!(
            AGENTIC_LOOP_TIME_BUDGET < AGENTIC_RUNTIME_TIMEOUT,
            "the loop must give up before its own outer breaker discards its work"
        );

        // THE property a raise-in-isolation must break: one full-length model
        // step AND the reserved grace answer must both still fit in the loop
        // budget. Without this the reserve is only nominal — the grace step is
        // bounded by the same per-step timeout as any other step, so a large
        // per-step bound lets the final answer overrun the budget and be thrown
        // away by the breaker, which is exactly what the reserve exists to stop.
        assert!(
            MODEL_STEP_TIMEOUT + DEFAULT_GRACE_RESERVE <= AGENTIC_LOOP_TIME_BUDGET,
            "a full model step ({MODEL_STEP_TIMEOUT:?}) plus the grace reserve \
             ({DEFAULT_GRACE_RESERVE:?}) must fit inside the loop budget \
             ({AGENTIC_LOOP_TIME_BUDGET:?}); raising a nested deadline without \
             re-deriving this hierarchy makes the grace answer unreachable"
        );

        // Bridge chain: every bound applied INSIDE the interactive window must
        // be strictly smaller than it, or it can never be reached and its
        // failure is indistinguishable from a model-step timeout.
        assert!(
            crate::llm::CODEX_THREAD_START_TIMEOUT < crate::llm::CODEX_INTERACTIVE_CHAT_TIMEOUT,
            "thread/start and turn/start run inside the interactive window"
        );
        assert!(
            crate::llm::CODEX_INTERRUPT_CLEANUP_TIMEOUT
                < crate::llm::CODEX_INTERACTIVE_CHAT_TIMEOUT,
            "cleanup runs inside the interactive window"
        );
        assert!(
            crate::llm::CODEX_INTERACTIVE_CHAT_TIMEOUT < MODEL_STEP_TIMEOUT,
            "the provider step bound must outlive the bridge bound it wraps"
        );
    }

    /// How many model steps a turn can actually afford at the current numbers.
    ///
    /// Pinned because it is the user-visible consequence of every constant
    /// above: it decides whether a multi-tool turn can COMPLETE or gets cut off
    /// mid-plan. Measured on-device model steps in the .164 probe set ran
    /// 4.6-10.8s, and tool batches ~5s.
    #[test]
    fn the_loop_budget_affords_a_multi_step_tool_turn() {
        use crate::services::aibus::understand::AGENTIC_LOOP_TIME_BUDGET;
        use crate::synapse::chat_turn_loop::DEFAULT_GRACE_RESERVE;

        // Observed worst case step, rounded up, plus a nominal tool batch.
        let step = Duration::from_secs(11);
        let tool_batch = Duration::from_secs(5);

        // Tool-capable steps that fit before the grace reserve must be claimed.
        let usable = AGENTIC_LOOP_TIME_BUDGET.saturating_sub(DEFAULT_GRACE_RESERVE);
        let per_iteration = step + tool_batch;
        let tool_steps = usable.as_secs() / per_iteration.as_secs();

        assert_eq!(
            tool_steps, 3,
            "at observed latency the run affords 3 tool-capable steps plus the \
             grace answer ({usable:?} usable / {per_iteration:?} per iteration)"
        );

        // And the worst case still fits: even if every one of those steps ran
        // to the full per-step circuit breaker, the run cannot exceed its own
        // budget, because the loop clamps each step to the remaining budget.
        assert!(
            MODEL_STEP_TIMEOUT <= AGENTIC_LOOP_TIME_BUDGET,
            "a single step's circuit breaker must not exceed the whole budget"
        );
    }

    #[tokio::test]
    async fn broker_rejects_all_location_reads_for_locked_and_unknown_devices_first() {
        let invocations = [
            ReadToolInvocation::CurrentLocation(EmptyArguments::default()),
            ReadToolInvocation::CurrentWeather(CurrentWeatherArguments {
                location: Some("current location".into()),
            }),
            ReadToolInvocation::ReverseGeocode(ReverseGeocodeArguments {
                latitude: 55.6761,
                longitude: 12.5683,
            }),
            ReadToolInvocation::NearbySearch(NearbySearchArguments {
                query: "coffee".into(),
                latitude: Some(55.6761),
                longitude: Some(12.5683),
                radius_m: None,
            }),
            ReadToolInvocation::Route(RouteArguments {
                origin: "current location".into(),
                destination: "Tivoli".into(),
                mode: None,
            }),
        ];

        for state in [DeviceLockState::Locked, DeviceLockState::Unknown] {
            let directory = tempfile::tempdir().unwrap();
            let broker = restricted_test_broker(&directory, state, Some((55.6761, 12.5683)));
            for invocation in &invocations {
                let error = broker
                    .execute(AgenticToolRequest {
                        call_id: "restricted-location",
                        invocation,
                    })
                    .await
                    .expect_err("restricted location read must fail before provider work");
                assert_eq!(
                    error.to_string(),
                    "location tools require a confirmed unlocked device",
                    "{} escaped with {state:?}",
                    invocation.name()
                );
            }

            let no_cached_location = restricted_test_broker(&directory, state, None);
            let invocation = ReadToolInvocation::CurrentLocation(EmptyArguments::default());
            assert!(no_cached_location
                .execute(AgenticToolRequest {
                    call_id: "must-not-preflight",
                    invocation: &invocation,
                })
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn broker_never_reads_current_music_without_confirmed_unlock() {
        for state in [DeviceLockState::Locked, DeviceLockState::Unknown] {
            let directory = tempfile::tempdir().unwrap();
            let broker = restricted_test_broker(&directory, state, None);
            let invocation = ReadToolInvocation::CurrentMusic(EmptyArguments::default());
            let output = broker
                .execute(AgenticToolRequest {
                    call_id: "restricted-current-music",
                    invocation: &invocation,
                })
                .await
                .expect("restricted current music should return typed unavailable");
            let AgenticToolOutput::Result(result) = output else {
                panic!("restricted current music must not stage a device action");
            };
            assert_eq!(result["status"], "unavailable");
            assert_eq!(result["tool"], "current_music");
            assert_eq!(result["reason"], "requires_unlocked_device");
        }
    }

    #[test]
    fn a_failed_external_lookup_carries_a_spoken_message_local_state_does_not() {
        // A genuinely failed web search must hand the model the exact words, so
        // the wearer hears that search was unavailable rather than a generic
        // decline (roadmap item 0). The words live in the observation, not the
        // prompt.
        let searched = unavailable("web_search", "provider_unavailable");
        assert_eq!(searched["status"], "unavailable");
        assert_eq!(searched["reason"], "provider_unavailable");
        assert_eq!(searched["message"], "Web search is unavailable right now.");

        // Every external provider that can be unreachable gets a capability-named
        // sentence — removing the wiring drops these and turns the test RED.
        for tool in [
            "knowledge_lookup",
            "place_search",
            "weather",
            "nearby_search",
            "route",
        ] {
            assert!(
                unavailable(tool, "timeout")["message"].is_string(),
                "{tool} failure must contain a spoken message"
            );
        }

        // A local-state / device-gate failure is left exactly as before: no
        // message, so the model keeps handling it the way it already does.
        let local = unavailable("current_music", "local_state_unavailable");
        assert_eq!(local["status"], "unavailable");
        assert!(
            local.get("message").is_none(),
            "local-state failures must not gain a wearer message"
        );
    }

    #[test]
    fn user_span_matching_is_case_and_punctuation_insensitive_but_token_bounded() {
        assert!(normalized_contains(
            "Look up Michael Jackson's best songs",
            "Michael Jackson"
        ));
        assert!(!normalized_contains("play a soundtrack", "track"));
    }

    #[test]
    fn current_location_labels_are_explicit_and_bounded() {
        assert!(is_current_location_label("my location"));
        assert!(is_current_location_label("Where I am"));
        assert!(!is_current_location_label("Copenhagen"));
    }

    #[test]
    fn remote_weather_labels_prefer_a_short_locality_and_country() {
        assert_eq!(
            place_weather_label(
                None,
                Some("Paris"),
                Some("France"),
                "Paris, Île-de-France, Metropolitan France, France",
            ),
            "Paris, France"
        );
        assert_eq!(
            place_weather_label(Some("Singapore"), None, Some("Singapore"), "Singapore"),
            "Singapore"
        );
        assert_eq!(
            place_provider_query("Paris", Some("France")).as_deref(),
            Some("Paris, France")
        );
        assert_eq!(
            place_provider_query("Singapore", Some("Singapore")).as_deref(),
            Some("Singapore")
        );
        assert!(provider_place_matches_selected(
            "Paris",
            None,
            Some("Paris")
        ));
        assert!(!provider_place_matches_selected(
            "Paris",
            Some("Paris Embassy"),
            None
        ));
    }

    #[tokio::test]
    async fn topic_context_falls_back_once_to_the_exact_place_with_country_proof() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/search",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let url =
                        reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                    let query = url
                        .query_pairs()
                        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
                        .unwrap();
                    let response = match query.as_str() {
                        "Paris, Capital of France" => json!([]),
                        "Paris" => json!([{
                            "lat": "48.8566",
                            "lon": "2.3522",
                            "name": "Paris",
                            "display_name": "Paris, France",
                            "address": {"city": "Paris", "country": "France"}
                        }]),
                        other => panic!("unexpected place query {other}"),
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(serde_json::to_vec(&response).unwrap()))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let osm = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        let place = resolve_selected_place(&osm, "Paris", Some("Capital of France"))
            .await
            .unwrap()
            .expect("the country-backed exact-place fallback must resolve");

        assert_eq!(place.name.as_deref(), Some("Paris"));
        assert_eq!(place.country.as_deref(), Some("France"));
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn contextual_first_hit_in_wrong_country_falls_back_once() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/search",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let url =
                        reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                    let query = url
                        .query_pairs()
                        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
                        .unwrap();
                    let response = match query.as_str() {
                        "Paris, Capital of France" => json!([{
                            "lat": "33.6609",
                            "lon": "-95.5555",
                            "name": "Paris",
                            "display_name": "Paris, Texas, United States",
                            "address": {"city": "Paris", "country": "United States"}
                        }]),
                        "Paris" => json!([{
                            "lat": "48.8566",
                            "lon": "2.3522",
                            "name": "Paris",
                            "display_name": "Paris, France",
                            "address": {"city": "Paris", "country": "France"}
                        }]),
                        other => panic!("unexpected place query {other}"),
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(serde_json::to_vec(&response).unwrap()))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let osm = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        let place = resolve_selected_place(&osm, "Paris", Some("Capital of France"))
            .await
            .unwrap()
            .expect("the wrong-country first hit must be replaced by the proven fallback");

        assert_eq!(place.country.as_deref(), Some("France"));
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn contextual_first_hit_with_supported_country_needs_no_fallback() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/search",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let url =
                        reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                    let query = url
                        .query_pairs()
                        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
                        .unwrap();
                    assert_eq!(query, "Paris, Capital of France");
                    let response = json!([{
                        "lat": "48.8566",
                        "lon": "2.3522",
                        "name": "Paris",
                        "display_name": "Paris, France",
                        "address": {"city": "Paris", "country": "France"}
                    }]);
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(serde_json::to_vec(&response).unwrap()))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let osm = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        let place = resolve_selected_place(&osm, "Paris", Some("Capital of France"))
            .await
            .unwrap()
            .expect("a contextual result with country proof must resolve");

        assert_eq!(place.country.as_deref(), Some("France"));
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn uncontextualized_unique_place_has_no_same_name_counterpart() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/search",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let url =
                        reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                    let query = url
                        .query_pairs()
                        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
                        .unwrap();
                    let response = match query.as_str() {
                        "Reykjavik" => json!([{
                            "lat": "64.1466",
                            "lon": "-21.9426",
                            "name": "Reykjavik",
                            "display_name": "Reykjavik, Iceland",
                            "address": {"city": "Reykjavik", "country": "Iceland"}
                        }]),
                        "Reykjavik, United States" => json!([]),
                        other => panic!("unexpected place query {other}"),
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(serde_json::to_vec(&response).unwrap()))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let osm = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        let place = resolve_selected_place(&osm, "Reykjavik", None)
            .await
            .unwrap()
            .expect("a unique bare name with no counter-country match must resolve");

        assert_eq!(place.country.as_deref(), Some("Iceland"));
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn bare_ambiguous_place_is_rejected() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/search",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let url =
                        reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                    let query = url
                        .query_pairs()
                        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
                        .unwrap();
                    let response = match query.as_str() {
                        "Paris" => json!([{
                            "lat": "33.6609",
                            "lon": "-95.5555",
                            "name": "Paris",
                            "display_name": "Paris, Texas, United States",
                            "address": {"city": "Paris", "country": "United States"}
                        }]),
                        "Paris, France" => json!([{
                            "lat": "48.8566",
                            "lon": "2.3522",
                            "name": "Paris",
                            "display_name": "Paris, France",
                            "address": {"city": "Paris", "country": "France"}
                        }]),
                        other => panic!("unexpected place query {other}"),
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(serde_json::to_vec(&response).unwrap()))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let osm = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        let result = resolve_selected_place(&osm, "Paris", None).await.unwrap();
        assert!(
            result.is_none(),
            "a bare ambiguous name must not silently accept the provider-first limit-one result"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn direct_qualified_place_preserves_two_exact_spans() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/search",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let url =
                        reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                    let query = url
                        .query_pairs()
                        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
                        .unwrap();
                    assert_eq!(query, "Paris, France");
                    let response = json!([{
                        "lat": "48.8566",
                        "lon": "2.3522",
                        "name": "Paris",
                        "display_name": "Paris, France",
                        "address": {"city": "Paris", "country": "France"}
                    }]);
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(serde_json::to_vec(&response).unwrap()))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let osm = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        let place = resolve_selected_place(&osm, "Paris", Some("France"))
            .await
            .unwrap()
            .expect("a direct qualified place with two exact user spans must resolve");

        assert_eq!(place.name.as_deref(), Some("Paris"));
        assert_eq!(place.country.as_deref(), Some("France"));
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn qualified_place_rejects_wrong_country_result() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/search",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let url =
                        reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                    let query = url
                        .query_pairs()
                        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
                        .unwrap();
                    let response = match query.as_str() {
                        "Paris, France" => json!([{
                            "lat": "33.6609",
                            "lon": "-95.5555",
                            "name": "Paris",
                            "display_name": "Paris, Texas, United States",
                            "address": {"city": "Paris", "country": "United States"}
                        }]),
                        "Paris" => json!([{
                            "lat": "33.6609",
                            "lon": "-95.5555",
                            "name": "Paris",
                            "display_name": "Paris, Texas, United States",
                            "address": {"city": "Paris", "country": "United States"}
                        }]),
                        other => panic!("unexpected place query {other}"),
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(serde_json::to_vec(&response).unwrap()))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let osm = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        let result = resolve_selected_place(&osm, "Paris", Some("France"))
            .await
            .unwrap();
        assert!(
            result.is_none(),
            "a qualified place must reject a result whose country does not match the trusted context"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn bare_place_fallback_rejects_an_unrelated_country_or_name() {
        let place = PlaceSearchResult {
            name: Some("Paris".to_string()),
            display_name: "Paris, France".to_string(),
            municipality: Some("Paris".to_string()),
            country: Some("France".to_string()),
            latitude: 48.8566,
            longitude: 2.3522,
        };
        assert!(contextual_place_is_supported(
            "Paris",
            Some("Capital of France"),
            &place
        ));
        assert!(!contextual_place_is_supported(
            "Paris",
            Some("Capital of Spain"),
            &place
        ));
        assert!(!contextual_place_is_supported(
            "Lyon",
            Some("Capital of France"),
            &place
        ));
        assert!(!contextual_place_is_supported("Paris", None, &place));
    }

    #[test]
    fn country_matching_rejects_compound_sovereign_substrings() {
        // Sudan vs South Sudan
        assert!(country_supported_in_context("Sudan", "Sudan"));
        assert!(country_supported_in_context("History of Sudan", "Sudan"));
        assert!(!country_supported_in_context("South Sudan", "Sudan"));
        assert!(country_supported_in_context("South Sudan", "South Sudan"));
        assert!(!country_supported_in_context("Sudan", "South Sudan"));

        // Ireland vs Northern Ireland
        assert!(country_supported_in_context("Ireland", "Ireland"));
        assert!(country_supported_in_context(
            "Republic of Ireland",
            "Ireland"
        ));
        assert!(!country_supported_in_context("Northern Ireland", "Ireland"));
        assert!(country_supported_in_context(
            "Northern Ireland",
            "Northern Ireland"
        ));
        assert!(!country_supported_in_context("Ireland", "Northern Ireland"));

        // Non-directional compounds: false positives the directional-modifier
        // blocklist structurally could not catch (F4).
        assert!(country_supported_in_context("Guinea", "Guinea"));
        assert!(!country_supported_in_context("Guinea-Bissau", "Guinea"));
        assert!(country_supported_in_context(
            "Guinea-Bissau",
            "Guinea-Bissau"
        ));
        assert!(!country_supported_in_context(
            "Democratic Republic of the Congo",
            "Congo"
        ));
        assert!(!country_supported_in_context(
            "Republic of the Congo",
            "Congo"
        ));

        // France remains unambiguous
        assert!(country_supported_in_context("France", "France"));
        assert!(country_supported_in_context("Capital of France", "France"));
        assert!(!country_supported_in_context("Spain", "France"));

        // Empty and mismatch cases
        assert!(!country_supported_in_context("", "France"));
        assert!(!country_supported_in_context("France", ""));
        assert!(!country_supported_in_context("Germany", "France"));
    }

    #[test]
    fn contextual_place_rejects_sudan_in_south_sudan_context() {
        let place_in_sudan = PlaceSearchResult {
            name: Some("Khartoum".to_string()),
            display_name: "Khartoum, Sudan".to_string(),
            municipality: Some("Khartoum".to_string()),
            country: Some("Sudan".to_string()),
            latitude: 15.5007,
            longitude: 32.5599,
        };
        let place_in_south_sudan = PlaceSearchResult {
            name: Some("Juba".to_string()),
            display_name: "Juba, South Sudan".to_string(),
            municipality: Some("Juba".to_string()),
            country: Some("South Sudan".to_string()),
            latitude: 4.8594,
            longitude: 31.5713,
        };

        // Context "South Sudan" must NOT accept a place in "Sudan"
        assert!(!contextual_place_is_supported(
            "Khartoum",
            Some("South Sudan"),
            &place_in_sudan
        ));
        // Context "South Sudan" must accept a place in "South Sudan"
        assert!(contextual_place_is_supported(
            "Juba",
            Some("South Sudan"),
            &place_in_south_sudan
        ));
        // Context "Sudan" must NOT accept a place in "South Sudan"
        assert!(!contextual_place_is_supported(
            "Juba",
            Some("Sudan"),
            &place_in_south_sudan
        ));
        // Context "Sudan" must accept a place in "Sudan"
        assert!(contextual_place_is_supported(
            "Khartoum",
            Some("Sudan"),
            &place_in_sudan
        ));
    }

    #[test]
    fn contextual_place_rejects_ireland_in_northern_ireland_context() {
        let place_in_ireland = PlaceSearchResult {
            name: Some("Dublin".to_string()),
            display_name: "Dublin, Ireland".to_string(),
            municipality: Some("Dublin".to_string()),
            country: Some("Ireland".to_string()),
            latitude: 53.3498,
            longitude: -6.2603,
        };
        let place_in_northern_ireland = PlaceSearchResult {
            name: Some("Belfast".to_string()),
            display_name: "Belfast, Northern Ireland".to_string(),
            municipality: Some("Belfast".to_string()),
            country: Some("United Kingdom".to_string()),
            latitude: 54.5973,
            longitude: -5.9301,
        };

        // Context "Northern Ireland" must NOT accept a place in "Ireland"
        // (country "Ireland" is a substring of context "Northern Ireland")
        assert!(!contextual_place_is_supported(
            "Dublin",
            Some("Northern Ireland"),
            &place_in_ireland
        ));
        // Context "Ireland" must accept a place in "Ireland"
        assert!(contextual_place_is_supported(
            "Dublin",
            Some("Ireland"),
            &place_in_ireland
        ));
        // Context "Ireland" must NOT accept a place whose country is
        // "United Kingdom" (no Ireland in the country field at all)
        assert!(!contextual_place_is_supported(
            "Belfast",
            Some("Ireland"),
            &place_in_northern_ireland
        ));
    }

    #[tokio::test]
    async fn equal_context_requires_country_proof_and_rejects_foreign_name_match() {
        let requests = Arc::new(AtomicUsize::new(0));
        let handler_requests = Arc::clone(&requests);
        let app = Router::new().route(
            "/search",
            get(move |request: Request| {
                let requests = Arc::clone(&handler_requests);
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    let url =
                        reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                    let query = url
                        .query_pairs()
                        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
                        .unwrap();
                    // The provider query is just "Sudan" because context equals
                    // the selected span. Return a place whose name matches but
                    // whose country is the wrong sovereign state.
                    let response = match query.as_str() {
                        "Sudan" => json!([{
                            "lat": "4.8594",
                            "lon": "31.5713",
                            "name": "Sudan",
                            "display_name": "Sudan, South Sudan",
                            "address": {"state": "Sudan", "country": "South Sudan"}
                        }]),
                        other => panic!("unexpected place query {other}"),
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(serde_json::to_vec(&response).unwrap()))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let osm = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        // When context equals selected ("Sudan", Some("Sudan")), the result
        // must still contain country proof. A provider returning country
        // "South Sudan" must be rejected, and no fallback is attempted because
        // the query already matched the selected span.
        let place = resolve_selected_place(&osm, "Sudan", Some("Sudan"))
            .await
            .unwrap();
        assert!(
            place.is_none(),
            "equal context must require country proof; a name-only match in the wrong country must be rejected"
        );
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "no redundant fallback query when the initial query already matched the selected span"
        );
    }

    #[test]
    fn coordinate_matching_rejects_model_selected_places() {
        assert!(coordinates_match(55.6761, 55.6761));
        assert!(!coordinates_match(55.6761, 55.7));
    }

    #[test]
    fn route_mode_inference_is_explicit_and_rejects_ambiguity() {
        assert_eq!(
            requested_route_mode("Give me walking directions home"),
            Ok(Some(RouteMode::Walking))
        );
        assert_eq!(
            requested_route_mode("How do I get there by car?"),
            Ok(Some(RouteMode::Driving))
        );
        assert_eq!(
            requested_route_mode("Find a route to the station"),
            Ok(None)
        );
        assert_eq!(
            requested_route_mode("Should I walk or drive there?"),
            Err(())
        );
        assert_eq!(requested_route_mode("Play the Cars album"), Ok(None));
    }

    #[test]
    fn route_modes_must_match_the_configured_provider_mode() {
        assert!(route_mode_matches_configuration(
            RouteMode::Walking,
            RoutesTravelMode::Walk
        ));
        assert!(route_mode_matches_configuration(
            RouteMode::Driving,
            RoutesTravelMode::Drive
        ));
        assert!(route_mode_matches_configuration(
            RouteMode::Cycling,
            RoutesTravelMode::Bicycle
        ));
        assert!(!route_mode_matches_configuration(
            RouteMode::Walking,
            RoutesTravelMode::Drive
        ));
        assert!(!route_mode_matches_configuration(
            RouteMode::Transit,
            RoutesTravelMode::Walk
        ));
    }

    /// The music tool payload is re-sent to the model on every music turn, so
    /// its width is a recurring prompt cost. Ranking provenance was allowed in
    /// as ONE short string; per-track metadata was not, because rank-one
    /// selection is deterministic in Rust and the model never sees the choice.
    ///
    /// The two payloads are built inline inside an `async` method behind a live
    /// `SpotifyService`, so there is no seam to call them from a test. Pin them
    /// against the source instead — and prove the scan found something first,
    /// so a renamed anchor fails loudly rather than passing on an empty set.
    /// The anchors contain escaped quotes here, so this test cannot match its own
    /// source and pass vacuously.
    #[test]
    fn music_tool_payload_gained_only_the_ranking_string() {
        use crate::spotify::SpotifyRankingProvenance;

        const SOURCE: &str = include_str!("orchestration.rs");
        const RANKING_FIELD: &str = "\"ranking\": response.ranking_provenance.as_str(),";
        const TRACK_LIST: &str = "\"tracks\": response.items.into_iter()";
        const ARM_END: &str = "\n                    }),";
        // Fields a music result may put in front of the model. Anything else
        // is prompt budget spent on a decision the model does not make.
        const ALLOWED_TRACK_FIELDS: &[&str] = &[
            "\"rank\"",
            "\"title\"",
            "\"artists\"",
            "\"album\"",
            "\"duration_ms\"",
        ];
        const FORBIDDEN_TRACK_FIELDS: &[&str] = &[
            "popularity",
            "release_date",
            "\"id\"",
            "\"explicit\"",
            "track_number",
            "disc_number",
            "preview_url",
            "\"uri\"",
        ];

        // `music_artist_top_tracks` and `music_catalog_search` — both reach the
        // same provider branch, so both must contain the provenance.
        let mut blocks = Vec::new();
        let mut rest = SOURCE;
        while let Some(start) = rest.find(TRACK_LIST) {
            rest = &rest[start..];
            let end = rest.find(ARM_END).expect("each music arm terminates");
            blocks.push(&rest[..end]);
            rest = &rest[end..];
        }
        assert_eq!(
            blocks.len(),
            2,
            "expected two music payload sites; if this is 0 the anchor rotted and the guard, not the payload, is what changed",
        );
        assert_eq!(
            SOURCE.matches(RANKING_FIELD).count(),
            2,
            "both music payloads must contain ranking provenance into the turn trace",
        );

        for block in &blocks {
            for field in ALLOWED_TRACK_FIELDS {
                assert!(block.contains(field), "music payload lost {field}");
            }
            for field in FORBIDDEN_TRACK_FIELDS {
                assert!(
                    !block.contains(field),
                    "music payload grew a per-track {field}; enrich SpotifyTrack, not the prompt",
                );
            }
        }

        // The whole cost of the change, in bytes on the wire to the model.
        let widest = [
            SpotifyRankingProvenance::ProviderTopTracks,
            SpotifyRankingProvenance::SearchRelevanceFallback,
            SpotifyRankingProvenance::NotRanked,
        ]
        .into_iter()
        .map(|ranking| {
            serde_json::to_string(&serde_json::json!({ "ranking": ranking.as_str() }))
                .expect("provenance serializes")
                .len()
                - "{}".len()
                + ",".len()
        })
        .max()
        .expect("a widest variant exists");
        assert!(
            widest <= 40,
            "ranking provenance must stay a small string, was {widest} bytes",
        );
    }
}
