//! REST/JSON API for the web portal.
//!
//! These endpoints are consumed by the Pin Setup web app over the Local
//! Network Access (LNA) API.  All responses include CORS headers so the
//! public HTTPS portal can reach this HTTP server on the LAN.

mod activity;
mod auth;
mod contacts;
mod conversations;
mod dev;
pub mod device;
mod esim;
mod feature_flags;
pub(crate) mod setup;
#[cfg(target_os = "android")]
pub(crate) use feature_flags::{maintain_food_runtime_gate, request_startup_feature_flag_sync};
mod fitness;
mod media;
mod spotify;
mod traces;

pub(crate) async fn sync_weather_temperature_unit_to_device(
    unit: TemperatureUnit,
) -> Result<(), String> {
    feature_flags::sync_weather_temperature_unit(unit).await
}

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
#[cfg(target_os = "android")]
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, put};
use axum::{Json, Router};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

use crate::config::{
    normalize_iroh_remote_center_allowed_peers, validate_admin_token, Config, TemperatureUnit,
};
use crate::db::Database;
use crate::dedup::DedupHandle;
use crate::esim::EsimBridge;
use crate::fitness::FitnessStore;
use crate::llm::memory::MemoryService;
use crate::llm::LlmRequestLogger;
use crate::services::aibus::{AiBus, CompositionServiceImpl, FoodRuntimeGate};
use crate::services::featureflags::FeatureFlagDeliveryTracker;
use crate::services::speech::SpeechServiceImpl;
use crate::spotify::SpotifyService;
use crate::storage::{MediaStore, MemoryRecord};
use crate::turn_trace_log::TurnTraceLogger;
use device::{DeviceApi, DeviceVersionSnapshot};

pub(crate) use auth::{require_admin_auth, AdminAuthState};

#[cfg(target_os = "android")]
const CONFIG_VAULT_COMMIT_TIMEOUT: Duration = Duration::from_secs(5);

// ─── Shared state ───────────────────────────────────────────────────

/// State shared across all API handlers.
#[derive(Clone)]
pub struct ApiState {
    pub store: Arc<Mutex<MediaStore>>,
    pub db: Database,
    pub events_tx: tokio::sync::broadcast::Sender<Event>,
    /// Path to config.toml on disk — needed for writing settings back.
    pub config_path: PathBuf,
    /// Live config that can be updated at runtime.
    pub shared_config: Arc<RwLock<Config>>,
    /// Observes the latest complete assignment set fetched over stock gRPC.
    /// This is delivery evidence, not proof that the stock binder cache or
    /// every long-lived consumer applied the values.
    pub feature_flag_delivery: FeatureFlagDeliveryTracker,
    /// Fresh, tri-state mirror of Android's authoritative
    /// `humane_food_enabled` Settings.Global gate. It is never derived from
    /// cloud feature assignments or provider configuration.
    pub(crate) food_runtime_gate: FoodRuntimeGate,
    /// Serializes every config mutation without using the live config lock as
    /// a transaction lock. Long-running validation and service construction
    /// must happen against a private candidate while this lock is held.
    pub config_update_lock: Arc<Mutex<()>>,
    /// Currently published memory service. Reuse it when settings leave the
    /// memory configuration unchanged; opening the active Memvid path twice
    /// can block while the old AiBus tree still owns it.
    pub active_memory: Arc<RwLock<Option<MemoryService>>>,
    /// Hot-swappable AiBus service root.
    pub aibus: AiBus,
    /// Hot-swappable stock CompositionService provider root.
    pub composition_service: CompositionServiceImpl,
    /// Hot-swappable stock SpeechService provider root.
    pub speech_service: SpeechServiceImpl,
    /// Dedup cache handle for invalidating stale gRPC responses after config swaps.
    pub dedup: DedupHandle,
    /// Always-on LLM request/response logger.
    pub llm_request_logger: LlmRequestLogger,
    /// Rolling per-turn diagnostic trace log. Writes nothing and creates no
    /// file until `llm.turn_trace` is armed.
    pub turn_trace_logger: TurnTraceLogger,
    /// Shared HTTP client for outbound requests.
    pub http_client: HttpClient,
    /// Directory where rolling log files are written, if file logging is enabled.
    pub log_dir: Option<PathBuf>,
    /// File-name prefix for rolling log files.
    pub log_file_prefix: String,
    /// Persistent eSIM bridge to the Android server app.
    pub esim_bridge: EsimBridge,
    /// One-shot flag consumed by the device contacts sync hook.
    pub contact_client_reset_pending: Arc<AtomicBool>,
    /// Current device software and OS versions.
    pub device_versions: DeviceVersionSnapshot,
    /// LAN-dashboard state of the listener created at process startup. This
    /// remains fixed until restart so the API can report durable pending work.
    pub active_lan_dashboard_enabled: bool,
    /// Experimental Spotify session, pairing, catalog, and playback engine.
    pub spotify: SpotifyService,
    /// App-private, bounded fitness exports surfaced to the authenticated dashboard.
    pub fitness: FitnessStore,
    /// Optional iroh P2P connector for remote Center access.
    #[cfg(feature = "iroh")]
    pub iroh_connector:
        Option<std::sync::Arc<crate::remote_center::iroh_connector::IrohConnectorState>>,
}

// ─── Event types for the streaming endpoint ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    MemoryCreated { memory: MemoryRecord },
    MemoryCompleted { uuid: String },
    MemoryFailed { uuid: String },
    MemoryDeleted { uuid: String },
    Heartbeat,
}

// ─── Router ─────────────────────────────────────────────────────────

/// Build the `/api/*` router.
pub fn router(state: ApiState) -> Router {
    let fitness_router = fitness::router(state.fitness.clone());
    let traces_router =
        traces::router(state.turn_trace_logger.clone(), state.shared_config.clone());
    let router = Router::new()
        .merge(contacts::internal_router())
        .route("/api/health", get(health))
        .route("/api/memories", get(list_memories))
        .route("/api/memories/{uuid}", get(get_memory))
        .route("/api/memories/{uuid}", delete(delete_memory))
        .route("/api/memories/{uuid}/thumbnail/{index}", get(get_thumbnail))
        .route("/api/memories/{uuid}/files/{filename}", get(get_file))
        .nest("/api", contacts::router())
        .route("/api/device", get(DeviceApi::get_device))
        .route("/api/settings", get(get_settings))
        .route("/api/settings", put(update_settings))
        .nest("/api/activity", activity::router())
        .nest("/api", conversations::router())
        .nest("/api", esim::router())
        .route("/api/feature-flags", get(feature_flags::get_feature_flags))
        .route(
            "/api/feature-flags",
            put(feature_flags::update_feature_flags),
        )
        .nest("/api/spotify", spotify::router())
        .route("/api/events", get(event_stream))
        .route("/api/logs/server", get(get_server_logs))
        .route("/api/logs/logcat", get(get_logcat_logs))
        .nest("/api/dev", dev::router());
    // The iroh remote-Center endpoints (ticket + status) exist only with the
    // `iroh` feature. Merge them before the catch-all so `/api/iroh/*` is not
    // swallowed by `api_not_found`, and while `ApiState` is still the router's
    // state type.
    #[cfg(feature = "iroh")]
    let router = router.merge(iroh_endpoints::router());
    router
        // Keep unknown administration paths inside the authenticated API
        // boundary instead of falling through to the public HTTP fallback.
        .route("/api", any(api_not_found))
        .route("/api/{*path}", any(api_not_found))
        .with_state(state)
        .nest("/api/fitness", fitness_router)
        // Carries its own state, like the fitness router above. Merged after
        // the catch-all: a static path wins over `/api/{*path}`.
        .merge(traces_router)
        // Merge public, state-free UI routes only after applying ApiState so
        // they cannot change the state inferred for the administration API.
        .merge(setup::router())
}

async fn api_not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, "not found")
}

// ─── Health ─────────────────────────────────────────────────────────

async fn health(State(state): State<ApiState>) -> Json<serde_json::Value> {
    let config = state.shared_config.read().await;
    let name = config
        .server
        .display_name
        .clone()
        .unwrap_or_else(|| "Ai Pin Revival".into());

    Json(serde_json::json!({
        "status": "ok",
        "name": name,
        "version": env!("PENUMBRA_VERSION"),
    }))
}

// ─── Memories ───────────────────────────────────────────────────────

async fn list_memories(State(state): State<ApiState>) -> Json<Vec<MemoryRecord>> {
    let store = state.store.lock().await;
    Json(store.list_memories().await)
}

async fn get_memory(
    Path(uuid): Path<String>,
    State(state): State<ApiState>,
) -> Result<Json<MemoryRecord>, StatusCode> {
    let store = state.store.lock().await;
    store
        .memory_dir(&uuid)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    match store.get_memory(&uuid).await {
        Some(record) => Ok(Json(record)),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn delete_memory(
    Path(uuid): Path<String>,
    State(state): State<ApiState>,
) -> Result<StatusCode, StatusCode> {
    let mut store = state.store.lock().await;
    store
        .memory_dir(&uuid)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    match store.delete_memory(&uuid).await {
        Ok(true) => {
            let _ = state
                .events_tx
                .send(Event::MemoryDeleted { uuid: uuid.clone() });
            info!("memory deleted via API");
            Ok(StatusCode::NO_CONTENT)
        }
        Ok(false) => Err(StatusCode::NOT_FOUND),
        Err(e) => {
            tracing::error!(error = %e, "failed to delete memory");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

// ─── File serving ───────────────────────────────────────────────────

async fn get_thumbnail(
    Path((uuid, index)): Path<(String, usize)>,
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let store = state.store.lock().await;
    let file = store
        .open_thumbnail_file(&uuid, index)
        .await
        .map_err(media::media_open_status)?;
    drop(store);

    Ok(media::serve_file(file, "image/jpeg", &headers).await)
}

async fn get_file(
    Path((uuid, filename)): Path<(String, String)>,
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let store = state.store.lock().await;
    let file = store
        .open_media_file(&uuid, &filename)
        .await
        .map_err(media::media_open_status)?;
    drop(store);

    let content_type = mime_guess::from_path(&filename)
        .first_or_octet_stream()
        .to_string();

    Ok(media::serve_file(file, &content_type, &headers).await)
}

// ─── Settings ───────────────────────────────────────────────────────

#[derive(Serialize)]
struct SettingsResponse {
    /// True only on a successful settings update that changed a listener
    /// setting. The persisted value takes effect after the server restarts.
    restart_required: bool,
    server: ServerSettingsResponse,
    contacts: ContactsSettingsResponse,
    dev: DevSettingsResponse,
}

#[derive(Serialize)]
struct ServerSettingsResponse {
    /// Capability flag for dashboard clients. The credential itself is
    /// write-only and is never included in a settings response.
    admin_token_auth: bool,
    grpc_bind_addr: String,
    lan_dashboard_enabled: bool,
    display_name: Option<String>,
}

#[derive(Serialize)]
struct ContactsSettingsResponse {
    trust_all_contacts: bool,
    allow_all_inbound: bool,
}

#[derive(Serialize)]
struct DevSettingsResponse {
    apk_install_enabled: bool,
    injected_package_recovery_enabled: bool,
    // Pinned recovery digests are public release identities (SHA256SUMS
    // values), not secrets; return them for operator verification.
    injected_package_recovery_hook_sha256: Option<String>,
    injected_package_recovery_hook_injector_sha256: Option<String>,
}

async fn get_settings(State(state): State<ApiState>) -> Json<SettingsResponse> {
    let config = state.shared_config.read().await;
    Json(settings_response_with_restart(
        &config,
        listener_restart_required(&config, state.active_lan_dashboard_enabled),
    ))
}

#[cfg(test)]
fn settings_response(config: &Config) -> SettingsResponse {
    settings_response_with_restart(config, false)
}

fn settings_response_with_restart(config: &Config, restart_required: bool) -> SettingsResponse {
    SettingsResponse {
        restart_required,
        server: ServerSettingsResponse {
            admin_token_auth: true,
            grpc_bind_addr: config.server.grpc_bind_addr.clone(),
            lan_dashboard_enabled: config.server.lan_dashboard_enabled,
            display_name: config.server.display_name.clone(),
        },
        contacts: ContactsSettingsResponse {
            trust_all_contacts: config.contacts.trust_all_contacts,
            allow_all_inbound: config.contacts.allow_all_inbound,
        },
        dev: DevSettingsResponse {
            apk_install_enabled: config.dev.apk_install_enabled,
            injected_package_recovery_enabled: config.dev.injected_package_recovery_enabled,
            injected_package_recovery_hook_sha256: config
                .dev
                .injected_package_recovery_hook_sha256
                .clone(),
            injected_package_recovery_hook_injector_sha256: config
                .dev
                .injected_package_recovery_hook_injector_sha256
                .clone(),
        },
    }
}

fn listener_restart_required(config: &Config, active_lan_dashboard_enabled: bool) -> bool {
    config.server.lan_dashboard_enabled != active_lan_dashboard_enabled
}

#[derive(Deserialize)]
struct UpdateSettingsRequest {
    llm: Option<serde_json::Value>,
    server: Option<UpdateServerSettings>,
    weather: Option<serde_json::Value>,
    google_maps: Option<serde_json::Value>,
    brave_search: Option<serde_json::Value>,
    open_food_facts: Option<serde_json::Value>,
    azure_speech: Option<serde_json::Value>,
    openstreetmap: Option<serde_json::Value>,
    contacts: Option<UpdateContactsSettings>,
    dev: Option<UpdateDevSettings>,
    /// Storage is read-only; presence in the request is rejected.
    storage: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct UpdateServerSettings {
    /// Read-only — rejected if present.
    http_bind_addr: Option<serde_json::Value>,
    /// Read-only — rejected if present.
    grpc_bind_addr: Option<serde_json::Value>,
    /// Read-only — rejected if present.
    public_addr: Option<serde_json::Value>,
    /// Persisted immediately and applied to the HTTP listener after restart.
    lan_dashboard_enabled: Option<bool>,
    /// Persisted immediately; the iroh connector picks it up on the next server
    /// start (it is initialized once at startup).
    iroh_remote_center_enabled: Option<bool>,
    /// Write-only trusted bridge EndpointIds. Applied on the next server start.
    iroh_remote_center_allowed_peers: Option<Vec<String>>,
    /// Write-only. The administration token cannot be cleared through the API.
    admin_token: Option<String>,
    #[serde(default)]
    system_prompt: FieldPresence,
    #[serde(default)]
    status_prompt: FieldPresence,
    display_name: Option<String>,
}

#[derive(Default)]
struct FieldPresence(bool);

impl<'de> Deserialize<'de> for FieldPresence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let _ = serde::de::IgnoredAny::deserialize(deserializer)?;
        Ok(Self(true))
    }
}

#[derive(Deserialize)]
struct UpdateContactsSettings {
    trust_all_contacts: Option<bool>,
    allow_all_inbound: Option<bool>,
}

#[derive(Deserialize)]
struct UpdateDevSettings {
    apk_install_enabled: Option<bool>,
    injected_package_recovery_enabled: Option<bool>,
    // Empty string clears a pin; a non-empty value must be 64 lowercase hex
    // (validated by DevConfig::validate before persistence).
    injected_package_recovery_hook_sha256: Option<String>,
    injected_package_recovery_hook_injector_sha256: Option<String>,
}

async fn update_settings(
    State(state): State<ApiState>,
    Json(body): Json<UpdateSettingsRequest>,
) -> Response {
    if contains_cosmos_owned_settings(&body) {
        return (
            StatusCode::BAD_REQUEST,
            "assistant, search, maps, weather and speech providers are configured in Cosmos",
        )
            .into_response();
    }
    if contains_cosmos_owned_prompt(&body) {
        return (
            StatusCode::BAD_REQUEST,
            "assistant instructions are configured in Cosmos",
        )
            .into_response();
    }

    if let Some(ref server) = body.server {
        if server.http_bind_addr.is_some() {
            return (
                StatusCode::BAD_REQUEST,
                "http_bind_addr cannot be changed at runtime (requires server restart)",
            )
                .into_response();
        }
        if server.grpc_bind_addr.is_some() {
            return (
                StatusCode::BAD_REQUEST,
                "grpc_bind_addr cannot be changed at runtime (requires server restart)",
            )
                .into_response();
        }
        if server.public_addr.is_some() {
            return (
                StatusCode::BAD_REQUEST,
                "public_addr cannot be changed at runtime (requires server restart)",
            )
                .into_response();
        }
        if admin_token_update_conflicts_with_environment(
            server.admin_token.is_some(),
            std::env::var_os("PENUMBRA_ADMIN_TOKEN").is_some(),
        ) {
            return (
                StatusCode::BAD_REQUEST,
                "admin token is managed by the process environment",
            )
                .into_response();
        }
    }
    if body.storage.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            "storage paths cannot be changed at runtime (requires server restart)",
        )
            .into_response();
    }

    let _update_guard = state.config_update_lock.lock().await;
    let original_config = state.shared_config.read().await.clone();
    let mut config = original_config.clone();

    if let Some(ref server) = body.server {
        if let Some(enabled) = server.lan_dashboard_enabled {
            config.server.lan_dashboard_enabled = enabled;
        }
        if let Some(enabled) = server.iroh_remote_center_enabled {
            config.server.iroh_remote_center_enabled = enabled;
        }
        if let Some(peers) = server.iroh_remote_center_allowed_peers.clone() {
            config.server.iroh_remote_center_allowed_peers =
                match normalize_iroh_remote_center_allowed_peers(peers) {
                    Ok(peers) => peers,
                    Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
                };
        }
        if config.server.iroh_remote_center_enabled
            && config.server.iroh_remote_center_allowed_peers.is_empty()
        {
            return (
                StatusCode::BAD_REQUEST,
                "iroh remote Center requires at least one trusted bridge EndpointId",
            )
                .into_response();
        }
        if let Some(ref display_name) = server.display_name {
            config.server.display_name = if display_name.is_empty() {
                None
            } else {
                Some(display_name.clone())
            };
        }
        if let Some(ref admin_token) = server.admin_token {
            if let Err(error) = validate_admin_token(admin_token) {
                return (StatusCode::BAD_REQUEST, error).into_response();
            }
            config.server.admin_token = Some(admin_token.clone());
        }
    }

    if let Some(ref contacts) = body.contacts {
        if let Some(value) = contacts.trust_all_contacts {
            config.contacts.trust_all_contacts = value;
        }
        if let Some(value) = contacts.allow_all_inbound {
            config.contacts.allow_all_inbound = value;
        }
    }

    if let Some(ref dev) = body.dev {
        if let Some(value) = dev.apk_install_enabled {
            config.dev.apk_install_enabled = value;
        }
        if let Some(value) = dev.injected_package_recovery_enabled {
            config.dev.injected_package_recovery_enabled = value;
        }
        if let Some(ref digest) = dev.injected_package_recovery_hook_sha256 {
            let digest = digest.trim();
            config.dev.injected_package_recovery_hook_sha256 =
                (!digest.is_empty()).then(|| digest.to_string());
        }
        if let Some(ref digest) = dev.injected_package_recovery_hook_injector_sha256 {
            let digest = digest.trim();
            config.dev.injected_package_recovery_hook_injector_sha256 =
                (!digest.is_empty()).then(|| digest.to_string());
        }
    }

    if let Err(error) = config.dev.validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    if let Err(error) = persist_config_durably(
        &state.config_path,
        &config,
        &original_config,
        &state.esim_bridge,
    )
    .await
    {
        warn!(error = %error, "failed to persist config");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "settings update could not be confirmed; reload settings before retrying",
        )
            .into_response();
    }

    {
        let mut live_config = state.shared_config.write().await;
        *live_config = config.clone();
    }

    info!("Pin-local settings updated");
    Json(settings_response_with_restart(
        &config,
        listener_restart_required(&config, state.active_lan_dashboard_enabled),
    ))
    .into_response()
}

fn contains_cosmos_owned_settings(body: &UpdateSettingsRequest) -> bool {
    body.llm.is_some()
        || body.weather.is_some()
        || body.google_maps.is_some()
        || body.brave_search.is_some()
        || body.open_food_facts.is_some()
        || body.azure_speech.is_some()
        || body.openstreetmap.is_some()
}

fn contains_cosmos_owned_prompt(body: &UpdateSettingsRequest) -> bool {
    body.server
        .as_ref()
        .is_some_and(|server| server.system_prompt.0 || server.status_prompt.0)
}

fn admin_token_update_conflicts_with_environment(
    update_requested: bool,
    environment_present: bool,
) -> bool {
    update_requested && environment_present
}

/// Persist the config to disk using `toml_edit` for format-preserving writes.
/// Creates a `.bak` backup before overwriting.
#[cfg(test)]
fn persist_config(config_path: &std::path::Path, config: &Config) -> Result<(), String> {
    persist_config_with_digest(config_path, config).map(|_| ())
}

fn persist_config_with_digest(
    config_path: &std::path::Path,
    config: &Config,
) -> Result<String, String> {
    persist_config_inner(config_path, config).map_err(|e| e.to_string())
}

/// Persist a candidate locally and synchronously commit the fixed Android CE
/// artifact set to the system-owned vault before acknowledging the update.
/// If the vault commit is not confirmed, restore the previous local/vault
/// generation so an unsuccessful request cannot become active after reboot.
pub(super) async fn persist_config_durably(
    config_path: &std::path::Path,
    candidate: &Config,
    previous: &Config,
    bridge: &EsimBridge,
) -> Result<(), String> {
    let candidate_digest = persist_config_with_digest(config_path, candidate)?;
    if let Err(commit_error) = commit_persistent_config_vault(bridge, &candidate_digest).await {
        let local_rollback = persist_config_with_digest(config_path, previous);
        let vault_rollback = match local_rollback.as_ref() {
            Ok(previous_digest) => commit_persistent_config_vault(bridge, previous_digest).await,
            Err(_) => Err("local rollback failed before vault rollback".to_string()),
        };
        return Err(format!(
            "config vault commit failed ({commit_error}); rollback local={}, vault={}",
            if local_rollback.is_ok() {
                "ok"
            } else {
                "failed"
            },
            if vault_rollback.is_ok() {
                "ok"
            } else {
                "failed"
            },
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
async fn commit_persistent_config_vault(
    _bridge: &EsimBridge,
    _expected_config_digest: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "android")]
async fn commit_persistent_config_vault(
    bridge: &EsimBridge,
    expected_config_digest: &str,
) -> Result<(), String> {
    let mut last_error = "config snapshot broker unavailable".to_string();
    for attempt in 0..3 {
        match bridge
            .commit_persistent_config(expected_config_digest, CONFIG_VAULT_COMMIT_TIMEOUT)
            .await
        {
            Ok(_) => return Ok(()),
            Err(error) => last_error = error,
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    Err(last_error)
}

fn persist_config_inner(
    config_path: &std::path::Path,
    config: &Config,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use toml_edit::DocumentMut;

    let local_override_path = config_path
        .parent()
        .map(|parent| parent.join("config.local.toml"))
        .unwrap_or_else(|| PathBuf::from("config.local.toml"));
    if local_override_path.exists() {
        return Err(
            "dashboard settings writes are disabled while config.local.toml is present".into(),
        );
    }

    // Read the existing file (or start from empty if it doesn't exist)
    let existing = if config_path.exists() {
        std::fs::read_to_string(config_path)?
    } else {
        String::new()
    };

    let mut doc: DocumentMut = existing.parse()?;

    // The format-preserving editor intentionally supports standard TOML
    // tables only. Reject inline-table forms before touching the file so clear
    // operations cannot silently retain secrets or replace sibling settings.
    for section in [
        "llm",
        "server",
        "storage",
        "weather",
        "google_maps",
        "open_food_facts",
        "azure_speech",
        "openstreetmap",
        "spotify",
        "contacts",
        "dev",
        "feature_flags",
    ] {
        if doc.get(section).is_some_and(|item| !item.is_table()) {
            return Err(
                format!("dashboard settings cannot edit inline TOML table `{section}`").into(),
            );
        }
    }
    for subsection in ["tools", "memory"] {
        if doc
            .get("llm")
            .and_then(toml_edit::Item::as_table)
            .and_then(|table| table.get(subsection))
            .is_some_and(|item| !item.is_table())
        {
            return Err(format!(
                "dashboard settings cannot edit inline TOML table `llm.{subsection}`"
            )
            .into());
        }
    }
    if doc
        .get("feature_flags")
        .and_then(toml_edit::Item::as_table)
        .and_then(|table| table.get("overrides"))
        .is_some_and(|item| !item.is_table())
    {
        return Err(
            "dashboard settings cannot edit inline TOML table `feature_flags.overrides`".into(),
        );
    }

    // Helper: ensure a table exists in the document
    fn ensure_table<'a>(doc: &'a mut DocumentMut, key: &str) -> &'a mut toml_edit::Item {
        if doc.get(key).is_none() {
            doc[key] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        &mut doc[key]
    }

    // --- [llm] ---
    {
        let table = ensure_table(&mut doc, "llm");
        table["provider"] = toml_edit::value(config.llm.provider.as_str());
        table["model"] = toml_edit::value(&config.llm.model);
        match &config.llm.api_key {
            Some(key) => table["api_key"] = toml_edit::value(key),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("api_key");
                }
            }
        }
        match &config.llm.base_url {
            Some(url) => table["base_url"] = toml_edit::value(url),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("base_url");
                }
            }
        }
        match &config.llm.progress_cue_model {
            Some(model) => table["progress_cue_model"] = toml_edit::value(model),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("progress_cue_model");
                }
            }
        }
        table["gemini_google_search"] = toml_edit::value(config.llm.gemini_google_search);
    }

    // --- [llm.tools] ---
    {
        if doc["llm"].as_table_mut().is_none() {
            doc["llm"] = toml_edit::Item::Table(toml_edit::Table::new());
        }

        if doc["llm"]["tools"].as_table_mut().is_none() {
            doc["llm"]["tools"] = toml_edit::Item::Table(toml_edit::Table::new());
        }

        let table = &mut doc["llm"]["tools"];
        table["enabled"] = toml_edit::value(config.llm.tools.enabled);
        table["dynamic_tool_count"] = toml_edit::value(config.llm.tools.dynamic_tool_count as i64);
        table["max_tool_turns"] = toml_edit::value(config.llm.tools.max_tool_turns as i64);
        table["tool_concurrency"] = toml_edit::value(config.llm.tools.tool_concurrency as i64);

        if let Some(t) = table.as_table_mut() {
            t.remove("embedding_model");
        }
    }

    // --- [llm.memory] ---
    {
        if doc["llm"].as_table_mut().is_none() {
            doc["llm"] = toml_edit::Item::Table(toml_edit::Table::new());
        }

        if doc["llm"]["memory"].as_table_mut().is_none() {
            doc["llm"]["memory"] = toml_edit::Item::Table(toml_edit::Table::new());
        }

        let table = &mut doc["llm"]["memory"];
        table["enabled"] = toml_edit::value(config.llm.memory.enabled);
        table["path"] = toml_edit::value(&config.llm.memory.path);
        table["top_k"] = toml_edit::value(config.llm.memory.top_k as i64);
        table["snippet_chars"] = toml_edit::value(config.llm.memory.snippet_chars as i64);
        table["max_context_chars"] = toml_edit::value(config.llm.memory.max_context_chars as i64);
        table["auto_retrieve"] = toml_edit::value(config.llm.memory.auto_retrieve);
        table["auto_remember"] = toml_edit::value(config.llm.memory.auto_remember);
    }

    // --- [server] ---
    {
        let table = ensure_table(&mut doc, "server");
        if let Some(t) = table.as_table_mut() {
            t.remove("port");
        }
        table["http_bind_addr"] = toml_edit::value(&config.server.http_bind_addr);
        table["grpc_bind_addr"] = toml_edit::value(&config.server.grpc_bind_addr);
        table["public_addr"] = toml_edit::value(&config.server.public_addr);
        table["lan_dashboard_enabled"] = toml_edit::value(config.server.lan_dashboard_enabled);
        table["iroh_remote_center_enabled"] =
            toml_edit::value(config.server.iroh_remote_center_enabled);
        let mut allowed_peers = toml_edit::Array::new();
        for peer in &config.server.iroh_remote_center_allowed_peers {
            allowed_peers.push(peer.as_str());
        }
        table["iroh_remote_center_allowed_peers"] =
            toml_edit::Item::Value(toml_edit::Value::Array(allowed_peers));
        match &config.server.system_prompt {
            Some(system_prompt) => table["system_prompt"] = toml_edit::value(system_prompt),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("system_prompt");
                }
            }
        }
        match &config.server.status_prompt {
            Some(status_prompt) => table["status_prompt"] = toml_edit::value(status_prompt),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("status_prompt");
                }
            }
        }
        match &config.server.display_name {
            Some(name) => table["display_name"] = toml_edit::value(name),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("display_name");
                }
            }
        }
        match &config.server.admin_token {
            Some(token) => table["admin_token"] = toml_edit::value(token),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("admin_token");
                }
            }
        }
    }

    // --- [storage] --- (read-only, but write it to keep the file complete)
    {
        let table = ensure_table(&mut doc, "storage");
        table["media_dir"] = toml_edit::value(&config.storage.media_dir);
        table["db_path"] = toml_edit::value(&config.storage.db_path);
    }

    // --- [weather] ---
    {
        let table = ensure_table(&mut doc, "weather");
        match &config.weather.pirate_weather_api_key {
            Some(key) => table["pirate_weather_api_key"] = toml_edit::value(key),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("pirate_weather_api_key");
                }
            }
        }
        table["measurement_system"] = toml_edit::value(config.weather.measurement_system.as_str());
        table["temperature_unit"] = toml_edit::value(config.weather.temperature_unit.as_str());
    }

    // --- [brave_search] ---
    {
        let table = ensure_table(&mut doc, "brave_search");
        match &config.brave_search.api_key {
            Some(key) => table["api_key"] = toml_edit::value(key),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("api_key");
                }
            }
        }
    }

    // --- [google_maps] ---
    {
        let table = ensure_table(&mut doc, "google_maps");
        match &config.google_maps.api_key {
            Some(key) => table["api_key"] = toml_edit::value(key),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("api_key");
                }
            }
        }
        table["geolocation_enabled"] = toml_edit::value(config.google_maps.geolocation_enabled);
        table["routes_enabled"] = toml_edit::value(config.google_maps.routes_enabled);
        table["routes_compliance_acknowledged"] =
            toml_edit::value(config.google_maps.routes_compliance_acknowledged);
        table["routes_travel_mode"] =
            toml_edit::value(config.google_maps.routes_travel_mode.as_str());
        table["language_code"] = toml_edit::value(&config.google_maps.language_code);
    }

    // --- [open_food_facts] ---
    {
        let table = ensure_table(&mut doc, "open_food_facts");
        table["enabled"] = toml_edit::value(config.open_food_facts.enabled);
        table["attribution_acknowledged"] =
            toml_edit::value(config.open_food_facts.attribution_acknowledged);
    }

    // --- [azure_speech] ---
    {
        let table = ensure_table(&mut doc, "azure_speech");
        match &config.azure_speech.subscription_key {
            Some(key) => table["subscription_key"] = toml_edit::value(key),
            None => {
                if let Some(table) = table.as_table_mut() {
                    table.remove("subscription_key");
                }
            }
        }
        match &config.azure_speech.region {
            Some(region) => table["region"] = toml_edit::value(region),
            None => {
                if let Some(table) = table.as_table_mut() {
                    table.remove("region");
                }
            }
        }
        match &config.azure_speech.voice_name {
            Some(voice) => table["voice_name"] = toml_edit::value(voice),
            None => {
                if let Some(table) = table.as_table_mut() {
                    table.remove("voice_name");
                }
            }
        }
        table["enabled"] = toml_edit::value(config.azure_speech.enabled);
        table["cloud_consent_acknowledged"] =
            toml_edit::value(config.azure_speech.cloud_consent_acknowledged);
    }

    // --- [openstreetmap] ---
    {
        let table = ensure_table(&mut doc, "openstreetmap");
        table["enabled"] = toml_edit::value(config.openstreetmap.enabled);
        table["location_consent_acknowledged"] =
            toml_edit::value(config.openstreetmap.location_consent_acknowledged);
    }

    // --- [music] ---
    // Provider credentials stay in Center. This bearer is write-only and is
    // removed from migration backups below.
    {
        let table = ensure_table(&mut doc, "music");
        table["active_provider"] = toml_edit::value(config.music.active_provider.as_str());
        match config.music.gateway_url.as_deref() {
            Some(value) => table["gateway_url"] = toml_edit::value(value),
            None => {
                table
                    .as_table_mut()
                    .expect("music table")
                    .remove("gateway_url");
            }
        }
        match config.music.gateway_token.as_deref() {
            Some(value) => table["gateway_token"] = toml_edit::value(value),
            None => {
                table
                    .as_table_mut()
                    .expect("music table")
                    .remove("gateway_token");
            }
        }
    }

    // --- [spotify] ---
    // Authentication remains a separate app-private artifact. Only the
    // operator-controlled feature gates and advertised device name belong in
    // the canonical configuration snapshot.
    {
        let table = ensure_table(&mut doc, "spotify");
        table["enabled"] = toml_edit::value(config.spotify.enabled);
        table["experimental_acknowledged"] =
            toml_edit::value(config.spotify.experimental_acknowledged);
        table["device_name"] = toml_edit::value(&config.spotify.device_name);
    }

    // --- [contacts] ---
    {
        let table = ensure_table(&mut doc, "contacts");
        table["trust_all_contacts"] = toml_edit::value(config.contacts.trust_all_contacts);
        table["allow_all_inbound"] = toml_edit::value(config.contacts.allow_all_inbound);
    }

    // --- [dev] ---
    {
        let table = ensure_table(&mut doc, "dev");
        table["apk_install_enabled"] = toml_edit::value(config.dev.apk_install_enabled);
        table["injected_package_recovery_enabled"] =
            toml_edit::value(config.dev.injected_package_recovery_enabled);
        match &config.dev.injected_package_recovery_hook_sha256 {
            Some(digest) => {
                table["injected_package_recovery_hook_sha256"] = toml_edit::value(digest);
            }
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("injected_package_recovery_hook_sha256");
                }
            }
        }
        match &config.dev.injected_package_recovery_hook_injector_sha256 {
            Some(digest) => {
                table["injected_package_recovery_hook_injector_sha256"] = toml_edit::value(digest);
            }
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("injected_package_recovery_hook_injector_sha256");
                }
            }
        }
    }

    // --- [feature_flags.overrides] ---
    // This table intentionally contains only cloud FeatureFlagsService keys.
    // Settings.Global feature gates are a separate storage plane.
    {
        if doc["feature_flags"].as_table_mut().is_none() {
            doc["feature_flags"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        if doc["feature_flags"]["overrides"].as_table_mut().is_none() {
            doc["feature_flags"]["overrides"] = toml_edit::Item::Table(toml_edit::Table::new());
        }

        let table = doc["feature_flags"]["overrides"]
            .as_table_mut()
            .expect("feature flag overrides table was just created");
        let old_keys: Vec<String> = table.iter().map(|(key, _)| key.to_string()).collect();
        for key in old_keys {
            table.remove(&key);
        }
        for (key, value) in &config.feature_flags.overrides {
            table[key] = match value {
                crate::feature_flags::ConfiguredFeatureFlagValue::Bool(value) => {
                    toml_edit::value(*value)
                }
                crate::feature_flags::ConfiguredFeatureFlagValue::Int(value) => {
                    toml_edit::value(*value)
                }
                crate::feature_flags::ConfiguredFeatureFlagValue::Float(value) => {
                    toml_edit::value(*value)
                }
                crate::feature_flags::ConfiguredFeatureFlagValue::String(value) => {
                    toml_edit::value(value)
                }
            };
        }
    }

    // Create .bak before writing
    if config_path.exists() {
        let bak = config_path.with_extension("toml.bak");
        // Backups preserve structure and comments but intentionally exclude
        // write-only credentials. A historical backup must never retain an
        // old secret after the operator replaces or clears it.
        let mut backup_doc: DocumentMut = existing.parse()?;
        for (section, keys) in [
            ("llm", &["api_key"][..]),
            ("weather", &["pirate_weather_api_key"][..]),
            ("google_maps", &["api_key"][..]),
            ("brave_search", &["api_key"][..]),
            ("azure_speech", &["subscription_key"][..]),
            ("server", &["admin_token", "grpc_auth_token"][..]),
            ("music", &["gateway_token"][..]),
        ] {
            if let Some(table) = backup_doc
                .get_mut(section)
                .and_then(toml_edit::Item::as_table_mut)
            {
                for key in keys {
                    table.remove(key);
                }
            }
        }
        write_private_atomic(&bak, &backup_doc.to_string())?;
    }

    // Bind the vault acknowledgement to the exact bytes supplied to the
    // atomic writer. A post-write re-read would introduce a TOCTOU with
    // Android-side bootstrap and maintenance commits.
    let rendered = doc.to_string();
    let digest = format!("{:x}", Sha256::digest(rendered.as_bytes()));
    write_private_atomic(config_path, &rendered)?;
    info!(path = %config_path.display(), "config persisted to disk");

    Ok(digest)
}

fn write_private_atomic(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write as _;

    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    let write_result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

// ─── Event stream (streaming fetch / NDJSON) ────────────────────────

async fn event_stream(State(state): State<ApiState>) -> Response {
    let mut rx = state.events_tx.subscribe();
    build_ndjson_stream_response(async_stream::stream! {
        // Immediately send a heartbeat so the client knows the connection is live.
        yield Ok::<_, std::convert::Infallible>(
            format!("{}\n", serde_json::to_string(&Event::Heartbeat).unwrap())
        );

        // 30 s is a contract, not a local choice: the USB bridge relays this
        // stream through a blocking read loop whose SO_TIMEOUT is the longest
        // gap it tolerates between chunks, and this heartbeat is the only
        // traffic on a quiet stream. See SERVER_HEARTBEAT_PERIOD_MS in
        // pin/runtime/android/.../CenterUsbBridge.kt — changing this period
        // without changing that one puts the two deadlines back in a race.
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
        heartbeat.tick().await; // consume the immediate first tick

        loop {
            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(event) => {
                            let line = format!("{}\n", serde_json::to_string(&event).unwrap());
                            yield Ok(line);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(missed = n, "event stream client lagged");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    yield Ok(
                        format!("{}\n", serde_json::to_string(&Event::Heartbeat).unwrap())
                    );
                }
            }
        }
    })
}

pub(super) fn build_ndjson_stream_response<S>(stream: S) -> Response
where
    S: futures::stream::Stream<Item = Result<String, std::convert::Infallible>> + Send + 'static,
{
    let body = axum::body::Body::from_stream(stream);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap()
}

// ─── Logs ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LogQuery {
    /// Optional cap on returned lines (tail of the log). 0 / unset = all.
    #[serde(default)]
    pub lines: Option<usize>,
    /// If true (default), concatenate all rolled files in chronological order.
    /// If false, only return the most recent file.
    #[serde(default)]
    pub all: Option<bool>,
}

/// GET /api/logs/server — returns the on-disk rolling log files as text/plain.
///
/// By default, all rolled files in `logging.log_dir` are concatenated in
/// chronological order. Use `?lines=N` to return only the last N lines, or
/// `?all=false` to read just the most recent file.
async fn get_server_logs(
    State(state): State<ApiState>,
    axum::extract::Query(query): axum::extract::Query<LogQuery>,
) -> Response {
    let Some(log_dir) = state.log_dir.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "file logging is not configured (set logging.log_dir in config.toml)",
        )
            .into_response();
    };

    let prefix = state.log_file_prefix.as_str();

    // Discover candidate files: `{prefix}*` in `log_dir`, sorted by name
    // (rolling-file daily filenames are `{prefix}.YYYY-MM-DD`, lexicographically
    // sorted == chronologically sorted).
    let mut files: Vec<PathBuf> = match std::fs::read_dir(log_dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with(prefix))
                        .unwrap_or(false)
            })
            .collect(),
        Err(e) => {
            tracing::error!(dir = %log_dir.display(), error = %e, "failed to read log dir");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read log dir: {e}"),
            )
                .into_response();
        }
    };
    files.sort();

    if files.is_empty() {
        return (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            String::new(),
        )
            .into_response();
    }

    let want_all = query.all.unwrap_or(true);
    let selected: &[PathBuf] = if want_all {
        &files
    } else {
        &files[files.len() - 1..]
    };

    // Read everything. Logs are typically small enough; large deployments
    // should use ?lines=. We accept the memory cost for simplicity.
    let mut buf = Vec::new();
    for path in selected {
        match tokio::fs::read(path).await {
            Ok(mut bytes) => buf.append(&mut bytes),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "failed to read log file");
            }
        }
    }

    let body = match query.lines {
        Some(n) if n > 0 => tail_lines(&buf, n),
        _ => buf,
    };

    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

/// Return the last `n` lines from `bytes`. Operates on raw bytes to avoid
/// requiring valid UTF-8 (logs may include arbitrary bytes).
fn tail_lines(bytes: &[u8], n: usize) -> Vec<u8> {
    if n == 0 || bytes.is_empty() {
        return bytes.to_vec();
    }
    let mut count = 0usize;
    // Walk from the end, counting newlines.
    let mut idx = bytes.len();
    while idx > 0 {
        idx -= 1;
        if bytes[idx] == b'\n' {
            count += 1;
            if count > n {
                return bytes[idx + 1..].to_vec();
            }
        }
    }
    bytes.to_vec()
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn redact_logcat_activation_codes(bytes: &[u8]) -> Vec<u8> {
    const MARKER: &[u8] = b"activationCode:";
    const REDACTED: &[u8] = b"[REDACTED]";

    let mut output = Vec::with_capacity(bytes.len());
    let mut cursor = 0usize;
    while let Some(relative_marker) = bytes[cursor..]
        .windows(MARKER.len())
        .position(|window| window.eq_ignore_ascii_case(MARKER))
    {
        let marker_start = cursor + relative_marker;
        let marker_end = marker_start + MARKER.len();
        output.extend_from_slice(&bytes[cursor..marker_end]);

        let mut value_start = marker_end;
        while value_start < bytes.len() && matches!(bytes[value_start], b' ' | b'\t') {
            output.push(bytes[value_start]);
            value_start += 1;
        }
        let mut value_end = value_start;
        while value_end < bytes.len() && !bytes[value_end].is_ascii_whitespace() {
            value_end += 1;
        }
        if value_end > value_start {
            output.extend_from_slice(REDACTED);
            cursor = value_end;
        } else {
            cursor = value_start;
        }
    }
    output.extend_from_slice(&bytes[cursor..]);
    output
}

/// GET /api/logs/logcat — returns the device's full logcat buffer as text/plain.
///
/// Only available on Android. Returns 503 on other platforms. Uses
/// `logcat -d` (dump-and-exit). Use `?lines=N` to tail the output.
#[cfg(target_os = "android")]
async fn get_logcat_logs(axum::extract::Query(query): axum::extract::Query<LogQuery>) -> Response {
    use tokio::process::Command;

    let output = match Command::new("logcat").args(["-d"]).output().await {
        Ok(o) => o,
        Err(e) => {
            tracing::error!(error = %e, "failed to spawn logcat");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to run logcat: {e}"),
            )
                .into_response();
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!(status = ?output.status, %stderr, "logcat exited non-zero");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("logcat failed: {stderr}"),
        )
            .into_response();
    }

    let redacted = redact_logcat_activation_codes(&output.stdout);
    let body = match query.lines {
        Some(n) if n > 0 => tail_lines(&redacted, n),
        _ => redacted,
    };

    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

#[cfg(not(target_os = "android"))]
async fn get_logcat_logs(axum::extract::Query(_query): axum::extract::Query<LogQuery>) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "logcat is only available on Android",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::media::{parse_media_range, serve_file, MediaByteRange};
    use super::*;
    use crate::storage::OpenedMediaFile;
    use crate::tier_a::feature_flags::cloud as cloud_feature_keys;
    use axum::http::HeaderValue;

    #[test]
    fn logcat_activation_codes_are_redacted_without_changing_unrelated_bytes() {
        let input = b"before\nfactoryService activationCode: LPA:1$host$credential\nafter \xff\n";
        let expected = b"before\nfactoryService activationCode: [REDACTED]\nafter \xff\n";
        assert_eq!(redact_logcat_activation_codes(input), expected);

        let mixed_case = b"ActivationCODE:\tsecret\n";
        assert_eq!(
            redact_logcat_activation_codes(mixed_case),
            b"ActivationCODE:\t[REDACTED]\n"
        );

        let unrelated = b"activation completed; ordinary number 12345678901234567890\n";
        assert_eq!(redact_logcat_activation_codes(unrelated), unrelated);
    }

    #[test]
    fn media_ranges_support_bounded_open_and_suffix_forms() {
        for (raw, expected) in [
            ("bytes=10-19", MediaByteRange { start: 10, end: 19 }),
            ("bytes=90-", MediaByteRange { start: 90, end: 99 }),
            ("bytes=-10", MediaByteRange { start: 90, end: 99 }),
            ("bytes=95-999", MediaByteRange { start: 95, end: 99 }),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, HeaderValue::from_str(raw).unwrap());
            assert_eq!(parse_media_range(&headers, 100), Ok(Some(expected)));
        }
    }

    #[test]
    fn media_ranges_reject_ambiguous_or_unsatisfiable_requests() {
        for raw in [
            "items=0-1",
            "bytes=",
            "bytes=0-1,4-5",
            "bytes=100-",
            "bytes=20-10",
            "bytes=-0",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, HeaderValue::from_str(raw).unwrap());
            assert_eq!(
                parse_media_range(&headers, 100),
                Err(StatusCode::RANGE_NOT_SATISFIABLE),
                "accepted {raw}",
            );
        }

        let mut duplicate = HeaderMap::new();
        duplicate.append(header::RANGE, HeaderValue::from_static("bytes=0-1"));
        duplicate.append(header::RANGE, HeaderValue::from_static("bytes=2-3"));
        assert_eq!(
            parse_media_range(&duplicate, 100),
            Err(StatusCode::RANGE_NOT_SATISFIABLE),
        );
    }

    #[tokio::test]
    async fn media_responses_include_bodies_and_complete_range_headers() {
        use http_body_util::BodyExt;
        use std::io::Write as _;

        fn opened(contents: &[u8]) -> (tempfile::TempDir, OpenedMediaFile) {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("media.bin");
            let mut writable = std::fs::File::create(&path).unwrap();
            writable.write_all(contents).unwrap();
            writable.sync_all().unwrap();
            let file = std::fs::File::open(path).unwrap();
            (
                directory,
                OpenedMediaFile {
                    file,
                    len: contents.len() as u64,
                },
            )
        }

        let (_directory, file) = opened(b"0123456789");
        let full = serve_file(file, "video/mp4", &HeaderMap::new()).await;
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(full.headers()[header::ACCEPT_RANGES], "bytes");
        assert!(full.headers().get(header::CONTENT_RANGE).is_none());
        assert_eq!(
            full.into_body().collect().await.unwrap().to_bytes(),
            &b"0123456789"[..],
        );

        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=2-5"));
        let (_directory, file) = opened(b"0123456789");
        let partial = serve_file(file, "video/mp4", &headers).await;
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.headers()[header::CONTENT_LENGTH], "4");
        assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(
            partial.into_body().collect().await.unwrap().to_bytes(),
            &b"2345"[..],
        );

        headers.insert(header::RANGE, HeaderValue::from_static("bytes=20-"));
        let (_directory, file) = opened(b"0123456789");
        let unsatisfiable = serve_file(file, "video/mp4", &headers).await;
        assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(unsatisfiable.headers()[header::CONTENT_RANGE], "bytes */10",);
        assert_eq!(unsatisfiable.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(unsatisfiable.headers()[header::CONTENT_LENGTH], "0");
        assert_eq!(
            unsatisfiable
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes(),
            &b""[..],
        );
    }

    #[test]
    fn settings_response_is_pin_local() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(&dir.path().join("missing.toml")).unwrap();
        let json = serde_json::to_value(settings_response(&config)).unwrap();
        let object = json.as_object().unwrap();

        assert_eq!(object.len(), 4);
        for provider in [
            "llm",
            "weather",
            "google_maps",
            "brave_search",
            "open_food_facts",
            "azure_speech",
            "openstreetmap",
        ] {
            assert!(!object.contains_key(provider), "{provider}");
        }
        assert_eq!(object["server"]["admin_token_auth"], true);
    }

    #[test]
    fn provider_and_prompt_writes_are_cosmos_owned() {
        for json in [
            r#"{"llm":{}}"#,
            r#"{"weather":{}}"#,
            r#"{"google_maps":{}}"#,
            r#"{"brave_search":{}}"#,
            r#"{"open_food_facts":{}}"#,
            r#"{"azure_speech":{}}"#,
            r#"{"openstreetmap":{}}"#,
        ] {
            let body: UpdateSettingsRequest = serde_json::from_str(json).unwrap();
            assert!(contains_cosmos_owned_settings(&body), "{json}");
        }

        for json in [
            r#"{"server":{"system_prompt":"Keep answers short."}}"#,
            r#"{"server":{"status_prompt":null}}"#,
        ] {
            let body: UpdateSettingsRequest = serde_json::from_str(json).unwrap();
            assert!(contains_cosmos_owned_prompt(&body), "{json}");
        }
    }

    #[test]
    fn lan_dashboard_setting_round_trips_with_restart_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.server.lan_dashboard_enabled = true;

        let regular = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(regular["server"]["lan_dashboard_enabled"], true);
        assert_eq!(regular["restart_required"], false);
        assert!(listener_restart_required(&config, false));
        assert!(!listener_restart_required(&config, true));
        let changed = serde_json::to_value(settings_response_with_restart(&config, true)).unwrap();
        assert_eq!(changed["restart_required"], true);

        persist_config(&path, &config).unwrap();
        assert!(Config::load(&path).unwrap().server.lan_dashboard_enabled);

        let update: UpdateSettingsRequest =
            serde_json::from_str(r#"{"server":{"lan_dashboard_enabled":false}}"#).unwrap();
        assert_eq!(update.server.unwrap().lan_dashboard_enabled, Some(false));
    }

    #[test]
    fn iroh_peer_allowlist_is_write_only_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let peer = "09ad483a6a046e4148a71a7e05f2880e82abd3086369b42f3fb6bda6ee7f3b63";
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.server.iroh_remote_center_enabled = true;
        config.server.iroh_remote_center_allowed_peers = vec![peer.into()];

        let response = serde_json::to_value(settings_response(&config)).unwrap();
        for field in [
            "iroh_remote_center_enabled",
            "iroh_remote_center_allowed_peer_count",
            "iroh_remote_center_allowed_peers",
        ] {
            assert!(response["server"].get(field).is_none(), "{field}");
        }
        assert!(!response.to_string().contains(peer));

        persist_config(&path, &config).unwrap();
        assert_eq!(
            Config::load(&path)
                .unwrap()
                .server
                .iroh_remote_center_allowed_peers,
            vec![peer]
        );

        let update: UpdateSettingsRequest = serde_json::from_str(&format!(
            r#"{{"server":{{"iroh_remote_center_allowed_peers":["{}"]}}}}"#,
            peer.to_ascii_uppercase()
        ))
        .unwrap();
        assert_eq!(
            normalize_iroh_remote_center_allowed_peers(
                update
                    .server
                    .unwrap()
                    .iroh_remote_center_allowed_peers
                    .unwrap()
            )
            .unwrap(),
            vec![peer]
        );
    }

    #[test]
    fn admin_token_is_write_only_persisted_and_scrubbed_from_backups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let first_token = "a".repeat(crate::config::MIN_ADMIN_TOKEN_BYTES);
        let second_token = "b".repeat(crate::config::MIN_ADMIN_TOKEN_BYTES);
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.server.admin_token = Some(first_token.clone());

        let json = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(json["server"]["admin_token_auth"], true);
        assert!(json["server"].get("admin_token").is_none());
        assert!(!json.to_string().contains(&first_token));

        persist_config(&path, &config).unwrap();
        assert_eq!(
            Config::load(&path).unwrap().server.admin_token.as_deref(),
            Some(first_token.as_str())
        );

        config.server.admin_token = Some(second_token.clone());
        persist_config(&path, &config).unwrap();
        let persisted = std::fs::read_to_string(&path).unwrap();
        let backup = std::fs::read_to_string(path.with_extension("toml.bak")).unwrap();
        assert!(persisted.contains(&second_token));
        assert!(!persisted.contains(&first_token));
        assert!(!backup.contains(&first_token));
        assert!(!backup.contains(&second_token));

        let update: UpdateSettingsRequest = serde_json::from_str(&format!(
            r#"{{"server":{{"admin_token":"{second_token}"}}}}"#
        ))
        .unwrap();
        assert_eq!(
            update.server.unwrap().admin_token.as_deref(),
            Some(second_token.as_str())
        );
    }

    #[test]
    fn settings_response_explicitly_advertises_admin_token_auth_capability() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(&dir.path().join("missing.toml")).unwrap();

        let json = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(json["server"]["admin_token_auth"], true);
        assert!(json["server"].get("admin_token").is_none());
    }

    #[test]
    fn environment_authority_rejects_persisted_admin_token_updates() {
        assert!(admin_token_update_conflicts_with_environment(true, true));
        assert!(!admin_token_update_conflicts_with_environment(true, false));
        assert!(!admin_token_update_conflicts_with_environment(false, true));
    }

    #[test]
    fn injected_package_recovery_settings_are_persisted_and_clearable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        let hook_digest = "ab".repeat(32);
        let injector_digest = "cd".repeat(32);
        config.dev.injected_package_recovery_enabled = true;
        config.dev.injected_package_recovery_hook_sha256 = Some(hook_digest.clone());
        config.dev.injected_package_recovery_hook_injector_sha256 = Some(injector_digest.clone());

        // The gate and pins must survive the same durable persistence path
        // that the vault snapshots, so a data-clear restore brings them back.
        persist_config(&path, &config).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert!(loaded.dev.injected_package_recovery_enabled);
        assert_eq!(
            loaded.dev.injected_package_recovery_hook_sha256.as_deref(),
            Some(hook_digest.as_str())
        );
        assert_eq!(
            loaded
                .dev
                .injected_package_recovery_hook_injector_sha256
                .as_deref(),
            Some(injector_digest.as_str())
        );

        config.dev.injected_package_recovery_hook_sha256 = None;
        config.dev.injected_package_recovery_hook_injector_sha256 = None;
        persist_config(&path, &config).unwrap();
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("injected_package_recovery_hook_sha256"));
        assert!(!persisted.contains("injected_package_recovery_hook_injector_sha256"));
        assert!(persisted.contains("injected_package_recovery_enabled = true"));

        // A malformed pin cannot reach a persisted config through the
        // settings-update surface: DevConfig::validate rejects it.
        config.dev.injected_package_recovery_hook_sha256 = Some("not-a-digest".into());
        assert!(config.dev.validate().is_err());
    }

    #[test]
    fn music_provider_and_spotify_settings_round_trip_and_disabling_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.music.active_provider = crate::config::MusicProvider::Tidal;
        config.music.gateway_url = Some("https://center.example.test".into());
        config.music.gateway_token = Some("gateway-token-for-runtime-test-only".into());
        config.spotify.enabled = true;
        config.spotify.experimental_acknowledged = true;
        config.spotify.device_name = "Kitchen Ai Pin".into();

        persist_config(&path, &config).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.music, config.music);
        assert_eq!(loaded.spotify, config.spotify);

        let update: crate::spotify::UpdateSpotifySettings = serde_json::from_str(
            r#"{"active_provider":"tidal","enabled":false,"experimental_acknowledged":false,"device_name":"Ai Pin"}"#,
        )
        .unwrap();
        assert_eq!(
            update.active_provider,
            Some(crate::config::MusicProvider::Tidal)
        );

        config.music.active_provider = crate::config::MusicProvider::YoutubeMusic;
        config.spotify.enabled = false;
        config.spotify.experimental_acknowledged = false;
        config.spotify.device_name = "Travel Ai Pin".into();
        persist_config(&path, &config).unwrap();
        let reloaded = Config::load(&path).unwrap();
        assert_eq!(reloaded.music, config.music);
        assert_eq!(reloaded.spotify, config.spotify);
    }

    #[test]
    fn feature_flag_overrides_round_trip_and_reset_cleanly() {
        use crate::feature_flags::ConfiguredFeatureFlagValue;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "# keep this comment\n[feature_flags.overrides]\nstale = true\n",
        )
        .unwrap();
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.feature_flags.overrides = std::collections::BTreeMap::from([
            (
                cloud_feature_keys::VISION_ACTIONS_ENABLED.into(),
                ConfiguredFeatureFlagValue::Bool(true),
            ),
            (
                cloud_feature_keys::TOUCHCODE_TIMEOUT_MILLIS.into(),
                ConfiguredFeatureFlagValue::Int(7_500),
            ),
        ]);

        persist_config(&path, &config).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.feature_flags, config.feature_flags);
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(persisted.contains("# keep this comment"));
        assert!(!persisted.contains("stale = true"));
        assert!(path.with_extension("toml.bak").exists());

        config.feature_flags.overrides.clear();
        persist_config(&path, &config).unwrap();
        let reset = Config::load(&path).unwrap();
        assert!(reset.feature_flags.overrides.is_empty());
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains("[feature_flags.overrides]"));
    }

    #[test]
    fn memory_failure_event_uses_the_center_stream_contract() {
        let event = Event::MemoryFailed {
            uuid: "123e4567-e89b-42d3-a456-426614174000".into(),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "memory_failed",
                "uuid": "123e4567-e89b-42d3-a456-426614174000"
            })
        );
    }
}

// iroh remote center endpoints

#[cfg(feature = "iroh")]
pub(crate) mod iroh_endpoints {
    use axum::{extract::State, http::StatusCode, response::Json, routing::get, Router};

    pub fn router() -> Router<crate::api::ApiState> {
        Router::new()
            .route("/api/iroh/status", get(status))
            .route("/api/iroh/ticket", get(ticket))
    }

    async fn status(State(state): State<crate::api::ApiState>) -> Json<serde_json::Value> {
        // `iroh_connector` is `Option<Arc<IrohConnectorState>>`: present means
        // the tunnel was initialized and is serving.
        Json(serde_json::json!({
            "iroh_remote_center_enabled": state.iroh_connector.is_some(),
        }))
    }

    async fn ticket(
        State(state): State<crate::api::ApiState>,
    ) -> Result<Json<serde_json::Value>, StatusCode> {
        let connector = state
            .iroh_connector
            .as_ref()
            .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

        // `EndpointTicket` round-trips through its canonical `Display`/`FromStr`
        // string form — exactly what the Mac helper parses back to dial the Pin.
        Ok(Json(serde_json::json!({
            "ticket": connector.node_ticket().to_string(),
            "node_id": connector.node_id().to_string(),
        })))
    }
}
