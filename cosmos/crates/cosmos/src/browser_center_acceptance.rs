//! Driven by center/verify/center-runtime-live.mjs against an actual Center
//! image and browser. Authentication and cognition are synthetic; the owner
//! APIs, PostgreSQL authority, SFU, BFF, React render and DOM acknowledgment run.
use super::*;
use crate::{
    ambiance::{ActionStatus, RuntimeState, SemanticIntent},
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    enrollment::{EnrollmentStore, MemoryEnrollmentStore},
    store::Store,
    surface_registry::{Mutation, pin_surface_id},
};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

struct Model {
    calls: AtomicUsize,
    provider: Option<crate::ambiance::openrouter::OpenRouterTextModel>,
}
#[tonic::async_trait]
impl ChatModel for Model {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(provider) = &self.provider {
            return provider.complete(messages, tools).await;
        }
        Ok(ChatResponse { tool_call: Some(ToolCall { name: "propose_information".into(),
            arguments: json!({"intent":SemanticIntent::VisualTextCard { text: "Center acceptance card".into() },"privacy":"public"}).to_string(),
        }), ..Default::default() })
    }
}

fn write_private(path: &str, value: &Value, create: bool) {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).mode(0o600);
    if create {
        options.create_new(true);
    } else {
        options.truncate(true);
    }
    let mut file = options.open(path).unwrap();
    file.write_all(value.to_string().as_bytes()).unwrap();
    file.sync_all().unwrap();
}

#[tokio::test]
#[ignore = "requires the isolated Center image/browser, PostgreSQL and SFU acceptance driver"]
async fn browser_center_application_acceptance() {
    let input: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("COSMOS_CENTER_TEST_INPUT").unwrap()).unwrap(),
    )
    .unwrap();
    let url = input["url"].as_str().unwrap();
    let public_url = input["publicUrl"].as_str().unwrap();
    let database = std::env::var("COSMOS_TEST_DATABASE_URL").unwrap();
    assert!(url.starts_with("ws://127.0.0.1:") && public_url.starts_with("wss://127.0.0.1:"));
    assert_eq!(
        reqwest::Url::parse(&database).unwrap().host_str(),
        Some("127.0.0.1")
    );
    let store = Arc::new(
        crate::store_postgres::PostgresStore::connect(&database)
            .await
            .unwrap(),
    );
    let audit = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&database)
        .await
        .unwrap();
    let subject = format!("center-acceptance-{}", Uuid::new_v4());
    let principal = format!("U:{subject}");
    let pairing = Arc::new(MemoryEnrollmentStore::default());
    pairing.put_device_account("aabb", &subject).await.unwrap();
    let pin_id = pin_surface_id(&principal, "aabb");
    store
        .mutate_surface(
            &principal,
            pin_id,
            Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
        )
        .await
        .unwrap();
    let provider = if std::env::var("COSMOS_CENTER_TEST_OPENROUTER_STDIN").as_deref() == Ok("1") {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::io::stdin()
            .lock()
            .take(16385)
            .read_to_end(&mut bytes)
            .unwrap();
        assert!(bytes.len() <= 16384);
        Some(
            crate::ambiance::openrouter::OpenRouterTextModel::new(
                serde_json::from_slice(&bytes).unwrap(),
            )
            .unwrap(),
        )
    } else {
        None
    };
    let model_mode = if provider.is_some() {
        "openrouter-text"
    } else {
        "synthetic"
    };
    let model = Arc::new(Model {
        calls: AtomicUsize::new(0),
        provider,
    });
    let runtime = Arc::new(AmbianceRuntime::new(
        store.clone(),
        model.clone(),
        Some(pairing.clone()),
    ));
    let config = crate::browser_rooms::Config::new(
        url.into(),
        public_url.into(),
        input["key"].as_str().unwrap().into(),
        input["secret"].as_str().unwrap().into(),
    )
    .unwrap();
    let app = with_rooms(runtime, Some(super::tests::verifier()), Some(config)).merge(
        crate::surface_api::with_pairing(
            store.clone(),
            Some(super::tests::verifier()),
            Some(pairing),
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let status_path = input["statusPath"].as_str().unwrap();
    write_private(
        status_path,
        &json!({"acknowledged":false,"complete":false}),
        true,
    );
    write_private(
        input["bootstrapPath"].as_str().unwrap(),
        &json!({
            "port":address.port(),"subject":subject,"bearer":super::tests::bearer(&subject),"pinId":pin_id,
        }),
        true,
    );
    let accepted = tokio::time::timeout(Duration::from_secs(240), async {
        let mut acknowledged = false;
        loop {
            let encoded: Option<String> = sqlx::query_scalar("SELECT state::text FROM cosmos_ambiance_runtime WHERE principal=$1")
                .bind(&principal).fetch_optional(&audit).await.unwrap();
            if let Some(encoded) = encoded {
                let state: RuntimeState = serde_json::from_str(&encoded).unwrap();
                let speech_revoked = state.disclosure_policies.get(&pin_id).is_some_and(|a| a.revision == 2 && a.policy.is_none());
                if state.actions.values().any(|a| a.status == ActionStatus::Acknowledged && a.intent.text() == "Center acceptance card") {
                    acknowledged = true;
                    write_private(status_path, &json!({"acknowledged":true,"complete":false}), false);
                }
                if acknowledged && speech_revoked && !state.actions.is_empty()
                    && state.actions.values().all(|a| a.status == ActionStatus::Cancelled && a.intent.text().is_empty())
                {
                    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
                    assert!(store.surfaces(&principal).await.unwrap().iter().filter(|s| s.surface_id != pin_id).all(|s| !s.connected));
                    write_private(status_path, &json!({"acknowledged":true,"complete":true,"modelCalls":1,"modelMode":model_mode,"speechPolicyRevision":2}), false);
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await;
    server.abort();
    let _ = server.await;
    audit.close().await;
    accepted.expect("Center must commit speech permission/revocation, render a routed card, acknowledge it, and clear the durable payload on leave");
}
