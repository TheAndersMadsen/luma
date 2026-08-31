use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::device::{get_global_setting, getprop, DeviceVersionCollector};
use super::{write_private_atomic, ApiState};

pub(super) const MAX_REQUEST_BYTES: usize = 2 * 1024;
const MAX_RECORD_BYTES: u64 = 2 * 1024;
const RECORD_FILE: &str = "setup-acceptance-v1.json";
const REMOTE_MODE_SETTING: &str = "penumbra_cosmos_remote_mode";
const EDGE_IPV4_SETTING: &str = "penumbra_cosmos_edge_ipv4";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct PhysicalChecks {
    microphone: bool,
    speaker: bool,
    gesture: bool,
}

impl PhysicalChecks {
    fn complete(&self) -> bool {
        self.microphone && self.speaker && self.gesture
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct ConfirmAcceptanceRequest {
    schema_version: u8,
    device_serial: String,
    release_id: String,
    release_version: String,
    edge_ipv4: String,
    checks: PhysicalChecks,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct AcceptanceRecord {
    schema_version: u8,
    device_serial: String,
    release_id: String,
    release_version: String,
    edge_ipv4: String,
    confirmed_at_epoch_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct CurrentIdentity {
    device_serial: String,
    release_version: String,
    edge_ipv4: String,
}

#[derive(Serialize)]
pub(super) struct AcceptanceResponse {
    schema_version: u8,
    current: CurrentIdentity,
    confirmation: Option<AcceptanceRecord>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

#[derive(Debug)]
pub(super) enum AcceptanceError {
    Invalid,
    IdentityChanged,
    IdentityUnavailable,
    Persistence,
}

impl IntoResponse for AcceptanceError {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid_acceptance"),
            Self::IdentityChanged => (StatusCode::CONFLICT, "pin_identity_changed"),
            Self::IdentityUnavailable => {
                (StatusCode::SERVICE_UNAVAILABLE, "pin_identity_unavailable")
            }
            Self::Persistence => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "acceptance_persistence_failed",
            ),
        };
        (status, Json(ErrorBody { error })).into_response()
    }
}

pub(super) async fn get_acceptance(
    State(state): State<ApiState>,
) -> Result<Json<AcceptanceResponse>, AcceptanceError> {
    let current = current_identity().await?;
    let record = read_record(&record_path(&state.config_path))?;
    Ok(Json(response(current, record)))
}

pub(super) async fn confirm_acceptance(
    State(state): State<ApiState>,
    Json(request): Json<ConfirmAcceptanceRequest>,
) -> Result<Json<AcceptanceResponse>, AcceptanceError> {
    validate_request(&request)?;
    let current = current_identity().await?;
    if request.device_serial != current.device_serial
        || request.release_version != current.release_version
        || request.edge_ipv4 != current.edge_ipv4
    {
        return Err(AcceptanceError::IdentityChanged);
    }

    let record = AcceptanceRecord {
        schema_version: 1,
        device_serial: current.device_serial.clone(),
        release_id: request.release_id,
        release_version: current.release_version.clone(),
        edge_ipv4: current.edge_ipv4.clone(),
        confirmed_at_epoch_ms: now_epoch_ms().ok_or(AcceptanceError::Persistence)?,
    };
    let path = record_path(&state.config_path);
    persist_record(&path, &record)?;
    let persisted = read_record(&path)?.filter(|value| value == &record);
    if persisted.is_none() {
        return Err(AcceptanceError::Persistence);
    }
    Ok(Json(response(current, persisted)))
}

async fn current_identity() -> Result<CurrentIdentity, AcceptanceError> {
    let serial = canonical_serial(
        &getprop("ro.serialno")
            .await
            .ok_or(AcceptanceError::IdentityUnavailable)?,
    )
    .ok_or(AcceptanceError::IdentityUnavailable)?;
    let versions = DeviceVersionCollector::collect().await;
    let release_version = versions
        .exact_runtime_release()
        .map(str::to_owned)
        .ok_or(AcceptanceError::IdentityUnavailable)?;
    if get_global_setting(REMOTE_MODE_SETTING).await.as_deref() != Some("1") {
        return Err(AcceptanceError::IdentityUnavailable);
    }
    let edge_ipv4 = canonical_ipv4(
        &get_global_setting(EDGE_IPV4_SETTING)
            .await
            .ok_or(AcceptanceError::IdentityUnavailable)?,
    )
    .ok_or(AcceptanceError::IdentityUnavailable)?;

    Ok(CurrentIdentity {
        device_serial: serial,
        release_version,
        edge_ipv4,
    })
}

fn response(current: CurrentIdentity, record: Option<AcceptanceRecord>) -> AcceptanceResponse {
    let confirmation = record.filter(|record| {
        record.device_serial == current.device_serial
            && record.release_version == current.release_version
            && record.edge_ipv4 == current.edge_ipv4
    });
    AcceptanceResponse {
        schema_version: 1,
        current,
        confirmation,
    }
}

fn validate_request(request: &ConfirmAcceptanceRequest) -> Result<(), AcceptanceError> {
    if request.schema_version != 1
        || canonical_serial(&request.device_serial).as_deref() != Some(&request.device_serial)
        || !valid_release_id(&request.release_id)
        || !valid_release_version(&request.release_version)
        || canonical_ipv4(&request.edge_ipv4).as_deref() != Some(&request.edge_ipv4)
        || !request.checks.complete()
    {
        return Err(AcceptanceError::Invalid);
    }
    Ok(())
}

fn canonical_serial(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_uppercase();
    (value.len() <= 128
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then_some(value)
}

fn valid_release_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_release_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn canonical_ipv4(value: &str) -> Option<String> {
    value
        .trim()
        .parse::<Ipv4Addr>()
        .ok()
        .map(|value| value.to_string())
}

fn record_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(RECORD_FILE)
}

fn read_record(path: &Path) -> Result<Option<AcceptanceRecord>, AcceptanceError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(AcceptanceError::Persistence),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RECORD_BYTES
    {
        return Err(AcceptanceError::Persistence);
    }
    let bytes = std::fs::read(path).map_err(|_| AcceptanceError::Persistence)?;
    let record: AcceptanceRecord =
        serde_json::from_slice(&bytes).map_err(|_| AcceptanceError::Persistence)?;
    validate_record(&record)?;
    Ok(Some(record))
}

fn persist_record(path: &Path, record: &AcceptanceRecord) -> Result<(), AcceptanceError> {
    let contents = serde_json::to_string(record).map_err(|_| AcceptanceError::Persistence)?;
    if contents.len() as u64 > MAX_RECORD_BYTES {
        return Err(AcceptanceError::Persistence);
    }
    if path.exists()
        && std::fs::symlink_metadata(path)
            .map_err(|_| AcceptanceError::Persistence)?
            .file_type()
            .is_symlink()
    {
        return Err(AcceptanceError::Persistence);
    }
    write_private_atomic(path, &contents).map_err(|_| AcceptanceError::Persistence)
}

fn validate_record(record: &AcceptanceRecord) -> Result<(), AcceptanceError> {
    let request = ConfirmAcceptanceRequest {
        schema_version: record.schema_version,
        device_serial: record.device_serial.clone(),
        release_id: record.release_id.clone(),
        release_version: record.release_version.clone(),
        edge_ipv4: record.edge_ipv4.clone(),
        checks: PhysicalChecks {
            microphone: true,
            speaker: true,
            gesture: true,
        },
    };
    if record.confirmed_at_epoch_ms == 0 {
        return Err(AcceptanceError::Persistence);
    }
    validate_request(&request).map_err(|_| AcceptanceError::Persistence)
}

fn now_epoch_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> CurrentIdentity {
        CurrentIdentity {
            device_serial: "1H4MPA42230112".into(),
            release_version: "2026-08-31.6".into(),
            edge_ipv4: "203.0.113.9".into(),
        }
    }

    fn record() -> AcceptanceRecord {
        AcceptanceRecord {
            schema_version: 1,
            device_serial: "1H4MPA42230112".into(),
            release_id: "a".repeat(64),
            release_version: "2026-08-31.6".into(),
            edge_ipv4: "203.0.113.9".into(),
            confirmed_at_epoch_ms: 1_788_000_000_000,
        }
    }

    #[test]
    fn confirmation_is_visible_only_for_the_current_pin_release_and_edge() {
        assert!(response(identity(), Some(record())).confirmation.is_some());

        let mut changed = identity();
        changed.release_version = "2026-09-01.1".into();
        assert!(response(changed, Some(record())).confirmation.is_none());

        let mut changed = identity();
        changed.device_serial = "OTHER".into();
        assert!(response(changed, Some(record())).confirmation.is_none());

        let mut changed = identity();
        changed.edge_ipv4 = "203.0.113.10".into();
        assert!(response(changed, Some(record())).confirmation.is_none());
    }

    #[test]
    fn persisted_confirmation_round_trips_and_rejects_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(RECORD_FILE);
        persist_record(&path, &record()).unwrap();
        assert_eq!(read_record(&path).unwrap(), Some(record()));

        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(directory.path().join("elsewhere"), &path).unwrap();
            assert!(matches!(
                read_record(&path),
                Err(AcceptanceError::Persistence)
            ));
        }
    }

    #[test]
    fn request_requires_every_physical_check_and_exact_bounded_identity() {
        let valid = ConfirmAcceptanceRequest {
            schema_version: 1,
            device_serial: "1H4MPA42230112".into(),
            release_id: "a".repeat(64),
            release_version: "2026-08-31.6".into(),
            edge_ipv4: "203.0.113.9".into(),
            checks: PhysicalChecks {
                microphone: true,
                speaker: true,
                gesture: true,
            },
        };
        assert!(validate_request(&valid).is_ok());

        let mut invalid = valid.clone();
        invalid.checks.speaker = false;
        assert!(matches!(
            validate_request(&invalid),
            Err(AcceptanceError::Invalid)
        ));
        let mut invalid = valid.clone();
        invalid.release_id = "A".repeat(64);
        assert!(matches!(
            validate_request(&invalid),
            Err(AcceptanceError::Invalid)
        ));
        let mut invalid = valid;
        invalid.device_serial = " pin ".into();
        assert!(matches!(
            validate_request(&invalid),
            Err(AcceptanceError::Invalid)
        ));
    }
}
