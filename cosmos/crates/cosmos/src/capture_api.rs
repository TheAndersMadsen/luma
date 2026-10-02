//! The web companion's `capture` service, the surface `humane.center`
//! consumed, rebuilt faithfully over Cosmos's own store.
//!
//! ## Why this exists, and what it is not
//!
//! No `CaptureService` gRPC method the *device* calls lists captures, the Pin
//! only ever creates and deletes its own. But a reader is `observed` at the WEB
//! boundary: the recovered `.Center` client (`api-client.js`, module 87044)
//! called `GET /capture/captures` with `page`/`size`/`sort=userCreatedAt,DESC`,
//! and the webapi backend was Spring Boot, so those responses were Spring Data
//! `Page<T>` envelopes (confirmed independently from the `PinSync` client and
//! the leaked `spring.data.repository.invocations` metrics). This module serves
//! that exact shape from [`crate::store::Store::memory_page`], which was
//! authored for precisely this companion-dashboard path, page, size and kind
//! filter pushed into the store, so `?size=1` costs what one row costs.
//!
//! Every other recovered `capture` route lives here too: the pending queue the
//! Pin declares with `DeclareMemoryCreateIntent`, favourites, tags, bulk
//! actions, reindex, originals and derivatives, one file route serving photos
//! and (with `Range`) videos, the share link, and the food log. The one share
//! authority is [`crate::services::capture::ShareAuthority`]: the web button
//! and the Pin's `GetMemoryShareLink` mint the same stock-shaped link, and
//! `GET /share/capture/{uuid}/thumbnail` resolves it for Center's public page.
//!
//! Identity, paging envelopes and the delete contract are shared with the other
//! web surfaces in [`crate::web_api`]. Notes live in `notes_api` and My Data in
//! `notable_api`.
//!
//! ## Honest by construction
//!
//! Capture bodies remain sealed at rest. The capture index never exposes them.
//! Plaintext media is released only to a verified web caller, after the stock
//! capture binding authenticates, or, for one capture's best frame, to the
//! holder of an unexpired share capability.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::{
    Json, Router,
    extract::{FromRef, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};

use crate::services::capture::ShareAuthority;
use crate::store::{MemoryKind, MemoryRecord, MemorySummary, SyncTime, Written};
use crate::web_api::{
    ApiState, DeletedDto, MAX_PAGE_SIZE, PAGE_SIDE_READ_CONCURRENCY, PageQuery, RequestPlane,
    delete_failed, key_directory_miss, page_of, unavailable,
};

/// The capture router's state: the shared web state, plus the share
/// authority the public share read needs. Handlers that need only the web
/// state extract [`ApiState`] from it.
#[derive(Clone)]
struct CaptureApi {
    api: ApiState,
    share: Arc<ShareAuthority>,
}

impl FromRef<CaptureApi> for ApiState {
    fn from_ref(state: &CaptureApi) -> Self {
        state.api.clone()
    }
}

/// Mount the capture routes over the shared web state and this deployment's
/// share authority.
pub(crate) fn router(state: ApiState) -> Router {
    router_with_share(state, ShareAuthority::from_environment())
}

pub(crate) fn router_with_share(state: ApiState, share: ShareAuthority) -> Router {
    Router::new()
        .route("/capture/captures", get(list_captures))
        .route("/capture/captures/list", post(list_named_captures))
        .route("/capture/search", get(search_captures))
        .route(
            "/capture/pending-memory-creates",
            get(list_pending).delete(clear_pending),
        )
        .route("/capture/food-log", get(food_log))
        .route("/capture/memory/bulk-favorite", post(bulk_favorite))
        .route("/capture/memory/bulk-unfavorite", post(bulk_unfavorite))
        .route("/capture/memory/bulk-delete", post(bulk_delete))
        .route(
            "/capture/memory/:uuid",
            get(get_memory).delete(delete_memory),
        )
        .route("/capture/memory/:uuid/favorite", post(favorite))
        .route("/capture/memory/:uuid/unfavorite", post(unfavorite))
        .route("/capture/memory/:uuid/tag", post(add_tag))
        .route("/capture/memory/:uuid/tag/:tag", delete(remove_tag))
        .route("/capture/memory/:uuid/index", post(reindex))
        // `observed` in recovered Center. The original ranking internals are
        // unknown. These routes drive the clone-owned selector documented in
        // `capture_ranking` and never discard an original frame.
        .route("/capture/memory/:uuid/best_photo", post(rank_best_photo))
        .route("/capture/memory/:uuid/bestFrame", post(set_best_frame))
        .route("/capture/memory/:uuid/originals", get(originals))
        .route("/capture/memory/:uuid/derivatives", get(derivatives))
        .route("/capture/memory/:uuid/share-link", post(share_link))
        // Authenticated web projections. Device-plane callers never receive
        // opened durable media from these routes.
        .route("/capture/memory/:uuid/thumbnail/:index", get(get_thumbnail))
        .route("/capture/memory/:uuid/file/:file", get(get_file))
        .route(
            "/capture/memory/:uuid/file/:file/download",
            get(download_file),
        )
        // The public share page's frame, behind a share capability instead of
        // an identity. The edge never publishes it: Center's public
        // `/humane.center/share/capture/{uuid}` page reads it over the
        // internal network.
        .route("/share/capture/:uuid/thumbnail", get(shared_thumbnail))
        .with_state(CaptureApi {
            api: state,
            share: Arc::new(share),
        })
}

/// `/capture/captures` is the photo/video view. Notes and food logs are not
/// "captures".
pub(crate) const CAPTURE_KINDS: &[MemoryKind] = &[MemoryKind::Photo, MemoryKind::Video];

/// Most tags one capture carries, and the longest tag, in characters.
const MAX_TAGS: usize = 32;
const MAX_TAG_CHARS: usize = 64;

// ── DTOs: the capture INDEX, never sealed content ───────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryDto {
    uuid: String,
    id: i64,
    device_local_id: String,
    /// PHOTO | VIDEO | FOODLOG | NOTE, the device's own memory type.
    #[serde(rename = "type")]
    kind: &'static str,
    /// Epoch seconds the device recorded it. The `.Center` client sorted on this.
    user_created_at: Option<i64>,
    /// Epoch seconds the server first stored it.
    created_at: i64,
    upload_complete: bool,
    /// `pending` | `complete` | `failed_final`: where the Pin's upload
    /// stands, as `UploadComplete` reported it. `pending` still shows the
    /// thumbnails `CreateMemory` carried (the Pin's "preview on Center").
    upload_state: &'static str,
    deleted: bool,
    /// How many thumbnails the device sealed, a count, never the bytes.
    thumbnail_count: usize,
    has_location: bool,
    burst_count: usize,
    /// Number of uploaded frame slots in all bursts. Stock photos normally have
    /// one burst with three frames.
    frame_count: usize,
    /// `VideoMemoryRequest.total_video_duration_sec`, for a video.
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_sec: Option<i32>,
    /// Recovered `POST /capture/memory/{uuid}/favorite`.
    favorite: bool,
    /// Recovered `POST /capture/memory/{uuid}/tag`, in the order they were added.
    tags: Vec<String>,
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
    /// [`MemorySummary`] sufficient, and is why reading whole records to fill
    /// it in was pure waste. Listings never load a frame. The single-capture
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
            upload_state: m.upload_state.as_str(),
            // Listings and single reads both select live rows only, so a record
            // that reaches here is never a tombstone.
            deleted: false,
            thumbnail_count: m.thumbnail_count,
            has_location: m.has_location,
            burst_count: m.burst_count,
            frame_count: m.frame_count,
            duration_sec: (m.kind == MemoryKind::Video).then_some(m.total_video_duration_sec),
            favorite: m.favorite,
            tags: m.tags.clone(),
            best_frame_index: selection.as_ref().map(|selection| selection.frame),
            best_frame_method: selection.as_ref().map(|selection| selection.method.clone()),
            best_frame_reason: selection.map(|selection| selection.reason),
            visual_search_ready,
            sealed: true,
        }
    }
}

/// One capture with what `CreateMemory` carried beyond the index: where on
/// the clock it was taken and what the camera recorded. The location stays
/// sealed; `hasLocation` only says one exists.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryDetailDto {
    #[serde(flatten)]
    memory: MemoryDto,
    /// `gmt_offset`: whole hours east of UTC where the capture was taken
    /// (`PhotographyManager` sends `getTotalSeconds() / 3600`).
    gmt_offset_hours: i32,
    /// `PhotoMemoryRequest.format` (`humane.capture.PhotoFileFormat`), for a photo.
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lut_name: Option<String>,
    /// `PhotoMemoryRequest.photo_metadatas`, one per frame the Pin described.
    frames: Vec<FrameDto>,
}

/// The camera facts of one frame (`humane.capture.ImageMetadata`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameDto {
    width: i32,
    height: i32,
    /// `OrientationInfo.horizon_angle`, signed degrees.
    #[serde(skip_serializing_if = "Option::is_none")]
    horizon_angle: Option<i32>,
    /// `ShutterSpeed.exposure_time`, nanoseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    exposure_time_ns: Option<i64>,
    /// `ISO.sensitivity`.
    #[serde(skip_serializing_if = "Option::is_none")]
    iso: Option<i64>,
    luminance: f32,
}

impl MemoryDetailDto {
    fn new(
        record: &MemoryRecord,
        selection: Option<crate::capture_ranking::BestFrameSelection>,
    ) -> Self {
        let metadata = &record.metadata;
        Self {
            memory: MemoryDto::new(&MemorySummary::from_record(record), selection),
            gmt_offset_hours: record.gmt_offset,
            format: (record.kind == MemoryKind::Photo && metadata.format != 0)
                .then(|| cosmos_protocol::capture::PhotoFileFormat::try_from(metadata.format).ok())
                .flatten()
                .map(|format| format.as_str_name()),
            lut_name: Some(metadata.lut_name.clone()).filter(|name| !name.is_empty()),
            frames: metadata
                .photo_metadatas
                .iter()
                .map(|frame| FrameDto {
                    width: frame.resolution_width,
                    height: frame.resolution_height,
                    horizon_angle: frame.orientation_info.as_ref().map(|o| o.horizon_angle),
                    exposure_time_ns: frame.shutter_speed.as_ref().map(|s| s.exposure_time),
                    iso: frame.iso.as_ref().map(|iso| iso.sensitivity),
                    luminance: frame.luminance,
                })
                .collect(),
        }
    }
}

/// One stored file of a capture, as the originals and derivatives listings
/// name it. `fileId` is what `GET /capture/memory/{uuid}/file/{fileId}` takes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureFileDto {
    file_id: String,
    index: usize,
    kind: &'static str,
    content_type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureFilesDto {
    memory_uuid: String,
    files: Vec<CaptureFileDto>,
}

// ── Caller resolution ───────────────────────────────────────────────────────

// ── Handlers ────────────────────────────────────────────────────────────────

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
pub(crate) async fn memory_dtos(
    state: &ApiState,
    account: &str,
    page: Vec<MemorySummary>,
) -> Vec<MemoryDto> {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturesQuery {
    page: Option<i64>,
    size: Option<i64>,
    /// Recovered `onlyContainingFavorited=false`: favourites only when true.
    #[serde(default)]
    only_containing_favorited: bool,
}

async fn list_captures(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<CapturesQuery>,
) -> Response {
    let account = match state.caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let (page, size, offset) = PageQuery {
        page: query.page,
        size: query.size,
    }
    .window();
    // `/capture/captures` was the photo/video view. Notes and food logs are not
    // "captures".
    //
    // Both filters are pushed into the store rather than applied to the page
    // here: selecting photos or favourites out of an already-limited fetch
    // returns short pages and a total that counts rows the caller never asked
    // for.
    match state
        .store
        .memory_page(
            &account,
            CAPTURE_KINDS,
            query.only_containing_favorited,
            offset,
            size,
        )
        .await
    {
        Ok(rows) => {
            let dtos = memory_dtos(&state, &account, rows.records).await;
            Json(page_of(dtos, rows.total, page, size)).into_response()
        }
        Err(_) => unavailable(),
    }
}

/// The recovered `{ memoryUUIDs: [...] }` body of `captures/list` and the
/// bulk routes.
#[derive(Deserialize)]
struct MemoryUuids {
    #[serde(rename = "memoryUUIDs")]
    memory_uuids: Vec<String>,
}

impl MemoryUuids {
    /// The named captures, once each, in the order given. More than one page's
    /// worth is refused: every name costs a store read.
    fn bounded(self) -> Result<Vec<String>, Response> {
        if self.memory_uuids.len() > MAX_PAGE_SIZE as usize {
            return Err((
                StatusCode::BAD_REQUEST,
                "at most 200 captures may be named at once",
            )
                .into_response());
        }
        let mut seen = std::collections::HashSet::new();
        Ok(self
            .memory_uuids
            .into_iter()
            .map(|uuid| uuid.trim().to_owned())
            .filter(|uuid| !uuid.is_empty() && seen.insert(uuid.clone()))
            .collect())
    }
}

/// `POST /capture/captures/list {memoryUUIDs}` (recovered
/// `getWebapiCapturesList`): the named captures the caller holds, in the order
/// asked. A name that is not the caller's is simply absent.
async fn list_named_captures(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<MemoryUuids>,
) -> Response {
    let account = match state.caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let uuids = match body.bounded() {
        Ok(uuids) => uuids,
        Err(response) => return response,
    };
    let mut summaries = Vec::with_capacity(uuids.len());
    for uuid in &uuids {
        match state.store.memory(&account, uuid).await {
            Ok(Some(record)) if CAPTURE_KINDS.contains(&record.kind) => {
                summaries.push(MemorySummary::from_record(&record));
            }
            Ok(_) => {}
            Err(_) => return unavailable(),
        }
    }
    Json(memory_dtos(&state, &account, summaries).await).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSearchQuery {
    query: String,
    page: Option<i64>,
    size: Option<i64>,
    /// Recovered `onlyContainingFavorited=false`: favourites only when true.
    #[serde(default)]
    only_containing_favorited: bool,
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
    // A UUID pasted whole (or a long fragment of one) finds that exact capture.
    // Both ids are UUIDs, so a bare substring match on a short hex term like "a"
    // or "bed" matched most of the library. Only treat the query as an id when
    // it is a long enough run of UUID characters to be specific.
    let looks_like_uuid_fragment =
        literal.len() >= 8 && literal.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if looks_like_uuid_fragment
        && (summary.uuid.to_lowercase().contains(&literal)
            || summary.device_local_id.to_lowercase().contains(&literal))
    {
        return true;
    }
    let mut searchable = vec![kind_str(summary.kind).to_owned()];
    searchable.push(summary.created.seconds().to_string());
    if let Some(created) = summary.device_created_time.as_ref() {
        searchable.push(created.seconds().to_string());
    }
    // The wearer's own tags: a capture tagged "beach" is found by "beach".
    searchable.extend(summary.tags.iter().cloned());
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
///
/// Web plane only, like the note and event searches: which captures match is
/// derived from their private captions, so it is as private as the captions,
/// and a search also starts the paid vision indexer on unranked photos.
async fn search_captures(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<CaptureSearchQuery>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let (page, size, requested_offset) = PageQuery {
        page: query.page,
        size: query.size,
    }
    .window();
    if query.query.trim().is_empty() {
        return Json(page_of(Vec::<MemoryDto>::new(), 0, page, size)).into_response();
    }

    let mut source_offset = 0i64;
    let mut matches = Vec::new();
    let mut pending_visual_index = Vec::new();
    loop {
        let rows = match state
            .store
            .memory_page(
                &account,
                CAPTURE_KINDS,
                query.only_containing_favorited,
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
        for (summary, selection) in memories_with_selections(&state, &account, rows.records).await {
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
    schedule_visual_index(&state, &account, pending_visual_index);
    let mut response = Json(page_of(content, total, page, size)).into_response();
    response.headers_mut().insert(
        "x-cosmos-visual-index",
        HeaderValue::from_static(visual_index_state),
    );
    if let Ok(value) = HeaderValue::from_str(&pending.to_string()) {
        response
            .headers_mut()
            .insert("x-cosmos-visual-pending", value);
    }
    response
}

/// The caller's capture, a photo or video, by uuid or numeric id.
///
/// Food logs are memories too, but not captures: the favourite, tag and delete
/// routes answer for one exactly as for a uuid the caller does not hold, as
/// `/capture/captures` never lists one. A food log is deleted through
/// `CaptureService.DeleteMemory`, which also takes its entry out of the food
/// log.
async fn capture(state: &ApiState, account: &str, uuid: &str) -> Written<Option<MemoryRecord>> {
    Ok(state
        .store
        .memory(account, uuid)
        .await?
        .filter(|record| CAPTURE_KINDS.contains(&record.kind)))
}

/// One capture's answer, read fresh: the shape every single-capture write
/// returns so the caller renders what the store now holds.
async fn memory_response(state: &ApiState, account: &str, uuid: &str) -> Response {
    match state.store.memory(account, uuid).await {
        Ok(Some(record)) => {
            let selection = best_frame_metadata(state, account, &record.uuid).await;
            Json(MemoryDetailDto::new(&record, selection)).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => unavailable(),
    }
}

async fn get_memory(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    match state.caller(&headers) {
        Ok(account) => memory_response(&state, &account, &uuid).await,
        Err(response) => response,
    }
}

/// `DELETE /capture/memory/{uuid}` (recovered `deleteWebapiMemory`).
///
/// The same delete the Pin's `DeleteMemory` runs, frames first, then the
/// row, so a capture forgotten on the web leaves nothing on the volume.
/// `{"deleted": false}` only when the caller holds no such capture. A delete
/// the store could not finish is a 500, never a claim that it happened.
async fn delete_memory(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    match delete_one(&state, &account, &uuid).await {
        Some(deleted) => Json(DeletedDto { deleted }).into_response(),
        None => delete_failed(),
    }
}

/// `Some(true)` deleted, `Some(false)` no such capture, `None` not done.
async fn delete_one(state: &ApiState, account: &str, uuid: &str) -> Option<bool> {
    use cosmos_protocol::capture::DeleteMemoryStatus;
    if capture(state, account, uuid).await.ok()?.is_none() {
        return Some(false);
    }
    let status = crate::services::capture::delete_memory(
        &state.store,
        state.objects.as_deref(),
        account,
        cosmos_protocol::capture::DeleteMemoryRequest {
            memory_uuid: uuid.to_owned(),
            ..Default::default()
        },
    )
    .await
    .ok()?;
    match status {
        DeleteMemoryStatus::Success => Some(true),
        DeleteMemoryStatus::NotFound => Some(false),
        _ => None,
    }
}

async fn set_favorite(
    state: &ApiState,
    headers: &HeaderMap,
    uuid: &str,
    favorite: bool,
) -> Response {
    let account = match state.web_caller(headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let record = match capture(state, &account, uuid).await {
        Ok(Some(record)) => record,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    match state
        .store
        .set_memory_favorite(&account, std::slice::from_ref(&record.uuid), favorite)
        .await
    {
        Ok(0) => StatusCode::NOT_FOUND.into_response(),
        Ok(_) => memory_response(state, &account, &record.uuid).await,
        Err(_) => unavailable(),
    }
}

async fn favorite(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    set_favorite(&state, &headers, &uuid, true).await
}

async fn unfavorite(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    set_favorite(&state, &headers, &uuid, false).await
}

/// How many of the named captures a bulk favourite changed.
#[derive(Serialize)]
struct UpdatedDto {
    updated: usize,
}

async fn set_favorites(
    state: &ApiState,
    headers: &HeaderMap,
    body: MemoryUuids,
    favorite: bool,
) -> Response {
    let account = match state.web_caller(headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let named = match body.bounded() {
        Ok(uuids) => uuids,
        Err(response) => return response,
    };
    let mut uuids = Vec::with_capacity(named.len());
    for name in &named {
        match capture(state, &account, name).await {
            Ok(Some(record)) if !uuids.contains(&record.uuid) => uuids.push(record.uuid),
            Ok(_) => {}
            Err(_) => return unavailable(),
        }
    }
    match state
        .store
        .set_memory_favorite(&account, &uuids, favorite)
        .await
    {
        Ok(updated) => Json(UpdatedDto { updated }).into_response(),
        Err(_) => unavailable(),
    }
}

async fn bulk_favorite(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<MemoryUuids>,
) -> Response {
    set_favorites(&state, &headers, body, true).await
}

async fn bulk_unfavorite(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<MemoryUuids>,
) -> Response {
    set_favorites(&state, &headers, body, false).await
}

/// What a bulk delete did to each named capture. A name in `failed` is still
/// stored: the wearer must be told, never shown it as gone.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct BulkDeletedDto {
    deleted: Vec<String>,
    not_found: Vec<String>,
    failed: Vec<String>,
}

/// `POST /capture/memory/bulk-delete {memoryUUIDs}` (recovered
/// `bulkDeleteMemories`): each capture deleted exactly as a single delete is.
async fn bulk_delete(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<MemoryUuids>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let uuids = match body.bounded() {
        Ok(uuids) => uuids,
        Err(response) => return response,
    };
    let mut outcome = BulkDeletedDto::default();
    for uuid in uuids {
        match delete_one(&state, &account, &uuid).await {
            Some(true) => outcome.deleted.push(uuid),
            Some(false) => outcome.not_found.push(uuid),
            None => outcome.failed.push(uuid),
        }
    }
    Json(outcome).into_response()
}

/// `humane.capture.Tag`, the recovered `tagMemory` body.
#[derive(Deserialize)]
struct TagBody {
    text: String,
}

/// `POST /capture/memory/{uuid}/tag {text}`: add the wearer's tag. A tag is
/// one to 64 printable characters, and a capture carries at most 32.
async fn add_tag(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(body): Json<TagBody>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let tag = body.text.trim();
    if tag.is_empty() || tag.chars().count() > MAX_TAG_CHARS || tag.chars().any(char::is_control) {
        return (
            StatusCode::BAD_REQUEST,
            "a tag is 1 to 64 printable characters",
        )
            .into_response();
    }
    let record = match capture(&state, &account, &uuid).await {
        Ok(Some(record)) => record,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    if record.tags.len() >= MAX_TAGS && !record.tags.iter().any(|existing| existing == tag) {
        return (StatusCode::BAD_REQUEST, "a capture carries at most 32 tags").into_response();
    }
    match state
        .store
        .add_memory_tag(&account, &record.uuid, tag)
        .await
    {
        Ok(true) => memory_response(&state, &account, &record.uuid).await,
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => unavailable(),
    }
}

/// `DELETE /capture/memory/{uuid}/tag/{tag}` under the delete contract:
/// `{"deleted": true}` only when the capture carried that tag.
async fn remove_tag(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((uuid, tag)): Path<(String, String)>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let record = match capture(&state, &account, &uuid).await {
        Ok(Some(record)) => record,
        Ok(None) => return Json(DeletedDto { deleted: false }).into_response(),
        Err(_) => return delete_failed(),
    };
    if !record.tags.contains(&tag) {
        return Json(DeletedDto { deleted: false }).into_response();
    }
    match state
        .store
        .remove_memory_tag(&account, &record.uuid, &tag)
        .await
    {
        Ok(deleted) => Json(DeletedDto { deleted }).into_response(),
        Err(_) => delete_failed(),
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

/// Rank one photo's frames and refresh its private visual index. `force`
/// re-asks the model even when an index exists. A wearer's manual frame
/// choice is kept either way (`rank_photo_best_frame`).
async fn rank(
    state: &ApiState,
    account: &str,
    uuid: &str,
    force: bool,
) -> Result<(MemoryRecord, crate::capture_ranking::BestFrameSelection), Response> {
    let record = match state.store.memory(account, uuid).await {
        Ok(Some(record)) if record.kind == MemoryKind::Photo => record,
        Ok(_) => return Err(StatusCode::NOT_FOUND.into_response()),
        Err(_) => return Err(unavailable()),
    };
    let Some(objects) = state.objects.as_ref() else {
        return Err(unavailable());
    };
    match objects
        .rank_photo_best_frame(&state.keys, account, &record, force)
        .await
    {
        Ok(Some(selection)) => Ok((record, selection)),
        Ok(None) => Err((
            StatusCode::CONFLICT,
            "no opened thumbnails are available for ranking",
        )
            .into_response()),
        Err(_) => Err(unavailable()),
    }
}

async fn rank_best_photo(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Query(query): Query<RankBestPhotoQuery>,
) -> Response {
    // A write: the web plane only (`web_api::ApiState::web_account_for`).
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    match rank(&state, &account, &uuid, query.force).await {
        Ok((_, selection)) => Json(selection).into_response(),
        Err(response) => response,
    }
}

/// `POST /capture/memory/{uuid}/index` (recovered `indexMemory`): rebuild the
/// capture's private search index now. Answers the capture as it now reads.
async fn reindex(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    match rank(&state, &account, &uuid, true).await {
        Ok((record, selection)) => {
            Json(MemoryDetailDto::new(&record, Some(selection))).into_response()
        }
        Err(response) => response,
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
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Query(query): Query<BestFrameQuery>,
) -> Response {
    // A write: the web plane only (`web_api::ApiState::web_account_for`).
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let record = match state.store.memory(&account, &uuid).await {
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
        .read_best_frame(&account, &record.uuid)
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
    // in both backends), but object storage is namespaced by uuid alone, every
    // reader of this sidecar keys it that way: `get_memory`, `memory_dtos` and
    // `rank_photo_best_frame` all pass `record.uuid`. So a request that named the
    // capture by its numeric id wrote the wearer's manual choice to
    // `{principal}/4711/.best-frame.json`, which nothing ever reads: the wearer
    // pressed "use this frame", got a 200 with their selection echoed back, and
    // the dashboard went on showing the old hero image. The automatic ranker
    // could not see the choice either, so the "the wearer always wins" guard
    // never fired and the next `best_photo` silently overrode them, and
    // `remove_slots` prunes only the uuid-keyed path, so the stray sidecar and
    // its directory outlived the deleted capture.
    //
    // Anything addressed to object storage derives from the resolved record, the
    // way `rank_best_photo` already does. The URL is how the caller ASKED for the
    // capture, not what the capture is.
    if objects
        .write_best_frame(&account, &record.uuid, &selection)
        .await
        .is_err()
    {
        return unavailable();
    }
    Json(selection).into_response()
}

// ── Pending captures ────────────────────────────────────────────────────────

/// A capture the Pin declared with `DeclareMemoryCreateIntent` and has not
/// created here yet (recovered `getPendingMemoryCreates`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingCaptureDto {
    device_local_id: String,
    /// `humane.capture.MemoryType` without its `MEMORY_TYPE_` prefix.
    memory_type: &'static str,
    /// `MemoryCreateIntentRequest.DelayReason` without its `DELAY_REASON_` prefix.
    delay_reason: &'static str,
    /// Epoch seconds Cosmos recorded the declaration.
    declared_at: i64,
}

impl PendingCaptureDto {
    fn new(pending: crate::store::PendingMemoryCreate) -> Self {
        use cosmos_protocol::capture::{MemoryType, memory_create_intent_request::DelayReason};
        Self {
            memory_type: MemoryType::try_from(pending.memory_type)
                .map(|kind| kind.as_str_name().trim_start_matches("MEMORY_TYPE_"))
                .unwrap_or("UNSPECIFIED"),
            delay_reason: DelayReason::try_from(pending.delay_reason)
                .map(|reason| reason.as_str_name().trim_start_matches("DELAY_REASON_"))
                .unwrap_or("UNSPECIFIED"),
            declared_at: pending.declared.seconds(),
            device_local_id: pending.device_local_id,
        }
    }
}

async fn list_pending(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let account = match state.caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    match state.store.pending_memory_creates(&account).await {
        Ok(pending) => Json(
            pending
                .into_iter()
                .map(PendingCaptureDto::new)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(_) => unavailable(),
    }
}

/// `DELETE /capture/pending-memory-creates` (recovered
/// `deletePendingMemoryCreate`): clear the queue. The captures themselves are
/// on the Pin and untouched. A Pin that still holds one declares it again.
async fn clear_pending(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    match state
        .store
        .delete_all_pending_memory_creates(&account)
        .await
    {
        Ok(removed) => Json(DeletedDto {
            deleted: removed > 0,
        })
        .into_response(),
        Err(_) => delete_failed(),
    }
}

// ── Food log ────────────────────────────────────────────────────────────────

/// `GET /capture/food-log?startTime&endTime` (recovered `getFoodLog`). Both
/// bounds are RFC 3339 instants and inclusive. Either may be left out.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoodLogQuery {
    start_time: Option<String>,
    end_time: Option<String>,
}

/// An RFC 3339 instant; `None` when absent. Shared with the account API's
/// food-intake window, which reads the same food log.
pub(crate) fn instant(value: Option<&str>) -> Result<Option<SyncTime>, ()> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = sqlx::types::chrono::DateTime::parse_from_rfc3339(value).map_err(|_| ())?;
    Ok(Some(SyncTime::from_parts(
        parsed.timestamp(),
        parsed.timestamp_subsec_nanos() as i32,
    )))
}

/// One logged `humane.common.food.FoodLog`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FoodLogEntryDto {
    memory_uuid: String,
    /// Epoch seconds the Pin logged it.
    logged_at: i64,
    item_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    brand: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    typical_serving_size: Option<String>,
    servings_consumed: f32,
    nutrition_info: Vec<NutritionDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NutritionDto {
    /// `humane.common.food.NutrientType`, by name.
    nutrient_type: &'static str,
    value: f32,
}

async fn food_log(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<FoodLogQuery>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let (Ok(start), Ok(end)) = (
        instant(query.start_time.as_deref()),
        instant(query.end_time.as_deref()),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            "startTime and endTime are RFC 3339 instants",
        )
            .into_response();
    };
    // One entry sealed under a key Cosmos does not hold must not blank the
    // day: the listing answers every entry it could open and counts the rest
    // in `x-cosmos-sealed`, the way note listings mark a note they cannot read.
    // Totals (the Pin's summary, the intake read) still refuse instead.
    let window = match crate::services::capture::open_food_logs(
        &state.store,
        &state.keys,
        &account,
        start.unwrap_or_else(|| SyncTime::from_parts(0, 0)),
        end,
    )
    .await
    {
        Ok(window) => window,
        Err(_) => return unavailable(),
    };
    if window.sealed > 0 {
        // The subject is the account the sealed entries belong to, every
        // other call site names the record it could not open, and a window
        // holds many. The message already says what was sealed.
        key_directory_miss(
            &state.keys,
            &account,
            "a food-log entry could not be opened",
        );
    }
    let sealed = window.sealed;
    let entries = window
        .opened
        .into_iter()
        .filter_map(|entry| {
            let item = entry.log.food_item?;
            Some(FoodLogEntryDto {
                memory_uuid: entry.memory_uuid,
                logged_at: entry.logged.seconds(),
                item_name: item.item_name,
                brand: Some(item.brand).filter(|brand| !brand.is_empty()),
                typical_serving_size: Some(item.typical_serving_size)
                    .filter(|size| !size.is_empty()),
                servings_consumed: entry.log.servings_consumed,
                nutrition_info: item
                    .nutrition_info
                    .into_iter()
                    .filter_map(|nutrient| {
                        let kind = cosmos_protocol::common::food::NutrientType::try_from(
                            nutrient.nutrient_type,
                        )
                        .ok()?;
                        Some(NutritionDto {
                            nutrient_type: kind.as_str_name(),
                            value: nutrient.value,
                        })
                    })
                    .collect(),
            })
        })
        .collect::<Vec<_>>();
    let mut response = Json(entries).into_response();
    response
        .headers_mut()
        .insert(FOOD_LOG_SEALED_HEADER, HeaderValue::from(sealed));
    response
}

/// How many food-log entries in the window Cosmos could not open.
const FOOD_LOG_SEALED_HEADER: &str = "x-cosmos-sealed";

// ── Media ───────────────────────────────────────────────────────────────────

/// Open one sealed thumbnail for a web caller: the JPEG, or the response
/// explaining why not.
async fn open_thumbnail(
    state: &ApiState,
    uuid: &str,
    sealed: &cosmos_protocol::common::encryption::EncryptedData,
) -> Result<Vec<u8>, Response> {
    let kid = sealed
        .encryption_information
        .as_ref()
        .map(|information| information.kid.as_str())
        .unwrap_or_default();
    // A key we do not hold, or an envelope that will not open, is a KEYING
    // problem, the row is intact and the listing still reports it. Answering
    // 404 said "this frame does not exist", which is a claim about the wearer's
    // data and is indistinguishable from a genuinely missing capture on both
    // sides. 503 is the same answer the store-outage branch gives, and Center
    // renders it as degraded rather than "frame unavailable".
    let key = match state.keys.get(kid).await {
        Ok(Some(key)) => key,
        Err(_) => return Err(unavailable()),
        Ok(None) => {
            key_directory_miss(&state.keys, uuid, "no channel key for this capture");
            return Err(unavailable());
        }
    };
    cosmos_crypto::secure_asset::open_secure_asset(
        &key,
        kid,
        &sealed.data,
        cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
    )
    .map_err(|_| {
        key_directory_miss(
            &state.keys,
            uuid,
            "held the capture's key but the thumbnail did not open",
        );
        unavailable()
    })
}

/// One capture thumbnail.
///
/// The rule this module states, return the index, never sealed bytes, was
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
    headers: HeaderMap,
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
    // them, on a photo route the dashboard calls per tile.
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

    match open_thumbnail(&state, &uuid, &sealed).await {
        Ok(jpeg) => (
            StatusCode::OK,
            [
                ("content-type", "image/jpeg"),
                ("cache-control", "private, no-store"),
                ("x-cosmos-projection", "opened"),
            ],
            jpeg,
        )
            .into_response(),
        Err(response) => response,
    }
}

/// Which stored file a `fileId` names.
enum FileRef<'a> {
    /// A device-sealed thumbnail, listed as a derivative: `thumbnail-<index>`.
    Thumbnail(usize),
    /// An uploaded full-resolution photo or video.
    Original(&'a crate::store::BurstFileRecord),
}

/// Resolve `requested` against `record`: `thumbnail-<n>` first, then the
/// file's uuid (recovered `/memory/{uuid}/file/{fileUUID}`) or its server
/// file id, then a zero-based ordinal (Center's UI has only an ordinal).
fn resolve_file<'a>(record: &'a MemoryRecord, requested: &str) -> Option<FileRef<'a>> {
    if let Some(index) = requested.strip_prefix("thumbnail-") {
        let index = index.parse::<usize>().ok()?;
        return (index < record.thumbnails.len()).then_some(FileRef::Thumbnail(index));
    }
    let files = record
        .bursts
        .iter()
        .flat_map(|burst| burst.files.iter())
        .collect::<Vec<_>>();
    files
        .iter()
        .copied()
        .find(|file| file.uuid == requested || file.id.to_string() == requested)
        .or_else(|| {
            requested
                .parse::<usize>()
                .ok()
                .and_then(|index| files.get(index).copied())
        })
        .map(FileRef::Original)
}

/// The key id a capture's full-resolution assets are sealed under: the
/// request's `encryption_information.kid`, which `MemoryUploadWorkerImpl`
/// also seals every thumbnail and asset with. A row stored before that column
/// existed falls back to its first thumbnail's kid, the same key.
fn asset_kid(record: &MemoryRecord) -> &str {
    if !record.metadata.encryption_kid.is_empty() {
        return &record.metadata.encryption_kid;
    }
    record
        .thumbnails
        .first()
        .and_then(|thumbnail| thumbnail.encryption_information.as_ref())
        .map(|information| information.kid.as_str())
        .unwrap_or_default()
}

/// One opened file of a capture and how to label it.
struct OpenedFile {
    bytes: Vec<u8>,
    content_type: &'static str,
    extension: &'static str,
}

async fn open_file(
    state: &ApiState,
    account: &str,
    record: &MemoryRecord,
    file: FileRef<'_>,
) -> Result<OpenedFile, Response> {
    let file = match file {
        FileRef::Thumbnail(index) => {
            let bytes = open_thumbnail(state, &record.uuid, &record.thumbnails[index]).await?;
            return Ok(OpenedFile {
                bytes,
                content_type: "image/jpeg",
                extension: "jpg",
            });
        }
        FileRef::Original(file) => file,
    };
    // `observed`: the photography worker uploads the JPG to
    // `CaptureFile.secure_filename` as capture domain 2 / object 2, and a
    // video to the same slot as object 1 (`AssetUploadWorkerImpl`
    // `VIDEO_OBJ_ID`).
    let (binding, content_type, extension) = match record.kind {
        MemoryKind::Video => (
            cosmos_crypto::secure_asset::CAPTURE_VIDEO,
            "video/mp4",
            "mp4",
        ),
        _ => (
            cosmos_crypto::secure_asset::CAPTURE_JPEG,
            "image/jpeg",
            "jpg",
        ),
    };
    let Some(objects) = state.objects.as_ref() else {
        return Err(unavailable());
    };
    let sealed = match objects.read(account, &file.secure_filename).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(StatusCode::NOT_FOUND.into_response()),
        Err(_) => return Err(unavailable()),
    };
    let kid = asset_kid(record);
    // Same split as `get_thumbnail`: the object is stored and readable, so a
    // missing key or a refused open is an outage to report, not a file that
    // does not exist.
    let key = match state.keys.get(kid).await {
        Ok(Some(key)) => key,
        Err(_) => return Err(unavailable()),
        Ok(None) => {
            key_directory_miss(
                &state.keys,
                &record.uuid,
                "no channel key for this capture's file",
            );
            return Err(unavailable());
        }
    };
    let bytes = cosmos_crypto::secure_asset::open_secure_asset(&key, kid, &sealed, binding)
        .map_err(|_| {
            key_directory_miss(
                &state.keys,
                &record.uuid,
                "held the capture's key but the file did not open",
            );
            unavailable()
        })?;
    Ok(OpenedFile {
        bytes,
        content_type,
        extension,
    })
}

/// A single `bytes=` range over `total` bytes: `None` to serve the whole body
/// (no range, or one this server does not honour, as RFC 9110 allows),
/// `Some(Err)` for a range that cannot be satisfied.
fn byte_range(value: &str, total: usize) -> Option<Result<(usize, usize), ()>> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = (start.trim(), end.trim());
    let range = if start.is_empty() {
        let suffix = end.parse::<usize>().ok()?;
        if suffix == 0 || total == 0 {
            return Some(Err(()));
        }
        (total - suffix.min(total), total - 1)
    } else {
        let start = start.parse::<usize>().ok()?;
        let end = if end.is_empty() {
            usize::MAX
        } else {
            end.parse::<usize>().ok()?
        };
        if end < start {
            return None;
        }
        if start >= total {
            return Some(Err(()));
        }
        (start, end.min(total - 1))
    };
    Some(Ok(range))
}

/// Serve an opened file, honouring a single `Range` so a `<video>` can seek.
///
/// A video is opened whole on every request, the stock asset is one
/// AES-GCM envelope, which cannot be decrypted from the middle, and sliced
/// here. A 15-second stock capture fits comfortably inside the upload ceiling
/// the object store already enforces on reads.
fn ranged(headers: &HeaderMap, file: OpenedFile, attachment: Option<&str>) -> Response {
    let total = file.bytes.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| byte_range(value, total));
    let mut response = match range {
        None => (StatusCode::OK, file.bytes).into_response(),
        Some(Ok((start, end))) => {
            let mut response = (
                StatusCode::PARTIAL_CONTENT,
                file.bytes[start..=end].to_vec(),
            )
                .into_response();
            if let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            response
        }
        Some(Err(())) => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{total}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            response
        }
    };
    let satisfied = response.status() != StatusCode::RANGE_NOT_SATISFIABLE;
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-cosmos-projection", HeaderValue::from_static("opened"));
    if satisfied {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(file.content_type),
        );
    }
    if let Some(name) = attachment
        && let Ok(value) = HeaderValue::from_str(&format!(
            "attachment; filename=\"capture-{name}.{}\"",
            file.extension
        ))
    {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    response
}

/// One stored file of a capture, opened only for an authenticated web wearer.
///
/// `observed`: `/capture/memory/{memoryId}/file/{fileId}` in recovered Center,
/// with `HEAD` for its size (`getEncryptedMediaSize`), answered by the same
/// handler. Photos are served as JPEG and videos as MP4 with `Range`.
async fn serve_file(
    state: &ApiState,
    headers: &HeaderMap,
    uuid: &str,
    requested: &str,
    attachment: bool,
) -> Response {
    let account = match state.web_caller(headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let record = match state.store.memory(&account, uuid).await {
        Ok(Some(record)) if CAPTURE_KINDS.contains(&record.kind) => record,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    let Some(file) = resolve_file(&record, requested) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match open_file(state, &account, &record, file).await {
        Ok(opened) => ranged(headers, opened, attachment.then_some(record.uuid.as_str())),
        Err(response) => response,
    }
}

async fn get_file(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((uuid, file)): Path<(String, String)>,
) -> Response {
    serve_file(&state, &headers, &uuid, &file, false).await
}

#[derive(Deserialize)]
struct DownloadQuery {
    /// Recovered `rawData`: the unprocessed sensor asset. Stock JPG mode never
    /// uploads one (`humane_photography_jpg_enabled` is locked on), so none is
    /// ever stored.
    #[serde(default, rename = "rawData")]
    raw_data: bool,
}

/// `GET /capture/memory/{uuid}/file/{fileId}/download` (recovered
/// `getEncryptedMedia`): the same file as an attachment.
async fn download_file(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((uuid, file)): Path<(String, String)>,
    Query(query): Query<DownloadQuery>,
) -> Response {
    if query.raw_data {
        return (
            StatusCode::NOT_FOUND,
            "no raw sensor data is stored for this capture",
        )
            .into_response();
    }
    serve_file(&state, &headers, &uuid, &file, true).await
}

/// `GET /capture/memory/{uuid}/originals` (recovered
/// `getWebapiMemoryIdOriginals`): the full-resolution files the Pin uploaded
/// and this deployment holds, in frame order.
async fn originals(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let account = match state.caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let record = match state.store.memory(&account, &uuid).await {
        Ok(Some(record)) if CAPTURE_KINDS.contains(&record.kind) => record,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    let Some(objects) = state.objects.as_ref() else {
        return unavailable();
    };
    let (kind, content_type) = match record.kind {
        MemoryKind::Video => ("VIDEO", "video/mp4"),
        _ => ("PHOTO", "image/jpeg"),
    };
    let mut files = Vec::new();
    for (index, file) in record
        .bursts
        .iter()
        .flat_map(|burst| burst.files.iter())
        .enumerate()
    {
        if objects.holds(&account, &file.secure_filename).await {
            files.push(CaptureFileDto {
                file_id: file.id.to_string(),
                index,
                kind,
                content_type,
            });
        }
    }
    Json(CaptureFilesDto {
        memory_uuid: record.uuid,
        files,
    })
    .into_response()
}

/// `GET /capture/memory/{uuid}/derivatives` (recovered
/// `getWebapiMemoryIdDerivatives`): the renditions made from the originals.
/// Cosmos makes none of its own. The Pin's sealed thumbnails are the
/// renditions it holds, served by the file route as `thumbnail-<index>`.
async fn derivatives(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let account = match state.caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    match state.store.memory(&account, &uuid).await {
        Ok(Some(record)) if CAPTURE_KINDS.contains(&record.kind) => Json(CaptureFilesDto {
            files: (0..record.thumbnails.len())
                .map(|index| CaptureFileDto {
                    file_id: format!("thumbnail-{index}"),
                    index,
                    kind: "PHOTO",
                    content_type: "image/jpeg",
                })
                .collect(),
            memory_uuid: record.uuid,
        })
        .into_response(),
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => unavailable(),
    }
}

// ── Sharing ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareLinkDto {
    url: String,
    memory_uuid: String,
    /// Unix seconds after which the link stops opening the capture.
    expiry: i64,
}

/// A share-authority refusal as HTTP: an invalid or expired capability is
/// 404, and an authority this deployment never configured (no share base URL
/// or token secret) is 501, a fact about the server that no retry changes,
/// kept apart from the 503 a store outage answers, which a retry may cure.
fn share_refusal(status: &tonic::Status) -> Response {
    match status.code() {
        tonic::Code::NotFound => StatusCode::NOT_FOUND.into_response(),
        tonic::Code::FailedPrecondition => (
            StatusCode::NOT_IMPLEMENTED,
            "sharing is not set up on this server",
        )
            .into_response(),
        _ => (StatusCode::SERVICE_UNAVAILABLE, "sharing is not available").into_response(),
    }
}

/// `POST /capture/memory/{uuid}/share-link`: the web share button. The same
/// link the Pin's `GetMemoryShareLink` mints, for a capture the caller owns.
async fn share_link(
    State(api): State<CaptureApi>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Response {
    let state = &api.api;
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(response) => return response,
    };
    let record = match state.store.memory(&account, &uuid).await {
        Ok(Some(record)) if CAPTURE_KINDS.contains(&record.kind) => record,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    match api.share.mint(&account, &record.uuid) {
        Ok(link) => Json(ShareLinkDto {
            url: link.url,
            memory_uuid: link.memory_uuid,
            expiry: link.expiry,
        })
        .into_response(),
        Err(status) => share_refusal(&status),
    }
}

#[derive(Deserialize)]
struct SharedQuery {
    expiry: Option<i64>,
    signature: Option<String>,
}

/// `GET /share/capture/{uuid}/thumbnail?expiry&signature`: the frame a share
/// link shows, for whoever holds the link.
///
/// The capability is the whole authorization, it names its owner and its one
/// capture and expires, so no identity is asked for or used. It opens the
/// best frame, the same one `GetShareLinkContents` hands a recipient's Pin.
/// Every refusal of the link itself is 404, so a prober learns nothing.
async fn shared_thumbnail(
    State(api): State<CaptureApi>,
    Path(uuid): Path<String>,
    Query(query): Query<SharedQuery>,
) -> Response {
    let (Some(expiry), Some(signature)) = (query.expiry, query.signature) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let capability = match api.share.open(&cosmos_protocol::capture::ShareLinkData {
        memory_uuid: uuid,
        signature,
        expiry,
    }) {
        Ok(capability) => capability,
        Err(status) => return share_refusal(&status),
    };
    let state = &api.api;
    let record = match state
        .store
        .memory(&capability.owner, &capability.memory_uuid)
        .await
    {
        Ok(Some(record)) if !record.thumbnails.is_empty() => record,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return unavailable(),
    };
    match crate::services::capture::shared_frame(
        &state.store,
        &state.keys,
        state.objects.as_deref(),
        &capability.owner,
        &record,
    )
    .await
    {
        Ok(Some(jpeg)) => (
            StatusCode::OK,
            [
                ("content-type", "image/jpeg"),
                ("cache-control", "private, no-store"),
                ("x-content-type-options", "nosniff"),
                ("referrer-policy", "no-referrer"),
                (
                    "content-security-policy",
                    "default-src 'none'; frame-ancestors 'none'; sandbox",
                ),
                ("x-cosmos-projection", "opened"),
            ],
            jpeg,
        )
            .into_response(),
        Ok(None) => {
            key_directory_miss(
                &state.keys,
                &record.uuid,
                "no thumbnail of a shared capture opens",
            );
            unavailable()
        }
        Err(_) => unavailable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{CaptureMetadata, NewMemory, NewNote, SharedStore};
    use crate::web_api::test_support::*;
    use crate::web_api::{DEMO_PRINCIPAL, HttpTrust};
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn router_with_verifier(
        store: SharedStore,
        keys: crate::keydirectory::SharedKeyDirectory,
        principal: impl Into<Arc<str>>,
        trust: HttpTrust,
        web_verifier: Option<Arc<crate::web_auth::JwtVerifier>>,
    ) -> Router {
        router_with_objects(store, keys, principal, trust, web_verifier, None)
    }

    fn router_with_objects(
        store: SharedStore,
        keys: crate::keydirectory::SharedKeyDirectory,
        principal: impl Into<Arc<str>>,
        trust: HttpTrust,
        web_verifier: Option<Arc<crate::web_auth::JwtVerifier>>,
        objects: Option<Arc<crate::services::capture::CaptureObjectStore>>,
    ) -> Router {
        crate::web_api::router(ApiState::for_tests(
            store,
            keys,
            principal,
            trust,
            web_verifier,
            objects,
        ))
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
            metadata: CaptureMetadata::default(),
        }
    }

    /// THE PUBLIC CAPTURE INDEX IS NOT A GUESSING GAME.
    ///
    /// On an internet-facing deployment, knowing a wearer's account id used to
    /// be enough: send `x-forwarded-client-cert: U:<id>` and read their capture
    /// index, probe their private captions through `/capture/search`, and set
    /// the vision indexer running on their photos. Sending nothing read the demo
    /// account. Both are 401 now, on every read. Only a request that carries the
    /// proof its sender holds a deployment secret is answered.
    #[tokio::test]
    async fn an_internet_facing_capture_api_answers_only_proven_callers() {
        use crate::config::{EDGE_PRINCIPAL_HEADER, EDGE_TOKEN_HEADER};
        let store = fresh();
        let capture = store
            .create_memory("U:alice", photo("cam-1"))
            .await
            .unwrap();
        store
            .create_note("U:alice", NewNote::sealed(None, None))
            .await
            .unwrap();
        store
            .create_note(DEMO_PRINCIPAL, NewNote::sealed(None, None))
            .await
            .unwrap();
        let app = router_with_verifier(
            store,
            fresh_keys(),
            DEMO_PRINCIPAL,
            internet_facing(),
            Some(test_verifier()),
        );

        let memory = format!("/capture/memory/{}", capture.uuid);
        let thumbnail = format!("/capture/memory/{}/thumbnail/0", capture.uuid);
        let reads = [
            "/capture/captures",
            "/capture/search?query=cat",
            "/capture/notes",
            memory.as_str(),
            thumbnail.as_str(),
        ];
        for uri in reads {
            let (status, body) = get_with(&app, uri, &[]).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "anonymous {uri}");
            assert_eq!(body, serde_json::Value::Null, "anonymous {uri}");
            for subject in edge_subjects("alice") {
                let (status, body) =
                    get_with(&app, uri, &[(EDGE_PRINCIPAL_HEADER, &subject)]).await;
                assert_eq!(
                    status,
                    StatusCode::UNAUTHORIZED,
                    "forged {subject} on {uri}"
                );
                assert_eq!(body, serde_json::Value::Null, "forged {subject} on {uri}");
            }
        }

        let [xfcc, ..] = edge_subjects("alice");
        let (status, device) = get_with(
            &app,
            "/capture/captures",
            &[
                (EDGE_PRINCIPAL_HEADER, &xfcc),
                (EDGE_TOKEN_HEADER, EDGE_TOKEN),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(device["totalElements"], 1, "alice's capture");

        let (status, web) = get_with_bearer(&app, "/capture/notes", &bearer_for("alice")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(web["totalElements"], 1, "alice's note, not the demo one");

        let (status, bearer) =
            get_with_bearer(&app, "/capture/captures", &bearer_for("alice")).await;
        assert_eq!(status, StatusCode::OK, "a signed-in wearer is unaffected");
        assert_eq!(bearer["totalElements"], 1);
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
            HttpTrust::development(),
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
        // `tags` on the wire is the wearer's own list. The vision tags that
        // matched stay private.
        assert_eq!(alice["content"][0]["tags"], serde_json::json!([]));
        assert!(!public_json.contains("animal"));
        assert!(!public_json.contains("pet"));
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

    /// The best-frame routes WRITE, so only the web plane may call them: a Pin
    /// behind the edge is 403 and nobody is 401, never the demo partition,
    /// while the signed-in wearer's choice is recorded.
    #[tokio::test]
    async fn best_frame_writes_answer_only_the_web_plane() {
        use crate::config::{EDGE_PRINCIPAL_HEADER, EDGE_TOKEN_HEADER};
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
                    ..photo("cam-web-only")
                },
            )
            .await
            .unwrap();
        let app = router_with_objects(
            store,
            fresh_keys(),
            DEMO_PRINCIPAL,
            internet_facing(),
            Some(test_verifier()),
            Some(crate::services::capture::CaptureObjectStore::for_tests()),
        );
        let uri = format!("/capture/memory/{}/bestFrame?frame=1", record.uuid);
        let [xfcc, ..] = edge_subjects("alice");
        let device = [
            (EDGE_PRINCIPAL_HEADER, xfcc),
            (EDGE_TOKEN_HEADER, EDGE_TOKEN.to_owned()),
        ];
        for path in [
            uri.clone(),
            format!("/capture/memory/{}/best_photo", record.uuid),
        ] {
            let (status, _) = send(&app, axum::http::Method::POST, &path, &device, None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "device plane on {path}");
            let (status, _) = send(&app, axum::http::Method::POST, &path, &[], None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "nobody on {path}");
        }
        let (status, body) = send(
            &app,
            axum::http::Method::POST,
            &uri,
            &[bearer_header("alice")],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["frame"], 1);
        assert_eq!(body["method"], "manual");
    }

    // ── W2: the remaining recovered capture routes ──────────────────────────

    const SHARE_BASE: &str = "https://luma.example.com";

    /// An internet-facing deployment with object storage and a configured
    /// share authority: the shape production runs.
    fn full_router(
        store: SharedStore,
        keys: crate::keydirectory::SharedKeyDirectory,
        objects: Option<Arc<crate::services::capture::CaptureObjectStore>>,
    ) -> Router {
        router_with_share(
            ApiState::for_tests(
                store,
                keys,
                DEMO_PRINCIPAL,
                internet_facing(),
                Some(test_verifier()),
                objects,
            ),
            ShareAuthority::for_tests(Some(SHARE_BASE)),
        )
    }

    /// A Pin behind the edge, proven by the edge token.
    fn device_headers(account: &str) -> Vec<(&'static str, String)> {
        let [xfcc, ..] = edge_subjects(account);
        vec![
            (crate::config::EDGE_PRINCIPAL_HEADER, xfcc),
            (crate::config::EDGE_TOKEN_HEADER, EDGE_TOKEN.to_owned()),
        ]
    }

    /// Status, headers and raw body: for the routes that answer bytes.
    async fn raw(
        app: &Router,
        method: axum::http::Method,
        uri: &str,
        headers: &[(&str, String)],
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut request = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, value.as_str());
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 24)
            .await
            .unwrap();
        (status, headers, bytes.to_vec())
    }

    const KID: &str = "d=pin1;u=alice;k=capture";
    const KEY: [u8; cosmos_crypto::AES_KEY_LEN] = [5u8; cosmos_crypto::AES_KEY_LEN];

    async fn keys_with_capture_key() -> crate::keydirectory::SharedKeyDirectory {
        let keys = fresh_keys();
        keys.put(KID, KEY).await.unwrap();
        keys
    }

    fn sealed(
        bytes: &[u8],
        binding: cosmos_crypto::secure_asset::AssetBinding,
    ) -> cosmos_protocol::common::encryption::EncryptedData {
        cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: KID.to_owned(),
                },
            ),
            data: cosmos_crypto::secure_asset::seal_secure_asset(&KEY, KID, bytes, binding)
                .unwrap(),
        }
    }

    /// Capture search matches on private vision captions and starts the vision
    /// indexer, so only a verified web caller may run it: a device-plane
    /// caller is refused before any capture is read or ranked.
    #[tokio::test]
    async fn capture_search_answers_only_the_web_plane() {
        let store = fresh();
        store
            .create_memory("U:alice", photo("cam-1"))
            .await
            .unwrap();
        let app = router_with_objects(
            store,
            fresh_keys(),
            DEMO_PRINCIPAL,
            internet_facing(),
            Some(test_verifier()),
            Some(crate::services::capture::CaptureObjectStore::for_tests()),
        );

        let (status, body) = send(
            &app,
            axum::http::Method::GET,
            "/capture/search?query=cat",
            &device_headers("alice"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, serde_json::Value::Null, "nothing about a match leaks");

        let (status, web) = send(
            &app,
            axum::http::Method::GET,
            "/capture/search?query=cat",
            &[bearer_header("alice")],
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the signed-in wearer still searches"
        );
        assert_eq!(web["totalElements"], 0);
    }

    /// A VIDEO opens under the stock video binding (capture domain 2, object
    /// 1) and is served as MP4 with `Range`, so a `<video>` can seek, and
    /// only to a signed-in wearer.
    #[tokio::test]
    async fn video_file_is_served_with_range_on_web_plane_only() {
        let store = fresh();
        let objects = crate::services::capture::CaptureObjectStore::for_tests();
        let mp4: Vec<u8> = (0u8..=99).collect();
        let video = store
            .create_memory(
                "U:alice",
                NewMemory {
                    kind: MemoryKind::Video,
                    thumbnails: vec![sealed(
                        b"poster",
                        cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
                    )],
                    metadata: CaptureMetadata {
                        encryption_kid: KID.to_owned(),
                        num_videos: 1,
                        total_video_duration_sec: 15,
                        ..CaptureMetadata::default()
                    },
                    ..photo("clip")
                },
            )
            .await
            .unwrap();
        let slot = video.bursts[0].files[0].secure_filename.clone();
        let sealed_video = cosmos_crypto::secure_asset::seal_secure_asset(
            &KEY,
            KID,
            &mp4,
            cosmos_crypto::secure_asset::CAPTURE_VIDEO,
        )
        .unwrap();
        objects
            .accept(
                &objects.grant_for_tests("U:alice", &slot),
                Some(&slot),
                &sealed_video,
            )
            .await
            .unwrap();
        let app = full_router(store, keys_with_capture_key().await, Some(objects));
        let alice = [bearer_header("alice")];
        let uri = format!("/capture/memory/{}/file/0", video.uuid);
        let get_method = axum::http::Method::GET;

        let (status, headers, body) = raw(&app, get_method.clone(), &uri, &alice).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "video/mp4");
        assert_eq!(headers["accept-ranges"], "bytes");
        assert_eq!(headers["cache-control"], "private, no-store");
        assert_eq!(body, mp4);

        let ranged = |range: &'static str| {
            let mut headers = alice.to_vec();
            headers.push(("range", range.to_owned()));
            headers
        };
        let (status, headers, body) =
            raw(&app, get_method.clone(), &uri, &ranged("bytes=2-5")).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(headers["content-range"], "bytes 2-5/100");
        assert_eq!(headers["content-length"], "4");
        assert_eq!(headers["content-type"], "video/mp4");
        assert_eq!(body, vec![2, 3, 4, 5]);
        let (_, headers, body) = raw(&app, get_method.clone(), &uri, &ranged("bytes=97-")).await;
        assert_eq!(headers["content-range"], "bytes 97-99/100");
        assert_eq!(body, vec![97, 98, 99]);
        let (_, headers, body) = raw(&app, get_method.clone(), &uri, &ranged("bytes=-2")).await;
        assert_eq!(headers["content-range"], "bytes 98-99/100");
        assert_eq!(body, vec![98, 99]);
        let (_, _, body) = raw(&app, get_method.clone(), &uri, &ranged("bytes=90-500")).await;
        assert_eq!(
            body,
            (90u8..=99).collect::<Vec<_>>(),
            "an end past the file is clamped"
        );
        let (status, headers, _) = raw(&app, get_method.clone(), &uri, &ranged("bytes=100-")).await;
        assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(headers["content-range"], "bytes */100");
        let (status, _, body) = raw(&app, get_method.clone(), &uri, &ranged("bytes=0-1,4-5")).await;
        assert_eq!(status, StatusCode::OK, "multiple ranges are served whole");
        assert_eq!(body.len(), 100);

        let (status, headers, body) = raw(&app, axum::http::Method::HEAD, &uri, &alice).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-length"], "100", "HEAD answers the size");
        assert!(body.is_empty());

        let (status, headers, body) =
            raw(&app, get_method.clone(), &format!("{uri}/download"), &alice).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers["content-disposition"],
            format!("attachment; filename=\"capture-{}.mp4\"", video.uuid)
        );
        assert_eq!(body, mp4);
        let (status, _, _) = raw(
            &app,
            get_method.clone(),
            &format!("{uri}/download?rawData=true"),
            &alice,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "no raw sensor data is ever stored"
        );

        let (status, _, body) = raw(&app, get_method.clone(), &uri, &device_headers("alice")).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "the Pin never receives opened media"
        );
        assert!(body.is_empty());
        let (status, _, _) = raw(&app, get_method.clone(), &uri, &[]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = raw(&app, get_method, &uri, &[bearer_header("bob")]).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "bob holds no such capture");
    }

    /// THE ONE SHARE AUTHORITY, END TO END ON THE WEB.
    ///
    // Unrecorded synthetic JPEG/XMP fixture: public recipients must not receive
    // embedded location metadata unless the capture owner opts in.
    #[tokio::test]
    async fn privacy_shared_thumbnail_strips_location_metadata_and_uses_owner_consent() {
        use prost::Message;
        use std::io::Cursor;
        let image = image::RgbImage::from_pixel(8, 8, image::Rgb([20, 40, 60]));
        let mut output = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut output, image::ImageFormat::Jpeg)
            .unwrap();
        let original = output.into_inner();
        let xmp = b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x='adobe:ns:meta/' xmlns:exif='http://ns.adobe.com/exif/1.0/'><exif:GPSLatitude>52.1</exif:GPSLatitude><exif:GPSLongitude>21.2</exif:GPSLongitude></x:xmpmeta>";
        let mut jpeg = original[..2].to_vec();
        jpeg.extend_from_slice(&[0xff, 0xe1]);
        jpeg.extend_from_slice(&((xmp.len() + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(xmp);
        jpeg.extend_from_slice(&original[2..]);
        let store = fresh();
        let record = store
            .create_memory(
                "U:alice",
                NewMemory {
                    thumbnails: vec![sealed(
                        &jpeg,
                        cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
                    )],
                    ..photo("location-sharing")
                },
            )
            .await
            .unwrap();
        let app = full_router(store.clone(), keys_with_capture_key().await, None);
        let (_, link) = send(
            &app,
            axum::http::Method::POST,
            &format!("/capture/memory/{}/share-link", record.uuid),
            &[bearer_header("alice")],
            None,
        )
        .await;
        let signature = link["url"]
            .as_str()
            .unwrap()
            .rsplit("signature=")
            .next()
            .unwrap();
        let uri = format!(
            "/share/capture/{}/thumbnail?expiry={}&signature={signature}",
            record.uuid, link["expiry"]
        );
        let enabled = cosmos_protocol::privacy::grpc::r#pub::GetSettingsResponse {
            settings: vec![cosmos_protocol::privacy::grpc::common::PrivacySettingInfo {
                name: "share_capture_location".into(),
                value: "on".into(),
                ..Default::default()
            }],
        }
        .encode_to_vec();
        store
            .put_account_blob(
                "U:bob",
                crate::store::AccountBlobKind::PrivacySettings,
                &enabled,
            )
            .await
            .unwrap();
        let (status, _, body) = raw(&app, axum::http::Method::GET, &uri, &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body, original,
            "another wearer's consent must not leak Alice's location"
        );
        image::load_from_memory(&body).expect("recipient still receives a working JPEG");
        store
            .put_account_blob(
                "U:alice",
                crate::store::AccountBlobKind::PrivacySettings,
                &enabled,
            )
            .await
            .unwrap();
        assert_eq!(
            raw(&app, axum::http::Method::GET, &uri, &[]).await.2,
            jpeg,
            "explicit owner consent preserves the shared metadata"
        );
    }

    /// The web share button mints the stock-shaped link. The public frame read
    /// opens it without any identity. And every way a link can be wrong,
    /// forged, retargeted, expired, truncated, is the same 404.
    #[tokio::test]
    async fn public_share_thumbnail_rejects_bad_signature_and_expired_capability() {
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(8, 8, image::Rgb([30, 40, 50])))
            .write_to(&mut encoded, image::ImageFormat::Jpeg)
            .unwrap();
        let hero = encoded.into_inner();
        let store = fresh();
        let record = store
            .create_memory(
                "U:alice",
                NewMemory {
                    thumbnails: vec![sealed(
                        &hero,
                        cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
                    )],
                    ..photo("shared")
                },
            )
            .await
            .unwrap();
        let other = store
            .create_memory("U:alice", photo("other"))
            .await
            .unwrap();
        let app = full_router(store.clone(), keys_with_capture_key().await, None);
        let share_uri = format!("/capture/memory/{}/share-link", record.uuid);

        let (status, _) = send(
            &app,
            axum::http::Method::POST,
            &share_uri,
            &device_headers("alice"),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "sharing is the wearer's web action"
        );
        let (status, _) = send(
            &app,
            axum::http::Method::POST,
            &share_uri,
            &[bearer_header("bob")],
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "bob cannot share alice's capture"
        );

        let (status, link) = send(
            &app,
            axum::http::Method::POST,
            &share_uri,
            &[bearer_header("alice")],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(link["memoryUuid"], record.uuid);
        let url = link["url"].as_str().unwrap();
        let expected_prefix = format!(
            "{SHARE_BASE}/humane.center/share/capture/{}?expiry={}&signature=",
            record.uuid, link["expiry"]
        );
        assert!(url.starts_with(&expected_prefix), "{url}");
        let signature = url.rsplit("signature=").next().unwrap().to_owned();
        let expiry = link["expiry"].as_i64().unwrap();

        let read = |uuid: &str, expiry: i64, signature: &str| {
            format!("/share/capture/{uuid}/thumbnail?expiry={expiry}&signature={signature}")
        };
        let (status, headers, body) = raw(
            &app,
            axum::http::Method::GET,
            &read(&record.uuid, expiry, &signature),
            &[],
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the link is the whole authorization"
        );
        assert_eq!(body, hero);
        assert_eq!(headers["content-type"], "image/jpeg");
        assert_eq!(headers["cache-control"], "private, no-store");
        assert_eq!(headers["referrer-policy"], "no-referrer");

        let mut forged = signature.clone();
        let last = forged.pop().unwrap();
        forged.push(if last == 'A' { 'B' } else { 'A' });
        let expired = ShareAuthority::for_tests(Some(SHARE_BASE))
            .mint_until("U:alice", &record.uuid, 1)
            .unwrap();
        let expired_signature = expired.url.rsplit("signature=").next().unwrap().to_owned();
        for uri in [
            read(&record.uuid, expiry, &forged),
            read(&record.uuid, expiry + 60, &signature),
            read(&other.uuid, expiry, &signature),
            read(&record.uuid, 1, &expired_signature),
            format!("/share/capture/{}/thumbnail?expiry={expiry}", record.uuid),
            format!("/share/capture/{}/thumbnail", record.uuid),
        ] {
            let (status, _, body) = raw(&app, axum::http::Method::GET, &uri, &[]).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
            assert!(body.is_empty() || body.len() < 64, "{uri} leaked a frame");
        }

        // A deployment with no share base URL mints nothing, and says sharing
        // is not set up (501), never a link that goes nowhere.
        let unconfigured = router_with_share(
            ApiState::for_tests(
                store,
                fresh_keys(),
                DEMO_PRINCIPAL,
                internet_facing(),
                Some(test_verifier()),
                None,
            ),
            ShareAuthority::for_tests(None),
        );
        let (status, _) = send(
            &unconfigured,
            axum::http::Method::POST,
            &share_uri,
            &[bearer_header("alice")],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    }
}
