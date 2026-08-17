//! Turn tracing: the per-run decision-chain recorder and its redaction rules.

use super::*;

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
pub(super) struct TracedModelStep<'a> {
    pub(super) iteration: usize,
    pub(super) latency: std::time::Duration,
    pub(super) prompt_chars: usize,
    pub(super) step: &'a ToolStepResult,
}

/// One tool execution, as the trace sees it. `status` is a bounded label from
/// the closed set below, never provider or tool prose.
pub(super) struct TracedToolCall<'a> {
    pub(super) ordinal: usize,
    pub(super) call: &'a ToolStepCall,
    pub(super) latency: std::time::Duration,
    pub(super) ok: bool,
    pub(super) status: &'static str,
    /// The observation the model was given, when there was one. Recorded only
    /// when content capture is on.
    pub(super) observation: Option<&'a str>,
}

/// The closed vocabulary of [`TracedToolCall::status`]. Grouped here so a new
/// outcome has to be named rather than described.
pub(super) mod tool_call_status {
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

    pub(super) fn is_enabled(&self) -> bool {
        self.tracer.is_enabled()
    }

    pub(super) fn gate(&self, gate: &str, allowed: bool, reason: &str, shape: &[(&str, i64)]) {
        self.tracer.gate(gate, allowed, reason, shape);
    }

    pub(super) fn model_step(&self, step: TracedModelStep<'_>) {
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

    pub(super) fn tool_call(&self, executed: TracedToolCall<'_>) {
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
    pub(super) fn backend_error_note(&self, category: &str, iteration: usize) {
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
    pub(super) fn terminal(&self, outcome: &ChatTurnOutcome) {
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
