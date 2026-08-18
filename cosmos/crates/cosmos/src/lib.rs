// `tonic::Status` is a large error type by design (it is the required gRPC error);
// boxing it would break `?` across every handler. Unit-struct `::default()` is the
// idiomatic constructor for the stateless handlers. Both lints are noise here.
#![allow(clippy::result_large_err, clippy::default_constructed_unit_structs)]

mod assistant;
mod auth;
mod backends;
mod capture_api;
mod capture_ranking;
pub mod config;
pub mod enrollment;
pub mod flag_overrides;
mod http;
pub mod keydirectory;
pub mod keymaterial;
pub mod metrics;
pub mod provision;
mod response_metadata;
mod services;
pub mod store;
pub mod store_postgres;
pub mod web_auth;

use std::{future::Future, io, time::Duration};

use config::{Config, LogLevel};
use http::Readiness;
use tokio::{
    sync::watch,
    task::{JoinError, JoinHandle},
    time::Instant,
};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;
use tonic_health::ServingStatus;

pub async fn run(config: Config) -> Result<(), ServerError> {
    serve_until(config, shutdown_signal()).await
}

pub async fn serve_until<F>(config: Config, shutdown: F) -> Result<(), ServerError>
where
    F: Future<Output = ()> + Send + 'static,
{
    let grpc_listener = tokio::net::TcpListener::bind(config.grpc_bind).await?;
    let http_listener = tokio::net::TcpListener::bind(config.http_bind).await?;

    // The web (Keycloak/OIDC) authentication plane, when configured. Built once
    // and shared into every authenticator. Absent ⇒ device-only, exactly as
    // before. A misconfigured issuer fails startup rather than silently trusting
    // no tokens — an admin door that is quietly shut is worse than one that says
    // it is shut.
    let web_verifier = match crate::web_auth::OidcConfig::from_env() {
        Some(oidc) => Some(
            crate::web_auth::JwtVerifier::connect(oidc)
                .await
                .map_err(ServerError::WebAuth)?,
        ),
        None => None,
    };
    // Publish it for the HTTP surfaces too. The gRPC services get the verifier by
    // construction below; the capture REST API the web companion reads is built
    // without one, and a reader that cannot identify the caller can only serve a
    // fixed account (which is exactly the bug where a Pin's captures and the
    // dashboard's view landed in different partitions).
    if let Some(verifier) = &web_verifier {
        crate::web_auth::install_verifier(verifier.clone());
    }
    let attach_web = |auth: auth::RequestAuthenticator| match &web_verifier {
        Some(verifier) => auth.with_web(verifier.clone()),
        None => auth,
    };

    let mut grpc_builder = Server::builder()
        .timeout(config.limits.request_timeout)
        .concurrency_limit_per_connection(config.limits.grpc_max_concurrent_streams as usize)
        .max_concurrent_streams(config.limits.grpc_max_concurrent_streams)
        .http2_keepalive_interval(Some(config.limits.http2_keepalive_interval))
        .http2_keepalive_timeout(Some(config.limits.http2_keepalive_timeout))
        .http2_max_header_list_size(config.limits.http2_max_header_list_bytes)
        .http2_max_pending_accept_reset_streams(Some(config.limits.http2_max_pending_reset_streams))
        // Outermost on purpose: tower applies the first layer nearest the wire,
        // so this counts calls the auth layer below rejects too. A workload that
        // authenticates nobody and a workload nobody calls are the same silence
        // otherwise.
        .layer(metrics::RpcMetricsLayer::new())
        .layer(response_metadata::ServicePathLayer::new(
            &config.service_path,
        ))
        // Authenticate EVERY gRPC call at the workload's front door (health
        // excepted). The mesh edge is the primary trust boundary, but a workload
        // that authenticates only in some handlers serves the rest to anyone who
        // can address its port directly.
        .layer(auth::AuthLayer::new(attach_web(
            auth::RequestAuthenticator::new(config.auth.clone()),
        )));

    // The standard gRPC health service is always registered; application
    // services are added per workload below. The implemented feature-flags
    // handler parses the edge principal via `RequestAuthenticator`, but that
    // parser does not prove transport provenance. Production remains blocked
    // on an edge that authenticates the device and replaces this metadata;
    // there is no transport-level interceptor in this process.
    let (mut health_reporter, health_service) = tonic_health::server::health_reporter();
    let health_service = health_service
        .max_decoding_message_size(config.limits.max_decode_bytes)
        .max_encoding_message_size(config.limits.max_encode_bytes);
    let service_name = config.identity.workload().as_str().to_owned();
    health_reporter
        .set_service_status("", ServingStatus::NotServing)
        .await;
    health_reporter
        .set_service_status(service_name.clone(), ServingStatus::NotServing)
        .await;

    let readiness = Readiness::default();
    let demo_enabled = config.identity.workload() == cosmos_core::Workload::AiBus
        && std::env::var("COSMOS_DEMO_ENABLED").is_ok_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        });
    // Configure the AI-bus store once and hand the SAME handle to both planes:
    // device-facing gRPC writes and the authenticated Center REST reads/deletes.
    // Constructing the HTTP demo backend independently used MemoryStore even in
    // a PostgreSQL deployment, splitting one wearer's data into two stores.
    let ai_bus_store = if config.identity.workload() == cosmos_core::Workload::AiBus {
        Some(crate::store::configured().await)
    } else {
        None
    };
    // One directory for both halves of the AI-bus data-protection path:
    // PublicPrivacy imports the owned Pin's C1 key and the authenticated Center
    // REST projection reads that same handle. PostgreSQL makes it cross-workload;
    // sharing the handle here also keeps the single-process/test shape correct.
    let ai_bus_keys = if config.identity.workload() == cosmos_core::Workload::AiBus {
        Some(crate::keydirectory::KeyDirectory::configured().await)
    } else {
        None
    };
    let http_app = if demo_enabled {
        http::demo_router(
            readiness.clone(),
            ai_bus_store
                .clone()
                .expect("AI-bus workload configures its shared store"),
            ai_bus_keys
                .clone()
                .expect("AI-bus workload configures its shared key directory"),
        )
    } else if config.identity.workload() == cosmos_core::Workload::Provisioning {
        // The pair route must run in the process that runs the OPAQUE ceremony
        // (this workload): the pairing it records is read back from that same
        // in-memory enrollment store during `CreateLoginInit`. The operator
        // console on ai-bus cannot record a pairing the ceremony would ever see,
        // so — without a shared database — it belongs here and nowhere else.
        http::router(readiness.clone()).merge(http::pairing_router())
    } else {
        http::router(readiness.clone())
    }
    // `/metrics` rides the probe listener the mesh already scrapes. It carries
    // counts and durations only — no wearer content, no principal, no token.
    .merge(metrics::router())
    // `/manage/metrics` is the same numbers in Micrometer JSON — the Actuator
    // shape Humane's Spring backend served. It rides this internal listener too,
    // never the gRPC edge, which is precisely the placement their exposure
    // report found missing.
    .merge(metrics::management_router());
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let http_shutdown = wait_for_shutdown(shutdown_rx.clone());
    let grpc_shutdown = wait_for_shutdown(shutdown_rx);

    let mut http_task = tokio::spawn(async move {
        axum::serve(http_listener, http_app)
            .with_graceful_shutdown(http_shutdown)
            .await
    });
    let mut grpc_router = grpc_builder.add_service(health_service);
    if config.identity.workload() == cosmos_core::Workload::FeatureFlags {
        let authenticator = attach_web(auth::RequestAuthenticator::new(config.auth.clone()));
        grpc_router =
            grpc_router.add_service(services::feature_flags(authenticator, &config.limits));
    }
    if config.identity.workload() == cosmos_core::Workload::Provisioning {
        grpc_router = grpc_router.add_service(services::provisioning(
            &config.limits,
            crate::store::configured().await,
        ));
    }
    let (d, e) = (
        config.limits.max_decode_bytes,
        config.limits.max_encode_bytes,
    );
    if config.identity.workload() == cosmos_core::Workload::Account {
        use cosmos_protocol::account::{
            food_preferences_service_server::FoodPreferencesServiceServer,
            user_information_service_server::UserInformationServiceServer,
            wifi_config_service_server::WifiConfigServiceServer,
        };
        // Stateful: the wearer's food restrictions include their allergies, and
        // an ack that echoes the payload is indistinguishable from a write. All
        // three services share one principal-keyed store and the auth seam that
        // supplies the storage key.
        let authenticator = attach_web(auth::RequestAuthenticator::new(config.auth.clone()));
        let store = crate::store::configured().await;
        grpc_router = grpc_router
            .add_service(
                FoodPreferencesServiceServer::new(services::account::FoodPreferences::new(
                    authenticator.clone(),
                    store.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                UserInformationServiceServer::new(services::account::UserInformation::new(
                    authenticator.clone(),
                    store.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                WifiConfigServiceServer::new(services::account::WifiConfigs::new(
                    authenticator,
                    store,
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            );
    }
    if config.identity.workload() == cosmos_core::Workload::Contacts {
        use cosmos_protocol::contacts::contacts_rpc_service_server::ContactsRpcServiceServer;
        // Contacts is the first stateful surface: a device's writes have to read
        // back, so the handler gets this workload's principal-keyed store and
        // the auth seam that supplies the storage key.
        let authenticator = attach_web(auth::RequestAuthenticator::new(config.auth.clone()));
        let store = crate::store::configured().await;
        grpc_router = grpc_router.add_service(
            ContactsRpcServiceServer::new(
                services::contacts::Contacts::new(authenticator, store)
                    // Keys the device escrowed via `ImportKeys` land in the
                    // AI-bus workload; this is how contacts — a different
                    // process — can honour `server_should_decrypt`.
                    .with_key_directory(crate::keydirectory::KeyDirectory::configured().await),
            )
            .max_decoding_message_size(d)
            .max_encoding_message_size(e),
        );
    }
    if config.identity.workload() == cosmos_core::Workload::NotableEvents {
        // Notable events are per-wearer and must survive a factory reset —
        // restoring that history is the whole point of this service.
        let events_store = crate::store::configured().await;
        use cosmos_protocol::events::{
            device_events_history_service_server::DeviceEventsHistoryServiceServer,
            events_ingest_service_server::EventsIngestServiceServer,
        };
        grpc_router = grpc_router
            .add_service(
                DeviceEventsHistoryServiceServer::new(services::events::DeviceEventsHistory::new(
                    attach_web(auth::RequestAuthenticator::new(config.auth.clone())),
                    events_store.clone(),
                    crate::keydirectory::KeyDirectory::configured().await,
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                EventsIngestServiceServer::new(services::events::EventsIngest::new(
                    attach_web(auth::RequestAuthenticator::new(config.auth.clone())),
                    events_store.clone(),
                    // A real Pin seals event_data and clears the plaintext, so
                    // without the channel keys every ingested event is a blob
                    // nothing can search. This resolves THIS workload's own key
                    // material; a channel key imported on another workload is
                    // reachable only through the shared KeyDirectory. Resolve
                    // that directory here so this workload can open the exact
                    // C1 key imported by PublicPrivacy in the AI-bus workload.
                    crate::keydirectory::KeyDirectory::configured().await,
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            );
    }
    if config.identity.workload() == cosmos_core::Workload::AiBus {
        // The privacy service (key exchange) and the AI-bus `Encrypted*` handlers
        // are two halves of one ephemeral-channel lifecycle and run in the SAME
        // workload, so they share one in-memory key store: the device establishes
        // a channel key via PublicPrivacyService, then uses it everywhere else.
        let key_material: crate::keymaterial::SharedKeyMaterial = Default::default();
        // Captures and notable events are per-wearer; one store serves the
        // workload's stateful surfaces.
        let capture_store = ai_bus_store.expect("AI-bus workload configures its shared store");
        use cosmos_protocol::capture::{
            capture_service_server::CaptureServiceServer,
            testing_automation_service_server::TestingAutomationServiceServer,
        };
        use cosmos_protocol::partnerservices::partner_token_rpc_service_server::PartnerTokenRpcServiceServer;
        use cosmos_protocol::pushrelay::push_relay_service_server::PushRelayServiceServer;
        grpc_router = grpc_router
            .add_service(
                CaptureServiceServer::new(
                    services::capture::Capture::new(
                        attach_web(auth::RequestAuthenticator::new(config.auth.clone())),
                        capture_store.clone(),
                        // A note arrives sealed; without the channel keys the
                        // capture service can store it but never index it, and an
                        // unindexed note is unfindable by voice forever.
                        key_material.clone(),
                    )
                    .with_capture_key_directory(
                        ai_bus_keys
                            .clone()
                            .expect("AI-bus workload configures its shared key directory"),
                    ),
                )
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                TestingAutomationServiceServer::new(services::capture::TestingAutomation::new(
                    attach_web(auth::RequestAuthenticator::new(config.auth.clone())),
                    capture_store.clone(),
                    key_material.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                PartnerTokenRpcServiceServer::new(
                    services::partnerservices::PartnerToken::with_store(capture_store.clone()),
                )
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                PushRelayServiceServer::new(services::pushrelay::PushRelay::with_store(
                    capture_store.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            );
        use cosmos_protocol::aibus::{
            ai_bus_service_server::AiBusServiceServer,
            amazon_shopping_service_server::AmazonShoppingServiceServer,
            composition_service_server::CompositionServiceServer,
            device_messages_service_server::DeviceMessagesServiceServer,
            food_service_server::FoodServiceServer, speech_service_server::SpeechServiceServer,
            test_automation_service_server::TestAutomationServiceServer,
            web_search_service_server::WebSearchServiceServer,
        };
        use cosmos_protocol::location::v1::e911_geo_location_service_server::E911GeoLocationServiceServer;
        grpc_router = grpc_router
            .add_service(
                AiBusServiceServer::new(
                    services::aibus_main::AiBusMain::with_key_material(key_material.clone())
                        .with_store(capture_store.clone()),
                )
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                AmazonShoppingServiceServer::new(services::aibus_extra::AmazonShopping::default())
                    .max_decoding_message_size(d)
                    .max_encoding_message_size(e),
            )
            .add_service(
                CompositionServiceServer::new(
                    services::aibus_extra::Composition::with_key_material(key_material.clone()),
                )
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                DeviceMessagesServiceServer::new(services::aibus_extra::DeviceMessages::new(
                    attach_web(auth::RequestAuthenticator::new(config.auth.clone())),
                    capture_store.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                FoodServiceServer::new(services::aibus_extra::Food::with_key_material(
                    key_material.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                SpeechServiceServer::new(services::aibus_extra::Speech::with_key_material(
                    key_material.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                TestAutomationServiceServer::new(services::aibus_extra::TestAutomation::new(
                    attach_web(auth::RequestAuthenticator::new(config.auth.clone())),
                    capture_store.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                WebSearchServiceServer::new(services::aibus_extra::WebSearch::new(
                    attach_web(auth::RequestAuthenticator::new(config.auth.clone())),
                    capture_store.clone(),
                ))
                .max_decoding_message_size(d)
                .max_encoding_message_size(e),
            )
            .add_service(
                E911GeoLocationServiceServer::new(services::location::Location::default())
                    .max_decoding_message_size(d)
                    .max_encoding_message_size(e),
            );
        use cosmos_protocol::privacy::grpc::r#pub::public_privacy_service_server::PublicPrivacyServiceServer;
        grpc_router = grpc_router.add_service(
            PublicPrivacyServiceServer::new(
                services::public_privacy::PublicPrivacy::with_key_material(key_material)
                    .with_store(capture_store.clone())
                    .with_key_directory(
                        ai_bus_keys
                            .clone()
                            .expect("AI-bus workload configures its shared key directory"),
                    ),
            )
            .max_decoding_message_size(d)
            .max_encoding_message_size(e),
        );
    }
    let mut grpc_task = tokio::spawn(async move {
        grpc_router
            .serve_with_incoming_shutdown(TcpListenerStream::new(grpc_listener), grpc_shutdown)
            .await
    });

    readiness.mark_ready();
    health_reporter
        .set_service_status("", ServingStatus::Serving)
        .await;
    health_reporter
        .set_service_status(service_name.clone(), ServingStatus::Serving)
        .await;
    // Publish enrollment readiness from the workload that actually holds the
    // DeviceUser CA. The operator console lives in another process and cannot
    // see this material; asking here — over the health service every container
    // can already reach — is what stops it from guessing from its own
    // environment and reporting "No DeviceUser CA" while enrollment is fine.
    //
    // Registered whatever the answer is, so a peer can tell "no CA" apart from
    // "could not ask": an unregistered name answers NOT_FOUND, not NOT_SERVING.
    if config.identity.workload() == cosmos_core::Workload::Provisioning {
        let duc = crate::enrollment::duc_ca_readiness();
        let status = if duc == crate::enrollment::DucCaReadiness::Ready {
            ServingStatus::Serving
        } else {
            tracing::warn!(
                readiness = ?duc,
                "no usable DeviceUser CA: device binding will refuse, and the operator console \
                 will show this workload's verdict"
            );
            ServingStatus::NotServing
        };
        health_reporter
            .set_service_status(crate::enrollment::DUC_CA_HEALTH_SERVICE, status)
            .await;
    }
    tracing::info!(
        workload = %config.identity.workload(),
        environment = %config.identity.environment(),
        grpc_bind = %config.grpc_bind,
        http_bind = %config.http_bind,
        auth = config.auth.label(),
        "workload serving"
    );

    enum Exit {
        Shutdown,
        Http(Result<Result<(), io::Error>, JoinError>),
        Grpc(Result<Result<(), tonic::transport::Error>, JoinError>),
    }

    let exit = tokio::select! {
        () = shutdown => Exit::Shutdown,
        result = &mut http_task => Exit::Http(result),
        result = &mut grpc_task => Exit::Grpc(result),
    };

    readiness.mark_not_ready();
    health_reporter
        .set_service_status("", ServingStatus::NotServing)
        .await;
    health_reporter
        .set_service_status(service_name, ServingStatus::NotServing)
        .await;
    let _ = shutdown_tx.send(true);

    let grace = config.limits.shutdown_grace;
    let deadline = Instant::now() + grace;
    let (primary_result, secondary_result) = match exit {
        Exit::Shutdown => {
            let (http_result, grpc_result) = tokio::join!(
                await_http_until(http_task, deadline, grace),
                await_grpc_until(grpc_task, deadline, grace),
            );
            (http_result, grpc_result)
        }
        Exit::Http(result) => {
            let grpc_result = await_grpc_until(grpc_task, deadline, grace).await;
            (flatten_http(result), grpc_result)
        }
        Exit::Grpc(result) => {
            let http_result = await_http_until(http_task, deadline, grace).await;
            (flatten_grpc(result), http_result)
        }
    };

    primary_result?;
    secondary_result?;
    tracing::info!(workload = %config.identity.workload(), "workload stopped");
    Ok(())
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(signal) => signal,
        Err(error) => {
            tracing::error!(kind = "shutdown_signal", %error, "failed to listen for SIGTERM");
            wait_for_ctrl_c().await;
            return;
        }
    };

    let sigterm = async {
        if terminate.recv().await.is_none() {
            tracing::error!(
                kind = "shutdown_signal",
                "SIGTERM listener closed unexpectedly"
            );
            std::future::pending::<()>().await;
        }
    };

    tokio::select! {
        () = wait_for_ctrl_c() => {}
        () = sigterm => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    wait_for_ctrl_c().await;
}

async fn wait_for_ctrl_c() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(kind = "shutdown_signal", %error, "failed to listen for Ctrl-C");
        std::future::pending::<()>().await;
    }
}

async fn wait_for_shutdown(mut receiver: watch::Receiver<bool>) {
    while !*receiver.borrow() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

fn flatten_http(result: Result<Result<(), io::Error>, JoinError>) -> Result<(), ServerError> {
    result.map_err(ServerError::Task)?.map_err(ServerError::Io)
}

fn flatten_grpc(
    result: Result<Result<(), tonic::transport::Error>, JoinError>,
) -> Result<(), ServerError> {
    result
        .map_err(ServerError::Task)?
        .map_err(ServerError::Transport)
}

async fn await_http_until(
    task: JoinHandle<Result<(), io::Error>>,
    deadline: Instant,
    grace: Duration,
) -> Result<(), ServerError> {
    await_task_until(task, deadline, grace)
        .await?
        .map_err(ServerError::Io)
}

async fn await_grpc_until(
    task: JoinHandle<Result<(), tonic::transport::Error>>,
    deadline: Instant,
    grace: Duration,
) -> Result<(), ServerError> {
    await_task_until(task, deadline, grace)
        .await?
        .map_err(ServerError::Transport)
}

async fn await_task_until<T>(
    mut task: JoinHandle<T>,
    deadline: Instant,
    grace: Duration,
) -> Result<T, ServerError> {
    match tokio::time::timeout_at(deadline, &mut task).await {
        Ok(result) => result.map_err(ServerError::Task),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(ServerError::ShutdownTimeout(grace))
        }
    }
}

pub fn init_logging(level: LogLevel) {
    let filter = tracing_subscriber::EnvFilter::new(level.as_str());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .try_init();
}

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("I/O failure: {0}")]
    Io(#[from] io::Error),
    #[error("gRPC transport failure: {0}")]
    Transport(#[from] tonic::transport::Error),
    #[error("server task failed: {0}")]
    Task(#[from] JoinError),
    #[error("servers did not stop within {0:?}")]
    ShutdownTimeout(std::time::Duration),
    #[error("web authentication plane unavailable: {0}")]
    WebAuth(String),
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        net::SocketAddr,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };

    use tonic::Request;
    use tonic_health::pb::{
        HealthCheckRequest, health_check_response, health_client::HealthClient,
    };

    use super::*;

    async fn unused_loopback_address() -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind temporary listener");
        listener.local_addr().expect("temporary local address")
    }

    #[tokio::test]
    async fn serves_standard_grpc_health_over_http2() {
        let grpc_address = unused_loopback_address().await;
        let http_address = unused_loopback_address().await;
        let values = HashMap::from([
            (
                "COSMOS_AUTH_MODE".to_owned(),
                "development-insecure".to_owned(),
            ),
            ("COSMOS_GRPC_BIND".to_owned(), grpc_address.to_string()),
            ("COSMOS_HTTP_BIND".to_owned(), http_address.to_string()),
            ("COSMOS_SHUTDOWN_GRACE_MS".to_owned(), "2000".to_owned()),
        ]);
        let config = Config::from_map(&values).expect("local test config");
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_until(config, async move {
            let _ = shutdown_rx.await;
        }));

        let endpoint = tonic::transport::Endpoint::from_shared(format!("http://{grpc_address}"))
            .expect("valid endpoint URI");
        let mut client = None;
        for _ in 0..20 {
            match endpoint.clone().connect().await {
                Ok(channel) => {
                    client = Some(HealthClient::new(channel));
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        let mut client = client.expect("gRPC health server became reachable");
        let response = client
            .check(Request::new(HealthCheckRequest {
                service: "ai-bus".to_owned(),
            }))
            .await
            .expect("health check succeeds");

        assert_eq!(
            response
                .metadata()
                .get("x-humane-service-path")
                .expect("gRPC topology metadata")
                .to_str()
                .expect("ASCII topology metadata"),
            "development:eastus:ai-bus-local-local-1"
        );
        let response = response.into_inner();

        assert_eq!(
            response.status,
            health_check_response::ServingStatus::Serving as i32
        );

        shutdown_tx.send(()).expect("request shutdown");
        tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .expect("server stops before test timeout")
            .expect("server task completes")
            .expect("server exits cleanly");
    }

    #[tokio::test]
    async fn shutdown_timeout_aborts_and_awaits_the_server_task() {
        struct DropNotice(Arc<AtomicBool>);

        impl Drop for DropNotice {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task_dropped = dropped.clone();
        let task = tokio::spawn(async move {
            let _notice = DropNotice(task_dropped);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        started_rx.await.expect("task started");

        let grace = Duration::from_millis(5);
        let error = await_task_until(task, Instant::now() + grace, grace)
            .await
            .expect_err("pending task must exceed the grace period");

        assert!(matches!(
            error,
            ServerError::ShutdownTimeout(timeout) if timeout == grace
        ));
        assert!(
            dropped.load(Ordering::Acquire),
            "task future must be dropped before the timeout result returns"
        );
    }
}
