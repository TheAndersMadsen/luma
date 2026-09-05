use super::*;
use crate::{
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, Role, ToolCall, ToolDef},
    store::{MemoryStore, Store},
    surface_registry::{self, Mutation, hash},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use uuid::Uuid;

const PRINCIPAL: &str = "U:native-room-test";
const AUDIENCE: &str = "https://native-room.test";
const CURRENT_TEXT: &str = "Tell me a public fact";

#[derive(Default)]
struct Gate {
    entered: Notify,
    release: Notify,
}

#[derive(Default)]
struct SpyModel {
    calls: AtomicUsize,
    current_texts: Mutex<Vec<String>>,
    gate: Option<Arc<Gate>>,
}

#[tonic::async_trait]
impl ChatModel for SpyModel {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, Role::System);
        assert_eq!(messages[1].role, Role::User);
        assert!(
            messages
                .iter()
                .all(|message| !message.content.contains("private_canary"))
        );
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "propose_information");
        self.current_texts
            .lock()
            .unwrap()
            .push(messages[1].content.clone());
        if let Some(gate) = &self.gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        Ok(ChatResponse {
            tool_call: Some(ToolCall {
                name: "propose_information".into(),
                arguments: serde_json::json!({
                    "intent":{"kind":"visual_text_card","text":"A bounded public fact."},
                    "privacy":"public"
                })
                .to_string(),
            }),
            ..Default::default()
        })
    }
}

struct Fixture {
    runtime: Arc<runtime::AmbianceRuntime>,
    store: Arc<MemoryStore>,
    native: NativeProof,
    browser: BrowserProof,
    stamp: InputStamp,
}

fn signed_open(
    challenge: &native_connection::Challenge,
    epoch: Uuid,
    token_hash: String,
) -> native_connection::OpenRequest {
    let mut request = native_connection::OpenRequest {
        enrollment_id: challenge.enrollment_id,
        challenge_id: challenge.challenge_id,
        epoch,
        expected_incarnation: challenge.current_incarnation,
        session_token_hash: token_hash,
        signature: String::new(),
    };
    let mut scalar = [0u8; 32];
    scalar[31] = 1;
    let key = SigningKey::from_bytes(&scalar).unwrap();
    let signature: Signature =
        key.sign(&native_connection::signing_message(challenge, &request).unwrap());
    request.signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
    request
}

async fn fixture(model: Arc<SpyModel>) -> Fixture {
    let store = Arc::new(MemoryStore::default());
    store
        .create_indexed_note(PRINCIPAL, None, None, Some("private_canary"))
        .await
        .unwrap();
    let enrollment_id = Uuid::new_v4();
    let surface_id = surface_registry::native_surface_id(PRINCIPAL, enrollment_id);
    store
        .mutate_surface(
            PRINCIPAL,
            surface_id,
            crate::store::native_test_approval(enrollment_id, 0),
        )
        .await
        .unwrap();
    let RuntimeResult::NativeChallenge(challenge) = store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::NativeChallenge {
                surface_id,
                enrollment_id,
                audience: AUDIENCE.into(),
                challenge_id: Uuid::new_v4(),
                nonce: URL_SAFE_NO_PAD.encode([9u8; 32]),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native challenge required")
    };
    let stamp = InputStamp {
        epoch: Uuid::new_v4(),
        sequence: 1,
        instance_id: Uuid::new_v4(),
    };
    let token_hash = hash(b"synthetic-native-room-session");
    let request = signed_open(&challenge, stamp.epoch, token_hash.clone());
    let RuntimeResult::NativeOpened {
        connection,
        duplicate: false,
    } = store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::OpenNative {
                surface_id,
                audience: AUDIENCE.into(),
                request,
                incarnation: Uuid::new_v4(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native connection required")
    };
    let native = NativeProof {
        surface_id,
        incarnation: connection.incarnation,
        token_hash,
    };
    let browser = BrowserProof {
        surface_id: Uuid::new_v4(),
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"synthetic-browser-output"),
    };
    store
        .mutate_surface(
            PRINCIPAL,
            browser.surface_id,
            Mutation::Approve {
                incarnation: browser.incarnation,
                token_hash: browser.token_hash.clone(),
            },
        )
        .await
        .unwrap();
    store
        .mutate_surface(
            PRINCIPAL,
            browser.surface_id,
            Mutation::State {
                incarnation: browser.incarnation,
                token_hash: browser.token_hash.clone(),
                sequence: 1,
                visible: true,
            },
        )
        .await
        .unwrap();
    Fixture {
        runtime: Arc::new(runtime::AmbianceRuntime::new(store.clone(), model, None)),
        store,
        native,
        browser,
        stamp,
    }
}

#[tokio::test]
async fn native_room_browser_ack_allows_the_next_input_immediately() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let browser_epoch = Uuid::new_v4();
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::OpenBrowser {
                connection: fixture.browser.clone(),
                epoch: browser_epoch,
            },
        )
        .await
        .unwrap();
    let RuntimeResult::Proposed(first) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            fixture.stamp.clone(),
            CURRENT_TEXT.into(),
        )
        .await
        .unwrap()
    else {
        panic!("first output required")
    };
    let RuntimeResult::Pending(dispatched) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: fixture.browser.clone(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("browser dispatch required")
    };
    assert!(
        dispatched
            .iter()
            .any(|action| { action.id == first.id && action.status == ActionStatus::Dispatched })
    );
    let acknowledge = || RuntimeOperation::RoomControl {
        connection: RoomProof::Browser(fixture.browser.clone()),
        stamp: InputStamp {
            epoch: browser_epoch,
            sequence: 1,
            instance_id: first.id,
        },
        control: BrowserControl::Acknowledge {
            action_id: first.id,
            turn_id: first.turn_id,
            generation: first.generation,
            channel: first.channel,
            content_digest: first.content_digest.clone(),
        },
    };
    assert!(matches!(
        fixture
            .store
            .runtime(PRINCIPAL, acknowledge())
            .await
            .unwrap(),
        RuntimeResult::ControlAccepted { duplicate: false }
    ));
    assert!(matches!(
        fixture
            .store
            .runtime(PRINCIPAL, acknowledge())
            .await
            .unwrap(),
        RuntimeResult::ControlAccepted { duplicate: true }
    ));
    let RuntimeResult::Proposed(second) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            InputStamp {
                sequence: 2,
                instance_id: Uuid::new_v4(),
                ..fixture.stamp.clone()
            },
            "Tell me another public fact".into(),
        )
        .await
        .unwrap()
    else {
        panic!("acknowledged output must release the native turn immediately")
    };
    assert_ne!(second.turn_id, first.turn_id);
    assert_eq!(second.generation, first.generation + 1);
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture
            .store
            .assistant_private_accesses
            .load(Ordering::SeqCst),
        0
    );
}

#[test]
fn native_room_terminal_delivery_timeout_releases_the_turn_before_its_lease() {
    let enrollment_id = Uuid::new_v4();
    let surface_id = surface_registry::native_surface_id(PRINCIPAL, enrollment_id);
    let (native_record, _) = surface_registry::transition(
        None,
        0,
        surface_id,
        &crate::store::native_test_approval(enrollment_id, 0),
        100,
    )
    .unwrap();
    let browser = BrowserProof {
        surface_id: Uuid::new_v4(),
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"synthetic-browser-timeout"),
    };
    let (browser_record, _) = surface_registry::transition(
        None,
        0,
        browser.surface_id,
        &Mutation::Approve {
            incarnation: browser.incarnation,
            token_hash: browser.token_hash.clone(),
        },
        100,
    )
    .unwrap();
    let (browser_record, _) = surface_registry::transition(
        Some(&browser_record),
        1,
        browser.surface_id,
        &Mutation::State {
            incarnation: browser.incarnation,
            token_hash: browser.token_hash.clone(),
            sequence: 1,
            visible: true,
        },
        100,
    )
    .unwrap();
    let records = BTreeMap::from([
        (surface_id, native_record),
        (browser.surface_id, browser_record),
    ]);
    let mut state = RuntimeState::default();
    let (RuntimeResult::NativeChallenge(challenge), _) = state
        .apply(
            PRINCIPAL,
            &records,
            RuntimeOperation::NativeChallenge {
                surface_id,
                enrollment_id,
                audience: AUDIENCE.into(),
                challenge_id: Uuid::new_v4(),
                nonce: URL_SAFE_NO_PAD.encode([9u8; 32]),
            },
            100,
        )
        .unwrap()
    else {
        panic!("native challenge required")
    };
    let stamp = InputStamp {
        epoch: Uuid::new_v4(),
        sequence: 1,
        instance_id: Uuid::new_v4(),
    };
    let proof = NativeProof {
        surface_id,
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"synthetic-native-timeout"),
    };
    state
        .apply(
            PRINCIPAL,
            &records,
            RuntimeOperation::OpenNative {
                surface_id,
                audience: AUDIENCE.into(),
                request: signed_open(&challenge, stamp.epoch, proof.token_hash.clone()),
                incarnation: proof.incarnation,
            },
            101,
        )
        .unwrap();
    let input = |stamp: InputStamp| RuntimeOperation::Begin {
        turn_id: stamp.instance_id,
        worker: Uuid::new_v4(),
        origin: OriginProof::SequencedRoom {
            connection: RoomProof::Native(proof.clone()),
            stamp,
        },
        request_digest: hash(CURRENT_TEXT.as_bytes()),
        privacy_floor: PrivacyClass::SharedRoom,
    };
    let (RuntimeResult::Begun(first), _) = state
        .apply(PRINCIPAL, &records, input(stamp.clone()), 102)
        .unwrap()
    else {
        panic!("native turn required")
    };
    let (RuntimeResult::Proposed(action), _) = state
        .apply(
            PRINCIPAL,
            &records,
            RuntimeOperation::Propose {
                turn_id: first.turn_id,
                generation: first.generation,
                worker: first.worker,
                intent: SemanticIntent::VisualTextCard {
                    text: "A bounded public fact.".into(),
                },
                privacy: PrivacyClass::SharedRoom,
            },
            103,
        )
        .unwrap()
    else {
        panic!("browser output required")
    };
    let poll = || RuntimeOperation::Poll {
        connection: browser.clone(),
    };
    state.apply(PRINCIPAL, &records, poll(), 104).unwrap();
    let retry_at = state.actions[&action.id].deadline_ms;
    state
        .apply(PRINCIPAL, &records, RuntimeOperation::Sweep, retry_at)
        .unwrap();
    assert_eq!(state.actions[&action.id].status, ActionStatus::Proposed);
    assert!(!state.turn.as_ref().unwrap().finished);
    state.apply(PRINCIPAL, &records, poll(), retry_at).unwrap();
    assert_eq!(state.actions[&action.id].attempts, 2);
    let terminal_at = state.actions[&action.id].deadline_ms;
    let (_, events) = state
        .apply(PRINCIPAL, &records, RuntimeOperation::Sweep, terminal_at)
        .unwrap();
    assert_eq!(
        state.actions[&action.id].status,
        ActionStatus::OutcomeUnknown
    );
    assert!(state.actions[&action.id].intent.text().is_empty());
    let turn = state.turn.as_ref().unwrap();
    assert!(turn.finished && !turn.cancelled);
    assert!(terminal_at < turn.lease_until_ms);
    assert!(events.iter().any(|event| matches!(
        event,
        RuntimeData::TurnFinished { turn_id, generation }
            if *turn_id == first.turn_id && *generation == first.generation
    )));
    assert!(state.check_native(&records, &proof, terminal_at).is_ok());
    let (RuntimeResult::Begun(second), _) = state
        .apply(
            PRINCIPAL,
            &records,
            input(InputStamp {
                sequence: 2,
                instance_id: Uuid::new_v4(),
                ..stamp
            }),
            terminal_at,
        )
        .unwrap()
    else {
        panic!("terminal output must release the native turn immediately")
    };
    assert_eq!(second.generation, first.generation + 1);
    assert_ne!(second.turn_id, first.turn_id);
}

#[tokio::test]
async fn native_room_signed_origin_uses_current_text_shared_privacy_and_one_cognition() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let (started, admitted) = tokio::sync::oneshot::channel();
    let RuntimeResult::Proposed(action) = fixture
        .runtime
        .sequenced_room_text_started(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            fixture.stamp.clone(),
            CURRENT_TEXT.into(),
            Some(started),
        )
        .await
        .unwrap()
    else {
        panic!("approved browser output required")
    };
    let fence = admitted.await.unwrap();
    assert_eq!(fence.origin_surface, fixture.native.surface_id);
    assert_eq!(action.surface_id, fixture.browser.surface_id);
    assert_ne!(action.surface_id, fixture.native.surface_id);
    assert_eq!(action.privacy, PrivacyClass::SharedRoom);
    assert_eq!(action.channel, Channel::VisualCard);
    let RuntimeResult::Duplicate(duplicate) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            fixture.stamp.clone(),
            CURRENT_TEXT.into(),
        )
        .await
        .unwrap()
    else {
        panic!("same input must be a duplicate")
    };
    assert_eq!(duplicate.turn_id, fence.turn_id);
    assert_eq!(duplicate.worker, fence.worker);
    assert!(
        fixture
            .runtime
            .sequenced_room_text(
                PRINCIPAL,
                RoomProof::Native(fixture.native.clone()),
                fixture.stamp.clone(),
                "Changed current text".into(),
            )
            .await
            .is_err()
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *model.current_texts.lock().unwrap(),
        [CURRENT_TEXT.to_owned()]
    );
    assert_eq!(
        fixture
            .store
            .assistant_private_accesses
            .load(Ordering::SeqCst),
        0
    );
    let surface = fixture
        .store
        .surface(PRINCIPAL, fixture.native.surface_id)
        .await
        .unwrap()
        .unwrap();
    let native = surface.native_view().unwrap();
    assert_eq!(native.occupancy, "unknown");
    assert_eq!(native.actor_identity, "unknown");
    assert_eq!(native.trust_level, 0);
    assert!(!native.render_verified && !native.playback_verified);
}

#[tokio::test]
async fn native_room_cross_kind_and_private_requests_fail_before_cognition() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let browser_impersonation = BrowserProof {
        surface_id: fixture.native.surface_id,
        incarnation: fixture.native.incarnation,
        token_hash: fixture.native.token_hash.clone(),
    };
    let error = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Browser(browser_impersonation),
            fixture.stamp.clone(),
            CURRENT_TEXT.into(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::PermissionDenied);
    assert!(
        fixture
            .runtime
            .sequenced_room_text(
                "U:other",
                RoomProof::Native(fixture.native.clone()),
                fixture.stamp.clone(),
                CURRENT_TEXT.into(),
            )
            .await
            .is_err()
    );
    let error = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            fixture.stamp.clone(),
            "Read my notes".into(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .store
            .assistant_private_accesses
            .load(Ordering::SeqCst),
        0
    );
    let next = InputStamp {
        sequence: 2,
        instance_id: Uuid::new_v4(),
        ..fixture.stamp.clone()
    };
    assert!(matches!(
        fixture
            .runtime
            .sequenced_room_text(
                PRINCIPAL,
                RoomProof::Native(fixture.native.clone()),
                next,
                CURRENT_TEXT.into(),
            )
            .await
            .unwrap(),
        RuntimeResult::Proposed(_)
    ));
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *model.current_texts.lock().unwrap(),
        [CURRENT_TEXT.to_owned()]
    );
    assert_eq!(
        fixture
            .store
            .assistant_private_accesses
            .load(Ordering::SeqCst),
        0
    );
}

#[tokio::test]
async fn native_room_close_or_revocation_while_cognition_waits_fences_late_output() {
    for revoke in [false, true] {
        let gate = Arc::new(Gate::default());
        let model = Arc::new(SpyModel {
            gate: Some(gate.clone()),
            ..SpyModel::default()
        });
        let fixture = fixture(model.clone()).await;
        let runtime = fixture.runtime.clone();
        let proof = fixture.native.clone();
        let stamp = fixture.stamp.clone();
        let pending = tokio::spawn(async move {
            runtime
                .sequenced_room_text(
                    PRINCIPAL,
                    RoomProof::Native(proof),
                    stamp,
                    CURRENT_TEXT.into(),
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), gate.entered.notified())
            .await
            .unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        assert!(matches!(
            fixture
                .runtime
                .sequenced_room_text(
                    PRINCIPAL,
                    RoomProof::Native(fixture.native.clone()),
                    fixture.stamp.clone(),
                    CURRENT_TEXT.into(),
                )
                .await
                .unwrap(),
            RuntimeResult::Duplicate(_)
        ));
        if revoke {
            fixture
                .store
                .mutate_surface(
                    PRINCIPAL,
                    fixture.native.surface_id,
                    Mutation::RevokeNative {
                        expected_revision: 1,
                    },
                )
                .await
                .unwrap();
        } else {
            assert!(matches!(
                fixture
                    .store
                    .runtime(
                        PRINCIPAL,
                        RuntimeOperation::CloseNative {
                            connection: fixture.native.clone()
                        }
                    )
                    .await
                    .unwrap(),
                RuntimeResult::NativeClosed
            ));
        }
        gate.release.notify_one();
        let error = tokio::time::timeout(std::time::Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);
        assert!(
            fixture
                .store
                .runtime(
                    PRINCIPAL,
                    RuntimeOperation::CheckNative {
                        connection: fixture.native.clone()
                    }
                )
                .await
                .is_err()
        );
        assert!(
            fixture
                .runtime
                .sequenced_room_text(
                    PRINCIPAL,
                    RoomProof::Native(fixture.native.clone()),
                    fixture.stamp.clone(),
                    CURRENT_TEXT.into(),
                )
                .await
                .is_err()
        );
        let RuntimeResult::Pending(actions) = fixture
            .store
            .runtime(
                PRINCIPAL,
                RuntimeOperation::Poll {
                    connection: fixture.browser.clone(),
                },
            )
            .await
            .unwrap()
        else {
            panic!("browser projection required")
        };
        assert!(actions.is_empty());
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            fixture
                .store
                .assistant_private_accesses
                .load(Ordering::SeqCst),
            0
        );
    }
}

#[tokio::test]
async fn native_room_heartbeat_and_cancel_share_cursor_without_browser_authority() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let RuntimeResult::Proposed(first) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            fixture.stamp.clone(),
            CURRENT_TEXT.into(),
        )
        .await
        .unwrap()
    else {
        panic!("first output required")
    };
    let RuntimeResult::Pending(dispatched) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: fixture.browser.clone(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("browser dispatch required")
    };
    assert!(
        dispatched
            .iter()
            .any(|action| action.id == first.id && action.status == ActionStatus::Dispatched)
    );
    let heartbeat_stamp = InputStamp {
        sequence: 2,
        instance_id: Uuid::new_v4(),
        ..fixture.stamp.clone()
    };
    for control in [
        BrowserControl::State { visible: true },
        BrowserControl::Acknowledge {
            action_id: first.id,
            turn_id: first.turn_id,
            generation: first.generation,
            channel: first.channel,
            content_digest: first.content_digest.clone(),
        },
    ] {
        let instance_id = match &control {
            BrowserControl::Acknowledge { action_id, .. } => *action_id,
            _ => heartbeat_stamp.instance_id,
        };
        assert!(matches!(
            fixture
                .store
                .runtime(
                    PRINCIPAL,
                    RuntimeOperation::RoomControl {
                        connection: RoomProof::Native(fixture.native.clone()),
                        stamp: InputStamp {
                            instance_id,
                            ..heartbeat_stamp.clone()
                        },
                        control,
                    }
                )
                .await,
            Err(RuntimeError::InvalidOrigin)
        ));
    }
    let heartbeat = || RuntimeOperation::RoomControl {
        connection: RoomProof::Native(fixture.native.clone()),
        stamp: heartbeat_stamp.clone(),
        control: BrowserControl::Heartbeat,
    };
    assert!(matches!(
        fixture.store.runtime(PRINCIPAL, heartbeat()).await.unwrap(),
        RuntimeResult::ControlAccepted { duplicate: false }
    ));
    let RuntimeResult::NativeCurrent(after) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::CheckNative {
                connection: fixture.native.clone(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("current native connection required")
    };
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    assert!(matches!(
        fixture.store.runtime(PRINCIPAL, heartbeat()).await.unwrap(),
        RuntimeResult::ControlAccepted { duplicate: true }
    ));
    let RuntimeResult::NativeCurrent(retried) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::CheckNative {
                connection: fixture.native.clone(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("current native connection required")
    };
    assert_eq!(after.lease_expires_at_ms, retried.lease_expires_at_ms);
    assert!(
        fixture
            .runtime
            .sequenced_room_text(
                PRINCIPAL,
                RoomProof::Native(fixture.native.clone()),
                heartbeat_stamp,
                CURRENT_TEXT.into(),
            )
            .await
            .is_err()
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let cancel = || RuntimeOperation::RoomControl {
        connection: RoomProof::Native(fixture.native.clone()),
        stamp: InputStamp {
            sequence: 3,
            instance_id: first.turn_id,
            ..fixture.stamp.clone()
        },
        control: BrowserControl::Cancel {
            turn_id: first.turn_id,
            generation: first.generation,
        },
    };
    assert!(matches!(
        fixture.store.runtime(PRINCIPAL, cancel()).await.unwrap(),
        RuntimeResult::ControlAccepted { duplicate: false }
    ));
    let RuntimeResult::Pending(cancelled) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: fixture.browser.clone(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("browser cancellation projection required")
    };
    let cancelled = cancelled
        .iter()
        .find(|action| action.id == first.id)
        .unwrap();
    assert_eq!(cancelled.status, ActionStatus::Cancelled);
    assert!(cancelled.intent.text().is_empty());
    let next = InputStamp {
        sequence: 4,
        instance_id: Uuid::new_v4(),
        ..fixture.stamp.clone()
    };
    let RuntimeResult::Proposed(second) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            next,
            "Tell me another public fact".into(),
        )
        .await
        .unwrap()
    else {
        panic!("replacement output required")
    };
    assert!(matches!(
        fixture.store.runtime(PRINCIPAL, cancel()).await.unwrap(),
        RuntimeResult::ControlAccepted { duplicate: true }
    ));
    let RuntimeResult::Pending(actions) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: fixture.browser,
            },
        )
        .await
        .unwrap()
    else {
        panic!("browser projection required")
    };
    assert!(actions.iter().any(|action| action.id == second.id));
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture
            .store
            .assistant_private_accesses
            .load(Ordering::SeqCst),
        0
    );
}
