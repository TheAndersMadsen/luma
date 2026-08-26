//! iroh P2P connector for remote Center access.
//!
//! This module establishes an outbound QUIC connection from the Pin to the Mac
//! helper using iroh. The Pin acts as a server accepting connections from
//! authorized Mac helpers. All requests flow through the typed remote_center
//! policy layer before dispatch.
//!
//! Architecture:
//! - Pin runs an iroh endpoint listening for Mac helper connections
//! - Mac helper connects to Pin using NodeId (no VPS relay needed)
//! - Requests are validated by policy::authorize before dispatch
//! - Center assets and approved API responses flow over the QUIC tunnel

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use base64::Engine as _;
use iroh::{Endpoint, EndpointId, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower::ServiceExt as _;
use tracing::{error, info, warn};

use super::policy::{
    authorize, ApiOperation, ApprovedOperation, AssetMethod, Capabilities, CenterAssetCatalog,
    CenterGeneration, CompletionState, MetadataLedger, PolicyContext, RequestEnvelope,
    RequestFingerprint, ReservationDecision,
};

/// Bound on the replay/idempotency ledger. The remote Center is a single
/// operator's session, so a few thousand recent requests is ample headroom.
const LEDGER_CAPACITY: usize = 4_096;
const REMOTE_PROTOCOL: &str = "penumbra-remote-center-v1";

/// Load a 32-byte iroh secret key from `path`, or generate one and persist it
/// (owner-only) so the Pin keeps a stable `EndpointId` across restarts. The key
/// is the Pin's remote-Center identity, so it is treated like a credential.
fn load_or_create_secret_key(
    path: &Path,
) -> Result<SecretKey, Box<dyn std::error::Error + Send + Sync>> {
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(SecretKey::from_bytes(&key));
        }
        warn!("iroh: secret key file has an unexpected length; regenerating");
    }
    let secret_key = SecretKey::generate();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, secret_key.to_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(secret_key)
}

/// Configuration for the iroh connector.
#[derive(Clone, Debug)]
pub struct IrohConfig {
    /// Whether the iroh tunnel is enabled.
    pub enabled: bool,
    /// Request timeout in milliseconds.
    pub request_timeout_ms: u64,
}

impl Default for IrohConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            request_timeout_ms: 30_000,
        }
    }
}

/// Wire protocol request from Mac helper to Pin.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoteRequest {
    pub protocol: String,
    pub request_id: String,
    pub generation: u64,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    /// Content-Type of the request body, forwarded so the Pin parses writes
    /// (e.g. `PUT /api/settings` JSON) correctly. Absent for bodyless reads.
    #[serde(default)]
    pub content_type: Option<String>,
    /// The request body, base64-encoded so it survives the JSON envelope
    /// (binary-safe, symmetric with `RemoteResponse`). Absent for GET/HEAD.
    #[serde(default)]
    pub body_base64: Option<String>,
}

/// Wire protocol response from Pin to Mac helper.
///
/// The body is base64 so binary Center assets (images, fonts, the `.webp`
/// install art) survive the JSON envelope intact, and `content_type` carries
/// the exact header the Pin served so the Mac helper's browser renders CSS/JS
/// correctly rather than guessing from the path.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoteResponse {
    pub protocol: String,
    pub request_id: String,
    pub generation: u64,
    pub status: u16,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub body_base64: Option<String>,
}

/// State shared between the iroh listener and request handlers.
pub struct IrohConnectorState {
    endpoint: Endpoint,
    generation: CenterGeneration,
    center_catalog: CenterAssetCatalog<'static>,
    /// Capabilities the remote peer is granted. Center assets and `/api/health`
    /// need none; every sensitive Center/Spotify route is opt-in here.
    capabilities: Capabilities,
    /// Replay + idempotency ledger consulted before every dispatch, so a
    /// replayed request id or a conflicting idempotency key fails closed.
    ledger: tokio::sync::Mutex<MetadataLedger>,
    http_router: Arc<RwLock<axum::Router>>,
    config: IrohConfig,
    /// Remote `EndpointId`s permitted to connect, lower-case hex.
    allowed_peers: Vec<String>,
}

impl IrohConnectorState {
    #[allow(clippy::too_many_arguments)]
    pub async fn new(
        generation: u64,
        center_entries: Vec<&'static str>,
        capabilities: Capabilities,
        http_router: axum::Router,
        config: IrohConfig,
        secret_key_path: Option<PathBuf>,
        allowed_peers: Vec<String>,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error + Send + Sync>> {
        let allowed_peers: Vec<String> = allowed_peers
            .into_iter()
            .map(|peer| peer.trim().to_ascii_lowercase())
            .filter(|peer| !peer.is_empty())
            .collect();
        if allowed_peers.is_empty() {
            return Err(
                "iroh remote Center requires at least one trusted bridge EndpointId".into(),
            );
        }
        let generation = CenterGeneration::new(generation)?;
        let catalog = CenterAssetCatalog::new(Box::leak(center_entries.into_boxed_slice()))?;
        let ledger = tokio::sync::Mutex::new(MetadataLedger::new(generation, LEDGER_CAPACITY)?);

        // iroh 1.0 requires an explicit connectivity preset. `N0` uses the
        // n0 relay + DNS discovery so the Mac helper can reach the Pin by
        // EndpointId alone (no LAN, no manual relay), which is the whole point
        // of the remote-Center tunnel.
        //
        // A persisted secret key gives the Pin a STABLE EndpointId across
        // restarts, so the ticket handed to the VPS bridge stays valid instead
        // of changing on every boot. Without a path (or on I/O error) we fall
        // back to an ephemeral identity.
        // The DNS resolver is supplied explicitly because the endpoint builds a
        // default one otherwise, and that default reads the platform nameserver
        // config through JNI — which panics in this JVM-less process and then
        // silently falls back to Google's resolvers. See `super::system_dns`.
        let mut builder = Endpoint::builder(iroh::endpoint::presets::N0)
            .dns_resolver(super::system_dns::resolver())
            .alpns(vec![b"penumbra-center".to_vec()]);
        if let Some(path) = secret_key_path.as_deref() {
            match load_or_create_secret_key(path) {
                Ok(secret_key) => builder = builder.secret_key(secret_key),
                Err(e) => warn!(
                    error = %e,
                    "iroh: could not persist secret key; using an ephemeral identity"
                ),
            }
        }
        let endpoint = builder.bind().await?;

        info!(
            node_id = %endpoint.id(),
            "iroh connector initialized with node ID"
        );

        Ok(Arc::new(Self {
            endpoint,
            allowed_peers,
            generation,
            center_catalog: catalog,
            capabilities,
            ledger,
            http_router: Arc::new(RwLock::new(http_router)),
            config,
        }))
    }

    /// This Pin endpoint's stable identity (the `EndpointId`, iroh 1.0's
    /// replacement for `NodeId`). The Mac helper authenticates the Pin by it.
    pub fn node_id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// Build the ticket the Mac helper needs to reach this Pin. In iroh 1.0 the
    /// ticket type lives in `iroh-tickets` and `Endpoint::addr()` is a
    /// synchronous, infallible snapshot of the current addressing info.
    pub fn node_ticket(&self) -> EndpointTicket {
        EndpointTicket::new(self.endpoint.addr())
    }

    /// Start accepting connections from Mac helpers.
    pub async fn serve(self: Arc<Self>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.config.enabled {
            info!("iroh connector is disabled");
            return Ok(());
        }

        info!("iroh connector listening for Mac helper connections");

        loop {
            match self.endpoint.accept().await {
                Some(incoming) => {
                    let state = Arc::clone(&self);
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(incoming, state).await {
                            error!(error = %e, "failed to handle iroh connection");
                        }
                    });
                }
                None => {
                    warn!("iroh endpoint closed");
                    break;
                }
            }
        }

        Ok(())
    }
}

async fn handle_connection(
    incoming: iroh::endpoint::Incoming,
    state: Arc<IrohConnectorState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let connection = incoming.await?;
    let remote = connection.remote_id();

    // Mutual authentication, using iroh's own key crypto. The connector
    // dispatches through the API router *without* the administration-auth layer
    // the LAN listener gets, so without this the Pin's EndpointId is the only
    // credential — and it is persisted, stable across reboots and printed at
    // startup. A caller must now additionally *be* a permitted endpoint, which
    // it cannot forge without that peer's private key.
    //
    let remote_hex = remote.to_string().to_ascii_lowercase();
    if !state.allowed_peers.iter().any(|peer| peer == &remote_hex) {
        warn!("rejected iroh connection from a peer that is not on the allowlist");
        connection.close(1u32.into(), b"peer not allowed");
        return Ok(());
    }

    info!(
        remote = %remote,
        "accepted iroh connection from Mac helper"
    );

    loop {
        match connection.accept_bi().await {
            Ok((mut send, mut recv)) => {
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    if let Err(e) = handle_request_stream(&mut send, &mut recv, state).await {
                        error!(error = %e, "failed to handle request stream");
                    }
                });
            }
            Err(iroh::endpoint::ConnectionError::ApplicationClosed(_)) => {
                info!("iroh connection closed by peer");
                break;
            }
            Err(e) => {
                error!(error = %e, "iroh connection error");
                break;
            }
        }
    }

    Ok(())
}

async fn handle_request_stream(
    send: &mut iroh::endpoint::SendStream,
    recv: &mut iroh::endpoint::RecvStream,
    state: Arc<IrohConnectorState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    loop {
        // Read request length (4 bytes, big-endian)
        let mut len_buf = [0u8; 4];
        if recv.read_exact(&mut len_buf).await.is_err() {
            // Connection closed
            break;
        }
        let len = u32::from_be_bytes(len_buf) as usize;

        if len > 8 * 1024 * 1024 {
            // 8 MiB max request envelope — large enough for any Center write
            // body (base64-inflated), symmetric with the response cap.
            error!(len, "request exceeds maximum size");
            break;
        }

        // Read request JSON
        let mut request_buf = vec![0u8; len];
        if recv.read_exact(&mut request_buf).await.is_err() {
            break;
        }

        let request: RemoteRequest = match serde_json::from_slice(&request_buf) {
            Ok(req) => req,
            Err(e) => {
                error!(error = %e, "failed to parse remote request");
                send_error_response(send, StatusCode::BAD_REQUEST, "invalid request JSON").await?;
                continue;
            }
        };
        if request.protocol != REMOTE_PROTOCOL {
            send_error_response(send, StatusCode::BAD_REQUEST, "unsupported protocol").await?;
            continue;
        }

        let request_body = match request.body_base64.as_deref() {
            Some(encoded) => match base64::engine::general_purpose::STANDARD.decode(encoded) {
                Ok(body) => body,
                Err(_) => {
                    send_error_response(send, StatusCode::BAD_REQUEST, "invalid request body")
                        .await?;
                    continue;
                }
            },
            None => Vec::new(),
        };
        let header_count = usize::from(request.content_type.is_some());
        let header_bytes = request.content_type.as_deref().map_or(0, |value| {
            axum::http::header::CONTENT_TYPE.as_str().len() + value.len()
        });

        // Validate and authorize through policy layer
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let envelope = RequestEnvelope {
            method: &request.method,
            target: &request.path,
            content_type: request.content_type.as_deref(),
            header_count,
            header_bytes,
            body_bytes: request_body.len() as u64,
            declared_body_bytes: Some(request_body.len() as u64),
            issued_at_ms: now_ms,
            expires_at_ms: now_ms + state.config.request_timeout_ms,
            generation: request.generation,
            request_id: &request.request_id,
            idempotency_key: request.idempotency_key.as_deref(),
        };

        let context = PolicyContext {
            now_ms,
            expected_generation: state.generation,
            capabilities: state.capabilities,
            center_assets: &state.center_catalog,
        };

        let validated = match authorize(&envelope, &context) {
            Ok(validated) => validated,
            Err(policy_error) => {
                warn!(error = %policy_error, "remote request denied by policy");
                send_error_response(send, StatusCode::FORBIDDEN, "request denied by policy")
                    .await?;
                continue;
            }
        };

        // Replay + idempotency gate. Include the body digest so reusing a write
        // key for a different settings payload is a conflict, not a retry.
        let fingerprint = request_fingerprint(&request.method, &request.path, &request_body);
        let admit = {
            let mut ledger = state.ledger.lock().await;
            ledger.admit(&validated, fingerprint, now_ms)
        };
        let reservation = match admit {
            Ok(ReservationDecision::ExecuteOnce(reservation)) => reservation,
            Ok(ReservationDecision::RejectDuplicateDoNotExecute(_)) => {
                send_error_response(send, StatusCode::CONFLICT, "duplicate request").await?;
                continue;
            }
            Err(ledger_error) => {
                warn!(error = %ledger_error, "remote request rejected by ledger");
                send_error_response(send, StatusCode::FORBIDDEN, "request rejected").await?;
                continue;
            }
        };

        // Check the reservation again immediately before dispatch. Mutations
        // therefore cannot begin after their freshness window, and replayed or
        // conflicting idempotency metadata never reaches the router.
        let dispatch_now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        if !state
            .ledger
            .lock()
            .await
            .reservation_may_start(&reservation, dispatch_now_ms)
        {
            send_error_response(send, StatusCode::FORBIDDEN, "request reservation expired").await?;
            continue;
        }

        // Never forward the peer's method, path, query or headers. Construct an
        // exact in-process request from the authorized typed operation.
        let dispatch = match typed_dispatch_request(
            reservation.operation(),
            &state.center_catalog,
            request_body,
        ) {
            Ok(dispatch) => dispatch,
            Err(message) => {
                let mut ledger = state.ledger.lock().await;
                let _ = ledger.record_completion(
                    &reservation,
                    CompletionState::Completed,
                    dispatch_now_ms,
                );
                drop(ledger);
                send_error_response(send, StatusCode::BAD_REQUEST, message).await?;
                continue;
            }
        };

        // Dispatch through the in-process HTTP router. Binary response bodies
        // and their exact content type still flow back over the tunnel.
        let router = state.http_router.read().await.clone();
        let mut request_builder = Request::builder()
            .method(dispatch.method)
            .uri(&dispatch.target);
        if let Some(content_type) = dispatch.content_type.as_deref() {
            request_builder =
                request_builder.header(axum::http::header::CONTENT_TYPE, content_type);
        }
        let http_request = request_builder.body(Body::from(dispatch.body))?;

        let http_response = router.oneshot(http_request).await?;
        let status = http_response.status().as_u16();
        let content_type = http_response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body_bytes = axum::body::to_bytes(http_response.into_body(), 8 * 1024 * 1024).await?;
        let body_base64 = base64::engine::general_purpose::STANDARD.encode(&body_bytes);

        // Record the terminal metadata state (content-free) so a duplicate can
        // never re-execute a completed mutation.
        let mut ledger = state.ledger.lock().await;
        let _ = ledger.record_completion(&reservation, CompletionState::Completed, now_ms);
        drop(ledger);

        send_response(
            send,
            &request.protocol,
            &request.request_id,
            request.generation,
            status,
            content_type,
            Some(body_base64),
        )
        .await?;
    }

    Ok(())
}

#[derive(Debug)]
struct DispatchRequest {
    method: Method,
    target: String,
    content_type: Option<String>,
    body: Vec<u8>,
}

/// Convert a closed policy operation into an exact router request.
///
/// The remote peer cannot select a host, path, HTTP method, or forwarded
/// header here. The sole variable URL component is a decoded/bounded Spotify
/// search term, which is encoded again locally into a canonical query string.
fn typed_dispatch_request(
    operation: ApprovedOperation,
    catalog: &CenterAssetCatalog<'_>,
    body: Vec<u8>,
) -> Result<DispatchRequest, &'static str> {
    match operation {
        ApprovedOperation::CenterAsset(operation) => {
            if !body.is_empty() {
                return Err("Center asset request body is not allowed");
            }
            let method = match operation {
                super::policy::CenterOperation::Asset {
                    method: AssetMethod::Get,
                    ..
                } => Method::GET,
                super::policy::CenterOperation::Asset {
                    method: AssetMethod::Head,
                    ..
                } => Method::HEAD,
            };
            let entry = catalog
                .resolve(operation)
                .ok_or("Center asset operation is not in the active catalog")?;
            let target = if entry == "index.html" {
                "/setup/".to_owned()
            } else {
                format!("/setup/{entry}")
            };
            Ok(DispatchRequest {
                method,
                target,
                content_type: None,
                body,
            })
        }
        ApprovedOperation::Api(operation) => {
            let (method, target, content_type) = match operation {
                ApiOperation::Health => (Method::GET, "/api/health".to_owned(), None),
                ApiOperation::DeviceMetadata => (Method::GET, "/api/device".to_owned(), None),
                ApiOperation::FeatureFlagsRead => {
                    (Method::GET, "/api/feature-flags".to_owned(), None)
                }
                ApiOperation::MusicEgress => {
                    crate::api::music::validate_egress_payload(&body)?;
                    (
                        Method::POST,
                        "/api/music/egress".to_owned(),
                        Some("application/json".to_owned()),
                    )
                }
                ApiOperation::SpotifyStatus => {
                    (Method::GET, "/api/spotify/status".to_owned(), None)
                }
                ApiOperation::SpotifySettingsUpdate => {
                    validate_spotify_settings_payload(&body)?;
                    (
                        Method::PUT,
                        "/api/spotify/settings".to_owned(),
                        Some("application/json".to_owned()),
                    )
                }
                ApiOperation::SpotifyPairingStart => {
                    (Method::POST, "/api/spotify/pairing/start".to_owned(), None)
                }
                ApiOperation::SpotifyPairingCancel => {
                    (Method::POST, "/api/spotify/pairing/cancel".to_owned(), None)
                }
                ApiOperation::SpotifySessionDelete => {
                    (Method::DELETE, "/api/spotify/session".to_owned(), None)
                }
                ApiOperation::SpotifySearch(query) => (
                    Method::GET,
                    format!(
                        "/api/spotify/search?q={}&kind=track",
                        encode_form_value(query.as_str())
                    ),
                    None,
                ),
                #[cfg(test)]
                ApiOperation::TestMutation => return Err("test mutation reached typed dispatch"),
            };
            if !matches!(
                operation,
                ApiOperation::SpotifySettingsUpdate | ApiOperation::MusicEgress
            ) && !body.is_empty()
            {
                return Err("request body is not allowed for this operation");
            }
            Ok(DispatchRequest {
                method,
                target,
                content_type,
                body,
            })
        }
    }
}

fn validate_spotify_settings_payload(body: &[u8]) -> Result<(), &'static str> {
    let settings: crate::spotify::UpdateSpotifySettings =
        serde_json::from_slice(body).map_err(|_| "invalid Spotify settings payload")?;
    let name = settings.device_name.trim();
    if !(1..=48).contains(&name.chars().count()) || name.chars().any(char::is_control) {
        return Err("invalid Spotify device name");
    }
    if settings.enabled && !settings.experimental_acknowledged {
        return Err("Spotify acknowledgement is required");
    }
    Ok(())
}

fn encode_form_value(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b' ' => encoded.push('+'),
            byte if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') => {
                encoded.push(char::from(byte));
            }
            byte => {
                encoded.push('%');
                encoded.push(char::from(HEX[usize::from(byte >> 4)]));
                encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
            }
        }
    }
    encoded
}

/// Content-free semantic fingerprint of a request: the typed method + path,
/// excluding retry-specific request ids/timestamps so a legitimate retry maps
/// to the same fingerprint. Computed locally; never accepted from the peer.
fn request_fingerprint(method: &str, path: &str, body: &[u8]) -> RequestFingerprint {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(method.as_bytes());
    hasher.update([0u8]);
    hasher.update(path.as_bytes());
    hasher.update([0u8]);
    hasher.update(body);
    RequestFingerprint::from_locally_computed_digest(hasher.finalize().into())
}

#[allow(clippy::too_many_arguments)]
async fn send_response(
    send: &mut iroh::endpoint::SendStream,
    protocol: &str,
    request_id: &str,
    generation: u64,
    status: u16,
    content_type: Option<String>,
    body_base64: Option<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let response = RemoteResponse {
        protocol: protocol.to_string(),
        request_id: request_id.to_string(),
        generation,
        status,
        content_type,
        body_base64,
    };

    let response_json = serde_json::to_vec(&response)?;
    let len = (response_json.len() as u32).to_be_bytes();

    send.write_all(&len).await?;
    send.write_all(&response_json).await?;

    Ok(())
}

async fn send_error_response(
    send: &mut iroh::endpoint::SendStream,
    status: StatusCode,
    message: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    send_response(
        send,
        REMOTE_PROTOCOL,
        "error",
        0,
        status.as_u16(),
        Some("text/plain; charset=utf-8".to_string()),
        Some(base64::engine::general_purpose::STANDARD.encode(message.as_bytes())),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_center::policy::{Capability, PolicyContext};

    #[test]
    fn remote_request_serialization() {
        let request = RemoteRequest {
            protocol: REMOTE_PROTOCOL.to_string(),
            request_id: "req-001".to_string(),
            generation: 1,
            method: "GET".to_string(),
            path: "/center/".to_string(),
            idempotency_key: None,
            content_type: None,
            body_base64: None,
        };

        let json = serde_json::to_string(&request).unwrap();
        let parsed: RemoteRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.protocol, request.protocol);
        assert_eq!(parsed.request_id, request.request_id);
        assert_eq!(parsed.generation, request.generation);
        assert_eq!(parsed.method, request.method);
        assert_eq!(parsed.path, request.path);
    }

    #[test]
    fn remote_response_serialization() {
        let response = RemoteResponse {
            protocol: "penumbra-remote-center-v1".to_string(),
            request_id: "req-001".to_string(),
            generation: 1,
            status: 200,
            content_type: Some("text/html; charset=utf-8".to_string()),
            body_base64: Some(base64::engine::general_purpose::STANDARD.encode(b"<html>OK</html>")),
        };

        let json = serde_json::to_string(&response).unwrap();
        let parsed: RemoteResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.protocol, response.protocol);
        assert_eq!(parsed.request_id, response.request_id);
        assert_eq!(parsed.status, response.status);
        assert_eq!(parsed.content_type, response.content_type);
        assert_eq!(parsed.body_base64, response.body_base64);
    }

    #[test]
    fn request_fingerprint_is_stable_and_path_sensitive() {
        // A legitimate retry (same method+path) shares a fingerprint; a
        // different path/method does not, so the ledger distinguishes
        // operations. (`RequestFingerprint` is `PartialEq` but not `Debug`.)
        assert!(
            request_fingerprint("GET", "/center/index.html", b"")
                == request_fingerprint("GET", "/center/index.html", b"")
        );
        assert!(
            request_fingerprint("GET", "/center/index.html", b"")
                != request_fingerprint("GET", "/api/health", b"")
        );
        assert!(
            request_fingerprint("GET", "/center/", b"")
                != request_fingerprint("POST", "/center/", b"")
        );
        assert!(
            request_fingerprint("PUT", "/api/settings", br#"{"a":1}"#)
                != request_fingerprint("PUT", "/api/settings", br#"{"a":2}"#)
        );
    }

    fn spotify_operation(method: &str, target: &str, body: &[u8]) -> ApprovedOperation {
        let catalog = CenterAssetCatalog::new(&["index.html"]).unwrap();
        let generation = CenterGeneration::new(1).unwrap();
        let capabilities = Capabilities::none()
            .with(Capability::SpotifyRead)
            .with(Capability::SpotifyManage);
        let is_write = method != "GET" && method != "HEAD";
        let request = RequestEnvelope {
            method,
            target,
            content_type: (target == "/api/spotify/settings").then_some("application/json"),
            header_count: usize::from(target == "/api/spotify/settings"),
            header_bytes: if target == "/api/spotify/settings" {
                28
            } else {
                0
            },
            body_bytes: body.len() as u64,
            declared_body_bytes: is_write.then_some(body.len() as u64),
            issued_at_ms: 1_000,
            expires_at_ms: 31_000,
            generation: 1,
            request_id: "spotify-request-0001",
            idempotency_key: is_write.then_some("spotify-idempotency-0001"),
        };
        let context = PolicyContext {
            now_ms: 2_000,
            expected_generation: generation,
            capabilities,
            center_assets: &catalog,
        };
        let validated = authorize(&request, &context).unwrap();
        let mut ledger = MetadataLedger::new(generation, 4).unwrap();
        let ReservationDecision::ExecuteOnce(reservation) = ledger
            .admit(&validated, request_fingerprint(method, target, body), 2_000)
            .unwrap()
        else {
            panic!("request should receive an execution reservation");
        };
        reservation.operation()
    }

    fn music_egress_operation(body: &[u8]) -> ApprovedOperation {
        let catalog = CenterAssetCatalog::new(&["index.html"]).unwrap();
        let generation = CenterGeneration::new(1).unwrap();
        let request = RequestEnvelope {
            method: "POST",
            target: "/api/music/egress",
            content_type: Some("application/json"),
            header_count: 1,
            header_bytes: 28,
            body_bytes: body.len() as u64,
            declared_body_bytes: Some(body.len() as u64),
            issued_at_ms: 1_000,
            expires_at_ms: 31_000,
            generation: 1,
            request_id: "music-egress-request-0001",
            idempotency_key: Some("music-egress-idempotency-0001"),
        };
        let context = PolicyContext {
            now_ms: 2_000,
            expected_generation: generation,
            capabilities: Capabilities::none().with(Capability::MusicEgress),
            center_assets: &catalog,
        };
        let validated = authorize(&request, &context).unwrap();
        let mut ledger = MetadataLedger::new(generation, 4).unwrap();
        let ReservationDecision::ExecuteOnce(reservation) = ledger
            .admit(
                &validated,
                request_fingerprint("POST", "/api/music/egress", body),
                2_000,
            )
            .unwrap()
        else {
            panic!("request should receive an execution reservation");
        };
        reservation.operation()
    }

    #[test]
    fn typed_spotify_dispatch_uses_fixed_routes_and_canonical_query() {
        let catalog = CenterAssetCatalog::new(&["index.html"]).unwrap();
        let status = typed_dispatch_request(
            spotify_operation("GET", "/api/spotify/status", b""),
            &catalog,
            Vec::new(),
        )
        .unwrap();
        assert_eq!(status.method, Method::GET);
        assert_eq!(status.target, "/api/spotify/status");
        assert!(status.content_type.is_none());

        let search = typed_dispatch_request(
            spotify_operation(
                "GET",
                "/api/spotify/search?kind=track&q=Bj%C3%B6rk+Live",
                b"",
            ),
            &catalog,
            Vec::new(),
        )
        .unwrap();
        assert_eq!(search.method, Method::GET);
        assert_eq!(
            search.target,
            "/api/spotify/search?q=Bj%C3%B6rk+Live&kind=track"
        );
    }

    #[test]
    fn typed_spotify_settings_validate_schema_before_dispatch() {
        let catalog = CenterAssetCatalog::new(&["index.html"]).unwrap();
        let valid = br#"{"enabled":true,"experimental_acknowledged":true,"device_name":"Ai Pin"}"#;
        let operation = spotify_operation("PUT", "/api/spotify/settings", valid);
        let dispatch = typed_dispatch_request(operation, &catalog, valid.to_vec()).unwrap();
        assert_eq!(dispatch.method, Method::PUT);
        assert_eq!(dispatch.target, "/api/spotify/settings");
        assert_eq!(dispatch.content_type.as_deref(), Some("application/json"));

        let unknown = br#"{"enabled":false,"experimental_acknowledged":false,"device_name":"Ai Pin","extra":true}"#;
        assert_eq!(
            typed_dispatch_request(operation, &catalog, unknown.to_vec()).unwrap_err(),
            "invalid Spotify settings payload"
        );
        let unacknowledged =
            br#"{"enabled":true,"experimental_acknowledged":false,"device_name":"Ai Pin"}"#;
        assert_eq!(
            typed_dispatch_request(operation, &catalog, unacknowledged.to_vec()).unwrap_err(),
            "Spotify acknowledgement is required"
        );
    }

    #[test]
    fn typed_music_egress_dispatch_revalidates_the_closed_provider_request() {
        let catalog = CenterAssetCatalog::new(&["index.html"]).unwrap();
        let valid = br#"{"provider":"youtube_music","method":"POST","url":"https://youtubei.googleapis.com/youtubei/v1/player","headers":{"content-type":"application/json"},"body_base64":"e30="}"#;
        let operation = music_egress_operation(valid);
        let dispatch = typed_dispatch_request(operation, &catalog, valid.to_vec()).unwrap();
        assert_eq!(dispatch.method, Method::POST);
        assert_eq!(dispatch.target, "/api/music/egress");
        assert_eq!(dispatch.content_type.as_deref(), Some("application/json"));
        assert_eq!(dispatch.body, valid);

        let unsafe_target = br#"{"provider":"youtube_music","method":"POST","url":"https://example.test/player","headers":{"content-type":"application/json"},"body_base64":"e30="}"#;
        assert_eq!(
            typed_dispatch_request(operation, &catalog, unsafe_target.to_vec()).unwrap_err(),
            "music egress URL is not allowed"
        );
    }
}
