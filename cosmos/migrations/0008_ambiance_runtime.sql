-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_ambiance_runtime (
    principal TEXT PRIMARY KEY REFERENCES cosmos_surface_head(principal),
    state JSONB NOT NULL
);

-- cosmos:statement
ALTER TABLE IF EXISTS cosmos_ambiance_runtime
    ADD COLUMN IF NOT EXISTS next_maintenance_ms BIGINT NOT NULL DEFAULT 0;

-- cosmos:statement
CREATE INDEX IF NOT EXISTS cosmos_ambiance_due
    ON cosmos_ambiance_runtime (next_maintenance_ms, principal);
