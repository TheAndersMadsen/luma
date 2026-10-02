//! The device-local HTTP upload plane: media uploads from the stock camera
//! pipeline. Moved out of `main.rs` so the composition root only wires it.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::StreamExt as _;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::storage::{MediaStore, MediaStoreError, MAX_HTTP_UPLOAD_BYTES};

// ─── HTTP upload handler ────────────────────────────────────────────

/// Shared state passed to the axum upload handler.
#[derive(Clone)]
pub(crate) struct UploadState {
    pub(crate) store: Arc<Mutex<MediaStore>>,
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

/// PUT /upload/:uuid/:filename, receives media file bytes from the device.
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
    use super::is_device_local_upload_peer;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    #[test]
    fn media_upload_peer_must_be_loopback() {
        let v4_loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1);
        let v6_loopback = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 1);
        let wildcard = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 1);

        assert!(is_device_local_upload_peer(&v4_loopback));
        assert!(is_device_local_upload_peer(&v6_loopback));
        assert!(!is_device_local_upload_peer(&wildcard));
    }
}
