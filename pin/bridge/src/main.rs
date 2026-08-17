//! Setup iroh bridge — Mac helper for remote Ai Pin Setup access.
//!
//! Connects to a Pin's iroh endpoint using an EndpointTicket and exposes the
//! Setup dashboard on a local loopback HTTP port. No LAN, USB, or VPS
//! required — iroh handles NAT traversal automatically via the n0 relay and
//! DNS discovery.
//!
//! Usage:
//! 1. On the Pin: enable `[server] iroh_remote_center_enabled = true`.
//! 2. Fetch the ticket once (over LAN or `adb forward`) from
//!    `GET /api/iroh/ticket`; it returns
//!    `{ "ticket": "<EndpointTicket>", "node_id": "..." }`.
//! 3. On the Mac: `cargo run -- --ticket <EndpointTicket>`.
//! 4. Open `http://localhost:18080/setup/` in your browser.
//!
//! Everything binds to loopback only. The ticket is the sole credential; the
//! iroh connection is end-to-end encrypted to the Pin's key, and the Pin's
//! policy layer grants read-only access (Center assets + a few status reads).

use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::Engine as _;
use clap::{Parser, ValueEnum};
use iroh::{Endpoint, EndpointAddr};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{error, info, warn};
use uuid::Uuid;

const PROTOCOL_VERSION: &str = "penumbra-remote-center-v1";
const ALPN: &[u8] = b"penumbra-center";
/// The Pin caps response bodies at 8 MiB; base64 inflates by ~4/3 and the JSON
/// envelope adds a little more, so allow generous headroom.
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SPOTIFY_SETTINGS_BODY_BYTES: usize = 512;
const MAX_SPOTIFY_SEARCH_QUERY_BYTES: usize = 256;

/// Defense-in-depth policy applied by the loopback bridge before a request is
/// put on the authenticated iroh tunnel. Compatibility remains the default so
/// existing Setup recovery flows do not change during a staged rollout.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
enum ProxyPolicy {
    #[default]
    Compatibility,
    Reviewed,
}

/// Wire protocol request to the Pin. Mirrors `RemoteRequest` in
/// `runtime/core/src/remote_center/iroh_connector.rs`.
#[derive(Debug, Clone, Serialize)]
struct RemoteRequest {
    protocol: String,
    request_id: String,
    generation: u64,
    method: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    idempotency_key: Option<String>,
    /// Content-Type of the request body, forwarded so the Pin parses writes.
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    /// Base64 request body (writes: PUT/POST/DELETE). Absent for empty bodies.
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
}

/// Wire protocol response from the Pin. Mirrors `RemoteResponse` in
/// `runtime/core/src/remote_center/iroh_connector.rs`: the body is base64 so
/// binary assets survive the JSON envelope, and `content_type` carries the
/// exact header the Pin served.
#[derive(Debug, Deserialize)]
struct RemoteResponse {
    #[allow(dead_code)]
    protocol: String,
    #[allow(dead_code)]
    request_id: String,
    #[allow(dead_code)]
    generation: u64,
    status: u16,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    body_base64: Option<String>,
}

/// Shared state between the HTTP server and the iroh connection.
struct BridgeState {
    /// The iroh stream to the Pin. Protected by a mutex because we multiplex
    /// requests over a single bidirectional stream, one at a time.
    stream: Mutex<Option<(iroh::endpoint::SendStream, iroh::endpoint::RecvStream)>>,
    endpoint: Endpoint,
    node_addr: EndpointAddr,
    generation: u64,
    proxy_policy: ProxyPolicy,
}

impl BridgeState {
    /// Ensure we have an active stream to the Pin, reconnecting if needed.
    async fn get_or_connect(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut stream_guard = self.stream.lock().await;
        if stream_guard.is_some() {
            return Ok(());
        }

        info!("connecting to Pin via iroh...");
        let connection = self.endpoint.connect(self.node_addr.clone(), ALPN).await?;
        info!(
            "connected to Pin (remote endpoint: {})",
            connection.remote_id()
        );

        let (send, recv) = connection.open_bi().await?;
        *stream_guard = Some((send, recv));
        info!("bidirectional stream established");

        Ok(())
    }

    /// Send a request and receive a response over the iroh stream.
    async fn roundtrip(
        &self,
        request: RemoteRequest,
    ) -> Result<RemoteResponse, Box<dyn std::error::Error + Send + Sync>> {
        let mut stream_guard = self.stream.lock().await;

        let (send, recv) = match stream_guard.as_mut() {
            Some(pair) => pair,
            None => return Err("not connected".into()),
        };

        // Write length-prefixed JSON request (u32 big-endian length prefix).
        // No explicit flush: iroh/quinn transmits buffered stream data as the
        // connection drives itself, and the server writes its response only
        // after reading a full request — mirroring the server's own path.
        let request_json = serde_json::to_vec(&request)?;
        let len = (request_json.len() as u32).to_be_bytes();
        // Drop the stream on a write failure too, not just on read failures: if
        // the Pin restarts, the shared stream dies and the write is the first
        // thing to fail. Leaving it in place would wedge the bridge into
        // permanent "connection lost" (502) until it was restarted by hand.
        if let Err(e) = send.write_all(&len).await {
            *stream_guard = None;
            return Err(format!("write error: {e}").into());
        }
        if let Err(e) = send.write_all(&request_json).await {
            *stream_guard = None;
            return Err(format!("write error: {e}").into());
        }

        // Read length-prefixed JSON response.
        let mut len_buf = [0u8; 4];
        let read_result =
            tokio::time::timeout(REQUEST_TIMEOUT, recv.read_exact(&mut len_buf)).await;
        match read_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                // Connection lost; drop the stream so the next call reconnects.
                *stream_guard = None;
                return Err(format!("read error: {e}").into());
            }
            Err(_) => {
                *stream_guard = None;
                return Err("response timed out".into());
            }
        }

        let response_len = u32::from_be_bytes(len_buf) as usize;
        if response_len > MAX_RESPONSE_BYTES {
            *stream_guard = None;
            return Err(format!("response too large: {response_len} bytes").into());
        }

        let mut response_buf = vec![0u8; response_len];
        if let Err(e) = recv.read_exact(&mut response_buf).await {
            *stream_guard = None;
            return Err(format!("read error: {e}").into());
        }

        let response: RemoteResponse = serde_json::from_slice(&response_buf)?;
        Ok(response)
    }
}

/// Handle any HTTP request by forwarding it over iroh to the Pin.
async fn proxy_request(
    State(state): State<Arc<BridgeState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if state.proxy_policy == ProxyPolicy::Reviewed
        && !reviewed_route_allowed(&method, &uri, &headers, body.len())
    {
        warn!(method = %method, path = uri.path(), "request denied by bridge allowlist");
        return (StatusCode::FORBIDDEN, "request denied by bridge policy\n").into_response();
    }

    // Forward the full path + query so API routes with query strings work.
    let path = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());
    let request_id = Uuid::new_v4().to_string();

    // Forward the request body (writes: PUT/POST/DELETE) and its content type
    // so the Pin can parse and apply them.
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body_base64 = if body.is_empty() {
        None
    } else {
        Some(base64::engine::general_purpose::STANDARD.encode(&body))
    };

    let request = RemoteRequest {
        protocol: PROTOCOL_VERSION.to_string(),
        request_id: request_id.clone(),
        generation: state.generation,
        method: method.to_string(),
        path,
        // Only non-idempotent methods carry a key; the Pin's ledger uses it to
        // collapse retries. GET/HEAD are naturally idempotent.
        idempotency_key: if method != Method::GET && method != Method::HEAD {
            Some(request_id.clone())
        } else {
            None
        },
        content_type,
        body_base64,
    };

    // Never put personal search terms or other query data in normal logs.
    info!(">>> {} {} (id={})", request.method, uri.path(), request_id);

    // Transparent reconnect-and-retry. When the Pin restarts, the shared iroh
    // stream dies: the first attempt fails and clears it, the second redials.
    // Without this a Pin restart wedges the bridge into permanent 502s.
    let mut response = None;
    let mut last_error = String::from("not connected");
    for attempt in 0..2 {
        if let Err(e) = state.get_or_connect().await {
            last_error = format!("cannot connect to Pin: {e}");
            continue;
        }
        match state.roundtrip(request.clone()).await {
            Ok(received) => {
                response = Some(received);
                break;
            }
            Err(e) => {
                last_error = e.to_string();
                if attempt == 0 {
                    warn!("roundtrip failed ({last_error}); reconnecting and retrying");
                }
            }
        }
    }

    let Some(response) = response else {
        error!("roundtrip failed after retry: {last_error}");
        return (
            StatusCode::BAD_GATEWAY,
            format!("Pin request failed: {last_error}\n"),
        )
            .into_response();
    };

    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    // Decode the base64 body back to raw bytes (binary-safe).
    let body_bytes = match response.body_base64.as_deref() {
        Some(encoded) => match base64::engine::general_purpose::STANDARD.decode(encoded) {
            Ok(bytes) => bytes,
            Err(e) => {
                error!("invalid base64 body from Pin: {e}");
                return (
                    StatusCode::BAD_GATEWAY,
                    "Pin returned an undecodable response body\n",
                )
                    .into_response();
            }
        },
        None => Vec::new(),
    };
    info!(
        "<<< {} {} -> {} ({} bytes)",
        method,
        uri.path(),
        status,
        body_bytes.len()
    );

    let mut resp = Response::new(Body::from(body_bytes));
    *resp.status_mut() = status;

    // Prefer the exact content type the Pin served; fall back to a path-based
    // guess only when the Pin didn't provide one.
    let content_type = response
        .content_type
        .and_then(|ct| header::HeaderValue::from_str(&ct).ok())
        .unwrap_or_else(|| header::HeaderValue::from_static(guess_content_type(uri.path())));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );

    resp
}

fn reviewed_route_allowed(
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body_bytes: usize,
) -> bool {
    let path = uri.path();
    let no_content_type = headers.get(header::CONTENT_TYPE).is_none();
    let bodyless = body_bytes == 0;

    if uri.query().is_none()
        && bodyless
        && no_content_type
        && (method == Method::GET || method == Method::HEAD)
        && (path == "/setup/"
            || path.starts_with("/setup/")
            || path == "/center/"
            || path.starts_with("/center/"))
    {
        // The Pin still checks exact membership in its embedded asset catalog.
        return true;
    }

    if uri.query().is_none() && bodyless && no_content_type && *method == Method::GET {
        if matches!(
            path,
            "/api/health" | "/api/device" | "/api/feature-flags" | "/api/spotify/status"
        ) {
            return true;
        }
    }

    match (method, path, uri.query()) {
        (&Method::GET, "/api/spotify/search", Some(query)) => {
            bodyless && no_content_type && valid_spotify_search_query(query)
        }
        (&Method::PUT, "/api/spotify/settings", None) => {
            body_bytes <= MAX_SPOTIFY_SETTINGS_BODY_BYTES
                && headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    == Some("application/json")
        }
        (&Method::POST, "/api/spotify/pairing/start", None)
        | (&Method::POST, "/api/spotify/pairing/cancel", None)
        | (&Method::DELETE, "/api/spotify/session", None) => bodyless && no_content_type,
        _ => false,
    }
}

fn valid_spotify_search_query(query: &str) -> bool {
    let mut search = None;
    let mut kind = None;
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            return false;
        };
        let Some(value) = decode_form_value(value) else {
            return false;
        };
        match name {
            "q" if search.is_none() => search = Some(value),
            "kind" if kind.is_none() => kind = Some(value),
            _ => return false,
        }
    }
    let Some(search) = search else {
        return false;
    };
    kind.as_deref() == Some("track")
        && !search.trim().is_empty()
        && search.len() <= MAX_SPOTIFY_SEARCH_QUERY_BYTES
        && !search.chars().any(char::is_control)
}

fn decode_form_value(value: &str) -> Option<String> {
    let input = value.as_bytes();
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        match input[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < input.len() => {
                output.push((hex_value(input[index + 1])? << 4) | hex_value(input[index + 2])?);
                index += 3;
            }
            byte if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') => {
                output.push(byte);
                index += 1;
            }
            _ => return None,
        }
        if output.len() > MAX_SPOTIFY_SEARCH_QUERY_BYTES {
            return None;
        }
    }
    String::from_utf8(output).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Last-resort content-type guess when the Pin omits the header.
fn guess_content_type(path: &str) -> &'static str {
    if path.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".html") || path.ends_with('/') {
        "text/html; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

/// Status endpoint showing connection info (served locally, not proxied).
async fn status(State(state): State<Arc<BridgeState>>) -> impl IntoResponse {
    let connected = state.stream.lock().await.is_some();

    axum::Json(serde_json::json!({
        "local_endpoint_id": state.endpoint.id().to_string(),
        "remote_endpoint_id": state.node_addr.id.to_string(),
        "connected": connected,
        "generation": state.generation,
        "protocol": PROTOCOL_VERSION,
    }))
}

#[derive(Parser, Debug)]
#[command(name = "center-iroh-bridge")]
#[command(about = "Mac helper: exposes Ai Pin Setup over iroh P2P")]
struct Args {
    /// The EndpointTicket from the Pin (GET /api/iroh/ticket). Base64-encoded;
    /// contains the Pin's EndpointId and relay/direct addresses.
    #[arg(long, short)]
    ticket: String,

    /// Local port to serve Center on. Binds to loopback only.
    #[arg(long, short, default_value = "18080")]
    port: u16,

    /// Generation counter for the remote protocol; must match the Pin's.
    #[arg(long, default_value = "1")]
    generation: u64,

    /// Where to persist this bridge's iroh secret key.
    ///
    /// Without it the bridge gets a fresh identity on every restart, so the Pin
    /// cannot allowlist it — and an allowlist is the only thing standing
    /// between a full-access tunnel and anyone who learns the Pin's
    /// EndpointId. With it, this bridge has a stable EndpointId to pin.
    #[arg(long, default_value = "/etc/penumbra/bridge_secret.key")]
    secret_key_file: String,

    /// Local defense-in-depth route policy. Keep compatibility during rollout;
    /// switch to reviewed after the Center adapter and typed Pin release are
    /// both deployed and the Pin's full-access mode has been disabled.
    #[arg(long, value_enum, default_value_t)]
    proxy_policy: ProxyPolicy,
}

/// Load a 32-byte iroh secret key, creating it `0600` on first run.
///
/// Mirrors what the Pin does for its own identity. Any I/O problem is
/// non-fatal: we fall back to an ephemeral key so the tunnel still works, just
/// without a pinnable identity.
fn load_or_create_secret_key(path: &std::path::Path) -> std::io::Result<iroh::SecretKey> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() == 32 => {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Ok(iroh::SecretKey::from_bytes(&key))
        }
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "secret key file is not 32 bytes",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let secret = iroh::SecretKey::generate();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, secret.to_bytes())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            }
            Ok(secret)
        }
        Err(error) => Err(error),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();

    // Parse the EndpointTicket and extract the Pin's dialable address.
    let ticket = EndpointTicket::from_str(&args.ticket)
        .map_err(|e| format!("invalid EndpointTicket: {e}"))?;
    let node_addr = ticket.endpoint_addr().clone();

    info!("Pin EndpointId: {}", node_addr.id);
    info!(
        "Pin relays: {:?}",
        node_addr.relay_urls().collect::<Vec<_>>()
    );
    info!(
        "Pin direct addrs: {:?}",
        node_addr.ip_addrs().collect::<Vec<_>>()
    );

    // Create our own iroh endpoint using the n0 relay + DNS discovery preset,
    // matching the Pin so relay-assisted NAT traversal works out of the box.
    let mut builder = Endpoint::builder(iroh::endpoint::presets::N0).alpns(vec![ALPN.to_vec()]);
    match load_or_create_secret_key(std::path::Path::new(&args.secret_key_file)) {
        Ok(secret) => builder = builder.secret_key(secret),
        Err(error) => error!(
            "could not persist bridge identity at {}: {error}; using an ephemeral key \
             (the Pin will not be able to allowlist this bridge)",
            args.secret_key_file
        ),
    }
    let endpoint = builder.bind().await?;

    // Stable across restarts once persisted — this is the value to put in the
    // Pin's `server.iroh_remote_center_allowed_peers`.
    info!(
        "bridge EndpointId (allowlist this on the Pin): {}",
        endpoint.id()
    );

    let state = Arc::new(BridgeState {
        stream: Mutex::new(None),
        endpoint,
        node_addr,
        generation: args.generation,
        proxy_policy: args.proxy_policy,
    });

    // Every request proxies to the Pin except the local status route. Using a
    // fallback (rather than a wildcard route) also catches the bare `/` path.
    let app = Router::new()
        .route("/__status", axum::routing::get(status))
        .fallback(proxy_request)
        .with_state(state);

    // Loopback only — never expose the tunnel on the LAN.
    let addr = SocketAddr::from(([127, 0, 0, 1], args.port));
    info!("listening on http://localhost:{}/setup/", args.port);
    info!("open your browser to access Ai Pin Setup");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install CTRL+C handler");
    info!("shutting down");
}

#[cfg(test)]
mod tests {
    use super::*;

    const B64: base64::engine::general_purpose::GeneralPurpose =
        base64::engine::general_purpose::STANDARD;

    /// The request we emit must deserialize into the Pin's `RemoteRequest`
    /// (`runtime/core/src/remote_center/iroh_connector.rs`). Its `idempotency_key`
    /// is `#[serde(default)]`, so omitting the field for GET is accepted.
    #[test]
    fn request_serializes_with_the_fields_the_pin_expects() {
        let req = RemoteRequest {
            protocol: PROTOCOL_VERSION.to_string(),
            request_id: "req-1".to_string(),
            generation: 1,
            method: "GET".to_string(),
            path: "/center/index.html".to_string(),
            idempotency_key: None,
            content_type: None,
            body_base64: None,
        };
        let value: serde_json::Value = serde_json::from_slice(&serde_json::to_vec(&req).unwrap())
            .expect("request serializes to JSON");

        assert_eq!(value["protocol"], PROTOCOL_VERSION);
        assert_eq!(value["request_id"], "req-1");
        assert_eq!(value["generation"], 1);
        assert_eq!(value["method"], "GET");
        assert_eq!(value["path"], "/center/index.html");
        // GET is idempotent: the key is skipped entirely, not sent as null.
        assert!(
            value.get("idempotency_key").is_none(),
            "GET must omit idempotency_key so the Pin's ledger treats it as a plain read"
        );
        // A bodyless read omits body fields entirely (not sent as null).
        assert!(value.get("body_base64").is_none());
        assert!(value.get("content_type").is_none());
    }

    #[test]
    fn non_idempotent_request_carries_an_idempotency_key() {
        let req = RemoteRequest {
            protocol: PROTOCOL_VERSION.to_string(),
            request_id: "req-2".to_string(),
            generation: 1,
            method: "POST".to_string(),
            path: "/api/thing".to_string(),
            idempotency_key: Some("req-2".to_string()),
            content_type: None,
            body_base64: None,
        };
        let value: serde_json::Value =
            serde_json::from_slice(&serde_json::to_vec(&req).unwrap()).unwrap();
        assert_eq!(value["idempotency_key"], "req-2");
    }

    #[test]
    fn write_request_carries_body_and_content_type() {
        let payload = br#"{"server":{"lan_dashboard_enabled":true}}"#;
        let req = RemoteRequest {
            protocol: PROTOCOL_VERSION.to_string(),
            request_id: "req-3".to_string(),
            generation: 1,
            method: "PUT".to_string(),
            path: "/api/settings".to_string(),
            idempotency_key: Some("req-3".to_string()),
            content_type: Some("application/json".to_string()),
            body_base64: Some(B64.encode(payload)),
        };
        let value: serde_json::Value =
            serde_json::from_slice(&serde_json::to_vec(&req).unwrap()).unwrap();
        assert_eq!(value["content_type"], "application/json");
        // The Pin decodes body_base64 back to the exact request bytes.
        let decoded = B64.decode(value["body_base64"].as_str().unwrap()).unwrap();
        assert_eq!(decoded, payload);
    }

    /// A response shaped exactly as the Pin's `send_response` emits it must
    /// parse, and the base64 body must decode back to the original bytes.
    #[test]
    fn parses_a_pin_shaped_text_response() {
        let pin_json = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "request_id": "req-1",
            "generation": 1,
            "status": 200,
            "content_type": "text/html; charset=utf-8",
            "body_base64": B64.encode(b"<html>OK</html>"),
        })
        .to_string();

        let resp: RemoteResponse = serde_json::from_str(&pin_json).unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(
            resp.content_type.as_deref(),
            Some("text/html; charset=utf-8")
        );
        let body = B64.decode(resp.body_base64.unwrap()).unwrap();
        assert_eq!(body, b"<html>OK</html>");
    }

    /// The reason the body is base64 at all: binary assets (logo.png,
    /// ai-pin.webp) must survive the JSON envelope byte-for-byte.
    #[test]
    fn binary_body_round_trips_through_base64() {
        // PNG magic + a NUL and high bytes that would corrupt a raw JSON string.
        let raw: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe,
        ];
        let pin_json = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "request_id": "req-img",
            "generation": 1,
            "status": 200,
            "content_type": "image/png",
            "body_base64": B64.encode(raw),
        })
        .to_string();

        let resp: RemoteResponse = serde_json::from_str(&pin_json).unwrap();
        let decoded = B64.decode(resp.body_base64.unwrap()).unwrap();
        assert_eq!(decoded, raw, "binary asset must decode identically");
    }

    /// `content_type`/`body_base64` are `#[serde(default)]` on the Pin; an
    /// error response with an empty body (or a bodyless 204) must still parse.
    #[test]
    fn tolerates_missing_optional_fields() {
        let pin_json = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "request_id": "req-3",
            "generation": 1,
            "status": 204,
        })
        .to_string();
        let resp: RemoteResponse = serde_json::from_str(&pin_json).unwrap();
        assert_eq!(resp.status, 204);
        assert!(resp.content_type.is_none());
        assert!(resp.body_base64.is_none());
    }

    #[test]
    fn content_type_guess_is_a_last_resort_only() {
        assert_eq!(
            guess_content_type("/center/app.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            guess_content_type("/center/app.css"),
            "text/css; charset=utf-8"
        );
        assert_eq!(guess_content_type("/center/icons.svg"), "image/svg+xml");
        assert_eq!(guess_content_type("/center/img/logo.png"), "image/png");
        assert_eq!(
            guess_content_type("/center/install/ai-pin.webp"),
            "image/webp"
        );
        assert_eq!(guess_content_type("/center/"), "text/html; charset=utf-8");
        assert_eq!(
            guess_content_type("/center/index.html"),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            guess_content_type("/api/health"),
            "application/octet-stream"
        );
    }

    #[test]
    fn reviewed_bridge_policy_allows_only_typed_spotify_surface() {
        let empty_headers = HeaderMap::new();
        assert!(reviewed_route_allowed(
            &Method::GET,
            &Uri::from_static("/api/spotify/status"),
            &empty_headers,
            0,
        ));
        assert!(reviewed_route_allowed(
            &Method::GET,
            &Uri::from_static("/api/spotify/search?q=No+Surprises&kind=track"),
            &empty_headers,
            0,
        ));
        for uri in [
            "/api/spotify/search?q=No+Surprises&kind=artist",
            "/api/spotify/search?q=No+Surprises&kind=track&extra=1",
            "/api/spotify/diagnostics/track/example",
            "/api/spotify/status/extra",
        ] {
            assert!(!reviewed_route_allowed(
                &Method::GET,
                &uri.parse().unwrap(),
                &empty_headers,
                0,
            ));
        }

        let mut json_headers = HeaderMap::new();
        json_headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        assert!(reviewed_route_allowed(
            &Method::PUT,
            &Uri::from_static("/api/spotify/settings"),
            &json_headers,
            MAX_SPOTIFY_SETTINGS_BODY_BYTES,
        ));
        assert!(!reviewed_route_allowed(
            &Method::PUT,
            &Uri::from_static("/api/spotify/settings"),
            &json_headers,
            MAX_SPOTIFY_SETTINGS_BODY_BYTES + 1,
        ));
        assert!(!reviewed_route_allowed(
            &Method::POST,
            &Uri::from_static("/api/spotify/settings"),
            &json_headers,
            1,
        ));
    }

    #[test]
    fn reviewed_bridge_policy_preserves_setup_assets_and_core_reads() {
        let headers = HeaderMap::new();
        for (method, uri) in [
            (Method::GET, "/setup/"),
            (Method::HEAD, "/setup/assets/app.js"),
            (Method::GET, "/center/index.html"),
            (Method::GET, "/api/health"),
            (Method::GET, "/api/device"),
            (Method::GET, "/api/feature-flags"),
        ] {
            assert!(reviewed_route_allowed(
                &method,
                &uri.parse().unwrap(),
                &headers,
                0,
            ));
        }
        assert!(!reviewed_route_allowed(
            &Method::GET,
            &Uri::from_static("/api/logs/server"),
            &headers,
            0,
        ));
    }
}
