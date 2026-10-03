//! Stock-facing **bidirectional** assistant transport for
//! `AIBusService.BidirectionalStreamingUnderstand`, built on the same turn
//! engine as `engine.rs`.
//!
//! Same loop, different division of labour. On the legacy server-stream
//! `Understand` the server runs the *whole* loop and the device dispatches only
//! the final action of the batch (a **positional** rule). On bidi the server
//! cannot execute device tools, so it drives the loop **cooperatively** and the
//! rule becomes **explicit**: every emitted turn is an
//! `IntermediateEvent{event, agent, requires_response}` and the device's
//! `TaoEventRegistrar.onIntermediateEvent` branches on that flag,
//! `action && requires_response` → `dispatchAction` (the pin actually runs it and
//! owes us an observation), `action && !requires_response` → `recordAction`
//! (history only. The server already ran it), `observation` → `recordObservation`.
//! `SynapseBidirectionalStreamingSession$1.onNext` mirrors this on the transport
//! side: it queues every event and completes the outstanding device future ONLY
//! when one arrives with `requires_response == true`, then resets the queue. So
//! `requires_response=true` is the wire-level definition of "device, execute this
//! and hand me the result before I can continue", and each device turn is
//! terminated by **exactly one** such event.
//!
//! Contract points this session machine therefore honors:
//!   1. **A device-catalog tool PAUSES the server.** It is emitted with
//!      `requires_response=true` and the session then *waits* on the request
//!      stream for `StreamingUnderstandRequest{observation}`. The server never
//!      executes it and never fabricates its observation.
//!   2. **A server tool does not pause the server.** It is executed inline and
//!      streamed as two `requires_response=false` informational events (the action
//!      node, then its observation node) purely as context/latency mask, and the
//!      loop continues immediately (state machine 4a).
//!   3. **`Respond` is terminal, not a pause.** `Respond` *is* a device action, so
//!      it must contain `requires_response=true` or the device would merely
//!      `recordAction` it and never speak. But its device-side observation is
//!      FINAL, and `LanguageUnderstanding.onObservation` short-circuits on a final
//!      observation (ends the run without re-understanding), so the device never
//!      posts it back. Waiting for it would hang the session forever. The run
//!      therefore ends the moment `Respond` is emitted (state machine 4c/6).
//!   4. **Observation-to-action matching** is by `parent_identifier == action.identifier`
//!      ("Key decisions" #10). An observation naming some other action is stale /
//!      superseded work and is discarded, mirroring `RunManager.shouldDispatchCurrent`.
//!   5. **Server-held run state.** Unlike legacy (stateless per RPC. The device
//!      replays the whole transcript every hop), on bidi the device sends the full
//!      `device_context` only in the initial `understanding_request` and thereafter
//!      only observation deltas, so the transcript is accumulated here for the
//!      life of the stream and discarded on close (§3).
//!   6. **Loop guard.** The same action budget as legacy (`ai_bus.max_action_turns`,
//!      default 8). Exceeding it yields a `TooManyActions` observation converted
//!      into a terminal `Respond`, mirroring `Switchboard`'s runaway guard where
//!      `Respond` is exempt so the agent can always answer.
//!   7. **Honest termination.** A client half-close or a stream error half-closes
//!      the response stream (state machine 7, ABORTED), we never invent the
//!      observation we did not receive. Running out of wall clock does not
//!      fabricate one either, but it is not silent: a run that exhausts
//!      `RUN_BUDGET` (including while parked on a device action) ends in the
//!      terminal `Respond` containing `ERROR_TIMEOUT`, the same string the device
//!      speaks for itself when its own deadline fires. A bare half-close here
//!      would leave the wearer with nothing at all.
//!
//! Deliberately NOT emitted: `Interstitial`. This shipped client's bidi observer
//! early-returns on any non-`intermediate_event` response, so server interstitials
//! are received and dropped (§1, edge cases). We also host no interstitial model,
//! and emitting filler we cannot generate honestly would be noise on the wire.
//!
//! Also not consumed: `StreamingUnderstandRequest.initial_run_state`. It is the
//! explicit resume/seed hook for priming `RunState.agent_to_runs`, but the shipped
//! device never sends it (§3) and we host no per-agent run history to rehydrate
//! into, so we accept and skip it rather than pretend to. It now DECODES
//! faithfully at least: `agent_to_runs` is `map<string, Runs>`, not the opaque
//! `bytes` this deployment modelled it as, which silently kept only the last
//! agent's entry.

use std::sync::Arc;
use std::time::Duration;

use cosmos_protocol::aibus as pb;
use tokio::sync::mpsc::Sender;
use tokio_stream::{Stream, StreamExt, wrappers::ReceiverStream};
use tonic::Status;

use super::catalog;
use super::engine::{ERROR_TIMEOUT, NO_ANSWER, TOO_MANY_ACTIONS};
use super::llm::{ChatMessage, ChatModel, ChatResponse, Role, ToolCall, ToolDef};
use super::runtime::{ForegroundRun, RouteClass, TERMINAL_RESERVE, Transport};
use super::turn::context::{MEMORY_CONTEXT_POLICY, situation_line, wearer_memory};
use super::turn::frames::{action_turn, now_ts, observation_turn};
use super::turn::text::{model_facing_observation, spoken_text};
use crate::services::gates::{self, BlockingObservation, Entitlement};

/// cosmos's `ai_bus.max_action_turns` feature flag defaults to 8 (same budget the
/// legacy engine enforces).
const MAX_STEPS: usize = 8;

/// Per-model-step ceiling, shared with the legacy engine. It bounds one
/// provider round trip independently of the Hooked 90-second device session.
const MODEL_STEP_TIMEOUT: std::time::Duration = super::runtime::MODEL_STEP_LIMIT;

/// Total wall-clock budget for one run, the same 70s the legacy engine bounds a
/// turn with and the same inner-loop budget as the Pin runtime.
///
/// gRPC does not impose it here, `AIBusService.bidirectionalStreamingUnderstand`
/// sets no `withDeadlineAfter`, unlike `understand`/`encryptedUnderstand`, and
/// that is precisely why the server has to. With no budget the loop could spend
/// eight steps at the per-step ceiling plus unbounded tool time while
/// `SynapseInterpreter.getNextDeviceActionResponse` sits in an UNBOUNDED
/// `responseFuture.get()`: the wearer's turn simply never comes back. Bounding
/// the run at the same 70s the other transports use keeps the two transports
/// answering on the same clock, and always leaves room to speak a terminal
/// before giving up.
const RUN_BUDGET: Duration = super::runtime::FOREGROUND_BUDGET;

/// Below this there is no useful work left to start, anything begun now would
/// overrun the budget before it could be spoken.
const MIN_USEFUL_REMAINING: Duration = super::runtime::MIN_USEFUL_REMAINING;

/// Bounced back in place of a server tool's result when the tool does not return
/// inside the run's remaining budget. Not spoken directly (only `TooManyActions`
/// is respoken by the device). It tells the model the step produced nothing so it
/// answers from what it has rather than treating the gap as a result.
const TOOL_TIMED_OUT: &str = "The tool did not return in time.";

/// The exact observation the stock device bounces back when an emitted action does
/// not resolve in its `SchemaCatalog` (`JsonResolver.resolve` → null).
const UNRECOGNIZED_FUNCTION: &str = "Unrecognized function name and/or arguments";

/// `IntermediateEvent.agent`, the server's label for which sub-agent produced a
/// turn, a key into its own `RunState.agent_to_runs`. The device never reads it
/// (no callers of `getAgent()` anywhere in the client), and cosmos's agent-string
/// taxonomy is server-defined and not recoverable, so this clone names its single
/// agent itself.
const AGENT: &str = "assistant";

/// The ceiling on one wait for a device observation. Stock
/// `AIBusService.bidirectionalStreamingUnderstand` sets no deadline on this
/// stream (unlike `understand`, whose `AIMIC_TIMEOUT_MS` the Compatibility Layer
/// raises to 90 s in `AgenticSessionDeadlineHooks`), so the only clock is the
/// run's own: a wait may use whatever the run has left, and the session still
/// speaks before the budget ends. The stock 25 s `AIMIC_TIMEOUT_MS` no longer
/// bounds anything on a Luma Pin, so it is not a ceiling here either.
const DEVICE_OBSERVATION_TIMEOUT: Duration = RUN_BUDGET;

/// Outbound buffer depth, matching the `Understand` handler.
const CHANNEL_DEPTH: usize = 16;

/// One open `BidirectionalStreamingUnderstand` stream: a long-lived session that
/// may contain several request/observation exchanges (a new
/// `SynapseBidirectionalStreamingSession` is created on the device only when the
/// previous one has completed, so the stream outlives a single run).
pub struct BidiSession {
    model: Arc<dyn ChatModel>,
    tx: Sender<Result<pb::StreamingUnderstandResponse, Status>>,
    device_timeout: Duration,
    /// Wall clock for ONE run (see [`RUN_BUDGET`]), reset per run rather than per
    /// session, the stream serves several turns and the wearer's patience is
    /// per turn.
    run_budget: Duration,
    /// The caller's account verdict, resolved once per RPC by the handler exactly
    /// as `Understand` and `ServerStatefulUnderstand` do. Without it this
    /// transport served every caller as fully subscribed and authorized, a
    /// request that reached the handler with no principal included.
    entitlement: Entitlement,
    /// Whose data the server-side tools operate on. Without it `recall_memory`
    /// and every other wearer-scoped tool can only report having nothing.
    tools: catalog::ToolContext,
}

/// How a run ended, from the session's point of view.
/// Outcome of one bounded, preemptible model step.
enum Step {
    /// The model produced a turn.
    Answer(ChatResponse),
    /// A new understanding request arrived. Abandon this run for it.
    Superseded(Box<pb::SynapseUnderstandingRequest>),
    /// Model error or step deadline, classified without provider response text.
    Failed(&'static str),
}

enum ToolBatchStep {
    Observations(Vec<String>),
    Superseded(Box<pb::SynapseUnderstandingRequest>),
    Disconnected,
}

enum Flow {
    /// The run reached its terminal action. The stream stays open for another
    /// exchange (device-side session reuse).
    Done,
    /// A fresh `understanding_request` arrived while a device action was pending:
    /// the new user turn supersedes the in-flight run (a turn that is its own root
    /// starts a new run. Work outside the active run is discarded).
    Supersede(Box<pb::SynapseUnderstandingRequest>),
    /// Client hung up, the stream errored, or the turn deadline expired: half-close.
    Closed,
}

/// What the session got while paused on a `requires_response=true` device action.
enum Awaited {
    /// The device executed the action and returned its observation.
    Observation {
        /// The device-minted turn id, which becomes the next parent in the DAG.
        id: String,
        content: pb::SynapseObservationContent,
    },
    Supersede(Box<pb::SynapseUnderstandingRequest>),
    Closed,
}

impl BidiSession {
    /// Drive a real gRPC bidi stream. Returns the response stream to hand back to
    /// tonic. The session runs on its own task and half-closes by dropping the
    /// sender.
    /// `entitlement` and `tools` are the same per-request state the other two
    /// transports resolve (`AiBusMain::entitlement_for` / `AiBusMain::tool_context`)
    /// and are required, not defaulted: a caller that could omit them would
    /// silently reopen the ungated path this transport used to have.
    pub fn spawn(
        model: Arc<dyn ChatModel>,
        entitlement: Entitlement,
        tools: catalog::ToolContext,
        inbound: tonic::Streaming<pb::StreamingUnderstandRequest>,
    ) -> ReceiverStream<Result<pb::StreamingUnderstandResponse, Status>> {
        Self::spawn_with(model, entitlement, tools, inbound)
    }

    /// Transport-agnostic entry point: `spawn` is the thin `tonic::Streaming`
    /// wrapper over this, which lets the session machine be driven by any request
    /// stream (and therefore tested without standing up a gRPC connection).
    pub fn spawn_with<S>(
        model: Arc<dyn ChatModel>,
        entitlement: Entitlement,
        tools: catalog::ToolContext,
        inbound: S,
    ) -> ReceiverStream<Result<pb::StreamingUnderstandResponse, Status>>
    where
        S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Send + 'static,
    {
        Self::spawn_tuned(
            model,
            entitlement,
            tools,
            inbound,
            RUN_BUDGET,
            DEVICE_OBSERVATION_TIMEOUT,
        )
    }

    /// The same session machine with its two clocks passed in, so the deadline
    /// guards can be exercised without spending the real 70 seconds. Production
    /// always goes through `spawn_with`, which supplies the real values.
    fn spawn_tuned<S>(
        model: Arc<dyn ChatModel>,
        entitlement: Entitlement,
        tools: catalog::ToolContext,
        inbound: S,
        run_budget: Duration,
        device_timeout: Duration,
    ) -> ReceiverStream<Result<pb::StreamingUnderstandResponse, Status>>
    where
        S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Send + 'static,
    {
        let (tx, rx) = tokio::sync::mpsc::channel(CHANNEL_DEPTH);
        let mut session = Self {
            model,
            tx,
            device_timeout,
            run_budget,
            entitlement,
            tools,
        };
        tokio::spawn(async move {
            let mut inbound = Box::pin(inbound);
            session.drive(&mut inbound).await;
        });
        ReceiverStream::new(rx)
    }

    /// Session loop: serve runs until the request stream ends or a run reports the
    /// client is gone. Dropping `self.tx` on return is the server's half-close.
    async fn drive<S>(&mut self, inbound: &mut S)
    where
        S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Unpin,
    {
        let Some(mut next) = next_request(inbound).await else {
            return;
        };
        loop {
            match self.run_turn(*next, inbound).await {
                Flow::Done => match next_request(inbound).await {
                    Some(req) => next = req,
                    None => return,
                },
                Flow::Supersede(req) => next = req,
                Flow::Closed => return,
            }
        }
    }

    /// One run: `understanding_request` → thought/action/observation loop →
    /// terminal `Respond`. Every emitted turn is an `IntermediateEvent`. The flag
    /// on it is what tells the device whether to execute or merely record.
    /// One model step, bounded and preemptible. `step_timeout` is already clamped
    /// to whatever is left of the run budget, so a single step can never spend
    /// time the run does not have.
    async fn step<S>(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
        step_timeout: Duration,
        inbound: &mut S,
    ) -> Step
    where
        S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Unpin,
    {
        let mut pending = Box::pin(tokio::time::timeout(
            step_timeout,
            self.model.complete(messages, tools),
        ));
        // Once the request side is done we stop racing it, a half-close means
        // "the client has finished sending", not "abandon this run". The server
        // still owes the wearer an answer on the response stream.
        let mut inbound_open = true;

        loop {
            if !inbound_open {
                return match pending.await {
                    Ok(Ok(r)) => Step::Answer(r),
                    Ok(Err(error)) => Step::Failed(super::engine::model_failure_outcome(&error)),
                    Err(_) => Step::Failed("deadline"),
                };
            }
            tokio::select! {
                // Bias the inbound branch so a barge-in already queued wins over a
                // model reply landing in the same poll.
                biased;

                incoming = inbound.next() => {
                    match incoming {
                        // A new utterance is its own run root: it supersedes.
                        Some(Ok(msg)) => match msg.content {
                            Some(pb::streaming_understand_request::Content::UnderstandingRequest(
                                next,
                            )) => return Step::Superseded(Box::new(next)),
                            // Observations for a step we have not emitted yet, and
                            // run-state seeds, are not preemptive, keep waiting.
                            _ => continue,
                        },
                        // Half-close or a broken request side: stop racing, but
                        // let the in-flight step finish and be spoken.
                        Some(Err(_)) | None => {
                            inbound_open = false;
                            continue;
                        }
                    }
                }

                resolved = &mut pending => {
                    return match resolved {
                        Ok(Ok(r)) => Step::Answer(r),
                        Ok(Err(error)) => {
                            Step::Failed(super::engine::model_failure_outcome(&error))
                        }
                        Err(_) => Step::Failed("deadline"),
                    };
                }
            }
        }
    }

    async fn server_tool_batch<S, F>(
        &self,
        work: F,
        timeout: Duration,
        inbound: &mut S,
    ) -> ToolBatchStep
    where
        S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Unpin,
        F: std::future::Future<Output = Vec<String>>,
    {
        let mut pending = Box::pin(tokio::time::timeout(timeout, work));
        let mut inbound_open = true;
        loop {
            tokio::select! {
                biased;

                // Stock SynapseBidirectionalStreamingSession.close completes
                // its request observer. This half-close alone still permits a
                // response. INFERRED Luma policy: the response receiver leaving
                // cancels unheard provider work, matching the legacy engine.
                _ = self.tx.closed() => return ToolBatchStep::Disconnected,

                incoming = inbound.next(), if inbound_open => {
                    match incoming {
                        Some(Ok(message)) => match message.content {
                            Some(pb::streaming_understand_request::Content::UnderstandingRequest(
                                request,
                            )) => return ToolBatchStep::Superseded(Box::new(request)),
                            _ => continue,
                        },
                        Some(Err(_)) | None => inbound_open = false,
                    }
                }

                resolved = &mut pending => {
                    return ToolBatchStep::Observations(resolved.unwrap_or_default());
                }
            }
        }
    }

    async fn run_turn<S>(
        &mut self,
        mut req: pb::SynapseUnderstandingRequest,
        inbound: &mut S,
    ) -> Flow
    where
        S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Unpin,
    {
        let mut run = ForegroundRun::with_budget(Transport::Bidi, RouteClass::A1, self.run_budget)
            .with_model(self.model.provenance());
        let location_allowed =
            super::turn::context::apply_location_privacy(&mut req, &self.tools, run.deadline())
                .await;
        // Server-owned catalog for this run: our tool set minus `excluded_tools`.
        let mut tools = resolve_catalog(&req, &self.entitlement);
        let request_locked = super::policy::request_is_locked(&req);

        // The wearer's own words, kept for required-slot backfill (see the device
        // branch below): the agent entry points take the request verbatim, so the
        // utterance is the faithful fill rather than an invention.
        let utterance = super::engine::current_utterance(&req).to_owned();
        catalog::scope_tickle_to_exact_request(&mut tools, &utterance);
        catalog::scope_explanation_to_non_device_tools(&mut tools, &utterance);
        let bounded_music_research = super::intents::prefer_one_music_research_tool(
            &mut tools,
            &utterance,
            self.tools.answer_engine_available,
        );
        // The legacy engine's closed D1 routes run here too, before any model
        // step: device reads, safe stock actions, the world clock, nutrition,
        // and clock agents (`engine::deterministic_device_action`). Its
        // location-first step stays with `location_preflight` below, which also
        // knows a position the Pin already reported on this stream. The canned
        // Tickle and forecast answers are settled before the loop.
        let mut deterministic_action = super::engine::deterministic_device_action(&req, &tools)
            .filter(|action| action.name != "GetCurrentLocation");

        // Root the run on the user-request turn the device replayed. With no device
        // context the first server turn self-roots rather than pointing at an id we
        // never emitted.
        let mut parent = req
            .device_context
            .as_ref()
            .and_then(|dc| dc.turns.last())
            .map(|t| t.identifier.clone())
            .unwrap_or_default();

        // Seed the run's action count from the transcript the device replayed,
        // exactly as the legacy engine does. `Switchboard` counts actions over the
        // whole RUN, and a multi-hop run arrives here with earlier hops already in
        // `device_context.turns`. Counting only the steps taken inside this process
        // lets the server ride past the pin's own `mActionLimit`, at which point the
        // device cuts the run short itself, the wearer's turn dies mid-flight with
        // no terminal from us.
        let mut actions_in_run = req
            .device_context
            .as_ref()
            .map(|dc| super::engine::actions_in_current_run(&dc.turns))
            .unwrap_or(0);
        // A device observation re-enters the model's context mid-run on this
        // transport without adding to `actions_in_run`.
        let mut device_observed_in_run = false;

        // An addressed OS3 request ("ask OS3 to …") is a closed first-step
        // route here too, before any model step. A companion request that
        // never names OS3 stays model-led through the `ask_os3` tool. Both
        // routes cross the same foreground-runtime seam for their
        // absolute clock and content-free production-plane provenance.
        let future_weather = super::intents::unanswerable_forecast_request(&utterance);
        let tickle_near_miss = super::intents::tickle_near_miss_request(&utterance);
        let os3_first_step =
            actions_in_run == 0 && tools.iter().any(|tool| tool.name == catalog::OS3_TOOL);
        let contextual_os3 = if os3_first_step
            && !request_locked
            && super::policy::preceding_run_contains_tool(
                req.device_context.as_ref(),
                catalog::OS3_TOOL,
            ) != Some(false)
        {
            catalog::resolve_os3_follow_up(
                &utterance,
                &self.tools,
                run.deadline().checked_sub(super::engine::ANSWER_RESERVE),
            )
            .await
        } else {
            Ok(None)
        };
        let contextual_intent = contextual_os3.as_ref().ok().copied().flatten();
        let explicit_os3 = os3_first_step
            && (super::llm::explicit_os3_request(&utterance)
                || contextual_intent.is_some()
                || contextual_os3.is_err());
        run.set_route(
            if explicit_os3 || future_weather || tickle_near_miss || deterministic_action.is_some()
            {
                RouteClass::D1
            } else {
                RouteClass::A1
            },
        );
        let run_deadline = run.deadline();
        let mut tool_context = self.tools.clone();
        tool_context.os3_follow_up = contextual_intent;
        if !location_allowed {
            tool_context.location = None;
        }
        tool_context.deadline = Some(run_deadline);
        // The wearer's position for the location-taking tools: the request's
        // own field when a client sets it (the legacy handlers read the same),
        // else the `GetCurrentLocation` observation the Pin replayed. A stock
        // Pin on this transport sends its position only as that observation.
        if let Some(location) = req
            .location
            .as_ref()
            .map(|location| (location.latitude, location.longitude))
            .or_else(|| {
                req.device_context
                    .as_ref()
                    .and_then(|context| catalog::replayed_location(&context.turns))
            })
        {
            tool_context.location = Some(location);
        }
        // With no position yet, the engine's location-first step runs here too,
        // before the first model step. Its observation sets the position.
        let mut location_preflight = tool_context
            .location
            .is_none()
            .then(|| super::engine::location_preflight(&req, &tools))
            .flatten();
        let mut initial_model_retry_available = true;
        let mut music_research_completed = false;
        let mut music_provider_retry_available = true;
        let mut music_provider_retry_pending = false;
        let mut completed_server_calls = std::collections::HashMap::<String, String>::new();

        // Explicit OS3 delegation is a closed first-step route. It cannot wait
        // for a model to select or rewrite it, and the bounded OS3 observation
        // is already the wearer-safe answer. Race the backend against a new
        // request exactly like every other bidi server-tool step.
        if !explicit_os3 && !location_allowed && super::engine::automatic_location_request(&req) {
            run.set_route(RouteClass::D1);
            let flow = self
                .finish(parent, super::engine::LOCATION_PRIVACY_RESPONSE)
                .await;
            run.finish_recorded("blocked", &self.tools).await;
            return flow;
        }

        let local_os3_answer = match &contextual_os3 {
            Ok(Some(super::llm::Os3FollowUp::OwnerInput)) => {
                Some(catalog::OS3_OWNER_INPUT_DIRECTION)
            }
            Err(error) => Some(error.observation()),
            _ => None,
        };
        if let Some(answer) = local_os3_answer {
            // Stock RespondActionHandler.handleAction speaks through the
            // narrator. INFERRED: permission acknowledgements stay local on
            // this transport too. No chat or answeredCard is submitted.
            let flow = self.finish(parent, answer).await;
            run.finish_recorded("answered", &self.tools).await;
            return flow;
        }
        if explicit_os3 {
            let call = ToolCall {
                name: catalog::OS3_TOOL.to_owned(),
                arguments: "{}".to_owned(),
            };
            let action_id = self.next_id();
            run.note_tool_call(catalog::OS3_TOOL);
            if self
                .emit(
                    action_turn(
                        &call,
                        "The wearer explicitly asked OS3",
                        parent,
                        action_id.clone(),
                        pb::SynapseSource::Server,
                    ),
                    false,
                )
                .await
                .is_err()
            {
                run.finish_recorded("cancelled", &self.tools).await;
                return Flow::Closed;
            }
            tool_context.first_step_request = Some(utterance.clone());
            let timeout = run_deadline
                .saturating_duration_since(std::time::Instant::now())
                .saturating_sub(TERMINAL_RESERVE);
            let work = futures_util::future::join_all(std::iter::once(catalog::execute_tool_with(
                catalog::OS3_TOOL,
                "{}",
                &tool_context,
            )));
            let observations = match self.server_tool_batch(work, timeout, inbound).await {
                ToolBatchStep::Observations(observations) => observations,
                ToolBatchStep::Disconnected => {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return Flow::Closed;
                }
                ToolBatchStep::Superseded(request) => {
                    run.finish_recorded("superseded", &self.tools).await;
                    return Flow::Supersede(request);
                }
            };
            let timed_out = observations.is_empty();
            let observation = observations
                .into_iter()
                .next()
                .unwrap_or_else(|| TOOL_TIMED_OUT.to_owned());
            let observation_id = self.next_id();
            if self
                .emit(
                    observation_turn(
                        catalog::OS3_TOOL,
                        &observation,
                        action_id,
                        observation_id.clone(),
                        pb::SynapseSource::Server,
                    ),
                    false,
                )
                .await
                .is_err()
            {
                run.finish_recorded("cancelled", &self.tools).await;
                return Flow::Closed;
            }
            let flow = self.finish(observation_id, &observation).await;
            run.finish_recorded(if timed_out { "deadline" } else { "answered" }, &self.tools)
                .await;
            return flow;
        }

        // The legacy engine speaks these as its deterministic `Respond` device
        // action, so both transports label the run the same way.
        if future_weather {
            let flow = self
                .finish(parent, super::intents::FUTURE_WEATHER_UNAVAILABLE)
                .await;
            run.finish_recorded("device_action", &self.tools).await;
            return flow;
        }
        if tickle_near_miss {
            let flow = self
                .finish(parent, super::intents::TICKLE_NEAR_MISS_RESPONSE)
                .await;
            run.finish_recorded("device_action", &self.tools).await;
            return flow;
        }
        // Seed the transcript from `device_context.turns` (the server seeds its own
        // RunState this way on the first request of a stream, §3) and grow it in
        // place as the loop proceeds, on bidi the device sends only deltas after
        // this point. Optional memory loading is bounded inside the same absolute
        // foreground clock. Personalization may degrade, the turn may not hang.
        // A locked Pin gets none, as on the legacy engine: stock refuses the
        // notes read on the keyguard (`ManageMemoryAction`).
        let mut messages = build_history(&req);
        if !request_locked
            && let Ok(Some(memory)) =
                tokio::time::timeout(run.context_timeout(), wearer_memory(&self.tools)).await
        {
            messages.push(ChatMessage::system(MEMORY_CONTEXT_POLICY));
            messages.push(memory);
        }

        for _ in 0..MAX_STEPS {
            // Out of wall clock: speak a terminal NOW. On this transport nothing
            // else will, the pin is parked in an unbounded `responseFuture.get()`
            // and a half-close would complete it with an empty queue, i.e.
            // silence.
            let budget_left = run_deadline.saturating_duration_since(std::time::Instant::now());
            if budget_left < MIN_USEFUL_REMAINING {
                let flow = self.finish(parent, ERROR_TIMEOUT).await;
                run.finish_recorded("deadline", &self.tools).await;
                return flow;
            }

            // Race the model step against the inbound stream. Two reasons:
            //
            //  * PREEMPTION, cosmos allows exactly one active run
            //    (`RunManager.shouldDispatchCurrent`: a turn that is its own root
            //    replaces `mExecutingRun` and every turn of the old run is then
            //    blocked as an orphan). If the wearer barges in with a new
            //    request, this run is abandoned *now* rather than grinding out a
            //    full action budget and then speaking an answer to a question
            //    that was superseded.
            //  * DEADLINE, an unbounded upstream call burns the wearer's whole
            //    turn. The device tears it down at its Hooked 90s AIMIC deadline and
            //    they hear nothing. A bounded step leaves room to speak an apology.
            //
            // The step ceiling is the SMALLER of the per-step ceiling and what is
            // left of the run: letting a 20s step start with only 3s left would
            // overrun the budget by 17s and leave no time to speak the result.
            let resp = if let Some(action) = deterministic_action
                .take()
                .or_else(|| location_preflight.take())
            {
                ChatResponse {
                    content: None,
                    thought: action.thought.to_owned(),
                    tool_call: Some(ToolCall {
                        name: action.name.to_owned(),
                        arguments: action.input,
                    }),
                    extra_tool_calls: Vec::new(),
                }
            } else {
                run.note_model_step();
                let model_step_budget = if music_provider_retry_pending {
                    super::engine::music_extraction_step_timeout(budget_left)
                } else {
                    budget_left
                        .saturating_sub(Duration::from_millis(750))
                        .min(MODEL_STEP_TIMEOUT)
                };
                match self
                    .step(
                        &messages,
                        &tools,
                        // Same rule as the server-stream engine: a step gets the
                        // budget it has (minus streaming reserve), bounded by the
                        // anti-hang ceiling, not a fixed cap that fires with budget
                        // to spare.
                        model_step_budget,
                        inbound,
                    )
                    .await
                {
                    Step::Superseded(req) => {
                        run.finish_recorded("superseded", &self.tools).await;
                        return Flow::Supersede(req);
                    }
                    Step::Answer(r) => {
                        music_provider_retry_pending = false;
                        r
                    }
                    Step::Failed(outcome) => {
                        if initial_model_retry_available
                            && outcome == "model_unreachable"
                            && !super::llm::current_request_has_tool_result(&messages)
                            && run_deadline.saturating_duration_since(std::time::Instant::now())
                                > TERMINAL_RESERVE
                        {
                            initial_model_retry_available = false;
                            continue;
                        }
                        if let Some(tool_call) =
                            super::llm::required_retrieval_after_model_failure(&messages, &tools)
                        {
                            tracing::warn!(
                                tool = %tool_call.name,
                                "bidi model step failed before a required retrieval; continuing with the guarded call"
                            );
                            ChatResponse {
                                content: None,
                                thought: String::new(),
                                tool_call: Some(tool_call),
                                extra_tool_calls: Vec::new(),
                            }
                        } else {
                            if super::llm::current_request_has_tool_result(&messages) {
                                let retry_budget = run_deadline
                                    .saturating_duration_since(std::time::Instant::now())
                                    .saturating_sub(TERMINAL_RESERVE)
                                    .min(MODEL_STEP_TIMEOUT);
                                if !retry_budget.is_zero() {
                                    let mut final_messages = messages.clone();
                                    final_messages.push(ChatMessage::user(
                                        super::engine::FINAL_ANSWER_DIRECTIVE,
                                    ));
                                    run.note_model_step();
                                    match self
                                        .step(&final_messages, &[], retry_budget, inbound)
                                        .await
                                    {
                                        Step::Superseded(request) => {
                                            run.finish_recorded("superseded", &self.tools).await;
                                            return Flow::Supersede(request);
                                        }
                                        Step::Answer(recovered) => {
                                            if let Some(answer) = recovered
                                                .content
                                                .as_deref()
                                                .map(str::trim)
                                                .filter(|answer| !answer.is_empty())
                                            {
                                                let flow = self.finish(parent, answer).await;
                                                run.finish_recorded("answered", &self.tools).await;
                                                return flow;
                                            }
                                        }
                                        Step::Failed(_) => {}
                                    }
                                }
                            }
                            // Even a degraded state is spoken through a terminal `Respond`
                            // device action, never a bare error the device would drop.
                            let flow = self.finish(parent, ERROR_TIMEOUT).await;
                            run.finish_recorded(outcome, &self.tools).await;
                            return flow;
                        }
                    }
                }
            };

            let Some(tc) = resp.tool_call else {
                // FINISH (state machine 4c): plain content, or nothing usable at
                // all, either way the run terminates in a spoken `Respond`.
                // Blank counts as nothing usable. `RespondAction.mResponse` is a
                // present-but-empty slot, so the device resolves the action,
                // dispatches it, narrates nothing, and its observation is final,
                // a turn that "succeeds" in silence with no retry. The legacy
                // engine has guarded this since the blank-content fix. Bidi was
                // missed, so the same wearer-facing silence survived on the other
                // transport.
                let answer = resp
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|answer| !answer.is_empty())
                    .unwrap_or(NO_ANSWER);
                let flow = self.finish(parent, answer).await;
                run.finish_recorded(
                    if answer == NO_ANSWER {
                        "no_answer"
                    } else {
                        "answered"
                    },
                    &self.tools,
                )
                .await;
                return flow;
            };
            // Exclusive delegation takes no model-authored arguments: OS3
            // hears the wearer's own words through the tool context, so the
            // action the Pin sees is the same zero-argument call the backend
            // answers. `enforce_explicit_os3` normalizes every live model
            // driver. This restates the rule at the transport for any call
            // that reaches the loop unnormalized.
            let mut tc = tc;
            if catalog::is_exclusive_server_tool(&tc.name) {
                tc.arguments = "{}".to_owned();
            }
            if catalog::is_server_tool(&tc.name) && tools.iter().any(|tool| tool.name == tc.name) {
                let key = super::engine::server_tool_call_key(&tc, &tool_context);
                if let Some(previous) = completed_server_calls.get(&key) {
                    messages.push(tool_result(
                        &tc,
                        &super::engine::repeated_server_tool_observation(previous),
                    ));
                    continue;
                }
            }
            run.note_tool_call(&tc.name);

            if actions_in_run >= MAX_STEPS {
                let flow = self.too_many_actions(parent).await;
                run.finish_recorded("too_many_actions", &self.tools).await;
                return flow;
            }

            // Keyguard gate, before anything runs. A locked Pin was never offered
            // this tool, so the model invented the call. It gets stock's locked
            // refusal rather than an "unrecognized" bounce, and no backend is
            // reached.
            if let Some(blocked) = super::policy::keyguard_refusal(request_locked, &tc.name) {
                let flow = self.refuse(&tc.name, blocked, parent).await;
                run.finish_recorded(
                    if matches!(flow, Flow::Closed) {
                        "cancelled"
                    } else {
                        "locked"
                    },
                    &self.tools,
                )
                .await;
                return flow;
            }

            if !location_allowed && tc.name == "GetCurrentLocation" {
                let flow = self
                    .finish(parent, super::engine::LOCATION_PRIVACY_RESPONSE)
                    .await;
                run.finish_recorded("blocked", &self.tools).await;
                return flow;
            }

            // Unknown tool: bounce the stock unrecognized-function observation as
            // informational events and LOOP so the model can correct itself. The
            // device must not run anything here, so neither event requires a
            // response.
            if !tools.iter().any(|t| t.name == tc.name) {
                let action_id = self.next_id();
                if self
                    .emit(
                        action_turn(
                            &tc,
                            &resp.thought,
                            parent,
                            action_id.clone(),
                            pb::SynapseSource::Server,
                        ),
                        false,
                    )
                    .await
                    .is_err()
                {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return Flow::Closed;
                }
                let obs_id = self.next_id();
                if self
                    .emit(
                        observation_turn(
                            &tc.name,
                            UNRECOGNIZED_FUNCTION,
                            action_id,
                            obs_id.clone(),
                            pb::SynapseSource::Device,
                        ),
                        false,
                    )
                    .await
                    .is_err()
                {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return Flow::Closed;
                }
                messages.push(tool_result(&tc, UNRECOGNIZED_FUNCTION));
                parent = obs_id;
                continue;
            }

            // TERMINAL DEVICE ACTION. `Respond` is a device action and so must be
            // flagged `requires_response=true` (otherwise the registrar only
            // records it and the wearer hears nothing), but its device-side
            // observation is final and is never posted back, so this ends the run
            // instead of pausing on it.
            if tc.name == catalog::RESPOND_ACTION {
                let id = self.next_id();
                // `Response` is an OPTIONAL slot on the device, so a missing or
                // miscased key resolves to null and `RespondActionHandler` throws,
                // total silence on the action that ends every turn. Rebuild the
                // canonical payload rather than forwarding model arguments.
                let input = catalog::respond_input_from_arguments(&tc.arguments)
                    .unwrap_or_else(|| catalog::respond_input(NO_ANSWER));
                let turn = device_action_turn(&tc.name, &input, &resp.thought, parent, id);
                run.finish_recorded(
                    if input.contains(NO_ANSWER) {
                        "no_answer"
                    } else {
                        "answered"
                    },
                    &self.tools,
                )
                .await;
                return match self.emit(turn, true).await {
                    Ok(()) => Flow::Done,
                    Err(()) => Flow::Closed,
                };
            }

            // PAUSING DEVICE ACTION (state machine 4b). Emit exactly one
            // `requires_response=true` event and wait, the wearer's pin executes
            // it and owes us the observation on this same stream.
            if catalog::is_device_tool(&tc.name) {
                // Account gate, matching `Switchboard.routeAction`'s order and the
                // legacy engine's `gated()`. The catalog filter alone cannot cover
                // this: `Entitlement::Unauthorized` deliberately reports
                // `is_subscribed() == true`, so a de-authorized device passes the
                // subscription filter and was previously stopped only by the edge
                // AuthLayer. A blocked action is replaced by the canned degraded
                // experience, the wearer hears why instead of hitting silence.
                if let Some(blocked) = gates::gate_action(&self.entitlement, &tc.name) {
                    let flow = self.refuse(&tc.name, blocked, parent).await;
                    run.finish_recorded(
                        if matches!(flow, Flow::Closed) {
                            "cancelled"
                        } else {
                            "blocked"
                        },
                        &self.tools,
                    )
                    .await;
                    return flow;
                }
                // Required-slot validation before the action leaves the server.
                // A missing slot resolves to null on the device: the agent entry
                // points NPE in-process and the rest run an empty request, both
                // silently. Repair what we can from the wearer's own words, and
                // bounce the rest back to the model like an unrecognized tool so
                // it self-corrects here rather than on a wasted device hop.
                let input = match catalog::device_action_input(&tc.name, &tc.arguments, &utterance)
                {
                    Ok(input) => input,
                    Err(observation) => {
                        if let Some(question) =
                            catalog::clarification_question(&tc.name, &tc.arguments)
                        {
                            let spoken =
                                if super::policy::question_was_already_asked(&req, &question) {
                                    super::engine::CLARIFICATION_UNRESOLVED
                                } else {
                                    &question
                                };
                            let flow = self.finish(parent, spoken).await;
                            run.finish_recorded("clarification", &self.tools).await;
                            return flow;
                        }
                        let action_id = self.next_id();
                        if self
                            .emit(
                                device_action_turn(
                                    &tc.name,
                                    &tc.arguments,
                                    &resp.thought,
                                    parent,
                                    action_id.clone(),
                                ),
                                false,
                            )
                            .await
                            .is_err()
                        {
                            run.finish_recorded("cancelled", &self.tools).await;
                            return Flow::Closed;
                        }
                        let obs_id = self.next_id();
                        if self
                            .emit(
                                observation_turn(
                                    &tc.name,
                                    &observation,
                                    action_id,
                                    obs_id.clone(),
                                    pb::SynapseSource::Device,
                                ),
                                false,
                            )
                            .await
                            .is_err()
                        {
                            run.finish_recorded("cancelled", &self.tools).await;
                            return Flow::Closed;
                        }
                        messages.push(tool_result(&tc, &observation));
                        parent = obs_id;
                        continue;
                    }
                };
                if let Some(question) = super::policy::confirmation_question(&req, &tc.name, &input)
                {
                    let flow = self.finish(parent, &question).await;
                    run.finish_recorded("confirmation_required", &self.tools)
                        .await;
                    return flow;
                }
                let action_id = self.next_id();
                if self
                    .emit(
                        device_action_turn(
                            &tc.name,
                            &input,
                            &resp.thought,
                            parent,
                            action_id.clone(),
                        ),
                        true,
                    )
                    .await
                    .is_err()
                {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return Flow::Closed;
                }

                // Park for the observation, but never past the run's own clock:
                // the pin executing an action is time the wearer is waiting too.
                // `AIMIC_TIMEOUT_MS` remains the ceiling on a single wait (past it
                // the turn is dead on the device side as well). The run budget is
                // the ceiling on the sum of them.
                let wait_for = run_deadline
                    .saturating_duration_since(std::time::Instant::now())
                    .min(self.device_timeout);
                let awaited =
                    match tokio::time::timeout(wait_for, await_observation(inbound, &action_id))
                        .await
                    {
                        Ok(a) => a,
                        // Deadline blown. We still do not invent the observation we
                        // never received, but we do speak. A half-close here only
                        // completes the pin's pending future with an empty queue,
                        // and the wearer, who has been standing there through a
                        // whole action, hears nothing at all.
                        Err(_elapsed) => {
                            let flow = self.finish(action_id, ERROR_TIMEOUT).await;
                            run.finish_recorded("deadline", &self.tools).await;
                            return flow;
                        }
                    };
                let (obs_id, obs) = match awaited {
                    Awaited::Observation { id, content } => (id, content),
                    Awaited::Supersede(req) => {
                        run.finish_recorded("superseded", &self.tools).await;
                        return Flow::Supersede(req);
                    }
                    Awaited::Closed => {
                        run.finish_recorded("cancelled", &self.tools).await;
                        return Flow::Closed;
                    }
                };

                messages.push(tool_result(&tc, &obs.observation));
                device_observed_in_run = true;
                // Mid-stream, the device's answer to `GetCurrentLocation` is
                // the position: no new request envelope follows on this
                // transport to carry it.
                if location_allowed
                    && let Some(location) =
                        catalog::location_from_observation(&tc.name, &obs.observation)
                {
                    tool_context.location = Some(location);
                }
                if obs.is_final {
                    // A final observation ends the run on the device
                    // (`RunManager.endRun`), so re-prompting would answer into a
                    // closed run. Stop here, but HALF-CLOSE, do not park.
                    //
                    // `Flow::Done` would send `drive` back into `next_request`,
                    // waiting for a message the pin will never send: it is blocked
                    // in `SynapseInterpreter.getNextDeviceActionResponse` →
                    // `responseFuture.get()` with NO deadline
                    // (`AIBusService.bidirectionalStreamingUnderstand` sets none,
                    // unlike `understand`/`encryptedUnderstand` which both use
                    // `AIMIC_TIMEOUT_MS`). Only a server half-close completes that
                    // future: `SynapseBidirectionalStreamingSession.onCompleted`
                    // → `close()` → `finishLatch.countDown()` + completes the
                    // pending future. Parking here wedges the wearer's supervisor
                    // thread for good.
                    //
                    // Half-closing costs nothing: `SynapseInterpreter` builds a
                    // fresh session whenever the previous one `isCompleted()`, so
                    // the next turn simply opens a new stream.
                    //
                    // Reachable via `ExperienceActionRouterImpl` →
                    // `TaoEventRegistrar.onObservation(String, Observation)`,
                    // whose `toContent()` carries `setIsFinal(observation.isFinal())`
                    // through `dispatchObservation`.
                    run.finish_recorded("device_action", &self.tools).await;
                    return Flow::Closed;
                }
                // Thread onto the device's own turn id where it minted one.
                parent = if obs_id.is_empty() { action_id } else { obs_id };
                continue;
            }

            // An MCP action tool runs only for the exact call the wearer just
            // confirmed. Any other call to one is asked about and ends the run,
            // like a device action that needs confirming, before any action
            // event goes out. Every other server tool passes.
            if let Some(question) =
                super::policy::confirmation_question(&req, &tc.name, &tc.arguments)
            {
                let flow = self.finish(parent, &question).await;
                run.finish_recorded("confirmation_required", &self.tools)
                    .await;
                return flow;
            }

            // SERVER TOOLS. A same-step batch represents independent work, so
            // execute it concurrently and publish observations in stable request
            // order. The Pin counts emitted actions rather than model rounds;
            // refuse an oversized batch before partially executing it.
            //
            // Before any action of this step goes out: with nothing run yet, the
            // call can only come from the wearer's utterance, and a tool that
            // must hear only the wearer (OS3) gets those words, not the model's.
            tool_context.first_step_request =
                (actions_in_run == 0 && !device_observed_in_run).then(|| utterance.clone());
            let terminal_music = tc.name == "music_discover"
                && super::intents::explicit_playback_request(&utterance)
                && tools.iter().any(|tool| tool.name == "PlayMusic");
            // The legacy engine's reserve: start a tool only with time left to
            // run it AND turn its result into an answer. Out of that time, the
            // observations already in `messages` are answered from now.
            let tool_reserve =
                super::engine::tool_reserve_for(&tc.name, terminal_music, bounded_music_research);
            if super::engine::out_of_tool_budget_with(run_deadline, tool_reserve) {
                return self
                    .compose_from_transcript(&messages, parent, run_deadline, inbound, &mut run)
                    .await;
            }
            let mut batch = vec![tc.clone()];
            let mut batch_keys =
                std::collections::HashSet::from([super::engine::server_tool_call_key(
                    &tc,
                    &tool_context,
                )]);
            if !terminal_music && !catalog::is_exclusive_server_tool(&tc.name) {
                for extra in &resp.extra_tool_calls {
                    // A companion call a locked Pin may not run is dropped unrun,
                    // like any companion outside the offered set.
                    if catalog::is_exclusive_server_tool(&extra.name)
                        || catalog::is_device_tool(&extra.name)
                        || !catalog::is_server_tool(&extra.name)
                        || !tools.iter().any(|tool| tool.name == extra.name)
                        || super::policy::keyguard_refusal(request_locked, &extra.name).is_some()
                    {
                        continue;
                    }
                    // An action the wearer has not confirmed never rides along
                    // beside another call. The model is told, so it neither
                    // answers as if it ran nor loses the request.
                    if super::policy::confirmation_question(&req, &extra.name, &extra.arguments)
                        .is_some()
                    {
                        messages.push(tool_result(extra, super::policy::CONFIRM_ON_ITS_OWN));
                        continue;
                    }
                    let key = super::engine::server_tool_call_key(extra, &tool_context);
                    if let Some(previous) = completed_server_calls.get(&key) {
                        messages.push(tool_result(
                            extra,
                            &super::engine::repeated_server_tool_observation(previous),
                        ));
                        continue;
                    }
                    if batch_keys.insert(key) {
                        batch.push(extra.clone());
                    }
                }
            }
            if actions_in_run.saturating_add(batch.len()) > MAX_STEPS {
                let flow = self.too_many_actions(parent).await;
                run.finish_recorded("too_many_actions", &self.tools).await;
                return flow;
            }
            run.note_tool_calls(batch.len().saturating_sub(1));

            let mut action_ids = Vec::with_capacity(batch.len());
            for call in &batch {
                let action_id = self.next_id();
                if self
                    .emit(
                        action_turn(
                            call,
                            &resp.thought,
                            parent.clone(),
                            action_id.clone(),
                            pb::SynapseSource::Server,
                        ),
                        false,
                    )
                    .await
                    .is_err()
                {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return Flow::Closed;
                }
                action_ids.push(action_id);
            }
            actions_in_run += batch.len();

            // Each tool is bounded on its own, leaving the reserve: a stalled
            // backend yields `TOOL_TIMED_OUT` for its call only, and the
            // results the others returned are still answered from. The batch
            // wait itself only races the inbound stream for a barge-in. Its
            // cap is the run's end, which the per-tool bounds always beat.
            let remaining = run_deadline.saturating_duration_since(std::time::Instant::now());
            let tool_timeout = remaining.saturating_sub(tool_reserve);
            let work = futures_util::future::join_all(batch.iter().map(|call| {
                bounded_tool(
                    tool_timeout,
                    catalog::execute_tool_with(&call.name, &call.arguments, &tool_context),
                )
            }));
            let observations = match self.server_tool_batch(work, remaining, inbound).await {
                ToolBatchStep::Observations(observations) => observations,
                ToolBatchStep::Disconnected => {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return Flow::Closed;
                }
                ToolBatchStep::Superseded(request) => {
                    run.finish_recorded("superseded", &self.tools).await;
                    return Flow::Supersede(request);
                }
            };
            if observations.len() != batch.len() {
                return self
                    .compose_from_transcript(&messages, parent, run_deadline, inbound, &mut run)
                    .await;
            }

            let mut primary_observation = None;
            for ((call, action_id), observation) in batch.iter().zip(action_ids).zip(observations) {
                let obs_id = self.next_id();
                if self
                    .emit(
                        observation_turn(
                            &call.name,
                            &observation,
                            action_id,
                            obs_id.clone(),
                            pb::SynapseSource::Server,
                        ),
                        false,
                    )
                    .await
                    .is_err()
                {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return Flow::Closed;
                }
                if call.name == tc.name && primary_observation.is_none() {
                    primary_observation = Some(observation.clone());
                }
                messages.push(tool_result(call, &observation));
                completed_server_calls.insert(
                    super::engine::server_tool_call_key(call, &tool_context),
                    observation.clone(),
                );
                parent = obs_id;
            }
            if bounded_music_research
                && batch
                    .iter()
                    .any(|call| matches!(call.name.as_str(), "web_search" | "ask_online"))
            {
                super::intents::retire_music_research_tools(&mut tools);
                music_research_completed = true;
            }
            for call in &batch {
                super::intents::retire_completed_single_reads(&mut tools, &utterance, &call.name);
            }

            if catalog::server_tool_observation_ends_run(&tc.name) {
                let observation = primary_observation.as_deref().unwrap_or(TOOL_TIMED_OUT);
                let flow = self.finish(parent, observation).await;
                run.finish_recorded("answered", &self.tools).await;
                return flow;
            }

            if terminal_music {
                let observation = primary_observation.as_deref().unwrap_or(TOOL_TIMED_OUT);
                if let Some(input) =
                    crate::backends::music_discovery::play_music_arguments(observation)
                {
                    let id = self.next_id();
                    let turn = device_action_turn(
                        "PlayMusic",
                        &input,
                        "I found a provider-verified track to play",
                        parent,
                        id,
                    );
                    run.finish_recorded("device_action", &self.tools).await;
                    return match self.emit(turn, true).await {
                        Ok(()) => Flow::Done,
                        Err(()) => Flow::Closed,
                    };
                }
                if music_research_completed
                    && super::engine::can_retry_music_provider_miss(
                        music_provider_retry_available,
                        observation,
                        run_deadline.saturating_duration_since(std::time::Instant::now()),
                    )
                {
                    music_provider_retry_available = false;
                    music_provider_retry_pending = true;
                    continue;
                }
                let spoken = if observation == TOOL_TIMED_OUT {
                    crate::backends::music_discovery::MusicDiscoveryError::Deadline.observation()
                } else {
                    crate::backends::music_discovery::spoken_failure(observation).unwrap_or_else(
                        || {
                            crate::backends::music_discovery::MusicDiscoveryError::NoEvidence
                                .observation()
                        },
                    )
                };
                let flow = self.finish(parent, spoken).await;
                run.finish_recorded("answered", &self.tools).await;
                return flow;
            }

            if actions_in_run >= MAX_STEPS {
                let flow = self.too_many_actions(parent).await;
                run.finish_recorded("too_many_actions", &self.tools).await;
                return flow;
            }
        }

        // Budget exhausted: close the run the way `Switchboard` does, a
        // `TooManyActions` observation converted into a terminal `Respond`
        // (`Respond` is exempt from the action limit).
        let flow = self.too_many_actions(parent).await;
        run.finish_recorded("too_many_actions", &self.tools).await;
        flow
    }

    /// Out of time to start another tool: one model step, with no tools, turns
    /// what the run already observed into an answer, as the legacy engine's
    /// `compose_final_answer` does. The device's timeout string is spoken only
    /// when that step cannot finish inside the run.
    async fn compose_from_transcript<S>(
        &mut self,
        messages: &[ChatMessage],
        parent: String,
        run_deadline: std::time::Instant,
        inbound: &mut S,
        run: &mut ForegroundRun,
    ) -> Flow
    where
        S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Unpin,
    {
        let budget = run_deadline
            .saturating_duration_since(std::time::Instant::now())
            .saturating_sub(TERMINAL_RESERVE)
            .min(MODEL_STEP_TIMEOUT);
        if !budget.is_zero() {
            let mut final_messages = messages.to_vec();
            final_messages.push(ChatMessage::user(super::engine::FINAL_ANSWER_DIRECTIVE));
            run.note_model_step();
            match self.step(&final_messages, &[], budget, inbound).await {
                Step::Superseded(request) => {
                    run.finish_recorded("superseded", &self.tools).await;
                    return Flow::Supersede(request);
                }
                Step::Answer(recovered) => {
                    if let Some(answer) = recovered
                        .content
                        .as_deref()
                        .map(str::trim)
                        .filter(|answer| !answer.is_empty())
                    {
                        let flow = self.finish(parent, answer).await;
                        run.finish_recorded("answered", &self.tools).await;
                        return flow;
                    }
                }
                Step::Failed(_) => {}
            }
        }
        let flow = self.finish(parent, ERROR_TIMEOUT).await;
        run.finish_recorded("deadline", &self.tools).await;
        flow
    }

    async fn too_many_actions(&mut self, parent: String) -> Flow {
        let obs_id = self.next_id();
        if self
            .emit(
                observation_turn(
                    "TooManyActions",
                    TOO_MANY_ACTIONS,
                    parent,
                    obs_id.clone(),
                    pb::SynapseSource::Device,
                ),
                false,
            )
            .await
            .is_err()
        {
            return Flow::Closed;
        }
        // The observation text IS the spoken text: stock's
        // `TaoEventRegistrar.convertAndDispatchGeneratedActionIfNeeded` builds
        // `new RespondAction(UUID.randomUUID(), observation.observation())` from
        // the `TooManyActions` observation it just recorded. Speaking
        // `ERROR_TIMEOUT` here both diverged from that rule and put a different
        // sentence in the wearer's ear than the legacy engine does for the very
        // same guard, depending only on which transport the feature flag picked.
        self.finish(obs_id, TOO_MANY_ACTIONS).await
    }

    /// End the run on a gate's verdict instead of running `action`: record the
    /// non-final blocking observation, then speak the verdict.
    ///
    /// Every blocked verdict, the keyguard's and the account gate's, is
    /// delivered spoken. The legacy engine reproduces the exact action the Pin
    /// synthesizes (`InstructUnlock`, `UnauthorizedDevice`, …). Here the
    /// terminal is always the exempt `Respond`, which carries what that action
    /// would have said to the wearer ([`BlockingObservation::spoken_text`]: "Ai
    /// Pin is locked." for the keyguard) and is the shape this transport
    /// already terminates on.
    async fn refuse(&mut self, action: &str, blocked: BlockingObservation, parent: String) -> Flow {
        let obs_id = self.next_id();
        if self
            .emit(
                observation_turn(
                    action,
                    blocked.observation_text(),
                    parent,
                    obs_id.clone(),
                    pb::SynapseSource::Device,
                ),
                false,
            )
            .await
            .is_err()
        {
            return Flow::Closed;
        }
        self.finish(obs_id, blocked.spoken_text()).await
    }

    /// Emit the run's terminal `Respond`, the one event of the run the device
    /// dispatches and narrates via local TTS.
    async fn finish(&mut self, parent: String, answer: &str) -> Flow {
        let id = self.next_id();
        let turn = device_action_turn(
            catalog::RESPOND_ACTION,
            &catalog::respond_input(answer),
            "",
            parent,
            id,
        );
        match self.emit(turn, true).await {
            Ok(()) => Flow::Done,
            Err(()) => Flow::Closed,
        }
    }

    /// Stream one transcript node as an `IntermediateEvent`. `requires_response`
    /// is the whole protocol: true ⇒ the device executes this and owes an
    /// observation. False ⇒ record as history only.
    async fn emit(&self, turn: pb::SynapseChatTurn, requires_response: bool) -> Result<(), ()> {
        let msg = pb::StreamingUnderstandResponse {
            content: Some(
                pb::streaming_understand_response::Content::IntermediateEvent(
                    pb::IntermediateEvent {
                        event: Some(turn),
                        agent: AGENT.to_owned(),
                        requires_response,
                    },
                ),
            ),
        };
        self.tx.send(Ok(msg)).await.map_err(|_| ())
    }

    /// Server-minted node id.
    ///
    /// MUST be a UUID: `LocalChatTurnService.record` enforces uniqueness via
    /// `ArgChecker.throwIfContainsKey` and throws on a collision. A per-session
    /// counter restarts at 1 for each new stream while the device still holds
    /// turns from the previous one, so a sequence would eventually re-mint an id
    /// the device already has and kill the run.
    fn next_id(&mut self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

// --- request-stream consumption -------------------------------------------

/// Pull request messages until an `understanding_request` starts a run.
///
/// An `initial_run_state` is the resume/seed affordance the shipped device never
/// sends and whose payload this proto models as opaque bytes, accepted and
/// skipped. A bare observation with no run in flight has no action turn to attach
/// to (the device drops the mirror-image case) and is likewise skipped rather than
/// tearing the stream down.
async fn next_request<S>(inbound: &mut S) -> Option<Box<pb::SynapseUnderstandingRequest>>
where
    S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Unpin,
{
    while let Some(msg) = inbound.next().await {
        let Ok(msg) = msg else {
            return None; // stream error ⇒ half-close
        };
        match msg.content {
            Some(pb::streaming_understand_request::Content::UnderstandingRequest(req)) => {
                return Some(Box::new(req));
            }
            Some(pb::streaming_understand_request::Content::InitialRunState(_)) => {}
            // A device observation arriving with NO run in flight is the
            // close-out of the run we just terminated.
            //
            // After we emit the terminal `Respond`, the pin executes it and its
            // handler completes with a FINAL observation. With the bidi flag on,
            // `LanguageUnderstanding.onObservation` does not early-out on a final
            // observation, it posts it back to us and then blocks on an
            // UNBOUNDED `responseFuture.get()`, which only completes on an event
            // flagged `requires_response` or when the session closes. Silently
            // ignoring the observation therefore parks the wearer's pin for its
            // full 90s AIMIC deadline after the answer has already been spoken.
            //
            // Returning `None` drops `tx`, and the half-close makes the client's
            // `SynapseBidirectionalStreamingSession.close()` complete that future
            // with the empty queue, the turn ends cleanly. The device opens a
            // fresh session whenever the previous one has completed, so
            // half-closing costs nothing.
            Some(pb::streaming_understand_request::Content::Observation(_)) => return None,
            None => {}
        }
    }
    None
}

/// Block until the device returns the observation for `action_id`.
///
/// Matching is by `parent_identifier == action.identifier` ("Key decisions" #10):
/// an observation naming a different action belongs to a superseded step and is
/// discarded, mirroring `RunManager.shouldDispatchCurrent`. An empty parent is
/// accepted, since a client that threads nothing can only mean the pending action.
async fn await_observation<S>(inbound: &mut S, action_id: &str) -> Awaited
where
    S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Unpin,
{
    while let Some(msg) = inbound.next().await {
        let Ok(msg) = msg else {
            return Awaited::Closed;
        };
        match msg.content {
            Some(pb::streaming_understand_request::Content::Observation(turn)) => {
                if !turn.parent_identifier.is_empty() && turn.parent_identifier != action_id {
                    continue; // stale / superseded step
                }
                let id = turn.identifier;
                match turn.content {
                    Some(pb::synapse_chat_turn::Content::Observation(content)) => {
                        return Awaited::Observation { id, content };
                    }
                    // A turn posted on the observation slot that carries no
                    // observation body tells us nothing. Keep waiting.
                    _ => continue,
                }
            }
            // A new user utterance mid-run supersedes the pending action.
            Some(pb::streaming_understand_request::Content::UnderstandingRequest(req)) => {
                return Awaited::Supersede(Box::new(req));
            }
            Some(pb::streaming_understand_request::Content::InitialRunState(_)) => {}
            None => {}
        }
    }
    Awaited::Closed
}

// --- transcript reconstruction --------------------------------------------
//
// These mirror the legacy engine's request-driven setup, which is private to
// `engine.rs`. The tool catalog and system prompt themselves are reused from
// `catalog` rather than restated.

/// Our tool set minus the device's `excluded_tools` (the device sends an empty
/// `action_definitions` and only a `tool_set_version` pointer, so the server is
/// authoritative).
///
/// The keyguard and subscription filters are the account gate's *first* half and
/// are applied here rather than bolted on later: `catalog::tool_catalog_for`
/// mirrors `routeAction`'s gate order (excluded → keyguard → unsubscribed
/// whitelist), so a locked or unsubscribed caller is never even offered a tool it
/// would be blocked on.
fn resolve_catalog(
    req: &pb::SynapseUnderstandingRequest,
    entitlement: &Entitlement,
) -> Vec<ToolDef> {
    // Honour the device's `tool_set_version` pointer, exactly as the legacy
    // transport does. Today `SynapseInterpreter` only ever sends `supervisor`
    // here, so this resolves to the same flat set, but reading the pointer means
    // the two transports cannot silently diverge the moment the device sends
    // anything else.
    let set = super::engine::resolved_tool_set(req).set;
    let mut tools = catalog::tool_catalog_for_set(
        &catalog::CatalogContext {
            is_locked: req.device_context.as_ref().is_some_and(|dc| dc.is_locked),
            excluded: &req.excluded_tools,
            subscribed: entitlement.is_subscribed(),
        },
        set,
    );
    if !super::intents::explicit_playback_request(super::engine::current_utterance(req)) {
        tools.retain(|tool| tool.name != "music_discover");
    }
    tools
}

/// Rebuild the chat transcript from the state the device replayed in the initial
/// request: prior turns, `previous_answers`, and this run's utterance.
fn build_history(req: &pb::SynapseUnderstandingRequest) -> Vec<ChatMessage> {
    // Same pointer, same reason as `resolve_catalog`: the resolved set carries its
    // own spoken-style guidance, and serving its tools without its guidance would
    // give a capability the narrow tool list but none of the narrow behaviour.
    let mut messages = vec![ChatMessage::system(catalog::system_prompt_for(
        super::engine::resolved_tool_set(req).set,
    ))];
    if let Some(situation) = situation_line(req) {
        messages.push(ChatMessage::device_context(&situation));
    }

    if let Some(dc) = req.device_context.as_ref() {
        for turn in &dc.turns {
            match turn.content.as_ref() {
                Some(pb::synapse_chat_turn::Content::UserRequest(u)) => {
                    let text = if u.repaired_request.is_empty() {
                        &u.request
                    } else {
                        &u.repaired_request
                    };
                    if !text.is_empty() {
                        messages.push(ChatMessage::user(text.clone()));
                    }
                }
                Some(pb::synapse_chat_turn::Content::Action(a)) => {
                    if a.action == catalog::RESPOND_ACTION {
                        if let Some(text) = spoken_text(&a.input) {
                            messages.push(ChatMessage::assistant(text));
                        }
                    } else if !a.action.is_empty() {
                        messages.push(ChatMessage::prior_tool_call(&a.action, &a.input));
                    }
                }
                Some(pb::synapse_chat_turn::Content::Observation(o)) => {
                    if !o.observation.is_empty() {
                        messages.push(ChatMessage::tool_result(
                            &o.action_name,
                            "{}",
                            &model_facing_observation(&o.observation),
                        ));
                    }
                }
                Some(pb::synapse_chat_turn::Content::Message(m)) => {
                    if !m.content.is_empty() {
                        messages.push(ChatMessage::assistant(m.content.clone()));
                    }
                }
                _ => {}
            }
        }
    }

    for prior in &req.previous_answers {
        if !prior.is_empty() {
            messages.push(ChatMessage::assistant(prior.clone()));
        }
    }

    // The device replays the current turn's own `user_request` in
    // `device_context.turns`, so appending `utterance` again would show the model
    // the question twice, and on later hops of a multi-hop run it would land
    // AFTER the observations, reading as if the wearer had just re-asked and
    // inviting the model to restart the work it already did.
    //
    // Push it only when the replayed transcript does not already end in it. The
    // device's `repaired_request` is the authoritative text where it differs, and
    // `replay` above already preferred it.
    let utterance = super::engine::current_utterance(req);
    let already_replayed = messages
        .iter()
        .rev()
        .find(|m| m.role == Role::User)
        .is_some_and(|m| m.content == utterance);
    if !already_replayed && !utterance.is_empty() {
        messages.push(ChatMessage::user(utterance.to_owned()));
    }
    messages
}

/// Fold a tool result back into the transcript, in the same shape the legacy
/// engine uses (portable across OpenAI-compatible endpoints: no tool-call-id
/// pairing required).
fn tool_result(tc: &ToolCall, observation: &str) -> ChatMessage {
    ChatMessage::tool_result(
        &tc.name,
        &tc.arguments,
        &model_facing_observation(observation),
    )
}

/// Run a server tool under a hard ceiling.
///
/// An upstream that stalls returns an honest "no result" observation rather than
/// holding the run open, never a fabricated result.
async fn bounded_tool(
    remaining: Duration,
    work: impl std::future::Future<Output = String>,
) -> String {
    tokio::time::timeout(remaining, work)
        .await
        .unwrap_or_else(|_elapsed| TOOL_TIMED_OUT.to_owned())
}

// --- turn constructors ----------------------------------------------------

/// An action turn the DEVICE resolves (`source = DEVICE`). Emitted with
/// `requires_response=true` so `TaoEventRegistrar` dispatches rather than records
/// it. `source` is provenance metadata only, the execution trigger on this
/// transport is the flag, not the enum.
fn device_action_turn(
    action: &str,
    input: &str,
    thought: &str,
    parent: String,
    id: String,
) -> pb::SynapseChatTurn {
    pb::SynapseChatTurn {
        user: pb::SynapseUser::Assistant as i32,
        timestamp: now_ts(),
        identifier: id,
        parent_identifier: parent,
        content: Some(pb::synapse_chat_turn::Content::Action(
            pb::SynapseActionContent {
                thought: thought.to_owned(),
                action: action.to_owned(),
                input: input.to_owned(),
                device_payload: Vec::new(),
                source: pb::SynapseSource::Device as i32,
            },
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::llm::LlmError;
    use tokio::sync::mpsc;

    type Inbound = mpsc::Sender<Result<pb::StreamingUnderstandRequest, Status>>;
    type Outbound = ReceiverStream<Result<pb::StreamingUnderstandResponse, Status>>;

    /// Start a session over a hand-fed request stream.
    fn session(model: Arc<dyn ChatModel>) -> (Inbound, Outbound) {
        let (tx, rx) = mpsc::channel(16);
        let out = BidiSession::spawn_with(
            model,
            Entitlement::Active,
            catalog::ToolContext::default(),
            ReceiverStream::new(rx),
        );
        (tx, out)
    }

    fn event(msg: &pb::StreamingUnderstandResponse) -> &pb::IntermediateEvent {
        match &msg.content {
            Some(pb::streaming_understand_response::Content::IntermediateEvent(e)) => e,
            _ => panic!("expected an intermediate_event"),
        }
    }

    fn turn(msg: &pb::StreamingUnderstandResponse) -> &pb::SynapseChatTurn {
        event(msg).event.as_ref().expect("event carries a turn")
    }

    fn action_of(msg: &pb::StreamingUnderstandResponse) -> Option<&pb::SynapseActionContent> {
        match &turn(msg).content {
            Some(pb::synapse_chat_turn::Content::Action(a)) => Some(a),
            _ => None,
        }
    }

    async fn next(out: &mut Outbound) -> pb::StreamingUnderstandResponse {
        tokio::time::timeout(Duration::from_secs(5), out.next())
            .await
            .expect("session produced no event in time")
            .expect("stream ended early")
            .expect("session error")
    }

    /// Synthetic provider HTTP boundary: wait until the request arrives before
    /// disconnecting the response consumer. The helper runs the production
    /// server-tool wait with the same request/response streams tonic supplies.
    #[tokio::test]
    async fn bidi_server_tool_http_wait_cancels_on_outgoing_disconnect_only() {
        use tokio::io::AsyncReadExt;

        struct NoModel;
        #[tonic::async_trait]
        impl ChatModel for NoModel {
            async fn complete(
                &self,
                _: &[ChatMessage],
                _: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                panic!("disconnect handling must not invoke a model");
            }
        }
        struct DropSignal(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }
        for half_close in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
            let provider = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 1024];
                let mut headers = Vec::new();
                while !headers.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = socket.read(&mut bytes).await.unwrap();
                    assert!(count > 0);
                    headers.extend_from_slice(&bytes[..count]);
                    assert!(headers.len() <= 8192);
                }
                let _ = accepted_tx.send(());
                // Never send a response. Closing the fixture is explicit at
                // the end, so this task cannot become background test work.
                let _ = socket.read(&mut bytes).await;
            });
            let (outgoing, receiver) = mpsc::channel(4);
            let session = BidiSession {
                model: Arc::new(NoModel),
                tx: outgoing,
                device_timeout: Duration::from_secs(5),
                run_budget: Duration::from_secs(5),
                entitlement: Entitlement::Active,
                tools: catalog::ToolContext::default(),
            };
            let (incoming, requests) = mpsc::channel(4);
            if half_close {
                drop(incoming);
            }
            let (drop_tx, drop_rx) = tokio::sync::oneshot::channel();
            let mut batch = tokio::spawn(async move {
                let work = async move {
                    let _drop = DropSignal(Some(drop_tx));
                    let result = reqwest::Client::new()
                        .get(format!("http://{address}/provider"))
                        .send()
                        .await;
                    vec![format!("{result:?}")]
                };
                session
                    .server_tool_batch(
                        work,
                        Duration::from_secs(5),
                        &mut ReceiverStream::new(requests),
                    )
                    .await
            });
            tokio::time::timeout(Duration::from_secs(2), accepted_rx)
                .await
                .unwrap()
                .unwrap();
            drop(receiver);
            let cancelled = tokio::time::timeout(Duration::from_millis(300), &mut batch).await;
            if cancelled.is_err() {
                batch.abort();
                let _ = batch.await;
            }
            provider.abort();
            let _ = provider.await;
            assert!(
                cancelled.is_ok(),
                "outgoing disconnect must cancel even with half_close={half_close}"
            );
            tokio::time::timeout(Duration::from_millis(300), drop_rx)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn bidi_server_tool_http_wait_preserves_inbound_half_close_and_supersession() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        struct NoModel;
        #[tonic::async_trait]
        impl ChatModel for NoModel {
            async fn complete(
                &self,
                _: &[ChatMessage],
                _: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                panic!("stream lifecycle must not invoke a model");
            }
        }
        for supersede in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
            let provider = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 1024];
                assert!(socket.read(&mut bytes).await.unwrap() > 0);
                let _ = accepted_tx.send(());
                let _ = release_rx.await;
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\nConfirmed result").await.unwrap();
            });
            let (outgoing, receiver) = mpsc::channel(4);
            let session = BidiSession {
                model: Arc::new(NoModel),
                tx: outgoing,
                device_timeout: Duration::from_secs(5),
                run_budget: Duration::from_secs(5),
                entitlement: Entitlement::Active,
                tools: catalog::ToolContext::default(),
            };
            let (incoming, requests) = mpsc::channel(4);
            let batch = tokio::spawn(async move {
                let work = async move {
                    vec![
                        reqwest::Client::new()
                            .get(format!("http://{address}/provider"))
                            .send()
                            .await
                            .unwrap()
                            .text()
                            .await
                            .unwrap(),
                    ]
                };
                session
                    .server_tool_batch(
                        work,
                        Duration::from_secs(5),
                        &mut ReceiverStream::new(requests),
                    )
                    .await
            });
            tokio::time::timeout(Duration::from_secs(2), accepted_rx)
                .await
                .unwrap()
                .unwrap();
            if supersede {
                incoming
                    .send(Ok(pb::StreamingUnderstandRequest {
                        content: Some(
                            pb::streaming_understand_request::Content::UnderstandingRequest(
                                pb::SynapseUnderstandingRequest {
                                    utterance: "New wearer request".into(),
                                    ..Default::default()
                                },
                            ),
                        ),
                    }))
                    .await
                    .unwrap();
                assert!(
                    matches!(tokio::time::timeout(Duration::from_millis(300), batch).await.unwrap().unwrap(), ToolBatchStep::Superseded(request) if request.utterance == "New wearer request")
                );
                provider.abort();
            } else {
                drop(incoming);
                let _ = release_tx.send(());
                assert!(
                    matches!(tokio::time::timeout(Duration::from_secs(2), batch).await.unwrap().unwrap(), ToolBatchStep::Observations(values) if values == vec!["Confirmed result"])
                );
            }
            let _ = provider.await;
            drop(receiver);
        }
    }

    /// PARITY: the legacy engine's D1 lane runs on bidi too. An operator who
    /// turns on `synapse_bidirectional_streaming` must not lose device reads,
    /// timers, alarms, nutrition, or translation to a model step. Each of the
    /// eval's D1 prompts here gets the same first action on both transports.
    #[tokio::test]
    async fn bidi_takes_the_engines_d1_route_before_any_model_step() {
        struct ModelMustNotRun;

        #[tonic::async_trait]
        impl ChatModel for ModelMustNotRun {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                panic!("a D1 request must not spend a model step on bidi")
            }
        }

        for (utterance, expected) in [
            ("Battery level.", "GetBatteryLevel"),
            ("Show my timers.", "Timer"),
            ("Show my alarms.", "Alarm"),
            ("Set a timer for five minutes.", "Timer"),
            ("What have I eaten today?", "ManageNutrition"),
            ("Reset session.", "ClearUnderstandingContext"),
            ("Open contacts.", "OpenContacts"),
            ("How do you say thank you in Japanese?", "Translate"),
            ("Translate hello to Polish.", "Translate"),
            ("Translate \"I love US! Żółć\" to Polish.", "Translate"),
            ("Translate \"yes and no\" to Polish.", "Translate"),
            ("What time is it in Tokyo?", "WorldClock"),
        ] {
            let request = pb::SynapseUnderstandingRequest {
                utterance: utterance.to_owned(),
                device_context: Some(pb::SynapseDeviceContext::default()),
                ..Default::default()
            };
            let legacy = super::super::engine::deterministic_device_action(
                &request,
                &resolve_catalog(&request, &Entitlement::Active),
            )
            .unwrap_or_else(|| panic!("{utterance:?} is not on the engine's D1 lane"));
            assert_eq!(legacy.name, expected, "{utterance:?}");
            if utterance.contains("I love US") {
                let input: serde_json::Value = serde_json::from_str(&legacy.input).unwrap();
                assert_eq!(input["Text"], "I love US! Żółć");
            }
            if utterance.contains("yes and no") {
                let input: serde_json::Value = serde_json::from_str(&legacy.input).unwrap();
                assert_eq!(input["Text"], "yes and no");
            }

            let (tx, mut out) = session(Arc::new(ModelMustNotRun));
            tx.send(Ok(pb::StreamingUnderstandRequest {
                content: Some(
                    pb::streaming_understand_request::Content::UnderstandingRequest(request),
                ),
            }))
            .await
            .unwrap();
            let response = next(&mut out).await;
            let action = action_of(&response)
                .unwrap_or_else(|| panic!("{utterance:?} produced no action on bidi"));
            assert_eq!(action.action, expected, "{utterance:?}");
            assert_eq!(action.input, legacy.input, "{utterance:?}");
            assert!(
                event(&response).requires_response,
                "{utterance:?}: the Pin must run the action, not only record it",
            );
            drop(tx);
        }
    }
}
