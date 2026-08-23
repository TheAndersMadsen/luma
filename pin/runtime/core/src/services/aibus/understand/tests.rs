use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use crate::external::osm::OsmOptions;

struct SetupCancellationProbe(Arc<AtomicBool>);

impl Drop for SetupCancellationProbe {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn sensitive_setup_panic_returns_a_fixed_internal_status() {
    let result: Result<Option<()>, Status> = sensitive_setup_before_deadline(
        async { panic!("synthetic confidential setup panic") },
        tokio::time::Instant::now() + Duration::from_secs(1),
        "Understand",
    )
    .await;

    let status = result.unwrap_err();
    assert_eq!(status.code(), tonic::Code::Internal);
    assert_eq!(status.message(), "stock understanding setup failed");
}

#[tokio::test(start_paused = true)]
async fn sensitive_setup_deadline_aborts_and_drops_pending_work() {
    let dropped = Arc::new(AtomicBool::new(false));
    let dropped_by_setup = dropped.clone();
    let deadline = Duration::from_secs(5);
    let result = sensitive_setup_before_deadline(
        async move {
            let _probe = SetupCancellationProbe(dropped_by_setup);
            futures::future::pending::<()>().await;
            Ok::<(), Status>(())
        },
        tokio::time::Instant::now() + deadline,
        "Understand",
    );
    tokio::pin!(result);

    tokio::select! {
        biased;
        output = &mut result => panic!("setup unexpectedly completed: {output:?}"),
        () = tokio::task::yield_now() => {}
    }
    tokio::time::advance(deadline).await;
    assert_eq!(result.await.unwrap(), None);
    assert!(
        dropped.load(Ordering::SeqCst),
        "deadline must abort and drop pending setup work"
    );
}

#[tokio::test]
async fn dropping_sensitive_setup_aborts_instead_of_detaching_pending_work() {
    let dropped = Arc::new(AtomicBool::new(false));
    let dropped_by_setup = dropped.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(sensitive_setup_before_deadline(
        async move {
            let _probe = SetupCancellationProbe(dropped_by_setup);
            let _ = started_tx.send(());
            futures::future::pending::<()>().await;
            Ok::<(), Status>(())
        },
        tokio::time::Instant::now() + Duration::from_secs(30),
        "Understand",
    ));

    started_rx.await.expect("setup task started");
    caller.abort();
    let _ = caller.await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while !dropped.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropping the caller must promptly drop setup work");
}

#[tokio::test]
async fn forwarder_wakes_on_response_stream_drop_so_a_silent_planner_is_cancelled() {
    let (unbounded_tx, unbounded_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<SynapseUnderstandingResponse, Status>>();
    let (frame_tx, frame_rx) = tokio::sync::mpsc::channel(1);
    let task = tokio::spawn(forward_frames_to_response_stream(unbounded_rx, frame_tx));

    // The planner is parked emitting nothing (no frame in flight) when the
    // response stream goes away. The forwarder must wake on the channel
    // close itself; a plain `while recv()` loop would block here forever
    // because it only observes the closed sender on its next send.
    drop(frame_rx);
    tokio::time::timeout(std::time::Duration::from_secs(1), task)
        .await
        .expect("forwarder must wake on response-stream drop, not on the next frame")
        .unwrap();

    // Dropping the forwarder drops `unbounded_rx`, which is exactly what
    // fires the planner's `unbounded_tx.closed()` cancellation guard.
    tokio::time::timeout(std::time::Duration::from_secs(1), unbounded_tx.closed())
        .await
        .expect("planner cancellation guard must fire once the forwarder is gone");
}

#[tokio::test]
async fn forwarder_delivers_a_real_terminal_then_ends_when_the_planner_finishes() {
    let (unbounded_tx, unbounded_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<SynapseUnderstandingResponse, Status>>();
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::channel(1);
    let task = tokio::spawn(forward_frames_to_response_stream(unbounded_rx, frame_tx));

    unbounded_tx
        .send(Ok(SynapseUnderstandingResponse::action_response(
            native_actions::RESPOND,
            "I should return the completed answer",
            r#"{"Response":"done"}"#,
            "parent",
        )))
        .unwrap();
    let forwarded = tokio::time::timeout(std::time::Duration::from_secs(1), frame_rx.recv())
        .await
        .expect("a queued frame must forward")
        .expect("channel open")
        .unwrap();
    let Some(synapse_understanding_response::Body::Turn(turn)) = forwarded.body else {
        panic!("expected the forwarded turn");
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected an action turn");
    };
    assert_eq!(action.action, native_actions::RESPOND);

    // The planner finishing closes the unbounded sender, which ends the
    // forwarder and in turn closes the response stream.
    drop(unbounded_tx);
    tokio::time::timeout(std::time::Duration::from_secs(1), task)
        .await
        .expect("forwarder must end when the planner drops its sender")
        .unwrap();
    assert!(frame_rx.recv().await.is_none(), "response stream closes");
}

#[tokio::test]
async fn planner_panic_is_forwarded_as_a_sanitized_error_without_a_turn() {
    let (unbounded_tx, unbounded_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<SynapseUnderstandingResponse, Status>>();
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::channel(1);
    let forwarder = tokio::spawn(forward_frames_to_response_stream(unbounded_rx, frame_tx));

    let planner = spawn_sensitive_task(async move {
        panic!("synthetic planner panic payload");
    });
    let supervisor = tokio::spawn(report_planner_task_failure(planner, unbounded_tx.clone()));
    drop(unbounded_tx);

    let failure = tokio::time::timeout(std::time::Duration::from_secs(1), frame_rx.recv())
        .await
        .expect("planner panic must resolve promptly")
        .expect("planner panic must be forwarded instead of clean EOF")
        .expect_err("planner panic must be an error frame");
    assert_eq!(failure.code(), tonic::Code::Internal);
    assert_eq!(failure.message(), "understanding planner task failed");
    assert!(!failure
        .message()
        .contains("synthetic planner panic payload"));

    tokio::time::timeout(std::time::Duration::from_secs(1), supervisor)
        .await
        .expect("planner supervisor must resolve after reporting the panic")
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), forwarder)
        .await
        .expect("forwarder must close after the planner failure")
        .unwrap();
    assert!(frame_rx.recv().await.is_none(), "error is followed by EOF");
}

#[test]
fn production_agentic_path_cannot_construct_synthetic_turn_frames() {
    let source = include_str!("agentic.rs");
    let orchestration_start = source
        .find("async fn run_agentic_orchestration")
        .expect("agentic orchestration must exist");
    let dispatch_start = source[orchestration_start..]
        .find("async fn chat_turn_dispatch")
        .map(|offset| orchestration_start + offset)
        .expect("terminal dispatch must follow orchestration");
    let orchestration = &source[orchestration_start..dispatch_start];

    assert!(
        orchestration.contains("NoopTurnObserver"),
        "production must always use the observer that emits no turns"
    );
    for forbidden in [
        "ChannelTurnObserver",
        "predicted_early_cue_tool",
        "on_early_cue",
        "SynapseUnderstandingResponse::action_response",
        "SynapseUnderstandingResponse::observation_response",
        "last_turn_id",
        "close_unresolved_cue_chain",
    ] {
        assert!(
            !orchestration.contains(forbidden),
            "agentic orchestration must not contain synthetic turn path {forbidden}"
        );
    }

    let outcome_start = source
        .find("async fn chat_turn_outcome")
        .expect("chat-turn outcome must exist");
    let outcome_end = source[outcome_start..]
        .find("fn agentic_respond_or_empty")
        .map(|offset| outcome_start + offset)
        .expect("the next implementation section must follow chat-turn outcome");
    let outcome = &source[outcome_start..outcome_end];
    assert!(outcome.contains("DiscardCueSink"));
    assert!(!outcome.contains("info!(cue"));
    assert!(!outcome.contains("turn_referent"));
}

#[test]
fn noop_turn_observer_ignores_every_lifecycle_callback() {
    use crate::synapse::chat_turn_loop::ChatTurnObserver as _;
    let observer = crate::synapse::chat_turn_loop::NoopTurnObserver;
    observer.on_batch_start("knowledge_lookup");
    observer.on_batch_end("knowledge_lookup", true);
    observer.on_slow_step();
    assert_eq!(std::mem::size_of_val(&observer), 0);
}

struct UnaryCancellationProbe(Arc<AtomicBool>);

impl Drop for UnaryCancellationProbe {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn unary_deadline_request() -> SynapseUnderstandingRequest {
    SynapseUnderstandingRequest {
        utterance: "slow unary request".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![SynapseChatTurn {
                user: SynapseUser::User as i32,
                identifier: "unary-user".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: "slow unary request".into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[tokio::test(start_paused = true)]
async fn unary_timeout_cancels_work_returns_parent_linked_fallback_and_closes() {
    let deadline = Duration::from_secs(5);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_by_work = cancelled.clone();
    let request = unary_deadline_request();
    let task = tokio::spawn(async move {
        let late_work = async move {
            let _probe = UnaryCancellationProbe(cancelled_by_work);
            tokio::time::sleep(deadline + Duration::from_secs(1)).await;
            Ok(vec![SynapseUnderstandingResponse::action_response(
                native_actions::PLAY_MUSIC,
                "late action",
                r#"{"Track":"late"}"#,
                "unary-user",
            )])
        };
        run_finite_stock_turn(&request, "unary-run", "Understand", deadline, late_work).await
    });

    tokio::task::yield_now().await;
    tokio::time::advance(deadline).await;
    let mut stream = task.await.unwrap().unwrap();
    assert!(
        cancelled.load(Ordering::SeqCst),
        "the unary planner must be dropped at the shared deadline"
    );
    let response = stream.next().await.unwrap().unwrap();
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected unary timeout action");
    };
    assert_eq!(turn.parent_identifier, "unary-user");
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected unary Respond fallback");
    };
    assert_eq!(action.action, native_actions::RESPOND);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({"Response": super::super::stock_deadline::TIMEOUT_FALLBACK})
    );

    tokio::time::advance(Duration::from_secs(10)).await;
    assert!(
        stream.next().await.is_none(),
        "the unary fallback stream must close without a late action"
    );
}

#[tokio::test(start_paused = true)]
async fn unary_fast_native_action_remains_unchanged_and_stream_is_finite() {
    let request = unary_deadline_request();
    let response = SynapseUnderstandingResponse::action_response(
        native_actions::PLAY_MUSIC,
        "fast native action",
        r#"{"Track":"Billie Jean"}"#,
        "unary-user",
    );
    let expected = response.encode_to_vec();
    let started = tokio::time::Instant::now();
    let mut stream = run_finite_stock_turn(
        &request,
        "unary-run",
        "Understand",
        STOCK_TURN_DEADLINE,
        async move { Ok(vec![response]) },
    )
    .await
    .unwrap();

    assert_eq!(tokio::time::Instant::now(), started);
    assert_eq!(
        stream.next().await.unwrap().unwrap().encode_to_vec(),
        expected
    );
    assert!(stream.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn encrypted_timeout_encrypts_only_the_fallback_then_closes_without_late_action() {
    let deadline = Duration::from_secs(5);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_by_work = cancelled.clone();
    let request = unary_deadline_request();
    let task = tokio::spawn(async move {
        let late_work = async move {
            let _probe = UnaryCancellationProbe(cancelled_by_work);
            tokio::time::sleep(deadline + Duration::from_secs(1)).await;
            Ok(vec![SynapseUnderstandingResponse::action_response(
                native_actions::PLAY_MUSIC,
                "late encrypted action",
                r#"{"Track":"late"}"#,
                "unary-user",
            )])
        };
        let stream = run_finite_stock_turn(
            &request,
            "encrypted-run",
            "EncryptedUnderstand",
            deadline,
            late_work,
        )
        .await?;
        Ok::<_, Status>(encrypt_understanding_stream(stream))
    });

    tokio::task::yield_now().await;
    tokio::time::advance(deadline).await;
    let mut stream = task.await.unwrap().unwrap();
    assert!(cancelled.load(Ordering::SeqCst));
    let encrypted = stream.next().await.unwrap().unwrap();
    let envelope = encrypted.response.expect("encrypted fallback envelope");
    assert_eq!(
        envelope
            .encryption_information
            .as_ref()
            .map(|information| information.kid.as_str()),
        Some(proto_kids::SYNAPSE_UNDERSTANDING_RESPONSE)
    );
    let fallback = SynapseUnderstandingResponse::decode(envelope.data.as_slice()).unwrap();
    let Some(synapse_understanding_response::Body::Turn(turn)) = fallback.body else {
        panic!("expected encrypted fallback action turn");
    };
    assert_eq!(turn.parent_identifier, "unary-user");
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected encrypted Respond fallback");
    };
    assert_eq!(action.action, native_actions::RESPOND);

    tokio::time::advance(Duration::from_secs(10)).await;
    assert!(stream.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn encrypted_fast_native_action_preserves_exact_payload_and_closes() {
    let request = unary_deadline_request();
    let response = SynapseUnderstandingResponse::action_response(
        native_actions::GET_CURRENT_LOCATION,
        "fast encrypted action",
        "{}",
        "unary-user",
    );
    let expected = response.encode_to_vec();
    let plain_stream = run_finite_stock_turn(
        &request,
        "encrypted-run",
        "EncryptedUnderstand",
        STOCK_TURN_DEADLINE,
        async move { Ok(vec![response]) },
    )
    .await
    .unwrap();
    let mut stream = encrypt_understanding_stream(plain_stream);

    let encrypted = stream.next().await.unwrap().unwrap();
    let envelope = encrypted
        .response
        .expect("encrypted native action envelope");
    assert_eq!(envelope.data, expected);
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn encrypted_stream_forwards_frames_while_the_plain_stream_remains_open() {
    let (plain_tx, plain_rx) =
        tokio::sync::mpsc::channel::<Result<SynapseUnderstandingResponse, Status>>(1);
    let plain_stream: UnderstandingStream =
        Box::pin(tokio_stream::wrappers::ReceiverStream::new(plain_rx));
    let mut encrypted_stream = encrypt_understanding_stream(plain_stream);

    let terminal = SynapseUnderstandingResponse::action_response(
        native_actions::RESPOND,
        "I should return the completed answer",
        r#"{"Response":"done"}"#,
        "request-turn",
    );
    let terminal_bytes = terminal.encode_to_vec();
    plain_tx.send(Ok(terminal)).await.unwrap();

    // `plain_tx` deliberately remains open here. The first encrypted frame
    // must arrive without waiting for source EOF.
    let encrypted =
        tokio::time::timeout(std::time::Duration::from_secs(1), encrypted_stream.next())
            .await
            .expect("the terminal encrypted frame must forward while the source is open")
            .expect("encrypted stream open")
            .expect("terminal encrypted frame ok");
    assert_eq!(
        encrypted.response.expect("terminal envelope").data,
        terminal_bytes
    );

    drop(plain_tx);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), encrypted_stream.next(),)
            .await
            .expect("encrypted stream must observe source EOF promptly")
            .is_none(),
        "encrypted stream ends after forwarding the real terminal"
    );
}

async fn test_understand_handler(
    vision_actions_enabled: bool,
) -> (
    tempfile::TempDir,
    Arc<RwLock<Config>>,
    Arc<UnderstandHandler>,
    VisionAutomationStore,
) {
    let directory = tempfile::tempdir().unwrap();
    let mut config = Config::load(&directory.path().join("missing.toml")).unwrap();
    config.llm.memory.enabled = false;
    // The camera->cloud consent is acknowledged in this fixture so the
    // `vision_actions_enabled` flag alone drives the behavior under test.
    // Consent-specific gating has its own dedicated tests.
    config.llm.vision_consent_acknowledged = true;
    config.feature_flags.overrides.insert(
        cloud_feature_flags::VISION_ACTIONS_ENABLED.into(),
        crate::feature_flags::ConfiguredFeatureFlagValue::Bool(vision_actions_enabled),
    );
    let live_config = Arc::new(RwLock::new(config.clone()));
    let resolved = Arc::new(ResolvedConfig::resolve(config));
    let http = reqwest::Client::new();
    let agent = Arc::new(
        LlmAgent::from_config(
            resolved.as_ref(),
            http.clone(),
            crate::llm::LlmRequestLogger::new(directory.path().join("logs")),
            None,
        )
        .await
        .unwrap(),
    );
    let db = Database::open(directory.path().join("test.sqlite")).unwrap();
    let automation_store = VisionAutomationStore::default();
    let food_gate = super::super::capabilities::food::FoodRuntimeGate::default();
    food_gate.enable_for_test();
    let handler = UnderstandHandler::new(
        agent,
        resolved.clone(),
        live_config.clone(),
        db,
        None,
        LiveImageStore::new(),
        http.clone(),
        NearbyClient::new(http, resolved.openstreetmap_options.clone()),
    )
    .with_vision_automation(automation_store.clone())
    .with_food_handler(FoodHandler::default().with_runtime_gate(food_gate));
    // Arc-wrapped to match production: the chat-turn task owns the
    // handler across the streamed response.
    (directory, live_config, Arc::new(handler), automation_store)
}

enum AgenticHostToolStep {
    Ready(Result<crate::llm::tool_step::ToolStepResult, String>),
    Pending(Arc<AtomicBool>),
}

struct AgenticHostCancellationProbe(Arc<AtomicBool>);

impl Drop for AgenticHostCancellationProbe {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct AgenticHostScriptedBackend {
    chat_steps: Mutex<std::collections::VecDeque<Result<crate::llm::ChatResult, String>>>,
    tool_steps: Mutex<std::collections::VecDeque<AgenticHostToolStep>>,
    chat_calls: AtomicUsize,
    tool_step_calls: AtomicUsize,
    tool_step_started: tokio::sync::Notify,
}

impl AgenticHostScriptedBackend {
    fn new(
        chat_steps: Vec<Result<crate::llm::ChatResult, String>>,
        tool_steps: Vec<AgenticHostToolStep>,
    ) -> Self {
        Self {
            chat_steps: Mutex::new(chat_steps.into_iter().collect()),
            tool_steps: Mutex::new(tool_steps.into_iter().collect()),
            chat_calls: AtomicUsize::new(0),
            tool_step_calls: AtomicUsize::new(0),
            tool_step_started: tokio::sync::Notify::new(),
        }
    }
}

impl crate::llm::backend::LlmBackend for AgenticHostScriptedBackend {
    fn chat<'a>(
        &'a self,
        _request: crate::llm::LlmChatRequest,
    ) -> crate::llm::backend::LlmFuture<'a> {
        self.chat_calls.fetch_add(1, Ordering::SeqCst);
        let step = self
            .chat_steps
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err("agentic host chat script exhausted".to_string()));
        Box::pin(async move { step })
    }

    fn tool_step<'a>(
        &'a self,
        _request: crate::llm::tool_step::ToolStepRequest,
    ) -> crate::llm::backend::ToolStepFuture<'a> {
        self.tool_step_calls.fetch_add(1, Ordering::SeqCst);
        self.tool_step_started.notify_one();
        match self
            .tool_steps
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| {
                AgenticHostToolStep::Ready(Err(
                    "agentic host chat-turn script exhausted".to_string()
                ))
            }) {
            AgenticHostToolStep::Ready(step) => Box::pin(async move { step }),
            AgenticHostToolStep::Pending(cancelled) => Box::pin(async move {
                let _probe = AgenticHostCancellationProbe(cancelled);
                futures::future::pending().await
            }),
        }
    }
}

const AGENTIC_HOST_USER_ID: &str = "5b51a3c2-836f-4c4d-b475-560beefdd9df";

fn agentic_host_request(utterance: &str) -> SynapseUnderstandingRequest {
    let request = request_with_user_turns(vec![user_turn(AGENTIC_HOST_USER_ID, utterance)]);
    let (index, turn, content) =
        trusted_current_user_request(&request).expect("current user turn must be trusted");
    assert_eq!(index, 0);
    assert_eq!(turn.identifier, AGENTIC_HOST_USER_ID);
    assert_eq!(selected_user_request_text(content), utterance);
    assert_eq!(
        trusted_authorizing_user_id(&request),
        Some(AGENTIC_HOST_USER_ID)
    );
    assert_eq!(
        request_device_lock_state(&request),
        DeviceLockState::Unlocked
    );
    request
}

async fn agentic_host_understand_handler(
    backend: Arc<AgenticHostScriptedBackend>,
) -> (tempfile::TempDir, Arc<UnderstandHandler>) {
    let directory = tempfile::tempdir().unwrap();
    let mut config = Config::load(&directory.path().join("missing.toml")).unwrap();
    config.llm.provider = crate::config::LlmProvider::OpenAi;
    config.llm.tools.enabled = true;
    config.llm.memory.enabled = false;
    let live_config = Arc::new(RwLock::new(config.clone()));
    let resolved = Arc::new(ResolvedConfig::resolve(config));
    let http = reqwest::Client::new();
    let llm_backend: Arc<dyn crate::llm::backend::LlmBackend> = backend;
    let agent = Arc::new(LlmAgent::from_backend(llm_backend));
    let db = Database::open(directory.path().join("agentic-host.sqlite")).unwrap();
    let osm_options = resolved.openstreetmap_options.clone();
    let handler = UnderstandHandler::new(
        agent,
        resolved,
        live_config,
        db,
        None,
        LiveImageStore::new(),
        http.clone(),
        NearbyClient::new(http.clone(), osm_options),
    )
    .with_agentic_external_clients(AgenticExternalClients::new(
        crate::external::google_maps::GoogleMapsClient::disabled(http.clone()),
        crate::external::open_food_facts::OpenFoodFactsClient::disabled(http.clone()),
        None,
        crate::external::web_search::WebSearch::new(
            Vec::new(),
            crate::external::web_search::WebSearchGeo::default(),
        ),
    ));
    (directory, Arc::new(handler))
}

fn response_action(
    response: SynapseUnderstandingResponse,
) -> (SynapseChatTurn, SynapseActionContent) {
    let Some(synapse_understanding_response::Body::Turn(mut turn)) = response.body else {
        panic!("expected a stock action turn");
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content.take() else {
        panic!("expected stock action content");
    };
    (turn, action)
}

#[tokio::test]
async fn agentic_host_scripted_final_answer_covers_orchestration_dispatch_and_outcome() {
    let backend = Arc::new(AgenticHostScriptedBackend::new(
        Vec::new(),
        vec![AgenticHostToolStep::Ready(Ok(
            crate::llm::tool_step::ToolStepResult::Final(
                "Rayleigh scattering makes the sky look blue.".to_string(),
            ),
        ))],
    ));
    let (_directory, handler) = agentic_host_understand_handler(backend.clone()).await;
    let request = agentic_host_request("why does the daytime sky look blue");

    let mut stream = handler
        .run_agentic_orchestration(
            TurnContext {
                req: &request,
                run_id: AGENTIC_HOST_USER_ID,
                utterance: &request.utterance,
                response_parent: AGENTIC_HOST_USER_ID,
                is_vision: false,
            },
            &[],
            None,
            ChatTurnSessionContinuity::Unary,
        )
        .await
        .unwrap()
        .expect("configured agentic host must claim the request");
    let response = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .expect("scripted chat-turn response must arrive")
        .expect("agentic host stream must contain one response")
        .unwrap();
    assert!(
        stream.next().await.is_none(),
        "agentic host stream must close after its terminal"
    );
    let (turn, action) = response_action(response);
    assert_eq!(turn.parent_identifier, AGENTIC_HOST_USER_ID);
    assert_eq!(action.action, native_actions::RESPOND);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({
            "Request": "why does the daytime sky look blue",
            "Response": "Rayleigh scattering makes the sky look blue."
        })
    );
    assert_eq!(backend.tool_step_calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.chat_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn agentic_host_real_runtime_breaker_cancels_pending_tool_step_and_returns_inner_fallback() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let backend = Arc::new(AgenticHostScriptedBackend::new(
        Vec::new(),
        vec![AgenticHostToolStep::Pending(cancelled.clone())],
    ));
    let (_directory, handler) = agentic_host_understand_handler(backend.clone()).await;
    let request = agentic_host_request("explain a subject that needs careful reasoning");
    let mut task = tokio::spawn(async move {
        tokio::time::timeout(
            AGENTIC_RUNTIME_TIMEOUT + Duration::from_secs(1),
            async move {
                let mut stream = handler
                    .understand_inner(MetadataMap::new(), request, "AgenticHostTest")
                    .await
                    .unwrap();
                let response = stream
                    .next()
                    .await
                    .expect("the inner breaker must return one fallback")
                    .unwrap();
                assert!(
                    stream.next().await.is_none(),
                    "inner breaker fallback must be terminal"
                );
                response
            },
        )
        .await
    });

    tokio::select! {
        () = backend.tool_step_started.notified() => {}
        result = &mut task => panic!("agentic host finished before starting its tool step: {result:?}"),
    }
    assert_eq!(
        backend.tool_step_calls.load(Ordering::SeqCst),
        1,
        "the returned stream must be polled into the pending tool-step future"
    );

    tokio::time::advance(AGENTIC_RUNTIME_TIMEOUT).await;
    for _ in 0..64 {
        if task.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
    }
    if !task.is_finished() {
        // Test-local watchdog: if the production 75-second timeout is deleted,
        // advance the independent one-second margin so this test fails instead
        // of parking the suite forever.
        tokio::time::advance(Duration::from_secs(1)).await;
    }
    let response = task
        .await
        .unwrap()
        .expect("the real 75-second breaker must beat the test-local watchdog");

    assert!(
        cancelled.load(Ordering::SeqCst),
        "timing out must drop and cancel the pending tool-step future"
    );
    let (turn, action) = response_action(response);
    assert_eq!(turn.parent_identifier, AGENTIC_HOST_USER_ID);
    assert_eq!(action.action, native_actions::RESPOND);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({
            "Request": "explain a subject that needs careful reasoning",
            "Response": "The assistant service took too long to respond. Please try again."
        })
    );
    assert_eq!(backend.chat_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn agentic_host_deterministic_fast_path_precedes_model_orchestration() {
    let backend = Arc::new(AgenticHostScriptedBackend::new(
        vec![Ok(crate::llm::ChatResult::Text(
            "a legacy chat response that must remain unused".to_string(),
        ))],
        vec![AgenticHostToolStep::Ready(Ok(
            crate::llm::tool_step::ToolStepResult::Final(
                "a chat-turn loop response that must remain unused".to_string(),
            ),
        ))],
    ));
    let (_directory, handler) = agentic_host_understand_handler(backend.clone()).await;
    let request = agentic_host_request("set a timer for five minutes");

    let action = full_handler_action(&handler, request)
        .await
        .expect("the deterministic clock fast path must return a stock action");
    assert_eq!(action.action, native_actions::TIMER);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({"Request": "set a timer for five minutes"})
    );
    assert_eq!(
        backend.tool_step_calls.load(Ordering::SeqCst),
        0,
        "deterministic fast paths must not enter the chat-turn loop"
    );
    assert_eq!(
        backend.chat_calls.load(Ordering::SeqCst),
        0,
        "deterministic fast paths must not enter legacy chat"
    );
}

#[tokio::test]
async fn agentic_host_runs_tool_step_before_the_degraded_drake_classifier() {
    let utterance = "could you put that Drake song Laugh Now Cry Later on";
    let backend = Arc::new(AgenticHostScriptedBackend::new(
        vec![Ok(crate::llm::ChatResult::Text(
            serde_json::json!({
                "intent": "play_catalog",
                "track": "Laugh Now Cry Later",
                "artist": "Drake",
                "album": null,
                "genre": null,
                "confidence": "high"
            })
            .to_string(),
        ))],
        vec![AgenticHostToolStep::Ready(Ok(
            crate::llm::tool_step::ToolStepResult::Final(
                "the chat-turn loop claimed this otherwise-unhandled music wording.".to_string(),
            ),
        ))],
    ));
    let (_directory, handler) = agentic_host_understand_handler(backend.clone()).await;
    let request = agentic_host_request(utterance);
    assert!(
        is_ai_music_fallback_candidate(&request),
        "the Drake wording must keep colliding with the degraded classifier"
    );
    assert!(should_run_ai_music_classifier(&request));

    let action = full_handler_action(&handler, request)
        .await
        .expect("the chat-turn loop must return a terminal before the degraded classifier");
    assert_eq!(action.action, native_actions::RESPOND);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({
            "Request": utterance,
            "Response": "the chat-turn loop claimed this otherwise-unhandled music wording."
        })
    );
    assert_eq!(backend.tool_step_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        backend.chat_calls.load(Ordering::SeqCst),
        0,
        "the legacy music classifier is degraded-only and must not race the chat-turn loop"
    );
}

#[test]
fn agentic_deadline_stays_inside_the_stock_turn_deadline() {
    assert_eq!(AGENTIC_RUNTIME_TIMEOUT, Duration::from_secs(75));
    assert_eq!(STOCK_TURN_DEADLINE, Duration::from_secs(80));
    // The retained-session ack margin is gone with the legacy engine; the
    // runtime budget alone must leave stock delivery headroom.
    assert!(AGENTIC_RUNTIME_TIMEOUT + Duration::from_secs(4) < STOCK_TURN_DEADLINE);
}

#[test]
fn ai_music_classifier_never_receives_private_context_without_confirmed_unlock() {
    let utterance = "could you put that Drake song Laugh Now Cry Later on";
    let mut locked = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: true,
            turns: vec![
                user_turn("previous-private", "HISTORY_MUSIC_CANARY"),
                user_turn("current-music", utterance),
            ],
            ..Default::default()
        }),
        ..Default::default()
    };
    assert!(is_ai_music_fallback_candidate(&locked));
    assert!(!should_run_ai_music_classifier(&locked));

    locked.device_context.as_mut().unwrap().is_locked = false;
    assert!(should_run_ai_music_classifier(&locked));

    let unknown = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        ..Default::default()
    };
    assert!(!should_run_ai_music_classifier(&unknown));
}

#[tokio::test]
async fn compound_agentic_failure_never_falls_through_to_a_mutating_fast_path() {
    let (_directory, _live_config, handler, _automation) = test_understand_handler(false).await;
    let utterance = "look up the best songs by Michael Jackson and play the most popular";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            turns: vec![user_turn("compound-user", utterance)],
            ..Default::default()
        }),
        ..Default::default()
    };

    // The test handler intentionally has no agentic external clients. The
    // semantic planner is therefore unavailable before any model/tool
    // work, and the full handler must terminate rather than reaching the
    // deterministic music mutation below it.
    let action = full_handler_action(&handler, request.clone())
        .await
        .expect("compound failure should return one honest response");
    assert_eq!(action.action, native_actions::RESPOND);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({
            "Request": utterance,
            "Response": "The assistant service needed for ranked playback is unavailable right now. Please try again."
        })
    );
    assert!(!action.input.contains(native_actions::PLAY_MUSIC));

    let mut response_excluded = request;
    response_excluded
        .excluded_tools
        .push(native_actions::RESPOND.into());
    let mut stream = handler
        .understand_inner(MetadataMap::new(), response_excluded, "TestUnderstand")
        .await
        .unwrap();
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn full_handler_locked_weather_terminates_before_location_provider_or_agentic_work() {
    let (_directory, _live_config, handler, _automation) = test_understand_handler(false).await;
    let utterance = "Will it rain this afternoon?";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        location: Some(Location {
            latitude: 55.6761,
            longitude: 12.5683,
        }),
        device_context: Some(SynapseDeviceContext {
            is_locked: true,
            turns: vec![user_turn("weather-user", utterance)],
            ..Default::default()
        }),
        ..Default::default()
    };

    assert!(is_restricted_weather_prompt(&request));
    let action = full_handler_action(&handler, request.clone())
        .await
        .expect("locked weather should terminate through Respond");
    assert_eq!(action.action, native_actions::RESPOND);
    assert!(action.input.contains("Unlock your Pin"));
    assert!(!action.input.contains(native_actions::GET_CURRENT_LOCATION));

    let unknown = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        location: request.location,
        device_context: None,
        ..Default::default()
    };
    assert!(is_restricted_weather_prompt(&unknown));
    let unknown_action = full_handler_action(&handler, unknown)
        .await
        .expect("unknown lock state should terminate through Respond");
    assert_eq!(unknown_action.action, native_actions::RESPOND);
    assert!(unknown_action.input.contains("can't verify"));
    assert!(!unknown_action
        .input
        .contains(native_actions::GET_CURRENT_LOCATION));

    let mut response_excluded = request;
    response_excluded
        .excluded_tools
        .push(native_actions::RESPOND.into());
    let mut stream = handler
        .understand_inner(MetadataMap::new(), response_excluded, "TestUnderstand")
        .await
        .unwrap();
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn full_handler_restricted_location_and_nearby_terminate_before_private_context() {
    let (_directory, _live_config, handler, _automation) = test_understand_handler(false).await;
    handler.location_grounding.cache.lock().unwrap().insert(
        "previous-nearby".into(),
        GroundingCacheEntry {
            stored_at: Instant::now(),
            latitude: 10.0,
            longitude: 20.0,
            payload: GroundingPayload {
                location_status: "current_device_location",
                reverse_geocode_status: Some("success"),
                nearby_search_status: Some("success"),
                resolved_location: Some(GroundedLocation {
                    display_name: Some("GROUNDING_CACHE_CANARY".into()),
                    municipality: None,
                    country_subdivision: None,
                    country: None,
                    postal_code: None,
                }),
                nearby_query: Some("coffee".into()),
                nearby_places: Vec::new(),
            },
        },
    );

    for (index, utterance) in [
        "Where am I?",
        "Find coffee near me",
        "What is the closest pharmacy to me?",
    ]
    .into_iter()
    .enumerate()
    {
        let request = SynapseUnderstandingRequest {
            utterance: utterance.into(),
            location: Some(Location {
                latitude: 10.0,
                longitude: 20.0,
            }),
            device_context: Some(SynapseDeviceContext {
                is_locked: true,
                reverse_geocoded_location: "REQUEST_LOCATION_CANARY".into(),
                turns: vec![
                    SynapseChatTurn {
                        user: SynapseUser::Assistant as i32,
                        identifier: "private-observation".into(),
                        content: Some(synapse_chat_turn::Content::Observation(
                            SynapseObservationContent {
                                action_name: native_actions::GET_CURRENT_LOCATION.into(),
                                observation: "HISTORY_LOCATION_CANARY".into(),
                                source: SynapseSource::Device as i32,
                                ..Default::default()
                            },
                        )),
                        ..Default::default()
                    },
                    user_turn(&format!("location-user-{index}"), utterance),
                ],
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            restricted_location_request_kind(&request),
            Some(RestrictedLocationRequestKind::Location)
        );
        let action = full_handler_action(&handler, request)
            .await
            .expect("locked location request should return one honest response");
        assert_eq!(action.action, native_actions::RESPOND);
        assert!(action.input.contains("Unlock your Pin"));
        for canary in [
            "REQUEST_LOCATION_CANARY",
            "HISTORY_LOCATION_CANARY",
            "GROUNDING_CACHE_CANARY",
            native_actions::GET_CURRENT_LOCATION,
        ] {
            assert!(!action.input.contains(canary));
        }
    }
    assert!(handler.location_grounding.cache.lock().unwrap().is_empty());

    let followup = "What about pharmacies?";
    let locked_followup = SynapseUnderstandingRequest {
        utterance: followup.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: true,
            turns: vec![
                user_turn_with_repair("previous-nearby", "Find coffee near me", "   "),
                user_turn("current-followup", followup),
            ],
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        restricted_location_request_kind(&locked_followup),
        Some(RestrictedLocationRequestKind::Location)
    );
    let action = full_handler_action(&handler, locked_followup)
        .await
        .expect("locked Nearby refinement should terminate honestly");
    assert_eq!(action.action, native_actions::RESPOND);

    let unknown = SynapseUnderstandingRequest {
        utterance: "Where am I?".into(),
        location: Some(Location {
            latitude: 10.0,
            longitude: 20.0,
        }),
        ..Default::default()
    };
    let action = full_handler_action(&handler, unknown.clone())
        .await
        .expect("unknown lock state should return one honest response");
    assert_eq!(action.action, native_actions::RESPOND);
    assert!(action.input.contains("can't verify"));

    let mut response_excluded = unknown;
    response_excluded
        .excluded_tools
        .push(native_actions::RESPOND.into());
    let mut stream = handler
        .understand_inner(MetadataMap::new(), response_excluded, "TestUnderstand")
        .await
        .unwrap();
    assert!(stream.next().await.is_none());
}

#[test]
fn current_location_action_requires_confirmed_unlock_independently_of_recognition() {
    let locked = SynapseUnderstandingRequest {
        utterance: "Where am I?".into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: true,
            turns: vec![user_turn("locked-location", "Where am I?")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let unknown = SynapseUnderstandingRequest {
        utterance: "Where am I?".into(),
        ..Default::default()
    };
    let unlocked = SynapseUnderstandingRequest {
        utterance: "Where am I?".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_turn("unlocked-location", "Where am I?")],
            ..Default::default()
        }),
        ..Default::default()
    };

    assert!(!should_emit_current_location_action(&locked));
    assert!(!should_emit_current_location_action(&unknown));
    assert!(should_emit_current_location_action(&unlocked));
}

#[tokio::test]
async fn restricted_general_model_context_is_location_free_and_images_are_blocked() {
    let (_directory, _live_config, handler, _automation) = test_understand_handler(false).await;
    for device_context in [
        Some(SynapseDeviceContext {
            is_locked: true,
            reverse_geocoded_location: "PROMPT_LOCATION_CANARY".into(),
            turns: vec![user_turn("locked-user", "Tell me a joke")],
            ..Default::default()
        }),
        None,
    ] {
        let request = SynapseUnderstandingRequest {
            utterance: "Tell me a joke".into(),
            location: Some(Location {
                latitude: 10.0,
                longitude: 20.0,
            }),
            device_context,
            ..Default::default()
        };
        let context =
            handler.build_prompt_template_context(&request, "privacy-run", &handler.config);
        assert!(context.location_name.is_none());
        assert!(context.latitude.is_none());
        assert!(context.longitude.is_none());
        assert!(context.coordinates.is_none());
    }

    let unlocked = SynapseUnderstandingRequest {
        location: Some(Location {
            latitude: 10.0,
            longitude: 20.0,
        }),
        device_context: Some(SynapseDeviceContext {
            reverse_geocoded_location: "UNLOCKED_LOCATION_CANARY".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let context = handler.build_prompt_template_context(&unlocked, "privacy-run", &handler.config);
    assert_eq!(
        context.location_name.as_deref(),
        Some("UNLOCKED_LOCATION_CANARY")
    );
    assert!(context.coordinates.is_some());

    let visual = "What is this?";
    let locked_visual = SynapseUnderstandingRequest {
        utterance: visual.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: true,
            turns: vec![SynapseChatTurn {
                user: SynapseUser::User as i32,
                identifier: "visual-user".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: visual.into(),
                        image_data: b"IMAGE_BYTES_CANARY".to_vec(),
                        vision_requested: synapse_user_request_content::VisionRequested::Vision
                            as i32,
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };
    let action = full_handler_action(&handler, locked_visual)
        .await
        .expect("locked image must terminate through Respond");
    assert_eq!(action.action, native_actions::RESPOND);
    assert!(action.input.contains("Unlock your Pin"));
    assert!(!action.input.contains("IMAGE_BYTES_CANARY"));
}

#[tokio::test]
async fn agentic_authorization_uses_one_live_fail_closed_snapshot() {
    let (_directory, live_config, handler, _automation) = test_understand_handler(false).await;
    {
        let mut config = live_config.write().await;
        for key in [
            cloud_feature_flags::FITNESS_TRACKER_ENABLED,
            cloud_feature_flags::QUICK_ACTIONS_REMAPPING_ENABLED,
            cloud_feature_flags::TICKLE,
            cloud_feature_flags::VISION_ACTIONS_ENABLED,
        ] {
            config.feature_flags.overrides.insert(
                key.into(),
                crate::feature_flags::ConfiguredFeatureFlagValue::Bool(false),
            );
        }
    }
    let request = SynapseUnderstandingRequest {
        excluded_tools: vec![native_actions::COMPOSE_MESSAGE.into()],
        ..Default::default()
    };
    let missing_context = handler.live_agentic_authorization(&request).await;
    assert_eq!(missing_context.device_lock_state, DeviceLockState::Unknown);
    assert_eq!(
        missing_context.excluded_actions,
        vec![native_actions::COMPOSE_MESSAGE]
    );
    assert!(missing_context.enabled_feature_gates.is_empty());

    {
        let mut config = live_config.write().await;
        config.feature_flags.overrides.insert(
            cloud_feature_flags::TICKLE.into(),
            crate::feature_flags::ConfiguredFeatureFlagValue::Bool(true),
        );
    }
    let unlocked = SynapseUnderstandingRequest {
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            ..Default::default()
        }),
        ..Default::default()
    };
    let enabled = handler.live_agentic_authorization(&unlocked).await;
    assert_eq!(enabled.device_lock_state, DeviceLockState::Unlocked);
    assert_eq!(enabled.enabled_feature_gates, vec![FeatureGate::Tickle]);
}

fn test_agentic_resume_state() -> AgenticResumeState {
    AgenticResumeState::for_tool_preflight(
        "resume-run",
        crate::synapse::catalog::ReadToolInvocation::CurrentLocation(Default::default()),
        native_actions::GET_CURRENT_LOCATION,
    )
}

fn agentic_location_chain(action_parent: &str) -> SynapseUnderstandingRequest {
    let utterance = "What's the weather like today?";
    SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![
                SynapseChatTurn {
                    user: SynapseUser::User as i32,
                    identifier: "weather-user".into(),
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        SynapseUserRequestContent {
                            request: utterance.into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "agentic-location-action".into(),
                    parent_identifier: action_parent.into(),
                    content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                        thought: AGENTIC_LOCATION_PREFLIGHT_THOUGHT.into(),
                        action: native_actions::GET_CURRENT_LOCATION.into(),
                        source: SynapseSource::Server as i32,
                        ..Default::default()
                    })),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "agentic-location-observation".into(),
                    parent_identifier: "agentic-location-action".into(),
                    content: Some(synapse_chat_turn::Content::Observation(
                        SynapseObservationContent {
                            observation:
                                r#"{"latitude":55.6761,"longitude":12.5683,"isStale":false}"#.into(),
                            is_final: false,
                            action_name: native_actions::GET_CURRENT_LOCATION.into(),
                            source: SynapseSource::Device as i32,
                        },
                    )),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[tokio::test]
async fn agentic_location_resume_is_parent_bound_single_use_and_expiry_safe() {
    let store = AgenticResumeStore::default();
    let request = agentic_location_chain("weather-user");
    assert!(store.stage(
        "agentic-location-action",
        "weather-user",
        &request.utterance,
        test_agentic_resume_state(),
        None,
    ));
    let state = current_location_fetch_state(&request);
    assert!(matches!(state, CurrentLocationFetchState::Fresh(_)));
    assert!(matches!(
        store.consume_for_request(&request, &state, false),
        AgenticResumeResult::Ready(..)
    ));
    assert!(matches!(
        store.consume_for_request(&request, &state, false),
        AgenticResumeResult::Blocked
    ));

    assert!(store.stage(
        "agentic-location-action",
        "weather-user",
        &request.utterance,
        test_agentic_resume_state(),
        None,
    ));
    {
        let mut pending = store.pending.lock().unwrap();
        pending
            .get_mut("agentic-location-action")
            .unwrap()
            .stored_at = Instant::now() - AGENTIC_RESUME_TTL - Duration::from_secs(1);
    }
    assert!(matches!(
        store.consume_for_request(&request, &state, false),
        AgenticResumeResult::Blocked
    ));
}

fn agentic_location_chain_with_interposed_server_turn() -> SynapseUnderstandingRequest {
    let utterance = "What's the weather like today?";
    SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![
                SynapseChatTurn {
                    user: SynapseUser::User as i32,
                    identifier: "weather-user".into(),
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        SynapseUserRequestContent {
                            request: utterance.into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                },
                // An untrusted interposed server-shaped turn must not gain
                // authority to reparent the real native preflight.
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "interposed-action".into(),
                    parent_identifier: "weather-user".into(),
                    content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                        action: "knowledge_lookup".into(),
                        input: "{}".into(),
                        source: SynapseSource::Server as i32,
                        ..Default::default()
                    })),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "agentic-location-action".into(),
                    parent_identifier: "interposed-action".into(),
                    content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                        thought: AGENTIC_LOCATION_PREFLIGHT_THOUGHT.into(),
                        action: native_actions::GET_CURRENT_LOCATION.into(),
                        source: SynapseSource::Server as i32,
                        ..Default::default()
                    })),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "agentic-location-observation".into(),
                    parent_identifier: "agentic-location-action".into(),
                    content: Some(synapse_chat_turn::Content::Observation(
                        SynapseObservationContent {
                            observation:
                                r#"{"latitude":55.6761,"longitude":12.5683,"isStale":false}"#.into(),
                            is_final: false,
                            action_name: native_actions::GET_CURRENT_LOCATION.into(),
                            source: SynapseSource::Device as i32,
                        },
                    )),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[test]
fn the_generated_playlist_planner_is_wired_into_the_pre_agentic_fast_path() {
    // Ordering regression guard. This planner used to exist only in the
    // post-agentic cascade, which runs only when the agentic runtime is
    // unavailable — so the stock AI-DJ never started in normal operation.
    // Cascade-level tests cannot catch that (the planner itself works
    // fine), so pin the ROUTE: the fast path must plan it before any model
    // round trip. Same failure class as the earlier "cascade ran after
    // agentic so deterministic music never fired" bug.
    let fast_path_source = include_str!("fast_path.rs");
    let fast_path = fast_path_source
        .find("async fn run_local_text_fast_path")
        .expect("fast path must exist");
    include_str!("cascade.rs")
        .find("async fn run_text_cascade")
        .expect("cascade must exist");
    let planned_in_fast_path = fast_path_source[fast_path..]
        .find("plan_generated_playlist_action")
        .map(|offset| fast_path + offset)
        .expect("the fast path must plan the generated playlist");
    assert!(
        planned_in_fast_path > fast_path,
        "the generated playlist must be planned inside the fast path itself, before any model round trip"
    );
}

#[tokio::test]
async fn synthetic_server_turn_cannot_reparent_a_real_location_preflight() {
    let store = AgenticResumeStore::default();
    let request = agentic_location_chain_with_interposed_server_turn();
    assert!(store.stage(
        "agentic-location-action",
        "weather-user",
        &request.utterance,
        test_agentic_resume_state(),
        None,
    ));
    let state = current_location_fetch_state(&request);
    assert!(
        matches!(state, CurrentLocationFetchState::Unavailable),
        "an interposed server turn must invalidate the native preflight binding, got {state:?}"
    );
    assert!(matches!(
        store.consume_for_request(&request, &state, false),
        AgenticResumeResult::Blocked
    ));
}

#[tokio::test]
async fn agentic_location_resume_rejects_a_tampered_action_parent() {
    let store = AgenticResumeStore::default();
    let request = agentic_location_chain("wrong-user");
    assert!(store.stage(
        "agentic-location-action",
        "weather-user",
        &request.utterance,
        test_agentic_resume_state(),
        None,
    ));
    let state = current_location_fetch_state(&request);
    assert!(matches!(state, CurrentLocationFetchState::Unavailable));
    assert!(matches!(
        store.consume_for_request(&request, &state, false),
        AgenticResumeResult::Blocked
    ));
}

#[tokio::test]
async fn agentic_location_resume_is_revoked_if_device_locks_before_continuation() {
    let store = AgenticResumeStore::default();
    let mut request = agentic_location_chain("weather-user");
    assert!(store.stage(
        "agentic-location-action",
        "weather-user",
        &request.utterance,
        test_agentic_resume_state(),
        None,
    ));
    request.device_context.as_mut().unwrap().is_locked = true;

    // Even a caller that already parsed a fresh observation cannot feed it
    // into the resume after the lock-state transition.
    let parsed_while_restricted = current_location_fetch_state(&request);
    assert!(matches!(
        parsed_while_restricted,
        CurrentLocationFetchState::Fresh(_)
    ));
    assert!(matches!(
        store.consume_for_request(&request, &parsed_while_restricted, false),
        AgenticResumeResult::Blocked
    ));
    assert!(!store
        .pending
        .lock()
        .unwrap()
        .contains_key("agentic-location-action"));

    let mut guarded_request = request.clone();
    if request_device_lock_state(&guarded_request) == DeviceLockState::Unlocked {
        promote_fresh_current_location_observation(&mut guarded_request);
    }
    assert!(guarded_request.location.is_none());
}

#[test]
fn completed_agentic_location_marker_does_not_poison_a_later_user_turn() {
    let store = AgenticResumeStore::default();
    let mut request = agentic_location_chain("weather-user");
    request.utterance = "tell me a joke".into();
    request
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .push(SynapseChatTurn {
            user: SynapseUser::User as i32,
            identifier: "later-user".into(),
            parent_identifier: "agentic-location-observation".into(),
            content: Some(synapse_chat_turn::Content::UserRequest(
                SynapseUserRequestContent {
                    request: "tell me a joke".into(),
                    ..Default::default()
                },
            )),
            ..Default::default()
        });
    let state = current_location_fetch_state(&request);
    assert!(matches!(state, CurrentLocationFetchState::NotRequested));
    assert!(matches!(
        store.consume_for_request(&request, &state, false),
        AgenticResumeResult::NoMatch
    ));
}

/// The in-session chat-turn transcript is exclusive to the bidirectional
/// streaming session: a unary continuation claims the same validated
/// resume but the stored transcript is dropped, so the legacy fresh-replan
/// behavior is unchanged while the device streaming flag stays off.
#[tokio::test]
async fn chat_turn_suspension_is_claimed_only_by_a_streaming_continuation() {
    let store = AgenticResumeStore::default();
    let request = agentic_location_chain("weather-user");
    let state = current_location_fetch_state(&request);
    assert!(matches!(state, CurrentLocationFetchState::Fresh(_)));

    // Unary continuation: the resume is Ready but the transcript is gone.
    assert!(store.stage(
        "agentic-location-action",
        "weather-user",
        &request.utterance,
        test_agentic_resume_state(),
        Some(ChatTurnSuspension::test_fixture()),
    ));
    match store.consume_for_request(&request, &state, false) {
        AgenticResumeResult::Ready(_, suspension) => assert!(
            suspension.is_none(),
            "a unary continuation must never receive the streaming transcript"
        ),
        other => panic!("expected Ready, got {}", resume_result_label(&other)),
    }

    // Streaming continuation: the same staging hands the transcript back.
    assert!(store.stage(
        "agentic-location-action",
        "weather-user",
        &request.utterance,
        test_agentic_resume_state(),
        Some(ChatTurnSuspension::test_fixture()),
    ));
    match store.consume_for_request(&request, &state, true) {
        AgenticResumeResult::Ready(_, suspension) => assert!(
            suspension.is_some(),
            "a streaming continuation must resume the suspended transcript"
        ),
        other => panic!("expected Ready, got {}", resume_result_label(&other)),
    }

    // Staging without a transcript stays valid for both paths.
    assert!(store.stage(
        "agentic-location-action",
        "weather-user",
        &request.utterance,
        test_agentic_resume_state(),
        None,
    ));
    match store.consume_for_request(&request, &state, true) {
        AgenticResumeResult::Ready(_, suspension) => assert!(suspension.is_none()),
        other => panic!("expected Ready, got {}", resume_result_label(&other)),
    }
}

fn resume_result_label(result: &AgenticResumeResult) -> &'static str {
    match result {
        AgenticResumeResult::Ready(..) => "Ready",
        AgenticResumeResult::Blocked => "Blocked",
        AgenticResumeResult::NoMatch => "NoMatch",
    }
}

fn vision_automation_chain_request(run_id: &str, observation: &str) -> SynapseUnderstandingRequest {
    let utterance = "what do you see";
    SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![
                SynapseChatTurn {
                    identifier: run_id.into(),
                    user: SynapseUser::User as i32,
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        SynapseUserRequestContent {
                            request: utterance.into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                },
                SynapseChatTurn {
                    identifier: "vision-action".into(),
                    parent_identifier: run_id.into(),
                    user: SynapseUser::Assistant as i32,
                    content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                        action: native_actions::UNDERSTAND_SCENE.into(),
                        source: SynapseSource::Server as i32,
                        ..Default::default()
                    })),
                    ..Default::default()
                },
                SynapseChatTurn {
                    identifier: "vision-observation".into(),
                    parent_identifier: "vision-action".into(),
                    user: SynapseUser::Assistant as i32,
                    content: Some(synapse_chat_turn::Content::Observation(
                        SynapseObservationContent {
                            observation: observation.into(),
                            action_name: native_actions::UNDERSTAND_SCENE.into(),
                            source: SynapseSource::Device as i32,
                            is_final: false,
                        },
                    )),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }),
        ..Default::default()
    }
}

async fn cascade_action(
    handler: &UnderstandHandler,
    request: &SynapseUnderstandingRequest,
    run_id: &str,
) -> Option<SynapseActionContent> {
    let mut stream = handler
        .run_text_cascade(request, run_id, &request.utterance, run_id, false)
        .await
        .unwrap()?;
    let response = stream.next().await?.unwrap();
    let synapse_understanding_response::Body::Turn(turn) = response.body? else {
        return None;
    };
    let synapse_chat_turn::Content::Action(action) = turn.content? else {
        return None;
    };
    Some(action)
}

async fn full_handler_action(
    handler: &Arc<UnderstandHandler>,
    request: SynapseUnderstandingRequest,
) -> Option<SynapseActionContent> {
    let mut stream = handler
        .understand_inner(MetadataMap::new(), request, "TestUnderstand")
        .await
        .unwrap();
    let response = stream.next().await?.unwrap();
    assert!(
        stream.next().await.is_none(),
        "expected one terminal action"
    );
    let synapse_understanding_response::Body::Turn(turn) = response.body? else {
        return None;
    };
    let synapse_chat_turn::Content::Action(action) = turn.content? else {
        return None;
    };
    Some(action)
}

fn situation_request(situation: SynapseUserSituation) -> SynapseUnderstandingRequest {
    SynapseUnderstandingRequest {
        device_context: Some(SynapseDeviceContext {
            situation: Some(situation),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn user_turn(identifier: &str, request: &str) -> SynapseChatTurn {
    user_turn_with_repair(identifier, request, "")
}

fn user_turn_with_repair(
    identifier: &str,
    request: &str,
    repaired_request: &str,
) -> SynapseChatTurn {
    SynapseChatTurn {
        user: SynapseUser::User as i32,
        identifier: identifier.into(),
        content: Some(synapse_chat_turn::Content::UserRequest(
            SynapseUserRequestContent {
                request: request.into(),
                repaired_request: repaired_request.into(),
                ..Default::default()
            },
        )),
        ..Default::default()
    }
}

fn request_with_user_turns(turns: Vec<SynapseChatTurn>) -> SynapseUnderstandingRequest {
    let utterance = turns
        .iter()
        .rev()
        .find_map(|turn| match turn.content.as_ref() {
            Some(synapse_chat_turn::Content::UserRequest(content)) => Some(content.request.clone()),
            _ => None,
        })
        .unwrap_or_default();
    SynapseUnderstandingRequest {
        utterance,
        device_context: Some(SynapseDeviceContext {
            turns,
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[tokio::test]
async fn historical_or_current_inline_image_cannot_bypass_local_timer_routing() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "set a timer for five minutes";
    let image = vec![0xff, 0xd8, 0xff, 0xdb];

    let mut historical = user_turn("historical-image", "what is this");
    let Some(synapse_chat_turn::Content::UserRequest(historical_request)) =
        historical.content.as_mut()
    else {
        panic!("expected historical user request");
    };
    historical_request.image_data = image.clone();

    let historical_only =
        request_with_user_turns(vec![historical, user_turn("timer-current", utterance)]);

    let mut current = user_turn("timer-current-with-image", utterance);
    let Some(synapse_chat_turn::Content::UserRequest(current_request)) = current.content.as_mut()
    else {
        panic!("expected current user request");
    };
    current_request.image_data = image;
    let current_inline = request_with_user_turns(vec![current]);

    for (label, request) in [
        ("historical image", historical_only),
        ("current image", current_inline),
    ] {
        let action = full_handler_action(&handler, request)
            .await
            .unwrap_or_else(|| panic!("{label} request produced no local timer action"));
        assert_eq!(action.action, native_actions::TIMER, "{label}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
            serde_json::json!({"Request": utterance}),
            "{label}"
        );
    }
}

#[tokio::test]
async fn current_vision_request_without_image_still_returns_understand_scene() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "what do you see";
    let mut current = user_turn("vision-current", utterance);
    let Some(synapse_chat_turn::Content::UserRequest(current_request)) = current.content.as_mut()
    else {
        panic!("expected current user request");
    };
    current_request.vision_requested = synapse_user_request_content::VisionRequested::Vision as i32;

    let action = full_handler_action(&handler, request_with_user_turns(vec![current]))
        .await
        .expect("no-image vision request must return its stock preflight");
    assert_eq!(action.action, native_actions::UNDERSTAND_SCENE);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({"Question": utterance})
    );
}

#[test]
fn ordinary_image_route_runs_the_local_fast_path_once_before_generic_vision() {
    let source = include_str!("cascade.rs");
    let start = source
        .find("async fn understand_inner")
        .expect("Understand implementation must exist");
    // `understand_inner` is the final method in cascade.rs; the module's
    // closing brace bounds it.
    let implementation = &source[start..];

    assert_eq!(
        implementation.matches(".run_local_text_fast_path(").count(),
        1,
        "the ordinary request flow must run deterministic local planning exactly once"
    );
    let visual_music = implementation
        .find(".run_visual_music_request(")
        .expect("visual music guard must remain wired");
    let visual_nutrition = implementation
        .find("let visual_nutrition_query")
        .expect("visual nutrition guard must remain wired");
    let local = implementation
        .find(".run_local_text_fast_path(")
        .expect("local fast path must remain wired");
    let generic_image = implementation
        .find("let inline_image =")
        .expect("generic image route must remain wired");
    assert!(visual_music < local);
    assert!(visual_nutrition < local);
    assert!(local < generic_image);
    assert!(implementation[generic_image..].contains("linked_current_turn_image"));
    assert!(!implementation.contains("extract_most_recent_image_data"));
}

#[test]
fn trusted_current_user_binding_uses_repair_then_raw_and_rejects_ambiguity() {
    let mut repaired =
        request_with_user_turns(vec![user_turn("current-turn", "uncertain transcript")]);
    repaired.utterance = "where am I?".into();
    let Some(synapse_chat_turn::Content::UserRequest(current)) = repaired
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .last_mut()
        .unwrap()
        .content
        .as_mut()
    else {
        panic!("expected current user request");
    };
    current.repaired_request = "Where am I?".into();
    assert_eq!(
        trusted_current_user_request(&repaired).map(|(_, turn, _)| turn.identifier.as_str()),
        Some("current-turn")
    );

    let mut raw_fallback = repaired.clone();
    let Some(synapse_chat_turn::Content::UserRequest(current)) = raw_fallback
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .last_mut()
        .unwrap()
        .content
        .as_mut()
    else {
        panic!("expected current user request");
    };
    current.request = "WHERE am I?".into();
    current.repaired_request = "   ".into();
    assert!(trusted_current_user_request(&raw_fallback).is_some());

    for punctuation_shift in ["Where am I", "Where am I!", "Where am I."] {
        let mut shifted = raw_fallback.clone();
        let Some(synapse_chat_turn::Content::UserRequest(current)) = shifted
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap()
            .content
            .as_mut()
        else {
            panic!("expected current user request");
        };
        current.repaired_request = punctuation_shift.into();
        assert!(trusted_current_user_request(&shifted).is_none());
    }

    let mut repaired_mismatch = raw_fallback.clone();
    let Some(synapse_chat_turn::Content::UserRequest(current)) = repaired_mismatch
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .last_mut()
        .unwrap()
        .content
        .as_mut()
    else {
        panic!("expected current user request");
    };
    current.repaired_request = "where is somewhere else".into();
    assert!(trusted_current_user_request(&repaired_mismatch).is_none());

    let mut control_bearing = raw_fallback.clone();
    let Some(synapse_chat_turn::Content::UserRequest(current)) = control_bearing
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .last_mut()
        .unwrap()
        .content
        .as_mut()
    else {
        panic!("expected current user request");
    };
    current.repaired_request = "where\nam I".into();
    assert!(trusted_current_user_request(&control_bearing).is_none());

    let mut duplicate = raw_fallback;
    duplicate
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .insert(0, user_turn("current-turn", "older request"));
    assert!(trusted_current_user_request(&duplicate).is_none());
}

#[tokio::test]
async fn full_handler_classifies_the_selected_authoritative_current_text() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let outer = "text Alice saying hello";
    let request = SynapseUnderstandingRequest {
        utterance: outer.into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_turn_with_repair(
                "message-user",
                outer,
                "Text Alice saying hello!",
            )],
            ..Default::default()
        }),
        ..Default::default()
    };

    let action = full_handler_action(&handler, request)
        .await
        .expect("selected repaired text should reach the stock message composer");
    assert_eq!(action.action, native_actions::COMPOSE_MESSAGE);
    let input: serde_json::Value = serde_json::from_str(&action.input).unwrap();
    assert_eq!(input["To"], serde_json::json!(["Alice"]));
    assert_eq!(input["Message"], "hello!");
}

#[test]
fn visual_state_ids_bind_to_the_canonical_repaired_current_turn() {
    let mut trusted =
        request_with_user_turns(vec![user_turn("visual-current", "uncertain transcript")]);
    trusted.utterance = "what is this?".into();
    let Some(synapse_chat_turn::Content::UserRequest(current)) = trusted
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .last_mut()
        .unwrap()
        .content
        .as_mut()
    else {
        panic!("expected current user request");
    };
    current.repaired_request = "What is this?".into();
    assert_eq!(
        validated_visual_state_id(&trusted, "visual-current"),
        Some("visual-current")
    );

    let mut punctuation_shift = trusted.clone();
    let Some(synapse_chat_turn::Content::UserRequest(current)) = punctuation_shift
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .last_mut()
        .unwrap()
        .content
        .as_mut()
    else {
        panic!("expected current user request");
    };
    current.repaired_request = "What is this!".into();
    assert_eq!(
        validated_visual_state_id(&punctuation_shift, "visual-current"),
        None
    );

    let previous_inline = SynapseUnderstandingRequest {
        utterance: "what is this?".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![SynapseChatTurn {
                user: SynapseUser::System as i32,
                identifier: "legacy-inline".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: "uncertain transcript".into(),
                        repaired_request: "What is this?".into(),
                        image_data: vec![1],
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        validated_inline_image_id(&previous_inline, "legacy-inline"),
        Some("legacy-inline")
    );

    let mut mismatch = previous_inline;
    let Some(synapse_chat_turn::Content::UserRequest(current)) = mismatch
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .last_mut()
        .unwrap()
        .content
        .as_mut()
    else {
        panic!("expected current user request");
    };
    current.repaired_request = "What is this".into();
    assert_eq!(validated_inline_image_id(&mismatch, "legacy-inline"), None);
}

#[test]
fn effective_correlation_prefers_transport_then_verified_stock_user_uuid() {
    let user_correlation = "7d93c620-5ab6-4a41-8f2d-33e70e7c5a91";
    let transport_correlation = "50d3b678-2675-4b35-9e5f-04db2d934268";
    let request = request_with_user_turns(vec![user_turn(user_correlation, "hello")]);

    assert_eq!(
        effective_request_correlation(&request, transport_correlation),
        transport_correlation
    );
    assert_eq!(
        effective_request_correlation(&request, &transport_correlation.to_uppercase()),
        transport_correlation,
        "valid transport UUIDs are normalized for the privacy-safe marker"
    );
    assert_eq!(
        effective_request_correlation(&request, "unknown"),
        user_correlation
    );
}

#[test]
fn effective_correlation_generates_v4_when_transport_or_chain_is_untrusted() {
    let user_correlation = "7d93c620-5ab6-4a41-8f2d-33e70e7c5a91";
    let mut mismatched = request_with_user_turns(vec![user_turn(user_correlation, "different")]);
    mismatched.utterance = "hello".into();

    for request in [
        mismatched,
        request_with_user_turns(vec![user_turn(
            "7d93c620-5ab6-1a41-8f2d-33e70e7c5a91",
            "hello",
        )]),
    ] {
        let generated = effective_request_correlation(&request, "not-a-uuid");
        assert_ne!(generated, user_correlation);
        let parsed = uuid::Uuid::parse_str(&generated).expect("generated correlation UUID");
        assert_eq!(parsed.get_version_num(), 4);
        assert_eq!(parsed.get_variant(), uuid::Variant::RFC4122);
        assert_eq!(parsed.hyphenated().to_string(), generated);
    }
}

#[tokio::test]
async fn visual_nutrition_accepts_only_current_or_exact_parent_linked_image_bytes() {
    let image = vec![0xff, 0xd8, 0xff, 0xdb];
    let current_inline = SynapseUnderstandingRequest {
        utterance: "How much protein is in this?".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![SynapseChatTurn {
                identifier: "current-run".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: "How much protein is in this?".into(),
                        image_data: image.clone(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        exact_visual_nutrition_image(
            &current_inline,
            "current-run",
            "current-run",
            &LiveImageStore::new(),
        )
        .await,
        Some(image.clone())
    );

    let timestamp = |seconds| prost_types::Timestamp { seconds, nanos: 0 };
    let previous = SynapseChatTurn {
        identifier: "vision-run".into(),
        timestamp: Some(timestamp(100)),
        content: Some(synapse_chat_turn::Content::UserRequest(
            SynapseUserRequestContent {
                request: "What food is this?".into(),
                vision_requested: synapse_user_request_content::VisionRequested::Vision as i32,
                image_data: image.clone(),
                ..Default::default()
            },
        )),
        ..Default::default()
    };
    let action = SynapseChatTurn {
        identifier: "vision-action".into(),
        parent_identifier: "vision-run".into(),
        content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
            action: native_actions::UNDERSTAND_SCENE.into(),
            source: SynapseSource::Server as i32,
            ..Default::default()
        })),
        ..Default::default()
    };
    let observation = SynapseChatTurn {
        identifier: "vision-observation".into(),
        parent_identifier: "vision-action".into(),
        content: Some(synapse_chat_turn::Content::Observation(
            SynapseObservationContent {
                observation: "A banana is visible.".into(),
                action_name: native_actions::UNDERSTAND_SCENE.into(),
                source: SynapseSource::Device as i32,
                ..Default::default()
            },
        )),
        ..Default::default()
    };
    let current = SynapseChatTurn {
        identifier: "current-run".into(),
        parent_identifier: "vision-observation".into(),
        timestamp: Some(timestamp(160)),
        content: Some(synapse_chat_turn::Content::UserRequest(
            SynapseUserRequestContent {
                request: "How many calories?".into(),
                ..Default::default()
            },
        )),
        ..Default::default()
    };
    let contextual = SynapseUnderstandingRequest {
        utterance: "How many calories?".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![
                previous.clone(),
                action.clone(),
                observation.clone(),
                current.clone(),
            ],
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        exact_visual_nutrition_image(
            &contextual,
            "current-run",
            "current-run",
            &LiveImageStore::new(),
        )
        .await,
        Some(image)
    );

    let mut cached_contextual = contextual.clone();
    let Some(synapse_chat_turn::Content::UserRequest(previous_request)) =
        cached_contextual.device_context.as_mut().unwrap().turns[0]
            .content
            .as_mut()
    else {
        panic!("expected previous user request");
    };
    previous_request.image_data.clear();
    let cache = LiveImageStore::new();
    let _ = cache
        .put_capture(
            "vision-run",
            vec![0xff, 0xd8, 0xff, 0xdb, 1],
            "What food is this?".into(),
            Vec::new(),
        )
        .await;
    assert_eq!(
        exact_visual_nutrition_image(&cached_contextual, "current-run", "current-run", &cache,)
            .await,
        Some(vec![0xff, 0xd8, 0xff, 0xdb, 1])
    );

    let mut tampered = contextual;
    tampered.device_context.as_mut().unwrap().turns[3].parent_identifier = "older-turn".into();
    assert!(exact_visual_nutrition_image(
        &tampered,
        "current-run",
        "current-run",
        &LiveImageStore::new(),
    )
    .await
    .is_none());

    let stale_unlinked = SynapseUnderstandingRequest {
        utterance: "How many calories?".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![previous, current],
            ..Default::default()
        }),
        ..Default::default()
    };
    assert!(exact_visual_nutrition_image(
        &stale_unlinked,
        "current-run",
        "current-run",
        &LiveImageStore::new()
    )
    .await
    .is_none());
}

#[tokio::test]
async fn image_grounded_nutrition_emits_only_read_only_respond_action() {
    let (_directory, _config, handler, _automation) = test_understand_handler(false).await;
    let mut metadata = MetadataMap::new();
    metadata.insert("x-ai-mic-run-id", "nutrition-run".parse().unwrap());
    let request = SynapseUnderstandingRequest {
        utterance: "How many calories are in this?".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![SynapseChatTurn {
                identifier: "nutrition-run".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: "How many calories are in this?".into(),
                        image_data: vec![0xff, 0xd8, 0xff, 0xdb],
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut stream = handler
        .understand_inner(metadata, request, "VisualNutritionTest")
        .await
        .unwrap();
    let response = stream.next().await.unwrap().unwrap();
    let synapse_understanding_response::Body::Turn(turn) = response.body.unwrap() else {
        panic!("expected a stock action turn");
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected a stock action");
    };
    assert_eq!(action.action, native_actions::RESPOND);
    assert!(!action.input.contains(native_actions::MANAGE_NUTRITION));
    assert!(!action.input.contains("TrackFoodConsumption"));
    assert!(!action.input.contains("FoodImageResponse"));
    assert!(action.input.contains("won't guess nutrition"));
}

#[tokio::test]
async fn unsupported_image_nutrition_is_blocked_but_named_food_text_still_uses_stock_agent() {
    let (_directory, _config, handler, _automation) = test_understand_handler(false).await;
    let mut metadata = MetadataMap::new();
    metadata.insert("x-ai-mic-run-id", "nutrition-run".parse().unwrap());
    let image_request = SynapseUnderstandingRequest {
        utterance: "Could you estimate the caffeine in this photo?".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![SynapseChatTurn {
                identifier: "nutrition-run".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: "Could you estimate the caffeine in this photo?".into(),
                        image_data: vec![0xff, 0xd8, 0xff, 0xdb],
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut stream = handler
        .understand_inner(metadata.clone(), image_request, "VisualNutritionGuardTest")
        .await
        .unwrap();
    let response = stream.next().await.unwrap().unwrap();
    let synapse_understanding_response::Body::Turn(turn) = response.body.unwrap() else {
        panic!("expected a stock action turn");
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected a stock action");
    };
    assert_eq!(action.action, native_actions::RESPOND);
    assert!(action
        .input
        .contains("won't let a generic vision model estimate or invent nutrition"));
    assert!(!action.input.contains(native_actions::MANAGE_NUTRITION));

    let named_food_utterance = "How many calories are in a banana?";
    let named_food =
        request_with_user_turns(vec![user_turn("nutrition-run", named_food_utterance)]);
    let mut stream = handler
        .understand_inner(metadata, named_food, "TextNutritionRegressionTest")
        .await
        .unwrap();
    let response = stream.next().await.unwrap().unwrap();
    let synapse_understanding_response::Body::Turn(turn) = response.body.unwrap() else {
        panic!("expected a stock action turn");
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected a stock action");
    };
    assert_eq!(action.action, native_actions::MANAGE_NUTRITION);
}

#[tokio::test]
async fn false_and_unknown_android_food_gate_terminate_text_nutrition_before_stock_agent() {
    let (_directory, _config, handler, _automation) = test_understand_handler(false).await;
    let gate = handler.food.as_ref().unwrap().runtime_gate();

    for (index, publish) in [Some(false), None].into_iter().enumerate() {
        let mutation = gate.begin_mutation();
        match publish {
            Some(value) => mutation.publish(Some(value)),
            None => drop(mutation),
        }
        let utterance = "What are the nutrition facts for oatmeal?";
        let request = request_with_user_turns(vec![user_turn(
            &format!("food-gate-user-{index}"),
            utterance,
        )]);
        let action = cascade_action(&handler, &request, &format!("food-gate-{index}"))
            .await
            .expect("disabled food intent should terminate with a safe response");
        assert_eq!(action.action, native_actions::RESPOND);
        assert!(action.input.contains("device setting is unavailable"));
        assert!(!action.input.contains(native_actions::MANAGE_NUTRITION));
    }
}

fn test_location_grounding() -> LocationGrounding {
    let http = reqwest::Client::new();
    let options = OsmOptions::new(true, true);
    LocationGrounding {
        enabled: true,
        osm: OsmClient::new(http.clone(), options.clone()),
        nearby: NearbyClient::new(http, options),
        cache: Arc::new(Mutex::new(HashMap::new())),
    }
}

fn test_grounding_payload() -> GroundingPayload {
    GroundingPayload {
        location_status: "current_device_location",
        reverse_geocode_status: Some("success"),
        nearby_search_status: Some("success"),
        resolved_location: None,
        nearby_query: Some("coffee".into()),
        nearby_places: vec![GroundedPlace {
            ordinal: 1,
            name: "Test Cafe".into(),
            address: "Test Street".into(),
            place_types: vec!["cafe".into()],
            distance_meters: 125,
            phone_number: Some("+45 12 34 56 78".into()),
            description: Some("cafe".into()),
            website_url: Some("https://example.test/".into()),
        }],
    }
}

#[tokio::test]
async fn location_grounding_first_branch_revokes_cache_for_locked_and_unknown_requests() {
    let grounding = test_location_grounding();
    for request in [
        SynapseUnderstandingRequest {
            utterance: "Where am I?".into(),
            location: Some(Location {
                latitude: 10.0,
                longitude: 20.0,
            }),
            device_context: Some(SynapseDeviceContext {
                is_locked: true,
                ..Default::default()
            }),
            ..Default::default()
        },
        SynapseUnderstandingRequest {
            utterance: "Where am I?".into(),
            location: Some(Location {
                latitude: 10.0,
                longitude: 20.0,
            }),
            ..Default::default()
        },
    ] {
        grounding.cache.lock().unwrap().insert(
            "CACHE_KEY_CANARY".into(),
            GroundingCacheEntry {
                stored_at: Instant::now(),
                latitude: 10.0,
                longitude: 20.0,
                payload: test_grounding_payload(),
            },
        );
        assert!(grounding
            .resolve(&request, "restricted-run", &request.utterance)
            .await
            .is_none());
        assert!(grounding.cache.lock().unwrap().is_empty());
    }
}

#[test]
fn llm_content_is_redacted_from_understand_logs() {
    assert!(!llm_content_logging_enabled());
}

#[tokio::test]
async fn natural_ranked_phrasing_survives_harness_shaped_exclusions() {
    // Mirror the release-harness probe request exactly: same utterance,
    // same benign excluded tools, explicit unlocked context.
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "play the most popular song by drake";
    let mut request = request_with_user_turns(vec![user_turn("music-user", utterance)]);
    request.excluded_tools = vec![
        native_actions::CREATE_MEMORY.to_string(),
        native_actions::SET_VOLUME.to_string(),
        native_actions::INCREMENT_VOLUME.to_string(),
        native_actions::DECREMENT_VOLUME.to_string(),
    ];

    let action = cascade_action(&handler, &request, "music-user")
        .await
        .expect("harness-shaped exclusions must not push the request to the model");

    assert_eq!(action.action, native_actions::PLAY_MUSIC);
}

#[tokio::test]
async fn natural_ranked_phrasing_is_handled_by_the_pre_agentic_fast_path() {
    // Pins the ORDER contract: deterministic catalog music must resolve in
    // run_local_text_fast_path, which runs before any agentic model call
    // in understand_inner. The cascade-level tests alone cannot prove this
    // (production only reaches the cascade when agentic declines).
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    for utterance in [
        "play the most popular song by drake",
        "play the top song by Michael Jackson",
    ] {
        let request = request_with_user_turns(vec![user_turn("music-user", utterance)]);
        let mut stream = handler
            .run_local_text_fast_path(&request, "fast-run", utterance, "fast-run", false)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("{utterance} must resolve in the local fast path"));
        let response = stream.next().await.unwrap().unwrap();
        let synapse_understanding_response::Body::Turn(turn) = response.body.unwrap() else {
            panic!("fast path must return a turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("fast path must return an action turn");
        };
        assert_eq!(action.action, native_actions::PLAY_MUSIC, "{utterance}");
    }
}

#[tokio::test]
async fn unbound_or_incomplete_current_turn_never_authorizes_local_music_planning() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;

    for (utterance, expected_action) in [
        (
            "play my favorite tracks",
            native_actions::PLAY_FAVORITE_TRACKS,
        ),
        ("play some music", native_actions::PLAY_FEATURED_MUSIC),
        (
            "make me a playlist for running",
            native_actions::GENERATE_MUSIC_PLAYLIST,
        ),
    ] {
        let request = SynapseUnderstandingRequest {
            utterance: utterance.into(),
            device_context: Some(SynapseDeviceContext {
                is_locked: false,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(trusted_authorizing_user_id(&request), None);
        assert!(
            handler
                .run_local_text_fast_path(&request, "unbound-run", utterance, "unbound-run", false,)
                .await
                .unwrap()
                .is_none(),
            "unbound outer text reached local {expected_action}"
        );
        assert!(
            handler
                .run_text_cascade(&request, "unbound-run", utterance, "unbound-run", false,)
                .await
                .unwrap()
                .is_none(),
            "unbound outer text reached fallback {expected_action}"
        );
    }

    let utterance = "play my favorite tracks";
    let mut incomplete = request_with_user_turns(vec![user_turn("music-user", utterance)]);
    incomplete
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .push(SynapseChatTurn {
            user: SynapseUser::Assistant as i32,
            identifier: "pending-action".into(),
            parent_identifier: "music-user".into(),
            content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                action: "GetBatteryStatus".into(),
                source: SynapseSource::Server as i32,
                ..Default::default()
            })),
            ..Default::default()
        });
    assert!(trusted_current_user_request(&incomplete).is_some());
    assert_eq!(trusted_authorizing_user_id(&incomplete), None);
    assert!(handler
        .run_local_text_fast_path(
            &incomplete,
            "incomplete-run",
            utterance,
            "pending-action",
            false,
        )
        .await
        .unwrap()
        .is_none());
    assert!(handler
        .run_text_cascade(
            &incomplete,
            "incomplete-run",
            utterance,
            "pending-action",
            false,
        )
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn trusted_current_turn_keeps_direct_music_actions_local_first() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;

    for (index, (utterance, expected_action)) in [
        (
            "play my favorite tracks",
            native_actions::PLAY_FAVORITE_TRACKS,
        ),
        ("play some music", native_actions::PLAY_FEATURED_MUSIC),
        (
            "make me a playlist for running",
            native_actions::GENERATE_MUSIC_PLAYLIST,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let user_id = format!("trusted-music-user-{index}");
        let request = request_with_user_turns(vec![user_turn(&user_id, utterance)]);
        assert_eq!(
            trusted_authorizing_user_id(&request),
            Some(user_id.as_str())
        );

        let mut stream = handler
            .run_local_text_fast_path(&request, "trusted-run", utterance, &user_id, false)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("trusted turn did not reach local {expected_action}"));
        let response = stream.next().await.unwrap().unwrap();
        assert!(stream.next().await.is_none());
        let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
            panic!("expected one local action turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected local action content");
        };
        assert_eq!(action.action, expected_action, "{utterance}");
    }
}

#[tokio::test]
async fn natural_most_popular_phrasing_reaches_stock_music_without_a_model() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "play the most popular song by drake";
    let request = request_with_user_turns(vec![user_turn("music-user", utterance)]);

    let action = cascade_action(&handler, &request, "music-user")
        .await
        .expect("the natural ranked phrasing must reach stock PlayMusic deterministically");

    assert_eq!(action.action, native_actions::PLAY_MUSIC);
    assert_eq!(action.source(), SynapseSource::Server);
}

#[tokio::test]
async fn named_artist_top_lookup_reaches_the_stock_music_action_without_a_model() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "play the top song by Michael Jackson";
    let request = request_with_user_turns(vec![user_turn("music-user", utterance)]);

    let action = cascade_action(&handler, &request, "music-user")
        .await
        .expect("the deterministic artist request must reach stock PlayMusic");

    assert_eq!(action.action, native_actions::PLAY_MUSIC);
    assert_eq!(action.source(), SynapseSource::Server);
    assert!(action.device_payload.is_empty());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({"Artist": "Michael Jackson"}),
    );
    assert!(!action.input.contains("Track"));
}

#[tokio::test]
async fn one_understand_handler_observes_live_fitness_flag_false_true_false() {
    let (_directory, live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let request = request_with_user_turns(vec![user_turn("fitness-user", "start tracking my run")]);

    assert!(handler
        .run_text_cascade(&request, "run-a", &request.utterance, "run-a", false)
        .await
        .unwrap()
        .is_none());

    live_config.write().await.feature_flags.overrides.insert(
        cloud_feature_flags::FITNESS_TRACKER_ENABLED.into(),
        crate::feature_flags::ConfiguredFeatureFlagValue::Bool(true),
    );
    let mut enabled = handler
        .run_text_cascade(&request, "run-b", &request.utterance, "run-b", false)
        .await
        .unwrap()
        .expect("the live flag should enable the stock fitness action");
    let response = enabled.next().await.unwrap().unwrap();
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected action turn");
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected action content");
    };
    assert_eq!(action.action, native_actions::START_ACTIVITY_TRACKER);

    live_config.write().await.feature_flags.overrides.insert(
        cloud_feature_flags::FITNESS_TRACKER_ENABLED.into(),
        crate::feature_flags::ConfiguredFeatureFlagValue::Bool(false),
    );
    assert!(handler
        .run_text_cascade(&request, "run-c", &request.utterance, "run-c", false)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn disabled_fitness_keeps_exact_stop_recovery_reachable() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let request = request_with_user_turns(vec![user_turn(
        "fitness-stop-user",
        "stop tracking my workout",
    )]);

    let mut response = handler
        .run_text_cascade(&request, "stop-run", &request.utterance, "stop-run", false)
        .await
        .unwrap()
        .expect("disabling new fitness sessions must not strand an active stock tracker");
    let response = response.next().await.unwrap().unwrap();
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected action turn");
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected action content");
    };
    assert_eq!(action.action, native_actions::STOP_ACTIVITY_TRACKER);
    assert_eq!(action.input, "{}");
}

#[tokio::test]
async fn one_understand_handler_observes_every_live_native_action_feature_gate() {
    let (_directory, live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    for (index, (key, utterance, expected_action, expected_input)) in [
        (
            cloud_feature_flags::TICKLE,
            "tickle my fancy",
            native_actions::TICKLE,
            serde_json::json!({}),
        ),
        (
            cloud_feature_flags::VISION_ACTIONS_ENABLED,
            "if you see a dog then take a picture",
            native_actions::ADD_IF_THEN_ENTRY,
            serde_json::json!({"If": "a dog", "Then": "take a picture"}),
        ),
        (
            cloud_feature_flags::QUICK_ACTIONS_REMAPPING_ENABLED,
            "change my quick action to notes",
            native_actions::CHANGE_QUICK_ACTION,
            serde_json::json!({"action": "notes"}),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        live_config.write().await.feature_flags.overrides.insert(
            key.into(),
            crate::feature_flags::ConfiguredFeatureFlagValue::Bool(false),
        );
        let request = request_with_user_turns(vec![user_turn(
            &format!("native-feature-user-{index}"),
            utterance,
        )]);
        assert!(
            cascade_action(&handler, &request, &format!("run-{index}-off"))
                .await
                .is_none(),
            "{key} ignored its disabled live value"
        );

        live_config.write().await.feature_flags.overrides.insert(
            key.into(),
            crate::feature_flags::ConfiguredFeatureFlagValue::Bool(true),
        );
        let action = cascade_action(&handler, &request, &format!("run-{index}-on"))
            .await
            .expect("enabled live gate should emit its stock action");
        assert_eq!(action.action, expected_action, "{key}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
            expected_input,
            "{key}"
        );

        live_config.write().await.feature_flags.overrides.insert(
            key.into(),
            crate::feature_flags::ConfiguredFeatureFlagValue::Bool(false),
        );
        assert!(
            cascade_action(&handler, &request, &format!("run-{index}-off-again"))
                .await
                .is_none(),
            "{key} did not observe the second live update"
        );
    }
}

#[tokio::test]
async fn enabled_vision_flag_is_ineffective_without_live_camera_cloud_consent() {
    let (_directory, live_config, handler, _automation_store) = test_understand_handler(true).await;
    let request = request_with_user_turns(vec![user_turn(
        "vision-feature-user",
        "if you see a dog then take a picture",
    )]);

    // Fixture: flag enabled and consent acknowledged -> the local vision
    // grammar emits its stock action.
    assert!(cascade_action(&handler, &request, "consent-on")
        .await
        .is_some());

    // Revoking only the camera->cloud consent disables the flag's effect
    // without touching the flag itself.
    live_config.write().await.llm.vision_consent_acknowledged = false;
    assert!(cascade_action(&handler, &request, "consent-off")
        .await
        .is_none());

    // Re-acknowledging restores it live.
    live_config.write().await.llm.vision_consent_acknowledged = true;
    assert!(cascade_action(&handler, &request, "consent-restored")
        .await
        .is_some());
}

#[tokio::test]
async fn quick_action_aliases_reach_native_planner_through_full_locked_cascade() {
    let (_directory, live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    live_config.write().await.feature_flags.overrides.insert(
        cloud_feature_flags::QUICK_ACTIONS_REMAPPING_ENABLED.into(),
        crate::feature_flags::ConfiguredFeatureFlagValue::Bool(true),
    );

    for (index, (utterance, canonical_target)) in [
        ("set quick action to translation", "interpreter"),
        ("swap touch action to messages", "messages"),
        ("make two finger action to note", "notes"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut request = request_with_user_turns(vec![user_turn(
            &format!("quick-action-user-{index}"),
            utterance,
        )]);
        request.device_context.as_mut().unwrap().is_locked = true;
        let action = cascade_action(&handler, &request, &format!("quick-action-{index}"))
            .await
            .unwrap_or_else(|| panic!("full cascade rejected stock alias: {utterance}"));
        assert_eq!(
            action.action,
            native_actions::CHANGE_QUICK_ACTION,
            "{utterance}"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
            serde_json::json!({"action": canonical_target}),
            "{utterance}"
        );
    }
}

#[tokio::test]
async fn disabling_vision_actions_revokes_staged_continuation_before_consumption() {
    let (_directory, live_config, handler, automation_store) = test_understand_handler(true).await;
    automation_store
        .stage(
            "run-a",
            &[0xff, 0xd8, 0xff, 0xdb],
            "a dog",
            crate::synapse::capabilities::vision_automation::BoundedAutomationUtterance::parse(
                "take a picture",
            )
            .unwrap(),
            "A dog is visible.",
        )
        .await;
    live_config.write().await.feature_flags.overrides.insert(
        cloud_feature_flags::VISION_ACTIONS_ENABLED.into(),
        crate::feature_flags::ConfiguredFeatureFlagValue::Bool(false),
    );

    let request = vision_automation_chain_request("run-a", "A dog is visible.");
    assert_eq!(
        handler.consume_visual_automation("run-a", &request).await,
        PendingActionResult::Blocked
    );
    assert_eq!(
        automation_store
            .consume_for_request("run-a", &request)
            .await,
        PendingActionResult::NoMatch
    );
}

#[tokio::test]
async fn verified_visual_then_replays_once_with_observation_parent_and_shared_policy() {
    let (_directory, _live_config, handler, automation_store) = test_understand_handler(true).await;
    let image = [0xff, 0xd8, 0xff, 0xdb];
    let observation = "A dog is visible.";
    automation_store
        .stage(
            "run-a",
            &image,
            "a dog",
            crate::synapse::capabilities::vision_automation::BoundedAutomationUtterance::parse(
                "take a picture",
            )
            .unwrap(),
            observation,
        )
        .await;
    let request = vision_automation_chain_request("run-a", observation);
    let mut metadata = MetadataMap::new();
    metadata.insert("x-ai-mic-run-id", "run-a".parse().unwrap());

    let mut stream = handler
        .understand_inner(metadata, request.clone(), "VisionAutomationReplayTest")
        .await
        .unwrap();
    let response = stream.next().await.unwrap().unwrap();
    let synapse_understanding_response::Body::Turn(turn) = response.body.unwrap() else {
        panic!("expected a stock action turn");
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected a stock action");
    };
    assert_eq!(action.action, native_actions::CAPTURE_PHOTOGRAPH);
    assert_eq!(turn.parent_identifier, "vision-observation");
    assert_eq!(
        automation_store
            .consume_for_request("run-a", &request)
            .await,
        PendingActionResult::NoMatch,
        "the verified Then utterance must be consumed exactly once"
    );

    automation_store
        .stage(
            "run-b",
            &image,
            "a dog",
            crate::synapse::capabilities::vision_automation::BoundedAutomationUtterance::parse(
                "take a picture",
            )
            .unwrap(),
            observation,
        )
        .await;
    let mut excluded = vision_automation_chain_request("run-b", observation);
    excluded.excluded_tools = vec!["cApTuRePhOtOgRaPh".into(), native_actions::RESPOND.into()];
    let mut metadata = MetadataMap::new();
    metadata.insert("x-ai-mic-run-id", "run-b".parse().unwrap());
    let mut stream = handler
        .understand_inner(metadata, excluded.clone(), "VisionAutomationExclusionTest")
        .await
        .unwrap();
    assert!(
        stream.next().await.is_none(),
        "a visual Then must not bypass action or Respond exclusions"
    );
    assert_eq!(
        automation_store
            .consume_for_request("run-b", &excluded)
            .await,
        PendingActionResult::NoMatch,
        "an excluded one-shot must not remain replayable"
    );
}

#[test]
fn request_location_prefers_the_current_top_level_field() {
    let req = SynapseUnderstandingRequest {
        location: Some(Location {
            latitude: 55.1,
            longitude: 12.1,
        }),
        device_context: Some(SynapseDeviceContext {
            situation: Some(SynapseUserSituation {
                location: Some(Location {
                    latitude: 56.2,
                    longitude: 13.2,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };

    assert_eq!(request_location(&req).unwrap().latitude, 55.1);
}

#[test]
fn request_location_restores_stock_situation_location_fallback() {
    let req = situation_request(SynapseUserSituation {
        location: Some(Location {
            latitude: 55.2,
            longitude: 12.2,
        }),
        ..Default::default()
    });

    let location = request_location(&req).unwrap();
    assert_eq!((location.latitude, location.longitude), (55.2, 12.2));
}

#[test]
#[allow(deprecated)]
fn request_location_accepts_valid_previous_coordinates_but_not_defaults() {
    let legacy = situation_request(SynapseUserSituation {
        latitude: 55.3,
        longitude: 12.3,
        ..Default::default()
    });
    let defaulted = situation_request(SynapseUserSituation::default());

    let location = request_location(&legacy).unwrap();
    assert!((location.latitude - 55.3).abs() < 0.001);
    assert!((location.longitude - 12.3).abs() < 0.001);
    assert!(request_location(&defaulted).is_none());
}

#[test]
fn request_location_rejects_malformed_values_and_uses_valid_fallback() {
    let req = SynapseUnderstandingRequest {
        location: Some(Location {
            latitude: 120.0,
            longitude: 12.0,
        }),
        device_context: Some(SynapseDeviceContext {
            situation: Some(SynapseUserSituation {
                location: Some(Location {
                    latitude: 55.4,
                    longitude: 12.4,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };

    assert_eq!(request_location(&req).unwrap().latitude, 55.4);
}

#[test]
#[allow(deprecated)]
fn explicit_stale_envelope_clears_every_location_fallback() {
    let mut request = SynapseUnderstandingRequest {
        location: Some(Location {
            latitude: 55.1,
            longitude: 12.1,
        }),
        device_context: Some(SynapseDeviceContext {
            reverse_geocoded_location: "Old address".into(),
            situation: Some(SynapseUserSituation {
                location_string: "Old label".into(),
                latitude: 55.2,
                longitude: 12.2,
                location: Some(Location {
                    latitude: 55.3,
                    longitude: 12.3,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    let envelope = encryption::LocationEnvelope {
        latitude: 55.4,
        longitude: 12.4,
        stale_status: encryption::LocationStaleStatus::Stale as i32,
        accuracy: 10.0,
        ..Default::default()
    };

    apply_location_envelope(&mut request, &envelope);

    assert!(request_location(&request).is_none());
    assert!(request_location_name(&request).is_none());
}

#[test]
fn undefined_or_fresh_envelope_restores_coordinates_and_bounded_label() {
    let mut request = SynapseUnderstandingRequest {
        device_context: Some(SynapseDeviceContext::default()),
        ..Default::default()
    };
    let envelope = encryption::LocationEnvelope {
        latitude: 55.4,
        longitude: 12.4,
        full_address: format!(
            " Copenhagen\n{}",
            "x".repeat(MAX_GROUNDING_VALUE_CHARS + 20)
        ),
        human_readable: "fallback label".into(),
        // UNDEFINED is how older stock clients encode an otherwise valid fix.
        stale_status: encryption::LocationStaleStatus::Undefined as i32,
        accuracy: 0.0,
        ..Default::default()
    };

    apply_location_envelope(&mut request, &envelope);

    let location = request_location(&request).unwrap();
    assert!((location.latitude - 55.4).abs() < 0.001);
    let label = request_location_name(&request).unwrap();
    assert!(!label.contains('\n'));
    assert_eq!(label.chars().count(), MAX_GROUNDING_VALUE_CHARS);
}

#[test]
fn labeled_location_envelope_never_promotes_unknown_lock_state_to_unlocked() {
    let mut request = SynapseUnderstandingRequest::default();
    let envelope = encryption::LocationEnvelope {
        latitude: 40.0,
        longitude: -70.0,
        full_address: "LOCATION_LABEL_CANARY".into(),
        stale_status: encryption::LocationStaleStatus::NotStale as i32,
        accuracy: 10.0,
        ..Default::default()
    };

    apply_location_envelope(&mut request, &envelope);

    assert!(request.device_context.is_none());
    assert_eq!(
        request_device_lock_state(&request),
        DeviceLockState::Unknown
    );
    assert!(request_location_name(&request).is_none());
    assert!(request_location(&request).is_some());
    clear_request_location(&mut request);
    assert!(request_location(&request).is_none());
}

#[test]
#[allow(deprecated)]
fn valid_envelope_never_pairs_new_coordinates_with_an_older_context_label() {
    let mut request = situation_request(SynapseUserSituation {
        location_string: "Older situation label".into(),
        ..Default::default()
    });
    request
        .device_context
        .as_mut()
        .unwrap()
        .reverse_geocoded_location = "Older context label".into();
    let mut envelope = encryption::LocationEnvelope {
        latitude: 55.4,
        longitude: 12.4,
        human_readable: "Current envelope label".into(),
        stale_status: encryption::LocationStaleStatus::NotStale as i32,
        accuracy: 10.0,
        ..Default::default()
    };

    apply_location_envelope(&mut request, &envelope);
    assert_eq!(
        request_location_name(&request).as_deref(),
        Some("Current envelope label")
    );

    envelope.human_readable.clear();
    apply_location_envelope(&mut request, &envelope);
    assert!(request_location_name(&request).is_none());
}

#[test]
fn malformed_envelope_accuracy_or_timestamp_is_not_used() {
    let mut request = SynapseUnderstandingRequest::default();
    apply_location_envelope(
        &mut request,
        &encryption::LocationEnvelope {
            latitude: 55.4,
            longitude: 12.4,
            stale_status: encryption::LocationStaleStatus::NotStale as i32,
            accuracy: -1.0,
            ..Default::default()
        },
    );
    assert!(request_location(&request).is_none());

    apply_location_envelope(
        &mut request,
        &encryption::LocationEnvelope {
            latitude: 55.4,
            longitude: 12.4,
            stale_status: encryption::LocationStaleStatus::NotStale as i32,
            accuracy: 10.0,
            timestamp: Some(prost_types::Timestamp {
                seconds: 1,
                nanos: 1_000_000_000,
            }),
            ..Default::default()
        },
    );
    assert!(request_location(&request).is_none());
}

#[test]
fn location_intents_cover_stock_nearby_prompts_and_explicit_location() {
    assert_eq!(
        classify_location_intent("Coffee nearby?"),
        Some(LocationIntent {
            reverse_geocode: false,
            nearby_query: Some("coffee".to_string()),
        })
    );
    assert_eq!(
        classify_location_intent("Find public transit around here"),
        Some(LocationIntent {
            reverse_geocode: false,
            nearby_query: Some("public transit".to_string()),
        })
    );
    assert_eq!(
        classify_location_intent("Where am I right now?"),
        Some(LocationIntent {
            reverse_geocode: true,
            nearby_query: None,
        })
    );
    assert_eq!(
        classify_location_intent("Find sushi near me"),
        Some(LocationIntent {
            reverse_geocode: false,
            nearby_query: Some("sushi".to_string()),
        })
    );
    assert_eq!(
        classify_location_intent("What's nearby?"),
        Some(LocationIntent {
            reverse_geocode: false,
            nearby_query: Some(String::new()),
        })
    );
    for (utterance, query) in [
        ("Where is the nearest Starbucks?", "starbucks"),
        ("What's the closest coffee shop near me?", "coffee shop"),
        ("Find the nearest pharmacy to me", "pharmacy"),
        ("Nearest hospital here", "hospital"),
    ] {
        assert_eq!(
            classify_location_intent(utterance),
            Some(LocationIntent {
                reverse_geocode: false,
                nearby_query: Some(query.to_string()),
            }),
            "expected bounded proximity lookup: {utterance}"
        );
    }

    for utterance in [
        "What street am I on?",
        "Which area are we in?",
        "Can you tell me my current location?",
        "Can you figure out where I am?",
        "Could you check where we are?",
        "Do you know where I am right now?",
        "Please show me my current location",
        "Please tell me what city I am in right now",
        "What is the neighborhood here?",
    ] {
        assert_eq!(
            classify_location_intent(utterance),
            Some(LocationIntent {
                reverse_geocode: true,
                nearby_query: None,
            }),
            "expected bounded current-location intent: {utterance}"
        );
    }

    for utterance in [
        "What country is Tokyo in?",
        "What city was Mozart born in?",
        "Where is the Eiffel Tower?",
        "What street is the White House on?",
        "Which area has the best museums?",
        "What city is shown in this picture?",
        "Do you know where I am from?",
        "What is the nearest star to Earth?",
        "Find the nearest prime number",
        "What is the closest planet?",
        "What is the closest matching color?",
        "Find nearest neighbor algorithm",
        "Show me the closest integer to 10",
    ] {
        assert_eq!(
            classify_location_intent(utterance),
            None,
            "ordinary factual or visual query must not fetch device location: {utterance}"
        );
    }
}

#[test]
#[allow(deprecated)]
fn current_location_fetch_is_one_shot_for_the_exact_current_turn() {
    let utterance = "Where am I?";
    let current_user = SynapseChatTurn {
        user: SynapseUser::User as i32,
        identifier: "location-user".into(),
        content: Some(synapse_chat_turn::Content::UserRequest(
            SynapseUserRequestContent {
                request: utterance.into(),
                ..Default::default()
            },
        )),
        ..Default::default()
    };
    let mut request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![current_user.clone()],
            ..Default::default()
        }),
        ..Default::default()
    };

    assert!(should_emit_current_location_action(&request));

    request.location = Some(Location {
        latitude: 55.6761,
        longitude: 12.5683,
    });
    assert!(!should_emit_current_location_action(&request));
    request.location = None;

    request
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .push(SynapseChatTurn {
            user: SynapseUser::Assistant as i32,
            identifier: "location-action".into(),
            parent_identifier: current_user.identifier.clone(),
            content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                action: native_actions::GET_CURRENT_LOCATION.into(),
                source: SynapseSource::Server as i32,
                ..Default::default()
            })),
            ..Default::default()
        });
    assert!(!should_emit_current_location_action(&request));

    request
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .push(SynapseChatTurn {
            user: SynapseUser::Assistant as i32,
            identifier: "location-observation".into(),
            parent_identifier: "location-action".into(),
            content: Some(synapse_chat_turn::Content::Observation(
                SynapseObservationContent {
                    observation: r#"{"latitude":55.6761, "longitude":12.5683,"isStale":false}"#
                        .into(),
                    is_final: false,
                    // Stock TaoEventRegistrar leaves action_name empty and
                    // binds the observation through the parent action ID.
                    action_name: String::new(),
                    source: SynapseSource::Device as i32,
                },
            )),
            ..Default::default()
        });
    match current_location_fetch_state(&request) {
        CurrentLocationFetchState::Fresh(location) => {
            assert!((location.latitude - 55.6761).abs() < 0.0001);
            assert!((location.longitude - 12.5683).abs() < 0.0001);
        }
        _ => panic!("the exact stock observation must yield a fresh fix"),
    }
    {
        let context = request.device_context.as_mut().unwrap();
        context.reverse_geocoded_location = "Older fix label".into();
        context.situation = Some(SynapseUserSituation {
            location_string: "Older situation label".into(),
            ..Default::default()
        });
    }
    request.location = Some(Location {
        latitude: 10.0,
        longitude: 20.0,
    });
    promote_fresh_current_location_observation(&mut request);
    let promoted = request_location(&request).expect("fresh observation must be promoted");
    assert!((promoted.latitude - 55.6761).abs() < 0.0001);
    assert!((promoted.longitude - 12.5683).abs() < 0.0001);
    assert!(request_location_name(&request).is_none());
    request.location = None;

    let set_observation = |request: &mut SynapseUnderstandingRequest, text: &str, parent: &str| {
        let observation = request
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap();
        let Some(synapse_chat_turn::Content::Observation(content)) = observation.content.as_mut()
        else {
            panic!("expected location observation")
        };
        content.observation = text.into();
        observation.parent_identifier = parent.into();
    };
    set_observation(
        &mut request,
        r#"{"latitude":55.6761,"longitude":12.5683,"isStale":true}"#,
        "location-action",
    );
    assert!(matches!(
        current_location_fetch_state(&request),
        CurrentLocationFetchState::Unavailable
    ));
    set_observation(&mut request, "not valid stock JSON", "location-action");
    assert!(matches!(
        current_location_fetch_state(&request),
        CurrentLocationFetchState::Unavailable
    ));
    set_observation(
        &mut request,
        r#"{"latitude":55.6761,"longitude":12.5683,"isStale":false}"#,
        "unlinked-action",
    );
    assert!(matches!(
        current_location_fetch_state(&request),
        CurrentLocationFetchState::Unavailable
    ));

    // A prior completed run must not suppress a fresh location request.
    request
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .push(SynapseChatTurn {
            user: SynapseUser::User as i32,
            identifier: "new-location-user".into(),
            content: Some(synapse_chat_turn::Content::UserRequest(
                SynapseUserRequestContent {
                    request: utterance.into(),
                    ..Default::default()
                },
            )),
            ..Default::default()
        });
    assert!(should_emit_current_location_action(&request));
}

#[test]
fn current_location_authority_uses_only_an_unlocked_canonical_current_turn() {
    let request = |raw: &str, repaired: &str| SynapseUnderstandingRequest {
        utterance: "where am I?".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![SynapseChatTurn {
                user: SynapseUser::User as i32,
                identifier: "current-location-user".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: raw.into(),
                        repaired_request: repaired.into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };

    assert!(should_emit_current_location_action(&request(
        "uncertain transcript",
        "Where am I?"
    )));
    assert!(should_emit_current_location_action(&request(
        "WHERE am I?",
        "   "
    )));
    assert!(!should_emit_current_location_action(&request(
        "where am I",
        "where is somewhere else"
    )));
    assert!(!should_emit_current_location_action(&request(
        "unused raw",
        "where\nam I?"
    )));

    for punctuation_shift in ["where am I", "where am I!", "where am I."] {
        assert!(!should_emit_current_location_action(&request(
            "where am I?",
            punctuation_shift
        )));
    }

    let mut duplicate = request("where am I?", "");
    duplicate
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .insert(0, user_turn("current-location-user", "older request"));
    assert!(!should_emit_current_location_action(&duplicate));

    let mut locked = request("where am I?", "");
    locked.device_context.as_mut().unwrap().is_locked = true;
    assert!(!should_emit_current_location_action(&locked));
}

#[test]
fn current_location_fetch_fails_closed_on_ambiguous_or_malformed_provenance() {
    let utterance = "Where am I?";
    let user = || SynapseChatTurn {
        user: SynapseUser::User as i32,
        identifier: "location-user".into(),
        content: Some(synapse_chat_turn::Content::UserRequest(
            SynapseUserRequestContent {
                request: utterance.into(),
                ..Default::default()
            },
        )),
        ..Default::default()
    };
    let action = || SynapseChatTurn {
        user: SynapseUser::Assistant as i32,
        identifier: "location-action".into(),
        parent_identifier: "location-user".into(),
        content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
            action: native_actions::GET_CURRENT_LOCATION.into(),
            source: SynapseSource::Server as i32,
            ..Default::default()
        })),
        ..Default::default()
    };
    let observation = || SynapseChatTurn {
        user: SynapseUser::Assistant as i32,
        identifier: "location-observation".into(),
        parent_identifier: "location-action".into(),
        content: Some(synapse_chat_turn::Content::Observation(
            SynapseObservationContent {
                observation: r#"{"latitude":55.6761,"longitude":12.5683,"isStale":false}"#.into(),
                is_final: false,
                action_name: native_actions::GET_CURRENT_LOCATION.into(),
                source: SynapseSource::Device as i32,
            },
        )),
        ..Default::default()
    };
    let request = |turns| SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            turns,
            ..Default::default()
        }),
        ..Default::default()
    };
    let assert_unavailable = |request: SynapseUnderstandingRequest| {
        assert!(matches!(
            current_location_fetch_state(&request),
            CurrentLocationFetchState::Unavailable
        ));
    };

    let mut wrong_latest_text = user();
    wrong_latest_text.identifier = "newer-user".into();
    let Some(synapse_chat_turn::Content::UserRequest(content)) = wrong_latest_text.content.as_mut()
    else {
        unreachable!()
    };
    content.request = "A different latest request".into();
    assert_unavailable(request(vec![user(), wrong_latest_text]));

    let mut wrong_latest_role = user();
    wrong_latest_role.user = SynapseUser::Assistant as i32;
    assert_unavailable(request(vec![wrong_latest_role]));
    let mut empty_latest_id = user();
    empty_latest_id.identifier.clear();
    assert_unavailable(request(vec![empty_latest_id]));
    assert_unavailable(request(vec![action()]));

    let mut wrong_parent = action();
    wrong_parent.parent_identifier = "wrong-user".into();
    assert_unavailable(request(vec![user(), wrong_parent]));
    let mut wrong_source = action();
    let Some(synapse_chat_turn::Content::Action(content)) = wrong_source.content.as_mut() else {
        unreachable!()
    };
    content.source = SynapseSource::Device as i32;
    assert_unavailable(request(vec![user(), wrong_source]));
    let mut nonempty_payload = action();
    let Some(synapse_chat_turn::Content::Action(content)) = nonempty_payload.content.as_mut()
    else {
        unreachable!()
    };
    content.device_payload = vec![1];
    assert_unavailable(request(vec![user(), nonempty_payload]));

    let mut duplicate_action = action();
    duplicate_action.identifier = "duplicate-location-action".into();
    assert_unavailable(request(vec![user(), action(), duplicate_action]));

    let mut non_location_sibling = action();
    let Some(synapse_chat_turn::Content::Action(content)) = non_location_sibling.content.as_mut()
    else {
        unreachable!()
    };
    content.action = native_actions::GET_BATTERY_LEVEL.into();
    assert_unavailable(request(vec![
        user(),
        non_location_sibling,
        action(),
        observation(),
    ]));

    let cross_content_interloper = SynapseChatTurn {
        user: SynapseUser::Assistant as i32,
        identifier: "location-action".into(),
        parent_identifier: "location-user".into(),
        content: Some(synapse_chat_turn::Content::Message(SynapseMessageContent {
            content: "unrelated sibling".into(),
        })),
        ..Default::default()
    };
    assert_unavailable(request(vec![
        user(),
        action(),
        cross_content_interloper,
        observation(),
    ]));

    let historical_message = |identifier: &str| SynapseChatTurn {
        user: SynapseUser::Assistant as i32,
        identifier: identifier.into(),
        content: Some(synapse_chat_turn::Content::Message(SynapseMessageContent {
            content: "older completed context".into(),
        })),
        ..Default::default()
    };
    assert_unavailable(request(vec![
        historical_message("location-action"),
        user(),
        action(),
        observation(),
    ]));
    assert_unavailable(request(vec![
        historical_message("location-observation"),
        user(),
        action(),
        observation(),
    ]));

    assert_unavailable(request(vec![user(), observation()]));
    let mut duplicate_observation = observation();
    duplicate_observation.identifier = "duplicate-location-observation".into();
    assert_unavailable(request(vec![
        user(),
        action(),
        observation(),
        duplicate_observation,
    ]));

    let mut nameless_observation = observation();
    let Some(synapse_chat_turn::Content::Observation(content)) =
        nameless_observation.content.as_mut()
    else {
        unreachable!()
    };
    content.action_name.clear();
    let valid_nameless_observation = nameless_observation.clone();
    let mut duplicate_nameless_observation = nameless_observation.clone();
    duplicate_nameless_observation.identifier = "duplicate-nameless-observation".into();
    assert_unavailable(request(vec![
        user(),
        action(),
        nameless_observation,
        duplicate_nameless_observation,
    ]));

    let mut wrong_named_observation = observation();
    let Some(synapse_chat_turn::Content::Observation(content)) =
        wrong_named_observation.content.as_mut()
    else {
        unreachable!()
    };
    content.action_name = "SomeOtherAction".into();
    assert_unavailable(request(vec![
        user(),
        action(),
        wrong_named_observation.clone(),
    ]));
    assert_unavailable(request(vec![
        user(),
        action(),
        valid_nameless_observation,
        wrong_named_observation,
    ]));
}

#[tokio::test]
async fn unusable_current_location_fetch_returns_one_terminal_response() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "Where am I?";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![
                SynapseChatTurn {
                    user: SynapseUser::User as i32,
                    identifier: "location-user".into(),
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        SynapseUserRequestContent {
                            request: utterance.into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "location-action".into(),
                    parent_identifier: "location-user".into(),
                    content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                        action: native_actions::GET_CURRENT_LOCATION.into(),
                        source: SynapseSource::Server as i32,
                        ..Default::default()
                    })),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "location-observation".into(),
                    parent_identifier: "location-action".into(),
                    content: Some(synapse_chat_turn::Content::Observation(
                        SynapseObservationContent {
                            observation: "Unable to get updated location[unavailable].".into(),
                            is_final: false,
                            action_name: native_actions::GET_CURRENT_LOCATION.into(),
                            source: SynapseSource::Device as i32,
                        },
                    )),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }),
        ..Default::default()
    };

    let mut stream = handler
        .run_text_cascade(&request, "location-run", utterance, "location-user", false)
        .await
        .unwrap()
        .expect("an unusable completed fetch must return a terminal response");
    let response = stream.next().await.unwrap().unwrap();
    assert!(stream.next().await.is_none());
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected one Respond turn")
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected one Respond action")
    };
    assert_eq!(action.action, native_actions::RESPOND);
    assert!(action
        .input
        .contains("couldn't get a fresh current location"));

    let mut respond_excluded = request.clone();
    respond_excluded.excluded_tools.push("respond".into());
    let mut stream = handler
        .run_text_cascade(
            &respond_excluded,
            "location-run",
            utterance,
            "location-user",
            false,
        )
        .await
        .unwrap()
        .expect("a completed location fetch must terminate the cascade stage");
    assert!(
        stream.next().await.is_none(),
        "an excluded Respond action must not be reintroduced as a fallback"
    );
}

#[tokio::test]
async fn nearby_preflight_respects_get_current_location_exclusion() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "What's nearby?";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        excluded_tools: vec!["getcurrentlocation".into()],
        device_context: Some(SynapseDeviceContext {
            turns: vec![SynapseChatTurn {
                user: SynapseUser::User as i32,
                identifier: "nearby-user".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: utterance.into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };

    assert!(handler
        .run_text_cascade(&request, "nearby-run", utterance, "nearby-user", false)
        .await
        .unwrap()
        .is_none());
}

fn local_weather_continuation_request(
    user_identifier: &str,
    action_turn: SynapseChatTurn,
    utterance: &str,
    is_locked: bool,
) -> SynapseUnderstandingRequest {
    let action_identifier = action_turn.identifier.clone();
    SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked,
            turns: vec![
                user_turn(user_identifier, utterance),
                action_turn,
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: format!("{action_identifier}-observation"),
                    parent_identifier: action_identifier,
                    content: Some(synapse_chat_turn::Content::Observation(
                        SynapseObservationContent {
                            observation:
                                r#"{"latitude":55.6761,"longitude":12.5683,"isStale":false}"#.into(),
                            is_final: false,
                            action_name: native_actions::GET_CURRENT_LOCATION.into(),
                            source: SynapseSource::Device as i32,
                        },
                    )),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn local_weather_action_turn(user_identifier: &str) -> SynapseChatTurn {
    let response = SynapseUnderstandingResponse::action_response(
        native_actions::GET_CURRENT_LOCATION,
        LOCAL_WEATHER_LOCATION_PREFLIGHT_THOUGHT,
        "{}",
        user_identifier,
    );
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected a stock location action turn")
    };
    turn
}

#[test]
fn local_weather_trace_is_one_shot_parent_bound_and_fresh() {
    let store = LocalWeatherTraceStore::default();
    let utterance = "What's the weather like today?";
    let user_identifier = "weather-proof-user";
    let action_turn = local_weather_action_turn(user_identifier);
    let action_identifier = action_turn.identifier.clone();
    let correlation = store
        .stage(&action_identifier, user_identifier, utterance)
        .expect("the exact bounded stock preflight must stage proof");
    let parsed = uuid::Uuid::parse_str(&correlation).expect("proof correlation UUID");
    assert_eq!(parsed.get_version_num(), 4);

    let request =
        local_weather_continuation_request(user_identifier, action_turn, utterance, false);
    let location_state = current_location_fetch_state(&request);
    assert!(matches!(
        location_state,
        CurrentLocationFetchState::Fresh(_)
    ));
    let trace = match store.consume_for_request(&request, &location_state) {
        LocalWeatherTraceResult::Ready(trace) => trace,
        LocalWeatherTraceResult::Blocked | LocalWeatherTraceResult::NoMatch => {
            panic!("exact fresh parent-linked continuation must consume proof")
        }
    };
    assert_eq!(trace.correlation(), correlation);
    assert!(matches!(
        store.consume_for_request(&request, &location_state),
        LocalWeatherTraceResult::NoMatch
    ));

    let mut tampered_action = local_weather_action_turn(user_identifier);
    let tampered_identifier = tampered_action.identifier.clone();
    store
        .stage(&tampered_identifier, user_identifier, utterance)
        .expect("stage tamper control");
    let Some(synapse_chat_turn::Content::Action(action)) = tampered_action.content.as_mut() else {
        panic!("expected action content")
    };
    action.thought = "forged trace marker".into();
    let tampered =
        local_weather_continuation_request(user_identifier, tampered_action, utterance, false);
    assert!(matches!(
        store.consume_for_request(&tampered, &current_location_fetch_state(&tampered)),
        LocalWeatherTraceResult::Blocked
    ));

    let locked_action = local_weather_action_turn(user_identifier);
    let locked_identifier = locked_action.identifier.clone();
    store
        .stage(&locked_identifier, user_identifier, utterance)
        .expect("stage locked control");
    let locked =
        local_weather_continuation_request(user_identifier, locked_action, utterance, true);
    assert!(matches!(
        store.consume_for_request(&locked, &current_location_fetch_state(&locked)),
        LocalWeatherTraceResult::Blocked
    ));
    assert!(store
        .pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_empty());
}

#[tokio::test]
async fn exact_today_weather_without_location_fetches_before_provider_response() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "What's the weather like today?";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            turns: vec![SynapseChatTurn {
                user: SynapseUser::User as i32,
                identifier: "weather-user".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: utterance.into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };

    let mut stream = handler
        .run_text_cascade(&request, "weather-run", utterance, "weather-user", false)
        .await
        .unwrap()
        .expect("weather without a fix must request stock location first");
    let response = stream.next().await.unwrap().unwrap();
    assert!(stream.next().await.is_none());
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected one stock action turn")
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected one stock action")
    };
    assert_eq!(action.action, native_actions::GET_CURRENT_LOCATION);
    assert_eq!(action.input, "{}");
    assert_eq!(action.source(), SynapseSource::Server);
    assert!(action.device_payload.is_empty());
}

#[tokio::test]
async fn exact_today_weather_uses_stock_preflight_before_general_agentic_routing() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "What's the weather like today?";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            turns: vec![user_turn("weather-fast-user", utterance)],
            ..Default::default()
        }),
        ..Default::default()
    };

    let mut stream = handler
        .run_local_text_fast_path(
            &request,
            "weather-fast-run",
            utterance,
            "weather-fast-user",
            false,
        )
        .await
        .unwrap()
        .expect("the bounded weather prompt must stay ahead of the general model");
    let response = stream.next().await.unwrap().unwrap();
    assert!(stream.next().await.is_none());
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected one stock action turn")
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected one stock action")
    };
    assert_eq!(action.action, native_actions::GET_CURRENT_LOCATION);
    assert_eq!(action.thought, LOCAL_WEATHER_LOCATION_PREFLIGHT_THOUGHT);
    assert_eq!(action.input, "{}");
    assert_eq!(action.source(), SynapseSource::Server);
    assert!(action.device_payload.is_empty());

    let compound = "Lookup the capital of France and check the weather there";
    let compound_request = SynapseUnderstandingRequest {
        utterance: compound.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            turns: vec![user_turn("compound-weather-user", compound)],
            ..Default::default()
        }),
        ..Default::default()
    };
    assert!(handler
        .run_local_text_fast_path(
            &compound_request,
            "compound-weather-run",
            compound,
            "compound-weather-user",
            false,
        )
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn exact_today_weather_uses_valid_request_coordinates_without_inventing_a_city() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "WHAT'S THE WEATHER LIKE TODAY?!";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        location: Some(Location {
            latitude: 55.6761,
            longitude: 12.5683,
        }),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            reverse_geocoded_location: "A stale city label that must not be narrated".into(),
            turns: vec![user_turn("weather-user", utterance)],
            ..Default::default()
        }),
        ..Default::default()
    };

    assert_eq!(
        plan_weather_prompt_with_context(&request),
        Some(WeatherPromptKind::Current)
    );
    let provider_location = request_location(&request).expect("valid request coordinates");
    assert_eq!(
        (provider_location.latitude, provider_location.longitude),
        (55.6761, 12.5683),
    );
    let action = cascade_action(&handler, &request, "weather-user")
        .await
        .expect("valid device coordinates must route through the stock response action");
    assert_eq!(action.action, native_actions::RESPOND);
    assert_eq!(action.source(), SynapseSource::Server);
    assert!(action.device_payload.is_empty());
    let input = serde_json::from_str::<serde_json::Value>(&action.input).unwrap();
    assert_eq!(input.as_object().unwrap().len(), 1);
    assert!(input
        .get("Response")
        .is_some_and(serde_json::Value::is_string));
    assert!(!action.input.contains("stale city label"));
    assert!(!action.input.contains(native_actions::GET_CURRENT_LOCATION));
}

#[test]
fn weather_locality_requires_the_exact_unlocked_fix_and_structured_municipality() {
    let location = Location {
        latitude: 55.6761,
        longitude: 12.5683,
    };
    let mut request = SynapseUnderstandingRequest {
        location: Some(location),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            reverse_geocoded_location: "Old request label".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert!(request_owns_weather_fix(&request, &location));
    assert!(!request_owns_weather_fix(
        &request,
        &Location {
            latitude: 55.6762,
            longitude: 12.5683,
        },
    ));

    request.device_context.as_mut().unwrap().is_locked = true;
    assert!(!request_owns_weather_fix(&request, &location));

    let locality = ReverseGeocodeResult {
        display_name: Some("An unrelated full provider address".into()),
        street_number: None,
        street_name: None,
        municipality: Some("Hvidovre".into()),
        country_subdivision: None,
        country: Some("Denmark".into()),
        postal_code: None,
    };
    assert_eq!(
        reverse_geocoded_weather_locality(&locality).as_deref(),
        Some("Hvidovre")
    );

    let display_only = ReverseGeocodeResult {
        municipality: None,
        ..locality
    };
    assert!(reverse_geocoded_weather_locality(&display_only).is_none());
}

#[test]
fn exact_today_weather_promotes_only_the_parent_bound_stock_location() {
    let utterance = "What's the weather like today?";
    let mut request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            reverse_geocoded_location: "Older city label".into(),
            turns: vec![
                user_turn("weather-user", utterance),
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "location-action".into(),
                    parent_identifier: "weather-user".into(),
                    content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                        action: native_actions::GET_CURRENT_LOCATION.into(),
                        source: SynapseSource::Server as i32,
                        ..Default::default()
                    })),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "location-observation".into(),
                    parent_identifier: "location-action".into(),
                    content: Some(synapse_chat_turn::Content::Observation(
                        SynapseObservationContent {
                            observation:
                                r#"{"latitude":55.6761,"longitude":12.5683,"isStale":false}"#.into(),
                            is_final: false,
                            action_name: native_actions::GET_CURRENT_LOCATION.into(),
                            source: SynapseSource::Device as i32,
                        },
                    )),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }),
        ..Default::default()
    };

    promote_fresh_current_location_observation(&mut request);

    let location = request_location(&request).expect("trusted stock fix must be promoted");
    assert!((location.latitude - 55.6761).abs() < 0.0001);
    assert!((location.longitude - 12.5683).abs() < 0.0001);
    assert!(request_location_name(&request).is_none());
    assert_eq!(
        plan_weather_prompt_with_context(&request),
        Some(WeatherPromptKind::Current)
    );

    let mut wrong_parent = request.clone();
    wrong_parent.location = None;
    wrong_parent.device_context.as_mut().unwrap().turns[2].parent_identifier =
        "some-other-action".into();
    promote_fresh_current_location_observation(&mut wrong_parent);
    assert!(request_location(&wrong_parent).is_none());
}

#[tokio::test]
async fn exact_today_weather_fails_safely_when_locked_invalid_or_excluded() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "What's the weather like today?";

    let mut locked = request_with_user_turns(vec![user_turn("weather-user", utterance)]);
    locked.device_context.as_mut().unwrap().is_locked = true;
    assert_eq!(plan_weather_prompt_with_context(&locked), None);
    assert!(handler
        .run_text_cascade(&locked, "weather-user", utterance, "weather-user", false,)
        .await
        .unwrap()
        .is_none());

    let mut invalid = request_with_user_turns(vec![user_turn("weather-user", utterance)]);
    invalid.location = Some(Location {
        latitude: 120.0,
        longitude: 12.0,
    });
    let invalid_action = cascade_action(&handler, &invalid, "weather-user")
        .await
        .expect("an invalid coordinate must be replaced by one stock location preflight");
    assert_eq!(invalid_action.action, native_actions::GET_CURRENT_LOCATION);

    let mut excluded = request_with_user_turns(vec![user_turn("weather-user", utterance)]);
    excluded.excluded_tools = vec!["getcurrentlocation".into()];
    let excluded_action = cascade_action(&handler, &excluded, "weather-user")
        .await
        .expect("an excluded location preflight must terminate through stock Respond");
    assert_eq!(excluded_action.action, native_actions::RESPOND);
    assert!(excluded_action.input.contains("current location"));

    excluded.excluded_tools.push("respond".into());
    let mut stream = handler
        .run_text_cascade(&excluded, "weather-user", utterance, "weather-user", false)
        .await
        .unwrap()
        .expect("the bounded weather stage must terminate when both actions are excluded");
    assert!(stream.next().await.is_none());

    let mut valid_but_respond_excluded =
        request_with_user_turns(vec![user_turn("weather-user", utterance)]);
    valid_but_respond_excluded.location = Some(Location {
        latitude: 55.6761,
        longitude: 12.5683,
    });
    valid_but_respond_excluded.excluded_tools = vec!["respond".into()];
    let mut stream = handler
        .run_text_cascade(
            &valid_but_respond_excluded,
            "weather-user",
            utterance,
            "weather-user",
            false,
        )
        .await
        .unwrap()
        .expect("the deterministic weather stage must honor Respond exclusion");
    assert!(stream.next().await.is_none());
}

#[test]
fn weather_followups_require_an_immediately_prior_trusted_weather_user_turn() {
    let tomorrow = request_with_user_turns(vec![
        user_turn("weather-root", "What's the weather outside?"),
        user_turn("weather-followup", "What about tomorrow?"),
    ]);
    assert_eq!(
        plan_weather_prompt_with_context(&tomorrow),
        Some(WeatherPromptKind::Tomorrow)
    );

    let whitespace_only_prior_repair = request_with_user_turns(vec![
        user_turn_with_repair("weather-root", "What's the weather outside?", "   "),
        user_turn("weather-followup", "What about tomorrow?"),
    ]);
    assert_eq!(
        plan_weather_prompt_with_context(&whitespace_only_prior_repair),
        Some(WeatherPromptKind::Tomorrow)
    );

    let alerts = request_with_user_turns(vec![
        user_turn("weather-root", "What's the weather outside?"),
        user_turn("weather-followup", "Any alerts?"),
    ]);
    assert_eq!(
        plan_weather_prompt_with_context(&alerts),
        Some(WeatherPromptKind::Alerts)
    );

    let unrelated = request_with_user_turns(vec![
        user_turn("unrelated-root", "Tell me about Copenhagen"),
        user_turn("ambiguous-followup", "What about tomorrow?"),
    ]);
    assert_eq!(plan_weather_prompt_with_context(&unrelated), None);

    let mut wrong_role = tomorrow.clone();
    wrong_role
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .first_mut()
        .unwrap()
        .user = SynapseUser::Assistant as i32;
    assert_eq!(plan_weather_prompt_with_context(&wrong_role), None);

    let mut mismatched_outer_request = tomorrow;
    mismatched_outer_request.utterance = "unlinked outer request".into();
    assert_eq!(
        plan_weather_prompt_with_context(&mismatched_outer_request),
        None
    );
}

#[tokio::test]
async fn nearest_place_without_location_fetches_before_grounding() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "Where is the nearest Starbucks?";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            turns: vec![SynapseChatTurn {
                user: SynapseUser::User as i32,
                identifier: "nearest-user".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: utterance.into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };

    let mut stream = handler
        .run_text_cascade(&request, "nearest-run", utterance, "nearest-user", false)
        .await
        .unwrap()
        .expect("nearest-place lookup without a fix must request stock location first");
    let response = stream.next().await.unwrap().unwrap();
    assert!(stream.next().await.is_none());
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected one stock action turn")
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected one stock action")
    };
    assert_eq!(action.action, native_actions::GET_CURRENT_LOCATION);
}

#[tokio::test]
async fn adjacent_nearby_category_refinement_fetches_location_for_a_fresh_lookup() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let location = Location {
        latitude: 55.0,
        longitude: 12.0,
    };
    let initial = request_with_user_turns(vec![user_turn("nearby-user", "Coffee nearby?")]);
    handler.location_grounding.store_grounding(
        &initial,
        "fallback-run",
        &location,
        test_grounding_payload(),
    );

    let request = request_with_user_turns(vec![
        user_turn("nearby-user", "Coffee nearby?"),
        user_turn("refinement-user", "What about restaurants?"),
    ]);
    let mut stream = handler
        .run_text_cascade(
            &request,
            "refinement-run",
            &request.utterance,
            "refinement-user",
            false,
        )
        .await
        .unwrap()
        .expect("a fresh Nearby refinement must request current location first");
    let response = stream.next().await.unwrap().unwrap();
    assert!(stream.next().await.is_none());
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        panic!("expected one stock action turn")
    };
    let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
        panic!("expected one stock action")
    };
    assert_eq!(action.action, native_actions::GET_CURRENT_LOCATION);
}

#[tokio::test]
async fn visual_location_continuation_never_emits_or_repeats_location_fetch() {
    let (_directory, _live_config, handler, _automation_store) =
        test_understand_handler(false).await;
    let utterance = "find coffee nearby";
    let request = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            is_locked: false,
            turns: vec![SynapseChatTurn {
                user: SynapseUser::User as i32,
                identifier: "vision-observation".into(),
                content: Some(synapse_chat_turn::Content::UserRequest(
                    SynapseUserRequestContent {
                        request: utterance.into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };

    for _ in 0..2 {
        let mut stream = handler
            .run_text_cascade(
                &request,
                "visual-location-run",
                utterance,
                "vision-observation",
                true,
            )
            .await
            .unwrap()
            .expect("visual location continuation must terminate safely");
        let response = stream.next().await.unwrap().unwrap();
        assert!(stream.next().await.is_none());
        let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
            panic!("expected one terminal stock action turn")
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected one terminal stock action")
        };
        assert_eq!(action.action, native_actions::RESPOND);
        assert_ne!(action.action, native_actions::GET_CURRENT_LOCATION);
    }

    let mut respond_excluded = request;
    respond_excluded
        .excluded_tools
        .push(native_actions::RESPOND.into());
    let mut stream = handler
        .run_text_cascade(
            &respond_excluded,
            "visual-location-run",
            utterance,
            "vision-observation",
            true,
        )
        .await
        .unwrap()
        .expect("excluded visual location continuation must still terminate the stage");
    assert!(stream.next().await.is_none());
}

#[test]
fn nearby_snapshot_supports_the_adjacent_distance_followup() {
    assert!(classify_location_intent("How far is the second one?").is_none());
    assert!(is_location_followup("How far is the second one?"));
    let grounding = test_location_grounding();
    let location = Location {
        latitude: 55.0,
        longitude: 12.0,
    };
    let initial = request_with_user_turns(vec![user_turn("nearby-user", "What's nearby?")]);
    grounding.store_grounding(
        &initial,
        "fallback-run",
        &location,
        test_grounding_payload(),
    );

    let followup = request_with_user_turns(vec![
        user_turn("nearby-user", "What's nearby?"),
        user_turn("distance-user", "How far is the second one?"),
    ]);
    let context = grounding
        .cached_followup(&followup, "fallback-run", Some(&location))
        .expect("an adjacent contextual follow-up should retain the exact nearby snapshot");
    assert!(context.contains("Test Cafe"));
    assert_eq!(
        previous_grounding_key(&followup).as_deref(),
        Some("nearby-user")
    );
    assert_eq!(
        current_grounding_key(&followup, "fallback-run"),
        "distance-user"
    );
}

#[test]
fn adjacent_nearby_category_refinement_becomes_a_fresh_search_intent() {
    assert_eq!(
        contextual_nearby_refinement_query("What about restaurants?"),
        Some("restaurants".into())
    );
    assert_eq!(
        contextual_nearby_refinement_query("And parks instead"),
        Some("parks".into())
    );
    assert_eq!(
        contextual_nearby_refinement_query("What about quantum mechanics?"),
        None
    );

    let grounding = test_location_grounding();
    let location = Location {
        latitude: 55.0,
        longitude: 12.0,
    };
    let initial = request_with_user_turns(vec![user_turn("nearby-user", "Coffee nearby?")]);
    grounding.store_grounding(
        &initial,
        "fallback-run",
        &location,
        test_grounding_payload(),
    );

    let refinement = request_with_user_turns(vec![
        user_turn("nearby-user", "Coffee nearby?"),
        user_turn("refinement-user", "What about restaurants?"),
    ]);
    assert_eq!(
        grounding.intent_for_request(&refinement, &refinement.utterance),
        Some(LocationIntent {
            reverse_geocode: false,
            nearby_query: Some("restaurants".into()),
        })
    );
    assert!(
        !is_location_followup(&refinement.utterance),
        "the refinement must take the fresh-search path, not replay the old snapshot"
    );

    let no_snapshot = test_location_grounding();
    assert_eq!(
        no_snapshot.intent_for_request(&refinement, &refinement.utterance),
        None
    );
}

#[test]
fn natural_note_call_uses_fixed_function_name_and_request_owned_context() {
    let timestamp = prost_types::Timestamp {
        seconds: 1_721_000_000,
        nanos: 0,
    };
    let request = SynapseUnderstandingRequest {
        utterance: "Take a note buy coffee".into(),
        location: Some(Location {
            latitude: 55.6761,
            longitude: 12.5683,
        }),
        device_context: Some(SynapseDeviceContext {
            current_timestamp: Some(timestamp),
            reverse_geocoded_location: "Copenhagen, Denmark".into(),
            situation: Some(SynapseUserSituation {
                time_zone_id: "Europe/Copenhagen".into(),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };

    let call = note_function_call(&request, "buy coffee".into());
    assert_eq!(call.name, native_actions::CREATE_MEMORY);
    assert_eq!(call.utterance, "buy coffee");
    assert_eq!(call.timestamp, Some(timestamp));
    assert_eq!(call.time_zone, "Europe/Copenhagen");
    assert_eq!(call.reverse_geocoded_location, "Copenhagen, Denmark");
    assert!(!call.is_locked);
    let location = call.location.unwrap();
    assert!((location.latitude - 55.6761).abs() < 0.001);
    assert!((location.longitude - 12.5683).abs() < 0.001);
}

#[test]
fn restricted_note_calls_drop_location_metadata_and_treat_unknown_as_locked() {
    for device_context in [
        Some(SynapseDeviceContext {
            is_locked: true,
            reverse_geocoded_location: "NOTE_LOCATION_CANARY".into(),
            situation: Some(SynapseUserSituation {
                time_zone_id: "NOTE_TIMEZONE_CANARY".into(),
                ..Default::default()
            }),
            ..Default::default()
        }),
        None,
    ] {
        let request = SynapseUnderstandingRequest {
            location: Some(Location {
                latitude: 40.0,
                longitude: -70.0,
            }),
            device_context,
            ..Default::default()
        };

        let call = note_function_call(&request, "NOTE_TEXT_CANARY".into());
        assert!(call.is_locked);
        assert!(call.location.is_none());
        assert!(call.reverse_geocoded_location.is_empty());
        assert!(call.time_zone.is_empty());
    }
}

#[test]
fn ordinary_and_deictic_followups_do_not_trigger_a_new_unrelated_search() {
    assert_eq!(classify_location_intent("Tell me more"), None);
    assert_eq!(classify_location_intent("How far is the second one?"), None);
    for utterance in [
        "Tell me more",
        "How far is the second one?",
        "What's its address?",
        "What time does number two close?",
        "How long to walk there?",
        "And the third?",
        "Give me directions",
    ] {
        assert!(
            is_location_followup(utterance),
            "expected location follow-up: {utterance}"
        );
    }
    for utterance in [
        "What time is it?",
        "Explain quantum mechanics",
        "What is the second law of thermodynamics?",
        "Tell me more about quantum mechanics",
        "What about quantum mechanics?",
    ] {
        assert!(
            !is_location_followup(utterance),
            "must not attach Nearby context: {utterance}"
        );
    }
}

#[test]
fn grounding_lookup_status_distinguishes_provider_failure_from_empty_success() {
    let timeout: Option<Result<Vec<NearbyPlace>, OsmError>> = Some(Err(OsmError::Timeout));
    let empty_success: Option<Result<Vec<NearbyPlace>, OsmError>> = Some(Ok(Vec::new()));
    let not_requested: Option<Result<Vec<NearbyPlace>, OsmError>> = None;

    assert_eq!(lookup_status(&timeout), Some("timeout"));
    assert_eq!(lookup_status(&empty_success), Some("success"));
    assert_eq!(lookup_status(&not_requested), None);
}

#[test]
fn grounding_cache_keys_follow_only_the_immediately_adjacent_user_turns() {
    let request = SynapseUnderstandingRequest {
        utterance: "the second one".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![
                SynapseChatTurn {
                    user: SynapseUser::User as i32,
                    identifier: "older-completed-run".into(),
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        SynapseUserRequestContent {
                            request: "unrelated older context".into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::User as i32,
                    identifier: "conversation-root".into(),
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        SynapseUserRequestContent {
                            request: "coffee nearby".into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                },
                SynapseChatTurn {
                    user: SynapseUser::User as i32,
                    identifier: "current-turn".into(),
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        SynapseUserRequestContent {
                            request: "the second one".into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }),
        ..Default::default()
    };

    assert_eq!(
        current_grounding_key(&request, "fallback-run"),
        "current-turn"
    );
    assert_eq!(
        previous_grounding_key(&request).as_deref(),
        Some("conversation-root")
    );
    assert_eq!(
        current_grounding_key(&SynapseUnderstandingRequest::default(), "fallback-run"),
        "fallback-run"
    );
    assert_eq!(
        previous_grounding_key(&SynapseUnderstandingRequest::default()),
        None
    );

    let mut wrong_role = request.clone();
    wrong_role
        .device_context
        .as_mut()
        .unwrap()
        .turns
        .last_mut()
        .unwrap()
        .user = SynapseUser::Assistant as i32;
    assert_eq!(
        current_grounding_key(&wrong_role, "fallback-run"),
        "fallback-run"
    );
    assert_eq!(previous_grounding_key(&wrong_role), None);

    let mut mismatched_outer_request = request;
    mismatched_outer_request.utterance = "different request".into();
    assert_eq!(
        current_grounding_key(&mismatched_outer_request, "fallback-run"),
        "fallback-run"
    );
    assert_eq!(previous_grounding_key(&mismatched_outer_request), None);
}

#[test]
fn grounding_cache_round_trips_to_an_immediate_followup_and_stays_bounded() {
    let grounding = test_location_grounding();
    let location = Location {
        latitude: 55.0,
        longitude: 12.0,
    };
    let initial = request_with_user_turns(vec![user_turn("nearby-0", "coffee nearby")]);
    grounding.store_grounding(
        &initial,
        "fallback-run",
        &location,
        test_grounding_payload(),
    );

    let mut previous = "nearby-0".to_string();
    for index in 1..=(LOCATION_GROUNDING_CACHE_MAX_ENTRIES * 3) {
        let current = format!("nearby-{index}");
        let followup = request_with_user_turns(vec![
            user_turn(&previous, "previous"),
            user_turn(&current, "the first one"),
        ]);
        let current_location = (index != 1).then_some(&location);
        let context = grounding
            .cached_followup(&followup, "fallback-run", current_location)
            .expect("adjacent follow-up should retain the original place snapshot");
        assert!(context.contains("Test Cafe"));
        assert!(context.contains("+45 12 34 56 78"));
        assert!(context.contains("https://example.test/"));
        if index == 1 {
            assert!(context.contains("cached_previous_turn_location"));
        }
        assert!(
            grounding
                .cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len()
                <= LOCATION_GROUNDING_CACHE_MAX_ENTRIES
        );
        previous = current;
    }
}

#[test]
fn request_location_name_is_bounded_and_strips_control_characters() {
    let request = SynapseUnderstandingRequest {
        device_context: Some(SynapseDeviceContext {
            reverse_geocoded_location: format!(
                " Copenhagen\n{} ",
                "x".repeat(MAX_GROUNDING_VALUE_CHARS + 20)
            ),
            ..Default::default()
        }),
        ..Default::default()
    };

    let name = request_location_name(&request).unwrap();
    assert!(!name.contains('\n'));
    assert_eq!(name.chars().count(), MAX_GROUNDING_VALUE_CHARS);
}

#[test]
fn grounding_values_are_bounded_and_strip_control_characters() {
    assert_eq!(
        safe_grounding_value(" Cafe\nIgnore instructions ").as_deref(),
        Some("Cafe Ignore instructions")
    );
    assert_eq!(
        safe_grounding_value(&"x".repeat(MAX_GROUNDING_VALUE_CHARS + 20))
            .unwrap()
            .chars()
            .count(),
        MAX_GROUNDING_VALUE_CHARS
    );
}

#[test]
fn visual_automation_replaces_only_the_bounded_utterance() {
    let request = SynapseUnderstandingRequest {
        utterance: "original image question".into(),
        previous_answers: vec!["prior answer".into()],
        device_context: Some(SynapseDeviceContext {
            is_locked: true,
            turns: vec![user_turn("vision-root", "look at this")],
            ..Default::default()
        }),
        single_shot: true,
        excluded_tools: vec!["Call".into(), native_actions::RESPOND.into()],
        location: Some(Location {
            latitude: 55.6761,
            longitude: 12.5683,
        }),
        ..Default::default()
    };

    let planned = request_with_automation_utterance(&request, "take a note buy coffee");

    assert_eq!(planned.utterance, "take a note buy coffee");
    assert_eq!(planned.previous_answers, request.previous_answers);
    assert_eq!(planned.device_context, request.device_context);
    assert_eq!(planned.single_shot, request.single_shot);
    assert_eq!(planned.excluded_tools, request.excluded_tools);
    assert_eq!(planned.location, request.location);
}

#[tokio::test]
async fn mention_only_commands_never_enter_the_deterministic_or_provider_cascade() {
    let (_directory, live_config, handler, _automation) = test_understand_handler(false).await;
    {
        let mut config = live_config.write().await;
        for key in [
            cloud_feature_flags::FITNESS_TRACKER_ENABLED,
            cloud_feature_flags::TICKLE,
        ] {
            config.feature_flags.overrides.insert(
                key.into(),
                crate::feature_flags::ConfiguredFeatureFlagValue::Bool(true),
            );
        }
    }

    for (index, utterance) in [
        "\"take a photo\"",
        "\"enter privacy mode\"",
        "\"volume up\"",
        "\"start tracking my run\"",
        "\"hang up\"",
        "\"set a timer for five minutes\"",
        "\"set an alarm for 7 am\"",
        "\"coffee near me\"",
        "do not find coffee near me",
        "What happens if I say \"pause the music\"?",
    ]
    .into_iter()
    .enumerate()
    {
        let request = request_with_user_turns(vec![user_turn(
            &format!("mention-only-user-{index}"),
            utterance,
        )]);
        assert!(
            handler
                .run_text_cascade(
                    &request,
                    "mention-only-run",
                    utterance,
                    "mention-only-user",
                    false,
                )
                .await
                .unwrap()
                .is_none(),
            "mention-only utterance reached deterministic/provider work: {utterance}"
        );
    }

    for (index, (utterance, expected_action)) in [
        (
            "How do you say 'thank you' in German?",
            native_actions::TRANSLATE,
        ),
        (cloud_feature_flags::TICKLE, native_actions::TICKLE),
        ("tickle my fancy", native_actions::TICKLE),
        ("tickle tickle tickle", native_actions::TICKLE),
    ]
    .into_iter()
    .enumerate()
    {
        let request = request_with_user_turns(vec![user_turn(
            &format!("direct-authority-user-{index}"),
            utterance,
        )]);
        let action = cascade_action(&handler, &request, "direct-authority-run")
            .await
            .expect(utterance);
        assert_eq!(action.action, expected_action);
    }
}

#[test]
fn mention_only_location_text_never_enters_restricted_location_routing() {
    for utterance in [
        "\"coffee near me\"",
        "do not find coffee near me",
        "What happens if I say \"find coffee near me\"?",
    ] {
        let mut request = request_with_user_turns(vec![user_turn("location-user", utterance)]);
        request.device_context.as_mut().unwrap().is_locked = true;
        assert_eq!(
            restricted_location_request_kind(&request),
            None,
            "mention-only text entered restricted location routing: {utterance}"
        );
    }
}

#[test]
fn locked_previous_clock_setting_does_not_gate_restored_clock_actions() {
    let previous_gate = crate::feature_flags::settings_global_feature_gate_spec(
        settings_global_feature_flags::CLOCK_ENABLED,
    )
    .expect("the exact installed Settings.Global key must stay registered");
    assert!(!previous_gate.default);
    assert!(!previous_gate.writable);

    for (utterance, expected_action) in [
        ("set a timer for five minutes", native_actions::TIMER),
        ("show my alarms", native_actions::ALARM),
        ("what time is it in New York?", native_actions::WORLD_CLOCK),
    ] {
        let planned = plan_clock_family_action(&SynapseUnderstandingRequest {
            utterance: utterance.to_string(),
            ..Default::default()
        })
        .expect("Penumbra's restored clock path is independent of the inert legacy key");
        assert_eq!(planned.action_name, expected_action);
    }
}

#[test]
fn clock_family_entry_preserves_stock_schema_keyguard_and_exclusions() {
    for (utterance, action, field, value, nested) in [
        (
            "set a timer for five minutes",
            native_actions::TIMER,
            "Request",
            "set a timer for five minutes",
            native_actions::SET_TIMER,
        ),
        (
            "show my alarms",
            native_actions::ALARM,
            "Request",
            "show my alarms",
            native_actions::DISPLAY_ALARM,
        ),
        (
            "what time is it in New York?",
            native_actions::WORLD_CLOCK,
            "Location",
            "new york",
            native_actions::WORLD_CLOCK,
        ),
    ] {
        let mut request = SynapseUnderstandingRequest {
            utterance: utterance.to_string(),
            device_context: Some(SynapseDeviceContext {
                is_locked: true,
                ..Default::default()
            }),
            ..Default::default()
        };
        let planned = plan_clock_family_action(&request).expect(utterance);
        assert_eq!(planned.action_name, action);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&planned.input_json).unwrap(),
            serde_json::json!({(field): value})
        );

        request.excluded_tools.push(action.to_ascii_lowercase());
        assert!(plan_clock_family_action(&request).is_none());
        request.excluded_tools.clear();
        request.excluded_tools.push(nested.to_ascii_lowercase());
        assert!(plan_clock_family_action(&request).is_none());
    }

    let mut cancellation = SynapseUnderstandingRequest {
        utterance: "cancel my 7 am alarm".to_string(),
        excluded_tools: vec![native_actions::CANCEL_ALARM.to_string()],
        ..Default::default()
    };
    assert!(
        plan_clock_family_action(&cancellation).is_none(),
        "the top-level Alarm entry must preserve the linked continuation exclusion"
    );
    cancellation.excluded_tools = vec![native_actions::DISPLAY_ALARM.to_string()];
    assert!(plan_clock_family_action(&cancellation).is_none());
}

#[test]
fn clock_family_entry_rejects_compounds_and_unsupported_requests() {
    for utterance in [
        "set a timer for five minutes and play music",
        "how do I set a timer?",
        "what time is it in Tokyo and London",
        "set an alarm for 29:99",
    ] {
        assert!(
            plan_clock_family_action(&SynapseUnderstandingRequest {
                utterance: utterance.to_string(),
                ..Default::default()
            })
            .is_none(),
            "unexpected clock action for {utterance}"
        );
    }
}

/// The durable activity row must contain what the action actually did, not just
/// its name — otherwise a follow-up like "play that one again" has nothing to
/// resolve against (experience-roadmap item 5).
#[test]
fn action_activity_outcome_records_the_arguments_not_only_the_name() {
    let outcome = action_activity_outcome(
        native_actions::PLAY_MUSIC,
        &serde_json::json!({"Title": "Purple Rain", "Artist": "Prince"}).to_string(),
    );
    assert!(
        outcome.contains("Purple Rain") && outcome.contains("Prince"),
        "the played track must survive into the durable record, got {outcome:?}",
    );
}

/// REGRESSION GUARD: `platform/deploy/acceptance/pin/physical-prompt-harness.mjs`,
/// `platform/deploy/acceptance/pin/speech-physical-smoke.mjs` and
/// `platform/deploy/acceptance/pin/session-continuity-physical-smoke.mjs` all classify a stored row with
/// `!response.startsWith("Action:")` — a row that fails this check is treated as
/// a *spoken answer*. Losing the prefix would silently reclassify every
/// dispatched action as speech in all three harnesses at once, and each would
/// still report green.
#[test]
fn action_activity_outcome_keeps_the_prefix_every_physical_harness_parses() {
    for (action, input) in [
        (native_actions::PLAY_MUSIC, r#"{"Title":"Purple Rain"}"#),
        (native_actions::GET_BATTERY_LEVEL, "{}"),
        (native_actions::GET_CURRENT_LOCATION, ""),
        (
            native_actions::SET_TIMER,
            r#"{"Duration":5,"Unit":"minutes"}"#,
        ),
    ] {
        let outcome = action_activity_outcome(action, input);
        assert!(
            outcome.starts_with("Action:"),
            "every harness filter depends on this prefix, got {outcome:?}",
        );
        assert!(
            outcome.contains(action),
            "the action name must remain readable, got {outcome:?}",
        );
    }
}

/// An argument-free action must not grow a noisy `{}` tail: its stored text is
/// unchanged from before this feature, so existing rows and new ones agree.
#[test]
fn argument_free_actions_keep_their_previous_exact_text() {
    for empty in ["", "  ", "{}", "null"] {
        assert_eq!(
            action_activity_outcome(native_actions::AM_I_ONLINE, empty),
            format!("Action: {}", native_actions::AM_I_ONLINE),
            "empty input {empty:?} must not add a tail",
        );
    }
}

/// `observed`: the content-free Tier-A interface manifest classifies one native
/// action and two server-side tool names. The underlying source material remains
/// in the immutable external evidence baseline and is not stored in this tree.
///
/// This test pins the client boundary: native actions must have a native catalog
/// entry, while server-side tools must never acquire one.
#[test]
fn tier_a_action_classes_match_native_catalog_boundary() {
    let raw = include_str!("../../../../../../contracts/fixtures/tier-a-action-classes.json");
    let manifest: serde_json::Value =
        serde_json::from_str(raw).expect("Tier-A action-class manifest parses");
    assert_eq!(manifest["schema_version"], 1);
    assert_eq!(manifest["provenance"], "clean-room-interface");
    assert_eq!(manifest["evidence"], "observed");

    let actions = manifest["actions"].as_array().expect("actions array");
    assert_eq!(actions.len(), 3, "Tier-A action-class manifest changed");

    let mut names = Vec::new();
    let mut device_actions = Vec::new();
    let mut server_tools = Vec::new();

    for action in actions {
        let name = action["name"].as_str().expect("action name");
        assert_eq!(
            action["turn_source"], "SERVER",
            "action {name}: turn source"
        );
        assert_eq!(action["evidence"], "observed", "action {name}: evidence");
        names.push(name);

        match action["kind"].as_str().expect("action kind") {
            "device_action" => device_actions.push(name),
            "server_tool" => server_tools.push(name),
            kind => panic!("action {name}: unsupported interface kind {kind}"),
        }
    }

    names.sort_unstable();
    assert_eq!(names, ["Creation", "HumaneSupport", "Respond"]);
    assert_eq!(device_actions, [native_actions::RESPOND]);
    assert_eq!(server_tools.len(), 2);

    for action in device_actions {
        assert!(
            crate::synapse::catalog::native_action_spec(action).is_some(),
            "device action {action} must have a native catalog entry"
        );
    }

    for tool in server_tools {
        assert!(
            crate::synapse::catalog::native_action_spec(tool).is_none(),
            "server tool {tool} must not have a native catalog entry"
        );
    }
}
