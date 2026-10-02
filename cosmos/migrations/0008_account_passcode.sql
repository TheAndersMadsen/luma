-- cosmos:statement
-- One OPAQUE password file per account, registered when the owner sets their
-- Pin passcode in Center. The passcode itself is never stored. This replaces
-- cosmos_opaque_password_file, whose records were fabricated from the retired
-- deployment-wide enrollment pincode and are no longer read by anything.
CREATE TABLE IF NOT EXISTS cosmos_account_passcode (
    account_sub TEXT PRIMARY KEY,
    record BYTEA NOT NULL
);
