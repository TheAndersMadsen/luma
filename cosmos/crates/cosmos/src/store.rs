//! Principal-keyed persistence for the stateful device surfaces.
//!
//! Most of this deployment's handlers are honestly stateless, but a few are only
//! *useful* if they remember: the Pin writes a contact and expects to read it
//! back on its next sync, and a device that gets an empty list after a
//! successful write notices the loss. This module is the seam that makes those
//! services stateful without committing the deployment to a database yet,
//! [`Store`] is the contract, [`MemoryStore`] is the process-lifetime
//! implementation, and a real backing store drops in behind the same trait.
//!
//! Two properties are load-bearing:
//!
//! * **Isolation is a security property.** Every row is filed under the
//!   authenticated principal the mesh edge established (see `auth.rs`). No read
//!   path can reach another principal's rows. The store takes that principal as
//!   an opaque string so it never has to interpret or re-derive identity.
//! * **Nothing is invented.** The store returns exactly what the device wrote.
//!   The server owns ids, versions, and sync cursors, ids are fresh UUIDv4s,
//!   but no contact, id, or timestamp is ever fabricated for a principal that
//!   wrote nothing. An untouched principal reads back well-formed empty, never
//!   an error and never seed data.
//!
//! Contacts are modelled first-class here. Notable events and push tokens are
//! the next two stateful gaps. They are meant to arrive as additional [`Store`]
//! methods over the same principal key and are deliberately not built yet.
//!
//! # Evidence and documented ambiguity
//!
//! The contacts family was observed to complete `OK`, but its sync semantics
//! remain unknown: "cursor/
//! time semantics, full-vs-delta transition, ordering, tombstones, pagination
//! boundaries, stream termination, retry/resume rules, and consistency
//! guarantees". Nothing below is reverse-engineered behaviour, it is the
//! simplest reading the `humane.contacts` proto admits, chosen so a device that
//! writes and reads back is never surprised. Each choice that the evidence does
//! not pin down is called out at its definition.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use cosmos_protocol::{
    capture::ImageMetadata,
    common::encryption::{EncryptedData, LocationEnvelope},
    contacts as pb,
};
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
/// construction, see [`SyncTime::from_proto`], which folds anything else a
/// client sends back into `seconds`.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct SyncTime {
    seconds: i64,
    nanos: i32,
}

impl SyncTime {
    /// Wall-clock now. Writes never depend on this being monotonic on its own,
    /// [`ContactBook::stamp`] raises it above the stored high-water mark, but a
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
            // Anchor at the epoch rather than wrapping into negative time. The
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
    /// form. `i64` nanoseconds run out in 2262. A saturating multiply keeps a
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
/// values. Every other field is exactly what the device wrote. `modified`
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
/// `EncryptedData` with a parallel repeated version, there is **no id field**,
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
    /// Live contacts in an order that is the same on every read until the
    /// next write, so paginated reads page over a consistent sequence. The
    /// memory store keeps first-write order and edits in place. PostgreSQL
    /// lists by last write (modification time, then id). Neither order is a
    /// display order: `GetContacts` sorts by name (`services::contacts`).
    pub contacts: Vec<ContactRecord>,
    /// Encrypted contacts, in the same kind of order: first write in memory,
    /// last write (then ciphertext) in PostgreSQL.
    pub encrypted: Vec<EncryptedContactRecord>,
    /// Tombstones, ordered by id (a `BTreeMap` backs them) so streaming order is
    /// deterministic across runs.
    pub deletions: Vec<DeletionRecord>,
    /// The greatest cursor across every stored contact, encrypted contact, and
    /// tombstone. `None` when the principal has stored nothing, the honest
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

    /// Contacts modified strictly after `since`. All of them when `since` is
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

    /// Encrypted contacts modified strictly after `since`. All when `None`.
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

    /// Contacts matching `GetContactsRequest.search_term`. All of them when the
    /// term is blank.
    ///
    /// *Documented reading:* the proto names the field `search_term` but does
    /// not say what it searches. This matches a case-insensitive substring
    /// against the human-identifying fields a wearer would speak, every part of
    /// the name, the full name, e-mail addresses, both phone-number
    /// representations, and the organisation. A term written as a phone number
    /// also matches by its digits. Encrypted contacts are unmatchable here
    /// because this workload holds no contact channel key.
    pub fn matching(&self, term: &str) -> impl Iterator<Item = &ContactRecord> {
        let needle = term.trim().to_lowercase();
        self.contacts
            .iter()
            .filter(move |record| needle.is_empty() || matches_term(&record.contact, &needle))
    }
}

/// A contact's full name as the Pin forms it: first and last name joined by
/// a space, leaving out an empty part (stock `humane.system.contacts.Name.
/// getFullName`, `combineNames`). A contact the Pin creates by voice has only
/// these (`Name.create(first, last)`), no display name.
pub(crate) fn full_name(name: &pb::Name) -> String {
    [name.first_name.trim(), name.last_name.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Case-insensitive substring match over a contact's identifying fields.
/// `needle` must already be trimmed and lowercased.
///
/// A needle written as a phone number ("12 34 56 78", "+45 1234-5678") also
/// matches a number with the same digits in any format (INFERRED: a wearer
/// types a number the way they read it).
fn matches_term(contact: &pb::Contact, needle: &str) -> bool {
    let name = contact.name.iter().flat_map(|name| {
        [
            name.first_name.clone(),
            name.last_name.clone(),
            name.nickname.clone(),
            name.display_name.clone(),
            full_name(name),
        ]
    });
    let emails = contact.emails.iter().map(|email| email.value.clone());
    let organization = contact
        .organization
        .iter()
        .map(|organization| organization.name.clone());
    let numbers = || {
        contact.telephone_numbers.iter().map(String::as_str).chain(
            contact
                .phone_numbers
                .iter()
                .map(|phone| phone.value.as_str()),
        )
    };

    if name
        .chain(emails)
        .chain(numbers().map(str::to_owned))
        .chain(organization)
        .any(|field| field.to_lowercase().contains(needle))
    {
        return true;
    }
    let dialled = needle
        .chars()
        .all(|character| character.is_ascii_digit() || " +-().".contains(character));
    let digits: String = needle.chars().filter(char::is_ascii_digit).collect();
    dialled
        && digits.len() >= 3
        && numbers().any(|number| {
            number
                .chars()
                .filter(char::is_ascii_digit)
                .collect::<String>()
                .contains(&digits)
        })
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
/// content, the server never invents a thumbnail, a location, or a frame.
///
/// No `Debug`: thumbnails and locations are wearer content.
#[derive(Clone)]
pub struct MemoryRecord {
    /// Server-minted UUIDv4, `Memory.uuid`.
    pub uuid: String,
    /// Monotonic per principal, `Memory.id`. Separate from the uuid because the
    /// device carries both.
    pub numeric_id: i64,
    /// The device's own id for this capture. Identity for retries.
    pub device_local_id: String,
    /// Which arm of `CreateMemoryRequest` produced it.
    pub kind: MemoryKind,
    pub device_created_time: Option<SyncTime>,
    pub gmt_offset: i32,
    /// Stored verbatim. Opaque to us.
    pub thumbnails: Vec<EncryptedData>,
    pub encrypted_location: Option<EncryptedData>,
    /// Server-allocated upload slots the device writes its frames into.
    pub bursts: Vec<BurstRecord>,
    pub upload_complete: bool,
    pub deleted: Option<SyncTime>,
    pub created: SyncTime,
    /// What `CreateMemory` carried beyond the index.
    pub metadata: CaptureMetadata,
    /// Web-owned: `POST /capture/memory/{uuid}/favorite`.
    pub favorite: bool,
    /// Web-owned: `POST /capture/memory/{uuid}/tag`, in insertion order.
    pub tags: Vec<String>,
    pub upload_state: UploadState,
}

/// The parts of `PhotoMemoryRequest` / `VideoMemoryRequest` that are not the
/// capture index: stored so the web can show camera and orientation data and
/// a video's length. Every field is exactly what the device sent.
#[derive(Clone, Default)]
pub struct CaptureMetadata {
    /// `PhotoMemoryRequest.photo_metadatas`, one per uploaded frame.
    pub photo_metadatas: Vec<ImageMetadata>,
    /// `PhotoMemoryRequest.format` (`humane.capture.PhotoFileFormat`).
    pub format: i32,
    /// `PhotoMemoryRequest.lut_name`.
    pub lut_name: String,
    /// `encryption_information.kid` of either request arm.
    pub encryption_kid: String,
    /// `VideoMemoryRequest.num_videos`.
    pub num_videos: i32,
    /// `VideoMemoryRequest.total_video_duration_sec`.
    pub total_video_duration_sec: i32,
}

/// Where a capture's upload stands, as `UploadComplete` reported it
/// (`humane.capture.UploadCompletionStatus`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UploadState {
    /// Created, with the thumbnails `CreateMemory` carried. The device has not
    /// reported the full-resolution upload finished. This is the stock Pin's
    /// "low res uploaded" state: `MemoryUploadWorkerImpl.handleCreateMemoryResponse`
    /// sets `RecentEntity.isLowResUploaded` on the same successful
    /// `CreateMemory` that creates this row, and Recents then labels the
    /// capture "preview on Center". No second state lies between the two.
    #[default]
    Pending,
    /// `UPLOAD_SUCCESS`.
    Complete,
    /// `UPLOAD_FAILURE_FINAL`: the device gave up on this asset.
    FailedFinal,
}

impl UploadState {
    /// The stable storage spelling. Never derived from the variant order.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Complete => "complete",
            Self::FailedFinal => "failed_final",
        }
    }

    /// A stored spelling, or `None` for one this build does not know.
    pub fn parse(value: &str) -> Option<Self> {
        [Self::Pending, Self::Complete, Self::FailedFinal]
            .into_iter()
            .find(|state| state.as_str() == value)
    }

    /// A row stored before `upload_state` existed has only the boolean.
    pub fn from_stored(stored: Option<&str>, upload_complete: bool) -> Self {
        match stored.and_then(Self::parse) {
            Some(state) => state,
            None if upload_complete => Self::Complete,
            None => Self::Pending,
        }
    }
}

/// A capture the Pin declared it will create once the network allows:
/// `CaptureService.DeclareMemoryCreateIntent` (`MemoryCreateIntentRequest`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingMemoryCreate {
    pub device_local_id: String,
    /// `humane.capture.MemoryType`.
    pub memory_type: i32,
    /// `MemoryCreateIntentRequest.DelayReason`.
    pub delay_reason: i32,
    pub declared: SyncTime,
}

/// Most pending creates one account keeps. A declaration past it drops the
/// oldest.
///
/// INFERRED: stock bounds nothing here, the Pin declares every capture it
/// takes and clears nothing but its own queue. Refusing past the bound would
/// be worse than dropping: `MemoryUploadIntentWorker` answers an error with
/// `Result.retry()`, and its work is enqueued `ExistingWorkPolicy.APPEND`, so
/// one refused intent would stall every later one behind it. A thousand is far
/// more captures than a Pin holds waiting on a network, and the list the web
/// shows stays one bounded read.
pub const MAX_PENDING_MEMORY_CREATES: usize = 1_000;

/// The wearer's vote on one notable event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventVote {
    Up,
    Down,
}

impl EventVote {
    /// The stored value: `1` up, `-1` down.
    pub const fn as_i16(self) -> i16 {
        match self {
            Self::Up => 1,
            Self::Down => -1,
        }
    }

    pub const fn from_i16(value: i16) -> Option<Self> {
        match value {
            1 => Some(Self::Up),
            -1 => Some(Self::Down),
            _ => None,
        }
    }
}

/// Which notable events a page or a count covers.
///
/// Every list is a set: empty means "any". `excluded_originators` removes rows
/// whatever the other filters say. `start`/`end` bound `creation_time`
/// inclusively at second granularity, and a row with no creation time is
/// outside any bounded window.
#[derive(Clone, Debug, Default)]
pub struct EventFilter {
    pub types: Vec<String>,
    pub originators: Vec<String>,
    pub excluded_originators: Vec<String>,
    pub start: Option<SyncTime>,
    pub end: Option<SyncTime>,
    /// Oldest first, as the recovered `/mydata` asked with
    /// `sort=eventCreationTime,ASC`. Newest first otherwise.
    pub oldest_first: bool,
}

impl EventFilter {
    /// Whether `event` belongs in this filter. Shared by both backends'
    /// in-process paths so the two can never disagree on membership.
    pub fn matches(&self, event: &NotableEventRecord) -> bool {
        let seconds = event.creation_time.map(|time| time.seconds());
        (self.types.is_empty() || self.types.contains(&event.event_type))
            && (self.originators.is_empty()
                || self.originators.contains(&event.originator_identifier))
            && !self
                .excluded_originators
                .contains(&event.originator_identifier)
            && self
                .start
                .is_none_or(|start| seconds.is_some_and(|s| s >= start.seconds()))
            && self
                .end
                .is_none_or(|end| seconds.is_some_and(|s| s <= end.seconds()))
    }
}

/// A capture's INDEX, containing no sealed bytes at all.
///
/// The listing endpoints render counts and timestamps and nothing else (see
/// `capture_api::MemoryDto`), while a capture's megabytes all live in
/// `thumbnails`. Reading whole [`MemoryRecord`]s just to evaluate
/// `thumbnails.len()` therefore made every listing cost O(total stored bytes),
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
    /// How many thumbnails the device sealed, the count, never the bytes.
    pub thumbnail_count: usize,
    pub has_location: bool,
    pub burst_count: usize,
    /// Uploaded frame slots across all bursts.
    pub frame_count: usize,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub upload_state: UploadState,
    /// `VideoMemoryRequest.total_video_duration_sec`. Zero for a photo.
    pub total_video_duration_sec: i32,
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
            favorite: record.favorite,
            tags: record.tags.clone(),
            upload_state: record.upload_state,
            total_video_duration_sec: record.metadata.total_video_duration_sec,
        }
    }
}

/// One page of a listing: the rows asked for, and how many exist in total.
///
/// `total` is deliberately not `records.len()`. It is what the Spring `Page<T>`
/// envelope's `totalElements`/`totalPages`/`last` are computed from, and
/// deriving it from a truncated vector is exactly what forced the HTTP layer to
/// materialise every row before it could paginate, so `?size=1` cost what
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
/// refused and `handle_alloc_error` ABORTED the process, not a catchable panic,
/// so every other wearer's in-flight RPC on the ai-bus workload died with it,
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
/// and still at most ~1024 slots, a bounded allocation and a bounded response.
/// Raise them if a real device is ever observed to need more. Do not remove
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
    pub metadata: CaptureMetadata,
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
    /// Server-minted UUIDv4, what the device keys on.
    pub uuid: String,
    /// Lowercased plaintext, present only when the server could open the note
    /// or wrote it itself. Used for retrieval. Never returned on the wire.
    pub indexed_text: Option<String>,
    /// Sealed by the device. Opaque to us.
    pub encrypted_note: Option<EncryptedData>,
    pub encrypted_location: Option<EncryptedData>,
    pub created: SyncTime,
    /// Who wrote it. `None` for a note stored before sources were recorded.
    pub source: Option<NoteSource>,
    /// Server-held title (web notes and edits). A device note's own title lives
    /// inside `encrypted_note`.
    pub title: Option<String>,
    /// Server-held body in the wearer's original case.
    pub body: Option<String>,
    /// When the body or title last changed. The creation time for a note
    /// written since this was recorded, `None` before.
    pub modified: Option<SyncTime>,
    /// `FunctionCall.time_zone` of the quick action that created it.
    pub time_zone: Option<String>,
    /// `FunctionCall.location` of the quick action that created it.
    pub location: Option<LocationEnvelope>,
    pub tags: Vec<String>,
}

/// Who created a note. Stored by name, so a renamed variant cannot re-file one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteSource {
    /// The Pin sealed it: `CreateMemory(NoteMemoryRequest)` or
    /// `TestingAutomationService.CreateNote`.
    Device,
    /// The notes quick action: `FunctionCall{name: "CreateMemory"}`.
    QuickAction,
    /// The assistant's `remember` tool.
    Assistant,
    /// humane.center: `POST /capture/note/create`.
    Web,
}

impl NoteSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Device => "device",
            Self::QuickAction => "quick_action",
            Self::Assistant => "assistant",
            Self::Web => "web",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [Self::Device, Self::QuickAction, Self::Assistant, Self::Web]
            .into_iter()
            .find(|source| source.as_str() == value)
    }
}

/// What a caller asks the store to record as one note.
///
/// One constructor per origin so the store stays the only place that decides
/// what is indexed: the search text is the opened device envelope when there is
/// one, and otherwise the server-held title and body.
pub struct NewNote {
    pub source: NoteSource,
    pub title: Option<String>,
    /// Plaintext body in the wearer's original case.
    pub body: Option<String>,
    /// Search text the server derived from a sealed body it opened.
    pub opened_text: Option<String>,
    pub time_zone: Option<String>,
    pub location: Option<LocationEnvelope>,
    pub encrypted_note: Option<EncryptedData>,
    pub encrypted_location: Option<EncryptedData>,
    pub tags: Vec<String>,
}

impl NewNote {
    /// A note the Pin sealed, stored verbatim.
    pub fn sealed(
        encrypted_note: Option<EncryptedData>,
        encrypted_location: Option<EncryptedData>,
    ) -> Self {
        Self {
            source: NoteSource::Device,
            title: None,
            body: None,
            opened_text: None,
            time_zone: None,
            location: None,
            encrypted_note,
            encrypted_location,
            tags: Vec::new(),
        }
    }

    /// A note whose plaintext the server holds, from `source`.
    pub fn text(source: NoteSource, body: &str) -> Self {
        Self {
            source,
            body: Some(body.to_owned()),
            ..Self::sealed(None, None)
        }
    }

    /// The lowercase search index this note publishes, if any.
    fn index(&self) -> Option<String> {
        match &self.opened_text {
            Some(opened) => Some(opened.to_lowercase()),
            None => note_index(self.title.as_deref(), self.body.as_deref()),
        }
    }
}

/// The search index for a server-held title and body: both, lowercased, so a
/// note is findable by either. `None` when there is no text at all.
pub fn note_index(title: Option<&str>, body: Option<&str>) -> Option<String> {
    let joined = [title, body]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!joined.is_empty()).then(|| joined.to_lowercase())
}

impl NoteRecord {
    pub(crate) fn from_new(new: NewNote, created: SyncTime) -> Self {
        let indexed_text = new.index();
        Self {
            uuid: Uuid::new_v4().to_string(),
            indexed_text,
            encrypted_note: new.encrypted_note,
            encrypted_location: new.encrypted_location,
            created,
            source: Some(new.source),
            title: new.title,
            body: new.body,
            modified: Some(created),
            time_zone: new.time_zone,
            location: new.location,
            tags: new.tags,
        }
    }
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
    /// Device-minted. The PRIMARY KEY. The device re-sends on every sync, so
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
    /// exists only in `encrypted_event_data`, an event stored without opening it
    /// is a blob nothing can ever search. Never returned on the wire.
    pub indexed_text: Option<String>,
}

/// A search index a verified web read derived by opening a sealed event
/// ([`Store::backfill_event_index`]). Only the lowercase index, never the
/// opened plaintext.
#[derive(Clone)]
pub struct EventSearchIndex {
    pub event_identifier: String,
    pub indexed_text: String,
}

/// Which `humane.account` payload a stored blob is.
///
/// The account services contain sealed, service-scoped `EncryptedData` (and one
/// plaintext goals message) that this deployment holds no key for and never
/// needs to read. They are therefore stored as opaque bytes under
/// `(principal, kind)`, the kind is the namespace, so food restrictions and
/// intake goals cannot overwrite each other.
///
/// Kinds are named rather than numbered because the value is written into a
/// column and a snapshot key. A renumbering would silently re-file a wearer's
/// allergies under someone else's payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AccountBlobKind {
    /// `EncryptedSetFoodRestrictions`, includes the wearer's **allergies**.
    FoodRestrictions,
    /// `SetUserDailyIntakeGoals`.
    DailyIntakeGoals,
    /// `GetUserPersonalDetails`' response payload (preferred name, pronunciation,
    /// sealed bio data). No RPC in `humane.account` writes it, see the
    /// `services::account` module doc, so it is read-only until one appears.
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
    /// INFERRED: one verified sealed Pin location, retained only with explicit consent.
    LastLocation,
    /// INFERRED: latest content-free assistant outcome for wearer troubleshooting.
    PrivacyDiagnostics,
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
    /// Luma-owned: the wearer's linked music providers and which one is
    /// active, next to the stock `PartnerTokens`.
    MusicProviderAccounts,
    /// Device ids the wearer blocked from humane.center's devices page. A
    /// blocked Pin is answered `PERMISSION_DENIED` with the stock
    /// `unauthorized-device` trailer (`AccountAuthorizationInterceptor`).
    DeviceBlocks,
    /// Luma-owned: the account's OS3 conversation between questions (its
    /// session ID and the work OS3 had not finished), sealed
    /// (`backends::os3::ConversationStore`).
    Os3Conversation,
    /// The account's own Settings → Features choices, applied over the flags
    /// `FeatureFlagsService.GetFlags` serves that account's Pins
    /// (`flag_overrides`).
    FeatureFlagOverrides,
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
            Self::LastLocation => "last_location",
            Self::PrivacyDiagnostics => "privacy_diagnostics",
            Self::PushTokens => "push_tokens",
            Self::PushQueue => "push_queue",
            Self::PartnerTokens => "partner_tokens",
            Self::DeviceMessages => "device_messages",
            Self::CalendarState => "calendar_state",
            Self::FoodLogs => "food_logs",
            Self::SubscriptionState => "subscription_state",
            Self::MusicProviderAccounts => "music_provider_accounts",
            Self::DeviceBlocks => "device_blocks",
            Self::Os3Conversation => "os3_conversation",
            Self::FeatureFlagOverrides => "feature_flag_overrides",
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
            // this as transient, which is exactly right, the write may succeed
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
/// (`SyncEngine.performSync` runs `SELECT * FROM <table> WHERE needs_sync = 1`,
/// no `LIMIT`) and gives the whole exchange **35 seconds**
/// (`SyncEngine.SYNC_TIMEOUT_SECONDS`) before it gives up and leaves every row
/// flagged for the next sync. One network round trip per event therefore turns a
/// long history into a sync that can never finish: it times out, nothing clears,
/// and the same batch comes back forever.
///
/// So the batch is committed in multi-row statements instead. The chunk bounds
/// the statement rather than the wearer's data, nothing is dropped, which
/// matters because PostgreSQL caps a statement at 65535 bind parameters and an
/// event binds 12 of them. The inbound size is separately bounded by tonic's
/// 4 MiB default decode limit.
pub const INGEST_CHUNK: usize = 256;

#[tonic::async_trait]
pub trait Store: Send + Sync + 'static {
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
    /// * Every contact in one call shares one cursor, a call is one sync point.
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
    /// vacuous success, it records no tombstone, because the server has nothing
    /// to tell the principal's other devices about. `DeleteContacts` returns
    /// `google.protobuf.Empty`, so there is no shape in which to report a
    /// per-id result even if one were wanted.
    async fn delete_contacts(&self, principal: &str, ids: &[String]) -> Written<()>;

    /// Remove the principal's sealed contact rows whose ciphertext is one of
    /// `sealed`, returning how many went. Their identity is the exact
    /// ciphertext ([`EncryptedContactRecord`]), so this matches nothing else.
    ///
    /// For legacy sealed rows the contacts service has turned into plaintext
    /// records: once the record (or its tombstone) speaks for the contact, the
    /// sealed copy is only a second copy of it. No tombstone is recorded, the
    /// device never keyed a row on a sealed item it skipped.
    async fn delete_encrypted_contacts(
        &self,
        principal: &str,
        sealed: &[EncryptedData],
    ) -> Written<usize>;

    /// Everything stored for `principal`.
    ///
    /// A principal that has written nothing gets `Ok` of a default (empty)
    /// snapshot, well-formed empty, and never another principal's rows.
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
    ///
    /// Clears the principal's pending create for the same `device_local_id`
    /// (see [`Store::declare_pending_memory_create`]): the capture the Pin
    /// declared is now in the cloud, whichever attempt got it there.
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
    /// calls lists captures, the Pin only ever creates and deletes its own. The
    /// capability is nonetheless `observed` at the *web* boundary: the recovered
    /// `.Center` client called `GET /capture/memories` and `GET /capture/captures`
    /// with `page`/`size`/`sort=userCreatedAt,DESC`. So a reader exists in the
    /// system being cloned. Only its gRPC shape is `unknown`, and this is the
    /// clone's own answer to it, serving the companion dashboard rather than the
    /// device.
    ///
    /// **There is deliberately no whole-record listing.** There was one, and
    /// every caller of it wanted counts: it returned `MemoryRecord`s with their
    /// sealed frames attached, so producing `thumbnailCount` for a page cost
    /// O(total stored bytes) on an endpoint polled every five seconds. A reader
    /// that needs a capture's bytes has [`Store::memory`] (one row) and
    /// [`Store::memory_thumbnail`] (one frame). A reader that needs the index has
    /// this. Reintroducing the unbounded form would reintroduce the defect.
    ///
    /// `kinds` filters on the memory type and an empty slice means every kind.
    /// The filter belongs here rather than above the store because
    /// `/capture/captures` selects photos and videos: filtering after a limited
    /// fetch returns short, and wrong, pages. `only_favorited` is the
    /// recovered `onlyContainingFavorited` filter, applied the same way.
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
        only_favorited: bool,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<MemorySummary>>;

    /// How many live captures the principal holds, by kind (empty ⇒ all).
    ///
    /// Exists so a caller that wants a NUMBER does not download rows to call
    /// `.len()` on them, which additionally plateaued at whatever page size the
    /// caller happened to ask for, reporting a frozen count as if persistence
    /// had stalled.
    async fn count_memories(&self, principal: &str, kinds: &[MemoryKind]) -> Written<i64>;

    /// ONE sealed thumbnail, by capture and zero-based ordinal.
    ///
    /// `Ok(None)` covers both "no such capture for this principal" and "this
    /// capture has no such frame". The two are one answer to the caller and
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
    /// wearer's device forget a capture the cloud still holds, a deletion the
    /// wearer asked for that silently never happens.
    async fn delete_memory(&self, principal: &str, uuid_or_id: &str) -> Written<bool>;

    /// Record where a capture's upload stands. [`UploadState::Complete`] is
    /// also what `upload_complete` reports. `Ok(false)` means no such capture;
    /// `Err` means the store could not record it.
    ///
    /// Same reason as [`Store::delete_memory`]: `AssetUploadWorkerImpl` treats
    /// `STATUS_MEMORY_NOT_FOUND` as fatal and gives up on the asset forever,
    /// while `STATUS_INTERNAL_ERROR` is retried. A store failure reported as
    /// "not found" strands the wearer's photo permanently.
    async fn record_upload_state(
        &self,
        principal: &str,
        uuid_or_id: &str,
        state: UploadState,
    ) -> Written<bool>;

    /// Set or clear the favourite flag on each live capture named by uuid or
    /// numeric id. Returns how many of this principal's captures matched;
    /// another account's identifiers match nothing.
    async fn set_memory_favorite(
        &self,
        principal: &str,
        uuids_or_ids: &[String],
        favorite: bool,
    ) -> Written<usize>;

    /// Add `tag` to a live capture unless it already carries it. `Ok(false)`
    /// means the principal holds no such capture.
    async fn add_memory_tag(&self, principal: &str, uuid_or_id: &str, tag: &str) -> Written<bool>;

    /// Remove `tag` from a live capture. `Ok(false)` means the principal holds
    /// no such capture. Removing a tag it does not carry is `Ok(true)`.
    async fn remove_memory_tag(
        &self,
        principal: &str,
        uuid_or_id: &str,
        tag: &str,
    ) -> Written<bool>;

    /// Upsert the Pin's declaration that a capture is waiting to be created,
    /// keyed on `device_local_id` within this principal.
    ///
    /// A declaration for a capture that is already live records nothing.
    /// `PhotographyWorkScheduler` queues intents with `ExistingWorkPolicy.APPEND`
    /// beside an independent upload worker, so an intent retried behind an
    /// earlier one can land after its `CreateMemory`. Recording it then would
    /// show the wearer a capture "still on the Pin" that nothing ever clears.
    /// That holds against a `CreateMemory` running at the same moment too: the
    /// two serialize per principal, so an intent can never land after the
    /// create that should have cleared it.
    ///
    /// The queue keeps the newest [`MAX_PENDING_MEMORY_CREATES`]. A
    /// declaration past that drops the oldest instead of failing.
    async fn declare_pending_memory_create(
        &self,
        principal: &str,
        pending: &PendingMemoryCreate,
    ) -> Written<()>;

    /// The principal's captures still waiting on the Pin, newest first.
    async fn pending_memory_creates(&self, principal: &str) -> Written<Vec<PendingMemoryCreate>>;

    /// Clear the principal's whole pending queue (recovered
    /// `DELETE /capture/pending-memory-creates`). Returns how many went.
    async fn delete_all_pending_memory_creates(&self, principal: &str) -> Written<usize>;

    // --- notes ------------------------------------------------------------

    /// Store one note and its search index in the same durable write, and
    /// return it with its server-minted uuid.
    ///
    /// A device note's body is an opaque `EncryptedData` blob stored verbatim;
    /// its index is the text the caller opened from it ([`NewNote::sealed`]
    /// plus `opened_text`). A note the server holds in plaintext keeps its body
    /// in the wearer's original case and indexes title and body lowercased
    /// ([`NewNote::text`]). A device note must never receive CREATE_SUCCESS
    /// between inserting the row and publishing the index that makes it
    /// retrievable.
    ///
    /// `Written` because the handler acks `CREATE_SUCCESS` with the returned
    /// uuid: a write that silently failed would tell the wearer their note was
    /// captured while nothing was stored, and the device keeps no copy to retry
    /// from.
    async fn create_note(&self, principal: &str, new: NewNote) -> Written<NoteRecord>;

    /// The principal's note with this uuid. `Ok(None)` means this principal
    /// holds no such note, another account's uuid included, and `Err` that
    /// the store could not answer.
    async fn note(&self, principal: &str, uuid: &str) -> Written<Option<NoteRecord>>;

    /// Replace a note's title and body (recovered `POST /capture/note/{uuid}
    /// {text, title}`), stamp `modified`, and re-derive the index from them.
    ///
    /// `Ok(None)` means this principal holds no such note.
    async fn update_note(
        &self,
        principal: &str,
        uuid: &str,
        title: Option<&str>,
        body: &str,
    ) -> Written<Option<NoteRecord>>;

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
    ///
    /// `query`, when present and not blank, keeps only notes whose index
    /// contains it case-insensitively. The total counts those matches. A note
    /// with no index cannot match.
    async fn note_page(
        &self,
        principal: &str,
        query: Option<&str>,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<NoteRecord>>;

    /// How many notes the principal holds. See [`Store::count_memories`].
    async fn count_notes(&self, principal: &str) -> Written<i64>;

    /// Delete every note. Returns how many were removed.
    ///
    /// `Err` rather than `Ok(0)` when the delete could not be carried out, the
    /// wearer asked for an erasure and must not be told it happened.
    async fn delete_all_notes(&self, principal: &str) -> Written<usize>;

    /// Delete ONE note. `Ok(true)` means a note was removed, `Ok(false)` that
    /// this principal holds no such note, `Err` that the store could not contain
    /// the delete out.
    ///
    /// **Clone-authored, not a stock RPC**, the same standing as
    /// [`Store::memory_page`]. The device only ever erases *all* of its notes
    /// (`DeviceDeleteAllNotes`). A per-note delete is `observed` at the WEB
    /// boundary, where the recovered `.Center` carried a Forget control on a
    /// single row. So this serves the companion dashboard and changes nothing
    /// the Pin speaks.
    ///
    /// Scoped by `principal` like every other read and write here: another
    /// account's uuid matches nothing, which is `Ok(false)`, "no such note for
    /// *you*", and never an error, because an error that only occurs for rows
    /// that exist is itself a disclosure that they exist.
    ///
    /// The three answers must never be collapsed. This is a privacy product: the
    /// wearer pressed a control that says *delete*, so reporting a failed delete
    /// as `Ok(false)` ("there was nothing to delete") tells them an erasure
    /// happened over a row that is still stored, the same lie
    /// [`Store::delete_all_notes`] documents.
    ///
    /// A hard delete, matching [`Store::delete_all_notes`], and deliberately
    /// **no tombstone**: nothing syncs notes back down. The device pushes a note
    /// with `CreateNote` and never reads the server's list, so there is no delta
    /// read a tombstone could appear in, dropping the row IS the deletion.
    async fn delete_note(&self, principal: &str, uuid: &str) -> Written<bool>;

    /// Record a plaintext index entry for a note the server was able to open.
    ///
    /// Note bodies are sealed by the device and stored verbatim. This legacy
    /// update is used only for explicitly best-effort backfill of an already
    /// acknowledged row. New writes publish their index atomically via
    /// [`Store::create_note`].
    async fn index_note(&self, principal: &str, uuid: &str, plaintext: &str);

    /// Note uuids matching `query`, most recent first.
    ///
    /// Returns **uuids only**, never bodies: `SearchMemoryItem` carries just a
    /// uuid and the device resolves the content locally.
    ///
    /// `Err` is distinct from `Ok(vec![])`, "the search could not run" is not
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
    /// whole unsynced table on every sync, `SyncEngine.performSync` selects
    /// `WHERE needs_sync = 1` with no `LIMIT`, so a batch is large and may well
    /// repeat itself. Implementations must commit it without one round trip per
    /// event. See [`INGEST_CHUNK`].
    async fn ingest_events(
        &self,
        principal: &str,
        events: &[NotableEventRecord],
    ) -> Written<Vec<String>>;

    /// Give each named event its search index, only where the principal still
    /// holds that event and it has none yet. Returns how many took one.
    ///
    /// What a verified web read writes back after it opened a sealed event.
    /// Never an upsert: the read can race a delete, and writing the whole row
    /// back through [`Store::ingest_events`] would bring a forgotten event
    /// back. An index already stored, by ingest, or by a read that got there
    /// first, is kept.
    async fn backfill_event_index(
        &self,
        principal: &str,
        indexes: &[EventSearchIndex],
    ) -> Written<usize>;

    /// Events matching the filters, newest first, bounded by `max_results`
    /// (non-positive means unbounded). `start`/`end` bound `creation_time`, the
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
    /// contract. What it serves is the `.Center` My Data rows, Ai Mic, Music,
    /// Calls, Translation, whose trash control had no backend at all.
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
    /// event deleted here, no RPC exists to tell it otherwise, so this erases
    /// the cloud's record, which is what the control claims and all it claims.
    ///
    /// The wearer's vote on the event goes with it.
    async fn delete_event(&self, principal: &str, event_identifier: &str) -> Written<bool>;

    /// One page of the events [`EventFilter`] selects, in its order, with the
    /// full match count. Same window semantics as [`Store::memory_page`]. This
    /// is what the My Data domains page through instead of reading a whole
    /// partition to show ten rows.
    async fn query_event_page(
        &self,
        principal: &str,
        filter: &EventFilter,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<NotableEventRecord>>;

    /// How many events [`EventFilter`] selects, counted by the store rather
    /// than by downloading rows.
    async fn count_events(&self, principal: &str, filter: &EventFilter) -> Written<i64>;

    /// Record the wearer's vote on one of their events. `Ok(false)` means this
    /// principal holds no such event, so nothing was recorded.
    async fn put_event_feedback(
        &self,
        principal: &str,
        event_identifier: &str,
        vote: EventVote,
    ) -> Written<bool>;

    /// Withdraw the wearer's vote. `Ok(false)` means there was none.
    async fn delete_event_feedback(&self, principal: &str, event_identifier: &str)
    -> Written<bool>;

    /// The wearer's votes on the named events. An event with no vote is absent.
    async fn event_feedback(
        &self,
        principal: &str,
        event_identifiers: &[String],
    ) -> Written<HashMap<String, EventVote>>;

    // --- account ----------------------------------------------------------

    /// Store one `humane.account` payload under `(principal, kind)`, replacing
    /// whatever that pair held.
    ///
    /// `payload` is the prost encoding of the response message the matching read
    /// hands back. The bytes are opaque here. Nothing is decrypted, re-encrypted,
    /// or merged, a set RPC is the wearer's whole list, so the last write wins,
    /// which is the only reading the proto admits (there is no per-item id).
    ///
    /// `Written` because the device cannot tell an echo from a write. The
    /// handlers ack `EncryptedSetFoodRestrictions` by returning the wearer's own
    /// blob, so a swallowed failure looks exactly like success and their
    /// allergies are gone with nothing to indicate it.
    ///
    /// **Deliberately not defaulted.** A defaulted no-op would compile against
    /// every backend and leave persistence silently inert on whichever one did
    /// not override it, the failure mode this trait exists to prevent.
    async fn put_account_blob(
        &self,
        principal: &str,
        kind: AccountBlobKind,
        payload: &[u8],
    ) -> Written<()>;

    /// The payload stored under `(principal, kind)`, if any.
    ///
    /// `Ok(None)` is genuine absence, a device that has never set this payload,
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

    // --- account deletion -------------------------------------------------

    /// Remove everything this store holds for `principal`: contacts with their
    /// sealed copies and tombstones, captures (tombstoned ones too), pending
    /// captures, notes, notable events, votes, the sync cursor, and every account
    /// blob, including each Pin's status row, which is kept under
    /// `<principal>#device:<id>`. Nothing of any other principal is touched.
    ///
    /// Idempotent: purging an account with nothing left is `Ok`. The capture
    /// bytes themselves live in the object store and are removed by the caller.
    async fn purge_account(&self, principal: &str) -> Written<()>;
}

/// Build the store this deployment is configured for.
///
/// `COSMOS_DATABASE_URL` selects PostgreSQL, the documented target, and the only
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
/// process lifetime. A restart is indistinguishable, to a device, from a
/// never-synced account.
#[derive(Default)]
pub struct MemoryStore {
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
    /// Test seam for [`Self::test_fail_next_account_cas_writes`]. Compiled out
    /// of production builds.
    #[cfg(test)]
    fail_account_cas: std::sync::atomic::AtomicUsize,
}

/// Per-principal capture and notable-event state.
#[derive(Default)]
struct MemoryBook {
    memories: Vec<MemoryRecord>,
    notes: Vec<NoteRecord>,
    events: Vec<NotableEventRecord>,
    /// Monotonic allocator for `Memory.id` and burst/file ids.
    next_id: i64,
    pending: Vec<PendingMemoryCreate>,
    /// `event_identifier -> (vote, when)`.
    feedback: BTreeMap<String, (EventVote, SyncTime)>,
}

impl MemoryBook {
    fn live_memory_mut(&mut self, uuid_or_id: &str) -> Option<&mut MemoryRecord> {
        self.memories.iter_mut().find(|m| {
            m.deleted.is_none() && (m.uuid == uuid_or_id || m.numeric_id.to_string() == uuid_or_id)
        })
    }
}

/// The order both backends list events in: creation time (a row without one
/// last when newest-first), then identifier, so a page boundary never drops or
/// repeats a row.
fn event_order(
    filter: &EventFilter,
    a: &NotableEventRecord,
    b: &NotableEventRecord,
) -> std::cmp::Ordering {
    let newest_first = match (a.creation_time, b.creation_time) {
        (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
    .then_with(|| b.event_identifier.cmp(&a.event_identifier));
    if filter.oldest_first {
        newest_first.reverse()
    } else {
        newest_first
    }
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
    /// Durability is configured by `COSMOS_STATE_DIR`. Unset means memory-only.
    /// The process's one in-memory store.
    ///
    /// **Genuinely a singleton**, which the name previously only implied: this
    /// used to build a fresh `MemoryStore` per call, so two callers in the same
    /// process got two unrelated accounts. That is not a theoretical hazard,
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
    pub(crate) fn at_path(path: std::path::PathBuf) -> Self {
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
    /// Tombstones are retained for the process lifetime. A database
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
/// * An event with an empty `event_identifier` has no key and is dropped, the
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
/// backend's monotonic allocation. Burst and file ids derive from it so two
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
/// false, so a note that plainly answered the question was reported as
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
        metadata,
    } = new;

    // At least one burst with one file, so the device always has somewhere to
    // upload. A zero-slot response is what stranded captures before.
    //
    // The upper bound is the backstop for the same counts: `.max(1)` is a floor
    // and did nothing about large positives, so an `i32::MAX` on either field
    // reached the allocations below and took the whole workload down (see
    // [`MAX_BURSTS`]). The refusal lives at the service boundary, where the
    // caller can be told it asked for too much. By the time we are here there is
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
        metadata,
        favorite: false,
        tags: Vec::new(),
        upload_state: UploadState::Pending,
    }
}

#[tonic::async_trait]
impl Store for MemoryStore {
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
            // Re-creating a previously deleted id makes it live again. Leaving
            // the tombstone would delete it from every other device on the next
            // delta sync.
            book.tombstones.remove(&id);
            written.push(record);
        }

        for (index, data) in list.encrypted_contacts.iter().enumerate() {
            // The versions are a parallel repeated field, so a short or absent
            // list is not an error, the missing entries default.
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
        // No book means the principal has written nothing. A delete creates no
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

    async fn delete_encrypted_contacts(
        &self,
        principal: &str,
        sealed: &[EncryptedData],
    ) -> Written<usize> {
        let mut books = self.books.lock().expect("contact store poisoned");
        let Some(book) = books.get_mut(principal) else {
            return Ok(0);
        };
        let before = book.encrypted.len();
        book.encrypted
            .retain(|record| !sealed.contains(&record.data));
        let removed = before - book.encrypted.len();
        drop(books);
        if removed > 0 {
            self.persist();
        }
        Ok(removed)
    }

    async fn contacts(&self, principal: &str) -> Written<ContactSnapshot> {
        let books = self.books.lock().expect("contact store poisoned");
        let Some(book) = books.get(principal) else {
            // Genuine absence, `Ok` of an empty snapshot, never `Err`.
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
            metadata,
        } = new;
        let device_local_id = device_local_id.as_str();
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let book = guard.entry(principal.to_owned()).or_default();

        // Idempotent on the device's own id: a retried CreateMemory must return
        // the SAME uuid, or the first attempt's upload slots are orphaned.
        if !device_local_id.is_empty() {
            let pending_before = book.pending.len();
            book.pending
                .retain(|pending| pending.device_local_id != device_local_id);
            let cleared = book.pending.len() != pending_before;
            if let Some(existing) = book
                .memories
                .iter()
                .find(|m| m.device_local_id == device_local_id && m.deleted.is_none())
            {
                let existing = existing.clone();
                drop(guard);
                if cleared {
                    self.persist();
                }
                return Ok(existing);
            }
        }

        let numeric_id = book.allocate();
        // At least one burst with one file, so the device always has somewhere
        // to upload. A zero-slot response is what stranded the capture before.
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
            metadata,
            favorite: false,
            tags: Vec::new(),
            upload_state: UploadState::Pending,
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
        only_favorited: bool,
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
            .filter(|m| !only_favorited || m.favorite)
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

    async fn record_upload_state(
        &self,
        principal: &str,
        uuid_or_id: &str,
        state: UploadState,
    ) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(memory) = guard
            .get_mut(principal)
            .and_then(|book| book.live_memory_mut(uuid_or_id))
        else {
            return Ok(false);
        };
        memory.upload_state = state;
        memory.upload_complete = state == UploadState::Complete;
        drop(guard);
        self.persist();
        Ok(true)
    }

    async fn set_memory_favorite(
        &self,
        principal: &str,
        uuids_or_ids: &[String],
        favorite: bool,
    ) -> Written<usize> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return Ok(0);
        };
        let mut matched = 0;
        for memory in book.memories.iter_mut().filter(|m| {
            m.deleted.is_none()
                && uuids_or_ids
                    .iter()
                    .any(|id| *id == m.uuid || *id == m.numeric_id.to_string())
        }) {
            memory.favorite = favorite;
            matched += 1;
        }
        drop(guard);
        if matched > 0 {
            self.persist();
        }
        Ok(matched)
    }

    async fn add_memory_tag(&self, principal: &str, uuid_or_id: &str, tag: &str) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(memory) = guard
            .get_mut(principal)
            .and_then(|book| book.live_memory_mut(uuid_or_id))
        else {
            return Ok(false);
        };
        if !memory.tags.iter().any(|existing| existing == tag) {
            memory.tags.push(tag.to_owned());
        }
        drop(guard);
        self.persist();
        Ok(true)
    }

    async fn remove_memory_tag(
        &self,
        principal: &str,
        uuid_or_id: &str,
        tag: &str,
    ) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(memory) = guard
            .get_mut(principal)
            .and_then(|book| book.live_memory_mut(uuid_or_id))
        else {
            return Ok(false);
        };
        memory.tags.retain(|existing| existing != tag);
        drop(guard);
        self.persist();
        Ok(true)
    }

    async fn declare_pending_memory_create(
        &self,
        principal: &str,
        pending: &PendingMemoryCreate,
    ) -> Written<()> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let book = guard.entry(principal.to_owned()).or_default();
        if !pending.device_local_id.is_empty()
            && book
                .memories
                .iter()
                .any(|m| m.device_local_id == pending.device_local_id && m.deleted.is_none())
        {
            return Ok(());
        }
        match book
            .pending
            .iter_mut()
            .find(|existing| existing.device_local_id == pending.device_local_id)
        {
            Some(existing) => *existing = pending.clone(),
            None => book.pending.push(pending.clone()),
        }
        if book.pending.len() > MAX_PENDING_MEMORY_CREATES {
            // Newest first, in the order `pending_memory_creates` reads. The
            // tail past the bound is the oldest.
            book.pending.sort_by(|a, b| {
                b.declared
                    .cmp(&a.declared)
                    .then_with(|| b.device_local_id.cmp(&a.device_local_id))
            });
            book.pending.truncate(MAX_PENDING_MEMORY_CREATES);
        }
        drop(guard);
        self.persist();
        Ok(())
    }

    async fn pending_memory_creates(&self, principal: &str) -> Written<Vec<PendingMemoryCreate>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        let mut pending = guard
            .get(principal)
            .map(|book| book.pending.clone())
            .unwrap_or_default();
        pending.sort_by(|a, b| {
            b.declared
                .cmp(&a.declared)
                .then_with(|| b.device_local_id.cmp(&a.device_local_id))
        });
        Ok(pending)
    }

    async fn delete_all_pending_memory_creates(&self, principal: &str) -> Written<usize> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return Ok(0);
        };
        let removed = std::mem::take(&mut book.pending).len();
        drop(guard);
        if removed > 0 {
            self.persist();
        }
        Ok(removed)
    }

    // --- notes ------------------------------------------------------------

    async fn create_note(&self, principal: &str, new: NewNote) -> Written<NoteRecord> {
        let record = NoteRecord::from_new(new, SyncTime::now());
        let mut guard = self.captures.lock().expect("capture store poisoned");
        guard
            .entry(principal.to_owned())
            .or_default()
            .notes
            .push(record.clone());
        drop(guard);
        self.persist();
        Ok(record)
    }

    async fn note(&self, principal: &str, uuid: &str) -> Written<Option<NoteRecord>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        Ok(guard
            .get(principal)
            .and_then(|book| book.notes.iter().find(|note| note.uuid == uuid))
            .cloned())
    }

    async fn update_note(
        &self,
        principal: &str,
        uuid: &str,
        title: Option<&str>,
        body: &str,
    ) -> Written<Option<NoteRecord>> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(note) = guard
            .get_mut(principal)
            .and_then(|book| book.notes.iter_mut().find(|n| n.uuid == uuid))
        else {
            return Ok(None);
        };
        note.title = title.map(str::to_owned);
        note.body = Some(body.to_owned());
        note.indexed_text = note_index(title, Some(body));
        note.modified = Some(SyncTime::now());
        let updated = note.clone();
        drop(guard);
        self.persist();
        Ok(Some(updated))
    }

    async fn recent_notes(
        &self,
        principal: &str,
        max_items: i32,
        start: Option<SyncTime>,
        end: Option<SyncTime>,
    ) -> Written<Vec<NoteRecord>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get(principal) else {
            return Ok(Vec::new());
        };
        let mut found: Vec<NoteRecord> = book
            .notes
            .iter()
            // The window is inclusive on both ends. An unset bound is open.
            // Second granularity, like `EventFilter::matches` and like the
            // bound the Postgres statement applies, so the two can never
            // disagree on membership over sub-second edges.
            .filter(|n| start.is_none_or(|s| n.created.seconds() >= s.seconds()))
            .filter(|n| end.is_none_or(|e| n.created.seconds() <= e.seconds()))
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
        query: Option<&str>,
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
        let needle = query
            .map(|query| query.trim().to_lowercase())
            .filter(|query| !query.is_empty());
        let mut found: Vec<NoteRecord> = book
            .notes
            .iter()
            .filter(|note| {
                needle.as_deref().is_none_or(|needle| {
                    note.indexed_text
                        .as_deref()
                        .is_some_and(|text| text.contains(needle))
                })
            })
            .cloned()
            .collect();
        // Newest first. The uuid breaks a tie in the same order Postgres does,
        // so a page boundary between two notes written in one instant neither
        // repeats nor skips a note.
        found.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| b.uuid.cmp(&a.uuid)));
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
        // Every indexed note is scored: a match anywhere in the wearer's
        // history must be found, never cut off by recency before scoring.
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
        // No book means this principal has stored nothing. A delete creates no
        // state for it, same shape as `delete_contacts`.
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
        // sync, the quadratic term is what a wearer with a long history pays.
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
                Some(at) => {
                    // A re-send the server could not open carries no index. The
                    // one an earlier opened copy earned stays searchable.
                    let kept = book.events[at].indexed_text.take();
                    // Privacy consent governs new events. An omitted envelope
                    // on an idempotent resend does not delete prior history.
                    let kept_location = book.events[at].encrypted_location.take();
                    book.events[at] = incoming.clone();
                    if book.events[at].indexed_text.is_none() {
                        book.events[at].indexed_text = kept;
                    }
                    if book.events[at].encrypted_location.is_none() {
                        book.events[at].encrypted_location = kept_location;
                    }
                }
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

    async fn backfill_event_index(
        &self,
        principal: &str,
        indexes: &[EventSearchIndex],
    ) -> Written<usize> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return Ok(0);
        };
        let wanted: HashMap<&str, &str> = indexes
            .iter()
            .map(|index| (index.event_identifier.as_str(), index.indexed_text.as_str()))
            .collect();
        let mut written = 0;
        for event in &mut book.events {
            if event.indexed_text.is_none()
                && let Some(text) = wanted.get(event.event_identifier.as_str())
            {
                event.indexed_text = Some((*text).to_owned());
                written += 1;
            }
        }
        drop(guard);
        if written > 0 {
            self.persist();
        }
        Ok(written)
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
            // An empty filter matches everything. A set one is an exact match.
            .filter(|e| event_type.is_empty() || e.event_type == event_type)
            .filter(|e| originator.is_empty() || e.originator_identifier == originator)
            // Time window on creation_time. A record with no creation time can't
            // be proven out of range, so it is kept (the device dedups by uuid).
            // Second granularity, like `EventFilter::matches` and like the bound
            // the Postgres statement applies, so the two can never disagree on
            // membership over sub-second edges.
            .filter(|e| match (&start, &e.creation_time) {
                (Some(s), Some(ct)) => ct.seconds() >= s.seconds(),
                _ => true,
            })
            .filter(|e| match (&end, &e.creation_time) {
                (Some(en), Some(ct)) => ct.seconds() <= en.seconds(),
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
        book.feedback.remove(event_identifier);
        drop(guard);
        self.persist();
        Ok(true)
    }

    async fn query_event_page(
        &self,
        principal: &str,
        filter: &EventFilter,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<NotableEventRecord>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get(principal) else {
            return Ok(StorePage {
                records: Vec::new(),
                total: 0,
            });
        };
        let mut found: Vec<&NotableEventRecord> =
            book.events.iter().filter(|e| filter.matches(e)).collect();
        found.sort_by(|a, b| event_order(filter, a, b));
        let total = found.len() as i64;
        let records = found
            .into_iter()
            .skip(offset.max(0) as usize)
            .take(limit.max(0) as usize)
            .cloned()
            .collect();
        Ok(StorePage { records, total })
    }

    async fn count_events(&self, principal: &str, filter: &EventFilter) -> Written<i64> {
        let guard = self.captures.lock().expect("capture store poisoned");
        Ok(guard.get(principal).map_or(0, |book| {
            book.events.iter().filter(|e| filter.matches(e)).count() as i64
        }))
    }

    async fn put_event_feedback(
        &self,
        principal: &str,
        event_identifier: &str,
        vote: EventVote,
    ) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let Some(book) = guard.get_mut(principal) else {
            return Ok(false);
        };
        if !book
            .events
            .iter()
            .any(|e| e.event_identifier == event_identifier)
        {
            return Ok(false);
        }
        book.feedback
            .insert(event_identifier.to_owned(), (vote, SyncTime::now()));
        drop(guard);
        self.persist();
        Ok(true)
    }

    async fn delete_event_feedback(
        &self,
        principal: &str,
        event_identifier: &str,
    ) -> Written<bool> {
        let mut guard = self.captures.lock().expect("capture store poisoned");
        let removed = guard
            .get_mut(principal)
            .is_some_and(|book| book.feedback.remove(event_identifier).is_some());
        drop(guard);
        if removed {
            self.persist();
        }
        Ok(removed)
    }

    async fn event_feedback(
        &self,
        principal: &str,
        event_identifiers: &[String],
    ) -> Written<HashMap<String, EventVote>> {
        let guard = self.captures.lock().expect("capture store poisoned");
        Ok(guard.get(principal).map_or_else(HashMap::new, |book| {
            event_identifiers
                .iter()
                .filter_map(|id| book.feedback.get(id).map(|(vote, _)| (id.clone(), *vote)))
                .collect()
        }))
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
        // Test seam: lose this compare-and-swap as if another writer had landed
        // first, so a caller's retry loop can be driven to exhaustion
        // deterministically, a real race cannot be forced from outside.
        #[cfg(test)]
        loop {
            let failing = self
                .fail_account_cas
                .load(std::sync::atomic::Ordering::SeqCst);
            if failing == 0 {
                break;
            }
            if self
                .fail_account_cas
                .compare_exchange(
                    failing,
                    failing - 1,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_ok()
            {
                return Ok(false);
            }
        }
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

    async fn purge_account(&self, principal: &str) -> Written<()> {
        let device_rows = format!("{principal}#device:");
        self.books
            .lock()
            .expect("contact store poisoned")
            .remove(principal);
        self.captures
            .lock()
            .expect("capture store poisoned")
            .remove(principal);
        self.account
            .lock()
            .expect("account store poisoned")
            .retain(|owner, _| owner != principal && !owner.starts_with(&device_rows));
        self.persist();
        Ok(())
    }
}

#[cfg(test)]
mod tests {

    /// REGRESSION: every handler calls `persist()` *after* dropping its data
    /// lock, and `persist` used to build, encode, and write with no
    /// serialisation of its own, through ONE shared `state.json.tmp`.
    ///
    /// Two consequences, both of which lose the wearer's data:
    ///
    /// * **Regression.** Writer A builds a snapshot, writer B builds a later one
    ///   and renames it, then A renames its stale copy over the top. Both writes
    ///   were acknowledged. One is now absent from the only durable copy, and no
    ///   later write will reintroduce it.
    /// * **Corruption.** Sharing one temp path lets B truncate and rewrite the
    ///   file A is midway through publishing, so the rename can publish a
    ///   half-and-half blob that parses as nothing. `restore` then refused to
    ///   start, before that, it discarded every wearer's data behind one WARN.
    ///
    /// The invariant is checked CONTINUOUSLY by a watcher reading the published
    /// file while the writers run, not just once at the end: at the end the
    /// writers are all finishing together, so the last snapshot published is
    /// usually complete by luck and the end-state assertion alone was only
    /// intermittently red. Every publish is an observation instead, the file
    /// must always parse, and its contact count must never go backwards.
    /// Concurrency is what makes this falsifiable (a serialised writer cannot
    /// produce either failure), so the writers are released together and each
    /// `persist` is made expensive enough, a 128 KiB opaque payload re-encoded
    /// every time, that the window is real rather than theoretical.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_writers_never_publish_a_partial_snapshot() {
        use std::sync::atomic::{AtomicBool, Ordering};

        const WRITERS: usize = 8;
        const ROUNDS: usize = 32;

        let dir = std::env::temp_dir().join(format!("cosmos-snapshot-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp state dir");
        let path = dir.join("state.json");

        // Reads whatever is currently published. `rename` is atomic, so a reader
        // always sees some complete previously-published file, which makes an
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
            // One store, many concurrent writers, the deployed shape.
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
        // write). It deliberately does not assert the final count, because it
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
    /// account payloads behind one WARN line, and the next write republished
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

    /// ANOTHER WEARER'S ROW IS INVISIBLE, NOT MERELY REFUSED.
    ///
    /// The identifiers here are the *real* ones, B is deleting exactly the keys
    /// A holds, so the only thing standing between the two accounts is the
    /// principal predicate. It answers `false` (nothing of yours matched) while
    /// A's rows stay put. An error instead would confirm the row exists, which
    /// is itself a disclosure.
    #[tokio::test]
    async fn a_delete_under_one_principal_cannot_reach_anothers_note_or_event() {
        let store = MemoryStore::default();
        store
            .ingest_events("device-a", &[event("ev-1")])
            .await
            .expect("write succeeds");
        let note = store
            .create_note("device-a", NewNote::sealed(None, None))
            .await
            .unwrap();

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
}

// --- durability -------------------------------------------------------------
//
// The three stateful workloads (contacts, notable-events, ai-bus) are separate
// processes, each with its own store, there is no shared database today, so
// each one snapshots its own state to its own file. That preserves exactly the
// current semantics while fixing the defect that mattered: on a restart the
// wearer's notes, contacts, captures, and history simply vanished, which to a
// device looks like a never-synced account.
//
// A shared PostgreSQL backend remains the target for a real deployment. It needs the `Store` trait
// async-ified, which this seam already anticipates.
//
// Encoding: protobuf-typed fields are stored as their encoded bytes (prost is
// already a dependency and the wire encoding is the one thing guaranteed stable
// here). Cursors and versions ride alongside as plain values.

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
/// The bytes are opaque, sealed by the device for a key we do not hold.
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
    /// still loads, the alternative is refusing the whole file and reading back
    /// as a never-synced account, which is the failure this section exists to
    /// prevent.
    #[serde(default)]
    memories: Vec<MemorySnapshot>,
    notes: Vec<NoteSnapshot>,
    events: Vec<EventSnapshot>,
    next_id: i64,
    /// `(device_local_id, memory_type, delay_reason, declared)`.
    #[serde(default)]
    pending: Vec<(String, i32, i32, (i64, i32))>,
    /// `(event_identifier, vote, when)`.
    #[serde(default)]
    feedback: Vec<(String, i16, (i64, i32))>,
}

/// A capture, flattened for the snapshot file.
///
/// Captures used to be left out of the snapshot entirely, so `UploadComplete`
/// and `DeleteMemory`, both of which the device is told succeeded, did not
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
    // Everything below is `default` so a snapshot written before it loads.
    #[serde(default)]
    photo_metadatas: Vec<Vec<u8>>,
    #[serde(default)]
    format: i32,
    #[serde(default)]
    lut_name: String,
    #[serde(default)]
    encryption_kid: String,
    #[serde(default)]
    num_videos: i32,
    #[serde(default)]
    total_video_duration_sec: i32,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    upload_state: Option<String>,
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
    // Everything below is `default` so a snapshot written before it loads.
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    modified: Option<(i64, i32)>,
    #[serde(default)]
    time_zone: Option<String>,
    /// The quick action's plaintext `LocationEnvelope`.
    #[serde(default)]
    place: Option<Vec<u8>>,
    #[serde(default)]
    tags: Vec<String>,
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
    /// same moment. With one shared temp name and a non-atomic `write` they
    /// interleaved and published a snapshot that parses as nothing, which
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
                                        photo_metadatas: m
                                            .metadata
                                            .photo_metadatas
                                            .iter()
                                            .map(encode_msg)
                                            .collect(),
                                        format: m.metadata.format,
                                        lut_name: m.metadata.lut_name.clone(),
                                        encryption_kid: m.metadata.encryption_kid.clone(),
                                        num_videos: m.metadata.num_videos,
                                        total_video_duration_sec: m
                                            .metadata
                                            .total_video_duration_sec,
                                        favorite: m.favorite,
                                        tags: m.tags.clone(),
                                        upload_state: Some(m.upload_state.as_str().to_owned()),
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
                                        source: n.source.map(|s| s.as_str().to_owned()),
                                        title: n.title.clone(),
                                        body: n.body.clone(),
                                        modified: n.modified.map(|t| (t.seconds(), t.nanos())),
                                        time_zone: n.time_zone.clone(),
                                        place: n.location.as_ref().map(encode_msg),
                                        tags: n.tags.clone(),
                                    })
                                    .collect(),
                                pending: book
                                    .pending
                                    .iter()
                                    .map(|p| {
                                        (
                                            p.device_local_id.clone(),
                                            p.memory_type,
                                            p.delay_reason,
                                            (p.declared.seconds(), p.declared.nanos()),
                                        )
                                    })
                                    .collect(),
                                feedback: book
                                    .feedback
                                    .iter()
                                    .map(|(id, (vote, at))| {
                                        (id.clone(), vote.as_i16(), (at.seconds(), at.nanos()))
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
        // corrupt file, and the `snapshot` guard is process-local, it says
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
    /// history, and account payloads, and the next write republished the empty
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
            // The path is named. The contents are wearer data and are not.
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
                    metadata: CaptureMetadata {
                        photo_metadatas: m
                            .photo_metadatas
                            .iter()
                            .filter_map(|bytes| decode_msg(bytes))
                            .collect(),
                        format: m.format,
                        lut_name: m.lut_name,
                        encryption_kid: m.encryption_kid,
                        num_videos: m.num_videos,
                        total_video_duration_sec: m.total_video_duration_sec,
                    },
                    favorite: m.favorite,
                    tags: m.tags,
                    upload_state: UploadState::from_stored(
                        m.upload_state.as_deref(),
                        m.upload_complete,
                    ),
                });
            }
            for n in snap.notes {
                book.notes.push(NoteRecord {
                    uuid: n.uuid,
                    indexed_text: n.indexed_text,
                    encrypted_note: n.note.as_deref().and_then(decode_msg),
                    encrypted_location: n.location.as_deref().and_then(decode_msg),
                    created: SyncTime::from_parts(n.created.0, n.created.1),
                    source: n.source.as_deref().and_then(NoteSource::parse),
                    title: n.title,
                    body: n.body,
                    modified: n.modified.map(|(s, ns)| SyncTime::from_parts(s, ns)),
                    time_zone: n.time_zone,
                    location: n.place.as_deref().and_then(decode_msg),
                    tags: n.tags,
                });
            }
            for (device_local_id, memory_type, delay_reason, (s, ns)) in snap.pending {
                book.pending.push(PendingMemoryCreate {
                    device_local_id,
                    memory_type,
                    delay_reason,
                    declared: SyncTime::from_parts(s, ns),
                });
            }
            for (identifier, vote, (s, ns)) in snap.feedback {
                if let Some(vote) = EventVote::from_i16(vote) {
                    book.feedback
                        .insert(identifier, (vote, SyncTime::from_parts(s, ns)));
                }
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
/// The rename is only atomic with respect to *naming*. Without the `sync_all`
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

/// The consolidation contract every backend must satisfy, written once and run
/// against [`MemoryStore`] here and against PostgreSQL in `store_postgres`.
///
/// Each check takes a fresh principal so a shared database cannot bleed rows
/// between runs.
#[cfg(test)]
pub(crate) mod contract {
    use super::*;

    pub(crate) fn fresh_principal(tag: &str) -> String {
        format!("contract-{tag}-{}", Uuid::new_v4())
    }

    fn photo(device_local_id: &str) -> NewMemory {
        NewMemory {
            kind: MemoryKind::Photo,
            device_local_id: device_local_id.to_owned(),
            bursts: 1,
            files_per_burst: 1,
            device_created_time: None,
            gmt_offset: 0,
            thumbnails: Vec::new(),
            encrypted_location: None,
            metadata: CaptureMetadata::default(),
        }
    }

    fn event(identifier: &str, event_type: &str, originator: &str, at: i64) -> NotableEventRecord {
        NotableEventRecord {
            event_identifier: identifier.to_owned(),
            originator_identifier: originator.to_owned(),
            creation_time: Some(SyncTime::from_parts(at, 0)),
            event_type: event_type.to_owned(),
            event_data: None,
            encrypted_event_data: None,
            encrypted_location: None,
            device_is_locked: false,
            ingested: SyncTime::now(),
            indexed_text: None,
        }
    }

    async fn only_note(store: &dyn Store, principal: &str, uuid: &str) -> NoteRecord {
        store
            .note_page(principal, None, 0, 200)
            .await
            .expect("page")
            .records
            .into_iter()
            .find(|note| note.uuid == uuid)
            .expect("the note reads back")
    }

    /// Note search ranks with the one recall matcher on every backend.
    ///
    /// Production runs on Postgres, and its statement once did raw substring
    /// term overlap while the in-memory store used `recall_hits`: "what do I
    /// like" found "I like trains" in tests and nothing in production, and a
    /// query's "the" or "is" pulled unrelated notes into the answer.
    pub(crate) async fn search_notes_matches_inflections_and_ignores_stopwords(store: &dyn Store) {
        let principal = fresh_principal("search");
        let mut indexed = Vec::new();
        for text in [
            "i like trains",
            "the gate code is 4412",
            "this note is about apples",
            "more apples for the pie",
            "the model railway show",
        ] {
            let note = store
                .create_note(&principal, NewNote::sealed(None, None))
                .await
                .expect("write succeeds");
            store.index_note(&principal, &note.uuid, text).await;
            indexed.push(note.uuid);
            // Distinct creation instants, so "newest first" is well defined.
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        let [trains, _gate, apples, pie, railway] = [0, 1, 2, 3, 4].map(|i| indexed[i].clone());

        assert_eq!(
            store.search_notes(&principal, "likes", 0).await.unwrap(),
            vec![trains.clone()],
            "an inflection finds the note"
        );
        assert_eq!(
            store.search_notes(&principal, "railways", 0).await.unwrap(),
            vec![railway],
            "a plural query finds the singular note: `contains(\"railways\")` is \
             false, so the substring scoring this replaced found nothing here"
        );
        assert_eq!(
            store
                .search_notes(
                    &principal,
                    "what the wearer likes preferences favorites interests",
                    5
                )
                .await
                .unwrap(),
            vec![trains],
            "a natural-language recall query finds the note and nothing on stopwords"
        );
        assert!(
            store
                .search_notes(&principal, "what is the", 0)
                .await
                .unwrap()
                .is_empty(),
            "a stopword-only query matches nothing"
        );
        assert_eq!(
            store.search_notes(&principal, "apple", 0).await.unwrap(),
            vec![pie.clone(), apples],
            "equal scores come back newest first"
        );
        assert_eq!(
            store.search_notes(&principal, "apple", 1).await.unwrap(),
            vec![pie],
            "max_results bounds the answer, not which notes are scored"
        );
    }

    pub(crate) async fn create_note_keeps_original_case_and_lowercases_only_the_index(
        store: &dyn Store,
    ) {
        let principal = fresh_principal("case");
        let written = store
            .create_note(
                &principal,
                NewNote {
                    title: Some("Weekend Plan".to_owned()),
                    time_zone: Some("Europe/Copenhagen".to_owned()),
                    location: Some(LocationEnvelope {
                        latitude: 55.68,
                        longitude: 12.57,
                        human_readable: "Nørrebro".to_owned(),
                        ..Default::default()
                    }),
                    tags: vec!["errands".to_owned()],
                    ..NewNote::text(NoteSource::QuickAction, "Buy Milk at Netto")
                },
            )
            .await
            .expect("write succeeds");
        let read = only_note(store, &principal, &written.uuid).await;
        assert_eq!(read.body.as_deref(), Some("Buy Milk at Netto"));
        assert_eq!(read.title.as_deref(), Some("Weekend Plan"));
        assert_eq!(
            read.indexed_text.as_deref(),
            Some("weekend plan buy milk at netto"),
            "only the index is lowercased"
        );
        assert_eq!(read.source, Some(NoteSource::QuickAction));
        assert_eq!(read.time_zone.as_deref(), Some("Europe/Copenhagen"));
        assert_eq!(
            read.location.as_ref().map(|l| l.human_readable.as_str()),
            Some("Nørrebro")
        );
        assert_eq!(read.tags, vec!["errands".to_owned()]);
        assert_eq!(read.modified, Some(read.created));

        // A device note publishes the text opened from its envelope and keeps
        // no server-held body.
        let sealed = EncryptedData {
            encryption_information: None,
            data: b"sealed".to_vec(),
        };
        let device = store
            .create_note(
                &principal,
                NewNote {
                    opened_text: Some("A Title Some Text".to_owned()),
                    ..NewNote::sealed(Some(sealed.clone()), None)
                },
            )
            .await
            .expect("write succeeds");
        let read = only_note(store, &principal, &device.uuid).await;
        assert_eq!(read.indexed_text.as_deref(), Some("a title some text"));
        assert_eq!(read.body, None);
        assert_eq!(read.source, Some(NoteSource::Device));
        assert_eq!(read.encrypted_note.map(|e| e.data), Some(sealed.data));
    }

    pub(crate) async fn update_note_refreshes_index_and_modified(store: &dyn Store) {
        let principal = fresh_principal("edit");
        let note = store
            .create_note(&principal, NewNote::text(NoteSource::Web, "Old Body"))
            .await
            .expect("write succeeds");
        let edited = store
            .update_note(&principal, &note.uuid, Some("New Title"), "Fresh Body")
            .await
            .expect("update succeeds")
            .expect("the note exists");
        assert_eq!(edited.title.as_deref(), Some("New Title"));
        assert_eq!(edited.body.as_deref(), Some("Fresh Body"));
        assert_eq!(edited.indexed_text.as_deref(), Some("new title fresh body"));
        assert!(edited.modified.expect("stamped") >= note.created);

        let read = only_note(store, &principal, &note.uuid).await;
        assert_eq!(read.body.as_deref(), Some("Fresh Body"));
        assert_eq!(read.modified, edited.modified);
        assert_eq!(read.created, note.created, "an edit is not a new note");

        let found = store
            .note_page(&principal, Some("FRESH"), 0, 10)
            .await
            .expect("search");
        assert_eq!(found.total, 1);
        let stale = store
            .note_page(&principal, Some("old body"), 0, 10)
            .await
            .expect("search");
        assert_eq!(stale.total, 0, "the old text is no longer indexed");

        assert!(
            store
                .update_note(&fresh_principal("other"), &note.uuid, None, "hijack")
                .await
                .expect("update runs")
                .is_none(),
            "another account's uuid matches nothing"
        );
        assert!(
            store
                .update_note(
                    &principal,
                    "00000000-0000-0000-0000-000000000000",
                    None,
                    "x"
                )
                .await
                .expect("update runs")
                .is_none()
        );
    }

    pub(crate) async fn note_page_query_filters_and_counts(store: &dyn Store) {
        let principal = fresh_principal("search");
        for body in ["Yellow Umbrella", "yellow raincoat", "Blue Kettle"] {
            store
                .create_note(&principal, NewNote::text(NoteSource::Assistant, body))
                .await
                .expect("write succeeds");
        }
        store
            .create_note(&principal, NewNote::sealed(None, None))
            .await
            .expect("write succeeds");
        let page = store
            .note_page(&principal, Some("  YELLOW "), 0, 1)
            .await
            .expect("search");
        assert_eq!(page.total, 2, "the total counts matches, not the window");
        assert_eq!(page.records.len(), 1);
        let all = store
            .note_page(&principal, Some("   "), 0, 10)
            .await
            .expect("list");
        assert_eq!(all.total, 4, "a blank query is no filter");
    }

    pub(crate) async fn pending_memory_create_upserts_and_clears_on_create_memory(
        store: &dyn Store,
    ) {
        let principal = fresh_principal("pending");
        let declare = |id: &str, reason: i32, at: i64| PendingMemoryCreate {
            device_local_id: id.to_owned(),
            memory_type: 1,
            delay_reason: reason,
            declared: SyncTime::from_parts(at, 0),
        };
        store
            .declare_pending_memory_create(&principal, &declare("cam-a", 1, 100))
            .await
            .expect("upsert");
        store
            .declare_pending_memory_create(&principal, &declare("cam-a", 0, 150))
            .await
            .expect("upsert");
        store
            .declare_pending_memory_create(&principal, &declare("cam-b", 1, 120))
            .await
            .expect("upsert");
        let pending = store
            .pending_memory_creates(&principal)
            .await
            .expect("list");
        assert_eq!(
            pending,
            vec![declare("cam-a", 0, 150), declare("cam-b", 1, 120)]
        );
        assert!(
            store
                .pending_memory_creates(&fresh_principal("other"))
                .await
                .expect("list")
                .is_empty()
        );

        store
            .create_memory(&principal, photo("cam-a"))
            .await
            .expect("create");
        assert_eq!(
            store
                .pending_memory_creates(&principal)
                .await
                .expect("list"),
            vec![declare("cam-b", 1, 120)],
            "CreateMemory for the same device-local id clears its pending row"
        );
        // The intent queue is APPEND-ordered and retried, so a declaration can
        // land after its capture. The capture is in the cloud: nothing pends.
        store
            .declare_pending_memory_create(&principal, &declare("cam-a", 1, 200))
            .await
            .expect("upsert");
        assert_eq!(
            store
                .pending_memory_creates(&principal)
                .await
                .expect("list"),
            vec![declare("cam-b", 1, 120)],
            "a late intent for a live capture records nothing"
        );
        assert_eq!(
            store
                .delete_all_pending_memory_creates(&principal)
                .await
                .expect("clear"),
            1
        );
        assert!(
            store
                .pending_memory_creates(&principal)
                .await
                .expect("list")
                .is_empty()
        );
    }

    pub(crate) async fn memory_favorite_filter_and_tags_round_trip(store: &dyn Store) {
        let principal = fresh_principal("favorite");
        let first = store.create_memory(&principal, photo("f-1")).await.unwrap();
        let second = store.create_memory(&principal, photo("f-2")).await.unwrap();
        store.create_memory(&principal, photo("f-3")).await.unwrap();

        assert_eq!(
            store
                .set_memory_favorite(
                    &fresh_principal("other"),
                    std::slice::from_ref(&first.uuid),
                    true,
                )
                .await
                .unwrap(),
            0,
            "another account's uuid matches nothing"
        );
        assert_eq!(
            store
                .set_memory_favorite(
                    &principal,
                    &[first.uuid.clone(), second.numeric_id.to_string()],
                    true,
                )
                .await
                .unwrap(),
            2
        );
        let favorites = store
            .memory_page(&principal, &[], true, 0, 10)
            .await
            .unwrap();
        assert_eq!(favorites.total, 2);
        assert!(favorites.records.iter().all(|summary| summary.favorite));
        assert_eq!(
            store
                .memory_page(&principal, &[], false, 0, 10)
                .await
                .unwrap()
                .total,
            3
        );
        store
            .set_memory_favorite(&principal, std::slice::from_ref(&second.uuid), false)
            .await
            .unwrap();
        let favorites = store
            .memory_page(&principal, &[MemoryKind::Photo], true, 0, 10)
            .await
            .unwrap();
        assert_eq!(favorites.total, 1);
        assert_eq!(favorites.records[0].uuid, first.uuid);

        for tag in ["cat", "cat", "pet"] {
            assert!(
                store
                    .add_memory_tag(&principal, &first.uuid, tag)
                    .await
                    .unwrap()
            );
        }
        assert!(
            store
                .remove_memory_tag(&principal, &first.uuid, "cat")
                .await
                .unwrap()
        );
        assert!(
            store
                .remove_memory_tag(&principal, &first.uuid, "absent")
                .await
                .unwrap()
        );
        let read = store
            .memory(&principal, &first.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read.tags, vec!["pet".to_owned()]);
        assert!(read.favorite);
        assert!(
            !store
                .add_memory_tag(&principal, "nope", "cat")
                .await
                .unwrap()
        );
        assert!(
            !store
                .add_memory_tag(&fresh_principal("other"), &first.uuid, "x")
                .await
                .unwrap()
        );
    }

    pub(crate) async fn capture_metadata_and_upload_state_round_trip(store: &dyn Store) {
        let principal = fresh_principal("metadata");
        let video = store
            .create_memory(
                &principal,
                NewMemory {
                    kind: MemoryKind::Video,
                    metadata: CaptureMetadata {
                        photo_metadatas: vec![ImageMetadata {
                            photo_filename: "frame-0.jpg".to_owned(),
                            resolution_width: 4032,
                            ..Default::default()
                        }],
                        format: 2,
                        lut_name: "natural".to_owned(),
                        encryption_kid: "kid-1".to_owned(),
                        num_videos: 1,
                        total_video_duration_sec: 12,
                    },
                    ..photo("clip-1")
                },
            )
            .await
            .unwrap();
        let read = store
            .memory(&principal, &video.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read.metadata.photo_metadatas.len(), 1);
        assert_eq!(
            read.metadata.photo_metadatas[0].photo_filename,
            "frame-0.jpg"
        );
        assert_eq!(read.metadata.photo_metadatas[0].resolution_width, 4032);
        assert_eq!(read.metadata.format, 2);
        assert_eq!(read.metadata.lut_name, "natural");
        assert_eq!(read.metadata.encryption_kid, "kid-1");
        assert_eq!(read.metadata.num_videos, 1);
        assert_eq!(read.upload_state, UploadState::Pending);
        let summary = store
            .memory_page(&principal, &[MemoryKind::Video], false, 0, 10)
            .await
            .unwrap();
        assert_eq!(summary.records[0].total_video_duration_sec, 12);
        assert_eq!(summary.records[0].upload_state, UploadState::Pending);

        assert!(
            store
                .record_upload_state(&principal, &video.uuid, UploadState::FailedFinal)
                .await
                .unwrap()
        );
        let read = store
            .memory(&principal, &video.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read.upload_state, UploadState::FailedFinal);
        assert!(!read.upload_complete);
        assert!(
            store
                .record_upload_state(
                    &principal,
                    &video.numeric_id.to_string(),
                    UploadState::Complete
                )
                .await
                .unwrap()
        );
        let read = store
            .memory(&principal, &video.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read.upload_state, UploadState::Complete);
        assert!(read.upload_complete);
        assert!(
            !store
                .record_upload_state(&principal, "nope", UploadState::Complete)
                .await
                .unwrap()
        );
    }

    async fn ingest_mixed(store: &dyn Store, principal: &str) {
        store
            .ingest_events(
                principal,
                &[
                    event("ask-1", "humane.respond", "humane.experience.answers", 100),
                    event("ask-2", "humane.respond", "hu.ma.ne.ironman", 200),
                    event(
                        "look-1",
                        "humane.respond.vision",
                        "humane.experience.vision",
                        300,
                    ),
                    event("web-1", "humane.respond", "luma.center", 400),
                    event(
                        "song-1",
                        "humane.playMusicTrack",
                        "humane.experience.music",
                        500,
                    ),
                ],
            )
            .await
            .expect("ingest");
    }

    pub(crate) async fn event_page_filters_by_type_set_and_reports_total(store: &dyn Store) {
        let principal = fresh_principal("events");
        ingest_mixed(store, &principal).await;
        let ai_mic = EventFilter {
            types: vec![
                "humane.respond".to_owned(),
                "humane.respond.vision".to_owned(),
            ],
            excluded_originators: vec!["luma.center".to_owned()],
            ..EventFilter::default()
        };
        let first = store
            .query_event_page(&principal, &ai_mic, 0, 2)
            .await
            .unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(
            first
                .records
                .iter()
                .map(|e| e.event_identifier.as_str())
                .collect::<Vec<_>>(),
            vec!["look-1", "ask-2"],
            "newest first"
        );
        let rest = store
            .query_event_page(&principal, &ai_mic, 2, 2)
            .await
            .unwrap();
        assert_eq!(rest.total, 3);
        assert_eq!(rest.records.len(), 1);
        assert_eq!(rest.records[0].event_identifier, "ask-1");
        let past_end = store
            .query_event_page(&principal, &ai_mic, 10, 2)
            .await
            .unwrap();
        assert_eq!((past_end.total, past_end.records.len()), (3, 0));

        let oldest = store
            .query_event_page(
                &principal,
                &EventFilter {
                    oldest_first: true,
                    ..ai_mic.clone()
                },
                0,
                10,
            )
            .await
            .unwrap();
        assert_eq!(
            oldest
                .records
                .iter()
                .map(|e| e.event_identifier.as_str())
                .collect::<Vec<_>>(),
            vec!["ask-1", "ask-2", "look-1"]
        );

        let window = store
            .query_event_page(
                &principal,
                &EventFilter {
                    originators: vec!["hu.ma.ne.ironman".to_owned(), "luma.center".to_owned()],
                    start: Some(SyncTime::from_parts(150, 0)),
                    end: Some(SyncTime::from_parts(350, 0)),
                    ..EventFilter::default()
                },
                0,
                10,
            )
            .await
            .unwrap();
        assert_eq!(window.total, 1);
        assert_eq!(window.records[0].event_identifier, "ask-2");
        assert_eq!(
            store
                .query_event_page(&fresh_principal("other"), &ai_mic, 0, 10)
                .await
                .unwrap()
                .total,
            0
        );
    }

    pub(crate) async fn event_counts_by_type_set_since(store: &dyn Store) {
        let principal = fresh_principal("counts");
        ingest_mixed(store, &principal).await;
        let responds = EventFilter {
            types: vec![
                "humane.respond".to_owned(),
                "humane.respond.vision".to_owned(),
            ],
            ..EventFilter::default()
        };
        assert_eq!(store.count_events(&principal, &responds).await.unwrap(), 4);
        assert_eq!(
            store
                .count_events(
                    &principal,
                    &EventFilter {
                        start: Some(SyncTime::from_parts(250, 0)),
                        ..responds.clone()
                    },
                )
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            store
                .count_events(&principal, &EventFilter::default())
                .await
                .unwrap(),
            5
        );
    }

    /// The Pin re-sends an event it never saw acknowledged. When that copy
    /// arrives while its key cannot be opened it carries no search index, and
    /// the index an earlier opened copy earned must survive it, or voice
    /// `recall_history` loses the event until a web read backfills it again.
    pub(crate) async fn a_resent_sealed_event_keeps_its_search_index(store: &dyn Store) {
        let principal = fresh_principal("resent");
        let mut opened = event("resent-1", "humane.respond", "hu.ma.ne.ironman", 10);
        opened.indexed_text = Some("what is the capital of france".to_owned());
        opened.encrypted_location = Some(EncryptedData {
            data: vec![31, 41, 59],
            ..Default::default()
        });
        store.ingest_events(&principal, &[opened]).await.unwrap();
        let resent = event("resent-1", "humane.respond", "hu.ma.ne.ironman", 10);
        store.ingest_events(&principal, &[resent]).await.unwrap();
        let stored = store
            .query_events(&principal, "humane.respond", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored[0].indexed_text.as_deref(),
            Some("what is the capital of france")
        );
        assert_eq!(
            stored[0]
                .encrypted_location
                .as_ref()
                .map(|location| location.data.as_slice()),
            Some([31, 41, 59].as_slice()),
            "a privacy-filtered retry must not erase existing history"
        );

        let mut reindexed = event("resent-1", "humane.respond", "hu.ma.ne.ironman", 10);
        reindexed.indexed_text = Some("a newer index".to_owned());
        store.ingest_events(&principal, &[reindexed]).await.unwrap();
        let stored = store
            .query_events(&principal, "humane.respond", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(stored[0].indexed_text.as_deref(), Some("a newer index"));
    }

    pub(crate) async fn event_feedback_upsert_and_delete_are_principal_scoped(store: &dyn Store) {
        let principal = fresh_principal("feedback");
        let other = fresh_principal("other");
        ingest_mixed(store, &principal).await;
        assert!(
            store
                .put_event_feedback(&principal, "ask-1", EventVote::Up)
                .await
                .unwrap()
        );
        assert!(
            !store
                .put_event_feedback(&other, "ask-1", EventVote::Down)
                .await
                .unwrap(),
            "another account cannot vote on this wearer's event"
        );
        assert!(
            !store
                .put_event_feedback(&principal, "never-ingested", EventVote::Up)
                .await
                .unwrap()
        );
        assert!(
            store
                .put_event_feedback(&principal, "ask-1", EventVote::Down)
                .await
                .unwrap()
        );
        store
            .put_event_feedback(&principal, "ask-2", EventVote::Up)
            .await
            .unwrap();
        let ids = vec!["ask-1".to_owned(), "ask-2".to_owned(), "look-1".to_owned()];
        let votes = store.event_feedback(&principal, &ids).await.unwrap();
        assert_eq!(votes.len(), 2);
        assert_eq!(votes.get("ask-1"), Some(&EventVote::Down));
        assert_eq!(votes.get("ask-2"), Some(&EventVote::Up));
        assert!(store.event_feedback(&other, &ids).await.unwrap().is_empty());

        assert!(!store.delete_event_feedback(&other, "ask-1").await.unwrap());
        assert!(
            store
                .delete_event_feedback(&principal, "ask-1")
                .await
                .unwrap()
        );
        assert!(
            !store
                .delete_event_feedback(&principal, "ask-1")
                .await
                .unwrap()
        );

        // Forgetting the event forgets the vote on it.
        assert!(store.delete_event(&principal, "ask-2").await.unwrap());
        assert!(
            store
                .event_feedback(&principal, &ids)
                .await
                .unwrap()
                .is_empty()
        );
    }

    fn index(identifier: &str, text: &str) -> EventSearchIndex {
        EventSearchIndex {
            event_identifier: identifier.to_owned(),
            indexed_text: text.to_owned(),
        }
    }

    /// A web read opened a sealed event and derived its index. The wearer
    /// forgot the event before the read wrote the index back. The write-back
    /// must land nowhere, never re-create the row, and it must never
    /// overwrite an index already stored or reach another account.
    pub(crate) async fn a_backfilled_index_never_resurrects_a_forgotten_event(store: &dyn Store) {
        let principal = fresh_principal("backfill");
        let other = fresh_principal("backfill-other");
        let mut indexed = event("kept-index", "humane.respond", "o", 30);
        indexed.indexed_text = Some("from ingest".to_owned());
        store
            .ingest_events(
                &principal,
                &[
                    event("sealed", "humane.respond", "o", 10),
                    event("forgotten", "humane.respond", "o", 20),
                    indexed,
                ],
            )
            .await
            .unwrap();
        assert!(store.delete_event(&principal, "forgotten").await.unwrap());

        let written = store
            .backfill_event_index(
                &principal,
                &[
                    index("sealed", "opened on the web"),
                    index("forgotten", "must not come back"),
                    index("kept-index", "a later read"),
                    index("never-ingested", "nothing"),
                ],
            )
            .await
            .unwrap();
        assert_eq!(written, 1, "only the live, unindexed event takes an index");
        assert_eq!(
            store
                .backfill_event_index(&other, &[index("sealed", "another account")])
                .await
                .unwrap(),
            0
        );

        let stored = store
            .query_events(&principal, "", "", None, None, 0)
            .await
            .unwrap();
        let by_id: HashMap<_, _> = stored
            .iter()
            .map(|event| {
                (
                    event.event_identifier.as_str(),
                    event.indexed_text.as_deref(),
                )
            })
            .collect();
        assert_eq!(by_id.len(), 2, "the forgotten event stays forgotten");
        assert_eq!(by_id["sealed"], Some("opened on the web"));
        assert_eq!(by_id["kept-index"], Some("from ingest"));
        assert!(
            store
                .query_events(&other, "", "", None, None, 0)
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// One note by uuid, for its owner only.
    pub(crate) async fn a_note_reads_back_by_uuid_for_its_owner_only(store: &dyn Store) {
        let principal = fresh_principal("note-get");
        let other = fresh_principal("note-get-other");
        let written = store
            .create_note(&principal, NewNote::text(NoteSource::Web, "Buy Milk"))
            .await
            .unwrap();
        store
            .create_note(&principal, NewNote::text(NoteSource::Web, "Another"))
            .await
            .unwrap();
        let read = store
            .note(&principal, &written.uuid)
            .await
            .unwrap()
            .expect("the note reads back by uuid");
        assert_eq!(read.uuid, written.uuid);
        assert_eq!(read.body.as_deref(), Some("Buy Milk"));
        assert!(store.note(&other, &written.uuid).await.unwrap().is_none());
        assert!(
            store
                .note(&principal, &Uuid::new_v4().to_string())
                .await
                .unwrap()
                .is_none()
        );
    }

    fn intent(device_local_id: &str, declared: i64) -> PendingMemoryCreate {
        PendingMemoryCreate {
            device_local_id: device_local_id.to_owned(),
            memory_type: 1,
            delay_reason: 1,
            declared: SyncTime::from_parts(declared, 0),
        }
    }

    /// Past [`MAX_PENDING_MEMORY_CREATES`] a declaration is still recorded and
    /// the oldest one goes.
    pub(crate) async fn the_pending_queue_keeps_the_newest_declarations(store: &dyn Store) {
        let principal = fresh_principal("pending-cap");
        for at in 0..=MAX_PENDING_MEMORY_CREATES as i64 {
            store
                .declare_pending_memory_create(&principal, &intent(&format!("cap-{at}"), at))
                .await
                .unwrap();
        }
        let pending = store.pending_memory_creates(&principal).await.unwrap();
        assert_eq!(pending.len(), MAX_PENDING_MEMORY_CREATES);
        assert_eq!(
            pending[0].device_local_id,
            format!("cap-{MAX_PENDING_MEMORY_CREATES}")
        );
        assert!(
            pending
                .iter()
                .all(|pending| pending.device_local_id != "cap-0"),
            "the oldest declaration is the one dropped"
        );
    }

    /// An intent and its `CreateMemory` arriving together, the Pin runs them
    /// on independent workers, never leave the capture listed as waiting.
    pub(crate) async fn a_racing_intent_never_outlives_its_capture(store: &dyn Store) {
        let principal = fresh_principal("pending-race");
        for round in 0..32 {
            let id = format!("race-{round}");
            let pending = intent(&id, round);
            let (declared, created) = tokio::join!(
                store.declare_pending_memory_create(&principal, &pending),
                store.create_memory(&principal, photo(&id)),
            );
            declared.unwrap();
            created.unwrap();
        }
        assert!(
            store
                .pending_memory_creates(&principal)
                .await
                .unwrap()
                .is_empty(),
            "every capture that reached the cloud is cleared from the waiting list"
        );
    }

    fn sealed_contact(bytes: &[u8]) -> EncryptedData {
        EncryptedData {
            data: bytes.to_vec(),
            encryption_information: None,
        }
    }

    /// Sealed contact rows go by their exact ciphertext, and only the named
    /// principal's.
    pub(crate) async fn sealed_contact_rows_are_removed_by_their_exact_ciphertext(
        store: &dyn Store,
    ) {
        let principal = fresh_principal("sealed-contacts");
        let other = fresh_principal("sealed-contacts-other");
        let list = pb::ContactList {
            encrypted_contacts: vec![sealed_contact(b"first"), sealed_contact(b"second")],
            encrypted_contacts_versions: vec![1, 1],
            ..pb::ContactList::default()
        };
        store.put_contacts(&principal, &list).await.unwrap();
        store.put_contacts(&other, &list).await.unwrap();

        let removed = store
            .delete_encrypted_contacts(
                &principal,
                &[sealed_contact(b"first"), sealed_contact(b"never stored")],
            )
            .await
            .unwrap();
        assert_eq!(removed, 1);
        let left = store.contacts(&principal).await.unwrap().encrypted;
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].data, sealed_contact(b"second"));
        assert_eq!(
            store.contacts(&other).await.unwrap().encrypted.len(),
            2,
            "another account's identical ciphertext is untouched"
        );
    }

    /// Account deletion: every row of one principal goes, contacts with their
    /// sealed copies and tombstones, live and tombstoned captures, pending
    /// captures, notes, events, votes, account blobs and its Pins'
    /// `#device:` status rows, while another principal holding the same data
    /// keeps all of it. A second purge is a no-op. Answers `(purged, kept)` so
    /// each backend can also look at its raw rows.
    pub(crate) async fn purge_account_removes_one_principal_and_nothing_else(
        store: &dyn Store,
    ) -> (String, String) {
        let gone = fresh_principal("purged");
        let kept = fresh_principal("kept");
        let contact = |first: &str| pb::Contact {
            name: Some(pb::Name {
                first_name: first.to_owned(),
                ..Default::default()
            }),
            ..Default::default()
        };
        for principal in [&gone, &kept] {
            let written = store
                .put_contacts(
                    principal,
                    &pb::ContactList {
                        contacts: vec![contact("Ada"), contact("Bo")],
                        encrypted_contacts: vec![EncryptedData {
                            data: b"sealed contact".to_vec(),
                            encryption_information: None,
                        }],
                        encrypted_contacts_versions: vec![1],
                    },
                )
                .await
                .unwrap();
            store
                .delete_contacts(principal, &[written[1].contact.id.clone()])
                .await
                .unwrap();
            store
                .create_memory(principal, photo("kept-photo"))
                .await
                .unwrap();
            let deleted = store
                .create_memory(principal, photo("deleted-photo"))
                .await
                .unwrap();
            assert!(store.delete_memory(principal, &deleted.uuid).await.unwrap());
            store
                .declare_pending_memory_create(
                    principal,
                    &PendingMemoryCreate {
                        device_local_id: "waiting".to_owned(),
                        memory_type: 1,
                        delay_reason: 0,
                        declared: SyncTime::now(),
                    },
                )
                .await
                .unwrap();
            store
                .create_note(principal, NewNote::text(NoteSource::Web, "a note"))
                .await
                .unwrap();
            store
                .ingest_events(
                    principal,
                    &[event("ask-1", "humane.respond", "hu.ma.ne.ironman", 10)],
                )
                .await
                .unwrap();
            assert!(
                store
                    .put_event_feedback(principal, "ask-1", EventVote::Up)
                    .await
                    .unwrap()
            );
            store
                .put_account_blob(principal, AccountBlobKind::PersonalDetails, b"details")
                .await
                .unwrap();
            store
                .put_account_blob(
                    &format!("{principal}#device:abc123"),
                    AccountBlobKind::DeviceStatus,
                    b"status",
                )
                .await
                .unwrap();
        }

        store.purge_account(&gone).await.expect("purge");
        store
            .purge_account(&gone)
            .await
            .expect("purging an account with nothing left is fine");

        let everything = EventFilter::default();
        let asked = ["ask-1".to_owned()];
        assert!(store.contacts(&gone).await.unwrap().is_empty());
        assert_eq!(store.count_memories(&gone, &[]).await.unwrap(), 0);
        assert!(
            store
                .pending_memory_creates(&gone)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.count_notes(&gone).await.unwrap(), 0);
        assert_eq!(store.count_events(&gone, &everything).await.unwrap(), 0);
        assert!(
            store
                .event_feedback(&gone, &asked)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .get_account_blob(&gone, AccountBlobKind::PersonalDetails)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .get_account_blob(
                    &format!("{gone}#device:abc123"),
                    AccountBlobKind::DeviceStatus
                )
                .await
                .unwrap(),
            None,
            "a Pin's status row goes with its account"
        );

        let untouched = store.contacts(&kept).await.unwrap();
        assert_eq!(untouched.contacts.len(), 1);
        assert_eq!(untouched.encrypted.len(), 1);
        assert_eq!(untouched.deletions.len(), 1);
        assert_eq!(store.count_memories(&kept, &[]).await.unwrap(), 1);
        assert_eq!(store.pending_memory_creates(&kept).await.unwrap().len(), 1);
        assert_eq!(store.count_notes(&kept).await.unwrap(), 1);
        assert_eq!(store.count_events(&kept, &everything).await.unwrap(), 1);
        assert_eq!(store.event_feedback(&kept, &asked).await.unwrap().len(), 1);
        assert!(
            store
                .get_account_blob(&kept, AccountBlobKind::PersonalDetails)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .get_account_blob(
                    &format!("{kept}#device:abc123"),
                    AccountBlobKind::DeviceStatus
                )
                .await
                .unwrap()
                .is_some()
        );
        (gone, kept)
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    /// Account deletion, and the in-memory store's own maps: nothing of the
    /// purged principal is left in them, tombstones included.
    #[tokio::test]
    async fn purge_account_removes_one_principal_and_nothing_else() {
        let store = fresh();
        let (gone, kept) =
            contract::purge_account_removes_one_principal_and_nothing_else(&store).await;
        assert!(!store.books.lock().unwrap().contains_key(&gone));
        assert!(!store.captures.lock().unwrap().contains_key(&gone));
        assert!(
            !store
                .account
                .lock()
                .unwrap()
                .keys()
                .any(|owner| owner.starts_with(&gone))
        );
        assert!(store.captures.lock().unwrap().contains_key(&kept));
    }

    #[tokio::test]
    async fn a_backfilled_index_never_resurrects_a_forgotten_event() {
        contract::a_backfilled_index_never_resurrects_a_forgotten_event(&fresh()).await;
    }

    #[tokio::test]
    async fn a_note_reads_back_by_uuid_for_its_owner_only() {
        contract::a_note_reads_back_by_uuid_for_its_owner_only(&fresh()).await;
    }

    #[tokio::test]
    async fn the_pending_queue_keeps_the_newest_declarations() {
        contract::the_pending_queue_keeps_the_newest_declarations(&fresh()).await;
    }

    #[tokio::test]
    async fn a_racing_intent_never_outlives_its_capture() {
        contract::a_racing_intent_never_outlives_its_capture(&fresh()).await;
    }

    #[tokio::test]
    async fn sealed_contact_rows_are_removed_by_their_exact_ciphertext() {
        contract::sealed_contact_rows_are_removed_by_their_exact_ciphertext(&fresh()).await;
    }

    fn fresh() -> MemoryStore {
        MemoryStore::default()
    }

    #[tokio::test]
    async fn search_notes_matches_inflections_and_ignores_stopwords() {
        contract::search_notes_matches_inflections_and_ignores_stopwords(&fresh()).await;
    }

    #[tokio::test]
    async fn create_note_keeps_original_case_and_lowercases_only_the_index() {
        contract::create_note_keeps_original_case_and_lowercases_only_the_index(&fresh()).await;
    }

    #[tokio::test]
    async fn update_note_refreshes_index_and_modified() {
        contract::update_note_refreshes_index_and_modified(&fresh()).await;
    }

    #[tokio::test]
    async fn note_page_query_filters_and_counts() {
        contract::note_page_query_filters_and_counts(&fresh()).await;
    }

    #[tokio::test]
    async fn pending_memory_create_upserts_and_clears_on_create_memory() {
        contract::pending_memory_create_upserts_and_clears_on_create_memory(&fresh()).await;
    }

    #[tokio::test]
    async fn memory_favorite_filter_and_tags_round_trip() {
        contract::memory_favorite_filter_and_tags_round_trip(&fresh()).await;
    }

    #[tokio::test]
    async fn capture_metadata_and_upload_state_round_trip() {
        contract::capture_metadata_and_upload_state_round_trip(&fresh()).await;
    }

    #[tokio::test]
    async fn event_page_filters_by_type_set_and_reports_total() {
        contract::event_page_filters_by_type_set_and_reports_total(&fresh()).await;
    }

    #[tokio::test]
    async fn event_counts_by_type_set_since() {
        contract::event_counts_by_type_set_since(&fresh()).await;
    }

    #[tokio::test]
    async fn event_feedback_upsert_and_delete_are_principal_scoped() {
        contract::event_feedback_upsert_and_delete_are_principal_scoped(&fresh()).await;
    }

    #[tokio::test]
    async fn a_resent_sealed_event_keeps_its_search_index() {
        contract::a_resent_sealed_event_keeps_its_search_index(&fresh()).await;
    }

    /// Everything this contract adds survives the in-memory store's snapshot,
    /// and a snapshot written before it existed still loads.
    #[tokio::test]
    async fn consolidation_state_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("cosmos-consolidation-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp state dir");
        let path = dir.join("state.json");
        let (note, memory) = {
            let store = MemoryStore::at_path(path.clone());
            let note = store
                .create_note(
                    "wearer",
                    NewNote {
                        title: Some("Kept Title".to_owned()),
                        time_zone: Some("UTC".to_owned()),
                        ..NewNote::text(NoteSource::Web, "Kept Body")
                    },
                )
                .await
                .unwrap();
            let memory = store
                .create_memory(
                    "wearer",
                    NewMemory {
                        kind: MemoryKind::Photo,
                        device_local_id: "kept".to_owned(),
                        bursts: 1,
                        files_per_burst: 1,
                        device_created_time: None,
                        gmt_offset: 0,
                        thumbnails: Vec::new(),
                        encrypted_location: None,
                        metadata: CaptureMetadata {
                            lut_name: "vivid".to_owned(),
                            ..CaptureMetadata::default()
                        },
                    },
                )
                .await
                .unwrap();
            store
                .set_memory_favorite("wearer", std::slice::from_ref(&memory.uuid), true)
                .await
                .unwrap();
            store
                .add_memory_tag("wearer", &memory.uuid, "trip")
                .await
                .unwrap();
            store
                .record_upload_state("wearer", &memory.uuid, UploadState::FailedFinal)
                .await
                .unwrap();
            store
                .declare_pending_memory_create(
                    "wearer",
                    &PendingMemoryCreate {
                        device_local_id: "waiting".to_owned(),
                        memory_type: 2,
                        delay_reason: 1,
                        declared: SyncTime::from_parts(9, 0),
                    },
                )
                .await
                .unwrap();
            store
                .ingest_events(
                    "wearer",
                    &[NotableEventRecord {
                        event_identifier: "ev".to_owned(),
                        originator_identifier: "o".to_owned(),
                        creation_time: None,
                        event_type: "t".to_owned(),
                        event_data: None,
                        encrypted_event_data: None,
                        encrypted_location: None,
                        device_is_locked: false,
                        ingested: SyncTime::now(),
                        indexed_text: None,
                    }],
                )
                .await
                .unwrap();
            store
                .put_event_feedback("wearer", "ev", EventVote::Up)
                .await
                .unwrap();
            (note, memory)
        };

        let restored = MemoryStore::at_path(path.clone());
        let notes = restored.note_page("wearer", None, 0, 10).await.unwrap();
        let read = &notes.records[0];
        assert_eq!(read.uuid, note.uuid);
        assert_eq!(read.title.as_deref(), Some("Kept Title"));
        assert_eq!(read.body.as_deref(), Some("Kept Body"));
        assert_eq!(read.source, Some(NoteSource::Web));
        assert_eq!(read.time_zone.as_deref(), Some("UTC"));
        assert_eq!(read.modified, note.modified);
        let read = restored
            .memory("wearer", &memory.uuid)
            .await
            .unwrap()
            .unwrap();
        assert!(read.favorite);
        assert_eq!(read.tags, vec!["trip".to_owned()]);
        assert_eq!(read.upload_state, UploadState::FailedFinal);
        assert_eq!(read.metadata.lut_name, "vivid");
        assert_eq!(
            restored
                .pending_memory_creates("wearer")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            restored
                .event_feedback("wearer", &["ev".to_owned()])
                .await
                .unwrap()
                .get("ev"),
            Some(&EventVote::Up)
        );

        // A snapshot from before these fields existed still loads, with the
        // legacy capture's state read through `upload_complete`.
        let legacy = serde_json::json!({
            "captures": [["old", {
                "memories": [{
                    "uuid": "m", "numeric_id": 1, "device_local_id": "d", "kind": 0,
                    "device_created": null, "gmt_offset": 0, "thumbnails": [],
                    "encrypted_location": null, "bursts": [], "upload_complete": true,
                    "deleted": null, "created": [1, 0]
                }],
                "notes": [{
                    "uuid": "n", "indexed_text": "legacy", "note": null,
                    "location": null, "created": [1, 0]
                }],
                "events": [],
                "next_id": 1
            }]]
        });
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let restored = MemoryStore::at_path(path);
        let old = restored.memory("old", "m").await.unwrap().unwrap();
        assert_eq!(old.upload_state, UploadState::Complete);
        assert!(!old.favorite);
        let old_note = &restored
            .note_page("old", None, 0, 10)
            .await
            .unwrap()
            .records[0];
        assert_eq!(old_note.source, None);
        assert_eq!(old_note.modified, None);
        assert_eq!(old_note.body, None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
