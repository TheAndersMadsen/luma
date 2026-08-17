//! Ai Pin Revival's independently implemented assistant turn engine.
//!
//! It drives an LLM in a thought→action→observation loop over a `SynapseChatTurn`
//! DAG and streams the stock-facing `SynapseUnderstandingResponse` contract.
//! Each model turn is either a tool call (emit an
//! action node, execute it server-side, feed the observation back — LOOP) or a
//! plain answer, delivered as a **terminal `Respond` action** the device narrates
//! (FINISH), bounded by the max-action-turns budget. The model + prompts +
//! catalog content are ours; the protocol, loop shape, and device-facing
//! interface preserve the observed device boundary.
//!
//! Contract details that are load-bearing on a real device and that this engine
//! therefore honors:
//!   1. **Terminal shape.** The legacy `Understand` consumer
//!      (`SynapseInterpreter$1.onNext`) keeps ONLY turns that
//!      `hasAction()`/`hasObservation()` — a bare `SynapseAnswer` body is logged
//!      "Unexpected TAO response" and dropped — and it *dispatches* only the FINAL
//!      action of the batch. So the answer is the last action turn
//!      (`action="Respond"`, `source=DEVICE`, `input={"Response": "…"}`), never a
//!      response-level `Answer`/`Failure` body.
//!   2. **Root threading.** The server is stateless per legacy call and threads its
//!      turns onto the user-request turn the device replays in
//!      `device_context.turns` (empty parent ⇒ self-rooting new run).
//!   3. **Device vs server execution.** A device-catalog action is emitted as the
//!      terminal action for the *pin* to run — the server never executes it or
//!      fabricates its observation. Server tools resolve inline and pair with an
//!      observation, then loop.
//!   4. **Replayed conversation state.** Prior turns in `device_context.turns` plus
//!      `previous_answers` reconstruct the transcript the model reasons over.
//!   5. **Catalog resolution.** `excluded_tools` is subtracted from the
//!      server-owned catalog keyed by `tool_set_version` (the device sends an empty
//!      `action_definitions` and only a version pointer).
//!   6. **Loop guards.** An action budget (`ai_bus.max_action_turns`, default 8)
//!      bounds the run; exceeding it yields a `TooManyActions` observation which is
//!      converted into a terminal `Respond` — mirroring `Switchboard`'s runaway
//!      guard, where `Respond` is exempt so the agent can always answer. A call to
//!      an unknown tool bounces the exact stock `Unrecognized function name and/or
//!      arguments` observation back so the model can retry with corrected args.

use std::sync::Arc;

use cosmos_protocol::aibus as pb;
use tokio::sync::mpsc::Sender;
use tonic::Status;

use super::catalog;
use super::llm::{ChatMessage, ChatModel, Role, ToolCall, ToolDef};
use super::toolsets;
use super::turn::context::situation_line;
use super::turn::frames::{action_turn, now_ts, observation_turn};
use super::turn::text::{model_facing_observation, spoken_text};
use crate::services::gates::{self, BlockingObservation, Entitlement};

/// carry's runaway guard (`Switchboard.mActionLimit`, stock `intent.actionLimit`).
/// The ceiling is over the whole RUN, not one RPC: a multi-hop run issues a fresh
/// `Understand` per hop, so a per-call budget would never bind.
const ACTION_LIMIT: usize = 8;

/// The exact observation the stock device bounces back when an emitted action
/// does not resolve in its `SchemaCatalog` (`JsonResolver.resolve` → null). The
/// server mirrors it so the model can retry with corrected arguments.
const UNRECOGNIZED_FUNCTION: &str = "Unrecognized function name and/or arguments";

/// Spoken when the runaway guard trips. carry's `TooManyActionsObservation`
/// carries `ErrorStrings.ERROR_TOO_MANY_ACTIONS` and the device speaks it verbatim
/// (`convertAndDispatchGeneratedActionIfNeeded` → `RespondAction`), so this exact
/// string is what the wearer hears.
pub(super) const TOO_MANY_ACTIONS: &str = "something went wrong. can you rephrase your request?";

/// Spoken on an internal error or when the turn budget is exhausted
/// (`ErrorStrings.ERROR_TIMEOUT` — the string the device itself speaks on
/// `DEADLINE_EXCEEDED`).
pub(super) const ERROR_TIMEOUT: &str = "Something went wrong. Try again.";

/// Spoken when the model returns a turn carrying no usable content — distinct
/// from an internal error (nothing failed) and from the runaway guard (the model
/// never got that far). Stock has no dedicated string for this because its
/// serverside never surfaces an empty completion to the wearer; the closest
/// faithful behaviour is a short, non-apologising retry prompt.
pub(super) const NO_ANSWER: &str = "No answer came back. Try asking again.";

/// Wearer-facing failure strings, kept in one place so the response-style
/// contract can be enforced over them by test rather than by convention.
///
/// The recovered stock tool sets forbid an assistant persona: no first person,
/// and no apology/regret constructions. Every string here is spoken to the wearer
/// on a path where something already went wrong, which is exactly where an
/// apologetic "sorry, I ..." would otherwise creep in — so these are the strings
/// most worth pinning. See `wearer_facing_strings_carry_no_persona`.
#[cfg(test)]
pub(super) const WEARER_FACING_FAILURE_STRINGS: &[&str] =
    &[TOO_MANY_ACTIONS, ERROR_TIMEOUT, NO_ANSWER];

/// Anti-hang ceiling for a single model step.
///
/// Its only job is to stop ONE stuck call from consuming the whole run — not to
/// cap normal latency. It was 10s, which was below real model latency on a busy
/// day and killed legitimate steps: a first step that took >10s to decide on a
/// tool, and an answer step that needed just over 10s to summarise a long search
/// result. Both surfaced to the wearer as "Something went wrong" at exactly
/// 10.0s. 15s clears realistic slow calls while a call past it is genuinely
/// stuck; the whole run stays bounded by [`RUN_BUDGET`] regardless.
const MODEL_STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// How many of the wearer's newest notes are scanned when building the facts
/// block. A ceiling on the READ, so the query cost cannot grow with the account.
const WEARER_FACT_SCAN: i32 = 64;
/// How many facts are carried to the model. These ride EVERY turn, so each one is
/// paid for on every request — but the failure mode of being too small is worse
/// than the token cost. Past the cap the OLDEST facts drop out silently, and the
/// only fallback is `recall_memory`, whose lexical matcher provably cannot bridge
/// a synonym ("interests" scores zero against "i like noodles"). So a wearer who
/// crosses the cap gets the original bug back for their older facts, quietly.
/// 48 keeps real accounts inside the block; the char ceiling still bounds cost.
const WEARER_FACTS_MAX_ITEMS: usize = 48;
/// Character ceiling for the whole block, enforced alongside the item count — one
/// pathologically long note must not consume the budget the others need. At ~40
/// characters a fact this is roughly the item cap, so neither bound dominates.
const WEARER_FACTS_MAX_CHARS: usize = 2_400;

/// How long this model step may run, given the budget left.
///
/// The budget that remains, minus the [`TERMINAL_RESERVE`] the run keeps to
/// stream the answer, bounded by the anti-hang ceiling. So a step uses the time
/// it actually has (up to the ceiling) instead of a fixed cap that fired with
/// budget to spare — while a stuck step still cannot outlive the ceiling.
fn step_timeout_for(remaining: std::time::Duration) -> std::time::Duration {
    remaining
        .saturating_sub(TERMINAL_RESERVE)
        .min(MODEL_STEP_TIMEOUT)
}

/// Total wall-clock budget for the whole turn. The device issues `understand` /
/// `encryptedUnderstand` with `withDeadlineAfter(AIMIC_TIMEOUT_MS = 25000)` over
/// the ENTIRE server-stream (`AIBusService.java`); if the stream doesn't complete
/// in time gRPC fires `DEADLINE_EXCEEDED`, the device discards every turn already
/// streamed, and speaks `ERROR_TIMEOUT`. So bound the run well under 25s and always
/// deliver a terminal `Respond` first. (Bidi carries no such deadline.)
const RUN_BUDGET: std::time::Duration = std::time::Duration::from_secs(22);

/// Headroom held back from the run budget so that a tool which overruns still
/// leaves time to stream the terminal `Respond` the wearer hears.
const TERMINAL_RESERVE: std::time::Duration = std::time::Duration::from_millis(750);

/// The observation for a server tool that did not return inside the run's
/// remaining budget. The tool produced nothing, so the model is told exactly
/// that: an invented stand-in result here would be spoken to the wearer as fact.
const TOOL_TIMED_OUT: &str = "The tool did not return in time and produced no result.";

/// Total wall-clock budget for this run.
///
/// Production always uses [`RUN_BUDGET`]; tests may shorten it so the budget
/// paths are exercised in milliseconds instead of 22 real seconds. The override
/// is thread-local (each test runs on its own thread, and `Engine::run` is
/// awaited on the caller's thread), so shortening it in one test cannot leak
/// into another running concurrently.
fn run_budget() -> std::time::Duration {
    #[cfg(test)]
    if let Some(shortened) = tests::budget_override() {
        return shortened;
    }
    RUN_BUDGET
}

/// Held back so a run that runs out of tool budget can still spend ONE model
/// step turning what it already observed into an answer.
///
/// [`TERMINAL_RESERVE`] is only enough to *stream* a canned string; composing
/// needs a real model round trip, which measured 2.4-7.7s against the live
/// backend. Sized for the slow end of that: a run that starts a third search at
/// t=16.7s has ~2s left afterwards, which buys a timeout string and nothing else.
const ANSWER_RESERVE: std::time::Duration = std::time::Duration::from_secs(7);

/// The smallest window worth STARTING a server tool in.
///
/// Reserving compose time is not enough on its own: the gate has to leave room
/// for the tool *and* the answer. Measured on the live stack, a second
/// `ask_online` was admitted with 8.0s left, ran 5.2s, and left 2.8s — just
/// under the ~2.9s a compose step needs. The run then spent its whole budget and
/// spoke `ERROR_TIMEOUT` with two full result sets sitting in context.
///
/// So a tool is admitted only with [`ANSWER_RESERVE`] + this much left, and
/// [`bounded_tool`] additionally caps it so it can never eat the compose window.
const MIN_TOOL_WINDOW: std::time::Duration = std::time::Duration::from_secs(3);

/// Appended when the budget is spent, to convert the transcript into an answer.
///
/// Deliberately not an apology and not first-person: whatever comes back is
/// spoken to the wearer, so it is bound by the same no-persona contract as every
/// other wearer-facing string here (`wearer_facing_strings_carry_no_persona`).
const FINAL_ANSWER_DIRECTIVE: &str = concat!(
    "Time for this turn is up. No further tools will run. ",
    "Answer now using only what the observations above already established. ",
    "If they are incomplete, say plainly what is known and what could not be ",
    "determined. Do not apologise and do not refer to yourself."
);

/// True when too little of the run budget is left to start a server tool AND
/// still turn its result into a spoken answer.
///
/// Checked BEFORE the action turn is emitted. An action turn with no paired
/// observation is the one shape `processLegacySupervisorOnlyChatTurns` will
/// happily dispatch — the pin would be handed a server-side tool name it cannot
/// resolve — so the run has to be closed before the node goes out, not after.
///
/// The reserve is [`ANSWER_RESERVE`], not [`TERMINAL_RESERVE`]: a run that
/// starts a tool it has no time to *use* has spent the wearer's budget buying
/// nothing. Observed live — three searches, a usable result in hand after the
/// second, and the device's timeout string spoken at 22s with the answer sitting
/// unread in the transcript.
fn out_of_tool_budget(deadline: std::time::Instant) -> bool {
    deadline.saturating_duration_since(std::time::Instant::now())
        <= ANSWER_RESERVE + MIN_TOOL_WINDOW
}

/// Run a server tool bounded by what is left of the run budget.
///
/// `RUN_BUDGET` used to be checked only at the top of each loop iteration, and
/// only the model step was wrapped in a timeout — `execute_tool_with` was
/// awaited unbounded. A backend that stalls at t=20s therefore returns past the
/// device's `withDeadlineAfter(AIMIC_TIMEOUT_MS = 25000)` (`AIBusService.java`),
/// at which point gRPC fires `DEADLINE_EXCEEDED` and the pin discards every turn
/// already streamed and speaks its own `ERROR_TIMEOUT`. The engine's whole
/// design is that the wearer always hears a terminal `Respond`; one unbounded
/// await defeats it.
async fn bounded_tool<F>(fut: F, deadline: std::time::Instant) -> String
where
    F: std::future::Future<Output = String>,
{
    // Reserve the COMPOSE window, not just the streaming one. A tool allowed to
    // run to `deadline - TERMINAL_RESERVE` can return with too little left to
    // turn its own result into an answer — which is how a run ends up spending
    // 22s and speaking the timeout string with the result already in hand.
    let budget = deadline
        .saturating_duration_since(std::time::Instant::now())
        .saturating_sub(ANSWER_RESERVE);
    tokio::time::timeout(budget, fut)
        .await
        .unwrap_or_else(|_| TOOL_TIMED_OUT.to_owned())
}

/// carry's replayed-context ceiling.
///
/// `resources/assets/config_generated.json` ships `tao.contextCapacity = 100`,
/// and `AiBrainService` hands it to `LocalChatTurnService`, which evicts past it
/// — so the device itself never holds more than 100 turns. `device_context.turns`
/// is device-supplied and deliberately MULTI-run (`EventsSnapshot.linearize`
/// stitches completed runs inside the inter-run window), so replaying all of it
/// grows every prompt without bound: prompt tokens, per-step latency, and the
/// run budget all pay for turns the pin has already forgotten. We cited the
/// constant and never enforced it; enforce it, keeping the MOST RECENT turns.
const CONTEXT_CAPACITY: usize = 100;

/// What the engine tells the model when the wearer used the vision gesture.
///
/// `IntentRecognitionAction.visionRequested()` returns `VISION` when the run was
/// started by the vision gesture/laser, and `TaoEventRegistrar.onTranscription`
/// stamps it onto the user-request turn (`SynapseUserRequestContent`
/// `vision_requested` field 5), with the prefetched frame in `image_data`
/// (field 8) when `shouldPrefetchVisionImage()` fired. Reading only the text
/// fields turns "what is this?" into a bare sentence with no referent, and the
/// one interaction where the wearer physically aimed the device is answered
/// blind.
///
/// The line states plainly that the frame is NOT readable from this transcript:
/// a model told an image is "attached" that it cannot actually see will describe
/// one it never saw, which is the worst possible outcome on a vision turn.
/// `UnderstandScene` is the device action that looks (recovered interface:
/// experience ANSWERS, required slot `Question`).
const VISION_GESTURE_POLICY: &str = "The wearer aimed the pin at something and this request is about what is in front of them. \
     The camera view belongs to the pin and is not readable from this transcript. Call \
     UnderstandScene with the wearer's question to look at it. Do not answer as though nothing \
     were being pointed at, and never describe anything that has not been observed.";

/// The same situation on a caller whose catalog has no way to look. Saying so is
/// the honest outcome; describing the scene anyway would be invented.
const VISION_UNAVAILABLE_POLICY: &str = "The wearer aimed the pin at something, but no tool available here can look at the camera \
     view. Say briefly that looking is not available on this connection. Never describe what the \
     camera might be seeing.";

/// Appended when the device already prefetched the frame onto the request, so
/// the model knows the capture exists rather than treating the look as a fresh,
/// possibly failing one.
const VISION_FRAME_ATTACHED: &str =
    " The pin already captured a frame for this request, so looking is immediate.";

/// `ServerStatefulUnderstand` returns text/audio only. It has no channel on
/// which a Pin can execute a terminal device action and post the observation.
/// Keep this constraint at system priority so a model cannot turn the absence
/// of a timer/music/contact tool into a false claim that the action succeeded.
const TEXT_ONLY_TRANSPORT_POLICY: &str = "This caller can receive spoken text only and is not a connected Pin. Do not claim or imply that \
     any timer, alarm, call, message, music, capture, setting, or other device action succeeded. If the \
     wearer requests a device action, say briefly that a connected Pin is required. Informational and \
     server-tool questions may still be answered normally.";

pub struct Engine {
    model: Arc<dyn ChatModel>,
    /// Whose data the server-side tools operate on. Empty for callers with no
    /// request context; a wearer-scoped tool then says it has nothing rather
    /// than reaching into another account.
    tools: catalog::ToolContext,
    /// The caller's account verdict. carry gates every dispatched action on this
    /// and *rewrites* the ReAct chain when it blocks (see [`Self::gated`]). With
    /// no entitlement datastore this deployment resolves to
    /// [`Entitlement::Active`] — carry's own fail-open behavior.
    entitlement: Entitlement,
}

impl Engine {
    pub fn new(model: Arc<dyn ChatModel>) -> Self {
        Self {
            model,
            entitlement: Entitlement::default(),
            tools: catalog::ToolContext::default(),
        }
    }

    /// Bind the wearer-scoped tool context for this caller.
    pub fn with_tools(mut self, tools: catalog::ToolContext) -> Self {
        self.tools = tools;
        self
    }

    /// The underlying chat model, so the bidi transport can drive the same model
    /// this engine does (one assistant, two transports).
    pub fn model(&self) -> Arc<dyn ChatModel> {
        self.model.clone()
    }

    /// The wearer's saved facts as a system line, or `None` when there are none.
    ///
    /// Bounded on purpose. A wearer's own notes are few and every one of them is
    /// about the person being spoken to, so the whole set is worth carrying — but
    /// "few" has to be enforced, not assumed: an unbounded block would grow with
    /// the account until it crowded out the conversation and slowed every turn.
    /// Newest first, so what survives the cap is what they most recently chose to
    /// keep.
    ///
    /// Only notes THIS SERVER can read appear. A note a device sealed under a key
    /// the deployment does not hold stays sealed and is simply absent — never
    /// guessed at, never counted. A store that cannot be reached yields `None`
    /// rather than an empty list, so a lookup failure can never render as "you
    /// have saved nothing".
    async fn wearer_facts(&self) -> Option<String> {
        let principal = self.tools.principal.as_deref()?;
        let store = self.tools.store.as_ref()?;
        let notes = store
            .recent_notes(principal, WEARER_FACT_SCAN, None, None)
            .await
            .ok()?;

        let mut lines: Vec<String> = Vec::new();
        let mut budget = WEARER_FACTS_MAX_CHARS;
        for note in notes.iter() {
            // Plaintext index only: a note the server sealed for the device is
            // opaque here, and inventing a summary of it would be fabricating a
            // memory the wearer never wrote.
            let Some(text) = note.indexed_text.as_deref() else {
                continue;
            };
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            let cost = text.chars().count() + 3;
            if cost > budget {
                break;
            }
            budget -= cost;
            lines.push(format!("- {text}"));
            if lines.len() >= WEARER_FACTS_MAX_ITEMS {
                break;
            }
        }
        if lines.is_empty() {
            return None;
        }
        Some(format!(
            "What the wearer has asked you to remember about them:\n{}\n\
             Treat these as established facts about the person you are speaking to \
             and answer from them directly. If one of them answers the question, \
             say so plainly — do not look it up again and do not say nothing has \
             been established. If they do not cover what was asked, say only that \
             the specific thing is not something they have saved.",
            lines.join("\n")
        ))
    }

    /// Spend what is left of the budget turning the transcript into an answer.
    ///
    /// Every budget-exhaustion path used to speak [`ERROR_TIMEOUT`] and drop the
    /// run on the floor. That is the right string when the run genuinely has
    /// nothing — and the wrong one when it has three tool observations in
    /// context, which is what a search-shaped question produces by t=20s. The
    /// wearer waited the full 22s either way; this decides whether they get the
    /// answer that wait bought.
    ///
    /// Tools are passed empty so the model cannot spend the remainder asking for
    /// another one. Returns `None` if there is no time left, the step fails, or
    /// the model returns nothing usable — every caller then falls back to the
    /// stock timeout string, so this can only add an answer, never remove one.
    async fn compose_final_answer(
        &self,
        messages: &[ChatMessage],
        deadline: std::time::Instant,
    ) -> Option<String> {
        let budget = deadline
            .saturating_duration_since(std::time::Instant::now())
            .checked_sub(TERMINAL_RESERVE)?;
        if budget.is_zero() {
            return None;
        }
        let mut messages = messages.to_vec();
        messages.push(ChatMessage::user(FINAL_ANSWER_DIRECTIVE));
        let resp = tokio::time::timeout(budget, self.model.complete(&messages, &[]))
            .await
            .ok()?
            .ok()?;
        resp.content
            .as_deref()
            .map(str::trim)
            .filter(|answer| !answer.is_empty())
            .map(str::to_owned)
    }

    /// Build an engine for a caller with a known account verdict.
    pub fn with_entitlement(model: Arc<dyn ChatModel>, entitlement: Entitlement) -> Self {
        Self {
            model,
            entitlement,
            tools: catalog::ToolContext::default(),
        }
    }

    /// This engine's model bound to one caller's account verdict, so a shared
    /// engine can serve per-request entitlements without rebuilding the model.
    /// This engine's model bound to one caller's account verdict and
    /// wearer-scoped tool context, so a shared engine serves per-request state
    /// without rebuilding the model.
    pub fn for_request(&self, entitlement: Entitlement, tools: catalog::ToolContext) -> Arc<Self> {
        Arc::new(Self {
            model: self.model.clone(),
            entitlement,
            tools,
        })
    }

    /// carry's degraded-state rewrite: when the account gate blocks an action, the
    /// device records a NON-final blocking observation and then dispatches a
    /// *self-generated* device action that runs a canned local experience
    /// (`convertAndDispatchGeneratedActionIfNeeded`). The server models the same
    /// rewrite so the wearer hears why instead of hitting silence.
    ///
    /// Returns the substituted action name when the original is blocked.
    fn gated(&self, action: &str) -> Option<BlockingObservation> {
        gates::gate_action(&self.entitlement, action)
    }

    /// Run one turn, streaming the transcript + terminal answer down `tx`.
    pub async fn run(
        &self,
        req: pb::SynapseUnderstandingRequest,
        tx: Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    ) {
        self.run_with_system_addendum(req, tx, None).await;
    }

    /// Run the text-only stateful adapter. This is deliberately separate from
    /// `run`: full Pin transports must retain the device-action/observation loop.
    pub async fn run_text_only(
        &self,
        req: pb::SynapseUnderstandingRequest,
        tx: Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    ) {
        self.run_with_system_addendum(req, tx, Some(TEXT_ONLY_TRANSPORT_POLICY))
            .await;
    }

    async fn run_with_system_addendum(
        &self,
        req: pb::SynapseUnderstandingRequest,
        tx: Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
        system_addendum: Option<&str>,
    ) {
        // Resolve the server-owned catalog for this request: our tool set minus
        // whatever the device excluded (`SYNAPSE_EXCLUDED_TOOLS`).
        let tools = resolve_catalog(&req, self.entitlement.is_subscribed());

        // The wearer's own words, kept for required-slot backfill: the agent
        // entry points take the request verbatim, so when the model omits the
        // slot the utterance is the faithful value rather than an invention.
        let utterance = req.utterance.clone();

        // Root the transcript on the user-request turn the DEVICE replayed. With no
        // device context the first server turn self-roots (empty parent) rather
        // than pointing at a fabricated id we never emit.
        let mut parent = req
            .device_context
            .as_ref()
            .and_then(|dc| dc.turns.last())
            .map(|t| t.identifier.clone())
            .unwrap_or_default();

        // Reconstruct the conversation the model reasons over from the state the
        // device replayed (carry's legacy path is stateless per call).
        let mut messages = build_history(&req);
        // The vision gesture reaches the model as a policy line rather than as
        // pixels: `build_history` used to read only the text fields and drop
        // both `vision_requested` and `image_data`. Pushed here, not in
        // `build_history`, because whether the pin can be asked to look depends
        // on the RESOLVED catalog (a text-only caller excludes device tools).
        if let Some(vision) = vision_line(&req, &tools) {
            messages.push(ChatMessage::system(vision));
        }
        if let Some(addendum) = system_addendum {
            messages.push(ChatMessage::system(addendum));
        }
        // What the wearer has asked to be remembered, carried on EVERY turn.
        //
        // Recall used to be a lookup the model had to choose to make, over a
        // lexical matcher. Both halves failed live: the model answered "nothing
        // about your likes has been established here" without calling the tool at
        // all, and when it did call, `interests` shares zero stemmed terms with
        // "i like trains" so the matcher returned nothing and the wearer was told
        // they had saved nothing about a note they had just saved.
        //
        // A wearer's saved facts are small and always relevant — they are who the
        // assistant is talking to. Putting them in front of the model removes both
        // failure modes at once: no tool decision, no term overlap, no round trip.
        // `recall_memory` stays for dated and archive-shaped questions ("what did
        // I note last Tuesday"), where scanning beats carrying everything.
        if let Some(facts) = self.wearer_facts().await {
            messages.push(ChatMessage::system(facts));
        }

        // NOTE: no leading heartbeat on the legacy server-stream.
        //
        // `SynapseInterpreter$1.onNext` keeps only responses whose turn
        // `hasAction()`/`hasObservation()`; anything else is logged as an
        // "Unexpected TAO response" and discarded. A heartbeat sent before the
        // first real turn is therefore pure noise to the one consumer that
        // matters, and on a build that treats an unparseable leading message as
        // a protocol error it costs the whole turn.

        // Seed the run's action count from the CURRENT run only, so the ceiling
        // binds across hops the way `Switchboard.numActionsInRun` does.
        let mut actions_in_run = req
            .device_context
            .as_ref()
            .map(|dc| actions_in_current_run(&dc.turns))
            .unwrap_or(0);

        // Bound the whole turn under the device's 25s deadline (see RUN_BUDGET).
        let run_deadline = std::time::Instant::now() + run_budget();

        for step in 0..ACTION_LIMIT {
            // Out of turn budget: deliver a spoken terminal NOW, before the device's
            // deadline fires and throws away everything we streamed.
            let remaining = run_deadline.saturating_duration_since(std::time::Instant::now());
            if remaining < std::time::Duration::from_millis(500) {
                // Too little left even to compose; the stock timeout string is
                // all there is time to say.
                let id = new_id();
                finish(&tx, respond(ERROR_TIMEOUT, parent, id)).await;
                return;
            }
            // Never past the remaining budget, and never so short that the last
            // step of a turn is cut off with budget still unspent.
            let step_timeout = step_timeout_for(remaining);
            // Every arm below speaks the same sentence — carry converts degraded
            // states into device actions that narrate, never a bare `Failure`
            // body the device would drop — but they are NOT the same event, and
            // folding them together is what made an expired provider key raise
            // the deadline alarm. The spoken string stays stock; the outcome
            // label says what actually happened.
            let resp =
                match tokio::time::timeout(step_timeout, self.model.complete(&messages, &tools))
                    .await
                {
                    Ok(Ok(response)) => response,
                    Ok(Err(error)) => {
                        let id = new_id();
                        finish_as(
                            &tx,
                            respond(ERROR_TIMEOUT, parent, id),
                            Some(model_failure_outcome(&error)),
                        )
                        .await;
                        return;
                    }
                    // The step outran its slice of the turn budget. This one really
                    // is a deadline.
                    Err(_elapsed) => {
                        let id = new_id();
                        finish_as(&tx, respond(ERROR_TIMEOUT, parent, id), Some("deadline")).await;
                        return;
                    }
                };

            if let Some(tc) = resp.tool_call {
                // Unknown tool: bounce the stock unrecognized-function observation
                // and LOOP so the model can correct itself (carry's device does
                // exactly this, tagged source=DEVICE).
                if !tools.iter().any(|t| t.name == tc.name) {
                    let action_id = new_id();
                    if send(
                        &tx,
                        node(action_turn(
                            &tc,
                            &resp.thought,
                            parent,
                            action_id.clone(),
                            pb::SynapseSource::Server,
                        )),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    let obs_id = new_id();
                    if send(
                        &tx,
                        node(observation_turn(
                            &tc.name,
                            UNRECOGNIZED_FUNCTION,
                            action_id,
                            obs_id.clone(),
                            pb::SynapseSource::Device,
                        )),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    messages.push(ChatMessage::user(format!(
                        "[Called {}({}). Result: {UNRECOGNIZED_FUNCTION}]",
                        tc.name, tc.arguments
                    )));
                    // The device counts this action turn toward `mActionLimit`
                    // like any other, so the server's ceiling must too — else a
                    // model that keeps hallucinating tools runs past the pin's
                    // own limit and the run is cut short on the device instead.
                    actions_in_run += 1;
                    parent = obs_id;
                    // Same budget check the device-tool and server-tool branches
                    // make. Without it a model that keeps naming a tool outside
                    // the resolved catalog rides the loop to exhaustion and falls
                    // out of it with an OBSERVATION last — which the device never
                    // dispatches, so the wearer hears nothing at all.
                    if step + 1 == ACTION_LIMIT || actions_in_run + 1 > ACTION_LIMIT {
                        too_many_actions_terminal(&tx, parent).await;
                        return;
                    }
                    continue;
                }

                if catalog::is_device_tool(&tc.name) {
                    // `Respond` terminates every turn, and its `Response` slot is
                    // OPTIONAL on the device — a missing/miscased key resolves to
                    // null and the answers experience throws, so the wearer hears
                    // nothing. Never forward the model's arguments for it.
                    if tc.name == catalog::RESPOND_ACTION {
                        let id = new_id();
                        let input = catalog::respond_input_from_arguments(&tc.arguments)
                            .unwrap_or_else(|| catalog::respond_input(NO_ANSWER));
                        finish(
                            &tx,
                            terminal_device_action(
                                catalog::RESPOND_ACTION,
                                &input,
                                &resp.thought,
                                parent,
                                id,
                            ),
                        )
                        .await;
                        return;
                    }
                    // Account gate: a blocked action is replaced by the canned
                    // degraded experience rather than executed.
                    if let Some(blocked) = self.gated(&tc.name) {
                        let obs_id = new_id();
                        if send(
                            &tx,
                            node(observation_turn(
                                &tc.name,
                                blocked.observation_text(),
                                parent,
                                obs_id.clone(),
                                pb::SynapseSource::Device,
                            )),
                        )
                        .await
                        .is_err()
                        {
                            return;
                        }
                        let id = new_id();
                        finish(
                            &tx,
                            // The synthesized action needs a real input object.
                            // The device parses `input` unconditionally, so an
                            // empty string throws — `Errors.deviceBlocked()` and
                            // `unsubscribed()` both send "{}". `Respond`-shaped
                            // verdicts carry their spoken text instead.
                            match blocked.synthesized_action() {
                                catalog::RESPOND_ACTION => terminal_device_action(
                                    catalog::RESPOND_ACTION,
                                    &catalog::respond_input(blocked.observation_text()),
                                    "",
                                    obs_id,
                                    id,
                                ),
                                "Narrate" => terminal_device_action(
                                    "Narrate",
                                    &serde_json::json!({ "Narration": blocked.observation_text() })
                                        .to_string(),
                                    "",
                                    obs_id,
                                    id,
                                ),
                                other => terminal_device_action(other, "{}", "", obs_id, id),
                            },
                        )
                        .await;
                        return;
                    }
                    // Runaway guard: `Switchboard` rejects any dispatched action
                    // (except `Respond`) once the run's action count exceeds the
                    // limit. A terminal device action past the limit would be
                    // dropped by the device, which would then speak its own runaway
                    // apology. Deliver the exempt `Respond` ourselves instead.
                    if actions_in_run + 1 > ACTION_LIMIT {
                        too_many_actions_terminal(&tx, parent).await;
                        return;
                    }
                    // Validate the arguments against the action's REQUIRED slots
                    // before emitting. Marking a slot required in the schema only
                    // asks the model; the device resolves a missing slot to null
                    // and either NPEs in-process (the agent entry points) or runs
                    // an empty request — silently, with the run then hanging to
                    // the deadline. Repair what is repairable, and bounce what is
                    // not the same way an unrecognized tool bounces, so the model
                    // corrects itself here instead of burning a device round trip.
                    let input =
                        match catalog::device_action_input(&tc.name, &tc.arguments, &utterance) {
                            Ok(input) => input,
                            Err(observation) => {
                                let action_id = new_id();
                                if send(
                                    &tx,
                                    node(action_turn(
                                        &tc,
                                        &resp.thought,
                                        parent.clone(),
                                        action_id.clone(),
                                        pb::SynapseSource::Device,
                                    )),
                                )
                                .await
                                .is_err()
                                {
                                    return;
                                }
                                let obs_id = new_id();
                                if send(
                                    &tx,
                                    node(observation_turn(
                                        &tc.name,
                                        &observation,
                                        action_id,
                                        obs_id.clone(),
                                        pb::SynapseSource::Device,
                                    )),
                                )
                                .await
                                .is_err()
                                {
                                    return;
                                }
                                messages.push(ChatMessage::user(format!(
                                    "[Called {}({}). Result: {observation}]",
                                    tc.name, tc.arguments
                                )));
                                actions_in_run += 1;
                                parent = obs_id;
                                if step + 1 == ACTION_LIMIT || actions_in_run + 1 > ACTION_LIMIT {
                                    too_many_actions_terminal(&tx, parent).await;
                                    return;
                                }
                                continue;
                            }
                        };
                    // DEVICE action: the wearer's pin executes it. In the legacy
                    // server-stream path the device dispatches the *final* action,
                    // so a device tool is terminal — emit it as the last action
                    // (source=DEVICE) and stop. The server never fabricates a
                    // device-side observation it did not run.
                    let id = new_id();
                    finish(
                        &tx,
                        terminal_device_action(&tc.name, &input, &resp.thought, parent, id),
                    )
                    .await;
                    return;
                }

                // SERVER TOOL, single or batched. Both paths run a backend and
                // then loop, so both are bounded by the run budget from here on:
                // if there is not enough left to run one AND still speak, close
                // the run now, before any action node goes out.
                if out_of_tool_budget(run_deadline) {
                    // The run is out of time to start another tool — but the
                    // observations it already collected are sitting in
                    // `messages`. Answer from those before falling back to the
                    // device's timeout string.
                    let id = new_id();
                    let spoken = self
                        .compose_final_answer(&messages, run_deadline)
                        .await
                        .unwrap_or_else(|| ERROR_TIMEOUT.to_owned());
                    finish(&tx, respond(&spoken, parent, id)).await;
                    return;
                }

                // PARALLEL SERVER TOOLS. Every recovered stock tool set ships a
                // parallel-invocation wrapper instructing the model to batch
                // independent calls, so a model that asks for two lookups at once
                // is doing what it was told. We used to keep the first and drop
                // the rest silently — the dropped call was never observed, so the
                // model could answer as if it had run, and the turn paid for a
                // second model round trip to fetch what it had already asked for.
                //
                // Only server tools batch. A device action is terminal on this
                // transport (the pin dispatches the final action and returns one
                // observation), so anything device-side falls through to the
                // single-action path below.
                let batched: Vec<ToolCall> = resp
                    .extra_tool_calls
                    .iter()
                    .filter(|extra| {
                        !catalog::is_device_tool(&extra.name)
                            && catalog::is_server_tool(&extra.name)
                    })
                    .cloned()
                    .collect();
                // Never exceed the run's action ceiling: the device counts every
                // dispatched action, so a batch that overruns it would be cut
                // short on the pin instead of here.
                let room = ACTION_LIMIT.saturating_sub(actions_in_run + 1);
                let batched: Vec<ToolCall> = batched.into_iter().take(room).collect();

                if !batched.is_empty() {
                    let mut all: Vec<ToolCall> = vec![tc.clone()];
                    all.extend(batched);

                    // Emit every action first, then run them concurrently: the
                    // whole point is that two lookups cost one tool wait, not two.
                    let mut action_ids = Vec::with_capacity(all.len());
                    for call in &all {
                        let id = new_id();
                        if send(
                            &tx,
                            node(action_turn(
                                call,
                                &resp.thought,
                                parent.clone(),
                                id.clone(),
                                pb::SynapseSource::Server,
                            )),
                        )
                        .await
                        .is_err()
                        {
                            return;
                        }
                        actions_in_run += 1;
                        action_ids.push(id);
                    }

                    // Concurrent, but every one of them still bounded by the run
                    // budget: a batch is only as fast as its slowest member, so
                    // one stalled backend here would blow the device deadline
                    // just as surely as it would on the single-tool path.
                    let results = futures_util::future::join_all(all.iter().map(|call| {
                        bounded_tool(
                            catalog::execute_tool_with(&call.name, &call.arguments, &self.tools),
                            run_deadline,
                        )
                    }))
                    .await;

                    let mut last_obs_id = parent.clone();
                    for ((call, action_id), observation) in
                        all.iter().zip(action_ids).zip(results.iter())
                    {
                        let obs_id = new_id();
                        if send(
                            &tx,
                            node(observation_turn(
                                &call.name,
                                observation,
                                action_id,
                                obs_id.clone(),
                                pb::SynapseSource::Server,
                            )),
                        )
                        .await
                        .is_err()
                        {
                            return;
                        }
                        messages.push(ChatMessage::user(format!(
                            "[Called {}({}). Result: {}]",
                            call.name,
                            call.arguments,
                            model_facing_observation(observation)
                        )));
                        last_obs_id = obs_id;
                    }
                    parent = last_obs_id;

                    if step + 1 == ACTION_LIMIT || actions_in_run + 1 > ACTION_LIMIT {
                        too_many_actions_terminal(&tx, parent).await;
                        return;
                    }
                    continue;
                }

                // SERVER tool: resolve it server-side, emit action + paired
                // observation, and LOOP.
                let action_id = new_id();
                if send(
                    &tx,
                    node(action_turn(
                        &tc,
                        &resp.thought,
                        parent,
                        action_id.clone(),
                        pb::SynapseSource::Server,
                    )),
                )
                .await
                .is_err()
                {
                    return;
                }
                actions_in_run += 1;
                let observation = bounded_tool(
                    catalog::execute_tool_with(&tc.name, &tc.arguments, &self.tools),
                    run_deadline,
                )
                .await;
                let obs_id = new_id();
                if send(
                    &tx,
                    node(observation_turn(
                        &tc.name,
                        &observation,
                        action_id,
                        obs_id.clone(),
                        pb::SynapseSource::Server,
                    )),
                )
                .await
                .is_err()
                {
                    return;
                }
                messages.push(ChatMessage::user(format!(
                    "[Called {}({}). Result: {}]",
                    tc.name,
                    tc.arguments,
                    model_facing_observation(&observation)
                )));
                parent = obs_id;

                // Budget guard: if this was the last permitted step, close the run
                // the way Switchboard does — a TooManyActions observation converted
                // into a terminal Respond (Respond is exempt from the limit).
                if step + 1 == ACTION_LIMIT || actions_in_run + 1 > ACTION_LIMIT {
                    too_many_actions_terminal(&tx, parent).await;
                    return;
                }
            } else if let Some(answer) = resp
                .content
                .as_deref()
                .map(str::trim)
                .filter(|answer| !answer.is_empty())
            {
                // FINISH: the answer is the terminal `Respond` action turn the
                // device dispatches + speaks — the batch's last action.
                //
                // Blank content is treated as no content. `RespondAction.mResponse`
                // is a present-but-empty slot, so the device resolves the action,
                // dispatches it, and narrates nothing — a turn that "succeeds"
                // in silence, and whose observation is final, so nothing retries.
                // `respond_input_from_arguments` already applies this rule on the
                // tool-call path; this is the same rule on the plain-content path.
                let id = new_id();
                finish(&tx, respond(answer, parent, id)).await;
                return;
            } else {
                // Model returned neither a tool call nor content: still terminate
                // the stream with a spoken `Respond` rather than silence.
                let id = new_id();
                finish(&tx, respond(NO_ANSWER, parent, id)).await;
                return;
            }
        }

        // Structural backstop: the loop must never simply fall out.
        //
        // `processLegacySupervisorOnlyChatTurns` dispatches a turn only when the
        // LAST collected element `hasAction()`; an observation in that slot is
        // recorded and nothing is ever dispatched, so the run dies without a
        // sound and without an error path. Every branch above returns after
        // emitting a terminal, but relying on that is a standing invitation for
        // the next branch to forget — which is exactly how the unknown-tool path
        // regressed. Close the run here the way `Switchboard` does. Bidi has
        // carried this same post-loop terminal since it was written.
        too_many_actions_terminal(&tx, parent).await;
    }
}

/// Close a run the way `Switchboard`'s runaway guard does: record a non-final
/// `TooManyActions` observation, then convert it into the terminal (limit-exempt)
/// `Respond` whose text is the stock apology.
async fn too_many_actions_terminal(
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    parent: String,
) {
    let obs_id = new_id();
    if send(
        tx,
        node(observation_turn(
            "TooManyActions",
            TOO_MANY_ACTIONS,
            parent,
            obs_id.clone(),
            pb::SynapseSource::Device,
        )),
    )
    .await
    .is_err()
    {
        return;
    }
    let id = new_id();
    finish(tx, respond(TOO_MANY_ACTIONS, obs_id, id)).await;
}

// --- request-driven setup -------------------------------------------------

/// Resolve the device's `tool_set_version` pointer to a server-owned tool set.
///
/// The device ships an EMPTY `action_definitions` and only this pointer, so the
/// server is authoritative over which capability's tools and guidance the turn
/// gets. An absent or unrecognized pointer degrades to the flat default set
/// rather than failing the wearer's turn — see `toolsets::resolve`.
pub(super) fn resolved_tool_set(
    req: &pb::SynapseUnderstandingRequest,
) -> toolsets::ResolvedToolSet {
    let pointer = req
        .tool_set_version
        .as_ref()
        .map(|v| (v.set_name.as_str(), v.version));
    let resolved = toolsets::resolve(pointer);
    if resolved.resolution.is_degraded() {
        if let Some((name, version)) = pointer {
            // Visible in the logs: a degraded resolution silently changes which
            // tools the wearer's turn can reach, so it must not be silent here.
            tracing::debug!(
                requested = %toolsets::pointer_label(name, version),
                served = %toolsets::pointer_label(resolved.set.name, resolved.set.version),
                "tool_set_version degraded"
            );
        }
    }
    resolved
}

/// Resolve the server-owned catalog for a request: the tool set the device's
/// `tool_set_version` pointer selected, minus the device's `excluded_tools`.
/// carry keys the catalog by that pointer (the device sends `action_definitions`
/// empty, so the server is authoritative over the whole set).
fn resolve_catalog(req: &pb::SynapseUnderstandingRequest, subscribed: bool) -> Vec<ToolDef> {
    let context = catalog::CatalogContext {
        // The keyguard gate: a locked pin will only run actions whose stock class
        // is `@Action(enabledInKeyguard=true)`, so offering the rest invites an
        // action the device silently refuses.
        is_locked: req
            .device_context
            .as_ref()
            .map(|dc| dc.is_locked)
            .unwrap_or(false),
        excluded: &req.excluded_tools,
        subscribed,
    };
    catalog::tool_catalog_for_set(&context, resolved_tool_set(req).set)
}

/// The newest user-request turn the device replayed — the one this run is about.
///
/// The device replays the current turn's own `user_request` in
/// `device_context.turns` (see `build_history`), so the last one in the list is
/// the live request, not a historical one.
fn newest_user_request(
    req: &pb::SynapseUnderstandingRequest,
) -> Option<&pb::SynapseUserRequestContent> {
    req.device_context
        .as_ref()?
        .turns
        .iter()
        .rev()
        .find_map(|turn| match turn.content.as_ref() {
            Some(pb::synapse_chat_turn::Content::UserRequest(u)) => Some(u),
            _ => None,
        })
}

/// The system line for a vision-gesture turn, or `None` when the wearer did not
/// aim the pin at anything.
///
/// Keyed off the RESOLVED catalog so the guidance can never point the model at a
/// tool this caller does not have — a text-only caller excludes every device
/// action, `UnderstandScene` included, and telling that model to call it would
/// buy a bounced `Unrecognized function name and/or arguments` and a wasted step.
fn vision_line(req: &pb::SynapseUnderstandingRequest, tools: &[ToolDef]) -> Option<String> {
    let request = newest_user_request(req)?;
    let requested = request.vision_requested()
        == pb::synapse_user_request_content::VisionRequested::Vision
        || !request.image_data.is_empty();
    if !requested {
        return None;
    }
    // Legacy Understand is one RPC per device action. After `UnderstandScene`
    // finishes, the Pin replays the original vision-marked user request plus the
    // action and its observation into a fresh RPC. Re-applying "call
    // UnderstandScene" on that hop makes the model look again, and repeats until
    // Switchboard's action limit turns a successful image analysis into the
    // generic failure response. Only the current parent chain matters here:
    // device_context also carries completed older runs, and a previous look must
    // not suppress a new vision gesture.
    if req
        .device_context
        .as_ref()
        .is_some_and(|context| current_run_contains_action(&context.turns, VISION_ACTION))
    {
        return None;
    }
    let mut line = if tools.iter().any(|t| t.name == VISION_ACTION) {
        VISION_GESTURE_POLICY.to_owned()
    } else {
        VISION_UNAVAILABLE_POLICY.to_owned()
    };
    // The frame the device prefetched is not dropped on the floor any more: its
    // presence is stated. It is NOT described here — this transport hands the
    // model text only, and inventing a description of bytes nobody looked at is
    // exactly the failure this whole line exists to prevent.
    if !request.image_data.is_empty() && tools.iter().any(|t| t.name == VISION_ACTION) {
        line.push_str(VISION_FRAME_ATTACHED);
    }
    Some(line)
}

/// The device action that looks at the wearer's camera view.
const VISION_ACTION: &str = "UnderstandScene";

/// turn's utterance. carry's legacy server is stateless per call and reconstructs
/// conversation state exactly this way.
/// Rebuild the chat transcript the model reasons over from the state the device
/// replayed: prior turns (`device_context.turns`), `previous_answers`, and this
/// turn's utterance. carry's legacy server is stateless per call and
/// reconstructs conversation state exactly this way.
fn build_history(req: &pb::SynapseUnderstandingRequest) -> Vec<ChatMessage> {
    // The same pointer that selects the tool subset selects the prompt: carry's
    // server resolved `tool_set_version` to BOTH. Giving a capability child the
    // narrow tool list without its narrow guidance is half the topology.
    let mut messages = vec![ChatMessage::system(catalog::system_prompt_for(
        resolved_tool_set(req).set,
    ))];
    if let Some(situation) = situation_line(req) {
        messages.push(ChatMessage::system(situation));
    }

    if let Some(dc) = req.device_context.as_ref() {
        // Enforce carry's own `tao.contextCapacity`, keeping the MOST RECENT
        // turns: the device evicts the oldest at exactly this ceiling, and the
        // newest turns are the ones this run is threaded onto.
        let replayed = &dc.turns[dc.turns.len().saturating_sub(CONTEXT_CAPACITY)..];
        for turn in replayed {
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
                    // A prior step the server already resolved; replay as context.
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
    let already_replayed = messages
        .iter()
        .rev()
        .find(|m| m.role == Role::User)
        .is_some_and(|m| m.content == req.utterance);
    if !already_replayed && !req.utterance.is_empty() {
        messages.push(ChatMessage::user(req.utterance.clone()));
    }
    messages
}

// --- streaming helpers ----------------------------------------------------

async fn send(
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    msg: pb::SynapseUnderstandingResponse,
) -> Result<(), ()> {
    tx.send(Ok(msg)).await.map_err(|_| ())
}

/// Send the terminal action, then carry's explicit turn-complete marker
/// (`SynapseEndContent`, `SynapseChatTurn` oneof field 10). The legacy device
/// consumer keeps only action/observation turns, so it dispatches the terminal
/// action and ignores the end marker; richer clients get the explicit close.
async fn finish(
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    terminal: pb::SynapseUnderstandingResponse,
) {
    finish_as(tx, terminal, None).await;
}

/// [`finish`], with the outcome label stated rather than derived.
///
/// The default is to derive it from the terminal, and that default is
/// load-bearing: `record_turn` shipped with zero callers, so the one metric that
/// answers "did the wearer get an answer?" was always zero — including through a
/// live regression where every news turn ended in the device's timeout string.
/// Reading the message that actually goes out means a future branch cannot
/// forget to count itself, which is the same reason the post-loop backstop
/// exists.
///
/// `outcome` exists for the one case that breaks the derivation honestly: a
/// model failure is SPOKEN as the device's own timeout sentence, deliberately,
/// so the wearer hears stock wording — but a refused API key and an exhausted
/// turn budget are different operator problems and must not share a label. Pass
/// it only where the spoken string is known to understate the cause.
async fn finish_as(
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    terminal: pb::SynapseUnderstandingResponse,
    outcome: Option<&'static str>,
) {
    crate::metrics::record_turn(outcome.unwrap_or_else(|| turn_outcome(&terminal)));
    if send(tx, terminal).await.is_err() {
        return;
    }
    let _ = send(tx, end_marker()).await;
}

/// Which model failure ended this turn, as a short constant.
///
/// Never the error's message: `LlmError::Transport` carries a reqwest string
/// that can contain the configured URL, and a metric label is not the place for
/// it. The kinds line up with the `carry_errors_total{kind=…}` values the model
/// client emits, so one incident reads the same in both families.
fn model_failure_outcome(error: &super::llm::LlmError) -> &'static str {
    use super::llm::LlmError;
    match error {
        LlmError::Status(_) => "model_refused",
        LlmError::Malformed => "model_malformed",
        LlmError::Transport(_) | LlmError::ScriptExhausted => "model_unreachable",
    }
}

/// Classify a terminal into one of a small, bounded set of outcomes.
///
/// Never wearer text: every arm returns a `&'static str`, so no utterance,
/// answer, or tool argument can reach the metric label.
fn turn_outcome(terminal: &pb::SynapseUnderstandingResponse) -> &'static str {
    let Some(pb::synapse_understanding_response::Body::Turn(turn)) = &terminal.body else {
        return "unknown";
    };
    let Some(pb::synapse_chat_turn::Content::Action(action)) = &turn.content else {
        return "unknown";
    };
    if action.action != catalog::RESPOND_ACTION {
        // The pin performs it and the doing is the feedback; no spoken reply is
        // expected, so this is a success, not a silence.
        return "device_action";
    }
    match catalog::respond_input_from_arguments(&action.input).as_deref() {
        Some(spoken) if spoken.contains(ERROR_TIMEOUT) => "deadline",
        Some(spoken) if spoken.contains(TOO_MANY_ACTIONS) => "too_many_actions",
        Some(spoken) if spoken.contains(NO_ANSWER) => "no_answer",
        Some(_) => "answered",
        None => "empty",
    }
}

/// Count the action nodes belonging to the CURRENT run.
///
/// `device_context.turns` is deliberately MULTI-run: `EventsSnapshot.linearize`
/// stitches the live run together with every prior *complete* run inside the
/// inter-run window, bounded by the device's turn capacity. On the production
/// `SynapseInterpreter` path these come from `config.tao`:
/// `contextCapacity = 100` turns and `maximumSecondsBetweenRuns = 180` (the 30/60
/// values are the unrelated hard-coded `TaoAgent`/`TaoAgentV2` constructors). The
/// action ceiling, however, is per-run (`Switchboard.numActionsInRun`).
///
/// Counting the whole window conflates the two and the assistant degrades the
/// longer a wearer talks to it: each completed exchange leaves at least its
/// terminal `Respond` node behind, so after enough turns every new tool-using
/// turn trips the ceiling and dies in the canned apology — recovering only after
/// the inter-run gap flushes the window.
///
/// So walk `parent_identifier` from the newest turn back to the run root (the
/// turn with an empty parent), exactly as `EventsSnapshot.runFromHead` does, and
/// count only that chain.
pub(super) fn actions_in_current_run(turns: &[pb::SynapseChatTurn]) -> usize {
    use std::collections::HashMap;
    let by_id: HashMap<&str, &pb::SynapseChatTurn> =
        turns.iter().map(|t| (t.identifier.as_str(), t)).collect();

    let mut actions = 0usize;
    let mut cursor = turns.last();
    // Bounded by the turn count so a malformed parent cycle cannot spin.
    for _ in 0..turns.len() {
        let Some(turn) = cursor else { break };
        if matches!(
            turn.content,
            Some(pb::synapse_chat_turn::Content::Action(_))
        ) {
            actions += 1;
        }
        if turn.parent_identifier.is_empty() {
            break; // reached this run's root
        }
        cursor = by_id.get(turn.parent_identifier.as_str()).copied();
    }
    actions
}

/// Whether the newest run's parent chain already contains `action_name`.
///
/// The device replays multiple completed runs in one context, so a flat scan is
/// wrong for one-shot actions such as `UnderstandScene`: it would make a vision
/// capture in an older run disable the next vision gesture. Walking from the
/// newest turn mirrors [`actions_in_current_run`] and the Pin's own
/// `EventsSnapshot.runFromHead` behavior.
fn current_run_contains_action(turns: &[pb::SynapseChatTurn], action_name: &str) -> bool {
    use std::collections::HashMap;

    let by_id: HashMap<&str, &pb::SynapseChatTurn> = turns
        .iter()
        .map(|turn| (turn.identifier.as_str(), turn))
        .collect();
    let mut cursor = turns.last();
    for _ in 0..turns.len() {
        let Some(turn) = cursor else { break };
        if matches!(
            turn.content.as_ref(),
            Some(pb::synapse_chat_turn::Content::Action(action))
                if action.action == action_name
        ) {
            return true;
        }
        if turn.parent_identifier.is_empty() {
            break;
        }
        cursor = by_id.get(turn.parent_identifier.as_str()).copied();
    }
    false
}

/// Server-minted node id.
///
/// MUST be a UUID, not a per-call sequence. carry's `LocalChatTurnService.record`
/// enforces uniqueness via `ArgChecker.throwIfContainsKey` and *throws* on a
/// collision. A multi-hop run issues a FRESH `Understand` RPC per hop while
/// replaying every prior turn in `device_context.turns`, so any per-call counter
/// re-mints ids the device already holds and kills the run on the second hop.
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Wrap a non-terminal transcript node (`is_final = false`).
fn node(t: pb::SynapseChatTurn) -> pb::SynapseUnderstandingResponse {
    pb::SynapseUnderstandingResponse {
        response: String::new(),
        is_final: false,
        body: Some(pb::synapse_understanding_response::Body::Turn(t)),
    }
}

fn heartbeat() -> pb::SynapseUnderstandingResponse {
    pb::SynapseUnderstandingResponse {
        response: String::new(),
        is_final: false,
        body: Some(pb::synapse_understanding_response::Body::Heartbeat(
            pb::SynapseHeartbeat {},
        )),
    }
}

/// The explicit turn-complete marker.
fn end_marker() -> pb::SynapseUnderstandingResponse {
    pb::SynapseUnderstandingResponse {
        response: String::new(),
        is_final: true,
        body: Some(pb::synapse_understanding_response::Body::Turn(
            pb::SynapseChatTurn {
                user: pb::SynapseUser::System as i32,
                timestamp: now_ts(),
                identifier: String::new(),
                parent_identifier: String::new(),
                content: Some(pb::synapse_chat_turn::Content::End(
                    pb::SynapseEndContent {},
                )),
            },
        )),
    }
}

/// A terminal DEVICE action turn: `source = DEVICE`, `is_final` set so the
/// response-level flag also signals end-of-run. This is the batch's final action,
/// which the legacy device consumer dispatches and executes. Used both for the
/// spoken answer (`Respond`) and for any device tool the model calls (SetTimer, …).
/// The `source` a terminal action carries.
///
/// `source` is not decoration — `Schema.java:207` sets
/// `action.setIsDeviceAction(ActionToJson.isDeviceAction(content.getSource()))`,
/// and `isDeviceAction` is exactly `source == DEVICE`. So it tells the Pin
/// whether IT must execute the action.
///
/// That splits the two cases cleanly:
///
///   * A genuine device action (`WorldClock`, `PlayMusic`, `SetTimer`) must be
///     `DEVICE` — the Pin performs it, and for World Clock it does so offline.
///   * `Respond` is `SERVER`, because the answer was produced server-side and the
///     device narrates it rather than executing anything.
///
/// The second half is measured, not reasoned: in a capture of the real carry
/// cloud, all 65 observed `Respond` actions carried `source: SERVER` (see
/// `tools/carry-action-ground-truth.mjs` in the PenumbraOS repo). This code
/// previously sent `DEVICE` for everything, which told a Pin to execute
/// `Respond` itself — a divergence from every real turn we have on record.
///
/// `CARRY_RESPOND_SOURCE_DEVICE=1` restores the old behaviour, because this sits
/// on the one path that decides whether a wearer hears anything at all and no
/// real Pin has confirmed the change yet.
fn terminal_source(action: &str) -> pb::SynapseSource {
    if action == catalog::RESPOND_ACTION
        && !matches!(
            std::env::var("CARRY_RESPOND_SOURCE_DEVICE").ok().as_deref(),
            Some("1") | Some("true")
        )
    {
        pb::SynapseSource::Server
    } else {
        pb::SynapseSource::Device
    }
}

fn terminal_device_action(
    action: &str,
    input: &str,
    thought: &str,
    parent: String,
    id: String,
) -> pb::SynapseUnderstandingResponse {
    pb::SynapseUnderstandingResponse {
        response: String::new(),
        is_final: true,
        body: Some(pb::synapse_understanding_response::Body::Turn(
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
                        source: terminal_source(action) as i32,
                    },
                )),
            },
        )),
    }
}

/// The terminal `Respond` action: the device narrates the answer via local TTS
/// (SERVERSIDE-LOGIC §1 line 21). `input` uses the real model-facing field name
/// (`{"Response": "<text>"}`) recovered from the decompiled `RespondAction` schema,
/// so a real pin's `JsonResolver` resolves it. The top-level `response` mirrors
/// the spoken text.
fn respond(answer: &str, parent: String, id: String) -> pb::SynapseUnderstandingResponse {
    let mut msg = terminal_device_action(
        catalog::RESPOND_ACTION,
        &catalog::respond_input(answer),
        "",
        parent,
        id,
    );
    // Must be the SAME text the device speaks. Stripping markup from the action
    // input but not from here quietly broke that mirror — the demo reads this
    // field, so a wearer heard one thing and a reader saw another.
    msg.response = catalog::speakable(answer);
    msg
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::llm::{ChatResponse, LlmError, MockChatModel, ToolCall};
    use crate::assistant::turn::text::MAX_MODEL_FACING_OBSERVATION;

    thread_local! {
        /// Test-only shortening of the run budget. Thread-local because each
        /// test runs on its own thread and `Engine::run` is awaited there, so a
        /// short budget in one test cannot reach a concurrent one.
        static RUN_BUDGET_OVERRIDE: std::cell::Cell<Option<std::time::Duration>> =
            const { std::cell::Cell::new(None) };
    }

    pub(super) fn budget_override() -> Option<std::time::Duration> {
        RUN_BUDGET_OVERRIDE.with(|slot| slot.get())
    }

    /// Shorten the run budget for the rest of this test.
    fn shorten_run_budget(to: std::time::Duration) {
        RUN_BUDGET_OVERRIDE.with(|slot| slot.set(Some(to)));
    }

    /// The response-style contract, enforced over the strings we control.
    ///
    /// Every recovered stock tool set forbids an assistant persona: no first
    /// person, and no apology/regret constructions. That rule was previously
    /// honoured only by asking the model nicely — which says nothing about the
    /// hardcoded strings the server speaks on its own failure paths, and those
    /// had drifted (six sites read "Sorry, I ..."). Those are the strings a
    /// wearer hits precisely when something has already gone wrong, so they are
    /// the ones worth pinning in code.
    #[test]
    fn wearer_facing_strings_carry_no_persona() {
        // Whole words, so "I" does not match inside "Internal" and "my" does not
        // match inside "myself"-free prose like "something".
        const FIRST_PERSON: &[&str] = &["i", "i'm", "i've", "i'll", "me", "my", "mine", "myself"];
        const APOLOGY_STEMS: &[&str] = &["sorry", "apolog", "regret", "afraid", "unfortunately"];

        for text in WEARER_FACING_FAILURE_STRINGS {
            let lowered = text.to_lowercase();
            for word in lowered.split(|c: char| !c.is_ascii_alphanumeric() && c != '\'') {
                assert!(
                    !FIRST_PERSON.contains(&word),
                    "wearer-facing string speaks in the first person ({word:?}): {text:?}"
                );
            }
            for stem in APOLOGY_STEMS {
                assert!(
                    !lowered.contains(stem),
                    "wearer-facing string apologises ({stem:?}): {text:?}"
                );
            }
        }
    }

    struct TextOnlyPolicyAssertingModel;

    #[tonic::async_trait]
    impl ChatModel for TextOnlyPolicyAssertingModel {
        async fn complete(
            &self,
            messages: &[ChatMessage],
            _tools: &[ToolDef],
        ) -> Result<ChatResponse, LlmError> {
            assert!(messages.iter().any(|message| {
                message.role == super::super::llm::Role::System
                    && message.content.contains("is not a connected Pin")
                    && message.content.contains("Do not claim or imply")
            }));
            Ok(ChatResponse {
                content: Some("A connected Pin is required to start that timer.".to_owned()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            })
        }
    }

    /// Collect the full streamed transcript of one engine run.
    async fn drain(
        model: MockChatModel,
        req: pb::SynapseUnderstandingRequest,
    ) -> Vec<pb::SynapseUnderstandingResponse> {
        run_with(Arc::new(model), req).await
    }

    async fn run_with(
        model: Arc<dyn ChatModel>,
        req: pb::SynapseUnderstandingRequest,
    ) -> Vec<pb::SynapseUnderstandingResponse> {
        let engine = Engine::new(model);
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        engine.run(req, tx).await;
        use tokio_stream::StreamExt;
        tokio_stream::wrappers::ReceiverStream::new(rx)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(|r| r.unwrap())
            .collect()
    }

    #[tokio::test]
    async fn text_only_transport_adds_the_no_false_device_success_policy() {
        let engine = Engine::new(Arc::new(TextOnlyPolicyAssertingModel));
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        engine
            .run_text_only(
                pb::SynapseUnderstandingRequest {
                    utterance: "Set a timer for one minute.".to_owned(),
                    excluded_tools: catalog::stateful_excluded_device_tools(),
                    ..Default::default()
                },
                tx,
            )
            .await;
        assert!(rx.recv().await.is_some());
    }

    fn as_action(m: &pb::SynapseUnderstandingResponse) -> Option<&pb::SynapseActionContent> {
        match &m.body {
            Some(pb::synapse_understanding_response::Body::Turn(t)) => match &t.content {
                Some(pb::synapse_chat_turn::Content::Action(a)) => Some(a),
                _ => None,
            },
            _ => None,
        }
    }

    fn as_observation(
        m: &pb::SynapseUnderstandingResponse,
    ) -> Option<&pb::SynapseObservationContent> {
        match &m.body {
            Some(pb::synapse_understanding_response::Body::Turn(t)) => match &t.content {
                Some(pb::synapse_chat_turn::Content::Observation(o)) => Some(o),
                _ => None,
            },
            _ => None,
        }
    }

    fn is_heartbeat(m: &pb::SynapseUnderstandingResponse) -> bool {
        matches!(
            m.body,
            Some(pb::synapse_understanding_response::Body::Heartbeat(_))
        )
    }

    fn is_end(m: &pb::SynapseUnderstandingResponse) -> bool {
        matches!(&m.body,
            Some(pb::synapse_understanding_response::Body::Turn(t))
                if matches!(t.content, Some(pb::synapse_chat_turn::Content::End(_))))
    }

    /// The action/observation turns a legacy device would actually keep.
    fn device_visible(
        msgs: &[pb::SynapseUnderstandingResponse],
    ) -> Vec<&pb::SynapseUnderstandingResponse> {
        msgs.iter()
            .filter(|m| as_action(m).is_some() || as_observation(m).is_some())
            .collect()
    }

    /// Records exactly what the engine handed the model on the first step, then
    /// terminates the run with a plain answer.
    #[derive(Default)]
    struct CapturingModel {
        /// (tool names, concatenated system messages) of the first step.
        seen: std::sync::Mutex<Option<(Vec<String>, String)>>,
    }

    impl CapturingModel {
        fn tools(&self) -> Vec<String> {
            self.seen
                .lock()
                .unwrap()
                .as_ref()
                .expect("the model must have been called")
                .0
                .clone()
        }
        fn system(&self) -> String {
            self.seen
                .lock()
                .unwrap()
                .as_ref()
                .expect("the model must have been called")
                .1
                .clone()
        }
    }

    #[tonic::async_trait]
    impl ChatModel for CapturingModel {
        async fn complete(
            &self,
            messages: &[ChatMessage],
            tools: &[ToolDef],
        ) -> Result<ChatResponse, LlmError> {
            let mut slot = self.seen.lock().unwrap();
            if slot.is_none() {
                *slot = Some((
                    tools.iter().map(|t| t.name.clone()).collect(),
                    messages
                        .iter()
                        .filter(|m| m.role == Role::System)
                        .map(|m| m.content.clone())
                        .collect::<Vec<_>>()
                        .join("\n"),
                ));
            }
            Ok(ChatResponse {
                content: Some("Done.".to_owned()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            })
        }
    }

    fn pointer(set_name: &str, version: i32) -> pb::SynapseUnderstandingRequest {
        pb::SynapseUnderstandingRequest {
            utterance: "set a five minute timer".to_owned(),
            tool_set_version: Some(pb::ToolSetVersion {
                set_name: set_name.to_owned(),
                version,
            }),
            ..Default::default()
        }
    }

    /// WIRING REGRESSION — the largest remaining topology gap.
    ///
    /// carry's device ships an EMPTY `action_definitions` and only a
    /// `tool_set_version` pointer; the server resolves that pointer to a
    /// capability's tool subset AND its own guidance. This engine ignored the
    /// field entirely and served one flat set to every caller, so a `timer@1`
    /// turn was handed music, capture, messaging and web tools.
    ///
    /// Driven end-to-end through `Engine::run` — the production entry point —
    /// because a resolver with no call site would pass its own unit tests while
    /// the wire behaviour never changed.
    #[tokio::test]
    async fn the_devices_tool_set_pointer_selects_the_tools_and_the_prompt() {
        let model = Arc::new(CapturingModel::default());
        let msgs = run_with(model.clone(), pointer("timer", 1)).await;

        let tools = model.tools();
        assert!(
            tools.iter().any(|t| t == "SetTimer"),
            "timer@1 must keep its own tools, got {tools:?}"
        );
        for foreign in [
            "PlayMusic",
            "CapturePhotograph",
            "web_search",
            "ComposeMessage",
        ] {
            assert!(
                !tools.iter().any(|t| t == foreign),
                "timer@1 must not be handed {foreign}, got {tools:?}"
            );
        }
        assert!(
            tools.iter().any(|t| t == catalog::RESPOND_ACTION),
            "every set must still be able to speak, got {tools:?}"
        );
        assert!(
            model.system().contains("countdown timers only"),
            "the set's own guidance must reach the model, got: {}",
            model.system()
        );
        // The run still terminates in a spoken Respond.
        assert!(
            device_visible(&msgs)
                .iter()
                .filter_map(|m| as_action(m))
                .any(|a| a.action == catalog::RESPOND_ACTION),
            "the turn must still end in a spoken Respond"
        );

        // A different pointer selects a different capability.
        let music = Arc::new(CapturingModel::default());
        run_with(music.clone(), pointer("music", 1)).await;
        assert!(music.tools().iter().any(|t| t == "PlayMusic"));
        assert!(!music.tools().iter().any(|t| t == "SetTimer"));
        assert!(music.system().contains("music playback only"));
    }

    /// An unrecognized or absent pointer must never cost the wearer their turn:
    /// it degrades to the flat default set, which is exactly what every caller
    /// that predates the field already gets.
    #[tokio::test]
    async fn an_unknown_tool_set_pointer_degrades_to_the_flat_default() {
        let flat = Arc::new(CapturingModel::default());
        run_with(
            flat.clone(),
            pb::SynapseUnderstandingRequest {
                utterance: "set a five minute timer".to_owned(),
                ..Default::default()
            },
        )
        .await;
        let baseline = flat.tools();
        assert!(baseline.iter().any(|t| t == "PlayMusic"));
        assert!(baseline.iter().any(|t| t == "SetTimer"));
        assert_eq!(
            flat.system(),
            catalog::system_prompt_for(toolsets::default_set()),
            "an unusable pointer must resolve to exactly the DEFAULT set's prompt \
             — compared against the default's own prompt, not the bare base \
             string, so shared additions (the safety block) cannot break this \
             without a real regression"
        );

        for (name, version) in [("no-such-set", 9), ("photography", 1), ("answers", 1)] {
            let model = Arc::new(CapturingModel::default());
            let msgs = run_with(model.clone(), pointer(name, version)).await;
            assert_eq!(
                model.tools(),
                baseline,
                "{name}@{version} must degrade to the default set, not fail the turn"
            );
            assert!(
                device_visible(&msgs)
                    .iter()
                    .filter_map(|m| as_action(m))
                    .any(|a| a.action == catalog::RESPOND_ACTION),
                "{name}@{version} must still produce a spoken turn"
            );
        }

        // A known capability at an unserved revision stays on that capability
        // rather than dropping the wearer into the flat set.
        let old = Arc::new(CapturingModel::default());
        run_with(old.clone(), pointer("settings", 99)).await;
        assert!(old.tools().iter().any(|t| t == "TurnOnWifi"));
        assert!(!old.tools().iter().any(|t| t == "PlayMusic"));
    }

    /// A resolved set narrows the catalog; it never widens it. `excluded_tools`
    /// and the keyguard gate keep applying on top of the set, so a pointer can
    /// never be used to reach a tool the deployment withholds.
    #[tokio::test]
    async fn a_set_pointer_cannot_reopen_a_gated_tool() {
        let model = Arc::new(CapturingModel::default());
        let mut req = pointer("settings", 3);
        req.excluded_tools = vec!["TurnOnWifi".to_owned()];
        req.device_context = Some(pb::SynapseDeviceContext {
            is_locked: true,
            ..Default::default()
        });
        run_with(model.clone(), req).await;

        let tools = model.tools();
        assert!(
            !tools.iter().any(|t| t == "TurnOnWifi"),
            "excluded_tools must still bind inside a resolved set, got {tools:?}"
        );
        assert!(
            !tools.iter().any(|t| t == "PlayMusic"),
            "the resolved settings set must still be the one in force, got {tools:?}"
        );
        for withheld in ["FactoryReset", "Reboot", "TurnOffDevice"] {
            assert!(
                !tools.iter().any(|t| t == withheld),
                "{withheld} is withheld by the deployment and no set may reopen it"
            );
        }
        for tool in &tools {
            assert!(
                catalog::tool_catalog().iter().any(|t| &t.name == tool),
                "{tool} is not in the deployment catalog — a set widened it"
            );
        }
    }

    /// WIRING REGRESSION: required-slot repair must be live on the emission path,
    /// not merely available as a function.
    ///
    /// `catalog::device_action_input` existed, was tested, and had ZERO production
    /// call sites — both transports called `with_device_defaults` instead, so a
    /// model that omitted `Request` still put a null-bearing action on the wire.
    /// A unit test over the helper cannot catch that; only driving the engine can.
    /// This asserts the repaired slot actually reaches the device turn.
    #[tokio::test]
    async fn a_missing_required_slot_is_repaired_before_the_action_is_emitted() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: None,
            thought: String::new(),
            tool_call: Some(ToolCall {
                name: "Settings".into(),
                // The model omits `Request` entirely — the case that NPEs the
                // Settings agent in-process on the device.
                arguments: "{}".into(),
            }),
            extra_tool_calls: Vec::new(),
        }]);
        let msgs = run_with(
            Arc::new(model),
            pb::SynapseUnderstandingRequest {
                utterance: "turn on wifi".into(),
                ..Default::default()
            },
        )
        .await;

        let emitted = device_visible(&msgs);
        let action = emitted
            .iter()
            .filter_map(|m| as_action(m))
            .find(|a| a.action == "Settings")
            .expect("the Settings action must be emitted");
        let input: serde_json::Value =
            serde_json::from_str(&action.input).expect("input must be a JSON object");
        assert_eq!(
            input.get("Request").and_then(|v| v.as_str()),
            Some("turn on wifi"),
            "the required Request slot must be backfilled from the wearer's own \
             words before the action leaves the server, got {}",
            action.input
        );
    }

    /// A long tool result must be clipped for the MODEL but not for the device.
    ///
    /// The observation text is paid for twice: once in prompt tokens and again in
    /// the latency of every later step. Measured here, an over-verbose search
    /// answer preceded a ~6.5s model step. The device, though, is the consumer of
    /// record — clipping what it receives would be a parity change, so only the
    /// transcript copy is bounded.
    #[test]
    fn a_long_observation_is_clipped_for_the_model_only() {
        let long = format!(
            "The next game is Friday at 7 PM. {}",
            "Extra schedule detail and source links. ".repeat(80)
        );
        assert!(long.len() > MAX_MODEL_FACING_OBSERVATION);

        let clipped = model_facing_observation(&long);
        assert!(
            clipped.len() < long.len(),
            "an over-long observation must not re-enter the transcript whole",
        );
        assert!(
            clipped.contains("The next game is Friday at 7 PM."),
            "the useful head of the answer must survive the clip",
        );
        assert!(
            clipped.ends_with("… [truncated]"),
            "the model must be told the text was cut, not handed a fragment that \
             looks complete",
        );

        // Short results are passed through untouched and without allocating.
        let short = "It is 12 degrees and clear.";
        assert!(matches!(
            model_facing_observation(short),
            std::borrow::Cow::Borrowed(_)
        ));
    }

    /// Multi-byte text must not panic the clip. Byte-offset slicing on non-ASCII
    /// has been a recurring defect in this codebase.
    #[test]
    fn clipping_never_splits_a_multibyte_character() {
        let text = "café ".repeat(600);
        assert!(text.len() > MAX_MODEL_FACING_OBSERVATION);
        let clipped = model_facing_observation(&text);
        assert!(clipped.chars().count() > 0);
    }

    /// Restored multi-tool: a model that batches independent lookups must have
    /// ALL of them executed, in ONE step.
    ///
    /// Every recovered stock tool set ships a parallel-invocation wrapper telling
    /// the model to batch independent calls. The driver used to keep the first
    /// and drop the rest silently — so the dropped call was never observed, the
    /// model could answer as though it had run, and the turn burned a second
    /// model round trip (the dominant cost) to fetch what it had already asked
    /// for.
    #[tokio::test]
    async fn batched_server_tool_calls_are_all_executed_in_one_step() {
        struct BatchThenAnswer;
        #[tonic::async_trait]
        impl ChatModel for BatchThenAnswer {
            async fn complete(
                &self,
                messages: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                // Second visit: both observations must already be in context.
                if messages.iter().any(|m| m.content.starts_with("[Called ")) {
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

        let msgs = run_with(
            Arc::new(BatchThenAnswer),
            pb::SynapseUnderstandingRequest {
                utterance: "how tall is the eiffel tower in feet".into(),
                ..Default::default()
            },
        )
        .await;

        let names: Vec<String> = msgs
            .iter()
            .filter_map(as_action)
            .map(|a| a.action.clone())
            .collect();
        assert!(
            names.iter().any(|n| n == "wikipedia") && names.iter().any(|n| n == "wolfram"),
            "both batched calls must be dispatched, not just the first: {names:?}",
        );

        // And both must be OBSERVED — an executed call the model never sees is
        // the same failure as a dropped one.
        let observed: Vec<String> = msgs
            .iter()
            .filter_map(as_observation)
            .map(|o| o.action_name.clone())
            .collect();
        assert!(
            observed.iter().any(|n| n == "wikipedia") && observed.iter().any(|n| n == "wolfram"),
            "every dispatched call must return an observation: {observed:?}",
        );

        // One model step for the batch, so the run still ends on a spoken answer.
        let kept = device_visible(&msgs);
        let last = kept.last().expect("a terminal turn");
        assert_eq!(
            as_action(last).map(|a| a.action.as_str()),
            Some(catalog::RESPOND_ACTION),
        );
    }

    /// WIRING: the registry's safety rules must reach the MODEL, on a real turn.
    ///
    /// `prompts/registry.json` sat unwired for a long time — 22 authored prompts
    /// the engine never opened, because the release image ships only the binary
    /// and a runtime read would have failed in the container. They are embedded
    /// now, but embedding is not wiring: this drives `Engine::run` and inspects
    /// what the model was actually handed, because a helper test would pass just
    /// as happily with zero production call sites.
    #[tokio::test]
    async fn the_registry_safety_rules_reach_the_model() {
        struct CapturingModel(std::sync::Mutex<Option<String>>);
        #[tonic::async_trait]
        impl ChatModel for CapturingModel {
            async fn complete(
                &self,
                messages: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                *self.0.lock().unwrap() = messages
                    .iter()
                    .find(|m| m.role == Role::System)
                    .map(|m| m.content.clone());
                Ok(ChatResponse {
                    content: Some("Done.".to_owned()),
                    ..Default::default()
                })
            }
        }

        let model = Arc::new(CapturingModel(std::sync::Mutex::new(None)));
        let _ = run_with(
            model.clone(),
            pb::SynapseUnderstandingRequest {
                utterance: "hello".into(),
                ..Default::default()
            },
        )
        .await;

        let system = model.0.lock().unwrap().clone().expect("a system message");
        assert!(
            system.contains("not authority"),
            "the untrusted-content rule must reach the model — it is the only \
             thing standing between a search result's embedded instructions and \
             the wearer's turn: {system:.400}",
        );
        assert!(
            system.contains("minimum private context"),
            "the privacy rule must reach the model: {system:.400}",
        );
    }

    /// A model that never names a tool in the resolved catalog.
    struct AlwaysUnknownTool;

    #[tonic::async_trait]
    impl ChatModel for AlwaysUnknownTool {
        async fn complete(
            &self,
            _m: &[ChatMessage],
            _t: &[ToolDef],
        ) -> Result<ChatResponse, LlmError> {
            Ok(ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(ToolCall {
                    name: "TotallyNotARealTool".into(),
                    arguments: "{}".into(),
                }),
                extra_tool_calls: Vec::new(),
            })
        }
    }

    /// The stream must never end on an observation.
    ///
    /// `processLegacySupervisorOnlyChatTurns` dispatches a collected turn only
    /// when the LAST element `hasAction()`; an observation in that slot is
    /// recorded and never dispatched, and no error path fires. So a run that
    /// exhausts its budget on unrecognized tool names used to end in total
    /// silence — the wearer hears nothing, not even the stock apology.
    #[tokio::test]
    async fn a_runaway_unknown_tool_still_ends_in_a_spoken_respond() {
        let msgs = run_with(
            Arc::new(AlwaysUnknownTool),
            pb::SynapseUnderstandingRequest {
                utterance: "x".into(),
                ..Default::default()
            },
        )
        .await;

        let kept = device_visible(&msgs);
        let last = kept.last().expect("at least one device-visible turn");
        let action = as_action(last).expect(
            "the LAST device-visible turn must be an ACTION: the device dispatches \
             only when the final collected element hasAction(), so ending on an \
             observation is silence",
        );
        assert_eq!(action.action, catalog::RESPOND_ACTION);
        assert_eq!(
            spoken_text(&action.input).as_deref(),
            Some(TOO_MANY_ACTIONS),
            "budget exhaustion speaks the stock runaway string"
        );
    }

    /// Blank model content must not become an empty `Respond`.
    ///
    /// `RespondAction.mResponse` is a present-but-empty slot: the device resolves
    /// the action, dispatches it, narrates nothing, and the resulting observation
    /// is final — so the run ends having said nothing and nothing retries.
    #[tokio::test]
    async fn blank_model_content_is_not_spoken_as_an_empty_respond() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: Some("   ".to_owned()),
            thought: String::new(),
            tool_call: None,
            extra_tool_calls: Vec::new(),
        }]);
        let msgs = run_with(
            Arc::new(model),
            pb::SynapseUnderstandingRequest {
                utterance: "x".into(),
                ..Default::default()
            },
        )
        .await;

        let kept = device_visible(&msgs);
        let last = kept.last().expect("a terminal turn");
        let action = as_action(last).expect("the run must end on an action");
        assert_eq!(action.action, catalog::RESPOND_ACTION);
        let spoken = spoken_text(&action.input).unwrap_or_default();
        assert!(
            !spoken.trim().is_empty(),
            "a terminal Respond must carry speakable text, got {spoken:?}"
        );
    }

    #[tokio::test]
    async fn react_loop_streams_action_observation_respond_end() {
        let model = MockChatModel::tool_then_answer(
            ToolCall {
                name: "web_search".into(),
                arguments: r#"{"query":"capital of France"}"#.into(),
            },
            "Paris is the capital of France.",
        );
        let msgs = drain(
            model,
            pb::SynapseUnderstandingRequest {
                utterance: "what's the capital of France".into(),
                ..Default::default()
            },
        )
        .await;

        // action, observation, terminal Respond, end marker. No leading
        // heartbeat: the legacy consumer keeps only action/observation turns and
        // logs anything else as an "Unexpected TAO response".
        assert_eq!(msgs.len(), 4);
        assert!(
            !msgs.iter().any(is_heartbeat),
            "no heartbeat on the legacy stream"
        );
        assert!(is_end(&msgs[3]));

        let a1 = as_action(&msgs[0]).expect("action turn");
        assert_eq!(a1.action, "web_search");
        assert_eq!(a1.source, pb::SynapseSource::Server as i32);
        // No device context => first node self-roots.
        if let Some(pb::synapse_understanding_response::Body::Turn(t)) = &msgs[0].body {
            assert_eq!(t.parent_identifier, "");
        }

        let o2 = as_observation(&msgs[1]).expect("observation");
        // The server never marks the run's final observation; the device does.
        assert!(!o2.is_final);

        // Terminal Respond, with the real decompiled field name.
        let a3 = as_action(&msgs[2]).expect("terminal Respond action");
        assert_eq!(a3.action, "Respond");
        assert_eq!(a3.source, pb::SynapseSource::Server as i32);
        let parsed: serde_json::Value = serde_json::from_str(&a3.input).unwrap();
        assert_eq!(parsed["Response"], "Paris is the capital of France.");
        assert!(msgs[2].is_final);

        // What a legacy device keeps: action, observation, Respond — and the LAST
        // action it dispatches is the Respond that speaks the answer.
        let kept = device_visible(&msgs);
        assert_eq!(kept.len(), 3);
        let last_action = kept.iter().rev().find_map(|m| as_action(m)).unwrap();
        assert_eq!(last_action.action, "Respond");
    }

    #[tokio::test]
    async fn unknown_tool_bounces_the_stock_unrecognized_observation_and_loops() {
        // Model hallucinates a tool, gets the stock bounce, then answers.
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
        let msgs = drain(
            model,
            pb::SynapseUnderstandingRequest {
                utterance: "x".into(),
                ..Default::default()
            },
        )
        .await;

        let obs = msgs
            .iter()
            .find_map(as_observation)
            .expect("bounce observation");
        assert_eq!(obs.observation, UNRECOGNIZED_FUNCTION);
        // Stock tags the bounce as device-sourced.
        assert_eq!(obs.source, pb::SynapseSource::Device as i32);
        assert!(!obs.is_final);
        // The run still ends in a spoken Respond.
        let last_action = device_visible(&msgs)
            .iter()
            .rev()
            .find_map(|m| as_action(m))
            .unwrap()
            .clone();
        assert_eq!(last_action.action, "Respond");
    }

    #[tokio::test]
    async fn excluded_tools_are_removed_from_the_catalog() {
        let req = pb::SynapseUnderstandingRequest {
            utterance: "x".into(),
            excluded_tools: vec!["web_search".into(), "SetTimer".into()],
            ..Default::default()
        };
        let tools = resolve_catalog(&req, true);
        assert!(!tools.iter().any(|t| t.name == "web_search"));
        assert!(!tools.iter().any(|t| t.name == "SetTimer"));
        // Everything else survives.
        assert!(tools.iter().any(|t| t.name == "Respond"));
        assert!(tools.iter().any(|t| t.name == "recall_memory"));
    }

    #[tokio::test]
    async fn device_context_turns_rebuild_the_conversation() {
        let req = pb::SynapseUnderstandingRequest {
            utterance: "and what about Berlin?".into(),
            previous_answers: vec!["Paris is the capital of France.".into()],
            device_context: Some(pb::SynapseDeviceContext {
                turns: vec![
                    pb::SynapseChatTurn {
                        identifier: "d1".into(),
                        content: Some(pb::synapse_chat_turn::Content::UserRequest(
                            pb::SynapseUserRequestContent {
                                request: "what's the capital of France".into(),
                                ..Default::default()
                            },
                        )),
                        ..Default::default()
                    },
                    pb::SynapseChatTurn {
                        identifier: "d2".into(),
                        content: Some(pb::synapse_chat_turn::Content::Action(
                            pb::SynapseActionContent {
                                action: "Respond".into(),
                                input: r#"{"Response":"Paris."}"#.into(),
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
        let history = build_history(&req);
        let joined: Vec<_> = history.iter().map(|m| m.content.as_str()).collect();
        assert!(joined.iter().any(|c| c.contains("capital of France")));
        // A prior Respond replays as assistant speech, unwrapped from its JSON.
        assert!(
            history
                .iter()
                .any(|m| m.role == crate::assistant::llm::Role::Assistant && m.content == "Paris.")
        );
        // previous_answers replay too, and the new utterance is last.
        assert!(
            history
                .iter()
                .any(|m| m.content.contains("Paris is the capital"))
        );
        assert_eq!(history.last().unwrap().content, "and what about Berlin?");
    }

    #[tokio::test]
    async fn roots_first_action_on_device_context_turn() {
        let root = pb::SynapseChatTurn {
            identifier: "device-root-uuid".into(),
            parent_identifier: String::new(),
            ..Default::default()
        };
        let model = MockChatModel::tool_then_answer(
            ToolCall {
                name: "web_search".into(),
                arguments: r#"{"query":"x"}"#.into(),
            },
            "done",
        );
        let msgs = drain(
            model,
            pb::SynapseUnderstandingRequest {
                utterance: "x".into(),
                device_context: Some(pb::SynapseDeviceContext {
                    turns: vec![root],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await;

        // First *turn* (after the heartbeat) parents onto the device-replayed root.
        let first_turn = msgs.iter().find(|m| as_action(m).is_some()).unwrap();
        if let Some(pb::synapse_understanding_response::Body::Turn(t)) = &first_turn.body {
            assert_eq!(t.parent_identifier, "device-root-uuid");
        } else {
            panic!("expected a turn");
        }
    }

    #[tokio::test]
    async fn device_tool_call_is_emitted_as_a_single_terminal_device_action() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: None,
            thought: "the wearer wants a timer".into(),
            tool_call: Some(ToolCall {
                name: "SetTimer".into(),
                arguments: r#"{"minuteDuration":5,"name":"pasta"}"#.into(),
            }),
            extra_tool_calls: Vec::new(),
        }]);
        let msgs = drain(
            model,
            pb::SynapseUnderstandingRequest {
                utterance: "set a 5 minute pasta timer".into(),
                ..Default::default()
            },
        )
        .await;

        // terminal device action, end marker. No fabricated observation, and no
        // leading heartbeat on the legacy stream.
        assert_eq!(msgs.len(), 2);
        assert!(is_end(&msgs[1]));
        assert!(msgs.iter().all(|m| as_observation(m).is_none()));

        let a = as_action(&msgs[0]).expect("terminal device action");
        assert_eq!(a.action, "SetTimer");
        assert_eq!(a.source, pb::SynapseSource::Device as i32);
        assert_eq!(a.thought, "the wearer wants a timer");
        assert!(msgs[0].is_final);
        let parsed: serde_json::Value = serde_json::from_str(&a.input).unwrap();
        assert_eq!(parsed["minuteDuration"], 5);
        assert_eq!(parsed["name"], "pasta");
    }

    #[tokio::test]
    async fn action_budget_exhaustion_yields_too_many_actions_then_respond() {
        // A model that only ever calls the server tool: it can never finish.
        struct AlwaysSearch;
        #[tonic::async_trait]
        impl ChatModel for AlwaysSearch {
            async fn complete(
                &self,
                _m: &[ChatMessage],
                _t: &[ToolDef],
            ) -> Result<ChatResponse, crate::assistant::llm::LlmError> {
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
        let msgs = run_with(
            Arc::new(AlwaysSearch),
            pb::SynapseUnderstandingRequest {
                utterance: "loop forever".into(),
                ..Default::default()
            },
        )
        .await;

        // The run is bounded and still ends in a spoken Respond.
        let too_many = msgs
            .iter()
            .filter_map(as_observation)
            .find(|o| o.observation == TOO_MANY_ACTIONS)
            .expect("TooManyActions observation");
        assert_eq!(too_many.action_name, "TooManyActions");
        let last_action = device_visible(&msgs)
            .iter()
            .rev()
            .find_map(|m| as_action(m))
            .unwrap()
            .clone();
        assert_eq!(last_action.action, "Respond");
        assert!(is_end(msgs.last().unwrap()));
    }

    #[tokio::test]
    async fn a_blocked_device_action_is_rewritten_into_the_degraded_experience() {
        // An unauthorized device blocks every action; carry does not go silent —
        // it records a NON-final blocking observation and dispatches a
        // self-generated device action that runs the canned local experience.
        use crate::services::gates::Entitlement;
        use cosmos_protocol::account::UnauthorizedStatusCode;
        let model = MockChatModel::new(vec![ChatResponse {
            content: None,
            thought: String::new(),
            tool_call: Some(ToolCall {
                name: "SetTimer".into(),
                arguments: r#"{"minuteDuration":5}"#.into(),
            }),
            extra_tool_calls: Vec::new(),
        }]);
        let engine = Engine::with_entitlement(
            Arc::new(model),
            Entitlement::unauthorized(vec![UnauthorizedStatusCode::DeviceLostOrStolen]),
        );
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        engine
            .run(
                pb::SynapseUnderstandingRequest {
                    utterance: "set a timer".into(),
                    ..Default::default()
                },
                tx,
            )
            .await;
        use tokio_stream::StreamExt;
        let msgs: Vec<_> = tokio_stream::wrappers::ReceiverStream::new(rx)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(|r| r.unwrap())
            .collect();

        // The blocking observation is recorded and is NOT final (so the chain is
        // rewritten, not terminated as an error).
        let obs = msgs
            .iter()
            .find_map(as_observation)
            .expect("blocking observation");
        assert!(!obs.is_final);
        assert_eq!(obs.source, pb::SynapseSource::Device as i32);

        // SetTimer never reaches the device; the degraded action does.
        let actions: Vec<_> = msgs.iter().filter_map(as_action).collect();
        assert!(!actions.iter().any(|a| a.action == "SetTimer"));
        let dispatched = actions.last().expect("a synthesized action is dispatched");
        assert_eq!(dispatched.action, "UnauthorizedDevice");
        assert_eq!(dispatched.source, pb::SynapseSource::Device as i32);
    }

    /// REGRESSION: a multi-hop run issues a FRESH `Understand` RPC per hop while
    /// replaying every prior turn. Server-minted ids must never repeat an id the
    /// device already holds — `LocalChatTurnService.record` throws on a duplicate
    /// (`ArgChecker.throwIfContainsKey`) and the run dies on the device.
    #[tokio::test]
    async fn server_minted_ids_never_collide_across_hops() {
        use std::collections::HashSet;
        let mut seen: HashSet<String> = HashSet::new();
        let mut replayed: Vec<pb::SynapseChatTurn> = Vec::new();

        // Three hops, each replaying everything the device has accumulated.
        for _ in 0..3 {
            let model = MockChatModel::tool_then_answer(
                ToolCall {
                    name: "web_search".into(),
                    arguments: r#"{"query":"x"}"#.into(),
                },
                "done",
            );
            let msgs = drain(
                model,
                pb::SynapseUnderstandingRequest {
                    utterance: "x".into(),
                    device_context: Some(pb::SynapseDeviceContext {
                        turns: replayed.clone(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await;

            for m in &msgs {
                if let Some(pb::synapse_understanding_response::Body::Turn(t)) = &m.body {
                    if t.identifier.is_empty() {
                        continue; // the end marker carries no id
                    }
                    assert!(
                        seen.insert(t.identifier.clone()),
                        "duplicate server-minted id {} would throw on the device",
                        t.identifier
                    );
                    replayed.push(t.clone());
                }
            }
        }
        assert!(seen.len() >= 9, "each hop mints fresh ids");
    }

    /// A locked pin only runs actions whose stock class is
    /// `@Action(enabledInKeyguard=true)`. Offering the rest would produce an
    /// action the device silently refuses.
    #[tokio::test]
    async fn keyguard_restricts_the_catalog_to_lock_screen_actions() {
        let locked = pb::SynapseUnderstandingRequest {
            utterance: "x".into(),
            device_context: Some(pb::SynapseDeviceContext {
                is_locked: true,
                ..Default::default()
            }),
            ..Default::default()
        };
        let tools = resolve_catalog(&locked, true);
        // CreateContact is enabledInKeyguard=false in the stock class.
        assert!(!tools.iter().any(|t| t.name == "CreateContact"));
        // Respond and the timer actions stay available on the lock screen.
        assert!(tools.iter().any(|t| t.name == "Respond"));
        assert!(tools.iter().any(|t| t.name == "SetTimer"));

        // Unlocked, the full catalog is offered.
        let unlocked = pb::SynapseUnderstandingRequest {
            utterance: "x".into(),
            ..Default::default()
        };
        assert!(
            resolve_catalog(&unlocked, true)
                .iter()
                .any(|t| t.name == "CreateContact")
        );
    }

    /// Every emitted turn must carry a wall-clock stamp: an absent timestamp
    /// decodes as epoch 0, sorting server nodes first in the device's turn queue
    /// (so they evict first) and making the inter-run gap test see ~56 years.
    #[tokio::test]
    async fn every_emitted_turn_is_timestamped() {
        let model = MockChatModel::tool_then_answer(
            ToolCall {
                name: "web_search".into(),
                arguments: r#"{"query":"x"}"#.into(),
            },
            "done",
        );
        let msgs = drain(
            model,
            pb::SynapseUnderstandingRequest {
                utterance: "x".into(),
                ..Default::default()
            },
        )
        .await;
        let mut checked = 0;
        for m in &msgs {
            if let Some(pb::synapse_understanding_response::Body::Turn(t)) = &m.body {
                if t.identifier.is_empty() {
                    continue; // end marker
                }
                let ts = t.timestamp.as_ref().expect("turn must be timestamped");
                assert!(ts.seconds > 1_700_000_000, "must be a real wall clock");
                checked += 1;
            }
        }
        assert!(checked >= 3, "action, observation, and Respond all stamped");
    }

    /// REGRESSION: `device_context.turns` is MULTI-run (the device stitches prior
    /// complete runs into a `tao.maximumSecondsBetweenRuns = 180s` window), but the
    /// action ceiling is PER-run. Seeding the budget from the whole window made the
    /// assistant degrade the longer a wearer talked to it — from ~the 5th exchange,
    /// every tool-using turn died in the runaway apology.
    #[tokio::test]
    async fn prior_completed_runs_do_not_consume_the_current_runs_budget() {
        // Eight prior COMPLETE exchanges, each its own run: a user root, a server
        // action, its observation, and the terminal Respond. That is 16 action
        // nodes of history — double the ceiling.
        let mut replayed: Vec<pb::SynapseChatTurn> = Vec::new();
        for exchange in 0..8 {
            let root = format!("user-{exchange}");
            let act = format!("act-{exchange}");
            let obs = format!("obs-{exchange}");
            replayed.push(pb::SynapseChatTurn {
                identifier: root.clone(),
                parent_identifier: String::new(), // a run root
                content: Some(pb::synapse_chat_turn::Content::UserRequest(
                    pb::SynapseUserRequestContent {
                        request: format!("question {exchange}"),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            });
            replayed.push(pb::SynapseChatTurn {
                identifier: act.clone(),
                parent_identifier: root,
                content: Some(pb::synapse_chat_turn::Content::Action(
                    pb::SynapseActionContent {
                        action: "web_search".into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            });
            replayed.push(pb::SynapseChatTurn {
                identifier: obs.clone(),
                parent_identifier: act,
                content: Some(pb::synapse_chat_turn::Content::Observation(
                    pb::SynapseObservationContent {
                        observation: "…".into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            });
            replayed.push(pb::SynapseChatTurn {
                identifier: format!("resp-{exchange}"),
                parent_identifier: obs,
                content: Some(pb::synapse_chat_turn::Content::Action(
                    pb::SynapseActionContent {
                        action: "Respond".into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            });
        }
        assert_eq!(
            replayed
                .iter()
                .filter(|t| matches!(t.content, Some(pb::synapse_chat_turn::Content::Action(_))))
                .count(),
            16,
            "history alone must exceed the ceiling for this test to mean anything"
        );

        // Only the LAST run's actions count, and the newest turn's chain here is
        // the 8th exchange: act + Respond = 2.
        assert_eq!(actions_in_current_run(&replayed), 2);

        // A fresh tool-using turn must still complete normally.
        let model = MockChatModel::tool_then_answer(
            ToolCall {
                name: "web_search".into(),
                arguments: r#"{"query":"x"}"#.into(),
            },
            "Paris.",
        );
        let msgs = drain(
            model,
            pb::SynapseUnderstandingRequest {
                utterance: "and the ninth question".into(),
                device_context: Some(pb::SynapseDeviceContext {
                    turns: replayed,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await;

        assert!(
            !msgs
                .iter()
                .filter_map(as_observation)
                .any(|o| o.observation == TOO_MANY_ACTIONS),
            "a long conversation must not exhaust the per-run budget"
        );
        let terminal = device_visible(&msgs)
            .iter()
            .rev()
            .find_map(|m| as_action(m))
            .expect("terminal action")
            .clone();
        assert_eq!(terminal.action, "Respond");
        let spoken: serde_json::Value = serde_json::from_str(&terminal.input).unwrap();
        assert_eq!(spoken["Response"], "Paris.");
    }

    /// The ceiling still binds within a single long run.
    #[tokio::test]
    async fn a_single_run_that_is_already_at_the_ceiling_still_trips() {
        // One run: root -> 8 chained action nodes.
        let mut chain: Vec<pb::SynapseChatTurn> = vec![pb::SynapseChatTurn {
            identifier: "root".into(),
            parent_identifier: String::new(),
            content: Some(pb::synapse_chat_turn::Content::UserRequest(
                pb::SynapseUserRequestContent::default(),
            )),
            ..Default::default()
        }];
        for i in 0..ACTION_LIMIT {
            let parent = chain.last().unwrap().identifier.clone();
            chain.push(pb::SynapseChatTurn {
                identifier: format!("a{i}"),
                parent_identifier: parent,
                content: Some(pb::synapse_chat_turn::Content::Action(
                    pb::SynapseActionContent {
                        action: "web_search".into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            });
        }
        assert_eq!(actions_in_current_run(&chain), ACTION_LIMIT);
    }

    /// The device replays the current turn's own user_request, so appending the
    /// utterance again shows the model the question twice — and on hop 2+ it
    /// lands after the observations, reading as a fresh re-ask.
    #[tokio::test]
    async fn the_replayed_utterance_is_not_duplicated() {
        let req = pb::SynapseUnderstandingRequest {
            utterance: "what's the weather".into(),
            device_context: Some(pb::SynapseDeviceContext {
                turns: vec![pb::SynapseChatTurn {
                    identifier: "d1".into(),
                    content: Some(pb::synapse_chat_turn::Content::UserRequest(
                        pb::SynapseUserRequestContent {
                            request: "what's the weather".into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        let history = build_history(&req);
        let asked = history
            .iter()
            .filter(|m| m.role == Role::User && m.content == "what's the weather")
            .count();
        assert_eq!(asked, 1, "the question must appear exactly once");

        // With no device context (tests, and any client that does not replay),
        // the utterance still reaches the model.
        let bare = pb::SynapseUnderstandingRequest {
            utterance: "hello".into(),
            ..Default::default()
        };
        assert!(build_history(&bare).iter().any(|m| m.content == "hello"));
    }

    /// WHAT THE WEARER ASKED TO BE REMEMBERED REACHES THE MODEL EVERY TURN.
    ///
    /// Observed live, twice over. "Remember that I like noodles" saved, then
    /// "What do I like?" answered "Nothing about your likes has been established
    /// here" — with no recall call at all. And when the model DID call recall,
    /// "What are my interests?" still failed: `interests` shares zero stemmed
    /// terms with "i like noodles", so the lexical matcher returned nothing and
    /// the wearer was told they had saved nothing about a note they had just
    /// saved. No prompt wording fixes a matcher that cannot bridge a synonym.
    ///
    /// Carrying the facts removes both failure modes: the model needs no tool
    /// decision and no term overlap. This asserts the note text reaches the
    /// model's system context for a question that shares NO words with it.
    #[tokio::test]
    async fn what_the_wearer_asked_to_remember_reaches_the_model() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let principal = "V:01:D:test:U:wearer";
        let note = store
            .create_note(principal, None, None)
            .await
            .expect("note is stored");
        store
            .index_note(principal, &note.uuid, "i like noodles")
            .await;

        let model = Arc::new(CapturingModel::default());
        let engine = Engine::new(model.clone()).with_tools(catalog::ToolContext {
            principal: Some(principal.to_owned()),
            store: Some(store.clone()),
            ..Default::default()
        });
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        engine
            .run(
                pb::SynapseUnderstandingRequest {
                    // Deliberately shares no term with the note.
                    utterance: "what are my interests".into(),
                    ..Default::default()
                },
                tx,
            )
            .await;
        while rx.recv().await.is_some() {}

        let system = model.system();
        assert!(
            system.contains("i like noodles"),
            "the saved fact must reach the model without a lookup; system was:\n{system}"
        );
        assert!(
            system.contains("asked you to remember"),
            "the facts must be labelled as established facts about the wearer"
        );
    }

    /// A wearer with nothing saved gets NO facts block — an empty one would be a
    /// claim ("you have saved nothing") on a turn that never looked.
    #[tokio::test]
    async fn a_wearer_with_no_saved_facts_gets_no_block() {
        let store: crate::store::SharedStore =
            std::sync::Arc::new(crate::store::MemoryStore::default());
        let model = Arc::new(CapturingModel::default());
        let engine = Engine::new(model.clone()).with_tools(catalog::ToolContext {
            principal: Some("V:01:D:test:U:empty".to_owned()),
            store: Some(store),
            ..Default::default()
        });
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        engine
            .run(
                pb::SynapseUnderstandingRequest {
                    utterance: "what are my interests".into(),
                    ..Default::default()
                },
                tx,
            )
            .await;
        while rx.recv().await.is_some() {}
        assert!(
            !model.system().contains("asked you to remember"),
            "no saved facts must mean no facts block at all"
        );
    }

    /// The wearer's own time/place must reach the model — otherwise every
    /// time-relative or place-relative question is answered blind.
    #[tokio::test]
    async fn the_wearers_situation_reaches_the_model() {
        let req = pb::SynapseUnderstandingRequest {
            utterance: "is it late".into(),
            device_context: Some(pb::SynapseDeviceContext {
                situation: Some(pb::SynapseUserSituation {
                    timestamp: Some(prost_types::Timestamp {
                        seconds: 1_800_000_000,
                        nanos: 0,
                    }),
                    time_zone_id: "Europe/Copenhagen".into(),
                    ..Default::default()
                }),
                reverse_geocoded_location: "Copenhagen, Denmark".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let history = build_history(&req);
        let context = history
            .iter()
            .filter(|m| m.role == Role::System)
            .map(|m| m.content.clone())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(context.contains("Europe/Copenhagen"));
        assert!(context.contains("1800000000"));
        assert!(context.contains("Copenhagen, Denmark"));

        // Absent fields must NOT be defaulted — a placeholder zone or a (0,0)
        // coordinate is fabricated device state the model would trust.
        let bare = pb::SynapseUnderstandingRequest {
            utterance: "hi".into(),
            ..Default::default()
        };
        assert!(situation_line(&bare).is_none());
        let empty_ctx = pb::SynapseUnderstandingRequest {
            utterance: "hi".into(),
            device_context: Some(pb::SynapseDeviceContext::default()),
            ..Default::default()
        };
        let line = situation_line(&empty_ctx).unwrap_or_default();
        assert!(!line.contains("0.00000"), "must not invent coordinates");
        assert!(
            !line.to_lowercase().contains("utc"),
            "must not invent a zone"
        );
    }

    #[tokio::test]
    async fn demo_model_is_stateless_across_repeated_runs() {
        use crate::assistant::llm::DemoChatModel;
        let model: Arc<dyn ChatModel> = Arc::new(DemoChatModel);
        for _ in 0..3 {
            let msgs = run_with(
                model.clone(),
                pb::SynapseUnderstandingRequest {
                    utterance: "anything".into(),
                    ..Default::default()
                },
            )
            .await;
            let kept = device_visible(&msgs);
            // web_search action, observation, terminal Respond — every time.
            assert_eq!(kept.len(), 3, "each run must complete the full loop");
            let terminal = as_action(kept[2]).expect("terminal Respond");
            assert_eq!(terminal.action, "Respond");
            let parsed: serde_json::Value = serde_json::from_str(&terminal.input).unwrap();
            let spoken = parsed["Response"].as_str().unwrap();
            // Operational detail belongs in health surfaces, not in spoken copy.
            assert_eq!(spoken, "This request can't be completed right now.");
            assert!(
                !spoken.contains("search backend is configured"),
                "must not misreport a backend that may be live, got: {spoken}"
            );
        }
    }

    #[tokio::test]
    async fn answer_only_turn_is_a_single_terminal_respond() {
        let model = MockChatModel::new(vec![ChatResponse {
            content: Some("Hello there.".into()),
            thought: String::new(),
            tool_call: None,
            extra_tool_calls: Vec::new(),
        }]);
        let msgs = drain(
            model,
            pb::SynapseUnderstandingRequest {
                utterance: "hi".into(),
                ..Default::default()
            },
        )
        .await;
        let kept = device_visible(&msgs);
        assert_eq!(kept.len(), 1);
        let a = as_action(kept[0]).expect("terminal Respond");
        assert_eq!(a.action, "Respond");
        assert_eq!(a.source, pb::SynapseSource::Server as i32);
    }

    /// A user-request turn as the device replays it, optionally carrying the
    /// vision gesture and the frame it prefetched.
    fn vision_request(
        vision: pb::synapse_user_request_content::VisionRequested,
        frame: &[u8],
    ) -> pb::SynapseUnderstandingRequest {
        pb::SynapseUnderstandingRequest {
            utterance: "what is this?".into(),
            device_context: Some(pb::SynapseDeviceContext {
                turns: vec![pb::SynapseChatTurn {
                    identifier: "u1".into(),
                    content: Some(pb::synapse_chat_turn::Content::UserRequest(
                        pb::SynapseUserRequestContent {
                            request: "what is this?".into(),
                            vision_requested: vision as i32,
                            image_data: frame.to_vec(),
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

    /// THE VISION GESTURE MUST REACH THE MODEL.
    ///
    /// `SynapseUserRequestContent` carries `vision_requested` (field 5) and
    /// `image_data` (field 8); `IntentRecognitionAction.visionRequested()` sets
    /// VISION when the wearer aimed the pin. `build_history` read only the text
    /// fields, so the one interaction where the wearer physically pointed the
    /// device arrived as a bare "what is this?" and the model answered blind.
    ///
    /// Driven through `Engine::run` — the production entry point — because the
    /// line is only useful if it is actually in the messages the model sees.
    #[tokio::test]
    async fn the_vision_gesture_tells_the_model_the_camera_view_can_be_looked_at() {
        use pb::synapse_user_request_content::VisionRequested;

        let model = Arc::new(CapturingModel::default());
        run_with(model.clone(), vision_request(VisionRequested::Vision, &[])).await;
        let system = model.system();
        assert!(
            system.contains(VISION_ACTION),
            "a vision turn must name the action that looks, got: {system}"
        );
        assert!(
            system.contains("aimed the pin"),
            "a vision turn must tell the model something is being pointed at, got: {system}"
        );

        // A prefetched frame is acknowledged rather than dropped silently.
        let with_frame = Arc::new(CapturingModel::default());
        run_with(
            with_frame.clone(),
            vision_request(VisionRequested::Vision, b"\xff\xd8\xff-not-a-real-jpeg"),
        )
        .await;
        assert!(
            with_frame.system().contains("already captured a frame"),
            "an attached frame must reach the model, got: {}",
            with_frame.system()
        );

        // No gesture, no frame: no vision guidance at all. A line that fires on
        // every turn would push the model at the camera for "what time is it".
        let plain = Arc::new(CapturingModel::default());
        run_with(
            plain.clone(),
            vision_request(VisionRequested::NoVision, &[]),
        )
        .await;
        assert!(
            !plain.system().contains(VISION_ACTION),
            "a non-vision turn must not be pushed at the camera, got: {}",
            plain.system()
        );
    }

    /// A successful look returns to legacy `Understand` as a new RPC with the
    /// original vision-marked request still in the replay. The policy must be
    /// one-shot for that run; otherwise every answer step emits another
    /// `UnderstandScene`, captures another photo, and eventually hits the Pin's
    /// action limit instead of speaking the image observation.
    #[tokio::test]
    async fn a_completed_vision_action_is_not_requested_again_in_the_same_run() {
        use pb::synapse_user_request_content::VisionRequested;

        let mut request = vision_request(VisionRequested::Vision, &[]);
        let turns = &mut request.device_context.as_mut().unwrap().turns;
        turns.push(pb::SynapseChatTurn {
            user: pb::SynapseUser::Assistant as i32,
            identifier: "vision-action".into(),
            parent_identifier: "u1".into(),
            content: Some(pb::synapse_chat_turn::Content::Action(
                pb::SynapseActionContent {
                    action: VISION_ACTION.into(),
                    input: r#"{"Question":"what is this?"}"#.into(),
                    source: pb::SynapseSource::Device as i32,
                    ..Default::default()
                },
            )),
            ..Default::default()
        });
        turns.push(pb::SynapseChatTurn {
            user: pb::SynapseUser::System as i32,
            identifier: "vision-observation".into(),
            parent_identifier: "vision-action".into(),
            content: Some(pb::synapse_chat_turn::Content::Observation(
                pb::SynapseObservationContent {
                    observation: r#"{"description":"a red mug"}"#.into(),
                    source: pb::SynapseSource::Device as i32,
                    ..Default::default()
                },
            )),
            ..Default::default()
        });

        assert!(current_run_contains_action(turns, VISION_ACTION));
        let model = Arc::new(CapturingModel::default());
        run_with(model.clone(), request).await;
        assert!(
            !model.system().contains("aimed the pin"),
            "the post-capture hop must reason from the observation instead of asking the Pin to look again, got: {}",
            model.system()
        );
    }

    /// Device context includes older completed runs. A look in one of them must
    /// not suppress a later, independent vision gesture.
    #[tokio::test]
    async fn a_vision_action_from_an_older_run_does_not_suppress_a_new_gesture() {
        use pb::synapse_user_request_content::VisionRequested;

        let mut request = vision_request(VisionRequested::Vision, &[]);
        let current_root = request
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .pop()
            .unwrap();
        let turns = &mut request.device_context.as_mut().unwrap().turns;
        turns.extend([
            pb::SynapseChatTurn {
                identifier: "old-user".into(),
                content: Some(pb::synapse_chat_turn::Content::UserRequest(
                    pb::SynapseUserRequestContent {
                        request: "what was that?".into(),
                        vision_requested: VisionRequested::Vision as i32,
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
            pb::SynapseChatTurn {
                identifier: "old-vision-action".into(),
                parent_identifier: "old-user".into(),
                content: Some(pb::synapse_chat_turn::Content::Action(
                    pb::SynapseActionContent {
                        action: VISION_ACTION.into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
            pb::SynapseChatTurn {
                identifier: "old-observation".into(),
                parent_identifier: "old-vision-action".into(),
                content: Some(pb::synapse_chat_turn::Content::Observation(
                    pb::SynapseObservationContent {
                        observation: "old scene".into(),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
            current_root,
        ]);

        assert!(!current_run_contains_action(turns, VISION_ACTION));
        let model = Arc::new(CapturingModel::default());
        run_with(model.clone(), request).await;
        assert!(
            model.system().contains("aimed the pin"),
            "a new vision run must still receive the one-shot look instruction, got: {}",
            model.system()
        );
    }

    /// The guidance must never point at a tool this caller does not have, and
    /// must never invite a description of a scene nobody looked at.
    #[tokio::test]
    async fn a_caller_that_cannot_look_is_told_so_instead_of_guessing() {
        use pb::synapse_user_request_content::VisionRequested;

        let mut req = vision_request(VisionRequested::Vision, b"frame");
        // The stateful text-only transport excludes every device action.
        req.excluded_tools = catalog::stateful_excluded_device_tools();

        let model = Arc::new(CapturingModel::default());
        run_with(model.clone(), req).await;
        let system = model.system();
        assert!(
            !system.contains(VISION_ACTION),
            "must not name a tool this caller cannot call, got: {system}"
        );
        assert!(
            system.contains("no tool available here can look"),
            "must say plainly that looking is unavailable, got: {system}"
        );
        assert!(
            system.contains("Never describe what the camera"),
            "must forbid inventing the scene, got: {system}"
        );
    }

    /// THE REPLAYED TRANSCRIPT MUST BE BOUNDED.
    ///
    /// `device_context.turns` is device-supplied and multi-run. Stock caps it at
    /// `tao.contextCapacity = 100`; we cited the constant and never enforced it,
    /// so a long conversation grew every prompt without limit. The cap keeps the
    /// MOST RECENT turns — the ones the current run is threaded onto.
    #[tokio::test]
    async fn the_replayed_transcript_is_capped_at_the_devices_context_capacity() {
        let turns: Vec<pb::SynapseChatTurn> = (0..CONTEXT_CAPACITY * 2)
            .map(|i| pb::SynapseChatTurn {
                identifier: format!("t{i}"),
                content: Some(pb::synapse_chat_turn::Content::UserRequest(
                    pb::SynapseUserRequestContent {
                        request: format!("utterance number {i}"),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            })
            .collect();
        let req = pb::SynapseUnderstandingRequest {
            utterance: "utterance number 199".into(),
            device_context: Some(pb::SynapseDeviceContext {
                turns,
                ..Default::default()
            }),
            ..Default::default()
        };

        let history = build_history(&req);
        let replayed = history
            .iter()
            .filter(|m| m.role == Role::User)
            .collect::<Vec<_>>();
        assert_eq!(
            replayed.len(),
            CONTEXT_CAPACITY,
            "the replayed transcript must be capped at {CONTEXT_CAPACITY} turns, got {}",
            replayed.len()
        );
        assert!(
            !replayed
                .iter()
                .any(|m| m.content == "utterance number 0" || m.content == "utterance number 99"),
            "the oldest turns must be dropped, not the newest"
        );
        assert_eq!(
            replayed.first().unwrap().content,
            "utterance number 100",
            "the kept window must be the most recent one"
        );
        assert_eq!(
            replayed.last().unwrap().content,
            "utterance number 199",
            "the live request must survive the cap"
        );
    }

    /// THE RUN BUDGET MUST COVER TOOL EXECUTION.
    ///
    /// `RUN_BUDGET` was checked only at the top of each loop iteration, and only
    /// the model step was wrapped in a timeout — `execute_tool_with` was awaited
    /// unbounded. A tool started with almost nothing left returns past the
    /// device's 25s `AIMIC_TIMEOUT_MS`, gRPC fires `DEADLINE_EXCEEDED`, and the
    /// pin discards every turn already streamed: the wearer hears nothing we
    /// said. So a tool is never STARTED without room to speak afterwards.
    ///
    /// Driven through `Engine::run` with a shortened budget; the guard itself is
    /// the production one.
    #[tokio::test]
    async fn a_server_tool_is_not_started_without_room_left_to_speak() {
        shorten_run_budget(std::time::Duration::from_millis(2_000));

        /// Burns most of the budget inside the model step, then asks for a
        /// server tool — the shape a real slow first step produces.
        struct SlowThenTool;
        #[tonic::async_trait]
        impl ChatModel for SlowThenTool {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                Ok(ChatResponse {
                    content: None,
                    thought: String::new(),
                    tool_call: Some(ToolCall {
                        name: "web_search".into(),
                        arguments: r#"{"query":"anything"}"#.into(),
                    }),
                    extra_tool_calls: Vec::new(),
                })
            }
        }

        let msgs = run_with(
            Arc::new(SlowThenTool),
            pb::SynapseUnderstandingRequest {
                utterance: "what is happening in the world".into(),
                ..Default::default()
            },
        )
        .await;

        let kept = device_visible(&msgs);
        assert!(
            !kept
                .iter()
                .any(|m| as_action(m).is_some_and(|a| a.action == "web_search")),
            "a tool with no room to finish must not be started, got {:?}",
            kept.iter().filter_map(|m| as_action(m)).collect::<Vec<_>>()
        );
        let terminal = as_action(kept.last().expect("a terminal must still be spoken"))
            .expect("the run must end on an action the device dispatches");
        assert_eq!(terminal.action, catalog::RESPOND_ACTION);
        assert!(
            terminal.input.contains(ERROR_TIMEOUT),
            "the wearer must hear the timeout string, got {}",
            terminal.input
        );
    }

    /// EVERY TERMINAL MUST CLASSIFY ITSELF, AND NEVER AS WEARER TEXT.
    ///
    /// `record_turn` shipped with zero callers, so `carry_turns_total` was
    /// permanently zero — the one metric that says whether wearers are getting
    /// answers read the same during a live regression as on a perfect day.
    /// Wiring it is only useful if the classification is right, and the failure
    /// mode is silent: `respond_input_from_arguments` returns the input JSON
    /// (`{"Response":"…"}`), not the bare text, so an equality check would have
    /// classified every single turn as `empty` and still compiled.
    #[test]
    fn every_terminal_shape_reports_its_own_outcome() {
        let p = || "parent".to_owned();
        assert_eq!(
            turn_outcome(&respond("Paris.", p(), "id".into())),
            "answered"
        );
        assert_eq!(
            turn_outcome(&respond(ERROR_TIMEOUT, p(), "id".into())),
            "deadline"
        );
        assert_eq!(
            turn_outcome(&respond(TOO_MANY_ACTIONS, p(), "id".into())),
            "too_many_actions"
        );
        assert_eq!(
            turn_outcome(&respond(NO_ANSWER, p(), "id".into())),
            "no_answer"
        );
        assert_eq!(
            turn_outcome(&terminal_device_action(
                "PlayMusic",
                r#"{"Query":"miles davis"}"#,
                "",
                p(),
                "id".into()
            )),
            "device_action",
            "a turn the pin performs is a success, not a silence"
        );

        // No arm may leak wearer content into a metric label. The set is closed.
        for outcome in [
            turn_outcome(&respond(
                "some private answer about a person",
                p(),
                "id".into(),
            )),
            turn_outcome(&terminal_device_action(
                "SetTimer",
                r#"{"Duration":"5m"}"#,
                "",
                p(),
                "id".into(),
            )),
        ] {
            assert!(
                [
                    "answered",
                    "deadline",
                    "too_many_actions",
                    "no_answer",
                    "device_action",
                    "empty",
                    "unknown"
                ]
                .contains(&outcome),
                "{outcome} is not one of the bounded outcome constants"
            );
        }
    }

    /// A MODEL FAILURE IS NOT A DEADLINE.
    ///
    /// Every one of these is SPOKEN as the device's own timeout sentence, on
    /// purpose — the wearer hears stock wording on a path where something already
    /// went wrong. Deriving the metric from that sentence therefore filed an
    /// expired `CARRY_LLM_API_KEY`, a provider outage and a malformed body all
    /// as `deadline`, which points the operator at latency and budget. The
    /// spoken string stays; the label has to say what actually happened.
    #[test]
    fn a_refused_model_is_labelled_apart_from_an_exhausted_budget() {
        use crate::assistant::llm::LlmError;
        assert_eq!(
            model_failure_outcome(&LlmError::Status(401)),
            "model_refused"
        );
        assert_eq!(
            model_failure_outcome(&LlmError::Status(429)),
            "model_refused"
        );
        assert_eq!(
            model_failure_outcome(&LlmError::Malformed),
            "model_malformed"
        );
        assert_eq!(
            model_failure_outcome(&LlmError::Transport("connection refused".into())),
            "model_unreachable"
        );
        // Never the error's own message: `Transport` carries a reqwest string
        // that can hold the configured provider URL.
        for error in [
            LlmError::Status(500),
            LlmError::Malformed,
            LlmError::Transport("https://provider.example/v1: dns error".into()),
            LlmError::ScriptExhausted,
        ] {
            let outcome = model_failure_outcome(&error);
            assert!(
                ["model_refused", "model_malformed", "model_unreachable"].contains(&outcome),
                "{outcome} is not one of the bounded model-failure constants"
            );
            assert!(
                !outcome.contains("provider.example"),
                "an error message must not reach a metric label"
            );
        }

        // The spoken sentence is unchanged, which is why the label has to carry
        // the difference at all.
        assert_eq!(
            turn_outcome(&respond(ERROR_TIMEOUT, "parent".to_owned(), "id".into())),
            "deadline",
            "the derived classification still reads the stock sentence as a deadline"
        );
    }

    /// A RUN THAT SPENDS ITS BUDGET MUST STILL ANSWER FROM WHAT IT LEARNED.
    ///
    /// Observed live: "fetch the latest news from ekstrabladet.dk" ran two
    /// searches and a `ask_online` lookup, had a usable result in hand at
    /// t=13.5s, started a THIRD search at t=16.7s, and spoke `ERROR_TIMEOUT` at
    /// t=22s. The wearer waited the full budget and was told something broke,
    /// while the answer sat unread in the transcript.
    ///
    /// So when the tool budget is gone, the remaining time buys one tool-less
    /// model step over the observations already collected.
    #[tokio::test]
    async fn budget_exhaustion_answers_from_the_observations_already_collected() {
        shorten_run_budget(std::time::Duration::from_millis(3_000));

        /// Asks for a tool first, then — once the engine refuses to start one —
        /// composes. Records the tool list it was handed on the composing step.
        #[derive(Default)]
        struct ToolThenCompose {
            calls: std::sync::atomic::AtomicUsize,
            composed_with_tools: std::sync::atomic::AtomicUsize,
        }
        #[tonic::async_trait]
        impl ChatModel for ToolThenCompose {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if call == 0 {
                    // Leaves ~2.5s: past the tool reserve, inside composing range.
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    return Ok(ChatResponse {
                        content: None,
                        thought: String::new(),
                        tool_call: Some(ToolCall {
                            name: "web_search".into(),
                            arguments: r#"{"query":"ekstrabladet latest"}"#.into(),
                        }),
                        extra_tool_calls: Vec::new(),
                    });
                }
                self.composed_with_tools
                    .store(tools.len(), std::sync::atomic::Ordering::SeqCst);
                Ok(ChatResponse {
                    content: Some("Ekstra Bladet's front page could not be read.".into()),
                    thought: String::new(),
                    tool_call: None,
                    extra_tool_calls: Vec::new(),
                })
            }
        }

        let model = Arc::new(ToolThenCompose::default());
        let msgs = run_with(
            model.clone(),
            pb::SynapseUnderstandingRequest {
                utterance: "fetch the latest news from ekstrabladet.dk".into(),
                ..Default::default()
            },
        )
        .await;

        let kept = device_visible(&msgs);
        let terminal = as_action(kept.last().expect("a terminal must still be spoken"))
            .expect("the run must end on an action the device dispatches");
        assert_eq!(terminal.action, catalog::RESPOND_ACTION);
        assert!(
            terminal.input.contains("front page could not be read"),
            "the wearer must hear the composed answer, got {}",
            terminal.input
        );
        assert!(
            !terminal.input.contains(ERROR_TIMEOUT),
            "the timeout string is for a run with nothing to say, got {}",
            terminal.input
        );
        // The composing step must not be able to spend the remainder asking for
        // yet another tool — that is the loop this fix exists to break.
        assert_eq!(
            model
                .composed_with_tools
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the final compose step must be offered no tools"
        );
    }

    /// Defence in depth for the same gap: a tool that DOES start and then stalls
    /// is cut off at the run deadline instead of running the stream past the
    /// device's own. Honest observation — never a fabricated result.
    #[tokio::test]
    async fn a_tool_that_stalls_is_cut_off_at_the_run_deadline() {
        // Deadlines here are stated relative to ANSWER_RESERVE on purpose. The
        // bound is `deadline - ANSWER_RESERVE`, so a deadline BELOW the reserve
        // gives every tool a zero budget and both assertions below stop meaning
        // what they say — the "answers in time" case passed only because an
        // immediately-ready future completes on its first poll.
        let started = std::time::Instant::now();
        let observation = bounded_tool(
            async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                "a result that arrived long after the device gave up".to_owned()
            },
            std::time::Instant::now() + ANSWER_RESERVE + std::time::Duration::from_millis(400),
        )
        .await;
        assert_eq!(observation, TOOL_TIMED_OUT);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "the stall must be cut at its 400ms window, not run to the deadline"
        );

        // A tool that answers in time is untouched — and genuinely awaits, so a
        // zero-length budget could not let it through.
        let quick = bounded_tool(
            async {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                "17 degrees and clear".to_owned()
            },
            std::time::Instant::now() + ANSWER_RESERVE + std::time::Duration::from_secs(5),
        )
        .await;
        assert_eq!(quick, "17 degrees and clear");

        // The compose window is never on the table: a tool handed a deadline
        // inside the reserve gets no budget at all rather than borrowing it.
        let starved = bounded_tool(
            async {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                "too late to matter".to_owned()
            },
            std::time::Instant::now() + ANSWER_RESERVE - std::time::Duration::from_millis(500),
        )
        .await;
        assert_eq!(starved, TOOL_TIMED_OUT);
    }
}

#[cfg(test)]
mod terminal_source_tests {
    use super::*;

    /// Measured against the real carry cloud: every one of 65 observed `Respond`
    /// actions carried `source: SERVER`. Sending `DEVICE` told the Pin to execute
    /// `Respond` itself, which no real carry turn ever asked for.
    #[test]
    fn respond_matches_the_source_carry_was_observed_to_send() {
        assert_eq!(
            terminal_source(catalog::RESPOND_ACTION),
            pb::SynapseSource::Server
        );
    }

    /// Genuine device actions must stay DEVICE — `isDeviceAction` is what makes
    /// the Pin perform them, and World Clock is documented to work offline.
    #[test]
    fn genuine_device_actions_stay_device_executed() {
        for action in ["WorldClock", "PlayMusic", "SetTimer", "CapturePhotograph"] {
            assert_eq!(
                terminal_source(action),
                pb::SynapseSource::Device,
                "{action} is performed by the Pin, so it must be marked DEVICE",
            );
        }
    }
}

#[cfg(test)]
mod respond_mirror_tests {
    use super::*;

    /// The top-level `response` must mirror what is actually spoken. They are
    /// produced in two places, so the invariant is pinned rather than assumed.
    #[test]
    fn the_response_field_matches_the_spoken_action_input() {
        let msg = respond("It is *Paris*.", String::new(), "id".into());
        let spoken = match msg.body.as_ref() {
            Some(pb::synapse_understanding_response::Body::Turn(turn)) => {
                match turn.content.as_ref() {
                    Some(pb::synapse_chat_turn::Content::Action(action)) => action.input.clone(),
                    _ => panic!("expected an action turn"),
                }
            }
            _ => panic!("expected a turn body"),
        };
        assert!(
            spoken.contains("It is Paris."),
            "action input not stripped: {spoken}"
        );
        assert_eq!(
            msg.response, "It is Paris.",
            "response must mirror the spoken text"
        );
        assert!(!msg.response.contains('*'));
    }
}

#[cfg(test)]
mod step_budget_tests {
    use super::*;
    use std::time::Duration;

    /// The live failure, as arithmetic. A search returned at 7.4s of a 22s
    /// budget; the answer step needed just over 10s and was killed at exactly
    /// 10.0s with 14.6s still unspent.
    #[test]
    fn the_last_step_may_use_the_budget_that_is_left() {
        let remaining = Duration::from_millis(14_600);
        let allowed = step_timeout_for(remaining);
        // It gets the budget it has, not a fixed sub-budget cap.
        assert_eq!(allowed, remaining - TERMINAL_RESERVE);
        assert!(
            allowed > Duration::from_secs(10),
            "the step that failed live at 10.0s must now get more than 10s",
        );
        assert!(
            allowed < remaining,
            "must still reserve time to speak the answer"
        );
    }

    /// A stuck step still cannot outlive the anti-hang ceiling, even with the
    /// whole budget in front of it.
    #[test]
    fn a_step_never_outlives_the_anti_hang_ceiling() {
        assert_eq!(step_timeout_for(RUN_BUDGET), MODEL_STEP_TIMEOUT);
        assert_eq!(
            step_timeout_for(Duration::from_secs(60)),
            MODEL_STEP_TIMEOUT
        );
    }

    /// A legitimately slow step — the 10-14s calls that used to die at the old
    /// 10s cap — now completes.
    #[test]
    fn a_slow_but_real_step_is_no_longer_cut_at_ten_seconds() {
        assert!(step_timeout_for(RUN_BUDGET) > Duration::from_secs(10));
        assert!(step_timeout_for(Duration::from_millis(14_600)) > Duration::from_secs(10));
    }

    /// Never longer than what is left, and never negative.
    #[test]
    fn the_step_never_outlives_the_budget() {
        for ms in [0u64, 200, 800, 1_500, 5_000, 12_000, 20_000, 22_000] {
            let remaining = Duration::from_millis(ms);
            assert!(
                step_timeout_for(remaining) <= remaining,
                "step may not outlive the remaining {remaining:?}",
            );
        }
    }
}
