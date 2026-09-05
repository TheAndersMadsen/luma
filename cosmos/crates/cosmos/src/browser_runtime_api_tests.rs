use super::*;
use crate::{
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolDef},
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
        .uri("/runtime-api/v1/browser/room")
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
            "room",
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
        _messages: &[ChatMessage],
        _tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        panic!("room bootstrap must not invoke cognition")
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
async fn browser_runtime_api_superseded_transports_are_absent() {
    let (app, _, _, _, _) = fixture().await;
    for operation in ["poll", "ack", "input"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/runtime-api/v1/browser/{operation}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_BROWSER_TEST_INPUT with an isolated localhost SFU"]
async fn browser_runtime_api_live_bootstrap_binds_owner_capability_and_epoch() {
    let input: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("COSMOS_RTC_BROWSER_TEST_INPUT").unwrap()).unwrap(),
    )
    .unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(url.starts_with("ws://127.0.0.1:"));
    let (_, store, id, incarnation, token) = fixture().await;
    let runtime = Arc::new(AmbianceRuntime::new(store, Arc::new(Model), None));
    let app = with_rooms(
        runtime,
        Some(verifier()),
        Some(
            crate::browser_rooms::Config::new(
                url.into(),
                url.into(),
                input["key"].as_str().unwrap().into(),
                input["secret"].as_str().unwrap().into(),
            )
            .unwrap(),
        ),
    );
    let epoch = Uuid::new_v4();
    let body = json!({"surfaceId": id, "incarnation":incarnation, "epoch":epoch});
    for (owner, capability) in [("other", token.clone()), ("owner", "f".repeat(64))] {
        assert_eq!(
            call(
                &app,
                "room",
                Some(&bearer(owner)),
                Some(&capability),
                body.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let (status, connected) = call(
        &app,
        "room",
        Some(&bearer("owner")),
        Some(&token),
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(connected["epoch"], epoch.to_string());
    assert_eq!(connected["runtimeParticipant"], "runtime");
    assert!(Uuid::parse_str(connected["participant"].as_str().unwrap()).is_ok());
    assert!(!connected.to_string().contains(&token));
    assert!(
        !connected
            .to_string()
            .contains(input["secret"].as_str().unwrap())
    );
    let mut replacement = body;
    replacement["epoch"] = Uuid::new_v4().to_string().into();
    assert_eq!(
        call(
            &app,
            "room",
            Some(&bearer("owner")),
            Some(&token),
            replacement
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}
