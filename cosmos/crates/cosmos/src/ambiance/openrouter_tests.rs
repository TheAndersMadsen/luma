use super::*;
use crate::ambiance::{
    PrivacyClass, SemanticIntent,
    analysis::{Proposal, proposal_tool},
};

fn model() -> OpenRouterTextModel {
    OpenRouterTextModel::new(RealtimeConfig {
        provider: RealtimeProvider::OpenRouterText,
        api_key: Some("synthetic-openrouter-key".into()),
        model: "openai/gpt-4.1-mini".into(),
        upstream: Some("openai".into()),
        ..Default::default()
    })
    .unwrap()
}
fn input() -> ([ChatMessage; 2], [ToolDef; 1]) {
    (
        [
            ChatMessage::system("Propose information only."),
            ChatMessage::user("What is 15 percent of 80?"),
        ],
        [proposal_tool()],
    )
}
fn response() -> Value {
    json!({"choices":[{"index":0,"finish_reason":"tool_calls","message":{
        "role":"assistant","content":null,"tool_calls":[{"id":"call_test","type":"function","function":{
            "name":"propose_information","arguments":r#"{"intent":{"kind":"visual_text_card","text":"12"},"privacy":"public"}"#
        }}]
    }}]})
}

#[test]
fn openrouter_proposal_requires_one_completed_exact_call_without_prose() {
    let valid = response();
    assert_eq!(
        parse(&serde_json::to_vec(&valid).unwrap())
            .unwrap()
            .tool_call
            .unwrap()
            .arguments,
        valid["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
    );
    for reason in ["stop", "length", "error", "content_filter", "cancelled"] {
        let mut changed = valid.clone();
        changed["choices"][0]["finish_reason"] = reason.into();
        assert!(parse(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    for (pointer, replacement) in [
        ("/error", json!({"message":"failed"})),
        ("/choices/0/message/content", json!("I sent the message")),
        ("/choices/0/message/role", json!("user")),
        ("/choices/0/message/tool_calls/0/id", json!("")),
        ("/choices/0/message/tool_calls/0/type", json!("server_tool")),
        (
            "/choices/0/message/tool_calls/0/function/name",
            json!("send_message"),
        ),
        (
            "/choices/0/message/tool_calls/0/function/arguments",
            json!("{}"),
        ),
        (
            "/choices/0/message/tool_calls/0/function/arguments",
            json!("x".repeat(16385)),
        ),
    ] {
        let mut changed = valid.clone();
        if pointer == "/error" {
            changed["error"] = replacement;
        } else {
            *changed.pointer_mut(pointer).unwrap() = replacement;
        }
        assert!(
            parse(&serde_json::to_vec(&changed).unwrap()).is_err(),
            "reject {pointer}"
        );
    }
    for field in [
        "refusal",
        "reasoning",
        "reasoning_details",
        "function_call",
        "audio",
        "images",
    ] {
        let mut changed = valid.clone();
        changed["choices"][0]["message"][field] = "unexpected".into();
        assert!(parse(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    for pointer in ["/choices", "/choices/0/message/tool_calls"] {
        let mut changed = valid.clone();
        let entries = changed
            .pointer_mut(pointer)
            .unwrap()
            .as_array_mut()
            .unwrap();
        entries.push(entries[0].clone());
        assert!(parse(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
}

#[tokio::test]
async fn openrouter_http_uses_only_selected_upstream_bounds_and_no_redirects() {
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let redirects = Arc::new(AtomicUsize::new(0));
    let forbidden = redirects.clone();
    let app = Router::new()
        .route(
            "/chat",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(headers["authorization"], "Bearer synthetic-openrouter-key");
                    assert_eq!(
                        body["provider"],
                        json!({"only":["openai"],"allow_fallbacks":false,"require_parameters":true})
                    );
                    assert_eq!(body["stream"], false);
                    assert_eq!(body["max_tokens"], 1024);
                    assert!(body.get("n").is_none() && body.get("parallel_tool_calls").is_none());
                    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
                    assert_eq!(body["tools"].as_array().unwrap().len(), 1);
                    assert_eq!(
                        body["tool_choice"],
                        json!({"type":"function","function":{"name":"propose_information"}})
                    );
                    match body["model"].as_str().unwrap() {
                        "test/redirect" => (
                            StatusCode::TEMPORARY_REDIRECT,
                            [("location", "/forbidden")],
                            "",
                        )
                            .into_response(),
                        "test/oversized" => "x".repeat(MAX_RESPONSE + 1).into_response(),
                        _ => Json(response()).into_response(),
                    }
                }
            }),
        )
        .route(
            "/forbidden",
            post(move || {
                let forbidden = forbidden.clone();
                async move {
                    forbidden.fetch_add(1, Ordering::SeqCst);
                    StatusCode::OK
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/chat", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (messages, tools) = input();
    for (name, succeeds) in [
        ("openai/gpt-4.1-mini", true),
        ("test/redirect", false),
        ("test/oversized", false),
    ] {
        let mut selected = model();
        selected.config.model = name.into();
        assert_eq!(
            selected
                .exchange(&url, &messages, &tools, DEADLINE)
                .await
                .is_ok(),
            succeeds
        );
    }
    assert!(
        model()
            .exchange(&url, &messages[..1], &tools, DEADLINE)
            .await
            .is_err()
    );
    let mut other = proposal_tool();
    other.name = "send_message".into();
    assert!(
        model()
            .exchange(&url, &messages, &[other], DEADLINE)
            .await
            .is_err()
    );
    assert_eq!(count.load(Ordering::SeqCst), 3);
    assert_eq!(redirects.load(Ordering::SeqCst), 0);
    assert!(OpenRouterTextModel::new(RealtimeConfig::default()).is_err());
    server.abort();
}

#[tokio::test]
async fn openrouter_cancellation_and_deadline_close_the_owned_pending_body() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for cancel in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/chat", listener.local_addr().unwrap());
        let (started, arrived) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 8192];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n1\r\n{\r\n").await.unwrap();
            started.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                let mut remaining = 0;
                loop {
                    let n = match socket.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                        Err(error) => panic!("unexpected response closure: {}", error.kind()),
                    };
                    remaining += n;
                    assert!(remaining < 65536);
                }
            })
            .await
            .expect("dropping the owned request must close the response");
        });
        let request = tokio::spawn(async move {
            let (messages, tools) = input();
            model()
                .exchange(&url, &messages, &tools, Duration::from_millis(300))
                .await
        });
        arrived.await.unwrap();
        if cancel {
            request.abort();
            assert!(request.await.unwrap_err().is_cancelled());
        } else {
            assert!(request.await.unwrap().is_err());
        }
        server.await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires explicitly supplied OpenRouter test configuration; makes one billed synthetic request"]
async fn openrouter_live_public_proposal() {
    use std::io::Read;
    assert_eq!(
        std::env::var("COSMOS_OPENROUTER_TEST_STDIN").as_deref(),
        Ok("1"),
        "explicitly supply approved configuration through stdin"
    );
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(16385)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 16384);
    let config: RealtimeConfig = serde_json::from_slice(&bytes).unwrap();
    let selected = OpenRouterTextModel::new(config).unwrap();
    let messages = [
        ChatMessage::system(
            "Use propose_information exactly once. Answer directly with a public visual_text_card. You have no memory or device actions.",
        ),
        ChatMessage::user("What is 15 percent of 80? Use only the number as the card text."),
    ];
    let result = selected
        .complete(&messages, &[proposal_tool()])
        .await
        .expect("the configured provider must return one valid proposal");
    let proposal: Proposal = serde_json::from_str(&result.tool_call.unwrap().arguments).unwrap();
    let Proposal::Information {
        intent: SemanticIntent::VisualTextCard { text },
        privacy,
    } = proposal
    else {
        panic!("expected one direct visual proposal")
    };
    assert_eq!(text.trim(), "12");
    assert!(privacy <= PrivacyClass::SharedRoom);
}
