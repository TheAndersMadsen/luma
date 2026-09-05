//! Installation challenge and connection bootstrap. The Store verifies key
//! possession and commits authority; request headers supply neither owner nor audience.
#[cfg(test)]
#[path = "native_runtime_api_tests.rs"]
mod tests;

use crate::{
    ambiance::{RuntimeError, RuntimeOperation, RuntimeResult, native_connection},
    store::SharedStore,
    surface_registry::RegistryError,
};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;
use uuid::Uuid;

const MAX_INFLIGHT: usize = 16;
const MAX_BODY_BYTES: usize = 2048;

#[derive(Clone)]
struct ApiState {
    store: SharedStore,
    audience: Option<String>,
    inflight: Arc<Semaphore>,
}

pub fn router(store: SharedStore) -> Router {
    with_audience(store, std::env::var("REVIVAL_PUBLIC_ORIGIN").ok())
}

pub(crate) fn with_audience(store: SharedStore, audience: Option<String>) -> Router {
    Router::new()
        .route("/runtime-api/v1/native/challenge", post(challenge))
        .route("/runtime-api/v1/native/open", post(open))
        .layer(axum::middleware::map_response(response_headers))
        .with_state(ApiState {
            store,
            audience: audience.and_then(|value| native_connection::canonical_audience(&value).ok()),
            inflight: Arc::new(Semaphore::new(MAX_INFLIGHT)),
        })
}

async fn response_headers(mut response: Response) -> Response {
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
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

fn invalid() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "invalid_request")
}

fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
}

impl From<RuntimeError> for ApiError {
    fn from(error: RuntimeError) -> Self {
        match error {
            RuntimeError::InvalidRequest => invalid(),
            RuntimeError::InvalidOrigin | RuntimeError::NotFound | RuntimeError::PolicyBlocked => {
                Self(StatusCode::NOT_FOUND, "not_found")
            }
            RuntimeError::Stale => Self(StatusCode::CONFLICT, "stale_connection"),
            RuntimeError::Busy => Self(StatusCode::TOO_MANY_REQUESTS, "busy"),
            RuntimeError::Unavailable => unavailable(),
        }
    }
}

impl From<RegistryError> for ApiError {
    fn from(error: RegistryError) -> Self {
        match error {
            RegistryError::NotFound | RegistryError::InvalidConnection => {
                Self(StatusCode::NOT_FOUND, "not_found")
            }
            RegistryError::SequenceConflict => Self(StatusCode::CONFLICT, "stale_connection"),
            RegistryError::SurfaceLimit => Self(StatusCode::TOO_MANY_REQUESTS, "busy"),
            RegistryError::Unavailable => unavailable(),
        }
    }
}

async fn body<T: serde::de::DeserializeOwned>(request: Request) -> Result<T, ApiError> {
    if request.headers().get_all("content-type").iter().count() != 1
        || request
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            != Some("application/json")
    {
        return Err(invalid());
    }
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        axum::body::to_bytes(request.into_body(), MAX_BODY_BYTES),
    )
    .await
    .map_err(|_| invalid())?
    .map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChallengeRequest {
    enrollment_id: Uuid,
}

async fn challenge(State(api): State<ApiState>, request: Request) -> Result<Json<Value>, ApiError> {
    let audience = api.audience.as_ref().ok_or_else(unavailable)?.clone();
    let _permit = api
        .inflight
        .try_acquire()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"))?;
    let request: ChallengeRequest = body(request).await?;
    if request.enrollment_id.is_nil() {
        return Err(invalid());
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let location = api
            .store
            .native_location(request.enrollment_id)
            .await?
            .ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
        let mut nonce = [0u8; 32];
        rand::rngs::OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| unavailable())?;
        let result = api
            .store
            .runtime(
                &location.principal,
                RuntimeOperation::NativeChallenge {
                    surface_id: location.surface_id,
                    enrollment_id: request.enrollment_id,
                    audience,
                    challenge_id: Uuid::new_v4(),
                    nonce: URL_SAFE_NO_PAD.encode(nonce),
                },
            )
            .await?;
        let RuntimeResult::NativeChallenge(challenge) = result else {
            return Err(unavailable());
        };
        Ok(Json(json!({"challenge": challenge})))
    })
    .await
    .map_err(|_| unavailable())?
}

async fn open(State(api): State<ApiState>, request: Request) -> Result<Json<Value>, ApiError> {
    let audience = api.audience.as_ref().ok_or_else(unavailable)?.clone();
    let _permit = api
        .inflight
        .try_acquire()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"))?;
    let request: native_connection::OpenRequest = body(request).await?;
    if request.enrollment_id.is_nil() {
        return Err(invalid());
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let location = api
            .store
            .native_location(request.enrollment_id)
            .await?
            .ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
        let result = api
            .store
            .runtime(
                &location.principal,
                RuntimeOperation::OpenNative {
                    surface_id: location.surface_id,
                    audience,
                    request,
                    incarnation: Uuid::new_v4(),
                },
            )
            .await?;
        let RuntimeResult::NativeOpened {
            connection,
            duplicate,
        } = result
        else {
            return Err(unavailable());
        };
        Ok(Json(
            json!({"connection": connection, "duplicate": duplicate}),
        ))
    })
    .await
    .map_err(|_| unavailable())?
}
