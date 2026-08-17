//! Bounded, authenticated read access to persisted turn traces.
//!
//! The parent API router must merge this router inside the existing admin-auth
//! middleware, which guards every `/api/*` path except `/api/health`.
//!
//! Free text is served only while `llm.turn_trace_content` is on, and the check
//! reads the *live* config rather than trusting what was on disk: disarming the
//! flag closes the capture window and the read window together. Without that, a
//! durable log plus an authenticated endpoint would be a way to retrieve
//! content the current policy says must not be exposed.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::Config;
use crate::turn_trace::TurnTraceRecord;
use crate::turn_trace_log::{TurnTraceLogger, DEFAULT_TRACE_READ_LIMIT, MAX_TRACE_READ_LIMIT};

/// Bound on `{correlation}`. Correlations are short machine identifiers minted
/// per turn; anything longer is a caller error, not a trace that exists.
const MAX_CORRELATION_BYTES: usize = 128;

#[derive(Clone)]
pub struct TraceApiState {
    logger: TurnTraceLogger,
    shared_config: Arc<RwLock<Config>>,
}

pub fn router(logger: TurnTraceLogger, shared_config: Arc<RwLock<Config>>) -> Router {
    Router::new()
        .route("/api/traces", get(list_traces))
        .route("/api/traces/{correlation}", get(get_trace))
        .with_state(TraceApiState {
            logger,
            shared_config,
        })
}

impl TraceApiState {
    /// Whether free text may be served, read from the live config at request
    /// time so a settings change takes effect on the next read.
    async fn include_content(&self) -> bool {
        self.shared_config.read().await.llm.turn_trace_content
    }

    async fn enabled(&self) -> bool {
        self.shared_config.read().await.llm.turn_trace
    }
}

#[derive(Debug, Deserialize)]
struct TraceQuery {
    limit: Option<usize>,
}

impl TraceQuery {
    fn limit(&self) -> usize {
        self.limit
            .unwrap_or(DEFAULT_TRACE_READ_LIMIT)
            .clamp(1, MAX_TRACE_READ_LIMIT)
    }
}

#[derive(Debug, Serialize)]
struct TracePage {
    /// True while `llm.turn_trace` is armed. When false, anything listed is
    /// what an earlier capture window left on disk, not a live recording.
    enabled: bool,
    /// True while free text may be served. When false every trace below is
    /// shape-only regardless of what was captured.
    include_content: bool,
    items: Vec<TurnTraceRecord>,
}

#[derive(Debug, Serialize)]
struct TraceResponse {
    enabled: bool,
    include_content: bool,
    trace: TurnTraceRecord,
}

async fn list_traces(
    State(state): State<TraceApiState>,
    Query(query): Query<TraceQuery>,
) -> Json<TracePage> {
    let include_content = state.include_content().await;
    let items = state.logger.recent(query.limit(), include_content).await;
    Json(TracePage {
        enabled: state.enabled().await,
        include_content,
        items,
    })
}

async fn get_trace(
    Path(correlation): Path<String>,
    State(state): State<TraceApiState>,
) -> Result<Json<TraceResponse>, StatusCode> {
    if correlation.is_empty()
        || correlation.len() > MAX_CORRELATION_BYTES
        || !correlation.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    let include_content = state.include_content().await;
    let trace = state
        .logger
        .find(&correlation, include_content)
        .await
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(TraceResponse {
        enabled: state.enabled().await,
        include_content,
        trace,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, Request};
    use axum::middleware::from_fn_with_state;
    use axum::routing::any;
    use http_body_util::BodyExt as _;
    use serde_json::Value;
    use tower::ServiceExt as _;

    use crate::api::{require_admin_auth, AdminAuthState};
    use crate::config::MIN_ADMIN_TOKEN_BYTES;
    use crate::turn_trace::{TracePolicy, TurnTracer};
    use crate::turn_trace_log::TurnTraceLogger;

    fn admin_token() -> String {
        "a".repeat(MIN_ADMIN_TOKEN_BYTES)
    }

    /// Production layering: the real trace routes, merged behind the real
    /// admin-auth middleware and the real `/api/*` catch-all.
    async fn app(dir: &tempfile::TempDir, content: bool) -> Router {
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.server.admin_token = Some(admin_token());
        config.llm.turn_trace = true;
        config.llm.turn_trace_content = content;
        let shared_config = Arc::new(RwLock::new(config));
        let auth = AdminAuthState::new(shared_config.clone());

        Router::new()
            .route("/api", any(|| async { StatusCode::NOT_FOUND }))
            .route("/api/{*path}", any(|| async { StatusCode::NOT_FOUND }))
            .merge(router(
                TurnTraceLogger::new(dir.path().to_path_buf()),
                shared_config,
            ))
            .layer(from_fn_with_state(auth, require_admin_auth))
    }

    async fn write_trace(dir: &tempfile::TempDir, correlation: &str) {
        let policy = TracePolicy {
            enabled: true,
            include_content: true,
        };
        let tracer = TurnTracer::new(
            policy,
            correlation,
            "play the best one",
            "2026-07-31".into(),
        );
        tracer.gate(
            "music_grounding",
            false,
            "music_target_not_grounded",
            &[("targets", 1)],
        );
        TurnTraceLogger::new(dir.path().to_path_buf())
            .append(policy, tracer.finish().unwrap())
            .await;
    }

    async fn get(app: Router, uri: &str, token: Option<&str>) -> (StatusCode, Value) {
        let mut builder = Request::builder().uri(uri);
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn both_endpoints_require_the_admin_token() {
        let dir = tempfile::tempdir().unwrap();
        write_trace(&dir, "turn-1").await;

        for uri in ["/api/traces", "/api/traces?limit=5", "/api/traces/turn-1"] {
            assert_eq!(
                get(app(&dir, false).await, uri, None).await.0,
                StatusCode::UNAUTHORIZED,
                "{uri} must not be readable without a token"
            );
            assert_eq!(
                get(
                    app(&dir, false).await,
                    uri,
                    Some("Bearer wrong-token-long-enough-to-parse")
                )
                .await
                .0,
                StatusCode::UNAUTHORIZED,
                "{uri} must not be readable with the wrong token"
            );
            assert_eq!(
                get(app(&dir, false).await, uri, Some(&admin_token()))
                    .await
                    .0,
                StatusCode::OK,
                "{uri} must be readable with the right token"
            );
        }
    }

    #[tokio::test]
    async fn the_list_is_newest_first_and_honours_limit() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..4 {
            write_trace(&dir, &format!("turn-{index}")).await;
        }

        let (status, body) = get(
            app(&dir, false).await,
            "/api/traces?limit=2",
            Some(&admin_token()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"][0]["correlation"], "turn-3");
        assert_eq!(body["items"][1]["correlation"], "turn-2");
        assert_eq!(body["items"].as_array().unwrap().len(), 2);

        // An absurd limit is clamped, not honoured.
        let (_, body) = get(
            app(&dir, false).await,
            "/api/traces?limit=100000",
            Some(&admin_token()),
        )
        .await;
        assert_eq!(body["items"].as_array().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn one_trace_is_addressable_by_correlation() {
        let dir = tempfile::tempdir().unwrap();
        write_trace(&dir, "turn-1").await;

        let (status, body) = get(
            app(&dir, false).await,
            "/api/traces/turn-1",
            Some(&admin_token()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["trace"]["correlation"], "turn-1");
        assert_eq!(
            body["trace"]["events"][0]["reason"],
            "music_target_not_grounded"
        );

        assert_eq!(
            get(
                app(&dir, false).await,
                "/api/traces/turn-9",
                Some(&admin_token())
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let overlong = "t".repeat(MAX_CORRELATION_BYTES + 1);
        assert_eq!(
            get(
                app(&dir, false).await,
                &format!("/api/traces/{overlong}"),
                Some(&admin_token())
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn content_is_withheld_while_the_content_flag_is_off() {
        let dir = tempfile::tempdir().unwrap();
        // Written with content on: the text really is on disk.
        write_trace(&dir, "turn-1").await;

        let (_, armed) = get(app(&dir, true).await, "/api/traces", Some(&admin_token())).await;
        assert_eq!(armed["include_content"], true);
        assert_eq!(armed["items"][0]["utterance"], "play the best one");

        // Same file, content flag off: the endpoint must not hand it back.
        let (_, disarmed) = get(app(&dir, false).await, "/api/traces", Some(&admin_token())).await;
        assert_eq!(disarmed["include_content"], false);
        assert!(
            disarmed["items"][0]["utterance"].is_null(),
            "a disarmed content flag must not serve text captured while it was armed"
        );
        assert_eq!(
            disarmed["items"][0]["utterance_chars"], 17,
            "the shape is still diagnostic"
        );

        let (_, single) = get(
            app(&dir, false).await,
            "/api/traces/turn-1",
            Some(&admin_token()),
        )
        .await;
        assert!(single["trace"]["utterance"].is_null());
    }
}
