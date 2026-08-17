//! Authenticated REST surface for bounded, app-private fitness history.
//!
//! The parent API router must nest this router below `/api/fitness`, inside the
//! existing admin-auth middleware. Only manifest metadata and the final stock
//! summary row are returned as JSON; raw allowlisted files require an explicit
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;
    use uuid::Uuid;

    use crate::fitness::{
        FitnessFileMetadata, LOCATION_FILENAME, SENSOR_FILENAME, SUMMARY_FILENAME,
    };

    fn create_session(root: &std::path::Path, id: &str) -> Vec<u8> {
        let directory = root.join(id);
        std::fs::create_dir(&directory).unwrap();
        let summary = concat!(
            "Splits,Pace (min/km),Elapsed Time,Cumulative Distance (km),Moving Time,Motion Breakdown,Step Count\n",
            "1,PT6M,PT10M,1.25,PT8M,walk,1500\n"
        )
        .as_bytes()
        .to_vec();
        let location = b"<gpx></gpx>".to_vec();
        let sensor = b"ax,ay\n1,2\n".to_vec();
        std::fs::write(directory.join(SUMMARY_FILENAME), &summary).unwrap();
        std::fs::write(directory.join(LOCATION_FILENAME), &location).unwrap();
        std::fs::write(directory.join(SENSOR_FILENAME), &sensor).unwrap();
        let files = [
            FitnessFileMetadata {
                filename: SUMMARY_FILENAME.into(),
                size_bytes: summary.len() as u64,
            },
            FitnessFileMetadata {
                filename: LOCATION_FILENAME.into(),
                size_bytes: location.len() as u64,
            },
            FitnessFileMetadata {
                filename: SENSOR_FILENAME.into(),
                size_bytes: sensor.len() as u64,
            },
        ];
        std::fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "session_id": id,
                "started_at_ms": 1_000,
                "stopped_at_ms": 2_000,
                "files": files,
            }))
            .unwrap(),
        )
        .unwrap();
        sensor
    }

    #[tokio::test]
    async fn list_detail_and_allowlisted_download_contract() {
        let temp = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let sensor = create_session(temp.path(), &id);
        let app = router(FitnessStore::open(temp.path()).unwrap());

        let list = app
            .clone()
            .oneshot(Request::get("/sessions").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::OK);
        let list: Value =
            serde_json::from_slice(&list.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(list["sessions"][0]["session_id"], id);
        assert_eq!(list["sessions"][0]["summary"]["step_count"], 1_500);

        let detail = app
            .clone()
            .oneshot(
                Request::get(format!("/sessions/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(detail.status(), StatusCode::OK);

        let download = app
            .clone()
            .oneshot(
                Request::get(format!("/sessions/{id}/files/{SENSOR_FILENAME}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(download.status(), StatusCode::OK);
        assert_eq!(
            download.headers()[header::CONTENT_TYPE],
            "text/csv; charset=utf-8"
        );
        assert_eq!(
            download.into_body().collect().await.unwrap().to_bytes(),
            sensor
        );

        let rejected = app
            .oneshot(
                Request::get(format!("/sessions/{id}/files/manifest.json"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn delete_one_clear_all_and_invalid_id_contract() {
        let temp = tempfile::tempdir().unwrap();
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        create_session(temp.path(), &first);
        create_session(temp.path(), &second);
        let app = router(FitnessStore::open(temp.path()).unwrap());

        let invalid = app
            .clone()
            .oneshot(
                Request::get("/sessions/not-a-uuid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        let deleted = app
            .clone()
            .oneshot(
                Request::delete(format!("/sessions/{first}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

        let cleared = app
            .clone()
            .oneshot(Request::delete("/sessions").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(cleared.status(), StatusCode::NO_CONTENT);

        let list = app
            .oneshot(Request::get("/sessions").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let list: Value =
            serde_json::from_slice(&list.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(list["sessions"].as_array().unwrap().len(), 0);
    }
}
