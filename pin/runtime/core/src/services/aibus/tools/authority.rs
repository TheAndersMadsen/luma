//! Pure command-authority predicates for model-proposed native mutations.
//!
//! These helpers decide whether the current user's utterance authorizes the
//! proposed arguments. They have no executor, provider, or device side effects.

use serde_json::Value;

use crate::tier_a::native_actions;

use super::catalog::AdvertisedMutationTool;
use crate::synapse::authority::runtime::AgenticToolResult;
use crate::synapse::catalog::{
    classify_fieldless_music_grounding, native_action_spec, FieldlessMusicGrounding,
    ReadToolInvocation, ReadToolResultProvenance,
};
pub(super) const FIELDLESS_DIRECT_MUSIC_MUTATION_ACTIONS: &[&str] = &[
    native_actions::PLAY_FAVORITE_TRACKS,
    native_actions::PLAY_FEATURED_MUSIC,
    native_actions::PLAY_CURRENT_TRACK_RADIO,
];

pub(super) const DIRECT_MUSIC_MUTATION_ACTIONS: &[&str] = &[
    native_actions::PLAY_FAVORITE_TRACKS,
    native_actions::PLAY_FEATURED_MUSIC,
    native_actions::GENERATE_MUSIC_PLAYLIST,
];

pub(super) fn is_direct_music_mutation(mutation: &AdvertisedMutationTool) -> bool {
    DIRECT_MUSIC_MUTATION_ACTIONS.contains(&mutation.action)
}

pub(super) fn is_fieldless_direct_music_mutation(mutation: &AdvertisedMutationTool) -> bool {
    FIELDLESS_DIRECT_MUSIC_MUTATION_ACTIONS.contains(&mutation.action)
}

/// Normalize spoken command text without preserving punctuation as authority.
/// Apostrophes become spaces, so both `don't` and ASR's `dont` can be checked
/// without treating contractions as quoted spans.
pub(super) fn normalized_command_text(utterance: &str) -> String {
    let mut normalized = String::with_capacity(utterance.len());
    for ch in utterance.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            normalized.push(ch);
        } else if !normalized.ends_with(' ') {
            normalized.push(' ');
        }
    }
    normalized.trim().to_string()
}

/// Remove one bounded request wrapper. This deliberately mirrors the shared
/// strict fieldless-music contract: arbitrary prose cannot be peeled away
/// until an action-shaped substring becomes authority.
pub(super) fn strip_bounded_command_prefix(command: &str) -> &str {
    [
        "could you please ",
        "would you please ",
        "can you please ",
        "will you please ",
        "i would like you to ",
        "i would like to ",
        "i d like you to ",
        "i d like to ",
        "i want you to ",
        "i want to ",
        "could you ",
        "would you ",
        "can you ",
        "will you ",
        "hey please ",
        "please ",
        "hey ",
        "let s ",
    ]
    .iter()
    .find_map(|prefix| command.strip_prefix(prefix))
    .unwrap_or(command)
}

pub(super) fn strip_bounded_command_suffix(command: &str) -> &str {
    [" right now", " please", " for me", " now"]
        .iter()
        .find_map(|suffix| command.strip_suffix(suffix))
        .unwrap_or(command)
}

pub(super) fn command_starts_with(command: &str, phrase: &str) -> bool {
    command == phrase || command.starts_with(&format!("{phrase} "))
}

pub(super) fn command_ends_with(command: &str, phrase: &str) -> bool {
    command == phrase || command.ends_with(&format!(" {phrase}"))
}

#[derive(Debug)]
pub(super) struct QuotedCommandScan {
    outside: String,
    has_delimiters: bool,
    has_nonempty_payload: bool,
    balanced: bool,
}

pub(super) fn apostrophe_is_inside_word(characters: &[char], index: usize) -> bool {
    index
        .checked_sub(1)
        .and_then(|previous| characters.get(previous))
        .is_some_and(|previous| previous.is_alphanumeric())
        && characters
            .get(index + 1)
            .is_some_and(|next| next.is_alphanumeric())
}

pub(super) fn opening_quote(character: char, internal_apostrophe: bool) -> Option<char> {
    match character {
        '"' => Some('"'),
        '`' => Some('`'),
        '“' => Some('”'),
        '„' => Some('“'),
        '«' => Some('»'),
        '‘' if !internal_apostrophe => Some('’'),
        '\'' if !internal_apostrophe => Some('\''),
        _ => None,
    }
}

pub(super) fn is_unmatched_closing_quote(character: char, internal_apostrophe: bool) -> bool {
    matches!(character, '”' | '»') || (character == '’' && !internal_apostrophe)
}

/// Parse, rather than merely erase, quoted data. Every supported opening must
/// meet its matching closing delimiter; a mismatched or unterminated span is
/// invalid. Apostrophes inside words remain ordinary text.
pub(super) fn scan_quoted_command_text(utterance: &str) -> QuotedCommandScan {
    let characters: Vec<char> = utterance.chars().collect();
    let mut outside = String::with_capacity(utterance.len());
    let mut quoted_payload = String::new();
    let mut expected_closing = None;
    let mut has_delimiters = false;
    let mut has_nonempty_payload = false;
    let mut balanced = true;

    for (index, character) in characters.iter().copied().enumerate() {
        let internal_apostrophe =
            matches!(character, '\'' | '‘' | '’') && apostrophe_is_inside_word(&characters, index);
        if let Some(closing) = expected_closing {
            let is_delimiter = opening_quote(character, internal_apostrophe).is_some()
                || is_unmatched_closing_quote(character, internal_apostrophe);
            if character == closing && !internal_apostrophe {
                has_nonempty_payload |= !quoted_payload.trim().is_empty();
                quoted_payload.clear();
                expected_closing = None;
            } else if is_delimiter {
                balanced = false;
                break;
            } else {
                quoted_payload.push(character);
            }
            outside.push(' ');
            continue;
        }

        if let Some(closing) = opening_quote(character, internal_apostrophe) {
            has_delimiters = true;
            expected_closing = Some(closing);
            outside.push(' ');
        } else if is_unmatched_closing_quote(character, internal_apostrophe) {
            has_delimiters = true;
            balanced = false;
            break;
        } else {
            outside.push(character);
        }
    }
    if expected_closing.is_some() {
        balanced = false;
    }

    QuotedCommandScan {
        outside: normalized_command_text(&outside),
        has_delimiters,
        has_nonempty_payload,
        balanced,
    }
}

pub(super) fn whole_utterance_is_quoted(utterance: &str) -> bool {
    let candidate = utterance
        .trim()
        .trim_end_matches(['.', '!', '?'])
        .trim_end();
    let Some(opening) = candidate.chars().next() else {
        return false;
    };
    let Some(closing) = candidate.chars().next_back() else {
        return false;
    };
    candidate.len() > opening.len_utf8() + closing.len_utf8()
        && matches!(
            (opening, closing),
            ('"', '"') | ('\'', '\'') | ('`', '`') | ('“', '”') | ('‘', '’')
        )
}

pub(super) fn command_has_informational_outer_prefix(command: &str) -> bool {
    [
        "what",
        "why",
        "how",
        "when",
        "where",
        "who",
        "which",
        "tell me about",
        "explain",
        "describe",
        "define",
        "show me how",
        "what happens",
        "what would happen",
        "is it possible",
        "should i",
        "can i",
        "could i",
        "would i",
        "do i",
        "did i say",
        "repeat after me",
    ]
    .iter()
    .any(|prefix| command_starts_with(command, prefix))
}

/// Argument-free device reads exempt from the informational-prefix bail-out.
///
/// The prefix gate prevents questions about state-changing actions from
/// performing them. Adding a name here is therefore a security decision: every
/// entry must have empty arguments, leave device state unchanged, and be
/// permitted while the keyguard is active. All validation, authorization and
/// grounding gates still run after this exemption.
pub(super) const INFORMATIONAL_PREFIX_EXEMPT_READS: &[&str] = &[
    native_actions::GET_BATTERY_LEVEL,
    native_actions::GET_CURRENT_VOLUME,
    native_actions::GET_MUSIC_QUEUE,
    native_actions::AM_I_ONLINE,
];

pub(super) fn command_has_followup_action(command: &str) -> bool {
    command.contains(" and then ")
        || command.contains(" then ")
        || [
            "call", "text", "message", "send", "set", "open", "delete", "take", "capture",
            "record", "turn",
        ]
        .iter()
        .any(|verb| contains_word_phrase(command, &format!("and {verb}")))
}

pub(super) fn command_has_trailing_cancellation(command: &str) -> bool {
    let existing_cancellation = [
        "but do not",
        "but don t",
        "but dont",
        "never mind",
        "cancel that",
        "actually don t",
        "actually dont",
    ]
    .iter()
    .any(|phrase| contains_word_phrase(command, phrase));
    let cancellation_candidate = [" please", " for me"]
        .iter()
        .find_map(|suffix| command.strip_suffix(suffix))
        .unwrap_or(command);
    let bounded_suffix = ["scratch that", "forget that", "not now", "not right now"]
        .iter()
        .any(|phrase| command_ends_with(cancellation_candidate, phrase));
    existing_cancellation || bounded_suffix
}

pub(super) fn music_playback_target(command: &str) -> Option<&str> {
    ["play ", "listen to ", "put on ", "queue up ", "start "]
        .iter()
        .find_map(|prefix| command.strip_prefix(prefix))
        .map(str::trim)
        .filter(|target| !target.is_empty())
}

/// Recognize a fieldless local-music target independent of the surface verb.
/// The shared action catalog intentionally carries a narrow exact-command
/// grammar; The catalog additionally needs to keep variants such as "listen to my
/// favorites" out of provider catalog search. Matching the exact target of a
/// declared fieldless phrase avoids reclassifying named songs or artists.
pub(super) fn command_targets_fieldless_direct_music_action(utterance: &str) -> bool {
    let normalized = normalized_command_text(utterance);
    let command = strip_bounded_command_suffix(strip_bounded_command_prefix(&normalized));
    let Some(target) = music_playback_target(command) else {
        return false;
    };

    FIELDLESS_DIRECT_MUSIC_MUTATION_ACTIONS
        .iter()
        .any(|action| {
            native_action_spec(action).is_some_and(|spec| {
                spec.required_user_terms.iter().any(|term| {
                    let normalized_term = normalized_command_text(term);
                    let declared_target =
                        music_playback_target(&normalized_term).unwrap_or(&normalized_term);
                    target == declared_target
                })
            })
        })
}

/// These requests need a trusted current-run recent-track referent. The chat-turn loop has
/// no such observation in its authority snapshot, so it must neither dispatch
/// the fieldless radio action nor reinterpret the words as a catalog query.
pub(super) fn radio_command_requires_recent_track_context(utterance: &str) -> bool {
    let normalized = normalized_command_text(utterance);
    let command = strip_bounded_command_suffix(strip_bounded_command_prefix(&normalized));
    let target = music_playback_target(command).unwrap_or(command);
    matches!(
        target,
        "more like this"
            | "more like this one"
            | "more like that"
            | "more like that one"
            | "more like it"
            | "songs like this"
            | "songs like that"
            | "songs like it"
            | "tracks like this"
            | "tracks like that"
            | "tracks like it"
            | "music like this"
            | "music like that"
            | "music like it"
    )
}

pub(super) fn catalog_must_reserve_current_track_radio(utterance: &str) -> bool {
    let classified_radio = native_action_spec(native_actions::PLAY_CURRENT_TRACK_RADIO)
        .is_some_and(|spec| {
            matches!(
                classify_fieldless_music_grounding(spec, utterance),
                Some(FieldlessMusicGrounding::AuthoritativeDirectCommand)
                    | Some(FieldlessMusicGrounding::NonAuthoritativeDirectActionMention)
            )
        });
    classified_radio || radio_command_requires_recent_track_context(utterance)
}

pub(super) fn unquoted_command_text(utterance: &str) -> String {
    let scan = scan_quoted_command_text(utterance);
    if scan.balanced {
        scan.outside
    } else {
        normalized_command_text(utterance)
    }
}

pub(super) fn argument_text(arguments: &Value, field: &str) -> Option<String> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(normalized_command_text)
        .filter(|value| !value.is_empty())
}

pub(super) fn strip_leading_phrase<'a>(value: &'a str, phrase: &str) -> Option<&'a str> {
    let tail = value.strip_prefix(phrase)?;
    if tail.is_empty() {
        Some(tail)
    } else {
        tail.strip_prefix(' ')
    }
}

pub(super) fn recipient_command_remainder<'a>(
    command: &'a str,
    prefixes: &[&str],
    recipient: &str,
) -> Option<&'a str> {
    prefixes.iter().find_map(|prefix| {
        let tail = command.strip_prefix(prefix)?;
        let tail = tail.trim_start();
        let tail = tail.strip_prefix("to ").unwrap_or(tail);
        strip_leading_phrase(tail, recipient).map(str::trim_start)
    })
}

pub(super) fn compose_message_body_matches(command: &str, arguments: &Value) -> bool {
    let Some(recipient) = argument_text(arguments, "to") else {
        return false;
    };
    let Some(message) = argument_text(arguments, "message") else {
        return false;
    };
    let Some(remainder) = recipient_command_remainder(
        command,
        &[
            "send a message",
            "send message",
            "send a text",
            "send text",
            "write a message",
            "write message",
            "text",
            "message",
        ],
        &recipient,
    ) else {
        return false;
    };
    let body = [
        "saying ",
        "say ",
        "and say ",
        "that says ",
        "with the message ",
        "with message ",
    ]
    .iter()
    .find_map(|prefix| remainder.strip_prefix(prefix))
    .unwrap_or(remainder)
    .trim();
    !body.is_empty() && body == message
}

pub(super) fn requested_alarm_day(words: &[&str]) -> Result<Option<String>, ()> {
    const WEEKDAYS: &[&str] = &[
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ];
    let mut matches = Vec::new();
    let mut index = 0;
    while index < words.len() {
        if matches!(words[index], "this" | "next")
            && words
                .get(index + 1)
                .is_some_and(|day| WEEKDAYS.contains(day))
        {
            matches.push(format!("{} {}", words[index], words[index + 1]));
            index += 2;
            continue;
        }
        if matches!(words[index], "today" | "tomorrow" | "tonight")
            || WEEKDAYS.contains(&words[index])
        {
            matches.push(words[index].to_string());
        }
        index += 1;
    }
    match matches.as_slice() {
        [] => Ok(None),
        [day] => Ok(Some(day.clone())),
        _ => Err(()),
    }
}

pub(super) fn alarm_arguments_match_requested_time(arguments: &Value, utterance: &str) -> bool {
    let Some(time) = argument_text(arguments, "time") else {
        return false;
    };
    let normalized = normalized_command_text(utterance);
    let command = strip_bounded_command_prefix(&normalized);
    let Some(mut tail) = [
        "set an alarm",
        "set alarm",
        "create an alarm",
        "create alarm",
        "wake me up",
        "wake me",
    ]
    .iter()
    .find_map(|prefix| strip_leading_phrase(command, prefix)) else {
        return false;
    };
    tail = tail
        .strip_prefix("for ")
        .or_else(|| tail.strip_prefix("at "))
        .or_else(|| tail.split_once(" at ").map(|(_, after)| after))
        .unwrap_or(tail);
    for exclusion in [" instead of ", " rather than ", " but not ", " except "] {
        if let Some((requested, _)) = tail.split_once(exclusion) {
            tail = requested.trim();
            break;
        }
    }
    let words: Vec<&str> = tail.split_whitespace().collect();
    let time_words: Vec<&str> = time.split_whitespace().collect();
    if time_words.is_empty()
        || !words.starts_with(&time_words)
        || (words.get(time_words.len()).is_some_and(|word| {
            word.chars().all(|character| character.is_ascii_digit())
                && time_words
                    .last()
                    .is_some_and(|word| word.chars().all(|character| character.is_ascii_digit()))
        }))
    {
        return false;
    }
    let qualifiers = &words[time_words.len()..];
    let requested_ampm = qualifiers
        .first()
        .copied()
        .filter(|value| matches!(*value, "am" | "pm"));
    if argument_text(arguments, "ampm").as_deref() != requested_ampm {
        return false;
    }
    let day_words = if requested_ampm.is_some() {
        &qualifiers[1..]
    } else {
        qualifiers
    };
    let Ok(requested_day) = requested_alarm_day(day_words) else {
        return false;
    };
    argument_text(arguments, "once_day") == requested_day
}

pub(super) fn timer_duration(arguments: &Value) -> Option<(&str, String)> {
    let object = arguments.as_object()?;
    let durations: Vec<(&str, f64)> = ["seconds", "minutes", "hours"]
        .into_iter()
        .filter_map(|field| {
            object
                .get(field)
                .and_then(Value::as_f64)
                .map(|value| (field, value))
        })
        .collect();
    let [(unit, value)] = durations.as_slice() else {
        return None;
    };
    if !value.is_finite() || value.fract() != 0.0 {
        return None;
    }
    Some((unit, format!("{value:.0}")))
}

pub(super) fn english_number(value: u64) -> Option<String> {
    const SMALL: [&str; 20] = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    const TENS: [&str; 10] = [
        "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    match value {
        0..=19 => Some(SMALL[value as usize].to_string()),
        20..=99 => {
            let tens = TENS[(value / 10) as usize];
            let ones = value % 10;
            Some(if ones == 0 {
                tens.to_string()
            } else {
                format!("{tens} {}", SMALL[ones as usize])
            })
        }
        100..=999 => {
            let remainder = value % 100;
            let hundreds = SMALL[(value / 100) as usize];
            Some(if remainder == 0 {
                format!("{hundreds} hundred")
            } else {
                format!("{hundreds} hundred {}", english_number(remainder)?)
            })
        }
        1_000..=86_400 => {
            let remainder = value % 1_000;
            let thousands = english_number(value / 1_000)?;
            Some(if remainder == 0 {
                format!("{thousands} thousand")
            } else {
                format!("{thousands} thousand {}", english_number(remainder)?)
            })
        }
        _ => None,
    }
}

pub(super) fn timer_duration_matches_utterance(arguments: &Value, utterance: &str) -> bool {
    let Some((unit, value)) = timer_duration(arguments) else {
        return false;
    };
    let singular = unit.strip_suffix('s').unwrap_or(unit);
    let normalized = normalized_command_text(utterance);
    let requested = [" instead of ", " rather than ", " but not ", " except "]
        .iter()
        .find_map(|exclusion| normalized.split_once(exclusion).map(|(before, _)| before))
        .unwrap_or(&normalized);
    let digits_match = contains_word_phrase(requested, &format!("{value} {unit}"))
        || contains_word_phrase(requested, &format!("{value} {singular}"));
    let words_match = value
        .parse::<u64>()
        .ok()
        .and_then(english_number)
        .is_some_and(|words| {
            contains_word_phrase(requested, &format!("{words} {unit}"))
                || contains_word_phrase(requested, &format!("{words} {singular}"))
        });
    digits_match || words_match
}

pub(super) fn mutation_arguments_have_declared_shape(
    mutation: &AdvertisedMutationTool,
    arguments: &Value,
) -> bool {
    let Some(object) = arguments.as_object() else {
        return false;
    };
    let only = |allowed: &[&str]| object.keys().all(|key| allowed.contains(&key.as_str()));
    match mutation.action {
        native_actions::PLAY_FAVORITE_TRACKS | native_actions::PLAY_FEATURED_MUSIC => {
            object.is_empty()
        }
        native_actions::GENERATE_MUSIC_PLAYLIST => {
            only(&["playlist"]) && argument_text(arguments, "playlist").is_some()
        }
        native_actions::SET_TIMER => {
            only(&["minutes", "seconds", "hours", "name"])
                && object
                    .get("name")
                    .is_none_or(|name| name.as_str().is_some_and(|name| !name.trim().is_empty()))
                && timer_duration(arguments).is_some()
        }
        native_actions::SET_ALARM => {
            only(&["time", "ampm", "once_day"])
                && argument_text(arguments, "time").is_some()
                && ["ampm", "once_day"].iter().all(|field| {
                    object.get(*field).is_none_or(|value| {
                        value.as_str().is_some_and(|value| !value.trim().is_empty())
                    })
                })
        }
        native_actions::COMPOSE_MESSAGE => {
            only(&["to", "message"])
                && argument_text(arguments, "to").is_some()
                && argument_text(arguments, "message").is_some()
        }
        native_actions::CALL_PERSON => only(&["to"]) && argument_text(arguments, "to").is_some(),
        // Argument-free device controls and facts. Taking no arguments is the
        // point: there is nothing for the model to invent or misquote, so the
        // only thing it chooses is WHICH action — which the catalog, the
        // authorization gate and lock state then re-check before dispatch.
        native_actions::INCREMENT_VOLUME
        | native_actions::DECREMENT_VOLUME
        | native_actions::GET_CURRENT_VOLUME
        | native_actions::PAUSE_MUSIC
        | native_actions::RESUME_MUSIC
        | native_actions::NEXT_TRACK
        | native_actions::PREVIOUS_TRACK
        | native_actions::RESTART_TRACK
        | native_actions::SAVE_CURRENT_TRACK_TO_FAVORITES
        | native_actions::GET_MUSIC_QUEUE
        | native_actions::GET_BATTERY_LEVEL
        | native_actions::GET_CURRENT_TIME
        | native_actions::AM_I_ONLINE => object.is_empty(),
        // The level must be a number the user actually said; the native
        // argument spec bounds it to 0-100 and requires an exact user span.
        native_actions::SET_VOLUME => {
            only(&["level"])
                && object
                    .get("level")
                    .and_then(serde_json::Value::as_i64)
                    .is_some_and(|level| (0..=100).contains(&level))
        }
        _ => false,
    }
}

/// Does the command contain any of these action-specific terms?
pub(super) fn mentions_any(command: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| command.contains(term))
}

/// The requested volume must be a number the user actually said. The native
/// argument spec enforces `ExactUserSpan` downstream; checking here means the
/// model is told why its call was refused instead of failing later.
pub(super) fn object_level_appears_in_utterance(arguments: &Value, utterance: &str) -> bool {
    let Some(level) = arguments.get("level").and_then(Value::as_i64) else {
        return false;
    };
    utterance.contains(&level.to_string())
}

pub(super) fn generic_mutation_command_intent(
    mutation: &AdvertisedMutationTool,
    utterance: &str,
    arguments: &Value,
) -> bool {
    if whole_utterance_is_quoted(utterance) {
        return false;
    }
    let normalized = normalized_command_text(utterance);
    let command = strip_bounded_command_prefix(&normalized);
    if command.is_empty() {
        return false;
    }
    if command_has_informational_outer_prefix(command)
        && !INFORMATIONAL_PREFIX_EXEMPT_READS.contains(&mutation.action)
    {
        return false;
    }
    if mutation.action != native_actions::COMPOSE_MESSAGE
        && (crate::synapse::intent_authority::non_authoritative_intent_reason(utterance).is_some()
            || command_has_followup_action(command)
            || command_has_trailing_cancellation(command))
    {
        return false;
    }
    if mutation.action == native_actions::COMPOSE_MESSAGE
        && command_has_trailing_cancellation(&unquoted_command_text(utterance))
    {
        return false;
    }

    let starts_any = |phrases: &[&str]| {
        phrases
            .iter()
            .any(|phrase| command_starts_with(command, phrase))
    };
    match mutation.action {
        native_actions::SET_TIMER => {
            starts_any(&[
                "set timer",
                "set a timer",
                "start timer",
                "start a timer",
                "create timer",
                "create a timer",
            ]) && timer_duration_matches_utterance(arguments, utterance)
        }
        native_actions::SET_ALARM => {
            starts_any(&[
                "set alarm",
                "set an alarm",
                "create alarm",
                "create an alarm",
                "wake me",
                "wake me up",
            ]) && alarm_arguments_match_requested_time(arguments, utterance)
        }
        native_actions::COMPOSE_MESSAGE => compose_message_body_matches(command, arguments),
        native_actions::CALL_PERSON => argument_text(arguments, "to").is_some_and(|recipient| {
            recipient_command_remainder(command, &["call", "phone", "dial"], &recipient)
                .is_some_and(|remainder| {
                    ["", "please", "now", "right now", "for me"].contains(&remainder)
                })
        }),
        // Argument-free controls still require direct, action-specific evidence
        // in THIS utterance. The model choosing the tool is not authority on its
        // own; these terms are what makes the command the user's, not the
        // model's. Kept deliberately tight — a control that fires on a vague
        // sentence is worse than one that occasionally declines.
        native_actions::INCREMENT_VOLUME => mentions_any(
            command,
            &[
                "turn it up",
                "turn up",
                "volume up",
                "louder",
                "raise the volume",
                "increase the volume",
            ],
        ),
        native_actions::DECREMENT_VOLUME => mentions_any(
            command,
            &[
                "turn it down",
                "turn down",
                "volume down",
                "quieter",
                "lower the volume",
                "decrease the volume",
            ],
        ),
        native_actions::SET_VOLUME => {
            mentions_any(command, &["volume"])
                && object_level_appears_in_utterance(arguments, utterance)
        }
        native_actions::GET_CURRENT_VOLUME => mentions_any(command, &["volume"]),
        native_actions::PAUSE_MUSIC => {
            mentions_any(command, &["pause", "stop the music", "stop playing"])
        }
        native_actions::RESUME_MUSIC => mentions_any(
            command,
            &["resume", "unpause", "keep playing", "continue playing"],
        ),
        native_actions::NEXT_TRACK => mentions_any(command, &["next track", "next song", "skip"]),
        native_actions::PREVIOUS_TRACK => mentions_any(
            command,
            &[
                "previous track",
                "previous song",
                "last song",
                "go back a track",
            ],
        ),
        native_actions::RESTART_TRACK => mentions_any(
            command,
            &[
                "restart",
                "start over",
                "from the beginning",
                "play it again",
            ],
        ),
        native_actions::SAVE_CURRENT_TRACK_TO_FAVORITES => mentions_any(
            command,
            &[
                "save this",
                "save the song",
                "save the track",
                "favorite",
                "favourite",
                "add to my library",
            ],
        ),
        native_actions::GET_MUSIC_QUEUE => {
            mentions_any(command, &["queue", "what's next", "whats next", "up next"])
        }
        native_actions::GET_BATTERY_LEVEL => {
            mentions_any(command, &["battery", "charge level", "how much charge"])
        }
        native_actions::GET_CURRENT_TIME => mentions_any(command, &["time"]),
        native_actions::AM_I_ONLINE => mentions_any(
            command,
            &[
                "online",
                "internet",
                "connected",
                "connection",
                "wifi",
                "wi-fi",
            ],
        ),
        _ => false,
    }
}

pub(super) fn authoritative_play_music_command(utterance: &str) -> bool {
    if whole_utterance_is_quoted(utterance) {
        return false;
    }
    // Quoted payloads remain valid data only when the action itself appears
    // outside the quotes (`play "Example Track"`). A directive that exists
    // solely inside quoted data (`"play Example Track" is a phrase`) cannot
    // mint playback authority.
    let quoted = scan_quoted_command_text(utterance);
    if !quoted.balanced {
        return false;
    }
    let normalized = if quoted.has_delimiters {
        quoted.outside.clone()
    } else {
        normalized_command_text(utterance)
    };
    let command = strip_bounded_command_prefix(&normalized);
    let catalog_then_play = ["look up", "lookup", "search for", "find"]
        .iter()
        .any(|prefix| command_starts_with(command, prefix))
        && [" and play ", " then play ", " and put on ", " then put on "]
            .iter()
            .any(|connector| command.contains(connector));
    if command.is_empty()
        || command_has_informational_outer_prefix(command)
        || crate::synapse::intent_authority::non_authoritative_intent_reason(utterance).is_some()
        || (command_has_followup_action(command) && !catalog_then_play)
        || command_has_trailing_cancellation(command)
    {
        return false;
    }

    if catalog_must_reserve_current_track_radio(utterance)
        || command_targets_fieldless_direct_music_action(utterance)
    {
        return false;
    }

    if FIELDLESS_DIRECT_MUSIC_MUTATION_ACTIONS
        .iter()
        .any(|action| {
            native_action_spec(action).is_some_and(|spec| {
                classify_fieldless_music_grounding(spec, utterance)
                    == Some(FieldlessMusicGrounding::AuthoritativeDirectCommand)
            })
        })
    {
        return false;
    }

    let bare_command = strip_bounded_command_suffix(command);
    if matches!(bare_command, "play" | "listen to" | "put on" | "queue up")
        && !(quoted.has_delimiters && quoted.has_nonempty_payload)
    {
        return false;
    }

    if ["play", "listen to", "put on", "queue up"]
        .iter()
        .any(|prefix| command_starts_with(command, prefix))
    {
        return true;
    }

    catalog_then_play
}

pub(super) fn is_generic_music_result_reference(target: &str) -> bool {
    matches!(
        target,
        "" | "it"
            | "this"
            | "that"
            | "one"
            | "the one"
            | "top one"
            | "the top one"
            | "top result"
            | "the top result"
            | "first one"
            | "the first one"
            | "result"
            | "the result"
            | "something"
            | "anything"
            | "music"
            | "some music"
            | "song"
            | "a song"
            | "songs"
            | "the songs"
            | "some songs"
            | "track"
            | "a track"
            | "tracks"
            | "the tracks"
            | "some tracks"
            | "artist"
            | "album"
            | "albums"
            | "the albums"
            | "some albums"
            | "hit"
            | "a hit"
            | "hits"
            | "the hits"
            | "some hits"
            | "best one"
            | "the best one"
            | "best songs"
            | "the best songs"
            | "top songs"
            | "the top songs"
            | "biggest hits"
            | "the biggest hits"
    )
}

pub(super) fn push_music_target(targets: &mut Vec<String>, target: &str) {
    let target = strip_bounded_command_suffix(target.trim());
    if is_generic_music_result_reference(target) || targets.iter().any(|value| value == target) {
        return;
    }
    targets.push(target.to_string());
}

pub(super) fn is_explicit_music_collection_side(target: &str) -> bool {
    target.split_whitespace().last().is_some_and(|word| {
        matches!(
            word,
            "songs"
                | "tracks"
                | "albums"
                | "hits"
                | "tunes"
                | "releases"
                | "records"
                | "singles"
                | "catalog"
                | "catalogue"
                | "discography"
                | "music"
        )
    })
}

pub(super) fn add_music_target_variants(targets: &mut Vec<String>, target: &str) {
    let target = strip_bounded_command_suffix(target.trim());
    push_music_target(targets, target);

    if let Some(stripped) = [
        "the song ",
        "song ",
        "the track ",
        "track ",
        "the album ",
        "album ",
        "the artist ",
        "artist ",
        "some ",
    ]
    .iter()
    .find_map(|prefix| target.strip_prefix(prefix))
    {
        push_music_target(targets, stripped);
    }

    if let Some((named, artist)) = target.rsplit_once(" by ") {
        let named = [
            "the song ",
            "song ",
            "the track ",
            "track ",
            "the album ",
            "album ",
        ]
        .iter()
        .find_map(|prefix| named.strip_prefix(prefix))
        .unwrap_or(named);
        // Never detach the left side: without a trusted entity type, code
        // cannot prove whether `X by Artist` names a title or merely describes
        // a collection. The full phrase remains authoritative. Detaching the
        // artist is allowed only when a closed collection grammar proves that
        // the request is for the artist's body of work, not one named item.
        if is_explicit_music_collection_side(named) {
            push_music_target(targets, artist);
        }
    }
}

/// Bounded provider tails a spoken playback clause carries. Closed set, and
/// used ONLY to decide whether a clause is anaphoric — never to widen a target.
const MUSIC_PROVIDER_TAILS: &[&str] = &[
    " on spotify",
    " in spotify",
    " on apple music",
    " on youtube music",
    " on amazon music",
    " on tidal",
    " on soundcloud",
];

/// True when the playback half of a compound request names nothing of its own,
/// so it can only refer BACK to the search clause ("look up X and play the best
/// one"). A clause that names a concrete target ("...and play jazz") is not
/// anaphoric, and its search clause stays a separate errand with no playback
/// authority.
pub(super) fn music_playback_clause_is_anaphoric(playback_target: &str) -> bool {
    let target = strip_bounded_command_suffix(playback_target.trim());
    let target = MUSIC_PROVIDER_TAILS
        .iter()
        .find_map(|tail| target.strip_suffix(tail))
        .unwrap_or(target);
    is_generic_music_result_reference(strip_bounded_command_suffix(target.trim()))
}

pub(super) fn requested_side_before_fieldless_exclusion(command: &str) -> &str {
    [
        " instead of ",
        " instead ",
        " rather than ",
        " but not ",
        " except ",
        " not ",
    ]
    .iter()
    .filter_map(|separator| {
        let (requested, excluded) = command.split_once(separator)?;
        let synthetic_excluded_command = format!("play {}", excluded.trim());
        (command_targets_fieldless_direct_music_action(&synthetic_excluded_command)
            || catalog_must_reserve_current_track_radio(&synthetic_excluded_command))
        .then_some(requested)
    })
    .next()
    .unwrap_or(command)
}

pub(super) fn authoritative_music_playback_targets(utterance: &str) -> Vec<String> {
    if !authoritative_play_music_command(utterance) {
        return Vec::new();
    }
    let normalized = normalized_command_text(utterance);
    let command = strip_bounded_command_suffix(strip_bounded_command_prefix(&normalized));
    let command = requested_side_before_fieldless_exclusion(command).trim();
    let mut targets = Vec::new();

    if let Some((search_clause, playback_target)) =
        [" and play ", " then play ", " and put on ", " then put on "]
            .iter()
            .filter_map(|connector| command.split_once(connector))
            .next()
    {
        add_music_target_variants(&mut targets, playback_target);
        // The search half becomes a playback target ONLY when the playback half
        // names nothing of its own. "...and play the best one on Spotify"
        // refers BACK to the search clause, so the entity being played lives
        // there; returning here discarded the only half that named it, and
        // artist="Michael Jackson" could not be contained in
        // `the best one on spotify`. Measured on device: targets=1
        // requested_words=2 longest_target_words=5, and playback was refused.
        //
        // The condition is load-bearing, not decoration. When the playback half
        // DOES name a concrete target the search clause is a different errand:
        // "look up weather and play jazz" must never make `weather` a playback
        // target, and `play_music_rejects_partial_or_non_playback_search_spans`
        // fails the moment this returns early only on emptiness again.
        if !music_playback_clause_is_anaphoric(playback_target) {
            return targets;
        }
        let search_target = ["look up ", "lookup ", "search for ", "find "]
            .iter()
            .find_map(|prefix| search_clause.strip_prefix(prefix))
            .unwrap_or(search_clause);
        add_music_target_variants(&mut targets, search_target);
        return targets;
    }

    if let Some(target) = ["play ", "listen to ", "put on ", "queue up "]
        .iter()
        .find_map(|prefix| command.strip_prefix(prefix))
    {
        add_music_target_variants(&mut targets, target);
    }
    targets
}

/// The model's own search argument for one music provider call. `None` for any
/// other tool: nothing else may be cited for playback.
fn music_result_requested_search_target(result: &AgenticToolResult) -> Option<&str> {
    match &result.tool {
        ReadToolInvocation::MusicArtistTopTracks(arguments) => Some(arguments.artist.as_str()),
        ReadToolInvocation::MusicCatalogSearch(arguments) => Some(arguments.query.as_str()),
        _ => None,
    }
}

/// Normalize a model-supplied search argument for comparison. `None` when it
/// carries control characters or normalizes to nothing.
fn normalized_music_search_target(requested: &str) -> Option<String> {
    if requested.chars().any(char::is_control) {
        return None;
    }
    let requested = normalized_command_text(requested);
    (!requested.is_empty()).then_some(requested)
}

/// Normalization splits a possessive into its own token: "Dr. Dre's most
/// popular song" becomes six words, `dr dre s most popular song`. Models search
/// the five-word form without the possessive. Measured on device:
/// requested_words=5 vs longest_target_words=6, and grounding failed on that
/// single token, which is why playback never completed.
///
/// Dropping a standalone possessive marker introduces no foreign token, so the
/// invariant holds: every remaining word still comes from the authority.
fn depossessed_music_span(text: &str) -> String {
    text.split(' ')
        .filter(|word| *word != "s")
        .collect::<Vec<_>>()
        .join(" ")
}

/// The ONE strictness rule. Both grounding paths call this and nothing else, so
/// "rule (b) is exactly as strict as rule (a)" is a property of the code rather
/// than a claim about it.
///
/// Exact equality alone is too strict, and it is why music playback never
/// completed: "play Dr. Dre's most popular song" yields the whole phrase as the
/// authoritative target, while the model searches artist="Dr. Dre". Measured on
/// device: results=4 ungrounded=4 play_args_refused=0 — every result refused, so
/// play_music could never cite one.
///
/// A word-bounded SUBSPAN of an authority is still entirely that authority's
/// own words, narrowed. Reordering, substitution and any foreign token remain
/// refused, because this is containment of a contiguous span, not a
/// bag-of-words comparison.
fn music_span_authorizes_request(authority: &str, requested: &str) -> bool {
    // Head form ("michael jackson s best song") and tail form ("the best song
    // by michael jackson") are the same request in different English word
    // order. Only the head form grounded before, so every "play the best song
    // by <artist>" phrasing found a track and then refused to play it —
    // measured on device as targets=1 requested_words=2 longest_target_words=6.
    //
    // `target_ends_with_entity_span` admits a word-bounded SUFFIX whose
    // preceding words are only qualifiers or connectives, so it introduces no
    // foreign token: every word still comes from the authority span. That is
    // the same invariant `target_contains_span` keeps, which is why both rules
    // may share this function.
    if authority == requested
        || target_contains_span(authority, requested)
        || target_ends_with_entity_span(authority, requested)
    {
        return true;
    }
    let authority_bare = depossessed_music_span(authority);
    let requested_bare = depossessed_music_span(requested);
    authority_bare == requested_bare
        || target_contains_span(&authority_bare, &requested_bare)
        || target_ends_with_entity_span(&authority_bare, &requested_bare)
}

/// Rule (a): the user said it. Authoritative spans extracted from this turn's
/// utterance, unchanged.
fn music_request_is_grounded_in_utterance(requested: &str, targets: &[String]) -> bool {
    targets
        .iter()
        .any(|target| music_span_authorizes_request(target, requested))
}

/// Bound the provider values one result may contribute. A provider payload is
/// untrusted input and grounding rescans it for every candidate; the bound
/// keeps a pathological response from turning grounding into a hot loop.
const MAX_CITABLE_MUSIC_VALUES_PER_FIELD: usize = 64;

/// Whether a stored result may be cited at all. These are the same two
/// conditions the audited rank-one playback builder already requires before it
/// will touch a result: a trusted provider produced it, and it succeeded.
fn music_result_is_citable(result: &AgenticToolResult) -> bool {
    result.provenance == ReadToolResultProvenance::TrustedProviderResult
        && result.result.get("status").and_then(Value::as_str) == Some("ok")
}

/// The provider-produced values inside one music result, normalized for
/// comparison: each track's title, its album, and its artists — exactly the
/// three fields the audited builder puts into `PlayMusic` arguments.
///
/// The echoed top-level `artist`/`query` fields are deliberately excluded: they
/// are the MODEL's own argument reflected back, not provider data, and
/// admitting them would let a search authorize its own successor.
fn citable_music_result_values(result: &AgenticToolResult) -> Vec<String> {
    let Some(tracks) = result.result.get("tracks").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut values: Vec<String> = Vec::new();
    for track in tracks.iter().take(MAX_CITABLE_MUSIC_VALUES_PER_FIELD) {
        let named = ["title", "album"]
            .iter()
            .filter_map(|field| track.get(*field).and_then(Value::as_str));
        let artists = track
            .get("artists")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_CITABLE_MUSIC_VALUES_PER_FIELD)
            .filter_map(Value::as_str);
        for value in named.chain(artists) {
            let normalized = normalized_command_text(value);
            if !normalized.is_empty() && !values.contains(&normalized) {
                values.push(normalized);
            }
        }
    }
    values
}

/// Rule (b) — the chain of trust. A value the user never spoke is grounded only
/// when it appears in the citable content of an EARLIER same-turn result that
/// itself passed grounding.
///
/// Neither half is sufficient alone, and that is the whole point: the USER
/// authorizes the topic, by having grounded the earlier search in their own
/// words; the VALUE comes from real provider data rather than model invention.
/// An ungrounded result contributes nothing (no bootstrapping), and a
/// non-citable one contributes nothing (no untrusted or failed payload).
fn music_request_is_chained_to_prior_result(
    requested: &str,
    grounded_priors: &[&AgenticToolResult],
) -> bool {
    grounded_priors
        .iter()
        .filter(|prior| music_result_is_citable(prior))
        .any(|prior| {
            citable_music_result_values(prior)
                .iter()
                .any(|value| music_span_authorizes_request(value, requested))
        })
}

/// Resolve which of the earlier same-turn results are themselves grounded.
///
/// Walking FORWARD is what makes the chain well-founded: each candidate is
/// tested only against results recorded strictly before it, so a result can
/// never ground itself and no cycle is expressible. The first result has no
/// priors, so every chain terminates at rule (a) — the user's own words.
fn grounded_prior_music_results<'a>(
    prior_results: &'a [AgenticToolResult],
    targets: &[String],
) -> Vec<&'a AgenticToolResult> {
    let mut grounded: Vec<&AgenticToolResult> = Vec::new();
    for candidate in prior_results {
        let Some(requested) = music_result_requested_search_target(candidate)
            .and_then(normalized_music_search_target)
        else {
            continue;
        };
        if music_request_is_grounded_in_utterance(&requested, targets)
            || music_request_is_chained_to_prior_result(&requested, &grounded)
        {
            grounded.push(candidate);
        }
    }
    grounded
}

/// A same-run provider call proves freshness, not user authority. Bind the
/// invocation's model-chosen artist/query to the actual playback target, not
/// an arbitrary or partial word elsewhere in the turn. This object carries no
/// trusted recent-track observation that could authorize an absent value.
///
/// `prior_results` are this turn's music results recorded strictly BEFORE
/// `result`, in order. They are the only extra authority admitted, and only
/// through rule (b) below.
pub(super) fn music_result_search_target_is_grounded(
    result: &AgenticToolResult,
    utterance: &str,
    prior_results: &[AgenticToolResult],
) -> bool {
    let Some(requested) =
        music_result_requested_search_target(result).and_then(normalized_music_search_target)
    else {
        return false;
    };
    let targets = authoritative_music_playback_targets(utterance);
    // (a) The user's own words. Unchanged, and still tried first.
    if music_request_is_grounded_in_utterance(&requested, &targets) {
        return true;
    }
    // (b) A value real provider data supplied inside an earlier grounded
    // search. `result` is never in `prior_results`, so it cannot ground itself.
    let grounded_priors = grounded_prior_music_results(prior_results, &targets);
    if music_request_is_chained_to_prior_result(&requested, &grounded_priors) {
        return true;
    }
    // Bounded shape only, never the target or query text. Measured:
    // ungrounded=2 with play_args_refused=2 means the ranked results (top_tracks)
    // are the ones failing HERE, so playback can never complete. Lengths
    // and counts distinguish "no targets extracted" from "target extracted
    // but the requested span is not its entity head"; the chain counters
    // separate "no earlier grounded search existed" from "one existed and did
    // not contain this value".
    tracing::info!(
        tool = match &result.tool {
            ReadToolInvocation::MusicArtistTopTracks(_) => "music_artist_top_tracks",
            ReadToolInvocation::MusicCatalogSearch(_) => "music_catalog_search",
            _ => "other",
        },
        targets = targets.len(),
        requested_words = requested.split(' ').count(),
        longest_target_words = targets
            .iter()
            .map(|target| target.split(' ').count())
            .max()
            .unwrap_or(0),
        prior_results = prior_results.len(),
        grounded_priors = grounded_priors.len(),
        chain_values = grounded_priors
            .iter()
            .filter(|prior| music_result_is_citable(prior))
            .map(|prior| citable_music_result_values(prior).len())
            .sum::<usize>(),
        "<<< music target not grounded"
    );
    false
}

/// The remainder must OPEN with one of these. A possessive or superlative is
/// what makes "<entity> s most popular song" a request *about* an entity rather
/// than an entity whose own name happens to end in "track" or "song".
pub(super) const MUSIC_QUALIFIER_HEADS: &[&str] = &[
    "s",
    "most",
    "best",
    "top",
    "greatest",
    "biggest",
    "favourite",
    "favorite",
];

/// Words allowed AFTER the qualifier head.
pub(super) const MUSIC_TARGET_QUALIFIERS: &[&str] = &[
    "s",
    "most",
    "best",
    "top",
    "greatest",
    "biggest",
    "popular",
    "famous",
    "song",
    "songs",
    "track",
    "tracks",
    "hit",
    "hits",
    "album",
    "albums",
    "music",
    "stuff",
    "latest",
    "newest",
    "favourite",
    "favorite",
];

/// Connective words that may sit between a leading qualifier phrase and a
/// TRAILING entity span. They contain no entity of their own, so admitting them
/// cannot let a foreign token through — every word still comes from the
/// request.
pub(super) const MUSIC_TARGET_CONNECTIVES: &[&str] = &["the", "by", "a", "an", "from", "of"];

/// True when `span` is the TRAILING entity of `target`: a word-bounded suffix
/// whose preceding words are only qualifiers or connectives.
///
/// The mirror of [`target_contains_span`], for the equally natural English
/// ordering "the best song BY michael jackson". Without it that phrasing found
/// a track and then refused to play it, because the artist sits at the tail
/// rather than the head.
///
/// The safety invariant is unchanged and is what keeps a bare fragment out:
/// every preceding word must be a qualifier or connective, so
/// "dr dre s most popular song" cannot ground the span "song" — "dr" and "dre"
/// are neither. No token may originate outside the request, and this is
/// containment of a contiguous span, not a bag-of-words comparison.
pub(super) fn target_ends_with_entity_span(target: &str, span: &str) -> bool {
    if span.is_empty() || span.len() >= target.len() {
        return false;
    }
    let Some(prefix) = target.strip_suffix(span) else {
        return false;
    };
    let Some(prefix) = prefix.strip_suffix(' ') else {
        return false;
    };
    prefix.split(' ').all(|word| {
        MUSIC_TARGET_QUALIFIERS.contains(&word) || MUSIC_TARGET_CONNECTIVES.contains(&word)
    })
}

/// True when `span` is the ENTITY HEAD of `target`: a leading word-bounded
/// prefix whose remainder is only qualifier words.
///
/// A plain containment check is not safe here — "dr" is a word-bounded subspan
/// of "dr dre s most popular song", and a one-word fragment as a search target
/// would play something the user never named. Requiring the remainder to be
/// qualifiers means the model dropped "…'s most popular song" and kept
/// "dr dre", which is strictly the user's own words narrowed to the entity.
pub(super) fn target_contains_span(target: &str, span: &str) -> bool {
    if span.is_empty() || span.len() >= target.len() {
        return false;
    }
    let Some(remainder) = target.strip_prefix(span) else {
        return false;
    };
    let Some(remainder) = remainder.strip_prefix(' ') else {
        return false;
    };
    // The remainder must OPEN with a possessive/superlative. Without this,
    // "play Example Track" would let the span "Example" through (remainder
    // "track" is a qualifier word), and the provider's answer for "Example"
    // can be a completely different song — caught by
    // `play_music_rejects_partial_or_non_playback_search_spans`.
    let mut words = remainder.split(' ');
    let Some(head) = words.next() else {
        return false;
    };
    if !MUSIC_QUALIFIER_HEADS.contains(&head) {
        return false;
    }
    words.all(|word| MUSIC_TARGET_QUALIFIERS.contains(&word))
}

/// A concrete catalog request remains authoritative when the user contrasts it
/// with a fieldless action they do not want. The shared fieldless classifier is
/// intentionally conservative and may label ASR-shortened wording such as
/// `play jazz instead my favorites` as a mention of `PlayFavoriteTracks`.
/// That mention must not authorize the favorites mutation, but it must not hide
/// the independently authoritative `play jazz` request either.
pub(super) fn catalog_command_precedes_excluded_fieldless_alternative(utterance: &str) -> bool {
    if utterance.contains(';')
        || utterance.chars().any(char::is_control)
        || unquoted_command_text(utterance) != normalized_command_text(utterance)
        || !authoritative_play_music_command(utterance)
    {
        return false;
    }

    let normalized = normalized_command_text(utterance);
    let command = strip_bounded_command_suffix(strip_bounded_command_prefix(&normalized));
    let Some((requested, excluded)) = [
        " instead of ",
        // Some speech recognizers omit the preposition in short contrasts.
        " instead ",
        " rather than ",
        " not ",
    ]
    .iter()
    .find_map(|separator| command.split_once(separator)) else {
        return false;
    };
    let requested = requested.trim();
    let excluded = excluded.trim();
    let requested_target = ["play ", "listen to ", "put on ", "queue up "]
        .iter()
        .find_map(|prefix| requested.strip_prefix(prefix))
        .map(str::trim)
        .filter(|target| {
            !target.is_empty()
                && !matches!(
                    *target,
                    "it" | "this"
                        | "that"
                        | "something"
                        | "anything"
                        | "music"
                        | "some music"
                        | "a song"
                        | "a track"
                        | "songs"
                        | "tracks"
                )
        });
    !requested.is_empty()
        && !excluded.is_empty()
        && requested_target.is_some()
        // Reuse the full catalog authority grammar on the requested side. In
        // particular, this rejects generic/direct prefixes such as `play
        // something` and `play my favorites` instead of reclassifying them as
        // catalog searches.
        && authoritative_play_music_command(requested)
}

/// Extract the deterministic playlist topic after the direct command. Excluded
/// alternatives are never eligible payloads: in "for running instead of jazz"
/// the only authoritative topic is "running".
pub(super) fn generated_playlist_requested_topic(utterance: &str) -> Option<String> {
    if whole_utterance_is_quoted(utterance) || utterance.contains(';') || utterance.contains('\n') {
        return None;
    }
    let normalized = normalized_command_text(utterance);
    let command = strip_bounded_command_suffix(strip_bounded_command_prefix(&normalized));
    if command.is_empty()
        || command_has_informational_outer_prefix(command)
        || crate::synapse::intent_authority::non_authoritative_intent_reason(utterance).is_some()
        || command.contains(" and then ")
        || command.contains(" then ")
        || [
            "call", "text", "message", "send", "set", "open", "delete", "take", "capture",
            "record", "turn",
        ]
        .iter()
        .any(|verb| contains_word_phrase(command, &format!("and {verb}")))
        || command_has_trailing_cancellation(command)
    {
        return None;
    }

    let mut topic = [
        "make me a playlist",
        "make a playlist",
        "create me a playlist",
        "create a playlist",
        "generate me a playlist",
        "generate a playlist",
    ]
    .iter()
    .find_map(|prefix| {
        command
            .strip_prefix(prefix)
            .filter(|tail| tail.is_empty() || tail.starts_with(' '))
    })?
    .trim();
    topic = ["for ", "about ", "of ", "with ", "called ", "named "]
        .iter()
        .find_map(|prefix| topic.strip_prefix(prefix))
        .unwrap_or(topic)
        .trim();
    for exclusion in [" instead of ", " rather than ", " but not ", " except "] {
        if let Some((requested, _excluded)) = topic.split_once(exclusion) {
            topic = requested.trim();
            break;
        }
    }
    if topic.is_empty()
        || topic.starts_with("not ")
        || topic.contains(" and then ")
        || topic.contains(" then ")
        || [
            "call", "text", "message", "send", "set", "open", "delete", "take", "capture",
            "record", "turn",
        ]
        .iter()
        .any(|verb| contains_word_phrase(topic, &format!("and {verb}")))
    {
        return None;
    }
    Some(topic.to_string())
}

pub(super) fn generated_playlist_argument_matches(utterance: &str, arguments: &Value) -> bool {
    let Some(expected) = generated_playlist_requested_topic(utterance) else {
        return false;
    };
    arguments
        .get("playlist")
        .and_then(Value::as_str)
        .is_some_and(|provided| {
            !provided.trim().is_empty()
                && !provided.chars().any(char::is_control)
                && utterance.contains(provided)
                && normalized_command_text(provided) == expected
        })
}

pub(super) fn direct_music_command_intent(
    mutation: &AdvertisedMutationTool,
    utterance: &str,
) -> bool {
    if is_fieldless_direct_music_mutation(mutation) {
        let Some(spec) = native_action_spec(mutation.action) else {
            return false;
        };
        return classify_fieldless_music_grounding(spec, utterance)
            == Some(FieldlessMusicGrounding::AuthoritativeDirectCommand);
    }
    mutation.action == native_actions::GENERATE_MUSIC_PLAYLIST
        && generated_playlist_requested_topic(utterance).is_some()
}

/// Word-boundary phrase match on an already-lowercased haystack (mirrors
/// `understand::contains_phrase`): matches the whole string, a prefix followed
/// by a space, a space-preceded suffix, or a space-bounded interior — so short
/// terms like "rain" never fire inside "train".
pub(super) fn contains_word_phrase(haystack: &str, phrase: &str) -> bool {
    haystack == phrase
        || haystack.starts_with(&format!("{phrase} "))
        || haystack.ends_with(&format!(" {phrase}"))
        || haystack.contains(&format!(" {phrase} "))
}
