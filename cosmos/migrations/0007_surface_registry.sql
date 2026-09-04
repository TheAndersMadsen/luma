-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_surface_head (
    principal TEXT PRIMARY KEY,
    sequence BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0),
    hash TEXT NOT NULL DEFAULT ''
);

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_surface_registry (
    principal TEXT NOT NULL REFERENCES cosmos_surface_head(principal),
    surface_id UUID NOT NULL,
    record JSONB NOT NULL,
    PRIMARY KEY (principal, surface_id)
);

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_surface_event (
    principal TEXT NOT NULL REFERENCES cosmos_surface_head(principal),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    hash TEXT NOT NULL,
    event JSONB NOT NULL,
    PRIMARY KEY (principal, sequence)
);

-- cosmos:statement
CREATE INDEX IF NOT EXISTS cosmos_surface_active
    ON cosmos_surface_registry (principal, surface_id)
    WHERE record->>'revoked' = 'false';
