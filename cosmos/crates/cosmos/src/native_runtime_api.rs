//! Installation challenge, connection and shared-room bootstrap. The Store verifies key
//! possession and commits authority; request headers supply neither owner nor audience.
#[cfg(test)]
#[path = "native_runtime_api_tests.rs"]
mod tests;

use crate::{
    ambiance::{
        InputStamp, NativeProof, RoomProof, RuntimeError, RuntimeOperation, RuntimeResult,
        native_connection, native_voice, runtime::AmbianceRuntime,
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
/// One press of bounded 16 kHz mono PCM, base64url, plus its small envelope.
const MAX_VOICE_BODY_BYTES: usize = native_voice::MAX_AUDIO_BYTES.div_ceil(3) * 4 + 1024;
/// Recognition of one bounded capture, measured from the admitted request.
const RECOGNITION_MS: u64 = 20_000;

#[derive(Clone)]
struct ApiState {
    store: SharedStore,
    runtime: Arc<AmbianceRuntime>,
    rooms: Arc<crate::browser_rooms::Rooms>,
    audience: Option<String>,
    /// The pinned local recognizer, loaded once on first use. Without a
    /// configured model this stays empty and every spoken request is
    /// unavailable: there is no provider to fall back to, by design.
    recognizer: Arc<tokio::sync::OnceCell<cosmos_stt::LocalRecognizer>>,
    model_path: Option<std::path::PathBuf>,
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
        .route("/runtime-api/v1/native/voice", post(voice))
        .layer(axum::middleware::map_response(response_headers))
        .with_state(ApiState {
            store,
            runtime: rooms.runtime().clone(),
            rooms,
            audience: audience.and_then(|value| native_connection::canonical_audience(&value).ok()),
            recognizer: Arc::new(tokio::sync::OnceCell::new()),
            model_path: std::env::var_os("REVIVAL_STT_MODEL").map(std::path::PathBuf::from),
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
    bounded_body(request, MAX_BODY_BYTES).await
}

async fn bounded_body<T: serde::de::DeserializeOwned>(
    request: Request,
    limit: usize,
) -> Result<T, ApiError> {
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
        axum::body::to_bytes(request.into_body(), limit),
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceAudio {
    encoding: VoiceEncoding,
    sample_rate: u32,
    channels: u8,
    /// Canonical unpadded base64url of the captured PCM. It reaches
    /// `cosmos-stt` inside this process and no provider, and neither these
    /// bytes nor the transcript become durable state.
    data: String,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum VoiceEncoding {
    PcmS16le,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum VoiceLanguage {
    Da,
    En,
}

impl From<VoiceLanguage> for cosmos_stt::Language {
    fn from(language: VoiceLanguage) -> Self {
        match language {
            VoiceLanguage::Da => Self::Danish,
            VoiceLanguage::En => Self::English,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceRequest {
    enrollment_id: Uuid,
    approval_revision: u64,
    incarnation: Uuid,
    epoch: Uuid,
    stamp: InputStamp,
    capture: native_voice::Claim,
    audio: VoiceAudio,
    language: VoiceLanguage,
}

/// The owner's answer, not a routing accident: this installation may not be
/// spoken to. It is deliberately its own status so a client can say what has
/// to happen instead of retrying.
fn not_permitted() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "voice_not_permitted")
}

fn voice_error(error: RuntimeError) -> ApiError {
    match error {
        RuntimeError::PolicyBlocked => not_permitted(),
        other => ApiError::from(other),
    }
}

fn voice_status(status: tonic::Status) -> ApiError {
    match status.code() {
        tonic::Code::InvalidArgument => invalid(),
        tonic::Code::PermissionDenied | tonic::Code::Unauthenticated => not_permitted(),
        tonic::Code::FailedPrecondition | tonic::Code::NotFound => {
            ApiError(StatusCode::CONFLICT, "stale_connection")
        }
        tonic::Code::ResourceExhausted => ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"),
        _ => unavailable(),
    }
}

/// One push-to-talk capture from an approved installation, carried on the
/// connection it already holds.
///
/// Nothing here can start a capture: this route only ever receives audio a
/// person's own press already produced. The order is the point. The owner's
/// permission and the installation's current approval revision are checked
/// before a single sample is read; only then is the audio transcribed, by the
/// pinned local recognizer in this process; and the transcript is admitted as
/// an ordinary sequenced request whose provenance says it was spoken and
/// whose class is the owner's floor joined with the transcript's own terms.
async fn voice(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    api.audience.as_ref().ok_or_else(unavailable)?;
    let runtime = api.runtime.clone();
    let _permit = api
        .inflight
        .try_acquire()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"))?;
    let token_hash = session_hash(&headers)?;
    let request: VoiceRequest = bounded_body(request, MAX_VOICE_BODY_BYTES).await?;
    if request.enrollment_id.is_nil()
        || request.incarnation.is_nil()
        || request.epoch.is_nil()
        || request.stamp.epoch != request.epoch
        || request.stamp.sequence == 0
        || request.stamp.instance_id.is_nil()
        || request.approval_revision == 0
        || request.approval_revision > crate::surface_registry::MAX_NATIVE_REVISION
        || request.audio.encoding != VoiceEncoding::PcmS16le
        || request.audio.sample_rate != native_voice::SAMPLE_RATE
        || request.audio.channels != 1
    {
        return Err(invalid());
    }
    let audio = URL_SAFE_NO_PAD
        .decode(&request.audio.data)
        .ok()
        .filter(|bytes| {
            !bytes.is_empty()
                && bytes.len() % 2 == 0
                && bytes.len() <= native_voice::MAX_AUDIO_BYTES
                && URL_SAFE_NO_PAD.encode(bytes) == request.audio.data
        })
        .ok_or_else(invalid)?;
    let audio_digest = crate::surface_registry::hash(&audio);
    let samples = u32::try_from(audio.len() / 2).map_err(|_| invalid())?;
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
    if current.approval_revision != request.approval_revision || current.epoch != request.epoch {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    }
    // The permission gate, before any audio is read.
    let (policy_revision, source_floor) = runtime
        .native_voice_admission(&location.principal, &proof)
        .await
        .map_err(voice_error)?;
    let capture = native_voice::Capture::new(
        &request.capture,
        samples,
        audio_digest,
        policy_revision,
        source_floor,
    );
    if !capture.valid() {
        return Err(invalid());
    }
    let pcm = cosmos_stt::Pcm16Mono::new(
        audio
            .chunks_exact(2)
            .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0)
            .collect(),
    )
    .map_err(|_| invalid())?;
    // Recognition is local or it does not happen: without the pinned model
    // there is no provider to fall back to, and the refusal is unavailable
    // rather than a request leaving the owner's own infrastructure.
    let model_path = api.model_path.clone().ok_or_else(unavailable)?;
    let recognizer = api
        .recognizer
        .get_or_try_init(|| {
            let path = model_path.clone();
            async move {
                tokio::task::spawn_blocking(move || cosmos_stt::LocalRecognizer::load(&path))
                    .await
                    .map_err(|_| cosmos_stt::Error::ModelLoad)?
            }
        })
        .await
        .map_err(|_| unavailable())?;
    let cancellation = cosmos_stt::Cancellation::default();
    let recognition = recognizer
        .transcribe(
            pcm,
            request.language.into(),
            std::time::Instant::now() + std::time::Duration::from_millis(RECOGNITION_MS),
            cancellation.clone(),
        )
        .await;
    let recognition = match recognition {
        Ok(recognition) => recognition,
        Err(error) => {
            cancellation.cancel();
            return Err(match error {
                cosmos_stt::Error::Busy => ApiError(StatusCode::TOO_MANY_REQUESTS, "busy"),
                _ => unavailable(),
            });
        }
    };
    // No match is not proven silence and never a turn: nothing was begun, so
    // nothing has to be cancelled.
    let cosmos_stt::Recognition::Transcript(transcript) = recognition else {
        return Ok(Json(json!({"admitted": null})));
    };
    // Admission is signalled independently of the model finishing, so the
    // press is answered with the turn it became even when cognition is slow.
    let (started, admission) = tokio::sync::oneshot::channel();
    let result = runtime
        .native_voice_transcript(
            &location.principal,
            proof,
            request.stamp,
            capture,
            transcript,
            Some(started),
        )
        .await
        .map_err(voice_status)?;
    let (fence, duplicate) = match result {
        RuntimeResult::Duplicate(fence) => (fence, true),
        _ => (admission.await.map_err(|_| unavailable())?, false),
    };
    Ok(Json(json!({"admitted": {
        "turnId": fence.turn_id,
        "generation": fence.generation,
        "duplicate": duplicate,
    }})))
}
