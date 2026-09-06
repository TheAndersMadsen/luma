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
    /// An explicit screen the synthetic request named, proposed as a target.
    target: Mutex<Option<&'static str>>,
    /// Propose a spoken reply instead of a card.
    speak: std::sync::atomic::AtomicBool,
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
        let kind = if self.speak.load(Ordering::SeqCst) {
            "informational_speech"
        } else {
            "visual_text_card"
        };
        let mut arguments = serde_json::json!({
            "intent":{"kind":kind,"text":"A bounded public fact."},
            "privacy":"public"
        });
        if let Some(target) = *self.target.lock().unwrap() {
            arguments["target"] = serde_json::json!(target);
        }
        Ok(ChatResponse {
            tool_call: Some(ToolCall {
                name: "propose_information".into(),
                arguments: arguments.to_string(),
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
                connection: RoomProof::Browser(fixture.browser.clone()),
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
                hint: None,
            },
            103,
        )
        .unwrap()
    else {
        panic!("browser output required")
    };
    let poll = || RuntimeOperation::Poll {
        connection: RoomProof::Browser(browser.clone()),
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
    // A private request with no personal surface declared for its class has
    // nowhere to appear: it is refused before cognition or any memory read.
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
                    connection: RoomProof::Browser(fixture.browser.clone()),
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
                connection: RoomProof::Browser(fixture.browser.clone()),
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
    // A native installation cannot acknowledge a card dispatched to another
    // surface; its own visibility report is not authority over that card.
    assert!(matches!(
        fixture
            .store
            .runtime(
                PRINCIPAL,
                RuntimeOperation::RoomControl {
                    connection: RoomProof::Native(fixture.native.clone()),
                    stamp: InputStamp {
                        instance_id: first.id,
                        ..heartbeat_stamp.clone()
                    },
                    control: BrowserControl::Acknowledge {
                        action_id: first.id,
                        turn_id: first.turn_id,
                        generation: first.generation,
                        channel: first.channel,
                        content_digest: first.content_digest.clone(),
                    },
                }
            )
            .await,
        Err(RuntimeError::Stale)
    ));
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
                connection: RoomProof::Browser(fixture.browser.clone()),
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
                connection: RoomProof::Browser(fixture.browser),
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
    // A native visibility report is admitted on the same cursor and stays on
    // the signed connection, never on the owner's registry record.
    assert!(matches!(
        fixture
            .store
            .runtime(
                PRINCIPAL,
                RuntimeOperation::RoomControl {
                    connection: RoomProof::Native(fixture.native.clone()),
                    stamp: InputStamp {
                        sequence: 5,
                        instance_id: Uuid::new_v4(),
                        ..fixture.stamp.clone()
                    },
                    control: BrowserControl::State { visible: true },
                }
            )
            .await,
        Ok(RuntimeResult::ControlAccepted { duplicate: false })
    ));
    assert!(
        fixture
            .store
            .surfaces(PRINCIPAL)
            .await
            .unwrap()
            .iter()
            .all(|surface| surface.surface_id != fixture.native.surface_id || !surface.visible),
        "native visibility lives on the connection, not the registry record"
    );
}

/// A visible native installation is a shared visual candidate. The request's
/// explicit target is weighed among eligible surfaces only: it routes a
/// browser request to the Mac, never revives a hidden installation, and the
/// installation acknowledges only the exact card dispatched to itself.
#[tokio::test]
async fn native_room_visible_installation_renders_hinted_cards_and_hidden_ones_never_do() {
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
    let browser_stamp = |sequence: u64, instance_id: Uuid| InputStamp {
        epoch: browser_epoch,
        sequence,
        instance_id,
    };
    // Hidden installation: the hint names it, but it is not an eligible candidate.
    *model.target.lock().unwrap() = Some("macos");
    let RuntimeResult::Proposed(first) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Browser(fixture.browser.clone()),
            browser_stamp(1, Uuid::new_v4()),
            "Show this on the Mac".into(),
        )
        .await
        .unwrap()
    else {
        panic!("first output required")
    };
    assert_eq!(first.surface_id, fixture.browser.surface_id);
    let RuntimeResult::Pending(native_pending) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(fixture.native.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native poll required")
    };
    assert!(native_pending.is_empty());
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::RoomControl {
                connection: RoomProof::Browser(fixture.browser.clone()),
                stamp: browser_stamp(2, first.turn_id),
                control: BrowserControl::Cancel {
                    turn_id: first.turn_id,
                    generation: first.generation,
                },
            },
        )
        .await
        .unwrap();
    // Visible installation: the same hint now leads over the origin browser.
    assert!(matches!(
        fixture
            .store
            .runtime(
                PRINCIPAL,
                RuntimeOperation::RoomControl {
                    connection: RoomProof::Native(fixture.native.clone()),
                    stamp: InputStamp {
                        sequence: 2,
                        instance_id: Uuid::new_v4(),
                        ..fixture.stamp.clone()
                    },
                    control: BrowserControl::State { visible: true },
                }
            )
            .await
            .unwrap(),
        RuntimeResult::ControlAccepted { duplicate: false }
    ));
    let RuntimeResult::Proposed(second) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Browser(fixture.browser.clone()),
            browser_stamp(3, Uuid::new_v4()),
            "Show this on the Mac".into(),
        )
        .await
        .unwrap()
    else {
        panic!("second output required")
    };
    assert_eq!(second.surface_id, fixture.native.surface_id);
    assert_eq!(second.incarnation, fixture.native.incarnation);
    assert_eq!(second.fallbacks, vec![fixture.browser.surface_id]);
    let decision = fixture
        .store
        .ambiance_ledger_events(PRINCIPAL)
        .await
        .into_iter()
        .filter_map(|event| match event {
            ledger::LedgerEvent::Runtime(event) => match event.data {
                RuntimeData::Decision {
                    turn_id,
                    hint,
                    candidates,
                    ..
                } if turn_id == second.turn_id => Some((hint, candidates)),
                _ => None,
            },
            _ => None,
        })
        .next_back()
        .expect("routing decision recorded");
    assert_eq!(decision.0, Some(policy::RoutingTarget::Macos));
    let hinted = decision
        .1
        .iter()
        .find(|candidate| candidate.surface_id == fixture.native.surface_id)
        .unwrap();
    assert_eq!((hinted.blocker, hinted.hint), (None, policy::HINT_WEIGHT));
    // The browser must not receive or acknowledge the Mac's card.
    let RuntimeResult::Pending(browser_pending) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Browser(fixture.browser.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("browser poll required")
    };
    assert!(!browser_pending.iter().any(|action| action.id == second.id));
    let RuntimeResult::Pending(dispatched) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(fixture.native.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native dispatch required")
    };
    assert!(
        dispatched
            .iter()
            .any(|action| { action.id == second.id && action.status == ActionStatus::Dispatched })
    );
    let acknowledge = |sequence: u64| RuntimeOperation::RoomControl {
        connection: RoomProof::Native(fixture.native.clone()),
        stamp: InputStamp {
            sequence,
            instance_id: second.id,
            ..fixture.stamp.clone()
        },
        control: BrowserControl::Acknowledge {
            action_id: second.id,
            turn_id: second.turn_id,
            generation: second.generation,
            channel: second.channel,
            content_digest: second.content_digest.clone(),
        },
    };
    assert!(matches!(
        fixture
            .store
            .runtime(PRINCIPAL, acknowledge(3))
            .await
            .unwrap(),
        RuntimeResult::ControlAccepted { duplicate: false }
    ));
    assert!(matches!(
        fixture
            .store
            .runtime(PRINCIPAL, acknowledge(3))
            .await
            .unwrap(),
        RuntimeResult::ControlAccepted { duplicate: true }
    ));
    // Losing the foreground revalidates the dispatched target: the shown card
    // is retired and the browser fallback receives its own new action.
    assert!(matches!(
        fixture
            .store
            .runtime(
                PRINCIPAL,
                RuntimeOperation::RoomControl {
                    connection: RoomProof::Native(fixture.native.clone()),
                    stamp: InputStamp {
                        sequence: 4,
                        instance_id: Uuid::new_v4(),
                        ..fixture.stamp.clone()
                    },
                    control: BrowserControl::State { visible: false },
                }
            )
            .await
            .unwrap(),
        RuntimeResult::ControlAccepted { duplicate: false }
    ));
    let RuntimeResult::Pending(after) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(fixture.native.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native poll required")
    };
    assert!(
        after
            .iter()
            .all(|action| action.status == ActionStatus::Cancelled)
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture
            .store
            .assistant_private_accesses
            .load(Ordering::SeqCst),
        0
    );
}

/// Speech reaches a native installation only through the origin owner's
/// provider disclosure: without it the same text becomes a card, a room poll
/// never stock-claims audio, the disclosure claims the exact action, and only
/// the native member's audio.tts acknowledgment completes the turn.
#[tokio::test]
async fn native_room_speech_routes_only_with_disclosure_and_is_acknowledged_after_playback() {
    let model = Arc::new(SpyModel::default());
    model.speak.store(true, Ordering::SeqCst);
    let fixture = fixture(model.clone()).await;
    let native_stamp = |sequence: u64, instance_id: Uuid| InputStamp {
        sequence,
        instance_id,
        ..fixture.stamp.clone()
    };
    let control =
        |sequence: u64, instance_id: Uuid, control: BrowserControl| RuntimeOperation::RoomControl {
            connection: RoomProof::Native(fixture.native.clone()),
            stamp: native_stamp(sequence, instance_id),
            control,
        };
    fixture
        .store
        .runtime(
            PRINCIPAL,
            control(1, Uuid::new_v4(), BrowserControl::State { visible: true }),
        )
        .await
        .unwrap();
    // No disclosure policy: the spoken proposal has no eligible surface and is
    // shown as the same text on the visible installation instead.
    let RuntimeResult::Proposed(card) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            native_stamp(2, Uuid::new_v4()),
            CURRENT_TEXT.into(),
        )
        .await
        .unwrap()
    else {
        panic!("card fallback required")
    };
    assert_eq!(card.channel, Channel::VisualCard);
    assert_eq!(card.surface_id, fixture.native.surface_id);
    assert_eq!(card.intent.text(), "A bounded public fact.");
    fixture
        .store
        .runtime(
            PRINCIPAL,
            control(
                3,
                card.turn_id,
                BrowserControl::Cancel {
                    turn_id: card.turn_id,
                    generation: card.generation,
                },
            ),
        )
        .await
        .unwrap();
    // The owner grants the origin's Azure Speech disclosure through the
    // common surface policy; the native surface is now a speech candidate.
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::SetDisclosurePolicy {
                surface_id: fixture.native.surface_id,
                approval_revision: 1,
                expected_revision: 0,
                policy: Some(disclosure::Policy {
                    provider: disclosure::Provider::AzureSpeech {
                        region: "westeurope".into(),
                    },
                    maximum_class: PrivacyClass::SharedRoom,
                    transcription: false,
                    synthesis: true,
                }),
            },
        )
        .await
        .unwrap();
    let RuntimeResult::Proposed(speech) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            native_stamp(4, Uuid::new_v4()),
            CURRENT_TEXT.into(),
        )
        .await
        .unwrap()
    else {
        panic!("spoken output required")
    };
    assert_eq!(speech.channel, Channel::AudioTts);
    assert_eq!(speech.surface_id, fixture.native.surface_id);
    assert_eq!(speech.origin_surface, fixture.native.surface_id);
    // A room poll reports the audio action but never stock-claims it.
    let RuntimeResult::Pending(pending) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(fixture.native.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native poll required")
    };
    assert_eq!(
        pending.iter().map(|a| (a.id, a.status)).collect::<Vec<_>>(),
        vec![(speech.id, ActionStatus::Proposed)]
    );
    // Playback cannot be acknowledged before the disclosure claims the action.
    let acknowledge = |sequence: u64| {
        control(
            sequence,
            speech.id,
            BrowserControl::Acknowledge {
                action_id: speech.id,
                turn_id: speech.turn_id,
                generation: speech.generation,
                channel: Channel::AudioTts,
                content_digest: speech.content_digest.clone(),
            },
        )
    };
    assert!(
        fixture
            .store
            .runtime(PRINCIPAL, acknowledge(5))
            .await
            .is_err()
    );
    let RuntimeResult::DisclosureStarted(_) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::StartDisclosure {
                fence: speech.fence(),
                request: disclosure::Request {
                    provider: disclosure::Provider::AzureSpeech {
                        region: "westeurope".into(),
                    },
                    purpose: disclosure::Purpose::Synthesis,
                    payload_digest: hash(b"synthetic synthesis payload"),
                    content_digest: speech.content_digest.clone(),
                    action_id: Some(speech.id),
                    privacy: speech.privacy,
                },
                id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("disclosure must claim the exact speech action")
    };
    let RuntimeResult::Pending(claimed) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(fixture.native.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native poll required")
    };
    assert_eq!(claimed[0].status, ActionStatus::Dispatched);
    assert_eq!(claimed[0].attempts, 1);
    // Only the exact native member acknowledges complete playback; the
    // browser is not this action's surface and the ledger finishes the turn.
    assert!(
        fixture
            .store
            .runtime(
                PRINCIPAL,
                RuntimeOperation::RoomControl {
                    connection: RoomProof::Browser(fixture.browser.clone()),
                    stamp: InputStamp {
                        epoch: Uuid::new_v4(),
                        sequence: 1,
                        instance_id: speech.id,
                    },
                    control: BrowserControl::Acknowledge {
                        action_id: speech.id,
                        turn_id: speech.turn_id,
                        generation: speech.generation,
                        channel: Channel::AudioTts,
                        content_digest: speech.content_digest.clone(),
                    },
                },
            )
            .await
            .is_err()
    );
    assert!(matches!(
        fixture
            .store
            .runtime(PRINCIPAL, acknowledge(6))
            .await
            .unwrap(),
        RuntimeResult::ControlAccepted { duplicate: false }
    ));
    let RuntimeResult::Pending(acknowledged) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(fixture.native.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native poll required")
    };
    assert_eq!(acknowledged[0].status, ActionStatus::Acknowledged);
    assert!(
        fixture
            .store
            .ambiance_ledger_events(PRINCIPAL)
            .await
            .into_iter()
            .any(|event| matches!(
                event,
                ledger::LedgerEvent::Runtime(event)
                    if matches!(event.data, RuntimeData::TurnFinished { turn_id, .. } if turn_id == speech.turn_id)
            ))
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
}

/// Approve and open a second native installation of the given platform in
/// the fixture's store; it joins with its own boot epoch and cursor.
async fn open_native(store: &Arc<MemoryStore>, platform: &str) -> (NativeProof, InputStamp) {
    let enrollment_id = Uuid::new_v4();
    let surface_id = surface_registry::native_surface_id(PRINCIPAL, enrollment_id);
    store
        .mutate_surface(
            PRINCIPAL,
            surface_id,
            Mutation::ApproveNative {
                enrollment_id,
                public_key: "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU".into(),
                platform: platform.into(),
                expected_revision: 0,
            },
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
                nonce: URL_SAFE_NO_PAD.encode([7u8; 32]),
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
    let token_hash = hash(format!("synthetic-{platform}-session").as_bytes());
    let request = signed_open(&challenge, stamp.epoch, token_hash.clone());
    let RuntimeResult::NativeOpened { connection, .. } = store
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
    (
        NativeProof {
            surface_id,
            incarnation: connection.incarnation,
            token_hash,
        },
        stamp,
    )
}

/// A private request from a shared origin is answered in the same turn from
/// the owner's notes inside the runtime (no cognition), and the reply can appear
/// only on the personal phone the owner declared: the Mac and a TV are
/// suppressed with privacy blockers, the card waits while the phone is not in
/// front, is dispatched only once its unlocked foreground reports visible,
/// and is retired the moment that foreground goes away. A TV can never hold
/// the permission, and without any personal surface the request is refused.
#[tokio::test]
async fn native_room_private_request_routes_only_to_the_owners_personal_surface() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let mac = fixture.native.clone();
    let mac_stamp = |sequence: u64, instance_id: Uuid| InputStamp {
        sequence,
        instance_id,
        ..fixture.stamp.clone()
    };
    let mac_control =
        |sequence: u64, instance_id: Uuid, control: BrowserControl| RuntimeOperation::RoomControl {
            connection: RoomProof::Native(mac.clone()),
            stamp: mac_stamp(sequence, instance_id),
            control,
        };
    fixture
        .store
        .runtime(
            PRINCIPAL,
            mac_control(1, Uuid::new_v4(), BrowserControl::State { visible: true }),
        )
        .await
        .unwrap();
    let (phone, phone_epoch) = open_native(&fixture.store, "android").await;
    let phone_stamp = |sequence: u64, instance_id: Uuid| InputStamp {
        sequence,
        instance_id,
        ..phone_epoch.clone()
    };
    let phone_control =
        |sequence: u64, instance_id: Uuid, control: BrowserControl| RuntimeOperation::RoomControl {
            connection: RoomProof::Native(phone.clone()),
            stamp: phone_stamp(sequence, instance_id),
            control,
        };
    let poll = |proof: NativeProof| {
        fixture.store.runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(proof),
            },
        )
    };
    let invitation = |proof: NativeProof| {
        fixture.store.runtime(
            PRINCIPAL,
            RuntimeOperation::Invitation {
                connection: RoomProof::Native(proof),
            },
        )
    };
    // No personal surface yet: the private request is refused before cognition.
    let error = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(mac.clone()),
            mac_stamp(2, Uuid::new_v4()),
            "Read my private notes".into(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    // The owner's statement lives on the phone only; a TV is refused.
    let (tv, _) = open_native(&fixture.store, "android_tv").await;
    let private = Some(personal::Policy {
        maximum_class: PrivacyClass::Private,
    });
    assert!(matches!(
        fixture
            .store
            .runtime(
                PRINCIPAL,
                RuntimeOperation::SetPrivatePolicy {
                    surface_id: tv.surface_id,
                    approval_revision: 1,
                    expected_revision: 0,
                    policy: private,
                },
            )
            .await,
        Err(RuntimeError::PolicyBlocked)
    ));
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::SetPrivatePolicy {
                surface_id: phone.surface_id,
                approval_revision: 1,
                expected_revision: 0,
                policy: private,
            },
        )
        .await
        .unwrap();
    // The Mac asks again. The reply is built inside the runtime from the
    // owner's notes, with no cognition and no provider, and proposed for the
    // phone, which is connected but not in front, so it waits.
    let RuntimeResult::Proposed(card) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(mac.clone()),
            mac_stamp(3, Uuid::new_v4()),
            "Read my private notes".into(),
        )
        .await
        .unwrap()
    else {
        panic!("private card required")
    };
    assert_eq!(card.surface_id, phone.surface_id);
    assert_eq!(card.origin_surface, mac.surface_id);
    assert_eq!(card.channel, Channel::VisualCard);
    assert_eq!(card.privacy, PrivacyClass::Private);
    assert_eq!(card.status, ActionStatus::Proposed);
    assert!(card.fallbacks.is_empty());
    assert!(card.intent.text().contains("private_canary"));
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .store
            .assistant_private_accesses
            .load(Ordering::SeqCst),
        1
    );
    let events = fixture.store.ambiance_ledger_events(PRINCIPAL).await;
    assert!(events.iter().any(|event| matches!(
        event,
        ledger::LedgerEvent::Runtime(event)
            if matches!(event.data, RuntimeData::PrivateContextOffered { count: 1, ref source, ref fence, .. }
                if source == "notes" && fence.turn_id == card.turn_id)
    )));
    let decision = events
        .iter()
        .filter_map(|event| match event {
            ledger::LedgerEvent::Runtime(event) => match &event.data {
                RuntimeData::Decision {
                    turn_id,
                    candidates,
                    privacy,
                    ..
                } if *turn_id == card.turn_id => Some((candidates.clone(), *privacy)),
                _ => None,
            },
            _ => None,
        })
        .next_back()
        .expect("private decision logged");
    assert_eq!(decision.1, PrivacyClass::Private);
    for candidate in &decision.0 {
        if candidate.surface_id == phone.surface_id && candidate.channel == Channel::VisualCard {
            assert_eq!(candidate.blocker, None);
        } else {
            assert_eq!(candidate.blocker, Some(policy::Blocker::Privacy));
        }
    }
    // Only the phone is told that something waits; the Mac polls nothing and
    // the phone's poll does not dispatch until its foreground is reported.
    let RuntimeResult::Invitation(Some(waiting)) = invitation(phone.clone()).await.unwrap() else {
        panic!("phone invitation required")
    };
    assert_eq!(waiting.id, card.id);
    assert_eq!(waiting.origin_surface, mac.surface_id);
    assert_eq!(waiting.privacy, PrivacyClass::Private);
    assert_eq!(waiting.expires_at_ms, card.display_expires_at_ms);
    assert!(matches!(
        invitation(mac.clone()).await.unwrap(),
        RuntimeResult::Invitation(None)
    ));
    let RuntimeResult::Pending(mac_pending) = poll(mac.clone()).await.unwrap() else {
        panic!("mac poll required")
    };
    assert!(mac_pending.is_empty());
    let RuntimeResult::Pending(waiting_pending) = poll(phone.clone()).await.unwrap() else {
        panic!("phone poll required")
    };
    assert_eq!(
        waiting_pending
            .iter()
            .map(|a| (a.id, a.status))
            .collect::<Vec<_>>(),
        vec![(card.id, ActionStatus::Proposed)]
    );
    // The owner unlocks the phone and opens Cosmos: the card is dispatched,
    // acknowledged, and the offer is withdrawn.
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(1, Uuid::new_v4(), BrowserControl::State { visible: true }),
        )
        .await
        .unwrap();
    let RuntimeResult::Pending(dispatched) = poll(phone.clone()).await.unwrap() else {
        panic!("phone poll required")
    };
    assert_eq!(
        dispatched
            .iter()
            .map(|a| (a.id, a.status, a.privacy))
            .collect::<Vec<_>>(),
        vec![(card.id, ActionStatus::Dispatched, PrivacyClass::Private)]
    );
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(
                2,
                card.id,
                BrowserControl::Acknowledge {
                    action_id: card.id,
                    turn_id: card.turn_id,
                    generation: card.generation,
                    channel: Channel::VisualCard,
                    content_digest: card.content_digest.clone(),
                },
            ),
        )
        .await
        .unwrap();
    assert!(matches!(
        invitation(phone.clone()).await.unwrap(),
        RuntimeResult::Invitation(None)
    ));
    // The phone leaving the foreground retires the private card.
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(3, Uuid::new_v4(), BrowserControl::State { visible: false }),
        )
        .await
        .unwrap();
    let RuntimeResult::Pending(after) = poll(phone.clone()).await.unwrap() else {
        panic!("phone poll required")
    };
    assert!(after.iter().all(|a| a.status == ActionStatus::Cancelled));
    let RuntimeResult::Pending(mac_after) = poll(mac.clone()).await.unwrap() else {
        panic!("mac poll required")
    };
    assert!(mac_after.is_empty());
}
