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
//! Both halves of that lifecycle therefore need the *same* store: the privacy
//! service **writes** unwrapped channel keys into it, and the AI-bus
//! `Encrypted*` handlers **read** from it to open requests and seal responses.
//! This module owns that shared state so neither service has to reach into the
//! other.
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
//! keep sending forever. Both halves are therefore snapshotted: the RSA-OAEP
//! wrapping keypair (so the public key the device wrapped to stays valid) and the
//! `{kid -> channel key}` map.
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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use cosmos_crypto::{AES_KEY_LEN, ChannelKeyStore, CryptoError, EncryptedData, WrappingKeypair};
use serde::{Deserialize, Serialize};

/// Durability switch, shared with `store.rs`: unset means memory-only, which is
/// right for tests and local runs and wrong for anything a device talks to twice.
const STATE_DIR_ENV: &str = "COSMOS_STATE_DIR";

/// The server's ephemeral-key state: one RSA-OAEP wrapping keypair plus the
/// `{kid -> AES-128 channel key}` map the device populated.
pub struct KeyMaterial {
    /// Lazily generated so a 4096-bit keygen never blocks workload startup, and
    /// generated only once ever: after the first run it is restored from the
    /// snapshot, because the device wrapped to that exact public key.
    wrapping: Mutex<Option<Arc<WrappingKeypair>>>,
    /// Unwrapped ephemeral channel keys, keyed by kid.
    keys: Mutex<ChannelKeyStore>,
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
}

/// The on-disk form. Base64 because these are raw key bytes and JSON has no byte
/// string; `BTreeMap` so a snapshot is byte-stable across writes.
#[derive(Serialize, Deserialize, Default)]
struct KeySnapshot {
    /// PKCS#8 DER of the RSA-OAEP wrapping private key.
    wrapping_private_key: Option<String>,
    /// `kid -> AES-128 channel key`.
    channel_keys: BTreeMap<String, String>,
}

impl Default for KeyMaterial {
    /// Restores any snapshot this workload previously wrote.
    ///
    /// `Default` rather than a named `shared()` constructor because the workload
    /// builds its key material with `Default::default()` (`lib.rs`), and a
    /// durable store nothing constructs would be no fix at all.
    fn default() -> Self {
        let material = Self {
            wrapping: Mutex::new(None),
            keys: Mutex::new(ChannelKeyStore::default()),
            state_path: Self::configured_state_path(),
            snapshot_unreadable: AtomicBool::new(false),
        };
        material.restore();
        material
    }
}

impl KeyMaterial {
    /// Build key material persisting to an explicit path. Used by tests so
    /// durability can be exercised without touching process-global environment.
    #[cfg(test)]
    pub(crate) fn at_path(path: PathBuf) -> Self {
        let material = Self {
            wrapping: Mutex::new(None),
            keys: Mutex::new(ChannelKeyStore::default()),
            state_path: Some(path),
            snapshot_unreadable: AtomicBool::new(false),
        };
        material.restore();
        material
    }

    /// The server's RSA-OAEP wrapping keypair, generated on first use and kept
    /// from then on: the device caches the public half it wrapped to and never
    /// re-establishes, so a second keypair would fail every later `ImportKeys`
    /// unwrap with no way back.
    pub fn wrapping_key(&self) -> Result<Arc<WrappingKeypair>, CryptoError> {
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
        let mut guard = self.wrapping.lock().expect("key material poisoned");
        let generated = guard.is_none();
        if generated {
            *guard = Some(Arc::new(WrappingKeypair::generate()?));
        }
        let keypair = guard.as_ref().expect("wrapping key just set").clone();
        drop(guard);
        // Only the first-ever generation changes what is on disk; every later
        // `EstablishWrappingKeys` republishes the same key.
        if generated {
            self.persist();
        }
        Ok(keypair)
    }

    /// Record an unwrapped ephemeral channel key under its kid.
    pub fn insert(&self, kid: String, key: [u8; AES_KEY_LEN]) {
        self.keys
            .lock()
            .expect("keystore poisoned")
            .insert(kid, key);
        self.persist();
    }

    /// Whether any channel key has been established yet. Used to tell "the device
    /// never ran the key exchange" apart from "the envelope is undecryptable",
    /// so the encrypted RPCs can return an accurate gRPC status.
    pub fn is_empty(&self) -> bool {
        self.keys.lock().expect("keystore poisoned").is_empty()
    }

    /// Whether this exact kid is held. The key-lifecycle RPCs must answer per kid
    /// — "held" and "never seen" are different answers to the device, and a
    /// response that omits a kid entirely is the shape that wedges the client.
    pub fn holds(&self, kid: &str) -> bool {
        self.keys
            .lock()
            .expect("keystore poisoned")
            .entries()
            .any(|(known, _)| known == kid)
    }

    /// Forget a channel key. Returns whether it was held.
    ///
    /// The snapshot is rewritten so the removal survives a restart; otherwise a
    /// key the device believes gone would come back on the next boot and the two
    /// sides would disagree about the channel forever.
    pub fn remove(&self, kid: &str) -> bool {
        let removed = self.keys.lock().expect("keystore poisoned").remove(kid);
        if removed {
            self.persist();
        }
        removed
    }

    /// Open a device-sealed envelope with the channel key named by its kid.
    pub fn open(&self, enc: &EncryptedData) -> Result<Vec<u8>, CryptoError> {
        self.keys.lock().expect("keystore poisoned").open(enc)
    }

    /// Seal a server payload under an established channel key. `aad` is the
    /// envelope's additional authenticated data (empty on the assistant path).
    pub fn seal(
        &self,
        kid: &str,
        plaintext: &[u8],
        aad: &[u8],
    ) -> Result<EncryptedData, CryptoError> {
        self.keys
            .lock()
            .expect("keystore poisoned")
            .seal(kid, plaintext, aad)
    }

    /// Where this workload persists its key material, from the environment.
    ///
    /// One file per workload, and a *different* file from the store snapshot:
    /// long-lived key material does not belong in the same blob as wearer data.
    fn configured_state_path() -> Option<PathBuf> {
        let dir = std::env::var(STATE_DIR_ENV).ok()?;
        if dir.trim().is_empty() {
            return None;
        }
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).ok()?;
        let workload = std::env::var("COSMOS_WORKLOAD").unwrap_or_else(|_| "workload".to_owned());
        Some(dir.join(format!("{workload}-keymaterial.json")))
    }

    /// Write the current key material. Best-effort: a snapshot failure must never
    /// fail the wearer's request, but it is not silent either — and it never
    /// names a kid or a key in the log line.
    fn persist(&self) {
        let Some(path) = self.state_path.as_ref() else {
            return;
        };
        // The one write that must never happen. Everything else in this module
        // is best-effort; this is the case where writing destroys the only copy.
        if self.snapshot_unreadable.load(Ordering::SeqCst) {
            tracing::error!(
                path = %path.display(),
                "refusing to overwrite an unreadable key-material snapshot; move or repair the file and restart to recover the established channel keys"
            );
            return;
        }
        let base64 = base64::engine::general_purpose::STANDARD;
        let snapshot = {
            let wrapping = self.wrapping.lock().expect("key material poisoned");
            let keys = self.keys.lock().expect("keystore poisoned");
            KeySnapshot {
                wrapping_private_key: wrapping
                    .as_ref()
                    .and_then(|kp| kp.private_pkcs8_der().ok())
                    .map(|der| base64.encode(der)),
                channel_keys: keys
                    .entries()
                    .map(|(kid, key)| (kid.to_owned(), base64.encode(key)))
                    .collect(),
            }
        };

        let Ok(encoded) = serde_json::to_vec(&snapshot) else {
            tracing::warn!("could not encode the key-material snapshot");
            return;
        };
        // Write-and-rename so a crash mid-write cannot leave a truncated file
        // that would read back as "the device never ran the key exchange".
        let temporary = path.with_extension("json.tmp");
        if write_private(&temporary, &encoded).is_err()
            || std::fs::rename(&temporary, path).is_err()
        {
            tracing::warn!("could not persist the key-material snapshot");
        }
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
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return, // first run
            Err(error) => {
                tracing::error!(
                    path = %path.display(),
                    error = %error,
                    "key-material snapshot exists but could not be read; the encrypted transport stays down and this process will not write over it"
                );
                self.snapshot_unreadable.store(true, Ordering::SeqCst);
                return;
            }
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
        // `from_private_pkcs8_der` means the file HAS a wrapping key we cannot
        // read — corrupt bytes, a truncated field, an algorithm we can no longer
        // load. Falling through here (the old `if let … && let Ok … && let Ok`
        // chain did exactly that) left `wrapping = None` with
        // `snapshot_unreadable` still false, so the next `wrapping_key()` minted
        // a REPLACEMENT keypair and `persist()` wrote it over the only copy of
        // the key the device wrapped to — the exact irreversible strand this flag
        // exists to prevent, reached through a snapshot whose JSON parsed fine.
        // Treat it like an unreadable file or unparseable JSON: refuse to
        // overwrite, and report the true cause rather than a first run.
        if let Some(encoded) = snapshot.wrapping_private_key.as_ref() {
            match base64
                .decode(encoded)
                .ok()
                .and_then(|der| WrappingKeypair::from_private_pkcs8_der(&der).ok())
            {
                Some(keypair) => {
                    *self.wrapping.lock().expect("key material poisoned") = Some(Arc::new(keypair));
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

        let mut keys = self.keys.lock().expect("keystore poisoned");
        for (kid, encoded) in snapshot.channel_keys {
            if let Ok(raw) = base64.decode(encoded)
                && let Ok(key) = <[u8; AES_KEY_LEN]>::try_from(raw.as_slice())
            {
                keys.insert(kid, key);
            }
        }
    }
}

/// Write a file only the workload's own user can read. The snapshot is
/// cleartext key material (see the module doc), so the mode is the protection.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
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
        assert!(km.is_empty());
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]);
        assert!(!km.is_empty());

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
            wrapping: Mutex::new(None),
            keys: Mutex::new(ChannelKeyStore::default()),
            state_path: None,
            snapshot_unreadable: AtomicBool::new(false),
        };
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]);
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
            km.insert(kid.to_owned(), [7u8; AES_KEY_LEN]);
            km.seal(kid, b"hello pin", b"")
                .expect("seal before restart")
        };

        let restarted = KeyMaterial::at_path(scratch.path());
        assert!(
            !restarted.is_empty(),
            "a restarted server must still hold the channel key the device established"
        );
        assert_eq!(
            restarted.open(&sealed).expect("open after restart"),
            b"hello pin"
        );
    }

    /// The device caches the wrapping public key it wrapped to and never
    /// re-establishes, so a restart that mints a fresh keypair would fail every
    /// later `ImportKeys` unwrap.
    #[test]
    fn the_wrapping_keypair_survives_a_restart() {
        let scratch = TempPath::new("wrapping");

        let (public_der, wrapped) = {
            let km = KeyMaterial::at_path(scratch.path());
            let kp = km.wrapping_key().expect("generate");
            let wrapped = cosmos_crypto::wrap_channel_key(kp.public_der(), &[3u8; AES_KEY_LEN])
                .expect("device wraps to the published key");
            (kp.public_der().to_vec(), wrapped)
        };

        let restarted = KeyMaterial::at_path(scratch.path());
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
        std::fs::write(scratch.path(), b"{ not json").expect("write corrupt snapshot");

        let km = KeyMaterial::at_path(scratch.path());
        assert!(km.is_empty());
        assert_eq!(
            std::fs::read(scratch.path()).expect("still there"),
            b"{ not json"
        );

        assert!(
            matches!(km.wrapping_key(), Err(CryptoError::SnapshotUnreadable)),
            "an unreadable snapshot must fail the RPC, not mint a keypair no device wrapped to"
        );
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]);
        assert!(km.remove("kid-1"));

        assert_eq!(
            std::fs::read(scratch.path()).expect("still there after every write path"),
            b"{ not json",
            "no code path may overwrite the only copy of the established channel keys"
        );
        assert!(
            !scratch.path().with_extension("json.tmp").exists(),
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
        // are not a PKCS#8 key (so `from_private_pkcs8_der` rejects them). This
        // is the insidious case: the field is present and even base64-clean —
        // only the key bytes are bad — so nothing upstream catches it.
        let bogus = base64.encode(b"this is not a PKCS#8 wrapping private key");
        let snapshot = format!("{{\"wrapping_private_key\":\"{bogus}\",\"channel_keys\":{{}}}}");
        std::fs::write(scratch.path(), snapshot.as_bytes()).expect("write snapshot");

        let km = KeyMaterial::at_path(scratch.path());
        assert!(
            matches!(km.wrapping_key(), Err(CryptoError::SnapshotUnreadable)),
            "a recorded-but-undecodable wrapping key must fail the RPC, not mint a \
             replacement no device wrapped to"
        );
        // Every write path must now refuse to touch the file.
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]);
        assert!(km.remove("kid-1"));
        assert_eq!(
            std::fs::read(scratch.path()).expect("still there"),
            snapshot.as_bytes(),
            "no code path may overwrite a snapshot whose wrapping key merely failed to decode"
        );
        assert!(
            !scratch.path().with_extension("json.tmp").exists(),
            "the write-and-rename temporary must not be left behind either"
        );
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
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]);

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
        km.insert("kid-1".to_owned(), [7u8; AES_KEY_LEN]);

        let mode = std::fs::metadata(scratch.path())
            .expect("snapshot written")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "cleartext key material must stay 0600");
    }
}
