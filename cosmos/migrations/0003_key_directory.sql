-- cosmos:statement
CREATE TABLE IF NOT EXISTS cosmos_channel_key (
    kid TEXT PRIMARY KEY,
    key BYTEA NOT NULL
);
