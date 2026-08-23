-- cosmos:statement
-- A capture's thumbnail COUNT, stored beside the frames rather than derived from
-- them. `thumbnails` holds every sealed JPEG of the capture as a JSON array of
-- decimal byte values (roughly four stored bytes per byte of image), and the
-- listing endpoints render only `thumbnailCount` — so computing that integer
-- used to detoast, JSON-parse and prost-decode every frame the wearer owns, on
-- an endpoint the dashboard polls every five seconds.
--
-- Nullable on purpose: rows written before this column existed remain NULL, and
-- the read path falls back to counting the array inside PostgreSQL until
-- `backfill_thumbnail_counts` fills them in. A NOT NULL DEFAULT 0 would have
-- claimed those captures have no frames.
ALTER TABLE IF EXISTS cosmos_memory
    ADD COLUMN IF NOT EXISTS thumbnail_count INTEGER;

-- cosmos:statement
-- The ordering `query_events` asks for. `cosmos_event`'s only index was its
-- primary key `(principal, event_identifier)`, so every QueryEvents sorted the
-- whole partition. The NULLS LAST here must match the ORDER BY in the query or
-- the planner will not use the index for it.
CREATE INDEX IF NOT EXISTS cosmos_event_recent
    ON cosmos_event (principal, originator_identifier,
                    creation_seconds DESC NULLS LAST, creation_nanos DESC);

-- cosmos:statement
-- The ordering `memory_page` asks for, over live rows only. COALESCE is
-- immutable, so it is indexable; the partial predicate matches the listing's own
-- `deleted_seconds IS NULL` so a tombstoned capture costs nothing to skip.
CREATE INDEX IF NOT EXISTS cosmos_memory_recent
    ON cosmos_memory (principal,
                     COALESCE(device_created_seconds, created_seconds) DESC,
                     numeric_id DESC)
    WHERE deleted_seconds IS NULL;

-- cosmos:statement
-- The ordering `note_page` asks for.
CREATE INDEX IF NOT EXISTS cosmos_note_recent
    ON cosmos_note (principal, created_seconds DESC, created_nanos DESC);
