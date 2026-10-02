-- cosmos:statement
-- INFERRED Luma admission policy: one physical Pin for the entire server.
-- The boolean primary key and CHECK permit exactly one row across replicas.
-- Unpairing does not release the slot or revoke issued credentials.
CREATE TABLE IF NOT EXISTS cosmos_provisioned_pin (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    device_id TEXT NOT NULL
);
