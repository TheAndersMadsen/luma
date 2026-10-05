//! Pluggable chat-model abstraction for the assistant engine.
//!
//! cosmos's serverside drives an OpenAI-shaped LLM whose exact model + prompts are
//! Humane's (server-only, not reproduced here). This layer lets the clone's ReAct
//! engine drive **our own** model with **our own** prompts: a [`ChatModel`] trait,
//! a deterministic test `MockChatModel`, and an OpenAI-compatible HTTP driver ([`OpenAiChatModel`]).

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("llm transport: {0}")]
    Transport(String),
    /// The provider answered, and refused. `429` is a rate limit, `401`/`403` an
    /// expired or wrong `COSMOS_LLM_API_KEY`, `5xx` the provider itself.
    ///
    /// Distinct from [`LlmError::Transport`] because the engine spoke the
    /// device's timeout string for all of these and `record_turn` then labelled
    /// the turn `deadline`, so a dead API key raised the latency-and-budget
    /// alarm and the operator went looking at deadlines.
    #[error("llm refused with HTTP {0}")]
    Status(u16),
    #[error("llm response was empty / malformed")]
    Malformed,
    #[cfg(test)]
    #[error("mock script exhausted")]
    ScriptExhausted,
}

/// A message in the running chat transcript handed to the model.
///
/// Tool results and wearer memory remain structurally distinct inside Cosmos.
/// The chat-completions adapter sends a tool result as the answer to its call
/// ([`wire_messages`]). A role a provider cannot express natively goes as its
/// JSON data envelope in a `user` message. Routing, replay, and policy code
/// never mistake either for a fresh wearer instruction.
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

    pub fn tool_result(name: &str, arguments: &str, observation: &str) -> Self {
        let arguments = serde_json::from_str::<serde_json::Value>(arguments)
            .unwrap_or_else(|_| serde_json::Value::String(arguments.to_owned()));
        Self {
            role: Role::ToolResult,
            content: serde_json::json!({
                "kind": "untrusted_tool_result",
                "tool": name,
                "arguments": arguments,
                "observation": observation,
            })
            .to_string(),
        }
    }

    pub fn prior_tool_call(name: &str, arguments: &str) -> Self {
        let arguments = serde_json::from_str::<serde_json::Value>(arguments)
            .unwrap_or_else(|_| serde_json::Value::String(arguments.to_owned()));
        Self {
            role: Role::ToolResult,
            content: serde_json::json!({
                "kind": "prior_tool_call",
                "tool": name,
                "arguments": arguments,
            })
            .to_string(),
        }
    }

    pub fn memory(content: &str) -> Self {
        Self {
            role: Role::Memory,
            content: serde_json::json!({
                "kind": "wearer_memory",
                "content": content,
            })
            .to_string(),
        }
    }

    pub fn device_context(content: &str) -> Self {
        Self {
            role: Role::DeviceContext,
            content: serde_json::json!({
                "kind": "authenticated_device_context",
                "content": content,
            })
            .to_string(),
        }
    }

    fn is_tool_result_for(&self, tool: &str) -> bool {
        self.role == Role::ToolResult
            && serde_json::from_str::<serde_json::Value>(&self.content)
                .ok()
                .is_some_and(|value| {
                    value.get("kind").and_then(serde_json::Value::as_str)
                        == Some("untrusted_tool_result")
                        && value.get("tool").and_then(serde_json::Value::as_str) == Some(tool)
                })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
    ToolResult,
    Memory,
    DeviceContext,
}

/// Coerce model-supplied tool arguments into a JSON **object**.
///
/// The device parses `SynapseActionContent.input` with
/// `JsonParser.parseString(input).getAsJsonObject()`, unconditionally, before it
/// even looks at the slot list (`Schema.resolve`). Gson turns `""` into
/// `JsonNull`, and `JsonNull.getAsJsonObject()` throws; `JsonResolver` catches it
/// and the pin bounces "Unrecognized function name and/or arguments". Since the
/// server then re-plans and emits the same action, that is an infinite bounce
/// until the action limit trips and the wearer hears the runaway apology, for a
/// request the device could have executed immediately.
///
/// OpenAI-compatible endpoints routinely emit `""` for a function with no
/// parameters, and many recovered device actions take none (`AmIOnline`,
/// `EndCall`, `GetBatteryLevel`, `LockDevice`, …). `{}` is the device's own
/// canonical zero-argument form, it is what `Errors.unsubscribed()` and
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

/// One model turn: either a tool call (loop) or final content (finish), mirrors
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
    /// answered as though it had run, and cost two model round trips instead of
    /// one. `tool_call` stays the primary so single-call callers are unchanged.
    pub extra_tool_calls: Vec<ToolCall>,
}

/// Content-free model configuration attached to one foreground run.
///
/// These values describe operator-selected infrastructure only. They never
/// contain prompts, transcripts, tool arguments, wearer identity, or provider
/// response text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelProvenance {
    pub provider: String,
    pub model: String,
    pub speed: String,
    pub effort: String,
}

impl ModelProvenance {
    fn unreported() -> Self {
        Self {
            provider: "unreported".to_owned(),
            model: "unreported".to_owned(),
            speed: "unreported".to_owned(),
            effort: "unreported".to_owned(),
        }
    }
}

fn explicit_web_search_utterance(messages: &[ChatMessage]) -> Option<&str> {
    let utterance = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)?
        .content
        .trim();
    (!utterance.is_empty() && names_web_search(utterance)).then_some(utterance)
}

/// Whether the wearer named web search as the capability to use.
pub(crate) fn names_web_search(utterance: &str) -> bool {
    let normalized = utterance.to_lowercase();
    [
        "web_search",
        "web search",
        "search the web",
        "browse the web",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
}

fn explicit_lookup_utterance(messages: &[ChatMessage]) -> Option<&str> {
    let utterance = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)?
        .content
        .trim();
    if utterance.is_empty() {
        return None;
    }
    let normalized = utterance.to_lowercase();
    (normalized.contains("look up ") || normalized.contains("lookup ")).then_some(utterance)
}

/// Explicit playback is an action request, so a plain model answer cannot
/// complete it. Requiring one offered tool leaves the semantic choice with the
/// model while preventing prose such as an invented provider timeout from
/// being accepted as if work had run.
fn explicit_playback_requires_tool(messages: &[ChatMessage], tools: &[ToolDef]) -> bool {
    !tools.is_empty()
        && messages
            .iter()
            .rev()
            .find(|message| message.role == Role::User)
            .is_some_and(|message| super::intents::explicit_playback_request(&message.content))
}

/// Whether this turn, the messages after the wearer's latest request, already
/// holds a result from `tool`. The Pin replays earlier turns of the
/// conversation, and their results answered those turns.
fn current_turn_has_result(messages: &[ChatMessage], tool: &str) -> bool {
    messages
        .iter()
        .rev()
        .take_while(|message| message.role != Role::User)
        .any(|message| message.is_tool_result_for(tool))
}

/// Whether this turn, the messages after the wearer's latest request, already
/// holds any tool result or replayed tool call. The retry and compose-fallback
/// decisions ask this rather than scanning the whole replay window: the Pin
/// replays earlier completed runs for three minutes, and their observations
/// answered those runs, not this one.
pub(crate) fn current_request_has_tool_result(messages: &[ChatMessage]) -> bool {
    messages
        .iter()
        .rev()
        .take_while(|message| message.role != Role::User)
        .any(|message| message.role == Role::ToolResult)
}

/// The wearer's words reduced to the command itself: lowercased, with polite
/// or spoken openers ("please", "can you", "hey", "OK,") removed. `None` for
/// empty text or text carrying control characters.
fn os3_command(utterance: &str) -> Option<String> {
    let normalized = utterance.trim().to_lowercase();
    if normalized.is_empty() || normalized.chars().any(char::is_control) {
        return None;
    }
    let mut command = normalized.as_str();
    while let Some(request) = [
        "please ",
        "please, ",
        "can you ",
        "could you ",
        "would you ",
        "will you ",
        "hey ",
        "hey, ",
        "ok ",
        "ok, ",
        "okay ",
        "okay, ",
    ]
    .into_iter()
    .find_map(|prefix| command.strip_prefix(prefix))
    {
        command = request.trim_start();
    }
    Some(command.to_owned())
}

/// Whether the wearer only asked how earlier OS3 work is going ("What did OS3
/// find?", "Is OS3 still working?"), as opposed to giving OS3 new work.
pub(crate) fn os3_status_follow_up(utterance: &str) -> bool {
    let Some(command) = os3_command(utterance) else {
        return false;
    };
    // These are prefixes because a natural status question may name the task
    // afterwards ("what did OS3 find about the battery?"). Require a real
    // phrase boundary, though: `starts_with` alone also treated a possessive
    // mention such as "check OS3's privacy settings" as authorization to run
    // OS3, and matched longer non-OS3 words such as "OS3X".
    let starts_with_phrase = |phrase: &str| {
        command.strip_prefix(phrase).is_some_and(|remainder| {
            remainder.is_empty()
                || remainder.chars().next().is_some_and(|character| {
                    character.is_whitespace()
                        || matches!(character, '?' | '.' | '!' | ',' | ':' | ';' | '-' | '—')
                })
        })
    };
    let direct_follow_up = [
        "what did os3 find",
        "what has os3 found",
        "what did os3 say",
        "what is os3 doing",
        "is os3 done",
        "is os3 still working",
        "check on os3",
        "check os3",
    ]
    .into_iter()
    .any(starts_with_phrase);
    let status_follow_up = matches!(
        command.trim_end_matches(['?', '.', '!']).trim_end(),
        "did os3 finish"
            | "has os3 finished"
            | "any update from os3"
            | "any update on os3"
            | "how is os3 doing"
            | "how's os3 doing"
            | "os3 status"
            | "what is os3's status"
            | "what's the status of os3"
    );
    direct_follow_up || status_follow_up
}

/// INFERRED Luma command grammar: request cancellation only for a simple,
/// explicit wearer command. Backend state decides whether there is a scoped
/// accepted task. This does not mean stop every task in an OS3 account.
/// Terminal question punctuation is accepted on exact commands. Mention
/// questions, quoted text and compound/conditional instructions stay outside
/// this typed control path even when ordinary OS3 delegation accepts them.
pub(crate) fn os3_cancel_request(utterance: &str) -> bool {
    if utterance.chars().any(char::is_control)
        || utterance.contains(['\"', '\'', '‘', '’', '“', '”', '`'])
    {
        return false;
    }
    let Some(command) = os3_command(utterance) else {
        return false;
    };
    let command = command.split_whitespace().collect::<Vec<_>>().join(" ");
    let command = command.trim_end_matches(['.', '!', '?']).trim_end();
    if command.contains('?') {
        return false;
    }
    let command = command
        .strip_suffix(", please")
        .or_else(|| command.strip_suffix(" please"))
        .unwrap_or(command);
    let addressed = command
        .strip_prefix("os3,")
        .or_else(|| command.strip_prefix("os3:"))
        .map(|rest| format!("os3 {}", rest.trim_start()));
    let command = addressed.as_deref().unwrap_or(command);
    matches!(
        command,
        "cancel os3"
            | "stop os3"
            | "cancel the os3 task"
            | "stop the os3 task"
            | "os3 cancel"
            | "os3 stop"
            | "tell os3 to cancel"
            | "tell os3 to stop"
            | "tell os3 to cancel the task"
            | "tell os3 to stop the task"
            | "tell os3 to cancel current task"
            | "tell os3 to stop current task"
            | "tell os3 to cancel the current task"
            | "tell os3 to stop the current task"
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Os3FollowUp {
    Status,
    Cancel,
    OwnerInput,
}

/// INFERRED: short follow-ups have an OS3 target only when the authenticated
/// account still retains accepted work under its current sign-in. This grammar
/// supplies no authority by itself. Catalog resolves that task separately.
pub(crate) fn contextual_os3_follow_up(utterance: &str) -> Option<Os3FollowUp> {
    if utterance.chars().any(char::is_control)
        || utterance.contains(['\"', '\'', '‘', '’', '“', '”', '`'])
    {
        return None;
    }
    let command = os3_command(utterance)?;
    let command = command.split_whitespace().collect::<Vec<_>>().join(" ");
    let command = command.trim_end_matches(['.', '!', '?']).trim_end();
    match command {
        "give me an update"
        | "any update"
        | "is it done"
        | "is it finished"
        | "are you done"
        | "check again"
        | "i approved it, check again"
        | "i approved it check again" => Some(Os3FollowUp::Status),
        "cancel it" | "stop the task" | "cancel the task" => Some(Os3FollowUp::Cancel),
        "yes" => Some(Os3FollowUp::OwnerInput),
        _ => None,
    }
}

/// Whether the wearer explicitly delegated this request to OS3.
///
/// This is intentionally command-shaped rather than a broad mention check:
/// talking about OS3 must not authorize work on another device. A later status
/// question is explicit too, because it is how the wearer resumes work OS3
/// kept running after the Pin turn ended. Spoken forms that speech recognition
/// punctuates ("Ask OS3, what is on my desktop?", "Hey OS3, check my Mac.")
/// are the same command.
pub(crate) fn explicit_os3_request(utterance: &str) -> bool {
    if os3_cancel_request(utterance) {
        return true;
    }
    let Some(command) = os3_command(utterance) else {
        return false;
    };
    let command = command.as_str();
    // "ask OS3" then a space, or the comma, colon or dash transcription puts
    // after an address. Never "ask OS3's …" or "ask OS3X".
    let delegated_to = |verb: &str| {
        command.strip_prefix(verb).is_some_and(|remainder| {
            remainder.chars().next().is_some_and(|character| {
                character.is_whitespace() || matches!(character, ',' | ':' | '-' | '—')
            }) && !remainder
                .trim_start_matches(|character: char| {
                    character.is_whitespace() || matches!(character, ',' | ':' | '-' | '—')
                })
                .is_empty()
        })
    };
    let delegated = ["ask os3", "tell os3", "have os3"]
        .into_iter()
        .any(delegated_to)
        || ["use os3 to ", "using os3, ", "using os3 to ", "get os3 to "]
            .into_iter()
            .any(|prefix| {
                command
                    .strip_prefix(prefix)
                    .is_some_and(|request| !request.trim().is_empty())
            });
    let addressed = ["os3,", "os3:", "os3 -", "os3 —"]
        .into_iter()
        .any(|prefix| {
            command
                .strip_prefix(prefix)
                .is_some_and(|request| !request.trim().is_empty())
        });
    let unpunctuated_address = command.strip_prefix("os3 ").is_some_and(|request| {
        let verb = request.split_whitespace().next().unwrap_or_default();
        [
            "analyze",
            "build",
            "check",
            "clean",
            "close",
            "continue",
            "copy",
            "count",
            "create",
            "delete",
            "deploy",
            "download",
            "find",
            "finish",
            "help",
            "inspect",
            "launch",
            "list",
            "move",
            "open",
            "organize",
            "read",
            "rename",
            "reply",
            "restart",
            "run",
            "search",
            "send",
            "show",
            "start",
            "stop",
            "summarize",
            "test",
            "upload",
            "wait",
            "write",
        ]
        .contains(&verb)
    });

    delegated || addressed || unpunctuated_address || os3_status_follow_up(command)
}

/// The model's OS3 call, corrected to the one shape delegation may take.
///
/// Which executor serves a request is the model-led loop's semantic decision:
/// the `ask_os3` tool description teaches when the wearer's Rabbit companion
/// work, their Mac, its files, its tasks, belongs to OS3, so a natural
/// "what's on my MacBook?" reaches it without the utterance naming OS3. This
/// correction changes nothing about that choice. It repairs the call's shape.
/// Delegation is exclusive (never one branch of parallel fan-out) and OS3
/// hears the wearer's own words through `ToolContext`, so any model-authored
/// arguments are dropped and companions with it. When the model did not
/// select OS3, nothing is forced: a keyword override here would be a router
/// in front of the model.
fn enforce_explicit_os3(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    if !tools
        .iter()
        .any(|tool| tool.name == super::catalog::OS3_TOOL)
        || current_turn_has_result(messages, super::catalog::OS3_TOOL)
    {
        return response;
    }
    let selected = response
        .tool_call
        .iter()
        .chain(response.extra_tool_calls.iter())
        .any(|call| call.name == super::catalog::OS3_TOOL);
    if !selected {
        return response;
    }

    response.content = None;
    response.thought.clear();
    response.tool_call = Some(ToolCall {
        name: super::catalog::OS3_TOOL.to_owned(),
        arguments: "{}".to_owned(),
    });
    response.extra_tool_calls.clear();
    tracing::info!("OS3 delegation normalized to one exclusive zero-argument call");
    response
}

/// Once explicit work has its observation, the model answers from it instead
/// of starting it again. A second search adds latency. A second OS3 delegation
/// could repeat work on another device.
fn tools_after_completed_explicit_work(
    messages: &[ChatMessage],
    tools: &[ToolDef],
) -> Vec<ToolDef> {
    let has_result = |name: &str| current_turn_has_result(messages, name);
    let web_searched =
        has_result("web_search") && explicit_web_search_utterance(messages).is_some();
    let places_searched = has_result("nearby")
        && messages
            .iter()
            .rev()
            .find(|message| message.role == Role::User)
            .is_some_and(|message| {
                super::intents::explicit_nearby_query(&message.content).is_some()
            });
    // Once this turn holds OS3's observation, delegation is done: OS3 may
    // only be asked once per request, whatever the wearer called it.
    let os3_contacted = has_result(super::catalog::OS3_TOOL);

    tools
        .iter()
        .filter(|tool| match tool.name.as_str() {
            "web_search" | "ask_online" => !web_searched,
            "nearby" => !places_searched,
            super::catalog::OS3_TOOL => !os3_contacted,
            _ => true,
        })
        .cloned()
        .collect()
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
    if !tools.iter().any(|tool| tool.name == "web_search")
        || current_turn_has_result(messages, "web_search")
    {
        return response;
    }

    let Some(utterance) = explicit_web_search_utterance(messages) else {
        return response;
    };

    let mut calls = response.tool_call.take().into_iter().collect::<Vec<_>>();
    calls.append(&mut response.extra_tool_calls);
    let existing_search = calls
        .iter()
        .position(|call| call.name == "web_search")
        .map(|index| calls.remove(index));
    let search = existing_search.unwrap_or_else(|| ToolCall {
        name: "web_search".to_owned(),
        arguments: serde_json::json!({ "query": utterance }).to_string(),
    });
    tracing::info!("explicit web-search request normalized to the requested capability");
    response.content = None;
    response.tool_call = Some(search);
    // `ask_online` overlaps this explicit wearer-selected capability, while a
    // terminal `Respond` would end the run before the lookup. Preserve only
    // independent calls such as an explicitly requested Wikipedia lookup.
    response.extra_tool_calls = calls
        .into_iter()
        .filter(|call| !matches!(call.name.as_str(), "ask_online" | "Respond" | "web_search"))
        .collect();
    response
}

/// Honor an explicit generic lookup without overriding a retrieval route the
/// model already selected.
///
/// "Look up" does not name a provider. Wikipedia is the cheapest appropriate
/// default for ordinary background facts. Deployments without it fall back to
/// web search and then the configured answer engine. This is an intent-level
/// rule and contains no entity, artist, or prompt-specific vocabulary.
fn enforce_explicit_lookup(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    let Some(utterance) = explicit_lookup_utterance(messages) else {
        return response;
    };
    if ["wikipedia", "web_search", "ask_online", "ask_os3"]
        .iter()
        .any(|tool| current_turn_has_result(messages, tool))
    {
        return response;
    }
    if response
        .tool_call
        .iter()
        .chain(response.extra_tool_calls.iter())
        .any(|call| {
            matches!(
                call.name.as_str(),
                "food_lookup"
                    | "web_search"
                    | "ask_online"
                    | "ask_os3"
                    | "wikipedia"
                    | "wolfram"
                    | "recall_memory"
                    | "music_discover"
            )
        })
    {
        return response;
    }

    let Some(tool) = ["wikipedia", "web_search", "ask_online"]
        .into_iter()
        .find(|name| tools.iter().any(|tool| tool.name == *name))
    else {
        return response;
    };

    let mut calls = response.tool_call.take().into_iter().collect::<Vec<_>>();
    calls.append(&mut response.extra_tool_calls);
    response.content = None;
    response.tool_call = Some(ToolCall {
        name: tool.to_owned(),
        arguments: serde_json::json!({ "query": utterance }).to_string(),
    });
    response.extra_tool_calls = calls
        .into_iter()
        .filter(|call| {
            !matches!(
                call.name.as_str(),
                "Respond" | "wikipedia" | "web_search" | "ask_online"
            )
        })
        .collect();
    tracing::info!(
        tool,
        "explicit lookup request normalized to a retrieval capability"
    );
    response
}

/// Do not accept a fabricated terminal answer for an explicit playback request
/// before any music work has run.
///
/// The model remains the normal planner: any tool it selected is preserved.
/// This is the zero-tool recovery path, plus one rule for ranked playback
/// ("Play Dr. Dre's most popular song"): which track ranks highest is
/// research, so a `PlayMusic` naming a track, or a `music_discover` that would
/// only confirm the model's own guess exists, cannot be the first step. Only a
/// provider-confirmed title and artist becomes `PlayMusic` (AGENTS.md). The
/// engine has already narrowed the turn to one configured research tool, so
/// forwarding the wearer's complete request to it obtains evidence without
/// hard-coding an artist, title, ranking criterion, or provider result here.
fn enforce_unstarted_music_playback(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    if !tools.iter().any(|tool| tool.name == "music_discover")
        || ["web_search", "ask_online", "music_discover"]
            .iter()
            .any(|tool| current_turn_has_result(messages, tool))
    {
        return response;
    }

    let Some(utterance) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
        .map(|message| message.content.trim())
        .filter(|utterance| super::intents::explicit_playback_request(utterance))
    else {
        return response;
    };
    let mut calls = response.tool_call.iter().chain(&response.extra_tool_calls);
    let unresearched_pick = super::intents::ranked_playback_request(utterance)
        && calls.clone().any(|call| {
            call.name == "music_discover" || (call.name == "PlayMusic" && names_a_track(call))
        });
    if calls.next().is_some() && !unresearched_pick {
        return response;
    }
    let Some(tool) = ["ask_online", "web_search"]
        .into_iter()
        .find(|name| tools.iter().any(|tool| tool.name == *name))
    else {
        return response;
    };

    response.content = None;
    response.tool_call = Some(ToolCall {
        name: tool.to_owned(),
        arguments: serde_json::json!({ "query": utterance }).to_string(),
    });
    response.extra_tool_calls.clear();
    tracing::info!(
        tool,
        unresearched_pick,
        "unstarted playback normalized to the available research capability"
    );
    response
}

/// Whether a `PlayMusic` call names a specific track.
fn names_a_track(call: &ToolCall) -> bool {
    serde_json::from_str::<serde_json::Value>(&call.arguments)
        .ok()
        .and_then(|arguments| {
            arguments
                .get("Track")
                .and_then(serde_json::Value::as_str)
                .map(|track| !track.trim().is_empty())
        })
        .unwrap_or(false)
}

/// Play an existing playlist through the stock `Playlist` slot.
///
/// The model still chooses the music tool. This guard only repairs choices
/// that cannot play the wearer's own playlist once an explicit playback request
/// names one (for example, "my workout playlist"): `GenerateMusicPlaylist`
/// builds a new one, `Track` searches for a song of that name, and the stock
/// handler reads `Option` only as shuffle or repeat. The stock resolver plays a
/// named playlist only from `Playlist` (`queryWithPlaylistName`). The
/// model-authored name remains the provider query. No title or use case is
/// hard-coded here.
fn enforce_existing_playlist_playback(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    if !tools.iter().any(|tool| tool.name == "PlayMusic")
        || !explicit_existing_playlist_request(messages)
    {
        return response;
    }

    let Some(arguments) = response
        .tool_call
        .iter()
        .chain(response.extra_tool_calls.iter())
        .filter(|call| matches!(call.name.as_str(), "GenerateMusicPlaylist" | "PlayMusic"))
        .find_map(|call| {
            let arguments = serde_json::from_str::<serde_json::Value>(&call.arguments).ok()?;
            existing_playlist_arguments(&call.name, &arguments)
        })
    else {
        return response;
    };

    response.content = None;
    response.tool_call = Some(ToolCall {
        name: "PlayMusic".to_owned(),
        arguments: arguments.to_string(),
    });
    response.extra_tool_calls.clear();
    tracing::info!("existing-playlist request normalized to stock playlist playback");
    response
}

/// `PlayMusic` arguments that play the named existing playlist, or `None`
/// when the call already does, or names no playlist to play.
fn existing_playlist_arguments(
    action: &str,
    arguments: &serde_json::Value,
) -> Option<serde_json::Value> {
    let field = |name: &str| {
        arguments
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let transport = field("Option").filter(|option| {
        option.eq_ignore_ascii_case("shuffle") || option.eq_ignore_ascii_case("repeat")
    });
    let named = match action {
        "GenerateMusicPlaylist" => field("Playlist")?,
        _ => {
            let current = field("Playlist");
            let untouched = ["Track", "Artist", "Album", "Genre"]
                .iter()
                .all(|slot| field(slot).is_none());
            if current.is_some_and(|name| playlist_name(name) == name) && untouched {
                return None;
            }
            current
                .or_else(|| field("Track").filter(|track| mentions_playlist(track)))
                .or_else(|| {
                    field("Option")
                        .filter(|option| transport.is_none() && !is_playlist_word(option))
                })
                .or_else(|| {
                    field("Track").filter(|_| field("Option").is_some_and(is_playlist_word))
                })?
        }
    };
    let name = playlist_name(named);
    if name.is_empty() {
        return None;
    }
    let mut repaired = serde_json::json!({ "Playlist": name });
    if let Some(option) = transport {
        repaired["Option"] = serde_json::Value::String(option.to_ascii_lowercase());
    }
    Some(repaired)
}

fn is_playlist_word(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "playlist" | "playlists"
    )
}

fn mentions_playlist(value: &str) -> bool {
    value
        .split(|character: char| !character.is_alphanumeric())
        .any(is_playlist_word)
}

/// A playlist's own name: "my workout playlist" names "workout".
fn playlist_name(value: &str) -> &str {
    let mut name = value.trim().trim_end_matches(['.', '!', '?']).trim_end();
    for prefix in ["my ", "the "] {
        if name.len() > prefix.len()
            && name
                .get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        {
            name = name[prefix.len()..].trim_start();
        }
    }
    for suffix in [" playlists", " playlist"] {
        let Some(split) = name
            .len()
            .checked_sub(suffix.len())
            .filter(|split| *split > 0)
        else {
            continue;
        };
        if name
            .get(split..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
        {
            name = name[..split].trim_end();
            break;
        }
    }
    name
}

/// Keep a relative volume change pointed the way the wearer asked.
///
/// "The music is too loud" names loudness but asks for less of it. A model
/// that keys on "loud" has turned the volume up. When the wearer's words name
/// exactly one direction, a relative volume action the other way is flipped.
/// The model still decides whether to change the volume at all.
fn enforce_volume_direction(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    use super::intents::VolumeDirection;
    let Some(direction) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
        .and_then(|message| super::intents::volume_direction(&message.content))
    else {
        return response;
    };
    let (wanted, opposite) = match direction {
        VolumeDirection::Up => ("IncrementVolume", "DecrementVolume"),
        VolumeDirection::Down => ("DecrementVolume", "IncrementVolume"),
    };
    if !tools.iter().any(|tool| tool.name == wanted) {
        return response;
    }
    let mut flipped = false;
    for call in response
        .tool_call
        .iter_mut()
        .chain(response.extra_tool_calls.iter_mut())
        .filter(|call| call.name == opposite)
    {
        call.name = wanted.to_owned();
        call.arguments = "{}".to_owned();
        flipped = true;
    }
    if flipped {
        tracing::info!(
            action = wanted,
            "relative volume change turned to the requested direction"
        );
    }
    response
}

/// Send an exact music transport command to the Pin as the stock action it
/// names.
///
/// Stock always emits the transport action and lets the device answer, even
/// with nothing queued ("No track is queued, cannot start playing."). Live,
/// the model answered "Resume the music." with words alone, and sent
/// `NextTrack` for "Previous track." in 4 of 8 runs. When the wearer's whole
/// request is one transport command, the offered stock action it names is
/// this step, whatever the model chose.
fn enforce_music_transport(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    let Some(action) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
        .and_then(|message| super::intents::explicit_music_transport_action(&message.content))
    else {
        return response;
    };
    // Only this request's own result counts: the Pin replays earlier turns,
    // and a wearer pauses and resumes many times in one conversation.
    if !tools.iter().any(|tool| tool.name == action) || current_turn_has_result(messages, action) {
        return response;
    }
    let stock = ToolCall {
        name: action.to_owned(),
        arguments: "{}".to_owned(),
    };
    if response.tool_call.as_ref() != Some(&stock) || !response.extra_tool_calls.is_empty() {
        tracing::info!(
            action,
            "music transport command normalized to its stock action"
        );
    }
    response.content = None;
    response.tool_call = Some(stock);
    response.extra_tool_calls.clear();
    response
}

fn explicit_existing_playlist_request(messages: &[ChatMessage]) -> bool {
    let Some(utterance) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
        .map(|message| message.content.trim())
        .filter(|utterance| super::intents::explicit_playback_request(utterance))
    else {
        return false;
    };

    let normalized = utterance.to_lowercase();
    let words = normalized
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    if !words
        .iter()
        .any(|word| matches!(*word, "playlist" | "playlists"))
    {
        return false;
    }

    let mut command = normalized.trim();
    if let Some(rest) = command.strip_prefix("please ") {
        command = rest;
    }
    for prefix in ["can you ", "could you ", "would you ", "will you "] {
        if let Some(rest) = command.strip_prefix(prefix) {
            command = rest;
            break;
        }
    }

    !["make ", "create ", "generate ", "build ", "curate "]
        .iter()
        .any(|prefix| command.starts_with(prefix))
        && !command.starts_with("play a playlist for ")
}

/// A direct named-destination route is one bounded lookup, not an open-ended
/// place search. Normalize a wrong model choice (observed as `nearby` for the
/// exact cycling checklist prompt) to `route`, retaining the requested travel
/// mode. Once a route observation exists, the model is free to summarize it.
fn enforce_explicit_route(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    if !tools.iter().any(|tool| tool.name == "route") || current_turn_has_result(messages, "route")
    {
        return response;
    }
    let Some(arguments) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
        .and_then(|message| super::intents::explicit_route_tool_arguments(&message.content))
    else {
        return response;
    };
    response.content = None;
    response.tool_call = Some(ToolCall {
        name: "route".to_owned(),
        arguments,
    });
    response.extra_tool_calls.clear();
    tracing::info!("explicit route request normalized to the route capability");
    response
}

/// Listing the wearer's notes always reads their authenticated memory store
/// first. This prevents a plausible-sounding generic answer from replacing the
/// only operation that can know whether notes exist or what they contain.
fn enforce_explicit_recent_notes(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    if !tools.iter().any(|tool| tool.name == "recall_memory")
        || current_turn_has_result(messages, "recall_memory")
    {
        return response;
    }
    let Some(arguments) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
        .and_then(|message| super::intents::explicit_recent_notes_tool_arguments(&message.content))
    else {
        return response;
    };
    response.content = None;
    response.tool_call = Some(ToolCall {
        name: "recall_memory".to_owned(),
        arguments,
    });
    response.extra_tool_calls.clear();
    tracing::info!("explicit note listing normalized to authenticated memory recall");
    response
}

/// A local place/weather request has already completed the stock location
/// preflight before the model runs. Keep the model as the planner for the
/// response, but do not let it skip or substitute the one read tool that can
/// ground the answer in that device-provided location.
fn enforce_grounded_location_read(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    mut response: ChatResponse,
) -> ChatResponse {
    let Some(utterance) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
        .map(|message| message.content.as_str())
    else {
        return response;
    };
    let has_result = |name: &str| current_turn_has_result(messages, name);
    let offered = |name: &str| tools.iter().any(|tool| tool.name == name);

    let call = if super::intents::current_city_request(utterance)
        && offered("reverse_geocode")
        && !has_result("reverse_geocode")
    {
        Some(ToolCall {
            name: "reverse_geocode".to_owned(),
            arguments: "{}".to_owned(),
        })
    } else if (super::intents::local_weather_request(utterance)
        || super::intents::local_forecast_request(utterance))
        && offered("weather")
        && !has_result("weather")
    {
        Some(ToolCall {
            name: "weather".to_owned(),
            arguments: "{}".to_owned(),
        })
    } else if let Some(query) = super::intents::explicit_nearby_query(utterance)
        && offered("nearby")
        && !has_result("nearby")
    {
        Some(ToolCall {
            name: "nearby".to_owned(),
            arguments: serde_json::json!({"query": query}).to_string(),
        })
    } else {
        None
    };

    if let Some(call) = call {
        response.content = None;
        response.tool_call = Some(call);
        response.extra_tool_calls.clear();
        tracing::info!("grounded location request normalized to its local read capability");
    }
    response
}

fn enforce_explicit_retrieval(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    response: ChatResponse,
) -> ChatResponse {
    let response = enforce_volume_direction(messages, tools, response);
    let response = enforce_music_transport(messages, tools, response);
    let response = enforce_explicit_recent_notes(
        messages,
        tools,
        enforce_grounded_location_read(
            messages,
            tools,
            enforce_explicit_route(
                messages,
                tools,
                enforce_explicit_lookup(
                    messages,
                    tools,
                    enforce_unstarted_music_playback(
                        messages,
                        tools,
                        enforce_existing_playlist_playback(
                            messages,
                            tools,
                            enforce_explicit_web_search(messages, tools, response),
                        ),
                    ),
                ),
            ),
        ),
    );
    enforce_explicit_os3(messages, tools, response)
}

/// Recover the one retrieval that must still happen when a model step fails.
///
/// This is deliberately narrower than choosing a useful tool: it reuses the
/// same explicit-request guards that reject an ungrounded model answer. A
/// location observation, for example, is only a prerequisite for an explicit
/// route request. It is not evidence from which a tool-less fallback may claim
/// to have produced directions.
pub(crate) fn required_retrieval_after_model_failure(
    messages: &[ChatMessage],
    tools: &[ToolDef],
) -> Option<ToolCall> {
    enforce_explicit_retrieval(messages, tools, ChatResponse::default()).tool_call
}

#[tonic::async_trait]
pub trait ChatModel: Send + Sync + 'static {
    fn provenance(&self) -> ModelProvenance {
        ModelProvenance::unreported()
    }

    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError>;
}

/// The live model selector backed by Cosmos's persisted integration settings.
/// A dashboard save takes effect on the next model step. No container or Pin
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
    fn provenance(&self) -> ModelProvenance {
        let config = crate::integrations::active().snapshot().assistant;
        let configured = config.configured();
        let provider = match config.provider {
            crate::integrations::AssistantProvider::OpenAiCompatible if configured => {
                "openai_compatible"
            }
            crate::integrations::AssistantProvider::CodexSubscription if configured => {
                "codex_subscription"
            }
            _ if self.demo_when_unconfigured => "demo",
            _ => "unconfigured",
        };
        ModelProvenance {
            provider: provider.to_owned(),
            model: if configured {
                config.model
            } else if self.demo_when_unconfigured {
                "demo".to_owned()
            } else {
                "none".to_owned()
            },
            speed: if configured
                && config.provider == crate::integrations::AssistantProvider::CodexSubscription
                && config.fast_mode
            {
                "fast".to_owned()
            } else {
                "standard".to_owned()
            },
            effort: config
                .reasoning_effort
                .unwrap_or_else(|| "provider_default".to_owned()),
        }
    }

    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        let tools = tools_after_completed_explicit_work(messages, tools);
        let tools = tools.as_slice();
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
                let require_tool = explicit_playback_requires_tool(messages, tools);
                let response = super::codex_app_server::complete(
                    &config.model,
                    config.reasoning_effort.as_deref(),
                    config.fast_mode,
                    prompt,
                    require_tool,
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
                Ok(enforce_explicit_retrieval(messages, tools, result))
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
                    Role::ToolResult => "tool_result",
                    Role::Memory => "memory",
                    Role::DeviceContext => "device_context",
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

/// Deterministic model for tests: returns a scripted sequence of responses
/// (tool calls then a final answer), one per `complete` call.
#[cfg(test)]
pub struct MockChatModel {
    script: std::sync::Mutex<std::collections::VecDeque<ChatResponse>>,
}

#[cfg(test)]
impl MockChatModel {
    pub fn new(script: Vec<ChatResponse>) -> Self {
        Self {
            script: std::sync::Mutex::new(script.into()),
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

#[cfg(test)]
#[tonic::async_trait]
impl ChatModel for MockChatModel {
    fn provenance(&self) -> ModelProvenance {
        ModelProvenance {
            provider: "test".to_owned(),
            model: "scripted".to_owned(),
            speed: "deterministic".to_owned(),
            effort: "none".to_owned(),
        }
    }

    async fn complete(&self, _m: &[ChatMessage], _t: &[ToolDef]) -> Result<ChatResponse, LlmError> {
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .ok_or(LlmError::ScriptExhausted)
    }
}

/// Stateless stand-in for deployments with no language model configured.
///
/// It answers with one plain line and chooses no lookup of its own. Without a
/// model nothing can read a tool's result, so a search it chose would only
/// send the wearer's words to a vendor (web search can forward them to
/// SerpApi) and keep the wearer waiting for an answer that cannot use it.
/// Only what every model step gets still applies: an explicit request the
/// `enforce_*` corrections turn into its tool ("search the web for …", a
/// route, "what city am I in"), which the wearer asked for by name. The line
/// keeps operational detail out of the wearer's ear: tool availability,
/// provider choice and deployment state belong in operator health surfaces,
/// and Center's assistant settings say the model is missing.
pub struct DemoChatModel;

/// What a deployment with no model says to every request.
pub(crate) const DEMO_ANSWER: &str = "This request can't be completed right now.";

#[tonic::async_trait]
impl ChatModel for DemoChatModel {
    fn provenance(&self) -> ModelProvenance {
        ModelProvenance {
            provider: "demo".to_owned(),
            model: "demo".to_owned(),
            speed: "deterministic".to_owned(),
            effort: "none".to_owned(),
        }
    }

    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        Ok(enforce_explicit_retrieval(
            messages,
            tools,
            ChatResponse {
                content: Some(DEMO_ANSWER.to_owned()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ))
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
    /// a verbose model spend the wearer's whole model-step allowance generating
    /// prose that will be cut off mid-sentence when spoken, model steps are the
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
    /// a latency knob with a correctness cost, a model that thinks less picks
    /// the wrong tool more often, so it must be measured on BOTH axes before
    /// being turned on anywhere a wearer is listening.
    reasoning_effort: Option<String>,
}

impl OpenAiChatModel {
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

/// The names the provider sees for Cosmos's own tools, where they differ from
/// the catalog's.
///
/// An agent gateway that answers chat completions keeps its own tool names for
/// itself. OpenClaw refuses the whole request (HTTP 400, "invalid tool
/// configuration") when a client tool shares a name with one of the agent's
/// tools, and `web_search` is one of them: every turn failed, from the Pin and
/// from Center alike. The tool keeps its name everywhere inside Cosmos, in the
/// trace and in the evaluator. Only the provider sees the prefixed one.
const WIRE_TOOL_NAMES: &[(&str, &str)] = &[("web_search", "luma_web_search")];

/// The name the provider sees for the catalog tool `name`.
fn wire_tool_name(name: &str) -> &str {
    WIRE_TOOL_NAMES
        .iter()
        .find(|(catalog, _)| *catalog == name)
        .map_or(name, |(_, wire)| wire)
}

/// The catalog tool the provider called as `name`.
fn catalog_tool_name(name: String) -> String {
    WIRE_TOOL_NAMES
        .iter()
        .find(|(_, wire)| *wire == name)
        .map_or(name, |(catalog, _)| (*catalog).to_owned())
}

/// `text` with every mention of a renamed tool given its wire name, so a
/// description that points the model at another tool names the one on offer.
fn wire_tool_text(text: &str) -> std::borrow::Cow<'_, str> {
    let in_a_name = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut text = std::borrow::Cow::Borrowed(text);
    for (catalog, wire) in WIRE_TOOL_NAMES {
        let bytes = text.as_bytes();
        let mut renamed = String::new();
        let mut copied = 0;
        for (at, _) in text.match_indices(catalog) {
            let end = at + catalog.len();
            // Part of a longer identifier is a different name.
            if (at > 0 && in_a_name(bytes[at - 1])) || bytes.get(end).is_some_and(|b| in_a_name(*b))
            {
                continue;
            }
            renamed.push_str(&text[copied..at]);
            renamed.push_str(wire);
            copied = end;
        }
        if copied > 0 {
            renamed.push_str(&text[copied..]);
            text = std::borrow::Cow::Owned(renamed);
        }
    }
    text
}

/// The provider's view of `tools`.
fn wire_tools(tools: &[ToolDef]) -> Vec<WireTool<'_>> {
    tools
        .iter()
        .map(|t| WireTool {
            r#type: "function",
            function: WireFn {
                name: wire_tool_name(&t.name),
                description: wire_tool_text(&t.description),
                parameters: &t.parameters,
            },
        })
        .collect()
}

// --- wire types for the OpenAI chat-completions API ---
#[derive(Serialize)]
struct ChatReq<'a> {
    model: &'a str,
    messages: Vec<WireMsg>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<WireTool<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// OpenRouter/OpenAI shape: `{"reasoning": {"effort": "low"}}`. Omitted
    /// entirely when unset, a provider that does not know the field rejects the
    /// whole request rather than ignoring it.
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<WireReasoning<'a>>,
}
#[derive(Serialize)]
struct WireReasoning<'a> {
    effort: &'a str,
}
#[derive(Serialize)]
pub(super) struct WireMsg {
    role: &'static str,
    content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<WireToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}
#[derive(Serialize)]
struct WireToolCall {
    id: String,
    r#type: &'static str,
    function: WireCall,
}
#[derive(Serialize)]
struct WireCall {
    name: String,
    arguments: String,
}

impl WireMsg {
    fn text(role: &'static str, content: String) -> Self {
        Self {
            role,
            content: Some(content),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
}

/// The chat-completions transcript for `messages`.
///
/// Each tool result goes back as the answer to the model's own call: an
/// assistant message carrying the call, then a `tool` message with the
/// observation. Sent as a user message, the result read as text the wearer
/// had pasted in. Live, the model doubted its own `ask_online` answer
/// ("doesn't reflect an actual tool call in this turn") and asked again: up
/// to three lookups for "What is the latest news in Denmark?", and 7 of 8
/// repeats of one such step, against none once the result answered its call.
/// Call ids are numbered per request, since Cosmos keeps no provider ids, as
/// nine letters and digits: Mistral's API and tokenizer (and so a self-hosted
/// Mistral) refuse any other id.
pub(super) fn wire_messages(messages: &[ChatMessage]) -> Vec<WireMsg> {
    let mut wire = Vec::with_capacity(messages.len() + 4);
    let mut index = 0;
    while let Some(message) = messages.get(index) {
        if let Some((call, observation, span)) = tool_exchange(&messages[index..]) {
            let id = format!("call{index:05}");
            wire.push(WireMsg {
                role: "assistant",
                content: None,
                tool_calls: vec![WireToolCall {
                    id: id.clone(),
                    r#type: "function",
                    function: WireCall {
                        name: wire_tool_name(&call.name).to_owned(),
                        arguments: call.arguments,
                    },
                }],
                tool_call_id: None,
            });
            wire.push(WireMsg {
                role: "tool",
                content: Some(observation),
                tool_calls: Vec::new(),
                tool_call_id: Some(id),
            });
            index += span;
            continue;
        }
        let role = match message.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            // Wearer memory, device state, and a replayed call whose result
            // was not replayed stay typed JSON data in a user message.
            Role::ToolResult | Role::Memory | Role::DeviceContext => "user",
        };
        wire.push(WireMsg::text(role, message.content.clone()));
        index += 1;
    }
    wire
}

/// The tool call and observation that start `messages`, and how many messages
/// they span: a result on its own, or a replayed call followed by its result.
fn tool_exchange(messages: &[ChatMessage]) -> Option<(ToolCall, String, usize)> {
    let envelope = |message: &ChatMessage| {
        (message.role == Role::ToolResult)
            .then(|| serde_json::from_str::<serde_json::Value>(&message.content).ok())
            .flatten()
    };
    let field = |value: &serde_json::Value, name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let first = envelope(messages.first()?)?;
    let name = field(&first, "tool")?;
    // The provider rejects a call to a name no function could have. A
    // replayed `Respond` is already the assistant's spoken text, so a device
    // observation of it is not the result of a call.
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || name == super::catalog::RESPOND_ACTION
    {
        return None;
    }
    let arguments = match first.get("arguments") {
        Some(value @ serde_json::Value::Object(_)) => value.to_string(),
        _ => "{}".to_owned(),
    };
    let (result, span) = match field(&first, "kind")?.as_str() {
        "untrusted_tool_result" => (first, 1),
        "prior_tool_call" => {
            let result = envelope(messages.get(1)?)?;
            (field(&result, "kind")?.as_str() == "untrusted_tool_result"
                && field(&result, "tool")? == name)
                .then_some((result, 2))?
        }
        _ => return None,
    };
    let observation = field(&result, "observation")?;
    Some((ToolCall { name, arguments }, observation, span))
}

#[derive(Serialize)]
struct WireTool<'a> {
    r#type: &'static str,
    function: WireFn<'a>,
}
#[derive(Serialize)]
struct WireFn<'a> {
    name: &'a str,
    description: std::borrow::Cow<'a, str>,
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
    /// Some OpenAI-compatible endpoints expose the model's rationale here. When
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
    /// the API key, the model id and the failure class only.
    fn failed(&self, kind: &'static str, error: LlmError) -> LlmError {
        crate::metrics::record_error(kind);
        tracing::warn!(kind, model = %self.model, %error, "model step failed");
        error
    }

    /// One model step's request.
    ///
    /// The shared vendor client ends every call at 8 s, body read included,
    /// which is a tool's bound, not a model step's. The step gets the whole
    /// [`MODEL_STEP_LIMIT`](super::runtime::MODEL_STEP_LIMIT) here, and the
    /// engine's per-step timeout, which also counts the run's remaining
    /// budget, stays the bound that actually ends it.
    fn request(&self, body: &ChatReq<'_>) -> reqwest::RequestBuilder {
        self.client
            .post(format!(
                "{}/chat/completions",
                self.base_url.trim_end_matches('/')
            ))
            .bearer_auth(&self.api_key)
            .timeout(super::runtime::MODEL_STEP_LIMIT)
            .json(body)
    }
}

#[tonic::async_trait]
impl ChatModel for OpenAiChatModel {
    fn provenance(&self) -> ModelProvenance {
        ModelProvenance {
            provider: "openai_compatible".to_owned(),
            model: self.model.clone(),
            speed: "standard".to_owned(),
            effort: self
                .reasoning_effort
                .clone()
                .unwrap_or_else(|| "provider_default".to_owned()),
        }
    }

    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        let msgs = wire_messages(messages);
        let body = ChatReq {
            model: &self.model,
            messages: msgs,
            tools: wire_tools(tools),
            tool_choice: explicit_playback_requires_tool(messages, tools).then_some("required"),
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
        // operator actually hits, a refused request and a body that will not
        // parse, with no counter and no log at all.
        let resp = self
            .request(&body)
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
            name: catalog_tool_name(tc.function.name),
            // Never let a non-object reach the device. See `normalize_arguments`.
            arguments: normalize_arguments(&tc.function.arguments),
        });
        let tool_call = calls.next();
        Ok(enforce_explicit_retrieval(
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
mod wire_tool_name_tests {
    use super::{
        ChatMessage, ToolDef, catalog_tool_name, wire_messages, wire_tool_name, wire_tool_text,
        wire_tools,
    };

    fn tool(name: &str, description: &str) -> ToolDef {
        ToolDef {
            name: name.to_owned(),
            description: description.to_owned(),
            parameters: serde_json::json!({ "type": "object", "properties": {} }),
        }
    }

    #[test]
    fn web_search_is_prefixed_for_the_provider_and_restored_from_its_call() {
        assert_eq!(wire_tool_name("web_search"), "luma_web_search");
        assert_eq!(
            catalog_tool_name("luma_web_search".to_owned()),
            "web_search"
        );
        for untouched in ["ask_online", "SetTimer", "mcp_bookmarks_search_bookmarks"] {
            assert_eq!(wire_tool_name(untouched), untouched);
            assert_eq!(catalog_tool_name(untouched.to_owned()), untouched);
        }
    }

    #[test]
    fn offered_tools_carry_the_wire_name_and_descriptions_point_at_it() {
        let tools = [
            tool("web_search", "Search raw web results."),
            tool("ask_online", "Do not precede it with web_search."),
        ];
        let wire = serde_json::to_value(wire_tools(&tools)).unwrap();
        assert_eq!(wire[0]["function"]["name"], "luma_web_search");
        assert_eq!(
            wire[0]["function"]["description"],
            "Search raw web results."
        );
        assert_eq!(wire[1]["function"]["name"], "ask_online");
        assert_eq!(
            wire[1]["function"]["description"],
            "Do not precede it with luma_web_search."
        );
    }

    #[test]
    fn only_a_whole_tool_name_is_rewritten_in_text() {
        assert_eq!(
            wire_tool_text("use web_search or ask_online, then web_search."),
            "use luma_web_search or ask_online, then luma_web_search."
        );
        for untouched in ["luma_web_search", "web_search_service", "a web search", ""] {
            assert_eq!(wire_tool_text(untouched), untouched);
        }
    }

    #[test]
    fn a_replayed_call_goes_back_under_the_name_the_provider_was_offered() {
        let wire = serde_json::to_value(wire_messages(&[ChatMessage::tool_result(
            "web_search",
            r#"{"query":"news"}"#,
            "headlines",
        )]))
        .unwrap();
        assert_eq!(
            wire[0]["tool_calls"][0]["function"]["name"],
            "luma_web_search"
        );
        assert_eq!(wire[1]["role"], "tool");
    }
}

#[cfg(test)]
mod os3_cancel_intent_tests {
    use super::{explicit_os3_request, os3_cancel_request};

    #[test]
    fn os3_cancel_request_accepts_only_exact_owner_commands() {
        for command in [
            "cancel OS3",
            "cancel OS3?",
            "Can you cancel OS3?",
            "Stop the OS3 task?",
            "Could you tell OS3 to stop the current task, please?",
            "stop OS3",
            "cancel the OS3 task",
            "stop the OS3 task",
            "OS3 cancel",
            "OS3 stop",
            "OS3, cancel!",
            "OS3: stop.",
            "tell OS3 to cancel",
            "tell OS3 to stop",
            "tell OS3 to cancel the task",
            "tell OS3 to stop the current task",
            "tell OS3 to cancel current task",
            "Please cancel OS3!",
            "Hey, tell OS3 to stop the current task, please.",
            "OK, OS3 stop please",
            "  CANCEL   OS3.  ",
        ] {
            assert!(
                os3_cancel_request(command),
                "exact cancellation: {command:?}"
            );
            assert!(
                explicit_os3_request(command),
                "first-tool D1 routing: {command:?}"
            );
        }
        for text in [
            "",
            "What does cancel OS3 mean?",
            "Should I cancel OS3?",
            "cancel? OS3",
            "tell OS3? to stop",
            "do not cancel OS3",
            "cancel OS3 if it is slow",
            "if it is slow cancel OS3",
            "cancel OS3 and search the web",
            "tell OS3 to stop then delete the file",
            "tell OS3 to cancel all tasks",
            "stop OS3's task",
            "cancel OS3X",
            "OS3X stop",
            "cancel my OS3 task",
            "I said cancel OS3",
            "\"cancel OS3\"",
            "‘OS3 stop’",
            "`cancel OS3`",
            "tell OS3 to cancel \"the task\"",
            "cancel OS3; stop Spotify",
            "cancel OS3\n",
            "stop OS3\t",
            "stop\nOS3",
            "OS3 cancel later",
        ] {
            assert!(
                !os3_cancel_request(text),
                "not an exact cancellation: {text:?}"
            );
        }
    }
}
