use super::*;
use crate::ambiance::{Action, ActionStatus, BrowserControl, Channel, InputStamp, RecentContextKind, RoomProof, RuntimeData, ledger::LedgerEvent};
use crate::backends::{
    lookup::{LookupProviderIdentity, LookupService},
    places::{self, LookupEvidence, LookupPlace},
};
use crate::integrations::{MapsConfig, SearchConfig};
use crate::store::{MemoryStore, Store};
use crate::surface_registry::{Mutation, hash};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};

const QUERY: &str = "observatory Copenhagen";
const PROMPT: &str = "Find the address of the observatory in Copenhagen.";
const PLACE_ID: &str = "transient-provider-place-id";
const PLACE_NAME: &str = "Transient Observatory Name";
const ADDRESS: &str = "17 Provider Address Lane";
const SOURCE_URL: &str = "https://maps.google.com/?cid=123456";
const ATTRIBUTION: &str =
    "<a href=\"https://attribution.example/source\">Provider credit canary</a>";
const PROVIDER_KEY: &str = "synthetic-places-conversation-key";

struct PlacesModel {
    calls: AtomicUsize,
}

#[tonic::async_trait]
impl ChatModel for PlacesModel {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].content, PROMPT);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "propose_information");
        for message in messages {
            for unavailable in ["PRIVATE_CANARY", PLACE_NAME, ADDRESS, ATTRIBUTION] {
                assert!(!message.content.contains(unavailable));
            }
        }
        Ok(ChatResponse {
            tool_call: Some(ToolCall {
                name: "propose_information".into(),
                arguments: serde_json::json!({"place_lookup":{"query":format!("  {QUERY}  ")},"privacy":"public"}).to_string(),
            }),
            ..Default::default()
        })
    }
}

struct Observation {
    request: String,
    ledger: Vec<LedgerEvent>,
}

struct PlacesFixture {
    runtime: Arc<AmbianceRuntime>,
    store: Arc<MemoryStore>,
    auth: AuthenticatedRequest,
    browser: BrowserProof,
    epoch: Uuid,
    config: MapsConfig,
    provider: LookupProviderIdentity,
    model: Arc<PlacesModel>,
    observations: Arc<Mutex<Vec<Observation>>>,
    calls: Arc<AtomicUsize>,
    received: Arc<Notify>,
    release: Arc<Notify>,
    responded: Arc<Notify>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for PlacesFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl PlacesFixture {
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
        service: LookupService,
        surface_id: Uuid,
        expected_revision: u64,
        provider: Option<LookupProviderIdentity>,
    ) {
        let RuntimeResult::LookupPolicy { binding, .. } = self
            .store
            .runtime(
                self.principal(),
                RuntimeOperation::LookupPolicy {
                    service,
                    surface_id,
                },
            )
            .await
            .unwrap()
        else {
            panic!("current lookup approval binding")
        };
        let result = self
            .store
            .runtime(
                self.principal(),
                RuntimeOperation::SetLookupPolicy {
                    service,
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
        assert!(
            matches!(result, RuntimeResult::LookupPolicy { approval: Some(approval), .. }
            if approval.revision == expected_revision + 1)
        );
    }

    async fn allow_places(&self) {
        self.approve(
            LookupService::Places,
            self.browser.surface_id,
            0,
            Some(self.provider.clone()),
        )
        .await;
    }

    async fn request(&self, stamp: InputStamp) -> Result<RuntimeResult, tonic::Status> {
        self.runtime
            .sequenced_room_text(
                self.principal(),
                RoomProof::Browser(self.browser.clone()),
                stamp,
                PROMPT.into(),
            )
            .await
    }

    fn spawn_request(
        &self,
        stamp: InputStamp,
    ) -> tokio::task::JoinHandle<Result<RuntimeResult, tonic::Status>> {
        let (runtime, principal, browser) = (
            self.runtime.clone(),
            self.principal().to_owned(),
            self.browser.clone(),
        );
        tokio::spawn(async move {
            runtime
                .sequenced_room_text(
                    &principal,
                    RoomProof::Browser(browser),
                    stamp,
                    PROMPT.into(),
                )
                .await
        })
    }

    async fn committed_request(&self, turn_id: Uuid) -> TurnFence {
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
        .expect("actual loopback Places request");
        let observations = self.observations.lock().await;
        assert_eq!(observations.len(), 1);
        assert_eq!(self.calls.load(Ordering::SeqCst), 1);
        let observation = &observations[0];
        let mut previous = String::new();
        for (index, event) in observation.ledger.iter().enumerate() {
            assert_eq!(event.sequence(), index as u64 + 1);
            assert_eq!(event.previous_hash(), previous);
            previous = event.hash().unwrap();
        }
        let starts: Vec<_> = observation
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
        assert_eq!(
            starts.len(),
            1,
            "provider observes the already-committed lookup"
        );
        let (fence, lookup) = starts[0];
        assert_eq!(fence.turn_id, turn_id);
        assert_eq!(lookup.policy_revision, 1);
        assert_eq!(lookup.request.provider, self.provider);
        assert_eq!(
            lookup.request.provider.provider.service(),
            LookupService::Places
        );
        assert_eq!(lookup.request.privacy, PrivacyClass::SharedRoom);
        assert!(lookup.receipt.is_none());
        assert!(observation.ledger.iter().any(|event| matches!(event,
            LedgerEvent::Runtime(event) if matches!(&event.data, RuntimeData::PlaceLookupPolicyChanged { surface_id, approval }
                if *surface_id == fence.origin_surface && approval.revision == 1 && approval.policy.is_some()))));
        assert!(!observation.ledger.iter().any(|event| matches!(event,
            LedgerEvent::Runtime(event) if matches!(event.data, RuntimeData::LookupCompleted { .. }))));
        let target = observation
            .request
            .lines()
            .next()
            .unwrap()
            .strip_prefix("GET ")
            .unwrap()
            .strip_suffix(" HTTP/1.1")
            .unwrap();
        let mut url = reqwest::Url::parse(&self.provider.endpoint)
            .unwrap()
            .join(target)
            .unwrap();
        assert_eq!(url.path(), "/maps/api/place/textsearch/json");
        let parameters: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(
            parameters,
            std::collections::BTreeMap::from([
                ("query".into(), QUERY.into()),
                ("key".into(), PROVIDER_KEY.into()),
            ]),
            "named query carries no implicit location, radius or ranking bias"
        );
        assert!(
            observation
                .request
                .to_ascii_lowercase()
                .contains("\r\naccept: application/json\r\n")
        );
        url.set_query(None);
        url.query_pairs_mut().append_pair("query", QUERY);
        assert_eq!(lookup.request.query_digest, hash(QUERY.as_bytes()));
        assert_eq!(
            lookup.request.payload_digest,
            hash(format!("GET\n{}\naccept:application/json\n", url.as_str()).as_bytes())
        );
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
            panic!("browser action poll")
        };
        actions
    }

    async fn assert_content_free_state(&self) {
        let state = self.store.ambiance_runtime_state(self.principal()).await;
        let ledger = self.store.ambiance_ledger_events(self.principal()).await;
        for serialized in [
            serde_json::to_string(&state).unwrap(),
            serde_json::to_string(&ledger).unwrap(),
        ] {
            for content in [
                PLACE_ID,
                PLACE_NAME,
                ADDRESS,
                SOURCE_URL,
                ATTRIBUTION,
                "Provider credit canary",
                PROVIDER_KEY,
                "55.6761",
                "12.5683",
            ] {
                assert!(
                    !serialized.contains(content),
                    "durable authority must omit provider content and credentials"
                );
            }
        }
        assert!(
            state
                .actions
                .values()
                .all(|action| action.channel != Channel::AudioTts)
        );
        assert!(
            state
                .turn
                .as_ref()
                .is_none_or(|turn| turn.disclosures.is_empty())
        );
        assert!(!ledger.iter().any(|event| matches!(event,
            LedgerEvent::Runtime(event) if matches!(event.data, RuntimeData::ProviderDisclosureStarted { .. } | RuntimeData::ProviderDisclosureDenied { .. }))));
        assert_eq!(
            self.store.assistant_private_accesses.load(Ordering::SeqCst),
            0
        );
        assert_eq!(self.model.calls.load(Ordering::SeqCst), 1);
    }

    async fn assert_cancelled(&self, turn_id: Uuid) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let state = self.store.ambiance_runtime_state(self.principal()).await;
                if state
                    .turn
                    .as_ref()
                    .is_some_and(|turn| turn.fence.turn_id == turn_id && turn.cancelled)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("failed lookup cancels its admitted turn");
        assert!(self.poll().await.is_empty());
    }
}

async fn places_fixture(status: u16, body: String, gated: bool) -> PlacesFixture {
    let model = Arc::new(PlacesModel {
        calls: AtomicUsize::new(0),
    });
    let (runtime, store, auth) = fixture(model.clone()).await;
    let principal = auth.principal.expose_for_authorization().to_owned();
    store
        .create_indexed_note(&principal, None, None, Some("PRIVATE_CANARY"))
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/maps/api/place/textsearch/json",
        listener.local_addr().unwrap()
    );
    let config = MapsConfig {
        google_maps_key: Some(PROVIDER_KEY.into()),
    };
    let provider = places::lookup_providers_for_test(&config, &endpoint).remove(0);
    let runtime = Arc::new(
        Arc::try_unwrap(runtime)
            .ok()
            .unwrap()
            .with_places_config_for_test(config.clone(), endpoint),
    );
    let browser = BrowserProof {
        surface_id: Uuid::new_v4(),
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"places-browser-fixture"),
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
    let responded = Arc::new(Notify::new());
    let server = {
        let (store, observations, calls, received, release, responded) = (
            store.clone(),
            observations.clone(),
            calls.clone(),
            received.clone(),
            release.clone(),
            responded.clone(),
        );
        tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        calls.fetch_add(1, Ordering::SeqCst);
                        let (store, principal, observations, received, release, responded, body) = (store.clone(), principal.clone(), observations.clone(), received.clone(), release.clone(), responded.clone(), body.clone());
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
                            observations.lock().await.push(Observation { request, ledger });
                            received.notify_one();
                            if gated { release.notified().await; }
                            let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = socket.write_all(response.as_bytes()).await;
                            let _ = socket.shutdown().await;
                            responded.notify_one();
                        });
                    }
                    completed = handlers.join_next(), if !handlers.is_empty() => { completed.unwrap().unwrap(); }
                }
            }
        })
    };
    PlacesFixture {
        runtime,
        store,
        auth,
        browser,
        epoch,
        config,
        provider,
        model,
        observations,
        calls,
        received,
        release,
        responded,
        server,
    }
}

fn source_response() -> String {
    serde_json::json!({"status":"OK","html_attributions":[ATTRIBUTION],"results":[{
        "place_id":PLACE_ID,"name":PLACE_NAME,"formatted_address":ADDRESS,
        "geometry":{"location":{"lat":55.6761,"lng":12.5683}},"url":SOURCE_URL
    }]})
    .to_string()
}

fn evidence(empty: bool, privacy_floor: PrivacyClass) -> LookupEvidence {
    LookupEvidence {
        places: if empty {
            vec![]
        } else {
            vec![LookupPlace {
                place_id: PLACE_ID.into(),
                name: PLACE_NAME.into(),
                address: ADDRESS.into(),
                latitude: 55.6761,
                longitude: 12.5683,
                source_url: Some(SOURCE_URL.into()),
            }]
        },
        html_attributions: vec![ATTRIBUTION.into()],
        privacy_floor,
    }
}

#[tokio::test]
async fn ambiance_places_conversation_commits_before_http_deduplicates_and_keeps_content_transient()
{
    let mut f = places_fixture(200, source_response(), true).await;
    f.allow_places().await;
    let stamp = f.stamp(1);
    let task = f.spawn_request(stamp.clone());
    let fence = f.committed_request(stamp.instance_id).await;
    assert_eq!(fence.origin_surface, f.browser.surface_id);
    assert!(matches!(
        f.request(stamp.clone()).await.unwrap(),
        RuntimeResult::Duplicate(_)
    ));
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.model.calls.load(Ordering::SeqCst), 1);
    f.release.notify_one();
    let RuntimeResult::Proposed(action) = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("structured Places proposal")
    };
    assert_eq!(action.surface_id, f.browser.surface_id);
    assert_eq!(action.channel, Channel::VisualCard);
    assert_eq!(action.privacy, PrivacyClass::SharedRoom);
    let SemanticIntent::PlaceAddressCard { content } = &action.intent else {
        panic!("transient card reference")
    };
    assert!(content.valid());
    assert_eq!(action.content_digest, content.digest);
    assert!(action.intent.text().is_empty());
    let card = f
        .runtime
        .visual_card(f.principal(), &action)
        .expect("transient payload exists");
    assert_eq!(
        card.value(),
        serde_json::json!({"kind":"places","query":QUERY,"items":[{
        "placeId":PLACE_ID,"name":PLACE_NAME,"address":ADDRESS,"sourceUrl":SOURCE_URL
    }],"attributions":[ATTRIBUTION]})
    );
    let digest = hash(
        serde_json::json!([
            "cosmos.place-address-card",
            1,
            QUERY,
            [[PLACE_ID, PLACE_NAME, ADDRESS, SOURCE_URL]],
            [ATTRIBUTION]
        ])
        .to_string()
        .as_bytes(),
    );
    assert_eq!(card.digest(), digest);
    assert_eq!(action.content_digest, digest);
    let state = f.store.ambiance_runtime_state(f.principal()).await;
    let lookup = state.turn.as_ref().unwrap().lookup.as_ref().unwrap();
    let receipt = lookup.receipt.as_ref().unwrap();
    assert_eq!(
        receipt.evidence_digest,
        hash(&serde_json::to_vec(&evidence(false, PrivacyClass::SharedRoom)).unwrap())
    );
    assert_eq!(f.poll().await[0].id, action.id);
    f.assert_content_free_state().await;
    drop(card);
    let recreated = Arc::new(
        AmbianceRuntime::new(f.store.clone(), f.model.clone(), f.runtime.pairing.clone())
            .with_places_config_for_test(f.config.clone(), f.provider.endpoint.clone()),
    );
    drop(std::mem::replace(&mut f.runtime, recreated));
    assert!(f.runtime.visual_card(f.principal(), &action).is_none());
    assert!(matches!(
        f.request(stamp).await.unwrap(),
        RuntimeResult::Duplicate(_)
    ));
    assert!(f.runtime.visual_card(f.principal(), &action).is_none());
    assert_eq!(
        f.calls.load(Ordering::SeqCst),
        1,
        "missing process content cannot trigger provider replay"
    );
    f.assert_content_free_state().await;
}

#[tokio::test]
async fn ambiance_places_conversation_permission_is_separate_from_web_and_other_origins() {
    for case in ["missing", "web_only", "other_origin", "revoked"] {
        let f = places_fixture(200, source_response(), false).await;
        match case {
            "web_only" => {
                let provider = crate::backends::search::lookup_providers_for_test(&SearchConfig {
                    searxng_base_url: Some("http://127.0.0.1:9".into()),
                    ..Default::default()
                })
                .remove(0);
                f.approve(LookupService::Web, f.browser.surface_id, 0, Some(provider))
                    .await;
            }
            "other_origin" => {
                let pin = crate::surface_registry::pin_surface_id(f.principal(), "abcd");
                f.approve(LookupService::Places, pin, 0, Some(f.provider.clone()))
                    .await;
            }
            "revoked" => {
                f.allow_places().await;
                f.approve(LookupService::Places, f.browser.surface_id, 1, None)
                    .await;
            }
            _ => {}
        }
        let RuntimeResult::Proposed(action) = f.request(f.stamp(1)).await.unwrap() else {
            panic!("permission explanation for {case}")
        };
        assert!(matches!(
            action.intent,
            SemanticIntent::VisualTextCard { .. }
        ));
        assert!(action.intent.text().contains("Places lookup"));
        assert!(action.intent.text().contains(if case == "revoked" {
            "permission is off"
        } else {
            "not enabled"
        }));
        assert!(f.runtime.visual_card(f.principal(), &action).is_none());
        assert_eq!(f.calls.load(Ordering::SeqCst), 0, "{case}");
        assert!(f.observations.lock().await.is_empty());
        let ledger = f.store.ambiance_ledger_events(f.principal()).await;
        assert!(!ledger.iter().any(|event| matches!(event, LedgerEvent::Runtime(event)
            if matches!(event.data, RuntimeData::LookupStarted { .. } | RuntimeData::LookupCompleted { .. }))));
        f.assert_content_free_state().await;
    }
}

#[tokio::test]
async fn ambiance_places_conversation_revocation_cancels_waiting_provider_without_rendering_late_result()
 {
    let f = places_fixture(200, source_response(), true).await;
    f.allow_places().await;
    let stamp = f.stamp(1);
    let task = f.spawn_request(stamp.clone());
    f.committed_request(stamp.instance_id).await;
    f.approve(LookupService::Places, f.browser.surface_id, 1, None)
        .await;
    let error = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    f.release.notify_one();
    tokio::time::timeout(Duration::from_secs(2), f.responded.notified())
        .await
        .unwrap();
    f.assert_cancelled(stamp.instance_id).await;
    let state = f.store.ambiance_runtime_state(f.principal()).await;
    assert!(state.turn.unwrap().lookup.unwrap().receipt.is_none());
    assert!(f.runtime.visual.bindings().is_empty());
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    f.assert_content_free_state().await;
}

#[tokio::test]
async fn ambiance_places_conversation_full_response_privacy_blocks_even_unrendered_fields() {
    for (marker, privacy) in [
        ("my notes", PrivacyClass::Private),
        (r#"\u0070assword"#, PrivacyClass::Sensitive),
    ] {
        let body = source_response();
        let body = format!(
            "{},\"ignored\":\"{}\",\"ignored\":\"ordinary\",\"privacy\":\"public\"}}",
            body.strip_suffix('}').unwrap(),
            marker
        );
        let f = places_fixture(200, body, false).await;
        f.allow_places().await;
        let stamp = f.stamp(1);
        assert!(matches!(
            f.request(stamp.clone()).await.unwrap(),
            RuntimeResult::Blocked
        ));
        f.committed_request(stamp.instance_id).await;
        assert!(f.poll().await.is_empty());
        assert!(f.runtime.visual.bindings().is_empty());
        let state = f.store.ambiance_runtime_state(f.principal()).await;
        let receipt = state
            .turn
            .as_ref()
            .unwrap()
            .lookup
            .as_ref()
            .unwrap()
            .receipt
            .as_ref()
            .unwrap();
        assert_eq!(receipt.privacy, privacy);
        assert_eq!(
            receipt.evidence_digest,
            hash(&serde_json::to_vec(&evidence(false, privacy)).unwrap())
        );
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        f.assert_content_free_state().await;
    }
}

#[tokio::test]
async fn ambiance_places_conversation_provider_errors_cancel_without_lookup_completion_or_text_fallback()
 {
    for (status, body) in [
        (503, source_response()),
        (200, r#"{"status":"REQUEST_DENIED","results":[]}"#.into()),
    ] {
        let f = places_fixture(status, body, false).await;
        f.allow_places().await;
        let stamp = f.stamp(1);
        let error = f.request(stamp.clone()).await.unwrap_err();
        assert_eq!(error.code(), tonic::Code::Unavailable);
        f.committed_request(stamp.instance_id).await;
        f.assert_cancelled(stamp.instance_id).await;
        let state = f.store.ambiance_runtime_state(f.principal()).await;
        assert!(state.turn.unwrap().lookup.unwrap().receipt.is_none());
        assert!(f.runtime.visual.bindings().is_empty());
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        f.assert_content_free_state().await;
    }
}

#[tokio::test]
async fn ambiance_places_conversation_zero_results_preserves_attribution_in_structured_card() {
    let f = places_fixture(
        200,
        serde_json::json!({"status":"ZERO_RESULTS","results":[],"html_attributions":[ATTRIBUTION]})
            .to_string(),
        false,
    )
    .await;
    f.allow_places().await;
    let stamp = f.stamp(1);
    let RuntimeResult::Proposed(action) = f.request(stamp.clone()).await.unwrap() else {
        panic!("empty Places card")
    };
    f.committed_request(stamp.instance_id).await;
    assert!(matches!(
        action.intent,
        SemanticIntent::PlaceAddressCard { .. }
    ));
    let card = f.runtime.visual_card(f.principal(), &action).unwrap();
    assert_eq!(
        card.value(),
        serde_json::json!({"kind":"places","query":QUERY,"items":[],"attributions":[ATTRIBUTION]})
    );
    assert_eq!(card.digest(), action.content_digest);
    let state = f.store.ambiance_runtime_state(f.principal()).await;
    let turn = state.turn.as_ref().unwrap();
    assert_eq!(
        turn.lookup
            .as_ref()
            .unwrap()
            .receipt
            .as_ref()
            .unwrap()
            .evidence_digest,
        hash(&serde_json::to_vec(&evidence(true, PrivacyClass::SharedRoom)).unwrap())
    );
    f.assert_content_free_state().await;
    f.runtime.cancel(f.principal(), &turn.fence).await.unwrap();
    assert!(
        f.runtime.visual_card(f.principal(), &action).is_none(),
        "explicit runtime cancellation retires transient content"
    );
    let terminal = f.poll().await;
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].id, action.id);
    assert_eq!(terminal[0].status, ActionStatus::Cancelled);
    assert!(
        f.store
            .runtime(
                f.principal(),
                RuntimeOperation::CheckDelivery {
                    connection: RoomProof::Browser(f.browser.clone()),
                    action_id: action.id,
                    generation: action.generation,
                }
            )
            .await
            .is_err()
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ambiance_places_conversation_owner_revocation_retires_cached_content_without_browser_poll()
{
    let f = places_fixture(200, source_response(), false).await;
    f.allow_places().await;
    let RuntimeResult::Proposed(action) = f.request(f.stamp(1)).await.unwrap() else {
        panic!("Places card")
    };
    assert!(f.runtime.visual_card(f.principal(), &action).is_some());
    f.approve(LookupService::Places, f.browser.surface_id, 1, None)
        .await;
    super::super::retire_visual_content(&f.runtime.store, &f.runtime.visual).await;
    assert!(f.runtime.visual_card(f.principal(), &action).is_none());
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    f.assert_content_free_state().await;
}

/// "The restaurant I just found on the computer": a completed place lookup
/// leaves the owner's own query as bounded recent context, and the next
/// request's cognition is offered it under the ledger's eye. Provider content
/// still never enters durable state.
#[tokio::test]
async fn ambiance_places_conversation_leaves_recent_context_for_the_next_request() {
    let f = places_fixture(200, source_response(), false).await;
    f.allow_places().await;
    let RuntimeResult::Proposed(first) = f.request(f.stamp(1)).await.unwrap() else {
        panic!("structured Places proposal")
    };
    let state = f.store.ambiance_runtime_state(f.principal()).await;
    let context = state.recent_context.clone().expect("recent place query");
    assert_eq!(context.text.trim(), QUERY);
    assert_eq!(context.source_surface, f.browser.surface_id);
    assert_eq!(context.privacy, PrivacyClass::SharedRoom);
    f.assert_content_free_state().await;
    f.store
        .runtime(
            f.principal(),
            RuntimeOperation::RoomControl {
                connection: RoomProof::Browser(f.browser.clone()),
                stamp: InputStamp {
                    epoch: f.epoch,
                    sequence: 2,
                    instance_id: first.turn_id,
                },
                control: BrowserControl::Cancel {
                    turn_id: first.turn_id,
                    generation: first.generation,
                },
            },
        )
        .await
        .unwrap();
    let RuntimeResult::Proposed(second) = f.request(f.stamp(3)).await.unwrap() else {
        panic!("second structured Places proposal")
    };
    assert_ne!(second.turn_id, first.turn_id);
    let ledger = f.store.ambiance_ledger_events(f.principal()).await;
    let offered = ledger.iter().filter(|event| match event {
        LedgerEvent::Runtime(event) => matches!(
            &event.data,
            RuntimeData::RecentContextOffered { fence, context, source_surface, .. }
                if fence.turn_id == second.turn_id
                    && *context == RecentContextKind::PlaceQuery
                    && *source_surface == f.browser.surface_id
        ),
        _ => false,
    });
    assert_eq!(offered.count(), 1);
    assert!(ledger.iter().any(|event| matches!(
        event,
        LedgerEvent::Runtime(event) if matches!(event.data, RuntimeData::RecentContextRemembered { .. })
    )));
    assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    // Two conversational turns, still no provider content in durable state.
    let state = serde_json::to_string(&f.store.ambiance_runtime_state(f.principal()).await).unwrap();
    let ledger = serde_json::to_string(&ledger).unwrap();
    for content in [PLACE_ID, PLACE_NAME, ADDRESS, SOURCE_URL, ATTRIBUTION, PROVIDER_KEY] {
        assert!(!state.contains(content) && !ledger.contains(content), "{content}");
    }
}
