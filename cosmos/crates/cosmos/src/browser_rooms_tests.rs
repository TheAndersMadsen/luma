use super::*;
use crate::{
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    store::{MemoryStore, Store},
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

struct CardModel;
#[tonic::async_trait]
impl ChatModel for CardModel {
    async fn complete(&self, _: &[ChatMessage], _: &[ToolDef]) -> Result<ChatResponse, LlmError> {
        Ok(ChatResponse { tool_call: Some(ToolCall {
            name: "propose_information".into(), arguments: serde_json::json!({"intent":{"kind":"visual_text_card","text":"Synthetic room card"},"privacy":"public"}).to_string(),
        }), ..Default::default() })
    }
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
        Arc::new(CardModel),
        None,
    ));
    let rooms = BrowserRooms::new(runtime, Some(config));
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
    let opened = rooms.open(&principal, proof.clone(), epoch).await.unwrap();
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
                connection: proof.clone(),
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
                connection: proof.clone(),
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
    let rooms = BrowserRooms::new(runtime, Some(config));
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
        rooms.open("U:someone-else", proof.clone(), epoch).await,
        Err(Error::Denied)
    ));
    let opened = rooms.open(&principal, proof.clone(), epoch).await.unwrap();
    assert!(matches!(
        rooms.open(&principal, proof.clone(), Uuid::new_v4()).await,
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
        rooms.open(&principal, proof.clone(), epoch).await,
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
