use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::{Config, ResolvedConfig};
use crate::db::Database;
use crate::llm::{LlmAgent, LlmRequestLogger};
use crate::nearby::NearbyClient;
use crate::proto::aibus::{
    ai_bus_service_client::AiBusServiceClient, ai_bus_service_server::AiBusServiceServer,
    streaming_understand_request, streaming_understand_response, Run, Runs, SynapseActionContent,
    SynapseObservationContent,
};
use crate::services::aibus::{AiBus, AiBusExternalClients};
use crate::storage::MediaStore;
use crate::tier_a::native_actions::{GET_CURRENT_LOCATION, PLAY_MUSIC, RESPOND};
use prost::Message as _;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex, RwLock};
use tonic::transport::Server;

struct CancellationProbe(Arc<AtomicBool>);

impl Drop for CancellationProbe {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn turn(identifier: &str) -> SynapseChatTurn {
    SynapseChatTurn {
        identifier: identifier.into(),
        ..Default::default()
    }
}

fn user_request(identifier: &str, utterance: &str) -> SynapseChatTurn {
    SynapseChatTurn {
        user: crate::proto::aibus::SynapseUser::User as i32,
        identifier: identifier.into(),
        content: Some(synapse_chat_turn::Content::UserRequest(
            crate::proto::aibus::SynapseUserRequestContent {
                request: utterance.into(),
                ..Default::default()
            },
        )),
        ..Default::default()
    }
}

fn action_response(identifier: &str) -> SynapseUnderstandingResponse {
    SynapseUnderstandingResponse {
        body: Some(synapse_understanding_response::Body::Turn(
            SynapseChatTurn {
                identifier: identifier.into(),
                content: Some(synapse_chat_turn::Content::Action(
                    SynapseActionContent::default(),
                )),
                ..Default::default()
            },
        )),
        ..Default::default()
    }
}

/// A server observation frame, the second half of each streamed cue pair.
fn observation_frame(identifier: &str) -> SynapseUnderstandingResponse {
    SynapseUnderstandingResponse {
        body: Some(synapse_understanding_response::Body::Turn(
            SynapseChatTurn {
                identifier: identifier.into(),
                content: Some(synapse_chat_turn::Content::Observation(
                    SynapseObservationContent {
                        observation: r#"{"status":"ok"}"#.into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
        )),
        ..Default::default()
    }
}

fn named_observation_response(
    identifier: &str,
    parent_identifier: &str,
) -> SynapseUnderstandingResponse {
    SynapseUnderstandingResponse {
        body: Some(synapse_understanding_response::Body::Turn(
            SynapseChatTurn {
                user: crate::proto::aibus::SynapseUser::Assistant as i32,
                identifier: identifier.into(),
                parent_identifier: parent_identifier.into(),
                content: Some(synapse_chat_turn::Content::Observation(
                    SynapseObservationContent {
                        observation: r#"{"status":"pending"}"#.into(),
                        source: crate::proto::aibus::SynapseSource::Server as i32,
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
        )),
        ..Default::default()
    }
}

/// The close-sentinel `understand_inner` emits when a cue-bearing run ends
/// with no dispatchable terminal: `is_final`, no turn body.
fn close_sentinel() -> SynapseUnderstandingResponse {
    SynapseUnderstandingResponse {
        is_final: true,
        ..Default::default()
    }
}

fn named_action_response(
    identifier: &str,
    action_name: &str,
    parent_identifier: &str,
) -> SynapseUnderstandingResponse {
    SynapseUnderstandingResponse {
        body: Some(synapse_understanding_response::Body::Turn(
            SynapseChatTurn {
                user: crate::proto::aibus::SynapseUser::Assistant as i32,
                identifier: identifier.into(),
                parent_identifier: parent_identifier.into(),
                content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                    action: action_name.into(),
                    source: crate::proto::aibus::SynapseSource::Server as i32,
                    ..Default::default()
                })),
                ..Default::default()
            },
        )),
        ..Default::default()
    }
}

fn observation(identifier: &str, is_final: bool) -> SynapseChatTurn {
    SynapseChatTurn {
        identifier: identifier.into(),
        content: Some(synapse_chat_turn::Content::Observation(
            SynapseObservationContent {
                is_final,
                ..Default::default()
            },
        )),
        ..Default::default()
    }
}

async fn spawn_test_aibus() -> (std::net::SocketAddr, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let mut config = Config::load(&directory.path().join("missing.toml")).unwrap();
    config.llm.memory.enabled = false;
    let shared_config = Arc::new(RwLock::new(config.clone()));
    let resolved = Arc::new(ResolvedConfig::resolve(config));
    let http = reqwest::Client::new();
    let agent = Arc::new(
        LlmAgent::from_config(
            resolved.as_ref(),
            http.clone(),
            LlmRequestLogger::new(directory.path().join("logs")),
            None,
        )
        .await
        .unwrap(),
    );
    let db = Database::open(directory.path().join("test.sqlite")).unwrap();
    let store = Arc::new(Mutex::new(
        MediaStore::open(directory.path().join("media"), db.clone())
            .await
            .unwrap(),
    ));
    let (events_tx, _) = broadcast::channel(8);
    let service = AiBus::new_with_external_clients(
        agent,
        resolved.clone(),
        shared_config,
        NearbyClient::new(http.clone(), resolved.openstreetmap_options.clone()),
        http.clone(),
        db,
        None,
        store,
        events_tx,
        AiBusExternalClients::disabled(http),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let incoming = async_stream::stream! {
        loop {
            match listener.accept().await {
                Ok((socket, _)) => yield Ok::<_, std::io::Error>(socket),
                Err(error) => {
                    yield Err(error);
                    break;
                }
            }
        }
    };
    tokio::spawn(async move {
        Server::builder()
            .add_service(AiBusServiceServer::new(service))
            .serve_with_incoming(incoming)
            .await
            .unwrap();
    });
    (address, directory)
}

#[test]
fn stock_streaming_wire_field_numbers_are_stable() {
    let initial = StreamingUnderstandRequest {
        content: Some(streaming_understand_request::Content::InitialRunState(
            RunState::default(),
        )),
    }
    .encode_to_vec();
    let observation = StreamingUnderstandRequest {
        content: Some(streaming_understand_request::Content::Observation(
            SynapseChatTurn::default(),
        )),
    }
    .encode_to_vec();
    let understanding = StreamingUnderstandRequest {
        content: Some(streaming_understand_request::Content::UnderstandingRequest(
            Box::<SynapseUnderstandingRequest>::default(),
        )),
    }
    .encode_to_vec();
    let response = StreamingUnderstandResponse {
        content: Some(streaming_understand_response::Content::IntermediateEvent(
            IntermediateEvent::default(),
        )),
    }
    .encode_to_vec();

    assert_eq!(initial.first(), Some(&0x0a));
    assert_eq!(observation.first(), Some(&0x12));
    assert_eq!(understanding.first(), Some(&0x1a));
    assert_eq!(response.first(), Some(&0x0a));
}

#[tokio::test]
async fn live_forward_marks_only_the_last_turn_as_dispatchable() {
    // The one-frame lookahead: interim turns forward with
    // requires_response=false as produced; only the terminal is the
    // dispatchable delimiter.
    let mut state = StreamingSessionState::default();
    let (tx, rx) = mpsc::channel(4);
    let mut output = DeadlineGatedResponseStream::new(rx);
    let stream = Box::pin(tokio_stream::iter(vec![
        Ok(action_response("one")),
        Ok(action_response("two")),
    ]));
    let control = stream_understanding_turn(
        &mut state,
        &SynapseUnderstandingRequest::default(),
        "run",
        &tx,
        tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
        stream,
    )
    .await
    .unwrap();
    assert_eq!(control, TurnControl::Continue);
    drop(tx);

    let mut requires_response = Vec::new();
    while let Some(item) = output.next().await {
        match item.unwrap().content.unwrap() {
            streaming_understand_response::Content::IntermediateEvent(event) => {
                requires_response.push(event.requires_response)
            }
            streaming_understand_response::Content::Interstitial(_) => {
                panic!("understanding turns must forward as intermediate events")
            }
        }
    }
    assert_eq!(requires_response, vec![false, true]);
}

#[test]
fn response_event_budget_covers_the_53_frame_structural_maximum() {
    // At the configured ceiling the loop can run twelve model steps, and
    // the one-shot verification nudge can add one more. Every one of those
    // thirteen steps may fire the slow-step action/observation pair. The
    // final step is tool-free, leaving at most twelve tool-batch pairs.
    // Add the early-cue pair and one terminal action: 26 + 24 + 2 + 1 = 53.
    const CONFIGURED_MODEL_STEPS: usize = 12;
    const NUDGE_EXTRA_MODEL_STEPS: usize = 1;
    const FRAMES_PER_SLOW_STEP: usize = 2;
    const MAX_TOOL_BATCHES: usize = 12;
    const FRAMES_PER_TOOL_BATCH: usize = 2;
    const EARLY_CUE_FRAMES: usize = 2;
    const TERMINAL_FRAMES: usize = 1;
    let maximum_model_steps = CONFIGURED_MODEL_STEPS + NUDGE_EXTRA_MODEL_STEPS;
    let structural_maximum = maximum_model_steps * FRAMES_PER_SLOW_STEP
        + MAX_TOOL_BATCHES * FRAMES_PER_TOOL_BATCH
        + EARLY_CUE_FRAMES
        + TERMINAL_FRAMES;
    assert_eq!(structural_maximum, 53);
    assert!(
        structural_maximum <= MAX_RESPONSE_EVENTS,
        "a legal run streams {structural_maximum} response events, which must fit under \
         MAX_RESPONSE_EVENTS={MAX_RESPONSE_EVENTS}"
    );
}

#[tokio::test]
async fn response_event_budget_forwards_the_full_53_frame_structure() {
    let mut frames = Vec::new();
    for index in 0..26 {
        frames.push(Ok(action_response(&format!("structural-action-{index}"))));
        frames.push(Ok(observation_frame(&format!(
            "structural-observation-{index}"
        ))));
    }
    frames.push(Ok(named_action_response(
        "structural-terminal",
        RESPOND,
        "structural-observation-25",
    )));
    assert_eq!(frames.len(), 53);

    let mut state = StreamingSessionState::default();
    let (tx, mut rx) = mpsc::channel(64);
    let control = stream_understanding_turn(
        &mut state,
        &SynapseUnderstandingRequest::default(),
        "structural-run",
        &tx,
        tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
        Box::pin(tokio_stream::iter(frames)),
    )
    .await
    .expect("the structurally legal run must fit within the response-event budget");
    assert_eq!(control, TurnControl::Continue);
    drop(tx);

    let mut delivered = Vec::new();
    while let Some(frame) = rx.recv().await {
        delivered.push(frame.unwrap());
    }
    assert_eq!(delivered.len(), 53);
    let terminal = delivered.last().unwrap().content.as_ref().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(terminal) = terminal else {
        panic!("expected terminal intermediate event");
    };
    assert!(terminal.requires_response);
}

#[tokio::test]
async fn response_event_budget_rejects_only_the_65th_frame() {
    let frames = (0..65)
        .map(|index| Ok(action_response(&format!("bounded-action-{index}"))))
        .collect::<Vec<_>>();
    let mut state = StreamingSessionState::default();
    let (tx, rx) = mpsc::channel(64);
    let status = stream_understanding_turn(
        &mut state,
        &SynapseUnderstandingRequest::default(),
        "bounded-run",
        &tx,
        tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
        Box::pin(tokio_stream::iter(frames)),
    )
    .await
    .unwrap_err();
    assert_eq!(status.code(), tonic::Code::ResourceExhausted);
    assert_eq!(rx.len(), 64, "the first 64 events remain within budget");
}

#[tokio::test]
async fn a_full_multi_tool_run_forwards_every_cue_and_exactly_one_terminal() {
    // The realistic multi-tool frame sequence a two-batch run produces:
    // action, observation, action, observation, then the terminal Respond.
    // Every cue turn must forward as interim; exactly the terminal may carry
    // requires_response, or stock would dispatch a progress cue as the answer.
    let mut state = StreamingSessionState::default();
    let (tx, mut rx) = mpsc::channel(16);
    let stream = Box::pin(tokio_stream::iter(vec![
        Ok(action_response("cue-action-1")),
        Ok(observation_frame("cue-observation-1")),
        Ok(action_response("cue-action-2")),
        Ok(observation_frame("cue-observation-2")),
        Ok(named_action_response(
            "terminal",
            RESPOND,
            "cue-observation-2",
        )),
    ]));

    let control = stream_understanding_turn(
        &mut state,
        &SynapseUnderstandingRequest::default(),
        "run",
        &tx,
        tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
        stream,
    )
    .await
    .unwrap();
    assert_eq!(control, TurnControl::Continue);
    drop(tx);

    let mut delivered = Vec::new();
    while let Some(item) = rx.recv().await {
        match item.unwrap().content.unwrap() {
            streaming_understand_response::Content::IntermediateEvent(event) => {
                delivered.push((event.event.unwrap().identifier, event.requires_response));
            }
            streaming_understand_response::Content::Interstitial(_) => {
                panic!("understanding turns must forward as intermediate events")
            }
        }
    }
    assert_eq!(
        delivered,
        vec![
            ("cue-action-1".to_string(), false),
            ("cue-observation-1".to_string(), false),
            ("cue-action-2".to_string(), false),
            ("cue-observation-2".to_string(), false),
            ("terminal".to_string(), true),
        ],
        "every cue forwards in order as interim; only the terminal dispatches"
    );
    assert_eq!(
        delivered.iter().filter(|(_, req)| *req).count(),
        1,
        "exactly one dispatchable delimiter per run"
    );
}

#[tokio::test]
async fn trailing_cue_is_not_promoted_to_terminal_on_an_empty_run() {
    // A cue-bearing run that produced no dispatchable terminal (an excluded
    // native action, or a FinalAnswer while stock excluded `Respond`).
    // `understand_inner` emits the close-sentinel; without it the plain
    // lookahead would promote `cue-two` to `requires_response = true` and
    // stock would dispatch a progress cue as the answer.
    let mut state = StreamingSessionState::default();
    let (tx, mut rx) = mpsc::channel(4);
    let stream = Box::pin(tokio_stream::iter(vec![
        Ok(action_response("cue-one")),
        Ok(action_response("cue-two")),
        Ok(close_sentinel()),
    ]));
    let control = stream_understanding_turn(
        &mut state,
        &SynapseUnderstandingRequest::default(),
        "run",
        &tx,
        tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
        stream,
    )
    .await
    .unwrap();
    assert_eq!(
        control,
        TurnControl::Close,
        "an empty run must close, not promote a cue to the terminal"
    );
    drop(tx);

    let mut promoted = false;
    while let Some(item) = rx.recv().await {
        if let streaming_understand_response::Content::IntermediateEvent(event) =
            item.unwrap().content.unwrap()
        {
            promoted |= event.requires_response;
        }
    }
    assert!(
        !promoted,
        "no progress cue may become the dispatchable terminal"
    );
}

#[tokio::test]
async fn live_forward_delivers_an_interim_frame_before_the_terminal() {
    // The whole point of Stage 1: interim turns reach the stock client as
    // produced, not materialized at stream end. The one-frame lookahead
    // emits a held interim as soon as the NEXT frame arrives, so an interim
    // must be observable before the terminal is even sent. A buffer-then-emit
    // regression (drain the whole stream, then emit) would deliver nothing
    // until the terminal and fail the bounded wait below.
    let mut state = StreamingSessionState::default();
    let (out_tx, mut out_rx) = mpsc::channel(8);
    let (feed_tx, feed_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<SynapseUnderstandingResponse, Status>>();
    let stream = Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(
        feed_rx,
    ));
    let task = tokio::spawn(async move {
        stream_understanding_turn(
            &mut state,
            &SynapseUnderstandingRequest::default(),
            "live-run",
            &out_tx,
            tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
            stream,
        )
        .await
    });

    // Two interim turns with the stream still open: the lookahead emits the
    // first when the second arrives, before any terminal exists.
    feed_tx.send(Ok(action_response("interim-one"))).unwrap();
    feed_tx.send(Ok(action_response("interim-two"))).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(1), out_rx.recv())
        .await
        .expect("an interim frame must forward before the terminal is sent")
        .unwrap()
        .unwrap();
    let first_event = match first.content.unwrap() {
        streaming_understand_response::Content::IntermediateEvent(event) => event,
        streaming_understand_response::Content::Interstitial(_) => {
            panic!("expected an intermediate event")
        }
    };
    assert!(
        !first_event.requires_response,
        "an interim frame must not be marked as the dispatchable terminal"
    );
    assert_eq!(first_event.event.unwrap().identifier, "interim-one");

    // Close the run with the real terminal (the last turn of the stream).
    feed_tx.send(Ok(action_response("terminal"))).unwrap();
    drop(feed_tx);
    assert_eq!(task.await.unwrap().unwrap(), TurnControl::Continue);

    let mut remaining = Vec::new();
    while let Some(item) = out_rx.recv().await {
        if let streaming_understand_response::Content::IntermediateEvent(event) =
            item.unwrap().content.unwrap()
        {
            remaining.push(event.requires_response);
        }
    }
    // interim-two (false) then the terminal (true).
    assert_eq!(remaining, vec![false, true]);
}

#[test]
fn initial_run_state_is_prepended_once_and_deduplicated() {
    let mut state = StreamingSessionState::default();
    let mut agent_to_runs = std::collections::HashMap::new();
    agent_to_runs.insert(
        "supervisor".into(),
        Runs {
            runs: vec![Run {
                events: vec![turn("resumed"), turn("current")],
            }],
        },
    );
    state
        .accept(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::InitialRunState(
                RunState { agent_to_runs },
            )),
        })
        .unwrap();

    let request = SynapseUnderstandingRequest {
        device_context: Some(SynapseDeviceContext {
            turns: vec![turn("current")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let InputAction::Understand(request) = state
        .accept(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::UnderstandingRequest(
                Box::new(request),
            )),
        })
        .unwrap()
    else {
        panic!("expected understanding request");
    };
    let identifiers = request
        .device_context
        .unwrap()
        .turns
        .into_iter()
        .map(|turn| turn.identifier)
        .collect::<Vec<_>>();
    assert_eq!(identifiers, vec!["resumed", "current"]);
    assert!(state.initial_run_state.is_none());
}

#[test]
fn non_final_observation_continues_but_final_observation_closes() {
    let mut state = StreamingSessionState::default();
    state
        .accept(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::UnderstandingRequest(
                Box::<SynapseUnderstandingRequest>::default(),
            )),
        })
        .unwrap();

    let continuation = state
        .accept(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::Observation(
                observation("working", false),
            )),
        })
        .unwrap();
    assert!(matches!(continuation, InputAction::Understand(_)));

    let completion = state
        .accept(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::Observation(
                observation("done", true),
            )),
        })
        .unwrap();
    assert!(matches!(completion, InputAction::Close));
}

#[test]
fn message_budget_requires_an_actual_65th_message_before_failing() {
    let mut accepted = 0usize;
    for index in 0..MAX_STREAM_MESSAGES {
        let message = accept_session_message_within_limit(Some(index), &mut accepted)
            .unwrap_or_else(|status| panic!("message {index} failed early: {status}"));
        assert_eq!(message, Some(index));
    }
    assert_eq!(accepted, MAX_STREAM_MESSAGES);

    assert_eq!(
        accept_session_message_within_limit::<usize>(None, &mut accepted).unwrap(),
        None,
        "EOF after exactly 64 messages must remain a clean completion"
    );
    let status = accept_session_message_within_limit(Some(64usize), &mut accepted)
        .expect_err("only an actual 65th message crosses the cap");
    assert_eq!(status.code(), tonic::Code::ResourceExhausted);
    assert_eq!(accepted, MAX_STREAM_MESSAGES);
}

#[test]
fn orphaned_observation_never_waits_and_carries_the_turn() {
    // The streaming-timeout poison: a bidi session that only ever carries an
    // observation (the terminal narration-completed re-entry) must resolve
    // the stock client at once. `accept` must therefore NEVER return `Wait`
    // here — that is the branch that used to block on the next message while
    // stock's untimed `responseFuture.get()` hung to the ~60s ceiling.
    for is_final in [false, true] {
        let mut state = StreamingSessionState::default();
        let action = state
            .accept(StreamingUnderstandRequest {
                content: Some(streaming_understand_request::Content::Observation(
                    observation("orphan", is_final),
                )),
            })
            .unwrap();
        let InputAction::OrphanedObservation(turn) = action else {
            panic!("orphaned observation must not Wait; got a non-close action");
        };
        // The turn is carried so a Stage-2 staged-resume claim can be matched
        // against it before the session closes.
        assert_eq!(turn.identifier, "orphan");
        // No plan is retained: the session closes rather than accumulating
        // state for a request that never arrives.
        assert!(state.request.is_none());
    }
}

#[test]
fn observation_before_request_does_not_establish_a_plan() {
    // Removing the pre-request buffering means an observation seen before any
    // understanding request no longer mutates session state; it is handled as
    // an orphaned observation and does not linger to be folded into a later
    // request. (Stock never sends this ordering in the live flow.)
    let mut state = StreamingSessionState::default();
    let action = state
        .accept(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::Observation(
                observation("early", false),
            )),
        })
        .unwrap();
    assert!(matches!(action, InputAction::OrphanedObservation(_)));
    assert!(state.request.is_none());
    assert!(state.initial_run_state.is_none());
}

#[test]
fn stock_turn_deadline_leaves_transport_margin_before_hooked_ironman_timeout() {
    assert_eq!(STOCK_TURN_DEADLINE, Duration::from_secs(80));
    assert_eq!(HOOKED_IRONMAN_TIMEOUT, Duration::from_secs(90));
    assert!(STOCK_TURN_DEADLINE < HOOKED_IRONMAN_TIMEOUT);
}

#[tokio::test]
async fn spawned_session_panic_is_forwarded_as_sanitized_internal_error() {
    let (tx, mut rx) = mpsc::channel(1);
    let _supervisor = spawn_streaming_session_task(tx, async move {
        if std::hint::black_box(true) {
            panic!("synthetic private panic payload");
        }
        Ok(())
    });

    let status = rx
        .recv()
        .await
        .expect("a panicked session must emit an error instead of clean EOF")
        .unwrap_err();
    assert_eq!(status.code(), tonic::Code::Internal);
    assert_eq!(status.message(), "bidirectional understand session failed");
    assert!(!status.message().contains("synthetic private panic payload"));
    assert!(rx.recv().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn expired_deadline_wins_over_an_already_ready_terminal_action() {
    let request = SynapseUnderstandingRequest {
        utterance: "play the late song".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("deadline-user", "play the late song")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut state = StreamingSessionState::default();
    let (tx, mut rx) = mpsc::channel(2);
    let deadline_at = tokio::time::Instant::now();
    tokio::time::advance(Duration::from_secs(1)).await;
    let control = stream_understanding_turn(
        &mut state,
        &request,
        "deadline-run",
        &tx,
        deadline_at,
        Box::pin(tokio_stream::iter(vec![Ok(named_action_response(
            "late-native-action",
            PLAY_MUSIC,
            "deadline-user",
        ))])),
    )
    .await
    .unwrap();
    assert_eq!(control, TurnControl::Close);
    drop(tx);

    let response = rx.recv().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(event) =
        response.content.unwrap()
    else {
        panic!("expected timeout fallback event");
    };
    assert!(event.requires_response);
    let synapse_chat_turn::Content::Action(action) = event.event.unwrap().content.unwrap() else {
        panic!("expected timeout Respond action");
    };
    assert_eq!(action.action, RESPOND);
    assert!(rx.recv().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn queued_play_music_is_replaced_when_first_polled_after_its_deadline() {
    let request = SynapseUnderstandingRequest {
        utterance: "play the late song".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("queued-user", "play the late song")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let deadline = Duration::from_secs(5);
    let deadline_at = tokio::time::Instant::now() + deadline;
    let (tx, rx) = mpsc::channel(3);
    let mut state = StreamingSessionState::default();

    let control = stream_understanding_turn(
        &mut state,
        &request,
        "queued-run",
        &tx,
        deadline_at,
        Box::pin(tokio_stream::iter(vec![
            Ok(named_action_response(
                "queued-interim",
                "knowledge_lookup",
                "queued-user",
            )),
            Ok(named_action_response(
                "queued-play-music",
                PLAY_MUSIC,
                "queued-interim",
            )),
        ])),
    )
    .await
    .unwrap();
    assert_eq!(control, TurnControl::Continue);
    assert_eq!(
        tx.capacity(),
        1,
        "the interim and terminal must both be queued for delivery"
    );

    let mut output = DeadlineGatedResponseStream::new(rx);
    tokio::time::advance(deadline).await;
    let response = output
        .next()
        .await
        .expect("an expired terminal should produce a safe timeout outcome")
        .unwrap();
    let streaming_understand_response::Content::IntermediateEvent(event) =
        response.content.unwrap()
    else {
        panic!("expected timeout fallback event");
    };
    assert!(event.requires_response);
    let turn = event.event.unwrap();
    assert_eq!(turn.parent_identifier, "queued-user");
    let synapse_chat_turn::Content::Action(action) = turn.content.unwrap() else {
        panic!("expected timeout fallback action");
    };
    assert_eq!(action.action, RESPOND);
    assert_ne!(action.action, PLAY_MUSIC);
    assert!(
        output.next().await.is_none(),
        "the stale terminal must close its bidi session"
    );
    assert!(tx.is_closed());
}

#[tokio::test(start_paused = true)]
async fn expired_terminal_fallback_parents_to_the_last_actually_delivered_interim() {
    let request = SynapseUnderstandingRequest {
        utterance: "play the slow song".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("partial-user", "play the slow song")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let deadline = Duration::from_secs(5);
    let (tx, rx) = mpsc::channel(3);
    let mut state = StreamingSessionState::default();
    stream_understanding_turn(
        &mut state,
        &request,
        "partial-delivery-run",
        &tx,
        tokio::time::Instant::now() + deadline,
        Box::pin(tokio_stream::iter(vec![
            Ok(named_action_response(
                "delivered-interim",
                "knowledge_lookup",
                "partial-user",
            )),
            Ok(named_action_response(
                "queued-terminal",
                PLAY_MUSIC,
                "delivered-interim",
            )),
        ])),
    )
    .await
    .unwrap();

    let mut output = DeadlineGatedResponseStream::new(rx);
    let interim = output.next().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(interim) =
        interim.content.unwrap()
    else {
        panic!("expected interim event");
    };
    assert!(!interim.requires_response);
    assert_eq!(interim.event.unwrap().identifier, "delivered-interim");

    tokio::time::advance(deadline).await;
    let fallback = output.next().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(fallback) =
        fallback.content.unwrap()
    else {
        panic!("expected timeout fallback event");
    };
    let fallback_turn = fallback.event.unwrap();
    assert!(fallback.requires_response);
    assert_eq!(fallback_turn.parent_identifier, "delivered-interim");
    assert_ne!(fallback_turn.parent_identifier, "queued-terminal");
    let synapse_chat_turn::Content::Action(action) = fallback_turn.content.unwrap() else {
        panic!("expected timeout fallback action");
    };
    assert_eq!(action.action, RESPOND);
    assert!(output.next().await.is_none());
    assert!(tx.is_closed());
}

#[tokio::test(start_paused = true)]
async fn delivery_gate_uses_each_turn_deadline_across_one_bidi_session() {
    let first_request = SynapseUnderstandingRequest {
        utterance: "play the first song".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("first-user", "play the first song")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let second_request = SynapseUnderstandingRequest {
        utterance: "play the second song".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("second-user", "play the second song")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let (tx, rx) = mpsc::channel(4);
    let mut output = DeadlineGatedResponseStream::new(rx);
    let mut state = StreamingSessionState::default();

    stream_understanding_turn(
        &mut state,
        &first_request,
        "multi-turn-run",
        &tx,
        tokio::time::Instant::now() + Duration::from_secs(5),
        Box::pin(tokio_stream::iter(vec![Ok(named_action_response(
            "first-terminal",
            PLAY_MUSIC,
            "first-user",
        ))])),
    )
    .await
    .unwrap();
    let first = output.next().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(first) = first.content.unwrap()
    else {
        panic!("expected first terminal event");
    };
    let synapse_chat_turn::Content::Action(first_action) = first.event.unwrap().content.unwrap()
    else {
        panic!("expected first native action");
    };
    assert_eq!(first_action.action, PLAY_MUSIC);
    assert!(!tx.is_closed());

    let second_deadline = Duration::from_secs(10);
    stream_understanding_turn(
        &mut state,
        &second_request,
        "multi-turn-run",
        &tx,
        tokio::time::Instant::now() + second_deadline,
        Box::pin(tokio_stream::iter(vec![Ok(named_action_response(
            "second-terminal",
            PLAY_MUSIC,
            "second-user",
        ))])),
    )
    .await
    .unwrap();
    tokio::time::advance(second_deadline).await;
    let second = output.next().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(second) = second.content.unwrap()
    else {
        panic!("expected second timeout fallback");
    };
    let second_turn = second.event.unwrap();
    assert_eq!(second_turn.parent_identifier, "second-user");
    let synapse_chat_turn::Content::Action(second_action) = second_turn.content.unwrap() else {
        panic!("expected second fallback action");
    };
    assert_eq!(second_action.action, RESPOND);
    assert!(output.next().await.is_none());
    assert!(tx.is_closed());
}

#[tokio::test(start_paused = true)]
async fn timeout_fallback_remains_deliverable_after_the_deadline_and_then_closes() {
    let request = SynapseUnderstandingRequest {
        utterance: "slow request".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("fallback-user", "slow request")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let (tx, rx) = mpsc::channel(1);
    assert_eq!(
        finish_timed_out_turn(&request, "fallback-run", &tx, 0, Some(0)).unwrap(),
        TurnControl::Close
    );
    drop(tx);

    let mut output = DeadlineGatedResponseStream::new(rx);
    tokio::time::advance(Duration::from_secs(60)).await;
    let response = output.next().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(event) =
        response.content.unwrap()
    else {
        panic!("expected timeout fallback event");
    };
    let synapse_chat_turn::Content::Action(action) = event.event.unwrap().content.unwrap() else {
        panic!("expected timeout fallback action");
    };
    assert_eq!(action.action, RESPOND);
    assert!(output.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn stale_terminal_closes_with_error_when_respond_is_excluded() {
    let request = SynapseUnderstandingRequest {
        utterance: "play the late song".into(),
        excluded_tools: vec![RESPOND.into()],
        ..Default::default()
    };
    let deadline = Duration::from_secs(5);
    let (tx, rx) = mpsc::channel(1);
    let mut state = StreamingSessionState::default();
    stream_understanding_turn(
        &mut state,
        &request,
        "excluded-delivery-run",
        &tx,
        tokio::time::Instant::now() + deadline,
        Box::pin(tokio_stream::iter(vec![Ok(named_action_response(
            "excluded-late-terminal",
            PLAY_MUSIC,
            "excluded-user",
        ))])),
    )
    .await
    .unwrap();

    let mut output = DeadlineGatedResponseStream::new(rx);
    tokio::time::advance(deadline).await;
    let status = output.next().await.unwrap().unwrap_err();
    assert_eq!(status.code(), tonic::Code::DeadlineExceeded);
    assert!(output.next().await.is_none());
    assert!(tx.is_closed());
}

#[tokio::test(start_paused = true)]
async fn timeout_fallback_uses_the_last_delivered_parent_not_the_held_turn() {
    let request = SynapseUnderstandingRequest {
        utterance: "do the slow thing".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("parent-user", "do the slow thing")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut state = StreamingSessionState::default();
    let InputAction::Understand(request) = state
        .accept(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::UnderstandingRequest(
                Box::new(request),
            )),
        })
        .unwrap()
    else {
        panic!("expected understanding request");
    };
    let (plain_tx, plain_rx) = mpsc::unbounded_channel();
    plain_tx
        .send(Ok(named_action_response(
            "cue-action",
            "knowledge_lookup",
            "parent-user",
        )))
        .unwrap();
    plain_tx
        .send(Ok(named_observation_response(
            "cue-observation",
            "cue-action",
        )))
        .unwrap();
    plain_tx
        .send(Ok(named_action_response(
            "held-late-action",
            "nearby_search",
            "cue-observation",
        )))
        .unwrap();

    let (tx, rx) = mpsc::channel(4);
    let mut output = DeadlineGatedResponseStream::new(rx);
    let deadline = Duration::from_secs(5);
    let task = tokio::spawn(async move {
        let control = stream_understanding_turn(
            &mut state,
            &request,
            "parent-run",
            &tx,
            tokio::time::Instant::now() + deadline,
            Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(
                plain_rx,
            )),
        )
        .await;
        drop(tx);
        control
    });

    for expected_id in ["cue-action", "cue-observation"] {
        let response = output.next().await.unwrap().unwrap();
        let streaming_understand_response::Content::IntermediateEvent(event) =
            response.content.unwrap()
        else {
            panic!("expected cue event");
        };
        assert!(!event.requires_response);
        assert_eq!(event.event.unwrap().identifier, expected_id);
    }

    tokio::time::advance(deadline).await;
    assert_eq!(task.await.unwrap().unwrap(), TurnControl::Close);
    let response = output.next().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(event) =
        response.content.unwrap()
    else {
        panic!("expected timeout fallback event");
    };
    let turn = event.event.unwrap();
    assert!(event.requires_response);
    assert_eq!(turn.parent_identifier, "cue-observation");
    assert_ne!(turn.parent_identifier, "held-late-action");
    drop(plain_tx);
    assert!(output.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn timeout_fallback_does_not_parent_to_an_unread_queued_interim() {
    let request = SynapseUnderstandingRequest {
        utterance: "do the unread slow thing".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("unread-user", "do the unread slow thing")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let (plain_tx, plain_rx) = mpsc::unbounded_channel();
    plain_tx
        .send(Ok(named_action_response(
            "unread-interim",
            "knowledge_lookup",
            "unread-user",
        )))
        .unwrap();
    plain_tx
        .send(Ok(named_action_response(
            "held-at-timeout",
            "nearby_search",
            "unread-interim",
        )))
        .unwrap();

    let deadline = Duration::from_secs(5);
    let (tx, rx) = mpsc::channel(2);
    let task = tokio::spawn(async move {
        let mut state = StreamingSessionState::default();
        let control = stream_understanding_turn(
            &mut state,
            &request,
            "unread-parent-run",
            &tx,
            tokio::time::Instant::now() + deadline,
            Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(
                plain_rx,
            )),
        )
        .await;
        drop(tx);
        control
    });

    tokio::task::yield_now().await;
    assert_eq!(rx.len(), 1, "the interim should be queued but unread");
    tokio::time::advance(deadline).await;
    assert_eq!(task.await.unwrap().unwrap(), TurnControl::Close);
    assert_eq!(
        rx.len(),
        2,
        "the safe fallback should fit behind the interim"
    );

    let mut output = DeadlineGatedResponseStream::new(rx);
    let fallback = output.next().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(fallback) =
        fallback.content.unwrap()
    else {
        panic!("expected timeout fallback event");
    };
    let fallback_turn = fallback.event.unwrap();
    assert_eq!(fallback_turn.parent_identifier, "unread-user");
    assert_ne!(fallback_turn.parent_identifier, "unread-interim");
    let synapse_chat_turn::Content::Action(action) = fallback_turn.content.unwrap() else {
        panic!("expected timeout fallback action");
    };
    assert_eq!(action.action, RESPOND);
    drop(plain_tx);
    assert!(output.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn full_output_channel_at_deadline_drops_a_late_terminal_and_closes() {
    let request = SynapseUnderstandingRequest {
        utterance: "play the late song".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("full-user", "play the late song")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let deadline = Duration::from_secs(5);
    let (tx, mut rx) = mpsc::channel(1);
    tx.try_send(QueuedStreamingResponse::unguarded(Ok(
        intermediate_event_response(turn("already-queued"), false),
    )))
    .unwrap();

    let task = tokio::spawn(async move {
        let mut state = StreamingSessionState::default();
        let result = stream_understanding_turn(
            &mut state,
            &request,
            "full-run",
            &tx,
            tokio::time::Instant::now() + deadline,
            Box::pin(tokio_stream::iter(vec![Ok(named_action_response(
                "late-terminal",
                PLAY_MUSIC,
                "full-user",
            ))])),
        )
        .await;
        drop(tx);
        result
    });

    tokio::task::yield_now().await;
    tokio::time::advance(deadline).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("a full response channel must not hold the turn past its deadline")
            .unwrap()
            .unwrap(),
        TurnControl::Close
    );

    let queued = rx.recv().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(queued) = queued.content.unwrap()
    else {
        panic!("expected the pre-existing queued event");
    };
    assert_eq!(queued.event.unwrap().identifier, "already-queued");
    assert!(!queued.requires_response);
    assert!(
        rx.recv().await.is_none(),
        "neither the late native action nor a blocking fallback may be queued after deadline"
    );
}

#[tokio::test]
async fn full_output_channel_drops_supervisor_error_instead_of_waiting_for_capacity() {
    let (tx, mut rx) = mpsc::channel(1);
    tx.try_send(QueuedStreamingResponse::unguarded(Ok(
        intermediate_event_response(turn("already-queued"), false),
    )))
    .unwrap();
    let supervisor = spawn_streaming_session_task(tx, async move {
        Err(Status::internal("synthetic session failure"))
    });
    tokio::time::timeout(Duration::from_secs(1), supervisor)
        .await
        .expect("supervisor reporting must not wait on a full response channel")
        .unwrap();

    let queued = rx.recv().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(queued) = queued.content.unwrap()
    else {
        panic!("expected the pre-existing queued event");
    };
    assert_eq!(queued.event.unwrap().identifier, "already-queued");
    assert!(
        tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("supervisor reporting must not wait on a full response channel")
            .is_none(),
        "a supervisor error observed only after capacity opens is already stale"
    );
}

#[tokio::test]
async fn full_output_channel_drops_supervisor_panic_status_and_closes_promptly() {
    let (tx, mut rx) = mpsc::channel(1);
    tx.try_send(QueuedStreamingResponse::unguarded(Ok(
        intermediate_event_response(turn("already-queued"), false),
    )))
    .unwrap();
    let supervisor = spawn_streaming_session_task(tx, async move {
        if std::hint::black_box(true) {
            panic!("synthetic private panic payload under backpressure");
        }
        Ok(())
    });
    tokio::time::timeout(Duration::from_secs(1), supervisor)
        .await
        .expect("panic supervision must not wait on a full response channel")
        .unwrap();

    let queued = rx.recv().await.unwrap().unwrap();
    let streaming_understand_response::Content::IntermediateEvent(queued) = queued.content.unwrap()
    else {
        panic!("expected the pre-existing queued event");
    };
    assert_eq!(queued.event.unwrap().identifier, "already-queued");
    assert!(
        tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("the failed session must close after queued frames drain")
            .is_none(),
        "a panic status delivered only after capacity opens is already stale"
    );
}

#[tokio::test(start_paused = true)]
async fn disconnected_response_cancels_the_idle_session_input_wait_immediately() {
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    let started = tokio::time::Instant::now();
    let result = wait_for_session_input(
        &tx,
        futures::future::pending::<Result<Option<StreamingUnderstandRequest>, Status>>(),
    )
    .await
    .unwrap();

    assert!(result.is_none());
    assert_eq!(
        tokio::time::Instant::now(),
        started,
        "a disconnected response must win without waiting for the idle timeout"
    );
}

#[tokio::test(start_paused = true)]
async fn disconnected_response_drops_pending_turn_work_without_recording_it() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_by_work = cancelled.clone();
    let request = SynapseUnderstandingRequest::default();
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    let probe = CancellationProbe(cancelled_by_work);
    let stream = Box::pin(futures::stream::once(async move {
        let _probe = probe;
        futures::future::pending::<()>().await;
        Ok(action_response("unreachable"))
    }));
    let mut state = StreamingSessionState::default();
    let started = tokio::time::Instant::now();

    let control = stream_understanding_turn(
        &mut state,
        &request,
        "disconnected-run",
        &tx,
        tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
        stream,
    )
    .await
    .unwrap();

    assert_eq!(control, TurnControl::Close);
    assert_eq!(tokio::time::Instant::now(), started);
    assert!(
        cancelled.load(Ordering::SeqCst),
        "disconnecting the response must drop pending planner work"
    );
    assert!(state.request.is_none());
}

#[tokio::test(start_paused = true)]
async fn disconnect_while_terminal_waits_for_capacity_cancels_the_send() {
    let request = SynapseUnderstandingRequest {
        utterance: "play the song".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("disconnect-user", "play the song")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let (tx, rx) = mpsc::channel(1);
    tx.try_send(QueuedStreamingResponse::unguarded(Ok(
        intermediate_event_response(turn("already-queued"), false),
    )))
    .unwrap();
    let started = tokio::time::Instant::now();
    let task = tokio::spawn(async move {
        let mut state = StreamingSessionState::default();
        let result = stream_understanding_turn(
            &mut state,
            &request,
            "disconnect-send-run",
            &tx,
            tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
            Box::pin(tokio_stream::iter(vec![Ok(named_action_response(
                "blocked-terminal",
                PLAY_MUSIC,
                "disconnect-user",
            ))])),
        )
        .await;
        drop(tx);
        result
    });

    tokio::task::yield_now().await;
    drop(rx);
    assert_eq!(task.await.unwrap().unwrap(), TurnControl::Close);
    assert_eq!(
        tokio::time::Instant::now(),
        started,
        "a disconnected response must cancel a capacity-blocked send immediately"
    );
}

#[tokio::test(start_paused = true)]
async fn fast_native_action_is_delivered_unchanged_without_waiting_for_deadline() {
    let request = SynapseUnderstandingRequest {
        utterance: "play Billie Jean".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("fast-user", "play Billie Jean")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut state = StreamingSessionState::default();
    let InputAction::Understand(request) = state
        .accept(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::UnderstandingRequest(
                Box::new(request),
            )),
        })
        .unwrap()
    else {
        panic!("expected understanding request");
    };
    let (tx, mut rx) = mpsc::channel(2);
    let started = tokio::time::Instant::now();

    let stream = Box::pin(tokio_stream::iter(vec![Ok(named_action_response(
        "fast-action",
        PLAY_MUSIC,
        "fast-user",
    ))]));
    let control = stream_understanding_turn(
        &mut state,
        &request,
        "fast-run",
        &tx,
        tokio::time::Instant::now() + STOCK_TURN_DEADLINE,
        stream,
    )
    .await
    .unwrap();

    assert_eq!(control, TurnControl::Continue);
    assert_eq!(tokio::time::Instant::now(), started);
    let response = rx.recv().await.unwrap().unwrap();
    let event = match response.content.unwrap() {
        streaming_understand_response::Content::IntermediateEvent(event) => event,
        streaming_understand_response::Content::Interstitial(_) => {
            panic!("expected understanding event")
        }
    };
    assert!(event.requires_response);
    let turn = event.event.unwrap();
    assert_eq!(turn.identifier, "fast-action");
    let synapse_chat_turn::Content::Action(action) = turn.content.unwrap() else {
        panic!("expected native action");
    };
    assert_eq!(action.action, PLAY_MUSIC);
    assert_eq!(
        state.request.unwrap().device_context.unwrap().turns.len(),
        2,
        "the successful action must still be recorded for its observation"
    );
    drop(tx);
    assert!(rx.recv().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn overdue_initial_turn_is_cancelled_then_falls_back_and_closes_without_late_action() {
    let deadline = Duration::from_secs(5);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_by_work = cancelled.clone();
    let request = SynapseUnderstandingRequest {
        utterance: "do the slow thing".into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("slow-user", "do the slow thing")],
            ..Default::default()
        }),
        ..Default::default()
    };
    let (tx, mut rx) = mpsc::channel(2);

    let task = tokio::spawn(async move {
        let mut state = StreamingSessionState::default();
        let InputAction::Understand(request) = state
            .accept(StreamingUnderstandRequest {
                content: Some(streaming_understand_request::Content::UnderstandingRequest(
                    Box::new(request),
                )),
            })
            .unwrap()
        else {
            panic!("expected understanding request");
        };
        let late_stream = Box::pin(futures::stream::once(async move {
            let _probe = CancellationProbe(cancelled_by_work);
            tokio::time::sleep(deadline + Duration::from_secs(1)).await;
            Ok(named_action_response(
                "late-native-action",
                PLAY_MUSIC,
                "slow-user",
            ))
        }));
        let control = stream_understanding_turn(
            &mut state,
            &request,
            "slow-run",
            &tx,
            tokio::time::Instant::now() + deadline,
            late_stream,
        )
        .await;
        drop(tx);
        control
    });

    tokio::task::yield_now().await;
    tokio::time::advance(deadline).await;
    assert_eq!(task.await.unwrap().unwrap(), TurnControl::Close);
    assert!(
        cancelled.load(Ordering::SeqCst),
        "the overdue planner future must be dropped"
    );

    let response = rx.recv().await.unwrap().unwrap();
    let event = match response.content.unwrap() {
        streaming_understand_response::Content::IntermediateEvent(event) => event,
        streaming_understand_response::Content::Interstitial(_) => {
            panic!("expected timeout fallback event")
        }
    };
    assert!(
        event.requires_response,
        "the fallback must delimit the stock response batch"
    );
    let turn = event.event.unwrap();
    assert_eq!(turn.parent_identifier, "slow-user");
    let synapse_chat_turn::Content::Action(action) = turn.content.unwrap() else {
        panic!("expected timeout Respond action");
    };
    assert_eq!(action.action, RESPOND);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
        serde_json::json!({"Response": TIMEOUT_FALLBACK})
    );

    tokio::time::advance(Duration::from_secs(10)).await;
    assert!(
        rx.recv().await.is_none(),
        "the terminal fallback must close the stream with no late action leak"
    );
}

#[tokio::test(start_paused = true)]
async fn overdue_observation_resume_does_not_repeat_or_leak_the_pending_action() {
    let deadline = Duration::from_secs(5);
    let utterance = "What's the weather like today?";
    let initial = SynapseUnderstandingRequest {
        utterance: utterance.into(),
        device_context: Some(SynapseDeviceContext {
            turns: vec![user_request("weather-user", utterance)],
            ..Default::default()
        }),
        ..Default::default()
    };
    let (tx, mut rx) = mpsc::channel(2);

    let task = tokio::spawn(async move {
        let mut state = StreamingSessionState::default();
        let InputAction::Understand(_) = state
            .accept(StreamingUnderstandRequest {
                content: Some(streaming_understand_request::Content::UnderstandingRequest(
                    Box::new(initial),
                )),
            })
            .unwrap()
        else {
            panic!("expected initial understanding request");
        };
        let location_response =
            named_action_response("location-action", GET_CURRENT_LOCATION, "weather-user");
        let Some(synapse_understanding_response::Body::Turn(location_turn)) =
            location_response.body
        else {
            panic!("expected location action turn");
        };
        state.record_turns(&[location_turn]);
        let InputAction::Understand(resume_request) = state
            .accept(StreamingUnderstandRequest {
                content: Some(streaming_understand_request::Content::Observation(
                    SynapseChatTurn {
                        parent_identifier: "location-action".into(),
                        ..observation("location-observation", false)
                    },
                )),
            })
            .unwrap()
        else {
            panic!("expected observation continuation");
        };
        let late_repeat = Box::pin(futures::stream::once(async move {
            tokio::time::sleep(deadline + Duration::from_secs(1)).await;
            Ok(named_action_response(
                "duplicate-location-action",
                GET_CURRENT_LOCATION,
                "location-observation",
            ))
        }));
        let control = stream_understanding_turn(
            &mut state,
            &resume_request,
            "weather-run",
            &tx,
            tokio::time::Instant::now() + deadline,
            late_repeat,
        )
        .await;
        let turns = state.request.unwrap().device_context.unwrap().turns;
        drop(tx);
        (control, turns)
    });

    tokio::task::yield_now().await;
    tokio::time::advance(deadline).await;
    let (control, turns) = task.await.unwrap();
    assert_eq!(control.unwrap(), TurnControl::Close);
    assert_eq!(
        turns
            .iter()
            .filter(|turn| matches!(
                turn.content.as_ref(),
                Some(synapse_chat_turn::Content::Action(action))
                    if action.action == GET_CURRENT_LOCATION
            ))
            .count(),
        1,
        "the already-dispatched location action must not be recorded twice"
    );
    let response = rx.recv().await.unwrap().unwrap();
    let event = match response.content.unwrap() {
        streaming_understand_response::Content::IntermediateEvent(event) => event,
        streaming_understand_response::Content::Interstitial(_) => {
            panic!("expected observation timeout fallback")
        }
    };
    let turn = event.event.unwrap();
    let synapse_chat_turn::Content::Action(action) = turn.content.unwrap() else {
        panic!("expected Respond fallback");
    };
    assert_eq!(action.action, RESPOND);
    tokio::time::advance(Duration::from_secs(10)).await;
    assert!(rx.recv().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn timeout_fails_terminally_when_stock_excludes_respond() {
    let deadline = Duration::from_secs(5);
    let request = SynapseUnderstandingRequest {
        utterance: "blocked fallback".into(),
        excluded_tools: vec![RESPOND.to_ascii_lowercase()],
        ..Default::default()
    };
    let (tx, mut rx) = mpsc::channel(1);
    let task = tokio::spawn(async move {
        let mut state = StreamingSessionState::default();
        // A planner that never yields a terminal: the deadline guard must
        // fire, and with `Respond` excluded the fallback is a terminal error
        // rather than a frame.
        let stream = Box::pin(futures::stream::pending::<
            Result<SynapseUnderstandingResponse, Status>,
        >());
        let result = stream_understanding_turn(
            &mut state,
            &request,
            "excluded-run",
            &tx,
            tokio::time::Instant::now() + deadline,
            stream,
        )
        .await;
        drop(tx);
        result
    });

    tokio::task::yield_now().await;
    tokio::time::advance(deadline).await;
    let status = task.await.unwrap().unwrap_err();
    assert_eq!(status.code(), tonic::Code::DeadlineExceeded);
    assert!(
        rx.recv().await.is_none(),
        "an excluded Respond must never be reintroduced by the deadline guard"
    );
}

#[tokio::test]
async fn tonic_bidi_round_trip_delimits_action_and_closes_after_final_observation() {
    let (address, _directory) = spawn_test_aibus().await;
    let mut client = AiBusServiceClient::connect(format!("http://{address}"))
        .await
        .unwrap();
    let (requests_tx, requests_rx) = mpsc::channel(4);
    requests_tx
        .send(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::InitialRunState(
                RunState::default(),
            )),
        })
        .await
        .unwrap();
    requests_tx
        .send(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::UnderstandingRequest(
                Box::new(SynapseUnderstandingRequest {
                    utterance: "hello from the stock stream".into(),
                    device_context: Some(SynapseDeviceContext::default()),
                    ..Default::default()
                }),
            )),
        })
        .await
        .unwrap();

    let mut responses = client
        .bidirectional_streaming_understand(ReceiverStream::new(requests_rx))
        .await
        .unwrap()
        .into_inner();
    let response = tokio::time::timeout(Duration::from_secs(5), responses.message())
        .await
        .expect("server must not leave the stock future waiting")
        .unwrap()
        .unwrap();
    let event = match response.content.unwrap() {
        streaming_understand_response::Content::IntermediateEvent(event) => event,
        streaming_understand_response::Content::Interstitial(_) => {
            panic!("expected an understanding event")
        }
    };
    assert!(event.requires_response);
    let action = match event.event.unwrap().content.unwrap() {
        synapse_chat_turn::Content::Action(action) => action,
        _ => panic!("expected a typed action turn"),
    };
    assert_eq!(action.action, RESPOND);
    assert!(action.input.contains("Echo: hello from the stock stream"));

    requests_tx
        .send(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::Observation(
                observation("completed", true),
            )),
        })
        .await
        .unwrap();
    drop(requests_tx);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), responses.message())
            .await
            .expect("final observation must close the server stream")
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn orphaned_observation_session_closes_instead_of_hanging() {
    // End-to-end poison guard: stock re-enters the ladder after narration
    // completes by opening a fresh bidi session that carries ONLY the
    // narration-completed observation — no InitialRunState, no
    // UnderstandingRequest. The server must close its side promptly so the
    // client's untimed `responseFuture.get()` resolves, instead of blocking
    // to the ~60s AI_MIC_THINKING ceiling.
    let (address, _directory) = spawn_test_aibus().await;
    let mut client = AiBusServiceClient::connect(format!("http://{address}"))
        .await
        .unwrap();
    let (requests_tx, requests_rx) = mpsc::channel(2);
    requests_tx
        .send(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::Observation(
                observation("narration-completed", false),
            )),
        })
        .await
        .unwrap();

    let mut responses = client
        .bidirectional_streaming_understand(ReceiverStream::new(requests_rx))
        .await
        .unwrap()
        .into_inner();
    // No event is dispatched (the observation is not an action) and the
    // stream ends. The bounded timeout is the assertion: a `Wait` here would
    // block until the session idle timeout, far past the stock ceiling.
    assert!(
        tokio::time::timeout(Duration::from_secs(5), responses.message())
            .await
            .expect("orphaned observation must close the server stream, not hang")
            .unwrap()
            .is_none(),
        "an orphaned observation must not produce a dispatched action"
    );
    drop(requests_tx);
}

#[tokio::test]
async fn nearby_preflight_consumes_fresh_location_without_repeating_the_action() {
    let (address, _directory) = spawn_test_aibus().await;
    let mut client = AiBusServiceClient::connect(format!("http://{address}"))
        .await
        .unwrap();
    let (requests_tx, requests_rx) = mpsc::channel(4);
    let utterance = "What's nearby?";
    requests_tx
        .send(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::UnderstandingRequest(
                Box::new(SynapseUnderstandingRequest {
                    utterance: utterance.into(),
                    device_context: Some(SynapseDeviceContext {
                        turns: vec![user_request("location-user", utterance)],
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
            )),
        })
        .await
        .unwrap();

    let mut responses = client
        .bidirectional_streaming_understand(ReceiverStream::new(requests_rx))
        .await
        .unwrap()
        .into_inner();
    let first = tokio::time::timeout(Duration::from_secs(5), responses.message())
        .await
        .expect("the one-shot location fetch must be returned")
        .unwrap()
        .unwrap();
    let first_event = match first.content.unwrap() {
        streaming_understand_response::Content::IntermediateEvent(event) => event,
        streaming_understand_response::Content::Interstitial(_) => {
            panic!("expected location action event")
        }
    };
    let first_turn = first_event.event.unwrap();
    let first_action = match first_turn.content.as_ref().unwrap() {
        synapse_chat_turn::Content::Action(action) => action,
        _ => panic!("expected GetCurrentLocation action"),
    };
    assert_eq!(first_action.action, GET_CURRENT_LOCATION);

    requests_tx
        .send(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::Observation(
                SynapseChatTurn {
                    user: crate::proto::aibus::SynapseUser::Assistant as i32,
                    identifier: "location-observation".into(),
                    parent_identifier: first_turn.identifier.clone(),
                    content: Some(synapse_chat_turn::Content::Observation(
                        SynapseObservationContent {
                            observation:
                                r#"{"latitude":55.6761,"longitude":12.5683,"isStale":false}"#
                                    .into(),
                            is_final: false,
                            // Exact stock CentralActionHandler shape: the
                            // parent ID names the action; action_name is unset.
                            action_name: String::new(),
                            source: crate::proto::aibus::SynapseSource::Device as i32,
                        },
                    )),
                    ..Default::default()
                },
            )),
        })
        .await
        .unwrap();

    let second = tokio::time::timeout(Duration::from_secs(5), responses.message())
        .await
        .expect("the fetch observation must produce a terminal answer")
        .unwrap()
        .unwrap();
    let second_event = match second.content.unwrap() {
        streaming_understand_response::Content::IntermediateEvent(event) => event,
        streaming_understand_response::Content::Interstitial(_) => {
            panic!("expected terminal answer event")
        }
    };
    let second_turn = second_event.event.unwrap();
    let second_action = match second_turn.content.as_ref().unwrap() {
        synapse_chat_turn::Content::Action(action) => action,
        _ => panic!("expected Respond action"),
    };
    assert_eq!(second_action.action, RESPOND);
    assert!(
        !second_action
            .input
            .contains("I couldn't get a fresh current location right now."),
        "the exact stock nameless observation must take the grounded path"
    );
    assert!(second_event.requires_response);

    requests_tx
        .send(StreamingUnderstandRequest {
            content: Some(streaming_understand_request::Content::Observation(
                observation(&second_turn.identifier, true),
            )),
        })
        .await
        .unwrap();
    drop(requests_tx);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), responses.message())
            .await
            .expect("the final answer observation must close the stream")
            .unwrap()
            .is_none()
    );
}
