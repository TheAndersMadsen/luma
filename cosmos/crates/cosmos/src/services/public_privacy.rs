//! `humane.privacy.grpc.pub.PublicPrivacyService` — the ephemeral-key lifecycle
//! and privacy-settings sync (the last of the cosmos gRPC services).
//!
//! **Key agreement is now real** (wired to `cosmos-crypto`): the server holds an
//! RSA-OAEP wrapping keypair; `EstablishWrappingKeys` publishes its public key,
//! and `ImportKeys` RSA-OAEP-unwraps the device's uploaded ephemeral AES-128
//! channel keys into a per-server `{kid -> key}` store the `Encrypted*` path can
//! then use to open/seal envelopes. Settings + key-sync reads/acks hold no
//! per-user state and return well-formed empties.
//!
//! This lifecycle runs **once per device lifetime** — the device caches the kid
//! and never re-establishes (see the module doc on [`crate::keymaterial`]) — so
//! everything imported here is written to durable key material rather than held
//! for the process lifetime.
//!
//! # `SyncKeys` is the one lever the server has over a stranded kid
//!
//! Nothing about an `Encrypted*` **failure** reaches the device's key layer.
//! `EncryptingStreamObserver.onError` / `DecryptingStreamObserver.onError`
//! forward the throwable to the inner observer and inspect nothing
//! (`humaneinternal/system/aibus/EncryptingStreamObserver.java:41`,
//! `DecryptingStreamObserver.java:41`), and
//! `EphemeralProtectionManager.encrypt`/`decrypt` swallow every krypton
//! exception into a `null` return with a log line
//! (`humaneinternal/system/krypto/ephemeral/EphemeralProtectionManager.java:88`,
//! `:130`). There is no `KeyInvalid` handling, no re-establish on
//! `FAILED_PRECONDITION` / `UNAUTHENTICATED` / `UNAVAILABLE`, and no boot-time
//! revalidation of the cached kid: **the gRPC status is irrelevant.** Nor does
//! re-running `EstablishWrappingKeys` rotate anything — the shipped krypto
//! client never calls that RPC at all (no caller in the decompiled
//! `PrivacyClient`; the device uploads `ClearKey`s, see
//! `ProtobufPrivacyUtils.constructImportableKey:92`).
//!
//! What *does* work is the periodic pull the device makes on its own:
//!
//! 1. `PrivacySyncAllWorker` runs every 30 minutes on a CONNECTED constraint
//!    (`humaneinternal/system/krypto/KryptoService.java:301`) and dispatches
//!    `PRIVACY_SYNC_ALL`, which includes `PrSyncKeysHandler`.
//! 2. `PrSyncKeysHandler.sync()` calls `SyncKeys` and, for every kid this server
//!    returns in `delete_kids`, looks the key up locally and — when it is there —
//!    calls `keyManager.removeKey(kid, KRYPTO_CREDS, true)`
//!    (`humaneinternal/system/privacy/handlers/PrSyncKeysHandler.java:60-67`).
//!    `delete = true` reaches `kryptonite.deleteKey`, so the key material is
//!    really gone (`CorePrivacyKeyManager.java:228,252-258`).
//! 3. The kid itself survives: `KryptoSecureChannelFactory.getKeyId` keeps it in
//!    the `krypto_key_id_cache` `SharedPreferences` and nothing clears that
//!    (`KryptoSecureChannelFactory.java:147`). So the next time `generateKey`
//!    runs, `kms.getKey` returns null, it re-creates the key **under the same
//!    kid**, and this time it does not take the early return — it calls
//!    `importKey` (`KryptoSecureChannelFactory.java:56-79`).
//! 4. `importKey` -> `uploadKey(keyId, channelId)` exports the clear key and calls
//!    `client.importEphemeralKeys` unconditionally — that path consults no
//!    `uploaded`/`removing` bookkeeping
//!    (`SynchronousPrivacyKeyManager.java:196-213`). The server gets a fresh
//!    `ImportKeys` for the kid it had lost.
//!
//! The one thing the server cannot drive is step 3's timing:
//! `CoreSecureChannelFactory.getChannel` serves the channel from a
//! **process-static** cache (`CoreSecureChannelFactory.java:98,37`) that only
//! `releaseChannel`/`shutdown` clear, and the ephemeral factory constructs its
//! channels with `cleanupKeysOnShutdown = false`
//! (`KryptoSecureChannelFactory.java:135`). So the re-import lands on the next
//! restart of the app process that owns the channel, i.e. after a reboot.
//!
//! **Operator recovery, exactly:** nothing to do by hand in the normal case —
//! serve the stranded kid in `SyncKeys.delete_kids` (this module does that
//! automatically for kids seen on unopenable envelopes) and reboot the Pin. Only
//! if that fails is the manual step needed, and it is: `adb shell` as root,
//! `rm /data/data/hu.ma.ne.ironman/shared_prefs/krypto_key_id_cache.xml` — that
//! is `KEY_ID_CACHE_PREFS` (`KryptoSecureChannelFactory.java:44`) under the
//! package that hosts the AI-bus secure channel (`ironman`, per its
//! `AndroidManifest.xml`) — then reboot. That forces a brand-new kid instead of
//! reusing the cached one.
//!
//! # Every kid operation is scoped to the caller
//!
//! A kid is caller-supplied input, not a capability. See the
//! "Principal scoping" section below for the rule and the decompiled evidence
//! that makes `u=` the field it hangs on.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, OnceLock};

use cosmos_crypto::{AES_KEY_LEN, CryptoError};
use prost::Message;

use crate::keymaterial::{SharedKeyMaterial, WrappingKeyMaterial};
use crate::store::{AccountBlobKind, MemoryStore, SharedStore};
use cosmos_protocol::krypton::grpc::key as keypb;
use cosmos_protocol::privacy::grpc::common as commonpb;

const MAX_KEY_RPC_BATCH: usize = 256;
use cosmos_protocol::privacy::grpc::r#pub as pb;
use pb::public_privacy_service_server::PublicPrivacyService;
use tonic::{Request, Response, Status};

type ImportedChannelKey = (String, [u8; AES_KEY_LEN]);
type ImportOutcome = (commonpb::KeyState, Option<ImportedChannelKey>);

/// Settings returned to a wearer who has not changed any privacy preference.
///
/// These names and values are observed wire behavior from an operator-owned Pin.
/// The ordering is clone-owned and has no protocol significance.
const DEFAULT_PRIVACY_SETTINGS: [(&str, &str); 6] = [
    ("location", "on"),
    ("save_event_location", "off"),
    ("last_location", "off"),
    ("share_capture_location", "off"),
    ("v1p0_defaults", "on"),
    ("traces", "off"),
];

/// Privacy-setting gates advertised to stock key managers.
///
/// The tuples are observed wire behavior from an operator-owned Pin. Every row
/// has value `on` and no label restriction; the clone authors the representation
/// independently from those observations.
const PRIVACY_CONFIGURATION: [(&str, &str); 24] = [
    ("last_location", "aiprofile"),
    ("location", "aibus"),
    ("location", "capture"),
    ("location", "notableevents"),
    ("location", "notes"),
    ("location", "personaldata"),
    ("save_event_location", "notableevents"),
    ("share_capture_location", "capture"),
    ("traces", "aibus"),
    ("v1p0_defaults", "account"),
    ("v1p0_defaults", "aibus"),
    ("v1p0_defaults", "aiprofile"),
    ("v1p0_defaults", "capture"),
    ("v1p0_defaults", "contacts"),
    ("v1p0_defaults", "default"),
    ("v1p0_defaults", "food"),
    ("v1p0_defaults", "health"),
    ("v1p0_defaults", "messages"),
    ("v1p0_defaults", "notableevents"),
    ("v1p0_defaults", "notes"),
    ("v1p0_defaults", "partnerservices"),
    ("v1p0_defaults", "personaldata"),
    ("v1p0_defaults", "search"),
    ("v1p0_defaults", "temporal"),
];

/// Stable clone-owned version marker for the configuration snapshot.
///
/// This is deliberately an opaque fixed token rather than a claim about the
/// original service's deployment time. The service returns the full snapshot on
/// every request, including when a client supplies this timestamp as `since_ts`.
const PRIVACY_CONFIGURATION_UPDATED_SECONDS: i64 = 1_700_000_000;

fn default_settings_snapshot() -> pb::GetSettingsResponse {
    pb::GetSettingsResponse {
        settings: DEFAULT_PRIVACY_SETTINGS
            .into_iter()
            .map(|(name, value)| commonpb::PrivacySettingInfo {
                name: name.to_owned(),
                status: commonpb::SettingState::SettingSuccess as i32,
                value: value.to_owned(),
            })
            .collect(),
    }
}

fn configuration_snapshot() -> pb::GetConfigurationResponse {
    pb::GetConfigurationResponse {
        updated_ts: Some(prost_types::Timestamp {
            seconds: PRIVACY_CONFIGURATION_UPDATED_SECONDS,
            nanos: 0,
        }),
        configs: PRIVACY_CONFIGURATION
            .into_iter()
            .map(|(name, manager)| pb::PrivacySettingConfiguration {
                name: name.to_owned(),
                value: "on".to_owned(),
                manager: manager.to_owned(),
                labels: Vec::new(),
            })
            .collect(),
    }
}

/// Kids the device is still sealing under that this server holds no key for.
///
/// Populated by the `Encrypted*` open path (via [`note_unknown_kid`]) and drained
/// by `SyncKeys`, which hands them back as `delete_kids` so the device deletes
/// the local key and re-imports it under the same kid. See the module doc for the
/// full device-side chain.
///
/// **A kid only ever enters this set after an envelope sealed under it failed to
/// open with `UnknownKid`.** Never on a bad tag, never on a malformed envelope,
/// never speculatively: telling the device to delete a key that works would take
/// a healthy channel down, so the entry condition is "the channel is already
/// broken and this is the only way back".
#[derive(Clone, Default)]
pub struct ReestablishQueue(Arc<Mutex<BTreeSet<String>>>);

impl ReestablishQueue {
    /// The process-wide queue. The `Encrypted*` handlers and `PublicPrivacy` live
    /// in different services built independently in `lib.rs`, and both halves must
    /// see the same set for the repair to close, so the default wiring shares one.
    pub fn shared() -> Self {
        static SHARED: OnceLock<ReestablishQueue> = OnceLock::new();
        SHARED.get_or_init(ReestablishQueue::default).clone()
    }

    /// Record a kid this server cannot open. Invalid kids are ignored: an
    /// envelope cannot turn the process-wide repair queue into an unbounded or
    /// ambiguous authority merely by naming attacker-controlled bytes.
    pub fn note_unknown(&self, kid: &str) {
        if !crate::keydirectory::valid_directory_kid(kid) {
            tracing::warn!("ignoring an invalid channel-key id in the repair queue");
            return;
        }
        let mut queue = self.0.lock().expect("reestablish queue poisoned");
        if !queue.contains(kid) && queue.len() >= crate::keydirectory::MAX_DIRECTORY_KEYS {
            tracing::warn!("channel-key repair queue reached its safe capacity");
            return;
        }
        queue.insert(kid.to_owned());
    }

    /// Drop a kid once the device has actually re-imported it.
    fn resolved(&self, kid: &str) {
        self.0
            .lock()
            .expect("reestablish queue poisoned")
            .remove(kid);
    }

    /// The kids to ask the device to drop, as `delete_kids` wants them: the
    /// device decodes each with `SimpleKrKeyId(ByteBuffer)`, which is a plain
    /// UTF-8 round trip of the kid string (`hu/ma/ne/krypton/key/SimpleKrKeyId.java:45`),
    /// so the bytes we echo back are exactly the ones that arrived on
    /// `EncryptionInformation.kid`.
    fn delete_kids(&self) -> Vec<Vec<u8>> {
        self.0
            .lock()
            .expect("reestablish queue poisoned")
            .iter()
            .map(|kid| kid.as_bytes().to_vec())
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Principal scoping
// ---------------------------------------------------------------------------
//
// Every RPC here takes a kid straight off the wire and acts on it, and nothing
// used to check that the kid had anything to do with the caller. `ImportKeys`
// overwrites whatever key is stored under a kid, so any enrolled device could
// replace another wearer's channel key and silently kill their assistant — every
// envelope the Pin sealed afterwards would fail to open, and the device treats
// that as `null` with a log line and no recovery (see the module doc). `SyncKeys`
// handed the whole process-global stranded-kid queue to every caller, and a kid
// is not opaque: `CoreKeyIdCodec.generateKeyId`
// (`hu/ma/ne/krypton/key/CoreKeyIdCodec.java:19`) builds it as
// `d=<deviceId>;u=<userId>;s=<serviceId>;a=<adminId>;<hex secs>;<hex nonce>`, so
// the queue is a list of other wearers' identifiers in cleartext.
//
// The identifier the check hangs on is `u=`. `d=` is always EMPTY on a real
// ephemeral channel kid — `CoreSecureChannelFactory.constructCreds:53` builds
// `KrCredentials.of(null, userId, channelId.getId(), null)`, so the device id
// slot is never filled — while `u=` carries the DeviceUser id, which is exactly
// the `U:` field of the mTLS subject the edge authenticates
// (`V:xx:D:<device>:U:<user>`, `hu.ma.ne.core.DeviceConstants`). So the kid and
// the principal name the same thing, and comparing them costs no new state.
//
// **The rule refuses only what it can positively attribute to someone else.** A
// kid whose `u=` is empty is not attributable to any wearer and is left alone,
// because that is the shape a channel established before login produces and
// refusing it would break a repair path for no security gain. A caller whose
// principal names no user (an attestation subject, or a request that never went
// through the edge) is likewise not narrowed.
//
// # The gate parsed a principal shape that no longer exists, and so never fired
//
// `caller_user_id` used to require the raw DeviceUser CN `V:xx:D:<device>:U:<user>`
// and bail at the first field that was not `V`. Nothing ever hands it that:
// `AuthLayer` builds every principal through `AuthenticatedPrincipal::from_device_cn`
// (`config.rs`), which COLLAPSES a DeviceUser CN onto its user
// (`cosmos_core::AuthenticatedPrincipal::for_user` → `U:<user>`), and the web
// plane calls `for_user` directly. So the first field was always `U`, the caller
// side was `None` for every real request, and `kid_is_actionable` permits
// whenever either side is `None` — the gate permitted everything, on every call
// site, while its unit tests passed because the helper injected the raw
// pre-collapse CN through `from_edge`. The kid side was dead the same way for
// Center, whose kid is `<principal>/center/ephemeral` and carries no `d=`/`;`.
// Both are fixed below: the principal parser now accepts the collapsed form that
// is actually produced, and kid attribution understands the Center shape.
//
// # Why enforcement is a mode, and why migration starts in explicit `audit`
//
// Making the comparison fire is necessary but not sufficient, because on this
// deployment the WEARER'S OWN keys do not all name the wearer's current user id.
// Read-only off the live `cosmos_channel_key` table on 2026-08-10: 377 rows — 21
// krypton kids under the user id the clone's DeviceUser certificate names
// (minted 2026-08-07/08), 3 with an empty `u=`, 1 Center kid, and 352 minted
// between 2024-04 and 2025-02 under a RETIRED user id from the Humane-cloud era
// that this server has no record of anywhere else (`cosmos_device_account` knows
// only the current one). A pure caller-vs-kid comparison classifies those 352 as
// foreign, and `refuse_foreign_kids` is whole-RPC: one legacy kid in a batch
// refuses the batch. On `ImportKeys` that strands the key the device just
// re-created; on `RequestKeys` it replaces the `KEY_NOT_FOUND` that is the ONLY
// answer the client can repair from (see `request_keys`) with an error the
// client turns into a null channel — the wedge this module's doc is written
// around, and its documented manual recovery (deleting `krypto_key_id_cache.xml`)
// needs root, which `adb shell` on this Pin does not have.
//
// Refusing the wearer's own history is not a security win, and it would fail
// exactly the way everything else in this system has failed: invisibly, blaming
// the wrong layer. So the comparison always RUNS and every foreign kid is always
// REPORTED — a warn line naming the RPC plus a `cosmos_kid_scope_foreign_total`
// counter — and `COSMOS_KID_SCOPE` decides whether it also refuses:
//
//   * `audit` — permit and report. The control is live and observable;
//     an operator can see whether enforcing would break anything BEFORE it does.
//   * `enforce` — refuse. Correct the moment the retired identity is reconciled
//     (or on any deployment that never had one), which is the state a second
//     enrolled wearer requires anyway.
//
// The mode is announced at startup, at `warn` while it is not enforcing, so
// "this protection is not refusing anything" is a line in the log of every boot
// rather than a fact discoverable only by reading this file.

/// How this deployment treats a key operation naming another wearer's kid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KidScope {
    /// Report the foreign kid and permit the operation. See the section comment
    /// for the retired-identity evidence behind this explicit migration mode.
    Audit,
    /// Report the foreign kid and refuse the operation.
    Enforce,
}

impl KidScope {
    const fn label(self) -> &'static str {
        match self {
            Self::Audit => "audit",
            Self::Enforce => "enforce",
        }
    }
}

/// Environment variable selecting the [`KidScope`].
const KID_SCOPE_ENV: &str = "COSMOS_KID_SCOPE";

/// A scope value that passed the exact startup contract.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ConfiguredKidScope(KidScope);

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("COSMOS_KID_SCOPE must be set to exactly `audit` or `enforce`")]
pub struct KidScopeConfigurationError;

fn parse_kid_scope(raw: Option<&str>) -> Result<KidScope, KidScopeConfigurationError> {
    match raw {
        Some("audit") => Ok(KidScope::Audit),
        Some("enforce") => Ok(KidScope::Enforce),
        _ => Err(KidScopeConfigurationError),
    }
}

/// Validate and announce the AI-bus scope before any listener or service starts.
///
/// There is deliberately no default and no case/whitespace normalization: an
/// unset or mistyped protection mode is an operator error, never permission to
/// weaken enforcement silently.
pub(crate) fn configured_kid_scope(
    raw: Option<&str>,
) -> Result<ConfiguredKidScope, KidScopeConfigurationError> {
    let scope = parse_kid_scope(raw)?;
    match scope {
        KidScope::Enforce => tracing::info!(
            variable = KID_SCOPE_ENV,
            mode = scope.label(),
            "kid scoping enforces: a key operation naming another wearer is refused"
        ),
        // Deliberately `warn`: a protection that is not refusing anything has
        // to be visible from the log, not from the source.
        KidScope::Audit => tracing::warn!(
            variable = KID_SCOPE_ENV,
            mode = scope.label(),
            "kid scoping is REPORTING ONLY: a key operation naming another \
             wearer is logged and permitted. Set COSMOS_KID_SCOPE=enforce to \
             refuse it — see the Principal scoping notes in public_privacy.rs \
             for the retired-identity reconciliation this deployment needs first"
        ),
    }
    Ok(ConfiguredKidScope(scope))
}

/// The user id carried by an authenticated principal, in either shape the edge
/// can produce.
///
/// * `U:<user>` — the COLLAPSED form, and the only one a real caller has: both
///   `AuthenticatedPrincipal::from_device_cn` (device front door) and
///   `for_user` (web front door) mint it, so a Pin and its wearer's browser
///   resolve to the same principal.
/// * `V:xx:D:<device>:U:<user>` — a raw DeviceUser CN that reached us
///   un-collapsed. Not produced by `AuthLayer` today; kept because a principal
///   injected by any other path must not silently attribute to nobody.
///
/// `None` for anything else — an attestation subject (`:P:<product>`), a service
/// or synthetic identity, or a call that never passed through `AuthLayer`. The
/// remainder after `U:` is returned verbatim, which is exactly the inverse of
/// `for_user`, so a user id is never truncated by a character it happens to
/// contain.
fn principal_user_id(principal: &str) -> Option<&str> {
    if let Some(user) = principal.strip_prefix("U:") {
        return (!user.is_empty()).then_some(user);
    }
    let mut fields = principal.split(':');
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
    let _device_id = fields.next()?;
    if fields.next()? != "U" {
        return None;
    }
    let user_id = fields.next()?;
    // Nothing may follow the user id, and it must be present.
    if user_id.is_empty() || fields.next().is_some() {
        return None;
    }
    Some(user_id)
}

/// The `u=` field of a krypton kid — the DeviceUser id the key belongs to.
///
/// The shape is fixed by `CoreKeyIdCodec.REGEX`
/// (`^d=[^;]*?;u=[^;]*?;s=[^;]*?;a=[^;]*?;\p{XDigit}+?;\p{XDigit}+$`): six
/// `;`-separated fields, the second of which is `u=<userId>`. An empty `u=` is
/// unattributable and stays `None`; it must NOT fall through to the Center parse
/// below, or a pre-login kid would start being attributed to whatever its first
/// characters look like.
fn krypton_kid_user_id(kid: &str) -> Option<&str> {
    let mut fields = kid.split(';');
    fields.next()?.strip_prefix("d=")?;
    let user = fields.next()?.strip_prefix("u=")?;
    (!user.is_empty()).then_some(user)
}

/// The user id a kid belongs to, or `None` when it names nobody.
///
/// Two producers reach this server, and the gate is worth nothing if it
/// understands only one:
///
/// * the Pin, whose kid is the krypton codec form above;
/// * Center, whose kid is `<principal>/center/ephemeral` (`channel.ts` `kidFor`)
///   — so its owner is simply the user named by the principal prefix, read by
///   the same parser that reads the caller's. Both the current `U:<sub>/…` shape
///   and the pre-collapse `V:01:D:web-demo:U:<sub>/…` rows still in the live key
///   table resolve through that one rule.
///
/// Anything else is unattributable, therefore not refused here. A kid the device
/// cannot decode is the encrypted path's problem, not this gate's.
fn kid_user_id(kid: &str) -> Option<&str> {
    if let Some(user) = krypton_kid_user_id(kid) {
        return Some(user);
    }
    // Not the codec shape: try the Center form. `split('/').next()` on a kid
    // with no `/` is the whole kid, which simply fails to parse as a principal.
    principal_user_id(kid.split('/').next()?)
}

/// Exact authenticated storage partition for a privacy-setting call.
fn caller_principal<T>(request: &Request<T>) -> Result<String, Status> {
    crate::auth::principal(request)
        .map(|principal| principal.expose_for_authorization().to_owned())
        .ok_or_else(|| Status::unauthenticated("an authenticated principal is required"))
}

/// The DeviceUser id the edge authenticated this caller as.
///
/// `None` narrows nothing; the gate below is only as strong as the edge that
/// injects the principal, which is the same posture every other authorization
/// decision in this workload takes.
fn caller_user_id<T>(request: &Request<T>) -> Option<String> {
    let principal = crate::auth::principal(request)?;
    principal_user_id(principal.expose_for_authorization()).map(ToOwned::to_owned)
}

/// Whether `kid` is one this caller may act on.
///
/// False only when both sides name a user and they are different users. See the
/// section comment above for why the unattributable cases stay permitted. This
/// is the comparison alone — [`kid_permitted`] applies the configured scope.
fn kid_is_actionable(caller: Option<&str>, kid: &str) -> bool {
    match (caller, kid_user_id(kid)) {
        (Some(caller), Some(owner)) => caller == owner,
        _ => true,
    }
}

/// Report a foreign kid, and answer whether the active scope also refuses it.
///
/// Reporting is unconditional: this is the only place a cross-wearer key
/// operation is ever visible, and in `audit` it is the ONLY effect the control
/// has. The kid and the wearer id are the identifiers at stake, so neither
/// reaches the log — `rpc` plus a count is what an operator needs to decide
/// whether enforcing is safe.
fn report_foreign_kid(scope: KidScope, rpc: &'static str) -> bool {
    crate::metrics::increment(
        "cosmos_kid_scope_foreign_total",
        &[("rpc", rpc), ("mode", scope.label())],
    );
    match scope {
        KidScope::Enforce => {
            tracing::warn!(
                rpc,
                "refusing a key operation on a kid that names another wearer"
            );
            true
        }
        KidScope::Audit => {
            tracing::warn!(
                rpc,
                "PERMITTING a key operation on a kid that names another wearer: \
                 kid scoping is in audit mode (COSMOS_KID_SCOPE=enforce refuses it)"
            );
            false
        }
    }
}

/// Whether this caller may act on `kid` under the active scope, reporting the
/// foreign case either way.
///
/// The short-circuit matters: an actionable kid is the overwhelmingly common
/// case and must cost nothing, and must never emit a line.
fn kid_permitted(scope: KidScope, rpc: &'static str, caller: Option<&str>, kid: &str) -> bool {
    kid_is_actionable(caller, kid) || !report_foreign_kid(scope, rpc)
}

#[allow(clippy::result_large_err)]
fn validated_kid_bytes(kid: &[u8]) -> Result<&str, Status> {
    let kid = std::str::from_utf8(kid).map_err(|_| {
        Status::invalid_argument("channel-key id must be valid UTF-8 without replacement")
    })?;
    if !crate::keydirectory::valid_directory_kid(kid) {
        return Err(Status::invalid_argument(
            "channel-key id must be nonempty, at most 1024 bytes, and control-free",
        ));
    }
    Ok(kid)
}

/// Refuse a batch that names a kid belonging to another wearer.
///
/// Whole-RPC rather than per-kid, because the per-kid `KeyState` rows are an
/// instruction channel the device acts on — `KEY_NOT_FOUND` makes it recreate a
/// key — and there is no state in that enum that means "not yours".
///
/// Every kid is examined even once one has been refused, so the counter reflects
/// the batch rather than its first offender; that is the number an operator
/// needs before switching the mode.
#[allow(clippy::result_large_err)]
fn refuse_foreign_kids<'a>(
    scope: KidScope,
    rpc: &'static str,
    caller: Option<&str>,
    kids: impl IntoIterator<Item = &'a [u8]>,
) -> Result<(), Status> {
    let kids: Vec<&[u8]> = kids.into_iter().take(MAX_KEY_RPC_BATCH + 1).collect();
    if kids.len() > MAX_KEY_RPC_BATCH {
        return Err(Status::resource_exhausted(
            "key lifecycle request exceeds the bounded batch size",
        ));
    }
    // Validate the whole batch before authorization metrics, key generation,
    // directory reads, or mutations. In particular, distinct invalid UTF-8
    // byte strings must never collapse through replacement characters.
    let kids = kids
        .into_iter()
        .map(validated_kid_bytes)
        .collect::<Result<Vec<_>, _>>()?;
    let mut refuse = false;
    for kid in kids {
        if !kid_permitted(scope, rpc, caller, kid) {
            refuse = true;
        }
    }
    if refuse {
        // The kid itself is the wearer identifier; it never reaches the wire
        // message.
        return Err(Status::permission_denied(
            "this key belongs to another wearer",
        ));
    }
    Ok(())
}

/// Record that an `Encrypted*` envelope named a kid this server has no key for.
///
/// Called from the encrypted open path so the next `SyncKeys` can ask the device
/// to re-establish. Routed through the shared queue rather than a threaded
/// handle because the AI-bus services and `PublicPrivacy` are constructed
/// separately in `lib.rs`.
pub fn note_unknown_kid(kid: &str) {
    ReestablishQueue::shared().note_unknown(kid);
}

/// The privacy service is the **writer** half of the ephemeral-key lifecycle: it
/// publishes the server wrapping key from `KeyMaterial` and imports device
/// channel keys into the authoritative `KeyDirectory` read by every workload.
fn key_material_mutation_status(error: CryptoError) -> Status {
    match error {
        CryptoError::SnapshotUnreadable => Status::failed_precondition(
            "key material snapshot is unreadable; restore it before changing channel keys",
        ),
        CryptoError::KeyMaterialPersistence => Status::unavailable(
            "channel-key mutation was not committed because durable persistence failed; retry",
        ),
        _ => Status::internal("channel-key mutation failed"),
    }
}

/// A durable-state fault is not an absent channel and not a corrupt envelope.
/// Every encrypted RPC maps these two variants identically so a repairable I/O
/// outage is never turned into `KEY_NOT_FOUND` or an authentication verdict.
pub(crate) fn key_material_availability_status(error: &CryptoError) -> Option<Status> {
    match error {
        CryptoError::SnapshotUnreadable => Some(Status::failed_precondition(
            "key material snapshot is unreadable; restore it before using channel keys",
        )),
        CryptoError::KeyMaterialPersistence => Some(Status::unavailable(
            "channel-key durability could not be confirmed; retry",
        )),
        _ => None,
    }
}

#[derive(Clone)]
pub struct PublicPrivacy {
    keys: SharedKeyMaterial,
    reestablish: ReestablishQueue,
    /// Durable, principal-scoped privacy-setting snapshots. An empty response is
    /// destructive to the stock client: its all-sync trims every local setting
    /// not named by the server response.
    store: SharedStore,
    /// The sole production channel-key authority. `None` exists only for
    /// focused memory-only tests of the legacy service contract.
    directory: Option<crate::keydirectory::SharedKeyDirectory>,
    /// Whether a kid naming another wearer is refused or only reported. The
    /// serving path validates the exact environment value before binding and
    /// passes that value into the service explicitly.
    scope: KidScope,
}

#[cfg(test)]
impl Default for PublicPrivacy {
    fn default() -> Self {
        Self {
            keys: SharedKeyMaterial::default(),
            reestablish: ReestablishQueue::shared(),
            store: MemoryStore::shared(),
            directory: None,
            scope: KidScope::Audit,
        }
    }
}

impl PublicPrivacy {
    async fn read_settings(&self, principal: &str) -> Result<pb::GetSettingsResponse, Status> {
        let mut settings: std::collections::BTreeMap<_, _> = default_settings_snapshot()
            .settings
            .into_iter()
            .map(|setting| (setting.name.clone(), setting))
            .collect();

        let Some(bytes) = self
            .store
            .get_account_blob(principal, AccountBlobKind::PrivacySettings)
            .await?
        else {
            return Ok(pb::GetSettingsResponse {
                settings: settings.into_values().collect(),
            });
        };
        let stored = pb::GetSettingsResponse::decode(bytes.as_slice()).map_err(|_| {
            tracing::error!("stored privacy settings could not be decoded");
            Status::internal("stored privacy settings could not be read")
        })?;
        for mut setting in stored.settings {
            // A setting returned successfully by this read is represented as
            // SETTING_SUCCESS even if an older stored snapshot carried another
            // transient result state.
            setting.status = commonpb::SettingState::SettingSuccess as i32;
            settings.insert(setting.name.clone(), setting);
        }
        Ok(pb::GetSettingsResponse {
            settings: settings.into_values().collect(),
        })
    }

    /// Publish imported keys to the directory every encrypted workload reads.
    pub fn with_key_directory(
        mut self,
        directory: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        self.directory = Some(directory);
        self
    }

    pub(crate) fn with_key_material_and_scope(
        keys: SharedKeyMaterial,
        scope: ConfiguredKidScope,
    ) -> Self {
        Self {
            keys,
            reestablish: ReestablishQueue::shared(),
            store: MemoryStore::shared(),
            directory: None,
            scope: scope.0,
        }
    }

    #[cfg(test)]
    pub fn with_key_material(keys: SharedKeyMaterial) -> Self {
        Self {
            keys,
            reestablish: ReestablishQueue::shared(),
            store: MemoryStore::shared(),
            directory: None,
            scope: KidScope::Audit,
        }
    }

    pub fn with_store(mut self, store: SharedStore) -> Self {
        self.store = store;
        self
    }

    /// Pin the kid-scope mode explicitly instead of reading the environment.
    ///
    /// Tests use this so both modes are exercised in one process: the
    /// environment-backed value is resolved once per process and cannot be
    /// changed afterwards, which is the right behaviour for a server and the
    /// wrong one for a test suite that must pin both.
    #[cfg(test)]
    fn with_kid_scope(mut self, scope: KidScope) -> Self {
        self.scope = scope;
        self
    }

    /// Same, with an isolated re-establish queue so a test does not observe the
    /// process-wide one.
    #[cfg(test)]
    fn with_parts(keys: SharedKeyMaterial, reestablish: ReestablishQueue) -> Self {
        Self {
            keys,
            reestablish,
            store: Arc::new(MemoryStore::default()),
            directory: None,
            scope: KidScope::Audit,
        }
    }

    fn wrapping_key(&self) -> Result<Arc<WrappingKeyMaterial>, Status> {
        self.keys.wrapping_key().map_err(|err| match err {
            // `SnapshotUnreadable` is not a generation failure: the durable
            // snapshot exists but could not be read, so the keypair the device
            // already wrapped to is still in that file. Blaming key *generation*
            // (`internal`) both mislabels the layer and invites a retry that
            // would mint a second keypair and strand the device for good. Report
            // it as its own cause — a failed precondition the operator must
            // clear by restoring the snapshot — and name the snapshot so the
            // container log and the RPC status agree with keymaterial.rs, which
            // already logs the true cause at error level with the path.
            CryptoError::SnapshotUnreadable => Status::failed_precondition(
                "key material snapshot is unreadable; refusing to mint a replacement \
                 wrapping key (restore the snapshot to recover)",
            ),
            CryptoError::KeyMaterialPersistence => Status::unavailable(
                "wrapping key was not published because its durable snapshot could not be installed; retry",
            ),
            // Every other variant here really is a keygen/allocation failure on
            // the first-use path.
            _ => Status::internal("failed to generate wrapping key"),
        })
    }

    /// `kp` is the RSA-OAEP wrapping keypair, and is `None` unless this batch
    /// actually contains a wrapped key — generating it costs a 4096-bit keygen,
    /// and the shipped device never sends one (`exportClearKey` ->
    /// `constructImportableKey` takes the `IKrClearKey` branch,
    /// `SynchronousPrivacyKeyManager.java:198`,
    /// `ProtobufPrivacyUtils.constructImportableKey:98`). Paying it on a cold
    /// server would put a multi-second stall in front of the one RPC that repairs
    /// a stranded channel.
    /// Returns the imported key alongside the status so the caller can publish
    /// it to the cross-workload directory. It is returned rather than pushed from
    /// here because that write is async and this path is deliberately sync.
    fn import_one(
        &self,
        kp: Option<&WrappingKeyMaterial>,
        kid: String,
        ik: pb::ImportableKey,
    ) -> Result<ImportOutcome, CryptoError> {
        use pb::importable_key::Key;
        let raw = match ik.key {
            // RSA-OAEP-wrapped ephemeral key uploaded by the device.
            Some(Key::WrappedKey(w)) => match kp.map(|kp| kp.unwrap(&w.keydata)) {
                Some(Ok(k)) => k,
                Some(Err(_)) | None => return Ok((commonpb::KeyState::KeyInvalid, None)),
            },
            // Already-clear key material.
            Some(Key::ClearKey(c)) => c.jca_encoded,
            None => return Ok((commonpb::KeyState::KeyInvalid, None)),
        };
        match <[u8; AES_KEY_LEN]>::try_from(raw.as_slice()) {
            Ok(key) => Ok((commonpb::KeyState::KeyImported, Some((kid, key)))),
            Err(_) => Ok((commonpb::KeyState::KeyInvalid, None)),
        }
    }
}

#[tonic::async_trait]
impl PublicPrivacyService for PublicPrivacy {
    async fn establish_wrapping_keys(
        &self,
        _request: Request<pb::EstablishWrappingKeysRequest>,
    ) -> Result<Response<pb::EstablishWrappingKeysResponse>, Status> {
        let kp = self.wrapping_key()?;
        // Publish the server's RSA-OAEP wrapping public key (SPKI DER) so the
        // device can wrap its ephemeral AES-128 channel keys to it.
        let clear_key = keypb::ClearKey {
            kid: b"cosmos-clone/wrapping/rsa-oaep".to_vec(),
            level: keypb::Level::Unspecified as i32,
            algo: keypb::Algo::RsaOaep as i32,
            ops: vec![keypb::Op::Wrap as i32, keypb::Op::Encrypt as i32],
            jca_encoded: kp.public_der().to_vec(),
            jca_algo: "RSA".to_owned(),
        };
        Ok(Response::new(pb::EstablishWrappingKeysResponse {
            clear_key: Some(clear_key),
        }))
    }

    /// Import the device's ephemeral channel keys.
    ///
    /// **Scoped to the caller** — refused under `COSMOS_KID_SCOPE=enforce`, and
    /// reported but permitted when the operator explicitly selects `audit` (see
    /// the Principal scoping section for why migration starts in that mode).
    ///
    /// This RPC overwrites whatever key is stored under a kid, so an unscoped one
    /// lets any enrolled device replace another wearer's channel key — after
    /// which every envelope that Pin seals fails to open,
    /// `EphemeralProtectionManager.encrypt` returns null with a log line, and
    /// nothing on the device notices or recovers. The check runs before any key
    /// material is touched, so enforcing refuses without having clobbered
    /// anything.
    async fn import_keys(
        &self,
        request: Request<pb::ImportKeysRequest>,
    ) -> Result<Response<pb::ImportKeysResponse>, Status> {
        let caller = caller_user_id(&request);
        refuse_foreign_kids(
            self.scope,
            "ImportKeys",
            caller.as_deref(),
            request.get_ref().keys.iter().map(|ik| ik.kid.as_slice()),
        )?;

        // Materialized only if the batch actually carries a wrapped key; see
        // `import_one`.
        let mut kp: Option<Arc<WrappingKeyMaterial>> = None;
        let mut results = Vec::new();
        for ik in request.into_inner().keys {
            let kid = ik.kid.clone();
            let kid_text = validated_kid_bytes(&kid)?.to_owned();
            if kp.is_none() && matches!(ik.key, Some(pb::importable_key::Key::WrappedKey(_))) {
                kp = Some(self.wrapping_key()?);
            }
            let (mut status, imported) = self
                .import_one(kp.as_deref(), kid_text, ik)
                .map_err(key_material_mutation_status)?;
            if let Some((imported_kid, key)) = imported {
                // The configured directory is the sole channel-key authority.
                // There is deliberately no second local write after this UPSERT:
                // that former DB/local boundary admitted split-brain crashes.
                if let Some(directory) = &self.directory {
                    directory
                        .put(&imported_kid, key)
                        .await
                        .map_err(|error| crate::keydirectory::grpc_status(&error))?;
                } else {
                    // Explicit memory-only/legacy test topology.
                    self.keys
                        .insert(imported_kid.clone(), key)
                        .map_err(key_material_mutation_status)?;
                }
                self.reestablish.resolved(&imported_kid);
                status = commonpb::KeyState::KeyImported;
            }
            results.push(commonpb::KeyStateResponse {
                kid,
                status: status as i32,
            });
        }
        Ok(Response::new(pb::ImportKeysResponse { results }))
    }

    async fn get_settings(
        &self,
        request: Request<pb::GetSettingsRequest>,
    ) -> Result<Response<pb::GetSettingsResponse>, Status> {
        let principal = caller_principal(&request)?;
        let names = request.into_inner().names;
        let mut response = self.read_settings(&principal).await?;
        if !names.is_empty() {
            let wanted: BTreeSet<_> = names.into_iter().collect();
            response
                .settings
                .retain(|setting| wanted.contains(&setting.name));
        }
        Ok(Response::new(response))
    }

    async fn get_configuration(
        &self,
        _request: Request<pb::GetConfigurationRequest>,
    ) -> Result<Response<pb::GetConfigurationResponse>, Status> {
        Ok(Response::new(configuration_snapshot()))
    }

    async fn update_settings(
        &self,
        request: Request<pb::UpdateSettingsRequest>,
    ) -> Result<Response<pb::UpdateSettingsResponse>, Status> {
        let principal = caller_principal(&request)?;
        let incoming = request.into_inner().settings;
        let mut snapshot = self.read_settings(&principal).await?;
        let mut by_name: std::collections::BTreeMap<String, commonpb::PrivacySettingInfo> =
            snapshot
                .settings
                .drain(..)
                .map(|setting| (setting.name.clone(), setting))
                .collect();
        let mut results = Vec::with_capacity(incoming.len());
        for setting in incoming {
            if setting.name.is_empty() {
                results.push(commonpb::SettingStateResponse {
                    name: setting.name,
                    status: commonpb::SettingState::SettingInvalid as i32,
                });
                continue;
            }
            let status = if by_name.contains_key(&setting.name) {
                commonpb::SettingState::SettingUpdated
            } else {
                commonpb::SettingState::SettingSuccess
            };
            results.push(commonpb::SettingStateResponse {
                name: setting.name.clone(),
                status: status as i32,
            });
            by_name.insert(
                setting.name.clone(),
                commonpb::PrivacySettingInfo {
                    name: setting.name,
                    status: commonpb::SettingState::SettingSuccess as i32,
                    value: setting.value,
                },
            );
        }
        let stored = pb::GetSettingsResponse {
            settings: by_name.into_values().collect(),
        };
        self.store
            .put_account_blob(
                &principal,
                AccountBlobKind::PrivacySettings,
                &stored.encode_to_vec(),
            )
            .await?;
        Ok(Response::new(pb::UpdateSettingsResponse { results }))
    }

    /// The device's key download — and the single point on which the whole
    /// re-establishment repair turns.
    ///
    /// After a `delete_kids` cycle the device has destroyed its local key but has
    /// NOT cleared its cached kid (`krypto_key_id_cache` is never written by
    /// anything but `getKeyId`; there is no `remove` anywhere in the client). So
    /// on the next process start `generateKey` asks the KMS, misses, and falls
    /// through to `downloadKey` → this RPC, containing that same kid.
    ///
    /// **Answering with an empty list wedges the device.** An empty `keys` is not
    /// read as "not found": `SynchronousPrivacyKeyManager.downloadKey` finds no
    /// entry matching the kid and throws `UnexpectedRemoteException("No response
    /// returned for key ID …")`, which surfaces as `EphemeralInternalException`
    /// in `generateKey`, so `getChannel` throws and `EphemeralProtectionManager.
    /// encrypt` returns null. The device never reaches `createKey`/`importKey`/
    /// `uploadKey`, and the channel is dead with no path back.
    ///
    /// The repair branch is entered only by an `ExportableKey` FOR THAT KID with
    /// `status = KEY_NOT_FOUND` and no key bytes: `constructKey` yields
    /// `KeyResponse(kid, KEY_NOT_FOUND, key = null)`, `CorePrivacyKeyManager::
    /// importKey` early-returns on the null key, `getKey` returns null, and
    /// `generateKey` then creates the key and uploads it under the same kid —
    /// which is exactly the re-establishment we want.
    ///
    /// So: report honestly, per kid, that we do not hold it. That is not
    /// fabricated key material — it is the truthful answer, in the one encoding
    /// the device can act on.
    ///
    /// Scoping does NOT change any of that. The repair depends on this RPC
    /// answering `KEY_NOT_FOUND` for a kid we do not hold, and it keeps doing so
    /// for every kid the caller can own — the check refuses only a kid whose `u=`
    /// names a *different* wearer, which is never the caller's own repair path.
    /// What it does close is the existence oracle: asking about another wearer's
    /// kid used to come back `KEY_EXISTS` or `KEY_NOT_FOUND`, which is a probe
    /// for whether that wearer's channel is established.
    ///
    /// It is also why this RPC is the one that decides the migration mode. A
    /// refusal here is NOT a status the client can recover from — it lands in the
    /// same `EphemeralInternalException` path as the empty-list wedge above — so
    /// misclassifying a kid as foreign costs the wearer their channel with no way
    /// back. See the Principal scoping section: this deployment's own retired
    /// user id would be misclassified today, so the documented migration starts
    /// in explicit `audit` rather than refusing.
    async fn request_keys(
        &self,
        request: Request<pb::RequestKeysRequest>,
    ) -> Result<Response<pb::RequestKeysResponse>, Status> {
        let caller = caller_user_id(&request);
        refuse_foreign_kids(
            self.scope,
            "RequestKeys",
            caller.as_deref(),
            request.get_ref().kids.iter().map(Vec::as_slice),
        )?;

        let mut keys = Vec::new();
        for kid in request.into_inner().kids {
            let kid_text = validated_kid_bytes(&kid)?;
            let held = if let Some(directory) = &self.directory {
                directory
                    .holds(kid_text)
                    .await
                    .map_err(|error| crate::keydirectory::grpc_status(&error))?
            } else {
                self.keys
                    .holds(kid_text)
                    .map_err(key_material_mutation_status)?
            };
            let status = if held {
                // We DO hold this key. Do not claim KEY_NOT_FOUND: that sends
                // the device down the create-and-upload path, overwriting a
                // key we still have and orphaning anything sealed under it.
                //
                // We also do not hand the key back. The kid is now scoped to
                // the caller, but that scoping rests on the `u=` field, which
                // is empty for a channel established before login — so it is
                // not strong enough to authorize handing out channel key
                // material. Escrow recovery needs an ownership record, not an
                // identifier parsed out of the caller's own input; until then
                // KEY_EXISTS is the truthful answer that discloses nothing.
                commonpb::KeyState::KeyExists
            } else {
                // The repair path: only this answer makes the device rebuild.
                commonpb::KeyState::KeyNotFound
            };
            keys.push(pb::ExportableKey {
                kid,
                status: status as i32,
                // No `key` oneof arm in either branch: we never put channel
                // key material on the wire from here.
                key: None,
                ..Default::default()
            });
        }
        Ok(Response::new(pb::RequestKeysResponse { keys }))
    }

    /// The device's every-30-minutes key pull, and this server's only way to
    /// un-strand a channel it has forgotten.
    ///
    /// `delete_kids` carries exactly the kids that arrived on an `Encrypted*`
    /// envelope we could not open because we hold no key for them. The device
    /// deletes those local keys and, on the next start of the process that owns
    /// the channel, re-creates and re-uploads them under the same kid — see the
    /// module doc for the cited chain. Kids stay listed until an `ImportKeys`
    /// actually delivers the key, because a single `SyncKeys` may be answered
    /// before the device gets a chance to restart.
    ///
    /// `exported_keys` stays empty: we have no server-originated key to push, and
    /// inventing one would be fabricating key material on the wire.
    ///
    /// **Scoped to the caller** under `COSMOS_KID_SCOPE=enforce`; reported and
    /// still served when the operator selected `audit`. The queue is
    /// process-global — one
    /// set shared by every workload, because the `Encrypted*` handlers and this
    /// service are built separately — and it used to be handed whole to whoever
    /// asked. A kid carries `u=<userId>` in cleartext
    /// (`CoreKeyIdCodec.generateKeyId:19`), so that was a list of other wearers'
    /// identifiers served to every device on the deployment. When enforcing,
    /// kids belonging to another wearer are withheld rather than refused: this is
    /// the device's every-30-minutes pull (`KryptoService.java:301`), and failing
    /// it outright would take the repair path down for the caller's own stranded
    /// kids too.
    async fn sync_keys(
        &self,
        request: Request<pb::SyncKeysRequest>,
    ) -> Result<Response<pb::SyncKeysResponse>, Status> {
        let caller = caller_user_id(&request);
        let deletekids = self
            .reestablish
            .delete_kids()
            .into_iter()
            .filter(|kid| {
                std::str::from_utf8(kid)
                    .is_ok_and(|kid| kid_permitted(self.scope, "SyncKeys", caller.as_deref(), kid))
            })
            .collect();
        Ok(Response::new(pb::SyncKeysResponse {
            deletekids,
            exportedkeys: Vec::new(),
        }))
    }

    /// Forget the named channel keys.
    ///
    /// Answer PER KID, never with an empty list. The device pairs each result to
    /// the kid it asked about; a response containing no result for a kid is not read
    /// as "nothing happened" — it is the same shape that wedged `RequestKeys`,
    /// where an empty list made the client raise rather than take a recovery
    /// branch. Reporting the outcome of each kid is both truthful and the only
    /// form the device can act on.
    ///
    /// Scoped to the caller for the same reason as `ImportKeys`: destroying
    /// another wearer's channel key strands their Pin exactly as overwriting it
    /// does.
    async fn remove_keys(
        &self,
        request: Request<pb::RemoveKeysRequest>,
    ) -> Result<Response<pb::RemoveKeysResponse>, Status> {
        let caller = caller_user_id(&request);
        refuse_foreign_kids(
            self.scope,
            "RemoveKeys",
            caller.as_deref(),
            request.get_ref().kids.iter().map(Vec::as_slice),
        )?;

        let mut results = Vec::new();
        for kid in request.into_inner().kids {
            let kid_text = validated_kid_bytes(&kid)?;
            // One authoritative DELETE. A crash before commit leaves the row;
            // one after commit is visible everywhere and retry is idempotent.
            let removed = if let Some(directory) = &self.directory {
                directory
                    .remove(kid_text)
                    .await
                    .map_err(|error| crate::keydirectory::grpc_status(&error))?
            } else {
                self.keys
                    .remove(kid_text)
                    .map_err(key_material_mutation_status)?
            };
            let status = if removed {
                commonpb::KeyState::KeyRemoved
            } else {
                commonpb::KeyState::KeyNotFound
            };
            results.push(commonpb::KeyStateResponse {
                kid,
                status: status as i32,
            });
        }
        Ok(Response::new(pb::RemoveKeysResponse { results }))
    }

    /// Client-side key attribute updates.
    ///
    /// The clone stores no per-key client attributes, so there is nothing to
    /// change — but the device still needs a result row per update, for the same
    /// reason as `remove_keys`. Answer honestly that the key is untouched rather
    /// than returning a silence the client cannot interpret.
    ///
    /// Scoped to the caller: the per-kid `KeyState` it answers with is an
    /// existence oracle for whatever kid was asked about.
    async fn update_keys(
        &self,
        request: Request<pb::UpdateKeysRequest>,
    ) -> Result<Response<pb::UpdateKeysResponse>, Status> {
        let caller = caller_user_id(&request);
        refuse_foreign_kids(
            self.scope,
            "UpdateKeys",
            caller.as_deref(),
            request
                .get_ref()
                .updates
                .iter()
                .map(|update| update.kid.as_slice()),
        )?;

        let mut results = Vec::new();
        for update in request.into_inner().updates {
            let kid_text = validated_kid_bytes(&update.kid)?;
            let held = if let Some(directory) = &self.directory {
                directory
                    .holds(kid_text)
                    .await
                    .map_err(|error| crate::keydirectory::grpc_status(&error))?
            } else {
                self.keys
                    .holds(kid_text)
                    .map_err(key_material_mutation_status)?
            };
            let status = if held {
                // The key exists; we simply keep no attributes to update.
                commonpb::KeyState::KeyExists
            } else {
                commonpb::KeyState::KeyNotFound
            };
            results.push(commonpb::KeyStateResponse {
                kid: update.kid,
                status: status as i32,
            });
        }
        Ok(Response::new(pb::UpdateKeysResponse { results }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kid_scope_configuration_accepts_only_exact_explicit_modes() {
        assert_eq!(parse_kid_scope(Some("audit")), Ok(KidScope::Audit));
        assert_eq!(parse_kid_scope(Some("enforce")), Ok(KidScope::Enforce));
        for rejected in [
            None,
            Some(""),
            Some("Audit"),
            Some(" enforce "),
            Some("warn"),
        ] {
            assert_eq!(parse_kid_scope(rejected), Err(KidScopeConfigurationError));
        }
    }

    fn clear_import_request(kid: &str, byte: u8) -> Request<pb::ImportKeysRequest> {
        Request::new(pb::ImportKeysRequest {
            keys: vec![pb::ImportableKey {
                kid: kid.as_bytes().to_vec(),
                key: Some(pb::importable_key::Key::ClearKey(keypb::ClearKey {
                    kid: kid.as_bytes().to_vec(),
                    level: keypb::Level::Unspecified as i32,
                    algo: keypb::Algo::Unspecified as i32,
                    ops: Vec::new(),
                    jca_encoded: vec![byte; AES_KEY_LEN],
                    jca_algo: "AES".to_owned(),
                })),
                attrs: None,
            }],
        })
    }

    fn import_request_bytes(kid: Vec<u8>) -> Request<pb::ImportKeysRequest> {
        Request::new(pb::ImportKeysRequest {
            keys: vec![pb::ImportableKey {
                kid: kid.clone(),
                key: Some(pb::importable_key::Key::ClearKey(keypb::ClearKey {
                    kid,
                    jca_encoded: vec![0x41; AES_KEY_LEN],
                    jca_algo: "AES".to_owned(),
                    ..Default::default()
                })),
                attrs: None,
            }],
        })
    }

    #[tokio::test]
    async fn every_key_lifecycle_rpc_rejects_ambiguous_or_unbounded_kids_before_authority_use() {
        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let retained_kid = unique_kid("retained-after-invalid");
        let retained_key = [0x31; AES_KEY_LEN];
        directory
            .put(&retained_kid, retained_key)
            .await
            .expect("seed authority");
        let service = PublicPrivacy::with_key_material(Default::default())
            .with_key_directory(directory.clone());
        let invalid_kids = [
            Vec::new(),
            vec![0xff],
            vec![0xfe],
            b"control\x01".to_vec(),
            "c1\u{85}".as_bytes().to_vec(),
            vec![b'x'; crate::keydirectory::MAX_DIRECTORY_KID_BYTES + 1],
        ];

        for kid in invalid_kids {
            let requested = service
                .request_keys(Request::new(pb::RequestKeysRequest {
                    kids: vec![kid.clone()],
                }))
                .await
                .expect_err("invalid RequestKeys kid");
            assert_eq!(requested.code(), tonic::Code::InvalidArgument);

            let imported = service
                .import_keys(import_request_bytes(kid.clone()))
                .await
                .expect_err("invalid ImportKeys kid");
            assert_eq!(imported.code(), tonic::Code::InvalidArgument);

            let removed = service
                .remove_keys(Request::new(pb::RemoveKeysRequest {
                    kids: vec![kid.clone()],
                    ..Default::default()
                }))
                .await
                .expect_err("invalid RemoveKeys kid");
            assert_eq!(removed.code(), tonic::Code::InvalidArgument);

            let updated = service
                .update_keys(Request::new(pb::UpdateKeysRequest {
                    updates: vec![pb::ClientKeyUpdate {
                        kid,
                        client_attrs: None,
                    }],
                }))
                .await
                .expect_err("invalid UpdateKeys kid");
            assert_eq!(updated.code(), tonic::Code::InvalidArgument);

            assert_eq!(
                directory.get(&retained_kid).await.expect("retained row"),
                Some(retained_key),
                "invalid input must leave the authority byte-for-byte equivalent"
            );
        }
    }

    #[tokio::test]
    async fn every_key_lifecycle_rpc_rejects_an_oversized_batch_before_authority_use() {
        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let retained_kid = unique_kid("retained-after-batch");
        let retained_key = [0x32; AES_KEY_LEN];
        directory
            .put(&retained_kid, retained_key)
            .await
            .expect("seed authority");
        let service = PublicPrivacy::with_key_material(Default::default())
            .with_key_directory(directory.clone());
        let kids = (0..=MAX_KEY_RPC_BATCH)
            .map(|index| format!("bounded-kid-{index}").into_bytes())
            .collect::<Vec<_>>();

        let requested = service
            .request_keys(Request::new(pb::RequestKeysRequest { kids: kids.clone() }))
            .await
            .expect_err("oversized RequestKeys batch");
        assert_eq!(requested.code(), tonic::Code::ResourceExhausted);
        let imported = service
            .import_keys(Request::new(pb::ImportKeysRequest {
                keys: kids
                    .iter()
                    .cloned()
                    .map(|kid| import_request_bytes(kid).into_inner().keys.remove(0))
                    .collect(),
            }))
            .await
            .expect_err("oversized ImportKeys batch");
        assert_eq!(imported.code(), tonic::Code::ResourceExhausted);
        let removed = service
            .remove_keys(Request::new(pb::RemoveKeysRequest {
                kids: kids.clone(),
                ..Default::default()
            }))
            .await
            .expect_err("oversized RemoveKeys batch");
        assert_eq!(removed.code(), tonic::Code::ResourceExhausted);
        let updated = service
            .update_keys(Request::new(pb::UpdateKeysRequest {
                updates: kids
                    .into_iter()
                    .map(|kid| pb::ClientKeyUpdate {
                        kid,
                        client_attrs: None,
                    })
                    .collect(),
            }))
            .await
            .expect_err("oversized UpdateKeys batch");
        assert_eq!(updated.code(), tonic::Code::ResourceExhausted);
        assert_eq!(
            directory.get(&retained_kid).await.expect("retained row"),
            Some(retained_key)
        );
    }

    #[test]
    fn repair_queue_rejects_invalid_kids_and_stays_cardinality_bounded() {
        let queue = ReestablishQueue::default();
        queue.note_unknown("");
        queue.note_unknown("c1\u{85}");
        queue.note_unknown(&"x".repeat(crate::keydirectory::MAX_DIRECTORY_KID_BYTES + 1));
        for index in 0..crate::keydirectory::MAX_DIRECTORY_KEYS {
            queue.note_unknown(&format!("queued-{index}"));
        }
        queue.note_unknown("one-too-many");
        let queued = queue.delete_kids();
        assert_eq!(queued.len(), crate::keydirectory::MAX_DIRECTORY_KEYS);
        assert!(!queued.contains(&b"one-too-many".to_vec()));
    }

    /// The other half of the repair: a key we DO hold must not be reported
    /// missing.
    ///
    /// `KEY_NOT_FOUND` is an instruction, not a status — it sends the device down
    /// the create-and-upload path. Saying it about a key we still hold makes the
    /// device overwrite that key and orphan everything sealed under it. The first
    /// version of this fix answered `KEY_NOT_FOUND` for every kid unconditionally,
    /// which was correct only for the unheld case.
    #[tokio::test]
    async fn a_held_kid_is_not_reported_missing() {
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        let kid = unique_kid("held");
        keys.insert(kid.clone(), [9u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let svc = PublicPrivacy::with_key_material(keys);

        let response = svc
            .request_keys(Request::new(pb::RequestKeysRequest {
                kids: vec![kid.as_bytes().to_vec()],
            }))
            .await
            .expect("request_keys answers")
            .into_inner();

        let exported = response
            .keys
            .first()
            .expect("a result for the kid asked about");
        assert_eq!(
            exported.status,
            commonpb::KeyState::KeyExists as i32,
            "a key we hold must not be reported KEY_NOT_FOUND — that tells the \
             device to recreate it and orphans anything sealed under it",
        );
        assert!(
            exported.key.is_none(),
            "this RPC has no principal scoping, so it must never serve key bytes",
        );
    }

    /// `RemoveKeys` must answer per kid, like every other key-lifecycle RPC.
    ///
    /// An empty `results` list is the same shape that wedged `RequestKeys`: the
    /// device pairs results to the kids it asked about, and a missing row is not
    /// read as "nothing happened".
    #[tokio::test]
    async fn remove_keys_answers_for_every_kid_it_was_asked_about() {
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        let held = unique_kid("remove-held");
        let absent = unique_kid("remove-absent");
        keys.insert(held.clone(), [4u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let svc = PublicPrivacy::with_key_material(keys.clone());

        let response = svc
            .remove_keys(Request::new(pb::RemoveKeysRequest {
                kids: vec![held.as_bytes().to_vec(), absent.as_bytes().to_vec()],
                deleted: true,
            }))
            .await
            .expect("remove_keys answers")
            .into_inner();

        assert_eq!(
            response.results.len(),
            2,
            "one result per kid asked about, never an empty list",
        );
        assert_eq!(
            response.results[0].status,
            commonpb::KeyState::KeyRemoved as i32
        );
        assert_eq!(
            response.results[1].status,
            commonpb::KeyState::KeyNotFound as i32
        );
        assert!(
            !keys.holds(&held).expect("inspect removed key"),
            "the key must actually be gone, or the device and server disagree \
             about the channel forever",
        );
    }

    #[tokio::test]
    async fn import_keys_does_not_acknowledge_or_resolve_a_failed_durable_insert() {
        use crate::keymaterial::{KeyMaterial, PersistenceFault};

        let snapshot = TestSnapshot::new("rpc-import-write-failure");
        let keys = Arc::new(KeyMaterial::at_path(snapshot.path()));
        let queue = ReestablishQueue::default();
        let kid = unique_kid("durable-import");
        queue.note_unknown(&kid);
        let svc = PublicPrivacy::with_parts(keys.clone(), queue.clone());
        let request = || {
            Request::new(pb::ImportKeysRequest {
                keys: vec![pb::ImportableKey {
                    kid: kid.as_bytes().to_vec(),
                    key: Some(pb::importable_key::Key::ClearKey(keypb::ClearKey {
                        kid: kid.as_bytes().to_vec(),
                        level: keypb::Level::Unspecified as i32,
                        algo: keypb::Algo::Unspecified as i32,
                        ops: Vec::new(),
                        jca_encoded: vec![0x42; AES_KEY_LEN],
                        jca_algo: "AES".to_owned(),
                    })),
                    attrs: None,
                }],
            })
        };

        keys.fail_next_persistence_at(PersistenceFault::Write);
        let error = svc
            .import_keys(request())
            .await
            .expect_err("a failed snapshot write must fail the RPC");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        assert!(!keys.holds(&kid).expect("inspect failed import"));
        assert!(
            queue.delete_kids().contains(&kid.as_bytes().to_vec()),
            "the repair must remain pending until the key is durable"
        );

        let retried = svc
            .import_keys(request())
            .await
            .expect("the unchanged request is safe to retry")
            .into_inner();
        assert_eq!(
            retried.results[0].status,
            commonpb::KeyState::KeyImported as i32
        );
        assert!(keys.holds(&kid).expect("inspect imported key"));
        assert!(!queue.delete_kids().contains(&kid.as_bytes().to_vec()));
        assert!(
            KeyMaterial::at_path(snapshot.path())
                .holds(&kid)
                .expect("inspect restarted import")
        );
    }

    #[tokio::test]
    async fn import_waits_for_authoritative_directory_publication_before_ack_or_repair() {
        use crate::keydirectory::{DirectoryFault, KeyDirectory};

        let keys: SharedKeyMaterial = Default::default();
        let queue = ReestablishQueue::default();
        let kid = unique_kid("directory-import-retry");
        queue.note_unknown(&kid);
        let directory = Arc::new(KeyDirectory::in_memory());
        directory.fail_next(DirectoryFault::Put);
        let svc = PublicPrivacy::with_parts(keys.clone(), queue.clone())
            .with_key_directory(directory.clone());

        let error = svc
            .import_keys(clear_import_request(&kid, 0x33))
            .await
            .expect_err("failed directory publication must fail ImportKeys");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        assert!(!keys.holds(&kid).expect("inspect local key"));
        assert!(
            directory
                .get(&kid)
                .await
                .expect("inspect directory")
                .is_none()
        );
        assert!(
            queue.delete_kids().contains(&kid.as_bytes().to_vec()),
            "repair remains pending until every durable publication succeeds"
        );

        let retry = svc
            .import_keys(clear_import_request(&kid, 0x33))
            .await
            .expect("idempotent retry")
            .into_inner();
        assert_eq!(
            retry.results[0].status,
            commonpb::KeyState::KeyImported as i32
        );
        assert!(
            !keys.holds(&kid).expect("local key remains absent"),
            "directory-backed imports must not recreate the retired local authority"
        );
        assert_eq!(
            directory.get(&kid).await.expect("inspect directory"),
            Some([0x33; AES_KEY_LEN])
        );
        assert!(!queue.delete_kids().contains(&kid.as_bytes().to_vec()));
    }

    #[tokio::test]
    async fn import_recovers_when_the_authority_committed_but_the_ack_was_lost() {
        use crate::keydirectory::{DirectoryFault, KeyDirectory};

        let keys: SharedKeyMaterial = Default::default();
        let queue = ReestablishQueue::default();
        let kid = unique_kid("directory-import-post-commit");
        queue.note_unknown(&kid);
        let directory = Arc::new(KeyDirectory::in_memory());
        directory.fail_next(DirectoryFault::PutAfterCommit);
        let svc = PublicPrivacy::with_parts(keys.clone(), queue.clone())
            .with_key_directory(directory.clone());

        let error = svc
            .import_keys(clear_import_request(&kid, 0x43))
            .await
            .expect_err("a lost commit acknowledgement must not ACK ImportKeys");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        assert_eq!(
            directory.get(&kid).await.expect("authoritative lookup"),
            Some([0x43; AES_KEY_LEN]),
            "the authority may have committed even though the caller saw an error"
        );
        assert!(queue.delete_kids().contains(&kid.as_bytes().to_vec()));

        let retry = svc
            .import_keys(clear_import_request(&kid, 0x43))
            .await
            .expect("idempotent UPSERT retry")
            .into_inner();
        assert_eq!(
            retry.results[0].status,
            commonpb::KeyState::KeyImported as i32
        );
        assert!(!queue.delete_kids().contains(&kid.as_bytes().to_vec()));
        assert!(
            !keys
                .holds(&kid)
                .expect("retired local authority stays empty")
        );
    }

    #[tokio::test]
    async fn request_keys_uses_the_authority_and_never_collapses_lookup_failure_to_not_found() {
        use crate::keydirectory::{DirectoryFault, KeyDirectory};

        let kid = unique_kid("request-authority");
        let directory = Arc::new(KeyDirectory::in_memory());
        directory
            .put(&kid, [0x44; AES_KEY_LEN])
            .await
            .expect("seed authority");
        let local: SharedKeyMaterial = Default::default();
        let svc =
            PublicPrivacy::with_key_material(local.clone()).with_key_directory(directory.clone());
        let request = || {
            Request::new(pb::RequestKeysRequest {
                kids: vec![kid.as_bytes().to_vec()],
            })
        };

        let held = svc
            .request_keys(request())
            .await
            .expect("authoritative read")
            .into_inner();
        assert_eq!(held.keys[0].status, commonpb::KeyState::KeyExists as i32);
        assert!(!local.holds(&kid).expect("local authority remains empty"));

        directory.fail_next(DirectoryFault::Get);
        let unavailable = svc
            .request_keys(request())
            .await
            .expect_err("lookup failure is not KEY_NOT_FOUND");
        assert_eq!(unavailable.code(), tonic::Code::Unavailable);
    }

    #[tokio::test]
    async fn remove_waits_for_directory_and_removes_stale_directory_only_rows() {
        use crate::keydirectory::{DirectoryFault, KeyDirectory};

        let keys: SharedKeyMaterial = Default::default();
        let kid = unique_kid("directory-remove-retry");
        let directory = Arc::new(KeyDirectory::in_memory());
        directory
            .put(&kid, [0x55; AES_KEY_LEN])
            .await
            .expect("seed directory key");
        directory.fail_next(DirectoryFault::Remove);
        let svc =
            PublicPrivacy::with_key_material(keys.clone()).with_key_directory(directory.clone());
        let request = || {
            Request::new(pb::RemoveKeysRequest {
                kids: vec![kid.as_bytes().to_vec()],
                deleted: true,
            })
        };

        let error = svc
            .remove_keys(request())
            .await
            .expect_err("directory failure must fail RemoveKeys");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        assert!(
            directory
                .get(&kid)
                .await
                .expect("inspect directory")
                .is_some()
        );

        let retry = svc
            .remove_keys(request())
            .await
            .expect("retry removal")
            .into_inner();
        assert_eq!(
            retry.results[0].status,
            commonpb::KeyState::KeyRemoved as i32
        );
        assert!(!keys.holds(&kid).expect("local authority stays unused"));
        assert!(
            directory
                .get(&kid)
                .await
                .expect("inspect directory")
                .is_none()
        );

        let stale = unique_kid("stale-directory-only");
        directory
            .put(&stale, [0x66; AES_KEY_LEN])
            .await
            .expect("seed stale row");
        let removed = svc
            .remove_keys(Request::new(pb::RemoveKeysRequest {
                kids: vec![stale.as_bytes().to_vec()],
                deleted: true,
            }))
            .await
            .expect("remove stale directory row")
            .into_inner();
        assert_eq!(
            removed.results[0].status,
            commonpb::KeyState::KeyRemoved as i32
        );
        assert!(
            directory
                .get(&stale)
                .await
                .expect("inspect directory")
                .is_none()
        );
    }

    #[tokio::test]
    async fn remove_recovers_when_the_authority_committed_but_the_ack_was_lost() {
        use crate::keydirectory::{DirectoryFault, KeyDirectory};

        let kid = unique_kid("directory-remove-post-commit");
        let directory = Arc::new(KeyDirectory::in_memory());
        directory
            .put(&kid, [0x65; AES_KEY_LEN])
            .await
            .expect("seed authority");
        directory.fail_next(DirectoryFault::RemoveAfterCommit);
        let svc = PublicPrivacy::with_key_material(Default::default())
            .with_key_directory(directory.clone());
        let request = || {
            Request::new(pb::RemoveKeysRequest {
                kids: vec![kid.as_bytes().to_vec()],
                deleted: true,
            })
        };

        let unavailable = svc
            .remove_keys(request())
            .await
            .expect_err("a lost commit acknowledgement must not ACK RemoveKeys");
        assert_eq!(unavailable.code(), tonic::Code::Unavailable);
        assert!(
            directory
                .get(&kid)
                .await
                .expect("authoritative lookup")
                .is_none()
        );

        let retry = svc
            .remove_keys(request())
            .await
            .expect("idempotent retry")
            .into_inner();
        assert_eq!(
            retry.results[0].status,
            commonpb::KeyState::KeyNotFound as i32,
            "the retry observes the already-committed revocation"
        );
    }

    #[tokio::test]
    async fn remove_keys_does_not_acknowledge_a_failed_snapshot_rename() {
        use crate::keymaterial::{KeyMaterial, PersistenceFault};

        let snapshot = TestSnapshot::new("rpc-remove-rename-failure");
        let keys = Arc::new(KeyMaterial::at_path(snapshot.path()));
        let kid = unique_kid("durable-remove");
        keys.insert(kid.clone(), [0x24; AES_KEY_LEN])
            .expect("persist baseline key");
        let svc = PublicPrivacy::with_key_material(keys.clone());
        let request = || {
            Request::new(pb::RemoveKeysRequest {
                kids: vec![kid.as_bytes().to_vec()],
                deleted: true,
            })
        };

        keys.fail_next_persistence_at(PersistenceFault::Rename);
        let error = svc
            .remove_keys(request())
            .await
            .expect_err("a failed snapshot rename must fail the RPC");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        assert!(keys.holds(&kid).expect("inspect failed removal"));
        assert!(
            KeyMaterial::at_path(snapshot.path())
                .holds(&kid)
                .expect("inspect restarted failed removal")
        );

        let retried = svc
            .remove_keys(request())
            .await
            .expect("the unchanged request is safe to retry")
            .into_inner();
        assert_eq!(
            retried.results[0].status,
            commonpb::KeyState::KeyRemoved as i32
        );
        assert!(!keys.holds(&kid).expect("inspect removed key"));
        assert!(
            !KeyMaterial::at_path(snapshot.path())
                .holds(&kid)
                .expect("inspect restarted removal")
        );
    }

    #[tokio::test]
    async fn request_and_update_keys_fail_precondition_on_an_unreadable_snapshot() {
        use crate::keymaterial::KeyMaterial;

        let snapshot = TestSnapshot::new("rpc-unreadable-status");
        snapshot.write_snapshot(b"{ not a key snapshot");
        let svc = PublicPrivacy::with_key_material(Arc::new(KeyMaterial::at_path(snapshot.path())));
        let kid = unique_kid("unreadable-status");

        let requested = svc
            .request_keys(Request::new(pb::RequestKeysRequest {
                kids: vec![kid.as_bytes().to_vec()],
            }))
            .await
            .expect_err("unreadable state is not KEY_NOT_FOUND");
        assert_eq!(requested.code(), tonic::Code::FailedPrecondition);

        let updated = svc
            .update_keys(Request::new(pb::UpdateKeysRequest {
                updates: vec![pb::ClientKeyUpdate {
                    kid: kid.as_bytes().to_vec(),
                    client_attrs: None,
                }],
            }))
            .await
            .expect_err("unreadable state is not an absent update target");
        assert_eq!(updated.code(), tonic::Code::FailedPrecondition);
        assert_eq!(
            std::fs::read(snapshot.path()).expect("snapshot remains"),
            b"{ not a key snapshot"
        );
    }

    #[tokio::test]
    async fn request_keys_returns_unavailable_until_restored_directory_sync_succeeds() {
        use crate::keymaterial::{KeyMaterial, PersistenceFault};

        let snapshot = TestSnapshot::new("rpc-restored-sync-status");
        let kid = unique_kid("restored-sync-status");
        {
            let first = KeyMaterial::at_path(snapshot.path());
            first
                .insert(kid.clone(), [0x71; AES_KEY_LEN])
                .expect("seed durable key");
        }
        let keys = Arc::new(KeyMaterial::at_path_with_initial_fault(
            snapshot.path(),
            PersistenceFault::DirectorySync,
        ));
        keys.fail_next_persistence_at(PersistenceFault::DirectorySync);
        let svc = PublicPrivacy::with_key_material(keys);
        let request = || {
            Request::new(pb::RequestKeysRequest {
                kids: vec![kid.as_bytes().to_vec()],
            })
        };

        let unavailable = svc
            .request_keys(request())
            .await
            .expect_err("unconfirmed restored state must not answer KEY_NOT_FOUND");
        assert_eq!(unavailable.code(), tonic::Code::Unavailable);

        let confirmed = svc
            .request_keys(request())
            .await
            .expect("retry confirms directory durability")
            .into_inner();
        assert_eq!(
            confirmed.keys[0].status,
            commonpb::KeyState::KeyExists as i32
        );
    }

    /// The single point the whole re-establishment repair turns on.
    ///
    /// After `delete_kids`, the device has destroyed its local key but still holds
    /// the same cached kid, and asks for it here. An EMPTY `keys` list does not
    /// read as "not found" — `SynchronousPrivacyKeyManager.downloadKey` throws
    /// `UnexpectedRemoteException`, `generateKey` dies with
    /// `EphemeralInternalException`, and the device never reaches
    /// `createKey`/`importKey`/`uploadKey`. The channel is then dead with no path
    /// back, and we would have caused it: the delete succeeded, the recreate
    /// cannot. Only an `ExportableKey` for that kid with `KEY_NOT_FOUND` and no
    /// key bytes lets the device rebuild.
    #[tokio::test]
    async fn an_unheld_kid_is_reported_not_found_rather_than_omitted() {
        let svc = PublicPrivacy::default();
        let kid = unique_kid("request-keys");

        let response = svc
            .request_keys(Request::new(pb::RequestKeysRequest {
                kids: vec![kid.as_bytes().to_vec()],
            }))
            .await
            .expect("request_keys answers")
            .into_inner();

        assert_eq!(
            response.keys.len(),
            1,
            "an empty list wedges the device: downloadKey throws instead of \
             letting generateKey rebuild the channel",
        );
        let exported = &response.keys[0];
        assert_eq!(
            exported.kid,
            kid.as_bytes(),
            "the answer must name the kid asked for"
        );
        assert_eq!(
            exported.status,
            cosmos_protocol::privacy::grpc::common::KeyState::KeyNotFound as i32,
            "only KEY_NOT_FOUND sends the device down the create-and-upload path",
        );
        assert!(
            exported.key.is_none(),
            "we hold no key; shipping one would be fabricated key material",
        );
    }

    // -----------------------------------------------------------------------
    // Principal scoping
    // -----------------------------------------------------------------------

    /// The user id a real Pin's DeviceUser certificate names, and the one its
    /// kids encode in `u=`.
    const WEARER: &str = "ca221c10-de71-4ce0-8b1d-000000000001";
    const OTHER_WEARER: &str = "ca221c10-de71-4ce0-8b1d-000000000002";

    /// A kid in the shape a real device mints once it is bound: `u=` carries the
    /// DeviceUser id (`CoreSecureChannelFactory.constructCreds:53` →
    /// `CoreKeyIdCodec.generateKeyId:19`).
    fn kid_owned_by(user_id: &str, tag: &str) -> String {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!(
            "d=;u={user_id};s=ai_bus.{tag};a=;{:x};{:x}",
            n,
            std::process::id()
        )
    }

    /// A kid in the shape Center mints: `<principal>/center/ephemeral`
    /// (`center/src/server/channel.ts` `kidFor`), over the collapsed principal
    /// the BFF sends as `x-forwarded-client-cert: U:<sub>`.
    fn center_kid_owned_by(user_id: &str) -> String {
        format!("U:{user_id}/center/ephemeral")
    }

    /// Attach the principal the edge produces for a bound Pin.
    ///
    /// Through `from_device_cn`, NOT `from_edge`: `AuthLayer` (`config.rs`) runs
    /// every subject through it, and it collapses a DeviceUser CN onto `U:<user>`.
    /// Injecting the raw pre-collapse CN is what let the scoping tests pass over
    /// a gate that could never fire in production — the helper has to produce the
    /// value production carries, or it is testing a shape nothing sends.
    fn as_wearer<T>(mut request: Request<T>, user_id: &str) -> Request<T> {
        request.extensions_mut().insert(
            cosmos_core::AuthenticatedPrincipal::from_device_cn(&format!(
                "V:01:D:2c2a00010000abcd:U:{user_id}"
            ))
            .expect("valid principal"),
        );
        request
    }

    /// Observed: a fresh owned Pin receives these six values from the privacy
    /// all-sync. Returning no rows leaves the stock key upload view with no
    /// setting side of its configuration join.
    #[tokio::test]
    async fn unconfigured_wearer_gets_the_observed_default_settings() {
        let response = PublicPrivacy::default()
            .get_settings(as_wearer(
                Request::new(pb::GetSettingsRequest::default()),
                WEARER,
            ))
            .await
            .expect("default settings sync succeeds")
            .into_inner();

        assert_eq!(response.settings.len(), DEFAULT_PRIVACY_SETTINGS.len());
        assert!(
            response
                .settings
                .iter()
                .all(|setting| { setting.status == commonpb::SettingState::SettingSuccess as i32 })
        );
        let actual: BTreeSet<_> = response
            .settings
            .iter()
            .map(|setting| (setting.name.as_str(), setting.value.as_str()))
            .collect();
        let expected: BTreeSet<_> = DEFAULT_PRIVACY_SETTINGS.into_iter().collect();
        assert_eq!(actual, expected);
    }

    /// Observed: the stock service advertises this complete 24-row manager
    /// catalog. Implemented: the clone uses a fixed non-null timestamp as an
    /// opaque catalog version and returns the full snapshot for every request.
    #[tokio::test]
    async fn configuration_is_the_observed_full_stable_snapshot() {
        let service = PublicPrivacy::default();
        let first = service
            .get_configuration(Request::new(pb::GetConfigurationRequest::default()))
            .await
            .expect("configuration sync succeeds")
            .into_inner();

        assert_eq!(
            first.updated_ts,
            Some(prost_types::Timestamp {
                seconds: PRIVACY_CONFIGURATION_UPDATED_SECONDS,
                nanos: 0,
            })
        );
        assert_eq!(first.configs.len(), PRIVACY_CONFIGURATION.len());
        assert!(
            first
                .configs
                .iter()
                .all(|config| config.value == "on" && config.labels.is_empty())
        );
        let actual: BTreeSet<_> = first
            .configs
            .iter()
            .map(|config| (config.name.as_str(), config.manager.as_str()))
            .collect();
        let expected: BTreeSet<_> = PRIVACY_CONFIGURATION.into_iter().collect();
        assert_eq!(actual, expected);

        let second = service
            .get_configuration(Request::new(pb::GetConfigurationRequest {
                since_ts: first.updated_ts,
            }))
            .await
            .expect("configuration resync succeeds")
            .into_inner();
        assert_eq!(
            second, first,
            "the catalog version and snapshot must be stable"
        );
    }

    /// Derived from the stock uploadable-key predicate: a key manager may upload
    /// when at least one of its configuration rows matches the current setting;
    /// an empty label list does not restrict a client key's labels. This is the
    /// regression for NotableEvents' `eventdata` key being filtered out before it
    /// could reach ImportKeys.
    #[tokio::test]
    async fn default_catalog_makes_notableevents_eventdata_uploadable() {
        let service = PublicPrivacy::default();
        let settings = service
            .get_settings(as_wearer(
                Request::new(pb::GetSettingsRequest::default()),
                WEARER,
            ))
            .await
            .expect("settings sync succeeds")
            .into_inner();
        let configuration = service
            .get_configuration(Request::new(pb::GetConfigurationRequest::default()))
            .await
            .expect("configuration sync succeeds")
            .into_inner();

        let client_labels = ["eventdata"];
        let matching_gates: BTreeSet<_> = configuration
            .configs
            .iter()
            .filter(|config| {
                config.manager == "notableevents"
                    && (config.labels.is_empty()
                        || config
                            .labels
                            .iter()
                            .all(|label| client_labels.contains(&label.as_str())))
                    && settings.settings.iter().any(|setting| {
                        setting.name == config.name
                            && setting.value == config.value
                            && setting.status == commonpb::SettingState::SettingSuccess as i32
                    })
            })
            .map(|config| config.name.as_str())
            .collect();

        assert!(
            matching_gates.contains("location") && matching_gates.contains("v1p0_defaults"),
            "the stock predicate must find an enabled gate for notableevents/eventdata"
        );
        assert!(
            !matching_gates.contains("save_event_location"),
            "the observed off default must remain off even though other gates allow upload"
        );
    }

    /// The stock all-sync treats the server response as authoritative and trims
    /// every local name missing from it. This round trip therefore proves more
    /// than a normal CRUD test: an empty or lossy response would erase the
    /// wearer's device-local privacy choices at the next 30-minute sync.
    #[tokio::test]
    async fn privacy_settings_survive_sync_restart_and_stay_principal_scoped() {
        let store: crate::store::SharedStore = Arc::new(crate::store::MemoryStore::default());
        let service =
            PublicPrivacy::with_key_material(Default::default()).with_store(store.clone());

        let updated = service
            .update_settings(as_wearer(
                Request::new(pb::UpdateSettingsRequest {
                    settings: vec![
                        commonpb::PrivacySetting {
                            name: "save_event_location".to_owned(),
                            value: "on".to_owned(),
                        },
                        commonpb::PrivacySetting {
                            name: "share_diagnostics".to_owned(),
                            value: "off".to_owned(),
                        },
                    ],
                }),
                WEARER,
            ))
            .await
            .expect("privacy update succeeds")
            .into_inner();
        assert_eq!(updated.results.len(), 2);
        assert_eq!(
            updated.results[0].status,
            commonpb::SettingState::SettingUpdated as i32,
            "save_event_location already exists in the default snapshot"
        );
        assert_eq!(
            updated.results[1].status,
            commonpb::SettingState::SettingSuccess as i32,
            "a new custom setting is created"
        );

        // A new service instance is the server-restart boundary. It sees the
        // same durable store and must return the complete authoritative set.
        let restarted =
            PublicPrivacy::with_key_material(Default::default()).with_store(store.clone());
        let all = restarted
            .get_settings(as_wearer(
                Request::new(pb::GetSettingsRequest::default()),
                WEARER,
            ))
            .await
            .expect("all-sync succeeds")
            .into_inner();
        assert_eq!(
            all.settings.len(),
            DEFAULT_PRIVACY_SETTINGS.len() + 1,
            "all-sync must preserve every default plus the saved custom name"
        );
        assert!(
            all.settings
                .iter()
                .any(|setting| { setting.name == "save_event_location" && setting.value == "on" })
        );

        let filtered = restarted
            .get_settings(as_wearer(
                Request::new(pb::GetSettingsRequest {
                    names: vec!["save_event_location".to_owned()],
                }),
                WEARER,
            ))
            .await
            .expect("named sync succeeds")
            .into_inner();
        assert_eq!(filtered.settings.len(), 1);
        assert_eq!(filtered.settings[0].name, "save_event_location");

        let other = restarted
            .get_settings(as_wearer(
                Request::new(pb::GetSettingsRequest::default()),
                OTHER_WEARER,
            ))
            .await
            .expect("an unconfigured account receives defaults")
            .into_inner();
        assert_eq!(
            other.settings.len(),
            DEFAULT_PRIVACY_SETTINGS.len(),
            "the other principal gets defaults but not the wearer's custom setting"
        );
        assert!(
            other
                .settings
                .iter()
                .any(|setting| { setting.name == "save_event_location" && setting.value == "off" }),
            "the wearer's override must not cross principals"
        );
        assert!(
            !other
                .settings
                .iter()
                .any(|setting| setting.name == "share_diagnostics"),
            "the wearer's custom setting must not cross principals"
        );
    }

    /// The gap this closes: `ImportKeys` took a kid straight off the wire and
    /// overwrote whatever key was stored under it. Any enrolled device could
    /// therefore replace another wearer's channel key, after which every envelope
    /// that Pin sealed failed to open — and the device swallows that into a null
    /// return with no recovery path (`EphemeralProtectionManager.encrypt:88`).
    #[tokio::test]
    async fn import_keys_refuses_a_kid_that_belongs_to_another_wearer() {
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        let victim_kid = kid_owned_by(WEARER, "victim");
        let victim_key = [0x11u8; AES_KEY_LEN];
        keys.insert(victim_kid.clone(), victim_key)
            .expect("insert victim test key");
        let svc = PublicPrivacy::with_key_material(keys.clone()).with_kid_scope(KidScope::Enforce);

        let hostile = pb::ImportableKey {
            kid: victim_kid.as_bytes().to_vec(),
            key: Some(pb::importable_key::Key::ClearKey(keypb::ClearKey {
                kid: victim_kid.as_bytes().to_vec(),
                level: keypb::Level::Unspecified as i32,
                algo: keypb::Algo::Unspecified as i32,
                ops: Vec::new(),
                jca_encoded: vec![0x99u8; AES_KEY_LEN],
                jca_algo: "AES".to_owned(),
            })),
            attrs: None,
        };

        let refused = svc
            .import_keys(as_wearer(
                Request::new(pb::ImportKeysRequest {
                    keys: vec![hostile.clone()],
                }),
                OTHER_WEARER,
            ))
            .await
            .expect_err("a device must not import under another wearer's kid");
        assert_eq!(refused.code(), tonic::Code::PermissionDenied);

        // The OBSERVABLE outcome, not the status: the victim's channel still
        // opens what their Pin sealed. A refusal that had already clobbered the
        // key would leave the wearer just as broken.
        let from_victim_pin =
            cosmos_crypto::seal(&victim_kid, &victim_key, b"what time is it", b"")
                .expect("seal under the established channel");
        assert_eq!(
            keys.open(&from_victim_pin)
                .expect("the victim's channel must still be intact"),
            b"what time is it",
        );

        // ...and the owner is not locked out of their own key, so the assertion
        // above pins the scoping rather than a blanket refusal.
        let allowed = svc
            .import_keys(as_wearer(
                Request::new(pb::ImportKeysRequest {
                    keys: vec![hostile],
                }),
                WEARER,
            ))
            .await
            .expect("the wearer who owns the kid may re-import it");
        assert_eq!(
            allowed.into_inner().results[0].status,
            commonpb::KeyState::KeyImported as i32
        );
    }

    /// The same refusal for the OTHER producer. Center derives its kid from its
    /// own principal (`channel.ts` `kidFor`), and that kid names the wearer just
    /// as plainly as a krypton `u=` does — a gate that only understands the
    /// krypton codec leaves the browser plane completely unscoped.
    #[tokio::test]
    async fn import_keys_refuses_a_center_kid_that_belongs_to_another_wearer() {
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        let victim_kid = center_kid_owned_by(WEARER);
        let victim_key = [0x21u8; AES_KEY_LEN];
        keys.insert(victim_kid.clone(), victim_key)
            .expect("insert victim test key");
        let svc = PublicPrivacy::with_key_material(keys.clone()).with_kid_scope(KidScope::Enforce);

        let hostile = pb::ImportableKey {
            kid: victim_kid.as_bytes().to_vec(),
            key: Some(pb::importable_key::Key::ClearKey(keypb::ClearKey {
                kid: victim_kid.as_bytes().to_vec(),
                level: keypb::Level::Unspecified as i32,
                algo: keypb::Algo::Unspecified as i32,
                ops: Vec::new(),
                jca_encoded: vec![0x88u8; AES_KEY_LEN],
                jca_algo: "AES".to_owned(),
            })),
            attrs: None,
        };

        let refused = svc
            .import_keys(as_wearer(
                Request::new(pb::ImportKeysRequest {
                    keys: vec![hostile],
                }),
                OTHER_WEARER,
            ))
            .await
            .expect_err("a caller must not import under another wearer's Center kid");
        assert_eq!(refused.code(), tonic::Code::PermissionDenied);

        // Observable outcome again: the victim's Center channel still opens.
        let sealed = cosmos_crypto::seal(&victim_kid, &victim_key, b"note body", b"")
            .expect("seal under the established channel");
        assert_eq!(
            keys.open(&sealed)
                .expect("the victim's Center channel must still be intact"),
            b"note body",
        );
    }

    /// The explicit compatibility mode this deployment uses during migration,
    /// pinned so it cannot drift into either direction silently.
    ///
    /// `audit` PERMITS the foreign kid — that is the point: this server holds 352
    /// channel keys minted under the wearer's own retired, pre-clone user id, and
    /// refusing them would strand the wearer's Pin on the one RPC
    /// (`RequestKeys`) whose refusal the client cannot recover from. What audit
    /// must never be is silent, so the same call is required to have produced a
    /// report — see `report_foreign_kid`, which is unconditional.
    #[tokio::test]
    async fn explicit_audit_mode_permits_a_foreign_kid_and_counts_it() {
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        let victim_kid = kid_owned_by(WEARER, "retired-identity");
        keys.insert(victim_kid.clone(), [0x31u8; AES_KEY_LEN])
            .expect("insert victim test key");
        let svc = PublicPrivacy::with_key_material(keys).with_kid_scope(KidScope::Audit);

        let before = foreign_kid_metric_total();
        let permitted = svc
            .import_keys(as_wearer(
                Request::new(pb::ImportKeysRequest {
                    keys: vec![pb::ImportableKey {
                        kid: victim_kid.as_bytes().to_vec(),
                        key: Some(pb::importable_key::Key::ClearKey(keypb::ClearKey {
                            kid: victim_kid.as_bytes().to_vec(),
                            level: keypb::Level::Unspecified as i32,
                            algo: keypb::Algo::Unspecified as i32,
                            ops: Vec::new(),
                            jca_encoded: vec![0x77u8; AES_KEY_LEN],
                            jca_algo: "AES".to_owned(),
                        })),
                        attrs: None,
                    }],
                }),
                OTHER_WEARER,
            ))
            .await
            .expect("audit mode reports and permits");
        assert_eq!(
            permitted.into_inner().results[0].status,
            commonpb::KeyState::KeyImported as i32,
            "audit must not change the answer, only observe it"
        );
        assert!(
            foreign_kid_metric_total() > before,
            "a permitted foreign kid that is not counted is the no-op this gate used to be"
        );
    }

    /// Sum of every `cosmos_kid_scope_foreign_total` series in the process-wide
    /// registry. Read out of the exposition text because that is the surface an
    /// operator actually sees; a count that never reaches it is not a report.
    fn foreign_kid_metric_total() -> u64 {
        crate::metrics::render()
            .lines()
            .filter(|line| line.starts_with("cosmos_kid_scope_foreign_total"))
            .filter_map(|line| line.rsplit(' ').next()?.parse::<f64>().ok())
            .map(|value| value as u64)
            .sum()
    }

    /// The gap this closes: `SyncKeys` handed the process-global stranded-kid
    /// queue to every caller. A kid is not opaque — it carries `u=<userId>` in
    /// cleartext (`CoreKeyIdCodec.generateKeyId:19`) — so that was a list of
    /// other wearers' identifiers served to every device on the deployment.
    #[tokio::test]
    async fn sync_keys_withholds_kids_that_name_another_wearer() {
        let queue = ReestablishQueue::default();
        let mine = kid_owned_by(WEARER, "mine");
        let theirs = kid_owned_by(OTHER_WEARER, "theirs");
        // An unattributable kid: the shape a channel established before login
        // produces. It names nobody, so it must keep flowing or the repair path
        // breaks for pre-login channels.
        let unattributed = unique_kid("unattributed");
        queue.note_unknown(&mine);
        queue.note_unknown(&theirs);
        queue.note_unknown(&unattributed);

        let svc =
            PublicPrivacy::with_parts(Default::default(), queue).with_kid_scope(KidScope::Enforce);
        let sync = svc
            .sync_keys(as_wearer(Request::new(pb::SyncKeysRequest {}), WEARER))
            .await
            .expect("sync_keys answers")
            .into_inner();

        assert!(
            sync.deletekids.contains(&mine.as_bytes().to_vec()),
            "a wearer must still be told to re-establish their own stranded kid"
        );
        assert!(
            sync.deletekids.contains(&unattributed.as_bytes().to_vec()),
            "a kid that names nobody must keep flowing, or pre-login channels never repair"
        );
        assert!(
            !sync.deletekids.contains(&theirs.as_bytes().to_vec()),
            "another wearer's kid is their identifier in cleartext and must never be served"
        );
    }

    /// The repair path the module doc is built around must survive the scoping.
    /// An unheld kid the caller owns still comes back `KEY_NOT_FOUND` — the one
    /// answer that makes the device rebuild — while another wearer's kid stops
    /// being an existence oracle.
    #[tokio::test]
    async fn request_keys_still_repairs_the_callers_own_kid_but_not_a_strangers() {
        let svc = PublicPrivacy::default().with_kid_scope(KidScope::Enforce);
        let mine = kid_owned_by(WEARER, "repair");

        let response = svc
            .request_keys(as_wearer(
                Request::new(pb::RequestKeysRequest {
                    kids: vec![mine.as_bytes().to_vec()],
                }),
                WEARER,
            ))
            .await
            .expect("the caller's own kid is answered")
            .into_inner();
        assert_eq!(
            response.keys[0].status,
            commonpb::KeyState::KeyNotFound as i32,
            "an empty or refused answer here wedges the device permanently",
        );

        let refused = svc
            .request_keys(as_wearer(
                Request::new(pb::RequestKeysRequest {
                    kids: vec![kid_owned_by(OTHER_WEARER, "probe").as_bytes().to_vec()],
                }),
                WEARER,
            ))
            .await
            .expect_err("probing another wearer's kid must not be answered");
        assert_eq!(refused.code(), tonic::Code::PermissionDenied);
    }

    /// The half that made the whole gate inert: `caller_user_id` parsed the raw
    /// pre-collapse CN, which `AuthLayer` never hands anyone. Every principal in
    /// production comes out of `from_device_cn`/`for_user` already collapsed to
    /// `U:<user>`, so the parser answered `None` for every real caller and
    /// `kid_is_actionable` permitted everything.
    ///
    /// This pins the VALUE PRODUCTION CARRIES, not a shape convenient to test:
    /// it builds the principal the same way `config.rs` does.
    #[test]
    fn the_caller_parser_reads_the_principal_authlayer_actually_produces() {
        let collapsed = cosmos_core::AuthenticatedPrincipal::from_device_cn(
            "V:01:D:2c2a00010000abcd:U:wearer-1",
        )
        .expect("a real DeviceUser CN authenticates");
        assert_eq!(collapsed.expose_for_authorization(), "U:wearer-1");
        assert_eq!(
            principal_user_id(collapsed.expose_for_authorization()),
            Some("wearer-1"),
            "the collapsed principal is the only shape a real caller has"
        );

        // The web front door resolves to the same principal for the same person.
        let web = cosmos_core::AuthenticatedPrincipal::for_user("wearer-1").expect("a web sub");
        assert_eq!(
            principal_user_id(web.expose_for_authorization()),
            Some("wearer-1")
        );

        // An un-collapsed CN still parses, so a principal injected by any other
        // path is not silently unattributable.
        assert_eq!(
            principal_user_id("V:01:D:2c2a00010000abcd:U:wearer-1"),
            Some("wearer-1")
        );

        // Names no user: an attestation subject, a service identity, junk.
        assert_eq!(
            principal_user_id("V:01:D:2c2a0001dead0001:P:00000001"),
            None
        );
        assert_eq!(principal_user_id("development-insecure-principal"), None);
        assert_eq!(principal_user_id("U:"), None);
        assert_eq!(principal_user_id(""), None);
    }

    /// The other half: Center's kid is `<principal>/center/ephemeral`, which
    /// carries no `d=` and no `;`, so the krypton parser called it unattributable
    /// and the gate permitted every Center kid too. Both the current collapsed
    /// shape and the pre-collapse rows still present in the live key table must
    /// resolve, or the gate is half-blind against the surface that reaches it
    /// most often.
    #[test]
    fn a_center_kid_is_attributed_to_the_principal_it_is_derived_from() {
        assert_eq!(
            kid_user_id("U:ca221c10-de71-4ce0-8b1d-000000000001/center/ephemeral"),
            Some("ca221c10-de71-4ce0-8b1d-000000000001")
        );
        // The pre-collapse shape Center used to derive, still stored live.
        assert_eq!(
            kid_user_id("V:01:D:web-demo:U:ca221c10-de71-4ce0-8b1d-000000000001/center/ephemeral"),
            Some("ca221c10-de71-4ce0-8b1d-000000000001")
        );
        // A krypton kid with an empty `u=` must stay unattributable rather than
        // falling through to the principal parse.
        assert_eq!(kid_user_id("d=;u=;s=;a=;68af;3f2a"), None);
    }

    /// The parser the whole gate rests on. `u=` is the only attributable field:
    /// `d=` is always empty on a real ephemeral kid, because
    /// `CoreSecureChannelFactory.constructCreds:53` passes a null device id.
    #[test]
    fn kid_ownership_is_read_only_from_a_populated_user_field() {
        assert_eq!(
            kid_user_id("d=;u=ca221c10;s=ai_bus.synapse;a=;68af;3f2a"),
            Some("ca221c10")
        );
        // Unattributable: no user named.
        assert_eq!(kid_user_id("d=;u=;s=ai_bus.synapse;a=;68af;3f2a"), None);
        // Not the codec's shape at all.
        assert_eq!(kid_user_id("not-a-kid"), None);
        assert_eq!(kid_user_id(""), None);

        // The gate narrows only when both sides name a user, and they differ.
        assert!(!kid_is_actionable(
            Some("aaa"),
            "d=;u=bbb;s=ai_bus.synapse;a=;68af;3f2a"
        ));
        assert!(kid_is_actionable(
            Some("aaa"),
            "d=;u=aaa;s=ai_bus.synapse;a=;68af;3f2a"
        ));
        assert!(kid_is_actionable(
            Some("aaa"),
            "d=;u=;s=ai_bus.synapse;a=;68af;3f2a"
        ));
        assert!(kid_is_actionable(
            None,
            "d=;u=bbb;s=ai_bus.synapse;a=;68af;3f2a"
        ));
    }

    /// A kid in the shape the device actually mints
    /// (`CoreKeyIdCodec.generateKeyId`: `d=;u=;s=<service>;a=;<hex>;<hex>`),
    /// unique per test so the process-wide queue cannot make two tests collide.
    fn unique_kid(tag: &str) -> String {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("d=;u=;s=ai_bus.{tag};a=;{:x};{:x}", n, std::process::id())
    }

    struct TestSnapshot(std::path::PathBuf);

    impl TestSnapshot {
        fn new(tag: &str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "cosmos-public-privacy-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            std::fs::create_dir_all(&directory).expect("create snapshot scratch directory");
            Self(directory.join("keymaterial.json"))
        }

        fn path(&self) -> std::path::PathBuf {
            self.0.clone()
        }

        fn write_snapshot(&self, bytes: &[u8]) {
            std::fs::write(&self.0, bytes).expect("write snapshot fixture");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600))
                    .expect("protect snapshot fixture");
            }
        }
    }

    impl Drop for TestSnapshot {
        fn drop(&mut self) {
            if let Some(directory) = self.0.parent() {
                let _ = std::fs::remove_dir_all(directory);
            }
        }
    }

    /// End-to-end, through the two real gRPC entry points a stranded Pin hits:
    /// an `Encrypted*` RPC that cannot be opened, then the key-sync pull the
    /// device makes every 30 minutes.
    ///
    /// A device that established its channel before this server persisted key
    /// material keeps sealing under a kid we no longer hold, forever — the kid
    /// lives in `krypto_key_id_cache` and `generateKey` takes the early return
    /// (`KryptoSecureChannelFactory.java:56,147`), and no gRPC status makes it
    /// re-establish. `SyncKeys.delete_kids` is the only lever: it makes the
    /// device delete the local key so the next `generateKey` re-creates and
    /// re-uploads it under the same kid.
    #[tokio::test]
    async fn an_unopenable_kid_comes_back_as_a_sync_keys_delete_until_reimported() {
        use crate::services::aibus_extra::Speech;
        use cosmos_protocol::aibus::speech_service_server::SpeechService;

        let keys: SharedKeyMaterial = Default::default();
        // A healthy channel this server does hold, so the "nothing established
        // at all" precondition does not short-circuit the open path.
        let healthy = unique_kid("healthy");
        keys.insert(healthy.clone(), [3u8; AES_KEY_LEN])
            .expect("insert healthy test key");

        // The stranded device: a real envelope, sealed under a kid the server
        // has no key for.
        let stranded = unique_kid("stranded");
        let device_key = [5u8; AES_KEY_LEN];
        let body = cosmos_protocol::aibus::CanTranslateRequest::default();
        let sealed = cosmos_crypto::seal(
            &stranded,
            &device_key,
            &prost::Message::encode_to_vec(&body),
            b"",
        )
        .unwrap();

        let speech = Speech::with_key_material(keys.clone());
        let err = speech
            .can_translate(Request::new(
                cosmos_protocol::aibus::EncryptedCanTranslateRequest {
                    data: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: sealed.kid.clone(),
                            },
                        ),
                        data: sealed.data,
                    }),
                },
            ))
            .await
            .expect_err("an envelope under an unknown kid cannot be opened");

        // Correctly coded and it names the kid: not an authorization problem.
        assert_eq!(err.code(), tonic::Code::FailedPrecondition, "{err:?}");
        assert!(err.message().contains(&stranded), "{}", err.message());

        // The device's next key sync now carries the stranded kid, UTF-8 encoded
        // exactly as `SimpleKrKeyId(ByteBuffer)` expects.
        let privacy = PublicPrivacy::with_key_material(keys.clone());
        let sync = privacy
            .sync_keys(Request::new(pb::SyncKeysRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(
            sync.deletekids.contains(&stranded.as_bytes().to_vec()),
            "a stranded kid must be returned for deletion so the device re-establishes"
        );
        assert!(
            !sync.deletekids.contains(&healthy.as_bytes().to_vec()),
            "a kid this server can open must never be marked for deletion"
        );

        // The device does what it is told, re-creates the key under the same kid
        // and re-imports it. After that the repair must stop — repeating it would
        // delete the key we were just given.
        let ik = pb::ImportableKey {
            kid: stranded.as_bytes().to_vec(),
            key: Some(pb::importable_key::Key::ClearKey(keypb::ClearKey {
                kid: stranded.as_bytes().to_vec(),
                level: keypb::Level::Unspecified as i32,
                algo: keypb::Algo::Unspecified as i32,
                ops: Vec::new(),
                jca_encoded: device_key.to_vec(),
                jca_algo: "AES".to_owned(),
            })),
            attrs: None,
        };
        let out = privacy
            .import_keys(Request::new(pb::ImportKeysRequest { keys: vec![ik] }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            out.results[0].status,
            commonpb::KeyState::KeyImported as i32
        );

        let after = privacy
            .sync_keys(Request::new(pb::SyncKeysRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(
            !after.deletekids.contains(&stranded.as_bytes().to_vec()),
            "a re-imported kid must stop being marked for deletion"
        );
    }

    /// The dangerous direction. `delete_kids` makes the device destroy a local
    /// key, so a kid this server CAN open must never reach the queue — otherwise
    /// one corrupt envelope would take a healthy channel down for a reboot.
    #[tokio::test]
    async fn a_corrupt_envelope_under_a_known_kid_is_never_queued_for_deletion() {
        use crate::services::aibus_extra::Speech;
        use cosmos_protocol::aibus::speech_service_server::SpeechService;

        let keys: SharedKeyMaterial = Default::default();
        let known = unique_kid("known");
        keys.insert(known.clone(), [1u8; AES_KEY_LEN])
            .expect("insert known test key");

        // Sealed under the right kid but the wrong key: the tag will not verify.
        let sealed = cosmos_crypto::seal(&known, &[2u8; AES_KEY_LEN], b"\x08\x01", b"").unwrap();

        let speech = Speech::with_key_material(keys.clone());
        let err = speech
            .can_translate(Request::new(
                cosmos_protocol::aibus::EncryptedCanTranslateRequest {
                    data: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: sealed.kid.clone(),
                            },
                        ),
                        data: sealed.data,
                    }),
                },
            ))
            .await
            .expect_err("a bad tag cannot be opened");
        assert_eq!(err.code(), tonic::Code::PermissionDenied, "{err:?}");

        let privacy = PublicPrivacy::with_key_material(keys);
        let sync = privacy
            .sync_keys(Request::new(pb::SyncKeysRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(
            !sync.deletekids.contains(&known.as_bytes().to_vec()),
            "a key this server holds must never be sent to the device for deletion"
        );
    }

    /// An envelope with no `encryption_information` names nothing; queueing the
    /// empty kid would put a kid the device cannot decode into `delete_kids`.
    #[test]
    fn an_empty_kid_is_not_queued() {
        let queue = ReestablishQueue::default();
        queue.note_unknown("");
        assert!(queue.delete_kids().is_empty());
    }

    /// `PublicPrivacy` built with an isolated queue reports only that queue —
    /// the sharing in `shared()` is a wiring decision, not a hard-coded global
    /// read inside `sync_keys`.
    #[tokio::test]
    async fn sync_keys_reports_the_queue_it_was_built_with() {
        let queue = ReestablishQueue::default();
        let kid = unique_kid("isolated");
        queue.note_unknown(&kid);
        let svc = PublicPrivacy::with_parts(Default::default(), queue);
        let sync = svc
            .sync_keys(Request::new(pb::SyncKeysRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(sync.deletekids, vec![kid.as_bytes().to_vec()]);
    }

    #[tokio::test]
    async fn wrapping_establish_import_and_seal_round_trip() {
        let svc = PublicPrivacy::with_key_material(Arc::new(
            crate::keymaterial::KeyMaterial::with_test_wrapping_key_generator(),
        ));

        // 1) device establishes wrapping keys -> receives the server RSA pubkey.
        let est = svc
            .establish_wrapping_keys(Request::new(pb::EstablishWrappingKeysRequest::default()))
            .await
            .unwrap()
            .into_inner();
        let clear = est.clear_key.expect("wrapping key present");
        assert_eq!(clear.algo, keypb::Algo::RsaOaep as i32);
        assert!(!clear.jca_encoded.is_empty());

        // 2) device generates an ephemeral AES-128 key, RSA-OAEP-wraps it to the
        //    server pubkey, and uploads it via ImportKeys.
        let kid = "d=;u=;s=ai_bus.synapse;a=;abc;def";
        let aes_key = [7u8; AES_KEY_LEN];
        let wrapped = cosmos_crypto::wrap_channel_key(&clear.jca_encoded, &aes_key).unwrap();
        let ik = pb::ImportableKey {
            kid: kid.as_bytes().to_vec(),
            key: Some(pb::importable_key::Key::WrappedKey(keypb::WrappedKey {
                wrapping_kid: Vec::new(),
                metadata: Vec::new(),
                keydata: wrapped,
                iv: Vec::new(),
                auth_tag: Vec::new(),
            })),
            attrs: None,
        };
        let out = svc
            .import_keys(Request::new(pb::ImportKeysRequest { keys: vec![ik] }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(out.results.len(), 1);
        assert_eq!(
            out.results[0].status,
            commonpb::KeyState::KeyImported as i32
        );

        // 3) the server now holds the unwrapped channel key and can seal/open.
        let store = &svc.keys;
        let sealed = store.seal(kid, b"hello pin", b"").unwrap();
        assert_eq!(store.open(&sealed).unwrap(), b"hello pin");
    }

    /// The whole point of persisting key material: a device that ran the key
    /// exchange before a redeploy keeps talking after it.
    ///
    /// The device establishes once and caches the kid in `krypto_key_id_cache`
    /// (`KryptoSecureChannelFactory.java:147`); `generateKey` (same file:56)
    /// returns the cached key without re-uploading, so there is no second
    /// `ImportKeys` to repair a server that forgot. A restarted server must
    /// therefore publish the same wrapping key and still open envelopes sealed
    /// under the kid it was told about before.
    #[tokio::test]
    async fn a_restarted_server_still_speaks_the_channel_the_device_established() {
        let scratch = std::env::temp_dir().join(format!(
            "cosmos-privacy-restart-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&scratch).expect("scratch dir");
        let path = scratch.join("keymaterial.json");
        let kid = "d=;u=;s=ai_bus.synapse;a=;abc;def";
        let aes_key = [9u8; AES_KEY_LEN];

        // Before the restart: the device establishes, wraps its channel key to
        // the published public key, and uploads it.
        let published = {
            let svc = PublicPrivacy::with_key_material(Arc::new(
                crate::keymaterial::KeyMaterial::at_path_with_test_wrapping_key_generator(
                    path.clone(),
                ),
            ));
            let est = svc
                .establish_wrapping_keys(Request::new(pb::EstablishWrappingKeysRequest::default()))
                .await
                .unwrap()
                .into_inner();
            let published = est.clear_key.expect("wrapping key present").jca_encoded;
            let ik = pb::ImportableKey {
                kid: kid.as_bytes().to_vec(),
                key: Some(pb::importable_key::Key::WrappedKey(keypb::WrappedKey {
                    wrapping_kid: Vec::new(),
                    metadata: Vec::new(),
                    keydata: cosmos_crypto::wrap_channel_key(&published, &aes_key).unwrap(),
                    iv: Vec::new(),
                    auth_tag: Vec::new(),
                })),
                attrs: None,
            };
            let out = svc
                .import_keys(Request::new(pb::ImportKeysRequest { keys: vec![ik] }))
                .await
                .unwrap()
                .into_inner();
            assert_eq!(
                out.results[0].status,
                commonpb::KeyState::KeyImported as i32
            );
            published
        };

        // The restart. Same state path, brand-new process state.
        let restarted = PublicPrivacy::with_key_material(Arc::new(
            crate::keymaterial::KeyMaterial::at_path_allowing_test_wrapping_key_restore(
                path.clone(),
            ),
        ));

        // The device's cached channel key still opens what the server seals, and
        // the server still opens what the device seals — the assistant transport
        // survives.
        let from_server = restarted
            .keys
            .seal(kid, b"hello pin", b"")
            .expect("a restarted server must still hold the established channel key");
        assert_eq!(restarted.keys.open(&from_server).unwrap(), b"hello pin");
        let from_device = cosmos_crypto::seal(kid, &aes_key, b"what time is it", b"").unwrap();
        assert_eq!(
            restarted.keys.open(&from_device).unwrap(),
            b"what time is it"
        );

        // And a device that re-runs the exchange is still wrapping to a key this
        // server can unwrap, rather than to one that died with the old process.
        let re_established = restarted
            .establish_wrapping_keys(Request::new(pb::EstablishWrappingKeysRequest::default()))
            .await
            .unwrap()
            .into_inner()
            .clear_key
            .expect("wrapping key present")
            .jca_encoded;
        assert_eq!(
            re_established, published,
            "a restarted server must publish the wrapping key the device already wrapped to"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// An unreadable key-material snapshot must reach the device as its own
    /// distinct cause, not as a generation failure.
    ///
    /// `wrapping_key()` collapsed **every** `CryptoError` into
    /// `internal("failed to generate wrapping key")`, so the one error that means
    /// "your only key snapshot is unreadable — do not mint a replacement" was
    /// indistinguishable, at both the RPC status and the log, from an ordinary
    /// keygen fault. The two properties this pins:
    ///   * the status code is `FailedPrecondition` (an operator-clearable state),
    ///     never `Internal` — so a client/operator is not told the wrong layer
    ///     failed and does not retry into a second keypair; and
    ///   * the message names the snapshot rather than "generate", so the surfaced
    ///     diagnosis matches the true cause keymaterial.rs already logs.
    ///
    /// Construction alone proves nothing: `KeyMaterial::at_path` returns fine over
    /// a corrupt file. The invariant is what `establish_wrapping_keys` — the first
    /// encrypted RPC, which calls `wrapping_key()` — returns.
    #[tokio::test]
    async fn an_unreadable_snapshot_is_reported_as_a_precondition_not_a_generation_failure() {
        let scratch = std::env::temp_dir().join(format!(
            "cosmos-privacy-unreadable-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&scratch).expect("scratch dir");
        let path = scratch.join("keymaterial.json");
        // A durable snapshot that exists but does not parse: the keypair the
        // device wrapped to is (conceptually) still in here, so this is exactly
        // the "do not replace it" case.
        std::fs::write(&path, b"{ not json").expect("write corrupt snapshot");

        let svc = PublicPrivacy::with_key_material(Arc::new(
            crate::keymaterial::KeyMaterial::at_path(path.clone()),
        ));
        let status = svc
            .establish_wrapping_keys(Request::new(pb::EstablishWrappingKeysRequest::default()))
            .await
            .expect_err("an unreadable snapshot must fail the RPC, not mint a keypair");

        assert_eq!(
            status.code(),
            tonic::Code::FailedPrecondition,
            "an unreadable snapshot is an operator-clearable precondition, not an \
             internal generation failure: got {:?} ({:?})",
            status.code(),
            status.message(),
        );
        assert!(
            status.message().contains("snapshot"),
            "the status must name the snapshot as the cause, not blame key generation: {:?}",
            status.message(),
        );
        assert!(
            !status.message().contains("generate wrapping key"),
            "the generic generation message hides the real cause: {:?}",
            status.message(),
        );

        // The corrupt snapshot must still be on disk untouched — the whole point
        // of the distinct error is that this path refuses to overwrite it.
        assert_eq!(
            std::fs::read(&path).expect("snapshot still present"),
            b"{ not json",
            "the unreadable snapshot must not have been replaced",
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }
}
