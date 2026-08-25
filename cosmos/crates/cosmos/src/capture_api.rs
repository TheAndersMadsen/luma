//! The web companion's capture/memory READ API — the surface `humane.center`
//! consumed, rebuilt faithfully over the clone's own store.
//!
//! ## Why this exists, and what it is not
//!
//! No `CaptureService` gRPC method the *device* calls lists captures — the Pin
//! only ever creates and deletes its own. But a reader is `observed` at the WEB
//! boundary: the recovered `.Center` client called `GET /capture/memories` and
//! `GET /capture/captures` with `page`/`size`/`sort=userCreatedAt,DESC`, and the
//! webapi backend was Spring Boot, so those responses were Spring Data `Page<T>`
//! envelopes (confirmed independently from the `PinSync` client and the leaked
//! `spring.data.repository.invocations` metrics). This module serves that exact
//! shape from [`crate::store::Store::memory_page`] / [`crate::store::Store::note_page`],
//! which were authored for precisely this companion-dashboard path — page, size
//! and kind filter pushed into the store, so `?size=1` costs what one row costs.
//!
//! ## Honest by construction
//!
//! Capture bodies remain sealed at rest. The capture index never exposes them.
//! Notes have one deliberately narrower projection: after a web Bearer is
//! cryptographically verified, the service may open the note with the exact C1
//! key the owned Pin escrowed and return only the decoded title/text/timestamp.
//! Device-plane and anonymous callers always receive `sealed: true`, even when
//! the service happens to hold the key or a private search index.
//!
//! ## The two deletes
//!
//! `DELETE /event/:id` and `DELETE /notes/:uuid` are the only writes here, and
//! they exist because `.Center` *already rendered the controls*: a trash button
//! on every My Data row and a Forget action over notes, both of which could not
//! delete anything — the row's route answered 405 and the store had no
//! single-row delete at all. On a privacy product a control that says delete and
//! does nothing is worse than no control, so either it works or it says it
//! didn't.
//!
//! They are REST, not new RPCs, because that is what the real system did: the
//! recovered `.Center` was a web client against the Spring webapi, and the
//! device never deletes an event or a single note. So `humane/events.proto` and
//! `humane/capture.proto` are untouched and nothing the Pin speaks changes.
//!
//! Both answer `200 {"deleted": <bool>}` — `true` when a row was removed,
//! `false` when this caller had no such row — and reserve a failure status for a
//! store that could not complete the delete. "Not found" is deliberately NOT an
//! error: it is an ordinary, truthful answer, and the caller learns nothing
//! about whether the identifier exists under some *other* account.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use prost::Message as _;
use serde::{Deserialize, Serialize};

use crate::keydirectory::SharedKeyDirectory;
use crate::store::{MemoryKind, MemorySummary, NoteRecord, SharedStore, SyncTime};

/// The account this surface falls back to when a request identifies nobody.
///
/// The demo assistant writes notes under this exact CN, so a "remember …" turn
/// and this reader see the same rows with no login configured — which is what
/// keeps the keyless demo working.
///
/// It is a FALLBACK, never the answer for an identified caller. Serving every
/// request from this constant is the bug [`principal_for`] exists to fix: a real
/// Pin enrols as `U:<account>` and writes there, while the dashboard read
/// `U:operator`, so the wearer's captures and the dashboard's view were two
/// different partitions and neither side reported anything wrong.
pub const DEMO_PRINCIPAL: &str = "V:01:D:web-demo:U:operator";

/// Whose data this request is asking for.
///
/// The same order of precedence the gRPC front door uses
/// (`auth::RequestAuthenticator::authenticate`), so one identity resolves the
/// same way whichever surface it arrives on:
///
/// 1. **A verified Bearer token** — the web plane. Signature-checked against
///    Keycloak's JWKS, so this is an assertion the server proved, not a header it
///    was handed. `sub` becomes `U:<sub>`.
/// 2. **The edge-injected principal** — the device plane. Only trustworthy
///    because Envoy rewrites `x-forwarded-client-cert` from the verified client
///    certificate and strips inbound copies; a DeviceUser CN resolves through
///    `from_device_cn` to the same `U:<account>` the web login produces, which is
///    what makes one person's Pin and browser read one partition.
/// 3. **The demo account** — nobody identified themselves and no plane is
///    configured.
///
/// A Bearer token that is PRESENT but INVALID resolves to `None`: the caller
/// asserted an identity and it did not hold, so falling back to the demo account
/// would silently serve them someone else's data. Absent a token, the request
/// simply has not made a web claim and continues to the device plane.
///
/// `pub(crate)` because the assistant's HTTP surfaces must resolve identity the
/// SAME way. They used to insert a hardcoded `from_edge(DEMO_PRINCIPAL)` on
/// every turn, so "remember X" wrote into the demo partition while the wearer's
/// own `/notes` read `U:<sub>` — the exact partition split this function exists
/// to prevent, reintroduced one module over.
pub(crate) fn principal_for(
    headers: &axum::http::HeaderMap,
    verifier: Option<&crate::web_auth::JwtVerifier>,
) -> Result<Option<ResolvedPrincipal>, ()> {
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        // An asserted web identity is all-or-nothing. A malformed header, an
        // unavailable verifier, or a token that does not verify must never fall
        // through to the demo partition (which would disclose another account).
        let value = value.to_str().map_err(|_| ())?;
        let token = crate::web_auth::bearer_token(value).ok_or(())?;
        let verifier = verifier.ok_or(())?;
        let principal = verifier.verify(token).map_err(|_| ())?;
        return Ok(Some(ResolvedPrincipal {
            account: principal.expose_for_authorization().to_owned(),
            plane: RequestPlane::Web,
        }));
    }
    if let Some(value) = headers
        .get(crate::config::EDGE_PRINCIPAL_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        let subject = crate::config::principal_from_xfcc(value).unwrap_or(value);
        if let Ok(principal) = cosmos_core::AuthenticatedPrincipal::from_device_cn(subject) {
            // Public share pages have no wearer Bearer by design. The trusted
            // Center BFF resolves an expiring signed capability to a wearer and
            // presents a purpose-scoped projection token on this internal
            // marker. Without that proof the exact same XFCC request remains
            // device-plane and receives ciphertext, never an opened thumbnail.
            let plane = if valid_projection_token(headers) {
                RequestPlane::Web
            } else {
                RequestPlane::Device
            };
            return Ok(Some(ResolvedPrincipal {
                account: principal.expose_for_authorization().to_owned(),
                plane,
            }));
        }
    }
    Ok(None)
}

const WEB_PROJECTION_TOKEN_HEADER: &str = "x-cosmos-web-projection-token";

fn valid_projection_token(headers: &axum::http::HeaderMap) -> bool {
    let Some(expected) = std::env::var("COSMOS_CENTER_PROJECTION_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
    else {
        return false;
    };
    let presented = headers
        .get(WEB_PROJECTION_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let a = presented.as_bytes();
    let b = expected.as_bytes();
    a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RequestPlane {
    Web,
    Device,
    Fallback,
}

pub(crate) struct ResolvedPrincipal {
    pub(crate) account: String,
    pub(crate) plane: RequestPlane,
}

#[derive(Clone)]
struct ApiState {
    store: SharedStore,
    keys: SharedKeyDirectory,
    objects: Option<Arc<crate::services::capture::CaptureObjectStore>>,
    principal: Arc<str>,
    web_verifier: Option<Arc<crate::web_auth::JwtVerifier>>,
}

/// Mount the capture read API. The store handed in MUST be the same instance the
/// assistant writes to, or the viewer shows nothing a "remember" turn saved.
pub fn router(
    store: SharedStore,
    keys: SharedKeyDirectory,
    principal: impl Into<Arc<str>>,
) -> Router {
    router_with_verifier(
        store,
        keys,
        principal,
        crate::web_auth::configured_verifier(),
    )
}

fn router_with_verifier(
    store: SharedStore,
    keys: SharedKeyDirectory,
    principal: impl Into<Arc<str>>,
    web_verifier: Option<Arc<crate::web_auth::JwtVerifier>>,
) -> Router {
    router_with_objects(
        store,
        keys,
        principal,
        web_verifier,
        crate::services::capture::configured_object_store(),
    )
}

/// The object sink is a parameter rather than a call to
/// `configured_object_store()` inside the body so that a test can mount this
/// router over a temporary root. The routes that write to storage — the
/// best-frame ones — were otherwise unreachable under `cargo test`, which runs
/// with no storage configured: they answered `503` before touching the sink, and
/// so a bug in what they filed there could not be caught by any test at all.
fn router_with_objects(
    store: SharedStore,
    keys: SharedKeyDirectory,
    principal: impl Into<Arc<str>>,
    web_verifier: Option<Arc<crate::web_auth::JwtVerifier>>,
    objects: Option<Arc<crate::services::capture::CaptureObjectStore>>,
) -> Router {
    let state = ApiState {
        store,
        keys,
        objects,
        principal: principal.into(),
        web_verifier,
    };
    Router::new()
        .route("/capture/memories", get(list_memories))
        .route("/capture/captures", get(list_captures))
        .route("/capture/search", get(search_captures))
        .route("/capture/memory/:uuid", get(get_memory))
        // `observed` in recovered Center. The original ranking internals are
        // unknown; these routes drive the clone-owned selector documented in
        // `capture_ranking` and never discard an original frame.
        .route("/capture/memory/:uuid/best_photo", post(rank_best_photo))
        .route("/capture/memory/:uuid/bestFrame", post(set_best_frame))
        // Authenticated web projections. Device-plane callers never receive
        // opened durable media from these routes.
        .route("/capture/memory/:uuid/thumbnail/:index", get(get_thumbnail))
        .route("/capture/memory/:uuid/file/:file", get(get_file))
        .route("/notes", get(list_notes))
        // The deletes ride the SAME router as the reads, so they resolve the
        // caller through the same `principal_for` and cannot drift into reading
        // one account while deleting from another. Captures are not here: the
        // device's own `CaptureService.DeleteMemory` already implements that and
        // the companion calls it over gRPC.
        .route("/event/:id", delete(delete_event))
        .route("/notes/:uuid", delete(delete_note))
        .with_state(state)
}

// ── Spring Data Page<T> envelope ────────────────────────────────────────────
// Field names are Spring's own, verbatim, so a client written against the real
// webapi deserializes this unchanged.

#[derive(Serialize)]
struct SortInfo {
    empty: bool,
    sorted: bool,
    unsorted: bool,
}

impl SortInfo {
    /// Every list here is server-sorted newest-first, so the sort is always the
    /// `userCreatedAt,DESC` the `.Center` client asked for.
    fn sorted() -> Self {
        Self {
            empty: false,
            sorted: true,
            unsorted: false,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pageable {
    page_number: i64,
    page_size: i64,
    sort: SortInfo,
    offset: i64,
    paged: bool,
    unpaged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    content: Vec<T>,
    pageable: Pageable,
    last: bool,
    total_elements: i64,
    total_pages: i64,
    size: i64,
    number: i64,
    sort: SortInfo,
    first: bool,
    number_of_elements: i64,
    empty: bool,
}

#[derive(Deserialize)]
struct PageQuery {
    page: Option<i64>,
    size: Option<i64>,
    // Accepted for compatibility with the `.Center` client's
    // `sort=userCreatedAt,DESC`; the store already returns that order, so it is
    // validated-and-ignored rather than honoured for arbitrary fields.
    #[allow(dead_code)]
    sort: Option<String>,
}

/// Default and maximum page sizes. The max bounds a client that asks for
/// everything at once from turning one request into an unbounded serialization.
const DEFAULT_PAGE_SIZE: i64 = 20;
const MAX_PAGE_SIZE: i64 = 200;
const CAPTURE_KINDS: &[MemoryKind] = &[MemoryKind::Photo, MemoryKind::Video];

impl PageQuery {
    /// The window this request asks for: `(page, size, offset)`.
    ///
    /// Resolved BEFORE the store is asked anything, because the window is what
    /// bounds the read. It used to be applied after a full listing had already
    /// been materialised and decrypted, which is why `?size=1` cost exactly what
    /// `?size=200` cost — and the health probe issues the `size=1` one.
    fn window(&self) -> (i64, i64, i64) {
        let page = self.page.unwrap_or(0).max(0);
        let size = self
            .size
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        (page, size, page.saturating_mul(size))
    }
}

/// Wrap rows the STORE already sliced in the Spring envelope.
///
/// `total` is the store's own count of everything the filter matches, not
/// `content.len()`: an empty final page still has to report how many rows exist,
/// and `last`/`totalPages` are derived from it.
fn page_of<T>(content: Vec<T>, total: i64, page: i64, size: i64) -> Page<T> {
    let offset = page.saturating_mul(size);
    // Ceiling division without the unstable `div_ceil`. `size` is clamped >= 1.
    let total_pages = (total + size - 1) / size;
    let number_of_elements = content.len() as i64;

    Page {
        empty: content.is_empty(),
        pageable: Pageable {
            page_number: page,
            page_size: size,
            sort: SortInfo::sorted(),
            offset,
            paged: true,
            unpaged: false,
        },
        // `last` is a property of the page position, true when this page reaches
        // or passes the final element — including the empty page past the end.
        last: offset + number_of_elements >= total,
        total_elements: total,
        total_pages,
        size,
        number: page,
        sort: SortInfo::sorted(),
        first: page == 0,
        number_of_elements,
        content,
    }
}

// ── DTOs: the capture INDEX, never sealed content ───────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryDto {
    uuid: String,
    id: i64,
    device_local_id: String,
    /// PHOTO | VIDEO | FOODLOG | NOTE — the device's own memory type.
    #[serde(rename = "type")]
    kind: &'static str,
    /// Epoch seconds the device recorded it; the `.Center` client sorted on this.
    user_created_at: Option<i64>,
    /// Epoch seconds the server first stored it.
    created_at: i64,
    upload_complete: bool,
    deleted: bool,
    /// How many thumbnails the device sealed — a count, never the bytes.
    thumbnail_count: usize,
    has_location: bool,
    burst_count: usize,
    /// Number of uploaded frame slots in all bursts. Stock photos normally have
    /// one burst with three frames.
    frame_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    best_frame_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    best_frame_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    best_frame_reason: Option<String>,
    /// Whether this photo has private object/category metadata available for
    /// semantic search. The metadata itself is never serialized.
    visual_search_ready: bool,
    /// The content is `EncryptedData` readable only on the Pin.
    sealed: bool,
}

fn kind_str(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Photo => "PHOTO",
        MemoryKind::Video => "VIDEO",
        MemoryKind::FoodLog => "FOODLOG",
        MemoryKind::Note => "NOTE",
    }
}

impl MemoryDto {
    /// Built from the capture INDEX, never from its sealed bytes.
    ///
    /// Every field here is a count, a flag or a timestamp, which is what makes
    /// [`MemorySummary`] sufficient — and is why reading whole records to fill
    /// it in was pure waste. Listings never load a frame; the single-capture
    /// routes that do already hold one and summarise it.
    fn new(
        m: &MemorySummary,
        selection: Option<crate::capture_ranking::BestFrameSelection>,
    ) -> Self {
        let selection = selection.filter(|selection| selection.frame < m.frame_count);
        let visual_search_ready = selection
            .as_ref()
            .is_some_and(crate::capture_ranking::BestFrameSelection::has_visual_index);
        Self {
            uuid: m.uuid.clone(),
            id: m.numeric_id,
            device_local_id: m.device_local_id.clone(),
            kind: kind_str(m.kind),
            user_created_at: m.device_created_time.as_ref().map(SyncTime::seconds),
            created_at: m.created.seconds(),
            upload_complete: m.upload_complete,
            // Listings and single reads both select live rows only, so a record
            // that reaches here is never a tombstone.
            deleted: false,
            thumbnail_count: m.thumbnail_count,
            has_location: m.has_location,
            burst_count: m.burst_count,
            frame_count: m.frame_count,
            best_frame_index: selection.as_ref().map(|selection| selection.frame),
            best_frame_method: selection.as_ref().map(|selection| selection.method.clone()),
            best_frame_reason: selection.map(|selection| selection.reason),
            visual_search_ready,
            sealed: true,
        }
    }
}

/// The answer both delete routes give: did a row actually go?
///
/// One boolean and nothing else. It is `snake_case` on the wire (`deleted`) —
/// a single word, so unlike the `Page<T>` envelope there is no camelCase form to
/// get wrong — and it is the ONLY 200 body these routes produce. A failed delete
/// is a failure status, never `{"deleted": false}`: `false` is a claim about the
/// wearer's data ("you had no such row"), and answering it over an outage tells
/// them an erasure happened that did not.
#[derive(Serialize)]
struct DeletedDto {
    deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteDto {
    uuid: String,
    created_at: i64,
    has_location: bool,
    /// True unless this exact request was authenticated on the web plane and
    /// Cosmos could project plaintext it had already authenticated.
    sealed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

impl NoteDto {
    fn sealed(n: &NoteRecord) -> Self {
        Self {
            uuid: n.uuid.clone(),
            created_at: n.created.seconds(),
            has_location: n.encrypted_location.is_some(),
            sealed: true,
            modified_at: None,
            title: None,
            text: None,
        }
    }

    fn opened(n: &NoteRecord, note: cosmos_protocol::capture::Note) -> Self {
        Self {
            uuid: n.uuid.clone(),
            created_at: n.created.seconds(),
            has_location: n.encrypted_location.is_some(),
            sealed: false,
            modified_at: note.modified_at.map(|timestamp| timestamp.seconds),
            title: Some(note.title),
            text: Some(note.text),
        }
    }

    fn indexed(n: &NoteRecord, indexed_text: String) -> Self {
        // Center-authored HMCT notes were indexed as their compact
        // `{title,text}` JSON payload. Voice-created notes are indexed as plain
        // text. Decode only that exact object shape so the dashboard never
        // renders JSON punctuation as the note body.
        #[derive(Deserialize)]
        struct IndexedNote {
            #[serde(default)]
            title: Option<String>,
            text: String,
        }
        let (title, text) = serde_json::from_str::<IndexedNote>(&indexed_text)
            .map(|note| (note.title, note.text))
            .unwrap_or((None, indexed_text));
        Self {
            uuid: n.uuid.clone(),
            created_at: n.created.seconds(),
            has_location: n.encrypted_location.is_some(),
            sealed: false,
            modified_at: None,
            title,
            text: Some(text),
        }
    }
}

/// Project one note for a verified web request.
///
/// The authenticated HMSA envelope is authoritative and preserves title,
/// casing and `modified_at`. `indexed_text` is a safe fallback for rows already
/// opened during ingestion before this projection existed; it is private
/// backend-derived data and is never used for device/anonymous responses.
async fn project_note_for_web(
    n: &NoteRecord,
    keys: &SharedKeyDirectory,
) -> Result<NoteDto, crate::keydirectory::KeyDirectoryError> {
    if let Some(encrypted) = &n.encrypted_note {
        if let Some(kid) = encrypted
            .encryption_information
            .as_ref()
            .map(|information| information.kid.as_str())
        {
            match keys.get(kid).await {
                Ok(Some(key)) => {
                    match cosmos_crypto::secure_asset::open_secure_asset(
                        &key,
                        kid,
                        &encrypted.data,
                        cosmos_crypto::secure_asset::NOTE_DATA,
                    ) {
                        Ok(plaintext) => {
                            match cosmos_protocol::capture::Note::decode(plaintext.as_slice()) {
                                Ok(note) => return Ok(NoteDto::opened(n, note)),
                                // We held the key and opened the envelope, so
                                // this is a stored note that is not a `Note`.
                                Err(_) => key_directory_miss(
                                    keys,
                                    &n.uuid,
                                    "note opened but did not decode as a Note",
                                ),
                            }
                        }
                        Err(_) => key_directory_miss(
                            keys,
                            &n.uuid,
                            "held the note's key but the envelope did not open",
                        ),
                    }
                }
                Ok(None) => key_directory_miss(keys, &n.uuid, "no channel key for this note"),
                Err(error) => return Err(error),
            }
        }
    }

    match &n.indexed_text {
        Some(text) => Ok(NoteDto::indexed(n, text.clone())),
        None => Ok(NoteDto::sealed(n)),
    }
}

/// Say why something sealed could not be opened.
///
/// The key directory's contract (`keydirectory`) puts this obligation on its
/// callers: "a note we cannot open is simply not searchable" is only honest if
/// somebody records that it happened. Five call sites here and in the services
/// used to return "not found" / `sealed: true` / `continue` with no trace at
/// all, so an ImportKeys that never ran, a directory that is process-local
/// because `COSMOS_DATABASE_URL` is unset, and a corrupt envelope were one silent
/// answer.
///
/// `shared` is the field that separates those: false means this process's
/// directory is memory-only, so a key imported by the AI-bus workload is simply
/// not visible here. The **kid is deliberately not logged** — it carries the
/// wearer's device and user ids, the same reason `services/events.rs` reports
/// only the decoder class.
fn key_directory_miss(keys: &SharedKeyDirectory, subject: &str, what: &str) {
    tracing::warn!(subject = %subject, shared = keys.is_shared(), "{what}");
}

// ── Handlers ────────────────────────────────────────────────────────────────

/// A store outage is a 503, never an empty page. An empty page is a *claim* — "you
/// have no captures" — and rendering an outage as that claim tells the wearer
/// their memories are gone. Same rule the store trait's `Written` distinction exists for.
fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "capture store is unavailable",
    )
        .into_response()
}

impl ApiState {
    /// Whose data to serve for this request: the identified caller, else the
    /// configured fallback account.
    fn account_for(
        &self,
        headers: &axum::http::HeaderMap,
    ) -> Result<ResolvedPrincipal, StatusCode> {
        match principal_for(headers, self.web_verifier.as_deref()) {
            Ok(Some(principal)) => Ok(principal),
            Ok(None) => Ok(ResolvedPrincipal {
                account: self.principal.to_string(),
                plane: RequestPlane::Fallback,
            }),
            Err(()) => Err(StatusCode::UNAUTHORIZED),
        }
    }
}

/// How many per-record side reads a page overlaps.
///
/// Each capture on a page costs one `read_best_frame` filesystem read and each
/// note one channel-key lookup, and both used to run strictly one after another
/// — a serial `for … .await` over every row the wearer owned. Bounded rather
/// than unbounded because both can reach a database pool (`max_connections` is
/// 8): a page must not be able to starve the pool it shares with the device
/// plane.
const PAGE_SIDE_READ_CONCURRENCY: usize = 8;
const VISUAL_INDEX_CONCURRENCY: usize = 2;
static VISUAL_INDEX_RUNNING: AtomicBool = AtomicBool::new(false);

struct VisualIndexRun;

impl Drop for VisualIndexRun {
    fn drop(&mut self) {
        VISUAL_INDEX_RUNNING.store(false, Ordering::Release);
    }
}

fn schedule_visual_index(state: &ApiState, account: &str, uuids: Vec<String>) {
    if uuids.is_empty()
        || !crate::assistant::vision::configured()
        || VISUAL_INDEX_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }
    let Some(objects) = state.objects.clone() else {
        VISUAL_INDEX_RUNNING.store(false, Ordering::Release);
        return;
    };
    let store = state.store.clone();
    let keys = state.keys.clone();
    let account = account.to_owned();
    tokio::spawn(async move {
        use futures_util::StreamExt as _;
        let _run = VisualIndexRun;
        futures_util::stream::iter(uuids)
            .for_each_concurrent(VISUAL_INDEX_CONCURRENCY, |uuid| {
                let store = store.clone();
                let keys = keys.clone();
                let objects = objects.clone();
                let account = account.clone();
                async move {
                    if let Ok(Some(record)) = store.memory(&account, &uuid).await {
                        let _ = objects
                            .rank_photo_best_frame(&keys, &account, &record, false)
                            .await;
                    }
                }
            })
            .await;
    });
}

/// The DTOs for one page of captures, with their best-frame reads overlapped.
///
/// `buffered`, not `buffer_unordered`: the store returned these newest-first and
/// the page envelope claims that order, so completion order must not be allowed
/// to rewrite it.
async fn memory_dtos(state: &ApiState, account: &str, page: Vec<MemorySummary>) -> Vec<MemoryDto> {
    use futures_util::StreamExt as _;
    futures_util::stream::iter(page)
        .map(|summary| async move {
            let selection = best_frame_metadata(state, account, &summary.uuid).await;
            MemoryDto::new(&summary, selection)
        })
        .buffered(PAGE_SIDE_READ_CONCURRENCY)
        .collect()
        .await
}

async fn memories_with_selections(
    state: &ApiState,
    account: &str,
    page: Vec<MemorySummary>,
) -> Vec<(
    MemorySummary,
    Option<crate::capture_ranking::BestFrameSelection>,
)> {
    use futures_util::StreamExt as _;
    futures_util::stream::iter(page)
        .map(|summary| async move {
            let selection = best_frame_metadata(state, account, &summary.uuid).await;
            (summary, selection)
        })
        .buffered(PAGE_SIDE_READ_CONCURRENCY)
        .collect()
        .await
}

async fn list_memories(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<PageQuery>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    let (page, size, offset) = query.window();
    // `/capture/memories` is everything; no kind filter.
    match state
        .store
        .memory_page(&resolved.account, &[], offset, size)
        .await
    {
        Ok(rows) => {
            let dtos = memory_dtos(&state, &resolved.account, rows.records).await;
            axum::Json(page_of(dtos, rows.total, page, size)).into_response()
        }
        Err(_) => unavailable(),
    }
}

async fn list_captures(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<PageQuery>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    let (page, size, offset) = query.window();
    // `/capture/captures` was the photo/video view; `/capture/memories` was
    // everything. Notes and food logs are not "captures".
    //
    // The filter is pushed into the store rather than applied to the page here:
    // selecting photos out of an already-limited fetch returns short pages and a
    // total that counts rows the caller never asked for.
    match state
        .store
        .memory_page(&resolved.account, CAPTURE_KINDS, offset, size)
        .await
    {
        Ok(rows) => {
            let dtos = memory_dtos(&state, &resolved.account, rows.records).await;
            axum::Json(page_of(dtos, rows.total, page, size)).into_response()
        }
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
struct CaptureSearchQuery {
    query: String,
    page: Option<i64>,
    size: Option<i64>,
    #[allow(dead_code)]
    sort: Option<String>,
}

fn normalized_search_words(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter_map(|word| {
            let mut word = word.trim().to_lowercase();
            if word.chars().count() > 3 && word.ends_with('s') && !word.ends_with("ss") {
                word.pop();
            }
            (!word.is_empty()).then_some(word)
        })
        .collect()
}

fn capture_matches(
    summary: &MemorySummary,
    selection: Option<&crate::capture_ranking::BestFrameSelection>,
    query: &str,
) -> bool {
    let query = query.trim();
    if query.is_empty() {
        return false;
    }
    let literal = query.to_lowercase();
    if summary.uuid.to_lowercase().contains(&literal)
        || summary.device_local_id.to_lowercase().contains(&literal)
    {
        return true;
    }
    let mut searchable = vec![kind_str(summary.kind).to_owned()];
    searchable.push(summary.created.seconds().to_string());
    if let Some(created) = summary.device_created_time.as_ref() {
        searchable.push(created.seconds().to_string());
    }
    if let Some(selection) = selection {
        searchable.push(selection.caption.clone());
        searchable.extend(selection.tags.iter().cloned());
    }
    let words = searchable
        .iter()
        .flat_map(|value| normalized_search_words(value))
        .collect::<Vec<_>>();
    let wanted = normalized_search_words(query);
    !wanted.is_empty()
        && wanted
            .iter()
            .all(|word| words.iter().any(|candidate| candidate == word))
}

/// Search the complete capture index, including private vision metadata.
/// Captions and tags are used for matching but never leave Cosmos.
async fn search_captures(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<CaptureSearchQuery>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    let (page, size, requested_offset) = PageQuery {
        page: query.page,
        size: query.size,
        sort: query.sort,
    }
    .window();
    if query.query.trim().is_empty() {
        return axum::Json(page_of(Vec::<MemoryDto>::new(), 0, page, size)).into_response();
    }

    let mut source_offset = 0i64;
    let mut matches = Vec::new();
    let mut pending_visual_index = Vec::new();
    loop {
        let rows = match state
            .store
            .memory_page(
                &resolved.account,
                CAPTURE_KINDS,
                source_offset,
                MAX_PAGE_SIZE,
            )
            .await
        {
            Ok(rows) => rows,
            Err(_) => return unavailable(),
        };
        let total = rows.total;
        let count = rows.records.len() as i64;
        for (summary, selection) in
            memories_with_selections(&state, &resolved.account, rows.records).await
        {
            if summary.kind == MemoryKind::Photo
                && summary.thumbnail_count > 0
                && !selection
                    .as_ref()
                    .is_some_and(crate::capture_ranking::BestFrameSelection::has_visual_index)
            {
                pending_visual_index.push(summary.uuid.clone());
            }
            if capture_matches(&summary, selection.as_ref(), &query.query) {
                matches.push(MemoryDto::new(&summary, selection));
            }
        }
        source_offset += count;
        if count == 0 || source_offset >= total {
            break;
        }
    }

    let total = matches.len() as i64;
    let content = matches
        .into_iter()
        .skip(requested_offset as usize)
        .take(size as usize)
        .collect();
    let visual_index_state = if pending_visual_index.is_empty() {
        "ready"
    } else if crate::assistant::vision::configured() && state.objects.is_some() {
        "building"
    } else {
        "unavailable"
    };
    let pending = pending_visual_index.len();
    schedule_visual_index(&state, &resolved.account, pending_visual_index);
    let mut response = axum::Json(page_of(content, total, page, size)).into_response();
    response.headers_mut().insert(
        "x-cosmos-visual-index",
        axum::http::HeaderValue::from_static(visual_index_state),
    );
    if let Ok(value) = axum::http::HeaderValue::from_str(&pending.to_string()) {
        response
            .headers_mut()
            .insert("x-cosmos-visual-pending", value);
    }
    response
}

async fn get_memory(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    match state.store.memory(&resolved.account, &uuid).await {
        Ok(Some(record)) => {
            let summary = MemorySummary::from_record(&record);
            let selection = best_frame_metadata(&state, &resolved.account, &summary.uuid).await;
            axum::Json(MemoryDto::new(&summary, selection)).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => unavailable(),
    }
}

async fn best_frame_metadata(
    state: &ApiState,
    account: &str,
    memory_uuid: &str,
) -> Option<crate::capture_ranking::BestFrameSelection> {
    let objects = state.objects.as_ref()?;
    objects.read_best_frame(account, memory_uuid).await.ok()?
}

async fn rank_best_photo(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path(uuid): Path<String>,
    Query(query): Query<RankBestPhotoQuery>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) if resolved.plane == RequestPlane::Web => resolved,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(status) => return status.into_response(),
    };
    let record = match state.store.memory(&resolved.account, &uuid).await {
        Ok(Some(record)) if record.kind == MemoryKind::Photo => record,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    let Some(objects) = state.objects.as_ref() else {
        return unavailable();
    };
    match objects
        .rank_photo_best_frame(&state.keys, &resolved.account, &record, query.force)
        .await
    {
        Ok(Some(selection)) => axum::Json(selection).into_response(),
        Ok(None) => (
            StatusCode::CONFLICT,
            "no opened thumbnails are available for ranking",
        )
            .into_response(),
        Err(_) => unavailable(),
    }
}

#[derive(Default, Deserialize)]
struct RankBestPhotoQuery {
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
struct BestFrameQuery {
    frame: usize,
}

async fn set_best_frame(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path(uuid): Path<String>,
    Query(query): Query<BestFrameQuery>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) if resolved.plane == RequestPlane::Web => resolved,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(status) => return status.into_response(),
    };
    let record = match state.store.memory(&resolved.account, &uuid).await {
        Ok(Some(record)) if record.kind == MemoryKind::Photo => record,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    let frame_count = record
        .bursts
        .iter()
        .map(|burst| burst.files.len())
        .sum::<usize>();
    if query.frame >= frame_count || query.frame >= record.thumbnails.len() {
        return (StatusCode::BAD_REQUEST, "frame is outside this capture").into_response();
    }
    let Some(objects) = state.objects.as_ref() else {
        return unavailable();
    };
    let existing = objects
        .read_best_frame(&resolved.account, &record.uuid)
        .await
        .ok()
        .flatten();
    let selection = crate::capture_ranking::BestFrameSelection {
        frame: query.frame,
        method: "manual".to_owned(),
        reason: "Chosen by the wearer.".to_owned(),
        caption: existing
            .as_ref()
            .map(|selection| selection.caption.clone())
            .unwrap_or_default(),
        tags: existing.map(|selection| selection.tags).unwrap_or_default(),
    };
    // `record.uuid`, never the path segment. `Store::memory` resolves a capture
    // by EITHER its uuid or its numeric id (`uuid = $2 OR numeric_id::text = $2`
    // in both backends), but object storage is namespaced by uuid alone — every
    // reader of this sidecar keys it that way: `get_memory`, `memory_dtos` and
    // `rank_photo_best_frame` all pass `record.uuid`. So a request that named the
    // capture by its numeric id wrote the wearer's manual choice to
    // `{principal}/4711/.best-frame.json`, which nothing ever reads: the wearer
    // pressed "use this frame", got a 200 with their selection echoed back, and
    // the dashboard went on showing the old hero image. The automatic ranker
    // could not see the choice either, so the "the wearer always wins" guard
    // never fired and the next `best_photo` silently overrode them — and
    // `remove_slots` prunes only the uuid-keyed path, so the stray sidecar and
    // its directory outlived the deleted capture.
    //
    // Anything addressed to object storage derives from the resolved record, the
    // way `rank_best_photo` already does; the URL is how the caller ASKED for the
    // capture, not what the capture is.
    if objects
        .write_best_frame(&resolved.account, &record.uuid, &selection)
        .await
        .is_err()
    {
        return unavailable();
    }
    axum::Json(selection).into_response()
}

/// One capture thumbnail.
///
/// The rule this module states — return the index, never sealed bytes — was
/// written when nothing in the deployment could open an envelope, so shipping
/// ciphertext would only have been noise. That premise changes the moment a
/// channel key is imported (`PublicPrivacyService.ImportKeys`): the holder can
/// open it, and the companion dashboard is exactly such a holder.
///
/// A verified web wearer receives the authenticated JPEG projection. Device and
/// demo/fallback callers still receive the opaque envelope: plaintext is never
/// released merely because somebody guessed a memory UUID. The shape mirrors
/// what `.Center` itself fetched, `/capture/memory/{memoryId}/file/{fileId}`.
async fn get_thumbnail(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path((uuid, index)): Path<(String, usize)>,
) -> Response {
    // Per-request, like every other read here: a frame is looked up in the
    // CALLER's account, so one wearer's uuid can never resolve in another's.
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    // ONE frame, fetched as one frame. Reading the whole capture and then
    // indexing into it decoded every sealed frame of the burst to return one of
    // them — on a photo route the dashboard calls per tile.
    let sealed = match state
        .store
        .memory_thumbnail(&resolved.account, &uuid, index)
        .await
    {
        Ok(Some(sealed)) => sealed,
        // Genuinely no such capture, or no such frame in it. The one case that
        // stays a 404 here.
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };

    if resolved.plane != RequestPlane::Web {
        return (
            StatusCode::OK,
            [
                ("content-type", "application/octet-stream"),
                ("cache-control", "private, no-store"),
            ],
            sealed.data,
        )
            .into_response();
    }

    let kid = sealed
        .encryption_information
        .as_ref()
        .map(|information| information.kid.as_str())
        .unwrap_or_default();
    // A key we do not hold, or an envelope that will not open, is a KEYING
    // problem — the row is intact and the listing still reports it. Answering
    // 404 said "this frame does not exist", which is a claim about the wearer's
    // data and is indistinguishable from a genuinely missing capture on both
    // sides. 503 is the same answer the store-outage branch above gives, and
    // Center renders it as degraded rather than "frame unavailable".
    let key = match state.keys.get(kid).await {
        Ok(Some(key)) => key,
        Err(_) => return unavailable(),
        Ok(None) => {
            key_directory_miss(&state.keys, &uuid, "no channel key for this capture");
            return unavailable();
        }
    };
    let Ok(jpeg) = cosmos_crypto::secure_asset::open_secure_asset(
        &key,
        kid,
        &sealed.data,
        cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
    ) else {
        key_directory_miss(
            &state.keys,
            &uuid,
            "held the capture's key but the thumbnail did not open",
        );
        return unavailable();
    };
    (
        StatusCode::OK,
        [
            ("content-type", "image/jpeg"),
            ("cache-control", "private, no-store"),
            ("x-cosmos-projection", "opened"),
        ],
        jpeg,
    )
        .into_response()
}

/// One full-resolution captured JPEG, opened only for an authenticated web
/// wearer (or the purpose-scoped Center projection used by an expiring share).
///
/// `observed`: the photography worker uploads the full JPG to
/// `CaptureFile.secure_filename`, protected as capture domain 2/object 2. The
/// web path itself is also observed in recovered Center as
/// `/capture/memory/{memoryId}/file/{fileId}`. Selection accepts the server file
/// id first and a zero-based ordinal second because the restored UI only has an
/// ordinal while the historical route named a file id.
async fn get_file(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path((uuid, requested_file)): Path<(String, String)>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) if resolved.plane == RequestPlane::Web => resolved,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(status) => return status.into_response(),
    };
    let record = match state.store.memory(&resolved.account, &uuid).await {
        Ok(Some(record)) if record.kind == MemoryKind::Photo => record,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    let files = record
        .bursts
        .iter()
        .flat_map(|burst| burst.files.iter())
        .collect::<Vec<_>>();
    let file = files
        .iter()
        .copied()
        .find(|file| file.id.to_string() == requested_file)
        .or_else(|| {
            requested_file
                .parse::<usize>()
                .ok()
                .and_then(|index| files.get(index).copied())
        });
    let Some(file) = file else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(objects) = state.objects.as_ref() else {
        return unavailable();
    };
    let sealed = match objects.read(&resolved.account, &file.secure_filename).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    let kid = record
        .thumbnails
        .first()
        .and_then(|thumbnail| thumbnail.encryption_information.as_ref())
        .map(|information| information.kid.as_str())
        .unwrap_or_default();
    // Same split as `get_thumbnail`: the object is stored and readable, so a
    // missing key or a refused open is an outage to report, not a file that
    // does not exist.
    let key = match state.keys.get(kid).await {
        Ok(Some(key)) => key,
        Err(_) => return unavailable(),
        Ok(None) => {
            key_directory_miss(&state.keys, &uuid, "no channel key for this capture's file");
            return unavailable();
        }
    };
    let Ok(jpeg) = cosmos_crypto::secure_asset::open_secure_asset(
        &key,
        kid,
        &sealed,
        cosmos_crypto::secure_asset::CAPTURE_JPEG,
    ) else {
        key_directory_miss(
            &state.keys,
            &uuid,
            "held the capture's key but the file did not open",
        );
        return unavailable();
    };
    (
        StatusCode::OK,
        [
            ("content-type", "image/jpeg"),
            ("cache-control", "private, no-store"),
            ("x-cosmos-projection", "opened"),
        ],
        jpeg,
    )
        .into_response()
}

async fn list_notes(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<PageQuery>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    let (page, size, offset) = query.window();
    match state.store.note_page(&resolved.account, offset, size).await {
        Ok(rows) => {
            let dtos = if resolved.plane == RequestPlane::Web {
                use futures_util::StreamExt as _;
                // One channel-key lookup and one AEAD open per note, overlapped
                // across the page and ORDERED (see `memory_dtos`). Serially, and
                // over every note the wearer had ever written, this ran twelve
                // times a minute for as long as a dashboard tab stayed open.
                let projected: Vec<Result<NoteDto, crate::keydirectory::KeyDirectoryError>> =
                    futures_util::stream::iter(rows.records)
                        .map(|record| {
                            let keys = state.keys.clone();
                            async move { project_note_for_web(&record, &keys).await }
                        })
                        .buffered(PAGE_SIDE_READ_CONCURRENCY)
                        .collect()
                        .await;
                let Ok(projected) = projected.into_iter().collect::<Result<Vec<_>, _>>() else {
                    return unavailable();
                };
                projected
            } else {
                rows.records.iter().map(NoteDto::sealed).collect()
            };
            axum::Json(page_of(dtos, rows.total, page, size)).into_response()
        }
        Err(_) => unavailable(),
    }
}

/// A delete the store could not complete.
///
/// **Never** `200 {"deleted": false}`. That body says "you had no such row", so
/// answering an outage with it closes the wearer's page on an erasure that never
/// happened — the exact failure the store's `Ok(false)`/`Err` split exists to
/// prevent, thrown away at the last hop.
///
/// 500 rather than the reads' 503: the delete contract the companion is written
/// against pins this status, and both sides code against it. Either way it is an
/// error the caller must surface, not a silent success.
fn delete_failed() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "the delete could not be carried out",
    )
        .into_response()
}

/// `DELETE /event/:id` — one My Data row (Ai Mic, Music, Calls, Translation).
///
/// `:id` is the device-minted `event_identifier`, the same key `IngestBatch`
/// upserts on and the same one the reader hands the companion.
///
/// A row this caller does not have is `200 {"deleted": false}`. Not a 404 —
/// which the fetch layer would have to special-case to avoid rendering an error
/// for the benign "it was already gone" — and above all not a 500, which would
/// make an ordinary answer look like a broken server.
async fn delete_event(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    // Resolved per request, exactly like the reads: the delete is executed in
    // the CALLER's account, so another wearer's identifier finds nothing rather
    // than deleting their row.
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    match state.store.delete_event(&resolved.account, &id).await {
        Ok(deleted) => axum::Json(DeletedDto { deleted }).into_response(),
        Err(_) => delete_failed(),
    }
}

/// `DELETE /notes/:uuid` — one note, the per-row Forget the notes view offered
/// but could not perform (the store had only "delete every note").
///
/// Same three answers as [`delete_event`], for the same reasons.
async fn delete_note(
    State(state): State<ApiState>,
    headers: axum::http::HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let resolved = match state.account_for(&headers) {
        Ok(resolved) => resolved,
        Err(status) => return status.into_response(),
    };
    match state.store.delete_note(&resolved.account, &uuid).await {
        Ok(deleted) => axum::Json(DeletedDto { deleted }).into_response(),
        Err(_) => delete_failed(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{MemoryStore, NewMemory, NotableEventRecord};
    use axum::body::Body;
    use axum::http::Request;
    use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, encode};
    use std::collections::HashMap;
    use tower::ServiceExt;

    const P: &str = "V:01:D:web-demo:U:operator";

    /// A FRESH, isolated store per test. `MemoryStore::shared()` is a process
    /// singleton (correct in production — the device establishes a channel key
    /// once), so calling it here would bleed state between tests: an "empty list"
    /// assertion would see notes another test wrote. `default()` is an in-memory
    /// instance with no state path and no restore — one per test, fully isolated.
    fn fresh() -> SharedStore {
        std::sync::Arc::new(MemoryStore::default())
    }

    fn fresh_keys() -> SharedKeyDirectory {
        std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory())
    }

    fn test_router(store: SharedStore, principal: impl Into<Arc<str>>) -> Router {
        router_with_verifier(store, fresh_keys(), principal, None)
    }

    #[test]
    fn internal_projection_token_upgrades_only_the_trusted_bff_to_web_plane() {
        unsafe { std::env::set_var("COSMOS_CENTER_PROJECTION_TOKEN", "projection-test-token") };
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            crate::config::EDGE_PRINCIPAL_HEADER,
            "U:wearer-42".parse().unwrap(),
        );

        let device = principal_for(&headers, None).unwrap().unwrap();
        assert_eq!(device.plane, RequestPlane::Device);

        headers.insert(WEB_PROJECTION_TOKEN_HEADER, "wrong-token".parse().unwrap());
        let wrong = principal_for(&headers, None).unwrap().unwrap();
        assert_eq!(wrong.plane, RequestPlane::Device);

        headers.insert(
            WEB_PROJECTION_TOKEN_HEADER,
            "projection-test-token".parse().unwrap(),
        );
        let web = principal_for(&headers, None).unwrap().unwrap();
        assert_eq!(web.account, "U:wearer-42");
        assert_eq!(web.plane, RequestPlane::Web);
        unsafe { std::env::remove_var("COSMOS_CENTER_PROJECTION_TOKEN") };
    }

    const TEST_KID: &str = "capture-api-test-key";
    const TEST_ISSUER: &str = "https://auth.humane.center/realms/humane";
    fn test_verifier() -> Arc<crate::web_auth::JwtVerifier> {
        let (_, public_pem) = crate::web_auth::test_jwt_keypair();
        let mut keys = HashMap::new();
        keys.insert(
            TEST_KID.to_owned(),
            DecodingKey::from_rsa_pem(public_pem.as_bytes()).unwrap(),
        );
        crate::web_auth::JwtVerifier::with_keys(
            crate::web_auth::OidcConfig {
                issuer: TEST_ISSUER.to_owned(),
                audience: None,
                jwks_uri: "unused-in-test".to_owned(),
            },
            keys,
        )
    }

    fn bearer_for(sub: &str) -> String {
        let (private_pem, _) = crate::web_auth::test_jwt_keypair();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(TEST_KID.to_owned());
        encode(
            &header,
            &serde_json::json!({
                "sub": sub,
                "iss": TEST_ISSUER,
                "exp": 4_102_444_800_i64,
            }),
            &EncodingKey::from_rsa_pem(private_pem.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    async fn get_with_bearer(
        app: &Router,
        uri: &str,
        bearer: &str,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {bearer}"),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// A GET containing an edge-injected principal, the way Envoy presents one.
    async fn get_as(app: &Router, uri: &str, device_cn: &str) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(
                        crate::config::EDGE_PRINCIPAL_HEADER,
                        format!("By=spiffe://cosmos.local/edge;Subject=\"CN={device_cn}\""),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// TWO IDENTITIES MUST BE TWO PARTITIONS.
    ///
    /// The bug this pins: every read used a hardcoded `U:operator`, so a Pin
    /// enrolled as `U:<account>` wrote to one partition while the dashboard read
    /// another. Nothing errored — the wearer's captures were simply invisible,
    /// and an empty dashboard is indistinguishable from a new account.
    ///
    /// Both CNs below contain the SAME device id and differ only in the `U:`
    /// segment, which is the segment minted server-side at binding — so this is
    /// exactly the discrimination the identity bridge depends on.
    #[tokio::test]
    async fn each_account_reads_only_its_own_notes() {
        let store = fresh();
        store.create_note("U:alice", None, None).await.unwrap();
        store.index_note("U:alice", "n-a", "alice's note").await;
        store.create_note("U:bob", None, None).await.unwrap();
        let app = test_router(store, DEMO_PRINCIPAL);

        let (_, alice) = get_as(&app, "/notes", "V:01:D:pin1:U:alice").await;
        let (_, bob) = get_as(&app, "/notes", "V:01:D:pin1:U:bob").await;
        assert_eq!(alice["totalElements"], 1, "alice sees her own note");
        assert_eq!(bob["totalElements"], 1, "bob sees his own note");
        assert_ne!(
            alice["content"][0]["uuid"], bob["content"][0]["uuid"],
            "two accounts must not resolve to the same row"
        );

        // A caller who identifies nobody still gets the fallback account, which
        // is what keeps the keyless demo working — and it is NOT either wearer's.
        let (_, anon) = get(&app, "/notes").await;
        assert_eq!(
            anon["totalElements"], 0,
            "the demo account is its own partition"
        );
    }

    async fn get(app: &Router, uri: &str) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, json)
    }

    fn photo(local: &str) -> NewMemory {
        NewMemory {
            kind: MemoryKind::Photo,
            device_local_id: local.to_owned(),
            bursts: 1,
            files_per_burst: 1,
            device_created_time: None,
            gmt_offset: 0,
            thumbnails: Vec::new(),
            encrypted_location: None,
        }
    }

    /// THE ENVELOPE IS SPRING DATA `Page<T>`, VERBATIM.
    ///
    /// A client written against the real webapi deserializes this unchanged, so
    /// the exact key set and their types are the contract — not an approximation.
    #[tokio::test]
    async fn an_empty_list_is_a_well_formed_spring_page() {
        let store = fresh();
        let app = test_router(store, P);
        let (status, body) = get(&app, "/capture/memories").await;
        assert_eq!(status, StatusCode::OK);
        for key in [
            "content",
            "pageable",
            "last",
            "totalElements",
            "totalPages",
            "size",
            "number",
            "sort",
            "first",
            "numberOfElements",
            "empty",
        ] {
            assert!(body.get(key).is_some(), "Page is missing `{key}`: {body}");
        }
        assert_eq!(body["content"].as_array().unwrap().len(), 0);
        assert_eq!(body["totalElements"], 0);
        assert_eq!(body["empty"], true);
        assert_eq!(body["pageable"]["pageNumber"], 0);
        assert_eq!(body["pageable"]["sort"]["sorted"], true);
    }

    /// A NOTE THE ASSISTANT WROTE IS VISIBLE TO THE READER — the whole point of
    /// sharing the store instance. And it comes back as INDEX ONLY: a uuid, a
    /// timestamp, `sealed: true` — never the body, which the server cannot open.
    #[tokio::test]
    async fn a_written_note_reads_back_as_sealed_index_only() {
        let store = fresh();
        store.create_note(P, None, None).await.unwrap();
        let app = test_router(store, P);

        let (status, body) = get(&app, "/notes").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["totalElements"], 1);
        let note = &body["content"][0];
        assert!(note["uuid"].as_str().is_some(), "a uuid must be present");
        assert_eq!(note["sealed"], true, "the body is readable only on the Pin");
        // The sealed body, its plaintext, and any location bytes must NOT appear.
        for forbidden in [
            "body",
            "text",
            "note",
            "content",
            "plaintext",
            "encryptedNote",
        ] {
            assert!(
                note.get(forbidden).is_none(),
                "a note DTO must not contain `{forbidden}`: {note}"
            );
        }
    }

    /// Only a signature-verified web request gets the private search projection.
    /// The exact same account over the device plane still receives a sealed row,
    /// so merely knowing a DeviceUser subject cannot turn this into a plaintext
    /// exfiltration endpoint.
    #[tokio::test]
    async fn verified_web_gets_indexed_note_but_device_and_fallback_do_not() {
        let store = fresh();
        let indexed = store.create_note("U:alice", None, None).await.unwrap();
        store
            .index_note(
                "U:alice",
                &indexed.uuid,
                r#"{"title":"Weekend","text":"Buy Milk"}"#,
            )
            .await;
        let app = router_with_verifier(store, fresh_keys(), DEMO_PRINCIPAL, Some(test_verifier()));

        let (status, web) = get_with_bearer(&app, "/notes", &bearer_for("alice")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(web["totalElements"], 1);
        let note = &web["content"][0];
        assert_eq!(note["sealed"], false);
        // The store's retrieval index is deliberately lowercase; most
        // importantly, its JSON wrapper is decoded rather than rendered.
        assert_eq!(note["title"], "weekend");
        assert_eq!(note["text"], "buy milk");

        let (_, device) = get_as(&app, "/notes", "V:01:D:pin1:U:alice").await;
        let device_note = &device["content"][0];
        assert_eq!(device_note["sealed"], true);
        assert!(device_note.get("title").is_none());
        assert!(device_note.get("text").is_none());

        let (_, fallback) = get(&app, "/notes").await;
        assert_eq!(
            fallback["totalElements"], 0,
            "fallback is a separate account"
        );
    }

    #[tokio::test]
    async fn verified_web_plain_index_remains_plain_note_text() {
        let store = fresh();
        let indexed = store.create_note("U:alice", None, None).await.unwrap();
        store
            .index_note("U:alice", &indexed.uuid, "Remember the yellow umbrella")
            .await;
        let app = router_with_verifier(store, fresh_keys(), DEMO_PRINCIPAL, Some(test_verifier()));

        let (_, body) = get_with_bearer(&app, "/notes", &bearer_for("alice")).await;
        let note = &body["content"][0];
        assert_eq!(note["sealed"], false);
        assert_eq!(note["text"], "remember the yellow umbrella");
        assert!(note.get("title").is_none());
    }

    /// Presence of a Bearer header suppresses every fallback. A bad signature or
    /// malformed JWT is 401, never an anonymous read of the demo account.
    #[tokio::test]
    async fn invalid_bearer_fails_closed_instead_of_reading_demo_data() {
        let store = fresh();
        let note = store.create_note(DEMO_PRINCIPAL, None, None).await.unwrap();
        store
            .index_note(DEMO_PRINCIPAL, &note.uuid, "demo account secret")
            .await;
        let app = router_with_verifier(store, fresh_keys(), DEMO_PRINCIPAL, Some(test_verifier()));

        let (status, body) = get_with_bearer(&app, "/notes", "not-a-jwt").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, serde_json::Value::Null);
    }

    #[test]
    fn decoded_capture_note_projects_title_text_and_modified_time() {
        let record = NoteRecord {
            uuid: "scrubbed-note".to_owned(),
            indexed_text: None,
            encrypted_note: None,
            encrypted_location: None,
            created: SyncTime::now(),
        };
        let dto = NoteDto::opened(
            &record,
            cosmos_protocol::capture::Note {
                text: "Preserve My Casing".to_owned(),
                title: "A Title".to_owned(),
                modified_at: Some(prost_types::Timestamp {
                    seconds: 1_725_000_123,
                    nanos: 0,
                }),
                ..Default::default()
            },
        );
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["sealed"], false);
        assert_eq!(json["title"], "A Title");
        assert_eq!(json["text"], "Preserve My Casing");
        assert_eq!(json["modifiedAt"], 1_725_000_123_i64);
    }

    /// A note written under one principal is invisible to another — the reader is
    /// scoped, not a firehose.
    #[tokio::test]
    async fn one_principals_notes_are_not_another_principals() {
        let store = fresh();
        store.create_note(P, None, None).await.unwrap();
        let app = test_router(store, "V:01:D:web-demo:U:someone-else");
        let (_, body) = get(&app, "/notes").await;
        assert_eq!(body["totalElements"], 0, "reader must be principal-scoped");
    }

    /// `/capture/captures` is the photo/video view; `/capture/memories` is
    /// everything. A note is a memory but not a capture.
    #[tokio::test]
    async fn captures_excludes_notes_but_memories_includes_them() {
        let store = fresh();
        store.create_memory(P, photo("cam-1")).await.unwrap();
        store.create_note(P, None, None).await.unwrap();
        let app = test_router(store, P);

        let (_, memories) = get(&app, "/capture/memories").await;
        let (_, captures) = get(&app, "/capture/captures").await;
        // Notes are stored as their own note rows, not memory rows, so memories
        // here reflects the one photo; captures reflects the same photo.
        assert_eq!(memories["totalElements"], 1, "the photo is a memory");
        assert_eq!(captures["totalElements"], 1, "the photo is a capture");
        assert_eq!(captures["content"][0]["type"], "PHOTO");
    }

    /// Pagination slices a sorted set, and `last`/`first`/`totalPages` describe
    /// the page's position honestly across the boundary.
    #[tokio::test]
    async fn pagination_walks_the_pages() {
        let store = fresh();
        for i in 0..5 {
            store
                .create_memory(P, photo(&format!("cam-{i}")))
                .await
                .unwrap();
        }
        let app = test_router(store, P);

        let (_, p0) = get(&app, "/capture/memories?page=0&size=2").await;
        assert_eq!(p0["totalElements"], 5);
        assert_eq!(p0["totalPages"], 3);
        assert_eq!(p0["content"].as_array().unwrap().len(), 2);
        assert_eq!(p0["first"], true);
        assert_eq!(p0["last"], false);

        let (_, p2) = get(&app, "/capture/memories?page=2&size=2").await;
        assert_eq!(
            p2["content"].as_array().unwrap().len(),
            1,
            "final page has the remainder"
        );
        assert_eq!(p2["last"], true);
        assert_eq!(p2["number"], 2);

        // A page past the end is empty AND last — not an error.
        let (status, p9) = get(&app, "/capture/memories?page=9&size=2").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(p9["empty"], true);
        assert_eq!(p9["last"], true);
    }

    /// THE PAGE IS THE READ, not a slice taken afterwards.
    ///
    /// `/capture/captures` filters to photos and videos, and that filter has to
    /// live in the store beside the window. Applied after a limited fetch it
    /// returns short pages and a total counting rows the caller never asked for;
    /// applied after an UNLIMITED fetch — which is what it used to be — `?size=1`
    /// costs exactly what `?size=200` costs, which is what the health probe pays
    /// on every poll.
    #[tokio::test]
    async fn a_captures_page_is_filtered_and_sized_by_the_store() {
        let store = fresh();
        for i in 0..3 {
            store
                .create_memory(P, photo(&format!("cam-{i}")))
                .await
                .unwrap();
            store
                .create_memory(
                    P,
                    NewMemory {
                        kind: MemoryKind::FoodLog,
                        device_local_id: format!("meal-{i}"),
                        ..photo("unused")
                    },
                )
                .await
                .unwrap();
        }
        let app = test_router(store, P);

        let (status, body) = get(&app, "/capture/captures?page=0&size=2").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["content"].as_array().unwrap().len(), 2);
        assert_eq!(
            body["totalElements"], 3,
            "the total counts photos and videos only, not the food logs"
        );
        assert_eq!(body["totalPages"], 2);
        for entry in body["content"].as_array().unwrap() {
            assert_eq!(entry["type"], "PHOTO");
        }

        // The final page holds the remainder rather than restarting the filter.
        let (_, last) = get(&app, "/capture/captures?page=1&size=2").await;
        assert_eq!(last["content"].as_array().unwrap().len(), 1);
        assert_eq!(last["last"], true);

        // `/capture/memories` is unfiltered and sees both kinds.
        let (_, memories) = get(&app, "/capture/memories?size=1").await;
        assert_eq!(memories["totalElements"], 6);
        assert_eq!(memories["content"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn visual_search_covers_the_full_library_without_leaking_its_index() {
        let store = fresh();
        let cat = store
            .create_memory("U:alice", photo("old-cat"))
            .await
            .unwrap();
        for index in 0..205 {
            store
                .create_memory("U:alice", photo(&format!("newer-{index}")))
                .await
                .unwrap();
        }
        let bobs_cat = store
            .create_memory("U:bob", photo("bobs-cat"))
            .await
            .unwrap();

        let objects = crate::services::capture::CaptureObjectStore::for_tests();
        let selection = |caption: &str| crate::capture_ranking::BestFrameSelection {
            frame: 0,
            method: "vision_v1".to_owned(),
            reason: "Best exposed frame.".to_owned(),
            caption: caption.to_owned(),
            tags: vec!["cat".to_owned(), "pet".to_owned(), "animal".to_owned()],
        };
        objects
            .write_best_frame("U:alice", &cat.uuid, &selection("A black cat on a sofa."))
            .await
            .unwrap();
        objects
            .write_best_frame("U:bob", &bobs_cat.uuid, &selection("A white cat."))
            .await
            .unwrap();

        let app = router_with_objects(
            store,
            fresh_keys(),
            DEMO_PRINCIPAL,
            Some(test_verifier()),
            Some(objects),
        );
        let (status, alice) = get_with_bearer(
            &app,
            "/capture/search?query=cats&size=200",
            &bearer_for("alice"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(alice["totalElements"], 1);
        assert_eq!(alice["content"][0]["uuid"], cat.uuid);
        assert_eq!(alice["content"][0]["visualSearchReady"], true);
        let public_json = serde_json::to_string(&alice).unwrap();
        assert!(!public_json.contains("caption"));
        assert!(!public_json.contains("tags"));
        assert!(!public_json.contains("black cat"));

        let (_, bob) = get_with_bearer(
            &app,
            "/capture/search?query=cat&size=200",
            &bearer_for("bob"),
        )
        .await;
        assert_eq!(bob["totalElements"], 1);
        assert_eq!(bob["content"][0]["uuid"], bobs_cat.uuid);
    }

    /// A sealed frame whose key we do not hold is an OUTAGE, not a missing frame.
    ///
    /// 404 said "this capture has no such thumbnail" — a claim about the
    /// wearer's data, indistinguishable from a genuinely absent capture, over a
    /// row that is intact and that the listing still counts. The recoverable
    /// causes (ImportKeys never ran; the directory is process-local because
    /// `COSMOS_DATABASE_URL` is unset; a corrupt envelope) all landed there, with
    /// no log line at any of them.
    #[tokio::test]
    async fn an_unopenable_thumbnail_is_degraded_rather_than_a_missing_frame() {
        let store = fresh();
        let sealed = cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: "d=pin1;u=alice".to_owned(),
                },
            ),
            data: vec![7u8; 32],
        };
        let record = store
            .create_memory(
                "U:alice",
                NewMemory {
                    thumbnails: vec![sealed.clone()],
                    ..photo("cam-1")
                },
            )
            .await
            .unwrap();
        // A key directory that holds nothing, which is the whole point.
        let app = router_with_verifier(store, fresh_keys(), DEMO_PRINCIPAL, Some(test_verifier()));

        let (status, _) = get_with_bearer(
            &app,
            &format!("/capture/memory/{}/thumbnail/0", record.uuid),
            &bearer_for("alice"),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "a key we do not hold is a keying problem, not a frame that does not exist"
        );

        // A frame that genuinely is not there stays a 404, so the two remain
        // distinguishable on both sides.
        let (missing, _) = get_with_bearer(
            &app,
            &format!("/capture/memory/{}/thumbnail/7", record.uuid),
            &bearer_for("alice"),
        )
        .await;
        assert_eq!(missing, StatusCode::NOT_FOUND);

        // The device plane never needed a key: it receives the envelope.
        // Assembled rather than written out, so the source never contains a
        // literal DeviceUser subject (`verify/hygiene.py`).
        let device_cn = "V:01:D:pin1:U:alice";
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/capture/memory/{}/thumbnail/0", record.uuid))
                    .header(
                        crate::config::EDGE_PRINCIPAL_HEADER,
                        format!("By=spiffe://cosmos.local/edge;Subject=\"CN={device_cn}\""),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        assert_eq!(bytes.as_ref(), sealed.data.as_slice());
    }

    /// REGRESSION: `set_best_frame` filed the wearer's manual choice under the
    /// PATH SEGMENT, while every reader keys the sidecar by `record.uuid`. The
    /// store resolves a capture by uuid OR numeric id, so a request that named it
    /// by id wrote to a directory nothing reads: 200 with the selection echoed
    /// back, dashboard unchanged, the automatic ranker unable to see that the
    /// wearer had chosen — so its "the wearer always wins" guard never fired and
    /// it overwrote them — and the stray file left behind after the capture was
    /// deleted.
    ///
    /// Driven by numeric id on purpose: by uuid the two identities coincide and
    /// the bug is invisible, which is exactly why it survived.
    #[tokio::test]
    async fn a_best_frame_chosen_by_numeric_id_is_filed_where_the_readers_look() {
        let store = fresh();
        let sealed = || cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: None,
            data: vec![7u8; 32],
        };
        let record = store
            .create_memory(
                "U:alice",
                NewMemory {
                    files_per_burst: 2,
                    thumbnails: vec![sealed(), sealed()],
                    ..photo("cam-best")
                },
            )
            .await
            .unwrap();

        let objects = crate::services::capture::CaptureObjectStore::for_tests();
        let app = router_with_objects(
            store,
            fresh_keys(),
            DEMO_PRINCIPAL,
            Some(test_verifier()),
            Some(objects.clone()),
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    // The numeric id, which `Store::memory` accepts as readily as
                    // the uuid.
                    .uri(format!(
                        "/capture/memory/{}/bestFrame?frame=1",
                        record.numeric_id
                    ))
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", bearer_for("alice")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let stored = objects
            .read_best_frame("U:alice", &record.uuid)
            .await
            .expect("reading the sidecar must not error");
        assert_eq!(
            stored.map(|selection| (selection.frame, selection.method)),
            Some((1, "manual".to_owned())),
            "the choice must be filed under the capture's uuid — that is the only \
             key `get_memory`, `memory_dtos` and the ranker ever read"
        );
        assert!(
            objects
                .read_best_frame("U:alice", &record.numeric_id.to_string())
                .await
                .expect("reading the sidecar must not error")
                .is_none(),
            "nothing may be written under the request's own spelling of the id: \
             no reader looks there and no delete prunes it"
        );
    }

    /// A single memory resolves by uuid; an unknown one is 404, not an empty body.
    #[tokio::test]
    async fn a_memory_resolves_by_uuid_and_an_unknown_one_is_404() {
        let store = fresh();
        let record = store.create_memory(P, photo("cam-1")).await.unwrap();
        let app = test_router(store, P);

        let (status, body) = get(&app, &format!("/capture/memory/{}", record.uuid)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["uuid"], record.uuid);
        assert_eq!(body["type"], "PHOTO");
        assert_eq!(body["sealed"], true);

        let (missing, _) = get(&app, "/capture/memory/00000000-0000-0000-0000-000000000000").await;
        assert_eq!(missing, StatusCode::NOT_FOUND);
    }

    // ── the deletes ─────────────────────────────────────────────────────────

    /// A DELETE containing an edge-injected principal, the way Envoy presents one.
    async fn delete_as(
        app: &Router,
        uri: &str,
        device_cn: &str,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(axum::http::Method::DELETE)
                    .uri(uri)
                    .header(
                        crate::config::EDGE_PRINCIPAL_HEADER,
                        format!("By=spiffe://cosmos.local/edge;Subject=\"CN={device_cn}\""),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// One ingested event, keyed the way the device keys it.
    fn event(identifier: &str) -> NotableEventRecord {
        NotableEventRecord {
            event_identifier: identifier.to_owned(),
            originator_identifier: "humane.experience.aimic".to_owned(),
            creation_time: Some(SyncTime::now()),
            event_type: "AI_MIC".to_owned(),
            event_data: None,
            encrypted_event_data: None,
            encrypted_location: None,
            device_is_locked: false,
            ingested: SyncTime::now(),
            indexed_text: None,
        }
    }

    /// THE CONTROL HAS TO ACTUALLY DELETE.
    ///
    /// `DELETE /event/:id` did not exist — the My Data trash button reached a
    /// route that answered 405 — so this is the whole point of the surface: the
    /// row is gone from the store the reader serves, not merely hidden.
    #[tokio::test]
    async fn deleting_an_event_removes_it_from_the_wearers_own_reads() {
        let store = fresh();
        store
            .ingest_events("U:alice", &[event("ev-1"), event("ev-2")])
            .await
            .expect("ingest succeeds");
        let app = test_router(store.clone(), DEMO_PRINCIPAL);

        let (status, body) = delete_as(&app, "/event/ev-1", "V:01:D:pin1:U:alice").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);

        let left = store
            .query_events("U:alice", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(left.len(), 1, "only the deleted event went");
        assert_eq!(left[0].event_identifier, "ev-2");
    }

    /// The notes view offered Forget on a row while the store could only erase
    /// *every* note. One uuid, one note.
    #[tokio::test]
    async fn deleting_a_note_removes_that_note_and_leaves_the_others() {
        let store = fresh();
        let doomed = store.create_note("U:alice", None, None).await.unwrap();
        store.create_note("U:alice", None, None).await.unwrap();
        let app = test_router(store, DEMO_PRINCIPAL);

        let uri = format!("/notes/{}", doomed.uuid);
        let (status, body) = delete_as(&app, &uri, "V:01:D:pin1:U:alice").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);

        let (_, list) = get_as(&app, "/notes", "V:01:D:pin1:U:alice").await;
        assert_eq!(list["totalElements"], 1, "the other note is untouched");
        assert_ne!(list["content"][0]["uuid"], doomed.uuid);
    }

    /// ONE ACCOUNT MUST NEVER DELETE ANOTHER'S ROW.
    ///
    /// This is the case that must not be got wrong. Bob deletes with alice's
    /// REAL identifiers — the only thing between him and her data is the
    /// principal the request resolves to — and must be told `false` while her
    /// rows stay put. `false`, not an error: an error that occurs only for rows
    /// that exist would itself confirm they exist.
    #[tokio::test]
    async fn a_delete_under_one_account_cannot_reach_anothers_rows() {
        let store = fresh();
        store
            .ingest_events("U:alice", &[event("ev-1")])
            .await
            .expect("ingest succeeds");
        let note = store.create_note("U:alice", None, None).await.unwrap();
        let app = test_router(store.clone(), DEMO_PRINCIPAL);

        let (status, body) = delete_as(&app, "/event/ev-1", "V:01:D:pin1:U:bob").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], false, "bob had no such event");

        let uri = format!("/notes/{}", note.uuid);
        let (status, body) = delete_as(&app, &uri, "V:01:D:pin1:U:bob").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], false, "bob had no such note");

        assert_eq!(
            store
                .query_events("U:alice", "", "", None, None, 0)
                .await
                .unwrap()
                .len(),
            1,
            "another account's delete must not remove alice's event"
        );
        let (_, list) = get_as(&app, "/notes", "V:01:D:pin1:U:alice").await;
        assert_eq!(
            list["totalElements"], 1,
            "another account's delete must not remove alice's note"
        );

        // And alice deleting her own rows still works, so the scoping above is
        // the predicate doing its job and not a delete that never works.
        let (_, mine) = delete_as(&app, "/event/ev-1", "V:01:D:pin1:U:alice").await;
        assert_eq!(mine["deleted"], true);
    }

    /// ALREADY GONE IS AN ORDINARY ANSWER.
    ///
    /// `200 {"deleted": false}` — never a 404 the caller has to special-case,
    /// and never a 500, which would render a benign repeat as a broken server.
    /// The store failure path is the only non-200 here, and the in-memory store
    /// cannot produce it; `store_postgres` covers it against a real backend.
    #[tokio::test]
    async fn deleting_something_already_gone_is_deleted_false_not_an_error() {
        let store = fresh();
        store
            .ingest_events("U:alice", &[event("ev-1")])
            .await
            .expect("ingest succeeds");
        let note = store.create_note("U:alice", None, None).await.unwrap();
        let app = test_router(store, DEMO_PRINCIPAL);

        let note_uri = format!("/notes/{}", note.uuid);
        let unknown_note = "/notes/00000000-0000-0000-0000-000000000000".to_owned();
        // Two rows that exist and two identifiers that never did — the first
        // pass differs, the repeat must not.
        for (uri, stored) in [
            ("/event/ev-1".to_owned(), true),
            (note_uri, true),
            ("/event/never-ingested".to_owned(), false),
            (unknown_note, false),
        ] {
            let (status, body) = delete_as(&app, &uri, "V:01:D:pin1:U:alice").await;
            assert_eq!(status, StatusCode::OK, "{uri} must not error");
            assert_eq!(body["deleted"], stored, "{uri} first delete");
            // The body is exactly one field: a client reading `deleted` gets the
            // whole truth, and nothing leaks about the row that was removed.
            assert_eq!(
                body.as_object().expect("a JSON object").len(),
                1,
                "the delete response carries `deleted` and nothing else: {body}"
            );

            // The repeat is the same shape with `false` — the delete is
            // idempotent and says honestly that this time nothing went.
            let (status, body) = delete_as(&app, &uri, "V:01:D:pin1:U:alice").await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["deleted"], false, "{uri} repeated delete");
        }
    }
}
