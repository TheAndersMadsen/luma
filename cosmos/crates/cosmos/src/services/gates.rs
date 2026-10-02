//! Subscription + device-authorization signalling, cosmos's account gates.
//!
//! cosmos never ships a bespoke "you are not subscribed" error body. It overloads
//! two ordinary gRPC status codes with a custom **trailing** metadata key, and the
//! device's channel-wide `AccountAuthorizationInterceptor` reads the trailer in
//! `onClose` (SERVERSIDE-LOGIC §4.1, RUNTIME-CONTRACTS §2):
//!
//!   * `subscription-status: <int>` on **UNAUTHENTICATED(16)**, one
//!     `SubscriptionStatusCode`, last-writer-wins.
//!   * `unauthorized-device: <int>[,<int>…]` on **PERMISSION_DENIED(7)**, a
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
//!      means to degrade the account, never as a generic auth failure.
//!   2. **Any OK self-heals.** There is no "you are subscribed again" message:
//!      `resetAuthStateIfNeeded` forces the device back to ACTIVE + authorized on
//!      *any* OK close on the channel. This deployment therefore needs no re-grant
//!      path, every successful RPC already is one.
//!   3. **The whole scheme fails open.** UNSPECIFIED(0) counts as subscribed, and
//!      0 is the device's stored default, so a never-signalled device is not
//!      bricked (SERVERSIDE-LOGIC §4.3).
//!
//! **Lost-device block mode is real. Subscriptions are not.** The wearer's
//! blocked Pins live in `AccountBlobKind::DeviceBlocks`, and
//! `services::device_block::DeviceBlockLayer` refuses every call from one with
//! [`unauthorized_device_status`] before any handler runs. So a call that
//! reaches a handler comes from an authorized Pin, which is why the resolver
//! below can answer [`Entitlement::Active`] for every principal that does.
//!
//! This self-hosted deployment has no billing, so it never degrades a
//! subscription and never sends `subscription-status`: cosmos's own grant
//! predicate treats "no signal" as subscribed, and we will not invent an
//! expired plan. The stored `SubscriptionState` answers only the onboarding
//! RPC `GetSubscriptionStatus` (`services::provisioning`), Active for a paired
//! Pin unless an operator recorded otherwise.
//!
//! The module also carries the per-action gate the device mirrors locally
//! (`AccountAuthorizationMonitor.maybeBlockAction`) so the assistant engine can
//! apply the same policy *before* emitting an action.

use cosmos_core::AuthenticatedPrincipal;
use cosmos_protocol::account::{SubscriptionStatusCode, UnauthorizedStatusCode};
use tonic::{Code, Status, metadata::MetadataMap};

/// Trailing metadata key containing a `SubscriptionStatusCode`, only ever on
/// UNAUTHENTICATED (`SUBSCRIPTION_HEADER_KEY`, RUNTIME-CONTRACTS §2).
pub const SUBSCRIPTION_STATUS_METADATA: &str = "subscription-status";

/// Trailing metadata key containing the comma-separated `UnauthorizedStatusCode`
/// set, only ever on PERMISSION_DENIED (`UNAUTHORIZED_HEADER_KEY`).
pub const UNAUTHORIZED_DEVICE_METADATA: &str = "unauthorized-device";

/// cosmos's grant predicate: full behavior in exactly
/// `{UNSPECIFIED, ACTIVE, AVAILABLE}`, degraded in
/// `{SUSPENDED, PAUSED, BLOCKED, NOT_CONFIGURED, INACTIVE}` (`isSubscribed()`,
/// SERVERSIDE-LOGIC §4.3). UNSPECIFIED granting service is the fail-open rule.
///
/// Code 6 is an intentional gap in the enum, the device's `forNumber(6)` returns
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
    /// plus the `subscription-status` trailer. The unsubscribed whitelist still
    /// applies to actions.
    ///
    /// No production path constructs it: this deployment has no billing
    /// backend, so the resolver every call runs behind answers Active. The
    /// stock degradation verdict and its refusal stay modelled here, and
    /// pinned by tests, for a real `EntitlementDirectory` to produce, which is
    /// why this one variant carries the allow the whole module used to.
    #[allow(dead_code)]
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

    /// `isDeviceAuthorized()`, the reason set is empty.
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

/// Where entitlement decisions come from. cosmos resolves this against its own
/// billing/entitlement and lost-device registries, server-only state that is
/// explicitly not derivable from the client. A real store implements this trait;
/// nothing else in this module changes.
pub trait EntitlementDirectory: Send + Sync + 'static {
    fn entitlement(&self, principal: &AuthenticatedPrincipal) -> Entitlement;
}

/// The resolver the assistant runs behind the block layer: every authenticated
/// principal that reaches it is [`Entitlement::Active`].
///
/// A blocked Pin never gets this far (`services::device_block` refused it at the
/// transport), and there is no billing backend to degrade a subscription. cosmos
/// itself grants on UNSPECIFIED and only *pushes* degradation when its own
/// entitlement backend says so, so the faithful behavior here is to serve. It
/// never fabricates a subscription state or an expiry.
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
/// for a real de-authorization. An empty set is never emitted (the caller path
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
/// `nameForModel` values, the exact strings that ride in
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
/// (`RespondAction`) the recon states the whitelist in. For every one of these ten
/// the class name is exactly the wire name plus the `Action` suffix. Matching is
/// exact and case-sensitive, as on the device.
pub fn is_enabled_when_unsubscribed(action: &str) -> bool {
    let name = action.strip_suffix("Action").unwrap_or(action);
    ENABLED_WHEN_UNSUBSCRIBED.contains(&name)
}

/// The blocking observations the gate produces and the device converts into a
/// *self-generated* action instead of ending the run
/// (`convertAndDispatchGeneratedActionIfNeeded`, SERVERSIDE-LOGIC §4.8 / §2).
/// Each is recorded as a non-final observation and then re-dispatched as the
/// action below, which runs a canned local experience and produces its own
/// observation, so the ReAct chain is *rewritten*, not terminated. Stock's
/// other two conversions (`Respond` for a plain response or an exceeded
/// `mActionLimit`, `Narrate` for narration) never originate from an account
/// verdict, so the transports synthesize those actions from their own strings
/// and they are not modelled here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlockingObservation {
    /// Authorized but unsubscribed, and the action is not whitelisted.
    InvalidSubscription,
    /// Device de-authorized. Blocks every action type.
    UnauthorizedDevice,
    /// `KeyguardMonitor.maybeBlockAction`, evaluated *before* the account gate.
    KeyguardLocked,
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
        }
    }

    /// The observation text recorded before the synthesized action is dispatched.
    /// Stated plainly and without inventing account facts (no expiry dates, plan
    /// names, or device records, this deployment holds none).
    pub const fn observation_text(self) -> &'static str {
        match self {
            Self::InvalidSubscription => "This device does not have an active subscription.",
            Self::UnauthorizedDevice => "This device is not authorized.",
            // `KeyguardMonitor.maybeBlockAction`, verbatim.
            Self::KeyguardLocked => "Device is locked, cannot perform Action.",
        }
    }

    /// What the wearer hears once the synthesized action runs. For a locked
    /// Pin that is the Pin's own `InstructUnlockAction` narration
    /// (`CentralActionHandler.resolve(InstructUnlockAction)`), never the
    /// observation text, which is recorded for the model. A transport that
    /// speaks the verdict itself instead of dispatching the action says this.
    pub const fn spoken_text(self) -> &'static str {
        match self {
            Self::KeyguardLocked => "Ai Pin is locked.",
            other => other.observation_text(),
        }
    }
}

/// `AccountAuthorizationMonitor.maybeBlockAction`, the per-action gate, in the
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

#[cfg(test)]
mod tests {
    use super::*;

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

        // Starting playback is NOT whitelisted, transport works, PlayMusic does not.
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
        let status = Entitlement::Unsubscribed(SubscriptionStatusCode::Suspended)
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
        // The account signal is exactly one key. Nothing else leaks.
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

        // Granting codes never produce a degrading trailer, and UNSPECIFIED,
        // the device's own stored default, grants.
        for code in [
            SubscriptionStatusCode::Unspecified,
            SubscriptionStatusCode::Active,
            SubscriptionStatusCode::Available,
        ] {
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
            assert!(Entitlement::Unsubscribed(code).denial().is_some());
        }
        // An empty reason set is "authorized" on the device, never an empty trailer.
        assert_eq!(Entitlement::unauthorized(Vec::new()), Entitlement::Active);
        assert!(Entitlement::Unauthorized(Vec::new()).denial().is_none());
    }

    #[test]
    fn action_gate_follows_the_device_precedence() {
        let active = Entitlement::Active;
        let unsubscribed = Entitlement::Unsubscribed(SubscriptionStatusCode::Paused);
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
        ] {
            assert_eq!(observation.synthesized_action(), action);
        }

        // The subscription experience is self-consistent: its own synthesized
        // action passes the gate, so it cannot recurse into another block.
        assert!(is_enabled_when_unsubscribed(
            BlockingObservation::InvalidSubscription.synthesized_action()
        ));
    }

    /// The model is told stock's keyguard observation, verbatim. The wearer
    /// hears what the Pin's `InstructUnlockAction` narrates. Every other
    /// verdict is spoken as it is observed.
    #[test]
    fn a_locked_refusal_is_observed_and_spoken_as_on_stock() {
        let locked = BlockingObservation::KeyguardLocked;
        assert_eq!(
            locked.observation_text(),
            "Device is locked, cannot perform Action."
        );
        assert_eq!(locked.spoken_text(), "Ai Pin is locked.");
        for other in [
            BlockingObservation::InvalidSubscription,
            BlockingObservation::UnauthorizedDevice,
        ] {
            assert_eq!(other.spoken_text(), other.observation_text());
        }
    }
}
