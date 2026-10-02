//! The device-enrollment ceremony: OPAQUE login, the H4 seal, and DeviceUser
//! certificate issuance.
//!
//! ## What the device does, and what we must answer
//!
//! A stock Pin never *registers*, its `libopaque.so` JNI surface is login-only.
//! The owner set a four-digit passcode on humane.center, and the Pin's onboarding
//! asks for it ("You have not set your pincode yet. Go to .center and set it.",
//! `PincodeNode.onPincodeNotSet`). So the ceremony here is:
//!
//! 1. The signed-in owner sets or changes their Pin passcode in Center
//!    (`PUT /account-service/passcode`, `account_api.rs`). Cosmos runs both
//!    halves of OPAQUE registration for that account ([`set_passcode`]) and
//!    stores only the resulting password file, keyed by the account. The
//!    passcode itself is never stored. Where registration ran in stock is not
//!    recoverable (INFERRED: the web page, or its backend). The device never
//!    registers.
//! 2. The device runs `ClientLogin` against the record of the account it is
//!    paired to: `CreateLoginInit` carries its KE1, we answer with KE2
//!    ([`Enrollment::login_init`]); `CreateLoginFinish` carries its KE3, we
//!    finish and both sides derive the SAME 32-byte session key
//!    ([`Enrollment::login_finish`]). An account with no passcode is answered
//!    `OPAQUE_LOGIN_STATUS_MISSING_REGISTRATION`, which the stock Pin turns into
//!    the "set it at .center" screen (`UserBindingManager.loginStart` →
//!    `MissingCredentialsException` → provisioning error 6).
//! 3. The device seals a `CreateDeviceUserBinding` under that session key, an
//!    attestation blob plus a PKCS#10 CSR. We open the attestation (proving the
//!    caller holds the session key), issue a DeviceUser certificate for the CSR's
//!    public key signed by the configured DeviceUser CA, and seal it back
//!    ([`Enrollment::issue_duc`] + [`Enrollment::seal_h4`]).
//!
//! ## The suite, recovered rather than guessed
//!
//! The cipher suite is pinned by what the device's `libopaque.so` was built from:
//! **opaque-ke 2.0.0 over NIST P-256 with Argon2 key stretching** (no
//! `curve25519-dalek`, no ristretto anywhere in the binary. SHA-256 is the
//! standard P-256 OPRF hash → a 32-byte session key). See [`CosmosSuite`].
//!
//! The Argon2 key-stretching function is `argon2::Argon2::default()`, which
//! opaque-ke constructs via the `Ksf: Default` bound: Argon2id, version 0x13,
//! `m_cost = 4096` KiB, `t_cost = 3`, `p_cost = 1`. Our own client and server use
//! the identical KSF.
//!
//! **VERIFIED against the real device binary (2026-08-06).** `libopaque.so`
//! extracted from `humane_onboarding.apk` (system_a firmware) links the SAME
//! `opaque-ke 2.0.0` and `argon2 0.4.1`, both crates' `cargo/registry` paths are
//! embedded verbatim in the binary, alongside `voprf 0.4.0-pre.3`, `sec1 0.3.0`
//! and `elliptic-curve 0.12.3` (P-256, no ristretto) and
//! `key_exchange/tripledh.rs`. Critically, opaque-ke 2.0.0 *default-constructs*
//! the KSF, `src/opaque.rs:1112` calls `CS::Ksf::default().hash(...)` under
//! `pub trait Ksf: Default`, with no API to supply Argon2 parameters, so both
//! sides necessarily compute `argon2-0.4.1::Params::default()`
//! (`DEFAULT_M_COST = 4096`, `DEFAULT_T_COST = 3`, `DEFAULT_P_COST = 1`). The
//! parameters are therefore identical by construction, not by assumption: a real
//! Pin's OPAQUE login cannot diverge on them.
//!
//! ## The H4 seal is NOT cosmos-crypto's envelope
//!
//! The DeviceUser-binding seal is AES-256-GCM keyed by the 32-byte OPAQUE session
//! key, with a 12-byte random IV, a 128-bit tag, and no AAD, output is
//! `ciphertext ‖ tag` (JCA/`Cipher.doFinal` layout). This is deliberately separate
//! from `cosmos-crypto`'s AES-128 Krypton envelope, which serves the AI-bus
//! channel, not enrollment.
//!
//! ## Every piece of ceremony state outlives the process, on purpose
//!
//! Provisioning runs more than one replica. `CreateLoginInit` and
//! `CreateLoginFinish` are separate RPCs and can land on different pods, and the
//! binding RPC is a third hop again. Holding the OPAQUE `ServerSetup`, the
//! password file, the in-flight `ServerLogin`, or the derived session key in
//! process memory means enrollment can simply never complete behind a load
//! balancer, and a per-pod `ServerSetup` silently invalidates every password file
//! it ever produced, because the OPRF seed it carries is what makes a record
//! openable. All four therefore live behind [`EnrollmentStore`]:
//! [`MemoryEnrollmentStore`] keeps the old process-lifetime behaviour (tests,
//! single-replica local runs) and [`PostgresEnrollmentStore`] is the durable
//! implementation every replica shares.
//!
//! ## An attempt ceiling is not optional here
//!
//! OPAQUE guarantees the server never learns the pincode and that a passive
//! observer learns nothing. It guarantees nothing at all about a caller who keeps
//! asking, and every KE2 this server answers is exactly one offline test of one
//! guess against a **four-digit code**. The ceiling
//! in [`MAX_LOGIN_ATTEMPTS`] is therefore part of the protocol's security
//! argument rather than a nicety bolted on top, and the stock server metered
//! it too, which is why `OPAQUE_LOGIN_STATUS_RATE_LIMIT_HIT` and the device's
//! `LockOutNode` exist. It is charged in [`Enrollment::login_init`], because that
//! is the RPC that hands out the guess: a wrong pincode is detected inside the
//! device's own `clientLoginFinish` and never sends a KE3 at all.
//!
//! ## `COSMOS_ENROLLMENT_OPEN` gates the ceremony, not just a screen
//!
//! [`enrollment_open`] is consulted by all three ceremony entry points
//! ([`Enrollment::login_init`], [`Enrollment::login_finish`] and
//! [`Enrollment::session_key`], which is what `CreateDeviceUserBinding` reaches
//! the ceremony through). It used to reach only `VerifyHmcByPass`, whose answer
//! is advisory, nothing stops a caller from skipping that screen, so an
//! operator who closed enrollment still had an open OPAQUE ceremony and an open
//! DeviceUser CA.
//!
//! ## The DeviceUser CA is configuration, never generated
//!
//! A certificate is only useful if the *other* replicas, and the mesh edge that
//! authenticates the device on its next connection, trust its issuer. A CA minted
//! at startup is trusted by exactly one pod for exactly one process lifetime, so
//! every restart silently invalidates every certificate it ever issued. The CA is
//! therefore loaded from `COSMOS_DUC_CA_CERT`/`COSMOS_DUC_CA_KEY` and enrollment is
//! honestly [`unimplemented`](tonic::Code::Unimplemented) without it. **Operators
//! must mount the same CA key/cert in every provisioning replica** and in the
//! edge's DeviceUser trust bundle.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::Argon2;
use base64::Engine as _;
use opaque_ke::{
    CipherSuite, ClientRegistration, ClientRegistrationFinishParameters, CredentialFinalization,
    CredentialRequest, ServerLogin, ServerLoginStartParameters, ServerRegistration, ServerSetup,
};
use p256::ecdsa::signature::Verifier as _;
use rand::{RngCore, SeedableRng, rngs::OsRng, rngs::StdRng};
use tonic::Status;

/// cosmos's OPAQUE cipher suite, as recovered from the device's `libopaque.so`.
///
/// P-256's VOPRF hashes with SHA-256, so `session_key` is 32 bytes.
pub struct CosmosSuite;

impl CipherSuite for CosmosSuite {
    type OprfCs = p256::NistP256;
    type KeGroup = p256::NistP256;
    type KeyExchange = opaque_ke::key_exchange::tripledh::TripleDh;
    type Ksf = Argon2<'static>;
}

/// The fallback user's name on the operator console when
/// `COSMOS_ENROLLMENT_DISPLAY_NAME` is unset. A Pin's welcome screen shows the
/// account's own preferred name instead (`CreateLoginFinish`).
const DEFAULT_DISPLAY_NAME: &str = "Cosmos User";

/// Fixed 32-byte seed used to *propose* the OPAQUE `ServerSetup` when
/// `COSMOS_OPAQUE_SEED` is unset or malformed.
///
/// The proposal only matters the first time: whichever setup reaches the store
/// first wins forever after (see [`EnrollmentStore::server_setup_or_install`]),
/// because a changed setup silently invalidates every password file it created.
// Deployed password files were derived from this exact legacy setup seed.
// The product rename must never mint a second OPAQUE server setup over the same
// database: that would make every existing password file unverifiable.
const DEFAULT_OPAQUE_SEED: [u8; 32] = *b"cosmos-revival-opaque-seed-00001";

/// The clone's single enrolled user id, a stable, deterministic UUID.
///
/// It is returned as the `user_id` of a finished login and, as bytes, doubles as
/// the OPAQUE `credential_id`: the registered record and every login must agree on
/// it, so it is fixed rather than minted per process. Its lowercase-hyphenated
/// rendering also has to satisfy the device's `DEVICE_USER_SUBJECT_PATTERN`
/// (`hu.ma.ne.core.DeviceConstants`), which only accepts `[a-f0-9]` UUIDs.
const ENROLLMENT_USER_UUID: uuid::Uuid = uuid::Uuid::from_bytes([
    0xca, 0x22, 0x1c, 0x10, 0xde, 0x71, 0x4c, 0xe0, 0x8b, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
]);

/// PEM path of the DeviceUser-issuing CA certificate.
pub const DUC_CA_CERT_ENV: &str = "COSMOS_DUC_CA_CERT";
/// PEM (PKCS#8) path of the DeviceUser-issuing CA private key.
pub const DUC_CA_KEY_ENV: &str = "COSMOS_DUC_CA_KEY";

/// The gRPC health service name under which the provisioning workload publishes
/// whether a DeviceUser binding can complete here.
///
/// The operator console runs in the AI-bus workload and the CA is mounted only
/// on provisioning, so the console cannot see the material and used to guess
/// from its own environment, reporting "No DeviceUser CA" in every shipped
/// environment. `grpc.health.v1.Health` is the one cross-container channel that
/// already exists and is exempt from authentication (`auth.rs`), so a named
/// sub-service on it lets the workload that HOLDS the CA answer the question,
/// with no new route, no new RPC and no shared admin token.
///
/// The legacy-qualified name is a deployed mixed-version contract. A logical
/// product rename must not make an older AI-bus unable to observe readiness
/// while a rollback-compatible provisioning workload is running.
pub const DUC_CA_HEALTH_SERVICE: &str = "cosmos.enrollment.DeviceUserCa";

/// Whether this process can issue a DeviceUser certificate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DucCaReadiness {
    /// The CA loaded, and the key really is the certificate's key.
    Ready,
    /// No CA is configured in this process.
    NotConfigured,
    /// A CA is configured and could not be used. The reason is logged where it
    /// is discovered rather than returned, because it names filesystem paths.
    Unusable,
}

/// Load the configured DeviceUser CA and report whether it is usable.
///
/// A REAL check, not an env-presence one: [`DucCa::from_pem`] parses the
/// certificate and refuses a key that is not its key, the exact mismatch that
/// otherwise produces a Pin failing mTLS against a leaf that verifies against
/// nothing. Two non-empty variable names prove none of that.
pub fn duc_ca_readiness() -> DucCaReadiness {
    match DucCa::from_env() {
        Ok(Some(_)) => DucCaReadiness::Ready,
        Ok(None) => DucCaReadiness::NotConfigured,
        Err(detail) => {
            tracing::error!(%detail, "the configured DeviceUser CA cannot issue certificates");
            DucCaReadiness::Unusable
        }
    }
}

/// How long an in-flight `ServerLogin` stays poppable.
///
/// The device runs `CreateLoginInit` → `CreateLoginFinish` back to back, so this
/// only has to survive a slow network, not a slow wearer. Anything older is a
/// leaked row, not a live ceremony.
const LOGIN_STATE_TTL_SECONDS: i64 = 300;

/// How long a finished login's session key stays usable for the binding RPC.
///
/// Longer than the login TTL because `CreateDeviceUserBinding` follows a CSR
/// generation that can touch the device's secure keystore, but still short: the
/// key is the only thing standing between a caller and a DeviceUser certificate.
const SESSION_TTL_SECONDS: i64 = 900;

/// How many `CreateLoginInit` answers one principal may draw inside
/// [`LOGIN_ATTEMPT_WINDOW_SECONDS`] before the ceremony refuses it.
///
/// **This is the control OPAQUE's security argument actually depends on.** The
/// protocol's guarantee is that the server never learns the password and a
/// passive observer learns nothing, it says nothing about a caller who simply
/// keeps asking. Every KE2 we answer with is exactly one offline password test
/// (the client's own `clientLoginFinish` decides locally whether the envelope MAC
/// matches, `ProvisioningAccessManager$4.lambda$finishClientLogin$0`, a wrong
/// pincode never even sends a KE3), and the credential here is a **four-digit
/// code**. Unmetered, that is a 10^4 keyspace an attacker walks at line rate.
///
/// The stock server metered it too: `OPAQUE_LOGIN_STATUS_RATE_LIMIT_HIT`
/// (`humane/provisioning/OpaqueLoginStatusCode.java:9`) exists for no other
/// reason, and the device has a whole wearer-facing lockout screen behind it
/// (`UserBindingManager.checkForRateLimitHit:144` →
/// `ProvisioningAccessManager$3.1.onRateLimitChecked` →
/// `PincodeNode.onLimitRateHit` → `showRateLimitMessage()` → `LockOutNode`).
///
/// Ten per quarter-hour is chosen for the wearer, not the attacker: onboarding is
/// one pincode entry and a fat-fingered wearer retries a handful of times, while
/// 10^4 codes at ten per 900 s is still more than ten days. The ceiling is a constant rather than
/// configuration on purpose, an environment variable that relaxes an attempt
/// ceiling is a gate an operator can turn off by accident.
const MAX_LOGIN_ATTEMPTS: u32 = 10;

/// The window [`MAX_LOGIN_ATTEMPTS`] is counted over, and therefore how long a
/// locked-out principal stays locked out.
///
/// Measured from the FIRST attempt in the window, so hammering the lock does not
/// extend it: a wearer who genuinely exhausted the ceiling gets back in without
/// operator involvement, which matters because the device offers no other way out
/// of `LockOutNode`.
const LOGIN_ATTEMPT_WINDOW_SECONDS: i64 = 900;

/// Validity of an issued DeviceUser certificate, in days.
///
/// A clone choice, not a recovered value: the device has no renewal path short of
/// re-running onboarding, so a short-lived DeviceUser certificate would strand a
/// wearer with a Pin that stops authenticating and no way to notice why.
const DUC_VALIDITY_DAYS: i64 = 3650;

/// Clock-skew allowance on an issued certificate's `notBefore`.
const DUC_BACKDATE_SECONDS: i64 = 3600;

/// A failure in the sealing or certificate-issuance half of the ceremony.
///
/// Deliberately coarse: it carries no protocol detail that a caller could turn
/// into an oracle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrollmentError {
    /// An AEAD open failed, wrong key, wrong IV length, or a corrupt payload.
    Crypto,
    /// The PKCS#10 CSR could not be parsed, did not prove possession of its own
    /// private key, or could not be signed.
    Csr,
    /// The caller's principal is not a device subject we can name, so there is no
    /// server-side identity to put in a DeviceUser certificate.
    Principal,
    /// A device-attestation signature did not verify against the attestation
    /// certificate the edge forwarded.
    Attestation,
    /// Durable ceremony state could not be read or written.
    Store,
}

impl std::fmt::Display for EnrollmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Crypto => f.write_str("encrypted payload could not be opened"),
            Self::Csr => f.write_str("certificate signing request could not be honoured"),
            Self::Principal => f.write_str("caller principal is not a device subject"),
            Self::Attestation => f.write_str("device attestation signature did not verify"),
            Self::Store => f.write_str("enrollment state could not be read or written"),
        }
    }
}

impl std::error::Error for EnrollmentError {}

impl From<EnrollmentError> for Status {
    fn from(error: EnrollmentError) -> Self {
        match error {
            // A payload that will not open under the session key is not
            // authenticated for this binding.
            EnrollmentError::Crypto => {
                Status::permission_denied("attestation could not be opened with the session key")
            }
            EnrollmentError::Csr => {
                Status::invalid_argument("device-user CSR could not be honoured")
            }
            EnrollmentError::Principal => Status::permission_denied(
                "caller is not authenticated as a device; no DeviceUser identity to issue",
            ),
            EnrollmentError::Attestation => {
                Status::unauthenticated("device attestation signature did not verify")
            }
            // UNAVAILABLE, not INTERNAL: losing durable ceremony state is
            // transient, and it is the one failure the device's onboarding UI
            // renders as a retry (see `Enrollment::login_finish`).
            EnrollmentError::Store => {
                Status::unavailable("enrollment state is temporarily unavailable")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Durable ceremony state
// ---------------------------------------------------------------------------

/// Ceremony state could not be read or written.
///
/// Coarse on purpose, exactly like [`crate::store::StoreError`]: a caller must not
/// be able to tell a missing row from a broken connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnrollmentStoreError;

impl std::fmt::Display for EnrollmentStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("enrollment state could not be read or written")
    }
}

impl std::error::Error for EnrollmentStoreError {}

impl From<EnrollmentStoreError> for EnrollmentError {
    fn from(_: EnrollmentStoreError) -> Self {
        Self::Store
    }
}

impl From<EnrollmentStoreError> for Status {
    fn from(_: EnrollmentStoreError) -> Self {
        EnrollmentError::Store.into()
    }
}

/// Result of a durable enrollment-state operation.
pub type Stored<T> = Result<T, EnrollmentStoreError>;

/// The four pieces of enrollment state that must be shared by every replica.
///
/// Modelled on [`crate::store::Store`]: async, principal-keyed, and coarse in its
/// error type. It is a *separate* trait with its own tables rather than more
/// methods on `Store` because enrollment is the provisioning workload's private
/// business, no other workload has any reason to reach this state, and the tables
/// hold key material the contact/capture surfaces must never touch.
#[tonic::async_trait]
pub trait EnrollmentStore: Send + Sync + 'static {
    /// INFERRED Luma policy: one provisioned Pin per server. Atomic and durable;
    /// removing a pairing never releases this slot or revokes its certificate.
    async fn reserve_provisioned_device(&self, device_id: &str) -> Stored<bool>;
    async fn provisioned_device(&self) -> Stored<Option<String>>;

    /// The deployment's OPAQUE `ServerSetup`, installing `candidate` if and only
    /// if none is stored yet.
    ///
    /// Install-if-absent rather than write-through: the stored setup wins forever,
    /// because replacing it invalidates every password file derived from its OPRF
    /// seed. Two replicas racing on a fresh database must therefore agree on one
    /// winner, not on "whoever wrote last".
    async fn server_setup_or_install(&self, candidate: &[u8]) -> Stored<Vec<u8>>;

    /// The OPAQUE password file `account` registered when its owner set their
    /// Pin passcode, or `None` when they have not set one.
    async fn passcode_record(&self, account: &str) -> Stored<Option<Vec<u8>>>;

    /// Store `account`'s password file, replacing any earlier one.
    ///
    /// Replace, not install-if-absent: changing the passcode is the owner's
    /// deliberate act, and replacing the record is what makes the old passcode
    /// stop opening.
    async fn put_passcode_record(&self, account: &str, record: &[u8]) -> Stored<()>;

    /// Forget `account`'s password file. `true` when there was one.
    async fn delete_passcode_record(&self, account: &str) -> Stored<bool>;

    /// Stash the in-flight `ServerLogin` for `principal`, replacing any previous
    /// one (a device that restarts its login abandons the old KE1).
    async fn put_login(&self, principal: &str, state: &[u8]) -> Stored<()>;

    /// Atomically remove and return the in-flight state for `principal`.
    ///
    /// **One-shot.** A `ServerLogin` that survived its `finish` would let a
    /// captured KE3 be replayed into a fresh session key.
    async fn take_login(&self, principal: &str) -> Stored<Option<Vec<u8>>>;

    /// Record the session key a finished login established for `principal`.
    async fn put_session(&self, principal: &str, session_key: &[u8; 32]) -> Stored<()>;

    /// The live session key for `principal`, if a login finished recently enough.
    ///
    /// Not one-shot: `CreateDeviceUserBinding` is the device's *next* RPC and it
    /// retries. Bounded by [`SESSION_TTL_SECONDS`] instead.
    async fn session(&self, principal: &str) -> Stored<Option<[u8; 32]>>;

    /// Count one pincode attempt against `principal` and return how many it has
    /// now made inside [`LOGIN_ATTEMPT_WINDOW_SECONDS`].
    ///
    /// **Check-and-increment in one call, deliberately.** A separate "read the
    /// counter" method would be a TOCTOU seam: two replicas serving a burst would
    /// both read a count below the ceiling and both answer with a KE2. The
    /// returned value is the count *including* this attempt, so the caller
    /// compares it against [`MAX_LOGIN_ATTEMPTS`] and refuses on `>`.
    ///
    /// The window restarts when the stored one has fully elapsed, never on each
    /// attempt, see [`LOGIN_ATTEMPT_WINDOW_SECONDS`].
    async fn record_login_attempt(&self, principal: &str) -> Stored<u32>;

    /// Forget `principal`'s attempts, because it just proved it knows the
    /// pincode.
    async fn clear_login_attempts(&self, principal: &str) -> Stored<()>;

    /// Pair a device to the account (Keycloak `sub`) it enrolls into, unless
    /// another account already holds it. `true` when the device is now paired
    /// to `account_sub` (newly, or as before); `false` when another account
    /// holds it, which is left untouched.
    ///
    /// Check-and-insert in one call, so two wearers claiming one Pin at once
    /// cannot both win. Stock: "To give this Ai Pin to another person, initiate
    /// contact with support to unlink it from your account"
    /// (`factory_reset_instructions`), a paired Pin is released only by its
    /// owner.
    async fn claim_device_account(&self, device_id: &str, account_sub: &str) -> Stored<bool>;

    /// Remove one device binding only when it still belongs to the expected
    /// account. The compare-and-delete is atomic so a concurrent transfer can
    /// never be undone by a stale Center tab.
    async fn delete_device_account(
        &self,
        device_id: &str,
        expected_account_sub: &str,
    ) -> Stored<bool>;

    /// The account a device is paired to, if any. Absence is not an error, it is
    /// the signal to fall back to the deployment's single configured user.
    async fn device_account(&self, device_id: &str) -> Stored<Option<String>>;

    /// Every durable device-to-account pairing, oldest first.
    ///
    /// This is an operator roster, not an authentication input: enrollment still
    /// resolves one exact device through [`EnrollmentStore::device_account`].
    async fn device_accounts(&self) -> Stored<Vec<DeviceAccountPairing>>;
}

/// A device claim recorded by the wearer's own pairing route.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
pub struct DeviceAccountPairing {
    pub device_id: String,
    pub account_sub: String,
    pub paired_at_epoch: i64,
}

/// Handle shared by the provisioning handlers, mirroring [`crate::store::SharedStore`].
pub type SharedEnrollmentStore = Arc<dyn EnrollmentStore>;

/// Epoch seconds, saturating at the epoch for a clock set before 1970.
fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// A stashed value with the instant it was written, so a reader can enforce a TTL.
///
/// No `Debug`: the session-key variant holds key material (the precedent set by
/// the secret-bearing records in `store.rs`).
struct Timed {
    value: Vec<u8>,
    written: i64,
}

/// Process-lifetime [`EnrollmentStore`], the previous behaviour, kept for tests
/// and single-replica local runs.
///
/// Correct for exactly one replica. Behind a load balancer it is the bug this
/// trait exists to fix: `CreateLoginFinish` lands on a pod that never saw the
/// matching `CreateLoginInit`.
#[derive(Default)]
pub struct MemoryEnrollmentStore {
    provisioned_device: Mutex<Option<String>>,
    server_setup: Mutex<Option<Vec<u8>>>,
    /// `account -> password file`.
    passcodes: Mutex<std::collections::HashMap<String, Vec<u8>>>,
    logins: Mutex<std::collections::HashMap<String, Timed>>,
    sessions: Mutex<std::collections::HashMap<String, Timed>>,
    /// `principal -> (attempts in the current window, when that window opened)`.
    attempts: Mutex<std::collections::HashMap<String, (u32, i64)>>,
    /// `device_id -> (account_sub, paired_at_epoch)`, the pairing routing table.
    device_accounts: Mutex<std::collections::HashMap<String, (String, i64)>>,
}

impl MemoryEnrollmentStore {
    pub fn shared() -> SharedEnrollmentStore {
        Arc::new(Self::default())
    }
}

#[tonic::async_trait]
impl EnrollmentStore for MemoryEnrollmentStore {
    async fn reserve_provisioned_device(&self, device_id: &str) -> Stored<bool> {
        let mut slot = self
            .provisioned_device
            .lock()
            .expect("provisioned device poisoned");
        Ok(slot.get_or_insert_with(|| device_id.to_owned()) == device_id)
    }

    async fn provisioned_device(&self) -> Stored<Option<String>> {
        Ok(self
            .provisioned_device
            .lock()
            .expect("provisioned device poisoned")
            .clone())
    }

    async fn server_setup_or_install(&self, candidate: &[u8]) -> Stored<Vec<u8>> {
        let mut stored = self.server_setup.lock().expect("opaque setup poisoned");
        Ok(stored.get_or_insert_with(|| candidate.to_vec()).clone())
    }

    async fn passcode_record(&self, account: &str) -> Stored<Option<Vec<u8>>> {
        Ok(self
            .passcodes
            .lock()
            .expect("passcodes poisoned")
            .get(account)
            .cloned())
    }

    async fn put_passcode_record(&self, account: &str, record: &[u8]) -> Stored<()> {
        self.passcodes
            .lock()
            .expect("passcodes poisoned")
            .insert(account.to_owned(), record.to_vec());
        Ok(())
    }

    async fn delete_passcode_record(&self, account: &str) -> Stored<bool> {
        Ok(self
            .passcodes
            .lock()
            .expect("passcodes poisoned")
            .remove(account)
            .is_some())
    }

    async fn put_login(&self, principal: &str, state: &[u8]) -> Stored<()> {
        self.logins.lock().expect("logins poisoned").insert(
            principal.to_owned(),
            Timed {
                value: state.to_vec(),
                written: now_epoch_seconds(),
            },
        );
        Ok(())
    }

    async fn take_login(&self, principal: &str) -> Stored<Option<Vec<u8>>> {
        let popped = self
            .logins
            .lock()
            .expect("logins poisoned")
            .remove(principal);
        Ok(popped
            .filter(|timed| now_epoch_seconds() - timed.written <= LOGIN_STATE_TTL_SECONDS)
            .map(|timed| timed.value))
    }

    async fn put_session(&self, principal: &str, session_key: &[u8; 32]) -> Stored<()> {
        self.sessions.lock().expect("sessions poisoned").insert(
            principal.to_owned(),
            Timed {
                value: session_key.to_vec(),
                written: now_epoch_seconds(),
            },
        );
        Ok(())
    }

    async fn session(&self, principal: &str) -> Stored<Option<[u8; 32]>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let Some(timed) = sessions.get(principal) else {
            return Ok(None);
        };
        if now_epoch_seconds() - timed.written > SESSION_TTL_SECONDS {
            return Ok(None);
        }
        // A stored key of the wrong length is CORRUPTION, not "no completed
        // login". Collapsing it to `Ok(None)` would send the wearer back through
        // the whole pincode ceremony instead of reporting a store problem.
        match <[u8; 32]>::try_from(timed.value.as_slice()) {
            Ok(key) => Ok(Some(key)),
            Err(_) => {
                tracing::error!("stored OPAQUE session key has the wrong length");
                Err(EnrollmentStoreError)
            }
        }
    }

    async fn record_login_attempt(&self, principal: &str) -> Stored<u32> {
        let now = now_epoch_seconds();
        let mut attempts = self.attempts.lock().expect("login attempts poisoned");
        let entry = attempts.entry(principal.to_owned()).or_insert((0, now));
        if now - entry.1 > LOGIN_ATTEMPT_WINDOW_SECONDS {
            *entry = (0, now);
        }
        entry.0 = entry.0.saturating_add(1);
        Ok(entry.0)
    }

    async fn clear_login_attempts(&self, principal: &str) -> Stored<()> {
        self.attempts
            .lock()
            .expect("login attempts poisoned")
            .remove(principal);
        Ok(())
    }

    async fn claim_device_account(&self, device_id: &str, account_sub: &str) -> Stored<bool> {
        let mut accounts = self
            .device_accounts
            .lock()
            .expect("device accounts poisoned");
        let (holder, _) = accounts
            .entry(device_id.to_owned())
            .or_insert_with(|| (account_sub.to_owned(), now_epoch_seconds()));
        Ok(holder == account_sub)
    }

    async fn device_account(&self, device_id: &str) -> Stored<Option<String>> {
        Ok(self
            .device_accounts
            .lock()
            .expect("device accounts poisoned")
            .get(device_id)
            .map(|(account_sub, _)| account_sub.clone()))
    }

    async fn delete_device_account(
        &self,
        device_id: &str,
        expected_account_sub: &str,
    ) -> Stored<bool> {
        let mut accounts = self
            .device_accounts
            .lock()
            .expect("device accounts poisoned");
        let belongs_to_expected = accounts
            .get(device_id)
            .is_some_and(|(account_sub, _)| account_sub == expected_account_sub);
        if belongs_to_expected {
            accounts.remove(device_id);
        }
        Ok(belongs_to_expected)
    }

    async fn device_accounts(&self) -> Stored<Vec<DeviceAccountPairing>> {
        let mut pairings: Vec<_> = self
            .device_accounts
            .lock()
            .expect("device accounts poisoned")
            .iter()
            .map(
                |(device_id, (account_sub, paired_at_epoch))| DeviceAccountPairing {
                    device_id: device_id.clone(),
                    account_sub: account_sub.clone(),
                    paired_at_epoch: *paired_at_epoch,
                },
            )
            .collect();
        pairings.sort_by_key(|pairing| (pairing.paired_at_epoch, pairing.device_id.clone()));
        Ok(pairings)
    }
}

/// PostgreSQL-backed [`EnrollmentStore`], the durable implementation.
///
/// Follows `store_postgres.rs`: one lazily-created pool, idempotent schema
/// creation, `BYTEA` columns, everything keyed by the authenticated principal.
/// Its ordered migration is separate from the account store because this state
/// belongs to the provisioning workload alone.
///
/// The pool is created with `connect_lazy` so construction stays synchronous (the
/// gRPC service is built without an async context). The first RPC pays for the
/// connection and the migration.
pub struct PostgresEnrollmentStore {
    pool: sqlx::PgPool,
    migrated: tokio::sync::OnceCell<()>,
}

/// Single-row key for the deployment's OPAQUE setup.
const SERVER_SETUP_ROW: &str = "default";

/// Advisory-lock key serializing enrollment schema creation across replicas.
/// Distinct from the store's so the two migrations never block each other.
pub(crate) const ENROLLMENT_SCHEMA_LOCK_KEY: i64 = 0x0CA2_2451_0000_0002;

pub(crate) const ENROLLMENT_MIGRATIONS: &[crate::store_postgres::EmbeddedMigration] = &[
    crate::store_postgres::EmbeddedMigration::new(
        2,
        "0002_enrollment.sql",
        include_str!("../../../migrations/0002_enrollment.sql"),
    ),
    crate::store_postgres::EmbeddedMigration::new(
        8,
        "0008_account_passcode.sql",
        include_str!("../../../migrations/0008_account_passcode.sql"),
    ),
    crate::store_postgres::EmbeddedMigration::new(
        9,
        "0009_single_pin.sql",
        include_str!("../../../migrations/0009_single_pin.sql"),
    ),
];

/// How long a query waits for a connection before reporting the store
/// unavailable. Matches `store_postgres.rs`.
const ACQUIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl PostgresEnrollmentStore {
    /// Build the pool without connecting. A malformed URL is a startup error.
    pub fn lazy(url: &str) -> Result<Self, sqlx::Error> {
        Self::lazy_with(url, ACQUIRE_TIMEOUT)
    }

    /// [`Self::lazy`] with an explicit acquire timeout, so a test can prove the
    /// unreachable-database behaviour without waiting out the production one.
    fn lazy_with(url: &str, acquire_timeout: std::time::Duration) -> Result<Self, sqlx::Error> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(acquire_timeout)
            .connect_lazy(url)?;
        Ok(Self {
            pool,
            migrated: tokio::sync::OnceCell::new(),
        })
    }

    /// Idempotent schema creation, run once per process on first use.
    ///
    /// Serialized across replicas by a transaction-scoped advisory lock for the
    /// same reason as [`crate::store_postgres::PostgresStore::migrate`]:
    /// `CREATE TABLE IF NOT EXISTS` races in the catalog when two sessions issue
    /// it together, and every workload runs with more than one replica. The
    /// `OnceCell` only makes this once per PROCESS. The lock is what makes it
    /// safe between processes.
    async fn ready(&self) -> Stored<()> {
        self.migrated
            .get_or_try_init(|| async {
                let mut tx = self.pool.begin().await.map_err(|error| {
                    tracing::error!(%error, "enrollment schema transaction failed");
                    EnrollmentStoreError
                })?;
                sqlx::query("SELECT pg_advisory_xact_lock($1)")
                    .bind(ENROLLMENT_SCHEMA_LOCK_KEY)
                    .execute(&mut *tx)
                    .await
                    .map_err(|error| {
                        tracing::error!(%error, "enrollment schema lock failed");
                        EnrollmentStoreError
                    })?;
                for migration in ENROLLMENT_MIGRATIONS {
                    for statement in migration.statements() {
                        sqlx::query(statement)
                            .execute(&mut *tx)
                            .await
                            .map_err(|error| {
                                tracing::error!(%error, "enrollment schema creation failed");
                                EnrollmentStoreError
                            })?;
                    }
                }
                tx.commit().await.map_err(|error| {
                    tracing::error!(%error, "enrollment schema commit failed");
                    EnrollmentStoreError
                })?;
                Ok(())
            })
            .await
            .copied()
    }
}

#[tonic::async_trait]
impl EnrollmentStore for PostgresEnrollmentStore {
    async fn reserve_provisioned_device(&self, device_id: &str) -> Stored<bool> {
        self.ready().await?;
        // A single upsert serializes competing replicas on the singleton key.
        let row: (String,) = sqlx::query_as(
            "INSERT INTO cosmos_provisioned_pin (singleton, device_id) VALUES (TRUE, $1) \
             ON CONFLICT (singleton) DO UPDATE SET device_id = cosmos_provisioned_pin.device_id \
             RETURNING device_id",
        )
        .bind(device_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "reserving the server's Pin failed");
            EnrollmentStoreError
        })?;
        Ok(row.0 == device_id)
    }

    async fn provisioned_device(&self) -> Stored<Option<String>> {
        self.ready().await?;
        let row: Option<(String,)> =
            sqlx::query_as("SELECT device_id FROM cosmos_provisioned_pin WHERE singleton = TRUE")
                .fetch_optional(&self.pool)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "reading the server's Pin failed");
                    EnrollmentStoreError
                })?;
        Ok(row.map(|(id,)| id))
    }

    async fn server_setup_or_install(&self, candidate: &[u8]) -> Stored<Vec<u8>> {
        self.ready().await?;
        // Insert-if-absent then read back, so two replicas racing on a fresh
        // database converge on one setup instead of overwriting each other.
        sqlx::query(
            "INSERT INTO cosmos_opaque_setup (id, setup) VALUES ($1, $2) \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(SERVER_SETUP_ROW)
        .bind(candidate)
        .execute(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "storing the OPAQUE server setup failed");
            EnrollmentStoreError
        })?;

        let row: (Vec<u8>,) = sqlx::query_as("SELECT setup FROM cosmos_opaque_setup WHERE id = $1")
            .bind(SERVER_SETUP_ROW)
            .fetch_one(&self.pool)
            .await
            .map_err(|error| {
                tracing::error!(%error, "reading the OPAQUE server setup failed");
                EnrollmentStoreError
            })?;
        Ok(row.0)
    }

    async fn passcode_record(&self, account: &str) -> Stored<Option<Vec<u8>>> {
        self.ready().await?;
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT record FROM cosmos_account_passcode WHERE account_sub = $1")
                .bind(account)
                .fetch_optional(&self.pool)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "reading an account's passcode record failed");
                    EnrollmentStoreError
                })?;
        Ok(row.map(|(record,)| record))
    }

    async fn put_passcode_record(&self, account: &str, record: &[u8]) -> Stored<()> {
        self.ready().await?;
        sqlx::query(
            "INSERT INTO cosmos_account_passcode (account_sub, record) VALUES ($1, $2) \
             ON CONFLICT (account_sub) DO UPDATE SET record = EXCLUDED.record",
        )
        .bind(account)
        .bind(record)
        .execute(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "storing an account's passcode record failed");
            EnrollmentStoreError
        })?;
        Ok(())
    }

    async fn delete_passcode_record(&self, account: &str) -> Stored<bool> {
        self.ready().await?;
        let result = sqlx::query("DELETE FROM cosmos_account_passcode WHERE account_sub = $1")
            .bind(account)
            .execute(&self.pool)
            .await
            .map_err(|error| {
                tracing::error!(%error, "removing an account's passcode record failed");
                EnrollmentStoreError
            })?;
        Ok(result.rows_affected() == 1)
    }

    async fn put_login(&self, principal: &str, state: &[u8]) -> Stored<()> {
        self.ready().await?;
        sqlx::query(
            "INSERT INTO cosmos_opaque_login (principal, state, written_epoch) VALUES ($1, $2, $3) \
             ON CONFLICT (principal) DO UPDATE SET state = EXCLUDED.state, \
             written_epoch = EXCLUDED.written_epoch",
        )
        .bind(principal)
        .bind(state)
        .bind(now_epoch_seconds())
        .execute(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "storing the in-flight OPAQUE login failed");
            EnrollmentStoreError
        })?;
        Ok(())
    }

    async fn take_login(&self, principal: &str) -> Stored<Option<Vec<u8>>> {
        self.ready().await?;
        // DELETE ... RETURNING is the atomic pop: two concurrent finishes cannot
        // both come away with the state, so a KE3 cannot be replayed.
        let row: Option<(Vec<u8>, i64)> = sqlx::query_as(
            "DELETE FROM cosmos_opaque_login WHERE principal = $1 RETURNING state, written_epoch",
        )
        .bind(principal)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "popping the in-flight OPAQUE login failed");
            EnrollmentStoreError
        })?;

        // Opportunistic pruning: abandoned ceremonies would otherwise accumulate
        // forever, and an expired row is not a live login anyway.
        let _ = sqlx::query("DELETE FROM cosmos_opaque_login WHERE written_epoch < $1")
            .bind(now_epoch_seconds() - LOGIN_STATE_TTL_SECONDS)
            .execute(&self.pool)
            .await;

        Ok(row
            .filter(|(_, written)| now_epoch_seconds() - written <= LOGIN_STATE_TTL_SECONDS)
            .map(|(state, _)| state))
    }

    async fn put_session(&self, principal: &str, session_key: &[u8; 32]) -> Stored<()> {
        self.ready().await?;
        sqlx::query(
            "INSERT INTO cosmos_opaque_session (principal, session_key, written_epoch) \
             VALUES ($1, $2, $3) ON CONFLICT (principal) DO UPDATE SET \
             session_key = EXCLUDED.session_key, written_epoch = EXCLUDED.written_epoch",
        )
        .bind(principal)
        .bind(&session_key[..])
        .bind(now_epoch_seconds())
        .execute(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "storing the OPAQUE session key failed");
            EnrollmentStoreError
        })?;
        Ok(())
    }

    async fn session(&self, principal: &str) -> Stored<Option<[u8; 32]>> {
        self.ready().await?;
        let _ = sqlx::query("DELETE FROM cosmos_opaque_session WHERE written_epoch < $1")
            .bind(now_epoch_seconds() - SESSION_TTL_SECONDS)
            .execute(&self.pool)
            .await;

        let row: Option<(Vec<u8>, i64)> = sqlx::query_as(
            "SELECT session_key, written_epoch FROM cosmos_opaque_session WHERE principal = $1",
        )
        .bind(principal)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "reading the OPAQUE session key failed");
            EnrollmentStoreError
        })?;

        // Same rule as the in-memory store: a malformed stored key is an error,
        // never silently "no session". `.ok()` here made corruption or a
        // truncating schema change look like an expired login.
        let Some((key, _)) =
            row.filter(|(_, written)| now_epoch_seconds() - written <= SESSION_TTL_SECONDS)
        else {
            return Ok(None);
        };
        match <[u8; 32]>::try_from(key.as_slice()) {
            Ok(key) => Ok(Some(key)),
            Err(_) => {
                tracing::error!("stored OPAQUE session key has the wrong length");
                Err(EnrollmentStoreError)
            }
        }
    }

    async fn record_login_attempt(&self, principal: &str) -> Stored<u32> {
        self.ready().await?;
        let now = now_epoch_seconds();
        let window_opened_after = now - LOGIN_ATTEMPT_WINDOW_SECONDS;
        // One statement, so two replicas serving a burst cannot both see a count
        // below the ceiling: the upsert serializes on the primary key and each
        // caller is RETURNED its own post-increment value.
        let row: (i32,) = sqlx::query_as(
            "INSERT INTO cosmos_opaque_login_attempt (principal, attempts, window_start_epoch) \
             VALUES ($1, 1, $2) \
             ON CONFLICT (principal) DO UPDATE SET \
             attempts = CASE WHEN cosmos_opaque_login_attempt.window_start_epoch < $3 \
                             THEN 1 ELSE cosmos_opaque_login_attempt.attempts + 1 END, \
             window_start_epoch = CASE WHEN cosmos_opaque_login_attempt.window_start_epoch < $3 \
                             THEN $2 ELSE cosmos_opaque_login_attempt.window_start_epoch END \
             RETURNING attempts",
        )
        .bind(principal)
        .bind(now)
        .bind(window_opened_after)
        .fetch_one(&self.pool)
        .await
        .map_err(|error| {
            // Never degrade to "no attempts recorded": a store that cannot count
            // must refuse the ceremony, not wave it through unmetered.
            tracing::error!(%error, "recording an OPAQUE login attempt failed");
            EnrollmentStoreError
        })?;

        // Opportunistic pruning of windows that have fully elapsed, exactly like
        // `take_login`. An expired row is not a live lockout.
        let _ =
            sqlx::query("DELETE FROM cosmos_opaque_login_attempt WHERE window_start_epoch < $1")
                .bind(window_opened_after)
                .execute(&self.pool)
                .await;

        Ok(row.0.max(0) as u32)
    }

    async fn clear_login_attempts(&self, principal: &str) -> Stored<()> {
        self.ready().await?;
        sqlx::query("DELETE FROM cosmos_opaque_login_attempt WHERE principal = $1")
            .bind(principal)
            .execute(&self.pool)
            .await
            .map_err(|error| {
                tracing::error!(%error, "clearing OPAQUE login attempts failed");
                EnrollmentStoreError
            })?;
        Ok(())
    }

    async fn claim_device_account(&self, device_id: &str, account_sub: &str) -> Stored<bool> {
        self.ready().await?;
        // Insert-if-absent, then read the holder back: the primary key decides
        // one winner when two accounts race for the same Pin.
        sqlx::query(
            "INSERT INTO cosmos_device_account (device_id, account_sub, paired_at_epoch) \
             VALUES ($1, $2, $3) ON CONFLICT (device_id) DO NOTHING",
        )
        .bind(device_id)
        .bind(account_sub)
        .bind(now_epoch_seconds())
        .execute(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "pairing a device to an account failed");
            EnrollmentStoreError
        })?;
        let holder: Option<(String,)> =
            sqlx::query_as("SELECT account_sub FROM cosmos_device_account WHERE device_id = $1")
                .bind(device_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "reading back a device pairing failed");
                    EnrollmentStoreError
                })?;
        Ok(holder.is_some_and(|(holder,)| holder == account_sub))
    }

    async fn device_account(&self, device_id: &str) -> Stored<Option<String>> {
        self.ready().await?;
        let row: Option<(String,)> =
            sqlx::query_as("SELECT account_sub FROM cosmos_device_account WHERE device_id = $1")
                .bind(device_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "reading a device-account pairing failed");
                    EnrollmentStoreError
                })?;
        Ok(row.map(|(account_sub,)| account_sub))
    }

    async fn delete_device_account(
        &self,
        device_id: &str,
        expected_account_sub: &str,
    ) -> Stored<bool> {
        self.ready().await?;
        let result = sqlx::query(
            "DELETE FROM cosmos_device_account WHERE device_id = $1 AND account_sub = $2",
        )
        .bind(device_id)
        .bind(expected_account_sub)
        .execute(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "removing a device-account pairing failed");
            EnrollmentStoreError
        })?;
        Ok(result.rows_affected() == 1)
    }

    async fn device_accounts(&self) -> Stored<Vec<DeviceAccountPairing>> {
        self.ready().await?;
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT device_id, account_sub, paired_at_epoch FROM cosmos_device_account \
             ORDER BY paired_at_epoch, device_id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| {
            tracing::error!(%error, "listing device-account pairings failed");
            EnrollmentStoreError
        })?;
        Ok(rows
            .into_iter()
            .map(
                |(device_id, account_sub, paired_at_epoch)| DeviceAccountPairing {
                    device_id,
                    account_sub,
                    paired_at_epoch,
                },
            )
            .collect())
    }
}

/// The one enrollment store this process uses, resolved on first call.
///
/// Memoised so the provisioning gRPC ceremony and the HTTP pairing endpoint
/// share a SINGLE store instance. That matters for the in-memory store, which is
/// process-local: two `configured_store()` calls would otherwise hand back
/// unrelated maps, and a device paired through the admin surface would be
/// invisible to the ceremony reading the pairing back. Postgres is shared by the
/// database regardless, but one memoised handle keeps a single pool either way.
static ENROLLMENT_STORE: std::sync::OnceLock<SharedEnrollmentStore> = std::sync::OnceLock::new();

/// Build the enrollment store this deployment is configured for.
///
/// Shares `COSMOS_DATABASE_URL` with [`crate::store::configured`], one database
/// per deployment, but keeps its own pool and tables. Unset keeps the
/// process-lifetime store, which is correct only for a single replica.
pub fn configured_store() -> SharedEnrollmentStore {
    ENROLLMENT_STORE.get_or_init(build_configured_store).clone()
}

/// The store a **pairing** must be written to, or `None` when this deployment
/// cannot record one that the ceremony would actually read.
///
/// This is a cross-process question, not a local one. The wearer's web routes
/// that pair Pins and set the passcode (`account_api.rs`) run in the `ai-bus`
/// workload, while the OPAQUE ceremony that reads both runs in `provisioning`:
/// separate processes, separate containers. So:
///
/// * If this process already initialised a store (the provisioning workload
///   itself, or a single-process local run), use exactly that instance.
/// * Otherwise the pairing is only meaningful if the provisioning workload can
///   read it, which means a SHARED database. Build the Postgres store.
/// * Otherwise `None`, an honest refusal.
///
/// The last case is the one that matters: with a process-local in-memory store,
/// a pairing written here would "succeed" and be invisible to the ceremony
/// forever. A silent wrong answer is worse than a refusal, so this never falls
/// back to one. It also never runs [`build_configured_store`], which panics on a
/// half-configured deployment.
pub fn pairing_store() -> Option<SharedEnrollmentStore> {
    if let Some(store) = ENROLLMENT_STORE.get() {
        return Some(store.clone());
    }
    let url = std::env::var(crate::store_postgres::DATABASE_URL_ENV)
        .ok()
        .filter(|url| !url.trim().is_empty())?;
    match PostgresEnrollmentStore::lazy(url.trim()) {
        Ok(store) => {
            let store: SharedEnrollmentStore = Arc::new(store);
            Some(ENROLLMENT_STORE.get_or_init(|| store).clone())
        }
        Err(error) => {
            tracing::error!(%error, "pairing is unavailable: the enrollment database is unusable");
            None
        }
    }
}

fn build_configured_store() -> SharedEnrollmentStore {
    match std::env::var(crate::store_postgres::DATABASE_URL_ENV) {
        Ok(url) if !url.trim().is_empty() => match PostgresEnrollmentStore::lazy(url.trim()) {
            Ok(store) => {
                tracing::info!("enrollment state: postgres");
                Arc::new(store)
            }
            Err(error) => panic!(
                "COSMOS_DATABASE_URL is set but unusable for enrollment state: {error}. \
                 Refusing to start on process-local OPAQUE state, which cannot complete \
                 an enrollment across replicas."
            ),
        },
        _ => {
            // In-memory OPAQUE state is process-local. Production may run
            // provisioning at more than one replica, so with no
            // shared store CreateLoginInit lands on one pod and
            // CreateLoginFinish on another, `take_login` finds nothing, and the
            // wearer gets a permanent retry loop, the exact defect the durable
            // store exists to fix, silently reintroduced.
            //
            // So this is only allowed when the operator has said the deployment
            // is single-replica. Everything else about enrollment fails closed
            // (an unconfigured CA refuses with UNIMPLEMENTED). Shared state must
            // not be the one part that fails open.
            if !single_replica_enrollment_allowed() {
                panic!(
                    "enrollment has no shared state: COSMOS_DATABASE_URL is unset. \
                     OPAQUE login state would be process-local, so CreateLoginInit and \
                     CreateLoginFinish landing on different replicas can never complete \
                     an enrollment. Set COSMOS_DATABASE_URL, or set \
                     COSMOS_ALLOW_SINGLE_REPLICA_ENROLLMENT=1 if this deployment really \
                     runs exactly one provisioning replica."
                );
            }
            tracing::warn!(
                "enrollment state: in-memory — valid ONLY for a single provisioning \
                 replica (COSMOS_ALLOW_SINGLE_REPLICA_ENROLLMENT is set)"
            );
            MemoryEnrollmentStore::shared()
        }
    }
}

/// A Pin passcode is exactly four ASCII digits: the stock onboarding entry
/// control takes four digits and nothing else, and the same code becomes the
/// Pin's keyguard PIN (`PincodeNode.onSuccessfulPasscodeLogin`).
pub fn is_stock_passcode(passcode: &str) -> bool {
    passcode.len() == 4 && passcode.bytes().all(|byte| byte.is_ascii_digit())
}

/// Why a passcode could not be set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasscodeError {
    /// Not four ASCII digits.
    Invalid,
    /// The enrollment store could not be read or written.
    Store,
}

impl From<EnrollmentStoreError> for PasscodeError {
    fn from(_: EnrollmentStoreError) -> Self {
        Self::Store
    }
}

/// Set or change `account`'s Pin passcode.
///
/// Cosmos runs both halves of OPAQUE registration here, against the shared
/// `ServerSetup`, and stores only the resulting password file, which is not
/// passcode-equivalent. The record replaces any earlier one, so the old
/// passcode stops opening at once. A Pin that already finished onboarding keeps
/// its keyguard PIN. The new passcode applies at its next setup, as stock said
/// ("Update your account passcode at humane.center, which will apply to your
/// Ai Pin after a factory reset", `help_instructions`).
pub async fn set_passcode(
    store: &dyn EnrollmentStore,
    account: &str,
    passcode: &str,
) -> Result<(), PasscodeError> {
    if !is_stock_passcode(passcode) {
        return Err(PasscodeError::Invalid);
    }
    let setup = server_setup(store).await?;
    let record = register_passcode(&setup, &Enrollment::credential_id_for(account), passcode)
        .map_err(|error| {
            tracing::error!(%error, "OPAQUE registration of a passcode failed");
            PasscodeError::Store
        })?;
    store.put_passcode_record(account, &record).await?;
    Ok(())
}

/// Whether `account`'s owner has set a Pin passcode.
pub async fn passcode_is_set(store: &dyn EnrollmentStore, account: &str) -> Stored<bool> {
    Ok(store.passcode_record(account).await?.is_some())
}

/// The deployment's one OPAQUE `ServerSetup`: the stored one, or on a fresh
/// database the one proposed from `COSMOS_OPAQUE_SEED`, installed if absent.
///
/// Every account's password file is registered and opened against this one
/// setup, from whichever workload does it, the web plane registers, the
/// provisioning workload logs in, so both must propose from the same seed.
async fn server_setup(store: &dyn EnrollmentStore) -> Stored<ServerSetup<CosmosSuite>> {
    let candidate = {
        let mut rng = StdRng::from_seed(load_opaque_seed());
        ServerSetup::<CosmosSuite>::new(&mut rng)
    };
    let setup_bytes = store
        .server_setup_or_install(&candidate.serialize())
        .await?;
    ServerSetup::<CosmosSuite>::deserialize(&setup_bytes).map_err(|error| {
        tracing::error!(%error, "the stored OPAQUE server setup is corrupt");
        EnrollmentStoreError
    })
}

/// The fallback user's name (`COSMOS_ENROLLMENT_DISPLAY_NAME`), for the
/// operator console.
pub fn configured_display_name() -> String {
    std::env::var("COSMOS_ENROLLMENT_DISPLAY_NAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DISPLAY_NAME.to_owned())
}

/// This deployment's single enrolled user id, rendered as the device sees it.
///
/// A single-tenant deployment can bind its one enrolled user to a real account,
/// e.g. the Keycloak `sub`, via `COSMOS_ENROLLMENT_USER_ID`, so a Pin that
/// onboards here and the account that logs into Center converge on the same
/// `U:<id>` partition (the faithful device↔account identity, without needing the
/// durable multi-tenant pairing store). Falls back to the built-in constant, and
/// ignores a value that would not survive the DUC subject / `U:<id>` principal
/// gates the id must later pass, a bad override degrades to the default rather
/// than minting signed-but-unusable certificates.
pub fn enrolled_user_id() -> String {
    std::env::var("COSMOS_ENROLLMENT_USER_ID")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 125 // `U:` + id must fit the 128-byte principal limit
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .unwrap_or_else(|| ENROLLMENT_USER_UUID.to_string())
}

/// A device that completed `CreateDeviceUserBinding` since this process started.
///
/// Recorded in-process only, the honest scope for a registry that a restart
/// empties, which the operator console labels as such rather than implying a
/// durable roster the clone does not keep.
#[derive(Clone, serde::Serialize)]
pub struct BoundDevice {
    pub device_id: String,
    pub user_id: String,
    /// Unix seconds at the moment the DeviceUser certificate was issued.
    pub bound_at_unix: i64,
}

static BOUND_DEVICES: Mutex<Vec<BoundDevice>> = Mutex::new(Vec::new());

/// Note that `device_id` finished binding to `user_id`. A re-bind replaces the
/// earlier row so the roster shows each device once, at its most recent binding.
pub fn record_binding(device_id: &str, user_id: &str) {
    let bound_at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default();
    let mut roster = BOUND_DEVICES
        .lock()
        .expect("bound-device roster is not poisoned");
    roster.retain(|device| device.device_id != device_id);
    roster.push(BoundDevice {
        device_id: device_id.to_owned(),
        user_id: user_id.to_owned(),
        bound_at_unix,
    });
}

/// Every device that has bound since this process started, oldest first.
pub fn bound_devices() -> Vec<BoundDevice> {
    BOUND_DEVICES
        .lock()
        .expect("bound-device roster is not poisoned")
        .clone()
}

/// Whether this deployment is admitting new devices.
///
/// `COSMOS_ENROLLMENT_OPEN` defaults to open, a self-hosted clone exists to let a
/// Pin bind, and a falsey value (`0`/`false`/`no`/`off`) closes it.
///
/// **Closed means closed.** The flag used to reach only `VerifyHmcByPass`, whose
/// answer is advisory: `checkHMCBypass` is a screen the onboarding UI consults,
/// not a gate the ceremony passes through, and nothing stops a caller from
/// skipping it and going straight to `CreateLoginInit`. An operator who set the
/// variable to close enrollment therefore left the OPAQUE ceremony and DeviceUser
/// issuance wide open while being told they were shut. The three ceremony
/// entry points ([`Enrollment::login_init`], [`Enrollment::login_finish`],
/// [`Enrollment::session_key`], which is what gates `CreateDeviceUserBinding`)
/// now consult it as well.
pub fn enrollment_open() -> bool {
    match std::env::var("COSMOS_ENROLLMENT_OPEN") {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

/// Whether the operator has declared this deployment single-replica, which is the
/// only configuration where process-local OPAQUE state can complete an enrollment.
fn single_replica_enrollment_allowed() -> bool {
    std::env::var("COSMOS_ALLOW_SINGLE_REPLICA_ENROLLMENT")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// The DeviceUser-issuing CA
// ---------------------------------------------------------------------------

/// The configured DeviceUser-issuing CA.
///
/// `certificate` exists only as a carrier for issuer parameters (subject DN and
/// subject-key-identifier) that rcgen needs when signing; `certificate_der` is the
/// **loaded** DER, which is what goes back to the device in the chain it will
/// import and trust.
struct DucCa {
    key: rcgen::KeyPair,
    certificate: rcgen::Certificate,
    certificate_der: Vec<u8>,
}

impl DucCa {
    /// Load the CA from PEM files, or `Ok(None)` when this deployment has not
    /// configured one.
    ///
    /// Half-configured is an error rather than a silent fallback: an operator who
    /// set one variable meant to enable enrollment.
    fn from_env() -> Result<Option<Self>, String> {
        let cert_path = std::env::var(DUC_CA_CERT_ENV)
            .ok()
            .filter(|v| !v.is_empty());
        let key_path = std::env::var(DUC_CA_KEY_ENV).ok().filter(|v| !v.is_empty());
        match (cert_path, key_path) {
            (Some(cert), Some(key)) => Self::from_pem_files(&cert, &key).map(Some),
            (None, None) => Ok(None),
            _ => Err(format!(
                "{DUC_CA_CERT_ENV} and {DUC_CA_KEY_ENV} must be set together"
            )),
        }
    }

    fn from_pem_files(cert_path: &str, key_path: &str) -> Result<Self, String> {
        let cert_pem = std::fs::read(cert_path)
            .map_err(|error| format!("reading {DUC_CA_CERT_ENV} ({cert_path}): {error}"))?;
        let key_pem = std::fs::read_to_string(key_path)
            .map_err(|error| format!("reading {DUC_CA_KEY_ENV} ({key_path}): {error}"))?;
        Self::from_pem(&cert_pem, &key_pem)
    }

    fn from_pem(cert_pem: &[u8], key_pem: &str) -> Result<Self, String> {
        let mut reader = std::io::BufReader::new(cert_pem);
        let certificate_der = rustls_pemfile::certs(&mut reader)
            .next()
            .ok_or_else(|| format!("{DUC_CA_CERT_ENV} contains no certificate"))?
            .map_err(|error| format!("{DUC_CA_CERT_ENV} is not valid PEM: {error}"))?;

        let key = rcgen::KeyPair::from_pem(key_pem)
            .map_err(|error| format!("{DUC_CA_KEY_ENV} is not a usable PKCS#8 key: {error}"))?;

        // The pair must actually be a pair. A mismatch is silent otherwise: we
        // would hand the device a CA certificate and then sign its DeviceUser
        // certificate with an unrelated key, producing a leaf that verifies
        // against nothing and a Pin that fails mTLS with no explanation.
        {
            let (_, parsed) =
                x509_parser::parse_x509_certificate(&certificate_der).map_err(|error| {
                    format!("{DUC_CA_CERT_ENV} is not a usable certificate: {error}")
                })?;
            if parsed.tbs_certificate.subject_pki.raw != key.public_key_der() {
                return Err(format!(
                    "{DUC_CA_KEY_ENV} is not the private key for {DUC_CA_CERT_ENV}"
                ));
            }
        }

        // rcgen signs with an issuer *parameter set*, not with a parsed
        // certificate, so the loaded CA is re-expressed as params. The re-signed
        // object is never emitted, only `certificate_der` reaches the device.
        let params =
            rcgen::CertificateParams::from_ca_cert_der(&certificate_der).map_err(|error| {
                format!("{DUC_CA_CERT_ENV} is not a usable CA certificate: {error}")
            })?;
        let certificate = params.self_signed(&key).map_err(|error| {
            format!("{DUC_CA_CERT_ENV} does not match {DUC_CA_KEY_ENV}: {error}")
        })?;

        Ok(Self {
            key,
            certificate,
            certificate_der: certificate_der.to_vec(),
        })
    }
}

// ---------------------------------------------------------------------------
// Device subjects
// ---------------------------------------------------------------------------

/// The device id inside a Humane certificate subject CN.
///
/// Mirrors `hu.ma.ne.core.DeviceConstants`:
///
/// * `DEVICE_ATTESTATION_SUBJECT_PATTERN`, `V:xx:D:<device>:P:<product>`, the
///   subject the Pin presents to the **onboarding** gateway (`ChannelFactory`
///   picks `newDeviceAttestationCredKeyManager()` for `GatewayType.ONBOARDING`).
/// * `DEVICE_USER_SUBJECT_PATTERN`, `V:xx:D:<device>:U:<uuid>`, accepted too so a
///   Pin that already holds a DeviceUser certificate can re-bind.
///
/// Returning `None` is a refusal, never a default: without a device id there is
/// no honest identity to write into a certificate.
pub fn device_id_from_subject(common_name: &str) -> Option<&str> {
    let mut fields = common_name.split(':');
    if fields.next()? != "V" {
        return None;
    }
    let version = fields.next()?;
    if version.len() != 2 || !version.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    if fields.next()? != "D" {
        return None;
    }
    let device_id = fields.next()?;
    if device_id.is_empty() || !device_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    if !matches!(fields.next()?, "P" | "U") {
        return None;
    }
    // The trailing product id / user id must be present but is not ours to use.
    if fields.next()?.is_empty() || fields.next().is_some() {
        return None;
    }
    Some(device_id)
}

fn canonical_device_id_from_subject(common_name: &str) -> Option<String> {
    device_id_from_subject(common_name).map(str::to_ascii_lowercase)
}

// ---------------------------------------------------------------------------
// The ceremony
// ---------------------------------------------------------------------------

/// What `CreateLoginInit` answers a KE1 with.
#[derive(Debug, PartialEq, Eq)]
pub enum LoginStart {
    /// The KE2: `OPAQUE_LOGIN_STATUS_SUCCESSFUL_REQUEST`.
    Ke2(Vec<u8>),
    /// The account has no passcode: `OPAQUE_LOGIN_STATUS_MISSING_REGISTRATION`,
    /// and no KE2.
    MissingRegistration,
    /// The principal spent its attempt ceiling: `OK` with
    /// `OPAQUE_LOGIN_STATUS_RATE_LIMIT_HIT` and no KE2, the answer stock's
    /// `UserBindingManager.checkForRateLimitHit` looks for before the Pin shows
    /// `LockOutNode`. A gRPC error never reaches that screen: the probe's
    /// `onError` only logs.
    RateLimited,
}

/// A login `CreateLoginFinish` completed.
pub struct FinishedLogin {
    /// The account whose passcode the login proved: the account `login_init`
    /// routed it to.
    pub account: String,
    /// The OPAQUE session key both sides derived.
    pub session_key: [u8; 32],
}

/// Names the account and never prints the session key.
impl std::fmt::Debug for FinishedLogin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FinishedLogin")
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

/// The server half of the enrollment ceremony.
///
/// Held by the provisioning service (behind an `Arc`). Every piece of state that
/// has to survive a hop between replicas lives in [`EnrollmentStore`]. What is
/// held inline is configuration.
///
/// No `Debug`: `server_setup` carries the OPRF seed and the server's static
/// private key.
pub struct Enrollment {
    /// The FALLBACK account id (a stable lowercase UUID string): the user a
    /// device enrolls into when it has no pairing. A device paired to a Keycloak
    /// `sub` uses that sub instead. See [`Enrollment::account_for_device`].
    user_id: String,
    /// The configured DeviceUser-issuing CA. Never generated. See the module docs.
    ca: DucCa,
    /// Whether this deployment admits devices at all ([`enrollment_open`]).
    ///
    /// Resolved ONCE at construction, following the precedent
    /// `Provisioning::require_attestation` set: sampling a process-global
    /// environment variable inside a handler makes concurrent tests race on it,
    /// and when a security decision takes effect should not depend on when it
    /// happens to be read.
    open: bool,
    /// Durable ceremony state, shared by every replica.
    store: SharedEnrollmentStore,
    /// The deployment's OPAQUE setup, read once. It never changes once stored
    /// ([`EnrollmentStore::server_setup_or_install`]). Password files are NOT
    /// cached: an owner who changes their passcode on the web must shut the old
    /// one out of every replica at once.
    server_setup: tokio::sync::OnceCell<ServerSetup<CosmosSuite>>,
}

impl Enrollment {
    /// Build the ceremony from the environment, or `None` when this deployment has
    /// not configured a DeviceUser CA.
    ///
    /// `None` is the honest answer, not a degraded one: without a shared CA every
    /// certificate we issued would stop being trusted the moment the process
    /// restarted or the request landed on another replica. The provisioning
    /// service turns it into `UNIMPLEMENTED`.
    ///
    /// Reads `COSMOS_OPAQUE_SEED`, `COSMOS_DUC_CA_CERT`, `COSMOS_DUC_CA_KEY`. The passcodes are the
    /// accounts' own, in the enrollment store.
    pub fn from_env() -> Option<Arc<Self>> {
        let ca = match DucCa::from_env() {
            Ok(Some(ca)) => ca,
            Ok(None) => {
                tracing::warn!(
                    "device enrollment is disabled: set {DUC_CA_CERT_ENV} and {DUC_CA_KEY_ENV} \
                     to the DeviceUser CA shared by every provisioning replica"
                );
                return None;
            }
            Err(error) => {
                // Loudly, because the operator asked for enrollment and did not
                // get it. Refusing beats minting a CA nothing else trusts.
                tracing::error!(%error, "device enrollment is disabled: the DeviceUser CA is unusable");
                return None;
            }
        };

        // Enrollment IS enabled from here on. The CA and the OPAQUE state are two
        // halves of one requirement and they chose opposite failure modes: a
        // missing CA switches enrollment off (fail closed), while a missing
        // database silently falls back to PROCESS-LOCAL OPAQUE state. That
        // combination is the one that fails open, the ceremony spans three RPCs
        // (`CreateLoginInit`, `CreateLoginFinish`, `CreateDeviceUserBinding`) and
        // every workload runs `replicas: 2`, so init lands on pod A, finish on
        // pod B, `take_login` finds nothing, and the wearer sits in a permanent
        // "network error" retry loop with nothing above `info` in the logs.
        //
        // Single-replica dev and demo deployments are legitimate, so this warns
        // rather than refusing, but it warns only when enrollment is actually
        // on, where the consequence is real, instead of on every boot.
        if std::env::var(crate::store_postgres::DATABASE_URL_ENV)
            .map(|url| url.trim().is_empty())
            .unwrap_or(true)
        {
            tracing::warn!(
                "device enrollment is enabled but {} is unset: OPAQUE login state is \
                 process-local, so an enrollment whose three RPCs do not all land on \
                 the SAME replica cannot complete. Single replica only.",
                crate::store_postgres::DATABASE_URL_ENV
            );
        }

        let open = enrollment_open();
        if !open {
            tracing::warn!(
                "COSMOS_ENROLLMENT_OPEN is set falsey: the OPAQUE ceremony and DeviceUser \
                 issuance are closed, so no new device can bind until it is cleared"
            );
        }

        Some(Arc::new(Self::with_gate(ca, configured_store(), open)))
    }

    /// Assemble from explicit parts, the seam the tests drive so they never
    /// depend on process environment. Open, which is the default a deployment
    /// gets; [`Enrollment::with_gate`] is the one that closes it.
    #[cfg(test)]
    fn with(ca: DucCa, store: SharedEnrollmentStore) -> Self {
        Self::with_gate(ca, store, true)
    }

    /// [`Enrollment::with`] with the open/closed gate injected rather than read
    /// from process-global environment.
    fn with_gate(ca: DucCa, store: SharedEnrollmentStore, open: bool) -> Self {
        let user_id = enrolled_user_id();
        Self {
            user_id,
            ca,
            open,
            store,
            server_setup: tokio::sync::OnceCell::new(),
        }
    }

    /// The refusal a closed deployment answers every ceremony RPC with.
    ///
    /// `PERMISSION_DENIED`, not `UNAVAILABLE`. The device renders only
    /// `UNAVAILABLE` as retryable (`ProvisioningAccessManager$3
    /// .lambda$finishProvisioningWithError$1` handles code `2` →
    /// `onNetworkError()`), and a deliberately closed deployment is not going to
    /// open on the next retry, telling the Pin to try again forever would be a
    /// lie the wearer pays for. A closed deployment is silent to the wearer, the
    /// same way an unconfigured one is. That is what "closed" means.
    #[allow(clippy::result_large_err)]
    fn ceremony_open(&self) -> Result<(), Status> {
        if self.open {
            return Ok(());
        }
        Err(Status::permission_denied(
            "device enrollment is closed on this deployment",
        ))
    }

    /// Meter one pincode attempt for `principal`: `true` once the ceiling is
    /// crossed, and the attempt must be refused.
    ///
    /// Called before a KE2 goes out, because the KE2 **is** the guess: see
    /// [`MAX_LOGIN_ATTEMPTS`].
    ///
    /// The verdict carries no information about whether the principal, the
    /// credential, or the pincode was right, it is the same whether the
    /// account set a passcode or not. A store failure is an error, not a
    /// verdict: an attempt this server could not count is one it must not
    /// answer.
    async fn locked_out(&self, principal: &str) -> Result<bool, Status> {
        let attempts = self.store.record_login_attempt(principal).await?;
        if attempts > MAX_LOGIN_ATTEMPTS {
            // No principal in the log line: it is the wearer's device subject.
            tracing::warn!(
                attempts,
                "refusing an OPAQUE login attempt: the pincode ceiling for this \
                 principal is exhausted"
            );
            return Ok(true);
        }
        Ok(false)
    }

    /// The enrolled user's id, returned as the `user_id` of a finished login.
    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    /// The DeviceUser CA certificate the device must trust, DER-encoded.
    pub fn ca_certificate_der(&self) -> &[u8] {
        &self.ca.certificate_der
    }

    /// The account a device enrols into: its pairing if it has one, else the
    /// deployment's fallback user (today's single-user behaviour).
    ///
    /// The pairing is keyed by the edge-authenticated device id and is only a
    /// ROUTING hint, it selects which account's credential to serve. It is never
    /// an authorization: the OPAQUE login still has to prove the passcode, and the
    /// pairing itself was made by the signed-in owner (`account_api.rs`).
    /// `None` device id (a non-device caller, or dev-insecure) resolves to the
    /// fallback so nothing regresses.
    pub async fn account_for_device(&self, device_id: Option<&str>) -> Result<String, Status> {
        // INFERRED Luma policy: previously issued attestation credentials cannot
        // bypass admission by entering the stock OPAQUE ceremony directly.
        if let Some(device_id) = device_id {
            if !self.store.reserve_provisioned_device(device_id).await? {
                return Err(Status::permission_denied(
                    "this server already has a different Pin",
                ));
            }
        }
        match device_id {
            Some(device_id) => Ok(self
                .store
                .device_account(device_id)
                .await?
                .unwrap_or_else(|| self.user_id.clone())),
            None => Ok(self.user_id.clone()),
        }
    }

    /// The OPAQUE credential id for an account: its bytes, the same domain as the
    /// DUC subject's `U:<account>`. Distinct accounts get distinct ids (so one's
    /// record can never open another's login), and an account's id never changes
    /// (a record is registered under it, so a changed id would strand the wearer).
    fn credential_id_for(account: &str) -> Vec<u8> {
        account.as_bytes().to_vec()
    }

    /// The deployment's OPAQUE setup, read from the store once per process.
    async fn setup(&self) -> Stored<&ServerSetup<CosmosSuite>> {
        self.server_setup
            .get_or_try_init(|| server_setup(self.store.as_ref()))
            .await
    }

    /// OPAQUE login, step 1: the device's KE1 in, and the [`LoginStart`] to
    /// answer with, a KE2, or one of the two stock refusals.
    ///
    /// [`LoginStart::MissingRegistration`] is for an account with no passcode:
    /// the stock Pin turns it into "You have not set your pincode yet. Go to
    /// .center and set it." (`UserBindingManager.loginStart` →
    /// `MissingCredentialsException` → error 6 → `PincodeNode.onPincodeNotSet`).
    /// The record is read on every login rather than cached, so a passcode
    /// changed on the web applies to the very next attempt on every replica.
    ///
    /// The `ServerLogin` state is stashed under the caller's principal, durably,
    /// for whichever replica handles `CreateLoginFinish`.
    ///
    /// ## This RPC is the metered one
    ///
    /// The KE2 answered here is exactly one offline password test, the device
    /// decides locally whether the pincode was right (`clientLoginFinish` returns
    /// null → `onWrongPincode()`, `ProvisioningAccessManager$4
    /// .lambda$finishClientLogin$0`) and a wrong pincode never sends a KE3 at
    /// all. So metering `CreateLoginFinish` would meter nothing. The ceiling
    /// belongs here, and it is charged **before** the KE2 leaves.
    ///
    /// A locked-out principal gets [`LoginStart::RateLimited`], whether or not
    /// the account has a passcode.
    pub async fn login_init(
        &self,
        principal: &str,
        device_id: Option<&str>,
        ke1: &[u8],
    ) -> Result<LoginStart, Status> {
        self.ceremony_open()?;
        let mut rng = OsRng;
        let request = CredentialRequest::<CosmosSuite>::deserialize(ke1)
            .map_err(|_| Status::invalid_argument("malformed OPAQUE KE1"))?;
        // Metered after the KE1 parses (a malformed one yields no KE2, so it is
        // no guess) and before anything that could answer with one. Keyed on
        // `principal`, the edge-authenticated device CN, unforgeable, NEVER on
        // the account: a ceiling an attacker could reset by rotating the routing
        // would hand them unlimited pincode guesses.
        if self.locked_out(principal).await? {
            return Ok(LoginStart::RateLimited);
        }

        // Route to the paired account's record (fallback: the deployment's
        // configured user). The credential id MUST equal the one the record was
        // registered under, both come from this single `account` resolution.
        let account = self.account_for_device(device_id).await?;
        let Some(record) = self.store.passcode_record(&account).await? else {
            // Nothing left over from an earlier KE1 can be finished either.
            self.store.take_login(principal).await?;
            return Ok(LoginStart::MissingRegistration);
        };
        let password_file =
            ServerRegistration::<CosmosSuite>::deserialize(&record).map_err(|error| {
                tracing::error!(%error, "a stored passcode record is corrupt");
                Status::from(EnrollmentStoreError)
            })?;
        let credential_id = Self::credential_id_for(&account);

        let started = ServerLogin::start(
            &mut rng,
            self.setup().await?,
            Some(password_file),
            request,
            &credential_id,
            ServerLoginStartParameters::default(),
        )
        .map_err(|_| Status::internal("OPAQUE login start failed"))?;

        let ke2 = started.message.serialize().to_vec();
        self.store
            .put_login(
                principal,
                &frame_login(&account, &started.state.serialize())?,
            )
            .await?;
        Ok(LoginStart::Ke2(ke2))
    }

    /// OPAQUE login, step 2: the device's KE3 in. Out, the account whose
    /// passcode the login proved and the shared session key.
    ///
    /// The account is the one `login_init` routed this login to, carried with
    /// the in-flight state, never the pairing read again: the wearer can change
    /// the pairing on the web between the two RPCs.
    ///
    /// The stashed state is **popped**, one-shot, so a captured KE3 cannot be
    /// replayed into a second session key. On success the session key is recorded
    /// for whichever replica handles `CreateDeviceUserBinding`.
    ///
    /// The error mapping is not arbitrary. It is what the decompiled client can
    /// act on. `UserBindingManager$3.onNext` turns any empty `user_id` into a
    /// `BindingException`, `ProvisioningService.FinishLoginErrorHandler
    /// .sendErrorFromThrowable` turns that into provisioning error code `0`, and
    /// `ProvisioningAccessManager$3.lambda$finishProvisioningWithError$1` handles
    /// only `1` (`onWrongPincode`) and `2` (`onNetworkError`), everything else
    /// falls into a rate-limit probe that calls no handler at all, i.e. the
    /// wearer's screen simply stops. Only `UNAVAILABLE` reaches code `2`, so a
    /// **lost or absent in-flight login is reported as `UNAVAILABLE`**: it is
    /// genuinely transient (the ceremony restarts from `clientLoginStart` after
    /// `cleanupOpaqueLogin()`) and it is the one failure the wearer can act on.
    /// A KE3 that does not authenticate stays `UNAUTHENTICATED`, mapping an
    /// authentication failure onto "network error" would be a lie that invites an
    /// endless retry, and it keeps a wrong pincode and an unknown device
    /// indistinguishable.
    pub async fn login_finish(&self, principal: &str, ke3: &[u8]) -> Result<FinishedLogin, Status> {
        self.ceremony_open()?;
        let state_bytes = self
            .store
            .take_login(principal)
            .await?
            .ok_or_else(|| Status::unavailable("no OPAQUE login is in progress"))?;
        let (account, state_bytes) = unframe_login(&state_bytes)
            .ok_or_else(|| Status::unavailable("the in-flight OPAQUE login is unusable"))?;
        let state = ServerLogin::<CosmosSuite>::deserialize(state_bytes)
            .map_err(|_| Status::unavailable("the in-flight OPAQUE login is unusable"))?;

        let finalization = CredentialFinalization::<CosmosSuite>::deserialize(ke3)
            .map_err(|_| Status::invalid_argument("malformed OPAQUE KE3"))?;
        let result = state
            .finish(finalization)
            .map_err(|_| Status::unauthenticated("OPAQUE login did not authenticate"))?;

        let session_key: [u8; 32] = result
            .session_key
            .to_vec()
            .try_into()
            .map_err(|_| Status::internal("OPAQUE session key was not 32 bytes"))?;
        self.store
            .put_session(&session_row(principal, account), &session_key)
            .await?;
        // This principal proved it knows the pincode, so its attempts stop
        // counting against it. A wearer who fumbled the code four times and then
        // got it right must not start their next onboarding one attempt from the
        // lock. Deliberately AFTER the session is recorded: a clear that
        // succeeded on a login that then failed to persist would hand back the
        // budget for a ceremony that never completed.
        if let Err(error) = self.store.clear_login_attempts(principal).await {
            // Not fatal, the login DID succeed, and a stale counter only ever
            // errs toward refusing later attempts, never toward allowing them.
            tracing::warn!(%error, "could not clear the OPAQUE attempt counter after a successful login");
        }
        Ok(FinishedLogin {
            account: account.to_owned(),
            session_key,
        })
    }

    /// The session key a finished login established for `principal` by proving
    /// `account`'s passcode, if one is still live.
    ///
    /// `CreateDeviceUserBinding` asks with the account the Pin is paired to at
    /// that moment and certifies that same account. A login that proved another
    /// account's passcode, the pairing changed after it, which the wearer can
    /// do on the web at any time, finds nothing, so the Pin starts over rather
    /// than drawing a certificate for an account whose passcode it never gave.
    ///
    /// Gated as well as the login pair: this is what `CreateDeviceUserBinding`
    /// consults, so it is the third of the three ceremony RPCs
    /// [`enrollment_open`] has to close. Without it a caller holding a session
    /// key from before the flag was flipped could still draw a DeviceUser
    /// certificate out of a deployment that had declared itself shut.
    pub async fn session_key(
        &self,
        principal: &str,
        account: &str,
    ) -> Result<Option<[u8; 32]>, Status> {
        self.ceremony_open()?;
        Ok(self.store.session(&session_row(principal, account)).await?)
    }

    /// H4 seal: AES-256-GCM under the session key, random 12-byte IV, 128-bit tag,
    /// no AAD. Output is `ciphertext ‖ tag` (JCA layout).
    pub fn seal_h4(session_key: &[u8; 32], plaintext: &[u8]) -> ([u8; 12], Vec<u8>) {
        let cipher =
            Aes256Gcm::new_from_slice(session_key).expect("a 32-byte key is a valid AES-256 key");
        let mut iv = [0u8; 12];
        OsRng.fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);
        let ciphertext_and_tag = cipher
            .encrypt(nonce, plaintext)
            .expect("AES-256-GCM sealing cannot fail for a bounded plaintext");
        (iv, ciphertext_and_tag)
    }

    /// H4 open: the inverse of [`Enrollment::seal_h4`]. Fails on a wrong key, a
    /// wrong IV length, or a corrupt payload.
    pub fn open_h4(
        session_key: &[u8; 32],
        iv: &[u8],
        ciphertext_and_tag: &[u8],
    ) -> Result<Vec<u8>, EnrollmentError> {
        if iv.len() != 12 {
            return Err(EnrollmentError::Crypto);
        }
        let cipher = Aes256Gcm::new_from_slice(session_key).map_err(|_| EnrollmentError::Crypto)?;
        let nonce = Nonce::from_slice(iv);
        cipher
            .decrypt(nonce, ciphertext_and_tag)
            .map_err(|_| EnrollmentError::Crypto)
    }

    /// Issue a DeviceUser certificate for the public key in the device's PKCS#10
    /// CSR, signed by the configured CA. Returns `(leaf_der, ca_certificate_der)`.
    ///
    /// **The subject is decided here, never taken from the CSR.** `device_id` comes
    /// from the mTLS subject the edge authenticated, `user_id` from the account the
    /// caller's OPAQUE login authenticated against (its pairing, or the fallback
    /// user), resolved server-side from the same edge-authenticated device id,
    /// never from the CSR or any other request field. The CSR contributes only a
    /// public key. A CSR is an unauthenticated wish, honouring its DN would let
    /// any caller name itself as any device. The DN we build is the one the device's own
    /// `DeviceUserCertificate.generateCertPrincipal()` builds
    /// (`CN=V:01:D:%s:U:%s, O=Humane, OU=DeviceUser`), so the certificate the Pin
    /// imports carries the subject it expected, and the one the API gateway
    /// parses back out with `DEVICE_USER_SUBJECT_PATTERN`.
    ///
    /// The CSR is parsed with `x509-parser` rather than rcgen's
    /// `CertificateSigningRequestParams::from_der`, which rejects any requested
    /// extension it does not model, including the **critical `basicConstraints`**
    /// that `HumaneCertificate.generateCSR` puts in every Pin's
    /// `pkcs-9-at-extensionRequest`. Routing a real device CSR through it fails
    /// 100% of the time.
    ///
    /// The CSR's self-signature *is* checked: it proves the caller holds the
    /// private key for the public key it is asking us to certify.
    pub fn issue_duc(
        &self,
        device_id: &str,
        user_id: &str,
        csr_der: &[u8],
    ) -> Result<(Vec<u8>, Vec<u8>), EnrollmentError> {
        use x509_parser::prelude::FromDer as _;

        let (rest, csr) =
            x509_parser::certification_request::X509CertificationRequest::from_der(csr_der)
                .map_err(|_| EnrollmentError::Csr)?;
        if !rest.is_empty() {
            return Err(EnrollmentError::Csr);
        }
        // Proof of possession: without this we would certify a public key the
        // caller may not own.
        csr.verify_signature().map_err(|_| EnrollmentError::Csr)?;

        let public_key =
            rcgen::SubjectPublicKeyInfo::from_der(csr.certification_request_info.subject_pki.raw)
                .map_err(|_| EnrollmentError::Csr)?;

        let mut params = rcgen::CertificateParams::new(Vec::<String>::new())
            .map_err(|_| EnrollmentError::Csr)?;
        let mut distinguished_name = rcgen::DistinguishedName::new();
        distinguished_name.push(
            rcgen::DnType::CommonName,
            format!("V:01:D:{device_id}:U:{user_id}"),
        );
        distinguished_name.push(rcgen::DnType::OrganizationName, "Humane");
        distinguished_name.push(rcgen::DnType::OrganizationalUnitName, "DeviceUser");
        params.distinguished_name = distinguished_name;

        // What the device asked for in its extension request, decided server-side:
        // `BasicConstraints(false)` and `KeyUsage(136)` = digitalSignature |
        // keyAgreement (`DeviceUserCertificate.generateKeyUsages()`).
        params.is_ca = rcgen::IsCa::ExplicitNoCa;
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::DigitalSignature,
            rcgen::KeyUsagePurpose::KeyAgreement,
        ];
        params.use_authority_key_identifier_extension = true;

        let now = time::OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::seconds(DUC_BACKDATE_SECONDS);
        params.not_after = now + time::Duration::days(DUC_VALIDITY_DAYS);

        let leaf = params
            .signed_by(&public_key, &self.ca.certificate, &self.ca.key)
            .map_err(|_| EnrollmentError::Csr)?;
        Ok((leaf.der().to_vec(), self.ca.certificate_der.clone()))
    }
}

/// Verify an ECDSA-P256-SHA256 signature the device produced with its
/// DeviceAttestation key.
///
/// The device signs on every provisioning RPC:
/// `UserBindingManager.buildDacVerifierSignature()` signs the **device id**
/// (`DeviceAttestationManager.generateVerifierSignature`, `SHA256withECDSA`), and
/// `createBindingRequest` signs the **encoded CSR**. Both are checkable only
/// against the DeviceAttestation certificate's public key, so `dac_certificate_der`
/// must be the certificate the edge verified for this connection.
///
/// `message = None` means "the message is this certificate's own device id",
/// which is what the per-call `device_id_verification_signature` covers.
/// The device id the attestation certificate itself claims, from its own CN.
///
/// The edge builds both XFCC elements, `Subject=` and `Cert=`, from one peer
/// certificate, so today they always agree. Callers still compare them: the
/// security argument for accepting an unverifiable signature is precisely "the
/// same key already authenticated this connection", and that argument is only
/// true if the certificate we verify against is the one that authenticated.
/// Nothing else in the request pipeline enforces it.
pub fn attestation_certificate_device_id(dac_certificate_der: &[u8]) -> Option<String> {
    let (_, certificate) = x509_parser::parse_x509_certificate(dac_certificate_der).ok()?;
    let common_name = certificate
        .subject()
        .iter_common_name()
        .next()
        .and_then(|attribute| attribute.as_str().ok())?;
    // Device identity hex is case-insensitive. Factory attestation subjects
    // observed on real Pins may use uppercase while the edge principal and
    // pairing store deliberately canonicalize the same id to lowercase.
    canonical_device_id_from_subject(common_name)
}

pub fn verify_attestation_signature(
    dac_certificate_der: &[u8],
    message: Option<&[u8]>,
    signature: &[u8],
) -> Result<(), EnrollmentError> {
    let (_, certificate) = x509_parser::parse_x509_certificate(dac_certificate_der)
        .map_err(|_| EnrollmentError::Attestation)?;

    let owned_device_id;
    let message = match message {
        Some(message) => message,
        None => {
            let common_name = certificate
                .subject()
                .iter_common_name()
                .next()
                .and_then(|attribute| attribute.as_str().ok())
                .ok_or(EnrollmentError::Attestation)?;
            owned_device_id = device_id_from_subject(common_name)
                .ok_or(EnrollmentError::Attestation)?
                .to_owned();
            owned_device_id.as_bytes()
        }
    };

    // The SPKI's BIT STRING is the SEC1-encoded point for an EC key.
    let point = certificate
        .tbs_certificate
        .subject_pki
        .subject_public_key
        .data
        .as_ref();
    let verifying_key = p256::ecdsa::VerifyingKey::from_sec1_bytes(point)
        .map_err(|_| EnrollmentError::Attestation)?;
    let signature =
        p256::ecdsa::Signature::from_der(signature).map_err(|_| EnrollmentError::Attestation)?;
    verifying_key
        .verify(message, &signature)
        .map_err(|_| EnrollmentError::Attestation)
}

/// The OPAQUE `ServerSetup` seed: base64 in `COSMOS_OPAQUE_SEED` (exactly 32 bytes
/// decoded) or the fixed default. A malformed value falls back to the default
/// rather than minting a random one, so a fresh deployment still proposes the same
/// setup from every replica.
fn load_opaque_seed() -> [u8; 32] {
    if let Ok(encoded) = std::env::var("COSMOS_OPAQUE_SEED")
        && let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded.trim())
        && let Ok(seed) = <[u8; 32]>::try_from(bytes.as_slice())
    {
        return seed;
    }
    DEFAULT_OPAQUE_SEED
}

/// The stored in-flight login: the account whose record `login_init` served,
/// then the `ServerLogin` state. `login_finish` keeps the session under that
/// same account ([`session_row`]), so the ceremony certifies only the account
/// whose passcode was proved.
fn frame_login(account: &str, state: &[u8]) -> Result<Vec<u8>, Status> {
    let length = u16::try_from(account.len())
        .map_err(|_| Status::internal("the enrolling account id is too long"))?;
    let mut framed = Vec::with_capacity(2 + account.len() + state.len());
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(account.as_bytes());
    framed.extend_from_slice(state);
    Ok(framed)
}

/// [`frame_login`] undone, or `None` for a row that is not one.
fn unframe_login(framed: &[u8]) -> Option<(&str, &[u8])> {
    let (length, rest) = framed.split_first_chunk::<2>()?;
    let length = usize::from(u16::from_be_bytes(*length));
    if rest.len() < length {
        return None;
    }
    let (account, state) = rest.split_at(length);
    Some((std::str::from_utf8(account).ok()?, state))
}

/// The row a finished login's session key is kept under: the edge principal
/// and the account whose passcode it proved. A principal never contains a
/// space (`AuthenticatedPrincipal`'s charset), so no two pairs share a row.
fn session_row(principal: &str, account: &str) -> String {
    format!("{principal} {account}")
}

/// Run both halves of OPAQUE registration to turn a passcode into a password
/// file. The stored record is not passcode-equivalent, and the passcode is
/// dropped as soon as this returns.
fn register_passcode(
    setup: &ServerSetup<CosmosSuite>,
    credential_id: &[u8],
    passcode: &str,
) -> Result<Vec<u8>, String> {
    let mut rng = OsRng;
    let client_start = ClientRegistration::<CosmosSuite>::start(&mut rng, passcode.as_bytes())
        .map_err(|error| error.to_string())?;
    let server_start =
        ServerRegistration::<CosmosSuite>::start(setup, client_start.message, credential_id)
            .map_err(|error| error.to_string())?;
    let client_finish = client_start
        .state
        .finish(
            &mut rng,
            passcode.as_bytes(),
            server_start.message,
            ClientRegistrationFinishParameters::default(),
        )
        .map_err(|error| error.to_string())?;
    let record = ServerRegistration::<CosmosSuite>::finish(client_finish.message);
    Ok(record.serialize().to_vec())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use opaque_ke::{ClientLogin, ClientLoginFinishParameters, CredentialResponse};

    /// A real PKCS#10 CSR **as a Pin builds it**: EC P-256, ECDSA-SHA256, the
    /// `CN=V:01:D:<device>:U:<uuid>, O=Humane, OU=DeviceUser` subject, and a
    /// `pkcs-9-at-extensionRequest` containing **critical `basicConstraints`
    /// (CA:FALSE)** plus critical `keyUsage` (digitalSignature | keyAgreement),
    /// exactly what `HumaneCertificate.generateCSR()` emits.
    ///
    /// Embedded rather than generated in-test on purpose: rcgen cannot *build* a
    /// CSR with a basicConstraints extension request, so a test that used one
    /// would never reproduce the failure this fixture exists to pin.
    const PIN_SHAPED_CSR_DER_BASE64: &str = "MIIBWjCCAQACAQAwbzFHMEUGA1UEAww+VjowMTpEOjJjMmEwMDAxMDAwMGFiY2Q6VTpjYTIyMWMxMC1kZTcxLTRjZTAtOGIxZC0wMDAwMDAwMDAwMDExDzANBgNVBAoMBkh1bWFuZTETMBEGA1UECwwKRGV2aWNlVXNlcjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABM4Ld/vjKwTll4GpeWwcOWNRV8RJpR+HEf+YNeNX6x/6NeRedmn/TppkmXzHibqNEyOwVWG1NgCWcA0fT6x0Sg+gLzAtBgkqhkiG9w0BCQ4xIDAeMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgOIMAoGCCqGSM49BAMCA0gAMEUCIQDZXktpAoDY4xKi7TNcUf4TbzMjjC7xya5WKNNhmC66jQIgNZrPnH/4WDyD55oQrPdWULSRn9l/QaJc/waxTdG/wy0=";

    /// A self-signed DeviceAttestation certificate with the device's real subject
    /// shape, `CN=V:01:D:2c2a00010000abcd:P:00000001`.
    const DAC_CERT_DER_BASE64: &str = "MIICCDCCAa+gAwIBAgIUaK97jBQrKkcBk3uBEhJMEQs79v8wCgYIKoZIzj0EAwIwWjErMCkGA1UEAwwiVjowMTpEOjJjMmEwMDAxMDAwMGFiY2Q6UDowMDAwMDAwMTEPMA0GA1UECgwGSHVtYW5lMRowGAYDVQQLDBFEZXZpY2VBdHRlc3RhdGlvbjAeFw0yNjA4MDMxMDQ1NDRaFw00NjA3MjkxMDQ1NDRaMFoxKzApBgNVBAMMIlY6MDE6RDoyYzJhMDAwMTAwMDBhYmNkOlA6MDAwMDAwMDExDzANBgNVBAoMBkh1bWFuZTEaMBgGA1UECwwRRGV2aWNlQXR0ZXN0YXRpb24wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATbqfYZwjXTRmWDN9JwYpUbiW68ZdUpDQL1bk/QmLSeEQDakCDDWcuCl6OB8qRED/3SiLc/4f8pFWHnq4YEZIHpo1MwUTAdBgNVHQ4EFgQUUBr5s+i816sPv/Zg8cQE7gPPa0YwHwYDVR0jBBgwFoAUUBr5s+i816sPv/Zg8cQE7gPPa0YwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAP4cvA5I9e3gGiF7zlUjnN5yzz7f8iH38brR2fiFXRgAIgW/8vBWT5LxoEGudQC4ylQjQ+Cvq8Kh6fFrWpUFWVZuA=";

    /// `SHA256withECDSA` over the ASCII device id `2c2a00010000abcd`, made with the
    /// key in [`DAC_CERT_DER_BASE64`], the shape
    /// `DeviceAttestationManager.generateVerifierSignature` produces.
    const DAC_DEVICE_ID_SIGNATURE_BASE64: &str = "MEUCIDHlFmV7C3tBNAfw6ngkliRHtoqJvgb502JstYGS7IWrAiEAkf5tM7QocxZBxyhNUo/PVRSAIF5DY7BtPVwflY+kElk=";

    pub(crate) const TEST_DEVICE_ID: &str = "2c2a00010000abcd";
    pub(crate) const TEST_PRINCIPAL: &str = "V:01:D:2c2a00010000abcd:P:00000001";

    #[test]
    fn a_passcode_is_exactly_the_stock_four_digit_entry() {
        assert!(is_stock_passcode("1234"));
        assert!(is_stock_passcode("0000"));
        assert!(!is_stock_passcode(""));
        assert!(!is_stock_passcode("123"));
        assert!(!is_stock_passcode("12345"));
        assert!(!is_stock_passcode("12a4"));
        assert!(!is_stock_passcode(" 1234"));
        assert!(!is_stock_passcode("１２３４"));
    }

    #[tokio::test]
    async fn the_pairing_roster_is_durable_store_state_not_process_binding_state() {
        let store = MemoryEnrollmentStore::default();
        assert!(
            store
                .claim_device_account("device-b", "account-b")
                .await
                .unwrap()
        );
        assert!(
            store
                .claim_device_account("device-a", "account-a")
                .await
                .unwrap()
        );
        assert!(
            store
                .claim_device_account("device-b", "account-b")
                .await
                .unwrap(),
            "claiming your own Pin again is a no-op, not a refusal"
        );

        let roster = store.device_accounts().await.expect("list pairings");
        assert_eq!(roster.len(), 2);
        assert!(roster.iter().all(|pairing| pairing.paired_at_epoch > 0));
        assert!(roster.iter().any(|pairing| {
            pairing.device_id == "device-a" && pairing.account_sub == "account-a"
        }));
        assert!(roster.iter().any(|pairing| {
            pairing.device_id == "device-b" && pairing.account_sub == "account-b"
        }));
    }

    /// A Pin paired to one account cannot be claimed by another: its owner has
    /// to release it first (stock: "initiate contact with support to unlink it
    /// from your account").
    #[tokio::test]
    async fn a_pin_held_by_one_account_cannot_be_claimed_by_another() {
        let store = MemoryEnrollmentStore::default();
        assert!(
            store
                .claim_device_account("device-a", "alice")
                .await
                .unwrap()
        );
        assert!(
            !store
                .claim_device_account("device-a", "mallory")
                .await
                .unwrap()
        );
        assert_eq!(
            store.device_account("device-a").await.unwrap().as_deref(),
            Some("alice")
        );
        assert!(
            store
                .delete_device_account("device-a", "alice")
                .await
                .unwrap()
        );
        assert!(
            store.claim_device_account("device-a", "bob").await.unwrap(),
            "released, it can be paired again"
        );
    }

    #[tokio::test]
    async fn unpair_is_scoped_to_the_account_that_still_owns_the_device() {
        let store = MemoryEnrollmentStore::default();
        store
            .claim_device_account("device-a", "account-new")
            .await
            .expect("pair device");

        assert!(
            !store
                .delete_device_account("device-a", "account-old")
                .await
                .expect("stale unpair answers")
        );
        assert_eq!(
            store.device_account("device-a").await.unwrap().as_deref(),
            Some("account-new"),
            "a stale Center tab must not remove a transferred device",
        );

        assert!(
            store
                .delete_device_account("device-a", "account-new")
                .await
                .expect("owner unpairs")
        );
        assert_eq!(store.device_account("device-a").await.unwrap(), None);
    }

    fn decode(encoded: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("fixture is valid base64")
    }

    pub(crate) fn pin_shaped_csr() -> Vec<u8> {
        decode(PIN_SHAPED_CSR_DER_BASE64)
    }

    /// A throwaway DeviceUser CA, generated here and handed in the way the
    /// deployment hands in a configured one.
    fn test_ca() -> DucCa {
        let key = rcgen::KeyPair::generate().expect("ca key");
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("ca params");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::CrlSign,
            rcgen::KeyUsagePurpose::DigitalSignature,
        ];
        let mut distinguished_name = rcgen::DistinguishedName::new();
        // Retained fixture subject: changing certificate bytes is outside the Cosmos naming migration.
        distinguished_name.push(rcgen::DnType::CommonName, "Cosmos Clone DeviceUser CA");
        distinguished_name.push(rcgen::DnType::OrganizationName, "Humane");
        distinguished_name.push(rcgen::DnType::OrganizationalUnitName, "DeviceUser");
        params.distinguished_name = distinguished_name;
        let certificate = params.self_signed(&key).expect("self-signed ca");
        let certificate_der = certificate.der().to_vec();
        DucCa {
            key,
            certificate,
            certificate_der,
        }
    }

    /// A ceremony whose fallback account (the one an unpaired device enrolls
    /// into) set `passcode` on the web.
    pub(crate) async fn enrollment_with_passcode(passcode: &str) -> Enrollment {
        let store = MemoryEnrollmentStore::shared();
        set_passcode(store.as_ref(), &enrolled_user_id(), passcode)
            .await
            .expect("the owner sets a passcode");
        Enrollment::with(test_ca(), store)
    }

    /// A ceremony over `store`, open, with a throwaway CA.
    pub(crate) fn enrollment_over(store: SharedEnrollmentStore) -> Enrollment {
        Enrollment::with(test_ca(), store)
    }

    /// A fully configured ceremony, what `Enrollment::from_env` returns when the
    /// deployment has a DeviceUser CA, and whose owner set passcode `1234`. The
    /// seam the provisioning tests use so they never touch process environment.
    pub(crate) async fn configured_enrollment() -> Enrollment {
        enrollment_with_passcode("1234").await
    }

    /// Drive the device's half of OPAQUE the way `libopaque.so` does.
    async fn client_login(
        enrollment: &Enrollment,
        principal: &str,
        pincode: &str,
    ) -> (Result<Vec<u8>, ()>, Vec<u8>) {
        let mut rng = OsRng;
        let start = ClientLogin::<CosmosSuite>::start(&mut rng, pincode.as_bytes()).expect("KE1");
        let LoginStart::Ke2(ke2) = enrollment
            .login_init(principal, None, &start.message.serialize())
            .await
            .expect("KE2")
        else {
            panic!("the account has a passcode and a budget");
        };
        match start.state.finish(
            pincode.as_bytes(),
            CredentialResponse::deserialize(&ke2).expect("KE2 parses"),
            ClientLoginFinishParameters::default(),
        ) {
            Ok(finish) => (
                Ok(finish.message.serialize().to_vec()),
                finish.session_key.to_vec(),
            ),
            Err(_) => (Err(()), Vec::new()),
        }
    }

    /// [`client_login`] for a device that routes to a paired account (a non-`None`
    /// device id at `login_init`).
    async fn client_login_routed(
        enrollment: &Enrollment,
        principal: &str,
        device_id: &str,
        pincode: &str,
    ) -> (Result<Vec<u8>, ()>, Vec<u8>) {
        let mut rng = OsRng;
        let start = ClientLogin::<CosmosSuite>::start(&mut rng, pincode.as_bytes()).expect("KE1");
        let LoginStart::Ke2(ke2) = enrollment
            .login_init(principal, Some(device_id), &start.message.serialize())
            .await
            .expect("KE2")
        else {
            panic!("the paired account has a passcode and a budget");
        };
        match start.state.finish(
            pincode.as_bytes(),
            CredentialResponse::deserialize(&ke2).expect("KE2 parses"),
            ClientLoginFinishParameters::default(),
        ) {
            Ok(finish) => (
                Ok(finish.message.serialize().to_vec()),
                finish.session_key.to_vec(),
            ),
            Err(_) => (Err(()), Vec::new()),
        }
    }

    /// A fresh serialized KE1 for the given pincode.
    fn ke1_for(pincode: &[u8]) -> Vec<u8> {
        let mut rng = OsRng;
        ClientLogin::<CosmosSuite>::start(&mut rng, pincode)
            .expect("KE1")
            .message
            .serialize()
            .to_vec()
    }

    /// MULTI-USER: a device paired to an account enrols into THAT account's
    /// partition, the DUC subject is `U:<sub>` and the finished login reports the
    /// same account (invariants I4/I5). The account is resolved from the
    /// edge-authenticated device id, never from anything the request carries.
    #[tokio::test]
    async fn a_paired_device_enrols_into_its_account() {
        let store = MemoryEnrollmentStore::shared();
        store
            .claim_device_account("aaaa0001", "alice-sub-01")
            .await
            .expect("pair");
        set_passcode(store.as_ref(), "alice-sub-01", "1234")
            .await
            .expect("alice sets her passcode");
        let enrollment = Enrollment::with(test_ca(), store);

        let account = enrollment
            .account_for_device(Some("aaaa0001"))
            .await
            .expect("resolve");
        assert_eq!(account, "alice-sub-01");

        let (ke3, _) =
            client_login_routed(&enrollment, "principal-alice", "aaaa0001", "1234").await;
        let ke3 = ke3.expect("the paired account's credential authenticates with the pincode");
        enrollment
            .login_finish("principal-alice", &ke3)
            .await
            .expect("finish");

        let (leaf_der, _) = enrollment
            .issue_duc("aaaa0001", &account, &pin_shaped_csr())
            .expect("issue");
        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("parse leaf");
        assert!(
            leaf.subject()
                .to_string()
                .contains("V:01:D:aaaa0001:U:alice-sub-01"),
            "the DUC must name the paired account: {}",
            leaf.subject()
        );
    }

    /// MULTI-USER: an UNpaired device falls back to the deployment's single user,
    /// today's exact behaviour, unchanged (invariant I8).
    #[tokio::test]
    async fn an_unpaired_device_falls_back_to_the_configured_user() {
        let enrollment = enrollment_with_passcode("1234").await;
        let account = enrollment
            .account_for_device(Some("beef0002"))
            .await
            .expect("resolve");
        assert_eq!(account, enrolled_user_id());
        assert_eq!(account, enrollment.user_id());
    }

    /// MULTI-USER: two accounts get DISTINCT credential ids, so one account's
    /// record can never open another's login. The fallback id stays stable
    /// (invariant I3).
    #[test]
    fn distinct_accounts_get_distinct_stable_credential_ids() {
        assert_ne!(
            Enrollment::credential_id_for("alice-sub"),
            Enrollment::credential_id_for("bob-sub"),
        );
        assert_eq!(
            Enrollment::credential_id_for(&enrolled_user_id()),
            enrolled_user_id().into_bytes(),
        );
    }

    /// MULTI-USER: pairing ROUTES, the passcode AUTHORIZES. A correctly paired
    /// device with the wrong passcode is still refused, the pairing is never a
    /// substitute for proving the passcode.
    #[tokio::test]
    async fn a_paired_device_with_the_wrong_pincode_is_refused() {
        let store = MemoryEnrollmentStore::shared();
        store
            .claim_device_account("aaaa0003", "carol-sub")
            .await
            .expect("pair");
        set_passcode(store.as_ref(), "carol-sub", "1234")
            .await
            .expect("carol sets her passcode");
        let enrollment = Enrollment::with(test_ca(), store);
        let (ke3, _) =
            client_login_routed(&enrollment, "principal-carol", "aaaa0003", "9999").await;
        assert!(
            ke3.is_err(),
            "a wrong pincode must not authenticate a paired device"
        );
    }

    /// The per-account passcode, end to end: the owner registers it on the web
    /// (server-side OPAQUE registration into the account's own record), the
    /// device paired to that account logs in with it, and both sides derive one
    /// session key. The record stored is a password file, never the passcode.
    #[tokio::test]
    async fn a_passcode_set_on_the_web_opens_the_paired_accounts_login() {
        let store = MemoryEnrollmentStore::shared();
        store
            .claim_device_account("aaaa0010", "dana-sub")
            .await
            .expect("pair");
        assert!(!passcode_is_set(store.as_ref(), "dana-sub").await.unwrap());
        set_passcode(store.as_ref(), "dana-sub", "4821")
            .await
            .expect("dana sets her passcode");
        assert!(passcode_is_set(store.as_ref(), "dana-sub").await.unwrap());

        let record = store
            .passcode_record("dana-sub")
            .await
            .unwrap()
            .expect("stored under dana's account");
        assert!(
            ServerRegistration::<CosmosSuite>::deserialize(&record).is_ok(),
            "what is stored is an OPAQUE password file"
        );
        assert!(
            !record.windows(4).any(|window| window == b"4821"),
            "the passcode itself is never stored"
        );

        let enrollment = Enrollment::with(test_ca(), store);
        let (ke3, client_key) =
            client_login_routed(&enrollment, "principal-dana", "aaaa0010", "4821").await;
        let server = enrollment
            .login_finish("principal-dana", &ke3.expect("the right passcode finishes"))
            .await
            .expect("server finish");
        assert_eq!(
            server.session_key.to_vec(),
            client_key,
            "both sides derive one key"
        );
        assert_eq!(
            server.account, "dana-sub",
            "the login proved the paired account"
        );
    }

    /// Changing the passcode shuts the old one out at once, on the very next
    /// login, through the same ceremony instance, with no cache to wait out.
    #[tokio::test]
    async fn changing_the_passcode_invalidates_the_old_one() {
        let store = MemoryEnrollmentStore::shared();
        store
            .claim_device_account("aaaa0011", "erin-sub")
            .await
            .expect("pair");
        set_passcode(store.as_ref(), "erin-sub", "1111")
            .await
            .expect("first passcode");
        let enrollment = Enrollment::with(test_ca(), store.clone());
        let (ke3, _) = client_login_routed(&enrollment, "principal-erin", "aaaa0011", "1111").await;
        assert!(ke3.is_ok(), "the first passcode works before the change");

        set_passcode(store.as_ref(), "erin-sub", "2222")
            .await
            .expect("changed passcode");
        let (old, _) = client_login_routed(&enrollment, "principal-erin", "aaaa0011", "1111").await;
        assert!(old.is_err(), "the old passcode no longer opens the login");
        let (new, client_key) =
            client_login_routed(&enrollment, "principal-erin", "aaaa0011", "2222").await;
        let server = enrollment
            .login_finish("principal-erin", &new.expect("the new passcode works"))
            .await
            .expect("server finish");
        assert_eq!(server.session_key.to_vec(), client_key);
    }

    /// One account's passcode never opens another account's login.
    #[tokio::test]
    async fn one_accounts_passcode_never_opens_anothers_login() {
        let store = MemoryEnrollmentStore::shared();
        store
            .claim_device_account("aaaa0012", "frank-sub")
            .await
            .unwrap();
        store
            .claim_device_account("aaaa0013", "gina-sub")
            .await
            .unwrap();
        set_passcode(store.as_ref(), "frank-sub", "1357")
            .await
            .unwrap();
        set_passcode(store.as_ref(), "gina-sub", "2468")
            .await
            .unwrap();
        let enrollment = Enrollment::with(test_ca(), store);
        let (ke3, _) = client_login_routed(&enrollment, "principal-gina", "aaaa0013", "1357").await;
        assert!(ke3.is_err(), "frank's passcode must not open gina's login");
    }

    /// An account with no passcode is told so, which the stock Pin turns into
    /// "You have not set your pincode yet. Go to .center and set it."
    #[tokio::test]
    async fn an_account_without_a_passcode_gets_no_ke2() {
        let store = MemoryEnrollmentStore::shared();
        store
            .claim_device_account("aaaa0014", "hana-sub")
            .await
            .unwrap();
        let enrollment = Enrollment::with(test_ca(), store);
        assert_eq!(
            enrollment
                .login_init("principal-hana", Some("aaaa0014"), &ke1_for(b"1234"))
                .await
                .expect("answered"),
            LoginStart::MissingRegistration
        );
    }

    #[tokio::test]
    async fn only_a_four_digit_passcode_is_registered() {
        let store = MemoryEnrollmentStore::shared();
        for rejected in ["", "123", "12345", "12a4", "１２３４"] {
            assert_eq!(
                set_passcode(store.as_ref(), "ivan-sub", rejected).await,
                Err(PasscodeError::Invalid),
                "{rejected:?}"
            );
        }
        assert!(!passcode_is_set(store.as_ref(), "ivan-sub").await.unwrap());
    }

    /// The attempt ceiling follows the authenticated principal even when the
    /// one Pin is released and paired to another account between attempts.
    #[tokio::test]
    async fn metering_is_by_principal_not_by_routing() {
        let store = MemoryEnrollmentStore::shared();
        let enrollment = Enrollment::with(test_ca(), store.clone());
        let device = "aaaa0015";
        for index in 0..=MAX_LOGIN_ATTEMPTS {
            let account = format!("acct{index:04x}");
            if index > 0 {
                assert!(
                    store
                        .delete_device_account(device, &format!("acct{:04x}", index - 1))
                        .await
                        .unwrap()
                );
            }
            assert!(store.claim_device_account(device, &account).await.unwrap());
            set_passcode(store.as_ref(), &account, "1234")
                .await
                .unwrap();
            let response = enrollment
                .login_init("one-principal", Some(device), &ke1_for(b"0000"))
                .await
                .unwrap();
            if index < MAX_LOGIN_ATTEMPTS {
                assert!(matches!(response, LoginStart::Ke2(_)));
            } else {
                assert_eq!(
                    response,
                    LoginStart::RateLimited,
                    "changing the paired account must not reset the attempt ceiling"
                );
            }
        }
        assert_eq!(
            enrollment
                .account_for_device(Some("aaaa0016"))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
    }

    /// CAPSTONE, one person, one partition, through BOTH front doors, against a
    /// REAL Keycloak. A device PAIRED to the person's Keycloak `sub` runs the real
    /// OPAQUE ceremony and gets a DeviceUser certificate. The principal the edge
    /// parses out of that certificate is byte-identical to the principal a real
    /// Keycloak login token resolves to, and a note the Pin writes is readable by
    /// the web login. This is the end-to-end convergence the other tests only
    /// approximate in pieces. Ignored (needs a running Keycloak built from
    /// `platform/containers/keycloak`).
    #[tokio::test]
    #[ignore = "requires a running Keycloak (platform/containers/keycloak); set KC_TEST_ISSUER, KC_TEST_JWKS, KC_TEST_TOKEN (a live access token) and KC_TEST_SUB"]
    async fn a_paired_pin_and_the_web_login_for_one_person_share_a_partition() {
        use crate::store::MemoryStore;
        use crate::web_auth::{JwtVerifier, OidcConfig};
        use cosmos_core::AuthenticatedPrincipal;
        use cosmos_protocol::common::encryption::EncryptedData;

        let issuer = std::env::var("KC_TEST_ISSUER").expect("KC_TEST_ISSUER");
        let jwks_uri = std::env::var("KC_TEST_JWKS").expect("KC_TEST_JWKS");
        let token = std::env::var("KC_TEST_TOKEN").expect("KC_TEST_TOKEN");
        let sub = std::env::var("KC_TEST_SUB").expect("KC_TEST_SUB");

        // WEB DOOR: verify the person's live Keycloak login token.
        let verifier = JwtVerifier::connect(OidcConfig {
            issuer,
            audience: None,
            jwks_uri,
        })
        .await
        .expect("connect to live Keycloak");
        let web_principal = verifier
            .verify(&token)
            .expect("the live login token verifies");

        // DEVICE DOOR: pair a Pin to that SAME account, then run the real ceremony.
        let store = MemoryEnrollmentStore::shared();
        store
            .claim_device_account("aaaa0001", &sub)
            .await
            .expect("pair the Pin to the person's account");
        set_passcode(store.as_ref(), &sub, "1234")
            .await
            .expect("the person sets a passcode");
        let enrollment = Enrollment::with(test_ca(), store);
        let (ke3, _) = client_login_routed(&enrollment, "principal-pin", "aaaa0001", "1234").await;
        enrollment
            .login_finish("principal-pin", &ke3.expect("the pincode authenticates"))
            .await
            .expect("finish");
        let account = enrollment
            .account_for_device(Some("aaaa0001"))
            .await
            .expect("resolve the paired account");
        let (leaf_der, _) = enrollment
            .issue_duc("aaaa0001", &account, &pin_shaped_csr())
            .expect("issue the DeviceUser certificate");

        // The edge parses the principal out of the certificate's Subject CN, the
        // real device-side resolution, not a shortcut.
        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("parse leaf");
        let cn = leaf
            .subject()
            .iter_common_name()
            .next()
            .and_then(|attr| attr.as_str().ok())
            .expect("the DUC carries a common name");
        let device_principal = AuthenticatedPrincipal::from_device_cn(cn)
            .expect("the edge resolves the DUC principal");

        // CONVERGENCE: the two doors resolve to the SAME partition.
        assert_eq!(
            device_principal.expose_for_authorization(),
            web_principal.expose_for_authorization(),
            "the Pin and the web login must resolve to one partition"
        );
        assert_eq!(web_principal.expose_for_authorization(), format!("U:{sub}"));

        // SHARED DATA: the Pin writes a note. The web login reads it back.
        let notes = MemoryStore::shared();
        let created = notes
            .create_note(
                device_principal.expose_for_authorization(),
                crate::store::NewNote::sealed(
                    Some(EncryptedData {
                        encryption_information: None,
                        data: b"a note from my Pin".to_vec(),
                    }),
                    None,
                ),
            )
            .await
            .expect("the Pin writes a note");
        let seen = notes
            .recent_notes(web_principal.expose_for_authorization(), 10, None, None)
            .await
            .expect("the web login reads notes");
        assert!(
            seen.iter().any(|note| note.uuid == created.uuid),
            "the note the Pin wrote must be visible to the web login — one partition"
        );
    }

    /// Test 1, a full OPAQUE round-trip with a real opaque-ke client over the
    /// same suite yields identical 32-byte session keys on both sides.
    #[tokio::test]
    async fn opaque_round_trip_yields_matching_session_keys() {
        let enrollment = enrollment_with_passcode("1234").await;
        let (ke3, client_key) = client_login(&enrollment, "principal-1", "1234").await;
        let ke3 = ke3.expect("the right pincode finishes on the client");

        let server = enrollment
            .login_finish("principal-1", &ke3)
            .await
            .expect("server finish");

        assert_eq!(
            server.session_key.to_vec(),
            client_key,
            "both sides derive one key"
        );
        assert_eq!(
            server.account,
            enrolled_user_id(),
            "an unpaired Pin proves the fallback"
        );
    }

    /// Test 2, a wrong pincode does not authenticate. With opaque-ke the client's
    /// own `finish` rejects (envelope MAC mismatch). If a build ever let it
    /// through, the server `finish` must still reject.
    #[tokio::test]
    async fn a_wrong_pincode_does_not_authenticate() {
        let enrollment = enrollment_with_passcode("1234").await;
        let (ke3, _) = client_login(&enrollment, "principal-1", "9999").await;

        let rejected = match ke3 {
            Err(()) => true,
            Ok(ke3) => enrollment.login_finish("principal-1", &ke3).await.is_err(),
        };
        assert!(rejected, "a wrong pincode must never authenticate");
    }

    /// No passcode means no KE2 at all, and no in-flight login is left behind
    /// for a KE3 to finish.
    #[tokio::test]
    async fn an_account_without_a_passcode_leaves_nothing_to_finish() {
        let unregistered = Enrollment::with(test_ca(), MemoryEnrollmentStore::shared());
        assert_eq!(
            unregistered
                .login_init("principal-1", None, &ke1_for(b"1234"))
                .await
                .expect("answered"),
            LoginStart::MissingRegistration
        );
        assert_eq!(
            unregistered
                .login_finish("principal-1", &[0u8; 64])
                .await
                .expect_err("nothing to finish")
                .code(),
            tonic::Code::Unavailable
        );
    }

    /// Test 3, the H4 seal round-trips, and the layout is `ciphertext ‖ tag`
    /// (a 16-byte GCM tag appended).
    #[test]
    fn h4_seal_round_trips_with_a_16_byte_tag() {
        let key = [0x5au8; 32];
        let plaintext = b"device-user binding attestation";

        let (iv, ciphertext_and_tag) = Enrollment::seal_h4(&key, plaintext);
        assert_eq!(iv.len(), 12);
        assert_eq!(
            ciphertext_and_tag.len(),
            plaintext.len() + 16,
            "GCM appends a 16-byte tag"
        );

        let opened = Enrollment::open_h4(&key, &iv, &ciphertext_and_tag).expect("open");
        assert_eq!(opened, plaintext);

        // A wrong key must fail the AEAD tag check.
        assert!(Enrollment::open_h4(&[0u8; 32], &iv, &ciphertext_and_tag).is_err());
        // A tampered ciphertext must fail too.
        let mut tampered = ciphertext_and_tag.clone();
        tampered[0] ^= 0xff;
        assert!(Enrollment::open_h4(&key, &iv, &tampered).is_err());
    }

    /// The regression this exists for: rcgen's CSR parser **refuses** the CSR every
    /// real Pin sends. If this ever goes green, the fixture stopped being
    /// Pin-shaped and the test below stopped proving anything.
    #[test]
    fn rcgen_refuses_the_csr_a_real_pin_sends() {
        let csr_der = pin_shaped_csr();
        assert!(
            rcgen::CertificateSigningRequestParams::from_der(&csr_der.as_slice().into()).is_err(),
            "the fixture must contain an extension request rcgen rejects, or it is not Pin-shaped"
        );

        // ... and it is specifically a *critical* basicConstraints request.
        use x509_parser::prelude::FromDer as _;
        let (_, csr) =
            x509_parser::certification_request::X509CertificationRequest::from_der(&csr_der)
                .expect("fixture parses");
        let has_basic_constraints = csr
            .requested_extensions()
            .expect("the fixture requests extensions")
            .any(|extension| {
                matches!(
                    extension,
                    x509_parser::extensions::ParsedExtension::BasicConstraints(_)
                )
            });
        assert!(
            has_basic_constraints,
            "the fixture must request basicConstraints"
        );
    }

    /// Test 4, a Pin-shaped CSR is honoured, the subject is the SERVER's, and the
    /// leaf verifies against the configured CA.
    #[test]
    fn issue_duc_honours_a_pin_shaped_csr_with_a_server_decided_subject() {
        let enrollment = enrollment_over(MemoryEnrollmentStore::shared());
        let (leaf_der, ca_der) = enrollment
            .issue_duc(TEST_DEVICE_ID, enrollment.user_id(), &pin_shaped_csr())
            .expect("a Pin's CSR must be honoured");

        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("parse leaf");
        let subject = leaf.subject().to_string();
        assert!(
            subject.contains(&format!(
                "V:01:D:{TEST_DEVICE_ID}:U:{}",
                enrollment.user_id()
            )),
            "the DeviceUser CN must be the server's: {subject}"
        );
        assert!(
            subject.contains("DeviceUser"),
            "the OU must be present: {subject}"
        );

        let (_, ca) = x509_parser::parse_x509_certificate(&ca_der).expect("parse ca");
        leaf.verify_signature(Some(ca.public_key()))
            .expect("the leaf must verify against the configured CA");
        assert_eq!(
            ca_der,
            enrollment.ca_certificate_der(),
            "the chain must contain the configured CA, not a re-signed copy"
        );
    }

    /// The CSR's subject is an unauthenticated wish. Even when it names another
    /// device, the issued certificate names the device the edge authenticated.
    #[test]
    fn issue_duc_ignores_the_device_id_the_csr_asks_for() {
        let enrollment = enrollment_over(MemoryEnrollmentStore::shared());
        let (leaf_der, _) = enrollment
            .issue_duc("deadbeef", enrollment.user_id(), &pin_shaped_csr())
            .expect("issue");

        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("parse leaf");
        let subject = leaf.subject().to_string();
        assert!(
            subject.contains("V:01:D:deadbeef:U:"),
            "the server's device id must win: {subject}"
        );
        assert!(
            !subject.contains(TEST_DEVICE_ID),
            "the CSR's own device id must not survive: {subject}"
        );
    }

    /// A CSR whose signature does not match its public key proves no possession
    /// and must not be certified.
    #[test]
    fn issue_duc_rejects_a_csr_that_does_not_prove_possession() {
        let enrollment = enrollment_over(MemoryEnrollmentStore::shared());
        let mut tampered = pin_shaped_csr();
        // Flip a byte inside the signature (the last field of the DER SEQUENCE).
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(
            enrollment
                .issue_duc(TEST_DEVICE_ID, enrollment.user_id(), &tampered)
                .is_err(),
            "a CSR whose self-signature fails must be refused"
        );
    }

    /// A login state is one-shot: `login_finish` must not be replayable.
    #[tokio::test]
    async fn a_finished_login_cannot_be_replayed() {
        let enrollment = enrollment_with_passcode("1234").await;
        let (ke3, _) = client_login(&enrollment, "principal-1", "1234").await;
        let ke3 = ke3.expect("finish");

        assert!(enrollment.login_finish("principal-1", &ke3).await.is_ok());
        assert!(
            enrollment.login_finish("principal-1", &ke3).await.is_err(),
            "a login state must be consumed exactly once"
        );
    }

    /// Two "replicas" sharing one store must be able to split the ceremony: init on
    /// one, finish on the other, bind on a third. This is the cross-pod failure the
    /// store seam exists to fix, with process-local state the finish below cannot
    /// find any login at all.
    #[tokio::test]
    async fn the_ceremony_completes_across_replicas_sharing_one_store() {
        let store = MemoryEnrollmentStore::shared();
        // The web plane registers the passcode. Three provisioning replicas
        // split the login.
        set_passcode(store.as_ref(), &enrolled_user_id(), "1234")
            .await
            .expect("passcode");
        let pod_a = Enrollment::with(test_ca(), store.clone());
        let pod_b = Enrollment::with(test_ca(), store.clone());
        let pod_c = Enrollment::with(test_ca(), store);

        let mut rng = OsRng;
        let start = ClientLogin::<CosmosSuite>::start(&mut rng, b"1234").expect("KE1");
        let LoginStart::Ke2(ke2) = pod_a
            .login_init(TEST_PRINCIPAL, None, &start.message.serialize())
            .await
            .expect("KE2 from pod A")
        else {
            panic!("the account has a passcode");
        };

        let finish = start
            .state
            .finish(
                b"1234",
                CredentialResponse::deserialize(&ke2).expect("KE2"),
                ClientLoginFinishParameters::default(),
            )
            .expect("client finish");
        let client_key: [u8; 32] = finish.session_key.to_vec().try_into().expect("32 bytes");

        let server = pod_b
            .login_finish(TEST_PRINCIPAL, &finish.message.serialize())
            .await
            .expect("pod B must finish a login pod A started");
        assert_eq!(server.session_key, client_key);

        assert_eq!(
            pod_c
                .session_key(TEST_PRINCIPAL, &enrolled_user_id())
                .await
                .expect("session lookup"),
            Some(client_key),
            "pod C must see the session key pod B established"
        );
    }

    /// A per-process `ServerSetup` silently invalidates every password file. With
    /// the store, a second "replica" must adopt the stored setup rather than its
    /// own, even if its seed differs.
    #[tokio::test]
    async fn the_stored_server_setup_wins_over_a_freshly_proposed_one() {
        let store = MemoryEnrollmentStore::shared();
        // Install the first setup and a password file registered against it.
        set_passcode(store.as_ref(), &enrolled_user_id(), "1234")
            .await
            .expect("passcode");

        // A replica that proposes something else must still read back the stored
        // bytes, or the record the first replica minted stops opening.
        let other_setup = {
            let mut rng = StdRng::from_seed([0x11u8; 32]);
            ServerSetup::<CosmosSuite>::new(&mut rng)
        };
        let winner = store
            .server_setup_or_install(&other_setup.serialize())
            .await
            .expect("install-if-absent");
        assert_ne!(
            winner,
            other_setup.serialize().to_vec(),
            "the stored setup must win"
        );

        // And the ceremony still works against the stored one.
        let second = Enrollment::with(test_ca(), store);
        let (ke3, client_key) = client_login(&second, TEST_PRINCIPAL, "1234").await;
        let server = second
            .login_finish(TEST_PRINCIPAL, &ke3.expect("finish"))
            .await
            .expect("finish");
        assert_eq!(server.session_key.to_vec(), client_key);
    }

    /// The CA is configuration. Loading the same PEM twice must produce the same
    /// issuer, so a certificate issued by one replica verifies against the chain
    /// another replica hands out.
    #[test]
    fn the_configured_ca_is_stable_across_loads() {
        let key = rcgen::KeyPair::generate().expect("ca key");
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign];
        let mut distinguished_name = rcgen::DistinguishedName::new();
        // Retained fixture subject: changing certificate bytes is outside the Cosmos naming migration.
        distinguished_name.push(rcgen::DnType::CommonName, "Cosmos Clone DeviceUser CA");
        params.distinguished_name = distinguished_name;
        let certificate = params.self_signed(&key).expect("self-signed");
        let cert_pem = certificate.pem();
        let key_pem = key.serialize_pem();

        let first = DucCa::from_pem(cert_pem.as_bytes(), &key_pem).expect("load once");
        let second = DucCa::from_pem(cert_pem.as_bytes(), &key_pem).expect("load twice");
        assert_eq!(
            first.certificate_der, second.certificate_der,
            "the loaded CA DER must be byte-identical across loads"
        );

        let store = MemoryEnrollmentStore::shared();
        let pod_a = Enrollment::with(first, store.clone());
        let pod_b = Enrollment::with(second, store);

        let (leaf_der, _) = pod_a
            .issue_duc(TEST_DEVICE_ID, pod_a.user_id(), &pin_shaped_csr())
            .expect("issue on pod A");
        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("parse leaf");
        let (_, ca_from_b) =
            x509_parser::parse_x509_certificate(pod_b.ca_certificate_der()).expect("parse ca");
        leaf.verify_signature(Some(ca_from_b.public_key()))
            .expect("a leaf from pod A must verify against pod B's chain");
    }

    /// A mismatched CA key/cert pair is a configuration error, not something to
    /// paper over. Left unchecked it would sign every DeviceUser certificate with
    /// a key unrelated to the CA we hand the device, a leaf that verifies against
    /// nothing, and a Pin that silently stops authenticating.
    #[test]
    fn a_mismatched_ca_key_is_refused() {
        let key = rcgen::KeyPair::generate().expect("ca key");
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let certificate = params.self_signed(&key).expect("self-signed");

        // The matching pair loads.
        DucCa::from_pem(certificate.pem().as_bytes(), &key.serialize_pem())
            .expect("a matching key/cert pair must load");

        // An unrelated key does not.
        let unrelated = rcgen::KeyPair::generate().expect("other key");
        assert!(
            DucCa::from_pem(certificate.pem().as_bytes(), &unrelated.serialize_pem()).is_err(),
            "a key that does not belong to the configured CA certificate must be refused"
        );
    }

    /// A database that cannot be reached must SAY so. The dangerous failures here
    /// are silent ones: a `server_setup_or_install` that fell back to the caller's
    /// candidate would give every replica its own OPAQUE setup (invalidating every
    /// password file), and a `take_login` that answered `Ok(None)` would present a
    /// database outage as "no login in progress", the exact cross-pod bug this
    /// store exists to fix, only harder to see.
    #[tokio::test]
    async fn an_unreachable_database_reports_failure_rather_than_silently_degrading() {
        // A pool pointed at a closed port: building it succeeds lazily, using it
        // does not.
        let Ok(store) = PostgresEnrollmentStore::lazy_with(
            "postgres://cosmos@127.0.0.1:1/none",
            std::time::Duration::from_millis(250),
        ) else {
            // Refusing to build is also a loud failure. The property holds.
            return;
        };
        let candidate = vec![0x5au8; 32];
        assert_eq!(
            store.server_setup_or_install(&candidate).await,
            Err(EnrollmentStoreError),
            "an unreachable store must never hand back the caller's own candidate"
        );
        assert_eq!(
            store.take_login("wearer").await,
            Err(EnrollmentStoreError),
            "an unreachable store must not look like an absent login"
        );
        assert_eq!(
            store.session("wearer").await,
            Err(EnrollmentStoreError),
            "an unreachable store must not look like an expired session"
        );
        assert_eq!(
            store.put_session("wearer", &[0u8; 32]).await,
            Err(EnrollmentStoreError),
            "an unrecorded session key must not be reported as recorded"
        );
    }

    // INFERRED Luma admission policy. Exercise the production database as well
    // as the local store: competing processes, restart, repair, and unpairing.
    #[tokio::test]
    async fn only_one_pin_can_be_provisioned_even_across_restarts() {
        let memory = MemoryEnrollmentStore::shared();
        assert!(memory.reserve_provisioned_device("aa01").await.unwrap());
        assert!(memory.reserve_provisioned_device("aa01").await.unwrap());
        assert!(!memory.reserve_provisioned_device("aa02").await.unwrap());
        assert_eq!(
            memory.provisioned_device().await.unwrap().as_deref(),
            Some("aa01")
        );

        let Ok(url) = std::env::var("COSMOS_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let first = PostgresEnrollmentStore::lazy(&url).unwrap();
        let second = PostgresEnrollmentStore::lazy(&url).unwrap();
        let (a, b) = tokio::join!(
            first.reserve_provisioned_device("aa01"),
            second.reserve_provisioned_device("aa02"),
        );
        assert_ne!(a.unwrap(), b.unwrap(), "exactly one request wins");
        let winner = first.provisioned_device().await.unwrap().unwrap();
        assert!(first.reserve_provisioned_device(&winner).await.unwrap());
        assert!(
            first
                .claim_device_account(&winner, "slot-owner")
                .await
                .unwrap()
        );
        assert!(
            first
                .delete_device_account(&winner, "slot-owner")
                .await
                .unwrap()
        );
        drop(first);
        drop(second);
        let restarted = PostgresEnrollmentStore::lazy(&url).unwrap();
        assert_eq!(
            restarted.provisioned_device().await.unwrap(),
            Some(winner.clone())
        );
        assert!(!restarted.reserve_provisioned_device("aa03").await.unwrap());
        assert!(restarted.reserve_provisioned_device(&winner).await.unwrap());
        let unavailable = PostgresEnrollmentStore::lazy_with(
            "postgres://unused:unused@127.0.0.1:1/unused",
            std::time::Duration::from_millis(100),
        )
        .unwrap();
        assert!(
            unavailable
                .reserve_provisioned_device("aa04")
                .await
                .is_err()
        );
    }

    /// The durable store, against a real database. SKIPS without
    /// `COSMOS_TEST_DATABASE_URL`, following `store_postgres.rs`.
    #[tokio::test]
    async fn the_durable_store_installs_once_pops_once_and_isolates_principals() {
        // Exactly ONE skip condition: the database was not offered. Once a URL
        // IS set, a bad pool or a failed migration must FAIL, not skip, a
        // `return` is indistinguishable from a pass in cargo's output, and this
        // test used to have three silent exits, so a broken URL or a broken
        // migration reported green having asserted nothing.
        let Ok(url) = std::env::var("COSMOS_TEST_DATABASE_URL") else {
            // Announce the skip in the same words `store_postgres.rs` uses. CI
            // greps for this exact string to fail a run where the database was
            // meant to be up but every backend test quietly stood down. A bare
            // `return` here was invisible to that guard.
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let store = PostgresEnrollmentStore::lazy(&url)
            .expect("COSMOS_TEST_DATABASE_URL is set but the pool could not be built");
        store
            .ready()
            .await
            .expect("COSMOS_TEST_DATABASE_URL is set but the schema migration failed");

        // Install-if-absent: whoever gets there first wins, forever.
        let first = store
            .server_setup_or_install(b"setup-one")
            .await
            .expect("install");
        let second = store
            .server_setup_or_install(b"setup-two")
            .await
            .expect("read back");
        assert_eq!(first, second, "the stored OPAQUE setup must win");

        // A passcode record is the account's own, and a change replaces it.
        let account = uuid::Uuid::new_v4().to_string();
        let other = uuid::Uuid::new_v4().to_string();
        assert_eq!(store.passcode_record(&account).await.expect("read"), None);
        store
            .put_passcode_record(&account, b"record-one")
            .await
            .expect("set");
        store
            .put_passcode_record(&account, b"record-two")
            .await
            .expect("change");
        assert_eq!(
            store.passcode_record(&account).await.expect("read back"),
            Some(b"record-two".to_vec()),
            "changing the passcode replaces the record"
        );
        assert_eq!(store.passcode_record(&other).await.expect("read"), None);
        assert!(
            store
                .delete_passcode_record(&account)
                .await
                .expect("delete")
        );
        assert!(!store.delete_passcode_record(&account).await.expect("again"));
        assert_eq!(store.passcode_record(&account).await.expect("read"), None);

        // One account wins a Pin. Another cannot take it.
        let device = uuid::Uuid::new_v4().simple().to_string();
        assert!(
            store
                .claim_device_account(&device, &account)
                .await
                .expect("claim")
        );
        assert!(
            store
                .claim_device_account(&device, &account)
                .await
                .expect("again")
        );
        assert!(
            !store
                .claim_device_account(&device, &other)
                .await
                .expect("taken")
        );
        assert_eq!(
            store
                .device_account(&device)
                .await
                .expect("read")
                .as_deref(),
            Some(account.as_str())
        );
        assert!(
            store
                .delete_device_account(&device, &account)
                .await
                .expect("release")
        );

        // One-shot pop, isolated per principal.
        let alice = format!("V:01:D:aaaa:P:{}", uuid::Uuid::new_v4().simple());
        let bob = format!("V:01:D:bbbb:P:{}", uuid::Uuid::new_v4().simple());
        store.put_login(&alice, b"alice-state").await.expect("put");
        assert_eq!(
            store.take_login(&bob).await.expect("bob pop"),
            None,
            "one principal must never pop another's login"
        );
        assert_eq!(
            store.take_login(&alice).await.expect("alice pop"),
            Some(b"alice-state".to_vec())
        );
        assert_eq!(
            store.take_login(&alice).await.expect("second pop"),
            None,
            "an in-flight login is one-shot"
        );

        // Sessions survive for the binding hop, and stay isolated.
        let key = [0x2bu8; 32];
        store.put_session(&alice, &key).await.expect("put session");
        assert_eq!(store.session(&alice).await.expect("session"), Some(key));
        assert_eq!(store.session(&bob).await.expect("session"), None);
    }

    /// Finding 20, the per-call `device_id_verification_signature` is verified,
    /// not ignored, whenever the attestation certificate is available.
    #[test]
    fn a_device_id_signature_verifies_against_the_attestation_certificate() {
        let dac = decode(DAC_CERT_DER_BASE64);
        let signature = decode(DAC_DEVICE_ID_SIGNATURE_BASE64);

        verify_attestation_signature(&dac, None, &signature)
            .expect("a genuine device-id signature must verify");

        // A flipped byte must not.
        let mut tampered = signature.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(verify_attestation_signature(&dac, None, &tampered).is_err());

        // Nor a signature over a different message.
        assert!(verify_attestation_signature(&dac, Some(b"another device"), &signature).is_err());
    }

    /// Subject parsing accepts exactly the two Humane device subject shapes and
    /// refuses everything else, a principal we cannot name yields no certificate.
    #[test]
    fn device_ids_are_parsed_only_from_humane_device_subjects() {
        assert_eq!(
            device_id_from_subject("V:01:D:2c2a00010000abcd:P:00000001"),
            Some("2c2a00010000abcd")
        );
        assert_eq!(
            device_id_from_subject("V:01:D:abcd:U:ca221c10-de71-4ce0-8b1d-000000000001"),
            Some("abcd")
        );
        for rejected in [
            "development-insecure-principal",
            "V:01:D::P:0001",
            "V:1:D:abcd:P:0001",
            "V:01:X:abcd:P:0001",
            "V:01:D:zzzz:P:0001",
            "V:01:D:abcd:P:0001:extra",
            "V:01:D:abcd:P:",
            "",
        ] {
            assert_eq!(device_id_from_subject(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn attestation_device_ids_are_canonical_lowercase() {
        assert_eq!(
            canonical_device_id_from_subject("V:01:D:2C2A000110000185:P:0001").as_deref(),
            Some("2c2a000110000185")
        );
    }

    /// Test 5, the whole ceremony through the provisioning gRPC handlers for a
    /// single principal: `CreateLoginInit` → `CreateLoginFinish` →
    /// `CreateDeviceUserBinding`, then open the sealed DeviceUser certificate with
    /// the client's own session key.
    #[tokio::test]
    async fn provisioning_drives_login_then_binding_end_to_end() {
        use crate::services::provisioning::Provisioning;
        use cosmos_core::AuthenticatedPrincipal;
        use cosmos_protocol::provisioning as pb;
        use cosmos_protocol::provisioning::device_onboarding_dac_service_server::DeviceOnboardingDacService;
        use tonic::Request;

        fn with_principal<T>(mut request: Request<T>, principal: &str) -> Request<T> {
            request
                .extensions_mut()
                .insert(AuthenticatedPrincipal::from_edge(principal).expect("valid principal"));
            request
        }

        let store = MemoryEnrollmentStore::shared();
        set_passcode(store.as_ref(), &enrolled_user_id(), "1234")
            .await
            .expect("passcode");
        let enrollment = Arc::new(Enrollment::with(test_ca(), store.clone()));
        let service = Provisioning::with_store(Some(enrollment.clone()), store);

        // The device's clientLoginStart.
        let mut rng = OsRng;
        let start = ClientLogin::<CosmosSuite>::start(&mut rng, b"1234").expect("KE1");

        // CreateLoginInit → KE2.
        let init = service
            .create_login_init(with_principal(
                Request::new(pb::CreateLoginInitRequest {
                    login_request: start.message.serialize().to_vec(),
                    device_id_verification_signature: None,
                    device_id: String::new(),
                }),
                TEST_PRINCIPAL,
            ))
            .await
            .expect("login init")
            .into_inner();
        assert_eq!(
            init.response_code.as_ref().map(|code| code.status_code),
            Some(pb::OpaqueLoginStatusCode::OpaqueLoginStatusSuccessfulRequest as i32)
        );

        // The device's clientLoginFinish → KE3 + client session key.
        let finish = start
            .state
            .finish(
                b"1234",
                CredentialResponse::deserialize(&init.login_response).expect("KE2"),
                ClientLoginFinishParameters::default(),
            )
            .expect("client finish");
        let client_key: [u8; 32] = finish.session_key.to_vec().try_into().expect("32-byte key");

        // CreateLoginFinish.
        let finished = service
            .create_login_finish(with_principal(
                Request::new(pb::CreateLoginFinishRequest {
                    login_finish_request: finish.message.serialize().to_vec(),
                    device_id_verification_signature: None,
                    device_id: String::new(),
                }),
                TEST_PRINCIPAL,
            ))
            .await
            .expect("login finish")
            .into_inner();
        assert_eq!(
            finished.response_code.as_ref().map(|code| code.status_code),
            Some(pb::OpaqueLoginStatusCode::OpaqueLoginStatusSuccessfulRequest as i32)
        );
        assert_eq!(finished.user_id, enrollment.user_id());
        assert_eq!(
            finished.display_name, "",
            "an account with no preferred name is greeted with just \"welcome\""
        );

        // The device seals its attestation over the CSR under the session key.
        let csr_der = pin_shaped_csr();
        let (attestation_iv, attestation_ct) =
            Enrollment::seal_h4(&client_key, b"device-attestation");

        // CreateDeviceUserBinding.
        let binding = service
            .create_device_user_binding(with_principal(
                Request::new(pb::EncryptedCreateDeviceUserBindingRequest {
                    device_user_credential_csr: Some(pb::CertificateSigningRequest {
                        format: pb::CertificateFormat::Pkcs10 as i32,
                        encoding: pb::CertificateEncoding::Der as i32,
                        csr: csr_der,
                    }),
                    device_attestation_credential_verification_signature: Some(
                        pb::EncryptedPayload {
                            payload: attestation_ct,
                            iv: attestation_iv.to_vec(),
                        },
                    ),
                }),
                TEST_PRINCIPAL,
            ))
            .await
            .expect("binding")
            .into_inner();

        // The device opens the sealed DeviceUser certificate with its own key.
        let sealed = binding.device_user_certificate.expect("sealed certificate");
        let leaf_der =
            Enrollment::open_h4(&client_key, &sealed.iv, &sealed.payload).expect("open cert");
        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("parse leaf");
        assert!(
            leaf.subject().to_string().contains(&format!(
                "V:01:D:{TEST_DEVICE_ID}:U:{}",
                enrollment.user_id()
            )),
            "the issued cert names the device the edge authenticated"
        );

        // The CA chain to trust is returned.
        let chain = binding.ca_chain.expect("ca chain");
        assert_eq!(chain.cert.len(), 1);
        assert_eq!(chain.cert[0].format, pb::CertificateFormat::X509 as i32);
        assert_eq!(chain.cert[0].certificate, enrollment.ca_certificate_der());
    }

    /// Pairing is the wearer's own web action, so it can change during the
    /// ceremony. A Pin that proved one account's passcode and was then released
    /// is told the account it proved, greeted by that account's own name, and
    /// never certified into the account it now routes to (here the fallback,
    /// whose passcode it never gave): the binding finds no session and the Pin
    /// starts over. Paired back, the same session binds into the account it
    /// proved.
    #[tokio::test]
    async fn a_pairing_changed_after_the_login_never_certifies_another_account() {
        use crate::services::provisioning::Provisioning;
        use cosmos_core::AuthenticatedPrincipal;
        use cosmos_protocol::provisioning as pb;
        use cosmos_protocol::provisioning::device_onboarding_dac_service_server::DeviceOnboardingDacService;
        use tonic::Request;

        fn as_pin<T>(message: T) -> Request<T> {
            let mut request = Request::new(message);
            request
                .extensions_mut()
                .insert(AuthenticatedPrincipal::from_edge(TEST_PRINCIPAL).expect("principal"));
            request
        }

        let store = MemoryEnrollmentStore::shared();
        assert!(
            store
                .claim_device_account(TEST_DEVICE_ID, "mallory-sub")
                .await
                .unwrap()
        );
        set_passcode(store.as_ref(), "mallory-sub", "1111")
            .await
            .unwrap();
        set_passcode(store.as_ref(), &enrolled_user_id(), "2222")
            .await
            .unwrap();
        let enrollment = Arc::new(Enrollment::with(test_ca(), store.clone()));
        let accounts = crate::store::MemoryStore::shared();
        crate::services::account::put_account_info(
            &accounts,
            "U:mallory-sub",
            cosmos_protocol::account::AccountInfo {
                preferred_name: "Mallory".to_owned(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let service = Provisioning::with_stores(Some(enrollment), store.clone(), accounts);

        // Log in with mallory's own passcode, routed to mallory's account.
        let start = ClientLogin::<CosmosSuite>::start(&mut OsRng, b"1111").expect("KE1");
        let init = service
            .create_login_init(as_pin(pb::CreateLoginInitRequest {
                login_request: start.message.serialize().to_vec(),
                device_id_verification_signature: None,
                device_id: String::new(),
            }))
            .await
            .expect("KE2")
            .into_inner();
        let finish = start
            .state
            .finish(
                b"1111",
                CredentialResponse::deserialize(&init.login_response).expect("KE2"),
                ClientLoginFinishParameters::default(),
            )
            .expect("mallory's passcode opens mallory's record");
        let client_key: [u8; 32] = finish.session_key.to_vec().try_into().expect("32 bytes");

        // Released on the web before the Pin finishes its login.
        assert!(
            store
                .delete_device_account(TEST_DEVICE_ID, "mallory-sub")
                .await
                .unwrap()
        );
        let finished = service
            .create_login_finish(as_pin(pb::CreateLoginFinishRequest {
                login_finish_request: finish.message.serialize().to_vec(),
                device_id_verification_signature: None,
                device_id: String::new(),
            }))
            .await
            .expect("login finish")
            .into_inner();
        assert_eq!(
            finished.user_id, "mallory-sub",
            "the account the login proved, not the pairing read again"
        );
        assert_eq!(finished.display_name, "Mallory", "that account's own name");

        let bind = || {
            let (iv, payload) = Enrollment::seal_h4(&client_key, b"device-attestation");
            as_pin(pb::EncryptedCreateDeviceUserBindingRequest {
                device_user_credential_csr: Some(pb::CertificateSigningRequest {
                    format: pb::CertificateFormat::Pkcs10 as i32,
                    encoding: pb::CertificateEncoding::Der as i32,
                    csr: pin_shaped_csr(),
                }),
                device_attestation_credential_verification_signature: Some(pb::EncryptedPayload {
                    payload,
                    iv: iv.to_vec(),
                }),
            })
        };

        let refused = service
            .create_device_user_binding(bind())
            .await
            .expect_err("the fallback account's passcode was never proved");
        assert_eq!(refused.code(), tonic::Code::Unavailable);

        // Paired back to the account it proved, the same session binds there.
        assert!(
            store
                .claim_device_account(TEST_DEVICE_ID, "mallory-sub")
                .await
                .unwrap()
        );
        let sealed = service
            .create_device_user_binding(bind())
            .await
            .expect("binding into the proved account")
            .into_inner()
            .device_user_certificate
            .expect("sealed certificate");
        let leaf_der =
            Enrollment::open_h4(&client_key, &sealed.iv, &sealed.payload).expect("open cert");
        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("parse leaf");
        assert!(
            leaf.subject()
                .to_string()
                .contains(&format!("V:01:D:{TEST_DEVICE_ID}:U:mallory-sub"))
        );
    }

    /// A KE1 for an account with no passcode also drops an earlier in-flight
    /// login of that principal, so its KE3 has nothing left to finish.
    #[tokio::test]
    async fn a_missing_passcode_drops_an_earlier_in_flight_login() {
        let store = MemoryEnrollmentStore::shared();
        store
            .claim_device_account("aaaa0021", "nina-sub")
            .await
            .unwrap();
        set_passcode(store.as_ref(), "nina-sub", "1234")
            .await
            .unwrap();
        let enrollment = Enrollment::with(test_ca(), store.clone());
        let start = ClientLogin::<CosmosSuite>::start(&mut OsRng, b"1234").expect("KE1");
        let LoginStart::Ke2(ke2) = enrollment
            .login_init(
                "principal-nina",
                Some("aaaa0021"),
                &start.message.serialize(),
            )
            .await
            .expect("KE2")
        else {
            panic!("nina has a passcode");
        };
        let ke3 = start
            .state
            .finish(
                b"1234",
                CredentialResponse::deserialize(&ke2).expect("KE2"),
                ClientLoginFinishParameters::default(),
            )
            .expect("client finish")
            .message
            .serialize()
            .to_vec();

        // Her passcode goes (the account is deleted), and the Pin asks again.
        assert!(store.delete_passcode_record("nina-sub").await.unwrap());
        assert_eq!(
            enrollment
                .login_init("principal-nina", Some("aaaa0021"), &ke1_for(b"1234"))
                .await
                .expect("answered"),
            LoginStart::MissingRegistration
        );
        assert_eq!(
            enrollment
                .login_finish("principal-nina", &ke3)
                .await
                .expect_err("nothing is left to finish")
                .code(),
            tonic::Code::Unavailable
        );
    }

    // -----------------------------------------------------------------------
    // The attempt ceiling
    // -----------------------------------------------------------------------

    /// A fresh KE1, the way `ProvisioningAccessManager.startClientLogin` mints
    /// one per pincode entry.
    fn fresh_ke1() -> Vec<u8> {
        let mut rng = OsRng;
        ClientLogin::<CosmosSuite>::start(&mut rng, b"1234")
            .expect("KE1")
            .message
            .serialize()
            .to_vec()
    }

    /// Inject the edge-authenticated principal, the way `AuthLayer` does.
    fn as_device<T>(mut request: tonic::Request<T>) -> tonic::Request<T> {
        request.extensions_mut().insert(
            cosmos_core::AuthenticatedPrincipal::from_edge(TEST_PRINCIPAL).expect("principal"),
        );
        request
    }

    /// The gap this closes: there was **no attempt ceiling anywhere** on a
    /// four-digit pincode with a deployment-wide default, and every
    /// `CreateLoginInit` answer is one offline guess. Driven through the real
    /// gRPC handler rather than [`Enrollment::login_init`], because a ceiling
    /// that a wired-up device never actually meets is not a ceiling.
    #[tokio::test]
    async fn the_pincode_ceremony_locks_out_after_the_attempt_ceiling() {
        use crate::services::provisioning::Provisioning;
        use cosmos_protocol::provisioning as pb;
        use cosmos_protocol::provisioning::device_onboarding_dac_service_server::DeviceOnboardingDacService;
        use tonic::Request;

        let store = MemoryEnrollmentStore::shared();
        set_passcode(store.as_ref(), &enrolled_user_id(), "1234")
            .await
            .expect("passcode");
        let service = Provisioning::with_store(
            Some(Arc::new(Enrollment::with(test_ca(), store.clone()))),
            store,
        );

        let status = |response: pb::CreateLoginInitResponse| {
            response.response_code.map(|code| code.status_code)
        };

        // Every attempt up to the ceiling is answered normally, the gate is not
        // simply refusing everything.
        for attempt in 1..=MAX_LOGIN_ATTEMPTS {
            let answered = service
                .create_login_init(as_device(Request::new(pb::CreateLoginInitRequest {
                    login_request: fresh_ke1(),
                    device_id_verification_signature: None,
                    device_id: String::new(),
                })))
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "attempt {attempt} of {MAX_LOGIN_ATTEMPTS} must still be served: {error}"
                    )
                })
                .into_inner();
            assert_eq!(
                status(answered),
                Some(pb::OpaqueLoginStatusCode::OpaqueLoginStatusSuccessfulRequest as i32)
            );
        }

        // The attempt after the ceiling is refused, an unmetered KE2 is one
        // free guess against a four-digit code, in the one shape stock's
        // `UserBindingManager.checkForRateLimitHit` reads: `OK`, `RATE_LIMIT_HIT`,
        // no KE2. `loginStart` turns the empty KE2 into a `BindingException`,
        // `ProvisioningAccessManager` probes again, and this same answer sends
        // the Pin to `LockOutNode`.
        for probe in ["the attempt", "the rate-limit probe"] {
            let refused = service
                .create_login_init(as_device(Request::new(pb::CreateLoginInitRequest {
                    login_request: fresh_ke1(),
                    device_id_verification_signature: None,
                    device_id: String::new(),
                })))
                .await
                .expect("a locked-out Pin is answered OK")
                .into_inner();
            assert!(refused.login_response.is_empty(), "{probe}: no KE2");
            assert_eq!(
                status(refused),
                Some(pb::OpaqueLoginStatusCode::OpaqueLoginStatusRateLimitHit as i32),
                "{probe}"
            );
        }

        // The meter remains per principal, while the one-Pin admission policy
        // independently refuses another device before it gets a KE2.
        let mut other = Request::new(pb::CreateLoginInitRequest {
            login_request: fresh_ke1(),
            device_id_verification_signature: None,
            device_id: String::new(),
        });
        other.extensions_mut().insert(
            cosmos_core::AuthenticatedPrincipal::from_edge("V:01:D:2c2a0001dead0001:P:00000001")
                .expect("principal"),
        );
        assert_eq!(
            service.create_login_init(other).await.unwrap_err().code(),
            tonic::Code::PermissionDenied
        );
    }

    /// The ceiling counts every KE1, whether or not the account set a passcode,
    /// and locks out at exactly the same attempt with the same answer: a probe
    /// for "has this account a passcode?" is metered too.
    #[tokio::test]
    async fn a_lockout_does_not_depend_on_whether_a_passcode_is_set() {
        let enrolled = enrollment_with_passcode("1234").await;
        let unregistered = Enrollment::with(test_ca(), MemoryEnrollmentStore::shared());

        for enrollment in [&enrolled, &unregistered] {
            for _ in 0..MAX_LOGIN_ATTEMPTS {
                assert_ne!(
                    enrollment
                        .login_init(TEST_PRINCIPAL, None, &fresh_ke1())
                        .await
                        .expect("attempts below the ceiling are answered either way"),
                    LoginStart::RateLimited
                );
            }
            assert_eq!(
                enrollment
                    .login_init(TEST_PRINCIPAL, None, &fresh_ke1())
                    .await
                    .expect("answered"),
                LoginStart::RateLimited,
                "a locked-out account with a passcode and one without get the same answer"
            );
        }
    }

    /// The wearer's half of the ceiling: knowing the pincode gives the budget
    /// back. A wearer who fumbles the code and then gets it right must not start
    /// their next onboarding one attempt away from a lockout they cannot clear
    /// (the device offers no way out of `LockOutNode` but waiting).
    #[tokio::test]
    async fn a_successful_login_gives_the_attempt_budget_back() {
        let enrollment = enrollment_with_passcode("1234").await;

        // Burn everything but one attempt.
        for _ in 1..MAX_LOGIN_ATTEMPTS {
            assert!(matches!(
                enrollment
                    .login_init(TEST_PRINCIPAL, None, &fresh_ke1())
                    .await
                    .expect("below the ceiling"),
                LoginStart::Ke2(_)
            ));
        }

        // The last attempt is the one that works, a full ceremony.
        let (ke3, _) = client_login(&enrollment, TEST_PRINCIPAL, "1234").await;
        enrollment
            .login_finish(TEST_PRINCIPAL, &ke3.expect("the right pincode finishes"))
            .await
            .expect("the ceremony completes at the ceiling, not one attempt short of it");

        // The counter is back to zero: a whole fresh budget is available.
        for attempt in 1..=MAX_LOGIN_ATTEMPTS {
            assert!(
                matches!(
                    enrollment
                        .login_init(TEST_PRINCIPAL, None, &fresh_ke1())
                        .await
                        .expect("answered"),
                    LoginStart::Ke2(_)
                ),
                "attempt {attempt} after a successful login must be served"
            );
        }
    }

    // -----------------------------------------------------------------------
    // COSMOS_ENROLLMENT_OPEN
    // -----------------------------------------------------------------------

    /// The gap this closes: `COSMOS_ENROLLMENT_OPEN=false` used to reach only
    /// `VerifyHmcByPass`, whose answer is advisory, the three RPCs that actually
    /// enroll a device never consulted it, so an operator who closed enrollment
    /// still had an open OPAQUE ceremony and an open DeviceUser CA.
    ///
    /// The gate is injected rather than set in the environment, following
    /// `Provisioning::with_attestation_requirement`: a process-global variable
    /// read inside a handler makes concurrent tests race on it.
    #[tokio::test]
    async fn a_closed_deployment_closes_all_three_ceremony_rpcs() {
        let closed = Enrollment::with_gate(test_ca(), MemoryEnrollmentStore::shared(), false);

        let init = closed
            .login_init(TEST_PRINCIPAL, None, &fresh_ke1())
            .await
            .expect_err("a closed deployment must not answer a KE1");
        assert_eq!(init.code(), tonic::Code::PermissionDenied);

        let finish = closed
            .login_finish(TEST_PRINCIPAL, &[0u8; 64])
            .await
            .expect_err("a closed deployment must not finish a login");
        assert_eq!(finish.code(), tonic::Code::PermissionDenied);

        // The binding RPC's gate: `CreateDeviceUserBinding` reaches the ceremony
        // through `session_key`, so a caller holding a session key from before
        // the flag was flipped must still be refused a certificate.
        let sealed_store = MemoryEnrollmentStore::shared();
        sealed_store
            .put_session(
                &session_row(TEST_PRINCIPAL, &enrolled_user_id()),
                &[7u8; 32],
            )
            .await
            .expect("stash a session from before the deployment closed");
        let closed_with_session = Enrollment::with_gate(test_ca(), sealed_store.clone(), false);
        let binding = closed_with_session
            .session_key(TEST_PRINCIPAL, &enrolled_user_id())
            .await
            .expect_err("a closed deployment must not hand out a live session key");
        assert_eq!(binding.code(), tonic::Code::PermissionDenied);

        // ...and with the SAME state, open, every one of them works, so the
        // assertions above pin the flag rather than some unrelated failure.
        set_passcode(sealed_store.as_ref(), &enrolled_user_id(), "1234")
            .await
            .expect("passcode");
        let open = Enrollment::with_gate(test_ca(), sealed_store, true);
        assert!(matches!(
            open.login_init(TEST_PRINCIPAL, None, &fresh_ke1())
                .await
                .expect("an open deployment answers a KE1"),
            LoginStart::Ke2(_)
        ));
        assert_eq!(
            open.session_key(TEST_PRINCIPAL, &enrolled_user_id())
                .await
                .expect("an open deployment serves the session key"),
            Some([7u8; 32])
        );
    }

    #[test]
    fn opaque_fallback_seed_is_stable() {
        assert_eq!(DEFAULT_OPAQUE_SEED, *b"cosmos-revival-opaque-seed-00001");
    }

    /// The deployment-wide enrollment pincode is gone, not bypassed: nothing
    /// reads its variable, and nothing reads or writes the password files that
    /// were fabricated from it.
    #[test]
    fn nothing_reads_the_retired_deployment_wide_pincode() {
        let source = include_str!("enrollment.rs");
        let production = source
            .rsplit_once("\n#[cfg(test)]\npub(crate) mod tests {")
            .map_or(source, |(production, _)| production);
        assert!(!production.contains(concat!("COSMOS_ENROLLMENT_", "PINCODE")));
        assert!(!production.contains(concat!("cosmos_opaque_", "password_file")));
    }
}
