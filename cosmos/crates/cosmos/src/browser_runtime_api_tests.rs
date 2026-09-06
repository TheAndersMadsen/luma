use super::*;
use crate::{
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolDef},
    store::SharedStore,
    surface_registry::{self, Mutation},
};
use axum::{body::Body, http::Request};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header};
use tower::ServiceExt;

fn render_action(intent: SemanticIntent) -> Action {
    Action {
        id: Uuid::new_v4(),
        root_id: Uuid::new_v4(),
        confirmation_root: None,
        turn_id: Uuid::new_v4(),
        generation: 3,
        worker: Uuid::new_v4(),
        surface_id: Uuid::new_v4(),
        channel: intent.channel(),
        incarnation: Uuid::new_v4(),
        content_digest: intent.content_digest(),
        intent,
        privacy: crate::ambiance::PrivacyClass::SharedRoom,
        status: crate::ambiance::ActionStatus::Dispatched,
        deadline_ms: 10_000,
        display_expires_at_ms: 20_000,
        attempts: 1,
        fallbacks: Vec::new(),
    }
}

fn place_card(query: &str) -> Card {
    Card::from_lookup(
        query,
        &crate::backends::places::LookupEvidence {
            places: vec![crate::backends::places::LookupPlace {
                place_id: "synthetic-place-id".into(),
                name: "Fixture Café".into(),
                address: "Example Street 1, Copenhagen".into(),
                latitude: 55.67,
                longitude: 12.56,
                source_url: Some("https://maps.google.com/?cid=123".into()),
            }],
            html_attributions: vec![
                "<a href=\"https://credit.test/\">Fixture &amp; Co</a>".into(),
                "Synthetic provider credit".into(),
            ],
            privacy_floor: crate::ambiance::PrivacyClass::SharedRoom,
        },
    )
    .unwrap()
}

#[test]
fn browser_runtime_command_preserves_text_wire_and_requires_matching_transient_places() {
    let text = render_action(SemanticIntent::VisualTextCard {
        text: "Existing text \"wire\"\nwith Unicode æøå".into(),
    });
    assert_eq!(
        command(&text, None),
        Some(
            json!({"version":1,"actionId":text.id,"turnId":text.turn_id,"generation":text.generation,"surfaceId":text.surface_id,"incarnation":text.incarnation,"channel":"visual.card","contentDigest":text.content_digest,"content":{"kind":"text","text":text.intent.text()},"expiresAt":text.display_expires_at_ms})
        )
    );
    let card = place_card("cafes in Copenhagen");
    assert_eq!(command(&text, Some(&card)), command(&text, None));
    let reference = crate::ambiance::visual::Reference {
        id: Uuid::new_v4(),
        digest: card.digest(),
        expires_at_ms: 20_000,
    };
    let action = render_action(SemanticIntent::PlaceAddressCard { content: reference });
    assert!(command(&action, None).is_none());
    let rendered = command(&action, Some(&card)).unwrap();
    assert_eq!(rendered["content"], card.value());
    assert_eq!(rendered["content"]["kind"], "places");
    assert_eq!(
        rendered["content"]["attributions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        rendered["content"]["attributions"][0],
        "<a href=\"https://credit.test/\">Fixture &amp; Co</a>"
    );
    assert!(rendered["content"].get("text").is_none());
    assert!(rendered["content"]["items"][0].get("latitude").is_none());
    assert_eq!(rendered["contentDigest"], card.digest());
    let other = place_card("restaurants in Copenhagen");
    assert!(command(&action, Some(&other)).is_none());
    let mut wrong_digest = action.clone();
    wrong_digest.content_digest = surface_registry::hash(b"different digest");
    assert!(command(&wrong_digest, Some(&card)).is_none());
    let mut nonvisual = action;
    nonvisual.channel = Channel::AudioTts;
    assert!(command(&nonvisual, Some(&card)).is_none());
    let speech = render_action(SemanticIntent::InformationalSpeech {
        text: "speech".into(),
    });
    assert!(command(&speech, None).is_none());
}

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
pub(super) fn verifier() -> Arc<JwtVerifier> {
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
pub(super) fn bearer(subject: &str) -> String {
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
    let rooms = Arc::new(crate::browser_rooms::Rooms::new(runtime.clone(), None));
    (
        with_rooms(runtime, Some(verifier()), rooms),
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
    let rooms = Arc::new(crate::browser_rooms::Rooms::new(
        runtime.clone(),
        Some(
            crate::browser_rooms::Config::new(
                url.into(),
                url.into(),
                input["key"].as_str().unwrap().into(),
                input["secret"].as_str().unwrap().into(),
            )
            .unwrap(),
        ),
    ));
    let app = with_rooms(runtime, Some(verifier()), rooms);
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
