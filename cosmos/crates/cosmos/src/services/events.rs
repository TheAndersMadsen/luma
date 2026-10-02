//! `humane.events`, device event history + ingest.
//!
//! Two services share this wire package:
//!
//! * `DeviceEventsHistoryService.QueryEvents`, the device asks the cloud for
//!   previously stored notable events (calendar-ish activity, reminders, etc.).
//!   These are served from [`crate::store::Store::query_events`], honouring the
//!   device's type/originator filters and its time window (history restore sends
//!   `event_start_time = now − 1 day`). A principal with nothing stored gets a
//!   well-formed *empty* result, not an error, but an empty answer now means
//!   genuinely nothing stored, never a store failure, which is why the read is
//!   `Written` and a failure surfaces as UNAVAILABLE.
//!
//! * `EventsIngestService.Ingest` / `.IngestBatch`, the device streams notable
//!   events up to the cloud and expects a stream of identifier acks back. Both
//!   are bidirectional streams. Events are PERSISTED, upserted on
//!   `event_identifier`, and only the identifiers actually committed are
//!   acknowledged. We never mint identifiers: the ack echoes the client-supplied
//!   `event_identifier`.
//!
//!   Acking without persisting would be the worst of both worlds, the device
//!   clears `needs_sync` on the ack and the event is gone. `SyncEngine`
//!   re-sends its whole unsynced table every sync (`WHERE needs_sync = 1`, no
//!   `LIMIT`) under a 35 s deadline, so the batch is unbounded and is committed
//!   in chunks inside one transaction rather than one round trip per event.
//!
//!   **Store and ack, whatever the key directory says.** An event Cosmos cannot
//!   open, no escrowed key yet, an envelope it does not recognise, or a key
//!   directory that is down, is stored sealed, unindexed, and acknowledged.
//!   Refusing it used to keep the device's row unsynced for a retry, but the
//!   stock `NotableEventsTtlWorker` deletes local rows older than 14 days with
//!   no sync predicate (`NotableEventsDao.getEventsSinceTimestamp`:
//!   `WHERE creationTime < ?`), so a retry that waited on a key lost the
//!   wearer's history for good. The sealed row loses nothing: the first
//!   verified web read that can open it backfills its search index
//!   ([`open_for_web`]).
//!
//! Transport auth is terminated at the mesh edge (see [`crate::auth`]). These
//! handlers trust the edge-injected principal and hold no per-request state,
//! matching the `provisioning` handler's idiom.

use std::pin::Pin;

use cosmos_protocol::events as pb;
use pb::device_events_history_service_server::DeviceEventsHistoryService;
use pb::events_ingest_service_server::EventsIngestService;
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};

/// `humane.events.DeviceEventsHistoryService`.
#[derive(Clone)]
pub struct DeviceEventsHistory {
    authenticator: crate::auth::RequestAuthenticator,
    store: crate::store::SharedStore,
    keys: crate::keydirectory::SharedKeyDirectory,
}

impl DeviceEventsHistory {
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        store: crate::store::SharedStore,
        keys: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        Self {
            authenticator,
            store,
            keys,
        }
    }
}

impl Default for DeviceEventsHistory {
    fn default() -> Self {
        Self::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            crate::store::MemoryStore::shared(),
            std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
        )
    }
}

#[tonic::async_trait]
impl DeviceEventsHistoryService for DeviceEventsHistory {
    /// Return the wearer's stored history.
    ///
    /// This is the one thing the service exists for: after a factory reset or on
    /// a new device, it is what restores what the wearer did. Acking ingest
    /// without persisting looks fine day to day, the Pin keeps its own DB, and
    /// then loses everything exactly when it matters.
    async fn query_events(
        &self,
        request: Request<pb::DeviceEventQueryRequest>,
    ) -> Result<Response<pb::EventsQueryResponse>, Status> {
        let authenticated = self.authenticator.authenticate_with_plane(&request)?;
        let owner = authenticated
            .principal
            .expose_for_authorization()
            .to_owned();
        let query = request.into_inner();
        let filters = query.filters.unwrap_or_default();
        let one = |value: String| {
            if value.is_empty() {
                Vec::new()
            } else {
                vec![value]
            }
        };
        let filter = crate::store::EventFilter {
            types: one(filters.event_type),
            originators: one(filters.event_originator_id),
            // A Pin restores what Pins recorded. Center's typed chat turns are
            // the web's (INFERRED: humane.center had no chat), and restoring
            // them would put plaintext answers the wearer never spoke into the
            // Pin's own history.
            excluded_originators: if authenticated.plane == crate::auth::AuthenticationPlane::Device
            {
                vec![crate::http::CENTER_CHAT_ORIGINATOR.to_owned()]
            } else {
                Vec::new()
            },
            // The device sends a time window (history restore = now − 1 day);
            // honor it rather than returning every stored event.
            start: filters
                .event_start_time
                .as_ref()
                .map(crate::store::SyncTime::from_proto),
            end: filters
                .event_end_time
                .as_ref()
                .map(crate::store::SyncTime::from_proto),
            oldest_first: false,
        };
        let limit = if query.max_results > 0 {
            i64::from(query.max_results)
        } else {
            i64::MAX
        };
        let mut found = self
            .store
            .query_event_page(&owner, &filter, 0, limit)
            .await?
            .records;
        if authenticated.plane == crate::auth::AuthenticationPlane::Web {
            let mut backfill = Vec::new();
            for event in &mut found {
                // A row this directory cannot open stays sealed in the answer,
                // exactly as the device plane receives it. Only a directory
                // that cannot answer fails the read.
                let web = open_for_web(&self.keys, event)
                    .await
                    .map_err(|error| crate::keydirectory::grpc_status(&error))?;
                event.event_data = web.data;
                backfill.extend(web.backfill);
            }
            persist_backfill(&self.store, &owner, &backfill).await;
        }
        Ok(Response::new(pb::EventsQueryResponse {
            events: found.into_iter().map(to_wire_event).collect(),
        }))
    }
}

/// One stored event as a verified web read sees it.
pub(crate) struct WebEvent {
    /// The event's properties: the plaintext the device sent, or the sealed
    /// copy opened. `None` when the row stays sealed for this directory.
    pub(crate) data: Option<prost_types::Struct>,
    /// The search-index backfill to persist when this read was the first to
    /// open a searchable row: only the derived lowercase index, never the
    /// plaintext.
    pub(crate) backfill: Option<crate::store::EventSearchIndex>,
}

/// Open one stored event for a verified web read.
///
/// `Err` only when the key directory could not answer. A missing key, an
/// unusable key id, or an envelope that does not open leaves the row sealed
/// (`data: None`) and is logged, so one unopenable row can never blank a page.
pub(crate) async fn open_for_web(
    keys: &crate::keydirectory::SharedKeyDirectory,
    record: &crate::store::NotableEventRecord,
) -> Result<WebEvent, crate::keydirectory::KeyDirectoryError> {
    if let Some(data) = &record.event_data {
        return Ok(WebEvent {
            data: Some(data.clone()),
            backfill: None,
        });
    }
    let Some(opened) = open_event(
        keys,
        &record.event_identifier,
        record.encrypted_event_data.as_ref(),
    )
    .await?
    else {
        return Ok(WebEvent {
            data: None,
            backfill: None,
        });
    };
    // Events stored before their key arrived remain sealed at rest, and become
    // searchable once an authorised read proves Cosmos can open them.
    let backfill = if record.indexed_text.is_none() {
        event_search_text(&record.event_type, Some(&opened)).map(|text| {
            crate::store::EventSearchIndex {
                event_identifier: record.event_identifier.clone(),
                indexed_text: text.to_lowercase(),
            }
        })
    } else {
        None
    };
    Ok(WebEvent {
        data: Some(opened),
        backfill,
    })
}

/// Write back the search indexes a web read derived. Best effort: the read has
/// already answered, and the next one derives the same index again.
///
/// Only onto rows that still exist ([`crate::store::Store::backfill_event_index`]):
/// the wearer can forget an event while the read that opened it is still
/// running, and writing the row back would bring it back.
pub(crate) async fn persist_backfill(
    store: &crate::store::SharedStore,
    owner: &str,
    backfill: &[crate::store::EventSearchIndex],
) {
    if !backfill.is_empty()
        && let Err(error) = store.backfill_event_index(owner, backfill).await
    {
        tracing::warn!(?error, "notable-event search-index backfill failed");
    }
}

/// Store record -> wire event. Only what the device gave us is returned.
fn to_wire_event(record: crate::store::NotableEventRecord) -> pb::NotableEvent {
    pb::NotableEvent {
        event_identifier: Some(pb::Uuid {
            value: record.event_identifier,
        }),
        originator_identifier: record.originator_identifier,
        creation_time: record.creation_time.map(|t| prost_types::Timestamp {
            seconds: t.seconds(),
            nanos: t.nanos(),
        }),
        event_data: record.event_data,
        event_type: record.event_type,
        encrypted_event_data: record.encrypted_event_data,
        encrypted_location: record.encrypted_location,
        device_is_locked: record.device_is_locked,
    }
}

/// The event types a wearer can actually search.
///
/// Humane's own support article scopes this deliberately, "Only Ai Mic and Music
/// events are searchable", so this list is a faithfulness rule, not a shortcut.
/// The names are the device's own (`humane.ui.notableevents.NotableEvent`:
/// `EVENT_TYPE_RESPOND`, `EVENT_TYPE_VISION_RESPOND`, and the four music track
/// types). A vision answer is an Ai Mic answer: `RespondActionHandler` records
/// `VisionRespondNotableEvent` instead of `RespondNotableEvent` whenever the run
/// looked at the scene, with the same `request`/`response` properties.
pub const SEARCHABLE_EVENT_TYPES: &[&str] = &[
    "humane.respond",
    "humane.respond.vision",
    "humane.playMusicTrack",
    "humane.pauseMusicTrack",
    "humane.completedMusicTrack",
    "humane.skippedMusicTrack",
];

/// Properties worth indexing, per the recovered wire shapes.
///
/// `humane.respond` carries `request`/`response` (RespondNotableEvent). The music
/// types include `trackTitle`/`artistName`/`albumName` (TrackNotableEvent). Both are
/// corroborated by the .Center dashboard's own `eventData` mappers.
const INDEXED_PROPERTIES: &[&str] = &[
    "request",
    "response",
    "trackTitle",
    "artistName",
    "albumName",
];

/// Flatten an opened event's `event_data` into searchable text.
///
/// Only the properties above, and only for searchable types: an event we cannot
/// open, or one outside the scope, is left unindexed rather than indexed as
/// garbage, unsearchable is bad, wrong results are worse.
fn event_search_text(event_type: &str, data: Option<&prost_types::Struct>) -> Option<String> {
    if !SEARCHABLE_EVENT_TYPES.contains(&event_type) {
        return None;
    }
    let data = data?;
    let mut parts: Vec<String> = Vec::new();
    for key in INDEXED_PROPERTIES {
        if let Some(value) = data.fields.get(*key) {
            if let Some(prost_types::value::Kind::StringValue(text)) = value.kind.as_ref() {
                if !text.trim().is_empty() {
                    parts.push(text.trim().to_owned());
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// Wire event -> store record. Events with no identifier have no key and are
/// dropped by the store.
fn to_record(event: pb::NotableEvent) -> crate::store::NotableEventRecord {
    let indexed_text =
        event_search_text(&event.event_type, event.event_data.as_ref()).map(|t| t.to_lowercase());
    crate::store::NotableEventRecord {
        event_identifier: event.event_identifier.map(|u| u.value).unwrap_or_default(),
        originator_identifier: event.originator_identifier,
        creation_time: event
            .creation_time
            .map(|t| crate::store::SyncTime::from_parts(t.seconds, t.nanos)),
        event_type: event.event_type,
        // Indexed from the PLAINTEXT copy when the device sent one. A real Pin
        // clears it and sends only the sealed copy, which `index_event` opens on
        // ingest, see `EventsIngest`.
        indexed_text,
        event_data: event.event_data,
        encrypted_event_data: event.encrypted_event_data,
        encrypted_location: event.encrypted_location,
        device_is_locked: event.device_is_locked,
        ingested: crate::store::SyncTime::now(),
    }
}

/// `humane.events.EventsIngestService`.
#[derive(Clone)]
pub struct EventsIngest {
    authenticator: crate::auth::RequestAuthenticator,
    store: crate::store::SharedStore,
    /// Needed to INDEX an event, not to store one.
    /// `NotableEventsManager.encryptEventData` seals `event_data` and then calls
    /// `clearEventData()`, so on the wire from a real Pin the content exists only
    /// in `encrypted_event_data`. Without the channel keys every ingested event
    /// is an opaque blob and "what did I ask last week" can never be answered.
    keys: crate::keydirectory::SharedKeyDirectory,
}

/// Fill in one event's searchable text when its content arrived sealed. See
/// [`index_batch`].
#[cfg(test)]
async fn indexed(
    keys: &crate::keydirectory::SharedKeyDirectory,
    mut record: crate::store::NotableEventRecord,
) -> crate::store::NotableEventRecord {
    index_batch(keys, std::slice::from_mut(&mut record)).await;
    record
}

/// The key id a sealed event names. Empty when it names none.
fn kid_of(sealed: &cosmos_protocol::common::encryption::EncryptedData) -> &str {
    sealed
        .encryption_information
        .as_ref()
        .map(|information| information.kid.as_str())
        .unwrap_or_default()
}

/// The key id ingest must look up to index this event, or `None` when it has
/// nothing to open: an index already derived from the plaintext copy, a type
/// outside [`SEARCHABLE_EVENT_TYPES`], or no sealed copy.
fn kid_to_open(record: &crate::store::NotableEventRecord) -> Option<&str> {
    if record.indexed_text.is_some()
        || !SEARCHABLE_EVENT_TYPES.contains(&record.event_type.as_str())
    {
        return None;
    }
    record.encrypted_event_data.as_ref().map(kid_of)
}

/// The distinct key ids a batch needs, in first-appearance order.
fn kids_to_look_up(records: &[crate::store::NotableEventRecord]) -> Vec<&str> {
    let mut seen = std::collections::HashSet::new();
    records
        .iter()
        .filter_map(kid_to_open)
        .filter(|kid| seen.insert(*kid))
        .collect()
}

/// Fill in the searchable text of every event in a batch whose content
/// arrived sealed, and never refuse an event over it.
///
/// Only the searchable types are opened: nothing else is ever indexed, so
/// opening a sealed weather or call event here would be work with no result.
/// Whatever stops the open, no key yet, an envelope this directory does not
/// recognise, a key directory that is down, the event is still stored and
/// acknowledged, sealed and unindexed. See the module note on store and ack.
///
/// One directory lookup per distinct key id, never one per event. Stock seals
/// each event under a key of its own (`NotableEventsManager.encryptEventData`
/// → `CoreDataProtector.protect`, which calls `generateKey`), so what this
/// buys is the outage: the batch is the Pin's whole unsynced table under a
/// 35 s `SyncEngine` deadline, and a lookup against a directory that is down
/// can wait out the pool's acquire timeout. The first lookup the directory
/// cannot answer therefore ends the lookups for the batch, and the rest of its
/// events are stored sealed like that one, for the first web read to backfill.
async fn index_batch(
    keys: &crate::keydirectory::SharedKeyDirectory,
    records: &mut [crate::store::NotableEventRecord],
) {
    let mut found = std::collections::HashMap::new();
    for kid in kids_to_look_up(records) {
        match lookup_key(keys, kid).await {
            Ok(key) => {
                found.insert(kid.to_owned(), key);
            }
            Err(error) => {
                tracing::warn!(
                    %error,
                    shared = keys.is_shared(),
                    "key directory unavailable; storing the batch's unopened notable events \
                     sealed and acknowledging them"
                );
                break;
            }
        }
    }
    for record in records.iter_mut() {
        let text = match kid_to_open(record).map(|kid| (kid, found.get(kid))) {
            // Nothing to open, or the directory went down before this key id.
            None | Some((_, None)) => continue,
            Some((_, Some(Err(what)))) => {
                crate::web_api::key_directory_miss(keys, &record.event_identifier, what);
                continue;
            }
            Some((kid, Some(Ok(key)))) => record
                .encrypted_event_data
                .as_ref()
                .and_then(|sealed| open_with_key(keys, &record.event_identifier, key, kid, sealed))
                .and_then(|data| event_search_text(&record.event_type, Some(&data)))
                .map(|text| text.to_lowercase()),
        };
        record.indexed_text = text;
    }
}

/// A key the directory answered for: the key, or why the event stays sealed.
type KeyLookup = Result<[u8; cosmos_crypto::AES_KEY_LEN], &'static str>;

/// Look up one key id. `Err` only when the directory could not answer. A
/// missing key or an unusable id is an answer.
async fn lookup_key(
    keys: &crate::keydirectory::SharedKeyDirectory,
    kid: &str,
) -> Result<KeyLookup, crate::keydirectory::KeyDirectoryError> {
    use crate::keydirectory::KeyDirectoryError;
    match keys.get(kid).await {
        Ok(Some(key)) => Ok(Ok(key)),
        Ok(None) => Ok(Err("no channel key for this notable event")),
        Err(KeyDirectoryError::InvalidKid) => Ok(Err("the notable event names no usable key id")),
        Err(error) => Err(error),
    }
}

/// Open a sealed `event_data` into the `google.protobuf.Struct` the device
/// sealed (`NotableEventsManager.encryptEventData` protects the event's Struct,
/// then `clearEventData()`).
///
/// `Ok(None)` when the event stays sealed, no envelope, no key under its id,
/// an unusable id, or bytes that do not open or decode, each logged with the
/// event id and never the key id, which carries the wearer's device and user
/// ids. `Err` only when the directory could not answer.
async fn open_event(
    keys: &crate::keydirectory::SharedKeyDirectory,
    event_identifier: &str,
    sealed: Option<&cosmos_protocol::common::encryption::EncryptedData>,
) -> Result<Option<prost_types::Struct>, crate::keydirectory::KeyDirectoryError> {
    let Some(sealed) = sealed else {
        return Ok(None);
    };
    let kid = kid_of(sealed);
    match lookup_key(keys, kid).await? {
        Ok(key) => Ok(open_with_key(keys, event_identifier, &key, kid, sealed)),
        Err(what) => {
            crate::web_api::key_directory_miss(keys, event_identifier, what);
            Ok(None)
        }
    }
}

/// Open a sealed event with the key its id named. Two envelopes: the stock
/// HMSA SecureAsset under the wearer's escrowed user key
/// (`NOTABLE_EVENT_DATA`), and the service-channel envelope the clone's own
/// writers used. `None`, logged, when it does not open or decode.
fn open_with_key(
    keys: &crate::keydirectory::SharedKeyDirectory,
    event_identifier: &str,
    key: &[u8; cosmos_crypto::AES_KEY_LEN],
    kid: &str,
    sealed: &cosmos_protocol::common::encryption::EncryptedData,
) -> Option<prost_types::Struct> {
    use prost::Message as _;

    let plaintext = if sealed.data.get(4..8) == Some(b"HMSA") {
        cosmos_crypto::secure_asset::open_secure_asset(
            key,
            kid,
            &sealed.data,
            cosmos_crypto::secure_asset::NOTABLE_EVENT_DATA,
        )
        .ok()
    } else {
        cosmos_crypto::open(
            key,
            &cosmos_crypto::EncryptedData {
                data: sealed.data.clone(),
                kid: kid.to_owned(),
            },
        )
        .ok()
    };
    let Some(plaintext) = plaintext else {
        crate::web_api::key_directory_miss(
            keys,
            event_identifier,
            "held the notable event's key but the envelope did not open",
        );
        return None;
    };
    match prost_types::Struct::decode(plaintext.as_slice()) {
        Ok(data) => Some(data),
        Err(_) => {
            crate::web_api::key_directory_miss(
                keys,
                event_identifier,
                "notable event opened but is not a Struct",
            );
            None
        }
    }
}

/// Reject an empty device batch before constructing an outbound acknowledgement.
///
/// The stock sync engine treats *any* `onNext` as success for the original
/// unsynced rows, even when its encryption stage filtered every row and sent an
/// empty batch. Returning a successful response here would therefore tell it to
/// clear data the server never received. A stream error keeps those rows pending
/// so a later privacy/key repair can retry them.
fn require_events(batch: &pb::IngestBatchRequest) -> Result<(), Status> {
    if batch.events.is_empty() {
        Err(Status::invalid_argument(
            "ingest batch contains no persistable events",
        ))
    } else {
        Ok(())
    }
}

/// Persist one device batch and acknowledge exactly the identifiers stored.
///
/// Every event in it is stored, opened or not (store and ack). The only
/// failures the device sees are an empty batch and a store that could not
/// commit, both of which keep its rows unsynced for the next sync.
async fn store_batch(
    store: &crate::store::SharedStore,
    keys: &crate::keydirectory::SharedKeyDirectory,
    owner: &str,
    batch: pb::IngestBatchRequest,
) -> Result<pb::IngestBatchResponse, Status> {
    require_events(&batch)?;
    let mut records: Vec<_> = batch.events.into_iter().map(to_record).collect();
    // Stock NotableEventsAccessImpl.uploadNotableEvent gates event locations.
    // INFERRED cloud enforcement also covers uploads before settings sync.
    let privacy = crate::services::public_privacy::AccountPrivacy::load(store, owner).await?;
    if !privacy.location_allowed || !privacy.save_event_location {
        for record in &mut records {
            record.encrypted_location = None;
        }
    }
    index_batch(keys, &mut records).await;
    let stored = store.ingest_events(owner, &records).await?;
    Ok(pb::IngestBatchResponse {
        event_identifier: stored.into_iter().map(|value| pb::Uuid { value }).collect(),
    })
}

impl EventsIngest {
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        store: crate::store::SharedStore,
        keys: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        Self {
            authenticator,
            store,
            keys,
        }
    }
}

impl Default for EventsIngest {
    fn default() -> Self {
        Self::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            crate::store::MemoryStore::shared(),
            std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
        )
    }
}

#[tonic::async_trait]
impl EventsIngestService for EventsIngest {
    type IngestBatchStream =
        Pin<Box<dyn Stream<Item = Result<pb::IngestBatchResponse, Status>> + Send + 'static>>;

    async fn ingest_batch(
        &self,
        request: Request<Streaming<pb::IngestBatchRequest>>,
    ) -> Result<Response<Self::IngestBatchStream>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let owner = principal.expose_for_authorization().to_owned();
        let store = self.store.clone();
        let keys = self.keys.clone();
        let inbound = request.into_inner();
        // Persist each batch, then ack with the identifiers actually stored.
        // Ingest is an upsert keyed on the device-minted identifier, the device
        // re-sends on every sync, so it must be idempotent, and an event with no
        // identifier has no key and is dropped rather than duplicated.
        // Persisting is async now, so each item is mapped through an async block
        // rather than a sync closure. Ordering is preserved: `then` does not
        // start the next item until this one resolves, which matters because
        // ingest is an upsert and the device may re-send within one stream.
        let outbound = inbound.then(move |item| {
            let store = store.clone();
            let owner = owner.clone();
            let keys = keys.clone();
            async move {
                match item {
                    Ok(batch) => store_batch(&store, &keys, &owner, batch).await,
                    Err(status) => Err(status),
                }
            }
        });
        let stream: Self::IngestBatchStream = Box::pin(outbound);
        Ok(Response::new(stream))
    }

    type IngestStream =
        Pin<Box<dyn Stream<Item = Result<pb::IngestResponse, Status>> + Send + 'static>>;

    async fn ingest(
        &self,
        request: Request<Streaming<pb::NotableEvent>>,
    ) -> Result<Response<Self::IngestStream>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let owner = principal.expose_for_authorization().to_owned();
        let store = self.store.clone();
        let keys = self.keys.clone();
        let inbound = request.into_inner();
        // Persist, then ack with the identifier actually stored.
        let outbound = inbound.then(move |item| {
            let store = store.clone();
            let owner = owner.clone();
            let keys = keys.clone();
            async move {
                match item {
                    Ok(event) => {
                        let stored = store_batch(
                            &store,
                            &keys,
                            &owner,
                            pb::IngestBatchRequest {
                                events: vec![event],
                            },
                        )
                        .await?;
                        Ok(pb::IngestResponse {
                            event_identifier: stored.event_identifier.into_iter().next(),
                        })
                    }
                    Err(status) => Err(status),
                }
            }
        });
        let stream: Self::IngestStream = Box::pin(outbound);
        Ok(Response::new(stream))
    }
}

#[cfg(test)]
mod tests {

    /// A Struct with string properties, the shape `NotableEvent.toProtobuf`
    /// fills for a `RespondNotableEvent`.
    fn strings(pairs: &[(&str, &str)]) -> prost_types::Struct {
        prost_types::Struct {
            fields: pairs
                .iter()
                .map(|(key, value)| {
                    (
                        (*key).to_owned(),
                        prost_types::Value {
                            kind: Some(prost_types::value::Kind::StringValue((*value).to_owned())),
                        },
                    )
                })
                .collect(),
        }
    }

    /// `data` sealed the way a stock Pin seals it: an HMSA SecureAsset under
    /// the wearer's user key, bound to the notable-events domain.
    fn stock_sealed(
        kid: &str,
        key: &[u8; cosmos_crypto::AES_KEY_LEN],
        data: &prost_types::Struct,
    ) -> cosmos_protocol::common::encryption::EncryptedData {
        use prost::Message as _;
        cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: kid.to_owned(),
                },
            ),
            data: cosmos_crypto::secure_asset::seal_secure_asset(
                key,
                kid,
                &data.encode_to_vec(),
                cosmos_crypto::secure_asset::NOTABLE_EVENT_DATA,
            )
            .expect("seal a stock notable event"),
        }
    }

    /// The wire event a stock Pin uploads: plaintext cleared, content sealed.
    fn sealed_event(
        id: &str,
        kind: &str,
        sealed: cosmos_protocol::common::encryption::EncryptedData,
    ) -> pb::NotableEvent {
        pb::NotableEvent {
            event_identifier: Some(pb::Uuid {
                value: id.to_owned(),
            }),
            originator_identifier: "humane.experience.answers".to_owned(),
            creation_time: Some(prost_types::Timestamp {
                seconds: 1_760_000_000,
                nanos: 0,
            }),
            event_data: None,
            event_type: kind.to_owned(),
            encrypted_event_data: Some(sealed),
            encrypted_location: None,
            device_is_locked: false,
        }
    }

    #[tokio::test]
    async fn privacy_events_batch_preserves_content_but_drops_location_without_consent() {
        use prost::Message;
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        let keys = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let batch = || pb::IngestBatchRequest {
            events: vec![pb::NotableEvent {
                event_identifier: Some(pb::Uuid {
                    value: "privacy-event".into(),
                }),
                event_type: "humane.respond".into(),
                event_data: Some(strings(&[("response", "fixture answer")])),
                encrypted_location: Some(cosmos_protocol::common::encryption::EncryptedData {
                    data: vec![10, 20, 30],
                    ..Default::default()
                }),
                ..Default::default()
            }],
        };
        store_batch(&store, &keys, "U:alice", batch())
            .await
            .unwrap();
        let alice = store
            .query_events("U:alice", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(alice.len(), 1);
        assert!(
            alice[0].event_data.is_some(),
            "respond history must still work"
        );
        assert!(
            alice[0].encrypted_location.is_none(),
            "default save_event_location=off is enforced by cloud too"
        );
        let enabled = cosmos_protocol::privacy::grpc::r#pub::GetSettingsResponse {
            settings: vec![cosmos_protocol::privacy::grpc::common::PrivacySettingInfo {
                name: "save_event_location".into(),
                value: "on".into(),
                ..Default::default()
            }],
        };
        store
            .put_account_blob(
                "U:bob",
                crate::store::AccountBlobKind::PrivacySettings,
                &enabled.encode_to_vec(),
            )
            .await
            .unwrap();
        store_batch(&store, &keys, "U:bob", batch()).await.unwrap();
        let bob = store
            .query_events("U:bob", "", "", None, None, 0)
            .await
            .unwrap();
        assert!(bob[0].encrypted_location.is_some());
        assert!(
            store
                .query_events("U:alice", "", "", None, None, 0)
                .await
                .unwrap()[0]
                .encrypted_location
                .is_none()
        );
    }

    /// STORE AND ACK. An event Cosmos cannot open, its key not escrowed yet,
    /// or the key directory down, is stored sealed and acknowledged, because
    /// the stock TTL worker deletes the device's copy after 14 days whether or
    /// not it synced. Once the key arrives, the first verified web read opens
    /// it and backfills its index, so nothing was lost by acknowledging it.
    #[tokio::test]
    async fn ingest_batch_acks_and_stores_unopenable_event_sealed() {
        let kid = "late-user-kid";
        let key = [0x68; cosmos_crypto::AES_KEY_LEN];
        let keys = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        let data = strings(&[("request", "remember the milk"), ("response", "Okay.")]);
        let batch = |id: &str| pb::IngestBatchRequest {
            events: vec![sealed_event(
                id,
                "humane.respond",
                stock_sealed(kid, &key, &data),
            )],
        };

        // No key under that id yet.
        let acked = store_batch(&store, &keys, "U:wearer", batch("evt-no-key"))
            .await
            .expect("an event with no key yet is stored, not refused");
        assert_eq!(acked.event_identifier[0].value, "evt-no-key");

        // The directory cannot answer at all.
        keys.fail_next(crate::keydirectory::DirectoryFault::Get);
        let acked = store_batch(&store, &keys, "U:wearer", batch("evt-outage"))
            .await
            .expect("a key-directory outage does not refuse the event either");
        assert_eq!(acked.event_identifier[0].value, "evt-outage");

        let stored = store
            .query_events("U:wearer", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(stored.len(), 2, "both events are in the cloud");
        for event in &stored {
            assert!(event.indexed_text.is_none(), "unopened, so unindexed");
            assert!(event.encrypted_event_data.is_some(), "kept sealed at rest");
        }

        // The key arrives. A web read opens the row and backfills its index.
        keys.put(kid, key).await.expect("escrow the key");
        let web = open_for_web(&keys, &stored[0]).await.expect("directory up");
        assert_eq!(web.data.as_ref(), Some(&data));
        let backfill = web.backfill.expect("the first open backfills the index");
        assert_eq!(backfill.event_identifier, stored[0].event_identifier);
        assert_eq!(backfill.indexed_text, "remember the milk okay.");
    }

    /// A web read opened a sealed event, and the wearer forgot the event
    /// before the read wrote its index back. The write-back must not bring
    /// the event back. On a row still stored it lands.
    #[tokio::test]
    async fn a_backfill_never_brings_back_a_forgotten_event() {
        let kid = "backfill-user-kid";
        let key = [0x52; cosmos_crypto::AES_KEY_LEN];
        let keys = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        let data = strings(&[("request", "where did I park"), ("response", "Level 2.")]);
        store_batch(
            &store,
            &keys,
            "U:wearer",
            pb::IngestBatchRequest {
                events: vec![
                    sealed_event(
                        "evt-forgotten",
                        "humane.respond",
                        stock_sealed(kid, &key, &data),
                    ),
                    sealed_event("evt-kept", "humane.respond", stock_sealed(kid, &key, &data)),
                ],
            },
        )
        .await
        .expect("stored sealed before the key arrived");
        keys.put(kid, key).await.expect("escrow the key");

        let stored = store
            .query_events("U:wearer", "", "", None, None, 0)
            .await
            .unwrap();
        let mut backfill = Vec::new();
        for record in &stored {
            backfill.extend(open_for_web(&keys, record).await.unwrap().backfill);
        }
        assert_eq!(backfill.len(), 2, "both opened for the first time");

        // Forgotten while the read was still running.
        assert!(
            store
                .delete_event("U:wearer", "evt-forgotten")
                .await
                .unwrap()
        );
        persist_backfill(&store, "U:wearer", &backfill).await;

        let after = store
            .query_events("U:wearer", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(after.len(), 1, "the forgotten event stays forgotten");
        assert_eq!(after[0].event_identifier, "evt-kept");
        assert_eq!(
            after[0].indexed_text.as_deref(),
            Some("where did i park level 2.")
        );
    }

    /// A key directory that cannot answer costs a batch one lookup, not one
    /// per event: after the first failure nothing else is looked up, and every
    /// event is still stored sealed and acknowledged.
    #[tokio::test]
    async fn a_directory_outage_ends_the_batchs_lookups() {
        let key = [0x61; cosmos_crypto::AES_KEY_LEN];
        let keys = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        keys.put("outage-kid-a", key).await.unwrap();
        keys.put("outage-kid-b", key).await.unwrap();
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        let data = strings(&[("request", "play something calm")]);
        let batch = || pb::IngestBatchRequest {
            events: vec![
                sealed_event(
                    "o1",
                    "humane.respond",
                    stock_sealed("outage-kid-a", &key, &data),
                ),
                sealed_event(
                    "o2",
                    "humane.respond",
                    stock_sealed("outage-kid-b", &key, &data),
                ),
                sealed_event(
                    "o3",
                    "humane.respond",
                    stock_sealed("outage-kid-a", &key, &data),
                ),
            ],
        };

        // The injected fault answers exactly one lookup. Were the batch still
        // looking keys up per event (or per key id) after it, the later ones
        // would find the keys and index their events.
        keys.fail_next(crate::keydirectory::DirectoryFault::Get);
        let acked = store_batch(&store, &keys, "U:wearer", batch())
            .await
            .expect("an outage refuses nothing");
        assert_eq!(acked.event_identifier.len(), 3);
        let stored = store
            .query_events("U:wearer", "", "", None, None, 0)
            .await
            .unwrap();
        assert!(stored.iter().all(|event| event.indexed_text.is_none()));

        // With the directory answering, the Pin's re-send indexes all three.
        store_batch(&store, &keys, "U:wearer", batch())
            .await
            .expect("re-sent");
        let stored = store
            .query_events("U:wearer", "", "", None, None, 0)
            .await
            .unwrap();
        assert!(
            stored
                .iter()
                .all(|event| event.indexed_text.as_deref() == Some("play something calm"))
        );
    }

    /// Only the searchable types are opened on ingest. A sealed call or weather
    /// event is stored without a lookup it could never use.
    #[tokio::test]
    async fn only_searchable_types_are_opened_on_ingest() {
        let keys = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let mut rec = record("evt-call", "humane.endCall", "humane.experience.dialer");
        rec.encrypted_event_data = Some(stock_sealed(
            "any-kid",
            &[3; cosmos_crypto::AES_KEY_LEN],
            &strings(&[("request", "private")]),
        ));
        keys.fail_next(crate::keydirectory::DirectoryFault::Get);
        assert!(indexed(&keys, rec).await.indexed_text.is_none());
        // The injected fault was never consumed: no lookup happened.
        assert!(keys.get("any-kid").await.is_err());
    }

    /// Scope is a faithfulness rule, not a shortcut: "Only Ai Mic and Music
    /// events are searchable."
    #[test]
    fn events_outside_the_searchable_set_are_not_indexed() {
        let mut fields = std::collections::BTreeMap::new();
        fields.insert(
            "request".to_owned(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue("private".to_owned())),
            },
        );
        assert!(
            event_search_text("humane.phoneCall", Some(&prost_types::Struct { fields })).is_none(),
            "a call event must not enter the searchable index",
        );
    }

    use crate::store::{MemoryStore, NotableEventRecord, SyncTime};

    fn record(id: &str, kind: &str, originator: &str) -> NotableEventRecord {
        NotableEventRecord {
            event_identifier: id.to_owned(),
            originator_identifier: originator.to_owned(),
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

    /// Isolation is a security property: one wearer must never read another's
    /// history.
    #[tokio::test]
    async fn one_principal_never_reads_anothers_events() {
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        store
            .ingest_events("wearer-a", &[record("a1", "photo", "camera")])
            .await
            .expect("write succeeds");
        store
            .ingest_events("wearer-b", &[record("b1", "photo", "camera")])
            .await
            .expect("write succeeds");
        let a = store
            .query_events("wearer-a", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].event_identifier, "a1");
        assert!(
            store
                .query_events("wearer-c", "", "", None, None, 0)
                .await
                .unwrap()
                .is_empty()
        );
    }

    use super::*;
}
