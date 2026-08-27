//! Setup iroh bridge — exposes a Pin's remote Center API over local HTTP.
//!
//! Connects to a Pin's iroh endpoint using an EndpointTicket and exposes the
//! Setup dashboard on a local HTTP port. It defaults to loopback for direct
//! use; the container deployment explicitly binds its private Compose network.
//! iroh handles NAT traversal automatically via the n0 relay and DNS discovery.
//!
//! Usage:
//! 1. On the Pin: enable `[server] iroh_remote_center_enabled = true`.
//! 2. Fetch the ticket once (over LAN or `adb forward`) from
//!    `GET /api/iroh/ticket`; it returns
//!    `{ "ticket": "<EndpointTicket>", "node_id": "..." }`.
//! 3. Save the ticket in a protected file, then run
//!    `cargo run -- --ticket-file /path/to/iroh-ticket`.
//! 4. Open `http://localhost:18080/setup/` in your browser.
//!
//! The ticket is the sole Pin dial credential; the iroh connection is
//! end-to-end encrypted to the Pin's key, and the Pin applies its route policy.

use std::future::Future;
use std::io::Write as _;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::Engine as _;
use clap::Parser;
use iroh::{Endpoint, EndpointAddr};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::time::Instant;
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
const MAX_MUSIC_EGRESS_BODY_BYTES: usize = 1024 * 1024;
const MAX_TICKET_BYTES: usize = 16 * 1024;

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
#[derive(Debug, Deserialize, Serialize)]
struct RemoteResponse {
    protocol: String,
    request_id: String,
    generation: u64,
    status: u16,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    body_base64: Option<String>,
}

type BridgeError = Box<dyn std::error::Error + Send + Sync>;

async fn wire_roundtrip<W, R>(
    send: &mut W,
    recv: &mut R,
    request: &RemoteRequest,
) -> Result<RemoteResponse, BridgeError>
where
    W: AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
{
    let request_json = serde_json::to_vec(request)?;
    let request_len = u32::try_from(request_json.len())?.to_be_bytes();
    send.write_all(&request_len).await?;
    send.write_all(&request_json).await?;
    send.flush().await?;

    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf).await?;
    let response_len = u32::from_be_bytes(len_buf) as usize;
    if response_len > MAX_RESPONSE_BYTES {
        return Err(format!("response too large: {response_len} bytes").into());
    }

    let mut response_buf = vec![0u8; response_len];
    recv.read_exact(&mut response_buf).await?;
    let response: RemoteResponse = serde_json::from_slice(&response_buf)?;
    if response.protocol != PROTOCOL_VERSION {
        return Err("response protocol does not match the request".into());
    }
    if response.request_id != request.request_id {
        return Err("response request_id does not match the request".into());
    }
    if response.generation != request.generation {
        return Err("response generation does not match the request".into());
    }
    Ok(response)
}

/// Shared state between the HTTP server and the iroh connection.
struct BridgeState {
    /// One shared QUIC connection to the Pin. Each request opens its own
    /// bidirectional stream after releasing this mutex, so independent provider
    /// calls cannot consume one another's deadline while waiting in a queue.
    connection: Mutex<Option<iroh::endpoint::Connection>>,
    endpoint: Endpoint,
    node_addr: EndpointAddr,
    generation: u64,
}

impl BridgeState {
    async fn shared_connection(&self) -> Result<iroh::endpoint::Connection, BridgeError> {
        let mut cached = self.connection.lock().await;
        if let Some(connection) = cached.as_ref() {
            return Ok(connection.clone());
        }

        info!("connecting to Pin via iroh...");
        let connection = self.endpoint.connect(self.node_addr.clone(), ALPN).await?;
        info!(
            "connected to Pin (remote endpoint: {})",
            connection.remote_id()
        );
        *cached = Some(connection.clone());
        Ok(connection)
    }

    async fn clear_connection_if_current(&self, stable_id: usize) {
        let mut cached = self.connection.lock().await;
        if cached
            .as_ref()
            .is_some_and(|connection| connection.stable_id() == stable_id)
        {
            *cached = None;
        }
    }

    /// Open an independent stream, then write and read one complete correlated
    /// response. A failed old clone cannot evict a newer replacement connection.
    async fn roundtrip(&self, request: RemoteRequest) -> Result<RemoteResponse, BridgeError> {
        let connection = self.shared_connection().await?;
        let stable_id = connection.stable_id();
        let result = async {
            let (mut send, mut recv) = connection.open_bi().await?;
            wire_roundtrip(&mut send, &mut recv, &request).await
        }
        .await;
        if result.is_err() {
            self.clear_connection_if_current(stable_id).await;
        }
        result
    }
}

/// Run the initial exchange and one transparent reconnect under one deadline.
async fn with_reconnect_retry<T, F, Fut>(
    total_timeout: Duration,
    mut attempt: F,
) -> Result<T, BridgeError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, BridgeError>>,
{
    let deadline = Instant::now() + total_timeout;
    match tokio::time::timeout_at(deadline, async {
        let mut last_error = None;
        for attempt_index in 0..2 {
            if Instant::now() >= deadline {
                return Err("Pin request exceeded its total timeout".into());
            }
            match attempt().await {
                Ok(response) => return Ok(response),
                Err(error) => {
                    if attempt_index == 0 {
                        warn!("roundtrip failed ({error}); reconnecting and retrying");
                    }
                    last_error = Some(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| "Pin request did not run".into()))
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("Pin request exceeded its total timeout".into()),
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
    if !reviewed_route_allowed(&method, &uri, &headers, body.len()) {
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
        // Only non-idempotent methods contain a key; the Pin's ledger uses it to
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
    // connection dies: the first attempt fails and clears it, the second redials.
    // Without this a Pin restart wedges the bridge into permanent 502s.
    let response = with_reconnect_retry(REQUEST_TIMEOUT, || state.roundtrip(request.clone())).await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            error!("roundtrip failed after retry: {error}");
            return (
                StatusCode::BAD_GATEWAY,
                format!("Pin request failed: {error}\n"),
            )
                .into_response();
        }
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

    if uri.query().is_none()
        && bodyless
        && no_content_type
        && *method == Method::GET
        && matches!(
            path,
            "/api/health" | "/api/device" | "/api/feature-flags" | "/api/spotify/status"
        )
    {
        return true;
    }

    match (method, path, uri.query()) {
        (&Method::POST, "/api/music/egress", None) => {
            body_bytes <= MAX_MUSIC_EGRESS_BODY_BYTES
                && headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    == Some("application/json")
        }
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
    // Liveness describes this bridge process, not whether the physical Pin is
    // online. `try_lock` also keeps the probe responsive while a request is
    // establishing or replacing the shared connection.
    let connected = state
        .connection
        .try_lock()
        .map(|connection| connection.is_some())
        .unwrap_or(false);

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
#[command(about = "Exposes Ai Pin Setup over an authenticated iroh connection")]
struct Args {
    /// File containing the EndpointTicket from the Pin (GET /api/iroh/ticket).
    /// The credential itself is never accepted through argv or the environment.
    #[arg(long, default_value = "/run/secrets/iroh_ticket")]
    ticket_file: PathBuf,

    /// IP address on which the local HTTP server listens.
    #[arg(long, default_value = "127.0.0.1")]
    listen_ip: IpAddr,

    /// Local port to serve Center on.
    #[arg(long, short, default_value = "18080")]
    port: u16,

    /// Generation counter for the remote protocol; must match the Pin's.
    #[arg(long, default_value = "1")]
    generation: u64,

    /// Where to persist this bridge's iroh secret key.
    ///
    /// Without it the bridge gets a fresh identity on every restart, so the Pin
    /// cannot authorize it. With it, this bridge has a stable EndpointId.
    #[arg(long, default_value = "/var/lib/center-iroh-bridge/endpoint.key")]
    secret_key_file: PathBuf,
}

/// Read the Pin credential from a file without ever placing it in argv or env.
fn read_ticket_file(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    if bytes.is_empty() || bytes.len() > MAX_TICKET_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "endpoint ticket file is empty or too large",
        ));
    }
    let source = std::str::from_utf8(&bytes).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "endpoint ticket file is not UTF-8",
        )
    })?;
    let ticket = source
        .strip_suffix("\r\n")
        .or_else(|| source.strip_suffix('\n'))
        .unwrap_or(source);
    if ticket.is_empty() || ticket.bytes().any(|byte| !(0x21..=0x7e).contains(&byte)) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "endpoint ticket file must contain one visible ASCII value",
        ));
    }
    Ok(ticket.to_owned())
}

/// Load a 32-byte iroh secret key, creating it `0600` on first run.
///
/// A stable endpoint identity is part of the Pin's allowlist boundary, so an
/// unreadable or unwritable key is fatal rather than an excuse to use a new
/// ephemeral identity.
fn load_or_create_secret_key(path: &Path) -> std::io::Result<iroh::SecretKey> {
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
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut file = options.open(path)?;
            file.write_all(&secret.to_bytes())?;
            file.sync_all()?;
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
    let ticket_value = read_ticket_file(&args.ticket_file)
        .map_err(|error| format!("cannot read endpoint ticket file: {error}"))?;
    let ticket = EndpointTicket::from_str(&ticket_value)
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
    let secret = load_or_create_secret_key(&args.secret_key_file)
        .map_err(|error| format!("cannot load persistent bridge identity: {error}"))?;
    let builder = Endpoint::builder(iroh::endpoint::presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .secret_key(secret);
    let endpoint = builder.bind().await?;

    // Stable across restarts once persisted — this is the value to put in the
    // Pin's `server.iroh_remote_center_allowed_peers`.
    info!(
        "bridge EndpointId (allowlist this on the Pin): {}",
        endpoint.id()
    );

    let state = Arc::new(BridgeState {
        connection: Mutex::new(None),
        endpoint,
        node_addr,
        generation: args.generation,
    });

    // Every request proxies to the Pin except the local status route. Using a
    // fallback (rather than a wildcard route) also catches the bare `/` path.
    let app = Router::new()
        .route("/__status", axum::routing::get(status))
        .fallback(proxy_request)
        .with_state(state);

    let addr = SocketAddr::new(args.listen_ip, args.port);
    info!(
        "listening on http://{}:{}/setup/",
        args.listen_ip, args.port
    );
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

    fn temporary_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!("center-iroh-bridge-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        directory
    }

    #[test]
    fn command_line_defaults_to_loopback_and_file_backed_credentials() {
        let args = Args::try_parse_from(["center-iroh-bridge"]).unwrap();
        assert_eq!(args.listen_ip, IpAddr::from([127, 0, 0, 1]));
        assert_eq!(args.port, 18_080);
        assert_eq!(args.ticket_file, Path::new("/run/secrets/iroh_ticket"));
        assert_eq!(
            args.secret_key_file,
            Path::new("/var/lib/center-iroh-bridge/endpoint.key")
        );
        assert!(Args::try_parse_from(["center-iroh-bridge", "--ticket", "secret"]).is_err());
    }

    #[test]
    fn ticket_is_read_only_from_one_bounded_secret_file() {
        let directory = temporary_directory();
        let ticket = directory.join("ticket");
        std::fs::write(&ticket, b"endpoint-ticket-value\n").unwrap();
        assert_eq!(read_ticket_file(&ticket).unwrap(), "endpoint-ticket-value");

        std::fs::write(&ticket, b"two\nlines\n").unwrap();
        assert!(read_ticket_file(&ticket).is_err());
        std::fs::write(&ticket, vec![b'x'; MAX_TICKET_BYTES + 1]).unwrap();
        assert!(read_ticket_file(&ticket).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn endpoint_key_is_persistent_and_invalid_state_is_fatal() {
        let directory = temporary_directory();
        let key_file = directory.join("endpoint.key");
        let first = load_or_create_secret_key(&key_file).unwrap();
        let second = load_or_create_secret_key(&key_file).unwrap();
        assert_eq!(first.to_bytes(), second.to_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&key_file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        std::fs::write(&key_file, b"not-a-32-byte-key").unwrap();
        assert!(load_or_create_secret_key(&key_file).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

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

    fn correlated_wire_request_with_id(request_id: &str) -> RemoteRequest {
        RemoteRequest {
            protocol: PROTOCOL_VERSION.to_string(),
            request_id: request_id.to_string(),
            generation: 7,
            method: "GET".to_string(),
            path: "/api/spotify/status".to_string(),
            idempotency_key: None,
            content_type: None,
            body_base64: None,
        }
    }

    fn correlated_wire_request() -> RemoteRequest {
        correlated_wire_request_with_id("wire-request-1")
    }

    async fn answer_iroh_request(
        (mut send, mut recv): (iroh::endpoint::SendStream, iroh::endpoint::RecvStream),
    ) {
        let mut request_len = [0u8; 4];
        recv.read_exact(&mut request_len).await.unwrap();
        let mut request = vec![0u8; u32::from_be_bytes(request_len) as usize];
        recv.read_exact(&mut request).await.unwrap();
        let request: serde_json::Value = serde_json::from_slice(&request).unwrap();
        let response = RemoteResponse {
            protocol: request["protocol"].as_str().unwrap().to_string(),
            request_id: request["request_id"].as_str().unwrap().to_string(),
            generation: request["generation"].as_u64().unwrap(),
            status: 200,
            content_type: Some("application/json".to_string()),
            body_base64: Some(B64.encode(b"{}")),
        };
        let encoded = serde_json::to_vec(&response).unwrap();
        send.write_all(&u32::try_from(encoded.len()).unwrap().to_be_bytes())
            .await
            .unwrap();
        send.write_all(&encoded).await.unwrap();
        send.finish().unwrap();
    }

    async fn exchange_test_response(
        response: RemoteResponse,
    ) -> Result<RemoteResponse, BridgeError> {
        let (client, server) = tokio::io::duplex(4096);
        let (mut client_read, mut client_write) = tokio::io::split(client);
        tokio::spawn(async move {
            let (mut server_read, mut server_write) = tokio::io::split(server);
            let mut request_len = [0u8; 4];
            server_read.read_exact(&mut request_len).await.unwrap();
            let mut request = vec![0u8; u32::from_be_bytes(request_len) as usize];
            server_read.read_exact(&mut request).await.unwrap();
            let encoded = serde_json::to_vec(&response).unwrap();
            server_write
                .write_all(&u32::try_from(encoded.len()).unwrap().to_be_bytes())
                .await
                .unwrap();
            server_write.write_all(&encoded).await.unwrap();
        });
        wire_roundtrip(
            &mut client_write,
            &mut client_read,
            &correlated_wire_request(),
        )
        .await
    }

    #[tokio::test]
    async fn wire_response_must_match_protocol_request_and_generation() {
        let matching = RemoteResponse {
            protocol: PROTOCOL_VERSION.to_string(),
            request_id: "wire-request-1".to_string(),
            generation: 7,
            status: 200,
            content_type: Some("application/json".to_string()),
            body_base64: Some(B64.encode(b"{}")),
        };
        assert_eq!(exchange_test_response(matching).await.unwrap().status, 200);

        for mismatched in [
            RemoteResponse {
                protocol: "wrong-protocol".to_string(),
                request_id: "wire-request-1".to_string(),
                generation: 7,
                status: 200,
                content_type: None,
                body_base64: None,
            },
            RemoteResponse {
                protocol: PROTOCOL_VERSION.to_string(),
                request_id: "other-request".to_string(),
                generation: 7,
                status: 200,
                content_type: None,
                body_base64: None,
            },
            RemoteResponse {
                protocol: PROTOCOL_VERSION.to_string(),
                request_id: "wire-request-1".to_string(),
                generation: 8,
                status: 200,
                content_type: None,
                body_base64: None,
            },
        ] {
            assert!(exchange_test_response(mismatched).await.is_err());
        }
    }

    #[tokio::test]
    async fn concurrent_roundtrips_use_independent_streams_on_one_connection() {
        let server = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let client = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .bind()
            .await
            .unwrap();
        let state = BridgeState {
            connection: Mutex::new(None),
            endpoint: client.clone(),
            node_addr: server.addr(),
            generation: 7,
        };
        let (release_server, server_released) = tokio::sync::oneshot::channel();
        let server_endpoint = server.clone();
        let server_task = tokio::spawn(async move {
            let incoming = server_endpoint.accept().await.unwrap();
            let connection = incoming.await.unwrap();

            // Do not answer either request until both streams have delivered
            // data. A globally serialized bridge can never cross this gate.
            let first = connection.accept_bi().await.unwrap();
            let second = connection.accept_bi().await.unwrap();
            tokio::join!(answer_iroh_request(first), answer_iroh_request(second));
            let _ = server_released.await;
        });

        let completed = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(
                state.roundtrip(correlated_wire_request_with_id("concurrent-1")),
                state.roundtrip(correlated_wire_request_with_id("concurrent-2")),
            )
        })
        .await
        .expect("both requests must reach the Pin before either response is sent");
        assert_eq!(completed.0.unwrap().request_id, "concurrent-1");
        assert_eq!(completed.1.unwrap().request_id, "concurrent-2");

        let connection_id = state.connection.lock().await.as_ref().unwrap().stable_id();
        state
            .clear_connection_if_current(connection_id.wrapping_add(1))
            .await;
        assert_eq!(
            state.connection.lock().await.as_ref().unwrap().stable_id(),
            connection_id,
            "a late failure from an old connection must not clear its replacement",
        );
        state.clear_connection_if_current(connection_id).await;
        assert!(state.connection.lock().await.is_none());

        release_server.send(()).unwrap();
        server_task.await.unwrap();
        client.close().await;
        server.close().await;
    }

    #[tokio::test]
    async fn one_deadline_covers_a_stalled_full_response_body() {
        let (client, server) = tokio::io::duplex(4096);
        let (mut client_read, mut client_write) = tokio::io::split(client);
        tokio::spawn(async move {
            let (mut server_read, mut server_write) = tokio::io::split(server);
            let mut request_len = [0u8; 4];
            server_read.read_exact(&mut request_len).await.unwrap();
            let mut request = vec![0u8; u32::from_be_bytes(request_len) as usize];
            server_read.read_exact(&mut request).await.unwrap();
            server_write.write_all(&32_u32.to_be_bytes()).await.unwrap();
            server_write.write_all(b"{").await.unwrap();
            server_write.flush().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            wire_roundtrip(
                &mut client_write,
                &mut client_read,
                &correlated_wire_request(),
            ),
        )
        .await;
        assert!(
            result.is_err(),
            "the partial response must not escape the total deadline"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_retry_spends_one_total_deadline() {
        let budget = Duration::from_secs(3);
        let started = Instant::now();
        let mut attempts = 0;

        let result: Result<(), BridgeError> = with_reconnect_retry(budget, || {
            attempts += 1;
            let attempt = attempts;
            async move {
                if attempt == 1 {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    return Err("first attempt failed".into());
                }
                std::future::pending().await
            }
        })
        .await;

        assert_eq!(
            result.unwrap_err().to_string(),
            "Pin request exceeded its total timeout"
        );
        assert_eq!(attempts, 2, "one transparent reconnect must remain");
        assert_eq!(
            Instant::now().duration_since(started),
            budget,
            "the retry must inherit the first attempt's remaining budget"
        );
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
    fn reviewed_bridge_policy_allows_only_the_exact_music_egress_write() {
        let mut json_headers = HeaderMap::new();
        json_headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        assert!(reviewed_route_allowed(
            &Method::POST,
            &Uri::from_static("/api/music/egress"),
            &json_headers,
            MAX_MUSIC_EGRESS_BODY_BYTES,
        ));
        assert!(!reviewed_route_allowed(
            &Method::POST,
            &Uri::from_static("/api/music/egress"),
            &json_headers,
            MAX_MUSIC_EGRESS_BODY_BYTES + 1,
        ));
        for (method, uri) in [
            (Method::GET, "/api/music/egress"),
            (Method::POST, "/api/music/egress/"),
            (Method::POST, "/api/music/egress?target=other"),
            (Method::POST, "/api/music/proxy"),
        ] {
            assert!(!reviewed_route_allowed(
                &method,
                &uri.parse().unwrap(),
                &json_headers,
                2,
            ));
        }
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
