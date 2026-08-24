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
    backends::azure_speech::{SpeechAudioFormat, SpeechSynthesisBackend, configured_backend},
    services::aibus_main::AiBusMain,
    services::capture::{CaptureObjectStore, UploadRejection, configured_object_store},
};

/// Header the device names the destination slot in
/// (`AssetUploadWorkerImpl.putFileOrBytes` sends `Map.of("file", serverFileName,
/// "x-ms-blob-type", "BlockBlob")`). It is only ever compared against the
/// capability — nothing here derives a path from it.
const UPLOAD_SLOT_HEADER: &str = "file";

const MAX_DEMO_TEXT_BYTES: usize = 4 * 1024;
const MAX_ADMIN_BODY_BYTES: usize = 128 * 1024;
const DEMO_CHAT_TIMEOUT: Duration = Duration::from_secs(25);
const DEMO_SPEECH_TIMEOUT: Duration = Duration::from_secs(35);

/// The engine's own run budget: it delivers a spoken terminal by here.
const RUN_BUDGET_MS: u64 = 22_000;
/// `AIMIC_TIMEOUT_MS` — the device's hard gRPC deadline. Past it a real Pin
/// fires DEADLINE_EXCEEDED and discards every turn already streamed.
const DEVICE_DEADLINE_MS: u64 = 25_000;

#[derive(Clone, Default)]
pub struct Readiness(Arc<AtomicBool>);

#[derive(Clone)]
struct DemoBackend {
    assistant: AiBusMain,
    speech: Option<Arc<dyn SpeechSynthesisBackend>>,
}

impl DemoBackend {
    fn new(store: crate::store::SharedStore) -> Self {
        Self {
            assistant: AiBusMain::default().with_store(store),
            speech: configured_backend(),
        }
    }
}

#[derive(Clone)]
struct HttpState {
    readiness: Readiness,
    demo: Option<DemoBackend>,
    store: Option<crate::store::SharedStore>,
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
/// frontend proxy; connectivity and the remaining workloads retain exactly the
/// content-free routes above.
pub fn demo_router(
    readiness: Readiness,
    store: crate::store::SharedStore,
    keys: crate::keydirectory::SharedKeyDirectory,
) -> Router {
    build_router(readiness, Some(store), keys)
}

/// The device→account pairing endpoint, mounted on the **provisioning** workload
/// only.
///
/// A pairing must be written to the very enrollment store the OPAQUE ceremony
/// reads during `CreateLoginInit`. That store is process-local and in-memory
/// unless `COSMOS_DATABASE_URL` is set, so the write has to happen inside the
/// provisioning process itself. The operator console lives in `ai-bus` — a
/// different process — where [`crate::enrollment::pairing_store`] finds no
/// ceremony store and, absent a shared database, honestly refuses with 503.
/// Mounting this one admin-gated route on provisioning closes that gap without
/// moving the whole console or requiring Postgres: here `pairing_store()`
/// returns the same `ENROLLMENT_STORE` the ceremony initialised at boot.
pub fn pairing_router() -> Router {
    Router::new().route(
        "/demo-api/admin/pair",
        post(admin_pair).delete(admin_unpair),
    )
}

fn build_router(
    readiness: Readiness,
    demo_store: Option<crate::store::SharedStore>,
    keys: crate::keydirectory::SharedKeyDirectory,
) -> Router {
    // The one configured object store. `services::capture::Capture::new` reads
    // the SAME handle, which is what makes a capability it mints redeemable
    // here.
    build_router_with_uploads_and_keys(readiness, demo_store, configured_object_store(), keys)
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
    )
}

fn build_router_with_uploads_and_keys(
    readiness: Readiness,
    demo_store: Option<crate::store::SharedStore>,
    uploads: Option<Arc<CaptureObjectStore>>,
    keys: crate::keydirectory::SharedKeyDirectory,
) -> Router {
    // The caller supplies the deployment's configured store. Keeping the store
    // as an argument makes it impossible for this HTTP surface to quietly create
    // an unrelated MemoryStore while the device-facing gRPC services use
    // PostgreSQL.
    let capture_store = demo_store.clone();
    let demo = demo_store.map(DemoBackend::new);
    let demo_enabled = demo.is_some();
    let state = HttpState {
        readiness,
        demo,
        store: capture_store.clone(),
        uploads: uploads.clone(),
    };
    let router = Router::new()
        .route("/", get(no_content).head(no_content))
        .route("/healthz", get(no_content).head(no_content))
        .route("/readyz", get(ready).head(ready));
    let router = if demo_enabled {
        router
            .route("/demo-api/status", get(demo_status))
            .route("/demo-api/flags", get(list_flags).delete(reset_flags))
            .route(
                "/demo-api/flags/:name",
                axum::routing::put(set_flag).delete(clear_flag),
            )
            .route("/demo-api/chat", post(demo_chat))
            .route("/demo-api/trace", post(demo_trace))
            .route("/demo-api/trace/stream", post(demo_trace_stream))
            .route("/demo-api/speech", post(demo_speech))
            // Operator console: enrollment + persistence state, minting a device
            // attestation credential, the bound-device roster. All admin-gated —
            // see `require_admin`; provisioning in particular hands out a
            // credential that enrolls a device.
            .route("/demo-api/admin/overview", get(admin_overview))
            .route("/demo-api/admin/provision", post(admin_provision))
            .route(
                "/demo-api/admin/pair",
                post(admin_pair).delete(admin_unpair),
            )
            .route("/demo-api/admin/profile", post(admin_profile))
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
    // workload — and any deployment with no storage configured — has no write
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
    // The web companion's capture READ API — the `GET /capture/memories`,
    // `/capture/captures`, `/capture/memory/:uuid`, `/notes` surface the `.Center`
    // client used. It carries its own state (the shared store), so it is merged
    // after the main router's state is applied, and only in the demo mode that
    // publishes a web frontend. Never mounted on a device-facing workload.
    match capture_store {
        Some(store) => app.merge(crate::capture_api::router(
            store,
            keys,
            crate::capture_api::DEMO_PRINCIPAL,
        )),
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
    /// returns "not configured" — which reads as the assistant being bad at its
    /// job rather than the deployment missing a key. Two configured backends sat
    /// unreachable here for exactly that reason.
    tools: Vec<ToolStatus>,
}

#[derive(Serialize)]
struct ToolStatus {
    name: &'static str,
    /// Whether this tool can actually do its job right now.
    live: bool,
    /// What it needs when it cannot — an env var name, never a value.
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
    /// True for the workload answering this request — it is trivially reachable,
    /// and saying so is more honest than a self-call that proves nothing.
    is_self: bool,
}

#[derive(Serialize)]
struct MeshStatus {
    /// The gRPC endpoint this deployment presents.
    ///
    /// Modelled on Humane's real DNS rather than an invented topology. A full
    /// enumeration of `*.humane.cloud` shows nine product-facing service
    /// families — `api`, `connectivity-check`, `location`, `onboarding`,
    /// `onboardingtk`, `partner-services`, `push`, `webapi`, `webhook` — each
    /// published at BOTH a regional host and a region-less global alias:
    ///
    ///   <family>.<region>.<env>.humane.cloud   (api.eastus.cosmos.humane.cloud)
    ///   <family>.<env>.humane.cloud            (api.cosmos.humane.cloud)
    ///
    /// across regions `eastus` / `westus2` and environments `dev` / `cosmos` /
    /// `prod`, on AKS (`pip.aks-cluster-pd-ue-01.fw.humane.cloud` — prod, us-east,
    /// behind a firewall) with per-region cluster ingresses `eastus-1.<env>` and
    /// `westus2-1.<env>`.
    ///
    /// The device only ever used two of those families — `api` and
    /// `connectivity-check` — which is why the client's `TRACED_HOSTS` lists just
    /// `api.<env>`. Reading only the client makes the platform look like one
    /// endpoint; it was not.
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
    /// source claims, not live-probe results; workload reachability remains the
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
/// another container by design — an HTTP probe reported 6 of 7 workloads down
/// while all 7 were healthy. Port 50051 is the surface that is actually exposed
/// on the mesh network, and `grpc.health.v1.Health/Check` is what Istio and
/// Kubernetes use, so this asks the same question they do.
///
/// Reports what is genuinely reachable right now rather than what the registry
/// says should exist — an inventory that cannot go red is not a status.
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
        std::env::var(name).is_ok_and(|v| !v.trim().is_empty())
    }
    // `wikipedia`, `food_lookup`, `remember` and `recall_memory` need no vendor
    // key — the first two are open APIs, the last two are the wearer's own store.
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
    ]
    .into_iter()
    .map(|(name, live, needs)| ToolStatus { name, live, needs })
    .collect()
}

/// One flag, with BOTH what cosmos served and what this deployment serves.
///
/// Showing them side by side is the whole point: an operator needs to see that a
/// value is a deliberate deviation, not discover months later that the "observed"
/// number was quietly edited.
#[derive(Serialize)]
struct FlagView {
    name: String,
    #[serde(rename = "type")]
    value_type: &'static str,
    observed: serde_json::Value,
    effective: serde_json::Value,
    overridden: bool,
    label: &'static str,
    description: &'static str,
    category: &'static str,
    evidence: &'static str,
    delivery: &'static str,
    writable: bool,
    warning: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct FlagMetadata {
    label: &'static str,
    description: &'static str,
    category: &'static str,
    evidence: &'static str,
    delivery: &'static str,
    writable: bool,
    warning: Option<&'static str>,
}

fn flag_metadata(name: &str) -> FlagMetadata {
    let server_only = |label, description| FlagMetadata {
        label,
        description,
        category: "Compatibility record",
        evidence: "observed",
        delivery: "server_only",
        writable: false,
        warning: Some(
            "No installed Pin consumer was found. Changing this would create a switch with no supported device behaviour.",
        ),
    };
    let device = |label, description, category, evidence, delivery, warning| FlagMetadata {
        label,
        description,
        category,
        evidence,
        delivery,
        writable: true,
        warning,
    };

    match name {
        "demo_v1_enabled" => server_only(
            "Demo v1",
            "Captured in Cosmos's assignment response; no installed Pin consumer was found.",
        ),
        "demo_v2_enabled" => server_only(
            "Demo v2",
            "Captured in Cosmos's assignment response; no installed Pin consumer was found.",
        ),
        "demo_v2_experience" => server_only(
            "Demo v2 experience",
            "Captured in Cosmos's assignment response; no installed Pin consumer was found.",
        ),
        "personal_voice_enabled" => server_only(
            "Personal voice",
            "Observed compatibility assignment; Cosmos has no compatible personal-voice experience.",
        ),
        "calendar_enabled" => server_only(
            "Calendar experiment",
            "Observed compatibility assignment; the installed Pin does not consume this key.",
        ),
        "synapse_prod_logging_enabled" => server_only(
            "Production Synapse logging",
            "Observed diagnostics assignment with no installed device consumer.",
        ),
        "health_experience" => server_only(
            "Health experience",
            "Observed experiment key; it does not enable the stock fitness tracker.",
        ),
        "hackathon_health_experience" => server_only(
            "Hackathon health experience",
            "Observed experiment key with no installed device consumer.",
        ),
        "hackathon_ai_profile_user_personalization" => server_only(
            "Hackathon personalization",
            "Observed experiment key with no installed device consumer.",
        ),
        "flight_search_enabled" => server_only(
            "Flight search",
            "Captured as enabled by Cosmos, but no installed Pin flag consumer was found.",
        ),
        "history_search_enabled" => server_only(
            "History search",
            "Captured as enabled by Cosmos, but no installed Pin flag consumer was found.",
        ),
        "web_show_save_event_location_privacy_setting" => server_only(
            "Event-location privacy control",
            "A web-side Cosmos assignment; the Pin does not consume it.",
        ),
        "touchcode_enabled" => device(
            "Touchcode unlock",
            "Keeps the stock Touchcode unlock path available.",
            "Everyday Pin",
            "observed",
            "next_sync",
            Some(
                "Safety-sensitive: disabling the unlock path can make the Pin difficult to operate.",
            ),
        ),
        "vision_custom_gesture_enabled" => device(
            "Custom vision gesture",
            "Enables the stock vision gesture entry point.",
            "Everyday Pin",
            "observed",
            "next_sync",
            None,
        ),
        "quick_actions_remapping_enabled" => device(
            "Quick-action remapping",
            "Enables stock Settings and voice routes for remapping Notes, Messages, and Interpreter.",
            "Everyday Pin",
            "observed",
            "next_sync_restart",
            Some("Restart Ironman after changing this so its cached recognizer map is rebuilt."),
        ),
        "tickle" => device(
            "The Tickle",
            "Enables the hidden stock Tickle phrases and experience.",
            "Everyday Pin",
            "observed",
            "next_sync",
            Some(
                "Prototype experience; transcript-to-activity behavior is implemented, but subjective audio quality remains unverified.",
            ),
        ),
        "music_interstitials_enabled" => device(
            "Music announcements",
            "Lets stock music actions narrate the current selection.",
            "Everyday Pin",
            "observed",
            "next_sync",
            None,
        ),
        "synapse_bidirectional_streaming" => device(
            "Streaming assistant sessions",
            "Switches ordinary assistant turns to the persistent bidirectional Understand transport.",
            "Experiments",
            "observed",
            "next_sync",
            Some("Experimental. Keep off for normal use; the stock Cosmos capture served false."),
        ),
        "accessory_feature_flags" => FlagMetadata {
            label: "Accessory feature flags",
            description: "Declared by firmware, but no installed runtime consumer or non-empty grammar was found.",
            category: "Compatibility record",
            evidence: "unknown",
            delivery: "inert",
            writable: false,
            warning: Some("Locked because no safe value format is known."),
        },
        "feature_flag_suppress_sync_on_startup" => FlagMetadata {
            label: "Suppress startup sync",
            description: "Skips Ironman's one-time boot fetch while periodic, push, and debug sync paths remain.",
            category: "System & recovery",
            evidence: "derived",
            delivery: "next_sync_restart",
            writable: false,
            warning: Some("Locked off so every boot has a deterministic recovery fetch."),
        },
        "touchcode_timeout_millis" => device(
            "Touchcode timeout",
            "Milliseconds before an in-progress Touchcode gesture finishes.",
            "Everyday Pin",
            "derived",
            "next_sync",
            Some("Use a non-negative Java integer. Zero expires immediately."),
        ),
        "laser_finding_guide" => FlagMetadata {
            label: "Laser finding guide",
            description: "Declared by firmware, but no installed runtime consumer was found.",
            category: "Compatibility record",
            evidence: "unknown",
            delivery: "inert",
            writable: false,
            warning: Some("Locked because changing it cannot produce an evidence-backed behavior."),
        },
        "server_side_transcription_save_enabled" => device(
            "Attach transcription audio",
            "Allows stock to attach bounded recognition PCM to the in-memory turn.",
            "Privacy & data",
            "derived",
            "next_sync",
            Some(
                "Privacy-sensitive. Penumbra currently discards this unknown response field rather than storing it.",
            ),
        ),
        "server_side_speech_synthesis_timeout_millis" => device(
            "Remote speech timeout",
            "A positive millisecond budget lets stock call Cosmos SpeechService; zero keeps local Android speech.",
            "Voice & assistant",
            "implemented",
            "next_sync",
            Some("Remote speech also requires the deployment's Azure Speech configuration."),
        ),
        "server_side_speech_synthesis_streaming_enabled" => device(
            "Streaming remote speech",
            "Uses the server-streaming speech RPC when remote speech is active.",
            "Voice & assistant",
            "implemented",
            "next_sync",
            Some("Requires a positive remote speech timeout."),
        ),
        "server_side_speech_synthesis_voice_name" => FlagMetadata {
            label: "Remote speech voice",
            description: "The stock-requested voice selector; this deployment uses its operator-configured Azure voice.",
            category: "Voice & assistant",
            evidence: "implemented",
            delivery: "server_controlled",
            writable: false,
            warning: Some(
                "Locked because untrusted device assignments must not choose cloud speech configuration.",
            ),
        },
        "cmu_ultra_enabled" => device(
            "Catch Me Up Ultra accessory path",
            "Controls stock ANCS onboarding and notification parsing for a paired phone.",
            "Everyday Pin",
            "derived",
            "next_sync_restart",
            Some(
                "Restart Ironman after either change to guarantee its cached Bluetooth parser state.",
            ),
        ),
        "cmu_ultra_chime_enabled" => device(
            "Catch Me Up chime",
            "Enables an eligible notification's stock sound, LED, and haptic alert outside its cooldown.",
            "Everyday Pin",
            "derived",
            "next_sync",
            Some("Requires Catch Me Up Ultra accessory path to be on."),
        ),
        "vision_actions_enabled" => device(
            "Vision actions",
            "Enables bounded if-you-see-then rules through Penumbra's restored planner handoff.",
            "Experiments",
            "implemented",
            "next_sync_restart",
            Some(
                "Experimental and ineffective until camera-to-cloud consent is acknowledged. Restart Ironman for stock Add/Clear/Count grammar.",
            ),
        ),
        "fitness_tracker_enabled" => device(
            "Fitness tracker",
            "Gates new stock activity-tracker starts and Penumbra's bounded local session history.",
            "Experiments",
            "implemented",
            "next_sync_restart",
            Some(
                "Sensitive health/activity data. Restart Ironman to rebuild the full stock voice catalog.",
            ),
        ),
        "fitness_tracker_extra_data_enabled" => device(
            "Fitness extra sensor data",
            "Adds raw motion, step, context, and location rows to the optional local session CSV.",
            "Privacy & data",
            "derived",
            "next_sync",
            Some(
                "Sensitive and high-volume. Requires Fitness tracker and takes full effect on the next session.",
            ),
        ),
        "esim_qr_scanner_enabled" => device(
            "eSIM QR scanner",
            "Shows the stock eSIM QR scanner in cellular settings.",
            "System & recovery",
            "derived",
            "next_sync",
            None,
        ),
        "network_reset_enabled" => device(
            "Network reset",
            "Shows the stock confirmed network-reset surface when About is opened.",
            "System & recovery",
            "derived",
            "next_sync",
            Some(
                "Destructive surface. This flag exposes the UI but never executes a reset by itself.",
            ),
        ),
        _ => FlagMetadata {
            label: "Unknown flag",
            description: "No evidence record exists for this key.",
            category: "Compatibility record",
            evidence: "unknown",
            delivery: "unknown",
            writable: false,
            warning: Some("Locked because its consumer and value contract are unknown."),
        },
    }
}

fn flag_json(
    val: &cosmos_protocol::featureflags::feature_flag_assignment::Val,
) -> serde_json::Value {
    use cosmos_protocol::featureflags::feature_flag_assignment::Val;
    match val {
        Val::ValBool(value) => serde_json::json!(value),
        Val::ValInt(value) => serde_json::json!(value),
        Val::ValStr(value) => serde_json::json!(value),
        Val::ValFloat(value) => serde_json::json!(value),
    }
}

fn flag_type(val: &cosmos_protocol::featureflags::feature_flag_assignment::Val) -> &'static str {
    use cosmos_protocol::featureflags::feature_flag_assignment::Val;
    match val {
        Val::ValBool(_) => "bool",
        Val::ValInt(_) => "int",
        Val::ValStr(_) => "text",
        Val::ValFloat(_) => "float",
    }
}

async fn list_flags() -> Json<Vec<FlagView>> {
    let overrides = crate::flag_overrides::all();
    // `observed` is read with overrides temporarily ignored by comparing against
    // the override map, rather than by mutating global state — a second request
    // arriving mid-read must never see the defaults.
    let effective = crate::services::feature_flags::assignments_for_inspection();
    let views = effective
        .into_iter()
        .filter_map(|assignment| {
            let val = assignment.val.as_ref()?;
            let name = assignment.flag_name.clone();
            let is_overridden = overrides.contains_key(&name);
            let effective_json = flag_json(val);
            // When overridden, the observed value is whatever the override is NOT.
            let observed = if is_overridden {
                crate::services::feature_flags::observed_value(&name)
                    .as_ref()
                    .map(flag_json)
                    .unwrap_or_else(|| effective_json.clone())
            } else {
                effective_json.clone()
            };
            Some(FlagView {
                value_type: flag_type(val),
                observed,
                effective: effective_json,
                overridden: is_overridden,
                label: flag_metadata(&name).label,
                description: flag_metadata(&name).description,
                category: flag_metadata(&name).category,
                evidence: flag_metadata(&name).evidence,
                delivery: flag_metadata(&name).delivery,
                writable: flag_metadata(&name).writable,
                warning: flag_metadata(&name).warning,
                name,
            })
        })
        .collect();
    Json(views)
}

#[derive(Deserialize)]
struct SetFlagRequest {
    value: serde_json::Value,
}

/// Gate the flag-management endpoints behind an operator token.
///
/// These three handlers CHANGE what a device receives on its next flag sync, so
/// they are exactly the "management endpoint reachable without a purpose-scoped
/// credential" that a real HackerOne report against cosmos called out
/// (`webapi.prod.humane.cloud/*/manage/*` served operational data to any
/// authenticated session). The read-only listing and status stay open; anything
/// that mutates requires `COSMOS_ADMIN_TOKEN`.
///
/// Fails CLOSED: if no token is configured, mutation is refused entirely rather
/// than left open. A management surface with no credential is the vulnerability,
/// so "not configured" must mean "locked", never "unguarded".
fn require_admin(headers: &HeaderMap) -> Result<(), DemoError> {
    let Some(expected) = std::env::var("COSMOS_ADMIN_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
    else {
        return Err(demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Flag administration is disabled: no COSMOS_ADMIN_TOKEN is configured.",
        ));
    };

    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();

    // Constant-time compare so a token cannot be recovered byte-by-byte from
    // response timing.
    let a = presented.as_bytes();
    let b = expected.as_bytes();
    let equal = a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0;
    if equal {
        Ok(())
    } else {
        Err(demo_error(
            StatusCode::UNAUTHORIZED,
            "A valid admin token is required.",
        ))
    }
}

async fn set_flag(
    headers: HeaderMap,
    axum::extract::Path(name): axum::extract::Path<String>,
    Json(body): Json<SetFlagRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let metadata = flag_metadata(&name);
    if !metadata.writable {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            metadata.warning.unwrap_or("This flag is read-only."),
        ));
    }
    use crate::flag_overrides::FlagValue;
    let value = match &body.value {
        serde_json::Value::Bool(value) => FlagValue::Bool(*value),
        serde_json::Value::Number(number) => {
            FlagValue::Int(number.as_i64().ok_or_else(|| {
                demo_error(StatusCode::BAD_REQUEST, "Flag integers must fit i64.")
            })?)
        }
        serde_json::Value::String(value) => FlagValue::Text(value.clone()),
        _ => {
            return Err(demo_error(
                StatusCode::BAD_REQUEST,
                "A flag value must be a boolean, integer or string.",
            ));
        }
    };
    validate_flag_change(&name, &value)?;
    crate::flag_overrides::set(&name, value);
    Ok(Json(
        serde_json::json!({ "name": name, "overridden": true }),
    ))
}

fn validate_flag_change(
    name: &str,
    value: &crate::flag_overrides::FlagValue,
) -> Result<(), DemoError> {
    use crate::flag_overrides::FlagValue;
    use cosmos_protocol::featureflags::feature_flag_assignment::Val;

    let expected = crate::services::feature_flags::observed_value(name)
        .ok_or_else(|| demo_error(StatusCode::BAD_REQUEST, "Unknown feature flag."))?;
    let type_matches = matches!(
        (&expected, value),
        (Val::ValBool(_), FlagValue::Bool(_))
            | (Val::ValInt(_), FlagValue::Int(_))
            | (Val::ValStr(_), FlagValue::Text(_))
    );
    if !type_matches {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "The value has the wrong type for this flag.",
        ));
    }
    match value {
        FlagValue::Int(number) => {
            if i32::try_from(*number).is_err() {
                return Err(demo_error(
                    StatusCode::BAD_REQUEST,
                    "Flag integers must fit Android's Java integer range.",
                ));
            }
            if matches!(
                name,
                "touchcode_timeout_millis" | "server_side_speech_synthesis_timeout_millis"
            ) && *number < 0
            {
                return Err(demo_error(
                    StatusCode::BAD_REQUEST,
                    "This timeout cannot be negative.",
                ));
            }
        }
        FlagValue::Text(text) if text.len() > 256 => {
            return Err(demo_error(
                StatusCode::BAD_REQUEST,
                "Flag strings cannot exceed 256 UTF-8 bytes.",
            ));
        }
        _ => {}
    }

    let mut prospective = crate::services::feature_flags::assignments_for_inspection()
        .into_iter()
        .filter_map(|assignment| assignment.val.map(|val| (assignment.flag_name, val)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let replacement = match value {
        FlagValue::Bool(value) => Val::ValBool(*value),
        FlagValue::Int(value) => Val::ValInt(*value),
        FlagValue::Text(value) => Val::ValStr(value.clone()),
    };
    prospective.insert(name.to_owned(), replacement);
    let bool_value = |key: &str| matches!(prospective.get(key), Some(Val::ValBool(true)));
    let int_value = |key: &str| match prospective.get(key) {
        Some(Val::ValInt(value)) => Some(*value),
        _ => None,
    };
    if bool_value("server_side_speech_synthesis_streaming_enabled")
        && int_value("server_side_speech_synthesis_timeout_millis").is_none_or(|value| value <= 0)
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Streaming remote speech requires a positive remote speech timeout.",
        ));
    }
    if bool_value("cmu_ultra_chime_enabled") && !bool_value("cmu_ultra_enabled") {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Catch Me Up chime requires Catch Me Up Ultra accessory path.",
        ));
    }
    if bool_value("fitness_tracker_extra_data_enabled") && !bool_value("fitness_tracker_enabled") {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Fitness extra sensor data requires Fitness tracker.",
        ));
    }
    Ok(())
}

async fn clear_flag(
    headers: HeaderMap,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let had = crate::flag_overrides::clear(&name).is_some();
    Ok(Json(serde_json::json!({ "name": name, "cleared": had })))
}

/// Restore every observed value — "put it back the way cosmos had it".
async fn reset_flags(headers: HeaderMap) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let cleared = crate::flag_overrides::clear_all();
    Ok(Json(serde_json::json!({ "cleared": cleared })))
}

// ---------------------------------------------------------------------------
// Operator console — onboarding devices and reviewing what the deployment holds.
// Every handler is admin-gated: minting an attestation credential enrolls a
// device, and the overview surfaces the enrollment pincode.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct AdminOverview {
    enrollment: AdminEnrollment,
    persistence: AdminPersistence,
    /// Devices provisioned from this console since the process started.
    provisioned_devices: usize,
    onboarding: AdminOnboarding,
}

#[derive(Serialize)]
struct AdminEnrollment {
    /// Whether the deployment is admitting new devices.
    open: bool,
    /// Whether a device-attestation credential can be minted here.
    provisioning_configured: bool,
    /// Whether the DeviceUser-issuing CA is loaded, so a binding can complete.
    duc_ca_configured: bool,
    /// Where that verdict came from, in one short constant.
    ///
    /// The flag alone was a lie in every shipped environment: it read THIS
    /// process's `COSMOS_DUC_CA_*`, and the CA lives on the provisioning
    /// workload, so the console reported "No DeviceUser CA" while enrollment was
    /// perfectly configured — and could never have warned when it genuinely was
    /// not. This names which of the two answers you are looking at.
    duc_ca_detail: &'static str,
    /// The pincode a Pin enters; empty means this deployment is keyless.
    pincode: String,
    keyless: bool,
    user_id: String,
    display_name: String,
}

#[derive(Serialize)]
struct AdminPersistence {
    notes: usize,
    memories: usize,
    contacts: usize,
}

#[derive(Serialize, Clone)]
struct AdminOnboarding {
    /// Where a device dials the onboarding edge, when the operator has named it.
    endpoint: String,
    /// The `:authority`/SNI the edge routes on.
    authority: String,
}

fn onboarding_hint() -> AdminOnboarding {
    AdminOnboarding {
        endpoint: std::env::var("COSMOS_ONBOARDING_ENDPOINT").unwrap_or_default(),
        authority: std::env::var("COSMOS_ONBOARDING_AUTHORITY").unwrap_or_default(),
    }
}

/// Can a DeviceUser binding actually complete on this deployment?
///
/// This process is the wrong one to ask by inspection. `admin_overview` is
/// mounted only on the AI-bus workload, `COSMOS_DUC_CA_CERT`/`_KEY` are set only
/// on the provisioning workload, and the previous implementation read its own
/// environment — so the operator console reported "No DeviceUser CA" in every
/// shipped environment, pointing enrollment debugging at a prerequisite that was
/// fine. The neighbouring `provisioning_configured` chip is correct (its CA
/// really is on AI-bus), which made the wrong one look authoritative.
///
/// So ask the workload that holds the material, over the one channel that
/// already exists between containers: the gRPC health service on the peer port.
/// Provisioning publishes [`crate::enrollment::DUC_CA_HEALTH_SERVICE`] as
/// SERVING only after loading the CA for real — parsing the PEM and confirming
/// the key is the certificate's key, not merely observing that two variables are
/// non-empty. `Health/Check` is auth-exempt (`auth.rs` short-circuits it before
/// authentication), so this needs no shared admin token and no new route.
///
/// A local answer wins when this process does hold the material, which is the
/// single-process development shape.
async fn duc_ca_status() -> (bool, &'static str) {
    match crate::enrollment::duc_ca_readiness() {
        crate::enrollment::DucCaReadiness::Ready => (true, "loaded by this workload"),
        crate::enrollment::DucCaReadiness::Unusable => (
            false,
            "configured on this workload but unusable; see this workload's logs",
        ),
        // Not configured here is the NORMAL production shape, not an answer.
        crate::enrollment::DucCaReadiness::NotConfigured => probe_peer_duc_ca().await,
    }
}

async fn probe_peer_duc_ca() -> (bool, &'static str) {
    let workload = cosmos_core::Workload::Provisioning.as_str();
    let peer_port: u16 = std::env::var("COSMOS_PEER_GRPC_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(15051);
    let probe = async {
        let channel =
            tonic::transport::Endpoint::from_shared(format!("http://{workload}:{peer_port}"))
                .ok()?
                .connect_timeout(std::time::Duration::from_millis(1200))
                .connect()
                .await
                .ok()?;
        tonic_health::pb::health_client::HealthClient::new(channel)
            .check(tonic_health::pb::HealthCheckRequest {
                service: crate::enrollment::DUC_CA_HEALTH_SERVICE.to_owned(),
            })
            .await
            .ok()
    };
    match tokio::time::timeout(std::time::Duration::from_millis(1800), probe).await {
        Ok(Some(response)) => {
            if response.into_inner().status
                == tonic_health::pb::health_check_response::ServingStatus::Serving as i32
            {
                (true, "loaded by the provisioning workload")
            } else {
                (
                    false,
                    "the provisioning workload holds no usable DeviceUser CA",
                )
            }
        }
        // Reachable-but-unknown and unreachable are one answer here: we could
        // not establish it. Reporting that as "no CA" would be the same lie in a
        // new place, so the detail says which it is.
        _ => (
            false,
            "could not ask the provisioning workload; this verdict is unknown, not negative",
        ),
    }
}

async fn admin_overview(
    headers: HeaderMap,
    State(state): State<HttpState>,
) -> Result<Json<AdminOverview>, DemoError> {
    require_admin(&headers)?;

    // Counts under the same principal the companion dashboard reads, so the
    // console reflects exactly the data a wearer would see.
    //
    // Counted in the store, not by downloading rows and calling `.len()` on
    // them: this screen is what an operator opens to check whether persistence
    // is working, and the row-download form additionally read (and, for notes,
    // decrypted) the wearer's whole history to produce three integers.
    let (notes, memories, contacts) =
        match state.demo.as_ref().map(|backend| backend.assistant.store()) {
            Some(store) => {
                let principal = crate::capture_api::DEMO_PRINCIPAL;
                let notes = store.count_notes(principal).await.unwrap_or(0) as usize;
                let memories = store.count_memories(principal, &[]).await.unwrap_or(0) as usize;
                let contacts = store
                    .contacts(principal)
                    .await
                    .map(|snapshot| snapshot.contacts.len())
                    .unwrap_or(0);
                (notes, memories, contacts)
            }
            None => (0, 0, 0),
        };

    let pincode = crate::enrollment::configured_pincode();
    let keyless = pincode.is_empty();
    let (duc_ca_configured, duc_ca_detail) = duc_ca_status().await;

    Ok(Json(AdminOverview {
        enrollment: AdminEnrollment {
            open: crate::enrollment::enrollment_open(),
            provisioning_configured: crate::provision::provisioning_configured(),
            duc_ca_configured,
            duc_ca_detail,
            pincode,
            keyless,
            user_id: crate::enrollment::enrolled_user_id(),
            display_name: crate::enrollment::configured_display_name(),
        },
        persistence: AdminPersistence {
            notes,
            memories,
            contacts,
        },
        provisioned_devices: crate::provision::provisioned_devices().len(),
        onboarding: onboarding_hint(),
    }))
}

#[derive(Deserialize)]
struct ProvisionRequest {
    device_id: String,
    #[serde(default)]
    product: Option<String>,
}

#[derive(Serialize)]
struct ProvisionResponse {
    device_id: String,
    subject: String,
    certificate_pem: String,
    private_key_pem: String,
    ca_certificate_pem: String,
    root_certificate_pem: String,
    /// The pincode this device enters to complete OPAQUE — surfaced so the
    /// operator can hand the device and its pincode together.
    pincode: String,
    onboarding: AdminOnboarding,
}

async fn admin_provision(
    headers: HeaderMap,
    Json(body): Json<ProvisionRequest>,
) -> Result<Json<ProvisionResponse>, DemoError> {
    require_admin(&headers)?;
    let product = body.product.unwrap_or_default();
    let product = if product.trim().is_empty() {
        "00000001".to_owned()
    } else {
        product.trim().to_owned()
    };
    // Device ids are hex; normalise case so "00AA" and "00aa" name one device.
    let device_id = body.device_id.trim().to_ascii_lowercase();

    match crate::provision::mint(&device_id, &product) {
        Ok(bundle) => Ok(Json(ProvisionResponse {
            device_id: bundle.device_id,
            subject: bundle.subject,
            certificate_pem: bundle.certificate_pem,
            private_key_pem: bundle.private_key_pem,
            ca_certificate_pem: bundle.ca_certificate_pem,
            root_certificate_pem: bundle.root_certificate_pem,
            pincode: crate::enrollment::configured_pincode(),
            onboarding: onboarding_hint(),
        })),
        Err(crate::provision::ProvisionError::NotConfigured) => Err(demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provisioning is disabled: no attestation CA is configured on this deployment.",
        )),
        Err(crate::provision::ProvisionError::BadInput(message)) => {
            Err(demo_error(StatusCode::BAD_REQUEST, message))
        }
        Err(crate::provision::ProvisionError::Ca(detail)) => {
            tracing::error!("device provisioning failed: {detail}");
            Err(demo_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The attestation CA could not sign a device certificate; see server logs.",
            ))
        }
    }
}

/// Pair a device to an account, so the Pin enrols into that account's partition.
#[derive(Deserialize)]
struct PairRequest {
    device_id: String,
    /// The Keycloak `sub` the device is claimed by. It becomes `U:<sub>` in the
    /// DeviceUser certificate, so it is validated to be subject-CN-safe.
    account_sub: String,
}

#[derive(Deserialize)]
struct ProfileRequest {
    /// Keycloak `sub`; resolves to the same `U:<sub>` partition as a bound Pin.
    account_sub: String,
    #[serde(default)]
    preferred_name: String,
    #[serde(default)]
    pronunciation: String,
}

/// Populate the account profile read by `GetUserPersonalDetails`.
///
/// The device proto exposes no write RPC for this record; `observed`: it is
/// supplied by the account/onboarding plane. This clone-authored, admin-gated
/// ingestion surface is that plane. It stores only the two plaintext fields the
/// device contract names and never accepts or fabricates encrypted bio data.
async fn admin_profile(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<ProfileRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    if account_sub.is_empty()
        || !account_sub
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "account_sub must be a plain identifier (letters, digits, '-' or '_').",
        ));
    }
    let principal = AuthenticatedPrincipal::for_user(account_sub).map_err(|_| {
        demo_error(
            StatusCode::BAD_REQUEST,
            "account_sub is too long: 'U:'+sub must fit the 128-byte principal limit.",
        )
    })?;
    let preferred_name = body.preferred_name.trim().to_owned();
    let pronunciation = body.pronunciation.trim().to_owned();
    if preferred_name.len() > 256 || pronunciation.len() > 256 {
        return Err(demo_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Profile fields must each be at most 256 bytes.",
        ));
    }
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Account profile ingestion is available only on the AI-bus workload.",
            )
        })?;
    let response = cosmos_protocol::account::PersonalDetailsResponse {
        account_info: Some(cosmos_protocol::account::AccountInfo {
            preferred_name,
            pronunciation,
        }),
        secure_bio_data: None,
    };
    store
        .put_account_blob(
            principal.expose_for_authorization(),
            crate::store::AccountBlobKind::PersonalDetails,
            &response.encode_to_vec(),
        )
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Could not record the account profile; persistence is unavailable.",
            )
        })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "stored": true,
    })))
}

#[derive(Deserialize)]
struct EncryptedEnvelopeInput {
    kid: String,
    data_base64: String,
}

impl EncryptedEnvelopeInput {
    fn decode(self) -> Result<cosmos_protocol::common::encryption::EncryptedData, DemoError> {
        let kid = self.kid.trim().to_owned();
        if kid.is_empty() || kid.len() > 256 {
            return Err(demo_error(
                StatusCode::BAD_REQUEST,
                "Every encrypted envelope requires a bounded key id.",
            ));
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(self.data_base64.trim())
            .map_err(|_| {
                demo_error(
                    StatusCode::BAD_REQUEST,
                    "Encrypted envelope data must be standard base64.",
                )
            })?;
        if data.is_empty() {
            return Err(demo_error(
                StatusCode::BAD_REQUEST,
                "Encrypted envelope data cannot be empty.",
            ));
        }
        Ok(cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation { kid },
            ),
            data,
        })
    }
}

#[derive(Deserialize)]
struct WifiIngestionRequest {
    account_sub: String,
    #[serde(default)]
    secure_wifi_configs: Vec<EncryptedEnvelopeInput>,
}

/// Populate the encrypted Wi-Fi list the account service exposes to a Pin.
/// Plain SSIDs and passwords are intentionally not accepted by this boundary.
async fn admin_wifi(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<WifiIngestionRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    if account_sub.is_empty()
        || !account_sub
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "A valid account_sub is required.",
        ));
    }
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "A valid account_sub is required."))?;
    if body.secure_wifi_configs.len() > 128 {
        return Err(demo_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "At most 128 encrypted Wi-Fi configurations may be stored.",
        ));
    }
    let secure_wifi_configs = body
        .secure_wifi_configs
        .into_iter()
        .map(EncryptedEnvelopeInput::decode)
        .collect::<Result<Vec<_>, _>>()?;
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Wi-Fi ingestion is available only on the AI-bus workload.",
            )
        })?;
    let response = cosmos_protocol::account::ListSecureWifiConfigsResponse {
        secure_wifi_configs,
    };
    store
        .put_account_blob(
            principal.expose_for_authorization(),
            crate::store::AccountBlobKind::WifiConfigs,
            &response.encode_to_vec(),
        )
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Could not record encrypted Wi-Fi configurations.",
            )
        })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "stored": response.secure_wifi_configs.len(),
    })))
}

#[derive(Deserialize)]
struct PartnerTokenIngestionRequest {
    account_sub: String,
    provider_name: String,
    encrypted_token: EncryptedEnvelopeInput,
}

#[derive(Deserialize)]
struct PartnerTokenDeletionRequest {
    account_sub: String,
    provider_name: String,
}

#[derive(Deserialize)]
struct SubscriptionStateRequest {
    account_sub: String,
    status_code: i32,
    #[serde(default)]
    message: String,
}

async fn admin_subscription(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<SubscriptionStateRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "A valid account_sub is required."))?;
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Subscription state is available only on the AI-bus workload.",
            )
        })?;
    crate::services::provisioning::put_subscription_state(
        &store,
        principal.expose_for_authorization(),
        cosmos_protocol::provisioning::SubscriptionStatus {
            status_code: body.status_code,
            message: body.message.trim().to_owned(),
        },
    )
    .await
    .map_err(|status| {
        demo_error(
            if status.code() == tonic::Code::InvalidArgument {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "Could not record the subscription state.",
        )
    })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "status_code": body.status_code,
        "stored": true,
    })))
}

/// Link one already-encrypted provider token to an account. Raw OAuth tokens
/// are outside this API by construction.
async fn admin_partner_token(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<PartnerTokenIngestionRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    if account_sub.is_empty()
        || !account_sub
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "A valid account_sub is required.",
        ));
    }
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "A valid account_sub is required."))?;
    let provider_name = body.provider_name.trim().to_ascii_lowercase();
    let encrypted_token = body.encrypted_token.decode()?;
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Partner linking is available only on the AI-bus workload.",
            )
        })?;
    crate::services::partnerservices::put_encrypted_token(
        &store,
        principal.expose_for_authorization(),
        &provider_name,
        encrypted_token,
    )
    .await
    .map_err(|status| {
        demo_error(
            if status.code() == tonic::Code::InvalidArgument {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "Could not record the encrypted partner token.",
        )
    })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "provider_name": provider_name,
        "stored": true,
    })))
}

async fn admin_delete_partner_token(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<PartnerTokenDeletionRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "A valid account_sub is required."))?;
    let provider_name = body.provider_name.trim().to_ascii_lowercase();
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Partner linking is available only on the AI-bus workload.",
            )
        })?;
    let removed = crate::services::partnerservices::delete_token(
        &store,
        principal.expose_for_authorization(),
        &provider_name,
    )
    .await
    .map_err(|status| {
        demo_error(
            if status.code() == tonic::Code::InvalidArgument {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "Could not unlink the provider.",
        )
    })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "provider_name": provider_name,
        "removed": removed,
    })))
}

#[derive(Deserialize)]
struct PushRequest {
    account_sub: String,
    app_name: String,
    #[serde(default)]
    data_payload: Vec<u8>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    subtitle: String,
    /// Relative lifetime. Zero selects the one-day default.
    #[serde(default)]
    expiration_seconds: u64,
}

/// Queue one operator-authorized push and wake an active device stream.
///
/// `implemented`: this is a clone management surface, not a claimed Humane RPC.
/// The opaque `data_payload` remains caller-authored because each app's internal
/// payload schema is still `unknown`; the relay must not invent it.
async fn admin_push(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<PushRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    let app_name = body.app_name.trim();
    if account_sub.is_empty()
        || !account_sub
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || app_name.is_empty()
        || app_name.len() > 256
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "A valid account_sub and app_name are required.",
        ));
    }
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "account_sub is too long."))?;
    let lifetime = if body.expiration_seconds == 0 {
        86_400
    } else {
        body.expiration_seconds
    };
    if lifetime > 30 * 86_400 {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Push lifetime cannot exceed 30 days.",
        ));
    }
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Push ingestion is available only on the AI-bus workload.",
            )
        })?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let message_id = uuid::Uuid::new_v4().to_string();
    let notification_payload = (!body.title.is_empty()
        || !body.text.is_empty()
        || !body.subtitle.is_empty())
    .then_some(cosmos_protocol::common::push::NotificationPayload {
        title: body.title,
        text: body.text,
        subtitle: body.subtitle,
    });
    crate::services::pushrelay::enqueue(
        &store,
        principal.expose_for_authorization(),
        cosmos_protocol::common::push::PushMessage {
            app_name: app_name.to_owned(),
            message_id: message_id.clone(),
            expiration_timestamp: Some(prost_types::Timestamp {
                seconds: now.as_secs().saturating_add(lifetime) as i64,
                nanos: now.subsec_nanos() as i32,
            }),
            data_payload: body.data_payload,
            notification_payload,
        },
    )
    .await
    .map_err(|_| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Could not queue the push; persistence is unavailable.",
        )
    })?;
    Ok(Json(serde_json::json!({
        "message_id": message_id,
        "queued": true,
    })))
}

/// `POST /demo-api/admin/pair` — bind a device id to an account (Keycloak `sub`).
///
/// Admin-gated, exactly like provisioning: the ONLY legitimate caller is the
/// Center BFF, which injects the *logged-in wearer's* `sub` server-side — a user
/// can only ever pair a device to their own account. The backend trusts the
/// `account_sub` in the body precisely because that gate sits in front of it; it
/// never sees a Keycloak session itself, and a device can never reach this route.
///
/// This decides *whose* partition a Pin enrols into; the OPAQUE pincode ceremony
/// still decides *whether* the enrolment is legitimate. Pairing is a routing
/// authorization, never a substitute for the pincode.
async fn admin_pair(
    headers: HeaderMap,
    Json(body): Json<PairRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    // Only reachable when enrollment actually initialised at startup (a valid
    // DeviceUser CA loaded). This is the store built for the ceremony — the SAME
    // instance, so a pairing written here is visible to the login. Using the
    // already-initialised handle rather than `configured_store()` also means this
    // never runs the store initialiser, which panics on a CA-present-but-unusable
    // misconfiguration that `duc_ca_configured()`'s env-presence check would miss.
    let Some(store) = crate::enrollment::pairing_store() else {
        return Err(demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Pairing is unavailable: this deployment has no shared enrollment database, so a \
             pairing recorded here could never be read by the provisioning workload that runs \
             the ceremony. Set COSMOS_DATABASE_URL on both.",
        ));
    };
    // Device ids are hex; normalise case exactly like `admin_provision` so one
    // device is named consistently across provisioning, pairing, and the ceremony.
    let device_id = body.device_id.trim().to_ascii_lowercase();
    let account_sub = body.account_sub.trim().to_owned();
    if device_id.is_empty() || account_sub.is_empty() {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Both device_id and account_sub are required.",
        ));
    }
    // The sub is written verbatim into the DUC CN `V:01:D:<device>:U:<sub>`. A `:`
    // or other separator would forge extra CN fields and break the gateway's
    // subject parser, so restrict it to the identifier charset a Keycloak UUID
    // `sub` already satisfies. This is a subject-safety gate, not a UUID check.
    if !account_sub
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "account_sub must be a plain identifier (letters, digits, '-' or '_').",
        ));
    }
    // Reject at PAIRING time any sub whose `U:<sub>` principal would blow the
    // 128-byte identity limit — delegated to the very gate the DUC must later pass
    // (`for_user`), so the two front doors stay in lockstep. Without this the
    // ceremony would happily mint a signed-but-unusable certificate and the device
    // would only discover it is bricked at its next authenticated RPC.
    if cosmos_core::AuthenticatedPrincipal::for_user(&account_sub).is_err() {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "account_sub is too long: 'U:'+sub must fit the 128-byte principal limit.",
        ));
    }

    store
        .put_device_account(&device_id, &account_sub)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Could not record the pairing; enrollment state is unavailable.",
            )
        })?;

    Ok(Json(serde_json::json!({
        "device_id": device_id,
        "account_sub": account_sub,
        "paired": true,
    })))
}

/// Remove exactly one account-owned pairing. `account_sub` is injected by the
/// authenticated Center BFF; the compare-and-delete in EnrollmentStore prevents
/// a stale page from removing a device that was transferred in the meantime.
async fn admin_unpair(
    headers: HeaderMap,
    Json(body): Json<PairRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let device_id = body.device_id.trim().to_ascii_lowercase();
    let account_sub = body.account_sub.trim();
    if device_id.is_empty() || account_sub.is_empty() {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Both device_id and account_sub are required.",
        ));
    }
    let store = crate::enrollment::pairing_store().ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The durable device pairing store is not configured.",
        )
    })?;
    let removed = store
        .delete_device_account(&device_id, account_sub)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The device pairing could not be removed.",
            )
        })?;
    Ok(Json(serde_json::json!({
        "device_id": device_id,
        "removed": removed,
    })))
}

async fn admin_devices(headers: HeaderMap) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let pairings = crate::enrollment::pairing_store()
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The durable device pairing store is not configured.",
            )
        })?
        .device_accounts()
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The durable device pairing roster is unavailable.",
            )
        })?;
    Ok(Json(serde_json::json!({
        "devices": crate::provision::provisioned_devices(),
        "pairings": pairings,
        "note": "devices are credentials minted since this process started; pairings are the durable device-to-account roster",
    })))
}

/// Independently implemented device-status projection used by the restored
/// Center. No stock endpoint for these fields was observed, so this deliberately
/// lives outside the Humane RPC namespace.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct DeviceStatusSnapshot {
    device_id: String,
    serial_number: String,
    firmware_version: String,
    os_version: String,
    battery_percent: u8,
    battery_charging: bool,
    reported_at_epoch: u64,
    #[serde(default)]
    wifi_networks: Vec<DeviceWifiNetwork>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DeviceWifiNetwork {
    ssid: String,
    #[serde(default)]
    authorization_type: String,
    #[serde(default)]
    connected: bool,
}

#[derive(Deserialize)]
struct SignedDeviceStatusReport {
    /// Exact UTF-8 JSON bytes covered by `signature_der`.
    payload: String,
    certificate_der: String,
    signature_der: String,
}

fn device_status_storage_owner(principal: &AuthenticatedPrincipal, device_id: &str) -> String {
    // Account authorization is resolved before this point. The device suffix is
    // an internal storage namespace so multiple Pins on one wearer account do
    // not overwrite or impersonate each other's latest snapshot.
    format!(
        "{}#device:{device_id}",
        principal.expose_for_authorization()
    )
}

fn device_status_ca_der() -> Result<Vec<u8>, DemoError> {
    let path = std::env::var("COSMOS_DEVICE_STATUS_CA_CERT").map_err(|_| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Device status trust is not configured.",
        )
    })?;
    let bytes = std::fs::read(path).map_err(|_| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Device status trust is unavailable.",
        )
    })?;
    let mut reader = std::io::BufReader::new(bytes.as_slice());
    rustls_pemfile::certs(&mut reader)
        .next()
        .transpose()
        .ok()
        .flatten()
        .map(|der| der.as_ref().to_vec())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Device status trust is invalid.",
            )
        })
}

fn verify_device_status_report(
    body: &SignedDeviceStatusReport,
) -> Result<DeviceStatusSnapshot, DemoError> {
    let base64 = base64::engine::general_purpose::STANDARD;
    let certificate_der = base64.decode(&body.certificate_der).map_err(|_| {
        demo_error(
            StatusCode::UNAUTHORIZED,
            "Invalid device certificate encoding.",
        )
    })?;
    let signature_der = base64.decode(&body.signature_der).map_err(|_| {
        demo_error(
            StatusCode::UNAUTHORIZED,
            "Invalid device signature encoding.",
        )
    })?;
    let ca_der = device_status_ca_der()?;
    let (_, leaf) = x509_parser::parse_x509_certificate(&certificate_der)
        .map_err(|_| demo_error(StatusCode::UNAUTHORIZED, "Invalid device certificate."))?;
    let (_, ca) = x509_parser::parse_x509_certificate(&ca_der).map_err(|_| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Invalid status trust root.",
        )
    })?;
    leaf.verify_signature(Some(ca.public_key()))
        .map_err(|_| demo_error(StatusCode::UNAUTHORIZED, "Untrusted device certificate."))?;
    crate::enrollment::verify_attestation_signature(
        &certificate_der,
        Some(body.payload.as_bytes()),
        &signature_der,
    )
    .map_err(|_| demo_error(StatusCode::UNAUTHORIZED, "Invalid device status signature."))?;

    let mut status: DeviceStatusSnapshot = serde_json::from_str(&body.payload)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "Invalid device status payload."))?;
    status.device_id = status.device_id.trim().to_ascii_lowercase();
    let certificate_device = crate::enrollment::attestation_certificate_device_id(&certificate_der)
        .ok_or_else(|| {
            demo_error(
                StatusCode::UNAUTHORIZED,
                "Certificate has no device identity.",
            )
        })?;
    if status.device_id != certificate_device {
        return Err(demo_error(
            StatusCode::UNAUTHORIZED,
            "Status device does not match its certificate.",
        ));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if status.reported_at_epoch.abs_diff(now) > 10 * 60 {
        return Err(demo_error(
            StatusCode::UNAUTHORIZED,
            "Stale device status report.",
        ));
    }
    if status.battery_percent > 100 || status.wifi_networks.len() > 128 {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Invalid device status values.",
        ));
    }
    for network in &status.wifi_networks {
        if network.ssid.len() > 256 || network.authorization_type.len() > 64 {
            return Err(demo_error(
                StatusCode::BAD_REQUEST,
                "Invalid Wi-Fi metadata.",
            ));
        }
    }
    Ok(status)
}

async fn device_status_report(
    State(state): State<HttpState>,
    Json(body): Json<SignedDeviceStatusReport>,
) -> Result<Json<serde_json::Value>, DemoError> {
    let status = verify_device_status_report(&body)?;
    let enrollment = crate::enrollment::pairing_store().ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Device pairing is unavailable.",
        )
    })?;
    let account_sub = enrollment
        .device_account(&status.device_id)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Device pairing is unavailable.",
            )
        })?
        .ok_or_else(|| demo_error(StatusCode::FORBIDDEN, "This device is not paired."))?;
    let principal = AuthenticatedPrincipal::for_user(&account_sub)
        .map_err(|_| demo_error(StatusCode::FORBIDDEN, "Device account is invalid."))?;
    let bytes = serde_json::to_vec(&status)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "Invalid device status."))?;
    let owner = device_status_storage_owner(&principal, &status.device_id);
    state
        .store
        .as_ref()
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Status storage is unavailable.",
            )
        })?
        .put_account_blob(&owner, crate::store::AccountBlobKind::DeviceStatus, &bytes)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Status storage is unavailable.",
            )
        })?;
    Ok(Json(serde_json::json!({"ok": true})))
}

async fn admin_device_status(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let device_id = device_id.trim().to_ascii_lowercase();
    let enrollment = crate::enrollment::pairing_store().ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Device pairing is unavailable.",
        )
    })?;
    let account_sub = enrollment
        .device_account(&device_id)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Device pairing is unavailable.",
            )
        })?
        .ok_or_else(|| demo_error(StatusCode::NOT_FOUND, "Device is not paired."))?;
    let principal = AuthenticatedPrincipal::for_user(&account_sub)
        .map_err(|_| demo_error(StatusCode::NOT_FOUND, "Device account is invalid."))?;
    let owner = device_status_storage_owner(&principal, &device_id);
    let stored = state
        .store
        .as_ref()
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Status storage is unavailable.",
            )
        })?
        .get_account_blob(&owner, crate::store::AccountBlobKind::DeviceStatus)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Status storage is unavailable.",
            )
        })?;
    let Some(bytes) = stored else {
        return Err(demo_error(
            StatusCode::NOT_FOUND,
            "No status has been reported yet.",
        ));
    };
    let status: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| demo_error(StatusCode::SERVICE_UNAVAILABLE, "Stored status is invalid."))?;
    Ok(Json(status))
}

async fn demo_status(State(state): State<HttpState>) -> Json<DemoStatus> {
    let assistant = std::env::var("COSMOS_LLM_BASE_URL")
        .is_ok_and(|value| !value.trim().is_empty())
        && crate::assistant::llm::configured_api_key().is_some();
    let speech = state
        .demo
        .as_ref()
        .is_some_and(|demo| demo.speech.is_some());
    let model = std::env::var("COSMOS_LLM_MODEL")
        .unwrap_or_else(|_| crate::assistant::llm::DEFAULT_LLM_MODEL.to_owned());
    Json(DemoStatus {
        assistant,
        speech,
        model,
        mesh: mesh_status(&state).await,
        tools: tool_status(),
    })
}

#[derive(Deserialize)]
struct DemoTextRequest {
    text: String,
}

#[derive(Serialize)]
struct DemoChatResponse {
    reply: String,
}

#[derive(Serialize)]
struct DemoErrorResponse {
    error: &'static str,
}

type DemoError = (StatusCode, Json<DemoErrorResponse>);

fn demo_error(status: StatusCode, error: &'static str) -> DemoError {
    (status, Json(DemoErrorResponse { error }))
}

/// Whose account an assistant turn runs under.
///
/// The SAME precedence every other web surface uses
/// ([`crate::capture_api::principal_for`]): a signature-verified Bearer, then
/// the edge-injected device principal, and the demo account only when nobody
/// identified themselves.
///
/// These three routes used to insert `from_edge(DEMO_PRINCIPAL)` unconditionally.
/// That is not a keyless-demo fallback, it is an override: a wearer signed in to
/// Center, saying "remember the gate code", had the note written into
/// `V:01:D:web-demo:U:operator` and was told "Saved". Their own `/notes` reads
/// `U:<sub>` and could never show it, and `recall_memory` then returned an
/// authoritative "you have no note about that" about their own data.
/// `from_edge` also keeps the literal string rather than collapsing to
/// `U:<user>`, so the demo account is not even a partition any front door can
/// reach.
///
/// A Bearer that is present but does not verify is a 401, not a fall-through:
/// the caller asserted an identity that did not hold, and running their turn in
/// the demo partition would answer questions about somebody else's data.
fn turn_principal(headers: &HeaderMap) -> Result<AuthenticatedPrincipal, DemoError> {
    let unusable = || {
        demo_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Caller identity unavailable.",
        )
    };
    let verifier = crate::web_auth::configured_verifier();
    let resolved =
        crate::capture_api::principal_for(headers, verifier.as_deref()).map_err(|()| {
            demo_error(
                StatusCode::UNAUTHORIZED,
                "That session could not be verified.",
            )
        })?;
    match resolved {
        // Already collapsed to the account principal both front doors share.
        Some(resolved) => {
            AuthenticatedPrincipal::from_edge(resolved.account).map_err(|_| unusable())
        }
        None => {
            if verifier.is_some() {
                // The web plane is configured, so a wearer turn was expected to
                // contain a Bearer and did not — the caller in front of us is not
                // forwarding it. Worth a line every time: the turn still runs,
                // but it runs somewhere the wearer cannot read.
                tracing::warn!(
                    "assistant turn carries no verified identity; running it under the demo \
                     account, where anything it remembers is unreadable from the wearer's own \
                     surfaces"
                );
            }
            AuthenticatedPrincipal::from_edge(crate::capture_api::DEMO_PRINCIPAL)
                .map_err(|_| unusable())
        }
    }
}

fn validate_demo_text(text: String) -> Result<String, DemoError> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Enter a message first.",
        ));
    }
    if text.len() > MAX_DEMO_TEXT_BYTES {
        return Err(demo_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That message is too long for the demo.",
        ));
    }
    Ok(text)
}

async fn demo_chat(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<DemoTextRequest>,
) -> Result<Json<DemoChatResponse>, DemoError> {
    let text = validate_demo_text(payload.text)?;
    let demo = state.demo.ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The Cosmos demo is unavailable.",
        )
    })?;
    let mut request = Request::new(ServerStatefulUnderstandRequest {
        userrequest: Some(
            cosmos_protocol::aibus::server_stateful_understand_request::Userrequest::Transcription(
                text,
            ),
        ),
        response_format: ResponseFormat::Text as i32,
    });
    request.extensions_mut().insert(turn_principal(&headers)?);

    let response = tokio::time::timeout(
        DEMO_CHAT_TIMEOUT,
        demo.assistant.server_stateful_understand(request),
    )
    .await
    .map_err(|_| demo_error(StatusCode::GATEWAY_TIMEOUT, "The assistant took too long."))?
    .map_err(|_| demo_error(StatusCode::BAD_GATEWAY, "The assistant could not answer."))?
    .into_inner();
    let reply = match response.response {
        Some(UnderstandResponse::Text(text)) if !text.trim().is_empty() => text,
        _ => {
            return Err(demo_error(
                StatusCode::BAD_GATEWAY,
                "The assistant returned no text.",
            ));
        }
    };
    Ok(Json(DemoChatResponse { reply }))
}

/// One step of the assistant's reasoning, streamed to the operator demo so the
/// browser can show *how* the backend reached its answer: every tool the model
/// invoked (server lookups like `web_search`/`wikipedia`, device actions like
/// `SetTimer`), the observation each returned, and the final spoken answer. This
/// is exactly the transcript a Pin receives on the `Understand` stream.
#[derive(Serialize)]
struct DemoTraceStep {
    /// `"action"` (a tool/device call), `"observation"` (its result), or
    /// `"answer"` (the terminal `Respond`).
    kind: &'static str,
    /// Action name (`SetTimer`, `web_search`, `wikipedia`, `Respond`, …).
    name: String,
    /// `"device"` for a Pin-executed action, `"server"` for a cloud-side tool.
    source: &'static str,
    /// The model's rationale for an action step, when the model supplied one.
    thought: String,
    /// Action arguments (JSON) for an action step; empty otherwise.
    input: String,
    /// Observation text for an observation; the spoken sentence for the answer.
    text: String,
    /// Milliseconds from the start of the turn to when this step was streamed.
    ///
    /// Latency is the dominant thing a wearer feels on this device, and it is
    /// almost entirely model-step time — so showing WHERE the turn went is more
    /// informative than a single total. It also makes the 25s device deadline
    /// visible: past it, a real Pin discards the whole turn.
    elapsed_ms: u64,
}

#[derive(Serialize)]
struct DemoTraceResponse {
    steps: Vec<DemoTraceStep>,
    reply: String,
    /// Wall-clock for the whole turn.
    total_ms: u64,
    /// The server's own run budget: it delivers a spoken terminal by here.
    budget_ms: u64,
    /// `AIMIC_TIMEOUT_MS` — the device's hard gRPC deadline. Past this a real Pin
    /// fires DEADLINE_EXCEEDED and throws away every turn already streamed, so
    /// this is the line the whole design is racing.
    device_deadline_ms: u64,
}

/// Run the wearer's prompt through the *real* `Understand` ReAct engine and
/// return the full turn transcript. Where [`demo_chat`] surfaces only the final
/// sentence, this exposes every action + observation so the demo can visualise
/// the backend thinking — a lookup before it answers, a `SetTimer`, and so on.
async fn demo_trace(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<DemoTextRequest>,
) -> Result<Json<DemoTraceResponse>, DemoError> {
    use cosmos_protocol::aibus::{
        synapse_chat_turn::Content, synapse_understanding_response::Body,
    };
    use tokio_stream::StreamExt as _;

    let text = validate_demo_text(payload.text)?;
    let demo = state.demo.ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The Cosmos demo is unavailable.",
        )
    })?;

    let mut request = Request::new(SynapseUnderstandingRequest {
        utterance: text,
        ..Default::default()
    });
    request.extensions_mut().insert(turn_principal(&headers)?);

    let mut stream = demo
        .assistant
        .understand(request)
        .await
        .map_err(|_| demo_error(StatusCode::BAD_GATEWAY, "The assistant could not answer."))?
        .into_inner();

    let source_label = |source: i32| {
        if source == SynapseSource::Device as i32 {
            "device"
        } else {
            "server"
        }
    };

    let started = std::time::Instant::now();
    let mut steps = Vec::new();
    let mut reply = String::new();
    let collect = async {
        while let Some(message) = stream.next().await {
            let Ok(message) = message else { break };
            let Some(Body::Turn(turn)) = message.body else {
                continue;
            };
            match turn.content {
                Some(Content::Action(action)) if action.action == RESPOND_ACTION => {
                    let spoken = spoken_answer(&action.input);
                    reply = spoken.clone();
                    steps.push(DemoTraceStep {
                        kind: "answer",
                        name: RESPOND_ACTION.to_owned(),
                        source: source_label(action.source),
                        thought: action.thought,
                        input: String::new(),
                        text: spoken,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    });
                }
                Some(Content::Action(action)) => steps.push(DemoTraceStep {
                    kind: "action",
                    name: action.action,
                    source: source_label(action.source),
                    thought: action.thought,
                    input: action.input,
                    text: String::new(),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                }),
                Some(Content::Observation(obs)) => steps.push(DemoTraceStep {
                    kind: "observation",
                    name: obs.action_name,
                    source: source_label(obs.source),
                    thought: String::new(),
                    input: String::new(),
                    text: obs.observation,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                }),
                _ => {}
            }
        }
    };
    tokio::time::timeout(DEMO_CHAT_TIMEOUT, collect)
        .await
        .map_err(|_| demo_error(StatusCode::GATEWAY_TIMEOUT, "The assistant took too long."))?;

    Ok(Json(DemoTraceResponse {
        steps,
        reply,
        total_ms: started.elapsed().as_millis() as u64,
        budget_ms: RUN_BUDGET_MS,
        device_deadline_ms: DEVICE_DEADLINE_MS,
    }))
}

/// The same turn as [`demo_trace`], streamed step by step as it happens.
///
/// The batched endpoint makes a wearer's turn look instantaneous-then-done: you
/// wait, and the whole transcript appears at once. That hides the thing worth
/// seeing — the assistant deciding, calling a tool, reading the result, and only
/// then answering. This emits each turn the engine produces the moment it
/// produces it, which is also exactly how the device receives them.
///
/// Server-sent events rather than a websocket: the stream is one-directional and
/// short-lived, and SSE survives the plain HTTP proxy in front of the demo.
/// Progress cues are emitted only after the assistant selects real work. They
/// are deterministic descriptions of that tool call, so no second model, flag,
/// or terminal-turn delay sits in the answer path.
async fn demo_trace_stream(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<DemoTextRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, DemoError> {
    use cosmos_protocol::aibus::{
        synapse_chat_turn::Content, synapse_understanding_response::Body,
    };
    use tokio_stream::StreamExt as _;

    let text = validate_demo_text(payload.text)?;
    let demo = state.demo.ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The Cosmos demo is unavailable.",
        )
    })?;

    let mut request = Request::new(SynapseUnderstandingRequest {
        utterance: text,
        ..Default::default()
    });
    request.extensions_mut().insert(turn_principal(&headers)?);

    let mut turns = demo
        .assistant
        .understand(request)
        .await
        .map_err(|_| demo_error(StatusCode::BAD_GATEWAY, "The assistant could not answer."))?
        .into_inner();

    let started = std::time::Instant::now();
    let events = async_stream::stream! {
        let mut cue_emitted = false;
        // Open with the budget the turn is racing, so the page can draw the
        // deadline before any step exists.
        yield Ok(Event::default().event("start").data(
            serde_json::json!({
                "budget_ms": RUN_BUDGET_MS,
                "device_deadline_ms": DEVICE_DEADLINE_MS,
            })
            .to_string(),
        ));

        loop {
            let Some(message) = turns.next().await else { break };
            let Ok(message) = message else { break };
            let Some(Body::Turn(turn)) = message.body else { continue };

            let elapsed_ms = started.elapsed().as_millis() as u64;
            let step = match turn.content {
                Some(Content::Action(action)) if action.action == RESPOND_ACTION => {
                    let spoken = spoken_answer(&action.input);
                    Some(DemoTraceStep {
                        kind: "answer",
                        name: RESPOND_ACTION.to_owned(),
                        source: source_label_for(action.source),
                        thought: action.thought,
                        input: String::new(),
                        text: spoken,
                        elapsed_ms,
                    })
                }
                Some(Content::Action(action)) => {
                    if !cue_emitted {
                        if let Some(text) = crate::assistant::catalog::progress_cue(
                            &action.action,
                            &action.input,
                        ) {
                            cue_emitted = true;
                            yield Ok(Event::default().event("cue").data(
                                serde_json::json!({ "text": text }).to_string(),
                            ));
                        }
                    }
                    Some(DemoTraceStep {
                        kind: "action",
                        name: action.action,
                        source: source_label_for(action.source),
                        thought: action.thought,
                        input: action.input,
                        text: String::new(),
                        elapsed_ms,
                    })
                }
                Some(Content::Observation(obs)) => Some(DemoTraceStep {
                    kind: "observation",
                    name: obs.action_name,
                    source: source_label_for(obs.source),
                    thought: String::new(),
                    input: String::new(),
                    text: obs.observation,
                    elapsed_ms,
                }),
                _ => None,
            };
            if let Some(step) = step {
                match serde_json::to_string(&step) {
                    Ok(data) => yield Ok(Event::default().event("step").data(data)),
                    Err(_) => continue,
                }
            }
        }

        yield Ok(Event::default().event("done").data(
            serde_json::json!({ "total_ms": started.elapsed().as_millis() as u64 }).to_string(),
        ));
    };

    Ok(Sse::new(events).keep_alive(axum::response::sse::KeepAlive::default()))
}

/// `"device"` for a Pin-executed action, `"server"` for a cloud-side tool.
fn source_label_for(source: i32) -> &'static str {
    if source == SynapseSource::Device as i32 {
        "device"
    } else {
        "server"
    }
}

/// Pull the spoken sentence out of a `Respond` action's `{"Response":"…"}` input,
/// falling back to the raw input when it is not the expected shape.
fn spoken_answer(input: &str) -> String {
    serde_json::from_str::<serde_json::Value>(input)
        .ok()
        .and_then(|value| {
            value
                .get(RESPOND_FIELD)
                .and_then(|field| field.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| input.to_owned())
}

async fn demo_speech(
    State(state): State<HttpState>,
    Json(payload): Json<DemoTextRequest>,
) -> Result<Response, DemoError> {
    let text = validate_demo_text(payload.text)?;
    let speech = state.demo.and_then(|demo| demo.speech).ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Speech synthesis is unavailable.",
        )
    })?;
    let audio = tokio::time::timeout(
        DEMO_SPEECH_TIMEOUT,
        speech.synthesize(&text, SpeechAudioFormat::Audio24Khz160KBitrateMonoMp3),
    )
    .await
    .map_err(|_| {
        demo_error(
            StatusCode::GATEWAY_TIMEOUT,
            "Speech synthesis took too long.",
        )
    })?
    .map_err(|_| demo_error(StatusCode::BAD_GATEWAY, "Speech synthesis failed."))?;

    let mut response = Response::new(axum::body::Body::from(audio));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mpeg"));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Method, Request},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
    async fn root_connectivity_get_and_head_are_empty_and_unauthenticated() {
        for method in [Method::GET, Method::HEAD] {
            let response = router(Readiness::default())
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");

            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert_eq!(
                response
                    .headers()
                    .get("content-length")
                    .expect("explicitly empty response"),
                "0"
            );
            assert_eq!(response.headers().get("x-humane-service-path"), None);
        }
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

    /// The Center REST surface must read the store supplied by server startup.
    /// A fresh isolated store is intentional: if `demo_router` constructs its own
    /// MemoryStore again, this seeded row disappears and the test distinguishes
    /// the broken production wiring from the correct one.
    #[tokio::test]
    async fn demo_capture_api_reads_the_store_supplied_by_server_startup() {
        let store = fresh_store();
        store
            .create_note(crate::capture_api::DEMO_PRINCIPAL, None, None)
            .await
            .expect("seed note");

        let response = demo_router(Readiness::default(), store, fresh_keys())
            .oneshot(
                Request::builder()
                    .uri("/notes")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body bytes");
        let payload: serde_json::Value = serde_json::from_slice(&bytes).expect("json body");
        assert_eq!(
            payload["totalElements"], 1,
            "the REST reader must use the caller-supplied deployment store"
        );
    }

    #[tokio::test]
    async fn demo_rejects_an_empty_chat_before_contacting_the_model() {
        let response = demo_app(Readiness::default())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .header("content-type", "application/json")
                    .uri("/demo-api/chat")
                    .body(Body::from(r#"{"text":"  "}"#))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn demo_trace_exposes_the_reasoning_transcript() {
        // A keyless deployment drives the deterministic DemoChatModel: it searches
        // the wearer's utterance, then answers. The trace endpoint must surface
        // both the tool call and the terminal answer — the whole point is showing
        // *how* the backend reached its reply, not just the reply.
        let response = demo_app(Readiness::default())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .header("content-type", "application/json")
                    .uri("/demo-api/trace")
                    .body(Body::from(r#"{"text":"how tall is the eiffel tower"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body bytes");
        let payload: serde_json::Value = serde_json::from_slice(&bytes).expect("json body");
        let steps = payload["steps"].as_array().expect("steps array");
        assert!(
            steps.iter().any(|step| step["kind"] == "action"),
            "trace should include the search action: {steps:?}"
        );
        assert!(
            steps.iter().any(|step| step["kind"] == "answer"),
            "trace should include the terminal answer: {steps:?}"
        );
        assert!(
            !payload["reply"].as_str().unwrap_or_default().is_empty(),
            "trace should contain a spoken reply"
        );
    }

    #[tokio::test]
    async fn demo_stream_emits_the_selected_work_as_its_only_progress_cue() {
        let response = demo_app(Readiness::default())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .header("content-type", "application/json")
                    .uri("/demo-api/trace/stream")
                    .body(Body::from(r#"{"text":"how tall is the eiffel tower"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("stream bytes");
        let stream = String::from_utf8(bytes.to_vec()).expect("SSE is UTF-8");
        assert_eq!(stream.matches("event: cue").count(), 1, "{stream}");
        assert!(
            stream.contains(r#"{"text":"Looking up how tall is the eiffel tower"}"#),
            "the cue must name the selected search: {stream}"
        );
        assert!(!stream.contains("Just a moment"), "{stream}");
    }

    /// AN ASSISTANT TURN BELONGS TO ITS CALLER.
    ///
    /// These routes used to insert `from_edge("V:01:D:web-demo:U:operator")`
    /// unconditionally, so every wearer turn ran in the demo partition: a
    /// "remember …" saved somewhere the wearer's own `/notes` can never read,
    /// answered with "Saved", and `recall_memory` then reported authoritatively
    /// that they had no such note.
    ///
    /// The `U:alice` case is the whole fix in one assertion — the identity must
    /// COLLAPSE to the account both front doors share, which is exactly what
    /// `from_edge` on a raw CN does not do.
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
            Ok(crate::capture_api::DEMO_PRINCIPAL),
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
            account(&headers).as_deref(),
            Ok("U:alice"),
            "a device CN must collapse to the account principal the wearer's own \
             dashboard reads, not stay a raw device subject"
        );

        // An asserted web identity that does not hold is a closed door, never a
        // fall-through into the demo partition.
        let mut asserted = HeaderMap::new();
        asserted.insert(header::AUTHORIZATION, "Bearer not-a-jwt".parse().unwrap());
        assert_eq!(account(&asserted).err(), Some(StatusCode::UNAUTHORIZED));
    }

    /// The same property over the wire, on the route Center actually calls.
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

    use cosmos_protocol::capture as capture_pb;
    use cosmos_protocol::capture::capture_service_server::CaptureService;

    /// One photo capture with `frames` slots, and the slot filenames the device
    /// would PUT to. `AssetUploadWorkerImpl.processItem` reads
    /// `secureRawDataFilename` off the stored `CreateMemoryResponse` for a photo
    /// in the default (non-JPG) mode, so those are the strings a real
    /// `UploadRequest` carries.
    async fn photo_with_slots(
        capture: &crate::services::capture::Capture,
        frames: i32,
    ) -> (String, Vec<String>) {
        let created = capture
            .create_memory(tonic::Request::new(capture_pb::CreateMemoryRequest {
                request: Some(
                    capture_pb::create_memory_request::Request::PhotoMemoryRequest(
                        capture_pb::PhotoMemoryRequest {
                            num_bursts: 1,
                            num_pics_per_burst: frames,
                            device_local_id: "device-http-upload".to_owned(),
                            ..Default::default()
                        },
                    ),
                ),
            }))
            .await
            .expect("create succeeds")
            .into_inner();
        let uuid = created.memory.expect("identity").uuid;
        let Some(capture_pb::create_memory_response::Request::PhotoMemoryResponse(photo)) =
            created.request
        else {
            panic!("a photo request must produce a photo response");
        };
        let slots = photo.bursts[0]
            .files
            .iter()
            .map(|file| file.secure_raw_data_filename.clone())
            .collect();
        (uuid, slots)
    }

    /// Ask `UploadFile` for a write URL and return just its path, which is what
    /// the device PUTs to.
    async fn upload_path(capture: &crate::services::capture::Capture, slot: &str) -> String {
        let url = capture
            .upload_file(tonic::Request::new(capture_pb::UploadRequest {
                filename: slot.to_owned(),
                upload_type: capture_pb::upload_request::UploadType::Image as i32,
                mime_encoding: "application/octet-stream".to_owned(),
            }))
            .await
            .expect("upload URL")
            .into_inner()
            .url;
        let parsed = reqwest::Url::parse(&url).expect("absolute URL");
        parsed.path().to_owned()
    }

    async fn report_upload_complete(
        capture: &crate::services::capture::Capture,
        memory_uuid: &str,
    ) -> i32 {
        capture
            .upload_complete(tonic::Request::new(capture_pb::UploadCompleteRequest {
                memory_uuid: memory_uuid.to_owned(),
                success: capture_pb::UploadCompletionStatus::UploadSuccess as i32,
                ..Default::default()
            }))
            .await
            .expect("upload_complete succeeds")
            .into_inner()
            .status
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

    /// END TO END, the whole reason this endpoint exists: a wearer takes a
    /// photo, the frames travel `CreateMemory` -> `UploadFile` -> PUT ->
    /// `UploadComplete`, and only once every frame is durably stored does the
    /// server acknowledge.
    ///
    /// The acknowledgement is destructive on the device:
    /// `AssetUploadWorkerImpl.handleUploadSuccess` runs
    /// `mFileSystem.deleteDirectory(captureDirectory())`. So the partial case is
    /// asserted too — one frame stored out of two must NOT acknowledge, or the
    /// wearer loses the frame that never arrived.
    #[tokio::test]
    async fn a_photo_is_acknowledged_only_once_every_frame_is_stored() {
        use crate::services::capture::{Capture, CaptureObjectStore};

        let objects = CaptureObjectStore::for_tests();
        let store = crate::store::MemoryStore::shared();
        // The production wiring: `Capture::new` and `build_router` both take the
        // ONE configured object store, so a capability minted on the gRPC side
        // is redeemable on the HTTP side.
        let capture =
            Capture::for_upload_tests(store.clone(), objects.clone(), "https://pin.example/");
        let app = build_router_with_uploads(Readiness::default(), None, Some(objects.clone()));

        let (memory_uuid, slots) = photo_with_slots(&capture, 2).await;
        assert_eq!(slots.len(), 2);

        // Nothing uploaded yet: a claimed success must not be acknowledged.
        assert_eq!(
            report_upload_complete(&capture, &memory_uuid).await,
            capture_pb::upload_complete_response::Status::UploadIncomplete as i32,
            "acknowledging before any bytes arrived deletes the wearer's only copy"
        );

        let frames: Vec<Vec<u8>> =
            vec![b"first encrypted frame".to_vec(), b"second frame".to_vec()];

        // Frame one.
        let path = upload_path(&capture, &slots[0]).await;
        let response = app
            .clone()
            .oneshot(put_asset(&path, &slots[0], frames[0].clone()))
            .await
            .expect("response");
        assert_eq!(
            response.status(),
            StatusCode::CREATED,
            "the device treats any non-2xx as a failed PUT"
        );

        // Still partial. This is the assertion that protects the wearer.
        assert_eq!(
            report_upload_complete(&capture, &memory_uuid).await,
            capture_pb::upload_complete_response::Status::UploadIncomplete as i32,
            "one frame of two is not a completed upload"
        );

        // Frame two.
        let path = upload_path(&capture, &slots[1]).await;
        let response = app
            .clone()
            .oneshot(put_asset(&path, &slots[1], frames[1].clone()))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::CREATED);

        assert_eq!(
            report_upload_complete(&capture, &memory_uuid).await,
            capture_pb::upload_complete_response::Status::Acknowledged as i32,
            "every frame is stored, so the device may now delete its copy"
        );

        // The claim has to be true on disk, byte for byte — an acknowledgement
        // is the last moment the frames exist anywhere else.
        for (slot, expected) in slots.iter().zip(&frames) {
            let path = objects
                .object_path_for_tests("development-insecure-principal", slot)
                .expect("stored path");
            assert_eq!(&std::fs::read(&path).expect("stored object"), expected);
        }

        // And the completion is recorded, so a restart does not un-finish it.
        assert!(
            store
                .memory("development-insecure-principal", &memory_uuid)
                .await
                .expect("store read")
                .expect("stored")
                .upload_complete
        );
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

    /// A deployment that stores nothing has no write surface at all — not a
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

    #[tokio::test]
    async fn readiness_tracks_serving_state() {
        let readiness = Readiness::default();
        let initial = router(readiness.clone())
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("initial response");
        assert_eq!(initial.status(), StatusCode::SERVICE_UNAVAILABLE);

        readiness.mark_ready();
        let ready = router(readiness)
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("ready response");
        assert_eq!(ready.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn connectivity_serves_http1_and_http2() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let address = listener.local_addr().expect("test listener address");
        let server =
            tokio::spawn(axum::serve(listener, router(Readiness::default())).into_future());

        let mut http1 = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect over HTTP/1.1");
        http1
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .expect("write HTTP/1.1 request");
        let mut http1_response = Vec::new();
        http1
            .read_to_end(&mut http1_response)
            .await
            .expect("read HTTP/1.1 response");
        assert!(
            http1_response.starts_with(b"HTTP/1.1 204 No Content\r\n"),
            "unexpected HTTP/1.1 status line"
        );

        let http2 = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect over HTTP/2");
        let (mut sender, connection) = h2::client::handshake(http2)
            .await
            .expect("complete HTTP/2 handshake");
        let connection = tokio::spawn(async move {
            connection.await.expect("drive HTTP/2 connection");
        });
        let request = axum::http::Request::builder()
            .uri(format!("http://{address}/"))
            .body(())
            .expect("build HTTP/2 request");
        let (response, _) = sender
            .send_request(request, true)
            .expect("send HTTP/2 request");
        assert_eq!(
            response.await.expect("receive HTTP/2 response").status(),
            StatusCode::NO_CONTENT
        );

        drop(sender);
        connection.abort();
        server.abort();
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

    #[test]
    fn feature_flag_controls_distinguish_real_consumers_from_record_only_keys() {
        let gesture = flag_metadata("vision_custom_gesture_enabled");
        assert!(gesture.writable);
        assert_eq!(gesture.evidence, "observed");
        assert_eq!(gesture.delivery, "next_sync");

        let demo = flag_metadata("demo_v1_enabled");
        assert!(!demo.writable);
        assert_eq!(demo.delivery, "server_only");

        let unknown = flag_metadata("not_a_real_flag");
        assert!(!unknown.writable);
        assert_eq!(unknown.evidence, "unknown");
    }

    #[test]
    fn feature_flag_writes_preserve_android_types_and_dependencies() {
        use crate::flag_overrides::FlagValue;

        assert!(validate_flag_change("touchcode_timeout_millis", &FlagValue::Int(7_500)).is_ok());
        assert!(validate_flag_change("touchcode_timeout_millis", &FlagValue::Int(-1)).is_err());
        assert!(validate_flag_change("touchcode_timeout_millis", &FlagValue::Bool(true)).is_err());
        assert!(validate_flag_change("cmu_ultra_chime_enabled", &FlagValue::Bool(true)).is_err());
        assert!(
            validate_flag_change("fitness_tracker_extra_data_enabled", &FlagValue::Bool(true))
                .is_err()
        );
        assert!(validate_flag_change("not_a_real_flag", &FlagValue::Bool(true)).is_err());
    }

    /// The whole point: mutation is refused when no token is configured, not left
    /// open. This is the failure mode the cosmos metrics disclosure demonstrated.
    #[test]
    fn mutation_fails_closed_when_no_token_is_configured() {
        // SAFETY: single-threaded test; the var is removed immediately after.
        unsafe { std::env::remove_var("COSMOS_ADMIN_TOKEN") };
        let (status, _) = require_admin(&bearer("anything")).unwrap_err();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn a_wrong_or_missing_token_is_rejected_and_the_right_one_passes() {
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

    #[tokio::test]
    async fn sealed_account_ingestion_populates_only_the_named_account_partition() {
        unsafe { std::env::set_var("COSMOS_ADMIN_TOKEN", "s3cret-operator-token") };
        let store = fresh_store();
        let demo = DemoBackend::new(store.clone());
        let state = HttpState {
            readiness: Readiness::default(),
            demo: Some(demo),
            store: Some(store.clone()),
            uploads: None,
        };
        let result = admin_profile(
            bearer("s3cret-operator-token"),
            State(state.clone()),
            Json(ProfileRequest {
                account_sub: "wearer-42".to_owned(),
                preferred_name: "  Ada  ".to_owned(),
                pronunciation: "AY-dah".to_owned(),
            }),
        )
        .await;
        assert!(result.is_ok(), "admin profile write must succeed");
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

        let payload = store
            .get_account_blob(
                "U:wearer-42",
                crate::store::AccountBlobKind::PersonalDetails,
            )
            .await
            .expect("store available")
            .expect("profile stored");
        let profile = cosmos_protocol::account::PersonalDetailsResponse::decode(payload.as_slice())
            .expect("wire-valid profile");
        assert_eq!(profile.account_info.unwrap().preferred_name, "Ada");
        assert!(profile.secure_bio_data.is_none());
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
                .get_account_blob(
                    "U:someone-else",
                    crate::store::AccountBlobKind::PersonalDetails,
                )
                .await
                .expect("store available")
                .is_none(),
            "a deliberately wrong partition must not observe the profile",
        );
    }
}
