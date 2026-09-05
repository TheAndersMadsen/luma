use super::*;
use crate::{
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    store::SharedStore,
    surface_registry::{self, Mutation},
};
use axum::{body::Body, http::Request};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header};
use tower::ServiceExt;

#[test]
fn realtime_readiness_never_uses_assistant_or_codex_credentials() {
    let mut config = crate::integrations::IntegrationsConfig::default();
    config.assistant.api_key = Some("synthetic-assistant-key".to_owned());
    config.assistant.base_url = "https://example.test".to_owned();
    assert_eq!(readiness_view(&config)["textInputConfigured"], false);
    config.assistant.provider = crate::integrations::AssistantProvider::CodexSubscription;
    assert_eq!(readiness_view(&config)["textInputConfigured"], false);
    config.realtime.api_key = Some("synthetic-realtime-key".to_owned());
    assert_eq!(
        readiness_view(&config),
        json!({"version":1,"textInputConfigured":true,"approvedSurfaceRequired":true})
    );
    assert!(!readiness_view(&config).to_string().contains("synthetic"));
    config.realtime.api_key = None;
    assert_eq!(readiness_view(&config)["textInputConfigured"], false);
}
#[tokio::test]
async fn browser_runtime_api_auth_precedes_body_and_authorized_body_is_bounded() {
    let (app, _, _, _, token) = fixture().await;
    let pending = Body::from_stream(futures_util::stream::pending::<
        Result<axum::body::Bytes, std::io::Error>,
    >());
    let request = Request::builder()
        .method("POST")
        .uri("/runtime-api/v1/browser/input")
        .header("content-type", "application/json")
        .body(pending)
        .unwrap();
    let response = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        app.clone().oneshot(request),
    )
    .await
    .expect("unauthenticated body must not be read")
    .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        call(
            &app,
            "input",
            Some(&bearer("owner")),
            Some(&token),
            json!({"text":"x".repeat(9000)})
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn browser_runtime_api_room_rejects_unauthenticated_and_unbounded_bootstrap() {
    let (app, _, id, incarnation, token) = fixture().await;
    let body = json!({"surfaceId":id,"incarnation":incarnation,"epoch":Uuid::new_v4()});
    assert_eq!(
        call(&app, "room", None, Some(&token), body.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "room", Some(&bearer("owner")), None, body)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "room",
            Some(&bearer("owner")),
            Some(&token),
            json!({"extra":"x".repeat(9000)})
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
}
struct Model;
#[tonic::async_trait]
impl ChatModel for Model {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        assert_eq!(messages.len(), 2);
        assert_eq!(tools.len(), 1);
        Ok(ChatResponse { tool_call: Some(ToolCall { name: "propose_information".into(), arguments: json!({"intent":{"kind":"visual_text_card","text":"Public answer"},"privacy":"public"}).to_string() }), ..Default::default() })
    }
}
fn verifier() -> Arc<JwtVerifier> {
    let (_, public) = crate::web_auth::test_jwt_keypair();
    JwtVerifier::with_keys(
        crate::web_auth::OidcConfig {
            issuer: "https://runtime.test".into(),
            audience: Some("runtime-test".into()),
            jwks_uri: "unused".into(),
        },
        [(
            "runtime-test".into(),
            DecodingKey::from_rsa_pem(public.as_bytes()).unwrap(),
        )]
        .into(),
    )
}
fn bearer(subject: &str) -> String {
    let (private, _) = crate::web_auth::test_jwt_keypair();
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("runtime-test".into());
    format!("Bearer {}", jsonwebtoken::encode(&header, &json!({"sub":subject,"iss":"https://runtime.test","aud":"runtime-test","exp":surface_registry::now_ms()/1000+300}), &EncodingKey::from_rsa_pem(private.as_bytes()).unwrap()).unwrap())
}
async fn call(
    app: &Router,
    operation: &str,
    bearer: Option<&str>,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(format!("/runtime-api/v1/browser/{operation}"))
        .header("content-type", "application/json");
    if let Some(bearer) = bearer {
        request = request.header("authorization", bearer);
    }
    if let Some(token) = token {
        request = request.header("x-cosmos-surface-token", token);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 196608)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn fixture() -> (Router, SharedStore, Uuid, Uuid, String) {
    let store: SharedStore = Arc::new(crate::store::MemoryStore::default());
    let id = Uuid::new_v4();
    let incarnation = Uuid::new_v4();
    let token = "a".repeat(64);
    let hash = surface_registry::hash(token.as_bytes());
    store
        .mutate_surface(
            "U:owner",
            id,
            Mutation::Approve {
                token_hash: hash.clone(),
                incarnation,
            },
        )
        .await
        .unwrap();
    store
        .mutate_surface(
            "U:owner",
            id,
            Mutation::State {
                token_hash: hash,
                incarnation,
                sequence: 1,
                visible: true,
            },
        )
        .await
        .unwrap();
    let runtime = Arc::new(AmbianceRuntime::new(store.clone(), Arc::new(Model), None));
    (
        with_verifier(runtime, Some(verifier())),
        store,
        id,
        incarnation,
        token,
    )
}
#[tokio::test]
async fn browser_runtime_api_requires_owner_and_current_capability_before_cognition() {
    let (app, _, id, incarnation, token) = fixture().await;
    let request = json!({"surfaceId":id,"incarnation":incarnation,"text":"hello"});
    assert_eq!(
        call(&app, "input", None, Some(&token), request.clone())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "input", Some(&bearer("owner")), None, request.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "input",
            Some(&bearer("other")),
            Some(&token),
            request.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "input",
            Some(&bearer("owner")),
            Some(&token),
            json!({"surfaceId":id,"incarnation":Uuid::new_v4(),"text":"hello"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "input",
            Some(&bearer("owner")),
            Some(&token),
            json!({"surfaceId":id,"incarnation":incarnation,"text":"hello","trust":9})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime-api/v1/browser/poll")
                .header("content-type", "application/json")
                .header("x-forwarded-client-cert", "attacker")
                .body(Body::from(
                    json!({"surfaceId":id,"incarnation":incarnation}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn browser_runtime_api_committed_poll_exact_ack_and_hidden_dismissal() {
    let (app, store, id, incarnation, token) = fixture().await;
    let owner = bearer("owner");
    assert_eq!(
        call(
            &app,
            "input",
            Some(&owner),
            Some(&token),
            json!({"surfaceId":id,"incarnation":incarnation,"text":"hello"})
        )
        .await,
        (StatusCode::OK, json!({"accepted":true}))
    );
    let (_, result) = call(
        &app,
        "poll",
        Some(&owner),
        Some(&token),
        json!({"surfaceId":id,"incarnation":incarnation}),
    )
    .await;
    let command = &result["commands"][0];
    assert_eq!(command["content"]["text"], "Public answer");
    assert_eq!(
        command["contentDigest"],
        surface_registry::hash(b"Public answer")
    );
    let mut proof = command.clone();
    for key in ["version", "content", "expiresAt"] {
        proof.as_object_mut().unwrap().remove(key);
    }
    for (key, wrong) in [
        ("generation", json!(999)),
        ("turnId", json!(Uuid::new_v4())),
        ("contentDigest", json!("b".repeat(64))),
        ("incarnation", json!(Uuid::new_v4())),
    ] {
        let mut stale = proof.clone();
        stale[key] = wrong;
        assert_ne!(
            call(&app, "ack", Some(&owner), Some(&token), stale).await.0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(&app, "ack", Some(&owner), Some(&token), proof.clone()).await,
        (StatusCode::OK, json!({"acknowledged":true}))
    );
    let (_, repeated) = call(
        &app,
        "poll",
        Some(&owner),
        Some(&token),
        json!({"surfaceId":id,"incarnation":incarnation}),
    )
    .await;
    assert_eq!(repeated["commands"][0], *command);
    store
        .mutate_surface(
            "U:owner",
            id,
            Mutation::State {
                token_hash: surface_registry::hash(token.as_bytes()),
                incarnation,
                sequence: 2,
                visible: false,
            },
        )
        .await
        .unwrap();
    let (_, hidden) = call(
        &app,
        "poll",
        Some(&owner),
        Some(&token),
        json!({"surfaceId":id,"incarnation":incarnation}),
    )
    .await;
    assert_eq!(hidden["commands"], json!([]));
    assert!(!hidden.to_string().contains("Public answer"));
    assert_ne!(
        call(&app, "ack", Some(&owner), Some(&token), proof).await.0,
        StatusCode::OK
    );
}
