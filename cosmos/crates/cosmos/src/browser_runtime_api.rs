//! Thin authenticated browser adapter. The Store owns all delivery authority.
#[cfg(test)]
#[path = "browser_runtime_api_tests.rs"]
mod tests;
use crate::{
    ambiance::{
        Action, ActionStatus, BrowserProof, Channel, RuntimeError, RuntimeOperation, RuntimeResult,
        runtime::AmbianceRuntime,
    },
    web_auth::JwtVerifier,
};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
struct ApiState {
    runtime: Arc<AmbianceRuntime>,
    verifier: Option<Arc<JwtVerifier>>,
}
pub fn router(runtime: Arc<AmbianceRuntime>) -> Router {
    with_verifier(runtime, crate::web_auth::configured_verifier())
}
fn with_verifier(runtime: Arc<AmbianceRuntime>, verifier: Option<Arc<JwtVerifier>>) -> Router {
    Router::new()
        .route("/runtime-api/v1/browser/status", get(status))
        .route("/runtime-api/v1/browser/poll", post(poll))
        .route("/runtime-api/v1/browser/ack", post(ack))
        .route("/runtime-api/v1/browser/input", post(input))
        .layer(axum::middleware::map_response(no_store))
        .with_state(ApiState { runtime, verifier })
}
async fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        axum::http::HeaderValue::from_static("nosniff"),
    );
    response
}
struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<RuntimeError> for ApiError {
    fn from(error: RuntimeError) -> Self {
        match error {
            RuntimeError::InvalidOrigin => Self(StatusCode::FORBIDDEN, "invalid_connection"),
            RuntimeError::InvalidRequest => Self(StatusCode::BAD_REQUEST, "invalid_request"),
            RuntimeError::Busy => Self(StatusCode::TOO_MANY_REQUESTS, "busy"),
            RuntimeError::Stale | RuntimeError::NotFound => {
                Self(StatusCode::CONFLICT, "stale_action")
            }
            RuntimeError::PolicyBlocked => Self(StatusCode::CONFLICT, "stale_action"),
            RuntimeError::Unavailable => Self(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        }
    }
}
fn invalid() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "invalid_request")
}
fn owner(headers: &HeaderMap, api: &ApiState) -> Result<String, ApiError> {
    let unauthorized = || ApiError(StatusCode::UNAUTHORIZED, "unauthorized");
    if headers.get_all("authorization").iter().count() != 1 {
        return Err(unauthorized());
    }
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(crate::web_auth::bearer_token)
        .ok_or_else(unauthorized)?;
    let verifier = api
        .verifier
        .as_ref()
        .ok_or(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?;
    Ok(verifier
        .verify(bearer)
        .map_err(|_| unauthorized())?
        .expose_for_authorization()
        .to_owned())
}
fn proof(
    headers: &HeaderMap,
    surface_id: Uuid,
    incarnation: Uuid,
) -> Result<BrowserProof, ApiError> {
    let denied = || ApiError(StatusCode::FORBIDDEN, "invalid_connection");
    if headers.get_all("x-cosmos-surface-token").iter().count() != 1 {
        return Err(denied());
    }
    let token = headers
        .get("x-cosmos-surface-token")
        .and_then(|v| v.to_str().ok())
        .filter(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(denied)?;
    if surface_id.is_nil() || incarnation.is_nil() {
        return Err(invalid());
    }
    Ok(BrowserProof {
        surface_id,
        incarnation,
        token_hash: crate::surface_registry::hash(token.as_bytes()),
    })
}
async fn body<T: serde::de::DeserializeOwned>(request: Request) -> Result<T, ApiError> {
    if request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(str::trim)
        != Some("application/json")
    {
        return Err(invalid());
    }
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        axum::body::to_bytes(request.into_body(), 8192),
    )
    .await
    .map_err(|_| ApiError(StatusCode::REQUEST_TIMEOUT, "request_timeout"))?
    .map_err(|_| ApiError(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large"))?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connection {
    surface_id: Uuid,
    incarnation: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    surface_id: Uuid,
    incarnation: Uuid,
    text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ack {
    surface_id: Uuid,
    incarnation: Uuid,
    action_id: Uuid,
    turn_id: Uuid,
    generation: u64,
    channel: Channel,
    content_digest: String,
}
fn command(action: &Action) -> Value {
    json!({"version":1,"actionId":action.id,"turnId":action.turn_id,"generation":action.generation,"surfaceId":action.surface_id,"incarnation":action.incarnation,"channel":"visual.card","contentDigest":action.content_digest,"content":{"kind":"text","text":action.intent.text()},"expiresAt":action.display_expires_at_ms})
}
async fn status(State(api): State<ApiState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    api.runtime
        .store
        .surfaces(&principal)
        .await
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?;
    let config = crate::integrations::active().snapshot();
    let configured = config.assistant.configured()
        && match config.assistant.provider {
            crate::integrations::AssistantProvider::OpenAiCompatible => true,
            crate::integrations::AssistantProvider::CodexSubscription => {
                crate::assistant::codex_app_server::account_status()
                    .await
                    .connected
            }
        };
    Ok(Json(
        json!({"version":1,"textInputConfigured":configured,"approvedSurfaceRequired":true}),
    ))
}
async fn poll(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let request: Connection = body(request).await?;
    let connection = proof(&headers, request.surface_id, request.incarnation)?;
    let result = api
        .runtime
        .store
        .runtime(&principal, RuntimeOperation::Poll { connection })
        .await?;
    let RuntimeResult::Pending(actions) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    if actions.len() > 32 {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    }
    let mut commands = Vec::new();
    let mut clear = Vec::new();
    for action in actions {
        if action.surface_id != request.surface_id
            || action.incarnation != request.incarnation
            || action.channel != Channel::VisualCard
        {
            return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
        }
        match action.status {
            ActionStatus::Dispatched | ActionStatus::Acknowledged => {
                if action.intent.text().len() > 4000 {
                    return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
                }
                commands.push(command(&action));
            }
            ActionStatus::Cancelled | ActionStatus::OutcomeUnknown => clear.push(action.id),
            ActionStatus::Proposed => {
                return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
            }
        }
    }
    Ok(Json(json!({"commands":commands,"clear":clear})))
}
async fn ack(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let request: Ack = body(request).await?;
    if request.channel != Channel::VisualCard
        || request.generation == 0
        || request.generation > 9_007_199_254_740_991
        || request.content_digest.len() != 64
        || !request
            .content_digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    let connection = proof(&headers, request.surface_id, request.incarnation)?;
    let result = api
        .runtime
        .store
        .runtime(
            &principal,
            RuntimeOperation::Ack {
                action_id: request.action_id,
                turn_id: request.turn_id,
                generation: request.generation,
                connection,
                channel: request.channel,
                content_digest: request.content_digest,
            },
        )
        .await?;
    if !matches!(result, RuntimeResult::Acknowledged(_)) {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    }
    Ok(Json(json!({"acknowledged":true})))
}
async fn input(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let request: Input = body(request).await?;
    if request.text.trim().is_empty() || request.text.len() > 4000 {
        return Err(invalid());
    }
    let connection = proof(&headers, request.surface_id, request.incarnation)?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(25),
        api.runtime
            .browser_text(&principal, connection, request.text),
    )
    .await
    .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?
    .map_err(|error| match error.code() {
        tonic::Code::InvalidArgument => invalid(),
        tonic::Code::Unauthenticated => ApiError(StatusCode::UNAUTHORIZED, "unauthorized"),
        tonic::Code::PermissionDenied => ApiError(StatusCode::FORBIDDEN, "invalid_connection"),
        tonic::Code::ResourceExhausted => ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"),
        tonic::Code::FailedPrecondition => ApiError(StatusCode::CONFLICT, "stale_action"),
        _ => ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    })?;
    if !matches!(result, RuntimeResult::Proposed(_) | RuntimeResult::Blocked) {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    }
    Ok(Json(json!({"accepted":true})))
}
