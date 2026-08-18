//! A dependency-light metrics surface, scraped over the existing HTTP listener.
//!
//! An operator watching this deployment could previously distinguish a healthy
//! server from a silently failing one only by asking a device to try. `/healthz`
//! and `/readyz` answer from process state, not from work actually completed, so
//! a workload that serves `UNAVAILABLE` to every RPC looks exactly like one
//! serving none — same 204, same logs (there are none per request).
//!
//! What is recorded here is deliberately narrow: **counts and durations of RPCs,
//! keyed by the method name off the wire**. Nothing a wearer said, captured, or
//! stored appears in a metric label, and no principal, device id, or capability
//! token does either. That constraint is why the HTTP router is NOT instrumented
//! — its capture route carries a redemption capability in the path
//! (`/capture/{token}`, see `http.rs`), and recording request paths there would
//! copy that token into an unauthenticated scrape.
//!
//! The exposition format is Prometheus text 0.0.4, hand-rolled: the whole
//! surface is a few hundred lines of atomics, which is cheaper than a metrics
//! client dependency tree and keeps the scrape output auditable by reading it.
//!
//! # Series only exist once something feeds them
//!
//! Families are registered lazily, on first observation. A counter nobody has
//! incremented does not appear in the scrape at all, rather than appearing as a
//! zero: a zero is a claim ("no errors"), and a family with no producer wired to
//! it would be making that claim falsely. Absence is the honest answer for a
//! quantity nothing measures. `record_tool_call` and `record_model_latency`
//! below are entry points for the assistant engine and have no call site yet —
//! until they get one, their families stay off the wire.

use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    pin::Pin,
    sync::{
        Arc, OnceLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};

use axum::{
    Router,
    http::{Request, Response, header},
    response::IntoResponse,
    routing::get,
};
use tower::{Layer, Service};

/// Prometheus text exposition, version 0.0.4.
const TEXT_FORMAT: &str = "text/plain; version=0.0.4; charset=utf-8";

/// gRPC calls served, labelled `service`, `method`, `outcome`.
const RPC_REQUESTS: &str = "cosmos_rpc_requests_total";
/// End-to-end handler latency for the same calls.
const RPC_DURATION: &str = "cosmos_rpc_duration_seconds";
/// Assistant turns, labelled `outcome`. Fed by the engine; see the module note.
const TURNS: &str = "cosmos_assistant_turns_total";
/// Tool invocations the engine made, labelled `tool` and `outcome`.
const TOOL_CALLS: &str = "cosmos_assistant_tool_calls_total";
/// Language-model round trips, labelled `model`.
const MODEL_LATENCY: &str = "cosmos_model_latency_seconds";
/// Failures the server chose to report, labelled `kind` — the same `kind` the
/// matching `tracing` event carries. See [`record_error`].
const ERRORS: &str = "cosmos_errors_total";

const HELP: &[(&str, &str)] = &[
    (
        RPC_REQUESTS,
        "gRPC calls served, by method and terminal status.",
    ),
    (RPC_DURATION, "gRPC handler latency in seconds, by method."),
    (TURNS, "Assistant turns completed, by outcome."),
    (
        TOOL_CALLS,
        "Assistant tool invocations, by tool and outcome.",
    ),
    (
        MODEL_LATENCY,
        "Language-model round-trip latency in seconds.",
    ),
    (ERRORS, "Errors reported by the server, by kind."),
];

/// Upper bounds, in seconds. The top of the range is set by the device's own
/// deadline: `AIMIC_TIMEOUT_MS` is 25s (see `http.rs`), past which a real Pin
/// gives up, so a bucket beyond 30s would describe nothing a wearer ever waits
/// for.
const BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0,
];

/// Per-family series ceiling. Label values are derived from request paths, which
/// arrive off the wire: without a cap, a peer that varies the path varies the
/// key and grows this map until the process dies. Past the cap new series are
/// dropped and counted, so the loss is visible in the scrape rather than silent.
const MAX_SERIES_PER_FAMILY: usize = 256;

/// Longest label value kept. Anything longer is truncated — a label is an
/// identifier, not a payload.
const MAX_LABEL_LEN: usize = 64;

type Labels = Vec<(&'static str, String)>;

struct Histogram {
    /// Cumulative on write: index `i` counts every observation `<= BUCKETS[i]`,
    /// which is what the exposition format wants, so rendering is a read.
    buckets: Box<[AtomicU64]>,
    sum_micros: AtomicU64,
    count: AtomicU64,
}

impl Histogram {
    fn new() -> Self {
        Self {
            buckets: (0..BUCKETS.len()).map(|_| AtomicU64::new(0)).collect(),
            sum_micros: AtomicU64::new(0),
            count: AtomicU64::new(0),
        }
    }

    fn observe(&self, seconds: f64) {
        let micros = (seconds * 1e6).clamp(0.0, u64::MAX as f64) as u64;
        self.sum_micros.fetch_add(micros, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        for (index, bound) in BUCKETS.iter().enumerate() {
            if seconds <= *bound {
                self.buckets[index].fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

#[derive(Default)]
struct Registry {
    counters: RwLock<HashMap<&'static str, HashMap<Labels, Arc<AtomicU64>>>>,
    histograms: RwLock<HashMap<&'static str, HashMap<Labels, Arc<Histogram>>>>,
    /// Series refused by [`MAX_SERIES_PER_FAMILY`]. Always rendered, including
    /// as a zero: unlike a lazily registered family this one has a producer
    /// wired to it, so zero is a measurement and not a claim about nothing.
    dropped: AtomicU64,
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

fn labels(pairs: &[(&'static str, &str)]) -> Labels {
    pairs
        .iter()
        .map(|(name, value)| (*name, label_value(value)))
        .collect()
}

/// Escape a label value into something that cannot forge a scrape line.
///
/// Values reach here from the wire. Left raw, a path containing `"} forged{a="`
/// would close the label list and let a peer write arbitrary metric lines into
/// an operator's monitoring — so quotes, backslashes, and newlines are escaped
/// as the exposition format requires, and control characters are dropped.
fn label_value(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars().take(MAX_LABEL_LEN) {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            character if character.is_control() => {}
            character => escaped.push(character),
        }
    }
    escaped
}

/// Add one to a counter series, registering the family on first use.
pub fn increment(name: &'static str, pairs: &[(&'static str, &str)]) {
    let key = labels(pairs);
    let registry = registry();
    if let Some(counter) = registry
        .counters
        .read()
        .expect("metrics registry is never poisoned by a panicking observer")
        .get(name)
        .and_then(|family| family.get(&key))
    {
        counter.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let mut families = registry
        .counters
        .write()
        .expect("metrics registry is never poisoned by a panicking observer");
    let family = families.entry(name).or_default();
    if family.len() >= MAX_SERIES_PER_FAMILY && !family.contains_key(&key) {
        registry.dropped.fetch_add(1, Ordering::Relaxed);
        return;
    }
    family
        .entry(key)
        .or_insert_with(|| Arc::new(AtomicU64::new(0)))
        .fetch_add(1, Ordering::Relaxed);
}

/// Record one duration, in seconds, registering the family on first use.
pub fn observe(name: &'static str, pairs: &[(&'static str, &str)], seconds: f64) {
    let key = labels(pairs);
    let registry = registry();
    if let Some(histogram) = registry
        .histograms
        .read()
        .expect("metrics registry is never poisoned by a panicking observer")
        .get(name)
        .and_then(|family| family.get(&key))
    {
        histogram.observe(seconds);
        return;
    }
    let mut families = registry
        .histograms
        .write()
        .expect("metrics registry is never poisoned by a panicking observer");
    let family = families.entry(name).or_default();
    if family.len() >= MAX_SERIES_PER_FAMILY && !family.contains_key(&key) {
        registry.dropped.fetch_add(1, Ordering::Relaxed);
        return;
    }
    family
        .entry(key)
        .or_insert_with(|| Arc::new(Histogram::new()))
        .observe(seconds);
}

/// One completed assistant turn. `outcome` is a short constant — `answered`,
/// `no_model`, `deadline` — never wearer text.
pub fn record_turn(outcome: &str) {
    increment(TURNS, &[("outcome", outcome)]);
}

/// One tool invocation. `tool` is the catalog action name, `outcome` a short
/// constant; tool *arguments* are wearer content and must not be passed here.
pub fn record_tool_call(tool: &str, outcome: &str) {
    increment(TOOL_CALLS, &[("tool", tool), ("outcome", outcome)]);
}

/// One language-model round trip. `model` is the configured model id.
pub fn record_model_latency(model: &str, elapsed: Duration) {
    observe(MODEL_LATENCY, &[("model", model)], elapsed.as_secs_f64());
}

/// One reported failure, by kind.
///
/// Every call site must emit a `tracing` event containing the SAME `kind` field,
/// so one incident reads identically in the logs and on a dashboard. That was a
/// claim before it was a rule: this counter had exactly one producer
/// (`llm_transport`), and the model client it lived in contained no `tracing`
/// call at all — so an expired provider key raised nothing here and said nothing
/// there.
pub fn record_error(kind: &str) {
    increment(ERRORS, &[("kind", kind)]);
}

/// The scrape route, merged onto the workload's existing HTTP listener beside
/// `/healthz` and `/readyz`.
pub fn router() -> Router {
    Router::new().route("/metrics", get(scrape))
}

async fn scrape() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, TEXT_FORMAT)], render())
}

/// Actuator-shaped management surface, `/manage/metrics` and
/// `/manage/metrics/{name}`.
///
/// Humane's backend was Spring Boot, and its per-service metrics were read at
/// exactly this path in Micrometer JSON — observed directly in a since-remediated
/// exposure report (`webapi.prod/{service}/manage/metrics/{name}`). Serving the
/// same shape means a monitoring config written against their backend reads ours
/// unchanged; it is the faithful projection of the same numbers `/metrics`
/// already exposes in Prometheus text.
///
/// It rides the SAME internal HTTP listener as `/metrics`. That placement is the
/// whole point: the report's finding was that this surface leaked because it
/// answered through an authenticated *front door* with no authorization behind
/// it. Here the edge fronts only the gRPC service router (`/humane.*`); `/manage`
/// lives on the probe listener the mesh scrapes and is unreachable from the
/// device edge by construction.
pub fn management_router() -> Router {
    Router::new()
        .route("/manage/metrics", get(metrics_list))
        .route("/manage/metrics/:name", get(metric_by_name))
        .route("/manage/health", get(manage_health))
        .route("/manage/info", get(manage_info))
}

/// `GET /manage/health` — the Actuator health surface Humane's Spring backend
/// exposed at `/manage/health` beside `/manage/metrics`. A process that can
/// answer this request is live, so it reports Spring's `{"status":"UP"}` with the
/// `livenessState` component of the `ApplicationAvailability` shape a monitoring
/// config written against their backend expects. It rides the same internal
/// probe listener as `/metrics` and is never routed from the device edge.
async fn manage_health() -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "status": "UP",
        "components": { "livenessState": { "status": "UP" } }
    }))
}

/// `GET /manage/info` — the Actuator info surface. Reports the build/deployment
/// identity Spring's `/manage/info` carried (app name, revision, region,
/// instance), sourced from this workload's own environment — no fabrication, an
/// unset field is simply omitted.
async fn manage_info() -> impl IntoResponse {
    let env = |key: &str| {
        std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
    };
    let name = env("COSMOS_WORKLOAD")
        .map(|workload| format!("cosmos-{workload}"))
        .unwrap_or_else(|| "cosmos".to_owned());
    axum::Json(serde_json::json!({
        "app": { "name": name, "region": env("COSMOS_REGION") },
        "build": { "revision": env("COSMOS_REVISION"), "instance": env("COSMOS_INSTANCE_ID") }
    }))
}

async fn metrics_list() -> impl IntoResponse {
    axum::Json(serde_json::json!({ "names": family_names() }))
}

async fn metric_by_name(
    axum::extract::Path(name): axum::extract::Path<String>,
) -> axum::response::Response {
    match family_snapshot(&name) {
        Some(body) => axum::Json(body).into_response(),
        // Actuator answers an unknown metric with 404, which is also what the
        // report's fuzzing filtered on. Matching it keeps the surface honest:
        // absence is reported as absence, not an empty measurement set.
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

/// Every registered family name, sorted — the `{"names":[…]}` list Actuator
/// serves at `/manage/metrics`. Only families with a live producer appear, the
/// same lazy-registration rule the Prometheus scrape follows.
fn family_names() -> Vec<&'static str> {
    let registry = registry();
    let mut names: Vec<&'static str> = {
        let counters = registry
            .counters
            .read()
            .expect("metrics registry is never poisoned by a panicking observer");
        let histograms = registry
            .histograms
            .read()
            .expect("metrics registry is never poisoned by a panicking observer");
        counters.keys().chain(histograms.keys()).copied().collect()
    };
    names.sort_unstable();
    names.dedup();
    names
}

/// One family as the Micrometer JSON object the report shows: `name`,
/// `description`, optional `baseUnit`, `measurements`, and `availableTags`.
///
/// `measurements` contains only statistics this registry actually keeps: `COUNT`
/// for a counter, and `COUNT` + `TOTAL_TIME` for a histogram. Micrometer also
/// reports `MAX`; we do not track a running max, so it is omitted rather than
/// fabricated from bucket bounds — an invented statistic here is a lie told in
/// the same breath as the real ones.
fn family_snapshot(name: &str) -> Option<serde_json::Value> {
    let registry = registry();
    let description = help_for(name);

    // Collect the label values seen across every series of the family, so
    // `availableTags` reports the real cardinality without echoing anything
    // beyond the bounded, wire-derived label set already in `/metrics`.
    let mut tags: BTreeMap<&'static str, std::collections::BTreeSet<String>> = BTreeMap::new();
    let mut measurements: Vec<serde_json::Value> = Vec::new();
    let mut base_unit: Option<&str> = None;
    let mut found = false;

    {
        let counters = registry
            .counters
            .read()
            .expect("metrics registry is never poisoned by a panicking observer");
        if let Some(series) = counters.get(name) {
            found = true;
            let mut count = 0.0_f64;
            for (key, value) in series.iter() {
                count += value.load(Ordering::Relaxed) as f64;
                for (tag, val) in key {
                    tags.entry(tag).or_default().insert(val.clone());
                }
            }
            measurements.push(serde_json::json!({ "statistic": "COUNT", "value": count }));
        }
    }
    {
        let histograms = registry
            .histograms
            .read()
            .expect("metrics registry is never poisoned by a panicking observer");
        if let Some(series) = histograms.get(name) {
            found = true;
            base_unit = Some("seconds");
            let mut count = 0.0_f64;
            let mut total = 0.0_f64;
            for (key, histogram) in series.iter() {
                count += histogram.count.load(Ordering::Relaxed) as f64;
                total += histogram.sum_micros.load(Ordering::Relaxed) as f64 / 1e6;
                for (tag, val) in key {
                    tags.entry(tag).or_default().insert(val.clone());
                }
            }
            measurements.push(serde_json::json!({ "statistic": "COUNT", "value": count }));
            measurements.push(serde_json::json!({ "statistic": "TOTAL_TIME", "value": total }));
        }
    }

    if !found {
        return None;
    }

    let available_tags: Vec<serde_json::Value> = tags
        .into_iter()
        .map(|(tag, values)| {
            serde_json::json!({ "tag": tag, "values": values.into_iter().collect::<Vec<_>>() })
        })
        .collect();

    let mut body = serde_json::json!({
        "name": name,
        "description": description,
        "measurements": measurements,
        "availableTags": available_tags,
    });
    if let Some(unit) = base_unit {
        body["baseUnit"] = serde_json::Value::String(unit.to_owned());
    }
    Some(body)
}

fn help_for(name: &str) -> &'static str {
    HELP.iter()
        .find(|(family, _)| *family == name)
        .map(|(_, help)| *help)
        .unwrap_or("No description registered.")
}

fn render_labels(pairs: &Labels) -> String {
    if pairs.is_empty() {
        return String::new();
    }
    let rendered = pairs
        .iter()
        .map(|(name, value)| format!("{name}=\"{value}\""))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{rendered}}}")
}

fn render_labels_with(pairs: &Labels, extra: (&str, &str)) -> String {
    let mut rendered = pairs
        .iter()
        .map(|(name, value)| format!("{name}=\"{value}\""))
        .collect::<Vec<_>>();
    rendered.push(format!("{}=\"{}\"", extra.0, extra.1));
    format!("{{{}}}", rendered.join(","))
}

/// The whole scrape, as text. Families and series are emitted in sorted order so
/// two consecutive scrapes of an idle server differ only in the numbers.
pub fn render() -> String {
    let registry = registry();
    let mut families: BTreeMap<&'static str, (&'static str, Vec<String>)> = BTreeMap::new();

    {
        let counters = registry
            .counters
            .read()
            .expect("metrics registry is never poisoned by a panicking observer");
        for (name, series) in counters.iter() {
            let mut lines = series
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{name}{} {}",
                        render_labels(key),
                        value.load(Ordering::Relaxed)
                    )
                })
                .collect::<Vec<_>>();
            lines.sort();
            families.insert(name, ("counter", lines));
        }
    }
    {
        let histograms = registry
            .histograms
            .read()
            .expect("metrics registry is never poisoned by a panicking observer");
        for (name, series) in histograms.iter() {
            let mut lines = Vec::new();
            for (key, histogram) in series.iter() {
                let mut block = Vec::new();
                for (index, bound) in BUCKETS.iter().enumerate() {
                    block.push(format!(
                        "{name}_bucket{} {}",
                        render_labels_with(key, ("le", &format!("{bound}"))),
                        histogram.buckets[index].load(Ordering::Relaxed)
                    ));
                }
                let count = histogram.count.load(Ordering::Relaxed);
                block.push(format!(
                    "{name}_bucket{} {count}",
                    render_labels_with(key, ("le", "+Inf"))
                ));
                block.push(format!(
                    "{name}_sum{} {:.6}",
                    render_labels(key),
                    histogram.sum_micros.load(Ordering::Relaxed) as f64 / 1e6
                ));
                block.push(format!("{name}_count{} {count}", render_labels(key)));
                // Sorting by the series key rather than the line keeps each
                // histogram's buckets in bucket order, which the format requires.
                lines.push((render_labels(key), block));
            }
            lines.sort_by(|left, right| left.0.cmp(&right.0));
            families.insert(
                name,
                (
                    "histogram",
                    lines.into_iter().flat_map(|(_, block)| block).collect(),
                ),
            );
        }
    }

    let mut out = String::new();
    for (name, (kind, lines)) in families {
        out.push_str(&format!("# HELP {name} {}\n", help_for(name)));
        out.push_str(&format!("# TYPE {name} {kind}\n"));
        for line in lines {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out.push_str("# HELP cosmos_metrics_series_dropped_total Series refused by the per-family cardinality cap.\n");
    out.push_str("# TYPE cosmos_metrics_series_dropped_total counter\n");
    out.push_str(&format!(
        "cosmos_metrics_series_dropped_total {}\n",
        registry.dropped.load(Ordering::Relaxed)
    ));
    out
}

/// Split `/humane.featureflags.FeatureFlagsService/GetFlags` into its two parts.
///
/// Anything not shaped like a gRPC path is folded into a single `other` series
/// rather than being echoed: the path is peer-controlled, and one series per
/// junk request is how a metrics endpoint becomes a memory leak.
fn split_grpc_path(path: &str) -> (String, String) {
    let mut parts = path.trim_start_matches('/').split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(service), Some(method), None)
            if !service.is_empty()
                && !method.is_empty()
                && service.len() <= MAX_LABEL_LEN
                && method.len() <= MAX_LABEL_LEN
                && service
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
                && method
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_') =>
        {
            (service.to_owned(), method.to_owned())
        }
        _ => ("other".to_owned(), "other".to_owned()),
    }
}

/// The gRPC status names, indexed by code.
const STATUS_NAMES: &[&str] = &[
    "ok",
    "cancelled",
    "unknown",
    "invalid_argument",
    "deadline_exceeded",
    "not_found",
    "already_exists",
    "permission_denied",
    "resource_exhausted",
    "failed_precondition",
    "aborted",
    "out_of_range",
    "unimplemented",
    "internal",
    "unavailable",
    "data_loss",
    "unauthenticated",
];

/// Read the call's terminal status off the response head.
///
/// tonic encodes a handler's `Err(Status)` as a trailers-only response —
/// `Status::into_http` puts `grpc-status` in the HEADERS (tonic 0.12
/// `src/status.rs:582`, reached from `server/grpc.rs:20`) — so every rejected
/// call is visible here. A success carries `grpc-status: 0` in the trailers
/// instead, which this layer does not read; that is why a 200 with no
/// `grpc-status` header is recorded as `ok`. The one case that misreports is a
/// *stream* that fails after its headers were sent: it is counted `ok` here and
/// has to be found in the logs. Reading trailers would mean replacing the
/// response body, and that cost is not worth paying for a case the duration
/// histogram already makes visible.
fn outcome_of<B>(response: &Response<B>) -> String {
    if let Some(code) = response
        .headers()
        .get("grpc-status")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        return STATUS_NAMES
            .get(code)
            .map(|name| (*name).to_owned())
            .unwrap_or_else(|| "unknown".to_owned());
    }
    if response.status().is_success() {
        "ok".to_owned()
    } else {
        format!("http_{}", response.status().as_u16())
    }
}

/// Counts and times every gRPC call the workload serves.
///
/// Applied to the tonic server builder alongside `ServicePathLayer` and
/// `AuthLayer`, so it sees authenticated and rejected calls alike — a burst of
/// `unauthenticated` is exactly the signal an operator needs and would be
/// invisible if this sat inside the handlers.
#[derive(Clone, Default)]
pub struct RpcMetricsLayer;

impl RpcMetricsLayer {
    pub fn new() -> Self {
        Self
    }
}

impl<S> Layer<S> for RpcMetricsLayer {
    type Service = RpcMetrics<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RpcMetrics { inner }
    }
}

#[derive(Clone)]
pub struct RpcMetrics<S> {
    inner: S,
}

impl<S, RequestBody, ResponseBody> Service<Request<RequestBody>> for RpcMetrics<S>
where
    S: Service<Request<RequestBody>, Response = Response<ResponseBody>> + Send + 'static,
    S::Future: Send + 'static,
    RequestBody: Send + 'static,
    ResponseBody: Send + 'static,
{
    type Response = Response<ResponseBody>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: Request<RequestBody>) -> Self::Future {
        let (service, method) = split_grpc_path(request.uri().path());
        let started = Instant::now();
        let future = self.inner.call(request);
        Box::pin(async move {
            let result = future.await;
            let elapsed = started.elapsed().as_secs_f64();
            // A transport-level failure never reached a handler, so it has no
            // gRPC status; it is still a served request that ended badly.
            let outcome = match &result {
                Ok(response) => outcome_of(response),
                Err(_) => "transport_error".to_owned(),
            };
            let pairs: [(&'static str, &str); 3] = [
                ("service", service.as_str()),
                ("method", method.as_str()),
                ("outcome", outcome.as_str()),
            ];
            increment(RPC_REQUESTS, &pairs);
            observe(RPC_DURATION, &pairs[..2], elapsed);
            result
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, net::SocketAddr, time::Duration};

    use cosmos_protocol::account::user_information_service_client::UserInformationServiceClient;
    use cosmos_protocol::featureflags::{
        DeviceFeatureFlagRequest, feature_flags_service_client::FeatureFlagsServiceClient,
    };

    use super::*;
    use crate::{config::Config, serve_until};

    async fn unused_loopback_address() -> SocketAddr {
        tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind temporary listener")
            .local_addr()
            .expect("temporary local address")
    }

    /// Read the value of one rendered counter series. `None` when the series is
    /// absent, which is a different answer from zero and the tests below rely on
    /// the difference.
    fn series(scrape: &str, prefix: &str) -> Option<u64> {
        scrape
            .lines()
            .find(|line| line.starts_with(prefix))
            .and_then(|line| line.rsplit(' ').next())
            .and_then(|value| value.parse().ok())
    }

    /// The whole wired path: a real gRPC call through the real server, counted
    /// by the layer `lib.rs` installs, and read back off the real HTTP listener.
    ///
    /// Driving the layer with a stub inner service would prove only that the
    /// layer compiles; it would stay green if the wiring in `lib.rs` were
    /// deleted, which is the failure this is here to catch.
    #[tokio::test]
    async fn a_served_rpc_is_counted_and_scrapable_from_the_http_listener() {
        let grpc_address = unused_loopback_address().await;
        let http_address = unused_loopback_address().await;
        let values = HashMap::from([
            (
                "COSMOS_AUTH_MODE".to_owned(),
                "development-insecure".to_owned(),
            ),
            ("COSMOS_WORKLOAD".to_owned(), "feature-flags".to_owned()),
            ("COSMOS_GRPC_BIND".to_owned(), grpc_address.to_string()),
            ("COSMOS_HTTP_BIND".to_owned(), http_address.to_string()),
            ("COSMOS_SHUTDOWN_GRACE_MS".to_owned(), "2000".to_owned()),
        ]);
        let config = Config::from_map(&values).expect("local feature-flags config");
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_until(config, async move {
            let _ = shutdown_rx.await;
        }));

        let endpoint = tonic::transport::Endpoint::from_shared(format!("http://{grpc_address}"))
            .expect("valid endpoint URI");
        let mut channel = None;
        for _ in 0..40 {
            match endpoint.clone().connect().await {
                Ok(connected) => {
                    channel = Some(connected);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        let channel = channel.expect("feature-flags gRPC server became reachable");

        let before = render();
        let served = series(
            &before,
            "cosmos_rpc_requests_total{service=\"humane.featureflags.FeatureFlagsService\",\
             method=\"GetFlags\",outcome=\"ok\"}",
        )
        .unwrap_or(0);

        FeatureFlagsServiceClient::new(channel.clone())
            .get_flags(DeviceFeatureFlagRequest {})
            .await
            .expect("get_flags succeeds");

        // A call this workload does not serve: tonic answers UNIMPLEMENTED as a
        // trailers-only response, which is the error path the outcome label
        // exists to make visible.
        UserInformationServiceClient::new(channel)
            .get_user_personal_details(())
            .await
            .expect_err("the feature-flags workload does not serve account RPCs");

        let scrape = reqwest::get(format!("http://{http_address}/metrics"))
            .await
            .expect("scrape the workload's own HTTP listener");
        assert_eq!(scrape.status(), reqwest::StatusCode::OK);
        assert_eq!(
            scrape
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some(TEXT_FORMAT),
            "a scrape Prometheus cannot parse is not observability"
        );
        let scrape = scrape.text().await.expect("scrape body");

        let after = series(
            &scrape,
            "cosmos_rpc_requests_total{service=\"humane.featureflags.FeatureFlagsService\",\
             method=\"GetFlags\",outcome=\"ok\"}",
        );
        assert_eq!(
            after,
            Some(served + 1),
            "the served GetFlags call must appear in the scrape; got:\n{scrape}"
        );
        assert!(
            scrape.contains(
                "cosmos_rpc_requests_total{service=\"humane.account.UserInformationService\",\
                 method=\"GetUserPersonalDetails\",outcome=\"unimplemented\"}"
            ),
            "a rejected call must be counted under its gRPC status, not as ok; got:\n{scrape}"
        );
        assert!(
            scrape.contains(
                "cosmos_rpc_duration_seconds_count{service=\"humane.featureflags.\
                 FeatureFlagsService\",method=\"GetFlags\"}"
            ),
            "handler latency must be recorded; got:\n{scrape}"
        );
        assert!(
            scrape.contains("# TYPE cosmos_rpc_duration_seconds histogram"),
            "the histogram family must declare its type; got:\n{scrape}"
        );

        // The Actuator projection must ride the SAME internal listener and read
        // the SAME registry — the faithful shape Humane's Spring backend served.
        // Asserted against the live server, so it goes red if the
        // `management_router()` merge in `lib.rs` is dropped.
        let list: serde_json::Value = reqwest::get(format!("http://{http_address}/manage/metrics"))
            .await
            .expect("list metrics")
            .json()
            .await
            .expect("metrics list is JSON");
        assert!(
            list["names"]
                .as_array()
                .expect("names is an array")
                .iter()
                .any(|n| n == "cosmos_rpc_duration_seconds"),
            "the served family must be listed at /manage/metrics; got {list}"
        );

        let metric: serde_json::Value = reqwest::get(format!(
            "http://{http_address}/manage/metrics/cosmos_rpc_duration_seconds"
        ))
        .await
        .expect("read one metric")
        .json()
        .await
        .expect("metric drill-down is JSON");
        // The exact shape from the report: name, baseUnit, measurements, availableTags.
        assert_eq!(metric["baseUnit"], "seconds");
        let stats: Vec<&str> = metric["measurements"]
            .as_array()
            .expect("measurements is an array")
            .iter()
            .map(|m| m["statistic"].as_str().unwrap_or(""))
            .collect();
        assert!(
            stats.contains(&"COUNT") && stats.contains(&"TOTAL_TIME"),
            "a timer reports COUNT and TOTAL_TIME like Micrometer; got {metric}"
        );
        // availableTags carries only the bounded, public label set — method names,
        // never a principal or wearer content. This is the property whose ABSENCE
        // was Humane's leak: their drill-down exposed repository and schema names.
        let method_tag = metric["availableTags"]
            .as_array()
            .expect("availableTags is an array")
            .iter()
            .find(|t| t["tag"] == "method")
            .expect("the method tag is present");
        assert!(
            method_tag["values"]
                .as_array()
                .expect("tag values are an array")
                .iter()
                .any(|v| v == "GetFlags"),
            "the served method must appear as a tag value; got {metric}"
        );

        // An unknown metric is 404, exactly as Actuator answers — and exactly the
        // status the report's fuzzing filtered on. Absence reported as absence.
        let missing = reqwest::get(format!(
            "http://{http_address}/manage/metrics/cosmos_no_such_family"
        ))
        .await
        .expect("request an unknown metric");
        assert_eq!(
            missing.status(),
            reqwest::StatusCode::NOT_FOUND,
            "an unregistered metric must 404, not answer an empty measurement set"
        );

        shutdown_tx.send(()).expect("request shutdown");
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server stops before test timeout")
            .expect("server task completes")
            .expect("server exits cleanly");
    }

    /// A series nobody observed must be ABSENT, not zero. A zero is a claim
    /// ("this failure has not happened"), and a family with no producer wired to
    /// it would make that claim on evidence nobody collected.
    #[tokio::test]
    async fn an_unobserved_series_is_absent_rather_than_reported_as_zero() {
        record_error("metrics_test_observed_kind");
        let scrape = render();
        assert!(
            scrape.contains("cosmos_errors_total{kind=\"metrics_test_observed_kind\"}"),
            "an observed error kind must appear; got:\n{scrape}"
        );
        assert!(
            !scrape.contains("metrics_test_unobserved_kind"),
            "an error kind nothing reported must not be published as a zero; got:\n{scrape}"
        );
    }

    /// Label values arrive off the wire. A value that closes the label list would
    /// let a peer write whole metric lines into an operator's monitoring.
    #[tokio::test]
    async fn a_label_value_cannot_forge_a_metric_line() {
        record_error("hostile\"} cosmos_rpc_requests_total{forged=\"yes");
        let scrape = render();
        assert!(
            !scrape.contains("forged=\"yes\"}"),
            "an escaped label must not close its own label list; got:\n{scrape}"
        );
        assert!(
            scrape.contains("cosmos_errors_total{kind=\"hostile\\\"} "),
            "the quote must be escaped, not dropped, so the value stays readable; \
             got:\n{scrape}"
        );
        // Every emitted line belongs to the family that emitted it.
        for line in scrape.lines().filter(|line| !line.starts_with('#')) {
            assert!(
                line.starts_with("cosmos_"),
                "a scrape line escaped its family: {line}"
            );
        }
    }

    /// Peer-controlled labels must not grow this map without bound, and the loss
    /// must be visible rather than silent.
    #[tokio::test]
    async fn a_capped_family_drops_new_series_and_says_so() {
        let before = registry().dropped.load(Ordering::Relaxed);
        for index in 0..(MAX_SERIES_PER_FAMILY + 8) {
            increment(
                "cosmos_metrics_test_cap_total",
                &[("n", &index.to_string())],
            );
        }
        let after = registry().dropped.load(Ordering::Relaxed);
        assert!(
            after >= before + 8,
            "series past the cap must be counted as dropped ({before} -> {after})"
        );
        let series_count = registry()
            .counters
            .read()
            .expect("registry")
            .get("cosmos_metrics_test_cap_total")
            .map(HashMap::len)
            .unwrap_or(0);
        assert_eq!(
            series_count, MAX_SERIES_PER_FAMILY,
            "the cap must hold: an unbounded label is how a scrape endpoint \
             becomes a memory leak"
        );
        assert!(
            render().contains("cosmos_metrics_series_dropped_total "),
            "the drop counter must always be published, including as a zero — it \
             has a producer, so zero is a measurement"
        );
    }

    /// A path that is not a gRPC method must not become its own series.
    #[test]
    fn a_junk_request_path_folds_into_one_series() {
        assert_eq!(
            split_grpc_path("/humane.featureflags.FeatureFlagsService/GetFlags"),
            (
                "humane.featureflags.FeatureFlagsService".to_owned(),
                "GetFlags".to_owned()
            )
        );
        for junk in [
            "/",
            "/one",
            "/a/b/c",
            "/humane.Service/Method?cache-buster=1",
            "/capture/8f14e45f-ce0a-4f2b-8f7a-000000000000",
        ] {
            assert_eq!(
                split_grpc_path(junk),
                ("other".to_owned(), "other".to_owned()),
                "{junk} must not mint a series"
            );
        }
    }
}
