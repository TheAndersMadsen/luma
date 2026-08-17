#!/usr/bin/env node

import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  collectInstalledServerIdentity,
  readAdminToken,
  verifyExplicitDevice,
} from "./agentic-release-smoke.mjs";
import { RELEASE_IDENTITY } from "./agentic-release-smoke-lib.mjs";
import {
  AUDIO_DUMP_ADB_ARGS,
  MEDIA_VOLUME_GET_ADB_ARGS,
  buildMediaVolumeSetAdbArgs,
  captureStableMediaVolumeSnapshot,
  parseMediaVolumeSnapshot,
  restoreMediaVolumeSnapshot,
} from "./media-volume-state-guard.mjs";
import {
  EXPECTED_PIN_SERIAL_ENV,
  exactDeviceTargetMatches,
  resolveExpectedDeviceSerial,
} from "./device-target-guard.mjs";
import {
  NATIVE_ACTIONS,
  OPERATIONAL_MARKERS,
  PACKAGES,
} from "./tier-a-symbols.mjs";

const PROGRAM = "session-continuity-physical-smoke";
const SERVER_PACKAGE = "com.penumbraos.server";
const IRONMAN_PACKAGE = PACKAGES.ironman;
const PROMPT_ACTIVITY_PATH = "/api/activity/prompts?limit=100";
const HTTP_STATUS_MARKER = "\n__PENUMBRA_CONTINUITY_HTTP_STATUS__:";
const MAX_CHILD_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const TURN_TIMEOUT_MS = 95_000;
const POLL_INTERVAL_MS = 500;
const DISPATCH_QUIET_INTERVAL_MS = 1_000;
const DISPATCH_QUIESCENCE_TIMEOUT_MS = 15_000;
const CLEAR_CONTEXT_RESPONSE =
  `Action: ${NATIVE_ACTIONS.CLEAR_UNDERSTANDING_CONTEXT}`;
const CONTINUITY_BOUNDARY_TAG = "PenumbraContinuitySmoke";
const QUIESCENCE_BOUNDARY_TAG = "PenumbraContinuityQuiet";
const CONTINUITY_BOUNDARY_PATTERN =
  /^continuity-smoke-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUIESCENCE_BOUNDARY_PATTERN =
  /^continuity-quiet-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXACT_RESET_HOOK_MARKER =
  OPERATIONAL_MARKERS.exact_context_reset_authorized.value;
const STOCK_FINAL_OBSERVATION =
  OPERATIONAL_MARKERS.stock_run_final_observation.value;
const STOCK_FINAL_MESSAGE =
  OPERATIONAL_MARKERS.stock_run_final_message.value;
const AGENTIC_TRACE_RESULT_STATUSES = new Set([
  "ok",
  "unavailable",
  "invalid",
]);
const AGENTIC_PHYSICAL_TRACE_MARKER =
  OPERATIONAL_MARKERS.agentic_physical_trace.value;
const HAND_TRACKING_HELD_MARKER =
  OPERATIONAL_MARKERS.hand_tracking_held_for_narration.value;
const NARRATION_START_WITHOUT_HAND_TRACKING_MARKER =
  OPERATIONAL_MARKERS.narration_start_without_hand_tracking.value;
const NARRATION_END_RELEASED_MARKER =
  OPERATIONAL_MARKERS.narration_end_released_hold.value;
const NARRATION_END_WITHOUT_HAND_TRACKING_MARKER =
  OPERATIONAL_MARKERS.narration_end_without_hand_tracking.value;
const STREAMING_UNDERSTAND_COMPLETED_MARKER =
  OPERATIONAL_MARKERS.streaming_understand_completed.value;
const STREAMING_UNDERSTAND_COMPLETED_LOG =
  `INFO humane_server::services::aibus::turn::streaming: ${STREAMING_UNDERSTAND_COMPLETED_MARKER}`;
const STREAMING_UNDERSTAND_REQUEST_MARKER =
  OPERATIONAL_MARKERS.streaming_understand_request.value;
const STREAMING_UNDERSTAND_REQUEST_LOG_PREFIX =
  `INFO humane_server::services::aibus::understand: ${STREAMING_UNDERSTAND_REQUEST_MARKER}`;
const STREAMING_UNDERSTAND_REQUEST_UUID_RE = new RegExp(
  `^${STREAMING_UNDERSTAND_REQUEST_LOG_PREFIX.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  )} run_id=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`,
);
const STREAMING_UNDERSTAND_REQUEST_LOOSE_RE = new RegExp(
  `^${STREAMING_UNDERSTAND_REQUEST_LOG_PREFIX.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  )} run_id=[0-9a-f-]+$`,
);
const AGENTIC_PHYSICAL_TRACE_RE = new RegExp(
  `^INFO humane_server::synapse::authority::runtime: ${AGENTIC_PHYSICAL_TRACE_MARKER.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  )} correlation=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) ordinal=([1-9][0-9]*) tool=([a-z][a-z0-9_]*) status=completed(?: result_status=([a-z_]+))?$`,
);

export const FIXED_CONTINUITY_PHRASE = "violet cedar seven";
export const FIXED_CONTINUITY_ARTIST = "solara";
export const FIXED_CONTINUITY_ALBUM = "moonrise";

function fixedTurn(value) {
  return Object.freeze({ ...value });
}

export const SESSION_CONTINUITY_TURNS = Object.freeze([
  fixedTurn({
    id: "seed",
    prompt:
      "Continuity acceptance test. I am giving you the harmless public phrase violet cedar seven for this conversation. The public artist is Solara and the public album is Moonrise. Reply only with remembered.",
  }),
  fixedTurn({
    id: "ordinary_interstitial",
    prompt:
      "This is an ordinary follow-up turn in the continuity acceptance test. Reply only with continuing.",
  }),
  fixedTurn({
    id: "ordinary_follow_up",
    prompt:
      "What was the harmless public phrase I gave you at the start of this continuity test? Reply only with the phrase, or unknown if it is not in this conversation.",
  }),
  fixedTurn({
    id: "contextual_artist_query",
    prompt:
      "Who is the artist I mentioned in this continuity test? Reply only with the artist name, or unknown if it is not in this conversation.",
  }),
  fixedTurn({
    id: "contextual_album_query",
    prompt:
      "What is the album by that artist? Reply only with the album name, or unknown if it is not in this conversation.",
  }),
  fixedTurn({
    id: "near_miss_reset",
    prompt: "reset sessions",
  }),
  fixedTurn({
    id: "near_miss_polite_reset",
    prompt: "please reset session",
  }),
  fixedTurn({
    id: "near_miss_punctuated_reset",
    prompt: "reset session.",
  }),
  fixedTurn({
    id: "near_miss_quoted_reset",
    prompt: 'say "reset session"',
  }),
  fixedTurn({
    id: "near_miss_compound_reset",
    prompt: "reset session and play music",
  }),
  fixedTurn({
    id: "near_miss_negated_reset",
    prompt: "don't reset session",
  }),
  fixedTurn({
    id: "near_miss_follow_up",
    prompt:
      "What was the harmless public phrase I gave you at the start of this continuity test? Reply only with the phrase, or unknown if it is not in this conversation.",
  }),
  fixedTurn({
    id: "exact_reset",
    prompt: "reset session",
  }),
  fixedTurn({
    id: "post_reset_follow_up",
    prompt:
      "What was the harmless public phrase I gave you at the start of this continuity test? Reply only with the phrase, or unknown if it is not in this conversation.",
  }),
]);

const TURN_BY_ID = new Map(SESSION_CONTINUITY_TURNS.map((turn) => [turn.id, turn]));
const FIXED_PROMPTS = new Set(SESSION_CONTINUITY_TURNS.map((turn) => turn.prompt));
const RESET_NEAR_MISS_TURN_IDS = Object.freeze([
  "near_miss_reset",
  "near_miss_polite_reset",
  "near_miss_punctuated_reset",
  "near_miss_quoted_reset",
  "near_miss_compound_reset",
  "near_miss_negated_reset",
]);
const FORBIDDEN_FIXED_PROMPT = /[`$\\\u0000-\u001f\u007f]/;

for (const turn of SESSION_CONTINUITY_TURNS) {
  if (
    Buffer.byteLength(turn.prompt, "utf8") > 512 ||
    FORBIDDEN_FIXED_PROMPT.test(turn.prompt)
  ) {
    throw new Error("unsafe fixed continuity fixture");
  }
}

export const CONTINUITY_PHASES = Object.freeze(new Map([
  ["seed", Object.freeze(["seed"])],
  ["ordinary", Object.freeze(["seed", "ordinary_interstitial", "ordinary_follow_up"])],
  ["contextual", Object.freeze(["seed", "ordinary_interstitial", "ordinary_follow_up", "contextual_artist_query", "contextual_album_query"])],
  ["near_miss", Object.freeze(["seed", "ordinary_interstitial", "near_miss_reset", "near_miss_polite_reset", "near_miss_punctuated_reset", "near_miss_quoted_reset", "near_miss_compound_reset", "near_miss_negated_reset", "near_miss_follow_up"])],
  ["exact_reset", Object.freeze(["seed", "ordinary_interstitial", "exact_reset", "post_reset_follow_up"])],
  ["full", Object.freeze(SESSION_CONTINUITY_TURNS.map((turn) => turn.id))],
]));

class SafeContinuityError extends Error {
  constructor(publicMessage, timeoutPhase = null, candidateOwnedIds = []) {
    super(publicMessage);
    this.name = "SafeContinuityError";
    this.publicMessage = publicMessage;
    this.timeoutPhase = timeoutPhase;
    this.candidateOwnedIds = Array.isArray(candidateOwnedIds) ? candidateOwnedIds : [];
  }
}

function usage() {
  return [
    "Usage:",
    "  node platform/deploy/acceptance/pin/session-continuity-physical-smoke.mjs --self-check [--json]",
    "  node platform/deploy/acceptance/pin/session-continuity-physical-smoke.mjs --run --serial PIN_SERIAL --expected-pin-serial PIN_SERIAL --expect-version-name NAME --expect-version-code CODE --expect-apk-sha256 SHA256 [--phase PHASE] [--json]",
    "",
    "Safety contract:",
    `  - Live mode accepts only an operator-confirmed AI Pin serial and the pinned ${RELEASE_IDENTITY.versionName} Server identity.`,
    `  - The expected Pin may use --expected-pin-serial or ${EXPECTED_PIN_SERIAL_ENV}.`,
    "  - The prompt sequence is fixed in source; no caller prompt or case selector is accepted.",
    "  - Fixed phases: seed, ordinary, contextual, near_miss, exact_reset, full (default).",
    "  - Prompts enter through the stock package-bound post-ASR transcription broadcast.",
    "  - The sequence intentionally clears the stock short-term conversation once.",
    "  - Activity and a bounded content-free lifecycle log window are reduced to booleans before output; raw rows and logs are never emitted.",
    "  - Only rows attributed to an injected fixed turn after the harness baseline are eligible for deletion.",
    "  - This harness performs no package installation and makes no package-installer session request.",
  ].join("\n");
}

function nextArgument(argv, argument, index) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${argument} requires a value`);
  return value;
}

export function parseSessionContinuityCliArgs(argv, environment = process.env) {
  const options = {
    mode: null,
    phase: "full",
    serial: null,
    expectedPinSerial: null,
    adbPath: "adb",
    expectedVersionName: null,
    expectedVersionCode: null,
    expectedApkSha256: null,
    json: false,
    help: false,
  };
  const seenValueOptions = new Set();

  const chooseMode = (mode) => {
    if (options.mode !== null) {
      throw new Error("choose exactly one mode");
    }
    options.mode = mode;
  };
  const takeValueOnce = (key, argument, index) => {
    if (seenValueOptions.has(key)) {
      throw new Error(`${argument} may be provided once`);
    }
    seenValueOptions.add(key);
    return nextArgument(argv, argument, index);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--self-check":
        chooseMode("self-check");
        break;
      case "--run":
        chooseMode("run");
        break;
      case "--serial":
      case "-s":
        options.serial = takeValueOnce("serial", argument, index);
        index += 1;
        break;
      case "--expected-pin-serial":
        options.expectedPinSerial = takeValueOnce(
          "expected-pin-serial",
          argument,
          index,
        );
        index += 1;
        break;
      case "--adb":
        options.adbPath = takeValueOnce("adb", argument, index);
        index += 1;
        break;
      case "--expect-version-name":
        options.expectedVersionName = takeValueOnce(
          "version-name",
          argument,
          index,
        );
        index += 1;
        break;
      case "--expect-version-code":
        options.expectedVersionCode = Number(
          takeValueOnce("version-code", argument, index),
        );
        index += 1;
        break;
      case "--expect-apk-sha256":
        options.expectedApkSha256 = takeValueOnce(
          "apk-sha256",
          argument,
          index,
        ).toLowerCase();
        index += 1;
        break;
      case "--phase": {
        const phaseValue = takeValueOnce("phase", argument, index);
        if (!CONTINUITY_PHASES.has(phaseValue)) {
          throw new Error("unknown fixed continuity phase");
        }
        options.phase = phaseValue;
        index += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error("unknown command option");
    }
  }

  if (options.help) return options;
  if (options.mode === null) throw new Error("choose --self-check or --run");
  if (options.mode === "self-check") {
    if (
      options.serial !== null ||
      options.expectedPinSerial !== null ||
      options.expectedVersionName !== null ||
      options.expectedVersionCode !== null ||
      options.expectedApkSha256 !== null ||
      options.adbPath !== "adb" ||
      options.phase !== "full"
    ) {
      throw new Error("--self-check does not accept live-device options");
    }
    return options;
  }

  options.expectedPinSerial = resolveExpectedDeviceSerial({
    cliValue: options.expectedPinSerial,
    environment,
    environmentName: EXPECTED_PIN_SERIAL_ENV,
    label: "AI Pin serial",
  });
  if (!exactDeviceTargetMatches(options.serial, options.expectedPinSerial)) {
    throw new Error("live mode requires the exact operator-confirmed AI Pin serial");
  }
  if (options.expectedVersionName !== RELEASE_IDENTITY.versionName) {
    throw new Error("the pinned Server version name is required");
  }
  if (options.expectedVersionCode !== RELEASE_IDENTITY.versionCode) {
    throw new Error("the pinned Server version code is required");
  }
  if (options.expectedApkSha256 !== RELEASE_IDENTITY.apkSha256) {
    throw new Error("the pinned Server APK SHA-256 is required");
  }
  if (
    typeof options.adbPath !== "string" ||
    options.adbPath.length === 0 ||
    /[\u0000\r\n]/.test(options.adbPath)
  ) {
    throw new Error("ADB executable path is required");
  }
  return options;
}

function turnForId(turnId) {
  const turn = TURN_BY_ID.get(turnId);
  if (turn === undefined) {
    throw new SafeContinuityError("unknown fixed continuity turn");
  }
  return turn;
}

export function buildContinuityTranscriptInjectionCommand(turnId) {
  const prompt = turnForId(turnId).prompt;
  return `am broadcast --user 0 -a hu.ma.ne.INJECT_TRANSCRIPTION -p ${IRONMAN_PACKAGE} --es transcription ${JSON.stringify(prompt)} --ez vision false`;
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function parseContinuityPromptActivityPage(value) {
  if (!plainObject(value) || !Array.isArray(value.items) || value.items.length > 100) {
    throw new SafeContinuityError("the prompt activity page was malformed");
  }
  return value.items.map((item) => {
    if (
      !plainObject(item) ||
      !Number.isSafeInteger(item.id) ||
      item.id <= 0 ||
      typeof item.run_id !== "string" ||
      item.run_id.length === 0 ||
      Buffer.byteLength(item.run_id, "utf8") > 256 ||
      typeof item.prompt !== "string" ||
      Buffer.byteLength(item.prompt, "utf8") > 16 * 1024 ||
      !(
        item.response === null ||
        item.response === undefined ||
        (typeof item.response === "string" &&
          Buffer.byteLength(item.response, "utf8") <= 64 * 1024)
      )
    ) {
      throw new SafeContinuityError("the prompt activity page was malformed");
    }
    return {
      id: item.id,
      runId: item.run_id,
      prompt: item.prompt,
      response: item.response ?? null,
    };
  });
}

function maximumId(rows) {
  return rows.reduce((maximum, row) => Math.max(maximum, row.id), 0);
}

function normalizedWords(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function responseContainsFixedPhrase(response) {
  const words = normalizedWords(response).split(" ").filter(Boolean);
  const phraseWords = FIXED_CONTINUITY_PHRASE.split(" ");
  return words.some(
    (_, index) =>
      phraseWords.every((word, offset) => words[index + offset] === word),
  );
}

function responseContainsArtist(response) {
  const words = normalizedWords(response).split(" ").filter(Boolean);
  const artistWords = FIXED_CONTINUITY_ARTIST.split(" ");
  return words.some(
    (_, index) =>
      artistWords.every((word, offset) => words[index + offset] === word),
  );
}

function responseContainsAlbum(response) {
  const words = normalizedWords(response).split(" ").filter(Boolean);
  const albumWords = FIXED_CONTINUITY_ALBUM.split(" ");
  return words.some(
    (_, index) =>
      albumWords.every((word, offset) => words[index + offset] === word),
  );
}

function parseEpochLogcatLine(line) {
  const match =
    /^\s*[0-9]{9,12}\.[0-9]+\s+([0-9]+)\s+[0-9]+\s+[VDIWEF]\s+([A-Za-z0-9_.-]+)\s*:[ \t]*(.*)$/.exec(
      line,
    );
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, tag: match[2], message: match[3] };
}

/**
 * Selects one stock request-to-final lifecycle after a harness-owned boundary.
 * The run identifier is retained only inside this process for activity
 * attribution. Exported evidence and CLI reports contain booleans and counts.
 */
function selectContinuityLifecycleLog(value, boundaryMarker) {
  if (!CONTINUITY_BOUNDARY_PATTERN.test(boundaryMarker)) {
    throw new SafeContinuityError("the continuity evidence boundary was malformed");
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text, "utf8") > MAX_CHILD_STDOUT_BYTES) {
    throw new SafeContinuityError("the continuity evidence observation was too large");
  }
  let boundaryCount = 0;
  let boundaryObserved = false;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEpochLogcatLine(line);
    if (parsed === null) continue;
    if (
      parsed.tag === CONTINUITY_BOUNDARY_TAG &&
      parsed.message === boundaryMarker
    ) {
      boundaryCount += 1;
      boundaryObserved = true;
      events.length = 0;
      continue;
    }
    if (!boundaryObserved) continue;
    if (parsed.tag === "RunManager") {
      const request = /^Started new Run: (.+)$/.exec(parsed.message);
      if (request !== null && UUID_PATTERN.test(request[1])) {
        events.push({ type: "request", pid: parsed.pid, runId: request[1] });
      } else if (
        parsed.message === STOCK_FINAL_OBSERVATION ||
        parsed.message === STOCK_FINAL_MESSAGE
      ) {
        events.push({ type: "final", pid: parsed.pid });
      }
      continue;
    }
    if (parsed.tag === "PenumbraServer") {
      const request = STREAMING_UNDERSTAND_REQUEST_UUID_RE.exec(parsed.message);
      const trace = AGENTIC_PHYSICAL_TRACE_RE.exec(parsed.message);
      if (request !== null) {
        events.push({ type: "server_request", pid: parsed.pid, runId: request[1] });
      } else if (trace !== null) {
        const terminal = trace[3] === "terminal";
        const resultStatus = trace[4] ?? null;
        if (
          terminal
            ? resultStatus !== null
            : !AGENTIC_TRACE_RESULT_STATUSES.has(resultStatus)
        ) {
          throw new SafeContinuityError(
            "the agentic continuity trace event was malformed",
          );
        }
        events.push({
          type: "agentic_trace",
          pid: parsed.pid,
          runId: trace[1],
          ordinal: Number(trace[2]),
          terminal,
        });
      } else if (parsed.message.includes(AGENTIC_PHYSICAL_TRACE_MARKER)) {
        throw new SafeContinuityError(
          "the agentic continuity trace event was malformed",
        );
      } else if (
        parsed.message === STREAMING_UNDERSTAND_COMPLETED_LOG
      ) {
        events.push({ type: "server_final", pid: parsed.pid });
      }
      continue;
    }
    if (
      parsed.tag === "PenumbraHook" &&
      parsed.message === EXACT_RESET_HOOK_MARKER
    ) {
      events.push({ type: "exact_reset", pid: parsed.pid });
    }
  }
  if (!boundaryObserved || boundaryCount !== 1) {
    throw new SafeContinuityError(
      "the fresh continuity evidence boundary was unavailable",
    );
  }
  const hasServerLifecycle = events.some(
    (event) => event.type === "server_request" || event.type === "server_final",
  );
  const requestType = hasServerLifecycle ? "server_request" : "request";
  const finalType = hasServerLifecycle ? "server_final" : "final";
  const requestIndexes = events
    .map((event, index) => (event.type === requestType ? index : -1))
    .filter((index) => index >= 0);
  const finalIndexes = events
    .map((event, index) => (event.type === finalType ? index : -1))
    .filter((index) => index >= 0);
  const resetMarkerIndexes = events
    .map((event, index) => (event.type === "exact_reset" ? index : -1))
    .filter((index) => index >= 0);
  const requestIndex = requestIndexes.length === 1 ? requestIndexes[0] : -1;
  const finalIndex = finalIndexes.length === 1 ? finalIndexes[0] : -1;
  const requestPid =
    requestIndex >= 0 ? events[requestIndex].pid : null;
  const requestFinalCorrelated =
    requestIndex >= 0 &&
    finalIndex > requestIndex &&
    events[requestIndex].pid === events[finalIndex].pid;
  const requestRunId =
    requestFinalCorrelated && UUID_PATTERN.test(events[requestIndex]?.runId ?? "")
      ? events[requestIndex].runId
      : null;
  const correlatedAgenticTraces =
    requestRunId === null
      ? []
      : events.slice(requestIndex + 1, finalIndex).filter(
          (event) =>
            event.type === "agentic_trace" &&
            event.pid === events[requestIndex].pid &&
            event.runId === requestRunId,
        );
  const agenticStartObserved = correlatedAgenticTraces.length > 0;
  const agenticTerminalTraceCount = correlatedAgenticTraces.filter(
    (event) => event.terminal,
  ).length;
  const agenticCompletedToolCount = correlatedAgenticTraces.filter(
    (event) => !event.terminal,
  ).length;
  const agenticTraceOrdinalsAreStrict = correlatedAgenticTraces.every(
    (event, index) => event.ordinal === index + 1,
  );
  const beforeRequestResetMarkerCount = resetMarkerIndexes.filter(
    (index) => requestIndex < 0 || index < requestIndex,
  ).length;
  const afterFinalResetMarkerCount = resetMarkerIndexes.filter(
    (index) => finalIndex < 0 || index > finalIndex,
  ).length;
  const correlatedResetAuthorizationCount =
    requestPid !== null && requestFinalCorrelated
      ? resetMarkerIndexes.filter(
          (index) =>
            events[index].pid === requestPid &&
            index > requestIndex &&
            index < finalIndex,
        ).length
      : 0;
  const wrongPidResetMarkerCount =
    requestPid !== null
      ? resetMarkerIndexes.filter(
          (index) => events[index].pid !== requestPid,
        ).length
      : resetMarkerIndexes.length;
  const correlatedPids = new Set();
  if (requestIndex >= 0) correlatedPids.add(events[requestIndex].pid);
  if (finalIndex >= 0) correlatedPids.add(events[finalIndex].pid);
  for (const trace of correlatedAgenticTraces) correlatedPids.add(trace.pid);
  const processStable =
    requestFinalCorrelated && correlatedPids.size === 1;
  return {
    evidence: {
      freshBoundaryObserved: true,
      requestObserved: requestIndex >= 0,
      agenticStartObserved,
      agenticNoToolTerminalCorrelated:
        agenticTerminalTraceCount === 1 &&
        agenticCompletedToolCount === 0 &&
        agenticTraceOrdinalsAreStrict,
      agenticToolTerminalCorrelated:
        agenticTerminalTraceCount === 1 &&
        agenticCompletedToolCount > 0 &&
        agenticTraceOrdinalsAreStrict,
      stockFinalObserved: finalIndex >= 0,
      requestFinalCorrelated,
      processStable,
      correlatedResetAuthorization:
        correlatedResetAuthorizationCount === 1,
      correlatedResetAuthorizationCount,
      exactResetMarkerObserved:
        correlatedResetAuthorizationCount === 1,
      exactResetMarkerCount: resetMarkerIndexes.length,
      wrongPidResetMarkerCount,
      beforeRequestResetMarkerCount,
      afterFinalResetMarkerCount,
      agenticCompletedToolCount,
    },
    requestRunId,
  };
}

export function evaluateContinuityLifecycleLog(value, boundaryMarker) {
  return selectContinuityLifecycleLog(value, boundaryMarker).evidence;
}

function narrationStart(message) {
  return (
    message.startsWith(`${HAND_TRACKING_HELD_MARKER} |`) ||
    message.startsWith(
      `${NARRATION_START_WITHOUT_HAND_TRACKING_MARKER} |`,
    )
  );
}

function narrationEnd(message) {
  return (
    message.startsWith(NARRATION_END_RELEASED_MARKER) ||
    message.startsWith(
      `${NARRATION_END_WITHOUT_HAND_TRACKING_MARKER} |`,
    )
  );
}

/**
 * Reduces the post-terminal readiness window to content-free state. The
 * preceding turn has already proved its stock final, which follows narration
 * end and focus release. Any new stock work after this fresh boundary makes
 * the device busy until its corresponding release is observed.
 */
export function evaluateDispatchQuiescenceLog(value, boundaryMarker) {
  if (!QUIESCENCE_BOUNDARY_PATTERN.test(boundaryMarker)) {
    throw new SafeContinuityError(
      "the dispatch quiescence boundary was malformed",
    );
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text, "utf8") > MAX_CHILD_STDOUT_BYTES) {
    throw new SafeContinuityError(
      "the dispatch quiescence observation was too large",
    );
  }
  let boundaryCount = 0;
  let boundaryObserved = false;
  let lifecycleActive = false;
  let narrationActive = false;
  const focusOwners = new Set();
  let transitionCount = 0;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEpochLogcatLine(line);
    if (parsed === null) continue;
    if (
      parsed.tag === QUIESCENCE_BOUNDARY_TAG &&
      parsed.message === boundaryMarker
    ) {
      boundaryCount += 1;
      boundaryObserved = true;
      lifecycleActive = false;
      transitionCount = 0;
      continue;
    }
    if (!boundaryObserved) {
      if (parsed.tag === "PenumbraHook") {
        if (narrationStart(parsed.message)) narrationActive = true;
        else if (narrationEnd(parsed.message)) narrationActive = false;
      }
      if (parsed.tag === "AudioFocusManager") {
        const focus =
          /^(CentralActionHandler|NarratorAccess\.REQUEST_NARRATION) audio focus (granted|abandoned)$/.exec(
            parsed.message,
          );
        if (focus !== null) {
          const owner = `${parsed.pid}:${focus[1]}`;
          if (focus[2] === "granted") focusOwners.add(owner);
          else focusOwners.delete(owner);
        }
      }
      if (parsed.tag === "RunManager") {
        if (/^Started new Run: [0-9a-f-]+$/.test(parsed.message)) lifecycleActive = true;
        else if (parsed.message === STOCK_FINAL_OBSERVATION || parsed.message === STOCK_FINAL_MESSAGE) lifecycleActive = false;
      }
      if (parsed.tag === "PenumbraServer") {
        if (STREAMING_UNDERSTAND_REQUEST_LOOSE_RE.test(parsed.message)) lifecycleActive = true;
        else if (parsed.message === STREAMING_UNDERSTAND_COMPLETED_LOG) lifecycleActive = false;
      }
      continue;
    }
    if (parsed.tag === "RunManager") {
      if (/^Started new Run: [0-9a-f-]+$/.test(parsed.message)) {
        lifecycleActive = true;
        transitionCount += 1;
      } else if (
        parsed.message === STOCK_FINAL_OBSERVATION ||
        parsed.message === STOCK_FINAL_MESSAGE
      ) {
        lifecycleActive = false;
        transitionCount += 1;
      }
      continue;
    }
    if (parsed.tag === "PenumbraServer") {
      if (STREAMING_UNDERSTAND_REQUEST_LOOSE_RE.test(parsed.message)) {
        lifecycleActive = true;
        transitionCount += 1;
      } else if (
        parsed.message === STREAMING_UNDERSTAND_COMPLETED_LOG
      ) {
        lifecycleActive = false;
        transitionCount += 1;
      }
      continue;
    }
    if (parsed.tag === "PenumbraHook") {
      if (narrationStart(parsed.message)) {
        narrationActive = true;
        transitionCount += 1;
      } else if (narrationEnd(parsed.message)) {
        narrationActive = false;
        transitionCount += 1;
      }
      continue;
    }
    if (parsed.tag === "AudioFocusManager") {
      const focus =
        /^(CentralActionHandler|NarratorAccess\.REQUEST_NARRATION) audio focus (granted|abandoned)$/.exec(
          parsed.message,
        );
      if (focus !== null) {
        const owner = `${parsed.pid}:${focus[1]}`;
        if (focus[2] === "granted") focusOwners.add(owner);
        else focusOwners.delete(owner);
        transitionCount += 1;
      }
    }
  }
  if (!boundaryObserved || boundaryCount !== 1) {
    throw new SafeContinuityError(
      "the fresh dispatch quiescence boundary was unavailable",
    );
  }
  return {
    freshBoundaryObserved: true,
    stockLifecycleActive: lifecycleActive,
    narrationActive,
    audioFocusActive: focusOwners.size > 0,
    transitionCount,
    ready:
      !lifecycleActive && !narrationActive && focusOwners.size === 0,
  };
}

/**
 * Attribute one post-baseline activity group to one immediately preceding
 * fixed injection, then discard all activity text. The opaque run key and
 * returned IDs stay internal to lifecycle correlation and cleanup and are
 * never copied into a report.
 */
export function reduceContinuityTurnActivity(turnId, rows, cursor) {
  const turn = turnForId(turnId);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new SafeContinuityError("the activity boundary was malformed");
  }
  if (!Array.isArray(rows)) {
    throw new SafeContinuityError("the prompt activity page was malformed");
  }
  const attributed = rows.filter(
    (row) => row.id > cursor && row.prompt === turn.prompt,
  );
  if (attributed.length === 0) {
    return {
      complete: false,
      unambiguous: true,
      terminalObserved: false,
      phraseObserved: false,
      artistObserved: false,
      albumObserved: false,
      rememberedAcknowledgementObserved: false,
      continuingAcknowledgementObserved: false,
      unknownObserved: false,
      clearContextActionObserved: false,
      correlationRunId: null,
      ownedIds: [],
      nextCursor: maximumId(rows),
    };
  }
  const runKeys = new Set(attributed.map((row) => row.runId));
  if (runKeys.size !== 1) {
    return {
      complete: true,
      unambiguous: false,
      terminalObserved: false,
      phraseObserved: false,
      artistObserved: false,
      albumObserved: false,
      rememberedAcknowledgementObserved: false,
      continuingAcknowledgementObserved: false,
      unknownObserved: false,
      clearContextActionObserved: false,
      correlationRunId: null,
      ownedIds: [],
      nextCursor: maximumId(rows),
    };
  }
  const responses = attributed
    .map((row) => row.response)
    .filter((response) => typeof response === "string" && response.length > 0);
  const terminals = responses.filter((response) => !response.startsWith("Action:"));
  const normalizedTerminals = terminals.map(normalizedWords);
  return {
    complete: responses.length > 0,
    unambiguous: true,
    terminalObserved: terminals.length > 0,
    phraseObserved: terminals.some(responseContainsFixedPhrase),
    artistObserved: terminals.some(responseContainsArtist),
    albumObserved: terminals.some(responseContainsAlbum),
    rememberedAcknowledgementObserved:
      normalizedTerminals.includes("remembered"),
    continuingAcknowledgementObserved:
      normalizedTerminals.includes("continuing"),
    unknownObserved: normalizedTerminals.includes("unknown"),
    clearContextActionObserved: responses.includes(CLEAR_CONTEXT_RESPONSE),
    correlationRunId: attributed[0].runId,
    ownedIds: attributed.map((row) => row.id),
    nextCursor: maximumId(rows),
  };
}

export function evaluateCandidateIdentity(actual, expected) {
  const packageExact = actual?.packageName === SERVER_PACKAGE;
  const versionNameExact =
    typeof expected?.versionName === "string" &&
    actual?.versionName === expected.versionName;
  const versionCodeExact =
    Number.isSafeInteger(expected?.versionCode) &&
    actual?.versionCode === expected.versionCode;
  const apkSha256Exact =
    typeof expected?.apkSha256 === "string" &&
    actual?.apkSha256 === expected.apkSha256;
  return {
    package_exact: packageExact,
    version_name_exact: versionNameExact,
    version_code_exact: versionCodeExact,
    apk_sha256_exact: apkSha256Exact,
    pass:
      packageExact && versionNameExact && versionCodeExact && apkSha256Exact,
  };
}

function captureChild(
  command,
  args,
  { input = null, timeoutMs = 20_000, maxStdoutBytes = MAX_CHILD_STDOUT_BYTES } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnProcess(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      rejectPromise(new SafeContinuityError("could not start a required local process"));
      return;
    }
    const stdout = [];
    let stdoutBytes = 0;
    let settled = false;
    let inputBuffer =
      input === null ? null : Buffer.isBuffer(input) ? input : Buffer.from(input);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (inputBuffer !== null) {
        inputBuffer.fill(0);
        inputBuffer = null;
      }
      callback();
    };
    const fail = (message) => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      finish(() => rejectPromise(new SafeContinuityError(message)));
    };
    const timer = setTimeout(
      () => fail("a bounded device operation timed out"),
      timeoutMs,
    );
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail("a bounded device response was too large");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.resume();
    child.on("error", () => fail("a required local process was unavailable"));
    child.on("close", (code, signal) => {
      finish(() =>
        resolvePromise({
          code: code ?? (signal === null ? 1 : 128),
          stdout: Buffer.concat(stdout),
        }),
      );
    });
    child.stdin.on("error", () => {});
    if (inputBuffer === null) child.stdin.end();
    else child.stdin.end(inputBuffer);
  });
}

async function runAdb(options, args, runOptions, publicFailure) {
  const completed = await captureChild(
    options.adbPath,
    ["-s", options.serial, ...args],
    runOptions,
  );
  if (completed.code !== 0) {
    completed.stdout.fill(0);
    throw new SafeContinuityError(publicFailure);
  }
  return completed.stdout;
}

export function buildContinuityActivityCurlConfig(path, method, token) {
  const validGet = path === PROMPT_ACTIVITY_PATH && method === "GET";
  const validDelete =
    method === "DELETE" && /^\/api\/activity\/prompts\/[1-9][0-9]*$/.test(path);
  if (!(validGet || validDelete)) {
    throw new SafeContinuityError("refusing a non-allowlisted Center activity request");
  }
  if (
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 1_024 ||
    !/^[A-Za-z0-9._~+/=:-]+$/.test(token)
  ) {
    throw new SafeContinuityError("the fixed admin token was invalid");
  }
  return Buffer.from(
    [
      `url = "http://127.0.0.1:8080${path}"`,
      `request = "${method}"`,
      `header = "Authorization: Bearer ${token}"`,
      'header = "Accept: application/json"',
      'header = "User-Agent: penumbra-session-continuity-smoke/1"',
      "silent",
      "show-error",
      "connect-timeout = 5",
      "max-time = 30",
      'noproxy = "*"',
      'proto = "=http"',
      `write-out = "${HTTP_STATUS_MARKER.replace("\n", "\\n")}%{http_code}\\n"`,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function deviceActivityRequest(options, token, path, method = "GET") {
  const output = await runAdb(
    options,
    ["shell", "exec curl -q -K -"],
    {
      input: buildContinuityActivityCurlConfig(path, method, token),
      timeoutMs: 40_000,
      maxStdoutBytes: MAX_CHILD_STDOUT_BYTES,
    },
    "a fixed Center activity request failed",
  );
  try {
    const marker = Buffer.from(HTTP_STATUS_MARKER, "utf8");
    const markerIndex = output.lastIndexOf(marker);
    if (markerIndex < 0) {
      throw new SafeContinuityError("a fixed Center response was malformed");
    }
    const status = output
      .subarray(markerIndex + marker.length)
      .toString("ascii")
      .trim();
    const body = output.subarray(0, markerIndex);
    if (method === "DELETE") {
      if (status !== "204" && status !== "404") {
        throw new SafeContinuityError("test activity cleanup was rejected");
      }
      return null;
    }
    if (status !== "200" || body.length === 0 || body.length > MAX_HTTP_BODY_BYTES) {
      throw new SafeContinuityError("a fixed Center activity response was unavailable");
    }
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw new SafeContinuityError("a fixed Center activity response was malformed");
    }
  } finally {
    output.fill(0);
  }
}

class SessionContinuityDevice {
  constructor(options, token) {
    this.options = options;
    this.token = token;
  }

  async readMediaVolumeState() {
    let volumeOutput = null;
    let audioDump = null;
    try {
      volumeOutput = await runAdb(
        this.options,
        [...MEDIA_VOLUME_GET_ADB_ARGS],
        { timeoutMs: 10_000, maxStdoutBytes: 4 * 1024 },
        "the media volume observation failed",
      );
      audioDump = await runAdb(
        this.options,
        [...AUDIO_DUMP_ADB_ARGS],
        { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
        "the media mute observation failed",
      );
      return parseMediaVolumeSnapshot(volumeOutput, audioDump);
    } finally {
      volumeOutput?.fill(0);
      audioDump?.fill(0);
    }
  }

  async setMediaVolumeIndex(index) {
    const output = await runAdb(
      this.options,
      buildMediaVolumeSetAdbArgs(index),
      { timeoutMs: 10_000, maxStdoutBytes: 4 * 1024 },
      "the media volume restoration failed",
    );
    output.fill(0);
  }

  async promptRows() {
    return parseContinuityPromptActivityPage(
      await deviceActivityRequest(
        this.options,
        this.token,
        PROMPT_ACTIVITY_PATH,
      ),
    );
  }

  async beginTurnBoundary() {
    const marker = `continuity-smoke-${randomUUID()}`;
    const output = await runAdb(
      this.options,
      ["shell", "log", "-p", "i", "-t", CONTINUITY_BOUNDARY_TAG, marker],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
      "the continuity evidence boundary could not be created",
    );
    output.fill(0);
    return marker;
  }

  async beginDispatchQuiescenceBoundary() {
    const marker = `continuity-quiet-${randomUUID()}`;
    const output = await runAdb(
      this.options,
      ["shell", "log", "-p", "i", "-t", QUIESCENCE_BOUNDARY_TAG, marker],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
      "the dispatch quiescence boundary could not be created",
    );
    output.fill(0);
    return marker;
  }

  async inject(turnId) {
    const output = await runAdb(
      this.options,
      ["shell", buildContinuityTranscriptInjectionCommand(turnId)],
      { timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 },
      "the fixed transcript injection failed",
    );
    output.fill(0);
  }

  async continuityLog(boundaryMarker) {
    if (!CONTINUITY_BOUNDARY_PATTERN.test(boundaryMarker)) {
      throw new SafeContinuityError("the continuity evidence boundary was malformed");
    }
    return runAdb(
      this.options,
      [
        "shell",
        "logcat",
        "-b",
        "main",
        "-v",
        "epoch",
        "-d",
        `${CONTINUITY_BOUNDARY_TAG}:I`,
        "PenumbraHook:V",
        "PenumbraServer:V",
        "RunManager:V",
        "*:S",
      ],
      { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
      "the continuity evidence observation failed",
    );
  }

  async dispatchQuiescenceLog(boundaryMarker) {
    if (!QUIESCENCE_BOUNDARY_PATTERN.test(boundaryMarker)) {
      throw new SafeContinuityError(
        "the dispatch quiescence boundary was malformed",
      );
    }
    return runAdb(
      this.options,
      [
        "shell",
        "logcat",
        "-b",
        "main",
        "-v",
        "epoch",
        "-d",
        `${QUIESCENCE_BOUNDARY_TAG}:I`,
        "PenumbraHook:V",
        "PenumbraServer:V",
        "RunManager:V",
        "AudioFocusManager:V",
        "*:S",
      ],
      { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
      "the dispatch quiescence observation failed",
    );
  }

  async deletePrompt(id) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new SafeContinuityError("invalid cleanup row");
    }
    await deviceActivityRequest(
      this.options,
      this.token,
      `/api/activity/prompts/${id}`,
      "DELETE",
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function awaitDispatchQuiescence(device, dependencies, globalDeadline = null) {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.delay ?? delay;
  const boundaryMarker = await device.beginDispatchQuiescenceBoundary();
  const quiescenceDeadline = now() + DISPATCH_QUIESCENCE_TIMEOUT_MS;
  const deadline = globalDeadline !== null ? Math.min(quiescenceDeadline, globalDeadline) : quiescenceDeadline;
  let quietSince = null;
  let previousTransitionCount = null;
  while (true) {
    const logValue = await device.dispatchQuiescenceLog(boundaryMarker);
    let state;
    try {
      state = evaluateDispatchQuiescenceLog(logValue, boundaryMarker);
    } finally {
      if (Buffer.isBuffer(logValue)) logValue.fill(0);
    }
    const observedAt = now();
    if (!state.ready) {
      quietSince = null;
    } else if (
      quietSince === null ||
      previousTransitionCount !== state.transitionCount
    ) {
      quietSince = observedAt;
    }
    previousTransitionCount = state.transitionCount;
    if (
      quietSince !== null &&
      observedAt - quietSince >= DISPATCH_QUIET_INTERVAL_MS
    ) {
      return;
    }
    if (observedAt >= deadline) {
      throw new SafeContinuityError(
        "stock dispatch did not become quiescent in time",
        "pre_dispatch_quiescence",
      );
    }
    await wait(POLL_INTERVAL_MS);
  }
}

async function observeInjectedTurn(
  device,
  turnId,
  cursor,
  boundaryMarker,
  dependencies,
  globalDeadline = null,
) {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.delay ?? delay;
  const turnDeadline = now() + TURN_TIMEOUT_MS;
  const deadline = globalDeadline !== null ? Math.min(turnDeadline, globalDeadline) : turnDeadline;
  let candidateOwnedIds = [];
  while (true) {
    const [rows, logValue] = await Promise.all([
      device.promptRows(),
      device.continuityLog(boundaryMarker),
    ]);
    const reduced = reduceContinuityTurnActivity(turnId, rows, cursor);
    let lifecycle;
    try {
      lifecycle = selectContinuityLifecycleLog(logValue, boundaryMarker);
    } finally {
      if (Buffer.isBuffer(logValue)) logValue.fill(0);
    }
    if (reduced.unambiguous && reduced.ownedIds.length > 0) {
      candidateOwnedIds = reduced.ownedIds;
    }
    if (!reduced.unambiguous) {
      throw new SafeContinuityError("fixed-turn activity attribution was ambiguous");
    }
    const exactReset = turnId === "exact_reset";
    const hasAttributedActivity = reduced.ownedIds.length > 0;
    const activityCorrelated = exactReset
      ? !hasAttributedActivity ||
        reduced.correlationRunId === lifecycle.requestRunId
      : reduced.correlationRunId === lifecycle.requestRunId;
    const activityComplete = exactReset || reduced.terminalObserved;
    const resetMarkerMatched = exactReset
      ? lifecycle.evidence.correlatedResetAuthorization
      : lifecycle.evidence.correlatedResetAuthorizationCount === 0;
    if (
      lifecycle.evidence.requestFinalCorrelated &&
      activityCorrelated &&
      activityComplete &&
      resetMarkerMatched
    ) {
      return {
        ...reduced,
        complete: true,
        stockLifecycleObserved: true,
        exactResetMarkerObserved:
          lifecycle.evidence.exactResetMarkerObserved,
        correlatedResetAuthorization:
          lifecycle.evidence.correlatedResetAuthorization,
        agenticNoToolTerminalCorrelated:
          lifecycle.evidence.agenticNoToolTerminalCorrelated,
        agenticToolTerminalCorrelated:
          lifecycle.evidence.agenticToolTerminalCorrelated,
        processStable: lifecycle.evidence.processStable,
      };
    }
    if (now() >= deadline) {
      throw new SafeContinuityError(
        "a fixed continuity turn did not complete in time",
        "turn_completion",
        candidateOwnedIds,
      );
    }
    await wait(POLL_INTERVAL_MS);
  }
}

function emptyEvidence() {
  return {
    sequence_completed: false,
    all_pre_dispatch_quiescence_gates_completed: false,
    activity_attribution_unambiguous: false,
    all_turn_stock_lifecycles_completed: false,
    seed_completed: false,
    seed_acknowledged: false,
    ordinary_interstitial_completed: false,
    ordinary_interstitial_acknowledged: false,
    ordinary_follow_up_completed: false,
    phrase_survived_ordinary_follow_up: false,
    bounded_prior_fact_recalled_without_tool: false,
    ordinary_follow_up_preserved_context: false,
    contextual_artist_query_completed: false,
    contextual_artist_recalled: false,
    contextual_album_query_completed: false,
    contextual_album_recalled: false,
    contextual_music_preserved_context: false,
    near_miss_completed: false,
    near_miss_clear_action_absent: false,
    near_miss_follow_up_completed: false,
    phrase_survived_near_miss: false,
    reset_near_misses_preserved_context: false,
    exact_reset_turn_completed: false,
    exact_reset_authorization_observed: false,
    exact_reset_completion_observed: false,
    exact_reset_action_observed: false,
    exact_reset_cleared_context: false,
    post_reset_follow_up_completed: false,
    post_reset_unknown_observed: false,
    phrase_absent_after_exact_reset: false,
    fresh_query_could_not_recall_prior_fact: false,
    process_stable_throughout: false,
    acceptance_scope_instrumentation_only: true,
    acceptance_scope_human_microphone_required: true,
    acceptance_scope_human_projector_required: true,
    acceptance_scope_human_audibility_required: true,
  };
}

function privacyEvidence() {
  return {
    fixed_public_prompts_only: true,
    caller_prompt_input_accepted: false,
    raw_activity_emitted: false,
    bounded_content_free_logcat_only: true,
    raw_logcat_emitted: false,
    session_identifiers_emitted: false,
    installer_session_queried: false,
  };
}

function blockedReport(identity) {
  return {
    schema_version: 1,
    mode: "stock_session_continuity_physical",
    status: "blocked",
    prerequisites: {
      allowlisted_pin_selected: true,
      candidate_package_exact: identity.package_exact,
      candidate_version_name_exact: identity.version_name_exact,
      candidate_version_code_exact: identity.version_code_exact,
      candidate_apk_sha256_exact: identity.apk_sha256_exact,
      candidate_identity_exact: identity.pass,
    },
    evidence: emptyEvidence(),
    cleanup: {
      cleanup_attempted: false,
      owned_activity_removed: false,
      non_owned_delete_attempted: false,
      cleanup_timed_out: false,
      candidate_timeout_row_count: 0,
      ambiguous_fixture_row_count: 0,
      media_volume_snapshot_captured: null,
      media_volume_restored: null,
    },
    timeouts: {
      pre_dispatch_quiescence: false,
      turn_completion: false,
      cleanup: false,
    },
    privacy: privacyEvidence(),
  };
}

function phaseRequiredEvidenceKeys(phaseTurnIds) {
  const keys = new Set([
    "sequence_completed",
    "all_pre_dispatch_quiescence_gates_completed",
    "activity_attribution_unambiguous",
    "all_turn_stock_lifecycles_completed",
    "process_stable_throughout",
  ]);
  const phaseSet = new Set(phaseTurnIds);
  if (phaseSet.has("seed")) {
    keys.add("seed_completed");
    keys.add("seed_acknowledged");
  }
  if (phaseSet.has("ordinary_interstitial")) {
    keys.add("ordinary_interstitial_completed");
    keys.add("ordinary_interstitial_acknowledged");
  }
  if (phaseSet.has("ordinary_follow_up")) {
    keys.add("ordinary_follow_up_completed");
    keys.add("phrase_survived_ordinary_follow_up");
    keys.add("bounded_prior_fact_recalled_without_tool");
    keys.add("ordinary_follow_up_preserved_context");
  }
  if (phaseSet.has("contextual_artist_query")) {
    keys.add("contextual_artist_query_completed");
    keys.add("contextual_artist_recalled");
    keys.add("contextual_music_preserved_context");
  }
  if (phaseSet.has("contextual_album_query")) {
    keys.add("contextual_album_query_completed");
    keys.add("contextual_album_recalled");
  }
  const hasNearMiss = RESET_NEAR_MISS_TURN_IDS.some((id) => phaseSet.has(id));
  if (hasNearMiss) {
    keys.add("near_miss_completed");
    keys.add("near_miss_clear_action_absent");
    keys.add("reset_near_misses_preserved_context");
  }
  if (phaseSet.has("near_miss_follow_up")) {
    keys.add("near_miss_follow_up_completed");
    keys.add("phrase_survived_near_miss");
  }
  if (phaseSet.has("exact_reset")) {
    keys.add("exact_reset_turn_completed");
    keys.add("exact_reset_authorization_observed");
    keys.add("exact_reset_completion_observed");
    keys.add("exact_reset_action_observed");
    keys.add("exact_reset_cleared_context");
  }
  if (phaseSet.has("post_reset_follow_up")) {
    keys.add("post_reset_follow_up_completed");
    keys.add("post_reset_unknown_observed");
    keys.add("phrase_absent_after_exact_reset");
    keys.add("fresh_query_could_not_recall_prior_fact");
  }
  return keys;
}

function evidenceFromTurns(
  observations,
  sequenceCompleted,
  attributionUnambiguous,
  quiescenceGatesCompleted,
  phaseTurnIds,
) {
  const seed = observations.get("seed");
  const ordinaryInterstitial = observations.get("ordinary_interstitial");
  const ordinary = observations.get("ordinary_follow_up");
  const contextualArtist = observations.get("contextual_artist_query");
  const contextualAlbum = observations.get("contextual_album_query");
  const nearMisses = RESET_NEAR_MISS_TURN_IDS.map((turnId) =>
    observations.get(turnId),
  );
  const afterNearMiss = observations.get("near_miss_follow_up");
  const exactReset = observations.get("exact_reset");
  const afterReset = observations.get("post_reset_follow_up");
  const phaseSet = new Set(phaseTurnIds);
  const allTurnStockLifecyclesCompleted =
    phaseTurnIds.every(
      (turnId) => observations.get(turnId)?.stockLifecycleObserved === true,
    );
  const processStableThroughout =
    phaseTurnIds.every(
      (turnId) => observations.get(turnId)?.processStable === true,
    );
  return {
    sequence_completed: sequenceCompleted,
    all_pre_dispatch_quiescence_gates_completed:
      quiescenceGatesCompleted === phaseTurnIds.length - 1,
    activity_attribution_unambiguous: attributionUnambiguous,
    all_turn_stock_lifecycles_completed: allTurnStockLifecyclesCompleted,
    process_stable_throughout: processStableThroughout,
    seed_completed: seed?.terminalObserved === true,
    seed_acknowledged:
      seed?.terminalObserved === true &&
      seed.rememberedAcknowledgementObserved === true,
    ordinary_interstitial_completed:
      ordinaryInterstitial?.terminalObserved === true,
    ordinary_interstitial_acknowledged:
      ordinaryInterstitial?.terminalObserved === true &&
      ordinaryInterstitial.continuingAcknowledgementObserved === true,
    ordinary_follow_up_completed: ordinary?.terminalObserved === true,
    phrase_survived_ordinary_follow_up:
      ordinary?.terminalObserved === true && ordinary.phraseObserved === true,
    bounded_prior_fact_recalled_without_tool:
      ordinary?.terminalObserved === true &&
      ordinary.phraseObserved === true &&
      ordinary.agenticNoToolTerminalCorrelated === true,
    ordinary_follow_up_preserved_context:
      ordinaryInterstitial?.continuingAcknowledgementObserved === true &&
      ordinary?.phraseObserved === true,
    contextual_artist_query_completed:
      contextualArtist?.terminalObserved === true,
    contextual_artist_recalled:
      contextualArtist?.terminalObserved === true &&
      contextualArtist.artistObserved === true,
    contextual_album_query_completed:
      contextualAlbum?.terminalObserved === true,
    contextual_album_recalled:
      contextualAlbum?.terminalObserved === true &&
      contextualAlbum.albumObserved === true,
    contextual_music_preserved_context:
      contextualArtist?.artistObserved === true &&
      contextualAlbum?.albumObserved === true,
    near_miss_completed: nearMisses.every(
      (nearMiss) => nearMiss?.terminalObserved === true,
    ),
    near_miss_clear_action_absent:
      nearMisses.every(
        (nearMiss) =>
          nearMiss?.terminalObserved === true &&
          nearMiss.exactResetMarkerObserved === false &&
          nearMiss.clearContextActionObserved === false,
      ),
    near_miss_follow_up_completed: afterNearMiss?.terminalObserved === true,
    phrase_survived_near_miss:
      afterNearMiss?.terminalObserved === true &&
      afterNearMiss.phraseObserved === true,
    reset_near_misses_preserved_context:
      nearMisses.every(
        (nearMiss) =>
          nearMiss?.terminalObserved === true &&
          nearMiss.exactResetMarkerObserved === false &&
          nearMiss.clearContextActionObserved === false,
      ) && afterNearMiss?.phraseObserved === true,
    exact_reset_turn_completed: exactReset?.complete === true,
    exact_reset_authorization_observed:
      exactReset?.correlatedResetAuthorization === true,
    exact_reset_completion_observed:
      exactReset?.clearContextActionObserved === true ||
      (exactReset?.exactResetMarkerObserved === true &&
       afterReset?.unknownObserved === true),
    exact_reset_action_observed:
      exactReset?.exactResetMarkerObserved === true,
    exact_reset_cleared_context:
      exactReset?.correlatedResetAuthorization === true &&
      afterReset?.terminalObserved === true &&
      afterReset.unknownObserved === true &&
      afterReset.phraseObserved === false,
    post_reset_follow_up_completed: afterReset?.terminalObserved === true,
    post_reset_unknown_observed:
      afterReset?.terminalObserved === true && afterReset.unknownObserved === true,
    phrase_absent_after_exact_reset:
      afterReset?.terminalObserved === true &&
      afterReset.unknownObserved === true &&
      afterReset.phraseObserved === false,
    fresh_query_could_not_recall_prior_fact:
      afterReset?.terminalObserved === true &&
      afterReset.unknownObserved === true &&
      afterReset.phraseObserved === false,
    acceptance_scope_instrumentation_only: true,
    acceptance_scope_human_microphone_required: true,
    acceptance_scope_human_projector_required: true,
    acceptance_scope_human_audibility_required: true,
  };
}

function requiredEvidencePassed(evidence, phaseTurnIds) {
  const requiredKeys = phaseRequiredEvidenceKeys(phaseTurnIds);
  for (const key of requiredKeys) {
    if (evidence[key] !== true) return false;
  }
  return true;
}

export async function executeSessionContinuitySuite(options, dependencies = {}) {
  if (!exactDeviceTargetMatches(options?.serial, options?.expectedPinSerial)) {
    throw new SafeContinuityError("refusing a non-confirmed physical device");
  }
  if (
    options.expectedVersionName !== RELEASE_IDENTITY.versionName ||
    options.expectedVersionCode !== RELEASE_IDENTITY.versionCode ||
    options.expectedApkSha256 !== RELEASE_IDENTITY.apkSha256
  ) {
    throw new SafeContinuityError("refusing an unpinned candidate identity");
  }
  const phaseTurnIds = CONTINUITY_PHASES.get(options.phase ?? "full");
  if (!phaseTurnIds) {
    throw new SafeContinuityError("unknown fixed continuity phase");
  }
  const expected = {
    versionName: options.expectedVersionName,
    versionCode: options.expectedVersionCode,
    apkSha256: options.expectedApkSha256,
  };
  const actualIdentity =
    dependencies.identity ?? (await collectInstalledServerIdentity(options));
  const identity = evaluateCandidateIdentity(actualIdentity, expected);
  if (!identity.pass) return blockedReport(identity);

  const token = dependencies.token ?? (await readAdminToken());
  const device =
    dependencies.device ?? new SessionContinuityDevice(options, token);
  const now = dependencies.now ?? Date.now;
  const globalDeadline = now() + TURN_TIMEOUT_MS * (phaseTurnIds.length + 2);
  const baselineRows = await device.promptRows();
  const baselineId = maximumId(baselineRows);
  let cursor = baselineId;
  const observations = new Map();
  const ownedIds = new Set();
  const candidateTimeoutIds = new Set();
  let sequenceCompleted = true;
  let attributionUnambiguous = true;
  let cleanupCallsSucceeded = true;
  let cleanupTimedOut = false;
  let quiescenceGatesCompleted = 0;
  let timeoutPhase = null;
  const mediaVolumeSnapshot = await captureStableMediaVolumeSnapshot(device);
  let mediaVolumeRestored = false;

  try {
    for (const [index, turnId] of phaseTurnIds.entries()) {
      if (index > 0) {
        await awaitDispatchQuiescence(device, dependencies, globalDeadline);
        quiescenceGatesCompleted += 1;
      }
      const boundaryMarker = await device.beginTurnBoundary();
      await device.inject(turnId);
      const observation = await observeInjectedTurn(
        device,
        turnId,
        cursor,
        boundaryMarker,
        dependencies,
        globalDeadline,
      );
      observations.set(turnId, observation);
      cursor = observation.nextCursor;
      for (const id of observation.ownedIds) ownedIds.add(id);
    }
  } catch (error) {
    sequenceCompleted = false;
    attributionUnambiguous = false;
    if (error instanceof SafeContinuityError) {
      timeoutPhase = error.timeoutPhase;
      for (const id of error.candidateOwnedIds) {
        candidateTimeoutIds.add(id);
      }
    }
  } finally {
    const idsToDelete = [...ownedIds].sort((left, right) => left - right);
    for (const id of idsToDelete) {
      if (now() >= globalDeadline) {
        cleanupTimedOut = true;
        break;
      }
      try {
        await device.deletePrompt(id);
      } catch {
        cleanupCallsSucceeded = false;
      }
    }
    mediaVolumeRestored = await restoreMediaVolumeSnapshot(
      device,
      mediaVolumeSnapshot,
    );
  }

  let ownedRowsAbsent = false;
  let noUnattributedFixtureRows = false;
  let ambiguousFixtureRowCount = 0;
  try {
    const finalRows = await device.promptRows();
    const remainingIds = new Set(finalRows.map((row) => row.id));
    ownedRowsAbsent = [...ownedIds].every((id) => !remainingIds.has(id));
    const unattributedFixtureRows = finalRows.filter(
      (row) =>
        row.id > baselineId &&
        FIXED_PROMPTS.has(row.prompt) &&
        !ownedIds.has(row.id),
    );
    ambiguousFixtureRowCount = unattributedFixtureRows.length;
    noUnattributedFixtureRows = ambiguousFixtureRowCount === 0;
  } catch {
    cleanupCallsSucceeded = false;
  }
  attributionUnambiguous &&= noUnattributedFixtureRows;

  const evidence = evidenceFromTurns(
    observations,
    sequenceCompleted,
    attributionUnambiguous,
    quiescenceGatesCompleted,
    phaseTurnIds,
  );
  const cleanup = {
    cleanup_attempted: true,
    owned_activity_removed: cleanupCallsSucceeded && ownedRowsAbsent && !cleanupTimedOut,
    non_owned_delete_attempted: false,
    cleanup_timed_out: cleanupTimedOut,
    candidate_timeout_row_count: candidateTimeoutIds.size,
    ambiguous_fixture_row_count: ambiguousFixtureRowCount,
    media_volume_snapshot_captured: true,
    media_volume_restored: mediaVolumeRestored,
  };
  const status =
    requiredEvidencePassed(evidence, phaseTurnIds) &&
    cleanup.owned_activity_removed &&
    cleanup.media_volume_restored
      ? "pass"
      : "incomplete";
  return {
    schema_version: 1,
    mode: "stock_session_continuity_physical",
    phase: options.phase ?? "full",
    status,
    prerequisites: {
      allowlisted_pin_selected: true,
      candidate_package_exact: identity.package_exact,
      candidate_version_name_exact: identity.version_name_exact,
      candidate_version_code_exact: identity.version_code_exact,
      candidate_apk_sha256_exact: identity.apk_sha256_exact,
      candidate_identity_exact: identity.pass,
    },
    evidence,
    cleanup,
    timeouts: {
      pre_dispatch_quiescence: timeoutPhase === "pre_dispatch_quiescence",
      turn_completion: timeoutPhase === "turn_completion",
      cleanup: cleanupTimedOut,
    },
    privacy: privacyEvidence(),
  };
}

function selfCheckReport() {
  const boundary =
    "continuity-smoke-123e4567-e89b-42d3-a456-426614174000";
  const runId = "123e4567-e89b-42d3-a456-426614174001";
  const rows = [
    {
      id: 1,
      runId,
      prompt: turnForId("ordinary_follow_up").prompt,
      response: "Violet, cedar, seven.",
    },
  ];
  const reduced = reduceContinuityTurnActivity("ordinary_follow_up", rows, 0);
  const lifecycle = selectContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I ${CONTINUITY_BOUNDARY_TAG}: ${boundary}`,
      `1710000000.002  200  201 D RunManager: Started new Run: ${runId}`,
      `1710000000.003  200  201 W PenumbraServer: INFO humane_server::synapse::authority::runtime: ${AGENTIC_PHYSICAL_TRACE_MARKER} correlation=${runId} ordinal=1 tool=terminal status=completed`,
      `1710000000.004  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  const passed =
    reduced.complete &&
    reduced.unambiguous &&
    reduced.terminalObserved &&
    reduced.phraseObserved &&
    reduced.ownedIds.length === 1 &&
    reduced.correlationRunId === lifecycle.requestRunId &&
    lifecycle.evidence.requestFinalCorrelated &&
    lifecycle.evidence.exactResetMarkerCount === 0 &&
    lifecycle.evidence.agenticNoToolTerminalCorrelated;
  return {
    schema_version: 1,
    mode: "stock_session_continuity_self_check",
    status: passed ? "pass" : "fail",
    parser_reduction_passed: passed,
    privacy: privacyEvidence(),
  };
}

export function renderSessionContinuityReport(report) {
  const yesNo = (value) => (value ? "yes" : "no");
  if (report.mode === "stock_session_continuity_self_check") {
    return [
      `Session continuity host self-check: ${report.status.toUpperCase()}`,
      `- parser reduction passed: ${yesNo(report.parser_reduction_passed)}`,
      "- physical device contacted: no",
      "- fixture or activity content emitted: no",
    ].join("\n");
  }
  const phaseLabel = report.phase ?? "full";
  return [
    `Session continuity physical acceptance (${phaseLabel}): ${report.status.toUpperCase()}`,
    `- candidate identity exact: ${yesNo(report.prerequisites.candidate_identity_exact)}`,
    `- pre-dispatch quiescence before each later turn: ${yesNo(report.evidence.all_pre_dispatch_quiescence_gates_completed)}`,
    `- every turn reached a stock final: ${yesNo(report.evidence.all_turn_stock_lifecycles_completed)}`,
    `- process stable throughout: ${yesNo(report.evidence.process_stable_throughout)}`,
    `- prior fact recalled without a tool: ${yesNo(report.evidence.bounded_prior_fact_recalled_without_tool)}`,
    `- ordinary follow-up preserved context: ${yesNo(report.evidence.ordinary_follow_up_preserved_context)}`,
    `- contextual artist recalled: ${yesNo(report.evidence.contextual_artist_recalled)}`,
    `- contextual album recalled: ${yesNo(report.evidence.contextual_album_recalled)}`,
    `- contextual music preserved context: ${yesNo(report.evidence.contextual_music_preserved_context)}`,
    `- reset near-misses preserved context: ${yesNo(report.evidence.reset_near_misses_preserved_context)}`,
    `- exact reset authorization observed: ${yesNo(report.evidence.exact_reset_authorization_observed)}`,
    `- exact reset completion observed: ${yesNo(report.evidence.exact_reset_completion_observed)}`,
    `- exact reset action observed: ${yesNo(report.evidence.exact_reset_action_observed)}`,
    `- fresh query could not recall prior fact: ${yesNo(report.evidence.fresh_query_could_not_recall_prior_fact)}`,
    `- owned activity removed: ${yesNo(report.cleanup.owned_activity_removed)}`,
    `- cleanup timed out: ${yesNo(report.cleanup.cleanup_timed_out)}`,
    `- pre-dispatch quiescence timeout: ${yesNo(report.timeouts.pre_dispatch_quiescence)}`,
    `- post-dispatch Server/model completion timeout: ${yesNo(report.timeouts.turn_completion)}`,
    `- instrumentation evidence only; human microphone, projector, and audibility acceptance required`,
  ].join("\n");
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, dependencies = {} } = {},
) {
  let options;
  try {
    options = parseSessionContinuityCliArgs(argv);
  } catch (error) {
    stderr.write(`${PROGRAM}: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    stderr.write(`${usage()}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    let report;
    if (options.mode === "self-check") {
      report = selfCheckReport();
    } else {
      await (dependencies.verifyDevice ?? verifyExplicitDevice)(options);
      report = await executeSessionContinuitySuite(options, dependencies);
    }
    stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${renderSessionContinuityReport(report)}\n`,
    );
    if (report.status === "pass") return 0;
    return report.status === "blocked" || report.status === "incomplete" ? 3 : 1;
  } catch (error) {
    const message =
      error instanceof SafeContinuityError
        ? error.publicMessage
        : "session continuity verification failed safely";
    stderr.write(`${PROGRAM}: ${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
