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
    system_prompts: Mutex<Vec<String>>,
    gate: Option<Arc<Gate>>,
    /// An explicit screen the synthetic request named, proposed as a target.
    target: Mutex<Option<&'static str>>,
    /// Propose a spoken reply instead of a card.
    speak: std::sync::atomic::AtomicBool,
    /// A complete proposal to return instead of the default card.
    proposal: Mutex<Option<serde_json::Value>>,
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
        self.system_prompts
            .lock()
            .unwrap()
            .push(messages[0].content.clone());
        if let Some(gate) = &self.gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        let kind = if self.speak.load(Ordering::SeqCst) {
            "informational_speech"
        } else {
            "visual_text_card"
        };
        let mut arguments = self.proposal.lock().unwrap().clone().unwrap_or_else(|| {
            serde_json::json!({
                "intent":{"kind":kind,"text":"A bounded public fact."},
                "privacy":"public"
            })
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
    state
        .apply(PRINCIPAL, &records, RuntimeOperation::Sweep, terminal_at)
        .unwrap();
    assert_eq!(
        state.actions[&action.id].status,
        ActionStatus::OutcomeUnknown
    );
    assert!(state.actions[&action.id].intent.text().is_empty());
    // The origin installation was the logged fallback all along: it is
    // connected, it just is not in front of anyone, so the card is held for
    // it rather than the turn ending with the answer nowhere.
    let repaired = state
        .actions
        .values()
        .find(|a| a.id != action.id)
        .expect("the logged fallback receives its own action")
        .clone();
    assert_eq!(repaired.surface_id, surface_id);
    assert_eq!(repaired.status, ActionStatus::Proposed);
    assert_eq!(repaired.deadline_ms, terminal_at + ATTENDED_WAIT_MS);
    assert!(!state.turn.as_ref().unwrap().finished);
    // Nobody comes to it either, and only then is the turn released — still
    // inside the worker lease.
    let terminal_at = repaired.deadline_ms;
    let (_, events) = state
        .apply(PRINCIPAL, &records, RuntimeOperation::Sweep, terminal_at)
        .unwrap();
    assert_eq!(state.actions[&repaired.id].status, ActionStatus::Cancelled);
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
        .sequenced_room_input_started(
            PRINCIPAL,
            RoomProof::Native(fixture.native.clone()),
            fixture.stamp.clone(),
            runtime::RoomInput::text(CURRENT_TEXT.into()),
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

/// A connected native installation is a shared visual candidate whether or
/// not its app is in front of anyone. The request's explicit target is
/// weighed among eligible surfaces only: it routes a browser request to the
/// Mac, the Mac holds the card until its own foreground reports rather than
/// receiving it in the background, and the installation acknowledges only
/// the exact card dispatched to itself.
#[tokio::test]
async fn native_room_hinted_cards_are_held_for_the_mac_and_delivered_when_it_comes_forward() {
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
    // The Mac is connected but its app is not in front of anyone. The owner
    // named it, so it leads and holds the card; nothing is handed over.
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
    assert_eq!(first.surface_id, fixture.native.surface_id);
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
    // The card is on the Mac and is not handed over: a poll from an app
    // nobody is in front of sees it waiting, never dispatched.
    assert!(
        native_pending
            .iter()
            .all(|action| { action.id == first.id && action.status == ActionStatus::Proposed })
    );
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
    // Once it reports its foreground, the same hint leads and the card is
    // dispatched to it rather than to the origin browser.
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

/// The request's own explicit destination carries exactly the weight of the
/// model's target and outranks it: a browser request naming the Mac reaches
/// the visible installation even when the model nominates the browser, the
/// decision logs the client's target, an identical retry is a duplicate and
/// a retry that changes only the target is refused.
#[tokio::test]
async fn native_room_explicit_target_outranks_the_model_and_binds_exact_retries() {
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
            },
        )
        .await
        .unwrap();
    *model.target.lock().unwrap() = Some("browser");
    let browser_stamp = |sequence: u64, instance_id: Uuid| InputStamp {
        epoch: browser_epoch,
        sequence,
        instance_id,
    };
    let input = |target: Option<policy::RoutingTarget>| runtime::RoomInput {
        text: "Show this on the Mac".into(),
        target,
        context: None,
        spoken: None,
    };
    let first_stamp = browser_stamp(1, Uuid::new_v4());
    let RuntimeResult::Proposed(first) = fixture
        .runtime
        .sequenced_room_input_started(
            PRINCIPAL,
            RoomProof::Browser(fixture.browser.clone()),
            first_stamp.clone(),
            input(Some(policy::RoutingTarget::Macos)),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("hinted output required")
    };
    assert_eq!(first.surface_id, fixture.native.surface_id);
    let decision = fixture
        .store
        .ambiance_ledger_events(PRINCIPAL)
        .await
        .into_iter()
        .filter_map(|event| match event {
            ledger::LedgerEvent::Runtime(event) => match event.data {
                RuntimeData::Decision { turn_id, hint, .. } if turn_id == first.turn_id => {
                    Some(hint)
                }
                _ => None,
            },
            _ => None,
        })
        .next_back()
        .expect("routing decision recorded");
    assert_eq!(decision, Some(policy::RoutingTarget::Macos));
    assert!(matches!(
        fixture
            .runtime
            .sequenced_room_input_started(
                PRINCIPAL,
                RoomProof::Browser(fixture.browser.clone()),
                first_stamp.clone(),
                input(Some(policy::RoutingTarget::Macos)),
                None,
            )
            .await
            .unwrap(),
        RuntimeResult::Duplicate(_)
    ));
    assert!(
        fixture
            .runtime
            .sequenced_room_input_started(
                PRINCIPAL,
                RoomProof::Browser(fixture.browser.clone()),
                first_stamp,
                input(None),
                None,
            )
            .await
            .is_err(),
        "the same sequence with another target is not the same request"
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
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
    // Without the client's target the model's self-nomination earns nothing
    // and the origin browser keeps its own card.
    let RuntimeResult::Proposed(second) = fixture
        .runtime
        .sequenced_room_input_started(
            PRINCIPAL,
            RoomProof::Browser(fixture.browser.clone()),
            browser_stamp(3, Uuid::new_v4()),
            input(None),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("second output required")
    };
    assert_eq!(second.surface_id, fixture.browser.surface_id);
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
}

/// Screen context is the owner's own data. Without the origin's permission
/// the text goes nowhere and a personal surface says so; with it cognition
/// receives the text as a delimited untrusted block after the request, the
/// turn is private, the reply can appear only on a personal surface, every
/// shared surface is suppressed with a privacy blocker and the ledger records
/// the offer content-free. Sensitive screen text is refused before cognition.
#[tokio::test]
async fn native_room_screen_context_reaches_cognition_only_under_the_owners_permission() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let mac = fixture.native.clone();
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::RoomControl {
                connection: RoomProof::Native(mac.clone()),
                stamp: InputStamp {
                    sequence: 2,
                    instance_id: Uuid::new_v4(),
                    ..fixture.stamp.clone()
                },
                control: BrowserControl::State { visible: true },
            },
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
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::SetPrivatePolicy {
                surface_id: phone.surface_id,
                approval_revision: 1,
                expected_revision: 0,
                policy: Some(personal::Policy {
                    maximum_class: PrivacyClass::Private,
                }),
            },
        )
        .await
        .unwrap();
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(1, Uuid::new_v4(), BrowserControl::State { visible: true }),
        )
        .await
        .unwrap();
    let context = screen::ScreenContext::new("Settings".into(), "Wi-Fi\nConnected to Home".into());
    let ask = |text: &str, context: screen::ScreenContext| runtime::RoomInput {
        text: text.into(),
        target: None,
        context: Some(context),
        spoken: None,
    };
    // No permission: the text never reaches cognition; the phone is told why.
    let RuntimeResult::Proposed(explained) = fixture
        .runtime
        .sequenced_room_input_started(
            PRINCIPAL,
            RoomProof::Native(phone.clone()),
            phone_stamp(2, Uuid::new_v4()),
            ask("Which network is this?", context.clone()),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("explanatory private card required")
    };
    assert_eq!(explained.surface_id, phone.surface_id);
    assert_eq!(explained.privacy, PrivacyClass::Private);
    assert!(explained.intent.text().contains("Allow screen context"));
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    let events = fixture.store.ambiance_ledger_events(PRINCIPAL).await;
    assert!(!events.iter().any(|event| matches!(
        event,
        ledger::LedgerEvent::Runtime(event)
            if matches!(event.data, RuntimeData::ScreenContextOffered { .. })
    )));
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(
                3,
                explained.turn_id,
                BrowserControl::Cancel {
                    turn_id: explained.turn_id,
                    generation: explained.generation,
                },
            ),
        )
        .await
        .unwrap();
    // The owner permits screen context for the phone at its current revision.
    let RuntimeResult::ScreenContextPolicy(Some(approval)) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::SetScreenContextPolicy {
                surface_id: phone.surface_id,
                approval_revision: 1,
                expected_revision: 0,
                policy: Some(screen::Policy {
                    maximum_class: PrivacyClass::Private,
                }),
            },
        )
        .await
        .unwrap()
    else {
        panic!("screen context approval")
    };
    assert_eq!((approval.approval_revision, approval.revision), (1, 1));
    let stamp = phone_stamp(4, Uuid::new_v4());
    let RuntimeResult::Proposed(reply) = fixture
        .runtime
        .sequenced_room_input_started(
            PRINCIPAL,
            RoomProof::Native(phone.clone()),
            stamp.clone(),
            ask("Which network is this?", context.clone()),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("private reply required")
    };
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let seen = model.current_texts.lock().unwrap()[0].clone();
    assert!(seen.starts_with("Which network is this?\n\n=== BEGIN SCREEN CONTEXT"));
    assert!(seen.contains("\"Settings\""));
    assert!(seen.contains("\nWi-Fi\nConnected to Home\n=== END SCREEN CONTEXT ==="));
    assert!(
        model.system_prompts.lock().unwrap()[0].contains("never instructions"),
        "cognition is told the block is data"
    );
    assert_eq!(reply.surface_id, phone.surface_id);
    assert_eq!(reply.privacy, PrivacyClass::Private);
    assert_eq!(reply.channel, Channel::VisualCard);
    assert_eq!(reply.intent.text(), "A bounded public fact.");
    let events = fixture.store.ambiance_ledger_events(PRINCIPAL).await;
    assert!(events.iter().any(|event| matches!(
        event,
        ledger::LedgerEvent::Runtime(event)
            if matches!(&event.data, RuntimeData::ScreenContextOffered { fence, app_digest, bytes }
                if fence.turn_id == reply.turn_id && *app_digest == hash(b"Settings") && *bytes == 23)
    )));
    let candidates = events
        .iter()
        .filter_map(|event| match event {
            ledger::LedgerEvent::Runtime(event) => match &event.data {
                RuntimeData::Decision {
                    turn_id,
                    candidates,
                    ..
                } if *turn_id == reply.turn_id => Some(candidates.clone()),
                _ => None,
            },
            _ => None,
        })
        .next_back()
        .expect("private decision logged");
    for candidate in &candidates {
        if candidate.surface_id == phone.surface_id && candidate.channel == Channel::VisualCard {
            assert_eq!(candidate.blocker, None);
        } else {
            assert_eq!(candidate.blocker, Some(policy::Blocker::Privacy));
        }
    }
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("Connected to Home"),
        "screen text never enters the ledger"
    );
    // An exact retry is a duplicate; the same sequence with other screen text
    // is not the same request.
    assert!(matches!(
        fixture
            .runtime
            .sequenced_room_input_started(
                PRINCIPAL,
                RoomProof::Native(phone.clone()),
                stamp.clone(),
                ask("Which network is this?", context),
                None,
            )
            .await
            .unwrap(),
        RuntimeResult::Duplicate(_)
    ));
    assert!(
        fixture
            .runtime
            .sequenced_room_input_started(
                PRINCIPAL,
                RoomProof::Native(phone.clone()),
                stamp,
                ask(
                    "Which network is this?",
                    screen::ScreenContext::new("Settings".into(), "Bluetooth".into())
                ),
                None,
            )
            .await
            .is_err()
    );
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(
                5,
                reply.turn_id,
                BrowserControl::Cancel {
                    turn_id: reply.turn_id,
                    generation: reply.generation,
                },
            ),
        )
        .await
        .unwrap();
    // Sensitive screen text has no display ceiling: refused before cognition.
    let error = fixture
        .runtime
        .sequenced_room_input_started(
            PRINCIPAL,
            RoomProof::Native(phone.clone()),
            phone_stamp(6, Uuid::new_v4()),
            ask(
                "What is this?",
                screen::ScreenContext::new("Bank".into(), "Password: hunter2".into()),
            ),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    // Over-long context is rejected before admission.
    let error = fixture
        .runtime
        .sequenced_room_input_started(
            PRINCIPAL,
            RoomProof::Native(phone.clone()),
            phone_stamp(7, Uuid::new_v4()),
            ask(
                "What is this?",
                screen::ScreenContext::new("App".into(), "x".repeat(screen::MAX_TEXT_BYTES + 1)),
            ),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::InvalidArgument);
    // The Mac, a shared surface, cannot hold the permission's benefit: its
    // screen text with no permission of its own is explained on the phone.
    let RuntimeResult::Proposed(from_mac) = fixture
        .runtime
        .sequenced_room_input_started(
            PRINCIPAL,
            RoomProof::Native(mac.clone()),
            InputStamp {
                sequence: 3,
                instance_id: Uuid::new_v4(),
                ..fixture.stamp.clone()
            },
            ask(
                "What is this window?",
                screen::ScreenContext::new("Finder".into(), "Documents".into()),
            ),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("explanatory private card required")
    };
    assert_eq!(from_mac.surface_id, phone.surface_id);
    assert_eq!(from_mac.privacy, PrivacyClass::Private);
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .store
            .assistant_private_accesses
            .load(Ordering::SeqCst),
        0,
        "screen context never reads private memory"
    );
}

/// "Find a good film for tonight" on the TV: cognition proposes a numbered
/// choice list, the runtime numbers it, the TV renders and acknowledges the
/// exact digest, the acknowledged list becomes bounded recent context, and
/// the next turn is offered the numbered items so "number two" resolves.
#[tokio::test]
async fn native_room_choice_list_is_shown_remembered_and_offered_to_the_next_turn() {
    let model = Arc::new(SpyModel::default());
    *model.proposal.lock().unwrap() = Some(serde_json::json!({
        "choice_list": {"title": "Films for tonight", "items": [
            {"title": "Arrival", "detail": "2016 science fiction"},
            {"title": "Heat", "detail": "1995 crime drama"},
        ]},
        "privacy": "public",
        "target": "android_tv",
    }));
    let fixture = fixture(model.clone()).await;
    let mac = fixture.native.clone();
    let mac_stamp = |sequence: u64, instance_id: Uuid| InputStamp {
        sequence,
        instance_id,
        ..fixture.stamp.clone()
    };
    let (tv, tv_epoch) = open_native(&fixture.store, "android_tv").await;
    let tv_control =
        |sequence: u64, instance_id: Uuid, control: BrowserControl| RuntimeOperation::RoomControl {
            connection: RoomProof::Native(tv.clone()),
            stamp: InputStamp {
                sequence,
                instance_id,
                ..tv_epoch.clone()
            },
            control,
        };
    fixture
        .store
        .runtime(
            PRINCIPAL,
            tv_control(1, Uuid::new_v4(), BrowserControl::State { visible: true }),
        )
        .await
        .unwrap();
    let RuntimeResult::Proposed(list) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(mac.clone()),
            mac_stamp(2, Uuid::new_v4()),
            "Find a good film for tonight".into(),
        )
        .await
        .unwrap()
    else {
        panic!("choice list required")
    };
    assert_eq!(list.surface_id, tv.surface_id);
    assert_eq!(list.channel, Channel::VisualCard);
    assert_eq!(list.privacy, PrivacyClass::SharedRoom);
    let SemanticIntent::ChoiceList { title, items } = &list.intent else {
        panic!("choice list intent")
    };
    assert_eq!(title, "Films for tonight");
    assert_eq!(
        items
            .iter()
            .map(|item| (item.id.as_str(), item.title.as_str()))
            .collect::<Vec<_>>(),
        vec![("1", "Arrival"), ("2", "Heat")]
    );
    let expected_digest = hash(
        serde_json::json!([
            "cosmos.choice-list",
            1,
            "Films for tonight",
            [
                ["1", "Arrival", "2016 science fiction"],
                ["2", "Heat", "1995 crime drama"]
            ]
        ])
        .to_string()
        .as_bytes(),
    );
    assert_eq!(list.content_digest, expected_digest);
    let command = crate::browser_runtime_api::command(&list, None).unwrap();
    assert_eq!(
        command["content"],
        serde_json::json!({"kind": "choices", "title": "Films for tonight", "items": [
            {"id": "1", "title": "Arrival", "detail": "2016 science fiction"},
            {"id": "2", "title": "Heat", "detail": "1995 crime drama"},
        ]})
    );
    assert_eq!(command["contentDigest"], expected_digest);
    let RuntimeResult::Pending(dispatched) = fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(tv.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("tv poll required")
    };
    assert_eq!(dispatched[0].status, ActionStatus::Dispatched);
    assert!(matches!(
        fixture
            .store
            .runtime(
                PRINCIPAL,
                tv_control(
                    2,
                    list.id,
                    BrowserControl::Acknowledge {
                        action_id: list.id,
                        turn_id: list.turn_id,
                        generation: list.generation,
                        channel: Channel::VisualCard,
                        content_digest: list.content_digest.clone(),
                    },
                ),
            )
            .await
            .unwrap(),
        RuntimeResult::ControlAccepted { duplicate: false }
    ));
    let events = fixture.store.ambiance_ledger_events(PRINCIPAL).await;
    assert!(events.iter().any(|event| matches!(
        event,
        ledger::LedgerEvent::Runtime(event)
            if matches!(event.data, RuntimeData::RecentContextRemembered {
                context: RecentContextKind::Choices, source_surface, privacy: PrivacyClass::SharedRoom, ..
            } if source_surface == tv.surface_id)
    )));
    // The follow-up from the Mac: cognition is offered the numbered items and
    // asks for the trailer; without a web permission the runtime explains
    // that instead of inventing a result, and nothing is played.
    *model.proposal.lock().unwrap() = Some(serde_json::json!({
        "web_lookup": {"query": "Heat trailer"},
        "privacy": "public",
    }));
    let RuntimeResult::Proposed(follow_up) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(mac.clone()),
            mac_stamp(3, Uuid::new_v4()),
            "Play trailer for number two".into(),
        )
        .await
        .unwrap()
    else {
        panic!("follow-up output required")
    };
    let prompt = model.system_prompts.lock().unwrap()[1].clone();
    assert!(prompt.contains(
        "a numbered choice list \"Films for tonight: 1. Arrival; 2. Heat\" was shown on the TV"
    ));
    assert!(prompt.contains("number two") && prompt.contains("trailer"));
    assert!(
        follow_up
            .intent
            .text()
            .contains("Web lookup is not enabled")
    );
    assert!(events.iter().any(|event| matches!(
        event,
        ledger::LedgerEvent::Runtime(event)
            if matches!(event.data, RuntimeData::RecentContextOffered { context: RecentContextKind::Choices, .. })
    )) || fixture
        .store
        .ambiance_ledger_events(PRINCIPAL)
        .await
        .iter()
        .any(|event| matches!(
            event,
            ledger::LedgerEvent::Runtime(event)
                if matches!(event.data, RuntimeData::RecentContextOffered { context: RecentContextKind::Choices, .. })
        )));
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
}

/// The origin's status frames follow committed outcomes: waiting while the
/// card is proposed or dispatched elsewhere, shown once acknowledged there,
/// nowhere when nothing could take it. A privacy-refused request and a
/// request with no visible screen end identically for a shared origin, and
/// a private card shown on the phone reports only "shown" on an android
/// surface at the shared class.
#[tokio::test]
async fn native_room_origin_status_reports_committed_outcomes_without_reasons() {
    use status::{TurnState, TurnStatus};
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let mac = fixture.native.clone();
    let mac_stamp = |sequence: u64, instance_id: Uuid| InputStamp {
        sequence,
        instance_id,
        ..fixture.stamp.clone()
    };
    let status = |proof: RoomProof| async {
        let RuntimeResult::TurnStatus(status) = fixture
            .store
            .runtime(
                PRINCIPAL,
                RuntimeOperation::TurnStatus { connection: proof },
            )
            .await
            .unwrap()
        else {
            panic!("turn status")
        };
        status
    };
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
    assert_eq!(status(RoomProof::Native(mac.clone())).await, None);
    let RuntimeResult::Proposed(card) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(mac.clone()),
            mac_stamp(1, Uuid::new_v4()),
            CURRENT_TEXT.into(),
        )
        .await
        .unwrap()
    else {
        panic!("browser card required")
    };
    assert_eq!(card.surface_id, fixture.browser.surface_id);
    let expect = |state: TurnState, surface: Option<Uuid>| TurnStatus {
        turn_id: card.turn_id,
        generation: card.generation,
        state,
        surface,
        privacy: PrivacyClass::SharedRoom,
    };
    assert_eq!(
        status(RoomProof::Native(mac.clone())).await,
        Some(expect(TurnState::Waiting, Some(fixture.browser.surface_id)))
    );
    assert_eq!(
        status(RoomProof::Browser(fixture.browser.clone())).await,
        None,
        "the lead surface is not the origin"
    );
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Browser(fixture.browser.clone()),
            },
        )
        .await
        .unwrap();
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::RoomControl {
                connection: RoomProof::Browser(fixture.browser.clone()),
                stamp: InputStamp {
                    epoch: browser_epoch,
                    sequence: 1,
                    instance_id: card.id,
                },
                control: BrowserControl::Acknowledge {
                    action_id: card.id,
                    turn_id: card.turn_id,
                    generation: card.generation,
                    channel: card.channel,
                    content_digest: card.content_digest.clone(),
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        status(RoomProof::Native(mac.clone())).await,
        Some(expect(TurnState::Shown, Some(fixture.browser.surface_id)))
    );
    // A private request with nowhere to go and a public request with no
    // visible screen are indistinguishable to the shared origin.
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
    let refused = status(RoomProof::Native(mac.clone())).await.unwrap();
    assert_eq!(
        (refused.state, refused.surface, refused.privacy),
        (TurnState::Nowhere, None, PrivacyClass::SharedRoom)
    );
    // A page nobody is looking at is still a page: the same public request
    // is held for it rather than refused, and the origin is told a card is
    // waiting on a device kind, never which one or why.
    fixture
        .store
        .mutate_surface(
            PRINCIPAL,
            fixture.browser.surface_id,
            Mutation::State {
                incarnation: fixture.browser.incarnation,
                token_hash: fixture.browser.token_hash.clone(),
                sequence: 2,
                visible: false,
            },
        )
        .await
        .unwrap();
    let RuntimeResult::Proposed(held) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(mac.clone()),
            mac_stamp(3, Uuid::new_v4()),
            CURRENT_TEXT.into(),
        )
        .await
        .unwrap()
    else {
        panic!("a screen nobody is in front of is still a screen")
    };
    let waiting = status(RoomProof::Native(mac.clone())).await.unwrap();
    assert_eq!(
        (waiting.state, waiting.privacy),
        (TurnState::Waiting, PrivacyClass::SharedRoom)
    );
    assert_eq!(waiting.surface, Some(held.surface_id));
    assert_ne!(waiting.turn_id, refused.turn_id);
    // A shared answer now has somewhere to go whenever the asking device can
    // show one, so `Nowhere` is reserved for a genuine refusal, and every
    // refusal reads the same: no state, no surface, no reason.
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::RoomControl {
                connection: RoomProof::Native(mac.clone()),
                stamp: mac_stamp(4, held.turn_id),
                control: BrowserControl::Cancel {
                    turn_id: held.turn_id,
                    generation: held.generation,
                },
            },
        )
        .await
        .unwrap();
    // A private reply on the phone: the Mac learns "shown on an android
    // surface" at the shared class and nothing about the card's own class.
    let (phone, phone_epoch) = open_native(&fixture.store, "android").await;
    let phone_control =
        |sequence: u64, instance_id: Uuid, control: BrowserControl| RuntimeOperation::RoomControl {
            connection: RoomProof::Native(phone.clone()),
            stamp: InputStamp {
                sequence,
                instance_id,
                ..phone_epoch.clone()
            },
            control,
        };
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::SetPrivatePolicy {
                surface_id: phone.surface_id,
                approval_revision: 1,
                expected_revision: 0,
                policy: Some(personal::Policy {
                    maximum_class: PrivacyClass::Private,
                }),
            },
        )
        .await
        .unwrap();
    let RuntimeResult::Proposed(private) = fixture
        .runtime
        .sequenced_room_text(
            PRINCIPAL,
            RoomProof::Native(mac.clone()),
            mac_stamp(5, Uuid::new_v4()),
            "Read my private notes".into(),
        )
        .await
        .unwrap()
    else {
        panic!("private card required")
    };
    assert_eq!(private.privacy, PrivacyClass::Private);
    let waiting = status(RoomProof::Native(mac.clone())).await.unwrap();
    assert_eq!(
        (waiting.state, waiting.surface, waiting.privacy),
        (
            TurnState::Waiting,
            Some(phone.surface_id),
            PrivacyClass::SharedRoom
        )
    );
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(1, Uuid::new_v4(), BrowserControl::State { visible: true }),
        )
        .await
        .unwrap();
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::Poll {
                connection: RoomProof::Native(phone.clone()),
            },
        )
        .await
        .unwrap();
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(
                2,
                private.id,
                BrowserControl::Acknowledge {
                    action_id: private.id,
                    turn_id: private.turn_id,
                    generation: private.generation,
                    channel: Channel::VisualCard,
                    content_digest: private.content_digest.clone(),
                },
            ),
        )
        .await
        .unwrap();
    let shown = status(RoomProof::Native(mac.clone())).await.unwrap();
    assert_eq!(
        (shown.state, shown.surface, shown.privacy),
        (
            TurnState::Shown,
            Some(phone.surface_id),
            PrivacyClass::SharedRoom
        )
    );
    // The phone leaving the foreground retires the card; the committed
    // outcome stands and the phone, not the origin, has no status.
    fixture
        .store
        .runtime(
            PRINCIPAL,
            phone_control(3, Uuid::new_v4(), BrowserControl::State { visible: false }),
        )
        .await
        .unwrap();
    assert_eq!(
        status(RoomProof::Native(mac.clone())).await.unwrap().state,
        TurnState::Shown
    );
    assert_eq!(status(RoomProof::Native(phone.clone())).await, None);
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
}

/// One synthetic push-to-talk capture: the bytes a client would have recorded
/// while it showed that it was recording, and what it attests about them.
fn synthetic_capture(
    samples: u32,
    policy_revision: u64,
    source_floor: PrivacyClass,
) -> native_voice::Capture {
    native_voice::Capture {
        attestation: native_voice::REQUIRED_ATTESTATION.to_vec(),
        capture_ms: i64::from(samples) * 1000 / i64::from(native_voice::SAMPLE_RATE) + 1,
        samples,
        audio_digest: hash(&samples.to_be_bytes()),
        policy_revision,
        source_floor,
    }
}

async fn set_voice_permission(
    store: &Arc<MemoryStore>,
    surface_id: Uuid,
    approval_revision: u64,
    expected_revision: u64,
    source_floor: Option<PrivacyClass>,
) -> Result<native_voice::Approval, RuntimeError> {
    match store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::SetNativeVoicePolicy {
                surface_id,
                approval_revision,
                expected_revision,
                policy: source_floor.map(|source_floor| native_voice::Policy { source_floor }),
            },
        )
        .await?
    {
        RuntimeResult::NativeVoicePolicy(Some(approval)) => Ok(approval),
        _ => panic!("native voice approval required"),
    }
}

async fn voice_admission(
    store: &Arc<MemoryStore>,
    connection: &NativeProof,
) -> Result<(u64, PrivacyClass), RuntimeError> {
    match store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::AdmitNativeVoice {
                connection: connection.clone(),
            },
        )
        .await?
    {
        RuntimeResult::NativeVoiceAdmissible {
            policy_revision,
            source_floor,
        } => Ok((policy_revision, source_floor)),
        _ => panic!("native voice admissibility required"),
    }
}

/// Speaking to a device is the owner's decision about that one installation,
/// and it is spent the moment the installation is reapproved. Nothing here is
/// a microphone the runtime can open: the gate is asked before any audio is
/// read, and audio only ever arrives because a person pressed something.
#[tokio::test]
async fn native_voice_admission_needs_the_owner_permission_at_the_current_revision() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let (mac, _) = open_native(&fixture.store, "macos").await;
    // Approved, connected, declaring a microphone — and still refused, because
    // the owner has said nothing about it.
    assert!(matches!(
        voice_admission(&fixture.store, &mac).await,
        Err(RuntimeError::PolicyBlocked)
    ));
    // The floor is never below the shared room: an unknown actor in a room of
    // unknown occupancy does not establish public capture.
    assert!(matches!(
        set_voice_permission(
            &fixture.store,
            mac.surface_id,
            1,
            0,
            Some(PrivacyClass::Public)
        )
        .await,
        Err(RuntimeError::InvalidRequest)
    ));
    let approval = set_voice_permission(
        &fixture.store,
        mac.surface_id,
        1,
        0,
        Some(PrivacyClass::SharedRoom),
    )
    .await
    .unwrap();
    assert_eq!((approval.approval_revision, approval.revision), (1, 1));
    assert_eq!(
        voice_admission(&fixture.store, &mac).await.unwrap(),
        (1, PrivacyClass::SharedRoom)
    );
    // Withdrawing it is one write, and it takes effect before the next press.
    set_voice_permission(&fixture.store, mac.surface_id, 1, 1, None)
        .await
        .unwrap();
    assert!(matches!(
        voice_admission(&fixture.store, &mac).await,
        Err(RuntimeError::PolicyBlocked)
    ));
    set_voice_permission(
        &fixture.store,
        mac.surface_id,
        1,
        2,
        Some(PrivacyClass::SharedRoom),
    )
    .await
    .unwrap();
    assert_eq!(voice_admission(&fixture.store, &mac).await.unwrap().0, 3);
    // Revoking and reapproving the installation moves its approval revision,
    // which drops the permission with everything else bound to it: the owner
    // says again what this device may do, including whether it has an ear.
    let enrollment_id = fixture
        .store
        .surface(PRINCIPAL, mac.surface_id)
        .await
        .unwrap()
        .unwrap()
        .native_view()
        .unwrap()
        .enrollment_id;
    fixture
        .store
        .mutate_surface(
            PRINCIPAL,
            mac.surface_id,
            Mutation::RevokeNative {
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    assert!(voice_admission(&fixture.store, &mac).await.is_err());
    fixture
        .store
        .mutate_surface(
            PRINCIPAL,
            mac.surface_id,
            Mutation::ApproveNative {
                enrollment_id,
                public_key: "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU".into(),
                platform: "macos".into(),
                expected_revision: 2,
            },
        )
        .await
        .unwrap();
    let reapproved = fixture
        .store
        .surface(PRINCIPAL, mac.surface_id)
        .await
        .unwrap()
        .unwrap()
        .native_view()
        .unwrap();
    assert_eq!(reapproved.revision, 3);
    assert_eq!(reapproved.approval, surface_registry::NATIVE_APPROVAL);
    // The permission did not survive the new approval: expecting the old
    // revision is a conflict, and nothing may be spoken until the owner
    // allows it again for this revision.
    assert!(matches!(
        set_voice_permission(
            &fixture.store,
            mac.surface_id,
            3,
            3,
            Some(PrivacyClass::SharedRoom)
        )
        .await,
        Err(RuntimeError::Stale)
    ));
    set_voice_permission(
        &fixture.store,
        mac.surface_id,
        3,
        0,
        Some(PrivacyClass::SharedRoom),
    )
    .await
    .unwrap();
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
}

/// A spoken request is one ordinary sequenced request whose provenance says it
/// was spoken. Its identity is the press, not the words, so a retry of the
/// same press is the same turn; the ledger carries the capture's bounds and
/// both classes, and never a syllable of what was said.
#[tokio::test]
async fn native_voice_admits_a_spoken_request_and_records_its_provenance() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let (mac, epoch) = open_native(&fixture.store, "macos").await;
    set_voice_permission(
        &fixture.store,
        mac.surface_id,
        1,
        0,
        Some(PrivacyClass::SharedRoom),
    )
    .await
    .unwrap();
    let (policy_revision, source_floor) = voice_admission(&fixture.store, &mac).await.unwrap();
    let capture = synthetic_capture(32_000, policy_revision, source_floor);
    let stamp = InputStamp {
        sequence: 2,
        instance_id: Uuid::new_v4(),
        ..epoch.clone()
    };
    let RuntimeResult::Proposed(reply) = fixture
        .runtime
        .native_voice_transcript(
            PRINCIPAL,
            mac.clone(),
            stamp.clone(),
            capture.clone(),
            "Tell me a public fact".into(),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("spoken request must reach cognition")
    };
    assert_eq!(reply.privacy, PrivacyClass::SharedRoom);
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let events = fixture.store.ambiance_ledger_events(PRINCIPAL).await;
    let admitted = events
        .iter()
        .filter_map(|event| match event {
            ledger::LedgerEvent::Runtime(event) => match &event.data {
                RuntimeData::NativeVoiceAdmitted { fence, .. }
                    if fence.turn_id == reply.turn_id =>
                {
                    Some(event.data.clone())
                }
                _ => None,
            },
            _ => None,
        })
        .next_back()
        .expect("a spoken request is recorded as spoken");
    let RuntimeData::NativeVoiceAdmitted {
        policy_revision: logged_revision,
        source_floor: logged_floor,
        capture_ms,
        samples,
        audio_digest,
        transcript_digest,
        privacy,
        ..
    } = admitted
    else {
        panic!("native voice admission event required")
    };
    assert_eq!(logged_revision, 1);
    assert_eq!(logged_floor, PrivacyClass::SharedRoom);
    assert_eq!(privacy, PrivacyClass::SharedRoom);
    assert_eq!(capture_ms, capture.capture_ms);
    assert_eq!(samples, capture.samples);
    assert_eq!(audio_digest, capture.audio_digest);
    assert_eq!(transcript_digest, hash(b"Tell me a public fact"));
    // The admitted request's digest is the press, never the transcript.
    assert!(events.iter().any(|event| matches!(
        event,
        ledger::LedgerEvent::Runtime(event)
            if matches!(&event.data, RuntimeData::TurnBegan { turn_id, request_digest, .. }
                if *turn_id == reply.turn_id
                    && *request_digest == capture.source_digest_for_test(&stamp))
    )));
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("Tell me a public fact"),
        "what was said never enters the ledger"
    );
    // Replaying the same press is the same request, not a second recognition.
    assert!(matches!(
        fixture
            .runtime
            .native_voice_transcript(
                PRINCIPAL,
                mac.clone(),
                stamp.clone(),
                capture.clone(),
                "Tell me a public fact".into(),
                None,
            )
            .await,
        Ok(RuntimeResult::Duplicate(fence)) if fence.turn_id == reply.turn_id
    ));
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    // A capture checked against a permission revision that has since moved is
    // refused under the admission lock, not admitted at the old class.
    set_voice_permission(
        &fixture.store,
        mac.surface_id,
        1,
        1,
        Some(PrivacyClass::SharedRoom),
    )
    .await
    .unwrap();
    let stale = fixture
        .runtime
        .native_voice_transcript(
            PRINCIPAL,
            mac.clone(),
            InputStamp {
                sequence: 3,
                instance_id: Uuid::new_v4(),
                ..epoch.clone()
            },
            capture,
            "Tell me a public fact".into(),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(stale.code(), tonic::Code::FailedPrecondition);
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
}

/// The server bounds the press it will accept, in both directions, and there
/// is nowhere in this path for a client to hand over words it wrote itself.
#[tokio::test]
async fn native_voice_bounds_the_capture_it_will_accept() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let (mac, epoch) = open_native(&fixture.store, "macos").await;
    set_voice_permission(
        &fixture.store,
        mac.surface_id,
        1,
        0,
        Some(PrivacyClass::SharedRoom),
    )
    .await
    .unwrap();
    let valid = synthetic_capture(32_000, 1, PrivacyClass::SharedRoom);
    let mut sequence = 1;
    for invalid in [
        // A press longer than the budget.
        native_voice::Capture {
            capture_ms: native_voice::MAX_CAPTURE_MS + 1,
            samples: native_voice::MAX_SAMPLES,
            ..valid.clone()
        },
        // More audio than the press it declares.
        native_voice::Capture {
            capture_ms: 1_000,
            samples: 32_000,
            ..valid.clone()
        },
        // More audio than the recognizer takes at all.
        native_voice::Capture {
            capture_ms: native_voice::MAX_CAPTURE_MS,
            samples: native_voice::MAX_SAMPLES + 1,
            ..valid.clone()
        },
        // A client that will not say it showed what it was doing.
        native_voice::Capture {
            attestation: vec![native_voice::Attestation::PushToTalk],
            ..valid.clone()
        },
        // A capture claiming a class the owner never wrote.
        native_voice::Capture {
            source_floor: PrivacyClass::Private,
            ..valid.clone()
        },
    ] {
        sequence += 1;
        let error = fixture
            .runtime
            .native_voice_transcript(
                PRINCIPAL,
                mac.clone(),
                InputStamp {
                    sequence,
                    instance_id: Uuid::new_v4(),
                    ..epoch.clone()
                },
                invalid,
                "Tell me a public fact".into(),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(
                error.code(),
                tonic::Code::InvalidArgument | tonic::Code::FailedPrecondition
            ),
            "{error:?}"
        );
    }
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
}

/// A shared device cannot claim a private ear. The television holds no
/// personal declaration, so both its floor and its ceiling are the shared
/// room; the phone the owner declared personal may be spoken to at a higher
/// class, and loses that the moment the declaration goes. Whatever the floor,
/// the transcript's own terms still raise the turn, and a request raised above
/// the shared room is answered on a personal surface while every shared one is
/// suppressed — including the television that heard it.
#[tokio::test]
async fn native_voice_class_is_the_owner_floor_joined_with_what_was_said() {
    let model = Arc::new(SpyModel::default());
    let fixture = fixture(model.clone()).await;
    let (tv, tv_epoch) = open_native(&fixture.store, "android_tv").await;
    let (phone, _) = open_native(&fixture.store, "android").await;
    // A television is bystander-perceivable by construction and can hold no
    // personal declaration, so a private floor for it is not writable.
    assert!(matches!(
        set_voice_permission(
            &fixture.store,
            tv.surface_id,
            1,
            0,
            Some(PrivacyClass::Private)
        )
        .await,
        Err(RuntimeError::InvalidRequest)
    ));
    assert!(matches!(
        set_voice_permission(
            &fixture.store,
            tv.surface_id,
            1,
            0,
            Some(PrivacyClass::NearUser)
        )
        .await,
        Err(RuntimeError::InvalidRequest)
    ));
    set_voice_permission(
        &fixture.store,
        tv.surface_id,
        1,
        0,
        Some(PrivacyClass::SharedRoom),
    )
    .await
    .unwrap();
    // The phone is the owner's own, declared for private display; only then is
    // a private floor writable for it.
    assert!(matches!(
        set_voice_permission(
            &fixture.store,
            phone.surface_id,
            1,
            0,
            Some(PrivacyClass::Private)
        )
        .await,
        Err(RuntimeError::InvalidRequest)
    ));
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::SetPrivatePolicy {
                surface_id: phone.surface_id,
                approval_revision: 1,
                expected_revision: 0,
                policy: Some(personal::Policy {
                    maximum_class: PrivacyClass::Private,
                }),
            },
        )
        .await
        .unwrap();
    set_voice_permission(
        &fixture.store,
        phone.surface_id,
        1,
        0,
        Some(PrivacyClass::Private),
    )
    .await
    .unwrap();
    assert_eq!(
        voice_admission(&fixture.store, &phone).await.unwrap().1,
        PrivacyClass::Private
    );
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::RoomControl {
                connection: RoomProof::Native(phone.clone()),
                stamp: InputStamp {
                    epoch: tv_epoch.epoch,
                    sequence: 1,
                    instance_id: Uuid::new_v4(),
                },
                control: BrowserControl::State { visible: true },
            },
        )
        .await
        .ok();
    // Said out loud at the television, about the owner's own notes: the floor
    // is the shared room, the words raise it to private, and the answer is
    // built by the runtime itself and offered to the phone.
    let (policy_revision, source_floor) = voice_admission(&fixture.store, &tv).await.unwrap();
    assert_eq!(source_floor, PrivacyClass::SharedRoom);
    let RuntimeResult::Proposed(private) = fixture
        .runtime
        .native_voice_transcript(
            PRINCIPAL,
            tv.clone(),
            InputStamp {
                sequence: 2,
                instance_id: Uuid::new_v4(),
                ..tv_epoch.clone()
            },
            synthetic_capture(32_000, policy_revision, source_floor),
            "Read my notes back to me".into(),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("a private spoken request is answered on a personal surface")
    };
    assert_eq!(private.privacy, PrivacyClass::Private);
    assert_eq!(private.surface_id, phone.surface_id);
    assert_ne!(private.surface_id, tv.surface_id);
    assert_eq!(
        model.calls.load(Ordering::SeqCst),
        0,
        "a private turn is answered without any provider"
    );
    let events = fixture.store.ambiance_ledger_events(PRINCIPAL).await;
    assert!(events.iter().any(|event| matches!(
        event,
        ledger::LedgerEvent::Runtime(event)
            if matches!(&event.data, RuntimeData::NativeVoiceAdmitted { fence, source_floor, privacy, .. }
                if fence.turn_id == private.turn_id
                    && *source_floor == PrivacyClass::SharedRoom
                    && *privacy == PrivacyClass::Private)
    )));
    let candidates = events
        .iter()
        .filter_map(|event| match event {
            ledger::LedgerEvent::Runtime(event) => match &event.data {
                RuntimeData::Decision {
                    turn_id,
                    candidates,
                    ..
                } if *turn_id == private.turn_id => Some(candidates.clone()),
                _ => None,
            },
            _ => None,
        })
        .next_back()
        .expect("the private decision is logged");
    for candidate in &candidates {
        if candidate.surface_id == tv.surface_id {
            assert_eq!(candidate.blocker, Some(policy::Blocker::Privacy));
        }
    }
    // Taking the phone's personal declaration away leaves its stored private
    // floor unusable: the next press is refused rather than admitted lower.
    fixture
        .store
        .runtime(
            PRINCIPAL,
            RuntimeOperation::SetPrivatePolicy {
                surface_id: phone.surface_id,
                approval_revision: 1,
                expected_revision: 1,
                policy: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        voice_admission(&fixture.store, &phone).await,
        Err(RuntimeError::PolicyBlocked)
    ));
}
