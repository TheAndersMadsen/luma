//! Explicit shared-text proposal provider; not the OpenAI Realtime protocol.
//! The owned, bounded request has no tools beyond one runtime proposal and no
//! automatic model, provider, key or upstream fallback. It holds no executor.
use crate::{
    assistant::llm::{
        ChatMessage, ChatModel, ChatResponse, LlmError, ModelProvenance, ToolCall, ToolDef,
    },
    integrations::{RealtimeConfig, RealtimeProvider},
};
use serde_json::{Value, json};
use std::time::Duration;
#[cfg(test)]
#[path = "openrouter_tests.rs"]
mod tests;

const MAX_RESPONSE: usize = 64 * 1024;
const DEADLINE: Duration = Duration::from_secs(18);

pub struct OpenRouterTextModel {
    config: RealtimeConfig,
}

impl OpenRouterTextModel {
    pub fn new(config: RealtimeConfig) -> Result<Self, LlmError> {
        if config.provider != RealtimeProvider::OpenRouterText || !config.configured() {
            return Err(LlmError::Transport(
                "text cognition is not configured".into(),
            ));
        }
        Ok(Self { config })
    }

    async fn exchange(
        &self,
        endpoint: &str,
        messages: &[ChatMessage],
        tools: &[ToolDef],
        deadline: Duration,
    ) -> Result<ChatResponse, LlmError> {
        super::realtime::validate_input(messages, tools)?;
        let tool = &tools[0];
        let body = json!({
            "model":self.config.model,
            "messages":[{"role":"system","content":messages[0].content},{"role":"user","content":messages[1].content}],
            "tools":[{"type":"function","function":{"name":tool.name,"description":tool.description,"parameters":tool.parameters}}],
            "tool_choice":{"type":"function","function":{"name":tool.name}},
            "max_tokens":self.config.max_output_tokens,"stream":false,
            "provider":{"only":[self.config.upstream],"allow_fallbacks":false,"require_parameters":true},
        });
        // The selected endpoint need not advertise parallel_tool_calls. Reject
        // extra calls locally; require_parameters must never be disabled to fit it.
        tokio::time::timeout(deadline, async {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(4))
                .timeout(deadline)
                .build()
                .map_err(|_| unavailable())?;
            let mut response = client
                .post(endpoint)
                .bearer_auth(self.config.api_key.as_deref().unwrap_or_default())
                .json(&body)
                .send()
                .await
                .map_err(|_| unavailable())?;
            if !response.status().is_success() {
                return Err(LlmError::Status(response.status().as_u16()));
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE as u64)
            {
                return Err(LlmError::Malformed);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
                if bytes.len() + chunk.len() > MAX_RESPONSE {
                    return Err(LlmError::Malformed);
                }
                bytes.extend_from_slice(&chunk);
            }
            parse(&bytes)
        })
        .await
        .map_err(|_| unavailable())?
    }
}

fn unavailable() -> LlmError {
    LlmError::Transport("text cognition provider unavailable".into())
}

#[tonic::async_trait]
impl ChatModel for OpenRouterTextModel {
    fn provenance(&self) -> ModelProvenance {
        super::realtime::provenance(&self.config)
    }
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        self.exchange(
            "https://openrouter.ai/api/v1/chat/completions",
            messages,
            tools,
            DEADLINE,
        )
        .await
    }
}

fn parse(bytes: &[u8]) -> Result<ChatResponse, LlmError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| LlmError::Malformed)?;
    let choices = value["choices"]
        .as_array()
        .filter(|c| c.len() == 1)
        .ok_or(LlmError::Malformed)?;
    let choice = &choices[0];
    let message = &choice["message"];
    let extra = [
        "refusal",
        "function_call",
        "reasoning",
        "reasoning_details",
        "audio",
        "images",
    ]
    .iter()
    .find(|k| {
        message
            .get(**k)
            .is_some_and(|v| !v.is_null() && v != "" && v != &json!([]))
    });
    let spoke = message
        .get("content")
        .is_some_and(|v| !v.is_null() && v != "");
    if value.get("error").is_some_and(|v| !v.is_null())
        || choice["finish_reason"] != "tool_calls"
        || message["role"] != "assistant"
        || spoke
        || extra.is_some()
    {
        // Content-free shape diagnostics: which rule the reply broke, never
        // what it said. A truncated tool call shows up as finish_reason=length.
        tracing::warn!(
            error = value.get("error").is_some_and(|v| !v.is_null()),
            finish_reason = choice["finish_reason"].as_str().unwrap_or("absent"),
            spoke,
            extra = extra.copied().unwrap_or("none"),
            "cognition reply did not carry exactly one proposal tool call"
        );
        return Err(LlmError::Malformed);
    }
    let calls = message["tool_calls"]
        .as_array()
        .filter(|c| c.len() == 1)
        .ok_or(LlmError::Malformed)?;
    let call = &calls[0];
    let identifier = call["id"].as_str().ok_or(LlmError::Malformed)?;
    if identifier.is_empty()
        || identifier.len() > 128
        || !identifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        || call["type"] != "function"
        || call["function"]["name"] != "propose_information"
    {
        return Err(LlmError::Malformed);
    }
    let arguments = call["function"]["arguments"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16 * 1024)
        .ok_or(LlmError::Malformed)?;
    // Keep the original arguments. The runtime still validates the semantic
    // intent and privacy join, then durably decides whether it can dispatch.
    let _: super::analysis::Proposal =
        serde_json::from_str(arguments).map_err(|_| LlmError::Malformed)?;
    Ok(ChatResponse {
        tool_call: Some(ToolCall {
            name: "propose_information".into(),
            arguments: arguments.into(),
        }),
        ..Default::default()
    })
}
