//! The composition root: configuration loading, provider construction,
//! service wiring, router assembly, and runtime supervision. `main.rs` parses
//! process arguments and hands off here. Startup order, ports, defaults, and
//! errors are those the former `async_main` established.

pub(crate) mod grpc_stack;
pub(crate) mod telemetry;
pub(crate) mod uploads;

use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderName, HeaderValue, Method};
use axum::routing::put;
use tokio::sync::{Mutex, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use zeroize::Zeroizing;

use crate::proto::account::user_information_service_server::UserInformationServiceServer;
use crate::proto::account::wifi_config_service_server::WifiConfigServiceServer;
use crate::proto::aibus::speech_service_server::SpeechServiceServer;
use crate::proto::capture::capture_service_server::CaptureServiceServer;
use crate::proto::contacts::contacts_rpc_service_server::ContactsRpcServiceServer;
use crate::proto::events::device_events_history_service_server::DeviceEventsHistoryServiceServer;
use crate::proto::events::events_ingest_service_server::EventsIngestServiceServer;
use crate::proto::featureflags::feature_flags_service_server::FeatureFlagsServiceServer;
use crate::proto::partnerservices::partner_token_rpc_service_server::PartnerTokenRpcServiceServer;
use crate::proto::privacy::pub_::public_privacy_service_server::PublicPrivacyServiceServer;
use crate::proto::provisioning::device_onboarding_dac_service_server::DeviceOnboardingDacServiceServer;
use crate::proto::pushrelay::push_relay_service_server::PushRelayServiceServer;

use crate::services::auth::GrpcAuthInterceptor;
use crate::services::capture::CaptureServiceImpl;
use crate::services::contacts::ContactsRpcServiceImpl;
use crate::services::events::{DeviceEventsHistoryServiceImpl, EventsIngestServiceImpl};
use crate::services::featureflags::{FeatureFlagDeliveryTracker, FeatureFlagsServiceImpl};
use crate::services::partnerservices::PartnerServicesImpl;
use crate::services::privacy::PublicPrivacyServiceImpl;
use crate::services::provisioning::{OnboardingCa, ProvisioningServiceImpl};
use crate::services::pushrelay::PushRelayServiceImpl;
use crate::services::speech::SpeechServiceImpl;
use crate::services::user_info::UserInformationServiceImpl;
use crate::services::wifi_config::WifiConfigServiceImpl;

use crate::api;
use crate::api::device::DeviceVersionCollector;
use crate::api::FoodRuntimeGate;
use crate::config::{Config, ResolvedConfig};
use crate::db::Database;
use crate::esim;
use crate::external::azure_speech::AzureSpeechClient;
use crate::fitness;
#[cfg(feature = "iroh")]
use crate::remote_center;
use crate::spotify;
use crate::storage::MediaStore;

use grpc_stack::{fallback_handler, log_grpc_unimplemented};
use uploads::{upload_handler, UploadState};

pub(crate) async fn run(
    config_path: PathBuf,
    database_key: Option<Zeroizing<String>>,
) -> Result<(), Box<dyn std::error::Error>> {
    telemetry::load_dotenv(&config_path);

    let config = Config::load(&config_path)?;

    telemetry::init_tracing(&config)?;

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
                    tracing::warn!(error = %error, "stock weather-unit sync retrying");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                Err(error) => tracing::warn!(error = %error, "stock weather-unit sync unavailable"),
            }
        }
        if synchronized {
            info!("stock weather-unit preference synchronized");
        }
    }

    // One shared pooled client for every outbound provider. HTTP/2 (ALPN)
    // keep-alive PINGs hold provider connections open between requests;
    // endpoints that only speak HTTP/1.1 keep working via ALPN fallback.
    let http_client = reqwest::Client::builder()
        .tls_backend_native()
        .redirect(reqwest::redirect::Policy::none())
        .http2_keep_alive_interval(Duration::from_secs(30))
        .http2_keep_alive_while_idle(true)
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(300))
        .tcp_keepalive(Duration::from_secs(60))
        .build()?;

    let resolved_config = Arc::new(ResolvedConfig::resolve(config.clone()));
    let azure_speech = AzureSpeechClient::from_options(
        resolved_config.azure_speech_options.clone(),
    )
    .map_err(|error| {
        format!(
            "failed to initialize Azure Speech provider: {}",
            error.kind()
        )
    })?;

    // Generate ephemeral CA for signing DUC certificates during onboarding
    let onboarding_ca = Arc::new(OnboardingCa::generate()?);
    let user_id = uuid::Uuid::new_v4().to_string();
    let display_name = config
        .server
        .display_name
        .clone()
        .unwrap_or_else(|| "Luma".into());

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

    // Broadcast channel for real-time events to web portal clients
    let (events_tx, _) = tokio::sync::broadcast::channel::<api::Event>(256);

    let http_bind_addr = config.server.effective_http_bind_addr()?;
    let active_lan_dashboard_enabled = config.server.lan_dashboard_enabled;
    let grpc_bind_addr: std::net::SocketAddr = config.server.grpc_bind_addr.parse()?;
    let public_addr = config.server.public_addr.clone();

    info!("============================================================");
    info!(
        lan_dashboard_enabled = config.server.lan_dashboard_enabled,
        "HTTP server listener configured"
    );
    info!("gRPC server listener configured");
    info!("Device-local upload URL configured");
    info!("Onboarding identity initialized");
    info!("Storage initialized");
    info!("============================================================");

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
        config.music.clone(),
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
    let speech_service = SpeechServiceImpl::new_with_config(azure_speech, resolved_config.clone());

    // Build the gRPC service stack as a native axum::Router. Assistant turns
    // are Cosmos's: the stock ChannelFactory gateways all route there, so the
    // Pin serves no local AIBusService.
    let grpc_routes = tonic::service::Routes::new(SpeechServiceServer::new(speech_service))
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
    let grpc_router = grpc_routes
        .into_axum_router()
        .fallback(fallback_handler)
        .layer(axum::middleware::from_fn(log_grpc_unimplemented))
        .layer(tonic::service::InterceptorLayer::new(grpc_auth_interceptor));

    // Build the axum HTTP router for upload endpoint
    let upload_state = UploadState {
        store: media_store.clone(),
    };

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
    // `iroh` feature. See the gate note in Cargo.toml).
    #[cfg(feature = "iroh")]
    let iroh_connector = if config.server.iroh_remote_center_enabled {
        use remote_center::iroh_connector::{IrohConfig, IrohConnectorState};
        use remote_center::policy::operator_bridge_capabilities;

        let iroh_config = IrohConfig {
            enabled: true,
            request_timeout_ms: 30_000,
        };

        // Dispatch remote requests through the same authenticated API router the
        // LAN dashboard uses. The policy layer classifies each one first.
        let connector_router = api::router(api_state.clone());

        // The real embedded Setup asset paths (hashed bundle names + binaries),
        // so every asset the dashboard references is dispatchable.
        let center_entries = api::setup::asset_paths();

        // Issue only the reviewed Center/Spotify capability bundle.
        let capabilities = operator_bridge_capabilities();

        // Persist the Pin's iroh identity next to the app database so its
        // EndpointId, and therefore the ticket the VPS bridge dials, survives
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
            tracing::warn!("startup feature-flag evidence refresh was not observed");
        }
    });
    #[cfg(target_os = "android")]
    tokio::spawn(api::maintain_food_runtime_gate(startup_food_runtime_gate));

    tokio::try_join!(http_server, grpc_server)?;

    Ok(())
}
