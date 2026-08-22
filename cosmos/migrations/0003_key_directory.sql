-- cosmos:statement
CREATE TABLE IF NOT EXISTS carry_channel_key (
    kid TEXT PRIMARY KEY,
    key BYTEA NOT NULL
);
