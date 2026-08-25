//! Shared types for one provider-agnostic native tool-calling step.
//!
//! One step = one completion request containing the full run transcript plus a
//! JSON-schema tool catalog; the model answers with either assistant text
//! (the final answer) or one batch of tool calls. The loop that drives steps
//! lives in `crate::synapse::chat_turn_loop`; each backend adapts the step to its
//! wire. Every supported provider uses native function calling.
//!
//! These types deliberately mirror the OpenAI function-calling shapes because
//! that is the interoperable format every supported provider is trained on —
//! the design finding recorded in the external-agent architecture comparison.

use std::time::Duration;

use rig::completion::message::Message;

/// One advertised tool: the standard function-calling triple.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolStepDefinition {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema for the arguments object.
    pub parameters: serde_json::Value,
}

/// One tool call proposed by the model in a step response.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolStepCall {
    /// Provider call id when present; synthesized (`call-N`) otherwise so a
    /// result can always be correlated.
    pub call_id: String,
    pub name: String,
    /// Raw JSON arguments object as emitted by the model. Validation and
    /// chat-turn-style drift coercion happen in the loop, not the transport.
    pub arguments: serde_json::Value,
}

/// One tool step request. `messages` is the canonical transcript in rig
/// message form (user turn, assistant tool-call turns, tool results); backends
/// convert to their wire as needed and MUST NOT reorder or drop entries.
pub struct ToolStepRequest {
    pub system_prompt: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolStepDefinition>,
    /// Per-attempt provider bound (provider-aware; see
    /// `services::aibus::turn::orchestration::model_step_timeout`).
    pub timeout: Duration,
    pub correlation: String,
}

/// Model output for one step.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolStepResult {
    /// Assistant text with no tool calls — the final answer for the run
    /// (or the grace answer when tools were withheld).
    Final(String),
    /// One batch of tool calls to execute before the next step. Order is the
    /// model's emission order.
    ToolCalls(Vec<ToolStepCall>),
}

impl ToolStepResult {
    #[cfg(test)]
    pub fn is_final(&self) -> bool {
        matches!(self, Self::Final(_))
    }
}

/// Bound the serialized argument payload of a single tool call. Large blobs
/// are a prompt-injection/exfiltration smell and never legitimate for the
/// wearable tool surface.
pub const MAX_TOOL_STEP_ARG_BYTES: usize = 4 * 1024;

/// Bound one tool result observation before it re-enters the transcript.
/// Mirrors the existing knowledge-extract citability bound rationale: concise
/// observations keep the transcript small and the spoken pipeline fast.
pub const MAX_TOOL_STEP_RESULT_BYTES: usize = 4 * 1024;

/// Prefix stamped onto every failed tool observation, following the reference agent
/// (`model_tools.py` `[TOOL_ERROR]`): a stable marker the model can key on
/// that ordinary tool output can never contain (results are JSON-encoded, so
/// an adversarial payload cannot start a line with this token unescaped).
pub const TOOL_STEP_ERROR_PREFIX: &str = "[TOOL_ERROR]";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_result_finality() {
        assert!(ToolStepResult::Final("done".into()).is_final());
        assert!(!ToolStepResult::ToolCalls(vec![]).is_final());
    }
}
