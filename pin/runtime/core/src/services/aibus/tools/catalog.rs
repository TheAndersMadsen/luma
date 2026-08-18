//! The Pin's concrete tool catalog for the chat-turn loop.
//!
//! Maps native function-calling tool calls (free-form JSON arguments) onto the
//! existing audited read executors and native-action validation. This is the
//! boundary where chat-turn-style tolerance meets the device product contract:
//!
//! - Read tools deserialize plain JSON arguments into the same typed
//!   `ReadToolInvocation` structures the broker has always executed, with a
//!   chat-turn-style drift-coercion pre-pass. A read failure becomes a
//!   `[TOOL_ERROR]` observation, never a run failure.
//! - Privacy-relevant reads still enforce unlock requirements at execution
//!   time; a gated call returns an explanatory failed observation so the model
//!   can self-correct. `required_user_terms` is NOT enforced here and never
//!   has been — see `read_gate_error`, which documents why lexical anchors
//!   cannot gate a model that chooses reads from observations. Query grounding
//!   is enforced instead, per-tool, in the broker.
//! - The `play_music` mutation never takes free text: its only argument is
//!   the `call_id` of a successful same-run music provider read, resolved to
//!   rank-one arguments by the shared audited builder
//!   (`rank_one_play_music_arguments`) and validated against the native
//!   action catalog and current authorization before terminating the loop.
//! - Progress cues are derived from registered tool names only (never
//!   arguments or results), using the privacy-safe closed vocabulary.

use std::sync::Mutex;

use serde_json::{json, Value};

use super::authority::*;
use crate::llm::tool_step::{ToolStepCall, ToolStepDefinition, MAX_TOOL_STEP_RESULT_BYTES};
use crate::synapse::authority::runtime::{
    rank_one_play_music_arguments, AgenticAuthorizationContext, AgenticToolExecutor,
    AgenticToolOutput, AgenticToolRequest, AgenticToolResult, AgenticWriteRequest, DeviceLockState,
};
use crate::synapse::catalog::{
    classify_fieldless_music_grounding, native_action_spec,
    read_tool_name_requires_confirmed_unlock, read_tool_spec, validate_native_action_arguments,
    write_tool_name_requires_confirmed_unlock, FieldlessMusicGrounding, ReadToolInvocation,
    WriteToolInvocation,
};
use crate::synapse::chat_turn_loop::{ToolCatalog, ToolExecutionOutcome, ValidatedNativeAction};
use crate::tier_a::{native_actions, operational_markers};

/// One registered read tool: schema + cue phrase + typed constructor.
struct AdvertisedReadTool {
    name: &'static str,
    description: &'static str,
    parameters: fn() -> Value,
    cue: &'static str,
    build: fn(Value) -> Result<ReadToolInvocation, String>,
}

fn args<T: serde::de::DeserializeOwned>(raw: Value) -> Result<T, String> {
    // Raw first: never let drift repair touch an already-valid argument object.
    // `coerce_scalar` rewrites numeric-looking strings ("1999", "42") into JSON
    // numbers, which then fail to deserialize into a `String` field — turning a
    // correct model call (e.g. a knowledge query "1984") into a [TOOL_ERROR].
    // Coercion is a fallback only, and on total failure the original error is
    // reported so the model sees an accurate diagnosis.
    match serde_json::from_value::<T>(raw.clone()) {
        Ok(value) => Ok(value),
        Err(raw_error) => {
            serde_json::from_value::<T>(coerce_arguments(raw)).map_err(|_| raw_error.to_string())
        }
    }
}

/// the chat-turn loop-style argument drift repair: models sometimes emit the arguments
/// object as a JSON-encoded string, numbers as strings, or booleans as
/// strings. Repair the common shapes instead of failing the call.
fn coerce_arguments(raw: Value) -> Value {
    match raw {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with('{') {
                serde_json::from_str(trimmed).unwrap_or(Value::String(text))
            } else {
                Value::String(text)
            }
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, coerce_scalar(value)))
                .collect(),
        ),
        other => other,
    }
}

fn coerce_scalar(value: Value) -> Value {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if let Ok(number) = trimmed.parse::<i64>() {
                Value::Number(number.into())
            } else if let Ok(number) = trimmed.parse::<f64>() {
                serde_json::Number::from_f64(number)
                    .map(Value::Number)
                    .unwrap_or(Value::String(text))
            } else if trimmed.eq_ignore_ascii_case("true") {
                Value::Bool(true)
            } else if trimmed.eq_ignore_ascii_case("false") {
                Value::Bool(false)
            } else {
                Value::String(text)
            }
        }
        other => other,
    }
}

fn string_schema(properties: &[(&str, &str, bool)]) -> Value {
    let mut props = serde_json::Map::new();
    let mut required = Vec::new();
    for (name, description, is_required) in properties {
        props.insert(
            (*name).to_string(),
            json!({"type": "string", "description": description}),
        );
        if *is_required {
            required.push(Value::String((*name).to_string()));
        }
    }
    json!({"type": "object", "properties": Value::Object(props), "required": required})
}

/// The registered read tools, in stable catalog order. Descriptions follow the
/// tool-calling style: purpose first, then when to use it.
/// Tools that gather LIVE device-scoped facts, i.e. the evidence the freshness
/// obligation is actually about. Static-knowledge tools (knowledge_lookup,
/// memory_search, food_lookup) are deliberately excluded: attempting one says
/// nothing about whether the model looked up the live fact it was asked for.
/// Which kind of fresh evidence an utterance owes. Kept separate because the
/// tool that discharges one family must not discharge the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LiveEvidenceFamily {
    /// Answerable only from device-scoped reads (location, weather, playback).
    DeviceScoped,
    /// Answerable only from the open web (news, results, prices, hours).
    CurrentEvents,
}

fn is_live_fact_tool(name: &str) -> bool {
    matches!(
        name,
        "current_location"
            | "current_weather"
            | "weather_at_place"
            | "place_search"
            | "reverse_geocode"
            | "nearby_search"
            | "route"
            | "current_music"
            | "music_catalog_search"
            | "music_artist_top_tracks"
    )
}

fn read_specs() -> &'static [AdvertisedReadTool] {
    const SPECS: &[AdvertisedReadTool] = &[
        AdvertisedReadTool {
            name: "knowledge_lookup",
            description: "Looks up a public fact or topic in an encyclopedia and returns the article. Use it for any general-knowledge question, and whenever the user asks to look something up — including when they want a single detail such as a height, an author or a population: the article carries those, so look up the subject and read the detail out of the result. Pass the subject alone, in the user's own words: for \"who wrote Pride and Prejudice\" the query is \"Pride and Prejudice\". Keep every word one the user actually said, and leave the question word out.",
            parameters: || string_schema(&[(
                "query",
                "the subject itself, in the user's own words. Not a question, and no added words such as author/height/population — the article supplies those",
                true,
            )]),
            cue: "Looking up facts",
            build: |raw| Ok(ReadToolInvocation::KnowledgeLookup(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "web_search",
            description: "Searches the open web and returns a few result snippets. Use it for anything current, local or not encyclopedic — news, events, results, prices, opening hours, releases, \"what happened\", \"latest\" — and whenever knowledge_lookup found nothing; for a settled fact about one well-known person, place or thing prefer knowledge_lookup. Build the query from the words the user already said: drop filler and reorder them freely, and keep every remaining term one they used, since an added term, place or year is refused.",
            parameters: || string_schema(&[(
                "query",
                "what to search for, using only words from the user's own request",
                true,
            )]),
            cue: "Searching the web",
            build: |raw| Ok(ReadToolInvocation::WebSearch(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "place_search",
            description: "Resolve a public place name to a location. Use after a knowledge lookup identifies a place, or when the user names a specific place.",
            parameters: || string_schema(&[
                ("query", "the place name to resolve", true),
                ("context", "optional disambiguation context such as a country or region", false),
            ]),
            cue: "Finding places",
            build: |raw| Ok(ReadToolInvocation::PlaceSearch(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "weather_at_place",
            description: "Reports the weather happening right now at a place you already resolved. Use it after place_search, passing that result's location, latitude and longitude. It covers present conditions only; for tomorrow, tonight or any future day, say the forecast is unavailable.",
            parameters: || json!({
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "the resolved place label"},
                    "latitude": {"type": "number"},
                    "longitude": {"type": "number"}
                },
                "required": ["location", "latitude", "longitude"]
            }),
            cue: "Checking the forecast",
            build: |raw| Ok(ReadToolInvocation::WeatherAtPlace(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "current_location",
            description: "Get the device's current location. Use when the user asks about here/nearby/their own location or weather.",
            parameters: || json!({"type": "object", "properties": {}}),
            cue: "Checking location",
            build: |raw| Ok(ReadToolInvocation::CurrentLocation(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "current_weather",
            description: "Reports the weather happening right now at the device's own location. Use it for the weather here, or what to wear today. It covers present conditions only; for tomorrow, tonight or any future day, say the forecast is unavailable.",
            parameters: || json!({"type": "object", "properties": {}}),
            cue: "Checking the forecast",
            build: |raw| Ok(ReadToolInvocation::CurrentWeather(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "reverse_geocode",
            description: "Turn coordinates into a place label. Use after current_location when the user asks where they are.",
            parameters: || json!({
                "type": "object",
                "properties": {
                    "latitude": {"type": "number"},
                    "longitude": {"type": "number"}
                },
                "required": ["latitude", "longitude"]
            }),
            cue: "Checking location",
            build: |raw| Ok(ReadToolInvocation::ReverseGeocode(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "nearby_search",
            description: "Find nearby places. Use for 'nearest' or 'nearby' requests. Give `query` ONLY when the user named a kind of place, quoting their words; for a bare 'what's nearby' omit it entirely and anything nearby is returned.",
            parameters: || string_schema(&[(
                "query",
                "optional: the kind of place, in the user's own words. Omit when they named no kind",
                false,
            )]),
            cue: "Finding nearby places",
            build: |raw| Ok(ReadToolInvocation::NearbySearch(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "route",
            description: "Get a route from the device's current position to a destination. Routes always start at the device. Use after nearby_search or place_search when the user wants directions or navigation.",
            parameters: || string_schema(&[
                ("origin", "must be 'current location' (routes always start at the device)", true),
                ("destination", "the destination", true),
                ("mode", "optional travel mode: walking, driving or cycling (transit is not supported)", false),
            ]),
            cue: "Finding directions",
            build: |raw| Ok(ReadToolInvocation::Route(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "music_artist_top_tracks",
            description: "Returns an artist's most popular tracks from the music provider. Use it for 'best/top/most popular song by X', and as the first step whenever the user asks to play one — then cite this call's id in play_music.",
            parameters: || string_schema(&[("artist", "the artist name", true)]),
            cue: "Finding songs",
            build: |raw| Ok(ReadToolInvocation::MusicArtistTopTracks(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "music_catalog_search",
            description: "Searches the music catalog for a track, album, artist or playlist. Use it as the first step whenever the user asks to play specific music — then cite this call's id in play_music.",
            parameters: || string_schema(&[
                ("query", "what to search for", true),
                ("kind", "optional kind: track, album, artist or playlist", false),
            ]),
            cue: "Finding songs",
            build: |raw| Ok(ReadToolInvocation::MusicCatalogSearch(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "current_music",
            description: "Get the currently playing track. Use for questions about what is playing right now.",
            parameters: || json!({"type": "object", "properties": {}}),
            cue: "Checking the music",
            build: |raw| Ok(ReadToolInvocation::CurrentMusic(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "memory_search",
            description: "Search the user's saved memories. Use when the user refers to something they asked to remember.",
            parameters: || string_schema(&[("query", "what to search memories for", true)]),
            cue: "Checking memories",
            build: |raw| Ok(ReadToolInvocation::MemorySearch(args(raw)?)),
        },
        AdvertisedReadTool {
            name: "food_lookup",
            description: "Look up nutrition facts for a food item.",
            parameters: || string_schema(&[("query", "the food to look up", true)]),
            cue: "Checking nutrition",
            build: |raw| Ok(ReadToolInvocation::FoodLookup(args(raw)?)),
        },
    ];
    SPECS
}

/// Reads that can safely share one bounded concurrent batch.
///
/// This is an explicit allowlist, not "everything in read_specs": location
/// resolution has real dependency chains. `weather_at_place` follows
/// `place_search`, `reverse_geocode` follows `current_location`, and `route`
/// can follow a place result, so all three remain serial. `current_location`
/// may return a resumable stock preflight rather than an observation. Every
/// future tool therefore starts serial until its independence is proven.
fn is_parallel_read_tool(name: &str) -> bool {
    matches!(
        name,
        "knowledge_lookup"
            | "web_search"
            | "place_search"
            | "current_weather"
            | "nearby_search"
            | "music_artist_top_tracks"
            | "music_catalog_search"
            | "current_music"
            | "memory_search"
            | "food_lookup"
    )
}

/// One registered write tool: schema + typed constructor. A parallel of
/// [`AdvertisedReadTool`] with no cue (a write is instant and speaks through its
/// observation, not a progress cue) and a [`WriteToolInvocation`] constructor.
struct AdvertisedWriteTool {
    name: &'static str,
    description: &'static str,
    parameters: fn() -> Value,
    build: fn(Value) -> Result<WriteToolInvocation, String>,
}

/// The registered server-side write tools. Kept apart from `read_specs` and
/// `mutation_specs`: a write is neither a read nor a stock native action. Each
/// entry dispatches to the broker's `execute_write` and returns an observation.
fn write_specs() -> &'static [AdvertisedWriteTool] {
    const SPECS: &[AdvertisedWriteTool] = &[AdvertisedWriteTool {
        name: "remember_fact",
        description: "Saves a fact for later turns, so the user can be told it back another day. Call it whenever they ask you to remember, note, keep in mind, or not forget something (\"remember that…\", \"note that…\", \"keep in mind…\", \"don't forget…\"). content is the fact itself in their own words, quoted from what they just said: every significant word must be one they used this turn, so a summary, an inference, or something you noticed yourself is refused. Use it only when they asked you to remember something.",
        parameters: || {
            string_schema(&[
                (
                    "content",
                    "the fact to remember, in the user's own words — not a paraphrase",
                    true,
                ),
                (
                    "kind",
                    "optional category: preference, fact, project, instruction, relationship, or other",
                    false,
                ),
            ])
        },
        build: |raw| Ok(WriteToolInvocation::RememberFact(args(raw)?)),
    }];
    SPECS
}

fn write_tool_spec(name: &str) -> Option<&'static AdvertisedWriteTool> {
    write_specs().iter().find(|spec| spec.name == name)
}

const PLAY_MUSIC_TOOL: &str = "play_music";

/// A model-callable action that *does* something, as opposed to a read.
///
/// Until now `play_music` was the only one, so the engine could speak and play
/// music and nothing else: every other capability lived behind hard-coded
/// phrase lists in the deterministic fast path, and a request phrased one word
/// differently fell through to a model with no matching tool. This table is how
/// an action becomes reachable by understanding rather than by exact match.
///
/// Safety comes from the shared executor, not from each entry: every dispatch
/// goes through the catalog's argument validation, the authorization context,
/// and `enforce_mutation_grounding` — so a model may choose *which* action fits
/// and *which* span fills each field, but cannot manufacture either.
pub(super) struct AdvertisedMutationTool {
    /// Model-facing tool name.
    name: &'static str,
    /// Stock native action it dispatches.
    ///
    /// Load-bearing, and the reason this table cannot host every side effect:
    /// a `Terminal` from here is handed back to the device as a stock action
    /// (`understand.rs` -> `SynapseUnderstandingResponse::action_response`) and
    /// the server never executes it. So an entry is only real if the FIRMWARE
    /// implements the action. A side effect that lives on the server — a write
    /// to `MemoryService`, say — has no action name it could put here, and
    /// naming one the firmware does not handle yields a silent no-op that the
    /// model still reports as done. Server-side side effects belong on the
    /// broker (`AgenticToolExecutor`), next to `memory_search`, where they can
    /// return a real observation.
    pub(super) action: &'static str,
    description: &'static str,
    parameters: fn() -> serde_json::Value,
    /// Shape the model's arguments into the catalog's argument names.
    build: fn(&serde_json::Value) -> serde_json::Value,
}

fn mutation_specs() -> &'static [AdvertisedMutationTool] {
    &[
        // Fallback tools for device control and immediate device facts.
        //
        // The deterministic planners still run FIRST and still own these
        // actions: `native_device_actions.rs` and `music.rs` match exact
        // phrasings pre-agentic, in ~100ms, and never reach the model. These
        // tools exist only for the phrasings those tables miss.
        //
        // Without them a missed phrase is SILENCE. "Turn the volume up a bit"
        // is not in the volume grammar, and with no tool the model could only
        // describe the action while nothing happened — the same unreachable
        // shape that hid GenerateMusicPlaylist. Every one of these still passes
        // the native action catalog, the authorization gate, and lock state
        // before dispatch; exposure widens what can be REACHED, not what is
        // permitted.
        AdvertisedMutationTool {
            name: "increment_volume",
            action: native_actions::INCREMENT_VOLUME,
            description: "Turn the device volume UP one step. Use for any relative increase ('louder', 'turn it up a bit') where the user gave no number. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "decrement_volume",
            action: native_actions::DECREMENT_VOLUME,
            description: "Turn the device volume DOWN one step. Use for any relative decrease ('quieter', 'turn it down'). Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "set_volume",
            action: native_actions::SET_VOLUME,
            description: "Sets the device volume to an exact level, 0-100. Use it when the user said a number; 'louder' or 'quieter' with no number goes to increment_volume or decrement_volume.",
            parameters: || {
                json!({
                    "type": "object",
                    "properties": {
                        "level": {
                            "type": "integer",
                            "description": "the volume the user said, 0-100"
                        }
                    },
                    "required": ["level"]
                })
            },
            build: |args| {
                let mut out = serde_json::Map::new();
                if let Some(level) = args.get("level").and_then(serde_json::Value::as_i64) {
                    out.insert("level".to_string(), json!(level));
                }
                serde_json::Value::Object(out)
            },
        },
        AdvertisedMutationTool {
            name: "get_current_volume",
            action: native_actions::GET_CURRENT_VOLUME,
            description: "Report the current device volume. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "pause_music",
            action: native_actions::PAUSE_MUSIC,
            description: "Pause playback that is currently playing. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "resume_music",
            action: native_actions::RESUME_MUSIC,
            description: "Resume playback that is paused. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "next_track",
            action: native_actions::NEXT_TRACK,
            description: "Skip to the next track. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "previous_track",
            action: native_actions::PREVIOUS_TRACK,
            description: "Go back to the previous track. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "restart_track",
            action: native_actions::RESTART_TRACK,
            description: "Restart the current track from the beginning. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "save_current_track_to_favorites",
            action: native_actions::SAVE_CURRENT_TRACK_TO_FAVORITES,
            description: "Save the currently playing track to the user's favourites/library. Only for the track already playing. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "get_music_queue",
            action: native_actions::GET_MUSIC_QUEUE,
            description: "Report what is queued to play next. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "get_battery_level",
            action: native_actions::GET_BATTERY_LEVEL,
            description: "Report the device battery level. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "get_current_time",
            action: native_actions::GET_CURRENT_TIME,
            description: "Report the current time of day on the device. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "am_i_online",
            action: native_actions::AM_I_ONLINE,
            description: "Report whether the device currently has network connectivity. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        // Provider-backed music intents that the rank-one `play_music` path
        // cannot express. `play_music` starts ONE track resolved from a search
        // result; none of these have a track to resolve, so without their own
        // tools a request like "play my favourites" had no reachable action and
        // the model could only talk about it.
        AdvertisedMutationTool {
            name: "play_favorite_tracks",
            action: native_actions::PLAY_FAVORITE_TRACKS,
            description: "Plays the user's own saved, liked or favourite tracks. Use it when they \
                          ask for their favourites or liked songs without naming a track or \
                          artist; a named track or artist goes to music_catalog_search and then \
                          play_music. Takes no arguments, so there is no track to supply.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "play_featured_music",
            action: native_actions::PLAY_FEATURED_MUSIC,
            description: "Plays the provider's featured or editorial music. Use it for an \
                          open-ended 'play something' or 'play featured music' with no track, \
                          artist or genre named. Takes no arguments.",
            parameters: || json!({"type": "object", "properties": {}}),
            build: |_args| json!({}),
        },
        AdvertisedMutationTool {
            name: "generate_music_playlist",
            action: native_actions::GENERATE_MUSIC_PLAYLIST,
            description: "Creates a playlist from the description the user gave, e.g. 'make me a \
                          playlist for running'. Use it for any 'make/create a playlist …' \
                          request. `playlist` is the requested topic after the playlist command \
                          (here, 'running'), copied verbatim; a paraphrase, or an alternative the \
                          user excluded, is refused.",
            parameters: || {
                json!({
                    "type": "object",
                    "properties": {
                        "playlist": {
                            "type": "string",
                            "description": "the playlist description, copied exactly from the user's words"
                        }
                    },
                    "required": ["playlist"]
                })
            },
            build: |args| {
                let mut out = serde_json::Map::new();
                if let Some(value) = args.get("playlist").and_then(serde_json::Value::as_str) {
                    out.insert("Playlist".to_string(), json!(value));
                }
                serde_json::Value::Object(out)
            },
        },
        AdvertisedMutationTool {
            name: "set_timer",
            action: native_actions::SET_TIMER,
            description: "Starts a countdown timer. Use it for a direct command such as 'set a \
                          timer', 'start a timer', or 'create a timer'. Give exactly one of \
                          hours, minutes or seconds, using the number the user said.",
            parameters: || {
                json!({
                    "type": "object",
                    "properties": {
                        "minutes": {"type": "number", "description": "whole minutes, 1-1440"},
                        "seconds": {"type": "number", "description": "whole seconds, 1-86400"},
                        "hours": {"type": "number", "description": "whole hours, 1-24"},
                        "name": {"type": "string", "description": "optional label the user said"}
                    }
                })
            },
            build: |args| {
                let mut out = serde_json::Map::new();
                for (from, to) in [
                    ("minutes", "minuteDuration"),
                    ("seconds", "secondDuration"),
                    ("hours", "hourDuration"),
                ] {
                    if let Some(value) = args.get(from).and_then(serde_json::Value::as_f64) {
                        out.insert(to.to_string(), json!(value));
                    }
                }
                if let Some(name) = args.get("name").and_then(serde_json::Value::as_str) {
                    out.insert("name".to_string(), json!(name));
                }
                serde_json::Value::Object(out)
            },
        },
        AdvertisedMutationTool {
            name: "set_alarm",
            action: native_actions::SET_ALARM,
            description: "Set an alarm for a clock time. `time` must be exactly the time the \
                          user said, e.g. '7:30' or '7'. Use this for 'wake me up at ...' too.",
            parameters: || {
                json!({
                    "type": "object",
                    "properties": {
                        "time": {"type": "string", "description": "clock time exactly as the user said it"},
                        "ampm": {"type": "string", "description": "'am' or 'pm' if the user said it"},
                        "once_day": {"type": "string", "description": "single day the user named"}
                    },
                    "required": ["time"]
                })
            },
            build: |args| {
                let mut out = serde_json::Map::new();
                for (from, to) in [("time", "time"), ("ampm", "ampm"), ("once_day", "onceDay")] {
                    if let Some(value) = args.get(from).and_then(serde_json::Value::as_str) {
                        out.insert(to.to_string(), json!(value));
                    }
                }
                serde_json::Value::Object(out)
            },
        },
        AdvertisedMutationTool {
            name: "send_message",
            action: native_actions::COMPOSE_MESSAGE,
            description: "Sends a text message to someone the user named. Use it for 'text …', \
                          'send a message to …' and the like. Copy the recipient and the message \
                          body word for word from this request; a paraphrased body, or a \
                          recipient they did not name here, is refused.",
            parameters: || {
                json!({
                    "type": "object",
                    "properties": {
                        "to": {"type": "string", "description": "recipient exactly as the user named them"},
                        "message": {"type": "string", "description": "message body exactly as the user said it"}
                    },
                    "required": ["to", "message"]
                })
            },
            build: |args| {
                let mut out = serde_json::Map::new();
                if let Some(to) = args.get("to").and_then(serde_json::Value::as_str) {
                    out.insert("To".to_string(), json!([to]));
                }
                if let Some(body) = args.get("message").and_then(serde_json::Value::as_str) {
                    out.insert("Message".to_string(), json!(body));
                }
                serde_json::Value::Object(out)
            },
        },
        AdvertisedMutationTool {
            name: "call_person",
            action: native_actions::CALL_PERSON,
            description: "Places a phone call to someone the user named. Use it for 'call …' and \
                          'ring …'. The recipient is exactly who they named in this request.",
            parameters: || {
                json!({
                    "type": "object",
                    "properties": {
                        "to": {"type": "string", "description": "who to call, exactly as the user named them"}
                    },
                    "required": ["to"]
                })
            },
            build: |args| {
                let mut out = serde_json::Map::new();
                if let Some(to) = args.get("to").and_then(serde_json::Value::as_str) {
                    out.insert("To".to_string(), json!([to]));
                }
                serde_json::Value::Object(out)
            },
        },
    ]
}

// ─── Tool broker ────────────────────────────────────────────────────

/// The Pin's chat-turn tool surface for one run.
pub struct AibusToolCatalog<'a> {
    broker: &'a dyn AgenticToolExecutor,
    authorization: AgenticAuthorizationContext,
    utterance: String,
    /// Stock triggering classification of the entry utterance (S2). When
    /// present it gates the play-completion nudge with a production-tuned
    /// classifier instead of the lexical fallback.
    entry_intent: Option<crate::nlu::triggering::EntryIntent>,
    /// Calibrated NER slots for a Play-shaped turn (S1). Untrusted hints used
    /// to seed search arguments; never action authority.
    music_slots: Option<crate::nlu::ner_post::NerSlots>,
    /// Semantic interpreter hit (S3). Currently inert — the semantic encoder
    /// identity is unknown (the algorithmic half is wired and tested). When
    /// the encoder is pinned, this flows the interpretation through so chat-turn
    /// can use it as a second-opinion signal alongside `entry_intent`.
    semantic_hit: Option<crate::nlu::semantic::SemanticHit>,
    /// Successful provider results retained for mutation validation
    /// (`play_music` resolves rank-one from these, never from free text).
    music_results: Mutex<Vec<AgenticToolResult>>,
    /// Count of read tools that returned an ok observation this run. Live-fact
    /// requests must not be answered from stale conversation context, so a
    /// tool-free final answer for such a request is rejected once when this
    /// stays zero.
    ok_read_results: std::sync::atomic::AtomicUsize,
    /// Run correlation, identical to the value `ChatTurnLoop` stamps on its own
    /// markers. Stamped on every tool-execution line so a trace can be
    /// attributed to one run: without it a concurrent background turn is
    /// indistinguishable from the turn under test. A random runtime id is not
    /// content, so this does not weaken the content-free trace rule.
    correlation: String,
    /// Count of read tools ATTEMPTED this run, successful or not.
    ///
    /// The freshness gate must distinguish "the model never looked" from "the
    /// model looked and the provider failed". Counting only successes made a
    /// failed lookup re-trigger the nudge, costing two more model round trips
    /// before the user heard the same honest "I couldn't get that" — and the
    /// nudge's "answer from their results" instruction, delivered when there
    /// are no results, pushes a weak model toward filling the gap from stale
    /// context.
    attempted_read_results: std::sync::atomic::AtomicUsize,
}

impl<'a> AibusToolCatalog<'a> {
    pub fn new(
        broker: &'a dyn AgenticToolExecutor,
        authorization: AgenticAuthorizationContext,
        utterance: &str,
    ) -> Self {
        Self {
            broker,
            authorization,
            utterance: utterance.to_string(),
            entry_intent: None,
            music_slots: None,
            semantic_hit: None,
            correlation: String::new(),
            music_results: Mutex::new(Vec::new()),
            ok_read_results: std::sync::atomic::AtomicUsize::new(0),
            attempted_read_results: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Attach the run correlation shared with the chat-turn loop's own markers.
    pub fn with_correlation(mut self, correlation: impl Into<String>) -> Self {
        self.correlation = correlation.into();
        self
    }

    /// Attach the stock triggering classification (S2 nudge gate + census).
    pub fn with_entry_intent(
        mut self,
        entry_intent: Option<crate::nlu::triggering::EntryIntent>,
    ) -> Self {
        self.entry_intent = entry_intent;
        self
    }

    /// Attach calibrated NER slots (S1 search-argument seeding).
    pub fn with_music_slots(mut self, music_slots: Option<crate::nlu::ner_post::NerSlots>) -> Self {
        self.music_slots = music_slots;
        self
    }

    /// Attach the semantic interpreter hit (S3 second opinion).
    pub fn with_semantic_hit(
        mut self,
        semantic_hit: Option<crate::nlu::semantic::SemanticHit>,
    ) -> Self {
        self.semantic_hit = semantic_hit;
        self
    }

    fn unlocked(&self) -> bool {
        self.authorization.device_lock_state == DeviceLockState::Unlocked
    }

    /// Whether this turn is one of the two server-parsed ranked
    /// lookup-and-play requests ("look up the best songs by <artist> and play
    /// the best one", and its catalog-query sibling).
    ///
    /// These are exactly the utterances whose provider argument the server
    /// already extracted as a verbatim user span, and whose only completing
    /// tools are `music_artist_top_tracks` / `music_catalog_search` followed by
    /// `play_music`. Deliberately reuses the SAME grammar the understanding
    /// layer's finality guard uses, rather than a second lexical
    /// approximation — one grammar, one meaning, or the two drift and the gate
    /// stops matching the requests it is meant to protect.
    fn ranked_music_playback_request(&self) -> bool {
        crate::synapse::capabilities::music::named_artist_lookup_and_play_top_artist(
            &self.utterance,
        )
        .is_some()
            || crate::synapse::capabilities::music::catalog_lookup_and_play_rank_one_query(
                &self.utterance,
            )
            .is_some()
    }

    /// Execution-time gate for one read. The production dynamic runtime gates
    /// reads by unlock state plus broker-level provider consent — the
    /// `required_user_terms` lexical anchors are a contract-path-only
    /// mechanism and deliberately NOT enforced here (a tool-step model chooses
    /// reads from observations, which lexical anchors cannot predict; the
    /// authority boundary remains unlock, consent, and trusted-turn gates).
    fn read_gate_error(&self, name: &str) -> Option<String> {
        read_tool_spec(name)?;
        if read_tool_name_requires_confirmed_unlock(name) && !self.unlocked() {
            return Some(format!(
                "the {name} tool requires the device to be unlocked"
            ));
        }
        None
    }

    /// Whether a write tool may be advertised in this authorization snapshot: a
    /// write is a trusted-current-user action and (for `remember_fact`) needs a
    /// confirmed unlocked device. Mirrors `mutation_advertised`'s intent.
    fn write_advertised(&self, name: &str) -> bool {
        self.authorization.trusted_current_user
            && (!write_tool_name_requires_confirmed_unlock(name) || self.unlocked())
    }

    /// Dispatch one write tool. The trust and unlock gates run BEFORE the
    /// arguments are built or the broker is touched — a write is refused here
    /// exactly as it would be hidden from the catalog. The broker then re-checks
    /// unlock and enforces content grounding before the store is written, and
    /// returns a real observation (never a device preflight).
    async fn execute_write_tool(
        &self,
        spec: &AdvertisedWriteTool,
        call: &ToolStepCall,
    ) -> ToolExecutionOutcome {
        if !self.authorization.trusted_current_user {
            tracing::info!(
                correlation = %self.correlation,
                tool = %spec.name,
                ok = false,
                reason = "untrusted_user",
                "{}", operational_markers::TOOL_EXECUTED
            );
            return failed_observation(&format!(
                "the {} tool is only available for the trusted current user",
                spec.name
            ));
        }
        if write_tool_name_requires_confirmed_unlock(spec.name) && !self.unlocked() {
            tracing::info!(
                correlation = %self.correlation,
                tool = %spec.name,
                ok = false,
                reason = "requires_unlock",
                "{}", operational_markers::TOOL_EXECUTED
            );
            return failed_observation(&format!(
                "the {} tool requires the device to be unlocked",
                spec.name
            ));
        }
        let invocation = match (spec.build)(call.arguments.clone()) {
            Ok(invocation) => invocation,
            Err(error) => {
                tracing::info!(
                    correlation = %self.correlation,
                    tool = %spec.name,
                    ok = false,
                    reason = "invalid_arguments",
                    "{}", operational_markers::TOOL_EXECUTED
                );
                return failed_observation(&format!(
                    "invalid arguments for {}: {error}",
                    spec.name
                ));
            }
        };
        let request = AgenticWriteRequest {
            call_id: &call.call_id,
            invocation: &invocation,
        };
        match self.broker.execute_write(request).await {
            Ok(AgenticToolOutput::Result(result)) => {
                let status = result.get("status").and_then(Value::as_str);
                let ok = matches!(status, Some("ok"));
                let reason = result
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or(if ok { "ok" } else { "unspecified" });
                tracing::info!(
                    correlation = %self.correlation,
                    tool = %spec.name,
                    ok,
                    reason,
                    "{}", operational_markers::TOOL_EXECUTED
                );
                ToolExecutionOutcome::Observation {
                    ok,
                    content: bounded_json(&result),
                }
            }
            Ok(AgenticToolOutput::ExternalDevicePreflight { .. }) => {
                // A write never stages a device action; treat it as a fault
                // rather than dispatching an unexpected native preflight.
                failed_observation(&format!(
                    "{} produced an unexpected device preflight",
                    spec.name
                ))
            }
            Err(error) => failed_observation(&error.to_string()),
        }
    }

    /// Whether the utterance asks for live facts that must come from THIS
    /// run's tools (location, nearby places, routes, weather, current
    /// playback). Lexical-on-utterance only, so untrusted data cannot create
    /// or suppress the obligation.
    /// Which family of live evidence this utterance owes, if any.
    ///
    /// The distinction is load-bearing: a device-scoped question ("where am I",
    /// "what's playing", "is it raining") can only be answered by a
    /// device-scoped tool, and a web snippet must never be allowed to satisfy
    /// it. A current-events question ("what happened", "who won", "what does it
    /// cost now") is the exact inverse — no device tool can answer it, and
    /// before this existed the model was free to answer from training data on
    /// precisely the utterances `web_search` was added for.
    fn live_evidence_obligation(&self) -> Option<LiveEvidenceFamily> {
        self.live_evidence_obligation_with_music_play(true)
    }

    fn live_evidence_obligation_with_music_play(
        &self,
        include_music_play: bool,
    ) -> Option<LiveEvidenceFamily> {
        let normalized = self.utterance.to_lowercase();
        let phrase = |needle: &str| contains_word_phrase(&normalized, needle);
        // Weather: an unambiguous weather term, or a precipitation/heat cue
        // paired with a here/now cue (covers the product's own phrasings —
        // "will it rain today", "do I need an umbrella", "how hot is it
        // outside" — that a bare "weather" list misses). Word-boundary matched
        // so "rain" does not fire on "train"/"brain".
        let weather = ["weather", "forecast", "uv index"]
            .iter()
            .any(|term| phrase(term))
            || ([
                "rain", "raining", "snow", "snowing", "umbrella", "how hot", "how cold",
            ]
            .iter()
            .any(|term| phrase(term))
                && [
                    "will it", "is it", "going to", "today", "tomorrow", "tonight", "outside",
                    "need", "should i",
                ]
                .iter()
                .any(|term| phrase(term)))
            || (phrase("temperature")
                && ["outside", "today", "now", "right now", "here", "it"]
                    .iter()
                    .any(|term| phrase(term)));
        let place = [
            "near me",
            "nearby",
            "nearest",
            "closest",
            "around me",
            "navigate",
            "directions",
            "route to",
            "where am i",
            "how do i get to",
        ]
        .iter()
        .any(|term| phrase(term));
        let playback = [
            "what's playing",
            "what is playing",
            "currently playing",
            "what song",
        ]
        .iter()
        .any(|term| phrase(term));
        // A play request is a live-catalog request. This arm comes from the
        // stock on-device NLU classifier rather than another lexical list, so
        // it covers the phrasings a word list misses ("put on his best track",
        // "his most popular song") without guessing.
        //
        // Observed on-device: after discussing an artist, "play his most
        // popular song" returned a tool-free iteration-0 answer. Every other
        // live-fact family already demanded fresh evidence; play intents did
        // not, so the model was free to talk about the song instead of
        // searching the catalog and playing it.
        // The classifier attaches an intent for non-play utterances too
        // ("play it cool" reads as ClearUnderstandingContext), so this must
        // test the Play classification itself, not merely that an intent was
        // attached — otherwise it re-introduces the lexical false-fire the
        // classifier is here to suppress.
        let music_play = include_music_play
            && self
                .entry_intent
                .as_ref()
                .is_some_and(|intent| crate::nlu::triggering::is_play_intent(&intent.intent));
        // A device-control request must be PERFORMED, not described. Observed
        // on device (.122): "turn the volume up a bit" returned a tool-free
        // iteration-0 answer, so the Pin discussed the volume instead of
        // changing it — the same shape as the play-intent failure, same remedy:
        // require that a tool was at least attempted before an answer stands.
        let device_control = [
            "turn it up",
            "turn it down",
            "turn the volume",
            "turn up the volume",
            "turn down the volume",
            "volume up",
            "volume down",
            "louder",
            "quieter",
            "pause the music",
            "skip this song",
            "next track",
        ]
        .iter()
        .any(|term| phrase(term));
        if weather || place || playback || music_play || device_control {
            return Some(LiveEvidenceFamily::DeviceScoped);
        }
        // Current events. Gated on an actually configured search provider so an
        // unconfigured Pin never acquires an obligation nothing can discharge,
        // and deliberately narrow: every false fire spends a whole extra model
        // step, which on this device is seconds of real dead air.
        let current_events = self.broker.web_search_available()
            && [
                "latest",
                "the news",
                "who won",
                "what happened",
                "how much does",
                "price of",
                "opening hours",
                "what time does",
                "search the web",
                "look it up online",
            ]
            .iter()
            .any(|term| phrase(term));
        current_events.then_some(LiveEvidenceFamily::CurrentEvents)
    }

    fn play_music_advertised(&self) -> bool {
        let trusted = self.authorization.trusted_current_user;
        let allowed = native_action_spec(native_actions::PLAY_MUSIC)
            .is_some_and(|spec| self.authorization.allows(spec));
        // Bounded booleans only. Observed on device: a play request ran four
        // successful searches over ~57s and ended in prose with play_music
        // never proposed AND never rejected — the signature of a tool the model
        // never saw. Without this line, "not advertised" and "advertised but
        // not chosen" are indistinguishable from the trace, and two separate
        // fixes were attempted against the wrong one.
        tracing::info!(
            trusted_current_user = trusted,
            play_music_allowed = allowed,
            "<<< play_music catalog eligibility"
        );
        trusted && allowed
    }

    fn mutation_advertised(&self, mutation: &AdvertisedMutationTool) -> bool {
        self.authorization.trusted_current_user
            && native_action_spec(mutation.action)
                .is_some_and(|spec| self.authorization.allows(spec))
    }

    fn execute_play_music(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
        // Session-authority truth first: when play_music is not advertised
        // (locked device, untrusted turn, or PlayMusic excluded) no amount of
        // searching can end in playback. Say so on the first attempt instead of
        // coaching the model through the whole search flow toward a mutation
        // that can only be refused.
        if !self.play_music_advertised() {
            return failed_observation(
                "music playback is not available in this session. Do not call play_music again: \
                 answer with text, and tell the user plainly, in ordinary words, that you cannot \
                 start music right now",
            );
        }
        if !authoritative_play_music_command(&self.utterance) {
            return failed_observation(
                "music playback needs a direct current command, not a question, quotation, \
                 negation, hypothetical, or incidental mention",
            );
        }
        let from_call_id = coerce_arguments(call.arguments.clone())
            .get("from_call_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(from_call_id) = from_call_id else {
            return failed_observation(
                "play_music requires from_call_id: the call_id of a successful \
                 music_artist_top_tracks or music_catalog_search result from this same turn",
            );
        };
        let results = self.music_results.lock().expect("music results lock");
        // The index carries the chain-of-trust ordering: only results recorded
        // strictly earlier in this same turn may ground this one.
        let mut matches = results
            .iter()
            .enumerate()
            .filter(|(_, result)| result.call_id == from_call_id);
        let (first, second) = (matches.next(), matches.next());
        let Some((index, result)) = first.filter(|_| second.is_none()) else {
            return failed_observation(
                "from_call_id does not name exactly one successful music provider result from this same turn",
            );
        };
        if !music_result_search_target_is_grounded(result, &self.utterance, &results[..index]) {
            return failed_observation(
                "the referenced music search must use an exact target from this request",
            );
        }
        let Some(arguments) = rank_one_play_music_arguments(result) else {
            return failed_observation(
                "the referenced music result has no unambiguous rank-one track to play",
            );
        };
        let Some(spec) = native_action_spec(native_actions::PLAY_MUSIC) else {
            return failed_observation("music playback is not available");
        };
        if validate_native_action_arguments(spec, &arguments).is_err()
            || !self.authorization.allows(spec)
        {
            return failed_observation("music playback is not authorized right now");
        }
        // The catalog's grounding contract, which nothing enforced before: the
        // user must have actually asked for playback in *this* turn. Without it
        // a model can decide from conversation context alone that it should
        // start music.
        let grounding =
            crate::synapse::catalog::enforce_mutation_grounding(spec, &arguments, &self.utterance);
        if let Err(reason) = grounding {
            tracing::info!(reason = %reason, "{}", operational_markers::MUTATION_REJECTED);
            return failed_observation("playback needs the user to ask for music in this request");
        }
        ToolExecutionOutcome::Terminal(ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.to_string(),
            arguments,
        })
    }
}

impl AibusToolCatalog<'_> {
    /// Dispatch one model-chosen mutation, through every gate.
    ///
    /// The order matters: establish current-turn trust and an action-specific
    /// outer command before inspecting model arguments; then shape and validate
    /// the arguments, authorization snapshot, and exact user spans. A failure at
    /// any step becomes an observation rather than a terminal, so the model can
    /// correct itself or explain instead of the turn dying.
    fn execute_mutation(
        &self,
        mutation: &AdvertisedMutationTool,
        call: &ToolStepCall,
    ) -> ToolExecutionOutcome {
        if !self.authorization.trusted_current_user {
            return failed_observation(
                "device actions need a trusted current user request; answer with text and say \
                 plainly, in ordinary words, that you cannot do that right now",
            );
        }
        if !mutation_arguments_have_declared_shape(mutation, &call.arguments) {
            return failed_observation(
                "those arguments do not match the declared tool shape and required fields",
            );
        }
        let authoritative_command = if is_direct_music_mutation(mutation) {
            direct_music_command_intent(mutation, &self.utterance)
        } else {
            generic_mutation_command_intent(mutation, &self.utterance, &call.arguments)
        };
        if !authoritative_command {
            return failed_observation(
                "native actions need one direct, action-specific command in this request",
            );
        }
        if mutation.action == native_actions::GENERATE_MUSIC_PLAYLIST
            && !generated_playlist_argument_matches(&self.utterance, &call.arguments)
        {
            return failed_observation(
                "the playlist description must be exactly the requested topic, never an \
                 excluded alternative or another span",
            );
        }
        let arguments = (mutation.build)(&call.arguments);

        let Some(spec) = native_action_spec(mutation.action) else {
            return failed_observation("that action is not available on this device");
        };
        if spec.requires_confirmed_unlock() && !self.unlocked() {
            return failed_observation("that needs the Pin unlocked");
        }
        if validate_native_action_arguments(spec, &arguments).is_err() {
            return failed_observation(
                "those arguments are not valid for that action; check the required fields",
            );
        }
        if !self.authorization.allows(spec) {
            return failed_observation("that action is not authorized right now");
        }
        let grounding =
            crate::synapse::catalog::enforce_mutation_grounding(spec, &arguments, &self.utterance);
        if let Err(reason) = grounding {
            tracing::info!(
                tool = %call.name,
                reason = %reason,
                "{}", operational_markers::MUTATION_REJECTED
            );
            return failed_observation(
                "that must come from what the user asked in this request — do not infer a \
                 recipient, time or message they did not say",
            );
        }

        tracing::info!(tool = %call.name, action = mutation.action, "{}", operational_markers::MUTATION);
        ToolExecutionOutcome::Terminal(ValidatedNativeAction {
            action: mutation.action.to_string(),
            arguments,
        })
    }

    /// Fill a missing music search argument from the calibrated NER slots.
    /// Never overwrites a value the model supplied.
    fn seed_music_arguments(&self, tool: &str, raw: Value) -> Value {
        let Some(slots) = self.music_slots.as_ref() else {
            return raw;
        };
        let mut value = coerce_arguments(raw);
        let Some(map) = value.as_object_mut() else {
            return value;
        };
        let missing = |map: &serde_json::Map<String, Value>, key: &str| {
            map.get(key)
                .and_then(Value::as_str)
                .is_none_or(|existing| existing.trim().is_empty())
        };
        match tool {
            "music_artist_top_tracks" => {
                if let Some(artist) = slots.artist.as_deref() {
                    if missing(map, "artist") {
                        map.insert("artist".to_string(), Value::String(artist.to_string()));
                    }
                }
            }
            "music_catalog_search" => {
                if missing(map, "query") {
                    // Prefer the most specific calibrated span available.
                    let seeded = slots
                        .track
                        .as_deref()
                        .or(slots.album.as_deref())
                        .or(slots.artist.as_deref());
                    if let Some(query) = seeded {
                        map.insert("query".to_string(), Value::String(query.to_string()));
                    }
                }
            }
            _ => {}
        }
        value
    }
}

fn failed_observation(message: &str) -> ToolExecutionOutcome {
    ToolExecutionOutcome::Observation {
        ok: false,
        content: message.to_string(),
    }
}

fn bounded_json(value: &Value) -> String {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    if text.len() <= MAX_TOOL_STEP_RESULT_BYTES {
        return text;
    }
    // Over-long observations are truncated on a char boundary; the model sees
    // a bounded prefix, which is always JSON-invalid when truncated — mark it.
    let mut end = 0;
    for (start, ch) in text.char_indices() {
        let next = start + ch.len_utf8();
        if next > MAX_TOOL_STEP_RESULT_BYTES.saturating_sub(16) {
            break;
        }
        end = next;
    }
    format!("{}…(truncated)", &text[..end])
}

// ─── Tool dispatch ──────────────────────────────────────────────────

#[tonic::async_trait]
impl ToolCatalog for AibusToolCatalog<'_> {
    fn catalog(&self) -> Vec<ToolStepDefinition> {
        let mut defs: Vec<ToolStepDefinition> = read_specs()
            .iter()
            .filter(|spec| {
                // Locked devices do not advertise unlock-required reads at
                // all; term-gated tools stay advertised (the gate names the
                // current request, which the model cannot know in advance)
                // and enforce at execution.
                if read_tool_name_requires_confirmed_unlock(spec.name) && !self.unlocked() {
                    return false;
                }
                // Search needs a configured subscription. Without one the tool
                // is hidden rather than advertised and failed, so the model
                // falls back to knowledge_lookup on its first choice.
                //
                // It is hidden for a ranked lookup-and-play request for the
                // same reason, one step earlier: the server has ALREADY parsed
                // the artist (or catalog query) out of that utterance, the
                // music tools are the only ones that can answer it, and
                // `web_search` cannot even discharge the turn's freshness
                // obligation — it clears only `CurrentEvents`, never the
                // device-scoped family a play request raises. So a model that
                // picks it cannot finish the request no matter what comes back.
                // Observed on device: "Look up the best songs by <artist> and
                // play the best one" spent two whole steps in `web_search`, and
                // when the provider was unreachable the turn died on "Something
                // went wrong" — for a request the grammar had already
                // understood. Advertising a tool that cannot complete the turn
                // is pure downside; the guarantee belongs in code, not in the
                // model's judgement.
                spec.name != "web_search"
                    || (self.broker.web_search_available() && !self.ranked_music_playback_request())
            })
            .map(|spec| ToolStepDefinition {
                name: spec.name,
                description: spec.description,
                parameters: (spec.parameters)(),
            })
            .collect();
        // Mutations. Advertised only for a trusted current user turn and when
        // the catalog says the action can run in this authorization snapshot.
        // Execution repeats the trust and authorization checks; the outer
        // service independently rechecks before dispatch as well.
        for mutation in mutation_specs() {
            if !self.mutation_advertised(mutation) {
                continue;
            }
            defs.push(ToolStepDefinition {
                name: mutation.name,
                description: mutation.description,
                parameters: (mutation.parameters)(),
            });
        }
        // Writes. Advertised only for a trusted current user turn on an unlocked
        // device: a write the model could never complete is worse than no tool,
        // so it is hidden rather than advertised and refused. Execution repeats
        // both gates, and the broker re-checks unlock and grounds the content.
        for spec in write_specs() {
            if !self.write_advertised(spec.name) {
                continue;
            }
            defs.push(ToolStepDefinition {
                name: spec.name,
                description: spec.description,
                parameters: (spec.parameters)(),
            });
        }
        if self.play_music_advertised() {
            defs.push(ToolStepDefinition {
                name: PLAY_MUSIC_TOOL,
                description: "Starts playback of a track the user named by title, artist, album or genre; the request is finished only when you call it. As soon as music_catalog_search or music_artist_top_tracks returns a result, call play_music with from_call_id set to that search's call id, copied exactly from your own earlier call in this same turn — it starts that result's top-ranked track. One search, then play. from_call_id is a call id, not a track name; it, and any track or artist name, must come from a real result rather than be invented. Favourites go to play_favorite_tracks, an open-ended 'play something' to play_featured_music, a requested playlist to generate_music_playlist, and radio from the currently playing track is not started here.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "from_call_id": {
                            "type": "string",
                            "description": "The call id of your own music_catalog_search or music_artist_top_tracks call earlier in this same turn, copied exactly from it. It is a call id, not a track name, and must never be invented."
                        }
                    },
                    "required": ["from_call_id"]
                }),
            });
        }
        defs
    }

    fn cue_for(&self, tool_names: &[&str]) -> Option<String> {
        // First registered read in the batch decides the cue; mutation calls
        // are instant and never cue. Names only — never arguments.
        tool_names.iter().find_map(|name| {
            read_specs()
                .iter()
                .find(|spec| spec.name == *name)
                .map(|spec| spec.cue.to_string())
        })
    }

    fn parallel_read_safe(&self, tool_name: &str) -> bool {
        is_parallel_read_tool(tool_name)
    }

    fn forced_terminal_action(&self, _final_answer: &str) -> Option<ValidatedNativeAction> {
        // Argument-free device controls first. Measured across suite runs:
        // "turn the volume up a bit" and "make it louder" FLIPPED pass/fail
        // between identical runs, so the tools work but fire only when the
        // model chooses to comply. The nudge buys one retry; after that the
        // user gets prose instead of a volume change.
        //
        // Deterministic code owns dispatch. This fires only for a command the
        // intent gate ALREADY accepts, so nothing becomes reachable that was
        // not already permitted — it removes the coin flip, not a check.
        for mutation in mutation_specs() {
            // Argument-free controls only. Anything needing an argument
            // (SetVolume, ComposeMessage, CallPerson) must come from the model
            // with the user's own value; inventing one is exactly what the
            // grounding rules exist to prevent.
            let arguments = (mutation.build)(&json!({}));
            if arguments != json!({}) {
                continue;
            }
            let Some(spec) = native_action_spec(mutation.action) else {
                continue;
            };
            if !self.mutation_advertised(mutation) {
                continue;
            }
            // Both gates the tool path uses, unchanged.
            if !generic_mutation_command_intent(mutation, &self.utterance, &json!({})) {
                continue;
            }
            if crate::synapse::catalog::enforce_mutation_grounding(
                spec,
                &arguments,
                &self.utterance,
            )
            .is_err()
            {
                continue;
            }
            if validate_native_action_arguments(spec, &arguments).is_err() {
                continue;
            }
            tracing::info!(
                action = mutation.action,
                "{}; the model would not",
                operational_markers::DETERMINISTIC_COMPLETION
            );
            return Some(ValidatedNativeAction {
                action: mutation.action.to_string(),
                arguments,
            });
        }

        // Only for an authoritative play command, and only when playback is
        // actually available in this session.
        if !authoritative_play_music_command(&self.utterance) || !self.play_music_advertised() {
            return None;
        }
        let spec = native_action_spec(native_actions::PLAY_MUSIC)?;
        let results = self.music_results.lock().expect("music results lock");
        // Newest first: the model's latest search is the one it was working
        // from. Every candidate must still be grounded in THIS request and
        // yield an unambiguous rank-one track through the shared audited
        // builder, so this cannot invent a track the user never asked for.
        // Bounded counters only. Four independent conditions can decline the
        // completion and the trace could not distinguish them; guessing between
        // them has already cost two release cycles.
        let mut ungrounded = 0usize;
        let mut play_args_refused = 0usize;
        // Split by tool. `music_artist_top_tracks` is scoped to the artist the
        // user named, so if ITS results are the ones failing, the problem is
        // upstream of ranking; if they never reach the check at all, they are
        // being dropped by grounding. The aggregate counters cannot tell those
        // apart, and guessing between them has already cost a release cycle.
        let mut top_tracks_ungrounded = 0usize;
        let mut top_tracks_refused = 0usize;
        // Artist-scoped results first. Measured on device: a
        // `music_catalog_search` rank-one track listed FOUR artists, none of
        // them the requested one, so the artist check correctly refused it and
        // playback declined — the gate was protecting the user from a wrong
        // song, not blocking a right one. `music_artist_top_tracks` is scoped
        // to the artist the user named, so its rank-one is the track actually
        // asked for. Try those before generic catalog hits.
        //
        // This is ORDERING, not loosening: every candidate still passes
        // grounding, rank-one extraction, the artist check, argument validation
        // and authorization.
        let artist_scoped = results
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, result)| result.tool_name == "music_artist_top_tracks");
        let catalog = results
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, result)| result.tool_name != "music_artist_top_tracks");
        let picked = artist_scoped.chain(catalog).find_map(|(index, result)| {
            let is_top_tracks = result.tool_name == "music_artist_top_tracks";
            // Only strictly earlier same-turn results may ground this one.
            if !music_result_search_target_is_grounded(result, &self.utterance, &results[..index]) {
                ungrounded += 1;
                if is_top_tracks {
                    top_tracks_ungrounded += 1;
                }
                return None;
            }
            match rank_one_play_music_arguments(result) {
                Some(arguments) => Some(arguments),
                None => {
                    play_args_refused += 1;
                    if is_top_tracks {
                        top_tracks_refused += 1;
                    }
                    None
                }
            }
        });
        let Some(arguments) = picked else {
            tracing::info!(
                results = results.len(),
                ungrounded,
                play_args_refused,
                top_tracks_ungrounded,
                top_tracks_refused,
                "<<< deterministic playback completion declined"
            );
            return None;
        };
        validate_native_action_arguments(spec, &arguments).ok()?;
        if !self.authorization.allows(spec) {
            return None;
        }
        tracing::info!("<<< completing playback deterministically; the model would not");
        Some(ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.to_string(),
            arguments,
        })
    }

    fn final_answer_nudge(&self, _final_answer: &str) -> Option<String> {
        // The shared strict classifier owns fieldless music authority. A real
        // direct command owes its terminal tool; an unsafe mention suppresses
        // every playback nudge; a named title/artist collision deliberately
        // falls through to the catalog-search obligation below.
        let mut suppress_playback_nudge = !authoritative_play_music_command(&self.utterance);
        for mutation in mutation_specs()
            .iter()
            .filter(|mutation| is_fieldless_direct_music_mutation(mutation))
        {
            let Some(spec) = native_action_spec(mutation.action) else {
                continue;
            };
            match classify_fieldless_music_grounding(spec, &self.utterance) {
                Some(FieldlessMusicGrounding::AuthoritativeDirectCommand) => {
                    if !self.mutation_advertised(mutation) {
                        suppress_playback_nudge = true;
                        continue;
                    }
                    return Some(format!(
                        "The user requested a direct music action, and a text reply does not start it. \
                         Call the matching terminal playback tool now ({}).",
                        mutation.name
                    ));
                }
                Some(FieldlessMusicGrounding::NonAuthoritativeDirectActionMention) => {
                    if !catalog_command_precedes_excluded_fieldless_alternative(&self.utterance) {
                        suppress_playback_nudge = true;
                    }
                }
                Some(FieldlessMusicGrounding::NamedCatalogCollision) | None => {}
            }
        }

        // Generated playlists have a required payload, so bind the nudge to the
        // same deterministic topic parser used at execution. A related but
        // unsafe playlist mention is suppressed. A direct `play ...` command
        // that happens to name a song/title containing "make a playlist" still
        // belongs to catalog search.
        let playlist = mutation_specs()
            .iter()
            .find(|mutation| mutation.action == native_actions::GENERATE_MUSIC_PLAYLIST)
            .expect("GenerateMusicPlaylist mutation registered");
        let playlist_related = native_action_spec(playlist.action).is_some_and(|spec| {
            crate::synapse::catalog::enforce_mutation_grounding(spec, &json!({}), &self.utterance)
                .is_ok()
        });
        if playlist_related {
            if generated_playlist_requested_topic(&self.utterance).is_some() {
                if !self.mutation_advertised(playlist) {
                    suppress_playback_nudge = true;
                } else {
                    return Some(
                        "The user requested a generated playlist, and a text reply does not create it. \
                         Call the generate_music_playlist terminal tool now with the requested topic."
                            .to_string(),
                    );
                }
            }
            if !authoritative_play_music_command(&self.utterance) {
                suppress_playback_nudge = true;
            }
        }

        // Freshness obligation: a live-fact request (weather, nearby, routes,
        // location, current playback) must be answered from THIS run's tool
        // results. With conversation context in the prompt, the model can
        // otherwise "answer" from a stale prior turn — observed on-device as a
        // tool-free iteration-0 answer to a nearby-plus-route request.
        // Only demand fresh evidence when it is actually obtainable: on a
        // locked (or unknown) device every live-fact tool the nudge names is
        // hidden from the catalog, so the obligation would be impossible and
        // just burn the model's grace iteration.
        // ATTEMPTED, not merely successful. A provider that failed still means
        // the model looked this run, so re-demanding evidence only costs two
        // more round trips before the same honest "I couldn't get that" — and
        // instructing it to "answer from their results" when there are none
        // invites a fabricated answer from stale context.
        let obligation = self.live_evidence_obligation_with_music_play(!suppress_playback_nudge);
        if self.unlocked()
            && obligation.is_some()
            && self
                .attempted_read_results
                .load(std::sync::atomic::Ordering::Relaxed)
                == 0
        {
            // Name the tools that can discharge THIS family. The device-scoped
            // list would steer a current-events question away from the only
            // tool able to answer it.
            let tools = match obligation {
                Some(LiveEvidenceFamily::CurrentEvents) => "web_search",
                _ => "current_location, nearby_search, route, weather, or music search",
            };
            // "in this run" stays: it is model-facing text where the same-turn
            // meaning is load-bearing, and `tool_catalog/tests.rs` pins it.
            // The leak this defect was about is fixed on the SPEECH side (the
            // prompt's internal-term rule), not by weakening a nudge.
            return Some(format!(
                "This request needs live information gathered in this run. Prior conversation \
                 answers are stale references, not evidence. Call the needed tools now \
                 ({tools}) and answer from their results."
            ));
        }
        if suppress_playback_nudge {
            return None;
        }
        // Deterministic completion obligation: the current request asked to
        // start music, a provider search already succeeded this run, and the
        // play_music mutation is authorized — a text reply cannot satisfy the
        // request. Detection is lexical-on-utterance only (never provider
        // text), so untrusted data cannot create the obligation.
        if !self.play_music_advertised() {
            return None;
        }
        // S2: prefer the stock triggering classifier — production-tuned, and
        // it catches phrasings the three-term lexical check misses ("queue up
        // some jazz") while rejecting ones it false-fires on ("play it cool").
        // Its strict-radius autocomplete tier is the high-precision signal.
        // Fail open to the lexical check whenever the classifier is absent.
        // Whether the Play reading is high-confidence. The stock classifier is
        // production-tuned; the lexical fallback is not, and false-fires on
        // phrases like "play it cool". Only the confident reading may demand a
        // search it has no evidence for (below).
        let confident_play_intent = self.entry_intent.is_some();
        let play_intent = match self.entry_intent.as_ref() {
            // `classify` already applied the centroid's loose radius, so ANY
            // Play classification means the utterance cleared the Play radius
            // — the precision that rejects "play it cool" is the centroid, not
            // the strict/autocomplete tier. Requiring autocomplete here was too
            // tight and dropped valid plays (e.g. "look up the best songs by X
            // and play it", which clears the loose radius but not the strict).
            Some(intent) => crate::nlu::triggering::is_play_intent(&intent.intent),
            None => {
                let normalized = self.utterance.to_lowercase();
                ["play", "put on", "start playing"]
                    .iter()
                    .any(|term| normalized.contains(term))
            }
        };
        if !play_intent {
            return None;
        }
        if !authoritative_play_music_command(&self.utterance) {
            return None;
        }
        let results = self.music_results.lock().expect("music results lock");
        let candidate = results
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, result)| {
                // Only strictly earlier same-turn results may ground this one.
                (music_result_search_target_is_grounded(result, &self.utterance, &results[..index])
                    && rank_one_play_music_arguments(result).is_some())
                .then(|| result.call_id.clone())
            });
        match candidate {
            Some(candidate) => Some(format!(
                "The user asked to play music, and a text reply does not start playback. Call the \
                 play_music tool now with from_call_id '{candidate}' to start the top result. If \
                 you truly cannot, say in one short sentence which song or artist you could not \
                 start and one thing the user could say instead, using ordinary words only."
            )),
            // No usable provider result this run. Previously this returned None,
            // so a text-only reply to "play X" sailed through the gate and the
            // Pin confidently said "Playing X now" while nothing played — a
            // spoken false claim of a completed action. Demand the search step
            // instead of accepting the fabrication.
            // Only when the classifier confirmed Play. On the lexical fallback
            // this would fire on false positives like "play it cool", so there
            // the obligation still requires real provider evidence.
            None if confident_play_intent => Some(
                "The user asked to play music but no music search has succeeded in this run, so \
                 a text reply would claim playback that never started. Call \
                 music_catalog_search or music_artist_top_tracks now, then play_music citing \
                 that same call's id. If the search itself comes back empty, say in one short \
                 sentence which song or artist you could not find and one thing the user could \
                 say instead, using ordinary words only."
                    .to_string(),
            ),
            None => None,
        }
    }

    async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
        if call.name == PLAY_MUSIC_TOOL {
            return self.execute_play_music(call);
        }
        if let Some(mutation) = mutation_specs().iter().find(|spec| spec.name == call.name) {
            return self.execute_mutation(mutation, call);
        }
        if let Some(spec) = write_tool_spec(&call.name) {
            return self.execute_write_tool(spec, call).await;
        }
        let Some(spec) = read_specs().iter().find(|spec| spec.name == call.name) else {
            tracing::info!(
                correlation = %self.correlation,
                tool = %call.name,
                ok = false,
                reason = "unknown_tool",
                "{}", operational_markers::TOOL_EXECUTED
            );
            return failed_observation(&format!(
                "unknown tool '{}'; use only the provided tools",
                call.name
            ));
        };
        if let Some(gate) = self.read_gate_error(spec.name) {
            tracing::info!(
                correlation = %self.correlation,
                tool = %call.name,
                ok = false,
                reason = "feature_gate",
                "{}", operational_markers::TOOL_EXECUTED
            );
            return failed_observation(&gate);
        }
        // S1 slot seeding: when the on-device extractor produced a
        // calibrated artist above the stock gates and the model left the
        // artist-lookup argument empty, fill it deterministically. Only fills
        // MISSING values — a model-supplied argument is never overridden, so
        // the model stays in control and the hint can only add information.
        let arguments = self.seed_music_arguments(&call.name, call.arguments.clone());
        let invocation = match (spec.build)(arguments) {
            Ok(invocation) => invocation,
            Err(error) => {
                // The serde detail can quote argument values, so it reaches
                // only the model transcript, never the trace.
                tracing::info!(
                    correlation = %self.correlation,
                    tool = %call.name,
                    ok = false,
                    reason = "invalid_arguments",
                    "{}", operational_markers::TOOL_EXECUTED
                );
                return failed_observation(&format!(
                    "invalid arguments for {}: {error}",
                    call.name
                ));
            }
        };
        let request = AgenticToolRequest {
            call_id: &call.call_id,
            invocation: &invocation,
        };
        match self.broker.execute(request).await {
            Ok(AgenticToolOutput::Result(result)) => {
                // `not_found` is a valid EMPTY result (e.g. current_music when
                // nothing is playing), not a failure: it must not contain the
                // [TOOL_ERROR] stamp, and it counts as live evidence gathered
                // this run so the freshness gate does not order a redundant
                // re-lookup of a definitively-empty read.
                let status = result.get("status").and_then(Value::as_str);
                let ok = matches!(status, Some("ok") | Some("not_found"));
                // Counted whatever the outcome: the model DID look this run.
                // Restricted to LIVE-FACT tools so an unrelated failed read
                // (e.g. knowledge_lookup) cannot clear the freshness obligation
                // for a weather/location question and let it be answered from
                // stale conversation context.
                // Family-scoped on purpose. `web_search` is deliberately NOT
                // in `is_live_fact_tool`: letting a web snippet clear a
                // "where am I" or "what's playing" obligation is exactly the
                // staleness this gate exists to prevent. It discharges only an
                // obligation the open web can actually answer.
                let discharges = is_live_fact_tool(call.name.as_str())
                    || (call.name == "web_search"
                        && self.live_evidence_obligation()
                            == Some(LiveEvidenceFamily::CurrentEvents));
                if discharges {
                    self.attempted_read_results
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                // Content-free execution trace (parity with the legacy proof
                // trace): registered name, status, and the closed-set failure
                // reason only, never arguments.
                if ok {
                    self.ok_read_results
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    tracing::info!(correlation = %self.correlation, tool = %call.name, ok, "{}", operational_markers::TOOL_EXECUTED);
                } else {
                    let reason = result
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("unspecified");
                    tracing::info!(correlation = %self.correlation, tool = %call.name, ok, reason, "{}", operational_markers::TOOL_EXECUTED);
                }
                if ok
                    && matches!(
                        invocation,
                        ReadToolInvocation::MusicArtistTopTracks(_)
                            | ReadToolInvocation::MusicCatalogSearch(_)
                    )
                {
                    if let Some(tool_spec) = read_tool_spec(call.name.as_str()) {
                        self.music_results.lock().expect("music results lock").push(
                            AgenticToolResult {
                                call_id: call.call_id.clone(),
                                tool_name: tool_spec.name,
                                provenance: tool_spec.result_provenance,
                                tool: invocation.clone(),
                                result: result.clone(),
                            },
                        );
                    }
                }
                // Bounded SHAPE only, never result content. The music defect
                // presents as: searches return ok=true, play_music is never
                // proposed and never rejected, the loop re-searches to the
                // iteration ceiling. Gating, tool description and the
                // completion nudge were each eliminated as causes; an
                // ok-but-empty result is the remaining candidate, and it is
                // invisible without this.
                if matches!(
                    call.name.as_str(),
                    "music_catalog_search" | "music_artist_top_tracks"
                ) {
                    let tracks = result
                        .get("tracks")
                        .and_then(|value| value.as_array())
                        .map_or(0, Vec::len);
                    tracing::info!(
                        tool = %call.name,
                        ok,
                        track_count = tracks,
                        citable = !self
                            .music_results
                            .lock()
                            .expect("music results lock")
                            .is_empty(),
                        "<<< music result shape"
                    );
                }
                ToolExecutionOutcome::Observation {
                    ok,
                    content: bounded_json(&result),
                }
            }
            Ok(AgenticToolOutput::ExternalDevicePreflight { action, arguments }) => {
                ToolExecutionOutcome::Preflight { action, arguments }
            }
            Err(error) => {
                // Broker rejection reasons are static, content-free grounding
                // or availability statements. Surfacing them lets the model
                // self-repair (re-quote the user's words, use the current
                // location label) instead of treating the tool as broken, and
                // makes the failure diagnosable from the trace.
                tracing::info!(
                    correlation = %self.correlation,
                    tool = %call.name,
                    ok = false,
                    reason = %error,
                    "{}", operational_markers::TOOL_EXECUTED
                );
                failed_observation(&format!(
                    "the {} tool rejected this call: {error}",
                    call.name
                ))
            }
        }
    }
}

#[cfg(test)]
#[path = "catalog/tests.rs"]
mod tests;
