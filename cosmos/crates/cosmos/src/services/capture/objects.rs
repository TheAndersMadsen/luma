//! The capture object store: the clone-served upload endpoint the device PUTs
//! assets to, its capabilities, staging, retention and sweeps.

use super::*;

/// Explicit object-storage root. Unset falls back to the durable state dir.
const STORAGE_DIR_ENV: &str = "COSMOS_CAPTURE_STORAGE_DIR";
/// The durability switch every workload already honours. A named docker volume
/// is mounted there. Captures land in a subdirectory of it.
pub(super) const STATE_DIR_ENV: &str = "COSMOS_STATE_DIR";
/// Largest single asset body accepted, in bytes.
const MAX_UPLOAD_BYTES_ENV: &str = "COSMOS_CAPTURE_MAX_UPLOAD_BYTES";
/// Which workload hosts `CaptureService`. Only that one serves capture objects,
/// so the other six never expose a write endpoint at all.
pub(super) const WORKLOAD_ENV: &str = "COSMOS_WORKLOAD";
/// How long an interrupted upload fragment may sit in staging, in seconds.
const INCOMING_TTL_ENV: &str = "COSMOS_CAPTURE_INCOMING_TTL_SECS";
/// Opt-in age bound on the wearer's STORED FRAMES, in days. Unset keeps them
/// forever, see [`Retention`].
const OBJECT_RETENTION_DAYS_ENV: &str = "COSMOS_CAPTURE_RETENTION_DAYS";

/// A ceiling for one encrypted frame or video, small enough that an
/// authenticated device cannot fill the volume with one request. The stock
/// camera records up to `videoDuration` (15 s) plus one second and budgets
/// 4,000,000 bytes per second (`Video.BYTES_PER_SECOND`, `Video.mMaxDuration`),
/// and a real 13 s clip is 51 MB, so 256 MiB keeps headroom for a longer
/// served `videoDuration` without letting one request fill a small server.
const DEFAULT_MAX_UPLOAD_BYTES: usize = 256 * 1024 * 1024;
pub(super) const MIN_MAX_UPLOAD_BYTES: usize = 1024 * 1024;
const MAX_MAX_UPLOAD_BYTES: usize = 1024 * 1024 * 1024;

/// How long a minted upload capability stays usable. The device PUTs
/// immediately after `UploadFile` returns (`uploadIndividualAsset` chains the
/// two), so this only has to cover a slow uplink, not a queued retry, which
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
pub(super) const MAX_SLOT_SEGMENT_LEN: usize = 128;

/// How long an abandoned `{token}.part` fragment is kept before it is swept.
///
/// A fragment is worthless the moment its write was interrupted, so this only
/// has to comfortably exceed one slow PUT. A day is far past
/// [`UPLOAD_GRANT_TTL`], which means a fragment belonging to a transfer that is
/// still live can never be old enough to sweep.
pub(super) const DEFAULT_INCOMING_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// A staging TTL shorter than a capability's own lifetime could sweep a
/// fragment out from under a transfer still in flight.
const MIN_INCOMING_TTL: Duration = UPLOAD_GRANT_TTL;
const MAX_INCOMING_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Floor on an opted-in capture retention, so a mistyped value cannot turn into
/// "expire the wearer's photographs within the hour".
const MIN_OBJECT_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

/// How often a sweep may run. Sweeping is opportunistic, it rides on an
/// authorized upload rather than a scheduler thread, so this is what keeps a
/// busy workload from walking the volume on every PUT.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// What this store is allowed to remove on its own initiative.
///
/// The asymmetry is the whole point. `incoming_ttl` bounds the SERVER'S OWN
/// transient artefacts, `{token}.part` fragments left behind when a PUT died
/// mid-write, which nothing will ever read again and which otherwise grow
/// without bound on the volume. `object_max_age` bounds the WEARER'S FRAMES,
/// and is therefore `None` unless an operator sets it: a server that quietly
/// expires photographs on a timer is destroying data nobody asked it to
/// destroy, and the pin has already deleted its own copy by then
/// (`AssetUploadWorkerImpl.handleUploadSuccess` →
/// `mFileSystem.deleteDirectory(captureDirectory())`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Retention {
    /// Age after which an interrupted staging fragment is swept.
    pub(super) incoming_ttl: Duration,
    /// Age after which a stored capture object is removed. `None`, the
    /// default, keeps the wearer's frames indefinitely.
    pub(super) object_max_age: Option<Duration>,
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
    /// both fields. In particular a garbled `COSMOS_CAPTURE_RETENTION_DAYS` means
    /// "keep the frames", never "expire them on some guessed schedule".
    pub(super) fn resolve(
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
    /// How often a sweep may run. Always [`SWEEP_INTERVAL`] in production. Tests
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

/// Why a PUT was refused. Deliberately coarse, the HTTP layer must not let a
/// caller tell "no such token" from "expired" from "already used".
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UploadRejection {
    /// Unknown, expired, or already-consumed capability.
    Unauthorized,
    /// The body was empty, so there is nothing to store.
    Empty,
    /// The body exceeded the configured ceiling.
    TooLarge,
    /// The body stopped arriving before it was complete.
    Interrupted,
    /// The bytes could not be durably written.
    Storage,
}

impl CaptureObjectStore {
    pub(super) fn new(
        root: PathBuf,
        max_bytes: usize,
        ttl: Duration,
        retention: Retention,
    ) -> Self {
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
    pub(super) fn for_tests_with_retention(retention: Retention) -> Arc<Self> {
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
    pub(super) fn grant(&self, principal: &str, slot: &str) -> String {
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
    pub(super) fn resolve(&self, token: &str) -> Result<(String, String), UploadRejection> {
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
    /// It is only ever *checked* against the capability, the destination comes
    /// from the capability, so a mismatched or hostile header cannot redirect a
    /// write.
    pub(crate) async fn accept(
        &self,
        token: &str,
        declared_slot: Option<&str>,
        body: &[u8],
    ) -> Result<(), UploadRejection> {
        let chunks = futures_util::stream::iter([Ok::<_, std::convert::Infallible>(body)]);
        self.accept_stream(token, declared_slot, chunks).await
    }

    /// [`Self::accept`] for a body that is still arriving. It is written to
    /// staging as it comes, so a video is never held in memory, and nothing is
    /// read until the capability has been authorized.
    pub(crate) async fn accept_stream<S, B, E>(
        &self,
        token: &str,
        declared_slot: Option<&str>,
        body: S,
    ) -> Result<(), UploadRejection>
    where
        S: futures_util::Stream<Item = Result<B, E>>,
        B: AsRef<[u8]>,
        E: std::fmt::Display,
    {
        // Authorize before saying anything about the body, so an unauthenticated
        // prober cannot learn size limits or emptiness rules from the response.
        let (principal, slot) = self.resolve(token)?;
        // Only ever behind an authorized capability: an unauthenticated prober
        // must not be able to make this workload walk its volume.
        self.maybe_sweep().await;
        if declared_slot.is_some_and(|declared| declared != slot) {
            return Err(UploadRejection::Unauthorized);
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
    /// metadata row. The destination is never chosen by the caller.
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
    /// already uploaded to Cosmos, never removes an original, and rechecks the
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
        if let Some(existing) = self.read_best_frame(principal, &record.uuid).await?
            && existing.has_visual_index()
            && (!force_automatic || existing.method == "manual")
        {
            return Ok(Some(existing));
        }

        // A frame we cannot open is skipped, but never silently: ranking that
        // sees no frames answers "no opened thumbnails are available", which
        // reads to an operator as "this burst is empty" when the real cause is a
        // channel key that was never imported, or one that lives in another
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
            let Some(key) = keys
                .get(kid)
                .await
                .map_err(|error| std::io::Error::other(error.to_string()))?
            else {
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
        // choice while it runs. Retain that frame while adding the new private
        // visual-search metadata.
        if let Some(existing) = self.read_best_frame(principal, memory_uuid).await? {
            if existing.method == "manual" {
                selection.frame = existing.frame;
                selection.method = existing.method;
                selection.reason = existing.reason;
            } else if existing.has_visual_index() && !force_automatic {
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
    pub(super) fn object_path(&self, principal: &str, slot: &str) -> Option<PathBuf> {
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
    async fn write_object<S, B, E>(
        &self,
        path: &Path,
        token: &str,
        body: S,
    ) -> Result<(), UploadRejection>
    where
        S: futures_util::Stream<Item = Result<B, E>>,
        B: AsRef<[u8]>,
        E: std::fmt::Display,
    {
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
        if let Err(rejection) = self.stage(&staging, body).await {
            let _ = tokio::fs::remove_file(&staging).await;
            return Err(rejection);
        }
        if let Err(error) = tokio::fs::rename(&staging, path).await {
            tracing::warn!(%error, "capture asset could not be committed");
            let _ = tokio::fs::remove_file(&staging).await;
            return Err(UploadRejection::Storage);
        }
        Ok(())
    }

    /// Write the body to `staging` as it arrives, refusing it as soon as it
    /// passes the ceiling rather than after it has all been received.
    async fn stage<S, B, E>(&self, staging: &Path, body: S) -> Result<(), UploadRejection>
    where
        S: futures_util::Stream<Item = Result<B, E>>,
        B: AsRef<[u8]>,
        E: std::fmt::Display,
    {
        use futures_util::StreamExt as _;
        use tokio::io::AsyncWriteExt as _;

        let not_staged = |error: std::io::Error| {
            tracing::warn!(%error, "capture asset could not be staged");
            UploadRejection::Storage
        };
        let mut file = tokio::fs::File::create(staging).await.map_err(not_staged)?;
        restrict_file(staging).await;
        let mut body = std::pin::pin!(body);
        let mut received = 0usize;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|error| {
                tracing::warn!(%error, "capture upload ended before its body arrived");
                UploadRejection::Interrupted
            })?;
            let chunk = chunk.as_ref();
            received = received.saturating_add(chunk.len());
            if received > self.max_bytes {
                return Err(UploadRejection::TooLarge);
            }
            file.write_all(chunk).await.map_err(not_staged)?;
        }
        if received == 0 {
            return Err(UploadRejection::Empty);
        }
        file.flush().await.map_err(not_staged)?;
        file.sync_all().await.map_err(not_staged)
    }

    /// Unlink the stored bytes for `slots`, and prune whatever directories that
    /// leaves empty. `true` when nothing of theirs remains on disk.
    ///
    /// This is what makes a deletion a deletion. `DeleteMemory` used to
    /// tombstone the metadata row and stop there, so a photograph the wearer
    /// explicitly deleted, and whose only other copy the pin then dropped,
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
            // way in either, `accept` derives its destination the same way,
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
            // directory is deliberately not a candidate, it outlives any one
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

    /// Remove every stored object of one principal: the object-store half of
    /// an account deletion. `true` when nothing of theirs remains on disk.
    ///
    /// Walks exactly the layout [`Self::object_path`] writes,
    /// `{root}/{principal}/{memory}/{burst}/{file}` plus each capture's
    /// `.best-frame.json`, the way [`Self::sweep_objects`] does: fixed depth, no
    /// symlink ever followed, and only this principal's directory reached.
    pub(crate) async fn remove_principal(&self, principal: &str) -> bool {
        let principal_directory = self.root.join(principal_directory(principal));
        for memory_directory in directories_in(&principal_directory).await {
            for burst_directory in directories_in(&memory_directory).await {
                remove_files_in(&burst_directory).await;
                let _ = tokio::fs::remove_dir(&burst_directory).await;
            }
            remove_files_in(&memory_directory).await;
            let _ = tokio::fs::remove_dir(&memory_directory).await;
        }
        let _ = tokio::fs::remove_dir(&principal_directory).await;
        matches!(tokio::fs::try_exists(&principal_directory).await, Ok(false))
    }

    /// Run a sweep if one is due.
    ///
    /// Rate-limited to [`SWEEP_INTERVAL`] because this rides on an upload rather
    /// than a scheduler thread, there is no background task to hang it off, and
    /// a per-PUT walk of the volume would be a self-inflicted denial of service.
    async fn maybe_sweep(&self) {
        {
            let mut last = self.last_sweep.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            if !last.is_none_or(|previous| now.duration_since(previous) >= self.sweep_interval) {
                return;
            }
            // Claimed before the sweep, not after, so concurrent uploads do not
            // all start one. The lock is released here, never held across the
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
            // in the staging directory is left alone, a sweeper that removes
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
    /// operator set [`OBJECT_RETENTION_DAYS_ENV`], see [`Retention`].
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

/// Remove the regular files directly in `path`, never following a symlink.
async fn remove_files_in(path: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(path).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let child = entry.path();
        if tokio::fs::symlink_metadata(&child)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            let _ = tokio::fs::remove_file(&child).await;
        }
    }
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
    let root = std::env::temp_dir().join(format!("cosmos-capture-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("test storage root");
    root
}

/// Test roots are private temporary directories. Clean them up rather than
/// littering the machine with wearer-shaped fixtures. Only compiled for tests,
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
/// Principals contain `:` separators and device/user identifiers, so they are not
/// usable as path segments directly. base64url is reversible and collision-free,
/// two wearers sharing a directory would be a cross-wearer data leak, which a
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
    // nothing, reported as such, never pretended around.
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
