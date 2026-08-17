// shared/logcat.mjs — boundary-marker fencing + window capture + closed-
// vocabulary signal parsing. All parsed lines are content-free (tool names,
// intents, ok/reason flags) — never transcript, args, or results — matching
// the project's evidence discipline.

import { randomUUID } from "node:crypto";
import { OPERATIONAL_MARKERS } from "../../tier-a-symbols.mjs";
import { runAdb } from "./adb.mjs";

export const PROBE_BOUNDARY_TAG = "PenumbraProbe";
const PROBE_BOUNDARY_PREFIX = "probe-";

// Filter set for the evidence window: the server, hook, TTS, and audio-focus
// tags, plus the boundary tag itself; everything else silenced.
export const LOGCAT_TAGS = [
  "PenumbraServer:V",
  "PenumbraHook:V",
  "PenumbraTTS:V",
  "AudioFocusManager:V",
  "AudioTrack:V",
  `${PROBE_BOUNDARY_TAG}:I`,
  "*:S",
];

export function newBoundaryMarker() {
  return `${PROBE_BOUNDARY_PREFIX}${randomUUID()}`;
}

export async function dropBoundary(options, marker, spawn) {
  await runAdb(options, ["shell", "log", "-p", "i", "-t", PROBE_BOUNDARY_TAG, marker], {
    timeoutMs: 10_000, maxStdoutBytes: 1_024,
  }, "the probe logcat boundary could not be created", spawn);
}

// Slice from the boundary line onward. If the marker is gone (buffer rotated),
// return everything and flag it so the summary can warn rather than silently
// reporting a too-narrow window.
export function sliceLogcatSince(rawText, marker) {
  const needle = `${PROBE_BOUNDARY_TAG}: ${marker}`;
  const idx = rawText.indexOf(needle);
  if (idx < 0) return { text: rawText, markerFound: false };
  const lineStart = rawText.lastIndexOf("\n", idx) + 1;
  return { text: rawText.slice(lineStart), markerFound: true };
}

export async function pullLogcatWindow(options, spawn) {
  const raw = await runAdb(
    options,
    ["shell", "logcat", "-b", "main", "-b", "system", "-v", "epoch", "-d", ...LOGCAT_TAGS],
    { timeoutMs: 20_000, maxStdoutBytes: 8 * 1024 * 1024 },
    "the logcat evidence window could not be captured",
    spawn,
  );
  return raw.toString("utf8");
}

// ── the marker vocabulary ───────────────────────────────────────────────────
// Every literal this module looks for, named once and reused by the regexes
// below AND by the emitter-existence test in platform/deploy/acceptance/pin/pinbox.test.mjs. A renamed
// marker is invisible in BOTH directions — the parser reports nothing and
// nothing reports that the parser has gone blind — which is the same failure
// mode as a tool name that does not exist. Keeping the list here means the
// test can prove every marker still has an emitter in runtime/core/ or hook/.
const M_TOOL_EXECUTED = OPERATIONAL_MARKERS.tool_executed.value;
const M_MUTATION = OPERATIONAL_MARKERS.mutation.value;
const M_MUTATION_REJECTED = OPERATIONAL_MARKERS.mutation_rejected.value;
const M_REPLAY = OPERATIONAL_MARKERS.observation_replayed.value;
const M_NLU_ENTRY_INTENT = OPERATIONAL_MARKERS.nlu_entry_intent.value;
const M_NLU_MUSIC_SLOTS = OPERATIONAL_MARKERS.nlu_music_slots.value;
const M_NLU_SEMANTIC_HIT = OPERATIONAL_MARKERS.nlu_semantic_hit.value;
const M_NATIVE_ACTION =
  OPERATIONAL_MARKERS.native_action_for_physical_verification.value;
const M_BACKEND_UNAVAILABLE = OPERATIONAL_MARKERS.backend_unavailable.value;
const M_MUSIC_RANKING_DEGRADED =
  OPERATIONAL_MARKERS.music_ranking_degraded.value;

export const PARSED_LOG_MARKERS = [
  M_TOOL_EXECUTED, // tools/catalog.rs
  M_MUTATION, // tools/catalog.rs
  M_MUTATION_REJECTED, // tools/catalog.rs (two emitters: with and without tool=)
  M_REPLAY, // chat_turn_loop.rs
  M_NLU_ENTRY_INTENT, // understand.rs
  M_NLU_MUSIC_SLOTS, // understand.rs
  M_NLU_SEMANTIC_HIT, // understand.rs
  M_NATIVE_ACTION, // hook/…/ContextHistorySafetyHooks.kt
  M_BACKEND_UNAVAILABLE, // chat_turn_loop.rs (HermesError discriminant)
  M_MUSIC_RANKING_DEGRADED, // spotify/mod.rs
];

// Tool names come from the MODEL, not from the shipped snake_case vocabulary:
// an `unknown_tool` failure carries whatever the model invented, and CamelCase
// is what it invents (`AmIOnline` is a real planned action on this device).
// The former `[a-z_]+` class simply failed to match such a line, so the WHOLE
// entry disappeared — making "the model called a tool that does not exist"
// indistinguishable from "the model called nothing at all".
const TOOL_NAME = "[A-Za-z_][A-Za-z0-9_]*";

// Build a regex fragment from a marker literal. The `<<< ` prefix is made
// optional so the same parser reads the logcat window (which carries it
// verbatim) and any transport that trims the arrow.
function markerSource(marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.startsWith("<<< ") ? `(?:<<< )?${escaped.slice(4)}` : escaped;
}

// tracing's compact fmt prints message-then-fields, e.g.
//   `<<< hermes tool executed correlation=… tool=web_search ok=false reason="…"`
// `reason` is quoted when recorded as a field value and bare when recorded with
// `%` (Display); both forms are accepted. Every captured field is a NAME, an
// ok flag, or a server-authored closed-set reason — never an argument, a
// transcript, or a result.
const TOOL_EXECUTED_RE = new RegExp(
  `${markerSource(M_TOOL_EXECUTED)}[^\\n]*?\\btool=(${TOOL_NAME}) ok=(true|false)` +
    `(?: reason=("?)([^"\\n]{0,120}))?`,
  "g",
);

// `<<< hermes mutation tool=decrement_volume action="DecrementVolume"` — the
// model SELECTED a mutation and every gate let it through. The lookahead keeps
// the rejection line (which begins with the same prefix) out of this set.
const MUTATION_RE = new RegExp(
  `${markerSource(M_MUTATION)}(?!\\s+rejected)\\s+tool=(${TOOL_NAME}) action="?([A-Za-z][A-Za-z0-9_]*)"?`,
  "g",
);

// A grounding gate REFUSED the call. `tool=` is present on only one of the two
// emitters, so it is optional. The reason is built from spec/field names
// (synapse/catalog.rs:2367-2401) — it never contains the utterance.
const MUTATION_REJECTED_RE = new RegExp(
  `${markerSource(M_MUTATION_REJECTED)}(?:\\s+tool=(${TOOL_NAME}))?` +
    `(?:\\s+reason=("?)([^"\\n]{0,120}))?`,
  "g",
);

// Proof a tool ran EARLIER in the same turn: the only surviving evidence when
// the original executed line fell out of the window.
const REPLAY_RE = new RegExp(
  `${markerSource(M_REPLAY)}[^\\n]*?\\btool=(${TOOL_NAME}) ok=(true|false)`,
  "g",
);

const NATIVE_ACTION_RE = new RegExp(
  `${markerSource(M_NATIVE_ACTION)} \\| action=([A-Za-z_]+)`,
  "g",
);

/**
 * Parse every hermes signal out of one evidence window.
 *
 * The four groups are returned SEPARATELY and must stay that way. A mutation
 * the model PROPOSED and a gate REFUSED is not a tool the planner performed;
 * folding either into the executed set would score a blocked action as a
 * successful one. A replay is evidence a tool ran, not evidence it ran now.
 */
export function parseChatTurnSignals(text) {
  const source = typeof text === "string" ? text : "";
  const executed = parseExecutedTools(source);
  const mutations = [];
  for (const m of source.matchAll(MUTATION_RE)) {
    mutations.push({ tool: m[1], action: m[2] });
  }
  const mutationsRejected = [];
  for (const m of source.matchAll(MUTATION_REJECTED_RE)) {
    mutationsRejected.push({ tool: m[1] ?? null, reason: m[3]?.trim() || null });
  }
  const replayed = [];
  for (const m of source.matchAll(REPLAY_RE)) {
    replayed.push({ tool: m[1], ok: m[2] === "true" });
  }
  return { executed, mutations, mutationsRejected, replayed };
}

/** Just the executed tools — one scan. Callers iterate the array directly. */
export function parseExecutedTools(text) {
  const source = typeof text === "string" ? text : "";
  const executed = [];
  for (const m of source.matchAll(TOOL_EXECUTED_RE)) {
    executed.push({ tool: m[1], ok: m[2] === "true", reason: m[4]?.trim() || null });
  }
  return executed;
}

function extractFields(line, keys) {
  const out = {};
  for (const key of keys) {
    const m = new RegExp(`\\b${key}=(\\S+)`).exec(line);
    if (m) out[key] = m[1];
  }
  return Object.keys(out).length ? out : null;
}

export function parseNlu(text) {
  const nlu = { entryIntent: null, musicSlots: null, semanticHit: null };
  for (const line of String(text ?? "").split("\n")) {
    if (line.includes(M_NLU_ENTRY_INTENT)) {
      nlu.entryIntent = extractFields(line, ["intent", "autocomplete"]);
    } else if (line.includes(M_NLU_MUSIC_SLOTS)) {
      nlu.musicSlots = extractFields(line, ["has_track", "has_artist", "has_album"]);
    } else if (line.includes(M_NLU_SEMANTIC_HIT)) {
      nlu.semanticHit = extractFields(line, ["interpretation", "distance_sq"]);
    }
  }
  return nlu;
}

export function parseNativeActions(text) {
  const actions = [];
  for (const m of String(text ?? "").matchAll(NATIVE_ACTION_RE)) {
    actions.push(m[1]);
  }
  return actions;
}

export function detectProviderDecline(text) {
  return String(text ?? "").includes(M_BACKEND_UNAVAILABLE);
}

/**
 * Artist lookups that fell back to relevance-ordered track search.
 *
 * The played track is always `rank == 1`, so nothing in the answer, the
 * activity record, or the track itself distinguishes "Spotify ranked this
 * first" from "our fallback ranked this first". This line is the difference,
 * and it carries a closed-set reason, a count and an ordering description —
 * never the artist the user asked for.
 */
export function parseMusicRankingDegraded(text) {
  const degraded = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes(M_MUSIC_RANKING_DEGRADED)) continue;
    degraded.push(
      extractFields(line, ["reason", "track_count", "popularity_order"]) ?? {},
    );
  }
  return degraded;
}
