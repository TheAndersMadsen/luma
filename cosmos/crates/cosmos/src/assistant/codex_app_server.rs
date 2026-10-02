//! Small client for the official `codex app-server` stdio protocol.
//!
//! The app-server owns ChatGPT OAuth token storage and refresh. Cosmos owns the
//! process and exposes only redacted account state plus the device-code login
//! ceremony to Center.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Mutex, broadcast, oneshot};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const TURN_TIMEOUT: Duration = Duration::from_secs(24);

type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, CodexError>>>>>;

#[derive(Debug, thiserror::Error)]
pub enum CodexError {
    #[error("Codex app-server is not installed")]
    Unavailable,
    #[error("Codex app-server could not start")]
    Start,
    #[error("Codex app-server protocol failed")]
    Protocol,
    #[error("Codex app-server request timed out")]
    Timeout,
    #[error("Codex subscription is not connected")]
    NotConnected,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexAccountStatus {
    pub available: bool,
    pub connected: bool,
    pub plan: Option<String>,
    pub email: Option<String>,
}

impl CodexAccountStatus {
    fn unavailable() -> Self {
        Self {
            available: false,
            connected: false,
            plan: None,
            email: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexDeviceCode {
    pub login_id: String,
    pub verification_url: String,
    pub user_code: String,
    pub expires_in_seconds: u32,
}

#[derive(Debug, Deserialize)]
pub struct CodexModelOutput {
    pub content: Option<String>,
    #[serde(default)]
    pub thought: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<CodexToolCall>,
}

#[derive(Debug, Deserialize)]
pub struct CodexToolCall {
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_tool_arguments")]
    pub arguments: serde_json::Value,
}

fn deserialize_tool_arguments<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let encoded = String::deserialize(deserializer)?;
    let value = serde_json::from_str::<Value>(&encoded).map_err(serde::de::Error::custom)?;
    if !value.is_object() {
        return Err(serde::de::Error::custom(
            "tool arguments must encode an object",
        ));
    }
    Ok(value)
}

struct Connection {
    stdin: Mutex<ChildStdin>,
    pending: PendingRequests,
    events: broadcast::Sender<Value>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
}

impl Connection {
    async fn request(&self, method: &str, params: Value) -> Result<Value, CodexError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(CodexError::Protocol);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        self.pending.lock().await.insert(id, send);
        let line = serde_json::to_vec(&json!({ "method": method, "id": id, "params": params }))
            .map_err(|_| CodexError::Protocol)?;
        let write = async {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(&line)
                .await
                .map_err(|_| CodexError::Protocol)?;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|_| CodexError::Protocol)?;
            stdin.flush().await.map_err(|_| CodexError::Protocol)
        }
        .await;
        if write.is_err() {
            self.pending.lock().await.remove(&id);
            return write.map(|_| Value::Null);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receive).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CodexError::Protocol),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(CodexError::Timeout)
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), CodexError> {
        let line = serde_json::to_vec(&json!({ "method": method, "params": params }))
            .map_err(|_| CodexError::Protocol)?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&line)
            .await
            .map_err(|_| CodexError::Protocol)?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|_| CodexError::Protocol)?;
        stdin.flush().await.map_err(|_| CodexError::Protocol)
    }
}

struct CodexClient {
    connection: Mutex<Option<Arc<Connection>>>,
    binary: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

/// Owns one live app-server turn until its result has been consumed.
///
/// Cosmos may abandon a model future when the Pin's foreground deadline wins.
/// Dropping an ordinary future does not cancel work already started inside the
/// app server, so the old turn used to keep consuming the shared subscription
/// while the next wearer request began. Interrupt it explicitly and remove its
/// ephemeral thread whenever the caller drops us early.
struct ActiveTurn {
    connection: Arc<Connection>,
    thread_id: Option<String>,
    turn_id: String,
}

fn turn_interrupt_params(thread_id: &str, turn_id: &str) -> Value {
    json!({ "threadId": thread_id, "turnId": turn_id })
}

impl ActiveTurn {
    fn new(connection: Arc<Connection>, thread_id: String, turn_id: String) -> Self {
        Self {
            connection,
            thread_id: Some(thread_id),
            turn_id,
        }
    }

    fn disarm(&mut self) -> Option<String> {
        self.thread_id.take()
    }
}

impl Drop for ActiveTurn {
    fn drop(&mut self) {
        let Some(thread_id) = self.thread_id.take() else {
            return;
        };
        let turn_id = self.turn_id.clone();
        let connection = self.connection.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            let _ = connection
                .request(
                    "turn/interrupt",
                    turn_interrupt_params(&thread_id, &turn_id),
                )
                .await;
            let _ = connection
                .request("thread/delete", json!({ "threadId": thread_id }))
                .await;
        });
    }
}

impl CodexClient {
    fn configured() -> Self {
        let state = std::env::var("COSMOS_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/var/lib/cosmos"));
        Self {
            connection: Mutex::new(None),
            binary: std::env::var("COSMOS_CODEX_BIN")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("/opt/codex/bin/codex")),
            home: state.join("codex"),
            workspace: state.join("codex-workspace"),
        }
    }

    fn available(&self) -> bool {
        self.binary.is_file()
    }

    async fn connection(&self) -> Result<Arc<Connection>, CodexError> {
        let mut guard = self.connection.lock().await;
        if let Some(connection) = guard.as_ref()
            && !connection.closed.load(Ordering::Acquire)
        {
            return Ok(connection.clone());
        }
        let connection = self.start().await?;
        *guard = Some(connection.clone());
        Ok(connection)
    }

    async fn start(&self) -> Result<Arc<Connection>, CodexError> {
        if !self.available() {
            return Err(CodexError::Unavailable);
        }
        std::fs::create_dir_all(&self.home).map_err(|_| CodexError::Start)?;
        std::fs::create_dir_all(&self.workspace).map_err(|_| CodexError::Start)?;
        let mut child = Command::new(&self.binary)
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .env("CODEX_HOME", &self.home)
            .env("HOME", &self.home)
            .current_dir(&self.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| CodexError::Start)?;
        let stdin = child.stdin.take().ok_or(CodexError::Start)?;
        let stdout = child.stdout.take().ok_or(CodexError::Start)?;
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(256);
        let closed = Arc::new(AtomicBool::new(false));
        let connection = Arc::new(Connection {
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            events: events.clone(),
            next_id: AtomicU64::new(1),
            closed: closed.clone(),
        });

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let response_id = message
                    .get("id")
                    .and_then(Value::as_u64)
                    .filter(|_| message.get("method").is_none());
                if let Some(id) = response_id
                    && let Some(waiter) = pending.lock().await.remove(&id)
                {
                    let result = message.get("result").cloned().ok_or(CodexError::Protocol);
                    let _ = waiter.send(result);
                    continue;
                }
                let _ = events.send(message);
            }
            closed.store(true, Ordering::Release);
            for (_, waiter) in pending.lock().await.drain() {
                let _ = waiter.send(Err(CodexError::Protocol));
            }
            let _ = child.wait().await;
        });

        connection
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "luma",
                        "title": "Luma",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": false,
                        "requestAttestation": false,
                        "optOutNotificationMethods": ["item/agentMessage/delta"]
                    }
                }),
            )
            .await?;
        connection.notify("initialized", json!({})).await?;
        Ok(connection)
    }
}

static CLIENT: OnceLock<CodexClient> = OnceLock::new();

fn client() -> &'static CodexClient {
    CLIENT.get_or_init(CodexClient::configured)
}

pub async fn account_status() -> CodexAccountStatus {
    if !client().available() {
        return CodexAccountStatus::unavailable();
    }
    let Ok(connection) = client().connection().await else {
        return CodexAccountStatus {
            available: true,
            connected: false,
            plan: None,
            email: None,
        };
    };
    let Ok(result) = connection
        .request("account/read", json!({ "refreshToken": false }))
        .await
    else {
        return CodexAccountStatus {
            available: true,
            connected: false,
            plan: None,
            email: None,
        };
    };
    let account = result.get("account");
    let connected = account
        .and_then(|account| account.get("type"))
        .and_then(Value::as_str)
        == Some("chatgpt");
    CodexAccountStatus {
        available: true,
        connected,
        plan: account
            .and_then(|account| account.get("planType"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        email: account
            .and_then(|account| account.get("email"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

pub async fn start_device_login() -> Result<CodexDeviceCode, CodexError> {
    let result = client()
        .connection()
        .await?
        .request(
            "account/login/start",
            json!({ "type": "chatgptDeviceCode" }),
        )
        .await?;
    Ok(CodexDeviceCode {
        login_id: string_field(&result, "loginId")?,
        verification_url: string_field(&result, "verificationUrl")?,
        user_code: string_field(&result, "userCode")?,
        expires_in_seconds: 900,
    })
}

pub async fn logout() -> Result<(), CodexError> {
    client()
        .connection()
        .await?
        .request("account/logout", json!({}))
        .await
        .map(|_| ())
}

fn thread_start_params(model: &str, fast_mode: bool, cwd: &str) -> Value {
    let mut params = json!({
        "model": model,
        "cwd": cwd,
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "serviceName": "luma",
        "ephemeral": true
    });
    if fast_mode {
        params["serviceTier"] = Value::String("fast".to_owned());
    }
    params
}

struct TurnInput<'a> {
    prompt: String,
    image_urls: &'a [String],
    require_tool: bool,
}

fn turn_start_params(
    thread_id: &str,
    model: &str,
    effort: Option<&str>,
    fast_mode: bool,
    input: TurnInput<'_>,
    cwd: &str,
) -> Value {
    let mut output_schema = json!({
        "type": "object",
        "properties": {
            "content": { "type": ["string", "null"] },
            "thought": { "type": ["string", "null"] },
            "tool_calls": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "arguments": { "type": "string" }
                    },
                    "required": ["name", "arguments"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["content", "thought", "tool_calls"],
        "additionalProperties": false
    });
    if input.require_tool {
        output_schema["properties"]["tool_calls"]["minItems"] = Value::from(1);
    }
    let mut items = vec![json!({ "type": "text", "text": input.prompt, "text_elements": [] })];
    items.extend(
        input
            .image_urls
            .iter()
            .map(|url| json!({ "type": "image", "url": url, "detail": "low" })),
    );
    let mut params = json!({
        "threadId": thread_id,
        "input": items,
        "cwd": cwd,
        "approvalPolicy": "never",
        "sandboxPolicy": { "type": "externalSandbox", "networkAccess": "restricted" },
        "model": model,
        "outputSchema": output_schema
    });
    if let Some(effort) = effort {
        params["effort"] = Value::String(effort.to_owned());
    }
    if fast_mode {
        params["serviceTier"] = Value::String("fast".to_owned());
    }
    params
}

pub async fn complete(
    model: &str,
    effort: Option<&str>,
    fast_mode: bool,
    prompt: String,
    require_tool: bool,
) -> Result<CodexModelOutput, CodexError> {
    complete_with_images(model, effort, fast_mode, prompt, &[], require_tool).await
}

pub async fn complete_with_images(
    model: &str,
    effort: Option<&str>,
    fast_mode: bool,
    prompt: String,
    image_urls: &[String],
    require_tool: bool,
) -> Result<CodexModelOutput, CodexError> {
    if !account_status().await.connected {
        return Err(CodexError::NotConnected);
    }
    let connection = client().connection().await?;
    let mut events = connection.events.subscribe();
    let cwd = client().workspace.to_string_lossy();
    let thread = connection
        .request("thread/start", thread_start_params(model, fast_mode, &cwd))
        .await?;
    let thread_id = thread
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or(CodexError::Protocol)?
        .to_owned();
    let turn_params = turn_start_params(
        thread_id.as_str(),
        model,
        effort,
        fast_mode,
        TurnInput {
            prompt,
            image_urls,
            require_tool,
        },
        &cwd,
    );
    let turn = connection.request("turn/start", turn_params).await?;
    let turn_id = turn
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .ok_or(CodexError::Protocol)?
        .to_owned();
    let mut active_turn = ActiveTurn::new(connection.clone(), thread_id.clone(), turn_id.clone());

    let result = tokio::time::timeout(TURN_TIMEOUT, async {
        let mut final_text = None;
        loop {
            let event = events.recv().await.map_err(|_| CodexError::Protocol)?;
            let method = event.get("method").and_then(Value::as_str);
            if method == Some("item/completed")
                && event.pointer("/params/threadId").and_then(Value::as_str)
                    == Some(thread_id.as_str())
                && event.pointer("/params/turnId").and_then(Value::as_str) == Some(turn_id.as_str())
                && event.pointer("/params/item/type").and_then(Value::as_str)
                    == Some("agentMessage")
            {
                if let Some(text) = event.pointer("/params/item/text").and_then(Value::as_str) {
                    final_text = Some(text.to_owned());
                }
            }
            if method == Some("turn/completed")
                && event.pointer("/params/turn/id").and_then(Value::as_str)
                    == Some(turn_id.as_str())
            {
                let status = event.pointer("/params/turn/status").and_then(Value::as_str);
                if status != Some("completed") {
                    return Err(CodexError::Protocol);
                }
                return parse_model_output(final_text.as_deref().ok_or(CodexError::Protocol)?);
            }
        }
    })
    .await
    .map_err(|_| CodexError::Timeout)?;

    // Each LLM step carries its complete transcript, so its Codex thread has no
    // durable product value. Delete it after extracting the final message.
    if let Some(thread_id) = active_turn.disarm() {
        let _ = connection
            .request("thread/delete", json!({ "threadId": thread_id }))
            .await;
    }
    result
}

fn string_field(value: &Value, name: &str) -> Result<String, CodexError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(CodexError::Protocol)
}

fn parse_model_output(text: &str) -> Result<CodexModelOutput, CodexError> {
    serde_json::from_str(text.trim()).map_err(|_| CodexError::Protocol)
}
