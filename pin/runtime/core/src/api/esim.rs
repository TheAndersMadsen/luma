//! eSIM, cellular, and Wi-Fi administration endpoints.
//!
//! Bounded, authenticated bridge routes that submit eSIM LPA operations and
//! cellular / Wi-Fi toggles to the Android server app and surface their
//! results. Relocated verbatim from `api.rs`; routes, timeouts, and error
//! mapping are unchanged.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::ApiState;
use crate::esim::{
    CellularStatusError, DeviceToggleError, EsimRequestError, EsimRequestRecord, EsimSnapshot,
};

const ESIM_GETTER_TIMEOUT: Duration = Duration::from_secs(20);
const CELLULAR_STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const NETWORK_TOGGLE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn router() -> Router<ApiState> {
    Router::new()
        .route("/esim/state", get(get_esim_state))
        .route("/esim/events", get(esim_event_stream))
        .route("/esim/requests/{request_id}", get(get_esim_request))
        .route("/esim/get-profiles", put(esim_get_profiles))
        .route("/esim/get-active-profile", put(esim_get_active_profile))
        .route("/esim/get-active-iccid", put(esim_get_active_iccid))
        .route("/esim/get-eid", put(esim_get_eid))
        .route("/esim/enable-profile", put(esim_enable_profile))
        .route("/esim/disable-profile", put(esim_disable_profile))
        .route("/esim/set-nickname", put(esim_set_nickname))
        .route("/esim/delete-profile", put(esim_delete_profile))
        .route(
            "/esim/download-verify-enable",
            put(esim_download_verify_enable),
        )
        .route("/cellular/service-status", get(get_cellular_service_status))
        .route("/cellular/set-enabled", put(set_cellular_enabled))
        .route("/wifi/set-enabled", put(set_wifi_enabled))
}

#[derive(Deserialize)]
struct EsimIccidRequest {
    iccid: String,
}

#[derive(Deserialize)]
struct EsimNicknameRequest {
    iccid: String,
    nickname: String,
}

#[derive(Deserialize)]
struct EsimActivationCodeRequest {
    activation_code: String,
}

#[derive(Serialize)]
struct EsimRequestAcceptedResponse {
    request_id: String,
}

#[derive(Deserialize)]
struct SetEnabledRequest {
    enabled: bool,
}

async fn get_esim_state(State(state): State<ApiState>) -> Json<EsimSnapshot> {
    Json(state.esim_bridge.snapshot().await)
}

async fn get_cellular_service_status(State(state): State<ApiState>) -> Response {
    match state
        .esim_bridge
        .get_cellular_status(CELLULAR_STATUS_TIMEOUT)
        .await
    {
        Ok(event) => Json(event).into_response(),
        Err(error) => {
            warn!(
                error_kind = cellular_status_error_kind(&error),
                "failed to fetch cellular service status"
            );
            cellular_status_error_response(error)
        }
    }
}

async fn set_cellular_enabled(
    State(state): State<ApiState>,
    Json(body): Json<SetEnabledRequest>,
) -> Response {
    match state
        .esim_bridge
        .set_cellular_enabled(body.enabled, NETWORK_TOGGLE_TIMEOUT)
        .await
    {
        Ok(event) => Json(event).into_response(),
        Err(error) => {
            warn!(
                error_kind = device_toggle_error_kind(&error),
                enabled = body.enabled,
                "failed to toggle cellular data"
            );
            device_toggle_error_response(error)
        }
    }
}

async fn set_wifi_enabled(
    State(state): State<ApiState>,
    Json(body): Json<SetEnabledRequest>,
) -> Response {
    match state
        .esim_bridge
        .set_wifi_enabled(body.enabled, NETWORK_TOGGLE_TIMEOUT)
        .await
    {
        Ok(event) => Json(event).into_response(),
        Err(error) => {
            warn!(
                error_kind = device_toggle_error_kind(&error),
                enabled = body.enabled,
                "failed to toggle Wi-Fi"
            );
            device_toggle_error_response(error)
        }
    }
}

async fn get_esim_request(
    Path(request_id): Path<String>,
    State(state): State<ApiState>,
) -> Result<Json<EsimRequestRecord>, StatusCode> {
    state
        .esim_bridge
        .get_request(&request_id)
        .await
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn esim_get_profiles(State(state): State<ApiState>) -> Response {
    submit_esim_request_and_wait(
        &state,
        "humane.connectivity.esimlpa.getProfiles",
        serde_json::json!({}),
        &["esim.profiles_result"],
    )
    .await
}

async fn esim_get_active_profile(State(state): State<ApiState>) -> Response {
    submit_esim_request_and_wait(
        &state,
        "humane.connectivity.esimlpa.getActiveProfile",
        serde_json::json!({}),
        &["esim.active_profile_result"],
    )
    .await
}

async fn esim_get_active_iccid(State(state): State<ApiState>) -> Response {
    submit_esim_request_and_wait(
        &state,
        "humane.connectivity.esimlpa.getActiveprofileICCID",
        serde_json::json!({}),
        &["esim.active_iccid_result"],
    )
    .await
}

async fn esim_get_eid(State(state): State<ApiState>) -> Response {
    submit_esim_request_and_wait(
        &state,
        "humane.connectivity.esimlpa.getEID",
        serde_json::json!({}),
        &["esim.device_identifiers_result"],
    )
    .await
}

async fn esim_enable_profile(
    State(state): State<ApiState>,
    Json(body): Json<EsimIccidRequest>,
) -> Result<Json<EsimRequestAcceptedResponse>, StatusCode> {
    submit_esim_request(
        &state,
        "humane.connectivity.esimlpa.enableProfile",
        serde_json::json!({ "iccid": body.iccid }),
    )
    .await
}

async fn esim_disable_profile(
    State(state): State<ApiState>,
    Json(body): Json<EsimIccidRequest>,
) -> Result<Json<EsimRequestAcceptedResponse>, StatusCode> {
    submit_esim_request(
        &state,
        "humane.connectivity.esimlpa.disableProfile",
        serde_json::json!({ "iccid": body.iccid }),
    )
    .await
}

async fn esim_set_nickname(
    State(state): State<ApiState>,
    Json(body): Json<EsimNicknameRequest>,
) -> Result<Json<EsimRequestAcceptedResponse>, StatusCode> {
    submit_esim_request(
        &state,
        "humane.connectivity.esimlpa.setNickname",
        serde_json::json!({ "iccid": body.iccid, "nickname": body.nickname }),
    )
    .await
}

async fn esim_delete_profile(
    State(state): State<ApiState>,
    Json(body): Json<EsimIccidRequest>,
) -> Result<Json<EsimRequestAcceptedResponse>, StatusCode> {
    submit_esim_request(
        &state,
        "humane.connectivity.esimlpa.deleteProfile",
        serde_json::json!({ "iccid": body.iccid }),
    )
    .await
}

async fn esim_download_verify_enable(
    State(state): State<ApiState>,
    Json(body): Json<EsimActivationCodeRequest>,
) -> Result<Json<EsimRequestAcceptedResponse>, StatusCode> {
    submit_esim_request(
        &state,
        "humane.connectivity.esimlpa.downloadVerifyAndEnableProfile",
        serde_json::json!({ "activationCode": body.activation_code }),
    )
    .await
}

async fn submit_esim_request(
    state: &ApiState,
    action: &str,
    payload: serde_json::Value,
) -> Result<Json<EsimRequestAcceptedResponse>, StatusCode> {
    match state
        .esim_bridge
        .submit_request(action.to_string(), payload)
        .await
    {
        Ok(request_id) => Ok(Json(EsimRequestAcceptedResponse { request_id })),
        Err(_) => {
            warn!(action, "failed to submit eSIM request");
            Err(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

async fn submit_esim_request_and_wait(
    state: &ApiState,
    action: &str,
    payload: serde_json::Value,
    terminal_types: &[&str],
) -> Response {
    match state
        .esim_bridge
        .submit_request_and_wait(
            action.to_string(),
            payload,
            terminal_types,
            ESIM_GETTER_TIMEOUT,
        )
        .await
    {
        Ok(event) => Json(event).into_response(),
        Err(error) => {
            warn!(
                error_kind = esim_request_error_kind(&error),
                action, "failed to complete synchronous eSIM request"
            );
            esim_request_error_response(error)
        }
    }
}

fn esim_request_error_kind(error: &EsimRequestError) -> &'static str {
    match error {
        EsimRequestError::BridgeError { .. } => "bridge",
        EsimRequestError::Timeout { .. } => "timeout",
        EsimRequestError::Internal { .. } => "internal",
    }
}

fn cellular_status_error_kind(error: &CellularStatusError) -> &'static str {
    match error {
        CellularStatusError::BridgeError(_) => "bridge",
        CellularStatusError::Timeout { .. } => "timeout",
        CellularStatusError::Internal(_) => "internal",
    }
}

fn device_toggle_error_kind(error: &DeviceToggleError) -> &'static str {
    match error {
        DeviceToggleError::BridgeError(_) => "bridge",
        DeviceToggleError::Timeout { .. } => "timeout",
        DeviceToggleError::Internal(_) => "internal",
    }
}

fn esim_request_error_response(error: EsimRequestError) -> Response {
    match error {
        EsimRequestError::BridgeError { event, .. } => {
            (StatusCode::BAD_GATEWAY, Json(event)).into_response()
        }
        EsimRequestError::Timeout { request_id } => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "type": "esim.request_timeout",
                "request_id": request_id,
                "payload": {
                    "message": "timed out waiting for terminal event"
                }
            })),
        )
            .into_response(),
        EsimRequestError::Internal {
            request_id,
            message,
        } => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "type": "esim.bridge_error",
                "request_id": request_id,
                "payload": {
                    "message": message
                }
            })),
        )
            .into_response(),
    }
}

fn cellular_status_error_response(error: CellularStatusError) -> Response {
    match error {
        CellularStatusError::BridgeError(event) => {
            (StatusCode::BAD_GATEWAY, Json(event)).into_response()
        }
        CellularStatusError::Timeout { request_id } => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "type": "cellular.status_timeout",
                "request_id": request_id,
                "payload": {
                    "message": "timed out waiting for cellular status"
                }
            })),
        )
            .into_response(),
        CellularStatusError::Internal(message) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "type": "cellular.status_error",
                "payload": {
                    "message": message
                }
            })),
        )
            .into_response(),
    }
}

fn device_toggle_error_response(error: DeviceToggleError) -> Response {
    match error {
        DeviceToggleError::BridgeError(event) => {
            (StatusCode::BAD_GATEWAY, Json(event)).into_response()
        }
        DeviceToggleError::Timeout { request_id } => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "type": "device.toggle_timeout",
                "request_id": request_id,
                "payload": {
                    "message": "timed out waiting for toggle result"
                }
            })),
        )
            .into_response(),
        DeviceToggleError::Internal(message) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "type": "device.toggle_error",
                "payload": {
                    "message": message
                }
            })),
        )
            .into_response(),
    }
}

async fn esim_event_stream(State(state): State<ApiState>) -> Response {
    let mut rx = state.esim_bridge.subscribe();
    super::build_ndjson_stream_response(async_stream::stream! {
        yield Ok::<_, std::convert::Infallible>(
            format!("{}\n", serde_json::json!({"type":"esim.heartbeat"}))
        );

        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
        heartbeat.tick().await;

        loop {
            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(event) => {
                            let line = format!("{}\n", serde_json::to_string(&event).unwrap());
                            yield Ok(line);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(missed = n, "eSIM event stream client lagged");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    yield Ok(
                        format!("{}\n", serde_json::json!({"type":"esim.heartbeat"}))
                    );
                }
            }
        }
    })
}
