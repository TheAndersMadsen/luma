//! The demo assistant surface: Center's chat, trace, trace stream and speech,
//! driven through the same engine the Pin uses.

use super::*;

pub(super) async fn demo_status(State(state): State<HttpState>) -> Json<DemoStatus> {
    let config = state.integrations.snapshot();
    let assistant = match config.assistant.provider {
        crate::integrations::AssistantProvider::OpenAiCompatible => config.assistant.configured(),
        crate::integrations::AssistantProvider::CodexSubscription => {
            config.assistant.configured()
                && crate::assistant::codex_app_server::account_status()
                    .await
                    .connected
        }
    };
    let speech = crate::backends::azure_speech::configured();
    let model = config.assistant.model;
    Json(DemoStatus {
        provider_authority: "cosmos",
        assistant,
        speech,
        model,
        mesh: mesh_status(&state).await,
        tools: tool_status(),
    })
}

#[derive(Deserialize)]
pub(super) struct DemoTextRequest {
    text: String,
    /// Evaluate the stock request shape an unlocked Pin sends without
    /// dispatching any returned device action. The trace endpoints use this
    /// for release acceptance. Chat and speech keep their normal demo shape.
    #[serde(default)]
    simulate_unlocked_pin: bool,
    /// Complete the stock current-location action/observation hop with a fixed
    /// valid coordinate. This is acceptance-only: no device action is dispatched
    /// and the production evaluator can inspect the grounded follow-up turn.
    #[serde(default)]
    simulate_location: bool,
}

/// A `/demo-api/trace` turn. Only the operator's trace takes a conversation:
/// the chat, stream, and speech routes keep one fresh turn per request.
#[derive(Deserialize)]
pub(super) struct DemoTraceRequest {
    #[serde(flatten)]
    turn: DemoTextRequest,
    /// Run this turn as the next utterance of a Pin conversation: the `replay`
    /// an earlier trace of that conversation returned, or `""` (the encoding of
    /// an empty context) to start one. The turn then carries an unlocked Pin's
    /// device context, and its response returns the conversation's next
    /// `replay`. Acceptance-only, like the simulations: nothing is dispatched.
    #[serde(default)]
    replay: Option<String>,
}

#[derive(Serialize)]
pub(super) struct DemoChatResponse {
    reply: String,
}

/// Whose account an assistant turn runs under.
///
/// The SAME precedence every other web surface uses
/// ([`crate::web_api::principal_for`]): a signature-verified Bearer, then
/// the edge-injected device principal, and the demo account only when nobody
/// identified themselves.
///
/// These three routes used to insert `from_edge(DEMO_PRINCIPAL)` unconditionally.
/// That is not a keyless-demo fallback, it is an override: a wearer signed in to
/// Center, saying "remember the gate code", had the note written into
/// `V:01:D:web-demo:U:operator` and was told "Saved". Their own `/notes` reads
/// `U:<sub>` and could never show it, and `recall_memory` then returned an
/// authoritative "you have no note about that" about their own data.
/// `from_edge` also keeps the literal string rather than collapsing to
/// `U:<user>`, so the demo account is not even a partition any front door can
/// reach.
///
/// A Bearer that is present but does not verify is a 401, not a fall-through:
/// the caller asserted an identity that did not hold, and running their turn in
/// the demo partition would answer questions about somebody else's data.
pub(super) fn turn_principal(headers: &HeaderMap) -> Result<AuthenticatedPrincipal, DemoError> {
    let unusable = || {
        demo_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Caller identity unavailable.",
        )
    };
    let verifier = crate::web_auth::configured_verifier();
    let resolved = crate::web_api::principal_for(headers, verifier.as_deref()).map_err(|()| {
        demo_error(
            StatusCode::UNAUTHORIZED,
            "That session could not be verified.",
        )
    })?;
    match resolved {
        // Already collapsed to the account principal both front doors share.
        Some(resolved) => {
            AuthenticatedPrincipal::from_edge(resolved.account).map_err(|_| unusable())
        }
        None => {
            if verifier.is_some() {
                // The web plane is configured, so a wearer turn was expected to
                // contain a Bearer and did not, the caller in front of us is not
                // forwarding it. Worth a line every time: the turn still runs,
                // but it runs somewhere the wearer cannot read.
                tracing::warn!(
                    "assistant turn carries no verified identity; running it under the demo \
                     account, where anything it remembers is unreadable from the wearer's own \
                     surfaces"
                );
            }
            AuthenticatedPrincipal::from_edge(crate::web_api::DEMO_PRINCIPAL)
                .map_err(|_| unusable())
        }
    }
}

fn validate_demo_text(text: String, max_bytes: usize) -> Result<String, DemoError> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Enter a message first.",
        ));
    }
    if text.len() > max_bytes {
        return Err(demo_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That message is too long for the demo.",
        ));
    }
    Ok(text)
}

pub(super) async fn demo_chat(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<DemoTextRequest>,
) -> Result<Json<DemoChatResponse>, DemoError> {
    let text = validate_demo_text(payload.text, MAX_DEMO_TEXT_BYTES)?;
    let demo = state.demo.ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The Cosmos demo is unavailable.",
        )
    })?;
    let mut request = Request::new(ServerStatefulUnderstandRequest {
        userrequest: Some(
            cosmos_protocol::aibus::server_stateful_understand_request::Userrequest::Transcription(
                text,
            ),
        ),
        response_format: ResponseFormat::Text as i32,
    });
    request.extensions_mut().insert(turn_principal(&headers)?);

    let response = tokio::time::timeout(
        DEMO_CHAT_TIMEOUT,
        demo.assistant.server_stateful_understand(request),
    )
    .await
    .map_err(|_| demo_error(StatusCode::GATEWAY_TIMEOUT, "The assistant took too long."))?
    .map_err(|_| demo_error(StatusCode::BAD_GATEWAY, "The assistant could not answer."))?
    .into_inner();
    let reply = match response.response {
        Some(UnderstandResponse::Text(text)) if !text.trim().is_empty() => text,
        _ => {
            return Err(demo_error(
                StatusCode::BAD_GATEWAY,
                "The assistant returned no text.",
            ));
        }
    };
    Ok(Json(DemoChatResponse { reply }))
}

/// One step of the assistant's reasoning, streamed to the operator demo so the
/// browser can show *how* the backend reached its answer: every tool the model
/// invoked (server lookups like `web_search`/`wikipedia`, device actions like
/// `SetTimer`), the observation each returned, and the final spoken answer. This
/// is exactly the transcript a Pin receives on the `Understand` stream.
#[derive(Serialize)]
struct DemoTraceStep {
    /// `"action"` (a tool/device call), `"observation"` (its result), or
    /// `"answer"` (the terminal `Respond`).
    kind: &'static str,
    /// Action name (`SetTimer`, `web_search`, `wikipedia`, `Respond`, …).
    name: String,
    /// `"device"` for a Pin-executed action, `"server"` for a cloud-side tool.
    source: &'static str,
    /// The model's rationale for an action step, when the model supplied one.
    thought: String,
    /// Action arguments (JSON) for an action step. Empty otherwise.
    input: String,
    /// Observation text for an observation. The spoken sentence for the answer.
    text: String,
    /// INFERRED Luma trace field: how this observation sounds if narrated
    /// directly by `Respond`. Keep `text` as the original wire evidence. The
    /// same `catalog::speakable` projection fills the stock `Response` field
    /// consumed by `RespondActionHandler.handleAction`. The evaluator must not
    /// reproduce that speech policy in a second language.
    #[serde(skip_serializing_if = "Option::is_none")]
    speakable_text: Option<String>,
    /// Milliseconds from the start of the turn to when this step was streamed.
    ///
    /// Latency is the dominant thing a wearer feels on this device, and it is
    /// almost entirely model-step time, so showing WHERE the turn went is more
    /// informative than a single total. It also makes the Hooked 90s device
    /// deadline visible: past it, a real Pin discards the whole turn.
    elapsed_ms: u64,
}

#[derive(Serialize)]
pub(super) struct DemoTraceResponse {
    steps: Vec<DemoTraceStep>,
    reply: String,
    /// Wall-clock for the whole turn.
    total_ms: u64,
    /// The server's own run budget: it delivers a spoken terminal by here.
    budget_ms: u64,
    /// `AIMIC_TIMEOUT_MS`, the device's hard gRPC deadline. Past this a real Pin
    /// fires DEADLINE_EXCEEDED and throws away every turn already streamed, so
    /// this is the line the whole design is racing.
    device_deadline_ms: u64,
    /// For a turn that continued or started a conversation: the conversation
    /// once this run has ended, to send as the next turn's `replay`.
    #[serde(skip_serializing_if = "Option::is_none")]
    replay: Option<String>,
    /// INFERRED private acceptance metadata: verified account's local retained
    /// OS3 checkpoint under the current cookie. Unknown state is omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    os3_task_retained: Option<bool>,
}

async fn collect_demo_trace<S>(
    stream: &mut S,
    started: std::time::Instant,
    steps: &mut Vec<DemoTraceStep>,
    reply: &mut String,
    replayed_turns: &mut Vec<cosmos_protocol::aibus::SynapseChatTurn>,
) where
    S: Stream<Item = Result<cosmos_protocol::aibus::SynapseUnderstandingResponse, tonic::Status>>
        + Unpin,
{
    use cosmos_protocol::aibus::{
        synapse_chat_turn::Content, synapse_understanding_response::Body,
    };
    use tokio_stream::StreamExt as _;

    while let Some(message) = stream.next().await {
        let Ok(message) = message else { break };
        let Some(Body::Turn(turn)) = message.body else {
            continue;
        };
        let replayed = turn.clone();
        match turn.content {
            Some(Content::Action(action)) if action.action == RESPOND_ACTION => {
                let spoken = spoken_answer(&action.input);
                *reply = spoken.clone();
                steps.push(DemoTraceStep {
                    kind: "answer",
                    name: RESPOND_ACTION.to_owned(),
                    source: source_label_for(action.source),
                    thought: action.thought,
                    input: String::new(),
                    text: spoken,
                    speakable_text: None,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
            }
            Some(Content::Action(action)) => steps.push(DemoTraceStep {
                kind: "action",
                name: action.action,
                source: source_label_for(action.source),
                thought: action.thought,
                input: action.input,
                text: String::new(),
                speakable_text: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
            }),
            Some(Content::Observation(obs)) => steps.push(DemoTraceStep {
                kind: "observation",
                name: obs.action_name,
                source: source_label_for(obs.source),
                thought: String::new(),
                input: String::new(),
                speakable_text: Some(crate::assistant::catalog::speakable(&obs.observation)),
                text: obs.observation,
                elapsed_ms: started.elapsed().as_millis() as u64,
            }),
            _ => {}
        }
        replayed_turns.push(replayed);
    }
}

fn simulated_user_turn(text: &str) -> cosmos_protocol::aibus::SynapseChatTurn {
    cosmos_protocol::aibus::SynapseChatTurn {
        user: cosmos_protocol::aibus::SynapseUser::User as i32,
        identifier: uuid::Uuid::new_v4().to_string(),
        content: Some(
            cosmos_protocol::aibus::synapse_chat_turn::Content::UserRequest(
                cosmos_protocol::aibus::SynapseUserRequestContent {
                    request: text.to_owned(),
                    ..Default::default()
                },
            ),
        ),
        ..Default::default()
    }
}

fn simulated_location_observation(
    action: &cosmos_protocol::aibus::SynapseChatTurn,
) -> cosmos_protocol::aibus::SynapseChatTurn {
    cosmos_protocol::aibus::SynapseChatTurn {
        user: cosmos_protocol::aibus::SynapseUser::Assistant as i32,
        identifier: uuid::Uuid::new_v4().to_string(),
        parent_identifier: action.identifier.clone(),
        content: Some(
            cosmos_protocol::aibus::synapse_chat_turn::Content::Observation(
                cosmos_protocol::aibus::SynapseObservationContent {
                    observation: serde_json::json!({
                        "latitude": 55.6761,
                        "longitude": 12.5683,
                        "isStale": false,
                    })
                    .to_string(),
                    is_final: false,
                    action_name: "GetCurrentLocation".to_owned(),
                    source: SynapseSource::Device as i32,
                },
            ),
        ),
        ..Default::default()
    }
}

/// The final observation a Pin records under the action that ended a run
/// (`TaoEventRegistrar.onObservation` records it under that action's turn,
/// with `is_final` and `source` taken from the observation), which is what
/// makes the run complete for `EventsSnapshot.isCompleteRun`. The device's own
/// observation text is not recovered, so it stays empty (INFERRED).
fn run_closing_observation(
    terminal: &cosmos_protocol::aibus::SynapseChatTurn,
) -> cosmos_protocol::aibus::SynapseChatTurn {
    cosmos_protocol::aibus::SynapseChatTurn {
        user: cosmos_protocol::aibus::SynapseUser::Assistant as i32,
        identifier: uuid::Uuid::new_v4().to_string(),
        parent_identifier: terminal.identifier.clone(),
        content: Some(
            cosmos_protocol::aibus::synapse_chat_turn::Content::Observation(
                cosmos_protocol::aibus::SynapseObservationContent {
                    is_final: true,
                    source: SynapseSource::Device as i32,
                    ..Default::default()
                },
            ),
        ),
        ..Default::default()
    }
}

/// The earlier turns of the conversation a trace continues, bounded as a Pin
/// bounds its own.
fn decode_demo_replay(
    replay: &str,
) -> Result<Vec<cosmos_protocol::aibus::SynapseChatTurn>, DemoError> {
    let too_long = || {
        demo_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That conversation is too long to continue.",
        )
    };
    let unreadable = || demo_error(StatusCode::BAD_REQUEST, "That replay could not be read.");
    if replay.len() > MAX_DEMO_REPLAY_BYTES {
        return Err(too_long());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(replay)
        .map_err(|_| unreadable())?;
    let context = cosmos_protocol::aibus::SynapseDeviceContext::decode(bytes.as_slice())
        .map_err(|_| unreadable())?;
    if context.turns.len() > MAX_DEMO_REPLAY_TURNS {
        return Err(too_long());
    }
    Ok(context.turns)
}

/// The conversation once this run has ended, encoded for the next turn's
/// `replay`: the earlier turns, this run's, and the observation that closes
/// it. Like the Pin's own history it drops the oldest turns first
/// (`LocalChatTurnService.prune`), so it never outgrows what a trace accepts.
fn encode_demo_replay(
    earlier: Vec<cosmos_protocol::aibus::SynapseChatTurn>,
    run: Vec<cosmos_protocol::aibus::SynapseChatTurn>,
) -> String {
    use cosmos_protocol::aibus::{SynapseDeviceContext, synapse_chat_turn::Content};

    let closing = run
        .last()
        .filter(|turn| matches!(turn.content, Some(Content::Action(_))))
        .map(run_closing_observation);
    let mut context = SynapseDeviceContext {
        turns: earlier.into_iter().chain(run).chain(closing).collect(),
        ..Default::default()
    };
    while context.turns.len() > MAX_DEMO_REPLAY_TURNS
        || context.encoded_len().div_ceil(3) * 4 > MAX_DEMO_REPLAY_BYTES
    {
        context.turns.remove(0);
    }
    base64::engine::general_purpose::STANDARD.encode(context.encode_to_vec())
}

/// Run the wearer's prompt through the *real* `Understand` ReAct engine and
/// return the full turn transcript. Where [`demo_chat`] surfaces only the final
/// sentence, this exposes every action + observation so the demo can visualise
/// the backend thinking, a lookup before it answers, a `SetTimer`, and so on.
pub(super) async fn demo_trace(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<DemoTraceRequest>,
) -> Result<Json<DemoTraceResponse>, DemoError> {
    let started = std::time::Instant::now();
    let finish_by = started + crate::assistant::runtime::FOREGROUND_BUDGET;
    let demo = state.demo.ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The Cosmos demo is unavailable.",
        )
    })?;
    let mut response = trace_turn(
        |request| demo.assistant.understand(request),
        &headers,
        payload,
    )
    .await?;
    if response.steps.iter().any(|step| step.name == "ask_os3")
        && std::time::Instant::now() < finish_by
    {
        // Same canonical caller resolver, store and key directory as this turn.
        // This is a bounded local query, never an external task/status request.
        let principal = turn_principal(&headers)?;
        let saved = crate::backends::os3::ConversationStore::new(
            demo.assistant.store(),
            demo.keys.clone(),
            principal.expose_for_authorization(),
        );
        response.os3_task_retained =
            crate::backends::os3::has_retained_task(&saved, Some(finish_by))
                .await
                .ok();
        response.total_ms = started.elapsed().as_millis() as u64;
    }
    Ok(Json(response))
}

/// One [`demo_trace`] turn, run by `understand`: the assistant's own
/// `Understand`.
///
/// With a `replay`, the turn is the next utterance of that Pin conversation,
/// in the shape a stock Pin sends it (`SynapseInterpreter.buildRequest`): the
/// utterance, and as device context the earlier complete runs
/// (`EventsSnapshot.linearize`) followed by this request as its own run root
/// (`TaoEventRegistrar.onTranscription`). So a "Yes." carries the question it
/// answers exactly as it does on a Pin, and nothing else confirms an action.
async fn trace_turn<U, F, S>(
    understand: U,
    headers: &HeaderMap,
    payload: DemoTraceRequest,
) -> Result<DemoTraceResponse, DemoError>
where
    U: Fn(Request<SynapseUnderstandingRequest>) -> F,
    F: std::future::Future<Output = Result<tonic::Response<S>, tonic::Status>>,
    S: Stream<Item = Result<cosmos_protocol::aibus::SynapseUnderstandingResponse, tonic::Status>>
        + Unpin,
{
    let DemoTraceRequest {
        turn: payload,
        replay,
    } = payload;
    let text = validate_demo_text(payload.text, MAX_DEMO_TEXT_BYTES)?;
    let earlier = replay.as_deref().map(decode_demo_replay).transpose()?;
    let conversation = earlier.is_some();
    let earlier = earlier.unwrap_or_default();

    // This run's turns as the Pin records them, rooted on the live request
    // whenever the request replays it.
    let mut replayed_turns = if payload.simulate_location || conversation {
        vec![simulated_user_turn(&text)]
    } else {
        Vec::new()
    };
    let context = |run: &[cosmos_protocol::aibus::SynapseChatTurn]| {
        cosmos_protocol::aibus::SynapseDeviceContext {
            turns: earlier.iter().chain(run).cloned().collect(),
            ..Default::default()
        }
    };
    let mut request = Request::new(SynapseUnderstandingRequest {
        utterance: text.clone(),
        device_context: (payload.simulate_unlocked_pin || conversation)
            .then(|| context(&replayed_turns)),
        ..Default::default()
    });
    request.extensions_mut().insert(turn_principal(headers)?);

    let mut stream = understand(request)
        .await
        .map_err(|_| demo_error(StatusCode::BAD_GATEWAY, "The assistant could not answer."))?
        .into_inner();

    let started = std::time::Instant::now();
    let mut steps = Vec::new();
    let mut reply = String::new();
    tokio::time::timeout(
        DEMO_CHAT_TIMEOUT,
        collect_demo_trace(
            &mut stream,
            started,
            &mut steps,
            &mut reply,
            &mut replayed_turns,
        ),
    )
    .await
    .map_err(|_| demo_error(StatusCode::GATEWAY_TIMEOUT, "The assistant took too long."))?;

    if payload.simulate_location {
        let location_action = replayed_turns.iter().rev().find(|turn| {
            matches!(
                turn.content.as_ref(),
                Some(cosmos_protocol::aibus::synapse_chat_turn::Content::Action(action))
                    if action.action == "GetCurrentLocation"
            )
        });
        if let Some(location_action) = location_action.cloned() {
            let observation = simulated_location_observation(&location_action);
            let observation_text = match observation.content.as_ref() {
                Some(cosmos_protocol::aibus::synapse_chat_turn::Content::Observation(value)) => {
                    value.observation.clone()
                }
                _ => String::new(),
            };
            steps.push(DemoTraceStep {
                kind: "observation",
                name: "GetCurrentLocation".to_owned(),
                source: "device",
                thought: String::new(),
                input: String::new(),
                speakable_text: Some(crate::assistant::catalog::speakable(&observation_text)),
                text: observation_text,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
            replayed_turns.push(observation);

            let mut follow_up = Request::new(SynapseUnderstandingRequest {
                utterance: text,
                device_context: Some(context(&replayed_turns)),
                location: Some(cosmos_protocol::aibus::Location {
                    latitude: 55.6761,
                    longitude: 12.5683,
                }),
                ..Default::default()
            });
            follow_up.extensions_mut().insert(turn_principal(headers)?);
            let mut follow_up_stream = understand(follow_up)
                .await
                .map_err(|_| {
                    demo_error(StatusCode::BAD_GATEWAY, "The assistant could not answer.")
                })?
                .into_inner();
            tokio::time::timeout(
                DEMO_CHAT_TIMEOUT,
                collect_demo_trace(
                    &mut follow_up_stream,
                    started,
                    &mut steps,
                    &mut reply,
                    &mut replayed_turns,
                ),
            )
            .await
            .map_err(|_| demo_error(StatusCode::GATEWAY_TIMEOUT, "The assistant took too long."))?;
        }
    }

    Ok(DemoTraceResponse {
        steps,
        reply,
        total_ms: started.elapsed().as_millis() as u64,
        budget_ms: RUN_BUDGET_MS,
        device_deadline_ms: DEVICE_DEADLINE_MS,
        replay: conversation.then(|| encode_demo_replay(earlier, replayed_turns)),
        os3_task_retained: None,
    })
}

/// The same turn as [`demo_trace`], streamed step by step as it happens.
///
/// The batched endpoint makes a wearer's turn look instantaneous-then-done: you
/// wait, and the whole transcript appears at once. That hides the thing worth
/// seeing, the assistant deciding, calling a tool, reading the result, and only
/// then answering. This emits each turn the engine produces the moment it
/// produces it, which is also exactly how the device receives them.
///
/// Server-sent events rather than a websocket: the stream is one-directional and
/// short-lived, and SSE survives the plain HTTP proxy in front of the demo.
/// Progress cues are emitted only after the assistant selects real work. They
/// are deterministic descriptions of that tool call, so no second model, flag,
/// or terminal-turn delay sits in the answer path.
///
/// This is Luma Center's assistant chat, so Cosmos records the answered turn in
/// the wearer's history itself ([`record_center_chat_turn`]). Center only
/// relays the stream.
pub(super) async fn demo_trace_stream(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<DemoTextRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, DemoError> {
    use cosmos_protocol::aibus::{
        synapse_chat_turn::Content, synapse_understanding_response::Body,
    };
    use tokio_stream::StreamExt as _;

    let text = validate_demo_text(payload.text, MAX_DEMO_TEXT_BYTES)?;
    let demo = state.demo.ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The Cosmos demo is unavailable.",
        )
    })?;

    let principal = turn_principal(&headers)?;
    // The finished turn is recorded under the account it ran as, once.
    let mut unrecorded = state.store.clone().map(|store| {
        (
            store,
            principal.expose_for_authorization().to_owned(),
            text.clone(),
        )
    });
    let started = std::time::Instant::now();
    // INFERRED Luma Center extension: an explicit one-off translates on Cosmos,
    // rather than returning a stock device action that a browser cannot execute.
    // Both browser transcript input and the stock Speech RPC use the same
    // confirmed-result archive operation. No model prose creates history.
    let translation = (!payload.simulate_unlocked_pin)
        .then(|| crate::assistant::intents::one_off_translation_request(&text))
        .flatten();
    let mut turns: <AiBusMain as AiBusService>::UnderstandStream = if let Some(input) = translation
    {
        let translated = demo
            .translation
            .translate_one_off(principal.expose_for_authorization(), input)
            .await
            .map_err(|status| {
                demo_error(
                    if status.code() == tonic::Code::DeadlineExceeded {
                        StatusCode::GATEWAY_TIMEOUT
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                    "The translation could not be completed and saved.",
                )
            })?;
        let answer = translated.translation;
        Box::pin(tokio_stream::iter([Ok(
            cosmos_protocol::aibus::SynapseUnderstandingResponse {
                response: answer.clone(),
                is_final: true,
                body: Some(Body::Turn(cosmos_protocol::aibus::SynapseChatTurn {
                    user: cosmos_protocol::aibus::SynapseUser::Assistant as i32,
                    identifier: uuid::Uuid::new_v4().to_string(),
                    content: Some(Content::Action(
                        cosmos_protocol::aibus::SynapseActionContent {
                            action: RESPOND_ACTION.into(),
                            input: crate::assistant::catalog::respond_input(&answer),
                            source: SynapseSource::Server as i32,
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                })),
            },
        )]))
    } else {
        let mut request = Request::new(SynapseUnderstandingRequest {
            utterance: text,
            device_context: payload
                .simulate_unlocked_pin
                .then(cosmos_protocol::aibus::SynapseDeviceContext::default),
            ..Default::default()
        });
        request.extensions_mut().insert(principal);
        demo.assistant
            .understand(request)
            .await
            .map_err(|_| demo_error(StatusCode::BAD_GATEWAY, "The assistant could not answer."))?
            .into_inner()
    };

    let events = async_stream::stream! {
        let mut cue_emitted = false;
        // Open with the budget the turn is racing, so the page can draw the
        // deadline before any step exists.
        yield Ok(Event::default().event("start").data(
            serde_json::json!({
                "budget_ms": RUN_BUDGET_MS.saturating_sub(started.elapsed().as_millis() as u64),
                "device_deadline_ms": DEVICE_DEADLINE_MS.saturating_sub(started.elapsed().as_millis() as u64),
            })
            .to_string(),
        ));

        loop {
            let Some(message) = turns.next().await else { break };
            let Ok(message) = message else { break };
            let Some(Body::Turn(turn)) = message.body else { continue };

            let elapsed_ms = started.elapsed().as_millis() as u64;
            let step = match turn.content {
                Some(Content::Action(action)) if action.action == RESPOND_ACTION => {
                    let spoken = spoken_answer(&action.input);
                    // Before the answer is yielded, so a wearer who closes the
                    // chat on reading it still has the turn in My Data.
                    if let Some((store, account, asked)) = unrecorded.take() {
                        record_center_chat_turn(&store, &account, &asked, &spoken).await;
                    }
                    Some(DemoTraceStep {
                        kind: "answer",
                        name: RESPOND_ACTION.to_owned(),
                        source: source_label_for(action.source),
                        thought: action.thought,
                        input: String::new(),
                        text: spoken,
                        speakable_text: None,
                        elapsed_ms,
                    })
                }
                Some(Content::Action(action)) => {
                    if !cue_emitted {
                        if let Some(text) = crate::assistant::catalog::progress_cue(
                            &action.action,
                            &action.input,
                        ) {
                            cue_emitted = true;
                            yield Ok(Event::default().event("cue").data(
                                serde_json::json!({ "text": text }).to_string(),
                            ));
                        }
                    }
                    Some(DemoTraceStep {
                        kind: "action",
                        name: action.action,
                        source: source_label_for(action.source),
                        thought: action.thought,
                        input: action.input,
                        text: String::new(),
                        speakable_text: None,
                        elapsed_ms,
                    })
                }
                Some(Content::Observation(obs)) => Some(DemoTraceStep {
                    kind: "observation",
                    name: obs.action_name,
                    source: source_label_for(obs.source),
                    thought: String::new(),
                    input: String::new(),
                    speakable_text: Some(crate::assistant::catalog::speakable(&obs.observation)),
                    text: obs.observation,
                    elapsed_ms,
                }),
                _ => None,
            };
            if let Some(step) = step {
                match serde_json::to_string(&step) {
                    Ok(data) => yield Ok(Event::default().event("step").data(data)),
                    Err(_) => continue,
                }
            }
        }

        yield Ok(Event::default().event("done").data(
            serde_json::json!({ "total_ms": started.elapsed().as_millis() as u64 }).to_string(),
        ));
    };

    Ok(Sse::new(events).keep_alive(axum::response::sse::KeepAlive::default()))
}

/// The originator of a `humane.respond` event recorded for a turn the wearer
/// typed in Luma Center's assistant chat rather than spoke to the Pin. Beyond
/// stock (humane.center had no chat), so it is kept apart from every Pin
/// originator: My Data's Ai Mic list shows it marked "Typed in Center", where
/// search and Forget reach it, and a Pin's history restore
/// (`DeviceEventsHistoryService.QueryEvents` on the device plane) leaves it
/// out.
pub(crate) const CENTER_CHAT_ORIGINATOR: &str = "luma.center";

/// Record one finished Center chat turn as the wearer's `humane.respond`
/// event, in the Pin's `RespondNotableEvent` shape `{request, response}`, with
/// the index `EventsIngest` gives a plaintext `humane.respond` (request then
/// response, lowercased) so "what did I ask" finds it.
///
/// Best-effort: the wearer already has the answer, so a failed write is logged
/// and never turns into a failed turn.
async fn record_center_chat_turn(
    store: &crate::store::SharedStore,
    account: &str,
    request: &str,
    response: &str,
) {
    let (request, response) = (request.trim(), response.trim());
    if request.is_empty() || response.is_empty() {
        return;
    }
    let text = |value: &str| prost_types::Value {
        kind: Some(prost_types::value::Kind::StringValue(value.to_owned())),
    };
    let now = crate::store::SyncTime::now();
    let event = crate::store::NotableEventRecord {
        event_identifier: uuid::Uuid::new_v4().to_string(),
        originator_identifier: CENTER_CHAT_ORIGINATOR.to_owned(),
        creation_time: Some(now),
        event_type: "humane.respond".to_owned(),
        event_data: Some(prost_types::Struct {
            fields: [
                ("request".to_owned(), text(request)),
                ("response".to_owned(), text(response)),
            ]
            .into_iter()
            .collect(),
        }),
        encrypted_event_data: None,
        encrypted_location: None,
        device_is_locked: false,
        ingested: now,
        indexed_text: Some(format!("{request} {response}").to_lowercase()),
    };
    if store.ingest_events(account, &[event]).await.is_err() {
        tracing::warn!("a Center assistant turn could not be recorded in the wearer's history");
    }
}

/// `"device"` for a Pin-executed action, `"server"` for a cloud-side tool.
fn source_label_for(source: i32) -> &'static str {
    if source == SynapseSource::Device as i32 {
        "device"
    } else {
        "server"
    }
}

/// Pull the spoken sentence out of a `Respond` action's `{"Response":"…"}` input,
/// falling back to the raw input when it is not the expected shape.
fn spoken_answer(input: &str) -> String {
    serde_json::from_str::<serde_json::Value>(input)
        .ok()
        .and_then(|value| {
            value
                .get(RESPOND_FIELD)
                .and_then(|field| field.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| input.to_owned())
}

pub(super) async fn demo_speech(
    State(_state): State<HttpState>,
    Json(payload): Json<DemoTextRequest>,
) -> Result<Response, DemoError> {
    let text = validate_demo_text(payload.text, MAX_DEMO_SPEECH_BYTES)?;
    let speech = configured_backend()
        .filter(|_| crate::backends::azure_speech::configured())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Speech synthesis is unavailable.",
            )
        })?;
    let audio = tokio::time::timeout(
        DEMO_SPEECH_TIMEOUT,
        speech.synthesize(&text, SpeechAudioFormat::Audio24Khz160KBitrateMonoMp3),
    )
    .await
    .map_err(|_| {
        demo_error(
            StatusCode::GATEWAY_TIMEOUT,
            "Speech synthesis took too long.",
        )
    })?
    .map_err(|_| demo_error(StatusCode::BAD_GATEWAY, "Speech synthesis failed."))?;

    let mut response = Response::new(axum::body::Body::from(audio));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mpeg"));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use cosmos_protocol::aibus as pb;
    use tower::ServiceExt;

    // Failure modes: missing/stale typed precondition makes a contextual eval
    // pass without retained work. Another account sees that work. Unreadable
    // state becomes false and hides uncertainty. Actual private HTTP + local
    // WebSocket, synthetic unrecorded fixtures, shared sealed store/key directory.
    #[tokio::test]
    async fn private_os3_trace_reports_only_verified_bounded_retained_task_state() {
        use super::super::os3_tests::{Rabbit, Scenario, app, post_as, setup};
        let Some((store, keys, dir)) = setup("http::demo::tests::private_os3_trace_reports_only_verified_bounded_retained_task_state").await else { return; };
        let rabbit = Rabbit::start(Scenario::Result).await;
        let (status, body) = post_as(
            app(store.clone(), keys.clone()),
            Some("alice"),
            "/demo-api/trace",
            "Ask OS3 to inspect the synthetic Mac fixture.",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let first: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            first["os3_task_retained"], true,
            "accepted unresolved work is a typed precondition"
        );
        let (status, body) = post_as(
            app(store.clone(), keys.clone()),
            Some("bob"),
            "/demo-api/trace",
            "What did OS3 find?",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let other: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            other["os3_task_retained"], false,
            "another verified account has no retained work"
        );
        let (status, body) = post_as(
            app(store.clone(), keys.clone()),
            Some("alice"),
            "/demo-api/trace",
            "What did OS3 find?",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let result: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(body.contains("Synthetic task result"));
        assert_eq!(
            result["os3_task_retained"], false,
            "terminal retained worker can retire its boundary"
        );
        store
            .put_account_blob(
                "U:alice",
                crate::store::AccountBlobKind::Os3Conversation,
                b"unreadable synthetic sealed state",
            )
            .await
            .unwrap();
        let (status, body) = post_as(
            app(store, keys),
            Some("alice"),
            "/demo-api/trace",
            "What did OS3 find?",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let unknown: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(
            unknown.get("os3_task_retained").is_none(),
            "unreadable state is unknown, never false"
        );
        assert_eq!(
            rabbit
                .sent()
                .iter()
                .filter(|packet| packet["type"] == "chat.message")
                .count(),
            1,
            "status metadata does not submit or replay tasks"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    // Failure modes: a legal character-bounded multilingual server answer exceeds
    // the chat byte cap. Increasing speech validation accidentally relaxes chat;
    // oversized/empty speech spends provider quota. Actual HTTP routes, unrecorded
    // synthetic text, isolated unconfigured speech: 503 proves validation only.
    #[tokio::test]
    async fn multilingual_os3_speech_accepts_bounded_utf8_without_relaxing_chat() {
        const CHILD: &str = "LUMA_MULTILINGUAL_SPEECH_FIXTURE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "http::demo::tests::multilingual_os3_speech_accepts_bounded_utf8_without_relaxing_chat", "--nocapture"])
                .env(CHILD, "synthetic")
                .env("COSMOS_AZURE_SPEECH_KEY", "")
                .env("COSMOS_AZURE_SPEECH_REGION", "")
                .output().unwrap();
            assert!(
                output.status.success(),
                "isolated speech validation: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let dir = std::env::temp_dir().join(format!("luma-speech-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::integrations::install(dir.to_str()).unwrap();
        let app = super::super::demo_router(
            Readiness::default(),
            crate::store::MemoryStore::shared(),
            std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
        );
        let multilingual = format!("{}…", "😀".repeat(1_500));
        assert_eq!(multilingual.len(), 6_003);
        for (path, text, expected) in [
            (
                "/demo-api/speech",
                multilingual.as_str(),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                "/demo-api/chat",
                multilingual.as_str(),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            ("/demo-api/speech", "", StatusCode::BAD_REQUEST),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::json!({"text":text}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "HTTP validation for {path}");
        }
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/demo-api/speech")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"text":"x".repeat(6_005)}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "speech remains byte bounded"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    // Failure modes: comparing raw provider markup/whitespace rejects the
    // exact spoken result. Normalizing raw trace text loses the wire evidence;
    // a missing projection can silently accept an invented answer. Exercise
    // the HTTP trace's stock action/observation/Respond stream before adding
    // the projection, without a provider credential or recorded response.
    #[tokio::test]
    async fn os3_trace_preserves_wire_text_and_exports_the_exact_speech_projection() {
        const RAW: &str = "OS3 replied: **Battery is at 82%.**\n  LUMA-OS3-ROUND-A. Try [café](https://example.invalid).";
        const SPOKEN: &str = "OS3 replied: Battery is at 82%. LUMA-OS3-ROUND-A. Try café.";
        let app = Router::new().route(
            "/demo-api/trace",
            post(
                |headers: HeaderMap, Json(payload): Json<DemoTraceRequest>| async move {
                    trace_turn(
                        |_| async {
                            let turn = |content| pb::SynapseUnderstandingResponse {
                                body: Some(pb::synapse_understanding_response::Body::Turn(
                                    pb::SynapseChatTurn {
                                        content: Some(content),
                                        ..Default::default()
                                    },
                                )),
                                ..Default::default()
                            };
                            let messages: Vec<Result<_, tonic::Status>> = vec![
                                Ok(turn(pb::synapse_chat_turn::Content::Action(
                                    pb::SynapseActionContent {
                                        action: "ask_os3".into(),
                                        input: "{}".into(),
                                        source: pb::SynapseSource::Server as i32,
                                        ..Default::default()
                                    },
                                ))),
                                Ok(turn(pb::synapse_chat_turn::Content::Observation(
                                    pb::SynapseObservationContent {
                                        action_name: "ask_os3".into(),
                                        observation: RAW.into(),
                                        source: pb::SynapseSource::Server as i32,
                                        ..Default::default()
                                    },
                                ))),
                                Ok(turn(pb::synapse_chat_turn::Content::Action(
                                    pb::SynapseActionContent {
                                        action: "Respond".into(),
                                        input: serde_json::json!({"Response": SPOKEN}).to_string(),
                                        source: pb::SynapseSource::Device as i32,
                                        ..Default::default()
                                    },
                                ))),
                            ];
                            Ok(tonic::Response::new(tokio_stream::iter(messages)))
                        },
                        &headers,
                        payload,
                    )
                    .await
                    .map(Json)
                },
            ),
        );
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/demo-api/trace")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"text":"What did OS3 find?"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let trace: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let steps = trace["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[1]["text"], RAW, "preserve the actual wire result");
        assert_eq!(
            steps[1]["speakable_text"], SPOKEN,
            "use the same formatting the stock Respond action speaks"
        );
        assert_eq!(steps[2]["text"], SPOKEN);
        assert_eq!(trace["reply"], SPOKEN);
        assert!(steps[0].get("speakable_text").is_none());
        assert!(steps[2].get("speakable_text").is_none());
    }
}
