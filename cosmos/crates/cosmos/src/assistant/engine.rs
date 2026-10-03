//! Luma's independently implemented assistant turn engine.
//!
//! It drives an LLM in a thought→action→observation loop over a `SynapseChatTurn`
//! DAG and streams the stock-facing `SynapseUnderstandingResponse` contract.
//! Each model turn is either a tool call (emit an
//! action node, execute it server-side, feed the observation back, LOOP) or a
//! plain answer, delivered as a **terminal `Respond` action** the device narrates
//! (FINISH), bounded by the max-action-turns budget. The model + prompts +
//! catalog content are ours. The protocol, loop shape, and device-facing
//! interface preserve the observed device boundary.
//!
//! Contract details that are load-bearing on a real device and that this engine
//! therefore honors:
//!   1. **Terminal shape.** The legacy `Understand` consumer
//!      (`SynapseInterpreter$1.onNext`) keeps ONLY turns that
//!      `hasAction()`/`hasObservation()`, a bare `SynapseAnswer` body is logged
//!      "Unexpected TAO response" and dropped, and it *dispatches* only the FINAL
//!      action of the batch. So the answer is the last action turn
//!      (`action="Respond"`, `source=DEVICE`, `input={"Response": "…"}`), never a
//!      response-level `Answer`/`Failure` body.
//!   2. **Root threading.** The server is stateless per legacy call and threads its
//!      turns onto the user-request turn the device replays in
//!      `device_context.turns` (empty parent ⇒ self-rooting new run).
//!   3. **Device vs server execution.** A device-catalog action is emitted as the
//!      terminal action for the *pin* to run, the server never executes it or
//!      fabricates its observation. Server tools resolve inline and pair with an
//!      observation, then loop.
//!   4. **Replayed conversation state.** Prior turns in `device_context.turns` plus
//!      `previous_answers` reconstruct the transcript the model reasons over.
//!   5. **Catalog resolution.** `excluded_tools` is subtracted from the
//!      server-owned catalog keyed by `tool_set_version` (the device sends an empty
//!      `action_definitions` and only a version pointer).
//!   6. **Loop guards.** An action budget (`ai_bus.max_action_turns`, default 8)
//!      bounds the run. Exceeding it yields a `TooManyActions` observation which is
//!      converted into a terminal `Respond`, mirroring `Switchboard`'s runaway
//!      guard, where `Respond` is exempt so the agent can always answer. A call to
//!      an unknown tool bounces the exact stock `Unrecognized function name and/or
//!      arguments` observation back so the model can retry with corrected args.

use std::sync::Arc;

use cosmos_protocol::aibus as pb;
use tokio::sync::mpsc::Sender;
use tonic::Status;

use super::catalog;
use super::intents::{
    FUTURE_WEATHER_UNAVAILABLE, TICKLE_NEAR_MISS_RESPONSE, current_city_request,
    deterministic_world_clock_action, explicit_clock_agent_request, explicit_nearby_query,
    explicit_nutrition_request, explicit_playback_request, explicit_route_request,
    explicit_safe_stock_action, is_music_research_tool, local_device_status_action,
    local_forecast_request, local_weather_request, prefer_one_music_research_tool,
    retire_completed_single_reads, retire_music_research_tools, tickle_near_miss_request,
    unanswerable_forecast_request,
};
use super::llm::{ChatMessage, ChatModel, ChatResponse, Role, ToolCall, ToolDef};
use super::runtime::{ForegroundRun, RouteClass, Transport};
use super::toolsets;
use super::turn::context::{MEMORY_CONTEXT_POLICY, situation_line, wearer_memory};
use super::turn::frames::{action_turn, now_ts, observation_turn};
use super::turn::text::{model_facing_observation, spoken_text};
use crate::services::gates::{self, BlockingObservation, Entitlement};

/// cosmos's runaway guard (`Switchboard.mActionLimit`, stock `intent.actionLimit`).
/// The ceiling is over the whole RUN, not one RPC: a multi-hop run issues a fresh
/// `Understand` per hop, so a per-call budget would never bind.
const ACTION_LIMIT: usize = 8;

/// The exact observation the stock device bounces back when an emitted action
/// does not resolve in its `SchemaCatalog` (`JsonResolver.resolve` → null). The
/// server mirrors it so the model can retry with corrected arguments.
const UNRECOGNIZED_FUNCTION: &str = "Unrecognized function name and/or arguments";

/// Spoken when the runaway guard trips. cosmos's `TooManyActionsObservation`
/// carries `ErrorStrings.ERROR_TOO_MANY_ACTIONS` and the device speaks it verbatim
/// (`convertAndDispatchGeneratedActionIfNeeded` → `RespondAction`), so this exact
/// string is what the wearer hears.
pub(super) const TOO_MANY_ACTIONS: &str = "something went wrong. can you rephrase your request?";

/// Spoken on an internal error or when the turn budget is exhausted
/// (`ErrorStrings.ERROR_TIMEOUT`, the string the device itself speaks on
/// `DEADLINE_EXCEEDED`).
pub(super) const ERROR_TIMEOUT: &str = "Something went wrong. Try again.";

/// Spoken when the model returns a turn containing no usable content, distinct
/// from an internal error (nothing failed) and from the runaway guard (the model
/// never got that far). Stock has no dedicated string for this because its
/// serverside never surfaces an empty completion to the wearer. The closest
/// faithful behaviour is a short, non-apologising retry prompt.
pub(super) const NO_ANSWER: &str = "No answer came back. Try asking again.";

/// Spoken when a clarification question was already asked and the wearer's
/// answer still left the value missing: one short line, not the same question
/// forever.
pub(super) const CLARIFICATION_UNRESOLVED: &str = "That needs the missing detail first.";

/// Anti-hang ceiling for a single model step.
///
/// Its only job is to stop ONE stuck call from consuming the whole run, not to
/// cap normal latency. It was 10s, which was below real model latency on a busy
/// day and killed legitimate steps: a first step that took >10s to decide on a
/// tool, and an answer step that needed just over 10s to summarise a long search
/// result. Both surfaced to the wearer as "Something went wrong" at exactly
/// 10.0s. The signed Pin runtime uses the same 20s per-step ceiling: it clears
/// the observed 15.002s GPT-5.6-sol planner response while the whole run remains
/// bounded by [`RUN_BUDGET`] regardless.
const MODEL_STEP_TIMEOUT: std::time::Duration = super::runtime::MODEL_STEP_LIMIT;

/// How long this model step may run, given the budget left.
///
/// The budget that remains, minus the [`TERMINAL_RESERVE`] the run keeps to
/// stream the answer, bounded by the anti-hang ceiling. So a step uses the time
/// it actually has (up to the ceiling) instead of a fixed cap that fired with
/// budget to spare, while a stuck step still cannot outlive the ceiling.
fn step_timeout_for(remaining: std::time::Duration) -> std::time::Duration {
    remaining
        .saturating_sub(TERMINAL_RESERVE)
        .min(MODEL_STEP_TIMEOUT)
}

fn can_retry_initial_model(
    retry_available: bool,
    has_tool_result: bool,
    remaining: std::time::Duration,
) -> bool {
    retry_available && !has_tool_result && remaining > TERMINAL_RESERVE + MIN_TOOL_WINDOW
}

/// Total wall-clock budget for the whole turn. The signed Hook raises the exact
/// inspected Ironman `AIMIC_TIMEOUT_MS` from 25s to 90s before `AIBusService`
/// initializes. Keep this run below that outer deadline so gRPC never discards
/// already-streamed turns, and always deliver a terminal `Respond` first.
const RUN_BUDGET: std::time::Duration = super::runtime::FOREGROUND_BUDGET;

/// Headroom held back from the run budget so that a tool which overruns still
/// leaves time to stream the terminal `Respond` the wearer hears.
const TERMINAL_RESERVE: std::time::Duration = super::runtime::TERMINAL_RESERVE;

/// A remaining interval below this is useful only for a terminal response.
/// Shared with the bidi transport, runtime.rs is the one place deadline
/// semantics are defined, and neither transport invents its own.
const MIN_USEFUL_REMAINING: std::time::Duration = super::runtime::MIN_USEFUL_REMAINING;

/// The observation for a server tool that did not return inside the run's
/// remaining budget. The tool produced nothing, so the model is told exactly
/// that: an invented stand-in result here would be spoken to the wearer as fact.
const TOOL_TIMED_OUT: &str = "The tool did not return in time and produced no result.";
const REPEATED_SERVER_TOOL_CALL: &str =
    "This exact tool call already returned earlier in this turn. Use that result and answer now.";

pub(crate) fn server_tool_call_key(call: &ToolCall, context: &catalog::ToolContext) -> String {
    let arguments = serde_json::from_str::<serde_json::Value>(&call.arguments)
        .map(|mut value| {
            if matches!(call.name.as_str(), "weather" | "reverse_geocode" | "nearby") {
                if let Some(object) = value.as_object_mut() {
                    let place_is_empty = object
                        .get("place")
                        .and_then(serde_json::Value::as_str)
                        .is_none_or(|place| place.trim().is_empty());
                    if place_is_empty {
                        object.remove("place");
                        let explicit = object
                            .get("latitude")
                            .and_then(serde_json::Value::as_f64)
                            .zip(object.get("longitude").and_then(serde_json::Value::as_f64))
                            .filter(|(latitude, longitude)| *latitude != 0.0 || *longitude != 0.0);
                        let effective = explicit.or(context.location);
                        if effective.zip(context.location).is_some_and(
                            |((latitude, longitude), (current_latitude, current_longitude))| {
                                (latitude - current_latitude).abs() <= 1e-6
                                    && (longitude - current_longitude).abs() <= 1e-6
                            },
                        ) {
                            object.remove("latitude");
                            object.remove("longitude");
                            object.insert(
                                "__resolved_location".to_owned(),
                                serde_json::Value::String("current".to_owned()),
                            );
                        }
                    }
                }
            }
            value.to_string()
        })
        .unwrap_or_else(|_| call.arguments.trim().to_owned());
    format!("{}\n{arguments}", call.name)
}

pub(crate) fn repeated_server_tool_observation(previous: &str) -> String {
    format!(
        "{REPEATED_SERVER_TOOL_CALL}\nPrevious result: {}",
        model_facing_observation(previous)
    )
}

/// Total wall-clock budget for this run: always [`RUN_BUDGET`].
fn run_budget() -> std::time::Duration {
    RUN_BUDGET
}

/// Held back so a run that runs out of tool budget can still spend ONE model
/// step turning what it already observed into an answer.
///
/// [`TERMINAL_RESERVE`] is only enough to *stream* a canned string. Composing
/// needs a real model round trip, which measured 2.4-7.7s against the live
/// backend. Sized for the slow end of that: a run that starts a third search at
/// t=16.7s has ~2s left afterwards, which buys a timeout string and nothing else.
pub(super) const ANSWER_RESERVE: std::time::Duration = std::time::Duration::from_secs(7);

/// Maximum time for the model step that extracts the exact title and artist
/// from one completed ranked-music research result.
///
/// The live fast model normally takes about 4.4s for this step but has reached
/// 7.7s. Use that early-research slack when it exists. The calculation below
/// still preserves the provider and terminal windows when the first lookup was
/// slower.
const MUSIC_EXTRACTION_STEP_LIMIT: std::time::Duration = std::time::Duration::from_secs(8);

/// Minimum time a ranked playback turn must retain after its one research
/// lookup: 8s for title/artist extraction, 10s for two bounded active-provider
/// verification, and 750ms to stream the terminal PlayMusic or spoken failure.
/// The 70s foreground budget still leaves more than 28s for research after a
/// maximally slow initial model step.
const MUSIC_POST_RESEARCH_RESERVE: std::time::Duration = std::time::Duration::from_millis(18_750);

pub(super) fn music_extraction_step_timeout(remaining: std::time::Duration) -> std::time::Duration {
    remaining
        .saturating_sub(crate::backends::music_discovery::PROVIDER_MAX + TERMINAL_RESERVE)
        .min(MUSIC_EXTRACTION_STEP_LIMIT)
}

/// A provider miss can reflect an imprecise public-web credit rather than an
/// absent catalog item. Give the foreground agent one chance to verify a
/// different candidate already present in the completed research result. The
/// retry stays closed for every other failure and starts only when enough of
/// the shared Pin deadline remains for another extraction step, provider
/// lookup, and terminal action.
pub(super) fn can_retry_music_provider_miss(
    retry_available: bool,
    observation: &str,
    remaining: std::time::Duration,
) -> bool {
    retry_available
        && crate::backends::music_discovery::failure(observation)
            == Some(crate::backends::music_discovery::MusicDiscoveryError::ProviderNoMatch)
        && remaining
            > crate::backends::music_discovery::PROVIDER_MAX + TERMINAL_RESERVE + MIN_TOOL_WINDOW
}

pub(super) fn tool_reserve_for(
    name: &str,
    terminal_music: bool,
    bounded_music_research: bool,
) -> std::time::Duration {
    if terminal_music {
        TERMINAL_RESERVE
    } else if bounded_music_research && is_music_research_tool(name) {
        MUSIC_POST_RESEARCH_RESERVE
    } else {
        ANSWER_RESERVE
    }
}

/// The smallest window worth STARTING a server tool in.
///
/// Reserving compose time is not enough on its own: the gate has to leave room
/// for the tool *and* the answer. Measured on the live stack, a second
/// `ask_online` was admitted with 8.0s left, ran 5.2s, and left 2.8s, just
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
/// other wearer-facing string here: the recovered stock tool sets forbid first
/// person and apology constructions.
pub(crate) const FINAL_ANSWER_DIRECTIVE: &str = concat!(
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
/// happily dispatch, the pin would be handed a server-side tool name it cannot
/// resolve, so the run has to be closed before the node goes out, not after.
///
/// The reserve is [`ANSWER_RESERVE`], not [`TERMINAL_RESERVE`]: a run that
/// starts a tool it has no time to *use* has spent the wearer's budget buying
/// nothing. Observed live, three searches, a usable result in hand after the
/// second, and the device's timeout string spoken at 22s with the answer sitting
/// unread in the transcript.
pub(super) fn out_of_tool_budget_with(
    deadline: std::time::Instant,
    terminal_reserve: std::time::Duration,
) -> bool {
    deadline.saturating_duration_since(std::time::Instant::now())
        <= terminal_reserve + MIN_TOOL_WINDOW
}

/// Run a server tool bounded by what is left of the run budget.
///
/// `RUN_BUDGET` used to be checked only at the top of each loop iteration, and
/// only the model step was wrapped in a timeout, `execute_tool_with` was
/// awaited unbounded. A backend that stalls at t=20s therefore returns past the
/// device's `withDeadlineAfter(AIMIC_TIMEOUT_MS = 25000)` (`AIBusService.java`),
/// at which point gRPC fires `DEADLINE_EXCEEDED` and the pin discards every turn
/// already streamed and speaks its own `ERROR_TIMEOUT`. The engine's whole
/// design is that the wearer always hears a terminal `Respond`. One unbounded
/// await defeats it.
async fn bounded_tool_with_reserve<F>(
    fut: F,
    deadline: std::time::Instant,
    terminal_reserve: std::time::Duration,
) -> String
where
    F: std::future::Future<Output = String>,
{
    // Reserve the COMPOSE window, not just the streaming one. A tool allowed to
    // run to `deadline - TERMINAL_RESERVE` can return with too little left to
    // turn its own result into an answer, which is how a run ends up spending
    // 22s and speaking the timeout string with the result already in hand.
    let budget = deadline
        .saturating_duration_since(std::time::Instant::now())
        .saturating_sub(terminal_reserve);
    tokio::time::timeout(budget, fut)
        .await
        .unwrap_or_else(|_| TOOL_TIMED_OUT.to_owned())
}

/// Run a server tool under the shared deadline, but abandon it immediately when
/// the stock response stream is gone. Dropping the future cancels reqwest-backed
/// provider work instead of spending the rest of the turn on an unheard answer.
async fn bounded_tool_or_cancel<F>(
    fut: F,
    deadline: std::time::Instant,
    terminal_reserve: std::time::Duration,
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
) -> Option<String>
where
    F: std::future::Future<Output = String>,
{
    tokio::select! {
        biased;
        _ = tx.closed() => None,
        observation = bounded_tool_with_reserve(fut, deadline, terminal_reserve) => {
            Some(observation)
        }
    }
}

/// cosmos's replayed-context ceiling.
///
/// `resources/assets/config_generated.json` ships `tao.contextCapacity = 100`,
/// and `AiBrainService` hands it to `LocalChatTurnService`, which evicts past it,
/// so the device itself never holds more than 100 turns. `device_context.turns`
/// is device-supplied and deliberately MULTI-run (`EventsSnapshot.linearize`
/// stitches completed runs inside the inter-run window), so replaying all of it
/// grows every prompt without bound: prompt tokens, per-step latency, and the
/// run budget all pay for turns the pin has already forgotten. We cited the
/// constant and never enforced it. Enforce it, keeping the MOST RECENT turns.
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
/// the honest outcome. Describing the scene anyway would be invented.
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
    /// request context. A wearer-scoped tool then says it has nothing rather
    /// than reaching into another account.
    tools: catalog::ToolContext,
    /// The caller's account verdict. cosmos gates every dispatched action on this
    /// and *rewrites* the ReAct chain when it blocks (see [`Self::gated`]). With
    /// no entitlement datastore this deployment resolves to
    /// [`Entitlement::Active`], cosmos's own fail-open behavior.
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

    /// The underlying chat model, so the bidi transport can drive the same model
    /// this engine does (one assistant, two transports).
    pub fn model(&self) -> Arc<dyn ChatModel> {
        self.model.clone()
    }

    /// Spend what is left of the budget turning the transcript into an answer.
    ///
    /// Every budget-exhaustion path used to speak [`ERROR_TIMEOUT`] and drop the
    /// run on the floor. That is the right string when the run genuinely has
    /// nothing, and the wrong one when it has three tool observations in
    /// context, which is what a search-shaped question produces by t=20s. The
    /// wearer waited the full 22s either way. This decides whether they get the
    /// answer that wait bought.
    ///
    /// Tools are passed empty so the model cannot spend the remainder asking for
    /// another one. Returns `None` if there is no time left, the step fails, or
    /// the model returns nothing usable, every caller then falls back to the
    /// stock timeout string, so this can only add an answer, never remove one.
    async fn compose_final_answer(
        &self,
        messages: &[ChatMessage],
        deadline: std::time::Instant,
    ) -> Option<String> {
        let budget = deadline
            .saturating_duration_since(std::time::Instant::now())
            .checked_sub(TERMINAL_RESERVE)?
            .min(super::runtime::MODEL_STEP_LIMIT);
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

    /// cosmos's degraded-state rewrite: when the account gate blocks an action, the
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
        mut req: pb::SynapseUnderstandingRequest,
        tx: Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
        system_addendum: Option<&str>,
    ) {
        let mut run = ForegroundRun::with_budget(Transport::Legacy, RouteClass::A1, run_budget())
            .with_model(self.model.provenance());
        let location_allowed =
            super::turn::context::apply_location_privacy(&mut req, &self.tools, run.deadline())
                .await;
        // Resolve the server-owned catalog for this request: our tool set minus
        // whatever the device excluded (`SYNAPSE_EXCLUDED_TOOLS`).
        let mut tools = resolve_catalog(&req, self.entitlement.is_subscribed());
        let request_locked = super::policy::request_is_locked(&req);
        let utterance = current_utterance(&req).to_owned();
        if !active_vision_request(&req) {
            tools.retain(|tool| tool.name != VISION_ACTION);
        }
        catalog::scope_tickle_to_exact_request(&mut tools, &utterance);
        catalog::scope_explanation_to_non_device_tools(&mut tools, &utterance);

        // The wearer's own words, kept for required-slot backfill: the agent
        // entry points take the request verbatim, so when the model omits the
        // slot the utterance is the faithful value rather than an invention.
        let bounded_music_research = prefer_one_music_research_tool(
            &mut tools,
            &utterance,
            self.tools.answer_engine_available,
        );

        // Root the transcript on the user-request turn the DEVICE replayed. With no
        // device context the first server turn self-roots (empty parent) rather
        // than pointing at a fabricated id we never emit.
        let mut parent = req
            .device_context
            .as_ref()
            .and_then(|dc| dc.turns.last())
            .map(|t| t.identifier.clone())
            .unwrap_or_default();

        // Seed the run's action count from the CURRENT run only, so the ceiling
        // and first-step-only tools bind across hops the way
        // `Switchboard.numActionsInRun` does.
        let mut actions_in_run = req
            .device_context
            .as_ref()
            .map(|dc| actions_in_current_run(&dc.turns))
            .unwrap_or(0);

        // An addressed OS3 request ("ask OS3 to …") is a closed deterministic
        // route: the executor is named, so it resolves before every other
        // deterministic route and costs no model step. Companion requests
        // that never name OS3 ("what's on my MacBook?") stay model-led: the
        // `ask_os3` tool description carries that semantic choice, and both
        // routes retain the catalog's lock, exclusion, entitlement, and
        // configuration gates and the first-step invariant.
        let os3_first_step = system_addendum.is_none()
            && actions_in_run == 0
            && tools.iter().any(|tool| tool.name == catalog::OS3_TOOL);
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
                run.deadline().checked_sub(ANSWER_RESERVE),
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

        // Stock's legacy consumer cannot recover when the model skips a
        // device-side prerequisite. Keep only closed prerequisites and
        // already-grounded actions deterministic. Ranked or subjective music
        // always reaches the model so it can select discovery/provider tools.
        // Text-only callers have no Pin on which to run a device action.
        let deterministic = system_addendum
            .is_none()
            .then(|| deterministic_device_action(&req, &tools))
            .flatten();
        run.set_route(if explicit_os3 || deterministic.is_some() {
            RouteClass::D1
        } else {
            RouteClass::A1
        });
        let run_deadline = run.deadline();
        let mut tool_context = self.tools.clone();
        tool_context.os3_follow_up = contextual_intent;
        if !location_allowed {
            tool_context.location = None;
        }
        tool_context.deadline = Some(run_deadline);
        // A request that carried no position still has the one the Pin
        // reported to this run's `GetCurrentLocation` preflight.
        if tool_context.location.is_none() {
            tool_context.location = req
                .device_context
                .as_ref()
                .and_then(|context| catalog::replayed_location(&context.turns));
        }

        if !explicit_os3 && !location_allowed && automatic_location_request(&req) {
            run.set_route(RouteClass::D1);
            finish(&tx, respond(LOCATION_PRIVACY_RESPONSE, parent, new_id())).await;
            run.finish_recorded("blocked", &self.tools).await;
            return;
        }

        let local_os3_answer = match &contextual_os3 {
            Ok(Some(super::llm::Os3FollowUp::OwnerInput)) => {
                Some(catalog::OS3_OWNER_INPUT_DIRECTION)
            }
            Err(error) => Some(error.observation()),
            _ => None,
        };
        if let Some(answer) = local_os3_answer {
            // Stock RespondActionHandler.handleAction narrates this text and
            // may reopen the microphone after speech. INFERRED: a short voice
            // acknowledgement never answers a remote permission/card.
            finish(&tx, respond(answer, parent, new_id())).await;
            run.finish_recorded("answered", &self.tools).await;
            return;
        }
        if explicit_os3 {
            let call = ToolCall {
                name: catalog::OS3_TOOL.to_owned(),
                arguments: "{}".to_owned(),
            };
            let action_id = new_id();
            run.note_tool_call(catalog::OS3_TOOL);
            if send(
                &tx,
                node(action_turn(
                    &call,
                    "The wearer explicitly asked OS3",
                    parent,
                    action_id.clone(),
                    pb::SynapseSource::Server,
                )),
            )
            .await
            .is_err()
            {
                run.finish_recorded("cancelled", &self.tools).await;
                return;
            }
            tool_context.first_step_request = Some(utterance.clone());
            let Some(observation) = bounded_tool_or_cancel(
                catalog::execute_tool_with(catalog::OS3_TOOL, "{}", &tool_context),
                run_deadline,
                TERMINAL_RESERVE,
                &tx,
            )
            .await
            else {
                run.finish_recorded("cancelled", &self.tools).await;
                return;
            };
            let observation_id = new_id();
            if send(
                &tx,
                node(observation_turn(
                    catalog::OS3_TOOL,
                    &observation,
                    action_id,
                    observation_id.clone(),
                    pb::SynapseSource::Server,
                )),
            )
            .await
            .is_err()
            {
                run.finish_recorded("cancelled", &self.tools).await;
                return;
            }
            finish(&tx, respond(&observation, observation_id, new_id())).await;
            run.finish_recorded("answered", &self.tools).await;
            return;
        }
        if let Some(action) = deterministic {
            let id = new_id();
            finish(
                &tx,
                terminal_device_action(action.name, &action.input, action.thought, parent, id),
            )
            .await;
            run.finish_recorded("device_action", &self.tools).await;
            return;
        }

        // Reconstruct the conversation the model reasons over from the state the
        // device replayed (cosmos's legacy path is stateless per call).
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
        // A wearer's saved facts are small and always relevant, they are who the
        // assistant is talking to. Putting them in front of the model removes both
        // failure modes at once: no tool decision, no term overlap, no round trip.
        // `recall_memory` stays for dated and archive-shaped questions ("what did
        // I note last Tuesday"), where scanning beats containing everything.
        //
        // Never on a locked Pin: the notes are what `recall_memory` reads, and
        // stock refuses that read on the keyguard (`ManageMemoryAction` is
        // `enabledInKeyguard = false`), so whoever holds a locked Pin cannot
        // have them read out.
        if !request_locked
            && let Ok(Some(memory)) =
                tokio::time::timeout(run.context_timeout(), wearer_memory(&self.tools)).await
        {
            messages.push(ChatMessage::system(MEMORY_CONTEXT_POLICY));
            messages.push(memory);
        }

        // NOTE: no leading heartbeat on the legacy server-stream.
        //
        // `SynapseInterpreter$1.onNext` keeps only responses whose turn
        // `hasAction()`/`hasObservation()`. Anything else is logged as an
        // "Unexpected TAO response" and discarded. A heartbeat sent before the
        // first real turn is therefore pure noise to the one consumer that
        // matters, and on a build that treats an unparseable leading message as
        // a protocol error it costs the whole turn.

        let mut music_research_completed = false;
        let mut music_provider_retry_available = true;
        let mut initial_model_retry_available = true;
        let mut completed_server_calls = std::collections::HashMap::<String, String>::new();
        for step in 0..ACTION_LIMIT {
            // Out of turn budget: deliver a spoken terminal NOW, before the device's
            // deadline fires and throws away everything we streamed.
            let remaining = run_deadline.saturating_duration_since(std::time::Instant::now());
            if remaining < MIN_USEFUL_REMAINING {
                // Too little left even to compose. The stock timeout string is
                // all there is time to say.
                let id = new_id();
                finish(&tx, respond(ERROR_TIMEOUT, parent, id)).await;
                run.finish_recorded("deadline", &self.tools).await;
                return;
            }
            // Never past the remaining budget, and never so short that the last
            // step of a turn is cut off with budget still unspent.
            let step_timeout = if music_research_completed {
                music_extraction_step_timeout(remaining)
            } else {
                step_timeout_for(remaining)
            };
            // Every arm below speaks the same sentence, cosmos converts degraded
            // states into device actions that narrate, never a bare `Failure`
            // body the device would drop, but they are NOT the same event, and
            // folding them together is what made an expired provider key raise
            // the deadline alarm. The spoken string stays stock. The outcome
            // label says what actually happened.
            run.note_model_step();
            let model_step =
                tokio::time::timeout(step_timeout, self.model.complete(&messages, &tools));
            let resolved = tokio::select! {
                biased;
                _ = tx.closed() => {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return;
                }
                resolved = model_step => resolved,
            };
            let resp = match resolved {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    if matches!(error, super::llm::LlmError::Transport(_))
                        && can_retry_initial_model(
                            initial_model_retry_available,
                            super::llm::current_request_has_tool_result(&messages),
                            run_deadline.saturating_duration_since(std::time::Instant::now()),
                        )
                    {
                        initial_model_retry_available = false;
                        continue;
                    }
                    if let Some(tool_call) =
                        super::llm::required_retrieval_after_model_failure(&messages, &tools)
                    {
                        tracing::warn!(
                            tool = %tool_call.name,
                            "model step failed before a required retrieval; continuing with the guarded call"
                        );
                        ChatResponse {
                            content: None,
                            thought: String::new(),
                            tool_call: Some(tool_call),
                            extra_tool_calls: Vec::new(),
                        }
                    } else {
                        if super::llm::current_request_has_tool_result(&messages) {
                            run.note_model_step();
                            if let Some(spoken) =
                                self.compose_final_answer(&messages, run_deadline).await
                            {
                                let id = new_id();
                                finish(&tx, respond(&spoken, parent, id)).await;
                                run.finish_recorded("answered", &self.tools).await;
                                return;
                            }
                        }
                        let id = new_id();
                        finish_as(
                            &tx,
                            respond(ERROR_TIMEOUT, parent, id),
                            Some(model_failure_outcome(&error)),
                        )
                        .await;
                        run.finish_recorded(model_failure_outcome(&error), &self.tools)
                            .await;
                        return;
                    }
                }
                // The step outran its slice of the turn budget. This one really
                // is a deadline.
                Err(_elapsed) => {
                    if can_retry_initial_model(
                        initial_model_retry_available,
                        super::llm::current_request_has_tool_result(&messages),
                        run_deadline.saturating_duration_since(std::time::Instant::now()),
                    ) {
                        initial_model_retry_available = false;
                        continue;
                    }
                    if let Some(tool_call) =
                        super::llm::required_retrieval_after_model_failure(&messages, &tools)
                    {
                        tracing::warn!(
                            tool = %tool_call.name,
                            "model step timed out before a required retrieval; continuing with the guarded call"
                        );
                        ChatResponse {
                            content: None,
                            thought: String::new(),
                            tool_call: Some(tool_call),
                            extra_tool_calls: Vec::new(),
                        }
                    } else {
                        if super::llm::current_request_has_tool_result(&messages) {
                            run.note_model_step();
                            if let Some(spoken) =
                                self.compose_final_answer(&messages, run_deadline).await
                            {
                                let id = new_id();
                                finish(&tx, respond(&spoken, parent, id)).await;
                                run.finish_recorded("answered", &self.tools).await;
                                return;
                            }
                        }
                        let id = new_id();
                        finish_as(&tx, respond(ERROR_TIMEOUT, parent, id), Some("deadline")).await;
                        run.finish_recorded("deadline", &self.tools).await;
                        return;
                    }
                }
            };

            if let Some(tc) = resp.tool_call {
                // Exclusive delegation takes no model-authored arguments: OS3
                // hears the wearer's own words through the tool context, so
                // the action the Pin sees is the same zero-argument call the
                // backend answers. `enforce_explicit_os3` normalizes every
                // live model driver. This restates the rule at the transport
                // for any call that reaches the loop unnormalized.
                let mut tc = tc;
                if catalog::is_exclusive_server_tool(&tc.name) {
                    tc.arguments = "{}".to_owned();
                }
                let terminal_music = tc.name == "music_discover"
                    && explicit_playback_request(&utterance)
                    && tools.iter().any(|tool| tool.name == "PlayMusic");
                // Keyguard gate, before anything runs. A locked Pin was never
                // offered this tool, so the model invented the call. It gets
                // stock's locked refusal rather than an "unrecognized" bounce,
                // and no backend is reached.
                if let Some(blocked) = super::policy::keyguard_refusal(request_locked, &tc.name) {
                    run.note_tool_call(&tc.name);
                    let delivered = rewrite_blocked(&tx, &tc.name, blocked, parent).await;
                    run.finish_recorded(
                        if delivered { "locked" } else { "cancelled" },
                        &self.tools,
                    )
                    .await;
                    return;
                }
                if !location_allowed && tc.name == "GetCurrentLocation" {
                    finish(&tx, respond(LOCATION_PRIVACY_RESPONSE, parent, new_id())).await;
                    run.finish_recorded("blocked", &self.tools).await;
                    return;
                }
                // Unknown tool: bounce the stock unrecognized-function observation
                // and LOOP so the model can correct itself (cosmos's device does
                // exactly this, tagged source=DEVICE).
                if !tools.iter().any(|t| t.name == tc.name) {
                    run.note_tool_call(&tc.name);
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
                        run.finish_recorded("cancelled", &self.tools).await;
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
                        run.finish_recorded("cancelled", &self.tools).await;
                        return;
                    }
                    messages.push(ChatMessage::tool_result(
                        &tc.name,
                        &tc.arguments,
                        UNRECOGNIZED_FUNCTION,
                    ));
                    // The device counts this action turn toward `mActionLimit`
                    // like any other, so the server's ceiling must too, else a
                    // model that keeps hallucinating tools runs past the pin's
                    // own limit and the run is cut short on the device instead.
                    actions_in_run += 1;
                    parent = obs_id;
                    // Same budget check the device-tool and server-tool branches
                    // make. Without it a model that keeps naming a tool outside
                    // the resolved catalog rides the loop to exhaustion and falls
                    // out of it with an OBSERVATION last, which the device never
                    // dispatches, so the wearer hears nothing at all.
                    if step + 1 == ACTION_LIMIT || actions_in_run + 1 > ACTION_LIMIT {
                        too_many_actions_terminal(&tx, parent).await;
                        run.finish_recorded("too_many_actions", &self.tools).await;
                        return;
                    }
                    continue;
                }

                if catalog::is_device_tool(&tc.name) {
                    run.note_tool_call(&tc.name);
                    // `Respond` terminates every turn, and its `Response` slot is
                    // OPTIONAL on the device, a missing/miscased key resolves to
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
                        run.finish_recorded(
                            if input.contains(NO_ANSWER) {
                                "no_answer"
                            } else {
                                "answered"
                            },
                            &self.tools,
                        )
                        .await;
                        return;
                    }
                    // Account gate: a blocked action is replaced by the canned
                    // degraded experience rather than executed.
                    if let Some(blocked) = self.gated(&tc.name) {
                        let delivered = rewrite_blocked(&tx, &tc.name, blocked, parent).await;
                        run.finish_recorded(
                            if delivered { "blocked" } else { "cancelled" },
                            &self.tools,
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
                        run.finish_recorded("too_many_actions", &self.tools).await;
                        return;
                    }
                    // Validate the arguments against the action's REQUIRED slots
                    // before emitting. Marking a slot required in the schema only
                    // asks the model. The device resolves a missing slot to null
                    // and either NPEs in-process (the agent entry points) or runs
                    // an empty request, silently, with the run then hanging to
                    // the deadline. Repair what is repairable, and bounce what is
                    // not the same way an unrecognized tool bounces, so the model
                    // corrects itself here instead of burning a device round trip.
                    let input =
                        match catalog::device_action_input(&tc.name, &tc.arguments, &utterance) {
                            Ok(input) => input,
                            Err(observation) => {
                                if let Some(question) =
                                    catalog::clarification_question(&tc.name, &tc.arguments)
                                {
                                    let spoken = if super::policy::question_was_already_asked(
                                        &req, &question,
                                    ) {
                                        CLARIFICATION_UNRESOLVED
                                    } else {
                                        &question
                                    };
                                    let id = new_id();
                                    finish(&tx, respond(spoken, parent, id)).await;
                                    run.finish_recorded("clarification", &self.tools).await;
                                    return;
                                }
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
                                    run.finish_recorded("cancelled", &self.tools).await;
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
                                    run.finish_recorded("cancelled", &self.tools).await;
                                    return;
                                }
                                messages.push(ChatMessage::tool_result(
                                    &tc.name,
                                    &tc.arguments,
                                    &observation,
                                ));
                                actions_in_run += 1;
                                parent = obs_id;
                                if step + 1 == ACTION_LIMIT || actions_in_run + 1 > ACTION_LIMIT {
                                    too_many_actions_terminal(&tx, parent).await;
                                    run.finish_recorded("too_many_actions", &self.tools).await;
                                    return;
                                }
                                continue;
                            }
                        };
                    if let Some(question) =
                        super::policy::confirmation_question(&req, &tc.name, &input)
                    {
                        let id = new_id();
                        finish(&tx, respond(&question, parent, id)).await;
                        run.finish_recorded("confirmation_required", &self.tools)
                            .await;
                        return;
                    }
                    // DEVICE action: the wearer's pin executes it. In the legacy
                    // server-stream path the device dispatches the *final* action,
                    // so a device tool is terminal, emit it as the last action
                    // (source=DEVICE) and stop. The server never fabricates a
                    // device-side observation it did not run.
                    let id = new_id();
                    finish(
                        &tx,
                        terminal_device_action(&tc.name, &input, &resp.thought, parent, id),
                    )
                    .await;
                    run.finish_recorded("device_action", &self.tools).await;
                    return;
                }

                // SERVER TOOL, single or batched. Both paths run a backend and
                // then loop, so both are bounded by the run budget from here on:
                // if there is not enough left to run one AND still speak, close
                // the run now, before any action node goes out.
                let server_call_key = server_tool_call_key(&tc, &tool_context);
                // Before any action of this step goes out: with nothing run yet,
                // the call can only come from the wearer's utterance, and a tool
                // that must hear only the wearer (OS3) gets those words, not the
                // model's.
                tool_context.first_step_request = (actions_in_run == 0).then(|| utterance.clone());
                if let Some(previous) = completed_server_calls.get(&server_call_key) {
                    let observation = repeated_server_tool_observation(previous);
                    messages.push(ChatMessage::tool_result(
                        &tc.name,
                        &tc.arguments,
                        &observation,
                    ));
                    continue;
                }
                let tool_reserve =
                    tool_reserve_for(&tc.name, terminal_music, bounded_music_research);
                if out_of_tool_budget_with(run_deadline, tool_reserve) {
                    // The run is out of time to start another tool, but the
                    // observations it already collected are sitting in
                    // `messages`. Answer from those before falling back to the
                    // device's timeout string.
                    let id = new_id();
                    let spoken = self
                        .compose_final_answer(&messages, run_deadline)
                        .await
                        .unwrap_or_else(|| ERROR_TIMEOUT.to_owned());
                    finish(&tx, respond(&spoken, parent, id)).await;
                    run.finish_recorded(
                        if spoken == ERROR_TIMEOUT {
                            "deadline"
                        } else {
                            "answered"
                        },
                        &self.tools,
                    )
                    .await;
                    return;
                }

                // PARALLEL SERVER TOOLS. Every recovered stock tool set ships a
                // parallel-invocation wrapper instructing the model to batch
                // independent calls, so a model that asks for two lookups at once
                // is doing what it was told. We used to keep the first and drop
                // the rest silently, the dropped call was never observed, so the
                // model could answer as if it had run, and the turn paid for a
                // second model round trip to fetch what it had already asked for.
                //
                // Only server tools batch. A device action is terminal on this
                // transport (the pin dispatches the final action and returns one
                // observation), so anything device-side falls through to the
                // single-action path below.
                let mut batch_keys = std::collections::HashSet::from([server_call_key.clone()]);
                let mut batched = Vec::new();
                if !terminal_music && !catalog::is_exclusive_server_tool(&tc.name) {
                    for extra in &resp.extra_tool_calls {
                        // A companion call a locked Pin may not run is dropped
                        // unrun, like any companion outside the offered set.
                        if catalog::is_exclusive_server_tool(&extra.name)
                            || catalog::is_device_tool(&extra.name)
                            || !catalog::is_server_tool(&extra.name)
                            || !tools.iter().any(|tool| tool.name == extra.name)
                            || super::policy::keyguard_refusal(request_locked, &extra.name)
                                .is_some()
                        {
                            continue;
                        }
                        let key = server_tool_call_key(extra, &tool_context);
                        if let Some(previous) = completed_server_calls.get(&key) {
                            messages.push(ChatMessage::tool_result(
                                &extra.name,
                                &extra.arguments,
                                &repeated_server_tool_observation(previous),
                            ));
                            continue;
                        }
                        if batch_keys.insert(key) {
                            batched.push(extra.clone());
                        }
                    }
                }
                // Never exceed the run's action ceiling: the device counts every
                // dispatched action, so a batch that overruns it would be cut
                // short on the pin instead of here.
                let room = ACTION_LIMIT.saturating_sub(actions_in_run + 1);
                let batched: Vec<ToolCall> = batched.into_iter().take(room).collect();

                if !batched.is_empty() {
                    let mut all: Vec<ToolCall> = vec![tc.clone()];
                    all.extend(batched);
                    run.note_tool_calls(all.len());

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
                            run.finish_recorded("cancelled", &self.tools).await;
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
                        bounded_tool_or_cancel(
                            catalog::execute_tool_with(&call.name, &call.arguments, &tool_context),
                            run_deadline,
                            ANSWER_RESERVE,
                            &tx,
                        )
                    }))
                    .await;

                    if results.iter().any(Option::is_none) {
                        run.finish_recorded("cancelled", &self.tools).await;
                        return;
                    }

                    let mut last_obs_id = parent.clone();
                    for ((call, action_id), observation) in
                        all.iter().zip(action_ids).zip(results.iter())
                    {
                        let observation = observation
                            .as_deref()
                            .expect("cancelled batches returned above");
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
                            run.finish_recorded("cancelled", &self.tools).await;
                            return;
                        }
                        messages.push(ChatMessage::tool_result(
                            &call.name,
                            &call.arguments,
                            &model_facing_observation(observation),
                        ));
                        completed_server_calls.insert(
                            server_tool_call_key(call, &tool_context),
                            observation.to_owned(),
                        );
                        last_obs_id = obs_id;
                    }
                    parent = last_obs_id;
                    if bounded_music_research
                        && all.iter().any(|call| is_music_research_tool(&call.name))
                    {
                        retire_music_research_tools(&mut tools);
                        music_research_completed = true;
                    }
                    for call in &all {
                        retire_completed_single_reads(&mut tools, &utterance, &call.name);
                    }

                    if step + 1 == ACTION_LIMIT || actions_in_run + 1 > ACTION_LIMIT {
                        too_many_actions_terminal(&tx, parent).await;
                        run.finish_recorded("too_many_actions", &self.tools).await;
                        return;
                    }
                    continue;
                }

                // SERVER tool: resolve it server-side, emit action + paired
                // observation, and LOOP.
                let action_id = new_id();
                run.note_tool_call(&tc.name);
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
                    run.finish_recorded("cancelled", &self.tools).await;
                    return;
                }
                actions_in_run += 1;
                let Some(observation) = bounded_tool_or_cancel(
                    catalog::execute_tool_with(&tc.name, &tc.arguments, &tool_context),
                    run_deadline,
                    tool_reserve,
                    &tx,
                )
                .await
                else {
                    run.finish_recorded("cancelled", &self.tools).await;
                    return;
                };
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
                    run.finish_recorded("cancelled", &self.tools).await;
                    return;
                }
                messages.push(ChatMessage::tool_result(
                    &tc.name,
                    &tc.arguments,
                    &model_facing_observation(&observation),
                ));
                completed_server_calls.insert(server_call_key, observation.clone());
                parent = obs_id;
                if catalog::server_tool_observation_ends_run(&tc.name) {
                    let id = new_id();
                    finish(&tx, respond(&observation, parent, id)).await;
                    run.finish_recorded("answered", &self.tools).await;
                    return;
                }
                if bounded_music_research && is_music_research_tool(&tc.name) {
                    retire_music_research_tools(&mut tools);
                    music_research_completed = true;
                }
                retire_completed_single_reads(&mut tools, &utterance, &tc.name);

                // A grounded discovery already contains the exact provider-
                // verified title and artist. When the wearer explicitly asked
                // to play it, a second model call can only add latency and is
                // the step that used to overrun the Pin's turn deadline.
                if terminal_music
                    && !current_run_contains_action(
                        req.device_context
                            .as_ref()
                            .map(|context| context.turns.as_slice())
                            .unwrap_or_default(),
                        "PlayMusic",
                    )
                {
                    if let Some(input) =
                        crate::backends::music_discovery::play_music_arguments(&observation)
                    {
                        let id = new_id();
                        let settlement_started = std::time::Instant::now();
                        finish(
                            &tx,
                            terminal_device_action(
                                "PlayMusic",
                                &input,
                                "I found a provider-verified track to play",
                                parent,
                                id,
                            ),
                        )
                        .await;
                        run.finish_recorded("device_action", &self.tools).await;
                        crate::metrics::record_music_discovery_stage(
                            "action",
                            "played",
                            settlement_started.elapsed(),
                        );
                        return;
                    }
                    if music_research_completed
                        && can_retry_music_provider_miss(
                            music_provider_retry_available,
                            &observation,
                            run_deadline.saturating_duration_since(std::time::Instant::now()),
                        )
                    {
                        music_provider_retry_available = false;
                        continue;
                    }
                    let spoken = if observation == TOOL_TIMED_OUT {
                        crate::backends::music_discovery::MusicDiscoveryError::Deadline
                            .observation()
                    } else {
                        crate::backends::music_discovery::spoken_failure(&observation)
                            .unwrap_or_else(|| {
                                crate::backends::music_discovery::MusicDiscoveryError::NoEvidence
                                    .observation()
                            })
                    };
                    let id = new_id();
                    let settlement_started = std::time::Instant::now();
                    finish(&tx, respond(spoken, parent, id)).await;
                    run.finish_recorded("answered", &self.tools).await;
                    crate::metrics::record_music_discovery_stage(
                        "action",
                        "responded",
                        settlement_started.elapsed(),
                    );
                    return;
                }

                // Budget guard: if this was the last permitted step, close the run
                // the way Switchboard does, a TooManyActions observation converted
                // into a terminal Respond (Respond is exempt from the limit).
                if step + 1 == ACTION_LIMIT || actions_in_run + 1 > ACTION_LIMIT {
                    too_many_actions_terminal(&tx, parent).await;
                    run.finish_recorded("too_many_actions", &self.tools).await;
                    return;
                }
            } else if let Some(answer) = resp
                .content
                .as_deref()
                .map(str::trim)
                .filter(|answer| !answer.is_empty())
            {
                // FINISH: the answer is the terminal `Respond` action turn the
                // device dispatches + speaks, the batch's last action.
                //
                // Blank content is treated as no content. `RespondAction.mResponse`
                // is a present-but-empty slot, so the device resolves the action,
                // dispatches it, and narrates nothing, a turn that "succeeds"
                // in silence, and whose observation is final, so nothing retries.
                // `respond_input_from_arguments` already applies this rule on the
                // tool-call path. This is the same rule on the plain-content path.
                let id = new_id();
                finish(&tx, respond(answer, parent, id)).await;
                run.finish_recorded("answered", &self.tools).await;
                return;
            } else {
                // Model returned neither a tool call nor content: still terminate
                // the stream with a spoken `Respond` rather than silence.
                let id = new_id();
                finish(&tx, respond(NO_ANSWER, parent, id)).await;
                run.finish_recorded("no_answer", &self.tools).await;
                return;
            }
        }

        // Structural backstop: the loop must never simply fall out.
        //
        // `processLegacySupervisorOnlyChatTurns` dispatches a turn only when the
        // LAST collected element `hasAction()`. An observation in that slot is
        // recorded and nothing is ever dispatched, so the run dies without a
        // sound and without an error path. Every branch above returns after
        // emitting a terminal, but relying on that is a standing invitation for
        // the next branch to forget, which is exactly how the unknown-tool path
        // regressed. Close the run here the way `Switchboard` does. Bidi has
        // carried this same post-loop terminal since it was written.
        too_many_actions_terminal(&tx, parent).await;
        run.finish_recorded("too_many_actions", &self.tools).await;
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
/// rather than failing the wearer's turn, see `toolsets::resolve`.
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
/// cosmos keys the catalog by that pointer (the device sends `action_definitions`
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
    let mut tools = catalog::tool_catalog_for_set(&context, resolved_tool_set(req).set);
    if !explicit_playback_request(current_utterance(req)) {
        tools.retain(|tool| tool.name != "music_discover");
    }
    // Content-free: which gates applied and how many tools survived them, so
    // "the Pin was not offered that tool" can be answered from the log.
    tracing::info!(
        is_locked = context.is_locked,
        subscribed,
        excluded = req.excluded_tools.len(),
        offered = tools.len(),
        mcp_offered = tools
            .iter()
            .filter(|tool| crate::mcp::is_tool_name(&tool.name))
            .count(),
        "assistant catalog resolved"
    );
    tools
}

/// The newest user-request turn the device replayed, the one this run is about.
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

/// Whether a replayed turn closes its run: the terminal `Respond` or an `End`.
fn ends_its_run(turn: &pb::SynapseChatTurn) -> bool {
    match turn.content.as_ref() {
        Some(pb::synapse_chat_turn::Content::Action(action)) => {
            action.action == catalog::RESPOND_ACTION
        }
        Some(pb::synapse_chat_turn::Content::End(_)) => true,
        _ => false,
    }
}

/// The user-request root on the newest in-progress run's parent chain.
///
/// Completed historical runs can remain in `device_context.turns` for three
/// minutes. A text-only follow-up may therefore have no replayed live root and
/// must use the top-level utterance. Conversely, when the newest turn is not
/// final, its parent chain is the live stock run and its user request is more
/// faithful than the lossy top-level intent projection.
fn current_run_user_request(
    req: &pb::SynapseUnderstandingRequest,
) -> Option<&pb::SynapseUserRequestContent> {
    use std::collections::HashMap;

    let turns = &req.device_context.as_ref()?.turns;
    let mut cursor = turns.last()?;
    if ends_its_run(cursor) {
        return None;
    }
    let by_id: HashMap<&str, &pb::SynapseChatTurn> = turns
        .iter()
        .map(|turn| (turn.identifier.as_str(), turn))
        .collect();
    for _ in 0..turns.len() {
        if let Some(pb::synapse_chat_turn::Content::UserRequest(request)) = cursor.content.as_ref()
        {
            return Some(request);
        }
        if cursor.parent_identifier.is_empty() {
            return None;
        }
        cursor = by_id.get(cursor.parent_identifier.as_str()).copied()?;
    }
    None
}

/// The current wearer text in the shape stock actually sends.
///
/// Legacy and bidirectional clients replay an in-progress live request inside
/// `device_context.turns`. That parent-chain root wins over both an empty and a
/// lossy top-level intent projection. When the replay window ends in a final
/// historical run, a nonempty top-level field is the newer text-only follow-up.
/// Repaired text wins only within whichever request is current.
pub(super) fn current_utterance(req: &pb::SynapseUnderstandingRequest) -> &str {
    if let Some(request) = current_run_user_request(req) {
        return if request.repaired_request.is_empty() {
            request.request.as_str()
        } else {
            request.repaired_request.as_str()
        };
    }
    let replayed = newest_user_request(req);
    if !req.utterance.is_empty() {
        if let Some(request) = replayed
            && !request.repaired_request.is_empty()
            && (req.utterance == request.request || req.utterance == request.repaired_request)
        {
            return request.repaired_request.as_str();
        }
        return req.utterance.as_str();
    }
    replayed
        .map(|request| {
            if request.repaired_request.is_empty() {
                request.request.as_str()
            } else {
                request.repaired_request.as_str()
            }
        })
        .unwrap_or("")
}

fn active_vision_request(req: &pb::SynapseUnderstandingRequest) -> bool {
    let Some(request) = newest_user_request(req) else {
        return false;
    };
    let requested = request.vision_requested()
        == pb::synapse_user_request_content::VisionRequested::Vision
        || !request.image_data.is_empty();
    requested
        && !req
            .device_context
            .as_ref()
            .is_some_and(|context| current_run_contains_action(&context.turns, VISION_ACTION))
}

/// The system line for a vision-gesture turn, or `None` when the wearer did not
/// aim the pin at anything.
///
/// Keyed off the RESOLVED catalog so the guidance can never point the model at a
/// tool this caller does not have, a text-only caller excludes every device
/// action, `UnderstandScene` included, and telling that model to call it would
/// buy a bounced `Unrecognized function name and/or arguments` and a wasted step.
fn vision_line(req: &pb::SynapseUnderstandingRequest, tools: &[ToolDef]) -> Option<String> {
    if !active_vision_request(req) {
        return None;
    }
    let request = newest_user_request(req)?;
    let mut line = if tools.iter().any(|t| t.name == VISION_ACTION) {
        VISION_GESTURE_POLICY.to_owned()
    } else {
        VISION_UNAVAILABLE_POLICY.to_owned()
    };
    // The frame the device prefetched is not dropped on the floor any more: its
    // presence is stated. It is NOT described here, this transport hands the
    // model text only, and inventing a description of bytes nobody looked at is
    // exactly the failure this whole line exists to prevent.
    if !request.image_data.is_empty() && tools.iter().any(|t| t.name == VISION_ACTION) {
        line.push_str(VISION_FRAME_ATTACHED);
    }
    Some(line)
}

/// The device action that looks at the wearer's camera view.
const VISION_ACTION: &str = "UnderstandScene";

/// turn's utterance. cosmos's legacy server is stateless per call and reconstructs
/// conversation state exactly this way.
/// Rebuild the chat transcript the model reasons over from the state the device
/// replayed: prior turns (`device_context.turns`), `previous_answers`, and this
/// turn's utterance. cosmos's legacy server is stateless per call and
/// reconstructs conversation state exactly this way.
fn build_history(req: &pb::SynapseUnderstandingRequest) -> Vec<ChatMessage> {
    // The same pointer that selects the tool subset selects the prompt: cosmos's
    // server resolved `tool_set_version` to BOTH. Giving a capability child the
    // narrow tool list without its narrow guidance is half the topology.
    let mut messages = vec![ChatMessage::system(catalog::system_prompt_for(
        resolved_tool_set(req).set,
    ))];
    if let Some(situation) = situation_line(req) {
        messages.push(ChatMessage::device_context(&situation));
    }

    if let Some(dc) = req.device_context.as_ref() {
        // Enforce cosmos's own `tao.contextCapacity`, keeping the MOST RECENT
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
                    // A prior step the server already resolved. Replay as context.
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
    let utterance = current_utterance(req);
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

// --- streaming helpers ----------------------------------------------------

async fn send(
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    msg: pb::SynapseUnderstandingResponse,
) -> Result<(), ()> {
    tx.send(Ok(msg)).await.map_err(|_| ())
}

/// Send the terminal action. Closing the server stream is the legacy protocol's
/// completion signal. An explicit `SynapseEndContent` is not accepted by stock
/// `SynapseInterpreter`, which logs it as an "Unexpected TAO response".
async fn finish(
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    terminal: pb::SynapseUnderstandingResponse,
) {
    finish_as(tx, terminal, None).await;
}

/// End the run the way the Pin ends one whose action a gate blocked: record the
/// non-final blocking observation, then dispatch the action the device itself
/// synthesizes from it (`convertAndDispatchGeneratedActionIfNeeded`), for the
/// keyguard `InstructUnlock`, for the account gate its degraded experience.
/// `false` when the stream closed before the refusal went out.
async fn rewrite_blocked(
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    action: &str,
    blocked: BlockingObservation,
    parent: String,
) -> bool {
    let obs_id = new_id();
    if send(
        tx,
        node(observation_turn(
            action,
            blocked.observation_text(),
            parent,
            obs_id.clone(),
            pb::SynapseSource::Device,
        )),
    )
    .await
    .is_err()
    {
        return false;
    }
    let id = new_id();
    finish(
        tx,
        // The synthesized action needs a real input object. The device parses
        // `input` unconditionally, so an empty string throws,
        // `Errors.deviceBlocked()` and `unsubscribed()` both send "{}".
        // `Respond`-shaped verdicts contain their spoken text instead.
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
                &serde_json::json!({ "Narration": blocked.observation_text() }).to_string(),
                "",
                obs_id,
                id,
            ),
            other => terminal_device_action(other, "{}", "", obs_id, id),
        },
    )
    .await;
    true
}

/// [`finish`], with the outcome label stated rather than derived.
///
/// The default is to derive it from the terminal, and that default is
/// load-bearing: `record_turn` shipped with zero callers, so the one metric that
/// answers "did the wearer get an answer?" was always zero, including through a
/// live regression where every news turn ended in the device's timeout string.
/// Reading the message that actually goes out means a future branch cannot
/// forget to count itself, which is the same reason the post-loop backstop
/// exists.
///
/// `outcome` exists for the one case that breaks the derivation honestly: a
/// model failure is SPOKEN as the device's own timeout sentence, deliberately,
/// so the wearer hears stock wording, but a refused API key and an exhausted
/// turn budget are different operator problems and must not share a label. Pass
/// it only where the spoken string is known to understate the cause.
async fn finish_as(
    tx: &Sender<Result<pb::SynapseUnderstandingResponse, Status>>,
    terminal: pb::SynapseUnderstandingResponse,
    outcome: Option<&'static str>,
) {
    crate::metrics::record_turn(outcome.unwrap_or_else(|| turn_outcome(&terminal)));
    let _ = send(tx, terminal).await;
}

/// Which model failure ended this turn, as a short constant.
///
/// Never the error's message: `LlmError::Transport` carries a reqwest string
/// that can contain the configured URL, and a metric label is not the place for
/// it. The kinds line up with the `cosmos_errors_total{kind=…}` values the model
/// client emits, so one incident reads the same in both families.
pub(crate) fn model_failure_outcome(error: &super::llm::LlmError) -> &'static str {
    use super::llm::LlmError;
    match error {
        LlmError::Status(_) => "model_refused",
        LlmError::Malformed => "model_malformed",
        LlmError::Transport(_) => "model_unreachable",
        #[cfg(test)]
        LlmError::ScriptExhausted => "model_unreachable",
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
        // The pin performs it and the doing is the feedback. No spoken reply is
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
/// turn trips the ceiling and dies in the canned apology, recovering only after
/// the inter-run gap flushes the window.
///
/// So walk `parent_identifier` from the newest turn back to the run root (the
/// turn with an empty parent), exactly as `EventsSnapshot.runFromHead` does, and
/// count only that chain. A window whose newest turn ends its run holds only
/// finished runs: the request is a new run (see [`current_run_user_request`])
/// and has taken no action yet.
pub(super) fn actions_in_current_run(turns: &[pb::SynapseChatTurn]) -> usize {
    use std::collections::HashMap;
    let by_id: HashMap<&str, &pb::SynapseChatTurn> =
        turns.iter().map(|t| (t.identifier.as_str(), t)).collect();

    let mut actions = 0usize;
    let mut cursor = turns.last().filter(|turn| !ends_its_run(turn));
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
pub(crate) fn current_run_contains_action(
    turns: &[pb::SynapseChatTurn],
    action_name: &str,
) -> bool {
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

pub(super) struct DeterministicDeviceAction {
    pub(super) name: &'static str,
    pub(super) input: String,
    pub(super) thought: &'static str,
}

pub(super) fn deterministic_device_action(
    req: &pb::SynapseUnderstandingRequest,
    tools: &[ToolDef],
) -> Option<DeterministicDeviceAction> {
    let offered = |name: &str| tools.iter().any(|tool| tool.name == name);
    let utterance = current_utterance(req);
    if tickle_near_miss_request(utterance) && offered(catalog::RESPOND_ACTION) {
        return Some(DeterministicDeviceAction {
            name: catalog::RESPOND_ACTION,
            input: catalog::respond_input(TICKLE_NEAR_MISS_RESPONSE),
            thought: "The wearer did not use one of the exact supported Tickle phrases",
        });
    }
    if unanswerable_forecast_request(utterance) && offered(catalog::RESPOND_ACTION) {
        return Some(DeterministicDeviceAction {
            name: catalog::RESPOND_ACTION,
            input: catalog::respond_input(FUTURE_WEATHER_UNAVAILABLE),
            thought: "No weather backend is connected to answer a forecast",
        });
    }
    let device_context = req.device_context.as_ref()?;
    let request_locked = device_context.is_locked;
    let current_turns = device_context.turns.as_slice();
    if let Some(action) = local_device_status_action(utterance) {
        let action_offered = offered(action.name);
        let action_replayed = current_run_contains_action(current_turns, action.name);
        if action_offered && !action_replayed {
            return Some(action);
        }
    }
    if let Some(action) = explicit_safe_stock_action(utterance) {
        let action_offered = offered(action.name);
        let action_replayed = current_run_contains_action(current_turns, action.name);
        let privacy_allowed = !request_locked || action.name != "Contacts";
        if action_offered && !action_replayed && privacy_allowed {
            return Some(action);
        }
    }
    if request_locked {
        return None;
    }
    if let Some(action) = deterministic_world_clock_action(req, tools) {
        return Some(action);
    }
    if let Some(request) = explicit_nutrition_request(utterance) {
        if offered("ManageNutrition")
            && !current_run_contains_action(current_turns, "ManageNutrition")
        {
            return Some(DeterministicDeviceAction {
                name: "ManageNutrition",
                input: serde_json::json!({"Request": request}).to_string(),
                thought: "The wearer explicitly requested the stock nutrition agent",
            });
        }
    }
    if let Some((agent, request)) = explicit_clock_agent_request(utterance) {
        if offered(agent) && !current_run_contains_action(current_turns, agent) {
            return Some(DeterministicDeviceAction {
                name: agent,
                input: serde_json::json!({"Request": request}).to_string(),
                thought: "The wearer explicitly requested a stock clock control",
            });
        }
    }

    location_preflight(req, tools)
}

pub(super) const LOCATION_PRIVACY_RESPONSE: &str =
    "Location access is off. Name a city or place, or turn on Location access in Privacy.";

/// INFERRED: exact requests that require the wearer's automatic position stop
/// before GPS, provider calls, or a model when location access is disabled.
pub(super) fn automatic_location_request(req: &pb::SynapseUnderstandingRequest) -> bool {
    let utterance = current_utterance(req);
    explicit_route_request(utterance)
        || local_weather_request(utterance)
        || local_forecast_request(utterance)
        || current_city_request(utterance)
        || explicit_nearby_query(utterance).is_some()
}

/// The stock location-first step: a route, local weather or forecast, city,
/// or nearby request asks the Pin for `GetCurrentLocation` before any tool
/// that needs the position runs, once per run. Both transports take it: the
/// legacy engine through [`deterministic_device_action`], and the bidi session
/// before its first model step, since a stock Pin on that transport reports its
/// position only as this action's observation.
pub(super) fn location_preflight(
    req: &pb::SynapseUnderstandingRequest,
    tools: &[ToolDef],
) -> Option<DeterministicDeviceAction> {
    let offered = |name: &str| tools.iter().any(|tool| tool.name == name);
    let utterance = current_utterance(req);
    // Only a Pin's request (one with a device context) has a device to ask.
    let current_turns = req.device_context.as_ref()?.turns.as_slice();
    if explicit_route_request(utterance)
        && req.location.is_none()
        && offered("GetCurrentLocation")
        && !current_run_contains_action(current_turns, "GetCurrentLocation")
    {
        return Some(DeterministicDeviceAction {
            name: "GetCurrentLocation",
            input: "{}".to_owned(),
            thought: "I should get the Pin's current location before finding the route",
        });
    }

    if local_weather_request(utterance)
        && offered("GetCurrentLocation")
        && !current_run_contains_action(current_turns, "GetCurrentLocation")
    {
        return Some(DeterministicDeviceAction {
            name: "GetCurrentLocation",
            input: "{}".to_owned(),
            thought: "I should get the Pin's current location before checking local weather",
        });
    }
    if local_forecast_request(utterance)
        && req.location.is_none()
        && offered("GetCurrentLocation")
        && !current_run_contains_action(current_turns, "GetCurrentLocation")
    {
        return Some(DeterministicDeviceAction {
            name: "GetCurrentLocation",
            input: "{}".to_owned(),
            thought: "I should get the Pin's current location before checking the local forecast",
        });
    }
    if (current_city_request(utterance) || explicit_nearby_query(utterance).is_some())
        && offered("GetCurrentLocation")
        && !current_run_contains_action(current_turns, "GetCurrentLocation")
    {
        return Some(DeterministicDeviceAction {
            name: "GetCurrentLocation",
            input: "{}".to_owned(),
            thought: "I should get the Pin's current location before resolving nearby places",
        });
    }

    None
}

/// Server-minted node id.
///
/// MUST be a UUID, not a per-call sequence. cosmos's `LocalChatTurnService.record`
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

/// A terminal DEVICE action turn: `source = DEVICE`, `is_final` set so the
/// response-level flag also signals end-of-run. This is the batch's final action,
/// which the legacy device consumer dispatches and executes. Used both for the
/// spoken answer (`Respond`) and for any device tool the model calls (SetTimer, …).
/// The `source` a terminal action carries.
///
/// `source` is not decoration, `Schema.java:207` sets
/// `action.setIsDeviceAction(ActionToJson.isDeviceAction(content.getSource()))`,
/// and `isDeviceAction` is exactly `source == DEVICE`. So it tells the Pin
/// whether IT must execute the action.
///
/// That splits the two cases cleanly:
///
///   * A genuine device action (`WorldClock`, `PlayMusic`, `SetTimer`) must be
///     `DEVICE`, the Pin performs it, and for World Clock it does so offline.
///   * `Respond` is `SERVER`, because the answer was produced server-side and the
///     device narrates it rather than executing anything.
///
/// The second half is measured, not reasoned: in a capture of the real cosmos
/// cloud, all 65 observed `Respond` actions carried `source: SERVER` (see
/// `tools/cosmos-action-ground-truth.mjs` in the PenumbraOS repo). This code
/// previously sent `DEVICE` for everything, which told a Pin to execute
/// `Respond` itself, a divergence from every real turn we have on record.
///
/// `COSMOS_RESPOND_SOURCE_DEVICE=1` restores the old behaviour, because this sits
/// on the one path that decides whether a wearer hears anything at all and no
/// real Pin has confirmed the change yet.
fn terminal_source(action: &str) -> pb::SynapseSource {
    if action == catalog::RESPOND_ACTION
        && !matches!(
            std::env::var("COSMOS_RESPOND_SOURCE_DEVICE")
                .ok()
                .as_deref(),
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
    // input but not from here quietly broke that mirror, the demo reads this
    // field, so a wearer heard one thing and a reader saw another.
    msg.response = catalog::speakable(answer);
    msg
}
