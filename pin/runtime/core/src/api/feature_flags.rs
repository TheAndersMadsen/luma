use std::collections::BTreeMap;
use std::future::Future;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "android")]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(target_os = "android")]
use tokio::net::TcpStream;

use super::{persist_config_durably, ApiState};
use crate::config::{Config, TemperatureUnit};
use crate::feature_flags::{
    feature_flag_spec, proto_assignments, settings_global_bridge_key_allowed,
    settings_global_feature_gate_spec, validate_feature_flags, ConfiguredFeatureFlagValue,
    FeatureFlagDefault, FEATURE_FLAG_SPECS, SETTINGS_GLOBAL_FEATURE_GATES,
    WEATHER_CELSIUS_SETTING_KEY,
};
use crate::services::aibus::FoodRuntimeGate;
use crate::services::featureflags::{assignment_set_hash, FeatureFlagDeliveryTracker};
use crate::tier_a::feature_flags::{cloud as cloud_keys, settings_global as settings_global_keys};

#[cfg(target_os = "android")]
const FORCE_FLAG_SYNC_ACTION: &str = "humane.central.debug.FORCE_FLAG_SYNC";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const SETTINGS_GLOBAL_BRIDGE_ADDR: &str = "127.0.0.1:16791";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const SETTINGS_GLOBAL_BRIDGE_TOKEN_ENV: &str = "PENUMBRA_SETTINGS_GLOBAL_BRIDGE_TOKEN";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const SETTINGS_GLOBAL_BRIDGE_TOKEN_CHARS: usize = 64;
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const SETTINGS_GLOBAL_BRIDGE_PROTOCOL_VERSION: u8 = 1;
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const SETTINGS_GLOBAL_BRIDGE_MAX_LINE_BYTES: usize = 2 * 1024;
const FOOD_SETTINGS_GLOBAL_KEY: &str = settings_global_keys::FOOD_ENABLED;
#[cfg(target_os = "android")]
const FOOD_RUNTIME_GATE_REFRESH_INTERVAL: Duration = Duration::from_secs(10);

#[cfg(not(test))]
const FEATURE_FLAG_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
// Keep pending-future regression tests fast while exercising the same timeout path.
#[cfg(test)]
const FEATURE_FLAG_COMMAND_TIMEOUT: Duration = Duration::from_millis(20);
#[cfg(not(test))]
const FEATURE_FLAG_FETCH_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const FEATURE_FLAG_FETCH_TIMEOUT: Duration = Duration::from_millis(75);
const FEATURE_FLAG_FETCH_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(target_os = "android")]
const STARTUP_FEATURE_FLAG_SYNC_DELAYS: [Duration; 3] = [
    Duration::from_millis(750),
    Duration::from_secs(3),
    Duration::from_secs(10),
];
#[cfg(target_os = "android")]
const STARTUP_FEATURE_FLAG_FETCH_TIMEOUT: Duration = Duration::from_secs(3);

async fn run_command_with_timeout<F, T, E>(future: F) -> Result<T, ()>
where
    F: Future<Output = Result<T, E>>,
{
    match tokio::time::timeout(FEATURE_FLAG_COMMAND_TIMEOUT, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) | Err(_) => Err(()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SettingsGlobalCommand {
    Get { key: String },
    Put { key: String, value: bool },
    Delete { key: String },
    FeatureFlagApplyAck,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FeatureFlagApplyAckReceipt {
    sequence: u64,
    assignment_set_hash: String,
    assignment_count: u32,
    applied_at_unix_ms: u64,
}

impl FeatureFlagApplyAckReceipt {
    fn still_matches(&self, expected: &Self) -> bool {
        self.sequence >= expected.sequence
            && self.assignment_set_hash == expected.assignment_set_hash
            && self.assignment_count == expected.assignment_count
    }
}

#[tonic::async_trait]
trait SettingsGlobalCommandRunner: Send + Sync {
    async fn run(&self, command: SettingsGlobalCommand) -> Result<String, String>;
}

struct SystemSettingsGlobalCommandRunner;

#[tonic::async_trait]
impl SettingsGlobalCommandRunner for SystemSettingsGlobalCommandRunner {
    async fn run(&self, command: SettingsGlobalCommand) -> Result<String, String> {
        #[cfg(not(target_os = "android"))]
        {
            let _ = command;
            Err("Settings.Global is unavailable on this platform".into())
        }

        #[cfg(target_os = "android")]
        {
            run_settings_global_bridge_command(command).await
        }
    }
}

#[tonic::async_trait]
trait FeatureFlagSyncRequester: Send + Sync {
    async fn request_sync(&self) -> bool;
}

struct SystemFeatureFlagSyncRequester;

#[tonic::async_trait]
impl FeatureFlagSyncRequester for SystemFeatureFlagSyncRequester {
    async fn request_sync(&self) -> bool {
        request_immediate_feature_flag_sync().await
    }
}

#[derive(Serialize)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct SettingsGlobalBridgeRequest<'a> {
    version: u8,
    token: &'a str,
    op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<bool>,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn settings_global_bridge_request(
    command: &SettingsGlobalCommand,
    token: &str,
) -> Result<Vec<u8>, String> {
    if !valid_settings_global_bridge_token(token) {
        return Err("Settings.Global bridge authentication is unavailable".into());
    }
    let (op, key, value) = match command {
        SettingsGlobalCommand::Get { key } => ("get", Some(key.as_str()), None),
        SettingsGlobalCommand::Put { key, value } => ("put", Some(key.as_str()), Some(*value)),
        SettingsGlobalCommand::Delete { key } => ("delete", Some(key.as_str()), None),
        SettingsGlobalCommand::FeatureFlagApplyAck => ("feature_flag_ack", None, None),
    };
    // Defense in depth on both sides of the app/native boundary.
    if key.is_some_and(|key| !settings_global_bridge_key_allowed(key)) {
        return Err("refusing non-allowlisted Settings.Global key".into());
    }
    let mut request = serde_json::to_vec(&SettingsGlobalBridgeRequest {
        version: SETTINGS_GLOBAL_BRIDGE_PROTOCOL_VERSION,
        token,
        op,
        key,
        value,
    })
    .map_err(|_| "Unable to encode Settings.Global bridge request".to_string())?;
    if request.len() > SETTINGS_GLOBAL_BRIDGE_MAX_LINE_BYTES {
        return Err("Settings.Global bridge request is too large".into());
    }
    request.push(b'\n');
    Ok(request)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn sync_weather_temperature_unit_with_runner<R: SettingsGlobalCommandRunner>(
    runner: &R,
    unit: TemperatureUnit,
) -> Result<(), String> {
    run_settings_global_command(
        runner,
        SettingsGlobalCommand::Put {
            key: WEATHER_CELSIUS_SETTING_KEY.to_string(),
            value: matches!(unit, TemperatureUnit::Celsius),
        },
    )
    .await
    .map(|_| ())
    .map_err(|_| "unable to synchronize the stock weather temperature unit".to_string())
}

#[cfg(target_os = "android")]
pub(super) async fn sync_weather_temperature_unit(unit: TemperatureUnit) -> Result<(), String> {
    sync_weather_temperature_unit_with_runner(&SystemSettingsGlobalCommandRunner, unit).await
}

#[cfg(not(target_os = "android"))]
pub(super) async fn sync_weather_temperature_unit(_unit: TemperatureUnit) -> Result<(), String> {
    Ok(())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn valid_settings_global_bridge_token(token: &str) -> bool {
    token.len() == SETTINGS_GLOBAL_BRIDGE_TOKEN_CHARS && valid_lowercase_hex(token)
}

fn valid_lowercase_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn parse_settings_global_bridge_response(
    command: &SettingsGlobalCommand,
    line: &[u8],
) -> Result<String, String> {
    if line.is_empty() || line.len() > SETTINGS_GLOBAL_BRIDGE_MAX_LINE_BYTES {
        return Err("Invalid Settings.Global bridge response".into());
    }
    let response: serde_json::Value = serde_json::from_slice(line)
        .map_err(|_| "Invalid Settings.Global bridge response".to_string())?;
    let object = response
        .as_object()
        .ok_or_else(|| "Invalid Settings.Global bridge response".to_string())?;
    if object.get("version").and_then(serde_json::Value::as_u64)
        != Some(u64::from(SETTINGS_GLOBAL_BRIDGE_PROTOCOL_VERSION))
    {
        return Err("Invalid Settings.Global bridge response".into());
    }
    let ok = object
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "Invalid Settings.Global bridge response".to_string())?;
    if !ok {
        let expected = ["error", "ok", "version"];
        let error = object.get("error").and_then(serde_json::Value::as_str);
        if object.len() != expected.len()
            || !expected.iter().all(|key| object.contains_key(*key))
            || error.is_none_or(|message| message.is_empty() || message.len() > 64)
        {
            return Err("Invalid Settings.Global bridge response".into());
        }
        return Err("Settings.Global bridge rejected the request".into());
    }

    match command {
        SettingsGlobalCommand::Get { .. } => {
            let expected = ["ok", "value", "version"];
            if object.len() != expected.len()
                || !expected.iter().all(|key| object.contains_key(*key))
            {
                return Err("Invalid Settings.Global bridge response".into());
            }
            match object.get("value") {
                Some(serde_json::Value::Null) => Ok("null".into()),
                Some(serde_json::Value::String(value)) if value.len() <= 32 => Ok(value.clone()),
                _ => Err("Invalid Settings.Global bridge response".into()),
            }
        }
        SettingsGlobalCommand::Put { .. } | SettingsGlobalCommand::Delete { .. } => {
            let expected = ["ok", "version"];
            if object.len() != expected.len()
                || !expected.iter().all(|key| object.contains_key(*key))
            {
                return Err("Invalid Settings.Global bridge response".into());
            }
            Ok(String::new())
        }
        SettingsGlobalCommand::FeatureFlagApplyAck => {
            let expected = ["ok", "receipt", "version"];
            if object.len() != expected.len()
                || !expected.iter().all(|key| object.contains_key(*key))
            {
                return Err("Invalid Settings.Global bridge response".into());
            }
            let Some(receipt_value) = object.get("receipt") else {
                return Err("Invalid Settings.Global bridge response".into());
            };
            if receipt_value.is_null() {
                return Ok("null".into());
            }
            let receipt: FeatureFlagApplyAckReceipt = serde_json::from_value(receipt_value.clone())
                .map_err(|_| "Invalid Settings.Global bridge response".to_string())?;
            if receipt.sequence == 0
                || receipt.assignment_count == 0
                || receipt.assignment_count > 256
                || receipt.applied_at_unix_ms == 0
                || receipt.assignment_set_hash.len() != 64
                || !valid_lowercase_hex(&receipt.assignment_set_hash)
            {
                return Err("Invalid Settings.Global bridge response".into());
            }
            serde_json::to_string(&receipt)
                .map_err(|_| "Invalid Settings.Global bridge response".to_string())
        }
    }
}

#[cfg(target_os = "android")]
async fn run_settings_global_bridge_command(
    command: SettingsGlobalCommand,
) -> Result<String, String> {
    let token = std::env::var(SETTINGS_GLOBAL_BRIDGE_TOKEN_ENV)
        .map_err(|_| "Settings.Global bridge authentication is unavailable".to_string())?;
    let request = settings_global_bridge_request(&command, &token)?;
    let mut stream = TcpStream::connect(SETTINGS_GLOBAL_BRIDGE_ADDR)
        .await
        .map_err(|_| "Settings.Global bridge is unavailable".to_string())?;
    stream
        .write_all(&request)
        .await
        .map_err(|_| "Settings.Global bridge request failed".to_string())?;
    stream
        .flush()
        .await
        .map_err(|_| "Settings.Global bridge request failed".to_string())?;

    let mut line = Vec::with_capacity(256);
    let mut buffer = [0_u8; 256];
    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|_| "Settings.Global bridge response failed".to_string())?;
        if read == 0 {
            return Err("Settings.Global bridge closed without a response".into());
        }
        let newline = buffer[..read].iter().position(|byte| *byte == b'\n');
        let chunk = &buffer[..newline.unwrap_or(read)];
        if line.len() + chunk.len() > SETTINGS_GLOBAL_BRIDGE_MAX_LINE_BYTES {
            return Err("Settings.Global bridge response is too large".into());
        }
        line.extend_from_slice(chunk);
        if newline.is_some() {
            break;
        }
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    parse_settings_global_bridge_response(&command, &line)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
enum FeatureFlagValueDto {
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
}

impl From<&ConfiguredFeatureFlagValue> for FeatureFlagValueDto {
    fn from(value: &ConfiguredFeatureFlagValue) -> Self {
        match value {
            ConfiguredFeatureFlagValue::Bool(value) => Self::Bool(*value),
            ConfiguredFeatureFlagValue::Int(value) => Self::Int(*value),
            ConfiguredFeatureFlagValue::Float(value) => Self::Float(*value),
            ConfiguredFeatureFlagValue::String(value) => Self::String(value.clone()),
        }
    }
}

impl From<FeatureFlagDefault> for FeatureFlagValueDto {
    fn from(value: FeatureFlagDefault) -> Self {
        Self::from(&value.to_configured())
    }
}

impl From<FeatureFlagValueDto> for ConfiguredFeatureFlagValue {
    fn from(value: FeatureFlagValueDto) -> Self {
        match value {
            FeatureFlagValueDto::Bool(value) => Self::Bool(value),
            FeatureFlagValueDto::Int(value) => Self::Int(value),
            FeatureFlagValueDto::Float(value) => Self::Float(value),
            FeatureFlagValueDto::String(value) => Self::String(value),
        }
    }
}

#[derive(Serialize)]
struct FeatureFlagDefinitionResponse {
    key: &'static str,
    label: &'static str,
    description: &'static str,
    value_type: &'static str,
    firmware_default: FeatureFlagValueDto,
    penumbra_default: Option<FeatureFlagValueDto>,
    override_value: Option<FeatureFlagValueDto>,
    /// Server-desired value. Delivery metadata separately reports how far the
    /// exact assignment set has been observed through the stock sync path. A
    /// firmware-default value is resolved by stock and is not sent.
    desired_value: FeatureFlagValueDto,
    /// The value actually present in Penumbra's replacement assignment set.
    /// `None` means stock resolves its own firmware default for this key.
    assignment_value: Option<FeatureFlagValueDto>,
    source: &'static str,
    writable: bool,
    warning: Option<&'static str>,
    restart_recommended: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum FeatureFlagDeliveryState {
    Persisted,
    SyncDispatched,
    GrpcFetched,
    StockCacheApplied,
}

#[derive(Serialize)]
struct FeatureFlagDeliveryResponse {
    state: FeatureFlagDeliveryState,
    desired_assignment_hash: String,
    grpc_fetch_observed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_grpc_fetch_unix_ms: Option<u64>,
    /// True only after the injected Ironman hook observes successful
    /// setServerFlags completion plus exact manager readback and the Android
    /// Binder bridge acknowledges that assignment identity.
    stock_cache_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_stock_cache_apply_unix_ms: Option<u64>,
    immediate_sync_supported: bool,
    automatic_triggers: &'static [&'static str],
    note: &'static str,
}

#[derive(Serialize)]
struct SettingsGlobalFeatureGateResponse {
    key: &'static str,
    label: &'static str,
    default: bool,
    writable: bool,
    warning: Option<&'static str>,
    restart_recommended: bool,
    stored_value: Option<bool>,
    current_value: Option<bool>,
    source: &'static str,
    available: bool,
    error: Option<&'static str>,
}

#[derive(Serialize)]
pub(super) struct FeatureFlagsResponse {
    flags: Vec<FeatureFlagDefinitionResponse>,
    /// Current state for the distinct Settings.Global storage plane. These
    /// keys are only writable through the separate request field and never
    /// accepted as cloud assignments.
    settings_global_gates: Vec<SettingsGlobalFeatureGateResponse>,
    settings_global_note: &'static str,
    delivery: FeatureFlagDeliveryResponse,
    /// `None` on GET. On PUT, true means the Android broadcast command was
    /// accepted; it is not an acknowledgement that WorkManager completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    sync_requested: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct UpdateFeatureFlagsRequest {
    /// Patch semantics: a typed value sets/replaces an override; null removes
    /// it and returns to the Penumbra or firmware default.
    #[serde(default)]
    overrides: BTreeMap<String, Option<FeatureFlagValueDto>>,
    /// A completely separate Android Settings.Global patch. A bool stores the
    /// canonical integer representation (0/1); null deletes the key so the
    /// stock default applies.
    #[serde(default)]
    settings_global: BTreeMap<String, Option<bool>>,
}

#[derive(Debug, Clone)]
struct SettingsGlobalGateRead {
    key: &'static str,
    label: &'static str,
    default: bool,
    writable: bool,
    warning: Option<&'static str>,
    restart_recommended: bool,
    stored_value: Option<bool>,
    available: bool,
}

impl SettingsGlobalGateRead {
    fn response(&self) -> SettingsGlobalFeatureGateResponse {
        SettingsGlobalFeatureGateResponse {
            key: self.key,
            label: self.label,
            default: self.default,
            writable: self.writable,
            warning: self.warning,
            restart_recommended: self.restart_recommended,
            stored_value: self.stored_value,
            current_value: self
                .available
                .then_some(self.stored_value.unwrap_or(self.default)),
            source: if !self.available {
                "unavailable"
            } else if self.stored_value.is_some() {
                "stored"
            } else {
                "default"
            },
            available: self.available,
            error: (!self.available).then_some("Unable to read this Settings.Global gate."),
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct SettingsGlobalOperationFailure {
    key: String,
    operation: &'static str,
}

#[derive(Debug)]
struct SettingsGlobalApplyFailure {
    failures: Vec<SettingsGlobalOperationFailure>,
    rollback_failures: Vec<SettingsGlobalOperationFailure>,
}

impl SettingsGlobalApplyFailure {
    fn response(self, partial_applied: bool) -> SettingsGlobalApplyFailureResponse {
        SettingsGlobalApplyFailureResponse {
            error: "Failed to apply one or more Settings.Global feature gates.",
            failures: self.failures,
            rollback_failures: self.rollback_failures,
            partial_applied,
        }
    }
}

#[derive(Serialize)]
struct SettingsGlobalApplyFailureResponse {
    error: &'static str,
    failures: Vec<SettingsGlobalOperationFailure>,
    rollback_failures: Vec<SettingsGlobalOperationFailure>,
    /// True when an earlier cross-plane step committed safely or a rollback
    /// was not acknowledged. The caller must reload before retrying.
    partial_applied: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CrossPlaneDependencyError {
    Invalid(String),
    Unavailable,
}

impl CrossPlaneDependencyError {
    fn message(&self) -> &str {
        match self {
            Self::Invalid(message) => message,
            Self::Unavailable => {
                "Unable to read the Settings.Global gates required to validate this update"
            }
        }
    }

    fn status_code(&self) -> StatusCode {
        match self {
            Self::Invalid(_) => StatusCode::BAD_REQUEST,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        }
    }

    pub(super) fn into_response(self) -> Response {
        (self.status_code(), self.message().to_string()).into_response()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CrossPlaneTransitionStep {
    PersistCloud,
    ApplySettingsGlobal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CrossPlaneTransitionPlan {
    steps: Vec<CrossPlaneTransitionStep>,
    cloud_changed: bool,
    settings_global_changed: bool,
}

impl CrossPlaneTransitionPlan {
    fn steps(&self) -> &[CrossPlaneTransitionStep] {
        &self.steps
    }

    fn cloud_changed(&self) -> bool {
        self.cloud_changed
    }

    fn settings_global_changed(&self) -> bool {
        self.settings_global_changed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FeatureFlagSyncObservation {
    sync_requested: bool,
    fresh_fetch_observed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FeatureFlagSyncFailure {
    message: &'static str,
    sync_requested: bool,
}

#[derive(Serialize)]
struct FeatureFlagTransitionDeferredResponse {
    error: &'static str,
    /// True when the cloud plane was durably changed. The dependent Android
    /// gate remains untouched and a retry can complete the transition.
    partial_applied: bool,
    sync_requested: bool,
}

fn settings_global_gate_transition_to_enabled(
    patch: &BTreeMap<String, Option<bool>>,
    reads: &[SettingsGlobalGateRead],
    key: &str,
) -> Result<bool, CrossPlaneDependencyError> {
    let Some(desired_stored_value) = patch.get(key) else {
        return Ok(false);
    };
    let spec = settings_global_feature_gate_spec(key).ok_or_else(|| {
        CrossPlaneDependencyError::Invalid(format!("unknown Settings.Global feature gate `{key}`"))
    })?;
    let read = reads
        .iter()
        .find(|read| read.key == key)
        .filter(|read| read.available)
        .ok_or(CrossPlaneDependencyError::Unavailable)?;
    let current = read.stored_value.unwrap_or(spec.default);
    let desired = desired_stored_value.unwrap_or(spec.default);
    Ok(!current && desired)
}

async fn publish_feature_flags_and_sync<S: FeatureFlagSyncRequester>(
    shared_config: &std::sync::Arc<tokio::sync::RwLock<Config>>,
    delivery_tracker: &FeatureFlagDeliveryTracker,
    candidate: &Config,
    sync_requester: &S,
    require_fresh_fetch: bool,
) -> Result<FeatureFlagSyncObservation, FeatureFlagSyncFailure> {
    let (target_hash, _) = feature_flag_assignment_identity(candidate)
        .map_err(|_| FeatureFlagSyncFailure {
            message: "Cloud feature flags were persisted but could not be published as a valid assignment set. The Android gate was not changed.",
            sync_requested: false,
        })?;
    let baseline_sequence = delivery_tracker.latest_sequence();
    {
        let mut live_config = shared_config.write().await;
        live_config.feature_flags = candidate.feature_flags.clone();
    }

    let sync_requested = sync_requester.request_sync().await;
    if !require_fresh_fetch {
        return Ok(FeatureFlagSyncObservation {
            sync_requested,
            fresh_fetch_observed: false,
        });
    }
    if !sync_requested {
        return Err(FeatureFlagSyncFailure {
            message: "Cloud feature flags are durable and live, but the stock sync request was not accepted. The dependent Android gate was not changed; reload and retry.",
            sync_requested: false,
        });
    }

    if wait_for_fresh_exact_feature_flag_fetch(delivery_tracker, &target_hash, baseline_sequence)
        .await
    {
        Ok(FeatureFlagSyncObservation {
            sync_requested: true,
            fresh_fetch_observed: true,
        })
    } else {
        Err(FeatureFlagSyncFailure {
            message: "Cloud feature flags are durable and live, but no fresh matching stock gRPC fetch was observed. The dependent Android gate was not changed; reload and retry.",
            sync_requested: true,
        })
    }
}

fn feature_flag_assignment_identity(config: &Config) -> Result<(String, u32), String> {
    let assignments = proto_assignments(&config.feature_flags)?;
    let assignment_count = u32::try_from(assignments.len())
        .map_err(|_| "feature-flag assignment set is too large".to_string())?;
    if assignment_count == 0 {
        return Err("feature-flag assignment set must not be empty".into());
    }
    Ok((assignment_set_hash(&assignments), assignment_count))
}

async fn wait_for_fresh_exact_feature_flag_fetch(
    delivery_tracker: &FeatureFlagDeliveryTracker,
    target_hash: &str,
    after_sequence: u64,
) -> bool {
    tokio::time::timeout(FEATURE_FLAG_FETCH_TIMEOUT, async {
        loop {
            if delivery_tracker
                .latest_matching_fetch(target_hash, Some(after_sequence))
                .is_some()
            {
                return true;
            }
            tokio::time::sleep(FEATURE_FLAG_FETCH_POLL_INTERVAL).await;
        }
    })
    .await
    .is_ok()
}

pub(super) async fn get_feature_flags(State(state): State<ApiState>) -> Response {
    let config = state.shared_config.read().await.clone();
    let food_refresh = state.food_runtime_gate.begin_refresh();
    let settings_global = read_settings_global_gates(&SystemSettingsGlobalCommandRunner).await;
    if let Some(refresh) = food_refresh {
        refresh.publish(effective_food_gate_readback(&settings_global));
    }
    let apply_ack = read_feature_flag_apply_ack(&SystemSettingsGlobalCommandRunner)
        .await
        .ok()
        .flatten();
    match feature_flags_response(
        &config,
        None,
        &settings_global,
        &state.feature_flag_delivery,
        apply_ack.as_ref(),
    ) {
        Ok(response) => Json(response).into_response(),
        Err(message) => {
            tracing::error!(%message, "failed to build feature-flag response");
            (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
        }
    }
}

pub(super) async fn update_feature_flags(
    State(state): State<ApiState>,
    Json(body): Json<UpdateFeatureFlagsRequest>,
) -> Response {
    update_feature_flags_with_runner(
        state,
        body,
        &SystemSettingsGlobalCommandRunner,
        &SystemFeatureFlagSyncRequester,
    )
    .await
}

async fn update_feature_flags_with_runner<
    R: SettingsGlobalCommandRunner,
    S: FeatureFlagSyncRequester,
>(
    state: ApiState,
    body: UpdateFeatureFlagsRequest,
    runner: &R,
    sync_requester: &S,
) -> Response {
    let UpdateFeatureFlagsRequest {
        overrides,
        settings_global,
    } = body;

    // Share the config transaction lock with /api/settings so neither
    // endpoint can persist a stale snapshot over the other's update.
    let _update_guard = state.config_update_lock.lock().await;

    // Work against a private candidate. The transaction mutex above prevents
    // another config endpoint from committing a stale snapshot, while keeping
    // the live RwLock available to auth, GET, and FeatureFlags.GetFlags during
    // bounded vault and Android bridge I/O.
    let original = state.shared_config.read().await.clone();
    let mut candidate = original.clone();

    if let Err(message) = apply_updates(&mut candidate, overrides) {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    if let Err(message) = validate_settings_global_patch(&settings_global) {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    // Invalidate before the first Android preflight, and therefore before any
    // possible write. Drop preserves Unknown across every early return or
    // ambiguous rollback. Only the post-apply canonical readback may publish.
    let mut food_mutation = settings_global
        .contains_key(FOOD_SETTINGS_GLOBAL_KEY)
        .then(|| state.food_runtime_gate.begin_mutation());

    // Validate and preflight the complete transaction before the first
    // mutation. Requested Android keys must all be readable so a cloud write
    // can never precede a Settings.Global failure that was knowable up front.
    let settings_global_reads = read_settings_global_gates(runner).await;
    let dependency_scope =
        match cross_plane_dependency_scope(&original, &candidate, &settings_global) {
            Ok(scope) => scope,
            Err(error) => return error.into_response(),
        };
    if let Err(error) = validate_settings_global_dependencies_in_scope(
        &candidate,
        &settings_global,
        &settings_global_reads,
        dependency_scope,
    ) {
        return error.into_response();
    }

    let plan = match plan_cross_plane_transition(
        &original,
        &candidate,
        &settings_global,
        &settings_global_reads,
    ) {
        Ok(plan) => plan,
        Err(error) => return error.into_response(),
    };
    let cloud_changed = plan.cloud_changed();
    let settings_global_changed = plan.settings_global_changed();
    let cmu_enable_requires_fetch = match settings_global_gate_transition_to_enabled(
        &settings_global,
        &settings_global_reads,
        settings_global_keys::CMU_ULTRA_ENABLED,
    ) {
        Ok(requires_fetch) => requires_fetch,
        Err(error) => return error.into_response(),
    };
    let (target_assignment_hash, target_assignment_count) =
        match feature_flag_assignment_identity(&candidate) {
            Ok(identity) => identity,
            Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
        };
    let initial_apply_ack_sequence = if cmu_enable_requires_fetch {
        match read_feature_flag_apply_ack(runner).await {
            Ok(receipt) => receipt.map_or(0, |receipt| receipt.sequence),
            Err(()) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The stock feature-flag application acknowledgement bridge is unavailable; no dependent Android gate was changed.",
                )
                    .into_response();
            }
        }
    } else {
        0
    };

    let mut cloud_persisted = false;
    let mut settings_global_applied = false;
    let mut sync_requested = false;
    let mut fresh_fetch_observed = false;
    let mut stock_cache_verified = false;
    let mut latest_apply_ack = None;
    let mut cloud_sync_attempted = false;
    let mut committed_settings_global = settings_global_reads.clone();
    for step in plan.steps() {
        match step {
            CrossPlaneTransitionStep::PersistCloud => {
                if let Err(error) = persist_config_durably(
                    &state.config_path,
                    &candidate,
                    &original,
                    &state.esim_bridge,
                )
                .await
                {
                    tracing::error!(
                        %error,
                        partial_applied = settings_global_applied,
                        "failed to persist feature flags"
                    );
                    drop(_update_guard);
                    return if settings_global_applied {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Cloud feature flags were not persisted after a dependency-safe Settings.Global step. The safe partial transition remains applied; reload before retrying.",
                        )
                            .into_response()
                    } else {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("failed to persist feature flags: {error}"),
                        )
                            .into_response()
                    };
                }
                cloud_persisted = true;

                match publish_feature_flags_and_sync(
                    &state.shared_config,
                    &state.feature_flag_delivery,
                    &candidate,
                    sync_requester,
                    cmu_enable_requires_fetch,
                )
                .await
                {
                    Ok(observation) => {
                        sync_requested |= observation.sync_requested;
                        fresh_fetch_observed |= observation.fresh_fetch_observed;
                        cloud_sync_attempted = true;
                        if cmu_enable_requires_fetch {
                            let Some(receipt) = wait_for_fresh_exact_feature_flag_apply_ack(
                                runner,
                                &target_assignment_hash,
                                target_assignment_count,
                                initial_apply_ack_sequence,
                            )
                            .await
                            else {
                                drop(_update_guard);
                                return (
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    Json(FeatureFlagTransitionDeferredResponse {
                                        error: "Cloud feature flags are durable and were fetched, but Ironman did not acknowledge applying the exact assignment set. The dependent Android gate was not changed; reload and retry.",
                                        partial_applied: true,
                                        sync_requested,
                                    }),
                                )
                                    .into_response();
                            };
                            stock_cache_verified = true;
                            latest_apply_ack = Some(receipt);
                        }
                    }
                    Err(failure) => {
                        sync_requested |= failure.sync_requested;
                        tracing::warn!(
                            sync_requested,
                            reason = failure.message,
                            "dependent Settings.Global gate deferred until stock fetches the matching cloud flags"
                        );
                        drop(_update_guard);
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(FeatureFlagTransitionDeferredResponse {
                                error: failure.message,
                                partial_applied: true,
                                sync_requested,
                            }),
                        )
                            .into_response();
                    }
                }
            }
            CrossPlaneTransitionStep::ApplySettingsGlobal => {
                // The sync wait can last several seconds. Re-read immediately
                // before mutation so a stale preflight snapshot can never make
                // us skip a requested write or project a value we did not see.
                let apply_reads = read_settings_global_gates(runner).await;
                if let Err(error) = validate_settings_global_dependencies_in_scope(
                    &candidate,
                    &settings_global,
                    &apply_reads,
                    dependency_scope,
                ) {
                    drop(_update_guard);
                    return error.into_response();
                }
                let current_cmu_enable_requires_fetch =
                    match settings_global_gate_transition_to_enabled(
                        &settings_global,
                        &apply_reads,
                        settings_global_keys::CMU_ULTRA_ENABLED,
                    ) {
                        Ok(requires_fetch) => requires_fetch,
                        Err(error) => {
                            drop(_update_guard);
                            return error.into_response();
                        }
                    };
                // Enabling the Android master is the dependency-sensitive
                // edge. Even when this request does not change cloud config,
                // require a fresh exact gRPC fetch before exposing the gate.
                if current_cmu_enable_requires_fetch && !stock_cache_verified {
                    let apply_ack_sequence = match read_feature_flag_apply_ack(runner).await {
                        Ok(receipt) => receipt.map_or(0, |receipt| receipt.sequence),
                        Err(()) => {
                            drop(_update_guard);
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                "The stock feature-flag application acknowledgement bridge is unavailable; no dependent Android gate was changed.",
                            )
                                .into_response();
                        }
                    };
                    match publish_feature_flags_and_sync(
                        &state.shared_config,
                        &state.feature_flag_delivery,
                        &candidate,
                        sync_requester,
                        true,
                    )
                    .await
                    {
                        Ok(observation) => {
                            sync_requested |= observation.sync_requested;
                            fresh_fetch_observed |= observation.fresh_fetch_observed;
                            cloud_sync_attempted = true;
                            let Some(receipt) = wait_for_fresh_exact_feature_flag_apply_ack(
                                runner,
                                &target_assignment_hash,
                                target_assignment_count,
                                apply_ack_sequence,
                            )
                            .await
                            else {
                                drop(_update_guard);
                                return (
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    Json(FeatureFlagTransitionDeferredResponse {
                                        error: "Cloud feature flags were fetched, but Ironman did not acknowledge applying the exact assignment set. The dependent Android gate was not changed; reload and retry.",
                                        partial_applied: cloud_persisted,
                                        sync_requested,
                                    }),
                                )
                                    .into_response();
                            };
                            stock_cache_verified = true;
                            latest_apply_ack = Some(receipt);
                        }
                        Err(failure) => {
                            sync_requested |= failure.sync_requested;
                            tracing::warn!(
                                sync_requested,
                                reason = failure.message,
                                "Settings.Global enable deferred until stock fetches the matching cloud flags"
                            );
                            drop(_update_guard);
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                Json(FeatureFlagTransitionDeferredResponse {
                                    error: failure.message,
                                    partial_applied: cloud_persisted,
                                    sync_requested,
                                }),
                            )
                                .into_response();
                        }
                    }
                }
                let cache_guard = if current_cmu_enable_requires_fetch {
                    match latest_apply_ack.as_ref() {
                        Some(receipt) => Some(receipt),
                        None => {
                            drop(_update_guard);
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                "The stock feature-flag application acknowledgement was lost before the dependent Android gate could be changed.",
                            )
                                .into_response();
                        }
                    }
                } else {
                    None
                };
                match apply_settings_global_updates(
                    runner,
                    &settings_global,
                    &apply_reads,
                    cache_guard,
                )
                .await
                {
                    Ok(changed) => {
                        settings_global_applied = changed;
                        committed_settings_global = read_settings_global_gates(runner).await;
                        if let Some(mutation) = food_mutation.take() {
                            match effective_food_gate_readback(&committed_settings_global) {
                                Some(enabled) => mutation.publish(Some(enabled)),
                                None => drop(mutation),
                            }
                        }
                    }
                    Err(failure) => {
                        // Never roll one durable plane back across another.
                        // The planner proved this earlier cloud state safe with
                        // the original gates, and PersistCloud already
                        // published/synchronized it before reaching this step.
                        let partial_applied =
                            cloud_persisted || !failure.rollback_failures.is_empty();
                        tracing::warn!(
                            failures = failure.failures.len(),
                            rollback_failures = failure.rollback_failures.len(),
                            partial_applied,
                            "Settings.Global feature-gate apply failed"
                        );
                        drop(_update_guard);
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(failure.response(partial_applied)),
                        )
                            .into_response();
                    }
                }
            }
        }
    }

    let snapshot = {
        let mut live_config = state.shared_config.write().await;
        if cloud_persisted {
            live_config.feature_flags = candidate.feature_flags.clone();
        }
        live_config.clone()
    };
    if latest_apply_ack.is_none() {
        latest_apply_ack = read_feature_flag_apply_ack(runner).await.ok().flatten();
    }
    stock_cache_verified |= latest_apply_ack.as_ref().is_some_and(|receipt| {
        receipt.assignment_set_hash == target_assignment_hash
            && receipt.assignment_count == target_assignment_count
    });
    // The transaction is durable, published, and any dependency-sensitive
    // fetch barrier has completed. Response-only work must not hold the
    // mutation lock.
    drop(_update_guard);

    tracing::info!(
        cloud_changed,
        settings_global_changed,
        sync_requested,
        fresh_fetch_observed,
        stock_cache_verified,
        cloud_sync_attempted,
        "feature flags updated"
    );
    let response = match feature_flags_response(
        &snapshot,
        Some(sync_requested),
        &committed_settings_global,
        &state.feature_flag_delivery,
        latest_apply_ack.as_ref(),
    ) {
        Ok(response) => response,
        Err(message) => {
            tracing::error!(%message, "failed to build updated feature-flag response");
            return (StatusCode::INTERNAL_SERVER_ERROR, message).into_response();
        }
    };
    Json(response).into_response()
}

fn apply_updates(
    config: &mut Config,
    overrides: BTreeMap<String, Option<FeatureFlagValueDto>>,
) -> Result<(), String> {
    let mut candidate = config.feature_flags.clone();

    for (key, value) in overrides {
        let spec =
            feature_flag_spec(&key).ok_or_else(|| format!("unknown feature flag `{key}`"))?;
        if !spec.writable && value.is_some() {
            return Err(format!("feature flag `{key}` is not writable"));
        }

        match value {
            Some(value) => {
                candidate.overrides.insert(key, value.into());
            }
            None => {
                candidate.overrides.remove(&key);
            }
        }
    }

    validate_feature_flags(&candidate)?;
    config.feature_flags = candidate;
    Ok(())
}

fn validate_settings_global_patch(patch: &BTreeMap<String, Option<bool>>) -> Result<(), String> {
    for (key, value) in patch {
        let spec = settings_global_feature_gate_spec(key)
            .ok_or_else(|| format!("unknown Settings.Global feature gate `{key}`"))?;
        // A locked gate still accepts its declared safe default or null so an
        // unsafe legacy value can be recovered through the dashboard. This
        // applies equally to default-off gates and the default-on JPG gate.
        if !spec.writable && value.is_some_and(|value| value != spec.default) {
            return Err(format!(
                "Settings.Global feature gate `{key}` is not writable"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
fn validate_settings_global_dependencies(
    config: &Config,
    patch: &BTreeMap<String, Option<bool>>,
    reads: &[SettingsGlobalGateRead],
) -> Result<(), CrossPlaneDependencyError> {
    validate_settings_global_dependencies_in_scope(
        config,
        patch,
        reads,
        CrossPlaneDependencyScope::all(),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CrossPlaneDependencyScope {
    cmu: bool,
}

impl CrossPlaneDependencyScope {
    #[cfg(test)]
    const fn all() -> Self {
        Self { cmu: true }
    }
}

fn cross_plane_dependency_scope(
    original: &Config,
    candidate: &Config,
    patch: &BTreeMap<String, Option<bool>>,
) -> Result<CrossPlaneDependencyScope, CrossPlaneDependencyError> {
    let cmu = patch.contains_key(settings_global_keys::CMU_ULTRA_ENABLED)
        || effective_cloud_bool(original, cloud_keys::CMU_ULTRA_ENABLED)?
            != effective_cloud_bool(candidate, cloud_keys::CMU_ULTRA_ENABLED)?;
    Ok(CrossPlaneDependencyScope { cmu })
}

fn validate_settings_global_dependencies_in_scope(
    config: &Config,
    patch: &BTreeMap<String, Option<bool>>,
    reads: &[SettingsGlobalGateRead],
    scope: CrossPlaneDependencyScope,
) -> Result<(), CrossPlaneDependencyError> {
    if scope.cmu {
        let global_cmu_enabled =
            effective_settings_global_bool(patch, reads, settings_global_keys::CMU_ULTRA_ENABLED)?;
        let cloud_cmu_enabled = effective_cloud_bool(config, cloud_keys::CMU_ULTRA_ENABLED)?;

        if global_cmu_enabled && !cloud_cmu_enabled {
            return Err(CrossPlaneDependencyError::Invalid(format!(
                "`{}=true` requires the cloud `{}` assignment to remain enabled",
                settings_global_keys::CMU_ULTRA_ENABLED,
                cloud_keys::CMU_ULTRA_ENABLED,
            )));
        }
    }

    Ok(())
}

fn settings_global_patch_changed(
    patch: &BTreeMap<String, Option<bool>>,
    reads: &[SettingsGlobalGateRead],
) -> Result<bool, CrossPlaneDependencyError> {
    let mut changed = false;
    for (key, desired) in patch {
        let read = reads
            .iter()
            .find(|read| read.key == key)
            .filter(|read| read.available)
            .ok_or(CrossPlaneDependencyError::Unavailable)?;
        changed |= read.stored_value != *desired;
    }
    Ok(changed)
}

fn plan_cross_plane_transition(
    original: &Config,
    candidate: &Config,
    settings_global: &BTreeMap<String, Option<bool>>,
    reads: &[SettingsGlobalGateRead],
) -> Result<CrossPlaneTransitionPlan, CrossPlaneDependencyError> {
    let dependency_scope = cross_plane_dependency_scope(original, candidate, settings_global)?;
    let cloud_changed = candidate.feature_flags != original.feature_flags;
    let settings_global_changed = settings_global_patch_changed(settings_global, reads)?;
    // Every non-empty Android patch gets an apply/verify step even when the
    // preflight value already matches. Otherwise an external write during the
    // cloud sync wait can be silently missed and the response can lie.
    let settings_global_requested = !settings_global.is_empty();
    let steps = match (cloud_changed, settings_global_requested) {
        (false, false) => Vec::new(),
        (true, false) => vec![CrossPlaneTransitionStep::PersistCloud],
        (false, true) => vec![CrossPlaneTransitionStep::ApplySettingsGlobal],
        (true, true) => {
            // Cloud-first means the candidate cloud values coexist durably
            // with the original Android gates until the second write lands.
            let cloud_first_safe = validate_settings_global_dependencies_in_scope(
                candidate,
                &BTreeMap::new(),
                reads,
                dependency_scope,
            )
            .is_ok();
            // Settings-first means the original cloud values coexist durably
            // with the requested Android gates until cloud persistence lands.
            let settings_first_safe = validate_settings_global_dependencies_in_scope(
                original,
                settings_global,
                reads,
                dependency_scope,
            )
            .is_ok();
            match (cloud_first_safe, settings_first_safe) {
                (true, _) => vec![
                    CrossPlaneTransitionStep::PersistCloud,
                    CrossPlaneTransitionStep::ApplySettingsGlobal,
                ],
                (false, true) => vec![
                    CrossPlaneTransitionStep::ApplySettingsGlobal,
                    CrossPlaneTransitionStep::PersistCloud,
                ],
                (false, false) => {
                    return Err(CrossPlaneDependencyError::Invalid(
                        "This cross-plane feature change has no dependency-safe one-step ordering; apply it as separate safe requests"
                            .into(),
                    ));
                }
            }
        }
    };
    Ok(CrossPlaneTransitionPlan {
        steps,
        cloud_changed,
        settings_global_changed,
    })
}

fn effective_cloud_bool(config: &Config, key: &str) -> Result<bool, CrossPlaneDependencyError> {
    let spec = feature_flag_spec(key).ok_or_else(|| {
        CrossPlaneDependencyError::Invalid(format!("unknown feature flag `{key}`"))
    })?;
    let value = config
        .feature_flags
        .overrides
        .get(key)
        .cloned()
        .unwrap_or_else(|| {
            spec.penumbra_default
                .unwrap_or(spec.firmware_default)
                .to_configured()
        });
    match value {
        ConfiguredFeatureFlagValue::Bool(value) => Ok(value),
        _ => Err(CrossPlaneDependencyError::Invalid(format!(
            "feature flag `{key}` is not boolean"
        ))),
    }
}

fn effective_settings_global_bool(
    patch: &BTreeMap<String, Option<bool>>,
    reads: &[SettingsGlobalGateRead],
    key: &str,
) -> Result<bool, CrossPlaneDependencyError> {
    let spec = settings_global_feature_gate_spec(key).ok_or_else(|| {
        CrossPlaneDependencyError::Invalid(format!("unknown Settings.Global feature gate `{key}`"))
    })?;
    if let Some(value) = patch.get(key) {
        return Ok(value.unwrap_or(spec.default));
    }
    let read = reads
        .iter()
        .find(|read| read.key == key)
        .filter(|read| read.available)
        .ok_or(CrossPlaneDependencyError::Unavailable)?;
    Ok(read.stored_value.unwrap_or(read.default))
}

fn parse_settings_global_value(value: &str) -> Result<Option<bool>, ()> {
    match value.trim() {
        "" | "null" => Ok(None),
        "0" | "false" => Ok(Some(false)),
        "1" | "true" => Ok(Some(true)),
        _ => Err(()),
    }
}

async fn run_settings_global_command<R: SettingsGlobalCommandRunner>(
    runner: &R,
    command: SettingsGlobalCommand,
) -> Result<String, ()> {
    // Bound every runner, not only the production process runner. Tests and
    // alternate runners therefore cannot pin shared_config's write lock.
    run_command_with_timeout(runner.run(command)).await
}

async fn read_feature_flag_apply_ack<R: SettingsGlobalCommandRunner>(
    runner: &R,
) -> Result<Option<FeatureFlagApplyAckReceipt>, ()> {
    let encoded =
        run_settings_global_command(runner, SettingsGlobalCommand::FeatureFlagApplyAck).await?;
    if encoded == "null" {
        return Ok(None);
    }
    let receipt: FeatureFlagApplyAckReceipt = serde_json::from_str(&encoded).map_err(|_| ())?;
    if receipt.sequence == 0
        || receipt.assignment_count == 0
        || receipt.assignment_count > 256
        || receipt.applied_at_unix_ms == 0
        || receipt.assignment_set_hash.len() != 64
        || !valid_lowercase_hex(&receipt.assignment_set_hash)
    {
        return Err(());
    }
    Ok(Some(receipt))
}

/// Verify that the complete feature-flag assignment set currently desired by
/// the server was both fetched by stock and applied to Ironman's live cache.
/// A successful gRPC fetch alone is deliberately insufficient: callers that
/// exercise a gated stock feature must not race the cache update and report a
/// misleading action failure.
pub(super) async fn current_stock_cache_delivery_verified(
    config: &Config,
    delivery_tracker: &FeatureFlagDeliveryTracker,
) -> Result<bool, ()> {
    let (target_hash, target_count) = feature_flag_assignment_identity(config).map_err(|_| ())?;
    let apply_ack = read_feature_flag_apply_ack(&SystemSettingsGlobalCommandRunner).await?;
    Ok(matching_stock_cache_apply_ack(
        &target_hash,
        target_count,
        delivery_tracker,
        apply_ack.as_ref(),
    )
    .is_some())
}

async fn wait_for_fresh_exact_feature_flag_apply_ack<R: SettingsGlobalCommandRunner>(
    runner: &R,
    target_hash: &str,
    target_count: u32,
    after_sequence: u64,
) -> Option<FeatureFlagApplyAckReceipt> {
    tokio::time::timeout(FEATURE_FLAG_FETCH_TIMEOUT, async {
        loop {
            if let Ok(Some(receipt)) = read_feature_flag_apply_ack(runner).await {
                if receipt.sequence > after_sequence
                    && receipt.assignment_set_hash == target_hash
                    && receipt.assignment_count == target_count
                {
                    return receipt;
                }
            }
            tokio::time::sleep(FEATURE_FLAG_FETCH_POLL_INTERVAL).await;
        }
    })
    .await
    .ok()
}

async fn feature_flag_apply_ack_still_matches<R: SettingsGlobalCommandRunner>(
    runner: &R,
    expected: &FeatureFlagApplyAckReceipt,
) -> bool {
    read_feature_flag_apply_ack(runner)
        .await
        .ok()
        .flatten()
        .is_some_and(|current| current.still_matches(expected))
}

async fn read_settings_global_gates<R: SettingsGlobalCommandRunner>(
    runner: &R,
) -> Vec<SettingsGlobalGateRead> {
    let mut reads = Vec::with_capacity(SETTINGS_GLOBAL_FEATURE_GATES.len());
    for spec in SETTINGS_GLOBAL_FEATURE_GATES {
        reads.push(read_settings_global_gate(runner, spec).await);
    }
    reads
}

fn effective_food_gate_readback(reads: &[SettingsGlobalGateRead]) -> Option<bool> {
    let read = reads
        .iter()
        .find(|read| read.key == FOOD_SETTINGS_GLOBAL_KEY)
        .filter(|read| read.available)?;
    Some(read.stored_value.unwrap_or(read.default))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn refresh_food_runtime_gate_with_runner<R: SettingsGlobalCommandRunner>(
    gate: &FoodRuntimeGate,
    runner: &R,
) -> bool {
    let Some(refresh) = gate.begin_refresh() else {
        return false;
    };
    let spec = settings_global_feature_gate_spec(FOOD_SETTINGS_GLOBAL_KEY)
        .expect("food gate is part of the static allowlist");
    let read = read_settings_global_gate(runner, spec).await;
    let value = read
        .available
        .then_some(read.stored_value.unwrap_or(read.default));
    refresh.publish(value);
    value.is_some()
}

async fn read_settings_global_gate<R: SettingsGlobalCommandRunner>(
    runner: &R,
    spec: &'static crate::feature_flags::SettingsGlobalFeatureGateSpec,
) -> SettingsGlobalGateRead {
    let result = run_settings_global_command(
        runner,
        SettingsGlobalCommand::Get {
            key: spec.key.to_string(),
        },
    )
    .await;
    let (stored_value, available) = match result {
        Ok(value) => match parse_settings_global_value(&value) {
            Ok(value) => (value, true),
            Err(()) => {
                tracing::warn!(
                    key = spec.key,
                    "Settings.Global gate had an invalid boolean representation"
                );
                (None, false)
            }
        },
        Err(_) => {
            tracing::warn!(
                key = spec.key,
                "unable to read Settings.Global feature gate"
            );
            (None, false)
        }
    };
    SettingsGlobalGateRead {
        key: spec.key,
        label: spec.label,
        default: spec.default,
        writable: spec.writable,
        warning: spec.warning,
        restart_recommended: spec.restart_recommended,
        stored_value,
        available,
    }
}

fn settings_global_command_for(key: &str, value: Option<bool>) -> SettingsGlobalCommand {
    match value {
        Some(value) => SettingsGlobalCommand::Put {
            key: key.to_string(),
            value,
        },
        None => SettingsGlobalCommand::Delete {
            key: key.to_string(),
        },
    }
}

async fn apply_settings_global_updates<R: SettingsGlobalCommandRunner>(
    runner: &R,
    patch: &BTreeMap<String, Option<bool>>,
    reads: &[SettingsGlobalGateRead],
    cache_guard: Option<&FeatureFlagApplyAckReceipt>,
) -> Result<bool, SettingsGlobalApplyFailure> {
    if patch.is_empty() {
        return Ok(false);
    }

    let mut original = BTreeMap::new();
    let mut preflight_failures = Vec::new();
    for key in patch.keys() {
        match reads.iter().find(|read| read.key == key) {
            Some(read) if read.available => {
                original.insert(key.clone(), read.stored_value);
            }
            _ => preflight_failures.push(SettingsGlobalOperationFailure {
                key: key.clone(),
                operation: "read",
            }),
        }
    }
    if !preflight_failures.is_empty() {
        return Err(SettingsGlobalApplyFailure {
            failures: preflight_failures,
            rollback_failures: Vec::new(),
        });
    }

    if let Some(expected) = cache_guard {
        if !feature_flag_apply_ack_still_matches(runner, expected).await {
            return Err(SettingsGlobalApplyFailure {
                failures: vec![SettingsGlobalOperationFailure {
                    key: settings_global_keys::CMU_ULTRA_ENABLED.into(),
                    operation: "cache_guard",
                }],
                rollback_failures: Vec::new(),
            });
        }
    }

    let mut applied: Vec<String> = Vec::new();
    for (key, desired) in patch {
        let previous = original
            .get(key)
            .copied()
            .expect("preflight recorded every requested key");
        if previous == *desired {
            continue;
        }

        if run_settings_global_command(runner, settings_global_command_for(key, *desired))
            .await
            .is_err()
        {
            let mut rollback_failures = Vec::new();
            // The failed command may have partially applied, so restore it too,
            // then unwind every earlier successful write in reverse order.
            for rollback_key in std::iter::once(key).chain(applied.iter().rev()) {
                let rollback_value = original
                    .get(rollback_key.as_str())
                    .copied()
                    .expect("rollback keys came from preflight");
                if run_settings_global_command(
                    runner,
                    settings_global_command_for(rollback_key, rollback_value),
                )
                .await
                .is_err()
                {
                    rollback_failures.push(SettingsGlobalOperationFailure {
                        key: rollback_key.to_string(),
                        operation: "rollback",
                    });
                }
            }
            return Err(SettingsGlobalApplyFailure {
                failures: vec![SettingsGlobalOperationFailure {
                    key: key.clone(),
                    operation: "apply",
                }],
                rollback_failures,
            });
        }
        applied.push(key.clone());
    }

    let mut verification_failures = Vec::new();
    for (key, desired) in patch {
        let verified =
            run_settings_global_command(runner, SettingsGlobalCommand::Get { key: key.clone() })
                .await
                .ok()
                .and_then(|value| parse_settings_global_value(&value).ok());
        if verified != Some(*desired) {
            verification_failures.push(SettingsGlobalOperationFailure {
                key: key.clone(),
                operation: "verify",
            });
        }
    }
    if !verification_failures.is_empty() {
        let mut rollback_failures = Vec::new();
        for rollback_key in applied.iter().rev() {
            let rollback_value = original
                .get(rollback_key.as_str())
                .copied()
                .expect("rollback keys came from preflight");
            if run_settings_global_command(
                runner,
                settings_global_command_for(rollback_key, rollback_value),
            )
            .await
            .is_err()
            {
                rollback_failures.push(SettingsGlobalOperationFailure {
                    key: rollback_key.clone(),
                    operation: "rollback",
                });
            }
        }
        return Err(SettingsGlobalApplyFailure {
            failures: verification_failures,
            rollback_failures,
        });
    }

    // Make the exact stock-cache receipt the final transaction postcondition.
    // Checking after Settings.Global readback narrows the point-in-time proof: a
    // stock cache writer observed during either the write or verification phase
    // forces the dependent gate back to its original value.
    if let Some(expected) = cache_guard {
        if !feature_flag_apply_ack_still_matches(runner, expected).await {
            let mut rollback_failures = Vec::new();
            for rollback_key in applied.iter().rev() {
                let rollback_value = original
                    .get(rollback_key.as_str())
                    .copied()
                    .expect("rollback keys came from preflight");
                if run_settings_global_command(
                    runner,
                    settings_global_command_for(rollback_key, rollback_value),
                )
                .await
                .is_err()
                {
                    rollback_failures.push(SettingsGlobalOperationFailure {
                        key: rollback_key.clone(),
                        operation: "rollback",
                    });
                }
            }
            return Err(SettingsGlobalApplyFailure {
                failures: vec![SettingsGlobalOperationFailure {
                    key: settings_global_keys::CMU_ULTRA_ENABLED.into(),
                    operation: "cache_guard",
                }],
                rollback_failures,
            });
        }
    }

    Ok(!applied.is_empty())
}

fn feature_flags_response(
    config: &Config,
    sync_requested: Option<bool>,
    settings_global: &[SettingsGlobalGateRead],
    delivery_tracker: &FeatureFlagDeliveryTracker,
    apply_ack: Option<&FeatureFlagApplyAckReceipt>,
) -> Result<FeatureFlagsResponse, String> {
    let desired_assignments = proto_assignments(&config.feature_flags)?;
    let desired_assignment_hash = assignment_set_hash(&desired_assignments);
    let desired_assignment_count = u32::try_from(desired_assignments.len())
        .map_err(|_| "feature-flag assignment set is too large".to_string())?;
    let matching_fetch = delivery_tracker.latest_matching_fetch(&desired_assignment_hash, None);
    let matching_apply_ack = matching_stock_cache_apply_ack(
        &desired_assignment_hash,
        desired_assignment_count,
        delivery_tracker,
        apply_ack,
    );
    let delivery_state = if matching_apply_ack.is_some() {
        FeatureFlagDeliveryState::StockCacheApplied
    } else if matching_fetch.is_some() {
        FeatureFlagDeliveryState::GrpcFetched
    } else if sync_requested == Some(true) {
        FeatureFlagDeliveryState::SyncDispatched
    } else {
        FeatureFlagDeliveryState::Persisted
    };

    let flags = FEATURE_FLAG_SPECS
        .iter()
        .map(|spec| {
            let override_value = config.feature_flags.overrides.get(spec.key);
            let (desired_value, assignment_value, source) = if let Some(value) = override_value {
                let value = FeatureFlagValueDto::from(value);
                (value.clone(), Some(value), "override")
            } else if let Some(value) = spec.penumbra_default {
                let value = FeatureFlagValueDto::from(value);
                (value.clone(), Some(value), "penumbra_default")
            } else {
                (
                    FeatureFlagValueDto::from(spec.firmware_default),
                    None,
                    "firmware_default",
                )
            };

            FeatureFlagDefinitionResponse {
                key: spec.key,
                label: spec.label,
                description: spec.description,
                value_type: spec.value_type.as_str(),
                firmware_default: FeatureFlagValueDto::from(spec.firmware_default),
                penumbra_default: spec.penumbra_default.map(FeatureFlagValueDto::from),
                override_value: override_value.map(FeatureFlagValueDto::from),
                desired_value,
                assignment_value,
                source,
                writable: spec.writable,
                warning: spec.warning,
                restart_recommended: spec.restart_recommended,
            }
        })
        .collect();

    Ok(FeatureFlagsResponse {
        flags,
        settings_global_gates: settings_global
            .iter()
            .map(SettingsGlobalGateRead::response)
            .collect(),
        settings_global_note: "These stock gates are read and written directly through Android Settings.Global. They never enter FeatureFlagsService assignments.",
        delivery: FeatureFlagDeliveryResponse {
            state: delivery_state,
            desired_assignment_hash,
            grpc_fetch_observed: matching_fetch.is_some(),
            last_grpc_fetch_unix_ms: matching_fetch
                .as_ref()
                .map(|receipt| receipt.fetched_at_unix_ms),
            stock_cache_verified: matching_apply_ack.is_some(),
            last_stock_cache_apply_unix_ms: matching_apply_ack
                .map(|receipt| receipt.applied_at_unix_ms),
            immediate_sync_supported: cfg!(target_os = "android"),
            automatic_triggers: &[
                "save broadcast",
                "Penumbra server startup",
                "Ironman startup",
                "daily",
                "push",
            ],
            note: "Delivery is evidence-based: persisted means only the server desired state is durable; sync dispatched means the Android broadcast command was accepted; gRPC fetched means the exact assignment set was returned by FeatureFlags.GetFlags; stock cache applied means Ironman completed setServerFlags and exact manager readback for that assignment identity. Individual long-lived consumers may still require the documented restart.",
        },
        sync_requested,
    })
}

fn matching_stock_cache_apply_ack<'a>(
    desired_assignment_hash: &str,
    desired_assignment_count: u32,
    delivery_tracker: &FeatureFlagDeliveryTracker,
    apply_ack: Option<&'a FeatureFlagApplyAckReceipt>,
) -> Option<&'a FeatureFlagApplyAckReceipt> {
    let matching_fetch = delivery_tracker.latest_matching_fetch(desired_assignment_hash, None)?;
    apply_ack.filter(|receipt| {
        receipt.assignment_set_hash == desired_assignment_hash
            && receipt.assignment_count == desired_assignment_count
            && receipt.applied_at_unix_ms >= matching_fetch.fetched_at_unix_ms
    })
}

async fn request_immediate_feature_flag_sync() -> bool {
    #[cfg(not(target_os = "android"))]
    {
        false
    }

    #[cfg(target_os = "android")]
    {
        let mut command = tokio::process::Command::new("/system/bin/am");
        command.args(["broadcast", "-a", FORCE_FLAG_SYNC_ACTION]);
        command.kill_on_drop(true);

        if command_output_succeeded_within_timeout(command.output()).await {
            tracing::info!("requested immediate device feature-flag sync");
            true
        } else {
            // Spawn errors, rejected broadcasts, and timeouts are deliberately
            // one generic best-effort failure category at the API boundary.
            tracing::warn!("feature-flag sync broadcast failed");
            false
        }
    }
}

/// Re-establish fresh delivery evidence after every native server start.
///
/// Both the gRPC fetch tracker and the Android apply acknowledgement are
/// deliberately process-private. Waiting until the listeners are bound, then
/// asking stock Ironman to perform its normal sync, regenerates that evidence
/// without persisting or trusting a stale receipt across process lifetimes.
#[cfg(target_os = "android")]
pub(crate) async fn request_startup_feature_flag_sync(
    delivery_tracker: FeatureFlagDeliveryTracker,
) -> bool {
    request_startup_feature_flag_sync_with(
        &delivery_tracker,
        &STARTUP_FEATURE_FLAG_SYNC_DELAYS,
        STARTUP_FEATURE_FLAG_FETCH_TIMEOUT,
        request_immediate_feature_flag_sync,
    )
    .await
}

/// Keep the process-local food permit fresh without performing Android I/O on
/// a user prompt. Each bridge read is independently timeout-bounded; a failed
/// or malformed read immediately publishes Unknown, and the next periodic
/// pass retries from scratch.
#[cfg(target_os = "android")]
pub(crate) async fn maintain_food_runtime_gate(gate: FoodRuntimeGate) {
    loop {
        if refresh_food_runtime_gate_with_runner(&gate, &SystemSettingsGlobalCommandRunner).await {
            tracing::debug!(
                key = FOOD_SETTINGS_GLOBAL_KEY,
                "refreshed Settings.Global runtime gate"
            );
        } else {
            tracing::warn!(
                key = FOOD_SETTINGS_GLOBAL_KEY,
                "Settings.Global runtime gate is unavailable"
            );
        }
        tokio::time::sleep(FOOD_RUNTIME_GATE_REFRESH_INTERVAL).await;
    }
}

#[cfg(any(target_os = "android", test))]
async fn request_startup_feature_flag_sync_with<F, Fut>(
    delivery_tracker: &FeatureFlagDeliveryTracker,
    delays: &[Duration],
    fetch_timeout: Duration,
    mut request_sync: F,
) -> bool
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let baseline_sequence = delivery_tracker.latest_sequence();
    for &delay in delays {
        tokio::time::sleep(delay).await;
        if delivery_tracker.latest_sequence() > baseline_sequence {
            return true;
        }
        if !request_sync().await {
            continue;
        }
        if wait_for_feature_flag_fetch_after(delivery_tracker, baseline_sequence, fetch_timeout)
            .await
        {
            return true;
        }
    }
    false
}

#[cfg(any(target_os = "android", test))]
async fn wait_for_feature_flag_fetch_after(
    delivery_tracker: &FeatureFlagDeliveryTracker,
    baseline_sequence: u64,
    timeout: Duration,
) -> bool {
    tokio::time::timeout(timeout, async {
        loop {
            if delivery_tracker.latest_sequence() > baseline_sequence {
                return;
            }
            tokio::time::sleep(FEATURE_FLAG_FETCH_POLL_INTERVAL).await;
        }
    })
    .await
    .is_ok()
}

#[cfg(any(target_os = "android", test))]
async fn command_output_succeeded_within_timeout<F, E>(future: F) -> bool
where
    F: Future<Output = Result<std::process::Output, E>>,
{
    matches!(
        run_command_with_timeout(future).await,
        Ok(output) if output.status.success()
    )
}

#[cfg(test)]
#[path = "feature_flags/tests.rs"]
mod tests;
