#!/usr/bin/env node

import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  collectInstalledServerIdentity,
  collectReadiness,
  loadExpectedServerIdentity,
  readAdminToken,
  verifyExplicitDevice,
} from "./agentic-release-smoke.mjs";
import {
  SERVER_PACKAGE_NAME,
  validateReleaseMetadataPath,
} from "./agentic-release-smoke-lib.mjs";
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
  FEATURE_FLAGS,
  OPERATIONAL_MARKERS,
  PACKAGES,
} from "./tier-a-symbols.mjs";

const PROGRAM = "speech-physical-smoke";
const SERVER_PACKAGE = SERVER_PACKAGE_NAME;
const PRELOADED_EXPECTED_IDENTITY = Symbol("preloaded expected Server identity");
const IRONMAN_PACKAGE = PACKAGES.ironman;
const FIXED_PROMPT = "In one short sentence, explain why the sky looks blue.";
const PROMPT_ACTIVITY_PATH = "/api/activity/prompts?limit=100";
const HTTP_STATUS_MARKER = "\n__PENUMBRA_SPEECH_HTTP_STATUS__:";
const BOUNDARY_TAG = "PenumbraSpeechSmoke";
const BOUNDARY_PATTERN =
  /^speech-smoke-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STOCK_NARRATION_FOCUS_CONTEXTS = new Set([
  "CentralActionHandler",
  "NarratorAccess.REQUEST_NARRATION",
]);
const MAX_CHILD_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const OBSERVATION_TIMEOUT_MS = 75_000;
const POLL_INTERVAL_MS = 500;

const SPEECH_TIMEOUT_FLAG =
  FEATURE_FLAGS.cloud.server_side_speech_synthesis_timeout_millis;
const STREAMING_SPEECH_FLAG =
  FEATURE_FLAGS.cloud.server_side_speech_synthesis_streaming_enabled;
const STREAMING_ASSISTANT_FLAG =
  FEATURE_FLAGS.cloud.synapse_bidirectional_streaming;

const HAND_TRACKING_HELD_MARKER =
  OPERATIONAL_MARKERS.hand_tracking_held_for_narration.value;
const NARRATION_START_WITHOUT_HAND_TRACKING_MARKER =
  OPERATIONAL_MARKERS.narration_start_without_hand_tracking.value;
const NARRATION_END_RELEASED_MARKER =
  OPERATIONAL_MARKERS.narration_end_released_hold.value;
const NARRATION_END_WITHOUT_HAND_TRACKING_MARKER =
  OPERATIONAL_MARKERS.narration_end_without_hand_tracking.value;
const STREAMING_SPEECH_FAILURE_RELEASED_MARKER =
  OPERATIONAL_MARKERS.streaming_speech_failure_released.value;
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

// These are the current fixed failure/lock responses emitted by the Rust
// agentic runtime and stock deadline. A physical speech pass must prove a
// substantive answer, not merely that Ironman spoke a safe fallback.
const NON_SUBSTANTIVE_RESPONSES = new Set([
  "I couldn't turn the verified result into a reliable spoken answer.",
  "I couldn't get a verified answer for that request.",
  "I couldn't finish that action because the required verified result was missing.",
  "I couldn't verify that action, so I won't claim it was completed.",
  "I couldn't get the verified information needed for that request.",
  "I need a little more information to complete that request.",
  "I couldn't finish that request in time. Please try again.",
  "The assistant service is unavailable right now. Please try again.",
  "The information service needed for that request is unavailable right now. Please try again.",
  "The information service returned an unusable result. Please try again.",
  "I got stuck while working on that request. Please try again.",
  "I couldn't verify the device information needed for that request. Please try again.",
  "The assistant service isn't configured for that request right now.",
  "I couldn't interpret that request reliably. Please rephrase it.",
  "Unlock your Pin to continue.",
  "I can't verify that your Pin is unlocked, so I can't safely use that assistant backend.",
]);

for (const fixture of [FIXED_PROMPT]) {
  if (
    Buffer.byteLength(fixture) > 256 ||
    /[`$\\\u0000-\u001f\u007f]/.test(fixture)
  ) {
    throw new Error("unsafe fixed speech fixture");
  }
}

export class SafeSpeechPhysicalError extends Error {
  constructor(publicMessage) {
    super(publicMessage);
    this.name = "SafeSpeechPhysicalError";
    this.publicMessage = publicMessage;
  }
}

function usage() {
  return [
    "Usage:",
    "  node platform/deploy/acceptance/pin/speech-physical-smoke.mjs --self-check [--json]",
    "  node platform/deploy/acceptance/pin/speech-physical-smoke.mjs --run --serial PIN_SERIAL --expected-pin-serial PIN_SERIAL --release-manifest PATH --release-receipts PATH [--json]",
    "",
    "Safety contract:",
    "  - Live mode accepts no prompt and injects one fixed harmless public question through Humane's stock transcript receiver.",
    "  - Live mode requires an exact operator-confirmed Pin serial plus canonical manifest and approved signer receipts for the installed Server identity.",
    `  - The expected Pin may use --expected-pin-serial or ${EXPECTED_PIN_SERIAL_ENV}.`,
    "  - The harness never installs packages or invokes PackageInstaller.",
    "  - Output contains only capability, branch, lifecycle, cleanup, and limitation booleans; no response text, credentials, identifiers, raw logs, or audio are emitted.",
    "  - Transcript injection verifies the post-ASR path. Human hearing is still required to claim subjective speaker audibility.",
  ].join("\n");
}

export function parseSpeechPhysicalCliArgs(argv, environment = process.env) {
  const options = {
    mode: null,
    serial: null,
    expectedPinSerial: null,
    adbPath: "adb",
    releaseManifestPath: null,
    releaseReceiptsPath: null,
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
  const next = (argument, index) => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    return value;
  };
  const takeUniqueValue = (key, argument, index) => {
    if (seenValueOptions.has(key)) {
      throw new Error(`${argument} may be specified only once`);
    }
    seenValueOptions.add(key);
    return next(argument, index);
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
        options.serial = takeUniqueValue("serial", argument, index);
        index += 1;
        break;
      case "--expected-pin-serial":
        options.expectedPinSerial = takeUniqueValue(
          "expected-pin-serial",
          argument,
          index,
        );
        index += 1;
        break;
      case "--adb":
        options.adbPath = takeUniqueValue("adb", argument, index);
        index += 1;
        break;
      case "--release-manifest":
        options.releaseManifestPath = takeUniqueValue(
          "release-manifest",
          argument,
          index,
        );
        index += 1;
        break;
      case "--release-receipts":
        options.releaseReceiptsPath = takeUniqueValue(
          "release-receipts",
          argument,
          index,
        );
        index += 1;
        break;
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
      options.releaseManifestPath !== null ||
      options.releaseReceiptsPath !== null
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
    throw new Error(
      "live speech smoke requires the exact operator-confirmed Pin serial",
    );
  }
  validateReleaseMetadataPath(options.releaseManifestPath, "--release-manifest");
  validateReleaseMetadataPath(options.releaseReceiptsPath, "--release-receipts");
  if (
    typeof options.adbPath !== "string" ||
    options.adbPath.length === 0 ||
    options.adbPath.includes("\0")
  ) {
    throw new Error("ADB executable path is required");
  }
  return options;
}

export function buildFixedTranscriptInjectionCommand() {
  return `am broadcast --user 0 -a hu.ma.ne.INJECT_TRANSCRIPTION -p ${IRONMAN_PACKAGE} --es transcription ${JSON.stringify(FIXED_PROMPT)} --ez vision false`;
}

export function buildSpeechLogcatCommand(boundaryMarker) {
  if (!BOUNDARY_PATTERN.test(boundaryMarker)) {
    throw new SafeSpeechPhysicalError("the speech evidence boundary was malformed");
  }
  return [
    "shell",
    "logcat",
    "-b",
    "main",
    "-b",
    "system",
    "-v",
    "epoch",
    "-d",
    `${BOUNDARY_TAG}:I`,
    "PenumbraHook:V",
    "PenumbraServer:V",
    "AudioFocusManager:V",
    "AudioTrack:V",
    "PenumbraTTS:V",
    "FeatureFlagServiceImpl:V",
    "*:S",
  ];
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function parseSpeechPromptActivityPage(value) {
  if (
    !plainObject(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 100
  ) {
    throw new SafeSpeechPhysicalError("the prompt activity page was malformed");
  }
  return value.items.map((item) => {
    if (
      !plainObject(item) ||
      !Number.isSafeInteger(item.id) ||
      item.id <= 0 ||
      typeof item.prompt !== "string" ||
      Buffer.byteLength(item.prompt) > 16 * 1024 ||
      !(
        item.response === null ||
        item.response === undefined ||
        (typeof item.response === "string" &&
          Buffer.byteLength(item.response) <= 64 * 1024)
      ) ||
      !(
        item.run_id === null ||
        item.run_id === undefined ||
        (typeof item.run_id === "string" && item.run_id.length <= 128)
      ) ||
      typeof item.is_vision !== "boolean" ||
      typeof item.created_at !== "string" ||
      !/^[0-9]{1,16}$/.test(item.created_at)
    ) {
      throw new SafeSpeechPhysicalError("the prompt activity page was malformed");
    }
    return item;
  });
}

function maximumId(rows) {
  return rows.reduce((maximum, row) => Math.max(maximum, row.id), 0);
}

function ownedRows(rows, baselineId, requestRunId) {
  if (!UUID_PATTERN.test(requestRunId ?? "")) return [];
  return rows.filter(
    (row) =>
      row.id > baselineId &&
      row.prompt === FIXED_PROMPT &&
      row.run_id === requestRunId &&
      row.is_vision === false,
  );
}

function terminalResponseIsSubstantive(response) {
  if (typeof response !== "string") return false;
  const trimmed = response.trim();
  if (trimmed.length === 0 || trimmed.startsWith("Action:")) return false;
  if (NON_SUBSTANTIVE_RESPONSES.has(trimmed)) return false;
  const normalized = trimmed.replaceAll("\u2019", "'");

  // Keep this deliberately conservative for the one public factual fixture.
  // These cover generic blanket failures without trying to judge arbitrary
  // model prose or exposing it in the report.
  return !(
    /^i (?:couldn't|could not|can't|cannot)\b/i.test(normalized) ||
    /^we (?:couldn't|could not|can't|cannot)\b.*\brequest\b/i.test(normalized) ||
    /^i (?:wasn't able|was not able|was unable|am unable)\b/i.test(normalized) ||
    /^(?:i(?:'m| am) sorry\b|sorry\b|something went wrong\b|unable to\b|no response\b|request failed\b|service unavailable\b)/i.test(
      normalized,
    ) ||
    /^unlock your pin\b/i.test(normalized) ||
    /^that request (?:couldn't|could not|can't|cannot)\b/i.test(normalized) ||
    /^(?:the )?(?:assistant|information) service\b.*(?:unavailable|isn't configured|is not configured)/i.test(
      normalized,
    ) ||
    /\bplease try again\.?$/i.test(normalized)
  );
}

function selectTerminalActivity(rows, baselineId, requestRunId) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(baselineId) || baselineId < 0) {
    throw new SafeSpeechPhysicalError("the prompt activity evidence was malformed");
  }
  const owned = ownedRows(rows, baselineId, requestRunId);
  const terminal = owned.filter(
    (row) =>
      typeof row.response === "string" &&
      row.response.trim().length > 0 &&
      !row.response.startsWith("Action:"),
  );
  const substantive = terminal.filter((row) =>
    terminalResponseIsSubstantive(row.response),
  );
  return {
    evidence: {
      fresh_activity_observed: owned.length > 0,
      unique_activity_observed: owned.length === 1,
      request_activity_correlated: owned.length === 1,
      terminal_activity_observed:
        owned.length === 1 && terminal.length === 1,
      substantive_terminal_observed:
        owned.length === 1 && substantive.length === 1,
      pass: owned.length === 1 && substantive.length === 1,
    },
    cleanupId: owned.length === 1 ? owned[0].id : null,
    requestRunId: owned.length === 1 ? requestRunId : null,
  };
}

export function evaluateTerminalSpeechActivity(rows, baselineId, requestRunId) {
  return selectTerminalActivity(rows, baselineId, requestRunId).evidence;
}

function taggedBoolean(value, expected) {
  return (
    plainObject(value) &&
    Object.keys(value).length === 2 &&
    value.type === "bool" &&
    value.value === expected
  );
}

function taggedPositiveInteger(value) {
  return (
    plainObject(value) &&
    Object.keys(value).length === 2 &&
    value.type === "int" &&
    Number.isSafeInteger(value.value) &&
    value.value > 0
  );
}

function flagFor(snapshot, key) {
  if (!Array.isArray(snapshot?.featureFlags?.flags)) return null;
  const matches = snapshot.featureFlags.flags.filter((flag) => flag?.key === key);
  return matches.length === 1 ? matches[0] : null;
}

function appliedBooleanFlag(snapshot, key) {
  const flag = flagFor(snapshot, key);
  return (
    taggedBoolean(flag?.desired_value, true) &&
    taggedBoolean(flag?.assignment_value, true)
  );
}

function appliedPositiveIntegerFlag(snapshot, key) {
  const flag = flagFor(snapshot, key);
  return (
    taggedPositiveInteger(flag?.desired_value) &&
    taggedPositiveInteger(flag?.assignment_value) &&
    flag.desired_value.value === flag.assignment_value.value
  );
}

export function evaluateSpeechPhysicalReadiness(snapshot, identity, expected) {
  const deliveryApplied =
    snapshot?.featureFlags?.delivery?.state === "stock_cache_applied" &&
    snapshot?.featureFlags?.delivery?.stock_cache_verified === true;
  const azure = snapshot?.settings?.azure_speech;
  const checks = {
    exact_server_identity:
      identity?.packageName === SERVER_PACKAGE &&
      identity?.packageName === expected?.packageName &&
      identity?.versionName === expected?.versionName &&
      identity?.versionCode === expected?.versionCode &&
      identity?.signerIdentity === expected?.signerIdentity &&
      snapshot?.health?.status === "ok" &&
      snapshot?.health?.version === expected?.versionName,
    authenticated_center:
      snapshot?.settings?.server?.admin_token_auth === true,
    no_restart_pending: snapshot?.settings?.restart_required === false,
    codex_ready:
      snapshot?.codex?.ready === true && snapshot?.codex?.state === "ready",
    azure_provider_configured:
      azure?.enabled === true &&
      azure?.cloud_consent_acknowledged === true &&
      azure?.has_subscription_key === true &&
      typeof azure?.region === "string" &&
      azure.region.length > 0 &&
      typeof azure?.voice_name === "string" &&
      azure.voice_name.length > 0,
    remote_speech_flags_applied:
      deliveryApplied &&
      appliedPositiveIntegerFlag(snapshot, SPEECH_TIMEOUT_FLAG) &&
      appliedBooleanFlag(snapshot, STREAMING_SPEECH_FLAG),
    streaming_assistant_flag_applied:
      deliveryApplied && appliedBooleanFlag(snapshot, STREAMING_ASSISTANT_FLAG),
  };
  return {
    checks,
    azure_remote_capability_ready:
      checks.azure_provider_configured && checks.remote_speech_flags_applied,
    pass: Object.values(checks).every(Boolean),
  };
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

function classifySpeechEvents(value, boundaryMarker) {
  if (!BOUNDARY_PATTERN.test(boundaryMarker)) {
    throw new SafeSpeechPhysicalError("the speech evidence boundary was malformed");
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text) > MAX_CHILD_STDOUT_BYTES) {
    throw new SafeSpeechPhysicalError("the speech evidence observation was too large");
  }
  let boundaryCount = 0;
  let boundaryObserved = false;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEpochLogcatLine(line);
    if (parsed === null) continue;
    if (parsed.tag === BOUNDARY_TAG && parsed.message === boundaryMarker) {
      boundaryCount += 1;
      boundaryObserved = true;
      events.length = 0;
      continue;
    }
    if (!boundaryObserved) continue;
    if (parsed.tag === "PenumbraHook") {
      if (narrationStart(parsed.message)) {
        events.push({ type: "narration_start", pid: parsed.pid });
      } else if (narrationEnd(parsed.message)) {
        events.push({ type: "narration_end", pid: parsed.pid });
      } else if (
        parsed.message.trim() === STREAMING_SPEECH_FAILURE_RELEASED_MARKER
      ) {
        events.push({ type: "playback_failure", pid: parsed.pid });
      }
      continue;
    }
    if (parsed.tag === "AudioFocusManager") {
      const match =
        /^(CentralActionHandler|NarratorAccess\.REQUEST_NARRATION) audio focus (granted|abandoned)$/.exec(
          parsed.message,
        );
      if (match !== null) {
        events.push({
          type: match[2] === "granted" ? "focus_granted" : "focus_abandoned",
          pid: parsed.pid,
          context: match[1],
        });
      }
      continue;
    }
    if (parsed.tag === "FeatureFlagServiceImpl") {
      if (`getFlagForKey: ${SPEECH_TIMEOUT_FLAG}` === parsed.message) {
        events.push({ type: "timeout_flag_read", pid: parsed.pid });
      } else if (`getFlagForKey: ${STREAMING_SPEECH_FLAG}` === parsed.message) {
        events.push({ type: "streaming_flag_read", pid: parsed.pid });
      }
      continue;
    }
    if (parsed.tag === "PenumbraTTS") {
      if (/^id=[0-9]+ tts playbackStart(?:\s|$)/.test(parsed.message)) {
        events.push({ type: "local_tts_start", pid: parsed.pid });
      } else if (/^id=[0-9]+ tts done(?:\s|$)/.test(parsed.message)) {
        events.push({ type: "local_tts_done", pid: parsed.pid });
      }
      continue;
    }
    if (parsed.tag === "AudioTrack") {
      const match =
        /^stop\([0-9]+\): called with ([0-9]+) frames delivered$/.exec(
          parsed.message,
        );
      if (match !== null) {
        const frames = Number(match[1]);
        if (Number.isSafeInteger(frames) && frames > 0) {
          events.push({ type: "audio_frames", pid: parsed.pid });
        }
      }
      continue;
    }
    if (parsed.tag === "PenumbraServer") {
      const request = STREAMING_UNDERSTAND_REQUEST_UUID_RE.exec(parsed.message);
      if (request !== null) {
        // The UUID is retained only inside this process long enough to bind
        // stock request, Center activity, and cleanup. It is never returned
        // by an exported evaluator or written to either output stream.
        events.push({
          type: "assistant_request",
          pid: parsed.pid,
          runId: request[1],
        });
      } else if (
        parsed.message === STREAMING_UNDERSTAND_COMPLETED_LOG
      ) {
        events.push({ type: "final_observation", pid: parsed.pid });
      }
    }
  }
  if (!boundaryObserved || boundaryCount !== 1) {
    throw new SafeSpeechPhysicalError(
      "the fresh speech evidence boundary was unavailable",
    );
  }
  return events;
}

function firstIndex(events, type, start = 0, end = events.length) {
  for (let index = Math.max(0, start); index < Math.min(end, events.length); index += 1) {
    if (events[index].type === type) return index;
  }
  return -1;
}

function lastIndex(events, type, start = events.length - 1) {
  for (let index = Math.min(start, events.length - 1); index >= 0; index -= 1) {
    if (events[index].type === type) return index;
  }
  return -1;
}

function selectSpeechLogEvidence(
  value,
  boundaryMarker,
  ironmanPid,
  { azureRemoteCapabilityReady = true } = {},
) {
  if (!Number.isSafeInteger(ironmanPid) || ironmanPid <= 0) {
    throw new SafeSpeechPhysicalError("the Ironman process evidence was malformed");
  }
  const events = classifySpeechEvents(value, boundaryMarker);
  const finalIndexes = events
    .map((event, index) => (event.type === "final_observation" ? index : -1))
    .filter((index) => index >= 0);
  const finalIndex = finalIndexes.length === 1 ? finalIndexes[0] : -1;
  const requestIndexes = events
    .map((event, index) => (event.type === "assistant_request" ? index : -1))
    .filter((index) => index >= 0);
  const requestIndex = requestIndexes.length === 1 ? requestIndexes[0] : -1;
  const requestRunId = requestIndex >= 0 ? events[requestIndex].runId : null;
  const serverRequestFinalCorrelated =
    requestIndex >= 0 &&
    finalIndex >= 0 &&
    requestIndex < finalIndex &&
    events[requestIndex].pid === events[finalIndex].pid;
  const endIndex = finalIndex >= 0
    ? lastIndex(events, "narration_end", finalIndex - 1)
    : -1;
  const previousEndIndex = endIndex >= 0
    ? lastIndex(events, "narration_end", endIndex - 1)
    : -1;
  const candidateStartIndex = endIndex >= 0
    ? lastIndex(events, "narration_start", endIndex - 1)
    : -1;
  // A prior progress cue may have its own complete narration lifecycle. Do
  // not let its start, focus, or frames satisfy a terminal narration whose
  // start marker is missing.
  const startIndex = candidateStartIndex > previousEndIndex
    ? candidateStartIndex
    : -1;
  const grantIndex = startIndex >= 0 && endIndex >= 0
    ? events.findIndex(
        (event, index) =>
          index > startIndex &&
          index < endIndex &&
          event.type === "focus_granted" &&
          event.pid === ironmanPid &&
          STOCK_NARRATION_FOCUS_CONTEXTS.has(event.context),
      )
    : -1;
  const grantContext = grantIndex >= 0 ? events[grantIndex].context : null;
  const abandonIndex = endIndex >= 0 && finalIndex >= 0
    ? events.findIndex(
        (event, index) =>
          index > endIndex &&
          index < finalIndex &&
          event.type === "focus_abandoned" &&
          event.pid === ironmanPid &&
          event.context === grantContext,
      )
    : -1;
  const prematureAbandonIndex = grantIndex >= 0 && endIndex >= 0
    ? events.findIndex(
        (event, index) =>
          index > grantIndex &&
          index < endIndex &&
          event.type === "focus_abandoned" &&
          event.pid === ironmanPid &&
          event.context === grantContext,
      )
    : -1;
  const frameWindowEnd = endIndex >= 0 ? endIndex : 0;
  const remoteFramesIndex = grantIndex >= 0
    ? events.findIndex(
        (event, index) =>
          index > grantIndex &&
          index < frameWindowEnd &&
          event.type === "audio_frames" &&
          event.pid === ironmanPid,
      )
    : -1;
  const timeoutReadIndex = grantIndex >= 0 && remoteFramesIndex >= 0
    ? firstIndex(events, "timeout_flag_read", grantIndex + 1, remoteFramesIndex)
    : -1;
  const streamingReadIndex = grantIndex >= 0 && remoteFramesIndex >= 0
    ? firstIndex(events, "streaming_flag_read", grantIndex + 1, remoteFramesIndex)
    : -1;

  const localStartIndex = startIndex >= 0 && endIndex >= 0
    ? firstIndex(events, "local_tts_start", startIndex + 1, endIndex)
    : -1;
  const localPid = localStartIndex >= 0 ? events[localStartIndex].pid : null;
  const localFramesIndex = localStartIndex >= 0 && endIndex >= 0
    ? events.findIndex(
        (event, index) =>
          index > localStartIndex &&
          index < endIndex &&
          event.type === "audio_frames" &&
          event.pid === localPid,
      )
    : -1;
  const localDoneIndex = localStartIndex >= 0 && endIndex >= 0
    ? events.findIndex(
        (event, index) =>
          index > localStartIndex &&
          index < endIndex &&
          event.type === "local_tts_done" &&
          event.pid === localPid,
      )
    : -1;
  const localTtsMarkerObserved = startIndex >= 0 && endIndex >= 0 &&
    (firstIndex(events, "local_tts_start", startIndex + 1, endIndex) >= 0 ||
      firstIndex(events, "local_tts_done", startIndex + 1, endIndex) >= 0);
  const playbackFailureObserved =
    firstIndex(events, "playback_failure", Math.max(0, startIndex), finalIndex >= 0 ? finalIndex : events.length) >= 0;
  const localBranchObserved =
    localStartIndex >= 0 && localFramesIndex >= 0 && localDoneIndex >= 0;
  const remotePlaybackObserved =
    remoteFramesIndex >= 0 && timeoutReadIndex >= 0 && streamingReadIndex >= 0;
  const branchAmbiguous = remotePlaybackObserved && localTtsMarkerObserved;
  const remoteBranchObserved =
    azureRemoteCapabilityReady === true &&
    remotePlaybackObserved &&
    !localTtsMarkerObserved &&
    !playbackFailureObserved;
  const localFallbackObserved =
    azureRemoteCapabilityReady === true &&
    localBranchObserved &&
    !remotePlaybackObserved;
  const narrationStarted =
    requestIndex >= 0 &&
    requestIndex < startIndex &&
    startIndex >= 0 &&
    events[startIndex].pid === ironmanPid;
  const narrationEnded =
    narrationStarted && endIndex >= 0 && events[endIndex].pid === ironmanPid;
  const focusGranted =
    narrationStarted &&
    grantIndex >= 0 &&
    events[grantIndex].pid === ironmanPid &&
    STOCK_NARRATION_FOCUS_CONTEXTS.has(grantContext) &&
    prematureAbandonIndex < 0;
  const focusReleased =
    focusGranted && narrationEnded && abandonIndex >= 0;
  const finalObservationObserved =
    focusReleased && finalIndex >= 0 && serverRequestFinalCorrelated;
  const audioTrackFramesObserved = remoteBranchObserved || localBranchObserved;
  // Distinguish TTS frame delivery from subjective human audibility.
  // AudioTrack stop with delivered frames proves the TTS/audio pipeline
  // produced output. Human audibility remains a physical-acceptance
  // observation that automation cannot claim.
  const ttsFramesDelivered = audioTrackFramesObserved;
  const humanAudibilityConfirmed = false;

  // Distinguish transcript injection from microphone ASR. The harness
  // injects a fixed prompt via stock broadcast (post-ASR path). No ASR
  // events are captured in the logcat filter; absence of microphone
  // input is structural to the harness, not inferred from log content.
  const transcriptInjectionPath =
    requestIndex >= 0 && requestIndex < startIndex;
  const microphoneAsrBypassed = true;

  // Distinguish stock narration lifecycle from projector presentation.
  // The harness observes narration start/end holds and audio focus, not
  // projector state. Projector absence is structural to the harness.
  const narrationLifecycleObserved = narrationStarted && narrationEnded;
  const projectorNotInPath = true;

  // Bounded focus/cue cancellation: focus granted then abandoned within
  // the expected narration window, with no premature abandonment before
  // narration end.
  const focusCancellationBounded =
    focusGranted && focusReleased && prematureAbandonIndex < 0;
  const cueCancellationBounded =
    narrationLifecycleObserved &&
    focusCancellationBounded &&
    prematureAbandonIndex < 0;

  const evidence = {
    fresh_boundary_observed: true,
    assistant_request_observed: requestIndex >= 0 && requestIndex < startIndex,
    server_request_final_correlated: serverRequestFinalCorrelated,
    narration_start_observed: narrationStarted,
    narration_end_observed: narrationEnded,
    audio_focus_granted: focusGranted,
    audio_track_frames_observed: audioTrackFramesObserved,
    audio_focus_released: focusReleased,
    final_observation_observed: finalObservationObserved,
    remote_branch_observed: remoteBranchObserved,
    local_fallback_observed: localFallbackObserved,
    branch_ambiguous: branchAmbiguous,
    playback_failure_observed: playbackFailureObserved,
    transcript_injection_path: transcriptInjectionPath,
    microphone_asr_bypassed: microphoneAsrBypassed,
    tts_frames_delivered: ttsFramesDelivered,
    human_audibility_confirmed: humanAudibilityConfirmed,
    narration_lifecycle_observed: narrationLifecycleObserved,
    projector_not_in_path: projectorNotInPath,
    focus_cancellation_bounded: focusCancellationBounded,
    cue_cancellation_bounded: cueCancellationBounded,
    pass:
      narrationStarted &&
      narrationEnded &&
      focusGranted &&
      focusReleased &&
      finalObservationObserved &&
      serverRequestFinalCorrelated &&
      remoteBranchObserved &&
      !branchAmbiguous &&
      !playbackFailureObserved,
  };
  return {
    evidence,
    requestRunId: UUID_PATTERN.test(requestRunId ?? "") ? requestRunId : null,
  };
}

export function evaluateSpeechLogEvidence(
  value,
  boundaryMarker,
  ironmanPid,
  options = {},
) {
  return selectSpeechLogEvidence(
    value,
    boundaryMarker,
    ironmanPid,
    options,
  ).evidence;
}

function parsePidSet(value) {
  const text = Buffer.isBuffer(value) ? value.toString("ascii") : String(value);
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (!/^[0-9]+(?:\s+[0-9]+)*$/.test(trimmed)) {
    throw new SafeSpeechPhysicalError("a package process observation was malformed");
  }
  return [...new Set(trimmed.split(/\s+/).map(Number))].sort((a, b) => a - b);
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
      rejectPromise(
        new SafeSpeechPhysicalError("could not start a required local process"),
      );
      return;
    }
    const stdout = [];
    let stdoutBytes = 0;
    let settled = false;
    let inputBuffer = input === null
      ? null
      : Buffer.isBuffer(input)
        ? input
        : Buffer.from(input);
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
      finish(() => rejectPromise(new SafeSpeechPhysicalError(message)));
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
    throw new SafeSpeechPhysicalError(publicFailure);
  }
  return completed.stdout;
}

function curlConfig(path, method, token) {
  const allowedGet = method === "GET" && path === PROMPT_ACTIVITY_PATH;
  const allowedDelete =
    method === "DELETE" && /^\/api\/activity\/prompts\/[1-9][0-9]*$/.test(path);
  if (!allowedGet && !allowedDelete) {
    throw new SafeSpeechPhysicalError("refusing a non-allowlisted Center endpoint");
  }
  return Buffer.from(
    [
      `url = "http://127.0.0.1:8080${path}"`,
      `request = "${method}"`,
      `header = "Authorization: Bearer ${token}"`,
      'header = "Accept: application/json"',
      'header = "User-Agent: penumbra-speech-physical-smoke/1"',
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
      input: curlConfig(path, method, token),
      timeoutMs: 40_000,
      maxStdoutBytes: MAX_CHILD_STDOUT_BYTES,
    },
    "a fixed Center activity request failed",
  );
  const marker = Buffer.from(HTTP_STATUS_MARKER, "utf8");
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new SafeSpeechPhysicalError("a fixed Center response was malformed");
  }
  const status = output
    .subarray(markerIndex + marker.length)
    .toString("ascii")
    .trim();
  const body = output.subarray(0, markerIndex);
  if (method === "DELETE") {
    if (status !== "204" && status !== "404") {
      throw new SafeSpeechPhysicalError("test activity cleanup was rejected");
    }
    return null;
  }
  if (
    status !== "200" ||
    body.length === 0 ||
    body.length > MAX_HTTP_BODY_BYTES
  ) {
    throw new SafeSpeechPhysicalError(
      "a fixed Center activity response was unavailable",
    );
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new SafeSpeechPhysicalError(
      "a fixed Center activity response was malformed",
    );
  }
}

class SpeechPhysicalDevice {
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
    return parseSpeechPromptActivityPage(
      await deviceActivityRequest(
        this.options,
        this.token,
        PROMPT_ACTIVITY_PATH,
      ),
    );
  }

  async deletePrompt(id) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new SafeSpeechPhysicalError("invalid cleanup row");
    }
    await deviceActivityRequest(
      this.options,
      this.token,
      `/api/activity/prompts/${id}`,
      "DELETE",
    );
  }

  async ironmanPids() {
    const completed = await captureChild(
      this.options.adbPath,
      ["-s", this.options.serial, "shell", "pidof", IRONMAN_PACKAGE],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
    );
    if (completed.code === 1 && completed.stdout.length === 0) return [];
    if (completed.code !== 0) {
      throw new SafeSpeechPhysicalError(
        "the Ironman process observation failed",
      );
    }
    return parsePidSet(completed.stdout);
  }

  async beginBoundary() {
    const marker = `speech-smoke-${randomUUID()}`;
    await runAdb(
      this.options,
      ["shell", "log", "-p", "i", "-t", BOUNDARY_TAG, marker],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
      "the speech evidence boundary could not be created",
    );
    return marker;
  }

  async inject() {
    await runAdb(
      this.options,
      ["shell", buildFixedTranscriptInjectionCommand()],
      { timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 },
      "the fixed transcript injection failed",
    );
  }

  async speechLog(boundaryMarker) {
    return runAdb(
      this.options,
      buildSpeechLogcatCommand(boundaryMarker),
      { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
      "the speech evidence observation failed",
    );
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function pollUntil(timeoutMs, observe) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    latest = await observe();
    if (latest.done) return latest;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return latest ?? { done: false, value: null };
}

function identityMatches(identity, expected) {
  return (
    expected?.packageName === SERVER_PACKAGE &&
    identity?.packageName === expected.packageName &&
    identity?.versionName === expected.versionName &&
    identity?.versionCode === expected.versionCode &&
    identity?.signerIdentity === expected.signerIdentity
  );
}

function runtimeOptionsAreExact(options) {
  try {
    return (
      exactDeviceTargetMatches(options?.serial, options?.expectedPinSerial) &&
      validateReleaseMetadataPath(
        options?.releaseManifestPath,
        "--release-manifest",
      ) === options.releaseManifestPath &&
      validateReleaseMetadataPath(
        options?.releaseReceiptsPath,
        "--release-receipts",
      ) === options.releaseReceiptsPath &&
      typeof options?.adbPath === "string" &&
      options.adbPath.length > 0 &&
      !options.adbPath.includes("\0")
    );
  } catch {
    return false;
  }
}

function blockedReport(exactIdentity) {
  return {
    schema_version: 1,
    mode: "stock_remote_speech_physical",
    status: "blocked",
    prerequisites: {
      exact_server_identity: exactIdentity,
      authenticated_center: false,
      no_restart_pending: false,
      codex_ready: false,
      azure_provider_configured: false,
      remote_speech_flags_applied: false,
      streaming_assistant_flag_applied: false,
    },
    azure_remote_capability_ready: false,
    evidence: null,
    cleanup: {
      fixed_prompt_activity_removed: null,
      media_volume_snapshot_captured: null,
      media_volume_restored: null,
    },
    limitations: [
      "post_asr_injection_only",
      "speaker_audibility_requires_human_confirmation",
      "projector_not_observed",
      "azure_branch_inferred_from_configured_exclusive_service_and_stock_remote_playback",
      "tts_frames_delivered_is_not_human_audibility",
      "microphone_asr_bypass_is_structural_not_inferred",
    ],
  };
}

export async function executeSpeechPhysicalSmoke(options, dependencies = {}) {
  if (!runtimeOptionsAreExact(options)) {
    throw new SafeSpeechPhysicalError(
      "speech physical runtime identity was incomplete",
    );
  }
  let expected;
  try {
    expected =
      dependencies[PRELOADED_EXPECTED_IDENTITY] ??
      (await (dependencies.loadExpectedServerIdentity ?? loadExpectedServerIdentity)(
        options,
      ));
  } catch {
    throw new SafeSpeechPhysicalError("refusing unverified release metadata");
  }
  const identity =
    dependencies.identity ?? (await collectInstalledServerIdentity(options));
  if (!identityMatches(identity, expected)) return blockedReport(false);

  const token = dependencies.token ?? (await readAdminToken());
  const snapshot =
    dependencies.snapshot ?? (await collectReadiness(options, token));
  const readiness = evaluateSpeechPhysicalReadiness(snapshot, identity, expected);
  if (!readiness.pass) {
    return {
      ...blockedReport(readiness.checks.exact_server_identity),
      prerequisites: readiness.checks,
      azure_remote_capability_ready:
        readiness.azure_remote_capability_ready,
    };
  }

  const device = dependencies.device ?? new SpeechPhysicalDevice(options, token);
  const initialPids = await device.ironmanPids();
  if (initialPids.length !== 1) {
    return {
      ...blockedReport(true),
      prerequisites: readiness.checks,
      azure_remote_capability_ready: readiness.azure_remote_capability_ready,
    };
  }
  const ironmanPid = initialPids[0];
  const baselineRows = await device.promptRows();
  const baselineId = maximumId(baselineRows);
  const boundaryMarker = await device.beginBoundary();
  const mediaVolumeSnapshot = await captureStableMediaVolumeSnapshot(device);
  let mediaVolumeRestored = false;
  let cleanupCandidate = null;
  let cleanupOwnershipAmbiguous = false;
  let cleanupRemoved = false;
  let collected = null;
  let executionError = null;

  const rememberCleanupCandidate = (selection) => {
    if (
      selection.cleanupId === null ||
      !UUID_PATTERN.test(selection.requestRunId ?? "")
    ) {
      return;
    }
    const candidate = {
      id: selection.cleanupId,
      requestRunId: selection.requestRunId,
    };
    if (cleanupCandidate === null) {
      if (cleanupOwnershipAmbiguous) return;
      cleanupCandidate = candidate;
      return;
    }
    if (
      cleanupCandidate.id !== candidate.id ||
      cleanupCandidate.requestRunId !== candidate.requestRunId
    ) {
      // Two different candidates means ownership is ambiguous. Refuse every
      // deletion rather than selecting whichever observation happened last.
      cleanupCandidate = null;
      cleanupOwnershipAmbiguous = true;
    }
  };

  const collectEvidence = async () => {
    const [rows, logValue, currentPids] = await Promise.all([
      device.promptRows(),
      device.speechLog(boundaryMarker),
      device.ironmanPids(),
    ]);
    const speechSelection = selectSpeechLogEvidence(
      logValue,
      boundaryMarker,
      ironmanPid,
      {
        azureRemoteCapabilityReady:
          readiness.azure_remote_capability_ready,
      },
    );
    const activity = selectTerminalActivity(
      rows,
      baselineId,
      speechSelection.requestRunId,
    );
    rememberCleanupCandidate(activity);
    const processStable =
      currentPids.length === 1 && currentPids[0] === ironmanPid;
    return {
      pass:
        activity.evidence.pass &&
        speechSelection.evidence.pass &&
        processStable,
      activity,
      speech: speechSelection.evidence,
      processStable,
      rows,
    };
  };

  const discoverCleanupCandidate = async () => {
    if (cleanupCandidate !== null || cleanupOwnershipAmbiguous) return;
    try {
      const [rows, logValue] = await Promise.all([
        device.promptRows(),
        device.speechLog(boundaryMarker),
      ]);
      const speechSelection = selectSpeechLogEvidence(
        logValue,
        boundaryMarker,
        ironmanPid,
        {
          azureRemoteCapabilityReady:
            readiness.azure_remote_capability_ready,
        },
      );
      rememberCleanupCandidate(
        selectTerminalActivity(
          rows,
          baselineId,
          speechSelection.requestRunId,
        ),
      );
    } catch {
      // Cleanup is best effort, but deletion is never attempted without the
      // same correlated request/activity proof required on the main path.
    }
  };

  const removeOwnedActivity = async () => {
    if (cleanupCandidate === null || cleanupOwnershipAmbiguous) return false;
    try {
      // Re-read immediately before DELETE. This closes the gap between an
      // earlier observation and mutation and prevents deleting a changed row.
      const beforeRows = await device.promptRows();
      const stillOwned = ownedRows(
        beforeRows,
        baselineId,
        cleanupCandidate.requestRunId,
      );
      if (
        stillOwned.length !== 1 ||
        stillOwned[0].id !== cleanupCandidate.id
      ) {
        return false;
      }
      await device.deletePrompt(cleanupCandidate.id);
      const remainingRows = await device.promptRows();
      return (
        !remainingRows.some((row) => row.id === cleanupCandidate.id) &&
        ownedRows(
          remainingRows,
          baselineId,
          cleanupCandidate.requestRunId,
        ).length === 0
      );
    } catch {
      return false;
    }
  };

  try {
    await device.inject();
    const observation = await (dependencies.pollUntil ?? pollUntil)(
      OBSERVATION_TIMEOUT_MS,
      async () => {
        const value = await collectEvidence();
        return { done: value.pass, value };
      },
    );
    collected = observation.value;
    if (observation.done) {
      await sleep(500);
      collected = await collectEvidence();
    }
    if (collected === null || collected === undefined) {
      throw new SafeSpeechPhysicalError(
        "speech evidence collection did not complete",
      );
    }
  } catch (error) {
    executionError = error;
  } finally {
    await discoverCleanupCandidate();
    cleanupRemoved = await removeOwnedActivity();
    mediaVolumeRestored = await restoreMediaVolumeSnapshot(
      device,
      mediaVolumeSnapshot,
    );
  }

  if (executionError !== null) throw executionError;

  // Session continuity: process stable and request/final correlated.
  const sessionContinuityMaintained =
    collected.processStable &&
    collected.speech.server_request_final_correlated &&
    collected.activity.evidence.request_activity_correlated;

  const evidence = {
    fresh_boundary_observed: collected.speech.fresh_boundary_observed,
    assistant_request_observed:
      collected.speech.assistant_request_observed,
    server_request_final_correlated:
      collected.speech.server_request_final_correlated,
    request_activity_correlated:
      collected.activity.evidence.request_activity_correlated,
    terminal_activity_observed:
      collected.activity.evidence.terminal_activity_observed,
    substantive_terminal_observed:
      collected.activity.evidence.substantive_terminal_observed,
    narration_start_observed: collected.speech.narration_start_observed,
    narration_end_observed: collected.speech.narration_end_observed,
    audio_focus_granted: collected.speech.audio_focus_granted,
    audio_track_frames_observed:
      collected.speech.audio_track_frames_observed,
    audio_focus_released: collected.speech.audio_focus_released,
    final_observation_observed:
      collected.speech.final_observation_observed,
    remote_branch_observed: collected.speech.remote_branch_observed,
    local_fallback_observed: collected.speech.local_fallback_observed,
    branch_ambiguous: collected.speech.branch_ambiguous,
    playback_failure_observed:
      collected.speech.playback_failure_observed,
    ironman_process_stable: collected.processStable,
    transcript_injection_path:
      collected.speech.transcript_injection_path,
    microphone_asr_bypassed:
      collected.speech.microphone_asr_bypassed,
    tts_frames_delivered:
      collected.speech.tts_frames_delivered,
    human_audibility_confirmed:
      collected.speech.human_audibility_confirmed,
    narration_lifecycle_observed:
      collected.speech.narration_lifecycle_observed,
    projector_not_in_path:
      collected.speech.projector_not_in_path,
    focus_cancellation_bounded:
      collected.speech.focus_cancellation_bounded,
    cue_cancellation_bounded:
      collected.speech.cue_cancellation_bounded,
    session_continuity_maintained:
      sessionContinuityMaintained,
  };
  const pass = collected.pass && cleanupRemoved && mediaVolumeRestored;
  return {
    schema_version: 1,
    mode: "stock_remote_speech_physical",
    status: pass ? "pass" : "incomplete",
    prerequisites: readiness.checks,
    azure_remote_capability_ready:
      readiness.azure_remote_capability_ready,
    evidence,
    cleanup: {
      fixed_prompt_activity_removed: cleanupRemoved,
      media_volume_snapshot_captured: true,
      media_volume_restored: mediaVolumeRestored,
    },
    limitations: [
      "post_asr_injection_only",
      "speaker_audibility_requires_human_confirmation",
      "projector_not_observed",
      "azure_branch_inferred_from_configured_exclusive_service_and_stock_remote_playback",
      "tts_frames_delivered_is_not_human_audibility",
      "microphone_asr_bypass_is_structural_not_inferred",
    ],
  };
}

function selfCheckReport() {
  const boundaryMarker =
    "speech-smoke-123e4567-e89b-42d3-a456-426614174000";
  const requestRunId =
    "223e4567-e89b-42d3-a456-426614174000";
  const logValue = [
    `1710000000.000  100  101 I ${BOUNDARY_TAG}: ${boundaryMarker}`,
    `1710000000.001  4000  101 W PenumbraServer: ${STREAMING_UNDERSTAND_REQUEST_LOG_PREFIX} run_id=${requestRunId}`,
    `1710000000.002  3152  101 W PenumbraHook: ${NARRATION_START_WITHOUT_HAND_TRACKING_MARKER} | sessionArmed=false`,
    "1710000000.003  3152  101 D AudioFocusManager: CentralActionHandler audio focus granted",
    `1710000000.004  1619  101 D FeatureFlagServiceImpl: getFlagForKey: ${SPEECH_TIMEOUT_FLAG}`,
    `1710000000.005  1619  101 D FeatureFlagServiceImpl: getFlagForKey: ${STREAMING_SPEECH_FLAG}`,
    "1710000000.006  3152  101 D AudioTrack: stop(53): called with 51264 frames delivered",
    `1710000000.007  3152  101 W PenumbraHook: ${NARRATION_END_WITHOUT_HAND_TRACKING_MARKER} | sessionArmed=false`,
    "1710000000.008  3152  101 D AudioFocusManager: CentralActionHandler audio focus abandoned",
    `1710000000.009  4000  101 W PenumbraServer: ${STREAMING_UNDERSTAND_COMPLETED_LOG}`,
  ].join("\n");
  const speech = evaluateSpeechLogEvidence(
    logValue,
    boundaryMarker,
    3152,
  );
  const activity = evaluateTerminalSpeechActivity(
    [
      {
        id: 2,
        run_id: requestRunId,
        prompt: FIXED_PROMPT,
        response: "PRIVATE_RESPONSE_MUST_NOT_ESCAPE",
        is_vision: false,
        created_at: "1710000000",
      },
    ],
    1,
    requestRunId,
  );
  return {
    schema_version: 1,
    mode: "self_check",
    status: speech.pass && activity.pass ? "pass" : "fail",
    checks: {
      fixed_prompt_only: true,
      fresh_boundary: speech.fresh_boundary_observed,
      assistant_request: speech.assistant_request_observed,
      ordered_stock_narration: speech.pass,
      terminal_activity: activity.pass,
      output_is_boolean_only: true,
      transcript_injection_path: speech.transcript_injection_path,
      microphone_asr_bypassed: speech.microphone_asr_bypassed,
      tts_frames_delivered: speech.tts_frames_delivered,
      human_audibility_confirmed: speech.human_audibility_confirmed,
      narration_lifecycle_observed: speech.narration_lifecycle_observed,
      projector_not_in_path: speech.projector_not_in_path,
      focus_cancellation_bounded: speech.focus_cancellation_bounded,
      cue_cancellation_bounded: speech.cue_cancellation_bounded,
    },
  };
}

function writeReport(report, stream, json) {
  if (json) {
    stream.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  stream.write(`${PROGRAM}: ${report.status}\n`);
  for (const [key, value] of Object.entries(report.prerequisites ?? report.checks ?? {})) {
    stream.write(`  ${key}: ${value === true ? "yes" : value === false ? "no" : "n/a"}\n`);
  }
  for (const [key, value] of Object.entries(report.evidence ?? {})) {
    stream.write(`  ${key}: ${value === true ? "yes" : value === false ? "no" : "n/a"}\n`);
  }
}

export async function main(
  argv = process.argv.slice(2),
  dependencies = {},
  stdout = process.stdout,
  stderr = process.stderr,
) {
  let options;
  try {
    options = parseSpeechPhysicalCliArgs(argv);
  } catch (error) {
    stderr.write(`${PROGRAM}: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    stderr.write(`${usage()}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.mode === "self-check") {
    const report = selfCheckReport();
    writeReport(report, stdout, options.json);
    return report.status === "pass" ? 0 : 1;
  }
  try {
    let expectedIdentity;
    try {
      expectedIdentity = await (
        dependencies.loadExpectedServerIdentity ?? loadExpectedServerIdentity
      )(options);
    } catch {
      throw new SafeSpeechPhysicalError("refusing unverified release metadata");
    }
    await (dependencies.verifyDevice ?? verifyExplicitDevice)(options);
    const report = await executeSpeechPhysicalSmoke(options, {
      ...dependencies,
      [PRELOADED_EXPECTED_IDENTITY]: expectedIdentity,
    });
    writeReport(report, stdout, options.json);
    return report.status === "pass" ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof SafeSpeechPhysicalError
        ? error.publicMessage
        : "speech physical smoke failed safely";
    stderr.write(`${PROGRAM}: ${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
