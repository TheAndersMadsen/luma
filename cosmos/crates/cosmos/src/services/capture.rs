//! `humane.capture.CaptureService` + `humane.capture.TestingAutomationService`
//! — memory capture (photos/videos/notes/food logs), asset upload orchestration,
//! share links, and the test-automation note surface.
//!
//! Stock-faithful degradation: a real carry account with no stored memories
//! returns *well-formed empty* for reads, so a device's capture and note flows
//! advance instead of erroring out.
//!
//! Writes and deletes are NOT success-shaped acks — they are carried out and
//! then reported. `DeleteMemory` answers SUCCESS only when something was
//! actually tombstoned, NOT_FOUND when the principal holds no such capture, and
//! FAILURE (the one retryable arm) when the store could not do it.
//! `UploadComplete` records completion and answers ACKNOWLEDGED only when that
//! write landed. The distinction is load-bearing in both handlers because
//! `DeleteUploadWorkerImpl` and `AssetUploadWorkerImpl` drop their local row on
//! the fatal arms: a failure reported as "not found" makes the wearer's device
//! forget a capture the cloud still holds, or strands an asset permanently.
//!
//! Share/upload URLs are only returned when clone-owned HTTP endpoints are
//! configured. An absent or malformed endpoint is reported as an unavailable
//! capability instead of handing the device a success-shaped URL that cannot
//! work.
//!
//! **Object storage is served by the clone itself.** The device PUTs the asset
//! straight to the URL `UploadFile` returns
//! (`AssetUploadWorkerImpl.putFileOrBytes`), so it cannot be a presigned
//! S3/Azure URL we hold no credentials for — [`CaptureObjectStore`] receives the
//! bytes on this workload's own HTTP listener (see `crate::http`) and
//! [`Capture::upload_bytes_landed`] reads the resulting objects back before any
//! completion is acknowledged. The URL carries a fresh unguessable capability,
//! never a derived-from-content token: a hashed filename would let anyone who
//! could name a slot mint their own write URL.
//!
//! Two properties are load-bearing and not incidental:
//!
//! * When no storage is configured, `UploadFile` reports the missing capability
//!   as UNIMPLEMENTED, which the device's upload worker treats as a bounded,
//!   per-item failure. The frames stay on the pin and the retry loop terminates
//!   instead of running forever.
//! * `UploadComplete` acknowledges a claimed UPLOAD_SUCCESS only after reading
//!   the stored objects back, because an acknowledgement is what makes the
//!   device delete its own copy. See [`AssetArrival`].
//!
//! `GetCaptureConfig` is *server* configuration (not per-device data): a real
//! carry always returns real numbers, so we serve a small functional default set
//! (as `featureflags` does) instead of zeros that would tell the camera to shoot
//! zero photos per burst.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant, SystemTime},
};

use aes_gcm::aead::{Aead as _, KeyInit as _};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use cosmos_protocol::capture as pb;
use cosmos_protocol::common::food::{FoodLog, FoodLogSummary, NutrientType};
use pb::capture_service_server::CaptureService;
use pb::testing_automation_service_server::TestingAutomationService;
use prost::Message as _;
use reqwest::Url;
use sha2::{Digest as _, Sha256};
use tonic::{Request, Response, Status};

const SHARE_BASE_URL_ENV: &str = "CARRY_CAPTURE_SHARE_BASE_URL";
const SHARE_TOKEN_SECRET_ENV: &str = "CARRY_SHARE_TOKEN_SECRET";
pub(crate) const UPLOAD_BASE_URL_ENV: &str = "CARRY_CAPTURE_UPLOAD_BASE_URL";

/// Explicit object-storage root. Unset falls back to the durable state dir.
const STORAGE_DIR_ENV: &str = "CARRY_CAPTURE_STORAGE_DIR";
/// The durability switch every workload already honours; a named docker volume
/// is mounted there. Captures land in a subdirectory of it.
const STATE_DIR_ENV: &str = "CARRY_STATE_DIR";
/// Largest single asset body accepted, in bytes.
const MAX_UPLOAD_BYTES_ENV: &str = "CARRY_CAPTURE_MAX_UPLOAD_BYTES";
/// Which workload hosts `CaptureService`. Only that one serves capture objects,
/// so the other six never expose a write endpoint at all.
const WORKLOAD_ENV: &str = "CARRY_WORKLOAD";
/// How long an interrupted upload fragment may sit in staging, in seconds.
const INCOMING_TTL_ENV: &str = "CARRY_CAPTURE_INCOMING_TTL_SECS";
/// Opt-in age bound on the wearer's STORED FRAMES, in days. Unset keeps them
/// forever — see [`Retention`].
const OBJECT_RETENTION_DAYS_ENV: &str = "CARRY_CAPTURE_RETENTION_DAYS";

/// A generous ceiling for one encrypted frame or short video, small enough that
/// an authenticated device cannot fill the volume with one request.
const DEFAULT_MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MIN_MAX_UPLOAD_BYTES: usize = 1024 * 1024;
const MAX_MAX_UPLOAD_BYTES: usize = 1024 * 1024 * 1024;
const MIN_PROTOBUF_TIMESTAMP_SECONDS: i64 = -62_135_596_800;
const MAX_PROTOBUF_TIMESTAMP_SECONDS: i64 = 253_402_300_799;
const MAX_FOOD_LOGS: usize = 512;
const MAX_FOOD_LOG_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_FOOD_LOG_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_FOOD_LOG_SUMMARY_BYTES: usize = MAX_FOOD_LOG_TOTAL_BYTES + 64 * 1024;
const MAX_FOOD_ITEM_NAME_BYTES: usize = 256;
const MAX_FOOD_ITEM_BRAND_BYTES: usize = 128;
const MAX_FOOD_ITEM_SERVING_BYTES: usize = 64;
const MAX_FOOD_ITEM_REQUEST_UUID_BYTES: usize = 128;
const MAX_FOOD_NUTRIENTS: usize = 64;
const MAX_FOOD_NUMERIC_VALUE: f32 = 10_000_000.0;
const FOOD_LOG_CAS_RETRIES: usize = 32;
const SHARE_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

/// How long a minted upload capability stays usable. The device PUTs
/// immediately after `UploadFile` returns (`uploadIndividualAsset` chains the
/// two), so this only has to cover a slow uplink — not a queued retry, which
/// asks for a fresh URL of its own.
const UPLOAD_GRANT_TTL: Duration = Duration::from_secs(15 * 60);

/// Ceiling on outstanding capabilities, so a device that asks for URLs it never
/// uses cannot grow this map without bound.
const MAX_OUTSTANDING_GRANTS: usize = 4096;

/// Staging directory for in-progress writes, inside the storage root. A
/// principal directory can never collide with it: those are base64url, which
/// has no `.`.
const INCOMING_DIR: &str = ".incoming";

/// Longest single path segment accepted in a slot filename.
const MAX_SLOT_SEGMENT_LEN: usize = 128;

/// How long an abandoned `{token}.part` fragment is kept before it is swept.
///
/// A fragment is worthless the moment its write was interrupted, so this only
/// has to comfortably exceed one slow PUT. A day is far past
/// [`UPLOAD_GRANT_TTL`], which means a fragment belonging to a transfer that is
/// still live can never be old enough to sweep.
const DEFAULT_INCOMING_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// A staging TTL shorter than a capability's own lifetime could sweep a
/// fragment out from under a transfer still in flight.
const MIN_INCOMING_TTL: Duration = UPLOAD_GRANT_TTL;
const MAX_INCOMING_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Floor on an opted-in capture retention, so a mistyped value cannot turn into
/// "expire the wearer's photographs within the hour".
const MIN_OBJECT_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

/// How often a sweep may run. Sweeping is opportunistic — it rides on an
/// authorized upload rather than a scheduler thread — so this is what keeps a
/// busy workload from walking the volume on every PUT.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// What this store is allowed to remove on its own initiative.
///
/// The asymmetry is the whole point. `incoming_ttl` bounds the SERVER'S OWN
/// transient artefacts — `{token}.part` fragments left behind when a PUT died
/// mid-write — which nothing will ever read again and which otherwise grow
/// without bound on the volume. `object_max_age` bounds the WEARER'S FRAMES,
/// and is therefore `None` unless an operator sets it: a server that quietly
/// expires photographs on a timer is destroying data nobody asked it to
/// destroy, and the pin has already deleted its own copy by then
/// (`AssetUploadWorkerImpl.handleUploadSuccess` →
/// `mFileSystem.deleteDirectory(captureDirectory())`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Retention {
    /// Age after which an interrupted staging fragment is swept.
    incoming_ttl: Duration,
    /// Age after which a stored capture object is removed. `None` — the
    /// default — keeps the wearer's frames indefinitely.
    object_max_age: Option<Duration>,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            incoming_ttl: DEFAULT_INCOMING_TTL,
            object_max_age: None,
        }
    }
}

impl Retention {
    /// Read the policy from configured strings.
    ///
    /// An absent or unparseable value falls back to the conservative default in
    /// both fields; in particular a garbled `CARRY_CAPTURE_RETENTION_DAYS` means
    /// "keep the frames", never "expire them on some guessed schedule".
    fn resolve(
        incoming_ttl_seconds: Option<String>,
        object_retention_days: Option<String>,
    ) -> Self {
        let incoming_ttl = incoming_ttl_seconds
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_INCOMING_TTL)
            .clamp(MIN_INCOMING_TTL, MAX_INCOMING_TTL);

        // Zero reads as "unset" the same way proto3's absent scalar does, and is
        // the value an operator writes to turn expiry back off.
        let object_max_age = object_retention_days
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|days| *days > 0)
            .map(|days| {
                Duration::from_secs(days.saturating_mul(24 * 60 * 60)).max(MIN_OBJECT_RETENTION)
            });
        if object_max_age.is_some() {
            tracing::warn!(
                "capture retention is enabled: stored frames will be removed once they age out"
            );
        }

        Self {
            incoming_ttl,
            object_max_age,
        }
    }
}

/// The object sink for a wearer's captured frames.
///
/// This is deliberately not a general file server. There is no read route, no
/// listing, and no way to name a destination: the only thing a caller presents
/// is an opaque capability minted by `UploadFile` for one authenticated
/// principal and one server-allocated slot, and the destination path is derived
/// from *that*, never from the request.
pub(crate) struct CaptureObjectStore {
    root: PathBuf,
    max_bytes: usize,
    ttl: Duration,
    /// Outstanding upload capabilities. In memory on purpose: a capability is
    /// short-lived and a restart should invalidate every one of them.
    grants: Mutex<HashMap<String, UploadGrant>>,
    /// What may be removed on the store's own initiative.
    retention: Retention,
    /// How often a sweep may run. Always [`SWEEP_INTERVAL`] in production; tests
    /// zero it so a sweep is observable without waiting an hour.
    sweep_interval: Duration,
    /// When the last sweep ran, so sweeping cannot ride on every single PUT.
    /// `None` until the first one, which makes a fresh process sweep once.
    last_sweep: Mutex<Option<Instant>>,
}

/// One minted write capability: who may use it, and for which slot.
struct UploadGrant {
    principal: String,
    slot: String,
    expires_at: Instant,
}

/// Why a PUT was refused. Deliberately coarse — the HTTP layer must not let a
/// caller tell "no such token" from "expired" from "already used".
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UploadRejection {
    /// Unknown, expired, or already-consumed capability.
    Unauthorized,
    /// The body was empty, so there is nothing to store.
    Empty,
    /// The body exceeded the configured ceiling.
    TooLarge,
    /// The bytes could not be durably written.
    Storage,
}

impl CaptureObjectStore {
    fn new(root: PathBuf, max_bytes: usize, ttl: Duration, retention: Retention) -> Self {
        Self {
            root,
            max_bytes,
            ttl,
            grants: Mutex::new(HashMap::new()),
            retention,
            sweep_interval: SWEEP_INTERVAL,
            last_sweep: Mutex::new(None),
        }
    }

    /// A store on a private temporary root, removed when the last handle drops.
    /// Used by tests so the real upload path can be exercised without mutating
    /// process-global environment.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Arc<Self> {
        Self::for_tests_with_limit(DEFAULT_MAX_UPLOAD_BYTES)
    }

    #[cfg(test)]
    pub(crate) fn for_tests_with_limit(max_bytes: usize) -> Arc<Self> {
        Arc::new(Self::new(
            temporary_root(),
            max_bytes,
            UPLOAD_GRANT_TTL,
            Retention::default(),
        ))
    }

    /// Test-only: how long a minted capability lives, so expiry is testable
    /// without sleeping for the production TTL.
    #[cfg(test)]
    pub(crate) fn for_tests_with_ttl(ttl: Duration) -> Arc<Self> {
        Arc::new(Self::new(
            temporary_root(),
            DEFAULT_MAX_UPLOAD_BYTES,
            ttl,
            Retention::default(),
        ))
    }

    /// Test-only: an explicit retention policy, with the sweep rate limit
    /// removed so every upload sweeps. Otherwise a test would have to wait out
    /// [`SWEEP_INTERVAL`] to observe the second one.
    #[cfg(test)]
    fn for_tests_with_retention(retention: Retention) -> Arc<Self> {
        let mut store = Self::new(
            temporary_root(),
            DEFAULT_MAX_UPLOAD_BYTES,
            UPLOAD_GRANT_TTL,
            retention,
        );
        store.sweep_interval = Duration::ZERO;
        Arc::new(store)
    }

    #[cfg(test)]
    fn retention(&self) -> Retention {
        self.retention
    }

    #[cfg(test)]
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Mint a capability directly, for tests that exercise the HTTP half
    /// without going through `UploadFile` first.
    #[cfg(test)]
    pub(crate) fn grant_for_tests(&self, principal: &str, slot: &str) -> String {
        self.grant(principal, slot)
    }

    /// Where a slot's bytes should be, so a test can read them back and check
    /// them byte for byte rather than trusting `holds`.
    #[cfg(test)]
    pub(crate) fn object_path_for_tests(&self, principal: &str, slot: &str) -> Option<PathBuf> {
        self.object_path(principal, slot)
    }

    pub(crate) fn max_upload_bytes(&self) -> usize {
        self.max_bytes
    }

    /// Mint a fresh capability for `principal` to write exactly `slot`.
    ///
    /// The token is 32 bytes from the OS CSPRNG. It is NOT derived from the
    /// filename, the principal, or anything else a caller could reconstruct:
    /// the URL is the credential, so a guessable one is an unauthenticated
    /// write endpoint wearing a token's clothes.
    fn grant(&self, principal: &str, slot: &str) -> String {
        let bytes: [u8; 32] = rand::random();
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        grants.retain(|_, grant| grant.expires_at > now);
        while grants.len() >= MAX_OUTSTANDING_GRANTS {
            let Some(oldest) = grants
                .iter()
                .min_by_key(|(_, grant)| grant.expires_at)
                .map(|(token, _)| token.clone())
            else {
                break;
            };
            grants.remove(&oldest);
        }
        grants.insert(
            token.clone(),
            UploadGrant {
                principal: principal.to_owned(),
                slot: slot.to_owned(),
                expires_at: now + self.ttl,
            },
        );
        token
    }

    /// Mint a one-shot upload capability for a message attachment.
    ///
    /// Attachments share the capture sink and its size, durability, expiry and
    /// single-use rules, but receive a server-owned path. The client-supplied
    /// filename contributes only a short alphanumeric extension so it can never
    /// select a destination or escape the storage root.
    pub(crate) fn grant_message_attachment(&self, principal: &str, filename: &str) -> String {
        let extension = std::path::Path::new(filename)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 12
                    && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
            .map(|value| format!(".{value}"))
            .unwrap_or_default();
        let group = uuid::Uuid::new_v4();
        let object = uuid::Uuid::new_v4();
        let slot = format!("message-attachments/{group}/{object}{extension}");
        self.grant(principal, &slot)
    }

    /// Resolve a capability, or reject it. Expired entries are dropped here so
    /// an expired token behaves exactly like an unknown one.
    fn resolve(&self, token: &str) -> Result<(String, String), UploadRejection> {
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        match grants.get(token) {
            Some(grant) if grant.expires_at > now => {
                Ok((grant.principal.clone(), grant.slot.clone()))
            }
            Some(_) => {
                grants.remove(token);
                Err(UploadRejection::Unauthorized)
            }
            None => Err(UploadRejection::Unauthorized),
        }
    }

    /// Take one asset's bytes.
    ///
    /// `declared_slot` is the device's `file:` header
    /// (`AssetUploadWorkerImpl.putFileOrBytes` sends the server filename there).
    /// It is only ever *checked* against the capability — the destination comes
    /// from the capability, so a mismatched or hostile header cannot redirect a
    /// write.
    pub(crate) async fn accept(
        &self,
        token: &str,
        declared_slot: Option<&str>,
        body: &[u8],
    ) -> Result<(), UploadRejection> {
        // Authorize before saying anything about the body, so an unauthenticated
        // prober cannot learn size limits or emptiness rules from the response.
        let (principal, slot) = self.resolve(token)?;
        // Only ever behind an authorized capability: an unauthenticated prober
        // must not be able to make this workload walk its volume.
        self.maybe_sweep().await;
        if declared_slot.is_some_and(|declared| declared != slot) {
            return Err(UploadRejection::Unauthorized);
        }
        if body.len() > self.max_bytes {
            return Err(UploadRejection::TooLarge);
        }
        if body.is_empty() {
            return Err(UploadRejection::Empty);
        }

        let path = self
            .object_path(&principal, &slot)
            .ok_or(UploadRejection::Storage)?;
        self.write_object(&path, token, body).await?;

        // Single use: a capability buys exactly one stored object. A device that
        // needs to re-upload asks `UploadFile` for a new one, which it already
        // does on every retry.
        self.grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token);
        Ok(())
    }

    /// Whether this store holds bytes for `slot` under `principal`.
    ///
    /// Reading the filesystem rather than remembering an in-process fact is
    /// deliberate: if a write was lost to a crash between the PUT and
    /// `UploadComplete`, the honest answer is "not here", and the device keeps
    /// its copy.
    pub(crate) async fn holds(&self, principal: &str, slot: &str) -> bool {
        let Some(path) = self.object_path(principal, slot) else {
            return false;
        };
        tokio::fs::metadata(path)
            .await
            .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
    }

    /// Read one committed object for an authenticated projection.
    ///
    /// The caller supplies a slot allocated in that principal's own memory
    /// record. `object_path` re-validates it and roots it below the principal's
    /// directory. The upload ceiling is enforced again before allocation so a
    /// file enlarged outside this process cannot turn a web read into an
    /// unbounded allocation.
    pub(crate) async fn read(
        &self,
        principal: &str,
        slot: &str,
    ) -> std::io::Result<Option<Vec<u8>>> {
        let Some(path) = self.object_path(principal, slot) else {
            return Ok(None);
        };
        let metadata = match tokio::fs::metadata(&path).await {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => metadata,
            Ok(_) => return Ok(None),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if metadata.len() > self.max_bytes as u64 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "stored capture object exceeds configured maximum",
            ));
        }
        tokio::fs::read(path).await.map(Some)
    }

    /// Copy one committed object into a server-allocated slot owned by another
    /// wearer. Shared-memory save uses this after it has created the recipient's
    /// metadata row; the destination is never chosen by the caller.
    pub(crate) async fn copy(
        &self,
        source_principal: &str,
        source_slot: &str,
        destination_principal: &str,
        destination_slot: &str,
    ) -> std::io::Result<bool> {
        let Some(bytes) = self.read(source_principal, source_slot).await? else {
            return Ok(false);
        };
        let token = self.grant(destination_principal, destination_slot);
        self.accept(&token, Some(destination_slot), &bytes)
            .await
            .map_err(|_| std::io::Error::other("shared capture object could not be stored"))?;
        Ok(true)
    }

    /// Read the small, clone-authored best-frame projection for one capture.
    ///
    /// This is metadata only: the device still uploads and retains every frame.
    /// Keeping it beside the capture objects makes the selection durable without
    /// changing the stock memory schema or copying wearer image bytes.
    pub(crate) async fn read_best_frame(
        &self,
        principal: &str,
        memory_uuid: &str,
    ) -> std::io::Result<Option<crate::capture_ranking::BestFrameSelection>> {
        let Some(path) = self.best_frame_path(principal, memory_uuid) else {
            return Ok(None);
        };
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) if bytes.len() <= 4096 => bytes,
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "best-frame metadata exceeds its bound",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid best-frame metadata",
            )
        })
    }

    /// Atomically persist which already-stored frame Center should present.
    pub(crate) async fn write_best_frame(
        &self,
        principal: &str,
        memory_uuid: &str,
        selection: &crate::capture_ranking::BestFrameSelection,
    ) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt as _;

        let path = self
            .best_frame_path(principal, memory_uuid)
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid memory uuid")
            })?;
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("best-frame path has no parent"))?;
        tokio::fs::create_dir_all(parent).await?;
        restrict_directory(parent).await;
        let staging = parent.join(format!(".best-frame.{}.part", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(selection)
            .map_err(|_| std::io::Error::other("best-frame metadata could not be encoded"))?;
        let write = async {
            let mut file = tokio::fs::File::create(&staging).await?;
            restrict_file(&staging).await;
            file.write_all(&bytes).await?;
            file.flush().await?;
            file.sync_all().await?;
            tokio::fs::rename(&staging, &path).await
        }
        .await;
        if write.is_err() {
            let _ = tokio::fs::remove_file(staging).await;
        }
        write
    }

    /// Select and persist the hero frame for one uploaded stock photo burst.
    ///
    /// `implemented`: this is the clean-room server-side replacement for the
    /// recovered `best_photo` behavior. It deliberately operates on thumbnails
    /// already uploaded to Carry, never removes an original, and rechecks the
    /// sidecar after the model returns so a concurrent wearer selection wins.
    pub(crate) async fn rank_photo_best_frame(
        &self,
        keys: &crate::keydirectory::SharedKeyDirectory,
        principal: &str,
        record: &crate::store::MemoryRecord,
        force_automatic: bool,
    ) -> std::io::Result<Option<crate::capture_ranking::BestFrameSelection>> {
        use crate::store::MemoryKind;

        if record.kind != MemoryKind::Photo || record.thumbnails.is_empty() {
            return Ok(None);
        }
        if let Some(existing) = self.read_best_frame(principal, &record.uuid).await? {
            if !force_automatic || existing.method == "manual" {
                return Ok(Some(existing));
            }
        }

        // A frame we cannot open is skipped, but never silently: ranking that
        // sees no frames answers "no opened thumbnails are available", which
        // reads to an operator as "this burst is empty" when the real cause is a
        // channel key that was never imported — or one that lives in another
        // process because this directory is memory-only. `shared` is the field
        // that separates those two. The kid is NOT logged: it carries the
        // wearer's device and user ids (see `services/events.rs`).
        let mut opened = Vec::new();
        let mut unopenable = 0usize;
        for (index, sealed) in record.thumbnails.iter().enumerate() {
            let kid = sealed
                .encryption_information
                .as_ref()
                .map(|information| information.kid.as_str())
                .unwrap_or_default();
            let Some(key) = keys.get(kid).await else {
                unopenable += 1;
                tracing::warn!(
                    memory = %record.uuid,
                    index,
                    shared = keys.is_shared(),
                    "no channel key for this thumbnail; it cannot be ranked"
                );
                continue;
            };
            if let Ok(jpeg) = cosmos_crypto::secure_asset::open_secure_asset(
                &key,
                kid,
                &sealed.data,
                cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
            ) {
                opened.push((index, jpeg));
            } else {
                unopenable += 1;
                tracing::warn!(
                    memory = %record.uuid,
                    index,
                    shared = keys.is_shared(),
                    "held the key but this thumbnail did not open; it cannot be ranked"
                );
            }
        }
        if opened.is_empty() {
            if unopenable > 0 {
                tracing::warn!(
                    memory = %record.uuid,
                    frames = unopenable,
                    shared = keys.is_shared(),
                    "no thumbnail of this capture could be opened, so no best frame was selected"
                );
            }
            return Ok(None);
        }

        self.rank_opened_best_frame(principal, &record.uuid, opened, force_automatic)
            .await
    }

    /// Rank already-opened thumbnails while retaining their stock ordinals.
    /// Kept as a seam so selection, persistence, and wearer-wins race behavior
    /// can be regression-tested without manufacturing a private HMSA fixture.
    async fn rank_opened_best_frame(
        &self,
        principal: &str,
        memory_uuid: &str,
        opened: Vec<(usize, Vec<u8>)>,
        force_automatic: bool,
    ) -> std::io::Result<Option<crate::capture_ranking::BestFrameSelection>> {
        if opened.is_empty() {
            return Ok(None);
        }

        let images = opened
            .iter()
            .map(|(_, bytes)| bytes.clone())
            .collect::<Vec<_>>();
        let Some(mut selection) = crate::capture_ranking::choose_best_frame(&images).await else {
            return Ok(None);
        };
        selection.frame = opened[selection.frame].0;

        // The vision request can take seconds. Center may receive a manual
        // choice while it runs; the wearer always wins that race.
        if let Some(existing) = self.read_best_frame(principal, memory_uuid).await? {
            if existing.method == "manual" || !force_automatic {
                return Ok(Some(existing));
            }
        }
        self.write_best_frame(principal, memory_uuid, &selection)
            .await?;
        Ok(Some(selection))
    }

    /// Where one slot's bytes live: `{root}/{principal}/{memory}/{burst}/{file}`.
    ///
    /// `slot_shape` is re-applied here even though `UploadFile` already checked
    /// it, because this is the function that turns a string into a path. Every
    /// segment is non-empty, is not `.` or `..`, and contains no separator or
    /// control character, so the result cannot escape `root`. The principal
    /// becomes one base64url segment: injective (two wearers can never share a
    /// directory) and free of anything a filesystem treats specially.
    fn object_path(&self, principal: &str, slot: &str) -> Option<PathBuf> {
        slot_shape(slot)?;
        let mut path = self.root.join(principal_directory(principal));
        for segment in slot.split('/') {
            path.push(segment);
        }
        Some(path)
    }

    fn best_frame_path(&self, principal: &str, memory_uuid: &str) -> Option<PathBuf> {
        safe_slot_segment(memory_uuid)?;
        Some(
            self.root
                .join(principal_directory(principal))
                .join(memory_uuid)
                .join(".best-frame.json"),
        )
    }

    /// Write the bytes so that the object is either entirely there or not there
    /// at all: staged, fsynced, then renamed into place. A half-written frame
    /// that `holds` reported as present would be acknowledged, and the device
    /// would delete the only good copy.
    async fn write_object(
        &self,
        path: &Path,
        token: &str,
        body: &[u8],
    ) -> Result<(), UploadRejection> {
        use tokio::io::AsyncWriteExt as _;

        let parent = path.parent().ok_or(UploadRejection::Storage)?;
        let incoming = self.root.join(INCOMING_DIR);
        for directory in [parent, incoming.as_path()] {
            tokio::fs::create_dir_all(directory)
                .await
                .map_err(|error| {
                    tracing::warn!(%error, "capture object storage is not writable");
                    UploadRejection::Storage
                })?;
            restrict_directory(directory).await;
        }

        // The token is one we minted (`resolve` succeeded), so it is 43 chars of
        // base64url and safe as a filename.
        let staging = incoming.join(format!("{token}.part"));
        let staged = async {
            let mut file = tokio::fs::File::create(&staging).await?;
            restrict_file(&staging).await;
            file.write_all(body).await?;
            file.flush().await?;
            file.sync_all().await
        }
        .await;
        if let Err(error) = staged {
            tracing::warn!(%error, "capture asset could not be staged");
            let _ = tokio::fs::remove_file(&staging).await;
            return Err(UploadRejection::Storage);
        }
        if let Err(error) = tokio::fs::rename(&staging, path).await {
            tracing::warn!(%error, "capture asset could not be committed");
            let _ = tokio::fs::remove_file(&staging).await;
            return Err(UploadRejection::Storage);
        }
        Ok(())
    }

    /// Unlink the stored bytes for `slots`, and prune whatever directories that
    /// leaves empty. `true` when nothing of theirs remains on disk.
    ///
    /// This is what makes a deletion a deletion. `DeleteMemory` used to
    /// tombstone the metadata row and stop there, so a photograph the wearer
    /// explicitly deleted — and whose only other copy the pin then dropped —
    /// stayed on the volume forever with nothing left pointing at it.
    ///
    /// Every destination comes from [`Self::object_path`], the same derivation
    /// the write path used: one base64url principal segment plus three
    /// shape-checked slot segments under the storage root. So this can neither
    /// escape the root nor reach another principal's directory, no matter what
    /// the caller passes.
    pub(crate) async fn remove_slots(&self, principal: &str, slots: &[String]) -> bool {
        let mut removed_everything = true;
        let mut emptied: Vec<PathBuf> = Vec::new();
        let mut capture_directories: Vec<PathBuf> = Vec::new();
        for slot in slots {
            // A slot string that cannot become a path never became one on the
            // way in either — `accept` derives its destination the same way —
            // so there are no bytes filed under it to remove.
            let Some(path) = self.object_path(principal, slot) else {
                continue;
            };
            match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                // Nothing stored for this slot: the device uploads one of the
                // two secure names per frame, never both, and skips imu/timing
                // whenever it has no local file. Absent is the normal case.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    // No path in the log line: it carries the principal and the
                    // capture's identity.
                    tracing::warn!(%error, "capture object could not be removed");
                    removed_everything = false;
                }
            }
            // Burst directory, then the capture's own directory. The principal's
            // directory is deliberately not a candidate — it outlives any one
            // capture.
            for directory in [path.parent(), path.parent().and_then(Path::parent)]
                .into_iter()
                .flatten()
            {
                if !emptied.iter().any(|seen| seen == directory) {
                    emptied.push(directory.to_owned());
                }
            }
            if let Some(directory) = path.parent().and_then(Path::parent)
                && !capture_directories.iter().any(|seen| seen == directory)
            {
                capture_directories.push(directory.to_owned());
            }
        }
        // The selection is derived from these exact frames and belongs to the
        // same deletion. Removing it before pruning allows the now-empty capture
        // directory to disappear too. Missing is the idempotent normal case.
        for directory in capture_directories {
            match tokio::fs::remove_file(directory.join(".best-frame.json")).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => removed_everything = false,
            }
        }
        // `remove_dir`, never `remove_dir_all`: an empty directory goes, and one
        // still holding bytes refuses and stays. A recursive delete here would
        // be one bad path away from taking a wearer's whole library.
        for directory in emptied {
            let _ = tokio::fs::remove_dir(&directory).await;
        }
        removed_everything
    }

    /// Run a sweep if one is due.
    ///
    /// Rate-limited to [`SWEEP_INTERVAL`] because this rides on an upload rather
    /// than a scheduler thread — there is no background task to hang it off, and
    /// a per-PUT walk of the volume would be a self-inflicted denial of service.
    async fn maybe_sweep(&self) {
        {
            let mut last = self.last_sweep.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            if !last.is_none_or(|previous| now.duration_since(previous) >= self.sweep_interval) {
                return;
            }
            // Claimed before the sweep, not after, so concurrent uploads do not
            // all start one. The lock is released here — never held across the
            // filesystem work below.
            *last = Some(now);
        }
        self.sweep().await;
    }

    /// Remove what [`Retention`] allows: always this store's own abandoned
    /// staging fragments, and stored frames only when an operator opted in.
    async fn sweep(&self) {
        let fragments = self.sweep_incoming().await;
        if fragments > 0 {
            tracing::info!(fragments, "swept interrupted capture upload fragments");
        }
        if let Some(max_age) = self.retention.object_max_age {
            let objects = self.sweep_objects(max_age).await;
            if objects > 0 {
                tracing::info!(objects, "capture retention removed stored objects");
            }
        }
    }

    /// Drop `{token}.part` fragments left behind by writes that died between
    /// `create` and `rename`. Without this they accumulate forever: the token
    /// they are named for is single-use and already spent or expired, so nothing
    /// will ever claim them.
    async fn sweep_incoming(&self) -> usize {
        let incoming = self.root.join(INCOMING_DIR);
        let Ok(mut entries) = tokio::fs::read_dir(&incoming).await else {
            // No staging directory yet is not a problem to report.
            return 0;
        };
        let mut removed = 0;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            // Only the fragments this store writes itself. Anything else found
            // in the staging directory is left alone — a sweeper that removes
            // what it does not recognise is one mistake away from removing
            // frames.
            if path.extension().and_then(|e| e.to_str()) != Some("part") {
                continue;
            }
            let Ok(metadata) = tokio::fs::symlink_metadata(&path).await else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            if entry_age(&metadata).is_none_or(|age| age <= self.retention.incoming_ttl) {
                continue;
            }
            if tokio::fs::remove_file(&path).await.is_ok() {
                removed += 1;
            }
        }
        removed
    }

    /// Expire stored capture objects past `max_age`. Only reached when an
    /// operator set [`OBJECT_RETENTION_DAYS_ENV`] — see [`Retention`].
    ///
    /// The walk follows exactly the layout [`Self::object_path`] writes,
    /// `{root}/{principal}/{memory}/{burst}/{file}`, rather than recursing over
    /// whatever it finds: fixed depth, no symlink ever followed, and nothing
    /// outside that shape is touched.
    async fn sweep_objects(&self, max_age: Duration) -> usize {
        let mut removed = 0;
        for principal_directory in directories_in(&self.root).await {
            if principal_directory.file_name().and_then(|n| n.to_str()) == Some(INCOMING_DIR) {
                continue;
            }
            for memory_directory in directories_in(&principal_directory).await {
                for burst_directory in directories_in(&memory_directory).await {
                    removed += expire_files_in(&burst_directory, max_age).await;
                    let _ = tokio::fs::remove_dir(&burst_directory).await;
                }
                let _ = tokio::fs::remove_dir(&memory_directory).await;
            }
        }
        removed
    }
}

/// The immediate subdirectories of `path`, never following a symlink.
///
/// `symlink_metadata` rather than `metadata` on purpose: a symlink planted in
/// the storage root must not be able to walk a sweep out of it.
async fn directories_in(path: &Path) -> Vec<PathBuf> {
    let Ok(mut entries) = tokio::fs::read_dir(path).await else {
        return Vec::new();
    };
    let mut directories = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let child = entry.path();
        if tokio::fs::symlink_metadata(&child)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            directories.push(child);
        }
    }
    directories
}

/// Remove the regular files directly in `path` that are older than `max_age`.
async fn expire_files_in(path: &Path, max_age: Duration) -> usize {
    let Ok(mut entries) = tokio::fs::read_dir(path).await else {
        return 0;
    };
    let mut removed = 0;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let child = entry.path();
        let Ok(metadata) = tokio::fs::symlink_metadata(&child).await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        // An age the platform cannot report is never treated as old. A sweep
        // that guesses deletes the wearer's photographs on a guess.
        if entry_age(&metadata).is_none_or(|age| age <= max_age) {
            continue;
        }
        if tokio::fs::remove_file(&child).await.is_ok() {
            removed += 1;
        }
    }
    removed
}

/// How long ago an entry was last written, or `None` when the platform cannot
/// say or the timestamp is in the future.
fn entry_age(metadata: &std::fs::Metadata) -> Option<Duration> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
}

/// A private temporary storage root for one test.
#[cfg(test)]
fn temporary_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("carry-capture-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("test storage root");
    root
}

/// Test roots are private temporary directories; clean them up rather than
/// littering the machine with wearer-shaped fixtures. Only compiled for tests —
/// a production store must never delete its own root.
#[cfg(test)]
impl Drop for CaptureObjectStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
async fn restrict_directory(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await;
}

#[cfg(unix)]
async fn restrict_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
}

#[cfg(not(unix))]
async fn restrict_directory(_path: &Path) {}

#[cfg(not(unix))]
async fn restrict_file(_path: &Path) {}

/// One filesystem-safe, injective directory name per authenticated principal.
///
/// Principals carry `:` separators and device/user identifiers, so they are not
/// usable as path segments directly. base64url is reversible and collision-free
/// — two wearers sharing a directory would be a cross-wearer data leak, which a
/// lossy "sanitize the string" mapping could produce.
fn principal_directory(principal: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(principal.as_bytes())
}

/// The process-wide capture object store.
///
/// One instance, because the gRPC handler that mints capabilities and the HTTP
/// handler that redeems them are the same process and must share the registry.
/// `LazyLock` rather than per-construction so `Capture::new` and
/// `crate::http::build_router` cannot end up with two.
static OBJECT_STORE: LazyLock<Option<Arc<CaptureObjectStore>>> =
    LazyLock::new(object_store_from_environment);

/// The configured object store, or `None` when this deployment stores nothing.
///
/// Called by both production constructors: `Capture::new` (mints capabilities,
/// reads objects back) and `crate::http::build_router` (accepts the bytes).
pub(crate) fn configured_object_store() -> Option<Arc<CaptureObjectStore>> {
    OBJECT_STORE.clone()
}

/// Resolve storage from the deployment's environment, or `None`.
///
/// `None` is an honest "this deployment stores nothing": `UploadFile` then
/// reports UNIMPLEMENTED and `UploadComplete` never acknowledges. Nothing here
/// pretends to store.
fn object_store_from_environment() -> Option<Arc<CaptureObjectStore>> {
    resolve_object_store(
        non_empty_env(WORKLOAD_ENV),
        non_empty_env(STORAGE_DIR_ENV),
        non_empty_env(STATE_DIR_ENV),
        non_empty_env(MAX_UPLOAD_BYTES_ENV),
        non_empty_env(INCOMING_TTL_ENV),
        non_empty_env(OBJECT_RETENTION_DAYS_ENV),
    )
}

/// The configuration decision itself, separated from reading the environment so
/// it is testable without mutating process-global state that `store.rs` and
/// `keymaterial.rs` read from the same variables.
fn resolve_object_store(
    workload: Option<String>,
    storage_dir: Option<String>,
    state_dir: Option<String>,
    max_upload_bytes: Option<String>,
    incoming_ttl_seconds: Option<String>,
    object_retention_days: Option<String>,
) -> Option<Arc<CaptureObjectStore>> {
    // `config.rs` defaults an unset workload to ai-bus, so an unset value has to
    // mean the same thing here or a default local run would silently lose its
    // storage.
    let workload = workload.unwrap_or_else(|| cosmos_core::Workload::AiBus.as_str().to_owned());
    if workload != cosmos_core::Workload::AiBus.as_str() {
        // Only the workload hosting `CaptureService` serves capture objects.
        return None;
    }

    // Defaults to the durable state dir, which every deployment already mounts
    // a named volume at. Neither configured means this deployment stores
    // nothing — reported as such, never pretended around.
    let root = match storage_dir {
        Some(explicit) => PathBuf::from(explicit),
        None => PathBuf::from(state_dir?).join("captures"),
    };
    if !root.is_absolute() {
        tracing::warn!("capture object storage path must be absolute; captures will not be stored");
        return None;
    }
    if let Err(error) = std::fs::create_dir_all(&root) {
        // Loud, and still honest: without a writable root there is no storage,
        // and pretending otherwise is what deletes a wearer's photo.
        tracing::warn!(%error, "capture object storage root is not writable");
        return None;
    }

    let max_bytes = max_upload_bytes
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_UPLOAD_BYTES)
        .clamp(MIN_MAX_UPLOAD_BYTES, MAX_MAX_UPLOAD_BYTES);

    Some(Arc::new(CaptureObjectStore::new(
        root,
        max_bytes,
        UPLOAD_GRANT_TTL,
        Retention::resolve(incoming_ttl_seconds, object_retention_days),
    )))
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[derive(Clone)]
pub struct Capture {
    share_endpoint: Endpoint,
    share_secret: Option<String>,
    upload_endpoint: Endpoint,
    authenticator: crate::auth::RequestAuthenticator,
    store: crate::store::SharedStore,
    /// Needed to INDEX a note, not to store one. A note arrives sealed; the text
    /// index is what `recall_memory` and `WebSearchService.Search` actually
    /// search, and both skip anything with no `indexed_text`. Storing without
    /// indexing therefore leaves the wearer's note permanently unfindable —
    /// saved, acknowledged, and unreachable by voice.
    keys: crate::keymaterial::SharedKeyMaterial,
    /// Durable C1 channel keys used by stock HMSA capture thumbnails. This is
    /// distinct from `keys`, which protects HMCT service-channel envelopes.
    capture_keys: crate::keydirectory::SharedKeyDirectory,
    asset_arrival: AssetArrival,
}

#[derive(Clone, PartialEq, prost::Message)]
struct StoredFoodLog {
    #[prost(string, tag = "1")]
    memory_uuid: String,
    #[prost(int64, tag = "2")]
    created_seconds: i64,
    #[prost(int32, tag = "3")]
    created_nanos: i32,
    #[prost(message, optional, tag = "4")]
    sealed: Option<cosmos_protocol::common::encryption::EncryptedData>,
}

#[derive(Clone, PartialEq, prost::Message)]
struct StoredFoodLogs {
    #[prost(message, repeated, tag = "1")]
    entries: Vec<StoredFoodLog>,
}

fn food_log_start_time(
    timestamp: Option<prost_types::Timestamp>,
) -> Result<crate::store::SyncTime, Status> {
    let timestamp = timestamp.ok_or_else(|| Status::invalid_argument("start_time is required"))?;
    if !(MIN_PROTOBUF_TIMESTAMP_SECONDS..=MAX_PROTOBUF_TIMESTAMP_SECONDS)
        .contains(&timestamp.seconds)
        || !(0..=999_999_999).contains(&timestamp.nanos)
    {
        return Err(Status::invalid_argument("start_time is invalid"));
    }
    Ok(crate::store::SyncTime::from_parts(
        timestamp.seconds,
        timestamp.nanos,
    ))
}

fn valid_food_text(value: &str, maximum_bytes: usize, may_be_empty: bool) -> bool {
    value.len() <= maximum_bytes
        && (may_be_empty || !value.trim().is_empty())
        && !value.chars().any(char::is_control)
}

fn decode_valid_food_log(payload: &[u8]) -> Option<FoodLog> {
    if payload.len() > MAX_FOOD_LOG_PAYLOAD_BYTES {
        return None;
    }
    let log = FoodLog::decode(payload).ok()?;
    let item = log.food_item.as_ref()?;
    if !valid_food_text(&item.item_name, MAX_FOOD_ITEM_NAME_BYTES, false)
        || !valid_food_text(&item.brand, MAX_FOOD_ITEM_BRAND_BYTES, true)
        || !valid_food_text(
            &item.typical_serving_size,
            MAX_FOOD_ITEM_SERVING_BYTES,
            true,
        )
        || !valid_food_text(&item.request_uuid, MAX_FOOD_ITEM_REQUEST_UUID_BYTES, true)
        || item.nutrition_info.len() > MAX_FOOD_NUTRIENTS
        || !log.servings_consumed.is_finite()
        || log.servings_consumed <= 0.0
        || log.servings_consumed > MAX_FOOD_NUMERIC_VALUE
        || item.nutrition_info.iter().any(|nutrient| {
            NutrientType::try_from(nutrient.nutrient_type).is_err()
                || !nutrient.value.is_finite()
                || nutrient.value < 0.0
                || nutrient.value > MAX_FOOD_NUMERIC_VALUE
        })
    {
        return None;
    }
    Some(log)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ShareCapability {
    owner: String,
    memory_uuid: String,
    expiry: i64,
}

fn share_cipher(secret: Option<&str>) -> Result<Aes256Gcm, Status> {
    let secret = secret.filter(|value| value.len() >= 32).ok_or_else(|| {
        Status::failed_precondition(format!(
            "{SHARE_TOKEN_SECRET_ENV} must contain at least 32 bytes"
        ))
    })?;
    let key = Sha256::digest(secret.as_bytes());
    Aes256Gcm::new_from_slice(&key)
        .map_err(|_| Status::failed_precondition("share token key is invalid"))
}

fn mint_share_capability(
    secret: Option<&str>,
    capability: &ShareCapability,
) -> Result<String, Status> {
    let payload = serde_json::to_vec(capability)
        .map_err(|_| Status::internal("share capability could not be encoded"))?;
    let nonce: [u8; 12] = rand::random();
    let ciphertext = share_cipher(secret)?
        .encrypt(Nonce::from_slice(&nonce), payload.as_slice())
        .map_err(|_| Status::internal("share capability could not be sealed"))?;
    let mut token = Vec::with_capacity(nonce.len() + ciphertext.len());
    token.extend_from_slice(&nonce);
    token.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token))
}

fn open_share_capability(
    secret: Option<&str>,
    data: &pb::ShareLinkData,
) -> Result<ShareCapability, Status> {
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(data.signature.as_bytes())
        .map_err(|_| Status::not_found("share link is invalid"))?;
    if token.len() <= 12 {
        return Err(Status::not_found("share link is invalid"));
    }
    let plaintext = share_cipher(secret)?
        .decrypt(Nonce::from_slice(&token[..12]), &token[12..])
        .map_err(|_| Status::not_found("share link is invalid"))?;
    let capability: ShareCapability = serde_json::from_slice(&plaintext)
        .map_err(|_| Status::not_found("share link is invalid"))?;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    if capability.expiry < now
        || capability.expiry != data.expiry
        || capability.memory_uuid != data.memory_uuid
    {
        return Err(Status::not_found("share link is invalid or expired"));
    }
    Ok(capability)
}

fn request_share_data(request: pb::SaveSharedMemoryRequest) -> Result<pb::ShareLinkData, Status> {
    if let Some(data) = request.share_link_data {
        return Ok(data);
    }
    if request.memory_uuid.is_empty() || request.signature.is_empty() {
        return Err(Status::invalid_argument("share_link_data is required"));
    }
    Ok(pb::ShareLinkData {
        memory_uuid: request.memory_uuid,
        signature: request.signature,
        expiry: request.expiry,
    })
}

async fn opened_thumbnail(
    keys: &crate::keydirectory::SharedKeyDirectory,
    record: &crate::store::MemoryRecord,
) -> Option<Vec<u8>> {
    for sealed in &record.thumbnails {
        let kid = sealed
            .encryption_information
            .as_ref()
            .map(|information| information.kid.as_str())
            .unwrap_or_default();
        let Some(key) = keys.get(kid).await else {
            continue;
        };
        if let Ok(bytes) = cosmos_crypto::secure_asset::open_secure_asset(
            &key,
            kid,
            &sealed.data,
            cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
        ) {
            return Some(bytes);
        }
    }
    None
}

async fn save_food_log(
    store: &crate::store::SharedStore,
    principal: &str,
    memory_uuid: &str,
    created: crate::store::SyncTime,
    sealed: cosmos_protocol::common::encryption::EncryptedData,
) -> Result<(), Status> {
    for _ in 0..FOOD_LOG_CAS_RETRIES {
        let previous = store
            .get_account_blob(principal, crate::store::AccountBlobKind::FoodLogs)
            .await?;
        let mut logs = previous
            .as_deref()
            .and_then(|bytes| StoredFoodLogs::decode(bytes).ok())
            .unwrap_or_default();
        let entry = StoredFoodLog {
            memory_uuid: memory_uuid.to_owned(),
            created_seconds: created.seconds(),
            created_nanos: created.nanos(),
            sealed: Some(sealed.clone()),
        };
        if let Some(index) = logs
            .entries
            .iter()
            .position(|stored| stored.memory_uuid == memory_uuid)
        {
            logs.entries[index] = entry;
        } else {
            logs.entries.push(entry);
        }
        logs.entries
            .sort_by_key(|entry| (entry.created_seconds, entry.created_nanos));
        if logs.entries.len() > MAX_FOOD_LOGS {
            let remove = logs.entries.len() - MAX_FOOD_LOGS;
            logs.entries.drain(..remove);
        }
        if store
            .compare_and_swap_account_blob(
                principal,
                crate::store::AccountBlobKind::FoodLogs,
                previous.as_deref(),
                &logs.encode_to_vec(),
            )
            .await?
        {
            return Ok(());
        }
    }
    Err(Status::aborted("food log changed concurrently; retry"))
}

/// Open a sealed note and record its plaintext in the search index.
///
/// Shared by both note-creating RPCs. It lived only inside
/// `TestingAutomationService::create_note`, so the path a real Pin uses stored
/// notes that could never be found again. A note whose envelope this server
/// cannot open is left unindexed rather than indexed as garbage — unfindable is
/// bad, wrong search results are worse.
async fn index_sealed_note(
    store: &crate::store::SharedStore,
    keys: &crate::keymaterial::SharedKeyMaterial,
    principal: &str,
    uuid: &str,
    sealed: Option<&cosmos_protocol::common::encryption::EncryptedData>,
) {
    let Some(sealed) = sealed else { return };
    let kid = sealed
        .encryption_information
        .as_ref()
        .map(|i| i.kid.clone())
        .unwrap_or_default();
    if let Ok(plaintext) = keys.open(&cosmos_crypto::EncryptedData {
        data: sealed.data.clone(),
        kid,
    }) {
        if let Some(text) = note_search_text(&plaintext) {
            store.index_note(principal, uuid, &text).await;
        }
    }
}

/// The searchable text inside an opened note.
///
/// The device seals a `humane.capture.Note` PROTOBUF, not a string:
/// `DataProtectionUtils.protectData(IDataProtector<GeneratedMessageLite<?,?>>,
/// Note, DataProtectionIdentity)` takes the message itself. Treating the
/// plaintext as UTF-8 therefore usually failed outright — protobuf bytes are
/// rarely valid UTF-8 — and the note was silently left unindexed, which is
/// indistinguishable from the wearer never having saved it. When it did happen to
/// decode, it indexed field tags and lengths as if they were words.
///
/// `Note` carries BOTH `title` (field 5) and `text` (field 2), and the .Center
/// dashboard showed notes with titles, so both belong in the index — searching
/// for a note by its title is a thing a wearer would expect to work.
///
/// Falls back to raw UTF-8 for notes this server wrote itself (the `remember`
/// tool stores plain text with no envelope), so both origins stay searchable.
fn note_search_text(plaintext: &[u8]) -> Option<String> {
    use prost::Message as _;
    if let Ok(note) = cosmos_protocol::capture::Note::decode(plaintext) {
        let joined = format!("{} {}", note.title.trim(), note.text.trim());
        let joined = joined.trim().to_owned();
        if !joined.is_empty() {
            return Some(joined);
        }
    }
    String::from_utf8(plaintext.to_vec())
        .ok()
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// Whether this deployment can *witness* a capture's bytes arriving.
///
/// It is separated out because `UploadComplete` must not acknowledge what it
/// cannot confirm: `AssetUploadWorkerImpl.handleUploadSuccess` responds to
/// `STATUS_ACKNOWLEDGED` by calling `delete(uploadableAssetEntity)`, which runs
/// `mFileSystem.deleteDirectory(uploadableAssetEntity.captureDirectory())`
/// whenever `deleteCapturesOnUpload` is set — the wearer's only copy of the
/// frames.
#[derive(Clone)]
enum AssetArrival {
    /// No storage backend is configured, so no arrival can be observed.
    Unobservable,
    /// The clone's own object store. Arrival is answered by reading the stored
    /// objects back, never by trusting the device's claim.
    Objects(Arc<CaptureObjectStore>),
    /// Test-only stand-in for a storage backend that confirmed the bytes, so
    /// the acknowledged path stays exercised without a filesystem.
    #[cfg(test)]
    Confirmed,
}

impl Capture {
    /// Captures are per-wearer, so every RPC resolves the caller first. This
    /// handler decides *whose* memories it touches, so it checks here rather
    /// than relying on wiring elsewhere staying correct.
    fn principal<T>(
        &self,
        request: &Request<T>,
    ) -> Result<cosmos_core::AuthenticatedPrincipal, Status> {
        self.authenticator.authenticate(request)
    }
}

#[derive(Clone)]
pub(crate) enum Endpoint {
    Missing,
    Invalid,
    Ready(Url),
}

impl Endpoint {
    pub(crate) fn from_environment(name: &str) -> Self {
        match std::env::var(name) {
            Ok(value) if !value.trim().is_empty() => Self::parse(&value),
            _ => Self::Missing,
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        let Ok(url) = Url::parse(value.trim()) else {
            return Self::Invalid;
        };
        let valid_scheme = matches!(url.scheme(), "http" | "https");
        let has_credentials = !url.username().is_empty() || url.password().is_some();
        if !valid_scheme
            || url.cannot_be_a_base()
            || url.host_str().is_none()
            || has_credentials
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Self::Invalid;
        }
        Self::Ready(url)
    }

    pub(crate) fn resource_url(&self, variable: &str, token: &str) -> Result<String, Status> {
        let mut url = match self {
            Self::Ready(url) => url.clone(),
            Self::Missing => {
                return Err(Status::failed_precondition(format!(
                    "{variable} is not configured"
                )));
            }
            Self::Invalid => {
                return Err(Status::failed_precondition(format!(
                    "{variable} must be an absolute HTTP(S) URL without credentials, query, or fragment"
                )));
            }
        };

        // Safe because `parse` rejects cannot-be-a-base URLs. `push` percent
        // encodes each segment, and the token contains no request plaintext.
        url.path_segments_mut()
            .map_err(|_| Status::failed_precondition(format!("{variable} is not a base URL")))?
            .pop_if_empty()
            .push("capture")
            .push(token);
        Ok(url.into())
    }
}

impl Capture {
    /// Build the service with the deployment's real authenticator and store.
    /// Captures are per-wearer, so this is how it must be constructed in
    /// production — `Default` resolves every caller to the same synthetic
    /// principal and exists only for tests.
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        store: crate::store::SharedStore,
        keys: crate::keymaterial::SharedKeyMaterial,
    ) -> Self {
        Self {
            authenticator,
            store,
            keys,
            capture_keys: Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
            share_endpoint: Endpoint::from_environment(SHARE_BASE_URL_ENV),
            share_secret: non_empty_env(SHARE_TOKEN_SECRET_ENV),
            upload_endpoint: Endpoint::from_environment(UPLOAD_BASE_URL_ENV),
            // The same store `crate::http::build_router` serves the PUT route
            // from, so a capability minted here is redeemable there and the
            // bytes are readable back. `None` when this deployment stores
            // nothing, which keeps `UploadFile` honestly UNIMPLEMENTED.
            asset_arrival: match configured_object_store() {
                Some(objects) => AssetArrival::Objects(objects),
                None => AssetArrival::Unobservable,
            },
        }
    }
}

impl Default for Capture {
    fn default() -> Self {
        Self {
            authenticator: crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store: crate::store::MemoryStore::shared(),
            keys: Default::default(),
            capture_keys: Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
            share_endpoint: Endpoint::from_environment(SHARE_BASE_URL_ENV),
            share_secret: non_empty_env(SHARE_TOKEN_SECRET_ENV),
            upload_endpoint: Endpoint::from_environment(UPLOAD_BASE_URL_ENV),
            asset_arrival: AssetArrival::Unobservable,
        }
    }
}

impl Capture {
    /// Share the same durable C1 key directory as PublicPrivacy and the Center
    /// projection, so upload-time ranking can open the thumbnails the Pin sent.
    pub fn with_capture_key_directory(
        mut self,
        keys: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        self.capture_keys = keys;
        self
    }

    /// Endpoints configured, storage configured. This is the *working* shape:
    /// `UploadFile` only issues a URL when the bytes have somewhere to land.
    #[cfg(test)]
    fn with_endpoints(share: Option<&str>, upload: Option<&str>) -> Self {
        Self {
            share_endpoint: share.map(Endpoint::parse).unwrap_or(Endpoint::Missing),
            share_secret: Some("test-share-token-secret-32-bytes!!".to_owned()),
            upload_endpoint: upload.map(Endpoint::parse).unwrap_or(Endpoint::Missing),
            asset_arrival: AssetArrival::Objects(CaptureObjectStore::for_tests()),
            ..Default::default()
        }
    }

    /// A capture service over an explicit store and object store — the shape
    /// `Capture::new` produces in production, with both halves supplied so a
    /// test can hand the SAME object store to `crate::http`'s router.
    #[cfg(test)]
    pub(crate) fn for_upload_tests(
        store: crate::store::SharedStore,
        objects: Arc<CaptureObjectStore>,
        upload_base: &str,
    ) -> Self {
        Self {
            store,
            share_endpoint: Endpoint::Missing,
            upload_endpoint: Endpoint::parse(upload_base),
            asset_arrival: AssetArrival::Objects(objects),
            ..Default::default()
        }
    }

    /// A service over `store` with no configured endpoints. `asset_arrival` is
    /// spelled out per test because it decides whether a claimed upload can be
    /// acknowledged; production is always [`AssetArrival::Unobservable`].
    #[cfg(test)]
    fn for_tests(store: crate::store::SharedStore, asset_arrival: AssetArrival) -> Self {
        Self {
            store,
            share_endpoint: Endpoint::Missing,
            upload_endpoint: Endpoint::Missing,
            asset_arrival,
            ..Default::default()
        }
    }

    async fn copy_shared_objects(
        &self,
        source_owner: &str,
        source: &crate::store::MemoryRecord,
        destination_owner: &str,
        destination: &crate::store::MemoryRecord,
    ) -> Result<(), Status> {
        let has_files = source.bursts.iter().any(|burst| !burst.files.is_empty());
        let objects = match &self.asset_arrival {
            AssetArrival::Objects(objects) => objects,
            AssetArrival::Unobservable if !has_files => return Ok(()),
            AssetArrival::Unobservable => {
                return Err(Status::failed_precondition(
                    "shared capture storage is not configured",
                ));
            }
            #[cfg(test)]
            AssetArrival::Confirmed => {
                return Err(Status::failed_precondition(
                    "shared capture storage is not readable",
                ));
            }
        };
        if source.bursts.len() != destination.bursts.len()
            || source
                .bursts
                .iter()
                .zip(&destination.bursts)
                .any(|(left, right)| left.files.len() != right.files.len())
        {
            return Err(Status::internal(
                "shared memory destination does not match its source",
            ));
        }
        for (source_burst, destination_burst) in source.bursts.iter().zip(&destination.bursts) {
            for (source_file, destination_file) in
                source_burst.files.iter().zip(&destination_burst.files)
            {
                let copied = objects
                    .copy(
                        source_owner,
                        &source_file.secure_raw_data_filename,
                        destination_owner,
                        &destination_file.secure_raw_data_filename,
                    )
                    .await
                    .map_err(|_| Status::unavailable("shared memory object copy failed"))?;
                if !copied {
                    return Err(Status::failed_precondition(
                        "shared memory assets are not available yet",
                    ));
                }
            }
        }
        if let Some(selection) = objects
            .read_best_frame(source_owner, &source.uuid)
            .await
            .map_err(|_| Status::unavailable("shared best-frame metadata could not be read"))?
        {
            objects
                .write_best_frame(destination_owner, &destination.uuid, &selection)
                .await
                .map_err(|_| {
                    Status::unavailable("shared best-frame metadata could not be stored")
                })?;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct TestingAutomation {
    authenticator: crate::auth::RequestAuthenticator,
    store: crate::store::SharedStore,
    /// Channel keys, so a note can be indexed for retrieval when the wearer's
    /// key is established. Without it the note is still stored — just not
    /// searchable.
    keys: crate::keymaterial::SharedKeyMaterial,
    /// The same object store `Capture` deletes through. `H4Device` reaches
    /// captures through this surface, so a delete arriving here has to remove
    /// the wearer's frames too — the test-automation service must not be the
    /// one that quietly keeps them.
    objects: Option<Arc<CaptureObjectStore>>,
}

impl TestingAutomation {
    /// Notes are per-wearer, so construct with the deployment's real
    /// authenticator and store. `Default` resolves every caller to the same
    /// synthetic principal and exists only for tests.
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        store: crate::store::SharedStore,
        keys: crate::keymaterial::SharedKeyMaterial,
    ) -> Self {
        Self {
            authenticator,
            store,
            keys,
            // The one process-wide store, so a delete here unlinks exactly the
            // objects `UploadFile` filed.
            objects: configured_object_store(),
        }
    }

    fn principal<T>(
        &self,
        request: &Request<T>,
    ) -> Result<cosmos_core::AuthenticatedPrincipal, Status> {
        self.authenticator.authenticate(request)
    }
}

impl Default for TestingAutomation {
    fn default() -> Self {
        Self {
            authenticator: crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store: crate::store::MemoryStore::shared(),
            keys: Default::default(),
            // Spelled out rather than resolved from the environment: a test
            // fixture must not reach the deployment's real storage root.
            objects: None,
        }
    }
}

/// A retry policy matching the device's OWN compiled-in defaults
/// (`PhotographyConfig`), so a served config is a no-op rather than a regression.
///
/// This matters because the device treats `GetCaptureConfigResponse` as
/// authoritative and lets the server value win whenever the local value equals
/// its default (`PhotographyConfig` merge ctor) — which it always does on a fresh
/// config. Returning a *weaker* retry (few attempts, short interval) makes the
/// device give up and PERMANENTLY LOSE a capture upload on any flaky uplink;
/// returning a smaller burst count degrades the computational-photography
/// pipeline. Stock defaults: create/asset = 1_000_000 @ 600s LINEAR,
/// delete = 1_000_000 @ 300s LINEAR.
fn retry_config(retry_interval_seconds: i32) -> pb::CaptureRetryConfig {
    pb::CaptureRetryConfig {
        num_retries: 1_000_000,
        retry_interval_seconds,
        policy: pb::capture_retry_config::CaptureRetryPolicy::Linear as i32,
    }
}

#[tonic::async_trait]
impl CaptureService for Capture {
    /// Record the capture and hand back the identity + upload slots the device
    /// needs for its very next step.
    ///
    /// This RPC previously acked CREATE_SUCCESS with no `Memory` and no bursts.
    /// `verifyResponse` passes that (proto3 `getUuid()` returns "" rather than
    /// null), so the device marked the capture permanent and then had nowhere to
    /// upload to — every photo and video was lost one step later. The uuid, the
    /// numeric id, and the burst/file paths are all server-allocated; none of the
    /// device's content is invented.
    async fn create_memory(
        &self,
        request: Request<pb::CreateMemoryRequest>,
    ) -> Result<Response<pb::CreateMemoryResponse>, Status> {
        use crate::store::MemoryKind;
        use pb::create_memory_request::Request as Req;
        use pb::create_memory_response::Request as Resp;

        let principal = self.principal(&request)?;
        let Some(body) = request.into_inner().request else {
            return Ok(Response::new(pb::CreateMemoryResponse {
                status: pb::CreateMemoryResultStatus::BadRequest as i32,
                memory: None,
                request: None,
            }));
        };

        // A note is not a capture: it has no bursts, no files, and no upload
        // slots — its whole content is `encrypted_note`. Routing it through
        // `create_memory` recorded an empty Photo-shaped row and dropped the body
        // on the floor, then answered `CreateSuccess`. The wearer was told their
        // note was saved and nothing was saved. `create_note` is the path that
        // actually persists it, and `TestingAutomationService.CreateNote` has
        // been using it correctly all along.
        if let Req::NoteMemoryRequest(n) = &body {
            let record = self
                .store
                .create_note(
                    principal.expose_for_authorization(),
                    n.encrypted_note.clone(),
                    n.encrypted_location.clone(),
                )
                .await?;
            // Index it, or the wearer can never find it again: both search
            // paths require `indexed_text`. Storing a note without indexing is
            // the same false negative the recall code works hard to avoid,
            // reached one layer earlier.
            index_sealed_note(
                &self.store,
                &self.keys,
                principal.expose_for_authorization(),
                &record.uuid,
                n.encrypted_note.as_ref(),
            )
            .await;
            return Ok(Response::new(pb::CreateMemoryResponse {
                status: pb::CreateMemoryResultStatus::CreateSuccess as i32,
                memory: Some(pb::Memory {
                    uuid: record.uuid.clone(),
                    ..Default::default()
                }),
                request: Some(Resp::NoteMemoryResponse(pb::NoteMemoryResponse {})),
            }));
        }

        // One shape per arm: what to store, and how many upload slots to cut.
        let (kind, device_local_id, bursts, per_burst, created, gmt, thumbs, location, food_log) =
            match &body {
                Req::PhotoMemoryRequest(p) => (
                    MemoryKind::Photo,
                    p.device_local_id.clone(),
                    p.num_bursts,
                    p.num_pics_per_burst,
                    p.device_created_time,
                    p.gmt_offset,
                    {
                        let mut t = p.thumbnails.clone();
                        if let Some(single) = p.thumbnail.clone() {
                            t.push(single);
                        }
                        t
                    },
                    p.encrypted_location.clone(),
                    None,
                ),
                Req::VideoMemoryRequest(v) => (
                    MemoryKind::Video,
                    v.device_local_id.clone(),
                    v.num_videos,
                    1,
                    v.device_created_time,
                    v.gmt_offset,
                    v.thumbnail.clone().into_iter().collect(),
                    v.encrypted_location.clone(),
                    None,
                ),
                Req::FoodLogMemoryRequest(f) => (
                    MemoryKind::FoodLog,
                    f.device_local_id.clone(),
                    0,
                    0,
                    f.device_created_time,
                    0,
                    Vec::new(),
                    None,
                    f.food_log.clone(),
                ),
                Req::NoteMemoryRequest(n) => (
                    MemoryKind::Note,
                    String::new(),
                    0,
                    0,
                    None,
                    0,
                    Vec::new(),
                    n.encrypted_location.clone(),
                    None,
                ),
            };
        // NOTE: the `NoteMemoryRequest` arm above is unreachable — notes return
        // early via `create_note`. It exists only to keep this match exhaustive,
        // and deliberately does NOT define note behaviour; edit the early return
        // instead.

        // Slot counts are the one thing in this request that the device turns
        // into work on our side, so they are the one thing bounded here.
        // `store::build_memory` allocates a record per burst and per file and
        // mints four uuids and six paths for each; nothing between the wire and
        // that loop looked at the magnitude. A `CreateMemoryRequest` carrying
        // `num_bursts: i32::MAX, num_pics_per_burst: i32::MAX` is about ten bytes
        // on the wire, so `max_decode_bytes` never sees it, and it asked the
        // process for hundreds of gigabytes: an allocator refusal here is
        // `handle_alloc_error`, which aborts — no unwind, no `Status`, just a
        // dead ai-bus container taking capture, the AI bus, notable events and
        // the push relay down for every wearer, and repeatable as soon as the
        // restart policy brings it back. Any authenticated principal reached it,
        // on either plane, since `RequestAuthenticator` resolves a Center bearer
        // and a paired Pin to the same kind of caller.
        //
        // Refused rather than clamped, and refused with a gRPC error rather than
        // an in-band `BadRequest` ack: a device that genuinely wanted more slots
        // must find out it did not get them. That is the whole lesson of the ack
        // this handler already carries a regression test for — `verifyResponse`
        // reads a `CreateMemoryResponse` with a status and no usable bursts as
        // good enough, marks the capture permanent, and then has nowhere to put
        // the frames. Silently cutting 32 slots for a request for 4096 would land
        // in exactly that hole one step later.
        if bursts > crate::store::MAX_BURSTS || per_burst > crate::store::MAX_FILES_PER_BURST {
            return Err(Status::invalid_argument(format!(
                "capture requests at most {} bursts of {} files; asked for {bursts} of {per_burst}",
                crate::store::MAX_BURSTS,
                crate::store::MAX_FILES_PER_BURST,
            )));
        }

        let record = self
            .store
            .create_memory(
                principal.expose_for_authorization(),
                crate::store::NewMemory {
                    kind,
                    device_local_id,
                    bursts,
                    files_per_burst: per_burst,
                    device_created_time: created
                        .map(|t| crate::store::SyncTime::from_parts(t.seconds, t.nanos)),
                    gmt_offset: gmt,
                    thumbnails: thumbs,
                    encrypted_location: location,
                },
                // A store that could not record the capture is UNAVAILABLE, which the
                // device's create-memory retry config treats as transient. `expect` here
                // panicked the request task instead, taking the connection with it.
            )
            .await?;

        if let Some(sealed) = food_log {
            save_food_log(
                &self.store,
                principal.expose_for_authorization(),
                &record.uuid,
                record.device_created_time.unwrap_or(record.created),
                sealed,
            )
            .await?;
        }

        let wire_bursts: Vec<pb::CaptureBurst> = record
            .bursts
            .iter()
            .map(|b| pb::CaptureBurst {
                id: b.id,
                index: b.index,
                uuid: b.uuid.clone(),
                files: b
                    .files
                    .iter()
                    .map(|f| pb::CaptureFile {
                        id: f.id,
                        index: f.index,
                        filename: f.filename.clone(),
                        metadata_filename: f.metadata_filename.clone(),
                        secure_filename: f.secure_filename.clone(),
                        secure_raw_data_filename: f.secure_raw_data_filename.clone(),
                        uuid: f.uuid.clone(),
                        imu_data_filename: f.imu_data_filename.clone(),
                        video_timing_data_filename: f.video_timing_data_filename.clone(),
                    })
                    .collect(),
            })
            .collect();

        let response_body = match kind {
            MemoryKind::Photo => Some(Resp::PhotoMemoryResponse(pb::PhotoMemoryResponse {
                bursts: wire_bursts,
            })),
            MemoryKind::Video => Some(Resp::VideoMemoryResponse(pb::VideoMemoryResponse {
                bursts: wire_bursts,
                // Calibration is device-specific data we do not hold; absent is
                // honest, invented values would misalign the wearer's video.
                calibration_data: None,
            })),
            MemoryKind::FoodLog => Some(Resp::FoodLogMemoryResponse(pb::FoodLogMemoryResponse {})),
            MemoryKind::Note => Some(Resp::NoteMemoryResponse(pb::NoteMemoryResponse {})),
        };

        Ok(Response::new(pb::CreateMemoryResponse {
            status: pb::CreateMemoryResultStatus::CreateSuccess as i32,
            memory: Some(pb::Memory {
                id: record.numeric_id.to_string(),
                uuid: record.uuid.clone(),
            }),
            request: response_body,
        }))
    }

    async fn declare_memory_create_intent(
        &self,
        _request: Request<pb::MemoryCreateIntentRequest>,
    ) -> Result<Response<pb::MemoryCreateIntentResponse>, Status> {
        Ok(Response::new(pb::MemoryCreateIntentResponse {}))
    }

    /// Delete the wearer's capture, and only say so when it is gone.
    ///
    /// This used to ack `DELETE_MEMORY_STATUS_SUCCESS` unconditionally without
    /// touching the store. `DeleteUploadWorkerImpl.handleDeleteMemoryResponse`
    /// deletes its local row on `SUCCESS`, so the device forgot the capture
    /// while the cloud kept it forever: the wearer deleted a photo, was shown
    /// that it worked, and it never left.
    async fn delete_memory(
        &self,
        request: Request<pb::DeleteMemoryRequest>,
    ) -> Result<Response<pb::DeleteMemoryResponse>, Status> {
        let principal = self.principal(&request)?;
        let status = delete_memory(
            &self.store,
            self.objects(),
            principal.expose_for_authorization(),
            request.into_inner(),
        )
        .await?;
        Ok(Response::new(pb::DeleteMemoryResponse {
            status: status as i32,
        }))
    }

    async fn get_capture_config(
        &self,
        _request: Request<pb::GetCaptureConfigRequest>,
    ) -> Result<Response<pb::GetCaptureConfigResponse>, Status> {
        // The device's own defaults: 3-frame bursts, near-infinite retries. Serving
        // anything weaker overrides those and causes degraded photos + lost uploads.
        Ok(Response::new(pb::GetCaptureConfigResponse {
            num_photos_per_burst: 3,
            create_memory_retry_config: Some(retry_config(600)),
            asset_upload_retry_config: Some(retry_config(600)),
            delete_memory_retry_config: Some(retry_config(300)),
        }))
    }

    async fn get_food_log_summary(
        &self,
        request: Request<pb::GetFoodLogSummaryRequest>,
    ) -> Result<Response<pb::GetFoodLogSummaryResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let start = food_log_start_time(request.into_inner().start_time)?;
        let stored = self
            .store
            .get_account_blob(
                principal.expose_for_authorization(),
                crate::store::AccountBlobKind::FoodLogs,
            )
            .await?
            .as_deref()
            .and_then(|bytes| StoredFoodLogs::decode(bytes).ok())
            .unwrap_or_default();
        let mut logs = Vec::new();
        let mut response_kid = None;
        let mut total_bytes = 0usize;
        for entry in stored.entries.into_iter().filter(|entry| {
            crate::store::SyncTime::from_parts(entry.created_seconds, entry.created_nanos) >= start
        }) {
            let Some(sealed) = entry.sealed else { continue };
            let kid = sealed
                .encryption_information
                .as_ref()
                .map(|information| information.kid.clone())
                .unwrap_or_default();
            let Ok(opened) = self.keys.open(&cosmos_crypto::EncryptedData {
                kid: kid.clone(),
                data: sealed.data,
            }) else {
                continue;
            };
            total_bytes = total_bytes.saturating_add(opened.len());
            if total_bytes > MAX_FOOD_LOG_TOTAL_BYTES {
                return Err(Status::resource_exhausted("food log summary is too large"));
            }
            if let Some(log) = decode_valid_food_log(&opened) {
                response_kid.get_or_insert(kid);
                logs.push(log);
            }
        }
        let Some(kid) = response_kid else {
            return Ok(Response::new(pb::GetFoodLogSummaryResponse {
                food_log_summary: None,
            }));
        };
        let summary = FoodLogSummary { food_logs: logs }.encode_to_vec();
        if summary.len() > MAX_FOOD_LOG_SUMMARY_BYTES {
            return Err(Status::resource_exhausted("food log summary is too large"));
        }
        let sealed = self
            .keys
            .seal(&kid, &summary, b"")
            .map_err(|_| Status::unavailable("food log summary could not be sealed"))?;
        Ok(Response::new(pb::GetFoodLogSummaryResponse {
            food_log_summary: Some(cosmos_protocol::common::encryption::EncryptedData {
                encryption_information: Some(
                    cosmos_protocol::common::encryption::EncryptionInformation { kid: sealed.kid },
                ),
                data: sealed.data,
            }),
        }))
    }

    async fn get_memory_share_link(
        &self,
        request: Request<pb::GetShareLinkRequest>,
    ) -> Result<Response<pb::GetShareLinkResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let request = request.into_inner();
        if request.memory_uuid.trim().is_empty() {
            return Err(Status::invalid_argument("memory_uuid is required"));
        }
        let owner = principal.expose_for_authorization();
        if self
            .store
            .memory(owner, request.memory_uuid.trim())
            .await?
            .is_none()
        {
            return Err(Status::not_found("memory was not found"));
        }
        let expiry = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
            + SHARE_TTL_SECONDS;
        let token = mint_share_capability(
            self.share_secret.as_deref(),
            &ShareCapability {
                owner: owner.to_owned(),
                memory_uuid: request.memory_uuid.clone(),
                expiry,
            },
        )?;
        let share_link = self
            .share_endpoint
            .resource_url(SHARE_BASE_URL_ENV, &token)?;
        let mut share_link = Url::parse(&share_link)
            .map_err(|_| Status::internal("share link could not be constructed"))?;
        share_link
            .query_pairs_mut()
            .append_pair("memory_uuid", &request.memory_uuid)
            .append_pair("signature", &token)
            .append_pair("expiry", &expiry.to_string());
        Ok(Response::new(pb::GetShareLinkResponse {
            share_link: share_link.into(),
        }))
    }

    async fn get_share_link_contents(
        &self,
        request: Request<pb::GetShareLinkContentsRequest>,
    ) -> Result<Response<pb::GetShareLinkContentsResponse>, Status> {
        self.authenticator.authenticate(&request)?;
        let data = request
            .into_inner()
            .share_link_data
            .ok_or_else(|| Status::invalid_argument("share_link_data is required"))?;
        let capability = open_share_capability(self.share_secret.as_deref(), &data)?;
        let record = self
            .store
            .memory(&capability.owner, &capability.memory_uuid)
            .await?
            .ok_or_else(|| Status::not_found("shared memory was not found"))?;
        let bytes = opened_thumbnail(&self.capture_keys, &record)
            .await
            .ok_or_else(|| Status::failed_precondition("shared thumbnail is unavailable"))?;
        Ok(Response::new(pb::GetShareLinkContentsResponse {
            decrypted_thumbnail_bytes: bytes,
        }))
    }

    async fn report_photography_experience_status(
        &self,
        _request: Request<pb::ReportPhotographyExperienceStatusRequest>,
    ) -> Result<Response<pb::ReportPhotographyExperienceStatusResponse>, Status> {
        // Pure telemetry report -> accept and ack.
        Ok(Response::new(
            pb::ReportPhotographyExperienceStatusResponse {},
        ))
    }

    async fn save_shared_memory(
        &self,
        request: Request<pb::SaveSharedMemoryRequest>,
    ) -> Result<Response<pb::SaveSharedMemoryResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let data = request_share_data(request.into_inner())?;
        let capability = open_share_capability(self.share_secret.as_deref(), &data)?;
        let source = self
            .store
            .memory(&capability.owner, &capability.memory_uuid)
            .await?
            .ok_or_else(|| Status::not_found("shared memory was not found"))?;
        let files_per_burst = source
            .bursts
            .first()
            .map(|burst| burst.files.len() as i32)
            .unwrap_or(0);
        let created = self
            .store
            .create_memory(
                principal.expose_for_authorization(),
                crate::store::NewMemory {
                    kind: source.kind,
                    device_local_id: format!("shared:{}", capability.memory_uuid),
                    bursts: source.bursts.len() as i32,
                    files_per_burst,
                    device_created_time: source.device_created_time,
                    gmt_offset: source.gmt_offset,
                    thumbnails: source.thumbnails.clone(),
                    encrypted_location: None,
                },
            )
            .await?;
        self.copy_shared_objects(
            &capability.owner,
            &source,
            principal.expose_for_authorization(),
            &created,
        )
        .await?;
        Ok(Response::new(pb::SaveSharedMemoryResponse {
            created_memory_uuid: created.uuid,
        }))
    }

    /// Record that the device finished uploading a capture's assets.
    ///
    /// This used to ack `STATUS_ACKNOWLEDGED` without writing anything, so the
    /// capture stayed marked incomplete forever while
    /// `AssetUploadWorkerImpl.handleUploadSuccess` deleted the device's own copy
    /// — the only remaining record that the frames were ever uploaded.
    ///
    /// The status choices come straight from that worker's response switch:
    ///
    /// * `STATUS_ACKNOWLEDGED` completes its future — the only outcome that lets
    ///   the wearer's capture finish.
    /// * `STATUS_INTERNAL_ERROR` is retried, which is right for a store outage:
    ///   the completion is real, we just could not write it down yet.
    /// * `STATUS_MEMORY_NOT_FOUND` falls to its `default` arm and is FATAL — the
    ///   device gives up on the asset. Correct only when we genuinely hold no
    ///   such capture, which is why a failed write must never report it.
    /// * `STATUS_UPLOAD_INCOMPLETE` is also retried, and additionally resets
    ///   `lastImgUploadedIdx` to 0 so the device re-uploads from the first
    ///   frame. That is the answer to a claimed success this server cannot
    ///   witness — see [`AssetArrival`].
    /// * `STATUS_UNSPECIFIED` is never returned: for any status other than
    ///   `UPLOAD_FAILURE_FINAL` that arm completes the device's future neither
    ///   normally nor exceptionally, and the upload worker hangs.
    async fn upload_complete(
        &self,
        request: Request<pb::UploadCompleteRequest>,
    ) -> Result<Response<pb::UploadCompleteResponse>, Status> {
        use pb::upload_complete_response::Status as Ack;

        let principal = self.principal(&request)?;
        let request = request.into_inner();
        let Some(identity) = memory_identity(&request.memory_uuid, request.memory_id) else {
            return Ok(Response::new(pb::UploadCompleteResponse {
                status: Ack::BadRequest as i32,
            }));
        };
        let owner = principal.expose_for_authorization();

        // `?`, not `.is_some()`. A store outage here used to be reported as
        // MEMORY_NOT_FOUND, which `AssetUploadWorkerImpl`'s response switch does
        // not enumerate (it handles 1..6; MEMORY_NOT_FOUND is 7) so it falls to
        // `default:` = FATAL. UNAVAILABLE is the retryable answer.
        let Some(record) = self.store.memory(owner, &identity).await? else {
            return Ok(Response::new(pb::UploadCompleteResponse {
                status: Ack::MemoryNotFound as i32,
            }));
        };

        // The device reports failures through this same RPC. Only a reported
        // SUCCESS means the assets are up; marking a capture complete on a
        // failure report would claim frames we do not have.
        if request.success != pb::UploadCompletionStatus::UploadSuccess as i32 {
            return Ok(Response::new(pb::UploadCompleteResponse {
                status: Ack::Acknowledged as i32,
            }));
        }

        // A reported SUCCESS is a CLAIM, and acting on it is destructive: the
        // ack is what makes `AssetUploadWorkerImpl.handleUploadSuccess` call
        // `delete(uploadableAssetEntity)` and, with `deleteCapturesOnUpload`
        // set, `mFileSystem.deleteDirectory(...)` — the wearer's only copy of
        // the frames. So the claim is only honoured after the stored objects
        // have been read back.
        //
        // `STATUS_UPLOAD_INCOMPLETE` is the worker's own arm for "you say you
        // finished, I do not have it": it resets `lastImgUploadedIdx` to 0 and
        // raises ITEM_RETRYABLE, so the device re-uploads from the first frame
        // and keeps everything. After `mMaxUploadAttempts` that path becomes
        // `handleFatalError`, which marks the asset unuploadable and logs
        // "not deleting capture" — bounded, and still no wearer data loss.
        if !self.upload_bytes_landed(owner, &record).await {
            return Ok(Response::new(pb::UploadCompleteResponse {
                status: Ack::UploadIncomplete as i32,
            }));
        }

        let status = match self.store.record_upload_complete(owner, &identity).await {
            Ok(true) => Ack::Acknowledged,
            Ok(false) => Ack::MemoryNotFound,
            Err(_) => Ack::InternalError,
        };

        // `implemented`: Best Shot belongs to upload completion, not to a later
        // Center page visit. Acknowledge as soon as the durable write lands and
        // rank in the background so a slow/unavailable model never makes the
        // Pin retain or retry an otherwise complete upload.
        if status == Ack::Acknowledged
            && record.kind == crate::store::MemoryKind::Photo
            && record.thumbnails.len() > 1
            && let AssetArrival::Objects(objects) = &self.asset_arrival
        {
            let objects = Arc::clone(objects);
            let keys = Arc::clone(&self.capture_keys);
            let owner = owner.to_owned();
            tokio::spawn(async move {
                if objects
                    .rank_photo_best_frame(&keys, &owner, &record, false)
                    .await
                    .is_err()
                {
                    tracing::warn!("automatic best-frame selection could not be persisted");
                }
            });
        }
        Ok(Response::new(pb::UploadCompleteResponse {
            status: status as i32,
        }))
    }

    /// Hand back the URL the device should PUT one asset to.
    ///
    /// The caller is resolved here and the requested filename is checked
    /// against the slots THIS principal was allocated. Without that, the
    /// filename was an unchecked, caller-supplied storage key: any device on
    /// the mesh could name another wearer's asset path and be handed a write
    /// URL for it.
    ///
    /// Scoping is safe against stock because every filename the device sends is
    /// one this server minted. `AssetUploadWorkerImpl.processItem` reads
    /// `secureFilename` / `secureRawDataFilename` / `imuDataFilename` /
    /// `videoTimingDataFilename` straight off the stored `CreateMemoryResponse`,
    /// and the only other source — `uploadCalibration`'s server path — comes
    /// from `VideoMemoryResponse.calibration_data`, which this server does not
    /// populate. A filename that is not one of ours is not a stock asset.
    async fn upload_file(
        &self,
        request: Request<pb::UploadRequest>,
    ) -> Result<Response<pb::UploadResponse>, Status> {
        let principal = self.principal(&request)?;
        let request = request.into_inner();
        let filename = request.filename.trim();
        if filename.is_empty() {
            return Err(Status::invalid_argument("filename is required"));
        }
        let owner = principal.expose_for_authorization();
        self.authorize_upload_slot(owner, filename).await?;

        // Nowhere for the bytes to land means no URL. Handing one out anyway
        // would make the device PUT into the void and then report a success we
        // would have to refuse — the frames survive either way, but only this
        // arm tells the device the truth on the first step.
        let AssetArrival::Objects(objects) = &self.asset_arrival else {
            return Err(Status::unimplemented(
                "capture object storage is not configured",
            ));
        };

        // FAILED_PRECONDITION is not survivable for the device here.
        // `PhotographyUploadWorkerImpl.getErrorType` maps it to
        // WORKER_RETRYABLE, which reschedules the worker WITHOUT incrementing
        // the item's attempt count — with the served retry config (1_000_000
        // attempts @ 600s) the same asset is retried for the life of the pin and
        // never reaches a terminal state. UNIMPLEMENTED lands in that switch's
        // `default:` arm as UNKNOWN, which `handleItemError` treats like
        // ITEM_RETRYABLE: bounded by `mMaxUploadAttempts`, then `handleFatalError`
        // marks the asset unuploadable and explicitly does NOT delete the
        // capture. The device learns the upload cannot succeed and still keeps
        // the wearer's frames.
        //
        // The capability is minted only once the URL is known to be
        // constructible, so a misconfigured endpoint does not leave grants
        // hanging around unusable.
        let token = objects.grant(owner, filename);
        let url = self
            .upload_endpoint
            .resource_url(UPLOAD_BASE_URL_ENV, &token)
            .map_err(|absent| Status::unimplemented(absent.message().to_owned()))?;
        Ok(Response::new(pb::UploadResponse { url }))
    }
}

impl Capture {
    /// The object store backing this deployment, when there is one. `None` for
    /// a deployment that stores nothing — then a delete has no bytes to unlink
    /// and the tombstone is the whole of it.
    fn objects(&self) -> Option<&CaptureObjectStore> {
        match &self.asset_arrival {
            AssetArrival::Objects(objects) => Some(objects),
            AssetArrival::Unobservable => None,
            // The test stand-in confirms arrivals without a filesystem, so it
            // has nothing to unlink either.
            #[cfg(test)]
            AssetArrival::Confirmed => None,
        }
    }

    /// Whether the frames this capture allocated slots for are actually stored.
    ///
    /// The device uploads the files of burst ZERO only
    /// (`AssetUploadWorkerImpl.processItem` reads
    /// `captureBurst.get(0).getFilesList()`), writing each frame to either
    /// `secure_filename` (JPG mode) or `secure_raw_data_filename` (YUV mode) —
    /// never both — plus, for video, the imu and timing files when the device
    /// has them. So "every frame of burst zero is stored under one of its two
    /// secure slots" is the strongest true statement about the wearer's data,
    /// and it is exactly the plan the device itself follows. The imu/timing
    /// files are not required: the device skips them whenever its local path is
    /// null, so demanding them would strand every such capture.
    ///
    /// A capture with no allocated bursts cannot be confirmed at all. That is
    /// deliberate: notes and food logs carry no frames and no worker sends
    /// `UploadComplete` for them.
    async fn upload_bytes_landed(
        &self,
        principal: &str,
        record: &crate::store::MemoryRecord,
    ) -> bool {
        let objects = match &self.asset_arrival {
            AssetArrival::Unobservable => return false,
            #[cfg(test)]
            AssetArrival::Confirmed => return true,
            AssetArrival::Objects(objects) => objects,
        };
        let Some(first) = record.bursts.first() else {
            return false;
        };
        if first.files.is_empty() {
            return false;
        }
        for file in &first.files {
            let landed = objects.holds(principal, &file.secure_filename).await
                || objects
                    .holds(principal, &file.secure_raw_data_filename)
                    .await;
            if !landed {
                return false;
            }
        }
        true
    }

    /// Reject any filename that is not an upload slot allocated to `principal`.
    ///
    /// Unknown capture and another wearer's capture answer identically, so the
    /// response cannot be used to probe for someone else's memories. Both are
    /// PERMISSION_DENIED, which `getErrorType` classes ITEM_RETRYABLE — bounded
    /// on the device, unlike the worker-retryable codes.
    async fn authorize_upload_slot(&self, principal: &str, filename: &str) -> Result<(), Status> {
        // Same status for "not shaped like a slot" and "not yours" would hide a
        // device bug, so a malformed path is called out separately. Both are
        // item-retryable.
        let Some(memory_uuid) = slot_memory_uuid(filename) else {
            return Err(Status::invalid_argument(
                "filename is not an upload slot path",
            ));
        };
        let denied = || Status::permission_denied("filename is not an allocated upload slot");
        // Scoped read: a capture belonging to another principal is simply
        // absent, so there is no cross-principal branch to get wrong.
        let Some(record) = self.store.memory(principal, memory_uuid).await? else {
            return Err(denied());
        };
        let allocated = record
            .bursts
            .iter()
            .flat_map(|burst| &burst.files)
            .any(|f| {
                [
                    &f.filename,
                    &f.metadata_filename,
                    &f.secure_filename,
                    &f.secure_raw_data_filename,
                    &f.imu_data_filename,
                    &f.video_timing_data_filename,
                ]
                .into_iter()
                .any(|slot| slot == filename)
            });
        if allocated { Ok(()) } else { Err(denied()) }
    }
}

/// The capture a slot filename belongs to, if the string is shaped like a slot
/// this server allocates at all.
///
/// `store::build_memory` mints them as `{memory}/{burst}/{file}.{ext}`, all
/// three segments server-minted UUIDs. Anything else — a traversal, an absolute
/// path, an empty or dotted segment, a backslash, a control character — is not
/// a slot and is refused before it reaches the store. The exact-match check in
/// [`Capture::authorize_upload_slot`] is the actual gate; this only keeps a
/// malformed key from being carried any further.
fn slot_memory_uuid(filename: &str) -> Option<&str> {
    Some(slot_shape(filename)?.0)
}

/// The three path segments of a slot filename, if it is shaped like one.
///
/// This is the single place that decides a slot string is safe to turn into a
/// path, and it is applied twice: once by `UploadFile` before any store lookup,
/// and once by [`CaptureObjectStore::object_path`] at the moment a path is
/// built. Every segment is non-empty, is neither `.` nor `..`, holds no
/// separator or control character, and is bounded in length, so joining them
/// onto the storage root cannot escape it.
fn slot_shape(filename: &str) -> Option<(&str, &str, &str)> {
    let mut segments = filename.split('/');
    let memory = segments.next()?;
    let burst = segments.next()?;
    let file = segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    for segment in [memory, burst, file] {
        safe_slot_segment(segment)?;
    }
    Some((memory, burst, file))
}

fn safe_slot_segment(segment: &str) -> Option<&str> {
    let traversable = segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.len() > MAX_SLOT_SEGMENT_LEN
        || segment.contains('/')
        || segment.contains('\\')
        || segment.contains(char::is_control);
    (!traversable).then_some(segment)
}

/// Which capture the device means.
///
/// `DeleteMemoryRequest` and `UploadCompleteRequest` both carry a uuid *and* a
/// numeric id, and different callers populate different ones: the shipping
/// workers send the uuid (`DeleteUploadWorkerImpl.deleteRecentFromWeb` and
/// `AssetUploadWorkerImpl.sendUploadComplete` both call `setMemoryUuid`), while
/// the manufacturing `UploadWorker` sends `setMemoryId`. Honouring only one of
/// them would silently no-op for the other caller, so the uuid is preferred and
/// the numeric id is the fallback. `None` means the request identified nothing.
fn memory_identity(memory_uuid: &str, memory_id: i64) -> Option<String> {
    let uuid = memory_uuid.trim();
    if !uuid.is_empty() {
        return Some(uuid.to_owned());
    }
    // A zero id is proto3's absent value, not capture zero.
    (memory_id != 0).then(|| memory_id.to_string())
}

/// Delete a capture, shared by `CaptureService` and `TestingAutomationService`
/// — the proto gives both services the same `DeleteMemory` RPC, and the test
/// automation surface must not be the one that quietly keeps the wearer's data
/// (`H4Device` drives it with `setMemoryUuid`).
///
/// The returned status is chosen against
/// `DeleteUploadWorkerImpl.handleDeleteMemoryResponse`:
///
/// * `SUCCESS` and `NOT_FOUND` both let the device drop its local row, which is
///   right in both cases — either we deleted it or we never had it.
/// * `FAILURE` is the only retryable arm, so a store that could not carry the
///   delete out must return exactly that. Reporting `SUCCESS` instead makes the
///   device forget a capture the cloud still holds.
///
/// **The frames go before the metadata does.** Tombstoning first and unlinking
/// after cannot be made correct: the tombstone hides the record from
/// `Store::memory`, and the record's bursts are the only description of which
/// objects belong to this capture, so a failure in between would strand the
/// wearer's photographs on the volume with nothing left able to name them. In
/// this order every step is idempotent — an already-absent object is fine, and a
/// retry of a half-finished delete finishes it.
async fn delete_memory(
    store: &crate::store::SharedStore,
    objects: Option<&CaptureObjectStore>,
    principal: &str,
    request: pb::DeleteMemoryRequest,
) -> Result<pb::DeleteMemoryStatus, Status> {
    let Some(identity) = memory_identity(&request.memory_uuid, request.memory_id) else {
        // `DeleteMemoryStatus` has no bad-request arm, and its two "fatal" arms
        // (UNSPECIFIED, NOT_AUTHORIZED) would both tell the device to drop the
        // row. A transport-level rejection is the honest answer, and matches how
        // the other RPCs here reject a missing required field.
        return Err(Status::invalid_argument(
            "memory_uuid or memory_id is required",
        ));
    };

    // Scoped read, so another principal's capture is simply absent and there is
    // no cross-principal branch to get wrong. `Err` is a store outage, not an
    // absence, and must not be answered with a status that drops the row.
    let record = match store.memory(principal, &identity).await {
        Ok(Some(record)) => record,
        Ok(None) => return Ok(pb::DeleteMemoryStatus::NotFound),
        Err(_) => return Ok(pb::DeleteMemoryStatus::Failure),
    };

    if let Some(objects) = objects
        && !objects
            .remove_slots(principal, &capture_slots(&record))
            .await
    {
        // Some of the wearer's bytes are still there. FAILURE is the arm that
        // makes the device retry; anything else tells it the deletion happened.
        return Ok(pb::DeleteMemoryStatus::Failure);
    }

    Ok(match store.delete_memory(principal, &identity).await {
        Ok(true) => pb::DeleteMemoryStatus::Success,
        // A concurrent delete got there first. Both are done, and NOT_FOUND
        // lets the device drop its row exactly as SUCCESS would.
        Ok(false) => pb::DeleteMemoryStatus::NotFound,
        Err(_) => pb::DeleteMemoryStatus::Failure,
    })
}

/// Every storage slot a capture was allocated.
///
/// All six per-file names across EVERY burst, not just burst zero — which is all
/// `AssetUploadWorkerImpl.processItem` uploads today. A delete that covered only
/// what we expect to be there would leave anything else behind forever, and this
/// is the wearer's one chance to have it removed.
fn capture_slots(record: &crate::store::MemoryRecord) -> Vec<String> {
    record
        .bursts
        .iter()
        .flat_map(|burst| &burst.files)
        .flat_map(|file| {
            [
                file.filename.clone(),
                file.metadata_filename.clone(),
                file.secure_filename.clone(),
                file.secure_raw_data_filename.clone(),
                file.imu_data_filename.clone(),
                file.video_timing_data_filename.clone(),
            ]
        })
        .filter(|slot| !slot.is_empty())
        .collect()
}

#[tonic::async_trait]
impl TestingAutomationService for TestingAutomation {
    /// Store the wearer's note and return the uuid it is filed under.
    ///
    /// The body is an `EncryptedData` blob the device sealed; we hold no key for
    /// it and store it verbatim — the note is readable only on the wearer's pin.
    /// Previously this acked CREATE_SUCCESS with an EMPTY uuid and dropped the
    /// note, so every note the wearer took was lost.
    async fn create_note(
        &self,
        request: Request<pb::DeviceCreateNoteRequest>,
    ) -> Result<Response<pb::DeviceCreateNoteResponse>, Status> {
        let principal = self.principal(&request)?;
        let note = request.into_inner();
        let record = self
            .store
            .create_note(
                principal.expose_for_authorization(),
                note.encrypted_note,
                note.encrypted_location,
            )
            .await?;
        // Index for retrieval when we hold the wearer's channel key. The stored
        // body stays sealed either way; this only makes the note findable.
        if let Some(sealed) = record.encrypted_note.as_ref() {
            let kid = sealed
                .encryption_information
                .as_ref()
                .map(|i| i.kid.clone())
                .unwrap_or_default();
            if let Ok(plaintext) = self.keys.open(&cosmos_crypto::EncryptedData {
                data: sealed.data.clone(),
                kid,
            }) {
                if let Ok(text) = String::from_utf8(plaintext) {
                    self.store
                        .index_note(principal.expose_for_authorization(), &record.uuid, &text)
                        .await;
                }
            }
        }

        Ok(Response::new(pb::DeviceCreateNoteResponse {
            status: pb::CreateMemoryResultStatus::CreateSuccess as i32,
            memory_uuid: record.uuid,
        }))
    }

    /// Delete every note this wearer has. The response carries no count, but the
    /// deletion must actually happen — a no-op here means the wearer asks to
    /// clear their notes and they silently come back.
    async fn delete_all_notes(
        &self,
        request: Request<pb::DeviceDeleteAllNotesRequest>,
    ) -> Result<Response<pb::DeviceDeleteAllNotesResponse>, Status> {
        let principal = self.principal(&request)?;
        self.store
            .delete_all_notes(principal.expose_for_authorization())
            .await?;
        Ok(Response::new(pb::DeviceDeleteAllNotesResponse {}))
    }

    /// Same delete as `CaptureService`, against the same store and the same
    /// object store — `H4Device` reaches captures through this surface.
    async fn delete_memory(
        &self,
        request: Request<pb::DeleteMemoryRequest>,
    ) -> Result<Response<pb::DeleteMemoryResponse>, Status> {
        let principal = self.principal(&request)?;
        let status = delete_memory(
            &self.store,
            self.objects.as_deref(),
            principal.expose_for_authorization(),
            request.into_inner(),
        )
        .await?;
        Ok(Response::new(pb::DeleteMemoryResponse {
            status: status as i32,
        }))
    }

    /// The wearer's notes, newest first, honoring the requested window and cap.
    async fn get_recent_notes(
        &self,
        request: Request<pb::DeviceGetRecentNotesRequest>,
    ) -> Result<Response<pb::DeviceGetRecentNotesResponse>, Status> {
        let principal = self.principal(&request)?;
        let query = request.into_inner();
        let to_cursor =
            |t: prost_types::Timestamp| crate::store::SyncTime::from_parts(t.seconds, t.nanos);
        let notes = self
            .store
            .recent_notes(
                principal.expose_for_authorization(),
                query.max_items,
                query.start_time.map(to_cursor),
                query.end_time.map(to_cursor),
            )
            .await?;
        Ok(Response::new(pb::DeviceGetRecentNotesResponse {
            note_responses: notes
                .into_iter()
                .map(|n| pb::DeviceGetSingleNoteResponse {
                    memory_uuid: n.uuid,
                    encrypted_note: n.encrypted_note,
                    encrypted_location: n.encrypted_location,
                })
                .collect(),
        }))
    }
}

#[cfg(test)]
mod tests {
    /// Who `Authentication::DevelopmentInsecure` resolves every caller to, so a
    /// test can look in the store under the same key the handler wrote to.
    const DEV_PRINCIPAL: &str = "development-insecure-principal";

    /// A service over a FRESH store, never the process singleton.
    ///
    /// The production `Default` impls resolve `MemoryStore::shared()`, which is a
    /// real `OnceLock` singleton — correct on the server, where every workload
    /// must see the one store the device established its channel key against. In
    /// a test it means rows written by one test are visible to every other test
    /// running in parallel, so an "empty account" assertion fails because some
    /// unrelated test wrote a note. These build the same services against an
    /// isolated in-memory store instead.
    fn fresh_store() -> crate::store::SharedStore {
        std::sync::Arc::new(crate::store::MemoryStore::default())
    }

    fn isolated_automation() -> TestingAutomation {
        TestingAutomation::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            fresh_store(),
            Default::default(),
        )
    }

    fn isolated_capture() -> Capture {
        Capture::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            fresh_store(),
            Default::default(),
        )
    }

    /// One photo capture on `svc`: its identity, plus the slot filename the
    /// device would upload the first frame to. `AssetUploadWorkerImpl.processItem`
    /// reads `secureRawDataFilename` off the stored `CreateMemoryResponse` for a
    /// photo, so that is the string a real `UploadRequest` carries.
    async fn create_photo(svc: &Capture, device_local_id: &str) -> (pb::Memory, String) {
        let response = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: 1,
                        num_pics_per_burst: 1,
                        device_local_id: device_local_id.to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .expect("create succeeds")
            .into_inner();
        let memory = response.memory.clone().expect("identity");
        let Some(pb::create_memory_response::Request::PhotoMemoryResponse(photo)) =
            response.request
        else {
            panic!("a photo request must produce a photo response");
        };
        (
            memory,
            photo.bursts[0].files[0].secure_raw_data_filename.clone(),
        )
    }

    fn upload_request(filename: String) -> pb::UploadRequest {
        pb::UploadRequest {
            filename,
            upload_type: pb::upload_request::UploadType::Image as i32,
            mime_encoding: "application/octet-stream".to_owned(),
        }
    }

    fn jpeg_with_luma(value: u8) -> Vec<u8> {
        use std::io::Cursor;

        let image = image::RgbImage::from_pixel(32, 32, image::Rgb([value, value, value]));
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, image::ImageFormat::Jpeg)
            .expect("test jpeg");
        bytes.into_inner()
    }

    /// REGRESSION: Best Shot used to be selected only when Center opened the
    /// capture list. The upload-complete path now calls this same helper, so a
    /// completed three-frame burst gets a durable hero without a page visit.
    #[tokio::test]
    async fn a_three_frame_burst_gets_a_durable_automatic_best_frame() {
        let objects = CaptureObjectStore::for_tests();
        let selected = objects
            .rank_opened_best_frame(
                DEV_PRINCIPAL,
                "memory-best-shot",
                vec![
                    (0, jpeg_with_luma(0)),
                    (1, jpeg_with_luma(127)),
                    (2, jpeg_with_luma(255)),
                ],
                false,
            )
            .await
            .unwrap()
            .expect("selection");

        assert_eq!(selected.frame, 1, "the well-exposed middle frame wins");
        assert_eq!(selected.method, "quality_v1");
        assert_eq!(
            objects
                .read_best_frame(DEV_PRINCIPAL, "memory-best-shot")
                .await
                .unwrap(),
            Some(selected),
            "the choice must survive beyond the ranking request"
        );
    }

    /// REGRESSION: CreateMemory used to ack CREATE_SUCCESS with no `Memory` and
    /// no bursts. `verifyResponse` passes that (proto3 `getUuid()` returns ""),
    /// so the device marked the capture permanent and then had nowhere to upload
    /// to — every photo and video was lost on the very next step.
    #[tokio::test]
    async fn a_photo_capture_gets_an_identity_and_somewhere_to_upload() {
        let svc = Capture::default();
        let response = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: 2,
                        num_pics_per_burst: 3,
                        device_local_id: "device-photo-1".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .expect("create succeeds")
            .into_inner();

        assert_eq!(
            response.status,
            pb::CreateMemoryResultStatus::CreateSuccess as i32
        );
        let memory = response.memory.expect("a Memory must be returned");
        assert!(!memory.uuid.is_empty(), "uuid is what the device keys on");
        assert!(!memory.id.is_empty());

        let Some(pb::create_memory_response::Request::PhotoMemoryResponse(photo)) =
            response.request
        else {
            panic!("the response arm must mirror the request");
        };
        assert_eq!(photo.bursts.len(), 2, "one burst per requested burst");
        for burst in &photo.bursts {
            assert!(!burst.uuid.is_empty());
            assert_eq!(burst.files.len(), 3, "one slot per pic");
            for file in &burst.files {
                // Without a filename the device has no upload target at all.
                assert!(!file.filename.is_empty());
                assert!(!file.secure_filename.is_empty());
            }
        }
    }

    /// REGRESSION: the slot counts went from the wire into `build_memory`'s
    /// allocations with nothing in between looking at their magnitude. This
    /// request is about ten bytes, so no decode limit sees it, and it asked the
    /// process to reserve hundreds of gigabytes — an allocator refusal at that
    /// size is `handle_alloc_error`, which ABORTS: the ai-bus container dies and
    /// takes every other wearer's in-flight capture, assistant turn and push with
    /// it, and one repeat does it again after the restart. Any authenticated
    /// caller on either plane could send it.
    ///
    /// If this test ever hangs or the runner dies instead of failing, that is the
    /// bug back: the refusal is gone and the allocation is being attempted.
    #[tokio::test]
    async fn a_capture_asking_for_a_ruinous_number_of_slots_is_refused() {
        let svc = isolated_capture();
        let status = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: i32::MAX,
                        num_pics_per_burst: i32::MAX,
                        device_local_id: "device-slot-flood".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .expect_err("a request for 2^31 bursts of 2^31 files must not be served");

        assert_eq!(
            status.code(),
            tonic::Code::InvalidArgument,
            "refused, and refused as a permanent error: the device's retry \
             config treats UNAVAILABLE as transient and would send it again"
        );
    }

    /// The same bound on the video arm, which feeds `num_videos` into the very
    /// same `bursts` field.
    #[tokio::test]
    async fn a_video_capture_asking_for_a_ruinous_number_of_segments_is_refused() {
        let svc = isolated_capture();
        let status = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::VideoMemoryRequest(
                    pb::VideoMemoryRequest {
                        num_videos: i32::MAX,
                        device_local_id: "device-video-flood".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .expect_err("a request for 2^31 video segments must not be served");

        assert_eq!(status.code(), tonic::Code::InvalidArgument);
    }

    /// The ceiling must not eat captures that sit under it. A bound that also
    /// refuses ordinary work is a worse outage than the one it prevents, and a
    /// stock burst is three frames — a thousandth of what this asks for.
    #[tokio::test]
    async fn a_capture_at_the_ceiling_is_still_served_every_slot() {
        let svc = isolated_capture();
        let response = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: crate::store::MAX_BURSTS,
                        num_pics_per_burst: crate::store::MAX_FILES_PER_BURST,
                        device_local_id: "device-at-ceiling".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .expect("a capture at the ceiling is an ordinary capture")
            .into_inner();

        let Some(pb::create_memory_response::Request::PhotoMemoryResponse(photo)) =
            response.request
        else {
            panic!("a photo request must produce a photo response");
        };
        assert_eq!(photo.bursts.len(), crate::store::MAX_BURSTS as usize);
        for burst in &photo.bursts {
            assert_eq!(
                burst.files.len(),
                crate::store::MAX_FILES_PER_BURST as usize,
                "every requested frame needs its own upload slot"
            );
        }
    }

    /// The device retries CreateMemory. A second uuid for the same capture would
    /// orphan the first attempt's upload slots.
    #[tokio::test]
    async fn a_retried_create_returns_the_same_memory() {
        let svc = Capture::default();
        let make = async || {
            svc.create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: 1,
                        num_pics_per_burst: 1,
                        device_local_id: "device-photo-retry".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
        };
        let first = make().await.unwrap().into_inner().memory.unwrap();
        let second = make().await.unwrap().into_inner().memory.unwrap();
        assert_eq!(
            first.uuid, second.uuid,
            "a retry must not mint a new capture"
        );
        assert_eq!(first.id, second.id);
    }

    /// REGRESSION: DeleteMemory acked SUCCESS without touching the store.
    /// `DeleteUploadWorkerImpl.handleDeleteMemoryResponse` deletes the device's
    /// local row on SUCCESS, so the wearer deleted a photo, was told it worked,
    /// and the cloud kept it forever with nothing left pointing at it.
    #[tokio::test]
    async fn deleting_a_capture_actually_deletes_it() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let svc = Capture::for_tests(store.clone(), AssetArrival::Confirmed);

        let created = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: 1,
                        num_pics_per_burst: 1,
                        device_local_id: "device-delete-1".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .unwrap()
            .into_inner()
            .memory
            .expect("identity");

        let deleted = svc
            .delete_memory(Request::new(pb::DeleteMemoryRequest {
                memory_id: 0,
                memory_uuid: created.uuid.clone(),
            }))
            .await
            .expect("delete succeeds")
            .into_inner();
        assert_eq!(deleted.status, pb::DeleteMemoryStatus::Success as i32);

        // The claim has to be true afterwards, not just well-shaped.
        assert!(
            store
                .memory(DEV_PRINCIPAL, &created.uuid)
                .await
                .unwrap()
                .is_none(),
            "a capture reported deleted must be gone"
        );

        // Deleting it again is NOT_FOUND, never a second fabricated SUCCESS.
        let again = svc
            .delete_memory(Request::new(pb::DeleteMemoryRequest {
                memory_id: 0,
                memory_uuid: created.uuid,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(again.status, pb::DeleteMemoryStatus::NotFound as i32);
    }

    /// A request naming no capture at all cannot be answered with a status that
    /// tells the device to drop its row.
    #[tokio::test]
    async fn a_delete_naming_no_capture_is_rejected() {
        let svc = Capture::default();
        let status = svc
            .delete_memory(Request::new(pb::DeleteMemoryRequest {
                memory_id: 0,
                memory_uuid: String::new(),
            }))
            .await
            .expect_err("an unidentified delete is rejected");
        assert_eq!(status.code(), tonic::Code::InvalidArgument);
    }

    /// REGRESSION: UploadComplete acked ACKNOWLEDGED without recording anything,
    /// so the capture stayed incomplete forever while
    /// `AssetUploadWorkerImpl.handleUploadSuccess` deleted the device's own copy.
    #[tokio::test]
    async fn upload_completion_is_recorded_and_unknown_captures_say_so() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let svc = Capture::for_tests(store.clone(), AssetArrival::Confirmed);
        let created = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: 1,
                        num_pics_per_burst: 1,
                        device_local_id: "device-upload-1".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .unwrap()
            .into_inner()
            .memory
            .expect("identity");
        assert!(
            !store
                .memory(DEV_PRINCIPAL, &created.uuid)
                .await
                .expect("store read")
                .expect("stored")
                .upload_complete
        );

        let ack = svc
            .upload_complete(Request::new(pb::UploadCompleteRequest {
                memory_uuid: created.uuid.clone(),
                success: pb::UploadCompletionStatus::UploadSuccess as i32,
                ..Default::default()
            }))
            .await
            .expect("upload_complete succeeds")
            .into_inner();
        assert_eq!(
            ack.status,
            pb::upload_complete_response::Status::Acknowledged as i32
        );
        assert!(
            store
                .memory(DEV_PRINCIPAL, &created.uuid)
                .await
                .expect("store read")
                .expect("stored")
                .upload_complete,
            "the completion the device was told we recorded must be recorded"
        );

        // A capture we do not hold is MEMORY_NOT_FOUND, not a fabricated ack.
        let unknown = svc
            .upload_complete(Request::new(pb::UploadCompleteRequest {
                memory_uuid: "never-created".to_owned(),
                success: pb::UploadCompletionStatus::UploadSuccess as i32,
                ..Default::default()
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            unknown.status,
            pb::upload_complete_response::Status::MemoryNotFound as i32
        );
    }

    /// The device reports its FAILURES through this RPC too. Marking a capture
    /// complete on one would claim frames that were never uploaded — and the
    /// answer still must not be STATUS_UNSPECIFIED, whose arm in
    /// `AssetUploadWorkerImpl` never completes the worker's future.
    #[tokio::test]
    async fn a_reported_upload_failure_is_acked_but_not_recorded_as_complete() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let svc = Capture::for_tests(store.clone(), AssetArrival::Confirmed);
        let created = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: 1,
                        num_pics_per_burst: 1,
                        device_local_id: "device-upload-failed".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .unwrap()
            .into_inner()
            .memory
            .expect("identity");

        for reported in [
            pb::UploadCompletionStatus::UploadFailure,
            pb::UploadCompletionStatus::UploadFailureFinal,
        ] {
            let ack = svc
                .upload_complete(Request::new(pb::UploadCompleteRequest {
                    memory_uuid: created.uuid.clone(),
                    success: reported as i32,
                    ..Default::default()
                }))
                .await
                .unwrap()
                .into_inner();
            assert_eq!(
                ack.status,
                pb::upload_complete_response::Status::Acknowledged as i32,
                "the worker's future must complete"
            );
            assert_ne!(
                ack.status,
                pb::upload_complete_response::Status::Unspecified as i32
            );
        }
        assert!(
            !store
                .memory(DEV_PRINCIPAL, &created.uuid)
                .await
                .expect("store read")
                .expect("stored")
                .upload_complete,
            "a reported failure is not a completed upload"
        );
    }

    /// The manufacturing `UploadWorker` identifies a capture by `memory_id`
    /// while the shipping workers use `memory_uuid`. Honouring only one would
    /// silently no-op for the other.
    #[tokio::test]
    async fn either_identifier_names_the_same_capture() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let svc = Capture::for_tests(store.clone(), AssetArrival::Confirmed);
        let created = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: 1,
                        num_pics_per_burst: 1,
                        device_local_id: "device-numeric-id".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .unwrap()
            .into_inner()
            .memory
            .expect("identity");
        let numeric: i64 = created.id.parse().expect("Memory.id is the numeric id");

        let ack = svc
            .upload_complete(Request::new(pb::UploadCompleteRequest {
                memory_id: numeric,
                memory_uuid: String::new(),
                success: pb::UploadCompletionStatus::UploadSuccess as i32,
                ..Default::default()
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            ack.status,
            pb::upload_complete_response::Status::Acknowledged as i32
        );

        let bad = svc
            .upload_complete(Request::new(pb::UploadCompleteRequest::default()))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            bad.status,
            pb::upload_complete_response::Status::BadRequest as i32,
            "a request naming no capture is BAD_REQUEST, never an ack"
        );
    }

    /// Isolation is a security property: one wearer must not be able to delete
    /// another's capture by naming its uuid.
    #[tokio::test]
    async fn a_delete_cannot_reach_another_principals_capture() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let victim = store
            .create_memory(
                "wearer-a",
                crate::store::NewMemory {
                    kind: crate::store::MemoryKind::Photo,
                    device_local_id: "a-1".to_owned(),
                    bursts: 1,
                    files_per_burst: 1,
                    device_created_time: None,
                    gmt_offset: 0,
                    thumbnails: Vec::new(),
                    encrypted_location: None,
                },
            )
            .await
            .expect("write succeeds");

        // The authenticated caller here is the development principal, not
        // "wearer-a", so the uuid must not be reachable.
        let svc = Capture::for_tests(store.clone(), AssetArrival::Confirmed);
        let response = svc
            .delete_memory(Request::new(pb::DeleteMemoryRequest {
                memory_id: 0,
                memory_uuid: victim.uuid.clone(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(response.status, pb::DeleteMemoryStatus::NotFound as i32);
        assert!(
            store
                .memory("wearer-a", &victim.uuid)
                .await
                .unwrap()
                .is_some(),
            "another principal's capture must survive"
        );
    }

    /// Notes and food logs carry no frames, so they get identity but no slots.
    #[tokio::test]
    async fn a_note_gets_identity_but_no_upload_slots() {
        let svc = Capture::default();
        let response = svc
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::NoteMemoryRequest(
                    pb::NoteMemoryRequest::default(),
                )),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(!response.memory.expect("identity").uuid.is_empty());
        assert!(matches!(
            response.request,
            Some(pb::create_memory_response::Request::NoteMemoryResponse(_))
        ));
    }

    use super::*;

    /// REGRESSION: notes were acked with an EMPTY uuid and dropped, so every
    /// note a wearer took was lost. The body stays an opaque sealed blob — the
    /// server holds no key for it.
    #[tokio::test]
    async fn a_note_is_stored_and_reads_back() {
        let automation = isolated_automation();
        let sealed = cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: "wearer-kid".to_owned(),
                },
            ),
            data: b"sealed note body".to_vec(),
        };

        let created = automation
            .create_note(Request::new(pb::DeviceCreateNoteRequest {
                encrypted_note: Some(sealed.clone()),
                encrypted_location: None,
            }))
            .await
            .expect("create_note succeeds")
            .into_inner();
        assert_eq!(
            created.status,
            pb::CreateMemoryResultStatus::CreateSuccess as i32
        );
        assert!(
            !created.memory_uuid.is_empty(),
            "the device keys the note on this uuid"
        );

        let notes = automation
            .get_recent_notes(Request::new(pb::DeviceGetRecentNotesRequest {
                max_items: 0,
                start_time: None,
                end_time: None,
            }))
            .await
            .expect("get_recent_notes succeeds")
            .into_inner();
        assert_eq!(notes.note_responses.len(), 1);
        let read = &notes.note_responses[0];
        assert_eq!(read.memory_uuid, created.memory_uuid);
        // Stored verbatim: the server never opened it.
        assert_eq!(
            read.encrypted_note.as_ref().map(|e| e.data.as_slice()),
            Some(b"sealed note body".as_slice())
        );

        // Clearing must actually clear — otherwise the wearer's notes come back.
        automation
            .delete_all_notes(Request::new(pb::DeviceDeleteAllNotesRequest {}))
            .await
            .expect("delete_all_notes succeeds");
        let after = automation
            .get_recent_notes(Request::new(pb::DeviceGetRecentNotesRequest {
                max_items: 0,
                start_time: None,
                end_time: None,
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(after.note_responses.is_empty(), "notes must stay deleted");
    }

    /// End to end: a note the wearer took is findable afterwards, and the search
    /// answers with UUIDS ONLY — the body never rides back over the wire.
    #[tokio::test]
    async fn a_stored_note_becomes_findable_by_search() {
        use crate::services::aibus_extra::WebSearch;
        use cosmos_protocol::aibus::web_search_service_server::WebSearchService;

        // One store + one key store, shared the way the workload wires them.
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("wearer-kid".to_owned(), [9u8; cosmos_crypto::AES_KEY_LEN]);
        let auth = crate::auth::RequestAuthenticator::new(
            crate::config::Authentication::DevelopmentInsecure,
        );
        let notes = TestingAutomation::new(auth.clone(), store.clone(), keys.clone());
        let search = WebSearch::new(auth, store.clone());

        // The device seals the note; the server stores it verbatim.
        let sealed = keys
            .seal("wearer-kid", b"buy oat milk and coffee filters", b"")
            .expect("seal");
        let created = notes
            .create_note(Request::new(pb::DeviceCreateNoteRequest {
                encrypted_note: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: sealed.kid.clone(),
                        },
                    ),
                    data: sealed.data,
                }),
                encrypted_location: None,
            }))
            .await
            .unwrap()
            .into_inner();

        let hits = search
            .search(Request::new(cosmos_protocol::aibus::SearchRequest {
                text_query: "oat milk".to_owned(),
            }))
            .await
            .expect("search succeeds")
            .into_inner();
        assert_eq!(hits.memories.len(), 1, "the note must be findable");
        assert_eq!(hits.memories[0].uuid, created.memory_uuid);

        // A query matching nothing returns empty rather than everything.
        let miss = search
            .search(Request::new(cosmos_protocol::aibus::SearchRequest {
                text_query: "bicycle repair".to_owned(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(miss.memories.is_empty());
    }

    /// A note sealed the way the DEVICE seals it must be searchable by its
    /// title as well as its text.
    ///
    /// `DataProtectionUtils.protectData(…, Note, …)` seals a `humane.capture.Note`
    /// PROTOBUF. Decoding that as UTF-8 usually fails, so the note was silently
    /// left unindexed — saved, acknowledged, and unfindable. `Note` carries both
    /// `title` and `text`, and .Center displayed titles, so a wearer searching
    /// for one should find it.
    #[tokio::test]
    async fn a_device_sealed_note_is_searchable_by_title_and_text() {
        use prost::Message as _;

        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("wearer-kid".to_owned(), [6u8; cosmos_crypto::AES_KEY_LEN]);
        let auth = crate::auth::RequestAuthenticator::new(
            crate::config::Authentication::DevelopmentInsecure,
        );
        let capture = Capture::new(auth, store.clone(), keys.clone());

        // Exactly what the device puts in the envelope: a Note message.
        let note = cosmos_protocol::capture::Note {
            text: "bring the blue folder".to_owned(),
            title: "Monday standup".to_owned(),
            ..Default::default()
        };
        let sealed = keys
            .seal("wearer-kid", &note.encode_to_vec(), b"")
            .expect("seal");
        capture
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::NoteMemoryRequest(
                    pb::NoteMemoryRequest {
                        encrypted_note: Some(cosmos_protocol::common::encryption::EncryptedData {
                            encryption_information: Some(
                                cosmos_protocol::common::encryption::EncryptionInformation {
                                    kid: sealed.kid.clone(),
                                },
                            ),
                            data: sealed.data.clone(),
                        }),
                        encrypted_location: None,
                    },
                )),
            }))
            .await
            .expect("create_memory succeeds");

        for term in ["folder", "standup"] {
            let found = store
                .search_notes("development-insecure-principal", term, 5)
                .await
                .expect("search runs");
            assert!(
                !found.is_empty(),
                "a device-sealed note must be findable by {term:?}",
            );
        }

        // The assertion that actually distinguishes the fix. Reading the envelope
        // as UTF-8 "works" for an ASCII note — protobuf framing bytes are low and
        // the decode succeeds — but it indexes
        // `\x12\x15bring the blue folder*\x0eMonday standup`: length prefixes and
        // field tags stored as if they were words. Substring search still matched,
        // which is exactly why this went unnoticed. The index must hold the note,
        // not the wire format.
        let notes = store
            .recent_notes("development-insecure-principal", 0, None, None)
            .await
            .expect("read back");
        let indexed = notes
            .iter()
            .find_map(|n| n.indexed_text.clone())
            .expect("the note was indexed");
        assert!(
            !indexed.chars().any(|c| c.is_control()),
            "indexed text must not carry protobuf framing: {indexed:?}",
        );
        assert_eq!(
            indexed.trim(),
            "monday standup bring the blue folder",
            "title and text, in that order, and nothing else",
        );
    }

    /// A note taken on the PIN must be findable afterwards.
    ///
    /// Storing and indexing are different things: both search paths
    /// (`recall_memory`, `WebSearchService.Search`) filter on `indexed_text` and
    /// skip anything without it. The indexing step lived only in
    /// `TestingAutomationService::create_note`, so a note that arrived on the
    /// path a real Pin uses was stored, acknowledged, and then invisible to
    /// every search — the exact false negative the recall code elsewhere works
    /// hard to avoid.
    #[tokio::test]
    async fn a_note_taken_on_the_pin_is_searchable_afterwards() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("wearer-kid".to_owned(), [5u8; cosmos_crypto::AES_KEY_LEN]);
        let auth = crate::auth::RequestAuthenticator::new(
            crate::config::Authentication::DevelopmentInsecure,
        );
        let capture = Capture::new(auth.clone(), store.clone(), keys.clone());

        // The device seals the note, exactly as it does on the wire.
        let sealed = keys
            .seal("wearer-kid", b"the gate code is 4417", b"")
            .expect("seal");
        capture
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::NoteMemoryRequest(
                    pb::NoteMemoryRequest {
                        encrypted_note: Some(cosmos_protocol::common::encryption::EncryptedData {
                            encryption_information: Some(
                                cosmos_protocol::common::encryption::EncryptionInformation {
                                    kid: sealed.kid.clone(),
                                },
                            ),
                            data: sealed.data.clone(),
                        }),
                        encrypted_location: None,
                    },
                )),
            }))
            .await
            .expect("create_memory succeeds");

        // The claim under test: the wearer can find it again.
        let found = store
            .search_notes("development-insecure-principal", "gate", 5)
            .await
            .expect("search runs");
        assert!(
            !found.is_empty(),
            "a note taken on the pin must be searchable — storing it without \
             indexing leaves it saved, acknowledged, and unreachable by voice",
        );
    }

    /// REGRESSION: `CreateMemory` with a note must actually store the note.
    ///
    /// The note arm used to fall through the capture path, which records bursts
    /// and upload slots and has nowhere to put `encrypted_note` — so the body was
    /// dropped and the device was still told `CreateSuccess`. The wearer says
    /// "remember this", hears that it is saved, and nothing is saved. Asserting
    /// the RPC's status alone cannot catch that; only reading the note back can.
    #[tokio::test]
    async fn a_note_memory_actually_persists_its_body() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let auth = crate::auth::RequestAuthenticator::new(
            crate::config::Authentication::DevelopmentInsecure,
        );
        let capture = Capture::new(auth.clone(), store.clone(), Default::default());
        let automation = TestingAutomation::new(auth, store.clone(), Default::default());

        let body = cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: "wearer-kid".to_owned(),
                },
            ),
            data: b"sealed note body".to_vec(),
        };
        let created = capture
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::NoteMemoryRequest(
                    pb::NoteMemoryRequest {
                        encrypted_note: Some(body.clone()),
                        encrypted_location: None,
                    },
                )),
            }))
            .await
            .expect("create_memory succeeds")
            .into_inner();
        assert_eq!(
            created.status,
            pb::CreateMemoryResultStatus::CreateSuccess as i32
        );

        // The claim under test: it is actually there.
        let notes = automation
            .get_recent_notes(Request::new(pb::DeviceGetRecentNotesRequest {
                max_items: 0,
                start_time: None,
                end_time: None,
            }))
            .await
            .expect("get_recent_notes succeeds")
            .into_inner();
        assert_eq!(
            notes.note_responses.len(),
            1,
            "the wearer was told the note was saved; it must be readable back",
        );
        assert_eq!(
            notes.note_responses[0]
                .encrypted_note
                .as_ref()
                .map(|e| e.data.clone())
                .unwrap_or_default(),
            body.data,
            "the note body must survive, not just a metadata row",
        );
    }

    #[tokio::test]
    async fn read_rpcs_return_well_formed_empty() {
        // A device with no stored notes gets an empty list, not an error.
        let automation = isolated_automation();
        let notes = automation
            .get_recent_notes(Request::new(pb::DeviceGetRecentNotesRequest {
                max_items: 0,
                start_time: None,
                end_time: None,
            }))
            .await
            .expect("get_recent_notes succeeds")
            .into_inner();
        assert!(notes.note_responses.is_empty());

        // A message-typed read field comes back unset, not fabricated.
        let capture = isolated_capture();
        let summary = capture
            .get_food_log_summary(Request::new(pb::GetFoodLogSummaryRequest {
                start_time: Some(prost_types::Timestamp {
                    seconds: 0,
                    nanos: 0,
                }),
            }))
            .await
            .expect("get_food_log_summary succeeds")
            .into_inner();
        assert!(summary.food_log_summary.is_none());
    }

    #[tokio::test]
    async fn encrypted_food_logs_round_trip_through_a_validated_time_window() {
        use cosmos_protocol::common::food::{FoodItem, NutritionInfo};

        let store = fresh_store();
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("food-kid".to_owned(), [4u8; cosmos_crypto::AES_KEY_LEN]);
        let capture = Capture::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store,
            keys.clone(),
        );
        let log = FoodLog {
            food_item: Some(FoodItem {
                request_uuid: "food-request-1".to_owned(),
                item_name: "Oatmeal".to_owned(),
                typical_serving_size: "1 bowl".to_owned(),
                nutrition_info: vec![NutritionInfo {
                    nutrient_type: NutrientType::Calories as i32,
                    value: 250.0,
                }],
                brand: String::new(),
            }),
            servings_consumed: 1.5,
        };
        let sealed = keys
            .seal("food-kid", &log.encode_to_vec(), b"")
            .expect("food log seals");
        capture
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::FoodLogMemoryRequest(
                    pb::FoodLogMemoryRequest {
                        food_log: Some(cosmos_protocol::common::encryption::EncryptedData {
                            encryption_information: Some(
                                cosmos_protocol::common::encryption::EncryptionInformation {
                                    kid: sealed.kid,
                                },
                            ),
                            data: sealed.data,
                        }),
                        device_created_time: Some(prost_types::Timestamp {
                            seconds: 200,
                            nanos: 0,
                        }),
                        device_local_id: "food-local-1".to_owned(),
                    },
                )),
            }))
            .await
            .expect("food log memory stores");

        let summary = capture
            .get_food_log_summary(Request::new(pb::GetFoodLogSummaryRequest {
                start_time: Some(prost_types::Timestamp {
                    seconds: 150,
                    nanos: 0,
                }),
            }))
            .await
            .expect("summary reads")
            .into_inner()
            .food_log_summary
            .expect("matching summary");
        let opened = keys
            .open(&cosmos_crypto::EncryptedData {
                kid: summary.encryption_information.expect("summary key id").kid,
                data: summary.data,
            })
            .expect("summary opens");
        let decoded = FoodLogSummary::decode(opened.as_slice()).expect("summary decodes");
        assert_eq!(decoded.food_logs, vec![log]);

        let excluded = capture
            .get_food_log_summary(Request::new(pb::GetFoodLogSummaryRequest {
                start_time: Some(prost_types::Timestamp {
                    seconds: 201,
                    nanos: 0,
                }),
            }))
            .await
            .expect("later window reads")
            .into_inner();
        assert!(excluded.food_log_summary.is_none());
    }

    #[tokio::test]
    async fn share_and_upload_capabilities_are_randomized_and_share_round_trips() {
        let capture = Capture::with_endpoints(
            Some("https://share.clone.example/public"),
            Some("https://upload.clone.example/put/"),
        );

        let (memory, slot) = create_photo(&capture, "device-upload-url").await;
        let share_req = pb::GetShareLinkRequest {
            memory_uuid: memory.uuid.clone(),
        };
        let share_a = capture
            .get_memory_share_link(Request::new(share_req.clone()))
            .await
            .expect("share link generated")
            .into_inner();
        let share_b = capture
            .get_memory_share_link(Request::new(share_req))
            .await
            .expect("share link generated")
            .into_inner();
        assert_ne!(
            share_a.share_link, share_b.share_link,
            "each share link is a fresh bearer capability"
        );
        for link in [&share_a.share_link, &share_b.share_link] {
            assert!(link.starts_with("https://share.clone.example/public/capture/"));
        }

        // The only filenames the device ever names are slots this server
        // allocated it, so the test asks for one of those.
        let upload_req = upload_request(slot.clone());
        let upload_a = capture
            .upload_file(Request::new(upload_req.clone()))
            .await
            .expect("upload URL")
            .into_inner();
        let upload_b = capture
            .upload_file(Request::new(upload_req))
            .await
            .expect("upload URL")
            .into_inner();
        // The upload URL is a CREDENTIAL — the only thing standing between a
        // caller and a write into the wearer's capture slot. Two requests for
        // the same slot must therefore mint two different capabilities: a token
        // derived from the filename would be reconstructible by anyone who
        // could name a slot, which is an unauthenticated write endpoint.
        assert_ne!(
            upload_a.url, upload_b.url,
            "an upload URL derived from the request is guessable"
        );
        for url in [&upload_a.url, &upload_b.url] {
            assert!(url.starts_with("https://upload.clone.example/put/capture/"));
            let token = url.rsplit('/').next().expect("token segment");
            // 32 random bytes, base64url without padding.
            assert_eq!(token.len(), 43, "token is not 256 bits of entropy: {token}");
        }
        let objects = match &capture.asset_arrival {
            AssetArrival::Objects(objects) => objects.clone(),
            AssetArrival::Unobservable => panic!("test capture must have object storage"),
            AssetArrival::Confirmed => panic!("test capture must expose object storage"),
        };
        let upload_token = Url::parse(&upload_a.url)
            .expect("upload URL")
            .path_segments()
            .and_then(Iterator::last)
            .expect("upload capability")
            .to_owned();
        objects
            .accept(&upload_token, Some(&slot), b"full size image bytes")
            .await
            .expect("source asset is stored");

        fn share_data(link: &str) -> pb::ShareLinkData {
            let url = Url::parse(link).expect("share URL");
            let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
            pb::ShareLinkData {
                memory_uuid: query.get("memory_uuid").expect("memory uuid").clone(),
                signature: query.get("signature").expect("signature").clone(),
                expiry: query
                    .get("expiry")
                    .expect("expiry")
                    .parse()
                    .expect("integer expiry"),
            }
        }
        let data = share_data(&share_a.share_link);
        assert_eq!(data.memory_uuid, memory.uuid);

        // The capability can be redeemed into a durable memory owned by the
        // recipient. This pins the new non-stubbed SaveSharedMemory behavior.
        let saved = capture
            .save_shared_memory(Request::new(pb::SaveSharedMemoryRequest {
                memory_uuid: String::new(),
                signature: String::new(),
                expiry: 0,
                share_link_data: Some(data.clone()),
            }))
            .await
            .expect("shared memory is saved")
            .into_inner();
        assert!(!saved.created_memory_uuid.is_empty());
        assert_ne!(saved.created_memory_uuid, memory.uuid);
        let saved_record = capture
            .store
            .memory(DEV_PRINCIPAL, &saved.created_memory_uuid)
            .await
            .expect("saved memory read")
            .expect("saved memory exists");
        let saved_slot = &saved_record.bursts[0].files[0].secure_raw_data_filename;
        assert_eq!(
            objects
                .read(DEV_PRINCIPAL, saved_slot)
                .await
                .expect("saved object read")
                .as_deref(),
            Some(b"full size image bytes".as_slice()),
            "SaveSharedMemory must copy the original object, not only metadata"
        );

        // A photo without a thumbnail cannot fabricate share-link contents.
        let contents = capture
            .get_share_link_contents(Request::new(pb::GetShareLinkContentsRequest {
                share_link_data: Some(data),
            }))
            .await
            .expect_err("missing thumbnail is explicit");
        assert_eq!(contents.code(), tonic::Code::FailedPrecondition);
    }

    #[tokio::test]
    async fn url_rpcs_fail_honestly_without_configured_endpoints() {
        let capture = Capture::with_endpoints(None, None);
        let (memory, slot) = create_photo(&capture, "device-upload-unconfigured").await;

        let share = capture
            .get_memory_share_link(Request::new(pb::GetShareLinkRequest {
                memory_uuid: memory.uuid,
            }))
            .await
            .expect_err("share endpoint is absent");
        assert_eq!(share.code(), tonic::Code::FailedPrecondition);

        // UNIMPLEMENTED, not FAILED_PRECONDITION. `getErrorType` maps
        // FAILED_PRECONDITION to WORKER_RETRYABLE, which reschedules the worker
        // without ever advancing the item, so with the served retry config the
        // asset is retried for the life of the pin. UNIMPLEMENTED reaches the
        // bounded item path instead, which terminates at `handleFatalError` —
        // asset marked unuploadable, capture NOT deleted.
        let upload = capture
            .upload_file(Request::new(upload_request(slot)))
            .await
            .expect_err("upload endpoint is absent");
        assert_eq!(upload.code(), tonic::Code::Unimplemented);
        assert_ne!(
            upload.code(),
            tonic::Code::FailedPrecondition,
            "worker-retryable would strand the asset in an unbounded retry loop"
        );
    }

    #[tokio::test]
    async fn endpoint_config_rejects_embedded_secrets_and_non_http_urls() {
        let capture = Capture::with_endpoints(
            Some("https://user:secret@share.clone.example"),
            Some("file:///tmp/uploads"),
        );
        let (memory, slot) = create_photo(&capture, "device-upload-bad-endpoint").await;

        let share = capture
            .get_memory_share_link(Request::new(pb::GetShareLinkRequest {
                memory_uuid: memory.uuid,
            }))
            .await
            .expect_err("credential-bearing endpoint is rejected");
        assert_eq!(share.code(), tonic::Code::FailedPrecondition);

        let upload = capture
            .upload_file(Request::new(upload_request(slot)))
            .await
            .expect_err("non-HTTP endpoint is rejected");
        assert_eq!(upload.code(), tonic::Code::Unimplemented);
    }

    /// Isolation on the WRITE path. The filename in an `UploadRequest` is a
    /// storage key; unchecked, any caller the edge lets through could name
    /// another wearer's asset path and be handed a URL to write over it.
    #[tokio::test]
    async fn an_upload_url_is_only_issued_for_a_slot_the_caller_owns() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let victim = store
            .create_memory(
                "wearer-a",
                crate::store::NewMemory {
                    kind: crate::store::MemoryKind::Photo,
                    device_local_id: "a-upload".to_owned(),
                    bursts: 1,
                    files_per_burst: 1,
                    device_created_time: None,
                    gmt_offset: 0,
                    thumbnails: Vec::new(),
                    encrypted_location: None,
                },
            )
            .await
            .expect("write succeeds");
        let victim_slot = victim.bursts[0].files[0].secure_raw_data_filename.clone();

        // Authenticated as the development principal, not "wearer-a".
        let capture = Capture::for_upload_tests(
            store.clone(),
            CaptureObjectStore::for_tests(),
            "https://upload.clone.example/put/",
        );

        let denied = capture
            .upload_file(Request::new(upload_request(victim_slot.clone())))
            .await
            .expect_err("another wearer's slot is not writable");
        assert_eq!(denied.code(), tonic::Code::PermissionDenied);
        assert!(
            !denied.message().contains(&victim_slot),
            "the refusal must not echo another wearer's storage key back"
        );

        // The caller's own slot still resolves, so the gate is scoped and not
        // simply closed.
        let (_, own) = create_photo(&capture, "device-own-slot").await;
        let url = capture
            .upload_file(Request::new(upload_request(own)))
            .await
            .expect("an owned slot is writable")
            .into_inner();
        assert!(
            url.url
                .starts_with("https://upload.clone.example/put/capture/")
        );
    }

    /// Anything that is not one of our allocated slots is refused before it can
    /// become a storage key. The manufacturing `UploadWorker` (mfgtest) puts
    /// arbitrary local diagnostic filenames on this same RPC — none of those is
    /// a wearer's capture, and none is accepted.
    #[tokio::test]
    async fn upload_refuses_anything_that_is_not_an_allocated_slot() {
        let capture = Capture::with_endpoints(None, Some("https://upload.clone.example/put/"));
        let (_, owned) = create_photo(&capture, "device-slot-shapes").await;

        // Not shaped like a slot at all: traversal, absolute path, empty
        // segment, wrong depth.
        for filename in [
            "../../etc/passwd",
            "/etc/passwd",
            "a/../b/c.raw",
            "a//c.raw",
            "crash-dump.bin",
            "wearer/../../../root/.ssh/id_rsa",
        ] {
            let refused = capture
                .upload_file(Request::new(upload_request(filename.to_owned())))
                .await
                .unwrap_err();
            assert_eq!(
                refused.code(),
                tonic::Code::InvalidArgument,
                "{filename} must not resolve to an upload URL"
            );
        }

        // Correctly shaped, but naming a capture this caller does not hold.
        let foreign = capture
            .upload_file(Request::new(upload_request(
                "11111111-1111-4111-8111-111111111111/burst/file.raw".to_owned(),
            )))
            .await
            .unwrap_err();
        assert_eq!(foreign.code(), tonic::Code::PermissionDenied);

        // The caller's own capture, but not a slot it was allocated.
        let tampered = capture
            .upload_file(Request::new(upload_request(format!("{owned}.extra"))))
            .await
            .unwrap_err();
        assert_eq!(tampered.code(), tonic::Code::PermissionDenied);
    }

    /// REGRESSION: a claimed UPLOAD_SUCCESS was acknowledged without the server
    /// ever receiving a byte. The acknowledgement is what makes
    /// `AssetUploadWorkerImpl.handleUploadSuccess` run
    /// `delete(uploadableAssetEntity)` — and with `deleteCapturesOnUpload`,
    /// `mFileSystem.deleteDirectory(captureDirectory())`, the wearer's only copy
    /// of the frames. It must never be issued on the device's word alone.
    #[tokio::test]
    async fn a_claimed_upload_success_is_refused_when_no_bytes_can_have_landed() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        // Production shape: no object storage, so no arrival can be witnessed.
        let svc = Capture::for_tests(store.clone(), AssetArrival::Unobservable);
        let (created, _) = create_photo(&svc, "device-unconfirmed-upload").await;

        let ack = svc
            .upload_complete(Request::new(pb::UploadCompleteRequest {
                memory_uuid: created.uuid.clone(),
                success: pb::UploadCompletionStatus::UploadSuccess as i32,
                ..Default::default()
            }))
            .await
            .expect("upload_complete succeeds")
            .into_inner();
        assert_ne!(
            ack.status,
            pb::upload_complete_response::Status::Acknowledged as i32,
            "acknowledging an unwitnessed upload deletes the wearer's only copy"
        );
        // STATUS_UPLOAD_INCOMPLETE is the worker's own arm for this: it resets
        // `lastImgUploadedIdx` to 0 and retries the item, bounded by
        // `mMaxUploadAttempts`, and never deletes the capture.
        assert_eq!(
            ack.status,
            pb::upload_complete_response::Status::UploadIncomplete as i32
        );
        assert!(
            !store
                .memory(DEV_PRINCIPAL, &created.uuid)
                .await
                .expect("store read")
                .expect("stored")
                .upload_complete,
            "an upload the server never witnessed must not be recorded as complete"
        );

        // A capture we do not hold is still MEMORY_NOT_FOUND, not a claim we
        // half-believe.
        let unknown = svc
            .upload_complete(Request::new(pb::UploadCompleteRequest {
                memory_uuid: "never-created".to_owned(),
                success: pb::UploadCompletionStatus::UploadSuccess as i32,
                ..Default::default()
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            unknown.status,
            pb::upload_complete_response::Status::MemoryNotFound as i32
        );
    }

    /// A capability is spendable exactly once, and only for the slot it names.
    ///
    /// The URL is the whole credential — nothing else authenticates the PUT —
    /// so a replayable or slot-agnostic one is a write primitive over a
    /// wearer's capture directory.
    #[tokio::test]
    async fn an_upload_capability_is_single_use_and_bound_to_its_own_slot() {
        let objects = CaptureObjectStore::for_tests();
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let capture = Capture::for_upload_tests(
            store.clone(),
            objects.clone(),
            "https://upload.clone.example/put/",
        );
        let (_, slot) = create_photo(&capture, "device-capability").await;
        let other = create_photo(&capture, "device-capability-other").await.1;

        let url = capture
            .upload_file(Request::new(upload_request(slot.clone())))
            .await
            .expect("upload URL")
            .into_inner()
            .url;
        let token = url.rsplit('/').next().expect("token").to_owned();

        // Naming a different slot in the `file:` header does not redirect the
        // write.
        assert_eq!(
            objects.accept(&token, Some(&other), b"frame").await,
            Err(UploadRejection::Unauthorized)
        );
        assert!(
            !objects.holds(DEV_PRINCIPAL, &other).await,
            "a header must never choose the destination"
        );

        assert_eq!(objects.accept(&token, Some(&slot), b"frame").await, Ok(()));
        assert!(objects.holds(DEV_PRINCIPAL, &slot).await);

        // Spent. A replay of the same URL is refused with the same answer an
        // unknown token gets, so a caller cannot mine the response for live
        // capabilities.
        assert_eq!(
            objects.accept(&token, Some(&slot), b"replayed").await,
            Err(UploadRejection::Unauthorized)
        );
        assert_eq!(
            objects.accept("not-a-real-token", None, b"frame").await,
            Err(UploadRejection::Unauthorized)
        );
    }

    /// An expired capability is dead even though the bytes and the slot are
    /// still valid.
    #[tokio::test]
    async fn an_expired_upload_capability_is_refused() {
        let objects = CaptureObjectStore::for_tests_with_ttl(Duration::from_millis(1));
        let token = objects.grant(DEV_PRINCIPAL, "memory/burst/file.raw");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            objects.accept(&token, None, b"frame").await,
            Err(UploadRejection::Unauthorized)
        );
        assert!(!objects.holds(DEV_PRINCIPAL, "memory/burst/file.raw").await);
    }

    /// A body over the ceiling is refused outright. The HTTP layer also caps the
    /// request body, but the store must not depend on that: it is the thing that
    /// writes to the volume.
    #[tokio::test]
    async fn an_oversized_asset_is_refused_and_an_empty_one_stores_nothing() {
        let objects = CaptureObjectStore::for_tests_with_limit(MIN_MAX_UPLOAD_BYTES);
        let slot = "memory/burst/file.raw";

        let token = objects.grant(DEV_PRINCIPAL, slot);
        assert_eq!(
            objects
                .accept(&token, None, &vec![7u8; MIN_MAX_UPLOAD_BYTES + 1])
                .await,
            Err(UploadRejection::TooLarge)
        );
        assert!(!objects.holds(DEV_PRINCIPAL, slot).await);

        // Refusing did not spend the capability, so a correctly-sized retry on
        // the same URL still works.
        assert_eq!(objects.accept(&token, None, b"frame").await, Ok(()));

        let empty = objects.grant(DEV_PRINCIPAL, "memory/burst/other.raw");
        assert_eq!(
            objects.accept(&empty, None, b"").await,
            Err(UploadRejection::Empty)
        );
        assert!(!objects.holds(DEV_PRINCIPAL, "memory/burst/other.raw").await);
    }

    /// Two wearers with identically-named slots must not share a file, and
    /// neither can reach the other's.
    #[tokio::test]
    async fn stored_objects_are_scoped_per_principal() {
        let objects = CaptureObjectStore::for_tests();
        let slot = "memory/burst/file.raw";

        let mine = objects.grant("wearer-a", slot);
        assert_eq!(objects.accept(&mine, None, b"wearer a frame").await, Ok(()));

        assert!(objects.holds("wearer-a", slot).await);
        assert!(
            !objects.holds("wearer-b", slot).await,
            "one wearer's frame must not answer for another's slot"
        );

        let theirs = objects.grant("wearer-b", slot);
        assert_eq!(
            objects.accept(&theirs, None, b"wearer b frame").await,
            Ok(())
        );
        let read = |principal: &str| {
            let path = objects.object_path(principal, slot).expect("path");
            std::fs::read(path).expect("stored object")
        };
        assert_eq!(read("wearer-a"), b"wearer a frame");
        assert_eq!(read("wearer-b"), b"wearer b frame");
    }

    #[tokio::test]
    async fn committed_object_reads_are_byte_exact_and_principal_scoped() {
        let objects = CaptureObjectStore::for_tests();
        let slot = "memory/burst/frame.jpg.secure";
        let token = objects.grant_for_tests("wearer-a", slot);
        assert_eq!(
            objects
                .accept(&token, Some(slot), b"sealed full photo")
                .await,
            Ok(())
        );

        assert_eq!(
            objects.read("wearer-a", slot).await.unwrap().as_deref(),
            Some(&b"sealed full photo"[..])
        );
        assert_eq!(
            objects.read("wearer-b", slot).await.unwrap(),
            None,
            "an identical slot name must not cross the principal directory"
        );
        assert_eq!(
            objects.read("wearer-a", "../escape/frame").await.unwrap(),
            None,
            "the read path must reject a slot that could escape its root"
        );
    }

    /// No slot string can produce a path outside the caller's own directory.
    /// The shape gate is applied again where the path is actually built, so a
    /// future caller of `object_path` cannot skip it.
    #[test]
    fn a_slot_can_never_escape_the_storage_root() {
        let objects = CaptureObjectStore::for_tests();
        let root = objects.root().to_owned();
        for hostile in [
            "../../etc/passwd",
            "/etc/passwd",
            "a/../b/c.raw",
            "a//c.raw",
            "crash-dump.bin",
            "wearer/../../../root/.ssh/id_rsa",
            "memory/burst/..",
            "memory/../burst/file.raw",
            "memory/burst/file.raw/extra",
        ] {
            assert!(
                objects.object_path(DEV_PRINCIPAL, hostile).is_none(),
                "{hostile} must not resolve to a path"
            );
        }
        let safe = objects
            .object_path(DEV_PRINCIPAL, "memory/burst/file.raw")
            .expect("a well-shaped slot resolves");
        assert!(safe.starts_with(&root));
        assert_eq!(
            safe.components().count(),
            root.components().count() + 4,
            "principal directory plus the three slot segments"
        );
    }

    /// Backdate a file so age-based retention is observable without waiting.
    fn backdate(path: &Path, by: Duration) {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open for backdating");
        file.set_modified(SystemTime::now() - by)
            .expect("set modification time");
    }

    /// REGRESSION: `DeleteMemory` tombstoned the metadata row and never touched
    /// the volume, so a photograph the wearer explicitly deleted stayed on disk
    /// forever — and `DeleteUploadWorkerImpl.handleDeleteMemoryResponse` had
    /// already dropped the device's own row on SUCCESS, leaving nothing that
    /// could ever name the file again.
    ///
    /// The claim is checked by reading the filesystem, not by trusting the
    /// status: a well-shaped SUCCESS is exactly what the bug returned.
    #[tokio::test]
    async fn deleting_a_capture_removes_its_stored_frames() {
        let objects = CaptureObjectStore::for_tests();
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let capture = Capture::for_upload_tests(
            store.clone(),
            objects.clone(),
            "https://upload.clone.example/put/",
        );

        // Straight through the real path: allocate a capture, take an upload
        // URL for its slot, and spend the capability on the wearer's frame.
        let (memory, slot) = create_photo(&capture, "device-delete-bytes").await;
        let url = capture
            .upload_file(Request::new(upload_request(slot.clone())))
            .await
            .expect("upload URL")
            .into_inner()
            .url;
        let token = url.rsplit('/').next().expect("token").to_owned();
        assert_eq!(
            objects.accept(&token, Some(&slot), b"wearer frame").await,
            Ok(())
        );
        let frame = objects
            .object_path_for_tests(DEV_PRINCIPAL, &slot)
            .expect("stored path");
        assert_eq!(
            std::fs::read(&frame).expect("stored frame"),
            b"wearer frame"
        );

        // Another wearer's identically-named slot, to prove the unlink is
        // scoped the same way the write was.
        let neighbour_token = objects.grant_for_tests("wearer-b", &slot);
        assert_eq!(
            objects
                .accept(&neighbour_token, Some(&slot), b"neighbour frame")
                .await,
            Ok(())
        );
        let neighbour_frame = objects
            .object_path_for_tests("wearer-b", &slot)
            .expect("stored path");

        let deleted = capture
            .delete_memory(Request::new(pb::DeleteMemoryRequest {
                memory_id: 0,
                memory_uuid: memory.uuid.clone(),
            }))
            .await
            .expect("delete succeeds")
            .into_inner();
        assert_eq!(deleted.status, pb::DeleteMemoryStatus::Success as i32);

        assert!(
            !frame.exists(),
            "a capture reported deleted must not still be on the volume",
        );
        // The capture's own directory goes with it, rather than accumulating
        // empty shells for the life of the deployment.
        assert!(
            !frame
                .parent()
                .and_then(Path::parent)
                .expect("capture directory")
                .exists(),
            "the emptied capture directory must be pruned",
        );
        assert!(
            store
                .memory(DEV_PRINCIPAL, &memory.uuid)
                .await
                .unwrap()
                .is_none(),
            "the metadata must go too",
        );

        assert_eq!(
            std::fs::read(&neighbour_frame).expect("neighbour's frame"),
            b"neighbour frame",
            "a delete must never reach another principal's bytes",
        );
    }

    /// Bounded retention for the server's OWN transient artefacts.
    ///
    /// A PUT that dies between `create` and `rename` leaves a `{token}.part`
    /// fragment nothing will ever claim — the token is single-use and already
    /// spent. Unswept they accumulate on the volume forever. The wearer's frames
    /// are on the other side of that line and are not touched by default.
    #[tokio::test]
    async fn abandoned_upload_fragments_are_swept_and_stored_frames_are_not() {
        let objects = CaptureObjectStore::for_tests_with_retention(Retention::default());
        let slot = "memory/burst/file.raw";

        // A frame the wearer uploaded a very long time ago.
        let token = objects.grant(DEV_PRINCIPAL, slot);
        assert_eq!(objects.accept(&token, None, b"wearer frame").await, Ok(()));
        let frame = objects
            .object_path_for_tests(DEV_PRINCIPAL, slot)
            .expect("stored path");
        backdate(&frame, Duration::from_secs(400 * 24 * 60 * 60));

        // Staging: one fragment from a write that died a week ago, one from a
        // transfer in flight right now, and a file this store did not write.
        let incoming = objects.root().join(INCOMING_DIR);
        std::fs::create_dir_all(&incoming).expect("staging directory");
        let abandoned = incoming.join("dGVzdC1hYmFuZG9uZWQ.part");
        std::fs::write(&abandoned, b"half a frame").expect("fragment");
        backdate(&abandoned, Duration::from_secs(7 * 24 * 60 * 60));
        let in_flight = incoming.join("dGVzdC1pbi1mbGlnaHQ.part");
        std::fs::write(&in_flight, b"half a frame").expect("fragment");
        let unrecognised = incoming.join("operator-put-this-here");
        std::fs::write(&unrecognised, b"not ours").expect("file");
        backdate(&unrecognised, Duration::from_secs(7 * 24 * 60 * 60));

        // The production trigger: a sweep rides on an authorized upload.
        let next = objects.grant(DEV_PRINCIPAL, "memory/burst/other.raw");
        assert_eq!(objects.accept(&next, None, b"another frame").await, Ok(()));

        assert!(
            !abandoned.exists(),
            "an abandoned fragment must not sit on the volume forever",
        );
        assert!(
            in_flight.exists(),
            "a fragment younger than the TTL belongs to a live transfer",
        );
        assert!(
            unrecognised.exists(),
            "the sweep must only remove fragments it wrote itself",
        );
        assert!(
            frame.exists(),
            "the default policy must never expire a wearer's capture",
        );
        assert_eq!(
            std::fs::read(&frame).expect("the wearer's frame"),
            b"wearer frame",
        );
    }

    /// Stored frames age out ONLY when an operator asked for it, and then by the
    /// configured age rather than wholesale.
    #[tokio::test]
    async fn stored_frames_expire_only_when_an_operator_opts_in() {
        let objects = CaptureObjectStore::for_tests_with_retention(Retention {
            incoming_ttl: DEFAULT_INCOMING_TTL,
            object_max_age: Some(Duration::from_secs(30 * 24 * 60 * 60)),
        });

        let stored = async |slot: &str, body: &[u8]| {
            let token = objects.grant(DEV_PRINCIPAL, slot);
            assert_eq!(objects.accept(&token, None, body).await, Ok(()));
            objects
                .object_path_for_tests(DEV_PRINCIPAL, slot)
                .expect("stored path")
        };
        let old = stored("old-memory/burst/frame.raw", b"last year's frame").await;
        backdate(&old, Duration::from_secs(200 * 24 * 60 * 60));
        let recent = stored("recent-memory/burst/frame.raw", b"this week's frame").await;

        // The production trigger, as above.
        let token = objects.grant(DEV_PRINCIPAL, "trigger-memory/burst/frame.raw");
        assert_eq!(objects.accept(&token, None, b"a new frame").await, Ok(()));

        assert!(!old.exists(), "an opted-in retention bound must be applied");
        assert!(
            !old.parent()
                .and_then(Path::parent)
                .expect("capture directory")
                .exists(),
            "the emptied capture directory must be pruned",
        );
        assert_eq!(
            std::fs::read(&recent).expect("the recent frame"),
            b"this week's frame",
            "retention removes what aged out, not the library",
        );
    }

    /// Storage configuration: defaults to the durable state dir every
    /// deployment already mounts, is served only by the workload that hosts
    /// `CaptureService`, and answers "nothing configured" rather than inventing
    /// somewhere to put a wearer's photograph.
    #[test]
    fn storage_configuration_defaults_to_the_state_dir_and_fails_honestly() {
        let state_dir = std::env::temp_dir().join(format!("carry-state-{}", uuid::Uuid::new_v4()));
        let state = state_dir.to_string_lossy().into_owned();

        let configured = resolve_object_store(None, None, Some(state.clone()), None, None, None)
            .expect("an unset workload is ai-bus, and the state dir is the default root");
        assert_eq!(configured.root(), state_dir.join("captures"));
        assert_eq!(configured.max_upload_bytes(), DEFAULT_MAX_UPLOAD_BYTES);
        // Unconfigured retention bounds the server's own fragments and leaves
        // the wearer's frames alone.
        assert_eq!(
            configured.retention().incoming_ttl,
            DEFAULT_INCOMING_TTL,
            "the staging directory must be bounded even unconfigured",
        );
        assert!(
            configured.retention().object_max_age.is_none(),
            "captures must never expire unless an operator asked for it",
        );

        // Only the workload that hosts CaptureService serves capture objects.
        for other in ["account", "contacts", "connectivity"] {
            assert!(
                resolve_object_store(
                    Some(other.to_owned()),
                    None,
                    Some(state.clone()),
                    None,
                    None,
                    None
                )
                .is_none(),
                "{other} must not expose a capture write surface"
            );
        }

        // Nothing configured => no storage. Not a temp directory, not the cwd.
        assert!(resolve_object_store(None, None, None, None, None, None).is_none());
        // A relative root would resolve against whatever the process cwd is.
        assert!(
            resolve_object_store(None, Some("captures".to_owned()), None, None, None, None)
                .is_none()
        );

        // The ceiling is configurable, and clamped so it can be neither absurd
        // nor small enough to reject a real frame.
        let explicit = std::env::temp_dir().join(format!("carry-cap-{}", uuid::Uuid::new_v4()));
        let explicit = explicit.to_string_lossy().into_owned();
        let clamped = resolve_object_store(
            None,
            Some(explicit.clone()),
            None,
            Some("999999999999".to_owned()),
            None,
            None,
        )
        .expect("explicit root");
        assert_eq!(clamped.max_upload_bytes(), MAX_MAX_UPLOAD_BYTES);
        let floored = resolve_object_store(
            None,
            Some(explicit.clone()),
            None,
            Some("1".to_owned()),
            None,
            None,
        )
        .expect("root");
        assert_eq!(floored.max_upload_bytes(), MIN_MAX_UPLOAD_BYTES);

        // Retention is configurable, with the staging TTL floored at a
        // capability's own lifetime so a sweep can never take a fragment out
        // from under a live transfer.
        let retained = resolve_object_store(
            None,
            Some(explicit.clone()),
            None,
            None,
            Some("60".to_owned()),
            Some("30".to_owned()),
        )
        .expect("root");
        assert_eq!(retained.retention().incoming_ttl, MIN_INCOMING_TTL);
        assert_eq!(
            retained.retention().object_max_age,
            Some(Duration::from_secs(30 * 24 * 60 * 60))
        );

        // Zero, negative, and garbage all mean KEEP the wearer's frames. A
        // mistyped value must never be read as "start expiring photographs".
        for value in ["0", "-7", "thirty", ""] {
            let store = resolve_object_store(
                None,
                Some(explicit.clone()),
                None,
                None,
                None,
                Some(value.to_owned()),
            )
            .expect("root");
            assert!(
                store.retention().object_max_age.is_none(),
                "{value:?} must not enable capture expiry",
            );
        }

        // A staging TTL that cannot be read falls back to the default; one that
        // reads as "sweep immediately" is floored instead, because a sweep must
        // never be able to take a fragment out from under a live transfer.
        for value in ["-7", "thirty", ""] {
            let store = resolve_object_store(
                None,
                Some(explicit.clone()),
                None,
                None,
                Some(value.to_owned()),
                None,
            )
            .expect("root");
            assert_eq!(
                store.retention().incoming_ttl,
                DEFAULT_INCOMING_TTL,
                "{value:?} must fall back to the default staging TTL",
            );
        }
        let floor =
            resolve_object_store(None, Some(explicit), None, None, Some("0".to_owned()), None)
                .expect("root");
        assert_eq!(floor.retention().incoming_ttl, MIN_INCOMING_TTL);
    }
}
