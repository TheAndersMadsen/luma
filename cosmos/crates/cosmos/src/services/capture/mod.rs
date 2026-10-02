//! `humane.capture.CaptureService` + `humane.capture.TestingAutomationService`,
//! memory capture (photos/videos/notes/food logs), asset upload orchestration,
//! share links, and the test-automation note surface.
//!
//! Stock-faithful degradation: a real cosmos account with no stored memories
//! returns *well-formed empty* for reads, so a device's capture and note flows
//! advance instead of erroring out.
//!
//! Writes and deletes are NOT success-shaped acks, they are carried out and
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
//! S3/Azure URL we hold no credentials for, [`CaptureObjectStore`] receives the
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
//! cosmos always returns real numbers, so we serve a small functional default set
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

mod food;
mod objects;
mod share;

pub(crate) use food::*;
pub(crate) use objects::*;
pub(crate) use share::*;

pub(crate) const UPLOAD_BASE_URL_ENV: &str = "COSMOS_CAPTURE_UPLOAD_BASE_URL";

const MIN_PROTOBUF_TIMESTAMP_SECONDS: i64 = -62_135_596_800;
const MAX_PROTOBUF_TIMESTAMP_SECONDS: i64 = 253_402_300_799;

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[derive(Clone)]
pub struct Capture {
    share: ShareAuthority,
    upload_endpoint: Endpoint,
    authenticator: crate::auth::RequestAuthenticator,
    store: crate::store::SharedStore,
    /// Needed to INDEX a note, not to store one. A note arrives sealed. The text
    /// index is what `recall_memory` and `WebSearchService.search` actually
    /// search, and both skip anything with no `indexed_text`. Storing without
    /// indexing therefore leaves the wearer's note permanently unfindable,
    /// saved, acknowledged, and unreachable by voice.
    /// Durable C1 channel keys used by stock HMSA capture thumbnails. This is
    /// The same authority protects service-channel envelopes and stock HMSA
    /// capture assets. Format decoding is separate, key ownership is not.
    capture_keys: crate::keydirectory::SharedKeyDirectory,
    asset_arrival: AssetArrival,
}

/// Open a sealed note and record its plaintext in the search index.
///
/// Shared by both note-creating RPCs. It lived only inside
/// `TestingAutomationService::create_note`, so the path a real Pin uses stored
/// notes that could never be found again. A note whose envelope this server
/// cannot open is left unindexed rather than indexed as garbage, unfindable is
/// bad, wrong search results are worse.
async fn opened_note_text(
    keys: &crate::keydirectory::SharedKeyDirectory,
    sealed: Option<&cosmos_protocol::common::encryption::EncryptedData>,
) -> Result<Option<String>, Status> {
    let Some(sealed) = sealed else {
        return Ok(None);
    };
    let kid = sealed
        .encryption_information
        .as_ref()
        .map(|i| i.kid.clone())
        .unwrap_or_default();
    let plaintext = if sealed.data.get(4..8) == Some(b"HMSA") {
        let Some(key) = keys
            .get(&kid)
            .await
            .map_err(|error| crate::keydirectory::grpc_status(&error))?
        else {
            return Err(Status::failed_precondition(
                "the note channel key is not established",
            ));
        };
        cosmos_crypto::secure_asset::open_secure_asset(
            &key,
            &kid,
            &sealed.data,
            cosmos_crypto::secure_asset::NOTE_DATA,
        )
        .map_err(|_| Status::failed_precondition("the sealed note could not be opened"))?
    } else {
        keys.open(&cosmos_crypto::EncryptedData {
            data: sealed.data.clone(),
            kid,
        })
        .await
        .map_err(|error| crate::keydirectory::grpc_status(&error))?
        .ok_or_else(|| Status::failed_precondition("the note channel key is not established"))?
    };
    Ok(note_search_text(&plaintext))
}

/// The searchable text inside an opened note.
///
/// The device seals a `humane.capture.Note` PROTOBUF, not a string:
/// `DataProtectionUtils.protectData(IDataProtector<GeneratedMessageLite<?,?>>,
/// Note, DataProtectionIdentity)` takes the message itself. Treating the
/// plaintext as UTF-8 therefore usually failed outright, protobuf bytes are
/// rarely valid UTF-8, and the note was silently left unindexed, which is
/// indistinguishable from the wearer never having saved it. When it did happen to
/// decode, it indexed field tags and lengths as if they were words.
///
/// `Note` carries BOTH `title` (field 5) and `text` (field 2), and the .Center
/// dashboard showed notes with titles, so both belong in the index, searching
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
/// whenever `deleteCapturesOnUpload` is set, the wearer's only copy of the
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

    fn base(&self, variable: &str) -> Result<Url, Status> {
        match self {
            Self::Ready(url) => Ok(url.clone()),
            Self::Missing => Err(Status::failed_precondition(format!(
                "{variable} is not configured"
            ))),
            Self::Invalid => Err(Status::failed_precondition(format!(
                "{variable} must be an absolute HTTP(S) URL without credentials, query, or fragment"
            ))),
        }
    }

    pub(crate) fn resource_url(&self, variable: &str, token: &str) -> Result<String, Status> {
        let mut url = self.base(variable)?;
        // Safe because `parse` rejects cannot-be-a-base URLs. `push` percent
        // encodes each segment, and the token contains no request plaintext.
        url.path_segments_mut()
            .map_err(|_| Status::failed_precondition(format!("{variable} is not a base URL")))?
            .pop_if_empty()
            .push("capture")
            .push(token);
        Ok(url.into())
    }

    /// `<base>/humane.center/share/capture/<uuid>?expiry=<unix>&signature=<sig>`,
    /// the stock share-link shape (see [`ShareAuthority`]). The query pairs are
    /// appended in exactly this order. The stock parser depends on it.
    fn share_url(
        &self,
        variable: &str,
        memory_uuid: &str,
        expiry: i64,
        signature: &str,
    ) -> Result<String, Status> {
        let mut url = self.base(variable)?;
        url.path_segments_mut()
            .map_err(|_| Status::failed_precondition(format!("{variable} is not a base URL")))?
            .pop_if_empty()
            .extend(["humane.center", "share", "capture", memory_uuid]);
        url.query_pairs_mut()
            .append_pair("expiry", &expiry.to_string())
            .append_pair("signature", signature);
        Ok(url.into())
    }
}

impl Capture {
    /// Build the service with the deployment's real authenticator and store.
    /// Captures are per-wearer, so this is how it must be constructed in
    /// production, `Default` resolves every caller to the same synthetic
    /// principal and exists only for tests.
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        store: crate::store::SharedStore,
        _keys: crate::keymaterial::SharedKeyMaterial,
    ) -> Self {
        let capture_keys = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        Self {
            authenticator,
            store,
            capture_keys,
            share: ShareAuthority::from_environment(),
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
            capture_keys: Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
            share: ShareAuthority::from_environment(),
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
            share: ShareAuthority::for_tests(share),
            upload_endpoint: upload.map(Endpoint::parse).unwrap_or(Endpoint::Missing),
            asset_arrival: AssetArrival::Objects(CaptureObjectStore::for_tests()),
            ..Default::default()
        }
    }

    /// A capture service over an explicit store and object store, the shape
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
            share: ShareAuthority::for_tests(None),
            upload_endpoint: Endpoint::parse(upload_base),
            asset_arrival: AssetArrival::Objects(objects),
            ..Default::default()
        }
    }

    /// A service over `store` with no configured endpoints. `asset_arrival` is
    /// spelled out per test because it decides whether a claimed upload can be
    /// acknowledged. Production is always [`AssetArrival::Unobservable`].
    #[cfg(test)]
    fn for_tests(store: crate::store::SharedStore, asset_arrival: AssetArrival) -> Self {
        Self {
            store,
            share: ShareAuthority::for_tests(None),
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
        // Every stored asset of every frame travels: the frame itself under
        // whichever secure slot the device wrote (`secure_filename` in stock
        // JPG mode, `secure_raw_data_filename` in YUV mode, never both), plus a
        // video's imu and timing files when it had them. Burst zero is what the
        // device uploads (`upload_bytes_landed`), so each of its frames must
        // bring at least its image. A capture still uploading is refused rather
        // than saved without its pictures.
        for (burst_index, (source_burst, destination_burst)) in
            source.bursts.iter().zip(&destination.bursts).enumerate()
        {
            for (source_file, destination_file) in
                source_burst.files.iter().zip(&destination_burst.files)
            {
                let mut copied_frame = false;
                for (from, to, is_frame) in [
                    (
                        &source_file.secure_filename,
                        &destination_file.secure_filename,
                        true,
                    ),
                    (
                        &source_file.secure_raw_data_filename,
                        &destination_file.secure_raw_data_filename,
                        true,
                    ),
                    (
                        &source_file.imu_data_filename,
                        &destination_file.imu_data_filename,
                        false,
                    ),
                    (
                        &source_file.video_timing_data_filename,
                        &destination_file.video_timing_data_filename,
                        false,
                    ),
                ] {
                    let copied = objects
                        .copy(source_owner, from, destination_owner, to)
                        .await
                        .map_err(|_| Status::unavailable("shared memory object copy failed"))?;
                    copied_frame |= copied && is_frame;
                }
                if burst_index == 0 && !copied_frame {
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
    /// key is established. Without it the note is still stored, just not
    /// searchable.
    keys: crate::keydirectory::SharedKeyDirectory,
    /// The same object store `Capture` deletes through. `H4Device` reaches
    /// captures through this surface, so a delete arriving here has to remove
    /// the wearer's frames too, the test-automation service must not be the
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
        _keys: crate::keymaterial::SharedKeyMaterial,
    ) -> Self {
        let keys = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        Self {
            authenticator,
            store,
            keys,
            // The one process-wide store, so a delete here unlinks exactly the
            // objects `UploadFile` filed.
            objects: configured_object_store(),
        }
    }

    pub fn with_key_directory(mut self, keys: crate::keydirectory::SharedKeyDirectory) -> Self {
        self.keys = keys;
        self
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
            keys: Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
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
/// its default (`PhotographyConfig` merge ctor), which it always does on a fresh
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
    /// upload to, every photo and video was lost one step later. The uuid, the
    /// numeric id, and the burst/file paths are all server-allocated. None of the
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
        // slots, its whole content is `encrypted_note`. Routing it through
        // `create_memory` recorded an empty Photo-shaped row and dropped the body
        // on the floor, then answered `CreateSuccess`. The wearer was told their
        // note was saved and nothing was saved. `create_note` is the path that
        // actually persists it, and `TestingAutomationService.CreateNote` has
        // been using it correctly all along.
        let privacy = crate::services::public_privacy::AccountPrivacy::load(
            &self.store,
            principal.expose_for_authorization(),
        )
        .await?;
        if let Req::NoteMemoryRequest(n) = &body {
            let indexed_text =
                opened_note_text(&self.capture_keys, n.encrypted_note.as_ref()).await?;
            let record = self
                .store
                .create_note(
                    principal.expose_for_authorization(),
                    crate::store::NewNote {
                        opened_text: indexed_text,
                        ..crate::store::NewNote::sealed(
                            n.encrypted_note.clone(),
                            privacy
                                .location_allowed
                                .then(|| n.encrypted_location.clone())
                                .flatten(),
                        )
                    },
                )
                .await?;
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
        //
        // `metadata` is everything else the arm carries, stored as sent: the
        // photo's per-frame `ImageMetadata`, `PhotoFileFormat`, LUT and the
        // request's key id, and the video's count and duration
        // (`MemoryUploadWorkerImpl.constructCreateMemoryRequestBuilder`). The
        // web shows camera details and a video's length from it, and the key id
        // is the one the full-resolution assets are sealed under.
        let (
            kind,
            device_local_id,
            bursts,
            per_burst,
            created,
            gmt,
            thumbs,
            location,
            food_log,
            metadata,
        ) = match &body {
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
                crate::store::CaptureMetadata {
                    photo_metadatas: p.photo_metadatas.clone(),
                    format: p.format,
                    lut_name: p.lut_name.clone(),
                    encryption_kid: request_kid(p.encryption_information.as_ref()),
                    num_videos: 0,
                    total_video_duration_sec: 0,
                },
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
                crate::store::CaptureMetadata {
                    encryption_kid: request_kid(v.encryption_information.as_ref()),
                    num_videos: v.num_videos,
                    total_video_duration_sec: v.total_video_duration_sec,
                    ..crate::store::CaptureMetadata::default()
                },
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
                crate::store::CaptureMetadata::default(),
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
                crate::store::CaptureMetadata::default(),
            ),
        };
        // NOTE: the `NoteMemoryRequest` arm above is unreachable, notes return
        // early via `create_note`. It exists only to keep this match exhaustive,
        // and deliberately does NOT define note behaviour. Edit the early return
        // instead.

        // Slot counts are the one thing in this request that the device turns
        // into work on our side, so they are the one thing bounded here.
        // `store::build_memory` allocates a record per burst and per file and
        // mints four uuids and six paths for each. Nothing between the wire and
        // that loop looked at the magnitude. A `CreateMemoryRequest` containing
        // `num_bursts: i32::MAX, num_pics_per_burst: i32::MAX` is about ten bytes
        // on the wire, so `max_decode_bytes` never sees it, and it asked the
        // process for hundreds of gigabytes: an allocator refusal here is
        // `handle_alloc_error`, which aborts, no unwind, no `Status`, just a
        // dead ai-bus container taking capture, the AI bus, notable events and
        // the push relay down for every wearer, and repeatable as soon as the
        // restart policy brings it back. Any authenticated principal reached it,
        // on either plane, since `RequestAuthenticator` resolves a Center bearer
        // and a paired Pin to the same kind of caller.
        //
        // Refused rather than clamped, and refused with a gRPC error rather than
        // an in-band `BadRequest` ack: a device that genuinely wanted more slots
        // must find out it did not get them. That is the whole lesson of the ack
        // this handler already carries a regression test for, `verifyResponse`
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
        // One `ImageMetadata` per frame. Bounded by the same ceiling as the
        // slots so a stored row can never outgrow the capture it describes.
        let max_frames = (crate::store::MAX_BURSTS * crate::store::MAX_FILES_PER_BURST) as usize;
        if metadata.photo_metadatas.len() > max_frames {
            return Err(Status::invalid_argument(format!(
                "capture carries at most {max_frames} frame metadata entries"
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
                    encrypted_location: privacy.location_allowed.then_some(location).flatten(),
                    metadata,
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
                // Calibration is device-specific data we do not hold. Absent is
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

    /// Record that the Pin holds a capture it has not created here yet.
    ///
    /// `PhotographyManager` schedules this the moment a photo or video is
    /// taken, with `DELAY_REASON_POOR_NETWORK` when upload conditions are not
    /// met, and `MemoryUploadIntentWorker` sends it on any connected network.
    /// humane.center listed these as `GET /capture/pending-memory-creates`, so
    /// the wearer could see captures still waiting on the Pin. `CreateMemory`
    /// with the same `device_local_id` clears the row.
    ///
    /// A failed write is an error, which the worker answers with
    /// `Result.retry()`. An acknowledged intent that was never recorded would
    /// hide a capture from the wearer.
    async fn declare_memory_create_intent(
        &self,
        request: Request<pb::MemoryCreateIntentRequest>,
    ) -> Result<Response<pb::MemoryCreateIntentResponse>, Status> {
        let principal = self.principal(&request)?;
        let request = request.into_inner();
        if request.device_local_id.trim().is_empty() {
            return Err(Status::invalid_argument("device_local_id is required"));
        }
        // Stored exactly as sent: `CreateMemory` clears the row by the same
        // untrimmed id, so a normalised copy would never be cleared.
        self.store
            .declare_pending_memory_create(
                principal.expose_for_authorization(),
                &crate::store::PendingMemoryCreate {
                    device_local_id: request.device_local_id,
                    memory_type: request.memory_type,
                    delay_reason: request.delay_reason,
                    declared: crate::store::SyncTime::now(),
                },
            )
            .await?;
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
        let opened = open_food_logs(
            &self.store,
            &self.capture_keys,
            principal.expose_for_authorization(),
            start,
            None,
        )
        .await?
        .complete()?;
        let mut logs = Vec::with_capacity(opened.len());
        let mut response_protection = None;
        for entry in opened {
            match entry.protection {
                FoodLogSummaryProtection::Plaintext => {
                    response_protection = Some(FoodLogSummaryProtection::Plaintext);
                }
                FoodLogSummaryProtection::Encrypted(kid) => {
                    response_protection.get_or_insert(FoodLogSummaryProtection::Encrypted(kid));
                }
            }
            logs.push(entry.log);
        }
        let Some(protection) = response_protection else {
            return Ok(Response::new(pb::GetFoodLogSummaryResponse {
                food_log_summary: None,
            }));
        };
        let summary = FoodLogSummary { food_logs: logs }.encode_to_vec();
        if summary.len() > MAX_FOOD_LOG_SUMMARY_BYTES {
            return Err(Status::resource_exhausted("food log summary is too large"));
        }
        let sealed = match protection {
            FoodLogSummaryProtection::Plaintext => {
                cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: FOOD_LOG_SUMMARY_PLAINTEXT_KID.to_owned(),
                        },
                    ),
                    data: summary,
                }
            }
            FoodLogSummaryProtection::Encrypted(kid) => {
                let sealed = self
                    .capture_keys
                    .seal(&kid, &summary, b"")
                    .await
                    .map_err(|error| crate::keydirectory::grpc_status(&error))?
                    .ok_or_else(|| {
                        Status::failed_precondition("the food-log channel key is not established")
                    })?;
                cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: sealed.kid,
                        },
                    ),
                    data: sealed.data,
                }
            }
        };
        Ok(Response::new(pb::GetFoodLogSummaryResponse {
            food_log_summary: Some(sealed),
        }))
    }

    /// The Pin's Recents share (`PhotographyManager.getRecentShareLink`, sent
    /// only while `humane_photo_sharing_enabled` is on). The link it returns is
    /// composed into an SMS by `RecentsInteractor.shareRecent`, so it must be
    /// the shape the recipient's Messages parses. See [`ShareAuthority`].
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
        let Some(record) = self.store.memory(owner, request.memory_uuid.trim()).await? else {
            return Err(Status::not_found("memory was not found"));
        };
        let link = self.share.mint(owner, &record.uuid)?;
        Ok(Response::new(pb::GetShareLinkResponse {
            share_link: link.url,
        }))
    }

    /// The preview a recipient's Messages shows for a share link
    /// (`ShareLinkUtil.downloadImageAndSave`): the capture's best frame, the
    /// same hero the owner's grid and the public share page show.
    async fn get_share_link_contents(
        &self,
        request: Request<pb::GetShareLinkContentsRequest>,
    ) -> Result<Response<pb::GetShareLinkContentsResponse>, Status> {
        self.authenticator.authenticate(&request)?;
        let data = request
            .into_inner()
            .share_link_data
            .ok_or_else(|| Status::invalid_argument("share_link_data is required"))?;
        let capability = self.share.open(&data)?;
        let record = self
            .store
            .memory(&capability.owner, &capability.memory_uuid)
            .await?
            .ok_or_else(|| Status::not_found("shared memory was not found"))?;
        let bytes = shared_frame(
            &self.store,
            &self.capture_keys,
            self.objects(),
            &capability.owner,
            &record,
        )
        .await?
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
        let capability = self.share.open(&data)?;
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
                    metadata: source.metadata.clone(),
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
    /// `AssetUploadWorkerImpl.handleUploadSuccess` deleted the device's own copy,
    /// the only remaining record that the frames were ever uploaded.
    ///
    /// The status choices come straight from that worker's response switch:
    ///
    /// * `STATUS_ACKNOWLEDGED` completes its future, the only outcome that lets
    ///   the wearer's capture finish.
    /// * `STATUS_INTERNAL_ERROR` is retried, which is right for a store outage:
    ///   the completion is real, we just could not write it down yet.
    /// * `STATUS_MEMORY_NOT_FOUND` falls to its `default` arm and is FATAL, the
    ///   device gives up on the asset. Correct only when we genuinely hold no
    ///   such capture, which is why a failed write must never report it.
    /// * `STATUS_UPLOAD_INCOMPLETE` is also retried, and additionally resets
    ///   `lastImgUploadedIdx` to 0 so the device re-uploads from the first
    ///   frame. That is the answer to a claimed success this server cannot
    ///   witness, see [`AssetArrival`].
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
        // not enumerate (it handles 1..6. MEMORY_NOT_FOUND is 7) so it falls to
        // `default:` = FATAL. UNAVAILABLE is the retryable answer.
        let Some(record) = self.store.memory(owner, &identity).await? else {
            return Ok(Response::new(pb::UploadCompleteResponse {
                status: Ack::MemoryNotFound as i32,
            }));
        };

        // The device reports failures through this same RPC. Only a reported
        // SUCCESS means the assets are up. Marking a capture complete on a
        // failure report would claim frames we do not have.
        //
        // `UPLOAD_FAILURE_FINAL` is the device giving up on the asset
        // (`AssetUploadWorkerImpl.handleFatalError`, after `markUnuploadable`):
        // the full-resolution frames will never arrive, so the capture is
        // recorded as `failed_final` and the web can say so instead of showing
        // it as still uploading. The worker completes on ACKNOWLEDGED and
        // retries an INTERNAL_ERROR, so a failed write is reported as one. A
        // capture already complete keeps its state: its frames are here.
        // `UPLOAD_FAILURE` is a retryable attempt and changes nothing.
        if request.success != pb::UploadCompletionStatus::UploadSuccess as i32 {
            if request.success != pb::UploadCompletionStatus::UploadFailureFinal as i32
                || record.upload_state == crate::store::UploadState::Complete
            {
                return Ok(Response::new(pb::UploadCompleteResponse {
                    status: Ack::Acknowledged as i32,
                }));
            }
            let status = match self
                .store
                .record_upload_state(owner, &identity, crate::store::UploadState::FailedFinal)
                .await
            {
                Ok(true) => Ack::Acknowledged,
                Ok(false) => Ack::MemoryNotFound,
                Err(_) => Ack::InternalError,
            };
            return Ok(Response::new(pb::UploadCompleteResponse {
                status: status as i32,
            }));
        }

        // A reported SUCCESS is a CLAIM, and acting on it is destructive: the
        // ack is what makes `AssetUploadWorkerImpl.handleUploadSuccess` call
        // `delete(uploadableAssetEntity)` and, with `deleteCapturesOnUpload`
        // set, `mFileSystem.deleteDirectory(...)`, the wearer's only copy of
        // the frames. So the claim is only honoured after the stored objects
        // have been read back.
        //
        // `STATUS_UPLOAD_INCOMPLETE` is the worker's own arm for "you say you
        // finished, I do not have it": it resets `lastImgUploadedIdx` to 0 and
        // raises ITEM_RETRYABLE, so the device re-uploads from the first frame
        // and keeps everything. After `mMaxUploadAttempts` that path becomes
        // `handleFatalError`, which marks the asset unuploadable and logs
        // "not deleting capture", bounded, and still no wearer data loss.
        if !self.upload_bytes_landed(owner, &record).await {
            return Ok(Response::new(pb::UploadCompleteResponse {
                status: Ack::UploadIncomplete as i32,
            }));
        }

        let status = match self
            .store
            .record_upload_state(owner, &identity, crate::store::UploadState::Complete)
            .await
        {
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
            && !record.thumbnails.is_empty()
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
    /// and the only other source, `uploadCalibration`'s server path, comes
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
        // would have to refuse, the frames survive either way, but only this
        // arm tells the device the truth on the first step.
        let AssetArrival::Objects(objects) = &self.asset_arrival else {
            return Err(Status::unimplemented(
                "capture object storage is not configured",
            ));
        };

        // FAILED_PRECONDITION is not survivable for the device here.
        // `PhotographyUploadWorkerImpl.getErrorType` maps it to
        // WORKER_RETRYABLE, which reschedules the worker WITHOUT incrementing
        // the item's attempt count, with the served retry config (1_000_000
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
    /// a deployment that stores nothing, then a delete has no bytes to unlink
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
    /// `secure_filename` (JPG mode) or `secure_raw_data_filename` (YUV mode),
    /// never both, plus, for video, the imu and timing files when the device
    /// has them. So "every frame of burst zero is stored under one of its two
    /// secure slots" is the strongest true statement about the wearer's data,
    /// and it is exactly the plan the device itself follows. The imu/timing
    /// files are not required: the device skips them whenever its local path is
    /// null, so demanding them would strand every such capture.
    ///
    /// A capture with no allocated bursts cannot be confirmed at all. That is
    /// deliberate: notes and food logs contain no frames and no worker sends
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
    /// PERMISSION_DENIED, which `getErrorType` classes ITEM_RETRYABLE, bounded
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
/// three segments server-minted UUIDs. Anything else, a traversal, an absolute
/// path, an empty or dotted segment, a backslash, a control character, is not
/// a slot and is refused before it reaches the store. The exact-match check in
/// [`Capture::authorize_upload_slot`] is the actual gate. This only keeps a
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
/// `DeleteMemoryRequest` and `UploadCompleteRequest` both contain a uuid *and* a
/// numeric id, and different callers populate different ones: the shipping
/// workers send the uuid (`DeleteUploadWorkerImpl.deleteRecentFromWeb` and
/// `AssetUploadWorkerImpl.sendUploadComplete` both call `setMemoryUuid`), while
/// the manufacturing `UploadWorker` sends `setMemoryId`. Honouring only one of
/// them would silently no-op for the other caller, so the uuid is preferred and
/// the numeric id is the fallback. `None` means the request identified nothing.
fn request_kid(
    information: Option<&cosmos_protocol::common::encryption::EncryptionInformation>,
) -> String {
    information
        .map(|information| information.kid.clone())
        .unwrap_or_default()
}

fn memory_identity(memory_uuid: &str, memory_id: i64) -> Option<String> {
    let uuid = memory_uuid.trim();
    if !uuid.is_empty() {
        return Some(uuid.to_owned());
    }
    // A zero id is proto3's absent value, not capture zero.
    (memory_id != 0).then(|| memory_id.to_string())
}

/// Delete a capture, shared by `CaptureService` and `TestingAutomationService`,
/// the proto gives both services the same `DeleteMemory` RPC, and the test
/// automation surface must not be the one that quietly keeps the wearer's data
/// (`H4Device` drives it with `setMemoryUuid`).
///
/// The returned status is chosen against
/// `DeleteUploadWorkerImpl.handleDeleteMemoryResponse`:
///
/// * `SUCCESS` and `NOT_FOUND` both let the device drop its local row, which is
///   right in both cases, either we deleted it or we never had it.
/// * `FAILURE` is the only retryable arm, so a store that could not contain the
///   delete out must return exactly that. Reporting `SUCCESS` instead makes the
///   device forget a capture the cloud still holds.
///
/// **The frames go before the metadata does.** Tombstoning first and unlinking
/// after cannot be made correct: the tombstone hides the record from
/// `Store::memory`, and the record's bursts are the only description of which
/// objects belong to this capture, so a failure in between would strand the
/// wearer's photographs on the volume with nothing left able to name them. In
/// this order every step is idempotent, an already-absent object is fine, and a
/// retry of a half-finished delete finishes it.
pub(crate) async fn delete_memory(
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
        // makes the device retry. Anything else tells it the deletion happened.
        return Ok(pb::DeleteMemoryStatus::Failure);
    }

    // A food log's meal lives in the stored food log too, keyed by this
    // capture's uuid. Removed before the row for the same reason the frames
    // are: once the row is gone nothing names the entry any more.
    if record.kind == crate::store::MemoryKind::FoodLog
        && remove_food_log(store, principal, &record.uuid)
            .await
            .is_err()
    {
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
/// All six per-file names across EVERY burst, not just burst zero, which is all
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
    /// The body is an `EncryptedData` blob the device sealed. We hold no key for
    /// it and store it verbatim, the note is readable only on the wearer's pin.
    /// Previously this acked CREATE_SUCCESS with an EMPTY uuid and dropped the
    /// note, so every note the wearer took was lost.
    async fn create_note(
        &self,
        request: Request<pb::DeviceCreateNoteRequest>,
    ) -> Result<Response<pb::DeviceCreateNoteResponse>, Status> {
        let principal = self.principal(&request)?;
        let mut note = request.into_inner();
        let privacy = crate::services::public_privacy::AccountPrivacy::load(
            &self.store,
            principal.expose_for_authorization(),
        )
        .await?;
        if !privacy.location_allowed {
            note.encrypted_location = None;
        }
        let indexed_text = opened_note_text(&self.keys, note.encrypted_note.as_ref()).await?;
        let record = self
            .store
            .create_note(
                principal.expose_for_authorization(),
                crate::store::NewNote {
                    opened_text: indexed_text,
                    ..crate::store::NewNote::sealed(note.encrypted_note, note.encrypted_location)
                },
            )
            .await?;

        Ok(Response::new(pb::DeviceCreateNoteResponse {
            status: pb::CreateMemoryResultStatus::CreateSuccess as i32,
            memory_uuid: record.uuid,
        }))
    }

    /// Delete every note this wearer has. The response carries no count, but the
    /// deletion must actually happen, a no-op here means the wearer asks to
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
    /// object store, `H4Device` reaches captures through this surface.
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
    /// real `OnceLock` singleton, correct on the server, where every workload
    /// must see the one store the device established its channel key against. In
    /// a test it means rows written by one test are visible to every other test
    /// running in parallel, so an "empty account" assertion fails because some
    /// unrelated test wrote a note. These build the same services against an
    /// isolated in-memory store instead.
    fn fresh_store() -> crate::store::SharedStore {
        std::sync::Arc::new(crate::store::MemoryStore::default())
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

    /// REGRESSION: the slot counts went from the wire into `build_memory`'s
    /// allocations with nothing in between looking at their magnitude. This
    /// request is about ten bytes, so no decode limit sees it, and it asked the
    /// process to reserve hundreds of gigabytes, an allocator refusal at that
    /// size is `handle_alloc_error`, which ABORTS: the ai-bus container dies and
    /// takes every other wearer's in-flight capture, assistant turn and push with
    /// it, and one repeat does it again after the restart. Any authenticated
    /// caller on either plane could send it.
    ///
    /// If this test ever hangs or the runner dies instead of failing, that is the
    /// bug back: the refusal is gone and the allocation is being attempted.
    #[tokio::test]
    async fn privacy_testing_note_honors_location_off_without_losing_note() {
        use cosmos_protocol::privacy::grpc::r#pub::public_privacy_service_server::PublicPrivacyService;
        let store = fresh_store();
        let privacy =
            crate::services::public_privacy::PublicPrivacy::default().with_store(store.clone());
        let mut request = Request::new(
            cosmos_protocol::privacy::grpc::r#pub::UpdateSettingsRequest {
                settings: vec![cosmos_protocol::privacy::grpc::common::PrivacySetting {
                    name: "location".into(),
                    value: "off".into(),
                }],
            },
        );
        request
            .extensions_mut()
            .insert(cosmos_core::AuthenticatedPrincipal::from_edge(DEV_PRINCIPAL).unwrap());
        privacy.update_settings(request).await.unwrap();
        let keys = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let kid = "privacy-note-fixture";
        let key = [0x44; cosmos_crypto::AES_KEY_LEN];
        keys.put(kid, key).await.unwrap();
        let sealed = cosmos_crypto::seal(kid, &key, b"fixture note", b"").unwrap();
        let notes = TestingAutomation::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store.clone(),
            Default::default(),
        )
        .with_key_directory(keys);
        let response = notes
            .create_note(Request::new(pb::DeviceCreateNoteRequest {
                encrypted_note: Some(cosmos_protocol::common::encryption::EncryptedData {
                    data: sealed.data,
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: kid.into(),
                        },
                    ),
                }),
                encrypted_location: Some(cosmos_protocol::common::encryption::EncryptedData {
                    data: vec![10, 20, 30],
                    ..Default::default()
                }),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(!response.memory_uuid.is_empty());
        let rows = store
            .recent_notes(DEV_PRINCIPAL, 0, None, None)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].encrypted_note.is_some());
        assert!(rows[0].encrypted_location.is_none());
    }

    // INFERRED Luma privacy extension: a confirmed account location preference
    // must govern newly ingested capture metadata even before the Pin syncs.
    #[tokio::test]
    async fn privacy_location_off_drops_new_capture_location_after_settings_rpc() {
        use cosmos_protocol::privacy::grpc::r#pub as privacy;
        use cosmos_protocol::privacy::grpc::r#pub::public_privacy_service_server::PublicPrivacyService;
        let store = fresh_store();
        let service =
            crate::services::public_privacy::PublicPrivacy::default().with_store(store.clone());
        let mut update = Request::new(privacy::UpdateSettingsRequest {
            settings: vec![cosmos_protocol::privacy::grpc::common::PrivacySetting {
                name: "location".to_owned(),
                value: "off".to_owned(),
            }],
        });
        update
            .extensions_mut()
            .insert(cosmos_core::AuthenticatedPrincipal::from_edge(DEV_PRINCIPAL).unwrap());
        service.update_settings(update).await.expect("settings RPC");
        let capture = Capture::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store.clone(),
            Default::default(),
        );
        let response = capture
            .create_memory(Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::PhotoMemoryRequest(
                    pb::PhotoMemoryRequest {
                        num_bursts: 1,
                        num_pics_per_burst: 1,
                        device_local_id: "privacy-off-photo".to_owned(),
                        encrypted_location: Some(
                            cosmos_protocol::common::encryption::EncryptedData {
                                data: vec![11, 22, 33],
                                ..Default::default()
                            },
                        ),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .expect("capture still works")
            .into_inner();
        let record = store
            .memory(DEV_PRINCIPAL, &response.memory.unwrap().uuid)
            .await
            .unwrap()
            .unwrap();
        assert!(
            record.encrypted_location.is_none(),
            "location off must stop new location retention"
        );
    }

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
                    metadata: crate::store::CaptureMetadata::default(),
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

    use super::*;

    #[tokio::test]
    async fn capture_note_does_not_store_or_ack_when_authoritative_lookup_fails() {
        let store = fresh_store();
        let kid = "capture-note-authority";
        let key = [0x47; cosmos_crypto::AES_KEY_LEN];
        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        directory.put(kid, key).await.expect("seed authority");
        let capture = Capture::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store.clone(),
            Default::default(),
        )
        .with_capture_key_directory(directory.clone());
        let encrypted = cosmos_crypto::seal(kid, &key, b"retryable note", b"").expect("seal note");
        let request = || {
            Request::new(pb::CreateMemoryRequest {
                request: Some(pb::create_memory_request::Request::NoteMemoryRequest(
                    pb::NoteMemoryRequest {
                        encrypted_note: Some(cosmos_protocol::common::encryption::EncryptedData {
                            encryption_information: Some(
                                cosmos_protocol::common::encryption::EncryptionInformation {
                                    kid: kid.to_owned(),
                                },
                            ),
                            data: encrypted.data.clone(),
                        }),
                        encrypted_location: None,
                    },
                )),
            })
        };

        directory.fail_next(crate::keydirectory::DirectoryFault::Get);
        let error = capture
            .create_memory(request())
            .await
            .expect_err("directory outage must fail before note persistence");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        assert!(
            store
                .recent_notes(DEV_PRINCIPAL, 0, None, None)
                .await
                .expect("inspect store")
                .is_empty()
        );

        capture
            .create_memory(request())
            .await
            .expect("unchanged request is retryable");
        assert_eq!(
            store
                .recent_notes(DEV_PRINCIPAL, 0, None, None)
                .await
                .expect("inspect store")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn testing_note_does_not_store_or_ack_when_authoritative_lookup_fails() {
        let store = fresh_store();
        let kid = "testing-note-authority";
        let key = [0x48; cosmos_crypto::AES_KEY_LEN];
        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        directory.put(kid, key).await.expect("seed authority");
        let service = TestingAutomation::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store.clone(),
            Default::default(),
        )
        .with_key_directory(directory.clone());
        let encrypted =
            cosmos_crypto::seal(kid, &key, b"retryable automation note", b"").expect("seal note");
        let request = || {
            Request::new(pb::DeviceCreateNoteRequest {
                encrypted_note: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: kid.to_owned(),
                        },
                    ),
                    data: encrypted.data.clone(),
                }),
                encrypted_location: None,
            })
        };

        directory.fail_next(crate::keydirectory::DirectoryFault::Get);
        let error = service
            .create_note(request())
            .await
            .expect_err("directory outage must fail before note persistence");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        assert!(
            store
                .recent_notes(DEV_PRINCIPAL, 0, None, None)
                .await
                .expect("inspect store")
                .is_empty()
        );
        service
            .create_note(request())
            .await
            .expect("unchanged request is retryable");
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
            assert!(link.starts_with(&format!(
                "https://share.clone.example/public/humane.center/share/capture/{}?expiry=",
                memory.uuid
            )));
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
        // The upload URL is a CREDENTIAL, the only thing standing between a
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
                memory_uuid: url
                    .path_segments()
                    .and_then(Iterator::last)
                    .expect("memory uuid")
                    .to_owned(),
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
    /// storage key. Unchecked, any caller the edge lets through could name
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
                    metadata: crate::store::CaptureMetadata::default(),
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
    /// arbitrary local diagnostic filenames on this same RPC, none of those is
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
    /// `delete(uploadableAssetEntity)`, and with `deleteCapturesOnUpload`,
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
    /// The URL is the whole credential, nothing else authenticates the PUT,
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

    // ── W2: pending captures, metadata, upload state, sharing, food log ─────

    /// Stock Messages' `SHARE_LINK_REGEX` as Java runs it on one line of a
    /// message: `https://(.*)humane.center/share/capture/(.*)\?expiry=(.*)signature=(.*)`
    /// with `Matcher.find()`. Every group is greedy, so each one runs to the
    /// LAST place the rest of the pattern can still match, and `.` stops at a
    /// line break. Emulated here rather than compiled so the crate needs no
    /// regex engine. The semantics are those four greedy groups exactly.
    fn stock_share_link_groups(text: &str) -> Option<[String; 4]> {
        let line = text.lines().find(|line| line.contains("https://"))?;
        // `humane.center`: the `.` is any character.
        let anchor = |haystack: &str| -> Vec<usize> {
            let bytes = haystack.as_bytes();
            let (left, right) = (b"humane", b"center/share/capture/");
            (0..bytes.len())
                .filter(|&at| {
                    bytes[at..].starts_with(left)
                        && bytes.len() > at + left.len()
                        && bytes[at + left.len() + 1..].starts_with(right)
                })
                .collect()
        };
        for start in line.match_indices("https://").map(|(at, _)| at) {
            let rest = &line[start + "https://".len()..];
            for host_end in anchor(rest).into_iter().rev() {
                let group1 = &rest[..host_end];
                let after = &rest[host_end + "humane.center/share/capture/".len()..];
                let Some(expiry_at) = after.rfind("?expiry=") else {
                    continue;
                };
                let group2 = &after[..expiry_at];
                let tail = &after[expiry_at + "?expiry=".len()..];
                let Some(signature_at) = tail.rfind("signature=") else {
                    continue;
                };
                return Some([
                    group1.to_owned(),
                    group2.to_owned(),
                    tail[..signature_at].to_owned(),
                    tail[signature_at + "signature=".len()..].to_owned(),
                ]);
            }
        }
        None
    }

    /// A capture whose frames open: three HMSA thumbnails sealed under one
    /// escrowed key, as the Pin's `encryptThumbnailBytes` makes them.
    async fn sealed_three_frame_photo(
        svc: &Capture,
        store: &crate::store::SharedStore,
        principal: &str,
    ) -> (crate::store::MemoryRecord, Vec<Vec<u8>>) {
        const KID: &str = "d=pin1;u=wearer;k=share";
        let key = [9u8; cosmos_crypto::AES_KEY_LEN];
        svc.capture_keys.put(KID, key).await.expect("key escrowed");
        let frames = vec![jpeg_with_luma(40), jpeg_with_luma(120), jpeg_with_luma(200)];
        let thumbnails = frames
            .iter()
            .map(|frame| cosmos_protocol::common::encryption::EncryptedData {
                encryption_information: Some(
                    cosmos_protocol::common::encryption::EncryptionInformation {
                        kid: KID.to_owned(),
                    },
                ),
                data: cosmos_crypto::secure_asset::seal_secure_asset(
                    &key,
                    KID,
                    frame,
                    cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
                )
                .expect("sealed"),
            })
            .collect();
        let record = store
            .create_memory(
                principal,
                crate::store::NewMemory {
                    kind: crate::store::MemoryKind::Photo,
                    device_local_id: "shared-burst".to_owned(),
                    bursts: 1,
                    files_per_burst: 3,
                    device_created_time: None,
                    gmt_offset: 0,
                    thumbnails,
                    encrypted_location: None,
                    metadata: crate::store::CaptureMetadata::default(),
                },
            )
            .await
            .expect("stored");
        (record, frames)
    }

    /// THE PIN'S SHARE LINK MUST SURVIVE THE STOCK MESSAGES PARSER.
    ///
    /// `GetMemoryShareLink` used to mint `<base>/capture/<token>?memory_uuid…`,
    /// which the recipient's Messages never recognised and which nothing served.
    /// Now: the link matches `SHARE_LINK_REGEX`. Group 2 is the uuid. Group 3
    /// is the expiry followed by the `&` that `substring(0, length - 1)` strips;
    /// and the link `parseShareLink` rebuilds from a production config
    /// (`https://humane.center/share/capture/…`) still parses to the same
    /// `ShareLinkData`, which `GetShareLinkContents` resolves.
    #[tokio::test]
    async fn share_link_matches_stock_messages_regex() {
        let store = fresh_store();
        let svc = Capture {
            share: ShareAuthority::for_tests(Some("https://luma.example.com")),
            ..Capture::for_tests(store.clone(), AssetArrival::Confirmed)
        };
        let (record, frames) = sealed_three_frame_photo(&svc, &store, DEV_PRINCIPAL).await;
        let link = svc
            .get_memory_share_link(Request::new(pb::GetShareLinkRequest {
                // By numeric id: the link still names the canonical uuid.
                memory_uuid: record.numeric_id.to_string(),
            }))
            .await
            .expect("link minted")
            .into_inner()
            .share_link;
        assert!(
            link.starts_with(&format!(
                "https://luma.example.com/humane.center/share/capture/{}?expiry=",
                record.uuid
            )),
            "{link}"
        );

        // As an SMS body with text on either side, the way RecentsInteractor
        // composes it.
        let message = format!("Look at this\n{link}\nfrom my Pin");
        let [host, uuid, expiry, signature] =
            stock_share_link_groups(&message).expect("the stock regex matches the link");
        assert_eq!(host, "luma.example.com/");
        assert_eq!(uuid, record.uuid);
        assert!(
            expiry.ends_with('&'),
            "group 3 carries the separator: {expiry}"
        );
        let parsed_expiry: i64 = expiry[..expiry.len() - 1]
            .parse()
            .expect("Long.parseLong(substring(0, length - 1))");

        // `parseShareLink` rebuilds the link from the device's own config. A
        // production config has no env, and the rebuilt link is what
        // `downloadImageAndSave` parses again.
        let rebuilt = format!(
            "https://humane.center/share/capture/{uuid}?expiry={expiry}signature={signature}"
        );
        let [_, uuid, expiry, signature] =
            stock_share_link_groups(&rebuilt).expect("the rebuilt link parses too");
        let data = pb::ShareLinkData {
            memory_uuid: uuid,
            signature,
            expiry: expiry[..expiry.len() - 1].parse().expect("expiry"),
        };
        assert_eq!(data.expiry, parsed_expiry);
        let preview = svc
            .get_share_link_contents(Request::new(pb::GetShareLinkContentsRequest {
                share_link_data: Some(data),
            }))
            .await
            .expect("the recipient's preview resolves")
            .into_inner()
            .decrypted_thumbnail_bytes;
        assert_eq!(
            preview, frames[0],
            "no ranking yet: the first frame that opens"
        );
    }
}
