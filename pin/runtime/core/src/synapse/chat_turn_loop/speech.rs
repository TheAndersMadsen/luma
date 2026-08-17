//! Output language: the speakable answer, decline speech, the bounded
//! backend-error rendering, and the internal-vocabulary guard that keeps
//! engineering terms out of anything spoken.

use super::*;

/// Closed-set, content-free category for a backend error string.
/// Turn a model answer into something a speaker should say out loud.
///
/// "No markdown, no lists, no URLs" exists only as prompt text, and a model
/// that ignores it gets narrated verbatim — so a bulleted answer is read as
/// "dash … dash …", `**really**` becomes "asterisk asterisk really", and a bare
/// URL is spelled out character by character. The input side is already bounded;
/// this gives the output side the same treatment.
///
/// Deliberately conservative: it removes markup that only ever exists for a
/// screen, and leaves prose alone. It does not try to rewrite the answer.
pub(super) fn speakable_answer(answer: &str) -> String {
    let mut out = String::with_capacity(answer.len());
    for raw_line in answer.lines() {
        let mut line = raw_line.trim();

        // Heading markers and block quotes: screen-only furniture.
        line = line.trim_start_matches(['#', '>']).trim_start();

        // List bullets. Ordered markers ("1.", "2)") are only stripped when
        // they open the line, so "won 3. place" is untouched.
        if let Some(rest) = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .or_else(|| line.strip_prefix("+ "))
        {
            line = rest.trim_start();
        } else {
            let digits: String = line.chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                let after = &line[digits.len()..];
                if let Some(rest) = after
                    .strip_prefix(". ")
                    .or_else(|| after.strip_prefix(") "))
                {
                    line = rest.trim_start();
                }
            }
        }

        if line.is_empty() {
            continue;
        }
        if !out.is_empty() {
            // Join lines as sentences so the narrator does not run them
            // together, and does not pause as if reading a list.
            if !out.ends_with(['.', '!', '?', ',', ';', ':']) {
                out.push('.');
            }
            out.push(' ');
        }
        out.push_str(line);
    }

    // Emphasis and code markers, which are pronounced if left in.
    let out: String = out
        .replace("**", "")
        .replace("__", "")
        .replace(['`', '*'], "");

    // Bare URLs read terribly aloud; drop the token rather than spell it.
    let out = out
        .split_whitespace()
        .filter(|token| {
            let t = token.trim_matches(|c: char| !c.is_alphanumeric());
            !(t.starts_with("http://") || t.starts_with("https://") || t.starts_with("www."))
        })
        .collect::<Vec<_>>()
        .join(" ");

    let trimmed = out.trim();
    if trimmed.is_empty() {
        // Stripping must never produce silence.
        return answer.trim().to_string();
    }
    bound_bytes(trimmed, MAX_SPOKEN_ANSWER_BYTES)
}

/// Upper bound on one spoken answer. A wearable turn is a short spoken reply;
/// past this the narration outlives the user's patience and the stock timeout.
pub(super) const MAX_SPOKEN_ANSWER_BYTES: usize = 4 * 1024;

/// Longest backend error we are willing to narrate. Provider messages that
/// came through `friendly_error_message` are one short sentence; anything much
/// longer is a raw diagnostic that escaped, and reading it aloud would be worse
/// than the generic line.
pub(super) const MAX_SPOKEN_BACKEND_ERROR_BYTES: usize = 180;

/// What the user actually hears when a turn declines.
///
/// Provider errors that are already wearer-facing sentences are passed through;
/// everything else is translated (see [`speakable_backend_error`]), and
/// anything unexpectedly long or empty falls back to the generic line — a
/// wearable must never read a stack trace out loud.
pub(super) fn decline_speech(reason: ChatTurnDeclineReason, backend_error: Option<&str>) -> String {
    match reason {
        ChatTurnDeclineReason::BackendUnavailable => backend_error
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .map(speakable_backend_error)
            .unwrap_or_else(|| CHAT_TURN_GENERIC_DECLINE.to_string()),
        // Distinct, honest, and each suggests the one thing that actually helps.
        ChatTurnDeclineReason::Budget => {
            "That needed more steps than I can take in one go. Try asking for one thing at a time."
                .to_string()
        }
        ChatTurnDeclineReason::EmptyModel => {
            "I didn't get an answer back that time. Please try again.".to_string()
        }
        ChatTurnDeclineReason::NoProgress => {
            "I couldn't work out how to do that one. Try rephrasing it.".to_string()
        }
    }
}

/// Turn one backend error into something a person wearing a Pin can hear.
///
/// Measured defect this exists for: the Pin said, out loud, "The Codex host
/// bridge could not be verified. Check Wi-Fi, TLS, and the bridge process." The
/// wearer is on a pavement somewhere; the computer running the bridge is not
/// with them, and TLS is not theirs to check. That sentence reached the speaker
/// because this function used to end in `_ => error.to_string()` — a verbatim
/// passthrough of anything short enough to narrate.
///
/// The passthrough was only ever safe for the rig providers, whose errors are
/// rewritten by `llm::error::friendly_error_message` before they leave the
/// provider. The Codex provider mints its own sentences for a host operator and
/// never called it, so ~9 operator instructions went straight to the speaker.
/// The arm is therefore a WHITELIST of the sentences that layer authors for a
/// wearer, and everything else is mapped through the same rewriter the rig path
/// already trusts.
///
/// Speech only. The raw error is untouched everywhere it matters for diagnosis:
/// `chat_turn_backend_error_category` and `chat_turn_backend_error_is_retryable`
/// both still read the original text, and the precise fault is named in the host
/// log by the layer that observed it (`llm::local_codex_bridge` `chat_outcome`).
/// That separation is deliberate — a previous attempt to soften the *diagnosis*
/// blamed login for every 503 and sent owners to repair a healthy session.
pub(super) fn speakable_backend_error(error: &str) -> String {
    match chat_turn_backend_error_category(error) {
        // Developer-facing strings: say something the owner can act on instead.
        "unsupported_backend" => {
            "This device's AI model isn't set up for that. Please check the server settings."
                .to_string()
        }
        "oversized_args" => {
            "That was too much for me at once. Try asking for one thing at a time.".to_string()
        }
        _ if error.len() > MAX_SPOKEN_BACKEND_ERROR_BYTES => CHAT_TURN_GENERIC_DECLINE.to_string(),
        // Already a friendly, speakable sentence from the provider layer.
        _ if WEARER_FACING_ERRORS.contains(&error) => error.to_string(),
        // A host-operator diagnostic. Say the wearer's version of it instead.
        _ => friendly_error_message(&error),
    }
}

// ─── Spoken-register guard ──────────────────────────────────────────
//
// Measured defect this exists for: the Pin said, out loud, "I can't access
// music search or playback in this run." A person wearing a Pin cannot know
// what a "run" is. The phrase was never a spoken string we wrote — the model
// copied it verbatim out of `play_music`'s own tool text, and nothing between
// the model and the narrator inspects wording (`speakable_answer` strips screen
// markup; `bound_spoken_answer` only truncates).
//
// A model can always echo something we did not anticipate, so this cannot be a
// complete defence. What it CAN do is keep the vocabulary out of the strings we
// author ourselves, which is the half we control, and fail loudly the moment
// one creeps back in.

/// Words and phrases that belong to the implementation and must never reach a
/// spoken reply, each with the reason it is banned.
///
/// Scope, deliberately narrow: this is asserted over strings the USER HEARS.
/// It is never applied to tracing/telemetry text, to
/// [`ChatTurnDeclineReason::label`], to the `thought` strings that travel beside
/// a spoken response, or to the model-facing failed observations in
/// `tool_catalog`. Those are diagnostics, and their engineering precision is
/// exactly what made this defect findable — sanitising them would trade a real
/// capability for a cosmetic one.
///
/// Matching is word-boundary and case-insensitive, over text normalised so that
/// punctuation and underscores are separators. `call_id` and `from_call_id`
/// therefore both match the single entry `"call id"`, and `run` does not match
/// `running`.
///
/// Test-only on purpose: this is a build-time guard over the strings this
/// repository authors, not a runtime filter. A runtime filter over model output
/// would be the wrong shape — it would silently rewrite an answer the model
/// meant, and hide the fact that our own text taught it the word.
#[cfg(test)]
pub const INTERNAL_VOCABULARY: &[(&str, &str)] = &[
    // The exact phrase the device was measured speaking aloud.
    (
        "in this run",
        "the measured leak; a wearer has no notion of a run",
    ),
    ("this run", "same leak without the preposition"),
    (
        "run",
        "one model-and-tool loop: engine bookkeeping, not anything the user owns",
    ),
    // Identifiers and transcript machinery.
    (
        "call id",
        "an internal identifier (also matches call_id / from_call_id)",
    ),
    ("tool step", "one internal model-and-tool exchange"),
    (
        "tool",
        "the model's implementation surface; the user asked for an answer",
    ),
    ("tools", "plural of the same"),
    (
        "observation",
        "our word for a tool result in transcript form",
    ),
    ("preflight", "our word for a staged device read"),
    ("iteration", "a step of the loop"),
    // Gate and routing vocabulary.
    (
        "catalog",
        "the native-action validation table; it appeared in the defect trace",
    ),
    (
        "grounding",
        "the argument-provenance check; nothing the user can act on",
    ),
    ("grounded", "same check, adjectival form"),
    ("mutation", "our word for a side-effecting action"),
    ("utterance", "our word for what the user just said"),
    (
        "trusted current user",
        "the authorization gate's own name; describes our trust, not their request",
    ),
    ("trusted user", "shortened form of the same gate"),
    // Which upstream service answered is ours to know, not theirs.
    ("provider", "which upstream service backs a read"),
    ("backend", "same, for the model service"),
    // Host-operator vocabulary. The wearer is walking around with a Pin on
    // their shirt; the machine running the server is not with them, so a
    // sentence that asks them to inspect it is not an answer, it is a chore
    // they cannot do. Measured: the Pin said "Check Wi-Fi, TLS, and the bridge
    // process" out loud.
    (
        "codex",
        "the host program's own name; nothing a wearer owns",
    ),
    ("bridge", "the host process that fronts it"),
    ("tls", "transport security; not the wearer's to check"),
    (
        "http",
        "wire vocabulary, and it also catches an HTTP status leak",
    ),
    ("endpoint", "the address of a service; wire vocabulary"),
    (
        "process",
        "an operating-system process on a machine they are not near",
    ),
    // Engine and wire names.
    ("agentic", "the runtime's internal name"),
    ("correlation", "the trace id that ties one turn together"),
    ("schema", "argument shape"),
    ("payload", "wire vocabulary"),
    ("json", "wire vocabulary"),
    ("grpc", "wire vocabulary"),
    ("token", "model or auth accounting"),
    ("tokens", "plural of the same"),
    // Assistant self-description. A wearer asked their Pin a question; a
    // sentence about the machinery answering it is never the answer.
    ("as an ai", "chatbot self-description"),
    ("language model", "the implementation class, not an answer"),
    ("llm", "the same, abbreviated"),
    ("system prompt", "the instruction channel's own name"),
];

/// Canned chatbot filler that must never appear in a FIXED wearer-facing
/// string. These are phrases, not vocabulary: each is the opening of a
/// sentence that performs helpfulness instead of answering. They are tested
/// against system-authored strings only — a wearer's own note or a quoted
/// search result is never rewritten or rejected for containing them.
#[cfg(test)]
pub(crate) const CANNED_FILLER: &[(&str, &str)] = &[
    ("i can help with that", "performs helpfulness; the help is the answer"),
    ("let me", "narrates intent instead of acting on it"),
    ("i would be happy to", "same performance, longer"),
    ("as requested", "restates the request back at the wearer"),
];

/// The first canned-filler phrase present in `text`, if any.
#[cfg(test)]
pub(crate) fn canned_filler_hit(text: &str) -> Option<&'static str> {
    let haystack = normalized_for_vocabulary(text);
    CANNED_FILLER
        .iter()
        .map(|(phrase, _)| *phrase)
        .find(|phrase| haystack.contains(&normalized_for_vocabulary(phrase)))
}

/// True when `text` apologises more than once — the apology loop. One apology
/// can be honest; a second one in the same breath is filler that costs the
/// wearer time on a device they listen to.
#[cfg(test)]
pub(crate) fn is_apology_loop(text: &str) -> bool {
    let haystack = normalized_for_vocabulary(text);
    let apologies = ["sorry", "i apologize", "apologies"];
    let count: usize = apologies
        .iter()
        .map(|term| haystack.matches(&normalized_for_vocabulary(term)).count())
        .sum();
    count > 1
}

/// Normalise text for word-boundary vocabulary matching: lowercase, every
/// non-alphanumeric character becomes a separator, and the result is padded
/// with spaces so a term can be matched with its own boundaries included.
#[cfg(test)]
pub(super) fn normalized_for_vocabulary(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len() + 2);
    normalized.push(' ');
    for character in text.chars() {
        if character.is_alphanumeric() {
            normalized.extend(character.to_lowercase());
        } else if !normalized.ends_with(' ') {
            normalized.push(' ');
        }
    }
    if !normalized.ends_with(' ') {
        normalized.push(' ');
    }
    normalized
}

/// The first [`INTERNAL_VOCABULARY`] term present in `text`, if any.
#[cfg(test)]
pub fn internal_vocabulary_hit(text: &str) -> Option<&'static str> {
    let haystack = normalized_for_vocabulary(text);
    INTERNAL_VOCABULARY
        .iter()
        .map(|(term, _)| *term)
        .find(|term| haystack.contains(&normalized_for_vocabulary(term)))
}

/// Whether retrying or spending more budget could plausibly change the outcome.
///
/// A bad API key, a missing model or a content-filter refusal will fail
/// identically on every retry, so burning the remaining deadline on them only
/// delays a failure the user could already have been told about — the reason a
/// misconfigured provider takes the better part of a minute to report.
pub(super) fn chat_turn_backend_error_is_retryable(message: &str) -> bool {
    let raw = message.to_lowercase();
    let permanent = [
        "api key",
        "model wasn't found",
        "model not found",
        "declined to answer",
        "does not support the tool-step loop",
        "check the server settings",
    ];
    !permanent.iter().any(|marker| raw.contains(marker))
}

pub(super) fn chat_turn_backend_error_category(message: &str) -> &'static str {
    if message.contains("timed out") {
        "timeout"
    } else if message.contains("does not support the tool-step loop") {
        "unsupported_backend"
    } else if message.contains("empty response") {
        "empty_response"
    } else if message.contains("oversized") {
        "oversized_args"
    } else {
        "backend_other"
    }
}
