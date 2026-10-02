//! The deterministic intent parsers behind the engine's fixed routes: small,
//! auditable utterance shapes (clock, nutrition, routes, message reads,
//! translation, device status, weather, music transport and ranking) that are
//! answered without a model step. `engine::deterministic_device_action` and
//! `engine::location_preflight` decide when each one runs. This module only
//! recognises the shapes. INFERRED throughout: Humane's cloud assistant was not
//! recovered, so these phrasings are Luma's own.

use cosmos_protocol::aibus as pb;

use super::catalog;
use super::engine::{DeterministicDeviceAction, current_run_contains_action, current_utterance};
use super::llm::ToolDef;

pub(super) fn deterministic_world_clock_action(
    req: &pb::SynapseUnderstandingRequest,
    tools: &[ToolDef],
) -> Option<DeterministicDeviceAction> {
    let device_context = req.device_context.as_ref()?;
    if device_context.is_locked
        || !tools.iter().any(|tool| tool.name == "WorldClock")
        || current_run_contains_action(&device_context.turns, "WorldClock")
    {
        return None;
    }
    let location = explicit_world_clock_location(current_utterance(req))?;
    Some(DeterministicDeviceAction {
        name: "WorldClock",
        input: serde_json::json!({"Location": location}).to_string(),
        thought: "The wearer asked the Pin to show the current time in a named location",
    })
}

fn explicit_world_clock_location(raw: &str) -> Option<String> {
    const MAX_CLOCK_REQUEST_BYTES: usize = 512;

    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_CLOCK_REQUEST_BYTES
        || trimmed.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return None;
    }
    let body = trimmed
        .strip_suffix('?')
        .or_else(|| trimmed.strip_suffix('.'))
        .or_else(|| trimmed.strip_suffix('!'))
        .unwrap_or(trimmed);
    if body.contains(['?', '.', '!', ',', '"', '-']) {
        return None;
    }

    let words = body.split_whitespace().collect::<Vec<_>>();
    let normalized = words
        .iter()
        .map(|word| word.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let location_start = [
        &["what's", "the", "current", "time", "in"][..],
        &["what", "s", "the", "current", "time", "in"][..],
        &["what", "time", "is", "it", "in"][..],
        &["current", "time", "in"][..],
    ]
    .into_iter()
    .find_map(|prefix| {
        (normalized.len() >= prefix.len()
            && normalized
                .iter()
                .zip(prefix)
                .all(|(word, expected)| word == expected))
        .then_some(prefix.len())
    })?;
    let location = &words[location_start..];
    if !(1..=3).contains(&location.len())
        || location.iter().any(|word| {
            !word.bytes().all(|byte| byte.is_ascii_alphabetic())
                || matches!(
                    word.to_ascii_lowercase().as_str(),
                    "also" | "and" | "or" | "please" | "then"
                )
        })
    {
        return None;
    }
    Some(location.join(" "))
}

pub(super) fn explicit_clock_agent_request(utterance: &str) -> Option<(&'static str, &str)> {
    const MAX_CLOCK_REQUEST_BYTES: usize = 512;
    const COMMANDS: &[&str] = &[
        "add", "cancel", "create", "delete", "display", "extend", "list", "pause", "remove",
        "resume", "set", "show", "start",
    ];

    let utterance = utterance.trim();
    if utterance.is_empty()
        || utterance.len() > MAX_CLOCK_REQUEST_BYTES
        || utterance.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return None;
    }
    let mut normalized = utterance
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character.is_whitespace() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for prefix in [
        "can you please ",
        "could you please ",
        "would you please ",
        "can you ",
        "could you ",
        "would you ",
        "please ",
    ] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            normalized = rest.to_owned();
            break;
        }
    }
    let mut words = normalized.split_whitespace();
    let command = words.next()?;
    if !COMMANDS.contains(&command) {
        return None;
    }
    let words: Vec<_> = std::iter::once(command).chain(words).collect();
    if words.iter().any(|word| matches!(*word, "timer" | "timers")) {
        Some(("Timer", utterance))
    } else if words.iter().any(|word| matches!(*word, "alarm" | "alarms")) {
        Some(("Alarm", utterance))
    } else {
        None
    }
}

pub(super) fn explicit_nutrition_request(utterance: &str) -> Option<&str> {
    const MAX_NUTRITION_REQUEST_BYTES: usize = 512;

    let utterance = utterance.trim();
    if utterance.is_empty()
        || utterance.len() > MAX_NUTRITION_REQUEST_BYTES
        || utterance.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return None;
    }

    let mut normalized = utterance
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character.is_whitespace() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for prefix in [
        "can you please ",
        "could you please ",
        "would you please ",
        "can you ",
        "could you ",
        "would you ",
        "please ",
    ] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            normalized = rest.to_owned();
            break;
        }
    }

    if normalized.starts_with("i ate at ") || normalized.starts_with("i just ate at ") {
        return None;
    }
    let starts_with_any = |prefixes: &[&str]| {
        prefixes
            .iter()
            .any(|prefix| normalized == prefix.trim_end() || normalized.starts_with(prefix))
    };
    let explicit_food_log_addition = normalized.strip_prefix("add ").is_some_and(|remainder| {
        [" to my food log", " to the food log"]
            .iter()
            .any(|suffix| {
                remainder
                    .strip_suffix(suffix)
                    .is_some_and(|items| !items.trim().is_empty())
            })
    });
    let explicit = starts_with_any(&[
        "i ate ",
        "i just ate ",
        "i drank ",
        "log that i ate ",
        "track that i ate ",
        "track my meal ",
        "track my food ",
        "log my meal ",
        "log my food ",
        "add this meal to my food log",
        "add this food to my food log",
        "what are the nutrition facts for ",
        "what is the nutrition information for ",
        "nutrition information for ",
        "nutrition facts for ",
        "how many calories are in ",
        "how many calories in ",
        "how much protein is in ",
        "how much protein in ",
        "how much sugar is in ",
        "how much sugar in ",
    ]) || explicit_food_log_addition
        || matches!(
            normalized.as_str(),
            "what have i eaten today"
                | "what did i eat today"
                | "what have i eaten"
                | "show my food log"
                | "show me my food log"
                | "how many calories did i eat today"
                | "how many calories have i eaten today"
        )
        || (normalized.starts_with("what have i eaten in the last ")
            && normalized.ends_with(" days"))
        || (normalized.starts_with("show my food log for the last ")
            && normalized.ends_with(" days"));
    explicit.then_some(utterance)
}

pub(super) fn explicit_route_request(utterance: &str) -> bool {
    let Some(normalized) = normalized_intent(utterance) else {
        return false;
    };
    route_command(utterance).is_some()
        || (normalized.starts_with("find the nearest ")
            && normalized.ends_with(" and navigate there"))
}

/// Extract the destination and optional Google-compatible travel mode from a
/// direct route command. Nearest-place navigation stays model-led because the
/// destination must first be resolved by `nearby`, which ranks by distance. A
/// route lookup of "the nearest coffee shop" finds a prominent one instead.
/// Named destinations can be normalized directly and must never be
/// substituted with a place search.
pub(crate) fn explicit_route_tool_arguments(utterance: &str) -> Option<String> {
    let (destination, mode) = route_command(utterance)?;
    if destination_relative_to_wearer(destination) {
        return None;
    }
    let mut arguments = serde_json::json!({"destination": destination});
    if let Some(mode) = mode {
        arguments["mode"] = serde_json::Value::String(mode.to_owned());
    }
    Some(arguments.to_string())
}

/// A destination picked by its distance from the wearer ("the nearest
/// pharmacy", "a café near me") rather than named.
fn destination_relative_to_wearer(destination: &str) -> bool {
    let lower = destination.to_lowercase();
    let words = lower
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    words
        .iter()
        .any(|word| matches!(*word, "nearest" | "closest" | "nearby"))
        || words
            .windows(2)
            .any(|pair| pair[0] == "near" && matches!(pair[1], "me" | "here"))
}

/// The destination and requested travel mode of one direct route command.
fn route_command(utterance: &str) -> Option<(&str, Option<&'static str>)> {
    let trimmed = utterance.trim();
    if trimmed.is_empty() || trimmed.len() > 384 || trimmed.chars().any(char::is_control) {
        return None;
    }
    let trimmed = trimmed.trim_end_matches(['.', '?', '!']).trim_end();
    let lower = trimmed.to_ascii_lowercase();
    let (prefix, mut mode) = [
        ("give me walking directions to ", Some("walking")),
        ("give me driving directions to ", Some("driving")),
        ("give me cycling directions to ", Some("bicycling")),
        ("give me bicycle directions to ", Some("bicycling")),
        ("give me transit directions to ", Some("transit")),
        ("give me public transport directions to ", Some("transit")),
        (
            "give me public transportation directions to ",
            Some("transit"),
        ),
        ("find a transit route to ", Some("transit")),
        ("find a public transport route to ", Some("transit")),
        ("give me directions to ", None),
        ("navigate to ", None),
        ("how do i get to ", None),
    ]
    .into_iter()
    .find(|(prefix, _)| lower.starts_with(prefix))?;
    let mut destination = trimmed.get(prefix.len()..)?.trim();
    // "Navigate to Nyhavn by transit": the mode is a suffix, never part of
    // the place looked up.
    if mode.is_none() {
        // Padded so a bare "by transit" leaves no destination.
        let padded = format!(" {}", destination.to_ascii_lowercase());
        if let Some(suffix) = [
            " by transit",
            " using transit",
            " by public transport",
            " using public transport",
            " by public transportation",
            " using public transportation",
        ]
        .into_iter()
        .find(|suffix| padded.ends_with(suffix))
        {
            destination = destination.get(..padded.len() - suffix.len())?.trim();
            mode = Some("transit");
        }
    }
    if !valid_route_destination(destination) {
        return None;
    }
    let destination_lower = destination.to_ascii_lowercase();
    if [
        " and call ",
        " and message ",
        " and play ",
        " and send ",
        " and set ",
        " and take ",
        " and text ",
    ]
    .iter()
    .any(|separator| destination_lower.contains(separator))
    {
        return None;
    }
    Some((destination, mode))
}

/// Recognize a bounded request to list the wearer's notes. An empty memory
/// query means "the most recent notes" at the tool boundary. Ordinary memory
/// questions remain model-led so their actual search terms are preserved.
pub(crate) fn explicit_recent_notes_tool_arguments(utterance: &str) -> Option<String> {
    let normalized = normalized_intent(utterance)?;
    [
        "show my notes",
        "read my notes",
        "list my notes",
        "what notes do i have",
    ]
    .contains(&normalized.as_str())
    .then(|| serde_json::json!({"query": ""}).to_string())
}

/// Reads a request needs exactly once. After one ran, the model answers from
/// its result:
/// - a note listing reads the notes once. Offered the read again after an
///   empty listing, the model repeated it with an invented all-time window;
/// - a ranked music question is one research lookup.
pub(crate) fn retire_completed_single_reads(tools: &mut Vec<ToolDef>, utterance: &str, ran: &str) {
    if ran == "recall_memory" && explicit_recent_notes_tool_arguments(utterance).is_some() {
        tools.retain(|tool| tool.name != "recall_memory");
    }
    if is_music_research_tool(ran) && ranked_music_question(utterance) {
        retire_music_research_tools(tools);
    }
}

fn normalized_intent(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 384 || value.chars().any(char::is_control) {
        return None;
    }
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
    (!normalized.is_empty()).then_some(normalized)
}

/// Resolve exact, bounded stock reads and UI openings without spending a model
/// step. These actions either expose current local state or open an existing
/// stock surface. None sends, calls, captures, plays, or changes radio state.
/// Catalog filtering remains authoritative for keyguard and per-request
/// exclusions, and the caller prevents replaying an action already in the
/// current stock turn chain.
pub(super) fn explicit_safe_stock_action(utterance: &str) -> Option<DeterministicDeviceAction> {
    let normalized = normalized_intent(utterance)?;
    let empty = |name, thought| DeterministicDeviceAction {
        name,
        input: "{}".to_owned(),
        thought,
    };

    if let Some(action) = explicit_message_read_action(utterance) {
        return Some(action);
    }

    let action = match normalized.as_str() {
        "reset session" | "clear session" | "start a new session" => empty(
            "ClearUnderstandingContext",
            "The wearer asked to clear the Pin's short-term conversation context",
        ),
        "read my recent messages" | "show my recent messages" => DeterministicDeviceAction {
            name: "DisplayMessages",
            input: serde_json::json!({
                "IDs": [],
                "Person": [],
                "MessageCount": 10,
            })
            .to_string(),
            thought: "The wearer asked to display recent local messages",
        },
        "open messages" | "open my messages" => empty(
            "OpenMessagesMainMenu",
            "The wearer asked to open the stock messages experience",
        ),
        "catch me up" | "what did i miss" => empty(
            "CatchMeUp",
            "The wearer asked for the stock notification summary",
        ),
        "open contacts" | "open my contacts" => empty(
            "OpenContacts",
            "The wearer asked to open the stock contacts experience",
        ),
        "open dialer" | "open the phone" => empty(
            "OpenDialerHome",
            "The wearer asked to open the stock dialer experience",
        ),
        "open the dial pad" | "open dial pad" | "open dialpad" => {
            empty("OpenDialpad", "The wearer asked to open the stock dial pad")
        }
        "open recent calls" | "open my recent calls" => empty(
            "OpenRecentCalls",
            "The wearer asked to open the stock recent-calls experience",
        ),
        "connect to wi fi" => empty(
            "ConnectToWifi",
            "The wearer asked to open the stock Wi-Fi selection flow",
        ),
        "scan wi fi qr code" => empty(
            "WifiQrScan",
            "The wearer asked to open the stock Wi-Fi QR scanner",
        ),
        "show my recent photos" | "open my recent photos" => DeterministicDeviceAction {
            name: "OpenRecentPhotos",
            input: serde_json::json!({"TriggeredFromTouchpad": false}).to_string(),
            thought: "The wearer asked to open the stock recent-photos experience",
        },
        "what is in my music queue"
        | "what s in my music queue"
        | "show my music queue"
        | "show the music queue" => empty(
            "GetMusicQueue",
            "The wearer asked to display the current music queue",
        ),
        "tell me the number of vision actions"
        | "how many vision actions are there"
        | "how many vision actions do i have" => empty(
            "GetIfThenMapSize",
            "The wearer asked for the number of configured vision actions",
        ),
        _ if normalized.starts_with("search my messages for ") => {
            let query = normalized.strip_prefix("search my messages for ")?.trim();
            if !bounded_read_subject(query) {
                return None;
            }
            DeterministicDeviceAction {
                name: "MessageSearch",
                input: serde_json::json!({"Person": [], "Query": query}).to_string(),
                thought: "The wearer asked to search local messages for a bounded query",
            }
        }
        _ if normalized.starts_with("search contacts for ")
            || normalized.starts_with("what is the phone number for ")
            || normalized == "who are my quick messaging contacts" =>
        {
            if [" and ", " then ", " also "]
                .iter()
                .any(|marker| normalized.contains(marker))
            {
                return None;
            }
            DeterministicDeviceAction {
                name: "Contacts",
                input: serde_json::json!({
                    "Request": utterance.trim().trim_end_matches(['.', '?', '!']).trim_end(),
                })
                .to_string(),
                thought: "The wearer asked the stock contacts agent for existing contact data",
            }
        }
        _ => return explicit_one_off_translation(utterance),
    };
    Some(action)
}

fn explicit_message_read_action(utterance: &str) -> Option<DeterministicDeviceAction> {
    let command = utterance
        .trim()
        .trim_end_matches(['.', '?', '!'])
        .trim_end();
    let lower = command.to_ascii_lowercase();

    if let Some(person) = lower
        .strip_prefix("read my messages from ")
        .and_then(|_| command.get("read my messages from ".len()..))
        .map(str::trim)
    {
        if !bounded_contact_name(person) {
            return None;
        }
        return Some(DeterministicDeviceAction {
            name: "DisplayMessages",
            input: serde_json::json!({
                "IDs": [],
                "Person": [person],
                "MessageCount": 10,
            })
            .to_string(),
            thought: "The wearer asked to display recent local messages from one contact",
        });
    }

    let remainder = lower.strip_prefix("what did ")?;
    let separator = " say about ";
    let separator_index = remainder.find(separator)?;
    let person_start = "what did ".len();
    let person_end = person_start + separator_index;
    let query_start = person_end + separator.len();
    let person = command.get(person_start..person_end)?.trim();
    let query = command.get(query_start..)?.trim();
    if !bounded_contact_name(person) || !bounded_read_subject(query) {
        return None;
    }
    Some(DeterministicDeviceAction {
        name: "MessageSearch",
        input: serde_json::json!({"Person": [person], "Query": query}).to_string(),
        thought: "The wearer asked to search one contact's local messages for a bounded topic",
    })
}

fn bounded_contact_name(value: &str) -> bool {
    let normalized = normalized_intent(value);
    let Some(normalized) = normalized else {
        return false;
    };
    value.len() <= 128
        && value.split_whitespace().count() <= 8
        && value.chars().any(char::is_alphabetic)
        && value.chars().all(|character| {
            character.is_alphabetic()
                || character.is_whitespace()
                || matches!(character, '-' | '\'' | '’' | '.')
        })
        && ![
            " and ", " or ", " then ", " while ", " before ", " after ", " also ",
        ]
        .iter()
        .any(|separator| normalized.contains(separator))
        && !matches!(
            normalized.as_str(),
            "a contact"
                | "any contact"
                | "anyone"
                | "contacts"
                | "everyone"
                | "my contact"
                | "someone"
        )
}

fn bounded_read_subject(value: &str) -> bool {
    let words = value.split_whitespace().collect::<Vec<_>>();
    !value.is_empty()
        && value.len() <= 256
        && words.len() <= 32
        && value
            .chars()
            .all(|character| character.is_alphanumeric() || character.is_whitespace())
        && !words
            .iter()
            .any(|word| matches!(*word, "and" | "then" | "also"))
}

// Stock humane.experience.LanguageResolution.localeFromLanguage recognizes
// these names (including Polish/pl). The bounded command grammar is INFERRED.
const ONE_OFF_LANGUAGES: &[(&str, &str)] = &[
    ("English", "en"),
    ("French", "fr"),
    ("German", "de"),
    ("Italian", "it"),
    ("Japanese", "ja"),
    ("Polish", "pl"),
    ("Portuguese", "pt"),
    ("Spanish", "es"),
];

pub(crate) fn translation_language_name(language: &str) -> Option<&'static str> {
    ONE_OFF_LANGUAGES
        .iter()
        .find(|(name, code)| {
            code.eq_ignore_ascii_case(language) || name.eq_ignore_ascii_case(language)
        })
        .map(|(name, _)| *name)
}

pub(crate) fn one_off_translation_request(utterance: &str) -> Option<pb::TranslateTextRequest> {
    normalized_intent(utterance)?; // Overall byte/control bounds, not source-text rewriting.
    let original = utterance
        .trim()
        .trim_end_matches(['.', '?', '!'])
        .trim_end();
    // ASCII matching keeps byte offsets identical even when the source is Unicode.
    let syntax = original.to_ascii_lowercase();
    let language = |value: &str| {
        ONE_OFF_LANGUAGES
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(value.trim()))
            .map(|(_, code)| *code)
    };
    let (text, source, target) = if syntax.starts_with("translate ") {
        let split = syntax.rfind(" to ")?;
        let target = language(&original[split + 4..])?;
        let before = original.get(10..split)?;
        let before_syntax = syntax.get(10..split)?;
        // A quoted source is data, including words such as 'from', 'and', 'then'.
        if before.starts_with(['"', '\'']) && before.ends_with(['"', '\'']) {
            (before, None, target)
        } else if let Some(split) = before_syntax.rfind(" from ") {
            (
                &before[..split],
                Some(language(&before[split + 6..])?),
                target,
            )
        } else {
            (before, None, target)
        }
    } else if syntax.starts_with("how do you say ") {
        let split = syntax.rfind(" in ")?;
        (
            original.get(15..split)?,
            None,
            language(&original[split + 4..])?,
        )
    } else {
        return None;
    };
    let text = text.trim();
    let text = text
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            text.strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(text);
    if text.trim().is_empty()
        || text.len() > 256
        || text.chars().any(char::is_control)
        || source == Some(target)
    {
        return None;
    }
    let locale = |language: &str| cosmos_protocol::common::Locale {
        language: language.into(),
        ..Default::default()
    };
    Some(pb::TranslateTextRequest {
        text: text.into(),
        from: source.map(locale),
        to: Some(locale(target)),
        ..Default::default()
    })
}

fn explicit_one_off_translation(utterance: &str) -> Option<DeterministicDeviceAction> {
    let request = one_off_translation_request(utterance)?;
    let target = translation_language_name(&request.to.as_ref()?.language)?;
    let mut input = serde_json::json!({"Text": request.text, "Target": target});
    if let Some(source) = request.from {
        input["Source"] =
            serde_json::Value::String(translation_language_name(&source.language)?.to_owned());
    }
    Some(DeterministicDeviceAction {
        name: "Translate",
        input: input.to_string(),
        thought: "The wearer explicitly requested a bounded one-off translation",
    })
}

pub(super) fn local_device_status_action(utterance: &str) -> Option<DeterministicDeviceAction> {
    let normalized = normalized_intent(utterance)?;
    let (name, thought) = match normalized.as_str() {
        "what time is it"
        | "what s the time"
        | "tell me the time"
        | "tell me the current time"
        | "current time" => (
            "GetCurrentTime",
            "The wearer asked the Pin for its current local time",
        ),
        "battery level"
        | "battery status"
        | "what is my battery level"
        | "what s my battery level"
        | "how much battery do i have"
        | "how much battery is left"
        | "how much charge do i have left" => (
            "GetBatteryLevel",
            "The wearer asked the Pin for its current battery level",
        ),
        "what is the current volume"
        | "what is my current volume"
        | "what is the volume"
        | "what s the current volume"
        | "what s my current volume"
        | "what s the volume"
        | "tell me the current volume"
        | "volume status" => (
            "GetCurrentVolume",
            "The wearer asked the Pin for its current media volume",
        ),
        "am i online"
        | "am i connected"
        | "am i connected to the internet"
        | "do i have internet"
        | "do i have an internet connection" => (
            "AmIOnline",
            "The wearer asked the Pin for its current connectivity state",
        ),
        "bluetooth status" | "is bluetooth on" | "is bluetooth enabled" => (
            "GetBluetoothStatus",
            "The wearer asked the Pin for its current Bluetooth state",
        ),
        "airplane mode status" | "is airplane mode on" | "is airplane mode enabled" => (
            "GetAirplaneModeStatus",
            "The wearer asked the Pin for its current airplane-mode state",
        ),
        "what is my phone number"
        | "tell me my phone number"
        | "what is my number"
        | "what s my phone number"
        | "what s my number" => (
            "GetPhoneNumber",
            "The wearer asked the Pin for its carrier-provided phone number",
        ),
        "what is my serial number"
        | "what is my pin s serial number"
        | "what is my pin serial number"
        | "what s my serial number"
        | "what s my pin s serial number"
        | "what s my pin serial number"
        | "tell me my serial number" => (
            "GetSerialNumber",
            "The wearer asked the Pin for its serial number",
        ),
        "where am i"
        | "where am i right now"
        | "what is my current location"
        | "tell me my current location"
        | "tell me where i am" => (
            "GetCurrentLocation",
            "The wearer asked the Pin for its current location",
        ),
        "device status"
        | "get device status"
        | "show device status"
        | "show me device status"
        | "give me a device status"
        | "give me a device status report"
        | "device status report" => (
            "Settings",
            "The wearer asked the stock Settings agent for a device status summary",
        ),
        _ => return None,
    };
    Some(DeterministicDeviceAction {
        name,
        input: if name == "Settings" {
            serde_json::json!({"Request": utterance.trim()}).to_string()
        } else {
            "{}".to_owned()
        },
        thought,
    })
}

pub(crate) fn local_weather_request(utterance: &str) -> bool {
    matches!(
        normalized_intent(utterance).as_deref(),
        Some(
            "what is the weather"
                | "what s the weather"
                | "what is the weather like"
                | "what s the weather like"
                | "what is the weather like today"
                | "what s the weather like today"
                | "what is the weather here"
                | "what s the weather here"
                | "what is the weather like here"
                | "what s the weather like here"
                | "what is the weather where i am"
                | "what s the weather where i am"
                | "what is the weather like where i am"
                | "what s the weather like where i am"
                | "what is the weather where i am right now"
                | "what s the weather where i am right now"
                | "what is the weather like where i am right now"
                | "what s the weather like where i am right now"
                | "what is the weather at my current location"
                | "what s the weather at my current location"
                | "what is the weather outside"
                | "what s the weather outside"
                | "what is the weather like outside"
                | "what s the weather like outside"
                | "tell me the weather outside"
                | "what is the current weather"
                | "what s the current weather"
                | "current weather"
                | "weather now"
                | "weather right now"
                | "weather today"
                | "what is the temperature"
                | "what is the temperature outside"
                | "how hot is it"
                | "how hot is it outside"
                | "how cold is it"
                | "how cold is it outside"
                | "is it raining"
                | "is it raining outside"
                | "should i bring an umbrella here today"
                | "what s the weather here and what s nearby"
        )
    )
}

pub(crate) fn current_city_request(utterance: &str) -> bool {
    matches!(
        normalized_intent(utterance).as_deref(),
        Some(
            "what city am i in" | "which city am i in" | "what town am i in" | "what is this city"
        )
    )
}

pub(crate) fn explicit_nearby_query(utterance: &str) -> Option<String> {
    let normalized = normalized_intent(utterance)?;
    if matches!(
        normalized.as_str(),
        "what s nearby"
            | "what is nearby"
            | "what s around me"
            | "what is around me"
            | "what s the weather here and what s nearby"
    ) {
        return Some(String::new());
    }

    let query = if let Some(value) = normalized.strip_prefix("find ") {
        value
            .strip_suffix(" nearby")
            .or_else(|| value.strip_suffix(" and navigate there"))
            .or_else(|| value.strip_prefix("the nearest "))?
    } else {
        return None;
    };
    let query = query.strip_prefix("the nearest ").unwrap_or(query).trim();
    bounded_read_subject(query).then(|| query.to_owned())
}

pub(crate) const FUTURE_WEATHER_UNAVAILABLE: &str =
    "Future weather forecasts are not available yet.";

pub(crate) const TICKLE_NEAR_MISS_RESPONSE: &str =
    "Tickle only runs for the exact phrases Tickle, Tickle my fancy, or Tickle tickle tickle.";

pub(crate) fn tickle_near_miss_request(utterance: &str) -> bool {
    !catalog::exact_tickle_request(utterance)
        && normalized_intent(utterance)
            .is_some_and(|intent| intent.split_whitespace().any(|word| word == "tickle"))
}

pub(crate) fn future_weather_request(utterance: &str) -> bool {
    let Some(intent) = normalized_intent(utterance) else {
        return false;
    };
    let asks_weather = intent.contains("weather") || intent.contains("forecast");
    let asks_future = intent.contains("tomorrow")
        || intent.contains("next week")
        || intent.contains("next month")
        || intent.contains("this weekend");
    asks_weather && asks_future
}

/// A forecast question this deployment cannot answer. With a weather backend
/// connected, the `weather` tool reads the daily forecast and answers it.
pub(crate) fn unanswerable_forecast_request(utterance: &str) -> bool {
    forecast_needs_a_backend(utterance, crate::backends::weather::configured())
}

fn forecast_needs_a_backend(utterance: &str, forecast_hosted: bool) -> bool {
    !forecast_hosted && future_weather_request(utterance)
}

/// A forecast for where the wearer is: no place is named, so the forecast
/// needs the Pin's own position first.
pub(crate) fn local_forecast_request(utterance: &str) -> bool {
    const TIME_WORDS: &[&str] = &[
        "the",
        "this",
        "next",
        "tomorrow",
        "today",
        "tonight",
        "weekend",
        "week",
        "month",
        "morning",
        "afternoon",
        "evening",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "here",
        "my",
        "me",
    ];
    if !future_weather_request(utterance) {
        return false;
    }
    let Some(intent) = normalized_intent(utterance) else {
        return false;
    };
    let words = intent.split_whitespace().collect::<Vec<_>>();
    !words.windows(2).any(|pair| {
        matches!(pair[0], "in" | "at" | "near" | "for" | "around") && !TIME_WORDS.contains(&pair[1])
    }) && !matches!(words.last(), Some(&("in" | "at" | "near" | "for")))
}

/// The stock transport action a whole request names, such as "Resume the
/// music.", "Previous track." or "Can you skip this song?". A closed grammar
/// of one verb and what it acts on, with polite wrapping removed: anything
/// longer or looser ("Next.", "Resume my timer.", "Resume the music in ten
/// minutes.") stays with the model.
pub(crate) fn explicit_music_transport_action(utterance: &str) -> Option<&'static str> {
    const SONG: &[&str] = &[
        "this song",
        "the song",
        "this track",
        "the track",
        "song",
        "track",
    ];
    const MUSIC: &[&str] = &["the music", "music", "my music", "playback"];
    const PLAYING: &[&str] = &[
        "the music",
        "music",
        "my music",
        "playback",
        "this song",
        "the song",
        "this track",
        "the track",
    ];
    const NEXT: &[&str] = &["the next song", "the next track", "next song", "next track"];
    const PREVIOUS: &[&str] = &[
        "the previous song",
        "the previous track",
        "previous song",
        "previous track",
    ];
    const ONE_BACK: &[&str] = &["a song", "a track", "one song", "one track"];

    let intent = normalized_intent(utterance)?;
    let mut command = intent.as_str();
    loop {
        let before = command;
        for prefix in [
            "please ",
            "can you ",
            "could you ",
            "would you ",
            "will you ",
        ] {
            command = command.strip_prefix(prefix).unwrap_or(command);
        }
        for suffix in [" please", " for now", " for me", " now"] {
            command = command.strip_suffix(suffix).unwrap_or(command);
        }
        if command == before {
            break;
        }
    }
    // `verb object`, exactly.
    let says = |verbs: &[&str], objects: &[&str]| {
        verbs.iter().any(|verb| {
            command
                .strip_prefix(verb)
                .and_then(|rest| rest.strip_prefix(' '))
                .is_some_and(|rest| objects.contains(&rest))
        })
    };
    // `object ending`, exactly, for "start this song over".
    let then = |verb: &str, ending: &str| {
        command
            .strip_prefix(verb)
            .and_then(|rest| rest.strip_prefix(' '))
            .and_then(|rest| rest.strip_suffix(ending))
            .and_then(|rest| rest.strip_suffix(' '))
            .is_some_and(|rest| SONG.contains(&rest))
    };

    if says(&["pause", "stop"], PLAYING) {
        Some("PauseMusic")
    } else if says(&["resume", "unpause"], PLAYING)
        // "Continue the song." also asks for more of a song just written.
        || says(&["continue"], MUSIC)
        || matches!(command, "resume playing" | "continue playing")
    {
        Some("ResumeMusic")
    } else if NEXT.contains(&command)
        || says(&["skip"], SONG)
        || says(&["play", "go to", "skip to"], NEXT)
    {
        Some("NextTrack")
    } else if PREVIOUS.contains(&command)
        || says(
            &["play", "go to", "go back to", "skip to", "skip back to"],
            PREVIOUS,
        )
        || says(&["go back", "skip back", "back"], ONE_BACK)
    {
        Some("PreviousTrack")
    } else if says(&["restart", "replay"], SONG)
        || then("start", "over")
        || then("play", "again")
        || then("play", "from the beginning")
        || then("play", "from the start")
    {
        Some("RestartTrack")
    } else {
        None
    }
}

/// Which way the wearer's words move the volume, when they name exactly one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VolumeDirection {
    Up,
    Down,
}

/// The volume direction a request asks for: `None` when the words name
/// neither direction, or both. "The music is too loud" asks for less volume
/// although it names loudness, so this reads complaints as well as commands.
pub(crate) fn volume_direction(utterance: &str) -> Option<VolumeDirection> {
    const UP: &[&str] = &[
        "louder",
        "too quiet",
        "too soft",
        "too low",
        "so quiet",
        "very quiet",
        "really quiet",
        "can t hear",
        "cannot hear",
        "can not hear",
        "couldn t hear",
        "barely hear",
        "hard to hear",
        "not loud enough",
        "t loud enough",
        "volume up",
        "up the volume",
        "more volume",
        "raise",
        "increase",
        "boost",
    ];
    const DOWN: &[&str] = &[
        "quieter",
        "softer",
        "too loud",
        "too noisy",
        "too high",
        "so loud",
        "very loud",
        "really loud",
        "less loud",
        "deafening",
        "quiet down",
        "volume down",
        "down the volume",
        "less volume",
        "lower",
        "decrease",
        "reduce",
        "hurts my ears",
        "hurting my ears",
    ];
    // "turn it up", "turn the music down a bit", "crank it up".
    const UP_VERBS: &[&str] = &["turn", "pump", "crank", "bring", "put", "jack", "speak"];
    const DOWN_VERBS: &[&str] = &["turn", "bring", "tone", "keep", "put"];

    let intent = normalized_intent(utterance)?;
    let words = intent.split_whitespace().collect::<Vec<_>>();
    // "It's not too loud", "don't turn it up", "don't make it louder".
    let negated = |start: usize| {
        let before = &words[start.saturating_sub(4)..start];
        matches!(before.last(), Some(&("not" | "never" | "t")))
            || before
                .windows(2)
                .any(|pair| matches!(pair, ["don", "t"] | ["do", "not"]))
            || before.contains(&"dont")
    };
    // A comparison or an aside describes the sound rather than asking for a
    // change, and can mean either way: "it's louder than I like", "it keeps
    // getting quieter", "I can't hear you over the music".
    let describes = |phrase: &[&str], start: usize| {
        let end = start + phrase.len();
        let comparison = matches!(phrase, ["louder" | "quieter" | "softer" | "lower"])
            && (words.get(end) == Some(&"than")
                || start.checked_sub(1).is_some_and(|previous| {
                    matches!(
                        words[previous],
                        "is" | "s"
                            | "was"
                            | "are"
                            | "re"
                            | "been"
                            | "get"
                            | "gets"
                            | "getting"
                            | "got"
                            | "any"
                    )
                }));
        comparison || (phrase.contains(&"hear") && words[end..].contains(&"over"))
    };
    let says = |phrases: &[&str]| {
        phrases.iter().any(|phrase| {
            let phrase = phrase.split(' ').collect::<Vec<_>>();
            words
                .windows(phrase.len())
                .enumerate()
                .any(|(start, window)| {
                    window == phrase.as_slice() && !negated(start) && !describes(&phrase, start)
                })
        })
    };
    let verb_then = |verbs: &[&str], particle: &str| {
        words.iter().enumerate().any(|(start, word)| {
            verbs.contains(word)
                && !negated(start)
                && words[start + 1..]
                    .iter()
                    .take(4)
                    .any(|later| *later == particle)
        })
    };
    let up = says(UP) || verb_then(UP_VERBS, "up");
    let down = says(DOWN) || verb_then(DOWN_VERBS, "down");
    match (up, down) {
        (true, false) => Some(VolumeDirection::Up),
        (false, true) => Some(VolumeDirection::Down),
        _ => None,
    }
}

fn valid_route_destination(destination: &str) -> bool {
    let destination = destination.trim();
    !destination.is_empty() && destination.chars().count() <= 160
}

pub(crate) fn explicit_playback_request(utterance: &str) -> bool {
    let Some(intent) = normalized_intent(utterance) else {
        return false;
    };
    intent == "play"
        || intent.starts_with("play ")
        || intent.starts_with("please play ")
        || intent.starts_with("put on ")
        || intent.starts_with("listen to ")
        || intent.contains(" and play ")
        || intent.contains(" then play ")
        || intent.ends_with(" and play it")
        || intent.ends_with(" then play it")
}

pub(super) fn is_music_research_tool(name: &str) -> bool {
    matches!(name, "web_search" | "ask_online")
}

/// A playback turn has room for one research lookup, one model extraction step,
/// and provider verification. The model still decides whether the request needs
/// research. When it does, offering both research tools allowed it to run them
/// serially and consume the whole Pin deadline before `music_discover`. Prefer
/// the connected answer engine because it returns a synthesized title/artist;
/// raw web search remains the no-answer-engine path, and the one kept when the
/// wearer asks to search the web.
///
/// A ranked music question that only asks what the song is gets the same one
/// research tool. Offered both, the model occasionally chained three lookups.
/// Returns whether the turn is ranked playback, whose budget also reserves
/// provider verification.
pub(crate) fn prefer_one_music_research_tool(
    tools: &mut Vec<ToolDef>,
    utterance: &str,
    answer_engine_available: bool,
) -> bool {
    let playback = explicit_playback_request(utterance)
        && tools.iter().any(|tool| tool.name == "music_discover");
    if !playback && !ranked_music_question(utterance) {
        return false;
    }
    let preferred = if answer_engine_available && !super::llm::names_web_search(utterance) {
        "ask_online"
    } else {
        "web_search"
    };
    tools.retain(|tool| !is_music_research_tool(&tool.name) || tool.name == preferred);
    playback
}

/// A question asking which song, album, or hit ranks highest by some
/// criterion ("What is Dr. Dre's most popular song?").
fn ranked_music_question(utterance: &str) -> bool {
    let Some(intent) = normalized_intent(utterance) else {
        return false;
    };
    let words = intent.split_whitespace().collect::<Vec<_>>();
    matches!(
        words.first(),
        Some(&("what" | "whats" | "which" | "tell" | "name"))
    ) && names_ranked_music(&words, true)
}

/// Playback of a song picked by a ranking ("Play Dr. Dre's most popular
/// song"), as opposed to a named track ("Play One Dance by Drake"). Which
/// track that is must come from research and the provider, never the model's
/// memory. See `llm::enforce_unstarted_music_playback`.
pub(crate) fn ranked_playback_request(utterance: &str) -> bool {
    explicit_playback_request(utterance)
        && normalized_intent(utterance).is_some_and(|intent| {
            names_ranked_music(&intent.split_whitespace().collect::<Vec<_>>(), false)
        })
}

/// Whether the words name music ranked by some criterion. Albums count for a
/// question. Playback picks a song.
fn names_ranked_music(words: &[&str], albums: bool) -> bool {
    words.iter().any(|word| {
        matches!(
            *word,
            "song" | "songs" | "track" | "tracks" | "single" | "hit" | "hits"
        ) || (albums && matches!(*word, "album" | "albums"))
    }) && words.iter().any(|word| {
        matches!(
            *word,
            "most"
                | "best"
                | "top"
                | "biggest"
                | "greatest"
                | "famous"
                | "popular"
                | "viral"
                | "controversial"
                | "underrated"
                | "influential"
        )
    })
}

pub(crate) fn retire_music_research_tools(tools: &mut Vec<ToolDef>) {
    tools.retain(|tool| !is_music_research_tool(&tool.name));
}
