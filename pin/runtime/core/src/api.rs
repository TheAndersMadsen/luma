//! REST/JSON API for the web portal.
//!
//! These endpoints are consumed by the Pin Setup web app over the Local
//! Network Access (LNA) API.  All responses include CORS headers so the
//! public HTTPS portal can reach this HTTP server on the LAN.

mod activity;
mod auth;
mod codex;
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
    normalize_iroh_remote_center_allowed_peers, validate_admin_token, Config, GoogleMapsTravelMode,
    LlmProvider, MeasurementSystem, ResolvedConfig, ServerConfig, TemperatureUnit,
};
use crate::db::Database;
use crate::dedup::DedupHandle;
use crate::esim::EsimBridge;
use crate::external::azure_speech::AzureSpeechClient;
use crate::external::google_maps::GoogleMapsClient;
use crate::external::open_food_facts::{
    OpenFoodFactsClient, OPEN_FOOD_FACTS_ATTRIBUTION, OPEN_FOOD_FACTS_LICENSE_URL,
};
use crate::fitness::FitnessStore;
use crate::llm::memory::MemoryService;
use crate::llm::{validate_prompt_template, LlmAgent, LlmRequestLogger};
use crate::nearby::NearbyClient;
use crate::services::aibus::{
    AiBus, AiBusExternalClients, AiBusHanders, CompositionServiceImpl, FoodRuntimeGate,
};
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
        .nest("/api", codex::router())
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
    llm: LlmSettingsResponse,
    server: ServerSettingsResponse,
    storage: StorageSettingsResponse,
    weather: WeatherSettingsResponse,
    google_maps: GoogleMapsSettingsResponse,
    brave_search: BraveSearchSettingsResponse,
    open_food_facts: OpenFoodFactsSettingsResponse,
    azure_speech: AzureSpeechSettingsResponse,
    openstreetmap: OpenStreetMapSettingsResponse,
    contacts: ContactsSettingsResponse,
    dev: DevSettingsResponse,
}

#[derive(Serialize)]
struct LlmSettingsResponse {
    provider: LlmProvider,
    model: String,
    /// Retired, unconsumed compatibility flag. No production path reads it;
    /// progress-cue delivery is NOT active (fail-closed) regardless of value.
    hermes_progress_turns: bool,
    /// Arms deterministic progress-cue prose on the stock action-interstitial
    /// RPC. Ships false. Unlike `hermes_progress_turns` this one is consumed.
    spoken_progress_cues: bool,
    /// Allows exactly one bounded retry of a turn's first model step. Ships
    /// false; exposed so the retry can be turned on, measured, and — if the
    /// measurement is flat — removed.
    first_step_retry: bool,
    /// Persists one diagnostic record per turn. Ships false; runtime-togglable
    /// so a fault can be captured without a rebuild or reinstall.
    turn_trace: bool,
    /// Widens those records from shapes to free text. Ships false and is
    /// independent of `turn_trace`; while false, `/api/traces` serves no text.
    turn_trace_content: bool,
    has_api_key: bool,
    base_url: Option<String>,
    codex_bridge_url: String,
    has_codex_bridge_token: bool,
    has_codex_bridge_ca: bool,
    /// Custom OpenAI-compatible provider routed through the on-device Codex
    /// app-server. Secrets are presence-only.
    codex_provider_base_url: Option<String>,
    codex_model: Option<String>,
    codex_provider_name: Option<String>,
    codex_wire_api: Option<String>,
    codex_cue_model: Option<String>,
    /// Path to a Codex model-catalog JSON (not a secret; shown verbatim).
    codex_model_catalog_path: Option<String>,
    has_codex_api_key: bool,
    /// True when the custom provider is fully configured and keyed, so the Pin
    /// routes qwen (etc.) through Codex instead of native ChatGPT.
    codex_custom_active: bool,
    /// The effective progress-cue model (resolves provider-aware defaults).
    progress_cue_model: String,
    /// Vision-capable model used for camera-image analysis. `null` keeps
    /// image requests on the main model.
    vision_model: Option<String>,
    /// Independent camera->cloud consent. While false no camera image leaves
    /// the device and `vision_actions_enabled` is ineffective.
    vision_consent_acknowledged: bool,
    gemini_google_search: bool,
    tools: LlmToolsSettingsResponse,
    memory: LlmMemorySettingsResponse,
}

#[derive(Serialize)]
struct LlmMemorySettingsResponse {
    enabled: bool,
    path: String,
    top_k: usize,
    snippet_chars: usize,
    max_context_chars: usize,
    auto_retrieve: bool,
    auto_remember: bool,
}

#[derive(Serialize)]
struct LlmToolsSettingsResponse {
    enabled: bool,
    dynamic_tool_count: usize,
    max_tool_turns: usize,
    tool_concurrency: usize,
}

#[derive(Serialize)]
struct ServerSettingsResponse {
    /// Capability flag for dashboard clients. The credential itself is
    /// write-only and is never included in a settings response.
    admin_token_auth: bool,
    http_bind_addr: String,
    grpc_bind_addr: String,
    public_addr: String,
    lan_dashboard_enabled: bool,
    iroh_remote_center_enabled: bool,
    iroh_remote_center_full_access: bool,
    /// Peer identities are write-only; expose only whether the direct tunnel
    /// is constrained and how many identities are trusted.
    iroh_remote_center_allowed_peer_count: usize,
    system_prompt: String,
    status_prompt: String,
    display_name: Option<String>,
}

#[derive(Serialize)]
struct StorageSettingsResponse {
    media_dir: String,
    db_path: String,
}

#[derive(Serialize)]
struct WeatherSettingsResponse {
    has_api_key: bool,
    measurement_system: MeasurementSystem,
    temperature_unit: TemperatureUnit,
}

/// Presence only. The subscription token is write-only and never read back.
#[derive(Serialize)]
struct BraveSearchSettingsResponse {
    has_api_key: bool,
}

#[derive(Serialize)]
struct GoogleMapsSettingsResponse {
    has_api_key: bool,
    geolocation_enabled: bool,
    routes_enabled: bool,
    routes_compliance_acknowledged: bool,
    routes_travel_mode: GoogleMapsTravelMode,
    language_code: String,
}

#[derive(Serialize)]
struct OpenFoodFactsSettingsResponse {
    enabled: bool,
    attribution_acknowledged: bool,
    attribution: &'static str,
    license_url: &'static str,
}

#[derive(Serialize)]
struct AzureSpeechSettingsResponse {
    has_subscription_key: bool,
    region: Option<String>,
    voice_name: Option<String>,
    enabled: bool,
    cloud_consent_acknowledged: bool,
}

#[derive(Serialize)]
struct OpenStreetMapSettingsResponse {
    enabled: bool,
    location_consent_acknowledged: bool,
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
        llm: LlmSettingsResponse {
            provider: config.llm.provider,
            model: config.llm.model.clone(),
            hermes_progress_turns: config.llm.hermes_progress_turns,
            spoken_progress_cues: config.llm.spoken_progress_cues,
            first_step_retry: config.llm.first_step_retry,
            turn_trace: config.llm.turn_trace,
            turn_trace_content: config.llm.turn_trace_content,
            has_api_key: config.llm.resolve_api_key().is_some(),
            base_url: config.llm.base_url.clone(),
            codex_bridge_url: config.llm.resolve_codex_bridge_url(),
            has_codex_bridge_token: config.llm.resolve_codex_bridge_token().is_some(),
            has_codex_bridge_ca: config.llm.codex_bridge_ca_pem.is_some(),
            codex_provider_base_url: config
                .llm
                .codex
                .as_ref()
                .and_then(|codex| codex.provider_base_url.clone()),
            codex_model: config
                .llm
                .codex
                .as_ref()
                .and_then(|codex| codex.model.clone()),
            codex_provider_name: config
                .llm
                .codex
                .as_ref()
                .map(|codex| codex.provider_name.clone()),
            codex_wire_api: config
                .llm
                .codex
                .as_ref()
                .map(|codex| codex.wire_api.clone()),
            codex_cue_model: config
                .llm
                .codex
                .as_ref()
                .and_then(|codex| codex.cue_model.clone()),
            codex_model_catalog_path: config
                .llm
                .codex
                .as_ref()
                .and_then(|codex| codex.model_catalog_path.clone()),
            has_codex_api_key: config
                .llm
                .codex
                .as_ref()
                .is_some_and(|codex| codex.resolve_api_key().is_some()),
            codex_custom_active: config.llm.codex_custom_provider_active(),
            progress_cue_model: config.llm.resolve_progress_cue_model().to_string(),
            vision_model: config.llm.resolve_vision_model().map(str::to_string),
            vision_consent_acknowledged: config.llm.vision_consent_acknowledged,
            gemini_google_search: config.llm.gemini_google_search,
            tools: LlmToolsSettingsResponse {
                enabled: config.llm.tools.enabled,
                dynamic_tool_count: config.llm.tools.dynamic_tool_count,
                max_tool_turns: config.llm.tools.max_tool_turns,
                tool_concurrency: config.llm.tools.tool_concurrency,
            },
            memory: LlmMemorySettingsResponse {
                enabled: config.llm.memory.enabled,
                path: config.llm.memory.path.clone(),
                top_k: config.llm.memory.top_k,
                snippet_chars: config.llm.memory.snippet_chars,
                max_context_chars: config.llm.memory.max_context_chars,
                auto_retrieve: config.llm.memory.auto_retrieve,
                auto_remember: config.llm.memory.auto_remember,
            },
        },
        server: ServerSettingsResponse {
            admin_token_auth: true,
            http_bind_addr: config.server.http_bind_addr.clone(),
            grpc_bind_addr: config.server.grpc_bind_addr.clone(),
            public_addr: config.server.public_addr.clone(),
            lan_dashboard_enabled: config.server.lan_dashboard_enabled,
            iroh_remote_center_enabled: config.server.iroh_remote_center_enabled,
            iroh_remote_center_full_access: config.server.iroh_remote_center_full_access,
            iroh_remote_center_allowed_peer_count: config
                .server
                .iroh_remote_center_allowed_peers
                .len(),
            system_prompt: config.server.resolved_system_prompt(),
            status_prompt: config.server.resolved_status_prompt(),
            display_name: config.server.display_name.clone(),
        },
        storage: StorageSettingsResponse {
            media_dir: config.storage.media_dir.clone(),
            db_path: config.storage.db_path.clone(),
        },
        weather: WeatherSettingsResponse {
            has_api_key: config.weather.resolve_api_key().is_some(),
            measurement_system: config.weather.measurement_system,
            temperature_unit: config.weather.temperature_unit,
        },
        google_maps: GoogleMapsSettingsResponse {
            has_api_key: config.google_maps.resolve_api_key().is_some(),
            geolocation_enabled: config.google_maps.geolocation_enabled,
            routes_enabled: config.google_maps.routes_enabled,
            routes_compliance_acknowledged: config.google_maps.routes_compliance_acknowledged,
            routes_travel_mode: config.google_maps.routes_travel_mode,
            language_code: config.google_maps.language_code.clone(),
        },
        brave_search: BraveSearchSettingsResponse {
            has_api_key: config.brave_search.resolve_api_key().is_some(),
        },
        open_food_facts: OpenFoodFactsSettingsResponse {
            enabled: config.open_food_facts.enabled,
            attribution_acknowledged: config.open_food_facts.attribution_acknowledged,
            attribution: OPEN_FOOD_FACTS_ATTRIBUTION,
            license_url: OPEN_FOOD_FACTS_LICENSE_URL,
        },
        azure_speech: AzureSpeechSettingsResponse {
            has_subscription_key: config.azure_speech.resolve_subscription_key().is_some(),
            region: config.azure_speech.region.clone(),
            voice_name: config.azure_speech.voice_name.clone(),
            enabled: config.azure_speech.enabled,
            cloud_consent_acknowledged: config.azure_speech.cloud_consent_acknowledged,
        },
        openstreetmap: OpenStreetMapSettingsResponse {
            enabled: config.openstreetmap.enabled,
            location_consent_acknowledged: config.openstreetmap.location_consent_acknowledged,
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
    llm: Option<UpdateLlmSettings>,
    server: Option<UpdateServerSettings>,
    weather: Option<UpdateWeatherSettings>,
    google_maps: Option<UpdateGoogleMapsSettings>,
    brave_search: Option<UpdateBraveSearchSettings>,
    open_food_facts: Option<UpdateOpenFoodFactsSettings>,
    azure_speech: Option<UpdateAzureSpeechSettings>,
    openstreetmap: Option<UpdateOpenStreetMapSettings>,
    contacts: Option<UpdateContactsSettings>,
    dev: Option<UpdateDevSettings>,
    /// Storage is read-only; presence in the request is rejected.
    storage: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct UpdateLlmSettings {
    provider: Option<LlmProvider>,
    model: Option<String>,
    hermes_progress_turns: Option<bool>,
    /// Opt-in for spoken progress-cue prose. Absent leaves the stored value
    /// untouched; the stored default is false.
    spoken_progress_cues: Option<bool>,
    /// Opt-in for the bounded first-step retry. Absent leaves the stored value
    /// untouched; the stored default is false.
    first_step_retry: Option<bool>,
    /// Opt-in for per-turn diagnostic traces. Absent leaves the stored value
    /// untouched; the stored default is false.
    turn_trace: Option<bool>,
    /// Opt-in for free text inside those traces. Absent leaves the stored value
    /// untouched; the stored default is false.
    turn_trace_content: Option<bool>,
    api_key: Option<String>,
    base_url: Option<String>,
    codex_bridge_url: Option<String>,
    codex_bridge_token: Option<String>,
    codex_bridge_ca_pem: Option<String>,
    codex_provider_base_url: Option<String>,
    codex_model: Option<String>,
    codex_provider_name: Option<String>,
    codex_wire_api: Option<String>,
    codex_cue_model: Option<String>,
    codex_model_catalog_path: Option<String>,
    codex_api_key: Option<String>,
    progress_cue_model: Option<String>,
    /// An empty string clears the vision model (images stay on the main model).
    vision_model: Option<String>,
    /// Camera->cloud consent acknowledgement (fail-closed while false).
    vision_consent_acknowledged: Option<bool>,
    gemini_google_search: Option<bool>,
    tools: Option<UpdateLlmToolsSettings>,
    memory: Option<UpdateLlmMemorySettings>,
}

#[derive(Deserialize)]
struct UpdateLlmMemorySettings {
    enabled: Option<bool>,
    path: Option<String>,
    top_k: Option<usize>,
    snippet_chars: Option<usize>,
    max_context_chars: Option<usize>,
    auto_retrieve: Option<bool>,
    auto_remember: Option<bool>,
}

#[derive(Deserialize)]
struct UpdateLlmToolsSettings {
    enabled: Option<bool>,
    dynamic_tool_count: Option<usize>,
    max_tool_turns: Option<usize>,
    tool_concurrency: Option<usize>,
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
    /// Persisted immediately; applied on the next server start. Only safe behind
    /// an iroh peer allowlist; edge auth does not protect the direct listener.
    iroh_remote_center_full_access: Option<bool>,
    /// Write-only trusted bridge EndpointIds. Applied on the next server start.
    iroh_remote_center_allowed_peers: Option<Vec<String>>,
    /// Write-only. The administration token cannot be cleared through the API.
    admin_token: Option<String>,
    #[serde(default, deserialize_with = "deserialize_prompt_update")]
    system_prompt: PromptUpdate,
    #[serde(default, deserialize_with = "deserialize_prompt_update")]
    status_prompt: PromptUpdate,
    display_name: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum PromptUpdate {
    #[default]
    Unchanged,
    Clear,
    Set(String),
}

fn deserialize_prompt_update<'de, D>(deserializer: D) -> Result<PromptUpdate, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    match value {
        None => Ok(PromptUpdate::Clear),
        Some(prompt) if prompt.is_empty() => Ok(PromptUpdate::Clear),
        Some(prompt) if prompt.trim().is_empty() => {
            Err(serde::de::Error::custom("prompt cannot be whitespace-only"))
        }
        Some(prompt) => Ok(PromptUpdate::Set(prompt.trim().to_string())),
    }
}

#[derive(Deserialize)]
struct UpdateWeatherSettings {
    pirate_weather_api_key: Option<String>,
    measurement_system: Option<MeasurementSystem>,
    temperature_unit: Option<TemperatureUnit>,
}

#[derive(Deserialize)]
struct UpdateGoogleMapsSettings {
    /// Write-only. An empty string explicitly clears the persisted key.
    api_key: Option<String>,
    geolocation_enabled: Option<bool>,
    routes_enabled: Option<bool>,
    routes_compliance_acknowledged: Option<bool>,
    routes_travel_mode: Option<GoogleMapsTravelMode>,
    language_code: Option<String>,
}

#[derive(Deserialize)]
struct UpdateBraveSearchSettings {
    /// Write-only. An empty string explicitly clears the persisted token.
    api_key: Option<String>,
}

#[derive(Deserialize)]
struct UpdateOpenFoodFactsSettings {
    enabled: Option<bool>,
    attribution_acknowledged: Option<bool>,
}

#[derive(Deserialize)]
struct UpdateAzureSpeechSettings {
    /// Write-only. An empty string explicitly clears the persisted key.
    subscription_key: Option<String>,
    region: Option<String>,
    voice_name: Option<String>,
    enabled: Option<bool>,
    cloud_consent_acknowledged: Option<bool>,
}

#[derive(Deserialize)]
struct UpdateOpenStreetMapSettings {
    enabled: Option<bool>,
    location_consent_acknowledged: Option<bool>,
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
    // Reject attempts to change read-only fields.
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
    }
    if body.storage.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            "storage paths cannot be changed at runtime (requires server restart)",
        )
            .into_response();
    }

    if let Some(ref llm) = body.llm {
        if codex_bridge_update_conflicts_with_environment(
            llm.codex_bridge_url.is_some(),
            llm.codex_bridge_token.is_some(),
            std::env::var_os("CODEX_BRIDGE_URL").is_some(),
            std::env::var_os("CODEX_BRIDGE_TOKEN").is_some(),
        ) {
            return (
                StatusCode::BAD_REQUEST,
                "Codex bridge URL or token is managed by the process environment",
            )
                .into_response();
        }
    }

    if let Some(ref server) = body.server {
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
        if let PromptUpdate::Set(system_prompt) = &server.system_prompt {
            if let Err(error) = validate_prompt_template("server.system_prompt", system_prompt) {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("invalid server.system_prompt template: {error}"),
                )
                    .into_response();
            }
        }
        if let PromptUpdate::Set(status_prompt) = &server.status_prompt {
            if let Err(error) = validate_prompt_template("server.status_prompt", status_prompt) {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("invalid server.status_prompt template: {error}"),
                )
                    .into_response();
            }
        }
    }

    let runtime_rebuild_required = settings_require_runtime_rebuild(&body);

    // Serialize config transactions, but keep the live config lock available
    // to health/auth/settings readers while providers and memory are rebuilt.
    let _update_guard = state.config_update_lock.lock().await;
    let original_config = state.shared_config.read().await.clone();
    let mut config = original_config.clone();
    // --- LLM changes ---
    if let Some(ref llm) = body.llm {
        if let Some(provider) = llm.provider {
            if provider != config.llm.provider {
                config.llm.provider = provider;
            }
        }
        if let Some(ref model) = llm.model {
            if *model != config.llm.model {
                config.llm.model = model.clone();
            }
        }
        if let Some(enabled) = llm.hermes_progress_turns {
            // Retired, unconsumed compatibility flag: no production path reads
            // it to gate cue delivery. Warn once so a persisted `true` is not
            // mistaken for "progress cues active".
            static PROGRESS_TURNS_WARNED: std::sync::Once = std::sync::Once::new();
            PROGRESS_TURNS_WARNED.call_once(move || {
                warn!(
                    value = enabled,
                    "hermes_progress_turns is a retired, unconsumed compatibility flag; \
                     progress-cue delivery is NOT active (fail-closed) regardless of this value"
                );
            });
            if enabled != config.llm.hermes_progress_turns {
                config.llm.hermes_progress_turns = enabled;
            }
        }
        if let Some(enabled) = llm.spoken_progress_cues {
            if enabled != config.llm.spoken_progress_cues {
                // Loud on the way up only. Enabling changes what the device
                // says out loud and no automated check in this repository can
                // hear it; the operator is expected to be listening.
                if enabled {
                    warn!(
                        "spoken_progress_cues armed: the stock action-interstitial RPC will \
                         now answer a first read-tool action with a fixed phrase. No interim \
                         turns are streamed, so stock reaches that RPC only for actions \
                         missing from its own schema catalog. Supervised listening only."
                    );
                } else {
                    info!("spoken_progress_cues disarmed: empty interstitials only");
                }
                config.llm.spoken_progress_cues = enabled;
            }
        }
        if let Some(enabled) = llm.first_step_retry {
            if enabled != config.llm.first_step_retry {
                if enabled {
                    // Turning this on is a measurement, not a fix. It buys one
                    // more chance at a failed first model step by spending wall
                    // clock against a ~5-6s backend floor, so a retry that also
                    // fails leaves the turn slower AND still wrong. Compare
                    // decline rate and time-to-answer before and after; if the
                    // difference is flat, remove the flag and the retry.
                    info!(
                        "first_step_retry armed: a turn whose FIRST model step fails with a \
                         retryable fault will re-issue that step exactly once. Permanent faults \
                         (bad key, missing model, refusal) still decline immediately. Measure \
                         decline rate and latency; delete the flag if the result is flat."
                    );
                } else {
                    info!("first_step_retry disarmed: a failed first model step declines at once");
                }
                config.llm.first_step_retry = enabled;
            }
        }
        if let Some(enabled) = llm.turn_trace {
            if enabled != config.llm.turn_trace {
                if enabled {
                    info!(
                        "turn_trace armed: one diagnostic record per turn is written to the \
                         rolling turn-traces log and served from /api/traces. Shapes and counts \
                         only unless turn_trace_content is armed separately. Disarm when the \
                         fault has been captured."
                    );
                } else {
                    info!("turn_trace disarmed: no turn traces are recorded");
                }
                config.llm.turn_trace = enabled;
            }
        }
        if let Some(enabled) = llm.turn_trace_content {
            if enabled != config.llm.turn_trace_content {
                // Loud on the way up only. This is the switch that puts what
                // the wearer said, what the tools were handed, and what was
                // spoken back onto disk and onto an HTTP response.
                if enabled {
                    warn!(
                        "turn_trace_content armed: turn traces will now record the utterance, \
                         tool arguments and results, and the spoken answer, and /api/traces will \
                         serve them. Disarm it to stop both capture and retrieval."
                    );
                } else {
                    info!(
                        "turn_trace_content disarmed: traces are shape-only and previously \
                         captured text is no longer served"
                    );
                }
                config.llm.turn_trace_content = enabled;
            }
        }
        if let Some(ref api_key) = llm.api_key {
            config.llm.api_key = if api_key.is_empty() {
                None
            } else {
                Some(api_key.clone())
            };
        }
        if let Some(ref base_url) = llm.base_url {
            let new_val = if base_url.is_empty() {
                None
            } else {
                Some(base_url.clone())
            };
            if new_val != config.llm.base_url {
                config.llm.base_url = new_val;
            }
        }
        if let Some(ref bridge_url) = llm.codex_bridge_url {
            let trimmed = bridge_url.trim();
            let new_val = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
            if new_val != config.llm.codex_bridge_url {
                config.llm.codex_bridge_url = new_val;
            }
        }
        if let Some(ref bridge_token) = llm.codex_bridge_token {
            let trimmed = bridge_token.trim();
            config.llm.codex_bridge_token = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
        if let Some(ref bridge_ca_pem) = llm.codex_bridge_ca_pem {
            let trimmed = bridge_ca_pem.trim();
            config.llm.codex_bridge_ca_pem = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
        // Custom OpenAI-compatible provider for the on-device Codex app-server.
        // Values are validated centrally by config.llm.normalize_and_validate().
        {
            let touches_codex = llm.codex_provider_base_url.is_some()
                || llm.codex_model.is_some()
                || llm.codex_provider_name.is_some()
                || llm.codex_wire_api.is_some()
                || llm.codex_cue_model.is_some()
                || llm.codex_model_catalog_path.is_some()
                || llm.codex_api_key.is_some();
            if touches_codex && config.llm.codex.is_none() {
                config.llm.codex = Some(crate::config::LlmCodexConfig::default());
            }
            if let Some(codex) = config.llm.codex.as_mut() {
                if let Some(ref base_url) = llm.codex_provider_base_url {
                    let trimmed = base_url.trim();
                    codex.provider_base_url = (!trimmed.is_empty()).then(|| trimmed.to_string());
                }
                if let Some(ref model) = llm.codex_model {
                    let trimmed = model.trim();
                    codex.model = (!trimmed.is_empty()).then(|| trimmed.to_string());
                }
                if let Some(ref name) = llm.codex_provider_name {
                    let trimmed = name.trim();
                    if !trimmed.is_empty() {
                        codex.provider_name = trimmed.to_string();
                    }
                }
                if let Some(ref wire) = llm.codex_wire_api {
                    let trimmed = wire.trim();
                    if !trimmed.is_empty() {
                        codex.wire_api = trimmed.to_string();
                    }
                }
                if let Some(ref cue) = llm.codex_cue_model {
                    let trimmed = cue.trim();
                    codex.cue_model = (!trimmed.is_empty()).then(|| trimmed.to_string());
                }
                if let Some(ref catalog) = llm.codex_model_catalog_path {
                    let trimmed = catalog.trim();
                    codex.model_catalog_path = (!trimmed.is_empty()).then(|| trimmed.to_string());
                }
                if let Some(ref key) = llm.codex_api_key {
                    codex.api_key = if key.is_empty() {
                        None
                    } else {
                        Some(key.clone())
                    };
                }
            }
        }
        if let Some(ref cue_model) = llm.progress_cue_model {
            let trimmed = cue_model.trim();
            config.llm.progress_cue_model = (!trimmed.is_empty()).then(|| trimmed.to_string());
        }
        if let Some(ref vision_model) = llm.vision_model {
            let trimmed = vision_model.trim();
            config.llm.vision_model = (!trimmed.is_empty()).then(|| trimmed.to_string());
        }
        if let Some(acknowledged) = llm.vision_consent_acknowledged {
            config.llm.vision_consent_acknowledged = acknowledged;
        }
        if let Some(v) = llm.gemini_google_search {
            if v != config.llm.gemini_google_search {
                config.llm.gemini_google_search = v;
            }
        }
        if let Some(ref tools) = llm.tools {
            if let Some(enabled) = tools.enabled {
                if enabled != config.llm.tools.enabled {
                    config.llm.tools.enabled = enabled;
                }
            }
            if let Some(dynamic_tool_count) = tools.dynamic_tool_count {
                if dynamic_tool_count != config.llm.tools.dynamic_tool_count {
                    config.llm.tools.dynamic_tool_count = dynamic_tool_count;
                }
            }
            if let Some(max_tool_turns) = tools.max_tool_turns {
                if max_tool_turns != config.llm.tools.max_tool_turns {
                    config.llm.tools.max_tool_turns = max_tool_turns;
                }
            }
            if let Some(tool_concurrency) = tools.tool_concurrency {
                if tool_concurrency != config.llm.tools.tool_concurrency {
                    config.llm.tools.tool_concurrency = tool_concurrency;
                }
            }
        }
        if let Some(ref memory) = llm.memory {
            if let Some(enabled) = memory.enabled {
                config.llm.memory.enabled = enabled;
            }
            if let Some(ref path) = memory.path {
                let trimmed = path.trim();
                if trimmed.is_empty() {
                    return (StatusCode::BAD_REQUEST, "llm.memory.path cannot be empty")
                        .into_response();
                }
                if trimmed != config.llm.memory.path {
                    config.llm.memory.path = trimmed.to_string();
                }
            }
            if let Some(top_k) = memory.top_k {
                config.llm.memory.top_k = top_k.max(1);
            }
            if let Some(snippet_chars) = memory.snippet_chars {
                config.llm.memory.snippet_chars = snippet_chars.max(1);
            }
            if let Some(max_context_chars) = memory.max_context_chars {
                config.llm.memory.max_context_chars = max_context_chars.max(1);
            }
            if let Some(auto_retrieve) = memory.auto_retrieve {
                config.llm.memory.auto_retrieve = auto_retrieve;
            }
            if let Some(auto_remember) = memory.auto_remember {
                config.llm.memory.auto_remember = auto_remember;
            }
        }
    }

    // --- Server changes ---
    if let Some(ref server) = body.server {
        if let Some(enabled) = server.lan_dashboard_enabled {
            config.server.lan_dashboard_enabled = enabled;
        }
        if let Some(enabled) = server.iroh_remote_center_enabled {
            config.server.iroh_remote_center_enabled = enabled;
        }
        if let Some(enabled) = server.iroh_remote_center_full_access {
            config.server.iroh_remote_center_full_access = enabled;
        }
        if let Some(peers) = server.iroh_remote_center_allowed_peers.clone() {
            config.server.iroh_remote_center_allowed_peers =
                match normalize_iroh_remote_center_allowed_peers(peers) {
                    Ok(peers) => peers,
                    Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
                };
        }
        match &server.system_prompt {
            PromptUpdate::Unchanged => {}
            PromptUpdate::Clear => {
                if config.server.system_prompt.is_some() {
                    config.server.system_prompt = None;
                }
            }
            PromptUpdate::Set(system_prompt) => {
                match ServerConfig::configured_system_prompt(system_prompt.clone()) {
                    Ok(new_val) => {
                        if new_val != config.server.system_prompt {
                            config.server.system_prompt = new_val;
                        }
                    }
                    Err(error) => {
                        return (StatusCode::BAD_REQUEST, error).into_response();
                    }
                }
            }
        }
        match &server.status_prompt {
            PromptUpdate::Unchanged => {}
            PromptUpdate::Clear => {
                if config.server.status_prompt.is_some() {
                    config.server.status_prompt = None;
                }
            }
            PromptUpdate::Set(status_prompt) => {
                match ServerConfig::configured_status_prompt(status_prompt.clone()) {
                    Ok(new_val) => {
                        if new_val != config.server.status_prompt {
                            config.server.status_prompt = new_val;
                        }
                    }
                    Err(error) => {
                        return (StatusCode::BAD_REQUEST, error).into_response();
                    }
                }
            }
        }
        if let Some(ref display_name) = server.display_name {
            let new_val = if display_name.is_empty() {
                None
            } else {
                Some(display_name.clone())
            };
            config.server.display_name = new_val;
        }
        if let Some(ref admin_token) = server.admin_token {
            if let Err(error) = validate_admin_token(admin_token) {
                return (StatusCode::BAD_REQUEST, error).into_response();
            }
            config.server.admin_token = Some(admin_token.clone());
        }
    }

    // --- Weather changes ---
    if let Some(ref weather) = body.weather {
        if let Some(ref key) = weather.pirate_weather_api_key {
            let new_val = if key.is_empty() {
                None
            } else {
                Some(key.clone())
            };
            if new_val != config.weather.pirate_weather_api_key {
                config.weather.pirate_weather_api_key = new_val;
            }
        }
        if let Some(measurement_system) = weather.measurement_system {
            config.weather.measurement_system = measurement_system;
        }
        if let Some(temperature_unit) = weather.temperature_unit {
            config.weather.temperature_unit = temperature_unit;
        }
    }

    // --- Brave Search changes ---
    if let Some(ref brave_search) = body.brave_search {
        if let Some(ref key) = brave_search.api_key {
            let trimmed = key.trim();
            config.brave_search.api_key = (!trimmed.is_empty()).then(|| trimmed.to_string());
        }
    }

    // --- Google Maps changes ---
    if let Some(ref google_maps) = body.google_maps {
        if let Some(ref key) = google_maps.api_key {
            let trimmed = key.trim();
            config.google_maps.api_key = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
        if let Some(enabled) = google_maps.geolocation_enabled {
            config.google_maps.geolocation_enabled = enabled;
        }
        if let Some(enabled) = google_maps.routes_enabled {
            config.google_maps.routes_enabled = enabled;
        }
        if let Some(acknowledged) = google_maps.routes_compliance_acknowledged {
            config.google_maps.routes_compliance_acknowledged = acknowledged;
        }
        if let Some(mode) = google_maps.routes_travel_mode {
            config.google_maps.routes_travel_mode = mode;
        }
        if let Some(ref language_code) = google_maps.language_code {
            config.google_maps.language_code = language_code.clone();
        }
    }

    // --- Open Food Facts changes ---
    if let Some(ref open_food_facts) = body.open_food_facts {
        if let Some(enabled) = open_food_facts.enabled {
            config.open_food_facts.enabled = enabled;
        }
        if let Some(acknowledged) = open_food_facts.attribution_acknowledged {
            config.open_food_facts.attribution_acknowledged = acknowledged;
        }
    }

    // --- Azure Speech changes ---
    if let Some(ref azure_speech) = body.azure_speech {
        if let Some(ref key) = azure_speech.subscription_key {
            config.azure_speech.subscription_key = if key.trim().is_empty() {
                None
            } else {
                Some(key.trim().to_string())
            };
        }
        if let Some(ref region) = azure_speech.region {
            config.azure_speech.region = if region.trim().is_empty() {
                None
            } else {
                Some(region.trim().to_string())
            };
        }
        if let Some(ref voice_name) = azure_speech.voice_name {
            config.azure_speech.voice_name = if voice_name.trim().is_empty() {
                None
            } else {
                Some(voice_name.trim().to_string())
            };
        }
        if let Some(enabled) = azure_speech.enabled {
            config.azure_speech.enabled = enabled;
        }
        if let Some(acknowledged) = azure_speech.cloud_consent_acknowledged {
            config.azure_speech.cloud_consent_acknowledged = acknowledged;
        }
    }

    // --- OpenStreetMap changes ---
    if let Some(ref openstreetmap) = body.openstreetmap {
        if let Some(enabled) = openstreetmap.enabled {
            config.openstreetmap.enabled = enabled;
        }
        if let Some(acknowledged) = openstreetmap.location_consent_acknowledged {
            config.openstreetmap.location_consent_acknowledged = acknowledged;
        }
    }

    // --- Contacts changes ---
    if let Some(ref contacts) = body.contacts {
        if let Some(new_val) = contacts.trust_all_contacts {
            config.contacts.trust_all_contacts = new_val;
        }
        if let Some(new_val) = contacts.allow_all_inbound {
            config.contacts.allow_all_inbound = new_val;
        }
    }

    // --- Dev changes ---
    if let Some(ref dev) = body.dev {
        if let Some(new_val) = dev.apk_install_enabled {
            config.dev.apk_install_enabled = new_val;
        }
        if let Some(new_val) = dev.injected_package_recovery_enabled {
            config.dev.injected_package_recovery_enabled = new_val;
        }
        if let Some(ref digest) = dev.injected_package_recovery_hook_sha256 {
            let trimmed = digest.trim();
            config.dev.injected_package_recovery_hook_sha256 = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
        if let Some(ref digest) = dev.injected_package_recovery_hook_injector_sha256 {
            let trimmed = digest.trim();
            config.dev.injected_package_recovery_hook_injector_sha256 = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
    }

    if let Err(error) = config.dev.validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    if let Err(error) = config.llm.normalize_and_validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    if let Err(error) = config.google_maps.normalize_and_validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    if body.open_food_facts.is_some() {
        if let Err(error) =
            feature_flags::validate_open_food_facts_provider_dependency(&config).await
        {
            return error.into_response();
        }
    } else if let Err(error) = config.open_food_facts.validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    if let Err(error) = config.azure_speech.normalize_and_validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    if let Err(error) = config.openstreetmap.validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }

    // Listener/auth/display/contact/dev-only changes do not affect AiBus or
    // Speech. Committing them directly avoids touching the active Memvid file
    // and keeps routine dashboard provisioning fast.
    if !runtime_rebuild_required {
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
        let settings = settings_response_with_restart(
            &config,
            listener_restart_required(&config, state.active_lan_dashboard_enabled),
        );
        info!("settings updated successfully without runtime rebuild");
        return Json(settings).into_response();
    }

    let new_resolved = Arc::new(ResolvedConfig::resolve(config.clone()));
    let google_maps = match GoogleMapsClient::from_options(new_resolved.google_maps_options.clone())
    {
        Ok(client) => client,
        Err(error) => {
            warn!(
                error_kind = error.kind(),
                "failed to initialize Google Maps provider, rolling back"
            );
            return (
                StatusCode::BAD_REQUEST,
                "invalid Google Maps provider configuration",
            )
                .into_response();
        }
    };
    let open_food_facts =
        match OpenFoodFactsClient::from_options(new_resolved.open_food_facts_options.clone()) {
            Ok(client) => client,
            Err(error) => {
                warn!(
                    error_kind = error.kind(),
                    "failed to initialize Open Food Facts provider, rolling back"
                );
                return (
                    StatusCode::BAD_REQUEST,
                    "invalid Open Food Facts provider configuration",
                )
                    .into_response();
            }
        };
    let azure_speech =
        match AzureSpeechClient::from_options(new_resolved.azure_speech_options.clone()) {
            Ok(client) => client,
            Err(error) => {
                warn!(
                    error_kind = error.kind(),
                    "failed to initialize Azure Speech provider, rolling back"
                );
                return (
                    StatusCode::BAD_REQUEST,
                    "invalid Azure Speech provider configuration",
                )
                    .into_response();
            }
        };

    // --- Validate: build a new LLM/AiBus tree before committing ---
    let memory = if !config.llm.memory.enabled {
        None
    } else if config.llm.memory == original_config.llm.memory {
        match state.active_memory.read().await.clone() {
            Some(memory) => Some(memory),
            // Memory config is unchanged and no service is currently active: it
            // failed to initialize earlier (e.g. the memvid flock/ENOSYS on
            // sdcardfs) and is running degraded. Re-opening would fail the same
            // way, so keep memory degraded and still apply this (unrelated)
            // settings change instead of rejecting it. A genuine memory-config
            // change (the `else` branch) still validates the new configuration.
            None => match MemoryService::open(config.llm.memory.clone()).await {
                Ok(memory) => Some(memory),
                Err(error) => {
                    warn!(
                        error = %error,
                        "assistant memory still unavailable; applying settings with memory degraded"
                    );
                    None
                }
            },
        }
    } else {
        match MemoryService::open(config.llm.memory.clone()).await {
            Ok(memory) => Some(memory),
            Err(error) => {
                warn!(error = %error, "failed to initialize assistant memory, rolling back");
                return (
                    StatusCode::BAD_REQUEST,
                    format!("invalid memory configuration: {error}"),
                )
                    .into_response();
            }
        }
    };

    let agent_result = LlmAgent::from_config(
        &new_resolved,
        state.http_client.clone(),
        state.llm_request_logger.clone(),
        memory.clone(),
    )
    .await
    .map_err(|e| e.to_string());

    let (new_aibus, new_composition_agent) = match agent_result {
        Ok(new_agent) => {
            let agent = Arc::new(new_agent);
            let external_clients = AiBusExternalClients::new(
                google_maps,
                open_food_facts,
                Some(state.spotify.clone()),
            )
            .with_food_runtime_gate(state.food_runtime_gate.clone());
            (
                Arc::new(
                    AiBusHanders::new_with_external_clients(
                        agent.clone(),
                        new_resolved.clone(),
                        state.shared_config.clone(),
                        NearbyClient::new(
                            state.http_client.clone(),
                            new_resolved.openstreetmap_options.clone(),
                        ),
                        state.http_client.clone(),
                        state.db.clone(),
                        memory.clone(),
                        external_clients,
                    )
                    .with_function_execution(state.aibus.function_execution_handler()),
                ),
                agent,
            )
        }
        Err(e) => {
            warn!(error = %e, "failed to build AiBus service with new settings, rolling back");
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid LLM configuration: {e}"),
            )
                .into_response();
        }
    };

    // Persist before publishing the new runtime tree. A successful response
    // must survive reboot; on any disk failure both live and stored settings
    // remain at the previous configuration.
    if let Err(e) = persist_config_durably(
        &state.config_path,
        &config,
        &original_config,
        &state.esim_bridge,
    )
    .await
    {
        warn!(error = %e, "failed to persist config, rolling back");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "settings update could not be confirmed; reload settings before retrying",
        )
            .into_response();
    }

    if config.weather.temperature_unit != original_config.weather.temperature_unit {
        if let Err(error) =
            sync_weather_temperature_unit_to_device(config.weather.temperature_unit).await
        {
            // A bridge write can fail after the provider applied it but before
            // the acknowledgement arrived. Best-effort restore both device UI
            // state and durable configuration before reporting failure.
            let device_rollback =
                sync_weather_temperature_unit_to_device(original_config.weather.temperature_unit)
                    .await;
            let config_rollback = persist_config_durably(
                &state.config_path,
                &original_config,
                &config,
                &state.esim_bridge,
            )
            .await;
            warn!(
                error = %error,
                device_rollback_ok = device_rollback.is_ok(),
                config_rollback_ok = config_rollback.is_ok(),
                "weather unit synchronization failed; rolled back settings"
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "weather unit could not be synchronized to the stock display; reload settings before retrying",
            )
                .into_response();
        }
    }

    state.aibus.replace(new_aibus).await;
    state
        .composition_service
        .replace(new_composition_agent.clone(), new_resolved.clone())
        .await;
    state
        .speech_service
        .replace_with_translation(azure_speech, new_composition_agent, new_resolved)
        .await;
    *state.active_memory.write().await = memory;
    {
        let mut live_config = state.shared_config.write().await;
        *live_config = config.clone();
    }
    // Hot-apply the llm settings whose consumers cannot read the live config
    // for themselves (the stock action-interstitial RPC boundary, and the
    // chat-turn loop config). Deliberately here, at the commit, and not next to
    // `ResolvedConfig::resolve` above: every rollback path between the two
    // returns without committing, and arming from a config that was rolled back
    // would leave the process disagreeing with both disk and the settings
    // response.
    crate::config::apply_spoken_progress_cues(config.llm.spoken_progress_cues);
    crate::config::apply_first_step_retry(config.llm.first_step_retry);
    crate::config::apply_turn_trace(config.llm.turn_trace, config.llm.turn_trace_content);
    state.dedup.clear().await;
    info!(
        provider = %config.llm.provider,
        model = %config.llm.model,
        "hot-reloaded AiBus, Composition, and Speech services"
    );

    // Build response from the updated config.
    let settings = settings_response_with_restart(
        &config,
        listener_restart_required(&config, state.active_lan_dashboard_enabled),
    );

    info!("settings updated successfully");
    Json(settings).into_response()
}

fn settings_require_runtime_rebuild(body: &UpdateSettingsRequest) -> bool {
    body.llm.is_some()
        || body.weather.is_some()
        || body.google_maps.is_some()
        // A search-subscription write has to rebuild: the Brave client is
        // constructed from the resolved config when the AiBus tree is built,
        // and the `web_search` tool is advertised only when that client says
        // it is configured. Persisting the token without a rebuild leaves the
        // running planner unable to see the tool until the next restart.
        || body.brave_search.is_some()
        || body.open_food_facts.is_some()
        || body.azure_speech.is_some()
        || body.openstreetmap.is_some()
        || body.server.as_ref().is_some_and(|server| {
            server.system_prompt != PromptUpdate::Unchanged
                || server.status_prompt != PromptUpdate::Unchanged
        })
}

fn admin_token_update_conflicts_with_environment(
    update_requested: bool,
    environment_present: bool,
) -> bool {
    update_requested && environment_present
}

fn codex_bridge_update_conflicts_with_environment(
    url_update_requested: bool,
    token_update_requested: bool,
    url_environment_present: bool,
    token_environment_present: bool,
) -> bool {
    (url_update_requested && url_environment_present)
        || (token_update_requested && token_environment_present)
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
        match &config.llm.codex_bridge_url {
            Some(url) => table["codex_bridge_url"] = toml_edit::value(url),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("codex_bridge_url");
                }
            }
        }
        match &config.llm.codex_bridge_token {
            Some(token) => table["codex_bridge_token"] = toml_edit::value(token),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("codex_bridge_token");
                }
            }
        }
        match &config.llm.codex_bridge_ca_pem {
            Some(ca_pem) => table["codex_bridge_ca_pem"] = toml_edit::value(ca_pem),
            None => {
                if let Some(t) = table.as_table_mut() {
                    t.remove("codex_bridge_ca_pem");
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

    // --- [llm.codex] ---
    {
        match &config.llm.codex {
            Some(codex) => {
                if doc["llm"].as_table_mut().is_none() {
                    doc["llm"] = toml_edit::Item::Table(toml_edit::Table::new());
                }
                if doc["llm"]["codex"].as_table_mut().is_none() {
                    doc["llm"]["codex"] = toml_edit::Item::Table(toml_edit::Table::new());
                }
                let table = &mut doc["llm"]["codex"];
                match &codex.provider_base_url {
                    Some(v) => table["provider_base_url"] = toml_edit::value(v),
                    None => {
                        if let Some(t) = table.as_table_mut() {
                            t.remove("provider_base_url");
                        }
                    }
                }
                match &codex.model {
                    Some(v) => table["model"] = toml_edit::value(v),
                    None => {
                        if let Some(t) = table.as_table_mut() {
                            t.remove("model");
                        }
                    }
                }
                table["api_key_env"] = toml_edit::value(&codex.api_key_env);
                table["provider_name"] = toml_edit::value(&codex.provider_name);
                table["wire_api"] = toml_edit::value(&codex.wire_api);
                match &codex.cue_model {
                    Some(v) => table["cue_model"] = toml_edit::value(v),
                    None => {
                        if let Some(t) = table.as_table_mut() {
                            t.remove("cue_model");
                        }
                    }
                }
                match &codex.api_key {
                    Some(v) => table["api_key"] = toml_edit::value(v),
                    None => {
                        if let Some(t) = table.as_table_mut() {
                            t.remove("api_key");
                        }
                    }
                }
                match &codex.model_catalog_path {
                    Some(v) => table["model_catalog_path"] = toml_edit::value(v),
                    None => {
                        if let Some(t) = table.as_table_mut() {
                            t.remove("model_catalog_path");
                        }
                    }
                }
            }
            None => {
                if let Some(t) = doc["llm"].as_table_mut() {
                    t.remove("codex");
                }
            }
        }
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
        table["iroh_remote_center_full_access"] =
            toml_edit::value(config.server.iroh_remote_center_full_access);
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
            ("llm", &["api_key", "codex_bridge_token"][..]),
            ("weather", &["pirate_weather_api_key"][..]),
            ("google_maps", &["api_key"][..]),
            ("brave_search", &["api_key"][..]),
            ("azure_speech", &["subscription_key"][..]),
            ("server", &["admin_token", "grpc_auth_token"][..]),
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

    #[derive(Debug, Deserialize)]
    struct PromptUpdateFixture {
        #[serde(default, deserialize_with = "deserialize_prompt_update")]
        prompt: PromptUpdate,
    }

    #[test]
    fn prompt_update_missing_is_unchanged() {
        let fixture: PromptUpdateFixture = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(fixture.prompt, PromptUpdate::Unchanged);
    }

    #[test]
    fn prompt_update_null_clears() {
        let fixture: PromptUpdateFixture = serde_json::from_str(r#"{"prompt":null}"#).unwrap();
        assert_eq!(fixture.prompt, PromptUpdate::Clear);
    }

    #[test]
    fn prompt_update_empty_string_clears() {
        let fixture: PromptUpdateFixture = serde_json::from_str(r#"{"prompt":""}"#).unwrap();
        assert_eq!(fixture.prompt, PromptUpdate::Clear);
    }

    #[test]
    fn prompt_update_string_sets_trimmed_custom_prompt() {
        let fixture: PromptUpdateFixture =
            serde_json::from_str(r#"{"prompt":"  Custom prompt  "}"#).unwrap();
        assert_eq!(fixture.prompt, PromptUpdate::Set("Custom prompt".into()));
    }

    #[test]
    fn listener_and_access_settings_do_not_rebuild_runtime_services() {
        let body: UpdateSettingsRequest = serde_json::from_str(
            r#"{
                "server":{"lan_dashboard_enabled":true,"display_name":"Pin"},
                "contacts":{"trust_all_contacts":true},
                "dev":{"apk_install_enabled":false}
            }"#,
        )
        .unwrap();

        assert!(!settings_require_runtime_rebuild(&body));
    }

    #[test]
    fn provider_and_prompt_settings_rebuild_runtime_services() {
        for json in [
            r#"{"llm":{}}"#,
            r#"{"google_maps":{}}"#,
            r#"{"brave_search":{}}"#,
            r#"{"azure_speech":{}}"#,
            r#"{"server":{"system_prompt":"Keep answers short."}}"#,
        ] {
            let body: UpdateSettingsRequest = serde_json::from_str(json).unwrap();
            assert!(settings_require_runtime_rebuild(&body), "{json}");
        }
    }

    #[test]
    fn prompt_update_whitespace_string_is_rejected() {
        let error = serde_json::from_str::<PromptUpdateFixture>(r#"{"prompt":"   "}"#)
            .unwrap_err()
            .to_string();
        assert!(error.contains("prompt cannot be whitespace-only"));
    }

    #[test]
    fn codex_settings_response_exposes_only_token_presence() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.llm.provider = LlmProvider::Codex;
        config.llm.codex_bridge_url = Some("http://127.0.0.1:9876".into());
        config.llm.codex_bridge_token = Some("bridge-secret-0123456789abcdefghijkl".into());
        config.llm.codex_bridge_ca_pem = Some(crate::llm::codex_bridge::TEST_CA_PEM.into());

        let json = serde_json::to_value(settings_response(&config)).unwrap();
        let llm = json.get("llm").unwrap();

        assert_eq!(llm.get("provider").unwrap(), "codex");
        assert!(llm.get("codex_bridge_url").unwrap().is_string());
        assert_eq!(llm.get("has_codex_bridge_token").unwrap(), true);
        assert_eq!(llm.get("has_codex_bridge_ca").unwrap(), true);
        assert!(llm.get("codex_bridge_token").is_none());
        assert!(llm.get("codex_bridge_ca_pem").is_none());
        assert!(!json
            .to_string()
            .contains("bridge-secret-0123456789abcdefghijkl"));
        assert!(!json.to_string().contains("BEGIN CERTIFICATE"));
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
        config.server.iroh_remote_center_full_access = true;
        config.server.iroh_remote_center_allowed_peers = vec![peer.into()];

        let response = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(response["server"]["iroh_remote_center_enabled"], true);
        assert_eq!(response["server"]["iroh_remote_center_full_access"], true);
        assert_eq!(
            response["server"]["iroh_remote_center_allowed_peer_count"],
            1
        );
        assert!(response["server"]
            .get("iroh_remote_center_allowed_peers")
            .is_none());
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
    fn environment_authority_rejects_shadowed_codex_bridge_updates() {
        assert!(codex_bridge_update_conflicts_with_environment(
            true, false, true, false,
        ));
        assert!(codex_bridge_update_conflicts_with_environment(
            false, true, false, true,
        ));
        assert!(!codex_bridge_update_conflicts_with_environment(
            true, false, false, true,
        ));
        assert!(!codex_bridge_update_conflicts_with_environment(
            false, true, true, false,
        ));
        assert!(!codex_bridge_update_conflicts_with_environment(
            false, false, true, true,
        ));
    }

    #[test]
    fn codex_bridge_settings_are_persisted_and_clearable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.llm.provider = LlmProvider::Codex;
        config.llm.model = "gpt-5.4".into();
        config.llm.codex_bridge_url = Some("http://127.0.0.1:9876".into());
        config.llm.codex_bridge_token = Some("bridge-secret-0123456789abcdefghijkl".into());
        config.llm.codex_bridge_ca_pem = Some(crate::llm::codex_bridge::TEST_CA_PEM.into());

        persist_config(&path, &config).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.llm.provider, LlmProvider::Codex);
        assert_eq!(
            loaded.llm.codex_bridge_url.as_deref(),
            Some("http://127.0.0.1:9876")
        );
        assert_eq!(
            loaded.llm.codex_bridge_token.as_deref(),
            Some("bridge-secret-0123456789abcdefghijkl")
        );
        assert_eq!(
            loaded.llm.codex_bridge_ca_pem.as_deref(),
            Some(crate::llm::codex_bridge::TEST_CA_PEM)
        );

        config.llm.codex_bridge_url = None;
        config.llm.codex_bridge_token = None;
        config.llm.codex_bridge_ca_pem = None;
        persist_config(&path, &config).unwrap();
        let persisted = std::fs::read_to_string(path).unwrap();
        assert!(!persisted.contains("codex_bridge_url"));
        assert!(!persisted.contains("codex_bridge_token"));
        assert!(!persisted.contains("codex_bridge_ca_pem"));
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
    fn spoken_progress_cues_ships_off_and_is_settable_independently_of_the_retired_flag() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        let defaults = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(defaults["llm"]["spoken_progress_cues"], false);
        // The retired neighbour ships `true`; reusing it would have armed
        // every fresh install.
        assert_eq!(defaults["llm"]["hermes_progress_turns"], true);

        config.llm.spoken_progress_cues = true;
        let armed = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(armed["llm"]["spoken_progress_cues"], true);

        // Absent in the request means "leave stored value alone".
        let untouched: UpdateSettingsRequest = serde_json::from_str(r#"{"llm":{}}"#).unwrap();
        assert_eq!(untouched.llm.unwrap().spoken_progress_cues, None);

        let update: UpdateSettingsRequest =
            serde_json::from_str(r#"{"llm":{"spoken_progress_cues":true}}"#).unwrap();
        assert_eq!(update.llm.unwrap().spoken_progress_cues, Some(true));

        // Any llm write takes the rebuild path, which is the branch containing
        // the hot-apply of this setting.
        let body: UpdateSettingsRequest =
            serde_json::from_str(r#"{"llm":{"spoken_progress_cues":true}}"#).unwrap();
        assert!(settings_require_runtime_rebuild(&body));
    }

    #[test]
    fn first_step_retry_ships_off_and_is_settable() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        let defaults = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(defaults["llm"]["first_step_retry"], false);

        config.llm.first_step_retry = true;
        let armed = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(armed["llm"]["first_step_retry"], true);

        // Absent in the request means "leave stored value alone".
        let untouched: UpdateSettingsRequest = serde_json::from_str(r#"{"llm":{}}"#).unwrap();
        assert_eq!(untouched.llm.unwrap().first_step_retry, None);

        let update: UpdateSettingsRequest =
            serde_json::from_str(r#"{"llm":{"first_step_retry":true}}"#).unwrap();
        assert_eq!(update.llm.unwrap().first_step_retry, Some(true));

        // Any llm write takes the rebuild path, which is the branch containing
        // the hot-apply of this setting.
        let body: UpdateSettingsRequest =
            serde_json::from_str(r#"{"llm":{"first_step_retry":true}}"#).unwrap();
        assert!(settings_require_runtime_rebuild(&body));
    }

    #[test]
    fn turn_trace_ships_off_in_both_halves_and_each_is_settable_alone() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        let defaults = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(defaults["llm"]["turn_trace"], false);
        assert_eq!(defaults["llm"]["turn_trace_content"], false);

        // Arming the master switch alone leaves content capture off, so the
        // default capture is shape-only.
        config.llm.turn_trace = true;
        let armed = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(armed["llm"]["turn_trace"], true);
        assert_eq!(armed["llm"]["turn_trace_content"], false);

        // Absent in the request means "leave stored value alone".
        let untouched: UpdateSettingsRequest = serde_json::from_str(r#"{"llm":{}}"#).unwrap();
        let untouched = untouched.llm.unwrap();
        assert_eq!(untouched.turn_trace, None);
        assert_eq!(untouched.turn_trace_content, None);

        let update: UpdateSettingsRequest =
            serde_json::from_str(r#"{"llm":{"turn_trace":true,"turn_trace_content":true}}"#)
                .unwrap();
        let update = update.llm.unwrap();
        assert_eq!(update.turn_trace, Some(true));
        assert_eq!(update.turn_trace_content, Some(true));

        // Any llm write takes the rebuild path, which is the branch containing
        // the hot-apply of these settings.
        let body: UpdateSettingsRequest =
            serde_json::from_str(r#"{"llm":{"turn_trace":true}}"#).unwrap();
        assert!(settings_require_runtime_rebuild(&body));
    }

    #[test]
    fn weather_unit_preferences_default_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        let defaults = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(defaults["weather"]["measurement_system"], "metric");
        assert_eq!(defaults["weather"]["temperature_unit"], "celsius");

        config.weather.measurement_system = MeasurementSystem::Imperial;
        config.weather.temperature_unit = TemperatureUnit::Fahrenheit;
        persist_config(&path, &config).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(
            loaded.weather.measurement_system,
            MeasurementSystem::Imperial
        );
        assert_eq!(loaded.weather.temperature_unit, TemperatureUnit::Fahrenheit);

        let update: UpdateSettingsRequest = serde_json::from_str(
            r#"{"weather":{"measurement_system":"metric","temperature_unit":"celsius"}}"#,
        )
        .unwrap();
        let weather = update.weather.unwrap();
        assert_eq!(weather.measurement_system, Some(MeasurementSystem::Metric));
        assert_eq!(weather.temperature_unit, Some(TemperatureUnit::Celsius));
    }

    #[test]
    fn google_maps_settings_response_exposes_only_key_presence() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.google_maps.api_key = Some("maps-secret".into());
        config.google_maps.geolocation_enabled = true;
        config.google_maps.routes_travel_mode = GoogleMapsTravelMode::Bicycle;

        let json = serde_json::to_value(settings_response(&config)).unwrap();
        let maps = json.get("google_maps").unwrap();

        assert_eq!(maps.get("has_api_key").unwrap(), true);
        assert_eq!(maps.get("geolocation_enabled").unwrap(), true);
        assert_eq!(maps.get("routes_enabled").unwrap(), false);
        assert_eq!(maps.get("routes_travel_mode").unwrap(), "bicycle");
        assert!(maps.get("api_key").is_none());
        assert!(!json.to_string().contains("maps-secret"));
    }

    #[test]
    fn google_maps_settings_are_persisted_and_clearable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.google_maps.api_key = Some("maps-secret".into());
        config.google_maps.geolocation_enabled = true;
        config.google_maps.routes_enabled = true;
        config.google_maps.routes_compliance_acknowledged = true;
        config.google_maps.routes_travel_mode = GoogleMapsTravelMode::Drive;
        config.google_maps.language_code = "da-DK".into();

        persist_config(&path, &config).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.google_maps, config.google_maps);

        config.google_maps.api_key = None;
        config.google_maps.geolocation_enabled = false;
        config.google_maps.routes_enabled = false;
        config.google_maps.routes_compliance_acknowledged = false;
        persist_config(&path, &config).unwrap();

        let persisted = std::fs::read_to_string(&path).unwrap();
        let google_maps_table = persisted
            .split("[google_maps]")
            .nth(1)
            .expect("google_maps table is persisted")
            .split('\n')
            .take_while(|line| !line.starts_with('['))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!google_maps_table.contains("api_key"));
        assert!(!persisted.contains("maps-secret"));
        assert!(!std::fs::read_to_string(path.with_extension("toml.bak"))
            .unwrap()
            .contains("maps-secret"));
        assert_eq!(Config::load(&path).unwrap().google_maps.api_key, None);
    }

    #[test]
    fn google_maps_empty_key_update_is_an_explicit_clear() {
        let update: UpdateSettingsRequest =
            serde_json::from_str(r#"{"google_maps":{"api_key":"","routes_enabled":false}}"#)
                .unwrap();
        let google_maps = update.google_maps.unwrap();

        assert_eq!(google_maps.api_key.as_deref(), Some(""));
        assert_eq!(google_maps.routes_enabled, Some(false));
    }

    #[test]
    fn open_food_facts_settings_round_trip_without_implicit_acknowledgement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();

        let defaults = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(defaults["open_food_facts"]["enabled"], false);
        assert_eq!(
            defaults["open_food_facts"]["attribution_acknowledged"],
            false
        );

        config.open_food_facts.enabled = true;
        config.open_food_facts.attribution_acknowledged = true;
        persist_config(&path, &config).unwrap();

        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.open_food_facts, config.open_food_facts);

        let update: UpdateSettingsRequest =
            serde_json::from_str(r#"{"open_food_facts":{"enabled":true}}"#).unwrap();
        let food = update.open_food_facts.unwrap();
        assert_eq!(food.enabled, Some(true));
        assert_eq!(food.attribution_acknowledged, None);
    }

    #[test]
    fn azure_speech_settings_are_write_only_persisted_and_clearable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.azure_speech.subscription_key = Some("0123456789abcdef0123456789abcdef".into());
        config.azure_speech.region = Some("southeastasia".into());
        config.azure_speech.voice_name = Some("en-US-AvaMultilingualNeural".into());
        config.azure_speech.enabled = true;
        config.azure_speech.cloud_consent_acknowledged = true;

        let json = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(json["azure_speech"]["has_subscription_key"], true);
        assert_eq!(json["azure_speech"]["enabled"], true);
        assert!(json["azure_speech"].get("subscription_key").is_none());
        assert!(!json.to_string().contains("0123456789abcdef"));

        persist_config(&path, &config).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.azure_speech, config.azure_speech);

        config.azure_speech.subscription_key = None;
        config.azure_speech.enabled = false;
        config.azure_speech.cloud_consent_acknowledged = false;
        persist_config(&path, &config).unwrap();
        let persisted = std::fs::read_to_string(&path).unwrap();
        let backup = std::fs::read_to_string(path.with_extension("toml.bak")).unwrap();
        assert!(!persisted.contains("0123456789abcdef"));
        assert!(!backup.contains("0123456789abcdef"));

        let update: UpdateSettingsRequest =
            serde_json::from_str(r#"{"azure_speech":{"subscription_key":"","enabled":false}}"#)
                .unwrap();
        let speech = update.azure_speech.unwrap();
        assert_eq!(speech.subscription_key.as_deref(), Some(""));
        assert_eq!(speech.enabled, Some(false));
        assert_eq!(speech.cloud_consent_acknowledged, None);
    }

    #[test]
    fn persistence_fails_closed_for_local_overlays_and_inline_tables() {
        let local_dir = tempfile::tempdir().unwrap();
        let local_path = local_dir.path().join("config.toml");
        std::fs::write(&local_path, "[server]\ndisplay_name = \"Base\"\n").unwrap();
        std::fs::write(
            local_dir.path().join("config.local.toml"),
            "[llm]\ncodex_bridge_token = \"local-only-secret-0123456789abcdefghijkl\"\n",
        )
        .unwrap();
        let config = Config::load(&local_path).unwrap();
        let before = std::fs::read_to_string(&local_path).unwrap();
        let error = persist_config(&local_path, &config).unwrap_err();
        assert!(error.contains("config.local.toml"));
        assert_eq!(std::fs::read_to_string(&local_path).unwrap(), before);
        assert!(!local_path.with_extension("toml.bak").exists());

        let inline_dir = tempfile::tempdir().unwrap();
        let inline_path = inline_dir.path().join("config.toml");
        let inline = r#"llm = { provider = "codex", model = "gpt-5.4", codex_bridge_token = "inline-secret-0123456789abcdefghijkl" }
[server]
http_bind_addr = "127.0.0.1:8080"
"#;
        std::fs::write(&inline_path, inline).unwrap();
        let config = Config::load(&inline_path).unwrap();
        let error = persist_config(&inline_path, &config).unwrap_err();
        assert!(error.contains("inline TOML table"));
        assert_eq!(std::fs::read_to_string(&inline_path).unwrap(), inline);
        assert!(!inline_path.with_extension("toml.bak").exists());

        let inline_server_path = inline_dir.path().join("server-inline.toml");
        let admin_token = "a".repeat(crate::config::MIN_ADMIN_TOKEN_BYTES);
        let inline_server = format!(
            "server = {{ http_bind_addr = \"127.0.0.1:8080\", admin_token = \"{admin_token}\" }}\n"
        );
        std::fs::write(&inline_server_path, &inline_server).unwrap();
        let config = Config::load(&inline_server_path).unwrap();
        let error = persist_config(&inline_server_path, &config).unwrap_err();
        assert!(error.contains("inline TOML table"));
        assert_eq!(
            std::fs::read_to_string(&inline_server_path).unwrap(),
            inline_server
        );
        assert!(!inline_server_path.with_extension("toml.bak").exists());
    }

    #[test]
    fn openstreetmap_settings_round_trip_with_independent_consent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        let defaults = serde_json::to_value(settings_response(&config)).unwrap();
        assert_eq!(defaults["openstreetmap"]["enabled"], false);
        assert_eq!(
            defaults["openstreetmap"]["location_consent_acknowledged"],
            false
        );

        config.openstreetmap.enabled = true;
        config.openstreetmap.location_consent_acknowledged = true;
        persist_config(&path, &config).unwrap();
        assert_eq!(
            Config::load(&path).unwrap().openstreetmap,
            config.openstreetmap
        );

        let update: UpdateSettingsRequest =
            serde_json::from_str(r#"{"openstreetmap":{"enabled":true}}"#).unwrap();
        let openstreetmap = update.openstreetmap.unwrap();
        assert_eq!(openstreetmap.enabled, Some(true));
        assert_eq!(openstreetmap.location_consent_acknowledged, None);
    }

    #[test]
    fn spotify_settings_round_trip_and_disabling_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.spotify.enabled = true;
        config.spotify.experimental_acknowledged = true;
        config.spotify.device_name = "Kitchen Ai Pin".into();

        persist_config(&path, &config).unwrap();
        assert_eq!(Config::load(&path).unwrap().spotify, config.spotify);

        config.spotify.enabled = false;
        config.spotify.experimental_acknowledged = false;
        config.spotify.device_name = "Travel Ai Pin".into();
        persist_config(&path, &config).unwrap();
        assert_eq!(Config::load(&path).unwrap().spotify, config.spotify);
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
