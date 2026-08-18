//! Native tool-calling chat-turn loop.
//! Stock: ironman/sources/humaneinternal/system/intent/SynapseChatTurnUtils.java
//!
//! This is the orchestration core described in the external-agent architecture
//! comparison. It follows the reference agent's control flow: one model
//! step per iteration containing the full transcript and a native tool catalog;
//! the model answers with assistant text (final) or proposed tool calls. For
//! a step that contains only independent, explicitly batch-safe reads executes
//! those reads concurrently and appends every real observation before the
//! model replans. Mixed, dependent, preflight-capable, write, and mutation
//! batches stay serial in provider order. Read-tool failures become
//! `[TOOL_ERROR]` observations the model corrects on the next iteration; a
//! bounded iteration budget with a tool-free grace call terminates the run.
//! Unlike that external reference project, a mutation tool call does not
//! execute here — it terminates the loop into the deterministic native-action
//! path so the device product contract (typed dispatch, gates, one terminal
//! mutation) is preserved.
//!
//! The loop is pure orchestration and provider/tool-agnostic: the concrete tool
//! catalog, argument mapping, read execution and mutation validation are
//! supplied by a [`ToolCatalog`] implementation (the aibus layer). This keeps
//! the loop unit-testable with scripted tools and a scripted backend.

use rig::completion::message::{
    AssistantContent, Message, ToolCall, ToolFunction, ToolResultContent, UserContent,
};
use rig::OneOrMany;

use futures::{stream, StreamExt};
use std::collections::HashMap;

use crate::llm::backend::LlmBackend;
use crate::llm::tool_step::{
    ToolStepCall, ToolStepDefinition, ToolStepRequest, ToolStepResult, MAX_TOOL_STEP_RESULT_BYTES,
    TOOL_STEP_ERROR_PREFIX,
};
use crate::llm::{friendly_error_message, WEARER_FACING_ERRORS};
use crate::synapse::authority::runtime::{
    emit_agentic_terminal_trace, emit_agentic_tool_trace, AgenticTraceResult, AgenticTraceTool,
};
use crate::tier_a::operational_markers;
use crate::turn_trace::{TraceEvent, TurnTracer};

/// What a tool call produced.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolExecutionOutcome {
    /// A read observation to feed back to the model (already bounded/sanitized
    /// by the tools impl). `ok=false` means the read failed or was
    /// unavailable; the loop stamps `[TOOL_ERROR]` and continues.
    Observation { ok: bool, content: String },
    /// A validated terminal native mutation. The loop stops and hands this to
    /// the caller for stock dispatch; the model never sees a result.
    Terminal(ValidatedNativeAction),
    /// The model asked for one device observation (e.g. current location)
    /// before a read can run. The loop stops and returns it so the caller can
    /// run the existing preflight/resume path.
    Preflight {
        action: String,
        arguments: serde_json::Value,
    },
}

/// A validated native mutation ready for the stock action path.
#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedNativeAction {
    pub action: String,
    pub arguments: serde_json::Value,
}

/// The terminal result of a chat-turn run.
#[derive(Clone, Debug, PartialEq)]
pub enum ChatTurnOutcome {
    /// A spoken final answer.
    Answer(String),
    /// A validated native mutation for stock dispatch.
    NativeAction(ValidatedNativeAction),
    /// One required device observation before the run can continue.
    Preflight {
        action: String,
        arguments: serde_json::Value,
    },
    /// The run could not produce a grounded result within its budget.
    Decline(String),
}

/// Reason a run declined, for content-free tracing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatTurnDeclineReason {
    Budget,
    EmptyModel,
    BackendUnavailable,
    NoProgress,
}

impl ChatTurnDeclineReason {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Budget => "budget",
            Self::EmptyModel => "empty_model",
            Self::BackendUnavailable => operational_markers::BACKEND_UNAVAILABLE,
            Self::NoProgress => "no_progress",
        }
    }
}

/// Concise, truthful spoken decline text (never leaks internal reasons).
///
/// Last resort only: it is used when the failure is an unexpectedly long or
/// empty backend error, i.e. the one case where we honestly do not know the
/// cause. "Something went wrong on my end" is accurate about that, and asking
/// again is the only next step that is true — the wearer has no screen, no log
/// and no other affordance, so a refusal that stops at "I couldn't" leaves them
/// with nothing to do.
const CHAT_TURN_GENERIC_DECLINE: &str = "Something went wrong on my end. Please ask me again.";

/// Supplied by the aibus layer: the tool surface and how to run it.
#[tonic::async_trait]
pub trait ToolCatalog: Send + Sync {
    /// Tools advertised to the model this run (already gated by unlock,
    /// consent, provider availability, and feature flags — the model must
    /// never see a tool it may not call).
    fn catalog(&self) -> Vec<ToolStepDefinition>;

    /// A privacy-safe progress cue for the selected pending tool call, or
    /// `None` when nothing citable-safe can be said. Names only; never args.
    fn cue_for(&self, tool_names: &[&str]) -> Option<String>;

    /// Execute one tool call. Reads run and return an `Observation`;
    /// mutation tools validate and return `Terminal`; a read needing a device
    /// observation returns `Preflight`. An unknown/invalid call MUST return a
    /// failed `Observation` (never an error) so the model can self-correct.
    async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome;

    /// Whether this registered call is safe to execute concurrently with
    /// sibling calls from the same model step.
    ///
    /// `true` is a strong contract: the call is read-only, side-effect free,
    /// independent of sibling results, and always returns `Observation` (never
    /// `Terminal` or `Preflight`). The default is serial and fail-closed.
    fn parallel_read_safe(&self, _tool_name: &str) -> bool {
        false
    }

    /// Deterministic final-answer verification gate (the external reference-agent
    /// recovery-gate pattern): given a proposed final answer, return `Some(nudge)` when the
    /// run has an unmet completion obligation the model skipped (for example a
    /// play request whose provider search succeeded but whose play_music call
    /// never happened). The loop rejects the final ONCE, feeds the nudge back,
    /// and continues; a second final is always accepted.
    fn final_answer_nudge(&self, _final_answer: &str) -> Option<String> {
        None
    }

    /// A deterministic terminal action the loop MUST dispatch instead of
    /// accepting prose.
    ///
    /// The nudge asks the model to finish; this is what happens when it will
    /// not. Measured on device: a play request returned 5-10 citable tracks,
    /// `play_music` was advertised, and the nudge fired — yet the model
    /// re-searched to the iteration ceiling and answered with text on 0/3 runs.
    /// Deterministic code owns dispatch, so a model that declines to finish
    /// must not strand the user.
    ///
    /// Implementations build the action from an audited same-run result; it
    /// still passes catalog validation, authorization and lock state before
    /// dispatch.
    fn forced_terminal_action(&self, _final_answer: &str) -> Option<ValidatedNativeAction> {
        None
    }
}

/// Receives an ephemeral, run-owned progress cue for an operation that has
/// actually been selected. Cue prose is a presentation side channel only: an
/// implementation must never put it in model messages, stock turns, logs,
/// transcripts, memory, or telemetry.
///
/// Production currently discards this side channel because no verified stock
/// path can speak a cue without also recording or logging it. Tests use a
/// recording sink to keep the planner/cue separation covered.
// Retained for future cue implementation per R-004
#[allow(dead_code)]
pub struct ChatTurnProgressCue<'a> {
    run_id: &'a str,
    operation: &'a str,
    phrase: &'a str,
}

// Retained for future cue implementation per R-004
#[allow(dead_code)]
impl ChatTurnProgressCue<'_> {
    pub fn run_id(&self) -> &str {
        self.run_id
    }

    pub fn operation(&self) -> &str {
        self.operation
    }

    pub fn phrase(&self) -> &str {
        self.phrase
    }
}

pub trait ChatTurnCueSink: Send + Sync {
    fn emit(&self, cue: ChatTurnProgressCue<'_>);
}

/// Observes the selected tool-call lifecycle without changing the stock turn
/// graph. Names are registered tool names only — never arguments or results.
/// Production uses [`NoopTurnObserver`]; these callbacks must not be serialized
/// as synthetic stock action/observation turns because stock records them as
/// conversation history. Method names retain `batch` for interface
/// compatibility.
pub trait ChatTurnObserver: Send + Sync {
    /// The selected tool call is about to execute. `first_tool` is its
    /// registered name.
    fn on_batch_start(&self, _first_tool: &str) {}
    /// The selected read finished (terminal/preflight outcomes end the run
    /// before this fires). `ok` reports that read's real outcome.
    fn on_batch_end(&self, _first_tool: &str, _ok: bool) {}
    /// A model step crossed the bounded slow-step threshold. Implementations
    /// must remain content-free and must not turn this timing signal into a
    /// synthetic stock turn. Default: observe nothing.
    ///
    /// Fired at most once per model step, and only after
    /// [`SLOW_STEP_CUE_AFTER`], so a fast turn behaves exactly as before.
    fn on_slow_step(&self) {}
}

/// Observer that observes nothing (the production default: the chat-turn
/// run does not stream interim turns).
pub struct NoopTurnObserver;
impl ChatTurnObserver for NoopTurnObserver {}

mod speech;
mod trace;
mod transcript;

#[cfg(test)]
pub(crate) use speech::canned_filler_hit as speech_canned_filler_hit;
#[cfg(test)]
pub use speech::internal_vocabulary_hit;
#[cfg(test)]
pub(crate) use speech::is_apology_loop as speech_is_apology_loop;
use speech::*;
pub use trace::ChatTurnTrace;
use trace::*;
use transcript::*;

/// Loop bounds. `max_iterations` is small for a wearable (the external
/// reference agent uses 90 for a coding agent; a voice turn needs a handful) — the last iteration is a
/// tool-free grace call that forces a spoken answer.
#[derive(Clone, Copy, Debug)]
pub struct ChatTurnLoopConfig {
    pub max_iterations: usize,
    /// Whole-run wall-clock budget, measured from the first model step.
    ///
    /// Without one the run is bounded only by iteration count, so the tool-free
    /// grace call — scheduled by index — is unreachable exactly when it matters:
    /// the outer breaker fires mid-iteration and every observation gathered so
    /// far is discarded in favour of a fixed timeout apology. With a budget the
    /// loop converts its LAST remaining slice into the grace answer, so the user
    /// hears something built from what was actually retrieved.
    pub time_budget: Option<std::time::Duration>,
    /// Time reserved for that final tool-free answer. Once the remaining budget
    /// falls to this, the current iteration becomes the grace call.
    pub grace_reserve: std::time::Duration,
    /// Whether this run may spend ONE extra model step retrying a failed first
    /// step. Ships off; see `crate::config::DEFAULT_FIRST_STEP_RETRY`.
    ///
    /// Off is the safe value in both directions. A retry is not free: it spends
    /// wall clock against a ~5-6s backend floor, so a retry that also fails
    /// makes a bad turn slower as well as wrong. The flag is here to be
    /// measured, and to be DELETED along with the retry if the measurement is
    /// flat — not to become one more knob nobody re-measures.
    pub first_step_retry: bool,
}

/// Enough for one more model step on the slowest supported provider path.
///
/// Public so the deadline hierarchy can be asserted numerically in one place
/// (`services::aibus::turn::orchestration`): this reserve is only meaningful
/// if a full-length model step plus this reserve still fit inside the loop's
/// time budget.
pub(crate) const DEFAULT_GRACE_RESERVE: std::time::Duration = std::time::Duration::from_secs(20);

/// A voice turn should never fan out into an unbounded provider burst.
///
/// Four covers the useful wearable cases (for example two facts plus weather
/// and playback state) while keeping pressure on phone-class network links and
/// upstream APIs predictable.
const MAX_PARALLEL_READS_PER_STEP: usize = 4;

/// How long a single model step may run before the observer is given a chance
/// to keep progress audible. Measured on-device model steps were 2.8s-14.8s;
/// this sits above the common case so a normal turn never fires it.
pub const SLOW_STEP_CUE_AFTER: std::time::Duration = std::time::Duration::from_secs(7);

impl ChatTurnLoopConfig {
    /// Loop bounds seeded from the process's effective configuration.
    ///
    /// `first_step_retry` is read from the runtime mirror rather than passed in:
    /// the mirror is the same coupling `spoken_progress_cues` uses, and it is
    /// off until a config that opts in has actually been applied. So a caller
    /// that knows nothing about the flag gets today's behaviour, and a test that
    /// wants either behaviour states it with `with_first_step_retry` instead of
    /// depending on process state.
    pub fn new(max_iterations: usize) -> Self {
        Self {
            max_iterations: if max_iterations == 0 {
                1
            } else {
                max_iterations
            },
            time_budget: None,
            grace_reserve: DEFAULT_GRACE_RESERVE,
            first_step_retry: crate::config::first_step_retry_enabled(),
        }
    }

    /// Bound the run in wall-clock time as well as iterations.
    pub const fn with_time_budget(mut self, budget: std::time::Duration) -> Self {
        self.time_budget = Some(budget);
        self
    }

    /// State the bounded first-step retry explicitly, ignoring the runtime
    /// mirror.
    ///
    /// Test-only on purpose: production has exactly one source for this value —
    /// the operator's applied configuration, read by `new` — so a second
    /// production entry point would be a second way for the flag to be on. Tests
    /// need the opposite: they must pin both behaviours without depending on
    /// process-wide state, and no test in this crate arms the mirror.
    #[cfg(test)]
    pub const fn with_first_step_retry(mut self, enabled: bool) -> Self {
        self.first_step_retry = enabled;
        self
    }
}

/// A run interrupted by a required device observation (`Preflight`), containing
/// the exact live transcript and the interrupted tool call so a validated
/// continuation can resume mid-plan instead of re-planning from scratch.
///
/// This is a same-process, in-memory carrier only — it is never serialized,
/// logged, or sent anywhere. Construction happens only inside the loop; the
/// integrating service treats it as opaque. The streaming Synapse session is
/// the only consumer (the legacy unary path keeps its proven fresh-replan
/// continuation and discards this).
pub struct ChatTurnSuspension {
    messages: Vec<Message>,
    pending_call: ToolStepCall,
    pending_trace_tool: AgenticTraceTool,
    next_iteration: usize,
    next_trace_ordinal: usize,
    nudge_used: bool,
}

/// Content-free by construction: transcript text and tool arguments never
/// cross a logging boundary. Only counts and the registered tool name (a
/// closed vocabulary) are printed.
impl std::fmt::Debug for ChatTurnSuspension {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChatTurnSuspension")
            .field("messages", &self.messages.len())
            .field("pending_tool", &self.pending_trace_tool)
            .field("next_iteration", &self.next_iteration)
            .field("next_trace_ordinal", &self.next_trace_ordinal)
            .field("nudge_used", &self.nudge_used)
            .finish()
    }
}

#[cfg(test)]
impl ChatTurnSuspension {
    /// Opaque fixture for integration-layer tests (store gating); loop-level
    /// tests obtain real suspensions from `run_suspendable`.
    pub(crate) fn test_fixture() -> Box<Self> {
        Box::new(Self {
            messages: Vec::new(),
            pending_call: ToolStepCall {
                call_id: "test-pending-call".to_string(),
                name: "current_location".to_string(),
                arguments: serde_json::json!({}),
            },
            pending_trace_tool: AgenticTraceTool::Known("current_location"),
            next_iteration: 1,
            next_trace_ordinal: 1,
            nudge_used: false,
        })
    }
}

/// One chat-turn run.
pub struct ChatTurnLoop<'a> {
    pub backend: &'a dyn LlmBackend,
    pub tools: &'a dyn ToolCatalog,
    pub cues: &'a dyn ChatTurnCueSink,
    pub observer: &'a dyn ChatTurnObserver,
    pub system_prompt: String,
    pub timeout: std::time::Duration,
    pub correlation: String,
    pub config: ChatTurnLoopConfig,
}

/// Ensures a retained provider thread is retired even when this future is
/// cancelled. Preflight deliberately disarms it because the exact same
/// in-memory turn resumes later; every terminal path leaves it armed.
struct ToolSessionGuard<'a> {
    backend: &'a dyn LlmBackend,
    correlation: &'a str,
    armed: bool,
}

impl<'a> ToolSessionGuard<'a> {
    fn new(backend: &'a dyn LlmBackend, correlation: &'a str) -> Self {
        Self {
            backend,
            correlation,
            armed: true,
        }
    }

    fn keep_for_resume(&mut self) {
        self.armed = false;
    }
}

impl Drop for ToolSessionGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.backend.finish_tool_session(self.correlation);
        }
    }
}

impl ChatTurnLoop<'_> {
    fn record_tool_trace(
        &self,
        next_trace_ordinal: &mut usize,
        tool: AgenticTraceTool,
        result: AgenticTraceResult,
    ) {
        emit_agentic_tool_trace(&self.correlation, *next_trace_ordinal, tool, result);
        *next_trace_ordinal = next_trace_ordinal.saturating_add(1);
    }

    fn finish_trace(
        &self,
        next_trace_ordinal: &mut usize,
        trace: &ChatTurnTrace,
        result: (ChatTurnOutcome, Option<Box<ChatTurnSuspension>>),
    ) -> (ChatTurnOutcome, Option<Box<ChatTurnSuspension>>) {
        if !matches!(&result.0, ChatTurnOutcome::Preflight { .. }) {
            emit_agentic_terminal_trace(&self.correlation, *next_trace_ordinal);
            *next_trace_ordinal = next_trace_ordinal.saturating_add(1);
        }
        // The single choke point every terminal path already passes through, so
        // the turn trace gets exactly one `Terminal` — including the declines,
        // which return from deep inside `drive`.
        trace.terminal(&result.0);
        result
    }

    /// Drive the run to a terminal outcome (legacy entry). Any preflight
    /// suspension is discarded, preserving the exact fresh-replan
    /// continuation contract of the unary path.
    // Untraced entry points. Production drives the `_traced` variants, so the
    // binary never calls these; the loop's own tests do, and they are the seam
    // any future untraced caller would use.
    #[allow(dead_code)]
    pub async fn run(&self, utterance: &str) -> ChatTurnOutcome {
        self.run_traced(utterance, &ChatTurnTrace::disabled()).await
    }

    /// [`run`](Self::run), recording the decision chain into `trace`.
    pub async fn run_traced(&self, utterance: &str, trace: &ChatTurnTrace) -> ChatTurnOutcome {
        let (outcome, suspension) = self.run_suspendable_traced(utterance, trace).await;
        if suspension.is_some() {
            // `run_suspendable` kept the provider thread alive for a resume
            // that this legacy entry point intentionally discards.
            self.backend.finish_tool_session(&self.correlation);
        }
        outcome
    }

    /// Drive the run to a terminal outcome. When the outcome is
    /// [`ChatTurnOutcome::Preflight`], the second slot carries the suspended
    /// transcript for an in-session resume; it is `None` for every other
    /// outcome.
    // Untraced entry points. Production drives the `_traced` variants, so the
    // binary never calls these; the loop's own tests do, and they are the seam
    // any future untraced caller would use.
    #[allow(dead_code)]
    pub async fn run_suspendable(
        &self,
        utterance: &str,
    ) -> (ChatTurnOutcome, Option<Box<ChatTurnSuspension>>) {
        self.run_suspendable_traced(utterance, &ChatTurnTrace::disabled())
            .await
    }

    /// [`run_suspendable`](Self::run_suspendable), recording the decision chain
    /// into `trace`.
    pub async fn run_suspendable_traced(
        &self,
        utterance: &str,
        trace: &ChatTurnTrace,
    ) -> (ChatTurnOutcome, Option<Box<ChatTurnSuspension>>) {
        let mut tool_session = ToolSessionGuard::new(self.backend, &self.correlation);
        let messages: Vec<Message> = vec![Message::User {
            content: OneOrMany::one(UserContent::text(utterance.to_string())),
        }];
        let mut next_trace_ordinal = 1;
        let result = self
            .drive(messages, 0, false, &mut next_trace_ordinal, trace)
            .await;
        if matches!(&result.0, ChatTurnOutcome::Preflight { .. }) {
            tool_session.keep_for_resume();
        }
        self.finish_trace(&mut next_trace_ordinal, trace, result)
    }

    /// Resume a suspended run after the device produced the requested
    /// observation. The interrupted call is re-executed against this loop's
    /// tools — which the caller rebuilt with the validated fresh observation —
    /// and its result re-enters the preserved transcript exactly like any
    /// other read; the loop then continues under the original iteration
    /// budget. If the re-executed call asks for a device observation again it
    /// becomes a `[TOOL_ERROR]` observation instead of a second suspension, so
    /// one observation can never ping-pong the same interrupted call.
    // Untraced entry points. Production drives the `_traced` variants, so the
    // binary never calls these; the loop's own tests do, and they are the seam
    // any future untraced caller would use.
    #[allow(dead_code)]
    pub async fn resume(
        &self,
        suspension: Box<ChatTurnSuspension>,
    ) -> (ChatTurnOutcome, Option<Box<ChatTurnSuspension>>) {
        self.resume_traced(suspension, &ChatTurnTrace::disabled())
            .await
    }

    /// [`resume`](Self::resume), recording the decision chain into `trace`.
    pub async fn resume_traced(
        &self,
        suspension: Box<ChatTurnSuspension>,
        trace: &ChatTurnTrace,
    ) -> (ChatTurnOutcome, Option<Box<ChatTurnSuspension>>) {
        let mut tool_session = ToolSessionGuard::new(self.backend, &self.correlation);
        let ChatTurnSuspension {
            mut messages,
            pending_call,
            pending_trace_tool,
            next_iteration,
            mut next_trace_ordinal,
            nudge_used,
        } = *suspension;
        // Deliberately no cue and no observer batch events here: the device
        // already executed the real action for this call, so the stock wire
        // saw real turns rather than a synthetic re-announcement.
        let resumed_ordinal = next_trace_ordinal;
        let resumed_started = std::time::Instant::now();
        match self.tools.execute(&pending_call).await {
            ToolExecutionOutcome::Terminal(action) => {
                tracing::info!(
                    correlation = %self.correlation,
                    tool = %pending_call.name,
                    "{}",
                    operational_markers::TERMINAL_NATIVE_ACTION
                );
                self.record_tool_trace(
                    &mut next_trace_ordinal,
                    pending_trace_tool,
                    AgenticTraceResult::from_observation(pending_trace_tool, true),
                );
                trace.tool_call(TracedToolCall {
                    ordinal: resumed_ordinal,
                    call: &pending_call,
                    latency: resumed_started.elapsed(),
                    ok: true,
                    status: tool_call_status::TERMINAL,
                    observation: None,
                });
                return self.finish_trace(
                    &mut next_trace_ordinal,
                    trace,
                    (ChatTurnOutcome::NativeAction(action), None),
                );
            }
            ToolExecutionOutcome::Preflight { .. } => {
                let observation =
                    bound_observation(false, "the required device observation was not available");
                trace.tool_call(TracedToolCall {
                    ordinal: resumed_ordinal,
                    call: &pending_call,
                    latency: resumed_started.elapsed(),
                    ok: false,
                    status: tool_call_status::PREFLIGHT_UNAVAILABLE,
                    observation: Some(&observation),
                });
                messages.push(tool_result_message(&pending_call, &observation));
                self.record_tool_trace(
                    &mut next_trace_ordinal,
                    pending_trace_tool,
                    AgenticTraceResult::from_observation(pending_trace_tool, false),
                );
            }
            ToolExecutionOutcome::Observation { ok, content } => {
                trace.tool_call(TracedToolCall {
                    ordinal: resumed_ordinal,
                    call: &pending_call,
                    latency: resumed_started.elapsed(),
                    ok,
                    status: if ok {
                        tool_call_status::OK
                    } else {
                        tool_call_status::ERROR
                    },
                    observation: Some(&content),
                });
                messages.push(tool_result_message(
                    &pending_call,
                    &bound_observation(ok, &content),
                ));
                self.record_tool_trace(
                    &mut next_trace_ordinal,
                    pending_trace_tool,
                    AgenticTraceResult::from_observation(pending_trace_tool, ok),
                );
            }
        }
        let result = self
            .drive(
                messages,
                next_iteration,
                nudge_used,
                &mut next_trace_ordinal,
                trace,
            )
            .await;
        if matches!(&result.0, ChatTurnOutcome::Preflight { .. }) {
            tool_session.keep_for_resume();
        }
        self.finish_trace(&mut next_trace_ordinal, trace, result)
    }

    /// The shared iteration engine behind `run`/`run_suspendable`/`resume`.
    /// Identical control flow to the historical `run` body; the only addition
    /// is that a `Preflight` captures the transcript instead of dropping it.
    async fn drive(
        &self,
        mut messages: Vec<Message>,
        start_iteration: usize,
        mut nudge_used: bool,
        next_trace_ordinal: &mut usize,
        trace: &ChatTurnTrace,
    ) -> (ChatTurnOutcome, Option<Box<ChatTurnSuspension>>) {
        // `budget` is the iteration ceiling. It is extended by exactly one when
        // the verification gate fires a nudge, so the nudge's demand ("call
        // play_music now") lands on a tool-capable iteration instead of the
        // tool-free grace call ("do not call any more tools") that would
        // otherwise immediately contradict it. The extension is bounded because
        // `nudge_used` lets the gate fire at most once.
        let mut budget = self.config.max_iterations;
        let mut iteration = start_iteration;
        // Within one turn, the same read with the same arguments has the same
        // answer. Measured on device: playing one song issued ~4.3 catalog
        // lookups, many of them byte-identical repeats, each a fresh network
        // round-trip on a wearable's wifi. Replaying the stored observation
        // removes the wire time without changing what the model sees.
        //
        // Only `Observation` outcomes are stored. `Terminal` dispatches a native
        // action and `Preflight` suspends the run; replaying either would mean
        // acting twice on one decision, so neither is ever memoised. Mutations
        // are terminal by construction and so cannot land here.
        let mut observation_memo: HashMap<(String, String), (bool, String)> = HashMap::new();
        // At most one first-step retry per run, ever. This is a latch, not a
        // counter: once spent it is never cleared, so no combination of budget
        // extension, nudge, or resume can turn the retry into a loop.
        let mut first_step_retry_used = false;
        let started = std::time::Instant::now();
        while iteration < budget {
            // Wall clock, not just iteration count. When the remaining budget no
            // longer covers a final answer, convert THIS iteration into the
            // grace call by making it the last one. Otherwise the outer breaker
            // fires mid-iteration and discards every observation gathered.
            if let Some(time_budget) = self.config.time_budget {
                let remaining = time_budget.saturating_sub(started.elapsed());
                if remaining <= self.config.grace_reserve && iteration + 1 < budget {
                    tracing::info!(
                        correlation = %self.correlation,
                        iteration,
                        remaining_ms = remaining.as_millis(),
                        "{}",
                        operational_markers::TIME_BUDGET_GRACE
                    );
                    trace.gate(
                        "time_budget",
                        false,
                        "grace_reserve_reached",
                        &[
                            ("iteration", iteration as i64),
                            ("remaining_ms", remaining.as_millis() as i64),
                        ],
                    );
                    budget = iteration + 1;
                }
            }
            let is_grace = iteration + 1 == budget;
            // On the grace iteration withhold tools so the model must answer.
            let tools = if is_grace {
                Vec::new()
            } else {
                self.tools.catalog()
            };
            let advertised_tool_names = tools.iter().map(|tool| tool.name).collect::<Vec<_>>();
            if is_grace {
                messages.push(Message::User {
                    content: OneOrMany::one(UserContent::text(
                        "Provide your best final spoken answer now using the information already \
                         gathered. Do not call any more tools. If a required lookup did not \
                         succeed, say in one short sentence what you could not get and one \
                         thing the user can try saying next. Use ordinary words the wearer \
                         would understand — never mention runs, tools, calls, or searches."
                            .to_string(),
                    )),
                });
            }

            // Expose one content-free timing signal when a provider step is
            // unusually slow. Production observes it with NoopTurnObserver;
            // it must never be converted into a synthetic stock turn. Keeping
            // the timer in the loop preserves a future run-owned spoken-only
            // side-channel seam without delaying or perturbing a fast step.
            // Clamp the per-step bound to what this run can still afford. The
            // provider timeout is a fixed circuit breaker sized for the slowest
            // supported path, so on its own it can exceed the budget that is
            // actually left and overrun the whole-run breaker — which then
            // discards every observation gathered, the exact failure
            // `time_budget` exists to prevent. The grace step is bounded by the
            // same provider timeout as any other step, so without this the
            // reserve is only nominally reserved. With the clamp, NO value of
            // the provider's per-step timeout can bust the loop budget, so the
            // hierarchy stays sound even if a nested deadline is later raised
            // in isolation.
            let step_timeout = match self.config.time_budget {
                Some(time_budget) => self
                    .timeout
                    .min(time_budget.saturating_sub(started.elapsed())),
                None => self.timeout,
            };
            let step_future = self.backend.tool_step(ToolStepRequest {
                system_prompt: self.system_prompt.clone(),
                messages: messages.clone(),
                tools,
                timeout: step_timeout,
                correlation: self.correlation.clone(),
            });
            tokio::pin!(step_future);
            // A monotonic clock read, not an allocation: the same two lines run
            // whether or not this run is traced.
            let step_started = std::time::Instant::now();
            let step = tokio::select! {
                biased;
                step = &mut step_future => step,
                () = tokio::time::sleep(SLOW_STEP_CUE_AFTER) => {
                    tracing::info!(
                        correlation = %self.correlation,
                        iteration,
                        "{}",
                        operational_markers::SLOW_MODEL_STEP
                    );
                    self.observer.on_slow_step();
                    // Fires once per step: from here just await the step.
                    step_future.await
                }
            };

            let step = match step {
                Ok(step) => step,
                Err(error) => {
                    let step_latency = step_started.elapsed();
                    let retryable = chat_turn_backend_error_is_retryable(&error);
                    tracing::warn!(
                        correlation = %self.correlation,
                        iteration,
                        category = chat_turn_backend_error_category(&error),
                        "{}",
                        operational_markers::STEP_BACKEND_ERROR
                    );
                    trace.backend_error_note(chat_turn_backend_error_category(&error), iteration);
                    let error_shape = [
                        ("iteration", iteration as i64),
                        ("latency_ms", step_latency.as_millis() as i64),
                        ("retryable", i64::from(retryable)),
                    ];
                    // A single transient provider hiccup must not throw away
                    // work already done. If reads succeeded this run, spend the
                    // remaining budget on one tool-free grace answer built from
                    // those observations instead of declining outright — the
                    // decline reads as flaky precisely because a retry of the
                    // same utterance then succeeds. Only give up when the grace
                    // call itself fails, or when there is nothing to answer from.
                    // A permanent fault (bad key, missing model, content
                    // refusal) fails identically on every retry, so spending
                    // the rest of the deadline on a grace call only delays a
                    // failure we could already describe. Retryable faults keep
                    // the grace path, which is what stops a single transient
                    // hiccup from discarding completed work.
                    if retryable && !is_grace && messages.iter().any(is_tool_result_message) {
                        tracing::info!(
                            correlation = %self.correlation,
                            "<<< answering from gathered observations after a step error"
                        );
                        trace.gate(
                            "backend_step",
                            true,
                            "retryable_grace_from_observations",
                            &error_shape,
                        );
                        budget = iteration + 1;
                        continue;
                    }
                    // The grace path above needs a tool result to answer from,
                    // so it cannot cover the FIRST step — and measurement says
                    // the first step is the only one that actually fails.
                    // Observed on an operator-owned Pin: 23 declines in 102
                    // turns, every one logged at `iteration=0`, never later. The one
                    // path with no retry was the only path that failed, and the
                    // failure arrived faster than a correct answer would have,
                    // so the wearer heard a confident "something went wrong"
                    // seconds after speaking and got it right by simply asking
                    // again. This does the asking again, once.
                    //
                    // DEFAULT OFF, and it must stay that way until measured. A
                    // retry buys a second chance by spending wall clock against
                    // a ~5-6s backend floor, so when the retry also fails the
                    // turn is slower AND still wrong. This repository has a
                    // history of knobs that survived because nobody re-measured
                    // them; the agreement for this one is explicit — ship it
                    // off, measure it, and DELETE the flag and this branch if
                    // the measurement is flat.
                    //
                    // Bounded four ways: the flag, a one-shot latch, only the
                    // run's first step, and only a retryable fault. A permanent
                    // fault (bad key, missing model, refusal) is classified by
                    // the same `chat_turn_backend_error_is_retryable` split the
                    // grace path uses and still declines immediately — spending
                    // the deadline re-asking for a key that will not appear only
                    // delays a failure we can already describe.
                    if self.config.first_step_retry
                        && !first_step_retry_used
                        && iteration == start_iteration
                        && !is_grace
                        && retryable
                    {
                        first_step_retry_used = true;
                        tracing::info!(
                            correlation = %self.correlation,
                            iteration,
                            category = chat_turn_backend_error_category(&error),
                            "{}",
                            operational_markers::FIRST_STEP_RETRY
                        );
                        trace.gate(
                            "backend_step",
                            true,
                            "retryable_first_step_retry",
                            &error_shape,
                        );
                        // Deliberately re-enters at the SAME iteration index:
                        // the retry is another attempt at the first step, not
                        // an extra step, so it consumes no iteration budget and
                        // cannot push the tool-free grace call out of reach.
                        // Nothing was appended to the transcript on a failed
                        // step, so the reissued request is byte-identical. Wall
                        // clock is still authoritative: the time-budget check at
                        // the top of the loop can convert the retried iteration
                        // into the grace call, and the per-step timeout is
                        // re-clamped to what the run can still afford.
                        continue;
                    }
                    trace.gate(
                        "backend_step",
                        false,
                        if retryable {
                            "retryable_without_recovery"
                        } else {
                            "permanent_backend_error"
                        },
                        &error_shape,
                    );
                    return (
                        self.decline_with(
                            trace,
                            ChatTurnDeclineReason::BackendUnavailable,
                            Some(&error),
                        ),
                        None,
                    );
                }
            };

            if trace.is_enabled() {
                trace.model_step(TracedModelStep {
                    iteration,
                    latency: step_started.elapsed(),
                    // Walking the transcript is O(turn); it only happens when a
                    // record is actually being written.
                    prompt_chars: transcript_chars(&self.system_prompt, &messages),
                    step: &step,
                });
            }

            match step {
                ToolStepResult::Final(answer) => {
                    let answer = answer.trim().to_string();
                    // Never narrate tool-call markup. Providers that emit
                    // prompted `<tool_call>` blocks strip them when parsing, but
                    // a malformed or truncated block could otherwise arrive here
                    // as "text" and be spoken aloud as raw JSON — and then be
                    // saved into conversation history. Decline instead; the
                    // decline is spoken, so the turn still answers.
                    if answer.is_empty() || answer.contains("<tool_call>") {
                        // Two very different faults share one decline reason, so
                        // the trace keeps them apart: an empty completion is a
                        // provider/config problem, leaked markup is a parsing one.
                        trace.gate(
                            "final_answer_shape",
                            false,
                            if answer.is_empty() {
                                "empty_model_answer"
                            } else {
                                "tool_call_markup_in_answer"
                            },
                            &[
                                ("iteration", iteration as i64),
                                ("answer_chars", answer.chars().count() as i64),
                            ],
                        );
                        return (self.decline(trace, ChatTurnDeclineReason::EmptyModel), None);
                    }
                    // The model answered with prose on a turn that asked for an
                    // action. Dispatch the deterministic completion instead.
                    //
                    // This runs BEFORE the nudge, not after. `forced_terminal_action`
                    // returns `Some` only when it already holds a candidate that
                    // passed every gate the tool path applies — intent, catalog
                    // grounding, argument validation, authorization — so the nudge
                    // cannot improve on it. It can only arrive at the same action
                    // one model round-trip later, and a round-trip measured 2.8-14.8s
                    // on device. When no candidate passes, this still returns `None`
                    // and the nudge below runs exactly as before, so the model keeps
                    // its retry in precisely the cases where the retry can help.
                    //
                    // Scoped by construction: it returns `None` unless the utterance
                    // is an authoritative command, so answer-only turns (knowledge,
                    // search) never reach it and keep the verification nudge.
                    if let Some(action) = self.tools.forced_terminal_action(&answer) {
                        tracing::info!(
                            correlation = %self.correlation,
                            iteration,
                            action = %action.action,
                            nudge_used,
                            is_grace,
                            "{}",
                            operational_markers::FORCING_DETERMINISTIC_TERMINAL_ACTION
                        );
                        // An override of the model's own choice: it answered in
                        // prose and code dispatched an action anyway.
                        trace.gate(
                            "deterministic_completion",
                            true,
                            "forced_terminal_action",
                            &[
                                ("iteration", iteration as i64),
                                ("answer_chars", answer.chars().count() as i64),
                                ("nudge_used", i64::from(nudge_used)),
                            ],
                        );
                        return (ChatTurnOutcome::NativeAction(action), None);
                    }
                    if !nudge_used && !is_grace {
                        if let Some(nudge) = self.tools.final_answer_nudge(&answer) {
                            nudge_used = true;
                            // Give the nudged follow-up its own tool-capable
                            // iteration before the grace call.
                            budget += 1;
                            tracing::info!(
                                correlation = %self.correlation,
                                iteration,
                                "{}",
                                operational_markers::VERIFICATION_GATE_REJECTED
                            );
                            trace.gate(
                                "final_answer_verification",
                                false,
                                "final_answer_nudged",
                                &[
                                    ("iteration", iteration as i64),
                                    ("answer_chars", answer.chars().count() as i64),
                                ],
                            );
                            messages.push(Message::Assistant {
                                id: None,
                                content: OneOrMany::one(AssistantContent::text(answer)),
                            });
                            messages.push(Message::User {
                                content: OneOrMany::one(UserContent::text(nudge)),
                            });
                            iteration += 1;
                            continue;
                        }
                    }
                    tracing::info!(
                        correlation = %self.correlation,
                        iteration,
                        "{}",
                        operational_markers::FINAL_ANSWER
                    );
                    // Recorded on the accept as well as the refusal: "the gate
                    // ran and passed" and "the gate never ran" are different
                    // diagnoses, and only one of them is the model's fault.
                    trace.gate(
                        "final_answer_verification",
                        true,
                        "final_answer_accepted",
                        &[
                            ("iteration", iteration as i64),
                            ("answer_chars", answer.chars().count() as i64),
                            ("nudge_used", i64::from(nudge_used)),
                            ("grace", i64::from(is_grace)),
                        ],
                    );
                    // Sanitise only here: after the verification/nudge gates,
                    // which inspect the model's literal text, and immediately
                    // before it becomes speech.
                    return (ChatTurnOutcome::Answer(speakable_answer(&answer)), None);
                }
                ToolStepResult::ToolCalls(calls) if !calls.is_empty() => {
                    // Batch only a leading group whose catalog contract says
                    // every call is a side-effect-free read that cannot
                    // preflight. The first write, mutation, preflight-capable
                    // read, unknown call, or concurrency cap ends the group.
                    // Fewer than two stays on the proven serial path below.
                    let parallel_prefix = calls
                        .iter()
                        .take(MAX_PARALLEL_READS_PER_STEP)
                        .take_while(|call| self.tools.parallel_read_safe(&call.name))
                        .count();
                    let selected_count = if parallel_prefix >= 2 {
                        parallel_prefix
                    } else {
                        1
                    };
                    if calls.len() > selected_count {
                        // The model asked for more than this step will run. The
                        // rest are not refused outright — it may re-request them
                        // next iteration — but they did not execute, and that is
                        // exactly the fact a "why didn't it check X" complaint
                        // needs.
                        trace.gate(
                            "tool_batch",
                            false,
                            "extra_tool_calls_deferred",
                            &[
                                ("iteration", iteration as i64),
                                ("requested", calls.len() as i64),
                                ("selected", selected_count as i64),
                            ],
                        );
                    }
                    let selected_calls = &calls[..selected_count];
                    let call = &selected_calls[0];
                    let trace_tool =
                        AgenticTraceTool::from_selected(&advertised_tool_names, &call.name);
                    let selected_names = selected_calls
                        .iter()
                        .map(|call| call.name.as_str())
                        .collect::<Vec<_>>();
                    if let Some(cue) = self.tools.cue_for(&selected_names) {
                        self.cues.emit(ChatTurnProgressCue {
                            run_id: &self.correlation,
                            operation: &call.name,
                            phrase: &cue,
                        });
                    }

                    messages.push(assistant_tool_calls_message(selected_calls));

                    let first_tool = call.name.clone();
                    self.observer.on_batch_start(&first_tool);

                    if selected_count > 1 {
                        // Replay observations from an earlier iteration, but
                        // execute same-step siblings independently. A tool may
                        // bind same-run authority to its call ID (music does),
                        // so aliasing two fresh call IDs onto one execution
                        // would make the second result look citable while the
                        // authority store had never registered it.
                        let memo_keys = selected_calls
                            .iter()
                            .map(|call| (call.name.clone(), canonical_arguments(&call.arguments)))
                            .collect::<Vec<_>>();
                        let memoized_before_batch = memo_keys
                            .iter()
                            .map(|memo_key| observation_memo.get(memo_key).cloned())
                            .collect::<Vec<_>>();
                        let pending = selected_calls
                            .iter()
                            .enumerate()
                            .zip(memoized_before_batch.iter())
                            .filter_map(|((index, call), memoized)| {
                                if memoized.is_some() {
                                    None
                                } else {
                                    Some((index, call.clone()))
                                }
                            })
                            .collect::<Vec<_>>();
                        let tools = self.tools;
                        let executed = stream::iter(pending)
                            .map(move |(index, call)| async move {
                                let started = std::time::Instant::now();
                                let outcome = tools.execute(&call).await;
                                (index, (outcome, started.elapsed()))
                            })
                            .buffered(MAX_PARALLEL_READS_PER_STEP)
                            .collect::<Vec<_>>()
                            .await
                            .into_iter()
                            .collect::<HashMap<_, _>>();

                        let mut results = Vec::with_capacity(selected_count);
                        let mut all_ok = true;
                        for (index, (call, memo_key)) in
                            selected_calls.iter().zip(memo_keys).enumerate()
                        {
                            let replayed = memoized_before_batch[index].is_some();
                            let (ok, content, memoizable, status, latency) =
                                if let Some((ok, content)) = &memoized_before_batch[index] {
                                    (
                                        *ok,
                                        content.clone(),
                                        false,
                                        tool_call_status::REPLAYED,
                                        std::time::Duration::ZERO,
                                    )
                                } else {
                                    match executed.get(&index).cloned() {
                                        Some((
                                            ToolExecutionOutcome::Observation { ok, content },
                                            latency,
                                        )) => (
                                            ok,
                                            content,
                                            true,
                                            if ok {
                                                tool_call_status::OK
                                            } else {
                                                tool_call_status::ERROR
                                            },
                                            latency,
                                        ),
                                        Some((ToolExecutionOutcome::Terminal(_), latency)) => {
                                            // A catalog bug must never turn a
                                            // read batch into an unreviewed
                                            // mutation. Validation may have
                                            // happened, but dispatch does not.
                                            tracing::error!(
                                                correlation = %self.correlation,
                                                tool = %call.name,
                                                "parallel-safe tool returned a terminal action"
                                            );
                                            (
                                                false,
                                                "that read could not be completed safely"
                                                    .to_string(),
                                                false,
                                                tool_call_status::UNSAFE_TERMINAL,
                                                latency,
                                            )
                                        }
                                        Some((ToolExecutionOutcome::Preflight { .. }, latency)) => {
                                            // Preflights contain one resumable
                                            // stock action and therefore run
                                            // only on the serial path.
                                            tracing::error!(
                                                correlation = %self.correlation,
                                                tool = %call.name,
                                                "parallel-safe tool requested a device preflight"
                                            );
                                            (
                                                false,
                                                "that read needs to be requested separately"
                                                    .to_string(),
                                                false,
                                                tool_call_status::UNSAFE_PREFLIGHT,
                                                latency,
                                            )
                                        }
                                        // Unchanged: a missing entry is still an
                                        // ordinary failed observation, and is still
                                        // memoised so the model cannot spend the
                                        // budget re-asking for it.
                                        None => (
                                            false,
                                            "the read did not produce a result".to_string(),
                                            true,
                                            tool_call_status::MISSING_RESULT,
                                            std::time::Duration::ZERO,
                                        ),
                                    }
                                };
                            if replayed {
                                tracing::info!(
                                    correlation = %self.correlation,
                                    tool = %call.name,
                                    ok,
                                    "{}",
                                    operational_markers::OBSERVATION_REPLAYED
                                );
                            }
                            if memoizable {
                                observation_memo.insert(memo_key, (ok, content.clone()));
                            }
                            let trace_tool =
                                AgenticTraceTool::from_selected(&advertised_tool_names, &call.name);
                            trace.tool_call(TracedToolCall {
                                ordinal: *next_trace_ordinal,
                                call,
                                latency,
                                ok,
                                status,
                                observation: Some(content.as_str()),
                            });
                            self.record_tool_trace(
                                next_trace_ordinal,
                                trace_tool,
                                AgenticTraceResult::from_observation(trace_tool, ok),
                            );
                            all_ok &= ok;
                            results.push((call.clone(), bound_observation(ok, content.as_str())));
                        }
                        messages.push(tool_results_message(&results));
                        self.observer.on_batch_end(&first_tool, all_ok);
                        iteration += 1;
                        continue;
                    }

                    // Serialized arguments, not the raw value: `serde_json::Value`
                    // is not `Hash`, and its object maps preserve insertion order,
                    // so two models emitting the same pair in a different order
                    // must not be treated as different calls.
                    let memo_key = (call.name.clone(), canonical_arguments(&call.arguments));
                    if let Some((ok, content)) = observation_memo.get(&memo_key) {
                        tracing::info!(
                            correlation = %self.correlation,
                            tool = %call.name,
                            ok,
                            "{}",
                            operational_markers::OBSERVATION_REPLAYED
                        );
                        messages.push(tool_result_message(call, &bound_observation(*ok, content)));
                        self.observer.on_batch_end(&first_tool, *ok);
                        trace.tool_call(TracedToolCall {
                            ordinal: *next_trace_ordinal,
                            call,
                            latency: std::time::Duration::ZERO,
                            ok: *ok,
                            status: tool_call_status::REPLAYED,
                            observation: Some(content.as_str()),
                        });
                        self.record_tool_trace(
                            next_trace_ordinal,
                            trace_tool,
                            AgenticTraceResult::from_observation(trace_tool, *ok),
                        );
                        iteration += 1;
                        continue;
                    }
                    let call_started = std::time::Instant::now();
                    match self.tools.execute(call).await {
                        ToolExecutionOutcome::Terminal(action) => {
                            tracing::info!(
                                correlation = %self.correlation,
                                tool = %call.name,
                                "{}",
                                operational_markers::TERMINAL_NATIVE_ACTION
                            );
                            trace.tool_call(TracedToolCall {
                                ordinal: *next_trace_ordinal,
                                call,
                                latency: call_started.elapsed(),
                                ok: true,
                                status: tool_call_status::TERMINAL,
                                observation: None,
                            });
                            self.record_tool_trace(
                                next_trace_ordinal,
                                trace_tool,
                                AgenticTraceResult::from_observation(trace_tool, true),
                            );
                            return (ChatTurnOutcome::NativeAction(action), None);
                        }
                        ToolExecutionOutcome::Preflight { action, arguments } => {
                            // Recorded at the ordinal the resume will re-use, and
                            // without consuming it: this call has not produced an
                            // observation yet, it has asked the device for one.
                            trace.tool_call(TracedToolCall {
                                ordinal: *next_trace_ordinal,
                                call,
                                latency: call_started.elapsed(),
                                ok: false,
                                status: tool_call_status::PREFLIGHT,
                                observation: None,
                            });
                            let suspension = ChatTurnSuspension {
                                messages,
                                pending_call: call.clone(),
                                pending_trace_tool: trace_tool,
                                next_iteration: iteration + 1,
                                next_trace_ordinal: *next_trace_ordinal,
                                nudge_used,
                            };
                            return (
                                ChatTurnOutcome::Preflight { action, arguments },
                                Some(Box::new(suspension)),
                            );
                        }
                        ToolExecutionOutcome::Observation { ok, content } => {
                            messages
                                .push(tool_result_message(call, &bound_observation(ok, &content)));
                            self.observer.on_batch_end(&first_tool, ok);
                            trace.tool_call(TracedToolCall {
                                ordinal: *next_trace_ordinal,
                                call,
                                latency: call_started.elapsed(),
                                ok,
                                status: if ok {
                                    tool_call_status::OK
                                } else {
                                    tool_call_status::ERROR
                                },
                                observation: Some(content.as_str()),
                            });
                            self.record_tool_trace(
                                next_trace_ordinal,
                                trace_tool,
                                AgenticTraceResult::from_observation(trace_tool, ok),
                            );
                            observation_memo.insert(memo_key, (ok, content));
                            // The artist-scoped search just answered. For an
                            // authoritative play command that is the whole job:
                            // the user named an artist, the provider confirmed
                            // it, and the deterministic completion holds a
                            // rank-one track that passed grounding, the artist
                            // check, argument validation and authorization.
                            //
                            // Measured on `.144`: the model still issued ~3
                            // searches before emitting any final, and the
                            // completion waited for that final. That wait is the
                            // bulk of a ~60s music turn.
                            //
                            // Deliberately narrow. Only `music_artist_top_tracks`
                            // triggers this, because `.141` established that
                            // artist-scoped results are the PREFERRED source; a
                            // generic `music_catalog_search` hit can be grounded
                            // yet worse, and dispatching on it would trade
                            // latency for the wrong song. Nothing is dispatched
                            // that the completion would not have dispatched
                            // anyway — `PlayMusic` is terminal, so this ends the
                            // turn exactly where the model's own `play_music`
                            // call would have.
                            if ok && first_tool == "music_artist_top_tracks" {
                                if let Some(action) = self.tools.forced_terminal_action("") {
                                    tracing::info!(
                                        correlation = %self.correlation,
                                        iteration,
                                        action = %action.action,
                                        "{}",
                                        operational_markers::ARTIST_SCOPED_COMPLETION
                                    );
                                    trace.gate(
                                        "deterministic_completion",
                                        true,
                                        "artist_scoped_completion",
                                        &[("iteration", iteration as i64)],
                                    );
                                    return (ChatTurnOutcome::NativeAction(action), None);
                                }
                            }
                        }
                    }
                }
                // Empty tool-call batch: treat as no progress this iteration.
                ToolStepResult::ToolCalls(_) => {
                    return (self.decline(trace, ChatTurnDeclineReason::NoProgress), None);
                }
            }
            iteration += 1;
        }

        trace.gate(
            "iteration_budget",
            false,
            "iteration_budget_exhausted",
            &[
                ("iterations", budget as i64),
                ("start_iteration", start_iteration as i64),
            ],
        );
        (self.decline(trace, ChatTurnDeclineReason::Budget), None)
    }

    fn decline(&self, trace: &ChatTurnTrace, reason: ChatTurnDeclineReason) -> ChatTurnOutcome {
        self.decline_with(trace, reason, None)
    }

    /// Decline, saying *why* where we honestly know why.
    ///
    /// Every decline used to narrate one sentence regardless of cause, so a
    /// dead API key, a dropped connection, a rate limit and a model that simply
    /// gave up were indistinguishable. On a wearable on flaky wifi that is the
    /// failure a user hits first and most often, and an unactionable "I
    /// couldn't complete that request" is what makes the device feel broken
    /// rather than merely busy. The cause is already diagnosed — the provider
    /// error arrives here having been through `friendly_error_message` — so
    /// this only stops throwing it away.
    fn decline_with(
        &self,
        trace: &ChatTurnTrace,
        reason: ChatTurnDeclineReason,
        backend_error: Option<&str>,
    ) -> ChatTurnOutcome {
        tracing::info!(
            correlation = %self.correlation,
            reason = reason.label(),
            "{}",
            operational_markers::DECLINE
        );
        // The reason is a closed set of snake_case labels, so it is stable
        // enough for tooling to key off; the spoken text lands on the
        // `Terminal` event that `finish_trace` writes for this outcome.
        trace.gate("decline", false, reason.label(), &[]);
        ChatTurnOutcome::Decline(decline_speech(reason, backend_error))
    }
}

#[cfg(test)]
#[path = "chat_turn_loop/tests.rs"]
mod tests;
