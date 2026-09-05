use super::*;
use crate::{
    ambiance::{InputStamp, PrivacyClass, SemanticIntent},
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    enrollment::{MemoryEnrollmentStore, SharedEnrollmentStore},
    store::{MemoryStore, Store},
    surface_registry::{Mutation, pin_surface_id},
};
use axum::{Router, body::Body, http::HeaderMap, routing::post};
use std::sync::atomic::AtomicUsize;

struct Model;
#[tonic::async_trait]
impl ChatModel for Model {
    async fn complete(&self, _: &[ChatMessage], _: &[ToolDef]) -> Result<ChatResponse, LlmError> {
        Ok(ChatResponse { tool_call: Some(ToolCall { name: "propose_information".into(), arguments: serde_json::json!({"intent":{"kind":"informational_speech","text":"An authorized answer."},"privacy":"shared_room"}).to_string() }), ..Default::default() })
    }
}
struct Fixture {
    runtime: Arc<AmbianceRuntime>,
    store: Arc<MemoryStore>,
    auth: AuthenticatedRequest,
    pairing: SharedEnrollmentStore,
    incarnation: Uuid,
    fence: TurnFence,
    action: Action,
}
async fn fixture() -> Fixture {
    let store = Arc::new(MemoryStore::default());
    let pairing: SharedEnrollmentStore = Arc::new(MemoryEnrollmentStore::default());
    let owner = format!("speech-{}", Uuid::new_v4());
    pairing.put_device_account("aabb", &owner).await.unwrap();
    let auth = AuthenticatedRequest {
        principal: cosmos_core::AuthenticatedPrincipal::for_user(&owner).unwrap(),
        device: Some(cosmos_core::AuthenticatedDeviceIdentity::from_edge("aabb").unwrap()),
        plane: crate::auth::AuthenticationPlane::Device,
    };
    store
        .mutate_surface(
            auth.principal.expose_for_authorization(),
            pin_surface_id(auth.principal.expose_for_authorization(), "aabb"),
            Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
        )
        .await
        .unwrap();
    let runtime = Arc::new(AmbianceRuntime::new(
        store.clone(),
        Arc::new(Model),
        Some(pairing.clone()),
    ));
    let epoch = Uuid::new_v4();
    let RuntimeResult::PinOpened { connection, .. } =
        runtime.open_pin(&auth, 1, epoch, None).await.unwrap()
    else {
        panic!()
    };
    let RuntimeResult::Proposed(action) = runtime
        .sequenced_pin_text(
            &auth,
            connection.incarnation,
            InputStamp {
                epoch,
                sequence: 1,
                instance_id: Uuid::new_v4(),
            },
            "Tell me a public fact.".into(),
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    let fence = TurnFence {
        turn_id: action.turn_id,
        generation: action.generation,
        worker: action.worker,
        origin_surface: action.surface_id,
    };
    Fixture {
        runtime,
        store,
        auth,
        pairing,
        incarnation: connection.incarnation,
        fence,
        action,
    }
}
fn policy() -> disclosure::Policy {
    disclosure::Policy {
        provider: disclosure::Provider::AzureSpeech {
            region: "westeurope".into(),
        },
        maximum_class: PrivacyClass::SharedRoom,
        transcription: false,
        synthesis: true,
    }
}
impl Fixture {
    async fn grant(&self, revision: u64, policy: Option<disclosure::Policy>) {
        self.store
            .runtime(
                self.auth.principal.expose_for_authorization(),
                RuntimeOperation::SetDisclosurePolicy {
                    surface_id: self.fence.origin_surface,
                    approval_revision: 1,
                    expected_revision: revision,
                    policy,
                },
            )
            .await
            .unwrap();
    }
    async fn speak(&self, url: &str, action: Action) -> Result<SpeechStream, Status> {
        self.runtime
            .synthesize_pin_with_client(
                self.auth.clone(),
                self.incarnation,
                self.fence.clone(),
                action,
                AzureSpeechClient::for_test(url.into()),
            )
            .await
    }
    async fn current(&self) -> bool {
        self.store
            .runtime(
                self.auth.principal.expose_for_authorization(),
                RuntimeOperation::CheckCognition {
                    fence: self.fence.clone(),
                },
            )
            .await
            .is_ok()
    }
}
async fn provider(body: Body) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/speech", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let body = Arc::new(tokio::sync::Mutex::new(Some(body)));
    let server = tokio::spawn(async move {
        let handler = move |headers: HeaderMap, text: String| {
            let (calls, body) = (calls.clone(), body.clone());
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(
                    headers["x-microsoft-outputformat"],
                    "raw-48khz-16bit-mono-pcm"
                );
                assert!(text.contains(">An authorized answer.</voice>"));
                body.lock().await.take().unwrap()
            }
        };
        axum::serve(listener, Router::new().route("/speech", post(handler)))
            .await
            .unwrap();
    });
    (url, observed, server)
}

#[tokio::test]
async fn ambiance_disclosure_synthesis_requires_exact_policy_action_and_one_owner() {
    let f = fixture().await;
    let (url, calls, server) = provider(Body::from(vec![1, 2, 3, 4])).await;
    assert!(f.speak(&url, f.action.clone()).await.is_err());
    let mut wrong = policy();
    wrong.provider = disclosure::Provider::AzureSpeech {
        region: "eastus".into(),
    };
    f.grant(0, Some(wrong)).await;
    assert!(f.speak(&url, f.action.clone()).await.is_err());
    let mut too_public = policy();
    too_public.maximum_class = PrivacyClass::Public;
    f.grant(1, Some(too_public)).await;
    assert!(f.speak(&url, f.action.clone()).await.is_err());
    f.grant(2, Some(policy())).await;
    let mut altered = f.action.clone();
    altered.intent = SemanticIntent::InformationalSpeech {
        text: "UNAPPROVED_PAYLOAD".into(),
    };
    assert!(f.speak(&url, altered).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut stream = f.speak(&url, f.action.clone()).await.unwrap();
    assert!(f.speak(&url, f.action.clone()).await.is_err());
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        f.current().await,
        "a losing attempt cannot cancel the owner"
    );
    let mut audio = Vec::new();
    while let Some(chunk) = stream.next().await {
        audio.extend(chunk.unwrap());
    }
    assert_eq!(audio, [1, 2, 3, 4]);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        f.current().await,
        "provider completion is not turn/playback completion"
    );
    assert!(f.speak(&url, f.action.clone()).await.is_err());
    server.abort();
}

struct Closed(Option<oneshot::Sender<()>>);
impl Drop for Closed {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}

#[tokio::test]
async fn ambiance_disclosure_revocation_closes_http_and_clears_unpolled_audio() {
    let f = fixture().await;
    f.grant(0, Some(policy())).await;
    let (closed, observed) = oneshot::channel();
    let body = Body::from_stream(async_stream::stream! {
        let _closed = Closed(Some(closed));
        yield Ok::<_, std::io::Error>(vec![1, 2, 3, 4]);
        std::future::pending::<()>().await;
    });
    let (url, calls, server) = provider(body).await;
    let mut stream = f.speak(&url, f.action.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while stream.chunks.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    f.grant(1, None).await;
    // An idle consumer cannot keep the actual stalled HTTP response alive.
    tokio::time::timeout(Duration::from_secs(2), observed)
        .await
        .unwrap()
        .unwrap();
    assert!(stream.next().await.unwrap().is_err());
    assert!(stream.next().await.is_none());
    assert!(!f.current().await);
    server.abort();
}

#[tokio::test]
async fn ambiance_disclosure_provider_eof_does_not_release_queued_bytes_from_policy() {
    let f = fixture().await;
    f.grant(0, Some(policy())).await;
    let (url, _, server) = provider(Body::from(vec![1, 2, 3, 4])).await;
    let mut stream = f.speak(&url, f.action.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while stream.chunks.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    f.grant(1, None).await;
    // Do not wait for the background watcher: consumption itself must consult
    // the committed policy before returning already-queued provider bytes.
    assert!(stream.next().await.unwrap().is_err());
    server.abort();
}

#[tokio::test]
async fn ambiance_disclosure_stock_claim_and_unpaired_origins_never_start_http() {
    let f = fixture().await;
    f.grant(0, Some(policy())).await;
    let (url, calls, server) = provider(Body::from(vec![1, 2])).await;
    f.pairing
        .put_device_account("aabb", "new-owner")
        .await
        .unwrap();
    assert!(f.speak(&url, f.action.clone()).await.is_err());
    f.pairing
        .put_device_account(
            "aabb",
            f.auth
                .principal
                .expose_for_authorization()
                .strip_prefix("U:")
                .unwrap(),
        )
        .await
        .unwrap();
    let RuntimeResult::Dispatch(action) = f.runtime.stock_claim(&f.auth, &f.action).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(action.status, super::super::ActionStatus::OutcomeUnknown);
    assert!(f.speak(&url, action).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn ambiance_disclosure_drop_closes_http_and_retires_only_its_turn() {
    let f = fixture().await;
    f.grant(0, Some(policy())).await;
    let (closed, observed) = oneshot::channel();
    let body = Body::from_stream(async_stream::stream! {
        let _closed = Closed(Some(closed));
        yield Ok::<_, std::io::Error>(vec![1, 2]);
        std::future::pending::<()>().await;
    });
    let (url, calls, server) = provider(body).await;
    let stream = f.speak(&url, f.action.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while stream.chunks.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    drop(stream);
    tokio::time::timeout(Duration::from_secs(2), observed)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.current().await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(f.speak(&url, f.action.clone()).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}
