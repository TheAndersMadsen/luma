-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_contact (
    principal TEXT NOT NULL,
    id TEXT NOT NULL,
    contact BYTEA NOT NULL,
    version INTEGER NOT NULL,
    modified_seconds BIGINT NOT NULL,
    modified_nanos INTEGER NOT NULL,
    PRIMARY KEY (principal, id)
);

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_contact_encrypted (
    principal TEXT NOT NULL,
    ciphertext BYTEA NOT NULL,
    version INTEGER NOT NULL,
    modified_seconds BIGINT NOT NULL,
    modified_nanos INTEGER NOT NULL,
    PRIMARY KEY (principal, ciphertext)
);

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_contact_tombstone (
    principal TEXT NOT NULL,
    id TEXT NOT NULL,
    deleted_seconds BIGINT NOT NULL,
    deleted_nanos INTEGER NOT NULL,
    PRIMARY KEY (principal, id)
);

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_memory (
    principal TEXT NOT NULL,
    uuid TEXT NOT NULL,
    numeric_id BIGINT NOT NULL,
    device_local_id TEXT NOT NULL,
    kind SMALLINT NOT NULL,
    created_seconds BIGINT NOT NULL,
    created_nanos INTEGER NOT NULL,
    device_created_seconds BIGINT,
    device_created_nanos INTEGER,
    gmt_offset INTEGER NOT NULL,
    thumbnails BYTEA NOT NULL,
    encrypted_location BYTEA,
    bursts BYTEA NOT NULL,
    upload_complete BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_seconds BIGINT,
    deleted_nanos INTEGER,
    PRIMARY KEY (principal, uuid)
);

-- cosmos:statement
CREATE UNIQUE INDEX IF NOT EXISTS cosmos_memory_device_local
    ON cosmos_memory (principal, device_local_id)
    WHERE device_local_id <> '' AND deleted_seconds IS NULL;

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_note (
    principal TEXT NOT NULL,
    uuid TEXT NOT NULL,
    indexed_text TEXT,
    encrypted_note BYTEA,
    encrypted_location BYTEA,
    created_seconds BIGINT NOT NULL,
    created_nanos INTEGER NOT NULL,
    PRIMARY KEY (principal, uuid)
);

-- cosmos:statement
-- Keep this before the table creation: it upgrades a table created by an older
-- release, while remaining a no-op for a fresh database.
ALTER TABLE IF EXISTS cosmos_event
    ADD COLUMN IF NOT EXISTS indexed_text TEXT;

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_event (
    principal TEXT NOT NULL,
    event_identifier TEXT NOT NULL,
    originator_identifier TEXT NOT NULL,
    creation_seconds BIGINT,
    creation_nanos INTEGER,
    event_type TEXT NOT NULL,
    event_data BYTEA,
    encrypted_event_data BYTEA,
    encrypted_location BYTEA,
    device_is_locked BOOLEAN NOT NULL,
    -- Searchable text opened from encrypted_event_data at ingest. The device
    -- clears the plaintext copy before sending, so otherwise it cannot be searched.
    indexed_text TEXT,
    ingested_seconds BIGINT NOT NULL,
    ingested_nanos INTEGER NOT NULL,
    PRIMARY KEY (principal, event_identifier)
);

-- cosmos:statement
-- One row per principal. This is an allocator, not a cache: callers raise it in
-- the transaction that carries the write so cursor assignment remains ordered.
CREATE TABLE IF NOT EXISTS cosmos_sync_cursor (
    principal TEXT PRIMARY KEY,
    cursor_nanos BIGINT NOT NULL
);

-- cosmos:statement
-- Seed once from cursors written by the older MAX-based scheme. ON CONFLICT
-- makes every later startup a no-op and preserves an existing higher cursor.
INSERT INTO cosmos_sync_cursor (principal, cursor_nanos)
SELECT principal, MAX(cursor_nanos) FROM (
    SELECT principal, MAX(modified_seconds * 1000000000 + modified_nanos) AS cursor_nanos
      FROM cosmos_contact GROUP BY principal
    UNION ALL
    SELECT principal, MAX(modified_seconds * 1000000000 + modified_nanos)
      FROM cosmos_contact_encrypted GROUP BY principal
    UNION ALL
    SELECT principal, MAX(deleted_seconds * 1000000000 + deleted_nanos)
      FROM cosmos_contact_tombstone GROUP BY principal
) existing GROUP BY principal
ON CONFLICT (principal) DO NOTHING;

-- cosmos:statement
CREATE SEQUENCE IF NOT EXISTS cosmos_memory_id_seq;

-- cosmos:statement
-- The account payload is sealed for a service key and remains opaque here, so
-- it is stored whole rather than split into columns Cosmos cannot interpret.
CREATE TABLE IF NOT EXISTS cosmos_account_blob (
    principal TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload BYTEA NOT NULL,
    PRIMARY KEY (principal, kind)
);
