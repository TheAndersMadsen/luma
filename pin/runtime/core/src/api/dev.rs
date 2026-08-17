use std::process::Stdio;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::multipart::Field;
use axum::extract::{DefaultBodyLimit, Multipart, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::api::feature_flags::current_stock_cache_delivery_verified;
use crate::api::ApiState;
use crate::esim::DeviceActionError;
use crate::feature_flags::effective_bool;
use crate::tier_a::feature_flags::cloud as cloud_keys;

const SYSTEM_INJECTOR_STAGING_URI: &str = "content://com.penumbraos.systeminjector.staging";
const STOCK_ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_STOCK_MESSAGE_CHARS: usize = 480;
const MAX_STOCK_MUSIC_TEXT_CHARS: usize = 200;
const MAX_STOCK_MESSAGE_STATUS_LOOKBACK_MS: u64 = 10 * 60 * 1_000;
const MAX_STOCK_MESSAGE_STATUS_FUTURE_SKEW_MS: u64 = 5_000;

pub fn router() -> Router<ApiState> {
    Router::new()
        .route("/install", post(install_apks))
        .route("/stock-action-test", post(stock_action_test))
        .route("/stock-message-status", post(stock_message_status))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StockActionName {
    ComposeMessage,
    ConfirmMessage,
    CancelMessage,
    CallPerson,
    EndCall,
    ClassifyEmergency,
    CapturePhoto,
    CaptureVideo,
    StopVideo,
    PlayMusic,
    Tickle,
}

impl StockActionName {
    fn as_str(self) -> &'static str {
        match self {
            Self::ComposeMessage => "compose_message",
            Self::ConfirmMessage => "confirm_message",
            Self::CancelMessage => "cancel_message",
            Self::CallPerson => "call_person",
            Self::EndCall => "end_call",
            Self::ClassifyEmergency => "classify_emergency",
            Self::CapturePhoto => "capture_photo",
            Self::CaptureVideo => "capture_video",
            Self::StopVideo => "stop_video",
            Self::PlayMusic => "play_music",
            Self::Tickle => "tickle",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StockActionTestRequest {
    action: StockActionName,
    recipient: Option<String>,
    message: Option<String>,
    track: Option<String>,
    artist: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StockMessageStatusRequest {
    recipient: String,
    message: String,
    after_ms: u64,
}

async fn stock_action_test(
    State(state): State<ApiState>,
    Json(request): Json<StockActionTestRequest>,
) -> Response {
    if let Err(response) = check_stock_action_permission(&state, request.action).await {
        return response;
    }

    let payload = match stock_action_payload(&request) {
        Ok(payload) => payload,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    match state
        .esim_bridge
        .dispatch_stock_action(request.action.as_str(), payload, STOCK_ACTION_TIMEOUT)
        .await
    {
        Ok(event) => Json(sanitized_bridge_payload(event)).into_response(),
        Err(error) => stock_action_error_response(error),
    }
}

async fn stock_message_status(
    State(state): State<ApiState>,
    Json(request): Json<StockMessageStatusRequest>,
) -> Response {
    if let Err(response) = check_dev_apk_install_permission(&state).await {
        return response;
    }
    if let Err(message) = validate_stock_message(&request.recipient, &request.message) {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    let now_ms = match unix_time_ms() {
        Ok(now_ms) => now_ms,
        Err(message) => {
            tracing::error!(%message, "system clock unavailable for message status check");
            return (StatusCode::SERVICE_UNAVAILABLE, "system clock unavailable").into_response();
        }
    };
    if let Err(message) = validate_stock_message_status_window(request.after_ms, now_ms) {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }

    match state
        .esim_bridge
        .get_stock_message_status(
            &request.recipient,
            &request.message,
            request.after_ms,
            STOCK_ACTION_TIMEOUT,
        )
        .await
    {
        Ok(event) => Json(sanitized_bridge_payload(event)).into_response(),
        Err(error) => stock_action_error_response(error),
    }
}

fn stock_action_payload(request: &StockActionTestRequest) -> Result<Value, &'static str> {
    match request.action {
        StockActionName::ComposeMessage => {
            if request.track.is_some() || request.artist.is_some() {
                return Err("music fields are not valid for compose_message");
            }
            let recipient = request
                .recipient
                .as_deref()
                .ok_or("recipient is required")?;
            let message = request.message.as_deref().ok_or("message is required")?;
            validate_stock_message(recipient, message)?;
            Ok(serde_json::json!({
                "recipient": recipient,
                "message": message,
            }))
        }
        StockActionName::CallPerson => {
            let recipient = request
                .recipient
                .as_deref()
                .ok_or("recipient is required")?;
            validate_stock_recipient(recipient)?;
            if request.message.is_some() || request.track.is_some() || request.artist.is_some() {
                return Err("extra fields are not valid for call_person");
            }
            Ok(serde_json::json!({ "recipient": recipient }))
        }
        StockActionName::ClassifyEmergency => {
            let number = request
                .recipient
                .as_deref()
                .ok_or("recipient is required")?;
            if request.message.is_some()
                || request.track.is_some()
                || request.artist.is_some()
                || !(2..=8).contains(&number.len())
                || !number.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err("emergency dry-run input must contain 2 to 8 digits");
            }
            Ok(serde_json::json!({ "number": number }))
        }
        StockActionName::PlayMusic => {
            if request.recipient.is_some() || request.message.is_some() {
                return Err("recipient and message are not valid for play_music");
            }
            let track = request.track.as_deref().ok_or("track is required")?;
            validate_stock_music_text(track, "track")?;
            if let Some(artist) = request.artist.as_deref() {
                validate_stock_music_text(artist, "artist")?;
                Ok(serde_json::json!({ "track": track, "artist": artist }))
            } else {
                Ok(serde_json::json!({ "track": track }))
            }
        }
        _ if request.recipient.is_some()
            || request.message.is_some()
            || request.track.is_some()
            || request.artist.is_some() =>
        {
            Err("request fields are not valid for this action")
        }
        _ => Ok(serde_json::json!({})),
    }
}

fn validate_stock_message(recipient: &str, message: &str) -> Result<(), &'static str> {
    validate_stock_recipient(recipient)?;
    if message.trim().is_empty() {
        return Err("message must not be blank");
    }
    // Android/Kotlin's String.length is measured in UTF-16 code units. Match
    // that boundary exactly so an astral scalar cannot pass Rust validation
    // and then be rejected by the on-device bridge.
    if message.encode_utf16().count() > MAX_STOCK_MESSAGE_CHARS {
        return Err("message exceeds 480 characters");
    }
    Ok(())
}

fn validate_stock_music_text(value: &str, field: &str) -> Result<(), &'static str> {
    if value.trim().is_empty() {
        return Err(if field == "artist" {
            "artist must not be blank"
        } else {
            "track must not be blank"
        });
    }
    if value.encode_utf16().count() > MAX_STOCK_MUSIC_TEXT_CHARS {
        return Err(if field == "artist" {
            "artist exceeds 200 characters"
        } else {
            "track exceeds 200 characters"
        });
    }
    if value.chars().any(char::is_control) {
        return Err(if field == "artist" {
            "artist contains control characters"
        } else {
            "track contains control characters"
        });
    }
    Ok(())
}

fn validate_stock_message_status_window(after_ms: u64, now_ms: u64) -> Result<(), &'static str> {
    if after_ms == 0 {
        return Err("after_ms must be a positive Unix timestamp in milliseconds");
    }
    if after_ms > now_ms.saturating_add(MAX_STOCK_MESSAGE_STATUS_FUTURE_SKEW_MS) {
        return Err("after_ms is too far in the future");
    }
    if now_ms.saturating_sub(after_ms) > MAX_STOCK_MESSAGE_STATUS_LOOKBACK_MS {
        return Err("after_ms is older than the allowed status window");
    }
    Ok(())
}

fn unix_time_ms() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock error: {error}"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| "system clock is outside the supported range".to_string())
}

fn validate_stock_recipient(recipient: &str) -> Result<(), &'static str> {
    let bytes = recipient.as_bytes();
    if !(9..=16).contains(&bytes.len())
        || bytes.first() != Some(&b'+')
        || !matches!(bytes.get(1), Some(b'1'..=b'9'))
        || !bytes[2..].iter().all(u8::is_ascii_digit)
    {
        return Err("recipient must be an E.164 phone number");
    }
    Ok(())
}

fn sanitized_bridge_payload(event: Value) -> Value {
    let mut payload = event
        .get("payload")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    let dispatch_accepted = payload
        .as_object_mut()
        .and_then(|object| object.remove("accepted"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    payload["dispatch_accepted"] = Value::Bool(dispatch_accepted);
    payload
}

fn stock_action_error_response(error: DeviceActionError) -> Response {
    let (status, kind) = match error {
        DeviceActionError::BridgeError(_) => (StatusCode::BAD_GATEWAY, "bridge"),
        DeviceActionError::Timeout { .. } => (StatusCode::GATEWAY_TIMEOUT, "timeout"),
        DeviceActionError::Internal(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    };
    tracing::warn!(error_kind = kind, "stock device action failed");
    (
        status,
        Json(serde_json::json!({
            "error": "stock device action failed",
            "kind": kind,
        })),
    )
        .into_response()
}

async fn install_apks(State(state): State<ApiState>, mut multipart: Multipart) -> Response {
    if let Err(response) = check_dev_apk_install_permission(&state).await {
        return response;
    }

    let mut staged_apks = Vec::new();
    let mut index = 0usize;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("failed to read multipart body: {e}"),
                )
                    .into_response();
            }
        };

        if field.name() != Some("apk") {
            continue;
        }

        let filename = match staging_filename(index, field.file_name()) {
            Ok(filename) => filename,
            Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
        };
        index += 1;

        let bytes = match stream_apk_to_staging(&filename, field).await {
            Ok(bytes) => bytes,
            Err(response) => return response,
        };
        staged_apks.push(serde_json::json!({
            "filename": filename,
            "bytes": bytes,
        }));
    }

    if staged_apks.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "multipart body must contain at least one 'apk' file part",
        )
            .into_response();
    }

    let staged_filenames = staged_apks
        .iter()
        .filter_map(|apk| apk.get("filename").and_then(|filename| filename.as_str()))
        .collect::<Vec<_>>();
    let install_arg = staged_filenames.join(",");
    let output = match execute_content_install(&install_arg).await {
        Ok(output) => output,
        Err(response) => return response,
    };

    if !output.contains("OK") {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "system-injector install failed",
                "output": output,
            })),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "accepted": true,
        "restart_expected": true,
        "apks": staged_apks,
    }))
    .into_response()
}

async fn stream_apk_to_staging(filename: &str, mut field: Field<'_>) -> Result<usize, Response> {
    let uri = format!("{SYSTEM_INJECTOR_STAGING_URI}/{filename}");
    let mut child = Command::new("/system/bin/content")
        .args(["write", "--uri", &uri])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            tracing::error!(error = %e, "failed to spawn content write");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to spawn content write: {e}"),
            )
                .into_response()
        })?;

    let mut stdin = child.stdin.take().ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "content write stdin unavailable",
        )
            .into_response()
    })?;

    let mut bytes_written: usize = 0;
    while let Some(chunk) = field.chunk().await.map_err(|e| {
        let _ = child.start_kill();
        (
            StatusCode::BAD_REQUEST,
            format!("failed to read APK part: {e}"),
        )
            .into_response()
    })? {
        bytes_written += chunk.len();
        if let Err(e) = stdin.write_all(&chunk).await {
            let _ = child.start_kill();
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to stream APK to content provider: {e}"),
            )
                .into_response());
        }
    }
    drop(stdin);

    let output = child.wait_with_output().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed waiting for content write: {e}"),
        )
            .into_response()
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!(status = ?output.status, %stderr, "content write failed");
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "content write failed",
                "filename": filename,
                "stderr": stderr.trim(),
            })),
        )
            .into_response());
    }

    Ok(bytes_written)
}

async fn execute_content_install(install_arg: &str) -> Result<String, Response> {
    let output = Command::new("/system/bin/content")
        .args([
            "call",
            "--uri",
            SYSTEM_INJECTOR_STAGING_URI,
            "--method",
            "install",
            "--arg",
            install_arg,
        ])
        .output()
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to spawn content call: {e}"),
            )
                .into_response()
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "content call failed",
                "stdout": stdout,
                "stderr": stderr,
            })),
        )
            .into_response());
    }

    Ok(if stderr.is_empty() {
        stdout
    } else {
        format!("{stdout}\n{stderr}")
    })
}

fn staging_filename(index: usize, original_filename: Option<&str>) -> Result<String, String> {
    let source = original_filename.unwrap_or("app.apk");
    let basename = source
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("app.apk");

    let sanitized = basename
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') {
                b as char
            } else {
                '_'
            }
        })
        .collect::<String>();
    let safe_name = if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "app.apk".to_owned()
    } else {
        sanitized
    };
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock error: {e}"))?
        .as_millis();
    let filename = format!("{timestamp_ms}-{index}-{safe_name}");
    validate_apk_filename(&filename)?;
    Ok(filename)
}

fn validate_apk_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("filename must not be empty".into());
    }

    if filename.contains('/') || filename.contains("..") {
        return Err("filename must not contain '/' or '..'".into());
    }

    if !filename
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err("filename contains unsupported characters".into());
    }

    Ok(())
}

async fn check_dev_apk_install_permission(state: &ApiState) -> Result<(), Response> {
    let config = state.shared_config.read().await;

    if config.dev.apk_install_enabled {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "dev APK install is disabled",
            })),
        )
            .into_response())
    }
}

/// Keep the prototype Tickle launch independently testable without opening the
/// much broader APK-install/call/message diagnostic gate. The normal admin API
/// authentication still applies, and the exact live feature flag must be on.
/// Every other stock-action diagnostic retains the existing dev gate.
async fn check_stock_action_permission(
    state: &ApiState,
    action: StockActionName,
) -> Result<(), Response> {
    if !stock_action_uses_tickle_gate(action) {
        return check_dev_apk_install_permission(state).await;
    }

    let config = {
        let config = state.shared_config.read().await;
        config.clone()
    };
    if !effective_bool(&config.feature_flags, cloud_keys::TICKLE).unwrap_or(false) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "tickle feature flag is disabled",
            })),
        )
            .into_response());
    }

    match current_stock_cache_delivery_verified(&config, &state.feature_flag_delivery).await {
        Ok(true) => Ok(()),
        Ok(false) => Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "tickle stock cache is not verified; reload feature flags and retry",
            })),
        )
            .into_response()),
        Err(()) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "tickle stock cache verification is unavailable",
            })),
        )
            .into_response()),
    }
}

fn stock_action_uses_tickle_gate(action: StockActionName) -> bool {
    matches!(action, StockActionName::Tickle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stock_sms_validation_requires_e164_and_a_bounded_body() {
        assert!(validate_stock_message("+4542493591", "PenumbraOS stock SMS test").is_ok());
        assert!(validate_stock_message("42493591", "test").is_err());
        assert!(validate_stock_message("+05", "test").is_err());
        assert!(validate_stock_message("+45;reboot", "test").is_err());
        assert!(validate_stock_message("+4542493591", "  ").is_err());
        assert!(validate_stock_message("+4542493591", &"x".repeat(481)).is_err());
        assert!(validate_stock_message("+4542493591", &"😀".repeat(240)).is_ok());
        assert!(validate_stock_message("+4542493591", &"😀".repeat(241)).is_err());
    }

    #[test]
    fn message_status_requires_a_recent_correlation_boundary() {
        let now = 1_800_000_000_000_u64;
        assert!(validate_stock_message_status_window(now, now).is_ok());
        assert!(validate_stock_message_status_window(now - 10 * 60 * 1_000, now).is_ok());
        assert!(validate_stock_message_status_window(now + 5_000, now).is_ok());
        assert!(validate_stock_message_status_window(0, now).is_err());
        assert!(validate_stock_message_status_window(now - 10 * 60 * 1_000 - 1, now).is_err());
        assert!(validate_stock_message_status_window(now + 5_001, now).is_err());
    }

    #[test]
    fn only_compose_accepts_recipient_or_message_fields() {
        let compose = StockActionTestRequest {
            action: StockActionName::ComposeMessage,
            recipient: Some("+4542493591".into()),
            message: Some("test".into()),
            track: None,
            artist: None,
        };
        assert_eq!(
            stock_action_payload(&compose).unwrap()["recipient"],
            "+4542493591"
        );

        let confirm_with_data = StockActionTestRequest {
            action: StockActionName::ConfirmMessage,
            recipient: Some("+4542493591".into()),
            message: None,
            track: None,
            artist: None,
        };
        assert!(stock_action_payload(&confirm_with_data).is_err());

        let confirm = StockActionTestRequest {
            action: StockActionName::ConfirmMessage,
            recipient: None,
            message: None,
            track: None,
            artist: None,
        };
        assert_eq!(
            stock_action_payload(&confirm).unwrap(),
            serde_json::json!({})
        );

        let call = StockActionTestRequest {
            action: StockActionName::CallPerson,
            recipient: Some("+4542493591".into()),
            message: None,
            track: None,
            artist: None,
        };
        assert_eq!(
            stock_action_payload(&call).unwrap(),
            serde_json::json!({ "recipient": "+4542493591" })
        );
        let call_with_message = StockActionTestRequest {
            action: StockActionName::CallPerson,
            recipient: Some("+4542493591".into()),
            message: Some("not valid".into()),
            track: None,
            artist: None,
        };
        assert!(stock_action_payload(&call_with_message).is_err());

        let emergency_dry_run = StockActionTestRequest {
            action: StockActionName::ClassifyEmergency,
            recipient: Some("112".into()),
            message: None,
            track: None,
            artist: None,
        };
        assert_eq!(
            stock_action_payload(&emergency_dry_run).unwrap(),
            serde_json::json!({ "number": "112" })
        );

        let play = StockActionTestRequest {
            action: StockActionName::PlayMusic,
            recipient: None,
            message: None,
            track: Some("Laugh Now Cry Later".into()),
            artist: Some("Drake".into()),
        };
        assert_eq!(
            stock_action_payload(&play).unwrap(),
            serde_json::json!({ "track": "Laugh Now Cry Later", "artist": "Drake" })
        );

        let tickle = StockActionTestRequest {
            action: StockActionName::Tickle,
            recipient: None,
            message: None,
            track: None,
            artist: None,
        };
        assert_eq!(
            stock_action_payload(&tickle).unwrap(),
            serde_json::json!({})
        );

        for request in [
            StockActionTestRequest {
                action: StockActionName::Tickle,
                recipient: Some("+4542493591".into()),
                message: None,
                track: None,
                artist: None,
            },
            StockActionTestRequest {
                action: StockActionName::Tickle,
                recipient: None,
                message: Some("not valid".into()),
                track: None,
                artist: None,
            },
            StockActionTestRequest {
                action: StockActionName::Tickle,
                recipient: None,
                message: None,
                track: Some("not valid".into()),
                artist: None,
            },
            StockActionTestRequest {
                action: StockActionName::Tickle,
                recipient: None,
                message: None,
                track: None,
                artist: Some("not valid".into()),
            },
        ] {
            assert!(stock_action_payload(&request).is_err());
        }
    }

    #[test]
    fn only_tickle_uses_the_narrow_feature_flag_diagnostic_gate() {
        for action in [
            StockActionName::ComposeMessage,
            StockActionName::ConfirmMessage,
            StockActionName::CancelMessage,
            StockActionName::CallPerson,
            StockActionName::EndCall,
            StockActionName::ClassifyEmergency,
            StockActionName::CapturePhoto,
            StockActionName::CaptureVideo,
            StockActionName::StopVideo,
            StockActionName::PlayMusic,
        ] {
            assert!(!stock_action_uses_tickle_gate(action));
        }
        assert!(stock_action_uses_tickle_gate(StockActionName::Tickle));
    }

    #[test]
    fn stock_music_diagnostic_rejects_unbounded_or_non_catalog_fields() {
        assert!(validate_stock_music_text("Laugh Now Cry Later", "track").is_ok());
        assert!(validate_stock_music_text("Drake", "artist").is_ok());
        assert!(validate_stock_music_text("   ", "track").is_err());
        assert!(validate_stock_music_text(&"x".repeat(201), "track").is_err());
        assert!(validate_stock_music_text("song\0title", "track").is_err());

        let missing_track = StockActionTestRequest {
            action: StockActionName::PlayMusic,
            recipient: None,
            message: None,
            track: None,
            artist: Some("Drake".into()),
        };
        assert!(stock_action_payload(&missing_track).is_err());

        let leaked_recipient = StockActionTestRequest {
            action: StockActionName::PlayMusic,
            recipient: Some("+4542493591".into()),
            message: None,
            track: Some("Laugh Now Cry Later".into()),
            artist: None,
        };
        assert!(stock_action_payload(&leaked_recipient).is_err());
    }

    #[test]
    fn bridge_responses_drop_request_envelope_and_inputs() {
        let event = serde_json::json!({
            "type": "device.stock_action_result",
            "request_id": "internal",
            "payload": {
                "accepted": true,
                "action": "compose_message",
                "action_id": "public-safe-id"
            }
        });
        let payload = sanitized_bridge_payload(event);
        assert_eq!(payload["dispatch_accepted"], true);
        assert!(payload.get("accepted").is_none());
        assert!(payload.get("request_id").is_none());
        assert!(payload.get("recipient").is_none());
        assert!(payload.get("message").is_none());
    }
}
