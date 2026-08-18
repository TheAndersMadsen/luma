-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_opaque_setup (
    id TEXT PRIMARY KEY,
    setup BYTEA NOT NULL
);

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_opaque_password_file (
    credential_id BYTEA PRIMARY KEY,
    record BYTEA NOT NULL
);

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_opaque_login (
    principal TEXT PRIMARY KEY,
    state BYTEA NOT NULL,
    written_epoch BIGINT NOT NULL
);

-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_opaque_session (
    principal TEXT PRIMARY KEY,
    session_key BYTEA NOT NULL,
    written_epoch BIGINT NOT NULL
);

-- cosmos:statement
-- The attempt ceiling is shared. A per-process counter against multiple replicas
-- would multiply the number of guesses by the replica count.
CREATE TABLE IF NOT EXISTS cosmos_opaque_login_attempt (
    principal TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    window_start_epoch BIGINT NOT NULL
);

-- cosmos:statement
-- Pair an edge-authenticated device with its account. The authenticated device
-- identity, rather than a caller-controlled value, is the primary key.
CREATE TABLE IF NOT EXISTS cosmos_device_account (
    device_id TEXT PRIMARY KEY,
    account_sub TEXT NOT NULL,
    paired_at_epoch BIGINT NOT NULL
);
