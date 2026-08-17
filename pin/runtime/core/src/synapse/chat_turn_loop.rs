//! Native tool-calling chat-turn loop.
//! Stock: ironman/sources/humaneinternal/system/intent/SynapseChatTurnUtils.java
//!
//! This is the orchestration core described in the external-agent architecture
//! comparison. It follows the reference agent's control flow: one model
//! step per iteration carrying the full transcript and a native tool catalog;
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

/// Diagnostic trace seam for one run.
///
/// The loop refuses, overrides, retries and gives up in a dozen places, and
/// each of those left only an ephemeral logcat marker. Diagnosing "it refused
/// to play that song" therefore needed a live device reproduction, because by
/// the time anyone looked the markers had rolled. This carries a [`TurnTracer`]
/// down the same call path so the ordered decision chain survives as one
/// durable record.
///
/// It arrives as a run parameter rather than a [`ChatTurnLoop`] field because
/// the integrating service builds that struct with a literal it owns; a new
/// required field would be an unrelated edit there. `run`, `run_suspendable`
/// and `resume` keep their exact signatures and pass a disabled trace, so an
/// untraced caller runs the previous code path with one `Option` check per
/// recording site and no allocation.
///
/// `provider` and `model` are supplied by the caller rather than read off the
/// backend on purpose: [`LlmBackend`] is an object-safe facade that
/// deliberately hides which client is behind it, so whoever selected it is the
/// only honest source for its identity.
#[derive(Clone, Debug)]
pub struct ChatTurnTrace {
    tracer: TurnTracer,
    provider: String,
    model: String,
}

/// One model call, as the trace sees it.
struct TracedModelStep<'a> {
    iteration: usize,
    latency: std::time::Duration,
    prompt_chars: usize,
    step: &'a ToolStepResult,
}

/// One tool execution, as the trace sees it. `status` is a bounded label from
/// the closed set below, never provider or tool prose.
struct TracedToolCall<'a> {
    ordinal: usize,
    call: &'a ToolStepCall,
    latency: std::time::Duration,
    ok: bool,
    status: &'static str,
    /// The observation the model was given, when there was one. Recorded only
    /// when content capture is on.
    observation: Option<&'a str>,
}

/// The closed vocabulary of [`TracedToolCall::status`]. Grouped here so a new
/// outcome has to be named rather than described.
mod tool_call_status {
    /// A read that succeeded.
    pub const OK: &str = "ok";
    /// A read that failed or was unavailable; the model sees `[TOOL_ERROR]`.
    pub const ERROR: &str = "error";
    /// An identical earlier call in this same turn, replayed from the memo.
    pub const REPLAYED: &str = "replayed";
    /// A validated native mutation: the loop stops and the caller dispatches.
    pub const TERMINAL: &str = "terminal";
    /// The call needs a device observation first; the run suspends here.
    pub const PREFLIGHT: &str = "preflight";
    /// A resumed call asked for a device observation a second time, so it was
    /// downgraded to a failed observation rather than suspending again.
    pub const PREFLIGHT_UNAVAILABLE: &str = "preflight_unavailable";
    /// A tool the catalog declared parallel-safe returned a terminal action.
    pub const UNSAFE_TERMINAL: &str = "unsafe_terminal";
    /// A tool the catalog declared parallel-safe requested a device preflight.
    pub const UNSAFE_PREFLIGHT: &str = "unsafe_preflight";
    /// A batched read produced no entry at all.
    pub const MISSING_RESULT: &str = "missing_result";
}

impl ChatTurnTrace {
    /// Records nothing. Behaviourally identical to the untraced loop.
    pub fn disabled() -> Self {
        Self {
            tracer: TurnTracer::disabled(),
            provider: String::new(),
            model: String::new(),
        }
    }

    /// Record this run into `tracer`, attributing every model step to the
    /// provider/model the caller selected.
    ///
    /// The production wiring lives in the integrating service (which owns the
    /// policy that decides whether a turn is traced at all); this is the seam
    /// it calls through, and the seam the loop's own tests drive.
    #[allow(dead_code)]
    pub fn new(tracer: TurnTracer, provider: &str, model: &str) -> Self {
        Self {
            tracer,
            provider: provider.to_string(),
            model: model.to_string(),
        }
    }

    fn is_enabled(&self) -> bool {
        self.tracer.is_enabled()
    }

    fn gate(&self, gate: &str, allowed: bool, reason: &str, shape: &[(&str, i64)]) {
        self.tracer.gate(gate, allowed, reason, shape);
    }

    fn model_step(&self, step: TracedModelStep<'_>) {
        if !self.is_enabled() {
            return;
        }
        let (tool_calls, completion_chars, text) = match step.step {
            ToolStepResult::Final(answer) => (
                Vec::new(),
                answer.chars().count(),
                self.tracer.content(answer),
            ),
            ToolStepResult::ToolCalls(calls) => (
                calls.iter().map(|call| call.name.clone()).collect(),
                0,
                None,
            ),
        };
        self.tracer.record(TraceEvent::ModelStep {
            iteration: step.iteration as u32,
            provider: self.provider.clone(),
            model: self.model.clone(),
            latency_ms: step.latency.as_millis() as u64,
            prompt_chars: step.prompt_chars,
            completion_chars,
            tool_calls,
            text,
        });
    }

    fn tool_call(&self, executed: TracedToolCall<'_>) {
        if !self.is_enabled() {
            return;
        }
        // Canonicalising arguments allocates, so only do it when the record is
        // actually allowed to hold them.
        let arguments = self
            .tracer
            .records_content()
            .then(|| canonical_arguments(&executed.call.arguments))
            .and_then(|arguments| self.tracer.content(&arguments));
        self.tracer.record(TraceEvent::ToolCall {
            ordinal: executed.ordinal as u32,
            tool: executed.call.name.clone(),
            latency_ms: executed.latency.as_millis() as u64,
            ok: executed.ok,
            status: executed.status.to_string(),
            arguments,
            result: executed
                .observation
                .and_then(|observation| self.tracer.content(observation)),
        });
    }

    /// The closed-set category of a backend error. Kept as a note rather than a
    /// gate shape because it is a label, not a count, and the gate below already
    /// records the decision that category drove.
    fn backend_error_note(&self, category: &str, iteration: usize) {
        if !self.is_enabled() {
            return;
        }
        self.tracer.record(TraceEvent::Note {
            marker: format!("backend_error_{category}"),
            shape: vec![("iteration".to_string(), iteration as i64)],
        });
    }

    /// How the turn ended. A `Preflight` is deliberately not terminal: the run
    /// suspends and the resumed half records the real ending, so tracing one
    /// here would produce two terminals for one turn.
    fn terminal(&self, outcome: &ChatTurnOutcome) {
        if !self.is_enabled() {
            return;
        }
        // `outcome` is the native action's own name when the turn ends in a
        // mutation, per the trace contract; `action` repeats it so a consumer
        // can key off either without parsing the outcome vocabulary.
        let (label, action, spoken) = match outcome {
            ChatTurnOutcome::Answer(text) => ("respond".to_string(), None, Some(text.as_str())),
            ChatTurnOutcome::NativeAction(action) => {
                (action.action.clone(), Some(action.action.clone()), None)
            }
            ChatTurnOutcome::Decline(text) => ("decline".to_string(), None, Some(text.as_str())),
            ChatTurnOutcome::Preflight { .. } => return,
        };
        self.tracer.record(TraceEvent::Terminal {
            outcome: label,
            action,
            spoken_chars: spoken.map(|text| text.chars().count()).unwrap_or(0),
            spoken_text: spoken.and_then(|text| self.tracer.content(text)),
        });
    }
}

impl Default for ChatTurnTrace {
    fn default() -> Self {
        Self::disabled()
    }
}

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

/// A run interrupted by a required device observation (`Preflight`), carrying
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
                                            // Preflights carry one resumable
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

/// Order-independent serialization of a tool call's arguments, for use as a
/// within-turn memo key.
///
/// Keys are sorted recursively so `{"artist":"X","limit":5}` and
/// `{"limit":5,"artist":"X"}` produce one key: they are the same request and
/// must not cost two network round-trips. Sorting is recursive because nested
/// objects carry arguments too.
fn canonical_arguments(arguments: &serde_json::Value) -> String {
    fn canonicalize(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(fields) => serde_json::Value::Object(
                fields
                    .iter()
                    .map(|(key, nested)| (key.clone(), canonicalize(nested)))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            serde_json::Value::Array(items) => {
                // Arrays are ordered data, not a key set: [a, b] and [b, a] are
                // different requests. Recurse without reordering.
                serde_json::Value::Array(items.iter().map(canonicalize).collect())
            }
            other => other.clone(),
        }
    }
    canonicalize(arguments).to_string()
}

/// Stamp `[TOOL_ERROR]` on a failed observation and bound its size before it
/// re-enters the transcript. A successful observation is passed through
/// (already bounded by the tools impl, but re-bounded defensively).
fn bound_observation(ok: bool, content: &str) -> String {
    let body = bound_bytes(content, MAX_TOOL_STEP_RESULT_BYTES);
    if ok {
        body
    } else {
        format!("{TOOL_STEP_ERROR_PREFIX} {body}")
    }
}

/// How many characters this step actually asked the model to read: the system
/// prompt plus every text part of the transcript.
///
/// Shape, not content — the text itself never leaves the transcript. Non-text
/// parts (images, audio, documents, reasoning blocks) count zero rather than
/// guessing at a character equivalent for bytes.
fn transcript_chars(system_prompt: &str, messages: &[Message]) -> usize {
    fn user_chars(content: &UserContent) -> usize {
        match content {
            UserContent::Text(text) => text.text.chars().count(),
            UserContent::ToolResult(result) => result
                .content
                .iter()
                .map(|item| match item {
                    ToolResultContent::Text(text) => text.text.chars().count(),
                    _ => 0,
                })
                .sum(),
            _ => 0,
        }
    }

    fn assistant_chars(content: &AssistantContent) -> usize {
        match content {
            AssistantContent::Text(text) => text.text.chars().count(),
            // A proposed call costs the model its name and its arguments.
            AssistantContent::ToolCall(call) => {
                call.function.name.chars().count()
                    + call.function.arguments.to_string().chars().count()
            }
            _ => 0,
        }
    }

    system_prompt.chars().count()
        + messages
            .iter()
            .map(|message| match message {
                Message::User { content } => content.iter().map(user_chars).sum::<usize>(),
                Message::Assistant { content, .. } => {
                    content.iter().map(assistant_chars).sum::<usize>()
                }
                // The loop never builds one (the system prompt travels in its
                // own request field), but a provider adapter could.
                Message::System { content } => content.chars().count(),
            })
            .sum::<usize>()
}

fn bound_bytes(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = 0;
    for (start, ch) in value.char_indices() {
        let next = start + ch.len_utf8();
        if next > max {
            break;
        }
        end = next;
    }
    value[..end].to_string()
}

fn assistant_tool_calls_message(calls: &[ToolStepCall]) -> Message {
    Message::Assistant {
        id: None,
        content: OneOrMany::many(
            calls
                .iter()
                .map(|call| {
                    AssistantContent::ToolCall(ToolCall {
                        id: call.call_id.clone(),
                        call_id: Some(call.call_id.clone()),
                        function: ToolFunction {
                            name: call.name.clone(),
                            arguments: call.arguments.clone(),
                        },
                        signature: None,
                        additional_params: None,
                    })
                })
                .collect::<Vec<_>>(),
        )
        .expect("selected tool-call batch is non-empty"),
    }
}

/// Whether a transcript entry is a tool result, i.e. evidence this run actually
/// gathered something worth answering from.
fn is_tool_result_message(message: &Message) -> bool {
    let Message::User { content } = message else {
        return false;
    };
    content
        .iter()
        .any(|item| matches!(item, UserContent::ToolResult(_)))
}

fn tool_result_message(call: &ToolStepCall, content: &str) -> Message {
    Message::User {
        content: OneOrMany::one(UserContent::tool_result(
            call.call_id.clone(),
            OneOrMany::one(ToolResultContent::text(content.to_string())),
        )),
    }
}

fn tool_results_message(results: &[(ToolStepCall, String)]) -> Message {
    Message::User {
        content: OneOrMany::many(
            results
                .iter()
                .map(|(call, content)| {
                    UserContent::tool_result(
                        call.call_id.clone(),
                        OneOrMany::one(ToolResultContent::text(content.clone())),
                    )
                })
                .collect::<Vec<_>>(),
        )
        .expect("parallel read batch is non-empty"),
    }
}

/// Closed-set, content-free category for a backend error string.
/// Turn a model answer into something a speaker should say out loud.
///
/// "No markdown, no lists, no URLs" exists only as prompt text, and a model
/// that ignores it gets narrated verbatim — so a bulleted answer is read as
/// "dash … dash …", `**really**` becomes "asterisk asterisk really", and a bare
/// URL is spelled out character by character. The input side is already bounded;
/// this gives the output side the same treatment.
///
/// Deliberately conservative: it removes markup that only ever exists for a
/// screen, and leaves prose alone. It does not try to rewrite the answer.
fn speakable_answer(answer: &str) -> String {
    let mut out = String::with_capacity(answer.len());
    for raw_line in answer.lines() {
        let mut line = raw_line.trim();

        // Heading markers and block quotes: screen-only furniture.
        line = line.trim_start_matches(['#', '>']).trim_start();

        // List bullets. Ordered markers ("1.", "2)") are only stripped when
        // they open the line, so "won 3. place" is untouched.
        if let Some(rest) = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .or_else(|| line.strip_prefix("+ "))
        {
            line = rest.trim_start();
        } else {
            let digits: String = line.chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                let after = &line[digits.len()..];
                if let Some(rest) = after
                    .strip_prefix(". ")
                    .or_else(|| after.strip_prefix(") "))
                {
                    line = rest.trim_start();
                }
            }
        }

        if line.is_empty() {
            continue;
        }
        if !out.is_empty() {
            // Join lines as sentences so the narrator does not run them
            // together, and does not pause as if reading a list.
            if !out.ends_with(['.', '!', '?', ',', ';', ':']) {
                out.push('.');
            }
            out.push(' ');
        }
        out.push_str(line);
    }

    // Emphasis and code markers, which are pronounced if left in.
    let out: String = out
        .replace("**", "")
        .replace("__", "")
        .replace(['`', '*'], "");

    // Bare URLs read terribly aloud; drop the token rather than spell it.
    let out = out
        .split_whitespace()
        .filter(|token| {
            let t = token.trim_matches(|c: char| !c.is_alphanumeric());
            !(t.starts_with("http://") || t.starts_with("https://") || t.starts_with("www."))
        })
        .collect::<Vec<_>>()
        .join(" ");

    let trimmed = out.trim();
    if trimmed.is_empty() {
        // Stripping must never produce silence.
        return answer.trim().to_string();
    }
    bound_bytes(trimmed, MAX_SPOKEN_ANSWER_BYTES)
}

/// Upper bound on one spoken answer. A wearable turn is a short spoken reply;
/// past this the narration outlives the user's patience and the stock timeout.
const MAX_SPOKEN_ANSWER_BYTES: usize = 4 * 1024;

/// Longest backend error we are willing to narrate. Provider messages that
/// came through `friendly_error_message` are one short sentence; anything much
/// longer is a raw diagnostic that escaped, and reading it aloud would be worse
/// than the generic line.
const MAX_SPOKEN_BACKEND_ERROR_BYTES: usize = 180;

/// What the user actually hears when a turn declines.
///
/// Provider errors that are already wearer-facing sentences are passed through;
/// everything else is translated (see [`speakable_backend_error`]), and
/// anything unexpectedly long or empty falls back to the generic line — a
/// wearable must never read a stack trace out loud.
fn decline_speech(reason: ChatTurnDeclineReason, backend_error: Option<&str>) -> String {
    match reason {
        ChatTurnDeclineReason::BackendUnavailable => backend_error
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .map(speakable_backend_error)
            .unwrap_or_else(|| CHAT_TURN_GENERIC_DECLINE.to_string()),
        // Distinct, honest, and each suggests the one thing that actually helps.
        ChatTurnDeclineReason::Budget => {
            "That needed more steps than I can take in one go. Try asking for one thing at a time."
                .to_string()
        }
        ChatTurnDeclineReason::EmptyModel => {
            "I didn't get an answer back that time. Please try again.".to_string()
        }
        ChatTurnDeclineReason::NoProgress => {
            "I couldn't work out how to do that one. Try rephrasing it.".to_string()
        }
    }
}

/// Turn one backend error into something a person wearing a Pin can hear.
///
/// Measured defect this exists for: the Pin said, out loud, "The Codex host
/// bridge could not be verified. Check Wi-Fi, TLS, and the bridge process." The
/// wearer is on a pavement somewhere; the computer running the bridge is not
/// with them, and TLS is not theirs to check. That sentence reached the speaker
/// because this function used to end in `_ => error.to_string()` — a verbatim
/// passthrough of anything short enough to narrate.
///
/// The passthrough was only ever safe for the rig providers, whose errors are
/// rewritten by `llm::error::friendly_error_message` before they leave the
/// provider. The Codex provider mints its own sentences for a host operator and
/// never called it, so ~9 operator instructions went straight to the speaker.
/// The arm is therefore a WHITELIST of the sentences that layer authors for a
/// wearer, and everything else is mapped through the same rewriter the rig path
/// already trusts.
///
/// Speech only. The raw error is untouched everywhere it matters for diagnosis:
/// `chat_turn_backend_error_category` and `chat_turn_backend_error_is_retryable`
/// both still read the original text, and the precise fault is named in the host
/// log by the layer that observed it (`llm::local_codex_bridge` `chat_outcome`).
/// That separation is deliberate — a previous attempt to soften the *diagnosis*
/// blamed login for every 503 and sent owners to repair a healthy session.
fn speakable_backend_error(error: &str) -> String {
    match chat_turn_backend_error_category(error) {
        // Developer-facing strings: say something the owner can act on instead.
        "unsupported_backend" => {
            "This device's AI model isn't set up for that. Please check the server settings."
                .to_string()
        }
        "oversized_args" => {
            "That was too much for me at once. Try asking for one thing at a time.".to_string()
        }
        _ if error.len() > MAX_SPOKEN_BACKEND_ERROR_BYTES => CHAT_TURN_GENERIC_DECLINE.to_string(),
        // Already a friendly, speakable sentence from the provider layer.
        _ if WEARER_FACING_ERRORS.contains(&error) => error.to_string(),
        // A host-operator diagnostic. Say the wearer's version of it instead.
        _ => friendly_error_message(&error),
    }
}

// ─── Spoken-register guard ──────────────────────────────────────────
//
// Measured defect this exists for: the Pin said, out loud, "I can't access
// music search or playback in this run." A person wearing a Pin cannot know
// what a "run" is. The phrase was never a spoken string we wrote — the model
// copied it verbatim out of `play_music`'s own tool text, and nothing between
// the model and the narrator inspects wording (`speakable_answer` strips screen
// markup; `bound_spoken_answer` only truncates).
//
// A model can always echo something we did not anticipate, so this cannot be a
// complete defence. What it CAN do is keep the vocabulary out of the strings we
// author ourselves, which is the half we control, and fail loudly the moment
// one creeps back in.

/// Words and phrases that belong to the implementation and must never reach a
/// spoken reply, each with the reason it is banned.
///
/// Scope, deliberately narrow: this is asserted over strings the USER HEARS.
/// It is never applied to tracing/telemetry text, to
/// [`ChatTurnDeclineReason::label`], to the `thought` strings that travel beside
/// a spoken response, or to the model-facing failed observations in
/// `tool_catalog`. Those are diagnostics, and their engineering precision is
/// exactly what made this defect findable — sanitising them would trade a real
/// capability for a cosmetic one.
///
/// Matching is word-boundary and case-insensitive, over text normalised so that
/// punctuation and underscores are separators. `call_id` and `from_call_id`
/// therefore both match the single entry `"call id"`, and `run` does not match
/// `running`.
///
/// Test-only on purpose: this is a build-time guard over the strings this
/// repository authors, not a runtime filter. A runtime filter over model output
/// would be the wrong shape — it would silently rewrite an answer the model
/// meant, and hide the fact that our own text taught it the word.
#[cfg(test)]
pub const INTERNAL_VOCABULARY: &[(&str, &str)] = &[
    // The exact phrase the device was measured speaking aloud.
    (
        "in this run",
        "the measured leak; a wearer has no notion of a run",
    ),
    ("this run", "same leak without the preposition"),
    (
        "run",
        "one model-and-tool loop: engine bookkeeping, not anything the user owns",
    ),
    // Identifiers and transcript machinery.
    (
        "call id",
        "an internal identifier (also matches call_id / from_call_id)",
    ),
    ("tool step", "one internal model-and-tool exchange"),
    (
        "tool",
        "the model's implementation surface; the user asked for an answer",
    ),
    ("tools", "plural of the same"),
    (
        "observation",
        "our word for a tool result in transcript form",
    ),
    ("preflight", "our word for a staged device read"),
    ("iteration", "a step of the loop"),
    // Gate and routing vocabulary.
    (
        "catalog",
        "the native-action validation table; it appeared in the defect trace",
    ),
    (
        "grounding",
        "the argument-provenance check; nothing the user can act on",
    ),
    ("grounded", "same check, adjectival form"),
    ("mutation", "our word for a side-effecting action"),
    ("utterance", "our word for what the user just said"),
    (
        "trusted current user",
        "the authorization gate's own name; describes our trust, not their request",
    ),
    ("trusted user", "shortened form of the same gate"),
    // Which upstream service answered is ours to know, not theirs.
    ("provider", "which upstream service backs a read"),
    ("backend", "same, for the model service"),
    // Host-operator vocabulary. The wearer is walking around with a Pin on
    // their shirt; the machine running the server is not with them, so a
    // sentence that asks them to inspect it is not an answer, it is a chore
    // they cannot do. Measured: the Pin said "Check Wi-Fi, TLS, and the bridge
    // process" out loud.
    (
        "codex",
        "the host program's own name; nothing a wearer owns",
    ),
    ("bridge", "the host process that fronts it"),
    ("tls", "transport security; not the wearer's to check"),
    (
        "http",
        "wire vocabulary, and it also catches an HTTP status leak",
    ),
    ("endpoint", "the address of a service; wire vocabulary"),
    (
        "process",
        "an operating-system process on a machine they are not near",
    ),
    // Engine and wire names.
    ("agentic", "the runtime's internal name"),
    ("correlation", "the trace id that ties one turn together"),
    ("schema", "argument shape"),
    ("payload", "wire vocabulary"),
    ("json", "wire vocabulary"),
    ("grpc", "wire vocabulary"),
    ("token", "model or auth accounting"),
    ("tokens", "plural of the same"),
];

/// Normalise text for word-boundary vocabulary matching: lowercase, every
/// non-alphanumeric character becomes a separator, and the result is padded
/// with spaces so a term can be matched with its own boundaries included.
#[cfg(test)]
fn normalized_for_vocabulary(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len() + 2);
    normalized.push(' ');
    for character in text.chars() {
        if character.is_alphanumeric() {
            normalized.extend(character.to_lowercase());
        } else if !normalized.ends_with(' ') {
            normalized.push(' ');
        }
    }
    if !normalized.ends_with(' ') {
        normalized.push(' ');
    }
    normalized
}

/// The first [`INTERNAL_VOCABULARY`] term present in `text`, if any.
#[cfg(test)]
pub fn internal_vocabulary_hit(text: &str) -> Option<&'static str> {
    let haystack = normalized_for_vocabulary(text);
    INTERNAL_VOCABULARY
        .iter()
        .map(|(term, _)| *term)
        .find(|term| haystack.contains(&normalized_for_vocabulary(term)))
}

/// Whether retrying or spending more budget could plausibly change the outcome.
///
/// A bad API key, a missing model or a content-filter refusal will fail
/// identically on every retry, so burning the remaining deadline on them only
/// delays a failure the user could already have been told about — the reason a
/// misconfigured provider takes the better part of a minute to report.
fn chat_turn_backend_error_is_retryable(message: &str) -> bool {
    let raw = message.to_lowercase();
    let permanent = [
        "api key",
        "model wasn't found",
        "model not found",
        "declined to answer",
        "does not support the tool-step loop",
        "check the server settings",
    ];
    !permanent.iter().any(|marker| raw.contains(marker))
}

fn chat_turn_backend_error_category(message: &str) -> &'static str {
    if message.contains("timed out") {
        "timeout"
    } else if message.contains("does not support the tool-step loop") {
        "unsupported_backend"
    } else if message.contains("empty response") {
        "empty_response"
    } else if message.contains("oversized") {
        "oversized_args"
    } else {
        "backend_other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::backend::{LlmFuture, ToolStepFuture};
    use crate::llm::tool_step::ToolStepDefinition;
    use crate::tier_a::native_actions;
    use crate::turn_trace::TracePolicy;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn a_screen_formatted_answer_is_spoken_as_prose() {
        let answer = "## Options\n\
                      - **Oat** milk is creamy\n\
                      - *Almond* is lighter\n\
                      1. Try `oat` first\n\
                      See https://example.com/coffee for more";
        let spoken = speakable_answer(answer);

        // None of the screen furniture survives to the narrator.
        for markup in ["#", "**", "*", "`", "- ", "https://"] {
            assert!(
                !spoken.contains(markup),
                "{markup:?} leaked into speech: {spoken}",
            );
        }
        // The prose itself is intact and joined into sentences.
        assert!(spoken.contains("Oat milk is creamy"));
        assert!(spoken.contains("Almond is lighter"));
        assert!(spoken.contains("Try oat first"));
    }

    #[test]
    fn sanitising_never_produces_silence_and_leaves_prose_alone() {
        // A plain sentence must pass through untouched.
        let plain = "It's about four degrees and clear in Copenhagen.";
        assert_eq!(speakable_answer(plain), plain);

        // Ordinals mid-sentence are not list markers.
        let ordinal = "They came 3. in the final standings";
        assert!(speakable_answer(ordinal).contains("3."));

        // An answer that is *only* markup must still say something.
        assert!(!speakable_answer("***").trim().is_empty());

        // And the result is bounded.
        let huge = "word ".repeat(4000);
        assert!(speakable_answer(&huge).len() <= MAX_SPOKEN_ANSWER_BYTES);
    }

    #[test]
    fn a_decline_says_why_instead_of_one_sentence_for_every_cause() {
        // The provider layer has already turned this into a speakable sentence;
        // the whole point is that it survives to the user.
        let key =
            "There's a problem with the API key configuration. Please check the server settings.";
        assert_eq!(
            decline_speech(ChatTurnDeclineReason::BackendUnavailable, Some(key)),
            key,
        );

        // Each non-backend reason is distinct and suggests what actually helps,
        // rather than all collapsing to the generic line.
        let budget = decline_speech(ChatTurnDeclineReason::Budget, None);
        let empty = decline_speech(ChatTurnDeclineReason::EmptyModel, None);
        let stuck = decline_speech(ChatTurnDeclineReason::NoProgress, None);
        for spoken in [&budget, &empty, &stuck] {
            assert_ne!(spoken.as_str(), CHAT_TURN_GENERIC_DECLINE);
        }
        assert_ne!(budget, empty);
        assert_ne!(empty, stuck);
    }

    #[test]
    fn a_wearable_never_reads_a_developer_string_aloud() {
        // Developer-facing producers are translated, not narrated verbatim.
        let spoken = decline_speech(
            ChatTurnDeclineReason::BackendUnavailable,
            Some("the configured model backend does not support the tool-step loop"),
        );
        assert!(!spoken.contains("tool-step loop"));
        assert!(spoken.contains("server settings"));

        // Anything unexpectedly long is a raw diagnostic that escaped.
        let raw = "x".repeat(MAX_SPOKEN_BACKEND_ERROR_BYTES + 1);
        assert_eq!(
            decline_speech(ChatTurnDeclineReason::BackendUnavailable, Some(&raw)),
            CHAT_TURN_GENERIC_DECLINE,
        );

        // An empty or whitespace error must not narrate an empty sentence.
        assert_eq!(
            decline_speech(ChatTurnDeclineReason::BackendUnavailable, Some("   ")),
            CHAT_TURN_GENERIC_DECLINE,
        );
    }

    /// The error sentences the Codex provider writes, exactly as they appear in
    /// its source.
    ///
    /// These are written for whoever administers the host: they name the
    /// bridge, the transport and the HTTP status, and several instruct the
    /// reader to go restart or reconfigure something. None of that is speech.
    /// They reach this module as the `backend_error` of a declined turn, so
    /// this is the fixture that proves the speech boundary rewrites them.
    ///
    /// A copied fixture normally rots in silence; this one is pinned against
    /// `codex.rs` itself by `the_codex_error_fixture_still_matches_its_source`,
    /// so rewording a provider sentence turns that test red rather than quietly
    /// dropping the sentence out of the corpus.
    const CODEX_SOURCE_ERROR_LITERALS: &[&str] = &[
        "The Codex bridge token is not configured. Add it in server settings.",
        "The Codex bridge returned an empty response.",
        "The Codex bridge returned an invalid response.",
        "The Codex bridge returned an invalid response. Please restart the host bridge.",
        "The camera image is too large for vision analysis.",
        "The camera returned an unsupported image format.",
        "The Codex host bridge timed out. Please try again.",
        "I couldn't reach the Codex host bridge. Check Wi-Fi and the bridge process.",
        "The Codex host bridge could not be verified. Check Wi-Fi, TLS, and the bridge process.",
        "The Codex bridge token was rejected. Check the server settings.",
        "Codex on the host is unavailable right now. Please try again.",
        // Interpolated at the call site; rendered below with a real status.
        "The Codex host bridge failed with HTTP status {status}.",
    ];

    /// The fixture as it actually arrives, with the one format hole filled.
    fn codex_backend_errors() -> Vec<String> {
        CODEX_SOURCE_ERROR_LITERALS
            .iter()
            .map(|literal| literal.replace("{status}", "503 Service Unavailable"))
            .collect()
    }

    #[test]
    fn the_codex_error_fixture_still_matches_its_source() {
        const CODEX_SOURCE: &str = include_str!("../llm/providers/codex.rs");
        // Aliveness: a path that stopped resolving to the provider, or a scan
        // that matched nothing, would make every assertion below vacuous.
        assert!(
            CODEX_SOURCE.contains("fn bridge_status_error"),
            "the fixture is no longer reading the Codex provider",
        );
        for literal in CODEX_SOURCE_ERROR_LITERALS {
            assert!(
                CODEX_SOURCE.contains(literal),
                "the Codex provider no longer says this, so the corpus stopped covering it: {literal}",
            );
        }
    }

    /// Everything a wearer can hear from this module, built by CALLING the
    /// producers rather than by copying their text, so a new decline reason or
    /// a reworded sentence is covered automatically.
    ///
    /// It also covers both halves of the backend-error boundary: the sentences
    /// `llm::error` authors for a wearer (which pass through untouched) and the
    /// Codex provider's host-operator sentences (which must not).
    fn spoken_corpus() -> Vec<String> {
        let mut corpus = vec![CHAT_TURN_GENERIC_DECLINE.to_string()];
        for reason in [
            ChatTurnDeclineReason::Budget,
            ChatTurnDeclineReason::EmptyModel,
            ChatTurnDeclineReason::NoProgress,
            ChatTurnDeclineReason::BackendUnavailable,
        ] {
            corpus.push(decline_speech(reason, None));
        }
        // The two developer-facing producers this module translates itself.
        corpus.push(speakable_backend_error(
            "the configured model backend does not support the tool-step loop",
        ));
        corpus.push(speakable_backend_error("oversized arguments for one call"));
        // An over-long raw diagnostic must fall back, not be narrated.
        corpus.push(decline_speech(
            ChatTurnDeclineReason::BackendUnavailable,
            Some(&"x".repeat(MAX_SPOKEN_BACKEND_ERROR_BYTES + 1)),
        ));
        // The whitelisted provider sentences, called rather than copied.
        for authored in WEARER_FACING_ERRORS {
            corpus.push(decline_speech(
                ChatTurnDeclineReason::BackendUnavailable,
                Some(authored),
            ));
        }
        // Every Codex host-operator sentence, as the wearer would hear it.
        for raw in codex_backend_errors() {
            corpus.push(decline_speech(
                ChatTurnDeclineReason::BackendUnavailable,
                Some(&raw),
            ));
        }
        corpus
    }

    #[test]
    fn a_provider_sentence_written_for_the_host_is_not_read_to_the_wearer() {
        // The measured leak: a person on a pavement told to check TLS on a
        // computer they are not near.
        let spoken = decline_speech(
            ChatTurnDeclineReason::BackendUnavailable,
            Some("The Codex host bridge could not be verified. Check Wi-Fi, TLS, and the bridge process."),
        );
        assert!(!spoken.contains("TLS"));
        assert!(!spoken.contains("bridge"));

        // Softened for the ear, never for the log: the classifiers that drive
        // retry and triage still read the untouched original.
        let raw = "The Codex host bridge failed with HTTP status 503 Service Unavailable.";
        assert!(!speakable_backend_error(raw).contains("503"));
        assert_eq!(chat_turn_backend_error_category(raw), "backend_other");
        assert!(chat_turn_backend_error_is_retryable(raw));

        // A sentence the provider layer already wrote for a wearer survives
        // intact — the arm is a whitelist, not a blanket rewrite.
        let authored = "The AI service is temporarily unavailable. Please try again shortly.";
        assert!(WEARER_FACING_ERRORS.contains(&authored));
        assert_eq!(speakable_backend_error(authored), authored);
    }

    #[test]
    fn the_internal_vocabulary_matcher_is_falsifiable() {
        // Positive controls: a broken matcher must not pass vacuously.
        assert_eq!(
            internal_vocabulary_hit("I can't access music search or playback in this run."),
            Some("in this run"),
        );
        assert_eq!(
            internal_vocabulary_hit("Copy the from_call_id from the earlier call."),
            Some("call id"),
        );
        assert_eq!(
            internal_vocabulary_hit("The PROVIDER is unavailable."),
            Some("provider"),
        );

        // Negative controls: ordinary speech, including words that merely
        // contain a banned term, must stay clean.
        for clean in [
            "Unlock your Pin and ask again.",
            "I couldn't find that song. Try naming the artist.",
            "You're running late for the 9am.",
            "It's sixteen degrees and cloudy.",
        ] {
            assert_eq!(internal_vocabulary_hit(clean), None, "{clean}");
        }

        // Every entry carries a reason, so the list cannot rot into folklore.
        for (term, why) in INTERNAL_VOCABULARY {
            assert!(!term.is_empty() && !why.is_empty(), "{term}: {why}");
            assert_eq!(
                internal_vocabulary_hit(&format!("a sentence with {term} inside")),
                Some(*term),
                "{term} is listed but unmatchable",
            );
        }
    }

    #[test]
    fn a_spoken_decline_never_carries_internal_vocabulary() {
        let corpus = spoken_corpus();
        // Aliveness: an empty or collapsed corpus would pass vacuously. The
        // floor counts the eight lines this module authors plus both halves of
        // the backend-error boundary, so losing either half is red.
        assert!(
            corpus.len() >= 8 + WEARER_FACING_ERRORS.len() + CODEX_SOURCE_ERROR_LITERALS.len(),
            "corpus collapsed: {}",
            corpus.len(),
        );
        assert!(
            corpus.iter().any(|line| line == CHAT_TURN_GENERIC_DECLINE),
            "the generic decline vanished from the corpus",
        );
        assert!(
            CODEX_SOURCE_ERROR_LITERALS.len() >= 10,
            "the Codex fixture collapsed: {}",
            CODEX_SOURCE_ERROR_LITERALS.len(),
        );

        for line in &corpus {
            assert!(!line.trim().is_empty(), "a spoken line was empty");
            assert_eq!(
                internal_vocabulary_hit(line),
                None,
                "internal vocabulary reached speech: {line}",
            );
            // A wearable answer over ~200 characters is interrupted mid-
            // delivery. A decline is one short sentence by construction, so
            // hold it to the tighter narratable-error ceiling this module
            // already owns rather than the outer spoken-answer limit.
            assert!(
                line.len() <= MAX_SPOKEN_BACKEND_ERROR_BYTES,
                "spoken line is too long to survive the narrator: {line}",
            );
        }

        // The assertion mechanism itself goes red on a planted leak.
        assert!(
            internal_vocabulary_hit(&format!("{CHAT_TURN_GENERIC_DECLINE} in this run")).is_some()
        );
    }

    #[test]
    fn permanent_faults_do_not_spend_the_rest_of_the_deadline_retrying() {
        // These fail identically on every retry, so the grace path only delays
        // a failure we can already describe.
        for permanent in [
            "There's a problem with the API key configuration. Please check the server settings.",
            "The configured AI model wasn't found. Please check the server settings.",
            "The AI service declined to answer that. Try rephrasing your question.",
            "the configured model backend does not support the tool-step loop",
        ] {
            assert!(
                !chat_turn_backend_error_is_retryable(permanent),
                "should be permanent: {permanent}",
            );
        }

        // Transient faults keep the grace path, which is what stops one hiccup
        // from discarding work already gathered.
        for transient in [
            "The request to the AI service timed out. Please try again.",
            "I couldn't reach the AI service. Please check the server's internet connection.",
            "I'm getting too many requests right now. Please try again in a moment.",
            "connection reset",
        ] {
            assert!(
                chat_turn_backend_error_is_retryable(transient),
                "should be retryable: {transient}",
            );
        }
    }

    // ---- scripted backend: returns pre-scripted step results in order ----
    struct ScriptedBackend {
        steps: Mutex<std::collections::VecDeque<Result<ToolStepResult, String>>>,
        seen_tool_counts: Mutex<Vec<usize>>,
        seen_message_counts: Mutex<Vec<usize>>,
        seen_messages: Mutex<Vec<Vec<Message>>>,
        seen_timeouts: Mutex<Vec<Duration>>,
        finished_sessions: Mutex<Vec<String>>,
    }
    impl ScriptedBackend {
        fn new(steps: Vec<Result<ToolStepResult, String>>) -> Self {
            Self {
                steps: Mutex::new(steps.into_iter().collect()),
                seen_tool_counts: Mutex::new(Vec::new()),
                seen_message_counts: Mutex::new(Vec::new()),
                seen_messages: Mutex::new(Vec::new()),
                seen_timeouts: Mutex::new(Vec::new()),
                finished_sessions: Mutex::new(Vec::new()),
            }
        }
    }
    impl LlmBackend for ScriptedBackend {
        fn chat<'a>(&'a self, _request: crate::llm::LlmChatRequest) -> LlmFuture<'a> {
            Box::pin(async { Err("unused".to_string()) })
        }
        fn tool_step<'a>(&'a self, request: ToolStepRequest) -> ToolStepFuture<'a> {
            self.seen_tool_counts
                .lock()
                .unwrap()
                .push(request.tools.len());
            self.seen_message_counts
                .lock()
                .unwrap()
                .push(request.messages.len());
            self.seen_messages
                .lock()
                .unwrap()
                .push(request.messages.clone());
            self.seen_timeouts.lock().unwrap().push(request.timeout);
            let next = self.steps.lock().unwrap().pop_front();
            Box::pin(async move { next.unwrap_or_else(|| Err("script exhausted".to_string())) })
        }

        fn finish_tool_session(&self, correlation: &str) {
            self.finished_sessions
                .lock()
                .unwrap()
                .push(correlation.to_string());
        }
    }

    // ---- scripted tools ----
    struct ScriptedTools {
        outcomes: Mutex<std::collections::HashMap<String, ToolExecutionOutcome>>,
        catalog_names: Vec<&'static str>,
        cue: Option<String>,
        cue_requests: Mutex<Vec<Vec<String>>>,
        executed: Mutex<Vec<String>>,
    }
    impl ScriptedTools {
        fn new(cue: Option<&str>) -> Self {
            Self {
                outcomes: Mutex::new(std::collections::HashMap::new()),
                catalog_names: vec!["knowledge_lookup"],
                cue: cue.map(|c| c.to_string()),
                cue_requests: Mutex::new(Vec::new()),
                executed: Mutex::new(Vec::new()),
            }
        }
        fn with_catalog(mut self, names: Vec<&'static str>) -> Self {
            self.catalog_names = names;
            self
        }
        fn with(self, name: &str, outcome: ToolExecutionOutcome) -> Self {
            self.outcomes
                .lock()
                .unwrap()
                .insert(name.to_string(), outcome);
            self
        }
    }
    #[tonic::async_trait]
    impl ToolCatalog for ScriptedTools {
        fn catalog(&self) -> Vec<ToolStepDefinition> {
            self.catalog_names
                .iter()
                .map(|name| ToolStepDefinition {
                    name,
                    description: "test tool",
                    parameters: serde_json::json!({"type":"object"}),
                })
                .collect()
        }
        fn cue_for(&self, tool_names: &[&str]) -> Option<String> {
            self.cue_requests
                .lock()
                .unwrap()
                .push(tool_names.iter().map(|name| (*name).to_string()).collect());
            self.cue.clone()
        }
        async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
            self.executed.lock().unwrap().push(call.name.clone());
            self.outcomes
                .lock()
                .unwrap()
                .get(&call.name)
                .cloned()
                .unwrap_or(ToolExecutionOutcome::Observation {
                    ok: false,
                    content: "unknown tool".to_string(),
                })
        }
    }

    struct BarrierReads {
        barrier: tokio::sync::Barrier,
        executed: Mutex<Vec<String>>,
    }

    impl BarrierReads {
        fn new() -> Self {
            Self {
                barrier: tokio::sync::Barrier::new(2),
                executed: Mutex::new(Vec::new()),
            }
        }
    }

    #[tonic::async_trait]
    impl ToolCatalog for BarrierReads {
        fn catalog(&self) -> Vec<ToolStepDefinition> {
            ["alpha_read", "beta_read"]
                .into_iter()
                .map(|name| ToolStepDefinition {
                    name,
                    description: "independent test read",
                    parameters: serde_json::json!({"type":"object"}),
                })
                .collect()
        }

        fn cue_for(&self, _tool_names: &[&str]) -> Option<String> {
            None
        }

        async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
            self.executed.lock().unwrap().push(call.name.clone());
            // A serial implementation blocks forever on the first call. The
            // surrounding test timeout therefore proves both futures were
            // actually polled together, not merely appended as one transcript.
            self.barrier.wait().await;
            ToolExecutionOutcome::Observation {
                ok: true,
                content: format!("{} result", call.name),
            }
        }

        fn parallel_read_safe(&self, tool_name: &str) -> bool {
            matches!(tool_name, "alpha_read" | "beta_read")
        }
    }

    struct RecordingCues(Mutex<Vec<String>>);
    impl ChatTurnCueSink for RecordingCues {
        fn emit(&self, cue: ChatTurnProgressCue<'_>) {
            assert!(!cue.run_id().is_empty());
            assert!(!cue.operation().is_empty());
            self.0.lock().unwrap().push(cue.phrase().to_string());
        }
    }

    struct RecordingCueEvents(Mutex<Vec<(String, String, String)>>);
    impl ChatTurnCueSink for RecordingCueEvents {
        fn emit(&self, cue: ChatTurnProgressCue<'_>) {
            self.0.lock().unwrap().push((
                cue.run_id().to_string(),
                cue.operation().to_string(),
                cue.phrase().to_string(),
            ));
        }
    }

    /// Records the selected tool-call lifecycle so multi-step runs can assert
    /// the exact stock mid-run wire shape and its ordering.
    #[derive(Default)]
    struct RecordingTurns(Mutex<Vec<String>>);
    impl ChatTurnObserver for RecordingTurns {
        fn on_batch_start(&self, first_tool: &str) {
            self.0.lock().unwrap().push(format!("start:{first_tool}"));
        }
        fn on_batch_end(&self, first_tool: &str, ok: bool) {
            self.0
                .lock()
                .unwrap()
                .push(format!("end:{first_tool}:{ok}"));
        }
    }

    fn call(name: &str) -> ToolStepCall {
        ToolStepCall {
            call_id: format!("{name}-1"),
            name: name.to_string(),
            arguments: serde_json::json!({}),
        }
    }

    fn transcript_tool_call_names(messages: &[Message]) -> Vec<String> {
        let mut names = Vec::new();
        for message in messages {
            let Message::Assistant { content, .. } = message else {
                continue;
            };
            for item in content.iter() {
                if let AssistantContent::ToolCall(call) = item {
                    names.push(call.function.name.clone());
                }
            }
        }
        names
    }

    fn transcript_tool_result_ids(messages: &[Message]) -> Vec<String> {
        let mut ids = Vec::new();
        for message in messages {
            let Message::User { content } = message else {
                continue;
            };
            for item in content.iter() {
                if let UserContent::ToolResult(result) = item {
                    ids.push(result.id.clone());
                }
            }
        }
        ids
    }

    fn transcript_tool_result_texts(messages: &[Message]) -> Vec<String> {
        let mut texts = Vec::new();
        for message in messages {
            let Message::User { content } = message else {
                continue;
            };
            for item in content.iter() {
                let UserContent::ToolResult(result) = item else {
                    continue;
                };
                for result_content in result.content.iter() {
                    if let ToolResultContent::Text(text) = result_content {
                        texts.push(text.text.clone());
                    }
                }
            }
        }
        texts
    }

    /// Test driver with a real timer. The loop keeps progress audible across a
    /// slow model step via `tokio::time::sleep`, which needs a tokio reactor —
    /// `futures::executor::block_on` has none and panics.
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    const TRACE_CORRELATION: &str = "223e4567-e89b-42d3-a456-426614174000";

    #[derive(Clone, Default)]
    struct TraceWriter(Arc<Mutex<Vec<u8>>>);

    struct TraceWriterGuard(Arc<Mutex<Vec<u8>>>);

    impl Write for TraceWriterGuard {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("trace writer lock").extend(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for TraceWriter {
        type Writer = TraceWriterGuard;

        fn make_writer(&'writer self) -> Self::Writer {
            TraceWriterGuard(Arc::clone(&self.0))
        }
    }

    fn capture_physical_trace<T>(run: impl FnOnce() -> T) -> (T, Vec<String>) {
        let writer = TraceWriter::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(writer.clone())
            .with_ansi(false)
            .without_time()
            .compact()
            .with_target(true)
            .finish();
        let result = tracing::subscriber::with_default(subscriber, run);
        let bytes = writer.0.lock().expect("trace bytes lock").clone();
        let output = String::from_utf8(bytes).expect("trace output is UTF-8");
        let events = output
            .lines()
            .filter_map(|line| {
                line.find(operational_markers::AGENTIC_PHYSICAL_TRACE)
                    .map(|index| line[index..].to_string())
            })
            .collect();
        (result, events)
    }

    fn physical_trace_event(ordinal: usize, tool: &str, result_status: Option<&str>) -> String {
        format!(
            "{} correlation={TRACE_CORRELATION} ordinal={ordinal} tool={tool} status=completed{}",
            operational_markers::AGENTIC_PHYSICAL_TRACE,
            result_status
                .map(|status| format!(" result_status={status}"))
                .unwrap_or_default()
        )
    }

    fn traced_loop<'a>(
        backend: &'a dyn LlmBackend,
        tools: &'a dyn ToolCatalog,
        cues: &'a dyn ChatTurnCueSink,
        observer: &'a dyn ChatTurnObserver,
        max_iterations: usize,
    ) -> ChatTurnLoop<'a> {
        ChatTurnLoop {
            backend,
            tools,
            cues,
            observer,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: TRACE_CORRELATION.to_string(),
            config: ChatTurnLoopConfig::new(max_iterations),
        }
    }

    #[test]
    fn physical_trace_emits_one_terminal_for_a_direct_answer() {
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final("Six million.".into()))]);
        let tools = ScriptedTools::new(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);

        let (outcome, events) =
            capture_physical_trace(|| block_on(loop_.run("how many people live there")));

        assert_eq!(outcome, ChatTurnOutcome::Answer("Six million.".into()));
        assert_eq!(events, [physical_trace_event(1, "terminal", None)]);
        assert_eq!(
            backend.finished_sessions.lock().unwrap().as_slice(),
            &[TRACE_CORRELATION],
            "a terminal answer must retire the retained provider thread"
        );
    }

    #[test]
    fn physical_trace_records_reads_replay_and_terminal_contiguously() {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::ToolCalls(vec![call("current_weather")])),
            Ok(ToolStepResult::Final("Best effort.".into())),
        ]);
        let tools = ScriptedTools::new(None)
            .with_catalog(vec!["knowledge_lookup", "current_weather"])
            .with(
                "knowledge_lookup",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "public fact".into(),
                },
            )
            .with(
                "current_weather",
                ToolExecutionOutcome::Observation {
                    ok: false,
                    content: "not available".into(),
                },
            );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 6);

        let (outcome, events) =
            capture_physical_trace(|| block_on(loop_.run("answer with two reads")));

        assert_eq!(outcome, ChatTurnOutcome::Answer("Best effort.".into()));
        assert_eq!(
            tools.executed.lock().unwrap().as_slice(),
            &["knowledge_lookup", "current_weather"],
            "the identical second read is replayed, but still consumes a trace ordinal"
        );
        assert_eq!(
            events,
            [
                physical_trace_event(1, "knowledge_lookup", Some("ok")),
                physical_trace_event(2, "knowledge_lookup", Some("ok")),
                physical_trace_event(3, "current_weather", Some("unavailable")),
                physical_trace_event(4, "terminal", None),
            ]
        );
    }

    #[test]
    fn physical_trace_preserves_the_next_ordinal_across_preflight_resume() {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::ToolCalls(vec![call("current_location")])),
        ]);
        let tools = ScriptedTools::new(None)
            .with_catalog(vec!["knowledge_lookup", "current_location"])
            .with(
                "knowledge_lookup",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "public fact".into(),
                },
            )
            .with(
                "current_location",
                ToolExecutionOutcome::Preflight {
                    action: native_actions::GET_CURRENT_LOCATION.into(),
                    arguments: serde_json::json!({}),
                },
            );
        let resumed_backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("nearby_search")])),
            Ok(ToolStepResult::Final("Three places.".into())),
        ]);
        let resumed_tools = ScriptedTools::new(None)
            .with_catalog(vec!["current_location", "nearby_search"])
            .with(
                "current_location",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "fresh location".into(),
                },
            )
            .with(
                "nearby_search",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "three places".into(),
                },
            );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let resumed_observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 6);
        let resumed_loop = traced_loop(
            &resumed_backend,
            &resumed_tools,
            &resumed_cues,
            &resumed_observer,
            6,
        );

        let ((initial, resumed, next_suspension), events) = capture_physical_trace(|| {
            let (initial, suspension) = block_on(loop_.run_suspendable("find somewhere nearby"));
            let suspension = suspension.expect("preflight must carry its transcript");
            assert_eq!(
                suspension.next_trace_ordinal, 2,
                "the pending preflight has not completed and must not consume an ordinal"
            );
            let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));
            (initial, resumed, next_suspension)
        });

        assert!(matches!(initial, ChatTurnOutcome::Preflight { .. }));
        assert_eq!(resumed, ChatTurnOutcome::Answer("Three places.".into()));
        assert!(next_suspension.is_none());
        assert_eq!(
            events,
            [
                physical_trace_event(1, "knowledge_lookup", Some("ok")),
                physical_trace_event(2, "current_location", Some("ok")),
                physical_trace_event(3, "nearby_search", Some("ok")),
                physical_trace_event(4, "terminal", None),
            ],
            "preflight emits nothing until resume completes the pending call"
        );
    }

    #[test]
    fn physical_trace_records_a_selected_mutation_before_terminal() {
        let action = ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.into(),
            arguments: serde_json::json!({"Track":"T","Artist":"A"}),
        };
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
            "play_music",
        )]))]);
        let tools = ScriptedTools::new(None)
            .with_catalog(vec!["play_music"])
            .with("play_music", ToolExecutionOutcome::Terminal(action.clone()));
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 3);

        let (outcome, events) =
            capture_physical_trace(|| block_on(loop_.run("play the selected track")));

        assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
        assert_eq!(
            events,
            [
                physical_trace_event(1, "other_registered_tool", Some("ok")),
                physical_trace_event(2, "terminal", None),
            ]
        );
    }

    #[test]
    fn physical_trace_replaces_an_unadvertised_name_with_the_invalid_placeholder() {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call(
                "private_text_from_model",
            )])),
            Ok(ToolStepResult::Final("I couldn't use that.".into())),
        ]);
        let tools = ScriptedTools::new(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 3);

        let (outcome, events) =
            capture_physical_trace(|| block_on(loop_.run("try an invented call")));

        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("I couldn't use that.".into())
        );
        assert_eq!(
            events,
            [
                physical_trace_event(1, "invalid_tool", Some("invalid")),
                physical_trace_event(2, "terminal", None),
            ]
        );
        assert!(
            events
                .iter()
                .all(|event| !event.contains("private_text_from_model")),
            "untrusted model text must not cross the physical-proof boundary"
        );
    }

    // ---- turn trace: the durable per-turn decision chain ----

    fn tracer_for(policy: TracePolicy, utterance: &str) -> TurnTracer {
        TurnTracer::new(
            policy,
            TRACE_CORRELATION,
            utterance,
            "2026-07-31T09:00:00Z".to_string(),
        )
    }

    fn enabled_trace(utterance: &str, include_content: bool) -> (TurnTracer, ChatTurnTrace) {
        let tracer = tracer_for(
            TracePolicy {
                enabled: true,
                include_content,
            },
            utterance,
        );
        let trace = ChatTurnTrace::new(tracer.clone(), "codex", "gpt-5.6-sol");
        (tracer, trace)
    }

    /// The recorded chain as an order-preserving list of short shapes, so a test
    /// pins the sequence rather than one event in isolation.
    fn trace_shape(tracer: &TurnTracer) -> Vec<String> {
        tracer
            .finish()
            .expect("an enabled tracer yields a record")
            .events
            .iter()
            .map(|event| match event {
                TraceEvent::ModelStep {
                    iteration,
                    tool_calls,
                    ..
                } => format!("model_step:{iteration}:[{}]", tool_calls.join(",")),
                TraceEvent::ToolCall {
                    ordinal,
                    tool,
                    ok,
                    status,
                    ..
                } => format!("tool_call:{ordinal}:{tool}:{ok}:{status}"),
                TraceEvent::GateDecision {
                    gate,
                    allowed,
                    reason,
                    ..
                } => format!("gate:{gate}:{allowed}:{reason}"),
                TraceEvent::Terminal {
                    outcome,
                    spoken_chars,
                    ..
                } => format!("terminal:{outcome}:{spoken_chars}"),
                TraceEvent::Note { marker, .. } => format!("note:{marker}"),
            })
            .collect()
    }

    /// Instrumentation that changes the run is worse than no instrumentation.
    /// A disabled trace must leave the outcome, the tool executions and the
    /// exact transcript the provider was shown byte-identical to the untraced
    /// entry point — and must produce no record at all.
    #[test]
    fn a_disabled_trace_changes_neither_the_outcome_nor_the_transcript() {
        fn run_once(
            trace: Option<&ChatTurnTrace>,
        ) -> (ChatTurnOutcome, Vec<String>, Vec<Vec<Message>>) {
            let backend = ScriptedBackend::new(vec![
                Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
                Ok(ToolStepResult::Final("Six million.".into())),
            ]);
            let tools = ScriptedTools::new(None).with(
                "knowledge_lookup",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "public fact".into(),
                },
            );
            let cues = RecordingCues(Mutex::new(Vec::new()));
            let observer = NoopTurnObserver;
            let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);
            let utterance = "how many people live there";
            let outcome = match trace {
                Some(trace) => block_on(loop_.run_traced(utterance, trace)),
                None => block_on(loop_.run(utterance)),
            };
            let executed = tools.executed.lock().unwrap().clone();
            let seen = backend.seen_messages.lock().unwrap().clone();
            (outcome, executed, seen)
        }

        let (untraced_outcome, untraced_tools, untraced_messages) = run_once(None);

        // Content capture is deliberately ON here: even the most permissive
        // policy must be inert while `enabled` is false.
        let tracer = tracer_for(
            TracePolicy {
                enabled: false,
                include_content: true,
            },
            "how many people live there",
        );
        let (traced_outcome, traced_tools, traced_messages) =
            run_once(Some(&ChatTurnTrace::new(tracer.clone(), "codex", "sol")));

        assert_eq!(untraced_outcome, traced_outcome);
        assert_eq!(untraced_tools, traced_tools);
        assert_eq!(
            untraced_messages, traced_messages,
            "the provider must be shown exactly the same transcript"
        );
        assert!(
            tracer.finish().is_none(),
            "a disabled tracer must not produce a record"
        );
    }

    /// The chain a normal turn produces: one model step per call, the tool it
    /// ran, the gate that accepted the answer, and one terminal.
    #[test]
    fn an_enabled_trace_records_the_ordered_chain_of_a_tool_then_answer_turn() {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final("Six million.".into())),
        ]);
        let tools = ScriptedTools::new(None).with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "public fact".into(),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);
        let (tracer, trace) = enabled_trace("how many people live there", true);

        let outcome = block_on(loop_.run_traced("how many people live there", &trace));

        assert_eq!(outcome, ChatTurnOutcome::Answer("Six million.".into()));
        assert_eq!(
            trace_shape(&tracer),
            [
                "model_step:0:[knowledge_lookup]",
                "tool_call:1:knowledge_lookup:true:ok",
                "model_step:1:[]",
                "gate:final_answer_verification:true:final_answer_accepted",
                "terminal:respond:12",
            ]
        );

        let record = tracer.finish().expect("record");
        match &record.events[0] {
            TraceEvent::ModelStep {
                provider,
                model,
                prompt_chars,
                completion_chars,
                text,
                ..
            } => {
                assert_eq!(provider, "codex");
                assert_eq!(model, "gpt-5.6-sol");
                // System prompt ("sys") plus the utterance, and nothing else yet.
                assert_eq!(*prompt_chars, 3 + "how many people live there".len());
                assert_eq!(*completion_chars, 0, "a tool step produced no prose");
                assert!(text.is_none());
            }
            other => panic!("expected the first event to be a model step, got {other:?}"),
        }
        match &record.events[1] {
            TraceEvent::ToolCall {
                arguments, result, ..
            } => {
                assert_eq!(arguments.as_deref(), Some("{}"));
                assert_eq!(
                    result.as_deref(),
                    Some("public fact"),
                    "the observation the model was actually given is the evidence"
                );
            }
            other => panic!("expected a tool call, got {other:?}"),
        }
        match record.events.last().expect("terminal") {
            TraceEvent::Terminal {
                outcome,
                action,
                spoken_text,
                ..
            } => {
                assert_eq!(outcome, "respond");
                assert!(action.is_none());
                assert_eq!(spoken_text.as_deref(), Some("Six million."));
            }
            other => panic!("expected a terminal, got {other:?}"),
        }
    }

    /// The failure that motivated all of this: a refusal has to name the gate
    /// and give a stable machine reason, not just leave a marker in a log that
    /// has since rolled.
    #[test]
    fn a_refused_final_answer_records_the_verification_gate_with_its_reason() {
        struct NudgingTools(ScriptedTools);
        #[tonic::async_trait]
        impl ToolCatalog for NudgingTools {
            fn catalog(&self) -> Vec<ToolStepDefinition> {
                self.0.catalog()
            }
            fn cue_for(&self, names: &[&str]) -> Option<String> {
                self.0.cue_for(names)
            }
            async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
                self.0.execute(call).await
            }
            fn final_answer_nudge(&self, _final_answer: &str) -> Option<String> {
                Some("Call play_music now.".to_string())
            }
        }
        let action = ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.into(),
            arguments: serde_json::json!({"Track":"T","Artist":"A"}),
        };
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::Final("Here are the songs.".into())),
            Ok(ToolStepResult::ToolCalls(vec![call("play_music")])),
        ]);
        let tools = NudgingTools(
            ScriptedTools::new(None)
                .with("play_music", ToolExecutionOutcome::Terminal(action.clone())),
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);
        let (tracer, trace) = enabled_trace("play the thing", false);

        let outcome = block_on(loop_.run_traced("play the thing", &trace));

        assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
        assert_eq!(
            trace_shape(&tracer),
            [
                "model_step:0:[]".to_string(),
                "gate:final_answer_verification:false:final_answer_nudged".to_string(),
                "model_step:1:[play_music]".to_string(),
                "tool_call:1:play_music:true:terminal".to_string(),
                format!("terminal:{}:0", native_actions::PLAY_MUSIC),
            ]
        );

        let record = tracer.finish().expect("record");
        let TraceEvent::GateDecision { shape, .. } = &record.events[1] else {
            panic!("expected the refusal to be a gate decision");
        };
        assert_eq!(
            shape,
            &[
                ("iteration".to_string(), 0),
                ("answer_chars".to_string(), 19),
            ],
            "a refusal must carry the shape it judged, not just the verdict"
        );
        assert!(
            record
                .events
                .iter()
                .all(|event| !format!("{event:?}").contains("Here are the songs")),
            "content capture is off, so no free text may be recorded"
        );
    }

    /// A backend failure must record which way it was classified: a permanent
    /// fault declining immediately and a transient one buying a grace answer
    /// are the same spoken outcome and completely different bugs.
    #[test]
    fn a_backend_failure_records_its_retryable_classification_and_decline() {
        // A permanent fault, worded exactly as the provider layer emits it.
        const KEY_ERROR: &str =
            "There's a problem with the API key configuration. Please check the server settings.";
        let backend = ScriptedBackend::new(vec![Err(KEY_ERROR.into())]);
        let tools = ScriptedTools::new(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);
        let (tracer, trace) = enabled_trace("what's the weather", true);

        let outcome = block_on(loop_.run_traced("what's the weather", &trace));

        assert!(matches!(outcome, ChatTurnOutcome::Decline(_)));
        assert_eq!(
            trace_shape(&tracer),
            [
                "note:backend_error_backend_other".to_string(),
                "gate:backend_step:false:permanent_backend_error".to_string(),
                "gate:decline:false:backend_unavailable".to_string(),
                format!("terminal:decline:{}", KEY_ERROR.chars().count()),
            ],
            "no model step is recorded for a call that never returned one"
        );

        let record = tracer.finish().expect("record");
        let TraceEvent::Terminal { spoken_text, .. } = record.events.last().expect("terminal")
        else {
            panic!("expected a terminal");
        };
        assert_eq!(
            spoken_text.as_deref(),
            Some(KEY_ERROR),
            "the trace must hold what the wearer actually heard"
        );
        let TraceEvent::GateDecision { shape, .. } = &record.events[1] else {
            panic!("expected the classification to be a gate decision");
        };
        assert_eq!(
            shape
                .iter()
                .map(|(key, value)| (key.as_str(), *value))
                .filter(|(key, _)| *key != "latency_ms")
                .collect::<Vec<_>>(),
            [("iteration", 0), ("retryable", 0)],
            "a permanent fault must be recorded as not retryable",
        );
    }

    #[test]
    fn cancelling_a_pending_run_does_not_fabricate_a_terminal_trace() {
        struct PendingBackend(std::sync::atomic::AtomicUsize);
        impl LlmBackend for PendingBackend {
            fn chat<'a>(&'a self, _request: crate::llm::LlmChatRequest) -> LlmFuture<'a> {
                Box::pin(async { Err("unused".to_string()) })
            }

            fn tool_step<'a>(&'a self, _request: ToolStepRequest) -> ToolStepFuture<'a> {
                Box::pin(std::future::pending::<Result<ToolStepResult, String>>())
            }

            fn finish_tool_session(&self, _correlation: &str) {
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }

        let backend = PendingBackend(std::sync::atomic::AtomicUsize::new(0));
        let tools = ScriptedTools::new(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);

        let (timed_out, events) = capture_physical_trace(|| {
            block_on(async {
                tokio::time::timeout(
                    Duration::from_millis(5),
                    loop_.run("wait on the pending provider"),
                )
                .await
            })
        });

        assert!(timed_out.is_err(), "the test must actually cancel the run");
        assert!(
            events.is_empty(),
            "a dropped future did not complete, so it cannot claim tool or terminal proof"
        );
        assert_eq!(
            backend.0.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "cancelling a run must retire its retained provider thread"
        );
    }

    fn run_loop(
        backend: &ScriptedBackend,
        tools: &ScriptedTools,
        cues: &dyn ChatTurnCueSink,
        max_iterations: usize,
    ) -> ChatTurnOutcome {
        run_loop_observed(backend, tools, cues, &NoopTurnObserver, max_iterations)
    }

    fn run_loop_observed(
        backend: &ScriptedBackend,
        tools: &ScriptedTools,
        cues: &dyn ChatTurnCueSink,
        observer: &dyn ChatTurnObserver,
        max_iterations: usize,
    ) -> ChatTurnOutcome {
        let loop_ = ChatTurnLoop {
            backend,
            tools,
            cues,
            observer,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(max_iterations),
        };
        block_on(loop_.run("do the thing"))
    }

    fn reading_tools(cue: Option<&str>) -> ScriptedTools {
        ScriptedTools::new(cue)
            .with(
                "knowledge_lookup",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "population 6M".into(),
                },
            )
            .with(
                "weather_lookup",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "12C and clear".into(),
                },
            )
            .with(
                "nearby_search",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "three cafes".into(),
                },
            )
    }

    // ---- every abnormal path must still SPEAK, never go silent ----
    //
    // Each of these maps to AgenticRuntimeOutcome::Decline (understand.rs), which
    // becomes a spoken response. A run that produced no outcome at all would
    // leave the user staring at a Pin that did nothing.

    #[test]
    fn an_empty_model_answer_declines_instead_of_speaking_nothing() {
        // The model returns whitespace/no text. Without this guard the user would
        // get an empty utterance, which reads on-device as "it ignored me".
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final("   ".into()))]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop(&backend, &tools, &cues, 4);

        assert!(
            matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
            "an empty model answer must still produce non-empty spoken text, got {outcome:?}"
        );
    }

    #[test]
    fn a_spent_time_budget_forces_the_grace_answer_instead_of_the_outer_timeout() {
        // The loop must convert its last slice into a tool-free answer built
        // from what was gathered. Previously the grace call was scheduled by
        // iteration index only, so a slow run never reached it: the outer
        // breaker fired mid-iteration and the user got a fixed apology while
        // every retrieved observation was thrown away.
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
            "Denmark has about 6 million people.".into(),
        ))]);
        let tools = reading_tools(Some("Working on it"));
        let cues = RecordingCues(Mutex::new(Vec::new()));
        // Budget already spent: the very next iteration must become the grace
        // call even though the iteration ceiling is nowhere near.
        let loop_ = ChatTurnLoop {
            backend: &backend,
            tools: &tools,
            cues: &cues,
            observer: &NoopTurnObserver,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(12).with_time_budget(Duration::from_millis(1)),
        };
        let outcome = block_on(loop_.run("how many people live in denmark"));

        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("Denmark has about 6 million people.".into())
        );
        // Exactly one model step: the run went straight to the grace answer
        // rather than burning iterations it had no time for.
        assert_eq!(backend.seen_message_counts.lock().unwrap().len(), 1);
        // Tools withheld on that step — the signature of the grace call.
        assert_eq!(backend.seen_tool_counts.lock().unwrap().as_slice(), &[0]);
        assert!(
            tools.executed.lock().unwrap().is_empty(),
            "the grace call withholds tools"
        );
    }

    #[test]
    fn a_model_step_is_clamped_to_the_budget_the_run_can_still_afford() {
        // The per-step timeout is a fixed circuit breaker sized for the slowest
        // provider path, so on its own it can exceed what is actually left and
        // overrun the whole-run breaker — which discards every observation
        // gathered. The clamp is what makes the grace reserve a real guarantee
        // rather than a nominal one, and it is what stops a future raise of a
        // nested provider deadline from silently busting this budget.
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final("Six million.".into())),
        ]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        // Per-step bound (30s) deliberately larger than the whole budget (10s).
        let loop_ = ChatTurnLoop {
            backend: &backend,
            tools: &tools,
            cues: &cues,
            observer: &NoopTurnObserver,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(30),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(6).with_time_budget(Duration::from_secs(10)),
        };
        let _ = block_on(loop_.run("how many people live in denmark"));

        let timeouts = backend.seen_timeouts.lock().unwrap().clone();
        assert!(!timeouts.is_empty(), "the run must have taken a step");
        for (index, seen) in timeouts.iter().enumerate() {
            assert!(
                *seen <= Duration::from_secs(10),
                "step {index} was handed {seen:?}, which exceeds the whole run \
                 budget of 10s; an unclamped step can overrun the outer breaker \
                 and throw away every observation gathered"
            );
        }
    }

    #[test]
    fn an_unbudgeted_run_still_gets_the_full_per_step_timeout() {
        // The clamp must only ever subtract time that a budget actually
        // withholds. With no budget configured there is nothing to clamp to,
        // and shortening the step there would be a silent regression.
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final("Six million.".into()))]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let _ = run_loop(&backend, &tools, &cues, 4);

        assert_eq!(
            backend.seen_timeouts.lock().unwrap().as_slice(),
            &[Duration::from_secs(5)]
        );
    }

    #[test]
    fn a_step_error_answers_from_gathered_observations_instead_of_declining() {
        // A transient provider hiccup after useful reads must not discard them —
        // declining there reads as flaky because retrying the same utterance
        // then succeeds.
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Err("connection reset".to_string()),
            Ok(ToolStepResult::Final(
                "Denmark has about 6 million people.".into(),
            )),
        ]);
        let tools = reading_tools(Some("Working on it"));
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop(&backend, &tools, &cues, 8);

        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("Denmark has about 6 million people.".into()),
            "the run must answer from the observation it already had"
        );
    }

    #[test]
    fn a_step_error_with_nothing_gathered_still_declines() {
        // No observations yet: there is nothing to answer from, so the honest
        // outcome is the spoken decline.
        let backend = ScriptedBackend::new(vec![Err("connection reset".to_string())]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop(&backend, &tools, &cues, 8);

        assert!(
            matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
            "got {outcome:?}"
        );
    }

    /// Drive the real loop with the bounded first-step retry stated explicitly.
    /// Never reads the process-wide runtime mirror, so these tests measure the
    /// flag and nothing else.
    fn run_loop_with_first_step_retry(
        backend: &ScriptedBackend,
        tools: &ScriptedTools,
        cues: &dyn ChatTurnCueSink,
        max_iterations: usize,
        first_step_retry: bool,
    ) -> ChatTurnOutcome {
        let loop_ = ChatTurnLoop {
            backend,
            tools,
            cues,
            observer: &NoopTurnObserver,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(max_iterations).with_first_step_retry(first_step_retry),
        };
        block_on(loop_.run("do the thing"))
    }

    #[test]
    fn the_first_step_retry_ships_off_and_a_failed_first_step_declines_at_once() {
        // Default-off means byte-for-byte today's behaviour: one step, one
        // decline. The second scripted step exists precisely so that consuming
        // it would be visible — if the flag ever leaked on, this goes red.
        let backend = ScriptedBackend::new(vec![
            Err("connection reset".to_string()),
            Ok(ToolStepResult::Final("Six million.".into())),
        ]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 4, false);

        assert!(
            matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
            "got {outcome:?}"
        );
        assert_eq!(
            backend.seen_message_counts.lock().unwrap().len(),
            1,
            "with the flag off the loop must not spend a second model step"
        );
        // The config default agrees with the explicit `false` above.
        assert!(
            !ChatTurnLoopConfig::new(4).first_step_retry,
            "an unconfigured process must not retry"
        );
    }

    #[test]
    fn an_armed_first_step_retry_re_issues_the_failed_step_exactly_once() {
        // The measured failure: the run's FIRST model step fails with a
        // transient fault, before any tool result exists, so the grace path
        // cannot fire and the turn declines faster than a correct answer would
        // have arrived. Asking again is what a wearer already does by hand.
        let backend = ScriptedBackend::new(vec![
            Err("connection reset".to_string()),
            Ok(ToolStepResult::Final(
                "Denmark has about 6 million people.".into(),
            )),
        ]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 4, true);

        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("Denmark has about 6 million people.".into()),
        );
        let messages = backend.seen_messages.lock().unwrap().clone();
        assert_eq!(messages.len(), 2, "exactly one retry, never more");
        assert_eq!(
            messages[0], messages[1],
            "a failed step appends nothing, so the retry must re-issue the identical request"
        );
        // Tools still offered on the retry: it is another attempt at the first
        // step, not the tool-free grace call (which offers zero).
        assert_eq!(backend.seen_tool_counts.lock().unwrap().as_slice(), &[1, 1]);
    }

    #[test]
    fn a_permanent_first_step_fault_is_never_retried_even_when_armed() {
        // A bad key fails identically forever. Retrying it only spends the
        // wearer's wall clock to reach the same answer later, so the
        // permanent-vs-retryable split must gate the retry exactly as it gates
        // the grace path.
        for permanent in [
            "There's a problem with the API key configuration. Please check the server settings.",
            "The configured AI model wasn't found. Please check the server settings.",
            "The AI service declined to answer that. Try rephrasing your question.",
            "the configured model backend does not support the tool-step loop",
        ] {
            let backend = ScriptedBackend::new(vec![
                Err(permanent.to_string()),
                Ok(ToolStepResult::Final("Six million.".into())),
            ]);
            let tools = reading_tools(None);
            let cues = RecordingCues(Mutex::new(Vec::new()));

            let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 4, true);

            assert!(
                matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
                "{permanent} produced {outcome:?}"
            );
            assert_eq!(
                backend.seen_message_counts.lock().unwrap().len(),
                1,
                "a permanent fault must cost exactly one model step: {permanent}"
            );
        }
    }

    #[test]
    fn an_armed_first_step_retry_that_also_fails_declines_once_and_never_loops() {
        // The retry is a one-shot latch, not a counter. Two failures must end
        // the run: a third step would mean the flag can spend the whole
        // deadline re-asking, which is the failure mode a retry must not have.
        let backend = ScriptedBackend::new(vec![
            Err("connection reset".to_string()),
            Err("connection reset".to_string()),
            Ok(ToolStepResult::Final("Six million.".into())),
        ]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 8, true);

        assert!(
            matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
            "got {outcome:?}"
        );
        assert_eq!(
            backend.seen_message_counts.lock().unwrap().len(),
            2,
            "exactly one retry: the scripted answer after it must stay unreached"
        );
    }

    #[test]
    fn an_armed_first_step_retry_does_not_spend_an_iteration_of_the_budget() {
        // The retry re-enters at the same iteration index, so the tool-free
        // grace call stays reachable. With a 2-iteration budget: step 0 fails,
        // step 0 is retried and calls a tool, and iteration 1 is still the
        // grace call that produces the spoken answer.
        let backend = ScriptedBackend::new(vec![
            Err("connection reset".to_string()),
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final("Six million.".into())),
        ]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 2, true);

        assert_eq!(outcome, ChatTurnOutcome::Answer("Six million.".into()));
        assert_eq!(
            tools.executed.lock().unwrap().as_slice(),
            &["knowledge_lookup"],
            "the retried first step still gets a tool-capable iteration"
        );
        assert_eq!(
            backend.seen_tool_counts.lock().unwrap().as_slice(),
            &[1, 1, 0],
            "the last step withholds tools, so the grace call survived the retry"
        );
    }

    #[test]
    fn an_armed_first_step_retry_leaves_the_later_step_grace_path_alone() {
        // A later step that fails after real observations must keep answering
        // from them, exactly as before: the grace path is checked first and the
        // retry latch is never touched.
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Err("connection reset".to_string()),
            Ok(ToolStepResult::Final(
                "Denmark has about 6 million people.".into(),
            )),
        ]);
        let tools = reading_tools(Some("Working on it"));
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 8, true);

        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("Denmark has about 6 million people.".into()),
        );
        assert_eq!(
            backend.seen_tool_counts.lock().unwrap().as_slice(),
            &[1, 1, 0],
            "the recovery was the tool-free grace answer, not a re-issued step"
        );
    }

    #[test]
    fn a_fast_model_step_never_fires_the_slow_step_cue() {
        // Fast turns must keep their original single-cue cadence — an extra cue
        // there would double-speak moments before the answer.
        struct CountingObserver(std::sync::atomic::AtomicUsize);
        impl ChatTurnObserver for CountingObserver {
            fn on_slow_step(&self) {
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final(
                "Denmark has about 6 million people.".into(),
            )),
        ]);
        let tools = reading_tools(Some("Working on it"));
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = CountingObserver(std::sync::atomic::AtomicUsize::new(0));

        let outcome = run_loop_observed(&backend, &tools, &cues, &observer, 8);

        assert!(matches!(outcome, ChatTurnOutcome::Answer(_)));
        assert_eq!(
            observer.0.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "a scripted (instant) step must not be treated as slow"
        );
    }

    #[test]
    fn the_slow_step_threshold_sits_above_normal_model_latency() {
        // Measured on-device steps were 2.8s-14.8s. The threshold must clear the
        // common case (so normal turns are untouched) while still firing well
        // before the observed 14.8s outlier that left the user in silence.
        assert!(SLOW_STEP_CUE_AFTER >= Duration::from_secs(6));
        assert!(SLOW_STEP_CUE_AFTER < Duration::from_secs(14));
    }

    #[test]
    fn tool_call_markup_is_never_spoken_aloud() {
        // A malformed or truncated tool-call block must not reach the speaker.
        // Without this guard the Pin narrates raw JSON ("less-than tool
        // underscore call...") and saves it into conversation history.
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
            "<tool_call>{\"name\":\"knowledge_lookup\",\"argum".into(),
        ))]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop(&backend, &tools, &cues, 4);

        match outcome {
            ChatTurnOutcome::Decline(text) => {
                assert!(!text.contains("<tool_call>"), "markup leaked into speech");
                assert!(!text.trim().is_empty(), "the decline must still speak");
            }
            other => panic!("tool-call markup must never be spoken, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_tool_call_batch_declines_rather_than_spinning() {
        // The model asks for tools but names none: no progress is possible, so
        // the run must end immediately rather than burn the whole 80s budget.
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(Vec::new()))]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop(&backend, &tools, &cues, 8);

        assert!(
            matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
            "an empty tool batch must decline with spoken text, got {outcome:?}"
        );
        assert!(
            tools.executed.lock().unwrap().is_empty(),
            "no tool should run for an empty batch"
        );
    }

    #[test]
    fn a_model_that_only_ever_calls_tools_still_terminates_with_speech() {
        // Worst case for a wearable: the model never answers, just keeps
        // requesting tools. The iteration budget (plus the tool-free grace call)
        // must end the run with something spoken rather than running to the
        // whole-turn deadline and timing out.
        let mut steps = Vec::new();
        for _ in 0..12 {
            steps.push(Ok(ToolStepResult::ToolCalls(vec![call(
                "knowledge_lookup",
            )])));
        }
        let backend = ScriptedBackend::new(steps);
        let tools = reading_tools(Some("Working on it"));
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop(&backend, &tools, &cues, 4);

        assert!(
            matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
            "a never-answering model must still terminate with spoken text, got {outcome:?}"
        );
        // Bounded work: the budget, not the transcript, decides when to stop.
        let steps_taken = backend.seen_message_counts.lock().unwrap().len();
        assert!(
            steps_taken <= 6,
            "a 4-iteration budget must not run away ({steps_taken} model steps)"
        );
    }

    #[test]
    fn multi_step_tool_run_executes_each_replanned_call_in_order_and_answers() {
        // The core multi-tool shape: tool -> observation -> tool -> observation
        // -> tool -> observation -> answer, across three model steps.
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::ToolCalls(vec![call("weather_lookup")])),
            Ok(ToolStepResult::ToolCalls(vec![call("nearby_search")])),
            Ok(ToolStepResult::Final("All three answered.".into())),
        ]);
        let tools = reading_tools(Some("Working on it"));
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let turns = RecordingTurns::default();

        let outcome = run_loop_observed(&backend, &tools, &cues, &turns, 8);

        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("All three answered.".into())
        );
        assert_eq!(
            tools.executed.lock().unwrap().as_slice(),
            &["knowledge_lookup", "weather_lookup", "nearby_search"],
            "every replanned call must execute, in order"
        );
        // One paired action/observation turn per selected call, in order.
        assert_eq!(
            turns.0.lock().unwrap().as_slice(),
            &[
                "start:knowledge_lookup",
                "end:knowledge_lookup:true",
                "start:weather_lookup",
                "end:weather_lookup:true",
                "start:nearby_search",
                "end:nearby_search:true",
            ]
        );
        // One cue per selected call reaches only the ephemeral side channel.
        assert_eq!(cues.0.lock().unwrap().len(), 3);
        // Each step saw a strictly larger transcript: no earlier tool result was
        // dropped, which is what keeps later batches grounded in earlier ones.
        let seen = backend.seen_message_counts.lock().unwrap().clone();
        assert_eq!(seen.len(), 4, "four model steps: {seen:?}");
        assert!(
            seen.windows(2).all(|w| w[1] > w[0]),
            "transcript must grow monotonically across steps: {seen:?}"
        );
    }

    #[test]
    fn cue_prose_never_enters_provider_messages_or_tool_history() {
        const EPHEMERAL_CUE: &str = "EPHEMERAL_CUE_MUST_NOT_ENTER_CONTEXT";
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final("Finished.".into())),
        ]);
        let tools = reading_tools(Some(EPHEMERAL_CUE));
        let cues = RecordingCueEvents(Mutex::new(Vec::new()));

        let outcome = run_loop(&backend, &tools, &cues, 4);

        assert_eq!(outcome, ChatTurnOutcome::Answer("Finished.".into()));
        assert_eq!(
            cues.0.lock().unwrap().as_slice(),
            &[(
                "corr".to_string(),
                "knowledge_lookup".to_string(),
                EPHEMERAL_CUE.to_string(),
            )],
            "the cue side channel must carry its run and selected operation"
        );
        for provider_step in backend.seen_messages.lock().unwrap().iter() {
            assert!(
                !format!("{provider_step:?}").contains(EPHEMERAL_CUE),
                "cue prose entered provider/model context"
            );
        }
    }

    #[test]
    fn independent_read_siblings_execute_concurrently_before_one_replan() {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![
                call("alpha_read"),
                call("beta_read"),
            ])),
            Ok(ToolStepResult::Final("Both checked.".into())),
        ]);
        let tools = BarrierReads::new();
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let turns = RecordingTurns::default();
        let loop_ = ChatTurnLoop {
            backend: &backend,
            tools: &tools,
            cues: &cues,
            observer: &turns,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(4),
        };

        let outcome = block_on(async {
            tokio::time::timeout(Duration::from_secs(1), loop_.run("check both"))
                .await
                .expect("parallel reads must not deadlock")
        });

        assert_eq!(outcome, ChatTurnOutcome::Answer("Both checked.".into()));
        let mut executed = tools.executed.lock().unwrap().clone();
        executed.sort();
        assert_eq!(executed, ["alpha_read", "beta_read"]);
        assert_eq!(
            turns.0.lock().unwrap().as_slice(),
            &["start:alpha_read", "end:alpha_read:true"],
            "one observer batch surrounds both independent reads"
        );

        let seen = backend.seen_messages.lock().unwrap();
        assert_eq!(
            transcript_tool_call_names(&seen[1]),
            vec!["alpha_read".to_string(), "beta_read".to_string()]
        );
        assert_eq!(
            transcript_tool_result_ids(&seen[1]),
            vec!["alpha_read-1".to_string(), "beta_read-1".to_string()]
        );
    }

    #[test]
    fn read_and_mutation_siblings_execute_one_at_a_time_after_replanning() {
        // A provider proposes a read and a terminal mutation together. Only the
        // read may run; the mutation must be proposed again after the real read
        // observation before it can reach typed validation and dispatch.
        let action = ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.into(),
            arguments: serde_json::json!({"Track":"T","Artist":"A"}),
        };
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![
                call("knowledge_lookup"),
                call("play_music"),
            ])),
            Ok(ToolStepResult::ToolCalls(vec![
                call("play_music"),
                call("nearby_search"),
            ])),
        ]);
        let tools = reading_tools(Some("Working on it"))
            .with("play_music", ToolExecutionOutcome::Terminal(action.clone()));
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let turns = RecordingTurns::default();

        let outcome = run_loop_observed(&backend, &tools, &cues, &turns, 8);

        assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
        assert_eq!(
            tools.executed.lock().unwrap().as_slice(),
            &["knowledge_lookup", "play_music"],
            "only the first call from each model step may execute"
        );
        assert_eq!(
            turns.0.lock().unwrap().as_slice(),
            &[
                "start:knowledge_lookup",
                "end:knowledge_lookup:true",
                "start:play_music",
            ],
            "observer events must follow only the selected call"
        );
        assert_eq!(cues.0.lock().unwrap().len(), 2);
        assert_eq!(
            tools.cue_requests.lock().unwrap().as_slice(),
            &[
                vec!["knowledge_lookup".to_string()],
                vec!["play_music".to_string()],
            ],
            "cue selection must not include unexecuted siblings"
        );

        // The replanning request contains exactly the selected assistant call
        // and its real result. The unexecuted mutation sibling never acquired
        // an unresolved assistant call ID in the transcript.
        let seen = backend.seen_messages.lock().unwrap();
        assert_eq!(
            transcript_tool_call_names(&seen[1]),
            vec!["knowledge_lookup".to_string()]
        );
        assert_eq!(
            transcript_tool_result_ids(&seen[1]),
            vec!["knowledge_lookup-1".to_string()]
        );
    }

    #[test]
    fn a_failed_selected_call_is_observed_before_a_sibling_can_be_replanned() {
        // A failed first call becomes the only observation from its model step.
        // A sibling can run only if the model proposes it again on the next
        // step, after seeing the real `[TOOL_ERROR]` result.
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![
                call("weather_lookup"),
                call("nearby_search"),
            ])),
            Ok(ToolStepResult::ToolCalls(vec![
                call("nearby_search"),
                call("knowledge_lookup"),
            ])),
            Ok(ToolStepResult::Final("Partial but useful.".into())),
        ]);
        let tools = reading_tools(Some("Working on it")).with(
            "weather_lookup",
            ToolExecutionOutcome::Observation {
                ok: false,
                content: "weather provider unavailable".into(),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let turns = RecordingTurns::default();

        let outcome = run_loop_observed(&backend, &tools, &cues, &turns, 8);

        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("Partial but useful.".into())
        );
        assert_eq!(
            tools.executed.lock().unwrap().as_slice(),
            &["weather_lookup", "nearby_search"],
            "the failed step's sibling must wait for a fresh proposal"
        );
        assert_eq!(
            turns.0.lock().unwrap().as_slice(),
            &[
                "start:weather_lookup",
                "end:weather_lookup:false",
                "start:nearby_search",
                "end:nearby_search:true",
            ],
            "each selected call reports its own real outcome"
        );
        assert_eq!(
            tools.cue_requests.lock().unwrap().as_slice(),
            &[
                vec!["weather_lookup".to_string()],
                vec!["nearby_search".to_string()],
            ]
        );

        let seen = backend.seen_messages.lock().unwrap();
        assert_eq!(
            transcript_tool_call_names(&seen[1]),
            vec!["weather_lookup".to_string()]
        );
        assert_eq!(
            transcript_tool_result_ids(&seen[1]),
            vec!["weather_lookup-1".to_string()]
        );
        assert_eq!(
            transcript_tool_result_texts(&seen[1]),
            vec![format!(
                "{TOOL_STEP_ERROR_PREFIX} weather provider unavailable"
            )]
        );
        assert_eq!(
            transcript_tool_call_names(&seen[2]),
            vec!["weather_lookup".to_string(), "nearby_search".to_string()],
            "only calls selected across successive steps enter the transcript"
        );
    }

    #[test]
    fn read_then_answer_produces_the_final_answer() {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final(
                "Denmark has about 6 million people.".into(),
            )),
        ]);
        let tools = ScriptedTools::new(Some("Looking up the answer")).with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "population 6M".into(),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let outcome = run_loop(&backend, &tools, &cues, 4);
        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("Denmark has about 6 million people.".into())
        );
        // A cue fired for the read batch.
        assert_eq!(
            cues.0.lock().unwrap().as_slice(),
            &["Looking up the answer"]
        );
    }

    #[test]
    fn failed_read_becomes_an_observation_and_the_model_recovers() {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            // Model tries again, this time answers from a second read result.
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final("Here is the answer.".into())),
        ]);
        let tools = ScriptedTools::new(None).with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: false,
                content: "unavailable".into(),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        // A failed read never terminates the run; the model gets [TOOL_ERROR]
        // observations and can keep going.
        let outcome = run_loop(&backend, &tools, &cues, 5);
        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("Here is the answer.".into())
        );
    }

    #[test]
    fn mutation_tool_terminates_into_a_native_action() {
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
            "play_music",
        )]))]);
        let action = ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.into(),
            arguments: serde_json::json!({"Track":"Smooth Criminal","Artist":"Michael Jackson"}),
        };
        let tools = ScriptedTools::new(None)
            .with("play_music", ToolExecutionOutcome::Terminal(action.clone()));
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let outcome = run_loop(&backend, &tools, &cues, 4);
        assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
    }

    #[test]
    fn budget_exhaustion_forces_a_tool_free_grace_call() {
        // The model keeps calling tools; on the final (grace) iteration tools
        // are withheld so it must answer.
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final("Best effort answer.".into())),
        ]);
        let tools = ScriptedTools::new(None).with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "partial".into(),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let outcome = run_loop(&backend, &tools, &cues, 2);
        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("Best effort answer.".into())
        );
        // The grace (2nd) step must have been offered zero tools.
        let counts = backend.seen_tool_counts.lock().unwrap().clone();
        assert_eq!(counts.len(), 2);
        assert!(counts[0] > 0, "first step advertises tools");
        assert_eq!(counts[1], 0, "grace step withholds tools");
    }

    #[test]
    fn a_ready_deterministic_action_dispatches_without_spending_a_nudge_round_trip() {
        // The nudge exists to give the model a retry. When the deterministic
        // completion ALREADY holds a validated candidate, that retry cannot
        // improve the outcome — it can only reach the same action one model
        // round-trip later, and a round-trip measured 2.8-14.8s on device.
        //
        // Both hooks return `Some` here, which is the ambiguous case: the loop
        // must prefer the action it can already dispatch.
        struct ReadyTools(ScriptedTools);
        #[tonic::async_trait]
        impl ToolCatalog for ReadyTools {
            fn catalog(&self) -> Vec<ToolStepDefinition> {
                self.0.catalog()
            }
            fn cue_for(&self, names: &[&str]) -> Option<String> {
                self.0.cue_for(names)
            }
            async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
                self.0.execute(call).await
            }
            fn final_answer_nudge(&self, _final_answer: &str) -> Option<String> {
                Some("Call play_music now.".to_string())
            }
            fn forced_terminal_action(&self, _final_answer: &str) -> Option<ValidatedNativeAction> {
                Some(ValidatedNativeAction {
                    action: native_actions::PLAY_MUSIC.into(),
                    arguments: serde_json::json!({"Track":"T","Artist":"A"}),
                })
            }
        }
        // Exactly ONE step is scripted. If the loop still spent a nudge
        // round-trip it would ask for a second step and not find one.
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
            "Here are the songs.".into(),
        ))]);
        let tools = ReadyTools(ScriptedTools::new(None));
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let loop_ = ChatTurnLoop {
            backend: &backend,
            tools: &tools,
            cues: &cues,
            observer: &NoopTurnObserver,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(4),
        };
        let outcome = block_on(loop_.run("play the thing"));
        assert_eq!(
            outcome,
            ChatTurnOutcome::NativeAction(ValidatedNativeAction {
                action: native_actions::PLAY_MUSIC.into(),
                arguments: serde_json::json!({"Track":"T","Artist":"A"}),
            })
        );
        assert_eq!(
            backend.seen_tool_counts.lock().unwrap().len(),
            1,
            "the ready action must dispatch on the first final, not after a nudge"
        );
    }

    #[test]
    fn an_artist_scoped_observation_completes_without_waiting_for_a_final_answer() {
        // `.144` measured ~3 searches before the model emitted any final, with
        // the deterministic completion waiting on that final. Once the
        // artist-scoped search has answered and a validated candidate exists,
        // there is nothing left to decide.
        struct ReadyTools(ScriptedTools);
        #[tonic::async_trait]
        impl ToolCatalog for ReadyTools {
            fn catalog(&self) -> Vec<ToolStepDefinition> {
                self.0.catalog()
            }
            fn cue_for(&self, names: &[&str]) -> Option<String> {
                self.0.cue_for(names)
            }
            async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
                self.0.execute(call).await
            }
            fn forced_terminal_action(&self, _final_answer: &str) -> Option<ValidatedNativeAction> {
                Some(ValidatedNativeAction {
                    action: native_actions::PLAY_MUSIC.into(),
                    arguments: serde_json::json!({"Track":"T","Artist":"A"}),
                })
            }
        }
        // A generic catalog search runs first and must NOT short-circuit: `.141`
        // established artist-scoped results are the preferred source, and
        // completing on a generic hit trades latency for the wrong song.
        // Only the artist-scoped observation may complete the turn.
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call(
                "music_catalog_search",
            )])),
            Ok(ToolStepResult::ToolCalls(vec![call(
                "music_artist_top_tracks",
            )])),
        ]);
        let tools = ReadyTools(
            ScriptedTools::new(None)
                .with(
                    "music_catalog_search",
                    ToolExecutionOutcome::Observation {
                        ok: true,
                        content: "generic hits".into(),
                    },
                )
                .with(
                    "music_artist_top_tracks",
                    ToolExecutionOutcome::Observation {
                        ok: true,
                        content: "top tracks".into(),
                    },
                ),
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let loop_ = ChatTurnLoop {
            backend: &backend,
            tools: &tools,
            cues: &cues,
            observer: &NoopTurnObserver,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(6),
        };
        let outcome = block_on(loop_.run("play Some Artist's most popular song"));
        assert_eq!(
            outcome,
            ChatTurnOutcome::NativeAction(ValidatedNativeAction {
                action: native_actions::PLAY_MUSIC.into(),
                arguments: serde_json::json!({"Track":"T","Artist":"A"}),
            })
        );
        assert_eq!(
            tools.0.executed.lock().unwrap().as_slice(),
            &["music_catalog_search", "music_artist_top_tracks"],
            "the generic search must not short-circuit; the artist-scoped one must"
        );
        assert_eq!(
            backend.seen_tool_counts.lock().unwrap().len(),
            2,
            "no further model step may be spent once the candidate is ready"
        );
    }

    #[test]
    fn an_identical_repeated_read_executes_once_but_changed_arguments_re_execute() {
        // Measured on device: playing one song issued ~4.3 catalog lookups,
        // many byte-identical. Each was a fresh network round-trip.
        let repeated = |args: serde_json::Value| ToolStepCall {
            call_id: "knowledge_lookup-1".to_string(),
            name: "knowledge_lookup".to_string(),
            arguments: args,
        };
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![repeated(
                serde_json::json!({"query": "denmark", "limit": 5}),
            )])),
            // Same pair, different key order: the same request, so it must be
            // served from the memo rather than re-fetched.
            Ok(ToolStepResult::ToolCalls(vec![repeated(
                serde_json::json!({"limit": 5, "query": "denmark"}),
            )])),
            // A genuinely different argument must NOT be served from the memo.
            Ok(ToolStepResult::ToolCalls(vec![repeated(
                serde_json::json!({"query": "sweden", "limit": 5}),
            )])),
            Ok(ToolStepResult::Final("Population is 6M.".into())),
        ]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop(&backend, &tools, &cues, 8);

        assert_eq!(outcome, ChatTurnOutcome::Answer("Population is 6M.".into()));
        assert_eq!(
            tools.executed.lock().unwrap().as_slice(),
            &["knowledge_lookup", "knowledge_lookup"],
            "the identical repeat is replayed; the changed query re-executes"
        );
    }

    #[test]
    fn verification_gate_rejects_one_final_and_the_model_completes_the_mutation() {
        struct NudgingTools(ScriptedTools);
        #[tonic::async_trait]
        impl ToolCatalog for NudgingTools {
            fn catalog(&self) -> Vec<ToolStepDefinition> {
                self.0.catalog()
            }
            fn cue_for(&self, names: &[&str]) -> Option<String> {
                self.0.cue_for(names)
            }
            async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
                self.0.execute(call).await
            }
            fn final_answer_nudge(&self, _final_answer: &str) -> Option<String> {
                Some("Call play_music now.".to_string())
            }
        }
        let action = ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.into(),
            arguments: serde_json::json!({"Track":"T","Artist":"A"}),
        };
        let backend = ScriptedBackend::new(vec![
            // Model tries to end with text; the gate rejects once.
            Ok(ToolStepResult::Final("Here are the songs.".into())),
            // After the nudge it completes the mutation.
            Ok(ToolStepResult::ToolCalls(vec![call("play_music")])),
        ]);
        let tools = NudgingTools(
            ScriptedTools::new(None)
                .with("play_music", ToolExecutionOutcome::Terminal(action.clone())),
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let loop_ = ChatTurnLoop {
            backend: &backend,
            tools: &tools,
            cues: &cues,
            observer: &NoopTurnObserver,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(4),
        };
        let outcome = block_on(loop_.run("play the thing"));
        assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
        // A second text final after the nudge is accepted (gate is one-shot):
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::Final("Here are the songs.".into())),
            Ok(ToolStepResult::Final("I cannot play that.".into())),
        ]);
        let tools = NudgingTools(ScriptedTools::new(None));
        let loop_ = ChatTurnLoop {
            backend: &backend,
            tools: &tools,
            cues: &cues,
            observer: &NoopTurnObserver,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(4),
        };
        let outcome = block_on(loop_.run("play the thing"));
        assert_eq!(
            outcome,
            ChatTurnOutcome::Answer("I cannot play that.".into())
        );
    }

    #[test]
    fn backend_error_declines_gracefully() {
        let backend = ScriptedBackend::new(vec![Err("timed out".into())]);
        let tools = ScriptedTools::new(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let outcome = run_loop(&backend, &tools, &cues, 4);
        assert!(matches!(outcome, ChatTurnOutcome::Decline(_)));
    }

    #[test]
    fn preflight_stops_the_loop_for_a_device_observation() {
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
            "current_location",
        )]))]);
        let tools = ScriptedTools::new(None).with(
            "current_location",
            ToolExecutionOutcome::Preflight {
                action: native_actions::GET_CURRENT_LOCATION.into(),
                arguments: serde_json::json!({}),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let outcome = run_loop(&backend, &tools, &cues, 4);
        assert!(matches!(outcome, ChatTurnOutcome::Preflight { .. }));
    }

    // ---- suspension/resume (streaming in-session continuation) ----

    fn suspendable_loop<'a>(
        backend: &'a ScriptedBackend,
        tools: &'a ScriptedTools,
        cues: &'a RecordingCues,
        max_iterations: usize,
    ) -> ChatTurnLoop<'a> {
        suspendable_loop_observed(backend, tools, cues, &NoopTurnObserver, max_iterations)
    }

    fn suspendable_loop_observed<'a>(
        backend: &'a ScriptedBackend,
        tools: &'a ScriptedTools,
        cues: &'a RecordingCues,
        observer: &'a dyn ChatTurnObserver,
        max_iterations: usize,
    ) -> ChatTurnLoop<'a> {
        ChatTurnLoop {
            backend,
            tools,
            cues,
            observer,
            system_prompt: "sys".to_string(),
            timeout: Duration::from_secs(5),
            correlation: "corr".to_string(),
            config: ChatTurnLoopConfig::new(max_iterations),
        }
    }

    /// Multi-tool across a device round-trip: read -> device preflight ->
    /// (device answers) -> further reads -> answer. This is the shape a real
    /// "what's near me" turn takes, and nothing from before the suspension may
    /// be lost when planning continues.
    #[test]
    fn a_device_round_trip_mid_run_resumes_into_further_tool_batches() {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::ToolCalls(vec![call("current_location")])),
        ]);
        let tools = reading_tools(Some("Working on it")).with(
            "current_location",
            ToolExecutionOutcome::Preflight {
                action: native_actions::GET_CURRENT_LOCATION.into(),
                arguments: serde_json::json!({}),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let turns = RecordingTurns::default();
        let loop_ = suspendable_loop_observed(&backend, &tools, &cues, &turns, 8);

        let (outcome, suspension) = block_on(loop_.run_suspendable("what's near me"));
        assert!(
            matches!(outcome, ChatTurnOutcome::Preflight { ref action, .. } if action == native_actions::GET_CURRENT_LOCATION),
            "the device action must interrupt the run"
        );
        let suspension = suspension.expect("a preflight must carry its suspension");
        // The completed first batch streamed its pair; the interrupted batch
        // announced itself but has no observation yet (it is still pending).
        assert_eq!(
            turns.0.lock().unwrap().as_slice(),
            &[
                "start:knowledge_lookup",
                "end:knowledge_lookup:true",
                "start:current_location",
            ]
        );

        // Continuation: the device fix is now available and the model runs a
        // FURTHER tool batch before answering.
        let resumed_backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("nearby_search")])),
            Ok(ToolStepResult::Final("Three cafes near you.".into())),
        ]);
        let resumed_tools = reading_tools(Some("Working on it")).with(
            "current_location",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: r#"{"status":"ok","latitude":55.7,"longitude":12.6}"#.into(),
            },
        );
        let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
        let resumed_turns = RecordingTurns::default();
        let resumed_loop = suspendable_loop_observed(
            &resumed_backend,
            &resumed_tools,
            &resumed_cues,
            &resumed_turns,
            8,
        );

        let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));

        assert_eq!(
            resumed,
            ChatTurnOutcome::Answer("Three cafes near you.".into()),
            "the resumed run must finish the multi-tool plan"
        );
        assert!(next_suspension.is_none(), "the resumed run completed");
        assert_eq!(
            resumed_tools.executed.lock().unwrap().as_slice(),
            &["current_location", "nearby_search"],
            "the interrupted call is retried, then planning continues with more tools"
        );
        // Post-resume batches keep streaming cue pairs, so progress keeps
        // rendering after the device round-trip instead of going silent. The
        // retried pending call deliberately does NOT re-announce a batch: its
        // cue already fired before the suspension, so re-announcing it would
        // speak the same progress twice.
        assert_eq!(
            resumed_turns.0.lock().unwrap().as_slice(),
            &["start:nearby_search", "end:nearby_search:true"],
            "only genuinely new batches announce after a resume"
        );
        // The resumed planning step inherited the pre-suspension transcript
        // rather than starting a fresh plan.
        let seen = resumed_backend.seen_message_counts.lock().unwrap().clone();
        assert!(
            seen[0] >= 4,
            "resumed planning must retain the pre-suspension transcript: {seen:?}"
        );
    }

    fn location_preflight_tools() -> ScriptedTools {
        ScriptedTools::new(Some("Checking location")).with(
            "current_location",
            ToolExecutionOutcome::Preflight {
                action: native_actions::GET_CURRENT_LOCATION.into(),
                arguments: serde_json::json!({}),
            },
        )
    }

    /// The full streaming continuation: action -> device observation ->
    /// resumed planning -> final answer, without a fresh re-plan.
    #[test]
    fn preflight_suspension_resumes_in_session_and_answers() {
        // First turn: the model asks for the current location; the tools have
        // no device fix yet, so the run suspends into a preflight.
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
            "current_location",
        )]))]);
        let tools = location_preflight_tools();
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let loop_ = suspendable_loop(&backend, &tools, &cues, 4);
        let (outcome, suspension) = block_on(loop_.run_suspendable("what's the weather here"));
        assert!(
            matches!(outcome, ChatTurnOutcome::Preflight { ref action, .. } if action == native_actions::GET_CURRENT_LOCATION)
        );
        let suspension = suspension.expect("a preflight must carry its suspension");

        // Continuation turn: a fresh loop instance (new tools now grounded
        // with the validated device observation) resumes the transcript.
        let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
            "It's sunny at your location.".into(),
        ))]);
        let resumed_tools = ScriptedTools::new(Some("Checking location")).with(
            "current_location",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: r#"{"status":"ok","latitude":55.7,"longitude":12.6}"#.into(),
            },
        );
        let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
        let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 4);
        let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));
        assert_eq!(
            resumed,
            ChatTurnOutcome::Answer("It's sunny at your location.".into())
        );
        assert!(next_suspension.is_none());
        // The interrupted call was answered from the transcript, not re-cued.
        assert!(resumed_cues.0.lock().unwrap().is_empty());
        // The resumed model step saw the preserved transcript: initial user
        // turn + assistant tool-call turn + the pending call's tool result.
        assert_eq!(
            resumed_backend
                .seen_message_counts
                .lock()
                .unwrap()
                .as_slice(),
            &[3]
        );
        // The pending call was re-executed against the grounded tools.
        assert_eq!(
            resumed_tools.executed.lock().unwrap().as_slice(),
            &["current_location".to_string()]
        );
    }

    /// action -> observation re-entry -> next (terminal) native action.
    #[test]
    fn resumed_run_can_terminate_into_a_native_action() {
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
            "current_location",
        )]))]);
        let tools = location_preflight_tools();
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let loop_ = suspendable_loop(&backend, &tools, &cues, 5);
        let (_, suspension) = block_on(loop_.run_suspendable("play something nearby-themed"));
        let suspension = suspension.expect("preflight suspension");

        let action = ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.into(),
            arguments: serde_json::json!({"Track":"Here Comes the Sun","Artist":"The Beatles"}),
        };
        let resumed_backend =
            ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
                "play_music",
            )]))]);
        let resumed_tools = ScriptedTools::new(None)
            .with(
                "current_location",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: r#"{"status":"ok"}"#.into(),
                },
            )
            .with("play_music", ToolExecutionOutcome::Terminal(action.clone()));
        let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
        let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 5);
        let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));
        assert_eq!(resumed, ChatTurnOutcome::NativeAction(action));
        assert!(next_suspension.is_none());
    }

    /// A continuation whose observation still cannot ground the read must not
    /// ping-pong the same call back to the device: it becomes a `[TOOL_ERROR]`
    /// observation and the model concludes from the transcript.
    #[test]
    fn resume_with_still_missing_observation_feeds_tool_error_and_answers() {
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
            "current_location",
        )]))]);
        let tools = location_preflight_tools();
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let loop_ = suspendable_loop(&backend, &tools, &cues, 4);
        let (_, suspension) = block_on(loop_.run_suspendable("where am I"));
        let suspension = suspension.expect("preflight suspension");

        // The resumed tools STILL cannot ground the read (no location).
        let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
            "I couldn't get your location.".into(),
        ))]);
        let resumed_tools = location_preflight_tools();
        let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
        let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 4);
        let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));
        assert_eq!(
            resumed,
            ChatTurnOutcome::Answer("I couldn't get your location.".into())
        );
        assert!(
            next_suspension.is_none(),
            "a re-preflight of the interrupted call must not re-suspend"
        );
    }

    /// The suspension preserves the run's iteration budget: a resume never
    /// grants more model steps than the original circuit breaker allowed.
    #[test]
    fn resume_preserves_the_remaining_iteration_budget() {
        // max_iterations=2: the preflight consumes iteration 0, so the resumed
        // run has exactly the grace iteration left (tools withheld).
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
            "current_location",
        )]))]);
        let tools = location_preflight_tools();
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let loop_ = suspendable_loop(&backend, &tools, &cues, 2);
        let (_, suspension) = block_on(loop_.run_suspendable("what's near me"));
        let suspension = suspension.expect("preflight suspension");

        let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
            "Best effort from the observation.".into(),
        ))]);
        let resumed_tools = ScriptedTools::new(None).with(
            "current_location",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: r#"{"status":"ok"}"#.into(),
            },
        );
        let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
        let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 2);
        let (resumed, _) = block_on(resumed_loop.resume(suspension));
        assert_eq!(
            resumed,
            ChatTurnOutcome::Answer("Best effort from the observation.".into())
        );
        // The single resumed step was the grace call: zero tools offered.
        assert_eq!(
            resumed_backend.seen_tool_counts.lock().unwrap().as_slice(),
            &[0]
        );
    }

    /// A selected preflight suspends only its own assistant call. Unselected
    /// siblings never enter the transcript and never receive fabricated
    /// results, so resume can pair the selected call with one real observation.
    #[test]
    fn preflight_suspension_omits_unselected_siblings_and_resumes_cleanly() {
        let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![
            call("current_location"),
            call("knowledge_lookup"),
        ]))]);
        let tools = location_preflight_tools().with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "never executed".into(),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let turns = RecordingTurns::default();
        let loop_ = suspendable_loop_observed(&backend, &tools, &cues, &turns, 4);
        let (_, suspension) = block_on(loop_.run_suspendable("compound request"));
        let suspension = suspension.expect("preflight suspension");
        assert_eq!(
            tools.executed.lock().unwrap().as_slice(),
            &["current_location".to_string()]
        );
        assert_eq!(
            tools.cue_requests.lock().unwrap().as_slice(),
            &[vec!["current_location".to_string()]]
        );
        assert_eq!(
            turns.0.lock().unwrap().as_slice(),
            &["start:current_location"],
            "a preflight has no real observation turn until resume"
        );
        assert_eq!(
            transcript_tool_call_names(&suspension.messages),
            vec!["current_location".to_string()],
            "the assistant transcript must omit the proposed sibling"
        );
        assert!(
            transcript_tool_result_ids(&suspension.messages).is_empty(),
            "the suspended transcript must not fabricate sibling results"
        );

        let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final("Done.".into()))]);
        let resumed_tools = ScriptedTools::new(None).with(
            "current_location",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: r#"{"status":"ok"}"#.into(),
            },
        );
        let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
        let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 4);
        let (resumed, _) = block_on(resumed_loop.resume(suspension));
        assert_eq!(resumed, ChatTurnOutcome::Answer("Done.".into()));
        // Transcript at the resumed step: user + one selected assistant call +
        // that call's real result. There is no unresolved sibling ID.
        assert_eq!(
            resumed_backend
                .seen_message_counts
                .lock()
                .unwrap()
                .as_slice(),
            &[3]
        );
        let seen = resumed_backend.seen_messages.lock().unwrap();
        assert_eq!(
            transcript_tool_call_names(&seen[0]),
            vec!["current_location".to_string()]
        );
        assert_eq!(
            transcript_tool_result_ids(&seen[0]),
            vec!["current_location-1".to_string()]
        );
    }
}
