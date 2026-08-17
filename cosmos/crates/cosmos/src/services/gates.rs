//! Subscription + device-authorization signalling — carry's account gates.
//!
//! carry never ships a bespoke "you are not subscribed" error body. It overloads
//! two ordinary gRPC status codes with a custom **trailing** metadata key, and the
//! device's channel-wide `AccountAuthorizationInterceptor` reads the trailer in
//! `onClose` (SERVERSIDE-LOGIC §4.1, RUNTIME-CONTRACTS §2):
//!
//!   * `subscription-status: <int>` on **UNAUTHENTICATED(16)** — one
//!     `SubscriptionStatusCode`, last-writer-wins.
//!   * `unauthorized-device: <int>[,<int>…]` on **PERMISSION_DENIED(7)** — a
//!     comma-separated *set* of `UnauthorizedStatusCode` reasons. A non-empty set
//!     makes the device lock its own keyguard and broadcast
//!     `LOCKED_UNAUTHORIZED_DEVICE`, so this is the lost/stolen kill switch and is
//!     strictly more severe than unsubscription.
//!
//! Three properties of that protocol are load-bearing and are honored here:
//!
//!   1. **Presence of the trailer is the discriminator.** A plain
//!      UNAUTHENTICATED/PERMISSION_DENIED with no trailer is treated by the device
//!      as a transient error and leaves account state untouched. So these statuses
//!      must only ever be built through the helpers below when the server actually
//!      means to degrade the account — never as a generic auth failure.
//!   2. **Any OK self-heals.** There is no "you are subscribed again" message:
//!      `resetAuthStateIfNeeded` forces the device back to ACTIVE + authorized on
//!      *any* OK close on the channel. This deployment therefore needs no re-grant
//!      path — every successful RPC already is one.
//!   3. **The whole scheme fails open.** UNSPECIFIED(0) counts as subscribed, and
//!      0 is the device's stored default, so a never-signalled device is not
//!      bricked (SERVERSIDE-LOGIC §4.3).
//!
//! **This deployment holds no subscription, billing, or lost-device datastore.**
//! The entitlement resolver below therefore returns [`Entitlement::Active`] for
//! every principal. That is a deliberate parity choice, not a stub pretending to
//! be a store: carry's own grant predicate treats "no signal" as subscribed, and
//! the entitlement decision itself is explicitly server-only and not derivable
//! (SERVERSIDE-LOGIC §4, "genuinely server-only"). We will not invent an expired
//! subscription, a lost-device record, or any user row. When a real datastore
//! exists it drops in behind [`EntitlementDirectory`] and every helper here keeps
//! working unchanged.
//!
//! The module also carries the per-action gate the device mirrors locally
//! (`AccountAuthorizationMonitor.maybeBlockAction`) so the assistant engine can
//! apply the same policy *before* emitting an action, and the response-header
//! formatter for `x-humane-service-path`.
//
// Nothing wires these pieces yet: the assistant engine and the service handlers
// still run ungated (this deployment is fail-open, so the gate is a no-op today).
// The same `#![allow(dead_code)]` precedent as `assistant/mod.rs` keeps the
// reusable surface compiling until those call sites land.
#![allow(dead_code)]

use cosmos_core::{AuthenticatedPrincipal, ServicePath, ServicePathError, WorkloadIdentity};
use cosmos_protocol::account::{SubscriptionStatusCode, UnauthorizedStatusCode};
use tonic::{Code, Status, metadata::MetadataMap};

/// Trailing metadata key carrying a `SubscriptionStatusCode`, only ever on
/// UNAUTHENTICATED (`SUBSCRIPTION_HEADER_KEY`, RUNTIME-CONTRACTS §2).
pub const SUBSCRIPTION_STATUS_METADATA: &str = "subscription-status";

/// Trailing metadata key carrying the comma-separated `UnauthorizedStatusCode`
/// set, only ever on PERMISSION_DENIED (`UNAUTHORIZED_HEADER_KEY`).
pub const UNAUTHORIZED_DEVICE_METADATA: &str = "unauthorized-device";

/// Topology header carry attaches to every response
/// (`carry:eastus:account-7d59c6df47-hnx6b`). The device does **not** read it
/// (RUNTIME-CONTRACTS §2), so it is observability, not a parity requirement.
pub const SERVICE_PATH_HEADER: &str = "x-humane-service-path";

/// carry's grant predicate: full behavior in exactly
/// `{UNSPECIFIED, ACTIVE, AVAILABLE}`, degraded in
/// `{SUSPENDED, PAUSED, BLOCKED, NOT_CONFIGURED, INACTIVE}` (`isSubscribed()`,
/// SERVERSIDE-LOGIC §4.3). UNSPECIFIED granting service is the fail-open rule.
///
/// Code 6 is an intentional gap in the enum — the device's `forNumber(6)` returns
/// null and it logs "Invalid subscription status update. Not updating." Our proto
/// has no variant for 6, so it is structurally impossible to emit.
pub const fn is_subscribed(code: SubscriptionStatusCode) -> bool {
    matches!(
        code,
        SubscriptionStatusCode::Unspecified
            | SubscriptionStatusCode::Active
            | SubscriptionStatusCode::Available
    )
}

/// The account verdict for one caller, in the form the wire needs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Entitlement {
    /// Serve normally. Also this deployment's fail-open default.
    Active,
    /// Device is authorized, subscription is degraded. Denied as UNAUTHENTICATED
    /// plus the `subscription-status` trailer; the unsubscribed whitelist still
    /// applies to actions.
    Unsubscribed(SubscriptionStatusCode),
    /// Device is de-authorized (lost/stolen/blocked). Denied as PERMISSION_DENIED
    /// plus the `unauthorized-device` trailer, which locks the pin's keyguard.
    /// Dominates the subscription state entirely.
    Unauthorized(Vec<UnauthorizedStatusCode>),
}

impl Default for Entitlement {
    /// Fail open, matching the device's own stored default of UNSPECIFIED.
    fn default() -> Self {
        Self::Active
    }
}

impl Entitlement {
    /// Maps a raw subscription code to a verdict. Codes carrying a grant
    /// (`UNSPECIFIED`/`ACTIVE`/`AVAILABLE`) collapse to [`Entitlement::Active`],
    /// so a granting code can never be emitted in a degrading trailer.
    pub fn from_subscription(code: SubscriptionStatusCode) -> Self {
        if is_subscribed(code) {
            Self::Active
        } else {
            Self::Unsubscribed(code)
        }
    }

    /// Marks the device de-authorized. An empty reason set means *authorized* on
    /// the device (`isDeviceAuthorized()` is `list.isEmpty()`), so it collapses to
    /// [`Entitlement::Active`] rather than emitting a meaningless empty trailer.
    pub fn unauthorized(reasons: impl Into<Vec<UnauthorizedStatusCode>>) -> Self {
        let reasons = reasons.into();
        if reasons.is_empty() {
            Self::Active
        } else {
            Self::Unauthorized(reasons)
        }
    }

    /// `isDeviceAuthorized()` — the reason set is empty.
    pub fn is_device_authorized(&self) -> bool {
        match self {
            Self::Active | Self::Unsubscribed(_) => true,
            Self::Unauthorized(reasons) => reasons.is_empty(),
        }
    }

    /// `isSubscribed()`, evaluated independently of device authorization.
    pub fn is_subscribed(&self) -> bool {
        match self {
            Self::Active | Self::Unauthorized(_) => true,
            Self::Unsubscribed(code) => is_subscribed(*code),
        }
    }

    /// The `Status` this verdict must be refused with, or `None` when the RPC
    /// should be served. Serving is itself the device's re-grant signal: any OK
    /// close resets it to ACTIVE + authorized (SERVERSIDE-LOGIC §4.4).
    pub fn denial(&self) -> Option<Status> {
        match self {
            Self::Active => None,
            Self::Unauthorized(reasons) if !reasons.is_empty() => {
                Some(unauthorized_device_status(reasons))
            }
            Self::Unauthorized(_) => None,
            Self::Unsubscribed(code) if !is_subscribed(*code) => Some(unsubscribed_status(*code)),
            Self::Unsubscribed(_) => None,
        }
    }
}

/// Where entitlement decisions come from. carry resolves this against its own
/// billing/entitlement and lost-device registries — server-only state that is
/// explicitly not derivable from the client. A real store implements this trait;
/// nothing else in this module changes.
pub trait EntitlementDirectory: Send + Sync + 'static {
    fn entitlement(&self, principal: &AuthenticatedPrincipal) -> Entitlement;
}

/// The resolver this deployment actually runs: **no datastore exists**, so every
/// authenticated principal is [`Entitlement::Active`].
///
/// This is honest fail-open parity, not a placeholder that fakes a lookup. carry
/// itself grants on UNSPECIFIED and only *pushes* degradation when its own
/// entitlement backend says so; with no such backend here there is no fact to
/// report, and the faithful behavior is to serve. It never fabricates a
/// subscription state, an expiry, or a lost-device record.
#[derive(Clone, Copy, Debug, Default)]
pub struct FailOpenDirectory;

impl EntitlementDirectory for FailOpenDirectory {
    fn entitlement(&self, _principal: &AuthenticatedPrincipal) -> Entitlement {
        Entitlement::Active
    }
}

/// UNAUTHENTICATED + `subscription-status: <code>` trailer.
///
/// Only for a real subscription degradation: the device flips account state
/// purely on the presence of this key, and ignores a bare UNAUTHENTICATED.
pub fn unsubscribed_status(code: SubscriptionStatusCode) -> Status {
    status_with_trailer(
        Code::Unauthenticated,
        "subscription is not active for this device",
        SUBSCRIPTION_STATUS_METADATA,
        &(code as i32).to_string(),
    )
}

/// PERMISSION_DENIED + `unauthorized-device: <csv>` trailer.
///
/// The device persists the reason set, locks its keyguard, and broadcasts. Only
/// for a real de-authorization; an empty set is never emitted (the caller path
/// through [`Entitlement::denial`] collapses it to a grant).
pub fn unauthorized_device_status(reasons: &[UnauthorizedStatusCode]) -> Status {
    let value = reasons
        .iter()
        .map(|reason| (*reason as i32).to_string())
        .collect::<Vec<_>>()
        .join(",");
    status_with_trailer(
        Code::PermissionDenied,
        "device is not authorized",
        UNAUTHORIZED_DEVICE_METADATA,
        &value,
    )
}

/// Builds a `Status` whose trailing metadata carries one ASCII account signal.
/// The message never reflects the caller's principal or request content.
fn status_with_trailer(code: Code, message: &str, key: &'static str, value: &str) -> Status {
    let mut trailers = MetadataMap::new();
    trailers.insert(
        key,
        value
            .parse()
            .expect("account signal values are ASCII digits and commas"),
    );
    Status::with_metadata(code, message.to_owned(), trailers)
}

/// Stock actions that keep working while unsubscribed but authorized
/// (`isEnabledWhenUnsubscribed`, SERVERSIDE-LOGIC §4.7). Names are the device's
/// `nameForModel` values — the exact strings that ride in
/// `SynapseActionContent.action`.
///
/// The wearer can still be talked to, file a bug report, see the not-subscribed
/// experience, and drive **transport** on already-playing audio. There is
/// deliberately no `PlayMusic`: skipping and pausing work, *starting* playback
/// does not, and neither does anything else that needs the cloud.
pub const ENABLED_WHEN_UNSUBSCRIBED: [&str; 10] = [
    "InvalidSubscription",
    "Respond",
    "TriggerBugReport",
    "ShowError",
    "PauseMusic",
    "ResumeMusic",
    "NextTrack",
    "PreviousTrack",
    "PreviousButton",
    "RestartTrack",
];

/// `isEnabledWhenUnsubscribed(action)` over an action name.
///
/// Accepts both the wire name (`Respond`) and the device class name
/// (`RespondAction`) the recon states the whitelist in; for every one of these ten
/// the class name is exactly the wire name plus the `Action` suffix. Matching is
/// exact and case-sensitive, as on the device.
pub fn is_enabled_when_unsubscribed(action: &str) -> bool {
    let name = action.strip_suffix("Action").unwrap_or(action);
    ENABLED_WHEN_UNSUBSCRIBED.contains(&name)
}

/// The blocking observations that the device converts into a *self-generated*
/// action instead of ending the run (`convertAndDispatchGeneratedActionIfNeeded`,
/// SERVERSIDE-LOGIC §4.8 / §2). Each is recorded as a non-final observation and
/// then re-dispatched as the action below, which runs a canned local experience
/// and produces its own observation — so the ReAct chain is *rewritten*, not
/// terminated.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlockingObservation {
    /// Authorized but unsubscribed, and the action is not whitelisted.
    InvalidSubscription,
    /// Device de-authorized. Blocks every action type.
    UnauthorizedDevice,
    /// `KeyguardMonitor.maybeBlockAction` — evaluated *before* the account gate.
    KeyguardLocked,
    /// A plain response observation promoted into a spoken answer.
    Response,
    /// The run exceeded `mActionLimit` (runaway guard, orthogonal to auth;
    /// `Respond` itself is exempt so an answer can always be delivered).
    TooManyActions,
    /// Narration observation promoted into the narrate action.
    Narration,
}

impl BlockingObservation {
    /// The device action name (`nameForModel`) synthesized from this observation.
    ///
    /// `InvalidSubscription` is itself on the unsubscribed whitelist, so the
    /// synthesized action passes the gate and cannot recurse into another block.
    /// `UnauthorizedDevice` is not whitelisted, but it is only ever synthesized on
    /// the unauthorized path where the local ANSWERS experience handles it
    /// (`enabledInKeyguard=true`, so it runs on a locked device).
    pub const fn synthesized_action(self) -> &'static str {
        match self {
            Self::InvalidSubscription => "InvalidSubscription",
            Self::UnauthorizedDevice => "UnauthorizedDevice",
            Self::KeyguardLocked => "InstructUnlock",
            Self::Response | Self::TooManyActions => "Respond",
            Self::Narration => "Narrate",
        }
    }

    /// The observation text recorded before the synthesized action is dispatched.
    /// Stated plainly and without inventing account facts (no expiry dates, plan
    /// names, or device records — this deployment holds none).
    pub const fn observation_text(self) -> &'static str {
        match self {
            Self::InvalidSubscription => "This device does not have an active subscription.",
            Self::UnauthorizedDevice => "This device is not authorized.",
            Self::KeyguardLocked => "The device is locked.",
            Self::Response => "Responding.",
            Self::TooManyActions => "Too many actions in this run.",
            Self::Narration => "Narrating.",
        }
    }

    /// Always false. These are `ErrorObservation`s built with `setIsFinal(false)`
    /// precisely so the conversion fires and the loop continues; a final
    /// observation would terminate the run as a plain error instead of running the
    /// degraded experience.
    pub const fn is_final(self) -> bool {
        false
    }
}

/// `AccountAuthorizationMonitor.maybeBlockAction` — the per-action gate, in the
/// device's exact precedence (SERVERSIDE-LOGIC §4.6). `None` allows the action.
///
/// Unauthorized strictly dominates: the whitelist is only consulted when the
/// device is authorized, so a de-authorized device is blocked on *every* action,
/// `Respond` and media transport included. The keyguard gate runs before this one
/// on the device and is not modelled here (the server does not hold keyguard
/// state; `device_context.is_locked` carries it per turn).
pub fn gate_action(entitlement: &Entitlement, action: &str) -> Option<BlockingObservation> {
    if !entitlement.is_device_authorized() {
        return Some(BlockingObservation::UnauthorizedDevice);
    }
    if entitlement.is_subscribed() || is_enabled_when_unsubscribed(action) {
        return None;
    }
    Some(BlockingObservation::InvalidSubscription)
}

/// Formats the `x-humane-service-path` value for this workload.
///
/// Shape follows the observed `environment:region:workload-revision-pod`
/// response header. Every token is *our* configured value — the environment token
/// is this deployment's own (`development`/`production`/…), not a literal `carry`,
/// so the header never claims to be Humane's infrastructure. `cosmos_core`
/// validates each token, and nothing caller-controlled or identity-bearing can
/// enter it.
///
/// The pod component is derived from real process state — the workload identity's
/// instance, i.e. `CARRY_POD_NAME`/`CARRY_INSTANCE_ID` from the downward API, or
/// the deterministic `local-1` off-cluster. No replicaset hash is ever
/// synthesized. When the instance is already a Deployment pod name
/// (`<workload>-<replicaset>-<suffix>`), the duplicated workload and revision
/// tokens are stripped first so the emitted path keeps the observed arity.
///
/// `config.rs` performs this same derivation once at startup and
/// `response_metadata::ServicePathLayer` emits the result on every response; this
/// is the reusable form for callers that hold only a `WorkloadIdentity`.
pub fn service_path_value(
    identity: &WorkloadIdentity,
    region: &str,
    revision: &str,
) -> Result<ServicePath, ServicePathError> {
    let workload = identity.workload();
    let environment = identity.environment();
    let instance = identity.instance();

    // Validate the full downward-API value before deriving a compact pod
    // component, so an operator-supplied instance id cannot be normalized into an
    // apparently trusted topology path.
    if ServicePath::from_pod_name(environment, region, workload, instance).is_err() {
        return ServicePath::new(environment, region, workload, revision, instance);
    }
    let pod = instance
        .strip_prefix(&format!("{workload}-"))
        .unwrap_or(instance);
    let pod = pod.strip_prefix(&format!("{revision}-")).unwrap_or(pod);
    ServicePath::new(environment, region, workload, revision, pod)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmos_core::{DeploymentEnvironment, Workload};

    fn identity(instance: &str) -> WorkloadIdentity {
        WorkloadIdentity::new(
            Workload::AiBus,
            DeploymentEnvironment::Development,
            instance,
            "carry.local",
        )
        .expect("valid workload identity")
    }

    #[test]
    fn whitelist_admits_respond_and_transport_but_never_playmusic() {
        // Talk back, file a bug, render the degraded experience.
        assert!(is_enabled_when_unsubscribed("Respond"));
        assert!(is_enabled_when_unsubscribed("InvalidSubscription"));
        assert!(is_enabled_when_unsubscribed("TriggerBugReport"));
        assert!(is_enabled_when_unsubscribed("ShowError"));
        // Transport on already-playing audio.
        for action in [
            "PauseMusic",
            "ResumeMusic",
            "NextTrack",
            "PreviousTrack",
            "PreviousButton",
            "RestartTrack",
        ] {
            assert!(is_enabled_when_unsubscribed(action), "{action}");
        }
        // The device class-name form the recon states the whitelist in.
        assert!(is_enabled_when_unsubscribed("PauseMusicAction"));
        assert!(is_enabled_when_unsubscribed("RespondAction"));

        // Starting playback is NOT whitelisted — transport works, PlayMusic does not.
        assert!(!is_enabled_when_unsubscribed("PlayMusic"));
        assert!(!is_enabled_when_unsubscribed("PlayMusicAction"));
        // Nothing else cloud-backed, and matching is exact + case-sensitive.
        assert!(!is_enabled_when_unsubscribed("SetTimer"));
        assert!(!is_enabled_when_unsubscribed("UnauthorizedDevice"));
        assert!(!is_enabled_when_unsubscribed("respond"));
        assert!(!is_enabled_when_unsubscribed(""));
    }

    #[test]
    fn unsubscribed_denial_is_unauthenticated_with_the_subscription_trailer() {
        let status = Entitlement::from_subscription(SubscriptionStatusCode::Suspended)
            .denial()
            .expect("a degraded subscription denies");

        assert_eq!(status.code(), Code::Unauthenticated);
        assert_eq!(
            status
                .metadata()
                .get(SUBSCRIPTION_STATUS_METADATA)
                .expect("subscription-status trailer present")
                .to_str()
                .expect("ascii trailer"),
            "3"
        );
        // The account signal is exactly one key; nothing else leaks.
        assert!(
            status
                .metadata()
                .get(UNAUTHORIZED_DEVICE_METADATA)
                .is_none()
        );
        assert!(!status.message().is_empty());
    }

    #[test]
    fn unauthorized_denial_is_permission_denied_with_the_reason_set_trailer() {
        let status = Entitlement::unauthorized(vec![
            UnauthorizedStatusCode::DeviceLostOrStolen,
            UnauthorizedStatusCode::Blocked,
        ])
        .denial()
        .expect("a de-authorized device denies");

        assert_eq!(status.code(), Code::PermissionDenied);
        // Comma-delimited SET: the server may attach several lockout reasons.
        assert_eq!(
            status
                .metadata()
                .get(UNAUTHORIZED_DEVICE_METADATA)
                .expect("unauthorized-device trailer present")
                .to_str()
                .expect("ascii trailer"),
            "1,2"
        );
        assert!(
            status
                .metadata()
                .get(SUBSCRIPTION_STATUS_METADATA)
                .is_none()
        );
    }

    #[test]
    fn no_datastore_means_fail_open_and_no_invented_degradation() {
        let principal =
            AuthenticatedPrincipal::from_edge("device-test-pin-01").expect("valid principal");
        assert_eq!(
            FailOpenDirectory.entitlement(&principal),
            Entitlement::Active
        );
        assert_eq!(Entitlement::default(), Entitlement::Active);
        assert!(Entitlement::Active.denial().is_none());

        // Granting codes never produce a degrading trailer, and UNSPECIFIED —
        // the device's own stored default — grants.
        for code in [
            SubscriptionStatusCode::Unspecified,
            SubscriptionStatusCode::Active,
            SubscriptionStatusCode::Available,
        ] {
            assert_eq!(Entitlement::from_subscription(code), Entitlement::Active);
            assert!(Entitlement::Unsubscribed(code).denial().is_none());
        }
        // Every degrading code does deny, once a real store reports one.
        for code in [
            SubscriptionStatusCode::Suspended,
            SubscriptionStatusCode::Paused,
            SubscriptionStatusCode::Blocked,
            SubscriptionStatusCode::NotConfigured,
            SubscriptionStatusCode::Inactive,
        ] {
            assert!(!is_subscribed(code));
            assert!(Entitlement::from_subscription(code).denial().is_some());
        }
        // An empty reason set is "authorized" on the device, never an empty trailer.
        assert_eq!(Entitlement::unauthorized(Vec::new()), Entitlement::Active);
        assert!(Entitlement::Unauthorized(Vec::new()).denial().is_none());
    }

    #[test]
    fn action_gate_follows_the_device_precedence() {
        let active = Entitlement::Active;
        let unsubscribed = Entitlement::from_subscription(SubscriptionStatusCode::Paused);
        let unauthorized = Entitlement::unauthorized(vec![UnauthorizedStatusCode::Blocked]);

        // Subscribed + authorized: everything runs.
        assert_eq!(gate_action(&active, "PlayMusic"), None);

        // Unsubscribed but authorized: whitelist decides.
        assert_eq!(gate_action(&unsubscribed, "Respond"), None);
        assert_eq!(gate_action(&unsubscribed, "PauseMusic"), None);
        assert_eq!(
            gate_action(&unsubscribed, "PlayMusic"),
            Some(BlockingObservation::InvalidSubscription)
        );

        // Unauthorized dominates: the whitelist branch is unreachable.
        for action in ["Respond", "PauseMusic", "PlayMusic"] {
            assert_eq!(
                gate_action(&unauthorized, action),
                Some(BlockingObservation::UnauthorizedDevice),
                "{action}"
            );
        }
    }

    #[test]
    fn blocked_observations_synthesize_the_stock_device_actions() {
        for (observation, action) in [
            (
                BlockingObservation::InvalidSubscription,
                "InvalidSubscription",
            ),
            (
                BlockingObservation::UnauthorizedDevice,
                "UnauthorizedDevice",
            ),
            (BlockingObservation::KeyguardLocked, "InstructUnlock"),
            (BlockingObservation::Response, "Respond"),
            (BlockingObservation::TooManyActions, "Respond"),
            (BlockingObservation::Narration, "Narrate"),
        ] {
            assert_eq!(observation.synthesized_action(), action);
            // Non-final, so the run continues into the degraded experience.
            assert!(!observation.is_final());
        }

        // The subscription experience is self-consistent: its own synthesized
        // action passes the gate, so it cannot recurse into another block.
        assert!(is_enabled_when_unsubscribed(
            BlockingObservation::InvalidSubscription.synthesized_action()
        ));
    }

    #[test]
    fn service_path_is_well_formed_and_derived_from_real_instance_state() {
        // Off-cluster: the deterministic instance, no synthesized pod hash.
        let path = service_path_value(&identity("local-1"), "eastus", "local")
            .expect("valid local service path");
        assert_eq!(path.as_str(), "development:eastus:ai-bus-local-local-1");

        // On-cluster: a Deployment pod name keeps the observed arity instead of
        // repeating the workload and revision tokens.
        let path = service_path_value(&identity("ai-bus-7d59c6df47-hnx6b"), "eastus", "r42")
            .expect("valid pod service path");
        assert_eq!(
            path.as_str(),
            "development:eastus:ai-bus-r42-7d59c6df47-hnx6b"
        );

        // Shape: `<environment>:<region>:<workload>-<revision>-<pod>`.
        let segments: Vec<&str> = path.as_str().split(':').collect();
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0], "development");
        assert_eq!(segments[1], "eastus");
        assert!(segments[2].starts_with("ai-bus-"));
        assert!(
            path.as_str()
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && byte != b'"')
        );

        // Topology tokens are validated, so nothing caller-shaped gets through.
        assert!(service_path_value(&identity("local-1"), "eastus:injected", "local").is_err());
    }
}
