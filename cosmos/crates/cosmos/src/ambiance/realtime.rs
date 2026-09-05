//! One fresh, text-only GA Realtime session per admitted runtime turn.
//! This adapter proposes information; it never executes a tool or proves playback.
//! The socket is owned by the completion future, including during handshake:
//! cancellation drops it without detached readers, retries, or late proposals.
//! Transport drop is not an acknowledged provider cancellation or billing stop.
//! GA protocol: https://developers.openai.com/api/docs/guides/realtime-websocket
//! and https://developers.openai.com/api/reference/resources/realtime/server-events.
use std::{collections::HashSet, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        Message, client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
    },
};

use crate::{
    assistant::llm::{
        ChatMessage, ChatModel, ChatResponse, LlmError, ModelProvenance, Role, ToolCall, ToolDef,
    },
    integrations::RealtimeConfig,
};

const MAX_EVENT: usize = 64 * 1024;
const MAX_TOTAL: usize = 512 * 1024;
const MAX_EVENTS: usize = 1024;
const MAX_ARGUMENTS: usize = 16 * 1024;
const DEADLINE: Duration = Duration::from_secs(18);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Default)]
pub struct ConfiguredRealtimeModel;

impl ConfiguredRealtimeModel {
    pub fn new() -> Self {
        Self
    }
}

fn provenance(config: &RealtimeConfig) -> ModelProvenance {
    ModelProvenance {
        provider: "openai_realtime".into(),
        model: if config.configured() {
            config.model.clone()
        } else {
            "unconfigured".into()
        },
        speed: "realtime".into(),
        effort: "default".into(),
    }
}

#[tonic::async_trait]
impl ChatModel for ConfiguredRealtimeModel {
    fn provenance(&self) -> ModelProvenance {
        provenance(&crate::integrations::active().snapshot().realtime)
    }

    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        OpenAiRealtimeModel::new(crate::integrations::active().snapshot().realtime)?
            .complete(messages, tools)
            .await
    }
}

// Deliberately no Debug: configuration contains a provider credential.
pub struct OpenAiRealtimeModel {
    config: RealtimeConfig,
}

impl OpenAiRealtimeModel {
    pub fn new(config: RealtimeConfig) -> Result<Self, LlmError> {
        if !config.configured() {
            return Err(transport("realtime is not configured"));
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
        validate_input(messages, tools)?;
        tokio::time::timeout(deadline, async {
            let mut request = endpoint.into_client_request().map_err(|_| LlmError::Malformed)?;
            let mut auth = HeaderValue::from_str(&format!("Bearer {}", self.config.api_key.as_deref().unwrap_or_default()))
                .map_err(|_| LlmError::Malformed)?;
            auth.set_sensitive(true);
            request.headers_mut().insert("Authorization", auth);
            let limits = WebSocketConfig::default().read_buffer_size(4096).write_buffer_size(0)
                .max_write_buffer_size(MAX_EVENT * 2).max_message_size(Some(MAX_EVENT)).max_frame_size(Some(MAX_EVENT));
            let (mut socket, _) = connect_async_with_config(request, Some(limits), true).await
                .map_err(|_| transport("realtime connection failed"))?;
            let expected = session(&messages[0].content, &tools[0], self.config.max_output_tokens);
            send(&mut socket, json!({"type":"session.update","session":expected})).await?;
            let mut budget = Budget::default();
            let created = budget.next(&mut socket).await?;
            if created["type"] != "session.created" { return Err(LlmError::Malformed); }
            let session_id = identifier(&created["session"]["id"])?;
            let updated = budget.next(&mut socket).await?;
            if updated["type"] != "session.updated" || identifier(&updated["session"]["id"])? != session_id
                || !effective_session(&updated["session"], &expected) { return Err(LlmError::Malformed); }
            let user_id = format!("item_{}", uuid::Uuid::new_v4().simple());
            send(&mut socket, json!({"type":"conversation.item.create","item":{"id":user_id,"type":"message","role":"user","content":[{"type":"input_text","text":messages[1].content}]}})).await?;
            send(&mut socket, json!({"type":"response.create","response":{"output_modalities":["text"]}})).await?;
            let mut response = ResponseState::default();
            loop {
                let event = budget.next(&mut socket).await?;
                if let Some(call) = response.accept(&event, &tools[0].name, &user_id)? {
                    // Dropping the owned connection is intentional; no close handshake can
                    // extend this turn or keep a background task alive after cancellation.
                    return Ok(ChatResponse { tool_call: Some(call), ..Default::default() });
                }
            }
        }).await.map_err(|_| transport("realtime deadline exceeded"))?
    }
}

#[tonic::async_trait]
impl ChatModel for OpenAiRealtimeModel {
    fn provenance(&self) -> ModelProvenance {
        provenance(&self.config)
    }
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        let mut url = reqwest::Url::parse("wss://api.openai.com/v1/realtime")
            .map_err(|_| LlmError::Malformed)?;
        url.query_pairs_mut()
            .append_pair("model", &self.config.model);
        self.exchange(url.as_str(), messages, tools, DEADLINE).await
    }
}

fn transport(message: &'static str) -> LlmError {
    LlmError::Transport(message.into())
}

fn validate_input(messages: &[ChatMessage], tools: &[ToolDef]) -> Result<(), LlmError> {
    if messages.len() != 2
        || messages[0].role != Role::System
        || messages[1].role != Role::User
        || messages[0].content.is_empty()
        || messages[0].content.len() > 8192
        || messages[1].content.trim().is_empty()
        || messages[1].content.len() > 4000
        || tools.len() != 1
        || tools[0].name != "propose_information"
        || tools[0].description.len() > 4096
        || !tools[0].parameters.is_object()
        || tools[0].parameters.to_string().len() > 16 * 1024
    {
        return Err(LlmError::Malformed);
    }
    Ok(())
}

fn session(instructions: &str, tool: &ToolDef, tokens: u32) -> Value {
    json!({"type":"realtime","output_modalities":["text"],"instructions":instructions,
        "audio":{"input":{"turn_detection":null}},"tracing":null,"max_output_tokens":tokens,
        "tools":[{"type":"function","name":tool.name,"description":tool.description,"parameters":tool.parameters}],
        "tool_choice":{"type":"function","name":tool.name}})
}

// These effective fields are a local fail-closed policy, not a claim that every
// optional GA field must be echoed. Model aliases need not echo verbatim.
fn effective_session(actual: &Value, expected: &Value) -> bool {
    [
        "type",
        "output_modalities",
        "instructions",
        "max_output_tokens",
        "tool_choice",
    ]
    .iter()
    .all(|key| actual.get(key) == expected.get(key))
        && actual.get("tracing").is_none_or(Value::is_null)
        && actual
            .pointer("/audio/input/turn_detection")
            .is_none_or(Value::is_null)
        && actual["tools"].as_array().is_some_and(|tools| {
            tools.len() == 1
                && ["type", "name", "description", "parameters"]
                    .iter()
                    .all(|key| tools[0].get(key) == expected["tools"][0].get(key))
        })
}

async fn send(socket: &mut Socket, event: Value) -> Result<(), LlmError> {
    let text = event.to_string();
    if text.len() > MAX_EVENT {
        return Err(LlmError::Malformed);
    }
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| transport("realtime write failed"))
}

#[derive(Default)]
struct Budget {
    bytes: usize,
    events: usize,
    ids: HashSet<String>,
}
impl Budget {
    async fn next(&mut self, socket: &mut Socket) -> Result<Value, LlmError> {
        loop {
            let frame = socket
                .next()
                .await
                .ok_or_else(|| transport("realtime disconnected"))?
                .map_err(|_| transport("realtime read failed"))?;
            self.events += 1;
            self.bytes = self.bytes.saturating_add(frame.len());
            if self.events > MAX_EVENTS || self.bytes > MAX_TOTAL {
                return Err(LlmError::Malformed);
            }
            match frame {
                Message::Text(text) => {
                    let event: Value =
                        serde_json::from_str(&text).map_err(|_| LlmError::Malformed)?;
                    let id = identifier(&event["event_id"])?;
                    if !self.ids.insert(id) || !event["type"].is_string() {
                        return Err(LlmError::Malformed);
                    }
                    if event["type"] == "error" {
                        return Err(transport("realtime provider rejected request"));
                    }
                    return Ok(event);
                }
                Message::Ping(_) => socket
                    .flush()
                    .await
                    .map_err(|_| transport("realtime write failed"))?,
                Message::Pong(_) => {}
                _ => return Err(transport("realtime disconnected")),
            }
        }
    }
}

fn identifier(value: &Value) -> Result<String, LlmError> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .map(str::to_owned)
        .ok_or(LlmError::Malformed)
}

#[derive(Default)]
struct ResponseState {
    id: Option<String>,
    item: Option<String>,
    call: Option<String>,
    mirror: Option<(String, String)>,
    deltas: String,
    arguments: Option<String>,
    item_done: bool,
}
impl ResponseState {
    fn accept(
        &mut self,
        event: &Value,
        name: &str,
        user_id: &str,
    ) -> Result<Option<ToolCall>, LlmError> {
        let kind = event["type"].as_str().ok_or(LlmError::Malformed)?;
        if kind == "response.created" {
            if self.id.is_some() || event["response"]["status"] != "in_progress" {
                return Err(LlmError::Malformed);
            }
            self.id = Some(identifier(&event["response"]["id"])?);
            return Ok(None);
        }
        if kind == "rate_limits.updated" {
            return Ok(None);
        }
        if matches!(
            kind,
            "conversation.item.added" | "conversation.item.done" | "conversation.item.created"
        ) {
            let item = &event["item"];
            // Mirrors can precede output_item.added. Remember their identity,
            // but never treat their status or arguments as completion authority.
            if item["id"] == user_id && item["type"] == "message" && item["role"] == "user" {
                return Ok(None);
            }
            if item["type"] == "function_call" && item["name"] == name {
                let pair = (identifier(&item["id"])?, identifier(&item["call_id"])?);
                if self
                    .mirror
                    .as_ref()
                    .is_some_and(|previous| previous != &pair)
                    || self.item.as_ref().is_some_and(|id| id != &pair.0)
                    || self.call.as_ref().is_some_and(|id| id != &pair.1)
                {
                    return Err(LlmError::Malformed);
                }
                self.mirror = Some(pair);
                return Ok(None);
            }
            return Err(LlmError::Malformed);
        }
        let id = self.id.as_deref().ok_or(LlmError::Malformed)?;
        if kind == "response.done" {
            let response = &event["response"];
            if response["id"] != id || response["status"] != "completed" || !self.item_done {
                return Err(LlmError::Malformed);
            }
            let output = response["output"]
                .as_array()
                .filter(|items| items.len() == 1)
                .ok_or(LlmError::Malformed)?;
            self.check_item(&output[0], name)?;
            let args = self.arguments.as_ref().ok_or(LlmError::Malformed)?;
            if output[0]["arguments"] != *args {
                return Err(LlmError::Malformed);
            }
            let value: Value = serde_json::from_str(args).map_err(|_| LlmError::Malformed)?;
            if !value.is_object() {
                return Err(LlmError::Malformed);
            }
            return Ok(Some(ToolCall {
                name: name.into(),
                arguments: args.clone(),
            }));
        }
        if event["response_id"] != id || event["output_index"] != 0 {
            return Err(LlmError::Malformed);
        }
        match kind {
            "response.output_item.added" => {
                let item = &event["item"];
                if self.item.is_some() || item["type"] != "function_call" || item["name"] != name {
                    return Err(LlmError::Malformed);
                }
                self.item = Some(identifier(&item["id"])?);
                self.call = Some(identifier(&item["call_id"])?);
                if self.mirror.as_ref().is_some_and(|pair| {
                    self.item.as_ref() != Some(&pair.0) || self.call.as_ref() != Some(&pair.1)
                }) {
                    return Err(LlmError::Malformed);
                }
            }
            "response.function_call_arguments.delta" => {
                if self.arguments.is_some()
                    || event["item_id"] != self.item.as_deref().ok_or(LlmError::Malformed)?
                {
                    return Err(LlmError::Malformed);
                }
                if let Some(call) = event.get("call_id") {
                    if Some(call.as_str().ok_or(LlmError::Malformed)?) != self.call.as_deref() {
                        return Err(LlmError::Malformed);
                    }
                }
                let delta = event["delta"].as_str().ok_or(LlmError::Malformed)?;
                if self.deltas.len() + delta.len() > MAX_ARGUMENTS {
                    return Err(LlmError::Malformed);
                }
                self.deltas.push_str(delta);
            }
            "response.function_call_arguments.done" => {
                if self.arguments.is_some()
                    || event["item_id"] != self.item.as_deref().ok_or(LlmError::Malformed)?
                    || event["call_id"] != self.call.as_deref().ok_or(LlmError::Malformed)?
                    || event["name"] != name
                {
                    return Err(LlmError::Malformed);
                }
                let args = event["arguments"].as_str().ok_or(LlmError::Malformed)?;
                if args.len() > MAX_ARGUMENTS || (!self.deltas.is_empty() && self.deltas != args) {
                    return Err(LlmError::Malformed);
                }
                self.arguments = Some(args.into());
            }
            "response.output_item.done" => {
                if self.item_done {
                    return Err(LlmError::Malformed);
                }
                self.check_item(&event["item"], name)?;
                if event["item"]["arguments"]
                    != *self.arguments.as_ref().ok_or(LlmError::Malformed)?
                {
                    return Err(LlmError::Malformed);
                }
                self.item_done = true;
            }
            _ => return Err(LlmError::Malformed),
        }
        Ok(None)
    }

    fn check_item(&self, item: &Value, name: &str) -> Result<(), LlmError> {
        if item["type"] != "function_call"
            || item["name"] != name
            || item["id"] != self.item.as_deref().ok_or(LlmError::Malformed)?
            || item["call_id"] != self.call.as_deref().ok_or(LlmError::Malformed)?
            || item
                .get("status")
                .is_some_and(|status| status != "completed")
        {
            return Err(LlmError::Malformed);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{net::TcpListener, sync::oneshot};

    fn model() -> OpenAiRealtimeModel {
        OpenAiRealtimeModel::new(RealtimeConfig {
            api_key: Some("synthetic-key".into()),
            model: "gpt-realtime".into(),
            max_output_tokens: 1024,
        })
        .unwrap()
    }
    fn input() -> ([ChatMessage; 2], [ToolDef; 1]) {
        (
            [
                ChatMessage::system("Runtime instructions only"),
                ChatMessage::user("Current text"),
            ],
            [ToolDef {
                name: "propose_information".into(),
                description: "Proposal only".into(),
                parameters: json!({"type":"object"}),
            }],
        )
    }
    fn output(status: &str) -> Vec<Value> {
        let args = r#"{"intent":{"kind":"visual_text_card","text":"Hello"},"privacy":"public"}"#;
        let item = json!({"id":"item_result","type":"function_call","call_id":"call_one","name":"propose_information","arguments":args});
        vec![
            json!({"type":"response.created","response":{"id":"resp_one","status":"in_progress"}}),
            json!({"type":"response.output_item.added","response_id":"resp_one","output_index":0,"item":{"id":"item_result","type":"function_call","call_id":"call_one","name":"propose_information","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","response_id":"resp_one","output_index":0,"item_id":"item_result","delta":args}),
            json!({"type":"response.function_call_arguments.done","response_id":"resp_one","output_index":0,"item_id":"item_result","call_id":"call_one","name":"propose_information","arguments":args}),
            json!({"type":"response.output_item.done","response_id":"resp_one","output_index":0,"item":item}),
            json!({"type":"response.done","response":{"id":"resp_one","status":status,"output":[item]}}),
        ]
    }
    async fn fixture(
        events: Vec<Value>,
        bad_config: bool,
        stall: bool,
    ) -> (String, oneshot::Receiver<()>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "ws://{}/v1/realtime?model=gpt-realtime",
            listener.local_addr().unwrap()
        );
        let (ready_tx, ready_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                stream,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.headers()["authorization"], "Bearer synthetic-key");
                    assert!(!request.headers().contains_key("openai-beta"));
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let update: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(update["type"], "session.update");
            assert_eq!(update["session"]["type"], "realtime");
            assert_eq!(update["session"]["output_modalities"], json!(["text"]));
            assert_eq!(update["session"]["tracing"], Value::Null);
            assert_eq!(update["session"]["max_output_tokens"], 1024);
            assert!(
                update["session"]
                    .get("max_response_output_tokens")
                    .is_none()
            );
            assert_eq!(
                update["session"]["audio"]["input"]["turn_detection"],
                Value::Null
            );
            assert_eq!(
                update["session"]["tool_choice"],
                json!({"type":"function","name":"propose_information"})
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(10), ws.next())
                    .await
                    .is_err(),
                "input leaked before session.updated"
            );
            ws.send(Message::Text(
                json!({"type":"session.created","event_id":"created","session":{"id":"sess_one"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            let mut effective = update["session"].clone();
            effective["id"] = json!("sess_one");
            // A resolved alias and optional extra effective fields are legitimate.
            effective["model"] = json!("gpt-realtime-resolved");
            if bad_config {
                effective["tracing"] = json!("auto");
            }
            ws.send(Message::Text(
                json!({"type":"session.updated","event_id":"updated","session":effective})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            if !bad_config {
                let user: Value =
                    serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(
                    user["item"]["content"],
                    json!([{"type":"input_text","text":"Current text"}])
                );
                let response: Value =
                    serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(
                    response,
                    json!({"type":"response.create","response":{"output_modalities":["text"]}})
                );
                for (i, mut event) in events.into_iter().enumerate() {
                    if event.get("event_id").is_none() {
                        event["event_id"] = json!(format!("e{i}"));
                    }
                    if ws
                        .send(Message::Text(event.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            let _ = ready_tx.send(());
            if stall {
                // A cancelled completion must release its transport without a reader task.
                let next = tokio::time::timeout(Duration::from_secs(2), ws.next())
                    .await
                    .unwrap();
                assert!(matches!(
                    next,
                    None | Some(Err(_)) | Some(Ok(Message::Close(_)))
                ));
            }
        });
        (endpoint, ready_rx, task)
    }

    #[tokio::test]
    async fn realtime_ga_completed_single_call_only() {
        let (messages, tools) = input();
        let (url, _, task) = fixture(output("completed"), false, false).await;
        let result = model()
            .exchange(&url, &messages, &tools, DEADLINE)
            .await
            .unwrap();
        assert!(result.content.is_none() && result.extra_tool_calls.is_empty());
        assert_eq!(result.tool_call.unwrap().name, "propose_information");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn realtime_rejects_noncompleted_and_intermediate_done() {
        let (messages, tools) = input();
        for status in ["cancelled", "failed", "incomplete"] {
            let (url, _, task) = fixture(output(status), false, false).await;
            assert!(
                model()
                    .exchange(&url, &messages, &tools, DEADLINE)
                    .await
                    .is_err()
            );
            task.await.unwrap();
        }
        let mut events = output("completed");
        events.pop();
        let (url, _, task) = fixture(events, false, true).await;
        assert!(
            model()
                .exchange(&url, &messages, &tools, Duration::from_millis(100))
                .await
                .is_err()
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn realtime_rejects_wrong_ids_multiple_calls_duplicates_and_json() {
        let (messages, tools) = input();
        let mut cases = Vec::new();
        for field in ["id", "call_id", "name"] {
            let mut events = output("completed");
            events[5]["response"]["output"][0][field] = json!("wrong");
            cases.push(events);
        }
        let mut events = output("completed");
        events[5]["response"]["id"] = json!("other_response");
        cases.push(events);
        let mut events = output("completed");
        events[5]["response"]["output"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"function_call"}));
        cases.push(events);
        let mut events = output("completed");
        events.insert(4, events[3].clone());
        cases.push(events);
        let mut events = output("completed");
        events[1]["event_id"] = json!("duplicate");
        events[2]["event_id"] = json!("duplicate");
        cases.push(events);
        let mut events = output("completed");
        events[2]["delta"] = json!("not-json");
        events[3]["arguments"] = json!("not-json");
        events[4]["item"]["arguments"] = json!("not-json");
        events[5]["response"]["output"][0]["arguments"] = json!("not-json");
        cases.push(events);
        for events in cases {
            let (url, _, task) = fixture(events, false, false).await;
            assert!(
                model()
                    .exchange(&url, &messages, &tools, DEADLINE)
                    .await
                    .is_err()
            );
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn realtime_config_barrier_oversize_disconnect_and_cancellation() {
        let (messages, tools) = input();
        for (events, bad) in [
            (Vec::new(), true),
            (Vec::new(), false),
            (
                vec![json!({"type":"rate_limits.updated","data":"x".repeat(MAX_EVENT + 1)})],
                false,
            ),
        ] {
            let (url, _, task) = fixture(events, bad, false).await;
            assert!(
                model()
                    .exchange(&url, &messages, &tools, DEADLINE)
                    .await
                    .is_err()
            );
            task.await.unwrap();
        }
        let (url, ready, server) = fixture(Vec::new(), false, true).await;
        let client =
            tokio::spawn(async move { model().exchange(&url, &messages, &tools, DEADLINE).await });
        ready.await.unwrap();
        client.abort();
        assert!(client.await.unwrap_err().is_cancelled());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn realtime_rejects_history_and_missing_configuration_without_network() {
        assert!(OpenAiRealtimeModel::new(RealtimeConfig::default()).is_err());
        let (mut messages, tools) = input();
        messages[0] = ChatMessage::memory("private data");
        assert!(
            model()
                .exchange("not an endpoint", &messages, &tools, DEADLINE)
                .await
                .is_err()
        );
        let (messages, tools) = input();
        let mut history = messages.to_vec();
        history.push(ChatMessage::assistant("old text"));
        assert!(
            model()
                .exchange("not an endpoint", &history, &tools, DEADLINE)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn realtime_accepts_early_mirror_and_optional_ack_fields() {
        let (messages, tools) = input();
        let mut expected = session(&messages[0].content, &tools[0], 1024);
        let request = expected.clone();
        expected.as_object_mut().unwrap().remove("tracing");
        expected.as_object_mut().unwrap().remove("audio");
        assert!(effective_session(&expected, &request));
        expected["audio"] = json!({"input":{"turn_detection":{"type":"server_vad"}}});
        assert!(!effective_session(&expected, &request));
        let mut events = output("completed");
        let mirror = json!({"type":"conversation.item.added","item":events[1]["item"].clone()});
        events[1]["item"]["arguments"] = json!("{}");
        events.insert(0, mirror);
        let (url, _, task) = fixture(events, false, false).await;
        assert!(
            model()
                .exchange(&url, &messages, &tools, DEADLINE)
                .await
                .is_ok()
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn realtime_total_event_and_argument_limits_and_redacted_errors() {
        let (messages, tools) = input();
        let mut oversized_args = output("completed");
        oversized_args[2]["delta"] = json!("x".repeat(MAX_ARGUMENTS + 1));
        let cases = [
            vec![json!({"type":"rate_limits.updated"}); MAX_EVENTS + 1],
            vec![json!({"type":"rate_limits.updated","data":"x".repeat(32 * 1024)}); 17],
            oversized_args,
            vec![json!({"type":"error","error":{"message":"synthetic-provider-secret"}})],
        ];
        for events in cases {
            let (url, _, task) = fixture(events, false, false).await;
            let error = model()
                .exchange(&url, &messages, &tools, DEADLINE)
                .await
                .unwrap_err();
            assert!(!error.to_string().contains("synthetic"));
            task.await.unwrap();
        }
    }
}
