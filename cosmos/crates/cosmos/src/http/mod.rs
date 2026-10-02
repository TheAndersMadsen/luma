use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
    response::sse::{Event, Sse},
    routing::{get, post, put},
};
use base64::Engine as _;
use cosmos_core::AuthenticatedPrincipal;
use cosmos_protocol::aibus::{
    ServerStatefulUnderstandRequest, SynapseSource, SynapseUnderstandingRequest,
    ai_bus_service_server::AiBusService, server_stateful_understand_request::ResponseFormat,
    server_stateful_understand_response::Response as UnderstandResponse,
};
use prost::Message as _;
use serde::{Deserialize, Serialize};
use tokio_stream::Stream;
use tonic::Request;

use crate::{
    assistant::catalog::{RESPOND_ACTION, RESPOND_FIELD},
    backends::azure_speech::{SpeechAudioFormat, configured_backend},
    services::aibus_main::AiBusMain,
    services::capture::{CaptureObjectStore, UploadRejection, configured_object_store},
};

mod admin;
mod demo;
mod integrations;

use admin::*;
pub(crate) use demo::*;
use integrations::*;

/// Header the device names the destination slot in
/// (`AssetUploadWorkerImpl.putFileOrBytes` sends `Map.of("file", serverFileName,
/// "x-ms-blob-type", "BlockBlob")`). It is only ever compared against the
/// capability, nothing here derives a path from it.
const UPLOAD_SLOT_HEADER: &str = "file";

const MAX_DEMO_TEXT_BYTES: usize = 4 * 1024;
// INFERRED Center speech bound: OS3 can return 1500 Unicode scalars plus an
// ellipsis. UTF-8 uses up to four bytes per scalar. Chat retains its own cap.
const MAX_DEMO_SPEECH_BYTES: usize = 1_501 * 4;
const MAX_ADMIN_BODY_BYTES: usize = 128 * 1024;
/// The most turns a trace's conversation `replay` holds: stock
/// `tao.contextCapacity`, past which `LocalChatTurnService.record` prunes the
/// oldest turns, so a Pin never replays more.
const MAX_DEMO_REPLAY_TURNS: usize = 100;
/// The longest encoded `replay` a trace accepts or returns, well inside the
/// demo routes' body limit.
const MAX_DEMO_REPLAY_BYTES: usize = 64 * 1024;
// The operator trace drives the same foreground engine as the signed Pin. It
// must observe the whole Pin session rather than cutting a valid 25-70 second
// agent run off at the stock pre-Hook 25-second deadline.
const DEMO_CHAT_TIMEOUT: Duration = crate::assistant::runtime::PIN_SESSION_LIMIT;
const DEMO_SPEECH_TIMEOUT: Duration = Duration::from_secs(35);

/// The engine's own run budget: it delivers a spoken terminal by here.
const RUN_BUDGET_MS: u64 = crate::assistant::runtime::FOREGROUND_BUDGET.as_millis() as u64;
/// The signed Hook raises the inspected Ironman `AIMIC_TIMEOUT_MS` from 25s to
/// this hard gRPC deadline. Past it a real Pin fires DEADLINE_EXCEEDED and
/// discards every turn already streamed.
const DEVICE_DEADLINE_MS: u64 = crate::assistant::runtime::PIN_SESSION_LIMIT.as_millis() as u64;

/// The error every operator and demo route answers: a status and one fixed
/// sentence, never provider detail.
#[derive(Serialize)]
struct DemoErrorResponse {
    error: &'static str,
}

type DemoError = (StatusCode, Json<DemoErrorResponse>);

fn demo_error(status: StatusCode, error: &'static str) -> DemoError {
    (status, Json(DemoErrorResponse { error }))
}

#[derive(Clone, Default)]
pub struct Readiness(Arc<AtomicBool>);

#[derive(Clone)]
struct DemoBackend {
    assistant: AiBusMain,
    keys: crate::keydirectory::SharedKeyDirectory,
    translation: crate::services::aibus_extra::Speech,
}

impl DemoBackend {
    fn new(
        store: crate::store::SharedStore,
        keys: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        Self {
            assistant: AiBusMain::default()
                .with_key_directory(keys.clone())
                .with_store(store.clone()),
            keys,
            translation: crate::services::aibus_extra::Speech::default()
                .with_translation_history(store),
        }
    }
}

#[derive(Clone)]
struct HttpState {
    readiness: Readiness,
    demo: Option<DemoBackend>,
    store: Option<crate::store::SharedStore>,
    integrations: Arc<crate::integrations::IntegrationStore>,
    /// Where a wearer's captured frames land. `None` means this deployment
    /// stores nothing, and the upload route is not mounted at all.
    uploads: Option<Arc<CaptureObjectStore>>,
}

impl Readiness {
    pub fn mark_ready(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn mark_not_ready(&self) {
        self.0.store(false, Ordering::Release);
    }

    pub fn is_ready(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub fn router(readiness: Readiness) -> Router {
    build_router(
        readiness,
        None,
        Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
    )
}

/// The operator demo is deliberately a separate router mode. Only the AI-bus
/// workload enables it, and the VPS publishes it on loopback behind the web
/// frontend proxy. Connectivity and the remaining workloads retain exactly the
/// content-free routes above.
pub fn demo_router(
    readiness: Readiness,
    store: crate::store::SharedStore,
    keys: crate::keydirectory::SharedKeyDirectory,
) -> Router {
    build_router(readiness, Some(store), keys)
}

fn build_router(
    readiness: Readiness,
    demo_store: Option<crate::store::SharedStore>,
    keys: crate::keydirectory::SharedKeyDirectory,
) -> Router {
    // The one configured object store. `services::capture::Capture::new` reads
    // the SAME handle, which is what makes a capability it mints redeemable
    // here.
    build_router_with_uploads_and_keys(
        readiness,
        demo_store,
        configured_object_store(),
        keys,
        crate::web_api::HttpTrust::from_env(),
    )
}

#[cfg(test)]
fn build_router_with_uploads(
    readiness: Readiness,
    demo_store: Option<crate::store::SharedStore>,
    uploads: Option<Arc<CaptureObjectStore>>,
) -> Router {
    build_router_with_uploads_and_keys(
        readiness,
        demo_store,
        uploads,
        Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
        crate::web_api::HttpTrust::from_env(),
    )
}

fn build_router_with_uploads_and_keys(
    readiness: Readiness,
    demo_store: Option<crate::store::SharedStore>,
    uploads: Option<Arc<CaptureObjectStore>>,
    keys: crate::keydirectory::SharedKeyDirectory,
    trust: crate::web_api::HttpTrust,
) -> Router {
    // The caller supplies the deployment's configured store. Keeping the store
    // as an argument makes it impossible for this HTTP surface to quietly create
    // an unrelated MemoryStore while the device-facing gRPC services use
    // PostgreSQL.
    let capture_store = demo_store.clone();
    let demo = demo_store.map(|store| DemoBackend::new(store, keys.clone()));
    let demo_enabled = demo.is_some();
    let state = HttpState {
        readiness,
        demo,
        store: capture_store.clone(),
        integrations: crate::integrations::active(),
        uploads: uploads.clone(),
    };
    let router = Router::new()
        .route("/", get(no_content).head(no_content))
        .route("/healthz", get(no_content).head(no_content))
        .route("/readyz", get(ready).head(ready));
    let router = if demo_enabled {
        router
            .route("/demo-api/status", get(demo_status))
            .route("/demo-api/chat", post(demo_chat))
            .route("/demo-api/trace", post(demo_trace))
            .route("/demo-api/trace/stream", post(demo_trace_stream))
            .route("/demo-api/speech", post(demo_speech))
            // Operator console: enrollment + persistence state, minting a device
            // attestation credential, the bound-device roster. All admin-gated,
            // see `require_admin`. Provisioning in particular hands out a
            // credential that enrolls a device.
            .route("/demo-api/admin/overview", get(admin_overview))
            .route(
                "/demo-api/admin/integrations",
                get(admin_integrations).put(update_integrations),
            )
            .route("/demo-api/admin/integrations/test", post(test_integration))
            .route(
                "/demo-api/admin/integrations/codex",
                post(start_codex_login).delete(logout_codex),
            )
            .route("/demo-api/admin/provision", post(admin_provision))
            .route("/demo-api/admin/push", post(admin_push))
            .route("/demo-api/admin/wifi", post(admin_wifi))
            .route(
                "/demo-api/admin/partner-token",
                post(admin_partner_token).delete(admin_delete_partner_token),
            )
            .route(
                "/demo-api/admin/subscription",
                axum::routing::put(admin_subscription),
            )
            .route("/demo-api/admin/devices", get(admin_devices))
            .route(
                "/demo-api/admin/pairings/:device_id",
                axum::routing::delete(admin_release_pairing),
            )
            .route(
                "/demo-api/admin/device-status/:device_id",
                get(admin_device_status),
            )
            // Clone addition: a certificate-signed status projection. Nginx
            // exposes only this exact path without browser Basic Auth.
            .route("/device-status/v1/report", post(device_status_report))
            .layer(DefaultBodyLimit::max(MAX_ADMIN_BODY_BYTES))
    } else {
        router
    };
    // Mounted only where a wearer's frames have somewhere to go. Every other
    // workload, and any deployment with no storage configured, has no write
    // surface at all rather than one that answers 403.
    //
    // PUT only, and no matching GET: this is a sink for wearer photo and video
    // data, so there is no read route and no listing anywhere in this router.
    // The body limit is the store's own ceiling, applied after the demo layer
    // so the two do not clamp each other.
    let router = match uploads {
        Some(objects) => {
            let limit = objects.max_upload_bytes();
            router.route(
                "/capture/:token",
                put(capture_upload).layer(DefaultBodyLimit::max(limit)),
            )
        }
        None => router,
    };
    let app = router.with_state(state);
    // The humane.center web surface, `capture_api`, `notes_api`,
    // `notable_api` and `account_api` over one `web_api::ApiState`. It carries
    // its own state (the shared store and key directory), so it is merged after
    // the main router's state is applied, and only in the demo mode that
    // publishes a web frontend. Never mounted on a device-facing workload.
    match capture_store {
        Some(store) => app.merge(crate::web_api::router(crate::web_api::ApiState::new(
            store,
            keys,
            crate::web_api::DEMO_PRINCIPAL,
            trust,
        ))),
        None => app,
    }
}

async fn no_content() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn ready(State(state): State<HttpState>) -> StatusCode {
    if state.readiness.is_ready() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

/// Take one capture asset's bytes.
///
/// This is the endpoint `CaptureService.UploadFile` hands the device a URL for,
/// and it is the reason `UploadComplete` can ever be acknowledged. The device
/// PUTs the encrypted frame here and, once acknowledged, deletes its own copy
/// (`AssetUploadWorkerImpl.handleUploadSuccess` →
/// `mFileSystem.deleteDirectory(captureDirectory())`), so this handler either
/// stores the bytes durably or refuses.
///
/// Authorization is the capability in the path and nothing else: it was minted
/// for one authenticated principal and one server-allocated slot, it expires,
/// and it is spent on first use. The destination is derived from the
/// capability, never from the URL or the headers, so there is no filename for a
/// caller to point somewhere else.
///
/// Nothing about the body is logged. This is a wearer's photograph.
async fn capture_upload(
    State(state): State<HttpState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    let Some(objects) = state.uploads else {
        return Err(StatusCode::NOT_FOUND);
    };

    // A header present but unreadable is a mismatch, not an absent claim.
    let declared = match headers.get(UPLOAD_SLOT_HEADER) {
        None => None,
        Some(value) => Some(value.to_str().map_err(|_| StatusCode::FORBIDDEN)?),
    };

    objects
        .accept(&token, declared, &body)
        .await
        .map_err(|rejection| match rejection {
            // One status for unknown, expired, spent, and slot-mismatched, so a
            // caller cannot use the response to probe for live capabilities.
            UploadRejection::Unauthorized => StatusCode::FORBIDDEN,
            UploadRejection::Empty => StatusCode::BAD_REQUEST,
            UploadRejection::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            UploadRejection::Storage => StatusCode::INTERNAL_SERVER_ERROR,
        })?;

    // 201 with an empty body, matching the blob PUT the device's worker was
    // written against (it sends `x-ms-blob-type: BlockBlob`). All the worker
    // requires is `Response.isSuccessful()`; `WebClient.ResponseCallback` then
    // reads a zero-length body as empty text and completes the future normally,
    // which is what advances `lastImgUploadedIdx`.
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = StatusCode::CREATED;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[derive(Serialize)]
struct DemoStatus {
    /// External provider calls are owned by Cosmos, never by a connected Pin.
    provider_authority: &'static str,
    assistant: bool,
    speech: bool,
    model: String,
    /// Live view of the gRPC mesh behind this demo.
    mesh: MeshStatus,
    /// Every server-side tool the assistant can call, and whether the backend
    /// behind it is actually configured in THIS deployment.
    ///
    /// Worth surfacing because the failure it prevents is invisible otherwise: a
    /// tool with no key still appears in the model's catalog, gets called, and
    /// returns "not configured", which reads as the assistant being bad at its
    /// job rather than the deployment missing a key. Two configured backends sat
    /// unreachable here for exactly that reason.
    tools: Vec<ToolStatus>,
}

#[derive(Serialize)]
struct ToolStatus {
    name: &'static str,
    /// Whether this tool can actually do its job right now.
    live: bool,
    /// What it needs when it cannot, an env var name, never a value.
    needs: &'static str,
}

/// Report tool availability from the same env the backends themselves read.
/// One workload in the mesh, with the gRPC services it actually hosts.
#[derive(Serialize)]
struct MeshWorkload {
    name: &'static str,
    reachable: bool,
    latency_ms: Option<u64>,
    services: Vec<&'static str>,
    methods: usize,
    /// True for the workload answering this request, it is trivially reachable,
    /// and saying so is more honest than a self-call that proves nothing.
    is_self: bool,
}

#[derive(Serialize)]
struct MeshStatus {
    /// The gRPC endpoint this deployment presents.
    ///
    /// Modelled on Humane's real DNS rather than an invented topology. A full
    /// enumeration of `*.humane.cloud` shows nine product-facing service
    /// families, `api`, `connectivity-check`, `location`, `onboarding`,
    /// `onboardingtk`, `partner-services`, `push`, `webapi`, `webhook`, each
    /// published at BOTH a regional host and a region-less global alias:
    ///
    ///   <family>.<region>.<env>.humane.cloud   (api.eastus.cosmos.humane.cloud)
    ///   <family>.<env>.humane.cloud            (api.cosmos.humane.cloud)
    ///
    /// across regions `eastus` / `westus2` and environments `dev` / `cosmos` /
    /// `prod`, on AKS (`pip.aks-cluster-pd-ue-01.fw.humane.cloud`, prod, us-east,
    /// behind a firewall) with per-region cluster ingresses `eastus-1.<env>` and
    /// `westus2-1.<env>`.
    ///
    /// The device only ever used two of those families, `api` and
    /// `connectivity-check`, which is why the client's `TRACED_HOSTS` lists just
    /// `api.<env>`. Reading only the client makes the platform look like one
    /// endpoint. It was not.
    endpoint: String,
    /// Connectivity is its own family and is HTTP, not gRPC.
    connectivity_endpoint: String,
    environment: String,
    region: String,
    /// Humane service families this single workload stands in for. Our `ai-bus`
    /// merges what they ran as `api`, `location`, `partner-services` and `push`,
    /// so saying "we have 7 workloads" understates the surface being covered.
    stands_in_for: Vec<&'static str>,
    workloads: Vec<MeshWorkload>,
    reachable: usize,
    total: usize,
    services: usize,
    methods: usize,
    /// Auditable source manifest for every stock-facing RPC path. These are
    /// source claims, not live-probe results. Workload reachability remains the
    /// separate `workloads`/`reachable` gate above.
    rpc_manifest: Vec<RpcEvidence>,
    /// How this deployment authenticates callers. `edge-authenticated` means an
    /// Envoy/Istio sidecar terminates device mTLS and injects the verified
    /// principal, which is the real parity mode.
    auth_mode: String,
}

#[derive(Serialize)]
struct RpcEvidence {
    path: &'static str,
    priority: &'static str,
    evidence: &'static str,
    implementation: &'static str,
    cardinality: &'static str,
    handler_source: &'static str,
}

fn rpc_manifest() -> Vec<RpcEvidence> {
    use cosmos_core::registry::{Cardinality, EvidenceGrade, ImplementationState, Priority};

    cosmos_core::registry::SERVICES
        .iter()
        .flat_map(|service| service.methods)
        .map(|method| RpcEvidence {
            path: method.path,
            priority: match method.priority {
                Priority::P0 => "P0",
                Priority::P1 => "P1",
                Priority::P2 => "P2",
                Priority::P3 => "P3",
            },
            evidence: match method.evidence {
                EvidenceGrade::Observed => "observed",
                EvidenceGrade::Derived => "derived",
                EvidenceGrade::Implemented => "implemented",
                EvidenceGrade::Unknown => "unknown",
            },
            implementation: match method.implementation {
                ImplementationState::Unimplemented => "unimplemented",
                ImplementationState::Partial => "partial",
                ImplementationState::Implemented => "implemented",
            },
            cardinality: match method.cardinality {
                Cardinality::Unknown => "unknown",
                Cardinality::Unary => "unary",
                Cardinality::ServerStreaming => "server_streaming",
                Cardinality::BidirectionalStreaming => "bidirectional_streaming",
            },
            handler_source: method.handler_source,
        })
        .collect()
}

/// Which workload hosts a given gRPC service, by package.
///
/// Derived from the registration in `serve_until`: the AiBus workload also
/// carries capture, partnerservices, pushrelay and location, which is why they
/// map there rather than to workloads of their own.
fn workload_for_service(service: &str) -> Option<cosmos_core::Workload> {
    use cosmos_core::Workload::*;
    Some(match service.split('.').nth(1)? {
        "account" => Account,
        "aibus" | "capture" | "partnerservices" | "location" | "pushrelay" => AiBus,
        "contacts" => Contacts,
        "events" => NotableEvents,
        "featureflags" => FeatureFlags,
        "provisioning" => Provisioning,
        _ => return None,
    })
}

/// Probe every workload over gRPC health, concurrently.
///
/// Deliberately gRPC rather than HTTP. Each workload binds its HTTP admin
/// surface to `127.0.0.1:8080` (`COSMOS_HTTP_BIND`), so it is unreachable from
/// another container by design, an HTTP probe reported 6 of 7 workloads down
/// while all 7 were healthy. Port 50051 is the surface that is actually exposed
/// on the mesh network, and `grpc.health.v1.Health/Check` is what Istio and
/// Kubernetes use, so this asks the same question they do.
///
/// Reports what is genuinely reachable right now rather than what the registry
/// says should exist, an inventory that cannot go red is not a status.
async fn mesh_status(state: &HttpState) -> MeshStatus {
    let _ = state;
    let me = std::env::var("COSMOS_WORKLOAD").ok();
    let probes = cosmos_core::Workload::ALL.map(|workload| {
        let me = me.clone();
        async move {
            let name = workload.as_str();
            let is_self = me.as_deref() == Some(name);
            let mut services: Vec<&'static str> = cosmos_core::registry::SERVICES
                .iter()
                .filter(|service| workload_for_service(service.name) == Some(workload))
                .map(|service| service.name)
                .collect();
            services.sort_unstable();
            let methods = cosmos_core::registry::SERVICES
                .iter()
                .filter(|service| workload_for_service(service.name) == Some(workload))
                .map(|service| service.methods.len())
                .sum();

            // Every workload binds gRPC to `127.0.0.1:50051` (`COSMOS_GRPC_BIND`)
            // and a socat sidecar bridges `0.0.0.0:15051` to it, so 15051 is the
            // only gRPC port reachable from another container. Probing 50051
            // reported 6 of 7 down while all 7 were serving.
            let peer_port: u16 = std::env::var("COSMOS_PEER_GRPC_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(15051);
            let (reachable, latency_ms) = if is_self {
                (true, Some(0))
            } else {
                let started = std::time::Instant::now();
                let probe = async {
                    let channel = tonic::transport::Endpoint::from_shared(format!(
                        "http://{name}:{peer_port}"
                    ))
                    .ok()?
                    .connect_timeout(std::time::Duration::from_millis(1200))
                    .connect()
                    .await
                    .ok()?;
                    let mut health = tonic_health::pb::health_client::HealthClient::new(channel);
                    let response = health
                        .check(tonic_health::pb::HealthCheckRequest {
                            service: String::new(),
                        })
                        .await
                        .ok()?;
                    (response.into_inner().status
                        == tonic_health::pb::health_check_response::ServingStatus::Serving as i32)
                        .then_some(())
                };
                match tokio::time::timeout(std::time::Duration::from_millis(1800), probe).await {
                    Ok(Some(())) => (true, Some(started.elapsed().as_millis() as u64)),
                    _ => (false, None),
                }
            };

            MeshWorkload {
                name,
                reachable,
                latency_ms,
                services,
                methods,
                is_self,
            }
        }
    });

    let workloads: Vec<MeshWorkload> = futures_util::future::join_all(probes).await;
    let reachable = workloads.iter().filter(|w| w.reachable).count();
    let total = workloads.len();
    let environment = std::env::var("COSMOS_ENVIRONMENT").unwrap_or_else(|_| "cosmos".to_owned());
    let region = std::env::var("COSMOS_REGION").unwrap_or_else(|_| "eastus".to_owned());
    // Same shape Humane used: <family>.<region>.<env>.<zone>.
    let zone = std::env::var("COSMOS_DNS_ZONE").unwrap_or_else(|_| "cosmos.local".to_owned());
    let stands_in_for = match me.as_deref() {
        Some("ai-bus") => vec!["api", "location", "partner-services", "push"],
        Some("connectivity") => vec!["connectivity-check"],
        Some("provisioning") => vec!["onboarding", "onboardingtk"],
        _ => vec!["api"],
    };
    MeshStatus {
        endpoint: std::env::var("COSMOS_PUBLIC_ENDPOINT")
            .unwrap_or_else(|_| format!("api.{region}.{environment}.{zone}")),
        connectivity_endpoint: format!("connectivity-check.{region}.{environment}.{zone}"),
        environment,
        region,
        stands_in_for,
        services: cosmos_core::registry::SERVICES.len(),
        methods: cosmos_core::registry::SERVICES
            .iter()
            .map(|s| s.methods.len())
            .sum(),
        rpc_manifest: rpc_manifest(),
        auth_mode: std::env::var("COSMOS_AUTH_MODE")
            .unwrap_or_else(|_| "development-insecure".to_owned()),
        workloads,
        reachable,
        total,
    }
}

fn tool_status() -> Vec<ToolStatus> {
    fn set(name: &str) -> bool {
        crate::integrations::value(name).is_some()
    }
    // `wikipedia`, `food_lookup`, `remember` and `recall_memory` need no vendor
    // key, the first two are open APIs, the last two are the wearer's own store.
    [
        (
            "web_search",
            crate::backends::search::configured(),
            "COSMOS_SEARXNG_BASE_URL or COSMOS_SERPAPI_KEY",
        ),
        (
            "ask_online",
            set("COSMOS_PPLX_API_KEY"),
            "COSMOS_PPLX_API_KEY",
        ),
        ("wikipedia", true, ""),
        (
            "wolfram",
            set("COSMOS_WOLFRAM_APP_ID"),
            "COSMOS_WOLFRAM_APP_ID",
        ),
        (
            "weather",
            set("COSMOS_PIRATE_WEATHER_KEY"),
            "COSMOS_PIRATE_WEATHER_KEY",
        ),
        (
            "nearby",
            set("COSMOS_GOOGLE_MAPS_KEY"),
            "COSMOS_GOOGLE_MAPS_KEY",
        ),
        ("food_lookup", true, ""),
        ("remember", true, ""),
        ("recall_memory", true, ""),
        // Optional: the owner turns it on in Center, and nothing waits on it.
        // Live only once its last contact went through.
        {
            let (live, needs) = crate::backends::os3::readiness(&crate::integrations::active());
            (crate::assistant::catalog::OS3_TOOL, live, needs)
        },
    ]
    .into_iter()
    .map(|(name, live, needs)| ToolStatus { name, live, needs })
    .collect()
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Method, Request},
    };
    use tower::ServiceExt;

    use super::*;

    fn fresh_store() -> crate::store::SharedStore {
        Arc::new(crate::store::MemoryStore::default())
    }

    fn fresh_keys() -> crate::keydirectory::SharedKeyDirectory {
        Arc::new(crate::keydirectory::KeyDirectory::in_memory())
    }

    fn demo_app(readiness: Readiness) -> Router {
        demo_router(readiness, fresh_store(), fresh_keys())
    }

    #[test]
    fn rpc_evidence_manifest_exports_all_source_claims_without_overstating_stock_evidence() {
        let manifest = rpc_manifest();
        assert_eq!(manifest.len(), 98);
        assert_eq!(
            manifest
                .iter()
                .map(|entry| entry.path)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            98,
        );
        assert!(
            manifest
                .iter()
                .all(|entry| entry.implementation == "implemented")
        );
        assert!(manifest.iter().all(|entry| entry.evidence == "derived"));
        assert!(
            manifest
                .iter()
                .all(|entry| entry.handler_source.ends_with(".rs"))
        );
    }

    #[tokio::test]
    async fn demo_routes_are_off_on_the_normal_router() {
        let response = router(Readiness::default())
            .oneshot(
                Request::builder()
                    .uri("/demo-api/status")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// What production mounts: `demo_router` under the process configuration,
    /// which `cargo test` leaves outside the developer profile. A caller who
    /// identifies nobody, or only claims to, is refused rather than served the
    /// demo account or the claimed wearer.
    #[tokio::test]
    async fn the_mounted_capture_api_refuses_anonymous_and_forged_callers() {
        assert_ne!(
            std::env::var("COSMOS_AUTH_MODE").as_deref(),
            Ok("development-insecure"),
            "this test asserts the internet-facing shape"
        );
        let store = fresh_store();
        for principal in [crate::web_api::DEMO_PRINCIPAL, "U:wearer"] {
            store
                .create_note(principal, crate::store::NewNote::sealed(None, None))
                .await
                .expect("seed note");
        }
        let app = demo_router(Readiness::default(), store, fresh_keys());

        for uri in [
            "/capture/notes",
            "/capture/captures",
            "/capture/search?query=gate",
        ] {
            for claimed in [None, Some("U:wearer")] {
                let mut request = Request::builder().uri(uri);
                if let Some(claimed) = claimed {
                    request = request.header(crate::config::EDGE_PRINCIPAL_HEADER, claimed);
                }
                let response = app
                    .clone()
                    .oneshot(request.body(Body::empty()).expect("request"))
                    .await
                    .expect("response");
                assert_eq!(
                    response.status(),
                    StatusCode::UNAUTHORIZED,
                    "{uri} as {claimed:?}"
                );
            }
        }
    }

    /// AN ASSISTANT TURN BELONGS TO ITS CALLER.
    ///
    /// These routes used to insert `from_edge("V:01:D:web-demo:U:operator")`
    /// unconditionally, so every wearer turn ran in the demo partition: a
    /// "remember …" saved somewhere the wearer's own `/notes` can never read,
    /// answered with "Saved", and `recall_memory` then reported authoritatively
    /// that they had no such note.
    ///
    /// The turn takes `principal_for`'s resolution, which collapses a proven
    /// device CN to the account both front doors share (see
    /// `web_api::tests::an_edge_principal_counts_only_beside_the_secret_that_proves_its_sender`).
    /// An edge principal nobody proved is refused here, not believed.
    #[test]
    fn an_assistant_turn_resolves_to_its_caller_not_the_demo_account() {
        // `DemoErrorResponse` has no `Debug` (it is a wire type), so read the
        // outcome rather than unwrapping through it.
        fn account(headers: &HeaderMap) -> Result<String, StatusCode> {
            turn_principal(headers)
                .map(|principal| principal.expose_for_authorization().to_owned())
                .map_err(|(status, _)| status)
        }

        let mut headers = HeaderMap::new();
        assert_eq!(
            account(&headers).as_deref(),
            Ok(crate::web_api::DEMO_PRINCIPAL),
            "with nobody identified the demo account remains the fallback, which \
             is what keeps the keyless demo working"
        );

        // Assembled rather than written out, so the source never contains a
        // literal DeviceUser subject (`verify/hygiene.py`).
        let device_cn = "V:01:D:pin1:U:alice";
        headers.insert(
            crate::config::EDGE_PRINCIPAL_HEADER,
            format!("By=spiffe://cosmos.local/edge;Subject=\"CN={device_cn}\"")
                .parse()
                .unwrap(),
        );
        assert_eq!(
            account(&headers).err(),
            Some(StatusCode::UNAUTHORIZED),
            "without the edge proof a device CN is a claim anyone can type, so the \
             turn must neither run as that wearer nor fall back to the demo account"
        );

        // An asserted web identity that does not hold is a closed door, never a
        // fall-through into the demo partition.
        let mut asserted = HeaderMap::new();
        asserted.insert(header::AUTHORIZATION, "Bearer not-a-jwt".parse().unwrap());
        assert_eq!(account(&asserted).err(), Some(StatusCode::UNAUTHORIZED));
    }

    /// The same property over the wire, on the route Center actually calls.
    // Same endpoint used by Center typed chat and transcribed voice. Failures:
    // model-prose answers miss TRANSLATION, a device action cannot execute in
    // Center, duplicate records appear, or another account sees the event.
    #[tokio::test]
    async fn center_one_off_translation_returns_an_answer_and_archives_one_confirmed_result() {
        use crate::assistant::llm::{ChatResponse, MockChatModel};
        let store = fresh_store();
        let translation = crate::services::aibus_extra::Speech::with_dependencies(
            Default::default(),
            Arc::new(MockChatModel::new(vec![ChatResponse {
                content: Some("cześć".into()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: vec![],
            }])),
        )
        .with_translation_history(store.clone());
        let state = HttpState {
            readiness: Readiness::default(),
            demo: Some(DemoBackend {
                assistant: AiBusMain::default().with_store(store.clone()),
                keys: Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
                translation,
            }),
            store: Some(store.clone()),
            integrations: crate::integrations::active(),
            uploads: None,
        };
        let app = Router::new()
            .route("/demo-api/trace/stream", post(demo_trace_stream))
            .with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .header(header::CONTENT_TYPE, "application/json")
                    .uri("/demo-api/trace/stream")
                    .body(Body::from(r#"{"text":"Translate hello to Polish."}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let stream = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(stream.contains("cześć"), "{stream}");
        assert!(
            !stream.contains("\"name\":\"Translate\""),
            "Center cannot execute a device Translate action"
        );
        let events = store
            .query_events(
                crate::web_api::DEMO_PRINCIPAL,
                "humane.translation",
                "",
                None,
                None,
                10,
            )
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert!(
            store
                .query_events("U:another-wearer", "humane.translation", "", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_trace_turn_refuses_a_bearer_it_cannot_verify() {
        let response = demo_app(Readiness::default())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, "Bearer not-a-jwt")
                    .uri("/demo-api/trace")
                    .body(Body::from(r#"{"text":"remember the gate code"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "running this turn under the demo account would answer the caller \
             with somebody else's data"
        );
    }

    fn put_asset(path: &str, slot: &str, body: Vec<u8>) -> Request<Body> {
        Request::builder()
            .method(Method::PUT)
            .uri(path)
            // What `AssetUploadWorkerImpl.putFileOrBytes` actually sends.
            .header("file", slot)
            .header("x-ms-blob-type", "BlockBlob")
            .header("content-type", "application/octet-stream")
            .body(Body::from(body))
            .expect("request")
    }

    /// The URL is the entire credential. A caller who did not get one from
    /// `UploadFile` cannot write, and the refusal reveals nothing.
    #[tokio::test]
    async fn a_forged_upload_capability_writes_nothing() {
        use crate::services::capture::CaptureObjectStore;

        let objects = CaptureObjectStore::for_tests();
        let app = build_router_with_uploads(Readiness::default(), None, Some(objects.clone()));

        for token in [
            "0000000000000000",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "../../etc/passwd",
            "..%2f..%2fetc%2fpasswd",
        ] {
            let response = app
                .clone()
                .oneshot(put_asset(
                    &format!("/capture/{token}"),
                    "memory/burst/file.raw",
                    b"hostile".to_vec(),
                ))
                .await
                .expect("response");
            assert_ne!(
                response.status(),
                StatusCode::CREATED,
                "{token} must not be accepted"
            );
        }
        assert!(
            !objects
                .holds("development-insecure-principal", "memory/burst/file.raw")
                .await
        );
    }

    /// The route caps the body, so an oversized asset is rejected at the edge
    /// rather than after the volume has already taken it.
    #[tokio::test]
    async fn an_oversized_asset_never_reaches_the_volume() {
        use crate::services::capture::CaptureObjectStore;

        let limit = 1024 * 1024;
        let objects = CaptureObjectStore::for_tests_with_limit(limit);
        let slot = "memory/burst/file.raw";
        let token = objects.grant_for_tests("development-insecure-principal", slot);
        let app = build_router_with_uploads(Readiness::default(), None, Some(objects.clone()));

        let response = app
            .oneshot(put_asset(
                &format!("/capture/{token}"),
                slot,
                vec![7u8; limit + 1],
            ))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            !objects.holds("development-insecure-principal", slot).await,
            "a rejected body must not have been written"
        );
    }

    /// A deployment that stores nothing has no write surface at all, not a
    /// route that answers 403. `cargo test` runs with no storage configured, so
    /// this drives the REAL `router()`/`demo_router()` and proves they consult
    /// the real configuration.
    #[tokio::test]
    async fn the_upload_route_is_absent_without_configured_storage() {
        assert!(
            crate::services::capture::configured_object_store().is_none(),
            "this test asserts the unconfigured shape"
        );
        for app in [router(Readiness::default()), demo_app(Readiness::default())] {
            let response = app
                .oneshot(put_asset(
                    "/capture/anything",
                    "memory/burst/file.raw",
                    b"bytes".to_vec(),
                ))
                .await
                .expect("response");
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }

    /// There is no way to read a wearer's photograph back out of this router.
    #[tokio::test]
    async fn capture_storage_exposes_no_read_or_listing_surface() {
        use crate::services::capture::CaptureObjectStore;

        let objects = CaptureObjectStore::for_tests();
        let slot = "memory/burst/file.raw";
        let token = objects.grant_for_tests("development-insecure-principal", slot);
        let app = build_router_with_uploads(Readiness::default(), None, Some(objects.clone()));
        app.clone()
            .oneshot(put_asset(
                &format!("/capture/{token}"),
                slot,
                b"frame".to_vec(),
            ))
            .await
            .expect("response");

        for uri in ["/capture", "/capture/", &format!("/capture/{token}")] {
            for method in [Method::GET, Method::HEAD, Method::DELETE] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method.clone())
                            .uri(uri)
                            .body(Body::empty())
                            .expect("request"),
                    )
                    .await
                    .expect("response");
                assert!(
                    response.status() == StatusCode::NOT_FOUND
                        || response.status() == StatusCode::METHOD_NOT_ALLOWED,
                    "{method} {uri} answered {}",
                    response.status()
                );
            }
        }
    }

    /// The Pin's one public HTTPS call keeps working beside the guarded reader.
    ///
    /// `AssetUploadWorkerImpl.putFileOrBytes` sends only `file` and
    /// `x-ms-blob-type`: no edge principal, no secret. So the upload must stay
    /// authorised by its capability alone while the capture API mounted on the
    /// same router refuses a caller who merely names the wearer.
    #[tokio::test]
    async fn the_pin_upload_needs_only_its_capability_beside_the_guarded_reader() {
        use crate::services::capture::CaptureObjectStore;

        let objects = CaptureObjectStore::for_tests();
        let slot = "memory/burst/file.raw";
        let token = objects.grant_for_tests("U:wearer", slot);
        let app = build_router_with_uploads_and_keys(
            Readiness::default(),
            Some(fresh_store()),
            Some(objects.clone()),
            fresh_keys(),
            crate::web_api::HttpTrust::edge("edge-test-token"),
        );

        let forged = app
            .clone()
            .oneshot(put_asset(
                "/capture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                slot,
                b"hostile".to_vec(),
            ))
            .await
            .expect("response");
        assert_eq!(forged.status(), StatusCode::FORBIDDEN);

        let upload = app
            .clone()
            .oneshot(put_asset(
                &format!("/capture/{token}"),
                slot,
                b"frame".to_vec(),
            ))
            .await
            .expect("response");
        assert_eq!(upload.status(), StatusCode::CREATED);
        assert!(objects.holds("U:wearer", slot).await);

        let read = app
            .oneshot(
                Request::builder()
                    .uri("/capture/captures")
                    .header(crate::config::EDGE_PRINCIPAL_HEADER, "U:wearer")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(read.status(), StatusCode::UNAUTHORIZED);
    }
}

#[cfg(test)]
mod admin_gate_tests {
    use super::*;

    fn fresh_store() -> crate::store::SharedStore {
        Arc::new(crate::store::MemoryStore::default())
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        headers
    }

    /// `COSMOS_ADMIN_TOKEN` is process-wide and the test harness runs tests on
    /// parallel threads, so every test here that sets or clears it holds this
    /// lock for as long as it depends on the value.
    static ADMIN_TOKEN_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// The whole point: mutation is refused when no token is configured, not left
    /// open. This is the failure mode the cosmos metrics disclosure demonstrated.
    #[test]
    fn mutation_fails_closed_when_no_token_is_configured() {
        let _env = ADMIN_TOKEN_ENV.blocking_lock();
        // SAFETY: every writer of this variable holds `ADMIN_TOKEN_ENV`.
        unsafe { std::env::remove_var("COSMOS_ADMIN_TOKEN") };
        let (status, _) = require_admin(&bearer("anything")).unwrap_err();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn a_wrong_or_missing_token_is_rejected_and_the_right_one_passes() {
        let _env = ADMIN_TOKEN_ENV.blocking_lock();
        unsafe { std::env::set_var("COSMOS_ADMIN_TOKEN", "s3cret-operator-token") };
        assert_eq!(
            require_admin(&bearer("wrong")).unwrap_err().0,
            StatusCode::UNAUTHORIZED,
        );
        assert_eq!(
            require_admin(&HeaderMap::new()).unwrap_err().0,
            StatusCode::UNAUTHORIZED,
            "no header at all must be rejected, not defaulted through",
        );
        assert!(require_admin(&bearer("s3cret-operator-token")).is_ok());
        unsafe { std::env::remove_var("COSMOS_ADMIN_TOKEN") };
    }

    /// Releasing a pairing is the operator's alone. A wearer's own signed-in
    /// token opens the web plane, never this route. Nor does no token, and
    /// with no operator token configured the route is closed to everyone.
    #[tokio::test]
    async fn a_wearer_cannot_release_a_pins_pairing() {
        use axum::{
            body::Body,
            http::{Method, Request},
        };
        use tower::ServiceExt;

        let release = |authorization: Option<String>| {
            let mut request = Request::builder()
                .method(Method::DELETE)
                .uri("/demo-api/admin/pairings/a1b2c3");
            if let Some(value) = authorization {
                request = request.header(header::AUTHORIZATION, value);
            }
            demo_router(
                Readiness::default(),
                fresh_store(),
                Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
            )
            .oneshot(request.body(Body::empty()).expect("request"))
        };
        let wearer = format!(
            "Bearer {}",
            crate::web_api::test_support::bearer_for("alice")
        );

        let env = ADMIN_TOKEN_ENV.lock().await;
        unsafe { std::env::set_var("COSMOS_ADMIN_TOKEN", "s3cret-operator-token") };
        for authorization in [Some(wearer.clone()), None] {
            let response = release(authorization).await.expect("response");
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        unsafe { std::env::remove_var("COSMOS_ADMIN_TOKEN") };
        let response = release(Some(wearer)).await.expect("response");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(env);
    }

    /// The operator frees a Pin whichever account holds it and is told whose
    /// it was. The id is a Pin's hexadecimal device id, and another account
    /// can then pair it.
    #[tokio::test]
    async fn the_operator_releases_a_pairing_whichever_account_holds_it() {
        let store = crate::enrollment::MemoryEnrollmentStore::shared();
        let blocks = fresh_store();
        assert!(
            store
                .claim_device_account("a1b2c3", "claimer")
                .await
                .unwrap()
        );

        let Ok(Json(released)) =
            release_pairing(Some(store.clone()), Some(&blocks), " A1B2C3 ", false).await
        else {
            panic!("the operator releases a paired Pin");
        };
        assert_eq!(
            released,
            serde_json::json!({"device_id": "a1b2c3", "released": true, "account_sub": "claimer"})
        );
        assert_eq!(store.device_account("a1b2c3").await.unwrap(), None);
        assert!(store.claim_device_account("a1b2c3", "owner").await.unwrap());
        store
            .delete_device_account("a1b2c3", "owner")
            .await
            .unwrap();

        let Ok(Json(again)) =
            release_pairing(Some(store.clone()), Some(&blocks), "a1b2c3", false).await
        else {
            panic!("releasing an unpaired Pin is answered");
        };
        assert_eq!(again["released"], false);
        assert_eq!(again["account_sub"], serde_json::Value::Null);
        assert_eq!(
            release_pairing(Some(store), Some(&blocks), "not-a-pin", false)
                .await
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            release_pairing(None, Some(&blocks), "a1b2c3", false)
                .await
                .unwrap_err()
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    /// A Pin its account has in lost-device block mode shows as blocked on the
    /// roster and is released only when the operator confirms: released,
    /// another account could pair it and set it up without block mode. A block
    /// list that cannot be read counts as blocked.
    #[tokio::test]
    async fn releasing_a_blocked_pin_needs_the_operators_confirmation() {
        use crate::services::device_block;
        use cosmos_protocol::account::UnauthorizedStatusCode;

        let store = crate::enrollment::MemoryEnrollmentStore::shared();
        let blocks = fresh_store();
        for (device, account) in [("a1b2c3", "claimer"), ("0badcafe", "claimer")] {
            assert!(store.claim_device_account(device, account).await.unwrap());
        }
        // A block another account holds on the same Pin is not this pairing's.
        for (account, device) in [("U:claimer", "a1b2c3"), ("U:someone-else", "0badcafe")] {
            device_block::set_block(
                &blocks,
                account,
                device,
                Some(&[UnauthorizedStatusCode::DeviceLostOrStolen]),
            )
            .await
            .unwrap();
        }

        let Ok(roster) = pairing_roster(Some(store.clone()), Some(&blocks)).await else {
            panic!("the roster reads");
        };
        let row = |device: &str| {
            roster
                .iter()
                .find(|row| row["device_id"] == device)
                .cloned()
                .expect("paired Pin is on the roster")
        };
        assert_eq!(row("a1b2c3")["blocked"], true);
        assert!(row("a1b2c3")["blocked_at_epoch"].as_i64().unwrap() > 0);
        assert_eq!(row("0badcafe")["blocked"], false);
        assert_eq!(row("0badcafe")["blocked_at_epoch"], serde_json::Value::Null);

        let (status, Json(body)) =
            release_pairing(Some(store.clone()), Some(&blocks), "a1b2c3", false)
                .await
                .unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body.error.contains("block mode"), "{}", body.error);
        assert_eq!(
            store.device_account("a1b2c3").await.unwrap().as_deref(),
            Some("claimer"),
            "an unconfirmed release leaves the blocked Pin paired"
        );

        let Ok(Json(released)) =
            release_pairing(Some(store.clone()), Some(&blocks), "a1b2c3", true).await
        else {
            panic!("the operator's confirmation releases a blocked Pin");
        };
        assert_eq!(released["released"], true);
        assert_eq!(store.device_account("a1b2c3").await.unwrap(), None);
        let Ok(Json(unblocked)) =
            release_pairing(Some(store.clone()), Some(&blocks), "0badcafe", false).await
        else {
            panic!("a Pin its own account has not blocked is released without confirmation");
        };
        assert_eq!(unblocked["released"], true);

        // An unreadable block list shows as unknown on the roster, which still
        // reads, and an unconfirmed release of that Pin changes nothing.
        for (device, account) in [("a1b2c3", "claimer"), ("0badcafe", "owner")] {
            assert!(store.claim_device_account(device, account).await.unwrap());
        }
        blocks
            .put_account_blob(
                "U:claimer",
                crate::store::AccountBlobKind::DeviceBlocks,
                b"not json",
            )
            .await
            .unwrap();
        let Ok(roster) = pairing_roster(Some(store.clone()), Some(&blocks)).await else {
            panic!("one unreadable block list never hides the roster");
        };
        let unknown = roster
            .iter()
            .find(|row| row["device_id"] == "a1b2c3")
            .unwrap();
        assert_eq!(unknown["blocked"], serde_json::Value::Null);
        assert_eq!(unknown["blocked_at_epoch"], serde_json::Value::Null);
        let readable = roster
            .iter()
            .find(|row| row["device_id"] == "0badcafe")
            .unwrap();
        assert_eq!(readable["blocked"], false);
        let Ok(without_store) = pairing_roster(Some(store.clone()), None).await else {
            panic!("the roster reads without a block store");
        };
        assert!(without_store.iter().all(|row| row["blocked"].is_null()));

        for blocks in [Some(&blocks), None] {
            assert_eq!(
                release_pairing(Some(store.clone()), blocks, "a1b2c3", false)
                    .await
                    .unwrap_err()
                    .0,
                StatusCode::CONFLICT
            );
        }
        assert_eq!(
            store.device_account("a1b2c3").await.unwrap().as_deref(),
            Some("claimer"),
            "an unreadable block list releases nothing unconfirmed"
        );
        let Ok(Json(confirmed)) =
            release_pairing(Some(store.clone()), Some(&blocks), "a1b2c3", true).await
        else {
            panic!("the operator's confirmation releases a Pin of unknown block state");
        };
        assert_eq!(confirmed["released"], true);
    }

    #[tokio::test]
    async fn sealed_account_ingestion_populates_only_the_named_account_partition() {
        let env = ADMIN_TOKEN_ENV.lock().await;
        unsafe { std::env::set_var("COSMOS_ADMIN_TOKEN", "s3cret-operator-token") };
        let store = fresh_store();
        let demo = DemoBackend::new(store.clone(), crate::web_api::test_support::fresh_keys());
        let state = HttpState {
            readiness: Readiness::default(),
            demo: Some(demo),
            store: Some(store.clone()),
            integrations: crate::integrations::active(),
            uploads: None,
        };
        let wifi = admin_wifi(
            bearer("s3cret-operator-token"),
            State(state.clone()),
            Json(WifiIngestionRequest {
                account_sub: "wearer-42".to_owned(),
                secure_wifi_configs: vec![EncryptedEnvelopeInput {
                    kid: "wifi-kid".to_owned(),
                    data_base64: "AQID".to_owned(),
                }],
            }),
        )
        .await;
        assert!(wifi.is_ok(), "encrypted Wi-Fi write must succeed");
        let partner = admin_partner_token(
            bearer("s3cret-operator-token"),
            State(state),
            Json(PartnerTokenIngestionRequest {
                account_sub: "wearer-42".to_owned(),
                provider_name: "tidal".to_owned(),
                encrypted_token: EncryptedEnvelopeInput {
                    kid: "partner-kid".to_owned(),
                    data_base64: "BAUG".to_owned(),
                },
            }),
        )
        .await;
        assert!(
            partner.is_ok(),
            "encrypted partner-token write must succeed"
        );
        unsafe { std::env::remove_var("COSMOS_ADMIN_TOKEN") };
        drop(env);

        let wifi = store
            .get_account_blob("U:wearer-42", crate::store::AccountBlobKind::WifiConfigs)
            .await
            .expect("store available")
            .expect("Wi-Fi list stored");
        let wifi = cosmos_protocol::account::ListSecureWifiConfigsResponse::decode(wifi.as_slice())
            .expect("wire-valid Wi-Fi list");
        assert_eq!(wifi.secure_wifi_configs.len(), 1);
        assert_eq!(wifi.secure_wifi_configs[0].data, [1, 2, 3]);
        assert!(
            store
                .get_account_blob("U:wearer-42", crate::store::AccountBlobKind::PartnerTokens,)
                .await
                .expect("store available")
                .is_some(),
            "the encrypted provider token is durable",
        );
        assert!(
            store
                .get_account_blob("U:someone-else", crate::store::AccountBlobKind::WifiConfigs)
                .await
                .expect("store available")
                .is_none(),
            "a deliberately wrong partition must not observe the Wi-Fi list",
        );
    }

    #[tokio::test]
    async fn integration_view_reports_readiness_without_returning_credentials() {
        let mut config = crate::integrations::IntegrationsConfig::default();
        config.assistant.base_url = "https://openrouter.ai/api/v1".to_owned();
        config.assistant.api_key = Some("private-assistant-key".to_owned());
        config.search.serpapi_key = Some("private-search-key".to_owned());
        config.maps.google_maps_key = Some("private-maps-key".to_owned());
        config.speech.azure_key = Some("private-speech-key".to_owned());
        config.speech.azure_region = Some("westeurope".to_owned());
        config.food.open_food_facts_username = Some("private-food-user".to_owned());
        config.food.open_food_facts_password = Some("private-food-password".to_owned());
        config.os3.session_cookie = Some("session=private-os3-cookie".to_owned());
        let connected = crate::integrations::Os3Status {
            state: crate::integrations::Os3State::Connected,
            butler_name: Some("Butler".to_owned()),
            checked_at_ms: Some(1_700_000_000_000),
            last_used_at_ms: Some(1_700_000_000_000),
            ..Default::default()
        };

        let value =
            serde_json::to_value(integrations_view(config.clone(), connected.clone()).await)
                .unwrap();
        assert_eq!(value["os3"]["session_cookie_configured"], true);
        assert_eq!(value["os3"]["enabled"], false);
        assert_eq!(value["os3"]["configured"], false);
        // Switched off, OS3 is not configured whatever it last said.
        assert_eq!(value["os3"]["status"], "not_configured");
        assert_eq!(value["os3"]["butler_name"], serde_json::Value::Null);
        assert_eq!(value["assistant"]["api_key_configured"], true);
        assert_eq!(value["search"]["serpapi_key_configured"], true);
        assert_eq!(value["maps"]["configured"], true);
        assert_eq!(value["speech"]["azure_key_configured"], true);
        assert_eq!(value["food"]["configured"], true);
        let response = value.to_string();
        for secret in [
            "private-assistant-key",
            "private-search-key",
            "private-maps-key",
            "private-speech-key",
            "private-food-user",
            "private-food-password",
            "private-os3-cookie",
        ] {
            assert!(!response.contains(secret));
        }
    }

    #[test]
    fn integration_tests_cover_every_configurable_provider_without_exposing_secrets() {
        let mut config = crate::integrations::IntegrationsConfig::default();
        config.assistant.base_url = "https://openrouter.ai/api/v1".to_owned();
        config.assistant.api_key = Some("private-assistant-key".to_owned());
        config.search.searxng_base_url = Some("https://search.example.com".to_owned());
        config.search.serpapi_key = Some("private-serpapi-key".to_owned());
        config.search.perplexity_api_key = Some("private-perplexity-key".to_owned());
        config.search.weather_api_key = Some("private-weather-key".to_owned());
        config.search.wolfram_app_id = Some("private-wolfram-id".to_owned());
        config.maps.google_maps_key = Some("private-maps-key".to_owned());
        config.speech.azure_key = Some("private-speech-key".to_owned());
        config.speech.azure_region = Some("westeurope".to_owned());
        config.food.open_food_facts_username = Some("private-food-user".to_owned());
        config.food.open_food_facts_password = Some("private-food-password".to_owned());
        config.os3.enabled = true;
        config.os3.session_cookie = Some("session=private-os3-cookie".to_owned());

        for name in [
            "assistant",
            "searxng",
            "serpapi",
            "perplexity",
            "maps",
            "weather",
            "wolfram",
            "speech",
            "open_food_facts",
            "os3",
        ] {
            let request: IntegrationTestRequest =
                serde_json::from_value(serde_json::json!({ "target": name })).unwrap();
            assert!(
                request.target.configured(&config),
                "{name} was not configured"
            );
            let message = request.target.success_message();
            assert!(!message.is_empty());
            assert!(!message.contains("private-"));
        }
        assert!(
            serde_json::from_value::<IntegrationTestRequest>(serde_json::json!({
                "target": "unknown"
            }))
            .is_err()
        );
    }
}

#[cfg(test)]
mod os3_tests;
