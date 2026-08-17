//! Command grammar: quick-action targets, lock/session commands, strict safe
//! local and restored-stock command normalization, and volume parsing.

use super::*;

pub(super) fn parse_quick_action_target(value: &str) -> Option<&'static str> {
    let command = strict_exact_feature_command(value)?;
    let mut remainder = ["swap ", "change ", "set ", "make "]
        .iter()
        .find_map(|prefix| command.strip_prefix(prefix))?;
    if let Some(value) = remainder
        .strip_prefix("the ")
        .or_else(|| remainder.strip_prefix("my "))
    {
        remainder = value;
    }

    for descriptor in [
        "two finger touchdown",
        "two finger hold gesture",
        "quick action gesture",
        "two finger gesture",
        "two finger action",
        "two finger touch",
        "quick action",
        "touch action",
        "action",
    ] {
        if let Some(value) = remainder.strip_prefix(descriptor) {
            let value = value.strip_prefix(' ')?;
            remainder = value;
            break;
        }
    }

    let target = remainder.strip_prefix("to ")?;
    match target {
        "interpreter" | "translation" | "translate" => Some("interpreter"),
        "messages" | "messaging" => Some("messages"),
        "note" | "notes" => Some("notes"),
        _ => None,
    }
}

pub(super) fn request_is_explicitly_unlocked(request: &SynapseUnderstandingRequest) -> bool {
    request
        .device_context
        .as_ref()
        .is_some_and(|context| !context.is_locked)
}

/// Shared with `capability_answer`: a spoken capability list must apply the same
/// exclusion rule the planner does, or it promises what this turn would refuse.
pub(crate) fn action_is_excluded(request: &SynapseUnderstandingRequest, action_name: &str) -> bool {
    request
        .excluded_tools
        .iter()
        .any(|excluded| excluded.eq_ignore_ascii_case(action_name))
}

pub(super) fn is_exact_reset_session_command(value: &str) -> bool {
    if value.contains(['\r', '\n']) {
        return false;
    }
    let mut words = value
        .trim_matches(is_ascii_horizontal_session_whitespace)
        .split(is_ascii_horizontal_session_whitespace)
        .filter(|word| !word.is_empty());
    words
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case("reset"))
        && words
            .next()
            .is_some_and(|word| word.eq_ignore_ascii_case("session"))
        && words.next().is_none()
}

pub(super) fn is_ascii_horizontal_session_whitespace(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\u{000B}' | '\u{000C}')
}

pub(super) fn normalize_words(value: &str) -> String {
    value
        .trim()
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
        .join(" ")
}

pub(super) fn is_strict_lock_command(value: &str) -> bool {
    let command = value.trim().trim_end_matches(['.', '!']).trim_end();
    if command
        .chars()
        .any(|character| !character.is_ascii_alphanumeric() && !character.is_whitespace())
    {
        return false;
    }
    matches!(
        normalize_words(command).as_str(),
        "lock my device" | "lock the device" | "lock my pin"
    )
}

pub(super) fn normalize(value: &str) -> String {
    let mut normalized = normalize_words(value);

    for prefix in [
        "can you please ",
        "could you please ",
        "would you please ",
        "can you ",
        "could you ",
        "would you ",
        "please ",
    ] {
        if let Some(remainder) = normalized.strip_prefix(prefix) {
            normalized = remainder.to_string();
            break;
        }
    }
    normalized
}

/// Return a normalized command only when the raw input is a single bounded
/// imperative. Internal punctuation, line breaks, compound chaining, and
/// instruction-injection markers are rejected before aliases are considered.
pub(super) fn strict_safe_local_command(value: &str) -> Option<String> {
    let command = value.trim();
    if command.is_empty() || command.len() > 160 || command.contains(['\r', '\n']) {
        return None;
    }
    let command = command.trim_end_matches(['.', '!', '?']).trim_end();
    if command.is_empty()
        || command.chars().any(|character| {
            !character.is_ascii_alphanumeric() && !character.is_whitespace() && character != '%'
        })
    {
        return None;
    }
    let normalized = normalize(command);
    if normalized.is_empty()
        || [
            " and ",
            " then ",
            " after that ",
            " ignore ",
            " system prompt",
            "developer message",
        ]
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return None;
    }
    Some(normalized)
}

pub(super) fn is_strict_safe_local_command(value: &str) -> bool {
    strict_safe_local_command(value).is_some()
}

/// Admit the ordinary spelling "Wi-Fi" without making arbitrary hyphenated
/// commands equivalent to space-separated mutations. The shared strict parser
/// intentionally rejects every other internal hyphen.
pub(super) fn strict_restored_stock_command(value: &str) -> Option<String> {
    let normalized_wifi = value.to_ascii_lowercase().replace("wi-fi", "wifi");
    strict_safe_local_command(&normalized_wifi)
}

pub(super) fn parse_set_volume_level(value: &str) -> Option<u8> {
    let normalized = strict_safe_local_command(value)?;
    let raw_level = [
        "set volume to ",
        "set the volume to ",
        "set my volume to ",
        "change volume to ",
        "change the volume to ",
        "change my volume to ",
        "volume ",
    ]
    .iter()
    .find_map(|prefix| normalized.strip_prefix(prefix))?
    .trim()
    .trim_end_matches(" percent")
    .trim_end_matches('%')
    .trim();
    if raw_level.is_empty()
        || !raw_level
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    raw_level.parse::<u8>().ok().filter(|level| *level <= 100)
}
