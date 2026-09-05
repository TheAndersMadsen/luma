//! Driven by center/verify/center-runtime-live.mjs against an actual Center
//! image and browser. Authentication and cognition are synthetic; the owner
//! APIs, PostgreSQL authority, SFU, BFF, React render and DOM acknowledgment run.
use super::*;
use crate::{
    ambiance::{ActionStatus, RuntimeState, SemanticIntent},
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    enrollment::{EnrollmentStore, MemoryEnrollmentStore},
    store::Store,
    surface_registry::{
        Binding, Mutation, Record, native_manifest, native_surface_id, pin_surface_id,
    },
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
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

async fn committed_runtime(audit: &sqlx::PgPool, principal: &str) -> RuntimeState {
    let encoded: Option<String> =
        sqlx::query_scalar("SELECT state::text FROM cosmos_ambiance_runtime WHERE principal=$1")
            .bind(principal)
            .fetch_optional(audit)
            .await
            .unwrap();
    encoded
        .map(|value| serde_json::from_str(&value).unwrap())
        .unwrap_or_default()
}

fn assert_approval_only(state: &RuntimeState, model: &Model) {
    assert!(state.native_connections.is_empty());
    assert!(state.ingress.is_empty());
    assert!(state.actions.is_empty());
    assert!(state.turn.is_none());
    assert_eq!(state.generation, 0);
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
}

async fn assert_native_transport_denied(
    address: std::net::SocketAddr,
    bearer: &str,
    enrollment_id: Uuid,
    surface_id: Uuid,
) {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    // The mounted native service rejects opening without its separate challenge
    // and key-possession ceremony. Owner approval/bearer alone creates no session.
    let response = client
        .post(format!("http://{address}/runtime-api/v1/native/open"))
        .header("authorization", bearer)
        .json(&json!({
            "enrollmentId":enrollment_id,"challengeId":Uuid::new_v4(),"epoch":Uuid::new_v4(),
            "expectedIncarnation":null,"sessionTokenHash":crate::surface_registry::hash(b"native-acceptance-token"),"signature":"",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"error":"stale_connection"})
    );
    let response = client
        .post(format!("http://{address}/runtime-api/v1/browser/room"))
        .header("authorization", bearer)
        .header("x-cosmos-surface-token", "0".repeat(64))
        .json(&json!({"surfaceId":surface_id,"incarnation":Uuid::new_v4(),"epoch":Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"error":"invalid_connection"})
    );
    // These transports are absent from the native service; 404 is route absence,
    // not evidence that a native room or text implementation has been exercised.
    for operation in ["room", "text", "input"] {
        let response = client
            .post(format!(
                "http://{address}/runtime-api/v1/native/{operation}"
            ))
            .header("authorization", bearer)
            .json(&json!({"surfaceId":surface_id,"text":"native input must remain unavailable"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    }
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
    let bearer = super::tests::bearer(&subject);
    let native_enrollment = Uuid::new_v4();
    let native_id = native_surface_id(&principal, native_enrollment);
    let Mutation::ApproveNative {
        public_key,
        platform,
        ..
    } = crate::store::native_test_approval(native_enrollment, 0)
    else {
        unreachable!()
    };
    let native_fingerprint =
        crate::surface_registry::hash(&URL_SAFE_NO_PAD.decode(&public_key).unwrap());
    let native_descriptor = json!({"enrollmentId":native_enrollment,"publicKey":public_key,
        "platform":platform,"approval":crate::surface_registry::NATIVE_APPROVAL});
    let native_binding = Binding::Native {
        enrollment_id: native_enrollment,
        public_key,
        platform,
    };
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
    let app = with_rooms(runtime, Some(super::tests::verifier()), Some(config))
        .merge(crate::surface_api::with_pairing(
            store.clone(),
            Some(super::tests::verifier()),
            Some(pairing),
        ))
        .merge(crate::native_runtime_api::with_audience(
            store.clone(),
            Some("https://127.0.0.1".into()),
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let status_path = input["statusPath"].as_str().unwrap();
    let mut status = json!({"acknowledged":false,"complete":false,
        "nativeApproved":false,"nativeRevoked":false,"noNativeRoomInputAuthority":false});
    write_private(status_path, &status, true);
    write_private(
        input["bootstrapPath"].as_str().unwrap(),
        &json!({
            "port":address.port(),"subject":subject,"bearer":bearer,"pinId":pin_id,
            "nativeDescriptor":native_descriptor,"nativeId":native_id,"nativePublicKeyFingerprint":native_fingerprint,
        }),
        true,
    );
    let accepted = tokio::time::timeout(Duration::from_secs(240), async {
        let mut acknowledged = false;
        let mut native_approved = false;
        let mut native_revoked = false;
        loop {
            let native: Option<String> = sqlx::query_scalar("SELECT record::text FROM cosmos_surface_registry WHERE principal=$1 AND surface_id=$2")
                .bind(&principal).bind(native_id).fetch_optional(&audit).await.unwrap();
            if let Some(encoded) = native {
                let record: Record = serde_json::from_str(&encoded).unwrap();
                assert_eq!(record.surface_id, native_id);
                assert_eq!(record.binding, native_binding);
                assert_eq!(record.approved_manifest, native_manifest());
                assert_eq!(record.view(crate::surface_registry::now_ms()).native_view().unwrap().public_key_fingerprint, native_fingerprint);
                assert!(record.incarnation.is_nil() && record.token_hash.is_empty());
                assert!(!record.visible && record.left);
                assert_eq!((record.sequence, record.connection_expires_at, record.lease_expires_at), (0, 0, 0));
                if record.revision == 1 && !record.revoked && !native_approved {
                    assert_approval_only(&committed_runtime(&audit, &principal).await, &model);
                    assert_native_transport_denied(address, &bearer, native_enrollment, native_id).await;
                    assert_approval_only(&committed_runtime(&audit, &principal).await, &model);
                    native_approved = true;
                    status["nativeApproved"] = true.into();
                    status["noNativeRoomInputAuthority"] = true.into();
                    write_private(status_path, &status, false);
                } else if record.revision == 2 && record.revoked && !native_revoked {
                    assert!(native_approved, "native revision 1 must be observed before revocation");
                    assert_approval_only(&committed_runtime(&audit, &principal).await, &model);
                    native_revoked = true;
                    status["nativeRevoked"] = true.into();
                    write_private(status_path, &status, false);
                }
                assert!(matches!((record.revision, record.revoked), (1, false) | (2, true)));
            }
            {
                let state = committed_runtime(&audit, &principal).await;
                assert!(state.native_connections.is_empty());
                assert!(!state.ingress.contains_key(&native_id));
                assert!(state.actions.values().all(|action| action.surface_id != native_id));
                assert!(state.turn.as_ref().is_none_or(|turn| turn.fence.origin_surface != native_id));
                let speech_revoked = state.disclosure_policies.get(&pin_id).is_some_and(|a| a.revision == 2 && a.policy.is_none());
                let voice_revoked = state.voice_policies.get(&pin_id).is_some_and(|a| a.revision == 2 && a.policy.is_none());
                if state.actions.values().any(|a| a.status == ActionStatus::Acknowledged && a.intent.text() == "Center acceptance card") {
                    acknowledged = true;
                    status["acknowledged"] = true.into();
                    write_private(status_path, &status, false);
                }
                if native_approved && native_revoked && acknowledged && speech_revoked && voice_revoked && !state.actions.is_empty()
                    && state.actions.values().all(|a| a.status == ActionStatus::Cancelled && a.intent.text().is_empty())
                {
                    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
                    assert!(store.surfaces(&principal).await.unwrap().iter().filter(|s| s.surface_id != pin_id).all(|s| !s.connected));
                    status["complete"] = true.into();
                    status["modelCalls"] = 1.into();
                    status["modelMode"] = model_mode.into();
                    status["speechPolicyRevision"] = 2.into();
                    status["localVoicePolicyRevision"] = 2.into();
                    status["nativeApprovalRevision"] = 1.into();
                    status["nativeRevocationRevision"] = 2.into();
                    write_private(status_path, &status, false);
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await;
    server.abort();
    let _ = server.await;
    audit.close().await;
    accepted.expect("Center must commit native approval/revocation without transport authority, separate speech and local voice permissions/revocations, render a routed card, acknowledge it, and clear the durable payload on leave");
}
