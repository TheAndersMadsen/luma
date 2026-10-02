//! PostgreSQL-backed [`Store`], the documented persistence target.
//!
//! Cosmos uses PostgreSQL in production. Until now the
//! clone snapshotted JSON per workload, which meant the three stateful workloads
//! (contacts, notable-events, ai-bus) each held their own island of state. A
//! shared database is what makes them one account.
//!
//! ## Design notes
//!
//! **Everything is keyed by the authenticated principal.** Isolation is a
//! security property, not a convenience: every statement filters on it, and a
//! test proves one principal cannot read another's rows.
//!
//! **Protobuf-typed columns are `BYTEA` holding prost encodings.** The wire
//! encoding is the one representation guaranteed stable here, a hand-rolled
//! column layout would drift from the contract the device speaks.
//!
//! **Sync cursors stay strictly monotonic per principal, and are allocated
//! inside the transaction they stamp.** The device compares its own cursor
//! against ours to decide what changed, so two writes inside one clock tick, or
//! a clock that steps backwards, must still order. More than that, the cursor
//! must not be *assigned* before the write it belongs to becomes visible: a
//! writer that commits second holding the lower cursor is a write the device
//! will never ask for again. `cosmos_sync_cursor` is the allocator that makes
//! assignment and commit one step. See [`PostgresStore::next_cursor`]. The
//! in-memory store gets the same property from holding its lock across both.
//!
//! **A configured-but-unreachable database fails loudly at startup.** Falling
//! back to memory would look healthy and quietly lose the wearer's data, which
//! is the failure this whole module exists to prevent.

use cosmos_protocol::common::encryption::EncryptedData;
use cosmos_protocol::contacts as pb;
use sqlx::{Row, postgres::PgPoolOptions};

use std::collections::HashMap;

use crate::store::{
    CaptureMetadata, ContactRecord, ContactSnapshot, DeletionRecord, EncryptedContactRecord,
    EventFilter, EventSearchIndex, EventVote, MAX_PENDING_MEMORY_CREATES, MemoryKind, MemoryRecord,
    MemorySummary, NewMemory, NewNote, NotableEventRecord, NoteRecord, NoteSource,
    PendingMemoryCreate, SearchableNote, Store, StoreError, StorePage, SyncTime, UploadState,
    Written,
};

/// Connection string. Unset means this deployment stays on the in-memory store.
pub const DATABASE_URL_ENV: &str = "COSMOS_DATABASE_URL";

/// Advisory-lock key serializing schema creation across replicas. Arbitrary but
/// fixed. The enrollment schema uses a different one so the two never block each
/// other. See [`PostgresStore::migrate`].
pub(crate) const SCHEMA_LOCK_KEY: i64 = 0x0CA2_2451_0000_0001;

/// Advisory-lock class serializing one principal's pending-create declarations
/// against the `CreateMemory` that clears them. The second key is
/// `hashtext(principal)`. The two-key form is a lock space apart from the
/// one-key locks above, so this can never contend with schema creation.
pub(crate) const PENDING_CREATE_LOCK_CLASS: i32 = 0x0CA2_0007;

/// Take [`PENDING_CREATE_LOCK_CLASS`] for `principal` until `tx` ends.
async fn lock_pending_creates(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &str,
) -> Result<(), StoreError> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, hashtext($2))")
        .bind(PENDING_CREATE_LOCK_CLASS)
        .bind(principal)
        .execute(&mut **tx)
        .await
        .map_err(|_| StoreError::Unavailable)?;
    Ok(())
}

/// An explicit separator keeps execution deterministic without pretending a
/// naive semicolon split is a SQL parser. Each migration remains valid SQL when
/// opened directly because the separator is a line comment.
const MIGRATION_STATEMENT_MARKER: &str = "-- cosmos:statement";

/// One append-only, source-embedded migration.
///
/// Versions are global across Cosmos rather than per workload. Each workload
/// applies only the migrations for the schema it owns, through the same startup
/// path and advisory lock it used before the DDL moved out of Rust.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct EmbeddedMigration {
    pub(crate) version: u32,
    pub(crate) filename: &'static str,
    sql: &'static str,
}

impl EmbeddedMigration {
    pub(crate) const fn new(version: u32, filename: &'static str, sql: &'static str) -> Self {
        Self {
            version,
            filename,
            sql,
        }
    }

    /// Yield exactly the statements separated by the explicit migration marker.
    pub(crate) fn statements(&self) -> impl Iterator<Item = &'static str> {
        self.sql
            .split(MIGRATION_STATEMENT_MARKER)
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
    }

    #[cfg(test)]
    pub(crate) const fn source(&self) -> &'static str {
        self.sql
    }
}

pub(crate) const STORE_MIGRATIONS: &[EmbeddedMigration] = &[
    EmbeddedMigration::new(
        1,
        "0001_store.sql",
        include_str!("../../../migrations/0001_store.sql"),
    ),
    EmbeddedMigration::new(
        4,
        "0004_listing.sql",
        include_str!("../../../migrations/0004_listing.sql"),
    ),
    EmbeddedMigration::new(
        5,
        "0005_device_status_namespacing.sql",
        include_str!("../../../migrations/0005_device_status_namespacing.sql"),
    ),
    EmbeddedMigration::new(
        7,
        "0007_consolidation.sql",
        include_str!("../../../migrations/0007_consolidation.sql"),
    ),
];

/// Statements this history is allowed to remove data with, frozen verbatim.
///
/// Migrations are non-destructive by rule (see
/// `every_migration_statement_is_restart_safe_and_non_destructive`), because the
/// blast radius of an accidental one is the wearer's own data. A retention or
/// privacy cleanup is the deliberate exception, and it is carried here as EXACT
/// normalized text rather than by loosening the rule to "DELETE is allowed":
/// any other destructive statement, and any edit to one of these, still fails
/// the gate and has to be reviewed onto this list on purpose.
#[cfg(test)]
const REVIEWED_DATA_REMOVALS: &[(&str, &str)] = &[(
    "0005_device_status_namespacing.sql",
    "DELETE FROM COSMOS_ACCOUNT_BLOB WHERE KIND = 'DEVICE_STATUS' \
     AND STRPOS(PRINCIPAL, '#DEVICE:') = 0;",
)];

/// Whether this run may perform data removals.
///
/// Off by default, so an ordinary deploy cannot delete a wearer's rows no
/// matter which migrations it happens to contain.
fn data_removals_enabled() -> bool {
    matches!(
        std::env::var("COSMOS_ALLOW_DATA_REMOVALS").as_deref(),
        Ok("1") | Ok("true")
    )
}

/// Recognises a row-removing statement by verb on normalized text, the same way
/// `every_migration_statement_is_restart_safe_and_non_destructive` does, so the
/// runtime and the gate cannot drift into disagreeing about what is destructive.
fn statement_removes_data(statement: &str) -> bool {
    let normalized = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    let padded = format!(" {} ", normalized.to_uppercase());
    [" DELETE ", " TRUNCATE ", " DROP "]
        .iter()
        .any(|verb| padded.contains(verb))
}

/// The same rows a held-back `DELETE FROM … [WHERE …]` statement would remove,
/// counted instead. `None` for any other removal, which cannot be counted.
fn removal_count_query(statement: &str) -> Option<String> {
    const DELETE: &str = "DELETE FROM ";
    let sql = statement
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .flat_map(str::split_whitespace)
        .collect::<Vec<_>>()
        .join(" ");
    let sql = sql.trim_end_matches(';').trim_end();
    sql.get(..DELETE.len())
        .filter(|verb| verb.eq_ignore_ascii_case(DELETE))
        .map(|_| format!("SELECT COUNT(*) FROM {}", &sql[DELETE.len()..]))
}

pub struct PostgresStore {
    pool: sqlx::PgPool,
}

impl PostgresStore {
    /// Connect and ensure the schema exists.
    ///
    /// Returns an error rather than degrading: a deployment that asked for a
    /// database and did not get one must not silently serve an empty account.
    pub async fn connect(url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(url)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        // Same reasoning as the removal gate above: this REWRITES existing
        // wearer rows, and a candidate's startup must not move data the deploy
        // then fingerprints. The read path already falls back to counting the
        // stored frames when the column is NULL, so holding it back costs a
        // little listing work and changes no answer.
        if data_removals_enabled() {
            store.backfill_thumbnail_counts().await;
        }
        Ok(store)
    }

    /// A store whose pool is built WITHOUT connecting, so the first *statement*
    /// is what fails.
    ///
    /// Tests for "a write that could not land is never reported as success"
    /// need the write to fail, not the startup: [`PostgresStore::connect`]
    /// against a closed port errors before a store exists, and a test that
    /// shrugs at that proves nothing about the write path it claims to cover.
    #[cfg(test)]
    pub(crate) fn unreachable() -> Self {
        let pool = PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(250))
            .connect_lazy("postgres://cosmos@127.0.0.1:1/none")
            .expect("the URL is syntactically valid; only connecting fails");
        Self { pool }
    }

    /// Idempotent schema creation, so a fresh database and a restart look alike.
    ///
    /// Serialized by a transaction-scoped advisory lock, because
    /// `CREATE TABLE IF NOT EXISTS` is **not** concurrency-safe: the existence
    /// check is not atomic with the create, so two sessions issuing it at the
    /// same moment race in the catalog and the loser gets
    /// `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`
    /// (or `42710 type already exists`). That is not a hypothetical, every
    /// production workloads may run more than one replica, and
    /// `migrate` runs on EVERY [`PostgresStore::connect`], so two pods coming up
    /// together against a fresh database would race. The loser's `connect`
    /// returns `Err` and `store::configured()` panics by design, turning a
    /// first deploy into a crash loop.
    ///
    /// `pg_advisory_xact_lock` is released automatically when the transaction
    /// ends, including on failure, so a crashed migrator cannot wedge the lock.
    /// DDL is transactional in Postgres, so the whole schema commits or none of
    /// it does.
    async fn migrate(&self) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(SCHEMA_LOCK_KEY)
            .execute(&mut *tx)
            .await?;
        // One statement per call: `sqlx::query` does not accept multiple.
        //
        // Statements that REMOVE wearer data are held back unless the operator
        // asked for them. Starting a candidate must not change a wearer's rows:
        // the deploy's staging smoke fingerprints every relation before and
        // after startup and refuses a candidate that moved one, so a cleanup
        // riding along with a release is either blocked, or, if that gate were
        // ever relaxed, deletes data as an invisible side effect of shipping.
        // The removal itself is legitimate and reviewed (REVIEWED_DATA_REMOVALS
        // pins its exact text). It just has to be something an operator does on
        // purpose rather than something a release does to them.
        let removals_allowed = data_removals_enabled();
        let mut held_back = Vec::new();
        for migration in STORE_MIGRATIONS {
            for statement in migration.statements() {
                if !removals_allowed && statement_removes_data(statement) {
                    held_back.push((migration.filename, statement));
                    continue;
                }
                sqlx::query(statement).execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
        for (migration, pending) in self.pending_removals(&held_back).await {
            match pending {
                // Nothing to remove, so nothing is withheld: a fresh or clean
                // database stays quiet at every start of every workload.
                Some(0) => {
                    tracing::debug!(migration, "store: held-back data removal matches no rows")
                }
                Some(rows) => tracing::info!(
                    migration,
                    rows,
                    "store: holding back a reviewed data removal of {rows} rows; \
                     set COSMOS_ALLOW_DATA_REMOVALS=1 to run it deliberately"
                ),
                None => tracing::info!(
                    migration,
                    "store: holding back a reviewed data removal; \
                     set COSMOS_ALLOW_DATA_REMOVALS=1 to run it deliberately"
                ),
            }
        }
        Ok(())
    }

    /// How many rows each held-back removal would delete, or `None` when that
    /// cannot be counted (not a plain `DELETE`, or the count failed). Runs after
    /// the migration commits, so a failed count never aborts the schema.
    async fn pending_removals(
        &self,
        held_back: &[(&'static str, &'static str)],
    ) -> Vec<(&'static str, Option<i64>)> {
        let mut pending = Vec::with_capacity(held_back.len());
        for &(migration, statement) in held_back {
            let rows = match removal_count_query(statement) {
                Some(query) => sqlx::query_scalar::<_, i64>(&query)
                    .fetch_one(&self.pool)
                    .await
                    .ok(),
                None => None,
            };
            pending.push((migration, rows));
        }
        pending
    }

    /// Fill `thumbnail_count` for captures written before the column existed.
    ///
    /// Deliberately NOT part of the migration: the migration suite forbids `UPDATE`
    /// so a schema step can never rewrite a wearer's rows, and that guard is worth
    /// more than the convenience. It lives here instead, where it is a data repair
    /// with a name.
    ///
    /// Best-effort on purpose. The read path computes the same count from the
    /// stored array when the scalar is absent (see [`THUMBNAIL_COUNT_EXPRESSION`]),
    /// so a repair that cannot run costs performance, not correctness, and
    /// failing the startup of a workload a live Pin is reporting into, over an
    /// optimisation, would be the worse trade. It converges: after one successful
    /// pass the predicate matches nothing.
    async fn backfill_thumbnail_counts(&self) {
        let repaired = sqlx::query(&format!(
            "UPDATE cosmos_memory SET thumbnail_count = {THUMBNAIL_COUNT_EXPRESSION} \
             WHERE thumbnail_count IS NULL"
        ))
        .execute(&self.pool)
        .await;
        match repaired {
            Ok(result) if result.rows_affected() > 0 => tracing::info!(
                rows = result.rows_affected(),
                "capture store: filled thumbnail_count for captures stored before the column existed"
            ),
            Ok(_) => {}
            Err(error) => tracing::warn!(
                %error,
                "capture store: could not fill thumbnail_count; listings will keep counting \
                 frames out of the stored blob"
            ),
        }
    }

    /// Allocate this principal's next sync cursor **inside** `tx`.
    ///
    /// The cursor used to be read with a standalone `SELECT MAX(...)` before the
    /// writes were issued, which loses the wearer's edits: two concurrent writers
    /// both read the same high-water mark, the one that commits *second* can hold
    /// the *lower* cursor, and a device that read the snapshot in between now
    /// syncs with a cursor at or above it. Delta reads compare strictly greater
    /// (`ContactSnapshot::contacts_since`), so that write is skipped, silently,
    /// and forever, because nothing will ever raise its cursor again.
    ///
    /// Taking `&mut PgConnection` from the caller's transaction is the fix, and
    /// the signature is the enforcement: the cursor cannot be allocated except on
    /// the connection that also carries the writes. The single upsert is what
    /// makes it atomic, it takes a row lock on this principal's cursor row that
    /// is held until the transaction commits, so a concurrent writer for the same
    /// principal blocks here and is issued a strictly higher cursor only once the
    /// first writer's rows are visible.
    ///
    /// `GREATEST(stored + 1, now)` keeps the cursor strictly monotonic per
    /// principal whatever the clock does, while still tracking wall time forward.
    async fn next_cursor(
        connection: &mut sqlx::PgConnection,
        principal: &str,
    ) -> Result<SyncTime, StoreError> {
        let nanos: i64 = sqlx::query_scalar(
            "INSERT INTO cosmos_sync_cursor (principal, cursor_nanos) VALUES ($1, $2)
             ON CONFLICT (principal) DO UPDATE SET
                cursor_nanos = GREATEST(cosmos_sync_cursor.cursor_nanos + 1, EXCLUDED.cursor_nanos)
             RETURNING cursor_nanos",
        )
        .bind(principal)
        .bind(SyncTime::now().to_epoch_nanos())
        .fetch_one(connection)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(SyncTime::from_epoch_nanos(nanos))
    }

    /// The capture write itself: idempotent on `device_local_id`, so a
    /// retried `CreateMemory` returns the first attempt's uuid.
    async fn insert_memory(&self, principal: &str, new: NewMemory) -> Written<MemoryRecord> {
        // Idempotent on the device's own id: a retried CreateMemory must return
        // the SAME uuid, or the first attempt's upload slots are orphaned.
        if !new.device_local_id.is_empty() {
            if let Some(existing) = self.memory(principal, &new.device_local_id).await? {
                return Ok(existing);
            }
            // Propagate: a swallowed lookup here silently defeats idempotency and
            // mints a SECOND uuid for a capture that already has one, orphaning
            // the first attempt's upload slots.
            let found = sqlx::query(
                "SELECT uuid FROM cosmos_memory WHERE principal = $1 AND device_local_id = $2 \
                 AND deleted_seconds IS NULL",
            )
            .bind(principal)
            .bind(&new.device_local_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)?;
            if let Some(row) = found {
                let uuid: String = row.get("uuid");
                if let Some(existing) = self.memory(principal, &uuid).await? {
                    return Ok(existing);
                }
            }
        }

        // Never `unwrap_or(1)`: a failed sequence read would hand every capture
        // in the outage the same numeric id.
        let numeric_id: i64 = sqlx::query_scalar("SELECT nextval('cosmos_memory_id_seq')")
            .fetch_one(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)?;
        let record = crate::store::build_memory(new, numeric_id);

        let thumbnails: Vec<u8> =
            serde_json::to_vec(&record.thumbnails.iter().map(encode).collect::<Vec<_>>())
                .unwrap_or_default();
        sqlx::query(
            "INSERT INTO cosmos_memory
                (principal, uuid, numeric_id, device_local_id, kind,
                 created_seconds, created_nanos, device_created_seconds, device_created_nanos,
                 gmt_offset, thumbnails, thumbnail_count, encrypted_location, bursts,
                 upload_complete, photo_metadatas, format, lut_name, encryption_kid,
                 num_videos, total_video_duration_sec, upload_state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE,
                     $15,$16,$17,$18,$19,$20,$21)",
        )
        .bind(principal)
        .bind(&record.uuid)
        .bind(record.numeric_id)
        .bind(&record.device_local_id)
        .bind(kind_to_i16(record.kind))
        .bind(record.created.seconds())
        .bind(record.created.nanos())
        .bind(record.device_created_time.map(|t| t.seconds()))
        .bind(record.device_created_time.map(|t| t.nanos()))
        .bind(record.gmt_offset)
        .bind(thumbnails)
        // The count is written beside the blob so a listing never has to open
        // it. It is derived from the same vector that was just serialised, so
        // the two cannot disagree for any row written from here on.
        .bind(record.thumbnails.len() as i32)
        .bind(record.encrypted_location.as_ref().map(encode))
        .bind(encode_bursts(&record.bursts))
        .bind(encode_photo_metadatas(&record.metadata.photo_metadatas))
        .bind(record.metadata.format)
        .bind(&record.metadata.lut_name)
        .bind(&record.metadata.encryption_kid)
        .bind(record.metadata.num_videos)
        .bind(record.metadata.total_video_duration_sec)
        .bind(record.upload_state.as_str())
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(record)
    }
}

fn encode<M: prost::Message>(m: &M) -> Vec<u8> {
    m.encode_to_vec()
}

fn decode<M: prost::Message + Default>(bytes: &[u8]) -> Option<M> {
    M::decode(bytes).ok()
}

/// Decode a stored protobuf column, reporting a blob that does not parse.
///
/// The permissive [`decode`] is right where absence and corruption are the same
/// answer, an optional location the device never sent decodes to `None` either
/// way. It is wrong inside a LIST: a frame that fails to parse there is silently
/// dropped, and the capture comes back with fewer thumbnails than were stored,
/// which is a state the in-memory store can never produce. Corruption must be
/// reported, not rendered as a smaller burst.
fn decode_or_corrupt<M: prost::Message + Default>(bytes: &[u8]) -> Result<M, StoreError> {
    M::decode(bytes).map_err(|_| StoreError::Unavailable)
}

/// Bursts are stored as a length-prefixed prost blob. They are opaque to SQL and
/// only ever read back whole.
fn encode_bursts(bursts: &[crate::store::BurstRecord]) -> Vec<u8> {
    serde_json::to_vec(bursts).unwrap_or_default()
}

fn decode_bursts(bytes: &[u8]) -> Result<Vec<crate::store::BurstRecord>, StoreError> {
    serde_json::from_slice(bytes).map_err(|_| StoreError::Unavailable)
}

/// How a listing reads a capture's thumbnail count without reading its frames.
///
/// `thumbnail_count` is written beside the blob by `create_memory`. Rows stored
/// before the column existed contain NULL, and those fall back to counting the
/// array elements inside PostgreSQL, still far cheaper than shipping the blob
/// to this process, and it converges to the scalar once
/// [`PostgresStore::backfill_thumbnail_counts`] has run. `CASE` short-circuits,
/// so a row with the scalar never touches `thumbnails` at all.
///
/// The `octet_length` guard is what keeps the fallback total: `create_memory`
/// serialises with `unwrap_or_default()`, whose failure value is zero bytes, and
/// `''::jsonb` is a hard error rather than an empty array.
const THUMBNAIL_COUNT_EXPRESSION: &str = "CASE \
     WHEN thumbnail_count IS NOT NULL THEN thumbnail_count \
     WHEN thumbnails IS NULL OR octet_length(thumbnails) < 2 THEN 0 \
     ELSE jsonb_array_length(convert_from(thumbnails, 'UTF8')::jsonb) \
   END";

fn kind_to_i16(kind: MemoryKind) -> i16 {
    match kind {
        MemoryKind::Photo => 0,
        MemoryKind::Video => 1,
        MemoryKind::FoodLog => 2,
        MemoryKind::Note => 3,
    }
}

/// An unknown value is corruption, like a blob that does not decode: reading it
/// as a photo would serve a note or food log as an image.
fn kind_from_i16(value: i16) -> Result<MemoryKind, StoreError> {
    match value {
        0 => Ok(MemoryKind::Photo),
        1 => Ok(MemoryKind::Video),
        2 => Ok(MemoryKind::FoodLog),
        3 => Ok(MemoryKind::Note),
        _ => Err(StoreError::Unavailable),
    }
}

/// One `cosmos_memory` row -> [`MemoryRecord`].
///
/// A blob that does not decode is corruption, not "this capture has no
/// thumbnails / no upload slots": handing back an emptier capture than the one
/// stored is a state the in-memory store can never produce. Callers that select
/// live rows only get `deleted: None`, matching [`PostgresStore::memory`].
fn memory_from_row(row: &sqlx::postgres::PgRow) -> Result<MemoryRecord, StoreError> {
    let uuid: String = row.get("uuid");
    let thumbs: Vec<u8> = row.get("thumbnails");
    // Both arms fail the read. The outer one already did. The inner one used to
    // `filter_map` the failure away, which honoured the comment above for a
    // corrupt envelope and violated it for a corrupt frame.
    let thumbnails: Vec<EncryptedData> = serde_json::from_slice::<Vec<Vec<u8>>>(&thumbs)
        .map_err(|_| StoreError::Unavailable)?
        .iter()
        .enumerate()
        .map(|(index, blob)| {
            decode_or_corrupt(blob).inspect_err(|_| {
                // The uuid is server-minted and already appears in the request
                // path. The kid is not logged, because it carries the wearer's
                // device and user ids (see `services/events.rs`).
                tracing::warn!(
                    memory = %uuid,
                    index,
                    "stored thumbnail blob failed to decode; refusing to serve a shorter burst"
                );
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let location: Option<Vec<u8>> = row.get("encrypted_location");
    let bursts: Vec<u8> = row.get("bursts");
    let device_seconds: Option<i64> = row.get("device_created_seconds");
    let device_nanos: Option<i32> = row.get("device_created_nanos");
    let upload_complete: bool = row.get("upload_complete");
    let upload_state: Option<String> = row.get("upload_state");
    let photo_metadatas: Option<Vec<u8>> = row.get("photo_metadatas");

    Ok(MemoryRecord {
        uuid,
        numeric_id: row.get("numeric_id"),
        device_local_id: row.get("device_local_id"),
        kind: kind_from_i16(row.get("kind"))?,
        device_created_time: device_seconds
            .zip(device_nanos)
            .map(|(s, n)| SyncTime::from_parts(s, n)),
        gmt_offset: row.get("gmt_offset"),
        thumbnails,
        encrypted_location: location.as_deref().and_then(decode),
        bursts: decode_bursts(&bursts)?,
        upload_complete,
        deleted: None,
        created: SyncTime::from_parts(row.get("created_seconds"), row.get("created_nanos")),
        metadata: CaptureMetadata {
            photo_metadatas: match photo_metadatas {
                Some(bytes) => decode_photo_metadatas(&bytes)?,
                None => Vec::new(),
            },
            format: row.get::<Option<i32>, _>("format").unwrap_or_default(),
            lut_name: row.get::<Option<String>, _>("lut_name").unwrap_or_default(),
            encryption_kid: row
                .get::<Option<String>, _>("encryption_kid")
                .unwrap_or_default(),
            num_videos: row.get::<Option<i32>, _>("num_videos").unwrap_or_default(),
            total_video_duration_sec: row
                .get::<Option<i32>, _>("total_video_duration_sec")
                .unwrap_or_default(),
        },
        favorite: row.get("favorite"),
        tags: row.get("tags"),
        upload_state: UploadState::from_stored(upload_state.as_deref(), upload_complete),
    })
}

/// `photo_metadatas` is stored as the device's own `PhotoMemoryRequest` wire
/// form with only field 13 (`repeated ImageMetadata photo_metadatas`) set, so
/// the column holds exactly the bytes the Pin framed them in.
fn encode_photo_metadatas(
    metadatas: &[cosmos_protocol::capture::ImageMetadata],
) -> Option<Vec<u8>> {
    (!metadatas.is_empty()).then(|| {
        encode(&cosmos_protocol::capture::PhotoMemoryRequest {
            photo_metadatas: metadatas.to_vec(),
            ..Default::default()
        })
    })
}

fn decode_photo_metadatas(
    bytes: &[u8],
) -> Result<Vec<cosmos_protocol::capture::ImageMetadata>, StoreError> {
    decode_or_corrupt::<cosmos_protocol::capture::PhotoMemoryRequest>(bytes)
        .map(|request| request.photo_metadatas)
}

/// One `cosmos_memory` row read through the INDEX projection -> [`MemorySummary`].
///
/// Deliberately cannot see `thumbnails`: the count arrives as a scalar computed
/// by [`THUMBNAIL_COUNT_EXPRESSION`], so there is no way for this function to
/// re-introduce the whole-column read it exists to avoid.
fn memory_summary_from_row(row: &sqlx::postgres::PgRow) -> Result<MemorySummary, StoreError> {
    let bursts: Vec<u8> = row.get("bursts");
    let bursts = decode_bursts(&bursts)?;
    let device_seconds: Option<i64> = row.get("device_created_seconds");
    let device_nanos: Option<i32> = row.get("device_created_nanos");
    let thumbnail_count: i32 = row.get("thumbnail_count");
    let upload_complete: bool = row.get("upload_complete");
    let upload_state: Option<String> = row.get("upload_state");

    Ok(MemorySummary {
        uuid: row.get("uuid"),
        numeric_id: row.get("numeric_id"),
        device_local_id: row.get("device_local_id"),
        kind: kind_from_i16(row.get("kind"))?,
        device_created_time: device_seconds
            .zip(device_nanos)
            .map(|(s, n)| SyncTime::from_parts(s, n)),
        created: SyncTime::from_parts(row.get("created_seconds"), row.get("created_nanos")),
        upload_complete,
        thumbnail_count: thumbnail_count.max(0) as usize,
        has_location: row.get("has_location"),
        burst_count: bursts.len(),
        frame_count: bursts.iter().map(|burst| burst.files.len()).sum(),
        favorite: row.get("favorite"),
        tags: row.get("tags"),
        upload_state: UploadState::from_stored(upload_state.as_deref(), upload_complete),
        total_video_duration_sec: row
            .get::<Option<i32>, _>("total_video_duration_sec")
            .unwrap_or_default(),
    })
}

/// Every column [`note_from_row`] reads, in one place so no note read can ask
/// for less than the decoder needs or ship the principal back.
const NOTE_COLUMNS: &str = "uuid, indexed_text, encrypted_note, encrypted_location, \
     created_seconds, created_nanos, source, title, body, modified_seconds, \
     modified_nanos, time_zone, location, tags";

/// One `cosmos_note` row -> [`NoteRecord`].
///
/// Sealed bodies stay opaque: a body that does not decode is genuinely absent to
/// us (the device sealed it under a key we may not hold), which is why this is
/// the permissive [`decode`] rather than [`decode_or_corrupt`].
fn note_from_row(row: sqlx::postgres::PgRow) -> NoteRecord {
    let note: Option<Vec<u8>> = row.get("encrypted_note");
    let location: Option<Vec<u8>> = row.get("encrypted_location");
    let place: Option<Vec<u8>> = row.get("location");
    let source: Option<String> = row.get("source");
    let modified_seconds: Option<i64> = row.get("modified_seconds");
    let modified_nanos: Option<i32> = row.get("modified_nanos");
    NoteRecord {
        uuid: row.get("uuid"),
        indexed_text: row.get("indexed_text"),
        encrypted_note: note.as_deref().and_then(decode),
        encrypted_location: location.as_deref().and_then(decode),
        created: SyncTime::from_parts(row.get("created_seconds"), row.get("created_nanos")),
        source: source.as_deref().and_then(NoteSource::parse),
        title: row.get("title"),
        body: row.get("body"),
        modified: modified_seconds
            .zip(modified_nanos)
            .map(|(s, n)| SyncTime::from_parts(s, n)),
        time_zone: row.get("time_zone"),
        location: place.as_deref().and_then(decode),
        tags: row.get("tags"),
    }
}

/// Every column [`event_from_row`] reads.
const EVENT_COLUMNS: &str = "event_identifier, originator_identifier, creation_seconds, \
     creation_nanos, event_type, event_data, encrypted_event_data, encrypted_location, \
     device_is_locked, indexed_text, ingested_seconds, ingested_nanos";

/// One `cosmos_event` row -> [`NotableEventRecord`].
fn event_from_row(row: sqlx::postgres::PgRow) -> NotableEventRecord {
    let data: Option<Vec<u8>> = row.get("event_data");
    let sealed: Option<Vec<u8>> = row.get("encrypted_event_data");
    let location: Option<Vec<u8>> = row.get("encrypted_location");
    let cs: Option<i64> = row.get("creation_seconds");
    let cn: Option<i32> = row.get("creation_nanos");
    NotableEventRecord {
        event_identifier: row.get("event_identifier"),
        originator_identifier: row.get("originator_identifier"),
        creation_time: cs.zip(cn).map(|(s, n)| SyncTime::from_parts(s, n)),
        event_type: row.get("event_type"),
        event_data: data.as_deref().and_then(decode),
        encrypted_event_data: sealed.as_deref().and_then(decode),
        encrypted_location: location.as_deref().and_then(decode),
        device_is_locked: row.get("device_is_locked"),
        ingested: SyncTime::from_parts(row.get("ingested_seconds"), row.get("ingested_nanos")),
        indexed_text: row.try_get("indexed_text").ok(),
    }
}

/// The `WHERE` clause an [`EventFilter`] compiles to, over binds `$1..$6`
/// in the order [`bind_event_filter`] pushes them. An empty set is "any"
/// (`cardinality = 0`), never `= ANY('{}')`, which matches nothing.
const EVENT_FILTER_SQL: &str = "principal = $1 \
     AND (cardinality($2::text[]) = 0 OR event_type = ANY($2::text[])) \
     AND (cardinality($3::text[]) = 0 OR originator_identifier = ANY($3::text[])) \
     AND NOT (originator_identifier = ANY($4::text[])) \
     AND ($5::bigint IS NULL OR creation_seconds >= $5) \
     AND ($6::bigint IS NULL OR creation_seconds <= $6)";

fn bind_event_filter<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    principal: &'q str,
    filter: &'q EventFilter,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    query
        .bind(principal)
        .bind(&filter.types)
        .bind(&filter.originators)
        .bind(&filter.excluded_originators)
        .bind(filter.start.map(|t| t.seconds()))
        .bind(filter.end.map(|t| t.seconds()))
}

/// The `kind = ANY($n)` bind for a kind filter; `None` means "every kind".
///
/// A NULL array rather than an empty one, because `kind = ANY('{}')` matches
/// nothing, the same expression would silently turn "no filter" into "no
/// captures".
fn kind_filter(kinds: &[MemoryKind]) -> Option<Vec<i16>> {
    (!kinds.is_empty()).then(|| kinds.iter().copied().map(kind_to_i16).collect())
}

#[tonic::async_trait]
impl Store for PostgresStore {
    /// One transaction: the cursor is allocated on the same connection that
    /// carries the writes and becomes visible with them, so a device can never
    /// be handed a sync point that a not-yet-committed write already sits at or
    /// below. See [`PostgresStore::next_cursor`].
    async fn put_contacts(
        &self,
        principal: &str,
        list: &pb::ContactList,
    ) -> Written<Vec<ContactRecord>> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| StoreError::Unavailable)?;
        let stamp = Self::next_cursor(&mut tx, principal).await?;
        let mut written = Vec::with_capacity(list.contacts.len());

        for incoming in &list.contacts {
            // An empty id is a create. A supplied id upserts within THIS
            // principal only, so a retry is idempotent and cannot reach across
            // accounts.
            let id = if incoming.id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                incoming.id.clone()
            };
            let mut contact = incoming.clone();
            contact.id = id.clone();

            // Version is server-owned: the client's value says what it holds,
            // not what the record becomes. Reading it before the write is safe
            // *because* the cursor row lock above is already held, every
            // mutating path for a principal allocates the cursor first, so this
            // transaction is the only one writing this principal's contacts and
            // no other writer can read the same version and overwrite our edit.
            // The version has to be known here rather than derived in SQL: the
            // device reads it back out of the encoded `contact` blob, not out of
            // the column.
            let version: i32 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM cosmos_contact \
                 WHERE principal = $1 AND id = $2",
            )
            .bind(principal)
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| StoreError::Unavailable)?;
            contact.version = version;
            contact.modified_at = Some(stamp.to_proto());

            // A swallowed failure here is reported to the Pin as a successful
            // write. It will not retry, and the wearer's contact is gone.
            sqlx::query(
                "INSERT INTO cosmos_contact
                    (principal, id, contact, version, modified_seconds, modified_nanos)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (principal, id) DO UPDATE SET
                    contact = EXCLUDED.contact,
                    version = EXCLUDED.version,
                    modified_seconds = EXCLUDED.modified_seconds,
                    modified_nanos = EXCLUDED.modified_nanos",
            )
            .bind(principal)
            .bind(&id)
            .bind(encode(&contact))
            .bind(version)
            .bind(stamp.seconds())
            .bind(stamp.nanos())
            .execute(&mut *tx)
            .await
            .map_err(|_| StoreError::Unavailable)?;

            // Re-creating an id retires its tombstone, or a delta sync would
            // report the contact as both present and deleted.
            sqlx::query("DELETE FROM cosmos_contact_tombstone WHERE principal = $1 AND id = $2")
                .bind(principal)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(|_| StoreError::Unavailable)?;

            written.push(ContactRecord {
                contact,
                modified: stamp,
            });
        }

        // Encrypted contacts have no id field in the proto, so their identity is
        // the exact ciphertext, retry-idempotent without inventing one.
        for (index, sealed) in list.encrypted_contacts.iter().enumerate() {
            let version = list
                .encrypted_contacts_versions
                .get(index)
                .copied()
                .unwrap_or(1);
            // A swallowed failure here is reported to the Pin as a successful
            // write. It will not retry, and the wearer's contact is gone.
            sqlx::query(
                "INSERT INTO cosmos_contact_encrypted
                    (principal, ciphertext, version, modified_seconds, modified_nanos)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (principal, ciphertext) DO UPDATE SET
                    version = EXCLUDED.version,
                    modified_seconds = EXCLUDED.modified_seconds,
                    modified_nanos = EXCLUDED.modified_nanos",
            )
            .bind(principal)
            .bind(encode(sealed))
            .bind(version)
            .bind(stamp.seconds())
            .bind(stamp.nanos())
            .execute(&mut *tx)
            .await
            .map_err(|_| StoreError::Unavailable)?;
        }

        // Nothing above is durable until this returns. A failed commit is a
        // failed write and must be reported as one.
        tx.commit().await.map_err(|_| StoreError::Unavailable)?;
        Ok(written)
    }

    async fn delete_contacts(&self, principal: &str, ids: &[String]) -> Written<()> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| StoreError::Unavailable)?;
        let stamp = Self::next_cursor(&mut tx, principal).await?;
        for id in ids {
            // Only tombstone something that existed: a delete for an unknown id
            // creates no state, matching the in-memory store. The DELETE's own
            // row count answers that, so there is no separate SELECT to race
            // against.
            let removed =
                sqlx::query("DELETE FROM cosmos_contact WHERE principal = $1 AND id = $2")
                    .bind(principal)
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|_| StoreError::Unavailable)?
                    .rows_affected();
            if removed == 0 {
                continue;
            }
            // A lost tombstone is worse than a lost delete: the contact silently
            // reappears on the device's next delta sync.
            sqlx::query(
                "INSERT INTO cosmos_contact_tombstone
                    (principal, id, deleted_seconds, deleted_nanos)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (principal, id) DO UPDATE SET
                    deleted_seconds = EXCLUDED.deleted_seconds,
                    deleted_nanos = EXCLUDED.deleted_nanos",
            )
            .bind(principal)
            .bind(id)
            .bind(stamp.seconds())
            .bind(stamp.nanos())
            .execute(&mut *tx)
            .await
            .map_err(|_| StoreError::Unavailable)?;
        }
        tx.commit().await.map_err(|_| StoreError::Unavailable)?;
        Ok(())
    }

    async fn delete_encrypted_contacts(
        &self,
        principal: &str,
        sealed: &[EncryptedData],
    ) -> Written<usize> {
        if sealed.is_empty() {
            return Ok(0);
        }
        // The same encoding `put_contacts` keys the row on.
        let ciphertexts: Vec<Vec<u8>> = sealed.iter().map(encode).collect();
        let affected = sqlx::query(
            "DELETE FROM cosmos_contact_encrypted \
              WHERE principal = $1 AND ciphertext = ANY($2::bytea[])",
        )
        .bind(principal)
        .bind(&ciphertexts)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected as usize)
    }

    async fn contacts(&self, principal: &str) -> Written<ContactSnapshot> {
        let mut snapshot = ContactSnapshot::default();

        // Every read below propagates. Swallowing them (`if let Ok(rows)`) made a
        // database outage indistinguishable from an empty address book: the pin
        // would render the wearer's contacts as gone AND get `latest = None`, so
        // the next delta sync had no cursor to resume from either.
        // Last write last, so every read between two writes lists the same
        // sequence (`ContactSnapshot::contacts`). Heap order is not an order.
        let rows = sqlx::query(
            "SELECT contact, modified_seconds, modified_nanos FROM cosmos_contact \
             WHERE principal = $1 ORDER BY modified_seconds, modified_nanos, id",
        )
        .bind(principal)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        for row in rows {
            let bytes: Vec<u8> = row.get("contact");
            if let Some(contact) = decode::<pb::Contact>(&bytes) {
                snapshot.contacts.push(ContactRecord {
                    contact,
                    modified: SyncTime::from_parts(
                        row.get("modified_seconds"),
                        row.get("modified_nanos"),
                    ),
                });
            }
        }

        let rows = sqlx::query(
            "SELECT ciphertext, version, modified_seconds, modified_nanos \
             FROM cosmos_contact_encrypted WHERE principal = $1 \
             ORDER BY modified_seconds, modified_nanos, ciphertext",
        )
        .bind(principal)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        for row in rows {
            let bytes: Vec<u8> = row.get("ciphertext");
            if let Some(data) = decode::<EncryptedData>(&bytes) {
                snapshot.encrypted.push(EncryptedContactRecord {
                    data,
                    version: row.get("version"),
                    modified: SyncTime::from_parts(
                        row.get("modified_seconds"),
                        row.get("modified_nanos"),
                    ),
                });
            }
        }

        let rows = sqlx::query(
            "SELECT id, deleted_seconds, deleted_nanos FROM cosmos_contact_tombstone \
             WHERE principal = $1 ORDER BY id",
        )
        .bind(principal)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        for row in rows {
            snapshot.deletions.push(DeletionRecord {
                id: row.get("id"),
                deleted: SyncTime::from_parts(row.get("deleted_seconds"), row.get("deleted_nanos")),
            });
        }

        // The high-water mark across everything this principal holds. A principal
        // with nothing stored gets `None`, never a fabricated sync point.
        snapshot.latest = snapshot
            .contacts
            .iter()
            .map(|c| c.modified)
            .chain(snapshot.encrypted.iter().map(|e| e.modified))
            .chain(snapshot.deletions.iter().map(|d| d.deleted))
            .max();
        Ok(snapshot)
    }

    async fn create_memory(&self, principal: &str, new: NewMemory) -> Written<MemoryRecord> {
        let device_local_id = new.device_local_id.clone();
        let record = self.insert_memory(principal, new).await?;
        // After the capture exists, never before: clearing first would hide a
        // capture the Pin still holds if the insert then failed. A failure here
        // is reported so the device retries, and the retry lands on
        // `insert_memory`'s idempotent path and clears it then.
        //
        // Under the principal's pending-create lock, which a declaration also
        // takes. Without it a declaration whose statement snapshot predated the
        // capture's commit could commit its row after this DELETE had already
        // run, leaving the capture listed as waiting for good. With it, either
        // the declaration committed first and this DELETE sees its row, or this
        // ran first and the declaration's snapshot, taken after the lock, sees
        // the capture and records nothing.
        if !device_local_id.is_empty() {
            let mut tx = self
                .pool
                .begin()
                .await
                .map_err(|_| StoreError::Unavailable)?;
            lock_pending_creates(&mut tx, principal).await?;
            sqlx::query(
                "DELETE FROM cosmos_pending_memory_create \
                 WHERE principal = $1 AND device_local_id = $2",
            )
            .bind(principal)
            .bind(&device_local_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| StoreError::Unavailable)?;
            tx.commit().await.map_err(|_| StoreError::Unavailable)?;
        }
        Ok(record)
    }

    async fn memory(&self, principal: &str, uuid_or_id: &str) -> Written<Option<MemoryRecord>> {
        // `.ok().flatten()` collapsed an outage into "no such capture", which the
        // upload worker treats as FATAL (`STATUS_MEMORY_NOT_FOUND` falls to its
        // `default:` arm) and never retries.
        let Some(row) = sqlx::query(
            "SELECT * FROM cosmos_memory WHERE principal = $1 \
             AND (uuid = $2 OR numeric_id::text = $2) AND deleted_seconds IS NULL",
        )
        .bind(principal)
        .bind(uuid_or_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        else {
            return Ok(None);
        };

        // One decoder for both read paths. This used to be a second, divergent
        // copy of [`memory_from_row`], same comment above it, and the copy that
        // silently dropped a corrupt frame instead of reporting it.
        memory_from_row(&row).map(Some)
    }

    async fn memory_page(
        &self,
        principal: &str,
        kinds: &[MemoryKind],
        only_favorited: bool,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<MemorySummary>> {
        // Two statements rather than `COUNT(*) OVER ()` on one: the window
        // function is evaluated before LIMIT, so it is correct, except for a
        // page past the end, which returns no rows at all and would therefore
        // report a total of zero. The envelope has to stay honest about how many
        // rows exist even on an empty final page.
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM cosmos_memory \
             WHERE principal = $1 AND deleted_seconds IS NULL \
               AND ($2::smallint[] IS NULL OR kind = ANY($2)) \
               AND (NOT $3 OR favorite)",
        )
        .bind(principal)
        .bind(kind_filter(kinds))
        .bind(only_favorited)
        .fetch_one(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        if limit <= 0 {
            return Ok(StorePage {
                records: Vec::new(),
                total,
            });
        }

        // The index columns only: `thumbnails` is where a capture's megabytes
        // live and nothing on this page renders them.
        let sql = format!(
            "SELECT uuid, numeric_id, device_local_id, kind, \
                    created_seconds, created_nanos, \
                    device_created_seconds, device_created_nanos, \
                    upload_complete, bursts, \
                    (encrypted_location IS NOT NULL) AS has_location, \
                    {THUMBNAIL_COUNT_EXPRESSION} AS thumbnail_count, \
                    favorite, tags, upload_state, total_video_duration_sec \
               FROM cosmos_memory \
              WHERE principal = $1 AND deleted_seconds IS NULL \
                AND ($2::smallint[] IS NULL OR kind = ANY($2)) \
                AND (NOT $3 OR favorite) \
              ORDER BY COALESCE(device_created_seconds, created_seconds) DESC, numeric_id DESC \
              LIMIT $4 OFFSET $5"
        );
        let rows = sqlx::query(&sql)
            .bind(principal)
            .bind(kind_filter(kinds))
            .bind(only_favorited)
            .bind(limit)
            .bind(offset.max(0))
            .fetch_all(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)?;

        let records = rows
            .iter()
            .map(memory_summary_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(StorePage { records, total })
    }

    async fn count_memories(&self, principal: &str, kinds: &[MemoryKind]) -> Written<i64> {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM cosmos_memory \
             WHERE principal = $1 AND deleted_seconds IS NULL \
               AND ($2::smallint[] IS NULL OR kind = ANY($2))",
        )
        .bind(principal)
        .bind(kind_filter(kinds))
        .fetch_one(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)
    }

    async fn memory_thumbnail(
        &self,
        principal: &str,
        uuid_or_id: &str,
        index: usize,
    ) -> Written<Option<EncryptedData>> {
        // `->> $3` extracts ONE element of the stored array as text, so the
        // server returns a single frame rather than the whole burst. It is the
        // one place the JSON-of-integers column layout is read selectively.
        let Ok(ordinal) = i32::try_from(index) else {
            // No capture can hold that many frames, so this is absence, not an
            // outage, and it must not become a negative jsonb subscript, which
            // Postgres reads as counting back from the end.
            return Ok(None);
        };
        let frame: Option<Option<String>> = sqlx::query_scalar(
            "SELECT CASE \
                      WHEN thumbnails IS NULL OR octet_length(thumbnails) < 2 THEN NULL \
                      ELSE (convert_from(thumbnails, 'UTF8')::jsonb -> $3)::text \
                    END \
               FROM cosmos_memory \
              WHERE principal = $1 AND (uuid = $2 OR numeric_id::text = $2) \
                AND deleted_seconds IS NULL",
        )
        .bind(principal)
        .bind(uuid_or_id)
        .bind(ordinal)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;

        // Outer `None`: no such capture. Inner `None`: the capture has no such
        // frame. Both are the same answer to the caller.
        let Some(Some(frame)) = frame else {
            return Ok(None);
        };
        // The element is a JSON array of byte values, the same shape the whole
        // column decodes as, one row of it.
        let bytes: Vec<u8> = serde_json::from_str(&frame).map_err(|_| StoreError::Unavailable)?;
        decode_or_corrupt(&bytes).map(Some).inspect_err(|_| {
            tracing::warn!(
                index,
                "stored thumbnail blob failed to decode; refusing to serve it as absent"
            );
        })
    }

    async fn delete_memory(&self, principal: &str, uuid_or_id: &str) -> Written<bool> {
        let now = SyncTime::now();
        // `unwrap_or(false)` here used to turn a database outage into "no such
        // capture", which the device reads as a settled delete.
        let affected = sqlx::query(
            "UPDATE cosmos_memory SET deleted_seconds = $3, deleted_nanos = $4 \
             WHERE principal = $1 AND (uuid = $2 OR numeric_id::text = $2) \
             AND deleted_seconds IS NULL",
        )
        .bind(principal)
        .bind(uuid_or_id)
        .bind(now.seconds())
        .bind(now.nanos())
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected > 0)
    }

    async fn record_upload_state(
        &self,
        principal: &str,
        uuid_or_id: &str,
        state: UploadState,
    ) -> Written<bool> {
        let affected = sqlx::query(
            "UPDATE cosmos_memory SET upload_state = $3, upload_complete = $4 \
             WHERE principal = $1 AND (uuid = $2 OR numeric_id::text = $2) \
             AND deleted_seconds IS NULL",
        )
        .bind(principal)
        .bind(uuid_or_id)
        .bind(state.as_str())
        .bind(state == UploadState::Complete)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected > 0)
    }

    async fn set_memory_favorite(
        &self,
        principal: &str,
        uuids_or_ids: &[String],
        favorite: bool,
    ) -> Written<usize> {
        let affected = sqlx::query(
            "UPDATE cosmos_memory SET favorite = $3 \
             WHERE principal = $1 AND deleted_seconds IS NULL \
               AND (uuid = ANY($2::text[]) OR numeric_id::text = ANY($2::text[]))",
        )
        .bind(principal)
        .bind(uuids_or_ids)
        .bind(favorite)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected as usize)
    }

    async fn add_memory_tag(&self, principal: &str, uuid_or_id: &str, tag: &str) -> Written<bool> {
        let affected = sqlx::query(
            "UPDATE cosmos_memory \
                SET tags = CASE WHEN $3::text = ANY(tags) THEN tags \
                                ELSE array_append(tags, $3::text) END \
              WHERE principal = $1 AND (uuid = $2 OR numeric_id::text = $2) \
                AND deleted_seconds IS NULL",
        )
        .bind(principal)
        .bind(uuid_or_id)
        .bind(tag)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected > 0)
    }

    async fn remove_memory_tag(
        &self,
        principal: &str,
        uuid_or_id: &str,
        tag: &str,
    ) -> Written<bool> {
        let affected = sqlx::query(
            "UPDATE cosmos_memory SET tags = array_remove(tags, $3::text) \
              WHERE principal = $1 AND (uuid = $2 OR numeric_id::text = $2) \
                AND deleted_seconds IS NULL",
        )
        .bind(principal)
        .bind(uuid_or_id)
        .bind(tag)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected > 0)
    }

    async fn declare_pending_memory_create(
        &self,
        principal: &str,
        pending: &PendingMemoryCreate,
    ) -> Written<()> {
        // Under the lock `create_memory` takes to clear a declaration (see
        // there), so the capture check below and that clear cannot interleave.
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| StoreError::Unavailable)?;
        lock_pending_creates(&mut tx, principal).await?;
        // One statement, so a `CreateMemory` that already landed is seen: an
        // intent arriving after its capture records nothing (see the trait).
        sqlx::query(
            "INSERT INTO cosmos_pending_memory_create
                (principal, device_local_id, memory_type, delay_reason,
                 declared_seconds, declared_nanos)
             SELECT $1::text, $2::text, $3::integer, $4::integer, $5::bigint, $6::integer
              WHERE $2::text = '' OR NOT EXISTS (
                    SELECT 1 FROM cosmos_memory
                     WHERE principal = $1 AND device_local_id = $2
                       AND deleted_seconds IS NULL)
             ON CONFLICT (principal, device_local_id) DO UPDATE SET
                memory_type = EXCLUDED.memory_type,
                delay_reason = EXCLUDED.delay_reason,
                declared_seconds = EXCLUDED.declared_seconds,
                declared_nanos = EXCLUDED.declared_nanos",
        )
        .bind(principal)
        .bind(&pending.device_local_id)
        .bind(pending.memory_type)
        .bind(pending.delay_reason)
        .bind(pending.declared.seconds())
        .bind(pending.declared.nanos())
        .execute(&mut *tx)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        // Keep the newest `MAX_PENDING_MEMORY_CREATES`, in the order
        // `pending_memory_creates` reads them.
        sqlx::query(
            "DELETE FROM cosmos_pending_memory_create
              WHERE principal = $1 AND device_local_id IN (
                    SELECT device_local_id FROM cosmos_pending_memory_create
                     WHERE principal = $1
                     ORDER BY declared_seconds DESC, declared_nanos DESC, device_local_id DESC
                    OFFSET $2)",
        )
        .bind(principal)
        .bind(MAX_PENDING_MEMORY_CREATES as i64)
        .execute(&mut *tx)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        tx.commit().await.map_err(|_| StoreError::Unavailable)?;
        Ok(())
    }

    async fn pending_memory_creates(&self, principal: &str) -> Written<Vec<PendingMemoryCreate>> {
        let rows = sqlx::query(
            "SELECT device_local_id, memory_type, delay_reason, declared_seconds, declared_nanos \
               FROM cosmos_pending_memory_create WHERE principal = $1 \
              ORDER BY declared_seconds DESC, declared_nanos DESC, device_local_id DESC",
        )
        .bind(principal)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(rows
            .into_iter()
            .map(|row| PendingMemoryCreate {
                device_local_id: row.get("device_local_id"),
                memory_type: row.get("memory_type"),
                delay_reason: row.get("delay_reason"),
                declared: SyncTime::from_parts(
                    row.get("declared_seconds"),
                    row.get("declared_nanos"),
                ),
            })
            .collect())
    }

    async fn delete_all_pending_memory_creates(&self, principal: &str) -> Written<usize> {
        let affected = sqlx::query("DELETE FROM cosmos_pending_memory_create WHERE principal = $1")
            .bind(principal)
            .execute(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)?
            .rows_affected();
        Ok(affected as usize)
    }

    async fn create_note(&self, principal: &str, new: NewNote) -> Written<NoteRecord> {
        let record = NoteRecord::from_new(new, SyncTime::now());
        // `let _ = ...` here meant the handler acked CREATE_SUCCESS with a uuid
        // for a row that was never written, and the device keeps no copy of the
        // note to retry from, so the wearer's note was simply gone.
        sqlx::query(
            "INSERT INTO cosmos_note
                (principal, uuid, indexed_text, encrypted_note, encrypted_location,
                 created_seconds, created_nanos, source, title, body,
                 modified_seconds, modified_nanos, time_zone, location, tags)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        )
        .bind(principal)
        .bind(&record.uuid)
        .bind(record.indexed_text.as_deref())
        .bind(record.encrypted_note.as_ref().map(encode))
        .bind(record.encrypted_location.as_ref().map(encode))
        .bind(record.created.seconds())
        .bind(record.created.nanos())
        .bind(record.source.map(NoteSource::as_str))
        .bind(record.title.as_deref())
        .bind(record.body.as_deref())
        .bind(record.modified.map(|t| t.seconds()))
        .bind(record.modified.map(|t| t.nanos()))
        .bind(record.time_zone.as_deref())
        .bind(record.location.as_ref().map(encode))
        .bind(&record.tags)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(record)
    }

    async fn note(&self, principal: &str, uuid: &str) -> Written<Option<NoteRecord>> {
        // `(principal, uuid)` is the primary key: one indexed row, never a page.
        let row = sqlx::query(&format!(
            "SELECT {NOTE_COLUMNS} FROM cosmos_note WHERE principal = $1 AND uuid = $2"
        ))
        .bind(principal)
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(row.map(note_from_row))
    }

    async fn update_note(
        &self,
        principal: &str,
        uuid: &str,
        title: Option<&str>,
        body: &str,
    ) -> Written<Option<NoteRecord>> {
        let modified = SyncTime::now();
        let row = sqlx::query(&format!(
            "UPDATE cosmos_note SET title = $3, body = $4, indexed_text = $5, \
                    modified_seconds = $6, modified_nanos = $7 \
              WHERE principal = $1 AND uuid = $2 \
             RETURNING {NOTE_COLUMNS}"
        ))
        .bind(principal)
        .bind(uuid)
        .bind(title)
        .bind(body)
        .bind(crate::store::note_index(title, Some(body)))
        .bind(modified.seconds())
        .bind(modified.nanos())
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(row.map(note_from_row))
    }

    async fn recent_notes(
        &self,
        principal: &str,
        max_items: i32,
        start: Option<SyncTime>,
        end: Option<SyncTime>,
    ) -> Written<Vec<NoteRecord>> {
        // `LIMIT` is bound rather than applied in Rust afterwards, for exactly
        // the reason `query_events` gives, and this read is worse placed than
        // that one. It sat on the assistant's latency path with no bound in SQL
        // at all: `wearer_facts` calls it on EVERY turn the wearer speaks (not
        // only recall turns) and recall calls it again, so a wearer with twenty
        // thousand notes had all twenty thousand rows shipped, every
        // `encrypted_note` and `encrypted_location` BYTEA with them, and every
        // one of those blobs prost-decoded, to keep sixty-four of them and
        // throw the rest away in `truncate`. The cost grew for the life of the
        // account, which is the very regression `NOTE_SCAN_LIMIT` was added to
        // fix at the caller while the store kept fetching the whole table.
        //
        // `cosmos_note_recent` (migrations/0004_listing.sql) covers this order,
        // so the bound stops the scan rather than merely trimming a materialised
        // sort. The columns are named explicitly, in place of the star this
        // statement used to contain, so it asks for exactly what `note_from_row`
        // reads and nothing else, `principal` was being shipped back on every
        // row to a caller that already knew it. Non-positive `max_items`
        // still means unbounded, per the `Store` contract, spelled as
        // `i64::MAX`, the same way `query_events` spells it.
        let rows = sqlx::query(&format!(
            "SELECT {NOTE_COLUMNS}
               FROM cosmos_note WHERE principal = $1
               AND ($2::bigint IS NULL OR created_seconds >= $2)
               AND ($3::bigint IS NULL OR created_seconds <= $3)
             ORDER BY created_seconds DESC, created_nanos DESC
             LIMIT $4"
        ))
        .bind(principal)
        .bind(start.map(|t| t.seconds()))
        .bind(end.map(|t| t.seconds()))
        .bind(if max_items > 0 {
            i64::from(max_items)
        } else {
            i64::MAX
        })
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;

        let mut notes: Vec<NoteRecord> = rows.into_iter().map(note_from_row).collect();
        // A no-op now that the bound is in the statement. Kept because the trait
        // contract is stated in terms of the returned vector, and a reader who
        // changes the SQL should find the contract still enforced here.
        if max_items > 0 {
            notes.truncate(max_items as usize);
        }
        Ok(notes)
    }

    async fn note_page(
        &self,
        principal: &str,
        query: Option<&str>,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<NoteRecord>> {
        // The index is lowercase, so a lowercased needle is a case-insensitive
        // match. `strpos` rather than LIKE so a `%` or `_` the wearer typed is
        // text, not a wildcard. A NULL index never matches.
        let needle = query
            .map(|query| query.trim().to_lowercase())
            .filter(|query| !query.is_empty());
        // Counted separately for the same reason as `memory_page`: a window past
        // the end returns no rows and still has to report the true total.
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM cosmos_note WHERE principal = $1 \
               AND ($2::text IS NULL OR strpos(indexed_text, $2) > 0)",
        )
        .bind(principal)
        .bind(needle.as_deref())
        .fetch_one(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        if limit <= 0 {
            return Ok(StorePage {
                records: Vec::new(),
                total,
            });
        }
        let rows = sqlx::query(&format!(
            "SELECT {NOTE_COLUMNS} \
               FROM cosmos_note WHERE principal = $1 \
                AND ($2::text IS NULL OR strpos(indexed_text, $2) > 0) \
              ORDER BY created_seconds DESC, created_nanos DESC, uuid DESC \
              LIMIT $3 OFFSET $4"
        ))
        .bind(principal)
        .bind(needle.as_deref())
        .bind(limit)
        .bind(offset.max(0))
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;

        let records = rows.into_iter().map(note_from_row).collect();
        Ok(StorePage { records, total })
    }

    async fn count_notes(&self, principal: &str) -> Written<i64> {
        sqlx::query_scalar("SELECT COUNT(*) FROM cosmos_note WHERE principal = $1")
            .bind(principal)
            .fetch_one(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)
    }

    async fn delete_all_notes(&self, principal: &str) -> Written<usize> {
        // `unwrap_or(0)` reported a failed erasure as "there was nothing to
        // erase", the wearer asked for a deletion and would be told it happened.
        let affected = sqlx::query("DELETE FROM cosmos_note WHERE principal = $1")
            .bind(principal)
            .execute(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)?
            .rows_affected();
        Ok(affected as usize)
    }

    async fn delete_note(&self, principal: &str, uuid: &str) -> Written<bool> {
        // `principal` is half the primary key, so another account's uuid matches
        // no row and the statement's own row count is the answer, no separate
        // SELECT to race against, the same shape `delete_contacts` uses.
        let affected = sqlx::query("DELETE FROM cosmos_note WHERE principal = $1 AND uuid = $2")
            .bind(principal)
            .bind(uuid)
            .execute(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)?
            .rows_affected();
        // Propagated, never `unwrap_or(false)`: a failed delete rendered as
        // "there was nothing to delete" tells the wearer a row they asked to
        // erase is gone while it is still stored.
        Ok(affected > 0)
    }

    async fn index_note(&self, principal: &str, uuid: &str, plaintext: &str) {
        // Best-effort by contract (see the trait doc), but not silent. A note
        // that fails to index is unsearchable forever, and `recall_memory` then
        // tells the wearer nothing matches a note they definitely saved.
        if let Err(error) = sqlx::query(
            "UPDATE cosmos_note SET indexed_text = $3 WHERE principal = $1 AND uuid = $2",
        )
        .bind(principal)
        .bind(uuid)
        .bind(plaintext.to_lowercase())
        .execute(&self.pool)
        .await
        {
            tracing::warn!(%error, "indexing a note failed; it will not be searchable");
        }
    }

    async fn search_notes(
        &self,
        principal: &str,
        query: &str,
        max_results: i32,
    ) -> Written<Vec<String>> {
        // How many rows may be shipped for scoring. The score is computed in
        // Rust, so SQL cannot rank: the bound is a candidate window, newest
        // first, and scoring plus truncation happen below exactly as the
        // in-memory store does them. A window of `max_results` rows would be
        // wrong twice, non-matching newer notes would crowd matching older
        // ones out of recall entirely, the same ranked-out-before-scoring bug
        // that moved `recall`'s date window ahead of its search, so the window
        // is one ceiling for every caller instead. It sits far above any
        // caller's own truncation (the assistant keeps five) while capping the
        // read that used to ship every indexed note's full `indexed_text`, the
        // exact cost `recent_notes` paid and paid for with a `LIMIT`. A wearer
        // with more notes than the ceiling can have a match fall outside it;
        // every history under it ranks in full, identically to the in-memory
        // store.
        const CANDIDATE_CEILING: i64 = 4_096;
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        // Lexical term overlap through the one recall matcher the in-memory
        // store uses (`recall_hits`: stopwords dropped, inflections matched),
        // so both backends find and rank the same notes. This deployment hosts
        // no embedding model, and claiming semantic ranking we do not perform
        // would misrepresent the order.
        let rows = sqlx::query(
            "SELECT uuid, indexed_text, created_seconds, created_nanos FROM cosmos_note \
             WHERE principal = $1 AND indexed_text IS NOT NULL \
             ORDER BY created_seconds DESC, created_nanos DESC \
             LIMIT $2",
        )
        .bind(principal)
        .bind(CANDIDATE_CEILING)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;

        let mut scored: Vec<(usize, String)> = rows
            .into_iter()
            .filter_map(|row| {
                let text: Option<String> = row.get("indexed_text");
                let text = text?;
                let hits = crate::store::recall_hits(&needle, &text);
                (hits > 0).then(|| (hits, row.get::<String, _>("uuid")))
            })
            .collect();
        // Most matching terms first. The sort is stable over rows that arrive
        // newest first, so equal scores stay most recent first.
        scored.sort_by(|a, b| b.0.cmp(&a.0));
        let mut uuids: Vec<String> = scored.into_iter().map(|(_, u)| u).collect();
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
        let limit = i64::try_from(maximum).unwrap_or(i64::MAX);
        let rows = sqlx::query(
            "SELECT uuid, indexed_text FROM cosmos_note \
             WHERE principal = $1 AND indexed_text IS NOT NULL \
             ORDER BY created_seconds DESC, created_nanos DESC LIMIT $2",
        )
        .bind(principal)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                Some(SearchableNote {
                    uuid: row.get("uuid"),
                    text: row.get::<Option<String>, _>("indexed_text")?,
                })
            })
            .collect())
    }

    /// Upsert the whole batch in multi-row statements inside one transaction.
    ///
    /// This was one INSERT round trip per event against a batch the device does
    /// not bound, under a 35-second client deadline it re-sends the entire
    /// history past, see [`crate::store::INGEST_CHUNK`] for why that cannot
    /// converge. Semantics are unchanged: idempotent on `event_identifier`,
    /// empty identifiers dropped, last writer wins.
    async fn ingest_events(
        &self,
        principal: &str,
        events: &[NotableEventRecord],
    ) -> Written<Vec<String>> {
        let batch = crate::store::collapse_ingest_batch(events);
        if batch.is_empty() {
            return Ok(Vec::new());
        }

        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| StoreError::Unavailable)?;
        for chunk in batch.chunks(crate::store::INGEST_CHUNK) {
            let mut builder = sqlx::QueryBuilder::new(
                "INSERT INTO cosmos_event
                    (principal, event_identifier, originator_identifier, creation_seconds,
                     creation_nanos, event_type, event_data, encrypted_event_data,
                     encrypted_location, device_is_locked, indexed_text,
                     ingested_seconds, ingested_nanos) ",
            );
            builder.push_values(chunk, |mut row, (identifier, incoming)| {
                row.push_bind(principal)
                    .push_bind(*identifier)
                    .push_bind(incoming.originator_identifier.as_str())
                    .push_bind(incoming.creation_time.map(|t| t.seconds()))
                    .push_bind(incoming.creation_time.map(|t| t.nanos()))
                    .push_bind(incoming.event_type.as_str())
                    .push_bind(incoming.event_data.as_ref().map(encode))
                    .push_bind(incoming.encrypted_event_data.as_ref().map(encode))
                    .push_bind(incoming.encrypted_location.as_ref().map(encode))
                    .push_bind(incoming.device_is_locked)
                    .push_bind(incoming.indexed_text.as_deref())
                    .push_bind(incoming.ingested.seconds())
                    .push_bind(incoming.ingested.nanos());
            });
            // Correct only because `collapse_ingest_batch` removed within-batch
            // duplicates: PostgreSQL rejects an ON CONFLICT DO UPDATE whose own
            // rows collide.
            builder.push(
                " ON CONFLICT (principal, event_identifier) DO UPDATE SET
                    originator_identifier = EXCLUDED.originator_identifier,
                    creation_seconds = EXCLUDED.creation_seconds,
                    creation_nanos = EXCLUDED.creation_nanos,
                    event_type = EXCLUDED.event_type,
                    event_data = EXCLUDED.event_data,
                    encrypted_event_data = EXCLUDED.encrypted_event_data,
                    encrypted_location = COALESCE(EXCLUDED.encrypted_location, cosmos_event.encrypted_location),
                    device_is_locked = EXCLUDED.device_is_locked,
                    indexed_text = COALESCE(EXCLUDED.indexed_text, cosmos_event.indexed_text),
                    ingested_seconds = EXCLUDED.ingested_seconds,
                    ingested_nanos = EXCLUDED.ingested_nanos",
            );
            builder
                .build()
                .execute(&mut *tx)
                .await
                .map_err(|_| StoreError::Unavailable)?;
        }
        // Only acknowledge identifiers that actually landed: an uncommitted
        // batch is not stored, and the device must re-send rather than believe
        // us and clear its `needs_sync` flags.
        tx.commit().await.map_err(|_| StoreError::Unavailable)?;

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
        if indexes.is_empty() {
            return Ok(0);
        }
        let identifiers: Vec<&str> = indexes
            .iter()
            .map(|index| index.event_identifier.as_str())
            .collect();
        let texts: Vec<&str> = indexes
            .iter()
            .map(|index| index.indexed_text.as_str())
            .collect();
        // An UPDATE, never the ingest upsert: a row forgotten since the read
        // matches nothing here, so it cannot come back.
        let affected = sqlx::query(
            "UPDATE cosmos_event AS event SET indexed_text = backfill.indexed_text
               FROM UNNEST($2::text[], $3::text[]) AS backfill(event_identifier, indexed_text)
              WHERE event.principal = $1
                AND event.event_identifier = backfill.event_identifier
                AND event.indexed_text IS NULL",
        )
        .bind(principal)
        .bind(&identifiers)
        .bind(&texts)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected as usize)
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
        // An empty filter matches everything. A set one is an exact match.
        //
        // `LIMIT` is bound rather than applied in Rust afterwards, matching
        // `memory_page`. Truncating after the fact meant every QueryEvents
        // read, decoded and sorted the wearer's WHOLE event partition to return
        // the twenty rows asked for, and Center issues four of these per My
        // Data refresh, every five seconds, including in a background tab. The
        // explicit column list replaces `SELECT *` so the statement asks for
        // exactly what the decoder below reads.
        let rows = sqlx::query(
            "SELECT event_identifier, originator_identifier, creation_seconds, creation_nanos,
                    event_type, event_data, encrypted_event_data, encrypted_location,
                    device_is_locked, indexed_text, ingested_seconds, ingested_nanos
               FROM cosmos_event WHERE principal = $1
               AND ($2 = '' OR event_type = $2)
               AND ($3 = '' OR originator_identifier = $3)
               AND ($4::bigint IS NULL OR creation_seconds >= $4)
               AND ($5::bigint IS NULL OR creation_seconds <= $5)
             ORDER BY creation_seconds DESC NULLS LAST, creation_nanos DESC
             LIMIT $6",
        )
        .bind(principal)
        .bind(event_type)
        .bind(originator)
        .bind(start.map(|t| t.seconds()))
        .bind(end.map(|t| t.seconds()))
        .bind(if max_results > 0 {
            i64::from(max_results)
        } else {
            i64::MAX
        })
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;

        let found: Vec<NotableEventRecord> = rows.into_iter().map(event_from_row).collect();
        Ok(found)
    }

    async fn delete_event(&self, principal: &str, event_identifier: &str) -> Written<bool> {
        // `(principal, event_identifier)` is the primary key, the same key
        // `ingest_events` upserts on, so this deletes at most one row and only
        // ever one belonging to the caller. The vote on it goes in the same
        // transaction, so a forgotten event never leaves its rating behind.
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| StoreError::Unavailable)?;
        let affected =
            sqlx::query("DELETE FROM cosmos_event WHERE principal = $1 AND event_identifier = $2")
                .bind(principal)
                .bind(event_identifier)
                .execute(&mut *tx)
                .await
                .map_err(|_| StoreError::Unavailable)?
                .rows_affected();
        sqlx::query(
            "DELETE FROM cosmos_event_feedback WHERE principal = $1 AND event_identifier = $2",
        )
        .bind(principal)
        .bind(event_identifier)
        .execute(&mut *tx)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        tx.commit().await.map_err(|_| StoreError::Unavailable)?;
        Ok(affected > 0)
    }

    async fn query_event_page(
        &self,
        principal: &str,
        filter: &EventFilter,
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<NotableEventRecord>> {
        let total = self.count_events(principal, filter).await?;
        if limit <= 0 {
            return Ok(StorePage {
                records: Vec::new(),
                total,
            });
        }
        // The exact inverse of each other, and the same total order the
        // in-memory store sorts by (`store::event_order`), so a page boundary
        // never drops or repeats a row.
        let order = if filter.oldest_first {
            "creation_seconds ASC NULLS FIRST, creation_nanos ASC NULLS FIRST, \
             event_identifier ASC"
        } else {
            "creation_seconds DESC NULLS LAST, creation_nanos DESC NULLS LAST, \
             event_identifier DESC"
        };
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM cosmos_event WHERE {EVENT_FILTER_SQL} \
             ORDER BY {order} LIMIT $7 OFFSET $8"
        );
        let rows = bind_event_filter(sqlx::query(&sql), principal, filter)
            .bind(limit)
            .bind(offset.max(0))
            .fetch_all(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)?;
        Ok(StorePage {
            records: rows.into_iter().map(event_from_row).collect(),
            total,
        })
    }

    async fn count_events(&self, principal: &str, filter: &EventFilter) -> Written<i64> {
        let sql = format!("SELECT COUNT(*) AS total FROM cosmos_event WHERE {EVENT_FILTER_SQL}");
        let row = bind_event_filter(sqlx::query(&sql), principal, filter)
            .fetch_one(&self.pool)
            .await
            .map_err(|_| StoreError::Unavailable)?;
        Ok(row.get("total"))
    }

    async fn put_event_feedback(
        &self,
        principal: &str,
        event_identifier: &str,
        vote: EventVote,
    ) -> Written<bool> {
        // The vote lands only beside an event this principal holds, in one
        // statement, so another account's identifier cannot plant a row.
        let now = SyncTime::now();
        let affected = sqlx::query(
            "INSERT INTO cosmos_event_feedback
                (principal, event_identifier, vote, updated_seconds, updated_nanos)
             SELECT $1::text, $2::text, $3::smallint, $4::bigint, $5::integer
              WHERE EXISTS (SELECT 1 FROM cosmos_event
                             WHERE principal = $1 AND event_identifier = $2)
             ON CONFLICT (principal, event_identifier) DO UPDATE SET
                vote = EXCLUDED.vote,
                updated_seconds = EXCLUDED.updated_seconds,
                updated_nanos = EXCLUDED.updated_nanos",
        )
        .bind(principal)
        .bind(event_identifier)
        .bind(vote.as_i16())
        .bind(now.seconds())
        .bind(now.nanos())
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected > 0)
    }

    async fn delete_event_feedback(
        &self,
        principal: &str,
        event_identifier: &str,
    ) -> Written<bool> {
        let affected = sqlx::query(
            "DELETE FROM cosmos_event_feedback WHERE principal = $1 AND event_identifier = $2",
        )
        .bind(principal)
        .bind(event_identifier)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected > 0)
    }

    async fn event_feedback(
        &self,
        principal: &str,
        event_identifiers: &[String],
    ) -> Written<HashMap<String, EventVote>> {
        let rows = sqlx::query(
            "SELECT event_identifier, vote FROM cosmos_event_feedback \
              WHERE principal = $1 AND event_identifier = ANY($2::text[])",
        )
        .bind(principal)
        .bind(event_identifiers)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                EventVote::from_i16(row.get("vote"))
                    .map(|vote| (row.get::<String, _>("event_identifier"), vote))
            })
            .collect())
    }

    /// Last writer wins for this `(principal, kind)`: a set RPC carries the
    /// wearer's whole list, and the proto gives its items no id to merge on.
    ///
    /// The error propagates. The handler acks by echoing the wearer's own blob
    /// back, which is indistinguishable from a successful write, so a swallowed
    /// failure here loses their allergies with nothing to indicate it.
    async fn put_account_blob(
        &self,
        principal: &str,
        kind: crate::store::AccountBlobKind,
        payload: &[u8],
    ) -> Written<()> {
        sqlx::query(
            "INSERT INTO cosmos_account_blob (principal, kind, payload) VALUES ($1, $2, $3)
             ON CONFLICT (principal, kind) DO UPDATE SET payload = EXCLUDED.payload",
        )
        .bind(principal)
        .bind(kind.as_str())
        .bind(payload)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(())
    }

    async fn get_account_blob(
        &self,
        principal: &str,
        kind: crate::store::AccountBlobKind,
    ) -> Written<Option<Vec<u8>>> {
        // Propagates for the same reason every other read here does: an outage
        // rendered as "nothing stored" is an empty allergy list, which the
        // assistant would plan meals against.
        let row = sqlx::query(
            "SELECT payload FROM cosmos_account_blob WHERE principal = $1 AND kind = $2",
        )
        .bind(principal)
        .bind(kind.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(row.map(|row| row.get::<Vec<u8>, _>("payload")))
    }

    async fn compare_and_swap_account_blob(
        &self,
        principal: &str,
        kind: crate::store::AccountBlobKind,
        expected: Option<&[u8]>,
        replacement: &[u8],
    ) -> Written<bool> {
        let affected = match expected {
            Some(expected) => {
                sqlx::query(
                    "UPDATE cosmos_account_blob SET payload = $4 \
                     WHERE principal = $1 AND kind = $2 AND payload = $3",
                )
                .bind(principal)
                .bind(kind.as_str())
                .bind(expected)
                .bind(replacement)
                .execute(&self.pool)
                .await
            }
            None => {
                sqlx::query(
                    "INSERT INTO cosmos_account_blob (principal, kind, payload) \
                     VALUES ($1, $2, $3) ON CONFLICT (principal, kind) DO NOTHING",
                )
                .bind(principal)
                .bind(kind.as_str())
                .bind(replacement)
                .execute(&self.pool)
                .await
            }
        }
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected == 1)
    }

    async fn purge_account(&self, principal: &str) -> Written<()> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| StoreError::Unavailable)?;
        for table in PRINCIPAL_TABLES {
            let statement = format!("DELETE FROM {table} WHERE principal = $1");
            sqlx::query(&statement)
                .bind(principal)
                .execute(&mut *tx)
                .await
                .map_err(|_| StoreError::Unavailable)?;
        }
        // Each Pin's status row is kept under `<principal>#device:<id>`
        // (`http/admin.rs` `device_status_storage_owner`).
        sqlx::query("DELETE FROM cosmos_account_blob WHERE starts_with(principal, $1)")
            .bind(format!("{principal}#device:"))
            .execute(&mut *tx)
            .await
            .map_err(|_| StoreError::Unavailable)?;
        tx.commit().await.map_err(|_| StoreError::Unavailable)
    }
}

/// Every table of this store keyed by the wearer's principal: what an account
/// deletion empties. `every_principal_table_is_purged` holds a new table to it.
const PRINCIPAL_TABLES: &[&str] = &[
    "cosmos_contact",
    "cosmos_contact_encrypted",
    "cosmos_contact_tombstone",
    "cosmos_memory",
    "cosmos_pending_memory_create",
    "cosmos_note",
    "cosmos_event",
    "cosmos_event_feedback",
    "cosmos_sync_cursor",
    "cosmos_account_blob",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn all_migrations() -> Vec<&'static EmbeddedMigration> {
        STORE_MIGRATIONS
            .iter()
            .chain(crate::enrollment::ENROLLMENT_MIGRATIONS)
            .chain(crate::keydirectory::KEY_DIRECTORY_MIGRATIONS)
            .collect()
    }

    fn first_sql_line(statement: &str) -> &str {
        statement
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with("--"))
            .expect("migration statement must contain SQL")
    }

    fn normalized_sql(statement: &str) -> String {
        statement
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("--"))
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_uppercase()
    }

    const GUARDED_KEY_DIRECTORY_BOUNDS: &str = concat!(
        "DO $$ BEGIN IF NOT EXISTS ( SELECT 1 FROM PG_CONSTRAINT ",
        "WHERE CONNAME = 'COSMOS_CHANNEL_KEY_SHAPE' ",
        "AND CONRELID = 'COSMOS_CHANNEL_KEY'::REGCLASS ) THEN ",
        "ALTER TABLE COSMOS_CHANNEL_KEY ",
        "ADD CONSTRAINT COSMOS_CHANNEL_KEY_SHAPE CHECK ( ",
        "OCTET_LENGTH(KID) BETWEEN 1 AND 1024 ",
        "AND OCTET_LENGTH(KEY) = 16 ); END IF; END $$;"
    );

    #[test]
    fn migrations_are_globally_numbered_and_append_only() {
        let migrations = all_migrations();
        let identity = migrations
            .iter()
            .map(|migration| (migration.version, migration.filename))
            .collect::<Vec<_>>();
        assert_eq!(
            identity,
            vec![
                (1, "0001_store.sql"),
                (4, "0004_listing.sql"),
                (5, "0005_device_status_namespacing.sql"),
                (7, "0007_consolidation.sql"),
                (2, "0002_enrollment.sql"),
                (8, "0008_account_passcode.sql"),
                (9, "0009_single_pin.sql"),
                (3, "0003_key_directory.sql"),
                (6, "0006_key_directory_bounds.sql"),
            ],
            "migration history is append-only; add a higher version rather than reordering it"
        );
        for migration in migrations {
            let prefix = migration
                .filename
                .split_once('_')
                .expect("migration filename must start with a numeric version")
                .0
                .parse::<u32>()
                .expect("migration filename version must be numeric");
            assert_eq!(prefix, migration.version);
        }
    }

    #[test]
    fn migration_advisory_lock_keys_remain_stable_and_distinct() {
        assert_eq!(SCHEMA_LOCK_KEY, 0x0CA2_2451_0000_0001);
        assert_eq!(
            crate::enrollment::ENROLLMENT_SCHEMA_LOCK_KEY,
            0x0CA2_2451_0000_0002
        );
        assert_ne!(
            SCHEMA_LOCK_KEY,
            crate::enrollment::ENROLLMENT_SCHEMA_LOCK_KEY
        );
        assert_eq!(
            crate::keydirectory::KEY_DIRECTORY_SCHEMA_LOCK_KEY,
            0x0CA2_2451_0000_0003
        );
        assert_ne!(
            SCHEMA_LOCK_KEY,
            crate::keydirectory::KEY_DIRECTORY_SCHEMA_LOCK_KEY
        );
        assert_ne!(
            crate::enrollment::ENROLLMENT_SCHEMA_LOCK_KEY,
            crate::keydirectory::KEY_DIRECTORY_SCHEMA_LOCK_KEY
        );
    }

    #[test]
    fn migration_parser_preserves_every_explicit_statement() {
        let expected_counts = [
            ("0001_store.sql", 12),
            ("0002_enrollment.sql", 6),
            ("0003_key_directory.sql", 1),
            ("0004_listing.sql", 4),
            ("0005_device_status_namespacing.sql", 1),
            ("0006_key_directory_bounds.sql", 1),
            ("0007_consolidation.sql", 5),
            ("0008_account_passcode.sql", 1),
            ("0009_single_pin.sql", 1),
        ];
        for migration in all_migrations() {
            let statements = migration.statements().collect::<Vec<_>>();
            let expected = expected_counts
                .iter()
                .find(|(filename, _)| *filename == migration.filename)
                .expect("every migration must have a frozen statement-count fixture")
                .1;
            assert_eq!(statements.len(), expected, "{}", migration.filename);
            assert_eq!(
                migration
                    .source()
                    .matches(MIGRATION_STATEMENT_MARKER)
                    .count(),
                statements.len(),
                "every statement must have one explicit separator"
            );
            assert!(
                statements.iter().all(|statement| statement.ends_with(';')),
                "each migration chunk remains directly executable SQL"
            );
        }
    }

    #[test]
    fn store_migration_order_matches_the_existing_startup_schema() {
        let signatures = STORE_MIGRATIONS
            .iter()
            .flat_map(EmbeddedMigration::statements)
            .map(first_sql_line)
            .collect::<Vec<_>>();
        assert_eq!(
            signatures,
            vec![
                "CREATE TABLE IF NOT EXISTS cosmos_contact (",
                "CREATE TABLE IF NOT EXISTS cosmos_contact_encrypted (",
                "CREATE TABLE IF NOT EXISTS cosmos_contact_tombstone (",
                "CREATE TABLE IF NOT EXISTS cosmos_memory (",
                "CREATE UNIQUE INDEX IF NOT EXISTS cosmos_memory_device_local",
                "CREATE TABLE IF NOT EXISTS cosmos_note (",
                "ALTER TABLE IF EXISTS cosmos_event",
                "CREATE TABLE IF NOT EXISTS cosmos_event (",
                "CREATE TABLE IF NOT EXISTS cosmos_sync_cursor (",
                "INSERT INTO cosmos_sync_cursor (principal, cursor_nanos)",
                "CREATE SEQUENCE IF NOT EXISTS cosmos_memory_id_seq;",
                "CREATE TABLE IF NOT EXISTS cosmos_account_blob (",
                "ALTER TABLE IF EXISTS cosmos_memory",
                "CREATE INDEX IF NOT EXISTS cosmos_event_recent",
                "CREATE INDEX IF NOT EXISTS cosmos_memory_recent",
                "CREATE INDEX IF NOT EXISTS cosmos_note_recent",
                "DELETE FROM cosmos_account_blob",
                "ALTER TABLE IF EXISTS cosmos_note",
                "ALTER TABLE IF EXISTS cosmos_memory",
                "CREATE TABLE IF NOT EXISTS cosmos_pending_memory_create (",
                "CREATE TABLE IF NOT EXISTS cosmos_event_feedback (",
                "CREATE INDEX IF NOT EXISTS cosmos_event_type_recent",
            ]
        );
    }

    #[test]
    fn every_migration_statement_is_restart_safe_and_non_destructive() {
        for migration in all_migrations() {
            for statement in migration.statements() {
                let sql = normalized_sql(statement);
                // A data removal is allowed only if it is on the reviewed list
                // VERBATIM. Membership is by exact normalized text, so editing a
                // listed statement, widening its predicate, say, puts it back
                // in front of this gate instead of inheriting the exemption.
                let reviewed_removal = REVIEWED_DATA_REMOVALS
                    .iter()
                    .any(|(filename, text)| *filename == migration.filename && *text == sql);
                assert!(
                    reviewed_removal
                        || ![" DROP ", " DELETE ", " TRUNCATE ", " UPDATE "]
                            .iter()
                            .any(|verb| format!(" {sql} ").contains(verb)),
                    "{} contains destructive SQL: {sql}",
                    migration.filename
                );
                let idempotent = reviewed_removal
                    || sql.starts_with("CREATE TABLE IF NOT EXISTS ")
                    || sql.starts_with("CREATE INDEX IF NOT EXISTS ")
                    || sql.starts_with("CREATE UNIQUE INDEX IF NOT EXISTS ")
                    || sql.starts_with("CREATE SEQUENCE IF NOT EXISTS ")
                    || (sql.starts_with("ALTER TABLE IF EXISTS ")
                        && sql.contains(" ADD COLUMN IF NOT EXISTS "))
                    || (sql.starts_with("INSERT INTO COSMOS_SYNC_CURSOR ")
                        && sql.ends_with("ON CONFLICT (PRINCIPAL) DO NOTHING;"))
                    // PostgreSQL 16 has no `ADD CONSTRAINT IF NOT EXISTS`.
                    // Accept only this frozen catalog-guarded statement, not a
                    // general DO block or a filename exemption. Any DDL change
                    // returns to review automatically.
                    || (migration.filename == "0006_key_directory_bounds.sql"
                        && sql == GUARDED_KEY_DIRECTORY_BOUNDS);
                assert!(
                    idempotent,
                    "{} has no explicit restart-safe form: {sql}",
                    migration.filename
                );
            }
        }
    }

    /// The reviewed list must stay a list of statements that EXIST, or it decays
    /// into a blanket exemption nobody notices is unused.
    #[test]
    fn every_reviewed_data_removal_is_still_in_the_migration_history() {
        for (filename, text) in REVIEWED_DATA_REMOVALS {
            let migration = all_migrations()
                .into_iter()
                .find(|migration| migration.filename == *filename)
                .unwrap_or_else(|| panic!("{filename} is on the reviewed list but not registered"));
            assert!(
                migration.statements().any(|s| normalized_sql(s) == *text),
                "{filename} no longer contains its reviewed removal verbatim"
            );
        }
    }

    /// The one removal this history performs must not be able to reach the kinds
    /// that are keyed by the bare principal ON PURPOSE, `privacy_settings` is
    /// written by `UpdateSettings` under exactly that key, and `push_tokens` /
    /// `push_queue` are per-wearer rather than per-device. A predicate widened to
    /// "any principal without `#device:`" would delete live wearer state.
    #[test]
    fn the_device_status_cleanup_cannot_reach_another_blob_kind() {
        let sql = REVIEWED_DATA_REMOVALS
            .iter()
            .find(|(filename, _)| *filename == "0005_device_status_namespacing.sql")
            .expect("the device-status cleanup is on the reviewed list")
            .1;
        assert!(
            sql.contains("KIND = 'DEVICE_STATUS'"),
            "the cleanup must stay pinned to one blob kind: {sql}"
        );
        assert!(
            sql.contains("STRPOS(PRINCIPAL, '#DEVICE:') = 0"),
            "the cleanup must spare the namespaced row it exists to leave behind: {sql}"
        );
    }

    /// A held-back removal is reported by the rows it would remove, so its
    /// count must select exactly the rows the reviewed statement deletes.
    #[test]
    fn a_held_back_removal_is_counted_by_its_own_predicate() {
        let removal = STORE_MIGRATIONS
            .iter()
            .flat_map(EmbeddedMigration::statements)
            .find(|statement| statement_removes_data(statement))
            .expect("the history holds the reviewed device-status removal");
        assert_eq!(
            removal_count_query(removal).as_deref(),
            Some(
                "SELECT COUNT(*) FROM cosmos_account_blob WHERE kind = 'device_status' \
                 AND strpos(principal, '#device:') = 0"
            )
        );
        assert_eq!(removal_count_query("DROP TABLE cosmos_note;"), None);
        assert_eq!(removal_count_query("TRUNCATE cosmos_note;"), None);
    }

    /// REGRESSION: every workload logged "holding back a reviewed data-removal
    /// statement" at every start, even on a fresh database where the removal
    /// matches nothing. The count is what decides whether there is anything to
    /// report, and holding back still removes nothing.
    #[tokio::test]
    async fn a_held_back_removal_reports_the_rows_it_would_remove_and_keeps_them() {
        let Some(store) = store().await else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let held_back: Vec<_> = STORE_MIGRATIONS
            .iter()
            .flat_map(|migration| {
                migration
                    .statements()
                    .filter(|statement| statement_removes_data(statement))
                    .map(|statement| (migration.filename, statement))
            })
            .collect();
        let before = store.pending_removals(&held_back).await;
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].0, "0005_device_status_namespacing.sql");
        assert!(before[0].1.is_some(), "a DELETE removal is counted");

        let legacy = format!("U:held-back-{}|device_status", uuid::Uuid::new_v4());
        sqlx::query("INSERT INTO cosmos_account_blob (principal, kind, payload) VALUES ($1, 'device_status', $2)")
            .bind(&legacy)
            .bind(b"legacy".as_slice())
            .execute(&store.pool)
            .await
            .unwrap();
        let after = store.pending_removals(&held_back).await;
        store.migrate().await.unwrap();
        let kept: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM cosmos_account_blob WHERE principal = $1")
                .bind(&legacy)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        sqlx::query("DELETE FROM cosmos_account_blob WHERE principal = $1")
            .bind(&legacy)
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(
            after[0].1.expect("counted") >= 1,
            "the legacy row is one the removal would take"
        );
        assert_eq!(
            kept, 1,
            "a start without COSMOS_ALLOW_DATA_REMOVALS keeps the row"
        );
    }

    #[test]
    fn migration_schema_ddl_exists_only_in_numbered_sql_files() {
        let sources = [
            ("store_postgres.rs", include_str!("store_postgres.rs")),
            ("enrollment.rs", include_str!("enrollment.rs")),
            ("keydirectory.rs", include_str!("keydirectory.rs")),
        ];
        let ddl_prefixes = [
            concat!("CREATE ", "TABLE IF NOT EXISTS"),
            concat!("CREATE ", "INDEX IF NOT EXISTS"),
            concat!("CREATE ", "UNIQUE INDEX IF NOT EXISTS"),
            concat!("CREATE ", "SEQUENCE IF NOT EXISTS"),
            concat!("ALTER ", "TABLE IF EXISTS"),
        ];
        for (filename, source) in sources {
            let production = source
                .rsplit_once("\n#[cfg(test)]\nmod tests {")
                .map_or(source, |(production, _)| production);
            for prefix in ddl_prefixes {
                let inline_literal = format!("\"{prefix}");
                assert!(
                    !production.contains(&inline_literal),
                    "{filename} duplicates schema DDL inline: {prefix}"
                );
            }
        }
    }

    /// Postgres tests need a real database. They SKIP rather than fail when
    /// `COSMOS_TEST_DATABASE_URL` is unset, so the suite stays green without one.
    ///
    /// The env var being unset is the ONLY skip. If a database WAS offered and we
    /// still cannot connect or migrate, that is a failure and must be reported as
    /// one: `connect` runs [`STORE_MIGRATIONS`], so swallowing its error would
    /// hide exactly the migration break that stops the server from starting, and every test
    /// here would report `... ok` having asserted nothing.
    async fn store() -> Option<PostgresStore> {
        let url = std::env::var("COSMOS_TEST_DATABASE_URL").ok()?;
        Some(
            PostgresStore::connect(&url)
                .await
                .expect("COSMOS_TEST_DATABASE_URL is set but connect/migrate failed"),
        )
    }

    fn named(first: &str) -> pb::Contact {
        pb::Contact {
            name: Some(pb::Name {
                first_name: first.to_owned(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// REGRESSION: writes used to be issued with `let _ = sqlx::query(..)`, so a
    /// failed INSERT was reported to the Pin as CREATE_SUCCESS. The device does
    /// not retry a success, so the wearer's data was silently gone. A store that
    /// cannot record a write must SAY so.
    #[tokio::test]
    async fn an_unreachable_database_reports_failure_rather_than_success() {
        // A pool pointed at a closed port, built lazily so the WRITE is what
        // fails. This test needs no database and must not skip.
        let store = PostgresStore::unreachable();
        let result = store
            .put_contacts(
                "wearer",
                &pb::ContactList {
                    contacts: vec![named("Ada")],
                    ..Default::default()
                },
            )
            .await;
        // `matches!` rather than `assert_eq!`: `ContactRecord` deliberately does
        // not derive Debug because it holds wearer PII.
        assert!(
            matches!(result, Err(StoreError::Unavailable)),
            "a store that cannot record a write must not report success"
        );
    }

    /// Every READ must report an outage as an outage.
    ///
    /// This is the test the empty-account parity test cannot be: with nothing
    /// stored, a swallowed error and genuine absence are the same answer, so only
    /// a store that FAILS can tell them apart. Each of these reads used to
    /// swallow, `contacts` wrapped three queries in `if let Ok(rows)`, `memory`
    /// ended in `.ok().flatten()`, and the note/event reads ended in
    /// `.unwrap_or_default()`, so a database outage was served to the wearer as
    /// an empty address book, a capture that does not exist, and a history in
    /// which nothing ever happened.
    ///
    /// Needs no database, and must not skip.
    #[tokio::test]
    async fn an_unreachable_database_never_reports_absence_instead_of_failure() {
        let store = PostgresStore::unreachable();

        assert_eq!(
            store.contacts("wearer").await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as an empty address book (it also zeroes the \
             sync cursor, so the next delta sync has nothing to resume from)"
        );
        assert_eq!(
            store.memory("wearer", "some-uuid").await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as 'no such capture' — the upload worker \
             treats MEMORY_NOT_FOUND as fatal and abandons the asset"
        );
        assert_eq!(
            store.recent_notes("wearer", 0, None, None).await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as 'the wearer saved nothing'"
        );
        // The paged reads the dashboard actually calls are subject to the same
        // rule, and they are separate statements, so they need their own arms:
        // an empty page with `totalElements: 0` is the same lie in the shape
        // the wearer's screen is written against.
        assert_eq!(
            store.memory_page("wearer", &[], false, 0, 20).await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as an empty page of captures"
        );
        assert_eq!(
            store.count_memories("wearer", &[]).await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as 'you have no captures'"
        );
        assert_eq!(
            store.note_page("wearer", None, 0, 20).await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as an empty page of notes"
        );
        assert_eq!(
            store.count_notes("wearer").await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as 'you have no notes'"
        );
        assert_eq!(
            store.memory_thumbnail("wearer", "some-uuid", 0).await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as 'this capture has no such frame'"
        );
        assert_eq!(
            store.search_notes("wearer", "milk", 0).await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as 'nothing matched'"
        );
        assert_eq!(
            store.delete_all_notes("wearer").await.err(),
            Some(StoreError::Unavailable),
            "a failed erasure must not read as 'there was nothing to erase'"
        );
        assert_eq!(
            store.delete_note("wearer", "some-uuid").await.err(),
            Some(StoreError::Unavailable),
            "a failed note delete must not read as 'there was nothing to delete' — \
             the row is still stored and the wearer would be told it is gone"
        );
        assert_eq!(
            store.delete_event("wearer", "some-event").await.err(),
            Some(StoreError::Unavailable),
            "a failed event delete must not read as 'there was nothing to delete'"
        );
        assert_eq!(
            store
                .query_events("wearer", "", "", None, None, 0)
                .await
                .err(),
            Some(StoreError::Unavailable),
            "an outage must not read as 'nothing ever happened'"
        );
        assert_eq!(
            store
                .create_note("wearer", NewNote::sealed(None, None))
                .await
                .err(),
            Some(StoreError::Unavailable),
            "a note that was never written must not come back with a uuid the \
             handler acks as CREATE_SUCCESS"
        );
    }

    /// Isolation is a security property, not a convenience.
    ///
    /// `contacts()` issues THREE independent reads, plaintext, encrypted, and
    /// tombstones, each with its own `WHERE principal` predicate. Asserting only
    /// on the plaintext list left the other two unguarded: dropping the predicate
    /// from the tombstone query kept this test green, even though the tombstone
    /// rows contain another wearer's deleted contact ids. All three are asserted
    /// here so a lost predicate on any of them is caught.
    #[tokio::test]
    async fn one_principal_never_reads_anothers_rows() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let a = format!("pg-a-{}", uuid::Uuid::new_v4());
        let b = format!("pg-b-{}", uuid::Uuid::new_v4());

        // `a` gets one of each row kind: a live contact, an encrypted contact,
        // and, by deleting a second contact, a tombstone.
        let written = store
            .put_contacts(
                &a,
                &pb::ContactList {
                    contacts: vec![named("Ada"), named("Grace")],
                    encrypted_contacts: vec![EncryptedData {
                        encryption_information: None,
                        data: b"opaque ciphertext".to_vec(),
                    }],
                    encrypted_contacts_versions: vec![4],
                },
            )
            .await
            .expect("write succeeds");
        let grace = written
            .iter()
            .find(|record| {
                record
                    .contact
                    .name
                    .as_ref()
                    .is_some_and(|name| name.first_name == "Grace")
            })
            .expect("both contacts were written")
            .contact
            .id
            .clone();
        store
            .delete_contacts(&a, std::slice::from_ref(&grace))
            .await
            .expect("delete succeeds");

        let mine = store.contacts(&a).await.unwrap();
        assert_eq!(mine.contacts.len(), 1, "Grace was deleted, Ada remains");
        assert_eq!(mine.encrypted.len(), 1);
        assert_eq!(mine.deletions.len(), 1, "the delete left a tombstone");

        // `b` shares the database and must see none of it.
        let theirs = store.contacts(&b).await.unwrap();
        assert!(theirs.contacts.is_empty(), "plaintext contacts leaked");
        assert!(theirs.encrypted.is_empty(), "encrypted contacts leaked");
        assert!(
            theirs.deletions.is_empty(),
            "tombstones leaked — these contain another wearer's contact ids"
        );
        assert!(
            theirs.latest.is_none(),
            "an empty principal must not inherit another's sync point"
        );
    }

    /// A store that cannot contain a capture write out must say so rather than
    /// report "no such capture", which the device reads as settled and fatal.
    #[tokio::test]
    async fn an_unreachable_database_never_reports_a_capture_write_as_not_found() {
        let store = PostgresStore::unreachable();
        // `unwrap_or(false)` used to turn an outage into "no such capture",
        // which `AssetUploadWorkerImpl` reads as fatal and gives up on.
        assert!(matches!(
            store.delete_memory("wearer", "some-uuid").await,
            Err(StoreError::Unavailable)
        ));
        assert!(matches!(
            store
                .record_upload_state("wearer", "some-uuid", UploadState::Complete)
                .await,
            Err(StoreError::Unavailable)
        ));
        // An unacknowledged ingest is what makes the device re-send. Reporting
        // the batch as stored would clear its `needs_sync` flags over data that
        // never landed.
        let event = NotableEventRecord {
            event_identifier: "e1".to_owned(),
            originator_identifier: "camera".to_owned(),
            creation_time: None,
            event_type: "photo".to_owned(),
            event_data: None,
            encrypted_event_data: None,
            encrypted_location: None,
            device_is_locked: false,
            ingested: SyncTime::now(),
            indexed_text: None,
        };
        assert!(matches!(
            store.ingest_events("wearer", &[event]).await,
            Err(StoreError::Unavailable)
        ));
        // An empty batch is vacuously fine: nothing to commit, nothing to fail.
        assert!(matches!(
            store.ingest_events("wearer", &[]).await,
            Ok(acknowledged) if acknowledged.is_empty()
        ));
    }

    /// A DELETE IS SCOPED TO THE CALLER, AND THE ROW REALLY GOES.
    ///
    /// Both statements contain a `WHERE principal` predicate and answer from their
    /// own row count. Dropping that predicate would let one account erase
    /// another's My Data row by guessing an identifier, so B here deletes with
    /// A's *real* uuid and *real* event identifier, and must be told `false`
    /// while A's rows stay put.
    #[tokio::test]
    async fn a_note_and_event_delete_is_scoped_to_the_caller() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let a = format!("pg-del-a-{}", uuid::Uuid::new_v4());
        let b = format!("pg-del-b-{}", uuid::Uuid::new_v4());

        let event = |id: &str| NotableEventRecord {
            event_identifier: id.to_owned(),
            originator_identifier: "humane.experience.aimic".to_owned(),
            creation_time: Some(SyncTime::now()),
            event_type: "AI_MIC".to_owned(),
            event_data: None,
            encrypted_event_data: None,
            encrypted_location: None,
            device_is_locked: false,
            ingested: SyncTime::now(),
            indexed_text: None,
        };
        store
            .ingest_events(&a, &[event("ev-1"), event("ev-2")])
            .await
            .expect("write succeeds");
        let note = store
            .create_note(&a, NewNote::sealed(None, None))
            .await
            .unwrap();

        // B guesses right and still reaches nothing.
        assert_eq!(store.delete_event(&b, "ev-1").await, Ok(false));
        assert_eq!(store.delete_note(&b, &note.uuid).await, Ok(false));
        assert_eq!(
            store
                .query_events(&a, "", "", None, None, 0)
                .await
                .unwrap()
                .len(),
            2,
            "another principal's delete must not remove a row"
        );
        assert_eq!(
            store.recent_notes(&a, 0, None, None).await.unwrap().len(),
            1
        );

        // The owner's delete removes exactly one row, and a repeat is `false`.
        assert_eq!(store.delete_event(&a, "ev-1").await, Ok(true));
        assert_eq!(store.delete_event(&a, "ev-1").await, Ok(false));
        let left = store.query_events(&a, "", "", None, None, 0).await.unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].event_identifier, "ev-2");

        assert_eq!(store.delete_note(&a, &note.uuid).await, Ok(true));
        assert_eq!(store.delete_note(&a, &note.uuid).await, Ok(false));
        assert!(
            store
                .recent_notes(&a, 0, None, None)
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// The two backends must be indistinguishable to a handler.
    ///
    /// Not a style point: every RPC in this crate is written against `dyn Store`,
    /// so a difference here is a difference in what the wearer's Pin is told,
    /// depending only on which backend the deployment configured. This pins the
    /// answers that used to diverge, the Postgres reads swallowed their errors
    /// and reported an outage as absence, while the in-memory store cannot fail
    /// and so always reported genuine absence.
    ///
    /// Absence is asserted here against BOTH backends. The failure half is
    /// covered by the `unreachable_database` tests, which the in-memory store has
    /// no counterpart for by construction.
    #[tokio::test]
    async fn both_backends_answer_an_empty_account_identically() {
        let Some(pg) = store().await else { return };
        let memory = crate::store::MemoryStore::shared();
        let principal = format!("parity-{}", uuid::Uuid::new_v4());

        let backends: [&dyn Store; 2] = [&pg, memory.as_ref()];
        for backend in backends {
            let contacts = backend
                .contacts(&principal)
                .await
                .expect("an empty account is Ok, never Err");
            assert!(contacts.contacts.is_empty());
            assert!(contacts.encrypted.is_empty());
            assert!(contacts.deletions.is_empty());
            assert_eq!(
                contacts.latest, None,
                "no writes means no sync point to resume from"
            );

            assert!(
                backend
                    .memory(&principal, "nope")
                    .await
                    .expect("a missing capture is Ok(None), never Err")
                    .is_none()
            );
            assert!(
                backend
                    .recent_notes(&principal, 0, None, None)
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert!(
                backend
                    .search_notes(&principal, "anything", 0)
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(backend.delete_all_notes(&principal).await.unwrap(), 0);
            assert!(
                backend
                    .query_events(&principal, "", "", None, None, 0)
                    .await
                    .unwrap()
                    .is_empty()
            );
            // Deleting what was never stored is a vacuous success on both.
            assert_eq!(backend.delete_memory(&principal, "nope").await, Ok(false));
            assert_eq!(
                backend
                    .record_upload_state(&principal, "nope", UploadState::Complete)
                    .await,
                Ok(false)
            );
            // Same for the two web-boundary deletes: `false` is "nothing of
            // yours matched", which is what an empty account must answer.
            assert_eq!(backend.delete_note(&principal, "nope").await, Ok(false));
            assert_eq!(backend.delete_event(&principal, "nope").await, Ok(false));
        }
    }
}

/// The consolidation contract (`store::contract`) against a real PostgreSQL.
/// Skips, like every database test here, only when no database is offered.
#[cfg(test)]
mod contract_tests {
    use super::*;
    use crate::store::contract;

    async fn store() -> Option<PostgresStore> {
        let url = std::env::var("COSMOS_TEST_DATABASE_URL").ok()?;
        Some(
            PostgresStore::connect(&url)
                .await
                .expect("COSMOS_TEST_DATABASE_URL is set but connect/migrate failed"),
        )
    }

    /// Account deletion against real rows: nothing of the purged principal is
    /// left in any table, tombstoned captures and `#device:` status rows
    /// included, and the other principal's rows are all still there.
    #[tokio::test]
    async fn purge_account_removes_one_principal_and_nothing_else() {
        let Some(store) = store().await else { return };
        let (gone, kept) =
            contract::purge_account_removes_one_principal_and_nothing_else(&store).await;
        for table in PRINCIPAL_TABLES {
            let statement = format!(
                "SELECT COUNT(*) FROM {table} WHERE principal = $1 OR starts_with(principal, $2)"
            );
            let (left,): (i64,) = sqlx::query_as(&statement)
                .bind(&gone)
                .bind(format!("{gone}#"))
                .fetch_one(&store.pool)
                .await
                .unwrap();
            assert_eq!(left, 0, "{table} still holds rows of the deleted account");
        }
        let (kept_captures,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM cosmos_memory WHERE principal = $1")
                .bind(&kept)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(
            kept_captures, 2,
            "the other account keeps its live and deleted captures"
        );
    }

    /// Every table with a `principal` column is either purged with the account
    /// or is enrollment ceremony state keyed by a Pin's device subject, which
    /// expires on its own. A new wearer table must join `PRINCIPAL_TABLES`.
    #[tokio::test]
    async fn every_principal_table_is_purged() {
        let Some(store) = store().await else { return };
        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT table_name::text FROM information_schema.columns \
             WHERE table_schema = current_schema() AND column_name = 'principal' \
             ORDER BY table_name",
        )
        .fetch_all(&store.pool)
        .await
        .unwrap();
        let ceremony = [
            "cosmos_opaque_login",
            "cosmos_opaque_login_attempt",
            "cosmos_opaque_session",
        ];
        for (table,) in tables {
            assert!(
                PRINCIPAL_TABLES.contains(&table.as_str()) || ceremony.contains(&table.as_str()),
                "{table} is keyed by principal but account deletion does not purge it"
            );
        }
    }

    #[tokio::test]
    async fn a_backfilled_index_never_resurrects_a_forgotten_event() {
        let Some(store) = store().await else { return };
        contract::a_backfilled_index_never_resurrects_a_forgotten_event(&store).await;
    }

    #[tokio::test]
    async fn a_note_reads_back_by_uuid_for_its_owner_only() {
        let Some(store) = store().await else { return };
        contract::a_note_reads_back_by_uuid_for_its_owner_only(&store).await;
    }

    #[tokio::test]
    async fn the_pending_queue_keeps_the_newest_declarations() {
        let Some(store) = store().await else { return };
        contract::the_pending_queue_keeps_the_newest_declarations(&store).await;
    }

    #[tokio::test]
    async fn a_racing_intent_never_outlives_its_capture() {
        let Some(store) = store().await else { return };
        contract::a_racing_intent_never_outlives_its_capture(&store).await;
    }

    #[tokio::test]
    async fn sealed_contact_rows_are_removed_by_their_exact_ciphertext() {
        let Some(store) = store().await else { return };
        contract::sealed_contact_rows_are_removed_by_their_exact_ciphertext(&store).await;
    }

    /// The race itself cannot be forced from outside, so this proves the
    /// mechanism that closes it: while another session holds the principal's
    /// pending-create lock, neither a declaration nor the clear inside
    /// `CreateMemory` can finish. Once it is released both do, and the
    /// capture is not left listed as waiting.
    #[tokio::test]
    async fn declarations_and_the_create_that_clears_them_serialize_per_principal() {
        let Some(store) = store().await else { return };
        let principal = contract::fresh_principal("pending-lock");
        let mut holder = store.pool.begin().await.expect("begin");
        lock_pending_creates(&mut holder, &principal)
            .await
            .expect("hold the lock");

        let pending = PendingMemoryCreate {
            device_local_id: "locked".to_owned(),
            memory_type: 1,
            delay_reason: 1,
            declared: SyncTime::now(),
        };
        let wait = std::time::Duration::from_millis(300);
        let declare = store.declare_pending_memory_create(&principal, &pending);
        tokio::pin!(declare);
        assert!(
            tokio::time::timeout(wait, &mut declare).await.is_err(),
            "a declaration waits on the principal's pending-create lock"
        );
        let create = store.create_memory(
            &principal,
            NewMemory {
                kind: MemoryKind::Photo,
                device_local_id: "locked".to_owned(),
                bursts: 1,
                files_per_burst: 1,
                device_created_time: None,
                gmt_offset: 0,
                thumbnails: Vec::new(),
                encrypted_location: None,
                metadata: CaptureMetadata::default(),
            },
        );
        tokio::pin!(create);
        assert!(
            tokio::time::timeout(wait, &mut create).await.is_err(),
            "so does the clear inside CreateMemory"
        );
        holder.rollback().await.expect("release the lock");
        let (declared, created) = tokio::join!(declare, create);
        declared.unwrap();
        created.unwrap();
        assert!(
            store
                .pending_memory_creates(&principal)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn search_notes_matches_inflections_and_ignores_stopwords() {
        let Some(store) = store().await else { return };
        contract::search_notes_matches_inflections_and_ignores_stopwords(&store).await;
    }

    #[tokio::test]
    async fn create_note_keeps_original_case_and_lowercases_only_the_index() {
        let Some(store) = store().await else { return };
        contract::create_note_keeps_original_case_and_lowercases_only_the_index(&store).await;
    }

    #[tokio::test]
    async fn update_note_refreshes_index_and_modified() {
        let Some(store) = store().await else { return };
        contract::update_note_refreshes_index_and_modified(&store).await;
    }

    #[tokio::test]
    async fn note_page_query_filters_and_counts() {
        let Some(store) = store().await else { return };
        contract::note_page_query_filters_and_counts(&store).await;
    }

    #[tokio::test]
    async fn pending_memory_create_upserts_and_clears_on_create_memory() {
        let Some(store) = store().await else { return };
        contract::pending_memory_create_upserts_and_clears_on_create_memory(&store).await;
    }

    #[tokio::test]
    async fn memory_favorite_filter_and_tags_round_trip() {
        let Some(store) = store().await else { return };
        contract::memory_favorite_filter_and_tags_round_trip(&store).await;
    }

    #[tokio::test]
    async fn capture_metadata_and_upload_state_round_trip() {
        let Some(store) = store().await else { return };
        contract::capture_metadata_and_upload_state_round_trip(&store).await;
    }

    #[tokio::test]
    async fn event_page_filters_by_type_set_and_reports_total() {
        let Some(store) = store().await else { return };
        contract::event_page_filters_by_type_set_and_reports_total(&store).await;
    }

    #[tokio::test]
    async fn event_counts_by_type_set_since() {
        let Some(store) = store().await else { return };
        contract::event_counts_by_type_set_since(&store).await;
    }

    #[tokio::test]
    async fn event_feedback_upsert_and_delete_are_principal_scoped() {
        let Some(store) = store().await else { return };
        contract::event_feedback_upsert_and_delete_are_principal_scoped(&store).await;
    }

    #[tokio::test]
    async fn a_resent_sealed_event_keeps_its_search_index() {
        let Some(store) = store().await else { return };
        contract::a_resent_sealed_event_keeps_its_search_index(&store).await;
    }

    /// A capture and a note written before 0007 read back through the new
    /// decoders: the columns the migration added are NULL or defaulted there.
    #[tokio::test]
    async fn rows_written_before_the_consolidation_columns_still_read() {
        let Some(store) = store().await else { return };
        let principal = contract::fresh_principal("legacy");
        sqlx::query(
            "INSERT INTO cosmos_note (principal, uuid, indexed_text, created_seconds, created_nanos)
             VALUES ($1, 'legacy-note', 'legacy text', 1, 0)",
        )
        .bind(&principal)
        .execute(&store.pool)
        .await
        .expect("legacy note");
        sqlx::query(
            "INSERT INTO cosmos_memory
                (principal, uuid, numeric_id, device_local_id, kind, created_seconds,
                 created_nanos, gmt_offset, thumbnails, bursts, upload_complete)
             VALUES ($1, 'legacy-memory', nextval('cosmos_memory_id_seq'), 'legacy', 0, 1, 0, 0,
                     '[]'::bytea, '[]'::bytea, TRUE)",
        )
        .bind(&principal)
        .execute(&store.pool)
        .await
        .expect("legacy capture");

        let note = &store
            .note_page(&principal, None, 0, 10)
            .await
            .unwrap()
            .records[0];
        assert_eq!(note.source, None);
        assert_eq!(note.body, None);
        assert_eq!(note.modified, None);
        assert!(note.tags.is_empty());
        let memory = store
            .memory(&principal, "legacy-memory")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(memory.upload_state, UploadState::Complete);
        assert!(!memory.favorite);
        assert!(memory.metadata.photo_metadatas.is_empty());
        let page = store
            .memory_page(&principal, &[], false, 0, 10)
            .await
            .unwrap();
        assert_eq!(page.records[0].upload_state, UploadState::Complete);
    }
}
