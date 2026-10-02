//! Authenticated REST surface for bounded, app-private fitness history.
//!
//! The parent API router must nest this router below `/api/fitness`, inside the
//! existing admin-auth middleware. Only manifest metadata and the final stock
//! summary row are returned as JSON. Raw allowlisted files require an explicit
//! download request.

use async_stream::stream;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use bytes::Bytes;
use serde::Serialize;
use tokio::io::AsyncReadExt;

use crate::fitness::{FitnessStore, FitnessStoreError};

const DOWNLOAD_CHUNK_BYTES: usize = 64 * 1024;

pub fn router(store: FitnessStore) -> Router {
    Router::new()
        .route("/sessions", get(list_sessions).delete(clear_sessions))
        .route(
            "/sessions/{session_id}",
            get(get_session).delete(delete_session),
        )
        .route(
            "/sessions/{session_id}/files/{filename}",
            get(download_file),
        )
        .with_state(store)
}

#[derive(Debug, Serialize)]
struct FitnessSessionsResponse {
    sessions: Vec<crate::fitness::FitnessSession>,
}

async fn list_sessions(State(store): State<FitnessStore>) -> Response {
    match tokio::task::spawn_blocking(move || store.list_sessions()).await {
        Ok(Ok(sessions)) => Json(FitnessSessionsResponse { sessions }).into_response(),
        Ok(Err(error)) => error_response(error),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn get_session(
    Path(session_id): Path<String>,
    State(store): State<FitnessStore>,
) -> Response {
    match tokio::task::spawn_blocking(move || store.get_session(&session_id)).await {
        Ok(Ok(Some(session))) => Json(session).into_response(),
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => error_response(error),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn download_file(
    Path((session_id, filename)): Path<(String, String)>,
    State(store): State<FitnessStore>,
) -> Response {
    let file = match tokio::task::spawn_blocking(move || store.file(&session_id, &filename)).await {
        Ok(Ok(Some(file))) => file,
        Ok(Ok(None)) => return StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => return error_response(error),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    // FitnessStore already opened this with O_NOFOLLOW and verified its size;
    // converting the handle avoids a validate-path-then-reopen race.
    let input = tokio::fs::File::from_std(file.file);
    let stream = stream! {
        let mut input = input;
        let mut buffer = vec![0_u8; DOWNLOAD_CHUNK_BYTES];
        loop {
            match input.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => {
                    yield Result::<Bytes, std::io::Error>::Ok(Bytes::copy_from_slice(&buffer[..count]));
                }
                Err(error) => {
                    yield Result::<Bytes, std::io::Error>::Err(error);
                    break;
                }
            }
        }
    };
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(file.content_type),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&file.size_bytes.to_string())
            .expect("validated fitness file length is an HTTP header value"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{}\"", file.filename))
            .expect("allowlisted fitness filename is an HTTP header value"),
    );
    response
}

async fn delete_session(
    Path(session_id): Path<String>,
    State(store): State<FitnessStore>,
) -> Response {
    match tokio::task::spawn_blocking(move || store.delete_session(&session_id)).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => error_response(error),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn clear_sessions(State(store): State<FitnessStore>) -> Response {
    match tokio::task::spawn_blocking(move || store.clear()).await {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => error_response(error),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/*
 * Keep the conversion in one place so malformed client identifiers remain a
 * 400 while corruption of the app-private store is never exposed verbatim.
 */
fn error_response(error: FitnessStoreError) -> Response {
    match error {
        FitnessStoreError::InvalidSessionId | FitnessStoreError::InvalidFilename => {
            StatusCode::BAD_REQUEST.into_response()
        }
        FitnessStoreError::InvalidManifest
        | FitnessStoreError::InvalidStoredPath
        | FitnessStoreError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
