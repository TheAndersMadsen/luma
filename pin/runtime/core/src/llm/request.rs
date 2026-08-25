use rig::completion::message::Message;
use serde::{Deserialize, Serialize};

use crate::config::ResolvedConfig;

/// The output contract expected from a provider call. Voice requests keep the
/// ordinary answer-only instruction, while the bounded agentic runtime
/// receives a dedicated JSON-only instruction.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LlmResponseMode {
    #[default]
    VoiceAnswer,
    AgenticJson,
    /// One schema-constrained, non-terminal progress preamble. The bridge must
    /// not expose search or any other tool in this mode.
    ProgressCue,
    /// Tool-free plain text response. Uses the structured (tool-free) agent
    /// to prevent the model from attempting to call tools that are not
    /// registered in the rig tool set (e.g., PlayMusic, which is an agentic
    /// runtime native action, not a rig tool). Used by composition service
    /// and other internal text classification workloads.
    ToolFreeText,
    /// One step of the chat-turn tool-calling loop over a transport with no
    /// native function-calling wire. The caller's tool catalog is embedded in
    /// the system text and the model answers either with plain text or with
    /// `<tool_call>{...}</tool_call>` blocks, so this is the one mode whose
    /// bridge instruction must NOT forbid tool calls. It stays distinct from
    /// every other mode precisely so the six genuinely tool-free `ToolFreeText`
    /// workloads keep their unchanged "no tools" instruction. The tools this
    /// mode permits belong to the caller and execute in the server runtime.
    #[serde(rename = "hermes_tool_loop")]
    ToolStep,
}

#[derive(Clone, Debug)]
pub struct PromptTemplates {
    pub system_prompt: String,
    pub status_prompt: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PromptTemplateContext {
    pub run_id: String,
    pub assistant_display_name: Option<String>,
    pub server_public_addr: String,

    pub current_timestamp: String,
    pub current_date: String,
    pub current_time: String,

    pub location_name: Option<String>,
    pub latitude: Option<String>,
    pub longitude: Option<String>,
    pub coordinates: Option<String>,
}

impl PromptTemplateContext {
    pub fn new(
        run_id: &str,
        config: &ResolvedConfig,
        datetime: chrono::DateTime<chrono::Local>,
    ) -> Self {
        let current_timestamp = datetime.to_rfc3339();
        let current_date = datetime.format("%Y-%m-%d").to_string();
        let current_time = datetime.format("%H:%M:%S %z").to_string();

        Self {
            run_id: run_id.to_string(),
            assistant_display_name: config.config.server.display_name.clone(),
            server_public_addr: config.config.server.public_addr.clone(),

            current_timestamp,
            current_date,
            current_time,

            location_name: None,
            latitude: None,
            longitude: None,
            coordinates: None,
        }
    }
}

/// Request-scoped context for building an LLM call
pub struct LlmChatRequest {
    pub utterance: String,
    pub history: Vec<Message>,
    pub templates: PromptTemplates,
    pub template_context: PromptTemplateContext,
    pub memory_context: Option<String>,
    pub request_context: Option<String>,
    pub response_mode: LlmResponseMode,
    /// Optional trusted per-request model selection. This is used only by
    /// tightly bounded internal workloads whose latency profile differs from
    /// the main assistant. User text must never populate this field.
    pub model_override: Option<String>,

    pub image: Option<Vec<u8>>,
}

impl LlmChatRequest {
    pub fn new(
        utterance: String,
        history: Vec<Message>,
        templates: PromptTemplates,
        template_context: PromptTemplateContext,
        memory_context: Option<String>,
    ) -> Self {
        Self {
            utterance,
            history,
            templates,
            template_context,
            memory_context,
            request_context: None,
            response_mode: LlmResponseMode::VoiceAnswer,
            model_override: None,
            image: None,
        }
    }

    /// Attach trusted, request-scoped data resolved by the on-device server.
    /// This is separate from conversation history so it cannot leak into a
    /// later turn after the device location changes.
    pub fn with_request_context(mut self, request_context: String) -> Self {
        self.request_context = Some(request_context);
        self
    }

    /// Require a tool-free progress-cue JSON response.
    #[cfg(test)]
    pub fn with_progress_cue_output(mut self) -> Self {
        self.response_mode = LlmResponseMode::ProgressCue;
        self
    }

    /// Require a tool-free plain text response. Prevents the model from
    /// attempting to call tools that are not registered in the rig tool set.
    /// Used by composition service and other internal workloads that need
    /// plain text output without tool calling.
    pub fn with_tool_free_text_output(mut self) -> Self {
        self.response_mode = LlmResponseMode::ToolFreeText;
        self
    }

    /// Route this trusted internal request to a specific configured model
    /// without changing the model used by ordinary assistant turns.
    pub fn with_model_override(mut self, model: impl Into<String>) -> Self {
        self.model_override = Some(model.into());
        self
    }

    /// Attach an image asset to this request's new user turn
    pub fn with_image(mut self, image_bytes: Vec<u8>) -> Self {
        self.image = Some(image_bytes);
        self
    }
}
