//! Media storage with filesystem for binary files and SQLite for metadata.

use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::fmt;
use std::fs::{File as StdFile, OpenOptions as StdOpenOptions};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::MetadataExt as _;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{info, warn};

use crate::db::Database;

pub const MAX_HTTP_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS: usize = 4;
const UPLOAD_CONTENT_FILENAME: &str = "data";
const MAX_STORAGE_DELETE_DEPTH: usize = 4;
const MAX_STORAGE_DELETE_ENTRIES: usize = 4_096;

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
    committed: bool,
    _lease: UploadLease,
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
                    // Publication already succeeded. Never report a retryable
                    // failure that could turn an accepted upload into conflict.
                    warn!(error = %error, "media parent directory sync was unavailable");
                }
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
        // stopped. On cancellation the unobserved task output drops it.
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
/// Directories are traversed through held descriptors. Symlinks and flat files
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
    match unlink_file(upload_directory, UPLOAD_CONTENT_FILENAME) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
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

// ─── MediaStore ─────────────────────────────────────────────────────

pub struct MediaStore {
    base_dir: PathBuf,
    base_directory: Arc<StdFile>,
    db: Database,
    upload_admission: Arc<UploadAdmission>,
}

#[allow(dead_code)] // Public API, some methods reserved for future features
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
}
