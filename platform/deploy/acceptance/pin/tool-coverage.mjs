#!/usr/bin/env node

// Tool-coverage sweep: which of the assistant's registered CAPABILITIES can
// actually be reached, and which have never been exercised at all?
//
// WHY THIS EXISTS: the behavioural suite (platform/deploy/acceptance/pin/prompt-suite.mjs) scores ~32
// prompts against expected ACTIONS. That is a planner contract, not coverage. A
// census over on-disk probe artifacts found only four tools ever observed
// executing, and ~25 registered capabilities with NO evidence in either
// direction. "It works" was never measured for most of the surface.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS FILE WAS REWRITTEN TO FIX (measured on device 2026-07-28)
// ---------------------------------------------------------------------------
// The first version of this sweep reported "0 reached" across 37 capabilities.
// That headline was WRONG, and the fault was in the instrument:
//
//   * A capability reaches the wearer through one of TWO surfaces. READ tools
//     (14, tools/catalog.rs:157-296) and the one WRITE tool (remember_fact,
//     tools/catalog.rs:311-332) log OPERATIONAL_MARKERS.tool_executed with
//     `tool=<snake_case> ok=<bool>`, which pinbox parses into
//     okTools/failedTools. The 21 MUTATION
//     tools (tools/catalog.rs:374-665) return `ToolExecutionOutcome::Terminal`
//     (tools/catalog.rs:2570-2573) and log NO such line — their success arrives
//     as a CamelCase native ACTION in the decoded response frames. Scoring a
//     mutation by okTools is unfalsifiable in BOTH directions: it can never be
//     met and can never trip. Five rows (get_current_time, get_battery_level,
//     am_i_online, get_current_volume, get_music_queue) were mis-declared as
//     reads for exactly this reason.
//   * "am I connected to the internet" returned NATIVE_ACTIONS.AM_I_ONLINE
//     (native_device_actions.rs:264-273 — that phrasing is an exact
//     deterministic arm). The old sweep looked for a read tool named
//     `am_i_online` and scored not-elicited. The capability worked.
//   * The answer extractor was inert: it called `require()` inside an ESM
//     module, threw, and was swallowed by a bare `catch {}` — so `answer` was
//     always "" and the load-bearing backend guard could never fire.
//
// This is the THIRD time a wrong or nonexistent name silently broke an
// instrument here. Hence the EXISTENCE GUARD below: every tool and action name
// this file uses is checked against the real Rust catalogs, and the check is
// exported so platform/deploy/acceptance/pin/tool-coverage.test.mjs can prove it goes red.
//
// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------
// This drives the same audited raw Understand probe the rest of the tooling
// uses, always in pinbox's default SAFE mode (`--dispatch` is never passed).
// Returned actions are DECODED AND COUNTED, NEVER DISPATCHED, so a sweep cannot
// send a message, place a call, start playback, take a photo, or set an alarm —
// even though it deliberately asks for all of those.
//
// ---------------------------------------------------------------------------
// STATUS VOCABULARY (what a row actually means)
// ---------------------------------------------------------------------------
//   reached      The READ/WRITE tool was selected and executed with ok=true.
//                `covered`.
//   planned      The capability's NATIVE ACTION came back in the decoded
//                frames (or the model's mutation-tool call terminated). The
//                device did NOT complete it: mutations are handed to stock for
//                dispatch, which this harness refuses to do. `covered`.
//                Proving a mutation end-to-end needs a real spoken turn.
//   failed       The tool ran and returned ok=false. Real signal.
//   rejected     The model DID call the mutation tool and a grounding gate
//                refused it (OPERATIONAL_MARKERS.mutation_rejected,
//                tools/catalog.rs:2485/2558-2562). Distinct from "the model
//                never asked" — those
//                were indistinguishable before this line was parsed.
//   gated        The capability is HIDDEN or DISABLED by a gate this harness
//                cannot satisfy (e.g. web_search needs a Brave subscription
//                key, tools/catalog.rs:2661 + turn/orchestration.rs:334-335). NOT a
//                coverage gap; do not report it as one.
//   unscoreable  The run cannot answer the question. Three causes, all named in
//                the detail: a NATIVE_ACTIONS.GET_CURRENT_LOCATION preflight
//                the raw probe cannot answer (turn/orchestration.rs:504-507);
//                a DEGRADED LOG WINDOW
//                (pinbox's boundary marker was evicted, so its fallback returns
//                the WHOLE buffer and a tool line may belong to an earlier
//                prompt); or an unreadable answer artifact, which would make
//                the backend guard silently inert.
//   backend      The turn ended in a provider/backend failure. Carries NO
//                information about the capability — re-run on a healthy backend.
//   other-tool   Something real happened, but not this capability's surface.
//   not-elicited Nothing ran and nothing was planned. The only true gap status.
//   probe-error  The probe itself failed.
//
// GATING NOTE — unlock/trust do NOT gate this sweep. The probe encodes
// `is_locked = 0` explicitly and a trusted user turn
// (platform/deploy/acceptance/pin/agentic-release-smoke-lib.mjs:545-560), so the eight unlock-required
// reads and the trusted-user mutations are satisfied by construction. Rows that
// contain `unlockRequired` and record that fact for the reader; marking them `gated`
// would MASK real coverage gaps, so it is deliberately not done.
//
// EVIDENCE NOTE — this file re-parses the per-prompt logcat window pinbox
// already wrote to disk (`files.logcat`, fenced by pinbox's own boundary
// marker, probe.mjs:231-239) rather than reading the device itself. That keeps
// the per-prompt window — a tool can never be attributed to a neighbouring
// prompt — while adding four markers pinbox does not parse. It is a deliberate
// second parser: pinbox owns its own tests and is not edited from here.
//
// Usage:
//   node platform/deploy/acceptance/pin/tool-coverage.mjs --serial SERIAL [--json] [--only name,name]
//                                [--settle-ms N] [--timeout-ms N]
//   node platform/deploy/acceptance/pin/tool-coverage.mjs --check-names      (no device; guard only)

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractAnswer, isMachineryLeak, isUnavailableAnswer } from "./prompt-suite.mjs";
import {
  NATIVE_ACTIONS,
  OPERATIONAL_MARKERS,
} from "./tier-a-symbols.mjs";

const DEFAULT_SETTLE_MS = 2_500;
const DEFAULT_TIMEOUT_MS = 90_000;

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../pin",
);
export const WORKSPACE_ROOT = resolve(REPO_ROOT, "..");

export const CATALOG_SOURCES = {
  toolCatalog: "runtime/core/src/services/aibus/tools/catalog.rs",
  actionCatalog: "runtime/core/src/synapse/catalog.rs",
};

// ---------------------------------------------------------------------------
// Names that DO NOT EXIST in the product. Kept as data so the guard can prove
// they never come back, with the real name to use instead. Both shipped as
// silent no-ops in platform/deploy/acceptance/pin/prompt-suite.mjs before it grew the same guard.
// ---------------------------------------------------------------------------
export const KNOWN_ABSENT_NAMES = {
  // grep '"current_time"' runtime/core/src -> no hits. The tool is get_current_time
  // (tools/catalog.rs:492) and the action is NATIVE_ACTIONS.GET_CURRENT_TIME.
  current_time:
    `${NATIVE_ACTIONS.GET_CURRENT_TIME} (catalog.rs:1438) / ` +
    "get_current_time (tools/catalog.rs:492)",
  // grep 'TakePhoto' runtime/core/src -> no hits.
  TakePhoto: `${NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH} (catalog.rs:1186)`,
  // There is no `take_photo`/`capture_photograph` hermes tool at all: the
  // camera is reachable ONLY through 11 exact phrases
  // (native_device_actions.rs:88-103).
  take_photo:
    `no tool exists — use the ${NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH} action ` +
    "with an exact phrase",
};

// ---------------------------------------------------------------------------
// Names that EXIST in NATIVE_ACTION_CATALOG but that the Understand RPC can
// NEVER return. They are nested stock-agent tool names reached only after stock
// re-enters the stock clock/contact/settings agent
// (services/aibus/tools/stock_agent.rs:26-48); from Understand you see only the
// ENTRY action. Expecting one is a name that can never match — the same
// "invisible in both directions" defect as a nonexistent name.
// ---------------------------------------------------------------------------
export const KNOWN_UNEMITTABLE_ACTION_NAMES = {
  [NATIVE_ACTIONS.DEVICE_STATUS]:
    `${NATIVE_ACTIONS.SETTINGS} (native_device_actions.rs:225-236 emits ` +
    `${NATIVE_ACTIONS.SETTINGS} containing a nested ` +
    `${NATIVE_ACTIONS.DEVICE_STATUS} Request)`,
  [NATIVE_ACTIONS.CANCEL_ALARM]:
    `${NATIVE_ACTIONS.ALARM} (the entry action; ` +
    `${NATIVE_ACTIONS.CANCEL_ALARM} is nested)`,
  [NATIVE_ACTIONS.DISPLAY_ALARM]:
    `${NATIVE_ACTIONS.ALARM} (the entry action; ` +
    `${NATIVE_ACTIONS.DISPLAY_ALARM} is nested)`,
  [NATIVE_ACTIONS.DELETE_TIMER]:
    `${NATIVE_ACTIONS.TIMER} (the entry action; ` +
    `${NATIVE_ACTIONS.DELETE_TIMER} is nested)`,
  [NATIVE_ACTIONS.DISPLAY_TIMER]:
    `${NATIVE_ACTIONS.TIMER} (the entry action; ` +
    `${NATIVE_ACTIONS.DISPLAY_TIMER} is nested)`,
  [NATIVE_ACTIONS.EDIT_TIMER]:
    `${NATIVE_ACTIONS.TIMER} (the entry action; ` +
    `${NATIVE_ACTIONS.EDIT_TIMER} is nested)`,
  [NATIVE_ACTIONS.PAUSE_TIMER]:
    `${NATIVE_ACTIONS.TIMER} (the entry action; ` +
    `${NATIVE_ACTIONS.PAUSE_TIMER} is nested)`,
  [NATIVE_ACTIONS.RESUME_TIMER]:
    `${NATIVE_ACTIONS.TIMER} (the entry action; ` +
    `${NATIVE_ACTIONS.RESUME_TIMER} is nested)`,
  [NATIVE_ACTIONS.SEARCH_CONTACT]:
    `${NATIVE_ACTIONS.CONTACTS} (the entry action; ` +
    `${NATIVE_ACTIONS.SEARCH_CONTACT} is nested)`,
  [NATIVE_ACTIONS.DISPLAY_CONTACT]:
    `${NATIVE_ACTIONS.CONTACTS} (the entry action; ` +
    `${NATIVE_ACTIONS.DISPLAY_CONTACT} is nested)`,
  [NATIVE_ACTIONS.SET_QUICK_MESSAGING_CONTACT]:
    `${NATIVE_ACTIONS.CONTACTS} (the entry action; ` +
    `${NATIVE_ACTIONS.SET_QUICK_MESSAGING_CONTACT} is nested)`,
  [NATIVE_ACTIONS.GET_QUICK_MESSAGING_PARTICIPANTS]:
    `${NATIVE_ACTIONS.CONTACTS} (the entry action; ` +
    `${NATIVE_ACTIONS.GET_QUICK_MESSAGING_PARTICIPANTS} is nested)`,
  // catalog.rs:1921 exists, but no emitter anywhere in runtime/core: a
  // language selection is emitted as NATIVE_ACTIONS.TRANSLATE containing Target
  // (synapse/capabilities/translation.rs:66-72).
  [NATIVE_ACTIONS.SET_DEFAULT_TRANSLATE_LANGUAGE]:
    `${NATIVE_ACTIONS.TRANSLATE} (catalog.rs:2026)`,
};

// ---------------------------------------------------------------------------
// Gates. A gate is a reason the product deliberately withholds a capability, so
// its absence is NOT a coverage gap. `answerPattern`, when present, is a
// verbatim product string: the guard test greps `source` for `literal` so a
// reworded string goes red instead of silently mis-scoring as a backend outage.
// ---------------------------------------------------------------------------
export const GATES = {
  braveSubscriptionKey: {
    id: "brave-subscription-key",
    detail: "web_search is removed from the advertised catalog unless a Brave subscription key is configured, so the model never sees it",
    evidence: "tools/catalog.rs:2661; services/aibus/turn/orchestration.rs:334-335",
  },
  foodRuntimePermit: {
    id: "food-runtime-permit",
    detail: "the food runtime permit is off, so the turn answers with the canned disabled string instead of using a food provider",
    evidence: "services/aibus/capabilities/food.rs:50-51",
    answerPattern: /food and nutrition is disabled/i,
    answerLiteral: "Food and nutrition is disabled",
    answerLiteralSource: "runtime/core/src/services/aibus/capabilities/food.rs",
  },
  visionActions: {
    id: "vision-actions-enabled-and-consented",
    detail: "visual If-Then actions require vision_actions_enabled=true and llm.vision_consent_acknowledged=true; either false makes the native planner withhold them",
    evidence: "services/aibus/understand.rs:2230-2241; config.rs:276-282",
  },
  fitnessTracker: {
    id: "fitness-tracker-enabled",
    detail: "starting a fitness session requires fitness_tracker_enabled=true; stopping remains reachable with the flag off so an active session can close",
    evidence: "synapse/native_device_actions.rs:363-364,1388-1446",
  },
};

// ---------------------------------------------------------------------------
// THE CASES. One prompt per capability, phrased the way a wearer would ask.
//
// Every case declares BOTH surfaces where they exist:
//   tool           the snake_case hermes tool, or null when none exists
//   actions        every CamelCase native action that legitimately satisfies it
//   successSignal  "tool-ok" | "action-planned" | "either"
//
// `actions` is a SET, not a single name, because two capabilities legitimately
// answer to more than one: the clock family is claimed pre-agentically by
// plan_clock_family_action (understand.rs:95-122, called at :4171), which
// returns stock agent-entry names; the nested set actions appear
// only when the classifier misses and the hermes tool fires. Both are correct.
//
// `note` records WHY the prompt is phrased this way, with the source line, so
// the next person can audit a verdict without re-deriving the routing.
// ---------------------------------------------------------------------------
export const COVERAGE_CASES = [
  // --- knowledge / web -----------------------------------------------------
  {
    id: "knowledge_lookup",
    capability: "Encyclopedia / general-knowledge lookup",
    tool: "knowledge_lookup",
    actions: [],
    successSignal: "tool-ok",
    prompt: "look up the Eiffel Tower and tell me how tall it is",
    note: "read spec tools/catalog.rs:160; always advertised (READ_TOOL_CATALOG catalog.rs:874)",
  },
  {
    id: "web_search",
    capability: "Open-web search",
    tool: "web_search",
    actions: [],
    successSignal: "tool-ok",
    gate: GATES.braveSubscriptionKey,
    prompt: "search the web for today's top news headline",
    note: "read spec tools/catalog.rs:171; HIDDEN from the catalog without a Brave key (tools/catalog.rs:2661)",
  },
  {
    id: "food_lookup",
    capability: "Nutrition facts for a food",
    tool: "food_lookup",
    actions: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    successSignal: "either",
    unlockRequired: true,
    gate: GATES.foodRuntimePermit,
    // WAS: "how many calories are in a Snickers bar" — that is a verbatim
    // deterministic prefix (synapse/capabilities/nutrition.rs:82), claimed by
    // plan_nutrition_action at understand.rs:4063 BEFORE the agentic loop, so
    // food_lookup could never be reached with it. This phrasing matches none of
    // the prefixes in is_explicit_nutrition_request (nutrition.rs:59-99).
    prompt: "what is the calorie count of a Snickers bar",
    note: "read spec tools/catalog.rs:288; prompt deliberately misses every nutrition.rs:59-99 prefix so the tool can run",
  },

  // --- memory --------------------------------------------------------------
  {
    id: "remember_fact",
    capability: "Save a fact to memory",
    tool: "remember_fact",
    actions: [],
    successSignal: "tool-ok",
    unlockRequired: true,
    prompt: "please remember that my favorite color is teal",
    note: "the only WRITE spec (tools/catalog.rs:313); emits an executed line at tools/catalog.rs:2237-2243",
  },
  {
    id: "memory_search",
    capability: "Search saved memories",
    tool: "memory_search",
    actions: [],
    successSignal: "tool-ok",
    unlockRequired: true,
    prompt: "what do you remember about me",
    note: "read spec tools/catalog.rs:281; unlock-required read (catalog.rs:97-109)",
  },

  // --- time / device state -------------------------------------------------
  // These five were declared as READS. They are MUTATION specs: their success
  // is a native action, never an `executed` log line. This is the mis-mapping
  // that produced the false "0 reached".
  {
    id: "get_current_time",
    capability: "Current time of day",
    tool: "get_current_time",
    actions: [NATIVE_ACTIONS.GET_CURRENT_TIME],
    successSignal: "action-planned",
    prompt: "what time is it",
    note: "mutation spec tools/catalog.rs:492; exact deterministic arm (native_device_actions.rs:155) so the tool never runs",
  },
  {
    id: "get_battery_level",
    capability: "Battery level",
    tool: "get_battery_level",
    actions: [NATIVE_ACTIONS.GET_BATTERY_LEVEL],
    successSignal: "action-planned",
    prompt: "how much battery do I have left",
    note: "mutation spec tools/catalog.rs:485; NOT a deterministic arm (the table has 'how much battery do i have' / 'how much battery is left', native_device_actions.rs:247-263), so this row genuinely tests the tool",
  },
  {
    id: "am_i_online",
    capability: "Network connectivity",
    tool: "am_i_online",
    actions: [NATIVE_ACTIONS.AM_I_ONLINE],
    successSignal: "action-planned",
    prompt: "am I connected to the internet",
    note: `mutation spec tools/catalog.rs:499; exact deterministic arm (native_device_actions.rs:266) — the ${NATIVE_ACTIONS.AM_I_ONLINE} observed on device proves the CAPABILITY, not the tool`,
  },
  {
    id: "get_current_volume",
    capability: "Current volume level",
    tool: "get_current_volume",
    actions: [NATIVE_ACTIONS.GET_CURRENT_VOLUME],
    successSignal: "action-planned",
    prompt: "what is the volume set to",
    note: "mutation spec tools/catalog.rs:429; 'what is the volume' IS an arm but 'set to' is not (native_device_actions.rs:274-287), so the tool owns it",
  },
  {
    id: "set_alarm",
    capability: "Set an alarm",
    tool: "set_alarm",
    actions: [NATIVE_ACTIONS.ALARM, NATIVE_ACTIONS.SET_ALARM],
    successSignal: "action-planned",
    prompt: "set an alarm for 7 am",
    note: `mutation spec tools/catalog.rs:590 -> ${NATIVE_ACTIONS.SET_ALARM}; but plan_clock_family_action (understand.rs:95-122, :4171) claims this pre-agentically and returns the entry action ${NATIVE_ACTIONS.ALARM} (catalog.rs:1143). Either is correct`,
  },
  {
    id: "set_timer",
    capability: "Set a timer",
    tool: "set_timer",
    actions: [NATIVE_ACTIONS.TIMER, NATIVE_ACTIONS.SET_TIMER],
    successSignal: "action-planned",
    prompt: "set a timer for 10 minutes",
    note: `mutation spec tools/catalog.rs:556 -> ${NATIVE_ACTIONS.SET_TIMER}; same pre-agentic split as the alarm — entry action ${NATIVE_ACTIONS.TIMER} (catalog.rs:2017)`,
  },

  // --- volume --------------------------------------------------------------
  {
    id: "increment_volume",
    capability: "Volume up (relative)",
    tool: "increment_volume",
    actions: [NATIVE_ACTIONS.INCREMENT_VOLUME],
    successSignal: "action-planned",
    prompt: "turn the volume up a bit",
    note: "mutation spec tools/catalog.rs:391; not a deterministic arm, so the tool or the forced terminal nudge (tools/catalog.rs:2727-2776) owns it",
  },
  {
    id: "decrement_volume",
    capability: "Volume down (relative)",
    tool: "decrement_volume",
    actions: [NATIVE_ACTIONS.DECREMENT_VOLUME],
    successSignal: "action-planned",
    prompt: "turn the volume down a bit",
    note:
      "mutation spec tools/catalog.rs:398; measured on device — logcat carries `" +
      OPERATIONAL_MARKERS.mutation.value +
      ` tool=decrement_volume action="${NATIVE_ACTIONS.DECREMENT_VOLUME}"` +
      "` while okTools stayed empty",
  },
  {
    id: "set_volume",
    capability: "Volume to an exact level",
    tool: "set_volume",
    actions: [NATIVE_ACTIONS.SET_VOLUME],
    successSignal: "action-planned",
    prompt: "set the volume to 30",
    note: "mutation spec tools/catalog.rs:405; claimed pre-agentically by parse_set_volume_level (native_device_actions.rs:69-78)",
  },

  // --- music: reads --------------------------------------------------------
  {
    id: "music_catalog_search",
    capability: "Music catalog search",
    tool: "music_catalog_search",
    actions: [],
    successSignal: "tool-ok",
    prompt: "what is Dr. Dre's most popular song",
    note: "read spec tools/catalog.rs:264; provider failure surfaces as ok=false",
  },
  {
    id: "music_artist_top_tracks",
    capability: "Artist top tracks",
    tool: "music_artist_top_tracks",
    actions: [],
    successSignal: "tool-ok",
    prompt: "what are Fleetwood Mac's top tracks",
    note: "read spec tools/catalog.rs:257; S1 NER can seed a missing artist (tools/catalog.rs:2591-2598)",
  },
  {
    id: "current_music",
    capability: "What is playing now",
    tool: "current_music",
    // The deterministic contextual arm (music.rs:1309-1321) answers with a
    // plain response. NATIVE_ACTIONS.RESPOND is DELIBERATELY not listed: it is the universal
    // text terminal, so counting it would make every spoken turn green — an
    // expectation that can never fail is as useless as one that can never pass.
    actions: [],
    successSignal: "tool-ok",
    unlockRequired: true,
    prompt: "what song is playing right now",
    note: "read spec tools/catalog.rs:274; 'what song is playing' IS a contextual arm (music.rs:1316) but 'right now' misses it — measured on device, current_music genuinely executed",
  },
  {
    id: "get_music_queue",
    capability: "What is queued next",
    tool: "get_music_queue",
    actions: [NATIVE_ACTIONS.GET_MUSIC_QUEUE],
    successSignal: "action-planned",
    prompt: "what is next in the queue",
    note: "mutation spec tools/catalog.rs:478 (NOT a read); not one of the deterministic GetQueue arms (music.rs:1108-1128), so the tool owns it",
  },

  // --- music: transport / playback (mutations; NEVER dispatched) -----------
  {
    id: "play_music",
    capability: "Play a named track/artist",
    tool: "play_music",
    actions: [NATIVE_ACTIONS.PLAY_MUSIC],
    successSignal: "action-planned",
    prompt: "play Dr. Dre's most popular song",
    note: "PLAY_MUSIC_TOOL tools/catalog.rs:338, Terminal at :2488-2491; needs a same-run music search cited by from_call_id plus per-turn grounding (:2395-2411)",
  },
  {
    id: "play_favorite_tracks",
    capability: "Play my favourites",
    tool: "play_favorite_tracks",
    actions: [NATIVE_ACTIONS.PLAY_FAVORITE_TRACKS],
    successSignal: "action-planned",
    prompt: "play my favourites",
    note: "mutation spec tools/catalog.rs:511; 'play my favourites' IS a deterministic arm (music.rs:1211), so the tool is pre-empted",
  },
  {
    id: "play_featured_music",
    capability: "Play featured music",
    tool: "play_featured_music",
    actions: [NATIVE_ACTIONS.PLAY_FEATURED_MUSIC],
    successSignal: "action-planned",
    prompt: "play some featured music",
    note: "mutation spec tools/catalog.rs:520; NOT a deterministic arm (music.rs:1197-1199 has only 'play music'/'play some music'/'play something'), so the tool owns it",
  },
  {
    id: "pause_music",
    capability: "Pause playback",
    tool: "pause_music",
    actions: [NATIVE_ACTIONS.PAUSE_MUSIC],
    successSignal: "action-planned",
    prompt: "pause the music",
    note: "mutation spec tools/catalog.rs:436; deterministic arm (music.rs:1135-1147) — tool pre-empted",
  },
  {
    id: "resume_music",
    capability: "Resume playback",
    tool: "resume_music",
    actions: [NATIVE_ACTIONS.RESUME_MUSIC],
    successSignal: "action-planned",
    prompt: "resume the music",
    note: "mutation spec tools/catalog.rs:443; deterministic arm (music.rs:1149-1160) — tool pre-empted",
  },
  {
    id: "next_track",
    capability: "Skip to next track",
    tool: "next_track",
    actions: [NATIVE_ACTIONS.NEXT_TRACK],
    successSignal: "action-planned",
    prompt: "skip this song",
    note: "mutation spec tools/catalog.rs:450; deterministic arm (music.rs:1162-1171) — tool pre-empted",
  },
  {
    id: "previous_track",
    capability: "Previous track",
    tool: "previous_track",
    actions: [NATIVE_ACTIONS.PREVIOUS_TRACK],
    successSignal: "action-planned",
    prompt: "go back to the previous song",
    note: "mutation spec tools/catalog.rs:457; deterministic arm (music.rs:1173-1180) — tool pre-empted",
  },
  {
    id: "restart_track",
    capability: "Restart current track",
    tool: "restart_track",
    actions: [NATIVE_ACTIONS.RESTART_TRACK],
    successSignal: "action-planned",
    prompt: "start this song over",
    note: "mutation spec tools/catalog.rs:464; deterministic arm (music.rs:1182-1195) — tool pre-empted",
  },
  {
    id: "save_current_track_to_favorites",
    capability: "Save current track to favourites",
    tool: "save_current_track_to_favorites",
    actions: [NATIVE_ACTIONS.SAVE_CURRENT_TRACK_TO_FAVORITES],
    successSignal: "action-planned",
    prompt: "add this song to my favourites",
    note: "mutation spec tools/catalog.rs:471; the BRITISH spelling misses the deterministic 'add this song to my favorites' (music.rs:1252), so this row does reach the tool",
  },
  {
    id: "generate_music_playlist",
    capability: "Generate a playlist",
    tool: "generate_music_playlist",
    actions: [NATIVE_ACTIONS.GENERATE_MUSIC_PLAYLIST],
    successSignal: "action-planned",
    prompt: "make me a playlist for working out",
    note: "mutation spec tools/catalog.rs:529; the playlist argument must be the verbatim requested topic (tools/catalog.rs:2528-2535)",
  },
  {
    id: NATIVE_ACTIONS.PLAY_CURRENT_TRACK_RADIO,
    capability: "Play similar songs / track radio",
    tool: null,
    actions: [NATIVE_ACTIONS.PLAY_CURRENT_TRACK_RADIO],
    successSignal: "action-planned",
    prompt: "play similar songs",
    note: "MISSING from the old sweep. NO hermes tool exists (FIELDLESS_DIRECT_MUSIC_MUTATION_ACTIONS lists it at tools/catalog.rs:667-671 but mutation_specs() does not expose one), so it is reachable only via the exact phrases at music.rs:1259-1275",
  },

  // --- communication (mutations; NEVER dispatched) -------------------------
  {
    id: "send_message",
    capability: "Send a text message",
    tool: "send_message",
    actions: [NATIVE_ACTIONS.COMPOSE_MESSAGE],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "send a message to Alex saying I am running late",
    note: `mutation spec tools/catalog.rs:616 -> ${NATIVE_ACTIONS.COMPOSE_MESSAGE}; claimed pre-agentically by parse_compose_request (messaging.rs:326-358, understand.rs:4015). NEVER dispatched by this harness`,
  },
  {
    id: "call_person",
    capability: "Place a phone call",
    tool: "call_person",
    actions: [NATIVE_ACTIONS.CALL_PERSON],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "call Alex",
    note: "mutation spec tools/catalog.rs:643; claimed pre-agentically by plan_call_person (communications.rs:193-230). NEVER dispatched by this harness",
  },
  {
    id: NATIVE_ACTIONS.MESSAGE_SEARCH,
    capability: "Search my messages",
    tool: null,
    actions: [NATIVE_ACTIONS.MESSAGE_SEARCH],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "what did Alex say",
    note: `MISSING from the old sweep. NO hermes tool; ${NATIVE_ACTIONS.MESSAGE_SEARCH} is the first hop (communications.rs:452-468) and ${NATIVE_ACTIONS.DISPLAY_MESSAGES} only ever arrives as its parent-linked continuation, so a single-shot probe can see ${NATIVE_ACTIONS.MESSAGE_SEARCH} alone`,
  },
  {
    id: NATIVE_ACTIONS.CATCH_ME_UP,
    capability: "Catch me up / what did I miss",
    tool: null,
    actions: [NATIVE_ACTIONS.CATCH_ME_UP],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "catch me up",
    note: "MISSING from the old sweep. NO hermes tool; five exact phrases only and fails closed on unknown lock state (communications.rs:152-166)",
  },

  // --- device controls with NO tool (exact phrases only) -------------------
  {
    id: NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH,
    capability: "Take a photo",
    tool: null,
    actions: [NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH],
    successSignal: "action-planned",
    prompt: "take a photo",
    note: "MISSING from the old sweep. NO hermes tool: reachable ONLY through the 11 exact phrases at native_device_actions.rs:88-103. This is the action prompt-suite once named with the nonexistent 'TakePhoto'",
  },
  {
    id: NATIVE_ACTIONS.GET_BLUETOOTH_STATUS,
    capability: "Bluetooth status",
    tool: null,
    actions: [NATIVE_ACTIONS.GET_BLUETOOTH_STATUS],
    successSignal: "action-planned",
    prompt: "is bluetooth on",
    note: "MISSING from the old sweep. NO hermes tool and NO agentic fallback — three exact phrases (native_device_actions.rs:288-293); any other phrasing is silence",
  },
  {
    id: NATIVE_ACTIONS.GET_AIRPLANE_MODE_STATUS,
    capability: "Airplane-mode status",
    tool: null,
    actions: [NATIVE_ACTIONS.GET_AIRPLANE_MODE_STATUS],
    successSignal: "action-planned",
    prompt: "is airplane mode on",
    note: "MISSING from the old sweep. NO hermes tool and NO agentic fallback — three exact phrases (native_device_actions.rs:294-299)",
  },
  {
    id: NATIVE_ACTIONS.SETTINGS,
    capability: "Device status report",
    tool: null,
    actions: [NATIVE_ACTIONS.SETTINGS],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "give me a device status report",
    note: `MISSING from the old sweep. NO hermes tool; the returned action is ${NATIVE_ACTIONS.SETTINGS} containing a nested ${NATIVE_ACTIONS.DEVICE_STATUS} Request (native_device_actions.rs:225-236) — expecting ${NATIVE_ACTIONS.DEVICE_STATUS} would be a name that can never match`,
  },
  {
    id: NATIVE_ACTIONS.TRANSLATE,
    capability: `${NATIVE_ACTIONS.TRANSLATE} a phrase`,
    tool: null,
    actions: [NATIVE_ACTIONS.TRANSLATE],
    successSignal: "action-planned",
    prompt: "translate good morning to French",
    note: "MISSING from the old sweep. NO hermes tool; deterministic only (translation.rs:170+) and only for the six languages at translation.rs:37-60",
  },
  {
    id: NATIVE_ACTIONS.WORLD_CLOCK,
    capability: "Time in another city",
    tool: null,
    actions: [NATIVE_ACTIONS.WORLD_CLOCK],
    successSignal: "action-planned",
    prompt: "what time is it in Tokyo",
    note: "MISSING from the old sweep. NO hermes tool; three stock regex-shaped prefixes followed by 1-3 plain name words (tools/stock_agent.rs:1857-1882)",
  },

  // --- complete native-device compatibility surface ----------------------
  // These have no hermes tool. Every row is an exact deterministic grammar in
  // native_device_actions.rs and the safe harness only decodes the returned
  // action; it never dispatches camera, radio, fitness, privacy, or settings
  // mutations to the device.
  {
    id: NATIVE_ACTIONS.CLEAR_UNDERSTANDING_CONTEXT,
    capability: "Reset the short-term interaction session",
    tool: null,
    actions: [NATIVE_ACTIONS.CLEAR_UNDERSTANDING_CONTEXT],
    successSignal: "action-planned",
    prompt: "reset session",
    note: "exact two-word action in native_device_actions.rs:49-63; whitespace and case may vary, punctuation and polite prefixes may not",
  },
  {
    id: NATIVE_ACTIONS.CAPTURE_VIDEO,
    capability: "Start recording a video",
    tool: null,
    actions: [NATIVE_ACTIONS.CAPTURE_VIDEO],
    successSignal: "action-planned",
    prompt: "record a video",
    note: "strict camera grammar in native_device_actions.rs:105-118; stock CaptureVideo is keyguard-enabled",
  },
  {
    id: NATIVE_ACTIONS.STOP_VIDEO,
    capability: "Stop recording a video",
    tool: null,
    actions: [NATIVE_ACTIONS.STOP_VIDEO],
    successSignal: "action-planned",
    prompt: "stop recording video",
    note: "strict camera grammar in native_device_actions.rs:119-124; stock StopVideo is keyguard-enabled",
  },
  {
    id: NATIVE_ACTIONS.OPEN_RECENT_PHOTOS,
    capability: "Open the private recent-photo gallery",
    tool: null,
    actions: [NATIVE_ACTIONS.OPEN_RECENT_PHOTOS],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "show me my recent photos",
    note: "strict gallery grammar in native_device_actions.rs:125-140; explicit unlocked state is enforced at :351-352",
  },
  {
    id: NATIVE_ACTIONS.LOCK_DEVICE,
    capability: "Lock the Pin",
    tool: null,
    actions: [NATIVE_ACTIONS.LOCK_DEVICE],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "lock my device",
    note: "three exact lock commands in native_device_actions.rs:142-152; strict syntax and explicit unlocked state are enforced at :378-380",
  },
  {
    id: NATIVE_ACTIONS.ENTER_PRIVACY_MODE,
    capability: "Enter privacy mode",
    tool: null,
    actions: [NATIVE_ACTIONS.ENTER_PRIVACY_MODE],
    successSignal: "action-planned",
    prompt: "enter privacy mode",
    note: "strict local mutation grammar in native_device_actions.rs:168-173 and :367-373; keyguard-safe in the stock catalog",
  },
  {
    id: NATIVE_ACTIONS.START_ACTIVITY_TRACKER,
    capability: "Start fitness activity tracking",
    tool: null,
    actions: [NATIVE_ACTIONS.START_ACTIVITY_TRACKER],
    successSignal: "action-planned",
    gate: GATES.fitnessTracker,
    prompt: "start tracking my workout",
    note: "strict fitness grammar in native_device_actions.rs:184-196; start is withheld unless the live fitness_tracker_enabled flag is true",
  },
  {
    id: NATIVE_ACTIONS.STOP_ACTIVITY_TRACKER,
    capability: "Stop fitness activity tracking",
    tool: null,
    actions: [NATIVE_ACTIONS.STOP_ACTIVITY_TRACKER],
    successSignal: "action-planned",
    prompt: "stop tracking my workout",
    note: "strict fitness grammar in native_device_actions.rs:197-209; cleanup deliberately remains reachable when the start gate is off",
  },
  {
    id: NATIVE_ACTIONS.OPEN_TUTORIAL,
    capability: "Open the Laser Ink tutorial",
    tool: null,
    actions: [NATIVE_ACTIONS.OPEN_TUTORIAL],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "open laser ink tutorial",
    note: "strict tutorial grammar in native_device_actions.rs:210-220; explicit unlocked state is enforced at :355-357",
  },
  {
    id: NATIVE_ACTIONS.GET_PHONE_NUMBER,
    capability: "Read the Pin phone number",
    tool: null,
    actions: [NATIVE_ACTIONS.GET_PHONE_NUMBER],
    successSignal: "action-planned",
    prompt: "tell me my phone number",
    note: "read-only device alias in native_device_actions.rs:301-312; preserves the stock action's keyguard-enabled declaration",
  },
  {
    id: NATIVE_ACTIONS.GET_SERIAL_NUMBER,
    capability: "Read the Pin serial number",
    tool: null,
    actions: [NATIVE_ACTIONS.GET_SERIAL_NUMBER],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "tell me my serial number",
    note: "read-only identifier alias in native_device_actions.rs:313-325; explicit unlocked state is enforced at :353-354",
  },
  {
    id: "connect_bluetooth_device",
    capability: "Connect a named Bluetooth device",
    tool: null,
    actions: [NATIVE_ACTIONS.SETTINGS],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "connect to my Acme Nova X1",
    note: "native_device_actions.rs:326-344 enters Settings with the exact Request; settings/3 resolves GetNewBluetoothAddress before ConnectToBluetooth, so the safe single-shot probe sees only Settings",
  },
  {
    id: "disconnect_bluetooth_device",
    capability: "Disconnect a named Bluetooth device",
    tool: null,
    actions: [NATIVE_ACTIONS.SETTINGS],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "disconnect from Acme Nova X1",
    note: "native_device_actions.rs:326-344 enters Settings with the exact Request; settings/3 resolves GetPairedBluetoothAddress before DisconnectBluetooth, so the safe single-shot probe sees only Settings",
  },
  {
    id: NATIVE_ACTIONS.TICKLE,
    capability: "Open the stock Tickle experience",
    tool: null,
    actions: [NATIVE_ACTIONS.TICKLE],
    successSignal: "action-planned",
    prompt: "tickle my fancy",
    note: "feature-gated exact grammar in native_device_actions.rs:400-412; the clone serves the captured tickle flag true by default",
  },
  {
    id: NATIVE_ACTIONS.ADD_IF_THEN_ENTRY,
    capability: "Add a visual If-Then action",
    tool: null,
    actions: [NATIVE_ACTIONS.ADD_IF_THEN_ENTRY],
    successSignal: "action-planned",
    gate: GATES.visionActions,
    prompt: "if you see a red bicycle then take a picture",
    note: "bounded visual rule grammar in native_device_actions.rs:414-423,502-532; emits exact If and Then fields only while the live vision gate and consent are true",
  },
  {
    id: NATIVE_ACTIONS.CLEAR_IF_THEN_MAP,
    capability: "Clear all visual If-Then actions",
    tool: null,
    actions: [NATIVE_ACTIONS.CLEAR_IF_THEN_MAP],
    successSignal: "action-planned",
    gate: GATES.visionActions,
    prompt: "clear vision actions",
    note: "feature-gated exact grammar in native_device_actions.rs:424-433,657-662; destructive map clear is never dispatched by this harness",
  },
  {
    id: NATIVE_ACTIONS.GET_IF_THEN_MAP_SIZE,
    capability: "Count saved visual If-Then actions",
    tool: null,
    actions: [NATIVE_ACTIONS.GET_IF_THEN_MAP_SIZE],
    successSignal: "action-planned",
    gate: GATES.visionActions,
    prompt: "tell me the number of vision actions",
    note: "feature-gated read grammar in native_device_actions.rs:434-441,664-683",
  },
  {
    id: NATIVE_ACTIONS.CHANGE_QUICK_ACTION,
    capability: "Remap the two-finger Quick Action",
    tool: null,
    actions: [NATIVE_ACTIONS.CHANGE_QUICK_ACTION],
    successSignal: "action-planned",
    prompt: "change my quick action to notes",
    note: "feature-gated allowlisted grammar in native_device_actions.rs:444-453,686-722; targets are notes, messages, or interpreter and the clone serves the captured flag true by default",
  },

  // --- restored stock settings, trust, contact, and power actions --------
  // The server only plans these actions. Android's installed stock handlers
  // remain responsible for radio state, enrollment UI, confirmation, and the
  // actual mutation. Stock keyguard annotations are enforced by the planner.
  {
    id: NATIVE_ACTIONS.CONNECT_TO_WIFI,
    capability: "Open Wi-Fi connection setup",
    tool: null,
    actions: [NATIVE_ACTIONS.CONNECT_TO_WIFI],
    successSignal: "action-planned",
    prompt: "Connect to Wi-Fi",
    note: "strict restored-stock grammar at native_device_actions.rs:424-427; opens the installed selector/QR flow without handling credentials server-side",
  },
  {
    id: NATIVE_ACTIONS.CREATE_CONTACT,
    capability: "Create a trusted contact",
    tool: null,
    actions: [NATIVE_ACTIONS.CREATE_CONTACT],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Add a contact Ada Lovelace with phone number +45 12 34 56 78",
    note: "bounded name-and-number parser at native_device_actions.rs:573-673; the installed stock handler always creates the contact as trusted",
  },
  {
    id: NATIVE_ACTIONS.DISCONNECT_WIFI,
    capability: "Disconnect Wi-Fi",
    tool: null,
    actions: [NATIVE_ACTIONS.DISCONNECT_WIFI],
    successSignal: "action-planned",
    prompt: "Disconnect from Wi-Fi",
    note: "strict restored-stock grammar at native_device_actions.rs:428-431; dispatch remains with the installed settings handler",
  },
  {
    id: NATIVE_ACTIONS.FACTORY_RESET,
    capability: "Open factory-reset confirmation",
    tool: null,
    actions: [NATIVE_ACTIONS.FACTORY_RESET],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Factory reset my Pin",
    note: "strict restored-stock grammar at native_device_actions.rs:432-435; emits CENTRAL FactoryReset so the installed confirmation flow remains authoritative",
  },
  {
    id: NATIVE_ACTIONS.REBOOT,
    capability: "Reboot the Pin",
    tool: null,
    actions: [NATIVE_ACTIONS.REBOOT],
    successSignal: "action-planned",
    prompt: "Reboot my Pin",
    note: "strict restored-stock grammar at native_device_actions.rs:436-439; the safe coverage harness never dispatches the reboot",
  },
  {
    id: NATIVE_ACTIONS.SET_UP_TOUCHCODE,
    capability: "Open Touchcode enrollment",
    tool: null,
    actions: [NATIVE_ACTIONS.SET_UP_TOUCHCODE],
    successSignal: "action-planned",
    prompt: "Set up Touchcode",
    note: "strict restored-stock grammar at native_device_actions.rs:440-443; opens the installed enrollment experience",
  },
  {
    id: NATIVE_ACTIONS.TRUST_LOCK,
    capability: "Enable Trust Lock",
    tool: null,
    actions: [NATIVE_ACTIONS.TRUST_LOCK],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Enable Trust Lock",
    note: "strict restored-stock grammar at native_device_actions.rs:444-447; stock marks the action keyguard-disabled",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_AIRPLANE_MODE,
    capability: "Disable airplane mode",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_AIRPLANE_MODE],
    successSignal: "action-planned",
    prompt: "Turn off airplane mode",
    note: "strict restored-stock radio grammar at native_device_actions.rs:448-451",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_AMBER_ALERT,
    capability: "Disable Amber alerts",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_AMBER_ALERT],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn off Amber alerts",
    note: "strict restored-stock alert grammar at native_device_actions.rs:452-455; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_BLUETOOTH,
    capability: "Disable Bluetooth",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_BLUETOOTH],
    successSignal: "action-planned",
    prompt: "Turn off Bluetooth",
    note: "strict restored-stock radio grammar at native_device_actions.rs:456-459",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_CELLULAR_DATA,
    capability: "Disable cellular data",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_CELLULAR_DATA],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn off cellular data",
    note: "strict restored-stock modem grammar at native_device_actions.rs:460-463; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_CELLULAR_ROAMING,
    capability: "Disable cellular roaming",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_CELLULAR_ROAMING],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn off cellular roaming",
    note: "strict restored-stock modem grammar at native_device_actions.rs:464-467; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_DEVICE,
    capability: "Power off the Pin",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_DEVICE],
    successSignal: "action-planned",
    prompt: "Turn off my Pin",
    note: "strict restored-stock power grammar at native_device_actions.rs:468-479; the safe coverage harness never dispatches shutdown",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_EMERGENCY_ALERT,
    capability: "Disable emergency alerts",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_EMERGENCY_ALERT],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn off emergency alerts",
    note: "strict restored-stock alert grammar at native_device_actions.rs:480-486; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_PUBLIC_SAFETY_ALERT,
    capability: "Disable public-safety alerts",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_PUBLIC_SAFETY_ALERT],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn off public safety alerts",
    note: "strict restored-stock alert grammar at native_device_actions.rs:487-493; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_OFF_WIFI,
    capability: "Disable the Wi-Fi radio",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_OFF_WIFI],
    successSignal: "action-planned",
    prompt: "Turn off Wi-Fi",
    note: "strict restored-stock radio grammar at native_device_actions.rs:494-497",
  },
  {
    id: NATIVE_ACTIONS.TURN_ON_AIRPLANE_MODE,
    capability: "Enable airplane mode",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_ON_AIRPLANE_MODE],
    successSignal: "action-planned",
    prompt: "Turn on airplane mode",
    note: "strict restored-stock radio grammar at native_device_actions.rs:498-501",
  },
  {
    id: NATIVE_ACTIONS.TURN_ON_AMBER_ALERT,
    capability: "Enable Amber alerts",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_ON_AMBER_ALERT],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn on Amber alerts",
    note: "strict restored-stock alert grammar at native_device_actions.rs:502-505; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_ON_BLUETOOTH,
    capability: "Enable Bluetooth",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_ON_BLUETOOTH],
    successSignal: "action-planned",
    prompt: "Turn on Bluetooth",
    note: "strict restored-stock radio grammar at native_device_actions.rs:506-509",
  },
  {
    id: NATIVE_ACTIONS.TURN_ON_CELLULAR_DATA,
    capability: "Enable cellular data",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_ON_CELLULAR_DATA],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn on cellular data",
    note: "strict restored-stock modem grammar at native_device_actions.rs:510-513; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_ON_CELLULAR_ROAMING,
    capability: "Enable cellular roaming",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_ON_CELLULAR_ROAMING],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn on cellular roaming",
    note: "strict restored-stock modem grammar at native_device_actions.rs:514-517; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_ON_EMERGENCY_ALERT,
    capability: "Enable emergency alerts",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_ON_EMERGENCY_ALERT],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn on emergency alerts",
    note: "strict restored-stock alert grammar at native_device_actions.rs:518-524; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_ON_PUBLIC_SAFETY_ALERT,
    capability: "Enable public-safety alerts",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_ON_PUBLIC_SAFETY_ALERT],
    successSignal: "action-planned",
    unlockRequired: true,
    prompt: "Turn on public safety alerts",
    note: "strict restored-stock alert grammar at native_device_actions.rs:525-531; stock requires unlock",
  },
  {
    id: NATIVE_ACTIONS.TURN_ON_WIFI,
    capability: "Enable the Wi-Fi radio",
    tool: null,
    actions: [NATIVE_ACTIONS.TURN_ON_WIFI],
    successSignal: "action-planned",
    prompt: "Turn on Wi-Fi",
    note: "strict restored-stock radio grammar at native_device_actions.rs:532-535",
  },
  {
    id: NATIVE_ACTIONS.WIFI_QR_SCAN,
    capability: "Scan a Wi-Fi QR code",
    tool: null,
    actions: [NATIVE_ACTIONS.WIFI_QR_SCAN],
    successSignal: "action-planned",
    prompt: "Scan Wi-Fi QR code",
    note: "strict restored-stock grammar at native_device_actions.rs:536-542; opens the installed scanner and never handles credentials server-side",
  },

  // --- location family -----------------------------------------------------
  // `locationDependent` is now on current_location ALONE. It is the only read
  // with the generated location-preflight action
  // (catalog.rs:931) and the only broker arm that returns
  // ExternalDevicePreflight (turn/orchestration.rs:504-507). The others call
  // current_coordinates()/require_current_coordinates() and return ok=false with
  // a reason (turn/orchestration.rs:515/539/560) — a genuine `failed`, not unscoreable.
  // When the model calls current_location FIRST and stalls, the staged
  // NATIVE_ACTIONS.GET_CURRENT_LOCATION shows up in plannedActions and
  // classify() detects it,
  // which is how that case stays unscoreable WITHOUT a blanket flag.
  {
    id: "current_location",
    capability: "Where am I (device coordinates)",
    tool: "current_location",
    // NATIVE_ACTIONS.GET_CURRENT_LOCATION is deliberately NOT listed as a
    // success action: the
    // staged preflight (turn/orchestration.rs:504-507) is the server WAITING, not the
    // capability delivering, so counting it would turn the one genuinely
    // unscoreable row green. classify() reports the staged preflight as
    // unscoreable instead.
    actions: [],
    stagedActions: [NATIVE_ACTIONS.GET_CURRENT_LOCATION],
    successSignal: "tool-ok",
    unlockRequired: true,
    locationDependent: true,
    prompt: "where am I",
    note: "read spec tools/catalog.rs:207; the only genuinely unscoreable row — the broker stages a preflight and waits for a stock client the raw probe cannot be",
  },
  {
    id: "current_weather",
    capability: "Weather here",
    tool: "current_weather",
    actions: [],
    successSignal: "tool-ok",
    unlockRequired: true,
    prompt: "what's the weather here",
    note: "read spec tools/catalog.rs:214; WAS flagged locationDependent — with no coordinates it returns ok=false (turn/orchestration.rs:508-537), a real signal. Measured artifact session-20260728-162901 shows the preflight-stall variant instead, which classify() detects from plannedActions",
  },
  {
    id: "weather_at_place",
    capability: "Weather at a named place",
    tool: "weather_at_place",
    actions: [],
    successSignal: "tool-ok",
    prompt: "what's the weather in Paris",
    note: "read spec tools/catalog.rs:192; needs latitude/longitude exported by a prior place_search (catalog.rs:770-790) — a two-step chain",
  },
  {
    id: "nearby_search",
    capability: "Nearby places",
    tool: "nearby_search",
    actions: [],
    successSignal: "tool-ok",
    unlockRequired: true,
    prompt: "what's nearby",
    note: "read spec tools/catalog.rs:235; WAS flagged locationDependent — a missing location yields ok=false (turn/orchestration.rs:548-560), not silence",
  },
  {
    id: "place_search",
    capability: "Resolve a public place name",
    tool: "place_search",
    actions: [],
    successSignal: "tool-ok",
    // WAS: "find a coffee shop near me", flagged locationDependent. Both were
    // wrong: place_search needs no coordinates at all (turn/orchestration.rs:~430-464,
    // query only) and that phrasing elicits nearby_search instead.
    prompt: "where is the Eiffel Tower",
    note: "read spec tools/catalog.rs:182; NOT location-dependent and NOT gated — a correct probe names a place",
  },
  {
    id: "route",
    capability: "Directions / route",
    tool: "route",
    actions: [],
    successSignal: "tool-ok",
    unlockRequired: true,
    prompt: "how do I get to the train station",
    note: "read spec tools/catalog.rs:246; routes start at the device, so a missing location yields ok=false",
  },
  {
    id: "reverse_geocode",
    capability: "Address for coordinates",
    tool: "reverse_geocode",
    actions: [],
    successSignal: "tool-ok",
    unlockRequired: true,
    prompt: "what is the address here",
    note: "read spec tools/catalog.rs:221; require_current_coordinates (turn/orchestration.rs:539-547) makes it a strict follow-on to current_location",
  },
];

// ---------------------------------------------------------------------------
// THE EXISTENCE GUARD
//
// Reads the real Rust catalogs so the sweep cannot assert a name the product
// does not have. A nonexistent name is invisible in BOTH directions: the
// expectation can never be met and the check can never trip. This has now
// silently broken an instrument on this project three times.
// ---------------------------------------------------------------------------

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Slice a Rust `fn NAME(...) { ... }` body by brace matching. */
function fnBody(source, name) {
  const signature = source.indexOf(`fn ${name}(`);
  if (signature < 0) return null;
  const open = source.indexOf("{", signature);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(open, i + 1), offset: open };
    }
  }
  return null;
}

function collect(body, source, file, pattern, target) {
  if (!body) return;
  for (const match of body.text.matchAll(pattern)) {
    target.set(match[1], `${file}:${lineOf(source, body.offset + match.index)}`);
  }
}

/**
 * Parse the product's real name catalogs.
 *
 * Returns `available: false` (rather than throwing) when the Rust sources are
 * not on disk, so the sweep still runs from a partial checkout — the test
 * asserts `available === true` in this repo, so a parse breakage goes RED there.
 */
export function readProductCatalogs(repoRoot = REPO_ROOT, read = readFileSync) {
  const empty = {
    available: false,
    reason: null,
    sources: CATALOG_SOURCES,
    readTools: new Map(),
    writeTools: new Map(),
    mutationTools: new Map(),
    mutationActionOf: new Map(),
    tools: new Map(),
    actions: new Map(),
  };
  let toolCatalogSource;
  let catalog;
  try {
    toolCatalogSource = String(read(join(repoRoot, CATALOG_SOURCES.toolCatalog), "utf8"));
    catalog = String(read(join(repoRoot, CATALOG_SOURCES.actionCatalog), "utf8"));
  } catch (error) {
    return { ...empty, reason: String(error?.message ?? error) };
  }

  const readTools = new Map();
  const writeTools = new Map();
  const mutationTools = new Map();
  const mutationActionOf = new Map();

  collect(
    fnBody(toolCatalogSource, "read_specs"),
    toolCatalogSource,
    CATALOG_SOURCES.toolCatalog,
    /AdvertisedReadTool\s*\{\s*name:\s*"([a-z0-9_]+)"/g,
    readTools,
  );
  collect(
    fnBody(toolCatalogSource, "write_specs"),
    toolCatalogSource,
    CATALOG_SOURCES.toolCatalog,
    /AdvertisedWriteTool\s*\{\s*name:\s*"([a-z0-9_]+)"/g,
    writeTools,
  );

  const mutationBody = fnBody(toolCatalogSource, "mutation_specs");
  if (mutationBody) {
    const pattern =
      /AdvertisedMutationTool\s*\{\s*name:\s*"([a-z0-9_]+)",\s*\n\s*action:\s*native_actions::([A-Z0-9_]+)/g;
    for (const match of mutationBody.text.matchAll(pattern)) {
      const action = NATIVE_ACTIONS[match[2]];
      if (typeof action !== "string") continue;
      mutationTools.set(
        match[1],
        `${CATALOG_SOURCES.toolCatalog}:${lineOf(toolCatalogSource, mutationBody.offset + match.index)}`,
      );
      mutationActionOf.set(match[1], action);
    }
  }

  // play_music is a mutation in every practical sense but lives outside
  // mutation_specs() as its own const (tools/catalog.rs).
  const playMusic = /const PLAY_MUSIC_TOOL:\s*&str\s*=\s*"([a-z0-9_]+)"/.exec(
    toolCatalogSource,
  );
  if (playMusic) {
    mutationTools.set(
      playMusic[1],
      `${CATALOG_SOURCES.toolCatalog}:${lineOf(toolCatalogSource, playMusic.index)}`,
    );
    mutationActionOf.set(playMusic[1], NATIVE_ACTIONS.PLAY_MUSIC);
  }

  const actions = new Map();
  for (const match of catalog.matchAll(
    /action_spec!\(\s*native_actions::([A-Z0-9_]+)/g,
  )) {
    const action = NATIVE_ACTIONS[match[1]];
    if (typeof action !== "string") continue;
    actions.set(
      action,
      `${CATALOG_SOURCES.actionCatalog}:${lineOf(catalog, match.index)}`,
    );
  }

  const tools = new Map([...readTools, ...writeTools, ...mutationTools]);
  const available = tools.size > 0 && actions.size > 0;
  return {
    available,
    reason: available ? null : "the catalogs parsed empty — the Rust source shape changed",
    sources: CATALOG_SOURCES,
    readTools,
    writeTools,
    mutationTools,
    mutationActionOf,
    tools,
    actions,
  };
}

/**
 * Pure validator: does every name the sweep uses exist in the product?
 *
 * Returns a list of human-readable problems, each citing file:line so the next
 * person can fix it in one step. Empty list means the sweep is name-clean.
 * Exported so the test can feed it a deliberately bogus case and prove the
 * guard is LIVE rather than vacuous.
 */
export function validateCaseNames(cases, catalogs) {
  const problems = [];
  const where = (map, name) => map.get(name) ?? "unknown location";

  for (const testCase of cases) {
    const id = testCase.id ?? "(case with no id)";

    if (testCase.tool) {
      if (testCase.tool in KNOWN_ABSENT_NAMES) {
        problems.push(`${id}: tool "${testCase.tool}" DOES NOT EXIST in the product — use ${KNOWN_ABSENT_NAMES[testCase.tool]}`);
      } else if (catalogs.available && !catalogs.tools.has(testCase.tool)) {
        problems.push(
          `${id}: tool "${testCase.tool}" is not registered in ${catalogs.sources.toolCatalog} ` +
          `(read_specs/write_specs/mutation_specs/PLAY_MUSIC_TOOL). A name the product does not have can never ` +
          `appear in okTools, so this row is unfalsifiable in both directions.`,
        );
      }
    }

    for (const action of [...(testCase.actions ?? []), ...(testCase.stagedActions ?? [])]) {
      if (action === UNIVERSAL_TERMINAL_ACTION) {
        problems.push(
          `${id}: "${UNIVERSAL_TERMINAL_ACTION}" is the universal text terminal (catalog.rs:1821) — every spoken ` +
          `turn emits it, so scoring it as success can never FAIL. That is as useless as a name that can never pass.`,
        );
      } else if (action in KNOWN_ABSENT_NAMES) {
        problems.push(`${id}: action "${action}" DOES NOT EXIST in the product — use ${KNOWN_ABSENT_NAMES[action]}`);
      } else if (action in KNOWN_UNEMITTABLE_ACTION_NAMES) {
        problems.push(
          `${id}: action "${action}" exists in ${catalogs.sources.actionCatalog} but the Understand RPC can never ` +
          `return it (nested stock-agent name) — use ${KNOWN_UNEMITTABLE_ACTION_NAMES[action]}`,
        );
      } else if (catalogs.available && !catalogs.actions.has(action)) {
        problems.push(
          `${id}: action "${action}" is absent from NATIVE_ACTION_CATALOG (${catalogs.sources.actionCatalog}) — ` +
          `an expectation on it can never be met`,
        );
      }
    }

    // A mutation tool NEVER emits OPERATIONAL_MARKERS.tool_executed (it returns
    // ToolExecutionOutcome::Terminal, tools/catalog.rs:2570-2573), so scoring one by
    // okTools is unfalsifiable. This is the exact defect that produced "0
    // reached" across 37 capabilities.
    if (catalogs.available && testCase.tool && catalogs.mutationTools.has(testCase.tool)
      && testCase.successSignal === "tool-ok") {
      problems.push(
        `${id}: "${testCase.tool}" is a MUTATION spec (${where(catalogs.mutationTools, testCase.tool)}) but the case ` +
        `scores it as "tool-ok". A mutation never logs an executed line — use successSignal "action-planned" and ` +
        `expect ${catalogs.mutationActionOf.get(testCase.tool) ?? "its native action"}.`,
      );
    }

    // Conversely a read/write tool's success is the executed line, so a case
    // that only watches for an action would never see it.
    if (catalogs.available && testCase.tool && !catalogs.mutationTools.has(testCase.tool)
      && testCase.successSignal === "action-planned") {
      problems.push(
        `${id}: "${testCase.tool}" is a READ/WRITE spec (${where(catalogs.tools, testCase.tool)}) whose success is an ` +
        `executed log line, but the case scores it as "action-planned" only.`,
      );
    }

    if (testCase.successSignal === "action-planned" && (testCase.actions ?? []).length === 0) {
      problems.push(`${id}: successSignal is "action-planned" but the case names no action — nothing can ever satisfy it`);
    }
    if (!testCase.tool && (testCase.actions ?? []).length === 0) {
      problems.push(`${id}: the case names neither a tool nor an action — it asserts nothing`);
    }
  }
  return problems;
}

/** Structural validation: ids, prompts, notes, duplicates. */
export function validateCaseShape(cases) {
  const problems = [];
  const seenIds = new Set();
  const seenPrompts = new Map();
  const seenCapabilities = new Set();
  for (const testCase of cases) {
    const id = testCase.id ?? "(case with no id)";
    if (!testCase.id) problems.push("a case has no id");
    else if (seenIds.has(testCase.id)) problems.push(`duplicate case id: ${testCase.id}`);
    seenIds.add(testCase.id);

    if (!testCase.capability) problems.push(`${id}: no capability label`);
    else if (seenCapabilities.has(testCase.capability)) problems.push(`duplicate capability: ${testCase.capability}`);
    seenCapabilities.add(testCase.capability);

    if (!testCase.prompt) problems.push(`${id}: no prompt`);
    else if (seenPrompts.has(testCase.prompt)) {
      problems.push(`duplicate prompt ${JSON.stringify(testCase.prompt)} shared by ${seenPrompts.get(testCase.prompt)} and ${id}`);
    }
    seenPrompts.set(testCase.prompt, id);

    if (!testCase.note) problems.push(`${id}: no note — a routing claim with no recorded evidence cannot be audited`);
    if (!SUCCESS_SIGNALS.has(testCase.successSignal)) {
      problems.push(`${id}: successSignal ${JSON.stringify(testCase.successSignal)} is not one of ${[...SUCCESS_SIGNALS].join(", ")}`);
    }
  }
  return problems;
}

export const SUCCESS_SIGNALS = new Set(["tool-ok", "action-planned", "either"]);

/** The catch-all text terminal every spoken turn ends in (catalog.rs:1821). */
export const UNIVERSAL_TERMINAL_ACTION = NATIVE_ACTIONS.RESPOND;

// ---------------------------------------------------------------------------
// EVIDENCE PARSING
//
// Re-parses the per-prompt logcat window pinbox already fenced and wrote to
// disk. Widened and extended relative to pinbox/shared/logcat.mjs:58:
//   * the tool-name class accepts CamelCase, so a hallucinated tool in an
//     `unknown_tool` failure is visible instead of producing no entry at all
//     (emitter tools/catalog.rs:3048-3056);
//   * OPERATIONAL_MARKERS.mutation (tools/catalog.rs:2569) — the model SELECTED a
//     mutation tool. Kept OUT of okTools: a proposal is not an execution;
//   * OPERATIONAL_MARKERS.mutation_rejected (tools/catalog.rs:2485, 2558-2562) — a
//     grounding gate refused the call. Previously invisible silence;
//   * OPERATIONAL_MARKERS.observation_replayed
//     (chat_turn_loop.rs:619) — proof a tool ran EARLIER in the same turn, the only
//     surviving evidence when the original executed line was evicted;
//   * OPERATIONAL_MARKERS.terminal_native_action (chat_turn_loop.rs:365, :631);
//   * OPERATIONAL_MARKERS.deterministic_completion (tools/catalog.rs:2768).
//
// The last two separate "the deterministic exact-phrase table matched" from
// "the model selected the tool" — identical planned actions until now.
// All parsed fields stay content-free: names, ok flags, closed-set reasons.
// ---------------------------------------------------------------------------

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;
const markerPattern = (marker) => marker.replace(REGEXP_META, "\\$&");
const TOOL_EXECUTED_RE = new RegExp(
  `${markerPattern(OPERATIONAL_MARKERS.tool_executed.value)} .*?\\btool=([A-Za-z_][A-Za-z0-9_]*) ok=(true|false)(?: reason=("?)([^"\\n]{0,120}))?`,
  "g",
);
const MUTATION_RE = new RegExp(
  `${markerPattern(OPERATIONAL_MARKERS.mutation.value)} (?!rejected)tool=([A-Za-z_][A-Za-z0-9_]*) action="?([A-Za-z]+)"?`,
  "g",
);
const MUTATION_REJECTED_RE = new RegExp(
  `${markerPattern(OPERATIONAL_MARKERS.mutation_rejected.value)}(?: tool=([A-Za-z_][A-Za-z0-9_]*))?(?: reason=([^\\n]{0,120}))?`,
  "g",
);
const REPLAY_RE = new RegExp(
  `${markerPattern(OPERATIONAL_MARKERS.observation_replayed.value)} .*?\\btool=([A-Za-z_][A-Za-z0-9_]*) ok=(true|false)`,
  "g",
);
const TERMINAL_NATIVE_RE = new RegExp(
  `${markerPattern(OPERATIONAL_MARKERS.terminal_native_action.value)} .*?\\btool=([A-Za-z_][A-Za-z0-9_]*)`,
  "g",
);
const DETERMINISTIC_RE = new RegExp(
  `${markerPattern(OPERATIONAL_MARKERS.deterministic_completion.value)}[^\\n]*?action="?([A-Za-z]+)"?`,
  "g",
);

export function parseEvidence(text) {
  const source = typeof text === "string" ? text : "";
  const executed = [];
  for (const m of source.matchAll(TOOL_EXECUTED_RE)) {
    executed.push({ tool: m[1], ok: m[2] === "true", reason: m[4]?.trim() || null });
  }
  const mutations = [];
  for (const m of source.matchAll(MUTATION_RE)) mutations.push({ tool: m[1], action: m[2] });
  const mutationsRejected = [];
  for (const m of source.matchAll(MUTATION_REJECTED_RE)) {
    mutationsRejected.push({ tool: m[1] ?? null, reason: m[2]?.trim() || null });
  }
  const replayed = [];
  for (const m of source.matchAll(REPLAY_RE)) replayed.push({ tool: m[1], ok: m[2] === "true" });
  const terminalNativeTools = [];
  for (const m of source.matchAll(TERMINAL_NATIVE_RE)) terminalNativeTools.push(m[1]);
  const deterministicActions = [];
  for (const m of source.matchAll(DETERMINISTIC_RE)) deterministicActions.push(m[1]);
  return { executed, mutations, mutationsRejected, replayed, terminalNativeTools, deterministicActions };
}

// ---------------------------------------------------------------------------
// CLASSIFICATION
// ---------------------------------------------------------------------------

const toolNameOf = (entry) => String(entry ?? "").split(" ")[0];

function verdict(status, detail, extra = {}) {
  return { status, detail, covered: status === "reached" || status === "planned", route: null, ...extra };
}

/**
 * Classify one probe result for one capability.
 *
 * ORDERING IS LOAD-BEARING.
 *  1. probe-error   — nothing was measured.
 *  2. gated         — the capability's OWN gate string came back. Checked
 *                     before `backend` because the canned food-permit reply
 *                     ("…its device setting is unavailable", food.rs:50-51)
 *                     matches the generic unavailable patterns and was being
 *                     mis-scored as a backend outage.
 *  3. backend       — BEFORE any success reading. A backend failure is
 *                     indistinguishable from "the tool was not selected" by
 *                     every other signal, and on this device it arrives FASTER
 *                     than a real answer, so a latency- or shape-based reading
 *                     scores an outage as a coverage gap. Anything measured
 *                     during an outage carries no information.
 *  4. action surface — decoded from the response frames, so it is INDEPENDENT
 *                     of the log window and safe even when the window degraded.
 *  5. tool surface  — log-derived, and therefore only trusted when pinbox's
 *                     boundary marker was found. With the marker gone pinbox
 *                     falls back to the WHOLE buffer (shared/logcat.mjs:37-43),
 *                     which can contain an earlier prompt's tools.
 */
export function classify(testCase, probe) {
  const p = probe ?? {};
  const expectedActions = testCase.actions ?? [];
  const ok = new Set(p.okTools ?? []);
  const failedNames = (p.failedTools ?? []).map(toolNameOf);
  const actions = p.plannedActions ?? [];
  const answer = String(p.answer ?? "");
  const mutations = p.mutations ?? [];
  const rejected = p.mutationsRejected ?? [];
  const replayed = p.replayed ?? [];
  const terminalNativeTools = p.terminalNativeTools ?? [];
  const deterministicActions = p.deterministicActions ?? [];
  const windowTrusted = p.logcatMarkerFound !== false;

  if (p.error) return verdict("probe-error", String(p.error));

  const gate = testCase.gate;
  if (gate?.answerPattern && gate.answerPattern.test(answer)) {
    return verdict("gated", `${gate.detail} (${gate.evidence})`, { gate: gate.id });
  }

  if (isUnavailableAnswer(answer) || p.providerDeclined === true) {
    return verdict("backend", "the turn ended in a backend/provider failure — this tells us NOTHING about the capability; re-run on a healthy backend");
  }

  // ---- 4. action surface (frame-derived; window-independent) ----
  const actionHit = expectedActions.find((action) => actions.includes(action));
  const mutationHit = mutations.find(
    (m) => (testCase.tool && m.tool === testCase.tool) || expectedActions.includes(m.action),
  );
  const preferTool = testCase.successSignal !== "action-planned";

  const routeOf = () => {
    if (mutationHit) {
      return `the MODEL selected ${mutationHit.tool} (${OPERATIONAL_MARKERS.mutation.value})`;
    }
    if (testCase.tool && terminalNativeTools.includes(testCase.tool)) {
      return `the MODEL selected ${testCase.tool} (${OPERATIONAL_MARKERS.terminal_native_action.value})`;
    }
    if (actionHit && deterministicActions.includes(actionHit)) return "the forced deterministic completion fired (tools/catalog.rs:2768)";
    return "the pre-agentic deterministic planner (no model tool-call marker in the window)";
  };

  const toolOk = Boolean(testCase.tool) && windowTrusted && ok.has(testCase.tool);
  const replayHit = Boolean(testCase.tool) && windowTrusted
    && replayed.some((r) => r.tool === testCase.tool && r.ok);

  const reached = (detail) => verdict("reached", detail, { route: "read-tool" });

  if (preferTool && toolOk) {
    return reached(
      `executed ok=true (${OPERATIONAL_MARKERS.tool_executed.value})`,
    );
  }
  if (preferTool && replayHit) {
    return reached(
      `executed ok=true earlier in this turn (${OPERATIONAL_MARKERS.observation_replayed.value}) — the original executed line was not in the window`,
    );
  }
  if (actionHit) {
    return verdict("planned", `planned action ${actionHit} — decoded, NEVER dispatched; via ${routeOf()}`, { route: "native-action" });
  }
  if (mutationHit) {
    return verdict(
      "planned",
      `the model called ${mutationHit.tool} -> ${mutationHit.action} (${OPERATIONAL_MARKERS.mutation.value}) but no matching action frame was decoded`,
      { route: "model-mutation" },
    );
  }
  if (toolOk) {
    return reached(
      `executed ok=true (${OPERATIONAL_MARKERS.tool_executed.value})`,
    );
  }
  if (replayHit) {
    return reached(
      `executed ok=true earlier in this turn (${OPERATIONAL_MARKERS.observation_replayed.value})`,
    );
  }

  // ---- 5. everything below is LOG-derived and needs a trustworthy window ----
  if (!windowTrusted) {
    return verdict(
      "unscoreable",
      "degraded log window: pinbox's boundary marker was evicted, so its fallback returns the whole buffer and a tool line may belong to an earlier prompt (pinbox/shared/logcat.mjs:37-43)",
    );
  }
  if (testCase.tool && failedNames.includes(testCase.tool)) {
    const entry = (p.failedTools ?? []).find((f) => toolNameOf(f) === testCase.tool);
    return verdict("failed", `selected but returned ok=false: ${entry}`, { route: "read-tool" });
  }
  const rejectHit = rejected.find(
    (r) => (testCase.tool && r.tool === testCase.tool) || (r.tool === null && testCase.tool === "play_music"),
  );
  if (rejectHit) {
    return verdict(
      "rejected",
      `the model called the tool and a grounding gate refused it${rejectHit.reason ? `: ${rejectHit.reason}` : ""} (tools/catalog.rs:2485/2558-2562)`,
    );
  }

  // Placed AFTER `failed`/`rejected`: those are hard log evidence that the tool
  // was reached, and an outage cannot retract them. Everything below is softer,
  // and with no readable answer the backend guard above was inert — scoring a
  // GAP on that basis is exactly the defect this file was rewritten to fix.
  if (p.answerStatus === "unreadable") {
    return verdict(
      "unscoreable",
      "the answer artifact could not be read, so a backend outage cannot be ruled out — scoring this row would repeat the inert-guard defect",
    );
  }

  // A staged location preflight that is not this capability's own action means
  // the turn is waiting on a stock client the raw probe cannot be.
  if (
    actions.includes(NATIVE_ACTIONS.GET_CURRENT_LOCATION) &&
    !expectedActions.includes(NATIVE_ACTIONS.GET_CURRENT_LOCATION)
  ) {
    return verdict(
      "unscoreable",
      `the turn staged a ${NATIVE_ACTIONS.GET_CURRENT_LOCATION} preflight (turn/orchestration.rs:504-507) and waits for a stock client the raw probe cannot be`,
    );
  }
  if (testCase.locationDependent) {
    return verdict(
      "unscoreable",
      `needs a ${NATIVE_ACTIONS.GET_CURRENT_LOCATION} preflight the raw probe cannot answer`,
    );
  }
  if (gate) {
    return verdict(
      "gated",
      `absent, but ${gate.detail} (${gate.evidence}) — NOT a coverage gap`,
      { gate: gate.id },
    );
  }

  const otherTools = [...ok].filter((t) => t !== testCase.tool);
  const otherActions = actions.filter(
    (action) =>
      action !== NATIVE_ACTIONS.RESPOND && !expectedActions.includes(action),
  );
  if (otherTools.length > 0 || otherActions.length > 0) {
    return verdict(
      "other-tool",
      `a different capability's surface fired: ${[...otherTools, ...otherActions].join(", ")}`,
    );
  }
  // Distinguish silence from "the assistant answered in prose without using the
  // capability". Both are gaps, but only the first is a routing failure — the
  // second is the honest decline measured on device for the battery row ("I
  // can't access your battery level right now").
  const spoke = answer.trim().length > 0;
  return verdict(
    "not-elicited",
    spoke
      ? `no tool ran and no action was planned — the turn answered in prose only (${answer.trim().length} chars)`
      : `no tool ran, no action was planned, and nothing was spoken; actions: ${actions.join(", ") || "none"}`,
  );
}

// ---------------------------------------------------------------------------
// PROBE DRIVER
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Turn one pinbox `probe --json` bundle into the probe shape classify() reads.
 *
 * Exported for the test: the artifact-reading half is where the previous
 * version silently died (a `require()` inside an ESM module, swallowed by
 * `catch {}`), so it must be exercisable without a device.
 */
export function buildProbeResult(bundle, io = { readJson, readText }) {
  if (!bundle || typeof bundle !== "object") return { error: "probe output was not JSON" };
  if (bundle.fatal) return { error: String(bundle.fatal) };

  const files = bundle.files ?? {};

  // The spoken answer lives at JSON.parse(frame.input).Response on the LAST
  // Response frame — no frame has an answer/text/speech field. Delegated to
  // prompt-suite's extractAnswer, which is unit-tested against the on-disk
  // corpus, rather than reimplemented here for a third time.
  let answer = "";
  let answerStatus = "unreadable";
  if (files.responses) {
    const frames = io.readJson(files.responses);
    if (frames !== undefined) {
      const extracted = extractAnswer(frames);
      answer = extracted.text;
      answerStatus = extracted.status;
    }
  }

  const logcat = files.logcat ? io.readText(files.logcat) : undefined;
  const evidence = parseEvidence(logcat ?? "");

  // Union with pinbox's own arrays: never lose a signal pinbox saw, and add the
  // ones its narrower regex misses.
  const okTools = new Set(bundle.okTools ?? []);
  const failedTools = new Set(bundle.failedTools ?? []);
  for (const entry of evidence.executed) {
    if (entry.ok) okTools.add(entry.tool);
    else failedTools.add(entry.reason ? `${entry.tool} (${entry.reason})` : entry.tool);
  }

  return {
    latencyMs: bundle.latencyMs ?? null,
    error: bundle.probeError ?? null,
    okTools: [...okTools],
    failedTools: [...failedTools],
    plannedActions: bundle.responses?.plannedActions ?? [],
    answer,
    answerStatus,
    machineryLeak: isMachineryLeak(answer),
    logcatMarkerFound: bundle.logcatMarkerFound !== false,
    logcatRead: logcat !== undefined,
    providerDeclined: bundle.providerDeclined === true,
    runDir: bundle.runDir ?? null,
    ...evidence,
  };
}

/**
 * Read the session-level agentic gate pinbox writes to session.json but does
 * NOT put on the per-prompt bundle (probe.mjs:142-148 vs :300-325), and which
 * it suppresses entirely in --json mode (probe.mjs:149). Without this a sweep
 * run against the STOCK path would return an empty row for every capability
 * with no signal that the agentic path was never in play.
 */
export function readAgenticGate(runDir, io = { readJson }) {
  if (!runDir) return null;
  const session = io.readJson(join(dirname(runDir), "session.json"));
  return session?.agenticGate ?? null;
}

export function buildPinboxProbeInvocation(serial, prompt, timeoutMs) {
  return [
    "platform/deploy/acceptance/pin/pinbox.mjs",
    "probe",
    "--serial",
    serial,
    "--prompt",
    prompt,
    "--json",
    "--timeout-ms",
    String(timeoutMs),
  ];
}

function probeOnce(serial, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      buildPinboxProbeInvocation(serial, prompt, timeoutMs),
      // The catalog root is <workspace>/pin, but the canonical Pinbox entry
      // above is workspace-relative. Launching it from REPO_ROOT made Node look
      // for pin/platform/... and every live row became a false probe-error.
      { cwd: WORKSPACE_ROOT },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    child.on("error", (e) => resolve({ error: `probe could not be spawned: ${String(e?.message ?? e)}` }));
    child.on("close", () => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        return resolve({ error: "probe output was not JSON" });
      }
      resolve(buildProbeResult(parsed));
    });
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.error(
    [
      "usage: node platform/deploy/acceptance/pin/tool-coverage.mjs --serial SERIAL [--json]",
      "                                    [--only name,name] [--settle-ms N] [--timeout-ms N]",
      "       node platform/deploy/acceptance/pin/tool-coverage.mjs --check-names",
      "",
      "  --serial       ADB serial. Required and never guessed.",
      "  --only         Comma-separated case ids, tool names or action names (default: all).",
      "  --settle-ms    Cool-down between probes (default 2500).",
      "  --timeout-ms   Per-probe timeout (default 90000).",
      "  --json         Machine-readable report.",
      "  --check-names  Run the existence guard against the Rust catalogs and exit.",
      "                 No device, no network.",
      "",
      "Actions are decoded, never dispatched: this cannot message, call, play, or",
      "take a photo — even though it deliberately asks for all of those.",
    ].join("\n"),
  );
}

export function parseArgs(argv) {
  const options = {
    settleMs: DEFAULT_SETTLE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    only: null,
    checkNames: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--serial") options.serial = argv[++i];
    else if (arg === "--only") options.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--settle-ms") options.settleMs = Number(argv[++i]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--check-names") options.checkNames = true;
    else return { error: `unknown argument: ${arg}` };
  }
  // `Number("90k")`/`Number(undefined)` is NaN; an unvalidated NaN would sleep
  // for nothing and be handed to the probe subprocess as the literal "NaN".
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0) {
    return { error: "--settle-ms must be a non-negative number of milliseconds" };
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return { error: "--timeout-ms must be a positive number of milliseconds" };
  }
  if (!options.checkNames && !options.serial) return { error: "--serial is required" };
  return { options };
}

export function selectCases(cases, only) {
  if (!only) return cases;
  const wanted = new Set(only);
  return cases.filter(
    (c) => wanted.has(c.id) || (c.tool && wanted.has(c.tool)) || (c.actions ?? []).some((a) => wanted.has(a)),
  );
}

function runGuard() {
  const catalogs = readProductCatalogs();
  const problems = [...validateCaseShape(COVERAGE_CASES), ...validateCaseNames(COVERAGE_CASES, catalogs)];
  return { catalogs, problems };
}

async function main() {
  const { options, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`tool-coverage: ${error}\n`);
    usage();
    process.exitCode = 2;
    return;
  }

  // The guard runs BEFORE any device work: a sweep whose names cannot match is
  // worse than no sweep — it reports confident zeroes.
  const { catalogs, problems } = runGuard();
  if (problems.length > 0) {
    console.error("tool-coverage: the case list names things the product does not have:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nRefusing to sweep: an unsatisfiable name reports a confident zero.");
    process.exitCode = 2;
    return;
  }
  if (options.checkNames) {
    if (!catalogs.available) {
      console.error(`tool-coverage: the product catalogs could not be read (${catalogs.reason}) — names were NOT verified.`);
      process.exitCode = 2;
      return;
    }
    console.log(
      `tool-coverage: ${COVERAGE_CASES.length} capabilities, all names verified against ` +
      `${catalogs.sources.toolCatalog} (${catalogs.tools.size} tools) and ` +
      `${catalogs.sources.actionCatalog} (${catalogs.actions.size} actions).`,
    );
    return;
  }
  if (!catalogs.available) {
    console.error(`tool-coverage: WARNING — the product catalogs could not be read (${catalogs.reason}); names were NOT verified.\n`);
  }

  const cases = selectCases(COVERAGE_CASES, options.only);
  if (cases.length === 0) {
    console.error("tool-coverage: --only matched no cases");
    process.exitCode = 2;
    return;
  }

  const results = [];
  let agenticGate = null;
  for (const testCase of cases) {
    const probe = await probeOnce(options.serial, testCase.prompt, options.timeoutMs);
    if (agenticGate === null && probe.runDir) agenticGate = readAgenticGate(probe.runDir);
    const v = classify(testCase, probe);
    results.push({
      id: testCase.id,
      capability: testCase.capability,
      tool: testCase.tool,
      actions: testCase.actions ?? [],
      successSignal: testCase.successSignal,
      prompt: testCase.prompt,
      unlockRequired: !!testCase.unlockRequired,
      ...v,
      machineryLeak: probe.machineryLeak === true,
      logcatRead: probe.logcatRead === true,
      latencyMs: probe.latencyMs,
    });
    if (!options.json) {
      const label = v.status.toUpperCase().padEnd(13);
      console.log(`  ${label} ${testCase.id}  (${probe.latencyMs ?? "?"}ms)`);
      if (!v.covered) console.log(`                ${v.detail}`);
      if (probe.machineryLeak) console.log("                NOTE: raw machinery leaked into the spoken answer");
    }
    await sleep(options.settleMs);
  }

  const by = (status) => results.filter((r) => r.status === status);
  const summary = {
    total: results.length,
    covered: results.filter((r) => r.covered).length,
    reached: by("reached").length,
    planned: by("planned").length,
    failed: by("failed").length,
    rejected: by("rejected").length,
    gated: by("gated").length,
    notElicited: by("not-elicited").length,
    otherTool: by("other-tool").length,
    unscoreable: by("unscoreable").length,
    backend: by("backend").length,
    probeError: by("probe-error").length,
  };

  if (options.json) {
    console.log(JSON.stringify({ harness: "tool-coverage", agenticGate, summary, results }, null, 2));
    return;
  }
  if (agenticGate?.warn) {
    console.log(`\n  WARN: ${agenticGate.warn}`);
    console.log("  Every row below may be measuring the STOCK path, not the agentic one.");
  }
  console.log("\n  ── summary ──");
  console.log(`  COVERED (reached + planned) : ${summary.covered} / ${summary.total}`);
  console.log(`    reached (tool executed ok): ${summary.reached}`);
  console.log(`    planned (action, not run) : ${summary.planned}`);
  console.log(`  failed  (ran, ok=false)     : ${summary.failed}`);
  console.log(`  rejected (gate refused it)  : ${summary.rejected}`);
  console.log(`  gated   (withheld by design): ${summary.gated}`);
  console.log(`  other surface fired         : ${summary.otherTool}`);
  console.log(`  NOT ELICITED (real gap)     : ${summary.notElicited}`);
  console.log(`  unscoreable (needs device)  : ${summary.unscoreable}`);
  console.log(`  BACKEND FAILURE (no signal) : ${summary.backend}`);
  console.log(`  probe error                 : ${summary.probeError}`);
  if (summary.backend > 0) {
    console.log("\n  A backend failure carries NO information about the capability. Re-run those");
    console.log("  rows on a healthy backend before recording them as coverage gaps.");
  }
  if (summary.gated > 0) {
    console.log("\n  `gated` rows are withheld by the product on purpose. They are NOT coverage gaps.");
  }
}

// Exact path identity, not a basename suffix test. The old
// `import.meta.url.endsWith(argv[1].split("/").pop())` fired `main()` at import
// time for any entry script whose basename is a suffix of this file's (e.g. an
// `import` from a wrapper named `coverage.mjs`), and split only on "/". This
// matches the robust form used by every sibling generator in this directory.
export function isDirectInvocation(entryArg, moduleUrl) {
  if (!entryArg) return false;
  return resolve(entryArg) === fileURLToPath(moduleUrl);
}

if (isDirectInvocation(process.argv[1], import.meta.url)) await main();
