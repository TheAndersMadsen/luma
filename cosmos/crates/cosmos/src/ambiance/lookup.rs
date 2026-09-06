//! One owner-approved web disclosure per turn, committed before provider I/O.
//! Only provider identities and digests enter the durable authority ledger.
use super::{PrivacyClass, RuntimeData, RuntimeError, RuntimeState, Turn, TurnFence};
use crate::{
    backends::search::LookupProviderIdentity,
    surface_registry::{Binding, Record},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const OWNER_APPROVAL: &str = "approve-web-lookup-disclosure-v1";
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
    pub(super) fn current(&self, record: &Record) -> bool {
        !record.revoked
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
                        record.approved_manifest == crate::surface_registry::native_manifest()
                    }
                }
        })
        .ok_or(RuntimeError::InvalidOrigin)
}

impl RuntimeState {
    pub(super) fn lookup_policy(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
    ) -> Result<(Option<Approval>, ApprovalBinding), RuntimeError> {
        let record = record(records, surface)?;
        Ok((
            self.lookup_policies
                .get(&surface)
                .filter(|bound| bound.current(record))
                .map(|bound| bound.approval.clone()),
            ApprovalBinding::for_record(record),
        ))
    }

    pub(super) fn set_lookup_policy(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
        approval_revision: u64,
        approval_incarnation: Option<Uuid>,
        expected_revision: u64,
        policy: Option<Policy>,
    ) -> Result<(Approval, ApprovalBinding, Vec<RuntimeData>), RuntimeError> {
        let record = record(records, surface)?;
        let (current, binding) = self.lookup_policy(records, surface)?;
        if approval_revision == 0
            || approval_revision > MAX_REVISION
            || approval_incarnation.is_some_and(|incarnation| incarnation.is_nil())
            || expected_revision >= MAX_REVISION
            || policy.as_ref().is_some_and(|policy| !policy.valid())
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
        self.lookup_policies.insert(
            surface,
            BoundApproval {
                approval: approval.clone(),
                origin_incarnation: binding.incarnation,
            },
        );
        Ok((
            approval.clone(),
            binding,
            vec![RuntimeData::LookupPolicyChanged {
                surface_id: surface,
                approval,
            }],
        ))
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
        let Some(bound) = self.lookup_policies.get(&turn.fence.origin_surface) else {
            return false;
        };
        if !bound.current(record)
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
            .lookup_policy(records, fence.origin_surface)?
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
            vec![RuntimeData::LookupStarted { fence, lookup }],
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
        evidence_digest: String,
        privacy: PrivacyClass,
        now: i64,
    ) -> Result<(Receipt, Vec<RuntimeData>), RuntimeError> {
        self.check_lookup(records, &fence, &lookup, now)?;
        if !super::state::digest_valid(&evidence_digest) {
            return Err(RuntimeError::InvalidRequest);
        }
        let turn = self.turn.as_mut().unwrap();
        turn.privacy = turn.privacy.max(lookup.request.privacy).max(privacy);
        let receipt = Receipt {
            evidence_digest,
            received_at_ms: now,
            privacy: turn.privacy,
        };
        turn.lookup.as_mut().unwrap().receipt = Some(receipt.clone());
        Ok((
            receipt.clone(),
            vec![RuntimeData::LookupCompleted {
                fence,
                id: lookup.id,
                policy_revision: lookup.policy_revision,
                receipt,
            }],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambiance::{
        ActionStatus, BrowserProof, InputStamp, NativeProof, OriginProof, PinProof, RoomProof,
        RuntimeOperation, RuntimeResult, SemanticIntent, echo, native_connection,
    };
    use crate::backends::search::{self, LookupProviderIdentity};
    use crate::integrations::SearchConfig;
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
            let RuntimeResult::LookupCompleted(receipt) = self
                .apply(
                    RuntimeOperation::CompleteLookup {
                        fence: self.fence.clone(),
                        lookup: lookup.clone(),
                        evidence_digest: hash(b"actual bounded evidence"),
                        privacy,
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
            RuntimeOperation::Propose {
                turn_id: self.fence.turn_id,
                generation: self.fence.generation,
                worker: self.fence.worker,
                intent: SemanticIntent::VisualTextCard {
                    text: "A sourced answer".into(),
                },
                privacy: PrivacyClass::Public,
            }
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
                f.apply(RuntimeOperation::LookupPolicy { surface_id: origin }, 111)
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
                        fence: f.fence.clone(),
                        lookup: lookup.clone(),
                        evidence_digest: receipt.evidence_digest.clone(),
                        privacy: PrivacyClass::SharedRoom
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
                        fence: f.fence.clone(),
                        lookup: changed,
                        evidence_digest: hash(b"evidence"),
                        privacy: PrivacyClass::SharedRoom
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
                    fence: f.fence.clone(),
                    lookup: lookup.clone(),
                    evidence_digest: "not-a-digest".into(),
                    privacy: PrivacyClass::SharedRoom
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
                            fence: stale,
                            lookup: lookup.clone(),
                            evidence_digest: hash(b"evidence"),
                            privacy: PrivacyClass::SharedRoom
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
                        fence: f.fence.clone(),
                        lookup,
                        evidence_digest: hash(b"late evidence"),
                        privacy: PrivacyClass::SharedRoom
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
                        fence: f.fence.clone(),
                        lookup,
                        evidence_digest: hash(b"revoked late evidence"),
                        privacy: PrivacyClass::SharedRoom
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
                    fence: f.fence.clone(),
                    lookup,
                    evidence_digest: hash(b"replacement late evidence"),
                    privacy: PrivacyClass::SharedRoom
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
}
