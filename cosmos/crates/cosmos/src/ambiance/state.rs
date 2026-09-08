use super::policy::{self, Candidate, Channel, PrivacyClass, SemanticIntent};
use crate::{
    backends::lookup::LookupService,
    surface_registry::{Binding, Record},
};
use cosmos_core::AuthenticatedDeviceIdentity;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const ACK_MS: i64 = 3_000;
/// How long a shared card is held for a screen that is reachable but not in
/// front of anyone yet. Short enough that a waiting television cannot hold
/// the single shared-card slot against the owner's next request.
pub const ATTENDED_WAIT_MS: i64 = 20_000;
pub const WORKER_LEASE_MS: i64 = 75_000;
pub const MAX_ACTIONS: usize = 32;

/// The two sentences a shared-perceivable origin may hear about a device
/// action. Neither names an operation, a device kind, a class or a reason:
/// privacy suppression, a capability miss, an exhausted budget, a decline and
/// an ordinary failure are byte-identical from a shared surface.
pub const ACTION_COMPLETED_EXPRESSION: &str = "Done on your approved device.";
pub const ACTION_HANDLED_EXPRESSION: &str = "Heard. Handled on your approved device.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    Unavailable,
    InvalidOrigin,
    InvalidRequest,
    Stale,
    Busy,
    PolicyBlocked,
    NotFound,
}
impl From<crate::surface_registry::RegistryError> for RuntimeError {
    fn from(_: crate::surface_registry::RegistryError) -> Self {
        Self::Unavailable
    }
}

/// Only verified owner HTTP adapters may construct this credential proof.
/// It is never serialized, returned, or logged.
#[derive(Clone)]
pub struct BrowserProof {
    pub surface_id: Uuid,
    pub incarnation: Uuid,
    pub token_hash: String,
}

/// The room manager retains the admitted capability. A peer identity selects
/// this proof; neither the room payload nor a surface ID creates authority.
#[derive(Clone)]
pub enum RoomProof {
    Browser(BrowserProof),
    Native(super::NativeProof),
}

impl RoomProof {
    pub fn surface_id(&self) -> Uuid {
        match self {
            Self::Browser(proof) => proof.surface_id,
            Self::Native(proof) => proof.surface_id,
        }
    }

    pub fn incarnation(&self) -> Uuid {
        match self {
            Self::Browser(proof) => proof.incarnation,
            Self::Native(proof) => proof.incarnation,
        }
    }
}
/// Pin adapters must retain AuthLayer evidence and recheck current pairing.
/// The device-ID parser alone does not authenticate this origin.
pub enum OriginProof {
    Browser(BrowserProof),
    SequencedRoom {
        connection: RoomProof,
        stamp: InputStamp,
    },
    Pin {
        device: AuthenticatedDeviceIdentity,
        surface_id: Uuid,
        echo_fingerprint: String,
    },
    SequencedPin {
        connection: super::PinProof,
        stamp: InputStamp,
        echo_fingerprint: String,
    },
    VoicePin {
        connection: super::PinProof,
        stamp: InputStamp,
        intake: super::voice::Intake,
    },
    /// One recognized push-to-talk capture from an approved installation. The
    /// capture is the admitted request's identity and the transcript digest is
    /// the runtime's own reading of what the local recognizer returned; a
    /// client never asserts either, and no adapter accepts a transcript.
    VoiceNative {
        connection: super::NativeProof,
        stamp: InputStamp,
        capture: super::native_voice::Capture,
        transcript_digest: String,
        echo_fingerprint: String,
    },
}

pub enum RuntimeOperation {
    NativeChallenge {
        surface_id: Uuid,
        enrollment_id: Uuid,
        audience: String,
        challenge_id: Uuid,
        nonce: String,
    },
    OpenNative {
        surface_id: Uuid,
        audience: String,
        request: super::native_connection::OpenRequest,
        incarnation: Uuid,
    },
    CheckNative {
        connection: super::NativeProof,
    },
    CloseNative {
        connection: super::NativeProof,
    },
    VoicePolicy {
        surface_id: Uuid,
    },
    SetVoicePolicy {
        surface_id: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<super::voice::Policy>,
    },
    NativeVoicePolicy {
        surface_id: Uuid,
    },
    SetNativeVoicePolicy {
        surface_id: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<super::native_voice::Policy>,
    },
    /// Whether this installation may be spoken to at all, asked before any
    /// audio is read. It changes nothing and admits nothing.
    AdmitNativeVoice {
        connection: super::NativeProof,
    },
    BeginVoice {
        connection: super::PinProof,
        stamp: InputStamp,
        worker: Uuid,
        intake_id: Uuid,
        binding: super::voice::Binding,
    },
    RetireVoice {
        turn_id: Uuid,
        worker: Uuid,
        intake_id: Uuid,
    },
    CheckVoice {
        connection: super::PinProof,
        fence: TurnFence,
        binding: super::voice::Binding,
    },
    FinalizeVoice {
        connection: super::PinProof,
        fence: TurnFence,
        binding: super::voice::Binding,
        transcript: String,
    },
    DisclosurePolicy {
        surface_id: Uuid,
    },
    LookupPolicy {
        service: LookupService,
        surface_id: Uuid,
    },
    SetLookupPolicy {
        service: LookupService,
        surface_id: Uuid,
        approval_revision: u64,
        approval_incarnation: Option<Uuid>,
        expected_revision: u64,
        policy: Option<super::lookup::Policy>,
    },
    StartLookup {
        fence: TurnFence,
        request: super::lookup::Request,
        id: Uuid,
    },
    CheckLookup {
        fence: TurnFence,
        lookup: super::lookup::Lookup,
    },
    CompleteLookup {
        fence: TurnFence,
        lookup: super::lookup::Lookup,
        evidence_digest: String,
        privacy: PrivacyClass,
        visual: Option<super::visual::Reference>,
        /// The user's own query text, retained as bounded recent context.
        query_text: Option<String>,
    },
    /// Offer the owner's recent context to the current turn's cognition.
    RecentContext {
        fence: TurnFence,
    },
    /// The one sentence a channel that is not a personal screen may carry
    /// about routing. The text is the runtime's own constant, chosen here and
    /// never supplied by the caller, so every account that cannot be given in
    /// full is byte-identical whatever its turn was (§4.3, invariant 7).
    ExpressAccount {
        fence: TurnFence,
        language: super::account::Language,
        /// The origin cannot play speech, so the same sentence is bound to a
        /// card the way any other reply to that origin would be.
        screen_only: bool,
    },
    /// Resolve one proposed candidate reference into a bound command. The
    /// runtime mints every argument; cognition supplied only the identifier.
    BindDeviceAction {
        fence: TurnFence,
        operation: super::action::OperationKind,
        reference: String,
    },
    /// Bind a route the runtime minted from this turn's own completed places
    /// receipt, under the `then` the same cognition call already proposed.
    BindPlaceRoute {
        fence: TurnFence,
        operation: super::action::Operation,
    },
    PrivatePolicy {
        surface_id: Uuid,
    },
    /// Owner-visible liveness of one native installation: whether a current
    /// signed connection exists and whether its app reports a foreground.
    NativePresence {
        surface_id: Uuid,
    },
    SetPrivatePolicy {
        surface_id: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<super::personal::Policy>,
    },
    /// How many personal surfaces the owner declared for this class.
    PersonalSurfaces {
        privacy: PrivacyClass,
    },
    /// The private card or waiting task for a connected surface, if any.
    Invitation {
        connection: RoomProof,
    },
    /// The confirmation this installation is being asked for, minting it when
    /// a command is waiting and this venue's own foreground is reporting.
    Confirmation {
        connection: RoomProof,
    },
    /// The owner's own device-action policy for a connected installation, as
    /// that installation should hold it. Native only, and never anyone
    /// else's: a browser member has no policy of its own.
    DevicePolicyFor {
        connection: RoomProof,
    },
    /// What this installation must be told to stop carrying out, and why.
    Revocations {
        connection: RoomProof,
    },
    /// One running command saying it is still running. Unsequenced, so it
    /// never consumes an ingress slot, and idempotent by its own sequence.
    Progress {
        connection: RoomProof,
        action_id: Uuid,
        generation: u64,
        sequence: u64,
        elapsed_ms: i64,
    },
    /// The device's own final account of one dispatched command. Only this
    /// may set the turn's outcome.
    Report {
        connection: RoomProof,
        action_id: Uuid,
        turn_id: Uuid,
        generation: u64,
        channel: Channel,
        content_digest: String,
        outcome: super::action::ReportOutcome,
        evidence: super::action::Evidence,
        /// The command's own bounded output, for a terminal command report.
        output: Option<String>,
    },
    /// The runtime's own shared-safe sentence for a device action, proposed
    /// only once the report it speaks for is committed.
    ExpressAction {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
        action_id: Option<Uuid>,
    },
    /// Current surface profiles attest neither the requesting actor nor room
    /// privacy. Record the refusal before any private source is accessed.
    RefusePrivateContext {
        fence: TurnFence,
    },
    /// Admit one note write for this turn. Cognition proposed only that the
    /// request be kept; the runtime bounded and classified the words itself
    /// and passes their measure, never the words.
    WriteNote {
        fence: TurnFence,
        bytes: u32,
        titled: bool,
        privacy: PrivacyClass,
    },
    /// What the store actually did with the admitted note. Only this may say
    /// a note exists, and only it decides which sentence the owner hears.
    NoteWritten {
        fence: TurnFence,
        saved: bool,
    },
    /// The owner's screen-context permission for one native installation.
    ScreenContextPolicy {
        surface_id: Uuid,
    },
    /// The owner's statement of what one native installation may be asked to
    /// do, and the commands the owner authored for it.
    DeviceActionPolicy {
        surface_id: Uuid,
    },
    SetDeviceActionPolicy {
        surface_id: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<super::action::Policy>,
    },
    DeviceCommandPolicy {
        surface_id: Uuid,
    },
    SetDeviceCommandPolicy {
        surface_id: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<super::action::CommandPolicy>,
    },
    SetScreenContextPolicy {
        surface_id: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<super::screen::Policy>,
    },
    /// Offer the origin's own screen text to this turn's cognition under the
    /// origin's screen-context permission; recorded content-free.
    OfferScreenContext {
        fence: TurnFence,
        app_digest: String,
        bytes: u32,
        document: Option<super::continuation::DocumentHandle>,
    },
    /// The current turn's outcome as its origin member may express it.
    TurnStatus {
        connection: RoomProof,
    },
    SetDisclosurePolicy {
        surface_id: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<super::disclosure::Policy>,
    },
    StartDisclosure {
        fence: TurnFence,
        request: super::disclosure::Request,
        id: Uuid,
    },
    CheckDisclosure {
        fence: TurnFence,
        disclosure: super::disclosure::Disclosure,
    },
    RetireDisclosure {
        fence: TurnFence,
        id: Uuid,
    },
    OpenPin {
        device: AuthenticatedDeviceIdentity,
        surface_id: Uuid,
        approval_revision: u64,
        epoch: Uuid,
        expected_incarnation: Option<Uuid>,
        incarnation: Uuid,
    },
    CheckPin {
        connection: super::PinProof,
    },
    ClaimPinMedia {
        connection: super::PinProof,
        owner: Uuid,
    },
    RetirePinMedia {
        connection: super::PinProof,
        owner: Uuid,
    },
    ClosePin {
        connection: super::PinProof,
    },
    OpenBrowser {
        connection: BrowserProof,
        epoch: Uuid,
    },
    RoomControl {
        connection: RoomProof,
        stamp: InputStamp,
        control: BrowserControl,
    },
    Begin {
        turn_id: Uuid,
        worker: Uuid,
        origin: OriginProof,
        request_digest: String,
        privacy_floor: PrivacyClass,
    },
    Propose {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
        intent: SemanticIntent,
        privacy: PrivacyClass,
        hint: Option<policy::RoutingTarget>,
    },
    ConfirmDisplay {
        action_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    CheckCognition {
        fence: TurnFence,
    },
    AnalysisStart {
        fence: TurnFence,
        input_digest: String,
        privacy: PrivacyClass,
    },
    AnalysisComplete {
        fence: TurnFence,
        input_digest: String,
        output_digest: String,
        privacy: PrivacyClass,
    },
    Claim {
        action_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    DeliveryFailed {
        connection: RoomProof,
        action_id: Uuid,
        generation: u64,
    },
    CheckDelivery {
        connection: RoomProof,
        action_id: Uuid,
        generation: u64,
    },
    Ack {
        action_id: Uuid,
        turn_id: Uuid,
        generation: u64,
        connection: RoomProof,
        channel: Channel,
        content_digest: String,
    },
    Cancel {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    Finish {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    Poll {
        connection: RoomProof,
    },
    Inspect {
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
    },
    Sweep,
    Recover {
        worker: Uuid,
    },
}
#[derive(Clone, Debug)]
pub enum RuntimeResult {
    NativeChallenge(super::native_connection::Challenge),
    NativeOpened {
        connection: super::native_connection::ConnectionView,
        duplicate: bool,
    },
    NativeCurrent(super::native_connection::ConnectionView),
    NativeClosed,
    VoicePolicy(Option<super::voice::Approval>),
    NativeVoicePolicy(Option<super::native_voice::Approval>),
    NativeVoiceAdmissible {
        policy_revision: u64,
        source_floor: PrivacyClass,
    },
    VoiceCurrent,
    VoiceFinalized {
        privacy: PrivacyClass,
    },
    DisclosurePolicy(Option<super::disclosure::Approval>),
    DisclosureStarted(super::disclosure::Disclosure),
    DisclosureCurrent,
    LookupPolicy {
        approval: Option<super::lookup::Approval>,
        binding: super::lookup::ApprovalBinding,
    },
    LookupStarted(super::lookup::Lookup),
    LookupCurrent,
    LookupCompleted(super::lookup::Receipt),
    RecentContext {
        contexts: Vec<RecentContext>,
        actions: super::action::ActionOffer,
    },
    DeviceActionBound(super::action::Operation),
    PrivatePolicy(Option<super::personal::Approval>),
    DeviceActionPolicy(Option<super::action::Approval>),
    DevicePolicyFor(Option<Box<super::action::DevicePolicy>>),
    DeviceCommandPolicy(Option<super::action::CommandApproval>),
    NativePresence {
        connected: bool,
        visible: bool,
        private_display: bool,
    },
    PersonalSurfaces(usize),
    Invitation(Option<super::personal::Invitation>),
    Confirmation(Option<super::grant::Request>),
    Revocations(Vec<Revocation>),
    Reported(Action),
    ProgressAccepted {
        duplicate: bool,
    },
    PrivateContextRefused,
    NoteWriteAdmitted,
    NoteWriteDenied(super::note::Denial),
    NoteWritten,
    ScreenContextPolicy(Option<super::screen::Approval>),
    ScreenContextOffered,
    TurnStatus(Option<super::status::TurnStatus>),
    PinOpened {
        connection: super::PinConnection,
        duplicate: bool,
    },
    PinCurrent,
    PinMediaGranted(super::PinConnection),
    PinClosed,
    ConnectionOpened,
    ControlAccepted {
        duplicate: bool,
    },
    Duplicate(TurnFence),
    EchoRejected,
    Begun(TurnFence),
    Proposed(Action),
    Dispatch(Action),
    DeliveryFailureRecorded,
    Acknowledged(Action),
    Blocked,
    Cancelled,
    Finished,
    Swept,
    Recovered,
    Pending(Vec<Action>),
    Observed(Vec<Action>),
    CognitionCurrent,
    AnalysisStarted,
    AnalysisCompleted,
}

pub struct RuntimeTransition {
    pub result: RuntimeResult,
    pub events: Vec<RuntimeData>,
    pub surface: Option<(Record, &'static str)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnFence {
    pub turn_id: Uuid,
    pub generation: u64,
    pub worker: Uuid,
    pub origin_surface: Uuid,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    pub fence: TurnFence,
    pub origin_incarnation: Uuid,
    pub origin_revision: u64,
    #[serde(default)]
    pub pin_incarnation: Option<Uuid>,
    pub request_digest: String,
    pub privacy: PrivacyClass,
    pub lease_until_ms: i64,
    pub cancelled: bool,
    pub finished: bool,
    #[serde(default)]
    pub analysis: Option<AnalysisState>,
    /// The one note this turn was allowed to write, and what became of it.
    /// One turn keeps at most one thing: a request is a request, not a queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<super::note::Write>,
    #[serde(default)]
    pub disclosures: Vec<super::disclosure::Disclosure>,
    #[serde(default)]
    pub voice: Option<super::voice::Intake>,
    #[serde(default)]
    pub lookup: Option<super::lookup::Lookup>,
    /// The first committed acknowledgment of this turn's own output: the
    /// only outcome any surface may express for it.
    #[serde(default)]
    pub outcome: Option<TurnOutcome>,
    /// The origin's own screen text was offered to cognition under the
    /// owner's permission; content-free.
    #[serde(default)]
    pub screen_context: Option<super::screen::Offered>,
    /// This request was spoken, not typed. Provenance the runtime keeps for
    /// the whole turn: what a person said out loud in a room and what they
    /// typed alone are not the same event, even when the words match.
    #[serde(default)]
    pub spoken: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnOutcome {
    pub surface_id: Uuid,
    pub channel: Channel,
}

impl Turn {
    pub(super) fn voice_pending(&self) -> bool {
        self.voice
            .as_ref()
            .is_some_and(|v| v.transcript_digest.is_none())
    }

    pub(super) fn lookup_pending(&self) -> bool {
        self.lookup
            .as_ref()
            .is_some_and(|lookup| lookup.receipt.is_none())
    }

    fn completed_places_lookup(&self) -> bool {
        self.lookup.as_ref().is_some_and(|lookup| {
            lookup.request.provider.provider.service() == LookupService::Places
                && lookup.receipt.is_some()
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisState {
    pub input_digest: String,
    pub output_digest: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    Proposed,
    /// An action channel waiting for the owner's confirmation ceremony.
    AwaitingGrant,
    Dispatched,
    /// Bound and legal at the executing installation. On an action channel
    /// this is not an outcome: a device can accept a command and then fail to
    /// carry it out.
    Acknowledged,
    /// A long command the executing installation is still working on.
    Running,
    Completed,
    Refused,
    Failed,
    Cancelled,
    OutcomeUnknown,
}

impl ActionStatus {
    /// Whether nothing more can happen to this action. Every payload it still
    /// carries is erased before the transaction that lands here commits.
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Refused | Self::Failed | Self::Cancelled | Self::OutcomeUnknown
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub id: Uuid,
    pub root_id: Uuid,
    pub turn_id: Uuid,
    pub generation: u64,
    pub worker: Uuid,
    pub surface_id: Uuid,
    pub channel: Channel,
    pub incarnation: Uuid,
    pub content_digest: String,
    pub intent: SemanticIntent,
    pub privacy: PrivacyClass,
    pub status: ActionStatus,
    pub deadline_ms: i64,
    pub display_expires_at_ms: i64,
    pub attempts: u8,
    pub fallbacks: Vec<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation_root: Option<Uuid>,
    /// The turn's origin, so a transport owner can rebuild the exact fence.
    #[serde(default)]
    pub origin_surface: Uuid,
    /// The runtime's own shared-safe expression: fixed text at the shared
    /// class that a later raise of the turn's class does not retire.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub expression: bool,
    /// What the executing device said happened. Only a device's own final
    /// report writes this, and only it may set the turn's outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<super::action::ReportOutcome>,
    /// Why the runtime told the device to stop, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked: Option<super::action::RevokeReason>,
    /// The highest progress sequence this action has accepted. Progress is
    /// unsequenced on the wire and idempotent here.
    #[serde(default, skip_serializing_if = "num::is_zero")]
    pub progress: u64,
    /// When the executing installation was first given this command, so the
    /// ledger can say how long it took to say what happened.
    #[serde(default, skip_serializing_if = "num::is_zero_i64")]
    pub dispatched_at_ms: i64,
}

mod num {
    pub fn is_zero(value: &u64) -> bool {
        *value == 0
    }
    pub fn is_zero_i64(value: &i64) -> bool {
        *value == 0
    }
}

impl Action {
    pub fn fence(&self) -> TurnFence {
        TurnFence {
            turn_id: self.turn_id,
            generation: self.generation,
            worker: self.worker,
            origin_surface: self.origin_surface,
        }
    }

    /// Whether this action still owes the turn something. A card's
    /// acknowledgment is its outcome; an action channel's is not, because a
    /// device can accept a command and then fail to carry it out.
    pub fn live(&self) -> bool {
        match self.status {
            ActionStatus::Proposed
            | ActionStatus::AwaitingGrant
            | ActionStatus::Dispatched
            | ActionStatus::Running => true,
            ActionStatus::Acknowledged => self.channel.is_action(),
            status => !status.terminal(),
        }
    }

    /// Whether the executing installation has already begun. Visibility is
    /// required to begin, never to continue.
    pub fn started(&self) -> bool {
        matches!(
            self.status,
            ActionStatus::Dispatched | ActionStatus::Acknowledged | ActionStatus::Running
        )
    }

    fn bound_operation(&self) -> Option<&super::action::Operation> {
        bound_operation(&self.intent)
    }
}

struct DisplayConfirmation {
    root_id: Uuid,
    acknowledged_action: Uuid,
    expires_at_ms: i64,
}

struct OutputProposal {
    intent: SemanticIntent,
    privacy: PrivacyClass,
    confirmation: Option<DisplayConfirmation>,
    hint: Option<policy::RoutingTarget>,
    /// The runtime's own shared-safe expression, identical for every
    /// elsewhere-routed request; routed at the shared class.
    expression: bool,
}
/// Bounded owner memory of the last completed place lookup: the user's own
/// query text, never provider content. It is scoped to the owner, classed by
/// the turn that produced it and offered to a later turn only as bounded
/// cognition context, so "the restaurant I just found on the computer" can be
/// looked up again under the new origin's own lookup permission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentContext {
    pub kind: RecentContextKind,
    /// The owner's own place query, or an acknowledged list's title.
    pub text: String,
    /// The acknowledged list's item titles, in list order, so "number two"
    /// names exactly one of them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<String>,
    pub source_surface: Uuid,
    pub privacy: PrivacyClass,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    /// The acknowledged list's own content digest. A different list means a
    /// different digest, so "number two" resolves against exactly the list
    /// the owner was shown or against nothing at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_digest: Option<String>,
    /// A document and its explanation, for a later turn that asks to carry on
    /// somewhere else. Never in a prompt; only its identifier and kind are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<super::continuation::Continuation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecentContextKind {
    PlaceQuery,
    /// An acknowledged choice list: its title and numbered item titles.
    Choices,
    /// A document handle the owner's own screen supplied, with the private
    /// explanation the same turn produced.
    Continuation,
}

/// At most one memory per kind, newest wins, so a remembered choice list and
/// a remembered place query can both stand inside the same ten minutes.
pub const MAX_RECENT_CONTEXT: usize = 4;

/// Reads the durable field whether it holds nothing, the single memory of an
/// earlier release, or the current list. One field, one meaning.
fn recent_contexts<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<RecentContext>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stored {
        Many(Vec<RecentContext>),
        One(Box<RecentContext>),
        None,
    }
    Ok(match Stored::deserialize(deserializer)? {
        Stored::Many(contexts) => contexts,
        Stored::One(context) => vec![*context],
        Stored::None => Vec::new(),
    })
}

pub const RECENT_CONTEXT_MS: i64 = 600_000;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeState {
    pub generation: u64,
    pub turn: Option<Turn>,
    pub actions: BTreeMap<Uuid, Action>,
    #[serde(default)]
    pub ingress: BTreeMap<Uuid, InputCursor>,
    #[serde(default)]
    pub echoes: Vec<super::echo::Window>,
    #[serde(default)]
    pub pin_connections: BTreeMap<Uuid, super::PinConnection>,
    #[serde(default)]
    pub native_connections: BTreeMap<Uuid, super::native_connection::NativeState>,
    #[serde(default)]
    pub disclosure_policies: BTreeMap<Uuid, super::disclosure::Approval>,
    #[serde(default)]
    pub voice_policies: BTreeMap<Uuid, super::voice::Approval>,
    #[serde(default)]
    pub native_voice_policies: BTreeMap<Uuid, super::native_voice::Approval>,
    #[serde(default)]
    pub lookup_policies: BTreeMap<Uuid, super::lookup::BoundApproval>,
    #[serde(default)]
    pub place_lookup_policies: BTreeMap<Uuid, super::lookup::BoundApproval>,
    #[serde(default, deserialize_with = "recent_contexts")]
    pub recent_context: Vec<RecentContext>,
    #[serde(default)]
    pub private_policies: BTreeMap<Uuid, super::personal::Approval>,
    #[serde(default)]
    pub screen_context_policies: BTreeMap<Uuid, super::screen::Approval>,
    #[serde(default)]
    pub device_action_policies: BTreeMap<Uuid, super::action::Approval>,
    #[serde(default)]
    pub device_command_policies: BTreeMap<Uuid, super::action::CommandApproval>,
    /// Live confirmation ceremonies, fenced by their own turn and worker.
    #[serde(default)]
    pub grants: BTreeMap<Uuid, super::grant::Grant>,
    /// Dispatched device actions in the rolling window.
    #[serde(default)]
    pub action_budget: super::action::ActionBudget,
    /// Notes written in the rolling window.
    #[serde(default)]
    pub note_budget: super::note::Budget,
    /// What each installation still has to be told to stop, and why.
    #[serde(default)]
    pub revocations: Vec<Revocation>,
}

/// One retired effect a device may still be carrying out. It is kept just
/// long enough to reach the installation that was asked to do it, because a
/// new turn clears the action rows the reason would otherwise live on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revocation {
    pub action_id: Uuid,
    pub surface_id: Uuid,
    pub incarnation: Uuid,
    pub reason: super::action::RevokeReason,
    pub expires_at_ms: i64,
}

/// A revocation reaches a connected installation within its own delivery
/// loop; it is not durable owner state.
pub const REVOCATION_MS: i64 = 120_000;
pub const MAX_REVOCATIONS: usize = 8;

/// Client boot epochs and sequences are provenance; client clocks are not.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputStamp {
    pub epoch: Uuid,
    pub sequence: u64,
    pub instance_id: Uuid,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputCursor {
    pub incarnation: Uuid,
    pub epoch: Uuid,
    pub high_water: u64,
    pub receipts: Vec<InputReceipt>,
    #[serde(default)]
    pub controls: Vec<ControlReceipt>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlReceipt {
    pub sequence: u64,
    pub instance_id: Uuid,
    pub digest: String,
    pub expires_at_ms: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BrowserControl {
    Heartbeat,
    Acknowledge {
        action_id: Uuid,
        turn_id: Uuid,
        generation: u64,
        channel: Channel,
        content_digest: String,
    },
    Cancel {
        turn_id: Uuid,
        generation: u64,
    },
    State {
        visible: bool,
    },
    /// What the device says happened to one bound command. Exactly one per
    /// action, so an action costs at most two ingress slots.
    Report {
        action_id: Uuid,
        turn_id: Uuid,
        generation: u64,
        channel: Channel,
        content_digest: String,
        outcome: super::action::ReportOutcome,
        evidence: super::action::Evidence,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    /// The owner's answer to a confirmation, bound to the exact sentence they
    /// read and carrying the actor evidence the platform actually obtained.
    Grant {
        grant_id: Uuid,
        action_id: Uuid,
        granted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attestation: Option<super::action::Attestation>,
        description_digest: String,
    },
}

impl InputCursor {
    fn prune(&mut self, now: i64) {
        self.receipts.retain(|r| now < r.expires_at_ms);
        self.controls.retain(|r| now < r.expires_at_ms);
        while self.receipts.len() + self.controls.len() > 32 {
            let input = self
                .receipts
                .first()
                .map(|r| r.sequence)
                .unwrap_or(u64::MAX);
            let control = self
                .controls
                .first()
                .map(|r| r.sequence)
                .unwrap_or(u64::MAX);
            if input < control {
                self.receipts.remove(0);
            } else {
                self.controls.remove(0);
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputReceipt {
    pub sequence: u64,
    pub digest: String,
    pub admission: InputAdmission,
    pub expires_at_ms: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputAdmission {
    Turn { fence: TurnFence },
    EchoRejected { request_id: Uuid },
}
impl InputAdmission {
    fn request_id(&self) -> Uuid {
        match self {
            Self::Turn { fence } => fence.turn_id,
            Self::EchoRejected { request_id } => *request_id,
        }
    }
}

/// Content-free event bodies. Never include request text, capability hashes,
/// device IDs, or model output. Candidate vectors explain deterministic routing.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RuntimeData {
    NativeLeaseRenewed {
        surface_id: Uuid,
        incarnation: Uuid,
        lease_expires_at_ms: i64,
    },
    NativeChallengeIssued {
        surface_id: Uuid,
        approval_revision: u64,
        challenge_id: Uuid,
        expires_at_ms: i64,
    },
    NativeEpochOpened {
        surface_id: Uuid,
        approval_revision: u64,
        incarnation: Uuid,
        epoch: Uuid,
        expires_at_ms: i64,
    },
    NativeEpochClosed {
        surface_id: Uuid,
        incarnation: Uuid,
    },
    VoicePolicyChanged {
        surface_id: Uuid,
        approval: super::voice::Approval,
    },
    NativeVoicePolicyChanged {
        surface_id: Uuid,
        approval: super::native_voice::Approval,
    },
    /// One spoken request from an installation, recorded where a typed one
    /// records only its digest: the press it came from, the class the owner's
    /// policy admitted it at and the class it ended up at once the transcript's
    /// own terms joined in. The words themselves are never here.
    NativeVoiceAdmitted {
        fence: TurnFence,
        policy_revision: u64,
        source_floor: PrivacyClass,
        capture_ms: i64,
        samples: u32,
        audio_digest: String,
        transcript_digest: String,
        classifier_version: u8,
        privacy: PrivacyClass,
    },
    VoiceStarted {
        fence: TurnFence,
        policy_revision: u64,
        source_digest: String,
        source_floor: PrivacyClass,
        expires_at_ms: i64,
    },
    VoiceFinalized {
        fence: TurnFence,
        transcript_digest: String,
        classifier_version: u8,
        privacy: PrivacyClass,
    },
    DisclosurePolicyChanged {
        surface_id: Uuid,
        approval: super::disclosure::Approval,
    },
    LookupPolicyChanged {
        surface_id: Uuid,
        approval: super::lookup::Approval,
    },
    PlaceLookupPolicyChanged {
        surface_id: Uuid,
        approval: super::lookup::Approval,
    },
    /// The largest body the runtime ledger carries; held behind an
    /// indirection so one event kind does not widen every other.
    LookupStarted {
        fence: TurnFence,
        lookup: Box<super::lookup::Lookup>,
    },
    LookupDenied {
        fence: TurnFence,
        request: super::lookup::Request,
    },
    LookupCompleted {
        fence: TurnFence,
        id: Uuid,
        policy_revision: u64,
        receipt: super::lookup::Receipt,
    },
    RecentContextRemembered {
        context: RecentContextKind,
        source_surface: Uuid,
        privacy: PrivacyClass,
        expires_at_ms: i64,
    },
    RecentContextOffered {
        fence: TurnFence,
        context: RecentContextKind,
        source_surface: Uuid,
        privacy: PrivacyClass,
    },
    PrivateDisplayPolicyChanged {
        surface_id: Uuid,
        approval: super::personal::Approval,
    },
    // Retained for decoding the durable ledger; new turns never emit this.
    PrivateContextOffered {
        fence: TurnFence,
        source: String,
        count: u32,
    },
    PrivateContextRefused {
        fence: TurnFence,
    },
    /// A routing question was admitted without reading the origin's history.
    AccountRequested {
        fence: TurnFence,
    },
    /// The runtime admitted one note write for this turn: how much text, and
    /// whether it carries a title. Never a word of it, and never a digest of
    /// one — a digest of a short note is a way to confirm a guess about it.
    NoteWriteStarted {
        fence: TurnFence,
        bytes: u32,
        titled: bool,
        privacy: PrivacyClass,
    },
    /// What the store did. The only event that says a note exists, which is
    /// what makes "Saved to your notes." an outcome rather than a claim.
    NoteWriteCompleted {
        turn_id: Uuid,
        generation: u64,
        saved: bool,
    },
    /// The runtime would not write a note, and why. The owner reads the reason
    /// here; the surface that asked hears the same sentence for all of them.
    NoteWriteDenied {
        fence: TurnFence,
        reason: super::note::Denial,
    },
    ScreenContextPolicyChanged {
        surface_id: Uuid,
        approval: super::screen::Approval,
    },
    /// The owner's permissions are the largest bodies the ledger carries, so
    /// they are held behind an indirection rather than widening every event.
    DeviceActionPolicyChanged {
        surface_id: Uuid,
        approval: Box<super::action::Approval>,
    },
    DeviceCommandPolicyChanged {
        surface_id: Uuid,
        approval: Box<super::action::CommandApproval>,
    },
    /// Which kinds of runtime-minted candidate this turn's cognition was
    /// offered, and how many. Never an identifier's content.
    ActionCandidatesOffered {
        fence: TurnFence,
        kinds: Vec<super::action::CandidateKind>,
        count: u32,
    },
    /// The runtime resolved a proposed reference into one bound command. It
    /// carries digests, kinds and identifiers only: no locator, argv, place
    /// name, media title, command output, device id or model text. The
    /// `Decision` that follows names the action this bound command became.
    ActionBound {
        fence: TurnFence,
        channel: Channel,
        operation: super::action::OperationKind,
        candidate: super::action::CandidateKind,
        reference_digest: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entry_digest: Option<String>,
        content_digest: String,
    },
    /// A confirmation ceremony was put in front of a person at the exact
    /// installation that would carry the command out.
    GrantRequested {
        fence: TurnFence,
        grant_id: Uuid,
        action_id: Uuid,
        venue_surface: Uuid,
        risk: super::action::Risk,
        expires_at_ms: i64,
    },
    /// How the ceremony ended, and how long the person took. Habituation is
    /// instrumented, never celebrated: a reflex grant is a signal to redesign.
    GrantResolved {
        grant_id: Uuid,
        action_id: Uuid,
        venue_surface: Uuid,
        outcome: super::grant::Outcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attestation: Option<super::action::Attestation>,
        dwell_ms: i64,
    },
    /// The executing device's own account of what happened. It carries the
    /// evidence kind and its digest, never the command's output.
    ActionReported {
        action_id: Uuid,
        channel: Channel,
        outcome: super::action::ReportOutcome,
        evidence: super::action::EvidenceKind,
        evidence_digest: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        elapsed_ms: i64,
        attempt: u8,
    },
    /// Six device actions in ten minutes, or one already in flight. The
    /// origin hears the ordinary understated acknowledgment; the owner reads
    /// this.
    ActionBudgetExhausted {
        fence: TurnFence,
        window_ms: i64,
        limit: u8,
    },
    /// The runtime told a device to stop. A revoke supersedes remaining work;
    /// it does not un-open an application.
    EffectRevoked {
        action_id: Uuid,
        reason: super::action::RevokeReason,
    },
    /// A new request from the owner voided a turn whose effect was still
    /// running. The stopped task is reported cancelled, never completed.
    TurnPreempted {
        turn_id: Uuid,
        generation: u64,
        by_surface: Uuid,
    },
    /// The origin's own screen text reached cognition: which app it came
    /// from (digest) and how many bytes; never the text.
    ScreenContextOffered {
        fence: TurnFence,
        app_digest: String,
        bytes: u32,
    },
    ProviderDisclosureStarted {
        fence: TurnFence,
        disclosure: super::disclosure::Disclosure,
    },
    ProviderDisclosureDenied {
        fence: TurnFence,
        request: super::disclosure::Request,
    },
    PinEpochOpened {
        surface_id: Uuid,
        approval_revision: u64,
        incarnation: Uuid,
        epoch: Uuid,
        expires_at_ms: i64,
    },
    PinEpochClosed {
        surface_id: Uuid,
        incarnation: Uuid,
    },
    PinMediaClaimed {
        surface_id: Uuid,
        incarnation: Uuid,
    },
    BrowserEpochOpened {
        surface_id: Uuid,
        incarnation: Uuid,
        epoch: Uuid,
    },
    InputAdmitted {
        surface_id: Uuid,
        epoch: Uuid,
        sequence: u64,
        instance_id: Uuid,
        request_digest: String,
    },
    ControlAdmitted {
        surface_id: Uuid,
        epoch: Uuid,
        sequence: u64,
        instance_id: Uuid,
        control_digest: String,
    },
    TurnBegan {
        turn_id: Uuid,
        generation: u64,
        origin: Uuid,
        request_digest: String,
        privacy: PrivacyClass,
    },
    EchoGuarded {
        action_id: Uuid,
        expires_at_ms: i64,
        privacy: PrivacyClass,
    },
    EchoRejected {
        request_id: Uuid,
        origin: Uuid,
        action_id: Uuid,
        privacy: PrivacyClass,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stamp: Option<InputStamp>,
    },
    EchoExpired {
        action_id: Uuid,
        privacy: PrivacyClass,
    },
    AnalysisStarted {
        turn_id: Uuid,
        generation: u64,
        input_digest: String,
        privacy: PrivacyClass,
    },
    AnalysisCompleted {
        turn_id: Uuid,
        generation: u64,
        output_digest: String,
        privacy: PrivacyClass,
    },
    Decision {
        turn_id: Uuid,
        generation: u64,
        action_id: Option<Uuid>,
        privacy: PrivacyClass,
        /// The content shape the runtime bound for this reply, and the row of
        /// the published fit table every candidate below was scored against.
        /// Absent on decisions logged before the runtime bound one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape: Option<policy::Shape>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<policy::RoutingTarget>,
        /// The runtime's own shared-safe expression, routed at the shared
        /// class while the turn itself stays above it.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        expression: bool,
        candidates: Vec<Candidate>,
    },
    NativeVisibility {
        surface_id: Uuid,
        incarnation: Uuid,
        visible: bool,
    },
    ActionChanged {
        action_id: Uuid,
        turn_id: Uuid,
        generation: u64,
        status: ActionStatus,
        channel: Channel,
        surface_id: Uuid,
        incarnation: Uuid,
        content_digest: String,
        deadline_ms: i64,
        attempt: u8,
    },
    DeliveryFailed {
        action_id: Uuid,
        generation: u64,
    },
    TurnCancelled {
        turn_id: Uuid,
        generation: u64,
    },
    TurnFinished {
        turn_id: Uuid,
        generation: u64,
    },
    PayloadCleared {
        action_id: Uuid,
        content_digest: String,
    },
    DisplayConfirmationProposed {
        visual_root: Uuid,
        visual_action: Uuid,
        action_id: Uuid,
    },
    Repair {
        previous_action: Uuid,
        action_id: Uuid,
        surface_id: Uuid,
        candidates: Vec<Candidate>,
    },
}
fn action_event(action: &Action) -> RuntimeData {
    RuntimeData::ActionChanged {
        action_id: action.id,
        turn_id: action.turn_id,
        generation: action.generation,
        status: action.status,
        channel: action.channel,
        surface_id: action.surface_id,
        incarnation: action.incarnation,
        content_digest: action.content_digest.clone(),
        deadline_ms: action.deadline_ms,
        attempt: action.attempts,
    }
}
/// The bound command a proposal carries, when it is an action at all.
fn bound_operation(intent: &SemanticIntent) -> Option<&super::action::Operation> {
    match intent {
        SemanticIntent::DeviceAction { operation } => Some(operation),
        _ => None,
    }
}

pub(super) fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn browser_record<'a>(
    records: &'a BTreeMap<Uuid, Record>,
    proof: &BrowserProof,
    now: i64,
) -> Result<&'a Record, RuntimeError> {
    let record = records
        .get(&proof.surface_id)
        .ok_or(RuntimeError::InvalidOrigin)?;
    let same = proof.token_hash.len() == record.token_hash.len()
        && proof
            .token_hash
            .bytes()
            .zip(record.token_hash.bytes())
            .fold(0u8, |a, (b, c)| a | (b ^ c))
            == 0;
    if !digest_valid(&proof.token_hash)
        || !same
        || proof.incarnation != record.incarnation
        || !matches!(record.binding, Binding::Browser)
        || record.revoked
        || record.left
        || now >= record.connection_expires_at
        || now >= record.lease_expires_at
        || !crate::surface_registry::known_browser_manifest(&record.approved_manifest)
    {
        return Err(RuntimeError::InvalidOrigin);
    }
    Ok(record)
}
impl RuntimeState {
    pub(super) fn room_record<'a>(
        &self,
        records: &'a BTreeMap<Uuid, Record>,
        connection: &RoomProof,
        now: i64,
    ) -> Result<&'a Record, RuntimeError> {
        match connection {
            RoomProof::Browser(proof) => browser_record(records, proof, now),
            RoomProof::Native(proof) => {
                let current = self.check_native(records, proof, now)?;
                self.ingress
                    .get(&proof.surface_id)
                    .filter(|cursor| {
                        cursor.incarnation == current.incarnation && cursor.epoch == current.epoch
                    })
                    .ok_or(RuntimeError::Stale)?;
                records
                    .get(&proof.surface_id)
                    .ok_or(RuntimeError::InvalidOrigin)
            }
        }
    }

    /// Whether anything can be sent to this surface right now, whether its
    /// own app reports itself in front of someone, and the incarnation an
    /// action must bind to. A native binds to its signed connection; the
    /// registry record stays nil. Reachability blocks; attention only ranks.
    pub(super) fn presence(&self, record: &Record, now: i64) -> policy::Presence {
        match record.binding {
            Binding::Browser => policy::Presence {
                reachable: record.view(now).connected,
                attended: record.view(now).connected && record.visible,
                incarnation: record.incarnation,
            },
            // A worn device has no foreground to lose and nothing to report
            // about one, so there is no attention to penalise: its manifest
            // declares no foreground constraint because it has none.
            Binding::Pin { .. } => policy::Presence {
                reachable: !record.revoked,
                attended: !record.revoked,
                incarnation: record.incarnation,
            },
            Binding::Native { .. } => {
                let connection = self
                    .native_connections
                    .get(&record.surface_id)
                    .and_then(|state| state.connection.as_ref())
                    .filter(|connection| connection.current(record, now));
                policy::Presence {
                    reachable: connection.is_some(),
                    attended: connection.is_some_and(|connection| connection.visible),
                    incarnation: connection
                        .map_or(Uuid::nil(), |connection| connection.incarnation),
                }
            }
        }
    }

    /// One candidate for one record, for the channel and shape the runtime
    /// bound. Everything read here is the record, its approved manifest, its
    /// connection, the owner's own permissions and this turn — never the
    /// request's words, never where the surface runs. `operation` is absent
    /// only when the runtime is asking whether a kind of command could be
    /// carried out at all, before there is one to bind.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn candidate(
        &self,
        records: &BTreeMap<Uuid, Record>,
        record: &Record,
        origin: Uuid,
        channel: Channel,
        shape: policy::Shape,
        privacy: PrivacyClass,
        hint: Option<policy::RoutingTarget>,
        operation: Option<&super::action::Operation>,
        now: i64,
    ) -> Candidate {
        let mut presence = self.presence(record, now);
        // Native speech exists only as the runtime's own disclosed synthesis.
        // Without the origin owner's current provider permission there is no
        // speech to route, so the surface is unavailable for that channel.
        if channel == Channel::AudioTts && matches!(record.binding, Binding::Native { .. }) {
            presence.reachable = presence.reachable
                && self
                    .disclosure_policy(records, origin)
                    .ok()
                    .flatten()
                    .and_then(|approval| approval.policy)
                    .is_some_and(|policy| policy.synthesis && privacy <= policy.maximum_class);
        }
        // An action channel exists for an installation only where the owner's
        // own permission for it stands at the installation's current approval
        // revision, and where that permission admits this exact command.
        if channel.is_action() {
            presence.reachable = presence.reachable
                && match operation {
                    Some(operation) => {
                        operation.channel() == channel
                            && self.action_permits(records, record.surface_id, operation)
                    }
                    None => self
                        .action_channels(records, record.surface_id)
                        .contains(&channel),
                };
        }
        policy::candidate(record, presence, origin, channel, shape, privacy, hint)
    }

    /// Store transactions apply runtime admission and visibility together. A
    /// failed registry transition must discard this working copy as well.
    pub fn apply_with_registry(
        &mut self,
        principal: &str,
        records: &mut BTreeMap<Uuid, Record>,
        operation: RuntimeOperation,
        now: i64,
    ) -> Result<RuntimeTransition, RuntimeError> {
        let mutation = match &operation {
            RuntimeOperation::RoomControl {
                connection: RoomProof::Browser(connection),
                stamp,
                control: BrowserControl::State { visible },
            } => Some((
                connection.surface_id,
                crate::surface_registry::Mutation::State {
                    token_hash: connection.token_hash.clone(),
                    incarnation: connection.incarnation,
                    sequence: stamp.sequence,
                    visible: *visible,
                },
            )),
            _ => None,
        };
        let (result, mut events) = self.apply(principal, records, operation, now)?;
        let mut changed = None;
        if matches!(result, RuntimeResult::ControlAccepted { duplicate: false })
            && let Some((id, mutation)) = mutation
        {
            let (record, kind) =
                crate::surface_registry::transition(records.get(&id), 0, id, &mutation, now)
                    .map_err(|_| RuntimeError::Stale)?;
            records.insert(id, record.clone());
            changed = kind.map(|kind| (record, kind));
            events.extend(self.reconcile(records, now));
        }
        Ok(RuntimeTransition {
            result,
            events,
            surface: changed,
        })
    }

    /// Due-time projection for the indexed maintenance queue. Policy remains
    /// in reconcile; this only schedules the next authoritative recheck.
    pub fn next_maintenance_ms(&self, records: &BTreeMap<Uuid, Record>) -> i64 {
        let mut due = self
            .echoes
            .iter()
            .map(|e| e.expires_at_ms)
            .min()
            .unwrap_or(i64::MAX);
        due = due.min(self.native_maintenance_ms());
        for connection in self.pin_connections.values().filter(|c| !c.closed) {
            due = due.min(connection.expires_at_ms);
        }
        for grant in self.grants.values().filter(|grant| !grant.consumed) {
            due = due.min(grant.expires_at_ms);
        }
        if let Some(turn) = self.turn.as_ref().filter(|t| !t.cancelled) {
            due = due.min(turn.lease_until_ms);
            if let Some(voice) = turn.voice.as_ref().filter(|_| turn.voice_pending()) {
                due = due.min(voice.expires_at_ms);
            }
            if let Some(lookup) = turn.lookup.as_ref().filter(|_| turn.lookup_pending()) {
                due = due.min(lookup.deadline_ms());
            }
            if let Some(visual) = turn
                .lookup
                .as_ref()
                .and_then(|lookup| lookup.receipt.as_ref())
                .and_then(|receipt| receipt.visual.as_ref())
            {
                due = due.min(visual.expires_at_ms);
            }
            if let Some(origin) = records.get(&turn.fence.origin_surface) {
                if matches!(origin.binding, Binding::Browser) {
                    due = due
                        .min(origin.lease_expires_at)
                        .min(origin.connection_expires_at);
                }
            } else {
                return 0;
            }
        }
        for action in self.actions.values() {
            if action.status.terminal() {
                if action.intent.has_payload() {
                    return 0;
                }
                continue;
            }
            due = due.min(action.display_expires_at_ms);
            if action.live() {
                due = due.min(action.deadline_ms);
            }
            if let Some(record) = records.get(&action.surface_id) {
                if matches!(record.binding, Binding::Browser) {
                    due = due
                        .min(record.lease_expires_at)
                        .min(record.connection_expires_at);
                }
            } else {
                return 0;
            }
        }
        due
    }

    /// Terminal payloads are erased before the transaction commits. A stock
    /// dispatch caller owns a separate one-use payload clone, never a replay.
    pub fn clear_terminal_payloads(&mut self) -> Vec<RuntimeData> {
        let mut events = Vec::new();
        for action in self.actions.values_mut() {
            if action.status.terminal() && action.intent.has_payload() {
                action.intent.clear_payload();
                events.push(RuntimeData::PayloadCleared {
                    action_id: action.id,
                    content_digest: action.content_digest.clone(),
                });
            }
        }
        events
    }
    /// Bounded owner memory: at most one entry per kind, newest wins, so a
    /// remembered list and a remembered place query coexist for ten minutes.
    pub(super) fn remember(&mut self, context: RecentContext) {
        self.recent_context.retain(|c| c.kind != context.kind);
        self.recent_context.push(context);
        self.recent_context.sort_by_key(|c| c.kind);
        while self.recent_context.len() > MAX_RECENT_CONTEXT {
            self.recent_context.remove(0);
        }
    }

    pub(super) fn fence(
        &self,
        turn_id: Uuid,
        generation: u64,
        worker: Uuid,
        now: i64,
    ) -> Result<&Turn, RuntimeError> {
        self.turn
            .as_ref()
            .filter(|t| {
                !t.cancelled
                    && t.fence.turn_id == turn_id
                    && t.fence.generation == generation
                    && t.fence.worker == worker
                    && self.generation == generation
                    && now < t.lease_until_ms
            })
            .ok_or(RuntimeError::Stale)
    }
    pub(super) fn origin_valid(
        &self,
        turn: &Turn,
        records: &BTreeMap<Uuid, Record>,
        now: i64,
    ) -> bool {
        self.lookup_authority_valid(turn, records, now)
            && records.get(&turn.fence.origin_surface).is_some_and(|r| {
                !r.revoked
                    && match r.binding {
                        Binding::Browser => {
                            r.incarnation == turn.origin_incarnation && r.view(now).available
                        }
                        Binding::Pin { .. } => {
                            r.revision == turn.origin_revision
                                && turn.pin_incarnation.is_none_or(|incarnation| {
                                    self.pin_connections.get(&r.surface_id).is_some_and(|c| {
                                        c.incarnation == incarnation && c.current(r, now)
                                    })
                                })
                        }
                        Binding::Native { .. } => {
                            r.revision == turn.origin_revision
                                && self
                                    .native_connections
                                    .get(&r.surface_id)
                                    .and_then(|state| state.connection.as_ref())
                                    .is_some_and(|connection| {
                                        connection.incarnation == turn.origin_incarnation
                                            && connection.current(r, now)
                                            && self.ingress.get(&r.surface_id).is_some_and(
                                                |cursor| {
                                                    cursor.incarnation == connection.incarnation
                                                        && cursor.epoch == connection.epoch
                                                },
                                            )
                                    })
                        }
                    }
            })
    }
    /// Called inside both registry and runtime transactions. Ordinary visible
    /// heartbeats do not alter the origin incarnation or eligibility.
    pub fn reconcile(&mut self, records: &BTreeMap<Uuid, Record>, now: i64) -> Vec<RuntimeData> {
        let mut events = self.reconcile_native(records, now);
        self.recent_context.retain(|c| now < c.expires_at_ms);
        for (id, connection) in &mut self.pin_connections {
            if !connection.closed && !records.get(id).is_some_and(|r| connection.current(r, now)) {
                connection.closed = true;
                events.push(RuntimeData::PinEpochClosed {
                    surface_id: *id,
                    incarnation: connection.incarnation,
                });
            }
        }
        // Revoked approvals cannot accumulate retired connection state. An
        // old open still fails its approval-revision check after reapproval.
        self.pin_connections.retain(|id, connection| {
            records
                .get(id)
                .is_some_and(|r| !r.revoked && r.revision == connection.approval_revision)
        });
        self.disclosure_policies.retain(|id, approval| {
            records
                .get(id)
                .is_some_and(|r| !r.revoked && r.revision == approval.approval_revision)
        });
        self.voice_policies.retain(|id, approval| {
            records
                .get(id)
                .is_some_and(|r| !r.revoked && r.revision == approval.approval_revision)
        });
        self.native_voice_policies.retain(|id, approval| {
            records
                .get(id)
                .is_some_and(|r| !r.revoked && r.revision == approval.approval_revision)
        });
        self.private_policies.retain(|id, approval| {
            records
                .get(id)
                .is_some_and(|r| !r.revoked && r.revision == approval.approval_revision)
        });
        self.screen_context_policies.retain(|id, approval| {
            records
                .get(id)
                .is_some_and(|r| !r.revoked && r.revision == approval.approval_revision)
        });
        self.device_action_policies.retain(|id, approval| {
            records
                .get(id)
                .is_some_and(|r| !r.revoked && r.revision == approval.approval_revision)
        });
        self.device_command_policies.retain(|id, approval| {
            records
                .get(id)
                .is_some_and(|r| !r.revoked && r.revision == approval.approval_revision)
        });

        self.reconcile_lookup_policies(records);
        self.ingress.retain(|id, cursor| {
            records.get(id).is_some_and(|r| {
                !r.revoked
                    && match r.binding {
                        Binding::Browser => r.incarnation == cursor.incarnation,
                        Binding::Pin { .. } => self
                            .pin_connections
                            .get(id)
                            .is_some_and(|c| c.incarnation == cursor.incarnation),
                        Binding::Native { .. } => self
                            .native_connections
                            .get(id)
                            .and_then(|state| state.connection.as_ref())
                            .is_some_and(|c| c.incarnation == cursor.incarnation),
                    }
            })
        });
        self.echoes.retain(|echo| {
            if now < echo.expires_at_ms {
                return true;
            }
            events.push(RuntimeData::EchoExpired {
                action_id: echo.action_id,
                privacy: echo.privacy,
            });
            false
        });
        let mut repairs = Vec::new();
        let origin_valid = self.turn.as_ref().is_some_and(|t| {
            !t.cancelled
                && now < t.lease_until_ms
                && self.origin_valid(t, records, now)
                && self.voice_valid(t, now)
        });
        if !origin_valid {
            if let Some(turn) = self.turn.as_mut().filter(|t| !t.cancelled) {
                turn.cancelled = true;
                events.push(RuntimeData::TurnCancelled {
                    turn_id: turn.fence.turn_id,
                    generation: turn.fence.generation,
                });
            }
        }
        let confirmed_roots: BTreeSet<_> = self
            .actions
            .values()
            .filter_map(|action| action.confirmation_root)
            .filter(|root| self.acknowledged_visual(records, *root, now).is_some())
            .collect();
        // Dispatch-time revalidation reads current presence before any
        // action mutates; a target that lost its foreground is repaired. A
        // raised turn class retires shared outputs proposed below it, except
        // the runtime's own shared-safe expression.
        let turn_privacy = self
            .turn
            .as_ref()
            .map_or(PrivacyClass::Public, |t| t.privacy);
        let validity: BTreeMap<Uuid, bool> = self
            .actions
            .values()
            .map(|action| {
                let class = if action.expression {
                    action.privacy
                } else {
                    action.privacy.max(turn_privacy)
                };
                let valid = origin_valid
                    && action
                        .confirmation_root
                        .is_none_or(|root| confirmed_roots.contains(&root))
                    && now < action.display_expires_at_ms
                    && self
                        .turn
                        .as_ref()
                        .is_some_and(|t| t.fence.generation == action.generation)
                    // A card exists on a screen only while that screen's own
                    // foreground is reported. It may be held for a screen
                    // nobody has come to yet; once it is there, walking away
                    // masks it and the logged fallback receives it. An effect
                    // already begun continues, because launching a player or
                    // a map puts Cosmos itself in the background.
                    && (action.channel != Channel::VisualCard
                        || action.status == ActionStatus::Proposed
                        || self.surface_visible(records, action.surface_id, now))
                    && records.get(&action.surface_id).is_some_and(|r| {
                        self.presence(r, now).incarnation == action.incarnation
                            && self
                                .candidate(
                                    records,
                                    r,
                                    self.turn.as_ref().unwrap().fence.origin_surface,
                                    action.channel,
                                    policy::shape(&action.intent),
                                    class,
                                    None,
                                    bound_operation(&action.intent),
                                    now,
                                )
                                .blocker
                                .is_none()
                    });
                (action.id, valid)
            })
            .collect();
        let mut revoked = Vec::new();
        for action in self.actions.values_mut() {
            if action.status.terminal() {
                continue;
            }
            let valid = validity[&action.id];
            if !valid {
                // P7: a side-effecting action never repairs to another
                // device. Its fallbacks are still computed and logged in the
                // decision; they are simply never dispatched to.
                let repair = origin_valid
                    && now < action.display_expires_at_ms
                    && action.privacy <= PrivacyClass::SharedRoom
                    && action.channel == Channel::VisualCard
                    && matches!(
                        action.status,
                        ActionStatus::Proposed | ActionStatus::Dispatched
                    );
                let unknown = (action.channel == Channel::AudioTts || action.channel.is_action())
                    && action.attempts > 0;
                action.status = if unknown {
                    ActionStatus::OutcomeUnknown
                } else {
                    ActionStatus::Cancelled
                };
                if action.channel.is_action() {
                    action.revoked = Some(if origin_valid {
                        super::action::RevokeReason::RevalidationFailed
                    } else {
                        super::action::RevokeReason::Cancelled
                    });
                    revoked.push(action.clone());
                }
                events.push(action_event(action));
                if repair {
                    repairs.push(action.clone());
                }
            } else if matches!(
                action.status,
                ActionStatus::Proposed | ActionStatus::AwaitingGrant
            ) && now >= action.deadline_ms
            {
                action.status = if action.attempts > 0 {
                    ActionStatus::OutcomeUnknown
                } else {
                    ActionStatus::Cancelled
                };
                if action.channel.is_action() {
                    action.revoked = Some(super::action::RevokeReason::Expired);
                    revoked.push(action.clone());
                }
                events.push(action_event(action));
                if action.channel == Channel::VisualCard {
                    repairs.push(action.clone());
                }
            } else if (action.status == ActionStatus::Dispatched
                // An acknowledged card lives out its display window; an
                // acknowledged command owes a report inside the channel's own
                // budget, and a running one inside its progress grace.
                || (action.channel.is_action()
                    && matches!(
                        action.status,
                        ActionStatus::Acknowledged | ActionStatus::Running
                    )))
                && now >= action.deadline_ms
            {
                // Retry only on this exact surface/key, and only where the
                // channel declares itself idempotent. `action.run` never
                // retries; a missing report is unknown, never a second run.
                let retry = action.attempts == 1
                    && action.status == ActionStatus::Dispatched
                    && (action.channel == Channel::VisualCard || action.channel.idempotent());
                if retry {
                    // Poll reclaims under policy, then gives the same key
                    // another bounded deadline.
                    action.status = ActionStatus::Proposed;
                    action.deadline_ms =
                        now.saturating_add(ACK_MS).min(action.display_expires_at_ms);
                } else {
                    action.status = ActionStatus::OutcomeUnknown;
                    if action.channel == Channel::VisualCard {
                        repairs.push(action.clone());
                    }
                    if action.channel.is_action() {
                        action.revoked = Some(super::action::RevokeReason::Expired);
                        revoked.push(action.clone());
                    }
                }
                events.push(action_event(action));
            }
        }
        for action in revoked {
            events.extend(self.record_revocation(&action, now));
        }
        events.extend(self.reconcile_grants(now));
        self.revocations
            .retain(|revocation| now < revocation.expires_at_ms);
        for previous in repairs {
            if self.actions.len() >= MAX_ACTIONS {
                continue;
            }
            let origin = self.turn.as_ref().unwrap().fence.origin_surface;
            let candidates: Vec<_> = previous
                .fallbacks
                .iter()
                .filter_map(|id| records.get(id))
                .map(|r| {
                    self.candidate(
                        records,
                        r,
                        origin,
                        previous.channel,
                        policy::shape(&previous.intent),
                        previous.privacy,
                        None,
                        bound_operation(&previous.intent),
                        now,
                    )
                })
                .collect();
            if let Some(selected) = candidates.iter().find(|c| c.blocker.is_none()) {
                let mut action = previous.clone();
                action.id = Uuid::new_v4();
                action.surface_id = selected.surface_id;
                action.incarnation = self
                    .presence(&records[&selected.surface_id], now)
                    .incarnation;
                action.status = ActionStatus::Proposed;
                action.attempts = 0;
                // The fallback is held on the same terms the lead was: the
                // acknowledgment clock for a screen someone is in front of,
                // and the longer wait for one that has to come forward.
                action.deadline_ms = now
                    .saturating_add(
                        if self.presence(&records[&selected.surface_id], now).attended {
                            ACK_MS
                        } else {
                            ATTENDED_WAIT_MS
                        },
                    )
                    .min(action.display_expires_at_ms);
                action.fallbacks.retain(|id| *id != selected.surface_id);
                events.push(RuntimeData::Repair {
                    previous_action: previous.id,
                    action_id: action.id,
                    surface_id: selected.surface_id,
                    candidates,
                });
                self.actions.insert(action.id, action);
            }
        }
        if let Some(turn) = self.turn.as_mut() {
            if !turn.cancelled
                && !turn.finished
                && !self.actions.is_empty()
                && records
                    .get(&turn.fence.origin_surface)
                    .is_some_and(|r| matches!(r.binding, Binding::Browser | Binding::Native { .. }))
                && self.actions.values().all(|a| !a.live())
            {
                turn.finished = true;
                events.push(RuntimeData::TurnFinished {
                    turn_id: turn.fence.turn_id,
                    generation: turn.fence.generation,
                });
            }
        }
        events.extend(self.clear_terminal_payloads());
        events
    }

    /// Remember that one installation must be told to stop, and log it. The
    /// row outlives the action, because a new turn clears the action first.
    fn record_revocation(&mut self, action: &Action, now: i64) -> Vec<RuntimeData> {
        let Some(reason) = action.revoked else {
            return Vec::new();
        };
        if !action.started() && action.attempts == 0 {
            // Nothing was ever sent, so there is nothing to stop.
            return vec![RuntimeData::EffectRevoked {
                action_id: action.id,
                reason,
            }];
        }
        self.revocations.retain(|r| r.action_id != action.id);
        self.revocations.push(Revocation {
            action_id: action.id,
            surface_id: action.surface_id,
            incarnation: action.incarnation,
            reason,
            expires_at_ms: now.saturating_add(REVOCATION_MS),
        });
        while self.revocations.len() > MAX_REVOCATIONS {
            self.revocations.remove(0);
        }
        vec![RuntimeData::EffectRevoked {
            action_id: action.id,
            reason,
        }]
    }

    /// Retire one action-channel action and tell its installation to stop.
    pub(super) fn revoke_action(
        &mut self,
        action_id: Uuid,
        reason: super::action::RevokeReason,
        now: i64,
    ) -> Vec<RuntimeData> {
        let Some(action) = self.actions.get_mut(&action_id) else {
            return Vec::new();
        };
        if action.status.terminal() {
            return Vec::new();
        }
        let unknown = action.channel.is_action() && action.started();
        action.status = if unknown {
            ActionStatus::OutcomeUnknown
        } else {
            ActionStatus::Cancelled
        };
        action.revoked = Some(reason);
        let action = action.clone();
        let mut events = vec![action_event(&action)];
        events.extend(self.record_revocation(&action, now));
        events
    }
    pub(super) fn claim(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        id: Uuid,
        generation: u64,
        worker: Uuid,
        now: i64,
        native_speech: bool,
    ) -> Result<(Action, Vec<RuntimeData>), RuntimeError> {
        let action = self.actions.get(&id).ok_or(RuntimeError::NotFound)?;
        let turn = self.fence(action.turn_id, generation, worker, now)?;
        // A command that always confirms is claimable only once its own
        // ceremony has been answered at the installation that will act.
        let ready = action.status == ActionStatus::Proposed
            || (action.status == ActionStatus::AwaitingGrant && action.channel.needs_grant());
        if turn.finished
            || turn.voice_pending()
            || action.generation != generation
            || action.worker != worker
            || !ready
            || !self.granted(id, now)
            || !self.origin_valid(turn, records, now)
        {
            return Err(RuntimeError::Stale);
        }
        // Visibility is required to begin. No platform starts a command in
        // the background, and a command must not be dispatched to a screen
        // nobody is looking at.
        if action.channel.needs_foreground()
            && !self.surface_visible(records, action.surface_id, now)
        {
            return Err(RuntimeError::PolicyBlocked);
        }
        // §4.5(d)'s residual risk is accumulated low-risk actions; §10's
        // answer is a per-principal budget. One effect at a time, six in ten
        // minutes. The origin hears the ordinary understated acknowledgment.
        if action.channel.is_action() && self.action_budget_blocked(now) {
            return Err(RuntimeError::PolicyBlocked);
        }
        if native_speech
            && (!Self::disclosed_speech_origin(records, turn)
                || action.channel != Channel::AudioTts
                || !Self::disclosed_speech_target(
                    records,
                    turn.fence.origin_surface,
                    action.surface_id,
                ))
        {
            return Err(RuntimeError::PolicyBlocked);
        }
        let record = records
            .get(&action.surface_id)
            .ok_or(RuntimeError::PolicyBlocked)?;
        if self.presence(record, now).incarnation != action.incarnation
            || self
                .candidate(
                    records,
                    record,
                    turn.fence.origin_surface,
                    action.channel,
                    policy::shape(&action.intent),
                    action.privacy,
                    None,
                    bound_operation(&action.intent),
                    now,
                )
                .blocker
                .is_some()
        {
            return Err(RuntimeError::PolicyBlocked);
        }
        let mut events = Vec::new();
        if action.channel == Channel::AudioTts {
            if self.echoes.len() >= super::echo::MAX_WINDOWS {
                return Err(RuntimeError::Busy);
            }
            let expires_at_ms = now
                .checked_add(super::echo::WINDOW_MS)
                .ok_or(RuntimeError::Unavailable)?;
            self.echoes.push(super::echo::Window {
                action_id: action.id,
                fingerprint: super::echo::fingerprint(action.intent.text()),
                expires_at_ms,
                privacy: action.privacy,
            });
            events.push(RuntimeData::EchoGuarded {
                action_id: action.id,
                expires_at_ms,
                privacy: action.privacy,
            });
        }
        let action = self.actions.get_mut(&id).unwrap();
        action.attempts += 1;
        action.deadline_ms = if native_speech {
            action.display_expires_at_ms
        } else {
            now.checked_add(ACK_MS)
                .ok_or(RuntimeError::Unavailable)?
                .min(action.display_expires_at_ms)
        };
        action.status = if action.channel == Channel::AudioTts && !native_speech {
            ActionStatus::OutcomeUnknown
        } else {
            ActionStatus::Dispatched
        };
        action.dispatched_at_ms = now;
        let dispatched = action.clone();
        events.push(action_event(action));
        if dispatched.channel.is_action() {
            // The grant is single-use and is consumed in the same transaction
            // that dispatches the command it authorized.
            self.consume_grant(id, now);
            self.action_budget.spend(now);
            // The effect's own turn stays live while the device works: the
            // lease is renewed here and again by every accepted progress, so
            // a long command never needs an effect timer of its own.
            self.renew_lease(now);
        }
        Ok((dispatched, events))
    }

    /// Whether a new device action may begin at all: one effect in flight per
    /// principal, six dispatched in the rolling window.
    pub(super) fn action_budget_blocked(&self, now: i64) -> bool {
        self.action_budget.exhausted(now)
            || self.actions.values().any(|a| {
                a.channel.is_action()
                    && matches!(
                        a.status,
                        ActionStatus::Dispatched
                            | ActionStatus::Acknowledged
                            | ActionStatus::Running
                    )
            })
    }

    /// The worker lease is stamped once when a turn begins; a device action
    /// renews it so the effect's own turn is still there to receive its
    /// outcome. The registry heartbeat stays hygiene and is never the
    /// in-flight detector.
    fn renew_lease(&mut self, now: i64) {
        if let Some(turn) = self.turn.as_mut().filter(|t| !t.cancelled) {
            turn.lease_until_ms = turn.lease_until_ms.max(now.saturating_add(WORKER_LEASE_MS));
        }
    }
    fn acknowledged_visual(
        &self,
        records: &BTreeMap<Uuid, Record>,
        root_id: Uuid,
        now: i64,
    ) -> Option<&Action> {
        let turn = self.turn.as_ref()?;
        let root = self.actions.get(&root_id)?;
        if turn.cancelled
            || now >= turn.lease_until_ms
            || !self.origin_valid(turn, records, now)
            || root.id != root.root_id
            || root.channel != Channel::VisualCard
            || root.turn_id != turn.fence.turn_id
            || root.generation != turn.fence.generation
            || root.worker != turn.fence.worker
        {
            return None;
        }
        self.actions.values().find(|action| {
            action.status == ActionStatus::Acknowledged
                && action.channel == Channel::VisualCard
                && action.root_id == root.id
                && action.content_digest == root.content_digest
                && action.intent.valid()
                && action.intent.content_digest() == root.content_digest
                && action.turn_id == root.turn_id
                && action.generation == root.generation
                && action.worker == root.worker
                && now < action.display_expires_at_ms
                && records.get(&action.surface_id).is_some_and(|record| {
                    self.presence(record, now).incarnation == action.incarnation
                        && self
                            .candidate(
                                records,
                                record,
                                turn.fence.origin_surface,
                                action.channel,
                                policy::shape(&action.intent),
                                action.privacy,
                                None,
                                bound_operation(&action.intent),
                                now,
                            )
                            .blocker
                            .is_none()
                })
        })
    }

    fn propose_output(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        fence: &TurnFence,
        output: OutputProposal,
        now: i64,
    ) -> Result<(RuntimeResult, Vec<RuntimeData>), RuntimeError> {
        let turn_id = fence.turn_id;
        let generation = fence.generation;
        let worker = fence.worker;
        let OutputProposal {
            intent,
            privacy,
            confirmation,
            hint,
            expression,
        } = output;
        let mut events = Vec::new();
        let turn = self.fence(turn_id, generation, worker, now)?;
        let origin_surface = turn.fence.origin_surface;
        if turn.finished || turn.voice_pending() || !self.origin_valid(turn, records, now) {
            return Err(RuntimeError::Stale);
        }
        if turn
            .analysis
            .as_ref()
            .is_some_and(|a| a.output_digest.is_none())
            || turn.lookup_pending()
        {
            return Err(RuntimeError::Busy);
        }
        if !intent.valid() || self.actions.len() >= MAX_ACTIONS {
            return Err(RuntimeError::InvalidRequest);
        }
        match &intent {
            SemanticIntent::PlaceAddressCard { content } => {
                let matching = turn.lookup.as_ref().is_some_and(|lookup| {
                    lookup.request.provider.provider.service() == LookupService::Places
                        && lookup.receipt.as_ref().is_some_and(|receipt| {
                            receipt.visual.as_ref() == Some(content) && now < content.expires_at_ms
                        })
                });
                if !matching {
                    return Err(RuntimeError::PolicyBlocked);
                }
            }
            SemanticIntent::InformationalSpeech { .. }
            | SemanticIntent::VisualTextCard { .. }
            | SemanticIntent::ChoiceList { .. }
                if turn.completed_places_lookup() && confirmation.is_none() =>
            {
                return Err(RuntimeError::PolicyBlocked);
            }
            // A completed place lookup produces its own card, or the route
            // the same call already asked for. Nothing else.
            SemanticIntent::DeviceAction { operation }
                if turn.completed_places_lookup()
                    && operation.kind() != super::action::OperationKind::Route =>
            {
                return Err(RuntimeError::PolicyBlocked);
            }
            _ => {}
        }
        // A shared-safe expression is the runtime's own fixed text; the turn
        // keeps its higher class and the expression never names it.
        let privacy = if expression {
            PrivacyClass::SharedRoom
        } else {
            turn.privacy.max(privacy)
        };
        if intent.channel() == Channel::VisualCard
            && privacy <= PrivacyClass::SharedRoom
            && self.actions.values().any(|a| {
                a.channel == Channel::VisualCard
                    && matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched)
            })
        {
            return Err(RuntimeError::Busy);
        }
        // The runtime binds one shape for this reply, from the intent it has
        // already validated, and every candidate below is scored against it.
        let shape = policy::shape(&intent);
        let mut candidates: Vec<_> = records
            .values()
            .filter(|r| !r.revoked)
            .map(|r| {
                self.candidate(
                    records,
                    r,
                    turn.fence.origin_surface,
                    intent.channel(),
                    shape,
                    privacy,
                    hint,
                    bound_operation(&intent),
                    now,
                )
            })
            .collect();
        policy::rank(&mut candidates);
        let selected = candidates
            .iter()
            .find(|c| c.blocker.is_none())
            .map(|c| c.surface_id);
        let fallbacks = candidates
            .iter()
            .filter(|c| c.blocker.is_none() && Some(c.surface_id) != selected)
            .map(|c| c.surface_id)
            .collect();
        let id = selected.map(|_| Uuid::new_v4());
        events.push(RuntimeData::Decision {
            turn_id,
            generation,
            action_id: id,
            privacy,
            shape: Some(shape),
            hint,
            expression,
            candidates,
        });
        if !expression {
            self.turn.as_mut().unwrap().privacy = privacy;
        }
        events.extend(self.reconcile(records, now));
        let result = if let (Some(surface_id), Some(id)) = (selected, id) {
            if intent.channel() == Channel::VisualCard {
                for old in self.actions.values_mut().filter(|a| {
                    a.channel == Channel::VisualCard && a.status == ActionStatus::Acknowledged
                }) {
                    old.status = ActionStatus::Cancelled;
                    events.push(action_event(old));
                }
            }
            let record = &records[&surface_id];
            let presence = self.presence(record, now);
            let incarnation = presence.incarnation;
            // A content reference is authority for exactly the surface this
            // decision named; it is checked again when the content is fetched.
            let intent = match intent {
                SemanticIntent::PlaceAddressCard { content } => SemanticIntent::PlaceAddressCard {
                    content: content.for_audience(surface_id),
                },
                other => other,
            };
            let content_digest = intent.content_digest();
            // A private card waits for its personal surface's unlocked
            // foreground; a shared card is renewed or repaired within a minute.
            // An action waits the same way whatever its class, because a
            // phone or a Mac cannot begin one in the background, and it then
            // has the channel's own budget to say what happened.
            let waiting = intent.channel().needs_foreground() || privacy > PrivacyClass::SharedRoom;
            let window = if waiting {
                super::personal::PRIVATE_DISPLAY_MS
            } else {
                60_000
            };
            let window = window.saturating_add(
                bound_operation(&intent).map_or(0, super::action::Operation::report_budget_ms),
            );
            let display_expires_at_ms = match &intent {
                SemanticIntent::PlaceAddressCard { content } => content.expires_at_ms,
                _ => now.checked_add(window).ok_or(RuntimeError::Unavailable)?,
            };
            let display_expires_at_ms = confirmation
                .as_ref()
                .map_or(display_expires_at_ms, |confirmation| {
                    display_expires_at_ms.min(confirmation.expires_at_ms)
                });
            let channel = intent.channel();
            let action = Action {
                id,
                root_id: id,
                turn_id,
                generation,
                worker,
                surface_id,
                channel,
                incarnation,
                content_digest,
                intent,
                privacy,
                status: if channel.needs_grant() {
                    ActionStatus::AwaitingGrant
                } else {
                    ActionStatus::Proposed
                },
                // A card the chosen screen is not in front of yet is held for
                // it, the way a private card already is, and for long enough
                // that walking over to it is an answer. If nobody comes,
                // reconcile repairs it to the next logged fallback.
                deadline_ms: now
                    .checked_add(if waiting {
                        super::personal::PRIVATE_DISPLAY_MS
                    } else if presence.attended {
                        ACK_MS
                    } else {
                        ATTENDED_WAIT_MS
                    })
                    .ok_or(RuntimeError::Unavailable)?
                    .min(display_expires_at_ms),
                display_expires_at_ms,
                attempts: 0,
                fallbacks,
                confirmation_root: confirmation
                    .as_ref()
                    .map(|confirmation| confirmation.root_id),
                origin_surface,
                expression,
                outcome: None,
                revoked: None,
                progress: 0,
                dispatched_at_ms: 0,
            };
            self.actions.insert(id, action.clone());
            if let Some(confirmation) = confirmation {
                events.push(RuntimeData::DisplayConfirmationProposed {
                    visual_root: confirmation.root_id,
                    visual_action: confirmation.acknowledged_action,
                    action_id: id,
                });
            }
            RuntimeResult::Proposed(action)
        } else {
            RuntimeResult::Blocked
        };
        Ok((result, events))
    }

    pub fn apply(
        &mut self,
        principal: &str,
        records: &BTreeMap<Uuid, Record>,
        operation: RuntimeOperation,
        now: i64,
    ) -> Result<(RuntimeResult, Vec<RuntimeData>), RuntimeError> {
        let mut events = self.reconcile(records, now);
        let result = match operation {
            RuntimeOperation::NativeChallenge {
                surface_id,
                enrollment_id,
                audience,
                challenge_id,
                nonce,
            } => {
                let (challenge, duplicate) = self.native_challenge(
                    records,
                    surface_id,
                    enrollment_id,
                    audience,
                    challenge_id,
                    nonce,
                    now,
                )?;
                if !duplicate {
                    events.push(RuntimeData::NativeChallengeIssued {
                        surface_id,
                        approval_revision: challenge.approval_revision,
                        challenge_id: challenge.challenge_id,
                        expires_at_ms: challenge.expires_at_ms,
                    });
                }
                RuntimeResult::NativeChallenge(challenge)
            }
            RuntimeOperation::OpenNative {
                surface_id,
                audience,
                request,
                incarnation,
            } => {
                let (connection, duplicate) =
                    self.open_native(records, surface_id, &audience, &request, incarnation, now)?;
                if !duplicate {
                    events.push(RuntimeData::NativeEpochOpened {
                        surface_id,
                        approval_revision: connection.approval_revision,
                        incarnation: connection.incarnation,
                        epoch: connection.epoch,
                        expires_at_ms: connection.expires_at_ms,
                    });
                    events.extend(self.reconcile(records, now));
                }
                RuntimeResult::NativeOpened {
                    connection,
                    duplicate,
                }
            }
            RuntimeOperation::CheckNative { connection } => {
                RuntimeResult::NativeCurrent(self.check_native(records, &connection, now)?)
            }
            RuntimeOperation::CloseNative { connection } => {
                if self.close_native(records, &connection)? {
                    events.push(RuntimeData::NativeEpochClosed {
                        surface_id: connection.surface_id,
                        incarnation: connection.incarnation,
                    });
                    events.extend(self.reconcile(records, now));
                }
                RuntimeResult::NativeClosed
            }
            RuntimeOperation::VoicePolicy { surface_id } => {
                RuntimeResult::VoicePolicy(self.voice_policy(records, surface_id)?)
            }
            RuntimeOperation::SetVoicePolicy {
                surface_id,
                approval_revision,
                expected_revision,
                policy,
            } => {
                let approval = self.set_voice_policy(
                    records,
                    surface_id,
                    approval_revision,
                    expected_revision,
                    policy,
                )?;
                events.push(RuntimeData::VoicePolicyChanged {
                    surface_id,
                    approval: approval.clone(),
                });
                events.extend(self.reconcile(records, now));
                RuntimeResult::VoicePolicy(Some(approval))
            }
            RuntimeOperation::NativeVoicePolicy { surface_id } => {
                RuntimeResult::NativeVoicePolicy(self.native_voice_policy(records, surface_id)?)
            }
            RuntimeOperation::SetNativeVoicePolicy {
                surface_id,
                approval_revision,
                expected_revision,
                policy,
            } => {
                let (approval, changed) = self.set_native_voice_policy(
                    records,
                    surface_id,
                    approval_revision,
                    expected_revision,
                    policy,
                )?;
                events.extend(changed);
                events.extend(self.reconcile(records, now));
                RuntimeResult::NativeVoicePolicy(Some(approval))
            }
            RuntimeOperation::AdmitNativeVoice { connection } => {
                let (policy_revision, source_floor) =
                    self.admit_native_voice(records, &connection, now)?;
                RuntimeResult::NativeVoiceAdmissible {
                    policy_revision,
                    source_floor,
                }
            }
            RuntimeOperation::BeginVoice {
                connection,
                stamp,
                worker,
                intake_id,
                binding,
            } => {
                let (result, appended) = self.begin_voice(
                    principal, records, connection, stamp, worker, intake_id, binding, now,
                )?;
                events.extend(appended);
                result
            }
            RuntimeOperation::RetireVoice {
                turn_id,
                worker,
                intake_id,
            } => {
                let turn = self
                    .turn
                    .as_ref()
                    .filter(|t| {
                        t.fence.turn_id == turn_id
                            && t.fence.worker == worker
                            && t.voice.as_ref().is_some_and(|v| v.id == intake_id)
                    })
                    .ok_or(RuntimeError::Stale)?;
                let generation = turn.fence.generation;
                let (result, appended) = self.apply(
                    principal,
                    records,
                    RuntimeOperation::Cancel {
                        turn_id,
                        generation,
                        worker,
                    },
                    now,
                )?;
                events.extend(appended);
                result
            }
            RuntimeOperation::CheckVoice {
                connection,
                fence,
                binding,
            } => {
                self.check_voice(principal, records, &connection, &fence, &binding, now)?;
                RuntimeResult::VoiceCurrent
            }
            RuntimeOperation::FinalizeVoice {
                connection,
                fence,
                binding,
                transcript,
            } => {
                let (result, appended) = self.finalize_voice(
                    principal,
                    records,
                    &connection,
                    fence,
                    &binding,
                    transcript,
                    now,
                )?;
                events.extend(appended);
                result
            }
            RuntimeOperation::DisclosurePolicy { surface_id } => {
                RuntimeResult::DisclosurePolicy(self.disclosure_policy(records, surface_id)?)
            }
            RuntimeOperation::LookupPolicy {
                service,
                surface_id,
            } => {
                let (approval, binding) = self.lookup_policy(records, service, surface_id)?;
                RuntimeResult::LookupPolicy { approval, binding }
            }
            RuntimeOperation::SetLookupPolicy {
                service,
                surface_id,
                approval_revision,
                approval_incarnation,
                expected_revision,
                policy,
            } => {
                let (approval, binding, appended) = self.set_lookup_policy(
                    records,
                    service,
                    surface_id,
                    super::lookup::ApprovalBinding {
                        approval_revision,
                        incarnation: approval_incarnation,
                    },
                    expected_revision,
                    policy,
                )?;
                events.extend(appended);
                events.extend(self.reconcile(records, now));
                RuntimeResult::LookupPolicy {
                    approval: Some(approval),
                    binding,
                }
            }
            RuntimeOperation::StartLookup { fence, request, id } => {
                match self.start_lookup(records, fence.clone(), request.clone(), id, now) {
                    Ok((lookup, appended)) => {
                        events.extend(appended);
                        RuntimeResult::LookupStarted(lookup)
                    }
                    Err(RuntimeError::PolicyBlocked) => {
                        events.push(RuntimeData::LookupDenied { fence, request });
                        RuntimeResult::Blocked
                    }
                    Err(error) => return Err(error),
                }
            }
            RuntimeOperation::CheckLookup { fence, lookup } => {
                self.check_lookup(records, &fence, &lookup, now)?;
                RuntimeResult::LookupCurrent
            }
            RuntimeOperation::CompleteLookup {
                fence,
                lookup,
                evidence_digest,
                privacy,
                visual,
                query_text,
            } => {
                let (receipt, appended) = self.complete_lookup(
                    records,
                    fence,
                    lookup,
                    super::lookup::Completion {
                        evidence_digest,
                        privacy,
                        visual,
                        query_text,
                    },
                    now,
                )?;
                events.extend(appended);
                events.extend(self.reconcile(records, now));
                RuntimeResult::LookupCompleted(receipt)
            }
            RuntimeOperation::RecentContext { fence } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.finished || turn.fence.origin_surface != fence.origin_surface {
                    return Err(RuntimeError::Stale);
                }
                // Memory at or below the shared-room ceiling is offered to any
                // origin. A private memory is offered only to a turn already
                // at that class whose origin holds the screen-context
                // permission that already carries the owner's own private text
                // to cognition: a private label in a shared-class prompt would
                // be a class downgrade in fact if not in name.
                let personal = turn.privacy >= PrivacyClass::Private
                    && turn.screen_context.is_some()
                    && self.screen_context_permitted(records, turn.fence.origin_surface);
                let turn_privacy = turn.privacy;
                // Read memory and the candidates derived from it in the same
                // transaction. Two reads could mix one list's numbers with
                // another list's action references while cognition starts.
                let actions = self.action_offer(records, turn, now);
                let offered: Vec<_> = self
                    .recent_context
                    .iter()
                    .filter(|c| {
                        now < c.expires_at_ms
                            && (c.privacy <= PrivacyClass::SharedRoom
                                || (personal && c.privacy <= turn_privacy))
                    })
                    .cloned()
                    .collect();
                for context in &offered {
                    events.push(RuntimeData::RecentContextOffered {
                        fence: fence.clone(),
                        context: context.kind,
                        source_surface: context.source_surface,
                        privacy: context.privacy,
                    });
                }
                if !actions.is_empty() {
                    events.push(RuntimeData::ActionCandidatesOffered {
                        fence,
                        kinds: actions.kinds(),
                        count: u32::try_from(actions.candidates.len()).unwrap_or(u32::MAX),
                    });
                }
                RuntimeResult::RecentContext {
                    contexts: offered,
                    actions,
                }
            }
            RuntimeOperation::BindDeviceAction {
                fence,
                operation,
                reference,
            } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.finished || turn.fence.origin_surface != fence.origin_surface {
                    return Err(RuntimeError::Stale);
                }
                let (bound, candidate) =
                    self.bind_device_action(records, turn, operation, &reference, now)?;
                events.push(RuntimeData::ActionBound {
                    fence,
                    channel: bound.channel(),
                    operation: bound.kind(),
                    candidate,
                    reference_digest: super::action::reference_digest(&reference),
                    entry_digest: match &bound {
                        super::action::Operation::Run { entry_digest, .. } => {
                            Some(entry_digest.clone())
                        }
                        _ => None,
                    },
                    content_digest: bound.content_digest(),
                });
                RuntimeResult::DeviceActionBound(bound)
            }
            RuntimeOperation::BindPlaceRoute { fence, operation } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.finished
                    || turn.fence.origin_surface != fence.origin_surface
                    || !turn.completed_places_lookup()
                    || !operation.valid()
                    || operation.kind() != super::action::OperationKind::Route
                {
                    return Err(RuntimeError::Stale);
                }
                events.push(RuntimeData::ActionBound {
                    fence,
                    channel: operation.channel(),
                    operation: operation.kind(),
                    candidate: super::action::CandidateKind::Place,
                    reference_digest: super::action::reference_digest("place:1"),
                    entry_digest: None,
                    content_digest: operation.content_digest(),
                });
                RuntimeResult::DeviceActionBound(operation)
            }
            RuntimeOperation::PrivatePolicy { surface_id } => {
                RuntimeResult::PrivatePolicy(self.private_policy(records, surface_id)?)
            }
            RuntimeOperation::DeviceActionPolicy { surface_id } => {
                RuntimeResult::DeviceActionPolicy(self.device_action_policy(records, surface_id)?)
            }
            RuntimeOperation::SetDeviceActionPolicy {
                surface_id,
                approval_revision,
                expected_revision,
                policy,
            } => {
                let (approval, appended) = self.set_device_action_policy(
                    records,
                    surface_id,
                    approval_revision,
                    expected_revision,
                    policy,
                )?;
                events.extend(appended);
                events.extend(self.reconcile(records, now));
                RuntimeResult::DeviceActionPolicy(Some(approval))
            }
            RuntimeOperation::DeviceCommandPolicy { surface_id } => {
                RuntimeResult::DeviceCommandPolicy(self.device_command_policy(records, surface_id)?)
            }
            RuntimeOperation::SetDeviceCommandPolicy {
                surface_id,
                approval_revision,
                expected_revision,
                policy,
            } => {
                let (approval, appended) = self.set_device_command_policy(
                    records,
                    surface_id,
                    approval_revision,
                    expected_revision,
                    policy,
                )?;
                events.extend(appended);
                events.extend(self.reconcile(records, now));
                RuntimeResult::DeviceCommandPolicy(Some(approval))
            }
            RuntimeOperation::NativePresence { surface_id } => {
                let record = records
                    .get(&surface_id)
                    .filter(|r| matches!(r.binding, Binding::Native { .. }))
                    .ok_or(RuntimeError::NotFound)?;
                let connection = self
                    .native_connections
                    .get(&surface_id)
                    .and_then(|state| state.connection.as_ref())
                    .filter(|connection| connection.current(record, now));
                RuntimeResult::NativePresence {
                    connected: connection.is_some(),
                    visible: connection.is_some_and(|connection| connection.visible),
                    private_display: self.personal_ceiling(records, surface_id).is_some(),
                }
            }
            RuntimeOperation::SetPrivatePolicy {
                surface_id,
                approval_revision,
                expected_revision,
                policy,
            } => {
                let (approval, appended) = self.set_private_policy(
                    records,
                    surface_id,
                    approval_revision,
                    expected_revision,
                    policy,
                )?;
                events.extend(appended);
                events.extend(self.reconcile(records, now));
                RuntimeResult::PrivatePolicy(Some(approval))
            }
            RuntimeOperation::PersonalSurfaces { privacy } => {
                RuntimeResult::PersonalSurfaces(self.personal_surfaces(records, privacy, now))
            }
            RuntimeOperation::Invitation { connection } => {
                let record = self.room_record(records, &connection, now)?;
                RuntimeResult::Invitation(self.invitation_for(record.surface_id, now))
            }
            // The connection proves which installation is asking, and the
            // policy is that installation's own. Anything else — a browser
            // member, a revoked or reapproved record, a connection that is no
            // longer current — has no policy to receive.
            RuntimeOperation::DevicePolicyFor { connection } => {
                let record = self.room_record(records, &connection, now)?;
                if !matches!(connection, RoomProof::Native(_)) {
                    return Err(RuntimeError::InvalidOrigin);
                }
                RuntimeResult::DevicePolicyFor(
                    self.device_policy(records, record.surface_id)?
                        .map(Box::new),
                )
            }
            // The ceremony is minted only once the venue's own foreground is
            // reporting, so the thirty-second clock starts at the sentence a
            // person can actually read, not at the proposal.
            RuntimeOperation::Confirmation { connection } => {
                let record = self.room_record(records, &connection, now)?;
                let surface_id = record.surface_id;
                let incarnation = connection.incarnation();
                if self.surface_visible(records, surface_id, now)
                    && let Some((_, appended)) =
                        self.request_grant(records, surface_id, incarnation, now)?
                {
                    events.extend(appended);
                }
                RuntimeResult::Confirmation(
                    self.grants
                        .values()
                        .find(|grant| {
                            grant.venue_surface == surface_id
                                && grant.venue_incarnation == incarnation
                                && grant.decision.is_none()
                                && grant.live(now)
                        })
                        .map(super::grant::Request::from),
                )
            }
            RuntimeOperation::Revocations { connection } => {
                let record = self.room_record(records, &connection, now)?;
                let surface_id = record.surface_id;
                let incarnation = connection.incarnation();
                RuntimeResult::Revocations(
                    self.revocations
                        .iter()
                        .filter(|revocation| {
                            revocation.surface_id == surface_id
                                && revocation.incarnation == incarnation
                                && now < revocation.expires_at_ms
                        })
                        .copied()
                        .collect(),
                )
            }
            // The account a shared-perceivable channel may carry. One fixed
            // sentence per language, held at the shared class like every
            // other runtime expression, naming no device, class, blocker or
            // outcome: a suppressed turn, a capability miss, an unreachable
            // screen and an empty window are the same bytes from here.
            RuntimeOperation::ExpressAccount {
                fence,
                language,
                screen_only,
            } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.finished || turn.fence.origin_surface != fence.origin_surface {
                    return Err(RuntimeError::Stale);
                }
                if self.actions.values().any(|a| a.expression) {
                    return Err(RuntimeError::Busy);
                }
                events.push(RuntimeData::AccountRequested {
                    fence: fence.clone(),
                });
                let sentence = || SemanticIntent::InformationalSpeech {
                    text: language.elsewhere().to_owned(),
                };
                let shared = |intent| OutputProposal {
                    expression: true,
                    intent,
                    privacy: PrivacyClass::SharedRoom,
                    confirmation: None,
                    hint: None,
                };
                let spoken = policy::bind_channel(sentence(), screen_only);
                let card = matches!(spoken, SemanticIntent::VisualTextCard { .. });
                let (mut result, appended) =
                    self.propose_output(records, &fence, shared(spoken), now)?;
                events.extend(appended);
                // A question asked out loud is answered out loud where the
                // fleet can, but the answer to "why?" is not optional: when
                // nothing may speak, the same bytes are shown instead. Which
                // channel carries it depends on the fleet, never on the turn
                // being accounted for.
                if !card && matches!(result, RuntimeResult::Blocked) {
                    let (fallback, appended) = self.propose_output(
                        records,
                        &fence,
                        shared(policy::bind_channel(sentence(), true)),
                        now,
                    )?;
                    events.extend(appended);
                    result = fallback;
                }
                result
            }
            RuntimeOperation::RefusePrivateContext { fence } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.finished || turn.fence.origin_surface != fence.origin_surface {
                    return Err(RuntimeError::Stale);
                }
                // Enrollment and permission to display private content are
                // neither actor authentication nor origin-scoped source
                // access. No current profile supplies the missing evidence.
                events.push(RuntimeData::PrivateContextRefused { fence });
                RuntimeResult::PrivateContextRefused
            }
            // One note write per turn, admitted before anything is stored. The
            // runtime has already bounded and classified the words; this
            // decides only whether a note may be written at all, and says why
            // in the owner's own ledger rather than to whoever asked.
            RuntimeOperation::WriteNote {
                fence,
                bytes,
                titled,
                privacy,
            } => {
                let sensitive = privacy > PrivacyClass::Private;
                let from_screen = {
                    let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                    if turn.finished
                        || turn.fence.origin_surface != fence.origin_surface
                        || turn.note.is_some()
                    {
                        return Err(RuntimeError::Stale);
                    }
                    turn.screen_context.is_some()
                };
                self.note_budget.prune(now);
                let denial = if sensitive {
                    Some(super::note::Denial::Sensitive)
                } else if from_screen {
                    Some(super::note::Denial::ScreenContext)
                } else if self.note_budget.exhausted(now) {
                    Some(super::note::Denial::Budget)
                } else {
                    None
                };
                if let Some(reason) = denial {
                    events.push(RuntimeData::NoteWriteDenied { fence, reason });
                    RuntimeResult::NoteWriteDenied(reason)
                } else {
                    self.note_budget.spend(now);
                    let turn = self.turn.as_mut().ok_or(RuntimeError::Stale)?;
                    turn.note = Some(super::note::Write {
                        bytes,
                        titled,
                        privacy,
                        saved: None,
                    });
                    events.push(RuntimeData::NoteWriteStarted {
                        fence,
                        bytes,
                        titled,
                        privacy,
                    });
                    RuntimeResult::NoteWriteAdmitted
                }
            }
            // What the store did, which is the only thing that may say a note
            // exists. An admitted write that never reaches here stays unsaid.
            RuntimeOperation::NoteWritten { fence, saved } => {
                // Read the fence first, so a stale or cancelled turn is refused
                // before anything is changed, then take the turn to change it.
                self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                let turn = self.turn.as_mut().ok_or(RuntimeError::Stale)?;
                let Some(write) = turn.note.as_mut() else {
                    return Err(RuntimeError::Stale);
                };
                if write.saved.is_some() {
                    return Err(RuntimeError::Stale);
                }
                write.saved = Some(saved);
                events.push(RuntimeData::NoteWriteCompleted {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    saved,
                });
                RuntimeResult::NoteWriteAdmitted
            }
            RuntimeOperation::ScreenContextPolicy { surface_id } => {
                RuntimeResult::ScreenContextPolicy(self.screen_context_policy(records, surface_id)?)
            }
            RuntimeOperation::SetScreenContextPolicy {
                surface_id,
                approval_revision,
                expected_revision,
                policy,
            } => {
                let (approval, appended) = self.set_screen_context_policy(
                    records,
                    surface_id,
                    approval_revision,
                    expected_revision,
                    policy,
                )?;
                events.extend(appended);
                events.extend(self.reconcile(records, now));
                RuntimeResult::ScreenContextPolicy(Some(approval))
            }
            RuntimeOperation::OfferScreenContext {
                fence,
                app_digest,
                bytes,
                document,
            } => {
                events.extend(
                    self.offer_screen_context(records, fence, app_digest, bytes, document, now)?,
                );
                RuntimeResult::ScreenContextOffered
            }
            RuntimeOperation::TurnStatus { connection } => {
                RuntimeResult::TurnStatus(self.turn_status(records, &connection, now)?)
            }
            RuntimeOperation::SetDisclosurePolicy {
                surface_id,
                approval_revision,
                expected_revision,
                policy,
            } => {
                let (approval, appended) = self.set_disclosure_policy(
                    records,
                    surface_id,
                    approval_revision,
                    expected_revision,
                    policy,
                )?;
                events.extend(appended);
                RuntimeResult::DisclosurePolicy(Some(approval))
            }
            RuntimeOperation::StartDisclosure { fence, request, id } => {
                match self.start_disclosure(records, fence.clone(), request.clone(), id, now) {
                    Ok((disclosure, appended)) => {
                        events.extend(appended);
                        RuntimeResult::DisclosureStarted(disclosure)
                    }
                    Err(RuntimeError::PolicyBlocked) => {
                        events.push(RuntimeData::ProviderDisclosureDenied { fence, request });
                        RuntimeResult::Blocked
                    }
                    Err(error) => return Err(error),
                }
            }
            RuntimeOperation::CheckDisclosure { fence, disclosure } => {
                self.check_disclosure(records, &fence, &disclosure, now)?;
                RuntimeResult::DisclosureCurrent
            }
            RuntimeOperation::RetireDisclosure { fence, id } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.fence.origin_surface != fence.origin_surface
                    || !turn.disclosures.iter().any(|d| d.id == id)
                {
                    return Err(RuntimeError::Stale);
                }
                let (result, appended) = self.apply(
                    principal,
                    records,
                    RuntimeOperation::Cancel {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: fence.worker,
                    },
                    now,
                )?;
                events.extend(appended);
                result
            }
            RuntimeOperation::OpenPin {
                device,
                surface_id,
                approval_revision,
                epoch,
                expected_incarnation,
                incarnation,
            } => {
                let record =
                    super::pin_connection::record(principal, records, surface_id, &device)?;
                let (connection, duplicate) = self.open_pin(
                    record,
                    approval_revision,
                    epoch,
                    expected_incarnation,
                    incarnation,
                    now,
                )?;
                if !duplicate {
                    events.push(RuntimeData::PinEpochOpened {
                        surface_id,
                        approval_revision,
                        epoch,
                        incarnation: connection.incarnation,
                        expires_at_ms: connection.expires_at_ms,
                    });
                    events.extend(self.reconcile(records, now));
                }
                RuntimeResult::PinOpened {
                    connection,
                    duplicate,
                }
            }
            RuntimeOperation::CheckPin { connection } => {
                self.pin_record(principal, records, &connection, now)?;
                RuntimeResult::PinCurrent
            }
            RuntimeOperation::ClaimPinMedia { connection, owner } => {
                if owner.is_nil() {
                    return Err(RuntimeError::InvalidRequest);
                }
                self.pin_record(principal, records, &connection, now)?;
                let current = self
                    .pin_connections
                    .get_mut(&connection.surface_id)
                    .unwrap();
                if current.media_owner.is_some() {
                    return Err(RuntimeError::Busy);
                }
                current.media_owner = Some(owner);
                events.push(RuntimeData::PinMediaClaimed {
                    surface_id: connection.surface_id,
                    incarnation: connection.incarnation,
                });
                RuntimeResult::PinMediaGranted(current.clone())
            }
            RuntimeOperation::RetirePinMedia { connection, owner } => {
                let record = super::pin_connection::record(
                    principal,
                    records,
                    connection.surface_id,
                    &connection.device,
                )?;
                let current = self
                    .pin_connections
                    .get(&connection.surface_id)
                    .filter(|c| {
                        c.incarnation == connection.incarnation
                            && c.media_owner == Some(owner)
                            && c.approval_revision == record.revision
                    })
                    .ok_or(RuntimeError::Stale)?;
                if current.closed {
                    return Ok((RuntimeResult::PinClosed, events));
                }
                let (result, appended) = self.apply(
                    principal,
                    records,
                    RuntimeOperation::ClosePin { connection },
                    now,
                )?;
                events.extend(appended);
                result
            }
            RuntimeOperation::ClosePin { connection } => {
                // Closing an exact retired incarnation is idempotent. It can
                // never close a replacement or alter that replacement's turn.
                let record = super::pin_connection::record(
                    principal,
                    records,
                    connection.surface_id,
                    &connection.device,
                )?;
                let current = self
                    .pin_connections
                    .get_mut(&connection.surface_id)
                    .filter(|c| {
                        c.incarnation == connection.incarnation
                            && c.approval_revision == record.revision
                    })
                    .ok_or(RuntimeError::Stale)?;
                if !current.closed {
                    current.closed = true;
                    events.push(RuntimeData::PinEpochClosed {
                        surface_id: connection.surface_id,
                        incarnation: current.incarnation,
                    });
                    events.extend(self.reconcile(records, now));
                }
                RuntimeResult::PinClosed
            }
            RuntimeOperation::OpenBrowser { connection, epoch } => {
                browser_record(records, &connection, now)?;
                if epoch.is_nil() {
                    return Err(RuntimeError::InvalidRequest);
                }
                if let Some(cursor) = self
                    .ingress
                    .get(&connection.surface_id)
                    .filter(|c| c.incarnation == connection.incarnation)
                {
                    if cursor.epoch != epoch {
                        return Err(RuntimeError::Stale);
                    }
                } else {
                    self.ingress.insert(
                        connection.surface_id,
                        InputCursor {
                            incarnation: connection.incarnation,
                            epoch,
                            high_water: 0,
                            receipts: Vec::new(),
                            controls: Vec::new(),
                        },
                    );
                    events.push(RuntimeData::BrowserEpochOpened {
                        surface_id: connection.surface_id,
                        incarnation: connection.incarnation,
                        epoch,
                    });
                }
                RuntimeResult::ConnectionOpened
            }
            RuntimeOperation::RoomControl {
                connection,
                stamp,
                control,
            } => {
                self.room_record(records, &connection, now)?;
                if matches!(
                    (&connection, &control),
                    (RoomProof::Browser(_), BrowserControl::Heartbeat)
                ) {
                    return Err(RuntimeError::InvalidOrigin);
                }
                let surface_id = connection.surface_id();
                let incarnation = connection.incarnation();
                if stamp.sequence == 0
                    || stamp.sequence > 9_007_199_254_740_991
                    || stamp.instance_id.is_nil()
                {
                    return Err(RuntimeError::InvalidRequest);
                }
                let cursor = self
                    .ingress
                    .get(&surface_id)
                    .filter(|c| c.incarnation == incarnation && c.epoch == stamp.epoch)
                    .ok_or(RuntimeError::Stale)?;
                let digest = crate::surface_registry::hash(
                    &serde_json::to_vec(&control).map_err(|_| RuntimeError::InvalidRequest)?,
                );
                let duplicate = if let Some(receipt) = cursor
                    .controls
                    .iter()
                    .find(|r| r.sequence == stamp.sequence)
                {
                    if receipt.instance_id != stamp.instance_id
                        || receipt.digest != digest
                        || now >= receipt.expires_at_ms
                    {
                        return Err(RuntimeError::Stale);
                    }
                    true
                } else {
                    if stamp.sequence <= cursor.high_water {
                        return Err(RuntimeError::Stale);
                    }
                    false
                };
                match control {
                    BrowserControl::Heartbeat => {
                        let RoomProof::Native(proof) = &connection else {
                            return Err(RuntimeError::InvalidOrigin);
                        };
                        if !duplicate {
                            let lease_expires_at_ms = self.heartbeat_native(records, proof, now)?;
                            events.push(RuntimeData::NativeLeaseRenewed {
                                surface_id,
                                incarnation,
                                lease_expires_at_ms,
                            });
                        }
                    }
                    BrowserControl::Acknowledge {
                        action_id,
                        turn_id,
                        generation,
                        channel,
                        content_digest,
                    } => {
                        if stamp.instance_id != action_id
                            || generation == 0
                            || generation > 9_007_199_254_740_991
                            || !digest_valid(&content_digest)
                        {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        // Even an exact acknowledgment retry must refer to a
                        // currently eligible render, never a hidden old card.
                        let (_, appended) = self.apply(
                            principal,
                            records,
                            RuntimeOperation::Ack {
                                action_id,
                                turn_id,
                                generation,
                                connection: connection.clone(),
                                channel,
                                content_digest,
                            },
                            now,
                        )?;
                        events.extend(appended);
                    }
                    BrowserControl::Cancel {
                        turn_id,
                        generation,
                    } => {
                        if stamp.instance_id != turn_id
                            || generation == 0
                            || generation > 9_007_199_254_740_991
                        {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        if !duplicate {
                            let turn = self
                                .turn
                                .as_ref()
                                .filter(|t| {
                                    t.fence.turn_id == turn_id
                                        && t.fence.generation == generation
                                        && t.fence.origin_surface == surface_id
                                        && t.origin_incarnation == incarnation
                                })
                                .ok_or(RuntimeError::Stale)?;
                            let (_, appended) = self.apply(
                                principal,
                                records,
                                RuntimeOperation::Cancel {
                                    turn_id,
                                    generation,
                                    worker: turn.fence.worker,
                                },
                                now,
                            )?;
                            events.extend(appended);
                        }
                    }
                    // Exactly one report per action. It is the only thing that
                    // may claim an outcome, and it is admitted on the same
                    // ordered cursor as the acknowledgment that preceded it.
                    BrowserControl::Report {
                        action_id,
                        turn_id,
                        generation,
                        channel,
                        content_digest,
                        outcome,
                        evidence,
                        output,
                    } => {
                        if stamp.instance_id != action_id
                            || generation == 0
                            || generation > 9_007_199_254_740_991
                            || !digest_valid(&content_digest)
                        {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        let (_, appended) = self.apply(
                            principal,
                            records,
                            RuntimeOperation::Report {
                                connection: connection.clone(),
                                action_id,
                                turn_id,
                                generation,
                                channel,
                                content_digest,
                                outcome,
                                evidence,
                                output,
                            },
                            now,
                        )?;
                        events.extend(appended);
                    }
                    // The owner's answer to a ceremony. A decline is one
                    // control away and weighs exactly as much as an accept;
                    // dismissing the panel answers nothing and expires.
                    BrowserControl::Grant {
                        grant_id,
                        action_id,
                        granted,
                        attestation,
                        description_digest,
                    } => {
                        if stamp.instance_id != grant_id
                            || grant_id.is_nil()
                            || action_id.is_nil()
                            || !digest_valid(&description_digest)
                        {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        if !duplicate {
                            let appended = self.resolve_grant(
                                grant_id,
                                action_id,
                                surface_id,
                                incarnation,
                                granted,
                                attestation,
                                &description_digest,
                                now,
                            )?;
                            events.extend(appended);
                            events.extend(self.reconcile(records, now));
                        }
                    }
                    // apply_with_registry applies the checked browser mutation
                    // in the same Store transaction after this sequence is
                    // admitted. Native visibility lives on the connection.
                    BrowserControl::State { visible } => {
                        if let RoomProof::Native(proof) = &connection
                            && !duplicate
                            && self.set_native_visible(records, proof, visible, now)?
                        {
                            events.push(RuntimeData::NativeVisibility {
                                surface_id,
                                incarnation,
                                visible,
                            });
                            events.extend(self.reconcile(records, now));
                        }
                    }
                }
                if !duplicate {
                    let cursor = self.ingress.get_mut(&surface_id).unwrap();
                    cursor.high_water = stamp.sequence;
                    cursor.controls.push(ControlReceipt {
                        sequence: stamp.sequence,
                        instance_id: stamp.instance_id,
                        digest: digest.clone(),
                        expires_at_ms: now.checked_add(300_000).ok_or(RuntimeError::Unavailable)?,
                    });
                    cursor.prune(now);
                    events.push(RuntimeData::ControlAdmitted {
                        surface_id,
                        epoch: stamp.epoch,
                        sequence: stamp.sequence,
                        instance_id: stamp.instance_id,
                        control_digest: digest,
                    });
                }
                RuntimeResult::ControlAccepted { duplicate }
            }
            RuntimeOperation::Begin {
                turn_id,
                worker,
                origin,
                request_digest,
                privacy_floor,
            } => {
                if turn_id.is_nil() || worker.is_nil() || !digest_valid(&request_digest) {
                    return Err(RuntimeError::InvalidRequest);
                }
                let record = match &origin {
                    OriginProof::Browser(proof) => {
                        let r = browser_record(records, proof, now)?;
                        if !r.visible
                            || !r.approved_manifest["authority"]["mayOriginate"]
                                .as_array()
                                .is_some_and(|a| a.iter().any(|v| v == "user.request"))
                        {
                            return Err(RuntimeError::InvalidOrigin);
                        }
                        r
                    }
                    OriginProof::SequencedRoom { connection, .. } => {
                        let r = self.room_record(records, connection, now)?;
                        if (matches!(connection, RoomProof::Browser(_)) && !r.visible)
                            || !r.approved_manifest["authority"]["mayOriginate"]
                                .as_array()
                                .is_some_and(|a| a.iter().any(|v| v == "user.request"))
                        {
                            return Err(RuntimeError::InvalidOrigin);
                        }
                        r
                    }
                    OriginProof::Pin {
                        device,
                        surface_id,
                        echo_fingerprint,
                    } => {
                        if !digest_valid(echo_fingerprint) {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        super::pin_connection::record(principal, records, *surface_id, device)?
                    }
                    OriginProof::SequencedPin {
                        connection,
                        echo_fingerprint,
                        ..
                    } => {
                        if !digest_valid(echo_fingerprint) {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        self.pin_record(principal, records, connection, now)?
                    }
                    OriginProof::VoicePin {
                        connection,
                        stamp,
                        intake,
                    } => {
                        let r = self.pin_record(principal, records, connection, now)?;
                        self.validate_voice_source(connection, intake, now)?;
                        if stamp.epoch != intake.stamp.epoch
                            || stamp.sequence != intake.stamp.sequence
                            || stamp.instance_id != intake.stamp.instance_id
                            || request_digest != intake.source_digest()?
                        {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        r
                    }
                    // The whole permission is rechecked here, under the same
                    // lock that commits the turn: the press was authorized
                    // seconds ago and the owner may have changed their mind
                    // since.
                    OriginProof::VoiceNative {
                        connection,
                        stamp,
                        capture,
                        transcript_digest,
                        echo_fingerprint,
                    } => {
                        if !digest_valid(echo_fingerprint) || !digest_valid(transcript_digest) {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        let r =
                            self.room_record(records, &RoomProof::Native(connection.clone()), now)?;
                        self.validate_native_voice(records, connection, capture, now)?;
                        if request_digest != capture.source_digest(stamp)? {
                            return Err(RuntimeError::InvalidRequest);
                        }
                        if !r.approved_manifest["authority"]["mayOriginate"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|v| v == "user.request"))
                        {
                            return Err(RuntimeError::InvalidOrigin);
                        }
                        r
                    }
                };
                let sequenced = match &origin {
                    OriginProof::SequencedRoom { connection, stamp } => {
                        Some((connection.surface_id(), connection.incarnation(), stamp))
                    }
                    OriginProof::SequencedPin {
                        connection, stamp, ..
                    }
                    | OriginProof::VoicePin {
                        connection, stamp, ..
                    } => Some((connection.surface_id, connection.incarnation, stamp)),
                    OriginProof::VoiceNative {
                        connection, stamp, ..
                    } => Some((connection.surface_id, connection.incarnation, stamp)),
                    _ => None,
                };
                if let Some((surface_id, incarnation, stamp)) = sequenced {
                    let cursor = self
                        .ingress
                        .get(&surface_id)
                        .filter(|c| c.incarnation == incarnation && c.epoch == stamp.epoch)
                        .ok_or(RuntimeError::Stale)?;
                    if stamp.sequence == 0
                        || stamp.sequence > 9_007_199_254_740_991
                        || stamp.instance_id != turn_id
                    {
                        return Err(RuntimeError::InvalidRequest);
                    }
                    if let Some(receipt) = cursor
                        .receipts
                        .iter()
                        .find(|r| r.sequence == stamp.sequence)
                    {
                        if receipt.admission.request_id() != turn_id
                            || receipt.digest != request_digest
                            || now >= receipt.expires_at_ms
                        {
                            return Err(RuntimeError::Stale);
                        }
                        let result = match &receipt.admission {
                            InputAdmission::Turn { fence } => {
                                RuntimeResult::Duplicate(fence.clone())
                            }
                            InputAdmission::EchoRejected { .. } => RuntimeResult::EchoRejected,
                        };
                        return Ok((result, events));
                    }
                    if stamp.sequence <= cursor.high_water
                        || cursor
                            .receipts
                            .iter()
                            .any(|r| r.admission.request_id() == turn_id)
                    {
                        return Err(RuntimeError::Stale);
                    }
                }
                // A room that hears its own reply is the cheapest way to make
                // this system talk to itself, and a native installation that
                // speaks through `audio.tts` and listens through its own
                // microphone is exactly that room.
                if let OriginProof::Pin {
                    echo_fingerprint, ..
                }
                | OriginProof::SequencedPin {
                    echo_fingerprint, ..
                }
                | OriginProof::VoiceNative {
                    echo_fingerprint, ..
                } = &origin
                    && let Some(echo) = self
                        .echoes
                        .iter()
                        .find(|e| now < e.expires_at_ms && e.fingerprint == *echo_fingerprint)
                {
                    if let Some((surface_id, _, stamp)) = sequenced {
                        let cursor = self.ingress.get_mut(&surface_id).unwrap();
                        cursor.high_water = stamp.sequence;
                        cursor.receipts.push(InputReceipt {
                            sequence: stamp.sequence,
                            digest: request_digest,
                            admission: InputAdmission::EchoRejected {
                                request_id: turn_id,
                            },
                            expires_at_ms: now
                                .checked_add(300_000)
                                .ok_or(RuntimeError::Unavailable)?,
                        });
                        cursor.prune(now);
                    }
                    events.push(RuntimeData::EchoRejected {
                        request_id: turn_id,
                        origin: record.surface_id,
                        action_id: echo.action_id,
                        privacy: privacy_floor.max(echo.privacy),
                        stamp: sequenced.map(|(_, _, stamp)| stamp.clone()),
                    });
                    return Ok((RuntimeResult::EchoRejected, events));
                }
                // A correction from an enrolled origin speaking as the
                // principal voids the active turn's remaining actions. While a
                // task runs the assistant stays answerable: the new request
                // preempts it, and the stopped task is reported cancelled,
                // never completed.
                if let Some(turn) = self
                    .turn
                    .as_ref()
                    .filter(|t| !t.cancelled && !t.finished && now < t.lease_until_ms)
                {
                    let running: Vec<Uuid> = self
                        .actions
                        .values()
                        .filter(|a| a.channel.is_action() && a.live())
                        .map(|a| a.id)
                        .collect();
                    if running.is_empty() {
                        return Err(RuntimeError::Busy);
                    }
                    let (turn_id, generation) = (turn.fence.turn_id, turn.fence.generation);
                    for id in running {
                        events.extend(self.revoke_action(
                            id,
                            super::action::RevokeReason::Preempted,
                            now,
                        ));
                    }
                    self.turn.as_mut().unwrap().cancelled = true;
                    events.push(RuntimeData::TurnPreempted {
                        turn_id,
                        generation,
                        by_surface: record.surface_id,
                    });
                    events.push(RuntimeData::TurnCancelled {
                        turn_id,
                        generation,
                    });
                }
                self.generation = self
                    .generation
                    .checked_add(1)
                    .ok_or(RuntimeError::Unavailable)?;
                // Old terminal payloads are removed; the audit events remain.
                self.actions.clear();
                let fence = TurnFence {
                    turn_id,
                    generation: self.generation,
                    worker,
                    origin_surface: record.surface_id,
                };
                let privacy = privacy_floor
                    .max(PrivacyClass::SharedRoom)
                    .max(match &origin {
                        OriginProof::VoicePin { intake, .. } => intake.source_floor,
                        OriginProof::VoiceNative { capture, .. } => capture.source_floor,
                        _ => PrivacyClass::Public,
                    });
                self.turn = Some(Turn {
                    fence: fence.clone(),
                    origin_incarnation: match &origin {
                        OriginProof::SequencedRoom { connection, .. } => connection.incarnation(),
                        OriginProof::VoiceNative { connection, .. } => connection.incarnation,
                        _ => record.incarnation,
                    },
                    origin_revision: record.revision,
                    // A turn carries at most one note, admitted later if
                    // cognition proposes one; it starts with none.
                    note: None,
                    pin_incarnation: match &origin {
                        OriginProof::SequencedPin { connection, .. }
                        | OriginProof::VoicePin { connection, .. } => Some(connection.incarnation),
                        _ => None,
                    },
                    request_digest: request_digest.clone(),
                    privacy,
                    lease_until_ms: now
                        .checked_add(WORKER_LEASE_MS)
                        .ok_or(RuntimeError::Unavailable)?,
                    cancelled: false,
                    finished: false,
                    analysis: None,
                    disclosures: Vec::new(),
                    lookup: None,
                    voice: match &origin {
                        OriginProof::VoicePin { intake, .. } => Some(intake.clone()),
                        _ => None,
                    },
                    outcome: None,
                    screen_context: None,
                    // A request the runtime heard out loud. A Pin has no
                    // other way to be asked anything.
                    spoken: matches!(
                        origin,
                        OriginProof::VoiceNative { .. }
                            | OriginProof::Pin { .. }
                            | OriginProof::SequencedPin { .. }
                            | OriginProof::VoicePin { .. }
                    ),
                });
                if let Some((surface_id, _, stamp)) = sequenced {
                    let cursor = self.ingress.get_mut(&surface_id).unwrap();
                    cursor.high_water = stamp.sequence;
                    cursor.receipts.push(InputReceipt {
                        sequence: stamp.sequence,
                        digest: request_digest.clone(),
                        admission: InputAdmission::Turn {
                            fence: fence.clone(),
                        },
                        expires_at_ms: now.checked_add(300_000).ok_or(RuntimeError::Unavailable)?,
                    });
                    cursor.prune(now);
                    events.push(RuntimeData::InputAdmitted {
                        surface_id,
                        epoch: stamp.epoch,
                        sequence: stamp.sequence,
                        instance_id: stamp.instance_id,
                        request_digest: request_digest.clone(),
                    });
                }
                events.push(RuntimeData::TurnBegan {
                    turn_id,
                    generation: self.generation,
                    origin: record.surface_id,
                    request_digest,
                    privacy,
                });
                if let OriginProof::VoiceNative {
                    capture,
                    transcript_digest,
                    ..
                } = origin
                {
                    events.push(RuntimeData::NativeVoiceAdmitted {
                        fence: fence.clone(),
                        policy_revision: capture.policy_revision,
                        source_floor: capture.source_floor,
                        capture_ms: capture.capture_ms,
                        samples: capture.samples,
                        audio_digest: capture.audio_digest,
                        transcript_digest,
                        classifier_version: super::runtime::INPUT_CLASSIFIER_VERSION,
                        privacy,
                    });
                }
                RuntimeResult::Begun(fence)
            }
            RuntimeOperation::CheckCognition { fence } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.finished
                    || turn.voice_pending()
                    || turn.fence.origin_surface != fence.origin_surface
                    || !self.origin_valid(turn, records, now)
                {
                    return Err(RuntimeError::Stale);
                }
                // Cognition sees a turn above the shared-room ceiling only
                // when the origin's own screen text was offered under the
                // owner's permission; sensitive content never reaches it.
                if (turn.privacy > PrivacyClass::SharedRoom && turn.screen_context.is_none())
                    || turn.privacy > PrivacyClass::Private
                    || turn.completed_places_lookup()
                {
                    return Err(RuntimeError::PolicyBlocked);
                }
                if turn.lookup_pending() {
                    return Err(RuntimeError::Busy);
                }
                RuntimeResult::CognitionCurrent
            }
            RuntimeOperation::AnalysisStart {
                fence,
                input_digest,
                privacy,
            } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.finished
                    || turn.voice_pending()
                    || turn.fence.origin_surface != fence.origin_surface
                    || !self.origin_valid(turn, records, now)
                {
                    return Err(RuntimeError::Stale);
                }
                if turn.analysis.is_some() || turn.lookup_pending() || !self.actions.is_empty() {
                    return Err(RuntimeError::Busy);
                }
                if turn.completed_places_lookup() {
                    return Err(RuntimeError::PolicyBlocked);
                }
                if !digest_valid(&input_digest) {
                    return Err(RuntimeError::InvalidRequest);
                }
                let privacy = turn.privacy.max(privacy);
                if privacy > PrivacyClass::SharedRoom {
                    return Err(RuntimeError::PolicyBlocked);
                }
                let turn = self.turn.as_mut().unwrap();
                turn.privacy = privacy;
                turn.analysis = Some(AnalysisState {
                    input_digest: input_digest.clone(),
                    output_digest: None,
                });
                events.push(RuntimeData::AnalysisStarted {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    input_digest,
                    privacy,
                });
                RuntimeResult::AnalysisStarted
            }
            RuntimeOperation::AnalysisComplete {
                fence,
                input_digest,
                output_digest,
                privacy,
            } => {
                let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
                if turn.finished
                    || turn.voice_pending()
                    || turn.fence.origin_surface != fence.origin_surface
                    || !self.origin_valid(turn, records, now)
                    || !turn.analysis.as_ref().is_some_and(|a| {
                        a.input_digest == input_digest && a.output_digest.is_none()
                    })
                {
                    return Err(RuntimeError::Stale);
                }
                if !digest_valid(&output_digest) {
                    return Err(RuntimeError::InvalidRequest);
                }
                let turn = self.turn.as_mut().unwrap();
                turn.privacy = turn.privacy.max(privacy);
                turn.analysis.as_mut().unwrap().output_digest = Some(output_digest.clone());
                events.push(RuntimeData::AnalysisCompleted {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    output_digest,
                    privacy: turn.privacy,
                });
                RuntimeResult::AnalysisCompleted
            }
            RuntimeOperation::Propose {
                turn_id,
                generation,
                worker,
                intent,
                privacy,
                hint,
            } => {
                let fence = self.fence(turn_id, generation, worker, now)?.fence.clone();
                let (result, appended) = self.propose_output(
                    records,
                    &fence,
                    OutputProposal {
                        expression: false,
                        intent,
                        privacy,
                        confirmation: None,
                        hint,
                    },
                    now,
                )?;
                events.extend(appended);
                result
            }
            RuntimeOperation::ConfirmDisplay {
                action_id,
                generation,
                worker,
            } => {
                let action = self.actions.get(&action_id).ok_or(RuntimeError::NotFound)?;
                let turn = self.fence(action.turn_id, generation, worker, now)?;
                if action.generation != generation
                    || action.worker != worker
                    || action.channel != Channel::VisualCard
                {
                    return Err(RuntimeError::Stale);
                }
                let fence = turn.fence.clone();
                if self
                    .actions
                    .values()
                    .any(|candidate| candidate.confirmation_root == Some(action.root_id))
                {
                    return Err(RuntimeError::Busy);
                }
                let acknowledged = self
                    .acknowledged_visual(records, action.root_id, now)
                    .ok_or(RuntimeError::PolicyBlocked)?;
                // The same sentence for every elsewhere-routed card, whatever
                // its class: a bystander learns nothing from the expression.
                let output = OutputProposal {
                    expression: true,
                    intent: SemanticIntent::InformationalSpeech {
                        text: "Displayed on your approved screen.".into(),
                    },
                    privacy: PrivacyClass::SharedRoom,
                    confirmation: Some(DisplayConfirmation {
                        root_id: acknowledged.root_id,
                        acknowledged_action: acknowledged.id,
                        expires_at_ms: acknowledged.display_expires_at_ms,
                    }),
                    hint: None,
                };
                let (result, appended) = self.propose_output(records, &fence, output, now)?;
                events.extend(appended);
                result
            }
            RuntimeOperation::Claim {
                action_id,
                generation,
                worker,
            } => {
                let (action, appended) =
                    self.claim(records, action_id, generation, worker, now, false)?;
                events.extend(appended);
                RuntimeResult::Dispatch(action)
            }
            RuntimeOperation::CheckDelivery {
                connection,
                action_id,
                generation,
            } => {
                let record = self.room_record(records, &connection, now)?;
                let action = self.actions.get(&action_id).ok_or(RuntimeError::NotFound)?;
                if action.surface_id != connection.surface_id()
                    || action.incarnation != connection.incarnation()
                    || action.generation != generation
                    // A command already begun continues while its connection
                    // is current; the room record above proved exactly that.
                    || !(self.presence(record, now).attended || action.channel.is_action())
                    || !matches!(
                        action.status,
                        ActionStatus::Dispatched
                            | ActionStatus::Acknowledged
                            | ActionStatus::Running
                    )
                {
                    return Err(RuntimeError::Stale);
                }
                RuntimeResult::Dispatch(action.clone())
            }
            RuntimeOperation::DeliveryFailed {
                connection,
                action_id,
                generation,
            } => {
                self.room_record(records, &connection, now)?;
                let action = self
                    .actions
                    .get_mut(&action_id)
                    .ok_or(RuntimeError::NotFound)?;
                if action.surface_id != connection.surface_id()
                    || action.incarnation != connection.incarnation()
                    || action.generation != generation
                {
                    return Err(RuntimeError::Stale);
                }
                // A late failed RPC cannot undo a separately committed DOM ack.
                if action.status == ActionStatus::Dispatched {
                    action.deadline_ms = now;
                    events.push(RuntimeData::DeliveryFailed {
                        action_id,
                        generation,
                    });
                    events.extend(self.reconcile(records, now));
                }
                RuntimeResult::DeliveryFailureRecorded
            }
            RuntimeOperation::Ack {
                action_id,
                turn_id,
                generation,
                connection,
                channel,
                content_digest,
            } => {
                let record = self.room_record(records, &connection, now)?;
                let action = self.actions.get(&action_id).ok_or(RuntimeError::NotFound)?;
                self.fence(turn_id, generation, action.worker, now)?;
                if action.turn_id != turn_id
                    || action.generation != generation
                    || action.surface_id != record.surface_id
                    || action.incarnation != connection.incarnation()
                    || action.channel != channel
                    || !(channel == Channel::VisualCard
                        || ((channel == Channel::AudioTts || channel.is_action())
                            && matches!(record.binding, Binding::Native { .. })))
                    || action.content_digest != content_digest
                    || (action.status != ActionStatus::Acknowledged && now >= action.deadline_ms)
                    // A device that has begun keeps its command while its
                    // connection is current: launching a player or a map
                    // backgrounds Cosmos, and the acknowledgment follows.
                    || !(self.presence(record, now).attended || channel.is_action())
                    || !matches!(
                        action.status,
                        ActionStatus::Dispatched | ActionStatus::Acknowledged
                    )
                {
                    return Err(RuntimeError::Stale);
                }
                let action = self.actions.get_mut(&action_id).unwrap();
                let first = action.status != ActionStatus::Acknowledged;
                if first {
                    action.status = ActionStatus::Acknowledged;
                    // On an action channel an acknowledgment means "I bound
                    // this exact command and it is legal here". The device now
                    // has the channel's own budget to say what happened.
                    if channel.is_action() {
                        let budget = action
                            .bound_operation()
                            .map_or(ACK_MS, super::action::Operation::report_budget_ms);
                        action.deadline_ms =
                            now.saturating_add(budget).min(action.display_expires_at_ms);
                    }
                    events.push(action_event(action));
                }
                // An acknowledgment on an action channel is not an outcome: a
                // device can accept a command and then fail to carry it out.
                // Only its own final report may set the turn's outcome.
                let outcome =
                    (first && !action.expression && !channel.is_action()).then_some(TurnOutcome {
                        surface_id: action.surface_id,
                        channel: action.channel,
                    });
                // An acknowledged choice list becomes bounded recent context
                // at the shared-room ceiling, so "number two" can be resolved
                // by the next turn; a private list is not remembered. The
                // list's own content digest is remembered with it, so a
                // number resolves against exactly the list that was shown.
                let mut remembered = Vec::new();
                if first
                    && action.privacy <= PrivacyClass::SharedRoom
                    && let SemanticIntent::ChoiceList { title, items } = &action.intent
                {
                    remembered.push(RecentContext {
                        kind: RecentContextKind::Choices,
                        text: title.clone(),
                        items: items.iter().map(|item| item.title.clone()).collect(),
                        source_surface: action.surface_id,
                        privacy: action.privacy,
                        created_at_ms: now,
                        expires_at_ms: now.saturating_add(RECENT_CONTEXT_MS),
                        list_digest: Some(action.content_digest.clone()),
                        continuation: None,
                    });
                }
                // A continuation is a memory write, so it happens only once
                // the private card the origin's own document produced has
                // actually been shown on a personal surface.
                let continuation = self
                    .turn
                    .as_ref()
                    .and_then(|turn| turn.screen_context.as_ref())
                    .and_then(|offered| offered.document.clone())
                    .filter(|document| {
                        first
                            && action.channel == Channel::VisualCard
                            && action.privacy >= PrivacyClass::Private
                            && document.valid()
                    });
                if let Some(document) = continuation {
                    remembered.push(RecentContext {
                        kind: RecentContextKind::Continuation,
                        text: String::new(),
                        items: Vec::new(),
                        source_surface: action.surface_id,
                        privacy: action.privacy,
                        created_at_ms: now,
                        expires_at_ms: now.saturating_add(RECENT_CONTEXT_MS),
                        list_digest: None,
                        continuation: Some(super::continuation::Continuation {
                            id: Uuid::new_v4(),
                            document,
                        }),
                    });
                }
                let result = RuntimeResult::Acknowledged(action.clone());
                for context in remembered {
                    events.push(RuntimeData::RecentContextRemembered {
                        context: context.kind,
                        source_surface: context.source_surface,
                        privacy: context.privacy,
                        expires_at_ms: context.expires_at_ms,
                    });
                    self.remember(context);
                }
                let turn = self.turn.as_mut().unwrap();
                if turn.outcome.is_none() {
                    turn.outcome = outcome;
                }
                if records
                    .get(&turn.fence.origin_surface)
                    .is_some_and(|r| matches!(r.binding, Binding::Browser | Binding::Native { .. }))
                    && !turn.finished
                    && self.actions.values().all(|a| !a.live())
                {
                    turn.finished = true;
                    events.push(RuntimeData::TurnFinished {
                        turn_id,
                        generation,
                    });
                }
                result
            }
            // Only this may claim an outcome. It is the device's own account
            // of what happened, bounded, closed and checked against the exact
            // command the decision bound.
            RuntimeOperation::Report {
                connection,
                action_id,
                turn_id,
                generation,
                channel,
                content_digest,
                outcome,
                evidence,
                output,
            } => {
                let record = self.room_record(records, &connection, now)?;
                let action = self.actions.get(&action_id).ok_or(RuntimeError::NotFound)?;
                self.fence(turn_id, generation, action.worker, now)?;
                let declined = matches!(evidence, super::action::Evidence::Declined { .. });
                if !channel.is_action()
                    || !matches!(record.binding, Binding::Native { .. })
                    || action.turn_id != turn_id
                    || action.generation != generation
                    || action.surface_id != record.surface_id
                    || action.incarnation != connection.incarnation()
                    || action.channel != channel
                    || action.content_digest != content_digest
                    || !action.started()
                    || !evidence.valid()
                    || !evidence.fits(channel)
                    || !matches!(&action.intent, SemanticIntent::DeviceAction { operation }
                        if evidence.matches_operation(operation, outcome))
                    // A launch a device could not observe further is unknown,
                    // never completed, and a refusal is exactly the evidence
                    // that says the device declined.
                    || (outcome == super::action::ReportOutcome::Completed
                        && !evidence.proves_completion())
                    || (outcome == super::action::ReportOutcome::Refused) != declined
                {
                    return Err(RuntimeError::Stale);
                }
                // The owner's own command output is content and travels as
                // content; nothing else crosses this leg as free text.
                let output = match (&evidence, output) {
                    (_, None) => None,
                    (super::action::Evidence::Command { .. }, Some(output))
                        if !output.is_empty()
                            && output.len() <= super::action::MAX_OUTPUT_BYTES
                            && !output
                                .chars()
                                .any(|c| c.is_control() && c != '\n' && c != '\t') =>
                    {
                        Some(output)
                    }
                    _ => return Err(RuntimeError::InvalidRequest),
                };
                let evidence_digest = evidence.digest();
                let exit_code = match &evidence {
                    super::action::Evidence::Command { exit_code, .. } => *exit_code,
                    _ => None,
                };
                let action = self.actions.get_mut(&action_id).unwrap();
                let elapsed_ms = now.saturating_sub(action.dispatched_at_ms);
                action.status = outcome.status();
                action.outcome = Some(outcome);
                let reported = action.clone();
                events.push(RuntimeData::ActionReported {
                    action_id,
                    channel,
                    outcome,
                    evidence: evidence.kind(),
                    evidence_digest,
                    exit_code,
                    elapsed_ms,
                    attempt: reported.attempts,
                });
                events.push(action_event(&reported));
                let turn = self.turn.as_mut().unwrap();
                if turn.outcome.is_none() && !reported.expression {
                    turn.outcome = Some(TurnOutcome {
                        surface_id: reported.surface_id,
                        channel: reported.channel,
                    });
                }
                let fence = turn.fence.clone();
                // The command's own bytes are the device's, not the runtime's.
                // They join to at least private, so they can only land on a
                // personal surface, and the ledger keeps only their digest.
                if let Some(output) = output {
                    let privacy = self
                        .turn
                        .as_ref()
                        .map_or(PrivacyClass::Private, |turn| turn.privacy)
                        .max(PrivacyClass::Private)
                        .max(super::runtime::input_privacy(&output));
                    let (_, appended) = self.propose_output(
                        records,
                        &fence,
                        OutputProposal {
                            expression: false,
                            intent: SemanticIntent::VisualTextCard { text: output },
                            privacy,
                            confirmation: None,
                            hint: None,
                        },
                        now,
                    )?;
                    events.extend(appended);
                } else {
                    events.extend(self.reconcile(records, now));
                }
                RuntimeResult::Reported(reported)
            }
            // Liveness for a long command. It never touches the ingress
            // cursor, so a three-minute task costs no ordered slots, and it
            // renews both the command's deadline and the turn's worker lease.
            RuntimeOperation::Progress {
                connection,
                action_id,
                generation,
                sequence,
                elapsed_ms,
            } => {
                let record = self.room_record(records, &connection, now)?;
                let action = self.actions.get(&action_id).ok_or(RuntimeError::NotFound)?;
                self.fence(action.turn_id, generation, action.worker, now)?;
                if !action.channel.is_action()
                    || action.generation != generation
                    || action.surface_id != record.surface_id
                    || action.incarnation != connection.incarnation()
                    || !action.started()
                    || sequence == 0
                    || sequence > super::action::MAX_PROGRESS
                    || !(0..=super::action::MAX_BUDGET_MS).contains(&elapsed_ms)
                {
                    return Err(RuntimeError::Stale);
                }
                let duplicate = sequence <= action.progress;
                if !duplicate {
                    let action = self.actions.get_mut(&action_id).unwrap();
                    action.progress = sequence;
                    action.status = ActionStatus::Running;
                    action.deadline_ms = now
                        .saturating_add(super::action::PROGRESS_GRACE_MS)
                        .min(action.display_expires_at_ms);
                    let running = action.clone();
                    events.push(action_event(&running));
                    self.renew_lease(now);
                }
                RuntimeResult::ProgressAccepted { duplicate }
            }
            // The runtime's own shared-safe sentence. A shared-perceivable
            // origin hears one of exactly two, neither of which names an
            // operation, a device kind, a class or a reason.
            RuntimeOperation::ExpressAction {
                turn_id,
                generation,
                worker,
                action_id,
            } => {
                let fence = self.fence(turn_id, generation, worker, now)?.fence.clone();
                if self.actions.values().any(|a| a.expression) {
                    return Err(RuntimeError::Busy);
                }
                let completed = action_id
                    .and_then(|id| self.actions.get(&id))
                    .filter(|a| {
                        a.turn_id == turn_id && a.generation == generation && a.channel.is_action()
                    })
                    .is_some_and(|a| a.outcome == Some(super::action::ReportOutcome::Completed));
                let text = if completed {
                    ACTION_COMPLETED_EXPRESSION
                } else {
                    ACTION_HANDLED_EXPRESSION
                };
                let (result, appended) = self.propose_output(
                    records,
                    &fence,
                    OutputProposal {
                        expression: true,
                        intent: SemanticIntent::InformationalSpeech { text: text.into() },
                        privacy: PrivacyClass::SharedRoom,
                        confirmation: None,
                        hint: None,
                    },
                    now,
                )?;
                events.extend(appended);
                result
            }
            RuntimeOperation::Cancel {
                turn_id,
                generation,
                worker,
            } => {
                self.fence(turn_id, generation, worker, now)?;
                self.turn.as_mut().unwrap().cancelled = true;
                events.push(RuntimeData::TurnCancelled {
                    turn_id,
                    generation,
                });
                events.extend(self.reconcile(records, now));
                RuntimeResult::Cancelled
            }
            RuntimeOperation::Poll { connection } => {
                self.room_record(records, &connection, now)?;
                // Speech is claimed only through its disclosure; a room poll
                // never stock-dispatches audio and never marks it unknown.
                let visible = self.surface_visible(records, connection.surface_id(), now);
                let pending: Vec<_> = self
                    .actions
                    .values()
                    .filter(|a| {
                        a.surface_id == connection.surface_id()
                            && a.incarnation == connection.incarnation()
                            && (a.status == ActionStatus::Proposed
                                || (a.status == ActionStatus::AwaitingGrant
                                    && self.granted(a.id, now)))
                            && (a.channel == Channel::VisualCard || a.channel.is_action())
                            // Dispatch-time revalidation: nothing is handed to
                            // a surface that is not reporting its own
                            // foreground. Every manifest says a card renders
                            // only there, and no platform begins a command in
                            // the background. A card chosen for a screen that
                            // has not come forward is held, not delivered, and
                            // that holding is what "waiting" means.
                            && visible
                    })
                    .map(|a| (a.id, a.generation, a.worker, a.channel))
                    .collect();
                let fence = self.turn.as_ref().map(|turn| turn.fence.clone());
                for (id, generation, worker, channel) in pending {
                    // Six device actions in ten minutes, one in flight. The
                    // owner reads this row; the origin hears nothing new.
                    if channel.is_action() && self.action_budget_blocked(now) {
                        if let Some(fence) = fence.clone() {
                            events.push(RuntimeData::ActionBudgetExhausted {
                                fence,
                                window_ms: super::action::BUDGET_WINDOW_MS,
                                limit: super::action::BUDGET_LIMIT as u8,
                            });
                        }
                        continue;
                    }
                    // One un-claimable action must not fail the whole poll and
                    // take card rendering down with it.
                    match self.claim(records, id, generation, worker, now, false) {
                        Ok((_, appended)) => events.extend(appended),
                        Err(
                            RuntimeError::PolicyBlocked
                            | RuntimeError::Stale
                            | RuntimeError::NotFound
                            | RuntimeError::Busy,
                        ) => continue,
                        Err(error) => return Err(error),
                    }
                }
                RuntimeResult::Pending(
                    self.actions
                        .values()
                        .filter(|a| {
                            a.surface_id == connection.surface_id()
                                && a.incarnation == connection.incarnation()
                        })
                        .cloned()
                        .collect(),
                )
            }
            RuntimeOperation::Sweep => RuntimeResult::Swept,
            RuntimeOperation::Finish {
                turn_id,
                generation,
                worker,
            } => {
                self.fence(turn_id, generation, worker, now)?;
                if self.actions.values().any(Action::live) {
                    return Err(RuntimeError::Busy);
                }
                let turn = self.turn.as_mut().unwrap();
                if !turn.finished {
                    turn.finished = true;
                    events.push(RuntimeData::TurnFinished {
                        turn_id,
                        generation,
                    });
                }
                RuntimeResult::Finished
            }
            RuntimeOperation::Inspect {
                turn_id,
                generation,
                worker,
            } => {
                self.fence(turn_id, generation, worker, now)?;
                RuntimeResult::Observed(
                    self.actions
                        .values()
                        .filter(|a| a.turn_id == turn_id && a.generation == generation)
                        .cloned()
                        .collect(),
                )
            }
            // A replica starting does not invalidate another replica. The
            // reconcile above only fences expired leases/current invalid state.
            RuntimeOperation::Recover { worker: _ } => RuntimeResult::Recovered,
        };
        events.extend(self.clear_terminal_payloads());
        Ok((result, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::surface_registry::{Mutation, hash, transition};

    fn browser(id: Uuid) -> Record {
        let (r, _) = transition(
            None,
            0,
            id,
            &Mutation::Approve {
                token_hash: hash(b"test capability"),
                incarnation: Uuid::new_v4(),
            },
            100,
        )
        .unwrap();
        transition(
            Some(&r),
            1,
            id,
            &Mutation::State {
                token_hash: r.token_hash.clone(),
                incarnation: r.incarnation,
                sequence: 1,
                visible: true,
            },
            100,
        )
        .unwrap()
        .0
    }
    fn proof(r: &Record) -> BrowserProof {
        BrowserProof {
            surface_id: r.surface_id,
            incarnation: r.incarnation,
            token_hash: r.token_hash.clone(),
        }
    }
    fn begin(state: &mut RuntimeState, records: &BTreeMap<Uuid, Record>, id: Uuid) -> TurnFence {
        let (result, _) = state
            .apply(
                "U:owner",
                records,
                RuntimeOperation::Begin {
                    turn_id: Uuid::new_v4(),
                    worker: Uuid::new_v4(),
                    origin: OriginProof::Browser(proof(&records[&id])),
                    request_digest: hash(b"request"),
                    privacy_floor: PrivacyClass::Public,
                },
                101,
            )
            .unwrap();
        let RuntimeResult::Begun(fence) = result else {
            panic!()
        };
        fence
    }
    #[test]
    fn ambiance_echo_is_logged_before_cognition_survives_turnover_and_expires() {
        let pin = crate::surface_registry::pin_surface_id("U:owner", "aabb");
        let record = transition(
            None,
            0,
            pin,
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            100,
        )
        .unwrap()
        .0;
        let browser_id = Uuid::new_v4();
        let records = BTreeMap::from([(pin, record), (browser_id, browser(browser_id))]);
        let mut state = RuntimeState::default();
        let stock_input = |text: &str| RuntimeOperation::Begin {
            turn_id: Uuid::new_v4(),
            worker: Uuid::new_v4(),
            origin: OriginProof::Pin {
                device: AuthenticatedDeviceIdentity::from_edge("aabb").unwrap(),
                surface_id: pin,
                echo_fingerprint: super::super::echo::fingerprint(text),
            },
            request_digest: hash(text.as_bytes()),
            privacy_floor: PrivacyClass::SharedRoom,
        };
        let (RuntimeResult::Begun(fence), _) = state
            .apply("U:owner", &records, stock_input("Tell me something"), 101)
            .unwrap()
        else {
            panic!()
        };
        let (RuntimeResult::Proposed(action), _) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::InformationalSpeech {
                        text: "A useful answer.".into(),
                    },
                    privacy: PrivacyClass::Public,
                    hint: None,
                },
                102,
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(state.echoes.is_empty(), "a proposal is not a dispatch");
        let mut saturated = state.clone();
        saturated.echoes = (0..super::super::echo::MAX_WINDOWS)
            .map(|_| super::super::echo::Window {
                action_id: Uuid::new_v4(),
                fingerprint: hash(b"prior speech"),
                expires_at_ms: 30_103,
                privacy: PrivacyClass::SharedRoom,
            })
            .collect();
        assert!(matches!(
            saturated.apply(
                "U:owner",
                &records,
                RuntimeOperation::Claim {
                    action_id: action.id,
                    generation: fence.generation,
                    worker: fence.worker,
                },
                103
            ),
            Err(RuntimeError::Busy)
        ));
        assert_eq!(saturated.actions[&action.id].status, ActionStatus::Proposed);
        let (_, events) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Claim {
                    action_id: action.id,
                    generation: fence.generation,
                    worker: fence.worker,
                },
                103,
            )
            .unwrap();
        assert!(events.iter().any(
            |e| matches!(e, RuntimeData::EchoGuarded { action_id, .. } if *action_id == action.id)
        ));
        assert_eq!(
            state.actions[&action.id].status,
            ActionStatus::OutcomeUnknown
        );
        assert!(state.actions[&action.id].intent.text().is_empty());
        state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Finish {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                },
                104,
            )
            .unwrap();
        // Reopen exercises the same serialized projection that PostgreSQL loads.
        let bytes = serde_json::to_vec(&state).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("A useful answer"));
        let mut state: RuntimeState = serde_json::from_slice(&bytes).unwrap();
        let (result, events) = state
            .apply("U:owner", &records, stock_input("A USEFUL answer!"), 105)
            .unwrap();
        assert!(matches!(result, RuntimeResult::EchoRejected));
        assert!(
            matches!(&events[..], [RuntimeData::EchoRejected { action_id, .. }] if *action_id == action.id)
        );
        assert_eq!(
            state.generation, fence.generation,
            "echo cannot supersede a turn"
        );
        let (RuntimeResult::Begun(browser_fence), _) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Begin {
                    turn_id: Uuid::new_v4(),
                    worker: Uuid::new_v4(),
                    origin: OriginProof::Browser(proof(&records[&browser_id])),
                    request_digest: hash(b"A useful answer"),
                    privacy_floor: PrivacyClass::SharedRoom,
                },
                106,
            )
            .unwrap()
        else {
            panic!("typed input must not be treated as microphone echo")
        };
        state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Finish {
                    turn_id: browser_fence.turn_id,
                    generation: browser_fence.generation,
                    worker: browser_fence.worker,
                },
                106,
            )
            .unwrap();
        assert!(
            state.actions.is_empty(),
            "the original action is no longer projected"
        );
        assert!(matches!(
            state
                .apply("U:owner", &records, stock_input("A useful answer"), 107)
                .unwrap()
                .0,
            RuntimeResult::EchoRejected
        ));
        let (result, events) = state
            .apply(
                "U:owner",
                &records,
                stock_input("A useful answer"),
                103 + super::super::echo::WINDOW_MS,
            )
            .unwrap();
        assert!(matches!(result, RuntimeResult::Begun(_)));
        assert!(events.iter().any(
            |e| matches!(e, RuntimeData::EchoExpired { action_id, .. } if *action_id == action.id)
        ));
        assert!(state.echoes.is_empty());
    }

    fn propose(
        state: &mut RuntimeState,
        records: &BTreeMap<Uuid, Record>,
        fence: &TurnFence,
    ) -> Action {
        let (result, _) = state
            .apply(
                "U:owner",
                records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::VisualTextCard {
                        text: "A useful answer".into(),
                    },
                    privacy: PrivacyClass::Public,
                    hint: None,
                },
                102,
            )
            .unwrap();
        let RuntimeResult::Proposed(action) = result else {
            panic!()
        };
        action
    }
    fn poll(
        state: &mut RuntimeState,
        records: &BTreeMap<Uuid, Record>,
        id: Uuid,
        now: i64,
    ) -> Vec<Action> {
        let (result, _) = state
            .apply(
                "U:owner",
                records,
                RuntimeOperation::Poll {
                    connection: RoomProof::Browser(proof(&records[&id])),
                },
                now,
            )
            .unwrap();
        let RuntimeResult::Pending(actions) = result else {
            panic!()
        };
        actions
    }
    fn ack(action: &Action, record: &Record) -> RuntimeOperation {
        RuntimeOperation::Ack {
            action_id: action.id,
            turn_id: action.turn_id,
            generation: action.generation,
            connection: RoomProof::Browser(proof(record)),
            channel: action.channel,
            content_digest: action.content_digest.clone(),
        }
    }

    #[test]
    fn ambiance_analysis_is_once_per_turn_durable_and_fenced_before_dispatch() {
        let id = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let start = || RuntimeOperation::AnalysisStart {
            fence: fence.clone(),
            input_digest: hash(b"admitted input"),
            privacy: PrivacyClass::Public,
        };
        let (result, events) = state.apply("U:owner", &records, start(), 102).unwrap();
        assert!(matches!(result, RuntimeResult::AnalysisStarted));
        assert!(matches!(
            events.as_slice(),
            [RuntimeData::AnalysisStarted {
                privacy: PrivacyClass::SharedRoom,
                ..
            }]
        ));
        assert!(state.apply("U:owner", &records, start(), 103).is_err());
        // Reopen the durable projection: neither a crash nor a second worker
        // can start the same analysis or dispatch before its result commits.
        let mut state: RuntimeState =
            serde_json::from_value(serde_json::to_value(state).unwrap()).unwrap();
        assert!(
            state
                .apply(
                    "U:owner",
                    &records,
                    RuntimeOperation::Propose {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: fence.worker,
                        intent: SemanticIntent::VisualTextCard {
                            text: "Premature".into()
                        },
                        privacy: PrivacyClass::Public,
                        hint: None,
                    },
                    104
                )
                .is_err()
        );
        let complete = |input: &str, fence: TurnFence| RuntimeOperation::AnalysisComplete {
            fence,
            input_digest: hash(input.as_bytes()),
            output_digest: hash(b"analysis result"),
            privacy: PrivacyClass::Private,
        };
        assert!(
            state
                .apply(
                    "U:owner",
                    &records,
                    complete("wrong input", fence.clone()),
                    104
                )
                .is_err()
        );
        let mut stale = fence.clone();
        stale.worker = Uuid::new_v4();
        assert!(
            state
                .apply("U:owner", &records, complete("admitted input", stale), 104)
                .is_err()
        );
        let (result, events) = state
            .apply(
                "U:owner",
                &records,
                complete("admitted input", fence.clone()),
                104,
            )
            .unwrap();
        assert!(matches!(result, RuntimeResult::AnalysisCompleted));
        assert!(matches!(
            events.as_slice(),
            [RuntimeData::AnalysisCompleted {
                privacy: PrivacyClass::Private,
                ..
            }]
        ));
        assert!(
            state
                .apply(
                    "U:owner",
                    &records,
                    complete("admitted input", fence.clone()),
                    105
                )
                .is_err()
        );
        let (result, _) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::VisualTextCard {
                        text: "analysis result".into(),
                    },
                    privacy: PrivacyClass::Public,
                    hint: None,
                },
                105,
            )
            .unwrap();
        assert!(
            matches!(result, RuntimeResult::Blocked),
            "service provenance cannot be lowered by output selection"
        );
        assert!(state.actions.is_empty());
    }

    #[test]
    fn ambiance_ack_is_exact_durable_order_and_duplicate_after_deadline_is_idempotent() {
        let id = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let proposed = propose(&mut state, &records, &fence);
        assert!(
            state
                .apply("U:owner", &records, ack(&proposed, &records[&id]), 103)
                .is_err()
        );
        let dispatched = poll(&mut state, &records, id, 103).remove(0);
        assert_eq!(dispatched.deadline_ms, 3103);
        assert_eq!(dispatched.display_expires_at_ms, 60102);
        let mut wrong = ack(&dispatched, &records[&id]);
        if let RuntimeOperation::Ack { generation, .. } = &mut wrong {
            *generation += 1;
        }
        assert!(state.apply("U:owner", &records, wrong, 104).is_err());
        let mut wrong = ack(&dispatched, &records[&id]);
        if let RuntimeOperation::Ack { content_digest, .. } = &mut wrong {
            *content_digest = hash(b"different");
        }
        assert!(state.apply("U:owner", &records, wrong, 104).is_err());
        let (_, events) = state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 104)
            .unwrap();
        assert!(matches!(
            events[0],
            RuntimeData::ActionChanged {
                status: ActionStatus::Acknowledged,
                ..
            }
        ));
        assert!(state.turn.as_ref().unwrap().finished);
        let (_, repeated) = state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 4104)
            .unwrap();
        assert!(repeated.is_empty());
        let next = begin(&mut state, &records, id);
        assert!(next.generation > fence.generation);
        assert!(
            state
                .apply(
                    "U:owner",
                    &records,
                    RuntimeOperation::Propose {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: fence.worker,
                        intent: SemanticIntent::VisualTextCard {
                            text: "late".into()
                        },
                        privacy: PrivacyClass::Public,
                        hint: None,
                    },
                    105
                )
                .is_err()
        );
    }

    #[test]
    fn ambiance_heartbeat_does_not_cancel_but_hide_rotation_and_privacy_raise_do() {
        let id = Uuid::new_v4();
        let mut records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let action = propose(&mut state, &records, &fence);
        poll(&mut state, &records, id, 103);
        let old = &records[&id];
        let heartbeat = transition(
            Some(old),
            1,
            id,
            &Mutation::State {
                token_hash: old.token_hash.clone(),
                incarnation: old.incarnation,
                sequence: 2,
                visible: true,
            },
            104,
        )
        .unwrap()
        .0;
        records.insert(id, heartbeat);
        assert!(state.reconcile(&records, 104).is_empty());
        let (_, events) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::VisualTextCard {
                        text: "private service data".into(),
                    },
                    privacy: PrivacyClass::Private,
                    hint: None,
                },
                105,
            )
            .unwrap();
        assert!(events.iter().any(|e| matches!(
            e,
            RuntimeData::Decision {
                action_id: None,
                privacy: PrivacyClass::Private,
                ..
            }
        )));
        assert_eq!(state.actions[&action.id].status, ActionStatus::Cancelled);
        assert_eq!(state.turn.as_ref().unwrap().privacy, PrivacyClass::Private);
        records.get_mut(&id).unwrap().visible = false;
        state.reconcile(&records, 106);
        assert!(state.turn.as_ref().unwrap().cancelled);
        records.get_mut(&id).unwrap().visible = true;
        records.get_mut(&id).unwrap().incarnation = Uuid::new_v4();
        assert!(
            state
                .apply("U:owner", &records, ack(&action, &records[&id]), 107)
                .is_err()
        );
    }

    #[test]
    fn ambiance_same_key_retry_precedes_logged_fallback_and_never_claims_playback() {
        let id = Uuid::new_v4();
        let other = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id)), (other, browser(other))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let action = propose(&mut state, &records, &fence);
        assert_eq!(action.surface_id, id);
        let first = poll(&mut state, &records, id, 103).remove(0);
        let retry = poll(&mut state, &records, id, 3103).remove(0);
        assert_eq!(retry.id, first.id);
        assert_eq!(retry.attempts, 2);
        let events = state.reconcile(&records, 6103);
        assert!(events.iter().any(
            |e| matches!(e,RuntimeData::Repair{previous_action,..} if *previous_action==first.id)
        ));
        let replacement = poll(&mut state, &records, other, 6104).remove(0);
        assert_ne!(replacement.id, first.id);
        assert_eq!(replacement.surface_id, other);
        assert_eq!(
            state.actions[&first.id].status,
            ActionStatus::OutcomeUnknown
        );
    }

    #[test]
    fn ambiance_recovery_respects_live_worker_and_cancel_requires_own_fence() {
        let id = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let (_, events) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Recover {
                    worker: Uuid::new_v4(),
                },
                102,
            )
            .unwrap();
        assert!(events.is_empty());
        assert!(
            state
                .apply(
                    "U:owner",
                    &records,
                    RuntimeOperation::Cancel {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: Uuid::new_v4()
                    },
                    103
                )
                .is_err()
        );
        assert!(!state.turn.as_ref().unwrap().cancelled);
        let events = state.reconcile(&records, WORKER_LEASE_MS + 102);
        assert!(!events.is_empty());
        assert!(state.turn.as_ref().unwrap().cancelled);
    }

    #[test]
    fn ambiance_target_loss_and_unpolled_proposal_repair_but_origin_loss_does_not() {
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        let pin = crate::surface_registry::pin_surface_id("U:owner", "aabb");
        let pin_record = transition(
            None,
            0,
            pin,
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            100,
        )
        .unwrap()
        .0;
        let original = BTreeMap::from([
            (first, browser(first)),
            (second, browser(second)),
            (pin, pin_record),
        ]);
        for mode in ["hide", "revoke", "lease", "unpolled", "origin"] {
            let mut records = original.clone();
            let mut state = RuntimeState::default();
            let (RuntimeResult::Begun(fence), _) = state
                .apply(
                    "U:owner",
                    &records,
                    RuntimeOperation::Begin {
                        turn_id: Uuid::new_v4(),
                        worker: Uuid::new_v4(),
                        origin: OriginProof::Pin {
                            device: AuthenticatedDeviceIdentity::from_edge("aabb").unwrap(),
                            surface_id: pin,
                            echo_fingerprint: super::super::echo::fingerprint("request"),
                        },
                        request_digest: hash(b"request"),
                        privacy_floor: PrivacyClass::SharedRoom,
                    },
                    101,
                )
                .unwrap()
            else {
                panic!()
            };
            let action = propose(&mut state, &records, &fence);
            assert_eq!(action.surface_id, first);
            if mode != "unpolled" {
                poll(&mut state, &records, first, 103);
            }
            match mode {
                "hide" => records.get_mut(&first).unwrap().visible = false,
                "revoke" => records.get_mut(&first).unwrap().revoked = true,
                "lease" => records.get_mut(&first).unwrap().lease_expires_at = 104,
                "origin" => records.get_mut(&pin).unwrap().revoked = true,
                _ => {}
            }
            let events = state.reconcile(&records, if mode == "unpolled" { 3102 } else { 104 });
            let repaired = events
                .iter()
                .any(|e| matches!(e,RuntimeData::Repair{surface_id,..}if *surface_id==second));
            assert_eq!(repaired, mode != "origin", "{mode}");
            if repaired {
                let replacement = state.actions.values().find(|a| a.id != action.id).unwrap();
                assert_eq!(replacement.root_id, action.root_id);
                assert_eq!(replacement.content_digest, action.content_digest);
            }
        }
    }

    #[test]
    fn ambiance_single_card_and_origin_scoped_privacy_ceiling_are_hard_blockers() {
        let id = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        propose(&mut state, &records, &fence);
        let extra = RuntimeOperation::Propose {
            turn_id: fence.turn_id,
            generation: fence.generation,
            worker: fence.worker,
            intent: SemanticIntent::VisualTextCard {
                text: "another".into(),
            },
            privacy: PrivacyClass::Public,
            hint: None,
        };
        assert!(matches!(
            state.apply("U:owner", &records, extra, 103),
            Err(RuntimeError::Busy)
        ));
        for class in [
            PrivacyClass::NearUser,
            PrivacyClass::Private,
            PrivacyClass::Sensitive,
        ] {
            let candidate = state.candidate(
                &records,
                &records[&id],
                id,
                Channel::VisualCard,
                policy::Shape::Note,
                class,
                None,
                None,
                103,
            );
            assert_eq!(candidate.blocker, Some(policy::Blocker::Privacy));
            assert_eq!(candidate.score(), 0);
        }
    }

    #[test]
    fn ambiance_acknowledged_payload_expires_and_retry_keeps_only_replacement_payload() {
        let id = Uuid::new_v4();
        let mut records = BTreeMap::from([(id, browser(id))]);
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let action = propose(&mut state, &records, &fence);
        let dispatched = poll(&mut state, &records, id, 103).remove(0);
        state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 104)
            .unwrap();
        assert!(!state.actions[&action.id].intent.text().is_empty());
        records.get_mut(&id).unwrap().lease_expires_at = 100_000;
        let events = state.reconcile(&records, action.display_expires_at_ms);
        assert!(state.actions[&action.id].intent.text().is_empty());
        assert!(events.iter().any(
            |e| matches!(e,RuntimeData::PayloadCleared{action_id,..}if *action_id==action.id)
        ));
        assert_eq!(
            state.actions[&action.id].content_digest,
            action.content_digest
        );
        assert!(
            state
                .reconcile(&records, action.display_expires_at_ms + 1)
                .is_empty()
        );
    }

    #[test]
    fn ambiance_private_payloads_restored_from_earlier_policy_are_retired_before_dispatch() {
        for status in [
            ActionStatus::Proposed,
            ActionStatus::Dispatched,
            ActionStatus::Acknowledged,
        ] {
            let id = Uuid::new_v4();
            let records = BTreeMap::from([(id, browser(id))]);
            let mut state = RuntimeState::default();
            let fence = begin(&mut state, &records, id);
            let action = propose(&mut state, &records, &fence);
            // Represent a snapshot admitted by the previous output policy.
            // No new private proposal can reach this state.
            state.turn.as_mut().unwrap().privacy = PrivacyClass::Private;
            let stored = state.actions.get_mut(&action.id).unwrap();
            stored.privacy = PrivacyClass::Private;
            stored.status = status;
            let mut restored: RuntimeState =
                serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
            let events = restored.reconcile(&records, 103);
            assert!(
                restored.actions[&action.id].intent.text().is_empty(),
                "{status:?}"
            );
            assert!(events.iter().any(|event| matches!(event,
                RuntimeData::PayloadCleared { action_id, .. } if *action_id == action.id
            )));
            assert!(
                poll(&mut restored, &records, id, 104)
                    .iter()
                    .all(|pending| {
                        pending.status != ActionStatus::Dispatched
                            && pending.intent.text().is_empty()
                    })
            );
        }
    }

    /// The origin's status is derived from committed state only: working
    /// until something is proposed, waiting while an action is proposed or
    /// dispatched, shown once acknowledged (and still shown after the card
    /// retires), unknown after exhausted deadlines, nowhere when nothing was
    /// eligible; a shared origin never sees a class above its own ceiling.
    #[test]
    fn ambiance_turn_status_follows_committed_outcomes_and_caps_the_origins_class() {
        use super::super::status::{TurnState, TurnStatus};
        let id = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut records = BTreeMap::from([(id, browser(id)), (other, browser(other))]);
        for record in records.values_mut() {
            record.lease_expires_at = 100_000;
        }
        let mut state = RuntimeState::default();
        let status =
            |state: &mut RuntimeState, records: &BTreeMap<Uuid, Record>, who: Uuid, now| {
                let (result, _) = state
                    .apply(
                        "U:owner",
                        records,
                        RuntimeOperation::TurnStatus {
                            connection: RoomProof::Browser(proof(&records[&who])),
                        },
                        now,
                    )
                    .unwrap();
                let RuntimeResult::TurnStatus(status) = result else {
                    panic!()
                };
                status
            };
        assert_eq!(status(&mut state, &records, id, 100), None);
        let fence = begin(&mut state, &records, id);
        let expect = |state: TurnState, surface: Option<Uuid>, privacy: PrivacyClass| TurnStatus {
            turn_id: fence.turn_id,
            generation: fence.generation,
            state,
            surface,
            privacy,
        };
        assert_eq!(
            status(&mut state, &records, id, 101),
            Some(expect(TurnState::Working, None, PrivacyClass::SharedRoom))
        );
        assert_eq!(
            status(&mut state, &records, other, 101),
            None,
            "only the origin has a status"
        );
        let action = propose(&mut state, &records, &fence);
        assert_eq!(
            status(&mut state, &records, id, 102),
            Some(expect(
                TurnState::Waiting,
                Some(id),
                PrivacyClass::SharedRoom
            ))
        );
        let dispatched = poll(&mut state, &records, id, 103).remove(0);
        assert_eq!(
            status(&mut state, &records, id, 103),
            Some(expect(
                TurnState::Waiting,
                Some(id),
                PrivacyClass::SharedRoom
            ))
        );
        state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 104)
            .unwrap();
        assert_eq!(
            status(&mut state, &records, id, 104),
            Some(expect(TurnState::Shown, Some(id), PrivacyClass::SharedRoom))
        );
        // Retiring the shown card does not unsay the committed outcome.
        state.reconcile(&records, action.display_expires_at_ms);
        assert_eq!(state.actions[&action.id].status, ActionStatus::Cancelled);
        assert_eq!(
            status(&mut state, &records, id, action.display_expires_at_ms),
            Some(expect(TurnState::Shown, Some(id), PrivacyClass::SharedRoom))
        );
        // Exhausted delivery deadlines are an unknown outcome, never a claim.
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        propose(&mut state, &records, &fence);
        poll(&mut state, &records, id, 103);
        let retry = poll(&mut state, &records, id, 3103).remove(0);
        assert_eq!(retry.attempts, 2);
        // The other display is gone, not merely looked away from, so there
        // is no fallback and the outcome stays unknown.
        records.get_mut(&other).unwrap().lease_expires_at = 6000;
        state.reconcile(&records, 6103);
        assert_eq!(
            status(&mut state, &records, id, 6104),
            Some(TurnStatus {
                turn_id: fence.turn_id,
                generation: fence.generation,
                state: TurnState::Unknown,
                surface: Some(id),
                privacy: PrivacyClass::SharedRoom,
            })
        );
        // A private answer with no personal surface and a public answer with
        // no visible surface end the same way: nowhere, at the shared class.
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let (result, _) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::VisualTextCard {
                        text: "private service data".into(),
                    },
                    privacy: PrivacyClass::Private,
                    hint: None,
                },
                102,
            )
            .unwrap();
        assert!(matches!(result, RuntimeResult::Blocked));
        assert_eq!(state.turn.as_ref().unwrap().privacy, PrivacyClass::Private);
        state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Finish {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                },
                103,
            )
            .unwrap();
        let private = status(&mut state, &records, id, 104).unwrap();
        assert_eq!(
            (private.state, private.surface, private.privacy),
            (TurnState::Nowhere, None, PrivacyClass::SharedRoom)
        );
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Cancel {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                },
                102,
            )
            .unwrap();
        let cancelled = status(&mut state, &records, id, 103).unwrap();
        assert_eq!(
            (cancelled.state, cancelled.surface, cancelled.privacy),
            (TurnState::Nowhere, None, PrivacyClass::SharedRoom)
        );
    }

    /// An acknowledged shared choice list becomes bounded recent context
    /// naming its numbered items; a private list is never remembered, and
    /// a retired list clears its whole payload.
    #[test]
    fn ambiance_acknowledged_choice_list_is_remembered_at_the_shared_class_only() {
        let id = Uuid::new_v4();
        let records = BTreeMap::from([(id, browser(id))]);
        let list = SemanticIntent::ChoiceList {
            title: "Films for tonight".into(),
            items: vec![
                policy::Choice {
                    id: "1".into(),
                    title: "Arrival".into(),
                    detail: "2016 science fiction".into(),
                },
                policy::Choice {
                    id: "2".into(),
                    title: "Heat".into(),
                    detail: String::new(),
                },
            ],
        };
        assert!(list.valid() && list.has_payload());
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let (RuntimeResult::Proposed(action), _) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: list.clone(),
                    privacy: PrivacyClass::Public,
                    hint: None,
                },
                102,
            )
            .unwrap()
        else {
            panic!("choice card")
        };
        assert_eq!(action.content_digest, list.content_digest());
        let dispatched = poll(&mut state, &records, id, 103).remove(0);
        let (_, events) = state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 104)
            .unwrap();
        let remembered = state
            .recent_context
            .first()
            .cloned()
            .expect("choice context");
        assert_eq!(remembered.kind, RecentContextKind::Choices);
        assert_eq!(remembered.text, "Films for tonight");
        assert_eq!(remembered.items, vec!["Arrival", "Heat"]);
        assert_eq!(
            remembered.list_digest.as_deref(),
            Some(action.content_digest.as_str())
        );
        assert_eq!(remembered.source_surface, id);
        assert_eq!(remembered.privacy, PrivacyClass::SharedRoom);
        assert_eq!(remembered.expires_at_ms, 104 + RECENT_CONTEXT_MS);
        assert!(events.iter().any(|e| matches!(
            e,
            RuntimeData::RecentContextRemembered {
                context: RecentContextKind::Choices,
                ..
            }
        )));
        assert_eq!(
            state.turn.as_ref().unwrap().outcome,
            Some(TurnOutcome {
                surface_id: id,
                channel: Channel::VisualCard
            })
        );
        // A repeated acknowledgment neither re-remembers nor moves the outcome.
        state
            .apply("U:owner", &records, ack(&dispatched, &records[&id]), 105)
            .unwrap();
        assert_eq!(state.recent_context[0].created_at_ms, 104);
        state.reconcile(&records, action.display_expires_at_ms);
        assert!(!state.actions[&action.id].intent.has_payload());
        assert!(!state.actions[&action.id].intent.valid());
        // Above the shared class the list is shown to a personal surface
        // only; it leaves no shared memory behind.
        let mut state = RuntimeState::default();
        let fence = begin(&mut state, &records, id);
        let (result, _) = state
            .apply(
                "U:owner",
                &records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: list,
                    privacy: PrivacyClass::Private,
                    hint: None,
                },
                102,
            )
            .unwrap();
        assert!(matches!(result, RuntimeResult::Blocked));
        assert!(state.recent_context.is_empty());
    }

    /// A screen that is connected but reporting no foreground is still a
    /// screen. The runtime picks it, holds the card for it, and repairs when
    /// nobody comes; it does not quietly pretend the screen is not there.
    #[test]
    fn ambiance_a_card_is_held_for_a_screen_nobody_is_in_front_of_and_repairs_when_nobody_comes() {
        let pin = crate::surface_registry::pin_surface_id("U:owner", "aabb");
        let pin_record = transition(
            None,
            0,
            pin,
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            100,
        )
        .unwrap()
        .0;
        let screen = Uuid::new_v4();
        let mut records = BTreeMap::from([(pin, pin_record), (screen, browser(screen))]);
        records.get_mut(&screen).unwrap().visible = false;
        let mut state = RuntimeState::default();
        let begin_pin = |state: &mut RuntimeState, records: &BTreeMap<Uuid, Record>, now| {
            let (result, _) = state
                .apply(
                    "U:owner",
                    records,
                    RuntimeOperation::Begin {
                        turn_id: Uuid::new_v4(),
                        worker: Uuid::new_v4(),
                        origin: OriginProof::Pin {
                            device: AuthenticatedDeviceIdentity::from_edge("aabb").unwrap(),
                            surface_id: pin,
                            echo_fingerprint: super::super::echo::fingerprint("what is on tonight"),
                        },
                        request_digest: hash(b"what is on tonight"),
                        privacy_floor: PrivacyClass::SharedRoom,
                    },
                    now,
                )
                .unwrap();
            let RuntimeResult::Begun(fence) = result else {
                panic!("the turn must begin")
            };
            fence
        };
        let fence = begin_pin(&mut state, &records, 101);
        let propose =
            |state: &mut RuntimeState, records: &BTreeMap<Uuid, Record>, fence: &TurnFence, now| {
                state
                    .apply(
                        "U:owner",
                        records,
                        RuntimeOperation::Propose {
                            turn_id: fence.turn_id,
                            generation: fence.generation,
                            worker: fence.worker,
                            intent: SemanticIntent::VisualTextCard {
                                text: "Three films tonight.".into(),
                            },
                            privacy: PrivacyClass::SharedRoom,
                            hint: None,
                        },
                        now,
                    )
                    .unwrap()
            };
        let (result, events) = propose(&mut state, &records, &fence, 102);
        let RuntimeResult::Proposed(action) = result else {
            panic!("a screen nobody is in front of is ranked, not skipped")
        };
        assert_eq!(action.surface_id, screen);
        // It is held long enough that walking over to it is an answer.
        assert_eq!(action.deadline_ms, 102 + ATTENDED_WAIT_MS);
        // The decision says what shape it bound and what the screen cost for
        // not being in front of anyone, so Center can say both.
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeData::Decision { shape: Some(policy::Shape::Note), candidates, .. }
                if candidates.iter().any(|c| c.surface_id == screen
                    && c.blocker.is_none()
                    && c.attention == policy::UNATTENDED)
        )));
        // Nobody comes. The card is retired at its own window rather than
        // waiting out a private display's five minutes.
        state.reconcile(&records, 102 + ATTENDED_WAIT_MS);
        assert_eq!(state.actions[&action.id].status, ActionStatus::Cancelled);
        // With someone in front of it, the same request is dispatched on the
        // ordinary acknowledgment clock and carries no penalty.
        records.get_mut(&screen).unwrap().visible = true;
        let mut state = RuntimeState::default();
        let fence = begin_pin(&mut state, &records, 101);
        let (result, events) = propose(&mut state, &records, &fence, 102);
        let RuntimeResult::Proposed(attended) = result else {
            panic!("the same request must still land")
        };
        assert_eq!(attended.surface_id, screen);
        assert_eq!(attended.deadline_ms, 102 + ACK_MS);
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeData::Decision { candidates, .. }
                if candidates.iter().any(|c| c.surface_id == screen && c.attention == 0)
        )));
    }
}
