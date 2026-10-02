use std::collections::HashMap;
use std::sync::Arc;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac as _};
use rand::TryRng as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, RwLock};
use tracing::{info, warn};
use uuid::Uuid;

const BRIDGE_ADDR: &str = "127.0.0.1:16790";
const REQUEST_TTL_MS: u64 = 60 * 60 * 1000;
const MAX_STORED_REQUESTS: usize = 256;
const MAX_EVENTS_PER_REQUEST: usize = 32;
const AUTH_TOKEN_ENV: &str = "PENUMBRA_ESIM_BRIDGE_TOKEN";
const AUTH_TOKEN_CHARS: usize = 64;
const AUTH_NONCE_BYTES: usize = 32;
const AUTH_NONCE_CHARS: usize = 43;
const AUTH_PROOF_BYTES: usize = 32;
const AUTH_PROOF_CHARS: usize = 43;
const MAX_AUTH_LINE_BYTES: usize = 512;
const MAX_BRIDGE_LINE_BYTES: usize = 256 * 1024;
const AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const REQUEST_ACCEPTANCE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const AUTH_CHANNEL: &str = "control";
const CLIENT_AUTH_DOMAIN: &[u8] = b"penumbra/esim-bridge/control/client/v1\0";
const SERVER_AUTH_DOMAIN: &[u8] = b"penumbra/esim-bridge/control/server/v1\0";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize)]
pub struct EsimRequestRecord {
    pub request_id: String,
    pub action: String,
    pub status: String,
    pub accepted: bool,
    pub events: Vec<Value>,
    pub final_event: Option<Value>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EsimSnapshot {
    pub connected: bool,
    pub requests: Vec<EsimRequestRecord>,
}

#[derive(Debug, Clone)]
pub enum EsimRequestError {
    BridgeError {
        event: Value,
    },
    Timeout {
        request_id: String,
    },
    Internal {
        request_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone)]
pub enum CellularStatusError {
    BridgeError(Value),
    Timeout { request_id: String },
    Internal(String),
}

#[derive(Debug, Clone)]
pub enum DeviceToggleError {
    BridgeError(Value),
    Timeout { request_id: String },
    Internal(String),
}

/// The authenticated Android control bridge uses the same failure envelope
/// for device toggles and the narrow stock-experience test actions.
pub type DeviceActionError = DeviceToggleError;

#[derive(Clone)]
pub struct EsimBridge {
    state: Arc<BridgeState>,
}

struct BridgeState {
    connected: RwLock<bool>,
    requests: Mutex<HashMap<String, EsimRequestRecord>>,
    active_esim_request: Mutex<Option<EsimOperationBinding>>,
    acceptance_waiters: Mutex<HashMap<String, oneshot::Receiver<Result<(), String>>>>,
    command_tx: mpsc::UnboundedSender<OutboundMessage>,
    events_tx: broadcast::Sender<Value>,
}

struct OutboundMessage {
    body: Value,
    accepted_tx: Option<oneshot::Sender<Result<(), String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CanonicalEsimRequest {
    action: String,
    payload: Value,
    iccid: Option<String>,
    nickname: Option<String>,
    activation_code_provided: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EsimOperationBinding {
    request_id: String,
    action: String,
    operation_token: String,
    iccid: Option<String>,
    nickname: Option<String>,
    activation_code_provided: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthChallenge {
    #[serde(rename = "type")]
    message_type: String,
    channel: String,
    nonce: String,
}

#[derive(Serialize)]
struct AuthResponse<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    channel: &'static str,
    nonce: &'a str,
    proof: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthAcknowledgement {
    #[serde(rename = "type")]
    message_type: String,
    channel: String,
    proof: String,
}

#[derive(Debug, Deserialize)]
struct BridgeEnvelope {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    operation_token: Option<String>,
    #[serde(default)]
    payload: Option<Value>,
}

fn canonicalize_esim_request(action: &str, payload: Value) -> Result<CanonicalEsimRequest, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "eSIM payload must be an object".to_string())?;
    let empty = || CanonicalEsimRequest {
        action: action.to_string(),
        payload: serde_json::json!({}),
        iccid: None,
        nickname: None,
        activation_code_provided: false,
    };

    match action {
        "humane.connectivity.esimlpa.getProfiles"
        | "humane.connectivity.esimlpa.getActiveProfile"
        | "humane.connectivity.esimlpa.getActiveprofileICCID"
        | "humane.connectivity.esimlpa.getEID" => {
            require_exact_payload_keys(object, &[])?;
            Ok(empty())
        }
        "humane.connectivity.esimlpa.enableProfile"
        | "humane.connectivity.esimlpa.disableProfile"
        | "humane.connectivity.esimlpa.deleteProfile" => {
            require_exact_payload_keys(object, &["iccid"])?;
            let iccid = normalize_iccid(required_payload_string(object, "iccid")?)?;
            Ok(CanonicalEsimRequest {
                action: action.to_string(),
                payload: serde_json::json!({ "iccid": iccid }),
                iccid: Some(iccid),
                nickname: None,
                activation_code_provided: false,
            })
        }
        "humane.connectivity.esimlpa.setNickname" => {
            require_exact_payload_keys(object, &["iccid", "nickname"])?;
            let iccid = normalize_iccid(required_payload_string(object, "iccid")?)?;
            let nickname = normalize_nickname(required_payload_string(object, "nickname")?)?;
            Ok(CanonicalEsimRequest {
                action: action.to_string(),
                payload: serde_json::json!({
                    "iccid": iccid,
                    "nickname": nickname,
                }),
                iccid: Some(iccid),
                nickname: Some(nickname),
                activation_code_provided: false,
            })
        }
        "humane.connectivity.esimlpa.downloadVerifyAndEnableProfile" => {
            require_exact_payload_keys(object, &["activationCode"])?;
            let activation_code =
                normalize_activation_code(required_payload_string(object, "activationCode")?)?;
            Ok(CanonicalEsimRequest {
                action: action.to_string(),
                payload: serde_json::json!({ "activationCode": activation_code }),
                iccid: None,
                nickname: None,
                activation_code_provided: true,
            })
        }
        _ => Err("unsupported eSIM action".to_string()),
    }
}

fn require_exact_payload_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
) -> Result<(), String> {
    if object.len() != expected.len() || !expected.iter().all(|key| object.contains_key(*key)) {
        return Err("eSIM payload schema mismatch".to_string());
    }
    Ok(())
}

fn required_payload_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} must be a non-empty string"))
}

fn normalize_iccid(raw: &str) -> Result<String, String> {
    let normalized = raw
        .trim()
        .chars()
        .filter(|character| *character != ' ' && *character != '-')
        .collect::<String>();
    if !(10..=22).contains(&normalized.len())
        || !normalized.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("invalid iccid".to_string());
    }
    Ok(normalized)
}

fn normalize_nickname(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_string();
    if normalized.is_empty()
        || normalized.encode_utf16().count() > 64
        || normalized.chars().any(char::is_control)
    {
        return Err("invalid nickname".to_string());
    }
    Ok(normalized)
}

fn normalize_activation_code(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_string();
    if normalized.is_empty()
        || normalized.encode_utf16().count() > 2_048
        || normalized.chars().any(char::is_control)
    {
        return Err("invalid activation code".to_string());
    }
    Ok(normalized)
}

fn expected_esim_terminal_type(action: &str) -> Option<&'static str> {
    match action {
        "humane.connectivity.esimlpa.getProfiles" => Some("esim.profiles_result"),
        "humane.connectivity.esimlpa.getActiveProfile" => Some("esim.active_profile_result"),
        "humane.connectivity.esimlpa.getActiveprofileICCID" => Some("esim.active_iccid_result"),
        "humane.connectivity.esimlpa.getEID" => Some("esim.device_identifiers_result"),
        "humane.connectivity.esimlpa.enableProfile"
        | "humane.connectivity.esimlpa.disableProfile"
        | "humane.connectivity.esimlpa.deleteProfile"
        | "humane.connectivity.esimlpa.setNickname" => Some("esim.profile_mutation_result"),
        _ => None,
    }
}

fn expected_esim_mutation_operation(action: &str) -> Option<&'static str> {
    match action {
        "humane.connectivity.esimlpa.enableProfile"
        | "humane.connectivity.esimlpa.downloadVerifyAndEnableProfile" => Some("enable"),
        "humane.connectivity.esimlpa.disableProfile" => Some("disable"),
        "humane.connectivity.esimlpa.deleteProfile" => Some("delete"),
        "humane.connectivity.esimlpa.setNickname" => Some("set_nickname"),
        _ => None,
    }
}

fn is_esim_download_action(action: &str) -> bool {
    action == "humane.connectivity.esimlpa.downloadVerifyAndEnableProfile"
}

impl EsimBridge {
    pub fn start() -> Self {
        #[cfg(not(target_os = "android"))]
        {
            Self::unavailable()
        }

        #[cfg(target_os = "android")]
        {
            let auth_token = match std::env::var(AUTH_TOKEN_ENV)
                .ok()
                .filter(|token| valid_auth_token(token))
            {
                Some(token) => token,
                None => {
                    warn!("eSIM bridge authentication is unavailable");
                    return Self::unavailable();
                }
            };

            let (command_tx, command_rx) = mpsc::unbounded_channel();
            let (events_tx, _) = broadcast::channel(256);
            let state = Arc::new(BridgeState {
                connected: RwLock::new(false),
                requests: Mutex::new(HashMap::new()),
                active_esim_request: Mutex::new(None),
                acceptance_waiters: Mutex::new(HashMap::new()),
                command_tx,
                events_tx,
            });

            tokio::spawn(run_bridge(state.clone(), command_rx, auth_token));
            Self { state }
        }
    }

    fn unavailable() -> Self {
        Self {
            state: Arc::new(BridgeState {
                connected: RwLock::new(false),
                requests: Mutex::new(HashMap::new()),
                active_esim_request: Mutex::new(None),
                acceptance_waiters: Mutex::new(HashMap::new()),
                command_tx: mpsc::unbounded_channel().0,
                events_tx: broadcast::channel(1).0,
            }),
        }
    }

    pub async fn submit_request(&self, action: String, payload: Value) -> Result<String, String> {
        let request_id = self.enqueue_request(action, payload).await?;
        self.wait_for_acceptance(&request_id).await?;
        Ok(request_id)
    }

    pub async fn submit_request_and_wait(
        &self,
        action: String,
        payload: Value,
        terminal_types: &[&str],
        timeout: std::time::Duration,
    ) -> Result<Value, EsimRequestError> {
        let request_id = self
            .enqueue_request(action, payload)
            .await
            .map_err(|message| EsimRequestError::Internal {
                request_id: None,
                message,
            })?;
        self.wait_for_acceptance(&request_id)
            .await
            .map_err(|message| EsimRequestError::Internal {
                request_id: Some(request_id.clone()),
                message,
            })?;
        self.wait_for_terminal_event(&request_id, terminal_types, timeout)
            .await
    }

    async fn enqueue_request(&self, action: String, payload: Value) -> Result<String, String> {
        let canonical = canonicalize_esim_request(&action, payload)?;
        let request_id = format!("req_{}", Uuid::new_v4().simple());
        let operation_token = format!("op_{}", Uuid::new_v4().simple());
        let binding = EsimOperationBinding {
            request_id: request_id.clone(),
            action: canonical.action.clone(),
            operation_token: operation_token.clone(),
            iccid: canonical.iccid.clone(),
            nickname: canonical.nickname.clone(),
            activation_code_provided: canonical.activation_code_provided,
        };
        claim_esim_operation(&self.state, binding.clone()).await?;

        let now_ms = now_ms();
        let record = EsimRequestRecord {
            request_id: request_id.clone(),
            action: canonical.action.clone(),
            status: "pending".into(),
            accepted: false,
            events: Vec::new(),
            final_event: None,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        };
        self.state
            .requests
            .lock()
            .await
            .insert(request_id.clone(), record);

        let body = serde_json::json!({
            "type": "esim.request",
            "request_id": request_id,
            "action": canonical.action,
            "operation_token": operation_token,
            "payload": canonical.payload,
        });

        let (accepted_tx, accepted_rx) = oneshot::channel();
        if self
            .state
            .command_tx
            .send(OutboundMessage {
                body,
                accepted_tx: Some(accepted_tx),
            })
            .is_err()
        {
            release_esim_operation(&self.state, &binding).await;
            return Err("bridge command queue closed".to_string());
        }

        self.state
            .requests
            .lock()
            .await
            .get_mut(&request_id)
            .ok_or_else(|| "request record missing after enqueue".to_string())?
            .status = "waiting_accept".into();

        self.state
            .acceptance_waiters
            .lock()
            .await
            .insert(request_id.clone(), accepted_rx);
        Ok(request_id)
    }

    async fn wait_for_acceptance(&self, request_id: &str) -> Result<(), String> {
        let accepted_rx = self
            .state
            .acceptance_waiters
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| "missing acceptance waiter".to_string())?;

        let result = match tokio::time::timeout(REQUEST_ACCEPTANCE_TIMEOUT, accepted_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                cancel_esim_operation(&self.state, request_id).await;
                return Err("bridge acceptance channel closed".to_string());
            }
            Err(_) => {
                cancel_esim_operation(&self.state, request_id).await;
                return Err("bridge acceptance timed out".to_string());
            }
        };
        if let Err(message) = result {
            cancel_esim_operation(&self.state, request_id).await;
            return Err(message);
        }
        Ok(())
    }

    async fn wait_for_terminal_event(
        &self,
        request_id: &str,
        terminal_types: &[&str],
        timeout: std::time::Duration,
    ) -> Result<Value, EsimRequestError> {
        let mut rx = self.state.events_tx.subscribe();

        if let Some(existing) = self
            .state
            .requests
            .lock()
            .await
            .get(request_id)
            .and_then(|record| record.final_event.clone())
        {
            if bridge_error_for_request(&existing, request_id)
                || explicit_error_event_for_request(&existing, request_id)
            {
                return Err(EsimRequestError::BridgeError { event: existing });
            }
            if matches_terminal_type(&existing, terminal_types) {
                return Ok(existing);
            }
        }

        let request_id = request_id.to_string();
        let timeout_request_id = request_id.clone();
        let terminal_types = terminal_types
            .iter()
            .map(|item| item.to_string())
            .collect::<Vec<_>>();

        let wait = async move {
            loop {
                let event = rx.recv().await.map_err(|e| EsimRequestError::Internal {
                    request_id: Some(request_id.clone()),
                    message: e.to_string(),
                })?;
                let event_request_id = event.get("request_id").and_then(Value::as_str);
                if event_request_id != Some(request_id.as_str()) {
                    continue;
                }

                if bridge_error_for_request(&event, &request_id)
                    || explicit_error_event_for_request(&event, &request_id)
                {
                    return Err(EsimRequestError::BridgeError { event });
                }

                let event_type = event.get("type").and_then(Value::as_str);
                if event_type
                    .map(|value| terminal_types.iter().any(|item| item == value))
                    .unwrap_or(false)
                {
                    return Ok(event);
                }
            }
        };

        match tokio::time::timeout(timeout, wait).await {
            Ok(result) => result,
            Err(_) => {
                cancel_esim_operation(&self.state, &timeout_request_id).await;
                Err(EsimRequestError::Timeout {
                    request_id: timeout_request_id,
                })
            }
        }
    }

    pub async fn snapshot(&self) -> EsimSnapshot {
        let connected = *self.state.connected.read().await;
        let mut requests = self
            .state
            .requests
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        requests.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));

        EsimSnapshot {
            connected,
            requests,
        }
    }

    pub async fn get_request(&self, request_id: &str) -> Option<EsimRequestRecord> {
        self.state.requests.lock().await.get(request_id).cloned()
    }

    pub async fn get_cellular_status(
        &self,
        timeout: std::time::Duration,
    ) -> Result<Value, CellularStatusError> {
        let request_id = format!("cellular_{}", Uuid::new_v4().simple());
        let body = serde_json::json!({
            "type": "cellular.status_request",
            "request_id": request_id,
        });
        self.state
            .command_tx
            .send(OutboundMessage {
                body,
                accepted_tx: None,
            })
            .map_err(|_| {
                CellularStatusError::Internal("bridge command queue closed".to_string())
            })?;

        let mut rx = self.state.events_tx.subscribe();
        let wait_request_id = request_id.clone();
        let wait = async move {
            loop {
                let event = rx.recv().await.map_err(|error| match error {
                    RecvError::Lagged(missed) => CellularStatusError::Internal(format!(
                        "cellular status stream lagged by {missed}"
                    )),
                    RecvError::Closed => {
                        CellularStatusError::Internal("cellular status stream closed".to_string())
                    }
                })?;
                let event_request_id = event.get("request_id").and_then(Value::as_str);
                if event_request_id != Some(wait_request_id.as_str()) {
                    continue;
                }
                match event.get("type").and_then(Value::as_str) {
                    Some("cellular.status_result") => return Ok(event),
                    Some("cellular.status_error") => {
                        return Err(CellularStatusError::BridgeError(event))
                    }
                    _ => continue,
                }
            }
        };

        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| CellularStatusError::Timeout { request_id })?
    }

    pub async fn set_wifi_enabled(
        &self,
        enabled: bool,
        timeout: std::time::Duration,
    ) -> Result<Value, DeviceToggleError> {
        self.send_simple_request_and_wait(
            "wifi.set_enabled_request",
            serde_json::json!({ "enabled": enabled }),
            "wifi.set_enabled_result",
            "wifi.set_enabled_error",
            timeout,
        )
        .await
    }

    pub async fn set_cellular_enabled(
        &self,
        enabled: bool,
        timeout: std::time::Duration,
    ) -> Result<Value, DeviceToggleError> {
        self.send_simple_request_and_wait(
            "cellular.set_enabled_request",
            serde_json::json!({ "enabled": enabled }),
            "cellular.set_enabled_result",
            "cellular.set_enabled_error",
            timeout,
        )
        .await
    }

    pub async fn dispatch_stock_action(
        &self,
        action: &str,
        payload: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, DeviceActionError> {
        let mut payload = payload.as_object().cloned().ok_or_else(|| {
            DeviceActionError::Internal("stock action payload must be an object".to_string())
        })?;
        payload.insert("action".to_string(), Value::String(action.to_string()));
        self.send_simple_request_and_wait(
            "device.stock_action_request",
            Value::Object(payload),
            "device.stock_action_result",
            "device.stock_action_error",
            timeout,
        )
        .await
    }

    pub async fn get_stock_message_status(
        &self,
        recipient: &str,
        message: &str,
        after_ms: u64,
        timeout: std::time::Duration,
    ) -> Result<Value, DeviceActionError> {
        self.send_simple_request_and_wait(
            "device.stock_message_status_request",
            serde_json::json!({
                "recipient": recipient,
                "message": message,
                "after_ms": after_ms,
            }),
            "device.stock_message_status_result",
            "device.stock_message_status_error",
            timeout,
        )
        .await
    }

    pub async fn commit_persistent_config(
        &self,
        expected_config_digest: &str,
        timeout: std::time::Duration,
    ) -> Result<u64, String> {
        if !canonical_sha256_digest(expected_config_digest) {
            return Err("invalid expected config snapshot digest".to_string());
        }
        let (generation, config_digest) = self.request_persistent_snapshot(timeout).await?;
        if config_digest != expected_config_digest {
            return Err("config snapshot acknowledgement mismatch".to_string());
        }
        Ok(generation)
    }

    /// Commit the provider's complete fixed artifact set after Spotify updates
    /// its app-private state. Callers cannot provide paths or bytes, and the
    /// Android broker validates every artifact.
    pub async fn commit_persistent_artifacts(
        &self,
        timeout: std::time::Duration,
    ) -> Result<u64, String> {
        self.request_persistent_snapshot(timeout)
            .await
            .map(|(generation, _)| generation)
    }

    async fn request_persistent_snapshot(
        &self,
        timeout: std::time::Duration,
    ) -> Result<(u64, String), String> {
        let request_id = format!("config_{}", Uuid::new_v4().simple());
        // Subscribe before enqueueing because the Android broker can answer
        // immediately on the already-authenticated loopback connection.
        let mut rx = self.state.events_tx.subscribe();
        self.state
            .command_tx
            .send(OutboundMessage {
                body: serde_json::json!({
                    "type": "config.snapshot_request",
                    "request_id": request_id,
                }),
                accepted_tx: None,
            })
            .map_err(|_| "config snapshot bridge queue closed".to_string())?;

        let wait_request_id = request_id.clone();
        let wait = async move {
            loop {
                let event = rx.recv().await.map_err(|error| match error {
                    RecvError::Lagged(_) => "config snapshot response stream lagged".to_string(),
                    RecvError::Closed => "config snapshot response stream closed".to_string(),
                })?;
                if event.get("request_id").and_then(Value::as_str) != Some(wait_request_id.as_str())
                {
                    continue;
                }
                match event.get("type").and_then(Value::as_str) {
                    Some("config.snapshot_result") => {
                        let (generation, config_digest) = config_snapshot_acknowledgement(&event)
                            .ok_or_else(|| {
                            "invalid config snapshot acknowledgement".to_string()
                        })?;
                        return Ok((generation, config_digest.to_string()));
                    }
                    Some("config.snapshot_error") | Some("esim.bridge_error") => {
                        return Err("config snapshot broker rejected the commit".to_string())
                    }
                    _ => continue,
                }
            }
        };

        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| format!("config snapshot request {request_id} timed out"))?
    }

    async fn send_simple_request_and_wait(
        &self,
        message_type: &str,
        payload: Value,
        success_type: &str,
        error_type: &str,
        timeout: std::time::Duration,
    ) -> Result<Value, DeviceToggleError> {
        let request_id = format!("toggle_{}", Uuid::new_v4().simple());
        let body = serde_json::json!({
            "type": message_type,
            "request_id": request_id,
            "payload": payload,
        });
        self.state
            .command_tx
            .send(OutboundMessage {
                body,
                accepted_tx: None,
            })
            .map_err(|_| DeviceToggleError::Internal("bridge command queue closed".to_string()))?;

        let mut rx = self.state.events_tx.subscribe();
        let wait_request_id = request_id.clone();
        let success_type = success_type.to_string();
        let error_type = error_type.to_string();
        let wait = async move {
            loop {
                let event = rx.recv().await.map_err(|error| match error {
                    RecvError::Lagged(missed) => DeviceToggleError::Internal(format!(
                        "device toggle stream lagged by {missed}"
                    )),
                    RecvError::Closed => {
                        DeviceToggleError::Internal("device toggle stream closed".to_string())
                    }
                })?;
                let event_request_id = event.get("request_id").and_then(Value::as_str);
                if event_request_id != Some(wait_request_id.as_str()) {
                    continue;
                }
                match event.get("type").and_then(Value::as_str) {
                    Some(value) if value == success_type => return Ok(event),
                    Some(value) if value == error_type => {
                        return Err(DeviceToggleError::BridgeError(event))
                    }
                    _ => continue,
                }
            }
        };

        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| DeviceToggleError::Timeout { request_id })?
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.state.events_tx.subscribe()
    }
}

async fn run_bridge(
    state: Arc<BridgeState>,
    mut command_rx: mpsc::UnboundedReceiver<OutboundMessage>,
    auth_token: String,
) {
    loop {
        match TcpStream::connect(BRIDGE_ADDR).await {
            Ok(stream) => {
                if let Err(error) =
                    handle_connection(state.clone(), stream, &mut command_rx, &auth_token).await
                {
                    warn!(%error, "eSIM bridge connection ended");
                }
                *state.connected.write().await = false;
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(error) => {
                warn!(%error, addr = BRIDGE_ADDR, "failed to connect to eSIM bridge");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }
}

async fn handle_connection(
    state: Arc<BridgeState>,
    stream: TcpStream,
    command_rx: &mut mpsc::UnboundedReceiver<OutboundMessage>,
    auth_token: &str,
) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    tokio::time::timeout(
        AUTH_TIMEOUT,
        authenticate_bridge(&mut reader, &mut writer, auth_token),
    )
    .await
    .map_err(|_| "eSIM bridge authentication failed".to_string())??;
    *state.connected.write().await = true;
    info!(addr = BRIDGE_ADDR, "authenticated eSIM bridge connection");
    let mut pending_accept = HashMap::<String, oneshot::Sender<Result<(), String>>>::new();

    loop {
        tokio::select! {
            maybe_command = command_rx.recv() => {
                let Some(command) = maybe_command else {
                    return Err("bridge command queue closed".into());
                };
                if let Some(request_id) = command.body.get("request_id").and_then(Value::as_str) {
                    if let Some(accepted_tx) = command.accepted_tx {
                        pending_accept.insert(request_id.to_string(), accepted_tx);
                    }
                }
                let encoded = serde_json::to_string(&command.body).map_err(|e| e.to_string())?;
                writer.write_all(encoded.as_bytes()).await.map_err(|e| e.to_string())?;
                writer.write_all(b"\n").await.map_err(|e| e.to_string())?;
                writer.flush().await.map_err(|e| e.to_string())?;
            }
            maybe_line = read_bounded_line(&mut reader, MAX_BRIDGE_LINE_BYTES) => {
                let line = maybe_line?;
                let Some(line) = line else {
                    return Err("bridge socket closed".into());
                };
                if line.is_blank() {
                    continue;
                }
                let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                let envelope: BridgeEnvelope = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                handle_incoming_message(&state, envelope, value, &mut pending_accept).await;
            }
        }
    }
}

async fn authenticate_bridge<R, W>(
    reader: &mut R,
    writer: &mut W,
    token: &str,
) -> Result<(), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    if !valid_auth_token(token) {
        return Err("eSIM bridge authentication failed".into());
    }

    let challenge_line = read_bounded_line(reader, MAX_AUTH_LINE_BYTES)
        .await
        .map_err(|_| "eSIM bridge authentication failed".to_string())?
        .ok_or_else(|| "eSIM bridge authentication failed".to_string())?;
    let challenge: AuthChallenge = serde_json::from_str(&challenge_line)
        .map_err(|_| "eSIM bridge authentication failed".to_string())?;
    if challenge.message_type != "esim.auth_challenge" || challenge.channel != AUTH_CHANNEL {
        return Err("eSIM bridge authentication failed".into());
    }
    let server_nonce = decode_auth_value(&challenge.nonce, AUTH_NONCE_CHARS, AUTH_NONCE_BYTES)
        .ok_or_else(|| "eSIM bridge authentication failed".to_string())?;

    let mut client_nonce = [0_u8; AUTH_NONCE_BYTES];
    rand::rngs::SysRng
        .try_fill_bytes(&mut client_nonce)
        .map_err(|_| "eSIM bridge authentication failed".to_string())?;
    let client_nonce_text = URL_SAFE_NO_PAD.encode(client_nonce);
    let client_proof = auth_proof(CLIENT_AUTH_DOMAIN, token, &server_nonce, &client_nonce)?;
    let client_proof_text = URL_SAFE_NO_PAD.encode(client_proof);
    let response = serde_json::to_vec(&AuthResponse {
        message_type: "esim.auth_response",
        channel: AUTH_CHANNEL,
        nonce: &client_nonce_text,
        proof: &client_proof_text,
    })
    .map_err(|_| "eSIM bridge authentication failed".to_string())?;
    writer
        .write_all(&response)
        .await
        .map_err(|_| "eSIM bridge authentication failed".to_string())?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|_| "eSIM bridge authentication failed".to_string())?;
    writer
        .flush()
        .await
        .map_err(|_| "eSIM bridge authentication failed".to_string())?;

    let ack_line = read_bounded_line(reader, MAX_AUTH_LINE_BYTES)
        .await
        .map_err(|_| "eSIM bridge authentication failed".to_string())?
        .ok_or_else(|| "eSIM bridge authentication failed".to_string())?;
    let ack: AuthAcknowledgement = serde_json::from_str(&ack_line)
        .map_err(|_| "eSIM bridge authentication failed".to_string())?;
    if ack.message_type != "esim.authenticated" || ack.channel != AUTH_CHANNEL {
        return Err("eSIM bridge authentication failed".into());
    }
    let server_proof = decode_auth_value(&ack.proof, AUTH_PROOF_CHARS, AUTH_PROOF_BYTES)
        .ok_or_else(|| "eSIM bridge authentication failed".to_string())?;
    let mut verifier = HmacSha256::new_from_slice(token.as_bytes())
        .map_err(|_| "eSIM bridge authentication failed".to_string())?;
    verifier.update(SERVER_AUTH_DOMAIN);
    verifier.update(&server_nonce);
    verifier.update(&client_nonce);
    verifier
        .verify_slice(&server_proof)
        .map_err(|_| "eSIM bridge authentication failed".to_string())
}

async fn read_bounded_line<R>(reader: &mut R, max_bytes: usize) -> Result<Option<String>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::with_capacity(max_bytes.min(1024));
    loop {
        let available = reader.fill_buf().await.map_err(|error| error.to_string())?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |position| position + 1);
        let content_len = newline.unwrap_or(available.len());
        if bytes.len().saturating_add(content_len) > max_bytes {
            return Err("eSIM bridge line exceeds limit".into());
        }
        bytes.extend_from_slice(&available[..content_len]);
        reader.consume(consumed);
        if newline.is_some() {
            break;
        }
    }

    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "eSIM bridge line is not UTF-8".into())
}

fn valid_auth_token(token: &str) -> bool {
    token.len() == AUTH_TOKEN_CHARS
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn decode_auth_value(value: &str, chars: usize, bytes: usize) -> Option<Vec<u8>> {
    if value.len() != chars
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(value).ok()?;
    (decoded.len() == bytes && URL_SAFE_NO_PAD.encode(&decoded) == value).then_some(decoded)
}

fn auth_proof(
    domain: &[u8],
    token: &str,
    server_nonce: &[u8],
    client_nonce: &[u8],
) -> Result<Vec<u8>, String> {
    let mut mac = HmacSha256::new_from_slice(token.as_bytes())
        .map_err(|_| "eSIM bridge authentication failed".to_string())?;
    mac.update(domain);
    mac.update(server_nonce);
    mac.update(client_nonce);
    Ok(mac.finalize().into_bytes().to_vec())
}

async fn claim_esim_operation(
    state: &BridgeState,
    binding: EsimOperationBinding,
) -> Result<(), String> {
    let mut active = state.active_esim_request.lock().await;
    if active.is_some() {
        return Err("another eSIM operation is already in flight".to_string());
    }
    *active = Some(binding);
    Ok(())
}

async fn release_esim_operation(state: &BridgeState, binding: &EsimOperationBinding) {
    let mut active = state.active_esim_request.lock().await;
    if active.as_ref() == Some(binding) {
        *active = None;
    }
}

async fn cancel_esim_operation(state: &BridgeState, request_id: &str) {
    let binding = state
        .active_esim_request
        .lock()
        .await
        .as_ref()
        .filter(|binding| binding.request_id == request_id)
        .cloned();
    let Some(binding) = binding else {
        return;
    };
    let _ = state.command_tx.send(OutboundMessage {
        body: serde_json::json!({
            "type": "esim.cancel_request",
            "request_id": binding.request_id,
            "action": binding.action,
            "operation_token": binding.operation_token,
        }),
        accepted_tx: None,
    });
    release_esim_operation(state, &binding).await;
}

fn nullable_payload_string<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn action_started_matches(binding: &EsimOperationBinding, payload: Option<&Value>) -> bool {
    let Some(extras) = payload.and_then(|value| value.get("extras")) else {
        return false;
    };
    nullable_payload_string(extras, "iccid") == binding.iccid.as_deref()
        && nullable_payload_string(extras, "nickname") == binding.nickname.as_deref()
        && extras
            .get("activationCodeProvided")
            .and_then(Value::as_bool)
            == Some(binding.activation_code_provided)
}

fn mutation_result_matches(binding: &EsimOperationBinding, payload: Option<&Value>) -> bool {
    let Some(payload) = payload else {
        return false;
    };
    if nullable_payload_string(payload, "operation")
        != expected_esim_mutation_operation(&binding.action)
    {
        return false;
    }
    if !is_esim_download_action(&binding.action)
        && nullable_payload_string(payload, "target_iccid") != binding.iccid.as_deref()
    {
        return false;
    }
    if binding.nickname.is_some()
        && nullable_payload_string(payload, "nickname") != binding.nickname.as_deref()
    {
        return false;
    }
    nullable_payload_string(payload, "result").is_some()
}

fn incoming_event_matches_binding(
    binding: &EsimOperationBinding,
    envelope: &BridgeEnvelope,
) -> bool {
    if envelope.request_id.as_deref() != Some(binding.request_id.as_str())
        || envelope.action.as_deref() != Some(binding.action.as_str())
        || envelope.operation_token.as_deref() != Some(binding.operation_token.as_str())
    {
        return false;
    }

    match envelope.message_type.as_str() {
        "esim.request_accepted" | "esim.bridge_error" => true,
        "esim.action_started" => action_started_matches(binding, envelope.payload.as_ref()),
        "esim.sysprop_update" => expected_esim_mutation_operation(&binding.action).is_none(),
        "esim.profiles_result"
        | "esim.active_profile_result"
        | "esim.active_iccid_result"
        | "esim.device_identifiers_result" => {
            expected_esim_terminal_type(&binding.action) == Some(envelope.message_type.as_str())
                && envelope
                    .payload
                    .as_ref()
                    .and_then(|payload| nullable_payload_string(payload, "result"))
                    .is_some()
        }
        "esim.profile_mutation_result" => {
            mutation_result_matches(binding, envelope.payload.as_ref())
        }
        "esim.download_progress" => {
            is_esim_download_action(&binding.action)
                && envelope
                    .payload
                    .as_ref()
                    .and_then(|payload| nullable_payload_string(payload, "phase"))
                    .is_some()
        }
        "esim.download_result" => {
            is_esim_download_action(&binding.action)
                && envelope
                    .payload
                    .as_ref()
                    .and_then(|payload| nullable_payload_string(payload, "result"))
                    .is_some()
        }
        _ => false,
    }
}

fn payload_result_is_error(result: &str) -> bool {
    matches!(
        result,
        "error" | "protected" | "active_profile" | "unverified_profile" | "disallowed_profile"
    )
}

fn config_snapshot_acknowledgement(event: &Value) -> Option<(u64, &str)> {
    let payload = event.get("payload")?;
    if payload.get("status").and_then(Value::as_str) != Some("committed") {
        return None;
    }
    let generation = payload
        .get("generation")
        .and_then(Value::as_u64)
        .filter(|generation| *generation > 0)?;
    let config_digest = payload.get("config_digest").and_then(Value::as_str)?;
    canonical_sha256_digest(config_digest).then_some((generation, config_digest))
}

fn canonical_sha256_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn explicit_error_event_for_request(event: &Value, request_id: &str) -> bool {
    if event.get("request_id").and_then(Value::as_str) != Some(request_id) {
        return false;
    }

    event
        .get("payload")
        .and_then(|payload| payload.get("result"))
        .and_then(Value::as_str)
        .map(payload_result_is_error)
        .unwrap_or(false)
}

fn download_verify_enable_event_is_final(envelope: &BridgeEnvelope) -> bool {
    match envelope.message_type.as_str() {
        "esim.download_result" => envelope
            .payload
            .as_ref()
            .and_then(|payload| payload.get("result"))
            .and_then(Value::as_str)
            .map(payload_result_is_error)
            .unwrap_or(false),
        "esim.profile_mutation_result" => {
            let payload = match envelope.payload.as_ref() {
                Some(payload) => payload,
                None => return false,
            };
            let operation = payload
                .get("operation")
                .and_then(Value::as_str)
                .unwrap_or("");
            let result = payload.get("result").and_then(Value::as_str).unwrap_or("");
            operation == "enable" || (operation == "unknown" && result == "error")
        }
        _ => false,
    }
}

fn is_final_event_for_action(action: &str, envelope: &BridgeEnvelope) -> bool {
    if is_esim_download_action(action) {
        return download_verify_enable_event_is_final(envelope);
    }
    expected_esim_terminal_type(action) == Some(envelope.message_type.as_str())
}

async fn handle_incoming_message(
    state: &Arc<BridgeState>,
    envelope: BridgeEnvelope,
    value: Value,
    pending_accept: &mut HashMap<String, oneshot::Sender<Result<(), String>>>,
) {
    let active_binding = if envelope.message_type.starts_with("esim.") {
        let active = state.active_esim_request.lock().await.clone();
        let Some(binding) = active else {
            warn!(
                event_type = envelope.message_type,
                "quarantined eSIM event without an active request"
            );
            return;
        };
        if !incoming_event_matches_binding(&binding, &envelope) {
            warn!(
                event_type = envelope.message_type,
                "quarantined mismatched eSIM event"
            );
            return;
        }
        Some(binding)
    } else {
        None
    };

    let mut terminal_request = false;
    if let Some(request_id) = envelope.request_id.as_deref() {
        let mut requests = state.requests.lock().await;
        prune_requests(&mut requests);
        if let Some(record) = requests.get_mut(request_id) {
            let now_ms = now_ms();
            match envelope.message_type.as_str() {
                "esim.request_accepted" => {
                    record.accepted = true;
                    record.status = "accepted".into();
                    record.updated_at_ms = now_ms;
                    if let Some(tx) = pending_accept.remove(request_id) {
                        let _ = tx.send(Ok(()));
                    }
                }
                "esim.bridge_error" => {
                    terminal_request = true;
                    record.status = "error".into();
                    record.final_event = Some(value.clone());
                    push_request_event(record, value.clone());
                    record.updated_at_ms = now_ms;
                    if let Some(tx) = pending_accept.remove(request_id) {
                        let message = envelope
                            .payload
                            .as_ref()
                            .and_then(|payload| payload.get("message"))
                            .and_then(Value::as_str)
                            .or_else(|| value.get("message").and_then(Value::as_str))
                            .unwrap_or("bridge error")
                            .to_string();
                        let _ = tx.send(Err(message));
                    }
                }
                _ => {
                    push_request_event(record, value.clone());
                    record.updated_at_ms = now_ms;
                    if record.final_event.is_none()
                        && is_final_event_for_action(&record.action, &envelope)
                    {
                        terminal_request = true;
                        record.final_event = Some(value.clone());
                        let result = envelope
                            .payload
                            .as_ref()
                            .and_then(|payload| payload.get("result"))
                            .and_then(Value::as_str)
                            .unwrap_or("success");
                        record.status = if payload_result_is_error(result) {
                            "error".into()
                        } else {
                            "completed".into()
                        };
                    } else if record.status == "pending" {
                        record.status = "running".into();
                    }
                }
            }
        } else if envelope.message_type == "esim.request_accepted" {
            if let Some(tx) = pending_accept.remove(request_id) {
                let _ = tx.send(Ok(()));
            }
        }
    }

    if terminal_request {
        if let Some(binding) = active_binding.as_ref() {
            release_esim_operation(state, binding).await;
        }
    }

    let _ = state.events_tx.send(value);
}

trait BlankCheck {
    fn is_blank(&self) -> bool;
}

impl BlankCheck for String {
    fn is_blank(&self) -> bool {
        self.trim().is_empty()
    }
}

fn matches_terminal_type(event: &Value, terminal_types: &[&str]) -> bool {
    event
        .get("type")
        .and_then(Value::as_str)
        .map(|event_type| terminal_types.contains(&event_type))
        .unwrap_or(false)
}

fn bridge_error_for_request(event: &Value, request_id: &str) -> bool {
    event.get("type").and_then(Value::as_str) == Some("esim.bridge_error")
        && event.get("request_id").and_then(Value::as_str) == Some(request_id)
}

fn push_request_event(record: &mut EsimRequestRecord, event: Value) {
    record.events.push(event);
    if record.events.len() > MAX_EVENTS_PER_REQUEST {
        let overflow = record.events.len() - MAX_EVENTS_PER_REQUEST;
        record.events.drain(0..overflow);
    }
}

fn prune_requests(requests: &mut HashMap<String, EsimRequestRecord>) {
    let cutoff_ms = now_ms().saturating_sub(REQUEST_TTL_MS);
    requests.retain(|_, record| record.updated_at_ms >= cutoff_ms);

    if requests.len() <= MAX_STORED_REQUESTS {
        return;
    }

    let mut ordered = requests
        .iter()
        .map(|(request_id, record)| (request_id.clone(), record.updated_at_ms))
        .collect::<Vec<_>>();
    ordered.sort_by(|a, b| b.1.cmp(&a.1));

    let keep = ordered
        .into_iter()
        .take(MAX_STORED_REQUESTS)
        .map(|(request_id, _)| request_id)
        .collect::<std::collections::HashSet<_>>();
    requests.retain(|request_id, _| keep.contains(request_id));
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SERVER_NONCE: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const CLIENT_NONCE: &str = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
    const CLIENT_PROOF: &str = "BVF9ipNYSuVUYpdEV2NI_fHSqAX6GJsN_9XBpxaizGs";
    const SERVER_PROOF: &str = "LFFZ6rg56xIRlbbvCeHG2OSvnUC3KaFYwGG7MKBG5Qg";

    #[test]
    fn esim_authentication_vectors_match_android_implementations() {
        assert!(valid_auth_token(TOKEN));
        assert!(!valid_auth_token(&TOKEN.to_uppercase()));
        assert!(!valid_auth_token("short"));

        let server = decode_auth_value(SERVER_NONCE, AUTH_NONCE_CHARS, AUTH_NONCE_BYTES).unwrap();
        let client = decode_auth_value(CLIENT_NONCE, AUTH_NONCE_CHARS, AUTH_NONCE_BYTES).unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD
                .encode(auth_proof(CLIENT_AUTH_DOMAIN, TOKEN, &server, &client).unwrap()),
            CLIENT_PROOF
        );
        assert_eq!(
            URL_SAFE_NO_PAD
                .encode(auth_proof(SERVER_AUTH_DOMAIN, TOKEN, &server, &client).unwrap()),
            SERVER_PROOF
        );
    }

    #[tokio::test]
    async fn bridge_lines_are_bounded_before_json_parsing() {
        let input = b"first\r\nsecond\n";
        let mut reader = BufReader::new(&input[..]);
        assert_eq!(
            read_bounded_line(&mut reader, 16).await.unwrap(),
            Some("first".into())
        );
        assert_eq!(
            read_bounded_line(&mut reader, 16).await.unwrap(),
            Some("second".into())
        );
        assert_eq!(read_bounded_line(&mut reader, 16).await.unwrap(), None);

        let oversized = vec![b'x'; 17];
        let mut reader = BufReader::new(oversized.as_slice());
        assert!(read_bounded_line(&mut reader, 16).await.is_err());
    }

    #[test]
    fn config_snapshot_acknowledgement_requires_committed_positive_generation() {
        let valid = serde_json::json!({
            "type": "config.snapshot_result",
            "payload": {
                "status": "committed",
                "generation": 9,
                "config_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
        });
        assert_eq!(
            config_snapshot_acknowledgement(&valid),
            Some((
                9,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ))
        );
        assert_eq!(
            config_snapshot_acknowledgement(&serde_json::json!({
                "payload": {
                    "status": "committed",
                    "generation": 0,
                    "config_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }
            })),
            None
        );
        assert_eq!(
            config_snapshot_acknowledgement(&serde_json::json!({
                "payload": {
                    "status": "error",
                    "generation": 9,
                    "config_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }
            })),
            None
        );
    }

    #[test]
    fn unsafe_profile_deletion_results_are_terminal_errors() {
        assert!(payload_result_is_error("protected"));
        assert!(payload_result_is_error("active_profile"));
        assert!(payload_result_is_error("unverified_profile"));
        assert!(!payload_result_is_error("success"));
    }

    #[test]
    fn esim_requests_are_allowlisted_normalized_and_schema_exact() {
        let request = canonicalize_esim_request(
            "humane.connectivity.esimlpa.setNickname",
            serde_json::json!({
                "iccid": " 12345-67890 ",
                "nickname": "  Travel  ",
            }),
        )
        .unwrap();
        assert_eq!(request.iccid.as_deref(), Some("1234567890"));
        assert_eq!(request.nickname.as_deref(), Some("Travel"));
        assert_eq!(
            request.payload,
            serde_json::json!({
                "iccid": "1234567890",
                "nickname": "Travel",
            })
        );

        assert!(canonicalize_esim_request(
            "humane.connectivity.esimlpa.setNickname",
            serde_json::json!({
                "iccid": "1234567890",
                "nickname": "Travel",
                "unexpected": true,
            }),
        )
        .is_err());
        assert!(canonicalize_esim_request(
            "humane.connectivity.esimlpa.unsupported",
            serde_json::json!({}),
        )
        .is_err());
    }

    #[tokio::test]
    async fn rust_side_allows_only_one_inflight_esim_operation() {
        let state = BridgeState {
            connected: RwLock::new(false),
            requests: Mutex::new(HashMap::new()),
            active_esim_request: Mutex::new(None),
            acceptance_waiters: Mutex::new(HashMap::new()),
            command_tx: mpsc::unbounded_channel().0,
            events_tx: broadcast::channel(1).0,
        };
        let first = test_binding(
            "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "op_11111111111111111111111111111111",
            "1234567890",
        );
        let second = test_binding(
            "req_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "op_22222222222222222222222222222222",
            "2222222222",
        );

        claim_esim_operation(&state, first.clone()).await.unwrap();
        assert!(claim_esim_operation(&state, second.clone()).await.is_err());
        release_esim_operation(&state, &second).await;
        assert_eq!(*state.active_esim_request.lock().await, Some(first.clone()));
        release_esim_operation(&state, &first).await;
        claim_esim_operation(&state, second.clone()).await.unwrap();
        assert_eq!(*state.active_esim_request.lock().await, Some(second));
    }

    #[tokio::test]
    async fn exact_cancellation_releases_and_preserves_the_retired_binding() {
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let state = BridgeState {
            connected: RwLock::new(false),
            requests: Mutex::new(HashMap::new()),
            active_esim_request: Mutex::new(None),
            acceptance_waiters: Mutex::new(HashMap::new()),
            command_tx,
            events_tx: broadcast::channel(1).0,
        };
        let binding = test_binding(
            "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "op_11111111111111111111111111111111",
            "1234567890",
        );
        claim_esim_operation(&state, binding.clone()).await.unwrap();

        cancel_esim_operation(&state, "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").await;

        assert_eq!(*state.active_esim_request.lock().await, None);
        let cancellation = command_rx.recv().await.unwrap().body;
        assert_eq!(
            cancellation.get("type").and_then(Value::as_str),
            Some("esim.cancel_request")
        );
        assert_eq!(
            cancellation.get("operation_token").and_then(Value::as_str),
            Some(binding.operation_token.as_str()),
        );
    }

    #[tokio::test(start_paused = true)]
    async fn silent_acceptance_is_bounded_and_releases_only_its_exact_binding() {
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let state = Arc::new(BridgeState {
            connected: RwLock::new(false),
            requests: Mutex::new(HashMap::new()),
            active_esim_request: Mutex::new(None),
            acceptance_waiters: Mutex::new(HashMap::new()),
            command_tx,
            events_tx: broadcast::channel(1).0,
        });
        let binding = test_binding(
            "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "op_11111111111111111111111111111111",
            "1234567890",
        );
        claim_esim_operation(&state, binding.clone()).await.unwrap();
        let (_accepted_tx, accepted_rx) = oneshot::channel();
        state
            .acceptance_waiters
            .lock()
            .await
            .insert(binding.request_id.clone(), accepted_rx);
        let bridge = EsimBridge {
            state: state.clone(),
        };

        let request_id = binding.request_id.clone();
        let wait = tokio::spawn(async move { bridge.wait_for_acceptance(&request_id).await });
        tokio::time::advance(REQUEST_ACCEPTANCE_TIMEOUT).await;

        assert_eq!(
            wait.await.unwrap().unwrap_err(),
            "bridge acceptance timed out"
        );
        assert_eq!(*state.active_esim_request.lock().await, None);
        let cancellation = command_rx.recv().await.unwrap().body;
        assert_eq!(
            cancellation.get("request_id").and_then(Value::as_str),
            Some(binding.request_id.as_str()),
        );
        assert_eq!(
            cancellation.get("operation_token").and_then(Value::as_str),
            Some(binding.operation_token.as_str()),
        );
    }

    #[test]
    fn exact_binding_quarantines_wrong_targets_and_late_callbacks() {
        let first = test_binding(
            "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "op_11111111111111111111111111111111",
            "1234567890",
        );
        let second = test_binding(
            "req_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "op_22222222222222222222222222222222",
            "2222222222",
        );
        let valid_first: BridgeEnvelope = serde_json::from_value(serde_json::json!({
            "type": "esim.profile_mutation_result",
            "request_id": first.request_id,
            "action": first.action,
            "operation_token": first.operation_token,
            "payload": {
                "operation": "enable",
                "target_iccid": "1234567890",
                "nickname": null,
                "result": "success",
            }
        }))
        .unwrap();
        assert!(incoming_event_matches_binding(&first, &valid_first));
        assert!(!incoming_event_matches_binding(&second, &valid_first));

        let wrong_target: BridgeEnvelope = serde_json::from_value(serde_json::json!({
            "type": "esim.profile_mutation_result",
            "request_id": first.request_id,
            "action": first.action,
            "operation_token": first.operation_token,
            "payload": {
                "operation": "enable",
                "target_iccid": "9999999999",
                "nickname": null,
                "result": "success",
            }
        }))
        .unwrap();
        assert!(!incoming_event_matches_binding(&first, &wrong_target));

        let malformed: BridgeEnvelope = serde_json::from_value(serde_json::json!({
            "type": "esim.profile_mutation_result",
            "request_id": first.request_id,
            "action": first.action,
            "operation_token": first.operation_token,
            "payload": {
                "operation": "enable",
                "target_iccid": "1234567890",
                "nickname": null,
            }
        }))
        .unwrap();
        assert!(!incoming_event_matches_binding(&first, &malformed));
    }

    fn test_binding(request_id: &str, operation_token: &str, iccid: &str) -> EsimOperationBinding {
        EsimOperationBinding {
            request_id: request_id.to_string(),
            action: "humane.connectivity.esimlpa.enableProfile".to_string(),
            operation_token: operation_token.to_string(),
            iccid: Some(iccid.to_string()),
            nickname: None,
            activation_code_provided: false,
        }
    }
}
