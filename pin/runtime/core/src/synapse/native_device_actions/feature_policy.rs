//! Feature policy: planning for feature-gated actions and the bounded-text /
//! injection-marker validation that protects the visual automation grammar.

use super::*;

pub(super) fn plan_feature_gated_action(
    request: &SynapseUnderstandingRequest,
    features: NativeActionFeatureSnapshot,
) -> Option<PlannedNativeDeviceAction> {
    if features.tickle_enabled
        && matches!(
            strict_exact_feature_command(&request.utterance).as_deref(),
            Some("tickle" | "tickle my fancy" | "tickle tickle tickle")
        )
    {
        return allowed_feature_action(
            request,
            native_actions::TICKLE,
            "The user invoked the enabled stock Tickle prototype with an exact local phrase",
            "{}".to_string(),
        );
    }

    if features.vision_actions_enabled {
        if let Some((if_text, then_text)) = parse_add_if_then_entry(&request.utterance) {
            return allowed_feature_action(
                request,
                native_actions::ADD_IF_THEN_ENTRY,
                "The user explicitly added one bounded stock visual If-Then action",
                serde_json::json!({"If": if_text, "Then": then_text}).to_string(),
            );
        }

        if let Some(command) = strict_exact_feature_command(&request.utterance) {
            if is_clear_vision_actions_command(&command) {
                return allowed_feature_action(
                    request,
                    native_actions::CLEAR_IF_THEN_MAP,
                    "The user explicitly asked to clear the enabled stock visual-action map",
                    "{}".to_string(),
                );
            }
            if is_get_vision_action_count_command(&command) {
                return allowed_feature_action(
                    request,
                    native_actions::GET_IF_THEN_MAP_SIZE,
                    "The user asked for the size of the enabled stock visual-action map",
                    "{}".to_string(),
                );
            }
        }
    }

    if features.quick_actions_remapping_enabled {
        if let Some(action) = parse_quick_action_target(&request.utterance) {
            return allowed_feature_action(
                request,
                native_actions::CHANGE_QUICK_ACTION,
                "The user explicitly selected an allowlisted stock Quick Action",
                serde_json::json!({"action": action}).to_string(),
            );
        }
    }

    None
}

pub(super) fn allowed_feature_action(
    request: &SynapseUnderstandingRequest,
    action_name: &'static str,
    thought: &'static str,
    input_json: String,
) -> Option<PlannedNativeDeviceAction> {
    (!action_is_excluded(request, action_name)).then_some(PlannedNativeDeviceAction {
        action_name,
        thought,
        input_json,
    })
}

/// Normalize only casing, whitespace, and terminal speech punctuation. Unlike
/// the broader compatibility aliases, gated prototype commands do not gain a
/// polite-prefix expansion: their complete stock phrase must still match.
pub(super) fn strict_exact_feature_command(value: &str) -> Option<String> {
    let command = value.trim();
    if command.is_empty()
        || command.chars().count() > 200
        || command.contains(['\r', '\n'])
        || command.chars().any(char::is_control)
    {
        return None;
    }
    let command = command.trim_end_matches(['.', '!', '?']).trim_end();
    if command.is_empty()
        || command
            .chars()
            .any(|character| !character.is_ascii_alphanumeric() && !character.is_whitespace())
    {
        return None;
    }
    let normalized = normalize_words(command);
    if contains_instruction_injection_marker(&normalized)
        || [" and ", " then ", " after that "]
            .iter()
            .any(|marker| normalized.contains(marker))
    {
        return None;
    }
    Some(normalized)
}

pub(super) fn parse_add_if_then_entry(value: &str) -> Option<(String, String)> {
    let command = value.trim();
    if command.is_empty()
        || command.contains(['\r', '\n', '\0'])
        || command.chars().any(|character| character.is_control())
    {
        return None;
    }

    let command = command.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = command.to_ascii_lowercase();
    let remainder = normalized.strip_prefix("if you see ")?;
    // Stock uses `(?<If>.+) then (?<Then>.+)`. The greedy `If` group makes
    // the final separator authoritative when the visible condition itself
    // contains the word "then".
    let separator = remainder.rfind(" then ")?;
    let condition_start = "if you see ".len();
    let condition_end = condition_start + separator;
    let then_start = condition_end + " then ".len();
    let condition = command[condition_start..condition_end].trim();
    let then_text = command[then_start..].trim();

    if !valid_bounded_feature_text(condition, MAX_VISION_CONDITION_CHARS)
        || !safe_visual_condition(condition)
        || !safe_visual_then_utterance(then_text)
    {
        return None;
    }
    let then_utterance = BoundedAutomationUtterance::parse(then_text)?;
    Some((condition.to_string(), then_utterance.text().to_string()))
}

pub(super) fn valid_bounded_feature_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max_chars
        && !value
            .chars()
            .any(|character| character == '\0' || character.is_control())
}

pub(super) fn safe_visual_condition(value: &str) -> bool {
    let normalized = normalize_words(value);
    if contains_instruction_injection_marker(&normalized) {
        return false;
    }

    // The stock regex gives every earlier `then` to its greedy If group. Keep
    // that exact split for ordinary descriptions, but reject a prior separator
    // followed by another action command: that shape is a compound request,
    // not one bounded visual condition.
    let mut remainder = normalized.as_str();
    while let Some((_, tail)) = remainder.split_once(" then ") {
        if starts_with_action_command(tail) {
            return false;
        }
        remainder = tail;
    }
    true
}

pub(super) fn safe_visual_then_utterance(value: &str) -> bool {
    let normalized = normalize_words(value);
    if normalized.is_empty()
        || contains_instruction_injection_marker(&normalized)
        || [" then ", " after that "]
            .iter()
            .any(|marker| normalized.contains(marker))
        || value.contains([';', '|'])
    {
        return false;
    }

    for connector in [" and ", " plus ", " as well as "] {
        let mut remainder = normalized.as_str();
        while let Some((_, tail)) = remainder.split_once(connector) {
            if starts_with_action_command(tail) {
                return false;
            }
            remainder = tail;
        }
    }

    !value
        .split(['.', '!', '?', ','])
        .skip(1)
        .map(normalize_words)
        .any(|tail| starts_with_action_command(&tail))
}

pub(super) fn starts_with_action_command(value: &str) -> bool {
    let mut value = value.trim();
    loop {
        let Some(remainder) = ["and ", "also ", "then ", "please ", "next "]
            .iter()
            .find_map(|prefix| value.strip_prefix(prefix))
        else {
            break;
        };
        value = remainder;
    }
    [
        "reboot",
        "restart",
        "factory reset",
        "turn ",
        "enable ",
        "disable ",
        "send ",
        "text ",
        "message ",
        "call ",
        "dial ",
        "delete ",
        "clear ",
        "erase ",
        "lock ",
        "unlock ",
        "take ",
        "capture ",
        "record ",
        "stop ",
        "start ",
        "set ",
        "change ",
        "play ",
        "open ",
        "connect ",
        "disconnect ",
        "create ",
    ]
    .iter()
    .any(|prefix| value == *prefix || value.starts_with(prefix))
}

pub(super) fn contains_instruction_injection_marker(value: &str) -> bool {
    [
        "ignore previous",
        "ignore all previous",
        "ignore prior",
        "disregard previous",
        "disregard all previous",
        "forget previous instructions",
        "forget all previous instructions",
        "system prompt",
        "developer message",
        "developer instructions",
        "assistant message",
        "follow these instructions",
        "prompt injection",
        "you are now",
    ]
    .iter()
    .any(|marker| value.contains(marker))
}

pub(super) fn is_clear_vision_actions_command(command: &str) -> bool {
    ["clear", "erase", "delete"].iter().any(|verb| {
        command == format!("{verb} vision actions")
            || command == format!("{verb} the vision actions")
    })
}

pub(super) fn is_get_vision_action_count_command(command: &str) -> bool {
    let Some(mut remainder) = command
        .strip_prefix("get ")
        .or_else(|| command.strip_prefix("tell "))
    else {
        return false;
    };
    if let Some(value) = remainder.strip_prefix("me ") {
        remainder = value;
    }
    if let Some(value) = remainder.strip_prefix("the ") {
        remainder = value;
    }
    let Some(mut remainder) = remainder.strip_prefix("number of ") else {
        return false;
    };
    if let Some(value) = remainder.strip_prefix("the ") {
        remainder = value;
    }
    remainder == "vision actions"
}
