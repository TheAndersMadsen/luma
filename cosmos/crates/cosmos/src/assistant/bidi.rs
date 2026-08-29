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
//! `TaoEventRegistrar.onIntermediateEvent` branches on that flag —
//! `action && requires_response` → `dispatchAction` (the pin actually runs it and
//! owes us an observation), `action && !requires_response` → `recordAction`
//! (history only; the server already ran it), `observation` → `recordObservation`.
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
//!      observation (ends the run without re-understanding) — so the device never
//!      posts it back. Waiting for it would hang the session forever. The run
//!      therefore ends the moment `Respond` is emitted (state machine 4c/6).
//!   4. **Observation-to-action matching** is by `parent_identifier == action.identifier`
//!      ("Key decisions" #10). An observation naming some other action is stale /
//!      superseded work and is discarded, mirroring `RunManager.shouldDispatchCurrent`.
//!   5. **Server-held run state.** Unlike legacy (stateless per RPC; the device
//!      replays the whole transcript every hop), on bidi the device sends the full
//!      `device_context` only in the initial `understanding_request` and thereafter
//!      only observation deltas — so the transcript is accumulated here for the
//!      life of the stream and discarded on close (§3).
//!   6. **Loop guard.** The same action budget as legacy (`ai_bus.max_action_turns`,
//!      default 8); exceeding it yields a `TooManyActions` observation converted
//!      into a terminal `Respond`, mirroring `Switchboard`'s runaway guard where
//!      `Respond` is exempt so the agent can always answer.
//!   7. **Honest termination.** A client half-close or a stream error half-closes
//!      the response stream (state machine 7, ABORTED) — we never invent the
//!      observation we did not receive. Running out of wall clock does not
//!      fabricate one either, but it is not silent: a run that exhausts
//!      `RUN_BUDGET` (including while parked on a device action) ends in the
//!      terminal `Respond` containing `ERROR_TIMEOUT`, the same string the device
//!      speaks for itself when its own deadline fires. A bare half-close here
//!      would leave the wearer with nothing at all.
//!
//! Deliberately NOT emitted: `Interstitial`. This shipped client's bidi observer
//! early-returns on any non-`intermediate_event` response, so server interstitials
//! are received and dropped (§1, edge cases); we also host no interstitial model,
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
use crate::services::gates::{self, Entitlement};

/// cosmos's `ai_bus.max_action_turns` feature flag defaults to 8 (same budget the
/// legacy engine enforces).
const MAX_STEPS: usize = 8;

/// Per-model-step ceiling, shared with the legacy engine: the device abandons the
/// turn at its own ~25s deadline, so a step must resolve well inside that.
const MODEL_STEP_TIMEOUT: std::time::Duration = super::runtime::MODEL_STEP_LIMIT;

/// Total wall-clock budget for one run, the same 22s the legacy engine bounds a
/// turn with.
///
/// gRPC does not impose it here — `AIBusService.bidirectionalStreamingUnderstand`
/// sets no `withDeadlineAfter`, unlike `understand`/`encryptedUnderstand` — and
/// that is precisely why the server has to. With no budget the loop could spend
/// eight steps at the per-step ceiling plus unbounded tool time while
/// `SynapseInterpreter.getNextDeviceActionResponse` sits in an UNBOUNDED
/// `responseFuture.get()`: the wearer's turn simply never comes back. Bounding
/// the run at the same 22s the other transports use keeps the two transports
/// answering on the same clock, and always leaves room to speak a terminal
/// before giving up.
const RUN_BUDGET: Duration = super::runtime::FOREGROUND_BUDGET;

/// Below this there is no useful work left to start — anything begun now would
/// overrun the budget before it could be spoken.
const MIN_USEFUL_REMAINING: Duration = super::runtime::MIN_USEFUL_REMAINING;

/// Bounced back in place of a server tool's result when the tool does not return
/// inside the run's remaining budget. Not spoken directly (only `TooManyActions`
/// is respoken by the device); it tells the model the step produced nothing so it
/// answers from what it has rather than treating the gap as a result.
const TOOL_TIMED_OUT: &str = "The tool did not return in time.";

/// The exact observation the stock device bounces back when an emitted action does
/// not resolve in its `SchemaCatalog` (`JsonResolver.resolve` → null).
const UNRECOGNIZED_FUNCTION: &str = "Unrecognized function name and/or arguments";

/// `IntermediateEvent.agent` — the server's label for which sub-agent produced a
/// turn, a key into its own `RunState.agent_to_runs`. The device never reads it
/// (no callers of `getAgent()` anywhere in the client), and cosmos's agent-string
/// taxonomy is server-defined and not recoverable, so this clone names its single
/// agent itself.
const AGENT: &str = "assistant";

/// `AIMIC_TIMEOUT_MS` — the whole-turn deadline the device applies to an assistant
/// turn. A device observation that never arrives within it means the turn is dead
/// on the device side too, so the session aborts rather than leaking forever.
const DEVICE_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(25);

/// Outbound buffer depth, matching the `Understand` handler.
const CHANNEL_DEPTH: usize = 16;

/// One open `BidirectionalStreamingUnderstand` stream: a long-lived session that
/// may contain several request/observation exchanges (a new
/// `SynapseBidirectionalStreamingSession` is created on the device only when the
/// previous one has completed, so the stream outlives a single run).
pub struct BidiSession {
    model: Arc<dyn ChatModel>,
    tx: Sender<Result<pb::StreamingUnderstandResponse, Status>>,
    /// Monotonic across the whole session so server-minted ids never collide.
    counter: usize,
    device_timeout: Duration,
    /// Wall clock for ONE run (see [`RUN_BUDGET`]), reset per run rather than per
    /// session — the stream serves several turns and the wearer's patience is
    /// per turn.
    run_budget: Duration,
    /// The caller's account verdict, resolved once per RPC by the handler exactly
    /// as `Understand` and `ServerStatefulUnderstand` do. Without it this
    /// transport served every caller as fully subscribed and authorized — a
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
    /// A new understanding request arrived; abandon this run for it.
    Superseded(Box<pb::SynapseUnderstandingRequest>),
    /// Model error or step deadline, classified without provider response text.
    Failed(&'static str),
}

enum ToolBatchStep {
    Observations(Vec<String>),
    Superseded(Box<pb::SynapseUnderstandingRequest>),
}

enum Flow {
    /// The run reached its terminal action. The stream stays open for another
    /// exchange (device-side session reuse).
    Done,
    /// A fresh `understanding_request` arrived while a device action was pending:
    /// the new user turn supersedes the in-flight run (a turn that is its own root
    /// starts a new run; work outside the active run is discarded).
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
    /// tonic; the session runs on its own task and half-closes by dropping the
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
    /// guards can be exercised without spending the real 22 seconds. Production
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
            counter: 0,
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
    /// terminal `Respond`. Every emitted turn is an `IntermediateEvent`; the flag
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
        // Once the request side is done we stop racing it — a half-close means
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
                            // run-state seeds, are not preemptive — keep waiting.
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
            if !inbound_open {
                return ToolBatchStep::Observations(pending.await.unwrap_or_default());
            }
            tokio::select! {
                biased;

                incoming = inbound.next() => {
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

    async fn run_turn<S>(&mut self, req: pb::SynapseUnderstandingRequest, inbound: &mut S) -> Flow
    where
        S: Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Unpin,
    {
        // Server-owned catalog for this run: our tool set minus `excluded_tools`.
        let mut tools = resolve_catalog(&req, &self.entitlement);

        // The wearer's own words, kept for required-slot backfill (see the device
        // branch below): the agent entry points take the request verbatim, so the
        // utterance is the faithful fill rather than an invention.
        let utterance = super::engine::current_utterance(&req).to_owned();
        catalog::scope_tickle_to_exact_request(&mut tools, &utterance);
        let bounded_music_research = super::engine::prefer_one_music_research_tool(
            &mut tools,
            &utterance,
            self.tools.answer_engine_available,
        );

        // Root the run on the user-request turn the device replayed; with no device
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
        // device cuts the run short itself — the wearer's turn dies mid-flight with
        // no terminal from us.
        let mut actions_in_run = req
            .device_context
            .as_ref()
            .map(|dc| super::engine::actions_in_current_run(&dc.turns))
            .unwrap_or(0);

        // Both transports cross the same foreground-runtime seam for their
        // absolute clock and content-free production-plane provenance.
        let future_weather = super::engine::future_weather_request(&utterance);
        let tickle_near_miss = super::engine::tickle_near_miss_request(&utterance);
        let mut run = ForegroundRun::with_budget(
            Transport::Bidi,
            if future_weather || tickle_near_miss {
                RouteClass::D1
            } else {
                RouteClass::A1
            },
            self.run_budget,
        )
        .with_model(self.model.provenance());
        let run_deadline = run.deadline();
        let mut tool_context = self.tools.clone();
        tool_context.deadline = Some(run_deadline);

        if future_weather {
            let flow = self
                .finish(parent, super::engine::FUTURE_WEATHER_UNAVAILABLE)
                .await;
            run.finish("answered");
            return flow;
        }
        if tickle_near_miss {
            let flow = self
                .finish(parent, super::engine::TICKLE_NEAR_MISS_RESPONSE)
                .await;
            run.finish("answered");
            return flow;
        }

        // Seed the transcript from `device_context.turns` (the server seeds its own
        // RunState this way on the first request of a stream, §3) and grow it in
        // place as the loop proceeds — on bidi the device sends only deltas after
        // this point. Optional memory loading is bounded inside the same absolute
        // foreground clock; personalization may degrade, the turn may not hang.
        let mut messages = build_history(&req);
        if let Ok(Some(memory)) =
            tokio::time::timeout(run.context_timeout(), wearer_memory(&self.tools)).await
        {
            messages.push(ChatMessage::system(MEMORY_CONTEXT_POLICY));
            messages.push(memory);
        }

        for _ in 0..MAX_STEPS {
            // Out of wall clock: speak a terminal NOW. On this transport nothing
            // else will — the pin is parked in an unbounded `responseFuture.get()`
            // and a half-close would complete it with an empty queue, i.e.
            // silence.
            let budget_left = run_deadline.saturating_duration_since(std::time::Instant::now());
            if budget_left < MIN_USEFUL_REMAINING {
                let flow = self.finish(parent, ERROR_TIMEOUT).await;
                run.finish("deadline");
                return flow;
            }

            // Race the model step against the inbound stream. Two reasons:
            //
            //  * PREEMPTION — cosmos allows exactly one active run
            //    (`RunManager.shouldDispatchCurrent`: a turn that is its own root
            //    replaces `mExecutingRun` and every turn of the old run is then
            //    blocked as an orphan). If the wearer barges in with a new
            //    request, this run is abandoned *now* rather than grinding out a
            //    full action budget and then speaking an answer to a question
            //    that was superseded.
            //  * DEADLINE — an unbounded upstream call burns the wearer's whole
            //    turn; the device tears it down at its own ~25s AIMIC deadline and
            //    they hear nothing. A bounded step leaves room to speak an apology.
            //
            // The step ceiling is the SMALLER of the per-step ceiling and what is
            // left of the run: a 10s step started with 3s of budget left is 7s
            // the wearer waits for a turn that can no longer be spoken.
            run.note_model_step();
            let resp = match self
                .step(
                    &messages,
                    &tools,
                    // Same rule as the server-stream engine: a step gets the
                    // budget it has (minus streaming reserve), bounded by the
                    // anti-hang ceiling — not a fixed cap that fires with budget
                    // to spare.
                    budget_left
                        .saturating_sub(Duration::from_millis(750))
                        .min(MODEL_STEP_TIMEOUT),
                    inbound,
                )
                .await
            {
                Step::Superseded(req) => {
                    run.supersede();
                    return Flow::Supersede(req);
                }
                Step::Answer(r) => r,
                Step::Failed(outcome) => {
                    // Even a degraded state is spoken through a terminal `Respond`
                    // device action, never a bare error the device would drop.
                    let flow = self.finish(parent, ERROR_TIMEOUT).await;
                    run.finish(outcome);
                    return flow;
                }
            };

            let Some(tc) = resp.tool_call else {
                // FINISH (state machine 4c): plain content, or nothing usable at
                // all — either way the run terminates in a spoken `Respond`.
                // Blank counts as nothing usable. `RespondAction.mResponse` is a
                // present-but-empty slot, so the device resolves the action,
                // dispatches it, narrates nothing, and its observation is final —
                // a turn that "succeeds" in silence with no retry. The legacy
                // engine has guarded this since the blank-content fix; bidi was
                // missed, so the same wearer-facing silence survived on the other
                // transport.
                let answer = resp
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|answer| !answer.is_empty())
                    .unwrap_or(NO_ANSWER);
                let flow = self.finish(parent, answer).await;
                run.finish(if answer == NO_ANSWER {
                    "no_answer"
                } else {
                    "answered"
                });
                return flow;
            };
            run.note_tool_call(&tc.name);

            if actions_in_run >= MAX_STEPS {
                let flow = self.too_many_actions(parent).await;
                run.finish("too_many_actions");
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
                    run.finish("cancelled");
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
                    run.finish("cancelled");
                    return Flow::Closed;
                }
                messages.push(tool_result(&tc, UNRECOGNIZED_FUNCTION));
                parent = obs_id;
                continue;
            }

            // TERMINAL DEVICE ACTION. `Respond` is a device action and so must be
            // flagged `requires_response=true` (otherwise the registrar only
            // records it and the wearer hears nothing), but its device-side
            // observation is final and is never posted back — so this ends the run
            // instead of pausing on it.
            if tc.name == catalog::RESPOND_ACTION {
                let id = self.next_id();
                // `Response` is an OPTIONAL slot on the device, so a missing or
                // miscased key resolves to null and `RespondActionHandler` throws
                // — total silence on the action that ends every turn. Rebuild the
                // canonical payload rather than forwarding model arguments.
                let input = catalog::respond_input_from_arguments(&tc.arguments)
                    .unwrap_or_else(|| catalog::respond_input(NO_ANSWER));
                let turn = device_action_turn(&tc.name, &input, &resp.thought, parent, id);
                run.finish(if input.contains(NO_ANSWER) {
                    "no_answer"
                } else {
                    "answered"
                });
                return match self.emit(turn, true).await {
                    Ok(()) => Flow::Done,
                    Err(()) => Flow::Closed,
                };
            }

            // PAUSING DEVICE ACTION (state machine 4b). Emit exactly one
            // `requires_response=true` event and wait — the wearer's pin executes
            // it and owes us the observation on this same stream.
            if catalog::is_device_tool(&tc.name) {
                // Account gate, matching `Switchboard.routeAction`'s order and the
                // legacy engine's `gated()`. The catalog filter alone cannot cover
                // this: `Entitlement::Unauthorized` deliberately reports
                // `is_subscribed() == true`, so a de-authorized device passes the
                // subscription filter and was previously stopped only by the edge
                // AuthLayer. A blocked action is replaced by the canned degraded
                // experience — the wearer hears why instead of hitting silence.
                if let Some(blocked) = gates::gate_action(&self.entitlement, &tc.name) {
                    let obs_id = self.next_id();
                    if self
                        .emit(
                            observation_turn(
                                &tc.name,
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
                        run.finish("cancelled");
                        return Flow::Closed;
                    }
                    // Every degraded verdict is delivered spoken. The legacy engine
                    // additionally reproduces the exact synthesized action name
                    // (`Respond`/`Narrate`/…); here the terminal is always the
                    // exempt `Respond`, which carries the same text to the wearer
                    // and is the shape this transport already terminates on.
                    let flow = self.finish(obs_id, blocked.observation_text()).await;
                    run.finish("blocked");
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
                                    "I couldn't complete that without the missing detail."
                                } else {
                                    &question
                                };
                            let flow = self.finish(parent, spoken).await;
                            run.finish("clarification");
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
                            run.finish("cancelled");
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
                            run.finish("cancelled");
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
                    run.finish("confirmation_required");
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
                    run.finish("cancelled");
                    return Flow::Closed;
                }

                // Park for the observation, but never past the run's own clock:
                // the pin executing an action is time the wearer is waiting too.
                // `AIMIC_TIMEOUT_MS` remains the ceiling on a single wait (past it
                // the turn is dead on the device side as well); the run budget is
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
                        // never received — but we do speak. A half-close here only
                        // completes the pin's pending future with an empty queue,
                        // and the wearer, who has been standing there through a
                        // whole action, hears nothing at all.
                        Err(_elapsed) => {
                            let flow = self.finish(action_id, ERROR_TIMEOUT).await;
                            run.finish("deadline");
                            return flow;
                        }
                    };
                let (obs_id, obs) = match awaited {
                    Awaited::Observation { id, content } => (id, content),
                    Awaited::Supersede(req) => {
                        run.supersede();
                        return Flow::Supersede(req);
                    }
                    Awaited::Closed => return Flow::Closed,
                };

                messages.push(tool_result(&tc, &obs.observation));
                if obs.is_final {
                    // A final observation ends the run on the device
                    // (`RunManager.endRun`), so re-prompting would answer into a
                    // closed run. Stop here — but HALF-CLOSE, do not park.
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
                    run.finish("device_action");
                    return Flow::Closed;
                }
                // Thread onto the device's own turn id where it minted one.
                parent = if obs_id.is_empty() { action_id } else { obs_id };
                continue;
            }

            // SERVER TOOLS. A same-step batch represents independent work, so
            // execute it concurrently and publish observations in stable request
            // order. The Pin counts emitted actions rather than model rounds;
            // refuse an oversized batch before partially executing it.
            let terminal_music = tc.name == "music_discover"
                && super::engine::explicit_playback_request(&utterance)
                && tools.iter().any(|tool| tool.name == "PlayMusic");
            let mut batch = vec![tc.clone()];
            if !terminal_music {
                batch.extend(
                    resp.extra_tool_calls
                        .iter()
                        .filter(|extra| {
                            !catalog::is_device_tool(&extra.name)
                                && catalog::is_server_tool(&extra.name)
                                && tools.iter().any(|tool| tool.name == extra.name)
                        })
                        .cloned(),
                );
            }
            if actions_in_run.saturating_add(batch.len()) > MAX_STEPS {
                let flow = self.too_many_actions(parent).await;
                run.finish("too_many_actions");
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
                    run.finish("cancelled");
                    return Flow::Closed;
                }
                action_ids.push(action_id);
            }
            actions_in_run += batch.len();

            let timeout = run_deadline
                .saturating_duration_since(std::time::Instant::now())
                .saturating_sub(TERMINAL_RESERVE);
            let work = futures_util::future::join_all(batch.iter().map(|call| {
                catalog::execute_tool_with(&call.name, &call.arguments, &tool_context)
            }));
            let observations = match self.server_tool_batch(work, timeout, inbound).await {
                ToolBatchStep::Observations(observations) => observations,
                ToolBatchStep::Superseded(request) => {
                    run.supersede();
                    return Flow::Supersede(request);
                }
            };
            if observations.len() != batch.len() {
                let flow = self.finish(parent, ERROR_TIMEOUT).await;
                run.finish("deadline");
                return flow;
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
                    run.finish("cancelled");
                    return Flow::Closed;
                }
                if call.name == tc.name && primary_observation.is_none() {
                    primary_observation = Some(observation.clone());
                }
                messages.push(tool_result(call, &observation));
                parent = obs_id;
            }
            if bounded_music_research
                && batch
                    .iter()
                    .any(|call| matches!(call.name.as_str(), "web_search" | "ask_online"))
            {
                super::engine::retire_music_research_tools(&mut tools);
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
                    run.finish("device_action");
                    return match self.emit(turn, true).await {
                        Ok(()) => Flow::Done,
                        Err(()) => Flow::Closed,
                    };
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
                run.finish("answered");
                return flow;
            }

            if actions_in_run >= MAX_STEPS {
                let flow = self.too_many_actions(parent).await;
                run.finish("too_many_actions");
                return flow;
            }
        }

        // Budget exhausted: close the run the way `Switchboard` does — a
        // `TooManyActions` observation converted into a terminal `Respond`
        // (`Respond` is exempt from the action limit).
        let flow = self.too_many_actions(parent).await;
        run.finish("too_many_actions");
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

    /// Emit the run's terminal `Respond` — the one event of the run the device
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
    /// observation; false ⇒ record as history only.
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
/// sends and whose payload this proto models as opaque bytes — accepted and
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
            // observation — it posts it back to us and then blocks on an
            // UNBOUNDED `responseFuture.get()`, which only completes on an event
            // flagged `requires_response` or when the session closes. Silently
            // ignoring the observation therefore parks the wearer's pin for its
            // full 25s AIMIC deadline after the answer has already been spoken.
            //
            // Returning `None` drops `tx`, and the half-close makes the client's
            // `SynapseBidirectionalStreamingSession.close()` complete that future
            // with the empty queue — the turn ends cleanly. The device opens a
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
                    // observation body tells us nothing; keep waiting.
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
// `engine.rs`; the tool catalog and system prompt themselves are reused from
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
    // here, so this resolves to the same flat set — but reading the pointer means
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
    if !super::engine::explicit_playback_request(super::engine::current_utterance(req)) {
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
                        messages.push(ChatMessage::user(format!(
                            "[Previously called {}({})]",
                            a.action, a.input
                        )));
                    }
                }
                Some(pb::synapse_chat_turn::Content::Observation(o)) => {
                    if !o.observation.is_empty() {
                        messages.push(ChatMessage::user(format!(
                            "[Result of {}: {}]",
                            o.action_name, o.observation
                        )));
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
    // the question twice — and on later hops of a multi-hop run it would land
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
/// holding the run open — never a fabricated result.
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
/// it. `source` is provenance metadata only — the execution trigger on this
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
    use crate::assistant::llm::{LlmError, MockChatModel};
    use crate::assistant::turn::text::MAX_MODEL_FACING_OBSERVATION;
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

    /// A session whose two deadlines are shortened, so the budget guards can be
    /// driven end to end in milliseconds. Everything else is the production path.
    fn session_with_clocks(
        model: Arc<dyn ChatModel>,
        run_budget: Duration,
        device_timeout: Duration,
    ) -> (Inbound, Outbound) {
        let (tx, rx) = mpsc::channel(16);
        let out = BidiSession::spawn_tuned(
            model,
            Entitlement::Active,
            catalog::ToolContext::default(),
            ReceiverStream::new(rx),
            run_budget,
            device_timeout,
        );
        (tx, out)
    }

    fn understanding(utterance: &str) -> pb::StreamingUnderstandRequest {
        pb::StreamingUnderstandRequest {
            content: Some(
                pb::streaming_understand_request::Content::UnderstandingRequest(
                    pb::SynapseUnderstandingRequest {
                        utterance: utterance.to_owned(),
                        ..Default::default()
                    },
                ),
            ),
        }
    }

    /// The device's reply to a `requires_response=true` action: an observation turn
    /// whose parent is the action's identifier.
    fn observation(
        parent: &str,
        id: &str,
        action: &str,
        text: &str,
    ) -> pb::StreamingUnderstandRequest {
        observation_with_finality(parent, id, action, text, false)
    }

    fn observation_with_finality(
        parent: &str,
        id: &str,
        action: &str,
        text: &str,
        is_final: bool,
    ) -> pb::StreamingUnderstandRequest {
        pb::StreamingUnderstandRequest {
            content: Some(pb::streaming_understand_request::Content::Observation(
                pb::SynapseChatTurn {
                    user: pb::SynapseUser::System as i32,
                    identifier: id.to_owned(),
                    parent_identifier: parent.to_owned(),
                    content: Some(pb::synapse_chat_turn::Content::Observation(
                        pb::SynapseObservationContent {
                            observation: text.to_owned(),
                            is_final,
                            action_name: action.to_owned(),
                            source: pb::SynapseSource::Device as i32,
                        },
                    )),
                    ..Default::default()
                },
            )),
        }
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

    fn observation_of(
        msg: &pb::StreamingUnderstandResponse,
    ) -> Option<&pb::SynapseObservationContent> {
        match &turn(msg).content {
            Some(pb::synapse_chat_turn::Content::Observation(o)) => Some(o),
            _ => None,
        }
    }

    fn spoken(msg: &pb::StreamingUnderstandResponse) -> String {
        let a = action_of(msg).expect("action");
        assert_eq!(a.action, catalog::RESPOND_ACTION);
        serde_json::from_str::<serde_json::Value>(&a.input).unwrap()[catalog::RESPOND_FIELD]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn next(out: &mut Outbound) -> pb::StreamingUnderstandResponse {
        tokio::time::timeout(Duration::from_secs(5), out.next())
            .await
            .expect("session produced no event in time")
            .expect("stream ended early")
            .expect("session error")
    }

    /// Assert the session emits nothing for a moment — i.e. it is parked awaiting
    /// the device.
    async fn assert_idle(out: &mut Outbound) {
        assert!(
            tokio::time::timeout(Duration::from_millis(100), out.next())
                .await
                .is_err(),
            "session emitted an event while it should have been awaiting the device"
        );
    }

    async fn assert_closed(out: &mut Outbound) {
        let tail = tokio::time::timeout(Duration::from_secs(5), out.next())
            .await
            .expect("stream did not half-close in time");
        assert!(tail.is_none(), "expected half-close, got another event");
    }

    // (a) A SERVER tool must not pause the loop.
    /// PARITY: batched server tools must execute on THIS transport too.
    ///
    /// The engine gained parallel tool execution and bidi did not, so the same
    /// question answered from fewer facts here — and the model could speak as
    /// though a lookup it never received had run. This is the third time a fix
    /// landed on one transport and left the other broken (blank content, the
    /// run budget, now this), which is why the assertion is about equality of
    /// behaviour rather than about bidi in isolation.
    #[tokio::test]
    async fn batched_server_tools_run_on_bidi_too() {
        struct BatchThenAnswer;
        #[tonic::async_trait]
        impl ChatModel for BatchThenAnswer {
            async fn complete(
                &self,
                messages: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                if messages.iter().any(|m| m.role == Role::ToolResult) {
                    return Ok(ChatResponse {
                        content: Some("Both looked up.".to_owned()),
                        ..Default::default()
                    });
                }
                Ok(ChatResponse {
                    tool_call: Some(ToolCall {
                        name: "wikipedia".into(),
                        arguments: r#"{"query":"eiffel tower"}"#.into(),
                    }),
                    extra_tool_calls: vec![ToolCall {
                        name: "wolfram".into(),
                        arguments: r#"{"query":"330 meters in feet"}"#.into(),
                    }],
                    ..Default::default()
                })
            }
        }

        let (tx, mut out) = session(Arc::new(BatchThenAnswer));
        tx.send(Ok(understanding("how tall is the eiffel tower in feet")))
            .await
            .unwrap();
        drop(tx);

        let mut msgs = Vec::new();
        while let Some(m) = out.next().await {
            msgs.push(m.unwrap());
        }
        let observed: Vec<String> = msgs
            .iter()
            .filter_map(observation_of)
            .map(|o| o.action_name.clone())
            .collect();
        assert!(
            observed.iter().any(|n| n == "wikipedia") && observed.iter().any(|n| n == "wolfram"),
            "both batched lookups must be executed AND observed on bidi, not just \
             the first — a dropped call the model never sees is one it may answer \
             as though it ran: {observed:?}",
        );
    }

    #[tokio::test]
    async fn a_batched_model_step_cannot_overrun_the_replayed_device_action_budget() {
        struct OversizedBatch;

        #[tonic::async_trait]
        impl ChatModel for OversizedBatch {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                Ok(ChatResponse {
                    tool_call: Some(ToolCall {
                        name: "web_search".to_owned(),
                        arguments: r#"{"query":"one"}"#.to_owned(),
                    }),
                    extra_tool_calls: vec![
                        ToolCall {
                            name: "wikipedia".to_owned(),
                            arguments: r#"{"query":"two"}"#.to_owned(),
                        },
                        ToolCall {
                            name: "wolfram".to_owned(),
                            arguments: r#"{"query":"three"}"#.to_owned(),
                        },
                    ],
                    ..Default::default()
                })
            }
        }

        let mut turns = vec![pb::SynapseChatTurn {
            identifier: "root".to_owned(),
            ..Default::default()
        }];
        for index in 0..(MAX_STEPS - 1) {
            let parent_identifier = turns.last().unwrap().identifier.clone();
            turns.push(pb::SynapseChatTurn {
                identifier: format!("prior-{index}"),
                parent_identifier,
                content: Some(pb::synapse_chat_turn::Content::Action(
                    pb::SynapseActionContent {
                        action: "web_search".to_owned(),
                        input: "{}".to_owned(),
                        source: pb::SynapseSource::Server as i32,
                        ..Default::default()
                    },
                )),
                ..Default::default()
            });
        }

        let (tx, mut out) = session(Arc::new(OversizedBatch));
        tx.send(Ok(pb::StreamingUnderstandRequest {
            content: Some(
                pb::streaming_understand_request::Content::UnderstandingRequest(
                    pb::SynapseUnderstandingRequest {
                        utterance: "look up all three".to_owned(),
                        device_context: Some(pb::SynapseDeviceContext {
                            turns,
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                ),
            ),
        }))
        .await
        .unwrap();
        drop(tx);

        let mut messages = Vec::new();
        while let Some(message) = out.next().await {
            messages.push(message.unwrap());
        }
        let emitted_server_actions = messages
            .iter()
            .filter_map(action_of)
            .filter(|action| action.source == pb::SynapseSource::Server as i32)
            .count();
        assert!(
            emitted_server_actions <= 1,
            "only one device-counted action remained, but bidi emitted {emitted_server_actions}"
        );
        assert_eq!(spoken(messages.last().unwrap()), TOO_MANY_ACTIONS);
    }

    #[tokio::test]
    async fn researched_music_playback_settles_on_bidi_without_a_third_model_step() {
        struct MusicModel(std::sync::atomic::AtomicUsize);

        #[tonic::async_trait]
        impl ChatModel for MusicModel {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                let call = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let (name, arguments) = if call == 0 {
                    assert_eq!(
                        tools
                            .iter()
                            .filter(|tool| matches!(
                                tool.name.as_str(),
                                "web_search" | "ask_online"
                            ))
                            .map(|tool| tool.name.as_str())
                            .collect::<Vec<_>>(),
                        vec!["web_search"],
                        "a ranked playback turn gets one configured research path"
                    );
                    (
                        "web_search",
                        serde_json::json!({
                            "query": "Drake most controversial song released in 2013"
                        })
                        .to_string(),
                    )
                } else {
                    assert_eq!(
                        call, 1,
                        "provider-grounded playback must not require a settlement model step"
                    );
                    assert!(
                        tools
                            .iter()
                            .all(|tool| !matches!(tool.name.as_str(), "web_search" | "ask_online")),
                        "one completed research lookup must retire both research tools"
                    );
                    (
                        "music_discover",
                        serde_json::json!({
                            "artist": "Drake",
                            "title": "Started From the Bottom",
                            "criterion": "most controversial",
                            "timeframe": "all_time",
                            "year": 2013
                        })
                        .to_string(),
                    )
                };
                Ok(ChatResponse {
                    tool_call: Some(ToolCall {
                        name: name.to_owned(),
                        arguments,
                    }),
                    ..Default::default()
                })
            }
        }

        struct FixedMusic;

        #[tonic::async_trait]
        impl crate::backends::music_discovery::MusicDiscoveryBackend for FixedMusic {
            async fn discover(
                &self,
                _request: crate::backends::music_discovery::MusicDiscoveryRequest,
                _principal: &str,
                _deadline: Option<std::time::Instant>,
            ) -> Result<
                crate::backends::music_discovery::GroundedMusicTrack,
                crate::backends::music_discovery::MusicDiscoveryError,
            > {
                Ok(crate::backends::music_discovery::GroundedMusicTrack {
                    title: "Started From the Bottom".to_owned(),
                    artist: "Drake".to_owned(),
                    provider: "youtube_music".to_owned(),
                    ranking_provenance: "provider_exact".to_owned(),
                    discovery_provenance: "perplexity".to_owned(),
                })
            }
        }

        let model = Arc::new(MusicModel(std::sync::atomic::AtomicUsize::new(0)));
        let (tx, rx) = mpsc::channel(16);
        let mut out = BidiSession::spawn_tuned(
            model.clone(),
            Entitlement::Active,
            catalog::ToolContext {
                principal: Some("V:01:D:pin-01:U:wearer-01".to_owned()),
                music_discovery: Some(Arc::new(FixedMusic)),
                ..Default::default()
            },
            ReceiverStream::new(rx),
            Duration::from_secs(2),
            Duration::from_secs(2),
        );
        tx.send(Ok(understanding(
            "Play Drake's most controversial song from 2013",
        )))
        .await
        .unwrap();
        drop(tx);

        let research_action = next(&mut out).await;
        assert_eq!(action_of(&research_action).unwrap().action, "web_search");
        let research_observation = next(&mut out).await;
        assert_eq!(
            observation_of(&research_observation).unwrap().action_name,
            "web_search"
        );
        let server_action = next(&mut out).await;
        assert_eq!(action_of(&server_action).unwrap().action, "music_discover");
        let server_observation = next(&mut out).await;
        assert_eq!(
            observation_of(&server_observation).unwrap().action_name,
            "music_discover"
        );
        let playback = next(&mut out).await;
        let action = action_of(&playback).expect("terminal provider playback action");
        assert_eq!(action.action, "PlayMusic");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
            serde_json::json!({"Artist": "Drake", "Track": "Started From the Bottom"})
        );
        assert_eq!(model.0.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn future_weather_declines_on_bidi_without_model_or_location_work() {
        struct ModelMustNotRun;

        #[tonic::async_trait]
        impl ChatModel for ModelMustNotRun {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                panic!("future weather is a closed product limitation")
            }
        }

        let (tx, mut out) = session(Arc::new(ModelMustNotRun));
        tx.send(Ok(understanding("What will the weather be tomorrow?")))
            .await
            .unwrap();
        drop(tx);

        let answer = next(&mut out).await;
        assert_eq!(
            spoken(&answer),
            "Future weather forecasts are not available yet."
        );
    }

    #[tokio::test]
    async fn tickle_near_miss_settles_on_bidi_without_model_or_adjacent_action() {
        struct ModelMustNotRun;

        #[tonic::async_trait]
        impl ChatModel for ModelMustNotRun {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                panic!("a bounded negative control must not spend a model step")
            }
        }

        let (tx, mut out) = session(Arc::new(ModelMustNotRun));
        tx.send(Ok(understanding("Please tickle."))).await.unwrap();
        drop(tx);

        let answer = next(&mut out).await;
        assert_eq!(
            spoken(&answer),
            crate::assistant::engine::TICKLE_NEAR_MISS_RESPONSE
        );
        assert_closed(&mut out).await;
    }

    #[tokio::test]
    async fn server_tool_streams_informational_events_and_never_waits() {
        let model = MockChatModel::tool_then_answer(
            ToolCall {
                name: "web_search".into(),
                arguments: r#"{"query":"capital of France"}"#.into(),
            },
            "Paris is the capital of France.",
        );
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("what's the capital of France")))
            .await
            .unwrap();
        // Deliberately never send an observation: if the session waited for one it
        // could not reach the answer.
        drop(tx);

        let a = next(&mut out).await;
        assert!(!event(&a).requires_response, "server action must not block");
        let action = action_of(&a).expect("action");
        assert_eq!(action.action, "web_search");
        assert_eq!(action.source, pb::SynapseSource::Server as i32);
        assert_eq!(event(&a).agent, AGENT);

        let o = next(&mut out).await;
        assert!(
            !event(&o).requires_response,
            "server observation must not block"
        );
        let obs = observation_of(&o).expect("observation");
        assert_eq!(obs.action_name, "web_search");
        assert_eq!(obs.source, pb::SynapseSource::Server as i32);
        assert!(!obs.is_final);

        let r = next(&mut out).await;
        assert!(event(&r).requires_response, "Respond must be dispatched");
        assert_eq!(spoken(&r), "Paris is the capital of France.");
        assert_closed(&mut out).await;
    }

    // (b) A DEVICE tool must pause the loop on exactly one flagged event, then
    //     resume when the device's observation arrives.
    #[tokio::test]
    async fn device_tool_emits_one_requires_response_event_then_waits_for_the_observation() {
        let model = MockChatModel::new(vec![
            ChatResponse {
                content: None,
                thought: "the wearer wants a timer".into(),
                tool_call: Some(ToolCall {
                    name: "SetTimer".into(),
                    arguments: r#"{"minuteDuration":5,"name":"pasta"}"#.into(),
                }),
                extra_tool_calls: Vec::new(),
            },
            ChatResponse {
                content: Some("Your 5 minute pasta timer is running.".into()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("set a 5 minute pasta timer")))
            .await
            .unwrap();

        let a = next(&mut out).await;
        assert!(
            event(&a).requires_response,
            "a device tool must be flagged for device execution"
        );
        let action = action_of(&a).expect("action");
        assert_eq!(action.action, "SetTimer");
        assert_eq!(action.source, pb::SynapseSource::Device as i32);
        assert_eq!(action.thought, "the wearer wants a timer");
        let action_id = turn(&a).identifier.clone();

        // The server must now be parked: it neither executed the tool nor invented
        // an observation for it.
        assert_idle(&mut out).await;

        tx.send(Ok(observation(
            &action_id,
            "dev-1",
            "SetTimer",
            "Timer started.",
        )))
        .await
        .unwrap();

        let r = next(&mut out).await;
        assert!(event(&r).requires_response);
        assert_eq!(spoken(&r), "Your 5 minute pasta timer is running.");
        // The terminal Respond threads onto the DEVICE's observation turn.
        assert_eq!(turn(&r).parent_identifier, "dev-1");

        drop(tx);
        assert_closed(&mut out).await;
    }

    #[tokio::test]
    async fn bidi_enforces_the_same_consequential_action_confirmation() {
        let model = MockChatModel::new(vec![ChatResponse {
            tool_call: Some(ToolCall {
                name: "CallPerson".to_owned(),
                arguments: r#"{"To":["Dana"]}"#.to_owned(),
            }),
            ..Default::default()
        }]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("call Dana"))).await.unwrap();
        drop(tx);

        let response = next(&mut out).await;
        assert_eq!(spoken(&response), "Call Dana?");
        assert!(event(&response).requires_response);
        assert_closed(&mut out).await;
    }

    // (c) The run terminates in a Respond.
    #[tokio::test]
    async fn plain_answer_run_terminates_in_a_single_flagged_respond() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: Some("Hello there.".into()),
            thought: String::new(),
            tool_call: None,
            extra_tool_calls: Vec::new(),
        }]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("hi"))).await.unwrap();
        drop(tx);

        let r = next(&mut out).await;
        assert!(event(&r).requires_response);
        let a = action_of(&r).expect("action");
        assert_eq!(a.action, catalog::RESPOND_ACTION);
        assert_eq!(a.source, pb::SynapseSource::Device as i32);
        assert_eq!(spoken(&r), "Hello there.");
        assert_closed(&mut out).await;
    }

    /// `Respond` is a device action, but waiting on it would deadlock: its device
    /// observation is final and never posted back.
    #[tokio::test]
    async fn explicit_respond_tool_call_is_terminal_and_does_not_wait() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: None,
            thought: String::new(),
            tool_call: Some(ToolCall {
                name: catalog::RESPOND_ACTION.into(),
                arguments: r#"{"Response":"All set."}"#.into(),
            }),
            extra_tool_calls: Vec::new(),
        }]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("thanks"))).await.unwrap();

        let r = next(&mut out).await;
        assert!(event(&r).requires_response);
        assert_eq!(spoken(&r), "All set.");
        // The run is over without any observation from the device.
        drop(tx);
        assert_closed(&mut out).await;
    }

    #[tokio::test]
    async fn unknown_tool_bounces_the_stock_observation_without_requiring_a_response() {
        let model = MockChatModel::new(vec![
            ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(ToolCall {
                    name: "TotallyNotARealTool".into(),
                    arguments: "{}".into(),
                }),
                extra_tool_calls: Vec::new(),
            },
            ChatResponse {
                content: Some("Recovered.".into()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("x"))).await.unwrap();
        drop(tx);

        let a = next(&mut out).await;
        assert!(!event(&a).requires_response);
        let o = next(&mut out).await;
        assert!(
            !event(&o).requires_response,
            "the bounce must not ask the device to run anything"
        );
        let obs = observation_of(&o).expect("observation");
        assert_eq!(obs.observation, UNRECOGNIZED_FUNCTION);
        assert_eq!(obs.source, pb::SynapseSource::Device as i32);

        let r = next(&mut out).await;
        assert_eq!(spoken(&r), "Recovered.");
        assert_closed(&mut out).await;
    }

    /// REGRESSION: the action budget is per RUN, and a multi-hop run arrives with
    /// its earlier hops already in `device_context.turns`.
    ///
    /// `Switchboard` counts actions over the whole run
    /// (`numActionsInRun(run) > mActionLimit`). Counting only the steps taken
    /// inside this process let the server keep planning past the pin's own
    /// ceiling, at which point the DEVICE cuts the run short — the wearer's turn
    /// dies mid-flight with no terminal from us. The legacy engine has always
    /// seeded from the replayed transcript; bidi did not.
    #[tokio::test]
    async fn a_replayed_run_consumes_the_bidi_action_budget() {
        struct AlwaysSearch;
        #[tonic::async_trait]
        impl ChatModel for AlwaysSearch {
            async fn complete(
                &self,
                _m: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                Ok(ChatResponse {
                    content: None,
                    thought: String::new(),
                    tool_call: Some(ToolCall {
                        name: "web_search".into(),
                        arguments: r#"{"query":"loop"}"#.into(),
                    }),
                    extra_tool_calls: Vec::new(),
                })
            }
        }

        // A replayed run in which the device already executed 6 actions: a root
        // plus a parent-linked chain, exactly as `EventsSnapshot.linearize` sends.
        const ALREADY: usize = 6;
        let mut turns = vec![pb::SynapseChatTurn {
            identifier: "root".to_owned(),
            parent_identifier: String::new(),
            ..Default::default()
        }];
        for i in 0..ALREADY {
            let parent = turns.last().unwrap().identifier.clone();
            turns.push(pb::SynapseChatTurn {
                identifier: format!("a{i}"),
                parent_identifier: parent,
                content: Some(pb::synapse_chat_turn::Content::Action(
                    pb::SynapseActionContent {
                        action: "web_search".to_owned(),
                        input: "{}".to_owned(),
                        source: pb::SynapseSource::Server as i32,
                        ..Default::default()
                    },
                )),
                ..Default::default()
            });
        }

        let (tx, mut out) = session(Arc::new(AlwaysSearch));
        tx.send(Ok(pb::StreamingUnderstandRequest {
            content: Some(
                pb::streaming_understand_request::Content::UnderstandingRequest(
                    pb::SynapseUnderstandingRequest {
                        utterance: "keep going".to_owned(),
                        device_context: Some(pb::SynapseDeviceContext {
                            turns,
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                ),
            ),
        }))
        .await
        .unwrap();
        drop(tx);

        let mut msgs = Vec::new();
        while let Some(m) = out.next().await {
            msgs.push(m.unwrap());
        }

        // Only the remaining budget may be spent here: 2 server steps
        // (action + observation each), then TooManyActions + the terminal Respond.
        let remaining = MAX_STEPS - ALREADY;
        assert_eq!(
            msgs.len(),
            remaining * 2 + 2,
            "bidi must spend only the run's REMAINING budget; the device already \
             executed {ALREADY} of {MAX_STEPS} actions in this run",
        );
        assert!(
            msgs.iter()
                .filter_map(observation_of)
                .any(|o| o.observation == TOO_MANY_ACTIONS),
            "the run must end on the runaway guard, not by exhausting the process budget",
        );
    }

    /// REGRESSION, and a lesson about fixing one transport at a time.
    ///
    /// The blank-content guard landed on the legacy engine but not here, so the
    /// wearer-facing silence it was written to prevent survived on this
    /// transport. `RespondAction.mResponse` is a present-but-empty slot: the
    /// device resolves and dispatches the action, narrates nothing, and the
    /// resulting observation is final, so nothing ever retries.
    #[tokio::test]
    async fn blank_model_content_is_not_spoken_as_an_empty_respond_on_bidi() {
        struct BlankAnswer;
        #[tonic::async_trait]
        impl ChatModel for BlankAnswer {
            async fn complete(
                &self,
                _m: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                Ok(ChatResponse {
                    content: Some("   ".to_owned()),
                    thought: String::new(),
                    tool_call: None,
                    extra_tool_calls: Vec::new(),
                })
            }
        }

        let (tx, mut out) = session(Arc::new(BlankAnswer));
        tx.send(Ok(understanding("say nothing"))).await.unwrap();
        drop(tx);

        let mut msgs = Vec::new();
        while let Some(m) = out.next().await {
            msgs.push(m.unwrap());
        }
        let last = msgs.last().expect("a terminal turn");
        let spoken = action_of(last)
            .and_then(|a| crate::assistant::catalog::respond_input_from_arguments(&a.input))
            .unwrap_or_default();
        assert!(
            !spoken.trim().is_empty(),
            "a terminal Respond must contain speakable text; blank narrates nothing \
             and its observation is final, so the run dies in silence",
        );
    }

    #[tokio::test]
    async fn action_budget_exhaustion_yields_too_many_actions_then_respond() {
        // A model that only ever calls a server tool: it can never finish.
        struct AlwaysSearch;
        #[tonic::async_trait]
        impl ChatModel for AlwaysSearch {
            async fn complete(
                &self,
                _m: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                Ok(ChatResponse {
                    content: None,
                    thought: String::new(),
                    tool_call: Some(ToolCall {
                        name: "web_search".into(),
                        arguments: r#"{"query":"loop"}"#.into(),
                    }),
                    extra_tool_calls: Vec::new(),
                })
            }
        }
        let (tx, mut out) = session(Arc::new(AlwaysSearch));
        tx.send(Ok(understanding("loop forever"))).await.unwrap();
        drop(tx);

        let mut msgs = Vec::new();
        while let Some(m) = out.next().await {
            msgs.push(m.unwrap());
        }
        // 8 server steps (action + observation each), then TooManyActions + Respond.
        assert_eq!(msgs.len(), MAX_STEPS * 2 + 2);
        let too_many = msgs
            .iter()
            .filter_map(observation_of)
            .find(|o| o.observation == TOO_MANY_ACTIONS)
            .expect("TooManyActions observation");
        assert_eq!(too_many.action_name, "TooManyActions");
        let last = msgs.last().unwrap();
        assert!(event(last).requires_response);
        // Both transports must put the SAME stock sentence in the wearer's ear for
        // the same guard, and it must be the observation's own text (that is what
        // `convertAndDispatchGeneratedActionIfNeeded` respeaks).
        assert_eq!(spoken(last), TOO_MANY_ACTIONS);
        assert_eq!(spoken(last), super::super::engine::TOO_MANY_ACTIONS);
    }

    /// A final device observation ends the run; the server must not re-prompt into
    /// a closed run (the mock would error and speak an apology if it did).
    #[tokio::test]
    async fn final_device_observation_ends_the_run_without_another_model_call() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: None,
            thought: String::new(),
            tool_call: Some(ToolCall {
                name: "SetTimer".into(),
                arguments: r#"{"minuteDuration":1}"#.into(),
            }),
            extra_tool_calls: Vec::new(),
        }]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("timer"))).await.unwrap();
        let a = next(&mut out).await;
        let action_id = turn(&a).identifier.clone();
        tx.send(Ok(observation_with_finality(
            &action_id, "dev-1", "SetTimer", "Done.", true,
        )))
        .await
        .unwrap();
        // Deliberately DO NOT drop `tx`. A real pin never half-closes its request
        // stream — it blocks in `responseFuture.get()` with no deadline. If the
        // session answers a final observation with `Flow::Done` it parks in
        // `next_request` and both sides wait forever; the only thing that can end
        // this stream is the SERVER half-closing. Dropping `tx` here would supply
        // that half-close from the test and the assertion would hold either way.
        assert_closed(&mut out).await;
    }

    /// An observation for some other action is superseded work and must not
    /// resume the pending step.
    #[tokio::test]
    async fn observation_for_a_different_action_is_discarded() {
        let model = MockChatModel::new(vec![
            ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(ToolCall {
                    name: "SetTimer".into(),
                    arguments: r#"{"minuteDuration":5}"#.into(),
                }),
                extra_tool_calls: Vec::new(),
            },
            ChatResponse {
                content: Some("Timer set.".into()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("set a timer"))).await.unwrap();
        let a = next(&mut out).await;
        let action_id = turn(&a).identifier.clone();

        tx.send(Ok(observation(
            "some-other-action",
            "stale",
            "SetTimer",
            "stale result",
        )))
        .await
        .unwrap();
        assert_idle(&mut out).await;

        tx.send(Ok(observation(
            &action_id,
            "dev-1",
            "SearchContact",
            "Ada Lovelace",
        )))
        .await
        .unwrap();
        let r = next(&mut out).await;
        assert_eq!(spoken(&r), "Timer set.");
        drop(tx);
        assert_closed(&mut out).await;
    }

    /// Client hangs up while the server is parked: half-close, never fabricate.
    #[tokio::test]
    async fn hangup_while_awaiting_a_device_observation_half_closes() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: None,
            thought: String::new(),
            tool_call: Some(ToolCall {
                name: "SetTimer".into(),
                arguments: "{}".into(),
            }),
            extra_tool_calls: Vec::new(),
        }]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("timer"))).await.unwrap();
        let a = next(&mut out).await;
        assert!(event(&a).requires_response);
        drop(tx);
        assert_closed(&mut out).await;
    }

    /// A fresh utterance mid-run supersedes the pending device action.
    #[tokio::test]
    async fn a_new_understanding_request_supersedes_the_pending_device_action() {
        let model = MockChatModel::new(vec![
            ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(ToolCall {
                    name: "SetTimer".into(),
                    arguments: "{}".into(),
                }),
                extra_tool_calls: Vec::new(),
            },
            ChatResponse {
                content: Some("Never mind, then.".into()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("set a timer"))).await.unwrap();
        let a = next(&mut out).await;
        assert_eq!(action_of(&a).unwrap().action, "SetTimer");

        tx.send(Ok(understanding("actually, cancel that")))
            .await
            .unwrap();
        let r = next(&mut out).await;
        assert_eq!(spoken(&r), "Never mind, then.");
        drop(tx);
        assert_closed(&mut out).await;
    }

    /// The stream is a session, not a single turn: it serves the next
    /// `understanding_request` on the same connection (device-side session reuse).
    #[tokio::test]
    async fn the_session_serves_a_second_turn_on_the_same_stream() {
        let model = MockChatModel::new(vec![
            ChatResponse {
                content: Some("First.".into()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
            ChatResponse {
                content: Some("Second.".into()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("one"))).await.unwrap();
        let first = next(&mut out).await;
        assert_eq!(spoken(&first), "First.");
        tx.send(Ok(understanding("two"))).await.unwrap();
        let second = next(&mut out).await;
        assert_eq!(spoken(&second), "Second.");
        // Ids stay unique across turns within the session. They are UUIDs, not a
        // sequence: a counter restarts per stream and would eventually re-mint an
        // id the device still holds, which throws in LocalChatTurnService.record.
        assert_ne!(turn(&first).identifier, turn(&second).identifier);
        assert!(uuid::Uuid::parse_str(&turn(&second).identifier).is_ok());
        drop(tx);
        assert_closed(&mut out).await;
    }

    /// REGRESSION: cosmos allows exactly one active run — a turn that is its own
    /// root replaces `mExecutingRun` and the old run's turns are blocked as
    /// orphans. A barge-in must abandon the in-flight step immediately, not let
    /// it grind out an answer to a superseded question.
    #[tokio::test]
    async fn a_barge_in_preempts_an_in_flight_model_step() {
        use std::sync::Arc;
        use tokio::sync::Notify;

        /// Stalls the FIRST step until released, so the barge-in lands
        /// mid-flight, and answers by echoing the question it was actually given
        /// — otherwise both runs would be indistinguishable in the output.
        struct StalledModel {
            released: Arc<Notify>,
            stalled: std::sync::atomic::AtomicBool,
        }
        #[tonic::async_trait]
        impl ChatModel for StalledModel {
            async fn complete(
                &self,
                m: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                use std::sync::atomic::Ordering;
                if self
                    .stalled
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    self.released.notified().await;
                }
                let asked = m
                    .iter()
                    .rev()
                    .find(|x| x.role == crate::assistant::llm::Role::User)
                    .map(|x| x.content.clone())
                    .unwrap_or_default();
                Ok(ChatResponse {
                    content: Some(format!("answer to: {asked}")),
                    thought: String::new(),
                    tool_call: None,
                    extra_tool_calls: Vec::new(),
                })
            }
        }

        let released = Arc::new(Notify::new());
        let (tx, mut out) = session(Arc::new(StalledModel {
            released: released.clone(),
            stalled: std::sync::atomic::AtomicBool::new(false),
        }));

        tx.send(Ok(understanding("first question"))).await.unwrap();
        // Barge in while the first step is still stalled.
        tx.send(Ok(understanding("second question"))).await.unwrap();
        // Now let the abandoned step's model call resolve; nothing may be spoken
        // for it.
        released.notify_waiters();
        released.notify_one();

        // The only thing spoken must answer the SECOND question; the abandoned
        // run's reply must never reach the wearer.
        let first_spoken = next(&mut out).await;
        let text = spoken(&first_spoken);
        assert!(
            text.contains("second question"),
            "the surviving run must answer the barge-in, got: {text}"
        );
        assert!(
            !text.contains("first question"),
            "the superseded run must not reach the wearer, got: {text}"
        );
        drop(tx);
    }

    #[tokio::test]
    async fn a_barge_in_preempts_an_in_flight_server_tool() {
        struct PromptAwareModel;

        #[tonic::async_trait]
        impl ChatModel for PromptAwareModel {
            async fn complete(
                &self,
                messages: &[ChatMessage],
                _tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                let asked = messages
                    .iter()
                    .rev()
                    .find(|message| message.role == Role::User)
                    .map(|message| message.content.as_str())
                    .unwrap_or_default();
                if asked == "second question" {
                    return Ok(ChatResponse {
                        content: Some("answer to: second question".to_owned()),
                        ..Default::default()
                    });
                }
                Ok(ChatResponse {
                    tool_call: Some(ToolCall {
                        name: "music_discover".to_owned(),
                        arguments: serde_json::json!({
                            "artist": "Drake",
                            "title": "Started From the Bottom",
                            "criterion": "most controversial",
                            "timeframe": "all_time",
                            "year": 2013
                        })
                        .to_string(),
                    }),
                    ..Default::default()
                })
            }
        }

        struct NeverReturns;

        #[tonic::async_trait]
        impl crate::backends::music_discovery::MusicDiscoveryBackend for NeverReturns {
            async fn discover(
                &self,
                _request: crate::backends::music_discovery::MusicDiscoveryRequest,
                _principal: &str,
                _deadline: Option<std::time::Instant>,
            ) -> Result<
                crate::backends::music_discovery::GroundedMusicTrack,
                crate::backends::music_discovery::MusicDiscoveryError,
            > {
                std::future::pending().await
            }
        }

        let (tx, rx) = mpsc::channel(16);
        let mut out = BidiSession::spawn_tuned(
            Arc::new(PromptAwareModel),
            Entitlement::Active,
            catalog::ToolContext {
                principal: Some("V:01:D:test:U:wearer".to_owned()),
                music_discovery: Some(Arc::new(NeverReturns)),
                ..Default::default()
            },
            ReceiverStream::new(rx),
            Duration::from_secs(2),
            Duration::from_secs(2),
        );

        tx.send(Ok(understanding(
            "play Drake's most controversial song from 2013",
        )))
        .await
        .unwrap();
        let selected_tool = next(&mut out).await;
        assert_eq!(action_of(&selected_tool).unwrap().action, "music_discover");

        tx.send(Ok(understanding("second question"))).await.unwrap();
        let second = tokio::time::timeout(Duration::from_millis(300), out.next())
            .await
            .expect("the stalled tool ignored the barge-in")
            .expect("the session closed instead of serving the barge-in")
            .expect("session error");
        assert_eq!(spoken(&second), "answer to: second question");
        drop(tx);
    }

    /// A run-state seed carries no request, so `initial_run_state` is accepted
    /// and skipped rather than failing the stream. The seed here holds two
    /// agents on purpose — see the note on the literal below.
    #[tokio::test]
    async fn a_run_state_seed_is_skipped_not_fatal() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: Some("Ready.".into()),
            thought: String::new(),
            tool_call: None,
            extra_tool_calls: Vec::new(),
        }]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(pb::StreamingUnderstandRequest {
            content: Some(pb::streaming_understand_request::Content::InitialRunState(
                // A seed with SEVERAL agents in it, on purpose. `agent_to_runs`
                // was declared `bytes` here until the two wire trees were
                // reconciled, and a `bytes` field decodes a multi-entry map
                // without complaint while keeping only the last entry's raw
                // bytes — so a single-entry seed would pass under both the right
                // declaration and the wrong one. Two entries do not.
                pb::RunState {
                    agent_to_runs: std::collections::HashMap::from([
                        ("assistant".to_string(), pb::Runs { runs: Vec::new() }),
                        ("planner".to_string(), pb::Runs { runs: Vec::new() }),
                    ]),
                },
            )),
        }))
        .await
        .unwrap();
        tx.send(Ok(understanding("hello"))).await.unwrap();
        assert_eq!(spoken(&next(&mut out).await), "Ready.");
        drop(tx);
        assert_closed(&mut out).await;
    }

    /// A model step that is slow but never slow enough to trip the PER-STEP
    /// ceiling, and that never finishes the job. Only a whole-run budget can stop
    /// it.
    struct SlowRunawayModel(Duration);
    #[tonic::async_trait]
    impl ChatModel for SlowRunawayModel {
        async fn complete(
            &self,
            _m: &[ChatMessage],
            _t: &[ToolDef],
        ) -> Result<ChatResponse, LlmError> {
            tokio::time::sleep(self.0).await;
            Ok(ChatResponse {
                content: None,
                thought: String::new(),
                // An unrecognized tool bounces and loops without touching the
                // network, so the run's wall clock is exactly the model's.
                tool_call: Some(ToolCall {
                    name: "TotallyNotARealTool".into(),
                    arguments: "{}".into(),
                }),
                extra_tool_calls: Vec::new(),
            })
        }
    }

    /// REGRESSION: bidi bounded a single model step and a single device wait, but
    /// nothing bounded the RUN. Eight steps just under the per-step ceiling, plus
    /// unbounded tool time, is minutes of wall clock — and on this transport
    /// nothing on the device side cuts it short either
    /// (`AIBusService.bidirectionalStreamingUnderstand` sets no
    /// `withDeadlineAfter`, and `getNextDeviceActionResponse` blocks in an
    /// unbounded `responseFuture.get()`), so the wearer just stands there.
    ///
    /// The budget is scaled down (1.5s instead of 22s) so the test costs
    /// milliseconds; the machinery under it is the production path.
    #[tokio::test]
    async fn a_slow_run_is_bounded_by_the_run_budget_and_still_speaks() {
        const BUDGET: Duration = Duration::from_millis(1_500);
        // 450ms a step: three steps fit, the fourth cannot start. Each step is
        // well inside MODEL_STEP_TIMEOUT, so the per-step ceiling never fires and
        // only a whole-run budget can end this.
        let started = std::time::Instant::now();
        let (tx, mut out) = session_with_clocks(
            Arc::new(SlowRunawayModel(Duration::from_millis(450))),
            BUDGET,
            DEVICE_OBSERVATION_TIMEOUT,
        );
        tx.send(Ok(understanding("take as long as you like")))
            .await
            .unwrap();
        drop(tx);

        let mut msgs = Vec::new();
        while let Some(m) = tokio::time::timeout(Duration::from_secs(30), out.next())
            .await
            .expect("the run never ended")
        {
            msgs.push(m.unwrap());
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed <= BUDGET + Duration::from_millis(500),
            "the run must be bounded by the {BUDGET:?} run budget; it ran for {elapsed:?}",
        );
        let last = msgs.last().expect("a terminal turn");
        assert!(
            event(last).requires_response,
            "a budget-exhausted run must still end in a DISPATCHED terminal, or the \
             device merely records it and the wearer hears nothing",
        );
        // The same string the device speaks for itself when its own deadline
        // fires, and the same one the legacy engine speaks for this guard.
        assert_eq!(spoken(last), ERROR_TIMEOUT);
    }

    /// REGRESSION: the wait for a device observation used to end in a bare
    /// half-close. That completes the pin's pending future with an empty queue —
    /// no event, nothing dispatched, nothing narrated. The wearer has by then
    /// stood through a whole device action and hears nothing at all.
    #[tokio::test]
    async fn a_device_action_that_never_comes_back_still_ends_in_a_spoken_terminal() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: None,
            thought: String::new(),
            tool_call: Some(ToolCall {
                name: "SetTimer".into(),
                arguments: r#"{"minuteDuration":5}"#.into(),
            }),
            extra_tool_calls: Vec::new(),
        }]);
        // Budget shorter than the per-wait AIMIC ceiling, as in production
        // (22s vs 25s): the run's own clock is what ends the park.
        let (tx, mut out) = session_with_clocks(
            Arc::new(model),
            Duration::from_millis(900),
            Duration::from_secs(25),
        );
        tx.send(Ok(understanding("set a timer"))).await.unwrap();

        let a = tokio::time::timeout(Duration::from_secs(30), out.next())
            .await
            .expect("no action emitted")
            .expect("stream ended early")
            .expect("session error");
        assert!(event(&a).requires_response);
        assert_eq!(action_of(&a).unwrap().action, "SetTimer");

        // The pin never answers, and never hangs up either — it is blocked in an
        // unbounded `responseFuture.get()`, so only the server can end this.
        let r = tokio::time::timeout(Duration::from_secs(30), out.next())
            .await
            .expect("the session never gave up on the device")
            .expect("the session half-closed silently instead of speaking")
            .expect("session error");
        assert!(event(&r).requires_response);
        assert_eq!(spoken(&r), ERROR_TIMEOUT);
        drop(tx);
    }

    /// The server tool ceiling. Every server tool is a call to somebody else's
    /// endpoint; one that accepts the connection and then stalls held the whole
    /// run open, because this was the last unbounded await in the loop.
    ///
    /// NOTE: driven at the helper rather than through a run, because no server
    /// tool in the catalog can be made to stall from a test without an injection
    /// point in `catalog.rs` (not this agent's file). The helper has exactly one
    /// call site, in the server-tool branch of `run_turn`.
    #[tokio::test]
    async fn a_stalled_server_tool_is_cut_off_at_the_remaining_budget() {
        let observation = bounded_tool(Duration::from_millis(50), async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            "a result that arrived far too late".to_owned()
        })
        .await;
        assert_eq!(
            observation, TOOL_TIMED_OUT,
            "a stalled tool must yield an honest empty-handed observation, never \
             its late result and never an unbounded wait",
        );
    }

    #[tokio::test]
    async fn bidi_propagates_the_foreground_deadline_into_multistage_tools() {
        use std::sync::atomic::{AtomicBool, Ordering};

        struct DeadlineProbe(Arc<AtomicBool>);

        #[tonic::async_trait]
        impl crate::backends::music_discovery::MusicDiscoveryBackend for DeadlineProbe {
            async fn discover(
                &self,
                _request: crate::backends::music_discovery::MusicDiscoveryRequest,
                _principal: &str,
                deadline: Option<std::time::Instant>,
            ) -> Result<
                crate::backends::music_discovery::GroundedMusicTrack,
                crate::backends::music_discovery::MusicDiscoveryError,
            > {
                self.0.store(deadline.is_some(), Ordering::SeqCst);
                Err(crate::backends::music_discovery::MusicDiscoveryError::NoEvidence)
            }
        }

        let saw_deadline = Arc::new(AtomicBool::new(false));
        let model = Arc::new(MockChatModel::tool_then_answer(
            ToolCall {
                name: "music_discover".to_owned(),
                arguments: serde_json::json!({
                    "artist": "Drake",
                    "title": "Started From the Bottom",
                    "criterion": "most controversial",
                    "timeframe": "all_time",
                    "year": 2013
                })
                .to_string(),
            },
            "No supported result was found.",
        ));
        let (tx, rx) = mpsc::channel(16);
        let mut out = BidiSession::spawn_with(
            model,
            Entitlement::Active,
            catalog::ToolContext {
                principal: Some("V:01:D:test:U:wearer".to_owned()),
                music_discovery: Some(Arc::new(DeadlineProbe(saw_deadline.clone()))),
                ..Default::default()
            },
            ReceiverStream::new(rx),
        );

        tx.send(Ok(understanding(
            "play Drake's most controversial song from 2013",
        )))
        .await
        .unwrap();
        drop(tx);
        while out.next().await.is_some() {}

        assert!(
            saw_deadline.load(Ordering::SeqCst),
            "every multistage tool must share the foreground turn's absolute deadline"
        );
    }

    #[tokio::test]
    async fn bidi_receives_the_same_typed_wearer_memory_as_legacy() {
        #[derive(Default)]
        struct MemoryCapturingModel(std::sync::Mutex<Vec<ChatMessage>>);

        #[tonic::async_trait]
        impl ChatModel for MemoryCapturingModel {
            async fn complete(
                &self,
                messages: &[ChatMessage],
                _tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                *self.0.lock().unwrap() = messages.to_vec();
                Ok(ChatResponse {
                    content: Some("Noodles.".to_owned()),
                    ..Default::default()
                })
            }
        }

        let principal = "V:01:D:test:U:wearer";
        let store: crate::store::SharedStore = Arc::new(crate::store::MemoryStore::default());
        let note = store.create_note(principal, None, None).await.unwrap();
        store
            .index_note(principal, &note.uuid, "i like noodles")
            .await;

        let model = Arc::new(MemoryCapturingModel::default());
        let (tx, rx) = mpsc::channel(16);
        let mut out = BidiSession::spawn_with(
            model.clone(),
            Entitlement::Active,
            catalog::ToolContext {
                principal: Some(principal.to_owned()),
                store: Some(store),
                ..Default::default()
            },
            ReceiverStream::new(rx),
        );
        tx.send(Ok(understanding("what are my interests")))
            .await
            .unwrap();
        let _ = next(&mut out).await;

        let seen = model.0.lock().unwrap();
        assert!(seen.iter().any(|message| {
            message.role == Role::Memory && message.content.contains("i like noodles")
        }));
        assert!(!seen.iter().any(|message| {
            message.role == Role::System && message.content.contains("i like noodles")
        }));
        drop(tx);
    }

    /// REGRESSION: every emitted turn must contain a wall-clock stamp.
    ///
    /// An absent timestamp decodes as epoch 0 on the device, so the node sorts
    /// first in the turn priority queue and is evicted first at the turn cap,
    /// and `linearize`'s inter-run gap test sees a ~56-year gap and truncates the
    /// history the next hop depends on. The legacy engine has stamped its turns
    /// since that was found; bidi stamped none of them — and bidi is the
    /// transport where the device records EVERY event, not just the last action.
    #[tokio::test]
    async fn every_emitted_turn_is_timestamped_on_bidi() {
        let model = MockChatModel::new(vec![
            ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(ToolCall {
                    name: "TotallyNotARealTool".into(),
                    arguments: "{}".into(),
                }),
                extra_tool_calls: Vec::new(),
            },
            ChatResponse {
                content: Some("Recovered.".into()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("x"))).await.unwrap();
        drop(tx);

        let mut msgs = Vec::new();
        while let Some(m) = out.next().await {
            msgs.push(m.unwrap());
        }
        assert_eq!(msgs.len(), 3, "action + observation + terminal Respond");
        for m in &msgs {
            let ts = turn(m)
                .timestamp
                .as_ref()
                .expect("every emitted turn carries a timestamp");
            assert!(
                ts.seconds > 1_600_000_000,
                "an epoch-0 stamp is what an absent one decodes to; got {}",
                ts.seconds,
            );
        }
    }

    /// REGRESSION: an observation re-enters the model's context on every later
    /// step of the run, so its length is paid for in prompt tokens and in the
    /// latency of each remaining step. The legacy engine clips what it feeds
    /// back; bidi fed the whole thing — and on bidi the longest observations are
    /// the DEVICE's, which arrive on this same path.
    ///
    /// The wire copy is untouched; only the transcript is clipped.
    #[tokio::test]
    async fn a_long_device_observation_is_clipped_before_it_re_enters_the_transcript() {
        /// Calls a device tool first, then echoes back the transcript line the
        /// observation produced — which is the thing under test.
        struct EchoTranscript(std::sync::atomic::AtomicUsize);
        #[tonic::async_trait]
        impl ChatModel for EchoTranscript {
            async fn complete(
                &self,
                m: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                use std::sync::atomic::Ordering;
                if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Ok(ChatResponse {
                        content: None,
                        thought: String::new(),
                        tool_call: Some(ToolCall {
                            name: "SetTimer".into(),
                            arguments: r#"{"minuteDuration":5,"name":"pasta"}"#.into(),
                        }),
                        extra_tool_calls: Vec::new(),
                    });
                }
                Ok(ChatResponse {
                    content: m.last().map(|x| x.content.clone()),
                    thought: String::new(),
                    tool_call: None,
                    extra_tool_calls: Vec::new(),
                })
            }
        }

        let (tx, mut out) = session(Arc::new(EchoTranscript(
            std::sync::atomic::AtomicUsize::new(0),
        )));
        tx.send(Ok(understanding("set a timer"))).await.unwrap();
        let a = next(&mut out).await;
        assert!(event(&a).requires_response, "the pin runs this one");
        let action_id = turn(&a).identifier.clone();

        // A device observation far longer than anything a spoken answer needs.
        let long: String = std::iter::repeat_n("The timer is running. ", 400)
            .collect::<Vec<_>>()
            .concat();
        assert!(long.len() > MAX_MODEL_FACING_OBSERVATION * 4);
        tx.send(Ok(observation(&action_id, "dev-1", "SetTimer", &long)))
            .await
            .unwrap();

        let r = next(&mut out).await;
        let echoed = spoken(&r);
        assert!(
            echoed.contains("… [truncated]"),
            "the transcript line must be marked as clipped so the model does not \
             read a cut list as complete",
        );
        assert!(
            echoed.len() < MAX_MODEL_FACING_OBSERVATION + 200,
            "the clipped transcript line is {} bytes; the observation was {}",
            echoed.len(),
            long.len(),
        );
        drop(tx);
    }

    /// REGRESSION: an observation arriving with no run in flight is the device
    /// closing out the run we just terminated — its `Respond` handler completed
    /// with a FINAL observation and the pin is now blocked on an unbounded
    /// `responseFuture.get()`. Ignoring it parks the wearer for the full 25s
    /// AIMIC deadline AFTER the answer was already spoken. Half-closing lets the
    /// client's `close()` complete that future immediately.
    #[tokio::test]
    async fn a_close_out_observation_ends_the_session_rather_than_parking_the_pin() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: Some("Ready.".into()),
            thought: String::new(),
            tool_call: None,
            extra_tool_calls: Vec::new(),
        }]);
        let (tx, mut out) = session(Arc::new(model));
        tx.send(Ok(understanding("hello"))).await.unwrap();
        assert_eq!(spoken(&next(&mut out).await), "Ready.");

        // The pin executed the terminal Respond and posts its final observation.
        tx.send(Ok(observation("", "close-out", "Respond", "done")))
            .await
            .unwrap();
        // The session must half-close rather than sit waiting for more input.
        assert_closed(&mut out).await;
        drop(tx);
    }
}
