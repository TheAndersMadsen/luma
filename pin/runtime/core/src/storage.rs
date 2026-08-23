//! Media storage with filesystem for binary files and SQLite for metadata.

use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::fmt;
use std::fs::{File as StdFile, OpenOptions as StdOpenOptions};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::MetadataExt as _;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{info, warn};

use crate::db::Database;

pub const MAX_HTTP_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_AIBUS_LOGICAL_NAME_BYTES: usize = 1_024;
pub const MAX_AIBUS_CONTENT_TYPE_BYTES: usize = 256;
const MAX_AIBUS_RETAINED_UPLOADS: usize = 16;
const MAX_AIBUS_RETAINED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_AIBUS_UPLOAD_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_CONCURRENT_UPLOADS: usize = 4;
const UPLOAD_CONTENT_FILENAME: &str = "data";
const UPLOAD_METADATA_FILENAME: &str = "metadata.json";
const MAX_STORAGE_DELETE_DEPTH: usize = 4;
const MAX_STORAGE_DELETE_ENTRIES: usize = 4_096;
const MAX_AIBUS_METADATA_BYTES: u64 = 8 * 1024;

#[derive(Clone, Copy)]
struct AibusRetentionPolicy {
    maximum_age_ms: u64,
    maximum_uploads: usize,
    maximum_bytes: u64,
}

const AIBUS_RETENTION_POLICY: AibusRetentionPolicy = AibusRetentionPolicy {
    maximum_age_ms: MAX_AIBUS_UPLOAD_AGE.as_millis() as u64,
    maximum_uploads: MAX_AIBUS_RETAINED_UPLOADS,
    maximum_bytes: MAX_AIBUS_RETAINED_BYTES,
};

fn upload_conflict(message: &'static str) -> MediaStoreError {
    MediaStoreError::Io(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        message,
    ))
}

fn upload_capacity_exhausted() -> MediaStoreError {
    MediaStoreError::Io(std::io::Error::new(
        std::io::ErrorKind::WouldBlock,
        "media upload capacity is exhausted",
    ))
}

/// An already-opened, regular media file. Keeping the descriptor rather than
/// returning only a path closes the delete/replace race before an HTTP body is
/// streamed.
pub struct OpenedMediaFile {
    pub file: std::fs::File,
    pub len: u64,
}

#[derive(Debug)]
pub enum MediaStoreError {
    InvalidMemoryId,
    InvalidFilename,
    UnexpectedFilename,
    MemoryNotFound,
    UploadTooLarge,
    Io(std::io::Error),
    Database,
}

impl fmt::Display for MediaStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidMemoryId => "invalid memory identifier",
            Self::InvalidFilename => "invalid media filename",
            Self::UnexpectedFilename => "media filename is not expected for memory",
            Self::MemoryNotFound => "memory not found",
            Self::UploadTooLarge => "upload exceeds the configured limit",
            Self::Io(_) => "media storage I/O failed",
            Self::Database => "media database operation failed",
        })
    }
}

impl std::error::Error for MediaStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for MediaStoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Same-directory temporary upload that is made visible only after a complete,
/// bounded body has been flushed to disk.
pub struct PendingUpload {
    file: Option<fs::File>,
    directory: Arc<StdFile>,
    temporary_directory: StdFile,
    temporary_filename: String,
    final_filename: String,
    bytes_written: u64,
    digest: Sha256,
    metadata: Option<AibusUploadMetadata>,
    prune_aibus_retention_on_commit: bool,
    committed: bool,
    _lease: UploadLease,
}

/// Bounded, inert metadata persisted alongside a stock AIBus UploadFile body.
/// `logical_name` is supplied in the stock client's `file` HTTP header and is
/// never interpreted as a filesystem path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AibusUploadMetadata {
    pub use_case: i32,
    pub logical_name: String,
    pub content_type: String,
    pub issued_at_unix_ms: u64,
    pub bytes: u64,
    pub sha256: [u8; 32],
}

impl PendingUpload {
    pub async fn write_chunk(&mut self, chunk: &[u8]) -> Result<(), MediaStoreError> {
        let new_size = self
            .bytes_written
            .checked_add(chunk.len() as u64)
            .ok_or(MediaStoreError::UploadTooLarge)?;
        if new_size > MAX_HTTP_UPLOAD_BYTES {
            return Err(MediaStoreError::UploadTooLarge);
        }

        self.file
            .as_mut()
            .ok_or_else(|| MediaStoreError::Io(std::io::Error::other("upload is closed")))?
            .write_all(chunk)
            .await?;
        self.digest.update(chunk);
        self.bytes_written = new_size;
        Ok(())
    }

    pub async fn commit(mut self) -> Result<u64, MediaStoreError> {
        let mut file = self
            .file
            .take()
            .ok_or_else(|| MediaStoreError::Io(std::io::Error::other("upload is closed")))?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);

        if let Some(mut metadata) = self.metadata.take() {
            metadata.bytes = self.bytes_written;
            metadata.sha256 = self.digest.clone().finalize().into();
            let encoded = serde_json::to_vec_pretty(&metadata).map_err(|error| {
                MediaStoreError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
            })?;
            let metadata_file = create_file_at(
                self.temporary_directory.as_raw_fd(),
                UPLOAD_METADATA_FILENAME,
            )?;
            let mut metadata_file = fs::File::from_std(metadata_file);
            metadata_file.write_all(&encoded).await?;
            metadata_file.flush().await?;
            metadata_file.sync_all().await?;
            drop(metadata_file);
        }

        if let Err(error) = self.temporary_directory.sync_all() {
            // Some Android shared-storage implementations reject directory
            // fsync. The payload itself is durable, so keep publication
            // available and record the weaker directory durability guarantee.
            warn!(error = %error, "media upload directory sync was unavailable");
        }

        match publish_upload_directory_no_replace(
            self.directory.as_raw_fd(),
            &self.temporary_filename,
            &self.final_filename,
        ) {
            Ok(()) => {
                self.committed = true;
                if let Err(error) = self.directory.sync_all() {
                    // Publication already succeeded; never report a retryable
                    // failure that could turn an accepted upload into conflict.
                    warn!(error = %error, "media parent directory sync was unavailable");
                }
                self.prune_completed_aibus_uploads();
                Ok(self.bytes_written)
            }
            Err(error) if is_publish_conflict(&error) => {
                let expected_digest: [u8; 32] = self.digest.clone().finalize().into();
                let is_identical = matches!(
                    existing_file_matches(
                        self.directory.clone(),
                        &self.final_filename,
                        self.bytes_written,
                        &expected_digest,
                    )
                    .await,
                    Ok(true)
                );
                if is_identical {
                    remove_upload_directory(
                        self.directory.as_raw_fd(),
                        self.temporary_directory.as_raw_fd(),
                        &self.temporary_filename,
                    )?;
                    self.committed = true;
                    if let Err(error) = self.directory.sync_all() {
                        warn!(error = %error, "media parent directory sync was unavailable");
                    }
                    self.prune_completed_aibus_uploads();
                    Ok(self.bytes_written)
                } else {
                    Err(upload_conflict(
                        "an existing media file has different contents",
                    ))
                }
            }
            Err(error) => Err(MediaStoreError::Io(error)),
        }
    }

    fn prune_completed_aibus_uploads(&self) {
        if !self.prune_aibus_retention_on_commit {
            return;
        }
        if let Err(error) = prune_completed_aibus_uploads(
            &self.directory,
            AIBUS_RETENTION_POLICY,
            Some(&self.final_filename),
            unix_time_ms(),
        ) {
            // The upload is already atomically published. Returning an error
            // would prompt stock to retry a ticket that is deliberately one-use,
            // so retain the successful response and surface cleanup separately.
            warn!(error = %error, "AIBus completed-upload retention cleanup failed");
        }
    }

    pub async fn abort(mut self) {
        drop(self.file.take());
        self.committed = match remove_upload_directory(
            self.directory.as_raw_fd(),
            self.temporary_directory.as_raw_fd(),
            &self.temporary_filename,
        ) {
            Ok(()) => true,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        };
    }
}

impl Drop for PendingUpload {
    fn drop(&mut self) {
        if !self.committed {
            let _ = remove_upload_directory(
                self.directory.as_raw_fd(),
                self.temporary_directory.as_raw_fd(),
                &self.temporary_filename,
            );
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct UploadTarget {
    memory_id: String,
    filename: String,
}

#[derive(Default)]
struct UploadAdmissionState {
    active_uploads: HashSet<UploadTarget>,
    deleting_memories: HashSet<String>,
}

#[derive(Default)]
struct UploadAdmission {
    state: StdMutex<UploadAdmissionState>,
}

impl UploadAdmission {
    fn try_acquire(self: &Arc<Self>, target: UploadTarget) -> Result<UploadLease, MediaStoreError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.deleting_memories.contains(&target.memory_id) {
            return Err(upload_conflict("memory deletion is already active"));
        }
        if state.active_uploads.contains(&target) {
            return Err(upload_conflict(
                "an upload for this media file is already active",
            ));
        }
        if state.active_uploads.len() >= MAX_CONCURRENT_UPLOADS {
            return Err(upload_capacity_exhausted());
        }
        state.active_uploads.insert(target.clone());
        Ok(UploadLease {
            admission: self.clone(),
            target: Some(target),
        })
    }

    fn try_acquire_deletion(
        self: &Arc<Self>,
        memory_id: String,
    ) -> Result<DeletionLease, MediaStoreError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.deleting_memories.contains(&memory_id)
            || state
                .active_uploads
                .iter()
                .any(|target| target.memory_id == memory_id)
        {
            return Err(upload_conflict(
                "memory cannot be deleted while an upload is active",
            ));
        }
        state.deleting_memories.insert(memory_id.clone());
        Ok(DeletionLease {
            admission: self.clone(),
            memory_id: Some(memory_id),
        })
    }
}

struct UploadLease {
    admission: Arc<UploadAdmission>,
    target: Option<UploadTarget>,
}

impl Drop for UploadLease {
    fn drop(&mut self) {
        let Some(target) = self.target.take() else {
            return;
        };
        self.admission
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_uploads
            .remove(&target);
    }
}

struct DeletionLease {
    admission: Arc<UploadAdmission>,
    memory_id: Option<String>,
}

impl Drop for DeletionLease {
    fn drop(&mut self) {
        let Some(memory_id) = self.memory_id.take() else {
            return;
        };
        self.admission
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .deleting_memories
            .remove(&memory_id);
    }
}

async fn run_blocking_with_deletion_lease<F>(
    deletion_lease: DeletionLease,
    operation: F,
) -> Result<(DeletionLease, Result<(), MediaStoreError>), tokio::task::JoinError>
where
    F: FnOnce() -> Result<(), MediaStoreError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let result = operation();
        // A blocking task continues if its async caller is cancelled. Returning
        // the lease keeps uploads excluded until the operation has actually
        // stopped; on cancellation the unobserved task output drops it.
        (deletion_lease, result)
    })
    .await
}

fn component_name(value: &str) -> Result<CString, MediaStoreError> {
    CString::new(value).map_err(|_| MediaStoreError::InvalidFilename)
}

fn open_base_directory(path: &Path) -> Result<StdFile, MediaStoreError> {
    let mut options = StdOpenOptions::new();
    options.read(true);
    use std::os::unix::fs::OpenOptionsExt as _;
    options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options.open(path).map_err(MediaStoreError::Io)
}

fn open_directory_at(parent: RawFd, name: &str) -> Result<StdFile, MediaStoreError> {
    let name = component_name(name)?;
    open_directory_component_at(parent, &name).map_err(MediaStoreError::Io)
}

fn open_directory_component_at(parent: RawFd, name: &CStr) -> Result<StdFile, std::io::Error> {
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { StdFile::from_raw_fd(descriptor) })
}

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

#[cfg(target_os = "android")]
fn errno_pointer() -> *mut libc::c_int {
    unsafe { libc::__errno() }
}

#[cfg(target_os = "macos")]
fn errno_pointer() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

#[cfg(not(any(target_os = "android", target_os = "macos")))]
fn errno_pointer() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

fn directory_entries(
    directory: &StdFile,
    remaining_entries: &mut usize,
) -> Result<Vec<CString>, std::io::Error> {
    let duplicate = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(duplicate);
        }
        return Err(error);
    }
    let stream = DirectoryStream(stream);
    let mut entries = Vec::new();
    loop {
        unsafe {
            *errno_pointer() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let errno = unsafe { *errno_pointer() };
            if errno == 0 {
                break;
            }
            return Err(std::io::Error::from_raw_os_error(errno));
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        if *remaining_entries == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "media deletion exceeds the total entry limit",
            ));
        }
        *remaining_entries -= 1;
        entries.push(name.to_owned());
    }
    Ok(entries)
}

fn unlink_component_at(
    parent: RawFd,
    name: &CStr,
    flags: libc::c_int,
) -> Result<(), std::io::Error> {
    let result = unsafe { libc::unlinkat(parent, name.as_ptr(), flags) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Remove one storage entry without ever resolving it through a pathname.
/// Directories are traversed through held descriptors; symlinks and flat files
/// are unlinked as entries and never followed.
fn remove_storage_entry_at(
    parent: RawFd,
    name: &CStr,
    depth: usize,
    remaining_entries: &mut usize,
) -> Result<(), std::io::Error> {
    if depth > MAX_STORAGE_DELETE_DEPTH {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "media directory nesting exceeds the deletion limit",
        ));
    }

    let directory = match open_directory_component_at(parent, name) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTDIR) | Some(libc::ELOOP)
            ) =>
        {
            return match unlink_component_at(parent, name, 0) {
                Err(unlink_error) if unlink_error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                result => result,
            };
        }
        Err(error) => return Err(error),
    };
    let opened_metadata = directory.metadata()?;

    for child in directory_entries(&directory, remaining_entries)? {
        remove_storage_entry_at(directory.as_raw_fd(), &child, depth + 1, remaining_entries)?;
    }

    // A shared-storage writer may rename the entry while it is open. Refuse to
    // unlink a replacement by verifying that the current name still identifies
    // the exact directory we traversed.
    let current = open_directory_component_at(parent, name)?;
    let current_metadata = current.metadata()?;
    if opened_metadata.dev() != current_metadata.dev()
        || opened_metadata.ino() != current_metadata.ino()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "media directory changed during deletion",
        ));
    }
    drop(current);
    unlink_component_at(parent, name, libc::AT_REMOVEDIR)
}

fn remove_storage_directory_at(parent: RawFd, name: &str) -> Result<(), MediaStoreError> {
    let name = component_name(name)?;
    let mut remaining_entries = MAX_STORAGE_DELETE_ENTRIES;
    remove_storage_entry_at(parent, &name, 0, &mut remaining_entries).map_err(MediaStoreError::Io)
}

fn create_directory_at(parent: RawFd, name: &str) -> Result<StdFile, MediaStoreError> {
    let name = component_name(name)?;
    let created = unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) };
    if created != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(MediaStoreError::Io(error));
        }
    }
    let name = name
        .to_str()
        .map_err(|_| MediaStoreError::InvalidMemoryId)?;
    open_directory_at(parent, name)
}

fn create_upload_directory_at(parent: RawFd, name: &str) -> Result<StdFile, MediaStoreError> {
    let component = component_name(name)?;
    let created = unsafe { libc::mkdirat(parent, component.as_ptr(), 0o700) };
    if created != 0 {
        return Err(MediaStoreError::Io(std::io::Error::last_os_error()));
    }
    match open_directory_at(parent, name) {
        Ok(directory) => Ok(directory),
        Err(error) => {
            let _ = unsafe { libc::unlinkat(parent, component.as_ptr(), libc::AT_REMOVEDIR) };
            Err(error)
        }
    }
}

fn create_file_at(directory: RawFd, name: &str) -> Result<StdFile, MediaStoreError> {
    let name = component_name(name)?;
    let descriptor = unsafe {
        libc::openat(
            directory,
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(MediaStoreError::Io(std::io::Error::last_os_error()));
    }
    Ok(unsafe { StdFile::from_raw_fd(descriptor) })
}

fn open_file_at(directory: RawFd, name: &str) -> Result<StdFile, MediaStoreError> {
    let name = component_name(name)?;
    let descriptor = unsafe {
        libc::openat(
            directory,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(MediaStoreError::Io(std::io::Error::last_os_error()));
    }
    Ok(unsafe { StdFile::from_raw_fd(descriptor) })
}

/// Atomically publish a completed non-empty upload directory.
///
/// Android's emulated/FUSE media storage rejects `RENAME_NOREPLACE` and SELinux
/// denies hard links to `system_app`. A non-empty directory gives ordinary
/// `renameat` the same media-safety property: it cannot replace either a flat
/// legacy file or another non-empty published upload directory. An empty
/// directory may be replaced, but by definition that discards no media data.
fn publish_upload_directory_no_replace(
    directory: RawFd,
    source: &str,
    destination: &str,
) -> Result<(), std::io::Error> {
    let source =
        CString::new(source).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;

    let result =
        unsafe { libc::renameat(directory, source.as_ptr(), directory, destination.as_ptr()) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn is_publish_conflict(error: &std::io::Error) -> bool {
    error.raw_os_error().is_some_and(|code| {
        [libc::EEXIST, libc::ENOTEMPTY, libc::ENOTDIR, libc::EISDIR].contains(&code)
    })
}

fn remove_upload_directory(
    parent: RawFd,
    upload_directory: RawFd,
    name: &str,
) -> Result<(), std::io::Error> {
    for filename in [UPLOAD_CONTENT_FILENAME, UPLOAD_METADATA_FILENAME] {
        match unlink_file(upload_directory, filename) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let name =
        CString::new(name).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe { libc::unlinkat(parent, name.as_ptr(), libc::AT_REMOVEDIR) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn unlink_file(directory: RawFd, name: &str) -> Result<(), std::io::Error> {
    let name =
        CString::new(name).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe { libc::unlinkat(directory, name.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

async fn existing_file_matches(
    directory: Arc<StdFile>,
    filename: &str,
    expected_size: u64,
    expected_digest: &[u8; 32],
) -> Result<bool, MediaStoreError> {
    let opened = open_regular_media_file_at(&directory, filename)?;
    if opened.len != expected_size {
        return Ok(false);
    }

    let mut file = fs::File::from_std(opened.file);
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let actual_digest: [u8; 32] = digest.finalize().into();
    Ok(actual_digest == *expected_digest)
}

// ─── Memory metadata ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub uuid: String,
    pub memory_type: String,
    pub device_local_id: String,
    pub created_at: String,
    pub status: MemoryStatus,
    /// Filenames the server told the device to upload.
    pub files: Vec<String>,
    /// Number of thumbnails saved.
    pub thumbnail_count: usize,
    /// Plaintext location (decoded from LocationEnvelope proto when available).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    Pending,
    Uploading,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    pub latitude: f64,
    pub longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_readable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_address: Option<String>,
}

// ─── AIBus training-data uploads ───────────────────────────────────

/// Dedicated, opaque persistence for the stock AIBus UploadFile contract.
///
/// Uploaded filenames are server-generated UUIDs. The client-provided logical
/// filename is persisted only inside `metadata.json`, while the raw body always
/// lands in the fixed `data` file inside the same atomic directory envelope.
pub struct AibusUploadStore {
    #[allow(dead_code)]
    base_dir: PathBuf,
    base_directory: Arc<StdFile>,
    upload_admission: Arc<UploadAdmission>,
}

impl AibusUploadStore {
    pub async fn open(base_dir: impl AsRef<Path>) -> Result<Self, MediaStoreError> {
        let base_dir = base_dir.as_ref().to_path_buf();
        fs::create_dir_all(&base_dir).await?;
        let base_directory = Arc::new(open_base_directory(&base_dir)?);
        cleanup_stale_aibus_uploads(&base_directory)?;
        if let Err(error) = prune_completed_aibus_uploads(
            &base_directory,
            AIBUS_RETENTION_POLICY,
            None,
            unix_time_ms(),
        ) {
            // Retention failure should not make the stock gRPC service vanish;
            // every later successful commit retries the same bounded cleanup.
            warn!(error = %error, "AIBus retention cleanup on open failed");
        }
        info!(path = %base_dir.display(), "AIBus upload store opened");
        Ok(Self {
            base_dir,
            base_directory,
            upload_admission: Arc::new(UploadAdmission::default()),
        })
    }

    pub async fn begin_upload(
        &self,
        ticket: &str,
        metadata: AibusUploadMetadata,
    ) -> Result<PendingUpload, MediaStoreError> {
        let parsed = uuid::Uuid::parse_str(ticket).map_err(|_| MediaStoreError::InvalidMemoryId)?;
        if parsed.hyphenated().to_string() != ticket {
            return Err(MediaStoreError::InvalidMemoryId);
        }
        if metadata.logical_name.trim().is_empty()
            || metadata.logical_name.len() > MAX_AIBUS_LOGICAL_NAME_BYTES
            || metadata.content_type.trim().is_empty()
            || metadata.content_type.len() > MAX_AIBUS_CONTENT_TYPE_BYTES
            || metadata.logical_name.chars().any(char::is_control)
            || metadata.content_type.chars().any(char::is_control)
        {
            return Err(MediaStoreError::InvalidFilename);
        }

        let lease = self.upload_admission.try_acquire(UploadTarget {
            memory_id: "aibus-upload".to_string(),
            filename: ticket.to_string(),
        })?;
        let temporary_filename = format!(".upload-{}.tmp", uuid::Uuid::new_v4().simple());
        let temporary_directory =
            create_upload_directory_at(self.base_directory.as_raw_fd(), &temporary_filename)?;
        let file = match create_file_at(temporary_directory.as_raw_fd(), UPLOAD_CONTENT_FILENAME) {
            Ok(file) => file,
            Err(error) => {
                let _ = remove_upload_directory(
                    self.base_directory.as_raw_fd(),
                    temporary_directory.as_raw_fd(),
                    &temporary_filename,
                );
                return Err(error);
            }
        };

        Ok(PendingUpload {
            file: Some(fs::File::from_std(file)),
            directory: self.base_directory.clone(),
            temporary_directory,
            temporary_filename,
            final_filename: ticket.to_string(),
            bytes_written: 0,
            digest: Sha256::new(),
            metadata: Some(metadata),
            prune_aibus_retention_on_commit: true,
            committed: false,
            _lease: lease,
        })
    }
}

fn cleanup_stale_aibus_uploads(directory: &StdFile) -> Result<(), MediaStoreError> {
    let mut remaining_entries = MAX_STORAGE_DELETE_ENTRIES;
    let entries = match directory_entries(directory, &mut remaining_entries) {
        Ok(entries) => entries,
        Err(error) => {
            warn!(error = %error, "skipping bounded AIBus temporary-upload cleanup");
            return Ok(());
        }
    };
    for entry in entries {
        let bytes = entry.to_bytes();
        if !bytes.starts_with(b".upload-") || !bytes.ends_with(b".tmp") {
            continue;
        }
        let Ok(name) = entry.to_str() else {
            continue;
        };
        if let Err(error) = remove_storage_directory_at(directory.as_raw_fd(), name) {
            warn!(name, error = %error, "failed to remove stale AIBus upload");
        }
    }
    Ok(())
}

#[derive(Debug)]
struct CompletedAibusUpload {
    name: String,
    issued_at_unix_ms: u64,
    stored_bytes: u64,
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn inspect_completed_aibus_upload(
    directory: &StdFile,
    entry: &CStr,
) -> Result<Option<CompletedAibusUpload>, MediaStoreError> {
    let Some(name) = entry.to_str().ok() else {
        return Ok(None);
    };
    let Ok(parsed) = uuid::Uuid::parse_str(name) else {
        return Ok(None);
    };
    if parsed.hyphenated().to_string() != name {
        return Ok(None);
    }

    // Every component is opened relative to a held descriptor with
    // O_NOFOLLOW. Unknown, malformed, or externally replaced entries are not
    // treated as server-owned completed envelopes.
    let envelope = match open_directory_component_at(directory.as_raw_fd(), entry) {
        Ok(envelope) => envelope,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTDIR) | Some(libc::ELOOP)
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(MediaStoreError::Io(error)),
    };
    let data = open_file_at(envelope.as_raw_fd(), UPLOAD_CONTENT_FILENAME)?;
    let data_metadata = data.metadata()?;
    if !data_metadata.is_file() || data_metadata.len() > MAX_HTTP_UPLOAD_BYTES {
        return Ok(None);
    }

    let mut metadata_file = open_file_at(envelope.as_raw_fd(), UPLOAD_METADATA_FILENAME)?;
    let metadata_file_metadata = metadata_file.metadata()?;
    if !metadata_file_metadata.is_file()
        || metadata_file_metadata.len() == 0
        || metadata_file_metadata.len() > MAX_AIBUS_METADATA_BYTES
    {
        return Ok(None);
    }
    let mut encoded = Vec::with_capacity(metadata_file_metadata.len() as usize);
    std::io::Read::read_to_end(&mut metadata_file, &mut encoded)?;
    let metadata: AibusUploadMetadata = match serde_json::from_slice(&encoded) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };
    if metadata.bytes != data_metadata.len() {
        return Ok(None);
    }
    let stored_bytes = data_metadata
        .len()
        .saturating_add(metadata_file_metadata.len());
    Ok(Some(CompletedAibusUpload {
        name: name.to_string(),
        issued_at_unix_ms: metadata.issued_at_unix_ms,
        stored_bytes,
    }))
}

fn prune_completed_aibus_uploads(
    directory: &StdFile,
    policy: AibusRetentionPolicy,
    protected_name: Option<&str>,
    now_unix_ms: u64,
) -> Result<(), MediaStoreError> {
    let mut remaining_entries = MAX_STORAGE_DELETE_ENTRIES;
    let entries = directory_entries(directory, &mut remaining_entries)?;
    let mut uploads = Vec::new();
    for entry in entries {
        match inspect_completed_aibus_upload(directory, &entry) {
            Ok(Some(upload)) => uploads.push(upload),
            Ok(None) => {}
            Err(error) => {
                warn!(error = %error, "skipping unreadable AIBus upload during retention scan");
            }
        }
    }
    uploads.sort_by(|left, right| {
        left.issued_at_unix_ms
            .cmp(&right.issued_at_unix_ms)
            .then_with(|| left.name.cmp(&right.name))
    });

    let mut retained = vec![true; uploads.len()];
    let mut retained_count = uploads.len();
    let mut retained_bytes = uploads.iter().fold(0_u64, |total, upload| {
        total.saturating_add(upload.stored_bytes)
    });
    let mut removed_count = 0_usize;
    let mut removed_bytes = 0_u64;

    let remove = |index: usize| {
        if protected_name == Some(uploads[index].name.as_str()) {
            return false;
        }
        match remove_storage_directory_at(directory.as_raw_fd(), &uploads[index].name) {
            Ok(()) => true,
            Err(error) => {
                warn!(error = %error, "failed to prune completed AIBus upload");
                false
            }
        }
    };

    for index in 0..uploads.len() {
        if now_unix_ms.saturating_sub(uploads[index].issued_at_unix_ms) > policy.maximum_age_ms
            && retained[index]
            && remove(index)
        {
            retained[index] = false;
            retained_count = retained_count.saturating_sub(1);
            retained_bytes = retained_bytes.saturating_sub(uploads[index].stored_bytes);
            removed_count += 1;
            removed_bytes = removed_bytes.saturating_add(uploads[index].stored_bytes);
        }
    }
    for index in 0..uploads.len() {
        if retained_count <= policy.maximum_uploads && retained_bytes <= policy.maximum_bytes {
            break;
        }
        if retained[index] && remove(index) {
            retained[index] = false;
            retained_count = retained_count.saturating_sub(1);
            retained_bytes = retained_bytes.saturating_sub(uploads[index].stored_bytes);
            removed_count += 1;
            removed_bytes = removed_bytes.saturating_add(uploads[index].stored_bytes);
        }
    }

    if removed_count > 0 {
        info!(
            removed_count,
            removed_bytes, "pruned completed AIBus uploads"
        );
        if let Err(error) = directory.sync_all() {
            warn!(error = %error, "AIBus retention directory sync was unavailable");
        }
    }
    Ok(())
}

// ─── MediaStore ─────────────────────────────────────────────────────

pub struct MediaStore {
    base_dir: PathBuf,
    base_directory: Arc<StdFile>,
    db: Database,
    upload_admission: Arc<UploadAdmission>,
}

#[allow(dead_code)] // Public API — some methods reserved for future features
impl MediaStore {
    /// Open (or create) the media store at the given directory.
    pub async fn open(
        base_dir: impl AsRef<Path>,
        db: Database,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let base_dir = base_dir.as_ref().to_path_buf();
        fs::create_dir_all(&base_dir).await?;
        let base_directory = Arc::new(open_base_directory(&base_dir)?);

        let count = db.list_memories().await.map(|v| v.len()).unwrap_or(0);
        info!(count, "media store opened (sqlite)");

        Ok(Self {
            base_dir,
            base_directory,
            db,
            upload_admission: Arc::new(UploadAdmission::default()),
        })
    }

    /// Create a new memory record and its directory.
    pub async fn create_memory(
        &mut self,
        uuid: String,
        memory_type: &str,
        device_local_id: &str,
        created_at: &str,
        files: Vec<String>,
        location: Option<Location>,
    ) -> Result<MemoryRecord, Box<dyn std::error::Error + Send + Sync>> {
        let existing = if device_local_id.is_empty() {
            None
        } else {
            self.db
                .find_memory_by_device_local_id_and_type_and_created_at(
                    device_local_id,
                    memory_type,
                    created_at,
                )
                .await?
        };
        if let Some(record) = existing {
            return Ok(record);
        }

        validate_memory_id(&uuid)?;
        for filename in &files {
            validate_filename(filename)?;
        }
        let _directory = create_directory_at(self.base_directory.as_raw_fd(), &uuid)?;

        let record = MemoryRecord {
            uuid,
            memory_type: memory_type.to_string(),
            device_local_id: device_local_id.to_string(),
            created_at: created_at.to_string(),
            status: MemoryStatus::Pending,
            files,
            thumbnail_count: 0,
            location,
        };

        let create_result = self.db.create_memory(&record).await;
        if let Err(error) = create_result {
            if !device_local_id.is_empty() {
                if let Ok(Some(record)) = self
                    .db
                    .find_memory_by_device_local_id_and_type_and_created_at(
                        &record.device_local_id,
                        &record.memory_type,
                        &record.created_at,
                    )
                    .await
                {
                    return Ok(record);
                }
            }
            return Err(error);
        }
        Ok(record)
    }

    /// Save a thumbnail as a separate .jpg file.
    pub async fn save_thumbnail(
        &mut self,
        uuid: &str,
        index: usize,
        data: &[u8],
    ) -> Result<String, Box<dyn std::error::Error>> {
        let filename = format!("thumbnail_{index}.jpg");
        let mut upload = self.begin_internal_upload(uuid, &filename).await?;
        upload.write_chunk(data).await?;
        upload.commit().await?;

        // Thumbnails have their own authenticated API route and are rendered
        // separately by Center. Keep them out of the device-upload file list
        // so photo/video detail views do not render the same JPEG twice.
        let new_count = index + 1;
        self.db
            .set_thumbnail_count(uuid, new_count)
            .await
            .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;

        info!(bytes = data.len(), "saved thumbnail");
        Ok(filename)
    }

    /// Save an uploaded file (streamed from HTTP PUT).
    pub async fn save_upload(
        &self,
        uuid: &str,
        filename: &str,
        data: &[u8],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut upload = self.begin_internal_upload(uuid, filename).await?;
        upload.write_chunk(data).await?;
        upload.commit().await?;
        info!(bytes = data.len(), "saved upload");
        Ok(())
    }

    /// Mark a memory as complete.
    pub async fn complete_memory(
        &mut self,
        uuid: &str,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        self.db
            .set_memory_status(uuid, &MemoryStatus::Complete)
            .await
            .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })
    }

    /// Mark a memory as failed.
    pub async fn fail_memory(&mut self, uuid: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.db
            .set_memory_status(uuid, &MemoryStatus::Failed)
            .await
            .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;
        Ok(())
    }

    /// Delete a memory (record + directory).
    pub async fn delete_memory(&mut self, uuid: &str) -> Result<bool, Box<dyn std::error::Error>> {
        validate_memory_id(uuid)?;
        let deletion_lease = self
            .upload_admission
            .try_acquire_deletion(uuid.to_string())?;
        let base_directory = self.base_directory.clone();
        let memory_id = uuid.to_string();
        let (_deletion_lease, removal_result) =
            run_blocking_with_deletion_lease(deletion_lease, move || {
                remove_storage_directory_at(base_directory.as_raw_fd(), &memory_id)
            })
            .await
            .map_err(|_| std::io::Error::other("media deletion worker failed"))?;
        removal_result?;
        self.db
            .delete_memory(uuid)
            .await
            .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })
    }

    /// Look up a memory by UUID.
    pub async fn get_memory(&self, uuid: &str) -> Option<MemoryRecord> {
        self.db.get_memory(uuid).await.ok().flatten()
    }

    /// Find a memory that owns a given filename.
    pub async fn find_memory_for_file(&self, filename: &str) -> Option<MemoryRecord> {
        self.db.find_memory_for_file(filename).await.ok().flatten()
    }

    /// List all memories.
    pub async fn list_memories(&self) -> Vec<MemoryRecord> {
        self.db.list_memories().await.unwrap_or_else(|e| {
            warn!(error = %e, "failed to list memories from db");
            Vec::new()
        })
    }

    /// Read bounded plaintext FoodLog protobuf payloads from food-log memories
    /// at or after an epoch-second cutoff. Metadata selection happens in SQL so
    /// no photo, video, note, or older memory file is opened.
    pub async fn read_food_log_payloads_since(
        &self,
        start_seconds: i64,
        maximum_count: usize,
        maximum_payload_bytes: usize,
        maximum_total_bytes: usize,
    ) -> Result<Vec<Vec<u8>>, MediaStoreError> {
        if maximum_count == 0 || maximum_payload_bytes == 0 || maximum_total_bytes == 0 {
            return Ok(Vec::new());
        }
        let memory_ids = self
            .db
            .list_memory_ids_by_type_since("food_log", start_seconds, maximum_count)
            .await
            .map_err(|_| MediaStoreError::Database)?;

        let mut payloads = Vec::with_capacity(memory_ids.len());
        let mut total_bytes = 0usize;
        for memory_id in memory_ids {
            let opened = match self.open_internal_media_file(&memory_id, "food_log.bin") {
                Ok(opened) => opened,
                Err(MediaStoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                    continue;
                }
                Err(MediaStoreError::InvalidFilename) => continue,
                Err(error) => return Err(error),
            };
            let declared_size = usize::try_from(opened.len).unwrap_or(usize::MAX);
            if declared_size > maximum_payload_bytes
                || total_bytes.saturating_add(declared_size) > maximum_total_bytes
            {
                continue;
            }

            let mut payload = Vec::with_capacity(declared_size);
            let read_limit = u64::try_from(maximum_payload_bytes)
                .unwrap_or(u64::MAX)
                .saturating_add(1);
            fs::File::from_std(opened.file)
                .take(read_limit)
                .read_to_end(&mut payload)
                .await?;
            if payload.len() > maximum_payload_bytes
                || total_bytes.saturating_add(payload.len()) > maximum_total_bytes
            {
                continue;
            }
            total_bytes += payload.len();
            payloads.push(payload);
        }
        Ok(payloads)
    }

    /// Base directory path.
    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub fn memory_dir(&self, uuid: &str) -> Result<PathBuf, MediaStoreError> {
        validate_memory_id(uuid)?;
        Ok(self.base_dir.join(uuid))
    }

    pub fn media_file_path(&self, uuid: &str, filename: &str) -> Result<PathBuf, MediaStoreError> {
        let directory = self.memory_dir(uuid)?;
        validate_filename(filename)?;
        // This is the logical filesystem entry only. Production reads must use
        // the held-descriptor openers below so legacy flat files and new upload
        // envelopes cannot be swapped through a pathname race.
        Ok(directory.join(filename))
    }

    /// Open a device-uploaded file only when the exact memory record owns the
    /// filename. The final path component may not be a symlink and the opened
    /// handle must still describe a bounded regular file.
    pub async fn open_media_file(
        &self,
        uuid: &str,
        filename: &str,
    ) -> Result<OpenedMediaFile, MediaStoreError> {
        validate_memory_id(uuid)?;
        validate_filename(filename)?;
        let memory = self
            .db
            .get_memory(uuid)
            .await
            .map_err(|_| MediaStoreError::Database)?
            .ok_or(MediaStoreError::MemoryNotFound)?;
        if !memory.files.iter().any(|expected| expected == filename) {
            return Err(MediaStoreError::UnexpectedFilename);
        }
        let directory = open_directory_at(self.base_directory.as_raw_fd(), uuid)?;
        open_regular_media_file_at(&directory, filename)
    }

    /// Open server-generated media that is selected by trusted metadata rather
    /// than the device-declared `files` list (for example FoodLog payloads).
    fn open_internal_media_file(
        &self,
        uuid: &str,
        filename: &str,
    ) -> Result<OpenedMediaFile, MediaStoreError> {
        validate_memory_id(uuid)?;
        validate_filename(filename)?;
        let directory = open_directory_at(self.base_directory.as_raw_fd(), uuid)?;
        open_regular_media_file_at(&directory, filename)
    }

    /// Open a generated thumbnail only when its index is present in the memory
    /// record. Thumbnail names never share the uploaded-file namespace.
    pub async fn open_thumbnail_file(
        &self,
        uuid: &str,
        index: usize,
    ) -> Result<OpenedMediaFile, MediaStoreError> {
        let memory = self
            .db
            .get_memory(uuid)
            .await
            .map_err(|_| MediaStoreError::Database)?
            .ok_or(MediaStoreError::MemoryNotFound)?;
        if index >= memory.thumbnail_count {
            return Err(MediaStoreError::UnexpectedFilename);
        }
        validate_memory_id(uuid)?;
        let filename = format!("thumbnail_{index}.jpg");
        validate_filename(&filename)?;
        let directory = open_directory_at(self.base_directory.as_raw_fd(), uuid)?;
        open_regular_media_file_at(&directory, &filename)
    }

    pub async fn begin_upload(
        &self,
        uuid: &str,
        filename: &str,
    ) -> Result<PendingUpload, MediaStoreError> {
        self.begin_upload_with_policy(uuid, filename, true).await
    }

    async fn begin_internal_upload(
        &self,
        uuid: &str,
        filename: &str,
    ) -> Result<PendingUpload, MediaStoreError> {
        self.begin_upload_with_policy(uuid, filename, false).await
    }

    async fn begin_upload_with_policy(
        &self,
        uuid: &str,
        filename: &str,
        require_expected_filename: bool,
    ) -> Result<PendingUpload, MediaStoreError> {
        validate_memory_id(uuid)?;
        validate_filename(filename)?;
        let memory = match self.db.get_memory(uuid).await {
            Ok(Some(memory)) => memory,
            Ok(None) => return Err(MediaStoreError::MemoryNotFound),
            Err(_) => return Err(MediaStoreError::Database),
        };
        if require_expected_filename && !memory.files.iter().any(|expected| expected == filename) {
            return Err(MediaStoreError::UnexpectedFilename);
        }
        if require_expected_filename
            && matches!(memory.status, MemoryStatus::Complete | MemoryStatus::Failed)
        {
            return Err(upload_conflict(
                "completed or failed memories cannot accept device uploads",
            ));
        }

        let lease = self.upload_admission.try_acquire(UploadTarget {
            memory_id: uuid.to_string(),
            filename: filename.to_string(),
        })?;
        let directory = Arc::new(open_directory_at(self.base_directory.as_raw_fd(), uuid)?);
        let temporary_filename = format!(".upload-{}.tmp", uuid::Uuid::new_v4().simple());
        let temporary_directory =
            create_upload_directory_at(directory.as_raw_fd(), &temporary_filename)?;
        let file = match create_file_at(temporary_directory.as_raw_fd(), UPLOAD_CONTENT_FILENAME) {
            Ok(file) => file,
            Err(error) => {
                let _ = remove_upload_directory(
                    directory.as_raw_fd(),
                    temporary_directory.as_raw_fd(),
                    &temporary_filename,
                );
                return Err(error);
            }
        };

        Ok(PendingUpload {
            file: Some(fs::File::from_std(file)),
            directory,
            temporary_directory,
            temporary_filename,
            final_filename: filename.to_string(),
            bytes_written: 0,
            digest: Sha256::new(),
            metadata: None,
            prune_aibus_retention_on_commit: false,
            committed: false,
            _lease: lease,
        })
    }

    /// Access the underlying database handle.
    pub fn db(&self) -> &Database {
        &self.db
    }
}

fn validate_memory_id(value: &str) -> Result<(), MediaStoreError> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| MediaStoreError::InvalidMemoryId)?;
    if parsed.hyphenated().to_string() != value {
        return Err(MediaStoreError::InvalidMemoryId);
    }
    Ok(())
}

fn validate_filename(value: &str) -> Result<(), MediaStoreError> {
    if value.is_empty()
        || value.len() > 255
        || value.contains('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(MediaStoreError::InvalidFilename);
    }

    let mut components = Path::new(value).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(MediaStoreError::InvalidFilename);
    }
    Ok(())
}

fn open_regular_media_file_at(
    directory: &StdFile,
    filename: &str,
) -> Result<OpenedMediaFile, MediaStoreError> {
    validate_filename(filename)?;
    let file = open_file_at(directory.as_raw_fd(), filename)?;
    let metadata = file.metadata()?;
    if metadata.is_file() {
        return bounded_regular_file(file, metadata.len());
    }

    // New uploads use an opaque non-empty directory as the atomic publication
    // unit on Android FUSE. Legacy flat files remain readable. Both levels are
    // opened relative to held descriptors with O_NOFOLLOW.
    if metadata.is_dir() {
        let data = open_file_at(file.as_raw_fd(), UPLOAD_CONTENT_FILENAME)?;
        let data_metadata = data.metadata()?;
        if data_metadata.is_file() {
            return bounded_regular_file(data, data_metadata.len());
        }
    }
    Err(MediaStoreError::InvalidFilename)
}

fn bounded_regular_file(file: StdFile, len: u64) -> Result<OpenedMediaFile, MediaStoreError> {
    if len > MAX_HTTP_UPLOAD_BYTES {
        return Err(MediaStoreError::UploadTooLarge);
    }
    Ok(OpenedMediaFile { file, len })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_store() -> (tempfile::TempDir, MediaStore) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("media.sqlite")).unwrap();
        let store = MediaStore::open(directory.path().join("media"), database)
            .await
            .unwrap();
        (directory, store)
    }

    async fn create_test_memory(store: &mut MediaStore, files: &[&str]) -> String {
        let memory_id = uuid::Uuid::new_v4().to_string();
        store
            .create_memory(
                memory_id.clone(),
                "photo",
                &memory_id,
                "created",
                files
                    .iter()
                    .map(|filename| (*filename).to_string())
                    .collect(),
                None,
            )
            .await
            .unwrap();
        memory_id
    }

    fn assert_io_kind<T>(result: Result<T, MediaStoreError>, expected: std::io::ErrorKind) {
        match result {
            Err(MediaStoreError::Io(error)) => assert_eq!(error.kind(), expected),
            Err(error) => panic!("expected {expected:?} I/O error, got {error:?}"),
            Ok(_) => panic!("expected {expected:?} I/O error, got success"),
        }
    }

    fn write_completed_aibus_upload(
        root: &Path,
        ticket: &str,
        issued_at_unix_ms: u64,
        body: &[u8],
    ) -> u64 {
        let envelope = root.join(ticket);
        std::fs::create_dir_all(&envelope).unwrap();
        std::fs::write(envelope.join(UPLOAD_CONTENT_FILENAME), body).unwrap();
        let metadata = AibusUploadMetadata {
            use_case: 1,
            logical_name: "debug/session.bin".into(),
            content_type: "application/octet-stream".into(),
            issued_at_unix_ms,
            bytes: body.len() as u64,
            sha256: Sha256::digest(body).into(),
        };
        let encoded = serde_json::to_vec_pretty(&metadata).unwrap();
        std::fs::write(envelope.join(UPLOAD_METADATA_FILENAME), &encoded).unwrap();
        body.len() as u64 + encoded.len() as u64
    }

    #[tokio::test]
    async fn aibus_upload_uses_an_opaque_atomic_envelope() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("aibus-uploads");
        let store = AibusUploadStore::open(&root).await.unwrap();
        let ticket = uuid::Uuid::new_v4().to_string();
        let logical_name = "../../outside/debug/session.json";
        let mut upload = store
            .begin_upload(
                &ticket,
                AibusUploadMetadata {
                    use_case: 1,
                    logical_name: logical_name.into(),
                    content_type: "application/json".into(),
                    issued_at_unix_ms: 123,
                    bytes: 0,
                    sha256: [0; 32],
                },
            )
            .await
            .unwrap();
        upload.write_chunk(b"training-data").await.unwrap();
        assert_eq!(upload.commit().await.unwrap(), 13);

        let envelope = root.join(&ticket);
        assert_eq!(
            std::fs::read(envelope.join(UPLOAD_CONTENT_FILENAME)).unwrap(),
            b"training-data"
        );
        let metadata: AibusUploadMetadata = serde_json::from_slice(
            &std::fs::read(envelope.join(UPLOAD_METADATA_FILENAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata.logical_name, logical_name);
        assert_eq!(metadata.bytes, 13);
        assert_ne!(metadata.sha256, [0; 32]);
        assert!(!directory.path().join("outside").exists());
        assert_eq!(std::fs::read_dir(envelope).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn aborted_aibus_upload_leaves_no_visible_or_temporary_entry() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("aibus-uploads");
        let store = AibusUploadStore::open(&root).await.unwrap();
        let ticket = uuid::Uuid::new_v4().to_string();
        let mut upload = store
            .begin_upload(
                &ticket,
                AibusUploadMetadata {
                    use_case: 2,
                    logical_name: "hand/tracking.bin".into(),
                    content_type: "application/octet-stream".into(),
                    issued_at_unix_ms: 123,
                    bytes: 0,
                    sha256: [0; 32],
                },
            )
            .await
            .unwrap();
        upload.write_chunk(b"partial").await.unwrap();
        upload.abort().await;

        assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn aibus_store_removes_only_stale_temporary_envelopes_on_open() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("aibus-uploads");
        let stale = root.join(".upload-stale.tmp");
        let complete = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join(UPLOAD_CONTENT_FILENAME), b"partial").unwrap();
        std::fs::create_dir_all(&complete).unwrap();
        std::fs::write(complete.join(UPLOAD_CONTENT_FILENAME), b"complete").unwrap();

        let _store = AibusUploadStore::open(&root).await.unwrap();

        assert!(!stale.exists());
        assert_eq!(
            std::fs::read(complete.join(UPLOAD_CONTENT_FILENAME)).unwrap(),
            b"complete"
        );
    }

    #[test]
    fn aibus_retention_prunes_expired_completed_uploads() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("aibus-uploads");
        std::fs::create_dir_all(&root).unwrap();
        let expired = uuid::Uuid::new_v4().to_string();
        let fresh = uuid::Uuid::new_v4().to_string();
        write_completed_aibus_upload(&root, &expired, 100, b"expired");
        write_completed_aibus_upload(&root, &fresh, 950, b"fresh");
        let root_directory = open_base_directory(&root).unwrap();

        prune_completed_aibus_uploads(
            &root_directory,
            AibusRetentionPolicy {
                maximum_age_ms: 200,
                maximum_uploads: 10,
                maximum_bytes: u64::MAX,
            },
            None,
            1_000,
        )
        .unwrap();

        assert!(!root.join(expired).exists());
        assert!(root.join(fresh).exists());
    }

    #[test]
    fn aibus_retention_prunes_oldest_by_count_and_total_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("aibus-uploads");
        std::fs::create_dir_all(&root).unwrap();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        let third = uuid::Uuid::new_v4().to_string();
        write_completed_aibus_upload(&root, &first, 100, b"first");
        let second_bytes = write_completed_aibus_upload(&root, &second, 200, b"second");
        let third_bytes = write_completed_aibus_upload(&root, &third, 300, b"third");
        let root_directory = open_base_directory(&root).unwrap();

        // The count cap removes the first envelope. The remaining two still
        // exceed this byte cap, so the older second envelope is removed too.
        prune_completed_aibus_uploads(
            &root_directory,
            AibusRetentionPolicy {
                maximum_age_ms: u64::MAX,
                maximum_uploads: 2,
                maximum_bytes: second_bytes + third_bytes - 1,
            },
            None,
            400,
        )
        .unwrap();

        assert!(!root.join(first).exists());
        assert!(!root.join(second).exists());
        assert!(root.join(third).exists());
    }

    #[test]
    fn aibus_retention_never_prunes_the_just_committed_upload() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("aibus-uploads");
        std::fs::create_dir_all(&root).unwrap();
        let current = uuid::Uuid::new_v4().to_string();
        let other = uuid::Uuid::new_v4().to_string();
        write_completed_aibus_upload(&root, &current, 100, b"current");
        write_completed_aibus_upload(&root, &other, 200, b"other");
        let root_directory = open_base_directory(&root).unwrap();

        prune_completed_aibus_uploads(
            &root_directory,
            AibusRetentionPolicy {
                maximum_age_ms: 0,
                maximum_uploads: 1,
                maximum_bytes: 1,
            },
            Some(&current),
            1_000,
        )
        .unwrap();

        assert!(root.join(current).exists());
        assert!(!root.join(other).exists());
    }

    #[test]
    fn media_paths_require_canonical_uuid_and_single_safe_filename() {
        let base = PathBuf::from("media-root");
        let valid_uuid = uuid::Uuid::new_v4().to_string();

        validate_memory_id(&valid_uuid).unwrap();
        validate_filename("capture_01.jpg").unwrap();
        for invalid in ["..", ".", "", "nested/file", "nested\\file", "bad\nname"] {
            assert!(validate_filename(invalid).is_err(), "accepted {invalid:?}");
        }
        for invalid in ["..", "unknown", "not-a-uuid"] {
            assert!(validate_memory_id(invalid).is_err(), "accepted {invalid:?}");
        }

        let path = base.join(&valid_uuid).join("capture_01.jpg");
        assert!(path.starts_with(&base));
    }

    #[test]
    fn no_replace_publish_consumes_source_and_preserves_existing_destination() {
        use std::io::Write as _;

        fn upload_directory(parent: RawFd, name: &str, content: &[u8]) -> StdFile {
            let directory = create_upload_directory_at(parent, name).unwrap();
            let mut file = create_file_at(directory.as_raw_fd(), UPLOAD_CONTENT_FILENAME).unwrap();
            file.write_all(content).unwrap();
            file.sync_all().unwrap();
            directory
        }

        let directory = tempfile::tempdir().unwrap();
        let held_directory = open_base_directory(directory.path()).unwrap();
        let descriptor = held_directory.as_raw_fd();

        let _first = upload_directory(descriptor, ".upload-first", b"first");

        publish_upload_directory_no_replace(descriptor, ".upload-first", "capture.jpg").unwrap();
        assert!(!directory.path().join(".upload-first").exists());
        assert_eq!(
            std::fs::read(
                directory
                    .path()
                    .join("capture.jpg")
                    .join(UPLOAD_CONTENT_FILENAME),
            )
            .unwrap(),
            b"first"
        );

        let _second = upload_directory(descriptor, ".upload-second", b"second");

        let error =
            publish_upload_directory_no_replace(descriptor, ".upload-second", "capture.jpg")
                .unwrap_err();
        assert!(is_publish_conflict(&error));
        assert!(directory.path().join(".upload-second").is_dir());
        assert_eq!(
            std::fs::read(
                directory
                    .path()
                    .join("capture.jpg")
                    .join(UPLOAD_CONTENT_FILENAME),
            )
            .unwrap(),
            b"first"
        );
    }

    #[tokio::test]
    async fn device_upload_requires_a_filename_expected_by_the_exact_memory() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("media.sqlite")).unwrap();
        let mut store = MediaStore::open(directory.path().join("media"), database)
            .await
            .unwrap();
        let first_uuid = uuid::Uuid::new_v4().to_string();
        let second_uuid = uuid::Uuid::new_v4().to_string();
        store
            .create_memory(
                first_uuid.clone(),
                "photo",
                "device",
                "created",
                vec!["first.jpg".to_string()],
                None,
            )
            .await
            .unwrap();
        store
            .create_memory(
                second_uuid,
                "photo",
                "device",
                "created",
                vec!["second.jpg".to_string()],
                None,
            )
            .await
            .unwrap();

        assert!(matches!(
            store.begin_upload(&first_uuid, "second.jpg").await,
            Err(MediaStoreError::UnexpectedFilename)
        ));
        let upload = store.begin_upload(&first_uuid, "first.jpg").await.unwrap();
        upload.abort().await;
    }

    #[tokio::test]
    async fn media_download_opens_only_owned_regular_files() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("media.sqlite")).unwrap();
        let mut store = MediaStore::open(directory.path().join("media"), database)
            .await
            .unwrap();
        let memory_id = uuid::Uuid::new_v4().to_string();
        store
            .create_memory(
                memory_id.clone(),
                "video",
                "device",
                "created",
                vec!["capture.mp4".to_string()],
                None,
            )
            .await
            .unwrap();
        let mut upload = store.begin_upload(&memory_id, "capture.mp4").await.unwrap();
        upload.write_chunk(b"video-bytes").await.unwrap();
        upload.commit().await.unwrap();

        let opened = store
            .open_media_file(&memory_id, "capture.mp4")
            .await
            .unwrap();
        assert_eq!(opened.len, 11);
        assert!(matches!(
            store.open_media_file(&memory_id, "unowned.mp4").await,
            Err(MediaStoreError::UnexpectedFilename)
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target = store.media_file_path(&memory_id, "target.mp4").unwrap();
            std::fs::write(&target, b"outside").unwrap();
            let logical = store.media_file_path(&memory_id, "capture.mp4").unwrap();
            let data = logical.join(UPLOAD_CONTENT_FILENAME);

            // Reject a swapped inner payload while holding the logical
            // container descriptor.
            std::fs::remove_file(&data).unwrap();
            symlink(&target, &data).unwrap();
            assert!(matches!(
                store.open_media_file(&memory_id, "capture.mp4").await,
                Err(MediaStoreError::Io(_))
            ));
            assert_eq!(std::fs::read(&target).unwrap(), b"outside");

            // Reject a symlink replacing the whole logical media entry too.
            std::fs::remove_file(&data).unwrap();
            std::fs::remove_dir(&logical).unwrap();
            symlink(&target, &logical).unwrap();
            assert!(matches!(
                store.open_media_file(&memory_id, "capture.mp4").await,
                Err(MediaStoreError::Io(_))
            ));
            assert_eq!(std::fs::read(&target).unwrap(), b"outside");
        }
    }

    #[tokio::test]
    async fn previous_flat_files_remain_readable_and_retry_safe() {
        use std::io::Read as _;

        let (_directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        let previous_path = store.media_file_path(&memory_id, "capture.jpg").unwrap();
        std::fs::write(&previous_path, b"legacy-bytes").unwrap();

        let mut opened = store
            .open_media_file(&memory_id, "capture.jpg")
            .await
            .unwrap();
        let mut bytes = Vec::new();
        opened.file.read_to_end(&mut bytes).unwrap();
        assert_eq!(opened.len, 12);
        assert_eq!(bytes, b"legacy-bytes");

        let mut identical = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        identical.write_chunk(b"legacy-bytes").await.unwrap();
        assert_eq!(identical.commit().await.unwrap(), 12);
        assert_eq!(std::fs::read(&previous_path).unwrap(), b"legacy-bytes");

        let mut conflicting = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        conflicting.write_chunk(b"different").await.unwrap();
        assert_io_kind(
            conflicting.commit().await,
            std::io::ErrorKind::AlreadyExists,
        );
        assert_eq!(std::fs::read(&previous_path).unwrap(), b"legacy-bytes");
    }

    #[tokio::test]
    async fn zero_byte_upload_still_publishes_a_nonempty_envelope() {
        let (_directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["empty.bin"]).await;

        let upload = store.begin_upload(&memory_id, "empty.bin").await.unwrap();
        assert_eq!(upload.commit().await.unwrap(), 0);

        let logical = store.media_file_path(&memory_id, "empty.bin").unwrap();
        assert!(logical.is_dir());
        assert!(logical.join(UPLOAD_CONTENT_FILENAME).is_file());
        assert_eq!(std::fs::read_dir(&logical).unwrap().count(), 1);
        assert_eq!(
            store
                .open_media_file(&memory_id, "empty.bin")
                .await
                .unwrap()
                .len,
            0
        );
    }

    #[tokio::test]
    async fn delete_memory_removes_envelopes_without_following_child_symlinks() {
        use std::os::unix::fs::symlink;

        let (directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        let mut upload = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        upload.write_chunk(b"photo").await.unwrap();
        upload.commit().await.unwrap();

        let outside = directory.path().join("outside-delete-target");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), b"preserve").unwrap();
        symlink(
            &outside,
            store.memory_dir(&memory_id).unwrap().join("outside-link"),
        )
        .unwrap();

        assert!(store.delete_memory(&memory_id).await.unwrap());
        assert!(store.get_memory(&memory_id).await.is_none());
        assert!(!store.memory_dir(&memory_id).unwrap().exists());
        assert_eq!(
            std::fs::read(outside.join("sentinel")).unwrap(),
            b"preserve"
        );
    }

    #[tokio::test]
    async fn delete_memory_uses_held_base_directory_after_base_path_swap() {
        use std::os::unix::fs::symlink;

        let (directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        let mut upload = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        upload.write_chunk(b"trusted").await.unwrap();
        upload.commit().await.unwrap();

        let base_path = directory.path().join("media");
        let original_base = directory.path().join("original-media-base-for-delete");
        std::fs::rename(&base_path, &original_base).unwrap();
        let outside_base = directory.path().join("outside-media-base-for-delete");
        let outside_memory = outside_base.join(&memory_id);
        std::fs::create_dir_all(&outside_memory).unwrap();
        std::fs::write(outside_memory.join("sentinel"), b"preserve").unwrap();
        symlink(&outside_base, &base_path).unwrap();

        assert!(store.delete_memory(&memory_id).await.unwrap());
        assert!(!original_base.join(&memory_id).exists());
        assert_eq!(
            std::fs::read(outside_memory.join("sentinel")).unwrap(),
            b"preserve"
        );
        assert!(store.get_memory(&memory_id).await.is_none());
    }

    #[tokio::test]
    async fn delete_memory_rejects_active_uploads_without_partial_removal() {
        let (_directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        let mut upload = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        upload.write_chunk(b"in flight").await.unwrap();

        let error = store.delete_memory(&memory_id).await.unwrap_err();
        assert!(matches!(
            error.downcast_ref::<MediaStoreError>(),
            Some(MediaStoreError::Io(io_error))
                if io_error.kind() == std::io::ErrorKind::AlreadyExists
        ));
        assert!(store.get_memory(&memory_id).await.is_some());
        assert!(store.memory_dir(&memory_id).unwrap().is_dir());

        upload.abort().await;
        assert!(store.delete_memory(&memory_id).await.unwrap());
        assert!(store.get_memory(&memory_id).await.is_none());
    }

    #[tokio::test]
    async fn deletion_lease_prevents_new_uploads_until_release() {
        let (_directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        let deletion = store
            .upload_admission
            .try_acquire_deletion(memory_id.clone())
            .unwrap();

        assert_io_kind(
            store.begin_upload(&memory_id, "capture.jpg").await,
            std::io::ErrorKind::AlreadyExists,
        );
        drop(deletion);

        let upload = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        upload.abort().await;
    }

    #[tokio::test]
    async fn cancelled_delete_future_holds_lease_until_blocking_work_stops() {
        let (_directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        let deletion = store
            .upload_admission
            .try_acquire_deletion(memory_id.clone())
            .unwrap();
        let (entered_sender, entered_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let task = tokio::spawn(run_blocking_with_deletion_lease(deletion, move || {
            let _ = entered_sender.send(());
            release_receiver.recv().unwrap();
            Ok(())
        }));
        entered_receiver.await.unwrap();

        task.abort();
        tokio::task::yield_now().await;
        assert_io_kind(
            store.begin_upload(&memory_id, "capture.jpg").await,
            std::io::ErrorKind::AlreadyExists,
        );

        release_sender.send(()).unwrap();
        let upload = loop {
            match store.begin_upload(&memory_id, "capture.jpg").await {
                Ok(upload) => break upload,
                Err(MediaStoreError::Io(error))
                    if error.kind() == std::io::ErrorKind::AlreadyExists =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                Err(error) => {
                    panic!("unexpected upload error after deletion release: {error:?}")
                }
            }
        };
        upload.abort().await;
    }

    #[test]
    fn recursive_deletion_uses_one_total_entry_budget() {
        let directory = tempfile::tempdir().unwrap();
        let memory_id = uuid::Uuid::new_v4().to_string();
        let memory = directory.path().join(&memory_id);
        std::fs::create_dir(&memory).unwrap();
        for child in ["first", "second"] {
            let nested = memory.join(child);
            std::fs::create_dir(&nested).unwrap();
            std::fs::write(nested.join("data"), child.as_bytes()).unwrap();
        }
        let base = open_base_directory(directory.path()).unwrap();
        let component = component_name(&memory_id).unwrap();
        // Two top-level directories plus two nested files require four total
        // entries. A shared budget of three must stop the traversal even
        // though neither individual directory approaches the production cap.
        let mut remaining_entries = 3;
        let error =
            remove_storage_entry_at(base.as_raw_fd(), &component, 0, &mut remaining_entries)
                .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(memory.exists());
    }

    #[tokio::test]
    async fn pending_upload_enforces_limit_and_abort_cleans_temporary_file() {
        let (_directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.bin"]).await;
        let mut upload = store.begin_upload(&memory_id, "capture.bin").await.unwrap();
        let temporary_path = store
            .memory_dir(&memory_id)
            .unwrap()
            .join(&upload.temporary_filename);
        upload.bytes_written = MAX_HTTP_UPLOAD_BYTES;

        assert!(matches!(
            upload.write_chunk(&[1]).await,
            Err(MediaStoreError::UploadTooLarge)
        ));
        upload.abort().await;
        assert!(!temporary_path.exists());
    }

    #[tokio::test]
    async fn concurrent_uploads_to_the_same_target_are_rejected_until_release() {
        let (_directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;

        let first = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        assert_io_kind(
            store.begin_upload(&memory_id, "capture.jpg").await,
            std::io::ErrorKind::AlreadyExists,
        );

        first.abort().await;
        let second = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        drop(second);

        let third = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        third.abort().await;
    }

    #[tokio::test]
    async fn global_upload_admission_is_bounded_and_released_on_drop() {
        let (_directory, mut store) = test_store().await;
        let filenames: Vec<String> = (0..=MAX_CONCURRENT_UPLOADS)
            .map(|index| format!("capture-{index}.jpg"))
            .collect();
        let file_refs: Vec<&str> = filenames.iter().map(String::as_str).collect();
        let memory_id = create_test_memory(&mut store, &file_refs).await;

        let mut active = Vec::new();
        for filename in filenames.iter().take(MAX_CONCURRENT_UPLOADS) {
            active.push(store.begin_upload(&memory_id, filename).await.unwrap());
        }
        assert_io_kind(
            store
                .begin_upload(&memory_id, &filenames[MAX_CONCURRENT_UPLOADS])
                .await,
            std::io::ErrorKind::WouldBlock,
        );

        drop(active.pop());
        let replacement = store
            .begin_upload(&memory_id, &filenames[MAX_CONCURRENT_UPLOADS])
            .await
            .unwrap();
        replacement.abort().await;
        for upload in active {
            upload.abort().await;
        }
    }

    #[tokio::test]
    async fn terminal_memories_reject_device_uploads() {
        let (_directory, mut store) = test_store().await;
        let complete_id = create_test_memory(&mut store, &["complete.jpg"]).await;
        let failed_id = create_test_memory(&mut store, &["failed.jpg"]).await;

        assert!(store.complete_memory(&complete_id).await.unwrap());
        store.fail_memory(&failed_id).await.unwrap();

        assert_io_kind(
            store.begin_upload(&complete_id, "complete.jpg").await,
            std::io::ErrorKind::AlreadyExists,
        );
        assert_io_kind(
            store.begin_upload(&failed_id, "failed.jpg").await,
            std::io::ErrorKind::AlreadyExists,
        );
    }

    #[tokio::test]
    async fn commit_accepts_identical_retry_and_rejects_conflicting_content() {
        let (_directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;

        let mut first = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        first.write_chunk(b"same-content").await.unwrap();
        assert_eq!(first.commit().await.unwrap(), 12);
        let final_path = store
            .media_file_path(&memory_id, "capture.jpg")
            .unwrap()
            .join(UPLOAD_CONTENT_FILENAME);

        let mut retry = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        retry.write_chunk(b"same-content").await.unwrap();
        assert_eq!(retry.commit().await.unwrap(), 12);
        assert_eq!(fs::read(&final_path).await.unwrap(), b"same-content");

        let mut conflict = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        conflict.write_chunk(b"other-content").await.unwrap();
        assert_io_kind(conflict.commit().await, std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&final_path).await.unwrap(), b"same-content");

        let entries: Vec<String> = std::fs::read_dir(store.memory_dir(&memory_id).unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(!entries.iter().any(|name| name.starts_with(".upload-")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_memory_directory_is_rejected_for_reads_and_uploads() {
        use std::os::unix::fs::symlink;

        let (directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        let memory_path = store.memory_dir(&memory_id).unwrap();
        std::fs::remove_dir(&memory_path).unwrap();
        let outside = directory.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("capture.jpg"), b"outside").unwrap();
        symlink(&outside, &memory_path).unwrap();

        assert!(matches!(
            store.open_media_file(&memory_id, "capture.jpg").await,
            Err(MediaStoreError::Io(_))
        ));
        assert!(matches!(
            store.begin_upload(&memory_id, "capture.jpg").await,
            Err(MediaStoreError::Io(_))
        ));
        assert!(matches!(
            store.begin_upload(&memory_id, "capture.jpg").await,
            Err(MediaStoreError::Io(_))
        ));
        assert_eq!(
            std::fs::read(outside.join("capture.jpg")).unwrap(),
            b"outside"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pending_upload_commits_through_held_directory_after_parent_swap() {
        use std::os::unix::fs::symlink;

        let (directory, mut store) = test_store().await;
        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        let mut upload = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        upload.write_chunk(b"trusted").await.unwrap();

        let original = store.memory_dir(&memory_id).unwrap();
        let moved = directory.path().join("original-memory-directory");
        std::fs::rename(&original, &moved).unwrap();
        let outside = directory.path().join("outside-memory-directory");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, &original).unwrap();

        assert_eq!(upload.commit().await.unwrap(), 7);
        assert_eq!(
            std::fs::read(moved.join("capture.jpg").join(UPLOAD_CONTENT_FILENAME),).unwrap(),
            b"trusted"
        );
        assert!(!outside.join("capture.jpg").exists());
        assert!(matches!(
            store.open_media_file(&memory_id, "capture.jpg").await,
            Err(MediaStoreError::Io(_))
        ));

        let entries: Vec<String> = std::fs::read_dir(&moved)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, ["capture.jpg"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn media_store_uses_held_base_directory_after_base_path_swap() {
        use std::os::unix::fs::symlink;

        let (directory, mut store) = test_store().await;
        let base_path = directory.path().join("media");
        let original_base = directory.path().join("original-media-base");
        let outside = directory.path().join("outside-media-base");
        std::fs::rename(&base_path, &original_base).unwrap();
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, &base_path).unwrap();

        let memory_id = create_test_memory(&mut store, &["capture.jpg"]).await;
        assert!(original_base.join(&memory_id).is_dir());
        assert!(!outside.join(&memory_id).exists());

        let mut upload = store.begin_upload(&memory_id, "capture.jpg").await.unwrap();
        upload.write_chunk(b"trusted").await.unwrap();
        upload.commit().await.unwrap();
        assert_eq!(
            std::fs::read(
                original_base
                    .join(memory_id)
                    .join("capture.jpg")
                    .join(UPLOAD_CONTENT_FILENAME),
            )
            .unwrap(),
            b"trusted"
        );
        assert!(!outside.join("capture.jpg").exists());
    }

    #[tokio::test]
    async fn thumbnails_are_not_duplicated_in_the_capture_file_list() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("media.sqlite")).unwrap();
        let mut store = MediaStore::open(directory.path().join("media"), database)
            .await
            .unwrap();
        let memory_uuid = uuid::Uuid::new_v4().to_string();
        store
            .create_memory(
                memory_uuid.clone(),
                "video",
                "device",
                "created",
                vec!["capture.mp4".into()],
                None,
            )
            .await
            .unwrap();

        store
            .save_thumbnail(&memory_uuid, 0, &[0xff, 0xd8, 0xff])
            .await
            .unwrap();
        let memory = store.get_memory(&memory_uuid).await.unwrap();
        assert_eq!(memory.thumbnail_count, 1);
        assert_eq!(memory.files, ["capture.mp4"]);
    }

    #[tokio::test]
    async fn food_log_reader_filters_type_and_time_and_enforces_all_bounds() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("media.sqlite")).unwrap();
        let mut store = MediaStore::open(directory.path().join("media"), database)
            .await
            .unwrap();

        async fn add(store: &mut MediaStore, kind: &str, at: i64, payload: &[u8]) {
            let uuid = uuid::Uuid::new_v4().to_string();
            store
                .create_memory(
                    uuid.clone(),
                    kind,
                    "device",
                    &at.to_string(),
                    Vec::new(),
                    None,
                )
                .await
                .unwrap();
            store
                .save_upload(&uuid, "food_log.bin", payload)
                .await
                .unwrap();
        }

        add(&mut store, "food_log", 9, b"old").await;
        add(&mut store, "photo", 10, b"photo").await;
        add(&mut store, "food_log", 10, b"first").await;
        add(&mut store, "food_log", 11, b"second").await;

        assert_eq!(
            store
                .read_food_log_payloads_since(10, 1, 64, 64)
                .await
                .unwrap(),
            [b"first".to_vec()]
        );
        assert_eq!(
            store
                .read_food_log_payloads_since(10, 8, 5, 10)
                .await
                .unwrap(),
            [b"first".to_vec()]
        );
        assert!(store
            .read_food_log_payloads_since(10, 8, 64, 4)
            .await
            .unwrap()
            .is_empty());
    }
}
