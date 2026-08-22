//! `humane.events` — device event history + ingest.
//!
//! Two services share this wire package:
//!
//! * `DeviceEventsHistoryService.QueryEvents` — the device asks the cloud for
//!   previously stored notable events (calendar-ish activity, reminders, etc.).
//!   These are served from [`crate::store::Store::query_events`], honouring the
//!   device's type/originator filters and its time window (history restore sends
//!   `event_start_time = now − 1 day`). A principal with nothing stored gets a
//!   well-formed *empty* result, not an error — but an empty answer now means
//!   genuinely nothing stored, never a store failure, which is why the read is
//!   `Written` and a failure surfaces as UNAVAILABLE.
//!
//! * `EventsIngestService.Ingest` / `.IngestBatch` — the device streams notable
//!   events up to the cloud and expects a stream of identifier acks back. Both
//!   are bidirectional streams. Events are PERSISTED, upserted on
//!   `event_identifier`, and only the identifiers actually committed are
//!   acknowledged. We never mint identifiers: the ack echoes the client-supplied
//!   `event_identifier`.
//!
//!   Acking without persisting would be the worst of both worlds — the device
//!   clears `needs_sync` on the ack and the event is gone. `SyncEngine`
//!   re-sends its whole unsynced table every sync (`WHERE needs_sync = 1`, no
//!   `LIMIT`) under a 35 s deadline, so the batch is unbounded and is committed
//!   in chunks inside one transaction rather than one round trip per event.
//!
//! Transport auth is terminated at the mesh edge (see [`crate::auth`]); these
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
    /// without persisting looks fine day to day — the Pin keeps its own DB — and
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

        let mut found = self
            .store
            .query_events(
                &owner,
                &filters.event_type,
                &filters.event_originator_id,
                // The device sends a time window (history restore = now − 1 day);
                // honor it rather than returning every stored event.
                filters
                    .event_start_time
                    .as_ref()
                    .map(crate::store::SyncTime::from_proto),
                filters
                    .event_end_time
                    .as_ref()
                    .map(crate::store::SyncTime::from_proto),
                query.max_results,
            )
            .await?;
        if authenticated.plane == crate::auth::AuthenticationPlane::Web {
            let mut backfill = Vec::new();
            for event in &mut found {
                if let Some(indexed) = project_event_for_web(&self.keys, event).await? {
                    backfill.push(indexed);
                }
            }
            // Events received before a compatible HMSA decoder existed remain
            // sealed at rest but should become searchable once an authorised
            // web read proves we can open them.  The records returned by
            // `project_event_for_web` deliberately clear `event_data`; only the
            // derived lowercase index is written back.
            if !backfill.is_empty()
                && let Err(error) = self.store.ingest_events(&owner, &backfill).await
            {
                tracing::warn!(?error, "notable-event search-index backfill failed");
            }
        }
        Ok(Response::new(pb::EventsQueryResponse {
            events: found.into_iter().map(to_wire_event).collect(),
        }))
    }
}

/// Project one sealed record for an authenticated Center read.
///
/// The returned record, when present, is safe to persist: its plaintext field
/// is cleared and only the search index derived from that plaintext remains.
async fn project_event_for_web(
    keys: &crate::keydirectory::SharedKeyDirectory,
    record: &mut crate::store::NotableEventRecord,
) -> Result<Option<crate::store::NotableEventRecord>, Status> {
    if record.event_data.is_some() {
        return Ok(None);
    }
    let Some(opened) = open_event_struct(keys, record.encrypted_event_data.as_ref()).await? else {
        return Ok(None);
    };
    let should_backfill = record.indexed_text.is_none();
    if should_backfill {
        record.indexed_text =
            event_search_text(&record.event_type, Some(&opened)).map(|text| text.to_lowercase());
    }
    record.event_data = Some(opened);

    if should_backfill && record.indexed_text.is_some() {
        let mut sealed = record.clone();
        sealed.event_data = None;
        Ok(Some(sealed))
    } else {
        Ok(None)
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

/// Wire event -> store record. Events with no identifier have no key and are
/// dropped by the store.
/// The event types a wearer can actually search.
///
/// Humane's own support article scopes this deliberately — "Only Ai Mic and Music
/// events are searchable" — so this list is a faithfulness rule, not a shortcut.
/// The names are the device's own (`humane.ui.notableevents.NotableEvent`:
/// `EVENT_TYPE_RESPOND`, and the four music track types).
pub const SEARCHABLE_EVENT_TYPES: &[&str] = &[
    "humane.respond",
    "humane.playMusicTrack",
    "humane.pauseMusicTrack",
    "humane.completedMusicTrack",
    "humane.skippedMusicTrack",
];

/// Properties worth indexing, per the recovered wire shapes.
///
/// `humane.respond` carries `request`/`response` (RespondNotableEvent); the music
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
/// garbage — unsearchable is bad, wrong results are worse.
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
        // ingest — see `EventsIngest`.
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

/// Open a sealed `event_data` and return its searchable text.
///
/// Mirrors `capture::index_sealed_note`: the plaintext is a serialized
/// `google.protobuf.Struct`, so it is decoded as one rather than read as UTF-8 —
/// the mistake that left device-sealed notes unindexed.
/// Fill in an event's searchable text when its content arrived sealed.
///
/// A free function over a cloned key handle rather than a method: the ingest
/// paths map over events inside async blocks, and borrowing `&self` there would
/// hold the borrow across an await.
async fn indexed(
    keys: &crate::keydirectory::SharedKeyDirectory,
    mut record: crate::store::NotableEventRecord,
) -> Result<crate::store::NotableEventRecord, Status> {
    if record.indexed_text.is_none() {
        record.indexed_text = sealed_event_text(
            keys,
            &record.event_type,
            record.encrypted_event_data.as_ref(),
        )
        .await?;
    }
    Ok(record)
}

async fn sealed_event_text(
    keys: &crate::keydirectory::SharedKeyDirectory,
    event_type: &str,
    sealed: Option<&cosmos_protocol::common::encryption::EncryptedData>,
) -> Result<Option<String>, Status> {
    let Some(data) = open_event_struct(keys, sealed).await? else {
        return Ok(None);
    };
    Ok(event_search_text(event_type, Some(&data)).map(|t| t.to_lowercase()))
}

async fn open_event_struct(
    keys: &crate::keydirectory::SharedKeyDirectory,
    sealed: Option<&cosmos_protocol::common::encryption::EncryptedData>,
) -> Result<Option<prost_types::Struct>, Status> {
    use prost::Message as _;
    let Some(sealed) = sealed else {
        return Ok(None);
    };
    let plaintext = open_event_payload(keys, sealed).await?;
    let decoded = prost_types::Struct::decode(plaintext.as_slice())
        .map_err(|_| Status::failed_precondition("opened notable-event data is malformed"))?;
    Ok(Some(decoded))
}

/// Open the envelope carried by `encrypted_event_data`.
///
/// Kept as a separate seam because the shared key lookup and the stock HMSA
/// SecureAsset decoder are distinct responsibilities. The directory currently
/// opens the service-channel envelope used by the clone; a stock C1 SecureAsset
/// must be decoded by the typed HMSA path before this can claim stock indexing
/// compatibility. An unrecognised envelope fails before ingest storage/ack so
/// the device retains its unsynced row and can retry after key repair.
async fn open_event_payload(
    keys: &crate::keydirectory::SharedKeyDirectory,
    sealed: &cosmos_protocol::common::encryption::EncryptedData,
) -> Result<Vec<u8>, Status> {
    let kid = sealed
        .encryption_information
        .as_ref()
        .map(|i| i.kid.clone())
        .unwrap_or_default();
    if sealed.data.get(4..8) == Some(b"HMSA") {
        let Some(key) = keys
            .get(&kid)
            .await
            .map_err(|error| crate::keydirectory::grpc_status(&error))?
        else {
            // An event we cannot open must fail before storage/ack, otherwise a
            // later `recall_history` says nothing happened after the device has
            // cleared its unsynced row. Still log no key id — it identifies the
            // wearer.
            tracing::warn!(
                shared = keys.is_shared(),
                "no authoritative channel key for this notable event; refusing ingest before storage/ack"
            );
            return Err(Status::failed_precondition(
                "no authoritative channel key for this notable event",
            ));
        };
        return match cosmos_crypto::secure_asset::open_secure_asset(
            &key,
            &kid,
            &sealed.data,
            cosmos_crypto::secure_asset::NOTABLE_EVENT_DATA,
        ) {
            Ok(plaintext) => Ok(plaintext),
            Err(error) => {
                // The key id is wearer-identifying; report only the decoder
                // class, never the id or payload.
                tracing::warn!(
                    %error,
                    shared = keys.is_shared(),
                    "notable-event HMSA payload could not be opened"
                );
                Err(Status::failed_precondition(
                    "the notable-event secure asset could not be opened",
                ))
            }
        };
    }
    keys.open(&cosmos_crypto::EncryptedData {
        data: sealed.data.clone(),
        kid,
    })
    .await
    .map_err(|error| crate::keydirectory::grpc_status(&error))?
    .ok_or_else(|| {
        Status::failed_precondition("no authoritative channel key for this notable event")
    })
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
        // Ingest is an upsert keyed on the device-minted identifier — the device
        // re-sends on every sync, so it must be idempotent — and an event with no
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
                    Ok(batch) => {
                        require_events(&batch)?;
                        let mut records = Vec::with_capacity(batch.events.len());
                        for event in batch.events {
                            records.push(indexed(&keys, to_record(event)).await?);
                        }
                        let stored = store.ingest_events(&owner, &records).await?;
                        Ok(pb::IngestBatchResponse {
                            event_identifier: stored
                                .into_iter()
                                .map(|value| pb::Uuid { value })
                                .collect(),
                        })
                    }
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
                        let record = indexed(&keys, to_record(event)).await?;
                        let stored = store
                            .ingest_events(&owner, std::slice::from_ref(&record))
                            .await?;
                        Ok(pb::IngestResponse {
                            event_identifier: stored
                                .into_iter()
                                .next()
                                .map(|value| pb::Uuid { value }),
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

    /// A decrypted Ai Mic Struct must feed the search index — the final half of
    /// the "Ai Mic History" path.
    ///
    /// **Implemented:** this fixture uses the clone's service-channel envelope
    /// to isolate shared-directory lookup + protobuf decoding. Stock HMSA
    /// SecureAsset compatibility needs its own typed fixture and decoder test.
    #[tokio::test]
    async fn an_opened_ai_mic_struct_is_indexed_on_ingest() {
        use prost::Message as _;

        let keys = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let key = [8u8; cosmos_crypto::AES_KEY_LEN];
        keys.put("wearer-kid", key).await.expect("put key");

        // Observed plaintext shape after protection is removed: request +
        // response as a Struct.
        let mut fields = std::collections::BTreeMap::new();
        fields.insert(
            "request".to_owned(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue(
                    "how tall is the eiffel tower".to_owned(),
                )),
            },
        );
        fields.insert(
            "response".to_owned(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue(
                    "About 330 metres.".to_owned(),
                )),
            },
        );
        let data = prost_types::Struct { fields };
        let sealed =
            cosmos_crypto::seal("wearer-kid", &key, &data.encode_to_vec(), b"").expect("seal");

        let mut rec = record("evt-1", "humane.respond", "ai-bus");
        rec.event_data = None;
        rec.encrypted_event_data = Some(cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: sealed.kid.clone(),
                },
            ),
            data: sealed.data.clone(),
        });

        let enriched = indexed(&keys, rec).await.expect("index event");
        let text = enriched
            .indexed_text
            .expect("a sealed Ai Mic event must be indexed on ingest");
        assert!(
            text.contains("eiffel") && text.contains("330"),
            "both the wearer's question and the answer must be searchable: {text:?}",
        );
    }

    #[tokio::test]
    async fn ingest_indexing_distinguishes_authority_outage_from_missing_key_before_ack() {
        use prost::Message as _;

        let kid = "event-authority-key";
        let key = [0x68; cosmos_crypto::AES_KEY_LEN];
        let directory = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        directory.put(kid, key).await.expect("seed authority");
        let payload = prost_types::Struct::default().encode_to_vec();
        let sealed = cosmos_crypto::seal(kid, &key, &payload, b"").expect("seal event");
        let candidate = || {
            let mut event = record("evt-authority", "humane.respond", "ai-bus");
            event.event_data = None;
            event.encrypted_event_data = Some(cosmos_protocol::common::encryption::EncryptedData {
                encryption_information: Some(
                    cosmos_protocol::common::encryption::EncryptionInformation {
                        kid: kid.to_owned(),
                    },
                ),
                data: sealed.data.clone(),
            });
            event
        };

        directory.fail_next(crate::keydirectory::DirectoryFault::Get);
        let unavailable = indexed(&directory, candidate())
            .await
            .err()
            .expect("lookup failure happens before store/ack");
        assert_eq!(unavailable.code(), tonic::Code::Unavailable);

        let missing = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let precondition = indexed(&missing, candidate())
            .await
            .err()
            .expect("a proven missing key is a failed precondition");
        assert_eq!(precondition.code(), tonic::Code::FailedPrecondition);

        indexed(&directory, candidate())
            .await
            .expect("unchanged event is retryable once authority recovers");
    }

    /// A web read may expose plaintext to the authenticated wearer, but the
    /// index backfill it persists must remain sealed at rest.
    #[tokio::test]
    async fn web_projection_backfills_only_the_search_index() {
        use prost::Message as _;

        let keys = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let key = [7u8; cosmos_crypto::AES_KEY_LEN];
        keys.put("web-projection-kid", key).await.expect("put key");

        let mut fields = std::collections::BTreeMap::new();
        fields.insert(
            "request".to_owned(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue(
                    "show this to the wearer".to_owned(),
                )),
            },
        );
        let plaintext = prost_types::Struct { fields }.encode_to_vec();
        let sealed = cosmos_crypto::seal("web-projection-kid", &key, &plaintext, b"")
            .expect("fixture seals");

        let mut rec = record("evt-web", "humane.respond", "humane.experience.answers");
        rec.encrypted_event_data = Some(cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation { kid: sealed.kid },
            ),
            data: sealed.data,
        });

        let backfill = project_event_for_web(&keys, &mut rec)
            .await
            .expect("project event")
            .expect("a newly opened event should produce an index backfill");
        assert!(
            rec.event_data.is_some(),
            "the web response receives plaintext"
        );
        assert!(rec.indexed_text.is_some(), "the web response is searchable");
        assert!(
            backfill.event_data.is_none(),
            "the durable backfill must not retain plaintext",
        );
        assert!(backfill.encrypted_event_data.is_some());
        assert!(backfill.indexed_text.is_some());
    }

    /// REGRESSION: the stock client clears the original unsynced rows after any
    /// successful batch response, even when encryption filtered all events out.
    /// The server must therefore fail an empty batch rather than acknowledge it.
    #[test]
    fn an_empty_batch_is_rejected_instead_of_acknowledged() {
        let error = require_events(&pb::IngestBatchRequest { events: Vec::new() })
            .expect_err("an empty batch must not receive a success response");
        assert_eq!(error.code(), tonic::Code::InvalidArgument);
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

    /// REGRESSION: ingest was acked but never persisted, so a wearer's history
    /// could never be restored after a factory reset — the one thing this
    /// service exists for.
    #[tokio::test]
    async fn ingested_events_are_queryable() {
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        store
            .ingest_events("wearer", &[record("e1", "photo", "camera")])
            .await
            .expect("write succeeds");
        let found = store
            .query_events("wearer", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].event_identifier, "e1");
    }

    /// The device re-sends on every sync, so ingest is an upsert keyed on the
    /// device-minted identifier — never a duplicate.
    #[tokio::test]
    async fn re_ingesting_the_same_event_updates_rather_than_duplicates() {
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        store
            .ingest_events("wearer", &[record("e1", "photo", "camera")])
            .await
            .expect("write succeeds");
        store
            .ingest_events("wearer", &[record("e1", "video", "camera")])
            .await
            .expect("write succeeds");
        let found = store
            .query_events("wearer", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(found.len(), 1, "the same identifier must not duplicate");
        assert_eq!(found[0].event_type, "video", "last writer wins");
    }

    /// The device hands us its whole unsynced table in ONE batch, and that batch
    /// can repeat an identifier. The batched upsert both backends now use is
    /// only correct on a collapsed batch — PostgreSQL rejects a multi-row
    /// `ON CONFLICT DO UPDATE` whose own rows collide — so the collapse is part
    /// of the contract, not an optimisation.
    #[tokio::test]
    async fn an_identifier_repeated_inside_one_batch_stores_once_and_acks_once() {
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        let stored = store
            .ingest_events(
                "wearer",
                &[
                    record("e1", "photo", "camera"),
                    record("e2", "video", "camera"),
                    record("e1", "note", "camera"),
                ],
            )
            .await
            .expect("write succeeds");

        assert_eq!(
            stored,
            vec!["e1".to_owned(), "e2".to_owned()],
            "one ack per distinct identifier, in first-appearance order"
        );
        let found = store
            .query_events("wearer", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(
            found
                .iter()
                .find(|e| e.event_identifier == "e1")
                .expect("e1")
                .event_type,
            "note",
            "the last copy in the batch wins, same as re-ingest across calls"
        );
    }

    /// Re-ingest must acknowledge what it updated, not just what it inserted:
    /// the device clears its `needs_sync` flags off this ack, and an event it
    /// believes unacknowledged is re-sent forever.
    #[tokio::test]
    async fn re_ingest_acknowledges_the_identifiers_it_updated() {
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        store
            .ingest_events("wearer", &[record("e1", "photo", "camera")])
            .await
            .expect("write succeeds");
        let stored = store
            .ingest_events("wearer", &[record("e1", "video", "camera")])
            .await
            .expect("write succeeds");
        assert_eq!(stored, vec!["e1".to_owned()]);
    }

    /// A batch far larger than one statement can contain still lands whole. The
    /// device's history is unbounded (`SyncEngine.performSync` selects
    /// `WHERE needs_sync = 1` with no LIMIT); chunking bounds the statement, and
    /// must not bound the wearer's data.
    #[tokio::test]
    async fn a_batch_larger_than_one_chunk_lands_whole() {
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        let count = crate::store::INGEST_CHUNK * 2 + 7;
        let batch: Vec<_> = (0..count)
            .map(|n| record(&format!("e{n}"), "photo", "camera"))
            .collect();

        let stored = store
            .ingest_events("wearer", &batch)
            .await
            .expect("write succeeds");
        assert_eq!(stored.len(), count);
        assert_eq!(
            store
                .query_events("wearer", "", "", None, None, 0)
                .await
                .unwrap()
                .len(),
            count
        );
    }

    /// An event with no identifier has no key.
    #[tokio::test]
    async fn events_without_an_identifier_are_dropped() {
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        let stored = store
            .ingest_events("wearer", &[record("", "photo", "camera")])
            .await
            .expect("write succeeds");
        assert!(stored.is_empty());
        assert!(
            store
                .query_events("wearer", "", "", None, None, 0)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn filters_and_max_results_are_applied() {
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        store
            .ingest_events(
                "wearer",
                &[
                    record("e1", "photo", "camera"),
                    record("e2", "video", "camera"),
                    record("e3", "photo", "mic"),
                ],
            )
            .await
            .expect("write succeeds");
        assert_eq!(
            store
                .query_events("wearer", "photo", "", None, None, 0)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .query_events("wearer", "", "mic", None, None, 0)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .query_events("wearer", "photo", "mic", None, None, 0)
                .await
                .unwrap()
                .len(),
            1
        );
        // An empty filter matches everything; max_results bounds the result.
        assert_eq!(
            store
                .query_events("wearer", "", "", None, None, 2)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .query_events("wearer", "", "", None, None, 0)
                .await
                .unwrap()
                .len(),
            3
        );
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

    #[tokio::test]
    async fn query_events_returns_well_formed_empty() {
        let service = DeviceEventsHistory::default();
        let response = service
            .query_events(Request::new(pb::DeviceEventQueryRequest {
                filters: None,
                max_results: 0,
            }))
            .await
            .expect("query_events succeeds")
            .into_inner();
        assert!(
            response.events.is_empty(),
            "a device with no stored history gets an empty, valid result"
        );
    }
}
