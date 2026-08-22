-- cosmos:statement
-- Channel ids are attacker-supplied bytes at the RPC edge. The runtime checks
-- these bounds before every lookup/mutation; the database repeats them so an
-- alternate writer cannot create state no serving process can safely address.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'carry_channel_key_shape'
          AND conrelid = 'carry_channel_key'::regclass
    ) THEN
        ALTER TABLE carry_channel_key
            ADD CONSTRAINT carry_channel_key_shape
            CHECK (
                octet_length(kid) BETWEEN 1 AND 1024
                AND octet_length(key) = 16
            );
    END IF;
END
$$;
