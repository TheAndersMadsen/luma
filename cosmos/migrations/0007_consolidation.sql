-- cosmos:statement
-- Notes the web and the assistant write are server-held plaintext, so the
-- wearer's own casing, a title, an edit time and where the note came from are
-- stored beside the lowercase search index instead of being folded into it.
-- `location` is the prost-encoded `humane.common.encryption.LocationEnvelope`
-- the notes quick action sends in `FunctionCall.location`
-- (QuickActionRouter.handleNotesAction); `encrypted_location` stays the
-- device-sealed form. Every column is nullable or defaulted, so rows written
-- before this migration read back unchanged.
ALTER TABLE IF EXISTS cosmos_note
    ADD COLUMN IF NOT EXISTS title TEXT,
    ADD COLUMN IF NOT EXISTS body TEXT,
    ADD COLUMN IF NOT EXISTS source TEXT,
    ADD COLUMN IF NOT EXISTS modified_seconds BIGINT,
    ADD COLUMN IF NOT EXISTS modified_nanos INTEGER,
    ADD COLUMN IF NOT EXISTS time_zone TEXT,
    ADD COLUMN IF NOT EXISTS location BYTEA,
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- cosmos:statement
-- What `CreateMemory` carries beyond the index: the photo's per-frame
-- `ImageMetadata` list, `PhotoFileFormat`, LUT and key id, and the video's
-- count and duration (humane.capture.PhotoMemoryRequest /
-- VideoMemoryRequest). Plus the web-owned favourite flag and tags, and the
-- upload state `UploadComplete` reports. A NULL `upload_state` is a row written
-- before this column existed; it is read through `upload_complete`.
ALTER TABLE IF EXISTS cosmos_memory
    ADD COLUMN IF NOT EXISTS photo_metadatas BYTEA,
    ADD COLUMN IF NOT EXISTS format INTEGER,
    ADD COLUMN IF NOT EXISTS lut_name TEXT,
    ADD COLUMN IF NOT EXISTS encryption_kid TEXT,
    ADD COLUMN IF NOT EXISTS num_videos INTEGER,
    ADD COLUMN IF NOT EXISTS total_video_duration_sec INTEGER,
    ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS upload_state TEXT;

-- cosmos:statement
-- A capture the Pin has taken but not yet created in the cloud:
-- `CaptureService.DeclareMemoryCreateIntent{device_local_id, memory_type,
-- delay_reason}` (PhotographyManager, MemoryUploadIntentWorker). The row goes
-- when `CreateMemory` arrives with the same device-local id.
CREATE TABLE IF NOT EXISTS cosmos_pending_memory_create (
    principal TEXT NOT NULL,
    device_local_id TEXT NOT NULL,
    memory_type INTEGER NOT NULL,
    delay_reason INTEGER NOT NULL,
    declared_seconds BIGINT NOT NULL,
    declared_nanos INTEGER NOT NULL,
    PRIMARY KEY (principal, device_local_id)
);

-- cosmos:statement
-- The wearer's up/down vote on one My Data row, keyed exactly like the event it
-- rates so another account's identifier can never reach it.
CREATE TABLE IF NOT EXISTS cosmos_event_feedback (
    principal TEXT NOT NULL,
    event_identifier TEXT NOT NULL,
    vote SMALLINT NOT NULL,
    updated_seconds BIGINT NOT NULL,
    updated_nanos INTEGER NOT NULL,
    PRIMARY KEY (principal, event_identifier)
);

-- cosmos:statement
-- The ordering a type-set page and count ask for. `cosmos_event_recent` leads
-- with the originator, which a My Data domain does not filter on.
CREATE INDEX IF NOT EXISTS cosmos_event_type_recent
    ON cosmos_event (principal, event_type,
                    creation_seconds DESC NULLS LAST, creation_nanos DESC);
