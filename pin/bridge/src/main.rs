//! Setup iroh bridge, exposes a Pin's remote Center API over local HTTP.
//!
//! It starts safely without a Pin assignment. Authenticated Center setup then
//! gives it one Pin EndpointTicket over the private control route. The bridge
//! persists that assignment beside its stable endpoint identity and reconnects
//! transparently after either side restarts. The container deployment binds
//! only its private Compose network. Iroh handles NAT traversal through the n0
//! relay and DNS discovery.
//!
//! The ticket is the sole Pin dial credential. The iroh connection is
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
use axum::routing::{get, put};
use axum::{Json, Router};
use base64::Engine as _;
use clap::Parser;
use iroh::{Endpoint, EndpointAddr};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, RwLock};
use tokio::time::Instant;
use tracing::{error, info, warn};
use uuid::Uuid;

const PROTOCOL_VERSION: &str = "penumbra-remote-center-v1";
const ALPN: &[u8] = b"penumbra-center";
/// The Pin caps response bodies at 8 MiB. Base64 inflates by ~4/3 and the JSON
/// envelope adds a little more, so allow generous headroom.
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SPOTIFY_SETTINGS_BODY_BYTES: usize = 512;
const MAX_SPOTIFY_SEARCH_QUERY_BYTES: usize = 256;
const MAX_MUSIC_EGRESS_BODY_BYTES: usize = 1024 * 1024;
const MAX_TICKET_BYTES: usize = 16 * 1024;
const MAX_CONTROL_BODY_BYTES: usize = 20 * 1024;
const MIN_CONTROL_TOKEN_BYTES: usize = 32;
const MAX_CONTROL_TOKEN_BYTES: usize = 512;
const ASSIGNMENT_SCHEMA_VERSION: u8 = 1;

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
    target: RwLock<Option<BridgeTarget>>,
    assignment_file: PathBuf,
    control_token: Vec<u8>,
    generation: u64,
}

#[derive(Clone)]
struct BridgeTarget {
    device_id: String,
    node_addr: EndpointAddr,
    /// Lets one request dial this assignment while the others wait to share
    /// its connection. Every assignment gets its own, so a dial still waiting
    /// on a replaced, offline Pin never delays the first dial to the new one.
    dial: Arc<Mutex<()>>,
}

impl BridgeTarget {
    fn new(device_id: String, node_addr: EndpointAddr) -> Self {
        Self {
            device_id,
            node_addr,
            dial: Arc::new(Mutex::new(())),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedAssignment {
    schema_version: u8,
    device_id: String,
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairRequest {
    device_id: String,
    ticket: String,
}

impl BridgeState {
    /// The dial holds neither the target lock nor the connection cache: a dial
    /// to an offline Pin can take the whole request deadline, and pairing a
    /// replacement Pin or reading the control status must never queue behind
    /// it. Only the assignment's own dial gate is held across the dial.
    async fn shared_connection(&self) -> Result<iroh::endpoint::Connection, BridgeError> {
        let assignment = self
            .target
            .read()
            .await
            .clone()
            .ok_or("the bridge has not been paired with a Pin")?;
        if let Some(connection) = self.connection.lock().await.as_ref() {
            return Ok(connection.clone());
        }
        let _dialing = assignment.dial.lock().await;
        if let Some(connection) = self.connection.lock().await.as_ref() {
            return Ok(connection.clone());
        }

        info!("connecting to Pin via iroh...");
        let connection = self.endpoint.connect(assignment.node_addr, ALPN).await?;

        // pair_target replaces the target and clears the cache under the
        // target lock, so a connection cached here always belongs to the
        // current assignment.
        let target = self.target.read().await;
        if !target
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.dial, &assignment.dial))
        {
            connection.close(0u32.into(), b"bridge target replaced");
            return Err("the bridge was paired with another Pin during the connection".into());
        }
        info!(
            "connected to Pin (remote endpoint: {})",
            connection.remote_id()
        );
        *self.connection.lock().await = Some(connection.clone());
        drop(target);
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

fn valid_device_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn parse_ticket_value(value: &str) -> Result<EndpointTicket, String> {
    if value.is_empty()
        || value.len() > MAX_TICKET_BYTES
        || value.bytes().any(|byte| !(0x21..=0x7e).contains(&byte))
    {
        return Err("endpoint ticket must contain one bounded visible ASCII value".into());
    }
    EndpointTicket::from_str(value).map_err(|_| "invalid EndpointTicket".into())
}

fn assignment_target(assignment: &PersistedAssignment) -> Result<BridgeTarget, String> {
    if assignment.schema_version != ASSIGNMENT_SCHEMA_VERSION
        || !valid_device_id(&assignment.device_id)
    {
        return Err("invalid persisted bridge assignment".into());
    }
    let ticket = parse_ticket_value(&assignment.ticket)?;
    Ok(BridgeTarget::new(
        assignment.device_id.clone(),
        ticket.endpoint_addr().clone(),
    ))
}

fn read_assignment(path: &Path) -> Result<Option<(PersistedAssignment, BridgeTarget)>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read persisted bridge assignment: {error}")),
    };
    if bytes.is_empty() || bytes.len() > MAX_CONTROL_BODY_BYTES {
        return Err("persisted bridge assignment is empty or too large".into());
    }
    let assignment: PersistedAssignment = serde_json::from_slice(&bytes)
        .map_err(|_| "persisted bridge assignment is invalid JSON")?;
    let target = assignment_target(&assignment)?;
    Ok(Some((assignment, target)))
}

fn persist_assignment(path: &Path, assignment: &PersistedAssignment) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("bridge assignment path has no parent")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create bridge state directory: {error}"))?;
    let bytes = serde_json::to_vec(assignment)
        .map_err(|error| format!("cannot encode bridge assignment: {error}"))?;
    let temporary = parent.join(format!(".assignment-{}.tmp", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("cannot persist bridge assignment: {error}"))
}

fn read_control_token(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = std::fs::read(path)
        .map_err(|error| format!("cannot read bridge control token file: {error}"))?;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    if !(MIN_CONTROL_TOKEN_BYTES..=MAX_CONTROL_TOKEN_BYTES).contains(&bytes.len())
        || bytes.iter().any(|byte| !(0x21..=0x7e).contains(byte))
    {
        return Err(format!(
            "bridge control token must be {MIN_CONTROL_TOKEN_BYTES}-{MAX_CONTROL_TOKEN_BYTES} visible ASCII bytes"
        ));
    }
    Ok(bytes)
}

fn authorized_control(headers: &HeaderMap, expected: &[u8]) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .map(|value| value.as_bytes())
    else {
        return false;
    };
    let Some(presented) = value.strip_prefix(b"Bearer ") else {
        return false;
    };
    presented.len() == expected.len() && bool::from(presented.ct_eq(expected))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn control_status(State(state): State<Arc<BridgeState>>, headers: HeaderMap) -> Response {
    if !authorized_control(&headers, &state.control_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let target = state.target.read().await;
    let connected = state
        .connection
        .try_lock()
        .map(|connection| connection.is_some())
        .unwrap_or(false);
    Json(serde_json::json!({
        "schema_version": ASSIGNMENT_SCHEMA_VERSION,
        "local_endpoint_id": state.endpoint.id().to_string(),
        "configured": target.is_some(),
        "device_id": target.as_ref().map(|target| target.device_id.as_str()),
        "remote_endpoint_id": target.as_ref().map(|target| target.node_addr.id.to_string()),
        "connected": connected,
        "generation": state.generation,
        "protocol": PROTOCOL_VERSION,
    }))
    .into_response()
}

async fn pair_target(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized_control(&headers, &state.control_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.is_empty() || body.len() > MAX_CONTROL_BODY_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "invalid bridge assignment\n").into_response();
    }
    let request: PairRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid bridge assignment\n").into_response(),
    };
    let device_id = request.device_id.trim().to_ascii_lowercase();
    if request.device_id != device_id || !valid_device_id(&device_id) {
        return (StatusCode::BAD_REQUEST, "invalid bridge assignment\n").into_response();
    }
    let ticket = match parse_ticket_value(&request.ticket) {
        Ok(ticket) => ticket,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid bridge assignment\n").into_response(),
    };
    let assignment = PersistedAssignment {
        schema_version: ASSIGNMENT_SCHEMA_VERSION,
        device_id: device_id.clone(),
        ticket: request.ticket,
    };
    if persist_assignment(&state.assignment_file, &assignment).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "bridge assignment was not saved\n",
        )
            .into_response();
    }
    {
        // Replace the target and drop the old connection in one step, so no
        // request can pair the new target with the old Pin's connection.
        let mut target = state.target.write().await;
        *target = Some(BridgeTarget::new(
            device_id.clone(),
            ticket.endpoint_addr().clone(),
        ));
        *state.connection.lock().await = None;
    }
    info!(device_id = %device_id, remote_endpoint = %ticket.endpoint_addr().id, "paired bridge with Pin");
    control_status(State(state), headers).await
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

/// One attempt at `request`. The Pin's ledger refuses a request_id it has seen
/// as a replay, so every attempt gets its own. The idempotency key stays the
/// same, so a retried read runs again and a retried write whose first attempt
/// already ran gets the Pin's own "duplicate request" answer.
fn next_attempt(request: &RemoteRequest) -> RemoteRequest {
    RemoteRequest {
        request_id: Uuid::new_v4().to_string(),
        ..request.clone()
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
        // Only non-idempotent methods contain a key. The Pin's ledger uses it to
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
    let response =
        with_reconnect_retry(REQUEST_TIMEOUT, || state.roundtrip(next_attempt(&request))).await;
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

    // Prefer the exact content type the Pin served. Fall back to a path-based
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
        (&Method::GET, "/api/activity/music", Some(query)) => {
            bodyless && no_content_type && valid_music_activity_query(query)
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

fn valid_music_activity_query(query: &str) -> bool {
    let mut limit = None;
    let mut before = None;
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            return false;
        };
        let Some(value) = decode_form_value(value) else {
            return false;
        };
        match name {
            "limit" if limit.is_none() => {
                let Ok(value) = value.parse::<usize>() else {
                    return false;
                };
                limit = Some(value);
            }
            "before" if before.is_none() => {
                let Ok(value) = value.parse::<i64>() else {
                    return false;
                };
                before = Some(value);
            }
            _ => return false,
        }
    }
    matches!(limit, Some(1..=100)) && before.is_none_or(|id| id > 0)
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

#[derive(Parser, Debug)]
#[command(name = "center-iroh-bridge")]
#[command(about = "Exposes Ai Pin Setup over an authenticated iroh connection")]
struct Args {
    /// Persisted assignment written only through the authenticated control route.
    #[arg(long, default_value = "/var/lib/center-iroh-bridge/assignment.json")]
    assignment_file: PathBuf,

    /// File containing the private control-route bearer token.
    #[arg(long, default_value = "/run/secrets/pin_bridge_control_token")]
    control_token_file: PathBuf,

    /// IP address on which the local HTTP server listens.
    #[arg(long, default_value = "127.0.0.1")]
    listen_ip: IpAddr,

    /// Local port to serve Center on.
    #[arg(long, short, default_value = "18080")]
    port: u16,

    /// Generation counter for the remote protocol. Must match the Pin's.
    #[arg(long, default_value = "1")]
    generation: u64,

    /// Where to persist this bridge's iroh secret key.
    ///
    /// Without it the bridge gets a fresh identity on every restart, so the Pin
    /// cannot authorize it. With it, this bridge has a stable EndpointId.
    #[arg(long, default_value = "/var/lib/center-iroh-bridge/endpoint.key")]
    secret_key_file: PathBuf,
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

    let control_token = read_control_token(&args.control_token_file)?;
    let target = read_assignment(&args.assignment_file)?.map(|(_, target)| target);

    // Create our own iroh endpoint using the n0 relay + DNS discovery preset,
    // matching the Pin so relay-assisted NAT traversal works out of the box.
    let secret = load_or_create_secret_key(&args.secret_key_file)
        .map_err(|error| format!("cannot load persistent bridge identity: {error}"))?;
    let builder = Endpoint::builder(iroh::endpoint::presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .secret_key(secret);
    let endpoint = builder.bind().await?;

    // Stable across restarts once persisted, this is the value to put in the
    // Pin's `server.iroh_remote_center_allowed_peers`.
    info!(
        "bridge EndpointId (allowlist this on the Pin): {}",
        endpoint.id()
    );

    let state = Arc::new(BridgeState {
        connection: Mutex::new(None),
        endpoint,
        target: RwLock::new(target),
        assignment_file: args.assignment_file,
        control_token,
        generation: args.generation,
    });

    // Every request proxies to the Pin except the local status route. Using a
    // fallback (rather than a wildcard route) also catches the bare `/` path.
    let app = Router::new()
        .route("/__health", get(health))
        .route("/__control/status", get(control_status))
        .route("/__control/pair", put(pair_target))
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
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt as _;

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
        assert_eq!(
            args.assignment_file,
            Path::new("/var/lib/center-iroh-bridge/assignment.json")
        );
        assert_eq!(
            args.control_token_file,
            Path::new("/run/secrets/pin_bridge_control_token")
        );
        assert_eq!(
            args.secret_key_file,
            Path::new("/var/lib/center-iroh-bridge/endpoint.key")
        );
        assert!(Args::try_parse_from(["center-iroh-bridge", "--ticket", "secret"]).is_err());
    }

    async fn control_test_state(directory: &Path) -> (Arc<BridgeState>, Endpoint) {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .bind()
            .await
            .unwrap();
        let remote = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        (
            Arc::new(BridgeState {
                connection: Mutex::new(None),
                endpoint,
                target: RwLock::new(None),
                assignment_file: directory.join("assignment.json"),
                control_token: vec![b'x'; MIN_CONTROL_TOKEN_BYTES],
                generation: 1,
            }),
            remote,
        )
    }

    fn control_router(state: Arc<BridgeState>) -> Router {
        Router::new()
            .route("/__control/status", get(control_status))
            .route("/__control/pair", put(pair_target))
            .with_state(state)
    }

    fn control_request(
        method: Method,
        path: &str,
        body: String,
        token: Option<&str>,
    ) -> Request<Body> {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        request.body(Body::from(body)).unwrap()
    }

    #[tokio::test]
    async fn control_routes_are_authenticated_strict_persistent_and_replace_connections() {
        let directory = temporary_directory();
        let (state, first_remote) = control_test_state(&directory).await;
        let app = control_router(Arc::clone(&state));
        let token = "x".repeat(MIN_CONTROL_TOKEN_BYTES);

        for presented in [None, Some("wrong-token-that-is-long-enough")] {
            let response = app
                .clone()
                .oneshot(control_request(
                    Method::GET,
                    "/__control/status",
                    String::new(),
                    presented,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        for body in [
            "not-json".to_string(),
            serde_json::json!({"device_id":"2c2a00010000abcd","ticket":"bad","extra":true})
                .to_string(),
            serde_json::json!({"device_id":"DEVICE-1","ticket":"bad"}).to_string(),
            serde_json::json!({"device_id":"2c2a00010000abcd","ticket":"bad"}).to_string(),
        ] {
            let response = app
                .clone()
                .oneshot(control_request(
                    Method::PUT,
                    "/__control/pair",
                    body,
                    Some(&token),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }

        let first_ticket = EndpointTicket::new(first_remote.addr()).to_string();
        let pair_body = serde_json::json!({
            "device_id": "2c2a00010000abcd",
            "ticket": first_ticket,
        })
        .to_string();
        let response = app
            .clone()
            .oneshot(control_request(
                Method::PUT,
                "/__control/pair",
                pair_body,
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response_body = to_bytes(response.into_body(), MAX_CONTROL_BODY_BYTES)
            .await
            .unwrap();
        let response_json: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response_json["configured"], true);
        assert_eq!(response_json["device_id"], "2c2a00010000abcd");
        assert!(!String::from_utf8_lossy(&response_body).contains(&first_ticket));

        let (persisted, target) = read_assignment(&state.assignment_file)
            .unwrap()
            .expect("the assignment must survive process restart");
        assert_eq!(persisted.device_id, "2c2a00010000abcd");
        assert_eq!(target.node_addr.id, first_remote.id());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&state.assignment_file)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let (client_connection, server_connection) =
            tokio::join!(state.endpoint.connect(first_remote.addr(), ALPN), async {
                first_remote.accept().await.unwrap().await
            },);
        *state.connection.lock().await = Some(client_connection.unwrap());
        let server_connection = server_connection.unwrap();

        let second_remote = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let second_ticket = EndpointTicket::new(second_remote.addr()).to_string();
        let replacement = serde_json::json!({
            "device_id": "2c2a00010000beef",
            "ticket": second_ticket,
        })
        .to_string();
        let response = app
            .oneshot(control_request(
                Method::PUT,
                "/__control/pair",
                replacement,
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state.connection.lock().await.is_none());
        assert_eq!(
            state.target.read().await.as_ref().unwrap().node_addr.id,
            second_remote.id()
        );

        server_connection.close(0u32.into(), b"test complete");
        state.endpoint.close().await;
        first_remote.close().await;
        second_remote.close().await;
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

    /// The Pin's refusal answers the request it refuses, so its status is
    /// the response, not a transport failure to redial and turn into a 502.
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
    /// `content_type`/`body_base64` are `#[serde(default)]` on the Pin. An
    /// error response with an empty body (or a bodyless 204) must still parse.
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
    fn reviewed_bridge_policy_allows_bounded_music_activity_reads() {
        let headers = HeaderMap::new();
        assert!(reviewed_route_allowed(
            &Method::GET,
            &Uri::from_static("/api/activity/music?limit=100"),
            &headers,
            0,
        ));
        assert!(reviewed_route_allowed(
            &Method::GET,
            &Uri::from_static("/api/activity/music?limit=20&before=42"),
            &headers,
            0,
        ));
        for uri in [
            "/api/activity/music?limit=101",
            "/api/activity/music?limit=bad&limit=20",
            "/api/activity/music?limit=20&before=bad&before=42",
            "/api/activity/music?limit=20&extra=1",
            "/api/activity/music/1?limit=20",
        ] {
            assert!(!reviewed_route_allowed(
                &Method::GET,
                &uri.parse().unwrap(),
                &headers,
                0,
            ));
        }
        assert!(!reviewed_route_allowed(
            &Method::POST,
            &Uri::from_static("/api/activity/music?limit=20"),
            &headers,
            0,
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
