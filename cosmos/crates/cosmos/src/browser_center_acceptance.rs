//! Driven by center/verify/center-runtime-live.mjs against an actual Center
//! image and browser. Authentication and cognition are synthetic; the owner
//! APIs, PostgreSQL authority, SFU, BFF, React render and DOM acknowledgment run.
use super::*;
use crate::{
    ambiance::{ActionStatus, Channel, PrivacyClass, RuntimeData, RuntimeState, SemanticIntent},
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    enrollment::{EnrollmentStore, MemoryEnrollmentStore},
    store::Store,
    surface_registry::{
        Binding, Mutation, Record, native_manifest, native_surface_id, pin_surface_id,
    },
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cosmos_surface_client::{
    Client as NativeClient, Config as NativeConfig, Error as NativeClientError, OperationKind,
    OperationResult, Platform, PlatformError, SecureStore, Signer as NativeSigner,
};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

/// Synthetic platform implementations only. The production client owns every
/// wire request; fixture keys and protected journal bytes stay in Rust memory.
struct FixtureSigner {
    key: SigningKey,
    calls: AtomicUsize,
}

impl NativeSigner for FixtureSigner {
    fn public_key_sec1(&self) -> Result<[u8; 65], PlatformError> {
        self.key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .try_into()
            .map_err(|_| PlatformError)
    }

    fn sign_sha256(&self, message: &[u8]) -> Result<Vec<u8>, PlatformError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let signature: Signature = self.key.sign(message);
        Ok(signature.to_der().as_bytes().to_vec())
    }
}

#[derive(Default)]
struct FixtureJournal {
    bytes: Mutex<Option<Vec<u8>>>,
    saves_until_failure: AtomicUsize,
    failures: AtomicUsize,
}

impl FixtureJournal {
    fn fail_completion_save(&self) {
        // First persist the exact pending envelope; fail the second save,
        // after its real runtime response, without replacing those bytes.
        assert_eq!(self.saves_until_failure.swap(2, Ordering::SeqCst), 0);
    }
}

impl SecureStore for FixtureJournal {
    fn load(&self) -> Result<Option<Vec<u8>>, PlatformError> {
        self.bytes
            .lock()
            .map_err(|_| PlatformError)
            .map(|bytes| bytes.clone())
    }

    fn save_atomically(&self, bytes: &[u8]) -> Result<(), PlatformError> {
        if bytes.is_empty() || bytes.len() > cosmos_surface_client::MAX_JOURNAL_BYTES {
            return Err(PlatformError);
        }
        let mut stored = self.bytes.lock().map_err(|_| PlatformError)?;
        if self
            .saves_until_failure
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .ok()
            == Some(1)
        {
            self.failures.fetch_add(1, Ordering::SeqCst);
            return Err(PlatformError);
        }
        *stored = Some(bytes.to_vec());
        Ok(())
    }
}

async fn retry_client_pending(client: &mut NativeClient) -> OperationResult {
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            match client.retry_pending().await {
                Ok(result) => return result,
                Err(NativeClientError::Unavailable | NativeClientError::Busy) => {
                    assert!(
                        client
                            .status()
                            .pending
                            .is_some_and(|pending| pending.can_retry)
                    );
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(error) => panic!("native client pending reconciliation failed: {error}"),
            }
        }
    })
    .await
    .expect("native client must reconcile its exact pending envelope")
}

struct Model {
    calls: AtomicUsize,
    provider_calls: AtomicUsize,
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
        if messages
            .last()
            .is_some_and(|message| message.content == LOOKUP_PROMPT)
        {
            return Ok(ChatResponse {
                tool_call: Some(ToolCall {
                    name: "propose_information".into(),
                    arguments: json!({"web_lookup":{"query":LOOKUP_QUERY},"privacy":"public"})
                        .to_string(),
                }),
                ..Default::default()
            });
        }
        if let Some(provider) = &self.provider {
            self.provider_calls.fetch_add(1, Ordering::SeqCst);
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
    LookupRenderObserved,
    LookupClearObserved,
}

const LOOKUP_PROMPT: &str = "Find public web sources about the Denmark national football team.";
const LOOKUP_QUERY: &str = "Denmark national football team";
const LOOKUP_TITLE: &str = "Denmark national football team";
const LOOKUP_SNIPPET: &str = "Official team information from the Danish Football Association.";
const LOOKUP_SOURCE_URL: &str = "https://www.dbu.dk/landshold/herrelandshold/";

fn lookup_card_text() -> String {
    format!(
        "Web results for \"{LOOKUP_QUERY}\"\n\n[1] {LOOKUP_TITLE}\n{LOOKUP_SNIPPET}\n{LOOKUP_SOURCE_URL}"
    )
}

fn lookup_evidence() -> crate::backends::search::LookupEvidence {
    crate::backends::search::LookupEvidence {
        sources: vec![crate::backends::search::LookupSource {
            title: LOOKUP_TITLE.into(),
            snippet: LOOKUP_SNIPPET.into(),
            url: LOOKUP_SOURCE_URL.into(),
        }],
        privacy_floor: PrivacyClass::SharedRoom,
    }
}

async fn committed_lookup_events(
    audit: &sqlx::PgPool,
    principal: &str,
) -> Vec<crate::ambiance::ledger::RuntimeEvent> {
    let events: Vec<String> = sqlx::query_scalar(
        "SELECT event::text FROM cosmos_surface_event WHERE principal=$1 AND event->>'version'='3' AND event->'data'->>'kind' LIKE 'lookup_%' ORDER BY sequence",
    ).bind(principal).fetch_all(audit).await.unwrap();
    events
        .into_iter()
        .map(|event| serde_json::from_str(&event).unwrap())
        .collect()
}

/// The selected SearXNG backend makes real loopback HTTP. Its response is
/// deterministic fixture data, never a claim that a live search was performed.
async fn lookup_server(
    audit: sqlx::PgPool,
    principal: String,
    native_id: Uuid,
) -> (
    crate::integrations::SearchConfig,
    crate::backends::search::LookupProviderIdentity,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    use crate::backends::search;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = crate::integrations::SearchConfig {
        searxng_base_url: Some(format!("http://{}", listener.local_addr().unwrap())),
        ..Default::default()
    };
    let providers = search::lookup_providers_for_test(&config);
    assert_eq!(providers.len(), 1);
    let provider = providers[0].clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let received = calls.clone();
    let expected_provider = provider.clone();
    let app = axum::Router::new().route("/search", axum::routing::get(move |axum::extract::Query(query): axum::extract::Query<BTreeMap<String, String>>, axum::extract::OriginalUri(uri): axum::extract::OriginalUri, headers: axum::http::HeaderMap| {
        let audit = audit.clone();
        let principal = principal.clone();
        let received = received.clone();
        let expected_provider = expected_provider.clone();
        async move {
            assert_eq!(received.fetch_add(1, Ordering::SeqCst), 0, "lookup retries must not contact the provider again");
            assert_eq!(query, BTreeMap::from([
                ("q".into(), LOOKUP_QUERY.into()), ("format".into(), "json".into()),
                ("categories".into(), "general".into()), ("language".into(), "en".into()),
                ("safesearch".into(), "1".into()), ("pageno".into(), "1".into()), ("engines".into(), "bing".into()),
            ]));
            assert_eq!(headers.get("accept").unwrap(), "application/json");
            let payload_digest = crate::surface_registry::hash(format!(
                "GET\nhttp://{}{}\naccept:application/json\n", headers.get("host").unwrap().to_str().unwrap(), uri,
            ).as_bytes());
            let state = committed_runtime(&audit, &principal).await;
            let turn = state.turn.as_ref().unwrap();
            assert_eq!(turn.fence.origin_surface, native_id);
            let lookup = turn.lookup.as_ref().expect("lookup must commit before provider I/O");
            assert_eq!(lookup.policy_revision, 1);
            assert_eq!(lookup.request.provider, expected_provider);
            assert_eq!(lookup.request.query_digest, crate::surface_registry::hash(LOOKUP_QUERY.as_bytes()));
            assert_eq!(lookup.request.payload_digest, payload_digest);
            assert_eq!(lookup.request.privacy, PrivacyClass::SharedRoom);
            assert!(lookup.receipt.is_none());
            let events = committed_lookup_events(&audit, &principal).await;
            assert_eq!(events.len(), 2);
            assert!(matches!(&events[0].data, RuntimeData::LookupPolicyChanged { surface_id, approval }
                if *surface_id == native_id && approval.approval_revision == 1 && approval.revision == 1
                    && approval.policy.as_ref().is_some_and(|policy| policy.provider == expected_provider && policy.maximum_class == PrivacyClass::SharedRoom)));
            assert!(matches!(&events[1].data, RuntimeData::LookupStarted { fence, lookup: started }
                if fence.turn_id == turn.fence.turn_id && fence.generation == turn.fence.generation
                    && fence.origin_surface == native_id && started == lookup));
            assert!(events[0].sequence < events[1].sequence);
            axum::Json(json!({"results":[{"title":LOOKUP_TITLE,"content":LOOKUP_SNIPPET,"url":LOOKUP_SOURCE_URL}]}))
        }
    }));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (config, provider, calls, server)
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
    let tls_certificate = std::fs::read(input["tlsCertificatePath"].as_str().unwrap()).unwrap();
    let mut audience_url = reqwest::Url::parse(public_url).unwrap();
    audience_url.set_scheme("https").unwrap();
    let audience = audience_url.origin().ascii_serialization();
    let database = std::env::var("COSMOS_TEST_DATABASE_URL").unwrap();
    assert!(url.starts_with("ws://127.0.0.1:") && public_url.starts_with("wss://127.0.0.1:"));
    cosmos_rtc::testing::install_loopback_tls_transport(
        &audience,
        &reqwest::Url::parse(url)
            .unwrap()
            .origin()
            .ascii_serialization(),
        &tls_certificate,
    )
    .expect("install the explicit loopback TLS trust before any SDK joins");
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
    let (lookup_config, lookup_provider, lookup_calls, lookup_server) =
        lookup_server(audit.clone(), principal.clone(), native_id).await;
    let mut scalar = [0u8; 32];
    scalar[31] = 1;
    let signer = Arc::new(FixtureSigner {
        key: SigningKey::from_bytes(&scalar).unwrap(),
        calls: AtomicUsize::new(0),
    });
    let journal = Arc::new(FixtureJournal::default());
    let epoch = Uuid::new_v4();
    let native_config = NativeConfig {
        server_origin: audience.clone(),
        enrollment_id: native_enrollment,
        platform: Platform::Macos,
        boot_epoch: epoch,
    };
    let mut native = NativeClient::new_with_root_certificate(
        native_config.clone(),
        signer.clone(),
        journal.clone(),
        &tls_certificate,
    )
    .unwrap();
    let native_shutdown = native.transport_shutdown();
    let native_descriptor = serde_json::to_value(native.descriptor()).unwrap();
    let public_key = native_descriptor["publicKey"].as_str().unwrap().to_owned();
    let platform = native_descriptor["platform"].as_str().unwrap().to_owned();
    let native_fingerprint =
        crate::surface_registry::hash(&URL_SAFE_NO_PAD.decode(&public_key).unwrap());
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
        provider_calls: AtomicUsize::new(0),
        provider,
    });
    let runtime = Arc::new(
        AmbianceRuntime::new(store.clone(), model.clone(), Some(pairing.clone()))
            .with_lookup_config_for_test(lookup_config.clone()),
    );
    let config = crate::browser_rooms::Config::new(
        url.into(),
        public_url.into(),
        input["key"].as_str().unwrap().into(),
        input["secret"].as_str().unwrap().into(),
    )
    .unwrap();
    let rooms = Arc::new(crate::browser_rooms::Rooms::new(
        runtime.clone(),
        Some(config),
    ));
    let app = with_rooms(
        runtime.clone(),
        Some(super::tests::verifier()),
        rooms.clone(),
    )
    .merge(crate::surface_api::with_lookup_config_for_test(
        store.clone(),
        Some(super::tests::verifier()),
        Some(pairing),
        lookup_config,
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
        "nativeDisconnected":false,"browserPreservedAfterNative":false,
        "nativeClientLibrary":false,"nativeUntrustedTlsRejected":false,
        "nativeCompletionSaveRecovered":false,
        "nativeCrashPendingRecovered":false,
        "webLookupApproved":false,"webLookupAcknowledged":false,"webLookupRetried":false,"webLookupLedgerVerified":false,
        "webLookupCancelled":false,"webLookupPayloadCleared":false,"webLookupRevoked":false});
    write_private(status_path, &status, true);
    write_private(
        input["bootstrapPath"].as_str().unwrap(),
        &json!({
            "port":address.port(),"subject":subject,"bearer":bearer,"pinId":pin_id,
            "nativeDescriptor":native_descriptor,"nativeId":native_id,"nativePublicKeyFingerprint":native_fingerprint,
            "lookupProvider":lookup_provider,
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
                assert_native_transport_denied(address, &bearer, native_enrollment, native_id)
                    .await;
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
        let browsers: Vec<_> = surfaces
            .iter()
            .filter(|surface| matches!(surface.binding, Binding::Browser))
            .collect();
        assert_eq!(browsers.len(), 1);
        let browser_id = browsers[0].surface_id;
        assert!(browsers[0].connected && browsers[0].available && !browsers[0].revoked);
        let browser_record = committed_record(&audit, &principal, browser_id)
            .await
            .unwrap();
        let browser_incarnation = browser_record.incarnation;

        // The same real client with platform-default trust must reject this
        // disposable CA before signing or creating any native runtime state.
        let mut untrusted = NativeClient::new(
            native_config.clone(),
            signer.clone(),
            Arc::new(FixtureJournal::default()),
        )
        .unwrap();
        let untrusted_shutdown = untrusted.transport_shutdown();
        assert_eq!(signer.calls.load(Ordering::SeqCst), 0);
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(8), untrusted.connect())
                .await
                .expect("untrusted native TLS rejection must be bounded"),
            Err(NativeClientError::Unavailable)
        ));
        assert_eq!(signer.calls.load(Ordering::SeqCst), 0);
        let rejected = untrusted.status();
        assert!(!rejected.connected && !rejected.pending_open);
        assert!(rejected.pending.is_none() && rejected.last_admission.is_none());
        let rejected_state = committed_runtime(&audit, &principal).await;
        assert!(rejected_state.native_connections.is_empty());
        assert!(!rejected_state.ingress.contains_key(&native_id));
        assert!(rejected_state.turn.is_none() && rejected_state.actions.is_empty());
        assert_eq!(rejected_state.generation, 0);
        assert_eq!(model.calls.load(Ordering::SeqCst), 0);
        drop(untrusted);
        untrusted_shutdown
            .finish()
            .await
            .expect("untrusted client has no remaining transport");
        status["nativeUntrustedTlsRejected"] = true.into();
        write_private(status_path, &status, false);

        // The shipped client independently validates challenges, signs, opens
        // HTTPS admission and joins the public WSS endpoint with explicit trust.
        native
            .connect()
            .await
            .expect("production native client must connect");
        assert!(native.status().connected);
        assert_eq!(signer.calls.load(Ordering::SeqCst), 1);
        let connected_state = committed_runtime(&audit, &principal).await;
        let connection = connected_state.native_connections[&native_id]
            .connection
            .as_ref()
            .unwrap();
        let incarnation = connection.incarnation;
        assert!(!incarnation.is_nil());
        assert_eq!((connection.approval_revision, connection.epoch), (1, epoch));

        let scenario = async {
            match native.heartbeat().await {
                Ok(()) => {}
                Err(NativeClientError::Unavailable | NativeClientError::Busy) => {
                    assert!(matches!(
                        retry_client_pending(&mut native).await,
                        OperationResult::Heartbeat
                    ));
                }
                Err(error) => panic!("native client heartbeat failed: {error}"),
            }
            let heartbeat_state = committed_runtime(&audit, &principal).await;
            let current = heartbeat_state.native_connections[&native_id]
                .connection
                .as_ref()
                .unwrap();
            assert_eq!(
                (
                    current.approval_revision,
                    current.incarnation,
                    current.epoch
                ),
                (1, incarnation, epoch)
            );
            assert!(
                !current.closed && current.lease_expires_at_ms > crate::surface_registry::now_ms()
            );
            let cursor = &heartbeat_state.ingress[&native_id];
            assert_eq!((cursor.epoch, cursor.incarnation), (epoch, incarnation));
            assert!(cursor.high_water >= 1 && !cursor.controls.is_empty());
            assert!(cursor.receipts.is_empty());
            let text_sequence = cursor.high_water + 1;
            assert_eq!(model.calls.load(Ordering::SeqCst), 0);
            status["nativeRoomJoined"] = true.into();
            status["nativeHeartbeatVerified"] = true.into();
            status["nativeClientLibrary"] = true.into();
            write_private(status_path, &status, false);

            journal.fail_completion_save();
            assert!(matches!(
                native
                    .send_text(
                        "Display a public text card containing exactly: Center acceptance card"
                    )
                    .await,
                Err(NativeClientError::Persistence)
            ));
            assert_eq!(journal.failures.load(Ordering::SeqCst), 1);
            // The server has admitted the turn, but the secure journal still
            // preserves its pending envelope. The in-process client already
            // knows the response and must retry its exact completion save.
            let admitted_state = committed_runtime(&audit, &principal).await;
            let admitted_turn = admitted_state.turn.as_ref().unwrap();
            let turn_id = admitted_turn.fence.turn_id;
            let generation = admitted_turn.fence.generation;
            let pending_text = native
                .status()
                .pending
                .expect("failed text completion remains pending");
            assert_eq!(pending_text.kind, OperationKind::Text);
            assert_eq!(
                (pending_text.instance_id, pending_text.sequence),
                (turn_id, text_sequence)
            );
            assert!(pending_text.can_retry);
            assert_eq!(generation, 1);
            assert_eq!(admitted_turn.fence.origin_surface, native_id);
            assert_eq!(admitted_state.ingress[&native_id].high_water, text_sequence);
            assert_eq!(admitted_state.ingress[&native_id].receipts.len(), 1);
            let OperationResult::Text(admission) = retry_client_pending(&mut native).await else {
                panic!("pending text must recover its actual admission")
            };
            assert_eq!(
                (admission.turn_id, admission.generation),
                (turn_id, generation)
            );
            assert!(
                !admission.duplicate,
                "saving a known response does not send another wire request"
            );
            assert!(native.status().pending.is_none());
            tokio::time::timeout(Duration::from_secs(5), async {
                while model.calls.load(Ordering::SeqCst) == 0 {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("admitted native text must reach the model");
            assert_eq!(model.calls.load(Ordering::SeqCst), 1);
            let retried_state = committed_runtime(&audit, &principal).await;
            let turn = retried_state.turn.as_ref().unwrap();
            assert_eq!(
                (
                    turn.fence.turn_id,
                    turn.fence.generation,
                    turn.fence.origin_surface
                ),
                (turn_id, generation, native_id)
            );
            assert_eq!(
                (turn.origin_incarnation, turn.origin_revision),
                (incarnation, 1)
            );
            assert_eq!(retried_state.ingress[&native_id].high_water, text_sequence);
            assert_eq!(retried_state.ingress[&native_id].receipts.len(), 1);
            status["nativeTextRetried"] = true.into();
            status["nativeCompletionSaveRecovered"] = true.into();
            write_private(status_path, &status, false);

            let mut heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
            let mut acknowledged = false;
            loop {
                let state = committed_runtime(&audit, &principal).await;
                assert_eq!(model.calls.load(Ordering::SeqCst), 1);
                assert!(
                    state
                        .actions
                        .values()
                        .all(|action| action.surface_id != native_id)
                );
                if !acknowledged
                    && state.actions.values().any(|action| {
                        action.status == ActionStatus::Acknowledged
                            && action.turn_id == turn_id
                            && action.generation == generation
                            && action.worker == turn.fence.worker
                            && action.channel == Channel::VisualCard
                            && action.surface_id == browser_id
                            && action.incarnation == browser_incarnation
                            && action.intent.text() == "Center acceptance card"
                            && action.content_digest
                                == crate::surface_registry::hash(b"Center acceptance card")
                    })
                {
                    acknowledged = true;
                    status["acknowledged"] = true.into();
                    write_private(status_path, &status, false);
                }
                match coordination_stage(coordination_path) {
                    Some(Stage::RenderObserved) => {
                        assert!(acknowledged);
                        break;
                    }
                    Some(Stage::BrowserReady) => {}
                    _ => panic!("Center render checkpoint is missing or out of order"),
                }
                if tokio::time::Instant::now() >= heartbeat_due {
                    native
                        .heartbeat()
                        .await
                        .expect("native client heartbeat while rendering");
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            native
                .cancel(admission)
                .await
                .expect("native client cancels its admitted turn");
            let state = committed_runtime(&audit, &principal).await;
            assert_cancelled_payload(&state, turn_id, generation);

            // A separate crash-recovery phase occurs only after the original
            // card was observed and explicitly cancelled. Losing a process
            // replaces its room incarnation; that must not be hidden while
            // claiming the original card still has a live origin.
            journal.fail_completion_save();
            assert!(matches!(
                native.heartbeat().await,
                Err(NativeClientError::Persistence)
            ));
            assert_eq!(journal.failures.load(Ordering::SeqCst), 2);
            let pending = native
                .status()
                .pending
                .expect("failed completion preserves pending heartbeat");
            assert_eq!(pending.kind, OperationKind::Heartbeat);
            let before_crash = committed_runtime(&audit, &principal).await;
            let before_cursor = &before_crash.ingress[&native_id];
            assert_eq!(before_cursor.high_water, pending.sequence);
            let controls_before_crash = before_cursor.controls.len();
            drop(native);
            native_shutdown
                .finish()
                .await
                .expect("crashed client SDK shutdown completes");
            let mut native = NativeClient::new_with_root_certificate(
                native_config.clone(),
                signer.clone(),
                journal.clone(),
                &tls_certificate,
            )
            .unwrap();
            let native_shutdown = native.transport_shutdown();
            assert!(!native.status().connected);
            assert_eq!(native.status().pending, Some(pending));
            native
                .connect()
                .await
                .expect("reconstructed production client reconnects explicitly");
            assert!(native.status().connected);
            assert_eq!(native.status().pending, Some(pending));
            let reconnected = committed_runtime(&audit, &principal).await;
            assert_eq!(reconnected.ingress[&native_id].high_water, pending.sequence);
            assert_eq!(
                reconnected.ingress[&native_id].controls.len(),
                controls_before_crash
            );
            let connection = reconnected.native_connections[&native_id]
                .connection
                .as_ref()
                .unwrap();
            assert_ne!(connection.incarnation, incarnation);
            assert_eq!(connection.epoch, epoch);
            let lease_before_retry = connection.lease_expires_at_ms;
            assert!(matches!(
                retry_client_pending(&mut native).await,
                OperationResult::Heartbeat
            ));
            assert!(native.status().pending.is_none());
            let recovered = committed_runtime(&audit, &principal).await;
            assert_eq!(recovered.ingress[&native_id].high_water, pending.sequence);
            assert_eq!(
                recovered.ingress[&native_id].controls.len(),
                controls_before_crash
            );
            assert_eq!(
                recovered.native_connections[&native_id]
                    .connection
                    .as_ref()
                    .unwrap()
                    .lease_expires_at_ms,
                lease_before_retry,
                "retry of the committed heartbeat must not renew the new connection lease"
            );
            assert_cancelled_payload(&recovered, turn_id, generation);
            assert_eq!(model.calls.load(Ordering::SeqCst), 1);
            status["nativeCrashPendingRecovered"] = true.into();
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
                    native
                        .heartbeat()
                        .await
                        .expect("native client heartbeat after clearing");
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            // A separate owner gesture approves the selected provider for
            // this native origin. The first text turn granted no web access.
            loop {
                assert_eq!(model.calls.load(Ordering::SeqCst), 1);
                assert_eq!(lookup_calls.load(Ordering::SeqCst), 0);
                let events = committed_lookup_events(&audit, &principal).await;
                if let Some(event) = events.last() {
                    assert_eq!(events.len(), 1);
                    assert!(matches!(&event.data, RuntimeData::LookupPolicyChanged { surface_id, approval }
                        if *surface_id == native_id && approval.approval_revision == 1 && approval.revision == 1
                            && approval.policy.as_ref().is_some_and(|policy| policy.provider == lookup_provider && policy.maximum_class == PrivacyClass::SharedRoom)));
                    break;
                }
                if tokio::time::Instant::now() >= heartbeat_due {
                    native.heartbeat().await.expect("native heartbeat while owner reviews lookup");
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            status["webLookupApproved"] = true.into();
            write_private(status_path, &status, false);
            native.heartbeat().await.expect("native heartbeat before lookup request");
            heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
            journal.fail_completion_save();
            assert!(matches!(native.send_text(LOOKUP_PROMPT).await, Err(NativeClientError::Persistence)));
            assert_eq!(journal.failures.load(Ordering::SeqCst), 3);
            let lookup_pending = native.status().pending.expect("lookup input admission remains pending");
            assert_eq!(lookup_pending.kind, OperationKind::Text);
            let OperationResult::Text(lookup_admission) = retry_client_pending(&mut native).await else {
                panic!("lookup input must recover its exact admitted turn")
            };
            assert_eq!(lookup_admission.turn_id, lookup_pending.instance_id);
            assert!(!lookup_admission.duplicate);
            assert!(native.status().pending.is_none());
            let turn_id = lookup_admission.turn_id;
            let generation = lookup_admission.generation;
            let expected_card = lookup_card_text();
            let expected_evidence_digest = crate::surface_registry::hash(&serde_json::to_vec(&lookup_evidence()).unwrap());
            let mut lookup_acknowledged = false;
            loop {
                let state = committed_runtime(&audit, &principal).await;
                assert!(model.calls.load(Ordering::SeqCst) <= 2);
                assert!(lookup_calls.load(Ordering::SeqCst) <= 1);
                let current = state.turn.as_ref().unwrap();
                assert_eq!((current.fence.turn_id, current.fence.generation, current.fence.origin_surface), (turn_id, generation, native_id));
                assert_eq!(state.ingress[&native_id].receipts.len(), 2);
                assert!(state.actions.values().all(|action| action.surface_id != native_id));
                if !lookup_acknowledged && state.actions.values().any(|action| {
                    action.status == ActionStatus::Acknowledged && action.turn_id == turn_id && action.generation == generation
                        && action.worker == current.fence.worker && action.channel == Channel::VisualCard
                        && action.surface_id == browser_id && action.incarnation == browser_incarnation
                        && action.intent.text() == expected_card
                        && action.content_digest == crate::surface_registry::hash(expected_card.as_bytes())
                }) {
                    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
                    assert_eq!(lookup_calls.load(Ordering::SeqCst), 1);
                    let lookup = current.lookup.as_ref().unwrap();
                    let receipt = lookup.receipt.as_ref().expect("source evidence commits before rendering");
                    assert_eq!(lookup.policy_revision, 1);
                    assert_eq!(lookup.request.provider, lookup_provider);
                    assert_eq!(receipt.evidence_digest, expected_evidence_digest);
                    assert_eq!(receipt.privacy, PrivacyClass::SharedRoom);
                    assert!(receipt.received_at_ms >= lookup.started_at_ms);
                    assert!(receipt.received_at_ms < lookup.started_at_ms + crate::ambiance::lookup::LOOKUP_MS);
                    let events = committed_lookup_events(&audit, &principal).await;
                    assert_eq!(events.len(), 3);
                    assert!(matches!(&events[2].data, RuntimeData::LookupCompleted { fence, id, policy_revision, receipt: committed }
                        if fence.turn_id == turn_id && fence.generation == generation && fence.origin_surface == native_id
                            && *id == lookup.id && *policy_revision == 1 && committed == receipt));
                    assert!(events[1].sequence < events[2].sequence);
                    lookup_acknowledged = true;
                    status["webLookupAcknowledged"] = true.into();
                    status["webLookupRetried"] = true.into();
                    status["webLookupLedgerVerified"] = true.into();
                    write_private(status_path, &status, false);
                }
                match coordination_stage(coordination_path) {
                    Some(Stage::LookupRenderObserved) => { assert!(lookup_acknowledged); break; }
                    Some(Stage::ClearObserved) => {}
                    _ => panic!("lookup render checkpoint is missing or out of order"),
                }
                if tokio::time::Instant::now() >= heartbeat_due {
                    native.heartbeat().await.expect("native heartbeat while sourced lookup renders");
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            native.cancel(lookup_admission).await.expect("native cancels sourced lookup turn");
            assert_cancelled_payload(&committed_runtime(&audit, &principal).await, turn_id, generation);
            status["webLookupCancelled"] = true.into();
            status["webLookupPayloadCleared"] = true.into();
            write_private(status_path, &status, false);
            loop {
                match coordination_stage(coordination_path) {
                    Some(Stage::LookupClearObserved) => break,
                    Some(Stage::LookupRenderObserved) => {}
                    _ => panic!("lookup clear checkpoint is missing or out of order"),
                }
                if tokio::time::Instant::now() >= heartbeat_due {
                    native.heartbeat().await.expect("native heartbeat after lookup clear");
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            loop {
                assert_eq!(model.calls.load(Ordering::SeqCst), 2);
                assert_eq!(lookup_calls.load(Ordering::SeqCst), 1);
                let events = committed_lookup_events(&audit, &principal).await;
                if events.len() == 4 {
                    assert!(matches!(&events[3].data, RuntimeData::LookupPolicyChanged { surface_id, approval }
                        if *surface_id == native_id && approval.approval_revision == 1 && approval.revision == 2 && approval.policy.is_none()));
                    assert_cancelled_payload(&committed_runtime(&audit, &principal).await, turn_id, generation);
                    break;
                }
                assert_eq!(events.len(), 3);
                if tokio::time::Instant::now() >= heartbeat_due {
                    native.heartbeat().await.expect("native heartbeat while owner revokes lookup");
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            status["webLookupRevoked"] = true.into();
            write_private(status_path, &status, false);

            loop {
                let record = committed_record(&audit, &principal, native_id)
                    .await
                    .unwrap();
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
                    match native.heartbeat().await {
                        Ok(()) => {}
                        Err(_) => {
                            let revoked = committed_record(&audit, &principal, native_id)
                                .await
                                .unwrap();
                            assert_eq!((revoked.revision, revoked.revoked), (2, true));
                        }
                    }
                    heartbeat_due = tokio::time::Instant::now() + Duration::from_secs(15);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let state = committed_runtime(&audit, &principal).await;
            assert!(state.native_connections.is_empty());
            assert!(!state.ingress.contains_key(&native_id));
            assert_cancelled_payload(&state, turn_id, generation);
            assert!(native.heartbeat().await.is_err());
            // Revocation removes application authority; it is not an SFU kick.
            // Explicitly close this fixture's native SDK before claiming it left.
            native
                .disconnect()
                .await
                .expect("native client shutdown failed");
            assert!(!native.status().connected);
            drop(native);
            native_shutdown
                .finish()
                .await
                .expect("native SDK shutdown completes before browser continuity check");
            let browser = store
                .surface(&principal, browser_id)
                .await
                .unwrap()
                .unwrap();
            assert!(browser.connected && browser.available && !browser.revoked);
            let preserved = committed_record(&audit, &principal, browser_id)
                .await
                .unwrap();
            assert_eq!(preserved.incarnation, browser_incarnation);
            assert_eq!(preserved.binding, Binding::Browser);
            // Center's normal visibility heartbeats advance its registry
            // revision while this same approved incarnation stays available.
            assert!(preserved.revision >= browser_record.revision);
            let browser_sequence_after_native_close = preserved.sequence;
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    let current = committed_record(&audit, &principal, browser_id)
                        .await
                        .unwrap();
                    assert_eq!(current.incarnation, browser_incarnation);
                    assert_eq!(current.binding, Binding::Browser);
                    let view = current.view(crate::surface_registry::now_ms());
                    assert!(view.connected && view.available && !view.revoked);
                    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
                    assert_eq!(lookup_calls.load(Ordering::SeqCst), 1);
                    if current.sequence > browser_sequence_after_native_close {
                        // This state sequence was committed after native SDK
                        // shutdown, so cached browser availability cannot pass.
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("browser must commit another room heartbeat after native shutdown");
            status["nativeRevoked"] = true.into();
            status["nativeDisconnected"] = true.into();
            status["browserPreservedAfterNative"] = true.into();
            write_private(status_path, &status, false);

            loop {
                let state = committed_runtime(&audit, &principal).await;
                assert!(state.native_connections.is_empty());
                assert!(!state.ingress.contains_key(&native_id));
                assert_cancelled_payload(&state, turn_id, generation);
                assert_eq!(model.calls.load(Ordering::SeqCst), 2);
                assert_eq!(lookup_calls.load(Ordering::SeqCst), 1);
                let speech_revoked = state
                    .disclosure_policies
                    .get(&pin_id)
                    .is_some_and(|approval| approval.revision == 2 && approval.policy.is_none());
                let voice_revoked = state
                    .voice_policies
                    .get(&pin_id)
                    .is_some_and(|approval| approval.revision == 2 && approval.policy.is_none());
                let surfaces = store.surfaces(&principal).await.unwrap();
                if speech_revoked
                    && voice_revoked
                    && surfaces
                        .iter()
                        .filter(|surface| surface.surface_id != pin_id)
                        .all(|surface| !surface.connected)
                {
                    status["complete"] = true.into();
                    status["modelCalls"] = 2.into();
                    status["modelProviderCalls"] = model.provider_calls.load(Ordering::SeqCst).into();
                    status["lookupProviderCalls"] = 1.into();
                    status["lookupProviderMode"] = "local-searxng-fixture".into();
                    status["webLookupPolicyRevision"] = 2.into();
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
        scenario.await;
    })
    .await;
    server.abort();
    let _ = server.await;
    lookup_server.abort();
    let _ = lookup_server.await;
    audit.close().await;
    accepted.expect("Center must verify native client recovery, approved sourced web lookup with one committed provider call, exact DOM acknowledgments and cancellation clears, native revocation with browser continuity, and separate speech and local voice revocations");
}
