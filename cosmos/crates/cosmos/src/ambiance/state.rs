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
pub const WORKER_LEASE_MS: i64 = 75_000;
pub const MAX_ACTIONS: usize = 32;

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
    #[serde(default)]
    pub disclosures: Vec<super::disclosure::Disclosure>,
    #[serde(default)]
    pub voice: Option<super::voice::Intake>,
    #[serde(default)]
    pub lookup: Option<super::lookup::Lookup>,
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
    Dispatched,
    Acknowledged,
    Cancelled,
    OutcomeUnknown,
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
}
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
    pub lookup_policies: BTreeMap<Uuid, super::lookup::BoundApproval>,
    #[serde(default)]
    pub place_lookup_policies: BTreeMap<Uuid, super::lookup::BoundApproval>,
}

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
    LookupStarted {
        fence: TurnFence,
        lookup: super::lookup::Lookup,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<policy::RoutingTarget>,
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

    /// Current availability and the incarnation an action must bind to. A
    /// native binds to its signed connection; the registry record stays nil.
    pub(super) fn presence(&self, record: &Record, now: i64) -> policy::Presence {
        match record.binding {
            Binding::Browser => policy::Presence {
                available: record.view(now).available,
                incarnation: record.incarnation,
            },
            Binding::Pin { .. } => policy::Presence {
                available: !record.revoked,
                incarnation: record.incarnation,
            },
            Binding::Native { .. } => {
                let connection = self
                    .native_connections
                    .get(&record.surface_id)
                    .and_then(|state| state.connection.as_ref())
                    .filter(|connection| connection.current(record, now));
                policy::Presence {
                    available: connection.is_some_and(|connection| connection.visible),
                    incarnation: connection
                        .map_or(Uuid::nil(), |connection| connection.incarnation),
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn candidate(
        &self,
        records: &BTreeMap<Uuid, Record>,
        record: &Record,
        origin: Uuid,
        channel: Channel,
        privacy: PrivacyClass,
        hint: Option<policy::RoutingTarget>,
        now: i64,
    ) -> Candidate {
        let mut presence = self.presence(record, now);
        // Native speech exists only as the runtime's own disclosed synthesis.
        // Without the origin owner's current provider permission there is no
        // speech to route, so the surface is unavailable for that channel.
        if channel == Channel::AudioTts && matches!(record.binding, Binding::Native { .. }) {
            presence.available = presence.available
                && self
                    .disclosure_policy(records, origin)
                    .ok()
                    .flatten()
                    .and_then(|approval| approval.policy)
                    .is_some_and(|policy| policy.synthesis && privacy <= policy.maximum_class);
        }
        policy::candidate(record, presence, origin, channel, privacy, hint)
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
            if matches!(
                action.status,
                ActionStatus::Cancelled | ActionStatus::OutcomeUnknown
            ) {
                if !action.intent.text().is_empty() {
                    return 0;
                }
                continue;
            }
            due = due.min(action.display_expires_at_ms);
            if matches!(
                action.status,
                ActionStatus::Proposed | ActionStatus::Dispatched
            ) {
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
            if matches!(
                action.status,
                ActionStatus::Cancelled | ActionStatus::OutcomeUnknown
            ) && !action.intent.text().is_empty()
            {
                match &mut action.intent {
                    SemanticIntent::InformationalSpeech { text }
                    | SemanticIntent::VisualTextCard { text } => text.clear(),
                    SemanticIntent::PlaceAddressCard { .. } => {}
                }
                events.push(RuntimeData::PayloadCleared {
                    action_id: action.id,
                    content_digest: action.content_digest.clone(),
                });
            }
        }
        events
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
        // action mutates; a target that lost its foreground is repaired.
        let validity: BTreeMap<Uuid, bool> = self
            .actions
            .values()
            .map(|action| {
                let valid = origin_valid
                    && action
                        .confirmation_root
                        .is_none_or(|root| confirmed_roots.contains(&root))
                    && now < action.display_expires_at_ms
                    && self.turn.as_ref().is_some_and(|t| {
                        t.fence.generation == action.generation
                            && t.privacy <= PrivacyClass::SharedRoom
                    })
                    && records.get(&action.surface_id).is_some_and(|r| {
                        self.presence(r, now).incarnation == action.incarnation
                            && self
                                .candidate(
                                    records,
                                    r,
                                    self.turn.as_ref().unwrap().fence.origin_surface,
                                    action.channel,
                                    action.privacy,
                                    None,
                                    now,
                                )
                                .blocker
                                .is_none()
                    });
                (action.id, valid)
            })
            .collect();
        for action in self.actions.values_mut() {
            if matches!(
                action.status,
                ActionStatus::Cancelled | ActionStatus::OutcomeUnknown
            ) {
                continue;
            }
            let valid = validity[&action.id];
            if !valid {
                let repair = origin_valid
                    && now < action.display_expires_at_ms
                    && self
                        .turn
                        .as_ref()
                        .is_some_and(|t| t.privacy <= PrivacyClass::SharedRoom)
                    && action.channel == Channel::VisualCard
                    && matches!(
                        action.status,
                        ActionStatus::Proposed | ActionStatus::Dispatched
                    );
                action.status = if action.channel == Channel::AudioTts && action.attempts > 0 {
                    ActionStatus::OutcomeUnknown
                } else {
                    ActionStatus::Cancelled
                };
                events.push(action_event(action));
                if repair {
                    repairs.push(action.clone());
                }
            } else if action.status == ActionStatus::Proposed && now >= action.deadline_ms {
                action.status = if action.attempts > 0 {
                    ActionStatus::OutcomeUnknown
                } else {
                    ActionStatus::Cancelled
                };
                events.push(action_event(action));
                if action.channel == Channel::VisualCard {
                    repairs.push(action.clone());
                }
            } else if action.status == ActionStatus::Dispatched && now >= action.deadline_ms {
                if action.channel == Channel::VisualCard && action.attempts == 1 {
                    // Retry only on this exact surface/key. Poll reclaims under
                    // policy, then gives the same key another bounded deadline.
                    action.status = ActionStatus::Proposed;
                    action.deadline_ms =
                        now.saturating_add(ACK_MS).min(action.display_expires_at_ms);
                } else {
                    action.status = ActionStatus::OutcomeUnknown;
                    if action.channel == Channel::VisualCard {
                        repairs.push(action.clone());
                    }
                }
                events.push(action_event(action));
            }
        }
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
                        previous.privacy,
                        None,
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
                action.deadline_ms = now.saturating_add(ACK_MS).min(action.display_expires_at_ms);
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
                && self
                    .actions
                    .values()
                    .all(|a| !matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched))
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
        if turn.finished
            || turn.voice_pending()
            || action.generation != generation
            || action.worker != worker
            || action.status != ActionStatus::Proposed
            || !self.origin_valid(turn, records, now)
        {
            return Err(RuntimeError::Stale);
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
                    action.privacy,
                    None,
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
        events.push(action_event(action));
        Ok((action.clone(), events))
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
            || turn.privacy > PrivacyClass::SharedRoom
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
                                action.privacy,
                                None,
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
            SemanticIntent::InformationalSpeech { .. } | SemanticIntent::VisualTextCard { .. }
                if turn.completed_places_lookup() && confirmation.is_none() =>
            {
                return Err(RuntimeError::PolicyBlocked);
            }
            _ => {}
        }
        let privacy = turn.privacy.max(privacy);
        if intent.channel() == Channel::VisualCard
            && privacy <= PrivacyClass::SharedRoom
            && self.actions.values().any(|a| {
                a.channel == Channel::VisualCard
                    && matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched)
            })
        {
            return Err(RuntimeError::Busy);
        }
        let mut candidates: Vec<_> = records
            .values()
            .filter(|r| !r.revoked)
            .map(|r| {
                self.candidate(
                    records,
                    r,
                    turn.fence.origin_surface,
                    intent.channel(),
                    privacy,
                    hint,
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
            hint,
            candidates,
        });
        self.turn.as_mut().unwrap().privacy = privacy;
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
            let incarnation = self.presence(record, now).incarnation;
            let content_digest = intent.content_digest();
            let display_expires_at_ms = match &intent {
                SemanticIntent::PlaceAddressCard { content } => content.expires_at_ms,
                _ => now.checked_add(60_000).ok_or(RuntimeError::Unavailable)?,
            };
            let display_expires_at_ms = confirmation
                .as_ref()
                .map_or(display_expires_at_ms, |confirmation| {
                    display_expires_at_ms.min(confirmation.expires_at_ms)
                });
            let action = Action {
                id,
                root_id: id,
                turn_id,
                generation,
                worker,
                surface_id,
                channel: intent.channel(),
                incarnation,
                content_digest,
                intent,
                privacy,
                status: ActionStatus::Proposed,
                deadline_ms: now
                    .checked_add(ACK_MS)
                    .ok_or(RuntimeError::Unavailable)?
                    .min(display_expires_at_ms),
                display_expires_at_ms,
                attempts: 0,
                fallbacks,
                confirmation_root: confirmation
                    .as_ref()
                    .map(|confirmation| confirmation.root_id),
                origin_surface,
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
            } => {
                let (receipt, appended) = self.complete_lookup(
                    records,
                    fence,
                    lookup,
                    super::lookup::Completion {
                        evidence_digest,
                        privacy,
                        visual,
                    },
                    now,
                )?;
                events.extend(appended);
                events.extend(self.reconcile(records, now));
                RuntimeResult::LookupCompleted(receipt)
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
                if let OriginProof::Pin {
                    echo_fingerprint, ..
                }
                | OriginProof::SequencedPin {
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
                if self
                    .turn
                    .as_ref()
                    .is_some_and(|t| !t.cancelled && !t.finished && now < t.lease_until_ms)
                {
                    return Err(RuntimeError::Busy);
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
                        _ => PrivacyClass::Public,
                    });
                self.turn = Some(Turn {
                    fence: fence.clone(),
                    origin_incarnation: match &origin {
                        OriginProof::SequencedRoom { connection, .. } => connection.incarnation(),
                        _ => record.incarnation,
                    },
                    origin_revision: record.revision,
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
                if turn.privacy > PrivacyClass::SharedRoom || turn.completed_places_lookup() {
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
                let output = OutputProposal {
                    intent: SemanticIntent::InformationalSpeech {
                        text: "Displayed on your approved screen.".into(),
                    },
                    privacy: turn.privacy.max(acknowledged.privacy),
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
                    || !self.presence(record, now).available
                    || !matches!(
                        action.status,
                        ActionStatus::Dispatched | ActionStatus::Acknowledged
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
                        || (channel == Channel::AudioTts
                            && matches!(record.binding, Binding::Native { .. })))
                    || action.content_digest != content_digest
                    || (action.status != ActionStatus::Acknowledged && now >= action.deadline_ms)
                    || !self.presence(record, now).available
                    || !matches!(
                        action.status,
                        ActionStatus::Dispatched | ActionStatus::Acknowledged
                    )
                {
                    return Err(RuntimeError::Stale);
                }
                let action = self.actions.get_mut(&action_id).unwrap();
                if action.status != ActionStatus::Acknowledged {
                    action.status = ActionStatus::Acknowledged;
                    events.push(action_event(action));
                }
                let result = RuntimeResult::Acknowledged(action.clone());
                let turn = self.turn.as_mut().unwrap();
                if records
                    .get(&turn.fence.origin_surface)
                    .is_some_and(|r| matches!(r.binding, Binding::Browser | Binding::Native { .. }))
                    && !turn.finished
                    && self.actions.values().all(|a| {
                        !matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched)
                    })
                {
                    turn.finished = true;
                    events.push(RuntimeData::TurnFinished {
                        turn_id,
                        generation,
                    });
                }
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
                let pending: Vec<_> = self
                    .actions
                    .values()
                    .filter(|a| {
                        a.surface_id == connection.surface_id()
                            && a.incarnation == connection.incarnation()
                            && a.status == ActionStatus::Proposed
                            && a.channel == Channel::VisualCard
                    })
                    .map(|a| (a.id, a.generation, a.worker))
                    .collect();
                for (id, generation, worker) in pending {
                    let (_, appended) = self.claim(records, id, generation, worker, now, false)?;
                    events.extend(appended);
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
                if self
                    .actions
                    .values()
                    .any(|a| matches!(a.status, ActionStatus::Proposed | ActionStatus::Dispatched))
                {
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
                class,
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
}
