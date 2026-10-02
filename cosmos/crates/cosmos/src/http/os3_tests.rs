//! Synthetic, unrecorded owner-spec HTTP/WebSocket workflows. No provider accounts.
use super::*;
use axum::{body::Body, http::Request};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

const COOKIE: &str = "session=synthetic-http-owner";
const TASK: &str = "Ask OS3 to inspect the synthetic Mac fixture.";
const EDGE: &str = "synthetic-http-edge-proof";

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Scenario {
    Result,
    Cancel,
    Permission,
    UnrelatedCancel,
    PermissionLifecycle,
}

pub(super) struct Rabbit {
    packets: Arc<Mutex<Vec<Value>>>,
    connections: Arc<AtomicUsize>,
}
impl Rabbit {
    pub(super) async fn start(scenario: Scenario) -> Self {
        let app = Router::new()
            .route(
                "/api/auth/token",
                get(|| async { Json(json!({"accessToken":"synthetic-token"})) }),
            )
            .route(
                "/session-directory/route",
                post(|| async { Json(json!({"kind":"any"})) }),
            );
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", http.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(http, app).await.unwrap();
        });
        let ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = format!("ws://{}/ws", ws.local_addr().unwrap());
        unsafe {
            std::env::set_var("LUMA_TEST_OS3_HTTP_ORIGIN", origin);
            std::env::set_var("LUMA_TEST_OS3_SOCKET", socket);
        }
        let packets = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let seen = packets.clone();
        let count = connections.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = ws.accept().await {
                let seen = seen.clone();
                let round = count.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let mut request = None;
                    while let Some(Ok(frame)) = socket.next().await {
                        let Message::Text(text) = frame else {
                            continue;
                        };
                        let packet: Value = serde_json::from_str(&text).unwrap();
                        seen.lock().unwrap().push(packet.clone());
                        if packet["type"] == "init" {
                            socket.send(Message::Text(json!({"type":"init_ack","version":1,"sessionId":"http_session","protocolVersion":1,"butlerName":"Fixture"}).to_string())).await.unwrap();
                            if round > 0 {
                                let mut messages = vec![
                                    json!({"type":"chat.message","messageId":"original_echo","role":"user","text":TASK,"timestamp":1700000000100_i64}),
                                    json!({"type":"chat.message","messageId":"original_ack","role":"agent","text":"Checking the fixture."}),
                                ];
                                if scenario == Scenario::Result
                                    || (scenario == Scenario::PermissionLifecycle && round >= 2)
                                {
                                    messages.push(json!({"type":"chat.message","messageId":"result","role":"agent","text":"Synthetic task result."}));
                                }
                                let history = json!({"type":"session.history","messages":messages});
                                socket
                                    .send(Message::Text(history.to_string()))
                                    .await
                                    .unwrap();
                                if scenario == Scenario::Result
                                    || scenario == Scenario::PermissionLifecycle
                                {
                                    let state = if scenario == Scenario::PermissionLifecycle
                                        && round == 1
                                    {
                                        "running"
                                    } else {
                                        "completed"
                                    };
                                    socket.send(Message::Text(json!({"type":"agent.list","agents":[{"agentId":"original_worker","title":"Fixture","state":state,"createdAt":1700000000101_i64}]}).to_string())).await.unwrap();
                                    if state == "running" {
                                        // Owner-spec section 5: a tool failure is an activity result,
                                        // not evidence that the correlated worker has stopped.
                                        socket.send(Message::Text(json!({"type":"activity.step","agentType":"worker","agentId":"original_worker","step":{"kind":"tool_result","toolCallId":"browser_call","toolName":"synthetic_browser","output":"The operation parameters were not accepted.","durationMs":10}}).to_string())).await.unwrap();
                                        socket.send(Message::Text(json!({"type":"error","message":"Synthetic provider temporary limit."}).to_string())).await.unwrap();
                                    }
                                    socket
                                        .send(Message::Text(
                                            json!({"type":"conversation.idle"}).to_string(),
                                        ))
                                        .await
                                        .unwrap();
                                }
                            }
                        } else if packet["type"] == "chat.message" {
                            let timestamp = 1700000000100_i64 + round as i64 * 1000;
                            request = Some(packet["text"].as_str().unwrap().to_owned());
                            let echo = json!({"type":"chat.message","version":1,"messageId":if round==0 {"original_echo"} else {"next_echo"},"role":"user","text":packet["text"],"timestamp":timestamp});
                            socket.send(Message::Text(echo.to_string())).await.unwrap();
                            if scenario == Scenario::Permission
                                || (scenario == Scenario::PermissionLifecycle && round == 0)
                            {
                                socket.send(Message::Text(json!({"type":"agent.list","agents":[{"agentId":"original_worker","title":"Fixture","state":"running","createdAt":timestamp+1}]}).to_string())).await.unwrap();
                                socket.send(Message::Text(json!({"type":"activity.step","agentType":"worker","agentId":"original_worker","step":{"kind":"ask_user","text":"Approve the synthetic operation in OS3."}}).to_string())).await.unwrap();
                            } else if round == 0 {
                                socket.send(Message::Text(json!({"type":"agent.list","agents":[{"agentId":"original_worker","title":"Fixture","state":"running","createdAt":timestamp+1}]}).to_string())).await.unwrap();
                                socket.send(Message::Text(json!({"type":"chat.message","messageId":"original_ack","role":"agent","text":"Checking the fixture."}).to_string())).await.unwrap();
                            } else {
                                let state = if scenario == Scenario::UnrelatedCancel {
                                    "running"
                                } else if scenario == Scenario::Cancel {
                                    "canceled"
                                } else {
                                    "completed"
                                };
                                // An unrelated canceled worker must not authorize confirmation.
                                socket.send(Message::Text(json!({"type":"agent.list","agents":[{"agentId":"unrelated","title":"Old unrelated task","state":"canceled","createdAt":1600000000000_i64},{"agentId":"original_worker","title":"Fixture","state":state,"createdAt":1700000000101_i64}]}).to_string())).await.unwrap();
                                socket.send(Message::Text(json!({"type":"chat.message","messageId":"result","role":"agent","text":"Synthetic task result."}).to_string())).await.unwrap();
                            }
                            socket
                                .send(Message::Text(
                                    json!({"type":"conversation.idle"}).to_string(),
                                ))
                                .await
                                .unwrap();
                        }
                    }
                    let _ = request;
                });
            }
        });
        Self {
            packets,
            connections,
        }
    }
    pub(super) fn sent(&self) -> Vec<Value> {
        self.packets.lock().unwrap().clone()
    }
}

pub(super) fn app(
    store: crate::store::SharedStore,
    keys: crate::keydirectory::SharedKeyDirectory,
) -> Router {
    demo_router(Readiness::default(), store, keys)
}
pub(super) async fn post_as(
    app: Router,
    account: Option<&str>,
    path: &str,
    text: &str,
) -> (StatusCode, String) {
    post_payload_as(
        app,
        account,
        path,
        json!({"text":text,"simulate_unlocked_pin":true}),
    )
    .await
}
async fn post_payload_as(
    app: Router,
    account: Option<&str>,
    path: &str,
    payload: Value,
) -> (StatusCode, String) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(account) = account {
        request = request
            .header(
                crate::config::EDGE_PRINCIPAL_HEADER,
                format!("V:01:D:httpfixture:U:{account}"),
            )
            .header(crate::config::EDGE_TOKEN_HEADER, EDGE);
    }
    let response = app
        .oneshot(request.body(Body::from(payload.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}
pub(super) async fn setup(
    test: &str,
) -> Option<(
    crate::store::SharedStore,
    crate::keydirectory::SharedKeyDirectory,
    std::path::PathBuf,
)> {
    const CHILD: &str = "LUMA_HTTP_OS3_FIXTURE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env(CHILD, "synthetic")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated HTTP OS3 workflow: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }
    let dir = std::env::temp_dir().join(format!("luma-http-os3-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut config = crate::integrations::IntegrationsConfig::default();
    config.os3.enabled = true;
    config.os3.session_cookie = Some(COOKIE.to_owned());
    std::fs::write(
        dir.join("integrations.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    crate::integrations::install(dir.to_str()).unwrap();
    unsafe {
        std::env::set_var("COSMOS_EDGE_TOKEN", EDGE);
        std::env::set_var("LUMA_TEST_OS3_ASK_WINDOW_MS", "4500");
    }
    Some((
        crate::store::MemoryStore::shared(),
        Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
        dir,
    ))
}
pub(super) async fn wait_for_checkpoint(
    store: &crate::store::SharedStore,
    keys: &crate::keydirectory::SharedKeyDirectory,
) {
    tokio::time::timeout(std::time::Duration::from_secs(2),async {
        loop {
            if let Some(data) = store.get_account_blob("U:alice",crate::store::AccountBlobKind::Os3Conversation).await.unwrap() {
                let envelope = cosmos_crypto::EncryptedData { kid:"U:alice/os3/conversation".to_owned(), data };
                if let Some(plain) = keys.open(&envelope).await.unwrap() {
                    let state: Value = serde_json::from_slice(&plain).unwrap();
                    if state["unfinished"]["agents"].get("original_worker").is_some() {
                        assert_eq!(state["session_id"],"http_session");
                        assert_eq!(state["unfinished"]["boundary"],"original_echo");
                        break;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("authenticated HTTP accepted task must checkpoint original worker before its foreground finishes");
}

#[tokio::test]
async fn authenticated_http_os3_retains_task_across_router_reconstruction_and_sse() {
    let Some((store, keys, dir)) = setup(
        "http::os3_tests::authenticated_http_os3_retains_task_across_router_reconstruction_and_sse",
    )
    .await
    else {
        return;
    };
    let rabbit = Rabbit::start(Scenario::Result).await;
    let first = tokio::spawn(post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        TASK,
    ));
    wait_for_checkpoint(&store, &keys).await;
    let (status, body) = first.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Checking the fixture"));
    let (status, body) = post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace/stream",
        "What did OS3 find?",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Synthetic task result"));
    let packets = rabbit.sent();
    let inits: Vec<_> = packets.iter().filter(|p| p["type"] == "init").collect();
    assert_eq!(inits.len(), 2);
    assert!(inits[0].get("sessionId").is_none());
    assert_eq!(
        inits[1]["sessionId"], "http_session",
        "next HTTP request must resume retained session"
    );
    assert_eq!(
        packets
            .iter()
            .filter(|p| p["type"] == "chat.message" && p["text"] == TASK)
            .count(),
        1,
        "accepted task is never resent"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn authenticated_http_os3_cancel_preempts_only_same_account_task() {
    let Some((store, keys, dir)) =
        setup("http::os3_tests::authenticated_http_os3_cancel_preempts_only_same_account_task")
            .await
    else {
        return;
    };
    let rabbit = Rabbit::start(Scenario::Cancel).await;
    let first = tokio::spawn(post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        TASK,
    ));
    wait_for_checkpoint(&store, &keys).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let queued: Vec<_> = [Some("bob"), None]
        .into_iter()
        .map(|account| {
            tokio::spawn(post_as(
                app(store.clone(), keys.clone()),
                account,
                "/demo-api/trace",
                "cancel OS3",
            ))
        })
        .collect();
    let packet_count = rabbit.sent().len();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(
        !first.is_finished(),
        "other principal/guest cannot preempt original foreground"
    );
    assert!(
        queued.iter().all(|request| !request.is_finished()),
        "unrelated callers wait for existing serialization"
    );
    assert_eq!(rabbit.connections.load(Ordering::SeqCst), 1);
    assert_eq!(
        rabbit.sent().len(),
        packet_count,
        "unrelated callers send no stop or resume packet"
    );
    let started = std::time::Instant::now();
    let (status, body) = post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        "cancel OS3",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("OS3 stopped your task"),
        "same-account cancel resumes original worker: {body}"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "same-account cancel preempts active wait"
    );
    assert!(first.is_finished());
    let _ = first.await.unwrap();
    for request in queued {
        let (_, body) = request.await.unwrap();
        assert!(
            body.contains("no Luma OS3 task"),
            "unrelated caller cannot read or resume original task: {body}"
        );
        assert!(!body.contains("Checking the fixture") && !body.contains("OS3 stopped your task"));
    }
    assert_eq!(
        rabbit.connections.load(Ordering::SeqCst),
        2,
        "only owner reconnects"
    );
    let packets = rabbit.sent();
    assert_eq!(
        packets
            .iter()
            .filter(|p| p["type"] == "chat.message" && p["text"] == TASK)
            .count(),
        1
    );
    assert_eq!(
        packets
            .iter()
            .filter(|p| p["type"] == "init")
            .next_back()
            .unwrap()["sessionId"],
        "http_session"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn authenticated_http_os3_owner_input_is_not_automatically_answered() {
    let Some((store, keys, dir)) =
        setup("http::os3_tests::authenticated_http_os3_owner_input_is_not_automatically_answered")
            .await
    else {
        return;
    };
    let rabbit = Rabbit::start(Scenario::Permission).await;
    let (status, body) = post_as(
        app(store.clone(), keys),
        Some("alice"),
        "/demo-api/trace",
        TASK,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("owner's input"));
    assert!(
        store
            .get_account_blob("U:alice", crate::store::AccountBlobKind::Os3Conversation)
            .await
            .unwrap()
            .is_some(),
        "input checkpoint is retained"
    );
    assert!(
        !rabbit
            .sent()
            .iter()
            .any(|p| p.get("answeredCard").is_some()),
        "no owner permission answered"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn authenticated_http_os3_changed_cookie_and_invalid_identity_do_not_reach_task() {
    let Some((store,keys,dir)) = setup("http::os3_tests::authenticated_http_os3_changed_cookie_and_invalid_identity_do_not_reach_task").await else { return; };
    let rabbit = Rabbit::start(Scenario::Result).await;
    let first = tokio::spawn(post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        TASK,
    ));
    wait_for_checkpoint(&store, &keys).await;
    let _ = first.await.unwrap();
    for path in [
        "/demo-api/chat",
        "/demo-api/trace",
        "/demo-api/trace/stream",
    ] {
        let response = app(store.clone(), keys.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer synthetic-invalid-jwt")
                    .body(Body::from(
                        json!({"text":"cancel OS3","simulate_unlocked_pin":true}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "invalid bearer closed on {path}"
        );
    }
    let response = app(store.clone(), keys.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/demo-api/trace")
                .header("content-type", "application/json")
                .header(
                    crate::config::EDGE_PRINCIPAL_HEADER,
                    "V:01:D:httpfixture:U:alice",
                )
                .header(crate::config::EDGE_TOKEN_HEADER, "wrong-proof")
                .body(Body::from(
                    json!({"text":"cancel OS3","simulate_unlocked_pin":true}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    crate::integrations::active()
        .update(crate::integrations::IntegrationsUpdate {
            os3: Some(crate::integrations::Os3Update {
                session_cookie: Some("session=synthetic-changed-account".to_owned()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .unwrap();
    let (_, body) = post_as(
        app(store.clone(), keys),
        Some("alice"),
        "/demo-api/trace",
        "cancel OS3",
    )
    .await;
    assert!(body.contains("no Luma OS3 task"));
    assert_eq!(
        rabbit.connections.load(Ordering::SeqCst),
        1,
        "invalid identity and new cookie never connect to old task"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn authenticated_http_os3_unrelated_canceled_worker_cannot_confirm_stop() {
    let Some((store, keys, dir)) = setup(
        "http::os3_tests::authenticated_http_os3_unrelated_canceled_worker_cannot_confirm_stop",
    )
    .await
    else {
        return;
    };
    let rabbit = Rabbit::start(Scenario::UnrelatedCancel).await;
    let first = tokio::spawn(post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        TASK,
    ));
    wait_for_checkpoint(&store, &keys).await;
    let _ = first.await.unwrap();
    let (_, body) = post_as(
        app(store.clone(), keys),
        Some("alice"),
        "/demo-api/trace",
        "cancel OS3",
    )
    .await;
    assert!(
        body.contains("Stop requested"),
        "cancel reaches retained task: {body}"
    );
    assert!(
        !body.contains("OS3 stopped your task"),
        "only original worker cancellation can confirm stopped"
    );
    assert_eq!(rabbit.connections.load(Ordering::SeqCst), 2);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Failure plan, before implementation: a permission pause must keep the
/// original sealed task. A spoken yes must not approve it or create new work;
/// a natural update must read the same task without a second chat/model run;
/// a provider/tool error must not erase a still-running worker. Reconstructing
/// the HTTP router must recover the eventual outcome. Another account must
/// never inherit that task. All packets below are synthetic, owner-spec shapes.
#[tokio::test]
async fn authenticated_http_os3_permission_resume_uses_read_only_natural_updates() {
    let Some((store, keys, dir)) = setup(
        "http::os3_tests::authenticated_http_os3_permission_resume_uses_read_only_natural_updates",
    )
    .await
    else {
        return;
    };
    let rabbit = Rabbit::start(Scenario::PermissionLifecycle).await;
    let (status, paused) = post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        TASK,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(paused.contains("owner's input"));
    wait_for_checkpoint(&store, &keys).await;

    let (_, other_account) = post_as(
        app(store.clone(), keys.clone()),
        Some("bob"),
        "/demo-api/trace",
        "Give me an update",
    )
    .await;
    assert!(
        !other_account.contains("Checking the fixture")
            && !other_account.contains("Synthetic task result")
    );
    assert_eq!(
        rabbit.connections.load(Ordering::SeqCst),
        1,
        "a natural follow-up cannot inherit another account's task"
    );

    let (status, owner_input) = post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        "Yes",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        owner_input.contains("permissions in OS3"),
        "a local voice acknowledgement cannot answer a remote permission: {owner_input}"
    );
    assert_eq!(rabbit.connections.load(Ordering::SeqCst), 1);
    wait_for_checkpoint(&store, &keys).await;

    // The fixture models an owner-completed OS3 approval. Cosmos itself sends
    // no card answer. A later connection observes independent worker progress.
    let (status, progress) = post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace/stream",
        "Give me an update",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        progress.contains("error"),
        "the service error is reported: {progress}"
    );
    assert!(
        progress.contains("still working") || progress.contains("still pending"),
        "a nonterminal service error cannot claim the worker stopped: {progress}"
    );
    assert_eq!(rabbit.connections.load(Ordering::SeqCst), 2);
    wait_for_checkpoint(&store, &keys).await;
    let (status, complete) = post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        "Is it done?",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        complete.contains("Synthetic task result"),
        "the retained result reaches normal Respond: {complete}"
    );
    let packets = rabbit.sent();
    let chats: Vec<_> = packets
        .iter()
        .filter(|p| p["type"] == "chat.message")
        .collect();
    assert_eq!(chats.len(), 1, "updates never start new Rabbit work");
    assert_eq!(chats[0]["text"], TASK);
    assert!(packets.iter().all(|p| p.get("answeredCard").is_none()));
    let inits: Vec<_> = packets.iter().filter(|p| p["type"] == "init").collect();
    assert_eq!(inits.len(), 3);
    assert!(
        inits
            .iter()
            .skip(1)
            .all(|p| p["sessionId"] == "http_session")
    );
    let proof = json!({
        "workflow":"authenticated_http_os3_permission_resume_uses_read_only_natural_updates",
        "source":"synthetic_unrecorded_owner_spec",
        "same_session_reconnects":inits.len()-1,
        "remote_chat_submissions":chats.len(),
        "remote_card_answers":0,
        "permission_pause_preserved":true,
        "local_yes_preserved_owner_control":true,
        "other_account_did_not_inherit_task":true,
        "nonterminal_error_preserved_task":true,
        "natural_follow_up_returned_result":true
    });
    let proof_path = std::env::temp_dir().join(format!(
        "luma-os3-http-lifecycle-{}.json",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&proof_path, serde_json::to_vec_pretty(&proof).unwrap()).unwrap();
    println!("OS3 workflow artifact: {}", proof_path.display());
    std::fs::remove_dir_all(dir).unwrap();
}

/// Failure plan, before this priority correction: an older retained Rabbit
/// task cannot steal the wearer's yes/cancel/update when the newest stock
/// replayed run instead asked a local call question. The existing exact-action
/// policy checks prove call confirmation. This HTTP workflow proves separation
/// from the real OS3 handoff without a provider account or a physical call.
#[tokio::test]
async fn authenticated_http_os3_shortcuts_respect_a_newer_local_conversation() {
    use base64::Engine as _;
    use cosmos_protocol::aibus::{
        SynapseActionContent, SynapseChatTurn, SynapseDeviceContext, synapse_chat_turn::Content,
    };
    use prost::Message as _;
    let Some((store, keys, dir)) = setup(
        "http::os3_tests::authenticated_http_os3_shortcuts_respect_a_newer_local_conversation",
    )
    .await
    else {
        return;
    };
    let rabbit = Rabbit::start(Scenario::Permission).await;
    let (_, paused) = post_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        TASK,
    )
    .await;
    assert!(paused.contains("owner's input"));
    wait_for_checkpoint(&store, &keys).await;
    let context = SynapseDeviceContext {
        turns: vec![
            SynapseChatTurn {
                identifier: "earlier_os3".to_owned(),
                content: Some(Content::Action(SynapseActionContent {
                    action: "ask_os3".to_owned(),
                    input: "{}".to_owned(),
                    ..Default::default()
                })),
                ..Default::default()
            },
            SynapseChatTurn {
                identifier: "earlier_os3_answer".to_owned(),
                parent_identifier: "earlier_os3".to_owned(),
                content: Some(Content::Action(SynapseActionContent {
                    action: "Respond".to_owned(),
                    input: json!({"response":"Approve any permissions in OS3."}).to_string(),
                    ..Default::default()
                })),
                ..Default::default()
            },
            SynapseChatTurn {
                identifier: "newer_local_answer".to_owned(),
                content: Some(Content::Action(SynapseActionContent {
                    action: "Respond".to_owned(),
                    input: json!({"response":"Call Dana?"}).to_string(),
                    ..Default::default()
                })),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let replay = base64::engine::general_purpose::STANDARD.encode(context.encode_to_vec());
    for text in ["Yes", "Cancel it", "Give me an update"] {
        let (status, body) = post_payload_as(
            app(store.clone(), keys.clone()),
            Some("alice"),
            "/demo-api/trace",
            json!({"text":text,"simulate_unlocked_pin":true,"replay":replay}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            !body.contains("permissions in OS3")
                && !body.contains("Stop requested")
                && !body.contains("OS3 stopped your task"),
            "newer local conversation owns the shortcut {text}: {body}"
        );
        assert_eq!(
            rabbit.connections.load(Ordering::SeqCst),
            1,
            "newer local conversation does not resume or cancel older Rabbit work"
        );
        wait_for_checkpoint(&store, &keys).await;
    }
    assert_eq!(
        rabbit
            .sent()
            .iter()
            .filter(|p| p["type"] == "chat.message")
            .count(),
        1
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// Failure plan before the replay-priority correction: the Pin replays every
/// completed voice run. A local yes that only explains owner-controlled OS3
/// permission must preserve the immediately preceding typed OS3 conversation;
/// the next status/cancel must remain scoped to that task. No fake tool action
/// or approval may be emitted merely to remember conversational context.
#[tokio::test]
async fn authenticated_http_os3_owner_acknowledgement_preserves_stock_replayed_context() {
    let Some((store, keys, dir)) = setup(
        "http::os3_tests::authenticated_http_os3_owner_acknowledgement_preserves_stock_replayed_context",
    )
    .await
    else { return; };
    let rabbit = Rabbit::start(Scenario::PermissionLifecycle).await;
    let (_, first) = post_payload_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        json!({"text":TASK,"simulate_unlocked_pin":true,"replay":""}),
    )
    .await;
    let first: Value = serde_json::from_str(&first).unwrap();
    assert!(first["reply"].as_str().unwrap().contains("owner's input"));
    let (_, yes) = post_payload_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        json!({"text":"Yes","simulate_unlocked_pin":true,"replay":first["replay"]}),
    )
    .await;
    let yes: Value = serde_json::from_str(&yes).unwrap();
    assert!(
        yes["reply"]
            .as_str()
            .unwrap()
            .contains("permissions in OS3")
    );
    assert!(
        yes["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|step| step["name"] != "ask_os3"),
        "local acknowledgement must not invent a provider call"
    );
    assert_eq!(rabbit.connections.load(Ordering::SeqCst), 1);
    let (_, progress) = post_payload_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        json!({"text":"Give me an update","simulate_unlocked_pin":true,"replay":yes["replay"]}),
    )
    .await;
    let progress: Value = serde_json::from_str(&progress).unwrap();
    assert!(
        progress["reply"]
            .as_str()
            .unwrap()
            .contains("still working")
            || progress["reply"]
                .as_str()
                .unwrap()
                .contains("still pending"),
        "local owner-input direction preserves typed OS3 scope through stock replay: {progress}"
    );
    assert_eq!(rabbit.connections.load(Ordering::SeqCst), 2);
    let (_, complete) = post_payload_as(
        app(store.clone(), keys.clone()),
        Some("alice"),
        "/demo-api/trace",
        json!({"text":"Is it done?","simulate_unlocked_pin":true,"replay":progress["replay"]}),
    )
    .await;
    let complete: Value = serde_json::from_str(&complete).unwrap();
    assert!(
        complete["reply"]
            .as_str()
            .unwrap()
            .contains("Synthetic task result")
    );
    assert_eq!(
        rabbit
            .sent()
            .iter()
            .filter(|p| p["type"] == "chat.message")
            .count(),
        1
    );
    assert!(
        rabbit
            .sent()
            .iter()
            .all(|p| p.get("answeredCard").is_none())
    );
    std::fs::remove_dir_all(dir).unwrap();
}
