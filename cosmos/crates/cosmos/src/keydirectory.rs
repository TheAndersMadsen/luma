//! Key material shared **across workloads**.
//!
//! This directory is the one channel-key authority. With PostgreSQL configured,
//! every lookup goes to the database: a process-local cache could otherwise keep
//! serving a key after another workload revoked or replaced it. The in-memory
//! implementation has the same API and is reserved for explicit local/test
//! topologies.
//!
//! Real cosmos did not have this problem: its services asked the privacy service
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
//! Postgres when `COSMOS_DATABASE_URL` is set, memory otherwise. Memory is an
//! explicit unconfigured/test topology only. A configured database that cannot
//! connect or migrate fails workload startup; falling back would make durable
//! cross-workload keys look absent while readiness claimed success.
//!
//! Keys are never logged, never returned by an RPC, and never put on the wire.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use cosmos_crypto::AES_KEY_LEN;

pub(crate) const MAX_DIRECTORY_KEYS: usize = 4_096;
pub(crate) const MAX_DIRECTORY_KID_BYTES: usize = 1_024;
pub(crate) const KEY_DIRECTORY_SCHEMA_LOCK_KEY: i64 = 0x0CA2_2451_0000_0003;
const KEY_DIRECTORY_MUTATION_LOCK_KEY: i64 = 0x0CA2_2451_0000_0004;

pub(crate) fn valid_directory_kid(kid: &str) -> bool {
    !kid.is_empty() && kid.len() <= MAX_DIRECTORY_KID_BYTES && !kid.chars().any(char::is_control)
}

/// `kid -> channel key`, shared by every workload pointed at the same database.
pub struct KeyDirectory {
    memory: Mutex<BTreeMap<String, [u8; AES_KEY_LEN]>>,
    pool: Option<sqlx::PgPool>,
    #[cfg(test)]
    fault: Mutex<Option<DirectoryFault>>,
}

#[derive(Debug, thiserror::Error)]
pub enum KeyDirectoryError {
    #[error("key-directory database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("key-directory row is malformed")]
    CorruptRow,
    #[error("key-directory held the named key but the payload could not be opened")]
    OpenFailed,
    #[error("legacy local channel-key snapshot disagrees with the authoritative directory")]
    ReconciliationMismatch,
    #[error("legacy local channel-key snapshot could not be stripped durably: {0}")]
    LocalPersistence(cosmos_crypto::CryptoError),
    #[error("channel-key id is empty, oversized, or contains controls")]
    InvalidKid,
    #[error("the authoritative channel-key directory reached its bounded cardinality")]
    DirectoryFull,
    #[cfg(test)]
    #[error("injected key-directory {0} failure")]
    Injected(&'static str),
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DirectoryFault {
    Put,
    PutAfterCommit,
    Remove,
    RemoveAfterCommit,
    Get,
}

pub(crate) const KEY_DIRECTORY_MIGRATIONS: &[crate::store_postgres::EmbeddedMigration] = &[
    crate::store_postgres::EmbeddedMigration::new(
        3,
        "0003_key_directory.sql",
        include_str!("../../../migrations/0003_key_directory.sql"),
    ),
    crate::store_postgres::EmbeddedMigration::new(
        6,
        "0006_key_directory_bounds.sql",
        include_str!("../../../migrations/0006_key_directory_bounds.sql"),
    ),
];

impl KeyDirectory {
    /// Memory-only. Reserved for explicit local and test topologies.
    pub fn in_memory() -> Self {
        Self {
            memory: Mutex::new(BTreeMap::new()),
            pool: None,
            #[cfg(test)]
            fault: Mutex::new(None),
        }
    }

    /// Snapshot a focused unit test's memory-only channel map into the test
    /// directory facade. This method does not exist in dependency/production
    /// builds; production constructors are always given the authoritative
    /// directory explicitly by `lib.rs`.
    #[cfg(test)]
    pub(crate) fn from_test_key_material(material: &crate::keymaterial::KeyMaterial) -> Self {
        let directory = Self::in_memory();
        let entries = material
            .legacy_channel_keys()
            .expect("focused test key material must be readable");
        directory
            .memory
            .lock()
            .expect("test key directory is not poisoned")
            .extend(entries);
        directory
    }

    /// Back the directory with Postgres, creating the table if absent.
    pub async fn connect(url: &str) -> Result<Self, sqlx::Error> {
        let pool = sqlx::PgPool::connect(url).await?;
        let mut tx = pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(KEY_DIRECTORY_SCHEMA_LOCK_KEY)
            .execute(&mut *tx)
            .await?;
        for migration in KEY_DIRECTORY_MIGRATIONS {
            for statement in migration.statements() {
                sqlx::query(statement).execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
        Ok(Self {
            memory: Mutex::new(BTreeMap::new()),
            pool: Some(pool),
            #[cfg(test)]
            fault: Mutex::new(None),
        })
    }

    /// Build from the environment, falling back to memory.
    ///
    /// A failure to reach a database that WAS configured is loud: the operator
    /// asked for shared keys, and silently degrading to process-local ones would
    /// present later as "the wearer has no contacts".
    pub async fn configured() -> Result<Arc<Self>, KeyDirectoryError> {
        let configured = std::env::var(crate::store_postgres::DATABASE_URL_ENV).ok();
        Self::configured_from(configured.as_deref()).await
    }

    pub(crate) async fn configured_from(url: Option<&str>) -> Result<Arc<Self>, KeyDirectoryError> {
        match url.map(str::trim).filter(|url| !url.is_empty()) {
            Some(url) => Ok(Arc::new(Self::connect(url).await?)),
            None => Ok(Arc::new(Self::in_memory())),
        }
    }

    /// Whether this directory is visible to other workloads.
    pub fn is_shared(&self) -> bool {
        self.pool.is_some()
    }

    /// Record a key in the sole authority. PostgreSQL-backed instances never
    /// mirror rows into process memory.
    pub async fn put(&self, kid: &str, key: [u8; AES_KEY_LEN]) -> Result<(), KeyDirectoryError> {
        if !valid_directory_kid(kid) {
            return Err(KeyDirectoryError::InvalidKid);
        }
        #[cfg(test)]
        if self.take_fault(DirectoryFault::Put) {
            return Err(KeyDirectoryError::Injected("put"));
        }
        if let Some(pool) = &self.pool {
            let mut tx = pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock($1)")
                .bind(KEY_DIRECTORY_MUTATION_LOCK_KEY)
                .execute(&mut *tx)
                .await?;
            let (exists,) = sqlx::query_as::<_, (bool,)>(
                "SELECT EXISTS (SELECT 1 FROM carry_channel_key WHERE kid = $1)",
            )
            .bind(kid)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                let (count,) =
                    sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM carry_channel_key")
                        .fetch_one(&mut *tx)
                        .await?;
                if count >= MAX_DIRECTORY_KEYS as i64 {
                    return Err(KeyDirectoryError::DirectoryFull);
                }
            }
            sqlx::query(
                "INSERT INTO carry_channel_key (kid, key) VALUES ($1, $2)
                 ON CONFLICT (kid) DO UPDATE SET key = EXCLUDED.key",
            )
            .bind(kid)
            .bind(key.as_slice())
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
        }
        if self.pool.is_none() {
            let mut memory = self.memory.lock().expect("key directory is not poisoned");
            if !memory.contains_key(kid) && memory.len() >= MAX_DIRECTORY_KEYS {
                return Err(KeyDirectoryError::DirectoryFull);
            }
            memory.insert(kid.to_owned(), key);
        }
        #[cfg(test)]
        if self.take_fault(DirectoryFault::PutAfterCommit) {
            return Err(KeyDirectoryError::Injected("put after commit"));
        }
        Ok(())
    }

    /// Remove a key from the sole authority. Deleting a missing row is success,
    /// making retries and stale directory-only cleanup safe.
    pub async fn remove(&self, kid: &str) -> Result<bool, KeyDirectoryError> {
        if !valid_directory_kid(kid) {
            return Err(KeyDirectoryError::InvalidKid);
        }
        #[cfg(test)]
        if self.take_fault(DirectoryFault::Remove) {
            return Err(KeyDirectoryError::Injected("remove"));
        }
        let durable_removed = if let Some(pool) = &self.pool {
            sqlx::query("DELETE FROM carry_channel_key WHERE kid = $1")
                .bind(kid)
                .execute(pool)
                .await?
                .rows_affected()
                > 0
        } else {
            false
        };
        let cached_removed = if self.pool.is_none() {
            self.memory
                .lock()
                .expect("key directory is not poisoned")
                .remove(kid)
                .is_some()
        } else {
            false
        };
        #[cfg(test)]
        if self.take_fault(DirectoryFault::RemoveAfterCommit) {
            return Err(KeyDirectoryError::Injected("remove after commit"));
        }
        Ok(durable_removed || cached_removed)
    }

    #[cfg(test)]
    fn take_fault(&self, expected: DirectoryFault) -> bool {
        let mut fault = self.fault.lock().expect("key directory fault poisoned");
        if *fault == Some(expected) {
            *fault = None;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_next(&self, fault: DirectoryFault) {
        *self.fault.lock().expect("key directory fault poisoned") = Some(fault);
    }

    /// Authoritative lookup. Database errors and malformed rows are never
    /// collapsed into absence: callers may report `KEY_NOT_FOUND` only for
    /// `Ok(None)`.
    pub async fn get(&self, kid: &str) -> Result<Option<[u8; AES_KEY_LEN]>, KeyDirectoryError> {
        if !valid_directory_kid(kid) {
            return Err(KeyDirectoryError::InvalidKid);
        }
        #[cfg(test)]
        if self.take_fault(DirectoryFault::Get) {
            return Err(KeyDirectoryError::Injected("get"));
        }
        let Some(pool) = &self.pool else {
            return Ok(self
                .memory
                .lock()
                .expect("key directory is not poisoned")
                .get(kid)
                .copied());
        };
        let row =
            sqlx::query_as::<_, (Vec<u8>,)>("SELECT key FROM carry_channel_key WHERE kid = $1")
                .bind(kid)
                .fetch_optional(pool)
                .await?;
        row.map(|row| {
            row.0
                .as_slice()
                .try_into()
                .map_err(|_| KeyDirectoryError::CorruptRow)
        })
        .transpose()
    }

    pub async fn holds(&self, kid: &str) -> Result<bool, KeyDirectoryError> {
        self.get(kid).await.map(|key| key.is_some())
    }

    pub async fn is_empty(&self) -> Result<bool, KeyDirectoryError> {
        #[cfg(test)]
        if self.take_fault(DirectoryFault::Get) {
            return Err(KeyDirectoryError::Injected("get"));
        }
        let Some(pool) = &self.pool else {
            return Ok(self
                .memory
                .lock()
                .expect("key directory is not poisoned")
                .is_empty());
        };
        let (exists,) = sqlx::query_as::<_, (bool,)>(
            "SELECT EXISTS (SELECT 1 FROM carry_channel_key LIMIT 1)",
        )
        .fetch_one(pool)
        .await?;
        Ok(!exists)
    }

    /// Open a sealed payload, if this directory holds the key it names.
    ///
    /// `None` means "not ours to read", which is a different thing from an error:
    /// a deployment that never received the device's key is expected to be unable
    /// to open its data, and must relay it sealed rather than dropping it.
    pub async fn open(
        &self,
        data: &cosmos_crypto::EncryptedData,
    ) -> Result<Option<Vec<u8>>, KeyDirectoryError> {
        let Some(key) = self.get(&data.kid).await? else {
            return Ok(None);
        };
        cosmos_crypto::open(&key, data)
            .map(Some)
            .map_err(|_| KeyDirectoryError::OpenFailed)
    }

    pub async fn seal(
        &self,
        kid: &str,
        plaintext: &[u8],
        aad: &[u8],
    ) -> Result<Option<cosmos_crypto::EncryptedData>, KeyDirectoryError> {
        let Some(key) = self.get(kid).await? else {
            return Ok(None);
        };
        cosmos_crypto::seal(kid, &key, plaintext, aad)
            .map(Some)
            .map_err(|_| KeyDirectoryError::OpenFailed)
    }

    /// Upgrade from the former DB-first/local-second writer without ever
    /// resurrecting local state. Every local row must already exist identically
    /// in the authoritative directory; only then is the local channel map
    /// durably stripped while its wrapping key is preserved.
    pub async fn reconcile_legacy_key_material(
        &self,
        material: &crate::keymaterial::KeyMaterial,
    ) -> Result<(), KeyDirectoryError> {
        let legacy = material
            .legacy_channel_keys()
            .map_err(KeyDirectoryError::LocalPersistence)?;
        for (kid, key) in &legacy {
            match self.get(kid).await? {
                Some(authoritative) if authoritative == *key => {}
                Some(_) | None => return Err(KeyDirectoryError::ReconciliationMismatch),
            }
        }
        if !legacy.is_empty() {
            material
                .strip_legacy_channel_keys()
                .map_err(KeyDirectoryError::LocalPersistence)?;
        }
        Ok(())
    }
}

pub type SharedKeyDirectory = Arc<KeyDirectory>;

/// Stable gRPC mapping for authoritative channel-key faults. Only a proven
/// absent row is a failed channel precondition; storage/read faults are
/// retryable availability failures and corrupt authority is fail-closed.
pub(crate) fn grpc_status(error: &KeyDirectoryError) -> tonic::Status {
    match error {
        KeyDirectoryError::Database(_) => tonic::Status::unavailable(
            "the authoritative channel-key directory is unavailable; retry",
        ),
        #[cfg(test)]
        KeyDirectoryError::Injected(_) => tonic::Status::unavailable(
            "the authoritative channel-key directory is unavailable; retry",
        ),
        KeyDirectoryError::InvalidKid => tonic::Status::invalid_argument(
            "channel-key id must be nonempty bounded control-free UTF-8",
        ),
        KeyDirectoryError::DirectoryFull => tonic::Status::resource_exhausted(
            "the authoritative channel-key directory reached its safe capacity",
        ),
        KeyDirectoryError::CorruptRow | KeyDirectoryError::ReconciliationMismatch => {
            tonic::Status::failed_precondition(
                "the authoritative channel-key state is inconsistent; repair it before retrying",
            )
        }
        KeyDirectoryError::LocalPersistence(error) => {
            crate::services::public_privacy::key_material_availability_status(error).unwrap_or_else(
                || tonic::Status::failed_precondition("legacy channel-key reconciliation failed"),
            )
        }
        KeyDirectoryError::OpenFailed => tonic::Status::failed_precondition(
            "the established channel key could not open the envelope",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempSnapshot(std::path::PathBuf);

    impl TempSnapshot {
        fn new(name: &str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "cosmos-keydirectory-{name}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&directory).expect("create scratch directory");
            Self(directory.join("keymaterial.json"))
        }

        fn path(&self) -> std::path::PathBuf {
            self.0.clone()
        }
    }

    impl Drop for TempSnapshot {
        fn drop(&mut self) {
            if let Some(parent) = self.0.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    fn sealed(kid: &str, key: [u8; AES_KEY_LEN], plaintext: &[u8]) -> cosmos_crypto::EncryptedData {
        let aad = b"humane.contacts.Contact";
        cosmos_crypto::seal(kid, &key, plaintext, aad).expect("seal")
    }

    #[tokio::test]
    async fn a_key_put_by_one_holder_opens_data_sealed_under_it() {
        let directory = KeyDirectory::in_memory();
        let key = [7u8; AES_KEY_LEN];
        directory.put("kid-1", key).await.expect("put");

        let opened = directory
            .open(&sealed("kid-1", key, b"a contact"))
            .await
            .expect("directory lookup");
        assert_eq!(opened.as_deref(), Some(&b"a contact"[..]));
    }

    #[tokio::test]
    async fn an_unknown_kid_reads_as_absent_rather_than_an_error() {
        let directory = KeyDirectory::in_memory();
        // Sealed under a key this directory was never given — the ordinary case
        // for a device that enrolled somewhere else.
        let opened = directory
            .open(&sealed("kid-unknown", [9u8; AES_KEY_LEN], b"not ours"))
            .await
            .expect("directory lookup");
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

    #[tokio::test]
    async fn a_configured_database_failure_never_falls_back_to_memory() {
        let result = KeyDirectory::configured_from(Some("not-a-postgres-url")).await;
        assert!(
            matches!(result, Err(KeyDirectoryError::Database(_))),
            "a configured but invalid database must fail startup"
        );
    }

    #[tokio::test]
    async fn failed_publication_never_enters_the_cache_and_retry_is_durable_first() {
        let directory = KeyDirectory::in_memory();
        let key = [5u8; AES_KEY_LEN];
        directory.fail_next(DirectoryFault::Put);
        assert!(matches!(
            directory.put("retry-kid", key).await,
            Err(KeyDirectoryError::Injected("put"))
        ));
        assert!(directory.get("retry-kid").await.expect("lookup").is_none());

        directory.put("retry-kid", key).await.expect("retry put");
        assert_eq!(directory.get("retry-kid").await.expect("lookup"), Some(key));
    }

    #[tokio::test]
    async fn unknown_put_commit_outcome_converges_on_idempotent_retry() {
        let directory = KeyDirectory::in_memory();
        let key = [0x15; AES_KEY_LEN];
        directory.fail_next(DirectoryFault::PutAfterCommit);
        assert!(matches!(
            directory.put("post-commit-put", key).await,
            Err(KeyDirectoryError::Injected("put after commit"))
        ));
        assert_eq!(
            directory.get("post-commit-put").await.expect("lookup"),
            Some(key),
            "the RPC may lose its commit acknowledgement after the authority committed"
        );
        directory
            .put("post-commit-put", key)
            .await
            .expect("UPSERT retry is idempotent");
        assert_eq!(
            directory.get("post-commit-put").await.expect("lookup"),
            Some(key)
        );
    }

    #[tokio::test]
    async fn unknown_remove_commit_outcome_converges_on_idempotent_retry() {
        let directory = KeyDirectory::in_memory();
        directory
            .put("post-commit-remove", [0x25; AES_KEY_LEN])
            .await
            .expect("seed");
        directory.fail_next(DirectoryFault::RemoveAfterCommit);
        assert!(matches!(
            directory.remove("post-commit-remove").await,
            Err(KeyDirectoryError::Injected("remove after commit"))
        ));
        assert!(
            directory
                .get("post-commit-remove")
                .await
                .expect("lookup")
                .is_none()
        );
        assert!(
            !directory
                .remove("post-commit-remove")
                .await
                .expect("DELETE retry is idempotent"),
            "a committed delete remains a successful no-op on retry"
        );
    }

    #[tokio::test]
    async fn lookup_failure_is_not_reported_as_absence() {
        let directory = KeyDirectory::in_memory();
        directory.fail_next(DirectoryFault::Get);
        assert!(matches!(
            directory.get("unknown").await,
            Err(KeyDirectoryError::Injected("get"))
        ));
    }

    #[tokio::test]
    async fn invalid_kids_and_a_full_memory_authority_leave_every_existing_row_unchanged() {
        let directory = KeyDirectory::in_memory();
        for invalid in [
            "",
            "control\u{1}",
            "c1\u{85}",
            &"x".repeat(MAX_DIRECTORY_KID_BYTES + 1),
        ] {
            assert!(matches!(
                directory.put(invalid, [1u8; AES_KEY_LEN]).await,
                Err(KeyDirectoryError::InvalidKid)
            ));
            assert!(matches!(
                directory.get(invalid).await,
                Err(KeyDirectoryError::InvalidKid)
            ));
            assert!(matches!(
                directory.remove(invalid).await,
                Err(KeyDirectoryError::InvalidKid)
            ));
        }
        {
            let mut memory = directory.memory.lock().expect("memory authority");
            for index in 0..MAX_DIRECTORY_KEYS {
                memory.insert(format!("kid-{index}"), [index as u8; AES_KEY_LEN]);
            }
        }
        let before = directory.memory.lock().expect("memory authority").clone();
        assert!(matches!(
            directory.put("one-too-many", [9u8; AES_KEY_LEN]).await,
            Err(KeyDirectoryError::DirectoryFull)
        ));
        assert_eq!(
            *directory.memory.lock().expect("memory authority"),
            before,
            "a rejected unique key changed the full authority"
        );
        directory
            .put("kid-0", [0xAA; AES_KEY_LEN])
            .await
            .expect("replacement at capacity remains allowed");
        assert_eq!(
            directory.get("kid-0").await.expect("lookup"),
            Some([0xAA; AES_KEY_LEN])
        );
        assert_eq!(
            directory.memory.lock().expect("memory authority").len(),
            MAX_DIRECTORY_KEYS
        );
    }

    #[tokio::test]
    async fn equal_legacy_rows_are_stripped_without_changing_the_authority() {
        let snapshot = TempSnapshot::new("equal-migration");
        let material = crate::keymaterial::KeyMaterial::at_path_with_test_wrapping_key_generator(
            snapshot.path(),
        );
        material
            .wrapping_key()
            .expect("seed the wrapping key through the ordinary durable branch");
        let key = [0x31; AES_KEY_LEN];
        material
            .insert("legacy".to_owned(), key)
            .expect("seed legacy snapshot");
        let before: serde_json::Value = serde_json::from_slice(
            &std::fs::read(snapshot.path()).expect("snapshot before migration"),
        )
        .expect("snapshot JSON");
        let directory = KeyDirectory::in_memory();
        directory.put("legacy", key).await.expect("seed authority");

        directory
            .reconcile_legacy_key_material(&material)
            .await
            .expect("compare and strip");
        assert!(
            material
                .legacy_channel_keys()
                .expect("local state")
                .is_empty()
        );
        assert_eq!(directory.get("legacy").await.expect("authority"), Some(key));
        let after: serde_json::Value = serde_json::from_slice(
            &std::fs::read(snapshot.path()).expect("snapshot after migration"),
        )
        .expect("snapshot JSON");
        assert!(before["wrapping_private_key"].is_string());
        assert_eq!(
            after["wrapping_private_key"], before["wrapping_private_key"],
            "one-time channel-map stripping must preserve the exact wrapping key"
        );
        assert!(
            crate::keymaterial::KeyMaterial::at_path_allowing_test_wrapping_key_restore(
                snapshot.path()
            )
            .legacy_channel_keys()
            .expect("restart")
            .is_empty(),
            "stripping must survive restart"
        );
    }

    #[tokio::test]
    async fn local_only_or_mismatched_legacy_rows_fail_closed_byte_identically() {
        for (name, authoritative) in [
            ("local-only", None),
            ("mismatch", Some([0x42; AES_KEY_LEN])),
        ] {
            let snapshot = TempSnapshot::new(name);
            let material = crate::keymaterial::KeyMaterial::at_path(snapshot.path());
            material
                .insert("legacy".to_owned(), [0x41; AES_KEY_LEN])
                .expect("seed local snapshot");
            let before = std::fs::read(snapshot.path()).expect("snapshot bytes");
            let directory = KeyDirectory::in_memory();
            if let Some(key) = authoritative {
                directory.put("legacy", key).await.expect("seed authority");
            }
            assert!(matches!(
                directory.reconcile_legacy_key_material(&material).await,
                Err(KeyDirectoryError::ReconciliationMismatch)
            ));
            assert_eq!(
                std::fs::read(snapshot.path()).expect("snapshot bytes"),
                before
            );
            assert!(material.holds("legacy").expect("local remains"));
        }
    }

    #[tokio::test]
    async fn directory_only_state_is_valid_and_strip_failure_retries_idempotently() {
        let directory_only = KeyDirectory::in_memory();
        directory_only
            .put("authoritative", [0x51; AES_KEY_LEN])
            .await
            .expect("seed authority");
        let empty = crate::keymaterial::KeyMaterial::default();
        directory_only
            .reconcile_legacy_key_material(&empty)
            .await
            .expect("DB-only state is authoritative");

        let snapshot = TempSnapshot::new("strip-retry");
        let material = crate::keymaterial::KeyMaterial::at_path(snapshot.path());
        let key = [0x61; AES_KEY_LEN];
        material
            .insert("legacy".to_owned(), key)
            .expect("seed local snapshot");
        let directory = KeyDirectory::in_memory();
        directory.put("legacy", key).await.expect("seed authority");
        material.fail_next_persistence_at(crate::keymaterial::PersistenceFault::Write);
        assert!(matches!(
            directory.reconcile_legacy_key_material(&material).await,
            Err(KeyDirectoryError::LocalPersistence(
                cosmos_crypto::CryptoError::KeyMaterialPersistence
            ))
        ));
        assert!(
            material
                .holds("legacy")
                .expect("pre-rename failure rolls back")
        );
        directory
            .reconcile_legacy_key_material(&material)
            .await
            .expect("retry strip");
        assert!(material.legacy_channel_keys().expect("stripped").is_empty());
    }

    #[tokio::test]
    async fn post_rename_strip_failure_converges_on_retry_and_restart() {
        let snapshot = TempSnapshot::new("strip-post-rename");
        let material = crate::keymaterial::KeyMaterial::at_path(snapshot.path());
        let key = [0x71; AES_KEY_LEN];
        material
            .insert("legacy".to_owned(), key)
            .expect("seed local snapshot");
        let directory = KeyDirectory::in_memory();
        directory.put("legacy", key).await.expect("seed authority");
        material.fail_next_persistence_at(crate::keymaterial::PersistenceFault::DirectorySync);
        assert!(matches!(
            directory.reconcile_legacy_key_material(&material).await,
            Err(KeyDirectoryError::LocalPersistence(
                cosmos_crypto::CryptoError::KeyMaterialPersistence
            ))
        ));
        directory
            .reconcile_legacy_key_material(&material)
            .await
            .expect("retry confirms renamed strip");
        assert!(
            crate::keymaterial::KeyMaterial::at_path(snapshot.path())
                .legacy_channel_keys()
                .expect("restart")
                .is_empty()
        );
        assert_eq!(directory.get("legacy").await.expect("authority"), Some(key));
    }

    #[tokio::test]
    async fn removal_failure_is_retryable_and_missing_removal_is_idempotent() {
        let directory = KeyDirectory::in_memory();
        directory
            .put("remove-kid", [6u8; AES_KEY_LEN])
            .await
            .expect("seed key");
        directory.fail_next(DirectoryFault::Remove);
        assert!(matches!(
            directory.remove("remove-kid").await,
            Err(KeyDirectoryError::Injected("remove"))
        ));
        assert!(directory.get("remove-kid").await.expect("lookup").is_some());
        assert!(directory.remove("remove-kid").await.expect("retry remove"));
        assert!(
            !directory
                .remove("remove-kid")
                .await
                .expect("idempotent remove")
        );
    }

    /// The cross-workload property, against a real database: a key written by one
    /// directory handle is readable by a second, independent one — the two stand
    /// in for two workloads.
    #[tokio::test]
    async fn a_second_workload_observes_import_replacement_revocation_and_reimport() {
        let Ok(url) = std::env::var("COSMOS_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the shared key directory");
            return;
        };
        let importer = KeyDirectory::connect(&url).await.expect("connect");
        let key = [3u8; AES_KEY_LEN];
        let kid = format!("kid-{}", uuid::Uuid::new_v4());
        importer.put(&kid, key).await.expect("put");

        // A separate handle: the only way it can answer is out of PostgreSQL,
        // because database-backed directories never cache channel keys.
        let reader = KeyDirectory::connect(&url).await.expect("connect");
        assert!(reader.is_shared());
        let opened = reader
            .open(&sealed(&kid, key, b"sealed by another workload"))
            .await
            .expect("directory lookup");
        assert_eq!(
            opened.as_deref(),
            Some(&b"sealed by another workload"[..]),
            "a key imported by one workload must open data in another"
        );

        let replacement = [4u8; AES_KEY_LEN];
        importer.put(&kid, replacement).await.expect("replace");
        assert_eq!(
            reader.get(&kid).await.expect("fresh authoritative read"),
            Some(replacement),
            "a reader must not retain the old process-cached key"
        );
        assert!(importer.remove(&kid).await.expect("remove"));
        assert_eq!(
            reader.get(&kid).await.expect("fresh revocation read"),
            None,
            "revocation must be visible to an already-running other workload"
        );
        let reimported = [5u8; AES_KEY_LEN];
        importer.put(&kid, reimported).await.expect("reimport");
        assert_eq!(
            reader.get(&kid).await.expect("fresh reimport read"),
            Some(reimported),
            "reimport must be visible without restarting another workload"
        );
        assert!(importer.remove(&kid).await.expect("cleanup"));
    }

    #[tokio::test]
    async fn many_concurrent_key_directories_migrate_one_fresh_postgres_schema_atomically() {
        let Ok(url) = std::env::var("COSMOS_TEST_DATABASE_URL") else {
            eprintln!(
                "SKIPPED: set COSMOS_TEST_DATABASE_URL for concurrent fresh-schema migration"
            );
            return;
        };
        let admin = sqlx::PgPool::connect(&url)
            .await
            .expect("connect test database");
        let schema = format!("cosmos_keydir_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!(r#"CREATE SCHEMA "{schema}""#))
            .execute(&admin)
            .await
            .expect("create disposable schema");
        let separator = if url.contains('?') { '&' } else { '?' };
        let scoped_url = format!("{url}{separator}options=-csearch_path%3D{schema}");

        let mut tasks = Vec::new();
        for _ in 0..16 {
            let scoped_url = scoped_url.clone();
            tasks.push(tokio::spawn(async move {
                KeyDirectory::connect(&scoped_url).await
            }));
        }
        let mut directories = Vec::new();
        for task in tasks {
            directories.push(
                task.await
                    .expect("migration task did not panic")
                    .expect("advisory-locked migration succeeds"),
            );
        }
        directories[0]
            .put("concurrent-migration-proof", [0x5A; AES_KEY_LEN])
            .await
            .expect("bounded table is usable");
        assert_eq!(
            directories[15]
                .get("concurrent-migration-proof")
                .await
                .expect("cross-handle lookup"),
            Some([0x5A; AES_KEY_LEN])
        );
        let (constraints,) = sqlx::query_as::<_, (i64,)>(
            "SELECT COUNT(*) FROM pg_constraint
             WHERE conname = 'carry_channel_key_shape'
               AND conrelid = 'carry_channel_key'::regclass",
        )
        .fetch_one(directories[0].pool.as_ref().expect("postgres pool"))
        .await
        .expect("inspect schema constraint");
        assert_eq!(
            constraints, 1,
            "migration created an ambiguous constraint set"
        );

        drop(directories);
        sqlx::query(&format!(r#"DROP SCHEMA "{schema}" CASCADE"#))
            .execute(&admin)
            .await
            .expect("drop disposable schema");
    }
}
