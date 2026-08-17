//! The device-local HTTP upload plane: media uploads from the stock camera
//! pipeline and one-shot AIBus upload tickets. Moved out of `main.rs` so the
//! composition root only wires it; behavior, statuses, and bounds are
//! unchanged.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::StreamExt as _;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::services::aibus::{UploadFileHandler, UploadTicketError};
use crate::storage::{
    MediaStore, MediaStoreError, MAX_AIBUS_CONTENT_TYPE_BYTES, MAX_AIBUS_LOGICAL_NAME_BYTES,
    MAX_HTTP_UPLOAD_BYTES,
};

// ─── HTTP upload handler ────────────────────────────────────────────

/// Shared state passed to the axum upload handler.
#[derive(Clone)]
pub(crate) struct UploadState {
    pub(crate) store: Arc<Mutex<MediaStore>>,
    pub(crate) aibus_upload: UploadFileHandler,
}

type UploadValidationError = (StatusCode, &'static str);

fn validate_upload_content_length(headers: &HeaderMap) -> Result<(), UploadValidationError> {
    let Some(content_length) = headers.get(header::CONTENT_LENGTH) else {
        return Ok(());
    };
    let Ok(content_length) = content_length.to_str() else {
        return Err((StatusCode::BAD_REQUEST, "invalid content length"));
    };
    let Ok(content_length) = content_length.parse::<u64>() else {
        return Err((StatusCode::BAD_REQUEST, "invalid content length"));
    };
    if content_length > MAX_HTTP_UPLOAD_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "upload is too large"));
    }
    Ok(())
}

/// PUT /upload/:uuid/:filename — receives media file bytes from the device.
pub(crate) async fn upload_handler(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((uuid, filename)): Path<(String, String)>,
    State(state): State<UploadState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // Stock capture clients receive a loopback URL. Never expose this
    // unauthenticated ingestion surface to dashboard peers on the LAN.
    if !is_device_local_upload_peer(&peer) {
        warn!("rejected non-loopback media upload");
        return (StatusCode::FORBIDDEN, "upload is device-local").into_response();
    }

    if let Err(error) = validate_upload_content_length(&headers) {
        return error.into_response();
    }

    let mut upload = {
        let store = state.store.lock().await;
        match store.begin_upload(&uuid, &filename).await {
            Ok(upload) => upload,
            Err(error) => return media_upload_error_response(error),
        }
    };

    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                upload.abort().await;
                warn!("media upload body failed");
                return (StatusCode::BAD_REQUEST, "invalid upload body").into_response();
            }
        };
        if let Err(error) = upload.write_chunk(&chunk).await {
            upload.abort().await;
            return media_upload_error_response(error);
        }
    }

    match upload.commit().await {
        Ok(bytes) => {
            info!(bytes, "media upload committed");
            (StatusCode::CREATED, "OK").into_response()
        }
        Err(error) => media_upload_error_response(error),
    }
}

/// PUT /aibus-upload/:ticket — the raw second stage of stock UploadFile.
pub(crate) async fn aibus_upload_handler(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(ticket): Path<String>,
    State(state): State<UploadState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !is_device_local_upload_peer(&peer) {
        warn!("rejected non-loopback AIBus upload");
        return (StatusCode::FORBIDDEN, "upload is device-local").into_response();
    }
    if let Err(error) = validate_upload_content_length(&headers) {
        return error.into_response();
    }

    let logical_name = match bounded_upload_header(
        &headers,
        HeaderName::from_static("file"),
        MAX_AIBUS_LOGICAL_NAME_BYTES,
        true,
    ) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let content_type = match bounded_upload_header(
        &headers,
        header::CONTENT_TYPE,
        MAX_AIBUS_CONTENT_TYPE_BYTES,
        false,
    ) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };

    let mut upload = match state
        .aibus_upload
        .begin_upload(&ticket, logical_name, content_type)
        .await
    {
        Ok(upload) => upload,
        Err(error) => return aibus_upload_error_response(error),
    };

    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                upload.abort().await;
                warn!("AIBus upload body failed");
                return (StatusCode::BAD_REQUEST, "invalid upload body").into_response();
            }
        };
        if let Err(error) = upload.write_chunk(&chunk).await {
            upload.abort().await;
            return media_upload_error_response(error);
        }
    }

    match upload.commit().await {
        Ok(bytes) => {
            info!(bytes, "AIBus upload committed");
            aibus_upload_success_response()
        }
        Err(error) => media_upload_error_response(error),
    }
}

pub(crate) fn bounded_upload_header(
    headers: &HeaderMap,
    name: HeaderName,
    maximum_bytes: usize,
    required: bool,
) -> Result<String, UploadValidationError> {
    let Some(value) = headers.get(&name) else {
        return if required {
            Err((StatusCode::BAD_REQUEST, "missing upload metadata"))
        } else {
            Ok("application/octet-stream".to_string())
        };
    };
    let value = std::str::from_utf8(value.as_bytes())
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid upload metadata"))?;
    if value.trim().is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control)
    {
        return Err((StatusCode::BAD_REQUEST, "invalid upload metadata"));
    }
    Ok(value.to_string())
}

pub(crate) fn aibus_upload_error_response(error: UploadTicketError) -> Response {
    match error {
        UploadTicketError::InvalidTicket | UploadTicketError::InvalidMetadata => {
            (StatusCode::BAD_REQUEST, "invalid upload ticket or metadata").into_response()
        }
        UploadTicketError::NotFound => {
            (StatusCode::NOT_FOUND, "upload ticket not found").into_response()
        }
        UploadTicketError::AlreadyClaimed => {
            (StatusCode::CONFLICT, "upload ticket is already in use").into_response()
        }
        UploadTicketError::Expired => (StatusCode::GONE, "upload ticket expired").into_response(),
        UploadTicketError::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "upload storage unavailable",
        )
            .into_response(),
        UploadTicketError::Storage(error) => media_upload_error_response(error),
    }
}

pub(crate) fn aibus_upload_success_response() -> Response {
    let mut response = (StatusCode::CREATED, "OK").into_response();
    // Stock WebClient compares MediaType.toString() to this exact value. Axum's
    // default string response adds a charset, which would prevent source cleanup.
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    response
}

pub(crate) fn is_device_local_upload_peer(peer: &SocketAddr) -> bool {
    peer.ip().is_loopback()
}

pub(crate) fn media_upload_error_response(error: MediaStoreError) -> Response {
    let (status, message) = match error {
        MediaStoreError::InvalidMemoryId | MediaStoreError::InvalidFilename => {
            (StatusCode::BAD_REQUEST, "invalid upload path")
        }
        MediaStoreError::MemoryNotFound | MediaStoreError::UnexpectedFilename => {
            (StatusCode::NOT_FOUND, "upload target not found")
        }
        MediaStoreError::UploadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "upload is too large"),
        MediaStoreError::Io(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            (StatusCode::CONFLICT, "upload conflicts with existing media")
        }
        MediaStoreError::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock => (
            StatusCode::TOO_MANY_REQUESTS,
            "upload capacity is exhausted",
        ),
        MediaStoreError::Io(_) | MediaStoreError::Database => {
            tracing::error!("media upload storage failure");
            (StatusCode::INTERNAL_SERVER_ERROR, "upload storage failed")
        }
    };
    (status, message).into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        aibus_upload_handler, aibus_upload_success_response, bounded_upload_header,
        is_device_local_upload_peer, media_upload_error_response, UploadState,
    };
    use crate::db::Database;
    use crate::proto::aibus::{upload_file_request::UploadUseCase, UploadFileRequest};
    use crate::services::aibus::UploadFileHandler;
    use crate::storage::{
        AibusUploadMetadata, AibusUploadStore, MediaStore, MediaStoreError,
        MAX_AIBUS_LOGICAL_NAME_BYTES, MAX_HTTP_UPLOAD_BYTES,
    };
    use axum::body::Body;
    use axum::extract::{ConnectInfo, Path, State};
    use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
    use http_body_util::BodyExt as _;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tonic::Request;

    #[test]
    fn media_upload_peer_must_be_loopback() {
        let v4_loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1);
        let v6_loopback = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 1);
        let wildcard = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 1);

        assert!(is_device_local_upload_peer(&v4_loopback));
        assert!(is_device_local_upload_peer(&v6_loopback));
        assert!(!is_device_local_upload_peer(&wildcard));
    }

    #[test]
    fn media_upload_admission_errors_have_distinct_http_statuses() {
        let conflict = media_upload_error_response(MediaStoreError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target is active",
        )));
        assert_eq!(conflict.status(), StatusCode::CONFLICT);

        let capacity = media_upload_error_response(MediaStoreError::Io(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "capacity is exhausted",
        )));
        assert_eq!(capacity.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn aibus_upload_success_is_exact_stock_text_response() {
        let response = aibus_upload_success_response();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "OK"
        );
    }

    #[test]
    fn aibus_file_header_is_bounded_but_never_treated_as_a_path() {
        let name = HeaderName::from_static("file");
        let mut headers = HeaderMap::new();
        headers.insert(
            name.clone(),
            HeaderValue::from_static("../../outside/debug/session.json"),
        );
        assert_eq!(
            bounded_upload_header(&headers, name.clone(), MAX_AIBUS_LOGICAL_NAME_BYTES, true)
                .unwrap(),
            "../../outside/debug/session.json"
        );

        headers.insert(
            name.clone(),
            HeaderValue::from_str(&"x".repeat(MAX_AIBUS_LOGICAL_NAME_BYTES + 1)).unwrap(),
        );
        assert!(bounded_upload_header(&headers, name, MAX_AIBUS_LOGICAL_NAME_BYTES, true).is_err());
    }

    #[tokio::test]
    async fn aibus_raw_put_is_loopback_only_bounded_and_one_use() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("media.sqlite")).unwrap();
        let media_store = Arc::new(Mutex::new(
            MediaStore::open(directory.path().join("media"), database)
                .await
                .unwrap(),
        ));
        let aibus_root = directory.path().join("aibus");
        let aibus_store = Arc::new(AibusUploadStore::open(&aibus_root).await.unwrap());
        let handler = UploadFileHandler::new(8080, aibus_store);
        let issued = handler
            .upload_file(Request::new(UploadFileRequest {
                use_case: UploadUseCase::IntentDebugging as i32,
            }))
            .await
            .unwrap()
            .into_inner();
        let ticket = issued.url.rsplit('/').next().unwrap().to_string();
        let state = UploadState {
            store: media_store,
            aibus_upload: handler,
        };
        let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1);
        let remote = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 1);
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("file"),
            HeaderValue::from_static("../../outside/debug/session.json"),
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        let forbidden = aibus_upload_handler(
            ConnectInfo(remote),
            Path(ticket.clone()),
            State(state.clone()),
            headers.clone(),
            Body::from("training-data"),
        )
        .await;
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        let mut oversized_headers = headers.clone();
        oversized_headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&(MAX_HTTP_UPLOAD_BYTES + 1).to_string()).unwrap(),
        );
        let oversized = aibus_upload_handler(
            ConnectInfo(loopback),
            Path(ticket.clone()),
            State(state.clone()),
            oversized_headers,
            Body::empty(),
        )
        .await;
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let accepted = aibus_upload_handler(
            ConnectInfo(loopback),
            Path(ticket.clone()),
            State(state.clone()),
            headers.clone(),
            Body::from("training-data"),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::CREATED);
        assert_eq!(
            accepted.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        assert_eq!(
            std::fs::read(aibus_root.join(&ticket).join("data")).unwrap(),
            b"training-data"
        );
        let metadata: AibusUploadMetadata = serde_json::from_slice(
            &std::fs::read(aibus_root.join(&ticket).join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata.logical_name, "../../outside/debug/session.json");
        assert!(!directory.path().join("outside").exists());

        let replay = aibus_upload_handler(
            ConnectInfo(loopback),
            Path(ticket),
            State(state),
            headers,
            Body::from("replacement"),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::CONFLICT);
    }
}
