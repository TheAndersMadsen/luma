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

/// Providers regularly return two shapes the schema forbids: a lookup nested
/// inside `intent`, or an answer together with a lookup. Both are made
/// unambiguous before the strict proposal parse: a nested lookup is lifted to
/// its own branch, and when the model both answered and asked to look
/// something up, the lookup stands and the unsourced answer is dropped, so
/// "find cafés" becomes a place card and a fact request a sourced card under
/// the origin's own permission. Every kept field is the model's own; nothing
/// is invented.
fn normalize_arguments(arguments: &str) -> Option<String> {
    let mut value: Value = serde_json::from_str(arguments).ok()?;
    let object = value.as_object_mut()?;
    let nested = object.get("intent").and_then(|intent| {
        let kind = intent.get("kind")?.as_str()?;
        let branch = match kind {
            "web_lookup" => json!({"query": intent.get("query")?.clone()}),
            "place_lookup" => {
                let mut branch = json!({"query": intent.get("query")?.clone()});
                if let Some(then) = intent.get("then") {
                    branch["then"] = then.clone();
                }
                branch
            }
            "choice_list" => json!({
                "title": intent.get("title")?.clone(),
                "items": intent.get("items")?.clone(),
            }),
            "device_action" => json!({
                "operation": intent.get("operation")?.clone(),
                "reference": intent.get("reference")?.clone(),
            }),
            _ => return None,
        };
        Some((kind.to_owned(), branch))
    });
    let mut normalized = false;
    if let Some((kind, branch)) = nested {
        object.remove("intent");
        if !object.contains_key(&kind) {
            object.insert(kind, branch);
        }
        normalized = true;
    }
    // Dropping a branch is only safe when nothing was going to happen. A
    // device action combined with any other branch is refused here, before
    // any runtime work: silently discarding the answer and keeping the effect
    // is the wrong direction to fail.
    if object.contains_key("device_action")
        && [
            "intent",
            "analysis",
            "web_lookup",
            "place_lookup",
            "choice_list",
        ]
        .iter()
        .any(|branch| object.contains_key(*branch))
    {
        tracing::warn!("cognition combined a device action with another branch");
        return None;
    }
    if ["analysis", "web_lookup", "place_lookup", "choice_list"]
        .iter()
        .any(|branch| object.contains_key(*branch))
        && object.remove("intent").is_some()
    {
        normalized = true;
    }
    if normalized {
        tracing::info!("cognition proposal normalized to one branch");
    }
    Some(value.to_string())
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
        .ok_or_else(|| {
            tracing::warn!(
                calls = message["tool_calls"].as_array().map_or(0, Vec::len),
                "cognition reply did not carry exactly one tool call"
            );
            LlmError::Malformed
        })?;
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
    let arguments = normalize_arguments(arguments).ok_or(LlmError::Malformed)?;
    let arguments = arguments.as_str();
    // Keep the model's own arguments. The runtime still validates the semantic
    // intent and privacy join, then durably decides whether it can dispatch.
    let _: super::analysis::Proposal = serde_json::from_str(arguments).map_err(|error| {
        // The serde message names fields and variants, never the text itself.
        tracing::warn!(
            bytes = arguments.len(),
            reason = %error,
            "cognition proposal did not match the schema"
        );
        LlmError::Malformed
    })?;
    Ok(ChatResponse {
        tool_call: Some(ToolCall {
            name: "propose_information".into(),
            arguments: arguments.into(),
        }),
        ..Default::default()
    })
}
