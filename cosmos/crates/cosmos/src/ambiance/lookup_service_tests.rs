use super::*;
use crate::ambiance::{
    Action, ActionStatus, Channel, InputStamp, RuntimeData, ledger::LedgerEvent,
};
use crate::backends::search::{self, LookupEvidence, LookupSource};
use crate::integrations::SearchConfig;
use crate::store::MemoryStore;
use crate::surface_registry::{Mutation, hash};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};

const PUBLIC_QUERY: &str = "public astronomy news";
const SOURCE_URL: &str = "https://example.org/article%20one?item=moon&lang=da#section-2";

struct LookupModel {
    query: String,
    calls: AtomicUsize,
}

#[tonic::async_trait]
impl ChatModel for LookupModel {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(messages.len(), 2);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "propose_information");
        assert!(
            messages
                .iter()
                .all(|m| !m.content.to_lowercase().contains("private_canary"))
        );
        Ok(ChatResponse {
            tool_call: Some(ToolCall {
                name: "propose_information".into(),
                arguments: serde_json::json!({
                    "web_lookup": {"query": self.query}, "privacy": "public"
                })
                .to_string(),
            }),
            ..Default::default()
        })
    }
}

struct RequestObservation {
    request: String,
    ledger: Vec<LedgerEvent>,
}

struct LookupFixture {
    runtime: Arc<AmbianceRuntime>,
    store: Arc<MemoryStore>,
    auth: AuthenticatedRequest,
    browser: BrowserProof,
    epoch: Uuid,
    model: Arc<LookupModel>,
    provider: LookupProviderIdentity,
    observations: Arc<Mutex<Vec<RequestObservation>>>,
    calls: Arc<AtomicUsize>,
    received: Arc<Notify>,
    release: Arc<Notify>,
    response_attempted: Arc<Notify>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for LookupFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl LookupFixture {
    fn principal(&self) -> &str {
        self.auth.principal.expose_for_authorization()
    }

    fn stamp(&self, sequence: u64) -> InputStamp {
        InputStamp {
            epoch: self.epoch,
            sequence,
            instance_id: Uuid::new_v4(),
        }
    }

    async fn approve(
        &self,
        surface_id: Uuid,
        expected_revision: u64,
        provider: Option<LookupProviderIdentity>,
    ) {
        let RuntimeResult::LookupPolicy { binding, .. } = self
            .store
            .runtime(
                self.principal(),
                RuntimeOperation::LookupPolicy {
                    service: LookupService::Web,
                    surface_id,
                },
            )
            .await
            .unwrap()
        else {
            panic!("current approval binding");
        };
        let result = self
            .store
            .runtime(
                self.principal(),
                RuntimeOperation::SetLookupPolicy {
                    service: LookupService::Web,
                    surface_id,
                    approval_revision: binding.approval_revision,
                    approval_incarnation: binding.incarnation,
                    expected_revision,
                    policy: provider.map(|provider| crate::ambiance::lookup::Policy {
                        provider,
                        maximum_class: PrivacyClass::SharedRoom,
                    }),
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            result,
            RuntimeResult::LookupPolicy {
                approval: Some(_),
                ..
            }
        ));
    }

    async fn request_observed(&self) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let notified = self.received.notified();
                if !self.observations.lock().await.is_empty() {
                    break;
                }
                notified.await;
            }
        })
        .await
        .expect("loopback provider request");
    }

    async fn assert_committed_request(&self, turn_id: Uuid) -> TurnFence {
        self.request_observed().await;
        let observations = self.observations.lock().await;
        assert_eq!(observations.len(), 1);
        assert_eq!(self.calls.load(Ordering::SeqCst), 1);
        let observed = &observations[0];
        let mut previous = String::new();
        for (index, event) in observed.ledger.iter().enumerate() {
            assert_eq!(event.sequence(), index as u64 + 1);
            assert_eq!(event.previous_hash(), previous);
            previous = event.hash().unwrap();
        }
        let starts: Vec<_> = observed
            .ledger
            .iter()
            .filter_map(|event| match event {
                LedgerEvent::Runtime(event) => match &event.data {
                    RuntimeData::LookupStarted { fence, lookup } => Some((fence, lookup)),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert_eq!(starts.len(), 1, "provider must observe one committed start");
        let (fence, lookup) = starts[0];
        assert_eq!(fence.turn_id, turn_id);
        assert!(lookup.receipt.is_none());
        assert_eq!(lookup.request.provider, self.provider);
        assert_eq!(lookup.request.privacy, PrivacyClass::SharedRoom);
        let target = observed
            .request
            .lines()
            .next()
            .unwrap()
            .strip_prefix("GET ")
            .unwrap()
            .strip_suffix(" HTTP/1.1")
            .unwrap();
        let endpoint = reqwest::Url::parse(&self.provider.endpoint).unwrap();
        let url = endpoint.join(target).unwrap();
        assert_eq!(url.path(), "/search");
        let parameters: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(parameters.get("q").unwrap(), PUBLIC_QUERY);
        assert_eq!(parameters.get("format").unwrap(), "json");
        assert_eq!(parameters.get("categories").unwrap(), "general");
        assert_eq!(parameters.get("language").unwrap(), "en");
        assert_eq!(parameters.get("safesearch").unwrap(), "1");
        assert_eq!(parameters.get("pageno").unwrap(), "1");
        assert_eq!(parameters.get("engines").unwrap(), "bing");
        assert_eq!(parameters.len(), 7);
        assert!(
            observed
                .request
                .to_ascii_lowercase()
                .contains("\r\naccept: application/json\r\n")
        );
        assert!(!observed.request.to_lowercase().contains("private_canary"));
        assert_eq!(lookup.request.query_digest, hash(PUBLIC_QUERY.as_bytes()));
        assert_eq!(
            lookup.request.payload_digest,
            hash(format!("GET\n{}\naccept:application/json\n", url.as_str()).as_bytes())
        );
        assert!(!observed.ledger.iter().any(|event| matches!(event,
            LedgerEvent::Runtime(event) if matches!(event.data, RuntimeData::LookupCompleted { .. }))));
        fence.clone()
    }

    async fn poll(&self) -> Vec<Action> {
        let RuntimeResult::Pending(actions) = self
            .store
            .runtime(
                self.principal(),
                RuntimeOperation::Poll {
                    connection: RoomProof::Browser(self.browser.clone()),
                },
            )
            .await
            .unwrap()
        else {
            panic!("browser poll result");
        };
        actions
    }

    fn assert_private_store_untouched(&self) {
        assert_eq!(
            self.store.assistant_private_accesses.load(Ordering::SeqCst),
            0
        );
    }
}

async fn lookup_fixture(query: &str, status: u16, body: String, gated: bool) -> LookupFixture {
    let model = Arc::new(LookupModel {
        query: query.into(),
        calls: AtomicUsize::new(0),
    });
    let (mut runtime, store, auth) = fixture(model.clone()).await;
    let principal = auth.principal.expose_for_authorization().to_owned();
    store
        .create_indexed_note(&principal, None, None, Some("private_canary"))
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = SearchConfig {
        searxng_base_url: Some(format!("http://{}", listener.local_addr().unwrap())),
        ..Default::default()
    };
    let provider = search::lookup_providers_for_test(&config).remove(0);
    Arc::get_mut(&mut runtime).unwrap().lookup_config = Some(config);
    let browser = BrowserProof {
        surface_id: Uuid::new_v4(),
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"lookup-browser-fixture"),
    };
    store
        .mutate_surface(
            &principal,
            browser.surface_id,
            Mutation::Approve {
                token_hash: browser.token_hash.clone(),
                incarnation: browser.incarnation,
            },
        )
        .await
        .unwrap();
    store
        .mutate_surface(
            &principal,
            browser.surface_id,
            Mutation::State {
                token_hash: browser.token_hash.clone(),
                incarnation: browser.incarnation,
                sequence: 1,
                visible: true,
            },
        )
        .await
        .unwrap();
    let epoch = Uuid::new_v4();
    store
        .runtime(
            &principal,
            RuntimeOperation::OpenBrowser {
                connection: browser.clone(),
                epoch,
            },
        )
        .await
        .unwrap();
    let observations = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let received = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let response_attempted = Arc::new(Notify::new());
    let server = {
        let (store, observations, calls, received, release, response_attempted) = (
            store.clone(),
            observations.clone(),
            calls.clone(),
            received.clone(),
            release.clone(),
            response_attempted.clone(),
        );
        tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        calls.fetch_add(1, Ordering::SeqCst);
                        let (store, principal, observations, received, release, response_attempted, body) =
                            (store.clone(), principal.clone(), observations.clone(), received.clone(), release.clone(), response_attempted.clone(), body.clone());
                        handlers.spawn(async move {
                            let request = tokio::time::timeout(Duration::from_secs(2), async {
                                let mut request = Vec::new();
                                let mut bytes = [0; 1024];
                                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                                    let count = socket.read(&mut bytes).await.unwrap();
                                    assert!(count > 0 && request.len() + count <= 16_384);
                                    request.extend_from_slice(&bytes[..count]);
                                }
                                String::from_utf8(request).unwrap()
                            }).await.unwrap();
                            let ledger = store.ambiance_ledger_events(&principal).await;
                            observations.lock().await.push(RequestObservation { request, ledger });
                            received.notify_one();
                            if gated { release.notified().await; }
                            let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = socket.write_all(response.as_bytes()).await;
                            let _ = socket.shutdown().await;
                            response_attempted.notify_one();
                        });
                    }
                    completed = handlers.join_next(), if !handlers.is_empty() => {
                        completed.unwrap().unwrap();
                    }
                }
            }
        })
    };
    LookupFixture {
        runtime,
        store,
        auth,
        browser,
        epoch,
        model,
        provider,
        observations,
        calls,
        received,
        release,
        response_attempted,
        server,
    }
}

fn source_response() -> String {
    serde_json::json!({"results":[{
        "title":"Actual article", "content":"Public lunar observations.",
        "url": SOURCE_URL, "engine":"bing"
    }]})
    .to_string()
}

#[tokio::test]
async fn ambiance_lookup_pin_commits_before_http_deduplicates_and_requires_exact_browser_ack() {
    let f = lookup_fixture("  public   astronomy news  ", 200, source_response(), true).await;
    let pin = crate::surface_registry::pin_surface_id(f.principal(), "abcd");
    f.approve(pin, 0, Some(f.provider.clone())).await;
    let RuntimeResult::PinOpened {
        connection,
        duplicate: false,
    } = f.runtime.open_pin(&f.auth, 1, f.epoch, None).await.unwrap()
    else {
        panic!("admitted Pin connection");
    };
    let stamp = f.stamp(1);
    let task = {
        let (runtime, auth, stamp) = (f.runtime.clone(), f.auth.clone(), stamp.clone());
        tokio::spawn(async move {
            runtime
                .sequenced_pin_text(
                    &auth,
                    connection.incarnation,
                    stamp,
                    "Find public astronomy news".into(),
                )
                .await
        })
    };
    f.assert_committed_request(stamp.instance_id).await;
    assert!(matches!(
        f.runtime
            .sequenced_pin_text(
                &f.auth,
                connection.incarnation,
                stamp,
                "Find public astronomy news".into()
            )
            .await
            .unwrap(),
        RuntimeResult::Duplicate(_)
    ));
    assert_eq!(f.model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    f.release.notify_one();
    let RuntimeResult::Proposed(action) = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("lookup card proposal");
    };
    let expected_text = format!(
        "Web results for \"{PUBLIC_QUERY}\"\n\n[1] Actual article\nPublic lunar observations.\n{SOURCE_URL}"
    );
    assert_eq!(action.surface_id, f.browser.surface_id);
    assert_eq!(action.channel, Channel::VisualCard);
    assert_eq!(action.privacy, PrivacyClass::SharedRoom);
    assert_eq!(action.intent.text(), expected_text);
    assert_eq!(action.content_digest, hash(expected_text.as_bytes()));
    let evidence = LookupEvidence {
        sources: vec![LookupSource {
            title: "Actual article".into(),
            snippet: "Public lunar observations.".into(),
            url: SOURCE_URL.into(),
        }],
        privacy_floor: PrivacyClass::SharedRoom,
    };
    let ledger = f.store.ambiance_ledger_events(f.principal()).await;
    let receipts: Vec<_> = ledger
        .iter()
        .filter_map(|event| match event {
            LedgerEvent::Runtime(event) => match &event.data {
                RuntimeData::LookupCompleted { receipt, .. } => Some(receipt),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        receipts[0].evidence_digest,
        hash(&serde_json::to_vec(&evidence).unwrap())
    );
    let pending = f.poll().await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, action.id);
    assert_eq!(pending[0].status, ActionStatus::Dispatched);
    assert!(
        f.store
            .runtime(
                f.principal(),
                RuntimeOperation::Ack {
                    action_id: action.id,
                    turn_id: action.turn_id,
                    generation: action.generation,
                    connection: RoomProof::Browser(f.browser.clone()),
                    channel: Channel::VisualCard,
                    content_digest: hash(b"a fabricated source card"),
                }
            )
            .await
            .is_err()
    );
    let acknowledged = f
        .store
        .runtime(
            f.principal(),
            RuntimeOperation::Ack {
                action_id: action.id,
                turn_id: action.turn_id,
                generation: action.generation,
                connection: RoomProof::Browser(f.browser.clone()),
                channel: Channel::VisualCard,
                content_digest: action.content_digest,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        acknowledged,
        RuntimeResult::Acknowledged(Action {
            status: ActionStatus::Acknowledged,
            ..
        })
    ));
    f.assert_private_store_untouched();
}

#[tokio::test]
async fn ambiance_lookup_missing_disabled_changed_provider_and_private_queries_make_no_http_calls()
{
    for case in [
        "missing",
        "disabled",
        "changed_provider",
        "private_query",
        "private_input",
    ] {
        let query = if case == "private_query" {
            "find my emails"
        } else {
            PUBLIC_QUERY
        };
        let f = lookup_fixture(query, 200, source_response(), false).await;
        if case != "missing" {
            let mut provider = f.provider.clone();
            if case == "changed_provider" {
                // Approve a valid former endpoint while the runtime keeps its
                // current configuration; malformed identities cannot be approved.
                let config = SearchConfig {
                    searxng_base_url: Some(f.provider.endpoint.replace("/search", "/previous")),
                    ..Default::default()
                };
                provider = search::lookup_providers_for_test(&config).remove(0);
            }
            f.approve(
                f.browser.surface_id,
                0,
                (case != "disabled").then_some(provider),
            )
            .await;
        }
        let input = if case == "private_input" {
            "Search my notes"
        } else {
            "Find public astronomy news"
        };
        let result = f
            .runtime
            .sequenced_room_text(
                f.principal(),
                RoomProof::Browser(f.browser.clone()),
                f.stamp(1),
                input.into(),
            )
            .await;
        if matches!(case, "missing" | "disabled") {
            let RuntimeResult::Proposed(action) = result.unwrap() else {
                panic!("permission explanation");
            };
            assert!(action.intent.text().contains(if case == "missing" {
                "not enabled"
            } else {
                "permission is off"
            }));
        } else {
            assert!(result.is_err(), "{case} must be denied");
            assert!(f.poll().await.is_empty());
        }
        assert_eq!(f.calls.load(Ordering::SeqCst), 0, "{case}");
        assert!(f.observations.lock().await.is_empty());
        assert_eq!(
            f.model.calls.load(Ordering::SeqCst),
            usize::from(case != "private_input")
        );
        let ledger = f.store.ambiance_ledger_events(f.principal()).await;
        assert!(!ledger.iter().any(|event| matches!(event, LedgerEvent::Runtime(event)
            if matches!(event.data, RuntimeData::LookupStarted { .. } | RuntimeData::LookupCompleted { .. }))));
        f.assert_private_store_untouched();
    }
}

#[tokio::test]
async fn ambiance_lookup_cancel_and_permission_revocation_drop_waiting_provider_results() {
    for revoke in [false, true] {
        let f = lookup_fixture(PUBLIC_QUERY, 200, source_response(), true).await;
        f.approve(f.browser.surface_id, 0, Some(f.provider.clone()))
            .await;
        let stamp = f.stamp(1);
        let task = {
            let (runtime, principal, browser, stamp) = (
                f.runtime.clone(),
                f.principal().to_owned(),
                f.browser.clone(),
                stamp.clone(),
            );
            tokio::spawn(async move {
                runtime
                    .sequenced_room_text(
                        &principal,
                        RoomProof::Browser(browser),
                        stamp,
                        "Find public astronomy news".into(),
                    )
                    .await
            })
        };
        let fence = f.assert_committed_request(stamp.instance_id).await;
        if revoke {
            f.approve(f.browser.surface_id, 1, None).await;
        } else {
            let result = f
                .store
                .runtime(
                    f.principal(),
                    RuntimeOperation::RoomControl {
                        connection: RoomProof::Browser(f.browser.clone()),
                        stamp: InputStamp {
                            instance_id: fence.turn_id,
                            ..f.stamp(2)
                        },
                        control: crate::ambiance::BrowserControl::Cancel {
                            turn_id: fence.turn_id,
                            generation: fence.generation,
                        },
                    },
                )
                .await
                .unwrap();
            assert!(matches!(
                result,
                RuntimeResult::ControlAccepted { duplicate: false }
            ));
        }
        // Leave the provider waiting: periodic authorization must cancel the
        // caller without needing a response, and a late response cannot revive it.
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);
        f.release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), f.response_attempted.notified())
            .await
            .unwrap();
        assert!(f.poll().await.is_empty());
        let ledger = f.store.ambiance_ledger_events(f.principal()).await;
        assert!(
            !ledger
                .iter()
                .any(|event| matches!(event, LedgerEvent::Runtime(event)
            if matches!(event.data, RuntimeData::LookupCompleted { .. })))
        );
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.model.calls.load(Ordering::SeqCst), 1);
        f.assert_private_store_untouched();
    }
}

#[tokio::test]
async fn ambiance_lookup_no_results_are_evidence_and_provider_failure_is_unavailable() {
    for status in [200, 503] {
        let f = lookup_fixture(
            PUBLIC_QUERY,
            status,
            serde_json::json!({"results": []}).to_string(),
            false,
        )
        .await;
        f.approve(f.browser.surface_id, 0, Some(f.provider.clone()))
            .await;
        let stamp = f.stamp(1);
        let result = f
            .runtime
            .sequenced_room_text(
                f.principal(),
                RoomProof::Browser(f.browser.clone()),
                stamp.clone(),
                "Find public astronomy news".into(),
            )
            .await;
        f.assert_committed_request(stamp.instance_id).await;
        let ledger = f.store.ambiance_ledger_events(f.principal()).await;
        let completions: Vec<_> = ledger
            .iter()
            .filter_map(|event| match event {
                LedgerEvent::Runtime(event) => match &event.data {
                    RuntimeData::LookupCompleted { receipt, .. } => Some(receipt),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        if status == 200 {
            let RuntimeResult::Proposed(action) = result.unwrap() else {
                panic!("honest no-results card");
            };
            assert!(
                action
                    .intent
                    .text()
                    .contains("The provider returned no source results for this query.")
            );
            assert_eq!(completions.len(), 1);
            assert_eq!(
                completions[0].evidence_digest,
                hash(
                    &serde_json::to_vec(&LookupEvidence {
                        sources: vec![],
                        privacy_floor: PrivacyClass::SharedRoom
                    })
                    .unwrap()
                )
            );
            assert_eq!(action.content_digest, hash(action.intent.text().as_bytes()));
        } else {
            assert_eq!(result.unwrap_err().code(), tonic::Code::Unavailable);
            assert!(completions.is_empty());
            assert!(f.poll().await.is_empty());
        }
        f.assert_private_store_untouched();
    }
}

#[tokio::test]
async fn ambiance_lookup_signed_native_input_uses_its_own_permission_and_browser_output() {
    use crate::ambiance::{NativeProof, native_connection};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use p256::ecdsa::{Signature, SigningKey, signature::Signer};

    let f = lookup_fixture(PUBLIC_QUERY, 200, source_response(), false).await;
    let enrollment_id = Uuid::new_v4();
    let surface_id = crate::surface_registry::native_surface_id(f.principal(), enrollment_id);
    f.store
        .mutate_surface(
            f.principal(),
            surface_id,
            crate::store::native_test_approval(enrollment_id, 0),
        )
        .await
        .unwrap();
    let audience = "https://native-lookup.test";
    let RuntimeResult::NativeChallenge(challenge) = f
        .store
        .runtime(
            f.principal(),
            RuntimeOperation::NativeChallenge {
                surface_id,
                enrollment_id,
                audience: audience.into(),
                challenge_id: Uuid::new_v4(),
                nonce: URL_SAFE_NO_PAD.encode([9u8; 32]),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native challenge");
    };
    let token_hash = hash(b"synthetic-native-lookup-session");
    let mut request = native_connection::OpenRequest {
        enrollment_id,
        challenge_id: challenge.challenge_id,
        epoch: f.epoch,
        expected_incarnation: challenge.current_incarnation,
        session_token_hash: token_hash.clone(),
        signature: String::new(),
    };
    let mut scalar = [0u8; 32];
    scalar[31] = 1;
    let key = SigningKey::from_bytes(&scalar).unwrap();
    let signature: Signature =
        key.sign(&native_connection::signing_message(&challenge, &request).unwrap());
    request.signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
    let RuntimeResult::NativeOpened {
        connection,
        duplicate: false,
    } = f
        .store
        .runtime(
            f.principal(),
            RuntimeOperation::OpenNative {
                surface_id,
                audience: audience.into(),
                request,
                incarnation: Uuid::new_v4(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("signed native admission");
    };
    f.approve(surface_id, 0, Some(f.provider.clone())).await;
    let stamp = f.stamp(1);
    let result = f
        .runtime
        .sequenced_room_text(
            f.principal(),
            RoomProof::Native(NativeProof {
                surface_id,
                incarnation: connection.incarnation,
                token_hash,
            }),
            stamp.clone(),
            "Find public astronomy news".into(),
        )
        .await
        .unwrap();
    let fence = f.assert_committed_request(stamp.instance_id).await;
    assert_eq!(fence.origin_surface, surface_id);
    let RuntimeResult::Proposed(action) = result else {
        panic!("native lookup result");
    };
    assert_eq!(action.surface_id, f.browser.surface_id);
    assert_eq!(action.channel, Channel::VisualCard);
    assert_eq!(action.privacy, PrivacyClass::SharedRoom);
    assert!(action.intent.text().ends_with(SOURCE_URL));
    assert_eq!(action.content_digest, hash(action.intent.text().as_bytes()));
    assert_eq!(f.poll().await[0].id, action.id);
    assert_eq!(f.model.calls.load(Ordering::SeqCst), 1);
    f.assert_private_store_untouched();
}

#[tokio::test]
async fn ambiance_lookup_private_provider_evidence_blocks_output_even_when_row_is_omitted() {
    for omitted in [false, true] {
        let mut sources = Vec::new();
        if omitted {
            for index in 0..3 {
                sources.push(LookupSource {
                    title: format!("public astronomy news {}", "a".repeat(160)),
                    snippet: "b".repeat(640),
                    url: format!(
                        "https://example.org/article-{index}?padding={}",
                        "x".repeat(900)
                    ),
                });
            }
        }
        sources.push(LookupSource {
            title: "A result referring to my notes".into(),
            snippet: "This source requires a private context.".into(),
            url: "https://example.org/last-result".into(),
        });
        if omitted {
            let card = lookup_card(
                PUBLIC_QUERY,
                &LookupEvidence {
                    sources: sources.clone(),
                    privacy_floor: PrivacyClass::Private,
                },
            );
            assert!(
                !card.contains("my notes"),
                "fixture must exercise a row beyond the presentation limit"
            );
            assert!(card.contains("Additional source results were omitted"));
        }
        let body = serde_json::json!({"results": sources.iter().map(|source| {
            serde_json::json!({"title":source.title,"content":source.snippet,"url":source.url,"engine":"bing"})
        }).collect::<Vec<_>>()}).to_string();
        let f = lookup_fixture(PUBLIC_QUERY, 200, body, false).await;
        f.approve(f.browser.surface_id, 0, Some(f.provider.clone()))
            .await;
        let stamp = f.stamp(1);
        let result = f
            .runtime
            .sequenced_room_text(
                f.principal(),
                RoomProof::Browser(f.browser.clone()),
                stamp.clone(),
                "Find public astronomy news".into(),
            )
            .await
            .unwrap();
        f.assert_committed_request(stamp.instance_id).await;
        assert!(matches!(result, RuntimeResult::Blocked));
        assert!(f.poll().await.is_empty());
        let ledger = f.store.ambiance_ledger_events(f.principal()).await;
        let completed: Vec<_> = ledger
            .iter()
            .filter_map(|event| match event {
                LedgerEvent::Runtime(event) => match &event.data {
                    RuntimeData::LookupCompleted { receipt, .. } => Some(receipt),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].privacy, PrivacyClass::Private);
        assert_eq!(
            completed[0].evidence_digest,
            hash(
                &serde_json::to_vec(&LookupEvidence {
                    sources,
                    privacy_floor: PrivacyClass::Private
                })
                .unwrap()
            )
        );
        f.assert_private_store_untouched();
    }
}

#[tokio::test]
async fn ambiance_lookup_full_response_privacy_survives_projection_and_blocks_service_output() {
    let kept = LookupSource {
        title: "Public astronomy news".into(),
        snippet: "Visible source".into(),
        url: "https://example.org/kept".into(),
    };
    let cases = [
        (
            "private marker beyond title cap",
            serde_json::json!({"results":[{
                "title": format!("{} my notes", "x".repeat(200)),
                "content": kept.snippet, "url": kept.url
            }]}).to_string(),
            LookupEvidence {
                sources: vec![LookupSource { title: format!("{}…", "x".repeat(189)), ..kept.clone() }],
                privacy_floor: PrivacyClass::Private,
            },
        ),
        (
            "sensitive marker beyond snippet cap",
            serde_json::json!({"results":[{
                "title": kept.title,
                "content": format!("{} password", "y".repeat(650)), "url": kept.url
            }]}).to_string(),
            LookupEvidence {
                sources: vec![LookupSource { snippet: format!("{}…", "y".repeat(637)), ..kept.clone() }],
                privacy_floor: PrivacyClass::Sensitive,
            },
        ),
        (
            "private marker in filtered non-web source",
            serde_json::json!({"results":[
                {"title":kept.title,"content":kept.snippet,"url":kept.url},
                {"title":"my notes","content":"Discarded source","url":"file:///discarded"}
            ]}).to_string(),
            LookupEvidence { sources: vec![kept.clone()], privacy_floor: PrivacyClass::Private },
        ),
        (
            "escaped sensitive marker in overwritten ignored field",
            // Keep the original JSON bytes: decoding into Value would erase
            // the first duplicate field and the privacy evidence it carries.
            r#"{"results":[{"title":"Public astronomy news","content":"Visible source","url":"https://example.org/kept"}],"ignored":"\u0070assword","ignored":"ordinary","privacy":"public"}"#.into(),
            LookupEvidence { sources: vec![kept], privacy_floor: PrivacyClass::Sensitive },
        ),
        (
            "private response with no source results",
            r#"{"results":[],"ignored":"my notes"}"#.into(),
            LookupEvidence { sources: vec![], privacy_floor: PrivacyClass::Private },
        ),
        (
            "escaped sensitive response with no source results",
            r#"{"results":[],"ignored":"\u0070assword","ignored":"ordinary","privacy":"public"}"#.into(),
            LookupEvidence { sources: vec![], privacy_floor: PrivacyClass::Sensitive },
        ),
    ];
    for (case, body, evidence) in cases {
        assert!(
            evidence
                .sources
                .iter()
                .all(
                    |source| input_privacy(&source.title) <= PrivacyClass::SharedRoom
                        && input_privacy(&source.snippet) <= PrivacyClass::SharedRoom
                        && input_privacy(&source.url) <= PrivacyClass::SharedRoom
                ),
            "{case} must depend on privacy outside the retained source text"
        );
        let f = lookup_fixture(PUBLIC_QUERY, 200, body, false).await;
        f.approve(f.browser.surface_id, 0, Some(f.provider.clone()))
            .await;
        let stamp = f.stamp(1);
        let result = f
            .runtime
            .sequenced_room_text(
                f.principal(),
                RoomProof::Browser(f.browser.clone()),
                stamp.clone(),
                "Find public astronomy news".into(),
            )
            .await
            .unwrap();
        f.assert_committed_request(stamp.instance_id).await;
        assert!(matches!(result, RuntimeResult::Blocked), "{case}");
        assert!(f.poll().await.is_empty(), "{case} must not become a card");
        let ledger = f.store.ambiance_ledger_events(f.principal()).await;
        let completions: Vec<_> = ledger
            .iter()
            .filter_map(|event| match event {
                LedgerEvent::Runtime(event) => match &event.data {
                    RuntimeData::LookupCompleted { receipt, .. } => Some(receipt),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert_eq!(
            completions.len(),
            1,
            "{case} must complete classified evidence"
        );
        assert_eq!(completions[0].privacy, evidence.privacy_floor, "{case}");
        assert_eq!(
            completions[0].evidence_digest,
            hash(&serde_json::to_vec(&evidence).unwrap()),
            "{case}"
        );
        assert_eq!(f.model.calls.load(Ordering::SeqCst), 1, "{case}");
        assert_eq!(f.calls.load(Ordering::SeqCst), 1, "{case}");
        f.assert_private_store_untouched();
    }
}
