//! Installation challenge, connection and shared-room bootstrap. The Store verifies key
//! possession and commits authority; request headers supply neither owner nor audience.
#[cfg(test)]
#[path = "native_runtime_api_tests.rs"]
mod tests;

use crate::{
    ambiance::{
        NativeProof, RoomProof, RuntimeError, RuntimeOperation, RuntimeResult, native_connection,
    },
    store::SharedStore,
    surface_registry::RegistryError,
};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
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
    rooms: Arc<crate::browser_rooms::Rooms>,
    audience: Option<String>,
    inflight: Arc<Semaphore>,
}

pub(crate) fn router(store: SharedStore, rooms: Arc<crate::browser_rooms::Rooms>) -> Router {
    with_audience(store, std::env::var("REVIVAL_PUBLIC_ORIGIN").ok(), rooms)
}

pub(crate) fn with_audience(
    store: SharedStore,
    audience: Option<String>,
    rooms: Arc<crate::browser_rooms::Rooms>,
) -> Router {
    Router::new()
        .route("/runtime-api/v1/native/challenge", post(challenge))
        .route("/runtime-api/v1/native/open", post(open))
        .route("/runtime-api/v1/native/room", post(room))
        .layer(axum::middleware::map_response(response_headers))
        .with_state(ApiState {
            store,
            rooms,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoomRequest {
    enrollment_id: Uuid,
    approval_revision: u64,
    incarnation: Uuid,
    epoch: Uuid,
}

fn session_hash(headers: &HeaderMap) -> Result<String, ApiError> {
    let denied = || ApiError(StatusCode::NOT_FOUND, "not_found");
    if headers.get_all("authorization").iter().count() != 1 {
        return Err(denied());
    }
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(crate::web_auth::bearer_token)
        .filter(|value| value.len() == 43)
        .ok_or_else(denied)?;
    let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| denied())?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != token {
        return Err(denied());
    }
    // Open signs the digest of decoded secret bytes. Neither the stored digest
    // nor a hash of its base64 spelling can authenticate a room connection.
    Ok(crate::surface_registry::hash(&bytes))
}

async fn room(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<crate::browser_rooms::Connection>, ApiError> {
    api.audience.as_ref().ok_or_else(unavailable)?;
    let _permit = api
        .inflight
        .try_acquire()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"))?;
    let token_hash = session_hash(&headers)?;
    let request: RoomRequest = body(request).await?;
    if request.enrollment_id.is_nil()
        || request.incarnation.is_nil()
        || request.epoch.is_nil()
        || request.approval_revision == 0
        || request.approval_revision > crate::surface_registry::MAX_NATIVE_REVISION
    {
        return Err(invalid());
    }
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let location = api
            .store
            .native_location(request.enrollment_id)
            .await?
            .ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
        let proof = NativeProof {
            surface_id: location.surface_id,
            incarnation: request.incarnation,
            token_hash,
        };
        let RuntimeResult::NativeCurrent(current) = api
            .store
            .runtime(
                &location.principal,
                RuntimeOperation::CheckNative {
                    connection: proof.clone(),
                },
            )
            .await?
        else {
            return Err(unavailable());
        };
        if current.approval_revision != request.approval_revision || current.epoch != request.epoch
        {
            return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
        }
        let connection = api
            .rooms
            .open(&location.principal, RoomProof::Native(proof), request.epoch)
            .await
            .map_err(|error| match error {
                cosmos_rtc::Error::Invalid => invalid(),
                cosmos_rtc::Error::Denied => ApiError(StatusCode::NOT_FOUND, "not_found"),
                cosmos_rtc::Error::Busy => ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"),
                cosmos_rtc::Error::Unavailable => unavailable(),
            })?;
        Ok(Json(connection))
    })
    .await
    .map_err(|_| unavailable())?
}
