//! Driven by center/verify/center-runtime-live.mjs against an actual Center
//! image and browser. Authentication and cognition are synthetic; the owner
//! APIs, PostgreSQL authority, SFU, BFF, React render and DOM acknowledgment run.
use super::*;
use crate::{
    ambiance::{
        ActionStatus, Channel, InputStamp, NativeProof, RuntimeOperation, RuntimeState,
        SemanticIntent,
        native_connection::{Challenge, OpenRequest, signing_message},
    },
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    enrollment::{EnrollmentStore, MemoryEnrollmentStore},
    store::Store,
    surface_registry::{
        Binding, Mutation, Record, native_manifest, native_surface_id, pin_surface_id,
    },
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use rand::RngCore;
use serde::Deserialize;
use std::{
    io::{Read, Write},
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Stage {
    BrowserReady,
    RenderObserved,
    ClearObserved,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Coordination {
    stage: Stage,
}

fn coordination_stage(path: &str) -> Option<Stage> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => panic!("cannot read Center coordination checkpoint"),
    };
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes).unwrap();
    assert!(
        bytes.len() <= 1024,
        "Center coordination checkpoint is too large"
    );
    Some(
        serde_json::from_slice::<Coordination>(&bytes)
            .expect("invalid Center coordination checkpoint")
            .stage,
    )
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

async fn committed_record(
    audit: &sqlx::PgPool,
    principal: &str,
    surface_id: Uuid,
) -> Option<Record> {
    let encoded: Option<String> = sqlx::query_scalar(
        "SELECT record::text FROM cosmos_surface_registry WHERE principal=$1 AND surface_id=$2",
    )
    .bind(principal)
    .bind(surface_id)
    .fetch_optional(audit)
    .await
    .unwrap();
    encoded.map(|value| serde_json::from_str(&value).unwrap())
}

fn assert_native_record(record: &Record, surface_id: Uuid, binding: &Binding, fingerprint: &str) {
    assert_eq!(record.surface_id, surface_id);
    assert_eq!(&record.binding, binding);
    assert_eq!(record.approved_manifest, native_manifest());
    assert_eq!(
        record
            .view(crate::surface_registry::now_ms())
            .native_view()
            .unwrap()
            .public_key_fingerprint,
        fingerprint
    );
    // Registry enrollment never becomes the installation's connection capability.
    assert!(record.incarnation.is_nil() && record.token_hash.is_empty());
    assert!(!record.visible && record.left);
    assert_eq!(
        (
            record.sequence,
            record.connection_expires_at,
            record.lease_expires_at
        ),
        (0, 0, 0)
    );
}

fn assert_cancelled_payload(state: &RuntimeState, turn_id: Uuid, generation: u64) {
    let turn = state.turn.as_ref().unwrap();
    assert_eq!(turn.fence.turn_id, turn_id);
    assert_eq!(turn.fence.generation, generation);
    assert!(turn.cancelled);
    assert!(!state.actions.is_empty());
    assert!(state.actions.values().all(|action| {
        action.turn_id == turn_id
            && action.generation == generation
            && action.status == ActionStatus::Cancelled
            && action.intent.text().is_empty()
    }));
}

async fn native_rpc(session: &cosmos_rtc::Session, runtime: &str, message: &Value) -> Value {
    serde_json::from_str(
        &session
            .invoke(runtime, message.to_string())
            .await
            .expect("native room RPC failed"),
    )
    .expect("invalid native room RPC response")
}

fn heartbeat(epoch: Uuid, sequence: u64, instance_id: Uuid) -> Value {
    let stamp = InputStamp {
        epoch,
        sequence,
        instance_id,
    };
    json!({"kind":"control","stamp":stamp,
        "control":{"kind":"heartbeat"}})
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
    // The room route is mounted, but enrollment and the owner bearer grant no
    // installation session. A well-formed unrelated secret also grants nothing.
    for (authorization, expected_status, expected_error) in [
        (
            bearer.to_owned(),
            reqwest::StatusCode::NOT_FOUND,
            "not_found",
        ),
        (
            format!("Bearer {}", URL_SAFE_NO_PAD.encode([0u8; 32])),
            reqwest::StatusCode::CONFLICT,
            "stale_connection",
        ),
    ] {
        let response = client
            .post(format!("http://{address}/runtime-api/v1/native/room"))
            .header("authorization", authorization)
            .json(&json!({"enrollmentId":enrollment_id,"approvalRevision":1,
                "incarnation":Uuid::new_v4(),"epoch":Uuid::new_v4()}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), expected_status);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"error":expected_error})
        );
    }
    // Text is admitted only through the authenticated shared-room RPC.
    for operation in ["text", "input"] {
        let response = client
            .post(format!(
                "http://{address}/runtime-api/v1/native/{operation}"
            ))
            .header("authorization", bearer)
            .json(&json!({"surfaceId":surface_id,"text":"HTTP text must remain unavailable"}))
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
    let mut audience_url = reqwest::Url::parse(public_url).unwrap();
    audience_url.set_scheme("https").unwrap();
    let audience = audience_url.origin().ascii_serialization();
    let rooms = Arc::new(crate::browser_rooms::Rooms::new(
        runtime.clone(),
        Some(config),
    ));
    let app = with_rooms(
        runtime.clone(),
        Some(super::tests::verifier()),
        rooms.clone(),
    )
    .merge(crate::surface_api::with_pairing(
        store.clone(),
        Some(super::tests::verifier()),
        Some(pairing),
    ))
    .merge(crate::native_runtime_api::with_audience(
        store.clone(),
        Some(audience.clone()),
        rooms.clone(),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let status_path = input["statusPath"].as_str().unwrap();
    let coordination_path = input["coordinationPath"].as_str().unwrap();
    let mut status = json!({"acknowledged":false,"complete":false,
        "nativeApproved":false,"enrollmentOnlyNoRoomAuthority":false,
        "nativeRoomJoined":false,"nativeHeartbeatVerified":false,"nativeTextRetried":false,
        "nativeCancelled":false,"payloadCleared":false,"nativeRevoked":false,
        "nativeDisconnected":false,"browserPreservedAfterNative":false});
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
        // Owner enrollment comes first. Nothing in this phase creates a native
        // challenge, connection, input cursor, turn or model invocation.
        loop {
            if let Some(record) = committed_record(&audit, &principal, native_id).await {
                assert_native_record(&record, native_id, &native_binding, &native_fingerprint);
                assert_eq!((record.revision, record.revoked), (1, false));
                assert_approval_only(&committed_runtime(&audit, &principal).await, &model);
                assert_native_transport_denied(address, &bearer, native_enrollment, native_id).await;
                assert_approval_only(&committed_runtime(&audit, &principal).await, &model);
                status["nativeApproved"] = true.into();
                status["enrollmentOnlyNoRoomAuthority"] = true.into();
                write_private(status_path, &status, false);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        loop {
            let state = committed_runtime(&audit, &principal).await;
            assert!(state.native_connections.is_empty());
            assert!(!state.ingress.contains_key(&native_id));
            assert!(state.turn.is_none() && state.actions.is_empty());
            assert_eq!(model.calls.load(Ordering::SeqCst), 0);
            match coordination_stage(coordination_path) {
                Some(Stage::BrowserReady) => break,
                None => {}
                Some(_) => panic!("Center skipped its browser-ready checkpoint"),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let surfaces = store.surfaces(&principal).await.unwrap();
        let browsers: Vec<_> = surfaces.iter().filter(|surface| matches!(surface.binding, Binding::Browser)).collect();
        assert_eq!(browsers.len(), 1);
        let browser_id = browsers[0].surface_id;
        assert!(browsers[0].connected && browsers[0].available && !browsers[0].revoked);
        let browser_record = committed_record(&audit, &principal, browser_id).await.unwrap();
        let browser_incarnation = browser_record.incarnation;

        // This fixture owns the scalar-one installation key used by its public
        // enrollment descriptor. The fresh session secret, signature and SFU
        // token stay in Rust memory; none enter bootstrap or status files.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        let response = client
            .post(format!("http://{address}/runtime-api/v1/native/challenge"))
            .json(&json!({"enrollmentId":native_enrollment}))
            .send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let challenge: Challenge = serde_json::from_value(response.json::<Value>().await.unwrap()["challenge"].take()).unwrap();
        assert_eq!(challenge.version, 1);
        assert_eq!(challenge.audience, audience);
        assert_eq!(challenge.enrollment_id, native_enrollment);
        assert_eq!(challenge.surface_id, native_id);
        assert_eq!(challenge.approval_revision, 1);
        assert_eq!(challenge.public_key_fingerprint, native_fingerprint);
        assert!(challenge.current_incarnation.is_none());
        assert!(challenge.expires_at_ms > crate::surface_registry::now_ms());
        let mut scalar = [0u8; 32];
        scalar[31] = 1;
        let signing_key = SigningKey::from_bytes(&scalar).unwrap();
        let mut raw_secret = [0u8; 32];
        rand::rngs::OsRng.try_fill_bytes(&mut raw_secret).unwrap();
        let epoch = Uuid::new_v4();
        let mut open = OpenRequest {
            enrollment_id: native_enrollment,
            challenge_id: challenge.challenge_id,
            epoch,
            expected_incarnation: challenge.current_incarnation,
            session_token_hash: crate::surface_registry::hash(&raw_secret),
            signature: String::new(),
        };
        let signature: Signature = signing_key.sign(&signing_message(&challenge, &open).unwrap());
        open.signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
        let response = client
            .post(format!("http://{address}/runtime-api/v1/native/open"))
            .json(&json!({"enrollmentId":open.enrollment_id,"challengeId":open.challenge_id,
                "epoch":open.epoch,"expectedIncarnation":open.expected_incarnation,
                "sessionTokenHash":open.session_token_hash,"signature":open.signature}))
            .send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let opened = response.json::<Value>().await.unwrap();
        assert_eq!(opened["duplicate"].as_bool(), Some(false));
        let connection = &opened["connection"];
        assert_eq!(connection["surfaceId"].as_str(), Some(native_id.to_string().as_str()));
        assert_eq!(connection["approvalRevision"].as_u64(), Some(1));
        assert_eq!(connection["epoch"].as_str(), Some(epoch.to_string().as_str()));
        let incarnation = Uuid::parse_str(connection["incarnation"].as_str().unwrap()).unwrap();
        assert!(!incarnation.is_nil());
        let proof = NativeProof { surface_id: native_id, incarnation, token_hash: open.session_token_hash.clone() };
        let response = client
            .post(format!("http://{address}/runtime-api/v1/native/room"))
            .bearer_auth(URL_SAFE_NO_PAD.encode(raw_secret))
            .json(&json!({"enrollmentId":native_enrollment,"approvalRevision":1,
                "incarnation":incarnation,"epoch":epoch}))
            .send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let room = response.json::<Value>().await.unwrap();
        assert_eq!(room["version"].as_u64(), Some(1));
        assert_eq!(room["url"].as_str(), Some(public_url));
        assert_eq!(room["epoch"].as_str(), Some(epoch.to_string().as_str()));
        assert!(!Uuid::parse_str(room["runtimeEpoch"].as_str().unwrap()).unwrap().is_nil());
        assert!(!Uuid::parse_str(room["participant"].as_str().unwrap()).unwrap().is_nil());
        let runtime_participant = room["runtimeParticipant"].as_str().unwrap().to_owned();
        assert_eq!(runtime_participant, "runtime");
        // The public URL above identifies this same SFU. The Rust SDK uses the
        // verified loopback endpoint, without relaxing public TLS validation.
        let (native, mut incoming) = cosmos_rtc::Session::connect(url, room["token"].as_str().unwrap()).await.unwrap();
        drop(room);
        drop(open);

        let scenario = async {
            let initial_heartbeat = heartbeat(epoch, 1, Uuid::new_v4());
            // Client-side presence alone does not prove the runtime observed
            // the native participant SID. Retry this exact idempotent control,
            // never a fresh input, until the application accepts it.
            let first_heartbeat = tokio::time::timeout(Duration::from_secs(6), async {
                loop {
                    if let Ok(reply) = native.invoke(&runtime_participant, initial_heartbeat.to_string()).await {
                        break serde_json::from_str::<Value>(&reply).unwrap();
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await.expect("runtime must observe native SFU membership");
            assert_eq!(first_heartbeat["version"].as_u64(), Some(1));
            assert_eq!(first_heartbeat["kind"].as_str(), Some("accepted"));
            assert!(first_heartbeat["duplicate"].is_boolean());
            let heartbeat_state = committed_runtime(&audit, &principal).await;
            let current = heartbeat_state.native_connections[&native_id].connection.as_ref().unwrap();
            assert_eq!((current.approval_revision, current.incarnation, current.epoch), (1, incarnation, epoch));
            assert!(!current.closed && current.lease_expires_at_ms > crate::surface_registry::now_ms());
            let lease_after_heartbeat = current.lease_expires_at_ms;
            let cursor = &heartbeat_state.ingress[&native_id];
            assert_eq!((cursor.epoch, cursor.incarnation, cursor.high_water), (epoch, incarnation, 1));
            assert!(cursor.receipts.is_empty());
            assert_eq!(cursor.controls.len(), 1);
            assert_eq!(model.calls.load(Ordering::SeqCst), 0);
            let duplicate = native_rpc(&native, &runtime_participant, &initial_heartbeat).await;
            assert_eq!(duplicate, json!({"version":1,"kind":"accepted","duplicate":true}));
            let duplicate_state = committed_runtime(&audit, &principal).await;
            assert_eq!(duplicate_state.native_connections[&native_id].connection.as_ref().unwrap().lease_expires_at_ms, lease_after_heartbeat);
            assert_eq!(duplicate_state.ingress[&native_id].high_water, 1);
            assert_eq!(duplicate_state.ingress[&native_id].controls.len(), 1);
            status["nativeRoomJoined"] = true.into();
            status["nativeHeartbeatVerified"] = true.into();
            write_private(status_path, &status, false);

            let turn_id = Uuid::new_v4();
            let text_stamp = InputStamp { epoch, sequence: 2, instance_id: turn_id };
            let text = json!({"kind":"input","stamp":text_stamp,
                "text":"Display a public text card containing exactly: Center acceptance card"});
            let admitted = native_rpc(&native, &runtime_participant, &text).await;
            assert_eq!(admitted["version"].as_u64(), Some(1));
            assert_eq!(admitted["kind"].as_str(), Some("admitted"));
            assert_eq!(admitted["turnId"].as_str(), Some(turn_id.to_string().as_str()));
            assert_eq!(admitted["duplicate"].as_bool(), Some(false));
            let generation = admitted["generation"].as_u64().unwrap();
            assert_eq!(generation, 1);
            let retried = native_rpc(&native, &runtime_participant, &text).await;
            assert_eq!(retried, json!({"version":1,"kind":"admitted","turnId":turn_id,"generation":generation,"duplicate":true}));
            tokio::time::timeout(Duration::from_secs(5), async {
                while model.calls.load(Ordering::SeqCst) == 0 {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await.expect("admitted native text must reach the model");
            assert_eq!(model.calls.load(Ordering::SeqCst), 1);
            let retried_state = committed_runtime(&audit, &principal).await;
            let turn = retried_state.turn.as_ref().unwrap();
            assert_eq!((turn.fence.turn_id, turn.fence.generation, turn.fence.origin_surface), (turn_id, generation, native_id));
            assert_eq!((turn.origin_incarnation, turn.origin_revision), (incarnation, 1));
            assert_eq!(retried_state.ingress[&native_id].high_water, 2);
            assert_eq!(retried_state.ingress[&native_id].receipts.len(), 1);
            status["nativeTextRetried"] = true.into();
            write_private(status_path, &status, false);

            let mut next_sequence = 3;
            let mut heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
            let mut acknowledged = false;
            loop {
                let state = committed_runtime(&audit, &principal).await;
                assert_eq!(model.calls.load(Ordering::SeqCst), 1);
                assert!(state.actions.values().all(|action| action.surface_id != native_id));
                if !acknowledged && state.actions.values().any(|action| {
                    action.status == ActionStatus::Acknowledged
                        && action.turn_id == turn_id && action.generation == generation
                        && action.worker == turn.fence.worker
                        && action.channel == Channel::VisualCard
                        && action.surface_id == browser_id && action.incarnation == browser_incarnation
                        && action.intent.text() == "Center acceptance card"
                        && action.content_digest == crate::surface_registry::hash(b"Center acceptance card")
                }) {
                    acknowledged = true;
                    status["acknowledged"] = true.into();
                    write_private(status_path, &status, false);
                }
                match coordination_stage(coordination_path) {
                    Some(Stage::RenderObserved) => { assert!(acknowledged); break; }
                    Some(Stage::BrowserReady) => {}
                    _ => panic!("Center render checkpoint is missing or out of order"),
                }
                if tokio::time::Instant::now() >= heartbeat_due {
                    let reply = native_rpc(&native, &runtime_participant, &heartbeat(epoch, next_sequence, Uuid::new_v4())).await;
                    assert_eq!(reply, json!({"version":1,"kind":"accepted","duplicate":false}));
                    next_sequence += 1;
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            let cancel_stamp = InputStamp { epoch, sequence: next_sequence, instance_id: turn_id };
            let cancel = json!({"kind":"control","stamp":cancel_stamp,
                "control":{"kind":"cancel","turnId":turn_id,"generation":generation}});
            let cancelled = native_rpc(&native, &runtime_participant, &cancel).await;
            assert_eq!(cancelled, json!({"version":1,"kind":"accepted","duplicate":false}));
            next_sequence += 1;
            let state = committed_runtime(&audit, &principal).await;
            assert_cancelled_payload(&state, turn_id, generation);
            status["nativeCancelled"] = true.into();
            status["payloadCleared"] = true.into();
            write_private(status_path, &status, false);
            loop {
                match coordination_stage(coordination_path) {
                    Some(Stage::ClearObserved) => break,
                    Some(Stage::RenderObserved) => {}
                    _ => panic!("Center clear checkpoint is missing or out of order"),
                }
                if tokio::time::Instant::now() >= heartbeat_due {
                    let reply = native_rpc(&native, &runtime_participant, &heartbeat(epoch, next_sequence, Uuid::new_v4())).await;
                    assert_eq!(reply, json!({"version":1,"kind":"accepted","duplicate":false}));
                    next_sequence += 1;
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            loop {
                let record = committed_record(&audit, &principal, native_id).await.unwrap();
                assert_native_record(&record, native_id, &native_binding, &native_fingerprint);
                if record.revoked {
                    assert_eq!(record.revision, 2);
                    break;
                }
                assert_eq!(record.revision, 1);
                // The UI may revoke immediately after this read. A concurrent
                // heartbeat denial is valid only if the next committed read
                // proves that revocation, never a reason to hide a room failure.
                if tokio::time::Instant::now() >= heartbeat_due {
                    let reply = native.invoke(&runtime_participant, heartbeat(epoch, next_sequence, Uuid::new_v4()).to_string()).await;
                    match reply {
                        Ok(reply) => assert_eq!(serde_json::from_str::<Value>(&reply).unwrap(), json!({"version":1,"kind":"accepted","duplicate":false})),
                        Err(_) => {
                            let revoked = committed_record(&audit, &principal, native_id).await.unwrap();
                            assert_eq!((revoked.revision, revoked.revoked), (2, true));
                        }
                    }
                    next_sequence += 1;
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let state = committed_runtime(&audit, &principal).await;
            assert!(state.native_connections.is_empty());
            assert!(!state.ingress.contains_key(&native_id));
            assert_cancelled_payload(&state, turn_id, generation);
            assert!(store.runtime(&principal, RuntimeOperation::CheckNative { connection: proof.clone() }).await.is_err());
            assert!(native.invoke(&runtime_participant, heartbeat(epoch, next_sequence, Uuid::new_v4()).to_string()).await.is_err());
            // Revocation removes application authority; it is not an SFU kick.
            // Explicitly close this fixture's native SDK before claiming it left.
            let mut native_connected = native.connected();
            native.shutdown().await.expect("native SDK shutdown failed");
            tokio::time::timeout(Duration::from_secs(5), async {
                while *native_connected.borrow_and_update() {
                    native_connected.changed().await.unwrap();
                }
            }).await.expect("native SDK must disconnect");
            let browser = store.surface(&principal, browser_id).await.unwrap().unwrap();
            assert!(browser.connected && browser.available && !browser.revoked);
            let preserved = committed_record(&audit, &principal, browser_id).await.unwrap();
            assert_eq!(preserved.incarnation, browser_incarnation);
            assert_eq!(preserved.binding, Binding::Browser);
            // Center's normal visibility heartbeats advance its registry
            // revision while this same approved incarnation stays available.
            assert!(preserved.revision >= browser_record.revision);
            let browser_sequence_after_native_close = preserved.sequence;
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    let current = committed_record(&audit, &principal, browser_id).await.unwrap();
                    assert_eq!(current.incarnation, browser_incarnation);
                    assert_eq!(current.binding, Binding::Browser);
                    let view = current.view(crate::surface_registry::now_ms());
                    assert!(view.connected && view.available && !view.revoked);
                    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
                    if current.sequence > browser_sequence_after_native_close {
                        // This state sequence was committed after native SDK
                        // shutdown, so cached browser availability cannot pass.
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }).await.expect("browser must commit another room heartbeat after native shutdown");
            status["nativeRevoked"] = true.into();
            status["nativeDisconnected"] = true.into();
            status["browserPreservedAfterNative"] = true.into();
            write_private(status_path, &status, false);

            loop {
                let state = committed_runtime(&audit, &principal).await;
                assert!(state.native_connections.is_empty());
                assert!(!state.ingress.contains_key(&native_id));
                assert_cancelled_payload(&state, turn_id, generation);
                assert_eq!(model.calls.load(Ordering::SeqCst), 1);
                let speech_revoked = state.disclosure_policies.get(&pin_id).is_some_and(|approval| approval.revision == 2 && approval.policy.is_none());
                let voice_revoked = state.voice_policies.get(&pin_id).is_some_and(|approval| approval.revision == 2 && approval.policy.is_none());
                let surfaces = store.surfaces(&principal).await.unwrap();
                if speech_revoked && voice_revoked && surfaces.iter().filter(|surface| surface.surface_id != pin_id).all(|surface| !surface.connected) {
                    status["complete"] = true.into();
                    status["modelCalls"] = 1.into();
                    status["modelMode"] = model_mode.into();
                    status["speechPolicyRevision"] = 2.into();
                    status["localVoicePolicyRevision"] = 2.into();
                    status["nativeApprovalRevision"] = 1.into();
                    status["nativeRevocationRevision"] = 2.into();
                    write_private(status_path, &status, false);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        tokio::select! {
            biased;
            Some(_) = incoming.recv() => panic!("native text-only participant received an output RPC"),
            _ = scenario => {}
        }
    }).await;
    server.abort();
    let _ = server.await;
    audit.close().await;
    accepted.expect("Center must verify enrollment alone grants no room authority, render and acknowledge one native-origin text turn despite exact retries, clear its payload on native cancellation, preserve the browser after native revocation, and finish with separate speech and local voice revocations");
}
