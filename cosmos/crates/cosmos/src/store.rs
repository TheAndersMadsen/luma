//! Principal-keyed persistence for the stateful device surfaces.
//!
//! Most of this deployment's handlers are honestly stateless, but a few are only
//! *useful* if they remember: the Pin writes a contact and expects to read it
//! back on its next sync, and a device that gets an empty list after a
//! successful write notices the loss. This module is the seam that makes those
//! services stateful without committing the deployment to a database yet —
//! [`Store`] is the contract, [`MemoryStore`] is the process-lifetime
//! implementation, and a real backing store drops in behind the same trait.
//!
//! Two properties are load-bearing:
//!
//! * **Isolation is a security property.** Every row is filed under the
//!   authenticated principal the mesh edge established (see `auth.rs`); no read
//!   path can reach another principal's rows. The store takes that principal as
//!   an opaque string so it never has to interpret or re-derive identity.
//! * **Nothing is invented.** The store returns exactly what the device wrote.
//!   The server owns ids, versions, and sync cursors — ids are fresh UUIDv4s —
//!   but no contact, id, or timestamp is ever fabricated for a principal that
//!   wrote nothing. An untouched principal reads back well-formed empty, never
//!   an error and never seed data.
//!
//! Contacts are modelled first-class here. Notable events and push tokens are
//! the next two stateful gaps; they are meant to arrive as additional [`Store`]
//! methods over the same principal key and are deliberately not built yet.
//!
//! # Evidence and documented ambiguity
//!
//! The contacts family was observed to complete `OK`, but its sync semantics
//! remain unknown: "cursor/
//! time semantics, full-vs-delta transition, ordering, tombstones, pagination
//! boundaries, stream termination, retry/resume rules, and consistency
//! guarantees". Nothing below is reverse-engineered behaviour — it is the
//! simplest reading the `humane.contacts` proto admits, chosen so a device that
//! writes and reads back is never surprised. Each choice that the evidence does
//! not pin down is called out at its definition.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use cosmos_protocol::{common::encryption::EncryptedData, contacts as pb};
use prost_types::Timestamp;
use uuid::Uuid;

const NANOS_PER_SECOND: i32 = 1_000_000_000;

/// A `google.protobuf.Timestamp`-shaped instant, normalised so sync cursors
/// compare totally.
///
/// The proto carries every sync point as a `Timestamp`, which prost generates
/// without `Ord`, so the store needs its own ordered instant to answer "changed
/// since". Field order is significant: deriving `Ord` over `(seconds, nanos)` is
/// only the correct comparison because `nanos` is held in `0..1_000_000_000` by
/// construction — see [`SyncTime::from_proto`], which folds anything else a
/// client sends back into `seconds`.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct SyncTime {
    seconds: i64,
    nanos: i32,
}

impl SyncTime {
    /// Wall-clock now. Writes never depend on this being monotonic on its own —
    /// [`ContactBook::stamp`] raises it above the stored high-water mark — but a
    /// wall clock is what the device compares its own cursor against.
    /// Build a cursor from a device-supplied timestamp. Out-of-range nanos are
    /// normalised the same way `now()` produces them.
    pub fn from_parts(seconds: i64, nanos: i32) -> Self {
        Self {
            seconds: seconds + i64::from(nanos.div_euclid(1_000_000_000)),
            nanos: nanos.rem_euclid(1_000_000_000),
        }
    }

    /// The cursor's epoch seconds.
    pub fn seconds(&self) -> i64 {
        self.seconds
    }

    /// The cursor's sub-second component.
    pub fn nanos(&self) -> i32 {
        self.nanos
    }

    pub fn now() -> Self {
        let Ok(since_epoch) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            // A clock set before the Unix epoch cannot produce a usable cursor.
            // Anchor at the epoch rather than wrapping into negative time; the
            // strict-monotonic write stamp still keeps ordering sound.
            return Self::default();
        };
        Self {
            seconds: since_epoch.as_secs() as i64,
            nanos: since_epoch.subsec_nanos() as i32,
        }
    }

    /// Read a client-supplied cursor, normalising out-of-range `nanos` so the
    /// derived ordering stays sound for values this server did not mint.
    pub fn from_proto(timestamp: &Timestamp) -> Self {
        let seconds_adjustment = i64::from(timestamp.nanos.div_euclid(NANOS_PER_SECOND));
        Self {
            seconds: timestamp.seconds.saturating_add(seconds_adjustment),
            nanos: timestamp.nanos.rem_euclid(NANOS_PER_SECOND),
        }
    }

    /// The wire form for a `google.protobuf.Timestamp` field.
    pub const fn to_proto(self) -> Timestamp {
        Timestamp {
            seconds: self.seconds,
            nanos: self.nanos,
        }
    }

    /// The cursor collapsed to a single nanoseconds-since-epoch integer.
    ///
    /// A backing store that must compare and *increment* cursors inside one SQL
    /// statement cannot do it over a `(seconds, nanos)` pair without a CASE
    /// ladder, so [`crate::store_postgres`] stores the cursor in this flattened
    /// form. `i64` nanoseconds run out in 2262; a saturating multiply keeps a
    /// nonsense clock from wrapping into the past, which would hand a device a
    /// cursor below one it has already seen.
    pub const fn to_epoch_nanos(self) -> i64 {
        self.seconds
            .saturating_mul(NANOS_PER_SECOND as i64)
            .saturating_add(self.nanos as i64)
    }

    /// Inverse of [`SyncTime::to_epoch_nanos`].
    pub const fn from_epoch_nanos(total: i64) -> Self {
        Self {
            seconds: total.div_euclid(NANOS_PER_SECOND as i64),
            nanos: total.rem_euclid(NANOS_PER_SECOND as i64) as i32,
        }
    }

    /// The smallest instant strictly after `self`, used to keep write stamps
    /// increasing even when the wall clock does not advance between two writes.
    /// Without this a second write inside the same clock tick would be invisible
    /// to a client whose cursor already covers the first.
    const fn successor(self) -> Self {
        if self.nanos >= NANOS_PER_SECOND - 1 {
            Self {
                seconds: self.seconds.saturating_add(1),
                nanos: 0,
            }
        } else {
            Self {
                seconds: self.seconds,
                nanos: self.nanos + 1,
            }
        }
    }
}

/// A stored contact: the canonical wire message plus the server-owned cursor.
///
/// `contact.id`, `contact.version`, and `contact.modified_at` are the server's
/// values; every other field is exactly what the device wrote. `modified`
/// mirrors `contact.modified_at` in comparable form.
///
/// Deliberately not `Debug`: a `Contact` holds names, e-mail addresses, and
/// phone numbers, and this codebase keeps personal data out of routine
/// formatting (see `cosmos_core::Sensitive`).
#[derive(Clone)]
pub struct ContactRecord {
    pub contact: pb::Contact,
    pub modified: SyncTime,
}

/// A stored encrypted contact.
///
/// `humane.contacts.ContactList` carries encrypted contacts as a bare repeated
/// `EncryptedData` with a parallel repeated version — there is **no id field**,
/// so an encrypted contact cannot be individually updated or deleted the way a
/// plaintext one can. Its identity here is therefore its exact ciphertext, which
/// makes a retried write idempotent without inventing an identifier. Not
/// `Debug` for the same reason as [`ContactRecord`].
#[derive(Clone)]
pub struct EncryptedContactRecord {
    pub data: EncryptedData,
    pub version: i32,
    pub modified: SyncTime,
}

/// A tombstone: an id the principal deleted, retained so a delta sync can tell
/// a second device the contact is gone rather than silently omitting it.
#[derive(Clone, Debug)]
pub struct DeletionRecord {
    pub id: String,
    pub deleted: SyncTime,
}

/// Everything one principal has stored, plus the high-water sync cursor.
///
/// Reads take a whole snapshot rather than pushing filters into the trait: a
/// contact book is small, and keeping the wire-shaped filtering in the handler
/// keeps the storage contract to three methods. A database implementation that
/// outgrows this can add pushdown methods without changing these semantics.
#[derive(Clone, Default)]
pub struct ContactSnapshot {
    /// Live contacts in write order — stable, so paginated reads page over a
    /// consistent sequence.
    pub contacts: Vec<ContactRecord>,
    /// Encrypted contacts in write order.
    pub encrypted: Vec<EncryptedContactRecord>,
    /// Tombstones, ordered by id (a `BTreeMap` backs them) so streaming order is
    /// deterministic across runs.
    pub deletions: Vec<DeletionRecord>,
    /// The greatest cursor across every stored contact, encrypted contact, and
    /// tombstone. `None` when the principal has stored nothing — the honest
    /// answer for a device that has never written, since the server has no sync
    /// point to hand back.
    pub latest: Option<SyncTime>,
}

impl ContactSnapshot {
    /// Whether this principal holds nothing at all.
    pub fn is_empty(&self) -> bool {
        self.contacts.is_empty() && self.encrypted.is_empty() && self.deletions.is_empty()
    }

    /// The live contact with `id`, if the principal still holds it.
    pub fn find(&self, id: &str) -> Option<&ContactRecord> {
        self.contacts.iter().find(|record| record.contact.id == id)
    }

    /// Contacts modified strictly after `since`; all of them when `since` is
    /// `None`.
    ///
    /// *Documented reading:* an absent cursor means "the client has no sync
    /// point", which the proto expresses on the streaming path as
    /// `GetContactsStreamingRequest.full_sync`. Both paths therefore resolve an
    /// absent cursor to a full read. The comparison is strict so a client that
    /// echoes back the `latest_sync_time` it was handed receives nothing twice.
    pub fn contacts_since(&self, since: Option<SyncTime>) -> impl Iterator<Item = &ContactRecord> {
        self.contacts
            .iter()
            .filter(move |record| since.is_none_or(|cursor| record.modified > cursor))
    }

    /// Encrypted contacts modified strictly after `since`; all when `None`.
    pub fn encrypted_since(
        &self,
        since: Option<SyncTime>,
    ) -> impl Iterator<Item = &EncryptedContactRecord> {
        self.encrypted
            .iter()
            .filter(move |record| since.is_none_or(|cursor| record.modified > cursor))
    }

    /// Tombstones recorded strictly after `since`.
    ///
    /// Takes a required cursor, not an `Option`: a full sync has no prior client
    /// state to reconcile, so it carries no tombstones. Handlers therefore only
    /// reach this on the delta path.
    pub fn deletions_since(&self, since: SyncTime) -> impl Iterator<Item = &DeletionRecord> {
        self.deletions
            .iter()
            .filter(move |record| record.deleted > since)
    }

    /// Contacts matching `GetContactsRequest.search_term`; all of them when the
    /// term is blank.
    ///
    /// *Documented reading:* the proto names the field `search_term` but does
    /// not say what it searches. This matches a case-insensitive substring
    /// against the human-identifying fields a wearer would speak — every part of
    /// the name, e-mail addresses, both phone-number representations, and the
    /// organisation. Encrypted contacts are unmatchable here because this
    /// workload holds no contact channel key.
    pub fn matching(&self, term: &str) -> impl Iterator<Item = &ContactRecord> {
        let needle = term.trim().to_lowercase();
        self.contacts
            .iter()
            .filter(move |record| needle.is_empty() || matches_term(&record.contact, &needle))
    }
}

/// Case-insensitive substring match over a contact's identifying fields.
/// `needle` must already be trimmed and lowercased.
fn matches_term(contact: &pb::Contact, needle: &str) -> bool {
    let name = contact.name.iter().flat_map(|name| {
        [
            name.first_name.as_str(),
            name.last_name.as_str(),
            name.nickname.as_str(),
            name.display_name.as_str(),
        ]
    });
    let emails = contact.emails.iter().map(|email| email.value.as_str());
    let telephones = contact.telephone_numbers.iter().map(String::as_str);
    let phones = contact
        .phone_numbers
        .iter()
        .map(|phone| phone.value.as_str());
    let organization = contact
        .organization
        .iter()
        .map(|organization| organization.name.as_str());

    name.chain(emails)
        .chain(telephones)
        .chain(phones)
        .chain(organization)
        .any(|field| field.to_lowercase().contains(needle))
}

/// The persistence contract every stateful handler talks to.
///
/// `principal` is the opaque value from `AuthenticatedPrincipal::
/// expose_for_authorization`. Implementations must treat it as an exact key:
/// isolation between principals is a security property, not a convenience.
///
/// The surface is contacts-only today. Notable events and push tokens are
/// expected to arrive as further methods on this same trait rather than as
/// parallel stores, so one backing database serves them all.
/// One capture the device created. Server-allocated identity, device-supplied
/// content — the server never invents a thumbnail, a location, or a frame.
///
/// No `Debug`: thumbnails and locations are wearer content.
#[derive(Clone)]
pub struct MemoryRecord {
    /// Server-minted UUIDv4 — `Memory.uuid`.
    pub uuid: String,
    /// Monotonic per principal — `Memory.id`. Separate from the uuid because the
    /// device carries both.
    pub numeric_id: i64,
    /// The device's own id for this capture. Identity for retries.
    pub device_local_id: String,
    /// Which arm of `CreateMemoryRequest` produced it.
    pub kind: MemoryKind,
    pub device_created_time: Option<SyncTime>,
    pub gmt_offset: i32,
    /// Stored verbatim; opaque to us.
    pub thumbnails: Vec<EncryptedData>,
    pub encrypted_location: Option<EncryptedData>,
    /// Server-allocated upload slots the device writes its frames into.
    pub bursts: Vec<BurstRecord>,
    pub upload_complete: bool,
    pub deleted: Option<SyncTime>,
    pub created: SyncTime,
}

/// A capture's INDEX, containing no sealed bytes at all.
///
/// The listing endpoints render counts and timestamps and nothing else (see
/// `capture_api::MemoryDto`), while a capture's megabytes all live in
/// `thumbnails`. Reading whole [`MemoryRecord`]s just to evaluate
/// `thumbnails.len()` therefore made every listing cost O(total stored bytes) —
/// detoasting, JSON-parsing and prost-decoding every sealed frame the wearer
/// owns to produce a handful of integers. This is the shape those endpoints
/// actually need, so the frames never leave the store.
///
/// It is a separate type rather than a `MemoryRecord` with the heavy fields left
/// empty on purpose: an empty `thumbnails` vector is a *claim* ("this capture
/// has no frames") and the DTO would have serialised it as one.
#[derive(Clone, Debug)]
pub struct MemorySummary {
    pub uuid: String,
    pub numeric_id: i64,
    pub device_local_id: String,
    pub kind: MemoryKind,
    pub device_created_time: Option<SyncTime>,
    pub created: SyncTime,
    pub upload_complete: bool,
    /// How many thumbnails the device sealed — the count, never the bytes.
    pub thumbnail_count: usize,
    pub has_location: bool,
    pub burst_count: usize,
    /// Uploaded frame slots across all bursts.
    pub frame_count: usize,
}

impl MemorySummary {
    /// The index view of a capture already loaded in full.
    ///
    /// The single-capture routes still read the whole record (they go on to
    /// serve its bytes), so they derive the same summary here rather than
    /// duplicating the DTO's field mapping.
    pub fn from_record(record: &MemoryRecord) -> Self {
        Self {
            uuid: record.uuid.clone(),
            numeric_id: record.numeric_id,
            device_local_id: record.device_local_id.clone(),
            kind: record.kind,
            device_created_time: record.device_created_time,
            created: record.created,
            upload_complete: record.upload_complete,
            thumbnail_count: record.thumbnails.len(),
            has_location: record.encrypted_location.is_some(),
            burst_count: record.bursts.len(),
            frame_count: record.bursts.iter().map(|burst| burst.files.len()).sum(),
        }
    }
}

/// One page of a listing: the rows asked for, and how many exist in total.
///
/// `total` is deliberately not `records.len()`. It is what the Spring `Page<T>`
/// envelope's `totalElements`/`totalPages`/`last` are computed from, and
/// deriving it from a truncated vector is exactly what forced the HTTP layer to
/// materialise every row before it could paginate — so `?size=1` cost what
/// `?size=200` cost.
pub struct StorePage<T> {
    /// Rows for the requested window, in the listing's own order.
    pub records: Vec<T>,
    /// How many rows the filter matches in total, ignoring the window.
    pub total: i64,
}

/// The most bursts one capture may ask for slots for, and the most files in
/// each.
///
/// `bursts` and `files_per_burst` arrive as proto3 `int32`s straight off the
/// device plane, and [`build_memory`] turns each unit of them into an allocation
/// and four `Uuid::new_v4()` calls. Unbounded, a ~10-byte
/// `CreateMemoryRequest{ num_bursts: i32::MAX, num_pics_per_burst: i32::MAX }`
/// asked this process to reserve hundreds of gigabytes: either the allocator
/// refused and `handle_alloc_error` ABORTED the process — not a catchable panic,
/// so every other wearer's in-flight RPC on the ai-bus workload died with it —
/// or overcommit let the reservation through and the loop below minted UUIDs and
/// format strings until the container hit its memory limit. `max_decode_bytes`
/// never fires on a message that small, and the request is repeatable the moment
/// `restart: unless-stopped` brings the workload back. One authenticated caller,
/// on either plane, could take capture, the AI bus, notable events and the push
/// relay down for everybody, over and over.
///
/// The numbers are deliberately far above anything a Pin asks for and still
/// trivially bounded: the photography app defaults `numPhotosPerBurst` to three
/// (see `capture_ranking`), and the widest request this repo has ever recorded
/// is two bursts of three. Thirty-two by thirty-two is a thousandfold headroom
/// and still at most ~1024 slots — a bounded allocation and a bounded response.
/// Raise them if a real device is ever observed to need more; do not remove
/// them.
pub const MAX_BURSTS: i32 = 32;
/// See [`MAX_BURSTS`].
pub const MAX_FILES_PER_BURST: i32 = 32;

/// What the device is asking us to record, and how many upload slots it needs.
///
/// A struct rather than positional arguments: these are eight same-shaped values
/// and transposing two of them silently mis-files a wearer's capture.
///
/// `bursts` and `files_per_burst` are refused above [`MAX_BURSTS`] /
/// [`MAX_FILES_PER_BURST`] at the service boundary, where the caller can still
/// be told; [`build_memory`] clamps as a backstop.
///
/// No `Debug`: thumbnails and locations are wearer content.
pub struct NewMemory {
    pub kind: MemoryKind,
    /// The device's own id. Identity for retries.
    pub device_local_id: String,
    pub bursts: i32,
    pub files_per_burst: i32,
    pub device_created_time: Option<SyncTime>,
    pub gmt_offset: i32,
    pub thumbnails: Vec<EncryptedData>,
    pub encrypted_location: Option<EncryptedData>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryKind {
    Photo,
    Video,
    FoodLog,
    Note,
}

/// A server-allocated burst: the upload slots for one group of frames.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BurstRecord {
    pub id: i64,
    pub index: i64,
    pub uuid: String,
    pub files: Vec<BurstFileRecord>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BurstFileRecord {
    pub id: i64,
    pub index: i64,
    pub uuid: String,
    pub filename: String,
    pub metadata_filename: String,
    pub secure_filename: String,
    pub secure_raw_data_filename: String,
    pub imu_data_filename: String,
    pub video_timing_data_filename: String,
}

/// A note the wearer captured.
///
/// No `Debug`: the body is wearer content, even sealed.
#[derive(Clone)]
pub struct NoteRecord {
    /// Server-minted UUIDv4 — what the device keys on.
    pub uuid: String,
    /// Lowercased plaintext, present only when the server could open the note.
    /// Used for retrieval; never returned on the wire.
    pub indexed_text: Option<String>,
    /// Sealed by the device; opaque to us.
    pub encrypted_note: Option<EncryptedData>,
    pub encrypted_location: Option<EncryptedData>,
    pub created: SyncTime,
}

/// Plaintext index material available to the server-side semantic ranker.
/// Never returned on a public wire; `WebSearchService` still returns UUIDs only.
#[derive(Clone)]
pub struct SearchableNote {
    pub uuid: String,
    pub text: String,
}

/// A notable event the device ingested.
///
/// No `Debug`: event bodies are wearer content.
#[derive(Clone)]
pub struct NotableEventRecord {
    /// Device-minted; the PRIMARY KEY. The device re-sends on every sync, so
    /// ingest must be idempotent on this.
    pub event_identifier: String,
    pub originator_identifier: String,
    pub creation_time: Option<SyncTime>,
    pub event_type: String,
    pub event_data: Option<prost_types::Struct>,
    pub encrypted_event_data: Option<EncryptedData>,
    pub encrypted_location: Option<EncryptedData>,
    pub device_is_locked: bool,
    pub ingested: SyncTime,
    /// Lowercased searchable text, present only when the server could open the
    /// event. `NotableEventsManager.encryptEventData` seals `event_data` and
    /// CLEARS the plaintext copy, so on the wire from a real Pin the content
    /// exists only in `encrypted_event_data` — an event stored without opening it
    /// is a blob nothing can ever search. Never returned on the wire.
    pub indexed_text: Option<String>,
}

/// Which `humane.account` payload a stored blob is.
///
/// The account services contain sealed, service-scoped `EncryptedData` (and one
/// plaintext goals message) that this deployment holds no key for and never
/// needs to read. They are therefore stored as opaque bytes under
/// `(principal, kind)` — the kind is the namespace, so food restrictions and
/// intake goals cannot overwrite each other.
///
/// Kinds are named rather than numbered because the value is written into a
/// column and a snapshot key; a renumbering would silently re-file a wearer's
/// allergies under someone else's payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AccountBlobKind {
    /// `EncryptedSetFoodRestrictions` — includes the wearer's **allergies**.
    FoodRestrictions,
    /// `SetUserDailyIntakeGoals`.
    DailyIntakeGoals,
    /// `GetUserPersonalDetails`' response payload (preferred name, pronunciation,
    /// sealed bio data). No RPC in `humane.account` writes it — see the
    /// `services::account` module doc — so it is read-only until one appears.
    PersonalDetails,
    /// `ListSecureWifiConfigs`' payload. Read-only for the same reason.
    WifiConfigs,
    /// Clone-owned, signed status snapshot reported by an operator-authorized
    /// Pin. This is JSON rather than a recovered Humane protobuf: no stock wire
    /// contract for serial, battery, firmware, or saved-network metadata was
    /// observed. The status endpoint verifies the device certificate and stores
    /// only non-secret network metadata (SSID/security), never credentials.
    DeviceStatus,
    /// `PublicPrivacyService.GetSettings`' complete per-wearer snapshot.
    ///
    /// This shares the opaque blob table rather than inventing a second generic
    /// key/value store. The payload is a prost-encoded `GetSettingsResponse` and
    /// is still scoped by the exact authenticated principal.
    PrivacySettings,
    /// `PushRelayService.GetPushTokens`' complete per-wearer token set.
    /// Tokens are clone-owned relay capabilities, never third-party credentials.
    PushTokens,
    /// Pending `PushRelayService.Subscribe` messages awaiting a device ack.
    PushQueue,
    /// Provider-name keyed encrypted `PartnerTokenRPCService` responses.
    PartnerTokens,
    /// Durable `DeviceMessagesService` backup state.
    DeviceMessages,
    /// Durable `TestAutomationService` scratch-calendar state.
    CalendarState,
    /// Durable sealed food-log entries used by `GetFoodLogSummary`.
    FoodLogs,
    /// Per-wearer subscription state used during onboarding.
    SubscriptionState,
}

impl AccountBlobKind {
    /// The stable storage key. Never derived from the variant order.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FoodRestrictions => "food_restrictions",
            Self::DailyIntakeGoals => "daily_intake_goals",
            Self::PersonalDetails => "personal_details",
            Self::WifiConfigs => "wifi_configs",
            Self::DeviceStatus => "device_status",
            Self::PrivacySettings => "privacy_settings",
            Self::PushTokens => "push_tokens",
            Self::PushQueue => "push_queue",
            Self::PartnerTokens => "partner_tokens",
            Self::DeviceMessages => "device_messages",
            Self::CalendarState => "calendar_state",
            Self::FoodLogs => "food_logs",
            Self::SubscriptionState => "subscription_state",
        }
    }
}

/// A write could not be durably recorded.
///
/// This exists so a failed write can never be reported to the device as a
/// success. A Pin that is told its contact/capture/note was saved will not
/// retry, so a swallowed error is silent, permanent data loss for the wearer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The backing store rejected or could not durably record the write.
    Unavailable,
}

impl From<StoreError> for tonic::Status {
    fn from(error: StoreError) -> Self {
        match error {
            // UNAVAILABLE (not INTERNAL): the device's own retry logic treats
            // this as transient, which is exactly right — the write may succeed
            // on the next sync.
            StoreError::Unavailable => {
                tonic::Status::unavailable("the store could not record the write")
            }
        }
    }
}

/// Result of a durable write.
pub type Written<T> = Result<T, StoreError>;

/// How many notable events one backing-store statement commits at a time.
///
/// The device hands us its entire unsynced table in a single `IngestBatchRequest`
/// (`SyncEngine.performSync` runs `SELECT * FROM <table> WHERE needs_sync = 1` —
/// no `LIMIT`) and gives the whole exchange **35 seconds**
/// (`SyncEngine.SYNC_TIMEOUT_SECONDS`) before it gives up and leaves every row
/// flagged for the next sync. One network round trip per event therefore turns a
/// long history into a sync that can never finish: it times out, nothing clears,
/// and the same batch comes back forever.
///
/// So the batch is committed in multi-row statements instead. The chunk bounds
/// the statement rather than the wearer's data — nothing is dropped — which
/// matters because PostgreSQL caps a statement at 65535 bind parameters and an
/// event binds 12 of them. The inbound size is separately bounded by tonic's
/// 4 MiB default decode limit.
pub const INGEST_CHUNK: usize = 256;

#[tonic::async_trait]
pub trait Store: Send + Sync + 'static {
    async fn runtime_changes(
        &self,
        principal: &str,
    ) -> Result<crate::ambiance::changes::Changes, crate::ambiance::RuntimeError>;
    async fn runtime_sweep(&self, limit: usize) -> Result<usize, crate::ambiance::RuntimeError>;
    async fn runtime(
        &self,
        principal: &str,
        operation: crate::ambiance::RuntimeOperation,
    ) -> Result<crate::ambiance::RuntimeResult, crate::ambiance::RuntimeError>;
    async fn surface(
        &self,
        principal: &str,
        surface_id: uuid::Uuid,
    ) -> Result<Option<crate::surface_registry::Surface>, crate::surface_registry::RegistryError>;
    async fn surfaces(
        &self,
        principal: &str,
    ) -> Result<Vec<crate::surface_registry::Surface>, crate::surface_registry::RegistryError>;

    async fn mutate_surface(
        &self,
        principal: &str,
        surface_id: uuid::Uuid,
        mutation: crate::surface_registry::Mutation,
    ) -> Result<crate::surface_registry::Surface, crate::surface_registry::RegistryError>;

    /// Persist `list` under `principal`, returning the canonical stored form of
    /// its plaintext contacts in request order.
    ///
    /// *Documented reading* of `CreateContacts`/`UpdateContacts`, neither of
    /// which the evidence pins down:
    ///
    /// * A contact with an empty `id` is new and receives a fresh UUIDv4.
    /// * A contact containing an `id` is an upsert against that id **within this
    ///   principal's book only**. Honouring a device-chosen id makes a retried
    ///   write idempotent and cannot reach another principal's data.
    /// * `version` is server-owned: `1` on first write, previous + 1 on each
    ///   subsequent one. A client-supplied `version` is advisory and ignored,
    ///   because `ContactDeltasRequest{id, version}` is the client telling the
    ///   server what it *already holds*, not asserting new state.
    /// * Every contact in one call shares one cursor — a call is one sync point.
    /// * Writing an id that was previously deleted retires its tombstone.
    async fn put_contacts(
        &self,
        principal: &str,
        list: &pb::ContactList,
    ) -> Written<Vec<ContactRecord>>;

    /// Remove `ids` under `principal`, recording a tombstone for each id that
    /// was actually present.
    ///
    /// *Documented reading:* deleting an id the principal never stored is a
    /// vacuous success — it records no tombstone, because the server has nothing
    /// to tell the principal's other devices about. `DeleteContacts` returns
    /// `google.protobuf.Empty`, so there is no shape in which to report a
    /// per-id result even if one were wanted.
    async fn delete_contacts(&self, principal: &str, ids: &[String]) -> Written<()>;

    /// Everything stored for `principal`.
    ///
    /// A principal that has written nothing gets `Ok` of a default (empty)
    /// snapshot — well-formed empty, and never another principal's rows.
    ///
    /// **`Err` is not the same answer as an empty snapshot** and the two must
    /// never be conflated. A backend that reports an outage as "you have no
    /// contacts" hands the wearer's pin an empty address book *and* a `latest`
    /// of `None`, so the next delta sync has no cursor to resume from either.
    /// Only genuine absence is `Ok(empty)`.
    async fn contacts(&self, principal: &str) -> Written<ContactSnapshot>;

    // --- capture ----------------------------------------------------------

    /// Record a capture and allocate its server-side identity + upload slots.
    ///
    /// **Idempotent on `device_local_id`**: the device retries `CreateMemory`,
    /// and a second uuid for the same capture would orphan the first one's
    /// upload slots. `bursts`/`files` say how many slots to allocate.
    async fn create_memory(&self, principal: &str, new: NewMemory) -> Written<MemoryRecord>;

    /// A capture by uuid or by its rendered numeric id.
    ///
    /// `Ok(None)` means the principal genuinely holds no such capture; `Err`
    /// means the store could not answer. Same reason the two writes below are
    /// `Written`: `AssetUploadWorkerImpl` maps `STATUS_MEMORY_NOT_FOUND` to its
    /// `default:` (FATAL) arm and gives up on the asset forever, so an outage
    /// rendered as "not found" strands the wearer's photo permanently.
    async fn memory(&self, principal: &str, uuid_or_id: &str) -> Written<Option<MemoryRecord>>;

    /// One page of a principal's captures as INDEX ONLY, newest first,
    /// tombstones excluded.
    ///
    /// **Clone-authored, not a stock RPC.** No `CaptureService` method the device
    /// calls lists captures — the Pin only ever creates and deletes its own. The
    /// capability is nonetheless `observed` at the *web* boundary: the recovered
    /// `.Center` client called `GET /capture/memories` and `GET /capture/captures`
    /// with `page`/`size`/`sort=userCreatedAt,DESC`. So a reader exists in the
    /// system being cloned; only its gRPC shape is `unknown`, and this is the
    /// clone's own answer to it, serving the companion dashboard rather than the
    /// device.
    ///
    /// **There is deliberately no whole-record listing.** There was one, and
    /// every caller of it wanted counts: it returned `MemoryRecord`s with their
    /// sealed frames attached, so producing `thumbnailCount` for a page cost
    /// O(total stored bytes) on an endpoint polled every five seconds. A reader
    /// that needs a capture's bytes has [`Store::memory`] (one row) and
    /// [`Store::memory_thumbnail`] (one frame); a reader that needs the index has
    /// this. Reintroducing the unbounded form would reintroduce the defect.
    ///
    /// `kinds` filters on the memory type and an empty slice means every kind.
    /// The filter belongs here rather than above the store because
    /// `/capture/captures` selects photos and videos: filtering after a limited
    /// fetch returns short — and wrong — pages.
    ///
    /// `offset`/`limit` are the window, and a non-positive `limit` returns no
    /// rows. [`StorePage::total`] is always the count the filter matches in
    /// full, including for a window past the end, because the page envelope
    /// reports it and an empty final page still has to say how many rows exist.
    ///
    /// `Err` is not an empty page: an outage rendered as "you have no captures"
    /// tells the wearer their memories are gone.
    async fn memory_page(
        &self,
        principal: &str,
        kinds: &[MemoryKind],
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<MemorySummary>>;

    /// How many live captures the principal holds, by kind (empty ⇒ all).
    ///
    /// Exists so a caller that wants a NUMBER does not download rows to call
    /// `.len()` on them — which additionally plateaued at whatever page size the
    /// caller happened to ask for, reporting a frozen count as if persistence
    /// had stalled.
    async fn count_memories(&self, principal: &str, kinds: &[MemoryKind]) -> Written<i64>;

    /// ONE sealed thumbnail, by capture and zero-based ordinal.
    ///
    /// `Ok(None)` covers both "no such capture for this principal" and "this
    /// capture has no such frame"; the two are one answer to the caller and
    /// distinguishing them would disclose which uuids exist. `Err` is an outage,
    /// never absence.
    ///
    /// Reading one frame through [`Store::memory`] instead decoded every frame
    /// of the capture to return one of them.
    async fn memory_thumbnail(
        &self,
        principal: &str,
        uuid_or_id: &str,
        index: usize,
    ) -> Written<Option<EncryptedData>>;

    /// Tombstone a capture. `Ok(false)` means the principal holds no such
    /// capture; `Err` means the store could not complete the delete.
    ///
    /// The distinction is load-bearing and used to be collapsed into a bare
    /// `bool`. `DeleteUploadWorkerImpl.handleDeleteMemoryResponse` deletes its
    /// local row on both `SUCCESS` and `NOT_FOUND` and only retries on
    /// `FAILURE`, so reporting a *failed* delete as "wasn't there" makes the
    /// wearer's device forget a capture the cloud still holds — a deletion the
    /// wearer asked for that silently never happens.
    async fn delete_memory(&self, principal: &str, uuid_or_id: &str) -> Written<bool>;

    /// Mark a capture's upload finished. `Ok(false)` means no such capture;
    /// `Err` means the store could not record the completion.
    ///
    /// Same reason as [`Store::delete_memory`]: `AssetUploadWorkerImpl` treats
    /// `STATUS_MEMORY_NOT_FOUND` as fatal and gives up on the asset forever,
    /// while `STATUS_INTERNAL_ERROR` is retried. A store failure reported as
    /// "not found" strands the wearer's photo permanently.
    async fn record_upload_complete(&self, principal: &str, uuid_or_id: &str) -> Written<bool>;

    // --- notes ------------------------------------------------------------

    /// Store a note and return its server-minted uuid.
    ///
    /// A note's body is an opaque `EncryptedData` blob the device sealed and is
    /// stored verbatim. Device RPCs that acknowledge a note derive its search
    /// index through the authoritative channel-key directory first and use
    /// [`Store::create_indexed_note`] for one durable write.
    ///
    /// `Written` because the handler acks `CREATE_SUCCESS` with the returned
    /// uuid: a write that silently failed would tell the wearer their note was
    /// captured while nothing was stored, and the device keeps no copy to retry
    /// from.
    async fn create_note(
        &self,
        principal: &str,
        encrypted_note: Option<EncryptedData>,
        encrypted_location: Option<EncryptedData>,
    ) -> Written<NoteRecord>;

    /// Store a note and its already-derived search text in the same durable
    /// write. A device note must never receive CREATE_SUCCESS between inserting
    /// the sealed row and publishing the index that makes it retrievable.
    async fn create_indexed_note(
        &self,
        principal: &str,
        encrypted_note: Option<EncryptedData>,
        encrypted_location: Option<EncryptedData>,
        indexed_text: Option<&str>,
    ) -> Written<NoteRecord>;

    /// The wearer's notes, newest first, bounded by `max_items` (non-positive is
    /// unbounded) and optionally by a creation-time window.
    ///
    /// `Err` is distinct from `Ok(vec![])`: an outage rendered as "no notes"
    /// tells the wearer their notes are gone.
    async fn recent_notes(
        &self,
        principal: &str,
        max_items: i32,
        start: Option<SyncTime>,
        end: Option<SyncTime>,
    ) -> Written<Vec<NoteRecord>>;

    /// One page of the wearer's notes, newest first.
    ///
    /// Same window semantics as [`Store::memory_page`], and the same reason for
    /// existing: `/notes` is polled every five seconds by the dashboard, and
    /// each note on the page is opened with the wearer's channel key before it
    /// is serialised. Paging above the store meant every poll decrypted the
    /// entire note history to render twenty rows.
    async fn note_page(
        &self,
        principal: &str,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<NoteRecord>>;

    /// How many notes the principal holds. See [`Store::count_memories`].
    async fn count_notes(&self, principal: &str) -> Written<i64>;

    /// Delete every note. Returns how many were removed.
    ///
    /// `Err` rather than `Ok(0)` when the delete could not be carried out — the
    /// wearer asked for an erasure and must not be told it happened.
    async fn delete_all_notes(&self, principal: &str) -> Written<usize>;

    /// Delete ONE note. `Ok(true)` means a note was removed, `Ok(false)` that
    /// this principal holds no such note, `Err` that the store could not contain
    /// the delete out.
    ///
    /// **Clone-authored, not a stock RPC** — the same standing as
    /// [`Store::memory_page`]. The device only ever erases *all* of its notes
    /// (`DeviceDeleteAllNotes`); a per-note delete is `observed` at the WEB
    /// boundary, where the recovered `.Center` carried a Forget control on a
    /// single row. So this serves the companion dashboard and changes nothing
    /// the Pin speaks.
    ///
    /// Scoped by `principal` like every other read and write here: another
    /// account's uuid matches nothing, which is `Ok(false)` — "no such note for
    /// *you*" — and never an error, because an error that only occurs for rows
    /// that exist is itself a disclosure that they exist.
    ///
    /// The three answers must never be collapsed. This is a privacy product: the
    /// wearer pressed a control that says *delete*, so reporting a failed delete
    /// as `Ok(false)` ("there was nothing to delete") tells them an erasure
    /// happened over a row that is still stored — the same lie
    /// [`Store::delete_all_notes`] documents.
    ///
    /// A hard delete, matching [`Store::delete_all_notes`], and deliberately
    /// **no tombstone**: nothing syncs notes back down. The device pushes a note
    /// with `CreateNote` and never reads the server's list, so there is no delta
    /// read a tombstone could appear in — dropping the row IS the deletion.
    async fn delete_note(&self, principal: &str, uuid: &str) -> Written<bool>;

    /// Record a plaintext index entry for a note the server was able to open.
    ///
    /// Note bodies are sealed by the device and stored verbatim. This legacy
    /// update is used only for explicitly best-effort backfill of an already
    /// acknowledged row; new device writes publish their index atomically via
    /// [`Store::create_indexed_note`].
    async fn index_note(&self, principal: &str, uuid: &str, plaintext: &str);

    /// Note uuids matching `query`, most recent first.
    ///
    /// Returns **uuids only**, never bodies: `SearchMemoryItem` carries just a
    /// uuid and the device resolves the content locally.
    ///
    /// `Err` is distinct from `Ok(vec![])` — "the search could not run" is not
    /// "nothing matched".
    async fn search_notes(
        &self,
        principal: &str,
        query: &str,
        max_results: i32,
    ) -> Written<Vec<String>>;

    /// Recent opened note bodies available for semantic ranking, newest first.
    /// Notes whose channel key was never imported are absent rather than exposed
    /// as undecodable blobs.
    async fn searchable_notes(
        &self,
        principal: &str,
        maximum: usize,
    ) -> Written<Vec<SearchableNote>>;

    // --- notable events ---------------------------------------------------

    /// Upsert events keyed on `event_identifier`, dropping empty identifiers.
    /// Returns the identifiers actually stored, in first-appearance order.
    ///
    /// An identifier repeated **inside one call** is one stored event
    /// (last-writer-wins) acknowledged once, not two. The device re-sends its
    /// whole unsynced table on every sync — `SyncEngine.performSync` selects
    /// `WHERE needs_sync = 1` with no `LIMIT` — so a batch is large and may well
    /// repeat itself; implementations must commit it without one round trip per
    /// event. See [`INGEST_CHUNK`].
    async fn ingest_events(
        &self,
        principal: &str,
        events: &[NotableEventRecord],
    ) -> Written<Vec<String>>;

    /// Events matching the filters, newest first, bounded by `max_results`
    /// (non-positive means unbounded). `start`/`end` bound `creation_time` — the
    /// device's history-restore query sends `event_start_time = now − 1 day`, so
    /// ignoring the window over-returns events outside the requested range.
    ///
    /// `Err` is distinct from `Ok(vec![])`: the device's history restore reads an
    /// empty answer as "nothing happened", not as "ask again later".
    #[allow(clippy::too_many_arguments)]
    async fn query_events(
        &self,
        principal: &str,
        event_type: &str,
        originator: &str,
        start: Option<SyncTime>,
        end: Option<SyncTime>,
        max_results: i32,
    ) -> Written<Vec<NotableEventRecord>>;

    /// Delete ONE event by its `event_identifier`. `Ok(true)` means a row was
    /// removed, `Ok(false)` that this principal holds no such event, `Err` that
    /// the store could not complete the delete.
    ///
    /// **Clone-authored over the WEB boundary**, like [`Store::delete_note`]:
    /// `events.proto` carries only `QueryEvents`/`Ingest`/`IngestBatch` and the
    /// device never deletes an event, so nothing here alters the device
    /// contract. What it serves is the `.Center` My Data rows — Ai Mic, Music,
    /// Calls, Translation — whose trash control had no backend at all.
    ///
    /// Scoped by `principal`, and the three answers stay distinct, for exactly
    /// the reasons spelled out on [`Store::delete_note`].
    ///
    /// A hard delete, no tombstone. Tombstones exist for contacts because the
    /// device DELTA-READS them (`ContactSnapshot::deletions_since`) and would
    /// otherwise keep a contact the wearer erased on the server. Events travel
    /// the other way: the device pushes them and only ever reads *current* state
    /// back through [`Store::query_events`], so the row's absence is the whole
    /// deletion and there is no delta channel to publish a tombstone into.
    /// Honest limit of that: the wearer's own Pin keeps its local copy of an
    /// event deleted here — no RPC exists to tell it otherwise — so this erases
    /// the cloud's record, which is what the control claims and all it claims.
    async fn delete_event(&self, principal: &str, event_identifier: &str) -> Written<bool>;

    // --- account ----------------------------------------------------------

    /// Store one `humane.account` payload under `(principal, kind)`, replacing
    /// whatever that pair held.
    ///
    /// `payload` is the prost encoding of the response message the matching read
    /// hands back; the bytes are opaque here. Nothing is decrypted, re-encrypted,
    /// or merged — a set RPC is the wearer's whole list, so the last write wins,
    /// which is the only reading the proto admits (there is no per-item id).
    ///
    /// `Written` because the device cannot tell an echo from a write. The
    /// handlers ack `EncryptedSetFoodRestrictions` by returning the wearer's own
    /// blob, so a swallowed failure looks exactly like success and their
    /// allergies are gone with nothing to indicate it.
    ///
    /// **Deliberately not defaulted.** A defaulted no-op would compile against
    /// every backend and leave persistence silently inert on whichever one did
    /// not override it — the failure mode this trait exists to prevent.
    async fn put_account_blob(
        &self,
        principal: &str,
        kind: AccountBlobKind,
        payload: &[u8],
    ) -> Written<()>;

    /// The payload stored under `(principal, kind)`, if any.
    ///
    /// `Ok(None)` is genuine absence — a device that has never set this payload —
    /// and the handler answers it with a well-formed empty response. `Err` is an
    /// outage and must not be collapsed into it: an empty food-restriction list
    /// tells the assistant the wearer has no allergies.
    async fn get_account_blob(
        &self,
        principal: &str,
        kind: AccountBlobKind,
    ) -> Written<Option<Vec<u8>>>;

    /// Atomically replace a blob only when its current value is exactly
    /// `expected`. `None` means the row must not exist yet.
    ///
    /// Stateful RPCs whose wire request is an incremental mutation use this to
    /// avoid losing a concurrent write between `get_account_blob` and
    /// `put_account_blob`. Callers re-read and retry when this returns `false`.
    async fn compare_and_swap_account_blob(
        &self,
        principal: &str,
        kind: AccountBlobKind,
        expected: Option<&[u8]>,
        replacement: &[u8],
    ) -> Written<bool>;
}

/// Build the store this deployment is configured for.
///
/// `COSMOS_DATABASE_URL` selects PostgreSQL — the documented target, and the only
/// backend the three stateful workloads can share. Unset keeps the in-memory
/// store with its per-workload snapshots.
///
/// A configured-but-unreachable database is a **hard failure**. Falling back to
/// memory would come up healthy and quietly serve every wearer an empty account,
/// which is precisely the data loss the database exists to prevent.
pub async fn configured() -> SharedStore {
    match std::env::var(crate::store_postgres::DATABASE_URL_ENV) {
        Ok(url) if !url.trim().is_empty() => {
            match crate::store_postgres::PostgresStore::connect(&url).await {
                Ok(store) => {
                    tracing::info!("store backend: postgres");
                    Arc::new(store)
                }
                Err(error) => panic!(
                    "COSMOS_DATABASE_URL is set but the database is unreachable: {error}. \
                     Refusing to start on an in-memory store, which would serve every \
                     wearer an empty account."
                ),
            }
        }
        _ => {
            tracing::info!("store backend: in-memory (set COSMOS_DATABASE_URL for postgres)");
            MemoryStore::shared()
        }
    }
}

/// Handle shared by the workload's stateful handlers, mirroring the
/// `SharedKeyMaterial` pattern in `keymaterial.rs`.
pub type SharedStore = Arc<dyn Store>;

/// Process-lifetime [`Store`]. State lives only in memory and only for the
/// process lifetime; a restart is indistinguishable, to a device, from a
/// never-synced account.
#[derive(Default)]
pub struct MemoryStore {
    /// Test-only observation of assistant memory preload/note writes/account
    /// context. Never a runtime authorization switch or a production metric.
    #[cfg(test)]
    pub(crate) assistant_private_accesses: std::sync::atomic::AtomicUsize,
    surfaces: Mutex<crate::surface_registry::RegistryBook>,
    runtime_signals: crate::ambiance::changes::Signals,
    books: Mutex<HashMap<String, ContactBook>>,
    captures: Mutex<HashMap<String, MemoryBook>>,
    /// `principal -> {payload kind -> opaque bytes}`. A `BTreeMap` so the
    /// snapshot is byte-stable across writes.
    account: Mutex<HashMap<String, BTreeMap<String, Vec<u8>>>>,
    /// Serialises snapshot writes. Every handler calls [`MemoryStore::persist`]
    /// after dropping its data lock, so without this two writers can be inside
    /// `persist` at once, interleave their `write`s into the temp file, and
    /// publish a half-and-half snapshot that parses as nothing.
    snapshot: Mutex<()>,
    /// Where this workload snapshots its state. `None` is memory-only, the right
    /// default for tests and local runs. Held on the struct rather than read from
    /// the environment per call so a store's durability is explicit and testable
    /// without mutating process-global state.
    state_path: Option<std::path::PathBuf>,
}

/// Per-principal capture and notable-event state.
#[derive(Default)]
struct MemoryBook {
    memories: Vec<MemoryRecord>,
    notes: Vec<NoteRecord>,
    events: Vec<NotableEventRecord>,
    /// Monotonic allocator for `Memory.id` and burst/file ids.
    next_id: i64,
}

impl MemoryBook {
    fn allocate(&mut self) -> i64 {
        self.next_id += 1;
        self.next_id
    }
}

impl MemoryStore {
    /// A ready-to-share handle, for wiring at service-registration time.
    /// Build the store, restoring any snapshot this workload previously wrote.
    ///
    /// Durability is configured by `COSMOS_STATE_DIR`; unset means memory-only.
    /// The process's one in-memory store.
    ///
    /// **Genuinely a singleton**, which the name previously only implied: this
    /// used to build a fresh `MemoryStore` per call, so two callers in the same
    /// process got two unrelated accounts. That is not a theoretical hazard —
    /// the ai-bus workload constructs its HTTP app (and with it the companion
    /// capture API) before it builds `capture_store` for the gRPC services, so
    /// every capture the device wrote landed in one store while the dashboard
    /// read an empty other one, with no error on either side.
    ///
    /// Restoring from `state_path` masked it only partially: two instances agree
    /// on what was on disk at startup and diverge on every write after.
    pub fn shared() -> SharedStore {
        static SHARED: OnceLock<SharedStore> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                let store = Self {
                    state_path: Self::configured_state_path(),
                    ..Default::default()
                };
                store.restore();
                Arc::new(store)
            })
            .clone()
    }

    /// Build a store persisting to an explicit path. Used by tests so durability
    /// can be exercised without touching process-global environment.
    #[cfg(test)]
    fn at_path(path: std::path::PathBuf) -> Self {
        let store = Self {
            state_path: Some(path),
            ..Default::default()
        };
        store.restore();
        store
    }
}

/// One principal's contact state.
#[derive(Default)]
struct ContactBook {
    contacts: Vec<ContactRecord>,
    encrypted: Vec<EncryptedContactRecord>,
    /// `id -> deletion cursor`. A `BTreeMap` so snapshot order is deterministic.
    /// Tombstones are retained for the process lifetime; a database
    /// implementation will want a retention bound, which an in-memory book of a
    /// single contact list does not need.
    tombstones: BTreeMap<String, SyncTime>,
}

impl ContactBook {
    /// The greatest cursor anywhere in this book.
    fn high_water(&self) -> Option<SyncTime> {
        self.contacts
            .iter()
            .map(|record| record.modified)
            .chain(self.encrypted.iter().map(|record| record.modified))
            .chain(self.tombstones.values().copied())
            .max()
    }

    /// A write stamp strictly greater than every cursor already stored, so a
    /// delta sync can never miss a write that landed inside one clock tick (or
    /// while the clock stepped backwards).
    fn stamp(&self) -> SyncTime {
        let now = SyncTime::now();
        match self.high_water() {
            Some(previous) if previous >= now => previous.successor(),
            _ => now,
        }
    }
}

/// Collapse an ingest batch to the events that will actually be written, in
/// first-appearance order.
///
/// Shared by both backends so they acknowledge the device identically. Two
/// things happen here:
///
/// * An event with an empty `event_identifier` has no key and is dropped — the
///   device would have nothing to reconcile the ack against.
/// * An identifier repeated inside one batch collapses to its **last** copy
///   (last-writer-wins, the same rule as re-ingest across calls). This is not
///   just tidiness: PostgreSQL rejects a multi-row `INSERT ... ON CONFLICT DO
///   UPDATE` whose rows collide with each other ("cannot affect row a second
///   time"), so the batched upsert is only correct on a collapsed batch.
pub(crate) fn collapse_ingest_batch(
    events: &[NotableEventRecord],
) -> Vec<(&str, &NotableEventRecord)> {
    let mut order: Vec<&str> = Vec::with_capacity(events.len());
    let mut latest: HashMap<&str, &NotableEventRecord> = HashMap::with_capacity(events.len());
    for incoming in events {
        if incoming.event_identifier.is_empty() {
            continue;
        }
        let identifier = incoming.event_identifier.as_str();
        if latest.insert(identifier, incoming).is_none() {
            order.push(identifier);
        }
    }
    order
        .into_iter()
        .map(|identifier| (identifier, latest[identifier]))
        .collect()
}

/// Build a memory record and its server-allocated upload slots.
///
/// Shared by both backends so a photo gets the same identity and the same
/// namespaced upload paths regardless of where it is stored. `numeric_id` is the
/// backend's monotonic allocation; burst and file ids derive from it so two
/// captures can never collide.
/// Words too common to contain meaning in a recall query.
///
/// A model asked "what do I like?" writes a query like *"what the wearer likes
/// preferences favorites interests"*. Without this, "the" and "what" match almost
/// any note and rank noise to the top.
const RECALL_STOPWORDS: &[&str] = &[
    "a", "an", "and", "any", "are", "as", "at", "be", "did", "do", "does", "for", "from", "had",
    "has", "have", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "that", "the",
    "their", "them", "they", "this", "to", "was", "were", "what", "when", "where", "which", "who",
    "wearer", "with", "you", "your",
];

/// Reduce a word to a comparison stem: lowercase, and drop the inflections that
/// otherwise defeat substring matching.
///
/// This is what "What do I like?" needed. The model searched for `likes`, the
/// wearer had saved `I like trains`, and `"i like trains".contains("likes")` is
/// false — so a note that plainly answered the question was reported as
/// "nothing saved". Stemming both sides makes `likes` and `like` the same token.
///
/// Deliberately a few suffix rules, not a real stemmer: this is a small lexical
/// index, and an aggressive stemmer would collide unrelated words while claiming
/// a linguistic precision the deployment does not have.
fn recall_stem(word: &str) -> &str {
    for suffix in ["ing", "ies", "es", "ed", "s"] {
        if let Some(stem) = word.strip_suffix(suffix) {
            // Keep stems meaningful; "is" must not become "i".
            if stem.len() >= 3 {
                return stem;
            }
        }
    }
    word
}

/// The meaningful, stemmed terms of a recall query or note.
pub fn recall_terms(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2 && !RECALL_STOPWORDS.contains(w))
        .map(|w| recall_stem(w).to_owned())
        .filter(|w| !w.is_empty())
        .collect()
}

/// How many distinct query terms this text matches.
///
/// One matcher shared by every recall path. They had drifted apart and failed
/// differently: the dated path tested `text.contains(<the whole query phrase>)`,
/// which a natural-language question can essentially never satisfy, while the
/// undated path did exact-substring term overlap that missed simple plurals.
/// A wearer asking the same question got "nothing saved" either way.
pub fn recall_hits(query: &str, text: &str) -> usize {
    let terms = recall_terms(query);
    if terms.is_empty() {
        return 0;
    }
    let hay = recall_terms(text);
    terms
        .iter()
        .filter(|term| {
            hay.iter().any(|word| {
                // Prefix either way, so "train" finds "trains" and vice versa.
                word == *term
                    || (term.len() >= 3 && word.starts_with(term.as_str()))
                    || (word.len() >= 3 && term.starts_with(word.as_str()))
            })
        })
        .count()
}

pub fn build_memory(new: NewMemory, numeric_id: i64) -> MemoryRecord {
    let NewMemory {
        kind,
        device_local_id,
        bursts,
        files_per_burst,
        device_created_time,
        gmt_offset,
        thumbnails,
        encrypted_location,
    } = new;

    // At least one burst with one file, so the device always has somewhere to
    // upload; a zero-slot response is what stranded captures before.
    //
    // The upper bound is the backstop for the same counts: `.max(1)` is a floor
    // and did nothing about large positives, so an `i32::MAX` on either field
    // reached the allocations below and took the whole workload down (see
    // [`MAX_BURSTS`]). The refusal lives at the service boundary, where the
    // caller can be told it asked for too much; by the time we are here there is
    // nobody left to tell, and a clamped capture that loses slots past the
    // ceiling is strictly better than an abort that loses every wearer's
    // in-flight request. Reaching the clamp means a caller skipped the boundary
    // check, so it is logged rather than passed over in silence.
    let burst_count = bursts.clamp(1, MAX_BURSTS);
    let per_burst = files_per_burst.clamp(1, MAX_FILES_PER_BURST);
    if bursts > MAX_BURSTS || files_per_burst > MAX_FILES_PER_BURST {
        tracing::warn!(
            requested_bursts = bursts,
            requested_files_per_burst = files_per_burst,
            burst_count,
            per_burst,
            "capture slot counts exceeded the ceiling and were clamped; the \
             caller should have been refused at the service boundary"
        );
    }
    let uuid = Uuid::new_v4().to_string();

    let mut burst_records = Vec::with_capacity(burst_count as usize);
    let mut next = numeric_id;
    for index in 0..burst_count as i64 {
        next += 1;
        let burst_uuid = Uuid::new_v4().to_string();
        let mut files = Vec::with_capacity(per_burst as usize);
        for file_index in 0..per_burst as i64 {
            next += 1;
            let file_uuid = Uuid::new_v4().to_string();
            // Storage keys are namespaced per memory/burst/file.
            let stem = format!("{uuid}/{burst_uuid}/{file_uuid}");
            files.push(BurstFileRecord {
                id: next,
                index: file_index,
                uuid: file_uuid,
                filename: format!("{stem}.bin"),
                metadata_filename: format!("{stem}.meta"),
                secure_filename: format!("{stem}.sec"),
                secure_raw_data_filename: format!("{stem}.raw"),
                imu_data_filename: format!("{stem}.imu"),
                video_timing_data_filename: format!("{stem}.timing"),
            });
        }
        burst_records.push(BurstRecord {
            id: next,
            index,
            uuid: burst_uuid,
            files,
        });
    }

    MemoryRecord {
        uuid,
        numeric_id,
        device_local_id,
        kind,
        device_created_time,
        gmt_offset,
        thumbnails,
        encrypted_location,
        // Notes and food logs contain no frames to upload.
        bursts: match kind {
            MemoryKind::Photo | MemoryKind::Video => burst_records,
            MemoryKind::FoodLog | MemoryKind::Note => Vec::new(),
        },
        upload_complete: false,
        deleted: None,
        created: SyncTime::now(),
    }
}

#[tonic::async_trait]
impl Store for MemoryStore {
    async fn runtime_changes(
        &self,
        principal: &str,
    ) -> Result<crate::ambiance::changes::Changes, crate::ambiance::RuntimeError> {
        if self.state_path.is_some() {
            return Err(crate::ambiance::RuntimeError::Unavailable);
        }
        Ok(self.runtime_signals.subscribe(principal))
    }
    async fn runtime_sweep(&self, limit: usize) -> Result<usize, crate::ambiance::RuntimeError> {
        use crate::ambiance::{RuntimeError, RuntimeOperation};
        if self.state_path.is_some() {
            return Err(RuntimeError::Unavailable);
        }
        let now = crate::surface_registry::now_ms();
        let principals: Vec<_> = self
            .surfaces
            .lock()
            .map_err(|_| RuntimeError::Unavailable)?
            .due
            .iter()
            .take_while(|(at, _)| *at <= now)
            .take(limit.min(32))
            .map(|(_, p)| p.clone())
            .collect();
        for principal in &principals {
            self.runtime(principal, RuntimeOperation::Sweep).await?;
        }
        Ok(principals.len())
    }
    async fn runtime(
        &self,
        principal: &str,
        operation: crate::ambiance::RuntimeOperation,
    ) -> Result<crate::ambiance::RuntimeResult, crate::ambiance::RuntimeError> {
        use crate::ambiance::{RuntimeError, ledger::LedgerEvent};
        if self.state_path.is_some() {
            return Err(RuntimeError::Unavailable);
        }
        let mut guard = self
            .surfaces
            .lock()
            .map_err(|_| RuntimeError::Unavailable)?;
        let mut registry = guard.get(principal).cloned().unwrap_or_default();
        let now = crate::surface_registry::now_ms();
        let previous_sequence = registry.events.len();
        let mut events = registry.runtime.reconcile(&registry.records, now);
        let mut working = registry.runtime.clone();
        let mut records = registry.records.clone();
        let result = match working.apply_with_registry(principal, &mut records, operation, now) {
            Ok(crate::ambiance::RuntimeTransition {
                result,
                events: appended,
                surface: changed,
            }) => {
                registry.runtime = working;
                registry.records = records;
                if let Some((record, kind)) = changed {
                    let sequence = registry.events.len() as u64 + 1;
                    let previous = registry
                        .events
                        .last()
                        .map(|e| e.hash())
                        .transpose()?
                        .unwrap_or_default();
                    let entry = crate::surface_registry::event(
                        principal, sequence, previous, kind, &record, now,
                    );
                    entry.hash()?;
                    registry.events.push(LedgerEvent::Enrollment(entry));
                }
                events.extend(appended);
                Ok(result)
            }
            Err(error) => Err(error),
        };
        for data in events {
            let sequence = registry.events.len() as u64 + 1;
            let previous = registry
                .events
                .last()
                .map(|e| e.hash())
                .transpose()?
                .unwrap_or_default();
            let entry = LedgerEvent::runtime(principal, sequence, previous, now, data);
            entry.hash()?;
            registry.events.push(entry);
        }
        registry.maintenance_ms = registry.runtime.next_maintenance_ms(&registry.records);
        let changed = registry.events.len() != previous_sequence;
        guard.publish(principal.to_owned(), registry);
        if changed {
            self.runtime_signals.notify(principal);
        }
        result
    }
    async fn surface(
        &self,
        principal: &str,
        surface_id: uuid::Uuid,
    ) -> Result<Option<crate::surface_registry::Surface>, crate::surface_registry::RegistryError>
    {
        use crate::surface_registry::{RegistryError, now_ms};
        if self.state_path.is_some() {
            return Err(RegistryError::Unavailable);
        }
        let guard = self
            .surfaces
            .lock()
            .map_err(|_| RegistryError::Unavailable)?;
        Ok(guard
            .get(principal)
            .and_then(|registry| registry.records.get(&surface_id))
            .map(|record| record.view(now_ms())))
    }
    async fn surfaces(
        &self,
        principal: &str,
    ) -> Result<Vec<crate::surface_registry::Surface>, crate::surface_registry::RegistryError> {
        use crate::surface_registry::{RegistryError, now_ms};
        if self.state_path.is_some() {
            return Err(RegistryError::Unavailable);
        }
        let guard = self
            .surfaces
            .lock()
            .map_err(|_| RegistryError::Unavailable)?;
        Ok(guard
            .get(principal)
            .map(|registry| {
                registry
                    .records
                    .values()
                    .filter(|r| !r.revoked)
                    .map(|r| r.view(now_ms()))
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn mutate_surface(
        &self,
        principal: &str,
        surface_id: uuid::Uuid,
        mutation: crate::surface_registry::Mutation,
    ) -> Result<crate::surface_registry::Surface, crate::surface_registry::RegistryError> {
        use crate::surface_registry::{RegistryError, event, now_ms, transition};
        // Existing snapshots are best-effort, not an atomic durable ledger.
        // Never report a registry write as persisted through that backend.
        if self.state_path.is_some() {
            return Err(RegistryError::Unavailable);
        }
        let mut guard = self
            .surfaces
            .lock()
            .map_err(|_| RegistryError::Unavailable)?;
        let mut registry = guard.get(principal).cloned().unwrap_or_default();
        let now = now_ms();
        let (record, kind) = transition(
            registry.records.get(&surface_id),
            registry.records.values().filter(|r| !r.revoked).count(),
            surface_id,
            &mutation,
            now,
        )?;
        if let Some(kind) = kind {
            let sequence = registry.events.len() as u64 + 1;
            let previous = registry
                .events
                .last()
                .map(|e| e.hash())
                .transpose()?
                .unwrap_or_default();
            let entry = event(principal, sequence, previous, kind, &record, now);
            entry.hash()?;
            registry
                .events
                .push(crate::ambiance::ledger::LedgerEvent::Enrollment(entry));
            registry.records.insert(surface_id, record.clone());
            for data in registry.runtime.reconcile(&registry.records, now) {
                let sequence = registry.events.len() as u64 + 1;
                let previous = registry
                    .events
                    .last()
                    .map(|e| e.hash())
                    .transpose()?
                    .unwrap_or_default();
                let entry = crate::ambiance::ledger::LedgerEvent::runtime(
                    principal, sequence, previous, now, data,
                );
                entry.hash()?;
                registry.events.push(entry);
            }
        }
        registry.maintenance_ms = registry.runtime.next_maintenance_ms(&registry.records);
        guard.publish(principal.to_owned(), registry);
        if kind.is_some() {
            self.runtime_signals.notify(principal);
        }
        Ok(record.view(now))
    }

    async fn put_contacts(
        &self,
        principal: &str,
        list: &pb::ContactList,
    ) -> Written<Vec<ContactRecord>> {
        let mut books = self.books.lock().expect("contact store poisoned");
        let book = books.entry(principal.to_owned()).or_default();
        let stamp = book.stamp();
        let mut written = Vec::with_capacity(list.contacts.len());

        for incoming in &list.contacts {
            let id = if incoming.id.is_empty() {
                Uuid::new_v4().to_string()
            } else {
                incoming.id.clone()
            };
            let existing = book
                .contacts
                .iter()
                .position(|record| record.contact.id == id);
            let version = existing.map_or(1, |index| {
                book.contacts[index].contact.version.saturating_add(1)
            });

            let mut contact = incoming.clone();
            contact.id.clone_from(&id);
            contact.version = version;
            contact.modified_at = Some(stamp.to_proto());
            let record = ContactRecord {
                contact,
                modified: stamp,
            };

            match existing {
                Some(index) => book.contacts[index] = record.clone(),
                None => book.contacts.push(record.clone()),
            }
            // Re-creating a previously deleted id makes it live again; leaving
            // the tombstone would delete it from every other device on the next
            // delta sync.
            book.tombstones.remove(&id);
            written.push(record);
        }

        for (index, data) in list.encrypted_contacts.iter().enumerate() {
            // The versions are a parallel repeated field, so a short or absent
            // list is not an error — the missing entries default.
            let version = list
                .encrypted_contacts_versions
                .get(index)
                .copied()
                .unwrap_or_default();
            match book
                .encrypted
                .iter_mut()
                .find(|record| record.data == *data)
            {
                Some(record) => {
                    record.version = version;
                    record.modified = stamp;
                }
                None => book.encrypted.push(EncryptedContactRecord {
                    data: data.clone(),
                    version,
                    modified: stamp,
                }),
            }
        }

        drop(books);
        self.persist();
        // The in-memory store cannot fail to record a write.
        Ok(written)
    }

    async fn delete_contacts(&self, principal: &str, ids: &[String]) -> Written<()> {
        let mut books = self.books.lock().expect("contact store poisoned");
        // No book means the principal has written nothing; a delete creates no
        // state for it.
        let Some(book) = books.get_mut(principal) else {
            return Ok(());
        };
        let stamp = book.stamp();
        for id in ids {
            if let Some(index) = book
                .contacts
                .iter()
                .position(|record| record.contact.id == *id)
            {
                book.contacts.remove(index);
                book.tombstones.insert(id.clone(), stamp);
            }
        }
        drop(books);
        self.persist();
        Ok(())
    }

    async fn contacts(&self, principal: &str) -> Written<ContactSnapshot> {
        let books = self.books.lock().expect("contact store poisoned");
        let Some(book) = books.get(principal) else {
            // Genuine absence — `Ok` of an empty snapshot, never `Err`.
            return Ok(ContactSnapshot::default());
        };
        Ok(ContactSnapshot {
            contacts: book.contacts.clone(),
            encrypted: book.encrypted.clone(),
            deletions: book
                .tombstones
                .iter()
                .map(|(id, deleted)| DeletionRecord {
                    id: id.clone(),
                    deleted: *deleted,
                })
                .collect(),
            latest: book.high_water(),
        })
    }

    // --- capture ----------------------------------------------------------

    async fn create_memory(&self, principal: &str, new: NewMemory) -> Written<MemoryRecord> {
        let NewMemory {
            kind,
            device_local_id,
            bursts,
            files_per_burst,
            device_created_time,
            gmt_offset,
            thumbnails,
            encrypted_location,
        } = new;
        let device_local_id = device_local_id.as_str();
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let book = guard.entry(principal.to_owned()).or_default();

        // Idempotent on the device's own id: a retried CreateMemory must return
        // the SAME uuid, or the first attempt's upload slots are orphaned.
        if !device_local_id.is_empty() {
            if let Some(existing) = book
                .memories
                .iter()
                .find(|m| m.device_local_id == device_local_id && m.deleted.is_none())
            {
                return Ok(existing.clone());
            }
        }

        let numeric_id = book.allocate();
        // At least one burst with one file, so the device always has somewhere
        // to upload; a zero-slot response is what stranded the capture before.
        let burst_count = bursts.max(1);
        let per_burst = files_per_burst.max(1);
        let uuid = uuid::Uuid::new_v4().to_string();

        let mut burst_records = Vec::with_capacity(burst_count as usize);
        for index in 0..burst_count as i64 {
            let burst_id = book.allocate();
            let burst_uuid = uuid::Uuid::new_v4().to_string();
            let mut files = Vec::with_capacity(per_burst as usize);
            for file_index in 0..per_burst as i64 {
                let file_id = book.allocate();
                let file_uuid = uuid::Uuid::new_v4().to_string();
                // Paths are server-allocated storage keys, namespaced per
                // memory/burst so two captures can never collide.
                let stem = format!("{uuid}/{burst_uuid}/{file_uuid}");
                files.push(BurstFileRecord {
                    id: file_id,
                    index: file_index,
                    uuid: file_uuid,
                    filename: format!("{stem}.bin"),
                    metadata_filename: format!("{stem}.meta"),
                    secure_filename: format!("{stem}.sec"),
                    secure_raw_data_filename: format!("{stem}.raw"),
                    imu_data_filename: format!("{stem}.imu"),
                    video_timing_data_filename: format!("{stem}.timing"),
                });
            }
            burst_records.push(BurstRecord {
                id: burst_id,
                index,
                uuid: burst_uuid,
                files,
            });
        }

        let record = MemoryRecord {
            uuid,
            numeric_id,
            device_local_id: device_local_id.to_owned(),
            kind,
            device_created_time,
            gmt_offset,
            thumbnails,
            encrypted_location,
            // Notes and food logs contain no frames to upload.
            bursts: match kind {
                MemoryKind::Photo | MemoryKind::Video => burst_records,
                MemoryKind::FoodLog | MemoryKind::Note => Vec::new(),
            },
            upload_complete: false,
            deleted: None,
            created: SyncTime::now(),
        };
        book.memories.push(record.clone());
        drop(guard);
        self.persist();
        Ok(record)
    }

    async fn memory(&self, principal: &str, uuid_or_id: &str) -> Written<Option<MemoryRecord>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        Ok(guard.get(principal).and_then(|book| {
            book.memories
                .iter()
                .find(|m| {
                    m.deleted.is_none()
                        && (m.uuid == uuid_or_id || m.numeric_id.to_string() == uuid_or_id)
                })
                .cloned()
        }))
    }

    async fn memory_page(
        &self,
        principal: &str,
        kinds: &[MemoryKind],
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<MemorySummary>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get(principal) else {
            return Ok(StorePage {
                records: Vec::new(),
                total: 0,
            });
        };
        // Order on the device's own creation time where it gave us one, falling
        // back to when we recorded it.
        let stamp = |m: &MemoryRecord| m.device_created_time.unwrap_or(m.created);
        let mut live: Vec<&MemoryRecord> = book
            .memories
            .iter()
            .filter(|m| m.deleted.is_none())
            .filter(|m| kinds.is_empty() || kinds.contains(&m.kind))
            .collect();
        // The SAME total order the Postgres listing sorts by
        // (stamp DESC, numeric_id DESC). A tie broken differently by the two
        // backends would make one of them drop or repeat a row at a page
        // boundary, which is invisible until a wearer scrolls past it.
        live.sort_by(|a, b| {
            stamp(b)
                .cmp(&stamp(a))
                .then_with(|| b.numeric_id.cmp(&a.numeric_id))
        });
        let total = live.len() as i64;
        let records = live
            .into_iter()
            .skip(offset.max(0) as usize)
            .take(limit.max(0) as usize)
            .map(MemorySummary::from_record)
            .collect();
        Ok(StorePage { records, total })
    }

    async fn count_memories(&self, principal: &str, kinds: &[MemoryKind]) -> Written<i64> {
        let guard = self.captures.lock().expect("capture store poisoned");
        Ok(guard.get(principal).map_or(0, |book| {
            book.memories
                .iter()
                .filter(|m| m.deleted.is_none())
                .filter(|m| kinds.is_empty() || kinds.contains(&m.kind))
                .count() as i64
        }))
    }

    async fn memory_thumbnail(
        &self,
        principal: &str,
        uuid_or_id: &str,
        index: usize,
    ) -> Written<Option<EncryptedData>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        Ok(guard.get(principal).and_then(|book| {
            book.memories
                .iter()
                .find(|m| {
                    m.deleted.is_none()
                        && (m.uuid == uuid_or_id || m.numeric_id.to_string() == uuid_or_id)
                })
                .and_then(|m| m.thumbnails.get(index))
                .cloned()
        }))
    }

    async fn delete_memory(&self, principal: &str, uuid_or_id: &str) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return Ok(false);
        };
        let now = SyncTime::now();
        let mut deleted = false;
        for m in book.memories.iter_mut() {
            if m.deleted.is_none()
                && (m.uuid == uuid_or_id || m.numeric_id.to_string() == uuid_or_id)
            {
                m.deleted = Some(now);
                deleted = true;
                break;
            }
        }
        drop(guard);
        if deleted {
            self.persist();
        }
        Ok(deleted)
    }

    async fn record_upload_complete(&self, principal: &str, uuid_or_id: &str) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return Ok(false);
        };
        let mut marked = false;
        for m in book.memories.iter_mut() {
            if m.deleted.is_none()
                && (m.uuid == uuid_or_id || m.numeric_id.to_string() == uuid_or_id)
            {
                m.upload_complete = true;
                marked = true;
                break;
            }
        }
        drop(guard);
        if marked {
            self.persist();
        }
        Ok(marked)
    }

    // --- notes ------------------------------------------------------------

    async fn create_note(
        &self,
        principal: &str,
        encrypted_note: Option<EncryptedData>,
        encrypted_location: Option<EncryptedData>,
    ) -> Written<NoteRecord> {
        #[cfg(test)]
        self.assistant_private_accesses
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let book = guard.entry(principal.to_owned()).or_default();
        let record = NoteRecord {
            uuid: uuid::Uuid::new_v4().to_string(),
            indexed_text: None,
            encrypted_note,
            encrypted_location,
            created: SyncTime::now(),
        };
        book.notes.push(record.clone());
        drop(guard);
        self.persist();
        Ok(record)
    }

    async fn create_indexed_note(
        &self,
        principal: &str,
        encrypted_note: Option<EncryptedData>,
        encrypted_location: Option<EncryptedData>,
        indexed_text: Option<&str>,
    ) -> Written<NoteRecord> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let book = guard.entry(principal.to_owned()).or_default();
        let record = NoteRecord {
            uuid: uuid::Uuid::new_v4().to_string(),
            indexed_text: indexed_text.map(str::to_lowercase),
            encrypted_note,
            encrypted_location,
            created: SyncTime::now(),
        };
        book.notes.push(record.clone());
        drop(guard);
        self.persist();
        Ok(record)
    }

    async fn recent_notes(
        &self,
        principal: &str,
        max_items: i32,
        start: Option<SyncTime>,
        end: Option<SyncTime>,
    ) -> Written<Vec<NoteRecord>> {
        #[cfg(test)]
        self.assistant_private_accesses
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get(principal) else {
            return Ok(Vec::new());
        };
        let mut found: Vec<NoteRecord> = book
            .notes
            .iter()
            // The window is inclusive on both ends; an unset bound is open.
            .filter(|n| start.is_none_or(|s| n.created >= s))
            .filter(|n| end.is_none_or(|e| n.created <= e))
            .cloned()
            .collect();
        found.sort_by(|a, b| b.created.cmp(&a.created)); // newest first
        if max_items > 0 {
            found.truncate(max_items as usize);
        }
        Ok(found)
    }

    async fn note_page(
        &self,
        principal: &str,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<NoteRecord>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get(principal) else {
            return Ok(StorePage {
                records: Vec::new(),
                total: 0,
            });
        };
        let mut found: Vec<NoteRecord> = book.notes.to_vec();
        found.sort_by(|a, b| b.created.cmp(&a.created)); // newest first
        let total = found.len() as i64;
        let records = found
            .into_iter()
            .skip(offset.max(0) as usize)
            .take(limit.max(0) as usize)
            .collect();
        Ok(StorePage { records, total })
    }

    async fn count_notes(&self, principal: &str) -> Written<i64> {
        let guard = self.captures.lock().expect("capture store poisoned");
        Ok(guard
            .get(principal)
            .map_or(0, |book| book.notes.len() as i64))
    }

    async fn index_note(&self, principal: &str, uuid: &str, plaintext: &str) {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return;
        };
        if let Some(note) = book.notes.iter_mut().find(|n| n.uuid == uuid) {
            note.indexed_text = Some(plaintext.to_lowercase());
        }
        drop(guard);
        self.persist();
    }

    async fn search_notes(
        &self,
        principal: &str,
        query: &str,
        max_results: i32,
    ) -> Written<Vec<String>> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        // Lexical term overlap, not embeddings: this deployment hosts no
        // embedding model, and claiming semantic ranking we do not perform would
        // misrepresent the result order. Documented rather than dressed up.
        let guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get(principal) else {
            return Ok(Vec::new());
        };
        let mut scored: Vec<(usize, &NoteRecord)> = book
            .notes
            .iter()
            .filter_map(|n| {
                let text = n.indexed_text.as_deref()?;
                let hits = recall_hits(&needle, text);
                (hits > 0).then_some((hits, n))
            })
            .collect();
        // Most matching terms first, then most recent.
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.created.cmp(&a.1.created)));
        let mut uuids: Vec<String> = scored.into_iter().map(|(_, n)| n.uuid.clone()).collect();
        if max_results > 0 {
            uuids.truncate(max_results as usize);
        }
        Ok(uuids)
    }

    async fn searchable_notes(
        &self,
        principal: &str,
        maximum: usize,
    ) -> Written<Vec<SearchableNote>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get(principal) else {
            return Ok(Vec::new());
        };
        let mut notes = book
            .notes
            .iter()
            .filter_map(|note| {
                note.indexed_text.as_ref().map(|text| {
                    (
                        note.created,
                        SearchableNote {
                            uuid: note.uuid.clone(),
                            text: text.clone(),
                        },
                    )
                })
            })
            .collect::<Vec<_>>();
        notes.sort_by(|left, right| right.0.cmp(&left.0));
        Ok(notes
            .into_iter()
            .take(maximum)
            .map(|(_, note)| note)
            .collect())
    }

    async fn delete_all_notes(&self, principal: &str) -> Written<usize> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return Ok(0);
        };
        let removed = book.notes.len();
        book.notes.clear();
        drop(guard);
        self.persist();
        Ok(removed)
    }

    async fn delete_note(&self, principal: &str, uuid: &str) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        // No book means this principal has stored nothing; a delete creates no
        // state for it — same shape as `delete_contacts`.
        let Some(book) = guard.get_mut(principal) else {
            return Ok(false);
        };
        // The lookup is INSIDE this principal's book, so another account's uuid
        // is not findable here rather than being found and refused.
        let Some(at) = book.notes.iter().position(|n| n.uuid == uuid) else {
            return Ok(false);
        };
        book.notes.remove(at);
        drop(guard);
        // Persist only on a real removal, and before answering: a snapshot still
        // holding the note would resurrect it on the next restart, which is a
        // deletion the wearer was told happened and then silently undone.
        self.persist();
        Ok(true)
    }

    // --- notable events ---------------------------------------------------

    async fn ingest_events(
        &self,
        principal: &str,
        events: &[NotableEventRecord],
    ) -> Written<Vec<String>> {
        let batch = collapse_ingest_batch(events);
        if batch.is_empty() {
            // Nothing keyed: no state to create, and no snapshot to rewrite.
            return Ok(Vec::new());
        }

        let mut guard = self.captures.lock().expect("capture store poisoned");
        let book = guard.entry(principal.to_owned()).or_default();

        // Resolve every write position against one index built once. The linear
        // scan this replaces was O(stored x incoming), and both sides grow
        // together because the device re-sends its whole unsynced table on every
        // sync — the quadratic term is what a wearer with a long history pays.
        // The index borrows from `book.events`, so positions are resolved in
        // their own scope and the writes applied after it ends.
        let mut plan: Vec<(Option<usize>, &NotableEventRecord)> = Vec::with_capacity(batch.len());
        {
            let index: HashMap<&str, usize> = book
                .events
                .iter()
                .enumerate()
                .map(|(at, event)| (event.event_identifier.as_str(), at))
                .collect();
            for (identifier, incoming) in &batch {
                plan.push((index.get(identifier).copied(), *incoming));
            }
        }
        for (existing, incoming) in plan {
            match existing {
                Some(at) => book.events[at] = incoming.clone(),
                None => book.events.push(incoming.clone()),
            }
        }

        drop(guard);
        self.persist();
        Ok(batch
            .into_iter()
            .map(|(identifier, _)| identifier.to_owned())
            .collect())
    }

    async fn query_events(
        &self,
        principal: &str,
        event_type: &str,
        originator: &str,
        start: Option<SyncTime>,
        end: Option<SyncTime>,
        max_results: i32,
    ) -> Written<Vec<NotableEventRecord>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get(principal) else {
            return Ok(Vec::new());
        };
        let mut found: Vec<NotableEventRecord> = book
            .events
            .iter()
            // An empty filter matches everything; a set one is an exact match.
            .filter(|e| event_type.is_empty() || e.event_type == event_type)
            .filter(|e| originator.is_empty() || e.originator_identifier == originator)
            // Time window on creation_time. A record with no creation time can't
            // be proven out of range, so it is kept (the device dedups by uuid).
            .filter(|e| match (&start, &e.creation_time) {
                (Some(s), Some(ct)) => ct >= s,
                _ => true,
            })
            .filter(|e| match (&end, &e.creation_time) {
                (Some(en), Some(ct)) => ct <= en,
                _ => true,
            })
            .cloned()
            .collect();
        // Newest first, by the device's creation time where it gave us one.
        found.sort_by(|a, b| b.creation_time.cmp(&a.creation_time));
        if max_results > 0 {
            found.truncate(max_results as usize);
        }
        Ok(found)
    }

    async fn delete_event(&self, principal: &str, event_identifier: &str) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return Ok(false);
        };
        // Keyed on the same identifier `ingest_events` upserts on, and searched
        // only within this principal's book.
        let Some(at) = book
            .events
            .iter()
            .position(|e| e.event_identifier == event_identifier)
        else {
            return Ok(false);
        };
        book.events.remove(at);
        drop(guard);
        self.persist();
        Ok(true)
    }

    // --- account ----------------------------------------------------------

    async fn put_account_blob(
        &self,
        principal: &str,
        kind: AccountBlobKind,
        payload: &[u8],
    ) -> Written<()> {
        {
            let mut guard = self.account.lock().expect("account store poisoned");
            guard
                .entry(principal.to_owned())
                .or_default()
                .insert(kind.as_str().to_owned(), payload.to_vec());
        }
        self.persist();
        // The in-memory store cannot fail to record a write.
        Ok(())
    }

    async fn get_account_blob(
        &self,
        principal: &str,
        kind: AccountBlobKind,
    ) -> Written<Option<Vec<u8>>> {
        #[cfg(test)]
        self.assistant_private_accesses
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let guard = self.account.lock().expect("account store poisoned");
        Ok(guard
            .get(principal)
            .and_then(|blobs| blobs.get(kind.as_str()))
            .cloned())
    }

    async fn compare_and_swap_account_blob(
        &self,
        principal: &str,
        kind: AccountBlobKind,
        expected: Option<&[u8]>,
        replacement: &[u8],
    ) -> Written<bool> {
        let changed = {
            let mut guard = self.account.lock().expect("account store poisoned");
            let blobs = guard.entry(principal.to_owned()).or_default();
            if blobs.get(kind.as_str()).map(Vec::as_slice) != expected {
                false
            } else {
                blobs.insert(kind.as_str().to_owned(), replacement.to_vec());
                true
            }
        };
        if changed {
            self.persist();
        }
        Ok(changed)
    }
}

#[cfg(test)]
pub(crate) async fn runtime_test_terminal(
    store: &dyn Store,
    principal: &str,
) -> crate::ambiance::Action {
    use crate::ambiance::*;
    use crate::surface_registry::{Mutation, hash, pin_surface_id};
    let surface_id = pin_surface_id(principal, "aabb");
    store
        .mutate_surface(
            principal,
            surface_id,
            Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
        )
        .await
        .unwrap();
    let RuntimeResult::Begun(fence) = store
        .runtime(
            principal,
            RuntimeOperation::Begin {
                turn_id: uuid::Uuid::new_v4(),
                worker: uuid::Uuid::new_v4(),
                origin: OriginProof::Pin {
                    device: cosmos_core::AuthenticatedDeviceIdentity::from_edge("aabb").unwrap(),
                    surface_id,
                    echo_fingerprint: crate::ambiance::echo::fingerprint("retention request"),
                },
                request_digest: hash(b"retention request"),
                privacy_floor: PrivacyClass::SharedRoom,
            },
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    let RuntimeResult::Proposed(action) = store
        .runtime(
            principal,
            RuntimeOperation::Propose {
                turn_id: fence.turn_id,
                generation: fence.generation,
                worker: fence.worker,
                intent: SemanticIntent::InformationalSpeech {
                    text: "retention fixture answer".into(),
                },
                privacy: PrivacyClass::SharedRoom,
            },
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    let RuntimeResult::Dispatch(action) = store
        .runtime(
            principal,
            RuntimeOperation::Claim {
                action_id: action.id,
                generation: fence.generation,
                worker: fence.worker,
            },
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    store
        .runtime(
            principal,
            RuntimeOperation::Finish {
                turn_id: fence.turn_id,
                generation: fence.generation,
                worker: fence.worker,
            },
        )
        .await
        .unwrap();
    action
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn ambiance_retention_bounded_sweep_and_startup_clean_existing_payloads() {
        use crate::ambiance::runtime::AmbianceRuntime;
        let store = std::sync::Arc::new(MemoryStore::default());
        let mut fixtures = Vec::new();
        for principal in ["U:retention-a", "U:retention-b", "U:retention-c"] {
            let action = runtime_test_terminal(store.as_ref(), principal).await;
            assert!(
                !action.intent.text().is_empty(),
                "one-use dispatch retains its owned clone"
            );
            {
                let guard = store.surfaces.lock().unwrap();
                assert!(
                    guard[principal].runtime.actions[&action.id]
                        .intent
                        .text()
                        .is_empty()
                );
            }
            fixtures.push((principal.to_owned(), action));
        }
        let restore_old_payloads = || {
            let mut guard = store.surfaces.lock().unwrap();
            for (principal, action) in &fixtures {
                let mut registry = guard[principal].clone();
                registry.runtime.actions.get_mut(&action.id).unwrap().intent =
                    action.intent.clone();
                registry.maintenance_ms = 0;
                guard.publish(principal.clone(), registry);
            }
        };
        restore_old_payloads();
        assert_eq!(store.runtime_sweep(1).await.unwrap(), 1);
        {
            let guard = store.surfaces.lock().unwrap();
            assert_eq!(
                fixtures
                    .iter()
                    .filter(|(p, a)| guard[p].runtime.actions[&a.id].intent.text().is_empty())
                    .count(),
                1
            );
        }
        assert_eq!(store.runtime_sweep(32).await.unwrap(), 2);
        assert_eq!(store.runtime_sweep(32).await.unwrap(), 0);
        restore_old_payloads();
        // A fresh runtime discovers already-persisted due entries without any
        // principal visiting an ingress or browser polling endpoint.
        let runtime = AmbianceRuntime::new(
            store.clone(),
            std::sync::Arc::new(crate::assistant::llm::MockChatModel::new(vec![])),
            None,
        );
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let done = {
                    let guard = store.surfaces.lock().unwrap();
                    fixtures
                        .iter()
                        .all(|(p, a)| guard[p].runtime.actions[&a.id].intent.text().is_empty())
                };
                if done {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        drop(runtime);
    }

    #[tokio::test]
    async fn ambiance_memory_registry_change_and_cancellation_share_one_chain() {
        use crate::ambiance::*;
        use crate::surface_registry::{Mutation, hash};
        let store = MemoryStore::default();
        let principal = "U:runtime-memory";
        let surface_id = uuid::Uuid::new_v4();
        let incarnation = uuid::Uuid::new_v4();
        let token_hash = hash(b"runtime test capability");
        store
            .mutate_surface(
                principal,
                surface_id,
                Mutation::Approve {
                    token_hash: token_hash.clone(),
                    incarnation,
                },
            )
            .await
            .unwrap();
        store
            .mutate_surface(
                principal,
                surface_id,
                Mutation::State {
                    token_hash: token_hash.clone(),
                    incarnation,
                    sequence: 1,
                    visible: true,
                },
            )
            .await
            .unwrap();
        let proof = || BrowserProof {
            surface_id,
            incarnation,
            token_hash: token_hash.clone(),
        };
        let RuntimeResult::Begun(fence) = store
            .runtime(
                principal,
                RuntimeOperation::Begin {
                    turn_id: uuid::Uuid::new_v4(),
                    worker: uuid::Uuid::new_v4(),
                    origin: OriginProof::Browser(proof()),
                    request_digest: hash(b"request"),
                    privacy_floor: PrivacyClass::Public,
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        let RuntimeResult::Proposed(action) = store
            .runtime(
                principal,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::VisualTextCard {
                        text: "bounded answer".into(),
                    },
                    privacy: PrivacyClass::Public,
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        store
            .runtime(
                principal,
                RuntimeOperation::Poll {
                    connection: proof(),
                },
            )
            .await
            .unwrap();
        store
            .mutate_surface(
                principal,
                surface_id,
                Mutation::State {
                    token_hash: token_hash.clone(),
                    incarnation,
                    sequence: 2,
                    visible: true,
                },
            )
            .await
            .unwrap();
        {
            let guard = store.surfaces.lock().unwrap();
            assert_eq!(
                guard[principal].runtime.actions[&action.id].status,
                ActionStatus::Dispatched
            );
        }
        store
            .mutate_surface(
                principal,
                surface_id,
                Mutation::State {
                    token_hash,
                    incarnation,
                    sequence: 3,
                    visible: false,
                },
            )
            .await
            .unwrap();
        let guard = store.surfaces.lock().unwrap();
        let registry = &guard[principal];
        assert_eq!(
            registry.runtime.actions[&action.id].status,
            ActionStatus::Cancelled
        );
        assert!(registry.runtime.turn.as_ref().unwrap().cancelled);
        for pair in registry.events.windows(2) {
            assert_eq!(pair[1].previous_hash(), pair[0].hash().unwrap());
            assert_eq!(pair[1].sequence(), pair[0].sequence() + 1);
        }
        assert!(matches!(
            registry.events.last().unwrap(),
            crate::ambiance::ledger::LedgerEvent::Runtime(_)
        ));
    }

    #[tokio::test]
    async fn ambiance_failed_operation_commits_only_logged_expiry_and_snapshot_fails_closed() {
        use crate::ambiance::*;
        use crate::surface_registry::{Mutation, hash};
        let store = MemoryStore::default();
        let principal = "U:runtime-expiry";
        let device = cosmos_core::AuthenticatedDeviceIdentity::from_edge("aabb").unwrap();
        let surface_id = crate::surface_registry::pin_surface_id(principal, "aabb");
        store
            .mutate_surface(
                principal,
                surface_id,
                Mutation::ApprovePin {
                    device_id: "aabb".into(),
                },
            )
            .await
            .unwrap();
        let RuntimeResult::Begun(fence) = store
            .runtime(
                principal,
                RuntimeOperation::Begin {
                    turn_id: uuid::Uuid::new_v4(),
                    worker: uuid::Uuid::new_v4(),
                    origin: OriginProof::Pin {
                        device,
                        surface_id,
                        echo_fingerprint: crate::ambiance::echo::fingerprint("request"),
                    },
                    request_digest: hash(b"request"),
                    privacy_floor: PrivacyClass::SharedRoom,
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        // Synthetic time state only; production leases are runtime/DB stamped.
        {
            let mut guard = store.surfaces.lock().unwrap();
            guard
                .get_mut(principal)
                .unwrap()
                .runtime
                .turn
                .as_mut()
                .unwrap()
                .lease_until_ms = 0;
        }
        let result = store
            .runtime(
                principal,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::InformationalSpeech {
                        text: "late output".into(),
                    },
                    privacy: PrivacyClass::Public,
                },
            )
            .await;
        assert!(matches!(result, Err(RuntimeError::Stale)));
        {
            let guard = store.surfaces.lock().unwrap();
            let registry = &guard[principal];
            assert!(registry.runtime.turn.as_ref().unwrap().cancelled);
            assert!(registry.runtime.actions.is_empty());
            assert_eq!(registry.events.len(), 3);
        }
        let snapshot = MemoryStore {
            state_path: Some(std::path::PathBuf::from("/unwritten-runtime-test")),
            ..Default::default()
        };
        assert!(matches!(
            snapshot.runtime(principal, RuntimeOperation::Sweep).await,
            Err(RuntimeError::Unavailable)
        ));
        assert!(snapshot.surfaces.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn surface_registry_snapshot_backend_rejects_without_mutation() {
        use crate::surface_registry::{Mutation, RegistryError, hash};
        let store = MemoryStore {
            state_path: Some(std::path::PathBuf::from("/unwritten-surface-test-snapshot")),
            ..Default::default()
        };
        let result = store
            .mutate_surface(
                "U:surface-test",
                uuid::Uuid::new_v4(),
                Mutation::Approve {
                    token_hash: hash(b"synthetic"),
                    incarnation: uuid::Uuid::new_v4(),
                },
            )
            .await;
        assert_eq!(result, Err(RegistryError::Unavailable));
        assert_eq!(
            store.surfaces("U:surface-test").await,
            Err(RegistryError::Unavailable)
        );
        assert!(store.surfaces.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn surface_registry_memory_bounds_active_enrollments_and_chains_atomic_changes() {
        use crate::surface_registry::{Mutation, RegistryError, hash};
        let store = MemoryStore::default();
        let ids: Vec<_> = (0..17).map(|_| uuid::Uuid::new_v4()).collect();
        let approve = || Mutation::Approve {
            token_hash: hash(b"synthetic"),
            incarnation: uuid::Uuid::new_v4(),
        };
        for id in &ids[..16] {
            store
                .mutate_surface("U:owner", *id, approve())
                .await
                .unwrap();
        }
        assert_eq!(
            store.mutate_surface("U:owner", ids[16], approve()).await,
            Err(RegistryError::SurfaceLimit)
        );
        store
            .mutate_surface("U:owner", ids[0], Mutation::Revoke)
            .await
            .unwrap();
        store
            .mutate_surface("U:owner", ids[16], approve())
            .await
            .unwrap();
        assert_eq!(store.surfaces("U:owner").await.unwrap().len(), 16);
        assert!(store.surfaces("U:other").await.unwrap().is_empty());
        let guard = store.surfaces.lock().unwrap();
        let registry = &guard["U:owner"];
        assert_eq!(registry.events.len(), 18);
        for pair in registry.events.windows(2) {
            assert_eq!(pair[1].previous_hash(), pair[0].hash().unwrap());
            assert_eq!(pair[1].sequence(), pair[0].sequence() + 1);
        }
    }

    /// A PARAPHRASED QUESTION MUST STILL FIND THE LITERAL NOTE.
    ///
    /// Reproduces a live failure: "What do I like?" made the model search
    /// `what the wearer likes, preferences, favorites, interests` (a comma-listed
    /// expansion), and the wearer had saved `I like trains`. The old windowed
    /// path did `text.contains(<the whole phrase>)`, which a note can never
    /// satisfy, and told the wearer they had saved nothing about a note they had
    /// just saved. Stemmed term-overlap (`likes`→`lik`, prefix-matches `like`)
    /// finds it. Locks the two together across both recall paths.
    #[test]
    fn a_paraphrased_question_still_finds_the_literal_note() {
        assert!(
            recall_hits(
                "what the wearer likes, preferences, favorites, interests",
                "i like trains",
            ) > 0,
            "a verbose 'what do I like' must match the saved 'I like trains'"
        );
        // And the clean case that already worked stays working.
        assert!(recall_hits("favorite color", "my favorite color is teal") >= 2);
        // A genuinely unrelated query must NOT match — the overlap has to be real.
        assert_eq!(recall_hits("weather forecast tomorrow", "i like trains"), 0);
    }

    /// REGRESSION: state lived only in memory, so a container restart looked to
    /// a device like a never-synced account — the wearer's notes, contacts, and
    /// history simply vanished. A snapshot must survive a fresh process.
    #[tokio::test]
    async fn state_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("cosmos-state-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp state dir");
        let path = dir.join("state.json");

        // First "process": the wearer saves a note and a contact.
        let uuid = {
            let store = MemoryStore::at_path(path.clone());
            let note = store.create_note("wearer", None, None).await.unwrap();
            store
                .index_note("wearer", &note.uuid, "remember the milk")
                .await;
            store
                .put_contacts(
                    "wearer",
                    &pb::ContactList {
                        contacts: vec![pb::Contact {
                            name: Some(pb::Name {
                                first_name: "Ada".into(),
                                ..Default::default()
                            }),
                            ..Default::default()
                        }],
                        ..Default::default()
                    },
                )
                .await
                .expect("write succeeds");
            note.uuid
        };

        // Second "process": a brand-new store over the same state file.
        let restarted = MemoryStore::at_path(path);
        let notes = restarted
            .recent_notes("wearer", 0, None, None)
            .await
            .unwrap();
        assert_eq!(notes.len(), 1, "the note must survive the restart");
        assert_eq!(notes[0].uuid, uuid);
        // The search index survives too, so recall still works after a restart.
        assert_eq!(
            restarted.search_notes("wearer", "milk", 0).await.unwrap(),
            vec![uuid.clone()]
        );
        assert_eq!(
            restarted.contacts("wearer").await.unwrap().contacts.len(),
            1,
            "contacts must survive too"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// REGRESSION: captures were left out of the snapshot entirely, so the two
    /// writes the device is explicitly told succeeded — `UploadComplete` and
    /// `DeleteMemory` — did not survive a restart, and neither did
    /// `CreateMemory`'s idempotency key.
    #[tokio::test]
    async fn capture_state_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("cosmos-capture-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp state dir");
        let path = dir.join("state.json");

        let new = |device_local_id: &str| NewMemory {
            kind: MemoryKind::Photo,
            device_local_id: device_local_id.to_owned(),
            bursts: 1,
            files_per_burst: 2,
            device_created_time: None,
            gmt_offset: 0,
            thumbnails: Vec::new(),
            encrypted_location: None,
        };

        let (uploaded, deleted) = {
            let store = MemoryStore::at_path(path.clone());
            let uploaded = store
                .create_memory("wearer", new("device-1"))
                .await
                .expect("write succeeds");
            let deleted = store
                .create_memory("wearer", new("device-2"))
                .await
                .expect("write succeeds");
            assert!(
                store
                    .record_upload_complete("wearer", &uploaded.uuid)
                    .await
                    .expect("write succeeds")
            );
            assert!(
                store
                    .delete_memory("wearer", &deleted.uuid)
                    .await
                    .expect("write succeeds")
            );
            (uploaded, deleted)
        };

        let restarted = MemoryStore::at_path(path);
        let back = restarted
            .memory("wearer", &uploaded.uuid)
            .await
            .expect("store read")
            .expect("the capture must survive the restart");
        assert!(
            back.upload_complete,
            "a completion the device was told we recorded must survive"
        );
        assert_eq!(back.bursts.len(), 1);
        assert_eq!(back.bursts[0].files.len(), 2, "upload slots survive too");
        assert!(
            restarted
                .memory("wearer", &deleted.uuid)
                .await
                .unwrap()
                .is_none(),
            "a capture the wearer deleted must stay deleted"
        );
        // The idempotency key survives, so a retry after a restart does not mint
        // a second uuid and orphan the first attempt's upload slots.
        let retried = restarted
            .create_memory("wearer", new("device-1"))
            .await
            .expect("write succeeds");
        assert_eq!(retried.uuid, uploaded.uuid);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// REGRESSION: the account payloads were never stored at all — the handlers
    /// echoed the wearer's blob back and dropped it. The snapshot has to contain
    /// them too, or a restart loses the wearer's allergies just as thoroughly as
    /// discarding them did.
    #[tokio::test]
    async fn account_payloads_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("cosmos-account-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp state dir");
        let path = dir.join("state.json");

        {
            let store = MemoryStore::at_path(path.clone());
            store
                .put_account_blob(
                    "wearer",
                    AccountBlobKind::FoodRestrictions,
                    b"sealed peanut allergy",
                )
                .await
                .expect("write succeeds");
        }

        let restarted = MemoryStore::at_path(path);
        assert_eq!(
            restarted
                .get_account_blob("wearer", AccountBlobKind::FoodRestrictions)
                .await
                .expect("store read")
                .as_deref(),
            Some(b"sealed peanut allergy".as_slice()),
            "the wearer's food restrictions must survive a restart"
        );
        // Kinds are separate namespaces, and another principal's rows are not
        // reachable.
        assert!(
            restarted
                .get_account_blob("wearer", AccountBlobKind::WifiConfigs)
                .await
                .expect("store read")
                .is_none()
        );
        assert!(
            restarted
                .get_account_blob("someone-else", AccountBlobKind::FoodRestrictions)
                .await
                .expect("store read")
                .is_none()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// REGRESSION: every handler calls `persist()` *after* dropping its data
    /// lock, and `persist` used to build, encode, and write with no
    /// serialisation of its own, through ONE shared `state.json.tmp`.
    ///
    /// Two consequences, both of which lose the wearer's data:
    ///
    /// * **Regression.** Writer A builds a snapshot, writer B builds a later one
    ///   and renames it, then A renames its stale copy over the top. Both writes
    ///   were acknowledged; one is now absent from the only durable copy, and no
    ///   later write will reintroduce it.
    /// * **Corruption.** Sharing one temp path lets B truncate and rewrite the
    ///   file A is midway through publishing, so the rename can publish a
    ///   half-and-half blob that parses as nothing. `restore` then refused to
    ///   start — before that, it discarded every wearer's data behind one WARN.
    ///
    /// The invariant is checked CONTINUOUSLY by a watcher reading the published
    /// file while the writers run, not just once at the end: at the end the
    /// writers are all finishing together, so the last snapshot published is
    /// usually complete by luck and the end-state assertion alone was only
    /// intermittently red. Every publish is an observation instead — the file
    /// must always parse, and its contact count must never go backwards.
    /// Concurrency is what makes this falsifiable (a serialised writer cannot
    /// produce either failure), so the writers are released together and each
    /// `persist` is made expensive enough — a 128 KiB opaque payload re-encoded
    /// every time — that the window is real rather than theoretical.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_writers_never_publish_a_partial_snapshot() {
        use std::sync::atomic::{AtomicBool, Ordering};

        const WRITERS: usize = 8;
        const ROUNDS: usize = 32;

        let dir = std::env::temp_dir().join(format!("cosmos-snapshot-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp state dir");
        let path = dir.join("state.json");

        // Reads whatever is currently published. `rename` is atomic, so a reader
        // always sees some complete previously-published file — which makes an
        // unparseable read, or one holding FEWER contacts than an earlier read,
        // proof that a bad snapshot was published rather than a torn read.
        let stop = Arc::new(AtomicBool::new(false));
        let watcher = std::thread::spawn({
            let path = path.clone();
            let stop = stop.clone();
            move || -> Result<usize, String> {
                let mut high_water = 0usize;
                while !stop.load(Ordering::Relaxed) {
                    let Ok(bytes) = std::fs::read(&path) else {
                        continue; // not published yet
                    };
                    let snapshot = serde_json::from_slice::<Snapshot>(&bytes).map_err(|error| {
                        format!(
                            "a published snapshot did not parse ({error}); a restarting \
                             workload would refuse to start on it, and before that it \
                             discarded every wearer's data"
                        )
                    })?;
                    let count: usize = snapshot
                        .books
                        .iter()
                        .map(|(_, book)| book.contacts.len())
                        .sum();
                    if count < high_water {
                        return Err(format!(
                            "the published snapshot went BACKWARDS, from {high_water} \
                             contacts to {count}: a writer republished a snapshot built \
                             before another writer's acknowledged write, erasing it"
                        ));
                    }
                    high_water = count;
                }
                Ok(high_water)
            }
        });

        {
            // One store, many concurrent writers — the deployed shape.
            let store: SharedStore = Arc::new(MemoryStore::at_path(path.clone()));
            store
                .put_account_blob(
                    "wearer",
                    AccountBlobKind::FoodRestrictions,
                    &vec![0xABu8; 128 * 1024],
                )
                .await
                .expect("account write succeeds");

            // `.collect()` before awaiting, deliberately: a lazy `map` of
            // `tokio::spawn` consumed by `for handle in handles { handle.await }`
            // spawns the next writer only after the previous one has FINISHED,
            // which serialises the very concurrency this test exists to create.
            let gate = Arc::new(tokio::sync::Barrier::new(WRITERS));
            let writers: Vec<_> = (0..WRITERS)
                .map(|writer| {
                    let store = store.clone();
                    let gate = gate.clone();
                    tokio::spawn(async move {
                        // Released together, so the writers are inside `persist`
                        // at the same moment rather than merely interleaved.
                        gate.wait().await;
                        for round in 0..ROUNDS {
                            store
                                .put_contacts(
                                    "wearer",
                                    &list(vec![named(&format!("Writer {writer}/{round}"))]),
                                )
                                .await
                                .expect("contact write succeeds");
                        }
                    })
                })
                .collect();
            for writer in writers {
                writer.await.expect("writer task");
            }
        }

        stop.store(true, Ordering::Relaxed);
        // The watcher checks the INVARIANT (every publish parses, none loses a
        // write); it deliberately does not assert the final count, because it
        // stops on a flag and can miss the last publish under load. Completeness
        // is the fresh-store read below, which is authoritative.
        if let Err(violation) = watcher.join().expect("watcher thread") {
            panic!("{violation}");
        }

        // A fresh store over the published file. This PANICS on an unparseable
        // snapshot, so a corrupt publish fails the test loudly instead of
        // quietly reading back as a never-synced account.
        let restarted = MemoryStore::at_path(path.clone());
        assert_eq!(
            restarted.contacts("wearer").await.unwrap().contacts.len(),
            WRITERS * ROUNDS,
            "every acknowledged write must be in the published snapshot; a writer \
             that published a snapshot built before another's write erases it"
        );
        assert_eq!(
            restarted
                .get_account_blob("wearer", AccountBlobKind::FoodRestrictions)
                .await
                .expect("store read")
                .map(|payload| payload.len()),
            Some(128 * 1024)
        );
        // No temp file is left beside the snapshot.
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .expect("state dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .filter(|name| name.to_string_lossy().contains(".tmp"))
            .collect();
        assert!(strays.is_empty(), "temp snapshots left behind: {strays:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A snapshot that will not parse must STOP the workload.
    ///
    /// Starting empty discarded every wearer's contacts, captures, notes, and
    /// account payloads behind one WARN line — and the next write republished
    /// the empty state over the file, destroying the only copy. The device reads
    /// that as a never-synced account and clears its own sync flags against it,
    /// so the loss becomes mutual and unrecoverable.
    #[tokio::test]
    async fn an_unparseable_snapshot_stops_the_workload_rather_than_discarding_data() {
        let dir = std::env::temp_dir().join(format!("cosmos-corrupt-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp state dir");
        let path = dir.join("state.json");
        std::fs::write(&path, b"{ not json").expect("write a corrupt snapshot");

        let attempt = std::panic::catch_unwind({
            let path = path.clone();
            || MemoryStore::at_path(path)
        });
        assert!(
            attempt.is_err(),
            "an unreadable snapshot must not be silently replaced with an empty account"
        );
        assert_eq!(
            std::fs::read(&path).expect("still there"),
            b"{ not json",
            "the operator's only copy must be left intact"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A store with no path stays memory-only — the right default for tests and
    /// local runs, and it must never touch the filesystem.
    #[tokio::test]
    async fn without_a_state_path_nothing_is_written() {
        let store = MemoryStore::default();
        assert!(store.state_path.is_none());
        store.create_note("wearer", None, None).await.unwrap();
        // persist() is a no-op; the note is still readable in memory.
        assert_eq!(
            store
                .recent_notes("wearer", 0, None, None)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    use super::*;

    fn named(display_name: &str) -> pb::Contact {
        pb::Contact {
            name: Some(pb::Name {
                display_name: display_name.to_owned(),
                ..pb::Name::default()
            }),
            ..pb::Contact::default()
        }
    }

    fn list(contacts: Vec<pb::Contact>) -> pb::ContactList {
        pb::ContactList {
            contacts,
            ..pb::ContactList::default()
        }
    }

    #[tokio::test]
    async fn empty_store_reads_back_well_formed_empty_not_an_error() {
        let store = MemoryStore::default();
        let snapshot = store.contacts("device-never-synced").await.unwrap();

        assert!(snapshot.is_empty());
        assert!(snapshot.contacts.is_empty());
        assert!(snapshot.encrypted.is_empty());
        assert!(snapshot.deletions.is_empty());
        assert!(
            snapshot.latest.is_none(),
            "a principal that never wrote has no sync point to hand back"
        );
        assert_eq!(snapshot.contacts_since(None).count(), 0);
        assert_eq!(snapshot.matching("anything").count(), 0);
    }

    #[tokio::test]
    async fn write_then_read_round_trips_under_the_same_principal() {
        let store = MemoryStore::default();
        store
            .put_contacts("device-a", &list(vec![named("Ada Lovelace")]))
            .await
            .expect("write succeeds");

        let snapshot = store.contacts("device-a").await.unwrap();
        assert_eq!(snapshot.contacts.len(), 1);
        assert_eq!(
            snapshot.contacts[0]
                .contact
                .name
                .as_ref()
                .expect("name survives the round trip")
                .display_name,
            "Ada Lovelace"
        );
        assert!(
            snapshot.latest.is_some(),
            "a write establishes a sync point"
        );
    }

    #[tokio::test]
    async fn one_principal_never_reads_anothers_contacts() {
        let store = MemoryStore::default();
        store
            .put_contacts("device-a", &list(vec![named("Ada Lovelace")]))
            .await
            .expect("write succeeds");
        store
            .put_contacts("device-b", &list(vec![named("Grace Hopper")]))
            .await
            .expect("write succeeds");

        let a = store.contacts("device-a").await.unwrap();
        let b = store.contacts("device-b").await.unwrap();
        assert_eq!(a.contacts.len(), 1);
        assert_eq!(b.contacts.len(), 1);
        assert!(a.matching("grace").next().is_none());
        assert!(b.matching("ada").next().is_none());

        // A third principal that wrote nothing sees nothing, not the union.
        assert!(store.contacts("device-c").await.unwrap().is_empty());

        // Deletes are scoped too: B cannot remove A's row by guessing its id.
        let a_id = a.contacts[0].contact.id.clone();
        store
            .delete_contacts("device-b", std::slice::from_ref(&a_id))
            .await
            .expect("delete succeeds");
        assert!(
            store
                .contacts("device-a")
                .await
                .unwrap()
                .find(&a_id)
                .is_some(),
            "a delete under one principal must not reach another's book"
        );
    }

    #[tokio::test]
    async fn new_contacts_get_server_assigned_uuids_and_version_one() {
        let store = MemoryStore::default();
        let written = store
            .put_contacts(
                "device-a",
                &list(vec![named("Ada Lovelace"), named("Grace Hopper")]),
            )
            .await
            .expect("write succeeds");

        assert_eq!(written.len(), 2);
        let mut ids = Vec::new();
        for record in &written {
            assert!(
                Uuid::parse_str(&record.contact.id).is_ok(),
                "server-assigned ids are UUIDs"
            );
            assert_eq!(record.contact.version, 1);
            assert_eq!(
                record.contact.modified_at,
                Some(record.modified.to_proto()),
                "the wire timestamp mirrors the stored cursor"
            );
            ids.push(record.contact.id.clone());
        }
        assert_ne!(ids[0], ids[1], "each contact gets its own id");
    }

    #[tokio::test]
    async fn rewriting_an_id_upserts_in_place_and_bumps_the_server_version() {
        let store = MemoryStore::default();
        let created = store
            .put_contacts("device-a", &list(vec![named("Ada")]))
            .await
            .expect("write succeeds");
        let id = created[0].contact.id.clone();

        let updated = store
            .put_contacts(
                "device-a",
                &list(vec![pb::Contact {
                    id: id.clone(),
                    // A client-asserted version is advisory and must not be trusted.
                    version: 97,
                    ..named("Ada Lovelace")
                }]),
            )
            .await
            .expect("write succeeds");

        assert_eq!(updated[0].contact.id, id, "the id is stable across updates");
        assert_eq!(updated[0].contact.version, 2, "the server owns `version`");
        let snapshot = store.contacts("device-a").await.unwrap();
        assert_eq!(
            snapshot.contacts.len(),
            1,
            "an upsert replaces, not appends"
        );
        assert_eq!(
            snapshot.contacts[0]
                .contact
                .name
                .as_ref()
                .expect("name")
                .display_name,
            "Ada Lovelace"
        );
    }

    #[tokio::test]
    async fn delta_reads_return_only_what_changed_after_the_clients_cursor() {
        let store = MemoryStore::default();
        store
            .put_contacts("device-a", &list(vec![named("Ada")]))
            .await
            .expect("write succeeds");
        let cursor = store
            .contacts("device-a")
            .await
            .unwrap()
            .latest
            .expect("first write established a cursor");

        // Nothing has changed since the cursor the client was just handed.
        let snapshot = store.contacts("device-a").await.unwrap();
        assert_eq!(snapshot.contacts_since(Some(cursor)).count(), 0);
        assert_eq!(snapshot.contacts_since(None).count(), 1, "full read is all");

        store
            .put_contacts("device-a", &list(vec![named("Grace")]))
            .await
            .expect("write succeeds");
        let snapshot = store.contacts("device-a").await.unwrap();
        let changed: Vec<_> = snapshot.contacts_since(Some(cursor)).collect();
        assert_eq!(changed.len(), 1, "only the second write is new");
        assert_eq!(
            changed[0].contact.name.as_ref().expect("name").display_name,
            "Grace"
        );
        assert!(
            snapshot.latest.expect("cursor advances") > cursor,
            "write stamps are strictly monotonic even within a clock tick"
        );
    }

    #[tokio::test]
    async fn deletes_tombstone_for_delta_sync_and_drop_out_of_full_reads() {
        let store = MemoryStore::default();
        let created = store
            .put_contacts("device-a", &list(vec![named("Ada")]))
            .await
            .expect("write succeeds");
        let id = created[0].contact.id.clone();
        let cursor = store
            .contacts("device-a")
            .await
            .unwrap()
            .latest
            .expect("cursor");

        store
            .delete_contacts("device-a", std::slice::from_ref(&id))
            .await
            .expect("delete succeeds");
        let snapshot = store.contacts("device-a").await.unwrap();

        assert!(
            snapshot.contacts.is_empty(),
            "a full read omits the deleted"
        );
        let tombstones: Vec<_> = snapshot.deletions_since(cursor).collect();
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0].id, id);
        assert!(snapshot.latest.expect("cursor") > cursor);

        // Deleting an unknown id is a vacuous success with no fabricated state.
        store
            .delete_contacts("device-a", &["never-stored".to_owned()])
            .await
            .expect("delete succeeds");
        assert_eq!(store.contacts("device-a").await.unwrap().deletions.len(), 1);
    }

    #[tokio::test]
    async fn recreating_a_deleted_id_retires_its_tombstone() {
        let store = MemoryStore::default();
        let created = store
            .put_contacts("device-a", &list(vec![named("Ada")]))
            .await
            .expect("write succeeds");
        let id = created[0].contact.id.clone();
        store
            .delete_contacts("device-a", std::slice::from_ref(&id))
            .await
            .expect("delete succeeds");

        store
            .put_contacts(
                "device-a",
                &list(vec![pb::Contact {
                    id: id.clone(),
                    ..named("Ada")
                }]),
            )
            .await
            .expect("write succeeds");

        let snapshot = store.contacts("device-a").await.unwrap();
        assert!(snapshot.find(&id).is_some(), "the contact is live again");
        assert!(
            snapshot.deletions.is_empty(),
            "a live contact must not also be tombstoned"
        );
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

    /// A DELETE THAT DID NOT DELETE MUST SAY SO — and one that did must stick.
    ///
    /// The `.Center` My Data rows and the notes list both rendered a trash
    /// control with nothing behind it. These are the two answers that control is
    /// allowed to produce: the row is gone, or it was never this wearer's.
    #[tokio::test]
    async fn deleting_a_note_or_event_removes_it_and_a_second_delete_reports_nothing() {
        let store = MemoryStore::default();
        store
            .ingest_events("device-a", &[event("ev-1"), event("ev-2")])
            .await
            .expect("write succeeds");
        let note = store.create_note("device-a", None, None).await.unwrap();

        assert!(
            store
                .delete_event("device-a", "ev-1")
                .await
                .expect("delete succeeds")
        );
        let left = store
            .query_events("device-a", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(left.len(), 1, "only the deleted event went");
        assert_eq!(left[0].event_identifier, "ev-2");

        assert!(
            store
                .delete_note("device-a", &note.uuid)
                .await
                .expect("delete succeeds")
        );
        assert!(
            store
                .recent_notes("device-a", 0, None, None)
                .await
                .unwrap()
                .is_empty(),
            "a deleted note must drop out of the wearer's own read"
        );

        // Deleting what is already gone is `false` — not an error, and above all
        // not a second fabricated success.
        assert_eq!(store.delete_event("device-a", "ev-1").await, Ok(false));
        assert_eq!(store.delete_note("device-a", &note.uuid).await, Ok(false));
        // Neither is a delete against a principal that has stored nothing at all.
        assert_eq!(store.delete_event("device-never", "ev-2").await, Ok(false));
        assert_eq!(
            store.delete_note("device-never", &note.uuid).await,
            Ok(false)
        );
    }

    /// ANOTHER WEARER'S ROW IS INVISIBLE, NOT MERELY REFUSED.
    ///
    /// The identifiers here are the *real* ones — B is deleting exactly the keys
    /// A holds — so the only thing standing between the two accounts is the
    /// principal predicate. It answers `false` (nothing of yours matched) while
    /// A's rows stay put; an error instead would confirm the row exists, which
    /// is itself a disclosure.
    #[tokio::test]
    async fn a_delete_under_one_principal_cannot_reach_anothers_note_or_event() {
        let store = MemoryStore::default();
        store
            .ingest_events("device-a", &[event("ev-1")])
            .await
            .expect("write succeeds");
        let note = store.create_note("device-a", None, None).await.unwrap();

        assert_eq!(store.delete_event("device-b", "ev-1").await, Ok(false));
        assert_eq!(store.delete_note("device-b", &note.uuid).await, Ok(false));

        assert_eq!(
            store
                .query_events("device-a", "", "", None, None, 0)
                .await
                .unwrap()
                .len(),
            1,
            "a delete under one principal must not reach another's events"
        );
        assert_eq!(
            store
                .recent_notes("device-a", 0, None, None)
                .await
                .unwrap()
                .len(),
            1,
            "a delete under one principal must not reach another's notes"
        );
    }

    /// A DELETION MUST SURVIVE THE RESTART TOO.
    ///
    /// The in-memory backend's analogue of the tombstone rule: the snapshot is
    /// this store's whole memory, so a delete that never reaches it comes back
    /// on the next process — an erasure the wearer was told happened and was
    /// then silently undone. Only writing the snapshot after the removal makes
    /// this go green.
    #[tokio::test]
    async fn a_deleted_note_and_event_stay_deleted_across_a_restart() {
        let dir = std::env::temp_dir().join(format!("cosmos-delete-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp state dir");
        let path = dir.join("state.json");

        let uuid = {
            let store = MemoryStore::at_path(path.clone());
            store
                .ingest_events("wearer", &[event("ev-1"), event("ev-2")])
                .await
                .expect("write succeeds");
            let note = store.create_note("wearer", None, None).await.unwrap();
            assert!(store.delete_event("wearer", "ev-1").await.unwrap());
            assert!(store.delete_note("wearer", &note.uuid).await.unwrap());
            note.uuid
        };

        let restarted = MemoryStore::at_path(path);
        let events = restarted
            .query_events("wearer", "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(events.len(), 1, "the deleted event must not come back");
        assert_eq!(events[0].event_identifier, "ev-2");
        assert!(
            restarted
                .recent_notes("wearer", 0, None, None)
                .await
                .unwrap()
                .iter()
                .all(|n| n.uuid != uuid),
            "the deleted note must not come back"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn encrypted_contacts_persist_opaquely_and_dedupe_on_retry() {
        let store = MemoryStore::default();
        let blob = EncryptedData {
            encryption_information: None,
            data: b"opaque ciphertext".to_vec(),
        };
        let written = pb::ContactList {
            contacts: Vec::new(),
            encrypted_contacts: vec![blob.clone()],
            encrypted_contacts_versions: vec![4],
        };

        store
            .put_contacts("device-a", &written)
            .await
            .expect("write succeeds");
        store
            .put_contacts("device-a", &written)
            .await
            .expect("write succeeds");

        let snapshot = store.contacts("device-a").await.unwrap();
        assert_eq!(
            snapshot.encrypted.len(),
            1,
            "an identical retried ciphertext is the same encrypted contact"
        );
        assert_eq!(snapshot.encrypted[0].data, blob);
        assert_eq!(snapshot.encrypted[0].version, 4);
        assert!(
            store
                .contacts("device-b")
                .await
                .unwrap()
                .encrypted
                .is_empty()
        );
    }

    #[tokio::test]
    async fn search_matches_identifying_fields_case_insensitively() {
        let store = MemoryStore::default();
        store
            .put_contacts(
                "device-a",
                &list(vec![
                    pb::Contact {
                        emails: vec![pb::Email {
                            value: "ada@analytical.example".to_owned(),
                            r#type: "work".to_owned(),
                        }],
                        organization: Some(pb::Organization {
                            name: "Analytical Engines".to_owned(),
                        }),
                        ..named("Ada Lovelace")
                    },
                    named("Grace Hopper"),
                ]),
            )
            .await
            .expect("write succeeds");
        let snapshot = store.contacts("device-a").await.unwrap();

        assert_eq!(snapshot.matching("lovelace").count(), 1);
        assert_eq!(snapshot.matching("ANALYTICAL").count(), 1);
        assert_eq!(snapshot.matching("ada@").count(), 1);
        assert_eq!(
            snapshot.matching("").count(),
            2,
            "a blank term is no filter"
        );
        assert_eq!(snapshot.matching("   ").count(), 2);
        assert_eq!(snapshot.matching("babbage").count(), 0);
    }

    /// A sync cursor must be strictly monotonic per principal *under
    /// concurrency*, not just when writes are serialised by the test.
    ///
    /// This is the invariant behind the delta-sync contract: the device is
    /// handed a cursor, replays it, and receives everything stamped strictly
    /// after it. Two writes sharing a cursor — or a later write landing at or
    /// below one the device already holds — makes one of them permanently
    /// invisible, and the wearer loses a contact edit with nothing to indicate
    /// it. The Postgres backend proves the same property against a real database
    /// in `store_postgres::tests::concurrent_writers_never_share_a_cursor`.
    #[tokio::test]
    async fn concurrent_writers_never_share_a_cursor() {
        let store = MemoryStore::shared();
        let writers = (0..32).map(|n| {
            let store = store.clone();
            tokio::spawn(async move {
                store
                    .put_contacts("device-a", &list(vec![named(&format!("Writer {n}"))]))
                    .await
                    .expect("write succeeds")
            })
        });

        let mut cursors = Vec::new();
        for writer in writers {
            for record in writer.await.expect("writer task") {
                cursors.push(record.modified);
            }
        }
        cursors.sort_unstable();
        let distinct = {
            let mut seen = cursors.clone();
            seen.dedup();
            seen.len()
        };
        assert_eq!(
            distinct,
            cursors.len(),
            "two writes sharing a cursor makes one of them invisible to a delta sync"
        );

        // Nothing is stranded above the sync point the device would be handed,
        // and replaying any cursor reaches everything written after it.
        let snapshot = store.contacts("device-a").await.unwrap();
        let latest = snapshot.latest.expect("writes established a sync point");
        assert_eq!(cursors.last().copied(), Some(latest));
        assert_eq!(snapshot.contacts.len(), 32);
        for (index, cursor) in cursors.iter().enumerate() {
            assert_eq!(
                snapshot.contacts_since(Some(*cursor)).count(),
                cursors.len() - index - 1,
                "a replayed cursor must reach every later write and no earlier one"
            );
        }
    }

    /// The nanos-since-epoch form the Postgres cursor allocator compares and
    /// increments in SQL has to mean the same instant coming back.
    #[test]
    fn cursors_round_trip_through_their_epoch_nanos_form() {
        for cursor in [
            SyncTime::default(),
            SyncTime::from_parts(0, 1),
            SyncTime::from_parts(1_700_000_000, 999_999_999),
            SyncTime::now(),
        ] {
            assert_eq!(SyncTime::from_epoch_nanos(cursor.to_epoch_nanos()), cursor);
        }
        // Ordering survives the flattening, which is what makes GREATEST() in
        // the allocator equivalent to comparing the pair.
        let earlier = SyncTime::from_parts(10, 999_999_999);
        let later = SyncTime::from_parts(11, 0);
        assert!(earlier.to_epoch_nanos() < later.to_epoch_nanos());
        assert_eq!(
            SyncTime::from_epoch_nanos(earlier.to_epoch_nanos() + 1),
            later,
            "+1 nanosecond is the successor instant"
        );
    }

    #[test]
    fn client_cursors_with_out_of_range_nanos_normalise() {
        let folded = SyncTime::from_proto(&Timestamp {
            seconds: 10,
            nanos: NANOS_PER_SECOND + 5,
        });
        assert_eq!(
            folded,
            SyncTime::from_proto(&Timestamp {
                seconds: 11,
                nanos: 5,
            })
        );
        assert!(
            folded
                > SyncTime::from_proto(&Timestamp {
                    seconds: 10,
                    nanos: 999_999_999,
                })
        );
    }
}

// --- durability -------------------------------------------------------------
//
// The three stateful workloads (contacts, notable-events, ai-bus) are separate
// processes, each with its own store — there is no shared database today, so
// each one snapshots its own state to its own file. That preserves exactly the
// current semantics while fixing the defect that mattered: on a restart the
// wearer's notes, contacts, captures, and history simply vanished, which to a
// device looks like a never-synced account.
//
// A shared PostgreSQL backend remains the target for a real deployment; it needs the `Store` trait
// async-ified, which this seam already anticipates.
//
// Encoding: protobuf-typed fields are stored as their encoded bytes (prost is
// already a dependency and the wire encoding is the one thing guaranteed stable
// here); cursors and versions ride alongside as plain values.

/// Directory the workload snapshots its state into. Unset means memory-only,
/// which is the right default for tests and local runs.
const STATE_DIR_ENV: &str = "COSMOS_STATE_DIR";

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Snapshot {
    #[serde(default)]
    books: Vec<(String, BookSnapshot)>,
    #[serde(default)]
    captures: Vec<(String, CaptureSnapshot)>,
    /// `default` so a snapshot written before the account payloads were
    /// persisted still loads.
    #[serde(default)]
    account: Vec<AccountSnapshot>,
}

/// One principal's `humane.account` payloads: `(principal, [(kind, bytes)])`.
/// The bytes are opaque — sealed by the device for a key we do not hold.
type AccountSnapshot = (String, Vec<(String, Vec<u8>)>);

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct BookSnapshot {
    contacts: Vec<(Vec<u8>, i64, i32)>,
    encrypted: Vec<(Vec<u8>, i32, i64, i32)>,
    tombstones: Vec<(String, i64, i32)>,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct CaptureSnapshot {
    /// Captures. `default` so a snapshot written before captures were persisted
    /// still loads — the alternative is refusing the whole file and reading back
    /// as a never-synced account, which is the failure this section exists to
    /// prevent.
    #[serde(default)]
    memories: Vec<MemorySnapshot>,
    notes: Vec<NoteSnapshot>,
    events: Vec<EventSnapshot>,
    next_id: i64,
}

/// A capture, flattened for the snapshot file.
///
/// Captures used to be left out of the snapshot entirely, so `UploadComplete`
/// and `DeleteMemory` — both of which the device is told succeeded — did not
/// survive a restart, and `CreateMemory`'s idempotency key went with them: a
/// retry after a restart minted a second uuid and orphaned the first attempt's
/// upload slots.
#[derive(serde::Serialize, serde::Deserialize)]
struct MemorySnapshot {
    uuid: String,
    numeric_id: i64,
    device_local_id: String,
    kind: u8,
    device_created: Option<(i64, i32)>,
    gmt_offset: i32,
    thumbnails: Vec<Vec<u8>>,
    encrypted_location: Option<Vec<u8>>,
    bursts: Vec<BurstRecord>,
    upload_complete: bool,
    deleted: Option<(i64, i32)>,
    created: (i64, i32),
}

/// Snapshot encoding for [`MemoryKind`]. Numeric rather than the variant name so
/// the file is stable if a variant is ever renamed.
const fn kind_to_u8(kind: MemoryKind) -> u8 {
    match kind {
        MemoryKind::Photo => 0,
        MemoryKind::Video => 1,
        MemoryKind::FoodLog => 2,
        MemoryKind::Note => 3,
    }
}

const fn kind_from_u8(value: u8) -> MemoryKind {
    match value {
        1 => MemoryKind::Video,
        2 => MemoryKind::FoodLog,
        3 => MemoryKind::Note,
        _ => MemoryKind::Photo,
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct NoteSnapshot {
    uuid: String,
    indexed_text: Option<String>,
    note: Option<Vec<u8>>,
    location: Option<Vec<u8>>,
    created: (i64, i32),
}

#[derive(serde::Serialize, serde::Deserialize)]
struct EventSnapshot {
    identifier: String,
    originator: String,
    creation: Option<(i64, i32)>,
    event_type: String,
    event_data: Option<Vec<u8>>,
    encrypted_event_data: Option<Vec<u8>>,
    encrypted_location: Option<Vec<u8>>,
    device_is_locked: bool,
    ingested: (i64, i32),
}

fn encode_msg<M: prost::Message>(m: &M) -> Vec<u8> {
    m.encode_to_vec()
}

fn decode_msg<M: prost::Message + Default>(bytes: &[u8]) -> Option<M> {
    M::decode(bytes).ok()
}

impl MemoryStore {
    /// Where this workload persists, from the environment.
    fn configured_state_path() -> Option<std::path::PathBuf> {
        let dir = std::env::var(STATE_DIR_ENV).ok()?;
        if dir.trim().is_empty() {
            return None;
        }
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).ok()?;
        // One file per workload: these are separate processes and must not
        // interleave writes into a single file.
        let workload = std::env::var("COSMOS_WORKLOAD").unwrap_or_else(|_| "workload".to_owned());
        Some(dir.join(format!("{workload}-state.json")))
    }

    /// Write the current state. Best-effort: a snapshot failure must never fail
    /// the wearer's request, but it is not silent either.
    ///
    /// Serialised end to end by `self.snapshot`. Handlers drop their data lock
    /// before calling this, so concurrent writers used to reach the file at the
    /// same moment; with one shared temp name and a non-atomic `write` they
    /// interleaved and published a snapshot that parses as nothing — which
    /// [`MemoryStore::restore`] then refuses to start on. Holding the guard also
    /// makes the last writer in the file the last writer to have built a
    /// snapshot, so the published state can never go backwards.
    fn persist(&self) {
        let Some(path) = self.state_path.as_ref() else {
            return;
        };
        let _serialised = self.snapshot.lock().unwrap_or_else(|poison| {
            // A panicking writer left the guard poisoned. The guard protects a
            // file, not an invariant in memory, so the right move is to keep
            // snapshotting rather than to stop persisting the wearer's data.
            poison.into_inner()
        });
        let snapshot = {
            let books = self.books.lock().expect("contact store poisoned");
            let captures = self.captures.lock().expect("capture store poisoned");
            Snapshot {
                books: books
                    .iter()
                    .map(|(principal, book)| {
                        (
                            principal.clone(),
                            BookSnapshot {
                                contacts: book
                                    .contacts
                                    .iter()
                                    .map(|c| {
                                        (
                                            encode_msg(&c.contact),
                                            c.modified.seconds(),
                                            c.modified.nanos(),
                                        )
                                    })
                                    .collect(),
                                encrypted: book
                                    .encrypted
                                    .iter()
                                    .map(|e| {
                                        (
                                            encode_msg(&e.data),
                                            e.version,
                                            e.modified.seconds(),
                                            e.modified.nanos(),
                                        )
                                    })
                                    .collect(),
                                tombstones: book
                                    .tombstones
                                    .iter()
                                    .map(|(id, t)| (id.clone(), t.seconds(), t.nanos()))
                                    .collect(),
                            },
                        )
                    })
                    .collect(),
                captures: captures
                    .iter()
                    .map(|(principal, book)| {
                        (
                            principal.clone(),
                            CaptureSnapshot {
                                memories: book
                                    .memories
                                    .iter()
                                    .map(|m| MemorySnapshot {
                                        uuid: m.uuid.clone(),
                                        numeric_id: m.numeric_id,
                                        device_local_id: m.device_local_id.clone(),
                                        kind: kind_to_u8(m.kind),
                                        device_created: m
                                            .device_created_time
                                            .map(|t| (t.seconds(), t.nanos())),
                                        gmt_offset: m.gmt_offset,
                                        thumbnails: m.thumbnails.iter().map(encode_msg).collect(),
                                        encrypted_location: m
                                            .encrypted_location
                                            .as_ref()
                                            .map(encode_msg),
                                        bursts: m.bursts.clone(),
                                        upload_complete: m.upload_complete,
                                        deleted: m.deleted.map(|t| (t.seconds(), t.nanos())),
                                        created: (m.created.seconds(), m.created.nanos()),
                                    })
                                    .collect(),
                                notes: book
                                    .notes
                                    .iter()
                                    .map(|n| NoteSnapshot {
                                        uuid: n.uuid.clone(),
                                        indexed_text: n.indexed_text.clone(),
                                        note: n.encrypted_note.as_ref().map(encode_msg),
                                        location: n.encrypted_location.as_ref().map(encode_msg),
                                        created: (n.created.seconds(), n.created.nanos()),
                                    })
                                    .collect(),
                                events: book
                                    .events
                                    .iter()
                                    .map(|e| EventSnapshot {
                                        identifier: e.event_identifier.clone(),
                                        originator: e.originator_identifier.clone(),
                                        creation: e.creation_time.map(|t| (t.seconds(), t.nanos())),
                                        event_type: e.event_type.clone(),
                                        event_data: e.event_data.as_ref().map(encode_msg),
                                        encrypted_event_data: e
                                            .encrypted_event_data
                                            .as_ref()
                                            .map(encode_msg),
                                        encrypted_location: e
                                            .encrypted_location
                                            .as_ref()
                                            .map(encode_msg),
                                        device_is_locked: e.device_is_locked,
                                        ingested: (e.ingested.seconds(), e.ingested.nanos()),
                                    })
                                    .collect(),
                                next_id: book.next_id,
                            },
                        )
                    })
                    .collect(),
                account: {
                    let account = self.account.lock().expect("account store poisoned");
                    account
                        .iter()
                        .map(|(principal, blobs)| {
                            (
                                principal.clone(),
                                blobs
                                    .iter()
                                    .map(|(kind, payload)| (kind.clone(), payload.clone()))
                                    .collect(),
                            )
                        })
                        .collect()
                },
            }
        };

        let Ok(encoded) = serde_json::to_vec(&snapshot) else {
            tracing::warn!("could not encode state snapshot");
            return;
        };
        // Write-and-rename so a crash mid-write cannot leave a truncated file
        // that would read back as an empty account. The temp name is unique per
        // writer as well: a shared one is a second way two writers can produce a
        // corrupt file, and the `snapshot` guard is process-local — it says
        // nothing about a second process pointed at the same state directory.
        let temporary = path.with_extension(format!(
            "json.tmp.{}.{}",
            std::process::id(),
            SNAPSHOT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        if write_durably(&temporary, &encoded).is_err()
            || std::fs::rename(&temporary, path).is_err()
        {
            tracing::warn!("could not persist state snapshot");
            // A unique temp name never gets reused, so a failed write would
            // otherwise leak one file per attempt next to the snapshot.
            let _ = std::fs::remove_file(&temporary);
        }
    }

    /// Load a previous snapshot, if one exists.
    ///
    /// A snapshot that will not parse **stops the workload**. Starting empty was
    /// a one-line WARN that discarded every wearer's contacts, captures, notes,
    /// history, and account payloads — and the next write republished the empty
    /// state over the file, so the only copy was gone. To a device that is
    /// indistinguishable from a never-synced account: it clears its own
    /// `needs_sync` flags against our empty answers and the loss becomes mutual.
    /// Refusing to start keeps the file for an operator, exactly as
    /// `store::configured()` refuses to fall back to memory.
    fn restore(&self) {
        let Some(path) = self.state_path.as_ref() else {
            return;
        };
        let Ok(bytes) = std::fs::read(path) else {
            return; // first run
        };
        let snapshot = match serde_json::from_slice::<Snapshot>(&bytes) {
            Ok(snapshot) => snapshot,
            // The path is named; the contents are wearer data and are not.
            Err(error) => panic!(
                "the state snapshot at {} is unreadable ({error}). Refusing to start \
                 empty, which would serve every wearer a never-synced account and then \
                 overwrite the only copy of their data on the next write.",
                path.display()
            ),
        };

        let mut books = self.books.lock().expect("contact store poisoned");
        for (principal, snap) in snapshot.books {
            let book = books.entry(principal).or_default();
            for (bytes, seconds, nanos) in snap.contacts {
                if let Some(contact) = decode_msg::<pb::Contact>(&bytes) {
                    book.contacts.push(ContactRecord {
                        contact,
                        modified: SyncTime::from_parts(seconds, nanos),
                    });
                }
            }
            for (bytes, version, seconds, nanos) in snap.encrypted {
                if let Some(data) = decode_msg::<EncryptedData>(&bytes) {
                    book.encrypted.push(EncryptedContactRecord {
                        data,
                        version,
                        modified: SyncTime::from_parts(seconds, nanos),
                    });
                }
            }
            for (id, seconds, nanos) in snap.tombstones {
                book.tombstones
                    .insert(id, SyncTime::from_parts(seconds, nanos));
            }
        }
        drop(books);

        let mut captures = self.captures.lock().expect("capture store poisoned");
        for (principal, snap) in snapshot.captures {
            let book = captures.entry(principal).or_default();
            book.next_id = snap.next_id;
            for m in snap.memories {
                book.memories.push(MemoryRecord {
                    uuid: m.uuid,
                    numeric_id: m.numeric_id,
                    device_local_id: m.device_local_id,
                    kind: kind_from_u8(m.kind),
                    device_created_time: m.device_created.map(|(s, n)| SyncTime::from_parts(s, n)),
                    gmt_offset: m.gmt_offset,
                    thumbnails: m
                        .thumbnails
                        .iter()
                        .filter_map(|bytes| decode_msg(bytes))
                        .collect(),
                    encrypted_location: m.encrypted_location.as_deref().and_then(decode_msg),
                    bursts: m.bursts,
                    upload_complete: m.upload_complete,
                    deleted: m.deleted.map(|(s, n)| SyncTime::from_parts(s, n)),
                    created: SyncTime::from_parts(m.created.0, m.created.1),
                });
            }
            for n in snap.notes {
                book.notes.push(NoteRecord {
                    uuid: n.uuid,
                    indexed_text: n.indexed_text,
                    encrypted_note: n.note.as_deref().and_then(decode_msg),
                    encrypted_location: n.location.as_deref().and_then(decode_msg),
                    created: SyncTime::from_parts(n.created.0, n.created.1),
                });
            }
            for e in snap.events {
                book.events.push(NotableEventRecord {
                    event_identifier: e.identifier,
                    originator_identifier: e.originator,
                    creation_time: e.creation.map(|(s, n)| SyncTime::from_parts(s, n)),
                    event_type: e.event_type,
                    event_data: e.event_data.as_deref().and_then(decode_msg),
                    encrypted_event_data: e.encrypted_event_data.as_deref().and_then(decode_msg),
                    encrypted_location: e.encrypted_location.as_deref().and_then(decode_msg),
                    device_is_locked: e.device_is_locked,
                    ingested: SyncTime::from_parts(e.ingested.0, e.ingested.1),
                    // Snapshots written before events were indexed have no text;
                    // they are re-indexed the next time the device re-syncs them.
                    indexed_text: None,
                });
            }
        }
        drop(captures);

        let mut account = self.account.lock().expect("account store poisoned");
        for (principal, blobs) in snapshot.account {
            let stored = account.entry(principal).or_default();
            for (kind, payload) in blobs {
                stored.insert(kind, payload);
            }
        }
    }
}

/// Distinguishes one writer's temp file from another's within this process.
static SNAPSHOT_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Write a file the workload's own user can read, and get it onto the disk
/// before the caller renames it into place.
///
/// The rename is only atomic with respect to *naming*; without the `sync_all`
/// the durability comment above it was claiming a guarantee the code did not
/// make, and a crash after the rename could publish a snapshot whose contents
/// had never left the page cache. Mirrors `keymaterial::write_private`, which
/// gets this right, including the mode: this file holds contacts, notes, and the
/// wearer's sealed account payloads.
fn write_durably(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    // `mode` only applies at creation, so a file left behind by an earlier run
    // with a wider mode is re-restricted explicitly.
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod recall_matching_tests {
    use super::*;

    /// The exact live failure: the wearer saved "I like trains", asked "What do
    /// I like?", and the model searched with a broad natural-language query. Both
    /// recall paths reported nothing saved.
    #[test]
    fn the_question_that_failed_now_finds_the_note() {
        let query = "what the wearer likes preferences favorites interests";
        assert!(
            recall_hits(query, "I like trains") > 0,
            "a saved note that plainly answers the question must be found",
        );
    }

    /// Plurals and inflections must not decide whether a memory exists.
    #[test]
    fn inflections_match_either_direction() {
        assert!(recall_hits("likes", "I like trains") > 0);
        assert!(recall_hits("train", "I like trains") > 0);
        assert!(recall_hits("running", "I run every morning") > 0);
    }

    /// Stopwords must not manufacture matches — otherwise every note "matches"
    /// every question and recall returns noise ranked as signal.
    #[test]
    fn stopwords_alone_never_match() {
        assert_eq!(recall_hits("what is the", "I like trains"), 0);
        assert_eq!(recall_hits("do I have any", "peonies, pale pink"), 0);
    }

    /// An unrelated question must still return nothing. A matcher that finds
    /// something for everything is as useless as one that finds nothing.
    #[test]
    fn unrelated_questions_still_find_nothing() {
        assert_eq!(recall_hits("what is my wifi password", "I like trains"), 0);
        assert_eq!(
            recall_hits("when is my flight", "Peonies - pale pink, not white."),
            0
        );
    }

    /// Ranking: more matching terms ranks higher, so the best note wins.
    #[test]
    fn more_matching_terms_scores_higher() {
        let strong = recall_hits("trains model railway", "I like trains and model railways");
        let weak = recall_hits("trains model railway", "I like trains");
        assert!(strong > weak, "{strong} should beat {weak}");
    }
}
