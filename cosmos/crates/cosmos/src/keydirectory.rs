//! Key material shared **across workloads**.
//!
//! [`crate::keymaterial::KeyMaterial`] is correct for the AI-bus path, where the
//! privacy service that imports a channel key and the `Encrypted*` handlers that
//! use it run in the same process. It is process-local by construction, and that
//! is the whole problem for anything else: `PublicPrivacyService.ImportKeys` is
//! served only by the AI-bus workload, so a key the device escrows arrives in one
//! process and is invisible to every other. Contacts — a separate workload — can
//! therefore never open a sealed contact, no matter what the device uploaded.
//!
//! Real carry did not have this problem: its services asked the privacy service
//! for keys (`ISynchronousPrivacyKeyClient` is the device-side half of exactly
//! that shape). This module is the clone's equivalent — one directory, written by
//! whoever imports a key, readable by whoever needs to open something sealed
//! under it.
//!
//! # Why the device escrows keys at all
//!
//! It refuses to do otherwise. `KryptoDataProtector.generateKey`
//! (`humaneinternal/system/dataprotection/KryptoDataProtector.java:46-80`) mints
//! the C1 user-data key, registers it, and then **deletes the key and fails the
//! operation** unless `keyInfo.isUploaded()`. A device will not protect data
//! under a key the server does not hold. That is what makes
//! `server_should_decrypt = true` a coherent request rather than an impossible
//! one.
//!
//! # Storage
//!
//! Postgres when `CARRY_DATABASE_URL` is set, memory otherwise. The memory case
//! is not a degraded mode to be papered over: it is correct for a single-workload
//! deployment and for tests, and it is *not* correct across workloads — which is
//! why [`KeyDirectory::is_shared`] exists and why callers say so in their logs
//! rather than silently returning "no key".
//!
//! Keys are never logged, never returned by an RPC, and never put on the wire.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use cosmos_crypto::AES_KEY_LEN;

/// `kid -> channel key`, shared by every workload pointed at the same database.
pub struct KeyDirectory {
    memory: Mutex<BTreeMap<String, [u8; AES_KEY_LEN]>>,
    pool: Option<sqlx::PgPool>,
}

pub(crate) const KEY_DIRECTORY_MIGRATIONS: &[crate::store_postgres::EmbeddedMigration] =
    &[crate::store_postgres::EmbeddedMigration::new(
        3,
        "0003_key_directory.sql",
        include_str!("../../../migrations/0003_key_directory.sql"),
    )];

impl KeyDirectory {
    /// Memory-only. Correct for tests and single-workload deployments.
    pub fn in_memory() -> Self {
        Self {
            memory: Mutex::new(BTreeMap::new()),
            pool: None,
        }
    }

    /// Back the directory with Postgres, creating the table if absent.
    pub async fn connect(url: &str) -> Result<Self, sqlx::Error> {
        let pool = sqlx::PgPool::connect(url).await?;
        for migration in KEY_DIRECTORY_MIGRATIONS {
            for statement in migration.statements() {
                sqlx::query(statement).execute(&pool).await?;
            }
        }
        Ok(Self {
            memory: Mutex::new(BTreeMap::new()),
            pool: Some(pool),
        })
    }

    /// Build from the environment, falling back to memory.
    ///
    /// A failure to reach a database that WAS configured is loud: the operator
    /// asked for shared keys, and silently degrading to process-local ones would
    /// present later as "the wearer has no contacts".
    pub async fn configured() -> Arc<Self> {
        match std::env::var(crate::store_postgres::DATABASE_URL_ENV) {
            Ok(url) if !url.trim().is_empty() => match Self::connect(&url).await {
                Ok(directory) => Arc::new(directory),
                Err(error) => {
                    tracing::error!(
                        %error,
                        "key directory: database configured but unreachable; keys will NOT be \
                         shared between workloads and sealed data will read as absent"
                    );
                    Arc::new(Self::in_memory())
                }
            },
            _ => Arc::new(Self::in_memory()),
        }
    }

    /// Whether this directory is visible to other workloads.
    pub fn is_shared(&self) -> bool {
        self.pool.is_some()
    }

    /// Record a key. Write-through: memory stays a cache of what is durable.
    pub async fn put(&self, kid: &str, key: [u8; AES_KEY_LEN]) {
        if let Some(pool) = &self.pool {
            let stored = sqlx::query(
                "INSERT INTO carry_channel_key (kid, key) VALUES ($1, $2)
                 ON CONFLICT (kid) DO UPDATE SET key = EXCLUDED.key",
            )
            .bind(kid)
            .bind(key.as_slice())
            .execute(pool)
            .await;
            if let Err(error) = stored {
                // Not fatal — the in-memory copy still serves this process — but
                // the cross-workload promise is broken and must not be silent.
                tracing::error!(%error, "key directory: could not persist an imported key");
            }
        }
        self.memory
            .lock()
            .expect("key directory is not poisoned")
            .insert(kid.to_owned(), key);
    }

    /// Look a key up, consulting the database only when this process has not seen
    /// it — which is exactly the cross-workload case.
    pub async fn get(&self, kid: &str) -> Option<[u8; AES_KEY_LEN]> {
        if let Some(key) = self
            .memory
            .lock()
            .expect("key directory is not poisoned")
            .get(kid)
            .copied()
        {
            return Some(key);
        }
        let pool = self.pool.as_ref()?;
        let row =
            sqlx::query_as::<_, (Vec<u8>,)>("SELECT key FROM carry_channel_key WHERE kid = $1")
                .bind(kid)
                .fetch_optional(pool)
                .await
                .unwrap_or_else(|error| {
                    tracing::error!(%error, "key directory: lookup failed");
                    None
                })?;
        let key: [u8; AES_KEY_LEN] = row.0.as_slice().try_into().ok()?;
        self.memory
            .lock()
            .expect("key directory is not poisoned")
            .insert(kid.to_owned(), key);
        Some(key)
    }

    /// Open a sealed payload, if this directory holds the key it names.
    ///
    /// `None` means "not ours to read", which is a different thing from an error:
    /// a deployment that never received the device's key is expected to be unable
    /// to open its data, and must relay it sealed rather than dropping it.
    pub async fn open(&self, data: &cosmos_crypto::EncryptedData) -> Option<Vec<u8>> {
        let key = self.get(&data.kid).await?;
        match cosmos_crypto::open(&key, data) {
            Ok(plaintext) => Some(plaintext),
            Err(error) => {
                // Holding the named key and still failing to open is a real
                // fault (wrong key for the kid, or a corrupted payload), not the
                // ordinary "we were never given it" case.
                tracing::warn!(%error, kid = %data.kid, "key directory: held the key but could not open");
                None
            }
        }
    }
}

pub type SharedKeyDirectory = Arc<KeyDirectory>;

#[cfg(test)]
mod tests {
    use super::*;

    fn sealed(kid: &str, key: [u8; AES_KEY_LEN], plaintext: &[u8]) -> cosmos_crypto::EncryptedData {
        let aad = b"humane.contacts.Contact";
        cosmos_crypto::seal(kid, &key, plaintext, aad).expect("seal")
    }

    #[tokio::test]
    async fn a_key_put_by_one_holder_opens_data_sealed_under_it() {
        let directory = KeyDirectory::in_memory();
        let key = [7u8; AES_KEY_LEN];
        directory.put("kid-1", key).await;

        let opened = directory.open(&sealed("kid-1", key, b"a contact")).await;
        assert_eq!(opened.as_deref(), Some(&b"a contact"[..]));
    }

    #[tokio::test]
    async fn an_unknown_kid_reads_as_absent_rather_than_an_error() {
        let directory = KeyDirectory::in_memory();
        // Sealed under a key this directory was never given — the ordinary case
        // for a device that enrolled somewhere else.
        let opened = directory
            .open(&sealed("kid-unknown", [9u8; AES_KEY_LEN], b"not ours"))
            .await;
        assert!(
            opened.is_none(),
            "data we hold no key for must read as absent, not decrypt to something"
        );
    }

    #[tokio::test]
    async fn a_memory_directory_says_it_is_not_shared() {
        assert!(
            !KeyDirectory::in_memory().is_shared(),
            "a process-local directory must not claim to be visible to other workloads"
        );
    }

    /// The cross-workload property, against a real database: a key written by one
    /// directory handle is readable by a second, independent one — the two stand
    /// in for two workloads.
    #[tokio::test]
    async fn a_second_workload_reads_a_key_the_first_imported() {
        let Ok(url) = std::env::var("CARRY_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set CARRY_TEST_DATABASE_URL to exercise the shared key directory");
            return;
        };
        let importer = KeyDirectory::connect(&url).await.expect("connect");
        let key = [3u8; AES_KEY_LEN];
        let kid = format!("kid-{}", uuid::Uuid::new_v4());
        importer.put(&kid, key).await;

        // A separate handle with an empty memory cache: the only way it can
        // answer is out of the database.
        let reader = KeyDirectory::connect(&url).await.expect("connect");
        assert!(reader.is_shared());
        let opened = reader
            .open(&sealed(&kid, key, b"sealed by another workload"))
            .await;
        assert_eq!(
            opened.as_deref(),
            Some(&b"sealed by another workload"[..]),
            "a key imported by one workload must open data in another"
        );
    }
}
