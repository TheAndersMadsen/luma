use super::*;
use crate::ambiance::{SemanticIntent, disclosure};
use crate::surface_registry::{Mutation, pin_surface_id, transition};

const PRINCIPAL: &str = "U:voice-fixture";
struct Fixture {
    state: RuntimeState,
    records: BTreeMap<Uuid, Record>,
    proof: PinProof,
    stamp: InputStamp,
    binding: Binding,
    worker: Uuid,
    intake_id: Uuid,
}
impl Fixture {
    fn new(floor: PrivacyClass) -> Self {
        let id = pin_surface_id(PRINCIPAL, "aabb");
        let (record, _) = transition(
            None,
            0,
            id,
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            100,
        )
        .unwrap();
        let mut fixture = Self {
            state: RuntimeState::default(),
            records: BTreeMap::from([(id, record)]),
            proof: PinProof {
                device: cosmos_core::AuthenticatedDeviceIdentity::from_edge("aabb").unwrap(),
                surface_id: id,
                incarnation: Uuid::new_v4(),
            },
            stamp: InputStamp {
                epoch: Uuid::new_v4(),
                sequence: 1,
                instance_id: Uuid::new_v4(),
            },
            binding: Binding {
                media_owner: Uuid::new_v4(),
                participant_sid: "PA_fixture".into(),
                track_sid: "TR_fixture".into(),
            },
            worker: Uuid::new_v4(),
            intake_id: Uuid::new_v4(),
        };
        fixture
            .apply(
                RuntimeOperation::OpenPin {
                    device: fixture.proof.device.clone(),
                    surface_id: id,
                    approval_revision: 1,
                    epoch: fixture.stamp.epoch,
                    expected_incarnation: None,
                    incarnation: fixture.proof.incarnation,
                },
                101,
            )
            .unwrap();
        fixture
            .apply(
                RuntimeOperation::ClaimPinMedia {
                    connection: fixture.proof.clone(),
                    owner: fixture.binding.media_owner,
                },
                102,
            )
            .unwrap();
        fixture
            .apply(
                RuntimeOperation::SetVoicePolicy {
                    surface_id: id,
                    approval_revision: 1,
                    expected_revision: 0,
                    policy: Some(Policy {
                        source_floor: floor,
                    }),
                },
                103,
            )
            .unwrap();
        fixture
    }
    fn begin(&self) -> RuntimeOperation {
        RuntimeOperation::BeginVoice {
            connection: self.proof.clone(),
            stamp: self.stamp.clone(),
            worker: self.worker,
            intake_id: self.intake_id,
            binding: self.binding.clone(),
        }
    }
    fn finalize(&self, fence: &TurnFence, text: &str) -> RuntimeOperation {
        RuntimeOperation::FinalizeVoice {
            connection: self.proof.clone(),
            fence: fence.clone(),
            binding: self.binding.clone(),
            transcript: text.into(),
        }
    }
    fn check(&self, fence: &TurnFence) -> RuntimeOperation {
        RuntimeOperation::CheckVoice {
            connection: self.proof.clone(),
            fence: fence.clone(),
            binding: self.binding.clone(),
        }
    }
    fn apply(
        &mut self,
        operation: RuntimeOperation,
        now: i64,
    ) -> Result<(RuntimeResult, Vec<RuntimeData>), RuntimeError> {
        self.state.apply(PRINCIPAL, &self.records, operation, now)
    }
    fn start(&mut self) -> TurnFence {
        let (RuntimeResult::Begun(fence), _) = self.apply(self.begin(), 104).unwrap() else {
            panic!()
        };
        fence
    }
}

#[test]
fn ambiance_voice_pending_has_no_cognition_analysis_proposal_or_disclosure_authority() {
    let mut f = Fixture::new(PrivacyClass::SharedRoom);
    let fence = f.start();
    assert!(matches!(
        f.apply(f.check(&fence), 105).unwrap().0,
        RuntimeResult::VoiceCurrent
    ));
    let operations = [
        RuntimeOperation::CheckCognition {
            fence: fence.clone(),
        },
        RuntimeOperation::AnalysisStart {
            fence: fence.clone(),
            input_digest: hash(b"analysis"),
            privacy: PrivacyClass::Public,
        },
        RuntimeOperation::AnalysisComplete {
            fence: fence.clone(),
            input_digest: hash(b"analysis"),
            output_digest: hash(b"result"),
            privacy: PrivacyClass::Public,
        },
        RuntimeOperation::Propose {
            turn_id: fence.turn_id,
            generation: fence.generation,
            worker: fence.worker,
            intent: SemanticIntent::InformationalSpeech {
                text: "a claimed answer".into(),
            },
            privacy: PrivacyClass::Public,
        },
        RuntimeOperation::StartDisclosure {
            fence: fence.clone(),
            id: Uuid::new_v4(),
            request: disclosure::Request {
                provider: disclosure::Provider::AzureSpeech {
                    region: "westeurope".into(),
                },
                purpose: disclosure::Purpose::Transcription,
                payload_digest: hash(b"pcm"),
                content_digest: hash(b"pcm"),
                action_id: None,
                privacy: PrivacyClass::Sensitive,
            },
        },
    ];
    for operation in operations {
        assert!(f.apply(operation, 105).is_err());
    }
    assert!(f.state.actions.is_empty());
    assert!(f.state.turn.as_ref().unwrap().analysis.is_none());
    assert!(f.state.turn.as_ref().unwrap().disclosures.is_empty());
    assert_eq!(
        f.state.turn.as_ref().unwrap().privacy,
        PrivacyClass::SharedRoom
    );
}

#[test]
fn ambiance_voice_intake_consumes_one_sequence_and_reopen_never_grants_duplicate_ownership() {
    let mut f = Fixture::new(PrivacyClass::SharedRoom);
    let fence = f.start();
    let original_id = f.intake_id;
    f.state = serde_json::from_value(serde_json::to_value(&f.state).unwrap()).unwrap();
    f.intake_id = Uuid::new_v4();
    let (RuntimeResult::Duplicate(retried), events) = f.apply(f.begin(), 105).unwrap() else {
        panic!()
    };
    assert_eq!(fence.turn_id, retried.turn_id);
    assert!(events.is_empty());
    assert_eq!(f.state.ingress[&f.proof.surface_id].high_water, 1);
    assert!(
        f.apply(
            RuntimeOperation::RetireVoice {
                turn_id: fence.turn_id,
                worker: f.worker,
                intake_id: f.intake_id
            },
            106
        )
        .is_err()
    );
    assert!(f.apply(f.check(&fence), 107).is_ok());
    f.binding.track_sid = "TR_changed".into();
    assert!(matches!(f.apply(f.begin(), 108), Err(RuntimeError::Stale)));
    f.binding.track_sid = "TR_fixture".into();
    let (result, events) = f
        .apply(f.finalize(&fence, "Tell me a public fact"), 109)
        .unwrap();
    assert!(matches!(
        result,
        RuntimeResult::VoiceFinalized {
            privacy: PrivacyClass::SharedRoom
        }
    ));
    assert_eq!(events.len(), 1);
    assert_eq!(f.state.ingress[&f.proof.surface_id].high_water, 1);
    assert!(
        f.apply(f.finalize(&fence, "Replacement transcript"), 110)
            .is_err()
    );
    assert!(
        f.apply(
            RuntimeOperation::CheckCognition {
                fence: fence.clone()
            },
            110
        )
        .is_ok()
    );
    let serialized = serde_json::to_string(&f.state).unwrap();
    assert!(!serialized.contains("Tell me"));
    assert!(!serialized.contains("Replacement transcript"));
    assert_eq!(
        f.state.turn.as_ref().unwrap().voice.as_ref().unwrap().id,
        original_id
    );
}

#[test]
fn ambiance_voice_transcript_joins_source_floor_and_runtime_raises_without_downgrade() {
    for (floor, text, expected) in [
        (
            PrivacyClass::SharedRoom,
            "A public fact",
            PrivacyClass::SharedRoom,
        ),
        (
            PrivacyClass::NearUser,
            "A public fact",
            PrivacyClass::NearUser,
        ),
        (
            PrivacyClass::Private,
            "A public fact",
            PrivacyClass::Private,
        ),
        (
            PrivacyClass::Sensitive,
            "A public fact",
            PrivacyClass::Sensitive,
        ),
        (
            PrivacyClass::SharedRoom,
            "Read my messages",
            PrivacyClass::Private,
        ),
        (
            PrivacyClass::SharedRoom,
            "Read my password",
            PrivacyClass::Sensitive,
        ),
    ] {
        let mut f = Fixture::new(floor);
        let fence = f.start();
        assert!(
            matches!(f.apply(f.finalize(&fence, text), 105).unwrap().0, RuntimeResult::VoiceFinalized { privacy } if privacy == expected)
        );
        assert_eq!(f.state.turn.as_ref().unwrap().privacy, expected);
        assert_eq!(
            f.state
                .turn
                .as_ref()
                .unwrap()
                .voice
                .as_ref()
                .unwrap()
                .source_floor,
            floor
        );
        let check = f.apply(
            RuntimeOperation::CheckCognition {
                fence: fence.clone(),
            },
            106,
        );
        assert_eq!(check.is_ok(), expected <= PrivacyClass::SharedRoom);
        let proposal = f
            .apply(
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::InformationalSpeech {
                        text: "A public model answer".into(),
                    },
                    privacy: PrivacyClass::Public,
                },
                107,
            )
            .unwrap()
            .0;
        assert_eq!(
            matches!(proposal, RuntimeResult::Proposed(_)),
            expected <= PrivacyClass::SharedRoom
        );
        assert_eq!(f.state.turn.as_ref().unwrap().privacy, expected);
    }
}

#[test]
fn ambiance_voice_requires_separate_approval_and_exact_source_and_admission_fields() {
    for field in [
        "policy",
        "media",
        "incarnation",
        "epoch",
        "device",
        "owner",
        "sequence",
        "instance",
    ] {
        let mut f = Fixture::new(PrivacyClass::SharedRoom);
        match field {
            "policy" => {
                f.state.voice_policies.clear();
            }
            "media" => {
                f.state
                    .pin_connections
                    .get_mut(&f.proof.surface_id)
                    .unwrap()
                    .media_owner = None;
            }
            "incarnation" => f.proof.incarnation = Uuid::new_v4(),
            "epoch" => f.stamp.epoch = Uuid::new_v4(),
            "device" => {
                f.proof.device =
                    cosmos_core::AuthenticatedDeviceIdentity::from_edge("ccdd").unwrap()
            }
            "owner" => f.binding.media_owner = Uuid::new_v4(),
            "sequence" => f.stamp.sequence = 0,
            "instance" => f.stamp.instance_id = Uuid::nil(),
            _ => unreachable!(),
        }
        assert!(f.apply(f.begin(), 104).is_err(), "{field}");
        assert!(f.state.turn.is_none());
    }
}

#[test]
fn ambiance_voice_revocation_reconnect_policy_change_and_deadline_fence_finalization() {
    for cause in [
        "revoke",
        "reconnect",
        "policy",
        "deadline",
        "worker",
        "turn",
        "generation",
        "source",
    ] {
        let mut f = Fixture::new(PrivacyClass::SharedRoom);
        let mut fence = f.start();
        let mut now = 105;
        match cause {
            "revoke" => f.records.get_mut(&f.proof.surface_id).unwrap().revoked = true,
            "reconnect" => {
                f.state
                    .pin_connections
                    .get_mut(&f.proof.surface_id)
                    .unwrap()
                    .incarnation = Uuid::new_v4()
            }
            "policy" => {
                f.apply(
                    RuntimeOperation::SetVoicePolicy {
                        surface_id: f.proof.surface_id,
                        approval_revision: 1,
                        expected_revision: 1,
                        policy: None,
                    },
                    105,
                )
                .unwrap();
            }
            "deadline" => now = 104 + INTAKE_MS,
            "worker" => fence.worker = Uuid::new_v4(),
            "turn" => fence.turn_id = Uuid::new_v4(),
            "generation" => fence.generation += 1,
            "source" => f.binding.participant_sid = "PA_changed".into(),
            _ => unreachable!(),
        }
        assert!(
            f.apply(f.finalize(&fence, "A late transcript"), now)
                .is_err(),
            "{cause}"
        );
        assert!(f.state.turn.as_ref().unwrap().voice_pending());
        assert!(f.state.actions.is_empty());
    }
}

#[test]
fn ambiance_voice_invalid_transcript_and_echo_never_gain_cognition_authority() {
    let mut f = Fixture::new(PrivacyClass::SharedRoom);
    let fence = f.start();
    for transcript in [String::new(), " ".into(), "x".repeat(4001)] {
        assert!(matches!(
            f.apply(f.finalize(&fence, &transcript), 105),
            Err(RuntimeError::InvalidRequest)
        ));
        assert!(f.state.turn.as_ref().unwrap().voice_pending());
    }
    f.state.echoes.push(crate::ambiance::echo::Window {
        action_id: Uuid::new_v4(),
        fingerprint: crate::ambiance::echo::fingerprint("A recent system answer"),
        expires_at_ms: 20_000,
        privacy: PrivacyClass::Private,
    });
    let (result, events) = f
        .apply(f.finalize(&fence, "A recent system answer!"), 106)
        .unwrap();
    assert!(matches!(result, RuntimeResult::EchoRejected));
    assert!(
        matches!(&events[0], RuntimeData::EchoRejected { privacy: PrivacyClass::Private, stamp: Some(stamp), .. } if stamp.sequence == 1)
    );
    assert_eq!(f.state.ingress[&f.proof.surface_id].high_water, 1);
    assert!(f.state.turn.as_ref().unwrap().cancelled);
    assert!(
        f.apply(RuntimeOperation::CheckCognition { fence }, 107)
            .is_err()
    );
}

mod runtime {
    use super::*;
    use crate::{
        ambiance::runtime::AmbianceRuntime,
        assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
        auth::{AuthenticatedRequest, AuthenticationPlane},
        enrollment::{MemoryEnrollmentStore, SharedEnrollmentStore},
        store::{MemoryStore, Store},
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct Model {
        calls: AtomicUsize,
        fail: bool,
    }
    #[tonic::async_trait]
    impl ChatModel for Model {
        async fn complete(
            &self,
            messages: &[ChatMessage],
            _: &[ToolDef],
        ) -> Result<ChatResponse, LlmError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(messages[1].content, "Tell me a public fact");
            if self.fail {
                return Err(LlmError::Malformed);
            }
            Ok(ChatResponse { tool_call: Some(ToolCall {
                name: "propose_information".into(),
                arguments: serde_json::json!({ "intent": { "kind": "informational_speech", "text": "A public answer" }, "privacy": "public" }).to_string(),
            }), ..Default::default() })
        }
    }
    struct App {
        runtime: Arc<AmbianceRuntime>,
        store: Arc<MemoryStore>,
        model: Arc<Model>,
        auth: AuthenticatedRequest,
        pairing: SharedEnrollmentStore,
        incarnation: Uuid,
        stamp: InputStamp,
        binding: Binding,
        source_current: Arc<AtomicBool>,
    }
    impl App {
        async fn new(floor: PrivacyClass, fail: bool) -> Self {
            let store = Arc::new(MemoryStore::default());
            let pairing: SharedEnrollmentStore = Arc::new(MemoryEnrollmentStore::default());
            let owner = format!("voice-{}", Uuid::new_v4());
            pairing.put_device_account("aabb", &owner).await.unwrap();
            let auth = AuthenticatedRequest {
                principal: cosmos_core::AuthenticatedPrincipal::for_user(&owner).unwrap(),
                device: Some(cosmos_core::AuthenticatedDeviceIdentity::from_edge("aabb").unwrap()),
                plane: AuthenticationPlane::Device,
            };
            let principal = auth.principal.expose_for_authorization();
            let id = pin_surface_id(principal, "aabb");
            store
                .mutate_surface(
                    principal,
                    id,
                    Mutation::ApprovePin {
                        device_id: "aabb".into(),
                    },
                )
                .await
                .unwrap();
            let model = Arc::new(Model {
                calls: AtomicUsize::new(0),
                fail,
            });
            let runtime = Arc::new(AmbianceRuntime::new(
                store.clone(),
                model.clone(),
                Some(pairing.clone()),
            ));
            let stamp = InputStamp {
                epoch: Uuid::new_v4(),
                sequence: 1,
                instance_id: Uuid::new_v4(),
            };
            let RuntimeResult::PinOpened { connection, .. } =
                runtime.open_pin(&auth, 1, stamp.epoch, None).await.unwrap()
            else {
                panic!()
            };
            let binding = Binding {
                media_owner: Uuid::new_v4(),
                participant_sid: "PA_fixture".into(),
                track_sid: "TR_fixture".into(),
            };
            store
                .runtime(
                    principal,
                    RuntimeOperation::ClaimPinMedia {
                        connection: runtime
                            .pin_proof(&auth, connection.incarnation)
                            .await
                            .unwrap(),
                        owner: binding.media_owner,
                    },
                )
                .await
                .unwrap();
            store
                .runtime(
                    principal,
                    RuntimeOperation::SetVoicePolicy {
                        surface_id: id,
                        approval_revision: 1,
                        expected_revision: 0,
                        policy: Some(Policy {
                            source_floor: floor,
                        }),
                    },
                )
                .await
                .unwrap();
            Self {
                runtime,
                store,
                model,
                auth,
                pairing,
                incarnation: connection.incarnation,
                stamp,
                binding,
                source_current: Arc::new(AtomicBool::new(true)),
            }
        }
        async fn start(&self) -> Option<LocalVoice> {
            let source_current = self.source_current.clone();
            self.runtime
                .begin_local_voice(
                    self.auth.clone(),
                    self.incarnation,
                    self.stamp.clone(),
                    self.binding.clone(),
                    Arc::new(move || source_current.load(Ordering::SeqCst)),
                )
                .await
                .unwrap()
        }
        async fn retired(&self, fence: &TurnFence) {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    if self
                        .store
                        .runtime(
                            self.auth.principal.expose_for_authorization(),
                            RuntimeOperation::CheckCognition {
                                fence: fence.clone(),
                            },
                        )
                        .await
                        .is_err()
                    {
                        // Pending voice also denies cognition; inspect its actual turn fence.
                        if self
                            .store
                            .runtime(
                                self.auth.principal.expose_for_authorization(),
                                RuntimeOperation::Inspect {
                                    turn_id: fence.turn_id,
                                    generation: fence.generation,
                                    worker: fence.worker,
                                },
                            )
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn ambiance_voice_runtime_continues_original_turn_once_without_memory_or_duplicate_cognition()
     {
        let app = App::new(PrivacyClass::SharedRoom, false).await;
        let intake = app.start().await.unwrap();
        let fence = intake.fence.clone();
        assert_eq!(app.model.calls.load(Ordering::SeqCst), 0);
        assert!(app.start().await.is_none());
        intake.check().await.unwrap();
        let RuntimeResult::Proposed(action) = intake
            .complete("Tell me a public fact".into())
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(action.turn_id, fence.turn_id);
        assert_eq!(action.generation, fence.generation);
        assert_eq!(action.privacy, PrivacyClass::SharedRoom);
        assert_eq!(app.model.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            app.store.assistant_private_accesses.load(Ordering::SeqCst),
            0
        );
        assert!(app.start().await.is_none());
        assert_eq!(app.model.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ambiance_voice_runtime_private_floor_failure_and_drop_retire_exact_intake() {
        for cause in ["private", "model", "invalid", "drop", "pairing", "source"] {
            let app = App::new(
                if cause == "private" {
                    PrivacyClass::Private
                } else {
                    PrivacyClass::SharedRoom
                },
                cause == "model",
            )
            .await;
            let intake = app.start().await.unwrap();
            let fence = intake.fence.clone();
            if cause == "pairing" {
                app.pairing
                    .put_device_account("aabb", "other-owner")
                    .await
                    .unwrap();
            }
            if cause == "source" {
                app.source_current.store(false, Ordering::SeqCst);
            }
            if cause == "drop" {
                drop(intake);
            } else {
                assert!(
                    intake
                        .complete(
                            if cause == "invalid" {
                                " "
                            } else {
                                "Tell me a public fact"
                            }
                            .into()
                        )
                        .await
                        .is_err(),
                    "{cause}"
                );
            }
            app.retired(&fence).await;
            assert_eq!(
                app.model.calls.load(Ordering::SeqCst),
                usize::from(cause == "model")
            );
        }
    }
}
