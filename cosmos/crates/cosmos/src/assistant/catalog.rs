//! The clone's **own** assistant system prompt + tool set + server-side tool
//! executor — the analogue of cosmos's server-owned catalog keyed by
//! `tool_set_version`.
//!
//! ## Where the two halves come from
//!
//! **The interface is recovered; the wording is ours.** `catalog_generated.rs`
//! is the complete stock device-action interface — every `nameForModel` the
//! pin's `SchemaCatalog` will resolve, with its model-facing parameter names,
//! types, and required-ness, plus `@Action(enabledInKeyguard=…)`. A real Pin
//! resolves an emitted action *only* if the name and argument keys match that
//! contract exactly, so mirroring it is a parity requirement — the same class of
//! fact as the protobuf wire contract. Parameter schemas below are **built from**
//! that table rather than hand-typed, so they cannot drift from the device.
//!
//! Everything the model *reads* — [`system_prompt`] and every tool description —
//! is authored here by us. Humane's proprietary prompt text and model-facing
//! description prose are deliberately not reproduced.
//!
//! ## Why a curated tool set rather than all 138 actions
//!
//! cosmos's device sends an empty `action_definitions` and only a
//! `tool_set_version` pointer, leaving the server authoritative over *which*
//! subset of the catalog a given turn may use. This deployment's set is
//! [`TOOL_SET_NAME`] v[`TOOL_SET_VERSION`]. Selecting a subset is therefore
//! faithful to the architecture, not a shortcut.
//!
//! Two classes are deliberately withheld, and this is **our safety choice, not a
//! fidelity claim** about what cosmos exposed:
//!   * irreversible or safety-critical device control — factory reset, reboot,
//!     power off, emergency-call confirmation, emergency/AMBER alert toggles;
//!   * device→server callbacks and internal diagnostics that are not model-
//!     callable in the first place (`UserConfirmed*`, `DeviceUnlocked`,
//!     `ThermalWarning`, `SystemTrace*`).
//!
//! The full interface stays available in
//! [`catalog_generated`](super::catalog_generated) for validating or emitting any
//! action, so withholding is a policy layer, not a capability loss.

use serde_json::{Value, json};

use super::catalog_generated::{self, DeviceAction, DeviceField, FieldType};
use super::llm::ToolDef;
use super::toolsets::{self, ToolSet};

/// Cosmos's tool-set version (the analogue of Cosmos's `tool_set_version`).
pub const TOOL_SET_NAME: &str = "cosmos";
pub const TOOL_SET_VERSION: i32 = 1;

/// cosmos's terminal speak action (`RespondAction`, `nameForModel="Respond"`); its
/// model-facing parameter is `Response` (a STRING), per the recovered schema.
pub const RESPOND_ACTION: &str = "Respond";
/// The model-facing field name `RespondAction` resolves the spoken text from.
pub const RESPOND_FIELD: &str = "Response";

/// Our own system prompt — never Humane's. The *behavior* it asks for mirrors the
/// reconstructed stock loop (ReAct tool discipline, TTS-shaped answers, always
/// terminate in a spoken `Respond`), but the wording is ours. Behavioral parity
/// comes from the interface + tools + loop shape, not from the prompt's text.
pub fn system_prompt() -> &'static str {
    "You are the assistant for a wearable AI pin. The wearer speaks to you and \
     hears your reply through a small speaker, so answer in one or two short, \
     natural spoken sentences — never lists, markdown, symbols, or spelled-out \
     URLs.\n\
     \n\
     Work one step at a time: decide what the wearer needs, call a tool if it \
     helps, read the result, then either call another tool or answer. When a \
     request needs two or more lookups that do not depend on each other, ask for \
     them together in one step rather than one after another — each extra step \
     costs the wearer seconds of silence.\n\
     \n\
     Answer straight away, with no lookup, when the question has a settled \
     answer you already know — who a well-known person is, what a word means, a \
     capital city, a landmark's height, how something works. A lookup the wearer \
     did not need still costs them the seconds of silence. If the wearer \
     explicitly asks you to look something up, search, or browse, honor that \
     request even when you already know the answer. Look it up when the \
     answer moves with time or place, when it is specific to this wearer, or \
     when being wrong would matter: news, weather, prices, scores, opening \
     hours, anything dated, and anything you are not sure of. For a product or \
     service price, use the answer engine directly when it is offered, verify \
     whether it is still sold, and distinguish present availability from an \
     old launch price; do not also call web search unless the answer engine \
     explicitly says it lacks current evidence. Pick the \
     tool that fits — the answer engine for current events and questions needing \
     fresh facts, the encyclopedia for definitions and background, the calculator \
     for math, units, dates, distances, and measurements, and web search for \
     anything else. Device actions (set a timer, play music, search contacts, \
     take a photo, and so on) run on the pin itself.\n\
     \n\
     For a ranked or subjective music question, use the one offered research tool \
     for the requested criterion. If the wearer only asks what the song is, \
     answer from that research and do not touch their music provider. If they \
     explicitly ask to play it, call `music_discover` after research with the \
     exact title and artist; it verifies the track against the active provider \
     before playback. If the provider rejects that candidate and the completed \
     research named a different exact candidate, call `music_discover` once more \
     with that different title and artist. Do not repeat the research or retry \
     the same candidate. For open-ended playback that names no track, artist, \
     album, genre, or existing playlist, call `PlayFeaturedMusic`; `PlayMusic` \
     is only for a named selection and must not be sent with empty fields.\n\
     \n\
     A question about the pin's OWN state — the current time, the battery level, \
     the volume, whether Wi-Fi, Bluetooth, or airplane mode is on, whether the \
     pin is online, or where the wearer is right now — is answered by the pin, \
     not by you. Emit the matching device action — `GetCurrentTime`, \
     `GetBatteryLevel`, `GetCurrentVolume`, `AmIOnline`, `GetCurrentLocation`, and \
     the like — and let the pin read the live value. Never answer these from the \
     authenticated device-context data or your own reasoning: that data exists to help you \
     reason about time- and place-relative requests, not to be read back as the \
     pin's current state, and it says nothing at all about battery, volume, or \
     connectivity.\n\
     \n\
     Always finish by speaking to the wearer: reply with plain text, or call \
     `Respond` with exactly what to say. If a tool reports that something is \
     unavailable, say so plainly — never invent an answer, a number, or a fact. \
     When the wearer asks you to remember something, save it with \
     `remember`.\n\
     \n\
     A question about the wearer themself — what they like, prefer, own, chose, \
     said, or were told — is ALWAYS a `recall_memory` lookup first. Their saved \
     notes are the only place that answer can live: you cannot know it, and this \
     turn carries no earlier conversation, so answering from what is \"established \
     here\" means answering from nothing. Never tell the wearer they have not told \
     you something until `recall_memory` has come back empty. `recall_history` is \
     a different tool — it replays past Ai Mic and music activity, not saved notes \
     — so reach for `recall_memory` whenever the question is about a fact they \
     asked you to keep. Only say nothing is saved when the lookup says so.\n\
     \n\
     Do not mention tools, steps, or that you are an assistant."
}

/// The system prompt for one resolved tool set: the base prompt above plus that
/// set's own short spoken-style guidance.
///
/// cosmos's server resolved `tool_set_version` to a prompt *and* a tool subset;
/// serving the subset without the guidance would offer a capability child the
/// narrow tool list but none of the narrow behaviour. The default
/// (`supervisor@7`) carries no addendum, so its prompt is byte-identical to
/// [`system_prompt`] and the flat path is unchanged.
pub fn system_prompt_for(set: &ToolSet) -> String {
    let base = system_prompt();
    // Safety rules ride on EVERY turn, whatever tool set resolved. They close two
    // gaps no code guard can: the assistant reads attacker-controlled text
    // (search results, retrieved pages, message bodies) through the same channel
    // as the wearer's request, and it holds private context that must not leak
    // into logs, citations, or tool arguments. Placed before the per-set guidance
    // so a capability prompt cannot read as an exception to them.
    let safety = super::prompts::safety_block();
    let orchestration = super::prompts::orchestration_block();
    if set.guidance.trim().is_empty() {
        format!("{base}\n\n{safety}\n\n{orchestration}")
    } else {
        format!("{base}\n\n{safety}\n\n{orchestration}\n\n{}", set.guidance)
    }
}

/// A server-side tool: ours, executed here, never on the pin.
struct ServerTool {
    name: &'static str,
    description: &'static str,
    parameters: fn() -> Value,
}

fn remember_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "Exactly what to save, in the wearer's own words."
            }
        },
        "required": ["text"]
    })
}

/// What a location-bearing tool accepts.
///
/// The wearer's own position reaches the model in the wearer-situation system
/// line, and the device supplies it in whichever form it has: coordinates
/// (`SynapseUnderstandingRequest.location`, `situation.latitude/longitude`) or a
/// place it already resolved (`situation.location_string`,
/// `device_context.reverse_geocoded_location`). Requiring coordinates when the
/// device only sent a place name left the model two bad options — invent a
/// latitude, or fall back to a web search — so both forms are accepted here and
/// a place name is turned into a point by a lookup rather than by the model.
const PLACE_DESCRIPTION: &str = "A place name to use when no coordinates are known — the wearer's \
     reported location, or a place they named. Only a location that was actually \
     supplied, never a guess.";

fn coordinate_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "latitude": { "type": "number" },
            "longitude": { "type": "number" },
            "place": { "type": "string", "description": PLACE_DESCRIPTION }
        },
        // Nothing is required: with no location at all the tool reports that,
        // and a made-up coordinate answers confidently about the wrong city.
        "required": []
    })
}

fn nearby_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "latitude": { "type": "number" },
            "longitude": { "type": "number" },
            "place": { "type": "string", "description": PLACE_DESCRIPTION },
            "query": {
                "type": "string",
                "description": "What to look for, e.g. \"coffee\" or \"pharmacy\". Omit or leave empty for a general nearby request."
            }
        },
        "required": []
    })
}

fn route_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "destination": {
                "type": "string",
                "description": "The destination the wearer named or selected from a preceding place result."
            },
            "mode": {
                "type": "string",
                "enum": ["driving", "walking", "bicycling"],
                "description": "The requested travel mode. Omit it when the wearer did not specify one."
            }
        },
        "required": ["destination"]
    })
}

fn query_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "query": { "type": "string" } },
        "required": ["query"]
    })
}

fn music_discovery_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "artist": {
                "type": "string",
                "description": "The exact primary artist identified by the preceding web research."
            },
            "title": {
                "type": "string",
                "description": "The exact official track title identified by the preceding web research."
            },
            "criterion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "description": "A short semantic criterion such as most popular, top, best, viral, controversial, influential, underrated, or suitable for a situation."
            },
            "timeframe": {
                "type": "string",
                "enum": ["current", "recent", "all_time"]
            },
            "year": {
                "type": "integer",
                "minimum": 1900,
                "maximum": 2100,
                "description": "An exact release year when the wearer supplied one."
            },
            "context": {
                "type": "string",
                "description": "Short additional constraints, mood, situation, or reference track supplied by the wearer."
            }
        },
        "required": ["artist", "title", "criterion", "timeframe"]
    })
}

const MAX_PROGRESS_SUBJECT_BYTES: usize = 48;
const MAX_ACTION_CUE_JSON_BYTES: usize = 4 * 1024;

/// A short, deterministic progress cue for work the assistant has actually
/// selected. The cue comes from the tool and its safe public subject, not from
/// a second model call, so it adds no latency and cannot drift into generic
/// filler such as "Just a moment".
pub(crate) fn progress_cue(action: &str, arguments: &str) -> Option<String> {
    let arguments = serde_json::from_str::<Value>(arguments).ok()?;
    progress_cue_from_value(action, &arguments)
}

/// Stock sends action interstitials as `{ "tool": { ...arguments... } }`.
/// More than one entry is a repeated/accumulated request, so only the first
/// single-action request speaks.
pub(crate) fn progress_cue_from_action_strings(actions: &[String]) -> Option<String> {
    let raw = actions.first()?;
    if actions.len() != 1 || raw.len() > MAX_ACTION_CUE_JSON_BYTES {
        return None;
    }
    let Value::Object(object) = serde_json::from_str::<Value>(raw).ok()? else {
        return None;
    };
    if object.len() != 1 {
        return None;
    }
    let (action, arguments) = object.iter().next()?;
    progress_cue_from_value(action, arguments)
}

fn progress_cue_from_value(action: &str, arguments: &Value) -> Option<String> {
    match action {
        "weather" => cue_with_subject(
            arguments,
            "place",
            "Checking the weather in ",
            "Checking the local weather",
        ),
        "nearby" => {
            let query = argument_subject(arguments, "query");
            let place = argument_subject(arguments, "place");
            Some(match (query, place) {
                (Some(query), Some(place)) => format!("Finding {query} near {place}"),
                (Some(query), None) => format!("Finding {query} nearby"),
                (None, Some(place)) => format!("Finding places near {place}"),
                (None, None) => "Finding nearby places".to_owned(),
            })
        }
        "food_lookup" => cue_with_subject(
            arguments,
            "query",
            "Checking nutrition for ",
            "Checking nutrition",
        ),
        "web_search" | "ask_online" | "wikipedia" | "knowledge_lookup" => {
            cue_with_subject(arguments, "query", "Looking up ", "Looking that up")
        }
        "wolfram" => cue_with_subject(arguments, "query", "Calculating ", "Calculating that"),
        "recall_history" => Some("Checking recent activity".to_owned()),
        "recall_memory" | "memory_search" => Some("Checking saved memories".to_owned()),

        // The Pin's local read-tool names use the same formatter when stock
        // asks Cosmos for an action interstitial.
        "place_search" => cue_with_subject(arguments, "query", "Finding ", "Finding that place"),
        "weather_at_place" => cue_with_subject(
            arguments,
            "location",
            "Checking the weather in ",
            "Checking the weather",
        ),
        "current_location" | "reverse_geocode" => Some("Checking the location".to_owned()),
        "current_weather" => cue_with_subject(
            arguments,
            "location",
            "Checking the weather in ",
            "Checking the local weather",
        ),
        "nearby_search" => {
            cue_with_subject(arguments, "query", "Finding ", "Finding nearby places").map(|cue| {
                if cue == "Finding nearby places" {
                    cue
                } else {
                    format!("{cue} nearby")
                }
            })
        }
        "route" => cue_with_subject(
            arguments,
            "destination",
            "Finding directions to ",
            "Finding directions",
        ),
        "music_artist_top_tracks" => {
            cue_with_subject(arguments, "artist", "Finding songs by ", "Finding songs")
        }
        "music_catalog_search" => cue_with_subject(arguments, "query", "Finding ", "Finding music"),
        "music_discover" => cue_with_subject(
            arguments,
            "artist",
            "Finding a track by ",
            "Finding the right track",
        ),
        "current_music" => Some("Checking the current music".to_owned()),

        // Writes, device mutations, answers, and unknown actions never need a
        // wait cue.
        _ => None,
    }
}

fn cue_with_subject(arguments: &Value, key: &str, prefix: &str, fallback: &str) -> Option<String> {
    Some(
        argument_subject(arguments, key)
            .map(|value| format!("{prefix}{value}"))
            .unwrap_or_else(|| fallback.to_owned()),
    )
}

fn argument_subject(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .and_then(progress_subject)
}

fn progress_subject(raw: &str) -> Option<String> {
    let cleaned = raw
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '.' | ',' | '?' | '!' | ':' | ';' | '"' | '“' | '”'
            )
    });
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.len() <= MAX_PROGRESS_SUBJECT_BYTES {
        return Some(cleaned.to_owned());
    }

    let mut end = MAX_PROGRESS_SUBJECT_BYTES.saturating_sub('…'.len_utf8());
    while end > 0 && !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    let shortened = cleaned[..end].trim_end();
    (!shortened.is_empty()).then(|| format!("{shortened}…"))
}

/// The server tools this deployment adds on top of the device catalog.
const SERVER_TOOLS: &[ServerTool] = &[
    ServerTool {
        name: "recall_history",
        description: "Replay past ACTIVITY: what the wearer previously asked the \
                      assistant, or what music played. Use for questions about the \
                      past like \"what did I ask last week\" or \"what song played \
                      on Friday\". NOT for facts the wearer asked you to remember \
                      — those are saved notes, use `recall_memory`.",
        parameters: recall_schema,
    },
    ServerTool {
        name: "remember",
        description: "Save something the wearer asked you to remember, so it can \
                      be recalled later. Use for notes, reminders of facts, and \
                      anything they say to keep.",
        parameters: remember_schema,
    },
    ServerTool {
        name: "weather",
        description: "Current weather conditions at a location. Pass the wearer's \
                      own coordinates or reported place when they ask about the \
                      weather where they are, or the place they named. Prefer \
                      this over a web search.",
        parameters: coordinate_schema,
    },
    ServerTool {
        name: "reverse_geocode",
        description: "Resolve the wearer's current coordinates into a city and address. Use only when the wearer asks where they are and the Pin supplied a location.",
        parameters: coordinate_schema,
    },
    ServerTool {
        name: "nearby",
        description: "Find places near a location — restaurants, shops, \
                      landmarks. Use when the wearer asks what is around them, \
                      passing their own coordinates or reported place.",
        parameters: nearby_schema,
    },
    ServerTool {
        name: "route",
        description: "Get grounded route directions from the Pin's current position to a destination. \
                      Use after nearby when the wearer asks for directions or navigation. This returns \
                      route guidance; never claim that continuous turn-by-turn navigation was started.",
        parameters: route_schema,
    },
    ServerTool {
        name: "food_lookup",
        description: "Nutrition facts for a packaged food or drink by name or \
                      barcode.",
        parameters: query_schema,
    },
    ServerTool {
        name: "web_search",
        description: "Search raw web results for current, factual information, especially latest headlines. For a current product or service price or availability question, use ask_online instead when it is offered.",
        parameters: query_schema,
    },
    ServerTool {
        name: "ask_online",
        description: "Ask a web-connected answer engine for a synthesized, cited \
                      answer to a current-events or factual question. Prefer this \
                      directly for current prices and product or service \
                      availability; do not precede it with web_search.",
        parameters: query_schema,
    },
    ServerTool {
        name: "wikipedia",
        description: "Look up an encyclopedia summary of a person, place, thing, \
                      or concept.",
        parameters: query_schema,
    },
    ServerTool {
        name: "wolfram",
        description: "Compute facts, math, unit conversions, and measurements \
                      (population, distances, dates, physical constants).",
        parameters: query_schema,
    },
    ServerTool {
        name: "recall_memory",
        description: "Look up a fact the wearer asked you to remember — what they \
                      like, prefer, own, chose, or told you to keep. Use this for \
                      ANY question about the wearer themself, before saying you \
                      do not know.",
        parameters: recall_schema,
    },
    ServerTool {
        name: "music_discover",
        description: "Verify one exact track against the wearer's active provider before explicit playback. For a ranked or subjective request, first use web_search or ask_online to identify the title and artist, then call this tool. Never use it for an information-only music question. Exact named tracks and ordinary transport controls do not need it.",
        parameters: music_discovery_schema,
    },
];

/// The device actions this tool set exposes to the model, each with **our**
/// description. The parameter schema is derived from the recovered interface, so
/// only the name and the wording live here.
///
/// NOT offered: `CreateMemory`. The pin declares the action (it resolves in
/// `SchemaCatalog`) but `CentralActionHandler` has no handler for it — the class
/// appears only in `ActionUtils` and its own file — so a dispatched
/// `CreateMemory` resolves and then does nothing, and the wearer is told their
/// note was saved. The server-side `remember` tool is the working path.
const DEVICE_TOOL_SET: &[(&str, &str)] = &[
    // --- answering ---------------------------------------------------------
    (
        RESPOND_ACTION,
        "Speak a final spoken response to the wearer.",
    ),
    (
        "Narrate",
        "Narrate a spoken line to the wearer without ending the turn.",
    ),
    (
        "UnderstandScene",
        "Answer a question about what the wearer is currently looking at.",
    ),
    (
        "ExplainFailure",
        "Explain why the request could not be completed.",
    ),
    // --- clock -------------------------------------------------------------
    ("SetTimer", "Start a countdown timer on the pin."),
    ("EditTimer", "Change the duration of an existing timer."),
    ("DisplayTimer", "Show a timer, or all timers."),
    ("PauseTimer", "Pause a running timer."),
    ("ResumeTimer", "Resume a paused timer."),
    // NOT offered: "DeleteTimer" / "CancelAlarm". Humane's support article lists
    // deletion as a supported voice command ("Delete Alarms: 'Remove existing
    // alarms'"), and both actions are real — but `catalog_generated` records
    // `central: false` for each, so they are absent from the pin's central
    // SchemaCatalog and `JsonResolver.resolve` returns null. Dispatched directly
    // they bounce as an unrecognized function. The wearer reaches them through
    // the `Timer` / `Alarm` agent wrappers below, which hand off to the Clock
    // sub-agent that owns those actions. The archive describes the CAPABILITY;
    // the decompile decides the ROUTE.
    ("SetAlarm", "Set an alarm for a given time."),
    ("DisplayAlarm", "Show an alarm, or all alarms."),
    ("WorldClock", "Report the current time in another place."),
    ("GetCurrentTime", "Report the wearer's current local time."),
    // --- contacts / communication -----------------------------------------
    ("CreateContact", "Create a new contact."),
    ("OpenContacts", "Open the contacts experience."),
    ("CallPerson", "Place a phone call to a contact."),
    ("EndCall", "End the call in progress."),
    ("AcceptCall", "Answer the incoming call."),
    ("ComposeMessage", "Compose a message to a contact."),
    ("DisplayMessages", "Show the wearer's messages."),
    ("MessageSearch", "Search the wearer's messages."),
    // --- music -------------------------------------------------------------
    (
        "PlayMusic",
        "Play a named artist, album, track, genre, or existing playlist. Never use for an open-ended request with no named selection; use PlayFeaturedMusic instead.",
    ),
    ("PauseMusic", "Pause playback."),
    ("ResumeMusic", "Resume playback."),
    ("NextTrack", "Skip to the next track."),
    ("PreviousTrack", "Go back to the previous track."),
    ("RestartTrack", "Restart the current track."),
    ("GetMusicQueue", "Report what is queued to play."),
    (
        "SaveCurrentTrackToFavorites",
        "Save the current track to the wearer's favorites.",
    ),
    ("PlayFavoriteTracks", "Play the wearer's favorite tracks."),
    (
        "GenerateMusicPlaylist",
        "Build a new playlist matching a description; never use for an existing playlist.",
    ),
    // --- capture -----------------------------------------------------------
    ("CapturePhotograph", "Take a photo."),
    ("CaptureVideo", "Start recording video."),
    ("StopVideo", "Stop recording video."),
    ("OpenRecentPhotos", "Show recently captured photos."),
    // --- translation -------------------------------------------------------
    ("Translate", "Translate a phrase into another language."),
    ("StartTranslation", "Begin live translation."),
    ("StopTranslation", "End live translation."),
    // --- memory / catch-up -------------------------------------------------
    //
    // `CreateMemory` is deliberately NOT here. It looks dispatchable — the
    // recovered interface has it (`CreateMemoryAction`, `experience=CENTRAL`,
    // `nameForModel="CreateMemory"`) and it is in the central `SchemaCatalog` —
    // but `CentralActionHandler.resolve(Action)` has no `instanceof
    // CreateMemoryAction` branch, so it falls through the whole chain to
    // `new ErrorObservation(action.identifier(), "Failed, unknown Action.")`
    // (CentralActionHandler.java:956). Emitted as this loop's terminal action,
    // that means the pin fails it and the wearer hears nothing at all.
    //
    // Stock never routes it through the model: note capture is a *device*-
    // initiated quick action that skips the action catalog entirely and calls the
    // capture service (`QuickActionRouter.handleNotesAction` builds a
    // `FunctionCall` named "CreateMemory", QuickActionRouter.java:115), and the
    // note body is sealed on the pin before it is uploaded. The server therefore
    // has no key with which to mint a readable note of its own, and the honest
    // home for the write side is the capture path, not a model tool. Recall
    // stays available server-side via `recall_memory`.
    (
        "ClearUnderstandingContext",
        "Clear only the current short-term conversation context.",
    ),
    ("CatchMeUp", "Summarize what the wearer missed."),
    // --- device status + benign settings -----------------------------------
    ("GetBatteryLevel", "Report the battery level."),
    ("GetCurrentLocation", "Report where the wearer is."),
    ("AmIOnline", "Report whether the pin has connectivity."),
    ("GetCurrentVolume", "Report the current volume."),
    // `experience=AGENT_SETTINGS`, `central=true` — the pin CAN resolve it
    // centrally, and it is the one quick-action capability the settings child
    // could not reach. Its sibling `DeviceStatus` is deliberately NOT here:
    // `central=false` means the device answers "Unrecognized function name",
    // exactly the trap `every_device_tool_is_centrally_dispatchable` guards. A
    // status question routes through the `Settings` wrapper instead, where the
    // on-device child resolves it.
    (
        "ChangeQuickAction",
        "Change which action the pin's quick-action gesture runs.",
    ),
    ("SetVolume", "Set the playback volume."),
    ("IncrementVolume", "Turn the volume up."),
    ("DecrementVolume", "Turn the volume down."),
    ("TurnOnWifi", "Turn Wi-Fi on."),
    ("TurnOffWifi", "Turn Wi-Fi off."),
    ("ConnectToWifi", "Connect to a Wi-Fi network."),
    ("TurnOnBluetooth", "Turn Bluetooth on."),
    ("TurnOffBluetooth", "Turn Bluetooth off."),
    ("TurnOnAirplaneMode", "Turn airplane mode on."),
    ("TurnOffAirplaneMode", "Turn airplane mode off."),
    ("TriggerBugReport", "File a bug report."),
    // --- degraded-state experiences (emitted by the gate, not chosen freely) -
    (
        "InstructUnlock",
        "Tell the wearer to unlock the pin to continue.",
    ),
    (
        "InvalidSubscription",
        "Tell the wearer their subscription is not active.",
    ),
    (
        "UnauthorizedDevice",
        "Tell the wearer this pin is not authorized.",
    ),
    // --- sub-agent entry points -------------------------------------------
    //
    // Contacts search, timer/alarm edits, and device settings are owned by
    // sub-agents, not the central catalog — the server cannot dispatch e.g.
    // `SearchContact` directly (the pin answers "Unrecognized function name").
    // It dispatches the agent instead and passes the wearer's intent in the
    // inherited `Request` slot; the sub-agent resolves the concrete action.
    (
        "Contacts",
        "Look something up in the wearer's contacts, or change them. Put the request in Request.",
    ),
    (
        "Timer",
        "Create, change, or cancel a timer. Put the request in Request.",
    ),
    (
        "Alarm",
        "Create, change, or cancel an alarm. Put the request in Request.",
    ),
    (
        "Settings",
        "Read or change a device setting (volume, Wi-Fi, Bluetooth, status). Put the request in Request.",
    ),
    // ======================================================================
    // Full-catalog coverage: the remaining wearer-facing device actions that
    // the pin's central SchemaCatalog can dispatch (`central: true`). Safety-
    // critical control (reset, reboot, power off, emergency/AMBER, lock,
    // Touchcode) and device->server callbacks stay withheld above by policy.
    // ======================================================================
    // --- automations --------------------------------------------------------
    (
        "AddIfThenEntry",
        "Add an if-this-then-that automation. Put the trigger in If and the action in Then.",
    ),
    ("ClearIfThenMap", "Remove all if-then automations."),
    (
        "GetIfThenMapSize",
        "Report how many if-then automations are set.",
    ),
    // --- music --------------------------------------------------------------
    (
        "PlayFeaturedMusic",
        "Play featured or recommended music. Use for an open-ended request such as playing music or something to listen to when no artist, album, track, genre, or playlist is named.",
    ),
    (
        "PlayCurrentTrackRadio",
        "Start a radio station based on the current track.",
    ),
    // --- messages & calling -------------------------------------------------
    ("OpenMessagesMainMenu", "Open the messages menu."),
    ("OpenDialerHome", "Open the phone home screen."),
    ("OpenDialpad", "Open the dialpad."),
    ("OpenRecentCalls", "Open the list of recent calls."),
    ("ResumeCall", "Resume a call that is on hold."),
    (
        "SetQuickMessagingContact",
        "Set which contacts quick messaging reaches. Put contact ids in ids.",
    ),
    // --- connectivity -------------------------------------------------------
    (
        "DisconnectWifi",
        "Disconnect from the current Wi-Fi network.",
    ),
    ("WifiQrScan", "Scan a Wi-Fi QR code to join a network."),
    (
        "GetBluetoothStatus",
        "Report whether Bluetooth is on and what is connected.",
    ),
    (
        "GetAirplaneModeStatus",
        "Report whether airplane mode is on.",
    ),
    ("TurnOnCellularData", "Turn on cellular data."),
    ("TurnOffCellularData", "Turn off cellular data."),
    ("TurnOnCellularRoaming", "Turn on cellular roaming."),
    ("TurnOffCellularRoaming", "Turn off cellular roaming."),
    // --- device info, privacy & fitness -------------------------------------
    ("GetPhoneNumber", "Report the pin's own phone number."),
    ("GetSerialNumber", "Report the pin's serial number."),
    ("EnterPrivacyMode", "Turn on privacy mode."),
    ("OpenTutorial", "Open the pin tutorial."),
    ("StartActivityTracker", "Start tracking a fitness activity."),
    (
        "StopActivityTracker",
        "Stop tracking the current fitness activity.",
    ),
    (
        "ManageNutrition",
        "Log or review food and nutrition. Put the request in Request.",
    ),
    // --- translation, sound & play ------------------------------------------
    (
        "SetDefaultTranslateLanguage",
        "Set the default language for translation. Put it in Language.",
    ),
    ("Tickle", "Trigger the pin's playful tickle response."),
];

/// How the server fills a required slot the model left out.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Backfill {
    /// The slot *is* the wearer's own request, so the utterance can be dropped
    /// straight into it — a restatement of what the wearer said, not invention.
    WearerRequest,
    /// Nothing the server holds can honestly stand in. Bounce instead.
    None,
}

/// One model-facing slot the recovered interface calls OPTIONAL but the device
/// dereferences as if it were REQUIRED.
struct RequiredSlot {
    action: &'static str,
    slot: &'static str,
    /// Keys a model plausibly emits instead. Folded onto `slot` before the action
    /// goes on the wire; case-variants of `slot` itself are always accepted.
    aliases: &'static [&'static str],
    backfill: Backfill,
}

/// Slots the pin will not survive being handed empty.
///
/// `Field.presence` defaults to OPTIONAL for every slot in the interface, so the
/// generated table cannot tell "the device tolerates this missing" apart from
/// "the device's own accessor is declared `@Nonnull`". These are the cases where
/// the decompiled Java is unambiguous:
///
///   * The four agent entry points all extend `AgentAction`, whose
///     `@Nonnull @Field(index=1, nameForModel="Request", type=STRING) mRequest`
///     is handed straight to `SynapseUserRequestContent.newBuilder()
///     .setRequest(mRequest)` (AgentAction.java:36-70). Protobuf setters throw on
///     null, and `TaoAgentV2.understandAsync` calls it on the very first line
///     (`mRegistrar.onRequest(action.request())`, TaoAgentV2.java:387). The
///     Settings agent shares the ironman process — `AGENT_SETTINGS
///     ("hu.ma.ne.ironman", …)`, HumanePackageManager.java:56 — so it takes that
///     NPE directly. Contacts and Clock live in their own packages, so the action
///     parcels across a binder first and `Objects.requireNonNullElse(
///     in.readString(), "")` (AgentAction.java:59) silently turns the missing
///     request into an EMPTY one: the sub-agent runs with no instruction and the
///     wearer gets nothing rather than an error.
///   * `NarrateAction.mNarration` is `@Nonnull` (NarrateAction.java:21-23) and
///     `narration()` is declared to return non-null (NarrateAction.java:85-88);
///     `CentralActionHandler.resolve(NarrateAction)` passes it to
///     `respondEvent.setResponse(...)` (CentralActionHandler.java:359), and the
///     parcel constructor asserts it outright (`Objects.requireNonNull(
///     in.readString())`, NarrateAction.java:46).
///
/// Marking these required in the schema only *asks* the model; `device_action_input`
/// is what enforces it before anything reaches the wire.
const REQUIRED_SLOTS: &[RequiredSlot] = &[
    // A targetless CallPerson cannot place the requested external call. The
    // recovered field is technically optional because the same action type can
    // open call UI, but the central model has a separate OpenDialerHome action
    // for that behavior; treating a missing recipient as executable would turn
    // a model omission into an ambiguous external action.
    RequiredSlot {
        action: "CallPerson",
        slot: "To",
        aliases: &["recipient", "contact", "name"],
        backfill: Backfill::None,
    },
    RequiredSlot {
        action: "Alarm",
        slot: "Request",
        aliases: AGENT_REQUEST_ALIASES,
        backfill: Backfill::WearerRequest,
    },
    RequiredSlot {
        action: "Contacts",
        slot: "Request",
        aliases: AGENT_REQUEST_ALIASES,
        backfill: Backfill::WearerRequest,
    },
    RequiredSlot {
        action: "Settings",
        slot: "Request",
        aliases: AGENT_REQUEST_ALIASES,
        backfill: Backfill::WearerRequest,
    },
    RequiredSlot {
        action: "Timer",
        slot: "Request",
        aliases: AGENT_REQUEST_ALIASES,
        backfill: Backfill::WearerRequest,
    },
    RequiredSlot {
        action: "Narrate",
        slot: "Narration",
        // Never backfilled: the only text the server holds is the wearer's own
        // utterance, and narrating that back is worse than not narrating.
        aliases: &["text", "response", "message", "narrative"],
        backfill: Backfill::None,
    },
];

/// Keys models reach for when they mean `Request`.
const AGENT_REQUEST_ALIASES: &[&str] = &["query", "utterance", "instruction", "text"];

/// The required-slot rules for one action.
fn required_slots_for(action: &str) -> impl Iterator<Item = &'static RequiredSlot> + '_ {
    REQUIRED_SLOTS.iter().filter(move |r| r.action == action)
}

/// Whether a slot holds usable text (present, a string, and not just blanks).
fn slot_is_filled(object: &serde_json::Map<String, Value>, slot: &str) -> bool {
    object.get(slot).is_some_and(|value| !is_blank(value))
}

/// A slot the device will read as absent: null, blank text, or an empty list.
fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// The contract's own spelling of an accepted value, matched case-insensitively.
///
/// The device deserializes these through the experience's `SerialName`
/// declarations, which are exact: `"Tomorrow"` does not parse where the contract
/// says `"tomorrow"`, and the alarm is accepted and never fires. A model that
/// only got the casing wrong picked the right value, so fold it onto the
/// contract's spelling rather than bouncing the turn.
fn canonical_enum_value(text: &str, accepted: &[&'static str]) -> Option<Value> {
    accepted
        .iter()
        .find(|a| a.eq_ignore_ascii_case(text.trim()))
        .map(|a| Value::String((*a).to_owned()))
}

/// Fold a model-supplied value onto the type and value set the contract
/// declares, where the intent is unambiguous.
///
/// `None` means it cannot be made to fit — the caller bounces rather than
/// putting a value on the wire that the pin's `JsonResolver` will drop.
fn coerce_to_field(value: &Value, field: &DeviceField) -> Option<Value> {
    match field.ty {
        FieldType::String => {
            let text = scalar_text(value)?;
            if field.enum_values.is_empty() {
                Some(Value::String(text))
            } else {
                canonical_enum_value(&text, field.enum_values)
            }
        }
        // `5` and `"5"` are the same number; an endpoint that stringifies its own
        // arguments emits the second, and the device wants a JSON number.
        FieldType::Number => match value {
            Value::Number(_) => Some(value.clone()),
            Value::String(s) => {
                serde_json::Number::from_f64(s.trim().parse::<f64>().ok()?).map(Value::Number)
            }
            _ => None,
        },
        FieldType::Boolean => match value {
            Value::Bool(_) => Some(value.clone()),
            Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
                "true" => Some(Value::Bool(true)),
                "false" => Some(Value::Bool(false)),
                _ => None,
            },
            _ => None,
        },
        FieldType::StringList => {
            // The device reads this slot as a JSON array, so a bare `"Dana"`
            // resolves to nothing at all. Wrap it.
            let raw: Vec<Value> = match value {
                Value::Array(items) => items.clone(),
                Value::String(_) | Value::Number(_) | Value::Bool(_) => vec![value.clone()],
                _ => return None,
            };
            let raw = split_constrained_list(raw, field);
            let mut items = Vec::with_capacity(raw.len());
            for item in &raw {
                let text = scalar_text(item)?;
                if field.enum_values.is_empty() {
                    items.push(Value::String(text));
                } else {
                    items.push(canonical_enum_value(&text, field.enum_values)?);
                }
            }
            Some(Value::Array(items))
        }
    }
}

/// A JSON scalar as the string the device would read it as.
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// `"monday, tuesday"` is one string where the device wants two.
///
/// Split only when the slot has a declared value set **and every part is in
/// it** — so `{"To": "Smith, Dana"}` on an unconstrained list is never torn in
/// half, and a comma that is part of a value is left alone.
fn split_constrained_list(raw: Vec<Value>, field: &DeviceField) -> Vec<Value> {
    if field.enum_values.is_empty() {
        return raw;
    }
    let [Value::String(one)] = raw.as_slice() else {
        return raw;
    };
    let parts: Vec<&str> = one
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() > 1
        && parts.iter().all(|p| {
            field
                .enum_values
                .iter()
                .any(|accepted| accepted.eq_ignore_ascii_case(p))
        })
    {
        return parts
            .into_iter()
            .map(|p| Value::String(p.to_owned()))
            .collect();
    }
    raw
}

/// Whether a value is already exactly what the device will deserialize.
fn fits_field(value: &Value, field: &DeviceField) -> bool {
    let in_set = |s: &str| field.enum_values.is_empty() || field.enum_values.contains(&s);
    match field.ty {
        FieldType::String => value.as_str().is_some_and(in_set),
        FieldType::Number => value.is_number(),
        FieldType::Boolean => value.is_boolean(),
        FieldType::StringList => value
            .as_array()
            .is_some_and(|items| items.iter().all(|i| i.as_str().is_some_and(in_set))),
    }
}

/// What this slot accepts, in the words the corrective observation uses.
fn describe_expectation(field: &DeviceField) -> String {
    if !field.enum_values.is_empty() {
        let accepted = field
            .enum_values
            .iter()
            .map(|v| format!("\"{v}\""))
            .collect::<Vec<_>>()
            .join(", ");
        return match field.ty {
            FieldType::StringList => format!("a list drawn from {accepted}"),
            _ => format!("one of {accepted}"),
        };
    }
    match field.ty {
        FieldType::String => "a string".to_owned(),
        FieldType::Number => "a number".to_owned(),
        FieldType::Boolean => "true or false".to_owned(),
        FieldType::StringList => "a list of strings".to_owned(),
    }
}

/// The offending value, short enough not to flood the transcript.
fn abbreviate(value: &Value) -> String {
    let text = value.to_string();
    // Char boundaries, not byte offsets: an argument is arbitrary wearer text.
    match text.char_indices().nth(48) {
        Some((idx, _)) => format!("{}…", &text[..idx]),
        None => text,
    }
}

/// How the model's arguments differ from the recovered contract — declared
/// types, declared value sets, and the contract's own `required` flag.
///
/// [`schema_for`] encodes all three faithfully, but a schema only *asks* the
/// model; the device is what has to deserialize the result. A value outside the
/// experience's `SerialName` set fails to parse on the pin and the action
/// silently does nothing — the difference between a working alarm and one that
/// never fires — and a REQUIRED slot the model omitted resolves to null. Neither
/// is reported back on the wire: the run simply produces nothing. So the check
/// belongs here, before the action is emitted, where it can be turned into an
/// observation the model corrects itself from.
///
/// Keys the contract does not declare are left alone: `device_booleans` are
/// added by [`with_device_defaults`] and are not model-facing fields.
fn contract_violations(
    recovered: &DeviceAction,
    object: &serde_json::Map<String, Value>,
) -> Vec<String> {
    let mut problems = Vec::new();
    for field in recovered.fields {
        match object.get(field.name) {
            Some(value) if !is_blank(value) => {
                if !fits_field(value, field) {
                    problems.push(format!(
                        "\"{}\" must be {} (got {})",
                        field.name,
                        describe_expectation(field),
                        abbreviate(value)
                    ));
                }
            }
            _ if field.required => {
                problems.push(format!("\"{}\" is required and was empty", field.name));
            }
            _ => {}
        }
    }
    problems
}

/// The corrective observation for arguments the device contract rejects.
///
/// Same shape as [`missing_slot_observation`], for the same reason: the loop
/// feeds it back and the model calls the tool again, in-loop, instead of the pin
/// receiving an action it cannot deserialize.
fn invalid_argument_observation(action: &str, problems: &[String]) -> String {
    format!(
        "Rejected \"{action}\": {}. Call \"{action}\" again with corrected arguments.",
        problems.join("; ")
    )
}

/// Build a JSON-schema object from a recovered action's model-facing fields.
///
/// Types and required-ness come straight from the device contract, so a tool the
/// model calls is one the pin's `JsonResolver` will accept — plus the
/// [`REQUIRED_SLOTS`] overrides, where the contract's OPTIONAL is a lie the
/// device's own `@Nonnull` accessors contradict.
fn schema_for(action: &DeviceAction) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    for field in action.fields {
        // Constrain to the values the device will actually deserialize. These
        // come from the experience's own SerialName declarations; a value
        // outside the set fails to parse on the pin and the action silently
        // does nothing, so telling the model the set is the difference between
        // a working alarm and one that never fires.
        let ty = match field.ty {
            FieldType::String if !field.enum_values.is_empty() => {
                json!({ "type": "string", "enum": field.enum_values })
            }
            FieldType::StringList if !field.enum_values.is_empty() => {
                json!({ "type": "array", "items": { "type": "string", "enum": field.enum_values } })
            }
            FieldType::String => json!({ "type": "string" }),
            FieldType::Number => json!({ "type": "number" }),
            FieldType::Boolean => json!({ "type": "boolean" }),
            FieldType::StringList => json!({ "type": "array", "items": { "type": "string" } }),
        };
        properties.insert(field.name.to_owned(), ty);
        let required_by_device = required_slots_for(action.name).any(|r| r.slot == field.name);
        if field.required || required_by_device {
            required.push(field.name);
        }
    }
    json!({
        "type": "object",
        "properties": Value::Object(properties),
        "required": required,
    })
}

/// A tool in this deployment's set, plus how it is executed.
struct CatalogTool {
    def: ToolDef,
    /// Executed on the wearer's pin ⇒ `SynapseActionContent.source = DEVICE`.
    device: bool,
    /// `@Action(enabledInKeyguard=…)` — runs while the pin is locked.
    keyguard: bool,
}

/// The per-request filter cosmos applies before exposing the set to the model:
/// `excluded_tools` subtraction, then the keyguard restriction, then the
/// unsubscribed whitelist (mirroring `routeAction`'s gate order).
#[derive(Clone, Copy, Debug, Default)]
pub struct CatalogContext<'a> {
    /// `device_context.is_locked` — the pin is on the keyguard this turn.
    pub is_locked: bool,
    /// Tools the device asked us to withhold (`SYNAPSE_EXCLUDED_TOOLS`).
    pub excluded: &'a [String],
    /// Whether the caller's account still grants full behavior.
    pub subscribed: bool,
}

impl CatalogContext<'_> {
    /// The unrestricted context (subscribed, unlocked, nothing excluded).
    pub fn unrestricted() -> Self {
        Self {
            is_locked: false,
            excluded: &[],
            subscribed: true,
        }
    }
}

/// This deployment's full tool set, before per-request filtering.
fn catalog() -> Vec<CatalogTool> {
    let mut tools: Vec<CatalogTool> = SERVER_TOOLS
        .iter()
        .map(|t| CatalogTool {
            def: ToolDef {
                name: t.name.to_owned(),
                description: t.description.to_owned(),
                parameters: (t.parameters)(),
            },
            device: false,
            // Server tools never touch the locked device, so the keyguard does
            // not restrict them.
            keyguard: true,
        })
        .collect();

    for (name, description) in DEVICE_TOOL_SET {
        // Every device tool must exist in the recovered interface. A name that
        // does not resolve would come back from the pin as "Unrecognized
        // function name and/or arguments" — a wasted turn — so this is a bug in
        // the list above, not something to emit blindly.
        let Some(action) = catalog_generated::find(name) else {
            debug_assert!(
                false,
                "device tool {name} is not in the recovered interface"
            );
            continue;
        };
        tools.push(CatalogTool {
            def: ToolDef {
                name: action.name.to_owned(),
                description: (*description).to_owned(),
                parameters: schema_for(action),
            },
            device: true,
            keyguard: action.keyguard,
        });
    }
    tools
}

/// The server-owned tool set exposed to the model, filtered for this request.
///
/// Gate order mirrors the device's `routeAction`: subtract `excluded_tools`, then
/// drop keyguard-disabled tools when the pin is locked, then — when the account
/// no longer grants full behavior — keep only the unsubscribed whitelist.
pub fn tool_catalog_for(ctx: &CatalogContext<'_>) -> Vec<ToolDef> {
    tool_catalog_for_set(ctx, toolsets::default_set())
}

/// The tool set the device's `tool_set_version` pointer resolved to, filtered
/// for this request.
///
/// The set is applied as an **intersection**, before the per-request gates: a
/// resolved set can only narrow what this deployment already offers, so a set
/// naming a withheld action cannot reintroduce it. Every filter here removes
/// tools, so their order does not change the result.
pub fn tool_catalog_for_set(ctx: &CatalogContext<'_>, set: &ToolSet) -> Vec<ToolDef> {
    catalog()
        .into_iter()
        .filter(|t| set.offers(&t.def.name))
        .filter(|t| !ctx.excluded.iter().any(|x| x == &t.def.name))
        .filter(|t| !ctx.is_locked || t.keyguard)
        .filter(|t| {
            ctx.subscribed || crate::services::gates::is_enabled_when_unsubscribed(&t.def.name)
        })
        .map(|t| t.def)
        .collect()
}

/// The unrestricted tool set (tests, and callers with no request context).
pub fn tool_catalog() -> Vec<ToolDef> {
    tool_catalog_for(&CatalogContext::unrestricted())
}

/// Whether a tool runs on the device (wearer's pin) rather than server-side.
/// Drives `SynapseActionContent.source` and, in the engine, whether the action is
/// emitted as the terminal action for the pin to execute.
/// Whether this tool runs HERE, on the server.
///
/// The complement of [`is_device_tool`] is not "server tool" — an unknown name is
/// neither, and must bounce as unrecognized rather than be executed. Batched
/// parallel calls therefore test for server-ness explicitly.
pub fn is_server_tool(name: &str) -> bool {
    SERVER_TOOLS.iter().any(|t| t.name == name)
}

pub fn is_device_tool(name: &str) -> bool {
    catalog_generated::find(name).is_some() && !SERVER_TOOLS.iter().any(|t| t.name == name)
}

/// Device actions cannot be represented by the text-only
/// `ServerStatefulUnderstand` response union. Exclude every device action except
/// `Respond`, which is the one terminal action that adapter can faithfully
/// collapse into response text. The full streaming transports keep the complete
/// device catalog.
pub fn stateful_excluded_device_tools() -> Vec<String> {
    DEVICE_TOOL_SET
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| *name != RESPOND_ACTION)
        .map(str::to_owned)
        .collect()
}

/// Build the `SynapseActionContent.input` JSON for a terminal `Respond`, using
/// the device schema's real model-facing field (`Response`).
pub fn respond_input(answer: &str) -> String {
    json!({ RESPOND_FIELD: speakable(answer) }).to_string()
}

/// Strip markup a wearer would otherwise HEAR.
///
/// `Respond.input` is not displayed anywhere on a Pin — `RespondActionHandler`
/// hands it to text-to-speech. So every character in it is spoken, and models
/// routinely answer in markdown: a live turn came back as
/// `William Shakespeare wrote *Hamlet*.`, which a synthesiser reads with the
/// asterisks or stumbles over them. The wearer hears punctuation noise in the
/// middle of an otherwise correct answer.
///
/// Deliberately conservative. It removes the markers that contain no meaning aloud
/// and leaves the words alone — it is not a markdown parser, and anything it does
/// not recognise passes through untouched rather than being mangled.
pub fn speakable(answer: &str) -> String {
    let mut out = String::with_capacity(answer.len());
    let chars: Vec<char> = answer.chars().collect();
    let mut index = 0;

    while index < chars.len() {
        let c = chars[index];
        match c {
            // Emphasis markers: *bold*, **bold**, _italic_, `code`.
            // Only dropped when they wrap text, so "2 * 3" and snake_case names
            // survive — an emphasis marker is never followed by whitespace.
            '*' | '_' | '`' => {
                let is_marker = chars
                    .get(index + 1)
                    .is_none_or(|next| !next.is_whitespace())
                    || out.chars().last().is_some_and(|prev| !prev.is_whitespace());
                if is_marker && answer.matches(c).count() >= 2 {
                    index += 1;
                    continue;
                }
                out.push(c);
                index += 1;
            }
            // Links: [label](url) is spoken as the label alone.
            '[' => {
                let rest: String = chars[index..].iter().collect();
                if let Some(close) = rest.find("](") {
                    if let Some(end) = rest[close..].find(')') {
                        out.push_str(&rest[1..close]);
                        // `str::find` answers in BYTES; `index` walks `chars`.
                        // Advancing by the byte length overshot by one position
                        // for every multi-byte character anywhere in the link,
                        // and the overshoot ate the characters AFTER it — so
                        // "Try [café](https://x)!" was spoken as "Try café",
                        // and "Book [café](x) and [théâtre](y) tonight." came
                        // out "Book caféand théâtreonight." Two links, two eaten
                        // characters, mid-word. A URL is enough on its own:
                        // "/wiki/Café" does it with a pure-ASCII label.
                        //
                        // The Pin has no screen, so this string IS the answer —
                        // `RespondActionHandler` speaks it and nothing marks the
                        // cut. A wearer cannot tell a truncated answer from a
                        // wrong one, which is worse than the markup noise this
                        // function exists to remove. Convert the span to a char
                        // count so both sides of the `+=` are in one unit.
                        index += rest[..close + end + 1].chars().count();
                        continue;
                    }
                }
                out.push(c);
                index += 1;
            }
            _ => {
                out.push(c);
                index += 1;
            }
        }
    }

    // Leading heading/list markers at the start of a line say nothing aloud.
    let cleaned: Vec<String> = out
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let stripped = trimmed
                .strip_prefix("### ")
                .or_else(|| trimmed.strip_prefix("## "))
                .or_else(|| trimmed.strip_prefix("# "))
                .or_else(|| trimmed.strip_prefix("- "))
                .unwrap_or(trimmed);
            stripped.to_owned()
        })
        .collect();

    let joined = cleaned.join(" ");
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Rebuild a terminal `Respond` payload from whatever the model supplied.
///
/// `RespondAction`'s `Response` slot is declared OPTIONAL (`Field.presence`
/// defaults to `OPTIONAL`), so the device does **not** reject a missing key — it
/// resolves `mResponse` to null and then `RespondActionHandler.handleAction`
/// asserts non-null on `action.response()` and **throws**. The wearer hears
/// nothing at all, on the one action that terminates every turn.
///
/// So the server never forwards the model's arguments for `Respond` verbatim: it
/// extracts the text (accepting a differently-cased key, or a bare string) and
/// re-emits the canonical `{"Response": "..."}`. If nothing usable is present the
/// caller should speak its own fallback rather than emit a null-bearing action.
pub fn respond_input_from_arguments(arguments: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(arguments) {
        if let Some(object) = value.as_object() {
            // Exact key first, then any case-variant of it.
            let text = object
                .get(RESPOND_FIELD)
                .or_else(|| {
                    object
                        .iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case(RESPOND_FIELD))
                        .map(|(_, v)| v)
                })
                .and_then(|v| v.as_str());
            if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
                return Some(respond_input(text));
            }
        }
        // A bare JSON string is also usable.
        if let Some(text) = value.as_str().filter(|t| !t.trim().is_empty()) {
            return Some(respond_input(text));
        }
    }
    None
}

/// Populate the DEVICE_ONLY slots the pin dereferences unguarded.
///
/// These are declared `@Nonnull Boolean` and read through accessors returning
/// primitive `boolean` (`OpenRecentPhotosAction.clearStorageState()` does
/// `mClearStorageState.booleanValue()`). A missing slot auto-unboxes null and
/// throws NPE *inside the experience process* — before any observation exists —
/// so the run hangs to the streaming timeout and the wearer hears nothing.
///
/// The model never sees these slots (they are excluded from `schema_for`), so
/// the server supplies them. `false` is the correct default in every case: not
/// triggered from the touchpad, no auto-send, no storage clear. An argument the
/// model already set is left alone.
///
/// This is also where a required slot the model near-missed is folded back onto
/// its canonical key (`{"request": …}` → `{"Request": …}`), and where a value the
/// contract types differently is coerced onto the declared type and value set, so
/// the repair happens on every path that already called this, not only the
/// validating one.
pub fn with_device_defaults(action: &str, arguments: &str) -> String {
    let Some(recovered) = catalog_generated::find(action) else {
        return arguments.to_owned();
    };
    let has_required_slots = required_slots_for(action).next().is_some();
    if recovered.device_booleans.is_empty() && recovered.fields.is_empty() && !has_required_slots {
        return arguments.to_owned();
    }
    let mut value: Value = serde_json::from_str(arguments)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if let Some(object) = value.as_object_mut() {
        for slot in recovered.device_booleans {
            object.entry(*slot).or_insert(Value::Bool(false));
        }
        canonicalize_field_keys(recovered, object);
        canonicalize_required_slots(action, object);
        coerce_to_contract(recovered, object);
    }
    value.to_string()
}

/// Move a slot onto the contract's exact key spelling.
///
/// The device looks the slot up by the `Field`'s `nameForModel` and matches it
/// exactly, so `{"onceDay": …}` and `{"OnceDay": …}` are not the same key: the
/// second resolves to null and the alarm is set for the wrong day. The model
/// that emitted it supplied the right value under the wrong spelling, so fold it
/// rather than discard it. A slot already present under its exact name wins.
fn canonicalize_field_keys(recovered: &DeviceAction, object: &mut serde_json::Map<String, Value>) {
    for field in recovered.fields {
        if object.contains_key(field.name) {
            continue;
        }
        let Some(key) = object
            .keys()
            .find(|k| k.eq_ignore_ascii_case(field.name))
            .cloned()
        else {
            continue;
        };
        if let Some(value) = object.remove(&key) {
            object.insert(field.name.to_owned(), value);
        }
    }
}

/// Coerce every declared slot onto the type and value set the device will
/// deserialize. A value that cannot be coerced is left exactly as the model sent
/// it, so [`contract_violations`] can name it in the bounce.
fn coerce_to_contract(recovered: &DeviceAction, object: &mut serde_json::Map<String, Value>) {
    for field in recovered.fields {
        let Some(current) = object.get(field.name) else {
            continue;
        };
        if let Some(coerced) = coerce_to_field(current, field) {
            if &coerced != current {
                object.insert(field.name.to_owned(), coerced);
            }
        }
    }
}

/// Move a near-miss key onto the canonical slot name the pin resolves.
///
/// The device matches slot names exactly (`JsonResolver` looks up the `Field`'s
/// `nameForModel`), so `{"request": "set a timer"}` resolves `mRequest` to null
/// just as surely as omitting it. A model that only got the *casing* wrong has
/// supplied the wearer's intent; dropping it on the floor would be the server's
/// bug, not the model's.
fn canonicalize_required_slots(action: &str, object: &mut serde_json::Map<String, Value>) {
    for rule in required_slots_for(action) {
        if slot_is_filled(object, rule.slot) {
            continue;
        }
        let found = object
            .iter()
            .find(|(key, value)| {
                (key.eq_ignore_ascii_case(rule.slot)
                    || rule.aliases.iter().any(|a| key.eq_ignore_ascii_case(a)))
                    && value.as_str().is_some_and(|s| !s.trim().is_empty())
            })
            .map(|(key, value)| (key.clone(), value.clone()));
        if let Some((key, value)) = found {
            object.remove(&key);
            object.insert(rule.slot.to_owned(), value);
        }
    }
}

/// Required slots still empty after [`with_device_defaults`] has repaired what it
/// can. Empty means the action is safe to put on the wire.
pub fn missing_required_slots(action: &str, arguments: &str) -> Vec<&'static str> {
    let repaired = with_device_defaults(action, arguments);
    let value: Value = serde_json::from_str(&repaired).unwrap_or_else(|_| json!({}));
    let empty = serde_json::Map::new();
    let object = value.as_object().unwrap_or(&empty);
    required_slots_for(action)
        .filter(|rule| !slot_is_filled(object, rule.slot))
        .map(|rule| rule.slot)
        .collect()
}

/// One concise wearer question when a device action is missing information the
/// model cannot safely invent. Invalid values still go back to the model for
/// self-correction; only absent required fields become a human clarification.
pub fn clarification_question(action: &str, arguments: &str) -> Option<String> {
    let recovered = catalog_generated::find(action)?;
    let repaired = with_device_defaults(action, arguments);
    let value: Value = serde_json::from_str(&repaired).ok()?;
    let object = value.as_object()?;
    let missing = recovered
        .fields
        .iter()
        .find(|field| field.required && !slot_is_filled(object, field.name))
        .map(|field| field.name)
        .or_else(|| missing_required_slots(action, &repaired).into_iter().next())?;

    let question = match (action, missing) {
        ("CallPerson", "To") => "Who should I call?".to_owned(),
        ("ComposeMessage", "To") => "Who should I write the message to?".to_owned(),
        ("ComposeMessage", _) => "What should the message say?".to_owned(),
        ("SetTimer", _) => "How long should the timer run?".to_owned(),
        ("SetAlarm", _) => "What time should I set the alarm for?".to_owned(),
        ("ConnectToWifi", _) => "Which Wi-Fi network should I connect to?".to_owned(),
        ("Translate", _) | ("StartTranslation", _) => {
            "Which language should I translate to?".to_owned()
        }
        ("PlayMusic", _) => "What would you like me to play?".to_owned(),
        _ => {
            let mut label = String::new();
            for (index, character) in missing.chars().enumerate() {
                if index > 0 && character.is_ascii_uppercase() {
                    label.push(' ');
                }
                label.extend(character.to_lowercase());
            }
            format!("What should the {label} be?")
        }
    };
    Some(question)
}

/// The corrective observation for a device action the server refused to emit.
///
/// Shaped like the device's own `"Unrecognized function name and/or arguments"`
/// bounce so the loop treats it the same way: feed it back as an observation and
/// let the model call the tool again, rather than emitting an action whose slot
/// resolves null on the pin.
pub fn missing_slot_observation(action: &str, missing: &[&str]) -> String {
    let slots = missing
        .iter()
        .map(|slot| format!("\"{slot}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Rejected \"{action}\": the device requires {slots} and it was empty. \
         Call \"{action}\" again with the wearer's request in {slots}."
    )
}

/// Validate and repair a device action's arguments before they go on the wire.
///
/// `Ok(input)` is a payload every slot the pin dereferences is filled in;
/// `Err(observation)` is the corrective text to feed back so the model retries.
///
/// `wearer_request` is the utterance this turn is answering. Where a required
/// slot *is* the wearer's request — the four sub-agent entry points inherit
/// `AgentAction.mRequest`, which is exactly "what the wearer asked for" — it is
/// backfilled from that utterance rather than trusted to the model. That is a
/// restatement of the wearer's own words, not fabricated content, and it is what
/// makes the guarantee live in code instead of in the schema's `required` list.
/// Pass `""` when no utterance is available; the slot then bounces.
///
/// The arguments are then checked against the rest of the recovered contract —
/// declared types, declared value sets, declared required-ness — for the same
/// reason: a slot the device cannot deserialize does not fail loudly on the pin,
/// it just quietly does nothing.
pub fn device_action_input(
    action: &str,
    arguments: &str,
    wearer_request: &str,
) -> Result<String, String> {
    if action == "Tickle" && !exact_tickle_request(wearer_request) {
        return Err(
            "Rejected \"Tickle\": the wearer did not use one of the three exact supported phrases."
                .to_owned(),
        );
    }
    let repaired = with_device_defaults(action, arguments);
    let missing = missing_required_slots(action, &repaired);
    let filled = if missing.is_empty() {
        repaired
    } else {
        let mut value: Value = serde_json::from_str(&repaired)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let utterance = wearer_request.trim();
        if let Some(object) = value.as_object_mut() {
            for rule in required_slots_for(action) {
                if rule.backfill == Backfill::WearerRequest
                    && !utterance.is_empty()
                    && !slot_is_filled(object, rule.slot)
                {
                    object.insert(rule.slot.to_owned(), Value::String(utterance.to_owned()));
                }
            }
        }

        let filled = value.to_string();
        let still_missing = missing_required_slots(action, &filled);
        if !still_missing.is_empty() {
            return Err(missing_slot_observation(action, &still_missing));
        }
        filled
    };

    let Some(recovered) = catalog_generated::find(action) else {
        return Ok(filled);
    };
    let value: Value = serde_json::from_str(&filled).unwrap_or_else(|_| json!({}));
    let empty = serde_json::Map::new();
    let problems = contract_violations(recovered, value.as_object().unwrap_or(&empty));
    if problems.is_empty() {
        Ok(filled)
    } else {
        Err(invalid_argument_observation(action, &problems))
    }
}

pub(crate) fn exact_tickle_request(value: &str) -> bool {
    let normalized = value
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
        .join(" ");
    matches!(
        normalized.as_str(),
        "tickle" | "tickle my fancy" | "tickle tickle tickle"
    )
}

pub(crate) fn scope_tickle_to_exact_request(tools: &mut Vec<ToolDef>, wearer_request: &str) {
    if !exact_tickle_request(wearer_request) {
        tools.retain(|tool| tool.name != "Tickle");
    }
}

/// Explanations mention capabilities without authorizing them.
///
/// A request such as "tell me about text messages" needs an answer, not the
/// messages UI. Keep server knowledge tools and the one spoken terminal, but do
/// not offer any device action for a broad explanation request. This is based
/// on the request form rather than the named capability, so it protects every
/// device action consistently.
pub(crate) fn scope_explanation_to_non_device_tools(
    tools: &mut Vec<ToolDef>,
    wearer_request: &str,
) {
    let normalized = wearer_request
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
        .join(" ");
    if normalized.starts_with("tell me about ") {
        tools.retain(|tool| tool.name == RESPOND_ACTION || !is_device_tool(&tool.name));
    }
}

/// Execute a **server-side** tool -> the observation text fed back to the model.
///
/// Device actions never reach here (the pin runs them). `web_search` resolves
/// through the deployment's private SearXNG when `COSMOS_SEARXNG_BASE_URL` is
/// configured, then falls back to the existing SerpApi adapter only when that
/// private search is unavailable or empty. Both implement cosmos's observed
/// `MODE_SERP_API` surface. With no backend wired, every arm reports the
/// capability as absent rather than inventing a result.
/// Per-request context for server-side tools.
///
/// Tools that touch the wearer's own data need to know *whose* data, so this
/// carries the authenticated principal and the stores. It is `None` for callers
/// with no request context (tests), in which case a wearer-scoped tool reports
/// that it has nothing to work with rather than reaching into another account.
#[derive(Clone, Default)]
pub struct ToolContext {
    pub principal: Option<String>,
    /// Whether the deployment has a synthesized online answer backend. Ranked
    /// music gives the model one research path per turn; this chooses the richer
    /// answer engine over raw search snippets when both are connected.
    pub answer_engine_available: bool,
    /// Where the wearer is, when the device told us.
    ///
    /// `SynapseUnderstandingRequest.location` (field 10) — populated on the
    /// encrypted transport from the `LocationEnvelope` the device seals alongside
    /// the utterance. Without this the `weather` and `nearby` tools had no way to
    /// learn a position, so the model either invented coordinates or fell back to
    /// a web search on the one question ("what's near me") the Pin is best placed
    /// to answer. An invented coordinate is worse than none, so this stays
    /// `None` unless the device actually supplied one.
    pub location: Option<(f64, f64)>,
    pub store: Option<crate::store::SharedStore>,
    /// Production's authoritative channel-key directory. When present, tools
    /// must never consult the retired process-local channel map: another
    /// workload may have replaced or revoked the row since this process began.
    pub key_directory: Option<crate::keydirectory::SharedKeyDirectory>,
    /// Test-only/legacy memory topology used when no directory is configured.
    pub keys: Option<crate::keymaterial::SharedKeyMaterial>,
    /// Semantic discovery varies at the external-provider seam. Tests inject a
    /// deterministic adapter; production uses the web + Center adapter.
    pub music_discovery:
        Option<std::sync::Arc<dyn crate::backends::music_discovery::MusicDiscoveryBackend>>,
    /// Absolute turn deadline supplied by the foreground assistant. Backends
    /// that contain multiple dependent stages share this instead of stacking
    /// independent request timeouts beyond the Pin's turn budget.
    pub deadline: Option<std::time::Instant>,
}

/// Counts one tool invocation when the call returns, however it returns.
///
/// A guard rather than a call at each `return`: this function has many exit
/// arms, and an instrumentation point that some arms forget is worse than none —
/// it under-reports silently and the gap looks like the tool was never used.
struct ToolCallRecorder<'a>(&'a str);

impl Drop for ToolCallRecorder<'_> {
    fn drop(&mut self) {
        crate::metrics::record_tool_call(self.0, "completed");
    }
}

pub async fn execute_tool(name: &str, arguments: &str) -> String {
    execute_tool_with(name, arguments, &ToolContext::default()).await
}

/// Execute a server-side tool for a specific wearer.
pub async fn execute_tool_with(name: &str, arguments: &str, context: &ToolContext) -> String {
    // Every server-side tool invocation funnels through here, so this is the one
    // place that can count them without the call sites having to remember to.
    let _tool_span = ToolCallRecorder(name);
    let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    match name {
        "ask_online" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            match crate::backends::perplexity::ask(q).await {
                Ok(text) => text,
                Err(e) => e.observation("answer engine"),
            }
        }
        "wikipedia" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            match crate::backends::wikipedia::lookup(q).await {
                Ok(text) => text,
                Err(e) => e.observation("encyclopedia"),
            }
        }
        "wolfram" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            match crate::backends::wolfram::query(q).await {
                Ok(text) => text,
                Err(e) => e.observation("computational knowledge"),
            }
        }
        "web_search" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            if q.trim().is_empty() {
                return "No search query was supplied.".to_string();
            }
            match crate::backends::search::search(q).await {
                Ok(findings) => findings,
                Err(e) => e.observation("web-search"),
            }
        }
        "remember" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            remember(text, context).await
        }
        "weather" => {
            let Some((lat, lon)) = resolve_point(&args, context).await else {
                return NO_LOCATION.to_string();
            };
            match crate::backends::weather::current(lat, lon).await {
                Ok(w) => describe_weather(&w),
                Err(e) => e.observation("weather"),
            }
        }
        "reverse_geocode" => {
            let Some((lat, lon)) = resolve_point(&args, context).await else {
                return NO_LOCATION.to_string();
            };
            match crate::backends::places::reverse_geocode(lat, lon).await {
                Ok(address) => describe_address(&address),
                Err(e) => e.observation("reverse-geocode"),
            }
        }
        "nearby" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let Some((lat, lon)) = resolve_point(&args, context).await else {
                return NO_LOCATION.to_string();
            };
            match crate::backends::places::nearby(query, Some((lat, lon)), 1_500.0).await {
                Ok(found) => describe_places(&found),
                Err(e) => e.observation("nearby-search"),
            }
        }
        "route" => {
            let destination = args
                .get("destination")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if destination.is_empty() {
                return "No route destination was supplied.".to_string();
            }
            let Some((lat, lon)) = context.location else {
                return NO_LOCATION.to_string();
            };
            let mode = match args.get("mode").and_then(Value::as_str) {
                None => None,
                Some(value) => match crate::backends::places::DirectionsMode::parse(value) {
                    Some(mode) => Some(mode),
                    None => return "The requested route travel mode is unsupported.".to_owned(),
                },
            };
            match crate::backends::places::directions(lat, lon, destination.to_owned(), mode).await
            {
                Ok(route) => describe_route(&route),
                Err(e) => e.observation("directions"),
            }
        }
        "food_lookup" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            if q.trim().is_empty() {
                return "No food was named.".to_string();
            }
            match crate::backends::food::lookup(q).await {
                Ok(found) => describe_food(&found),
                Err(e) => e.observation("food-lookup"),
            }
        }
        "music_discover" => {
            let request = serde_json::from_value::<
                crate::backends::music_discovery::MusicDiscoveryRequest,
            >(args.clone());
            let Some(principal) = context.principal.as_deref() else {
                return crate::backends::music_discovery::MusicDiscoveryError::InvalidRequest
                    .observation()
                    .to_owned();
            };
            let Ok(request) = request else {
                return crate::backends::music_discovery::MusicDiscoveryError::InvalidRequest
                    .observation()
                    .to_owned();
            };
            let production = crate::backends::music_discovery::ProductionMusicDiscovery;
            let result = match context.music_discovery.as_ref() {
                Some(backend) => backend.discover(request, principal, context.deadline).await,
                None => {
                    use crate::backends::music_discovery::MusicDiscoveryBackend;
                    production
                        .discover(request, principal, context.deadline)
                        .await
                }
            };
            match result {
                Ok(track) => crate::backends::music_discovery::observation(&track),
                Err(error) => error.observation().to_owned(),
            }
        }
        "recall_history" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let window = (
                args.get("on_or_after")
                    .and_then(|v| v.as_str())
                    .and_then(|d| day_boundary(d, false)),
                args.get("on_or_before")
                    .and_then(|v| v.as_str())
                    .and_then(|d| day_boundary(d, true)),
            );
            recall_history(q, window, context).await
        }
        "recall_memory" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let window = (
                args.get("on_or_after")
                    .and_then(|v| v.as_str())
                    .and_then(|d| day_boundary(d, false)),
                args.get("on_or_before")
                    .and_then(|v| v.as_str())
                    .and_then(|d| day_boundary(d, true)),
            );
            recall_memory(q, window, context).await
        }
        other => format!("Unknown server tool \"{other}\"."),
    }
}

/// Pull a note's text out of a JSON `arguments` payload, for callers that send
/// one instead of an `utterance`.
pub fn text_argument(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|v| {
            v.get("text")
                .or_else(|| v.get("note"))
                .and_then(|t| t.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

/// How far back Ai Mic / music history reaches, and how much of it.
///
/// Humane's own support article states both: "past Ai Mic searches or music
/// played from the last two weeks (up to 1,000 events)". Honouring them is
/// faithfulness, not a shortcut — and it keeps an unbounded event table off the
/// assistant's latency path.
const HISTORY_WINDOW_DAYS: i64 = 14;
const HISTORY_MAX_EVENTS: i32 = 1_000;
/// How many to actually speak back. The wearer hears this.
const HISTORY_SPOKEN_LIMIT: usize = 5;

/// Search what the wearer asked, and what played.
///
/// Deliberately scoped to Ai Mic and music, per the article: "Only Ai Mic and
/// Music events are searchable." Aggregation ("how many Taylor Swift songs did I
/// listen to") and location filtering are explicitly out of scope there too, and
/// are not attempted here — answering them badly would be worse than declining.
async fn recall_history(
    query: &str,
    window: (
        Option<crate::store::SyncTime>,
        Option<crate::store::SyncTime>,
    ),
    context: &ToolContext,
) -> String {
    let Some(principal) = context.principal.as_deref() else {
        return "No wearer is associated with this request, so nothing can be recalled."
            .to_string();
    };
    let Some(store) = context.store.as_ref() else {
        return "No history store is connected in this deployment.".to_string();
    };

    // Default to the article's two-week horizon when the wearer named no range.
    let start = window.0.or_else(|| {
        let now = crate::store::SyncTime::now().seconds();
        Some(crate::store::SyncTime::from_parts(
            now - HISTORY_WINDOW_DAYS * 86_400,
            0,
        ))
    });

    let needle = query.trim().to_lowercase();
    let mut lines: Vec<String> = Vec::new();
    for event_type in crate::services::events::SEARCHABLE_EVENT_TYPES {
        let Ok(found) = store
            .query_events(
                principal,
                event_type,
                "",
                start,
                window.1,
                HISTORY_MAX_EVENTS,
            )
            .await
        else {
            return "The history store could not be reached, so past activity could not \
                    be searched. This is not the same as there being none."
                .to_string();
        };
        for event in found {
            let Some(text) = event.indexed_text.as_deref() else {
                // Sealed under a key this workload does not hold. Skipped rather
                // than reported as absent — see the note in `recall_memory`.
                continue;
            };
            if needle.is_empty() || text.contains(&needle) {
                lines.push(format!("- {text}"));
            }
            if lines.len() >= HISTORY_SPOKEN_LIMIT {
                break;
            }
        }
        if lines.len() >= HISTORY_SPOKEN_LIMIT {
            break;
        }
    }

    if lines.is_empty() {
        if needle.is_empty() {
            "Nothing is recorded in the wearer's recent history.".to_string()
        } else {
            format!("Nothing in the wearer's recent history matches \"{query}\".")
        }
    } else {
        format!("From the wearer's recent history:\n{}", lines.join("\n"))
    }
}

/// Save what the wearer asked to remember.
///
/// The write counterpart to `recall_memory`. Without it the assistant could read
/// notes it had no way to create: `CreateMemory` is a DEVICE action the pin
/// declares but `CentralActionHandler` has no handler for, so every "remember
/// this" resolved on device and then did nothing.
async fn remember(text: &str, context: &ToolContext) -> String {
    let Some(principal) = context.principal.as_deref() else {
        return "No wearer is associated with this request, so nothing can be saved.".to_string();
    };
    let Some(store) = context.store.as_ref() else {
        return "No memory store is connected in this deployment.".to_string();
    };
    let text = text.trim();
    if text.is_empty() {
        return "There was nothing to save.".to_string();
    }
    // Stored as plaintext-indexed content this server owns. A device-sealed note
    // arrives through `CreateMemory`; this one originates here, so there is no
    // envelope to preserve and nothing is fabricated.
    match store
        .create_indexed_note(principal, None, None, Some(text))
        .await
    {
        Ok(_) => format!("Saved: {text}"),
        Err(_) => "The memory store could not be reached, so that was not saved.".to_string(),
    }
}

/// Open a wearer envelope through the one configured authority.
///
/// `Err` is intentionally distinct from `Ok(None)`: an authoritative lookup
/// failure must not be rendered as "nothing was saved". The local branch is
/// retained solely for unit tests that do not construct a database directory.
async fn open_tool_envelope(
    context: &ToolContext,
    data: &cosmos_crypto::EncryptedData,
) -> Result<Option<Vec<u8>>, ()> {
    if let Some(directory) = context.key_directory.as_ref() {
        return directory.open(data).await.map_err(|error| {
            tracing::warn!(
                %error,
                "authoritative channel-key lookup failed while reading wearer memory"
            );
        });
    }
    let Some(keys) = context.keys.as_ref() else {
        return Ok(None);
    };
    match keys.open(data) {
        Ok(plaintext) => Ok(Some(plaintext)),
        Err(cosmos_crypto::CryptoError::UnknownKid(_))
        | Err(cosmos_crypto::CryptoError::Aead)
        | Err(cosmos_crypto::CryptoError::Envelope(_)) => Ok(None),
        Err(error) => {
            tracing::warn!(
                %error,
                "local channel-key state failed while reading wearer memory"
            );
            Err(())
        }
    }
}

/// What the location-bearing tools report when the turn carries no location.
///
/// The absence is stated rather than papered over: a guessed coordinate produces
/// a confident, specific, wrong answer about a city the wearer is not in, which
/// is worse for them than being told the location is unknown.
const NO_LOCATION: &str = "No location is available for this request, so this cannot be looked up. \
     Say plainly that the location is not known rather than assuming one.";

/// The point a location-bearing tool should use.
///
/// Coordinates supplied by the caller win. Otherwise a place name is resolved
/// through the places backend — a lookup against a real gazetteer, not a guess —
/// so the device's own reverse-geocoded location ("Copenhagen, Denmark") is
/// usable even when the pin sent no numeric fix. `None` when nothing usable is
/// present; the tool then says so.
async fn resolve_point(args: &Value, context: &ToolContext) -> Option<(f64, f64)> {
    if let (Some(lat), Some(lon)) = (
        args.get("latitude").and_then(Value::as_f64),
        args.get("longitude").and_then(Value::as_f64),
    ) {
        // (0, 0) is the null island every unset location field decays to, and it
        // is a real point in the Atlantic that a weather backend will answer for.
        if lat != 0.0 || lon != 0.0 {
            return Some((lat, lon));
        }
    }
    let place = args
        .get("place")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if place.is_empty() {
        // Nothing named: fall back to where the device says the wearer is. This
        // is the "what's near me" case, and it is the whole reason the Pin can
        // answer it better than a browser. Still `None` when the device sent no
        // position — a fabricated coordinate produces a confident answer about
        // the wrong place, which is worse than declining.
        return context.location;
    }
    let found = crate::backends::places::nearby(place, None, 0.0)
        .await
        .ok()?;
    found
        .iter()
        .find_map(|p| p.location.as_ref())
        .map(|l| (l.latitude, l.longitude))
}

/// One spoken sentence of weather. The wire response carries far more than a
/// wearer wants read aloud.
fn describe_weather(w: &cosmos_protocol::aibus::WeatherResponse) -> String {
    let mut parts = Vec::new();
    if !w.weather_text.trim().is_empty() {
        parts.push(w.weather_text.trim().to_owned());
    }
    if w.temperature_fahrenheit != 0.0 || w.temperature_celsius != 0.0 {
        parts.push(format!(
            "{:.0}°F ({:.0}°C)",
            w.temperature_fahrenheit, w.temperature_celsius
        ));
    }
    if w.has_precipitation && !w.precipitation_type.trim().is_empty() {
        parts.push(format!("{} falling", w.precipitation_type.trim()));
    }
    if parts.is_empty() {
        "The weather service returned no conditions.".to_string()
    } else {
        parts.join(", ")
    }
}

/// Nutrition in a form a wearer can hear, not the full nutriment table.
fn describe_food(found: &crate::backends::food::FoodLookup) -> String {
    let mut out = found.item_name.clone();
    if !found.brand.trim().is_empty() {
        out.push_str(&format!(" by {}", found.brand.trim()));
    }
    if !found.serving_size.trim().is_empty() {
        out.push_str(&format!(", per {}", found.serving_size.trim()));
    }
    let mut facts: Vec<(usize, String)> = found
        .nutrition
        .iter()
        .filter_map(|nutrient| {
            describe_nutrient(nutrient)
                .map(|description| (nutrient_priority(nutrient.nutrient_type), description))
        })
        .collect();
    facts.sort_by_key(|(priority, _)| *priority);
    let facts = facts
        .into_iter()
        .take(6)
        .map(|(_, description)| description)
        .collect::<Vec<_>>();
    if !facts.is_empty() {
        out.push_str(&format!(": {}", facts.join(", ")));
    }
    out
}

fn describe_nutrient(nutrient: &cosmos_protocol::common::food::NutritionInfo) -> Option<String> {
    use cosmos_protocol::common::food::NutrientType;

    let nutrient_type = NutrientType::try_from(nutrient.nutrient_type).ok()?;
    let (name, unit) = match nutrient_type {
        NutrientType::Calories => ("calories", "kcal"),
        NutrientType::TotalFat => ("fat", "g"),
        NutrientType::SaturatedFat => ("saturated fat", "g"),
        NutrientType::TransFat => ("trans fat", "g"),
        NutrientType::MonounsaturatedFat => ("monounsaturated fat", "g"),
        NutrientType::PolyunsaturatedFat => ("polyunsaturated fat", "g"),
        NutrientType::TotalCarbs => ("carbohydrates", "g"),
        NutrientType::DietaryFiber => ("fiber", "g"),
        NutrientType::Sugars => ("sugars", "g"),
        NutrientType::Protein => ("protein", "g"),
        NutrientType::Sodium => ("sodium", "mg"),
        NutrientType::Potassium => ("potassium", "mg"),
        NutrientType::Cholesterol => ("cholesterol", "mg"),
        NutrientType::Calcium => ("calcium", "mg"),
        NutrientType::Iron => ("iron", "mg"),
        NutrientType::VitaminC => ("vitamin C", "mg"),
        NutrientType::VitaminA => ("vitamin A", "mcg"),
        NutrientType::Undefined => return None,
    };
    let value = if nutrient.value.fract().abs() < 0.05 {
        format!("{:.0}", nutrient.value)
    } else {
        format!("{:.1}", nutrient.value)
    };
    Some(format!("{name} {value} {unit}"))
}

fn nutrient_priority(nutrient_type: i32) -> usize {
    use cosmos_protocol::common::food::NutrientType;

    match NutrientType::try_from(nutrient_type).ok() {
        Some(NutrientType::Calories) => 0,
        Some(NutrientType::Protein) => 1,
        Some(NutrientType::TotalCarbs) => 2,
        Some(NutrientType::TotalFat) => 3,
        Some(NutrientType::DietaryFiber) => 4,
        Some(NutrientType::Sugars) => 5,
        Some(NutrientType::Sodium) => 6,
        _ => 7,
    }
}

/// A short list of nearby places, names first.
fn describe_places(found: &[cosmos_protocol::aibus::NearbyPlace]) -> String {
    if found.is_empty() {
        return "Nothing was found nearby.".to_string();
    }
    found
        .iter()
        .take(5)
        .map(|p| {
            if p.formatted_address.trim().is_empty() {
                p.name.clone()
            } else {
                format!("{} ({})", p.name, p.formatted_address)
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn describe_address(address: &cosmos_protocol::aibus::ReverseGeocodeResponse) -> String {
    let mut parts = [
        address.municipality.trim(),
        address.country_subdivision.trim(),
        address.country.trim(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .fold(Vec::<&str>::new(), |mut parts, part| {
        if !parts.iter().any(|existing| existing == &part) {
            parts.push(part);
        }
        parts
    });
    if parts.is_empty() {
        parts.extend(
            [address.street_name.trim(), address.postal_code.trim()]
                .into_iter()
                .filter(|part| !part.is_empty()),
        );
    }
    if parts.is_empty() {
        "No location name was found.".to_owned()
    } else {
        parts.join(", ")
    }
}

fn describe_route(route: &cosmos_protocol::aibus::NavigationDirectionsResponse) -> String {
    if route.steps.is_empty() {
        return "No route was found to that destination.".to_string();
    }

    let mut overview = Vec::new();
    if let Some(summary) = plain_route_instruction(&route.summary) {
        overview.push(summary);
    }
    if let Some(distance) = route
        .total_distance
        .as_ref()
        .and_then(|distance| plain_route_instruction(&distance.text))
    {
        overview.push(distance);
    }
    if let Some(duration) = route
        .total_duration
        .as_ref()
        .and_then(|duration| plain_route_instruction(&duration.text))
    {
        overview.push(duration);
    }

    let steps = route
        .steps
        .iter()
        .take(8)
        .filter_map(|step| plain_route_instruction(&step.instruction))
        .collect::<Vec<_>>();
    let overview = if overview.is_empty() {
        "Route found".to_owned()
    } else {
        overview.join(", ")
    };
    if steps.is_empty() {
        overview
    } else {
        format!("{overview}. Directions: {}", steps.join("; "))
    }
}

fn plain_route_instruction(value: &str) -> Option<String> {
    let mut plain = String::with_capacity(value.len());
    let mut inside_tag = false;
    for character in value.chars().take(1_024) {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag && !character.is_control() => plain.push(character),
            _ => {}
        }
    }
    let plain = plain
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!plain.is_empty()).then_some(plain)
}

/// Recall what the wearer asked to remember.
///
/// Searches their own notes and returns the matching text. Only notes the server
/// was able to open (i.e. whose channel key it holds) are searchable — an
/// unopenable note is not silently treated as absent-content, and a wearer with
/// nothing stored gets a plain "nothing found" rather than an invented memory.
/// Recall takes an optional day window as well as a query.
///
/// Humane's own support archive describes the wearer-facing capability as
/// "Search Ai Mic history by date or specific details" — so date was a first-class
/// way in, not a refinement. The store has always supported it
/// (`recent_notes(principal, max, start, end)`); only the tool schema did not, so
/// "what did I note last Tuesday" had no path through. Days rather than instants
/// because that is what a wearer says out loud, and the model can produce a date
/// far more reliably than an epoch.
fn recall_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What to look for. May be empty when searching purely by date."
            },
            "on_or_after": {
                "type": "string",
                "description": "Earliest day to search, as YYYY-MM-DD."
            },
            "on_or_before": {
                "type": "string",
                "description": "Latest day to search, as YYYY-MM-DD."
            }
        }
    })
}

/// Parse a `YYYY-MM-DD` day into a store timestamp at UTC midnight.
///
/// Returns `None` for anything malformed rather than guessing: a misread date
/// silently searches the wrong window and reports "nothing found", which is
/// indistinguishable from the wearer never having saved it.
fn day_boundary(day: &str, end_of_day: bool) -> Option<crate::store::SyncTime> {
    let mut parts = day.trim().split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let date: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&date) {
        return None;
    }
    // Days since the Unix epoch, civil-calendar algorithm (Howard Hinnant's
    // `days_from_civil`) — no chrono dependency for four lines of arithmetic.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + date - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + if end_of_day { 86_399 } else { 0 };
    Some(crate::store::SyncTime::from_parts(seconds, 0))
}

async fn recall_memory(
    query: &str,
    window: (
        Option<crate::store::SyncTime>,
        Option<crate::store::SyncTime>,
    ),
    context: &ToolContext,
) -> String {
    // Distinguish the two absences: a request that carried no authenticated
    // wearer must not read anyone's notes, which is different from a deployment
    // with no store wired.
    let Some(principal) = context.principal.as_deref() else {
        return "No wearer is associated with this request, so nothing can be recalled."
            .to_string();
    };
    let Some(store) = context.store.as_ref() else {
        return "No memory store is connected in this deployment.".to_string();
    };
    if context.key_directory.is_none() && context.keys.is_none() {
        return "No channel-key directory is connected in this deployment.".to_string();
    }
    let window_requested = window.0.is_some() || window.1.is_some();
    let recent_listing_requested = query.trim().is_empty() && !window_requested;

    // LIST/WINDOW PATH. A blank query lists the newest notes. When a date range
    // is given, page the window FIRST and match the query inside it. Searching
    // first and filtering by date afterwards was
    // wrong twice over: `search_notes` truncates to RECALL_LIMIT by recency, so a
    // note inside the window could be ranked out before the window was ever
    // applied — reporting "nothing in that time range" while the note sat in the
    // store — and a pure-date question ("what did I note last Tuesday") had no
    // path at all, because the schema invited it and the handler refused it.
    if window_requested || recent_listing_requested {
        let Ok(notes) = store
            .recent_notes(principal, NOTE_SCAN_LIMIT, window.0, window.1)
            .await
        else {
            return "The memory store could not be reached, so saved notes could not be \
                    searched. This is not the same as the wearer having saved nothing."
                .to_string();
        };
        let needle = query.trim().to_lowercase();
        let mut lines: Vec<String> = Vec::new();
        for note in notes.iter() {
            let text = match note.indexed_text.as_deref() {
                Some(text) if !text.trim().is_empty() => text.to_owned(),
                _ => match note.encrypted_note.as_ref() {
                    Some(sealed) => {
                        let kid = sealed
                            .encryption_information
                            .as_ref()
                            .map(|i| i.kid.clone())
                            .unwrap_or_default();
                        match open_tool_envelope(
                            context,
                            &cosmos_crypto::EncryptedData {
                                data: sealed.data.clone(),
                                kid,
                            },
                        )
                        .await
                        {
                            Ok(Some(plain)) => match String::from_utf8(plain) {
                                Ok(text) => text,
                                Err(_) => continue,
                            },
                            Ok(None) => continue,
                            Err(()) => {
                                return "The channel-key directory could not be reached, so saved notes could not be searched. Retry after the directory recovers.".to_string();
                            }
                        }
                    }
                    None => continue,
                },
            };
            // An empty query means "everything in this range" — the archive's own
            // shape of question ("What did I ask last week?").
            //
            // Otherwise match on stemmed TERM overlap, not on the whole query as
            // one substring. The old `text.contains(&needle)` compared a note
            // against an entire natural-language question, so "What do I like?"
            // — which the model sends as "what the wearer likes preferences
            // favorites interests" — could never match "I like trains". The
            // wearer was told they had saved nothing, about a note they had just
            // saved. Shared with `search_notes` so both paths agree.
            if needle.is_empty() || crate::store::recall_hits(&needle, &text) > 0 {
                lines.push(format!("- {}", text.trim()));
            }
            if lines.len() >= RECALL_LIMIT as usize {
                break;
            }
        }
        if lines.is_empty() {
            return if recent_listing_requested {
                "The wearer has no saved notes.".to_string()
            } else if needle.is_empty() {
                "The wearer saved nothing in that time range.".to_string()
            } else {
                format!("Nothing the wearer saved matching \"{query}\" falls in that time range.")
            };
        }
        return format!("The wearer previously saved:\n{}", lines.join("\n"));
    }

    // Search returns uuids; resolve each back to its text for the model.
    //
    // A store failure is reported as a failure, never as "nothing matched" — the
    // model would otherwise tell the wearer their saved note does not exist.
    let Ok(uuids) = store.search_notes(principal, query, RECALL_LIMIT).await else {
        return "The memory store could not be reached, so saved notes could not be \
                searched. This is not the same as the wearer having saved nothing."
            .to_string();
    };
    if uuids.is_empty() {
        return format!("Nothing the wearer saved matches \"{query}\".");
    }

    let Ok(notes) = store
        .recent_notes(principal, NOTE_SCAN_LIMIT, window.0, window.1)
        .await
    else {
        return "The memory store could not be reached, so the matching notes could \
                not be read back."
            .to_string();
    };
    let mut lines: Vec<String> = Vec::new();
    // Matches whose text could not be produced — outside the scan window, or
    // sealed with a key this server does not hold. Counted, never dropped: the
    // wearer must not be told a note they saved does not exist.
    let mut unreadable = 0usize;
    // Distinct from `unreadable`: a match the requested date window excludes is a
    // correct exclusion, not a note we failed to read. Merging them reported a
    // date search that had narrowed correctly as "their text could not be read
    // back", which reads as an outage and invites the wearer to distrust it.
    let mut outside_window = 0usize;
    // Whether the wearer actually asked for a date range decides what a missing
    // uuid MEANS. With a window, it is a correct exclusion. Without one, it fell
    // past the scan bound and is a match we could not render — which must be
    // reported as such, never as "you never saved that".
    let window_requested = window.0.is_some() || window.1.is_some();
    for uuid in &uuids {
        let Some(note) = notes.iter().find(|n| &n.uuid == uuid) else {
            if window_requested {
                outside_window += 1;
            } else {
                unreadable += 1;
            }
            continue;
        };
        let Some(sealed) = note.encrypted_note.as_ref() else {
            // A note with no device envelope originated HERE — the `remember`
            // tool wrote it, so there is nothing to open and the retrievable copy
            // is the indexed text. Skipping it meant a note the wearer was told
            // was saved could never be recalled: saved, acknowledged, unreachable.
            match note.indexed_text.as_deref() {
                Some(text) if !text.trim().is_empty() => lines.push(format!("- {}", text.trim())),
                _ => unreadable += 1,
            }
            continue;
        };
        let kid = sealed
            .encryption_information
            .as_ref()
            .map(|i| i.kid.clone())
            .unwrap_or_default();
        match open_tool_envelope(
            context,
            &cosmos_crypto::EncryptedData {
                data: sealed.data.clone(),
                kid,
            },
        )
        .await
        {
            Ok(Some(plaintext)) => match String::from_utf8(plaintext) {
                Ok(text) => lines.push(format!("- {}", text.trim())),
                Err(_) => unreadable += 1,
            },
            Ok(None) => unreadable += 1,
            Err(()) => {
                return "The channel-key directory could not be reached, so saved notes could not be recalled. Retry after the directory recovers.".to_string();
            }
        }
    }
    if lines.is_empty() {
        // "Matched but unreadable" is not "nothing matched". Collapsing the two
        // told the wearer a note they had saved did not exist — the one thing
        // this tool must never do.
        if unreadable == 0 && outside_window > 0 {
            // Everything the query matched fell outside the requested range —
            // a real answer, not a fault.
            return format!(
                "Nothing the wearer saved matching \"{query}\" falls in that time range."
            );
        }
        return if unreadable > 0 {
            format!(
                "Saved notes match \"{query}\", but their text could not be read back. This is \
                 not the same as the wearer having saved nothing."
            )
        } else {
            format!("Nothing the wearer saved matches \"{query}\".")
        };
    }
    let mut out = format!("The wearer previously saved:\n{}", lines.join("\n"));
    if unreadable > 0 {
        out.push('\n');
        out.push_str(&if unreadable == 1 {
            "One further match could not be read back.".to_owned()
        } else {
            format!("{unreadable} further matches could not be read back.")
        });
    }
    out
}

/// How many saved notes a single recall folds into the transcript.
const RECALL_LIMIT: i32 = 5;

/// How far back a recall reads to turn matched uuids into text.
///
/// `search_notes` returns uuids only and the store has no read-by-uuid, so the
/// bodies come from a newest-first page. Unbounded — `recent_notes(principal, 0,
/// …)` — that page was the wearer's ENTIRE note table, fetched and decrypted on
/// the assistant's latency path to resolve at most [`RECALL_LIMIT`] of them, and
/// it grew for the life of the account.
///
/// Bounded, a match older than this page cannot be read back. That case is
/// reported as unreadable rather than as "nothing matched", so the degradation
/// is visible instead of silent. A read-by-uuid on the store would remove the
/// tradeoff entirely.
const NOTE_SCAN_LIMIT: i32 = 200;

#[cfg(test)]
mod tests {

    #[test]
    fn food_description_names_and_units_the_useful_nutrients() {
        use cosmos_protocol::common::food::{NutrientType, NutritionInfo};

        let found = crate::backends::food::FoodLookup {
            item_name: "Plain oatmeal".to_owned(),
            brand: "Test".to_owned(),
            barcode: "12345678".to_owned(),
            serving_size: "1 cup".to_owned(),
            ingredients: vec!["oats".to_owned()],
            nutrition: vec![
                NutritionInfo {
                    nutrient_type: NutrientType::Calories as i32,
                    value: 100.0,
                },
                NutritionInfo {
                    nutrient_type: NutrientType::TotalFat as i32,
                    value: 2.0,
                },
                NutritionInfo {
                    nutrient_type: NutrientType::Protein as i32,
                    value: 5.0,
                },
                NutritionInfo {
                    nutrient_type: NutrientType::TotalCarbs as i32,
                    value: 20.0,
                },
                NutritionInfo {
                    nutrient_type: NutrientType::DietaryFiber as i32,
                    value: 3.0,
                },
            ],
        };

        let description = describe_food(&found);
        assert!(description.contains("calories 100 kcal"));
        assert!(description.contains("protein 5 g"));
        assert!(description.contains("carbohydrates 20 g"));
        assert!(description.contains("fiber 3 g"));
        assert!(!description.contains(": 2 100"));
    }

    #[test]
    fn progress_cues_describe_the_selected_work() {
        assert_eq!(
            progress_cue("weather", r#"{"place":"Hvidovre"}"#).as_deref(),
            Some("Checking the weather in Hvidovre")
        );
        assert_eq!(
            progress_cue("nearby", r#"{"query":"coffee","place":"Hvidovre"}"#).as_deref(),
            Some("Finding coffee near Hvidovre")
        );
        assert_eq!(
            progress_cue("web_search", r#"{"query":"FC København result"}"#).as_deref(),
            Some("Looking up FC København result")
        );
        assert_eq!(
            progress_cue(
                "weather_at_place",
                r#"{"location":"Hvidovre","latitude":55.65,"longitude":12.48}"#,
            )
            .as_deref(),
            Some("Checking the weather in Hvidovre")
        );
    }

    #[test]
    fn progress_cues_do_not_echo_private_memory_or_mutations() {
        assert_eq!(
            progress_cue("recall_memory", r#"{"query":"private detail"}"#).as_deref(),
            Some("Checking saved memories")
        );
        assert_eq!(
            progress_cue("remember", r#"{"text":"private detail"}"#),
            None
        );
        assert_eq!(progress_cue("Respond", r#"{"Response":"done"}"#), None);
        assert_eq!(progress_cue("weather", "not json"), None);
    }

    #[test]
    fn progress_cues_from_stock_actions_are_single_bounded_and_normalized() {
        assert_eq!(
            progress_cue_from_action_strings(&[r#"{"weather":{"place":"  Hvidovre\n  "}}"#.into()])
                .as_deref(),
            Some("Checking the weather in Hvidovre")
        );
        assert_eq!(
            progress_cue_from_action_strings(&[
                r#"{"web_search":{"query":"one"}}"#.into(),
                r#"{"web_search":{"query":"one"}}"#.into(),
            ]),
            None
        );
        let long = "ø".repeat(100);
        let cue = progress_cue("web_search", &json!({"query": long}).to_string()).unwrap();
        assert!(cue.ends_with('…'));
        assert!(cue.len() < 80);
        assert!(!cue.contains('\n'));
    }

    /// The wearer's own position must reach a location-taking tool.
    ///
    /// `weather` and `nearby` require coordinates. Nothing supplied them, so on
    /// the one question the Pin is best placed to answer — "what's near me" — the
    /// model either invented a coordinate or fell back to a web search. The
    /// device sends its position in `SynapseUnderstandingRequest.location`.
    #[tokio::test]
    async fn a_location_tool_falls_back_to_where_the_wearer_is() {
        let located = ToolContext {
            location: Some((55.6761, 12.5683)),
            ..Default::default()
        };
        // No coordinates in the arguments: the wearer's position must be used
        // rather than the tool refusing.
        let answer = execute_tool_with("weather", &json!({}).to_string(), &located).await;
        assert!(
            !answer.contains("No location is available"),
            "the wearer's own position must be used when the model omits one: {answer:?}",
        );

        // And with no position anywhere, the tool must say so rather than invent
        // one — a confident answer about the wrong place is worse than none.
        let nowhere = ToolContext::default();
        let refused = execute_tool_with("weather", &json!({}).to_string(), &nowhere).await;
        assert!(
            refused.contains("No location is available"),
            "with no position the tool must decline, never guess: {refused:?}",
        );
    }

    #[tokio::test]
    async fn route_requires_the_pin_location_instead_of_guessing_an_origin() {
        let answer = execute_tool_with(
            "route",
            &json!({"destination": "Central Station"}).to_string(),
            &ToolContext::default(),
        )
        .await;
        assert!(answer.contains("No location is available"));
    }

    #[test]
    fn route_observation_is_bounded_plain_text() {
        let route = cosmos_protocol::aibus::NavigationDirectionsResponse {
            summary: "<b>Main</b> road".to_owned(),
            total_distance: Some(cosmos_protocol::aibus::NavigationDistance {
                text: "<span>2 km</span>".to_owned(),
                value: 2_000,
            }),
            total_duration: Some(cosmos_protocol::aibus::NavigationDuration {
                text: "20&nbsp;mins".to_owned(),
                value: 1_200,
            }),
            steps: vec![
                cosmos_protocol::aibus::NavigationStep {
                    instruction: "Turn <b>left</b> onto Main&nbsp;Street".to_owned(),
                    ..Default::default()
                };
                12
            ],
        };

        let observation = describe_route(&route);
        assert!(observation.starts_with("Main road, 2 km, 20 mins. Directions:"));
        assert!(observation.contains("Turn left onto Main Street"));
        assert!(!observation.contains('<'));
        assert_eq!(observation.matches("Turn left").count(), 8);
    }

    /// Pure-date recall must work: the schema invites it, so the handler must
    /// serve it. "What did I ask last week?" is the archive's own example.
    #[tokio::test]
    async fn recall_works_with_a_date_and_no_query() {
        let context = ToolContext {
            principal: Some("V:01:D:test-pin:U:wearer".to_owned()),
            store: Some(crate::store::MemoryStore::shared()),
            key_directory: None,
            keys: Some(Default::default()),
            ..Default::default()
        };
        execute_tool_with(
            "remember",
            &json!({ "text": "picked up the dry cleaning" }).to_string(),
            &context,
        )
        .await;

        // No query at all — only a window that contains "now".
        let found = execute_tool_with(
            "recall_memory",
            &json!({ "on_or_after": "2020-01-01" }).to_string(),
            &context,
        )
        .await;
        assert!(
            found.contains("dry cleaning"),
            "a date with no query must return what was saved in that range — the \
             schema promises it and the handler used to refuse it: {found:?}",
        );
    }

    #[tokio::test]
    async fn recall_reports_authority_outage_instead_of_nothing_saved_and_retries() {
        let principal = "wearer-directory-recall";
        let kid = "directory-recall-key";
        let key = [0x57; cosmos_crypto::AES_KEY_LEN];
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let directory = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        directory.put(kid, key).await.expect("seed authority");
        let sealed =
            cosmos_crypto::seal(kid, &key, b"the blue key is upstairs", b"").expect("seal note");
        store
            .create_note(
                principal,
                Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: kid.to_owned(),
                        },
                    ),
                    data: sealed.data,
                }),
                None,
            )
            .await
            .expect("store sealed note");
        let context = ToolContext {
            principal: Some(principal.to_owned()),
            answer_engine_available: false,
            store: Some(store),
            key_directory: Some(directory.clone()),
            keys: None,
            location: None,
            music_discovery: None,
            deadline: None,
        };
        let request = json!({ "on_or_after": "2020-01-01" }).to_string();

        directory.fail_next(crate::keydirectory::DirectoryFault::Get);
        let unavailable = execute_tool_with("recall_memory", &request, &context).await;
        assert!(
            unavailable.contains("could not be reached"),
            "{unavailable}"
        );
        assert!(
            !unavailable.contains("saved nothing") && !unavailable.contains("Nothing the wearer"),
            "an authority outage must never be narrated as absence: {unavailable}"
        );

        let retried = execute_tool_with("recall_memory", &request, &context).await;
        assert!(retried.contains("blue key"), "{retried}");
    }

    /// The civil-date arithmetic must be right, or a date search silently
    /// returns the wrong window and reads as "you never saved that".
    #[test]
    fn a_day_parses_to_the_right_utc_boundaries() {
        // 1970-01-01 is the epoch itself.
        assert_eq!(
            day_boundary("1970-01-01", false).map(|t| t.seconds()),
            Some(0)
        );
        assert_eq!(
            day_boundary("1970-01-01", true).map(|t| t.seconds()),
            Some(86_399)
        );
        // A known modern date: 2026-08-04 -> 1785801600.
        assert_eq!(
            day_boundary("2026-08-04", false).map(|t| t.seconds()),
            Some(1_785_801_600)
        );
        // Leap day must not shift the year.
        assert_eq!(
            day_boundary("2024-02-29", false).map(|t| t.seconds()),
            Some(1_709_164_800)
        );
        // Malformed input yields None rather than a guessed window.
        for bad in [
            "",
            "2026",
            "2026-13-01",
            "2026-01-32",
            "yesterday",
            "2026-01-01-01",
        ] {
            assert!(day_boundary(bad, false).is_none(), "{bad:?} must not parse");
        }
    }

    /// A date window must actually narrow what recall returns.
    ///
    /// Humane's support archive describes the capability as "Search Ai Mic
    /// history by date or specific details". The store took a window all along;
    /// the tool schema did not expose one, so there was no path from the wearer's
    /// question to the layer that could answer it.
    #[tokio::test]
    async fn recall_can_be_narrowed_to_a_day_window() {
        let context = ToolContext {
            principal: Some("V:01:D:test-pin:U:wearer".to_owned()),
            store: Some(crate::store::MemoryStore::shared()),
            keys: Some(Default::default()),
            ..Default::default()
        };
        execute_tool_with(
            "remember",
            &json!({ "text": "dentist appointment on the fourteenth" }).to_string(),
            &context,
        )
        .await;

        // A window that cannot contain a note written now must exclude it.
        let long_ago = execute_tool_with(
            "recall_memory",
            &json!({ "query": "dentist", "on_or_before": "1971-01-01" }).to_string(),
            &context,
        )
        .await;
        assert!(
            // The message legitimately echoes the QUERY term, so assert on the
            // note's own content — that is what must not come back.
            !long_ago.contains("appointment"),
            "a date window must actually bound the search: {long_ago:?}",
        );
        assert!(
            long_ago.contains("time range"),
            "an empty window is a correct answer and must say so, not imply a \
             read failure: {long_ago:?}",
        );

        // With no window, the same note is found.
        let unbounded = execute_tool_with(
            "recall_memory",
            &json!({ "query": "dentist" }).to_string(),
            &context,
        )
        .await;
        assert!(
            unbounded.contains("dentist"),
            "the note must still be recallable without a window: {unbounded:?}",
        );
    }

    /// Memory must round-trip: what the wearer asks to remember must be
    /// recallable later.
    ///
    /// Before this the assistant had `recall_memory` (read) and no write tool at
    /// all — the only save path was the `CreateMemory` DEVICE action, which the
    /// pin resolves and then drops on the floor because `CentralActionHandler`
    /// has no handler for it. So "remember my flight is at six" was confirmed to
    /// the wearer and lost.
    #[tokio::test]
    async fn what_the_wearer_asks_to_remember_can_be_recalled() {
        let context = ToolContext {
            principal: Some("V:01:D:test-pin:U:wearer".to_owned()),
            answer_engine_available: false,
            store: Some(crate::store::MemoryStore::shared()),
            key_directory: None,
            keys: Some(Default::default()),
            location: None,
            music_discovery: None,
            deadline: None,
        };

        let saved = execute_tool_with(
            "remember",
            &json!({ "text": "my flight to Copenhagen is at six" }).to_string(),
            &context,
        )
        .await;
        assert!(
            saved.to_lowercase().contains("saved"),
            "the save must be acknowledged truthfully, got {saved:?}",
        );

        let recalled = execute_tool_with(
            "recall_memory",
            &json!({ "query": "flight" }).to_string(),
            &context,
        )
        .await;
        assert!(
            // Case-insensitive: the retrievable copy is the search index, which
            // is lowercased. The wearer hears the model's paraphrase, not this
            // string, so the lost casing is cosmetic — but it IS lost, and a
            // case-sensitive assertion here would be asserting a fiction.
            recalled.to_lowercase().contains("copenhagen"),
            "a saved note must come back from recall — otherwise the wearer was \
             told it was saved and it was not: {recalled:?}",
        );
    }

    /// The configured backends must be reachable BY THE ASSISTANT, not only via
    /// their dedicated RPCs. Keys were configured for weather and places and no
    /// tool could call them, so the model fell back to a web search every time.
    #[test]
    fn the_configured_backends_are_offered_as_tools() {
        let offered: Vec<&str> = SERVER_TOOLS.iter().map(|t| t.name).collect();
        for expected in [
            "weather",
            "reverse_geocode",
            "nearby",
            "route",
            "food_lookup",
            "remember",
            "music_discover",
        ] {
            assert!(
                offered.contains(&expected),
                "{expected} has a working backend but is not offered to the model: {offered:?}",
            );
        }
    }

    /// `CreateMemory` must never be offered: the pin cannot execute it.
    #[test]
    fn creatememory_is_not_offered_because_the_pin_cannot_run_it() {
        assert!(
            !DEVICE_TOOL_SET
                .iter()
                .any(|(name, _)| *name == "CreateMemory"),
            "CreateMemory resolves on device and then does nothing — offering it \
             makes every \"remember this\" a silent no-op",
        );
    }
    use super::*;

    /// REGRESSION: existing in the recovered interface is NOT enough — the pin
    /// only dispatches actions in its CENTRAL `SchemaCatalog`. Anything else is
    /// owned by a sub-agent or experience, and emitting it is answered with
    /// "Unrecognized function name and/or arguments", wasting the wearer's turn.
    /// REGRESSION: `OpenRecentPhotosAction` holds `@Nonnull Boolean
    /// mClearStorageState` and reads it via `clearStorageState()` returning a
    /// primitive — a missing slot auto-unboxes null and throws NPE inside the
    /// photography process, so the run hangs and the wearer hears nothing.
    /// Value sets are interface: `DayOfWeek`/`OnceDay` declare their accepted
    /// strings via SerialName, and anything else fails to deserialize on the pin
    /// — the alarm is accepted and never fires.
    #[test]
    fn constrained_slots_expose_the_devices_accepted_values() {
        let schema = schema_for(catalog_generated::find("SetAlarm").expect("SetAlarm"));
        let props = schema["properties"].as_object().unwrap();
        assert_eq!(props["onceDay"]["enum"], json!(["today", "tomorrow"]));
        assert_eq!(
            props["recurringDays"]["items"]["enum"],
            json!([
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday"
            ])
        );
        // An unconstrained slot stays unconstrained.
        assert!(props["time"].get("enum").is_none());
    }

    #[test]
    fn device_only_booleans_are_populated_so_the_experience_cannot_npe() {
        let filled = with_device_defaults("OpenRecentPhotos", "{}");
        let value: Value = serde_json::from_str(&filled).unwrap();
        assert_eq!(value["TriggeredFromTouchpad"], Value::Bool(false));

        // Even from a non-object, so the same slot is present.
        let from_empty = with_device_defaults("OpenRecentPhotos", "");
        assert_eq!(
            serde_json::from_str::<Value>(&from_empty).unwrap()["TriggeredFromTouchpad"],
            Value::Bool(false)
        );

        // A value the model already supplied is never overwritten.
        let explicit =
            with_device_defaults("OpenRecentPhotos", r#"{"TriggeredFromTouchpad":true}"#);
        assert_eq!(
            serde_json::from_str::<Value>(&explicit).unwrap()["TriggeredFromTouchpad"],
            Value::Bool(true)
        );

        // Actions with no such slot are untouched.
        assert_eq!(
            with_device_defaults("Respond", r#"{"Response":"hi"}"#),
            r#"{"Response":"hi"}"#
        );
        // The model never sees these slots.
        let schema = schema_for(catalog_generated::find("OpenRecentPhotos").unwrap());
        assert!(
            !schema["properties"]
                .as_object()
                .unwrap()
                .contains_key("TriggeredFromTouchpad")
        );
    }

    #[test]
    fn every_device_tool_is_centrally_dispatchable() {
        for (name, _) in DEVICE_TOOL_SET {
            let action = catalog_generated::find(name)
                .unwrap_or_else(|| panic!("{name} is not a recovered stock action"));
            assert!(
                action.central,
                "{name} is not in the pin's central SchemaCatalog — the device \
                 cannot resolve it; dispatch its owning agent instead"
            );
        }
    }

    /// REGRESSION: `CreateMemory` passes every other check in this file — it is
    /// a recovered action, `experience=CENTRAL`, and present in the central
    /// `SchemaCatalog` — yet `CentralActionHandler.resolve(Action)` has no
    /// `instanceof CreateMemoryAction` branch and falls through to
    /// `"Failed, unknown Action."` (CentralActionHandler.java:956). Offered as a
    /// tool it becomes the run's terminal action, the pin fails it, and the
    /// wearer hears nothing.
    #[test]
    fn create_memory_is_not_offered_as_a_device_tool() {
        assert!(
            !DEVICE_TOOL_SET
                .iter()
                .any(|(name, _)| *name == "CreateMemory"),
            "CreateMemory has no CentralActionHandler branch — the pin answers \
             \"Failed, unknown Action.\" and the turn ends in silence"
        );
        assert!(
            !tool_catalog().iter().any(|t| t.name == "CreateMemory"),
            "CreateMemory must not reach the model"
        );
        // The interface for it is still recovered; only the offer is withheld.
        assert!(catalog_generated::find("CreateMemory").is_some());
        // Recall stays available — reading saved notes is a server tool.
        assert!(tool_catalog().iter().any(|t| t.name == "recall_memory"));
    }

    #[test]
    fn internal_renderer_transitions_are_not_offered_as_wearer_tools() {
        for action in ["PlaySound", "PlayRecommendationsWithTrackId"] {
            assert!(
                !DEVICE_TOOL_SET.iter().any(|(name, _)| *name == action),
                "{action} is an internal-only state transition, not a wearer prompt tool"
            );
            assert!(
                !tool_catalog().iter().any(|tool| tool.name == action),
                "{action} must not reach the model"
            );
            assert!(
                catalog_generated::find(action).is_some(),
                "withholding an internal action must not erase its recovered wire contract"
            );
        }
    }

    /// REGRESSION: every slot in the recovered interface carries `presence =
    /// OPTIONAL`, but the four sub-agent entry points inherit
    /// `AgentAction.mRequest`, which is `@Nonnull` and goes straight into
    /// `SynapseUserRequestContent.newBuilder().setRequest(...)`
    /// (AgentAction.java:36-70, called from TaoAgentV2.java:387), and
    /// `NarrateAction.mNarration` is `@Nonnull` and reaches
    /// `respondEvent.setResponse(...)` (CentralActionHandler.java:359).
    #[test]
    fn slots_the_device_dereferences_unguarded_are_marked_required() {
        for agent in ["Settings", "Contacts", "Timer", "Alarm"] {
            let schema = schema_for(catalog_generated::find(agent).expect(agent));
            assert_eq!(
                schema["required"],
                json!(["Request"]),
                "{agent} must require Request — a missing one NPEs the settings \
                 agent in-process and silently empties the others across the binder"
            );
        }
        let narrate = schema_for(catalog_generated::find("Narrate").expect("Narrate"));
        assert_eq!(narrate["required"], json!(["Narration"]));

        // The override does not leak into unrelated actions: SetTimer's slots are
        // genuinely optional in the contract and stay that way.
        let set_timer = schema_for(catalog_generated::find("SetTimer").expect("SetTimer"));
        assert_eq!(set_timer["required"], json!([]));
    }

    /// The schema only *asks* the model. This is the part that guarantees it:
    /// the agent `Request` is backfilled from the wearer's own utterance, and
    /// anything still empty bounces as a corrective observation instead of going
    /// on the wire.
    #[test]
    fn required_slots_are_enforced_server_side_not_left_to_the_model() {
        // Backfilled from the utterance — a restatement of the wearer's own
        // words, which is exactly what the slot means.
        let input = device_action_input("Timer", "{}", "set a five minute timer")
            .expect("the wearer's request is a valid Request");
        assert_eq!(
            serde_json::from_str::<Value>(&input).unwrap()["Request"],
            "set a five minute timer"
        );

        // A near-miss key is folded onto the canonical name rather than dropped;
        // the device matches slot names exactly.
        for near_miss in [
            r#"{"request":"turn the volume down"}"#,
            r#"{"REQUEST":"turn the volume down"}"#,
            r#"{"query":"turn the volume down"}"#,
        ] {
            let input = device_action_input("Settings", near_miss, "")
                .unwrap_or_else(|e| panic!("{near_miss} should repair, got: {e}"));
            let value: Value = serde_json::from_str(&input).unwrap();
            assert_eq!(value["Request"], "turn the volume down", "{near_miss}");
            assert_eq!(value.as_object().unwrap().len(), 1, "{near_miss}");
        }

        // What the model supplied wins over the utterance.
        let explicit = device_action_input("Contacts", r#"{"Request":"find Dana"}"#, "who is dana")
            .expect("explicit Request");
        assert_eq!(
            serde_json::from_str::<Value>(&explicit).unwrap()["Request"],
            "find Dana"
        );

        // Nothing to backfill from => bounce, never a null-bearing action.
        for (arguments, utterance) in [("{}", ""), (r#"{"Request":"  "}"#, "   "), ("", "")] {
            let bounced = device_action_input("Alarm", arguments, utterance)
                .expect_err("an empty Request must not reach the pin");
            assert!(bounced.contains("Request"), "{bounced}");
            assert!(bounced.contains("Alarm"), "{bounced}");
        }

        // `Narrate` is never backfilled: the only text the server holds is the
        // wearer's own utterance, and narrating that back is worse than silence.
        let narrate = device_action_input("Narrate", "{}", "what is the capital of France")
            .expect_err("Narrate without Narration must bounce");
        assert!(narrate.contains("Narration"), "{narrate}");
        // But a miscased Narration is still usable.
        let repaired = device_action_input("Narrate", r#"{"narration":"Looking that up."}"#, "")
            .expect("miscased Narration repairs");
        assert_eq!(
            serde_json::from_str::<Value>(&repaired).unwrap()["Narration"],
            "Looking that up."
        );

        // Actions with no required slots are passed through untouched.
        assert!(device_action_input("PauseMusic", "{}", "").is_ok());
    }

    #[test]
    fn tickle_requires_one_of_the_three_exact_wearer_phrases() {
        for utterance in ["Tickle.", "Tickle my fancy.", "Tickle tickle tickle."] {
            device_action_input("Tickle", "{}", utterance)
                .unwrap_or_else(|error| panic!("{utterance:?} should be authoritative: {error}"));
        }

        for utterance in [
            "Please tickle.",
            "Could you tickle?",
            "What happens if I say tickle?",
            "Do not tickle.",
        ] {
            assert!(
                device_action_input("Tickle", "{}", utterance).is_err(),
                "{utterance:?} must not dispatch the exact stock action"
            );
        }
    }

    #[test]
    fn music_provider_verification_requires_the_researched_exact_track() {
        let tool = tool_catalog()
            .into_iter()
            .find(|tool| tool.name == "music_discover")
            .expect("music_discover");
        assert_eq!(
            tool.parameters["required"],
            json!(["artist", "title", "criterion", "timeframe"])
        );
        assert!(tool.description.contains("before explicit playback"));
        assert!(
            tool.description
                .contains("first use web_search or ask_online")
        );
        assert!(
            tool.description
                .contains("Never use it for an information-only")
        );
    }

    #[test]
    fn a_missing_required_device_value_becomes_one_concise_clarification() {
        assert_eq!(
            clarification_question("CallPerson", "{}"),
            Some("Who should I call?".to_owned())
        );
        assert_eq!(
            clarification_question("CallPerson", r#"{"To":"Dana"}"#),
            None,
            "a complete action must not ask an unnecessary question"
        );
        assert_eq!(
            clarification_question("PauseMusic", "{}"),
            None,
            "a zero-argument control is already unambiguous"
        );
    }

    /// REGRESSION: `schema_for` encoded the contract's types, value sets, and
    /// required flags faithfully — and nothing enforced any of them. The schema
    /// only *asks* the model; the pin is what has to deserialize, and a slot it
    /// cannot parse does not come back as an error. It resolves to null and the
    /// action quietly does nothing, so `{"onceDay": "Sunday"}` was an alarm the
    /// wearer was told about and that never fired.
    #[test]
    fn device_arguments_are_validated_against_the_recovered_contract() {
        // --- value sets -----------------------------------------------------
        // Casing is a near-miss, not a different value: fold it onto the
        // contract's own SerialName spelling.
        let ok = device_action_input("SetAlarm", r#"{"onceDay":"Tomorrow"}"#, "")
            .expect("a case-variant of an accepted value is repairable");
        assert_eq!(
            serde_json::from_str::<Value>(&ok).unwrap()["onceDay"],
            "tomorrow"
        );
        // A value outside the set is not repairable, and must not be emitted.
        let bounced = device_action_input("SetAlarm", r#"{"onceDay":"sunday"}"#, "")
            .expect_err("a value outside the device's set must not reach the pin");
        assert!(bounced.contains("onceDay"), "{bounced}");
        assert!(bounced.contains("\"today\""), "{bounced}");
        assert!(bounced.contains("\"tomorrow\""), "{bounced}");

        // --- lists ----------------------------------------------------------
        // The device reads this slot as a JSON array; a bare string resolves to
        // nothing, so wrap it rather than bouncing a usable value.
        let wrapped = device_action_input("CallPerson", r#"{"To":"Dana"}"#, "call dana")
            .expect("a single recipient is a one-element list");
        assert_eq!(
            serde_json::from_str::<Value>(&wrapped).unwrap()["To"],
            json!(["Dana"])
        );
        let days = device_action_input("SetAlarm", r#"{"recurringDays":"Monday, tuesday"}"#, "")
            .expect("a constrained list is split only into accepted values");
        assert_eq!(
            serde_json::from_str::<Value>(&days).unwrap()["recurringDays"],
            json!(["monday", "tuesday"])
        );
        // A comma inside an unconstrained value is never a separator.
        let name = device_action_input("CallPerson", r#"{"To":"Smith, Dana"}"#, "")
            .expect("an unconstrained list is not split");
        assert_eq!(
            serde_json::from_str::<Value>(&name).unwrap()["To"],
            json!(["Smith, Dana"])
        );
        let bad_day = device_action_input("SetAlarm", r#"{"recurringDays":["Funday"]}"#, "")
            .expect_err("a day outside the set must not reach the pin");
        assert!(bad_day.contains("recurringDays"), "{bad_day}");

        // --- types ----------------------------------------------------------
        // `"5"` is the shape an endpoint that stringifies its own arguments
        // emits; the number it meant is unambiguous.
        let coerced = device_action_input("SetTimer", r#"{"minuteDuration":"5"}"#, "")
            .expect("a numeric string is a number");
        assert_eq!(
            serde_json::from_str::<Value>(&coerced).unwrap()["minuteDuration"],
            json!(5.0)
        );
        let words = device_action_input("SetTimer", r#"{"minuteDuration":"five"}"#, "")
            .expect_err("a word is not a number the device can parse");
        assert!(words.contains("minuteDuration"), "{words}");
        assert!(words.contains("number"), "{words}");

        // --- the contract's own required flag -------------------------------
        // `UnderstandScene.Question` is REQUIRED in the recovered interface, and
        // nothing checked it: the pin resolved null and answered nothing.
        let no_question = device_action_input("UnderstandScene", "{}", "what is this")
            .expect_err("a REQUIRED slot must not be emitted empty");
        assert!(no_question.contains("Question"), "{no_question}");
        assert!(
            device_action_input("UnderstandScene", r#"{"Question":"what is this"}"#, "").is_ok()
        );

        // --- key spelling ---------------------------------------------------
        // The device matches slot names exactly, so a miscased key is a null
        // slot. The value is right; only the spelling is wrong.
        let miscased = device_action_input("SetAlarm", r#"{"OnceDay":"today"}"#, "")
            .expect("a miscased key is repairable");
        let value: Value = serde_json::from_str(&miscased).unwrap();
        assert_eq!(value["onceDay"], "today");
        assert!(value.get("OnceDay").is_none());

        // Slots the contract does not declare are left alone — `device_booleans`
        // are added by the server and are not model-facing fields.
        let photos = device_action_input("OpenRecentPhotos", "{}", "")
            .expect("device-only booleans are not contract violations");
        assert_eq!(
            serde_json::from_str::<Value>(&photos).unwrap()["TriggeredFromTouchpad"],
            Value::Bool(false)
        );
    }

    /// The weather and nearby tools must be able to use a REAL pin's location.
    ///
    /// They required latitude/longitude and nothing supplied them, so the model
    /// either invented a coordinate — a confident, specific answer about a city
    /// the wearer is not in — or fell back to a web search on a turn where a
    /// wired backend was sitting right there.
    #[tokio::test]
    async fn location_tools_accept_the_wearers_reported_place_and_never_invent_one() {
        let schema = coordinate_schema();
        assert!(
            schema["properties"].get("place").is_some(),
            "weather must accept the place the device reverse-geocoded, not only \
             coordinates the model would have to invent"
        );
        assert_eq!(
            schema["required"],
            json!([]),
            "requiring a coordinate the turn does not contain is what forced the \
             model to make one up"
        );
        assert!(nearby_schema()["properties"].get("place").is_some());
        assert_eq!(
            nearby_schema()["required"],
            json!([]),
            "a general nearby request legitimately has no category query",
        );

        // Coordinates the device sent are used as-is.
        assert_eq!(
            resolve_point(
                &json!({ "latitude": 55.6761, "longitude": 12.5683 }),
                &ToolContext::default()
            )
            .await,
            Some((55.6761, 12.5683))
        );
        // Null island is what an unset location field decays to, and a weather
        // backend answers for it — so it is treated as no location at all.
        assert_eq!(
            resolve_point(
                &json!({ "latitude": 0.0, "longitude": 0.0 }),
                &ToolContext::default()
            )
            .await,
            None
        );
        // No location at all: no lookup is attempted and the absence is stated.
        assert_eq!(
            resolve_point(&json!({}), &ToolContext::default()).await,
            None
        );

        let spoken = execute_tool("weather", "{}").await;
        assert!(
            spoken.to_lowercase().contains("location"),
            "with no location the tool must say so: {spoken}"
        );
        assert!(
            !spoken.chars().any(|c| c.is_ascii_digit()),
            "a location-less weather observation must contain no coordinates or \
             conditions to hallucinate from: {spoken}"
        );
        assert!(
            execute_tool("nearby", r#"{"query":"coffee"}"#)
                .await
                .to_lowercase()
                .contains("location")
        );

        let general_nearby = execute_tool_with(
            "nearby",
            "{}",
            &ToolContext {
                location: Some((55.6761, 12.5683)),
                ..Default::default()
            },
        )
        .await;
        assert!(
            !general_nearby.contains("Nothing to look for was named"),
            "a bare Nearby request must reach the provider: {general_nearby}",
        );
    }

    #[test]
    fn reverse_geocode_observation_leads_with_city_and_stays_bounded() {
        let spoken = describe_address(&cosmos_protocol::aibus::ReverseGeocodeResponse {
            street_number: "1".to_owned(),
            street_name: "Rådhuspladsen".to_owned(),
            municipality: "Copenhagen".to_owned(),
            country_subdivision: "Capital Region".to_owned(),
            country: "Denmark".to_owned(),
            postal_code: "1550".to_owned(),
        });
        assert_eq!(spoken, "Copenhagen, Capital Region, Denmark");
    }

    #[test]
    fn every_device_tool_resolves_in_the_recovered_interface() {
        // A tool the pin cannot resolve is answered with "Unrecognized function
        // name and/or arguments" — a wasted turn for the wearer.
        for (name, description) in DEVICE_TOOL_SET {
            assert!(
                catalog_generated::find(name).is_some(),
                "{name} is not a recovered stock action"
            );
            assert!(!description.is_empty(), "{name} needs a description");
        }
    }

    #[test]
    fn schemas_are_built_from_the_recovered_contract_not_hand_typed() {
        // SetTimer's model-facing fields, straight from the device contract.
        let set_timer = catalog_generated::find("SetTimer").expect("SetTimer");
        let schema = schema_for(set_timer);
        let props = schema["properties"].as_object().expect("object schema");
        for field in ["hourDuration", "minuteDuration", "secondDuration", "name"] {
            assert!(props.contains_key(field), "SetTimer must accept {field}");
        }
        // Device-only slots (Duration/Unit) are never exposed to the model.
        assert!(!props.contains_key("Duration"));
        assert!(!props.contains_key("Unit"));

        // Required-ness carries through: SearchContact.query is REQUIRED.
        let search = catalog_generated::find("SearchContact").expect("SearchContact");
        assert_eq!(schema_for(search)["required"], json!(["query"]));
    }

    /// The assistant can recall what the wearer saved — searching their own
    /// notes and reading back the text, never another account's.
    #[tokio::test]
    async fn recall_returns_the_wearers_own_saved_notes() {
        let store = crate::store::MemoryStore::shared();
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("k".to_owned(), [4u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");

        // The wearer saved a note; the server indexed what it could open.
        let sealed = keys
            .seal("k", b"the wifi password is hunter2", b"")
            .unwrap();
        let note = store
            .create_note(
                "wearer-a",
                Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: sealed.kid.clone(),
                        },
                    ),
                    data: sealed.data,
                }),
                None,
            )
            .await
            .expect("the in-memory store cannot fail");
        store
            .index_note("wearer-a", &note.uuid, "the wifi password is hunter2")
            .await;

        let context = ToolContext {
            principal: Some("wearer-a".to_owned()),
            answer_engine_available: false,
            store: Some(store.clone()),
            key_directory: None,
            keys: Some(keys.clone()),
            location: None,
            music_discovery: None,
            deadline: None,
        };
        let recalled =
            execute_tool_with("recall_memory", r#"{"query":"wifi password"}"#, &context).await;
        assert!(
            recalled.contains("hunter2"),
            "the wearer's own note must be recalled, got: {recalled}"
        );

        // A different wearer must not see it.
        let other = ToolContext {
            principal: Some("wearer-b".to_owned()),
            ..context.clone()
        };
        let miss = execute_tool_with("recall_memory", r#"{"query":"wifi password"}"#, &other).await;
        assert!(!miss.contains("hunter2"), "notes must not cross accounts");

        // Nothing matching yields a plain miss, never an invented memory.
        let nothing =
            execute_tool_with("recall_memory", r#"{"query":"submarine"}"#, &context).await;
        assert!(nothing.contains("Nothing the wearer saved"));
    }

    #[tokio::test]
    async fn an_empty_recall_query_lists_the_wearers_recent_notes() {
        let store = crate::store::MemoryStore::shared();
        let principal = "wearer-listing-notes";
        store
            .create_indexed_note(principal, None, None, Some("Buy coffee beans"))
            .await
            .expect("the in-memory store cannot fail");
        let context = ToolContext {
            principal: Some(principal.to_owned()),
            answer_engine_available: false,
            store: Some(store),
            key_directory: None,
            keys: Some(Default::default()),
            location: None,
            music_discovery: None,
            deadline: None,
        };

        let recalled = execute_tool_with("recall_memory", r#"{"query":""}"#, &context).await;
        assert!(
            recalled.to_ascii_lowercase().contains("buy coffee beans"),
            "an explicit note listing must return recent notes: {recalled}",
        );
    }

    /// REGRESSION: recall resolved matched uuids by fetching the wearer's
    /// **entire** note table — `recent_notes(principal, 0, …)` — on the
    /// assistant's latency path, to read at most [`RECALL_LIMIT`] of them.
    ///
    /// Bounding it has a cost, and the cost must be visible: a match outside the
    /// scan window is reported as unreadable, never as "nothing matched". Telling
    /// a wearer that a note they saved does not exist is the one outcome this
    /// tool must never produce.
    #[tokio::test]
    async fn recall_does_not_read_the_whole_note_table() {
        let store = crate::store::MemoryStore::shared();
        let principal = "wearer-with-a-long-history";
        let context = ToolContext {
            principal: Some(principal.to_owned()),
            answer_engine_available: false,
            store: Some(store.clone()),
            key_directory: None,
            keys: Some(Default::default()),
            location: None,
            music_discovery: None,
            deadline: None,
        };

        // The oldest note, then more than a full scan window of newer ones.
        let oldest = store
            .create_note(principal, None, None)
            .await
            .expect("the in-memory store cannot fail");
        store
            .index_note(
                principal,
                &oldest.uuid,
                "the aardvark paperwork is in the drawer",
            )
            .await;
        for _ in 0..(NOTE_SCAN_LIMIT + 20) {
            let note = store
                .create_note(principal, None, None)
                .await
                .expect("the in-memory store cannot fail");
            store.index_note(principal, &note.uuid, "unrelated").await;
        }

        let recalled = execute_tool_with(
            "recall_memory",
            &json!({ "query": "aardvark" }).to_string(),
            &context,
        )
        .await;
        assert!(
            !recalled.contains("Nothing the wearer saved"),
            "a note that MATCHED must never be reported as absent: {recalled}"
        );
        assert!(
            recalled.contains("could not be read back"),
            "a match outside the scan window must be reported as unreadable: {recalled}"
        );
        assert!(
            !recalled.contains("aardvark paperwork"),
            "reading it back would mean the whole table was scanned: {recalled}"
        );
    }

    /// A note the server cannot open is not the same as a note that does not
    /// exist. Collapsing the two told the wearer their saved note was never
    /// saved — the tool's own doc comment promised otherwise and the code did
    /// not honour it.
    #[tokio::test]
    async fn an_unreadable_note_is_not_reported_as_nothing_saved() {
        let store = crate::store::MemoryStore::shared();
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        let principal = "wearer-with-a-sealed-note";

        // Sealed under a channel key this server does not hold — exactly what a
        // note captured on the pin looks like when the key is gone.
        let note = store
            .create_note(
                principal,
                Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: "a-key-this-server-does-not-hold".to_owned(),
                        },
                    ),
                    data: vec![7u8; 32],
                }),
                None,
            )
            .await
            .expect("the in-memory store cannot fail");
        store
            .index_note(principal, &note.uuid, "the gate code")
            .await;

        let context = ToolContext {
            principal: Some(principal.to_owned()),
            answer_engine_available: false,
            store: Some(store),
            key_directory: None,
            keys: Some(keys),
            location: None,
            music_discovery: None,
            deadline: None,
        };
        let recalled =
            execute_tool_with("recall_memory", r#"{"query":"gate code"}"#, &context).await;
        assert!(
            !recalled.contains("Nothing the wearer saved"),
            "an unopenable note must not be reported as never saved: {recalled}"
        );
        assert!(recalled.contains("could not be read back"), "{recalled}");
    }

    /// A SETTLED FACT MUST NOT COST A LOOKUP.
    ///
    /// `observed`: stable general-knowledge questions were answered directly
    /// by the server without a lookup or native device action. The source
    /// transcript remains in the immutable external evidence baseline and is
    /// not stored in this repository. Avoiding unnecessary lookup preserves
    /// responsiveness for facts the model can answer reliably.
    ///
    /// This pins the RULE, not the model's obedience to it — that is only
    /// measurable against a live backend, and is not what a unit test can show.
    /// A QUESTION ABOUT THE WEARER MUST REACH FOR SAVED NOTES.
    ///
    /// `observed`: a question about a previously saved wearer preference
    /// failed when the memory tool was not called. A related failure selected
    /// history activity instead of saved notes. The source transcript remains
    /// in the immutable external evidence baseline and is not stored here.
    ///
    /// This pins the RULE and the tool split, not the model's obedience — that is
    /// only measurable against a live backend.
    #[test]
    fn the_prompt_sends_questions_about_the_wearer_to_saved_notes() {
        let prompt = system_prompt_for(super::super::toolsets::default_set());
        assert!(
            prompt.contains("recall_memory"),
            "the prompt must name the tool that reads saved notes"
        );
        assert!(
            prompt.contains("no earlier conversation"),
            "the prompt must say why 'established here' is never a source"
        );
        // The two recall tools must be distinguishable from their descriptions
        // alone — picking the wrong one is how a saved note reads as absent.
        let history = tool_catalog()
            .into_iter()
            .find(|t| t.name == "recall_history")
            .expect("recall_history is offered");
        let memory = tool_catalog()
            .into_iter()
            .find(|t| t.name == "recall_memory")
            .expect("recall_memory is offered");
        assert!(
            history.description.contains("recall_memory"),
            "recall_history must point saved-fact questions at recall_memory"
        );
        assert!(
            memory.description.contains("wearer themself")
                || memory.description.contains("remember"),
            "recall_memory must claim questions about the wearer"
        );
    }

    #[test]
    fn the_prompt_tells_the_model_not_to_look_up_settled_facts() {
        let prompt = system_prompt_for(super::super::toolsets::default_set());
        assert!(
            prompt.contains("no lookup"),
            "the prompt must tell the model it may answer without a lookup"
        );
        // The permission has to stay bounded, or it licenses answering
        // "what's the weather" from stale parametric knowledge.
        for changing in ["news", "weather", "prices"] {
            assert!(
                prompt.contains(changing),
                "the rule must still name {changing} as something to look up"
            );
        }
        assert!(
            prompt.contains("whether it is still sold") && prompt.contains("old launch price"),
            "a current price must not collapse into historical launch pricing"
        );
    }

    #[test]
    fn the_prompt_uses_one_synthesized_lookup_for_current_prices() {
        let prompt = system_prompt_for(super::super::toolsets::default_set());
        assert!(
            prompt.contains("use the answer engine directly"),
            "current price and availability questions need the synthesized source first"
        );
        assert!(
            prompt.contains("do not also call web search"),
            "one current-price question must not spend the Pin deadline on both retrieval tools"
        );
    }

    #[test]
    fn open_ended_music_is_distinct_from_named_playback() {
        let prompt = system_prompt_for(super::super::toolsets::default_set());
        assert!(prompt.contains("open-ended playback"));
        assert!(prompt.contains("PlayFeaturedMusic"));
        assert!(prompt.contains("PlayMusic"));

        let tools = tool_catalog();
        let named = tools
            .iter()
            .find(|tool| tool.name == "PlayMusic")
            .expect("named playback is offered");
        let featured = tools
            .iter()
            .find(|tool| tool.name == "PlayFeaturedMusic")
            .expect("featured playback is offered");
        assert!(named.description.contains("named selection"));
        assert!(named.description.contains("PlayFeaturedMusic"));
        assert!(featured.description.contains("open-ended request"));
    }

    #[test]
    fn the_prompt_routes_device_state_reads_to_device_actions() {
        // Stock resolves "what time is it / battery / volume / online / where am I"
        // on-device; the cloud must EMIT the matching device action so the pin reads
        // live state, never recite it from the injected situation line. Pin the rule
        // AND that each named route is a real, dispatchable device action.
        let prompt = system_prompt_for(super::super::toolsets::default_set());
        for action in [
            "GetCurrentTime",
            "GetBatteryLevel",
            "GetCurrentVolume",
            "AmIOnline",
            "GetCurrentLocation",
        ] {
            assert!(
                prompt.contains(action),
                "the prompt must route device-state reads to {action}"
            );
            assert!(
                is_device_tool(action),
                "{action} must be a real, dispatchable device action"
            );
        }
        assert!(
            prompt.contains("authenticated device-context data"),
            "the prompt must forbid reciting authenticated device state"
        );
    }

    #[test]
    fn respond_is_a_device_action_and_web_search_is_a_server_tool() {
        assert!(is_device_tool(RESPOND_ACTION));
        assert!(is_device_tool("SetTimer"));
        assert!(!is_device_tool("web_search"));
        assert!(!is_device_tool("recall_memory"));
        assert!(!is_device_tool("NotARealTool"));
    }

    #[test]
    fn text_stateful_transport_excludes_every_non_response_device_action() {
        let excluded = stateful_excluded_device_tools();
        assert!(!excluded.iter().any(|name| name == RESPOND_ACTION));
        assert!(excluded.iter().any(|name| name == "SetTimer"));
        assert!(excluded.iter().any(|name| name == "PlayMusic"));
        for tool in tool_catalog() {
            if is_device_tool(&tool.name) && tool.name != RESPOND_ACTION {
                assert!(
                    excluded.contains(&tool.name),
                    "{} must be excluded",
                    tool.name
                );
            }
        }
    }

    /// REGRESSION: the device parses `input` with
    /// `JsonParser.parseString(..).getAsJsonObject()` before looking at the slot
    /// list. `""` becomes JsonNull and throws, so the pin bounces
    /// "Unrecognized function name and/or arguments" and the run loops to the
    /// action limit — for an action it could have executed immediately.
    #[test]
    fn tool_arguments_are_always_a_json_object_on_the_wire() {
        use crate::assistant::llm::normalize_arguments;
        // The shapes an OpenAI-compatible endpoint actually emits for a
        // zero-parameter function.
        for empty in ["", "   ", "null", "[]", "\"text\"", "not json"] {
            assert_eq!(
                normalize_arguments(empty),
                "{}",
                "{empty:?} must be coerced to the device's canonical zero-arg form"
            );
        }
        // A real object is passed through untouched.
        assert_eq!(
            normalize_arguments(r#"{"minuteDuration":5}"#),
            r#"{"minuteDuration":5}"#
        );
    }

    /// REGRESSION: `Response` is an OPTIONAL slot, so the device does not reject
    /// a missing key — it resolves null and `RespondActionHandler` asserts
    /// non-null and throws. The wearer hears nothing on the action that ends
    /// every turn, so the server must never forward model arguments verbatim.
    #[test]
    fn respond_payload_is_rebuilt_rather_than_forwarded() {
        // Exact key.
        let exact = respond_input_from_arguments(r#"{"Response":"Paris."}"#).expect("exact");
        assert_eq!(
            serde_json::from_str::<Value>(&exact).unwrap()["Response"],
            "Paris."
        );
        // A model that lowercases the key still produces a resolvable action.
        let lower = respond_input_from_arguments(r#"{"response":"Paris."}"#).expect("lowercased");
        assert_eq!(
            serde_json::from_str::<Value>(&lower).unwrap()["Response"],
            "Paris."
        );
        // A bare string is usable too.
        let bare = respond_input_from_arguments(r#""Paris.""#).expect("bare string");
        assert_eq!(
            serde_json::from_str::<Value>(&bare).unwrap()["Response"],
            "Paris."
        );
        // Nothing usable => None, so the caller speaks its own fallback instead
        // of emitting an action whose Response resolves to null.
        for unusable in ["{}", "", r#"{"Response":""}"#, r#"{"other":"x"}"#, "null"] {
            assert!(
                respond_input_from_arguments(unusable).is_none(),
                "{unusable:?} must not produce a null-bearing Respond"
            );
        }
    }

    #[test]
    fn respond_input_uses_the_recovered_field_name() {
        let v: Value = serde_json::from_str(&respond_input("hello")).unwrap();
        assert_eq!(v["Response"], "hello");
    }

    #[test]
    fn every_tool_has_a_well_formed_object_schema() {
        for t in tool_catalog() {
            assert_eq!(t.parameters["type"], "object", "{} schema", t.name);
            assert!(t.parameters.get("properties").is_some(), "{}", t.name);
            assert!(!t.description.is_empty(), "{}", t.name);
        }
    }

    #[test]
    fn irreversible_and_safety_critical_actions_are_not_model_callable() {
        // Deliberate policy: these exist in the recovered interface but this
        // deployment never offers them to a language model.
        let offered: Vec<String> = tool_catalog().into_iter().map(|t| t.name).collect();
        for withheld in [
            "FactoryReset",
            "UserConfirmedFactoryReset",
            "Reboot",
            "TurnOffDevice",
            "UserConfirmedEmergencyCall",
            "TurnOffEmergencyAlert",
            "TurnOffAmberAlert",
            "SetUpTouchcode",
        ] {
            assert!(
                !offered.iter().any(|n| n == withheld),
                "{withheld} must not be offered to the model"
            );
            // ...but the interface for it is still recovered and available.
            assert!(catalog_generated::find(withheld).is_some());
        }
    }
}

#[cfg(test)]
mod speakable_tests {
    use super::*;

    /// The live turn that exposed this: markdown emphasis reached text-to-speech.
    #[test]
    fn markup_a_wearer_would_hear_is_removed() {
        assert_eq!(
            speakable("William Shakespeare wrote *Hamlet*."),
            "William Shakespeare wrote Hamlet.",
        );
        assert_eq!(
            speakable("**Paris** is the capital."),
            "Paris is the capital."
        );
        assert_eq!(speakable("Run `ls -la` to list."), "Run ls -la to list.");
        assert_eq!(
            speakable("See [the docs](https://x.dev) for more."),
            "See the docs for more."
        );
        assert_eq!(speakable("# Heading\n- one\n- two"), "Heading one two");
    }

    /// It must NOT mangle ordinary answers. A stripper that eats real characters
    /// is worse than the markup it removes, because the wearer gets a wrong
    /// answer instead of a noisy one.
    #[test]
    fn ordinary_answers_pass_through_untouched() {
        for text in [
            "It's 5:54 PM in Tokyo.",
            "Paris.",
            "The Eiffel Tower is 330 metres tall.",
            "Available: music, timers, alarms, answers, and photos.",
            "Your battery is at 62%.",
        ] {
            assert_eq!(speakable(text), text, "{text:?} must be spoken verbatim");
        }
    }

    /// The path the model actually takes — it supplies `Response` in the tool
    /// arguments — must strip too. Both branches funnel through `respond_input`,
    /// and this pins that rather than trusting it.
    #[test]
    fn the_model_supplied_argument_path_is_also_stripped() {
        let built = respond_input_from_arguments(r#"{"Response":"It is *Paris*."}"#)
            .expect("a Response argument yields a payload");
        assert!(built.contains("It is Paris."), "markup survived: {built}");
        assert!(
            !built.contains('*'),
            "asterisk reached the spoken payload: {built}"
        );
    }

    /// Arithmetic and identifiers keep their characters — an emphasis marker is
    /// never followed by whitespace, which is what separates them.
    #[test]
    fn maths_and_identifiers_are_not_mistaken_for_emphasis() {
        assert_eq!(speakable("2 * 3 is 6."), "2 * 3 is 6.");
    }

    /// REGRESSION: the link skip advanced a CHAR index by a BYTE length, so one
    /// character of the answer was eaten for every multi-byte character in the
    /// link — label or URL. The wearer heard the loss without any signal that
    /// something had been cut, and every one of these is a plausible answer for a
    /// device operated in Copenhagen.
    #[test]
    fn a_link_with_non_ascii_characters_does_not_eat_the_words_after_it() {
        assert_eq!(
            speakable("Try [café](https://x)!"),
            "Try café!",
            "the trailing character was swallowed by the byte-length skip"
        );
        assert_eq!(
            speakable("Read [Københavns Universitet](https://ku.dk) today, it opens at nine."),
            "Read Københavns Universitet today, it opens at nine.",
        );
        assert_eq!(
            speakable("Book [café](https://x) and [théâtre](https://y) tonight."),
            "Book café and théâtre tonight.",
            "two links used to eat two characters, mid-word"
        );
        // A non-ASCII URL does it with a pure-ASCII label, which is what the
        // encyclopedia tool returns for accented titles.
        assert_eq!(
            speakable("Visit [site](https://x.dev/café) now, it is open."),
            "Visit site now, it is open.",
        );
    }
}
