//! Shared request-language authority boundary for native actions and trusted reads.
//!
//! A command-shaped string is not necessarily a command. Quoted examples,
//! hypotheticals, metalinguistic discussion, and explicit negation can contain
//! the exact words a deterministic planner recognizes without authorizing that
//! planner. This classifier is deliberately lexical and fail-closed only for
//! those narrow shapes. It does not infer the user's desired action, which
//! remains Sol's job for otherwise-unhandled wording.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NonAuthoritativeIntentReason {
    QuotedUtterance,
    Hypothetical,
    Retrospective,
    Metalinguistic,
    Negated,
}

/// Return why the utterance cannot authorize a native action or trusted read.
///
/// Quoted entities remain usable when an outer verb supplies real authority,
/// for example `play "Beat It"`. Likewise, a translation request may quote its
/// payload because `How do you say 'thank you' in German?` is itself a direct
/// request for the Translate action rather than a mention of Translate.
pub fn non_authoritative_intent_reason(utterance: &str) -> Option<NonAuthoritativeIntentReason> {
    let trimmed = utterance.trim();
    if trimmed.is_empty() {
        return None;
    }
    if whole_utterance_is_quoted(trimmed) {
        return Some(NonAuthoritativeIntentReason::QuotedUtterance);
    }

    let normalized = normalize_words(trimmed);
    if is_explicitly_negated(&normalized) {
        return Some(NonAuthoritativeIntentReason::Negated);
    }
    if is_hypothetical(&normalized) {
        return Some(NonAuthoritativeIntentReason::Hypothetical);
    }
    if is_retrospective(&normalized) {
        return Some(NonAuthoritativeIntentReason::Retrospective);
    }
    if is_metalinguistic(trimmed, &normalized) {
        return Some(NonAuthoritativeIntentReason::Metalinguistic);
    }
    None
}

fn whole_utterance_is_quoted(value: &str) -> bool {
    let candidate = value.trim_end_matches(['.', '!', '?']).trim_end();
    let mut characters = candidate.chars();
    let Some(opening) = characters.next() else {
        return false;
    };
    let Some(closing) = candidate.chars().next_back() else {
        return false;
    };
    if candidate.len() <= opening.len_utf8() + closing.len_utf8() {
        return false;
    }
    matches!(
        (opening, closing),
        ('"', '"') | ('\'', '\'') | ('`', '`') | ('“', '”') | ('‘', '’')
    )
}

fn normalize_words(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
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

fn is_explicitly_negated(normalized: &str) -> bool {
    let command = strip_polite_request_prefix(normalized);
    [
        "do not ",
        "don t ",
        "dont ",
        "no do not ",
        "no don t ",
        "i do not want ",
        "i don t want ",
        "i dont want ",
        "i did not ask ",
        "i didn t ask ",
        "not ",
    ]
    .iter()
    .any(|prefix| command.starts_with(prefix))
        || ["never "]
            .iter()
            .find_map(|prefix| command.strip_prefix(prefix))
            .is_some_and(starts_with_directive_word)
}

fn is_hypothetical(normalized: &str) -> bool {
    [
        "what happens if i say",
        "what would happen if i say",
        "what happens when i say",
        "what would happen when i say",
        "if i say",
        "if i said",
        "if i asked",
        "if i asked you to",
        "if i were to",
        "if i told you to",
        "if you heard me say",
        "suppose i say",
        "suppose i said",
        "suppose i asked",
        "imagine i say",
        "imagine i said",
        "imagine i asked",
        "hypothetically",
        "in a hypothetical",
        "for example if i say",
        "what if i say",
    ]
    .iter()
    .any(|phrase| contains_phrase(normalized, phrase))
}

/// Past-tense questions can contain an exact action phrase without granting
/// authority to repeat that action now. Keep this deliberately narrow: it
/// covers retrospective assistant/device questions, not ordinary current
/// requests such as `pause the music` or `what's the weather?`.
fn is_retrospective(normalized: &str) -> bool {
    [
        "did you ",
        "why did you ",
        "when did you ",
        "what did you ",
        "how did you ",
        "were you ",
        "why were you ",
        "when were you ",
        "have you already ",
        "why have you ",
        "when have you ",
        "when was the ",
        "why was the ",
        "how was the ",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
}

fn is_metalinguistic(raw: &str, normalized: &str) -> bool {
    let has_quote = raw
        .chars()
        .any(|character| matches!(character, '"' | '\'' | '`' | '“' | '”' | '‘' | '’'));
    let command = strip_polite_request_prefix(normalized);
    if has_quote && has_authoritative_quoted_payload_action(command) {
        return false;
    }

    if [
        "the phrase",
        "these words",
        "the words",
        "the command",
        "this command",
        "that command",
        "a voice command",
        "an instruction",
        "the utterance",
        "literally say",
    ]
    .iter()
    .any(|phrase| {
        command == *phrase
            || command.starts_with(&format!("{phrase} "))
            || (has_quote && contains_phrase(normalized, phrase))
    }) {
        return true;
    }

    has_quote
        && [
            "say ",
            "repeat ",
            "quote ",
            "spell ",
            "pronounce ",
            "define ",
            "explain the phrase ",
            "tell me about the phrase ",
        ]
        .iter()
        .any(|prefix| command.starts_with(prefix))
        || first_quoted_payload(raw).is_some_and(|payload| {
            looks_like_directive(&normalize_words(payload))
                && [
                    "what does ",
                    "what do ",
                    "what is meant by ",
                    "tell me about ",
                    "explain ",
                    "define ",
                    "describe ",
                    "is ",
                ]
                .iter()
                .any(|prefix| command.starts_with(prefix))
        })
}

fn has_authoritative_quoted_payload_action(normalized: &str) -> bool {
    [
        "play ",
        "listen to ",
        "put on ",
        "look up ",
        "lookup ",
        "search for ",
        "find ",
        "translate ",
        "how do you say ",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
}

fn strip_polite_request_prefix(value: &str) -> &str {
    [
        "can you please ",
        "could you please ",
        "would you please ",
        "can you ",
        "could you ",
        "would you ",
        "please ",
    ]
    .iter()
    .find_map(|prefix| value.strip_prefix(prefix))
    .unwrap_or(value)
}

fn first_quoted_payload(value: &str) -> Option<&str> {
    for (opening_index, opening) in value.char_indices() {
        let closing = match opening {
            '"' => '"',
            '\'' => '\'',
            '`' => '`',
            '“' => '”',
            '‘' => '’',
            _ => continue,
        };
        let payload_start = opening_index + opening.len_utf8();
        let remainder = value.get(payload_start..)?;
        let closing_offset = remainder.find(closing)?;
        let payload = remainder.get(..closing_offset)?.trim();
        if !payload.is_empty() {
            return Some(payload);
        }
    }
    None
}

fn looks_like_directive(normalized: &str) -> bool {
    starts_with_directive_word(normalized)
        || matches!(
            normalized,
            "coffee near me" | "cafes near me" | "cafe near me"
        )
}

fn contains_phrase(normalized: &str, phrase: &str) -> bool {
    normalized == phrase
        || normalized.starts_with(&format!("{phrase} "))
        || normalized.ends_with(&format!(" {phrase}"))
        || normalized.contains(&format!(" {phrase} "))
}

fn starts_with_directive_word(value: &str) -> bool {
    const DIRECTIVE_WORDS: &[&str] = &[
        "accept",
        "answer",
        "call",
        "capture",
        "check",
        "clear",
        "delete",
        "dial",
        "directions",
        "disable",
        "enable",
        "end",
        "enter",
        "find",
        "forget",
        "get",
        "hang",
        "increase",
        "lock",
        "log",
        "look",
        "lower",
        "message",
        "navigate",
        "next",
        "open",
        "pause",
        "play",
        "previous",
        "raise",
        "read",
        "record",
        "remember",
        "restart",
        "resume",
        "save",
        "search",
        "send",
        "set",
        "show",
        "skip",
        "start",
        "stop",
        "take",
        "text",
        "tickle",
        "track",
        "translate",
        "turn",
        "volume",
        "where",
    ];
    let first = value.split_whitespace().next().unwrap_or_default();
    DIRECTIVE_WORDS.contains(&first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_hypothetical_metalinguistic_and_negated_commands_are_not_authority() {
        for utterance in [
            "\"take a photo\"",
            "“enter privacy mode”",
            "'volume up'",
            "`start tracking my run`",
            "\"hang up\"?",
            "\"set a timer for five minutes\"",
            "\"set an alarm for 7 am\"",
            "\"coffee near me\"",
            "do not find coffee near me",
            "Please don't pause the music",
            "Could you not pause the music?",
            "Never take a photo",
            "What happens if I say \"pause the music\"?",
            "Suppose I said take a photo",
            "Explain the phrase \"volume up\"",
            "Please explain \"coffee near me\"",
            "What does \"volume up\" do?",
            "Is \"hang up\" a voice command?",
            "Why did you pause the music?",
            "When did you set the alarm?",
            "Did you call Alex?",
            "When was the timer started?",
        ] {
            assert!(
                non_authoritative_intent_reason(utterance).is_some(),
                "expected mention-only classification for {utterance}"
            );
        }
    }

    #[test]
    fn outer_actions_quoted_entities_translation_and_exact_tickle_keep_authority() {
        for utterance in [
            "play \"Beat It\"",
            "play \"The Phrase\"",
            "Play \"Do Not Disturb\" by Drake",
            "look up \"Beat It\" by Michael Jackson",
            "How do you say 'thank you' in German?",
            "translate \"take a photo\" to German",
            "translate \"the command volume up\" to German",
            "Please translate \"the phrase volume up\" to German",
            "Could you play \"The Phrase\"?",
            "What does \"Beat It\" mean?",
            "tickle",
            "tickle my fancy",
            "tickle tickle tickle",
            "pause the music",
            "find coffee near me",
        ] {
            assert_eq!(
                non_authoritative_intent_reason(utterance),
                None,
                "unexpected authority rejection for {utterance}"
            );
        }
    }
}
