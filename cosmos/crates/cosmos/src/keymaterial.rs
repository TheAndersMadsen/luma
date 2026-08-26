//! Shared ephemeral-key material — the server side of cosmos's per-capability
//! encrypted channel.
//!
//! cosmos's shipped assistant path is envelope-encrypted end to end: the device
//! establishes an ephemeral channel key per capability, wraps it to the server's
//! public wrapping key, and uploads it via
//! `PublicPrivacyService.EstablishWrappingKeys` / `ImportKeys`. Every subsequent
//! `Encrypted*` RPC then carries an `EncryptedData{encryption_information{kid},
//! data}` sealed under that channel key.
//!
//! Current deployments keep channel keys in [`crate::keydirectory`], whose
//! PostgreSQL reads are authoritative across workloads. This module owns the
//! long-lived RSA wrapping key and can read the former local channel map only so
//! startup can compare it with that authority and durably strip the duplicate.
//!
//! # Why this state is durable
//!
//! The device establishes a channel key **once** and then reuses its kid
//! indefinitely. `KryptoSecureChannelFactory.getKeyId`
//! (`humaneinternal/system/krypto/ephemeral/KryptoSecureChannelFactory.java:147`)
//! mints the kid on first use and writes it to the `krypto_key_id_cache`
//! `SharedPreferences`; nothing on the device ever removes that entry.
//! `generateKey` (same file:56) then reads the cached kid, asks the on-device KMS
//! for the key, and — when the key is already there, which it always is after the
//! first run — **returns without calling `importKey`**. Above it,
//! `CoreSecureChannelFactory.getChannel`
//! (`hu/ma/ne/krypton/ephemeral/CoreSecureChannelFactory.java:98`) serves the
//! channel from a process-static cache. There is no re-establish on error, on
//! `FAILED_PRECONDITION`, or on boot: the upload happens once per device
//! lifetime.
//!
//! So process-lifetime key material means any restart, redeploy, or crash
//! permanently breaks `EncryptedUnderstand` — the transport a stock Pin actually
//! speaks — because the server no longer holds the key for a kid the device will
//! keep sending forever. The RSA-OAEP wrapping keypair is therefore snapshotted
//! so the public key the device wrapped to stays valid. Older releases also
//! wrote `{kid -> channel key}` here; that field remains readable solely for the
//! fail-closed one-time migration in
//!
//! # Handling
//!
//! Key material is never logged, never returned by an RPC, and never put on the
//! wire; only the wrapping *public* key leaves the process, via
//! `EstablishWrappingKeys`. The snapshot is a `0600` file under
//! `COSMOS_STATE_DIR`, the same durability switch [`crate::store::MemoryStore`]
//! uses, in its own file so long-lived key material never shares a blob with
//! wearer data.
//!
//! **It is written in the clear.** There is no second secret in this deployment
//! to encrypt it under, and inventing one that defaults to absent would look like
//! protection without being any: the file's confidentiality rests entirely on
//! filesystem permissions and on the volume being as trusted as the process. That
//! is the same trust boundary the DeviceUser-issuing CA private key already sits
//! on (`COSMOS_DUC_CA_KEY`, an unencrypted PEM read by `enrollment.rs`). If that
//! boundary ever stops holding, this file needs a KMS, not a passphrase.

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::PathBuf;
#[cfg(test)]
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use cosmos_crypto::{AES_KEY_LEN, ChannelKeyStore, CryptoError, EncryptedData, WrappingKeypair};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest as _, Sha256};

/// The concrete production key plus a strictly `cfg(test)` local substitute.
/// No crypto-crate feature or public API can make the smaller representation
/// reachable in a non-test dependency build.
pub(crate) enum WrappingKeyMaterial {
    Production(WrappingKeypair),
    #[cfg(test)]
    Test(TestWrappingKeypair),
}

#[cfg(test)]
pub(crate) struct TestWrappingKeypair {
    private: rsa::RsaPrivateKey,
    public_der: Vec<u8>,
}

impl WrappingKeyMaterial {
    fn production_generate() -> Result<Self, CryptoError> {
        WrappingKeypair::generate().map(Self::Production)
    }

    fn production_restore(der: &[u8]) -> Result<Self, CryptoError> {
        WrappingKeypair::from_production_private_pkcs8_der(der).map(Self::Production)
    }

    pub(crate) fn public_der(&self) -> &[u8] {
        match self {
            Self::Production(keypair) => keypair.public_der(),
            #[cfg(test)]
            Self::Test(keypair) => &keypair.public_der,
        }
    }

    pub(crate) fn unwrap(&self, wrapped: &[u8]) -> Result<Vec<u8>, CryptoError> {
        match self {
            Self::Production(keypair) => keypair.unwrap(wrapped),
            #[cfg(test)]
            Self::Test(keypair) => keypair
                .private
                .decrypt(rsa::Oaep::new::<sha1::Sha1>(), wrapped)
                .map_err(|_| CryptoError::RsaUnwrap),
        }
    }

    fn private_pkcs8_der(&self) -> Result<Vec<u8>, CryptoError> {
        match self {
            Self::Production(keypair) => keypair.private_pkcs8_der(),
            #[cfg(test)]
            Self::Test(keypair) => {
                use rsa::pkcs8::EncodePrivateKey as _;
                keypair
                    .private
                    .to_pkcs8_der()
                    .map(|document| document.as_bytes().to_vec())
                    .map_err(|_| CryptoError::RsaUnwrap)
            }
        }
    }

    #[cfg(test)]
    fn modulus_bits(&self) -> usize {
        use rsa::traits::PublicKeyParts as _;
        match self {
            Self::Production(keypair) => keypair.modulus_bits(),
            Self::Test(keypair) => keypair.private.n().bits(),
        }
    }
}

/// Durability switch, shared with `store.rs`: unset means memory-only, which is
/// right for tests and local runs and wrong for anything a device talks to twice.
const STATE_DIR_ENV: &str = "COSMOS_STATE_DIR";
#[cfg(not(test))]
const WORKLOAD_ENV: &str = "COSMOS_WORKLOAD";

/// A bounded cleartext snapshot. 4,096 maximum kids of 1,024 UTF-8 bytes plus
/// JSON/base64 overhead fit below this cap; a larger file is never allocated or
/// parsed as key material.
const MAX_SNAPSHOT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CHANNEL_KEYS: usize = 4_096;
const MAX_KID_BYTES: usize = 1_024;

fn workload_snapshot_filename(workload: &str) -> Result<String, cosmos_core::IdentityError> {
    workload
        .parse::<cosmos_core::Workload>()
        .map(|workload| format!("{}-keymaterial.json", workload.as_str()))
}

fn valid_snapshot_kid(kid: &str) -> bool {
    !kid.is_empty() && kid.len() <= MAX_KID_BYTES && !kid.chars().any(char::is_control)
}

/// The server's RSA-OAEP wrapping state plus the legacy local channel map that
/// startup may compare and strip. New production channel writes never enter the
/// map.
pub struct KeyMaterial {
    /// One lock covers both kinds of key material and the complete
    /// mutate -> persist -> commit transaction. Readers therefore cannot see a
    /// tentative mutation, and concurrent callers in the one supported writer
    /// process cannot persist stale snapshots over newer ones. This is not a
    /// cross-process lock; production runs one process per workload identity.
    state: Mutex<KeyMaterialState>,
    /// A complete candidate whose atomic rename succeeded but whose parent
    /// directory fsync did not. It remains invisible and every later operation
    /// retries the directory sync before it may publish or use the candidate.
    /// This distinguishes "rename may already be durable" from a pre-rename
    /// failure, where simply retaining the old state is sufficient.
    pending_after_rename: Mutex<Option<KeyMaterialState>>,
    /// Test-only seam for exercising the real lazy-generation branch without
    /// paying for a new 4096-bit key in every service test. Production builds
    /// have no generator field and call `WrappingKeypair::generate` directly.
    #[cfg(test)]
    wrapping_key_generator: fn() -> Result<Arc<WrappingKeyMaterial>, CryptoError>,
    /// Where this workload snapshots its key material. `None` is memory-only.
    /// Held on the struct rather than read from the environment per call so a
    /// store's durability is explicit and testable without mutating
    /// process-global state — the same shape as `MemoryStore::state_path`.
    state_path: Option<PathBuf>,
    /// Set when a snapshot is present but could not be read or parsed.
    ///
    /// The module doc promises an unreadable snapshot is left alone because it
    /// is the only copy of keys the device will never upload again. Nothing
    /// enforced that past construction: `restore()` returned with an empty
    /// keystore, and the next `wrapping_key()` or `insert()` — seconds later,
    /// on the first encrypted RPC — generated fresh material and renamed a new
    /// file over the old one. This flag makes the promise real for the whole
    /// process lifetime, and it is deliberately one-way: nothing clears it, so
    /// the only way out is an operator restoring or moving the file and
    /// restarting.
    snapshot_unreadable: AtomicBool,
    /// One-shot deterministic persistence failure used only by unit tests. The
    /// field and all branches that read it are absent from production builds.
    #[cfg(test)]
    persistence_fault: Mutex<Option<PersistenceFault>>,
    /// Only an explicitly test-only restart constructor may restore the shared
    /// process-local 2048-bit fixture. Production and production-model tests
    /// require the exact 4096-bit wrapping-key contract.
    #[cfg(test)]
    allow_test_wrapping_key_restore: bool,
}

/// All mutable key state is committed as one atomic snapshot.
#[derive(Clone, Default)]
struct KeyMaterialState {
    /// Lazily generated and then restored forever because the device wraps to
    /// this exact public key.
    wrapping: Option<Arc<WrappingKeyMaterial>>,
    /// Unwrapped ephemeral channel keys, keyed by kid.
    keys: ChannelKeyStore,
    /// Exact filesystem state from which this in-memory state was derived.
    /// `Absent` is a real CAS token, not permission to overwrite a file that
    /// appeared after startup.
    observation: SnapshotToken,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PersistenceFault {
    Write,
    Rename,
    DirectorySync,
    RestorePostObservationNotFound,
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The on-disk form. Base64 because these are raw key bytes and JSON has no byte
/// string; `BTreeMap` so a snapshot is byte-stable across writes.
#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct KeySnapshot {
    /// PKCS#8 DER of the RSA-OAEP wrapping private key.
    wrapping_private_key: Option<String>,
    /// `kid -> AES-128 channel key`.
    #[serde(deserialize_with = "deserialize_unique_channel_keys")]
    channel_keys: BTreeMap<String, String>,
}

fn deserialize_unique_channel_keys<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error>
where
    D: Deserializer<'de>,
{
    struct UniqueMap;

    impl<'de> Visitor<'de> for UniqueMap {
        type Value = BTreeMap<String, String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a channel-key object without duplicate kids")
        }

        fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut values = BTreeMap::new();
            while let Some((kid, encoded)) = access.next_entry::<String, String>()? {
                if values.insert(kid, encoded).is_some() {
                    return Err(serde::de::Error::custom("duplicate channel-key kid"));
                }
                if values.len() > MAX_CHANNEL_KEYS {
                    return Err(serde::de::Error::custom("too many channel keys"));
                }
            }
            Ok(values)
        }
    }

    deserializer.deserialize_map(UniqueMap)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum SnapshotToken {
    #[default]
    Absent,
    Present(SnapshotObservation),
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SnapshotObservation {
    device: u64,
    inode: u64,
    size: u64,
    mode: u32,
    digest: [u8; 32],
}

#[cfg(unix)]
impl SnapshotObservation {
    fn from_metadata_and_bytes(metadata: &std::fs::Metadata, bytes: &[u8]) -> Self {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            mode: metadata.permissions().mode() & 0o777,
            digest: Sha256::digest(bytes).into(),
        }
    }

    fn matches_metadata(self, metadata: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        self.device == metadata.dev()
            && self.inode == metadata.ino()
            && self.size == metadata.len()
            && self.mode == metadata.permissions().mode() & 0o777
    }
}

#[cfg(not(unix))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SnapshotObservation;

#[cfg(unix)]
fn observe_snapshot(path: &std::path::Path) -> std::io::Result<SnapshotObservation> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};

    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let before = file.metadata()?;
    if !before.file_type().is_file()
        || before.permissions().mode() & 0o777 != 0o600
        || before.len() == 0
        || before.len() > MAX_SNAPSHOT_BYTES
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "snapshot is not an exact-0600 bounded regular file",
        ));
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.by_ref()
        .take(MAX_SNAPSHOT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let stable = before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.permissions().mode() & 0o777 == after.permissions().mode() & 0o777
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec();
    if !stable || bytes.len() as u64 != before.len() || bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "snapshot changed during descriptor read",
        ));
    }
    let observation = SnapshotObservation::from_metadata_and_bytes(&before, &bytes);
    let current = std::fs::symlink_metadata(path)?;
    if current.file_type().is_symlink() || !observation.matches_metadata(&current) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "snapshot path changed after descriptor read",
        ));
    }
    Ok(observation)
}

#[cfg(target_os = "linux")]
fn renameat2_with_flags(
    source: &std::path::Path,
    destination: &std::path::Path,
    flags: libc::c_uint,
) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt as _;

    let source = std::ffi::CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in source path"))?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in destination path")
    })?;
    // SAFETY: both C strings are owned for the duration of the call, and
    // AT_FDCWD asks the kernel to resolve the already-validated absolute/sibling
    // paths exactly as std::fs would.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            flags,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn renamex_np_with_flags(
    source: &std::path::Path,
    destination: &std::path::Path,
    flags: libc::c_uint,
) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt as _;

    let source = std::ffi::CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in source path"))?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in destination path")
    })?;
    // SAFETY: both C strings are owned for the duration of the call. The
    // caller supplies one documented renamex_np flag for already-validated
    // absolute/sibling paths.
    let result = unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), flags) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn unsupported_snapshot_cas(
    _source: &std::path::Path,
    _destination: &std::path::Path,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic snapshot CAS requires Linux renameat2 or macOS renamex_np",
    ))
}

#[cfg(target_os = "linux")]
fn rename_noreplace(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    renameat2_with_flags(source, destination, libc::RENAME_NOREPLACE)
}

#[cfg(target_os = "macos")]
fn rename_noreplace(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    renamex_np_with_flags(source, destination, libc::RENAME_EXCL)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn rename_noreplace(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    unsupported_snapshot_cas(source, destination)
}

#[cfg(target_os = "linux")]
fn rename_exchange(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    renameat2_with_flags(source, destination, libc::RENAME_EXCHANGE)
}

#[cfg(target_os = "macos")]
fn rename_exchange(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    renamex_np_with_flags(source, destination, libc::RENAME_SWAP)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn rename_exchange(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    unsupported_snapshot_cas(source, destination)
}

impl Default for KeyMaterial {
    /// Restores any snapshot this workload previously wrote in production.
    ///
    /// `Default` rather than a named `shared()` constructor because the workload
    /// builds its key material with `Default::default()` (`lib.rs`), and a
    /// durable store nothing constructs would be no fix at all. Test builds are
    /// deliberately always memory-only: an ambient `COSMOS_STATE_DIR` must not
    /// let an ordinary unit test read or rewrite mounted production state.
    fn default() -> Self {
        #[cfg(not(test))]
        let (state_path, invalid_configuration) = match Self::configured_state_path() {
            Ok(path) => (path, false),
            Err(()) => (None, true),
        };
        let material = Self {
            state: Mutex::new(KeyMaterialState::default()),
            pending_after_rename: Mutex::new(None),
            #[cfg(test)]
            wrapping_key_generator: production_wrapping_key_generator,
            #[cfg(not(test))]
            state_path,
            #[cfg(test)]
            state_path: None,
            #[cfg(not(test))]
            snapshot_unreadable: AtomicBool::new(invalid_configuration),
            #[cfg(test)]
            snapshot_unreadable: AtomicBool::new(false),
            #[cfg(test)]
            persistence_fault: Mutex::new(None),
            #[cfg(test)]
            allow_test_wrapping_key_restore: false,
        };
        #[cfg(not(test))]
        material.restore();
        material
    }
}

impl KeyMaterial {
    /// Construct the serving instance from the already-captured startup
    /// configuration. Production/parity validation decides whether `None` is
    /// allowed; this function makes a configured directory real and fsynced, or
    /// returns an error before any listener can bind.
    pub(crate) fn configured_for_workload(
        state_dir: Option<&str>,
        workload: cosmos_core::Workload,
    ) -> Result<Self, CryptoError> {
        let state_path = match state_dir {
            None => None,
            Some(dir) if dir.trim().is_empty() => None,
            Some(dir) => {
                let directory = PathBuf::from(dir);
                std::fs::create_dir_all(&directory).map_err(|error| {
                    tracing::error!(path = %directory.display(), error = %error, "could not create the configured key-material state directory");
                    CryptoError::KeyMaterialPersistence
                })?;
                #[cfg(unix)]
                {
                    std::fs::File::open(&directory)
                        .and_then(|file| file.sync_all())
                        .map_err(|error| {
                            tracing::error!(path = %directory.display(), error = %error, "could not confirm the configured key-material state directory");
                            CryptoError::KeyMaterialPersistence
                        })?;
                    if let Some(parent) = directory.parent() {
                        std::fs::File::open(parent)
                            .and_then(|file| file.sync_all())
                            .map_err(|error| {
                                tracing::error!(path = %parent.display(), error = %error, "could not confirm the parent of the key-material state directory");
                                CryptoError::KeyMaterialPersistence
                            })?;
                    }
                }
                Some(directory.join(format!("{}-keymaterial.json", workload.as_str())))
            }
        };
        let material = Self {
            state: Mutex::new(KeyMaterialState::default()),
            pending_after_rename: Mutex::new(None),
            #[cfg(test)]
            wrapping_key_generator: production_wrapping_key_generator,
            state_path,
            snapshot_unreadable: AtomicBool::new(false),
            #[cfg(test)]
            persistence_fault: Mutex::new(None),
            #[cfg(test)]
            allow_test_wrapping_key_restore: false,
        };
        material.restore();
        material.refuse_if_unreadable()?;
        Ok(material)
    }

    /// Build key material persisting to an explicit path. Used by tests so
    /// durability can be exercised without touching process-global environment.
    #[cfg(test)]
    pub(crate) fn at_path(path: PathBuf) -> Self {
        let material = Self {
            state: Mutex::new(KeyMaterialState::default()),
            pending_after_rename: Mutex::new(None),
            wrapping_key_generator: production_wrapping_key_generator,
            state_path: Some(path),
            snapshot_unreadable: AtomicBool::new(false),
            persistence_fault: Mutex::new(None),
            allow_test_wrapping_key_restore: false,
        };
        material.restore();
        material
    }

    /// Restore with one persistence boundary failed from the first filesystem
    /// operation. This exists only to prove that startup never publishes a
    /// snapshot whose parent-directory entry could not be confirmed durable.
    #[cfg(test)]
    pub(crate) fn at_path_with_initial_fault(path: PathBuf, fault: PersistenceFault) -> Self {
        let material = Self {
            state: Mutex::new(KeyMaterialState::default()),
            pending_after_rename: Mutex::new(None),
            wrapping_key_generator: production_wrapping_key_generator,
            state_path: Some(path),
            snapshot_unreadable: AtomicBool::new(false),
            persistence_fault: Mutex::new(Some(fault)),
            allow_test_wrapping_key_restore: false,
        };
        material.restore();
        material
    }

    /// Fresh, memory-only key material using the small test key generator.
    ///
    /// Ordinary service tests exercise the same empty -> generate control flow
    /// as production. The injected generator returns one process-local,
    /// in-memory 2048-bit key so those tests avoid repeated unpredictable
    /// 4096-bit keygens while each mutable channel-key store remains isolated.
    /// This constructor and the generator field are absent from non-test builds.
    #[cfg(test)]
    pub(crate) fn with_test_wrapping_key_generator() -> Self {
        Self {
            state: Mutex::new(KeyMaterialState::default()),
            pending_after_rename: Mutex::new(None),
            wrapping_key_generator: test_wrapping_key_generator,
            state_path: None,
            snapshot_unreadable: AtomicBool::new(false),
            persistence_fault: Mutex::new(None),
            allow_test_wrapping_key_restore: false,
        }
    }

    /// The durable variant of [`KeyMaterial::with_test_wrapping_key_generator`].
    ///
    /// It starts empty. The first call to [`KeyMaterial::wrapping_key`] invokes
    /// the generator and must persist through the ordinary `if generated`
    /// branch. A restarted instance must use the explicitly test-only restore
    /// constructor: ordinary [`KeyMaterial::at_path`] models production and
    /// rejects a persisted key whose modulus is not exactly 4096 bits.
    #[cfg(test)]
    pub(crate) fn at_path_with_test_wrapping_key_generator(path: PathBuf) -> Self {
        assert!(
            !path.exists(),
            "the injected-generator constructor requires a fresh snapshot path"
        );
        Self {
            state: Mutex::new(KeyMaterialState::default()),
            pending_after_rename: Mutex::new(None),
            wrapping_key_generator: test_wrapping_key_generator,
            state_path: Some(path),
            snapshot_unreadable: AtomicBool::new(false),
            persistence_fault: Mutex::new(None),
            allow_test_wrapping_key_restore: false,
        }
    }

    /// Restart a snapshot made by the cfg(test)-only 2048-bit generator. This
    /// constructor is absent from production; ordinary `at_path` deliberately
    /// models production and rejects the same snapshot.
    #[cfg(test)]
    pub(crate) fn at_path_allowing_test_wrapping_key_restore(path: PathBuf) -> Self {
        let material = Self {
            state: Mutex::new(KeyMaterialState::default()),
            pending_after_rename: Mutex::new(None),
            wrapping_key_generator: test_wrapping_key_generator,
            state_path: Some(path),
            snapshot_unreadable: AtomicBool::new(false),
            persistence_fault: Mutex::new(None),
            allow_test_wrapping_key_restore: true,
        };
        material.restore();
        material
    }

    /// The server's RSA-OAEP wrapping keypair, generated on first use and kept
    /// from then on: the device caches the public half it wrapped to and never
    /// re-establishes, so a second keypair would fail every later `ImportKeys`
    /// unwrap with no way back.
    pub(crate) fn wrapping_key(&self) -> Result<Arc<WrappingKeyMaterial>, CryptoError> {
        // An unreadable snapshot is not an absent one. The keypair the device
        // wrapped to is still in that file, so generating a second one would
        // publish a public key no device holds and then persist it over the
        // original. Failing the RPC is recoverable; overwriting is not.
        if self.snapshot_unreadable.load(Ordering::SeqCst) {
            tracing::error!(
                "refusing to publish a replacement wrapping key while the key-material snapshot is unreadable; \
                 the encrypted transport stays down until the snapshot is restored"
            );
            return Err(CryptoError::SnapshotUnreadable);
        }
        let mut state = self.state.lock().expect("key material poisoned");
        self.finish_pending_persistence(&mut state)?;
        self.verify_committed_observation(&state)?;
        if let Some(keypair) = state.wrapping.as_ref() {
            return Ok(keypair.clone());
        }

        #[cfg(test)]
        let keypair = (self.wrapping_key_generator)()?;
        #[cfg(not(test))]
        let keypair = Arc::new(WrappingKeyMaterial::production_generate()?);

        let mut next = state.clone();
        next.wrapping = Some(keypair.clone());
        // Persist the complete next state before making the public key visible.
        // On failure `state` remains empty, so the caller receives an error and
        // a retry can safely generate/persist again.
        next.observation = self.persist_state(&next)?;
        *state = next;
        Ok(keypair)
    }

    /// Record an unwrapped ephemeral channel key under its kid, acknowledging it
    /// only after the durable snapshot has been atomically replaced.
    pub fn insert(&self, kid: String, key: [u8; AES_KEY_LEN]) -> Result<(), CryptoError> {
        if !valid_snapshot_kid(&kid) {
            tracing::error!(
                "refusing an invalid or oversized channel-key id before it can enter key material"
            );
            return Err(CryptoError::KeyMaterialPersistence);
        }
        self.refuse_if_unreadable()?;
        let mut state = self.state.lock().expect("key material poisoned");
        self.finish_pending_persistence(&mut state)?;
        self.verify_committed_observation(&state)?;
        let mut next = state.clone();
        next.keys.insert(kid, key);
        next.observation = self.persist_state(&next)?;
        *state = next;
        Ok(())
    }

    /// Whether any channel key has been established yet. Used to tell "the device
    /// never ran the key exchange" apart from "the envelope is undecryptable",
    /// so the encrypted RPCs can return an accurate gRPC status.
    pub fn is_empty(&self) -> Result<bool, CryptoError> {
        self.refuse_if_unreadable()?;
        let mut state = self.state.lock().expect("key material poisoned");
        self.finish_pending_persistence(&mut state)?;
        self.verify_committed_observation(&state)?;
        Ok(state.keys.is_empty())
    }

    /// Whether this exact kid is held. The key-lifecycle RPCs must answer per kid
    /// — "held" and "never seen" are different answers to the device, and a
    /// response that omits a kid entirely is the shape that wedges the client.
    pub fn holds(&self, kid: &str) -> Result<bool, CryptoError> {
        self.refuse_if_unreadable()?;
        let mut state = self.state.lock().expect("key material poisoned");
        self.finish_pending_persistence(&mut state)?;
        self.verify_committed_observation(&state)?;
        Ok(state.keys.entries().any(|(known, _)| known == kid))
    }

    /// Forget a channel key. Returns whether it was held.
    ///
    /// The snapshot is rewritten so the removal survives a restart; otherwise a
    /// key the device believes gone would come back on the next boot and the two
    /// sides would disagree about the channel forever.
    pub fn remove(&self, kid: &str) -> Result<bool, CryptoError> {
        self.refuse_if_unreadable()?;
        let mut state = self.state.lock().expect("key material poisoned");
        self.finish_pending_persistence(&mut state)?;
        self.verify_committed_observation(&state)?;
        if !state.keys.entries().any(|(known, _)| known == kid) {
            return Ok(false);
        }
        let mut next = state.clone();
        assert!(
            next.keys.remove(kid),
            "key disappeared while state was locked"
        );
        next.observation = self.persist_state(&next)?;
        *state = next;
        Ok(true)
    }

    /// Open a device-sealed envelope with the channel key named by its kid.
    pub fn open(&self, enc: &EncryptedData) -> Result<Vec<u8>, CryptoError> {
        self.refuse_if_unreadable()?;
        let mut state = self.state.lock().expect("key material poisoned");
        self.finish_pending_persistence(&mut state)?;
        self.verify_committed_observation(&state)?;
        state.keys.open(enc)
    }

    /// Seal a server payload under an established channel key. `aad` is the
    /// envelope's additional authenticated data (empty on the assistant path).
    pub fn seal(
        &self,
        kid: &str,
        plaintext: &[u8],
        aad: &[u8],
    ) -> Result<EncryptedData, CryptoError> {
        self.refuse_if_unreadable()?;
        let mut state = self.state.lock().expect("key material poisoned");
        self.finish_pending_persistence(&mut state)?;
        self.verify_committed_observation(&state)?;
        state.keys.seal(kid, plaintext, aad)
    }

    /// Where this workload persists its key material, from the environment.
    ///
    /// One file per workload, and a *different* file from the store snapshot:
    /// long-lived key material does not belong in the same blob as wearer data.
    #[cfg(not(test))]
    fn configured_state_path() -> Result<Option<PathBuf>, ()> {
        let Ok(dir) = std::env::var(STATE_DIR_ENV) else {
            return Ok(None);
        };
        if dir.trim().is_empty() {
            return Ok(None);
        }
        let workload = std::env::var(WORKLOAD_ENV).unwrap_or_else(|_| "ai-bus".to_owned());
        let filename = workload_snapshot_filename(&workload).map_err(|error| {
            tracing::error!(
                value = %workload,
                error = %error,
                "refusing an invalid COSMOS_WORKLOAD before deriving a key-material filename"
            );
        })?;
        let dir = PathBuf::from(dir);
        // Keep the configured path even if the directory cannot be created now.
        // Otherwise a mount/permission failure silently downgrades production to
        // memory-only and lets RPCs acknowledge state that cannot survive.
        if let Err(error) = std::fs::create_dir_all(&dir) {
            tracing::error!(
                path = %dir.display(),
                error = %error,
                "could not prepare the key-material state directory; mutations will fail until it is writable"
            );
        }
        Ok(Some(dir.join(filename)))
    }

    fn refuse_if_unreadable(&self) -> Result<(), CryptoError> {
        if self.snapshot_unreadable.load(Ordering::SeqCst) {
            Err(CryptoError::SnapshotUnreadable)
        } else {
            Ok(())
        }
    }

    /// Atomically install a complete candidate state. The caller holds
    /// `self.state` for the whole operation, serializing all writers. Failure is
    /// propagated and the caller leaves the visible state unchanged.
    fn persist_state(&self, state: &KeyMaterialState) -> Result<SnapshotToken, CryptoError> {
        let Some(path) = self.state_path.as_ref() else {
            return Ok(SnapshotToken::Absent);
        };
        if let Err(error) = self.refuse_if_unreadable() {
            tracing::error!(
                path = %path.display(),
                "refusing to overwrite an unreadable key-material snapshot; move or repair the file and restart to recover the established channel keys"
            );
            return Err(error);
        }
        let base64 = base64::engine::general_purpose::STANDARD;
        let wrapping_private_key = match state.wrapping.as_ref() {
            Some(keypair) => Some(base64.encode(keypair.private_pkcs8_der()?)),
            None => None,
        };
        let mut channel_keys = BTreeMap::new();
        for (kid, key) in state.keys.entries() {
            if !valid_snapshot_kid(kid) || channel_keys.len() >= MAX_CHANNEL_KEYS {
                tracing::error!(
                    "refusing to encode invalid or oversized key material before it can poison the durable snapshot"
                );
                return Err(CryptoError::KeyMaterialPersistence);
            }
            channel_keys.insert(kid.to_owned(), base64.encode(key));
        }
        let snapshot = KeySnapshot {
            wrapping_private_key,
            channel_keys,
        };
        let encoded = serde_json::to_vec(&snapshot).map_err(|error| {
            tracing::error!(error = %error, "could not encode the key-material snapshot");
            CryptoError::KeyMaterialPersistence
        })?;
        if encoded.len() as u64 > MAX_SNAPSHOT_BYTES {
            tracing::error!(
                size = encoded.len(),
                limit = MAX_SNAPSHOT_BYTES,
                "refusing to encode an oversized key-material snapshot"
            );
            return Err(CryptoError::KeyMaterialPersistence);
        }

        if let Some(parent) = path.parent()
            && let Err(error) = std::fs::create_dir_all(parent)
        {
            return self.persistence_error(path, "create state directory", error);
        }

        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("keymaterial");
        let temporary = path.with_file_name(format!(
            ".{file_name}.tmp-{}-{sequence}",
            std::process::id()
        ));

        #[cfg(test)]
        if self.take_persistence_fault(PersistenceFault::Write) {
            return self.persistence_error(
                path,
                "write temporary snapshot",
                std::io::Error::other("injected write failure"),
            );
        }

        if let Err(error) = write_private(&temporary, &encoded) {
            let _ = std::fs::remove_file(&temporary);
            return self.persistence_error(path, "write temporary snapshot", error);
        }

        #[cfg(test)]
        if self.take_persistence_fault(PersistenceFault::Rename) {
            let _ = std::fs::remove_file(&temporary);
            return self.persistence_error(
                path,
                "rename temporary snapshot",
                std::io::Error::other("injected rename failure"),
            );
        }

        let installed = self.install_snapshot_cas(path, &temporary, state.observation)?;
        if let Err(error) = self.sync_state_directory(path) {
            // The rename already happened, so rolling back only memory would
            // create an ambiguous split from a possibly durable candidate.
            // Retain it invisibly and retry this exact directory fsync before
            // any later operation may expose or build on the candidate.
            let mut candidate = state.clone();
            candidate.observation = SnapshotToken::Present(installed);
            *self
                .pending_after_rename
                .lock()
                .expect("pending key material poisoned") = Some(candidate);
            return self.persistence_error(path, "sync state directory", error);
        }
        self.require_observation(path, SnapshotToken::Present(installed))?;
        Ok(SnapshotToken::Present(installed))
    }

    /// Install `temporary` only if the path still has the exact token from
    /// which the candidate was derived. Linux renameat2 and macOS renamex_np
    /// give both required atomic shapes: NOREPLACE/EXCL for the first creation
    /// and EXCHANGE/SWAP for an existing snapshot. The displaced inode is
    /// inspected at the temporary name before it can be removed; a racing
    /// replacement is exchanged back rather than overwritten.
    #[cfg(unix)]
    fn install_snapshot_cas(
        &self,
        path: &std::path::Path,
        temporary: &std::path::Path,
        expected: SnapshotToken,
    ) -> Result<SnapshotObservation, CryptoError> {
        let candidate = match observe_snapshot(temporary) {
            Ok(observation) => observation,
            Err(error) => {
                let _ = std::fs::remove_file(temporary);
                return self.persistence_error(path, "observe temporary snapshot", error);
            }
        };

        match expected {
            SnapshotToken::Absent => {
                match std::fs::symlink_metadata(path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Ok(_) => {
                        let _ = std::fs::remove_file(temporary);
                        return self
                            .cas_conflict(path, "a snapshot appeared after absence was observed");
                    }
                    Err(error) => {
                        let _ = std::fs::remove_file(temporary);
                        return self.persistence_error(path, "inspect absent snapshot", error);
                    }
                }
                if let Err(error) = rename_noreplace(temporary, path) {
                    let _ = std::fs::remove_file(temporary);
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        return self
                            .cas_conflict(path, "a snapshot appeared during first creation");
                    }
                    return self.persistence_error(
                        path,
                        "install first snapshot no-replace",
                        error,
                    );
                }
            }
            SnapshotToken::Present(expected) => {
                match observe_snapshot(path) {
                    Ok(current) if current == expected => {}
                    Ok(_) | Err(_) => {
                        let _ = std::fs::remove_file(temporary);
                        return self.cas_conflict(
                            path,
                            "the committed snapshot changed before replacement",
                        );
                    }
                }
                if let Err(error) = rename_exchange(temporary, path) {
                    let _ = std::fs::remove_file(temporary);
                    return self.persistence_error(path, "exchange snapshot candidate", error);
                }
                let displaced = observe_snapshot(temporary);
                if displaced.as_ref().ok() != Some(&expected) {
                    // Restore the concurrently supplied target atomically. Once
                    // this succeeds the candidate is back at `temporary` and is
                    // safe to remove; failure leaves both inodes preserved.
                    if let Err(error) = rename_exchange(temporary, path) {
                        tracing::error!(
                            path = %path.display(),
                            error = %error,
                            "snapshot CAS detected a raced replacement and could not exchange it back; preserving both paths and failing closed"
                        );
                    } else {
                        let _ = std::fs::remove_file(temporary);
                    }
                    return self.cas_conflict(
                        path,
                        "the displaced snapshot did not match the committed token",
                    );
                }
                match observe_snapshot(path) {
                    Ok(current) if current == candidate => {}
                    _ => {
                        // `temporary` still contains the previously committed
                        // snapshot. Preserve it for operator recovery rather than
                        // unlinking the last known-good wrapping key.
                        return self.cas_conflict(
                            path,
                            "the installed snapshot changed before verification",
                        );
                    }
                }
                if let Err(error) = std::fs::remove_file(temporary) {
                    return self.persistence_error(path, "remove displaced snapshot", error);
                }
            }
        }

        match observe_snapshot(path) {
            Ok(current) if current == candidate => Ok(current),
            _ => self.cas_conflict(path, "the installed snapshot changed after replacement"),
        }
    }

    #[cfg(not(unix))]
    fn install_snapshot_cas(
        &self,
        path: &std::path::Path,
        temporary: &std::path::Path,
        _expected: SnapshotToken,
    ) -> Result<SnapshotObservation, CryptoError> {
        let _ = std::fs::remove_file(temporary);
        self.persistence_error(
            path,
            "install snapshot CAS",
            std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "snapshot CAS requires Unix renameat2 semantics",
            ),
        )
    }

    fn cas_conflict<T>(&self, path: &std::path::Path, reason: &str) -> Result<T, CryptoError> {
        tracing::error!(
            path = %path.display(),
            reason,
            "key-material snapshot changed outside the committed writer; refusing to publish or overwrite either state"
        );
        self.snapshot_unreadable.store(true, Ordering::SeqCst);
        Err(CryptoError::SnapshotUnreadable)
    }

    fn require_observation(
        &self,
        path: &std::path::Path,
        expected: SnapshotToken,
    ) -> Result<(), CryptoError> {
        #[cfg(unix)]
        let matches = match expected {
            SnapshotToken::Absent => std::fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
            SnapshotToken::Present(expected) => {
                observe_snapshot(path).is_ok_and(|current| current == expected)
            }
        };
        #[cfg(not(unix))]
        let matches = false;
        if matches {
            Ok(())
        } else {
            self.cas_conflict(path, "the path no longer matches its committed observation")
        }
    }

    fn verify_committed_observation(
        &self,
        committed: &KeyMaterialState,
    ) -> Result<(), CryptoError> {
        let Some(path) = self.state_path.as_ref() else {
            return Ok(());
        };
        self.require_observation(path, committed.observation)
    }

    /// Finish the only ambiguous persistence phase: a rename that succeeded
    /// before its containing directory could be synced. The candidate stays
    /// hidden until this succeeds, at which point disk durability precedes the
    /// in-memory commit just as it does on the ordinary path.
    fn finish_pending_persistence(
        &self,
        committed: &mut KeyMaterialState,
    ) -> Result<(), CryptoError> {
        let mut pending = self
            .pending_after_rename
            .lock()
            .expect("pending key material poisoned");
        let Some(candidate) = pending.as_ref() else {
            return Ok(());
        };
        let path = self
            .state_path
            .as_ref()
            .expect("pending persistence requires a state path");
        self.require_observation(path, candidate.observation)?;
        if let Err(error) = self.sync_state_directory(path) {
            return self.persistence_error(path, "retry state directory sync", error);
        }
        self.require_observation(path, candidate.observation)?;
        *committed = candidate.clone();
        *pending = None;
        Ok(())
    }

    fn sync_state_directory(&self, path: &std::path::Path) -> std::io::Result<()> {
        #[cfg(test)]
        if self.take_persistence_fault(PersistenceFault::DirectorySync) {
            return Err(std::io::Error::other("injected directory sync failure"));
        }
        #[cfg(unix)]
        {
            let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    }

    fn persistence_error<T>(
        &self,
        path: &std::path::Path,
        operation: &str,
        error: std::io::Error,
    ) -> Result<T, CryptoError> {
        tracing::error!(
            path = %path.display(),
            operation,
            error = %error,
            "could not persist key material; the mutation was not committed"
        );
        Err(CryptoError::KeyMaterialPersistence)
    }

    #[cfg(test)]
    fn take_persistence_fault(&self, expected: PersistenceFault) -> bool {
        let mut fault = self
            .persistence_fault
            .lock()
            .expect("persistence fault lock poisoned");
        if *fault == Some(expected) {
            *fault = None;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_next_persistence_at(&self, fault: PersistenceFault) {
        *self
            .persistence_fault
            .lock()
            .expect("persistence fault lock poisoned") = Some(fault);
    }

    /// Load a previous snapshot, if one exists. A snapshot that cannot be read or
    /// parsed is left alone rather than overwritten: it is the only copy of a key
    /// the device will never upload again, and an operator can still recover it.
    ///
    /// The two failures are told apart deliberately. `NotFound` is a genuine
    /// first run. Anything else — a mode or ownership change on the shared
    /// cosmos-state volume, an I/O error, a bad mount — means the file is there
    /// and this process cannot see it, which is exactly the case where writing
    /// is destructive. That distinction was previously absent: a single
    /// `let Ok(bytes) = ... else { return }` treated EACCES like ENOENT and
    /// logged nothing at all.
    fn restore(&self) {
        let Some(path) = self.state_path.as_ref() else {
            return;
        };

        // Open with O_NOFOLLOW, inspect and read through that one descriptor,
        // then prove the path still names the same inode. ENOENT is first-run
        // only at the initial open; once the descriptor exists, disappearance or
        // replacement is an observed-state race and therefore unreadable.
        #[cfg(not(unix))]
        {
            tracing::error!(
                path = %path.display(),
                "key-material restore requires Unix O_NOFOLLOW and file-mode semantics; refusing to use or rewrite the snapshot"
            );
            self.snapshot_unreadable.store(true, Ordering::SeqCst);
            return;
        }
        #[cfg(unix)]
        let (bytes, observation) = {
            use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

            let mut file = match std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(error) => {
                    tracing::error!(
                        path = %path.display(),
                        error = %error,
                        "key-material snapshot could not be opened without following links; the encrypted transport stays down and this process will not write over it"
                    );
                    self.snapshot_unreadable.store(true, Ordering::SeqCst);
                    return;
                }
            };
            let before = match file.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    tracing::error!(path = %path.display(), error = %error, "key-material snapshot descriptor could not be inspected; refusing to use or rewrite it");
                    self.snapshot_unreadable.store(true, Ordering::SeqCst);
                    return;
                }
            };
            if !before.file_type().is_file()
                || before.permissions().mode() & 0o777 != 0o600
                || before.len() == 0
                || before.len() > MAX_SNAPSHOT_BYTES
            {
                tracing::error!(
                    path = %path.display(),
                    mode = before.permissions().mode() & 0o777,
                    size = before.len(),
                    "key-material snapshot is not an exact-0600 bounded regular file; refusing to use or rewrite it"
                );
                self.snapshot_unreadable.store(true, Ordering::SeqCst);
                return;
            }
            let mut bytes = Vec::with_capacity(before.len() as usize);
            if let Err(error) = file
                .by_ref()
                .take(MAX_SNAPSHOT_BYTES + 1)
                .read_to_end(&mut bytes)
            {
                tracing::error!(path = %path.display(), error = %error, "key-material snapshot descriptor could not be read; refusing to use or rewrite it");
                self.snapshot_unreadable.store(true, Ordering::SeqCst);
                return;
            }
            let after = match file.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    tracing::error!(path = %path.display(), error = %error, "key-material snapshot changed while it was read; refusing to use or rewrite it");
                    self.snapshot_unreadable.store(true, Ordering::SeqCst);
                    return;
                }
            };
            use std::os::unix::fs::MetadataExt as _;
            let stable = before.dev() == after.dev()
                && before.ino() == after.ino()
                && before.len() == after.len()
                && before.permissions().mode() & 0o777 == after.permissions().mode() & 0o777
                && before.mtime() == after.mtime()
                && before.mtime_nsec() == after.mtime_nsec()
                && before.ctime() == after.ctime()
                && before.ctime_nsec() == after.ctime_nsec();
            if bytes.len() as u64 != before.len()
                || bytes.len() as u64 > MAX_SNAPSHOT_BYTES
                || !stable
            {
                tracing::error!(path = %path.display(), "key-material snapshot changed or exceeded its bound while it was read; refusing to use or rewrite it");
                self.snapshot_unreadable.store(true, Ordering::SeqCst);
                return;
            }

            #[cfg(test)]
            let current =
                if self.take_persistence_fault(PersistenceFault::RestorePostObservationNotFound) {
                    Err(std::io::Error::from(std::io::ErrorKind::NotFound))
                } else {
                    std::fs::symlink_metadata(path)
                };
            #[cfg(not(test))]
            let current = std::fs::symlink_metadata(path);
            let current = match current {
                Ok(metadata) => metadata,
                Err(error) => {
                    tracing::error!(path = %path.display(), error = %error, "key-material snapshot path disappeared after observation; refusing to use or rewrite it");
                    self.snapshot_unreadable.store(true, Ordering::SeqCst);
                    return;
                }
            };
            let observation = SnapshotObservation::from_metadata_and_bytes(&before, &bytes);
            if current.file_type().is_symlink() || !observation.matches_metadata(&current) {
                tracing::error!(path = %path.display(), "key-material snapshot path changed after observation; refusing to use or rewrite it");
                self.snapshot_unreadable.store(true, Ordering::SeqCst);
                return;
            }
            (bytes, observation)
        };
        let snapshot = match serde_json::from_slice::<KeySnapshot>(&bytes) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                tracing::error!(
                    path = %path.display(),
                    error = %error,
                    "key-material snapshot did not parse; the encrypted transport stays down and this process will not write over it"
                );
                self.snapshot_unreadable.store(true, Ordering::SeqCst);
                return;
            }
        };
        let base64 = base64::engine::general_purpose::STANDARD;

        // A wrapping key the snapshot RECORDED but that does not decode is
        // "unreadable", not "absent" — and the difference is the whole ballgame.
        //
        // `None` is a genuine absence: no wrapping key was ever persisted (the
        // shipped device uploads `ClearKey`s and may never trigger one), so a
        // later `wrapping_key()` is free to generate and persist the first one.
        //
        // But `Some(encoded)` that fails to base64-decode or fails
        // the exact production restore means the file HAS a wrapping key we cannot
        // read — corrupt bytes, a truncated field, an algorithm we can no longer
        // load. Falling through here (the old `if let … && let Ok … && let Ok`
        // chain did exactly that) left `wrapping = None` with
        // `snapshot_unreadable` still false, so the next `wrapping_key()` minted
        // a REPLACEMENT keypair and `persist()` wrote it over the only copy of
        // the key the device wrapped to — the exact irreversible strand this flag
        // exists to prevent, reached through a snapshot whose JSON parsed fine.
        // Treat it like an unreadable file or unparseable JSON: refuse to
        // overwrite, and report the true cause rather than a first run.
        let mut restored = KeyMaterialState::default();
        if let Some(encoded) = snapshot.wrapping_private_key.as_ref() {
            let decoded = base64
                .decode(encoded)
                .ok()
                .filter(|der| base64.encode(der) == *encoded);
            #[cfg(test)]
            let restored_keypair = decoded.and_then(|der| {
                if self.allow_test_wrapping_key_restore {
                    let candidate = test_wrapping_key_generator().ok()?;
                    (candidate.private_pkcs8_der().ok()?.as_slice() == der.as_slice())
                        .then_some(candidate)
                } else {
                    WrappingKeyMaterial::production_restore(&der)
                        .ok()
                        .map(Arc::new)
                }
            });
            #[cfg(not(test))]
            let restored_keypair = decoded.and_then(|der| {
                WrappingKeyMaterial::production_restore(&der)
                    .ok()
                    .map(Arc::new)
            });
            match restored_keypair {
                Some(keypair) => {
                    restored.wrapping = Some(keypair);
                }
                None => {
                    tracing::error!(
                        path = %path.display(),
                        "key-material snapshot records a wrapping key that does not decode; \
                         the encrypted transport stays down and this process will not write over it"
                    );
                    self.snapshot_unreadable.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }

        for (kid, encoded) in snapshot.channel_keys {
            if !valid_snapshot_kid(&kid) {
                tracing::error!(
                    path = %path.display(),
                    "key-material snapshot records an invalid or oversized kid; the encrypted transport stays down and this process will not write over it"
                );
                self.snapshot_unreadable.store(true, Ordering::SeqCst);
                return;
            }
            let Some(key) = base64
                .decode(&encoded)
                .ok()
                .filter(|raw| base64.encode(raw) == encoded)
                .and_then(|raw| <[u8; AES_KEY_LEN]>::try_from(raw.as_slice()).ok())
            else {
                // Never name the kid: it may identify a wearer. One malformed
                // recorded entry makes the whole snapshot non-overwritable,
                // because silently dropping it and later persisting would erase
                // the only copy of a key the device never uploads again.
                tracing::error!(
                    path = %path.display(),
                    "key-material snapshot records a channel key that does not decode; \
                     the encrypted transport stays down and this process will not write over it"
                );
                self.snapshot_unreadable.store(true, Ordering::SeqCst);
                return;
            };
            restored.keys.insert(kid, key);
        }
        restored.observation = SnapshotToken::Present(observation);
        // A snapshot may be present because a prior process completed rename
        // and crashed before syncing the directory. Confirm that directory
        // entry before the restored private material becomes operational.
        if let Err(error) = self.sync_state_directory(path) {
            tracing::error!(
                path = %path.display(),
                error = %error,
                "key-material snapshot is valid but its directory durability could not be confirmed; it remains hidden and the next operation will retry"
            );
            *self
                .pending_after_rename
                .lock()
                .expect("pending key material poisoned") = Some(restored);
            return;
        }
        if self
            .require_observation(path, SnapshotToken::Present(observation))
            .is_err()
        {
            return;
        }
        *self.state.lock().expect("key material poisoned") = restored;
    }
}

/// The unmodified production generator used by ordinary `KeyMaterial` test
/// constructors. Keeping it separate from the small generator makes the
/// injected behavior explicit at each expensive test call site.
#[cfg(test)]
fn production_wrapping_key_generator() -> Result<Arc<WrappingKeyMaterial>, CryptoError> {
    WrappingKeyMaterial::production_generate().map(Arc::new)
}

/// Generate one immutable 2048-bit key in memory for this test process.
/// Mutable `KeyMaterial` is never shared: each caller starts with `None` and
/// merely receives a clone of this read-only `Arc` through the normal lazy path.
#[cfg(test)]
fn test_wrapping_key_generator() -> Result<Arc<WrappingKeyMaterial>, CryptoError> {
    static TEST_WRAPPING_KEY: OnceLock<Arc<WrappingKeyMaterial>> = OnceLock::new();
    Ok(TEST_WRAPPING_KEY
        .get_or_init(|| {
            use rsa::pkcs8::EncodePublicKey as _;

            let private = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048)
                .expect("generate process-local test wrapping key");
            let public_der = rsa::RsaPublicKey::from(&private)
                .to_public_key_der()
                .expect("encode process-local test wrapping public key")
                .into_vec();
            Arc::new(WrappingKeyMaterial::Test(TestWrappingKeypair {
                private,
                public_der,
            }))
        })
        .clone())
}

/// Write a file only the workload's own user can read. The snapshot is
/// cleartext key material (see the module doc), so the mode is the protection.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    // `mode` only applies at creation, so a file left behind by an earlier run
    // with a wider mode is re-restricted explicitly.
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    file.sync_all()
}

/// Handle shared by the privacy service (writer) and the encrypted AI-bus
/// handlers (reader).
pub type SharedKeyMaterial = Arc<KeyMaterial>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_process_local_test_wrapping_key_is_2048_bit_and_immutable() {
        use rsa::RsaPublicKey;
        use rsa::pkcs8::DecodePublicKey as _;
        use rsa::traits::PublicKeyParts as _;

        let first = test_wrapping_key_generator().expect("generate test wrapping key");
        let public = RsaPublicKey::from_public_key_der(first.public_der())
            .expect("parse process-local test wrapping public key");
        assert_eq!(public.n().bits(), 2048, "test key size drifted");
        assert!(
            Arc::ptr_eq(
                &first,
                &test_wrapping_key_generator().expect("reuse test wrapping key")
            ),
            "the process should reuse one immutable test keypair"
        );
    }

    /// A scratch path that does not survive the test.
    struct TempPath(PathBuf);

    impl TempPath {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "cosmos-keymaterial-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir.join("keymaterial.json"))
        }
        fn path(&self) -> PathBuf {
            self.0.clone()
        }

        fn write_snapshot(&self, bytes: &[u8]) {
            write_private(&self.0, bytes).expect("write private snapshot fixture");
        }

        fn temporary_files(&self) -> Vec<PathBuf> {
            let Some(parent) = self.0.parent() else {
                return Vec::new();
            };
            std::fs::read_dir(parent)
                .expect("read scratch dir")
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.contains(".tmp-"))
                })
                .collect()
        }
    }

    impl Drop for TempPath {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    #[test]
    fn seal_open_round_trips_through_the_shared_store() {
        let km = KeyMaterial::default();
        assert!(km.is_empty().expect("inspect empty store"));
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN])
            .expect("insert memory-only key");
        assert!(!km.is_empty().expect("inspect populated store"));

        let sealed = km.seal("kid-1", b"hello pin", b"").expect("seal");
        let opened = km.open(&sealed).expect("open");
        assert_eq!(opened, b"hello pin");
    }

    #[test]
    fn sealing_under_an_unknown_kid_fails_rather_than_inventing_a_key() {
        let km = KeyMaterial::default();
        assert!(km.seal("nope", b"x", b"").is_err());
    }

    #[test]
    fn without_a_state_path_nothing_is_written() {
        let scratch = TempPath::new("unconfigured");
        let km = KeyMaterial {
            state: Mutex::new(KeyMaterialState::default()),
            pending_after_rename: Mutex::new(None),
            wrapping_key_generator: production_wrapping_key_generator,
            state_path: None,
            snapshot_unreadable: AtomicBool::new(false),
            persistence_fault: Mutex::new(None),
            allow_test_wrapping_key_restore: false,
        };
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN])
            .expect("insert memory-only key");
        assert!(!scratch.path().exists());
    }

    /// The device uploads a channel key once and reuses its kid forever
    /// (`KryptoSecureChannelFactory.java:147`), so a kid established before a
    /// restart has to still open envelopes after one.
    #[test]
    fn channel_keys_survive_a_restart() {
        let scratch = TempPath::new("channel-keys");
        let kid = "d=;u=;s=ai_bus.synapse;a=;abc;def";

        let sealed = {
            let km = KeyMaterial::at_path(scratch.path());
            km.insert(kid.to_owned(), [7u8; AES_KEY_LEN])
                .expect("persist channel key");
            km.seal(kid, b"hello pin", b"")
                .expect("seal before restart")
        };

        let restarted = KeyMaterial::at_path(scratch.path());
        assert!(
            !restarted.is_empty().expect("inspect restored store"),
            "a restarted server must still hold the channel key the device established"
        );
        assert_eq!(
            restarted.open(&sealed).expect("open after restart"),
            b"hello pin"
        );
    }

    #[test]
    fn production_restore_rejects_a_persisted_test_sized_wrapping_key_without_overwrite() {
        let scratch = TempPath::new("test-sized-production-restore");
        let original = {
            let generated = KeyMaterial::at_path_with_test_wrapping_key_generator(scratch.path());
            let keypair = generated.wrapping_key().expect("persist test-sized key");
            assert_eq!(keypair.modulus_bits(), 2048);
            std::fs::read(scratch.path()).expect("read test-sized snapshot")
        };

        let production_model = KeyMaterial::at_path(scratch.path());
        assert!(matches!(
            production_model.wrapping_key(),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            production_model.insert("new-kid".to_owned(), [7u8; AES_KEY_LEN]),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            production_model.remove("new-kid"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::read(scratch.path()).expect("snapshot remains"),
            original,
            "production restore must leave a non-4096-bit snapshot byte-identical"
        );
        assert!(scratch.temporary_files().is_empty());
    }

    #[test]
    fn test_default_ignores_an_ambient_state_directory_in_a_child_process() {
        const CHILD_SENTINEL: &str = "COSMOS_KEYMATERIAL_DEFAULT_SENTINEL_PATH";
        if let Ok(snapshot_path) = std::env::var(CHILD_SENTINEL) {
            let before = std::fs::read(&snapshot_path).expect("read ambient sentinel");
            let km = KeyMaterial::default();
            assert!(
                km.is_empty().expect("inspect test Default"),
                "test Default must not restore ambient state"
            );
            km.insert("unit-test-only".to_owned(), [9u8; AES_KEY_LEN])
                .expect("memory-only insert");
            assert_eq!(
                std::fs::read(&snapshot_path).expect("ambient sentinel remains"),
                before,
                "test Default must not rewrite ambient state"
            );
            return;
        }

        let scratch = TempPath::new("ambient-default-sentinel");
        let ambient_path = scratch
            .path()
            .parent()
            .expect("scratch parent")
            .join("ambient-keymaterial.json");
        let snapshot = br#"{"wrapping_private_key":null,"channel_keys":{"production-sentinel":"BwcHBwcHBwcHBwcHBwcHBw=="}}"#;
        std::fs::write(&ambient_path, snapshot).expect("write ambient sentinel");
        // This child gets an ambient state directory without mutating this
        // parallel test process's environment. A pre-fix Default restores the
        // sentinel and then rewrites this exact file on insert.
        let output = std::process::Command::new(
            std::env::current_exe().expect("current test executable"),
        )
        .arg("--exact")
        .arg("keymaterial::tests::test_default_ignores_an_ambient_state_directory_in_a_child_process")
        .env(STATE_DIR_ENV, scratch.path().parent().expect("scratch parent"))
        .env("COSMOS_WORKLOAD", "ambient")
        .env(CHILD_SENTINEL, &ambient_path)
        .output()
        .expect("run isolated ambient-state child");
        assert!(
            output.status.success(),
            "ambient-state child failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read(ambient_path).expect("sentinel remains"),
            snapshot
        );
    }

    /// The device caches the wrapping public key it wrapped to and never
    /// re-establishes, so a restart that mints a fresh keypair would fail every
    /// later `ImportKeys` unwrap.
    #[test]
    fn the_wrapping_keypair_survives_a_restart() {
        let scratch = TempPath::new("wrapping");

        let (public_der, wrapped) = {
            let km = KeyMaterial::at_path_with_test_wrapping_key_generator(scratch.path());
            assert!(
                !scratch.path().exists(),
                "constructing empty key material must not pre-populate a snapshot"
            );
            let kp = km.wrapping_key().expect("generate");
            let snapshot: KeySnapshot = serde_json::from_slice(
                &std::fs::read(scratch.path())
                    .expect("first wrapping-key generation must persist immediately"),
            )
            .expect("read generated wrapping-key snapshot");
            assert!(
                snapshot.wrapping_private_key.is_some(),
                "the generated key must be present before any channel-key insert"
            );
            let wrapped = cosmos_crypto::wrap_channel_key(kp.public_der(), &[3u8; AES_KEY_LEN])
                .expect("device wraps to the published key");
            (kp.public_der().to_vec(), wrapped)
        };

        let restarted = KeyMaterial::at_path_allowing_test_wrapping_key_restore(scratch.path());
        let restored = restarted.wrapping_key().expect("restored keypair");
        assert_eq!(
            restored.public_der(),
            public_der.as_slice(),
            "a restarted server must publish the same wrapping key the device wrapped to"
        );
        assert_eq!(
            restored.unwrap(&wrapped).expect("unwrap after restart"),
            [3u8; AES_KEY_LEN]
        );
    }

    /// The snapshot is the only copy of a key the device will never upload again,
    /// so an unreadable one must not be silently replaced with an empty file.
    ///
    /// Construction alone proves nothing here: the file survived
    /// `KeyMaterial::at_path` before this test called anything, and was then
    /// renamed over by the first `wrapping_key()` on the first encrypted RPC —
    /// seconds later in production. The calls below are the actual invariant.
    #[test]
    fn an_unreadable_snapshot_is_left_alone_rather_than_overwritten() {
        let scratch = TempPath::new("corrupt");
        scratch.write_snapshot(b"{ not json");

        let km = KeyMaterial::at_path(scratch.path());
        assert!(matches!(
            km.is_empty(),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::read(scratch.path()).expect("still there"),
            b"{ not json"
        );

        assert!(
            matches!(km.wrapping_key(), Err(CryptoError::SnapshotUnreadable)),
            "an unreadable snapshot must fail the RPC, not mint a keypair no device wrapped to"
        );
        assert!(matches!(
            km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            km.remove("kid-1"),
            Err(CryptoError::SnapshotUnreadable)
        ));

        assert_eq!(
            std::fs::read(scratch.path()).expect("still there after every write path"),
            b"{ not json",
            "no code path may overwrite the only copy of the established channel keys"
        );
        assert!(
            scratch.temporary_files().is_empty(),
            "the write-and-rename temporary must not be left behind either"
        );
    }

    /// The snapshot's JSON parses cleanly, but the wrapping key it RECORDS does
    /// not decode. Same catastrophe as an unreadable file — the file holds a
    /// wrapping key we cannot read, so minting a replacement overwrites the only
    /// copy the device wrapped to — but it arrives through a door the file-read
    /// and JSON-parse guards do not cover, so it was silently mishandled.
    ///
    /// Before the fix, `restore()`'s `if let Some … && let Ok … && let Ok`
    /// chain simply fell through on a decode failure: `wrapping` stayed `None`,
    /// `snapshot_unreadable` stayed `false`, and the very next `wrapping_key()`
    /// generated a fresh keypair and `persist()` wrote it over the corrupt but
    /// present one — a first-run diagnosis for an unreadable-snapshot fault, the
    /// signature "blame the wrong layer" defect on the irreplaceable path.
    #[test]
    fn a_snapshot_with_an_undecodable_wrapping_key_is_left_alone_rather_than_replaced() {
        let scratch = TempPath::new("corrupt-wrapping");
        let base64 = base64::engine::general_purpose::STANDARD;
        // Deliberately VALID base64 (so the decode step succeeds) of bytes that
        // are not a PKCS#8 key (so the production restore rejects them). This
        // is the insidious case: the field is present and even base64-clean —
        // only the key bytes are bad — so nothing upstream catches it.
        let bogus = base64.encode(b"this is not a PKCS#8 wrapping private key");
        let snapshot = format!("{{\"wrapping_private_key\":\"{bogus}\",\"channel_keys\":{{}}}}");
        scratch.write_snapshot(snapshot.as_bytes());

        let km = KeyMaterial::at_path(scratch.path());
        assert!(
            matches!(km.wrapping_key(), Err(CryptoError::SnapshotUnreadable)),
            "a recorded-but-undecodable wrapping key must fail the RPC, not mint a \
             replacement no device wrapped to"
        );
        // Every write path must now refuse to touch the file.
        assert!(matches!(
            km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            km.remove("kid-1"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::read(scratch.path()).expect("still there"),
            snapshot.as_bytes(),
            "no code path may overwrite a snapshot whose wrapping key merely failed to decode"
        );
        assert!(
            scratch.temporary_files().is_empty(),
            "the write-and-rename temporary must not be left behind either"
        );
    }

    #[test]
    fn a_snapshot_with_an_undecodable_channel_key_is_left_byte_identical() {
        let scratch = TempPath::new("corrupt-channel-key");
        // Valid JSON and valid base64, but one byte cannot be an AES-128 key.
        // A recorded entry is never optional: silently skipping it lets the next
        // successful mutation erase the only copy from the rewritten snapshot.
        let snapshot = br#"{"wrapping_private_key":null,"channel_keys":{"recorded-kid":"AA=="}}"#;
        scratch.write_snapshot(snapshot);

        let km = KeyMaterial::at_path(scratch.path());
        assert!(matches!(
            km.is_empty(),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            km.wrapping_key(),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            km.insert("new-kid".to_owned(), [7u8; AES_KEY_LEN]),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            km.remove("recorded-kid"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::read(scratch.path()).expect("snapshot remains"),
            snapshot,
            "later wrapping/insert/remove paths must leave every original byte intact"
        );
        assert!(scratch.temporary_files().is_empty());
    }

    #[test]
    fn unknown_or_misspelled_snapshot_fields_fail_closed_byte_identically() {
        for (name, snapshot) in [
            (
                "unknown-field",
                br#"{"wrapping_private_key":null,"channel_keys":{},"algorithm":"AES"}"#.as_slice(),
            ),
            (
                "misspelled-field",
                br#"{"wrapping_private_key":null,"channel_key":{}}"#.as_slice(),
            ),
        ] {
            let scratch = TempPath::new(name);
            scratch.write_snapshot(snapshot);
            let material = KeyMaterial::at_path(scratch.path());
            assert!(matches!(
                material.holds("anything"),
                Err(CryptoError::SnapshotUnreadable)
            ));
            assert!(matches!(
                material.insert("new".to_owned(), [4u8; AES_KEY_LEN]),
                Err(CryptoError::SnapshotUnreadable)
            ));
            assert_eq!(std::fs::read(scratch.path()).expect("snapshot"), snapshot);
            assert!(scratch.temporary_files().is_empty());
        }
    }

    #[test]
    fn duplicate_and_bounded_snapshot_contracts_fail_closed_byte_identically() {
        let key = base64::engine::general_purpose::STANDARD.encode([4u8; AES_KEY_LEN]);
        let oversized_map = (0..=MAX_CHANNEL_KEYS)
            .map(|index| format!(r#""kid-{index}":"{key}""#))
            .collect::<Vec<_>>()
            .join(",");
        let cases = [
            (
                "duplicate-top-level",
                br#"{"wrapping_private_key":null,"channel_keys":{},"channel_keys":{}}"#.to_vec(),
            ),
            (
                "duplicate-kid",
                format!(
                    r#"{{"wrapping_private_key":null,"channel_keys":{{"same":"{key}","same":"{key}"}}}}"#
                )
                .into_bytes(),
            ),
            (
                "oversized-kid",
                serde_json::to_vec(&serde_json::json!({
                    "wrapping_private_key": null,
                    "channel_keys": { ("x".repeat(MAX_KID_BYTES + 1)): key },
                }))
                .expect("encode oversized kid"),
            ),
            (
                "control-kid",
                serde_json::to_vec(&serde_json::json!({
                    "wrapping_private_key": null,
                    "channel_keys": { "bad\u{1}kid": key },
                }))
                .expect("encode control kid"),
            ),
            (
                "oversized-map",
                format!(
                    r#"{{"wrapping_private_key":null,"channel_keys":{{{oversized_map}}}}}"#
                )
                .into_bytes(),
            ),
        ];

        for (name, snapshot) in cases {
            let scratch = TempPath::new(name);
            scratch.write_snapshot(&snapshot);
            let material = KeyMaterial::at_path(scratch.path());
            assert!(matches!(
                material.holds("anything"),
                Err(CryptoError::SnapshotUnreadable)
            ));
            assert!(matches!(
                material.insert("new".to_owned(), [5u8; AES_KEY_LEN]),
                Err(CryptoError::SnapshotUnreadable)
            ));
            assert_eq!(std::fs::read(scratch.path()).expect("snapshot"), snapshot);
            assert!(scratch.temporary_files().is_empty());
        }
    }

    #[test]
    fn an_oversized_snapshot_is_bounded_and_left_byte_identical() {
        let scratch = TempPath::new("oversized-file");
        let snapshot = vec![b' '; MAX_SNAPSHOT_BYTES as usize + 1];
        scratch.write_snapshot(&snapshot);
        let material = KeyMaterial::at_path(scratch.path());
        assert!(matches!(
            material.holds("anything"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::metadata(scratch.path()).expect("snapshot").len(),
            MAX_SNAPSHOT_BYTES + 1
        );
        assert_eq!(std::fs::read(scratch.path()).expect("snapshot"), snapshot);
    }

    #[test]
    fn post_observation_disappearance_is_not_reclassified_as_first_run() {
        let scratch = TempPath::new("post-observation-not-found");
        let snapshot = br#"{"wrapping_private_key":null,"channel_keys":{}}"#;
        scratch.write_snapshot(snapshot);
        let material = KeyMaterial::at_path_with_initial_fault(
            scratch.path(),
            PersistenceFault::RestorePostObservationNotFound,
        );
        assert!(matches!(
            material.holds("anything"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(std::fs::read(scratch.path()).expect("snapshot"), snapshot);
    }

    #[test]
    fn only_known_workloads_can_become_snapshot_filenames() {
        assert_eq!(
            workload_snapshot_filename("ai-bus").expect("known workload"),
            "ai-bus-keymaterial.json"
        );
        for invalid in ["", "ambient", "../ai-bus", "ai/bus", "ai-bus.json"] {
            assert!(
                workload_snapshot_filename(invalid).is_err(),
                "invalid workload reached a filename: {invalid}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_or_widened_snapshot_is_never_used_or_rewritten() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};

        let linked = TempPath::new("symlink-snapshot");
        let target = linked
            .path()
            .parent()
            .expect("scratch parent")
            .join("actual-keymaterial.json");
        write_private(
            &target,
            br#"{"wrapping_private_key":null,"channel_keys":{"held":"BwcHBwcHBwcHBwcHBwcHBw=="}}"#,
        )
        .expect("write target");
        symlink(&target, linked.path()).expect("link snapshot");
        let before = std::fs::read(&target).expect("target bytes");
        let material = KeyMaterial::at_path(linked.path());
        assert!(matches!(
            material.holds("held"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            material.remove("held"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(std::fs::read(&target).expect("target remains"), before);

        let widened = TempPath::new("widened-snapshot");
        widened.write_snapshot(
            br#"{"wrapping_private_key":null,"channel_keys":{"held":"BwcHBwcHBwcHBwcHBwcHBw=="}}"#,
        );
        std::fs::set_permissions(widened.path(), std::fs::Permissions::from_mode(0o640))
            .expect("widen mode");
        let before = std::fs::read(widened.path()).expect("widened bytes");
        let material = KeyMaterial::at_path(widened.path());
        assert!(matches!(
            material.open(&cosmos_crypto::EncryptedData {
                data: Vec::new(),
                kid: "held".to_owned(),
            }),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(matches!(
            material.insert("new".to_owned(), [5u8; AES_KEY_LEN]),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::read(widened.path()).expect("widened remains"),
            before
        );
    }

    #[test]
    fn restored_snapshot_waits_for_repeated_parent_sync_failure_then_recovers() {
        let scratch = TempPath::new("restart-directory-sync");
        {
            let first = KeyMaterial::at_path(scratch.path());
            first.fail_next_persistence_at(PersistenceFault::DirectorySync);
            assert!(matches!(
                first.insert("pending".to_owned(), [8u8; AES_KEY_LEN]),
                Err(CryptoError::KeyMaterialPersistence)
            ));
            // Rename is visible, but this process drops before it can retry the
            // directory sync—the restart path must not trust visibility alone.
            assert!(scratch.path().exists());
        }

        let restarted = KeyMaterial::at_path_with_initial_fault(
            scratch.path(),
            PersistenceFault::DirectorySync,
        );
        restarted.fail_next_persistence_at(PersistenceFault::DirectorySync);
        assert!(matches!(
            restarted.holds("pending"),
            Err(CryptoError::KeyMaterialPersistence)
        ));
        assert!(
            restarted
                .holds("pending")
                .expect("successful parent sync publishes restored state")
        );
        assert!(scratch.temporary_files().is_empty());
    }

    /// The realistic version of the same failure: not a corrupt file, but a
    /// readable-by-nobody one. An ownership or mode change on the shared
    /// cosmos-state volume is not hypothetical — the deploy already performs an
    /// ownership migration for Center's channel key — and `std::fs::read`
    /// reports it with a different `ErrorKind`, not with absence.
    #[cfg(unix)]
    #[test]
    fn a_permission_denied_snapshot_is_left_alone_rather_than_overwritten() {
        use std::os::unix::fs::PermissionsExt as _;

        let scratch = TempPath::new("denied");
        std::fs::write(scratch.path(), b"{\"channel_keys\":{}}").expect("write snapshot");
        std::fs::set_permissions(scratch.path(), std::fs::Permissions::from_mode(0o000))
            .expect("drop every permission bit");
        if std::fs::read(scratch.path()).is_ok() {
            // Running as root (or on a filesystem that ignores modes) makes the
            // read succeed, and there is no denial left to assert about.
            return;
        }

        let km = KeyMaterial::at_path(scratch.path());
        assert!(
            matches!(km.wrapping_key(), Err(CryptoError::SnapshotUnreadable)),
            "an unreadable snapshot must not be treated as a first run"
        );
        assert!(matches!(
            km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]),
            Err(CryptoError::SnapshotUnreadable)
        ));

        std::fs::set_permissions(scratch.path(), std::fs::Permissions::from_mode(0o600))
            .expect("restore permissions to inspect the file");
        assert_eq!(
            std::fs::read(scratch.path()).expect("still there"),
            b"{\"channel_keys\":{}}",
            "a permissions fault must not replace the snapshot with this process's empty state"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_snapshot_is_readable_only_by_the_workloads_own_user() {
        use std::os::unix::fs::PermissionsExt as _;
        let scratch = TempPath::new("mode");
        let km = KeyMaterial::at_path(scratch.path());
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN])
            .expect("persist key");

        let mode = std::fs::metadata(scratch.path())
            .expect("snapshot written")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "cleartext key material must stay 0600");
    }

    #[test]
    #[should_panic(expected = "requires a fresh snapshot path")]
    fn the_injected_generator_constructor_rejects_a_nonfresh_path() {
        let scratch = TempPath::new("injected-nonfresh");
        std::fs::write(scratch.path(), b"{}").expect("create existing snapshot");
        let _ = KeyMaterial::at_path_with_test_wrapping_key_generator(scratch.path());
    }

    #[test]
    fn a_write_failure_is_not_acknowledged_and_the_insert_can_be_retried() {
        let scratch = TempPath::new("write-failure");
        let km = KeyMaterial::at_path(scratch.path());
        km.insert("durable".to_owned(), [1u8; AES_KEY_LEN])
            .expect("persist baseline key");

        km.fail_next_persistence_at(PersistenceFault::Write);
        assert!(matches!(
            km.insert("tentative".to_owned(), [2u8; AES_KEY_LEN]),
            Err(CryptoError::KeyMaterialPersistence)
        ));
        assert!(
            !km.holds("tentative").expect("inspect failed insert"),
            "failed insert must roll back in memory"
        );
        assert!(scratch.temporary_files().is_empty());

        let restarted = KeyMaterial::at_path(scratch.path());
        assert!(restarted.holds("durable").expect("inspect durable key"));
        assert!(!restarted.holds("tentative").expect("inspect tentative key"));

        km.insert("tentative".to_owned(), [2u8; AES_KEY_LEN])
            .expect("retry succeeds");
        assert!(
            KeyMaterial::at_path(scratch.path())
                .holds("tentative")
                .expect("inspect retried key")
        );
    }

    #[test]
    fn a_snapshot_appearing_after_absence_is_never_overwritten_on_first_use() {
        let scratch = TempPath::new("appearance-before-first-use");
        let material = KeyMaterial::at_path(scratch.path());
        let external = br#"{"wrapping_private_key":null,"channel_keys":{"external":"BwcHBwcHBwcHBwcHBwcHBw=="}}"#;
        scratch.write_snapshot(external);

        assert!(matches!(
            material.insert("ours".to_owned(), [1u8; AES_KEY_LEN]),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::read(scratch.path()).expect("external snapshot remains"),
            external,
            "an Absent token must use no-replace rather than overwrite an appearance"
        );
        assert!(scratch.temporary_files().is_empty());
    }

    #[test]
    fn an_external_same_path_content_change_before_update_fails_the_digest_cas() {
        let scratch = TempPath::new("external-change-before-update");
        let material = KeyMaterial::at_path(scratch.path());
        material
            .insert("held".to_owned(), [2u8; AES_KEY_LEN])
            .expect("persist baseline");
        let original_metadata = std::fs::metadata(scratch.path()).expect("baseline metadata");
        let external =
            br#"{"wrapping_private_key":null,"channel_keys":{"held":"AwMDAwMDAwMDAwMDAwMDAw=="}}"#;
        std::fs::write(scratch.path(), external).expect("change bytes in the observed inode");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(scratch.path(), std::fs::Permissions::from_mode(0o600))
                .expect("retain private mode");
        }
        assert_eq!(
            std::fs::metadata(scratch.path())
                .expect("changed metadata")
                .len(),
            original_metadata.len(),
            "fixture must exercise content digest, not only size"
        );

        assert!(matches!(
            material.insert("later".to_owned(), [4u8; AES_KEY_LEN]),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::read(scratch.path()).expect("external remains"),
            external
        );
        assert!(scratch.temporary_files().is_empty());
    }

    #[test]
    fn a_replaced_pending_rename_is_never_published_after_directory_sync_retry() {
        let scratch = TempPath::new("replace-before-sync-retry");
        let material = KeyMaterial::at_path(scratch.path());
        material
            .insert("baseline".to_owned(), [5u8; AES_KEY_LEN])
            .expect("persist baseline");
        material.fail_next_persistence_at(PersistenceFault::DirectorySync);
        assert!(matches!(
            material.insert("pending".to_owned(), [6u8; AES_KEY_LEN]),
            Err(CryptoError::KeyMaterialPersistence)
        ));

        let replacement = br#"{"wrapping_private_key":null,"channel_keys":{"replacement":"BwcHBwcHBwcHBwcHBwcHBw=="}}"#;
        let replacement_path = scratch.path().with_extension("replacement");
        write_private(&replacement_path, replacement).expect("write external replacement");
        std::fs::rename(&replacement_path, scratch.path()).expect("replace pending path");

        assert!(matches!(
            material.holds("pending"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert_eq!(
            std::fs::read(scratch.path()).expect("replacement remains"),
            replacement
        );
        assert!(
            !material
                .state
                .lock()
                .expect("state")
                .keys
                .entries()
                .any(|(kid, _)| kid == "pending"),
            "an externally replaced pending candidate became visible in memory"
        );
    }

    #[test]
    fn an_unlinked_pending_rename_is_never_published_after_directory_sync_retry() {
        let scratch = TempPath::new("unlink-before-sync-retry");
        let material = KeyMaterial::at_path(scratch.path());
        material
            .insert("baseline".to_owned(), [8u8; AES_KEY_LEN])
            .expect("persist baseline");
        material.fail_next_persistence_at(PersistenceFault::DirectorySync);
        assert!(matches!(
            material.insert("pending".to_owned(), [9u8; AES_KEY_LEN]),
            Err(CryptoError::KeyMaterialPersistence)
        ));
        std::fs::remove_file(scratch.path()).expect("unlink pending candidate");

        assert!(matches!(
            material.holds("pending"),
            Err(CryptoError::SnapshotUnreadable)
        ));
        assert!(!scratch.path().exists());
        assert!(
            !material
                .state
                .lock()
                .expect("state")
                .keys
                .entries()
                .any(|(kid, _)| kid == "pending"),
            "an unlinked pending candidate became visible in memory"
        );
    }

    #[test]
    fn a_rename_failure_preserves_a_removed_key_and_the_remove_can_be_retried() {
        let scratch = TempPath::new("rename-failure");
        let km = KeyMaterial::at_path(scratch.path());
        km.insert("victim".to_owned(), [3u8; AES_KEY_LEN])
            .expect("persist baseline key");

        km.fail_next_persistence_at(PersistenceFault::Rename);
        assert!(matches!(
            km.remove("victim"),
            Err(CryptoError::KeyMaterialPersistence)
        ));
        assert!(
            km.holds("victim").expect("inspect failed remove"),
            "failed remove must roll back in memory"
        );
        assert!(
            KeyMaterial::at_path(scratch.path())
                .holds("victim")
                .expect("inspect restarted victim")
        );
        assert!(scratch.temporary_files().is_empty());

        assert!(km.remove("victim").expect("retry succeeds"));
        assert!(
            !KeyMaterial::at_path(scratch.path())
                .holds("victim")
                .expect("inspect removed victim")
        );
    }

    #[test]
    fn a_directory_sync_failure_stays_hidden_and_is_retried_before_use() {
        let scratch = TempPath::new("directory-sync-failure");
        let km = KeyMaterial::at_path(scratch.path());
        km.insert("durable".to_owned(), [3u8; AES_KEY_LEN])
            .expect("persist baseline key");

        km.fail_next_persistence_at(PersistenceFault::DirectorySync);
        assert!(matches!(
            km.insert("pending".to_owned(), [4u8; AES_KEY_LEN]),
            Err(CryptoError::KeyMaterialPersistence)
        ));

        // Every read is checked: it must report the durability outage rather
        // than presenting old committed state as a trustworthy answer.
        km.fail_next_persistence_at(PersistenceFault::DirectorySync);
        assert!(matches!(
            km.holds("durable"),
            Err(CryptoError::KeyMaterialPersistence)
        ));
        km.fail_next_persistence_at(PersistenceFault::DirectorySync);
        assert!(matches!(
            km.holds("pending"),
            Err(CryptoError::KeyMaterialPersistence)
        ));

        // The next operation retries the same post-rename candidate. Only once
        // the directory sync succeeds does it become visible and restartable.
        assert!(km.holds("pending").expect("retry directory sync"));
        assert!(
            KeyMaterial::at_path(scratch.path())
                .holds("pending")
                .expect("inspect restarted pending key")
        );
        assert!(scratch.temporary_files().is_empty());
    }

    #[test]
    fn a_wrapping_key_is_not_published_until_its_snapshot_rename_succeeds() {
        let scratch = TempPath::new("wrapping-rename-failure");
        let km = KeyMaterial::at_path_with_test_wrapping_key_generator(scratch.path());
        km.fail_next_persistence_at(PersistenceFault::Rename);

        assert!(matches!(
            km.wrapping_key(),
            Err(CryptoError::KeyMaterialPersistence)
        ));
        assert!(!scratch.path().exists());
        assert!(scratch.temporary_files().is_empty());

        let published = km.wrapping_key().expect("retry persists before publishing");
        let restarted = KeyMaterial::at_path_allowing_test_wrapping_key_restore(scratch.path());
        assert_eq!(
            restarted.wrapping_key().expect("restore").public_der(),
            published.public_der()
        );
    }

    #[test]
    fn concurrent_mutations_are_serialized_and_every_acknowledged_key_restarts() {
        use std::sync::Barrier;

        const WRITERS: usize = 16;
        let scratch = TempPath::new("concurrent");
        let km = Arc::new(KeyMaterial::at_path(scratch.path()));
        let barrier = Arc::new(Barrier::new(WRITERS));
        let threads: Vec<_> = (0..WRITERS)
            .map(|index| {
                let km = Arc::clone(&km);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    km.insert(format!("kid-{index}"), [index as u8; AES_KEY_LEN])
                })
            })
            .collect();

        for thread in threads {
            thread
                .join()
                .expect("writer did not panic")
                .expect("persisted");
        }
        assert!(scratch.temporary_files().is_empty(), "no temp race residue");

        let restarted = KeyMaterial::at_path(scratch.path());
        for index in 0..WRITERS {
            assert!(
                restarted
                    .holds(&format!("kid-{index}"))
                    .expect("inspect acknowledged key"),
                "acknowledged key {index} was lost"
            );
        }
    }
}
