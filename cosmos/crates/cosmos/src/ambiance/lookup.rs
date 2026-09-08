//! One owner-approved lookup disclosure per turn, committed before provider I/O.
//! Only provider identities and digests enter the durable authority ledger.
use super::{PrivacyClass, RuntimeData, RuntimeError, RuntimeState, Turn, TurnFence};
use crate::{
    backends::lookup::{LookupProviderIdentity, LookupService},
    surface_registry::{Binding, Record},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub fn owner_approval(service: LookupService) -> &'static str {
    match service {
        LookupService::Web => "approve-web-lookup-disclosure-v1",
        LookupService::Places => "approve-places-lookup-disclosure-v1",
    }
}

pub const LOOKUP_MS: i64 = 15_000;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub provider: LookupProviderIdentity,
    pub maximum_class: PrivacyClass,
}

impl Policy {
    fn valid(&self) -> bool {
        self.provider.valid() && self.maximum_class == PrivacyClass::SharedRoom
    }

    fn permits(&self, request: &Request) -> bool {
        self.valid() && self.provider == request.provider && request.privacy <= self.maximum_class
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub approval_revision: u64,
    pub revision: u64,
    pub policy: Option<Policy>,
}

/// The registry approval the owner actually reviewed. Browser heartbeats may
/// advance its revision while preserving this exact connection incarnation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalBinding {
    pub approval_revision: u64,
    #[serde(deserialize_with = "required_incarnation")]
    pub incarnation: Option<Uuid>,
}

fn required_incarnation<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Uuid>, D::Error> {
    Option::deserialize(deserializer)
}

impl ApprovalBinding {
    fn for_record(record: &Record) -> Self {
        Self {
            approval_revision: record.revision,
            incarnation: matches!(record.binding, Binding::Browser).then_some(record.incarnation),
        }
    }
}

/// Browser registry revisions also count ordinary visibility heartbeats.
/// Keep the reviewed incarnation with the durable approval so changing the
/// browser connection retires authority even if its policy is unchanged.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoundApproval {
    approval: Approval,
    origin_incarnation: Option<Uuid>,
}

impl BoundApproval {
    fn current(&self, service: LookupService, record: &Record) -> bool {
        !record.revoked
            && self.approval.policy.as_ref().is_none_or(|policy| {
                policy.valid() && policy.provider.provider.service() == service
            })
            && self.approval.approval_revision > 0
            && self.approval.approval_revision <= MAX_REVISION
            && self.approval.revision > 0
            && self.approval.revision <= MAX_REVISION
            && match record.binding {
                Binding::Browser => {
                    self.origin_incarnation == Some(record.incarnation)
                        && record.revision >= self.approval.approval_revision
                }
                Binding::Pin { .. } | Binding::Native { .. } => {
                    self.origin_incarnation.is_none()
                        && record.revision == self.approval.approval_revision
                }
            }
    }
}

/// Constructed from the actual configured provider request by runtime code,
/// never from an HTTP body or model-supplied authority. No query text is stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub provider: LookupProviderIdentity,
    pub query_digest: String,
    pub payload_digest: String,
    pub privacy: PrivacyClass,
}

impl Request {
    fn valid(&self) -> bool {
        self.provider.valid()
            && super::state::digest_valid(&self.query_digest)
            && super::state::digest_valid(&self.payload_digest)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub evidence_digest: String,
    pub received_at_ms: i64,
    pub privacy: PrivacyClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual: Option<super::visual::Reference>,
}

impl Receipt {
    fn visual_valid(&self, service: LookupService, now: i64) -> bool {
        match service {
            LookupService::Web => self.visual.is_none(),
            LookupService::Places => self.visual.as_ref().is_some_and(|visual| {
                visual.valid()
                    && visual.expires_at_ms > now
                    && visual.expires_at_ms > self.received_at_ms
                    && self
                        .received_at_ms
                        .checked_add(60_000)
                        .is_some_and(|limit| visual.expires_at_ms <= limit)
            }),
        }
    }
}

pub(super) struct Completion {
    pub evidence_digest: String,
    pub privacy: PrivacyClass,
    pub visual: Option<super::visual::Reference>,
    pub query_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lookup {
    pub id: Uuid,
    pub policy_revision: u64,
    pub request: Request,
    pub started_at_ms: i64,
    pub receipt: Option<Receipt>,
}

impl Lookup {
    pub(super) fn deadline_ms(&self) -> i64 {
        self.started_at_ms.saturating_add(LOOKUP_MS)
    }
}

fn record(records: &BTreeMap<Uuid, Record>, surface: Uuid) -> Result<&Record, RuntimeError> {
    records
        .get(&surface)
        .filter(|record| {
            !record.revoked
                && !surface.is_nil()
                && record.revision > 0
                && record.revision <= MAX_REVISION
                && match record.binding {
                    Binding::Browser => {
                        !record.incarnation.is_nil()
                            && crate::surface_registry::known_browser_manifest(
                                &record.approved_manifest,
                            )
                    }
                    Binding::Pin { .. } => {
                        record.approved_manifest == crate::surface_registry::pin_manifest()
                    }
                    Binding::Native { .. } => {
                        crate::surface_registry::native_declares(record, "audio.tts")
                    }
                }
        })
        .ok_or(RuntimeError::InvalidOrigin)
}

impl RuntimeState {
    fn lookup_approvals(&self, service: LookupService) -> &BTreeMap<Uuid, BoundApproval> {
        match service {
            LookupService::Web => &self.lookup_policies,
            LookupService::Places => &self.place_lookup_policies,
        }
    }

    fn lookup_approvals_mut(
        &mut self,
        service: LookupService,
    ) -> &mut BTreeMap<Uuid, BoundApproval> {
        match service {
            LookupService::Web => &mut self.lookup_policies,
            LookupService::Places => &mut self.place_lookup_policies,
        }
    }

    pub(super) fn reconcile_lookup_policies(&mut self, records: &BTreeMap<Uuid, Record>) {
        for service in [LookupService::Web, LookupService::Places] {
            self.lookup_approvals_mut(service).retain(|id, approval| {
                records
                    .get(id)
                    .is_some_and(|record| approval.current(service, record))
            });
        }
    }

    pub(super) fn lookup_policy(
        &self,
        records: &BTreeMap<Uuid, Record>,
        service: LookupService,
        surface: Uuid,
    ) -> Result<(Option<Approval>, ApprovalBinding), RuntimeError> {
        let record = record(records, surface)?;
        Ok((
            self.lookup_approvals(service)
                .get(&surface)
                .filter(|bound| bound.current(service, record))
                .map(|bound| bound.approval.clone()),
            ApprovalBinding::for_record(record),
        ))
    }

    pub(super) fn set_lookup_policy(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        service: LookupService,
        surface: Uuid,
        reviewed: ApprovalBinding,
        expected_revision: u64,
        policy: Option<Policy>,
    ) -> Result<(Approval, ApprovalBinding, Vec<RuntimeData>), RuntimeError> {
        let record = record(records, surface)?;
        let (current, binding) = self.lookup_policy(records, service, surface)?;
        let ApprovalBinding {
            approval_revision,
            incarnation: approval_incarnation,
        } = reviewed;
        if approval_revision == 0
            || approval_revision > MAX_REVISION
            || approval_incarnation.is_some_and(|incarnation| incarnation.is_nil())
            || expected_revision >= MAX_REVISION
            || policy.as_ref().is_some_and(|policy| {
                !policy.valid() || policy.provider.provider.service() != service
            })
        {
            return Err(RuntimeError::InvalidRequest);
        }
        let reviewed_revision_current = match record.binding {
            Binding::Browser => approval_revision <= record.revision,
            Binding::Native { .. } | Binding::Pin { .. } => approval_revision == record.revision,
        };
        if !reviewed_revision_current
            || approval_incarnation != binding.incarnation
            || current.as_ref().map_or(0, |a| a.revision) != expected_revision
        {
            return Err(RuntimeError::Stale);
        }
        let approval = Approval {
            approval_revision,
            revision: expected_revision + 1,
            policy,
        };
        self.lookup_approvals_mut(service).insert(
            surface,
            BoundApproval {
                approval: approval.clone(),
                origin_incarnation: binding.incarnation,
            },
        );
        let event = match service {
            LookupService::Web => RuntimeData::LookupPolicyChanged {
                surface_id: surface,
                approval: approval.clone(),
            },
            LookupService::Places => RuntimeData::PlaceLookupPolicyChanged {
                surface_id: surface,
                approval: approval.clone(),
            },
        };
        Ok((approval, binding, vec![event]))
    }

    /// Nonrecursive authority check used by origin reconciliation, including
    /// after completion. Changing an approval retires already proposed output.
    pub(super) fn lookup_authority_valid(
        &self,
        turn: &Turn,
        records: &BTreeMap<Uuid, Record>,
        now: i64,
    ) -> bool {
        let Some(lookup) = &turn.lookup else {
            return true;
        };
        let Ok(record) = record(records, turn.fence.origin_surface) else {
            return false;
        };
        let service = lookup.request.provider.provider.service();
        let Some(bound) = self
            .lookup_approvals(service)
            .get(&turn.fence.origin_surface)
        else {
            return false;
        };
        if !bound.current(service, record)
            || lookup.id.is_nil()
            || !lookup.request.valid()
            || lookup.policy_revision != bound.approval.revision
            || !bound
                .approval
                .policy
                .as_ref()
                .is_some_and(|policy| policy.permits(&lookup.request))
            || lookup.started_at_ms <= 0
            || now < lookup.started_at_ms
        {
            return false;
        }
        match &lookup.receipt {
            None => now < lookup.deadline_ms(),
            Some(receipt) => {
                super::state::digest_valid(&receipt.evidence_digest)
                    && receipt.received_at_ms >= lookup.started_at_ms
                    && receipt.received_at_ms < lookup.deadline_ms()
                    && receipt.received_at_ms <= now
                    && receipt.privacy >= lookup.request.privacy
                    && receipt.visual_valid(service, now)
            }
        }
    }

    fn check_lookup_request(
        &self,
        records: &BTreeMap<Uuid, Record>,
        fence: &TurnFence,
        request: &Request,
        now: i64,
    ) -> Result<(u64, PrivacyClass), RuntimeError> {
        let turn = self.fence(fence.turn_id, fence.generation, fence.worker, now)?;
        if turn.finished
            || turn.voice_pending()
            || turn.fence.origin_surface != fence.origin_surface
            || !self.origin_valid(turn, records, now)
        {
            return Err(RuntimeError::Stale);
        }
        if !request.valid() {
            return Err(RuntimeError::InvalidRequest);
        }
        let privacy = turn.privacy.max(request.privacy);
        let mut effective = request.clone();
        effective.privacy = privacy;
        let approval = self
            .lookup_policy(
                records,
                request.provider.provider.service(),
                fence.origin_surface,
            )?
            .0
            .ok_or(RuntimeError::PolicyBlocked)?;
        if !approval
            .policy
            .as_ref()
            .is_some_and(|policy| policy.permits(&effective))
        {
            return Err(RuntimeError::PolicyBlocked);
        }
        Ok((approval.revision, privacy))
    }

    pub(super) fn start_lookup(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        fence: TurnFence,
        mut request: Request,
        id: Uuid,
        now: i64,
    ) -> Result<(Lookup, Vec<RuntimeData>), RuntimeError> {
        if id.is_nil() || now <= 0 || now.checked_add(LOOKUP_MS).is_none() {
            return Err(RuntimeError::InvalidRequest);
        }
        let (policy_revision, privacy) =
            self.check_lookup_request(records, &fence, &request, now)?;
        if self.turn.as_ref().unwrap().lookup.is_some()
            || self.turn.as_ref().unwrap().analysis.is_some()
            || !self.actions.is_empty()
        {
            return Err(RuntimeError::Busy);
        }
        request.privacy = privacy;
        let lookup = Lookup {
            id,
            policy_revision,
            request,
            started_at_ms: now,
            receipt: None,
        };
        let turn = self.turn.as_mut().unwrap();
        turn.privacy = privacy;
        turn.lookup = Some(lookup.clone());
        Ok((
            lookup.clone(),
            vec![RuntimeData::LookupStarted {
                fence,
                lookup: Box::new(lookup),
            }],
        ))
    }

    pub(super) fn check_lookup(
        &self,
        records: &BTreeMap<Uuid, Record>,
        fence: &TurnFence,
        lookup: &Lookup,
        now: i64,
    ) -> Result<(), RuntimeError> {
        let (revision, _) = self.check_lookup_request(records, fence, &lookup.request, now)?;
        if lookup.receipt.is_some()
            || lookup.policy_revision != revision
            || self.turn.as_ref().unwrap().lookup.as_ref() != Some(lookup)
        {
            return Err(RuntimeError::Stale);
        }
        Ok(())
    }

    pub(super) fn complete_lookup(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        fence: TurnFence,
        lookup: Lookup,
        completion: Completion,
        now: i64,
    ) -> Result<(Receipt, Vec<RuntimeData>), RuntimeError> {
        self.check_lookup(records, &fence, &lookup, now)?;
        if !super::state::digest_valid(&completion.evidence_digest) {
            return Err(RuntimeError::InvalidRequest);
        }
        let receipt = Receipt {
            evidence_digest: completion.evidence_digest,
            received_at_ms: now,
            privacy: self
                .turn
                .as_ref()
                .unwrap()
                .privacy
                .max(lookup.request.privacy)
                .max(completion.privacy),
            visual: completion.visual,
        };
        if !receipt.visual_valid(lookup.request.provider.provider.service(), now) {
            return Err(RuntimeError::InvalidRequest);
        }
        let turn = self.turn.as_mut().unwrap();
        turn.privacy = receipt.privacy;
        turn.lookup.as_mut().unwrap().receipt = Some(receipt.clone());
        let source_surface = turn.fence.origin_surface;
        let mut events = vec![RuntimeData::LookupCompleted {
            fence,
            id: lookup.id,
            policy_revision: lookup.policy_revision,
            receipt: receipt.clone(),
        }];
        // A completed place lookup leaves the owner's own query text as
        // bounded recent context. Provider content stays transient.
        if lookup.request.provider.provider.service() == LookupService::Places
            && receipt.visual.is_some()
            && receipt.privacy <= PrivacyClass::SharedRoom
            && let Some(text) = completion
                .query_text
                .filter(|text| !text.trim().is_empty() && text.len() <= 512)
        {
            let expires_at_ms = now.saturating_add(super::state::RECENT_CONTEXT_MS);
            self.remember(super::state::RecentContext {
                kind: super::state::RecentContextKind::PlaceQuery,
                text,
                items: Vec::new(),
                source_surface,
                privacy: receipt.privacy,
                created_at_ms: now,
                expires_at_ms,
                list_digest: None,
                continuation: None,
            });
            events.push(RuntimeData::RecentContextRemembered {
                context: super::state::RecentContextKind::PlaceQuery,
                source_surface,
                privacy: receipt.privacy,
                expires_at_ms,
            });
        }
        Ok((receipt, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambiance::{
        Action, ActionStatus, BrowserProof, InputStamp, NativeProof, OriginProof, PinProof,
        RoomProof, RuntimeOperation, RuntimeResult, SemanticIntent, echo, native_connection,
    };
    use crate::backends::{places, search};
    use crate::integrations::{MapsConfig, SearchConfig};
    use crate::surface_registry::{self, Mutation, hash, transition};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use cosmos_core::AuthenticatedDeviceIdentity;
    use p256::ecdsa::{Signature, SigningKey, signature::Signer};

    const PRINCIPAL: &str = "U:lookup-state-test";
    const TEXT: &str = "current public lookup request";

    #[derive(Clone, Copy, Debug)]
    enum Kind {
        Browser,
        Native,
        Pin,
    }
    const KINDS: [Kind; 3] = [Kind::Browser, Kind::Native, Kind::Pin];

    #[derive(Clone)]
    enum Origin {
        Browser(BrowserProof),
        Native(NativeProof),
        Pin(PinProof),
    }

    #[derive(Clone)]
    struct Fixture {
        state: RuntimeState,
        records: BTreeMap<Uuid, Record>,
        origin: Origin,
        fence: TurnFence,
        renderer: Uuid,
    }

    fn provider(host: &str) -> LookupProviderIdentity {
        let providers = search::lookup_providers_for_test(&SearchConfig {
            searxng_base_url: Some(format!("https://{host}")),
            ..Default::default()
        });
        let identity = providers
            .into_iter()
            .next()
            .expect("configured synthetic provider");
        assert!(identity.valid());
        identity
    }

    fn policy() -> Policy {
        Policy {
            provider: provider("lookup.example.test"),
            maximum_class: PrivacyClass::SharedRoom,
        }
    }

    fn service_policy(service: LookupService) -> Policy {
        match service {
            LookupService::Web => policy(),
            LookupService::Places => Policy {
                provider: places::lookup_providers_for_test(
                    &MapsConfig {
                        google_maps_key: Some("synthetic-fixture".into()),
                    },
                    "https://maps.googleapis.com/maps/api/place/textsearch/json",
                )
                .into_iter()
                .next()
                .expect("configured synthetic places provider"),
                maximum_class: PrivacyClass::SharedRoom,
            },
        }
    }

    fn service_request(service: LookupService) -> Request {
        Request {
            provider: service_policy(service).provider,
            ..request()
        }
    }

    fn visual_reference(expires_at_ms: i64) -> super::super::visual::Reference {
        super::super::visual::Reference {
            id: Uuid::new_v4(),
            digest: hash(b"transient named-place address card"),
            expires_at_ms,
            audience: None,
        }
    }

    fn request() -> Request {
        Request {
            provider: provider("lookup.example.test"),
            query_digest: hash(TEXT.as_bytes()),
            payload_digest: hash(b"synthetic exact provider payload"),
            privacy: PrivacyClass::Public,
        }
    }

    fn browser(records: &mut BTreeMap<Uuid, Record>) -> BrowserProof {
        let proof = BrowserProof {
            surface_id: Uuid::new_v4(),
            incarnation: Uuid::new_v4(),
            token_hash: hash(b"synthetic browser capability"),
        };
        let (record, _) = transition(
            None,
            records.len(),
            proof.surface_id,
            &Mutation::Approve {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
            },
            100,
        )
        .unwrap();
        let (record, _) = transition(
            Some(&record),
            records.len() + 1,
            proof.surface_id,
            &Mutation::State {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
                sequence: 1,
                visible: true,
            },
            101,
        )
        .unwrap();
        records.insert(proof.surface_id, record);
        proof
    }

    impl Fixture {
        fn new(kind: Kind, privacy: PrivacyClass) -> Self {
            let mut state = RuntimeState::default();
            let mut records = BTreeMap::new();
            let renderer = browser(&mut records).surface_id;
            let epoch = Uuid::new_v4();
            let origin = match kind {
                Kind::Browser => {
                    let proof = browser(&mut records);
                    assert!(matches!(
                        state
                            .apply(
                                PRINCIPAL,
                                &records,
                                RuntimeOperation::OpenBrowser {
                                    connection: proof.clone(),
                                    epoch,
                                },
                                102
                            )
                            .unwrap()
                            .0,
                        RuntimeResult::ConnectionOpened
                    ));
                    Origin::Browser(proof)
                }
                Kind::Native => {
                    let enrollment = Uuid::new_v4();
                    let surface = surface_registry::native_surface_id(PRINCIPAL, enrollment);
                    let (record, _) = transition(
                        None,
                        records.len(),
                        surface,
                        &crate::store::native_test_approval(enrollment, 0),
                        100,
                    )
                    .unwrap();
                    records.insert(surface, record);
                    let (RuntimeResult::NativeChallenge(challenge), _) = state
                        .apply(
                            PRINCIPAL,
                            &records,
                            RuntimeOperation::NativeChallenge {
                                surface_id: surface,
                                enrollment_id: enrollment,
                                audience: "https://lookup.example.test".into(),
                                challenge_id: Uuid::new_v4(),
                                nonce: URL_SAFE_NO_PAD.encode([4u8; 32]),
                            },
                            102,
                        )
                        .unwrap()
                    else {
                        panic!("native challenge")
                    };
                    let token_hash = hash(&[6u8; 32]);
                    let mut open = native_connection::OpenRequest {
                        enrollment_id: enrollment,
                        challenge_id: challenge.challenge_id,
                        epoch,
                        expected_incarnation: challenge.current_incarnation,
                        session_token_hash: token_hash.clone(),
                        signature: String::new(),
                    };
                    let mut scalar = [0u8; 32];
                    scalar[31] = 1;
                    let key = SigningKey::from_bytes(&scalar).unwrap();
                    let signature: Signature =
                        key.sign(&native_connection::signing_message(&challenge, &open).unwrap());
                    open.signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
                    let (
                        RuntimeResult::NativeOpened {
                            connection,
                            duplicate: false,
                        },
                        _,
                    ) = state
                        .apply(
                            PRINCIPAL,
                            &records,
                            RuntimeOperation::OpenNative {
                                surface_id: surface,
                                audience: "https://lookup.example.test".into(),
                                request: open,
                                incarnation: Uuid::new_v4(),
                            },
                            103,
                        )
                        .unwrap()
                    else {
                        panic!("signed native open")
                    };
                    Origin::Native(NativeProof {
                        surface_id: surface,
                        incarnation: connection.incarnation,
                        token_hash,
                    })
                }
                Kind::Pin => {
                    let surface = surface_registry::pin_surface_id(PRINCIPAL, "aabb");
                    let (record, _) = transition(
                        None,
                        records.len(),
                        surface,
                        &Mutation::ApprovePin {
                            device_id: "aabb".into(),
                        },
                        100,
                    )
                    .unwrap();
                    let revision = record.revision;
                    records.insert(surface, record);
                    let proof = PinProof {
                        device: AuthenticatedDeviceIdentity::from_edge("aabb").unwrap(),
                        surface_id: surface,
                        incarnation: Uuid::new_v4(),
                    };
                    assert!(matches!(
                        state
                            .apply(
                                PRINCIPAL,
                                &records,
                                RuntimeOperation::OpenPin {
                                    device: proof.device.clone(),
                                    surface_id: surface,
                                    approval_revision: revision,
                                    epoch,
                                    expected_incarnation: None,
                                    incarnation: proof.incarnation,
                                },
                                102
                            )
                            .unwrap()
                            .0,
                        RuntimeResult::PinOpened {
                            duplicate: false,
                            ..
                        }
                    ));
                    Origin::Pin(proof)
                }
            };
            let stamp = InputStamp {
                epoch,
                sequence: 1,
                instance_id: Uuid::new_v4(),
            };
            let proof = match &origin {
                Origin::Browser(proof) => OriginProof::SequencedRoom {
                    connection: RoomProof::Browser(proof.clone()),
                    stamp: stamp.clone(),
                },
                Origin::Native(proof) => OriginProof::SequencedRoom {
                    connection: RoomProof::Native(proof.clone()),
                    stamp: stamp.clone(),
                },
                Origin::Pin(proof) => OriginProof::SequencedPin {
                    connection: proof.clone(),
                    stamp: stamp.clone(),
                    echo_fingerprint: echo::fingerprint(TEXT),
                },
            };
            let (RuntimeResult::Begun(fence), _) = state
                .apply(
                    PRINCIPAL,
                    &records,
                    RuntimeOperation::Begin {
                        turn_id: stamp.instance_id,
                        worker: Uuid::new_v4(),
                        origin: proof,
                        request_digest: hash(TEXT.as_bytes()),
                        privacy_floor: privacy,
                    },
                    110,
                )
                .unwrap()
            else {
                panic!("current origin turn")
            };
            Self {
                state,
                records,
                origin,
                fence,
                renderer,
            }
        }

        fn apply(
            &mut self,
            operation: RuntimeOperation,
            now: i64,
        ) -> Result<RuntimeResult, RuntimeError> {
            self.state
                .apply(PRINCIPAL, &self.records, operation, now)
                .map(|(result, _)| result)
        }

        fn allow(&mut self) {
            let surface_id = self.fence.origin_surface;
            let binding = ApprovalBinding::for_record(&self.records[&surface_id]);
            assert!(matches!(
                self.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id,
                        approval_revision: binding.approval_revision,
                        approval_incarnation: binding.incarnation,
                        expected_revision: 0,
                        policy: Some(policy()),
                    },
                    111
                )
                .unwrap(),
                RuntimeResult::LookupPolicy {
                    approval: Some(Approval { revision: 1, .. }),
                    ..
                }
            ));
        }

        fn ready(kind: Kind) -> Self {
            let mut fixture = Self::new(kind, PrivacyClass::Public);
            fixture.allow();
            fixture
        }

        fn set_service_policy(
            &mut self,
            service: LookupService,
            expected_revision: u64,
            policy: Option<Policy>,
            now: i64,
        ) -> Result<RuntimeResult, RuntimeError> {
            let surface_id = self.fence.origin_surface;
            let binding = ApprovalBinding::for_record(&self.records[&surface_id]);
            self.apply(
                RuntimeOperation::SetLookupPolicy {
                    service,
                    surface_id,
                    approval_revision: binding.approval_revision,
                    approval_incarnation: binding.incarnation,
                    expected_revision,
                    policy,
                },
                now,
            )
        }

        fn start_service(
            &mut self,
            service: LookupService,
            now: i64,
        ) -> Result<RuntimeResult, RuntimeError> {
            self.apply(
                RuntimeOperation::StartLookup {
                    fence: self.fence.clone(),
                    request: service_request(service),
                    id: Uuid::new_v4(),
                },
                now,
            )
        }

        fn start(&mut self) -> Lookup {
            let RuntimeResult::LookupStarted(lookup) = self
                .apply(
                    RuntimeOperation::StartLookup {
                        fence: self.fence.clone(),
                        request: request(),
                        id: Uuid::new_v4(),
                    },
                    120,
                )
                .unwrap()
            else {
                panic!("one lookup capability")
            };
            lookup
        }

        fn complete(&mut self, lookup: &Lookup, privacy: PrivacyClass, now: i64) -> Receipt {
            let visual = (lookup.request.provider.provider.service() == LookupService::Places)
                .then(|| visual_reference(now + 60_000));
            let RuntimeResult::LookupCompleted(receipt) = self
                .apply(
                    RuntimeOperation::CompleteLookup {
                        visual,
                        fence: self.fence.clone(),
                        lookup: lookup.clone(),
                        evidence_digest: hash(b"actual bounded evidence"),
                        privacy,
                        query_text: None,
                    },
                    now,
                )
                .unwrap()
            else {
                panic!("committed lookup receipt")
            };
            receipt
        }

        fn proposal(&self) -> RuntimeOperation {
            let intent = self
                .state
                .turn
                .as_ref()
                .unwrap()
                .lookup
                .as_ref()
                .and_then(|lookup| lookup.receipt.as_ref())
                .and_then(|receipt| receipt.visual.as_ref())
                .map_or_else(
                    || SemanticIntent::VisualTextCard {
                        text: "A sourced answer".into(),
                    },
                    |content| SemanticIntent::PlaceAddressCard {
                        content: content.clone(),
                    },
                );
            RuntimeOperation::Propose {
                turn_id: self.fence.turn_id,
                generation: self.fence.generation,
                worker: self.fence.worker,
                intent,
                privacy: PrivacyClass::Public,
                hint: None,
            }
        }

        fn acknowledge_visual(&mut self, action: &Action, now: i64) {
            self.apply(
                RuntimeOperation::Claim {
                    action_id: action.id,
                    generation: self.fence.generation,
                    worker: self.fence.worker,
                },
                now,
            )
            .unwrap();
            let record = &self.records[&action.surface_id];
            let connection = BrowserProof {
                surface_id: record.surface_id,
                incarnation: record.incarnation,
                token_hash: record.token_hash.clone(),
            };
            assert!(matches!(
                self.apply(
                    RuntimeOperation::Ack {
                        action_id: action.id,
                        turn_id: self.fence.turn_id,
                        generation: self.fence.generation,
                        connection: RoomProof::Browser(connection),
                        channel: crate::ambiance::Channel::VisualCard,
                        content_digest: action.content_digest.clone(),
                    },
                    now + 1
                )
                .unwrap(),
                RuntimeResult::Acknowledged(_)
            ));
        }

        fn revoke_origin(&mut self, now: i64) {
            let surface = self.fence.origin_surface;
            let record = &self.records[&surface];
            let mutation = match &self.origin {
                Origin::Browser(_) => Mutation::Revoke,
                Origin::Native(_) => Mutation::RevokeNative {
                    expected_revision: record.revision,
                },
                Origin::Pin(_) => Mutation::RevokePin,
            };
            let (revoked, _) =
                transition(Some(record), self.records.len(), surface, &mutation, now).unwrap();
            self.records.insert(surface, revoked);
            self.state.reconcile(&self.records, now);
        }
    }

    #[test]
    fn ambiance_lookup_requires_its_own_origin_policy_and_exact_owner_revisions_for_all_profiles() {
        for kind in KINDS {
            let mut f = Fixture::new(kind, PrivacyClass::Public);
            let origin = f.fence.origin_surface;
            let revision = f.records[&origin].revision;
            assert!(matches!(
                f.apply(
                    RuntimeOperation::LookupPolicy {
                        service: LookupService::Web,
                        surface_id: origin
                    },
                    111
                )
                .unwrap(),
                RuntimeResult::LookupPolicy { approval: None, .. }
            ));
            assert!(matches!(
                f.apply(
                    RuntimeOperation::StartLookup {
                        fence: f.fence.clone(),
                        request: request(),
                        id: Uuid::new_v4()
                    },
                    112
                )
                .unwrap(),
                RuntimeResult::Blocked
            ));
            assert!(matches!(
                f.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id: f.renderer,
                        approval_revision: f.records[&f.renderer].revision,
                        approval_incarnation: ApprovalBinding::for_record(&f.records[&f.renderer])
                            .incarnation,
                        expected_revision: 0,
                        policy: Some(policy()),
                    },
                    113
                )
                .unwrap(),
                RuntimeResult::LookupPolicy {
                    approval: Some(_),
                    ..
                }
            ));
            assert!(matches!(
                f.apply(
                    RuntimeOperation::StartLookup {
                        fence: f.fence.clone(),
                        request: request(),
                        id: Uuid::new_v4()
                    },
                    114
                )
                .unwrap(),
                RuntimeResult::Blocked
            ));
            assert!(matches!(
                f.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id: origin,
                        approval_revision: revision + 1,
                        approval_incarnation: ApprovalBinding::for_record(&f.records[&origin])
                            .incarnation,
                        expected_revision: 0,
                        policy: Some(policy()),
                    },
                    115
                ),
                Err(RuntimeError::Stale)
            ));
            f.allow();
            assert!(matches!(
                f.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id: origin,
                        approval_revision: revision,
                        approval_incarnation: ApprovalBinding::for_record(&f.records[&origin])
                            .incarnation,
                        expected_revision: 0,
                        policy: Some(policy()),
                    },
                    116
                ),
                Err(RuntimeError::Stale)
            ));
            assert_eq!(f.start().policy_revision, 1);
        }
    }

    #[test]
    fn ambiance_lookup_rejects_wrong_providers_and_outgoing_privacy_even_when_the_request_claims_public()
     {
        for kind in KINDS {
            let mut f = Fixture::ready(kind);
            let mut wrong = request();
            wrong.provider = provider("other-lookup.example.test");
            assert!(matches!(
                f.apply(
                    RuntimeOperation::StartLookup {
                        fence: f.fence.clone(),
                        request: wrong,
                        id: Uuid::new_v4()
                    },
                    120
                )
                .unwrap(),
                RuntimeResult::Blocked
            ));
            let mut high = request();
            high.privacy = PrivacyClass::Private;
            assert!(matches!(
                f.apply(
                    RuntimeOperation::StartLookup {
                        fence: f.fence.clone(),
                        request: high,
                        id: Uuid::new_v4()
                    },
                    121
                )
                .unwrap(),
                RuntimeResult::Blocked
            ));
            let mut private = Fixture::new(kind, PrivacyClass::Private);
            private.allow();
            assert!(matches!(
                private
                    .apply(
                        RuntimeOperation::StartLookup {
                            fence: private.fence.clone(),
                            request: request(),
                            id: Uuid::new_v4()
                        },
                        120
                    )
                    .unwrap(),
                RuntimeResult::Blocked
            ));
            let mut public_policy = policy();
            public_policy.maximum_class = PrivacyClass::Public;
            assert!(matches!(
                f.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id: f.fence.origin_surface,
                        approval_revision: f.records[&f.fence.origin_surface].revision,
                        approval_incarnation: ApprovalBinding::for_record(
                            &f.records[&f.fence.origin_surface],
                        )
                        .incarnation,
                        expected_revision: 1,
                        policy: Some(public_policy),
                    },
                    122
                ),
                Err(RuntimeError::InvalidRequest)
            ));
            let mut invalid = policy();
            invalid.maximum_class = PrivacyClass::Private;
            assert!(matches!(
                f.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id: f.fence.origin_surface,
                        approval_revision: f.records[&f.fence.origin_surface].revision,
                        approval_incarnation: ApprovalBinding::for_record(
                            &f.records[&f.fence.origin_surface],
                        )
                        .incarnation,
                        expected_revision: 1,
                        policy: Some(invalid),
                    },
                    122
                ),
                Err(RuntimeError::InvalidRequest)
            ));
            assert!(f.state.turn.as_ref().unwrap().lookup.is_none());
        }
    }

    #[test]
    fn ambiance_lookup_start_is_once_durable_and_blocks_other_work_before_any_receipt() {
        for kind in KINDS {
            let mut f = Fixture::ready(kind);
            let lookup = f.start();
            assert_eq!(lookup.started_at_ms, 120);
            assert_eq!(lookup.request.privacy, PrivacyClass::SharedRoom);
            assert!(lookup.receipt.is_none());
            f.state = serde_json::from_slice(&serde_json::to_vec(&f.state).unwrap()).unwrap();
            assert_eq!(
                f.state.turn.as_ref().unwrap().lookup.as_ref(),
                Some(&lookup)
            );
            for id in [lookup.id, Uuid::new_v4()] {
                assert!(matches!(
                    f.apply(
                        RuntimeOperation::StartLookup {
                            fence: f.fence.clone(),
                            request: request(),
                            id
                        },
                        121
                    ),
                    Err(RuntimeError::Busy)
                ));
            }
            assert!(matches!(
                f.apply(
                    RuntimeOperation::CheckLookup {
                        fence: f.fence.clone(),
                        lookup: lookup.clone()
                    },
                    122
                )
                .unwrap(),
                RuntimeResult::LookupCurrent
            ));
            assert!(f.apply(f.proposal(), 123).is_err());
            assert!(
                f.apply(
                    RuntimeOperation::CheckCognition {
                        fence: f.fence.clone()
                    },
                    124
                )
                .is_err()
            );
            assert!(
                f.apply(
                    RuntimeOperation::AnalysisStart {
                        fence: f.fence.clone(),
                        input_digest: hash(TEXT.as_bytes()),
                        privacy: PrivacyClass::Public
                    },
                    125
                )
                .is_err()
            );
            assert!(f.state.actions.is_empty());
            assert!(f.state.turn.as_ref().unwrap().analysis.is_none());
        }
    }

    #[test]
    fn ambiance_lookup_cannot_start_after_a_larger_analysis_or_an_action_has_started() {
        let mut analysis = Fixture::ready(Kind::Browser);
        assert!(matches!(
            analysis
                .apply(
                    RuntimeOperation::AnalysisStart {
                        fence: analysis.fence.clone(),
                        input_digest: hash(TEXT.as_bytes()),
                        privacy: PrivacyClass::Public
                    },
                    115
                )
                .unwrap(),
            RuntimeResult::AnalysisStarted
        ));
        assert!(matches!(
            analysis.apply(
                RuntimeOperation::StartLookup {
                    fence: analysis.fence.clone(),
                    request: request(),
                    id: Uuid::new_v4()
                },
                120
            ),
            Err(RuntimeError::Busy)
        ));
        let mut action = Fixture::ready(Kind::Browser);
        assert!(matches!(
            action.apply(action.proposal(), 115).unwrap(),
            RuntimeResult::Proposed(_)
        ));
        assert!(matches!(
            action.apply(
                RuntimeOperation::StartLookup {
                    fence: action.fence.clone(),
                    request: request(),
                    id: Uuid::new_v4()
                },
                120
            ),
            Err(RuntimeError::Busy)
        ));
    }

    #[test]
    fn ambiance_lookup_completion_commits_authoritative_time_exact_evidence_and_a_monotone_privacy_join()
     {
        for kind in KINDS {
            let mut f = Fixture::ready(kind);
            let lookup = f.start();
            let receipt = f.complete(&lookup, PrivacyClass::Public, 130);
            assert_eq!(receipt.received_at_ms, 130);
            assert_eq!(receipt.evidence_digest, hash(b"actual bounded evidence"));
            assert_eq!(receipt.privacy, PrivacyClass::SharedRoom);
            assert_eq!(
                f.state.turn.as_ref().unwrap().privacy,
                PrivacyClass::SharedRoom
            );
            assert_eq!(
                f.state
                    .turn
                    .as_ref()
                    .unwrap()
                    .lookup
                    .as_ref()
                    .unwrap()
                    .receipt
                    .as_ref(),
                Some(&receipt)
            );
            assert!(
                f.apply(
                    RuntimeOperation::CompleteLookup {
                        visual: None,
                        fence: f.fence.clone(),
                        lookup: lookup.clone(),
                        evidence_digest: receipt.evidence_digest.clone(),
                        privacy: PrivacyClass::SharedRoom,
                        query_text: None,
                    },
                    131
                )
                .is_err()
            );
            assert!(
                f.apply(
                    RuntimeOperation::CheckLookup {
                        fence: f.fence.clone(),
                        lookup
                    },
                    132
                )
                .is_err()
            );
            assert!(matches!(
                f.apply(f.proposal(), 133).unwrap(),
                RuntimeResult::Proposed(_)
            ));
        }
        let mut f = Fixture::ready(Kind::Browser);
        let lookup = f.start();
        let receipt = f.complete(&lookup, PrivacyClass::Private, 130);
        assert_eq!(receipt.privacy, PrivacyClass::Private);
        assert_eq!(
            f.state.turn.as_ref().unwrap().privacy,
            PrivacyClass::Private
        );
        assert!(matches!(
            f.apply(
                RuntimeOperation::CheckCognition {
                    fence: f.fence.clone()
                },
                131
            ),
            Err(RuntimeError::PolicyBlocked)
        ));
        assert!(matches!(
            f.apply(f.proposal(), 132).unwrap(),
            RuntimeResult::Blocked
        ));
        assert!(f.state.actions.is_empty());
    }

    #[test]
    fn ambiance_lookup_rejects_tampered_capabilities_and_malformed_receipts_without_consuming_the_pending_result()
     {
        let mut f = Fixture::ready(Kind::Browser);
        let lookup = f.start();
        let changes: &[fn(&mut Lookup)] = &[
            |l| l.id = Uuid::new_v4(),
            |l| l.policy_revision += 1,
            |l| l.started_at_ms += 1,
            |l| l.request.provider = provider("different.example.test"),
            |l| l.request.query_digest = hash(b"other query"),
            |l| l.request.payload_digest = hash(b"other actual payload"),
            |l| l.request.privacy = PrivacyClass::Public,
            |l| {
                l.receipt = Some(Receipt {
                    evidence_digest: hash(b"invented receipt"),
                    received_at_ms: 121,
                    privacy: PrivacyClass::SharedRoom,
                    visual: None,
                })
            },
        ];
        for change in changes {
            let mut changed = lookup.clone();
            change(&mut changed);
            assert!(
                f.apply(
                    RuntimeOperation::CheckLookup {
                        fence: f.fence.clone(),
                        lookup: changed.clone()
                    },
                    125
                )
                .is_err()
            );
            assert!(
                f.apply(
                    RuntimeOperation::CompleteLookup {
                        visual: None,
                        fence: f.fence.clone(),
                        lookup: changed,
                        evidence_digest: hash(b"evidence"),
                        privacy: PrivacyClass::SharedRoom,
                        query_text: None,
                    },
                    126
                )
                .is_err()
            );
            assert_eq!(
                f.state.turn.as_ref().unwrap().lookup.as_ref(),
                Some(&lookup)
            );
        }
        assert!(matches!(
            f.apply(
                RuntimeOperation::CompleteLookup {
                    visual: None,
                    fence: f.fence.clone(),
                    lookup: lookup.clone(),
                    evidence_digest: "not-a-digest".into(),
                    privacy: PrivacyClass::SharedRoom,
                    query_text: None,
                },
                127
            ),
            Err(RuntimeError::InvalidRequest)
        ));
        f.complete(&lookup, PrivacyClass::SharedRoom, 128);
    }

    #[test]
    fn ambiance_lookup_rejects_invalid_request_proofs_before_reserving_the_turn() {
        let mut f = Fixture::ready(Kind::Browser);
        let changes: &[fn(&mut Request)] = &[
            |r| r.query_digest = "a".repeat(63),
            |r| r.payload_digest = "A".repeat(64),
            |r| r.provider.configuration_digest = hash(b"wrong provider profile"),
        ];
        for change in changes {
            let mut bad = request();
            change(&mut bad);
            assert!(matches!(
                f.apply(
                    RuntimeOperation::StartLookup {
                        fence: f.fence.clone(),
                        request: bad,
                        id: Uuid::new_v4()
                    },
                    120
                ),
                Err(RuntimeError::InvalidRequest)
            ));
            assert!(f.state.turn.as_ref().unwrap().lookup.is_none());
        }
        assert!(matches!(
            f.apply(
                RuntimeOperation::StartLookup {
                    fence: f.fence.clone(),
                    request: request(),
                    id: Uuid::nil()
                },
                120
            ),
            Err(RuntimeError::InvalidRequest)
        ));
        f.start();
    }

    #[test]
    fn ambiance_lookup_stale_fences_and_expired_pending_work_never_accept_a_late_result() {
        for kind in KINDS {
            let mut f = Fixture::ready(kind);
            let lookup = f.start();
            let changes: &[fn(&mut TurnFence)] = &[
                |f| f.worker = Uuid::new_v4(),
                |f| f.generation += 1,
                |f| f.turn_id = Uuid::new_v4(),
                |f| f.origin_surface = Uuid::new_v4(),
            ];
            for change in changes {
                let mut stale = f.fence.clone();
                change(&mut stale);
                assert!(
                    f.apply(
                        RuntimeOperation::CompleteLookup {
                            visual: None,
                            fence: stale,
                            lookup: lookup.clone(),
                            evidence_digest: hash(b"evidence"),
                            privacy: PrivacyClass::SharedRoom,
                            query_text: None,
                        },
                        125
                    )
                    .is_err()
                );
            }
            assert!(matches!(
                f.apply(
                    RuntimeOperation::CheckLookup {
                        fence: f.fence.clone(),
                        lookup: lookup.clone()
                    },
                    120 + LOOKUP_MS - 1
                )
                .unwrap(),
                RuntimeResult::LookupCurrent
            ));
            f.state.reconcile(&f.records, 120 + LOOKUP_MS);
            assert!(f.state.turn.as_ref().unwrap().cancelled);
            assert!(
                f.apply(
                    RuntimeOperation::CompleteLookup {
                        visual: None,
                        fence: f.fence.clone(),
                        lookup,
                        evidence_digest: hash(b"late evidence"),
                        privacy: PrivacyClass::SharedRoom,
                        query_text: None,
                    },
                    120 + LOOKUP_MS
                )
                .is_err()
            );
            assert!(
                f.state
                    .turn
                    .as_ref()
                    .unwrap()
                    .lookup
                    .as_ref()
                    .unwrap()
                    .receipt
                    .is_none()
            );
        }
    }

    #[test]
    fn ambiance_lookup_policy_changes_retire_pending_and_completed_output_for_every_origin_profile()
    {
        for kind in KINDS {
            for completed in [false, true] {
                let mut f = Fixture::ready(kind);
                let lookup = f.start();
                let action = if completed {
                    f.complete(&lookup, PrivacyClass::SharedRoom, 125);
                    let RuntimeResult::Proposed(action) = f.apply(f.proposal(), 126).unwrap()
                    else {
                        panic!("visual action")
                    };
                    Some(action)
                } else {
                    None
                };
                assert!(matches!(
                    f.apply(
                        RuntimeOperation::SetLookupPolicy {
                            service: LookupService::Web,
                            surface_id: f.fence.origin_surface,
                            approval_revision: f.records[&f.fence.origin_surface].revision,
                            approval_incarnation: ApprovalBinding::for_record(
                                &f.records[&f.fence.origin_surface],
                            )
                            .incarnation,
                            expected_revision: 1,
                            policy: None,
                        },
                        130
                    )
                    .unwrap(),
                    RuntimeResult::LookupPolicy {
                        approval: Some(Approval {
                            revision: 2,
                            policy: None,
                            ..
                        }),
                        ..
                    }
                ));
                assert!(f.state.turn.as_ref().unwrap().cancelled);
                if let Some(action) = action {
                    assert_eq!(f.state.actions[&action.id].status, ActionStatus::Cancelled);
                    assert!(f.state.actions[&action.id].intent.text().is_empty());
                }
                assert!(
                    f.apply(
                        RuntimeOperation::CheckLookup {
                            fence: f.fence.clone(),
                            lookup
                        },
                        131
                    )
                    .is_err()
                );
            }
        }
    }

    #[test]
    fn ambiance_lookup_origin_revocation_cancels_completed_actions_and_does_not_transfer_policy() {
        for kind in KINDS {
            let mut f = Fixture::ready(kind);
            let lookup = f.start();
            f.complete(&lookup, PrivacyClass::SharedRoom, 125);
            let RuntimeResult::Proposed(action) = f.apply(f.proposal(), 126).unwrap() else {
                panic!("visual action")
            };
            f.revoke_origin(130);
            assert!(f.state.turn.as_ref().unwrap().cancelled);
            assert_eq!(f.state.actions[&action.id].status, ActionStatus::Cancelled);
            assert!(
                !f.state
                    .lookup_policies
                    .contains_key(&f.fence.origin_surface)
            );
            assert!(
                f.apply(
                    RuntimeOperation::Claim {
                        action_id: action.id,
                        generation: f.fence.generation,
                        worker: f.fence.worker
                    },
                    131
                )
                .is_err()
            );
            assert!(
                f.apply(
                    RuntimeOperation::CompleteLookup {
                        visual: None,
                        fence: f.fence.clone(),
                        lookup,
                        evidence_digest: hash(b"revoked late evidence"),
                        privacy: PrivacyClass::SharedRoom,
                        query_text: None,
                    },
                    132
                )
                .is_err()
            );
        }
    }

    #[test]
    fn ambiance_lookup_browser_heartbeats_preserve_authority_but_reapproval_retires_the_incarnation()
     {
        let mut f = Fixture::ready(Kind::Browser);
        let lookup = f.start();
        let Origin::Browser(proof) = f.origin.clone() else {
            unreachable!()
        };
        let approved_revision = f.records[&proof.surface_id].revision;
        let (record, _) = transition(
            Some(&f.records[&proof.surface_id]),
            f.records.len(),
            proof.surface_id,
            &Mutation::State {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
                sequence: 2,
                visible: true,
            },
            125,
        )
        .unwrap();
        assert!(record.revision > approved_revision);
        f.records.insert(proof.surface_id, record);
        f.state.reconcile(&f.records, 125);
        assert!(!f.state.turn.as_ref().unwrap().cancelled);
        let RuntimeResult::LookupPolicy {
            approval: Some(approval),
            binding,
        } = f
            .apply(
                RuntimeOperation::LookupPolicy {
                    service: LookupService::Web,
                    surface_id: proof.surface_id,
                },
                126,
            )
            .unwrap()
        else {
            panic!("same-incarnation approval")
        };
        assert_eq!(approval.approval_revision, approved_revision);
        assert_eq!(
            binding.approval_revision,
            f.records[&proof.surface_id].revision
        );
        assert_eq!(binding.incarnation, Some(proof.incarnation));
        assert!(matches!(
            f.apply(
                RuntimeOperation::CheckLookup {
                    fence: f.fence.clone(),
                    lookup: lookup.clone()
                },
                127
            )
            .unwrap(),
            RuntimeResult::LookupCurrent
        ));
        let (replacement, _) = transition(
            Some(&f.records[&proof.surface_id]),
            f.records.len(),
            proof.surface_id,
            &Mutation::Approve {
                token_hash: hash(b"replacement browser capability"),
                incarnation: Uuid::new_v4(),
            },
            128,
        )
        .unwrap();
        f.records.insert(proof.surface_id, replacement);
        f.state.reconcile(&f.records, 128);
        assert!(f.state.turn.as_ref().unwrap().cancelled);
        assert!(matches!(
            f.apply(
                RuntimeOperation::LookupPolicy {
                    service: LookupService::Web,
                    surface_id: proof.surface_id
                },
                129
            )
            .unwrap(),
            RuntimeResult::LookupPolicy { approval: None, .. }
        ));
        assert!(
            f.apply(
                RuntimeOperation::CompleteLookup {
                    visual: None,
                    fence: f.fence.clone(),
                    lookup,
                    evidence_digest: hash(b"replacement late evidence"),
                    privacy: PrivacyClass::SharedRoom,
                    query_text: None,
                },
                130
            )
            .is_err()
        );
    }

    fn reviewed_lookup_policy(f: &mut Fixture, now: i64) -> (Option<Approval>, ApprovalBinding) {
        let RuntimeResult::LookupPolicy { approval, binding } = f
            .apply(
                RuntimeOperation::LookupPolicy {
                    service: LookupService::Web,
                    surface_id: f.fence.origin_surface,
                },
                now,
            )
            .unwrap()
        else {
            panic!("atomic current lookup policy binding")
        };
        (approval, binding)
    }

    fn heartbeat_lookup_browser(f: &mut Fixture, now: i64) {
        let Origin::Browser(proof) = f.origin.clone() else {
            panic!("browser fixture")
        };
        let current = &f.records[&proof.surface_id];
        let (updated, _) = transition(
            Some(current),
            f.records.len(),
            proof.surface_id,
            &Mutation::State {
                token_hash: proof.token_hash,
                incarnation: proof.incarnation,
                sequence: current.sequence + 1,
                visible: true,
            },
            now,
        )
        .unwrap();
        f.records.insert(proof.surface_id, updated);
        f.state.reconcile(&f.records, now);
    }

    #[test]
    fn ambiance_lookup_browser_review_survives_heartbeat_and_returns_atomic_current_binding() {
        let mut f = Fixture::new(Kind::Browser, PrivacyClass::Public);
        let surface_id = f.fence.origin_surface;
        let (approval, reviewed) = reviewed_lookup_policy(&mut f, 111);
        assert!(approval.is_none());
        assert!(reviewed.incarnation.is_some_and(|id| !id.is_nil()));
        heartbeat_lookup_browser(&mut f, 112);
        let current_revision = f.records[&surface_id].revision;
        assert!(current_revision > reviewed.approval_revision);

        let RuntimeResult::LookupPolicy { approval, binding } = f
            .apply(
                RuntimeOperation::SetLookupPolicy {
                    service: LookupService::Web,
                    surface_id,
                    approval_revision: reviewed.approval_revision,
                    approval_incarnation: reviewed.incarnation,
                    expected_revision: 0,
                    policy: Some(policy()),
                },
                113,
            )
            .unwrap()
        else {
            panic!("grant after an ordinary browser heartbeat")
        };
        let approval = approval.expect("granted policy");
        assert_eq!(approval.revision, 1);
        assert_eq!(approval.approval_revision, reviewed.approval_revision);
        assert_eq!(approval.policy, Some(policy()));
        assert_eq!(binding.approval_revision, current_revision);
        assert_eq!(binding.incarnation, reviewed.incarnation);

        let (stored, current) = reviewed_lookup_policy(&mut f, 114);
        assert_eq!(stored, Some(approval));
        assert_eq!(current.approval_revision, current_revision);
        assert_eq!(current.incarnation, reviewed.incarnation);
        // Exercise actual lookup authority, not only the owner policy response.
        assert!(f.start().receipt.is_none());
    }

    #[test]
    fn ambiance_lookup_browser_revoke_review_survives_heartbeat_without_rewriting_review_revision()
    {
        let mut f = Fixture::ready(Kind::Browser);
        let surface_id = f.fence.origin_surface;
        let (existing, reviewed) = reviewed_lookup_policy(&mut f, 112);
        let existing = existing.expect("existing owner grant");
        heartbeat_lookup_browser(&mut f, 113);
        let current_revision = f.records[&surface_id].revision;
        assert!(current_revision > reviewed.approval_revision);

        let RuntimeResult::LookupPolicy { approval, binding } = f
            .apply(
                RuntimeOperation::SetLookupPolicy {
                    service: LookupService::Web,
                    surface_id,
                    approval_revision: reviewed.approval_revision,
                    approval_incarnation: reviewed.incarnation,
                    expected_revision: existing.revision,
                    policy: None,
                },
                114,
            )
            .unwrap()
        else {
            panic!("revoke after an ordinary browser heartbeat")
        };
        let approval = approval.expect("revoked policy retains its CAS revision");
        assert_eq!(approval.revision, existing.revision + 1);
        assert_eq!(approval.approval_revision, reviewed.approval_revision);
        assert!(approval.policy.is_none());
        assert_eq!(binding.approval_revision, current_revision);
        assert_eq!(binding.incarnation, reviewed.incarnation);
        let (stored, current) = reviewed_lookup_policy(&mut f, 115);
        assert_eq!(stored, Some(approval));
        assert_eq!(current.approval_revision, current_revision);
        assert_eq!(current.incarnation, reviewed.incarnation);
        assert!(matches!(
            f.apply(
                RuntimeOperation::StartLookup {
                    fence: f.fence.clone(),
                    request: request(),
                    id: Uuid::new_v4(),
                },
                120,
            )
            .unwrap(),
            RuntimeResult::Blocked
        ));
    }

    #[test]
    fn ambiance_lookup_browser_reapproval_rejects_old_incarnation_grant_and_revoke() {
        let mut f = Fixture::ready(Kind::Browser);
        let surface_id = f.fence.origin_surface;
        let (_, reviewed) = reviewed_lookup_policy(&mut f, 112);
        let replacement_incarnation = Uuid::new_v4();
        let (replacement, _) = transition(
            Some(&f.records[&surface_id]),
            f.records.len(),
            surface_id,
            &Mutation::Approve {
                token_hash: hash(b"replacement browser capability"),
                incarnation: replacement_incarnation,
            },
            113,
        )
        .unwrap();
        f.records.insert(surface_id, replacement);
        f.state.reconcile(&f.records, 113);
        let (approval, current) = reviewed_lookup_policy(&mut f, 114);
        assert!(approval.is_none());
        assert_eq!(current.incarnation, Some(replacement_incarnation));
        assert!(reviewed.approval_revision > 0);
        assert!(reviewed.approval_revision <= current.approval_revision);

        for requested_policy in [Some(policy()), None] {
            assert!(matches!(
                f.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id,
                        approval_revision: reviewed.approval_revision,
                        approval_incarnation: reviewed.incarnation,
                        expected_revision: 0,
                        policy: requested_policy,
                    },
                    115,
                ),
                Err(RuntimeError::Stale)
            ));
        }
        assert!(reviewed_lookup_policy(&mut f, 116).0.is_none());
        // The same otherwise allowable reviewed revision succeeds for this incarnation.
        assert!(matches!(
            f.apply(
                RuntimeOperation::SetLookupPolicy {
                    service: LookupService::Web,
                    surface_id,
                    approval_revision: reviewed.approval_revision,
                    approval_incarnation: current.incarnation,
                    expected_revision: 0,
                    policy: Some(policy()),
                },
                117,
            )
            .unwrap(),
            RuntimeResult::LookupPolicy {
                approval: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn ambiance_lookup_browser_requires_positive_safe_review_and_current_nonnil_incarnation() {
        let mut f = Fixture::new(Kind::Browser, PrivacyClass::Public);
        let surface_id = f.fence.origin_surface;
        let (_, reviewed) = reviewed_lookup_policy(&mut f, 111);
        for incarnation in [None, Some(Uuid::nil()), Some(Uuid::new_v4())] {
            assert!(
                f.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id,
                        approval_revision: reviewed.approval_revision,
                        approval_incarnation: incarnation,
                        expected_revision: 0,
                        policy: Some(policy()),
                    },
                    112,
                )
                .is_err()
            );
        }
        for approval_revision in [0, reviewed.approval_revision + 1, MAX_REVISION + 1] {
            assert!(
                f.apply(
                    RuntimeOperation::SetLookupPolicy {
                        service: LookupService::Web,
                        surface_id,
                        approval_revision,
                        approval_incarnation: reviewed.incarnation,
                        expected_revision: 0,
                        policy: Some(policy()),
                    },
                    113,
                )
                .is_err()
            );
        }
        assert!(reviewed_lookup_policy(&mut f, 114).0.is_none());
    }

    #[test]
    fn ambiance_lookup_native_and_pin_require_exact_review_revision_and_null_incarnation() {
        for kind in [Kind::Native, Kind::Pin] {
            let mut f = Fixture::ready(kind);
            let surface_id = f.fence.origin_surface;
            let (_, old_review) = reviewed_lookup_policy(&mut f, 112);
            assert!(old_review.incarnation.is_none());
            assert!(old_review.approval_revision > 0);
            f.revoke_origin(113);
            let record = &f.records[&surface_id];
            let mutation = match &record.binding {
                surface_registry::Binding::Native { enrollment_id, .. } => {
                    crate::store::native_test_approval(*enrollment_id, record.revision)
                }
                surface_registry::Binding::Pin { .. } => Mutation::ApprovePin {
                    device_id: "aabb".into(),
                },
                surface_registry::Binding::Browser => unreachable!(),
            };
            let (replacement, _) =
                transition(Some(record), f.records.len(), surface_id, &mutation, 114).unwrap();
            f.records.insert(surface_id, replacement);
            f.state.reconcile(&f.records, 114);
            let (approval, current) = reviewed_lookup_policy(&mut f, 115);
            assert!(approval.is_none());
            assert!(current.incarnation.is_none());
            assert!(current.approval_revision > old_review.approval_revision);

            // Check both directions with the correct policy CAS revision each time.
            for (expected_revision, requested_policy, now) in
                [(0, Some(policy()), 116), (1, None, 120)]
            {
                assert!(matches!(
                    f.apply(
                        RuntimeOperation::SetLookupPolicy {
                            service: LookupService::Web,
                            surface_id,
                            approval_revision: old_review.approval_revision,
                            approval_incarnation: None,
                            expected_revision,
                            policy: requested_policy.clone(),
                        },
                        now,
                    ),
                    Err(RuntimeError::Stale)
                ));
                for incarnation in [Some(Uuid::new_v4()), Some(Uuid::nil())] {
                    assert!(
                        f.apply(
                            RuntimeOperation::SetLookupPolicy {
                                service: LookupService::Web,
                                surface_id,
                                approval_revision: current.approval_revision,
                                approval_incarnation: incarnation,
                                expected_revision,
                                policy: requested_policy.clone(),
                            },
                            now + 1,
                        )
                        .is_err()
                    );
                }
                let RuntimeResult::LookupPolicy { approval, binding } = f
                    .apply(
                        RuntimeOperation::SetLookupPolicy {
                            service: LookupService::Web,
                            surface_id,
                            approval_revision: current.approval_revision,
                            approval_incarnation: None,
                            expected_revision,
                            policy: requested_policy.clone(),
                        },
                        now + 2,
                    )
                    .unwrap()
                else {
                    panic!("exact native/Pin review binding")
                };
                let approval = approval.expect("new policy revision");
                assert_eq!(approval.revision, expected_revision + 1);
                assert_eq!(approval.approval_revision, current.approval_revision);
                assert_eq!(approval.policy, requested_policy);
                assert_eq!(binding.approval_revision, current.approval_revision);
                assert!(binding.incarnation.is_none());
            }
        }
    }

    #[test]
    fn ambiance_lookup_approval_binding_has_strict_required_nullable_camel_case_fields() {
        let native = serde_json::json!({ "approvalRevision": 3, "incarnation": null });
        let decoded: ApprovalBinding = serde_json::from_value(native.clone()).unwrap();
        assert_eq!(decoded.approval_revision, 3);
        assert!(decoded.incarnation.is_none());
        assert_eq!(serde_json::to_value(decoded).unwrap(), native);
        let incarnation = Uuid::new_v4();
        let browser = serde_json::json!({ "approvalRevision": 4, "incarnation": incarnation });
        let decoded: ApprovalBinding = serde_json::from_value(browser.clone()).unwrap();
        assert_eq!(decoded.incarnation, Some(incarnation));
        assert_eq!(serde_json::to_value(decoded).unwrap(), browser);
        for invalid in [
            serde_json::json!({ "approvalRevision": 3 }),
            serde_json::json!({ "incarnation": null }),
            serde_json::json!({ "approval_revision": 3, "incarnation": null }),
            serde_json::json!({ "approvalRevision": 3, "incarnation": null, "extra": true }),
            serde_json::json!({ "approvalRevision": 3, "incarnation": "invalid UUID" }),
        ] {
            assert!(serde_json::from_value::<ApprovalBinding>(invalid).is_err());
        }
    }

    #[test]
    fn ambiance_lookup_web_and_places_grants_are_independent_and_reject_cross_scope_providers() {
        assert_eq!(
            owner_approval(LookupService::Web),
            "approve-web-lookup-disclosure-v1"
        );
        assert_eq!(
            owner_approval(LookupService::Places),
            "approve-places-lookup-disclosure-v1"
        );
        for kind in KINDS {
            for (first, other) in [
                (LookupService::Web, LookupService::Places),
                (LookupService::Places, LookupService::Web),
            ] {
                let mut f = Fixture::new(kind, PrivacyClass::Public);
                assert!(matches!(
                    f.set_service_policy(first, 0, Some(service_policy(first)), 111)
                        .unwrap(),
                    RuntimeResult::LookupPolicy {
                        approval: Some(Approval { revision: 1, .. }),
                        ..
                    }
                ));
                assert!(matches!(
                    f.start_service(other, 112).unwrap(),
                    RuntimeResult::Blocked
                ));
                assert!(matches!(
                    f.set_service_policy(other, 0, Some(service_policy(first)), 113),
                    Err(RuntimeError::InvalidRequest)
                ));
                assert!(matches!(
                    f.apply(
                        RuntimeOperation::LookupPolicy {
                            service: other,
                            surface_id: f.fence.origin_surface,
                        },
                        114
                    )
                    .unwrap(),
                    RuntimeResult::LookupPolicy { approval: None, .. }
                ));
                assert!(matches!(
                    f.set_service_policy(other, 0, Some(service_policy(other)), 115)
                        .unwrap(),
                    RuntimeResult::LookupPolicy {
                        approval: Some(Approval { revision: 1, .. }),
                        ..
                    }
                ));
                for service in [first, other] {
                    let RuntimeResult::LookupPolicy {
                        approval: Some(approval),
                        ..
                    } = f
                        .apply(
                            RuntimeOperation::LookupPolicy {
                                service,
                                surface_id: f.fence.origin_surface,
                            },
                            116,
                        )
                        .unwrap()
                    else {
                        panic!("independent service grant")
                    };
                    assert_eq!(approval.revision, 1);
                    assert_eq!(approval.policy, Some(service_policy(service)));
                }
                assert_eq!(f.state.lookup_policies.len(), 1);
                assert_eq!(f.state.place_lookup_policies.len(), 1);
            }
        }
    }

    #[test]
    fn ambiance_lookup_service_revocation_only_retires_its_own_pending_or_completed_output() {
        for kind in KINDS {
            for (active, other) in [
                (LookupService::Web, LookupService::Places),
                (LookupService::Places, LookupService::Web),
            ] {
                for completed in [false, true] {
                    let mut f = Fixture::new(kind, PrivacyClass::Public);
                    for service in [active, other] {
                        f.set_service_policy(service, 0, Some(service_policy(service)), 111)
                            .unwrap();
                    }
                    let RuntimeResult::LookupStarted(lookup) =
                        f.start_service(active, 120).unwrap()
                    else {
                        panic!("admitted service lookup")
                    };
                    let action = if completed {
                        f.complete(&lookup, PrivacyClass::SharedRoom, 121);
                        let RuntimeResult::Proposed(action) = f.apply(f.proposal(), 122).unwrap()
                        else {
                            panic!("sourced output")
                        };
                        Some(action)
                    } else {
                        None
                    };
                    f.set_service_policy(other, 1, None, 123).unwrap();
                    assert!(!f.state.turn.as_ref().unwrap().cancelled);
                    assert!(f.state.lookup_authority_valid(
                        f.state.turn.as_ref().unwrap(),
                        &f.records,
                        124,
                    ));
                    if let Some(action) = &action {
                        assert_ne!(f.state.actions[&action.id].status, ActionStatus::Cancelled);
                        assert_eq!(f.state.actions[&action.id].intent, action.intent);
                    } else {
                        assert!(matches!(
                            f.apply(
                                RuntimeOperation::CheckLookup {
                                    fence: f.fence.clone(),
                                    lookup: lookup.clone(),
                                },
                                124
                            )
                            .unwrap(),
                            RuntimeResult::LookupCurrent
                        ));
                    }
                    f.set_service_policy(active, 1, None, 125).unwrap();
                    assert!(f.state.turn.as_ref().unwrap().cancelled);
                    if let Some(action) = action {
                        assert_eq!(f.state.actions[&action.id].status, ActionStatus::Cancelled);
                        assert!(f.state.actions[&action.id].intent.text().is_empty());
                    }
                    assert!(
                        f.apply(
                            RuntimeOperation::CompleteLookup {
                                visual: None,
                                fence: f.fence.clone(),
                                lookup,
                                evidence_digest: hash(b"revoked service evidence"),
                                privacy: PrivacyClass::SharedRoom,
                                query_text: None,
                            },
                            126
                        )
                        .is_err()
                    );
                }
            }
        }
    }

    #[test]
    fn ambiance_lookup_web_and_places_share_one_durable_call_budget_per_turn() {
        for kind in KINDS {
            for (first, next) in [
                (LookupService::Web, LookupService::Places),
                (LookupService::Places, LookupService::Web),
            ] {
                for completed in [false, true] {
                    let mut f = Fixture::new(kind, PrivacyClass::Public);
                    for service in [first, next] {
                        f.set_service_policy(service, 0, Some(service_policy(service)), 111)
                            .unwrap();
                    }
                    let RuntimeResult::LookupStarted(lookup) = f.start_service(first, 120).unwrap()
                    else {
                        panic!("one lookup reservation")
                    };
                    if completed {
                        f.complete(&lookup, PrivacyClass::SharedRoom, 121);
                    }
                    f.state =
                        serde_json::from_slice(&serde_json::to_vec(&f.state).unwrap()).unwrap();
                    assert!(matches!(
                        f.start_service(next, 122),
                        Err(RuntimeError::Busy)
                    ));
                    assert_eq!(
                        f.state.turn.as_ref().unwrap().lookup.as_ref().unwrap().id,
                        lookup.id
                    );
                    assert_eq!(
                        f.state
                            .turn
                            .as_ref()
                            .unwrap()
                            .lookup
                            .as_ref()
                            .unwrap()
                            .request
                            .provider
                            .provider
                            .service(),
                        first
                    );
                }
            }
        }
    }

    #[test]
    fn ambiance_lookup_places_uses_the_same_review_binding_and_privacy_checks() {
        let mut f = Fixture::new(Kind::Browser, PrivacyClass::Public);
        let surface_id = f.fence.origin_surface;
        let reviewed = ApprovalBinding::for_record(&f.records[&surface_id]);
        heartbeat_lookup_browser(&mut f, 111);
        let RuntimeResult::LookupPolicy {
            approval: Some(approval),
            binding,
        } = f
            .apply(
                RuntimeOperation::SetLookupPolicy {
                    service: LookupService::Places,
                    surface_id,
                    approval_revision: reviewed.approval_revision,
                    approval_incarnation: reviewed.incarnation,
                    expected_revision: 0,
                    policy: Some(service_policy(LookupService::Places)),
                },
                112,
            )
            .unwrap()
        else {
            panic!("places grant survives same-incarnation heartbeat")
        };
        assert_eq!(approval.approval_revision, reviewed.approval_revision);
        assert!(binding.approval_revision > reviewed.approval_revision);
        assert_eq!(binding.incarnation, reviewed.incarnation);
        let mut private = service_request(LookupService::Places);
        private.privacy = PrivacyClass::Private;
        assert!(matches!(
            f.apply(
                RuntimeOperation::StartLookup {
                    fence: f.fence.clone(),
                    request: private,
                    id: Uuid::new_v4(),
                },
                113
            )
            .unwrap(),
            RuntimeResult::Blocked
        ));
        assert!(f.state.turn.as_ref().unwrap().lookup.is_none());
        let RuntimeResult::LookupStarted(lookup) =
            f.start_service(LookupService::Places, 120).unwrap()
        else {
            panic!("public places request")
        };
        f.complete(&lookup, PrivacyClass::Private, 121);
        assert_eq!(
            f.state.turn.as_ref().unwrap().privacy,
            PrivacyClass::Private
        );
        assert!(matches!(
            f.apply(f.proposal(), 122).unwrap(),
            RuntimeResult::Blocked
        ));
    }

    #[test]
    fn ambiance_lookup_places_completion_requires_a_valid_current_bounded_visual_reference() {
        for kind in KINDS {
            let mut f = Fixture::new(kind, PrivacyClass::Public);
            f.set_service_policy(
                LookupService::Places,
                0,
                Some(service_policy(LookupService::Places)),
                111,
            )
            .unwrap();
            let RuntimeResult::LookupStarted(lookup) =
                f.start_service(LookupService::Places, 120).unwrap()
            else {
                panic!("places reservation")
            };
            let mut nil = visual_reference(135);
            nil.id = Uuid::nil();
            let mut bad_digest = visual_reference(135);
            bad_digest.digest = "not-a-digest".into();
            for visual in [
                None,
                Some(nil),
                Some(bad_digest),
                Some(visual_reference(125)),
                Some(visual_reference(124)),
                Some(visual_reference(60_126)),
                Some(visual_reference(-1)),
            ] {
                assert!(matches!(
                    f.apply(
                        RuntimeOperation::CompleteLookup {
                            fence: f.fence.clone(),
                            lookup: lookup.clone(),
                            evidence_digest: hash(b"bounded place evidence"),
                            privacy: PrivacyClass::Private,
                            visual,
                            query_text: None,
                        },
                        125
                    ),
                    Err(RuntimeError::InvalidRequest)
                ));
                assert!(
                    f.state
                        .turn
                        .as_ref()
                        .unwrap()
                        .lookup
                        .as_ref()
                        .unwrap()
                        .receipt
                        .is_none()
                );
                assert_eq!(
                    f.state.turn.as_ref().unwrap().privacy,
                    PrivacyClass::SharedRoom
                );
            }
            let visual = visual_reference(60_125);
            let RuntimeResult::LookupCompleted(receipt) = f
                .apply(
                    RuntimeOperation::CompleteLookup {
                        fence: f.fence.clone(),
                        lookup,
                        evidence_digest: hash(b"bounded place evidence"),
                        privacy: PrivacyClass::SharedRoom,
                        visual: Some(visual.clone()),
                        query_text: None,
                    },
                    125,
                )
                .unwrap()
            else {
                panic!("bounded place completion")
            };
            assert_eq!(receipt.visual, Some(visual));
            assert_eq!(receipt.received_at_ms, 125);
        }
    }

    #[test]
    fn ambiance_lookup_places_output_requires_the_exact_completed_reference_and_blocks_raw_reuse() {
        const RAW_PROVIDER_TEXT: &str = "Transient Museum, One Example Street";
        for kind in KINDS {
            let mut f = Fixture::new(kind, PrivacyClass::Public);
            f.set_service_policy(
                LookupService::Places,
                0,
                Some(service_policy(LookupService::Places)),
                111,
            )
            .unwrap();
            let RuntimeResult::LookupStarted(lookup) =
                f.start_service(LookupService::Places, 120).unwrap()
            else {
                panic!("places reservation")
            };
            let receipt = f.complete(&lookup, PrivacyClass::SharedRoom, 121);
            let visual = receipt.visual.unwrap();
            let mut wrong_id = visual.clone();
            wrong_id.id = Uuid::new_v4();
            let mut wrong_digest = visual.clone();
            wrong_digest.digest = hash(b"another transient payload");
            let mut wrong_expiry = visual.clone();
            wrong_expiry.expires_at_ms -= 1;
            for intent in [
                SemanticIntent::PlaceAddressCard { content: wrong_id },
                SemanticIntent::PlaceAddressCard {
                    content: wrong_digest,
                },
                SemanticIntent::PlaceAddressCard {
                    content: wrong_expiry,
                },
                SemanticIntent::VisualTextCard {
                    text: RAW_PROVIDER_TEXT.into(),
                },
                SemanticIntent::InformationalSpeech {
                    text: RAW_PROVIDER_TEXT.into(),
                },
            ] {
                assert!(matches!(
                    f.apply(
                        RuntimeOperation::Propose {
                            turn_id: f.fence.turn_id,
                            generation: f.fence.generation,
                            worker: f.fence.worker,
                            intent,
                            privacy: PrivacyClass::SharedRoom,
                            hint: None,
                        },
                        122
                    ),
                    Err(RuntimeError::PolicyBlocked)
                ));
            }
            assert!(matches!(
                f.apply(
                    RuntimeOperation::CheckCognition {
                        fence: f.fence.clone()
                    },
                    122
                ),
                Err(RuntimeError::PolicyBlocked)
            ));
            assert!(matches!(
                f.apply(
                    RuntimeOperation::AnalysisStart {
                        fence: f.fence.clone(),
                        input_digest: hash(RAW_PROVIDER_TEXT.as_bytes()),
                        privacy: PrivacyClass::SharedRoom,
                    },
                    122
                ),
                Err(RuntimeError::PolicyBlocked)
            ));
            assert!(f.state.actions.is_empty());
            assert!(f.state.turn.as_ref().unwrap().analysis.is_none());
            let proposal = f.proposal();
            let (RuntimeResult::Proposed(action), events) =
                f.state.apply(PRINCIPAL, &f.records, proposal, 123).unwrap()
            else {
                panic!("reference-only place card")
            };
            // The proposal binds the same content to the surface the
            // decision named; the reference is authority for that surface.
            assert_eq!(
                action.intent,
                SemanticIntent::PlaceAddressCard {
                    content: visual.for_audience(action.surface_id)
                }
            );
            assert!(action.intent.text().is_empty());
            assert_eq!(action.channel, crate::ambiance::Channel::VisualCard);
            assert_eq!(action.content_digest, visual.digest);
            assert_eq!(action.display_expires_at_ms, visual.expires_at_ms);
            assert!(action.deadline_ms <= visual.expires_at_ms);
            let durable = serde_json::to_string(&f.state).unwrap();
            assert!(!durable.contains(RAW_PROVIDER_TEXT));
            assert!(
                !serde_json::to_string(&events)
                    .unwrap()
                    .contains(RAW_PROVIDER_TEXT)
            );
            f.state = serde_json::from_str(&durable).unwrap();
            assert_eq!(f.state.actions[&action.id].intent, action.intent);
            assert_eq!(f.state.actions[&action.id].content_digest, visual.digest);
        }
    }

    #[test]
    fn ambiance_lookup_place_references_cannot_render_without_a_completed_places_receipt() {
        for kind in KINDS {
            for with_web_lookup in [false, true] {
                let mut f = Fixture::ready(kind);
                if with_web_lookup {
                    let lookup = f.start();
                    f.complete(&lookup, PrivacyClass::SharedRoom, 121);
                }
                assert!(matches!(
                    f.apply(
                        RuntimeOperation::Propose {
                            turn_id: f.fence.turn_id,
                            generation: f.fence.generation,
                            worker: f.fence.worker,
                            intent: SemanticIntent::PlaceAddressCard {
                                content: visual_reference(135)
                            },
                            privacy: PrivacyClass::SharedRoom,
                            hint: None,
                        },
                        122
                    ),
                    Err(RuntimeError::PolicyBlocked)
                ));
                assert!(f.state.actions.is_empty());
            }
        }
    }

    #[test]
    fn ambiance_lookup_place_reference_survives_renderer_repair_and_ack_but_never_its_expiry() {
        let mut f = Fixture::new(Kind::Native, PrivacyClass::Public);
        browser(&mut f.records);
        f.set_service_policy(
            LookupService::Places,
            0,
            Some(service_policy(LookupService::Places)),
            111,
        )
        .unwrap();
        let RuntimeResult::LookupStarted(lookup) =
            f.start_service(LookupService::Places, 120).unwrap()
        else {
            panic!("places reservation")
        };
        let visual = visual_reference(130);
        f.apply(
            RuntimeOperation::CompleteLookup {
                fence: f.fence.clone(),
                lookup,
                evidence_digest: hash(b"transient place evidence"),
                privacy: PrivacyClass::SharedRoom,
                visual: Some(visual.clone()),
                query_text: None,
            },
            121,
        )
        .unwrap();
        let RuntimeResult::Proposed(action) = f.apply(f.proposal(), 122).unwrap() else {
            panic!("place card")
        };
        assert_eq!(action.deadline_ms, 130);
        assert_eq!(action.display_expires_at_ms, 130);
        let RuntimeResult::Dispatch(dispatched) = f
            .apply(
                RuntimeOperation::Claim {
                    action_id: action.id,
                    generation: f.fence.generation,
                    worker: f.fence.worker,
                },
                123,
            )
            .unwrap()
        else {
            panic!("place dispatch")
        };
        assert_eq!(dispatched.deadline_ms, 130);
        let selected = &f.records[&action.surface_id];
        let (hidden, _) = transition(
            Some(selected),
            f.records.len(),
            action.surface_id,
            &Mutation::State {
                token_hash: selected.token_hash.clone(),
                incarnation: selected.incarnation,
                sequence: selected.sequence + 1,
                visible: false,
            },
            124,
        )
        .unwrap();
        f.records.insert(action.surface_id, hidden);
        let events = f.state.reconcile(&f.records, 124);
        assert!(events.iter().any(|event| matches!(event, RuntimeData::Repair { previous_action, .. } if *previous_action == action.id)));
        let replacement = f
            .state
            .actions
            .values()
            .find(|next| next.id != action.id)
            .unwrap()
            .clone();
        assert_eq!(replacement.root_id, action.root_id);
        assert_eq!(replacement.content_digest, visual.digest);
        assert_eq!(
            replacement.intent,
            SemanticIntent::PlaceAddressCard {
                content: visual.for_audience(replacement.surface_id),
            }
        );
        assert_eq!(replacement.deadline_ms, 130);
        assert_eq!(replacement.display_expires_at_ms, 130);
        f.apply(
            RuntimeOperation::Claim {
                action_id: replacement.id,
                generation: f.fence.generation,
                worker: f.fence.worker,
            },
            125,
        )
        .unwrap();
        let renderer = &f.records[&replacement.surface_id];
        f.apply(
            RuntimeOperation::Ack {
                action_id: replacement.id,
                turn_id: f.fence.turn_id,
                generation: f.fence.generation,
                connection: RoomProof::Browser(BrowserProof {
                    surface_id: renderer.surface_id,
                    incarnation: renderer.incarnation,
                    token_hash: renderer.token_hash.clone(),
                }),
                channel: crate::ambiance::Channel::VisualCard,
                content_digest: visual.digest.clone(),
            },
            126,
        )
        .unwrap();
        assert_eq!(
            f.state.actions[&replacement.id].status,
            ActionStatus::Acknowledged
        );
        assert_eq!(f.state.next_maintenance_ms(&f.records), 130);
        let events = f.state.reconcile(&f.records, 130);
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, RuntimeData::Repair { .. }))
        );
        assert!(f.state.turn.as_ref().unwrap().cancelled);
        assert_eq!(
            f.state.actions[&replacement.id].status,
            ActionStatus::Cancelled
        );
        assert_eq!(
            f.state.actions[&replacement.id].content_digest,
            visual.digest
        );
        assert!(
            f.apply(
                RuntimeOperation::Claim {
                    action_id: replacement.id,
                    generation: f.fence.generation,
                    worker: f.fence.worker,
                },
                131
            )
            .is_err()
        );
    }

    #[test]
    fn ambiance_lookup_web_receipt_keeps_exact_old_bytes_and_rejects_visual_references() {
        let mut f = Fixture::ready(Kind::Browser);
        let lookup = f.start();
        assert!(matches!(
            f.apply(
                RuntimeOperation::CompleteLookup {
                    fence: f.fence.clone(),
                    lookup: lookup.clone(),
                    evidence_digest: hash(b"actual bounded evidence"),
                    privacy: PrivacyClass::SharedRoom,
                    visual: Some(visual_reference(135)),
                    query_text: None,
                },
                121
            ),
            Err(RuntimeError::InvalidRequest)
        ));
        assert!(
            f.state
                .turn
                .as_ref()
                .unwrap()
                .lookup
                .as_ref()
                .unwrap()
                .receipt
                .is_none()
        );
        let receipt = f.complete(&lookup, PrivacyClass::SharedRoom, 122);
        assert!(receipt.visual.is_none());
        let old_receipt = format!(
            "{{\"evidence_digest\":\"{}\",\"received_at_ms\":122,\"privacy\":\"shared_room\"}}",
            hash(b"actual bounded evidence"),
        );
        assert_eq!(serde_json::to_string(&receipt).unwrap(), old_receipt);
        let decoded: Receipt = serde_json::from_str(&old_receipt).unwrap();
        assert_eq!(decoded, receipt);
        let old_event = format!(
            "{{\"kind\":\"lookup_completed\",\"fence\":{},\"id\":\"{}\",\"policy_revision\":{},\"receipt\":{old_receipt}}}",
            serde_json::to_string(&f.fence).unwrap(),
            lookup.id,
            lookup.policy_revision,
        );
        let decoded: RuntimeData = serde_json::from_str(&old_event).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), old_event);
        let text = "ordinary web output";
        for intent in [
            SemanticIntent::VisualTextCard { text: text.into() },
            SemanticIntent::InformationalSpeech { text: text.into() },
        ] {
            assert_eq!(intent.content_digest(), hash(text.as_bytes()));
        }
    }

    #[test]
    fn ambiance_lookup_display_confirmation_is_fixed_and_once_per_acknowledged_visual_root() {
        for service in [None, Some(LookupService::Web), Some(LookupService::Places)] {
            let mut f = Fixture::new(Kind::Pin, PrivacyClass::Public);
            if let Some(service) = service {
                f.set_service_policy(service, 0, Some(service_policy(service)), 111)
                    .unwrap();
                let RuntimeResult::LookupStarted(lookup) = f.start_service(service, 120).unwrap()
                else {
                    panic!("lookup reservation")
                };
                f.complete(&lookup, PrivacyClass::SharedRoom, 121);
            }
            let RuntimeResult::Proposed(visual) = f.apply(f.proposal(), 122).unwrap() else {
                panic!("visual output")
            };
            assert!(matches!(
                f.apply(
                    RuntimeOperation::ConfirmDisplay {
                        action_id: visual.id,
                        generation: f.fence.generation,
                        worker: f.fence.worker,
                    },
                    123
                ),
                Err(RuntimeError::PolicyBlocked)
            ));
            f.acknowledge_visual(&visual, 124);
            let (RuntimeResult::Proposed(confirmation), events) = f
                .state
                .apply(
                    PRINCIPAL,
                    &f.records,
                    RuntimeOperation::ConfirmDisplay {
                        action_id: visual.id,
                        generation: f.fence.generation,
                        worker: f.fence.worker,
                    },
                    126,
                )
                .unwrap()
            else {
                panic!("fixed acknowledged-display confirmation")
            };
            assert_eq!(
                confirmation.intent.text(),
                "Displayed on your approved screen."
            );
            assert_eq!(confirmation.channel, crate::ambiance::Channel::AudioTts);
            assert_eq!(confirmation.surface_id, f.fence.origin_surface);
            assert_eq!(
                confirmation.privacy,
                f.state.turn.as_ref().unwrap().privacy.max(visual.privacy)
            );
            assert_eq!(confirmation.confirmation_root, Some(visual.root_id));
            assert_eq!(
                confirmation.content_digest,
                hash(b"Displayed on your approved screen.")
            );
            assert!(confirmation.display_expires_at_ms <= visual.display_expires_at_ms);
            assert!(events.iter().any(|event| matches!(event,
                RuntimeData::DisplayConfirmationProposed { visual_root, visual_action, action_id }
                if *visual_root == visual.root_id && *visual_action == visual.id && *action_id == confirmation.id
            )));
            f.state = serde_json::from_slice(&serde_json::to_vec(&f.state).unwrap()).unwrap();
            let count = f.state.actions.len();
            assert!(matches!(
                f.apply(
                    RuntimeOperation::ConfirmDisplay {
                        action_id: visual.id,
                        generation: f.fence.generation,
                        worker: f.fence.worker,
                    },
                    127
                ),
                Err(RuntimeError::Busy)
            ));
            assert_eq!(f.state.actions.len(), count);
            if service == Some(LookupService::Places) {
                assert!(matches!(
                    f.apply(
                        RuntimeOperation::Propose {
                            turn_id: f.fence.turn_id,
                            generation: f.fence.generation,
                            worker: f.fence.worker,
                            intent: SemanticIntent::InformationalSpeech {
                                text: "Displayed on your approved screen.".into()
                            },
                            privacy: PrivacyClass::Public,
                            hint: None,
                        },
                        128
                    ),
                    Err(RuntimeError::PolicyBlocked)
                ));
            }
            let RuntimeResult::Dispatch(dispatched) = f
                .apply(
                    RuntimeOperation::Claim {
                        action_id: confirmation.id,
                        generation: f.fence.generation,
                        worker: f.fence.worker,
                    },
                    129,
                )
                .unwrap()
            else {
                panic!("fixed stock speech dispatch")
            };
            assert_eq!(
                dispatched.intent.text(),
                "Displayed on your approved screen."
            );
            assert!(matches!(
                f.apply(
                    RuntimeOperation::ConfirmDisplay {
                        action_id: visual.id,
                        generation: f.fence.generation,
                        worker: f.fence.worker,
                    },
                    130
                ),
                Err(RuntimeError::Busy)
            ));
            assert_eq!(f.state.actions.len(), count);
        }
    }

    #[test]
    fn ambiance_lookup_display_confirmation_rejects_stale_ids_workers_and_mismatched_lineages() {
        let mut f = Fixture::new(Kind::Pin, PrivacyClass::Public);
        let RuntimeResult::Proposed(visual) = f.apply(f.proposal(), 122).unwrap() else {
            panic!("visual output")
        };
        f.apply(
            RuntimeOperation::Claim {
                action_id: visual.id,
                generation: f.fence.generation,
                worker: f.fence.worker,
            },
            123,
        )
        .unwrap();
        assert!(matches!(
            f.apply(
                RuntimeOperation::ConfirmDisplay {
                    action_id: visual.id,
                    generation: f.fence.generation,
                    worker: f.fence.worker,
                },
                124
            ),
            Err(RuntimeError::PolicyBlocked)
        ));
        let record = &f.records[&visual.surface_id];
        let connection = BrowserProof {
            surface_id: record.surface_id,
            incarnation: record.incarnation,
            token_hash: record.token_hash.clone(),
        };
        f.apply(
            RuntimeOperation::Ack {
                action_id: visual.id,
                turn_id: f.fence.turn_id,
                generation: f.fence.generation,
                connection: RoomProof::Browser(connection),
                channel: crate::ambiance::Channel::VisualCard,
                content_digest: visual.content_digest.clone(),
            },
            125,
        )
        .unwrap();
        for operation in [
            RuntimeOperation::ConfirmDisplay {
                action_id: Uuid::new_v4(),
                generation: f.fence.generation,
                worker: f.fence.worker,
            },
            RuntimeOperation::ConfirmDisplay {
                action_id: visual.id,
                generation: f.fence.generation + 1,
                worker: f.fence.worker,
            },
            RuntimeOperation::ConfirmDisplay {
                action_id: visual.id,
                generation: f.fence.generation,
                worker: Uuid::new_v4(),
            },
        ] {
            assert!(f.apply(operation, 126).is_err());
        }
        for mismatch in ["root", "digest", "turn", "incarnation"] {
            let mut changed = f.clone();
            let action = changed.state.actions.get_mut(&visual.id).unwrap();
            match mismatch {
                "root" => action.root_id = Uuid::new_v4(),
                "digest" => action.content_digest = hash(b"another card"),
                "turn" => action.turn_id = Uuid::new_v4(),
                "incarnation" => action.incarnation = Uuid::new_v4(),
                _ => unreachable!(),
            }
            assert!(
                changed
                    .apply(
                        RuntimeOperation::ConfirmDisplay {
                            action_id: visual.id,
                            generation: changed.fence.generation,
                            worker: changed.fence.worker,
                        },
                        126
                    )
                    .is_err()
            );
            assert!(
                !changed
                    .state
                    .actions
                    .values()
                    .any(|action| action.confirmation_root.is_some())
            );
        }
    }

    #[test]
    fn ambiance_lookup_display_confirmation_follows_the_exact_acknowledged_repair() {
        let mut f = Fixture::new(Kind::Pin, PrivacyClass::Public);
        browser(&mut f.records);
        f.set_service_policy(
            LookupService::Places,
            0,
            Some(service_policy(LookupService::Places)),
            111,
        )
        .unwrap();
        let RuntimeResult::LookupStarted(lookup) =
            f.start_service(LookupService::Places, 120).unwrap()
        else {
            panic!("places reservation")
        };
        f.complete(&lookup, PrivacyClass::SharedRoom, 121);
        let RuntimeResult::Proposed(original) = f.apply(f.proposal(), 122).unwrap() else {
            panic!("visual output")
        };
        let selected = &f.records[&original.surface_id];
        let (hidden, _) = transition(
            Some(selected),
            f.records.len(),
            selected.surface_id,
            &Mutation::State {
                token_hash: selected.token_hash.clone(),
                incarnation: selected.incarnation,
                sequence: selected.sequence + 1,
                visible: false,
            },
            123,
        )
        .unwrap();
        f.records.insert(original.surface_id, hidden);
        // The chosen page is still connected, so its card is held for it;
        // when nobody comes back to it inside its own window the logged
        // fallback receives its own new action.
        assert!(f.state.reconcile(&f.records, 123).is_empty());
        f.state
            .reconcile(&f.records, f.state.actions[&original.id].deadline_ms);
        let replacement = f
            .state
            .actions
            .values()
            .find(|action| action.id != original.id)
            .unwrap()
            .clone();
        f.acknowledge_visual(&replacement, 124);
        let (RuntimeResult::Proposed(confirmation), events) = f
            .state
            .apply(
                PRINCIPAL,
                &f.records,
                RuntimeOperation::ConfirmDisplay {
                    action_id: original.id,
                    generation: f.fence.generation,
                    worker: f.fence.worker,
                },
                126,
            )
            .unwrap()
        else {
            panic!("confirmation of exact repaired lineage")
        };
        assert_eq!(confirmation.confirmation_root, Some(original.root_id));
        assert_eq!(
            confirmation.intent.text(),
            "Displayed on your approved screen."
        );
        assert!(events.iter().any(|event| matches!(event,
            RuntimeData::DisplayConfirmationProposed { visual_root, visual_action, .. }
            if *visual_root == original.root_id && *visual_action == replacement.id
        )));
    }

    #[test]
    fn ambiance_lookup_display_confirmation_rechecks_expiry_renderer_and_origin_policy_before_claim()
     {
        let mut original = Fixture::new(Kind::Pin, PrivacyClass::Public);
        original
            .set_service_policy(
                LookupService::Places,
                0,
                Some(service_policy(LookupService::Places)),
                111,
            )
            .unwrap();
        let RuntimeResult::LookupStarted(lookup) =
            original.start_service(LookupService::Places, 120).unwrap()
        else {
            panic!("places reservation")
        };
        original
            .apply(
                RuntimeOperation::CompleteLookup {
                    fence: original.fence.clone(),
                    lookup,
                    evidence_digest: hash(b"transient place evidence"),
                    privacy: PrivacyClass::SharedRoom,
                    visual: Some(visual_reference(140)),
                    query_text: None,
                },
                121,
            )
            .unwrap();
        let RuntimeResult::Proposed(visual) = original.apply(original.proposal(), 122).unwrap()
        else {
            panic!("visual output")
        };
        original.acknowledge_visual(&visual, 123);
        for cause in ["expiry", "renderer", "permission", "origin"] {
            let mut f = original.clone();
            let RuntimeResult::Proposed(confirmation) = f
                .apply(
                    RuntimeOperation::ConfirmDisplay {
                        action_id: visual.id,
                        generation: f.fence.generation,
                        worker: f.fence.worker,
                    },
                    125,
                )
                .unwrap()
            else {
                panic!("fixed confirmation")
            };
            assert_eq!(confirmation.display_expires_at_ms, 140);
            let now = if cause == "expiry" { 140 } else { 126 };
            match cause {
                "renderer" => {
                    let (revoked, _) = transition(
                        Some(&f.records[&visual.surface_id]),
                        f.records.len(),
                        visual.surface_id,
                        &Mutation::Revoke,
                        now,
                    )
                    .unwrap();
                    f.records.insert(visual.surface_id, revoked);
                    f.state.reconcile(&f.records, now);
                }
                "permission" => {
                    f.set_service_policy(LookupService::Places, 1, None, now)
                        .unwrap();
                }
                "origin" => f.revoke_origin(now),
                "expiry" => {
                    f.state.reconcile(&f.records, now);
                }
                _ => unreachable!(),
            }
            assert_eq!(
                f.state.actions[&confirmation.id].status,
                ActionStatus::Cancelled
            );
            assert_eq!(
                f.state.actions[&confirmation.id].confirmation_root,
                Some(visual.root_id)
            );
            assert!(f.state.actions[&confirmation.id].intent.text().is_empty());
            assert!(
                f.apply(
                    RuntimeOperation::Claim {
                        action_id: confirmation.id,
                        generation: f.fence.generation,
                        worker: f.fence.worker,
                    },
                    now + 1
                )
                .is_err()
            );
        }
    }

    #[test]
    fn ambiance_lookup_v6_state_and_web_event_keep_web_authority_without_granting_places() {
        for kind in KINDS {
            let mut f = Fixture::ready(kind);
            let surface_id = f.fence.origin_surface;
            let approval = f.state.lookup_policies[&surface_id].approval.clone();
            let legacy_event = format!(
                "{{\"kind\":\"lookup_policy_changed\",\"surface_id\":\"{surface_id}\",\"approval\":{}}}",
                serde_json::to_string(&approval).unwrap(),
            );
            let decoded: RuntimeData = serde_json::from_str(&legacy_event).unwrap();
            assert_eq!(serde_json::to_string(&decoded).unwrap(), legacy_event);
            let mut legacy_state = serde_json::to_value(&f.state).unwrap();
            legacy_state
                .as_object_mut()
                .unwrap()
                .remove("place_lookup_policies")
                .unwrap();
            f.state = serde_json::from_value(legacy_state).unwrap();
            assert!(f.state.place_lookup_policies.is_empty());
            assert_eq!(f.state.lookup_policies[&surface_id].approval, approval);
            assert!(matches!(
                f.apply(
                    RuntimeOperation::LookupPolicy {
                        service: LookupService::Places,
                        surface_id,
                    },
                    112
                )
                .unwrap(),
                RuntimeResult::LookupPolicy { approval: None, .. }
            ));
            assert!(matches!(
                f.start_service(LookupService::Places, 113).unwrap(),
                RuntimeResult::Blocked
            ));
            assert!(matches!(
                f.start_service(LookupService::Web, 120).unwrap(),
                RuntimeResult::LookupStarted(_)
            ));
        }
    }

    #[test]
    fn ambiance_lookup_absent_fields_in_older_state_deserialize_without_granting_permission() {
        let mut f = Fixture::new(Kind::Browser, PrivacyClass::Public);
        let mut old = serde_json::to_value(&f.state).unwrap();
        assert!(
            old.as_object_mut()
                .unwrap()
                .remove("lookup_policies")
                .is_some()
        );
        assert!(
            old.as_object_mut()
                .unwrap()
                .remove("place_lookup_policies")
                .is_some()
        );
        assert!(
            old["turn"]
                .as_object_mut()
                .unwrap()
                .remove("lookup")
                .is_some()
        );
        f.state = serde_json::from_value(old).unwrap();
        assert!(f.state.lookup_policies.is_empty());
        assert!(f.state.turn.as_ref().unwrap().lookup.is_none());
        assert!(matches!(
            f.apply(
                RuntimeOperation::LookupPolicy {
                    service: LookupService::Web,
                    surface_id: f.fence.origin_surface
                },
                120
            )
            .unwrap(),
            RuntimeResult::LookupPolicy { approval: None, .. }
        ));
        assert!(matches!(
            f.apply(
                RuntimeOperation::StartLookup {
                    fence: f.fence.clone(),
                    request: request(),
                    id: Uuid::new_v4()
                },
                121
            )
            .unwrap(),
            RuntimeResult::Blocked
        ));
    }

    #[test]
    fn recent_place_context_is_remembered_offered_and_expired_under_the_shared_room_ceiling() {
        let mut fixture = Fixture::ready(Kind::Browser);
        fixture
            .set_service_policy(
                LookupService::Places,
                0,
                Some(service_policy(LookupService::Places)),
                112,
            )
            .unwrap();
        let RuntimeResult::LookupStarted(lookup) =
            fixture.start_service(LookupService::Places, 120).unwrap()
        else {
            panic!("places lookup capability")
        };
        // A web receipt or an absent query leaves no memory; a place query does.
        let RuntimeResult::LookupCompleted(_) = fixture
            .apply(
                RuntimeOperation::CompleteLookup {
                    fence: fixture.fence.clone(),
                    lookup: lookup.clone(),
                    evidence_digest: hash(b"actual bounded evidence"),
                    privacy: PrivacyClass::SharedRoom,
                    visual: Some(visual_reference(130 + 60_000)),
                    query_text: Some("observatory Copenhagen".into()),
                },
                130,
            )
            .unwrap()
        else {
            panic!("committed lookup receipt")
        };
        let remembered = fixture
            .state
            .recent_context
            .first()
            .cloned()
            .expect("recent place query");
        assert_eq!(
            remembered.kind,
            super::super::state::RecentContextKind::PlaceQuery
        );
        assert_eq!(remembered.text, "observatory Copenhagen");
        assert_eq!(remembered.source_surface, fixture.fence.origin_surface);
        assert_eq!(remembered.privacy, PrivacyClass::SharedRoom);
        assert_eq!(
            remembered.expires_at_ms,
            130 + super::super::state::RECENT_CONTEXT_MS
        );
        // The current turn is offered the memory once per request; a stale
        // fence gets nothing, and expiry clears it for everyone.
        let RuntimeResult::RecentContext {
            contexts: offered, ..
        } = fixture
            .apply(
                RuntimeOperation::RecentContext {
                    fence: fixture.fence.clone(),
                },
                140,
            )
            .unwrap()
        else {
            panic!("offered recent context")
        };
        assert_eq!(offered, vec![remembered]);
        let mut stale = fixture.fence.clone();
        stale.generation += 1;
        assert!(matches!(
            fixture.apply(RuntimeOperation::RecentContext { fence: stale }, 141),
            Err(RuntimeError::Stale)
        ));
        let expiry = 130 + super::super::state::RECENT_CONTEXT_MS;
        fixture.state.reconcile(&fixture.records, expiry);
        assert!(fixture.state.recent_context.is_empty());
    }
}
