//! Thin authenticated browser adapter. The Store owns all delivery authority.
#[cfg(all(test, unix))]
#[path = "browser_center_acceptance.rs"]
mod center_acceptance;
#[cfg(test)]
#[path = "browser_runtime_api_tests.rs"]
mod tests;
use crate::{
    ambiance::{
        Action, BrowserProof, Channel, RoomProof, RuntimeError, SemanticIntent,
        runtime::AmbianceRuntime, visual::Card,
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
    rooms: Arc<crate::browser_rooms::Rooms>,
}
pub(crate) fn router(
    runtime: Arc<AmbianceRuntime>,
    rooms: Arc<crate::browser_rooms::Rooms>,
) -> Router {
    with_rooms(runtime, crate::web_auth::configured_verifier(), rooms)
}
fn with_rooms(
    runtime: Arc<AmbianceRuntime>,
    verifier: Option<Arc<JwtVerifier>>,
    rooms: Arc<crate::browser_rooms::Rooms>,
) -> Router {
    Router::new()
        .route("/runtime-api/v1/browser/status", get(status))
        .route("/runtime-api/v1/browser/room", post(room))
        .layer(axum::middleware::map_response(no_store))
        .with_state(ApiState {
            runtime,
            verifier,
            rooms,
        })
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
struct OpenRoom {
    surface_id: Uuid,
    incarnation: Uuid,
    epoch: Uuid,
}
async fn room(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<crate::browser_rooms::Connection>, ApiError> {
    let principal = owner(&headers, &api)?;
    let request: OpenRoom = body(request).await?;
    let connection = proof(&headers, request.surface_id, request.incarnation)?;
    let opened = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        api.rooms
            .open(&principal, RoomProof::Browser(connection), request.epoch),
    )
    .await
    .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?
    .map_err(|error| match error {
        cosmos_rtc::Error::Invalid => invalid(),
        cosmos_rtc::Error::Denied => ApiError(StatusCode::FORBIDDEN, "invalid_connection"),
        cosmos_rtc::Error::Busy => ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"),
        cosmos_rtc::Error::Unavailable => ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    })?;
    Ok(Json(opened))
}
/// Serialization only. The room dispatcher must first obtain current delivery
/// authority and resolve any transient content for that exact action.
pub(crate) fn command(action: &Action, card: Option<&Card>) -> Option<Value> {
    if action.channel != Channel::VisualCard
        || !action.intent.valid()
        || action.content_digest != action.intent.content_digest()
    {
        return None;
    }
    let content = match &action.intent {
        SemanticIntent::VisualTextCard { text } => json!({"kind":"text","text":text}),
        SemanticIntent::ChoiceList { title, items } => {
            json!({"kind":"choices","title":title,"items":items})
        }
        SemanticIntent::PlaceAddressCard { content } => {
            let card = card?;
            if card.digest() != content.digest
                || action.display_expires_at_ms != content.expires_at_ms
            {
                return None;
            }
            card.value()
        }
        SemanticIntent::InformationalSpeech { .. } | SemanticIntent::DeviceAction { .. } => {
            return None;
        }
    };
    Some(
        json!({"version":1,"actionId":action.id,"turnId":action.turn_id,"generation":action.generation,"surfaceId":action.surface_id,"incarnation":action.incarnation,"channel":"visual.card","contentDigest":action.content_digest,"content":content,"expiresAt":action.display_expires_at_ms,"privacy":action.privacy}),
    )
}
/// Serialization only, in the exact style of a render command. The device
/// receives the bound command, the key it deduplicates on, and how long it
/// has to say what happened; it never receives a reason, a fallback or the
/// candidate the runtime resolved.
pub(crate) fn act_command(action: &Action) -> Option<Value> {
    if !action.channel.is_action()
        || !action.intent.valid()
        || action.content_digest != action.intent.content_digest()
    {
        return None;
    }
    let SemanticIntent::DeviceAction { operation } = &action.intent else {
        return None;
    };
    // Derived from the committed claim, never from a wall clock: the device
    // has the acknowledgment window plus the channel's own report budget,
    // and never more than the action's own life.
    let report_by = action
        .dispatched_at_ms
        .saturating_add(crate::ambiance::ACK_MS)
        .saturating_add(operation.report_budget_ms())
        .min(action.display_expires_at_ms);
    Some(json!({
        "version": 1,
        "actionId": action.id,
        "turnId": action.turn_id,
        "generation": action.generation,
        "surfaceId": action.surface_id,
        "incarnation": action.incarnation,
        "channel": action.channel.as_str(),
        "contentDigest": action.content_digest,
        "idempotencyKey": crate::ambiance::action::idempotency_key(
            action.surface_id,
            action.incarnation,
            action.id,
        ),
        "operation": operation,
        "expiresAt": action.display_expires_at_ms,
        "reportBy": report_by,
        "privacy": action.privacy,
    }))
}

async fn status(State(api): State<ApiState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    api.runtime
        .store
        .surfaces(&principal)
        .await
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?;
    let config = crate::integrations::active().snapshot();
    Ok(Json(readiness_view(&config)))
}
fn readiness_view(config: &crate::integrations::IntegrationsConfig) -> Value {
    json!({"version":1,"textInputConfigured":config.realtime.configured(),"approvedSurfaceRequired":true})
}
