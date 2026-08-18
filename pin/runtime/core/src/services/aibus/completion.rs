use std::sync::Arc;

use prost::Message as _;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use super::capabilities::food::{FoodHandler, FoodRuntimeGate};
use super::envelope::unwrap_plaintext_data;
use super::tools::stock_agent;
use crate::config::ResolvedConfig;
use crate::llm::memory::MemoryService;
use crate::llm::ChatResult;
use crate::llm::{LlmAgent, LlmChatRequest, PromptTemplateContext, PromptTemplates};
use crate::proto::aibus::*;
use crate::proto::common::encryption::EncryptedData;
use crate::tier_a::proto_kids;

pub struct CompletionHandler {
    agent: Arc<LlmAgent>,
    config: Arc<ResolvedConfig>,
    // CompletionRequest and ChatCompletionRequest do not contain an
    // authenticated device lock state. Retain the constructor dependency for
    // API compatibility, but never attach personal memory to these Unknown-
    // state RPCs.
    _memory: Option<MemoryService>,
    food_runtime_gate: FoodRuntimeGate,
}

impl CompletionHandler {
    pub fn new(
        agent: Arc<LlmAgent>,
        config: Arc<ResolvedConfig>,
        memory: Option<MemoryService>,
    ) -> Self {
        Self {
            agent,
            config,
            _memory: memory,
            food_runtime_gate: FoodRuntimeGate::default(),
        }
    }

    pub(crate) fn with_food_runtime_gate(mut self, gate: FoodRuntimeGate) -> Self {
        self.food_runtime_gate = gate;
        self
    }

    pub async fn encrypted_chat_completion(
        &self,
        request: Request<EncryptedChatCompletionRequest>,
    ) -> Result<Response<EncryptedChatCompletionResponse>, Status> {
        let req = request.into_inner();
        let request_bytes = unwrap_plaintext_data(&req.request)?;
        let chat_req = ChatCompletionRequest::decode(request_bytes)
            .map_err(|e| Status::invalid_argument(format!("bad ChatCompletionRequest: {e}")))?;
        let food_agent_request = request_offers_food_tools(&chat_req);
        let food_permit = if food_agent_request {
            match self.food_runtime_gate.permit() {
                Some(permit) => Some(permit),
                None => return Ok(disabled_food_chat_response()),
            }
        } else {
            None
        };

        if let Some(tool_call) = stock_agent::plan_tool_call(&chat_req) {
            let tool_name = tool_call
                .function
                .as_ref()
                .map(|function| function.name.as_str())
                .unwrap_or_default();
            if is_food_tool_name(tool_name)
                && food_permit
                    .is_none_or(|permit| !self.food_runtime_gate.permit_is_current(permit))
            {
                return Ok(disabled_food_chat_response());
            }
            info!(
                tool = tool_name,
                ">>> EncryptedChatCompletion stock tool call"
            );

            let chat_response = ChatCompletionResponse {
                choices: vec![Choice {
                    message: Some(ChatCompletionMessage {
                        role: "assistant".into(),
                        content: String::new(),
                        tool_calls: vec![tool_call],
                        name: String::new(),
                        tool_call_id: String::new(),
                    }),
                    stop_reason: "tool_calls".into(),
                }],
                usage: Some(ChatCompletionUsage::default()),
                error: None,
            };

            return Ok(Response::new(EncryptedChatCompletionResponse {
                response: Some(EncryptedData::new(
                    proto_kids::CHAT_COMPLETION_RESPONSE,
                    chat_response.encode_to_vec(),
                )),
            }));
        }

        let prompt = chat_req
            .messages
            .iter()
            .filter(|m| !m.content.trim().is_empty())
            .map(|m| format!("{}: {}", m.role, m.content))
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = if prompt.is_empty() {
            "Hello".to_string()
        } else {
            prompt
        };

        info!(
            messages = chat_req.messages.len(),
            ">>> EncryptedChatCompletion"
        );
        // This schema has no authenticated lock-state field. Treat it as
        // Unknown and fail closed for automatic personal-memory retrieval.
        let memory_context = completion_memory_context();
        let chat = self.agent.chat(
            LlmChatRequest::new(
                prompt,
                Vec::new(),
                PromptTemplates {
                    system_prompt: self.config.config.server.resolved_system_prompt(),
                    status_prompt: self.config.config.server.resolved_status_prompt(),
                },
                PromptTemplateContext::new(
                    "encrypted-chat-completion",
                    &self.config,
                    chrono::Local::now(),
                ),
                memory_context,
            )
            .with_tool_free_text_output(),
        );
        let result = match food_permit {
            Some(permit) => match self.food_runtime_gate.run_while_enabled(permit, chat).await {
                Some(result) => result,
                None => return Ok(disabled_food_chat_response()),
            },
            None => chat.await,
        };
        let response_text = match result {
            Ok(ChatResult::Text(text)) => text,
            Ok(ChatResult::DeferredVision) => {
                warn!("EncryptedChatCompletion triggered vision tool (unexpected)");
                "I can't capture an image in this context.".to_string()
            }
            Err(error) => {
                warn!(error = %error, "EncryptedChatCompletion LLM failed");
                error
            }
        };
        if food_permit.is_some_and(|permit| !self.food_runtime_gate.permit_is_current(permit)) {
            return Ok(disabled_food_chat_response());
        }

        let chat_response = ChatCompletionResponse {
            choices: vec![Choice {
                message: Some(ChatCompletionMessage {
                    role: "assistant".into(),
                    content: response_text,
                    tool_calls: vec![],
                    name: String::new(),
                    tool_call_id: String::new(),
                }),
                stop_reason: "stop".into(),
            }],
            usage: Some(ChatCompletionUsage::default()),
            error: None,
        };

        Ok(Response::new(EncryptedChatCompletionResponse {
            response: Some(EncryptedData::new(
                proto_kids::CHAT_COMPLETION_RESPONSE,
                chat_response.encode_to_vec(),
            )),
        }))
    }

    pub async fn encrypted_completion(
        &self,
        request: Request<EncryptedCompletionRequest>,
    ) -> Result<Response<EncryptedCompletionResponse>, Status> {
        let req = request.into_inner();
        let request_bytes = unwrap_plaintext_data(&req.request)?;
        let completion_req = CompletionRequest::decode(request_bytes)
            .map_err(|e| Status::invalid_argument(format!("bad CompletionRequest: {e}")))?;

        info!(
            prompt_len = completion_req.prompt.len(),
            ">>> EncryptedCompletion"
        );
        let prompt = completion_req.prompt;
        // This schema has no authenticated lock-state field. Treat it as
        // Unknown and fail closed for automatic personal-memory retrieval.
        let memory_context = completion_memory_context();
        let response_text = match self
            .agent
            .chat(LlmChatRequest::new(
                prompt,
                Vec::new(),
                PromptTemplates {
                    system_prompt: self.config.config.server.resolved_system_prompt(),
                    status_prompt: self.config.config.server.resolved_status_prompt(),
                },
                PromptTemplateContext::new(
                    "encrypted-completion",
                    &self.config,
                    chrono::Local::now(),
                ),
                memory_context,
            ))
            .await
        {
            Ok(ChatResult::Text(text)) => text,
            Ok(ChatResult::DeferredVision) => {
                warn!("EncryptedCompletion triggered vision tool (unexpected)");
                "I can't capture an image in this context.".to_string()
            }
            Err(error) => {
                warn!(error = %error, "EncryptedCompletion LLM failed");
                error
            }
        };

        let completion_response = CompletionResponse {
            choices: vec![CompletionChoice {
                text: response_text,
                index: 0,
                finish_reason: "stop".into(),
            }],
            usage: Some(CompletionUsage::default()),
            error: None,
        };

        Ok(Response::new(EncryptedCompletionResponse {
            response: Some(EncryptedData::new(
                proto_kids::COMPLETION_RESPONSE,
                completion_response.encode_to_vec(),
            )),
        }))
    }
}

fn completion_memory_context() -> Option<String> {
    None
}

const FOOD_TOOL_NAMES: [&str; 3] = ["RetrieveFoodInfo", "TrackFoodConsumption", "GetFoodLog"];

fn is_food_tool_name(name: &str) -> bool {
    FOOD_TOOL_NAMES.contains(&name)
}

fn request_offers_food_tools(request: &ChatCompletionRequest) -> bool {
    request.tools.iter().any(|tool| {
        matches!(
            tool.content.as_ref(),
            Some(tool::Content::Function(function)) if is_food_tool_name(&function.name)
        )
    }) || request
        .tool_set_version
        .as_ref()
        .is_some_and(|version| version.set_name == "food" && version.version == 4)
}

fn disabled_food_chat_response() -> Response<EncryptedChatCompletionResponse> {
    let response = ChatCompletionResponse {
        choices: vec![Choice {
            message: Some(ChatCompletionMessage {
                role: "assistant".into(),
                content: FoodHandler::runtime_unavailable_message().into(),
                tool_calls: Vec::new(),
                name: String::new(),
                tool_call_id: String::new(),
            }),
            stop_reason: "stop".into(),
        }],
        usage: Some(ChatCompletionUsage::default()),
        error: None,
    };
    Response::new(EncryptedChatCompletionResponse {
        response: Some(EncryptedData::new(
            proto_kids::CHAT_COMPLETION_RESPONSE,
            response.encode_to_vec(),
        )),
    })
}

#[cfg(test)]
mod food_gate_tests {
    use super::*;

    fn food_request(prompt: &str) -> ChatCompletionRequest {
        ChatCompletionRequest {
            messages: vec![ChatCompletionMessage {
                role: "user".into(),
                content: prompt.into(),
                ..Default::default()
            }],
            tag: "agent".into(),
            tool_set_version: Some(ToolSetVersion {
                set_name: "food".into(),
                version: 4,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn food_v4_tool_emission_requires_a_current_runtime_permit() {
        let request = food_request("I ate two eggs");
        assert!(request_offers_food_tools(&request));
        let tool_call = stock_agent::plan_tool_call(&request).unwrap();
        assert_eq!(
            tool_call.function.as_ref().unwrap().name,
            "TrackFoodConsumption"
        );

        let gate = FoodRuntimeGate::default();
        assert!(gate.permit().is_none());
        gate.enable_for_test();
        let permit = gate.permit().unwrap();
        assert!(gate.permit_is_current(permit));

        gate.begin_mutation().publish(Some(false));
        assert!(!gate.permit_is_current(permit));
        assert!(gate.permit().is_none());
    }

    #[test]
    fn only_exact_food_tools_and_food_v4_activate_the_completion_gate() {
        let explicit = ChatCompletionRequest {
            tools: vec![Tool {
                content: Some(tool::Content::Function(Function {
                    name: "RetrieveFoodInfo".into(),
                    ..Default::default()
                })),
            }],
            ..Default::default()
        };
        assert!(request_offers_food_tools(&explicit));

        let explicit_non_food_plus_food_v4 = ChatCompletionRequest {
            tools: vec![Tool {
                content: Some(tool::Content::Function(Function {
                    name: "UnrelatedTool".into(),
                    ..Default::default()
                })),
            }],
            tool_set_version: Some(ToolSetVersion {
                set_name: "food".into(),
                version: 4,
            }),
            ..Default::default()
        };
        assert!(request_offers_food_tools(&explicit_non_food_plus_food_v4));

        for request in [
            ChatCompletionRequest::default(),
            ChatCompletionRequest {
                tool_set_version: Some(ToolSetVersion {
                    set_name: "food".into(),
                    version: 3,
                }),
                ..Default::default()
            },
            ChatCompletionRequest {
                tool_set_version: Some(ToolSetVersion {
                    set_name: "timer".into(),
                    version: 1,
                }),
                ..Default::default()
            },
        ] {
            assert!(!request_offers_food_tools(&request));
        }
    }

    #[test]
    fn completion_rpcs_never_auto_attach_memory_without_authenticated_lock_state() {
        assert_eq!(completion_memory_context(), None);
    }
}
