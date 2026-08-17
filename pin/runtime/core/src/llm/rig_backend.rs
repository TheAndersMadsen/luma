use std::time::Instant;

use std::sync::Arc;

use base64::Engine as _;
use reqwest::Client as HttpClient;
use rig::agent::{Agent, AgentBuilder, HookAction, PromptHook};
use rig::client::CompletionClient;
use rig::completion::message::{AssistantContent, ImageMediaType, Message, UserContent};
use rig::completion::CompletionModel;
use rig::completion::Prompt;
use rig::completion::{CompletionResponse, PromptError};
use rig::tool::Tool;
use rig::OneOrMany;
use tracing::{error, warn};

use crate::config::ResolvedConfig;
use crate::llm::tool_step::{
    ToolStepCall, ToolStepRequest, ToolStepResult, MAX_TOOL_STEP_ARG_BYTES,
};
use crate::llm::ChatResult;
use crate::tier_a::operational_markers;

use super::backend::ToolStepFuture;

use super::backend::{LlmBackend, LlmFuture};
use super::error::friendly_error_message;
use super::memory::MemoryService;
use super::prompt::PromptBuilder;
use super::request::{LlmChatRequest, LlmResponseMode};
use super::request_log::LlmRequestLogger;
use super::tools::registry::LlmToolContext;
use super::tools::understand_scene::UnderstandSceneTool;

/// Marker for a termination due to device vision request
const DEFERRED_VISION_SENTINEL: &str = "__HUMANE_DEFERRED_VISION__";

/// Rig hook to prevent execution of the `understand_scene` tool. The returned termination value
/// is used to trigger a DeferredVision response to the client
#[derive(Clone)]
struct DeferredVisionHook;

impl<M> PromptHook<M> for DeferredVisionHook
where
    M: CompletionModel,
{
    async fn on_completion_response(
        &self,
        _prompt: &Message,
        response: &CompletionResponse<M::Response>,
    ) -> HookAction {
        let selected_vision = response.choice.iter().any(|content| {
            matches!(
                content,
                AssistantContent::ToolCall(call)
                    if call.function.name == UnderstandSceneTool::NAME
            )
        });

        if selected_vision {
            HookAction::terminate(DEFERRED_VISION_SENTINEL)
        } else {
            HookAction::cont()
        }
    }
}

/// Shared LLM backend for providers
pub struct RigBackend<M>
where
    M: CompletionModel + 'static,
    (): PromptHook<M> + 'static,
{
    provider_label: &'static str,
    agent: Agent<M>,
    /// Tool-free agent used for the structured response modes (the bounded
    /// agentic JSON-operation loop and the progress cue). These modes own their
    /// own control flow and parse the raw JSON the model returns, so the model
    /// must emit exactly one JSON object rather than invoking a helper tool.
    structured_agent: Agent<M>,
    /// Tool-free agent bound to the resolved progress-cue model. Present only
    /// when an explicit cue model differs from the main model, so a configured
    /// fast cue model is honored instead of silently running on the main model.
    cue_agent: Option<Agent<M>>,
    /// The resolved cue model name `cue_agent` is bound to.
    cue_model: String,
    /// Tool-free agent bound to the configured vision-capable model. Present
    /// only when `llm.vision_model` is set and differs from the main model.
    /// Every image-bearing request routes here so the multimodal image part
    /// reaches a model that accepts it, and image content can never enter the
    /// side-effect-capable tool loop.
    vision_agent: Option<Agent<M>>,
    /// The configured vision model name `vision_agent` is bound to.
    vision_model: Option<String>,
    request_logger: LlmRequestLogger,
    max_tool_turns: usize,
    tool_concurrency: usize,
}

impl<M> RigBackend<M>
where
    M: CompletionModel + 'static,
    (): PromptHook<M> + 'static,
{
    pub async fn from_client<C, F>(
        provider_label: &'static str,
        client: C,
        request_logger: LlmRequestLogger,
        config: &ResolvedConfig,
        http_client: HttpClient,
        memory: Option<MemoryService>,
        customize_builder: F,
    ) -> Result<Arc<dyn LlmBackend>, Box<dyn std::error::Error + Send + Sync>>
    where
        C: CompletionClient<CompletionModel = M>,
        F: FnOnce(AgentBuilder<M>) -> AgentBuilder<M>,
    {
        let llm_config = &config.config.llm;
        let builder = customize_builder(client.agent(&llm_config.model));

        let tool_resources = if llm_config.tools.enabled {
            let tool_context = LlmToolContext::new(http_client, config, memory);
            tool_context
                .build_tool_resources(llm_config)
                .await
                .map_err(|err| -> Box<dyn std::error::Error + Send + Sync> {
                    std::io::Error::other(err).into()
                })?
        } else {
            None
        };

        let agent = match tool_resources {
            Some(resources) => resources.apply(builder).build(),
            None => builder.build(),
        };

        // Same model, no tools: the structured modes (tool steps, progress
        // cue) must return exactly one completion; the loop owns control flow.
        let structured_agent = client.agent(&llm_config.model).build();

        // Honor an explicit progress-cue model on this provider. The resolved
        // cue equals the main model unless the operator configured a distinct
        // fast model, so this stays `None` in the default configuration.
        let cue_model = llm_config.resolve_progress_cue_model().to_string();
        let cue_agent = (cue_model != llm_config.model).then(|| client.agent(&cue_model).build());

        // Honor an explicit vision model for image-bearing requests. Tool-free
        // and single-turn by construction; when the operator's vision model is
        // the main model this stays `None` and images keep the ordinary route.
        let vision_model = llm_config.resolve_vision_model().map(str::to_string);
        let vision_agent = vision_model
            .as_deref()
            .filter(|model| *model != llm_config.model)
            .map(|model| client.agent(model).build());

        Ok(Arc::new(Self {
            provider_label,
            agent,
            structured_agent,
            cue_agent,
            cue_model,
            vision_agent,
            vision_model,
            request_logger,
            max_tool_turns: llm_config.tools.max_tool_turns,
            tool_concurrency: llm_config.tools.tool_concurrency,
        }))
    }
}

#[allow(clippy::too_many_arguments)]
async fn log_chat_request(
    request_logger: &LlmRequestLogger,
    response_mode: LlmResponseMode,
    provider_label: &str,
    run_id: &str,
    history: &[Message],
    utterance: &str,
    result: &Result<ChatResult, String>,
    latency_ms: u128,
) {
    if matches!(response_mode, LlmResponseMode::ProgressCue) {
        return;
    }

    request_logger
        .log_chat(
            provider_label,
            run_id,
            history,
            utterance,
            match result {
                Ok(ChatResult::Text(text)) => Some(text.as_str()),
                Ok(ChatResult::DeferredVision) => None,
                Err(_) => None,
            },
            result.clone().err().as_deref(),
            latency_ms,
        )
        .await;
}

impl<M> LlmBackend for RigBackend<M>
where
    M: CompletionModel + 'static,
    (): PromptHook<M> + 'static,
{
    fn chat<'a>(&'a self, request: LlmChatRequest) -> LlmFuture<'a> {
        Box::pin(async move {
            let response_mode = request.response_mode;
            let utterance = request.utterance.clone();
            let run_id = request.template_context.run_id.clone();
            let history = PromptBuilder::build_chat_history(&request);
            let started = Instant::now();

            let content = if let Some(image_bytes) = &request.image {
                // Declare the actual capture format; AnalyzeImage accepts both
                // JPEG and PNG and some providers validate the data URI type.
                let media_type =
                    if image_bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
                        ImageMediaType::PNG
                    } else {
                        ImageMediaType::JPEG
                    };
                OneOrMany::many(vec![
                    UserContent::text(utterance.clone()),
                    UserContent::image_base64(
                        base64::engine::general_purpose::STANDARD.encode(image_bytes),
                        Some(media_type),
                        None,
                    ),
                ])
                .expect("non-empty content vec")
            } else {
                OneOrMany::one(UserContent::text(utterance.clone()))
            };

            let user_message = Message::User { content };

            // Image-bearing requests run tool-free on the configured vision
            // agent (when one exists) so the multimodal part reaches a model
            // that accepts it. This also keeps image-derived content out of
            // the side-effect-capable tool loop by construction.
            let vision_route = request
                .image
                .is_some()
                .then_some(self.vision_agent.as_ref())
                .flatten();

            let raw_result = if let Some(vision) = vision_route {
                vision
                    .prompt(user_message)
                    .with_history(history.clone())
                    .max_turns(1)
                    .await
            } else if matches!(response_mode, LlmResponseMode::VoiceAnswer) {
                self.agent
                    .prompt(user_message)
                    .with_history(history.clone())
                    .max_turns(self.max_tool_turns)
                    .with_tool_concurrency(self.tool_concurrency.max(1))
                    .with_hook(DeferredVisionHook)
                    .await
            } else {
                // Structured modes (bounded agentic JSON loop, progress cue)
                // require exactly one completion with no tools: the runtime and
                // the cue path own their control flow and parse the raw JSON the
                // model returns. Exposing helper tools here would let the model
                // call a tool instead of emitting the required JSON operation.
                let structured = match request.model_override.as_deref() {
                    Some(requested) if requested == self.cue_model => {
                        self.cue_agent.as_ref().unwrap_or(&self.structured_agent)
                    }
                    // The configured vision model with no distinct vision
                    // agent means it equals the main model; the structured
                    // agent is already bound to it.
                    Some(requested) if Some(requested) == self.vision_model.as_deref() => {
                        self.vision_agent.as_ref().unwrap_or(&self.structured_agent)
                    }
                    Some(requested) => {
                        warn!(
                            provider = self.provider_label,
                            requested,
                            "model_override does not match a configured model; using the main model"
                        );
                        &self.structured_agent
                    }
                    None => &self.structured_agent,
                };
                structured
                    .prompt(user_message)
                    .with_history(history.clone())
                    .max_turns(1)
                    .await
            };
            let latency_ms = started.elapsed().as_millis();

            let result = match raw_result {
                Ok(text) => Ok(ChatResult::Text(text)),
                Err(PromptError::PromptCancelled { reason, .. })
                    if reason == DEFERRED_VISION_SENTINEL =>
                {
                    Ok(ChatResult::DeferredVision)
                }
                Err(e) => {
                    error!(provider = self.provider_label, error = %e, "LLM chat failed");
                    Err(friendly_error_message(&e))
                }
            };

            log_chat_request(
                &self.request_logger,
                response_mode,
                self.provider_label,
                &run_id,
                &history,
                &utterance,
                &result,
                latency_ms,
            )
            .await;

            result
        })
    }

    fn tool_step<'a>(&'a self, request: ToolStepRequest) -> ToolStepFuture<'a> {
        Box::pin(async move {
            // One raw completion with a native tools array. The structured
            // agent's model is reused so the chat-turn loop shares the exact
            // provider client/model the operator configured; rig converts the
            // tool definitions to each provider's native function-calling
            // shape. No rig-internal agent loop runs here — the chat-turn loop
            // owns execution, observation feedback, and iteration budgets.
            let mut messages = request.messages;
            let Some(prompt) = messages.pop() else {
                return Err("tool step requires at least one message".to_string());
            };
            let tools: Vec<rig::completion::ToolDefinition> = request
                .tools
                .iter()
                .map(|tool| rig::completion::ToolDefinition {
                    name: tool.name.to_string(),
                    description: tool.description.to_string(),
                    parameters: tool.parameters.clone(),
                })
                .collect();

            let model = self.structured_agent.model.clone();
            let completion_request =
                rig::completion::CompletionRequestBuilder::new((*model).clone(), prompt)
                    .preamble(request.system_prompt)
                    .messages(messages)
                    .tools(tools)
                    .build();

            let started = Instant::now();
            let response =
                tokio::time::timeout(request.timeout, model.completion(completion_request))
                    .await
                    .map_err(|_| "tool step timed out".to_string())?
                    .map_err(|error| friendly_error_message(&error.to_string()))?;
            let latency_ms = started.elapsed().as_millis();

            let mut calls = Vec::new();
            let mut text_parts: Vec<String> = Vec::new();
            for content in response.choice.iter() {
                match content {
                    AssistantContent::ToolCall(call) => {
                        let arguments = call.function.arguments.clone();
                        let encoded_len = serde_json::to_vec(&arguments)
                            .map(|bytes| bytes.len())
                            .unwrap_or(usize::MAX);
                        if encoded_len > MAX_TOOL_STEP_ARG_BYTES {
                            return Err(format!(
                                "tool step produced an oversized tool argument payload ({encoded_len} bytes)"
                            ));
                        }
                        let call_id = call
                            .call_id
                            .clone()
                            .filter(|value| !value.trim().is_empty())
                            .unwrap_or_else(|| call.id.clone());
                        let call_id = if call_id.trim().is_empty() {
                            format!("call-{}", calls.len() + 1)
                        } else {
                            call_id
                        };
                        calls.push(ToolStepCall {
                            call_id,
                            name: call.function.name.clone(),
                            arguments,
                        });
                    }
                    AssistantContent::Text(text) => text_parts.push(text.text.clone()),
                    _ => {}
                }
            }

            tracing::info!(
                provider = self.provider_label,
                correlation = %request.correlation,
                latency_ms,
                tool_calls = calls.len(),
                has_text = !text_parts.is_empty(),
                "{}",
                operational_markers::STEP_COMPLETED
            );

            if calls.is_empty() {
                let text = text_parts.join("\n").trim().to_string();
                if text.is_empty() {
                    return Err("tool step returned an empty response".to_string());
                }
                Ok(ToolStepResult::Final(text))
            } else {
                Ok(ToolStepResult::ToolCalls(calls))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::Value;

    use super::*;

    async fn log_records(log_dir: &Path) -> Vec<Value> {
        let mut entries = match tokio::fs::read_dir(log_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(error) => panic!("failed to read request log directory: {error}"),
        };
        let mut records = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            let contents = tokio::fs::read_to_string(entry.path()).await.unwrap();
            records.extend(
                contents
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(|line| serde_json::from_str(line).unwrap()),
            );
        }
        records
    }

    #[tokio::test]
    async fn progress_cue_is_not_logged_but_voice_answer_is() {
        let temp_dir = tempfile::tempdir().unwrap();
        let log_dir = temp_dir.path().join("request-logs");
        let logger = LlmRequestLogger::new(log_dir.clone());
        let cue_result = Ok(ChatResult::Text("synthetic progress cue".to_string()));

        log_chat_request(
            &logger,
            LlmResponseMode::ProgressCue,
            "test-provider",
            "progress-cue-run",
            &[],
            "synthetic cue prompt",
            &cue_result,
            1,
        )
        .await;

        assert!(log_records(&log_dir).await.is_empty());

        let voice_result = Ok(ChatResult::Text("synthetic voice response".to_string()));

        log_chat_request(
            &logger,
            LlmResponseMode::VoiceAnswer,
            "test-provider",
            "voice-answer-run",
            &[],
            "synthetic voice prompt",
            &voice_result,
            1,
        )
        .await;

        let records = log_records(&log_dir).await;
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record["provider"], "test-provider");
        assert_eq!(record["kind"], "chat");
        assert_eq!(record["run_id"], "voice-answer-run");
        assert_eq!(record["request"]["messages"][0]["role"], "user");
        assert_eq!(record["request"]["messages"][0]["characters"], 22);
        assert_eq!(record["response"]["characters"], 24);
        let encoded = serde_json::to_string(record).unwrap();
        assert!(!encoded.contains("synthetic voice prompt"));
        assert!(!encoded.contains("synthetic voice response"));
    }
}
