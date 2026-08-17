//! Read-only indexing and explicit deletion for app-private fitness exports.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SUMMARY_FILENAME: &str = "activity-tracking-summary.csv";
pub const LOCATION_FILENAME: &str = "activity-tracking-location-data.gpx";
pub const SENSOR_FILENAME: &str = "activity-tracking-sensor-data.csv";
const MANIFEST_FILENAME: &str = "manifest.json";

const MAX_MANIFEST_BYTES: u64 = 16 * 1024;
const MAX_SUMMARY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LOCATION_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SENSOR_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = MAX_SUMMARY_BYTES + MAX_LOCATION_BYTES + MAX_SENSOR_BYTES;
const MAX_SESSION_DURATION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_TEXT_FIELD_CHARS: usize = 256;
const MAX_STORED_SESSIONS: usize = 20;

#[derive(Clone)]
pub struct FitnessStore {
    root: Arc<PathBuf>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FitnessSession {
    pub session_id: String,
    pub started_at_ms: i64,
    pub stopped_at_ms: i64,
    pub duration_ms: i64,
    pub files: Vec<FitnessFileMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<FitnessSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FitnessFileMetadata {
    pub filename: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FitnessSummary {
    pub splits: String,
    pub pace: String,
    pub elapsed_time: String,
    pub cumulative_distance_km: f64,
    pub moving_time: String,
    pub motion_breakdown: String,
    pub step_count: u64,
}

#[derive(Debug)]
pub struct FitnessFile {
    pub file: File,
    pub filename: String,
    pub size_bytes: u64,
    pub content_type: &'static str,
}

#[derive(Debug)]
pub enum FitnessStoreError {
    InvalidSessionId,
    InvalidFilename,
    InvalidManifest,
    InvalidStoredPath,
    Io(std::io::Error),
}

impl FitnessStoreError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidSessionId => "invalid_session_id",
            Self::InvalidFilename => "invalid_filename",
            Self::InvalidManifest => "invalid_manifest",
            Self::InvalidStoredPath => "invalid_stored_path",
            Self::Io(_) => "io",
        }
    }
}

impl fmt::Display for FitnessStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.kind())
    }
}

impl std::error::Error for FitnessStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for FitnessStoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FitnessManifest {
    version: u8,
    session_id: String,
    started_at_ms: i64,
    stopped_at_ms: i64,
    files: Vec<FitnessFileMetadata>,
}

impl FitnessStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, FitnessStoreError> {
        let root = root.as_ref();
        if root.exists() && fs::symlink_metadata(root)?.file_type().is_symlink() {
            return Err(FitnessStoreError::InvalidStoredPath);
        }
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        if !fs::metadata(&root)?.is_dir() {
            return Err(FitnessStoreError::InvalidStoredPath);
        }
        Ok(Self {
            root: Arc::new(root),
        })
    }

    pub fn list_sessions(&self) -> Result<Vec<FitnessSession>, FitnessStoreError> {
        let mut sessions = Vec::new();
        for entry in fs::read_dir(self.root.as_ref())? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if canonical_session_id(name).is_err() {
                continue;
            }
            match self.load_session(name) {
                Ok(Some(session)) => sessions.push(session),
                Ok(None)
                | Err(FitnessStoreError::InvalidManifest | FitnessStoreError::InvalidStoredPath) => {
                }
                Err(error) => return Err(error),
            }
        }
        sessions.sort_by(|left, right| {
            right
                .stopped_at_ms
                .cmp(&left.stopped_at_ms)
                .then_with(|| right.session_id.cmp(&left.session_id))
        });
        sessions.truncate(MAX_STORED_SESSIONS);
        Ok(sessions)
    }

    pub fn get_session(
        &self,
        session_id: &str,
    ) -> Result<Option<FitnessSession>, FitnessStoreError> {
        canonical_session_id(session_id)?;
        self.load_session(session_id)
    }

    pub fn file(
        &self,
        session_id: &str,
        filename: &str,
    ) -> Result<Option<FitnessFile>, FitnessStoreError> {
        validate_filename(filename)?;
        let Some(session) = self.get_session(session_id)? else {
            return Ok(None);
        };
        let Some(metadata) = session.files.iter().find(|file| file.filename == filename) else {
            return Ok(None);
        };
        let directory = self.session_directory(session_id)?;
        let file = open_verified_file(&directory, filename, metadata.size_bytes)?;
        Ok(Some(FitnessFile {
            file,
            filename: filename.to_string(),
            size_bytes: metadata.size_bytes,
            content_type: content_type(filename),
        }))
    }

    pub fn delete_session(&self, session_id: &str) -> Result<bool, FitnessStoreError> {
        canonical_session_id(session_id)?;
        let Some(_) = self.get_session(session_id)? else {
            return Ok(false);
        };
        remove_tree_no_follow(&self.session_directory(session_id)?)?;
        Ok(true)
    }

    pub fn clear(&self) -> Result<usize, FitnessStoreError> {
        let mut deleted = 0;
        for entry in fs::read_dir(self.root.as_ref())? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_importer_owned_directory_name(&name) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            // A forged symlink may have an importer-looking name. Never follow or
            // delete it through this administrative cleanup operation.
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            remove_tree_no_follow(&entry.path())?;
            deleted += 1;
        }
        Ok(deleted)
    }

    fn load_session(&self, session_id: &str) -> Result<Option<FitnessSession>, FitnessStoreError> {
        let directory = self.session_directory(session_id)?;
        if !directory.exists() {
            return Ok(None);
        }
        let metadata = fs::symlink_metadata(&directory)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(FitnessStoreError::InvalidStoredPath);
        }
        if fs::canonicalize(&directory)?.parent() != Some(self.root.as_path()) {
            return Err(FitnessStoreError::InvalidStoredPath);
        }

        let manifest_path = safe_regular_file(&directory, MANIFEST_FILENAME, 0)?;
        let manifest: FitnessManifest =
            serde_json::from_slice(&read_bounded(&manifest_path, MAX_MANIFEST_BYTES)?)
                .map_err(|_| FitnessStoreError::InvalidManifest)?;
        validate_manifest(&manifest, session_id)?;

        let expected_names = manifest
            .files
            .iter()
            .map(|file| file.filename.as_str())
            .chain(std::iter::once(MANIFEST_FILENAME))
            .collect::<HashSet<_>>();
        let actual_names = fs::read_dir(&directory)?
            .map(|entry| {
                entry
                    .map_err(FitnessStoreError::Io)?
                    .file_name()
                    .into_string()
                    .map_err(|_| FitnessStoreError::InvalidStoredPath)
            })
            .collect::<Result<HashSet<_>, _>>()?;
        if actual_names.len() != expected_names.len()
            || !actual_names
                .iter()
                .all(|name| expected_names.contains(name.as_str()))
        {
            return Err(FitnessStoreError::InvalidStoredPath);
        }

        for file in &manifest.files {
            safe_regular_file(&directory, &file.filename, file.size_bytes)?;
        }
        let summary = parse_summary(&safe_regular_file(
            &directory,
            SUMMARY_FILENAME,
            manifest
                .files
                .iter()
                .find(|file| file.filename == SUMMARY_FILENAME)
                .ok_or(FitnessStoreError::InvalidManifest)?
                .size_bytes,
        )?)
        .ok();

        Ok(Some(FitnessSession {
            session_id: manifest.session_id,
            started_at_ms: manifest.started_at_ms,
            stopped_at_ms: manifest.stopped_at_ms,
            duration_ms: manifest.stopped_at_ms - manifest.started_at_ms,
            files: manifest.files,
            summary,
        }))
    }

    fn session_directory(&self, session_id: &str) -> Result<PathBuf, FitnessStoreError> {
        canonical_session_id(session_id)?;
        let path = self.root.join(session_id);
        if path.parent() != Some(self.root.as_path()) {
            return Err(FitnessStoreError::InvalidStoredPath);
        }
        Ok(path)
    }
}

fn validate_manifest(
    manifest: &FitnessManifest,
    expected_session_id: &str,
) -> Result<(), FitnessStoreError> {
    if manifest.version != 1
        || canonical_session_id(&manifest.session_id).is_err()
        || manifest.session_id != expected_session_id
        || manifest.started_at_ms <= 0
        || manifest.stopped_at_ms < manifest.started_at_ms
        || manifest.stopped_at_ms - manifest.started_at_ms > MAX_SESSION_DURATION_MS
        || !(2..=3).contains(&manifest.files.len())
    {
        return Err(FitnessStoreError::InvalidManifest);
    }
    let names = manifest
        .files
        .iter()
        .map(|file| file.filename.as_str())
        .collect::<HashSet<_>>();
    if names.len() != manifest.files.len()
        || !names.contains(SUMMARY_FILENAME)
        || !names.contains(LOCATION_FILENAME)
    {
        return Err(FitnessStoreError::InvalidManifest);
    }
    let mut total = 0_u64;
    for file in &manifest.files {
        let limit = max_bytes(&file.filename).map_err(|_| FitnessStoreError::InvalidManifest)?;
        if file.size_bytes == 0 || file.size_bytes > limit {
            return Err(FitnessStoreError::InvalidManifest);
        }
        total = total
            .checked_add(file.size_bytes)
            .ok_or(FitnessStoreError::InvalidManifest)?;
    }
    if total > MAX_SESSION_BYTES {
        return Err(FitnessStoreError::InvalidManifest);
    }
    Ok(())
}

fn canonical_session_id(value: &str) -> Result<(), FitnessStoreError> {
    let parsed = Uuid::parse_str(value).map_err(|_| FitnessStoreError::InvalidSessionId)?;
    if parsed.to_string() != value {
        return Err(FitnessStoreError::InvalidSessionId);
    }
    Ok(())
}

fn validate_filename(filename: &str) -> Result<(), FitnessStoreError> {
    max_bytes(filename).map(|_| ())
}

fn is_importer_owned_directory_name(value: &str) -> bool {
    if canonical_session_id(value).is_ok() {
        return true;
    }
    let Some(rest) = value.strip_prefix(".incoming-") else {
        return false;
    };
    if rest.len() != 73 || rest.as_bytes().get(36) != Some(&b'-') {
        return false;
    }
    canonical_session_id(&rest[..36]).is_ok() && canonical_session_id(&rest[37..]).is_ok()
}

fn max_bytes(filename: &str) -> Result<u64, FitnessStoreError> {
    match filename {
        SUMMARY_FILENAME => Ok(MAX_SUMMARY_BYTES),
        LOCATION_FILENAME => Ok(MAX_LOCATION_BYTES),
        SENSOR_FILENAME => Ok(MAX_SENSOR_BYTES),
        _ => Err(FitnessStoreError::InvalidFilename),
    }
}

fn content_type(filename: &str) -> &'static str {
    match filename {
        LOCATION_FILENAME => "application/gpx+xml",
        SUMMARY_FILENAME | SENSOR_FILENAME => "text/csv; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn safe_regular_file(
    directory: &Path,
    filename: &str,
    expected_size: u64,
) -> Result<PathBuf, FitnessStoreError> {
    if filename != MANIFEST_FILENAME {
        validate_filename(filename)?;
    }
    let path = directory.join(filename);
    if path.parent() != Some(directory) {
        return Err(FitnessStoreError::InvalidStoredPath);
    }
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(FitnessStoreError::InvalidStoredPath);
    }
    let canonical = fs::canonicalize(&path)?;
    if canonical.parent() != Some(fs::canonicalize(directory)?.as_path()) {
        return Err(FitnessStoreError::InvalidStoredPath);
    }
    if expected_size != 0 && metadata.len() != expected_size {
        return Err(FitnessStoreError::InvalidManifest);
    }
    if filename == MANIFEST_FILENAME && metadata.len() > MAX_MANIFEST_BYTES {
        return Err(FitnessStoreError::InvalidManifest);
    }
    Ok(canonical)
}

fn open_verified_file(
    directory: &Path,
    filename: &str,
    expected_size: u64,
) -> Result<File, FitnessStoreError> {
    let canonical = safe_regular_file(directory, filename, expected_size)?;
    let mut options = OpenOptions::new();
    options.read(true);
    // Android/Linux and Darwin use different O_NOFOLLOW values. This rejects a
    // final-component symlink even if the checked path changes before open().
    #[cfg(any(target_os = "android", target_os = "linux"))]
    options.custom_flags(0x0002_0000);
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    options.custom_flags(0x0000_0100);
    let file = options.open(canonical)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err(FitnessStoreError::InvalidStoredPath);
    }
    Ok(file)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, FitnessStoreError> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    file.by_ref().take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(FitnessStoreError::InvalidManifest);
    }
    Ok(bytes)
}

fn parse_summary(path: &Path) -> Result<FitnessSummary, FitnessStoreError> {
    const HEADER: &str = "Splits,Pace (min/km),Elapsed Time,Cumulative Distance (km),Moving Time,Motion Breakdown,Step Count";
    let bytes = read_bounded(path, MAX_SUMMARY_BYTES)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| FitnessStoreError::InvalidManifest)?;
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some(HEADER) {
        return Err(FitnessStoreError::InvalidManifest);
    }
    let line = lines
        .rfind(|line| !line.trim().is_empty())
        .ok_or(FitnessStoreError::InvalidManifest)?;
    let (prefix, step_count) = line
        .rsplit_once(',')
        .ok_or(FitnessStoreError::InvalidManifest)?;
    let mut columns = prefix.splitn(6, ',');
    let splits = bounded_field(columns.next())?;
    let pace = bounded_field(columns.next())?;
    let elapsed_time = bounded_field(columns.next())?;
    let distance = bounded_field(columns.next())?
        .parse::<f64>()
        .map_err(|_| FitnessStoreError::InvalidManifest)?;
    let moving_time = bounded_field(columns.next())?;
    let motion_breakdown = bounded_field(columns.next())?;
    if !distance.is_finite() || !(0.0..=1_000_000.0).contains(&distance) {
        return Err(FitnessStoreError::InvalidManifest);
    }
    let step_count = step_count
        .trim()
        .parse::<u64>()
        .map_err(|_| FitnessStoreError::InvalidManifest)?;
    if step_count > 1_000_000_000 {
        return Err(FitnessStoreError::InvalidManifest);
    }
    Ok(FitnessSummary {
        splits,
        pace,
        elapsed_time,
        cumulative_distance_km: distance,
        moving_time,
        motion_breakdown,
        step_count,
    })
}

fn bounded_field(value: Option<&str>) -> Result<String, FitnessStoreError> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(FitnessStoreError::InvalidManifest)?;
    if value.chars().count() > MAX_TEXT_FIELD_CHARS
        || value.chars().any(|character| character.is_control())
    {
        return Err(FitnessStoreError::InvalidManifest);
    }
    Ok(value.to_string())
}

fn remove_tree_no_follow(path: &Path) -> Result<(), FitnessStoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path)?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(FitnessStoreError::InvalidStoredPath);
    }
    for entry in fs::read_dir(path)? {
        remove_tree_no_follow(&entry?.path())?;
    }
    fs::remove_dir(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_session(root: &Path, id: &str, with_sensor: bool) {
        let directory = root.join(id);
        fs::create_dir(&directory).unwrap();
        let summary = concat!(
            "Splits,Pace (min/km),Elapsed Time,Cumulative Distance (km),Moving Time,Motion Breakdown,Step Count\n",
            "1,PT6M,PT10M,1.25,PT8M,walk,1500\n"
        );
        fs::write(directory.join(SUMMARY_FILENAME), summary).unwrap();
        fs::write(directory.join(LOCATION_FILENAME), "<gpx></gpx>").unwrap();
        if with_sensor {
            fs::write(directory.join(SENSOR_FILENAME), "ax,ay\n1,2\n").unwrap();
        }
        let mut files = vec![
            FitnessFileMetadata {
                filename: SUMMARY_FILENAME.into(),
                size_bytes: summary.len() as u64,
            },
            FitnessFileMetadata {
                filename: LOCATION_FILENAME.into(),
                size_bytes: 11,
            },
        ];
        if with_sensor {
            files.push(FitnessFileMetadata {
                filename: SENSOR_FILENAME.into(),
                size_bytes: 10,
            });
        }
        fs::write(
            directory.join(MANIFEST_FILENAME),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "session_id": id,
                "started_at_ms": 1_000,
                "stopped_at_ms": 2_000,
                "files": files,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn lists_detail_summary_and_allowlisted_downloads() {
        let temp = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        create_session(temp.path(), &id, true);
        let store = FitnessStore::open(temp.path()).unwrap();
        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].summary.as_ref().unwrap().step_count, 1500);
        assert_eq!(
            sessions[0].summary.as_ref().unwrap().cumulative_distance_km,
            1.25
        );
        let mut download = store.file(&id, SENSOR_FILENAME).unwrap().unwrap();
        assert_eq!(download.content_type, "text/csv; charset=utf-8");
        // The API receives an already-open handle. Replacing the directory entry
        // cannot redirect the bytes subsequently streamed from that handle.
        fs::remove_file(temp.path().join(&id).join(SENSOR_FILENAME)).unwrap();
        fs::write(temp.path().join(&id).join(SENSOR_FILENAME), "replacement").unwrap();
        let mut downloaded = Vec::new();
        download.file.read_to_end(&mut downloaded).unwrap();
        assert_eq!(downloaded, b"ax,ay\n1,2\n");
        assert!(matches!(
            store.file(&id, "../manifest.json"),
            Err(FitnessStoreError::InvalidFilename)
        ));
    }

    #[test]
    fn rejects_path_traversal_tampering_and_size_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        create_session(temp.path(), &id, false);
        let store = FitnessStore::open(temp.path()).unwrap();
        assert!(matches!(
            store.get_session("../bad"),
            Err(FitnessStoreError::InvalidSessionId)
        ));

        fs::write(temp.path().join(&id).join(SUMMARY_FILENAME), "changed").unwrap();
        assert!(matches!(
            store.get_session(&id),
            Err(FitnessStoreError::InvalidManifest)
        ));
    }

    #[test]
    fn list_is_sorted_and_delete_clear_are_bounded_to_valid_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        create_session(temp.path(), &first, false);
        create_session(temp.path(), &second, false);
        let second_manifest = temp.path().join(&second).join(MANIFEST_FILENAME);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&second_manifest).unwrap()).unwrap();
        value["started_at_ms"] = 2_000.into();
        value["stopped_at_ms"] = 3_000.into();
        fs::write(second_manifest, serde_json::to_vec(&value).unwrap()).unwrap();

        let store = FitnessStore::open(temp.path()).unwrap();
        assert_eq!(store.list_sessions().unwrap()[0].session_id, second);
        assert!(store.delete_session(&first).unwrap());
        assert!(!store.delete_session(&first).unwrap());
        assert_eq!(store.clear().unwrap(), 1);
        assert!(store.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn list_never_returns_more_than_the_retention_limit() {
        let temp = tempfile::tempdir().unwrap();
        for _ in 0..(MAX_STORED_SESSIONS + 3) {
            create_session(temp.path(), &Uuid::new_v4().to_string(), false);
        }
        let store = FitnessStore::open(temp.path()).unwrap();
        assert_eq!(store.list_sessions().unwrap().len(), MAX_STORED_SESSIONS);
    }

    #[cfg(unix)]
    #[test]
    fn clear_sweeps_only_direct_non_symlink_importer_directories() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let valid = Uuid::new_v4().to_string();
        let corrupt = Uuid::new_v4().to_string();
        let linked = Uuid::new_v4().to_string();
        let incoming = format!(".incoming-{}-{}", Uuid::new_v4(), Uuid::new_v4());
        create_session(temp.path(), &valid, false);
        fs::create_dir(temp.path().join(&corrupt)).unwrap();
        fs::create_dir(temp.path().join(&incoming)).unwrap();
        fs::create_dir(temp.path().join("unrelated")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"), "safe").unwrap();
        symlink(outside.path(), temp.path().join(&linked)).unwrap();

        let store = FitnessStore::open(temp.path()).unwrap();
        assert_eq!(store.clear().unwrap(), 3);
        assert!(!temp.path().join(valid).exists());
        assert!(!temp.path().join(corrupt).exists());
        assert!(!temp.path().join(incoming).exists());
        assert!(temp.path().join("unrelated").is_dir());
        assert!(fs::symlink_metadata(temp.path().join(linked))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(outside.path().join("keep")).unwrap(),
            "safe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_session_is_never_listed_or_deleted_through() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        symlink(outside.path(), temp.path().join(&id)).unwrap();
        let store = FitnessStore::open(temp.path()).unwrap();
        assert!(store.list_sessions().unwrap().is_empty());
        assert!(matches!(
            store.get_session(&id),
            Err(FitnessStoreError::InvalidStoredPath)
        ));
        assert!(outside.path().exists());
    }
}
