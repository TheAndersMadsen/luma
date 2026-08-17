//! Bounded, authenticated Center activity views.
//!
//! These endpoints intentionally expose only user-authored notes, the final
//! prompt/response pair, and non-secret Spotify track metadata. They never
//! return system prompts, provider request logs, tokens, or raw model history.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::io::Read as _;

use super::ApiState;
use crate::storage::{Location, MediaStoreError, OpenedMediaFile};

const DEFAULT_LIMIT: usize = 40;
const MAX_LIMIT: usize = 100;
const MAX_NOTE_UTF8_BYTES: usize = 16 * 1024;

pub fn router() -> Router<ApiState> {
    Router::new()
        .route("/notes", get(list_notes).delete(clear_notes))
        .route("/notes/{id}", delete(delete_note))
        .route("/prompts", get(list_prompts).delete(clear_prompts))
        .route("/prompts/{id}", delete(delete_prompt))
        .route("/music", get(list_music).delete(clear_music))
        .route("/music/{id}", delete(delete_music))
}

#[derive(Debug, Deserialize)]
struct PageQuery {
    limit: Option<usize>,
    before: Option<String>,
}

impl PageQuery {
    fn limit(&self) -> usize {
        self.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
    }

    fn before_id(&self) -> Result<Option<i64>, StatusCode> {
        self.before
            .as_deref()
            .map(str::parse::<i64>)
            .transpose()
            .map_err(|_| StatusCode::BAD_REQUEST)
    }
}

fn parse_note_cursor(value: Option<&str>) -> Result<Option<(i64, String)>, StatusCode> {
    let Some(value) = value else { return Ok(None) };
    let (created_at, uuid) = value.split_once('|').ok_or(StatusCode::BAD_REQUEST)?;
    let created_at = created_at
        .parse::<i64>()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let parsed = uuid::Uuid::parse_str(uuid).map_err(|_| StatusCode::BAD_REQUEST)?;
    if parsed.hyphenated().to_string() != uuid {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(Some((created_at, uuid.to_string())))
}

fn note_cursor(created_at: &str, uuid: &str) -> String {
    format!("{created_at}|{uuid}")
}

#[derive(Debug, Serialize)]
struct ActivityPage<T> {
    items: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_before: Option<String>,
}

#[derive(Debug, Serialize)]
struct NoteActivity {
    id: String,
    created_at: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<Location>,
}

#[derive(Debug, Deserialize)]
struct StoredNote {
    format: String,
    version: u8,
    text: String,
}

async fn list_notes(
    State(state): State<ApiState>,
    Query(query): Query<PageQuery>,
) -> Result<Json<ActivityPage<NoteActivity>>, StatusCode> {
    let limit = query.limit();
    let query_limit = limit.saturating_add(1);
    let records = state
        .db
        .list_note_activity(query_limit, parse_note_cursor(query.before.as_deref())?)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let metadata_has_more = records.len() == query_limit;
    let record_count = records.len();
    let opened_notes = {
        let store = state.store.lock().await;
        let mut opened_notes = Vec::with_capacity(records.len());
        for record in records {
            let opened = match store.open_media_file(&record.uuid, "note.json").await {
                Ok(opened) => Some(opened),
                Err(
                    MediaStoreError::MemoryNotFound
                    | MediaStoreError::UnexpectedFilename
                    | MediaStoreError::InvalidFilename
                    | MediaStoreError::UploadTooLarge,
                ) => None,
                Err(MediaStoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                    None
                }
                Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
            };
            opened_notes.push((record, opened));
        }
        opened_notes
    };
    let last_record_cursor = opened_notes
        .last()
        .map(|(record, _)| note_cursor(&record.created_at, &record.uuid));
    let mut notes = Vec::with_capacity(limit);
    let mut next_before = None;

    for (index, (record, opened)) in opened_notes.into_iter().enumerate() {
        let Some(opened) = opened else { continue };
        let note = match tokio::task::spawn_blocking(move || read_stored_note(opened)).await {
            Ok(Ok(Some(note))) => note,
            Ok(Ok(None)) => continue,
            Ok(Err(_)) | Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
        };
        notes.push(NoteActivity {
            id: record.uuid.clone(),
            created_at: record.created_at.clone(),
            text: note.text,
            location: record.location.clone(),
        });
        if notes.len() == limit {
            if index + 1 < record_count || metadata_has_more {
                next_before = Some(note_cursor(&record.created_at, &record.uuid));
            }
            break;
        }
    }

    if notes.len() < limit && metadata_has_more {
        next_before = last_record_cursor;
    }
    Ok(Json(ActivityPage {
        items: notes,
        next_before,
    }))
}

fn read_stored_note(mut opened: OpenedMediaFile) -> std::io::Result<Option<StoredNote>> {
    if opened.len > MAX_NOTE_UTF8_BYTES as u64 {
        return Ok(None);
    }

    let metadata = opened.file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_NOTE_UTF8_BYTES as u64 {
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(opened.len as usize);
    opened
        .file
        .by_ref()
        .take(MAX_NOTE_UTF8_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_NOTE_UTF8_BYTES {
        return Ok(None);
    }
    Ok(match serde_json::from_slice::<StoredNote>(&bytes) {
        Ok(note) if note.format == "penumbra.note" && note.version == 1 => Some(note),
        _ => None,
    })
}

async fn delete_note(Path(id): Path<String>, State(state): State<ApiState>) -> Response {
    let mut store = state.store.lock().await;
    if store.memory_dir(&id).is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match store.get_memory(&id).await {
        Some(record) if record.memory_type == "note" => match store.delete_memory(&id).await {
            Ok(true) => StatusCode::NO_CONTENT.into_response(),
            Ok(false) => StatusCode::NOT_FOUND.into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        Some(_) => StatusCode::BAD_REQUEST.into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn clear_notes(State(state): State<ApiState>) -> Response {
    let ids = match state.db.list_memory_ids_by_type("note").await {
        Ok(ids) => ids,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut store = state.store.lock().await;
    for id in ids {
        if store.delete_memory(&id).await.is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn list_prompts(
    State(state): State<ApiState>,
    Query(query): Query<PageQuery>,
) -> Result<Json<ActivityPage<crate::db::PromptActivityRecord>>, StatusCode> {
    let items = state
        .db
        .list_prompt_activity(query.limit(), query.before_id()?)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let next_before = (items.len() == query.limit()).then(|| items.last().unwrap().id.to_string());
    Ok(Json(ActivityPage { items, next_before }))
}

async fn delete_prompt(Path(id): Path<i64>, State(state): State<ApiState>) -> StatusCode {
    match state.db.delete_prompt_activity(id).await {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn clear_prompts(State(state): State<ApiState>) -> StatusCode {
    match state.db.clear_prompt_activity().await {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn list_music(
    State(state): State<ApiState>,
    Query(query): Query<PageQuery>,
) -> Result<Json<ActivityPage<crate::db::MusicActivityRecord>>, StatusCode> {
    let items = state
        .db
        .list_music_activity(query.limit(), query.before_id()?)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let next_before = (items.len() == query.limit()).then(|| items.last().unwrap().id.to_string());
    Ok(Json(ActivityPage { items, next_before }))
}

async fn delete_music(Path(id): Path<i64>, State(state): State<ApiState>) -> StatusCode {
    match state.db.delete_music_activity(id).await {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn clear_music(State(state): State<ApiState>) -> StatusCode {
    match state.db.clear_music_activity().await {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_note(path: &std::path::Path) -> OpenedMediaFile {
        let file = std::fs::File::open(path).unwrap();
        let len = file.metadata().unwrap().len();
        OpenedMediaFile { file, len }
    }

    #[test]
    fn note_cursor_is_stable_and_strict() {
        let id = "123e4567-e89b-42d3-a456-426614174000";
        assert_eq!(
            parse_note_cursor(Some(&note_cursor("1721000000", id))).unwrap(),
            Some((1_721_000_000, id.to_string()))
        );
        assert!(parse_note_cursor(Some(id)).is_err());
        assert!(
            parse_note_cursor(Some("1721000000|123E4567-E89B-42D3-A456-426614174000")).is_err()
        );
    }

    #[test]
    fn bounded_note_reader_accepts_only_canonical_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.json");
        std::fs::write(
            &note,
            br#"{"format":"penumbra.note","version":1,"text":"buy coffee"}"#,
        )
        .unwrap();
        assert_eq!(
            read_stored_note(open_test_note(&note))
                .unwrap()
                .unwrap()
                .text,
            "buy coffee"
        );

        let noncanonical = dir.path().join("other.json");
        std::fs::write(
            &noncanonical,
            br#"{"format":"other.note","version":1,"text":"private"}"#,
        )
        .unwrap();
        assert!(read_stored_note(open_test_note(&noncanonical))
            .unwrap()
            .is_none());
    }

    #[test]
    fn bounded_note_reader_rejects_oversized_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let oversized = dir.path().join("large.json");
        std::fs::write(&oversized, vec![b'x'; MAX_NOTE_UTF8_BYTES + 1]).unwrap();
        assert!(read_stored_note(open_test_note(&oversized))
            .unwrap()
            .is_none());
    }

    #[test]
    fn bounded_note_reader_uses_open_descriptor_after_path_swap() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.json");
        std::fs::write(
            &note,
            br#"{"format":"penumbra.note","version":1,"text":"original"}"#,
        )
        .unwrap();
        let opened = open_test_note(&note);

        let displaced = dir.path().join("displaced.json");
        std::fs::rename(&note, displaced).unwrap();
        std::fs::write(
            &note,
            br#"{"format":"penumbra.note","version":1,"text":"replacement"}"#,
        )
        .unwrap();

        assert_eq!(read_stored_note(opened).unwrap().unwrap().text, "original");
    }
}
