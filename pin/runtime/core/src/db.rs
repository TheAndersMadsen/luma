//! SQLite backed persistence for memory metadata and conversations.
//!
//! All methods use [`tokio::task::spawn_blocking`] internally so callers can
//! treat them as async without blocking the tokio runtime.

mod contacts;

pub use contacts::{
    ContactEmail, ContactImportError, ContactName, ContactPhoneNumber, ContactRecord,
};

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::proto::events::NotableEvent;
use crate::storage::{Location, MemoryRecord, MemoryStatus};

// ─── Schema ─────────────────────────────────────────────────────────

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS memories (
    uuid                    TEXT PRIMARY KEY,
    memory_type             TEXT NOT NULL,
    device_local_id         TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pending',
    thumbnail_count         INTEGER NOT NULL DEFAULT 0,
    latitude                REAL,
    longitude               REAL,
    location_accuracy       REAL,
    location_human_readable TEXT,
    location_full_address   TEXT
);

CREATE TABLE IF NOT EXISTS memory_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_uuid TEXT NOT NULL REFERENCES memories(uuid) ON DELETE CASCADE,
    filename    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_files_uuid ON memory_files(memory_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedupe ON memories(device_local_id, memory_type, created_at)
    WHERE device_local_id <> '';

CREATE TABLE IF NOT EXISTS notable_events (
    event_identifier           TEXT PRIMARY KEY,
    event_type                 TEXT NOT NULL,
    event_originator_identifier TEXT NOT NULL,
    creation_time              INTEGER NOT NULL,
    event_data                 BLOB,
    event_payload              BLOB NOT NULL,
    event_properties_filter    BLOB,
    encrypted_event_data       BLOB,
    encrypted_location         BLOB,
    device_is_locked           INTEGER NOT NULL DEFAULT 0,
    received_at                INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_notable_events_filtering
    ON notable_events(event_type, event_originator_identifier, creation_time DESC);

CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%s','now')),
    utterance  TEXT NOT NULL,
    is_vision  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    seq             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS session_state (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),
    reset_at_conversation_id INTEGER NOT NULL DEFAULT 0
);

-- Per-run session-context eligibility. A run captured while the device was
-- locked/unknown must never resurface as model conversation context on a later
-- unlocked turn (the device-supplied window already excludes locked history;
-- this extends the same rule to the durable store). Keyed by run_id; a
-- conversation row with no matching eligible=1 record is excluded from session
-- context reads, so pre-existing rows are safely ineligible after upgrade.
CREATE TABLE IF NOT EXISTS run_session_eligibility (
    run_id   TEXT PRIMARY KEY,
    eligible INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS spotify_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id    TEXT NOT NULL,
    title       TEXT NOT NULL,
    artists_json TEXT NOT NULL DEFAULT '[]',
    album       TEXT,
    status      TEXT NOT NULL DEFAULT 'requested',
    started_at  TEXT NOT NULL DEFAULT (strftime('%s','now')),
    ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_spotify_history_started ON spotify_history(started_at DESC, id DESC);
"#;

/// Thread-safe handle to the SQLite database.
#[derive(Clone)]
pub struct Database {
    pub(super) conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptActivityRecord {
    pub id: i64,
    pub run_id: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
    pub is_vision: bool,
    pub created_at: String,
}

/// One stored conversation without its messages, for the Center list view.
#[derive(Debug, Clone, Serialize)]
pub struct ConversationSummary {
    pub id: i64,
    pub run_id: String,
    pub created_at: String,
    pub utterance: String,
    pub is_vision: bool,
}

/// A single message within a stored conversation.
#[derive(Debug, Clone, Serialize)]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
    pub seq: i64,
}

/// A stored conversation together with its ordered messages.
#[derive(Debug, Clone, Serialize)]
pub struct ConversationDetail {
    pub id: i64,
    pub run_id: String,
    pub created_at: String,
    pub utterance: String,
    pub is_vision: bool,
    pub messages: Vec<ConversationMessage>,
}

#[derive(Debug, Clone)]
pub struct NoteActivityIndexRecord {
    pub uuid: String,
    pub created_at: String,
    pub location: Option<Location>,
}

/// One completed assistant turn eligible as session conversation context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTurn {
    pub utterance: String,
    pub response: String,
}

/// How long a finished turn stays eligible as follow-up context.
///
/// Long enough that a real exchange, ask, listen, ask again, think, refine,
/// is never cut off mid-conversation, and short enough that tomorrow's first
/// question is not silently resolved against yesterday's. Before this, only an
/// explicit reset ended a session.
///
/// Privacy rationale (R-001): the 30-minute ceiling also bounds the window of
/// conversational data available to the model on any given prompt, so a later
/// prompt cannot silently dredge up an earlier unrelated exchange the user has
/// moved on from.
const SESSION_CONTEXT_MAX_AGE_SECS: i64 = 30 * 60;

/// Message role for a server-generated failure notice spoken in place of an
/// answer, a backend outage, a request-budget timeout, a step budget the run
/// could not finish inside.
///
/// Deliberately not `assistant`. [`Database::recent_session_turns`] reads
/// `assistant` rows only, so a failure notice stored under this role can never
/// come back as model conversation context on a later turn, while
/// [`Database::list_prompt_activity`] and [`Database::get_conversation`] still
/// show the wearer (and the Center) exactly what the Pin said.
///
/// The bug this exists for: backend failures are bursty, so the turn right
/// after a failure is the turn most likely to fail again, and it was the one
/// turn guaranteed to be primed with "I couldn't reach the service" as if the
/// assistant had said it, which it then echoed, hedged, or apologized around.
pub const DECLINE_MESSAGE_ROLE: &str = "assistant_decline";

const CONVERSATION_RETENTION_SECS: i64 = 7 * 24 * 60 * 60;
const CONVERSATION_ROW_LIMIT: i64 = 1_000;
const DATABASE_KEY_HEX_LEN: usize = 64;
const SQLITE_PLAINTEXT_HEADER: &[u8; 16] = b"SQLite format 3\0";

fn validate_database_key(key: &str) -> Result<(), Box<dyn std::error::Error>> {
    if key.len() != DATABASE_KEY_HEX_LEN
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("database key must be 32 bytes encoded as lowercase hexadecimal".into());
    }
    Ok(())
}

fn apply_database_key(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.pragma_update(None, "key", key)
}

fn verify_sqlcipher(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let cipher_version: String = conn.query_row("PRAGMA cipher_version", [], |row| row.get(0))?;
    if cipher_version.trim().is_empty() {
        return Err("SQLCipher support is unavailable".into());
    }
    let quick_check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(format!("encrypted database quick_check failed: {quick_check}").into());
    }
    Ok(())
}

fn has_plaintext_sqlite_header(path: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    if !path.exists() {
        return Ok(false);
    }
    if path.symlink_metadata()?.file_type().is_symlink() {
        return Err("refusing symbolic-link database".into());
    }
    let mut header = [0_u8; SQLITE_PLAINTEXT_HEADER.len()];
    let mut file = File::open(path)?;
    Ok(file.read_exact(&mut header).is_ok() && &header == SQLITE_PLAINTEXT_HEADER)
}

fn encrypted_migration_path(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let parent = path
        .parent()
        .ok_or("database path has no parent directory")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("database path has no UTF-8 file name")?;
    Ok(parent.join(format!(".{name}.sqlcipher-migrating")))
}

fn remove_regular_file_if_present(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(format!(
            "refusing non-regular migration artifact: {}",
            path.display()
        )
        .into()),
        Ok(_) => {
            std::fs::remove_file(path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn encrypt_plaintext_database(path: &Path, key: &str) -> Result<(), Box<dyn std::error::Error>> {
    let migration_path = encrypted_migration_path(path)?;
    let migration_wal = PathBuf::from(format!("{}-wal", migration_path.display()));
    let migration_shm = PathBuf::from(format!("{}-shm", migration_path.display()));
    remove_regular_file_if_present(&migration_path)?;
    remove_regular_file_if_present(&migration_wal)?;
    remove_regular_file_if_present(&migration_shm)?;

    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let plaintext = Connection::open(path)?;
        plaintext.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        plaintext.execute(
            "ATTACH DATABASE ?1 AS encrypted KEY ?2",
            params![migration_path.to_string_lossy(), key],
        )?;
        let export_result: Option<String> =
            plaintext.query_row("SELECT sqlcipher_export('encrypted')", [], |row| row.get(0))?;
        if export_result.is_some() {
            return Err("unexpected SQLCipher export result".into());
        }
        plaintext.execute_batch("DETACH DATABASE encrypted;")?;
        drop(plaintext);

        let encrypted = Connection::open(&migration_path)?;
        apply_database_key(&encrypted, key)?;
        verify_sqlcipher(&encrypted)?;
        encrypted.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        drop(encrypted);

        remove_regular_file_if_present(&migration_wal)?;
        remove_regular_file_if_present(&migration_shm)?;
        remove_regular_file_if_present(&PathBuf::from(format!("{}-wal", path.display())))?;
        remove_regular_file_if_present(&PathBuf::from(format!("{}-shm", path.display())))?;
        File::open(&migration_path)?.sync_all()?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        std::fs::rename(&migration_path, path)?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = remove_regular_file_if_present(&migration_path);
        let _ = remove_regular_file_if_present(&migration_wal);
        let _ = remove_regular_file_if_present(&migration_shm);
    }
    result
}

fn prune_conversation_history(conn: &Connection) -> rusqlite::Result<usize> {
    let expired = conn.execute(
        "DELETE FROM conversations
         WHERE created_at != printf('%lld', CAST(created_at AS INTEGER))
            OR CAST(created_at AS INTEGER) <
               (CAST(strftime('%s','now') AS INTEGER) - ?1)",
        params![CONVERSATION_RETENTION_SECS],
    )?;
    let over_limit = conn.execute(
        "DELETE FROM conversations WHERE id NOT IN
         (SELECT id FROM conversations ORDER BY id DESC LIMIT ?1)",
        params![CONVERSATION_ROW_LIMIT],
    )?;
    Ok(expired + over_limit)
}

fn truncate_wal_after_delete(conn: &Connection, deleted: usize) -> rusqlite::Result<()> {
    if deleted > 0 {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    }
    Ok(())
}

/// Bound session-context text on a character boundary without splitting a
/// UTF-8 code point.
fn bound_session_text(value: &mut String, max_chars: usize) {
    if value.chars().count() > max_chars {
        *value = value.chars().take(max_chars).collect();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MusicActivityRecord {
    pub id: i64,
    pub track_id: String,
    pub title: String,
    pub artists: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    pub status: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
}

#[allow(dead_code)]
impl Database {
    /// Open (or create) the database at the given path and apply the schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Box<dyn std::error::Error>> {
        let path = path.as_ref();

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(path)?;
        Self::finish_open(path, conn)
    }

    /// Open a SQLCipher database, atomically converting a legacy plaintext
    /// SQLite file on first use. The original remains authoritative until a
    /// fully encrypted copy passes `quick_check` and is renamed over it.
    pub fn open_encrypted(
        path: impl AsRef<Path>,
        key: &str,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        validate_database_key(key)?;
        let path = path.as_ref();

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            if parent.symlink_metadata()?.file_type().is_symlink() {
                return Err("refusing symbolic-link database directory".into());
            }
        }
        if has_plaintext_sqlite_header(path)? {
            encrypt_plaintext_database(path, key)?;
            info!(path = %path.display(), "migrated plaintext database to SQLCipher");
        }

        let conn = Connection::open(path)?;
        apply_database_key(&conn, key)?;
        verify_sqlcipher(&conn)?;
        Self::finish_open(path, conn)
    }

    fn finish_open(path: &Path, conn: Connection) -> Result<Self, Box<dyn std::error::Error>> {
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch(contacts::CONTACTS_SCHEMA)?;

        let deleted = prune_conversation_history(&conn)?;
        conn.execute(
            "DELETE FROM run_session_eligibility
             WHERE NOT EXISTS (
                 SELECT 1 FROM conversations
                 WHERE conversations.run_id = run_session_eligibility.run_id
             )",
            [],
        )?;
        truncate_wal_after_delete(&conn, deleted)?;

        info!(path = %path.display(), deleted, "database opened");

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Insert a new memory record.
    pub async fn create_memory(
        &self,
        record: &MemoryRecord,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let record = record.clone();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;

            let (lat, lon, acc, human, full) = match &record.location {
                Some(loc) => (
                    Some(loc.latitude),
                    Some(loc.longitude),
                    loc.accuracy.map(|a| a as f64),
                    loc.human_readable.clone(),
                    loc.full_address.clone(),
                ),
                None => (None, None, None, None, None),
            };

            conn.execute(
                "INSERT INTO memories (uuid, memory_type, device_local_id, created_at, status,
                    thumbnail_count, latitude, longitude, location_accuracy,
                    location_human_readable, location_full_address)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    record.uuid,
                    record.memory_type,
                    record.device_local_id,
                    record.created_at,
                    status_to_str(&record.status),
                    record.thumbnail_count as i64,
                    lat,
                    lon,
                    acc,
                    human,
                    full,
                ],
            )?;

            // Insert associated files
            for filename in &record.files {
                conn.execute(
                    "INSERT INTO memory_files (memory_uuid, filename) VALUES (?1, ?2)",
                    params![record.uuid, filename],
                )?;
            }

            Ok(())
        })
        .await?
    }

    /// Find an existing memory for the same device retry tuple.
    pub async fn find_memory_by_device_local_id_and_type_and_created_at(
        &self,
        device_local_id: &str,
        memory_type: &str,
        created_at: &str,
    ) -> Result<Option<MemoryRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let device_local_id = device_local_id.to_string();
        let memory_type = memory_type.to_string();
        let created_at = created_at.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT uuid, memory_type, device_local_id, created_at, status,
                        thumbnail_count, latitude, longitude, location_accuracy,
                        location_human_readable, location_full_address
                 FROM memories
                 WHERE device_local_id = ?1
                   AND memory_type = ?2
                   AND created_at = ?3
                 LIMIT 1",
            )?;
            let result = stmt
                .query_row(params![device_local_id, memory_type, created_at], |row| {
                    Ok(memory_from_row(row))
                })
                .ok();
            match result {
                Some(mut record) => {
                    let files = get_files_for_memory(&conn, &record.uuid)?;
                    record.files = files;
                    Ok(Some(record))
                }
                None => Ok(None),
            }
        })
        .await?
    }

    /// Update the status of a memory.
    pub async fn set_memory_status(
        &self,
        uuid: &str,
        status: &MemoryStatus,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let uuid = uuid.to_string();
        let status_str = status_to_str(status).to_string();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let changed = conn.execute(
                "UPDATE memories SET status = ?1 WHERE uuid = ?2",
                params![status_str, uuid],
            )?;
            Ok(changed > 0)
        })
        .await?
    }

    /// Update the thumbnail count for a memory.
    pub async fn set_thumbnail_count(
        &self,
        uuid: &str,
        count: usize,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let uuid = uuid.to_string();
        let count = count as i64;

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            conn.execute(
                "UPDATE memories SET thumbnail_count = ?1 WHERE uuid = ?2",
                params![count, uuid],
            )?;
            Ok(())
        })
        .await?
    }

    /// Delete a memory record and its files from the database.
    pub async fn delete_memory(
        &self,
        uuid: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let uuid = uuid.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let changed = conn.execute("DELETE FROM memories WHERE uuid = ?1", params![uuid])?;
            Ok(changed > 0)
        })
        .await?
    }

    /// Look up a single memory by UUID.
    pub async fn get_memory(
        &self,
        uuid: &str,
    ) -> Result<Option<MemoryRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let uuid = uuid.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            get_memory_inner(&conn, &uuid)
        })
        .await?
    }

    /// Find the memory that owns a given filename.
    pub async fn find_memory_for_file(
        &self,
        filename: &str,
    ) -> Result<Option<MemoryRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let filename = filename.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let uuid: Option<String> = conn
                .query_row(
                    "SELECT memory_uuid FROM memory_files WHERE filename = ?1 LIMIT 1",
                    params![filename],
                    |row| row.get(0),
                )
                .ok();

            match uuid {
                Some(uuid) => get_memory_inner(&conn, &uuid),
                None => Ok(None),
            }
        })
        .await?
    }

    /// List all memories, ordered by creation time descending.
    pub async fn list_memories(
        &self,
    ) -> Result<Vec<MemoryRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT uuid, memory_type, device_local_id, created_at, status,
                        thumbnail_count, latitude, longitude, location_accuracy,
                        location_human_readable, location_full_address
                 FROM memories ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map([], |row| Ok(memory_from_row(row)))?;

            let mut memories = Vec::new();
            for row in rows {
                let mut record = row?;
                record.files = get_files_for_memory(&conn, &record.uuid)?;
                memories.push(record);
            }
            Ok(memories)
        })
        .await?
    }

    /// List only canonical, epoch-second memory identifiers of one type at or
    /// after `start_seconds`. This intentionally does not load unrelated
    /// memory rows or their file lists.
    pub async fn list_memory_ids_by_type_since(
        &self,
        memory_type: &str,
        start_seconds: i64,
        limit: usize,
    ) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.clone();
        let memory_type = memory_type.to_string();
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT uuid
                 FROM memories
                 WHERE memory_type = ?1
                   AND created_at = printf('%lld', CAST(created_at AS INTEGER))
                   AND CAST(created_at AS INTEGER) >= ?2
                 ORDER BY CAST(created_at AS INTEGER) ASC, uuid ASC
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![memory_type, start_seconds, limit], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await?
    }

    /// List identifiers for one memory type without loading file metadata for
    /// unrelated gallery rows. Used by explicit activity cleanup operations.
    pub async fn list_memory_ids_by_type(
        &self,
        memory_type: &str,
    ) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let memory_type = memory_type.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT uuid FROM memories WHERE memory_type = ?1
                 ORDER BY CAST(created_at AS INTEGER) ASC, uuid ASC",
            )?;
            let rows = stmt.query_map(params![memory_type], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await?
    }

    /// Insert or replace a notable event by identifier.
    pub async fn upsert_notable_event(
        &self,
        event: &NotableEvent,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let event = event.clone();
        let payload = prost::Message::encode_to_vec(&event);
        let event_type = event.event_type.clone();
        let event_originator = event.originator_identifier.clone();
        let event_data = event
            .event_data
            .clone()
            .map(|value| prost::Message::encode_to_vec(&value));
        let event_properties_filter = event_data.clone();
        let encrypted_event_data = event
            .encrypted_event_data
            .map(|value| prost::Message::encode_to_vec(&value));
        let encrypted_location = event
            .encrypted_location
            .map(|value| prost::Message::encode_to_vec(&value));
        let identifier = event
            .event_identifier
            .as_ref()
            .map(|identifier| identifier.value.clone())
            .unwrap_or_default();
        let creation_time = event
            .creation_time
            .as_ref()
            .map(|value| value.seconds)
            .unwrap_or_default();
        let device_is_locked = event.device_is_locked as i32;

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            conn.execute(
                "INSERT INTO notable_events (
                        event_identifier, event_type, event_originator_identifier,
                        creation_time, event_data, event_payload, event_properties_filter,
                        encrypted_event_data, encrypted_location, device_is_locked
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                    ON CONFLICT(event_identifier) DO UPDATE SET
                        event_type = excluded.event_type,
                        event_originator_identifier = excluded.event_originator_identifier,
                        creation_time = excluded.creation_time,
                        event_data = excluded.event_data,
                        event_payload = excluded.event_payload,
                        event_properties_filter = excluded.event_properties_filter,
                        encrypted_event_data = excluded.encrypted_event_data,
                        encrypted_location = excluded.encrypted_location,
                        device_is_locked = excluded.device_is_locked,
                        received_at = excluded.received_at",
                params![
                    identifier,
                    event_type,
                    event_originator,
                    creation_time,
                    event_data,
                    payload,
                    event_properties_filter,
                    encrypted_event_data,
                    encrypted_location,
                    device_is_locked,
                ],
            )?;
            Ok(())
        })
        .await?
    }

    /// Fetch notable-event payloads matching basic filters.
    pub async fn list_notable_event_payloads(
        &self,
        event_type: Option<&str>,
        event_originator: Option<&str>,
        event_start_time: Option<i64>,
        event_end_time: Option<i64>,
        max_results: usize,
    ) -> Result<Vec<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
        if max_results == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.clone();
        let max_results = i64::try_from(max_results).unwrap_or(i64::MAX);
        let event_type = event_type.map(|value| value.to_string());
        let event_originator = event_originator.map(|value| value.to_string());

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT event_payload
                 FROM notable_events
                 WHERE (?1 = '' OR event_type = ?1)
                   AND (?2 = '' OR event_originator_identifier = ?2)
                   AND (?3 IS NULL OR creation_time >= ?3)
                   AND (?4 IS NULL OR creation_time <= ?4)
                 ORDER BY creation_time DESC, event_identifier DESC
                 LIMIT ?5",
            )?;
            let rows = stmt.query_map(
                params![
                    event_type.unwrap_or_default(),
                    event_originator.unwrap_or_default(),
                    event_start_time,
                    event_end_time,
                    max_results,
                ],
                |row| row.get::<_, Vec<u8>>(0),
            )?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await?
    }

    /// Persist a completed conversation.
    pub async fn save_conversation(
        &self,
        run_id: &str,
        utterance: &str,
        is_vision: bool,
        messages: &[(String, String)], // (role, content)
    ) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let run_id = run_id.to_string();
        let utterance = utterance.to_string();
        let messages: Vec<(String, String)> = messages.to_vec();

        tokio::task::spawn_blocking(move || {
            let mut conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let transaction = conn.transaction()?;

            transaction.execute(
                "INSERT INTO conversations (run_id, utterance, is_vision) VALUES (?1, ?2, ?3)",
                params![run_id, utterance, is_vision as i32],
            )?;
            let conversation_id = transaction.last_insert_rowid();

            for (seq, (role, content)) in messages.iter().enumerate() {
                transaction.execute(
                    "INSERT INTO conversation_messages (conversation_id, role, content, seq)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![conversation_id, role, content, seq as i64],
                )?;
            }

            // The dashboard is a recent-activity surface, not an unbounded
            // transcript archive. Cascading deletes remove child messages.
            // Privacy rationale (R-001): the 1000-row cap bounds how much
            // conversation data persists on disk, limiting exposure if the
            // device database is accessed without authorization. Older
            // conversations are silently evicted, not archived.
            let deleted = prune_conversation_history(&transaction)?;
            transaction.commit()?;
            truncate_wal_after_delete(&conn, deleted)?;

            Ok(conversation_id)
        })
        .await?
    }

    /// Persist a server-generated failure notice under [`DECLINE_MESSAGE_ROLE`]:
    /// it stays in the activity log and the Center thread, and stays out of
    /// model conversation context.
    pub async fn save_decline_conversation(
        &self,
        run_id: &str,
        utterance: &str,
        is_vision: bool,
        decline_text: &str,
    ) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
        self.save_conversation(
            run_id,
            utterance,
            is_vision,
            &[(DECLINE_MESSAGE_ROLE.into(), decline_text.to_string())],
        )
        .await
    }

    /// Start a new assistant session: turns saved before this call stop being
    /// eligible as model conversation context. The rows themselves remain in
    /// the activity log untouched.
    pub async fn mark_session_reset(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            conn.execute(
                "INSERT INTO session_state (id, reset_at_conversation_id)
                 VALUES (1, (SELECT COALESCE(MAX(id), 0) FROM conversations))
                 ON CONFLICT(id) DO UPDATE
                 SET reset_at_conversation_id =
                     (SELECT COALESCE(MAX(id), 0) FROM conversations)",
                [],
            )?;
            Ok(())
        })
        .await?
    }

    /// Record whether turns saved under `run_id` are eligible to become model
    /// conversation context (i.e. the device was unlocked for that run). Called
    /// once per turn from the request entry, before any of the run's turns are
    /// saved. Idempotent per run_id.
    pub async fn set_run_session_eligibility(
        &self,
        run_id: &str,
        eligible: bool,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let run_id = run_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            conn.execute(
                "INSERT INTO run_session_eligibility (run_id, eligible) VALUES (?1, ?2)
                 ON CONFLICT(run_id) DO UPDATE SET eligible = ?2",
                params![run_id, eligible as i32],
            )?;
            Ok(())
        })
        .await?
    }

    /// Persist the reset turn AND set the session marker to that row's id in a
    /// single transaction, so the marker provably includes the reset turn.
    ///
    /// Anchoring the marker to `MAX(id)` in one spawned task while the reset
    /// turn was saved in another left an always-armed race: whichever spawn
    /// committed second decided whether the reset turn (and any turn that
    /// slipped in beside it) landed above the marker and re-entered the fresh
    /// session's context. Inserting the row and reading its own id inside the
    /// transaction removes that race for the reset turn deterministically.
    pub async fn reset_session_at_new_turn(
        &self,
        run_id: &str,
        utterance: &str,
        outcome: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let run_id = run_id.to_string();
        let utterance = utterance.to_string();
        let outcome = outcome.chars().take(4_096).collect::<String>();
        tokio::task::spawn_blocking(move || {
            let mut conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let transaction = conn.transaction()?;
            transaction.execute(
                "INSERT INTO conversations (run_id, utterance, is_vision) VALUES (?1, ?2, 0)",
                params![run_id, utterance],
            )?;
            let conversation_id = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO conversation_messages (conversation_id, role, content, seq)
                 VALUES (?1, 'assistant', ?2, 0)",
                params![conversation_id, outcome],
            )?;
            transaction.execute(
                "INSERT INTO session_state (id, reset_at_conversation_id) VALUES (1, ?1)
                 ON CONFLICT(id) DO UPDATE SET reset_at_conversation_id = ?1",
                params![conversation_id],
            )?;
            // Privacy rationale (R-001): the 1000-row cap bounds how much
            // conversation data persists on disk, limiting exposure if the
            // device database is accessed without authorization.
            let deleted = prune_conversation_history(&transaction)?;
            transaction.commit()?;
            truncate_wal_after_delete(&conn, deleted)?;
            Ok(())
        })
        .await?
    }

    /// The most recent completed turns of the CURRENT session (turns saved
    /// after the last [`Self::mark_session_reset`]), oldest first. Each turn is
    /// the user utterance plus the final assistant text of that run, both
    /// bounded to `max_item_chars`. This is model conversation context only,
    /// never authority for actions.
    pub async fn recent_session_turns(
        &self,
        limit: usize,
        max_item_chars: usize,
    ) -> Result<Vec<SessionTurn>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            // Age bound. Without it the only thing ending a session is an
            // explicit reset, so a question asked days later still resolves
            // "he"/"that one" against a conversation the user has long
            // forgotten, which reads as the device confusing itself rather
            // than remembering. The stock experience dropped context on the
            // same principle. This keeps a follow-up window that is generous
            // for a real exchange and closed well before the next one.
            //
            // The two `role = 'assistant'` clauses are load-bearing, not
            // incidental: they are what keeps a [`DECLINE_MESSAGE_ROLE`] row,
            // a failure notice the server generated, not an answer the
            // assistant gave, out of the next turn's model context. A
            // conversation whose only message is a decline contributes no row
            // to this join at all. Widening either clause to accept every role
            // silently restores the poisoning.
            let mut statement = conn.prepare(
                "SELECT c.utterance, m.content
                 FROM conversations c
                 JOIN conversation_messages m ON m.conversation_id = c.id
                 WHERE c.id > (SELECT COALESCE(MAX(reset_at_conversation_id), 0)
                               FROM session_state)
                   AND CAST(c.created_at AS INTEGER)
                       >= (CAST(strftime('%s','now') AS INTEGER) - ?2)
                   AND (SELECT COALESCE(eligible, 0) FROM run_session_eligibility
                        WHERE run_id = c.run_id) = 1
                   AND m.role = 'assistant'
                   AND m.seq = (SELECT MAX(seq) FROM conversation_messages
                                WHERE conversation_id = c.id AND role = 'assistant')
                 ORDER BY c.id DESC
                 LIMIT ?1",
            )?;
            let mut turns = statement
                .query_map(params![limit as i64, SESSION_CONTEXT_MAX_AGE_SECS], |row| {
                    Ok(SessionTurn {
                        utterance: row.get::<_, String>(0)?,
                        response: row.get::<_, String>(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            turns.reverse();
            for turn in &mut turns {
                bound_session_text(&mut turn.utterance, max_item_chars);
                bound_session_text(&mut turn.response, max_item_chars);
            }
            turns.retain(|turn| !turn.utterance.is_empty() && !turn.response.is_empty());
            Ok(turns)
        })
        .await?
    }

    /// List bounded assistant activity without exposing system prompts or full
    /// model history. Only the user utterance and final assistant text are
    /// returned to the authenticated dashboard.
    ///
    /// Failure notices ([`DECLINE_MESSAGE_ROLE`]) are included here on purpose.
    /// They are excluded from model context, not from the record: a wearer who
    /// asks "why did it say that?" and the Center's activity view both still
    /// need to see the turn that went wrong.
    pub async fn list_prompt_activity(
        &self,
        limit: usize,
        before_id: Option<i64>,
    ) -> Result<Vec<PromptActivityRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let limit = i64::try_from(limit.clamp(1, 100)).unwrap_or(100);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let sql = "SELECT c.id, c.run_id, c.utterance, c.is_vision, c.created_at,
                              (SELECT m.content FROM conversation_messages m
                               WHERE m.conversation_id = c.id
                                 AND (m.role = 'assistant' OR m.role = ?3)
                               ORDER BY m.seq DESC, m.id DESC LIMIT 1)
                       FROM conversations c
                       WHERE (?1 IS NULL OR c.id < ?1)
                       ORDER BY c.id DESC LIMIT ?2";
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![before_id, limit, DECLINE_MESSAGE_ROLE], |row| {
                Ok(PromptActivityRecord {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    prompt: row.get(2)?,
                    is_vision: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
                    response: row.get(5)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await?
    }

    /// List stored conversations for the Center conversations view, most
    /// recent first. Only the summary row is returned. Call
    /// [`Self::get_conversation`] for the message thread.
    pub async fn list_conversations(
        &self,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<ConversationSummary>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let offset = offset.max(0);
        let limit = limit.clamp(1, 200);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT id, run_id, created_at, utterance, is_vision
                 FROM conversations
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?1 OFFSET ?2",
            )?;
            let rows = stmt.query_map(params![limit, offset], |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    created_at: row.get(2)?,
                    utterance: row.get(3)?,
                    is_vision: row.get::<_, i64>(4)? != 0,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await?
    }

    /// Fetch one stored conversation with its ordered messages, or `None` when
    /// the id does not exist.
    pub async fn get_conversation(
        &self,
        id: i64,
    ) -> Result<Option<ConversationDetail>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let summary = match conn.query_row(
                "SELECT id, run_id, created_at, utterance, is_vision
                 FROM conversations WHERE id = ?1",
                params![id],
                |row| {
                    Ok(ConversationSummary {
                        id: row.get(0)?,
                        run_id: row.get(1)?,
                        created_at: row.get(2)?,
                        utterance: row.get(3)?,
                        is_vision: row.get::<_, i64>(4)? != 0,
                    })
                },
            ) {
                Ok(summary) => summary,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(e) => return Err(e.into()),
            };

            let mut stmt = conn.prepare(
                "SELECT role, content, seq
                 FROM conversation_messages
                 WHERE conversation_id = ?1
                 ORDER BY seq, id",
            )?;
            let messages = stmt
                .query_map(params![id], |row| {
                    Ok(ConversationMessage {
                        role: row.get(0)?,
                        content: row.get(1)?,
                        seq: row.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;

            Ok(Some(ConversationDetail {
                id: summary.id,
                run_id: summary.run_id,
                created_at: summary.created_at,
                utterance: summary.utterance,
                is_vision: summary.is_vision,
                messages,
            }))
        })
        .await?
    }

    /// Seek-page complete local notes without materializing unrelated gallery
    /// rows or holding the MediaStore mutex during filesystem reads.
    pub async fn list_note_activity(
        &self,
        limit: usize,
        before: Option<(i64, String)>,
    ) -> Result<Vec<NoteActivityIndexRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let limit = i64::try_from(limit.clamp(1, 101)).unwrap_or(101);
        let (before_seconds, before_uuid) = before
            .map(|(seconds, uuid)| (Some(seconds), Some(uuid)))
            .unwrap_or((None, None));
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT m.uuid, m.created_at, m.latitude, m.longitude,
                        m.location_accuracy, m.location_human_readable,
                        m.location_full_address
                 FROM memories m
                 WHERE m.memory_type = 'note'
                   AND m.status = 'complete'
                   AND m.created_at = printf('%lld', CAST(m.created_at AS INTEGER))
                   AND EXISTS (
                       SELECT 1 FROM memory_files f
                       WHERE f.memory_uuid = m.uuid AND f.filename = 'note.json'
                   )
                   AND (
                       ?1 IS NULL
                       OR CAST(m.created_at AS INTEGER) < ?1
                       OR (CAST(m.created_at AS INTEGER) = ?1 AND m.uuid < ?2)
                   )
                 ORDER BY CAST(m.created_at AS INTEGER) DESC, m.uuid DESC
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![before_seconds, before_uuid, limit], |row| {
                let latitude: Option<f64> = row.get(2)?;
                let longitude: Option<f64> = row.get(3)?;
                let location = match (latitude, longitude) {
                    (Some(latitude), Some(longitude)) => Some(Location {
                        latitude,
                        longitude,
                        accuracy: row.get::<_, Option<f64>>(4)?.map(|value| value as f32),
                        human_readable: row.get(5)?,
                        full_address: row.get(6)?,
                    }),
                    _ => None,
                };
                Ok(NoteActivityIndexRecord {
                    uuid: row.get(0)?,
                    created_at: row.get(1)?,
                    location,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await?
    }

    pub async fn delete_prompt_activity(
        &self,
        id: i64,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let deleted = conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
            truncate_wal_after_delete(&conn, deleted)?;
            Ok(deleted > 0)
        })
        .await?
    }

    pub async fn clear_prompt_activity(
        &self,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let deleted = conn.execute("DELETE FROM conversations", [])?;
            truncate_wal_after_delete(&conn, deleted)?;
            Ok(deleted)
        })
        .await?
    }

    pub async fn start_music_activity(
        &self,
        track_id: &str,
        title: &str,
        artists: &[String],
        album: Option<&str>,
    ) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let track_id = track_id.to_string();
        let title = title.to_string();
        let artists_json = serde_json::to_string(artists)?;
        let album = album.map(str::to_string);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            conn.execute(
                "INSERT INTO spotify_history (track_id, title, artists_json, album, status)
                 VALUES (?1, ?2, ?3, ?4, 'requested')",
                params![track_id, title, artists_json, album],
            )?;
            let id = conn.last_insert_rowid();
            conn.execute(
                "DELETE FROM spotify_history WHERE id NOT IN
                 (SELECT id FROM spotify_history ORDER BY id DESC LIMIT 500)",
                [],
            )?;
            Ok(id)
        })
        .await?
    }

    pub async fn finish_music_activity(
        &self,
        id: i64,
        status: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let status = match status {
            "completed" | "interrupted" | "failed" => status.to_string(),
            _ => "failed".to_string(),
        };
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            Ok(conn.execute(
                "UPDATE spotify_history SET status = ?1, ended_at = strftime('%s','now')
                 WHERE id = ?2 AND ended_at IS NULL",
                params![status, id],
            )? > 0)
        })
        .await?
    }

    /// Mark that the stock player actually opened the local audio stream.
    /// Repeated/racing range requests are idempotent and cannot overwrite a
    /// terminal result.
    pub async fn mark_music_activity_playing(
        &self,
        id: i64,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            Ok(conn.execute(
                "UPDATE spotify_history SET status = 'playing'
                 WHERE id = ?1 AND ended_at IS NULL
                   AND status IN ('requested', 'started')",
                params![id],
            )? > 0)
        })
        .await?
    }

    /// A process restart cannot resume an old loopback stream. Reconcile any
    /// non-terminal row before accepting new playback so Center never shows a
    /// track as perpetually active.
    pub async fn interrupt_stale_music_activity(
        &self,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            conn.execute(
                "UPDATE spotify_history
                 SET status = 'interrupted', ended_at = strftime('%s','now')
                 WHERE ended_at IS NULL
                   AND status IN ('requested', 'started', 'playing')",
                [],
            )
            .map_err(Into::into)
        })
        .await?
    }

    pub async fn list_music_activity(
        &self,
        limit: usize,
        before_id: Option<i64>,
    ) -> Result<Vec<MusicActivityRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let limit = i64::try_from(limit.clamp(1, 100)).unwrap_or(100);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT id, track_id, title, artists_json, album, status, started_at, ended_at
                 FROM spotify_history WHERE (?1 IS NULL OR id < ?1)
                 ORDER BY id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![before_id, limit], |row| {
                let artists_json: String = row.get(3)?;
                Ok(MusicActivityRecord {
                    id: row.get(0)?,
                    track_id: row.get(1)?,
                    title: row.get(2)?,
                    artists: serde_json::from_str(&artists_json).unwrap_or_default(),
                    album: row.get(4)?,
                    status: row.get(5)?,
                    started_at: row.get(6)?,
                    ended_at: row.get(7)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await?
    }

    /// Return only a recent track that reached the stock player's stream.
    /// Merely resolving/requesting a Spotify item is not enough to become
    /// conversational "this song" context, and failed rows are never used.
    pub async fn recent_music_context(
        &self,
        max_age_seconds: u64,
    ) -> Result<Option<MusicActivityRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let max_age_seconds = i64::try_from(max_age_seconds).unwrap_or(i64::MAX);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let mut stmt = conn.prepare(
                "SELECT id, track_id, title, artists_json, album, status, started_at, ended_at
                 FROM spotify_history
                 WHERE title <> 'Unknown track'
                   AND (
                     status = 'playing'
                     OR (
                       status IN ('completed', 'interrupted')
                       AND CAST(ended_at AS INTEGER) >= strftime('%s','now') - ?1
                     )
                   )
                 ORDER BY CASE WHEN status = 'playing' THEN 0 ELSE 1 END, id DESC
                 LIMIT 1",
            )?;
            let result = stmt.query_row(params![max_age_seconds], |row| {
                let artists_json: String = row.get(3)?;
                Ok(MusicActivityRecord {
                    id: row.get(0)?,
                    track_id: row.get(1)?,
                    title: row.get(2)?,
                    artists: serde_json::from_str(&artists_json).unwrap_or_default(),
                    album: row.get(4)?,
                    status: row.get(5)?,
                    started_at: row.get(6)?,
                    ended_at: row.get(7)?,
                })
            });
            match result {
                Ok(record) => Ok(Some(record)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(error) => Err(error.into()),
            }
        })
        .await?
    }

    pub async fn delete_music_activity(
        &self,
        id: i64,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            Ok(conn.execute("DELETE FROM spotify_history WHERE id = ?1", params![id])? > 0)
        })
        .await?
    }

    pub async fn clear_music_activity(
        &self,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            conn.execute("DELETE FROM spotify_history", [])
                .map_err(Into::into)
        })
        .await?
    }
}

fn status_to_str(status: &MemoryStatus) -> &'static str {
    match status {
        MemoryStatus::Pending => "pending",
        MemoryStatus::Uploading => "uploading",
        MemoryStatus::Complete => "complete",
        MemoryStatus::Failed => "failed",
    }
}

fn str_to_status(s: &str) -> MemoryStatus {
    match s {
        "pending" => MemoryStatus::Pending,
        "uploading" => MemoryStatus::Uploading,
        "complete" => MemoryStatus::Complete,
        "failed" => MemoryStatus::Failed,
        other => {
            warn!(
                status = other,
                "unknown memory status, defaulting to Pending"
            );
            MemoryStatus::Pending
        }
    }
}

/// Build a `MemoryRecord` from a row.
fn memory_from_row(row: &rusqlite::Row) -> MemoryRecord {
    let status_str: String = row.get_unwrap(4);
    let lat: Option<f64> = row.get_unwrap(6);
    let lon: Option<f64> = row.get_unwrap(7);

    let location = match (lat, lon) {
        (Some(latitude), Some(longitude)) => Some(Location {
            latitude,
            longitude,
            accuracy: row.get_unwrap::<_, Option<f64>>(8).map(|a| a as f32),
            human_readable: row.get_unwrap(9),
            full_address: row.get_unwrap(10),
        }),
        _ => None,
    };

    MemoryRecord {
        uuid: row.get_unwrap(0),
        memory_type: row.get_unwrap(1),
        device_local_id: row.get_unwrap(2),
        created_at: row.get_unwrap(3),
        status: str_to_status(&status_str),
        files: Vec::new(), // filled in by caller
        thumbnail_count: row.get_unwrap::<_, i64>(5) as usize,
        location,
    }
}

/// Fetch the file list for a given memory UUID.
fn get_files_for_memory(conn: &Connection, uuid: &str) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt =
        conn.prepare("SELECT filename FROM memory_files WHERE memory_uuid = ?1 ORDER BY id")?;
    let rows = stmt.query_map(params![uuid], |row| row.get(0))?;
    rows.collect()
}

/// Fetch a single memory by UUID (with files).
fn get_memory_inner(
    conn: &Connection,
    uuid: &str,
) -> Result<Option<MemoryRecord>, Box<dyn std::error::Error + Send + Sync>> {
    let mut stmt = conn.prepare(
        "SELECT uuid, memory_type, device_local_id, created_at, status,
                thumbnail_count, latitude, longitude, location_accuracy,
                location_human_readable, location_full_address
         FROM memories WHERE uuid = ?1",
    )?;
    let result = stmt
        .query_row(params![uuid], |row| Ok(memory_from_row(row)))
        .ok();

    match result {
        Some(mut record) => {
            record.files = get_files_for_memory(conn, uuid)?;
            Ok(Some(record))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    const TEST_DATABASE_KEY: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn plaintext_database_is_atomically_migrated_to_sqlcipher() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.sqlite");
        let db = Database::open(&path).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO conversations (run_id, utterance) VALUES (?1, ?2)",
                params!["migration-run", "sensitive migration phrase"],
            )
            .unwrap();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .unwrap();
        }
        drop(db);
        assert!(has_plaintext_sqlite_header(&path).unwrap());

        let encrypted = Database::open_encrypted(&path, TEST_DATABASE_KEY).unwrap();
        assert!(!has_plaintext_sqlite_header(&path).unwrap());
        assert!(!std::fs::read(&path)
            .unwrap()
            .windows("sensitive migration phrase".len())
            .any(|window| window == b"sensitive migration phrase"));
        let count: i64 = encrypted
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE run_id = 'migration-run'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(encrypted);

        let wrong_key = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        assert!(Database::open_encrypted(&path, wrong_key).is_err());
        assert!(Database::open_encrypted(&path, TEST_DATABASE_KEY).is_ok());
    }

    #[test]
    fn invalid_database_key_is_rejected_before_creating_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.sqlite");
        assert!(Database::open_encrypted(&path, "not-a-key").is_err());
        assert!(!path.exists());
    }
}
