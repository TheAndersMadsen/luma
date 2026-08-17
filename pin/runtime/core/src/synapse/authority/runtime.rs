//! Shared authority types for the bounded agentic loop.
//!
//! The chat-turn loop (`crate::synapse::chat_turn_loop`) owns loop control. This
//! module keeps the deterministic authority surface shared between that loop,
//! the audited read-tool broker, and the integrating service: device lock
//! state, the request-scoped authorization snapshot, the typed read-tool
//! executor contract, the validated outcome shapes, the device-preflight
//! resume carrier, and the audited rank-one `PlayMusic` argument builder. It
//! deliberately owns no network clients and executes no native action.

use std::error::Error;
use std::fmt;

use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::tier_a::operational_markers;

use super::super::catalog::{
    Confidence, FeatureGate, MusicCatalogKind, NativeActionSpec, ReadToolInvocation,
    ReadToolResultProvenance, WriteToolInvocation,
};

/// Closed, privacy-safe label for one selected chat-turn tool.
///
/// A provider-supplied tool name is untrusted text. It must never cross the
/// physical-proof logging boundary directly: an invented name could contain
/// private text or forge another log field. Callers classify it against the
/// exact static catalog advertised on that model step, preserving the small
/// set of names used by physical acceptance and collapsing every other valid
/// name to one content-free category.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgenticTraceTool {
    Known(&'static str),
    OtherRegistered,
    Invalid,
}

impl AgenticTraceTool {
    pub(crate) fn from_selected(advertised_names: &[&'static str], selected_name: &str) -> Self {
        let Some(registered_name) = advertised_names
            .iter()
            .copied()
            .find(|name| *name == selected_name)
        else {
            return Self::Invalid;
        };
        if AGENTIC_PHYSICAL_KNOWN_TOOLS.contains(&registered_name) {
            Self::Known(registered_name)
        } else {
            Self::OtherRegistered
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Known(name) => name,
            Self::OtherRegistered => "other_registered_tool",
            Self::Invalid => "invalid_tool",
        }
    }
}

/// Closed result vocabulary consumed by the physical evidence parsers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgenticTraceResult {
    Ok,
    Unavailable,
    Invalid,
}

impl AgenticTraceResult {
    /// Classify an observation without inspecting or logging its content.
    ///
    /// `ok=false` deliberately means only "no usable observation". The current
    /// loop outcome does not carry a typed distinction between a provider
    /// outage and invalid arguments, so guessing from an error string would make
    /// the proof less truthful. An unadvertised name is the one structurally
    /// proven invalid case.
    pub(crate) const fn from_observation(tool: AgenticTraceTool, ok: bool) -> Self {
        match (tool, ok) {
            (AgenticTraceTool::Invalid, _) => Self::Invalid,
            (_, true) => Self::Ok,
            (_, false) => Self::Unavailable,
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Unavailable => "unavailable",
            Self::Invalid => "invalid",
        }
    }
}

/// The exact read-tool names whose identity is part of existing physical
/// acceptance. Every other advertised name is still represented, but only as
/// `other_registered_tool`, so adding a new tool cannot leak its model-facing
/// name or disappear from an exact-order proof.
const AGENTIC_PHYSICAL_KNOWN_TOOLS: &[&str] = &[
    "knowledge_lookup",
    "place_search",
    "weather_at_place",
    "current_location",
    "current_weather",
    "reverse_geocode",
    "nearby_search",
    "music_artist_top_tracks",
    "music_catalog_search",
    "current_music",
    "route",
    "food_lookup",
    "memory_search",
];

const AGENTIC_TRACE_MAX_ORDINAL: usize = 128;

fn canonical_trace_correlation(correlation: &str) -> bool {
    Uuid::parse_str(correlation).is_ok_and(|parsed| {
        parsed.get_version_num() == 4 && parsed.hyphenated().to_string() == correlation
    })
}

/// Emit one completed selected-tool event using the canonical physical-proof
/// schema. Only closed/static values cross this boundary; never prompt text,
/// arguments, results, errors, coordinates, or provider details.
pub(crate) fn emit_agentic_tool_trace(
    correlation: &str,
    ordinal: usize,
    tool: AgenticTraceTool,
    result: AgenticTraceResult,
) {
    if !canonical_trace_correlation(correlation)
        || ordinal == 0
        || ordinal > AGENTIC_TRACE_MAX_ORDINAL
    {
        return;
    }
    let tool = tool.label();
    let status = "completed";
    let result_status = result.label();
    tracing::info!(
        correlation = %correlation,
        ordinal,
        tool = %tool,
        status = %status,
        result_status = %result_status,
        "{}",
        operational_markers::AGENTIC_PHYSICAL_TRACE
    );
}

/// Emit the one terminal event for a completed chat-turn outcome.
///
/// A separate function makes omission of `result_status` structural rather
/// than depending on a formatter branch that could accidentally print it.
pub(crate) fn emit_agentic_terminal_trace(correlation: &str, ordinal: usize) {
    if !canonical_trace_correlation(correlation)
        || ordinal == 0
        || ordinal > AGENTIC_TRACE_MAX_ORDINAL
    {
        return;
    }
    let tool = "terminal";
    let status = "completed";
    tracing::info!(
        correlation = %correlation,
        ordinal,
        tool = %tool,
        status = %status,
        "{}",
        operational_markers::AGENTIC_PHYSICAL_TRACE
    );
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DeviceLockState {
    #[default]
    Unknown,
    Locked,
    Unlocked,
}

/// Request-scoped live gates supplied by the caller. The deterministic check
/// lives here, while the integrating service remains responsible for taking
/// one coherent snapshot of device state and feature flags.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgenticAuthorizationContext {
    pub excluded_actions: Vec<String>,
    pub device_lock_state: DeviceLockState,
    pub enabled_feature_gates: Vec<FeatureGate>,
    /// True only when the outer service bound this run to the exact current
    /// stock user turn. Native actions and device preflights may not be
    /// emitted without this authority.
    pub trusted_current_user: bool,
}

impl AgenticAuthorizationContext {
    pub(crate) fn allows(&self, spec: &NativeActionSpec) -> bool {
        if self
            .excluded_actions
            .iter()
            .any(|action| action.eq_ignore_ascii_case(spec.name))
        {
            return false;
        }
        if spec.requires_confirmed_unlock() && self.device_lock_state != DeviceLockState::Unlocked {
            return false;
        }
        spec.feature_gate
            .is_none_or(|required| self.enabled_feature_gates.contains(&required))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AgenticToolRequest<'a> {
    // Populated at every construction to correlate a tool request with its run;
    // carried for tracing/protocol completeness even though no production executor
    // currently reads it.
    #[allow(dead_code)]
    pub call_id: &'a str,
    pub invocation: &'a ReadToolInvocation,
}

#[derive(Clone, Copy, Debug)]
pub struct AgenticWriteRequest<'a> {
    #[allow(dead_code)]
    pub call_id: &'a str,
    pub invocation: &'a WriteToolInvocation,
}

#[tonic::async_trait]
pub trait AgenticToolExecutor: Send + Sync {
    /// Execute one audited read-tool invocation. Implementations must not
    /// execute a native mutation; native actions terminate through the model
    /// protocol and are dispatched by the existing stock action path.
    async fn execute(
        &self,
        request: AgenticToolRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError>;

    /// Execute one audited server-side write (for example, persisting a fact the
    /// user asked to remember). Separate from [`Self::execute`] because a write
    /// is not a read and must never be reachable through the read surface.
    ///
    /// The default refuses: an executor opts in only if it owns a writable
    /// store. The implementation enforces unlock and content grounding; the
    /// dispatcher additionally gates the trusted current user and unlock before
    /// ever calling this. The output is a normal `Result` observation — a write
    /// never returns a device preflight.
    async fn execute_write(
        &self,
        request: AgenticWriteRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        let _ = request;
        Err(AgenticToolError::new(
            "this executor does not support write tools",
        ))
    }

    /// Whether this broker can actually run an open-web search. The tool
    /// catalog is gated on it so a Pin with no search subscription never
    /// advertises a tool whose every call would fail — an advertised-then-
    /// refused tool costs the model a round trip and teaches it nothing.
    /// Defaults to false: a broker that has no provider says so.
    fn web_search_available(&self) -> bool {
        false
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum AgenticToolOutput {
    Result(Value),
    /// A read tool may require one stock device action before it can produce a
    /// result (for example, `current_location` -> `GetCurrentLocation`). The
    /// caller validates the action and returns a server-side resume state.
    ExternalDevicePreflight {
        action: String,
        arguments: Value,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AgenticToolResult {
    pub call_id: String,
    pub tool_name: &'static str,
    pub provenance: ReadToolResultProvenance,
    pub tool: ReadToolInvocation,
    pub result: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeActionRequest {
    pub action: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeActionTerminal {
    pub request: NativeActionRequest,
    pub confidence: Confidence,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalAnswerTerminal {
    pub answer: String,
    pub confidence: Confidence,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclineTerminal {
    pub reason: String,
    pub confidence: Confidence,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExternalDevicePreflight {
    pub request: NativeActionRequest,
    pub resume: AgenticResumeState,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgenticResumeState {
    correlation: String,
    pending: PendingExternalTool,
}

impl AgenticResumeState {
    /// Resume carrier for the chat-turn loop's device preflight.
    ///
    /// The chat-turn loop does not serialize its transcript across the stock
    /// round-trip: on resume it starts a fresh run against the resumed
    /// request, which by then carries the fresh authenticated observation
    /// (`promote_fresh_current_location_observation`). The carrier therefore
    /// only supplies the correlation and pending-action identity that the
    /// resume store validates. A requested correlation is accepted only as an
    /// exact random v4 UUID; anything else is replaced by a fresh one, so a
    /// forged continuation fails the caller's correlation check closed.
    pub(crate) fn for_tool_preflight(
        correlation: &str,
        tool: ReadToolInvocation,
        action: &str,
    ) -> Self {
        let requested = Uuid::parse_str(correlation).ok().and_then(|parsed| {
            (parsed.get_version_num() == 4 && parsed.hyphenated().to_string() == correlation)
                .then(|| correlation.to_string())
        });
        Self {
            correlation: requested.unwrap_or_else(|| Uuid::new_v4().hyphenated().to_string()),
            pending: PendingExternalTool {
                tool,
                action: action.to_string(),
            },
        }
    }

    pub fn expected_action(&self) -> &str {
        &self.pending.action
    }

    pub fn trace_correlation(&self) -> &str {
        &self.correlation
    }
}

#[derive(Clone, Debug, PartialEq)]
struct PendingExternalTool {
    tool: ReadToolInvocation,
    action: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SafeFailureReason {
    InvalidResumeObservation,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AgenticRuntimeOutcome {
    NativeAction(NativeActionTerminal),
    FinalAnswer(FinalAnswerTerminal),
    Decline(DeclineTerminal),
    // Boxed: `ExternalDevicePreflight` carries the resume carrier and the
    // staged action request, dwarfing the other variants. Boxing keeps the
    // common terminal outcomes (FinalAnswer/Decline) cheap to move and clone.
    ExternalDevicePreflight(Box<ExternalDevicePreflight>),
    SafeFailure(SafeFailureReason),
}

/// Build validated `PlayMusic` arguments from one trusted rank-one music
/// provider result. The chat-turn tool loop's `play_music` mutation resolves its
/// cited result through this single audited selection path.
pub(crate) fn rank_one_play_music_arguments(result: &AgenticToolResult) -> Option<Value> {
    if result.provenance != ReadToolResultProvenance::TrustedProviderResult
        || result.result.get("status").and_then(Value::as_str) != Some("ok")
    {
        return None;
    }
    let rank_one = unique_rank_one_track(&result.result)?;
    let track = rank_one.get("title")?.as_str()?;
    let artists = rank_one.get("artists")?.as_array()?;
    let primary_artist = artists.first()?.as_str()?;
    if track.trim().is_empty() || primary_artist.trim().is_empty() {
        return None;
    }
    let requested_artist = match &result.tool {
        ReadToolInvocation::MusicArtistTopTracks(arguments) => Some(arguments.artist.as_str()),
        ReadToolInvocation::MusicCatalogSearch(arguments)
            if arguments.kind == Some(MusicCatalogKind::Artist) =>
        {
            Some(arguments.query.as_str())
        }
        ReadToolInvocation::MusicCatalogSearch(_) => None,
        _ => return None,
    };
    let mut arguments = serde_json::Map::from_iter([
        ("Track".to_string(), Value::String(track.to_string())),
        (
            "Artist".to_string(),
            Value::String(requested_artist.unwrap_or(primary_artist).to_string()),
        ),
    ]);
    if let Some(album) = rank_one
        .get("album")
        .and_then(Value::as_str)
        .filter(|album| !album.trim().is_empty())
    {
        arguments.insert("Album".to_string(), Value::String(album.to_string()));
    }
    rank_one_music_selection_matches(result, &arguments).then_some(Value::Object(arguments))
}

fn rank_one_music_selection_matches(
    result: &AgenticToolResult,
    arguments: &serde_json::Map<String, Value>,
) -> bool {
    if !arguments
        .keys()
        .all(|key| matches!(key.as_str(), "Track" | "Artist" | "Album"))
        || !arguments.contains_key("Track")
        || !arguments.contains_key("Artist")
        || result.result.get("status").and_then(Value::as_str) != Some("ok")
        || result.provenance != ReadToolResultProvenance::TrustedProviderResult
    {
        return false;
    }

    let requested_artist = match &result.tool {
        ReadToolInvocation::MusicArtistTopTracks(invocation) => {
            if result.tool_name != "music_artist_top_tracks"
                || !text_equivalent(
                    result.result.get("artist").and_then(Value::as_str),
                    Some(invocation.artist.as_str()),
                )
            {
                tracing::info!(
                    reason = "top_tracks_artist_echo",
                    "<<< rank-one selection refused"
                );
                return false;
            }
            Some(invocation.artist.as_str())
        }
        ReadToolInvocation::MusicCatalogSearch(invocation) => {
            if result.tool_name != "music_catalog_search"
                || result.result.get("query").and_then(Value::as_str)
                    != Some(invocation.query.as_str())
            {
                tracing::info!(
                    reason = "catalog_query_echo",
                    "<<< rank-one selection refused"
                );
                return false;
            }
            (invocation.kind == Some(MusicCatalogKind::Artist)).then_some(invocation.query.as_str())
        }
        _ => return false,
    };

    let Some(rank_one) = unique_rank_one_track(&result.result) else {
        tracing::info!(
            reason = "no_unique_rank_one",
            "<<< rank-one selection refused"
        );
        return false;
    };

    let Some(title) = rank_one.get("title").and_then(Value::as_str) else {
        tracing::info!(reason = "missing_title", "<<< rank-one selection refused");
        return false;
    };
    let Some(artists) = rank_one.get("artists").and_then(Value::as_array) else {
        return false;
    };
    let primary_artist = artists.first().and_then(Value::as_str);
    // Split per condition. A single collapsed label named four different
    // failures identically, and a hypothesis was substituted for the missing
    // measurement twice. Control flow is unchanged; only the reason is precise.
    let refusal = if title.trim().is_empty() {
        Some("empty_title")
    } else if artists.is_empty()
        || !artists.iter().all(|artist| {
            artist
                .as_str()
                .is_some_and(|artist| !artist.trim().is_empty())
        })
    {
        Some("empty_artists")
    } else if
    // For `music_artist_top_tracks` the provider was ASKED for this
    // artist's top tracks and echoed the artist back, and that echo is
    // verified above. Requiring the individual track to also credit them is
    // a second, redundant check that fails on real catalog data: measured on
    // device, the rank-one track listed four artists and none matched, so
    // every artist-scoped result was refused (top_tracks_refused=3,
    // ungrounded=0) and playback never completed.
    //
    // It stays enforced for `music_catalog_search`, where a generic query
    // can return anything and the track-level credit is the only thing
    // tying the result to what the user asked for.
    !matches!(&result.tool, ReadToolInvocation::MusicArtistTopTracks(_))
        && requested_artist.is_some_and(|requested_artist| {
            let satisfied = artists
                .iter()
                .any(|artist| artist_satisfies_request(artist.as_str(), requested_artist));
            if !satisfied {
                // Bounded shape only, never artist or query text. The branch name
                // alone could not say WHICH side fails: whether the track lists no
                // artists, whether the request is a bare name or a whole phrase, or
                // whether containment fails in one direction only. Guessing between
                // those has already cost several release cycles.
                let requested_words = requested_artist.split_whitespace().count();
                let reverse_hit = artists.iter().any(|artist| {
                    artist.as_str().is_some_and(|artist| {
                        artist_satisfies_request(Some(requested_artist), artist)
                    })
                });
                tracing::info!(
                    artists_listed = artists.len(),
                    requested_words,
                    reverse_containment = reverse_hit,
                    "<<< requested artist did not match any track artist"
                );
            }
            !satisfied
        })
    {
        Some("requested_artist_not_in_track_artists")
    } else if arguments.get("Track").and_then(Value::as_str) != Some(title) {
        Some("track_arg_mismatch")
    } else if !text_equivalent(
        arguments.get("Artist").and_then(Value::as_str),
        requested_artist.or(primary_artist),
    ) {
        Some("artist_arg_mismatch")
    } else {
        None
    };
    if let Some(reason) = refusal {
        tracing::info!(reason, "<<< rank-one selection refused");
        return false;
    }

    match arguments.get("Album") {
        None => true,
        Some(album) => {
            let matched = text_equivalent(
                album.as_str(),
                rank_one.get("album").and_then(Value::as_str),
            );
            if !matched {
                tracing::info!(reason = "album_mismatch", "<<< rank-one selection refused");
            }
            matched
        }
    }
}

/// Compare two catalog texts for equivalence, ignoring case and punctuation.
///
/// Punctuation insensitivity is required, not cosmetic: providers return
/// "Dr. Dre" while a model searches "Dr Dre", and a lowercase-and-trim
/// comparison rejects that pair on one period. Measured on device as
/// `reason="track_or_artist_mismatch"` refusing every otherwise-valid result,
/// so playback could never complete.
///
/// This does not weaken the check. Both sides must still contain the same
/// words in the same order; only separators are ignored, so "Dr Dre" still
/// does not match "Snoop Dogg".
/// Does `artist` (from the provider result) satisfy what the user requested?
///
/// `requested` is the SEARCH TARGET, which for a catalog search is the whole
/// query — "dr dre most popular song" — not an artist name. Requiring exact
/// equivalence against the track's artist therefore never matched, and blocked
/// playback entirely. Measured on device as
/// `reason="requested_artist_not_in_track_artists"` on every result.
///
/// The artist must still be named by the request: it is accepted only when it
/// appears as a word-bounded span of the requested text, so a track by an
/// artist the user never mentioned is still refused.
fn artist_satisfies_request(artist: Option<&str>, requested: &str) -> bool {
    if text_equivalent(artist, Some(requested)) {
        return true;
    }
    let (Some(artist), false) = (artist, requested.trim().is_empty()) else {
        return false;
    };
    let comparable = |value: &str| {
        let mut out = String::with_capacity(value.len());
        for character in value.to_lowercase().chars() {
            if character.is_alphanumeric() {
                out.push(character);
            } else if !out.ends_with(' ') {
                out.push(' ');
            }
        }
        out.trim().to_string()
    };
    let artist = comparable(artist);
    let requested = comparable(requested);
    if artist.is_empty() || requested.is_empty() {
        return false;
    }
    format!(" {requested} ").contains(&format!(" {artist} "))
}

fn text_equivalent(left: Option<&str>, right: Option<&str>) -> bool {
    fn comparable(value: &str) -> String {
        let mut normalized = String::with_capacity(value.len());
        for character in value.to_lowercase().chars() {
            if character.is_alphanumeric() {
                normalized.push(character);
            } else if !normalized.ends_with(' ') {
                normalized.push(' ');
            }
        }
        normalized.trim().to_string()
    }
    match (left, right) {
        (Some(left), Some(right)) if !left.trim().is_empty() && !right.trim().is_empty() => {
            comparable(left) == comparable(right)
        }
        _ => false,
    }
}

fn unique_rank_one_track(result: &Value) -> Option<&Value> {
    let mut matches = result
        .get("tracks")?
        .as_array()?
        .iter()
        .filter(|track| track.get("rank").and_then(Value::as_u64) == Some(1));
    let rank_one = matches.next()?;
    matches.next().is_none().then_some(rank_one)
}

/// A broker rejection reason. The message is `&'static str` by design: it is
/// logged verbatim into the content-free tool trace and forwarded to the model
/// observation, so it must never carry user content. A `&'static str` cannot
/// embed a runtime query or coordinate, enforcing that at compile time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgenticToolError {
    message: &'static str,
}

impl AgenticToolError {
    pub fn new(message: &'static str) -> Self {
        Self { message }
    }
}

impl fmt::Display for AgenticToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for AgenticToolError {}

#[cfg(test)]
mod physical_trace_tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    struct SharedWriterGuard(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriterGuard {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("trace writer lock").extend(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for SharedWriter {
        type Writer = SharedWriterGuard;

        fn make_writer(&'writer self) -> Self::Writer {
            SharedWriterGuard(Arc::clone(&self.0))
        }
    }

    fn capture_trace(run: impl FnOnce()) -> String {
        let writer = SharedWriter::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(writer.clone())
            .with_ansi(false)
            .without_time()
            .compact()
            .with_target(true)
            .finish();
        tracing::subscriber::with_default(subscriber, run);
        let bytes = writer.0.lock().expect("trace bytes lock").clone();
        String::from_utf8(bytes).expect("trace output is UTF-8")
    }

    #[test]
    fn selected_tool_names_are_closed_before_they_reach_the_trace() {
        let advertised = ["knowledge_lookup", "web_search"];
        assert_eq!(
            AgenticTraceTool::from_selected(&advertised, "knowledge_lookup"),
            AgenticTraceTool::Known("knowledge_lookup")
        );
        assert_eq!(
            AgenticTraceTool::from_selected(&advertised, "web_search"),
            AgenticTraceTool::OtherRegistered
        );
        assert_eq!(
            AgenticTraceTool::from_selected(&advertised, "private_text_from_model"),
            AgenticTraceTool::Invalid
        );
    }

    #[test]
    fn physical_trace_format_matches_the_strict_consumer_schema() {
        const CORRELATION: &str = "223e4567-e89b-42d3-a456-426614174000";
        let output = capture_trace(|| {
            emit_agentic_tool_trace(
                CORRELATION,
                1,
                AgenticTraceTool::Known("knowledge_lookup"),
                AgenticTraceResult::Ok,
            );
            emit_agentic_tool_trace(
                CORRELATION,
                2,
                AgenticTraceTool::OtherRegistered,
                AgenticTraceResult::Unavailable,
            );
            emit_agentic_tool_trace(
                CORRELATION,
                3,
                AgenticTraceTool::Invalid,
                AgenticTraceResult::Invalid,
            );
            emit_agentic_terminal_trace(CORRELATION, 4);
        });
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(
            lines,
            [
                " INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=223e4567-e89b-42d3-a456-426614174000 ordinal=1 tool=knowledge_lookup status=completed result_status=ok",
                " INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=223e4567-e89b-42d3-a456-426614174000 ordinal=2 tool=other_registered_tool status=completed result_status=unavailable",
                " INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=223e4567-e89b-42d3-a456-426614174000 ordinal=3 tool=invalid_tool status=completed result_status=invalid",
                " INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=223e4567-e89b-42d3-a456-426614174000 ordinal=4 tool=terminal status=completed",
            ]
        );
        assert!(
            !lines[3].contains("result_status"),
            "terminal result_status must be structurally absent"
        );
    }

    #[test]
    fn malformed_proof_identity_is_suppressed_instead_of_logged() {
        let output = capture_trace(|| {
            emit_agentic_terminal_trace("not-a-runtime-correlation", 1);
            emit_agentic_terminal_trace("223E4567-E89B-42D3-A456-426614174000", 1);
            emit_agentic_terminal_trace("223e4567-e89b-42d3-a456-426614174000", 0);
            emit_agentic_terminal_trace("223e4567-e89b-42d3-a456-426614174000", 129);
        });
        assert!(output.is_empty());
    }
}

#[cfg(test)]
mod text_equivalent_tests {
    use super::text_equivalent;

    #[test]
    fn punctuation_differences_do_not_break_catalog_matching() {
        // Measured on device: every rank-one selection was refused with
        // reason="track_or_artist_mismatch" because the provider returns
        // "Dr. Dre" while the model searches "Dr Dre". One period blocked
        // playback entirely.
        assert!(text_equivalent(Some("Dr. Dre"), Some("Dr Dre")));
        assert!(text_equivalent(Some("dr dre"), Some("Dr. Dre")));
        assert!(text_equivalent(Some("AC/DC"), Some("AC DC")));
        // Known limitation, asserted so it is not mistaken for a bug later:
        // punctuation becomes a SEPARATOR, so an internal acronym does not
        // collapse. "Still D.R.E." -> "still d r e", not "still dre". The
        // artist case works because "Dr. Dre" already has a space after the
        // period. Collapsing acronyms would need a separate rule.
        assert!(!text_equivalent(Some("Still D.R.E."), Some("Still DRE")));
        assert!(text_equivalent(Some("Still D.R.E."), Some("Still D R E")));

        // Separators are ignored; content is not. Different words still refuse.
        assert!(!text_equivalent(Some("Dr. Dre"), Some("Snoop Dogg")));
        assert!(!text_equivalent(Some("Dr. Dre"), Some("Dre")));
        assert!(!text_equivalent(Some(""), Some("Dr. Dre")));
        assert!(!text_equivalent(None, Some("Dr. Dre")));
    }
}

#[cfg(test)]
mod artist_request_tests {
    use super::artist_satisfies_request;

    #[test]
    fn an_artist_named_in_the_request_satisfies_it_but_a_stranger_does_not() {
        // Measured on device: every rank-one selection was refused with
        // reason="requested_artist_not_in_track_artists" because the search
        // target is the whole query, not an artist name.
        assert!(artist_satisfies_request(
            Some("Dr. Dre"),
            "dr dre most popular song"
        ));
        assert!(artist_satisfies_request(
            Some("Dr Dre"),
            "Dr. Dre's most popular song"
        ));
        assert!(artist_satisfies_request(Some("Prince"), "prince"));

        // The artist must still be NAMED by the request. A track by someone the
        // user never mentioned is refused, which is the whole point of the gate.
        assert!(!artist_satisfies_request(
            Some("Snoop Dogg"),
            "dr dre most popular song"
        ));
        assert!(!artist_satisfies_request(
            Some("Eminem"),
            "dr dre greatest hits"
        ));
        assert!(!artist_satisfies_request(None, "dr dre"));
        assert!(!artist_satisfies_request(Some("Dr. Dre"), ""));
        // Word-bounded, so a name that merely overlaps is refused.
        assert!(!artist_satisfies_request(
            Some("Drexler"),
            "dr dre most popular song"
        ));
    }
}

#[cfg(test)]
mod top_tracks_credit_tests {
    use super::*;
    use serde_json::json;

    fn top_tracks_result(artist: &str, track_artists: Vec<&str>) -> AgenticToolResult {
        AgenticToolResult {
            call_id: "c1".into(),
            tool_name: "music_artist_top_tracks",
            provenance: ReadToolResultProvenance::TrustedProviderResult,
            tool: ReadToolInvocation::MusicArtistTopTracks(
                crate::synapse::catalog::MusicArtistTopTracksArguments {
                    artist: artist.to_string(),
                    limit: None,
                },
            ),
            result: json!({
                "status": "ok",
                "artist": artist,
                "tracks": [{"rank": 1, "title": "Some Track", "artists": track_artists}],
            }),
        }
    }

    #[test]
    fn an_artist_scoped_top_track_plays_even_when_the_track_credits_others() {
        // Measured on device: top_tracks_refused=3, ungrounded=0 — every
        // artist-scoped result was refused because the rank-one track listed
        // four collaborators and not the requested artist. The provider was
        // asked for THIS artist's top tracks and echoed the artist back, so
        // that echo is the scoping guarantee; the track-level credit is not.
        let collaborators = top_tracks_result("Dr. Dre", vec!["Snoop Dogg", "Kurupt", "Nate Dogg"]);
        assert!(
            rank_one_play_music_arguments(&collaborators).is_some(),
            "an artist-scoped top track must play even without a track-level credit"
        );

        // The echo itself is still verified: a result claiming a different
        // artist than was requested is refused.
        let mut mismatched = top_tracks_result("Dr. Dre", vec!["Dr. Dre"]);
        mismatched.result["artist"] = json!("Snoop Dogg");
        assert!(
            rank_one_play_music_arguments(&mismatched).is_none(),
            "a result whose echoed artist differs from the request must be refused"
        );
    }
}
