//! Transcript shaping: canonical arguments, bounded observations, transcript
//! accounting, and the assistant/tool message constructors.

use super::*;

/// Order-independent serialization of a tool call's arguments, for use as a
/// within-turn memo key.
///
/// Keys are sorted recursively so `{"artist":"X","limit":5}` and
/// `{"limit":5,"artist":"X"}` produce one key: they are the same request and
/// must not cost two network round-trips. Sorting is recursive because nested
/// objects contain arguments too.
pub(super) fn canonical_arguments(arguments: &serde_json::Value) -> String {
    fn canonicalize(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(fields) => serde_json::Value::Object(
                fields
                    .iter()
                    .map(|(key, nested)| (key.clone(), canonicalize(nested)))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            serde_json::Value::Array(items) => {
                // Arrays are ordered data, not a key set: [a, b] and [b, a] are
                // different requests. Recurse without reordering.
                serde_json::Value::Array(items.iter().map(canonicalize).collect())
            }
            other => other.clone(),
        }
    }
    canonicalize(arguments).to_string()
}

/// Stamp `[TOOL_ERROR]` on a failed observation and bound its size before it
/// re-enters the transcript. A successful observation is passed through
/// (already bounded by the tools impl, but re-bounded defensively).
pub(super) fn bound_observation(ok: bool, content: &str) -> String {
    let body = bound_bytes(content, MAX_TOOL_STEP_RESULT_BYTES);
    if ok {
        body
    } else {
        format!("{TOOL_STEP_ERROR_PREFIX} {body}")
    }
}

/// How many characters this step actually asked the model to read: the system
/// prompt plus every text part of the transcript.
///
/// Shape, not content — the text itself never leaves the transcript. Non-text
/// parts (images, audio, documents, reasoning blocks) count zero rather than
/// guessing at a character equivalent for bytes.
pub(super) fn transcript_chars(system_prompt: &str, messages: &[Message]) -> usize {
    fn user_chars(content: &UserContent) -> usize {
        match content {
            UserContent::Text(text) => text.text.chars().count(),
            UserContent::ToolResult(result) => result
                .content
                .iter()
                .map(|item| match item {
                    ToolResultContent::Text(text) => text.text.chars().count(),
                    _ => 0,
                })
                .sum(),
            _ => 0,
        }
    }

    fn assistant_chars(content: &AssistantContent) -> usize {
        match content {
            AssistantContent::Text(text) => text.text.chars().count(),
            // A proposed call costs the model its name and its arguments.
            AssistantContent::ToolCall(call) => {
                call.function.name.chars().count()
                    + call.function.arguments.to_string().chars().count()
            }
            _ => 0,
        }
    }

    system_prompt.chars().count()
        + messages
            .iter()
            .map(|message| match message {
                Message::User { content } => content.iter().map(user_chars).sum::<usize>(),
                Message::Assistant { content, .. } => {
                    content.iter().map(assistant_chars).sum::<usize>()
                }
                // The loop never builds one (the system prompt travels in its
                // own request field), but a provider adapter could.
                Message::System { content } => content.chars().count(),
            })
            .sum::<usize>()
}

pub(super) fn bound_bytes(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = 0;
    for (start, ch) in value.char_indices() {
        let next = start + ch.len_utf8();
        if next > max {
            break;
        }
        end = next;
    }
    value[..end].to_string()
}

pub(super) fn assistant_tool_calls_message(calls: &[ToolStepCall]) -> Message {
    Message::Assistant {
        id: None,
        content: OneOrMany::many(
            calls
                .iter()
                .map(|call| {
                    AssistantContent::ToolCall(ToolCall {
                        id: call.call_id.clone(),
                        call_id: Some(call.call_id.clone()),
                        function: ToolFunction {
                            name: call.name.clone(),
                            arguments: call.arguments.clone(),
                        },
                        signature: None,
                        additional_params: None,
                    })
                })
                .collect::<Vec<_>>(),
        )
        .expect("selected tool-call batch is non-empty"),
    }
}

/// Whether a transcript entry is a tool result, i.e. evidence this run actually
/// gathered something worth answering from.
pub(super) fn is_tool_result_message(message: &Message) -> bool {
    let Message::User { content } = message else {
        return false;
    };
    content
        .iter()
        .any(|item| matches!(item, UserContent::ToolResult(_)))
}

pub(super) fn tool_result_message(call: &ToolStepCall, content: &str) -> Message {
    Message::User {
        content: OneOrMany::one(UserContent::tool_result(
            call.call_id.clone(),
            OneOrMany::one(ToolResultContent::text(content.to_string())),
        )),
    }
}

pub(super) fn tool_results_message(results: &[(ToolStepCall, String)]) -> Message {
    Message::User {
        content: OneOrMany::many(
            results
                .iter()
                .map(|(call, content)| {
                    UserContent::tool_result(
                        call.call_id.clone(),
                        OneOrMany::one(ToolResultContent::text(content.clone())),
                    )
                })
                .collect::<Vec<_>>(),
        )
        .expect("parallel read batch is non-empty"),
    }
}
