use super::*;
use crate::{
    ambiance::{BrowserProof, NativeProof, native_connection::ConnectionView},
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    store::{MemoryStore, Store},
    surface_registry::now_ms,
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn browser_room_configuration_keeps_credentials_out_of_urls_and_requires_tls() {
    for url in [
        "https://example.test",
        "ws://example.test",
        "wss://user@example.test",
        "wss://example.test?token=x",
        "wss://example.test#token",
    ] {
        assert!(
            Config::new(
                url.into(),
                "wss://example.test".into(),
                "fixture".into(),
                "s".repeat(32)
            )
            .is_err()
        );
    }
    assert!(
        Config::new(
            "ws://livekit:7880".into(),
            "wss://example.test/rtc".into(),
            "fixture".into(),
            "s".repeat(32)
        )
        .is_ok()
    );
}

#[derive(Default)]
struct CardModel {
    calls: AtomicUsize,
}
#[tonic::async_trait]
impl ChatModel for CardModel {
    async fn complete(&self, _: &[ChatMessage], _: &[ToolDef]) -> Result<ChatResponse, LlmError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ChatResponse { tool_call: Some(ToolCall {
            name: "propose_information".into(), arguments: serde_json::json!({"intent":{"kind":"visual_text_card","text":"Synthetic room card"},"privacy":"public"}).to_string(),
        }), ..Default::default() })
    }
}

fn delivery_action(intent: crate::ambiance::SemanticIntent) -> crate::ambiance::Action {
    crate::ambiance::Action {
        id: Uuid::new_v4(),
        root_id: Uuid::new_v4(),
        confirmation_root: None,
        origin_surface: Uuid::nil(),
        expression: false,
        turn_id: Uuid::new_v4(),
        generation: 1,
        worker: Uuid::new_v4(),
        surface_id: Uuid::new_v4(),
        channel: intent.channel(),
        incarnation: Uuid::new_v4(),
        content_digest: intent.content_digest(),
        intent,
        privacy: crate::ambiance::PrivacyClass::SharedRoom,
        status: crate::ambiance::ActionStatus::Dispatched,
        deadline_ms: now_ms() + 5_000,
        display_expires_at_ms: now_ms() + 30_000,
        attempts: 1,
        fallbacks: Vec::new(),
        outcome: None,
        revoked: None,
        progress: 0,
        dispatched_at_ms: 0,
    }
}

#[test]
fn browser_room_render_envelope_enforces_exact_wire_byte_limit_before_send() {
    use crate::ambiance::SemanticIntent;
    let runtime = AmbianceRuntime::new(
        Arc::new(MemoryStore::default()),
        Arc::new(CardModel::default()),
        None,
    );
    let mut action = delivery_action(SemanticIntent::VisualTextCard { text: "x".into() });
    let stamp = InputStamp {
        epoch: Uuid::new_v4(),
        sequence: 1,
        instance_id: action.id,
    };
    let short = render_payload(&runtime, "U:fixture", &action, &stamp).unwrap();
    let decoded: serde_json::Value = serde_json::from_str(&short).unwrap();
    assert_eq!(decoded["kind"], "render");
    assert_eq!(decoded["stamp"], serde_json::to_value(&stamp).unwrap());
    assert_eq!(
        decoded["command"],
        crate::browser_runtime_api::command(&action, None).unwrap()
    );

    // Control bytes expand to six JSON bytes each. The 4000-byte text bound
    // alone cannot establish the size of the fully serialized RPC envelope.
    let available = cosmos_rtc::MAX_PAYLOAD - (short.len() - 1);
    let text = format!(
        "{}{}",
        "\u{0001}".repeat(available / 6),
        "x".repeat(available % 6)
    );
    assert!(text.len() < 4000);
    action.intent = SemanticIntent::VisualTextCard { text: text.clone() };
    action.content_digest = action.intent.content_digest();
    let exact = render_payload(&runtime, "U:fixture", &action, &stamp).unwrap();
    assert_eq!(exact.len(), cosmos_rtc::MAX_PAYLOAD);
    action.intent = SemanticIntent::VisualTextCard {
        text: format!("{text}x"),
    };
    action.content_digest = action.intent.content_digest();
    assert!(render_payload(&runtime, "U:fixture", &action, &stamp).is_none());
}

#[test]
fn native_room_status_frame_names_only_the_kind_of_surface_and_committed_state() {
    use crate::ambiance::status::{TurnState, TurnStatus};
    let stamp = InputStamp {
        epoch: Uuid::from_u128(9),
        sequence: 4,
        instance_id: Uuid::from_u128(12),
    };
    let status = TurnStatus {
        turn_id: Uuid::from_u128(8),
        generation: 2,
        state: TurnState::Shown,
        surface: Some(Uuid::from_u128(3)),
        privacy: crate::ambiance::PrivacyClass::SharedRoom,
    };
    let shown: serde_json::Value = serde_json::from_str(&status_frame(
        &status,
        serde_json::json!({"platform": "android"}),
        &stamp,
    ))
    .unwrap();
    assert_eq!(
        shown,
        serde_json::json!({
            "version": 1, "kind": "status",
            "stamp": {"epoch": Uuid::from_u128(9), "sequence": 4, "instanceId": Uuid::from_u128(12)},
            "status": {"version": 1, "turnId": Uuid::from_u128(8), "generation": 2,
                "state": "shown", "surface": {"platform": "android"}, "privacy": "shared_room"},
        })
    );
    assert!(!shown.to_string().contains(&Uuid::from_u128(3).to_string()));
    let nowhere = TurnStatus {
        state: TurnState::Nowhere,
        surface: None,
        ..status
    };
    let nowhere: serde_json::Value =
        serde_json::from_str(&status_frame(&nowhere, serde_json::Value::Null, &stamp)).unwrap();
    assert_eq!(nowhere["status"]["state"], "nowhere");
    assert!(nowhere["status"]["surface"].is_null());
    assert_eq!(
        nowhere["status"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        [
            "generation",
            "privacy",
            "state",
            "surface",
            "turnId",
            "version"
        ],
        "a status carries no reason"
    );
    assert!(TurnState::Shown.terminal() && TurnState::Nowhere.terminal());
    assert!(!TurnState::Working.terminal() && !TurnState::Waiting.terminal());
}

#[test]
fn browser_room_missing_transient_places_never_replays_or_substitutes_text() {
    let model = Arc::new(CardModel::default());
    let runtime = AmbianceRuntime::new(Arc::new(MemoryStore::default()), model.clone(), None);
    let expires_at_ms = now_ms() + 30_000;
    let reference = crate::ambiance::visual::Reference {
        id: Uuid::new_v4(),
        digest: hash(b"synthetic transient places content"),
        expires_at_ms,
        audience: None,
    };
    let mut action =
        delivery_action(crate::ambiance::SemanticIntent::PlaceAddressCard { content: reference });
    action.display_expires_at_ms = expires_at_ms;
    let stamp = InputStamp {
        epoch: Uuid::new_v4(),
        sequence: 1,
        instance_id: action.id,
    };
    // A durable action can survive process restart while its card cannot.
    // Neither the original dispatch nor its same-key retry recreates content.
    for attempts in [1, 2] {
        action.attempts = attempts;
        assert!(render_payload(&runtime, "U:fixture", &action, &stamp).is_none());
    }
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_BROWSER_TEST_INPUT with an isolated localhost SFU signing fixture"]
async fn browser_room_live_delivery_receipt_is_not_render_ack_and_hide_clears() {
    let path = std::env::var("COSMOS_RTC_BROWSER_TEST_INPUT").expect("isolated fixture required");
    let input: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(url.starts_with("ws://127.0.0.1:"));
    let config = Config::new(
        url.into(),
        url.into(),
        input["key"].as_str().unwrap().into(),
        input["secret"].as_str().unwrap().into(),
    )
    .unwrap();
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(AmbianceRuntime::new(
        store.clone(),
        Arc::new(CardModel::default()),
        None,
    ));
    let rooms = Rooms::new(runtime, Some(config));
    let principal = format!("U:fixture-render-{}", Uuid::new_v4());
    let proof = BrowserProof {
        surface_id: Uuid::new_v4(),
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"synthetic render capability"),
    };
    store
        .mutate_surface(
            &principal,
            proof.surface_id,
            Mutation::Approve {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
            },
        )
        .await
        .unwrap();
    let epoch = Uuid::new_v4();
    let opened = rooms
        .open(&principal, RoomProof::Browser(proof.clone()), epoch)
        .await
        .unwrap();
    let (surface, mut frames) = Session::connect(&opened.url, &opened.token).await.unwrap();
    let mut peers = rooms.rooms.lock().await[&principal].session.peers();
    tokio::time::timeout(Duration::from_secs(4), async {
        while !peers.borrow_and_update().contains_key(&opened.participant) {
            peers.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let visibility = |sequence, visible| {
        serde_json::json!({"kind":"control","stamp":InputStamp { epoch, sequence, instance_id: Uuid::new_v4() },"control":{"kind":"state","visible":visible}}).to_string()
    };
    surface
        .invoke("runtime", visibility(1, true))
        .await
        .unwrap();
    let stamp = InputStamp {
        epoch,
        sequence: 2,
        instance_id: Uuid::new_v4(),
    };
    surface
        .invoke(
            "runtime",
            serde_json::json!({"kind":"input","stamp":stamp,"text":"show a synthetic card"})
                .to_string(),
        )
        .await
        .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(2), frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame.caller, "runtime");
    let message: serde_json::Value = serde_json::from_str(&frame.payload).unwrap();
    assert_eq!(message["kind"], "render");
    assert_eq!(message["stamp"]["epoch"], opened.runtime_epoch.to_string());
    assert_eq!(message["command"]["content"]["text"], "Synthetic room card");
    frame
        .reply
        .send(Ok(
            serde_json::json!({"version":1,"kind":"received","stamp":message["stamp"]}).to_string(),
        ))
        .unwrap();
    let RuntimeResult::Pending(actions) = store
        .runtime(
            &principal,
            RuntimeOperation::Poll {
                connection: RoomProof::Browser(proof.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    let action = &actions[0];
    assert_eq!(
        action.status,
        crate::ambiance::ActionStatus::Dispatched,
        "network receipt is not a committed DOM render"
    );
    let ack = serde_json::json!({"kind":"control","stamp":InputStamp { epoch, sequence: 3, instance_id: action.id },"control":BrowserControl::Acknowledge {
        action_id: action.id, turn_id: action.turn_id, generation: action.generation, channel: action.channel, content_digest: action.content_digest.clone(),
    }});
    surface.invoke("runtime", ack.to_string()).await.unwrap();
    let RuntimeResult::Pending(acknowledged) = store
        .runtime(
            &principal,
            RuntimeOperation::Poll {
                connection: RoomProof::Browser(proof.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(
        acknowledged[0].status,
        crate::ambiance::ActionStatus::Acknowledged
    );
    surface
        .invoke("runtime", visibility(4, false))
        .await
        .unwrap();
    let clear = tokio::time::timeout(Duration::from_secs(2), frames.recv())
        .await
        .unwrap()
        .unwrap();
    let clear_message: serde_json::Value = serde_json::from_str(&clear.payload).unwrap();
    assert_eq!(clear_message["kind"], "clear");
    assert_eq!(clear_message["actionId"], action.id.to_string());
    assert!(clear_message["stamp"]["sequence"].as_u64() > message["stamp"]["sequence"].as_u64());
    clear
        .reply
        .send(Ok(
            serde_json::json!({"version":1,"kind":"received","stamp":clear_message["stamp"]})
                .to_string(),
        ))
        .unwrap();
    assert!(surface.invoke("runtime", ack.to_string()).await.is_err());
    assert!(
        !store
            .surface(&principal, proof.surface_id)
            .await
            .unwrap()
            .unwrap()
            .visible
    );
    surface.close().await.unwrap();
}

struct SlowModel {
    calls: AtomicUsize,
    dropped: Arc<AtomicUsize>,
}
#[tonic::async_trait]
impl ChatModel for SlowModel {
    async fn complete(&self, _: &[ChatMessage], _: &[ToolDef]) -> Result<ChatResponse, LlmError> {
        struct Dropped(Arc<AtomicUsize>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _dropped = Dropped(self.dropped.clone());
        std::future::pending().await
    }
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_BROWSER_TEST_INPUT with an isolated localhost SFU signing fixture"]
async fn browser_room_live_admission_duplicate_attribution_and_disconnect() {
    let path = std::env::var("COSMOS_RTC_BROWSER_TEST_INPUT").expect("isolated fixture required");
    let input: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(url.starts_with("ws://127.0.0.1:"));
    let config = Config::new(
        url.into(),
        url.into(),
        input["key"].as_str().unwrap().into(),
        input["secret"].as_str().unwrap().into(),
    )
    .unwrap();
    let store = Arc::new(MemoryStore::default());
    let dropped = Arc::new(AtomicUsize::new(0));
    let model = Arc::new(SlowModel {
        calls: AtomicUsize::new(0),
        dropped: dropped.clone(),
    });
    let runtime = Arc::new(AmbianceRuntime::new(store.clone(), model.clone(), None));
    let rooms = Rooms::new(runtime, Some(config));
    let proof = BrowserProof {
        surface_id: Uuid::new_v4(),
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"synthetic browser capability"),
    };
    let principal = format!("U:fixture-{}", Uuid::new_v4());
    store
        .mutate_surface(
            &principal,
            proof.surface_id,
            Mutation::Approve {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
            },
        )
        .await
        .unwrap();
    store
        .mutate_surface(
            &principal,
            proof.surface_id,
            Mutation::State {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
                sequence: 1,
                visible: true,
            },
        )
        .await
        .unwrap();
    let epoch = Uuid::new_v4();
    assert!(matches!(
        rooms
            .open("U:someone-else", RoomProof::Browser(proof.clone()), epoch)
            .await,
        Err(Error::Denied)
    ));
    let opened = rooms
        .open(&principal, RoomProof::Browser(proof.clone()), epoch)
        .await
        .unwrap();
    assert!(matches!(
        rooms
            .open(
                &principal,
                RoomProof::Browser(proof.clone()),
                Uuid::new_v4()
            )
            .await,
        Err(Error::Denied)
    ));
    let (surface, _renders) = Session::connect(&opened.url, &opened.token).await.unwrap();
    let mut presence = rooms.rooms.lock().await[&principal].session.peers();
    tokio::time::timeout(Duration::from_secs(4), async {
        while !presence
            .borrow_and_update()
            .contains_key(&opened.participant)
        {
            presence.changed().await.unwrap();
        }
    })
    .await
    .expect("the SFU batches non-media peer presence for up to three seconds");
    let stamp = InputStamp {
        epoch,
        sequence: 1,
        instance_id: Uuid::new_v4(),
    };
    let message = serde_json::json!({"kind":"input","stamp":stamp,"text":"synthetic request"});
    let reply = tokio::time::timeout(
        Duration::from_secs(2),
        surface.invoke("runtime", message.to_string()),
    )
    .await
    .expect("admission must not await the model")
    .unwrap();
    let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["turnId"], stamp.instance_id.to_string());
    assert_eq!(reply["duplicate"], false);
    let duplicate: serde_json::Value = serde_json::from_str(
        &surface
            .invoke("runtime", message.to_string())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["generation"], reply["generation"]);
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    let mut altered = message.clone();
    altered["text"] = "changed retry".into();
    assert!(
        surface
            .invoke("runtime", altered.to_string())
            .await
            .is_err()
    );
    let mut claimed = message.clone();
    claimed["principal"] = "U:someone-else".into();
    assert!(
        surface
            .invoke("runtime", claimed.to_string())
            .await
            .is_err()
    );
    // A valid room token without the HTTP-bound proof has no application role.
    let config = rooms.config.as_ref().unwrap();
    let room_name = rooms.rooms.lock().await[&principal].name.clone();
    let outsider_token =
        cosmos_rtc::coordination_token(&config.key, &config.secret, &room_name, "unregistered")
            .unwrap();
    let (outsider, _) = Session::connect(&config.url, &outsider_token)
        .await
        .unwrap();
    assert!(
        outsider
            .invoke("runtime", message.to_string())
            .await
            .is_err()
    );
    outsider.close().await.unwrap();
    assert!(
        presence.borrow().contains_key(&opened.participant),
        "runtime observed the joined browser"
    );
    surface.close().await.unwrap();
    let stopped = tokio::time::timeout(Duration::from_secs(4), async {
        while dropped.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(
        !presence.borrow().contains_key(&opened.participant),
        "SDK observed the browser disconnect"
    );
    assert!(
        !store
            .surface(&principal, proof.surface_id)
            .await
            .unwrap()
            .unwrap()
            .connected,
        "disconnect invalidated the approved connection"
    );
    stopped.expect("peer disconnect cancels the pending model, without heartbeat expiry");
    assert!(matches!(
        rooms
            .open(&principal, RoomProof::Browser(proof.clone()), epoch)
            .await,
        Err(Error::Denied)
    ));
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert!(
        !store
            .surface(&principal, proof.surface_id)
            .await
            .unwrap()
            .unwrap()
            .connected
    );
}

fn native_room_config() -> Config {
    let path = std::env::var("COSMOS_RTC_BROWSER_TEST_INPUT").expect("isolated fixture required");
    let input: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(url.starts_with("ws://127.0.0.1:"));
    Config::new(
        url.into(),
        url.into(),
        input["key"].as_str().unwrap().into(),
        input["secret"].as_str().unwrap().into(),
    )
    .unwrap()
}

async fn native_room_browser(store: &MemoryStore, principal: &str) -> BrowserProof {
    let proof = BrowserProof {
        surface_id: Uuid::new_v4(),
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"synthetic joint-room browser capability"),
    };
    store
        .mutate_surface(
            principal,
            proof.surface_id,
            Mutation::Approve {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
            },
        )
        .await
        .unwrap();
    proof
}

async fn native_room_open(
    store: &MemoryStore,
    principal: &str,
    enrollment_id: Uuid,
    epoch: Uuid,
    token_marker: u8,
) -> (NativeProof, ConnectionView) {
    use crate::ambiance::native_connection::{OpenRequest, signing_message};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use p256::ecdsa::{Signature, SigningKey, signature::Signer};

    let surface_id = crate::surface_registry::native_surface_id(principal, enrollment_id);
    let RuntimeResult::NativeChallenge(challenge) = store
        .runtime(
            principal,
            RuntimeOperation::NativeChallenge {
                surface_id,
                enrollment_id,
                audience: "https://native-room.test".into(),
                challenge_id: Uuid::new_v4(),
                nonce: URL_SAFE_NO_PAD.encode([token_marker; 32]),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native challenge expected")
    };
    let mut request = OpenRequest {
        enrollment_id,
        challenge_id: challenge.challenge_id,
        epoch,
        expected_incarnation: challenge.current_incarnation,
        session_token_hash: hash(&[token_marker; 32]),
        signature: String::new(),
    };
    let mut scalar = [0u8; 32];
    scalar[31] = 1;
    let key = SigningKey::from_bytes(&scalar).unwrap();
    let signature: Signature = key.sign(&signing_message(&challenge, &request).unwrap());
    request.signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
    let token_hash = request.session_token_hash.clone();
    let RuntimeResult::NativeOpened {
        connection,
        duplicate: false,
    } = store
        .runtime(
            principal,
            RuntimeOperation::OpenNative {
                surface_id,
                audience: challenge.audience,
                request,
                incarnation: Uuid::new_v4(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("new native connection expected")
    };
    (
        NativeProof {
            surface_id,
            incarnation: connection.incarnation,
            token_hash,
        },
        connection,
    )
}

async fn native_room_join(
    rooms: &Rooms,
    principal: &str,
    proof: RoomProof,
    epoch: Uuid,
) -> (Connection, Session, tokio::sync::mpsc::Receiver<Invocation>) {
    let opened = rooms.open(principal, proof, epoch).await.unwrap();
    let (session, inbox) = Session::connect(&opened.url, &opened.token).await.unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let rooms = rooms.rooms.lock().await;
            let participants = rooms[principal].participants.lock().await;
            if participants
                .get(&opened.participant)
                .is_some_and(|member| member.sid.is_some())
            {
                break;
            }
            drop(participants);
            drop(rooms);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("coordinator must observe the actual joined SFU session");
    (opened, session, inbox)
}

fn native_room_control(epoch: Uuid, sequence: u64, control: BrowserControl) -> String {
    let instance_id = match &control {
        BrowserControl::Cancel { turn_id, .. } => *turn_id,
        BrowserControl::Acknowledge { action_id, .. } => *action_id,
        _ => Uuid::new_v4(),
    };
    serde_json::json!({
        "kind":"control", "stamp": InputStamp { epoch, sequence, instance_id }, "control":control,
    })
    .to_string()
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_BROWSER_TEST_INPUT with an isolated localhost SFU signing fixture"]
async fn native_room_live_both_join_orders_share_coordinator_and_browser_delivery() {
    for native_first in [false, true] {
        let store = Arc::new(MemoryStore::default());
        let model = Arc::new(CardModel::default());
        let runtime = Arc::new(AmbianceRuntime::new(store.clone(), model.clone(), None));
        let rooms = Rooms::new(runtime, Some(native_room_config()));
        let principal = format!("U:native-joint-room-{}", Uuid::new_v4());
        let browser_proof = native_room_browser(&store, &principal).await;
        let browser_epoch = Uuid::new_v4();
        let native_epoch = Uuid::new_v4();
        let enrollment_id = Uuid::new_v4();
        let native_id = crate::surface_registry::native_surface_id(&principal, enrollment_id);
        store
            .mutate_surface(
                &principal,
                native_id,
                crate::store::native_test_approval(enrollment_id, 0),
            )
            .await
            .unwrap();
        let (native_proof, original_connection) =
            native_room_open(&store, &principal, enrollment_id, native_epoch, 41).await;
        let browser_join = || {
            native_room_join(
                &rooms,
                &principal,
                RoomProof::Browser(browser_proof.clone()),
                browser_epoch,
            )
        };
        let native_join = || {
            native_room_join(
                &rooms,
                &principal,
                RoomProof::Native(native_proof.clone()),
                native_epoch,
            )
        };
        let (browser_joined, native_joined) = if native_first {
            let native = native_join().await;
            (browser_join().await, native)
        } else {
            let browser = browser_join().await;
            (browser, native_join().await)
        };
        let (browser_connection, browser, mut browser_frames) = browser_joined;
        let (native_connection, native, mut native_frames) = native_joined;
        assert_eq!(rooms.rooms.lock().await.len(), 1);
        assert_eq!(
            browser_connection.runtime_epoch,
            native_connection.runtime_epoch
        );
        assert_eq!(browser_connection.runtime_participant, "runtime");
        assert_eq!(native_connection.runtime_participant, "runtime");
        assert_ne!(
            browser_connection.participant,
            native_connection.participant
        );
        let retry = rooms
            .open(
                &principal,
                RoomProof::Native(native_proof.clone()),
                native_epoch,
            )
            .await
            .unwrap();
        assert_eq!(retry.participant, native_connection.participant);
        let RuntimeResult::NativeCurrent(current) = store
            .runtime(
                &principal,
                RuntimeOperation::CheckNative {
                    connection: native_proof.clone(),
                },
            )
            .await
            .unwrap()
        else {
            panic!("native connection expected")
        };
        assert_eq!(
            current, original_connection,
            "room joins and retries renew nothing"
        );
        assert!(matches!(
            rooms
                .open(
                    &principal,
                    RoomProof::Native(native_proof.clone()),
                    Uuid::new_v4()
                )
                .await,
            Err(Error::Denied)
        ));
        browser
            .invoke(
                "runtime",
                native_room_control(browser_epoch, 1, BrowserControl::State { visible: true }),
            )
            .await
            .unwrap();
        let heartbeat = native_room_control(native_epoch, 1, BrowserControl::Heartbeat);
        native.invoke("runtime", heartbeat.clone()).await.unwrap();
        let retry: serde_json::Value =
            serde_json::from_str(&native.invoke("runtime", heartbeat).await.unwrap()).unwrap();
        assert_eq!(retry["duplicate"], true);
        let stamp = InputStamp {
            epoch: native_epoch,
            sequence: 2,
            instance_id: Uuid::new_v4(),
        };
        let input = serde_json::json!({"kind":"input","stamp":stamp,"text":"show a synthetic card on Center"}).to_string();
        let admitted: serde_json::Value =
            serde_json::from_str(&native.invoke("runtime", input.clone()).await.unwrap()).unwrap();
        let duplicate: serde_json::Value =
            serde_json::from_str(&native.invoke("runtime", input).await.unwrap()).unwrap();
        assert_eq!(admitted["turnId"], stamp.instance_id.to_string());
        assert_eq!(admitted["duplicate"], false);
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(duplicate["generation"], admitted["generation"]);

        let frame = tokio::time::timeout(Duration::from_secs(2), browser_frames.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.caller, "runtime");
        let render: serde_json::Value = serde_json::from_str(&frame.payload).unwrap();
        assert_eq!(render["kind"], "render");
        assert_eq!(
            render["command"]["surfaceId"],
            browser_proof.surface_id.to_string()
        );
        assert_eq!(render["command"]["content"]["text"], "Synthetic room card");
        frame
            .reply
            .send(Ok(
                serde_json::json!({"version":1,"kind":"received","stamp":render["stamp"]})
                    .to_string(),
            ))
            .unwrap();
        let RuntimeResult::Pending(actions) = store
            .runtime(
                &principal,
                RuntimeOperation::Poll {
                    connection: RoomProof::Browser(browser_proof.clone()),
                },
            )
            .await
            .unwrap()
        else {
            panic!("browser delivery expected")
        };
        let action = &actions[0];
        assert_eq!(
            action.status,
            crate::ambiance::ActionStatus::Dispatched,
            "transport receipt does not acknowledge rendering"
        );
        let ack = || BrowserControl::Acknowledge {
            action_id: action.id,
            turn_id: action.turn_id,
            generation: action.generation,
            channel: action.channel,
            content_digest: action.content_digest.clone(),
        };
        assert!(
            native
                .invoke("runtime", native_room_control(native_epoch, 3, ack()))
                .await
                .is_err()
        );
        assert!(
            native
                .invoke(
                    "runtime",
                    native_room_control(native_epoch, 3, BrowserControl::State { visible: true })
                )
                .await
                .is_err()
        );
        browser
            .invoke("runtime", native_room_control(browser_epoch, 2, ack()))
            .await
            .unwrap();
        let RuntimeResult::Pending(acknowledged) = store
            .runtime(
                &principal,
                RuntimeOperation::Poll {
                    connection: RoomProof::Browser(browser_proof.clone()),
                },
            )
            .await
            .unwrap()
        else {
            panic!("acknowledged browser delivery expected")
        };
        assert_eq!(
            acknowledged[0].status,
            crate::ambiance::ActionStatus::Acknowledged
        );
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        assert!(
            matches!(
                native_frames.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ),
            "native has no rendering channel"
        );

        native
            .invoke(
                "runtime",
                native_room_control(
                    native_epoch,
                    3,
                    BrowserControl::Cancel {
                        turn_id: stamp.instance_id,
                        generation: admitted["generation"].as_u64().unwrap(),
                    },
                ),
            )
            .await
            .unwrap();
        let clear = tokio::time::timeout(Duration::from_secs(2), browser_frames.recv())
            .await
            .unwrap()
            .unwrap();
        let clear_message: serde_json::Value = serde_json::from_str(&clear.payload).unwrap();
        assert_eq!(clear_message["kind"], "clear");
        assert_eq!(clear_message["actionId"], action.id.to_string());
        clear
            .reply
            .send(Ok(
                serde_json::json!({"version":1,"kind":"received","stamp":clear_message["stamp"]})
                    .to_string(),
            ))
            .unwrap();
        store
            .mutate_surface(
                &principal,
                native_id,
                Mutation::RevokeNative {
                    expected_revision: 1,
                },
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let rooms = rooms.rooms.lock().await;
                if !rooms[&principal]
                    .participants
                    .lock()
                    .await
                    .contains_key(&native_connection.participant)
                {
                    break;
                }
                drop(rooms);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("native revocation must retire only its room membership");
        assert!(
            native
                .invoke(
                    "runtime",
                    native_room_control(native_epoch, 4, BrowserControl::Heartbeat)
                )
                .await
                .is_err()
        );
        browser
            .invoke(
                "runtime",
                native_room_control(browser_epoch, 3, BrowserControl::State { visible: true }),
            )
            .await
            .unwrap();
        assert!(*browser.connected().borrow());
        assert!(matches!(
            native_frames.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        native.close().await.unwrap();
        browser.close().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_BROWSER_TEST_INPUT with an isolated localhost SFU signing fixture"]
async fn native_room_live_disconnect_fences_cognition_preserves_browser_and_reconnect_cursor() {
    let store = Arc::new(MemoryStore::default());
    let dropped = Arc::new(AtomicUsize::new(0));
    let model = Arc::new(SlowModel {
        calls: AtomicUsize::new(0),
        dropped: dropped.clone(),
    });
    let runtime = Arc::new(AmbianceRuntime::new(store.clone(), model.clone(), None));
    let rooms = Rooms::new(runtime, Some(native_room_config()));
    let principal = format!("U:native-disconnect-room-{}", Uuid::new_v4());
    let browser_proof = native_room_browser(&store, &principal).await;
    let browser_epoch = Uuid::new_v4();
    let (_, browser, mut browser_frames) = native_room_join(
        &rooms,
        &principal,
        RoomProof::Browser(browser_proof.clone()),
        browser_epoch,
    )
    .await;
    browser
        .invoke(
            "runtime",
            native_room_control(browser_epoch, 1, BrowserControl::State { visible: true }),
        )
        .await
        .unwrap();
    let enrollment_id = Uuid::new_v4();
    let native_id = crate::surface_registry::native_surface_id(&principal, enrollment_id);
    store
        .mutate_surface(
            &principal,
            native_id,
            crate::store::native_test_approval(enrollment_id, 0),
        )
        .await
        .unwrap();
    let native_epoch = Uuid::new_v4();
    let (native_proof, _) =
        native_room_open(&store, &principal, enrollment_id, native_epoch, 51).await;
    let (native_connection, native, mut native_frames) = native_room_join(
        &rooms,
        &principal,
        RoomProof::Native(native_proof.clone()),
        native_epoch,
    )
    .await;
    native
        .invoke(
            "runtime",
            native_room_control(native_epoch, 1, BrowserControl::Heartbeat),
        )
        .await
        .unwrap();
    let stamp = InputStamp {
        epoch: native_epoch,
        sequence: 2,
        instance_id: Uuid::new_v4(),
    };
    let input =
        serde_json::json!({"kind":"input","stamp":stamp,"text":"synthetic pending native request"})
            .to_string();
    let admitted: serde_json::Value = serde_json::from_str(
        &tokio::time::timeout(
            Duration::from_secs(2),
            native.invoke("runtime", input.clone()),
        )
        .await
        .expect("admission must precede model completion")
        .unwrap(),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while model.calls.load(Ordering::SeqCst) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let duplicate: serde_json::Value =
        serde_json::from_str(&native.invoke("runtime", input.clone()).await.unwrap()).unwrap();
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(
        dropped.load(Ordering::SeqCst),
        0,
        "duplicate does not own the pending model"
    );
    assert!(
        browser
            .invoke(
                "runtime",
                native_room_control(
                    browser_epoch,
                    2,
                    BrowserControl::Cancel {
                        turn_id: stamp.instance_id,
                        generation: admitted["generation"].as_u64().unwrap()
                    }
                )
            )
            .await
            .is_err(),
        "browser cannot cancel another origin's turn"
    );
    native.close().await.unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        while dropped.load(Ordering::SeqCst) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("native disconnect must cancel pending cognition before lease expiry");
    let installed = store.surface(&principal, native_id).await.unwrap().unwrap();
    assert!(!installed.revoked);
    assert_eq!(installed.revision, 1);
    assert!(
        store
            .runtime(
                &principal,
                RuntimeOperation::CheckNative {
                    connection: native_proof.clone()
                }
            )
            .await
            .is_err()
    );
    assert!(*browser.connected().borrow());
    let center = store
        .surface(&principal, browser_proof.surface_id)
        .await
        .unwrap()
        .unwrap();
    assert!(center.connected && center.visible && !center.revoked);
    assert!(
        !rooms.rooms.lock().await[&principal]
            .participants
            .lock()
            .await
            .contains_key(&native_connection.participant)
    );

    let (replacement, _) =
        native_room_open(&store, &principal, enrollment_id, native_epoch, 52).await;
    let (_, reconnected, mut replacement_frames) = native_room_join(
        &rooms,
        &principal,
        RoomProof::Native(replacement.clone()),
        native_epoch,
    )
    .await;
    let replay: serde_json::Value =
        serde_json::from_str(&reconnected.invoke("runtime", input).await.unwrap()).unwrap();
    assert_eq!(replay["duplicate"], true);
    assert_eq!(replay["turnId"], admitted["turnId"]);
    assert_eq!(replay["generation"], admitted["generation"]);
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert!(
        store
            .runtime(
                &principal,
                RuntimeOperation::CloseNative {
                    connection: native_proof
                }
            )
            .await
            .is_err()
    );
    assert!(matches!(
        store
            .runtime(
                &principal,
                RuntimeOperation::CheckNative {
                    connection: replacement
                }
            )
            .await
            .unwrap(),
        RuntimeResult::NativeCurrent(_)
    ));
    browser
        .invoke(
            "runtime",
            native_room_control(browser_epoch, 2, BrowserControl::State { visible: true }),
        )
        .await
        .unwrap();
    assert!(*browser.connected().borrow());
    assert!(matches!(
        browser_frames.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    assert!(native_frames.try_recv().is_err());
    assert!(matches!(
        replacement_frames.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    reconnected.close().await.unwrap();
    browser.close().await.unwrap();
}
