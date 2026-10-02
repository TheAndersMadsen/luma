//! A dependency-light metrics surface, scraped over the existing HTTP listener.
//!
//! An operator watching this deployment could previously distinguish a healthy
//! server from a silently failing one only by asking a device to try. `/healthz`
//! and `/readyz` answer from process state, not from work actually completed, so
//! a workload that serves `UNAVAILABLE` to every RPC looks exactly like one
//! serving none, same 204, same logs (there are none per request).
//!
//! What is recorded here is deliberately narrow: **counts and durations of RPCs,
//! keyed by the method name off the wire**. Nothing a wearer said, captured, or
//! stored appears in a metric label, and no principal, device id, or capability
//! token does either. That constraint is why the HTTP router is NOT instrumented,
//! its capture route carries a redemption capability in the path
//! (`/capture/{token}`, see `http/mod.rs`), and recording request paths there would
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
//! below are entry points for the assistant engine and have no call site yet,
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
/// Assistant turns, labelled `outcome`. Fed by the engine. See the module note.
const TURNS: &str = "cosmos_assistant_turns_total";
/// Tool invocations the engine made, labelled `tool` and `outcome`.
const TOOL_CALLS: &str = "cosmos_assistant_tool_calls_total";
/// Language-model round trips, labelled `model`.
const MODEL_LATENCY: &str = "cosmos_model_latency_seconds";
/// Production-plane assistant runs, with bounded content-free provenance.
const AGENT_RUNS: &str = "cosmos_agent_runs_total";
/// End-to-end production-plane assistant run latency.
const AGENT_RUN_DURATION: &str = "cosmos_agent_run_duration_seconds";
/// Grounded music discovery, with bounded semantic/provider outcome labels.
const MUSIC_DISCOVERY: &str = "cosmos_music_discovery_total";
/// End-to-end web discovery plus provider verification latency.
const MUSIC_DISCOVERY_DURATION: &str = "cosmos_music_discovery_duration_seconds";
/// Per-stage latency for the bounded research, corroboration, provider, and action path.
const MUSIC_DISCOVERY_STAGE_DURATION: &str = "cosmos_music_discovery_stage_duration_seconds";
/// Content-free shape of a completed discovery path.
const MUSIC_DISCOVERY_RESOLUTION: &str = "cosmos_music_discovery_resolution_total";
/// Failures the server chose to report, labelled `kind`, the same `kind` the
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
    (
        AGENT_RUNS,
        "Foreground assistant runs by planner plane, transport, route, model use, and terminal outcome.",
    ),
    (
        AGENT_RUN_DURATION,
        "Foreground assistant run latency by transport, route, and terminal outcome.",
    ),
    (
        MUSIC_DISCOVERY,
        "Grounded music discoveries, by criterion, provider, ranking provenance, and outcome.",
    ),
    (
        MUSIC_DISCOVERY_DURATION,
        "Grounded music discovery and provider verification latency in seconds.",
    ),
    (
        MUSIC_DISCOVERY_STAGE_DURATION,
        "Bounded music discovery stage latency in seconds, by stage and outcome.",
    ),
    (
        MUSIC_DISCOVERY_RESOLUTION,
        "Music discovery resolutions, by candidate count, selected index, corroboration, and disagreement.",
    ),
    (ERRORS, "Errors reported by the server, by kind."),
];

/// Upper bounds, in seconds. The top of the range matches the signed Hook's
/// 90-second `AIMIC_TIMEOUT_MS`. Cosmos normally settles inside its 70-second
/// foreground budget, but the outer bucket preserves visibility through the
/// final delivery margin.
const BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 90.0,
];

/// Per-family series ceiling. Label values are derived from request paths, which
/// arrive off the wire: without a cap, a peer that varies the path varies the
/// key and grows this map until the process dies. Past the cap new series are
/// dropped and counted, so the loss is visible in the scrape rather than silent.
const MAX_SERIES_PER_FAMILY: usize = 256;

/// Longest label value kept. Anything longer is truncated, a label is an
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
/// an operator's monitoring, so quotes, backslashes, and newlines are escaped
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

/// One completed assistant turn. `outcome` is a short constant, `answered`,
/// `no_model`, `deadline`, never wearer text.
pub fn record_turn(outcome: &str) {
    increment(TURNS, &[("outcome", outcome)]);
}

/// One tool invocation. `tool` is the catalog action name, `outcome` a short
/// constant. Tool *arguments* are wearer content and must not be passed here.
pub fn record_tool_call(tool: &str, outcome: &str) {
    increment(TOOL_CALLS, &[("tool", tool), ("outcome", outcome)]);
}

/// One language-model round trip. `model` is the configured model id.
pub fn record_model_latency(model: &str, elapsed: Duration) {
    observe(MODEL_LATENCY, &[("model", model)], elapsed.as_secs_f64());
}

/// Content-free dimensions for one completed remote-Cosmos foreground run.
pub struct AgentRunMetric<'a> {
    pub transport: &'a str,
    pub route: &'a str,
    pub model_invoked: &'a str,
    pub model_steps: &'a str,
    pub model_provider: &'a str,
    pub model: &'a str,
    pub model_speed: &'a str,
    pub reasoning_effort: &'a str,
    pub terminal: &'a str,
    pub elapsed: Duration,
}

/// Record one remote-Cosmos foreground run without any wearer content.
pub fn record_agent_run(run: AgentRunMetric<'_>) {
    increment(
        AGENT_RUNS,
        &[
            ("planner_plane", "cosmos_remote"),
            ("transport", run.transport),
            ("route", run.route),
            ("model_invoked", run.model_invoked),
            ("model_steps", run.model_steps),
            ("model_provider", run.model_provider),
            ("model", run.model),
            ("model_speed", run.model_speed),
            ("reasoning_effort", run.reasoning_effort),
            ("terminal", run.terminal),
        ],
    );
    observe(
        AGENT_RUN_DURATION,
        &[
            ("transport", run.transport),
            ("route", run.route),
            ("terminal", run.terminal),
        ],
        run.elapsed.as_secs_f64(),
    );
}

/// Record semantic music discovery without wearer text or provider identifiers.
///
/// Every argument is selected from a bounded constant set by the caller. Track,
/// artist, principal, and raw model output must never be passed here.
pub fn record_music_discovery(
    criterion: &str,
    provider: &str,
    ranking: &str,
    outcome: &str,
    elapsed: Duration,
) {
    let labels = [
        ("criterion", criterion),
        ("provider", provider),
        ("ranking", ranking),
        ("outcome", outcome),
    ];
    increment(MUSIC_DISCOVERY, &labels);
    observe(
        MUSIC_DISCOVERY_DURATION,
        &[("criterion", criterion), ("outcome", outcome)],
        elapsed.as_secs_f64(),
    );
}

/// One bounded stage in semantic music discovery. Both labels are selected from
/// fixed caller-owned sets. Source URLs, titles, artists, and wearer text never
/// enter the metric.
pub fn record_music_discovery_stage(stage: &str, outcome: &str, elapsed: Duration) {
    observe(
        MUSIC_DISCOVERY_STAGE_DURATION,
        &[("stage", stage), ("outcome", outcome)],
        elapsed.as_secs_f64(),
    );
}

/// Content-free summary of the candidate path used to settle a music request.
pub fn record_music_discovery_resolution(
    candidates: usize,
    match_index: Option<usize>,
    corroborated: bool,
    disagreement: bool,
) {
    let candidates = match candidates {
        0 => "0",
        1 => "1",
        2 => "2",
        _ => "3",
    };
    let match_index = match match_index {
        Some(0) => "0",
        Some(1) => "1",
        Some(_) => "2",
        None => "none",
    };
    increment(
        MUSIC_DISCOVERY_RESOLUTION,
        &[
            ("candidates", candidates),
            ("match_index", match_index),
            ("corroborated", if corroborated { "true" } else { "false" }),
            ("disagreement", if disagreement { "true" } else { "false" }),
        ],
    );
}

/// One reported failure, by kind.
///
/// Every call site must emit a `tracing` event containing the SAME `kind` field,
/// so one incident reads identically in the logs and on a dashboard. That was a
/// claim before it was a rule: this counter had exactly one producer
/// (`llm_transport`), and the model client it lived in contained no `tracing`
/// call at all, so an expired provider key raised nothing here and said nothing
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
/// exactly this path in Micrometer JSON, observed directly in a since-remediated
/// exposure report (`webapi.prod/{service}/manage/metrics/{name}`). Serving the
/// same shape means a monitoring config written against their backend reads ours
/// unchanged. It is the faithful projection of the same numbers `/metrics`
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

/// `GET /manage/health`, the Actuator health surface Humane's Spring backend
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

/// `GET /manage/info`, the Actuator info surface. Reports the build/deployment
/// identity Spring's `/manage/info` carried (app name, revision, region,
/// instance), sourced from this workload's own environment, no fabrication, an
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

/// Every registered family name, sorted, the `{"names":[…]}` list Actuator
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
/// reports `MAX`. We do not track a running max, so it is omitted rather than
/// fabricated from bucket bounds, an invented statistic here is a lie told in
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
/// tonic encodes a handler's `Err(Status)` as a trailers-only response,
/// `Status::into_http` puts `grpc-status` in the HEADERS (tonic 0.12
/// `src/status.rs:582`, reached from `server/grpc.rs:20`), so every rejected
/// call is visible here. A success carries `grpc-status: 0` in the trailers
/// instead, which this layer does not read. That is why a 200 with no
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
/// `AuthLayer`, so it sees authenticated and rejected calls alike, a burst of
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
            // gRPC status. It is still a served request that ended badly.
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
    use super::*;

    #[test]
    fn agent_run_provenance_includes_the_actual_model_configuration_without_content() {
        record_agent_run(AgentRunMetric {
            transport: "bidi",
            route: "a2",
            model_invoked: "true",
            model_steps: "2",
            model_provider: "codex_subscription",
            model: "gpt-5.6-sol",
            model_speed: "fast",
            reasoning_effort: "low",
            terminal: "answered",
            elapsed: Duration::from_millis(125),
        });
        let scrape = render();
        assert!(scrape.contains(
            "cosmos_agent_runs_total{planner_plane=\"cosmos_remote\",transport=\"bidi\",route=\"a2\",model_invoked=\"true\",model_steps=\"2\",model_provider=\"codex_subscription\",model=\"gpt-5.6-sol\",model_speed=\"fast\",reasoning_effort=\"low\",terminal=\"answered\"}"
        ));
        assert!(!scrape.contains("utterance="));
        assert!(!scrape.contains("principal="));
        assert!(!scrape.contains("tool_arguments="));
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
}
