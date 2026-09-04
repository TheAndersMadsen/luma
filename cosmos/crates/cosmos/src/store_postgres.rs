//! PostgreSQL-backed [`Store`] — the documented persistence target.
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
//! encoding is the one representation guaranteed stable here — a hand-rolled
//! column layout would drift from the contract the device speaks.
//!
//! **Sync cursors stay strictly monotonic per principal, and are allocated
//! inside the transaction they stamp.** The device compares its own cursor
//! against ours to decide what changed, so two writes inside one clock tick — or
//! a clock that steps backwards — must still order. More than that, the cursor
//! must not be *assigned* before the write it belongs to becomes visible: a
//! writer that commits second holding the lower cursor is a write the device
//! will never ask for again. `cosmos_sync_cursor` is the allocator that makes
//! assignment and commit one step; see [`PostgresStore::next_cursor`]. The
//! in-memory store gets the same property from holding its lock across both.
//!
//! **A configured-but-unreachable database fails loudly at startup.** Falling
//! back to memory would look healthy and quietly lose the wearer's data, which
//! is the failure this whole module exists to prevent.

use cosmos_protocol::common::encryption::EncryptedData;
use cosmos_protocol::contacts as pb;
use sqlx::{Row, postgres::PgPoolOptions};

use crate::store::{
    ContactRecord, ContactSnapshot, DeletionRecord, EncryptedContactRecord, MemoryKind,
    MemoryRecord, MemorySummary, NewMemory, NotableEventRecord, NoteRecord, SearchableNote, Store,
    StoreError, StorePage, SyncTime, Written,
};

/// Connection string. Unset means this deployment stays on the in-memory store.
pub const DATABASE_URL_ENV: &str = "COSMOS_DATABASE_URL";

/// Advisory-lock key serializing schema creation across replicas. Arbitrary but
/// fixed; the enrollment schema uses a different one so the two never block each
/// other. See [`PostgresStore::migrate`].
pub(crate) const SCHEMA_LOCK_KEY: i64 = 0x0CA2_2451_0000_0001;

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
        "0007_surface_registry.sql",
        include_str!("../../../migrations/0007_surface_registry.sql"),
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
    /// (or `42710 type already exists`). That is not a hypothetical — every
    /// production workloads may run more than one replica, and
    /// `migrate` runs on EVERY [`PostgresStore::connect`], so two pods coming up
    /// together against a fresh database would race; the loser's `connect`
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
        // riding along with a release is either blocked, or — if that gate were
        // ever relaxed — deletes data as an invisible side effect of shipping.
        // The removal itself is legitimate and reviewed (REVIEWED_DATA_REMOVALS
        // pins its exact text); it just has to be something an operator does on
        // purpose rather than something a release does to them.
        let removals_allowed = data_removals_enabled();
        for migration in STORE_MIGRATIONS {
            for statement in migration.statements() {
                if !removals_allowed && statement_removes_data(statement) {
                    tracing::info!(
                        migration = migration.filename,
                        "store: holding back a reviewed data-removal statement; \
                         set COSMOS_ALLOW_DATA_REMOVALS=1 to run it deliberately"
                    );
                    continue;
                }
                sqlx::query(statement).execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
        Ok(())
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
    /// so a repair that cannot run costs performance, not correctness — and
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
    /// (`ContactSnapshot::contacts_since`), so that write is skipped — silently,
    /// and forever, because nothing will ever raise its cursor again.
    ///
    /// Taking `&mut PgConnection` from the caller's transaction is the fix, and
    /// the signature is the enforcement: the cursor cannot be allocated except on
    /// the connection that also carries the writes. The single upsert is what
    /// makes it atomic — it takes a row lock on this principal's cursor row that
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
/// answer — an optional location the device never sent decodes to `None` either
/// way. It is wrong inside a LIST: a frame that fails to parse there is silently
/// dropped, and the capture comes back with fewer thumbnails than were stored,
/// which is a state the in-memory store can never produce. Corruption must be
/// reported, not rendered as a smaller burst.
fn decode_or_corrupt<M: prost::Message + Default>(bytes: &[u8]) -> Result<M, StoreError> {
    M::decode(bytes).map_err(|_| StoreError::Unavailable)
}

/// Bursts are stored as a length-prefixed prost blob; they are opaque to SQL and
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
/// array elements inside PostgreSQL — still far cheaper than shipping the blob
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

fn kind_from_i16(value: i16) -> MemoryKind {
    match value {
        1 => MemoryKind::Video,
        2 => MemoryKind::FoodLog,
        3 => MemoryKind::Note,
        _ => MemoryKind::Photo,
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
    // Both arms fail the read. The outer one already did; the inner one used to
    // `filter_map` the failure away, which honoured the comment above for a
    // corrupt envelope and violated it for a corrupt frame.
    let thumbnails: Vec<EncryptedData> = serde_json::from_slice::<Vec<Vec<u8>>>(&thumbs)
        .map_err(|_| StoreError::Unavailable)?
        .iter()
        .enumerate()
        .map(|(index, blob)| {
            decode_or_corrupt(blob).inspect_err(|_| {
                // The uuid is server-minted and already appears in the request
                // path; the kid is not logged, because it carries the wearer's
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

    Ok(MemoryRecord {
        uuid,
        numeric_id: row.get("numeric_id"),
        device_local_id: row.get("device_local_id"),
        kind: kind_from_i16(row.get("kind")),
        device_created_time: device_seconds
            .zip(device_nanos)
            .map(|(s, n)| SyncTime::from_parts(s, n)),
        gmt_offset: row.get("gmt_offset"),
        thumbnails,
        encrypted_location: location.as_deref().and_then(decode),
        bursts: decode_bursts(&bursts)?,
        upload_complete: row.get("upload_complete"),
        deleted: None,
        created: SyncTime::from_parts(row.get("created_seconds"), row.get("created_nanos")),
    })
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

    Ok(MemorySummary {
        uuid: row.get("uuid"),
        numeric_id: row.get("numeric_id"),
        device_local_id: row.get("device_local_id"),
        kind: kind_from_i16(row.get("kind")),
        device_created_time: device_seconds
            .zip(device_nanos)
            .map(|(s, n)| SyncTime::from_parts(s, n)),
        created: SyncTime::from_parts(row.get("created_seconds"), row.get("created_nanos")),
        upload_complete: row.get("upload_complete"),
        thumbnail_count: thumbnail_count.max(0) as usize,
        has_location: row.get("has_location"),
        burst_count: bursts.len(),
        frame_count: bursts.iter().map(|burst| burst.files.len()).sum(),
    })
}

/// One `cosmos_note` row -> [`NoteRecord`].
///
/// Sealed bodies stay opaque: a body that does not decode is genuinely absent to
/// us (the device sealed it under a key we may not hold), which is why this is
/// the permissive [`decode`] rather than [`decode_or_corrupt`].
fn note_from_row(row: sqlx::postgres::PgRow) -> NoteRecord {
    let note: Option<Vec<u8>> = row.get("encrypted_note");
    let location: Option<Vec<u8>> = row.get("encrypted_location");
    NoteRecord {
        uuid: row.get("uuid"),
        indexed_text: row.get("indexed_text"),
        encrypted_note: note.as_deref().and_then(decode),
        encrypted_location: location.as_deref().and_then(decode),
        created: SyncTime::from_parts(row.get("created_seconds"), row.get("created_nanos")),
    }
}

/// The `kind = ANY($n)` bind for a kind filter; `None` means "every kind".
///
/// A NULL array rather than an empty one, because `kind = ANY('{}')` matches
/// nothing — the same expression would silently turn "no filter" into "no
/// captures".
fn kind_filter(kinds: &[MemoryKind]) -> Option<Vec<i16>> {
    (!kinds.is_empty()).then(|| kinds.iter().copied().map(kind_to_i16).collect())
}

#[tonic::async_trait]
impl Store for PostgresStore {
    async fn surfaces(
        &self,
        principal: &str,
    ) -> Result<Vec<crate::surface_registry::Surface>, crate::surface_registry::RegistryError> {
        use crate::surface_registry::{Record, RegistryError};
        let rows = sqlx::query("SELECT record::text AS record, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms FROM cosmos_surface_registry WHERE principal = $1 AND record->>'revoked' = 'false' ORDER BY surface_id LIMIT 17")
            .bind(principal).fetch_all(&self.pool).await.map_err(|_| RegistryError::Unavailable)?;
        if rows.len() > 16 {
            return Err(RegistryError::Unavailable);
        }
        let mut surfaces = Vec::new();
        for row in rows {
            let record: Record = serde_json::from_str(row.get::<&str, _>("record"))
                .map_err(|_| RegistryError::Unavailable)?;
            if !record.revoked {
                surfaces.push(record.view(row.get("now_ms")));
            }
        }
        Ok(surfaces)
    }

    async fn mutate_surface(
        &self,
        principal: &str,
        surface_id: uuid::Uuid,
        mutation: crate::surface_registry::Mutation,
    ) -> Result<crate::surface_registry::Surface, crate::surface_registry::RegistryError> {
        use crate::surface_registry::{Record, RegistryError, event, transition};
        let unavailable = |_| RegistryError::Unavailable;
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        sqlx::query("INSERT INTO cosmos_surface_head (principal) VALUES ($1) ON CONFLICT (principal) DO NOTHING")
            .bind(principal).execute(&mut *tx).await.map_err(unavailable)?;
        let head = sqlx::query(
            "SELECT sequence, hash FROM cosmos_surface_head WHERE principal = $1 FOR UPDATE",
        )
        .bind(principal)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        // Receipt/expiry checks happen after acquiring the serialization lock;
        // transaction-start time would admit expired credentials after waiting.
        let now: i64 =
            sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint")
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        let row = sqlx::query(
            "SELECT record::text AS record FROM cosmos_surface_registry WHERE principal = $1 AND surface_id = $2",
        )
        .bind(principal)
        .bind(surface_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        let current = row
            .as_ref()
            .map(|row| {
                serde_json::from_str::<Record>(row.get::<&str, _>("record"))
                    .map_err(|_| RegistryError::Unavailable)
            })
            .transpose()?;
        let active_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cosmos_surface_registry WHERE principal = $1 AND record->>'revoked' = 'false'")
            .bind(principal).fetch_one(&mut *tx).await.map_err(unavailable)?;
        let (record, kind) = transition(
            current.as_ref(),
            usize::try_from(active_count).map_err(|_| RegistryError::Unavailable)?,
            surface_id,
            &mutation,
            now,
        )?;
        if let Some(kind) = kind {
            let sequence = head
                .get::<i64, _>("sequence")
                .checked_add(1)
                .ok_or(RegistryError::Unavailable)?;
            let entry = event(
                principal,
                sequence as u64,
                head.get("hash"),
                kind,
                &record,
                now,
            );
            let hash = entry.hash()?;
            let encoded_record =
                serde_json::to_string(&record).map_err(|_| RegistryError::Unavailable)?;
            let encoded_event =
                serde_json::to_string(&entry).map_err(|_| RegistryError::Unavailable)?;
            sqlx::query("INSERT INTO cosmos_surface_registry (principal, surface_id, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (principal, surface_id) DO UPDATE SET record = EXCLUDED.record")
                .bind(principal).bind(surface_id).bind(encoded_record).execute(&mut *tx).await.map_err(unavailable)?;
            sqlx::query("INSERT INTO cosmos_surface_event (principal, sequence, hash, event) VALUES ($1, $2, $3, $4::jsonb)")
                .bind(principal).bind(sequence).bind(&hash).bind(encoded_event).execute(&mut *tx).await.map_err(unavailable)?;
            sqlx::query(
                "UPDATE cosmos_surface_head SET sequence = $2, hash = $3 WHERE principal = $1",
            )
            .bind(principal)
            .bind(sequence)
            .bind(hash)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(record.view(now))
    }

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
            // An empty id is a create; a supplied id upserts within THIS
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
            // *because* the cursor row lock above is already held — every
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
            // write; it will not retry, and the wearer's contact is gone.
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
        // the exact ciphertext — retry-idempotent without inventing one.
        for (index, sealed) in list.encrypted_contacts.iter().enumerate() {
            let version = list
                .encrypted_contacts_versions
                .get(index)
                .copied()
                .unwrap_or(1);
            // A swallowed failure here is reported to the Pin as a successful
            // write; it will not retry, and the wearer's contact is gone.
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

        // Nothing above is durable until this returns; a failed commit is a
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

    async fn contacts(&self, principal: &str) -> Written<ContactSnapshot> {
        let mut snapshot = ContactSnapshot::default();

        // Every read below propagates. Swallowing them (`if let Ok(rows)`) made a
        // database outage indistinguishable from an empty address book: the pin
        // would render the wearer's contacts as gone AND get `latest = None`, so
        // the next delta sync had no cursor to resume from either.
        let rows = sqlx::query(
            "SELECT contact, modified_seconds, modified_nanos FROM cosmos_contact \
             WHERE principal = $1",
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
             FROM cosmos_contact_encrypted WHERE principal = $1",
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
                 upload_complete)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE)",
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
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
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
        // copy of [`memory_from_row`] — same comment above it, and the copy that
        // silently dropped a corrupt frame instead of reporting it.
        memory_from_row(&row).map(Some)
    }

    async fn memory_page(
        &self,
        principal: &str,
        kinds: &[MemoryKind],
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<MemorySummary>> {
        // Two statements rather than `COUNT(*) OVER ()` on one: the window
        // function is evaluated before LIMIT, so it is correct — except for a
        // page past the end, which returns no rows at all and would therefore
        // report a total of zero. The envelope has to stay honest about how many
        // rows exist even on an empty final page.
        let total = self.count_memories(principal, kinds).await?;
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
                    {THUMBNAIL_COUNT_EXPRESSION} AS thumbnail_count \
               FROM cosmos_memory \
              WHERE principal = $1 AND deleted_seconds IS NULL \
                AND ($2::smallint[] IS NULL OR kind = ANY($2)) \
              ORDER BY COALESCE(device_created_seconds, created_seconds) DESC, numeric_id DESC \
              LIMIT $3 OFFSET $4"
        );
        let rows = sqlx::query(&sql)
            .bind(principal)
            .bind(kind_filter(kinds))
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
            // outage — and it must not become a negative jsonb subscript, which
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
        // The element is a JSON array of byte values — the same shape the whole
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

    async fn record_upload_complete(&self, principal: &str, uuid_or_id: &str) -> Written<bool> {
        let affected = sqlx::query(
            "UPDATE cosmos_memory SET upload_complete = TRUE \
             WHERE principal = $1 AND (uuid = $2 OR numeric_id::text = $2) \
             AND deleted_seconds IS NULL",
        )
        .bind(principal)
        .bind(uuid_or_id)
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?
        .rows_affected();
        Ok(affected > 0)
    }

    async fn create_note(
        &self,
        principal: &str,
        encrypted_note: Option<EncryptedData>,
        encrypted_location: Option<EncryptedData>,
    ) -> Written<NoteRecord> {
        let record = NoteRecord {
            uuid: uuid::Uuid::new_v4().to_string(),
            indexed_text: None,
            encrypted_note,
            encrypted_location,
            created: SyncTime::now(),
        };
        // `let _ = ...` here meant the handler acked CREATE_SUCCESS with a uuid
        // for a row that was never written — and the device keeps no copy of the
        // note to retry from, so the wearer's note was simply gone.
        sqlx::query(
            "INSERT INTO cosmos_note
                (principal, uuid, indexed_text, encrypted_note, encrypted_location,
                 created_seconds, created_nanos)
             VALUES ($1,$2,NULL,$3,$4,$5,$6)",
        )
        .bind(principal)
        .bind(&record.uuid)
        .bind(record.encrypted_note.as_ref().map(encode))
        .bind(record.encrypted_location.as_ref().map(encode))
        .bind(record.created.seconds())
        .bind(record.created.nanos())
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(record)
    }

    async fn create_indexed_note(
        &self,
        principal: &str,
        encrypted_note: Option<EncryptedData>,
        encrypted_location: Option<EncryptedData>,
        indexed_text: Option<&str>,
    ) -> Written<NoteRecord> {
        let record = NoteRecord {
            uuid: uuid::Uuid::new_v4().to_string(),
            indexed_text: indexed_text.map(str::to_lowercase),
            encrypted_note,
            encrypted_location,
            created: SyncTime::now(),
        };
        sqlx::query(
            "INSERT INTO cosmos_note
                (principal, uuid, indexed_text, encrypted_note, encrypted_location,
                 created_seconds, created_nanos)
             VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(principal)
        .bind(&record.uuid)
        .bind(record.indexed_text.as_deref())
        .bind(record.encrypted_note.as_ref().map(encode))
        .bind(record.encrypted_location.as_ref().map(encode))
        .bind(record.created.seconds())
        .bind(record.created.nanos())
        .execute(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;
        Ok(record)
    }

    async fn recent_notes(
        &self,
        principal: &str,
        max_items: i32,
        start: Option<SyncTime>,
        end: Option<SyncTime>,
    ) -> Written<Vec<NoteRecord>> {
        // `LIMIT` is bound rather than applied in Rust afterwards, for exactly
        // the reason `query_events` gives — and this read is worse placed than
        // that one. It sat on the assistant's latency path with no bound in SQL
        // at all: `wearer_facts` calls it on EVERY turn the wearer speaks (not
        // only recall turns) and recall calls it again, so a wearer with twenty
        // thousand notes had all twenty thousand rows shipped, every
        // `encrypted_note` and `encrypted_location` BYTEA with them, and every
        // one of those blobs prost-decoded — to keep sixty-four of them and
        // throw the rest away in `truncate`. The cost grew for the life of the
        // account, which is the very regression `NOTE_SCAN_LIMIT` was added to
        // fix at the caller while the store kept fetching the whole table.
        //
        // `cosmos_note_recent` (migrations/0004_listing.sql) covers this order,
        // so the bound stops the scan rather than merely trimming a materialised
        // sort. The columns are named explicitly, in place of the star this
        // statement used to contain, so it asks for exactly what `note_from_row`
        // reads and nothing else — `principal` was being shipped back on every
        // row to a caller that already knew it. Non-positive `max_items`
        // still means unbounded, per the `Store` contract — spelled as
        // `i64::MAX`, the same way `query_events` spells it.
        let rows = sqlx::query(
            "SELECT uuid, indexed_text, encrypted_note, encrypted_location,
                    created_seconds, created_nanos
               FROM cosmos_note WHERE principal = $1
               AND ($2::bigint IS NULL OR created_seconds >= $2)
               AND ($3::bigint IS NULL OR created_seconds <= $3)
             ORDER BY created_seconds DESC, created_nanos DESC
             LIMIT $4",
        )
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
        offset: i64,
        limit: i64,
    ) -> Written<StorePage<NoteRecord>> {
        // Counted separately for the same reason as `memory_page`: a window past
        // the end returns no rows and still has to report the true total.
        let total = self.count_notes(principal).await?;
        if limit <= 0 {
            return Ok(StorePage {
                records: Vec::new(),
                total,
            });
        }
        let rows = sqlx::query(
            "SELECT uuid, indexed_text, encrypted_note, encrypted_location, \
                    created_seconds, created_nanos \
               FROM cosmos_note WHERE principal = $1 \
              ORDER BY created_seconds DESC, created_nanos DESC \
              LIMIT $2 OFFSET $3",
        )
        .bind(principal)
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
        // erase" — the wearer asked for a deletion and would be told it happened.
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
        // no row and the statement's own row count is the answer — no separate
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
        // Best-effort by contract (see the trait doc) — but not silent. A note
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
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        // Lexical term overlap, matching the in-memory store: this deployment
        // hosts no embedding model, and claiming semantic ranking we do not
        // perform would misrepresent the order.
        let terms: Vec<String> = needle.split_whitespace().map(str::to_owned).collect();
        let rows = sqlx::query(
            "SELECT uuid, indexed_text, created_seconds, created_nanos FROM cosmos_note \
             WHERE principal = $1 AND indexed_text IS NOT NULL \
             ORDER BY created_seconds DESC, created_nanos DESC",
        )
        .bind(principal)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Unavailable)?;

        let mut scored: Vec<(usize, String)> = rows
            .into_iter()
            .filter_map(|row| {
                let text: Option<String> = row.get("indexed_text");
                let text = text?;
                let hits = terms.iter().filter(|t| text.contains(t.as_str())).count();
                (hits > 0).then(|| (hits, row.get::<String, _>("uuid")))
            })
            .collect();
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
    /// history past — see [`crate::store::INGEST_CHUNK`] for why that cannot
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
                    encrypted_location = EXCLUDED.encrypted_location,
                    device_is_locked = EXCLUDED.device_is_locked,
                    indexed_text = EXCLUDED.indexed_text,
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

    async fn query_events(
        &self,
        principal: &str,
        event_type: &str,
        originator: &str,
        start: Option<SyncTime>,
        end: Option<SyncTime>,
        max_results: i32,
    ) -> Written<Vec<NotableEventRecord>> {
        // An empty filter matches everything; a set one is an exact match.
        //
        // `LIMIT` is bound rather than applied in Rust afterwards, matching
        // `memory_page`. Truncating after the fact meant every QueryEvents
        // read, decoded and sorted the wearer's WHOLE event partition to return
        // the twenty rows asked for — and Center issues four of these per My
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

        let found: Vec<NotableEventRecord> = rows
            .into_iter()
            .map(|row| {
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
                    ingested: SyncTime::from_parts(
                        row.get("ingested_seconds"),
                        row.get("ingested_nanos"),
                    ),
                    indexed_text: row.try_get("indexed_text").ok(),
                }
            })
            .collect();
        Ok(found)
    }

    async fn delete_event(&self, principal: &str, event_identifier: &str) -> Written<bool> {
        // `(principal, event_identifier)` is the primary key — the same key
        // `ingest_events` upserts on — so this deletes at most one row and only
        // ever one belonging to the caller.
        let affected =
            sqlx::query("DELETE FROM cosmos_event WHERE principal = $1 AND event_identifier = $2")
                .bind(principal)
                .bind(event_identifier)
                .execute(&self.pool)
                .await
                .map_err(|_| StoreError::Unavailable)?
                .rows_affected();
        Ok(affected > 0)
    }

    /// Last writer wins for this `(principal, kind)`: a set RPC carries the
    /// wearer's whole list, and the proto gives its items no id to merge on.
    ///
    /// The error propagates. The handler acks by echoing the wearer's own blob
    /// back, which is indistinguishable from a successful write — so a swallowed
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
}

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
                (7, "0007_surface_registry.sql"),
                (2, "0002_enrollment.sql"),
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
            ("0007_surface_registry.sql", 4),
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
                "CREATE TABLE IF NOT EXISTS cosmos_surface_head (",
                "CREATE TABLE IF NOT EXISTS cosmos_surface_registry (",
                "CREATE TABLE IF NOT EXISTS cosmos_surface_event (",
                "CREATE INDEX IF NOT EXISTS cosmos_surface_active",
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
                // listed statement — widening its predicate, say — puts it back
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
                    // general DO block or a filename exemption; any DDL change
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
    /// that are keyed by the bare principal ON PURPOSE — `privacy_settings` is
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
    /// hide exactly the migration break that stops the server from starting — and every test
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

    #[tokio::test]
    async fn surface_registry_postgres_serializes_independent_pools_and_reopens() {
        use crate::surface_registry::{Event, Mutation, RegistryError, hash};
        let Some(first) = store().await else {
            return;
        };
        let second = store().await.unwrap();
        let principal = format!("surface-test-{}", uuid::Uuid::new_v4());
        let id = uuid::Uuid::new_v4();
        let incarnation = uuid::Uuid::new_v4();
        let token_hash = hash(b"synthetic-surface-capability");
        first
            .mutate_surface(
                &principal,
                id,
                Mutation::Approve {
                    token_hash: token_hash.clone(),
                    incarnation,
                },
            )
            .await
            .unwrap();
        let state = |sequence| Mutation::State {
            token_hash: token_hash.clone(),
            incarnation,
            sequence,
            visible: true,
        };
        let (a, b) = tokio::join!(
            first.mutate_surface(&principal, id, state(1)),
            second.mutate_surface(&principal, id, state(1))
        );
        assert_eq!(a.unwrap().revision, 2);
        assert_eq!(b.unwrap().revision, 2);
        let (a, b) = tokio::join!(
            first.mutate_surface(&principal, id, state(2)),
            second.mutate_surface(&principal, id, state(3))
        );
        assert!(a.is_ok() || a == Err(RegistryError::SequenceConflict));
        assert!(b.is_ok());
        assert_eq!(first.surfaces(&principal).await.unwrap()[0].sequence, 3);
        assert_eq!(
            first.mutate_surface(&principal, id, state(1)).await,
            Err(RegistryError::SequenceConflict)
        );
        let rows = sqlx::query("SELECT sequence, hash, event::text AS event FROM cosmos_surface_event WHERE principal=$1 ORDER BY sequence").bind(&principal).fetch_all(&first.pool).await.unwrap();
        let mut previous = String::new();
        for (index, row) in rows.iter().enumerate() {
            let event: Event = serde_json::from_str(row.get("event")).unwrap();
            assert_eq!(event.sequence, index as u64 + 1);
            assert_eq!(event.previous_hash, previous);
            assert_eq!(event.principal, principal);
            assert_eq!(event.hash().unwrap(), row.get::<String, _>("hash"));
            previous = event.hash().unwrap();
        }
        let expected = first.surfaces(&principal).await.unwrap();
        drop(first);
        drop(second);
        let reopened = store().await.unwrap();
        assert_eq!(reopened.surfaces(&principal).await.unwrap(), expected);
        let rotated = reopened
            .mutate_surface(
                &principal,
                id,
                Mutation::Approve {
                    token_hash: hash(b"new-synthetic-capability"),
                    incarnation: uuid::Uuid::new_v4(),
                },
            )
            .await
            .unwrap();
        assert_eq!(rotated.sequence, 0);
        assert_eq!(
            reopened.mutate_surface(&principal, id, state(4)).await,
            Err(RegistryError::InvalidConnection)
        );
    }

    #[tokio::test]
    async fn surface_registry_postgres_failed_append_rolls_back_state_and_head() {
        use crate::surface_registry::{Mutation, RegistryError, hash};
        let Some(store) = store().await else {
            return;
        };
        let principal = format!("surface-rollback-test-{}", uuid::Uuid::new_v4());
        let id = uuid::Uuid::new_v4();
        let incarnation = uuid::Uuid::new_v4();
        let token_hash = hash(b"synthetic-rollback-capability");
        let before = store
            .mutate_surface(
                &principal,
                id,
                Mutation::Approve {
                    token_hash: token_hash.clone(),
                    incarnation,
                },
            )
            .await
            .unwrap();
        // Test-only duplicate next sequence forces the append (after registry
        // update) to fail. Scoped to this synthetic principal, no shared DDL.
        sqlx::query("INSERT INTO cosmos_surface_event (principal, sequence, hash, event) VALUES ($1, 2, 'test-obstruction', '{}'::jsonb)").bind(&principal).execute(&store.pool).await.unwrap();
        assert_eq!(
            store
                .mutate_surface(
                    &principal,
                    id,
                    Mutation::State {
                        token_hash,
                        incarnation,
                        sequence: 1,
                        visible: true
                    }
                )
                .await,
            Err(RegistryError::Unavailable)
        );
        assert_eq!(store.surfaces(&principal).await.unwrap(), vec![before]);
        let sequence: i64 =
            sqlx::query_scalar("SELECT sequence FROM cosmos_surface_head WHERE principal=$1")
                .bind(&principal)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(sequence, 1);
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
    /// swallow — `contacts` wrapped three queries in `if let Ok(rows)`, `memory`
    /// ended in `.ok().flatten()`, and the note/event reads ended in
    /// `.unwrap_or_default()` — so a database outage was served to the wearer as
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
            store.memory_page("wearer", &[], 0, 20).await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as an empty page of captures"
        );
        assert_eq!(
            store.count_memories("wearer", &[]).await.err(),
            Some(StoreError::Unavailable),
            "an outage must not read as 'you have no captures'"
        );
        assert_eq!(
            store.note_page("wearer", 0, 20).await.err(),
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
            store.create_note("wearer", None, None).await.err(),
            Some(StoreError::Unavailable),
            "a note that was never written must not come back with a uuid the \
             handler acks as CREATE_SUCCESS"
        );
    }

    #[tokio::test]
    async fn write_then_read_round_trips() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-test-{}", uuid::Uuid::new_v4());
        let written = store
            .put_contacts(
                &principal,
                &pb::ContactList {
                    contacts: vec![named("Ada")],
                    ..Default::default()
                },
            )
            .await
            .expect("write succeeds");
        assert_eq!(written.len(), 1);
        assert!(!written[0].contact.id.is_empty(), "server assigns the id");
        assert_eq!(written[0].contact.version, 1);

        let back = store.contacts(&principal).await.unwrap();
        assert_eq!(back.contacts.len(), 1);
        assert!(back.latest.is_some());
    }

    /// Isolation is a security property, not a convenience.
    ///
    /// `contacts()` issues THREE independent reads — plaintext, encrypted, and
    /// tombstones — each with its own `WHERE principal` predicate. Asserting only
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
        // and — by deleting a second contact — a tombstone.
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

    #[tokio::test]
    async fn a_retried_capture_returns_the_same_memory() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-cap-{}", uuid::Uuid::new_v4());
        let make = || NewMemory {
            kind: MemoryKind::Photo,
            device_local_id: "device-photo-1".to_owned(),
            bursts: 1,
            files_per_burst: 1,
            device_created_time: None,
            gmt_offset: 0,
            thumbnails: Vec::new(),
            encrypted_location: None,
        };
        let first = store
            .create_memory(&principal, make())
            .await
            .expect("write succeeds");
        let second = store
            .create_memory(&principal, make())
            .await
            .expect("write succeeds");
        assert_eq!(
            first.uuid, second.uuid,
            "a retry must not mint a new capture"
        );
    }

    /// REGRESSION (needs a database — see [`store`]): the cursor was read by a
    /// standalone `SELECT MAX(...)` before the writes were issued, so two
    /// concurrent writers could be handed the same cursor, or the one that
    /// committed second could hold the lower one. Delta reads compare strictly
    /// greater, so a device that read the snapshot in between skips that write
    /// permanently and the wearer loses a contact edit.
    ///
    /// Under the old ordering this goes red on the distinctness assertion; the
    /// fix is the cursor allocator's row lock, held inside the same transaction
    /// as the writes it stamps.
    #[tokio::test]
    async fn concurrent_writers_never_share_a_cursor() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let store = std::sync::Arc::new(store);
        let principal = format!("pg-cursor-{}", uuid::Uuid::new_v4());

        let writers: Vec<_> = (0..16)
            .map(|n| {
                let store = store.clone();
                let principal = principal.clone();
                tokio::spawn(async move {
                    store
                        .put_contacts(
                            &principal,
                            &pb::ContactList {
                                contacts: vec![named(&format!("Writer {n}"))],
                                ..Default::default()
                            },
                        )
                        .await
                        .expect("write succeeds")
                })
            })
            .collect();

        let mut cursors = Vec::new();
        for writer in writers {
            for record in writer.await.expect("writer task") {
                cursors.push(record.modified);
            }
        }
        cursors.sort_unstable();
        let mut distinct = cursors.clone();
        distinct.dedup();
        assert_eq!(
            distinct.len(),
            cursors.len(),
            "two writes sharing a cursor makes one of them invisible to a delta sync"
        );

        // And nothing landed at or below a sync point the device could already
        // hold: replaying any handed-out cursor still reaches every later write.
        let snapshot = store.contacts(&principal).await.unwrap();
        assert_eq!(snapshot.contacts.len(), 16);
        assert_eq!(cursors.last().copied(), snapshot.latest);
        for (index, cursor) in cursors.iter().enumerate() {
            assert_eq!(
                snapshot.contacts_since(Some(*cursor)).count(),
                cursors.len() - index - 1
            );
        }
    }

    /// The version the device reads back lives in the encoded `contact` blob,
    /// not the column — a rewrite that bumped only the column left the wearer's
    /// device believing the contact never changed.
    #[tokio::test]
    async fn the_stored_contact_carries_its_server_owned_version_and_cursor() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-ver-{}", uuid::Uuid::new_v4());
        let created = store
            .put_contacts(
                &principal,
                &pb::ContactList {
                    contacts: vec![named("Ada")],
                    ..Default::default()
                },
            )
            .await
            .expect("write succeeds");
        let id = created[0].contact.id.clone();

        store
            .put_contacts(
                &principal,
                &pb::ContactList {
                    contacts: vec![pb::Contact {
                        id: id.clone(),
                        // A client-asserted version is advisory.
                        version: 97,
                        ..named("Ada Lovelace")
                    }],
                    ..Default::default()
                },
            )
            .await
            .expect("write succeeds");

        let snapshot = store.contacts(&principal).await.unwrap();
        let stored = snapshot.find(&id).expect("the contact is still there");
        assert_eq!(stored.contact.version, 2, "the server owns `version`");
        assert_eq!(
            stored.contact.modified_at,
            Some(stored.modified.to_proto()),
            "the wire timestamp mirrors the stored cursor"
        );
    }

    /// A batch bigger than one statement still lands whole and stays idempotent
    /// even when the device repeats an identifier inside it — PostgreSQL rejects
    /// a multi-row upsert whose own rows collide, so this is what proves the
    /// batch is collapsed before it is issued.
    #[tokio::test]
    async fn a_large_repeating_batch_lands_whole_in_one_transaction() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-bulk-{}", uuid::Uuid::new_v4());

        let event = |id: &str, kind: &str| NotableEventRecord {
            event_identifier: id.to_owned(),
            originator_identifier: "camera".to_owned(),
            creation_time: Some(SyncTime::now()),
            event_type: kind.to_owned(),
            event_data: None,
            encrypted_event_data: None,
            encrypted_location: None,
            device_is_locked: false,
            ingested: SyncTime::now(),
            indexed_text: None,
        };

        let distinct = crate::store::INGEST_CHUNK * 2 + 7;
        let mut batch: Vec<_> = (0..distinct)
            .map(|n| event(&format!("e{n}"), "photo"))
            .collect();
        // The same identifier again, inside the same chunk and across chunks.
        batch.push(event("e0", "video"));
        batch.push(event(&format!("e{}", distinct - 1), "video"));

        let stored = store
            .ingest_events(&principal, &batch)
            .await
            .expect("write succeeds");
        assert_eq!(stored.len(), distinct, "one ack per distinct identifier");
        let found = store
            .query_events(&principal, "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(found.len(), distinct);
        assert_eq!(
            found
                .iter()
                .find(|e| e.event_identifier == "e0")
                .expect("e0")
                .event_type,
            "video",
            "last writer wins inside a batch too"
        );
    }

    #[tokio::test]
    async fn a_capture_delete_and_upload_completion_are_recorded() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-mem-{}", uuid::Uuid::new_v4());
        let new = |device_local_id: &str| NewMemory {
            kind: MemoryKind::Photo,
            device_local_id: device_local_id.to_owned(),
            bursts: 1,
            files_per_burst: 1,
            device_created_time: None,
            gmt_offset: 0,
            thumbnails: Vec::new(),
            encrypted_location: None,
        };

        let uploaded = store
            .create_memory(&principal, new("device-1"))
            .await
            .expect("write succeeds");
        assert!(
            store
                .record_upload_complete(&principal, &uploaded.uuid)
                .await
                .expect("write succeeds")
        );
        assert!(
            store
                .memory(&principal, &uploaded.uuid)
                .await
                .expect("store read")
                .expect("stored")
                .upload_complete
        );

        let removed = store
            .create_memory(&principal, new("device-2"))
            .await
            .expect("write succeeds");
        assert!(
            store
                .delete_memory(&principal, &removed.uuid)
                .await
                .expect("write succeeds")
        );
        assert!(
            store
                .memory(&principal, &removed.uuid)
                .await
                .unwrap()
                .is_none()
        );
        // A second delete is "wasn't there", never a second fabricated success.
        assert!(
            !store
                .delete_memory(&principal, &removed.uuid)
                .await
                .expect("write succeeds")
        );
    }

    /// The listing path, end to end against real SQL.
    ///
    /// It is all new statements — a kind filter bound as an array, a
    /// `LIMIT/OFFSET` window, a count that has to stay right on a page past the
    /// end, and a thumbnail count read as a scalar rather than out of the blob.
    /// None of that is exercised by the in-memory store, and a typo in any of it
    /// is a runtime error on the wearer's dashboard, not a compile error.
    #[tokio::test]
    async fn a_capture_page_is_bounded_filtered_and_counted_in_sql() {
        let Some(store) = store().await else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-page-{}", uuid::Uuid::new_v4());
        let sealed = |byte: u8| EncryptedData {
            data: vec![byte; 8],
            ..Default::default()
        };
        for index in 0..5u8 {
            store
                .create_memory(
                    &principal,
                    NewMemory {
                        kind: if index < 3 {
                            MemoryKind::Photo
                        } else {
                            MemoryKind::FoodLog
                        },
                        device_local_id: format!("device-{index}"),
                        bursts: 1,
                        files_per_burst: 2,
                        device_created_time: Some(SyncTime::from_parts(
                            1_700_000_000 + i64::from(index),
                            0,
                        )),
                        gmt_offset: 0,
                        thumbnails: vec![sealed(index), sealed(index + 100)],
                        encrypted_location: None,
                    },
                )
                .await
                .expect("write succeeds");
        }

        assert_eq!(store.count_memories(&principal, &[]).await.unwrap(), 5);
        assert_eq!(
            store
                .count_memories(&principal, &[MemoryKind::Photo, MemoryKind::Video])
                .await
                .unwrap(),
            3,
            "an empty kind slice means every kind; a set one must actually filter"
        );

        let first = store
            .memory_page(&principal, &[], 0, 2)
            .await
            .expect("page reads");
        assert_eq!(first.records.len(), 2, "the window bounds the rows");
        assert_eq!(
            first.total, 5,
            "the total is of everything, not of the page"
        );
        assert_eq!(
            first.records[0].device_local_id, "device-4",
            "newest first, on the device's own creation time"
        );
        assert_eq!(
            first.records[0].thumbnail_count, 2,
            "the count comes back without the frames"
        );
        // `device-4` is a food log, and `build_memory` allocates no upload slots
        // for those — so the summary has to report that faithfully rather than
        // assume every capture has a burst.
        assert_eq!(first.records[0].frame_count, 0);
        assert_eq!(first.records[0].burst_count, 0);

        // A page past the end is empty AND still reports the true total — the
        // reason the count is a separate statement rather than a window
        // function over the returned rows.
        let past_end = store
            .memory_page(&principal, &[], 100, 2)
            .await
            .expect("page reads");
        assert!(past_end.records.is_empty());
        assert_eq!(past_end.total, 5);

        let photos = store
            .memory_page(&principal, &[MemoryKind::Photo], 0, 10)
            .await
            .expect("page reads");
        assert_eq!(photos.records.len(), 3);
        assert_eq!(
            photos.total, 3,
            "filtering in the store keeps the envelope's total honest too"
        );
        assert_eq!(
            photos.records[0].frame_count, 2,
            "one burst of two upload slots, decoded from the bursts column"
        );
        assert_eq!(photos.records[0].burst_count, 1);

        // One frame, by ordinal, without opening the rest of the burst.
        let uuid = photos.records[0].uuid.clone();
        let frame = store
            .memory_thumbnail(&principal, &uuid, 1)
            .await
            .expect("frame reads")
            .expect("the capture has a second frame");
        assert_eq!(frame.data.len(), 8);
        assert!(
            store
                .memory_thumbnail(&principal, &uuid, 9)
                .await
                .expect("frame reads")
                .is_none(),
            "an ordinal past the burst is absence, not an error"
        );
        assert!(
            store
                .memory_thumbnail(&principal, "no-such-capture", 0)
                .await
                .expect("frame reads")
                .is_none()
        );
        // A tombstoned capture has no frames to serve.
        assert!(store.delete_memory(&principal, &uuid).await.unwrap());
        assert!(
            store
                .memory_thumbnail(&principal, &uuid, 0)
                .await
                .expect("frame reads")
                .is_none()
        );
        assert_eq!(store.count_memories(&principal, &[]).await.unwrap(), 4);
    }

    /// A capture stored before `thumbnail_count` existed must still report the
    /// right number.
    ///
    /// The column is nullable precisely so those rows are not claimed to have
    /// zero frames, and the read path falls back to counting the stored array
    /// inside PostgreSQL. This nulls the scalar on a real row to reproduce that
    /// state, then checks the fallback and the repair that clears it.
    #[tokio::test]
    async fn a_capture_written_before_the_count_column_still_counts_its_frames() {
        let Some(store) = store().await else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-backfill-{}", uuid::Uuid::new_v4());
        let created = store
            .create_memory(
                &principal,
                NewMemory {
                    kind: MemoryKind::Photo,
                    device_local_id: "device-legacy".to_owned(),
                    bursts: 1,
                    files_per_burst: 3,
                    device_created_time: None,
                    gmt_offset: 0,
                    thumbnails: vec![
                        EncryptedData {
                            data: vec![1; 4],
                            ..Default::default()
                        },
                        EncryptedData {
                            data: vec![2; 4],
                            ..Default::default()
                        },
                        EncryptedData {
                            data: vec![3; 4],
                            ..Default::default()
                        },
                    ],
                    encrypted_location: None,
                },
            )
            .await
            .expect("write succeeds");

        sqlx::query("UPDATE cosmos_memory SET thumbnail_count = NULL WHERE principal = $1")
            .bind(&principal)
            .execute(&store.pool)
            .await
            .expect("simulate a row from before the column existed");

        let page = store
            .memory_page(&principal, &[], 0, 10)
            .await
            .expect("page reads");
        assert_eq!(
            page.records[0].thumbnail_count, 3,
            "a NULL scalar must fall back to the stored array, not read as zero"
        );

        store.backfill_thumbnail_counts().await;
        let repaired: Option<i32> =
            sqlx::query_scalar("SELECT thumbnail_count FROM cosmos_memory WHERE principal = $1")
                .bind(&principal)
                .fetch_one(&store.pool)
                .await
                .expect("read the repaired scalar");
        assert_eq!(
            repaired,
            Some(3),
            "the repair fills the scalar so later listings never touch the blob"
        );
        assert_eq!(created.thumbnails.len(), 3);
    }

    /// REGRESSION: `recent_notes` shipped and decoded the wearer's WHOLE note
    /// table on every assistant turn.
    ///
    /// Asserted against the source rather than against a database because the
    /// defect is invisible to a behavioural assertion: the Rust-side `truncate`
    /// returned the correct rows, in the correct order, at any table size — it
    /// just paid for all of them first. Only the statement itself distinguishes
    /// the two, and this is the same shape as
    /// `migration_schema_ddl_exists_only_in_numbered_sql_files` above: read the
    /// production half of this file and check what it actually asks Postgres for.
    #[test]
    fn recent_notes_bounds_its_read_in_sql() {
        let source = include_str!("store_postgres.rs");
        let production = source
            .rsplit_once("\n#[cfg(test)]\nmod tests {")
            .map_or(source, |(production, _)| production);
        let start = production
            .find("async fn recent_notes")
            .expect("recent_notes is defined here");
        let end = production[start..]
            .find("async fn note_page")
            .expect("note_page follows it")
            + start;
        let body = &production[start..end];

        assert!(
            body.contains("LIMIT $4"),
            "recent_notes must bind its bound into the statement; without it the \
             wearer's entire note table crosses the wire and is prost-decoded on \
             the assistant's latency path, on every turn, forever: {body}"
        );
        assert!(
            !body.contains(concat!("SELECT ", "*")),
            "recent_notes must name the columns its decoder reads: {body}"
        );
    }

    /// The bound must not change what the caller gets back: newest first, and a
    /// non-positive `max_items` still means unbounded. Same contract, and same
    /// proof, as the event query below.
    #[tokio::test]
    async fn a_bounded_note_read_keeps_the_newest_and_zero_still_means_all() {
        let Some(store) = store().await else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-notes-{}", uuid::Uuid::new_v4());
        let mut written = Vec::new();
        for _ in 0..6 {
            written.push(
                store
                    .create_note(&principal, None, None)
                    .await
                    .expect("note write succeeds")
                    .uuid,
            );
        }

        let bounded = store
            .recent_notes(&principal, 2, None, None)
            .await
            .expect("read succeeds");
        assert_eq!(
            bounded.iter().map(|n| n.uuid.as_str()).collect::<Vec<_>>(),
            vec![written[5].as_str(), written[4].as_str()],
            "the bound must keep the newest rows the ORDER BY chose"
        );

        let unbounded = store
            .recent_notes(&principal, 0, None, None)
            .await
            .expect("read succeeds");
        assert_eq!(
            unbounded.len(),
            6,
            "a non-positive bound still means no limit"
        );
    }

    /// `query_events` must bound its read in SQL, not by truncating afterwards.
    ///
    /// Truncating in Rust still read, decoded and sorted the whole partition —
    /// and Center issues four of these every five seconds. The observable proof
    /// of the push-down is that the rows kept are the NEWEST ones the ORDER BY
    /// selects, which is only true if `LIMIT` rides the same statement.
    #[tokio::test]
    async fn a_bounded_event_query_limits_in_sql_and_keeps_the_newest() {
        let Some(store) = store().await else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-events-{}", uuid::Uuid::new_v4());
        let events: Vec<NotableEventRecord> = (0..6i64)
            .map(|index| NotableEventRecord {
                event_identifier: format!("e{index}"),
                originator_identifier: "aimic".to_owned(),
                creation_time: Some(SyncTime::from_parts(1_700_000_000 + index, 0)),
                event_type: "utterance".to_owned(),
                event_data: None,
                encrypted_event_data: None,
                encrypted_location: None,
                device_is_locked: false,
                ingested: SyncTime::now(),
                indexed_text: None,
            })
            .collect();
        store
            .ingest_events(&principal, &events)
            .await
            .expect("ingest succeeds");

        let bounded = store
            .query_events(&principal, "", "", None, None, 2)
            .await
            .expect("query succeeds");
        assert_eq!(bounded.len(), 2);
        assert_eq!(
            bounded
                .iter()
                .map(|e| e.event_identifier.as_str())
                .collect::<Vec<_>>(),
            vec!["e5", "e4"],
            "the bound must keep the newest rows the ORDER BY chose"
        );

        let unbounded = store
            .query_events(&principal, "", "", None, None, 0)
            .await
            .expect("query succeeds");
        assert_eq!(
            unbounded.len(),
            6,
            "a non-positive bound still means no limit"
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
            store.record_upload_complete("wearer", "some-uuid").await,
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

    #[tokio::test]
    async fn events_upsert_and_notes_search() {
        let Some(store) = store().await else {
            // A silent `return` is indistinguishable from a pass in cargo's
            // output, so say so: this coverage did NOT run.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let principal = format!("pg-ev-{}", uuid::Uuid::new_v4());

        let record = |id: &str, kind: &str| NotableEventRecord {
            event_identifier: id.to_owned(),
            originator_identifier: "camera".to_owned(),
            creation_time: Some(SyncTime::now()),
            event_type: kind.to_owned(),
            event_data: None,
            encrypted_event_data: None,
            encrypted_location: None,
            device_is_locked: false,
            ingested: SyncTime::now(),
            indexed_text: None,
        };
        store
            .ingest_events(&principal, &[record("e1", "photo")])
            .await
            .expect("write succeeds");
        let mut updated = record("e1", "video");
        updated.indexed_text = Some("this is a test".to_owned());
        store
            .ingest_events(&principal, &[updated])
            .await
            .expect("write succeeds");
        let found = store
            .query_events(&principal, "", "", None, None, 0)
            .await
            .unwrap();
        assert_eq!(found.len(), 1, "the same identifier must not duplicate");
        assert_eq!(found[0].event_type, "video", "last writer wins");
        assert_eq!(
            found[0].indexed_text.as_deref(),
            Some("this is a test"),
            "the search projection must survive the PostgreSQL upsert/read path"
        );

        // An event with no identifier has no key.
        // An event with no identifier has no key: dropped, not acknowledged.
        assert!(
            store
                .ingest_events(&principal, &[record("", "photo")])
                .await
                .expect("write succeeds")
                .is_empty()
        );

        let note = store.create_note(&principal, None, None).await.unwrap();
        store
            .index_note(&principal, &note.uuid, "remember the milk")
            .await;
        assert_eq!(
            store.search_notes(&principal, "milk", 0).await.unwrap(),
            vec![note.uuid.clone()]
        );
        assert!(
            store
                .search_notes(&principal, "bicycle", 0)
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// A DELETE IS SCOPED TO THE CALLER, AND THE ROW REALLY GOES.
    ///
    /// Both statements contain a `WHERE principal` predicate and answer from their
    /// own row count. Dropping that predicate would let one account erase
    /// another's My Data row by guessing an identifier — so B here deletes with
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
        let note = store.create_note(&a, None, None).await.unwrap();

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
    /// answers that used to diverge — the Postgres reads swallowed their errors
    /// and reported an outage as absence, while the in-memory store cannot fail
    /// and so always reported genuine absence.
    ///
    /// Absence is asserted here against BOTH backends; the failure half is
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
                backend.record_upload_complete(&principal, "nope").await,
                Ok(false)
            );
            // Same for the two web-boundary deletes: `false` is "nothing of
            // yours matched", which is what an empty account must answer.
            assert_eq!(backend.delete_note(&principal, "nope").await, Ok(false));
            assert_eq!(backend.delete_event(&principal, "nope").await, Ok(false));
        }
    }
}
