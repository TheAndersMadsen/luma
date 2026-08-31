// shared/evidence.mjs — pure data transforms over decoded responses, readiness,
// and activity diffs. No I/O, no ADB: pure functions so they are trivially
// unit-testable and reusable by both `probe` and `readiness`.

// The answer extractor and the measured failure vocabulary, imported so this
// file cannot become a THIRD copy of either. prompt-suite.mjs is data plus pure
// functions — no imports, no I/O — so pulling it in costs nothing, and its
// extractor is already pinned against every artifact on disk
// (platform/deploy/acceptance/pin/prompt-suite.test.mjs, "LOAD-BEARING extractAnswer: exact tally").
import { extractAnswer, isUnavailableAnswer } from "../../prompt-suite.mjs";
import { cosmosOwnsProviderConfiguration } from "../../agentic-release-smoke-lib.mjs";
import { NATIVE_ACTIONS } from "../../tier-a-symbols.mjs";

export const MAX_ANSWER_CHARS_STDOUT = 200;

// stock-action-test accepts only this fixed enum (api/dev.rs). Volume-control
// actions are absent, so `probe --dispatch` cannot move the volume.
export const STOCK_ACTION_DISPATCHABLE = new Set([
  NATIVE_ACTIONS.PLAY_MUSIC,
  NATIVE_ACTIONS.COMPOSE_MESSAGE,
  NATIVE_ACTIONS.CALL_PERSON,
  "CapturePhoto",
  NATIVE_ACTIONS.CAPTURE_VIDEO,
  NATIVE_ACTIONS.STOP_VIDEO,
  NATIVE_ACTIONS.TICKLE,
]);

/**
 * Shape only — never full response prose, which can contain private content. The
 * full decoded frames stay in the local bundle (gitignored); the summary keeps
 * a bounded preview so it remains shareable.
 *
 * THE ANSWER. This used to read `answer ?? text ?? speech` and keep the LONGEST
 * one. Both halves were wrong, and the result was silent under-reporting:
 *   * no decoded frame carries any of those three keys, so `answer` was `""` on
 *     every one of the 235 artifacts on disk — including turns whose spoken
 *     sentence was right there in the frame (verified against
 *     test-runs/session-20260729-082327-f5b3a6dd/001-…-belgium/summary.json,
 *     which recorded `answerChars: 0` for a real 61-character reply);
 *   * longest-wins prefers a verbose interim cue over the terminal answer, and
 *     the terminal answer is frequently the SHORTEST string in the turn.
 * The spoken sentence is `JSON.parse(frame.input).Response` on the LAST
 * `action: "Respond"` frame. `extractAnswer` implements exactly that and is
 * pinned against the whole on-disk corpus, so this delegates rather than
 * growing a third extractor that can drift.
 *
 * `answerStatus` and `unavailableAnswer` are closed-set/boolean and contain no
 * prose, so they stay safe for the shareable summary; `answerPreview` is
 * bounded by MAX_ANSWER_CHARS_STDOUT.
 */
export function summarizeResponses(responses) {
  const frames = Array.isArray(responses) ? responses : [];
  const actions = [];
  for (const response of frames) {
    const action = response?.action ?? response?.actionName;
    if (typeof action === "string" && action.length > 0 && !actions.includes(action)) {
      actions.push(action);
    }
  }
  const extraction = extractAnswer(responses);
  const answer = extraction.text;
  return {
    frames: frames.length,
    actions,
    answer,
    answerChars: answer.length,
    answerPreview: answer.slice(0, MAX_ANSWER_CHARS_STDOUT),
    // ok | no-frames | no-respond-frame | malformed-respond | legacy-text-dropped
    answerStatus: extraction.status,
    unavailableAnswer: isUnavailableAnswer(answer),
  };
}

/** Exact response emitted by the Pin-local credential-free EchoProvider. */
export function isLocalEchoAnswer(answer, utterance) {
  return typeof answer === "string" &&
    typeof utterance === "string" &&
    answer === `Echo: ${utterance}`;
}

export function assessAgenticGate(readiness) {
  const settings = readiness?.settings;
  if (!settings) return { known: false, warn: "settings unavailable" };
  const cosmosOwned = cosmosOwnsProviderConfiguration(settings);
  return {
    known: true,
    toolsEnabled: cosmosOwned,
    provider: "cosmos",
    warn: cosmosOwned ? null : "the Pin still exposes provider settings owned by Cosmos",
  };
}

// ── activity cross-check ────────────────────────────────────────────────────
//
// THE DEFECT THIS SECTION EXISTS TO PREVENT. The previous version read
//   `(before.prompts?.records ?? before.prompts ?? []).map(...)`
// which assumes the activity payload is either `{records:[…]}` or a bare array.
// The device returns NEITHER. `/api/activity/{prompts,music}` serialises
// `ActivityPage { items, next_before }` (runtime/core/src/api/activity.rs:69-73,
// and the two handlers at :216-227 and :244-254), so `before.prompts` is
// `{items:[…]}` — an object with no `records` key. `?? before.prompts` then
// yielded that truthy object and `.map` did not exist, throwing exactly
//   `((intermediate value) ?? before.prompts ?? []).map is not a function`.
//
// It stayed invisible until the allowlist repair. Before that commit,
// `assertAllowlistedPath` matched the whole request string, so
// `/api/activity/prompts?limit=100` was REFUSED, `deviceJsonGet` threw, probe's
// try/catch left `activityBefore = null`, and `diffActivity` returned null from
// its own null guard without ever reaching the bad line. Fixing the allowlist
// delivered the real payload to a function that had never handled it — and
// because probe called `diffActivity` outside any try/catch, a SUPPORTING
// cross-check killed the whole run and reported a device failure that did not
// happen.
//
// Two rules follow, and both are pinned by tests:
//   1. This function is TOTAL. No input shape may make it throw.
//   2. It must not go quietly blind. Every side reports the shape it matched,
//      so "0 new prompts because nothing was recorded" and "0 new prompts
//      because the payload was unreadable" are distinguishable in the bundle.

// List-bearing envelope keys, most-authoritative first. `items` is what the
// device actually returns today; the rest are tolerated so a server-side
// rename, a bare array, or an older payload degrades instead of throwing.
export const ACTIVITY_LIST_KEYS = ["items", "records", "prompts", "music", "data", "results"];

/**
 * Normalise any activity payload to `{ list, shape }`, never throwing.
 *
 * `shape` is the key that supplied the list (`items`, `records`, …),
 * `"array"` for a bare array, `"absent"` for null/undefined, or
 * `"unrecognized"` for anything else — an error object, a non-200 body, a
 * string, a number. Only `"absent"` and `"unrecognized"` normalise to `[]`.
 */
export function normalizeActivityList(value) {
  if (Array.isArray(value)) return { list: value, shape: "array" };
  if (value === null || value === undefined) return { list: [], shape: "absent" };
  if (typeof value !== "object") return { list: [], shape: "unrecognized" };
  for (const key of ACTIVITY_LIST_KEYS) {
    if (Array.isArray(value[key])) return { list: value[key], shape: key };
  }
  return { list: [], shape: "unrecognized" };
}

// Identity for one activity record. The key NAME is part of the identity so an
// `id` of 1 and a `track_id` of 1 can never collide. `0` is a legitimate id —
// the old `.filter(Boolean)` dropped it, which would have made that record look
// new on every single diff.
function recordIdentity(record, keys) {
  if (record === null || typeof record !== "object") return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return `${key}:${value}`;
    if (typeof value === "number" && Number.isFinite(value)) return `${key}:${value}`;
  }
  return null;
}

function diffOneList(beforeValue, afterValue, idKeys) {
  const b = normalizeActivityList(beforeValue);
  const a = normalizeActivityList(afterValue);
  const beforeIds = new Set();
  for (const record of b.list) {
    const id = recordIdentity(record, idKeys);
    if (id !== null) beforeIds.add(id);
  }
  // A record with no usable id cannot be proven old, so it counts as new. That
  // over-reports rather than silently swallowing a dispatch.
  const fresh = a.list.filter((record) => {
    const id = recordIdentity(record, idKeys);
    return id === null || !beforeIds.has(id);
  });
  return { fresh, beforeShape: b.shape, afterShape: a.shape };
}

/**
 * Diff two activity snapshots by id; report only newly-seen records as an
 * independent confirmation that a planned action actually dispatched.
 *
 * SUPPORTING evidence only — it is never allowed to throw, because a throw
 * here would be reported as a device failure. Returns null when either snapshot
 * is missing (the caller already recorded why it could not be fetched).
 */
export function diffActivity(before, after) {
  if (!before || !after) return null;
  try {
    const prompts = diffOneList(before.prompts, after.prompts, ["id", "prompt_id", "run_id"]);
    const music = diffOneList(before.music, after.music, ["id", "track_id"]);
    const shapes = {
      beforePrompts: prompts.beforeShape,
      afterPrompts: prompts.afterShape,
      beforeMusic: music.beforeShape,
      afterMusic: music.afterShape,
    };
    // A zero diff caused by an unreadable payload must not look like a zero
    // diff caused by an idle device.
    const unreadable = Object.entries(shapes)
      .filter(([, shape]) => shape === "unrecognized")
      .map(([side]) => side);
    return {
      newPromptCount: prompts.fresh.length,
      newMusicCount: music.fresh.length,
      newPrompts: prompts.fresh.slice(0, 10),
      newMusic: music.fresh.slice(0, 10),
      shapes,
      unreadable,
      note: unreadable.length
        ? `activity payload not recognised for: ${unreadable.join(", ")} — counts are not evidence of absence`
        : null,
    };
  } catch (e) {
    // Unreachable through any plain JSON value; kept so that even an exotic
    // input (a throwing getter) degrades this ONE field instead of the run.
    return {
      newPromptCount: 0,
      newMusicCount: 0,
      newPrompts: [],
      newMusic: [],
      shapes: null,
      unreadable: ["beforePrompts", "afterPrompts", "beforeMusic", "afterMusic"],
      error: String(e?.message ?? e),
      note: "activity diff could not be computed — counts are not evidence of absence",
    };
  }
}

// stock-action-test request shape (api/dev.rs). Only the fields the action
// needs; the server denies_unknown_fields, so extras would 400.
export function stockActionPayload(action) {
  switch (action) {
    case NATIVE_ACTIONS.PLAY_MUSIC:
      return { track: null, artist: null };
    case NATIVE_ACTIONS.COMPOSE_MESSAGE:
      return { recipient: null, message: null };
    case NATIVE_ACTIONS.CALL_PERSON:
      return { recipient: null };
    default:
      return {};
  }
}
