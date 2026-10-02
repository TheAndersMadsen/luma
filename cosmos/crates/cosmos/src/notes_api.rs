//! The humane.center notes surface.
//!
//! The recovered client read and wrote notes on the `capture` service
//! (`K/api-client.js` `getNotes`, `createNote`, `editNote`, `deleteAllNotes`):
//!
//! - `GET /capture/notes?page&size`, one Spring page, newest first. Luma adds
//!   `query`, the server search behind the recovered `/notes/search` route.
//! - `POST /capture/note/create {text = "New note.", title}`
//! - `POST /capture/note/{uuid} {text, title}`, the edit.
//! - `DELETE /capture/notes`, which the client paired with
//!   `DELETE /notable-events/event/createNote`. Cosmos does both in one call.
//!
//! Luma adds `GET /capture/note/{uuid}` and `DELETE /capture/notes/{uuid}` for
//! Center's per-note page and its Forget control.
//!
//! Cosmos holds every note it can read in the wearer's own words: `body` and
//! `title` for the notes it writes itself, the device envelope for the rest.
//! Center holds no note key and seals nothing.
//!
//! ## Honest by construction
//!
//! Only a verified web caller ([`RequestPlane::Web`]) receives a title or text,
//! may search, or may write. Device-plane and developer-fallback reads of the
//! list receive `sealed: true` rows, even when Cosmos holds the key.

use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use prost::Message as _;
use serde::{Deserialize, Serialize};

use crate::keydirectory::{KeyDirectoryError, SharedKeyDirectory};
use crate::store::{EventFilter, NewNote, NoteRecord, NoteSource, Written};
use crate::web_api::{
    ApiState, DeletedDto, MAX_PAGE_SIZE, PAGE_SIDE_READ_CONCURRENCY, PageQuery, RequestPlane,
    delete_failed, key_directory_miss, page_of, unavailable,
};

/// Mount the notes routes over the shared web state.
pub(crate) fn router(state: ApiState) -> Router {
    Router::new()
        .route("/capture/notes", get(list_notes).delete(delete_all_notes))
        .route("/capture/notes/:uuid", delete(delete_note))
        .route("/capture/note/create", post(create_note))
        .route("/capture/note/:uuid", get(get_note).post(edit_note))
        .with_state(state)
}

/// What the recovered client sends when the wearer leaves the body empty
/// (`createNote({text: a = "New note.", title})`, and the same default on
/// `editNote`).
const DEFAULT_NOTE_TEXT: &str = "New note.";

/// Bounds on one web write and one search, in characters. Luma's own limits:
/// the recovered client states none, and these are far above anything the
/// notes page can usefully show.
const MAX_TITLE_CHARS: usize = 256;
const MAX_TEXT_CHARS: usize = 32_768;
const MAX_QUERY_CHARS: usize = 256;

/// Notable-event types the recovered client erased with every note.
///
/// `deleteAllNotes()` is `DELETE /capture/notes` followed by
/// `DELETE /notable-events/event/createNote` (`K/api-client.js`), so the stock
/// cloud recorded a `createNote` event per note and cleared them together. No
/// device class emits one. The server-side spelling was not recovered, and
/// every stock type is namespaced `humane.` (`NotableEvent.EVENT_TYPE_*`), so
/// both spellings of that one kind are erased. INFERRED.
const NOTE_EVENT_TYPES: [&str; 2] = ["createNote", "humane.createNote"];

/// How many words a voice note's generated heading keeps.
const HEADING_WORDS: usize = 8;

/// One note row on the wire.
///
/// Every field outside `content` is index metadata. `content` exists only for a
/// verified web caller whose note Cosmos could read. A sealed row carries no
/// title or text key at all.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteDto {
    uuid: String,
    created_at: i64,
    /// The last change. The creation time for a note that was never edited.
    modified_at: i64,
    has_location: bool,
    /// True unless this exact request was authenticated on the web plane and
    /// Cosmos could read the note.
    sealed: bool,
    #[serde(flatten)]
    content: Option<NoteContent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteContent {
    /// `null` when the note has none. Blank titles are `null`, as the
    /// recovered client normalised them.
    title: Option<String>,
    /// Present, and true, when `title` is a voice note's generated heading
    /// rather than one somebody wrote. See [`NoteDto::headed`].
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    title_generated: bool,
    text: String,
}

impl NoteDto {
    fn sealed(n: &NoteRecord) -> Self {
        Self {
            uuid: n.uuid.clone(),
            created_at: n.created.seconds(),
            modified_at: modified_seconds(n),
            has_location: has_location(n),
            sealed: true,
            content: None,
        }
    }

    fn opened(n: &NoteRecord, title: Option<String>, text: String, modified_at: i64) -> Self {
        Self {
            uuid: n.uuid.clone(),
            created_at: n.created.seconds(),
            modified_at,
            has_location: has_location(n),
            sealed: false,
            content: Some(NoteContent {
                title: title.filter(|title| !title.trim().is_empty()),
                title_generated: false,
                text,
            }),
        }
    }

    /// Head a voice note nobody titled with its first sentence.
    ///
    /// The notes quick action sends only an utterance
    /// (`QuickActionRouter.handleNotesAction` → `FunctionCall{name:
    /// "CreateMemory", utterance, is_locked, time_zone, location}`) and the
    /// assistant's `remember` only its text, yet `humane.capture.Note` has a
    /// `title` and humane.center showed one, so the cloud titled voice notes
    /// itself. How is not recovered (INFERRED). Cosmos derives the heading from
    /// the note's current text on every read and never stores it, so it
    /// follows voice and web edits. A title the wearer types replaces it. Web
    /// and device notes are titled by whoever wrote them and never get one.
    fn headed(mut self, n: &NoteRecord) -> Self {
        if let Some(content) = self.content.as_mut() {
            if content.title.is_none() && is_voice_note(n) {
                content.title = voice_heading(&content.text);
                content.title_generated = content.title.is_some();
            }
        }
        self
    }
}

/// Written by speaking, not typing: the notes quick action or the assistant.
fn is_voice_note(n: &NoteRecord) -> bool {
    match n.source {
        Some(NoteSource::QuickAction | NoteSource::Assistant) => true,
        Some(NoteSource::Device | NoteSource::Web) => false,
        // Stored before sources were recorded. With no envelope, only the voice
        // paths wrote such a row: `remember` stored its text and nothing else.
        None => n.encrypted_note.is_none(),
    }
}

fn modified_seconds(n: &NoteRecord) -> i64 {
    n.modified.unwrap_or(n.created).seconds()
}

fn has_location(n: &NoteRecord) -> bool {
    n.location.is_some() || n.encrypted_location.is_some()
}

/// The page's rows as `plane` may see them, in order.
///
/// Shared with the Memories dashboard aggregate, so its note cards and the
/// notes page can never disagree about a note.
pub(crate) async fn note_dtos(
    keys: &SharedKeyDirectory,
    plane: RequestPlane,
    records: Vec<NoteRecord>,
) -> Result<Vec<NoteDto>, KeyDirectoryError> {
    use futures_util::StreamExt as _;
    if plane != RequestPlane::Web {
        return Ok(records.iter().map(NoteDto::sealed).collect());
    }
    // One key lookup and one open per sealed note, overlapped across the page
    // and ORDERED. Serially, and over every note the wearer had ever written,
    // this ran twelve times a minute for as long as a dashboard tab stayed open.
    futures_util::stream::iter(records)
        .map(|record| {
            let keys = keys.clone();
            async move { project_note_for_web(&record, &keys).await }
        })
        .buffered(PAGE_SIDE_READ_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect()
}

/// Project one note for a verified web request, in the wearer's own words
/// wherever Cosmos has them:
///
/// 1. `body`: every note Cosmos wrote itself (web, quick action, assistant) and
///    every note edited on the web.
/// 2. The Pin's HMSA envelope (`NOTE_DATA`, a `humane.capture.Note`).
/// 3. An HMCT envelope Center sealed before Cosmos held note bodies: a
///    `{title, text}` JSON object under a key Center imported.
/// 4. The lowercase search index, for a note whose envelope does not open and
///    for voice notes stored before `body` existed.
///
/// A missing key or an envelope that does not open is that row's problem and
/// is logged. Only a key directory that cannot answer fails the read.
async fn project_note_for_web(
    n: &NoteRecord,
    keys: &SharedKeyDirectory,
) -> Result<NoteDto, KeyDirectoryError> {
    if let Some(body) = &n.body {
        let dto = NoteDto::opened(n, n.title.clone(), body.clone(), modified_seconds(n));
        return Ok(dto.headed(n));
    }
    if let Some(opened) = open_envelope(n, keys).await? {
        return Ok(opened);
    }
    match &n.indexed_text {
        Some(index) => Ok(indexed(n, index)),
        None => Ok(NoteDto::sealed(n)),
    }
}

/// The note inside `encrypted_note`, when this directory can open it.
async fn open_envelope(
    n: &NoteRecord,
    keys: &SharedKeyDirectory,
) -> Result<Option<NoteDto>, KeyDirectoryError> {
    let Some(sealed) = &n.encrypted_note else {
        return Ok(None);
    };
    let kid = sealed
        .encryption_information
        .as_ref()
        .map(|information| information.kid.as_str())
        .unwrap_or_default();
    let miss = |what| {
        key_directory_miss(keys, &n.uuid, what);
        Ok(None)
    };
    let key = match keys.get(kid).await {
        Ok(Some(key)) => key,
        Ok(None) => return miss("no channel key for this note"),
        Err(KeyDirectoryError::InvalidKid) => return miss("the note names no usable key id"),
        Err(error) => return Err(error),
    };
    // Same discriminator as `services::capture::opened_note_text`.
    if sealed.data.get(4..8) == Some(b"HMSA") {
        let Ok(plaintext) = cosmos_crypto::secure_asset::open_secure_asset(
            &key,
            kid,
            &sealed.data,
            cosmos_crypto::secure_asset::NOTE_DATA,
        ) else {
            return miss("held the note's key but the envelope did not open");
        };
        let Ok(note) = cosmos_protocol::capture::Note::decode(plaintext.as_slice()) else {
            return miss("note opened but did not decode as a Note");
        };
        let modified_at = note
            .modified_at
            .map_or_else(|| modified_seconds(n), |timestamp| timestamp.seconds);
        return Ok(Some(NoteDto::opened(
            n,
            Some(note.title),
            note.text,
            modified_at,
        )));
    }
    let envelope = cosmos_crypto::EncryptedData {
        data: sealed.data.clone(),
        kid: kid.to_owned(),
    };
    let Ok(plaintext) = cosmos_crypto::open(&key, &envelope) else {
        return miss("held the note's key but the envelope did not open");
    };
    let Some(note) = web_note_json(&String::from_utf8_lossy(&plaintext)) else {
        return miss("note opened but is not a {title,text} object");
    };
    Ok(Some(NoteDto::opened(
        n,
        note.title,
        note.text,
        modified_seconds(n),
    )))
}

/// The `{title, text}` object Center used to seal (`JSON.stringify` drops an
/// undefined title). Only this exact shape, so JSON punctuation never renders
/// as a note body.
#[derive(Deserialize)]
struct WebNoteJson {
    #[serde(default)]
    title: Option<String>,
    text: String,
}

fn web_note_json(text: &str) -> Option<WebNoteJson> {
    serde_json::from_str(text).ok()
}

/// A note known only by its lowercase search index. An HMCT note whose key is
/// gone was indexed as its JSON, so that shape is decoded rather than shown.
fn indexed(n: &NoteRecord, index: &str) -> NoteDto {
    match web_note_json(index) {
        Some(note) => NoteDto::opened(n, note.title, note.text, modified_seconds(n)),
        None => NoteDto::opened(n, None, index.to_owned(), modified_seconds(n)).headed(n),
    }
}

/// The note's first sentence, cut to [`HEADING_WORDS`] words. `None` when that
/// sentence is the whole note: a one-line note is its own heading.
fn voice_heading(text: &str) -> Option<String> {
    let text = text.trim();
    let end = first_sentence_end(text);
    let sentence = text[..end].trim_end_matches(|c: char| {
        c.is_whitespace() || matches!(c, '.' | '!' | '?' | ',' | ';' | ':')
    });
    let words: Vec<&str> = sentence.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let cut = words.len() > HEADING_WORDS;
    if !cut && text[end..].trim().is_empty() {
        return None;
    }
    let mut heading = words[..words.len().min(HEADING_WORDS)].join(" ");
    if cut {
        heading.push('…');
    }
    let mut chars = heading.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().chain(chars).collect())
}

/// Byte offset just past the first sentence: a line break, or a `.`, `!` or `?`
/// that ends the text or is followed by whitespace (so "3.5" is one word).
fn first_sentence_end(text: &str) -> usize {
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match c {
            '\n' => return at,
            '.' | '!' | '?' if chars.peek().is_none_or(|(_, next)| next.is_whitespace()) => {
                return at + c.len_utf8();
            }
            _ => {}
        }
    }
    text.len()
}

/// `GET /capture/notes` query: the recovered `page`/`size`, plus the search.
#[derive(Deserialize)]
struct NotesQuery {
    page: Option<i64>,
    size: Option<i64>,
    query: Option<String>,
}

async fn list_notes(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<NotesQuery>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    let needle = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|needle| !needle.is_empty());
    if let Some(needle) = needle {
        if needle.chars().count() > MAX_QUERY_CHARS {
            return (StatusCode::BAD_REQUEST, "the search is too long").into_response();
        }
        if has_nul(needle) {
            return (
                StatusCode::BAD_REQUEST,
                "a search cannot contain a NUL character",
            )
                .into_response();
        }
        // Which notes match is derived from their text, so it is as private as
        // the text itself.
        if resolved.plane != RequestPlane::Web {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let (page, size, offset) = PageQuery {
        page: query.page,
        size: query.size,
    }
    .window();
    let rows = match state
        .store
        .note_page(&resolved.account, needle, offset, size)
        .await
    {
        Ok(rows) => rows,
        Err(_) => return unavailable(),
    };
    match note_dtos(&state.keys, resolved.plane, rows.records).await {
        Ok(dtos) => Json(page_of(dtos, rows.total, page, size)).into_response(),
        Err(_) => unavailable(),
    }
}

/// `GET /capture/note/{uuid}`, one note, for Center's note page.
async fn get_note(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let resolved = match state.web_account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    if uuid::Uuid::parse_str(&uuid).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let note = match state.store.note(&resolved.account, &uuid).await {
        Ok(Some(note)) => note,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    match project_note_for_web(&note, &state.keys).await {
        Ok(dto) => Json(dto).into_response(),
        Err(_) => unavailable(),
    }
}

/// The body of `POST /capture/note/create` and `POST /capture/note/{uuid}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteWrite {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

/// PostgreSQL `text` cannot hold U+0000, so a NUL the memory store would keep
/// fails the production insert, update or search as a store outage (503) that
/// no retry can fix. Refused up front, on every backend alike, as the bad
/// request it is.
fn has_nul(text: &str) -> bool {
    text.contains('\0')
}

/// A write's title and text, defaulted and bounded as one rule for both
/// routes.
fn note_write(
    body: Result<Json<NoteWrite>, JsonRejection>,
) -> Result<(Option<String>, String), Response> {
    let Json(body) = body.map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "expected a JSON {text, title} object",
        )
            .into_response()
    })?;
    let text = body.text.unwrap_or_else(|| DEFAULT_NOTE_TEXT.to_owned());
    let title = body.title.filter(|title| !title.trim().is_empty());
    if has_nul(&text) || title.as_deref().is_some_and(has_nul) {
        return Err((
            StatusCode::BAD_REQUEST,
            "a note cannot contain a NUL character",
        )
            .into_response());
    }
    if text.chars().count() > MAX_TEXT_CHARS
        || title
            .as_deref()
            .is_some_and(|title| title.chars().count() > MAX_TITLE_CHARS)
    {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "the note is too long").into_response());
    }
    Ok((title, text))
}

/// `POST /capture/note/create {text, title}`, a note written on the web.
async fn create_note(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    body: Result<Json<NoteWrite>, JsonRejection>,
) -> Response {
    let resolved = match state.web_account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    let (title, text) = match note_write(body) {
        Ok(write) => write,
        Err(refused) => return refused,
    };
    let new = NewNote {
        title,
        ..NewNote::text(NoteSource::Web, &text)
    };
    match state.store.create_note(&resolved.account, new).await {
        Ok(record) => respond_with(&state, &record).await,
        Err(_) => unavailable(),
    }
}

/// `POST /capture/note/{uuid} {text, title}`, the recovered `editNote`.
async fn edit_note(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path(uuid): Path<String>,
    body: Result<Json<NoteWrite>, JsonRejection>,
) -> Response {
    let resolved = match state.web_account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    let (title, text) = match note_write(body) {
        Ok(write) => write,
        Err(refused) => return refused,
    };
    if uuid::Uuid::parse_str(&uuid).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state
        .store
        .update_note(&resolved.account, &uuid, title.as_deref(), &text)
        .await
    {
        Ok(Some(record)) => respond_with(&state, &record).await,
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => unavailable(),
    }
}

async fn respond_with(state: &ApiState, record: &NoteRecord) -> Response {
    match project_note_for_web(record, &state.keys).await {
        Ok(dto) => Json(dto).into_response(),
        Err(_) => unavailable(),
    }
}

/// `DELETE /capture/notes`, every note, and the `createNote` events the
/// recovered client erased beside them.
///
/// `deleted` says whether anything went. A store that could not finish is a
/// failure status even when the notes already went, so a retry, which is
/// idempotent, completes the erasure the wearer asked for.
async fn delete_all_notes(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
) -> Response {
    let resolved = match state.web_account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    let Ok(notes) = state.store.delete_all_notes(&resolved.account).await else {
        return delete_failed();
    };
    let Ok(events) = delete_note_events(&state, &resolved.account).await else {
        return delete_failed();
    };
    Json(DeletedDto {
        deleted: notes + events > 0,
    })
    .into_response()
}

/// Erase the principal's [`NOTE_EVENT_TYPES`] events. How many went.
async fn delete_note_events(state: &ApiState, account: &str) -> Written<usize> {
    let filter = EventFilter {
        types: NOTE_EVENT_TYPES
            .iter()
            .map(|kind| (*kind).to_owned())
            .collect(),
        ..EventFilter::default()
    };
    let mut removed = 0;
    loop {
        let page = state
            .store
            .query_event_page(account, &filter, 0, MAX_PAGE_SIZE)
            .await?;
        let before = removed;
        for event in page.records {
            if state
                .store
                .delete_event(account, &event.event_identifier)
                .await?
            {
                removed += 1;
            }
        }
        // An empty page, or one whose rows were already gone, is the end.
        if removed == before {
            return Ok(removed);
        }
    }
}

/// `DELETE /capture/notes/{uuid}`, one note, Center's per-note Forget.
///
/// `200 {"deleted": false}` when this caller has no such note, never a 404:
/// an answer that differs only for rows that exist would say they exist.
async fn delete_note(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let resolved = match state.web_account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    match state.store.delete_note(&resolved.account, &uuid).await {
        Ok(deleted) => Json(DeletedDto { deleted }).into_response(),
        Err(_) => delete_failed(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{NotableEventRecord, SyncTime};
    use crate::web_api::test_support::*;
    // Explicit, so it wins over `axum::routing::get` from `super::*`.
    use crate::web_api::test_support::get;
    use crate::web_api::{DEMO_PRINCIPAL, HttpTrust};
    use axum::http::Method;
    use serde_json::{Value, json};

    /// The web surface exactly as `http/mod.rs` mounts it, in the loopback
    /// developer profile, with a Keycloak verifier for signed-in wearers.
    fn app(store: crate::store::SharedStore) -> Router {
        app_with_keys(store, fresh_keys())
    }

    fn app_with_keys(store: crate::store::SharedStore, keys: SharedKeyDirectory) -> Router {
        crate::web_api::router(ApiState::for_tests(
            store,
            keys,
            DEMO_PRINCIPAL.to_owned(),
            HttpTrust::development(),
            Some(test_verifier()),
            None,
        ))
    }

    /// A request from `sub`, signed in on the web.
    async fn as_wearer(
        app: &Router,
        sub: &str,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        send(app, method, uri, &[bearer_header(sub)], body).await
    }

    async fn voice_note(
        store: &crate::store::SharedStore,
        principal: &str,
        text: &str,
    ) -> NoteRecord {
        store
            .create_note(principal, NewNote::text(NoteSource::QuickAction, text))
            .await
            .unwrap()
    }

    fn event(identifier: &str, kind: &str) -> NotableEventRecord {
        NotableEventRecord {
            event_identifier: identifier.to_owned(),
            originator_identifier: "hu.ma.ne.ironman".to_owned(),
            creation_time: Some(SyncTime::now()),
            event_type: kind.to_owned(),
            event_data: None,
            encrypted_event_data: None,
            encrypted_location: None,
            device_is_locked: false,
            ingested: SyncTime::now(),
            indexed_text: None,
        }
    }

    /// A note Center sealed as HMCT JSON before Cosmos held note bodies opens
    /// with the key Center imported and reads in the wearer's casing, not as
    /// the lowercase JSON it was indexed under.
    #[tokio::test]
    async fn note_list_projects_legacy_hmct_json_note_in_original_case() {
        let store = fresh();
        let keys = fresh_keys();
        let kid = "U:alice/center/ephemeral";
        let key = [7u8; 16];
        keys.put(kid, key).await.unwrap();
        let plaintext = br#"{"title":"Weekend Plans","text":"Buy Oat Milk"}"#;
        let sealed = cosmos_crypto::seal(kid, &key, plaintext, b"").unwrap();
        let envelope = cosmos_protocol::common::encryption::EncryptedData {
            data: sealed.data,
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: kid.to_owned(),
                },
            ),
        };
        store
            .create_note(
                "U:alice",
                NewNote {
                    opened_text: Some(String::from_utf8(plaintext.to_vec()).unwrap()),
                    ..NewNote::sealed(Some(envelope), None)
                },
            )
            .await
            .unwrap();
        let app = app_with_keys(store, keys);

        let (status, page) = as_wearer(&app, "alice", Method::GET, "/capture/notes", None).await;
        assert_eq!(status, StatusCode::OK);
        let note = &page["content"][0];
        assert_eq!(note["sealed"], false);
        assert_eq!(note["title"], "Weekend Plans");
        assert_eq!(note["text"], "Buy Oat Milk");
    }

    /// The same legacy row whose key is gone falls back to its index: still
    /// decoded out of the JSON, necessarily lowercase.
    #[tokio::test]
    async fn a_legacy_note_without_its_key_reads_from_the_index() {
        let store = fresh();
        let note = store
            .create_note("U:alice", NewNote::sealed(None, None))
            .await
            .unwrap();
        store
            .index_note(
                "U:alice",
                &note.uuid,
                r#"{"title":"Weekend","text":"Buy Milk"}"#,
            )
            .await;
        let app = app(store);
        let (_, page) = as_wearer(&app, "alice", Method::GET, "/capture/notes", None).await;
        assert_eq!(page["content"][0]["title"], "weekend");
        assert_eq!(page["content"][0]["text"], "buy milk");
    }

    /// Every write, and every plaintext read, answers only a signed-in wearer:
    /// a Pin behind the edge is 403, nobody is 401 on an internet-facing
    /// deployment, and neither reaches any account's notes.
    #[tokio::test]
    async fn note_routes_refuse_device_plane_and_anonymous_writes() {
        use crate::config::{EDGE_PRINCIPAL_HEADER, EDGE_TOKEN_HEADER};
        let store = fresh();
        let mine = voice_note(&store, "U:alice", "Alice's Note").await;
        let app = crate::web_api::router(ApiState::for_tests(
            store.clone(),
            fresh_keys(),
            DEMO_PRINCIPAL.to_owned(),
            internet_facing(),
            Some(test_verifier()),
            None,
        ));
        let [xfcc, ..] = edge_subjects("alice");
        let device = [
            (EDGE_PRINCIPAL_HEADER, xfcc.clone()),
            (EDGE_TOKEN_HEADER, EDGE_TOKEN.to_owned()),
        ];
        let one = format!("/capture/note/{}", mine.uuid);
        let forget = format!("/capture/notes/{}", mine.uuid);
        let writes = [
            (
                Method::POST,
                "/capture/note/create",
                Some(json!({"text": "x"})),
            ),
            (Method::POST, one.as_str(), Some(json!({"text": "x"}))),
            (Method::GET, one.as_str(), None),
            (Method::GET, "/capture/notes?query=alice", None),
            (Method::DELETE, forget.as_str(), None),
            (Method::DELETE, "/capture/notes", None),
        ];
        for (method, uri, body) in writes {
            let (status, _) = send(&app, method.clone(), uri, &device, body.clone()).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "device {method} {uri}");
            let (status, _) = send(&app, method.clone(), uri, &[], body).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "anonymous {method} {uri}");
        }

        // The device plane still lists its own rows, sealed.
        let (status, listed) = send(&app, Method::GET, "/capture/notes", &device, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed["content"][0]["sealed"], true);
        assert!(listed["content"][0].get("text").is_none());

        let (_, page) = as_wearer(&app, "alice", Method::GET, "/capture/notes", None).await;
        assert_eq!(page["totalElements"], 1, "nothing was created or deleted");
        assert_eq!(
            page["content"][0]["text"], "Alice's Note",
            "nothing was edited"
        );
    }

    /// Delete-all is the recovered pair: every note, and every `createNote`
    /// event, of this wearer only.
    #[tokio::test]
    async fn delete_all_notes_is_principal_scoped_and_erases_create_note_events() {
        let store = fresh();
        voice_note(&store, "U:alice", "alice one").await;
        voice_note(&store, "U:alice", "alice two").await;
        voice_note(&store, "U:bob", "bob one").await;
        store
            .ingest_events(
                "U:alice",
                &[
                    event("a-note-1", "createNote"),
                    event("a-note-2", "humane.createNote"),
                    event("a-answer", "humane.respond"),
                ],
            )
            .await
            .unwrap();
        store
            .ingest_events("U:bob", &[event("b-note", "humane.createNote")])
            .await
            .unwrap();
        let app = app(store.clone());

        let (status, body) = as_wearer(&app, "alice", Method::DELETE, "/capture/notes", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deleted": true}));

        let (_, alice) = as_wearer(&app, "alice", Method::GET, "/capture/notes", None).await;
        assert_eq!(alice["totalElements"], 0);
        let remaining: Vec<String> = store
            .query_events("U:alice", "", "", None, None, 0)
            .await
            .unwrap()
            .into_iter()
            .map(|event| event.event_type)
            .collect();
        assert_eq!(remaining, ["humane.respond"], "only note events go");

        let (_, bob) = as_wearer(&app, "bob", Method::GET, "/capture/notes", None).await;
        assert_eq!(bob["totalElements"], 1, "bob's notes stay");
        assert_eq!(
            store
                .query_events("U:bob", "", "", None, None, 0)
                .await
                .unwrap()
                .len(),
            1,
            "bob's createNote event stays"
        );

        let (status, again) =
            as_wearer(&app, "alice", Method::DELETE, "/capture/notes", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(again, json!({"deleted": false}), "nothing left to erase");
    }

    /// TWO IDENTITIES MUST BE TWO PARTITIONS.
    ///
    /// The bug this pins: every read used a hardcoded `U:operator`, so a Pin
    /// enrolled as `U:<account>` wrote to one partition while the dashboard read
    /// another. Both CNs below contain the SAME device id and differ only in the
    /// `U:` segment minted server-side at binding.
    #[tokio::test]
    async fn each_account_reads_only_its_own_notes() {
        let store = fresh();
        voice_note(&store, "U:alice", "alice's note").await;
        voice_note(&store, "U:bob", "bob's note").await;
        let app = app(store);

        let (_, alice) = get_as(&app, "/capture/notes", "V:01:D:pin1:U:alice").await;
        let (_, bob) = get_as(&app, "/capture/notes", "V:01:D:pin1:U:bob").await;
        assert_eq!(alice["totalElements"], 1, "alice sees her own note");
        assert_eq!(bob["totalElements"], 1, "bob sees his own note");
        assert_ne!(
            alice["content"][0]["uuid"], bob["content"][0]["uuid"],
            "two accounts must not resolve to the same row"
        );

        // A caller who identifies nobody still gets the fallback account, which
        // is what keeps the keyless demo working, and it is NOT either wearer's.
        let (_, anon) = get(&app, "/capture/notes").await;
        assert_eq!(
            anon["totalElements"], 0,
            "the demo account is its own partition"
        );
    }

    /// Presence of a Bearer header suppresses every fallback. A bad signature or
    /// malformed JWT is 401, never an anonymous read of the demo account.
    #[tokio::test]
    async fn invalid_bearer_fails_closed_instead_of_reading_demo_data() {
        let store = fresh();
        voice_note(&store, DEMO_PRINCIPAL, "demo account secret").await;
        let app = app(store);

        let (status, body) = get_with_bearer(&app, "/capture/notes", "not-a-jwt").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, Value::Null);
    }

    /// The same routes over the production store. Skips, like every database
    /// test here, only when `COSMOS_TEST_DATABASE_URL` is unset.
    #[tokio::test]
    async fn notes_routes_behave_the_same_over_postgres() {
        let Ok(url) = std::env::var("COSMOS_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let store: crate::store::SharedStore = std::sync::Arc::new(
            crate::store_postgres::PostgresStore::connect(&url)
                .await
                .expect("COSMOS_TEST_DATABASE_URL is set but connect/migrate failed"),
        );
        // A partition of its own, so a shared database never bleeds between runs.
        let sub = format!("notes-pg-{}", uuid::Uuid::new_v4().simple());
        let principal = format!("U:{sub}");
        let app = app(store.clone());

        // Why the NUL guard exists: the production store cannot hold one.
        assert!(
            store
                .create_note(&principal, NewNote::text(NoteSource::Web, "a\u{0}b"))
                .await
                .is_err()
        );

        let (status, created) = as_wearer(
            &app,
            &sub,
            Method::POST,
            "/capture/note/create",
            Some(json!({"text": "Oat Milk 100% Off", "title": "Weekend"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["text"], "Oat Milk 100% Off");
        let uuid = created["uuid"].as_str().unwrap().to_owned();

        let (status, edited) = as_wearer(
            &app,
            &sub,
            Method::POST,
            &format!("/capture/note/{uuid}"),
            Some(json!({"text": "Oat Milk 100% Off AND Bread", "title": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{edited}");
        assert_eq!(edited["text"], "Oat Milk 100% Off AND Bread");
        assert_eq!(edited["title"], Value::Null, "the edit cleared the title");
        assert_eq!(edited["createdAt"], created["createdAt"]);

        // `%` and `_` are text, not wildcards, and the search ignores case.
        for (query, matches) in [
            ("100%25", 1),
            ("%25", 1),
            ("_", 0),
            ("BREAD", 1),
            ("weekend", 0),
        ] {
            let (status, found) = as_wearer(
                &app,
                &sub,
                Method::GET,
                &format!("/capture/notes?query={query}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(found["totalElements"], matches, "query {query}: {found}");
        }

        for index in 0..205 {
            voice_note(&store, &principal, &format!("voice {index}")).await;
        }
        let (_, second) = as_wearer(
            &app,
            &sub,
            Method::GET,
            "/capture/notes?page=1&size=200",
            None,
        )
        .await;
        assert_eq!(second["totalElements"], 206);
        assert_eq!(second["numberOfElements"], 6);
        assert_eq!(second["last"], true);
        // The web note is the oldest, so it is only on the second page, and
        // it still opens by uuid.
        let (status, oldest) = as_wearer(
            &app,
            &sub,
            Method::GET,
            &format!("/capture/note/{uuid}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(oldest["text"], "Oat Milk 100% Off AND Bread");

        store
            .ingest_events(&principal, &[event(&format!("{sub}-note"), "createNote")])
            .await
            .unwrap();
        let (status, body) = as_wearer(&app, &sub, Method::DELETE, "/capture/notes", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deleted": true}));
        assert_eq!(store.count_notes(&principal).await.unwrap(), 0);
        assert!(
            store
                .query_events(&principal, "", "", None, None, 0)
                .await
                .unwrap()
                .is_empty(),
            "the createNote event went with the notes"
        );
    }
}
