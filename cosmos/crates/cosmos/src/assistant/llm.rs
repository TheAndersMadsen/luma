//! Pluggable chat-model abstraction for the assistant engine.
//!
//! cosmos's serverside drives an OpenAI-shaped LLM whose exact model + prompts are
//! Humane's (server-only, not reproduced here). This layer lets the clone's ReAct
//! engine drive **our own** model with **our own** prompts: a [`ChatModel`] trait,
//! a deterministic [`MockChatModel`] (so the engine is fully testable + runnable
//! with no API key), and an OpenAI-compatible HTTP driver ([`OpenAiChatModel`]).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Default OpenRouter model for the clone's low-latency wearable assistant.
/// OpenRouter model identifiers include the provider namespace.
pub const DEFAULT_LLM_MODEL: &str = "openai/gpt-5.6-luna";

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("llm transport: {0}")]
    Transport(String),
    /// The provider answered, and refused. `429` is a rate limit, `401`/`403` an
    /// expired or wrong `COSMOS_LLM_API_KEY`, `5xx` the provider itself.
    ///
    /// Distinct from [`LlmError::Transport`] because the engine spoke the
    /// device's timeout string for all of these and `record_turn` then labelled
    /// the turn `deadline` — so a dead API key raised the latency-and-budget
    /// alarm and the operator went looking at deadlines.
    #[error("llm refused with HTTP {0}")]
    Status(u16),
    #[error("llm response was empty / malformed")]
    Malformed,
    #[error("mock script exhausted")]
    ScriptExhausted,
}

/// A message in the running chat transcript handed to the model. Tool results are
/// folded back in as `User` observation messages (portable across any OpenAI-
/// compatible endpoint — no tool-call-id pairing required).
#[derive(Clone, Debug)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

impl ChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: text.into(),
        }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: text.into(),
        }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: text.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
}

/// Coerce model-supplied tool arguments into a JSON **object**.
///
/// The device parses `SynapseActionContent.input` with
/// `JsonParser.parseString(input).getAsJsonObject()` — unconditionally, before it
/// even looks at the slot list (`Schema.resolve`). Gson turns `""` into
/// `JsonNull`, and `JsonNull.getAsJsonObject()` throws; `JsonResolver` catches it
/// and the pin bounces "Unrecognized function name and/or arguments". Since the
/// server then re-plans and emits the same action, that is an infinite bounce
/// until the action limit trips and the wearer hears the runaway apology — for a
/// request the device could have executed immediately.
///
/// OpenAI-compatible endpoints routinely emit `""` for a function with no
/// parameters, and many recovered device actions take none (`AmIOnline`,
/// `EndCall`, `GetBatteryLevel`, `LockDevice`, …). `{}` is the device's own
/// canonical zero-argument form — it is what `Errors.unsubscribed()` and
/// `ConfirmationInterpreter` put on the wire.
pub fn normalize_arguments(arguments: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(arguments) {
        Ok(serde_json::Value::Object(_)) => arguments.to_owned(),
        _ => "{}".to_owned(),
    }
}

/// A tool call the model emitted: the tool name + JSON-object arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCall {
    pub name: String,
    pub arguments: String,
}

/// A tool the model may call (mirrors `SynapseActionDefinition{name, parameter_definition, description}`).
#[derive(Clone, Debug)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON-schema object describing the tool's parameters.
    pub parameters: serde_json::Value,
}

/// One model turn: either a tool call (loop) or final content (finish) — mirrors
/// cosmos's loop-vs-finish decision (tool_call present => another action node).
#[derive(Clone, Debug, Default)]
pub struct ChatResponse {
    pub content: Option<String>,
    /// The model's rationale for this step, surfaced as
    /// `SynapseActionContent.thought` on the emitted action turn.
    pub thought: String,
    pub tool_call: Option<ToolCall>,
    /// Further tool calls the model asked for in the SAME step.
    ///
    /// Every recovered stock tool set ships a parallel-invocation wrapper telling
    /// the model to batch independent calls. We were taking `.next()` and
    /// dropping the rest, so a two-lookup request silently lost one call and then
    /// answered as though it had run — and cost two model round trips instead of
    /// one. `tool_call` stays the primary so single-call callers are unchanged.
    pub extra_tool_calls: Vec<ToolCall>,
}

/// Honor an explicit wearer request to search even when the configured model
/// returns an unsupported direct answer.
///
/// The ordinary choice remains the model's: this guard applies only when the
/// wearer literally asked for web search, `web_search` is in the resolved tool
/// set, the model emitted no tool call at all, and this turn has not already
/// searched. The last condition is what lets the model turn the observation
/// into a final spoken answer instead of being forced into a search loop.
fn enforce_explicit_web_search(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    if response.tool_call.is_some()
        || !response.extra_tool_calls.is_empty()
        || !tools.iter().any(|tool| tool.name == "web_search")
        || messages.iter().any(|message| {
            message.role == Role::User && message.content.starts_with("[Called web_search(")
        })
    {
        return response;
    }

    let Some(utterance) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User && !message.content.starts_with("[Called "))
        .map(|message| message.content.trim())
        .filter(|utterance| !utterance.is_empty())
    else {
        return response;
    };
    let normalized = utterance.to_lowercase();
    if ![
        "web_search",
        "web search",
        "search the web",
        "browse the web",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
    {
        return response;
    }

    tracing::info!("explicit web-search request corrected after direct model answer");
    response.content = None;
    response.tool_call = Some(ToolCall {
        name: "web_search".to_owned(),
        arguments: serde_json::json!({ "query": utterance }).to_string(),
    });
    response
}

#[tonic::async_trait]
pub trait ChatModel: Send + Sync + 'static {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError>;
}

/// The live model selector backed by Cosmos's persisted integration settings.
/// A dashboard save takes effect on the next model step; no container or Pin
/// restart is required.
pub struct ConfiguredChatModel {
    demo_when_unconfigured: bool,
}

impl ConfiguredChatModel {
    pub fn assistant() -> Self {
        Self {
            demo_when_unconfigured: true,
        }
    }

    pub fn external_only() -> Self {
        Self {
            demo_when_unconfigured: false,
        }
    }
}

#[tonic::async_trait]
impl ChatModel for ConfiguredChatModel {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        let config = crate::integrations::active().snapshot().assistant;
        match config.provider {
            crate::integrations::AssistantProvider::OpenAiCompatible if config.configured() => {
                OpenAiChatModel::with_options(
                    config.base_url,
                    config.api_key.expect("configured API provider has a key"),
                    config.model,
                    (config.max_tokens != 0).then_some(config.max_tokens),
                    config.reasoning_effort,
                )
                .complete(messages, tools)
                .await
            }
            crate::integrations::AssistantProvider::CodexSubscription if config.configured() => {
                let prompt = codex_prompt(messages, tools)?;
                let response = super::codex_app_server::complete(
                    &config.model,
                    config.reasoning_effort.as_deref(),
                    config.fast_mode,
                    prompt,
                )
                .await
                .map_err(|error| LlmError::Transport(error.to_string()))?;
                let mut calls = response.tool_calls.into_iter().map(|call| ToolCall {
                    name: call.name,
                    arguments: match call.arguments {
                        serde_json::Value::Object(_) => call.arguments.to_string(),
                        _ => "{}".to_owned(),
                    },
                });
                let result = ChatResponse {
                    content: response.content,
                    thought: response.thought.unwrap_or_default(),
                    tool_call: calls.next(),
                    extra_tool_calls: calls.collect(),
                };
                Ok(enforce_explicit_web_search(messages, tools, result))
            }
            _ if self.demo_when_unconfigured => DemoChatModel.complete(messages, tools).await,
            _ => Err(LlmError::Transport(
                "assistant provider is not configured".to_owned(),
            )),
        }
    }
}

fn codex_prompt(messages: &[ChatMessage], tools: &[ToolDef]) -> Result<String, LlmError> {
    let messages = messages
        .iter()
        .map(|message| {
            serde_json::json!({
                "role": match message.role {
                    Role::System => "system",
                    Role::User => "user",
                    Role::Assistant => "assistant",
                },
                "content": message.content,
            })
        })
        .collect::<Vec<_>>();
    let tools = tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })
        })
        .collect::<Vec<_>>();
    let input = serde_json::to_string(&serde_json::json!({
        "messages": messages,
        "tools": tools,
    }))
    .map_err(|_| LlmError::Malformed)?;
    Ok(format!(
        "You are the model adapter for a wearable voice assistant. Do not use files, shell commands, or network tools. Read the supplied transcript and tool definitions. Either answer briefly in content or select the necessary tools. Return only the required structured output. Each tool call's arguments field must be a JSON object encoded as a string.\n\n{input}"
    ))
}

/// Deterministic model for tests + a keyless demo: returns a scripted sequence of
/// responses (tool calls then a final answer), one per `complete` call.
pub struct MockChatModel {
    script: Mutex<std::collections::VecDeque<ChatResponse>>,
}

impl MockChatModel {
    pub fn new(script: Vec<ChatResponse>) -> Self {
        Self {
            script: Mutex::new(script.into()),
        }
    }
    /// Convenience: call `tool` once, then answer with `final_answer`.
    pub fn tool_then_answer(tool: ToolCall, final_answer: &str) -> Self {
        Self::new(vec![
            ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(tool),
                extra_tool_calls: Vec::new(),
            },
            ChatResponse {
                content: Some(final_answer.to_owned()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ])
    }
}

#[tonic::async_trait]
impl ChatModel for MockChatModel {
    async fn complete(&self, _m: &[ChatMessage], _t: &[ToolDef]) -> Result<ChatResponse, LlmError> {
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .ok_or(LlmError::ScriptExhausted)
    }
}

/// Stateless keyless-demo model for deployments with no LLM configured.
///
/// It exercises the full action→observation→answer loop identically on *every*
/// request (unlike a draining script, which is correct only once), deciding
/// purely from the message history.
///
/// Two honesty properties matter here, because this model's output reaches a
/// wearer:
///   1. It searches the wearer's **actual** utterance, so the observation on the
///      wire answers a real question rather than a canned probe.
///   2. Its final answer reports only what is genuinely missing — the language
///      model — and never claims a backend is absent when that backend just
///      returned results. Misreporting the deployment's own state is the same
///      class of error as fabricating an answer.
///
/// It never synthesizes a fact: it cannot read the search results, and says so.
pub struct DemoChatModel;

impl DemoChatModel {
    /// The wearer's utterance — the last user message that is not a folded-back
    /// tool observation.
    fn utterance(messages: &[ChatMessage]) -> Option<&str> {
        messages
            .iter()
            .rev()
            .find(|m| m.role == Role::User && !m.content.starts_with("[Called "))
            .map(|m| m.content.as_str())
    }
}

#[tonic::async_trait]
impl ChatModel for DemoChatModel {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        // The engine folds each tool result back as a "[Called ...]" user message.
        let searched = messages
            .iter()
            .any(|m| m.role == Role::User && m.content.starts_with("[Called "));

        let query = Self::utterance(messages)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let can_search = !query.is_empty() && tools.iter().any(|t| t.name == "web_search");

        if !searched && can_search {
            return Ok(ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(ToolCall {
                    name: "web_search".to_owned(),
                    arguments: serde_json::json!({ "query": query }).to_string(),
                }),
                extra_tool_calls: Vec::new(),
            });
        }

        // Terminal. Keep operational detail out of the spoken answer. Tool
        // availability, provider choice, and deployment state belong in operator
        // health surfaces, not in the assistant persona heard by the wearer.
        let answer = "This request can't be completed right now.";
        Ok(ChatResponse {
            content: Some(answer.to_owned()),
            thought: String::new(),
            tool_call: None,
            extra_tool_calls: Vec::new(),
        })
    }
}

/// OpenAI-compatible chat-completions driver (works against OpenAI, OpenRouter,
/// DashScope-compatible, a local server, …). Endpoint + key + model are config.
pub struct OpenAiChatModel {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
    /// Per-step generation ceiling.
    ///
    /// Stock bounds every model step: the device's own agent loop sends
    /// `setMaxTokens(200)` on each `ChatCompletionRequest`
    /// (`TaoAgentV2.java:195`, `TaoAgent.java:103`). Sending no bound at all lets
    /// a verbose model spend the wearer's whole 25s turn deadline generating
    /// prose that will be cut off mid-sentence when spoken — model steps are the
    /// dominant cost in a turn, so this is a latency control as much as a style
    /// one. Configurable via `COSMOS_LLM_MAX_TOKENS`; `0` disables the bound.
    max_tokens: Option<u32>,
    /// How hard the model should think per step, for backends that expose it.
    ///
    /// Measured against the live backend: picking one tool out of ten costs
    /// 3.1-4.0s and arrives with ~400 characters of reasoning, while the tool it
    /// picks (`weather`) answers in 390ms. Most of a lookup turn is deliberation
    /// about which lookup to make.
    ///
    /// Unset by default, so the backend's own default stands and this changes
    /// nothing until an operator opts in with `COSMOS_LLM_REASONING_EFFORT`. It is
    /// a latency knob with a correctness cost — a model that thinks less picks
    /// the wrong tool more often — so it must be measured on BOTH axes before
    /// being turned on anywhere a wearer is listening.
    reasoning_effort: Option<String>,
}

/// Default per-step generation ceiling.
///
/// Stock's device-side agent uses 200. We allow more headroom because the
/// supervisor tier must also emit tool-call arguments (a contact list, a playlist,
/// a search query) inside the same budget, and truncating those produces an action
/// the device rejects rather than a merely shorter answer. Still small enough that
/// a runaway generation cannot eat the 25s turn deadline.
const DEFAULT_MAX_TOKENS: u32 = 512;

impl OpenAiChatModel {
    pub fn new(base_url: String, api_key: String, model: String) -> Self {
        Self::with_options(
            base_url,
            api_key,
            model,
            configured_max_tokens(),
            configured_reasoning_effort(),
        )
    }

    pub fn with_options(
        base_url: String,
        api_key: String,
        model: String,
        max_tokens: Option<u32>,
        reasoning_effort: Option<String>,
    ) -> Self {
        Self {
            client: crate::backends::http(),
            base_url,
            api_key,
            model,
            max_tokens,
            reasoning_effort,
        }
    }
}

/// Resolve the per-step reasoning effort. Unset (or blank) sends nothing at all,
/// which is what every deployment does until someone deliberately opts in.
fn configured_reasoning_effort() -> Option<String> {
    parse_reasoning_effort(crate::integrations::value("COSMOS_LLM_REASONING_EFFORT").as_deref())
}

/// Split out from the environment read so the policy is testable without mutating
/// process-global state (which races every other test in the binary).
///
/// An unrecognised value sends nothing rather than being forwarded verbatim: an
/// unknown effort string is rejected by the provider, and a 400 on every model
/// step would take the whole assistant down for a typo in an env var.
fn parse_reasoning_effort(raw: Option<&str>) -> Option<String> {
    const ALLOWED: &[&str] = &["minimal", "low", "medium", "high"];
    let value = raw.map(str::trim)?.to_ascii_lowercase();
    ALLOWED.contains(&value.as_str()).then_some(value)
}

/// Resolve the per-step ceiling. `COSMOS_LLM_MAX_TOKENS=0` disables it entirely
/// (for a model whose provider rejects the field); anything unparseable falls back
/// to the default rather than silently sending no bound.
fn configured_max_tokens() -> Option<u32> {
    parse_max_tokens(crate::integrations::value("COSMOS_LLM_MAX_TOKENS").as_deref())
}

/// Split out from the environment read so the policy is testable without mutating
/// process-global state (which races every other test in the binary).
fn parse_max_tokens(raw: Option<&str>) -> Option<u32> {
    match raw.map(str::trim) {
        None | Some("") => Some(DEFAULT_MAX_TOKENS),
        Some("0") => None,
        Some(value) => Some(value.parse::<u32>().unwrap_or(DEFAULT_MAX_TOKENS)),
    }
}

// --- wire types for the OpenAI chat-completions API ---
#[derive(Serialize)]
struct ChatReq<'a> {
    model: &'a str,
    messages: Vec<WireMsg>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<WireTool<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// OpenRouter/OpenAI shape: `{"reasoning": {"effort": "low"}}`. Omitted
    /// entirely when unset — a provider that does not know the field rejects the
    /// whole request rather than ignoring it.
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<WireReasoning<'a>>,
}
#[derive(Serialize)]
struct WireReasoning<'a> {
    effort: &'a str,
}
#[derive(Serialize)]
struct WireMsg {
    role: &'static str,
    content: Option<String>,
}
#[derive(Serialize)]
struct WireTool<'a> {
    r#type: &'static str,
    function: WireFn<'a>,
}
#[derive(Serialize)]
struct WireFn<'a> {
    name: &'a str,
    description: &'a str,
    parameters: &'a serde_json::Value,
}
#[derive(Deserialize)]
struct ChatResp {
    choices: Vec<Choice>,
}
#[derive(Deserialize)]
struct Choice {
    message: RespMsg,
}
#[derive(Deserialize)]
struct RespMsg {
    content: Option<String>,
    /// Some OpenAI-compatible endpoints expose the model's rationale here; when
    /// present it becomes `SynapseActionContent.thought`.
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Vec<RespToolCall>,
}
#[derive(Deserialize)]
struct RespToolCall {
    function: RespFn,
}
#[derive(Deserialize)]
struct RespFn {
    name: String,
    /// Some endpoints omit this entirely for a zero-parameter function.
    #[serde(default)]
    arguments: String,
}

impl OpenAiChatModel {
    /// Count and log one model-step failure, then hand the error back.
    ///
    /// `kind` is the same short constant on both the counter and the log line,
    /// which is what `metrics::record_error` documents and what nothing
    /// upholding it made true. Neither carries the utterance, the transcript or
    /// the API key — the model id and the failure class only.
    fn failed(&self, kind: &'static str, error: LlmError) -> LlmError {
        crate::metrics::record_error(kind);
        tracing::warn!(kind, model = %self.model, %error, "model step failed");
        error
    }
}

#[tonic::async_trait]
impl ChatModel for OpenAiChatModel {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        let msgs = messages
            .iter()
            .map(|m| WireMsg {
                role: match m.role {
                    Role::System => "system",
                    Role::User => "user",
                    Role::Assistant => "assistant",
                },
                content: Some(m.content.clone()),
            })
            .collect();
        let wire_tools = tools
            .iter()
            .map(|t| WireTool {
                r#type: "function",
                function: WireFn {
                    name: &t.name,
                    description: &t.description,
                    parameters: &t.parameters,
                },
            })
            .collect();
        let body = ChatReq {
            model: &self.model,
            messages: msgs,
            tools: wire_tools,
            max_tokens: self.max_tokens,
            reasoning: self
                .reasoning_effort
                .as_deref()
                .map(|effort| WireReasoning { effort }),
        };
        let started = std::time::Instant::now();
        // Every arm of this chain is counted and named. Only `.send()` used to
        // be, which made `llm_transport` the ONLY producer of
        // `cosmos_errors_total` in the codebase and left the two failures an
        // operator actually hits — a refused request and a body that will not
        // parse — with no counter and no log at all.
        let resp = self
            .client
            .post(format!(
                "{}/chat/completions",
                self.base_url.trim_end_matches('/')
            ))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| self.failed("llm_transport", LlmError::Transport(e.to_string())))?
            .error_for_status()
            .map_err(|e| {
                // The status separates a bad key from rate limiting from a
                // provider outage, and it is the one field that does. It is not
                // wearer content, so it goes in the log.
                let status = e.status().map_or(0, |status| status.as_u16());
                self.failed("llm_http_status", LlmError::Status(status))
            })?
            .json::<ChatResp>()
            .await
            .map_err(|e| self.failed("llm_malformed", LlmError::Transport(e.to_string())))?;
        // The dominant cost of a wearer's turn is model time, and it was
        // unmeasurable: this is the single point every model round trip passes
        // through. Recorded AFTER the response is decoded so a transport failure
        // is an error, not a fast latency sample.
        crate::metrics::record_model_latency(&self.model, started.elapsed());
        let msg = resp
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| self.failed("llm_malformed", LlmError::Malformed))?
            .message;
        let mut calls = msg.tool_calls.into_iter().map(|tc| ToolCall {
            name: tc.function.name,
            // Never let a non-object reach the device; see `normalize_arguments`.
            arguments: normalize_arguments(&tc.function.arguments),
        });
        let tool_call = calls.next();
        Ok(enforce_explicit_web_search(
            messages,
            tools,
            ChatResponse {
                content: msg.content,
                thought: msg.reasoning.unwrap_or_default(),
                tool_call,
                extra_tool_calls: calls.collect(),
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web_search_tool() -> ToolDef {
        ToolDef {
            name: "web_search".to_owned(),
            description: "Search the web".to_owned(),
            parameters: serde_json::json!({"type": "object"}),
        }
    }

    fn direct_answer(text: &str) -> ChatResponse {
        ChatResponse {
            content: Some(text.to_owned()),
            thought: String::new(),
            tool_call: None,
            extra_tool_calls: Vec::new(),
        }
    }

    #[test]
    fn an_explicit_search_request_cannot_be_answered_without_searching() {
        let messages = vec![ChatMessage::user(
            "Search the web for the PenumbraOS GitHub repository",
        )];
        let response = enforce_explicit_web_search(
            &messages,
            &[web_search_tool()],
            direct_answer("I cannot browse."),
        );

        assert_eq!(response.content, None);
        let call = response.tool_call.expect("web search is forced once");
        assert_eq!(call.name, "web_search");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&call.arguments).unwrap()["query"],
            messages[0].content
        );
    }

    #[test]
    fn a_completed_search_is_not_forced_into_a_loop() {
        let messages = vec![
            ChatMessage::user("Use web search for PenumbraOS"),
            ChatMessage::user("[Called web_search({\"query\":\"PenumbraOS\"}). Result: found]"),
        ];
        let response = enforce_explicit_web_search(
            &messages,
            &[web_search_tool()],
            direct_answer("The first result is PenumbraOS."),
        );

        assert!(response.tool_call.is_none());
        assert_eq!(
            response.content.as_deref(),
            Some("The first result is PenumbraOS.")
        );
    }

    #[test]
    fn ordinary_answers_and_existing_tool_choices_are_left_to_the_model() {
        let ordinary = enforce_explicit_web_search(
            &[ChatMessage::user("What is a compiler?")],
            &[web_search_tool()],
            direct_answer("A compiler translates source code."),
        );
        assert!(ordinary.tool_call.is_none());

        let existing = ChatResponse {
            content: None,
            thought: String::new(),
            tool_call: Some(ToolCall {
                name: "wikipedia".to_owned(),
                arguments: "{}".to_owned(),
            }),
            extra_tool_calls: Vec::new(),
        };
        let preserved = enforce_explicit_web_search(
            &[ChatMessage::user("Search the web for compilers")],
            &[web_search_tool()],
            existing.clone(),
        );
        assert_eq!(preserved.tool_call, existing.tool_call);
    }

    /// Every model step must contain a generation ceiling.
    ///
    /// Stock bounds each step at 200 tokens (`TaoAgentV2.java:195`). Sending no
    /// bound lets a verbose model spend the wearer's whole 25s turn deadline
    /// generating text that is then cut off mid-sentence when spoken — model
    /// steps are the dominant cost in a turn.
    #[test]
    fn every_request_carries_a_generation_ceiling() {
        let body = ChatReq {
            model: "m",
            messages: Vec::new(),
            tools: Vec::new(),
            max_tokens: parse_max_tokens(None),
            reasoning: None,
        };
        let wire = serde_json::to_value(&body).expect("serializes");
        assert_eq!(
            wire.get("max_tokens").and_then(|v| v.as_u64()),
            Some(u64::from(DEFAULT_MAX_TOKENS)),
            "an unconfigured deployment must still bound generation, got {wire}",
        );
    }

    #[test]
    fn the_ceiling_is_configurable_and_can_be_disabled() {
        assert_eq!(parse_max_tokens(Some("256")), Some(256));
        // Explicit opt-out for a provider that rejects the field.
        assert_eq!(parse_max_tokens(Some("0")), None);
        // Never silently drop the bound because someone typo'd the value.
        assert_eq!(parse_max_tokens(Some("banana")), Some(DEFAULT_MAX_TOKENS));
        assert_eq!(parse_max_tokens(Some("  ")), Some(DEFAULT_MAX_TOKENS));
    }

    /// REASONING EFFORT IS OFF UNTIL SOMEONE MEASURES IT.
    ///
    /// It is a latency knob with a correctness cost: a model that deliberates
    /// less picks the wrong tool more often, and a wrong tool is worse for the
    /// wearer than a slow right one. So an unconfigured deployment must send
    /// nothing and inherit the backend's own default.
    #[test]
    fn reasoning_effort_is_absent_unless_configured() {
        assert_eq!(parse_reasoning_effort(None), None);
        assert_eq!(parse_reasoning_effort(Some("  ")), None);
        let unset = parse_reasoning_effort(None);
        let body = ChatReq {
            model: "m",
            messages: Vec::new(),
            tools: Vec::new(),
            max_tokens: None,
            reasoning: unset.as_deref().map(|effort| WireReasoning { effort }),
        };
        let wire = serde_json::to_value(&body).expect("serializes");
        assert!(
            wire.get("reasoning").is_none(),
            "an unconfigured deployment must send no reasoning field at all, got {wire}"
        );
    }

    #[test]
    fn a_configured_effort_is_sent_and_an_unknown_one_is_dropped() {
        assert_eq!(parse_reasoning_effort(Some("low")), Some("low".to_owned()));
        assert_eq!(
            parse_reasoning_effort(Some(" HIGH ")),
            Some("high".to_owned())
        );
        // A typo must not be forwarded: the provider rejects an unknown effort,
        // and a 400 on every model step takes the whole assistant down.
        assert_eq!(parse_reasoning_effort(Some("lowest")), None);
        assert_eq!(parse_reasoning_effort(Some("banana")), None);

        let low = parse_reasoning_effort(Some("low"));
        let body = ChatReq {
            model: "m",
            messages: Vec::new(),
            tools: Vec::new(),
            max_tokens: None,
            reasoning: low.as_deref().map(|effort| WireReasoning { effort }),
        };
        let wire = serde_json::to_value(&body).expect("serializes");
        assert_eq!(
            wire.pointer("/reasoning/effort").and_then(|v| v.as_str()),
            Some("low"),
            "the provider shape is {{\"reasoning\":{{\"effort\":…}}}}, got {wire}"
        );
    }

    /// The field must be OMITTED, not sent as null, when disabled — a strict
    /// endpoint rejects `"max_tokens": null`.
    #[test]
    fn a_disabled_ceiling_omits_the_field_entirely() {
        let body = ChatReq {
            model: "m",
            messages: Vec::new(),
            tools: Vec::new(),
            max_tokens: None,
            reasoning: None,
        };
        let wire = serde_json::to_value(&body).expect("serializes");
        assert!(
            wire.get("max_tokens").is_none(),
            "a disabled ceiling must omit the key, not send null: {wire}",
        );
    }
}
