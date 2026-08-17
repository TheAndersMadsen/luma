use std::fmt::Display;

/// Every sentence this module is willing to say out loud, named so that other
/// layers can recognise one rather than pattern-match its text.
///
/// The speech boundary in `synapse::chat_turn_loop` treats membership here as
/// "already written for a wearer" and passes it through untouched; anything
/// else is a raw diagnostic and gets mapped by [`friendly_error_message`]
/// first. `friendly_error_message` returns one of these and nothing else —
/// `every_branch_returns_a_registered_sentence` pins that, so the set cannot
/// drift out from under the passthrough.
pub const WEARER_FACING_ERRORS: &[&str] = &[
    RATE_LIMITED,
    BAD_CREDENTIALS,
    MODEL_NOT_FOUND,
    SERVICE_UNAVAILABLE,
    TIMED_OUT,
    UNREACHABLE,
    REFUSED,
    CONTEXT_TOO_LONG,
    UNDIAGNOSED,
];

const RATE_LIMITED: &str = "I'm getting too many requests right now. Please try again in a moment.";
/// Wording note: "check the server settings" is also the marker
/// `chat_turn_loop::chat_turn_backend_error_is_retryable` reads to know this
/// fault fails identically on every retry. Rewording it without updating that
/// list would spend the rest of a turn's deadline retrying a dead key.
const BAD_CREDENTIALS: &str =
    "There's a problem with the API key configuration. Please check the server settings.";
const MODEL_NOT_FOUND: &str =
    "The configured AI model wasn't found. Please check the server settings.";
const SERVICE_UNAVAILABLE: &str =
    "The AI service is temporarily unavailable. Please try again shortly.";
const TIMED_OUT: &str = "The request to the AI service timed out. Please try again.";
const UNREACHABLE: &str =
    "I couldn't reach the AI service. Please check the server's internet connection.";
const REFUSED: &str = "The AI service declined to answer that. Try rephrasing your question.";
const CONTEXT_TOO_LONG: &str =
    "That conversation got too long for the AI service to handle. Try starting a new one.";
const UNDIAGNOSED: &str = "Something went wrong while contacting the AI service. Please try again.";

/// Convert a raw LLM provider error into a friendly, speakable sentence.
pub fn friendly_error_message(e: &impl Display) -> String {
    let raw = e.to_string().to_lowercase();

    if raw.contains("429")
        || raw.contains("rate limit")
        || raw.contains("resource_exhausted")
        || raw.contains("too many requests")
    {
        RATE_LIMITED.into()
    } else if raw.contains("401")
        || raw.contains("403")
        || raw.contains("unauthorized")
        || raw.contains("forbidden")
        || raw.contains("invalid api key")
        || raw.contains("permission denied")
    {
        BAD_CREDENTIALS.into()
    } else if raw.contains("404")
        || raw.contains("model not found")
        || raw.contains("not_found")
        || raw.contains("does not exist")
    {
        MODEL_NOT_FOUND.into()
    } else if raw.contains("500")
        || raw.contains("502")
        || raw.contains("503")
        || raw.contains("internal server error")
        || raw.contains("service unavailable")
        || raw.contains("bad gateway")
    {
        SERVICE_UNAVAILABLE.into()
    } else if raw.contains("timeout")
        || raw.contains("timed out")
        || raw.contains("deadline exceeded")
    {
        TIMED_OUT.into()
    } else if raw.contains("connection")
        || raw.contains("dns")
        || raw.contains("resolve")
        || raw.contains("unreachable")
    {
        UNREACHABLE.into()
    } else if raw.contains("content filter")
        || raw.contains("safety")
        || raw.contains("blocked")
        || raw.contains("harm_category")
    {
        REFUSED.into()
    } else if raw.contains("context length")
        || raw.contains("too long")
        || raw.contains("max tokens")
        || raw.contains("token limit")
    {
        CONTEXT_TOO_LONG.into()
    } else {
        UNDIAGNOSED.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_branch_returns_a_registered_sentence() {
        // One raw error per branch, in branch order, so a reworded sentence
        // that was not registered turns this red instead of silently escaping
        // the speech passthrough. The last entry matches no keyword and so
        // exercises the fallback.
        let per_branch = [
            "HTTP 429 rate limit exceeded",
            "401 unauthorized: invalid api key",
            "404 model not found",
            "503 service unavailable",
            "request timed out after 240s",
            "connection reset by peer",
            "response blocked by content filter",
            "context length exceeded",
            "socket hang up",
        ];

        let mut produced = Vec::new();
        for raw in per_branch {
            let spoken = friendly_error_message(&raw);
            assert!(
                WEARER_FACING_ERRORS.contains(&spoken.as_str()),
                "unregistered sentence for {raw:?}: {spoken}",
            );
            produced.push(spoken);
        }

        // Aliveness: nine distinct branches must produce nine distinct
        // sentences, so a collapsed mapping cannot pass by returning one line
        // that happens to be registered.
        produced.sort();
        produced.dedup();
        assert_eq!(produced.len(), WEARER_FACING_ERRORS.len());
    }
}
