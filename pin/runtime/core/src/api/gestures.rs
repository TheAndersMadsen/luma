//! INFERRED: Luma device-local gestures. Android's shared SDK owns the schema,
//! catalog and storage; this authenticated HTTP surface only transports them.
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};

use super::ApiState;

pub(super) fn router() -> Router<ApiState> {
    Router::new()
        .route("/api/gestures", get(read).put(update))
        .route("/api/gestures/observation", get(observation))
        .route(
            "/api/gestures/clip",
            get(clip).put(stage_clip).delete(cancel_clip),
        )
        .route("/api/gestures/clip/result", axum::routing::put(clip_result))
        .layer(DefaultBodyLimit::max(64 * 1024))
}

async fn read() -> Response {
    request("gestures_get", None).await
}

async fn observation() -> Response {
    request("gestures_observation", None).await
}

async fn update(body: Result<Json<Value>, JsonRejection>) -> Response {
    match body {
        Ok(Json(body)) => request("gestures_put", Some(body)).await,
        Err(error) => (error.status(), Json(json!({"error": "invalid_request"}))).into_response(),
    }
}

async fn request(op: &str, update: Option<Value>) -> Response {
    let response = super::feature_flags::gesture_bridge_command(op, update).await;
    match response {
        Ok(value)
            if value.get("version") == Some(&json!(1)) && value.get("ok") == Some(&json!(true)) =>
        {
            match value.get("value").filter(|value| value.is_object()) {
                Some(value) => Json(value.clone()).into_response(),
                None => failure(StatusCode::BAD_GATEWAY, "invalid_bridge_response"),
            }
        }
        Ok(value) => match value.get("error").and_then(Value::as_str) {
            Some("invalid_request") => failure(StatusCode::BAD_REQUEST, "invalid_request"),
            Some("conflict") => failure(StatusCode::CONFLICT, "conflict"),
            _ => failure(StatusCode::SERVICE_UNAVAILABLE, "device_unavailable"),
        },
        Err(()) => failure(StatusCode::SERVICE_UNAVAILABLE, "device_unavailable"),
    }
}

async fn clip() -> Response {
    // INFERRED: pace the browser's read loop at the device. A hidden Center tab
    // must not depend on background JavaScript timers to observe a native press.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    request("clip_get", None).await
}
async fn stage_clip(body: Result<Json<Value>, JsonRejection>) -> Response {
    clip_write("clip_stage", body).await
}
async fn cancel_clip(body: Result<Json<Value>, JsonRejection>) -> Response {
    clip_write("clip_cancel", body).await
}
async fn clip_result(body: Result<Json<Value>, JsonRejection>) -> Response {
    clip_write("clip_result", body).await
}
async fn clip_write(op: &str, body: Result<Json<Value>, JsonRejection>) -> Response {
    match body {
        Ok(Json(body)) => request(op, Some(body)).await,
        Err(error) => failure(error.status(), "invalid_request"),
    }
}

fn failure(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}
