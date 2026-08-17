//! Transparent gRPC request deduplication.
//!
//! [`DedupRouter`] wraps [`tonic::service::Routes`] and adds a dedup middleware
//! layer automatically.
//!
//! When duplicate requests (same gRPC path, body bytes, and request headers)
//! arrive in a short burst, the first executes normally while
//! concurrent duplicates coalesce onto it and share the response. Completed
//! responses are cached for a configurable per-method TTL.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use http::HeaderMap;
use http_body::Frame;
use http_body_util::BodyExt as _;
use prost::bytes::Bytes;
use sha2::{Digest as _, Sha256};
use tokio::sync::{watch, Mutex};
use tonic::server::NamedService;
use tower::Service;
use tracing::info;

/// Per-operation history limits. Deduplication is a transport optimization,
/// so an unexpectedly large or fragmented response must fail closed rather
/// than turn the middleware into an unbounded response buffer.
const MAX_REPLAY_FRAMES: usize = 1_024;
const MAX_REPLAY_RETAINED_BYTES: usize = 4 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Four worst-case histories reserve at most 16 MiB of retained payload.
/// Reservations live with the history Arc, so `clear()` cannot admit a fresh
/// generation until active old-generation histories are actually dropped.
const MAX_INFLIGHT_ENTRIES: usize = 4;
const MAX_INFLIGHT_RETAINED_BYTES: usize = MAX_INFLIGHT_ENTRIES * MAX_REPLAY_RETAINED_BYTES;

/// Global completed-response cache limits. The entry limit bounds metadata
/// overhead while the byte limit bounds retained response content.
const MAX_CACHE_ENTRIES: usize = 64;
const MAX_CACHE_RETAINED_BYTES: usize = 16 * 1024 * 1024;

/// A drop-in replacement for [`tonic::service::Routes`] that adds transparent
/// per-method request deduplication.
///
/// Methods registered with [`.dedup()`](DedupRouter::dedup) will have their
/// responses cached for the given TTL. Concurrent identical requests coalesce
/// onto a single handler invocation.
pub struct DedupRouter {
    routes: tonic::service::Routes,
    dedup: GrpcDedup,
}

impl DedupRouter {
    /// Start a new router with an initial service.
    pub fn new<S>(svc: S) -> Self
    where
        S: Service<http::Request<tonic::body::Body>, Error = Infallible>
            + NamedService
            + Clone
            + Send
            + Sync
            + 'static,
        S::Response: axum::response::IntoResponse,
        S::Future: Send + 'static,
    {
        Self {
            routes: tonic::service::Routes::new(svc),
            dedup: GrpcDedup::new(),
        }
    }

    pub fn handle(&self) -> DedupHandle {
        DedupHandle {
            inner: self.dedup.inner.clone(),
        }
    }

    /// Add a service without dedup.
    pub fn add_service<S>(mut self, svc: S) -> Self
    where
        S: Service<http::Request<tonic::body::Body>, Error = Infallible>
            + NamedService
            + Clone
            + Send
            + Sync
            + 'static,
        S::Response: axum::response::IntoResponse,
        S::Future: Send + 'static,
    {
        self.routes = self.routes.add_service(svc);
        self
    }

    /// Register a method on a specific service for dedup with the given cache
    /// TTL.
    ///
    /// `S` is the gRPC service server type (must implement [`NamedService`]).
    /// `method` is the bare method name (e.g. `"EncryptedWeather"`).  The full
    /// gRPC path is derived from `S::NAME`.
    ///
    /// ```ignore
    /// type AiBus = AiBusServiceServer<AiBusServiceImpl>;
    ///
    /// DedupRouter::new(AiBusServiceServer::new(impl_))
    ///     .dedup::<AiBus>("EncryptedWeather", Duration::from_secs(300))
    ///     .dedup::<AiBus>("Understand", Duration::from_millis(200))
    ///     .add_service(PushRelayServiceServer::new(impl_))
    /// ```
    pub fn dedup<S: NamedService>(mut self, method: &str, ttl: Duration) -> Self {
        let path = format!("/{}/{}", S::NAME, method);
        self.dedup.routes.insert(path, ttl);
        self
    }

    /// Finalize into an [`axum::Router`] with the dedup middleware applied.
    pub fn into_axum_router(self) -> axum::Router {
        self.routes
            .into_axum_router()
            .layer(axum::middleware::from_fn_with_state(
                self.dedup,
                dedup_middleware,
            ))
    }
}

#[derive(Clone)]
pub struct DedupHandle {
    inner: Arc<Mutex<Inner>>,
}

impl DedupHandle {
    pub async fn clear(&self) {
        let mut inner = self.inner.lock().await;
        let invalidated = inner
            .inflight
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        inner.cache.clear();
        inner.next_cache_sequence = 0;
        drop(inner);
        for entry in invalidated {
            entry.invalidate();
        }
    }
}

/// Everything needed to reconstruct an HTTP response from cache.
#[derive(Clone)]
struct CachedResponse {
    status: http::StatusCode,
    headers: HeaderMap,
    body: Bytes,
    trailers: Option<HeaderMap>,
    expires_at: Instant,
    sequence: u64,
    retained_bytes: usize,
}

struct CompletedResponse {
    status: http::StatusCode,
    headers: HeaderMap,
    body: Bytes,
    trailers: Option<HeaderMap>,
    retained_bytes: usize,
}

/// Privacy-safe identity for one deduplication domain. The request body and
/// run metadata are hashed rather than retained in the in-flight/cache maps.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct DedupKey {
    path: String,
    digest: [u8; 32],
}

fn hash_len_prefixed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn dedup_key(path: &str, headers: &HeaderMap, body: &[u8]) -> DedupKey {
    let mut hasher = Sha256::new();
    hash_len_prefixed(&mut hasher, path.as_bytes());
    hash_len_prefixed(&mut hasher, body);
    // Hash every request header so authorization, deadline, compression,
    // locale, content negotiation, and future execution metadata cannot cross
    // a dedup/cache boundary. Header names are canonicalized; duplicate value
    // order is preserved because gRPC metadata consumers can observe it.
    let mut names = headers.keys().collect::<Vec<_>>();
    names.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
    names.dedup();
    hasher.update((names.len() as u64).to_be_bytes());
    for name in names {
        hash_len_prefixed(&mut hasher, name.as_str().as_bytes());
        let values = headers.get_all(name).iter().collect::<Vec<_>>();
        hasher.update((values.len() as u64).to_be_bytes());
        for value in values {
            hash_len_prefixed(&mut hasher, value.as_bytes());
        }
    }
    DedupKey {
        path: path.to_string(),
        digest: hasher.finalize().into(),
    }
}

fn dedup_key_for_request(path: &str, parts: &http::request::Parts, body: &[u8]) -> DedupKey {
    let base = dedup_key(path, &parts.headers, body);
    let mut hasher = Sha256::new();
    hash_len_prefixed(&mut hasher, parts.method.as_str().as_bytes());
    let target = parts.uri.to_string();
    hash_len_prefixed(&mut hasher, target.as_bytes());
    hash_len_prefixed(&mut hasher, &base.digest);
    DedupKey {
        path: base.path,
        digest: hasher.finalize().into(),
    }
}

#[derive(Clone)]
struct ResponseHead {
    status: http::StatusCode,
    headers: HeaderMap,
}

#[derive(Clone)]
enum ReplayFrame {
    Data(Bytes),
    Trailers(HeaderMap),
}

impl ReplayFrame {
    fn into_frame(self) -> Frame<Bytes> {
        match self {
            Self::Data(data) => Frame::data(data),
            Self::Trailers(trailers) => Frame::trailers(trailers),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReplayTerminal {
    Open,
    Complete,
    Failed,
}

struct ReplayState {
    head: Option<ResponseHead>,
    frames: Vec<ReplayFrame>,
    retained_bytes: usize,
    terminal: ReplayTerminal,
    joinable: bool,
    subscribers: usize,
}

#[derive(Default)]
struct ReplayBudgetState {
    entries: usize,
    reserved_bytes: usize,
}

#[derive(Default)]
struct ReplayBudget {
    state: std::sync::Mutex<ReplayBudgetState>,
}

impl ReplayBudget {
    fn try_reserve(self: &Arc<Self>) -> Option<ReplayReservation> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entries = state.entries.checked_add(1)?;
        let reserved_bytes = state
            .reserved_bytes
            .checked_add(MAX_REPLAY_RETAINED_BYTES)?;
        if entries > MAX_INFLIGHT_ENTRIES || reserved_bytes > MAX_INFLIGHT_RETAINED_BYTES {
            return None;
        }
        state.entries = entries;
        state.reserved_bytes = reserved_bytes;
        drop(state);
        Some(ReplayReservation {
            budget: self.clone(),
        })
    }
}

struct ReplayReservation {
    budget: Arc<ReplayBudget>,
}

impl Drop for ReplayReservation {
    fn drop(&mut self) {
        let mut state = self
            .budget
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.entries = state.entries.saturating_sub(1);
        state.reserved_bytes = state
            .reserved_bytes
            .saturating_sub(MAX_REPLAY_RETAINED_BYTES);
    }
}

/// One handler response shared by the leader and every concurrent duplicate.
/// Each client has an independent cursor into `frames`; the frame bytes exist
/// only once per in-flight key, not once per follower.
struct InflightResponse {
    state: std::sync::Mutex<ReplayState>,
    updates: watch::Sender<u64>,
    subscribers: watch::Sender<usize>,
    _reservation: ReplayReservation,
}

enum ReplayRead {
    Frame(ReplayFrame),
    Pending,
    Complete,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReplayPublish {
    Published,
    Ignored,
    Failed,
}

impl InflightResponse {
    fn with_reservation(reservation: ReplayReservation) -> Self {
        let (updates, _) = watch::channel(0);
        let (subscribers, _) = watch::channel(0);
        Self {
            state: std::sync::Mutex::new(ReplayState {
                head: None,
                frames: Vec::new(),
                retained_bytes: 0,
                terminal: ReplayTerminal::Open,
                joinable: true,
                subscribers: 0,
            }),
            updates,
            subscribers,
            _reservation: reservation,
        }
    }

    #[cfg(test)]
    fn new() -> Self {
        let budget = Arc::new(ReplayBudget::default());
        Self::with_reservation(
            budget
                .try_reserve()
                .expect("isolated test replay budget accepts one entry"),
        )
    }

    fn notify_update(&self) {
        self.updates.send_modify(|generation| {
            *generation = generation.wrapping_add(1);
        });
    }

    fn publish_head(&self, head: &ResponseHead) -> bool {
        let retained_bytes = header_map_retained_bytes(&head.headers);
        let copied_headers = retained_bytes
            .filter(|bytes| *bytes <= MAX_REPLAY_RETAINED_BYTES)
            .and_then(|_| deep_copy_header_map(&head.headers));
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let published = if state.terminal != ReplayTerminal::Open || state.head.is_some() {
            false
        } else if copied_headers.is_none() {
            state.terminal = ReplayTerminal::Failed;
            state.joinable = false;
            false
        } else {
            let copied_headers = copied_headers.expect("checked above");
            let closes_admission = matches!(
                grpc_application_status(std::iter::once(&copied_headers)),
                GrpcApplicationStatus::Invalid
            );
            state.retained_bytes = retained_bytes.expect("checked above");
            state.head = Some(ResponseHead {
                status: head.status,
                headers: copied_headers,
            });
            if closes_admission {
                // Existing subscribers still replay this response verbatim,
                // but a known application failure must not absorb a retry.
                state.joinable = false;
            }
            true
        };
        drop(state);
        self.notify_update();
        published
    }

    fn publish_frame(&self, frame: &Frame<Bytes>) -> ReplayPublish {
        let (additional_bytes, copied_trailers) = if let Some(data) = frame.data_ref() {
            (Some(data.len()), None)
        } else if let Some(trailers) = frame.trailers_ref() {
            let retained_bytes = header_map_retained_bytes(trailers);
            let copied = retained_bytes
                .filter(|bytes| *bytes <= MAX_REPLAY_RETAINED_BYTES)
                .and_then(|_| deep_copy_header_map(trailers));
            (retained_bytes.filter(|_| copied.is_some()), copied)
        } else {
            return ReplayPublish::Ignored;
        };
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal != ReplayTerminal::Open {
            return ReplayPublish::Failed;
        }
        let next_retained_bytes = additional_bytes
            .and_then(|bytes| state.retained_bytes.checked_add(bytes))
            .filter(|bytes| *bytes <= MAX_REPLAY_RETAINED_BYTES);
        if state.frames.len() >= MAX_REPLAY_FRAMES || next_retained_bytes.is_none() {
            state.terminal = ReplayTerminal::Failed;
            state.joinable = false;
            drop(state);
            self.notify_update();
            return ReplayPublish::Failed;
        }
        state.retained_bytes = next_retained_bytes.expect("checked above");
        let recorded = if let Some(data) = frame.data_ref() {
            // `Bytes::clone` can retain an arbitrarily larger sliced backing
            // allocation. Copying makes the retained-byte limit truthful.
            ReplayFrame::Data(Bytes::copy_from_slice(data))
        } else {
            ReplayFrame::Trailers(copied_trailers.expect("frame kind and copy checked above"))
        };
        let published_trailers = matches!(&recorded, ReplayFrame::Trailers(_));
        state.frames.push(recorded);
        if published_trailers
            && !matches!(
                grpc_application_status(state.head.iter().map(|head| &head.headers).chain(
                    state.frames.iter().filter_map(|frame| match frame {
                        ReplayFrame::Data(_) => None,
                        ReplayFrame::Trailers(trailers) => Some(trailers),
                    })
                ),),
                GrpcApplicationStatus::Success
            )
        {
            // A trailer makes the effective gRPC status observable. Missing,
            // duplicate, conflicting, malformed, and nonzero status all close
            // admission without disrupting clients that already subscribed.
            state.joinable = false;
        }
        drop(state);
        self.notify_update();
        ReplayPublish::Published
    }

    fn finish(&self, terminal: ReplayTerminal) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal == ReplayTerminal::Open {
            state.terminal = terminal;
        }
        state.joinable = false;
        drop(state);
        self.notify_update();
    }

    /// Marks an explicitly successful response complete while leaving it
    /// joinable until `InflightFinalizer::succeed` atomically swaps the map
    /// entry for its completed cache record under `Inner`'s mutex.
    fn finish_cacheable(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal == ReplayTerminal::Open {
            state.terminal = ReplayTerminal::Complete;
        }
        drop(state);
        self.notify_update();
    }

    fn invalidate(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.joinable = false;
        drop(state);
        self.notify_update();
    }

    fn try_subscribe(self: &Arc<Self>) -> Option<ReplaySubscription> {
        let subscribers = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !state.joinable || state.terminal == ReplayTerminal::Failed {
                return None;
            }
            state.subscribers = state.subscribers.saturating_add(1);
            state.subscribers
        };
        self.subscribers.send_replace(subscribers);
        Some(ReplaySubscription {
            entry: self.clone(),
        })
    }

    fn unsubscribe(&self) {
        let subscribers = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.subscribers = state.subscribers.saturating_sub(1);
            state.subscribers
        };
        self.subscribers.send_replace(subscribers);
    }

    /// Atomically closes admission when the last response body disappears.
    /// A concurrent follower either increments `subscribers` first and keeps
    /// the producer alive, or observes `Failed` and retries as a new leader.
    fn cancel_if_unsubscribed(&self) -> bool {
        let cancelled = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.terminal == ReplayTerminal::Open && state.subscribers == 0 {
                state.terminal = ReplayTerminal::Failed;
                state.joinable = false;
                true
            } else {
                false
            }
        };
        if cancelled {
            self.notify_update();
        }
        cancelled
    }

    async fn wait_for_head(&self) -> Option<ResponseHead> {
        let mut updates = self.updates.subscribe();
        loop {
            {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(head) = state.head.clone() {
                    return Some(head);
                }
                if state.terminal != ReplayTerminal::Open {
                    return None;
                }
            }
            if updates.changed().await.is_err() {
                return None;
            }
        }
    }

    fn read(&self, cursor: usize) -> ReplayRead {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(frame) = state.frames.get(cursor) {
            return ReplayRead::Frame(frame.clone());
        }
        match state.terminal {
            ReplayTerminal::Open => ReplayRead::Pending,
            ReplayTerminal::Complete => ReplayRead::Complete,
            ReplayTerminal::Failed => ReplayRead::Failed,
        }
    }

    fn completed_response(&self) -> Option<CompletedResponse> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal != ReplayTerminal::Open {
            return None;
        }
        let head = state.head.as_ref()?;
        let total = state.frames.iter().fold(0usize, |total, frame| {
            total.saturating_add(match frame {
                ReplayFrame::Data(data) => data.len(),
                ReplayFrame::Trailers(_) => 0,
            })
        });
        let mut body = Vec::with_capacity(total);
        let mut trailers = None;
        for frame in &state.frames {
            match frame {
                ReplayFrame::Data(data) => body.extend_from_slice(data),
                ReplayFrame::Trailers(value) => {
                    if trailers.replace(value.clone()).is_some() {
                        // Cached replay can emit one terminal trailer map. Do
                        // not collapse multiple wire-visible trailer frames.
                        return None;
                    }
                }
            }
        }
        if !grpc_application_status_is_cacheable(&head.headers, trailers.as_ref()) {
            return None;
        }
        let retained_bytes =
            completed_response_retained_bytes(&head.headers, body.len(), &trailers)?;
        if retained_bytes > MAX_REPLAY_RETAINED_BYTES {
            return None;
        }
        Some(CompletedResponse {
            status: head.status,
            headers: head.headers.clone(),
            body: Bytes::from(body),
            trailers,
            retained_bytes,
        })
    }
}

struct ReplaySubscription {
    entry: Arc<InflightResponse>,
}

impl Drop for ReplaySubscription {
    fn drop(&mut self) {
        self.entry.unsubscribe();
    }
}

fn header_map_retained_bytes(headers: &HeaderMap) -> Option<usize> {
    headers.iter().try_fold(0usize, |total, (name, value)| {
        total
            .checked_add(name.as_str().len())?
            .checked_add(value.as_bytes().len())
    })
}

/// Copy metadata into allocations sized to the visible name/value bytes. A
/// plain `HeaderMap::clone` can retain a tiny slice of an arbitrarily larger
/// shared `Bytes` allocation while our accounting sees only the slice length.
fn deep_copy_header_map(headers: &HeaderMap) -> Option<HeaderMap> {
    let mut copied = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        let is_sensitive = value.is_sensitive();
        let name = http::HeaderName::from_bytes(name.as_str().as_bytes()).ok()?;
        let mut value = http::HeaderValue::from_bytes(value.as_bytes()).ok()?;
        value.set_sensitive(is_sensitive);
        copied.append(name, value);
    }
    Some(copied)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GrpcApplicationStatus {
    Missing,
    Success,
    Invalid,
}

fn grpc_application_status<'a>(
    maps: impl IntoIterator<Item = &'a HeaderMap>,
) -> GrpcApplicationStatus {
    let mut observed = None;
    for map in maps {
        for status in map.get_all("grpc-status").iter() {
            if observed.replace(status.as_bytes()).is_some() {
                return GrpcApplicationStatus::Invalid;
            }
        }
    }
    match observed {
        None => GrpcApplicationStatus::Missing,
        Some(status) if status == b"0" => GrpcApplicationStatus::Success,
        Some(_) => GrpcApplicationStatus::Invalid,
    }
}

fn grpc_application_status_is_cacheable(headers: &HeaderMap, trailers: Option<&HeaderMap>) -> bool {
    matches!(
        grpc_application_status([Some(headers), trailers].into_iter().flatten()),
        GrpcApplicationStatus::Success
    )
}

fn completed_response_retained_bytes(
    headers: &HeaderMap,
    body_bytes: usize,
    trailers: &Option<HeaderMap>,
) -> Option<usize> {
    let headers = header_map_retained_bytes(headers)?;
    let trailers = match trailers {
        Some(trailers) => header_map_retained_bytes(trailers)?,
        None => 0,
    };
    headers.checked_add(body_bytes)?.checked_add(trailers)
}

struct Inner {
    /// In-flight requests share one append-only response history. Followers
    /// replay the prefix and then wait for subsequent live frames.
    inflight: HashMap<DedupKey, Arc<InflightResponse>>,

    /// Recently completed responses, kept for the method's configured TTL.
    cache: HashMap<DedupKey, CachedResponse>,

    /// Monotonic insertion order used for deterministic oldest-first eviction.
    next_cache_sequence: u64,
}

fn prune_expired_cache(inner: &mut Inner, now: Instant) {
    inner.cache.retain(|_, entry| entry.expires_at > now);
}

fn cache_retained_bytes(inner: &Inner) -> usize {
    inner.cache.values().fold(0usize, |total, entry| {
        total.saturating_add(entry.retained_bytes)
    })
}

fn oldest_cache_key(inner: &Inner) -> Option<DedupKey> {
    inner
        .cache
        .iter()
        .min_by(|(left_key, left), (right_key, right)| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left_key.path.cmp(&right_key.path))
                .then_with(|| left_key.digest.cmp(&right_key.digest))
        })
        .map(|(key, _)| key.clone())
}

fn enforce_cache_limits(inner: &mut Inner) {
    while inner.cache.len() > MAX_CACHE_ENTRIES
        || cache_retained_bytes(inner) > MAX_CACHE_RETAINED_BYTES
    {
        let Some(oldest) = oldest_cache_key(inner) else {
            break;
        };
        inner.cache.remove(&oldest);
    }
}

fn insert_completed_response(
    inner: &mut Inner,
    key: DedupKey,
    completed: CompletedResponse,
    ttl: Duration,
    now: Instant,
) {
    prune_expired_cache(inner, now);
    if ttl.is_zero()
        || completed.retained_bytes > MAX_REPLAY_RETAINED_BYTES
        || completed.retained_bytes > MAX_CACHE_RETAINED_BYTES
    {
        return;
    }
    let Some(expires_at) = now.checked_add(ttl) else {
        return;
    };
    // A wrap would make insertion order ambiguous. It is not operationally
    // reachable, but clearing this short-lived optimization keeps behavior
    // deterministic even in that state.
    if inner.next_cache_sequence == u64::MAX {
        inner.cache.clear();
        inner.next_cache_sequence = 0;
    }
    let sequence = inner.next_cache_sequence;
    inner.next_cache_sequence += 1;
    inner.cache.insert(
        key,
        CachedResponse {
            status: completed.status,
            headers: completed.headers,
            body: completed.body,
            trailers: completed.trailers,
            expires_at,
            sequence,
            retained_bytes: completed.retained_bytes,
        },
    );
    enforce_cache_limits(inner);
}

fn body_error_exceeded_limit(error: &axum::Error) -> bool {
    let mut current: &(dyn std::error::Error + 'static) = error;
    loop {
        if current.is::<http_body_util::LengthLimitError>() {
            return true;
        }
        let Some(source) = current.source() else {
            return false;
        };
        current = source;
    }
}

fn grpc_body_rejection(limit_exceeded: bool) -> axum::response::Response {
    let mut response = http::Response::new(Body::empty());
    let headers = response.headers_mut();
    headers.insert(
        "grpc-status",
        http::HeaderValue::from_static(if limit_exceeded { "8" } else { "13" }),
    );
    headers.insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/grpc"),
    );
    response
}

/// Shared dedup state.  Constructed internally by [`DedupRouter`].
#[derive(Clone)]
struct GrpcDedup {
    routes: HashMap<String, Duration>,
    inner: Arc<Mutex<Inner>>,
    replay_budget: Arc<ReplayBudget>,
}

impl GrpcDedup {
    fn new() -> Self {
        Self {
            routes: HashMap::new(),
            inner: Arc::new(Mutex::new(Inner {
                inflight: HashMap::new(),
                cache: HashMap::new(),
                next_cache_sequence: 0,
            })),
            replay_budget: Arc::new(ReplayBudget::default()),
        }
    }
}

/// axum middleware that performs the actual dedup logic.
async fn dedup_middleware(
    axum::extract::State(dedup): axum::extract::State<GrpcDedup>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let ttl = match dedup.routes.get(&path) {
        Some(ttl) => *ttl,
        None => return next.run(request).await,
    };

    let (parts, body) = request.into_parts();
    let body_bytes = match axum::body::to_bytes(body, MAX_REQUEST_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => {
            let limit_exceeded = body_error_exceeded_limit(&error);
            info!(path = %path, limit_exceeded, "dedup: rejected unreadable request body");
            return grpc_body_rejection(limit_exceeded);
        }
    };
    let key = dedup_key_for_request(&path, &parts, &body_bytes);

    let (mut guard, leader_subscription) = loop {
        let claim = {
            let mut inner = dedup.inner.lock().await;
            prune_expired_cache(&mut inner, Instant::now());
            if let Some(entry) = inner.cache.get(&key) {
                info!(path = %path, "dedup: cache hit");
                return rebuild_response(entry);
            }
            if let Some(entry) = inner.inflight.get(&key) {
                let entry = entry.clone();
                let subscription = entry.try_subscribe();
                Some((entry, false, subscription))
            } else {
                dedup.replay_budget.try_reserve().map(|reservation| {
                    let entry = Arc::new(InflightResponse::with_reservation(reservation));
                    let subscription = entry
                        .try_subscribe()
                        .expect("fresh in-flight response accepts its leader");
                    inner.inflight.insert(key.clone(), entry.clone());
                    (entry, true, Some(subscription))
                })
            }
        };

        let Some((entry, is_leader, subscription)) = claim else {
            // Deduplication is an optimization. At the global replay-memory
            // admission limit, preserve service availability by streaming a
            // distinct request directly without retaining another history.
            info!(path = %path, "dedup: bypassing at in-flight admission limit");
            return next
                .run(http::Request::from_parts(parts, Body::from(body_bytes)))
                .await;
        };

        let Some(subscription) = subscription else {
            let mut inner = dedup.inner.lock().await;
            remove_current_inflight(&mut inner, &key, &entry);
            continue;
        };

        if !is_leader {
            info!(path = %path, "dedup: coalescing with in-flight request");
            if let Some(head) = entry.wait_for_head().await {
                info!(path = %path, "dedup: joined live in-flight response");
                return rebuild_live_response(entry, head, subscription);
            }
            drop(subscription);
            let mut inner = dedup.inner.lock().await;
            remove_current_inflight(&mut inner, &key, &entry);
            continue;
        }

        break (
            InflightGuard::new(dedup.inner.clone(), key.clone(), entry, ttl),
            subscription,
        );
    };

    let request = http::Request::from_parts(parts, Body::from(body_bytes));
    let response = next.run(request).await;
    let (resp_parts, resp_body) = response.into_parts();
    let entry = guard.entry().clone();
    let head = ResponseHead {
        status: resp_parts.status,
        headers: resp_parts.headers,
    };
    let head_published = entry.publish_head(&head);

    // The producer owns the source, independently of the original leader's
    // response body. A surviving follower can therefore continue after the
    // first client disconnects.
    let streamed = rebuild_live_response(entry.clone(), head, leader_subscription);
    let finalizer = guard.take().expect("leader owns in-flight finalizer");
    if head_published {
        tokio::spawn(drive_inflight_response(
            Body::new(resp_body),
            entry,
            finalizer,
            path,
        ));
    } else {
        tokio::spawn(finalizer.fail());
    }
    streamed
}

fn remove_current_inflight(
    inner: &mut Inner,
    key: &DedupKey,
    entry: &Arc<InflightResponse>,
) -> bool {
    let matches = inner
        .inflight
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, entry));
    if matches {
        inner.inflight.remove(key);
    }
    matches
}

struct InflightOwnership {
    inner: Arc<Mutex<Inner>>,
    key: DedupKey,
    entry: Arc<InflightResponse>,
    ttl: Duration,
}

async fn abort_ownership(ownership: InflightOwnership) {
    ownership.entry.finish(ReplayTerminal::Failed);
    let mut inner = ownership.inner.lock().await;
    remove_current_inflight(&mut inner, &ownership.key, &ownership.entry);
}

fn spawn_abort_ownership(ownership: InflightOwnership) {
    tokio::spawn(abort_ownership(ownership));
}

struct InflightGuard {
    ownership: Option<InflightOwnership>,
}

impl InflightGuard {
    fn new(
        inner: Arc<Mutex<Inner>>,
        key: DedupKey,
        entry: Arc<InflightResponse>,
        ttl: Duration,
    ) -> Self {
        Self {
            ownership: Some(InflightOwnership {
                inner,
                key,
                entry,
                ttl,
            }),
        }
    }

    fn entry(&self) -> &Arc<InflightResponse> {
        &self
            .ownership
            .as_ref()
            .expect("in-flight guard still armed")
            .entry
    }

    fn take(&mut self) -> Option<InflightFinalizer> {
        self.ownership.take().map(|ownership| InflightFinalizer {
            ownership: Some(ownership),
        })
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Some(ownership) = self.ownership.take() {
            spawn_abort_ownership(ownership);
        }
    }
}

struct InflightFinalizer {
    ownership: Option<InflightOwnership>,
}

impl InflightFinalizer {
    async fn succeed(mut self, completed: CompletedResponse) {
        let Some(ownership) = self.ownership.take() else {
            return;
        };
        let mut inner = ownership.inner.lock().await;
        // A cache clear may already have invalidated this generation. Never
        // remove its replacement or reinsert stale response bytes.
        if remove_current_inflight(&mut inner, &ownership.key, &ownership.entry) {
            insert_completed_response(
                &mut inner,
                ownership.key,
                completed,
                ownership.ttl,
                Instant::now(),
            );
        }
    }

    async fn fail(mut self) {
        if let Some(ownership) = self.ownership.take() {
            abort_ownership(ownership).await;
        }
    }
}

impl Drop for InflightFinalizer {
    fn drop(&mut self) {
        if let Some(ownership) = self.ownership.take() {
            spawn_abort_ownership(ownership);
        }
    }
}

fn rebuild_live_response(
    entry: Arc<InflightResponse>,
    head: ResponseHead,
    subscription: ReplaySubscription,
) -> axum::response::Response {
    let mut updates = entry.updates.subscribe();
    let stream = async_stream::stream! {
        let _subscription = subscription;
        let mut cursor = 0usize;
        loop {
            match entry.read(cursor) {
                ReplayRead::Frame(frame) => {
                    cursor += 1;
                    yield Ok::<Frame<Bytes>, axum::Error>(frame.into_frame());
                }
                ReplayRead::Pending => {
                    if updates.changed().await.is_err() {
                        yield Err(axum::Error::new(std::io::Error::other(
                            "deduplicated response stream closed unexpectedly",
                        )));
                        return;
                    }
                }
                ReplayRead::Complete => return,
                ReplayRead::Failed => {
                    yield Err(axum::Error::new(std::io::Error::other(
                        "deduplicated response stream failed",
                    )));
                    return;
                }
            }
        }
    };
    let mut response = http::Response::new(Body::new(http_body_util::StreamBody::new(stream)));
    *response.status_mut() = head.status;
    *response.headers_mut() = head.headers;
    response
}

async fn drive_inflight_response(
    mut source: Body,
    entry: Arc<InflightResponse>,
    finalizer: InflightFinalizer,
    path: String,
) {
    let mut subscribers = entry.subscribers.subscribe();
    let mut finalizer = Some(finalizer);
    loop {
        if entry.cancel_if_unsubscribed() {
            if let Some(finalizer) = finalizer.take() {
                finalizer.fail().await;
            }
            return;
        }
        tokio::select! {
            biased;
            changed = subscribers.changed() => {
                if changed.is_err() || entry.cancel_if_unsubscribed() {
                    if let Some(finalizer) = finalizer.take() {
                        finalizer.fail().await;
                    }
                    return;
                }
            }
            frame = source.frame() => match frame {
                Some(Ok(frame)) => {
                    if let Some(data) = frame.data_ref() {
                        info!(path = %path, bytes = data.len(), "dedup shared response produced frame");
                    }
                    if entry.publish_frame(&frame) == ReplayPublish::Failed {
                        if let Some(finalizer) = finalizer.take() {
                            finalizer.fail().await;
                        }
                        return;
                    }
                }
                Some(Err(_)) => {
                    if let Some(finalizer) = finalizer.take() {
                        finalizer.fail().await;
                    }
                    return;
                }
                None => {
                    let completed = entry.completed_response();
                    if let Some(finalizer) = finalizer.take() {
                        if let Some(completed) = completed {
                            // Keep the successful completed history joinable
                            // until `succeed` atomically removes it and inserts
                            // the cache record under the same `Inner` lock.
                            entry.finish_cacheable();
                            finalizer.succeed(completed).await;
                        } else {
                            entry.finish(ReplayTerminal::Complete);
                            finalizer.fail().await;
                        }
                    }
                    return;
                }
            }
        }
    }
}

/// Reconstruct an HTTP response from a cached entry, preserving gRPC trailers.
fn rebuild_response(cached: &CachedResponse) -> axum::response::Response {
    let mut builder = http::Response::builder().status(cached.status);
    *builder.headers_mut().unwrap() = cached.headers.clone();

    // Build a body that yields the DATA frame(s) then the TRAILERS frame.
    let data = cached.body.clone();
    let trailers = cached.trailers.clone();

    let body = Body::new(TraileredBody {
        data: Some(data),
        trailers,
    });

    builder.body(body).unwrap()
}

/// A minimal [`http_body::Body`] implementation that yields a single DATA frame
/// followed by an optional TRAILERS frame.  This is necessary because
/// `Body::from(Bytes)` does not support trailers, which gRPC requires.
struct TraileredBody {
    data: Option<Bytes>,
    trailers: Option<HeaderMap>,
}

impl http_body::Body for TraileredBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        // Yield the DATA frame first, then the TRAILERS frame.
        if let Some(data) = self.data.take() {
            if !data.is_empty() {
                return std::task::Poll::Ready(Some(Ok(Frame::data(data))));
            }
        }
        if let Some(trailers) = self.trailers.take() {
            return std::task::Poll::Ready(Some(Ok(Frame::trailers(trailers))));
        }
        std::task::Poll::Ready(None)
    }
}

#[cfg(test)]
#[path = "dedup/tests.rs"]
mod tests;
