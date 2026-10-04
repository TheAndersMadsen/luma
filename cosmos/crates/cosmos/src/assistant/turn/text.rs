//! Speakable-text selection and the bounded model-facing observation, the two
//! text seams every transport pushes a model result through.

use super::super::catalog;

/// The spoken text inside a model answer: the `RESPOND_FIELD` of a JSON body
/// when the model produced one, the raw text otherwise, and `None` for silence.
pub(crate) fn spoken_text(input: &str) -> Option<String> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(input) {
        if let Some(s) = v.get(catalog::RESPOND_FIELD).and_then(|v| v.as_str()) {
            return Some(s.to_owned());
        }
    }
    if input.is_empty() {
        None
    } else {
        Some(input.to_owned())
    }
}

/// The most an observation may hand the model.
///
/// The full text still reaches the recorded turn. This bound is only for the
/// prompt, because that text is paid for twice: once in prompt tokens and once
/// in the latency of processing them.
pub(crate) const MAX_MODEL_FACING_OBSERVATION: usize = 1_200;

/// What the model reads of the result of the tool it just called.
///
/// INFERRED: an MCP tool's result is the owner's own data, a list or a
/// document, and the model has to read it to answer from it. `McpStore::call`
/// bounds it, far above the general bound. Every other tool keeps that bound,
/// and so does every result replayed from an earlier run.
pub(crate) fn model_facing_tool_observation<'a>(
    tool: &str,
    observation: &'a str,
) -> std::borrow::Cow<'a, str> {
    if crate::mcp::is_tool_name(tool) {
        return std::borrow::Cow::Borrowed(observation);
    }
    model_facing_observation(observation)
}

/// What goes into the turn the Pin records for a tool's result.
///
/// The Pin sends its recorded turns back with every later request, so an MCP
/// tool's long result is recorded in a short form. Every other tool's
/// observation is recorded whole, as before.
pub(crate) fn recorded_observation<'a>(
    tool: &str,
    observation: &'a str,
) -> std::borrow::Cow<'a, str> {
    if crate::mcp::is_tool_name(tool) {
        return crate::mcp::recorded(observation);
    }
    std::borrow::Cow::Borrowed(observation)
}

// The answer engine sizes its observation, sources included, to be shown whole.
const _: () = assert!(crate::backends::perplexity::MAX_CHARS <= MAX_MODEL_FACING_OBSERVATION);

/// The model-facing form of an observation, cut at a character boundary.
pub(crate) fn model_facing_observation(observation: &str) -> std::borrow::Cow<'_, str> {
    if observation.len() <= MAX_MODEL_FACING_OBSERVATION {
        return std::borrow::Cow::Borrowed(observation);
    }
    // Never slice mid-character: observations contain wearer text and tool output,
    // and a byte-offset cut on non-ASCII panics. Prefer the last sentence break
    // so the model is not handed a fragment.
    let mut end = MAX_MODEL_FACING_OBSERVATION;
    while end > 0 && !observation.is_char_boundary(end) {
        end -= 1;
    }
    let clipped = &observation[..end];
    let cut = clipped
        .rfind(". ")
        .map(|i| i + 1)
        .filter(|i| *i > MAX_MODEL_FACING_OBSERVATION / 2)
        .unwrap_or(end);
    // Marked, so the model knows the text was cut rather than treating a
    // truncated list as complete.
    std::borrow::Cow::Owned(format!("{}… [truncated]", &observation[..cut].trim_end()))
}
