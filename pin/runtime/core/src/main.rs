//! Standalone server for Humane AI Pin.
//!
//! Serves gRPC services and an HTTP upload endpoint on the same port.
//! gRPC requests (content-type: application/grpc) are routed to tonic;
//! HTTP PUT /upload/:uuid/:filename is handled by axum for media uploads.

mod api;
mod config;
mod db;
mod dedup;
// The live eSIM socket transport is Android-only. Host builds retain the
// public bridge facade for tests and local development, so transport-only
// helpers are intentionally unreachable there.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
mod esim;
mod external;
mod feature_flags;
mod fitness;
mod llm;
mod nearby;
// Staged S1/S2 decision layers (stock-NLU assists). The tflitec encoder
// runtime and the chat-turn injection seams are the consumers and land behind
// the `local-nlu` feature next; until then the pure decision layers carry
// their golden tests but no production caller. Remove this allow with S1.
#[allow(dead_code)]
mod nlu;
#[cfg(feature = "iroh")]
mod remote_center;
mod services;
mod spotify;
mod storage;
mod synapse;
mod tier_a;
// The turn-trace capture seam (the chat-turn loop and the AIBus tool executor)
// lands separately. Until it does, the recorder and the write half of its
// persistence sink carry their own tests but no production caller; the read
// half, the retention, and the configuration are live. Remove these allows
// with the capture seam.
#[allow(dead_code)]
mod turn_trace;
#[allow(dead_code)]
mod turn_trace_log;
mod util;

/// Generated protobuf/gRPC modules.
#[allow(unused)]
mod proto {
    #[allow(clippy::enum_variant_names)]
    pub mod aibus {
        tonic::include_proto!("humane.aibus");
    }
    pub mod pushrelay {
        tonic::include_proto!("humane.pushrelay");
    }
    #[allow(clippy::enum_variant_names)]
    pub mod featureflags {
        tonic::include_proto!("humane.featureflags");
    }
    pub mod account {
        tonic::include_proto!("humane.account");
    }
    #[allow(clippy::large_enum_variant)]
    pub mod contacts {
        tonic::include_proto!("humane.contacts");
    }
    pub mod events {
        tonic::include_proto!("humane.events");
    }
    #[allow(clippy::enum_variant_names)]
    pub mod provisioning {
        tonic::include_proto!("humane.provisioning");
    }
    #[allow(clippy::enum_variant_names)]
    pub mod capture {
        tonic::include_proto!("humane.capture");
    }
    pub mod partnerservices {
        tonic::include_proto!("humane.partnerservices");
    }
    pub mod common {
        pub mod encryption {
            tonic::include_proto!("humane.common.encryption");
        }
        pub mod food {
            tonic::include_proto!("humane.common.food");
        }
    }
    pub mod privacy {
        #[allow(clippy::enum_variant_names)]
        pub mod common {
            tonic::include_proto!("humane.privacy.grpc.common");
        }
        pub mod pub_ {
            tonic::include_proto!("humane.privacy.grpc.r#pub");
        }
    }
}

use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use futures::StreamExt as _;
use tokio::sync::{Mutex, RwLock};
use tower_http::cors::CorsLayer;

use proto::account::user_information_service_server::UserInformationServiceServer;
use proto::account::wifi_config_service_server::WifiConfigServiceServer;
use proto::aibus::ai_bus_service_server::AiBusServiceServer;
use proto::aibus::composition_service_server::CompositionServiceServer;
use proto::aibus::speech_service_server::SpeechServiceServer;
use proto::capture::capture_service_server::CaptureServiceServer;
use proto::contacts::contacts_rpc_service_server::ContactsRpcServiceServer;
use proto::events::device_events_history_service_server::DeviceEventsHistoryServiceServer;
use proto::events::events_ingest_service_server::EventsIngestServiceServer;
use proto::featureflags::feature_flags_service_server::FeatureFlagsServiceServer;
use proto::partnerservices::partner_token_rpc_service_server::PartnerTokenRpcServiceServer;
use proto::privacy::pub_::public_privacy_service_server::PublicPrivacyServiceServer;
use proto::provisioning::device_onboarding_dac_service_server::DeviceOnboardingDacServiceServer;
use proto::pushrelay::push_relay_service_server::PushRelayServiceServer;

use services::auth::GrpcAuthInterceptor;
use services::capture::CaptureServiceImpl;
use services::contacts::ContactsRpcServiceImpl;
use services::events::{DeviceEventsHistoryServiceImpl, EventsIngestServiceImpl};
use services::featureflags::{FeatureFlagDeliveryTracker, FeatureFlagsServiceImpl};
use services::partnerservices::PartnerServicesImpl;
use services::privacy::PublicPrivacyServiceImpl;
use services::provisioning::{OnboardingCa, ProvisioningServiceImpl};
use services::pushrelay::PushRelayServiceImpl;
use services::speech::SpeechServiceImpl;
use services::user_info::UserInformationServiceImpl;
use services::wifi_config::WifiConfigServiceImpl;

use config::{Config, ResolvedConfig};
use db::Database;
use dedup::DedupRouter;
use llm::memory::MemoryService;
use llm::{LlmAgent, LlmRequestLogger};
use storage::{
    AibusUploadStore, MediaStore, MediaStoreError, MAX_AIBUS_CONTENT_TYPE_BYTES,
    MAX_AIBUS_LOGICAL_NAME_BYTES, MAX_HTTP_UPLOAD_BYTES,
};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use std::time::Duration;
use zeroize::Zeroizing;

use crate::api::device::DeviceVersionCollector;
use crate::services::aibus::{
    AiBus, AiBusExternalClients, CompositionServiceImpl, FoodRuntimeGate, UploadFileHandler,
    UploadTicketError,
};
use external::azure_speech::AzureSpeechClient;
use external::google_maps::GoogleMapsClient;
use external::open_food_facts::OpenFoodFactsClient;

#[cfg(not(target_os = "android"))]
fn load_dotenv(config_path: &FsPath) {
    let Some(config_dir) = config_path.parent() else {
        return;
    };

    let dotenv_path = config_dir.join(".env");
    if !dotenv_path.exists() {
        return;
    }

    match dotenvy::from_path(&dotenv_path) {
        Ok(()) => info!(path = %dotenv_path.display(), "loaded .env file"),
        Err(error) => warn!(path = %dotenv_path.display(), %error, "failed to load .env file"),
    }
}

#[cfg(target_os = "android")]
fn load_dotenv(_config_path: &FsPath) {}

// ─── HTTP upload handler ────────────────────────────────────────────

/// Shared state passed to the axum upload handler.
#[derive(Clone)]
struct UploadState {
    store: Arc<Mutex<MediaStore>>,
    aibus_upload: UploadFileHandler,
}

type UploadValidationError = (StatusCode, &'static str);

fn validate_upload_content_length(headers: &HeaderMap) -> Result<(), UploadValidationError> {
    let Some(content_length) = headers.get(header::CONTENT_LENGTH) else {
        return Ok(());
    };
    let Ok(content_length) = content_length.to_str() else {
        return Err((StatusCode::BAD_REQUEST, "invalid content length"));
    };
    let Ok(content_length) = content_length.parse::<u64>() else {
        return Err((StatusCode::BAD_REQUEST, "invalid content length"));
    };
    if content_length > MAX_HTTP_UPLOAD_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "upload is too large"));
    }
    Ok(())
}

/// PUT /upload/:uuid/:filename — receives media file bytes from the device.
async fn upload_handler(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((uuid, filename)): Path<(String, String)>,
    State(state): State<UploadState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // Stock capture clients receive a loopback URL. Never expose this
    // unauthenticated ingestion surface to dashboard peers on the LAN.
    if !is_device_local_upload_peer(&peer) {
        warn!("rejected non-loopback media upload");
        return (StatusCode::FORBIDDEN, "upload is device-local").into_response();
    }

    if let Err(error) = validate_upload_content_length(&headers) {
        return error.into_response();
    }

    let mut upload = {
        let store = state.store.lock().await;
        match store.begin_upload(&uuid, &filename).await {
            Ok(upload) => upload,
            Err(error) => return media_upload_error_response(error),
        }
    };

    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                upload.abort().await;
                warn!("media upload body failed");
                return (StatusCode::BAD_REQUEST, "invalid upload body").into_response();
            }
        };
        if let Err(error) = upload.write_chunk(&chunk).await {
            upload.abort().await;
            return media_upload_error_response(error);
        }
    }

    match upload.commit().await {
        Ok(bytes) => {
            info!(bytes, "media upload committed");
            (StatusCode::CREATED, "OK").into_response()
        }
        Err(error) => media_upload_error_response(error),
    }
}

/// PUT /aibus-upload/:ticket — the raw second stage of stock UploadFile.
async fn aibus_upload_handler(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(ticket): Path<String>,
    State(state): State<UploadState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !is_device_local_upload_peer(&peer) {
        warn!("rejected non-loopback AIBus upload");
        return (StatusCode::FORBIDDEN, "upload is device-local").into_response();
    }
    if let Err(error) = validate_upload_content_length(&headers) {
        return error.into_response();
    }

    let logical_name = match bounded_upload_header(
        &headers,
        HeaderName::from_static("file"),
        MAX_AIBUS_LOGICAL_NAME_BYTES,
        true,
    ) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let content_type = match bounded_upload_header(
        &headers,
        header::CONTENT_TYPE,
        MAX_AIBUS_CONTENT_TYPE_BYTES,
        false,
    ) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };

    let mut upload = match state
        .aibus_upload
        .begin_upload(&ticket, logical_name, content_type)
        .await
    {
        Ok(upload) => upload,
        Err(error) => return aibus_upload_error_response(error),
    };

    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                upload.abort().await;
                warn!("AIBus upload body failed");
                return (StatusCode::BAD_REQUEST, "invalid upload body").into_response();
            }
        };
        if let Err(error) = upload.write_chunk(&chunk).await {
            upload.abort().await;
            return media_upload_error_response(error);
        }
    }

    match upload.commit().await {
        Ok(bytes) => {
            info!(bytes, "AIBus upload committed");
            aibus_upload_success_response()
        }
        Err(error) => media_upload_error_response(error),
    }
}

fn bounded_upload_header(
    headers: &HeaderMap,
    name: HeaderName,
    maximum_bytes: usize,
    required: bool,
) -> Result<String, UploadValidationError> {
    let Some(value) = headers.get(&name) else {
        return if required {
            Err((StatusCode::BAD_REQUEST, "missing upload metadata"))
        } else {
            Ok("application/octet-stream".to_string())
        };
    };
    let value = std::str::from_utf8(value.as_bytes())
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid upload metadata"))?;
    if value.trim().is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control)
    {
        return Err((StatusCode::BAD_REQUEST, "invalid upload metadata"));
    }
    Ok(value.to_string())
}

fn aibus_upload_error_response(error: UploadTicketError) -> Response {
    match error {
        UploadTicketError::InvalidTicket | UploadTicketError::InvalidMetadata => {
            (StatusCode::BAD_REQUEST, "invalid upload ticket or metadata").into_response()
        }
        UploadTicketError::NotFound => {
            (StatusCode::NOT_FOUND, "upload ticket not found").into_response()
        }
        UploadTicketError::AlreadyClaimed => {
            (StatusCode::CONFLICT, "upload ticket is already in use").into_response()
        }
        UploadTicketError::Expired => (StatusCode::GONE, "upload ticket expired").into_response(),
        UploadTicketError::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "upload storage unavailable",
        )
            .into_response(),
        UploadTicketError::Storage(error) => media_upload_error_response(error),
    }
}

fn aibus_upload_success_response() -> Response {
    let mut response = (StatusCode::CREATED, "OK").into_response();
    // Stock WebClient compares MediaType.toString() to this exact value. Axum's
    // default string response adds a charset, which would prevent source cleanup.
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    response
}

fn is_device_local_upload_peer(peer: &SocketAddr) -> bool {
    peer.ip().is_loopback()
}

fn media_upload_error_response(error: MediaStoreError) -> Response {
    let (status, message) = match error {
        MediaStoreError::InvalidMemoryId | MediaStoreError::InvalidFilename => {
            (StatusCode::BAD_REQUEST, "invalid upload path")
        }
        MediaStoreError::MemoryNotFound | MediaStoreError::UnexpectedFilename => {
            (StatusCode::NOT_FOUND, "upload target not found")
        }
        MediaStoreError::UploadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "upload is too large"),
        MediaStoreError::Io(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            (StatusCode::CONFLICT, "upload conflicts with existing media")
        }
        MediaStoreError::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock => (
            StatusCode::TOO_MANY_REQUESTS,
            "upload capacity is exhausted",
        ),
        MediaStoreError::Io(_) | MediaStoreError::Database => {
            tracing::error!("media upload storage failure");
            (StatusCode::INTERNAL_SERVER_ERROR, "upload storage failed")
        }
    };
    (status, message).into_response()
}

/// Catches any request that doesn't match a registered HTTP or gRPC route.
/// Logs a warning and returns HTTP 404.
async fn fallback_handler(request: axum::extract::Request) -> impl IntoResponse {
    warn!(
        method = %request.method(),
        content_type = request.headers().get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("none"),
        "unhandled request. No matching route"
    );
    (StatusCode::NOT_FOUND, "not found")
}

/// Middleware that inspects gRPC responses for UNIMPLEMENTED status (code 12)
/// and logs a warning when one is detected.
async fn log_grpc_unimplemented(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let response = next.run(request).await;

    // gRPC status code 12 = UNIMPLEMENTED.
    // Tonic sets this in the `grpc-status` header for routing-level rejections.
    if let Some(status) = response.headers().get("grpc-status") {
        if status.as_bytes() == b"12" {
            warn!(path = %path, "gRPC UNIMPLEMENTED. method not registered");
        }
    }

    response
}

// ─── main ───────────────────────────────────────────────────────────

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    // Locate config file: check --config <path>, then ./config.toml, then next to binary
    let config_path = args
        .iter()
        .position(|a| a == "--config")
        .and_then(|i| args.get(i + 1).cloned())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("config.toml"));

    let database_key = if args.iter().any(|arg| arg == "--database-key-stdin") {
        let mut input = Vec::new();
        std::io::stdin().take(66).read_to_end(&mut input)?;
        if input.last() == Some(&b'\n') {
            input.pop();
        }
        let key = String::from_utf8(input)?;
        if key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid database key received on stdin".into());
        }
        Some(Zeroizing::new(key))
    } else {
        None
    };

    #[cfg(target_os = "android")]
    if database_key.is_none() {
        return Err("Android requires a database key on stdin".into());
    }

    #[cfg(target_os = "android")]
    {
        let config_dir = config_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| FsPath::new("."));
        let tmp_dir = config_dir.join("tmp");
        std::fs::create_dir_all(&tmp_dir)?;

        // We need to set the envvar before Tokio starts
        unsafe {
            std::env::set_var("TMPDIR", &tmp_dir);
        }
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async_main(config_path, database_key))
}

async fn async_main(
    config_path: PathBuf,
    database_key: Option<Zeroizing<String>>,
) -> Result<(), Box<dyn std::error::Error>> {
    load_dotenv(&config_path);

    let config = Config::load(&config_path)?;

    // `librespot_playback::player` is raised to debug on purpose. It is the only
    // place the applied loudness-normalisation gain is reported ("Calculated
    // Normalisation Factor"), and that gain is otherwise invisible: with
    // normalisation on and no pregain, every track above Spotify's reference
    // level is quietly attenuated by an amount nobody can see. The module has
    // ~18 debug sites and they fire per track load, so the added volume is
    // negligible next to the value of knowing the gain. The lines are
    // content-free (a percentage and the normalisation type). RUST_LOG still
    // overrides everything.
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,librespot_playback::player=debug".into());

    // Optional rolling file appender, used both for persistence and for the
    // `/api/logs/server` REST endpoint. The guard must outlive the program;
    // we leak it intentionally.
    let file_layer = if let Some(dir) = config.logging.log_dir.as_deref() {
        match std::fs::create_dir_all(dir) {
            Ok(()) => {
                let appender = tracing_appender::rolling::Builder::new()
                    .rotation(tracing_appender::rolling::Rotation::DAILY)
                    .filename_prefix(&config.logging.file_prefix)
                    .max_log_files(config.logging.max_files)
                    .build(dir)
                    .map_err(|e| format!("failed to build rolling log appender: {e}"))?;
                let (nb, guard) = tracing_appender::non_blocking(appender);
                Box::leak(Box::new(guard));
                Some(
                    tracing_subscriber::fmt::layer()
                        .with_writer(nb)
                        .with_ansi(false)
                        .with_target(true),
                )
            }
            Err(e) => {
                eprintln!(
                    "warning: failed to create log_dir {:?}: {}. file logging disabled",
                    dir, e
                );
                None
            }
        }
    } else {
        None
    };

    {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;

        #[cfg(target_os = "android")]
        let stdout_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .compact()
            .without_time();
        #[cfg(not(target_os = "android"))]
        let stdout_layer = tracing_subscriber::fmt::layer();

        tracing_subscriber::registry()
            .with(env_filter)
            .with(stdout_layer)
            .with(file_layer)
            .init();
    }

    #[cfg(target_os = "android")]
    {
        let mut synchronized = false;
        for attempt in 0..3 {
            match api::sync_weather_temperature_unit_to_device(config.weather.temperature_unit)
                .await
            {
                Ok(()) => {
                    synchronized = true;
                    break;
                }
                Err(error) if attempt < 2 => {
                    warn!(error = %error, "stock weather-unit sync retrying");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                Err(error) => warn!(error = %error, "stock weather-unit sync unavailable"),
            }
        }
        if synchronized {
            info!("stock weather-unit preference synchronized");
        }
    }

    // Provider latency: one shared pooled client for every outbound provider.
    // HTTP/2 (ALPN) multiplexes the chat-turn loop's parallel tool batches over a
    // single connection, and keep-alive PINGs hold the long-haul provider
    // connection open between voice turns so a turn does not start with a
    // fresh TCP+TLS handshake (measured ~2x per-request latency without
    // reuse). Endpoints that only speak HTTP/1.1 keep working via ALPN
    // fallback and still benefit from the widened idle pool.
    let http_client = reqwest::Client::builder()
        .tls_backend_native()
        .redirect(reqwest::redirect::Policy::none())
        .http2_keep_alive_interval(Duration::from_secs(30))
        .http2_keep_alive_while_idle(true)
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(300))
        .tcp_keepalive(Duration::from_secs(60))
        .build()?;
    let llm_request_log_dir = config
        .logging
        .log_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("logs"));
    let llm_request_logger = LlmRequestLogger::new(llm_request_log_dir.clone());
    // Turn traces roll alongside the LLM request log, under the same directory
    // and the same seven-day retention. Constructed unconditionally and inert
    // until `llm.turn_trace` is armed: it writes nothing and creates no file.
    let turn_trace_logger = turn_trace_log::TurnTraceLogger::new(llm_request_log_dir);

    let resolved_config = Arc::new(ResolvedConfig::resolve(config.clone()));
    let has_weather_key = resolved_config.pirate_weather_api_key.is_some();
    let google_maps = GoogleMapsClient::from_options(resolved_config.google_maps_options.clone())
        .map_err(|error| {
        format!(
            "failed to initialize Google Maps provider: {}",
            error.kind()
        )
    })?;
    let open_food_facts =
        OpenFoodFactsClient::from_options(resolved_config.open_food_facts_options.clone())
            .map_err(|error| {
                format!(
                    "failed to initialize Open Food Facts provider: {}",
                    error.kind()
                )
            })?;
    let azure_speech = AzureSpeechClient::from_options(
        resolved_config.azure_speech_options.clone(),
    )
    .map_err(|error| {
        format!(
            "failed to initialize Azure Speech provider: {}",
            error.kind()
        )
    })?;

    // Long-term memory is an enhancement, not a boot requirement. If it cannot
    // initialize (e.g. the memvid store's advisory file lock is unsupported on
    // the configured filesystem — sdcardfs/FUSE external storage returns ENOSYS
    // for flock on some kernels), degrade gracefully to no memory rather than
    // crash-looping the whole assistant. The failure is logged; the dashboard's
    // memory init path (api.rs) already treats it as recoverable.
    let memory = if config.llm.memory.enabled {
        match MemoryService::open(config.llm.memory.clone()).await {
            Ok(service) => Some(service),
            Err(err) => {
                warn!(
                    error = %err,
                    "assistant memory unavailable; continuing without long-term memory"
                );
                None
            }
        }
    } else {
        None
    };
    let active_memory = Arc::new(RwLock::new(memory.clone()));

    let agent = Arc::new(
        LlmAgent::from_config(
            &resolved_config,
            http_client.clone(),
            llm_request_logger.clone(),
            memory.clone(),
        )
        .await
        .map_err(|err| -> Box<dyn std::error::Error> { err })?,
    );

    // Generate ephemeral CA for signing DUC certificates during onboarding
    let onboarding_ca = Arc::new(OnboardingCa::generate()?);
    let user_id = uuid::Uuid::new_v4().to_string();
    let display_name = config
        .server
        .display_name
        .clone()
        .unwrap_or_else(|| "Ai Pin Revival".into());

    // Open SQLite database
    let database = match database_key.as_deref() {
        Some(key) => Database::open_encrypted(&config.storage.db_path, key)?,
        None => Database::open(&config.storage.db_path)?,
    };
    drop(database_key);

    // Open media store (uses SQLite for metadata, filesystem for binary files)
    let media_store = Arc::new(Mutex::new(
        MediaStore::open(&config.storage.media_dir, database.clone()).await?,
    ));
    let aibus_upload_store = Arc::new(
        AibusUploadStore::open(FsPath::new(&config.storage.media_dir).join(".aibus-uploads"))
            .await?,
    );

    // Broadcast channel for real-time events to web portal clients
    let (events_tx, _) = tokio::sync::broadcast::channel::<api::Event>(256);

    let http_bind_addr = config.server.effective_http_bind_addr()?;
    let active_lan_dashboard_enabled = config.server.lan_dashboard_enabled;
    let grpc_bind_addr: std::net::SocketAddr = config.server.grpc_bind_addr.parse()?;
    let public_addr = config.server.public_addr.clone();
    let upload_file_handler = UploadFileHandler::new(http_bind_addr.port(), aibus_upload_store);

    let provider_label = config.llm.provider.as_str().to_uppercase();
    info!("============================================================");
    info!(
        lan_dashboard_enabled = config.server.lan_dashboard_enabled,
        "HTTP server listener configured"
    );
    info!("gRPC server listener configured");
    info!("Device-local upload URL configured");
    info!(
        "LLM provider: {} (model: {})",
        provider_label, config.llm.model
    );
    info!("Onboarding identity initialized");
    if has_weather_key {
        info!("Weather: PirateWeather API key configured");
    } else {
        info!("Weather: not configured");
    }
    if memory.is_some() {
        info!("Memory: configured");
    } else {
        info!("Memory: disabled");
    }
    info!("Storage initialized");
    info!("============================================================");

    type AiBusServer = AiBusServiceServer<AiBus>;

    // Shared config for hot-reload via the web portal
    let shared_config = Arc::new(RwLock::new(config.clone()));
    let feature_flag_delivery = FeatureFlagDeliveryTracker::default();
    let admin_auth_state = api::AdminAuthState::new(shared_config.clone());

    // Capture logging settings for the API state before `config` is moved.
    let log_dir_for_api: Option<PathBuf> = config.logging.log_dir.as_ref().map(PathBuf::from);
    let log_file_prefix_for_api: String = config.logging.file_prefix.clone();

    // Spotify is part of both the authenticated dashboard API and the stock
    // EncryptedSmartPlaylist AIBus route. Initialize one shared service before
    // constructing AIBus so both surfaces use the same paired session/cache.
    let esim_bridge = esim::EsimBridge::start();
    let spotify_service = spotify::SpotifyService::new(
        config.spotify.clone(),
        &config_path,
        http_bind_addr,
        http_client.clone(),
        esim_bridge.clone(),
        database.clone(),
    )
    .await;
    let spotify_internal_router = spotify::internal_router(spotify_service.clone());

    let food_runtime_gate = FoodRuntimeGate::default();
    let external_clients =
        AiBusExternalClients::new(google_maps, open_food_facts, Some(spotify_service.clone()))
            .with_food_runtime_gate(food_runtime_gate.clone());
    let aibus = AiBus::new_with_external_clients(
        agent.clone(),
        resolved_config.clone(),
        shared_config.clone(),
        nearby::NearbyClient::new(
            http_client.clone(),
            resolved_config.openstreetmap_options.clone(),
        ),
        http_client.clone(),
        database.clone(),
        memory.clone(),
        media_store.clone(),
        events_tx.clone(),
        external_clients,
    )
    .with_upload_file_handler(upload_file_handler.clone());
    let speech_service = SpeechServiceImpl::new_with_translation(
        azure_speech,
        agent.clone(),
        resolved_config.clone(),
    );
    let composition_service = CompositionServiceImpl::new(agent.clone(), resolved_config.clone());

    // Build the gRPC service stack as a native axum::Router.
    let dedup_router = DedupRouter::new(AiBusServiceServer::new(aibus.clone()))
        .dedup::<AiBusServer>("EncryptedWeather", Duration::from_secs(300))
        .dedup::<AiBusServer>("EncryptedReverseGeocode", Duration::from_secs(30))
        .dedup::<AiBusServer>("EncryptedUnderstand", Duration::from_millis(200))
        .dedup::<AiBusServer>("EncryptedAnalyzeImage", Duration::from_millis(200))
        .dedup::<AiBusServer>("EncryptedSmartPlaylist", Duration::from_millis(200))
        .dedup::<AiBusServer>("EncryptedCompletion", Duration::from_millis(200))
        .dedup::<AiBusServer>("EncryptedChatCompletion", Duration::from_millis(200))
        .dedup::<AiBusServer>("Understand", Duration::from_millis(200))
        .dedup::<AiBusServer>("AnalyzeImage", Duration::from_millis(200))
        .add_service(CompositionServiceServer::new(composition_service.clone()))
        .add_service(SpeechServiceServer::new(speech_service.clone()))
        .add_service(PushRelayServiceServer::new(PushRelayServiceImpl))
        .add_service(FeatureFlagsServiceServer::new(
            FeatureFlagsServiceImpl::new(shared_config.clone(), feature_flag_delivery.clone()),
        ))
        .add_service(WifiConfigServiceServer::new(WifiConfigServiceImpl))
        .add_service(UserInformationServiceServer::new(
            UserInformationServiceImpl,
        ))
        .add_service(ContactsRpcServiceServer::new(ContactsRpcServiceImpl {
            db: database.clone(),
        }))
        .add_service(EventsIngestServiceServer::new(EventsIngestServiceImpl {
            db: database.clone(),
        }))
        .add_service(DeviceEventsHistoryServiceServer::new(
            DeviceEventsHistoryServiceImpl {
                db: database.clone(),
            },
        ))
        .add_service(DeviceOnboardingDacServiceServer::new(
            ProvisioningServiceImpl {
                ca: onboarding_ca,
                display_name,
                user_id,
            },
        ))
        .add_service(CaptureServiceServer::new(CaptureServiceImpl {
            store: media_store.clone(),
            server_addr: public_addr.clone(),
            events_tx: events_tx.clone(),
        }))
        .add_service(PublicPrivacyServiceServer::new(PublicPrivacyServiceImpl))
        .add_service(PartnerTokenRpcServiceServer::new(PartnerServicesImpl));
    let dedup = dedup_router.handle();
    // Authenticate every privileged local gRPC call. Host development may omit
    // the token, but Android must never expose the stock service surface with a
    // no-op interceptor.
    let grpc_auth_token = match config.server.resolve_grpc_auth_token() {
        Some(token) => Some(token),
        None if cfg!(target_os = "android") => {
            return Err("Android requires a local gRPC authentication token".into());
        }
        None => None,
    };
    let grpc_auth_interceptor = GrpcAuthInterceptor::new(grpc_auth_token);
    let grpc_router = dedup_router
        .into_axum_router()
        .fallback(fallback_handler)
        .layer(axum::middleware::from_fn(log_grpc_unimplemented))
        .layer(tonic::service::InterceptorLayer::new(grpc_auth_interceptor));

    // Build the axum HTTP router for upload endpoint
    let upload_state = UploadState {
        store: media_store.clone(),
        aibus_upload: upload_file_handler,
    };

    // Resolve the Codex provider config if configured
    let (codex_provider_config, codex_api_key_value) =
        if let Some(codex_config) = config.llm.resolve_codex_provider_config() {
            // Resolve the API key: persisted app-private value first, then env.
            let api_key = codex_config.resolve_api_key();

            // Build the CodexProviderConfig if we have the required fields
            let provider_config = if let (Some(model), Some(base_url)) =
                (&codex_config.model, &codex_config.provider_base_url)
            {
                if api_key.is_some() {
                    Some(llm::CodexProviderConfig {
                        model: model.clone(),
                        base_url: base_url.clone(),
                        provider_name: codex_config.provider_name.clone(),
                        api_key_env: codex_config.api_key_env.clone(),
                        wire_api: codex_config.wire_api.clone(),
                        model_catalog_path: codex_config.model_catalog_path.clone(),
                    })
                } else {
                    None
                }
            } else {
                None
            };

            (provider_config, api_key)
        } else {
            (None, None)
        };

    // Content-free launch-mode marker: distinguishes the durable
    // OpenAI-compatible provider path (vault/env API key) from the ChatGPT
    // device-code login fallback when diagnosing post-data-clear behavior.
    let codex_custom_provider_active = codex_provider_config.is_some();
    let local_codex_runtime = llm::local_codex_bridge::LocalCodexRuntime::from_environment(
        config.llm.resolve_codex_bridge_token(),
        esim_bridge.clone(),
        codex_provider_config,
        codex_api_key_value,
    )
    .await?;
    if local_codex_runtime.is_some() {
        info!(
            custom_provider = codex_custom_provider_active,
            "on-device Codex runtime initialized"
        );
    }
    let device_versions = DeviceVersionCollector::collect().await;
    let fitness_history_path = if cfg!(target_os = "android") {
        PathBuf::from("/data/user/0/com.penumbraos.server/files/fitness-history")
    } else {
        config_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| FsPath::new("."))
            .join("fitness-history")
    };
    let fitness_store = fitness::FitnessStore::open(&fitness_history_path).map_err(|error| {
        format!(
            "failed to initialize fitness history at {}: {error}",
            fitness_history_path.display()
        )
    })?;

    // Build the REST API router for the web portal
    #[cfg(target_os = "android")]
    let startup_feature_flag_delivery = feature_flag_delivery.clone();
    #[cfg(target_os = "android")]
    let startup_food_runtime_gate = food_runtime_gate.clone();
    let api_state = api::ApiState {
        store: media_store,
        db: database,
        events_tx,
        config_path,
        shared_config,
        feature_flag_delivery,
        food_runtime_gate,
        config_update_lock: Arc::new(Mutex::new(())),
        active_memory,
        aibus,
        composition_service,
        speech_service,
        dedup,
        llm_request_logger,
        turn_trace_logger,
        http_client: http_client.clone(),
        log_dir: log_dir_for_api,
        log_file_prefix: log_file_prefix_for_api,
        esim_bridge,
        contact_client_reset_pending: Arc::new(AtomicBool::new(false)),
        device_versions,
        active_lan_dashboard_enabled,
        spotify: spotify_service,
        fitness: fitness_store,
        #[cfg(feature = "iroh")]
        iroh_connector: None,
    };

    // Initialize iroh connector if enabled in config (only compiled with the
    // `iroh` feature; see the gate note in Cargo.toml).
    #[cfg(feature = "iroh")]
    let iroh_connector = if config.server.iroh_remote_center_enabled {
        use remote_center::iroh_connector::{IrohConfig, IrohConnectorState};
        use remote_center::policy::{Capabilities, Capability};

        let iroh_config = IrohConfig {
            enabled: true,
            request_timeout_ms: 30_000,
        };

        // Dispatch remote requests through the same authenticated API router the
        // LAN dashboard uses; the policy layer classifies each one first.
        let connector_router = api::router(api_state.clone());

        // The real embedded Setup asset paths (hashed bundle names + binaries),
        // so every asset the dashboard references is dispatchable.
        let center_entries = api::setup::asset_paths();

        // Read-only remote access: Setup assets and `/api/health` need no
        // capability; grant device-metadata and feature-flag reads so the
        // dashboard's status views populate. No write capability is granted.
        let capabilities = Capabilities::none()
            .with(Capability::DeviceMetadataRead)
            .with(Capability::FeatureFlagsRead);

        // Persist the Pin's iroh identity next to the app database so its
        // EndpointId — and therefore the ticket the VPS bridge dials — survives
        // restarts instead of changing on every boot.
        let iroh_secret_key_path = std::path::Path::new(&config.storage.db_path)
            .parent()
            .map(|dir| dir.join("iroh_secret.key"));

        match IrohConnectorState::new(
            1,
            center_entries,
            capabilities,
            connector_router,
            iroh_config,
            iroh_secret_key_path,
            config.server.iroh_remote_center_full_access,
            config.server.iroh_remote_center_allowed_peers.clone(),
        )
        .await
        {
            Ok(connector) => {
                let connector_clone = connector.clone();
                tokio::spawn(async move {
                    if let Err(e) = connector_clone.serve().await {
                        tracing::error!(error = %e, "iroh connector failed");
                    }
                });
                info!(
                    node_id = %connector.node_id(),
                    "iroh remote Center enabled"
                );
                Some(connector)
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to initialize iroh connector");
                None
            }
        }
    } else {
        info!("iroh remote Center disabled");
        None
    };

    // Update api_state with iroh_connector (only when the iroh feature is on;
    // otherwise the field does not exist and api_state is used as constructed).
    #[cfg(feature = "iroh")]
    let api_state = api::ApiState {
        iroh_connector,
        ..api_state
    };

    // CORS layer for the web portal (public HTTPS → local HTTP via LNA).
    // The `Access-Control-Allow-Local-Network` header is required by the
    // Local Network Access spec for the browser to allow cross-origin
    // requests from a public site to a LAN server.
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            http::header::CONTENT_TYPE,
            http::header::AUTHORIZATION,
            http::header::RANGE,
        ])
        .expose_headers([
            http::header::CONTENT_TYPE,
            http::header::CONTENT_LENGTH,
            http::header::CONTENT_RANGE,
            http::header::ACCEPT_RANGES,
        ]);

    let api_router = api::router(api_state)
        .layer(axum::middleware::from_fn_with_state(
            admin_auth_state.clone(),
            api::require_admin_auth,
        ))
        .layer(cors)
        .layer(axum::middleware::from_fn_with_state(
            admin_auth_state,
            api::AdminAuthState::require_auth_for_api_options,
        ))
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async {
                let mut response = next.run(request).await;
                // Inject the LNA header on every response (including preflights).
                response.headers_mut().insert(
                    HeaderName::from_static("access-control-allow-local-network"),
                    HeaderValue::from_static("true"),
                );
                // Also advertise in preflight Allow-Headers so the browser accepts it.
                response.headers_mut().insert(
                    HeaderName::from_static("access-control-allow-private-network"),
                    HeaderValue::from_static("true"),
                );
                response
            },
        ));

    // Apply trace layer to the HTTP router.
    let trace_layer = TraceLayer::new_for_http()
        .make_span_with(|request: &http::Request<axum::body::Body>| {
            tracing::info_span!(
                "req",
                method = %request.method(),
            )
        })
        .on_request(
            |_request: &http::Request<axum::body::Body>, _span: &tracing::Span| {
                info!("request");
            },
        )
        .on_response(
            |response: &http::Response<_>, latency: std::time::Duration, _span: &tracing::Span| {
                info!(latency = ?latency, status = %response.status(), "response");
            },
        )
        .on_failure(
            |error: tower_http::classify::ServerErrorsFailureClass,
             latency: std::time::Duration,
             _span: &tracing::Span| {
                tracing::error!(latency = ?latency, error = %error, "failed");
            },
        );

    let http_app = axum::Router::new()
        .route("/upload/{uuid}/{filename}", put(upload_handler))
        .route("/aibus-upload/{ticket}", put(aibus_upload_handler))
        .with_state(upload_state)
        .merge(spotify_internal_router)
        .merge(api_router)
        .fallback(fallback_handler)
        .layer(trace_layer);

    let http_listener = tokio::net::TcpListener::bind(http_bind_addr).await?;
    let grpc_listener = tokio::net::TcpListener::bind(grpc_bind_addr).await?;

    let http_server = axum::serve(
        http_listener,
        http_app.into_make_service_with_connect_info::<SocketAddr>(),
    );
    let grpc_server = axum::serve(grpc_listener, grpc_router);

    // A native child restart resets the in-memory gRPC delivery tracker, and a
    // Java process restart also resets the Binder-side apply receipt. Once both
    // listeners are bound, ask stock Ironman to fetch and apply a fresh snapshot
    // so the dashboard automatically regains exact point-in-time evidence.
    #[cfg(target_os = "android")]
    tokio::spawn(async {
        if api::request_startup_feature_flag_sync(startup_feature_flag_delivery).await {
            info!("observed startup feature-flag evidence refresh");
        } else {
            warn!("startup feature-flag evidence refresh was not observed");
        }
    });
    #[cfg(target_os = "android")]
    tokio::spawn(api::maintain_food_runtime_gate(startup_food_runtime_gate));

    let local_codex_server = async move {
        match local_codex_runtime {
            Some(runtime) => runtime.serve().await.map_err(std::io::Error::other),
            None => std::future::pending::<Result<(), std::io::Error>>().await,
        }
    };

    tokio::try_join!(http_server, grpc_server, local_codex_server)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        aibus_upload_handler, aibus_upload_success_response, bounded_upload_header,
        is_device_local_upload_peer, media_upload_error_response, UploadState,
    };
    use crate::db::Database;
    use crate::dedup::DedupRouter;
    use crate::proto::account::wifi_config_service_client::WifiConfigServiceClient;
    use crate::proto::account::wifi_config_service_server::WifiConfigServiceServer;
    use crate::proto::account::ListSecureWifiConfigsRequest;
    use crate::proto::aibus::{upload_file_request::UploadUseCase, UploadFileRequest};
    use crate::services::aibus::UploadFileHandler;
    use crate::services::wifi_config::WifiConfigServiceImpl;
    use crate::storage::{
        AibusUploadMetadata, AibusUploadStore, MediaStore, MediaStoreError,
        MAX_AIBUS_LOGICAL_NAME_BYTES, MAX_HTTP_UPLOAD_BYTES,
    };
    use axum::body::Body;
    use axum::extract::{ConnectInfo, Path, State};
    use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
    use http_body_util::BodyExt as _;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tonic::Request;

    async fn require_http2(
        request: axum::extract::Request,
        next: axum::middleware::Next,
    ) -> axum::response::Response {
        assert_eq!(request.version(), axum::http::Version::HTTP_2);
        next.run(request).await
    }

    #[tokio::test]
    async fn axum_serve_accepts_tonic_http2_requests() {
        let manifest: toml::Value =
            toml::from_str(include_str!("../Cargo.toml")).expect("parse Cargo.toml");
        let axum_features = manifest["dependencies"]["axum"]["features"]
            .as_array()
            .expect("Axum dependency must declare features explicitly");
        assert!(
            axum_features
                .iter()
                .any(|feature| feature.as_str() == Some("http2")),
            "Axum must explicitly enable HTTP/2; relying on transitive feature unification is not a release contract"
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Axum gRPC test listener");
        let address = listener.local_addr().expect("Axum gRPC test address");
        let router = DedupRouter::new(WifiConfigServiceServer::new(WifiConfigServiceImpl))
            .into_axum_router()
            .layer(axum::middleware::from_fn(require_http2));
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve Tonic route through Axum");
        });

        let mut client = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            WifiConfigServiceClient::connect(format!("http://{address}")),
        )
        .await
        .expect("Tonic HTTP/2 handshake timed out")
        .expect("Axum must accept the Tonic HTTP/2 connection");
        let response = client
            .list_secure_wifi_configs(ListSecureWifiConfigsRequest {})
            .await
            .expect("Tonic request must traverse the Axum router")
            .into_inner();
        assert!(response.secure_wifi_configs.is_empty());

        server.abort();
        let _ = server.await;
    }

    /// Full-stack streaming regression: tonic-encoded server-streaming RPCs
    /// must forward frames through dedup + axum + h2 before the stream closes.
    /// This exercises the real tonic codec layer that the raw-body test bypasses.
    #[tokio::test]
    async fn tonic_streaming_responses_forward_through_dedup_and_h2() {
        use crate::proto::contacts::contacts_rpc_service_client::ContactsRpcServiceClient;
        use crate::proto::contacts::contacts_rpc_service_server::{
            ContactsRpcService, ContactsRpcServiceServer,
        };
        use crate::proto::contacts::*;
        use prost_types::Timestamp;
        use std::pin::Pin;
        use tokio::sync::mpsc;
        use tokio_stream::wrappers::ReceiverStream;
        use tonic::{Request, Response, Status};

        // Mock service that feeds channel responses through tonic's real stream wrapper
        struct MockContacts;
        #[tonic::async_trait]
        impl ContactsRpcService for MockContacts {
            type GetContactsStreamingStream = Pin<
                Box<
                    dyn futures::Stream<Item = Result<GetContactsStreamingResponse, Status>> + Send,
                >,
            >;
            type GetContactsPaginatedStreamingStream = Pin<
                Box<
                    dyn futures::Stream<Item = Result<GetContactsStreamingPageResponse, Status>>
                        + Send,
                >,
            >;

            async fn get_contacts(
                &self,
                _: Request<GetContactsRequest>,
            ) -> Result<Response<ContactList>, Status> {
                Ok(Response::new(ContactList::default()))
            }
            async fn get_contact_deltas(
                &self,
                _: Request<GetContactDeltasRequest>,
            ) -> Result<Response<GetContactDeltasResponse>, Status> {
                Ok(Response::new(GetContactDeltasResponse::default()))
            }
            async fn get_contacts_streaming(
                &self,
                _: Request<GetContactsStreamingRequest>,
            ) -> Result<Response<Self::GetContactsStreamingStream>, Status> {
                let (tx, rx) = mpsc::channel(16);
                tokio::spawn(async move {
                    let _ = tx
                        .send(Ok(GetContactsStreamingResponse {
                            modified_time: Some(Timestamp {
                                seconds: 1,
                                nanos: 0,
                            }),
                            response: Some(
                                get_contacts_streaming_response::Response::DeletedContactId(
                                    "first".into(),
                                ),
                            ),
                        }))
                        .await;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    let _ = tx
                        .send(Ok(GetContactsStreamingResponse {
                            modified_time: Some(Timestamp {
                                seconds: 2,
                                nanos: 0,
                            }),
                            response: Some(
                                get_contacts_streaming_response::Response::DeletedContactId(
                                    "second".into(),
                                ),
                            ),
                        }))
                        .await;
                });
                Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
            }
            async fn get_contacts_paginated_streaming(
                &self,
                _: Request<GetContactsStreamingPageRequest>,
            ) -> Result<Response<Self::GetContactsPaginatedStreamingStream>, Status> {
                Ok(Response::new(Box::pin(futures::stream::empty())))
            }
            async fn create_contacts(
                &self,
                _: Request<ContactList>,
            ) -> Result<Response<ContactList>, Status> {
                Ok(Response::new(ContactList::default()))
            }
            async fn update_contacts(
                &self,
                _: Request<ContactList>,
            ) -> Result<Response<()>, Status> {
                Ok(Response::new(()))
            }
            async fn delete_contacts(
                &self,
                _: Request<DeleteContactRequest>,
            ) -> Result<Response<()>, Status> {
                Ok(Response::new(()))
            }
        }

        let router = DedupRouter::new(ContactsRpcServiceServer::new(MockContacts))
            .dedup::<ContactsRpcServiceServer<MockContacts>>(
                "GetContactsStreaming",
                std::time::Duration::from_millis(200),
            )
            .into_axum_router();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("serve");
        });

        let mut client = ContactsRpcServiceClient::connect(format!("http://{address}"))
            .await
            .expect("connect");

        let stream = client
            .get_contacts_streaming(GetContactsStreamingRequest {
                sync_option: Some(get_contacts_streaming_request::SyncOption::FullSync(true)),
                server_should_decrypt: false,
            })
            .await
            .expect("request")
            .into_inner();

        use futures::StreamExt;
        let mut stream = Box::pin(stream);

        // First message must arrive before the handler task completes
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("first message must not wait for stream end")
            .expect("stream yields first message")
            .expect("message is ok");

        assert!(matches!(
            first.response,
            Some(get_contacts_streaming_response::Response::DeletedContactId(ref id)) if id == "first"
        ));

        let second = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("second message delivered")
            .expect("stream yields second")
            .expect("ok");
        assert!(matches!(
            second.response,
            Some(get_contacts_streaming_response::Response::DeletedContactId(ref id)) if id == "second"
        ));

        server.abort();
        let _ = server.await;
    }

    #[test]
    fn media_upload_peer_must_be_loopback() {
        let v4_loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1);
        let v6_loopback = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 1);
        let wildcard = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 1);

        assert!(is_device_local_upload_peer(&v4_loopback));
        assert!(is_device_local_upload_peer(&v6_loopback));
        assert!(!is_device_local_upload_peer(&wildcard));
    }

    #[test]
    fn media_upload_admission_errors_have_distinct_http_statuses() {
        let conflict = media_upload_error_response(MediaStoreError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target is active",
        )));
        assert_eq!(conflict.status(), StatusCode::CONFLICT);

        let capacity = media_upload_error_response(MediaStoreError::Io(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "capacity is exhausted",
        )));
        assert_eq!(capacity.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn aibus_upload_success_is_exact_stock_text_response() {
        let response = aibus_upload_success_response();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "OK"
        );
    }

    #[test]
    fn aibus_file_header_is_bounded_but_never_treated_as_a_path() {
        let name = HeaderName::from_static("file");
        let mut headers = HeaderMap::new();
        headers.insert(
            name.clone(),
            HeaderValue::from_static("../../outside/debug/session.json"),
        );
        assert_eq!(
            bounded_upload_header(&headers, name.clone(), MAX_AIBUS_LOGICAL_NAME_BYTES, true)
                .unwrap(),
            "../../outside/debug/session.json"
        );

        headers.insert(
            name.clone(),
            HeaderValue::from_str(&"x".repeat(MAX_AIBUS_LOGICAL_NAME_BYTES + 1)).unwrap(),
        );
        assert!(bounded_upload_header(&headers, name, MAX_AIBUS_LOGICAL_NAME_BYTES, true).is_err());
    }

    #[tokio::test]
    async fn aibus_raw_put_is_loopback_only_bounded_and_one_use() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("media.sqlite")).unwrap();
        let media_store = Arc::new(Mutex::new(
            MediaStore::open(directory.path().join("media"), database)
                .await
                .unwrap(),
        ));
        let aibus_root = directory.path().join("aibus");
        let aibus_store = Arc::new(AibusUploadStore::open(&aibus_root).await.unwrap());
        let handler = UploadFileHandler::new(8080, aibus_store);
        let issued = handler
            .upload_file(Request::new(UploadFileRequest {
                use_case: UploadUseCase::IntentDebugging as i32,
            }))
            .await
            .unwrap()
            .into_inner();
        let ticket = issued.url.rsplit('/').next().unwrap().to_string();
        let state = UploadState {
            store: media_store,
            aibus_upload: handler,
        };
        let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1);
        let remote = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 1);
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("file"),
            HeaderValue::from_static("../../outside/debug/session.json"),
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        let forbidden = aibus_upload_handler(
            ConnectInfo(remote),
            Path(ticket.clone()),
            State(state.clone()),
            headers.clone(),
            Body::from("training-data"),
        )
        .await;
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        let mut oversized_headers = headers.clone();
        oversized_headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&(MAX_HTTP_UPLOAD_BYTES + 1).to_string()).unwrap(),
        );
        let oversized = aibus_upload_handler(
            ConnectInfo(loopback),
            Path(ticket.clone()),
            State(state.clone()),
            oversized_headers,
            Body::empty(),
        )
        .await;
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let accepted = aibus_upload_handler(
            ConnectInfo(loopback),
            Path(ticket.clone()),
            State(state.clone()),
            headers.clone(),
            Body::from("training-data"),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::CREATED);
        assert_eq!(
            accepted.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        assert_eq!(
            std::fs::read(aibus_root.join(&ticket).join("data")).unwrap(),
            b"training-data"
        );
        let metadata: AibusUploadMetadata = serde_json::from_slice(
            &std::fs::read(aibus_root.join(&ticket).join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata.logical_name, "../../outside/debug/session.json");
        assert!(!directory.path().join("outside").exists());

        let replay = aibus_upload_handler(
            ConnectInfo(loopback),
            Path(ticket),
            State(state),
            headers,
            Body::from("replacement"),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::CONFLICT);
    }
}
