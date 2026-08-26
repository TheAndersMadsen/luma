#!/usr/bin/env node

import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect as connectHttp2, constants as http2Constants } from "node:http2";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import {
  GrpcFrameDecoder,
  RELEASE_IDENTITY,
  decodeProtoFields,
  encodeProtoBytes,
  encodeProtoString,
  encodeProtoVarint,
  parseLoopbackGrpcPort,
  validateSerial,
  wrapGrpcFrame,
} from "./agentic-release-smoke-lib.mjs";
import {
  collectFixedMusicRankOne,
  collectInstalledServerIdentity,
  collectReadiness,
  openAdbShellAibusTunnel,
  readAdminToken,
  verifyExplicitDevice,
} from "./agentic-release-smoke.mjs";
import {
  AUDIO_DUMP_ADB_ARGS,
  MEDIA_VOLUME_GET_ADB_ARGS,
  buildMediaVolumeSetAdbArgs,
  captureStableMediaVolumeSnapshot,
  parseMediaVolumeSnapshot,
  restoreMediaVolumeSnapshot,
} from "./media-volume-state-guard.mjs";
import {
  FEATURE_FLAGS,
  NATIVE_ACTIONS,
  OPERATIONAL_MARKERS,
  PACKAGES,
  PROTO_KIDS,
  RPC_PATHS,
} from "./tier-a-symbols.mjs";

const PROGRAM = "physical-prompt-harness";
const SERVER_PACKAGE = "com.penumbraos.server";
const IRONMAN_PACKAGE = PACKAGES.ironman;
const MUSIC_PACKAGE = PACKAGES.music;
const TICKLE_PACKAGE = PACKAGES.tickle;
const TICKLE_ACTIVITY =
  `${PACKAGES.tickle}/humaneinternal.system.ipc.HumaneExperienceActivity`;
const MAX_CHILD_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const HTTP_STATUS_MARKER = "\n__PENUMBRA_PHYSICAL_HTTP_STATUS__:";
const PROMPT_ACTIVITY_PATH = "/api/activity/prompts?limit=100";
const MUSIC_ACTIVITY_PATH = "/api/activity/music?limit=100";
const MUSIC_STABILITY_WINDOW_MS = 1_500;
const LOADING_REQUEST_KID = PROTO_KIDS.loading_message_request;
const LOADING_RESPONSE_KID = PROTO_KIDS.loading_message_response;
const LOADING_RPC_PATH = RPC_PATHS.aibus_encrypted_loading_message;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const HOOK_BOUNDARY_TAG = "PenumbraPhysicalHarness";
const HOOK_LOG_TAG = "PenumbraHook";
const SERVER_LOG_TAG = "PenumbraServer";
const PHYSICAL_NATIVE_ACTIONS = new Set([
  NATIVE_ACTIONS.GET_CURRENT_TIME,
  NATIVE_ACTIONS.GET_BATTERY_LEVEL,
  NATIVE_ACTIONS.PAUSE_MUSIC,
  NATIVE_ACTIONS.TICKLE,
]);
const PHYSICAL_NATIVE_ACTION_MARKER =
  `${OPERATIONAL_MARKERS.native_action_for_physical_verification.value} | action=`;
const HOOK_BOUNDARY_PATTERN = /^physical-simple-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROGRESS_BOUNDARY_PATTERN = /^physical-loading-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENTIC_BOUNDARY_PATTERN = /^physical-agentic-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENTIC_CORRELATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENTIC_TRACE_MESSAGE =
  OPERATIONAL_MARKERS.agentic_physical_trace.value;
const LOCAL_WEATHER_TRACE_MESSAGE =
  OPERATIONAL_MARKERS.local_weather_physical_trace.value;
const REGEXP_META = /[.*+?^${}()|[\]\\]/g;
const AGENTIC_TRACE_PATTERN = new RegExp(
  `${AGENTIC_TRACE_MESSAGE.replace(REGEXP_META, "\\$&")} correlation="?([0-9a-f-]+)"? ordinal=([0-9]+) tool="?([a-z_]+)"? status="?([a-z_]+)"?(?: result_status="?([a-z_]+)"?)?\\s*$`,
);
const LOCAL_WEATHER_TRACE_PATTERN = new RegExp(
  `${LOCAL_WEATHER_TRACE_MESSAGE.replace(REGEXP_META, "\\$&")} correlation="?([0-9a-f-]+)"? ordinal=([0-9]+) tool="?([a-z_]+)"? status="?([a-z_]+)"?\\s*$`,
);
const AGENTIC_TRACE_TOOLS = new Set([
  "knowledge_lookup",
  "place_search",
  "weather_at_place",
  "current_location",
  "current_weather",
  "reverse_geocode",
  "nearby_search",
  "music_artist_top_tracks",
  "music_catalog_search",
  "current_music",
  "route",
  "food_lookup",
  "memory_search",
  "other_registered_tool",
  "invalid_tool",
  "terminal",
]);
const AGENTIC_TRACE_RESULT_STATUSES = new Set([
  "ok",
  "unavailable",
  "invalid",
]);
const EXPECTED_REMOTE_WEATHER_TRACE = Object.freeze([
  Object.freeze({ tool: "knowledge_lookup", status: "completed", resultStatus: "ok" }),
  Object.freeze({ tool: "place_search", status: "completed", resultStatus: "ok" }),
  Object.freeze({ tool: "weather_at_place", status: "completed", resultStatus: "ok" }),
  Object.freeze({ tool: "terminal", status: "completed", resultStatus: null }),
]);
const EXPECTED_LOCAL_WEATHER_TRACE = Object.freeze([
  Object.freeze({ tool: "current_location", status: "completed" }),
  Object.freeze({ tool: "reverse_geocode", status: "completed" }),
  Object.freeze({ tool: "current_weather", status: "completed" }),
  Object.freeze({ tool: "terminal", status: "completed" }),
]);
const MAX_LOADING_CUE_LATENCY_MS = 5_000;
const PROGRESS_SOURCES = new Set(["spark", "fallback"]);
const PROGRESS_REASONS = new Set([
  "spark",
  "timeout",
  "error",
  "invalid",
  "skipped",
]);

const SAFE_PROGRESS_STARTS = new Set([
  "Finding",
  "Checking",
  "Searching",
  "Comparing",
  "Gathering",
  "Calculating",
  "Translating",
]);
const SAFE_PROGRESS_SUBJECTS = new Set([
  "answers", "availability", "details", "directions", "events", "facts",
  "flights", "food", "forecast", "hotels", "information", "language",
  "location", "memories", "music", "nearby", "news", "notes", "nutrition",
  "options", "places", "prices", "recommendations", "restaurants", "results",
  "routes", "schedules", "scores", "songs", "sources", "sports", "text",
  "times", "traffic", "translation", "weather",
]);

export const PHYSICAL_TIMEOUT_MS = Object.freeze({
  loadingEvidence: 10_000,
  simple: 25_000,
  weather: 35_000,
  // The observer must outlive the device's 90s client / 80s server / 75s
  // agentic circuit-breaker stack so a legitimate late terminal or a bounded
  // timeout is recorded instead of becoming a harness-side false negative.
  agenticRemoteWeather: 95_000,
  music: 95_000,
  ticklePositive: 25_000,
  tickleNegative: 25_000,
  cleanup: 20_000,
});

function fixedCase(value) {
  return Object.freeze({ ...value });
}

export const PHYSICAL_PROMPT_CASES = Object.freeze([
  fixedCase({
    id: "loading_semantic_music",
    prompt: "Queue the definitive dance-floor hit from the King of Pop.",
    kind: "loading_message",
    isUnlocked: true,
    expectedCueSubjects: Object.freeze(["songs", "music"]),
    expectedCueEmitted: true,
  }),
  fixedCase({
    id: "loading_semantic_playback",
    prompt: "Put the current track on hold for a moment.",
    kind: "loading_message",
    isUnlocked: true,
    expectedCueSubjects: Object.freeze([]),
    expectedCueEmitted: false,
  }),
  fixedCase({
    id: "loading_semantic_weather",
    prompt: "Will I need an umbrella before dinner?",
    kind: "loading_message",
    isUnlocked: true,
    expectedCueSubjects: Object.freeze(["weather", "forecast"]),
    expectedCueEmitted: true,
  }),
  fixedCase({
    id: "loading_locked_neutral",
    prompt: "Use what you remember about my commute to choose the closest stop.",
    kind: "loading_message",
    isUnlocked: false,
    expectedCueSubjects: Object.freeze([]),
    expectedCueEmitted: false,
  }),
  fixedCase({
    id: "current_time",
    prompt: "what time is it",
    kind: "simple_action",
    expectedAction: NATIVE_ACTIONS.GET_CURRENT_TIME,
  }),
  fixedCase({
    id: "battery_level",
    prompt: "battery level",
    kind: "simple_action",
    expectedAction: NATIVE_ACTIONS.GET_BATTERY_LEVEL,
  }),
  fixedCase({
    id: "current_weather",
    prompt: "What's the weather like where I am right now?",
    kind: "weather",
    expectedAction: NATIVE_ACTIONS.GET_CURRENT_LOCATION,
  }),
  fixedCase({
    id: "current_weather_today",
    prompt: "What's the weather like today?",
    kind: "weather",
    expectedAction: NATIVE_ACTIONS.GET_CURRENT_LOCATION,
  }),
  fixedCase({
    id: "capital_weather_remote",
    prompt: "Lookup the capitol of France and check the weather there",
    kind: "agentic_remote_weather",
  }),
  fixedCase({
    id: "ranked_music",
    prompt: "look up the best songs by Michael Jackson and play the most popular",
    kind: "music",
    expectedAction: NATIVE_ACTIONS.PLAY_MUSIC,
  }),
  fixedCase({
    id: "tickle_single",
    prompt: "tickle",
    kind: "tickle_positive",
    expectedAction: NATIVE_ACTIONS.TICKLE,
  }),
  fixedCase({
    id: "tickle_fancy",
    prompt: "tickle my fancy",
    kind: "tickle_positive",
    expectedAction: NATIVE_ACTIONS.TICKLE,
  }),
  fixedCase({
    id: "tickle_triple",
    prompt: "tickle tickle tickle",
    kind: "tickle_positive",
    expectedAction: NATIVE_ACTIONS.TICKLE,
  }),
  fixedCase({
    id: "tickle_negative",
    prompt: "please tickle",
    kind: "tickle_negative",
    expectedAction: null,
  }),
]);

const PAUSE_CLEANUP_CASE = fixedCase({
  id: "music_pause_cleanup",
  prompt: "pause music",
  kind: "cleanup",
  expectedAction: NATIVE_ACTIONS.PAUSE_MUSIC,
});

const CASE_BY_ID = new Map(
  [...PHYSICAL_PROMPT_CASES, PAUSE_CLEANUP_CASE].map((item) => [item.id, item]),
);
const PUBLIC_CASE_IDS = new Set(PHYSICAL_PROMPT_CASES.map((item) => item.id));

const FORBIDDEN_FIXED_PROMPT = /[`$\\\u0000-\u001f\u007f]/;
for (const item of CASE_BY_ID.values()) {
  if (
    Buffer.byteLength(item.prompt) > 256 ||
    FORBIDDEN_FIXED_PROMPT.test(item.prompt)
  ) {
    throw new Error("unsafe fixed physical prompt fixture");
  }
}

class SafePhysicalError extends Error {
  constructor(publicMessage) {
    super(publicMessage);
    this.name = "SafePhysicalError";
    this.publicMessage = publicMessage;
  }
}

function usage() {
  return [
    "Usage:",
    "  node platform/deploy/acceptance/pin/physical-prompt-harness.mjs --self-check [--json]",
    "  node platform/deploy/acceptance/pin/physical-prompt-harness.mjs --run --serial SERIAL --expect-version-name NAME --expect-version-code CODE --expect-apk-sha256 SHA256 --case FIXED_CASE_ID [--json]",
    "",
    "Safety contract:",
    `  - The live mode accepts no caller-supplied prompt and requires an explicit ADB serial plus the pinned ${RELEASE_IDENTITY.versionName} Server identity.`,
    "  - --case selects exactly one allowlisted fixture, so each live invocation can have an independent timeout and cleanup boundary.",
    `  - Allowed --case ids: ${PHYSICAL_PROMPT_CASES.map((item) => item.id).join(", ")}.`,
    `  - Only fixed time, battery, weather, ranked-music, pause-cleanup, and ${NATIVE_ACTIONS.TICKLE} fixtures can be injected.`,
    "  - Fixed semantic and locked loading-message fixtures call the no-action stock EncryptedLoadingMessage RPC directly.",
    "  - Calls, messages, camera, privacy mode, settings changes, installs, reboots, and package-installer session commands are structurally absent.",
    "  - Raw prompts, responses, coordinates, Spotify metadata, account data, dumpsys text, and ADB diagnostics are never printed.",
    `  - Music and ${NATIVE_ACTIONS.TICKLE} are skipped if their stock experience was already active. Music started by the harness is paused and its process is stopped; ${NATIVE_ACTIONS.TICKLE} processes started by the harness are stopped.`,
    "  - Only activity rows attributable to these fixed test prompts are deleted during cleanup.",
    "  - Transcript injection proves the post-ASR stock path. Microphone recognition, audible speech, and projector appearance require human confirmation.",
  ].join("\n");
}

export function parsePhysicalCliArgs(argv) {
  const options = {
    mode: null,
    serial: null,
    adbPath: "adb",
    expectedVersionName: null,
    expectedVersionCode: null,
    expectedApkSha256: null,
    caseId: null,
    json: false,
    help: false,
  };

  const chooseMode = (mode) => {
    if (options.mode !== null && options.mode !== mode) {
      throw new Error("choose exactly one mode");
    }
    options.mode = mode;
  };
  const next = (argument, index) => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    return value;
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
        options.serial = next(argument, index);
        index += 1;
        break;
      case "--adb":
        options.adbPath = next(argument, index);
        index += 1;
        break;
      case "--expect-version-name":
        options.expectedVersionName = next(argument, index);
        index += 1;
        break;
      case "--expect-version-code":
        options.expectedVersionCode = Number(next(argument, index));
        index += 1;
        break;
      case "--expect-apk-sha256":
        options.expectedApkSha256 = next(argument, index).toLowerCase();
        index += 1;
        break;
      case "--case":
        if (options.caseId !== null) throw new Error("--case may be provided once");
        options.caseId = next(argument, index);
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
      options.expectedVersionName !== null ||
      options.expectedVersionCode !== null ||
      options.expectedApkSha256 !== null ||
      options.caseId !== null
    ) {
      throw new Error("--self-check does not accept live-device options");
    }
    return options;
  }

  validateSerial(options.serial);
  if (options.expectedVersionName !== RELEASE_IDENTITY.versionName) {
    throw new Error("the pinned Server version name is required");
  }
  if (options.expectedVersionCode !== RELEASE_IDENTITY.versionCode) {
    throw new Error("the pinned Server version code is required");
  }
  if (options.expectedApkSha256 !== RELEASE_IDENTITY.apkSha256) {
    throw new Error("the pinned Server APK SHA-256 is required");
  }
  if (options.caseId === null) {
    throw new Error("live mode requires exactly one --case fixture");
  }
  if (!PUBLIC_CASE_IDS.has(options.caseId)) {
    throw new Error("--case must name one fixed public physical case");
  }
  if (
    typeof options.adbPath !== "string" ||
    options.adbPath.length === 0 ||
    options.adbPath.includes("\0")
  ) {
    throw new Error("ADB executable path is required");
  }
  return options;
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
      rejectPromise(new SafePhysicalError("could not start a required local process"));
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
      finish(() => rejectPromise(new SafePhysicalError(message)));
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
  const completed = await captureChild(options.adbPath, ["-s", options.serial, ...args], runOptions);
  if (completed.code !== 0) throw new SafePhysicalError(publicFailure);
  return completed.stdout;
}

function caseForId(caseId) {
  const item = CASE_BY_ID.get(caseId);
  if (item === undefined) throw new SafePhysicalError("unknown fixed physical case");
  return item;
}

export function buildTranscriptInjectionCommand(caseId) {
  const item = caseForId(caseId);
  if (item.kind === "loading_message") {
    throw new SafePhysicalError("loading-message cases cannot be transcript injected");
  }
  const prompt = item.prompt;
  return `am broadcast --user 0 -a hu.ma.ne.INJECT_TRANSCRIPTION -p ${IRONMAN_PACKAGE} --es transcription ${JSON.stringify(prompt)} --ez vision false`;
}

function exactlyOneBytes(fields, fieldNumber) {
  const entries = fields.get(fieldNumber) ?? [];
  if (entries.length !== 1 || entries[0].wireType !== 2) {
    throw new SafePhysicalError("the loading-message protobuf was malformed");
  }
  return entries[0].value;
}

function optionalBytes(fields, fieldNumber) {
  const entries = fields.get(fieldNumber) ?? [];
  if (entries.length === 0) return Buffer.alloc(0);
  if (entries.length !== 1 || entries[0].wireType !== 2) {
    throw new SafePhysicalError("the loading-message protobuf was malformed");
  }
  return entries[0].value;
}

function exactlyOneString(fields, fieldNumber) {
  try {
    return UTF8.decode(exactlyOneBytes(fields, fieldNumber));
  } catch (error) {
    if (error instanceof SafePhysicalError) throw error;
    throw new SafePhysicalError("the loading-message protobuf was malformed");
  }
}

function optionalString(fields, fieldNumber) {
  const entries = fields.get(fieldNumber) ?? [];
  if (entries.length === 0) return "";
  if (entries.length !== 1 || entries[0].wireType !== 2) {
    throw new SafePhysicalError("the loading-message protobuf was malformed");
  }
  try {
    return UTF8.decode(entries[0].value);
  } catch {
    throw new SafePhysicalError("the loading-message protobuf was malformed");
  }
}

export function encodeLoadingMessageCaseRequest(caseId) {
  const item = caseForId(caseId);
  if (item.kind !== "loading_message") {
    throw new SafePhysicalError("the case is not a loading-message fixture");
  }
  const inner = Buffer.concat([
    encodeProtoString(1, item.prompt),
    encodeProtoVarint(2, item.isUnlocked ? 1 : 0),
  ]);
  const encryptionInformation = encodeProtoString(1, LOADING_REQUEST_KID);
  const envelope = Buffer.concat([
    encodeProtoBytes(1, encryptionInformation),
    encodeProtoBytes(2, inner),
  ]);
  return encodeProtoBytes(1, envelope);
}

export function decodeLoadingMessageRpcResponse(value) {
  try {
    const outer = decodeProtoFields(value, { maxBytes: 128 * 1024 });
    if ([...outer.keys()].some((field) => field !== 1)) {
      throw new SafePhysicalError("the loading-message protobuf was malformed");
    }
    const envelope = decodeProtoFields(exactlyOneBytes(outer, 1), {
      maxBytes: 128 * 1024,
    });
    if ([...envelope.keys()].some((field) => field !== 1 && field !== 2)) {
      throw new SafePhysicalError("the loading-message protobuf was malformed");
    }
    const encryptionInformation = decodeProtoFields(
      exactlyOneBytes(envelope, 1),
      { maxBytes: 4 * 1024 },
    );
    if (
      [...encryptionInformation.keys()].some((field) => field !== 1) ||
      exactlyOneString(encryptionInformation, 1) !== LOADING_RESPONSE_KID
    ) {
      throw new SafePhysicalError("the loading-message response KID was invalid");
    }
    // `EncryptedData.data` is a proto3 `bytes` scalar. Prost canonically
    // elides that field when the inner LoadingMessageResponse is empty, which
    // is the expected wire shape for a deliberately omitted loading cue.
    const response = decodeProtoFields(optionalBytes(envelope, 2), {
      maxBytes: 16 * 1024,
    });
    if ([...response.keys()].some((field) => field !== 1 && field !== 2)) {
      throw new SafePhysicalError("the loading-message protobuf was malformed");
    }
    const loadingMessage = optionalString(response, 1);
    const verbalMessage = optionalString(response, 2);
    if (
      Buffer.byteLength(loadingMessage) > 256 ||
      Buffer.byteLength(verbalMessage) > 256
    ) {
      throw new SafePhysicalError("the loading-message response was oversized");
    }
    return { loadingMessage, verbalMessage };
  } catch (error) {
    if (error instanceof SafePhysicalError) throw error;
    throw new SafePhysicalError("the loading-message protobuf was malformed");
  }
}

function progressCuePhrase(response) {
  const loadingMessage = response?.loadingMessage;
  const verbalMessage = response?.verbalMessage;
  if (loadingMessage === "" && verbalMessage === "") return null;
  if (
    typeof loadingMessage !== "string" ||
    typeof verbalMessage !== "string" ||
    !loadingMessage.endsWith("...") ||
    !verbalMessage.endsWith(".")
  ) {
    return undefined;
  }
  const phrase = loadingMessage.slice(0, -3);
  if (verbalMessage.slice(0, -1) !== phrase || Buffer.byteLength(phrase) > 48) {
    return undefined;
  }
  const words = phrase.split(" ");
  if (
    words.length < 2 ||
    words.length > 4 ||
    words.some((word) => !/^[A-Za-z]+$/.test(word))
  ) {
    return undefined;
  }
  let subjectStart;
  if (SAFE_PROGRESS_STARTS.has(words[0])) subjectStart = 1;
  else if (words[0] === "Looking" && words[1] === "up") subjectStart = 2;
  else return undefined;
  const subjects = words.slice(subjectStart);
  if (
    subjects.length === 0 ||
    !subjects.every(
      (word) => word === "for" || word === "the" || SAFE_PROGRESS_SUBJECTS.has(word),
    ) ||
    !subjects.some((word) => SAFE_PROGRESS_SUBJECTS.has(word))
  ) {
    return undefined;
  }
  return phrase;
}

export function evaluateLoadingCueEvidence(caseId, response) {
  const item = caseForId(caseId);
  if (item.kind !== "loading_message") {
    throw new SafePhysicalError("the case is not a loading-message fixture");
  }
  const phrase = progressCuePhrase(response);
  const allowlisted = phrase !== undefined;
  const cueEmitted = typeof phrase === "string";
  const words = cueEmitted ? phrase.split(" ") : [];
  const categoryAppropriate = item.expectedCueEmitted
    ? cueEmitted && item.expectedCueSubjects.some((subject) => words.includes(subject))
    : phrase === null;
  return {
    allowlisted,
    categoryAppropriate,
    semanticCategoryObserved: item.isUnlocked ? categoryAppropriate : null,
    lockedNeutralObserved: item.isUnlocked ? null : phrase === null,
    pass: allowlisted && categoryAppropriate,
  };
}

function grpcHeaderValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.at(-1)?.toString();
  return value?.toString();
}

function runLoadingMessageRpc(options, devicePort, caseId, correlationMarker) {
  if (!PROGRESS_BOUNDARY_PATTERN.test(correlationMarker)) {
    throw new SafePhysicalError("the progress evidence boundary was malformed");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let tunnel;
    let session;
    try {
      tunnel = openAdbShellAibusTunnel(options, devicePort, {
        maxResponseBytes: 128 * 1024,
      });
      session = connectHttp2(`http://127.0.0.1:${devicePort}`, {
        createConnection: () => tunnel.stream,
      });
    } catch {
      tunnel?.close();
      rejectPromise(new SafePhysicalError("the loading-message RPC failed"));
      return;
    }
    const decoder = new GrpcFrameDecoder({
      maxFrameBytes: 128 * 1024,
      maxFrames: 2,
    });
    const frames = [];
    let responseHeaders;
    let responseTrailers;
    let stream;
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session.destroy();
      } catch {}
      tunnel.close();
      callback();
    };
    const fail = () => {
      if (settled) return;
      try {
        stream?.close(http2Constants.NGHTTP2_CANCEL);
      } catch {}
      settle(() =>
        rejectPromise(new SafePhysicalError("the loading-message RPC failed")),
      );
    };
    const timer = setTimeout(fail, 10_000);
    timer.unref?.();
    session.on("error", fail);
    try {
      stream = session.request({
        ":method": "POST",
        ":path": LOADING_RPC_PATH,
        "content-type": "application/grpc+proto",
        te: "trailers",
        "grpc-timeout": "10S",
        "x-ai-mic-run-id": correlationMarker,
      });
    } catch {
      fail();
      return;
    }
    stream.on("response", (headers) => {
      responseHeaders = headers;
    });
    stream.on("trailers", (headers) => {
      responseTrailers = headers;
    });
    stream.on("data", (chunk) => {
      try {
        frames.push(...decoder.push(chunk));
      } catch {
        fail();
      }
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      try {
        decoder.finish();
        const httpStatus = Number(responseHeaders?.[":status"] ?? 0);
        const grpcStatus =
          grpcHeaderValue(responseTrailers, "grpc-status") ??
          grpcHeaderValue(responseHeaders, "grpc-status");
        if (httpStatus !== 200 || grpcStatus !== "0" || frames.length !== 1) {
          fail();
          return;
        }
        const response = decodeLoadingMessageRpcResponse(frames[0]);
        settle(() => resolvePromise(response));
      } catch {
        fail();
      }
    });
    try {
      stream.end(wrapGrpcFrame(encodeLoadingMessageCaseRequest(caseId)));
    } catch {
      fail();
    }
  });
}

function curlConfig(path, method, token) {
  const validGet = path === PROMPT_ACTIVITY_PATH || path === MUSIC_ACTIVITY_PATH;
  const validDelete = /^\/api\/activity\/(?:prompts|music)\/[1-9][0-9]*$/.test(path);
  if (!((method === "GET" && validGet) || (method === "DELETE" && validDelete))) {
    throw new SafePhysicalError("refusing a non-allowlisted Center activity request");
  }
  return Buffer.from(
    [
      `url = "http://127.0.0.1:8080${path}"`,
      `request = "${method}"`,
      `header = "Authorization: Bearer ${token}"`,
      'header = "Accept: application/json"',
      'header = "User-Agent: penumbra-physical-prompt-harness/1"',
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
  if (markerIndex < 0) throw new SafePhysicalError("a fixed Center response was malformed");
  const status = output.subarray(markerIndex + marker.length).toString("ascii").trim();
  const body = output.subarray(0, markerIndex);
  if (method === "DELETE") {
    if (status !== "204" && status !== "404") {
      throw new SafePhysicalError("test activity cleanup was rejected");
    }
    return null;
  }
  if (status !== "200" || body.length === 0 || body.length > MAX_HTTP_BODY_BYTES) {
    throw new SafePhysicalError("a fixed Center activity response was unavailable");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new SafePhysicalError("a fixed Center activity response was malformed");
  }
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function parsePromptActivityPage(value) {
  if (!plainObject(value) || !Array.isArray(value.items) || value.items.length > 100) {
    throw new SafePhysicalError("the prompt activity page was malformed");
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
        (typeof item.response === "string" && Buffer.byteLength(item.response) <= 64 * 1024)
      )
    ) {
      throw new SafePhysicalError("the prompt activity page was malformed");
    }
    return item;
  });
}

export function parseMusicActivityPage(value) {
  if (!plainObject(value) || !Array.isArray(value.items) || value.items.length > 100) {
    throw new SafePhysicalError("the music activity page was malformed");
  }
  return value.items.map((item) => {
    if (
      !plainObject(item) ||
      !Number.isSafeInteger(item.id) ||
      item.id <= 0 ||
      typeof item.track_id !== "string" ||
      typeof item.title !== "string" ||
      !Array.isArray(item.artists) ||
      !item.artists.every((artist) => typeof artist === "string") ||
      typeof item.album !== "string" ||
      !["requested", "started", "playing", "completed", "interrupted", "failed"].includes(item.status)
    ) {
      throw new SafePhysicalError("the music activity page was malformed");
    }
    return item;
  });
}

function maximumId(items) {
  return items.reduce((maximum, item) => Math.max(maximum, item.id), 0);
}

function attributedPromptRows(rows, baselineId, caseId) {
  const prompt = caseForId(caseId).prompt;
  return rows.filter((row) => row.id > baselineId && row.prompt === prompt);
}

function attributedAgenticCorrelation(rows, baselineId, caseId) {
  const attributed = attributedPromptRows(rows, baselineId, caseId);
  if (attributed.length !== 1) return null;
  const correlation = attributed[0].run_id;
  return typeof correlation === "string" &&
    AGENTIC_CORRELATION_PATTERN.test(correlation)
    ? correlation
    : null;
}

function attributedLocalWeatherCorrelation(rows, baselineId, caseId) {
  const attributed = attributedPromptRows(rows, baselineId, caseId);
  if (attributed.length !== 2) return null;
  const correlations = new Set(attributed.map((row) => row.run_id));
  if (correlations.size !== 1) return null;
  const correlation = attributed[0].run_id;
  return typeof correlation === "string" &&
    AGENTIC_CORRELATION_PATTERN.test(correlation)
    ? correlation
    : null;
}

function actionObserved(rows, action) {
  return rows.some((row) => row.response === `Action: ${action}`);
}

const WEATHER_TEMPERATURE = /\b-?[0-9]{1,3} degrees (?:Celsius|Fahrenheit)\b/;
const WEATHER_LOCALITY = /\bdegrees (?:Celsius|Fahrenheit) in [\p{L}\p{M}][^.!?]{0,79}\./u;
const REMOTE_PARIS_MENTION = /\bParis\b/u;
const REMOTE_FRANCE_GROUNDING = /\bFrance\b/iu;
const REMOTE_WRONG_COUNTRY =
  /\bParis\b[\s,]*(?:Texas|Arkansas|Kentucky|Tennessee|Missouri|Maine|Idaho|Illinois|Indiana|Iowa|Michigan|Montana|Pennsylvania|Ohio|Virginia|New York|Wisconsin|Oregon|California|Alabama|Arizona|Florida|Georgia|Louisiana|Mississippi|North Carolina|South Carolina|New Jersey|Massachusetts|Minnesota|Colorado|Washington|Oklahoma|Connecticut|Utah|Nevada|New Mexico|Kansas|Nebraska|West Virginia|Hawaii|New Hampshire|Rhode Island|Delaware|South Dakota|North Dakota|Alaska|Vermont|Wyoming|Maryland|USA|U\.S\.A\.|U\.S\.|United States|Canada|Mexico|England|UK|Germany)\b/iu;

export function evaluatePromptEvidence(caseId, rows, baselineId) {
  const item = caseForId(caseId);
  const attributed = attributedPromptRows(rows, baselineId, caseId);
  if (item.kind === "weather") {
    const preflights = attributed.filter(
      (row) =>
        row.response === `Action: ${NATIVE_ACTIONS.GET_CURRENT_LOCATION}`,
    );
    const terminals = attributed.filter(
      (row) =>
        typeof row.response === "string" &&
        !row.response.startsWith("Action:") &&
        WEATHER_TEMPERATURE.test(row.response) &&
        WEATHER_LOCALITY.test(row.response),
    );
    const exactShape =
      attributed.length === 2 && preflights.length === 1 && terminals.length === 1;
    return {
      routeObserved: exactShape,
      terminalObserved: terminals.length === 1,
      localityObserved: terminals.length === 1,
      pass: exactShape,
      ownedIds: attributed.map((row) => row.id),
    };
  }
  if (item.kind === "agentic_remote_weather") {
    const responses = attributed
      .map((row) => row.response)
      .filter((response) => typeof response === "string");
    const currentLocationAction = responses.includes(
      `Action: ${NATIVE_ACTIONS.GET_CURRENT_LOCATION}`,
    );
    const terminal = responses.length === 1 && !responses[0].startsWith("Action:")
      ? responses[0]
      : null;
    const temperatureGrounded =
      terminal !== null && WEATHER_TEMPERATURE.test(terminal);
    const parisMentioned =
      terminal !== null && REMOTE_PARIS_MENTION.test(terminal);
    const franceGrounded =
      terminal !== null && REMOTE_FRANCE_GROUNDING.test(terminal);
    const wrongCountryObserved =
      terminal !== null && REMOTE_WRONG_COUNTRY.test(terminal);
    const parisGrounded =
      parisMentioned && franceGrounded && !wrongCountryObserved;
    return {
      currentLocationObserved: currentLocationAction,
      terminalObserved: terminal !== null && temperatureGrounded && parisGrounded,
      localityObserved: parisGrounded,
      franceGrounded,
      wrongCountryObserved,
      pass:
        !currentLocationAction &&
        terminal !== null &&
        temperatureGrounded &&
        parisGrounded,
      ownedIds: attributed.map((row) => row.id),
    };
  }
  if (item.kind === "tickle_negative") {
    const escaped = actionObserved(attributed, NATIVE_ACTIONS.TICKLE);
    const terminalObserved = attributed.some(
      (row) =>
        typeof row.response === "string" &&
        row.response.length > 0 &&
        !row.response.startsWith("Action:"),
    );
    return {
      routeObserved: terminalObserved && !escaped,
      actionEscaped: escaped,
      terminalObserved,
      localityObserved: null,
      pass: terminalObserved && !escaped,
      ownedIds: attributed.map((row) => row.id),
    };
  }
  const routeCount = attributed.filter(
    (row) => row.response === `Action: ${item.expectedAction}`,
  ).length;
  const routeObserved =
    item.kind === "tickle_positive" ? routeCount === 1 : routeCount > 0;
  return {
    routeObserved,
    terminalObserved: item.kind !== "simple_action" ? routeObserved : null,
    localityObserved: null,
    pass: routeObserved,
    ownedIds: attributed.map((row) => row.id),
  };
}

export function parsePidSet(value) {
  const text = Buffer.isBuffer(value) ? value.toString("ascii") : String(value);
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (!/^[0-9]+(?:\s+[0-9]+)*$/.test(trimmed)) {
    throw new SafePhysicalError("a package process observation was malformed");
  }
  return [...new Set(trimmed.split(/\s+/).map(Number))].sort((a, b) => a - b);
}

export function parseMediaSessionSummary(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text) > MAX_CHILD_STDOUT_BYTES) {
    throw new SafePhysicalError("the media-session observation was too large");
  }
  let currentPackage = null;
  let sessionCount = 0;
  const states = [];
  for (const line of text.split(/\r?\n/)) {
    const packageMatch = /^\s*package=(\S+)\s*$/.exec(line);
    if (packageMatch !== null) {
      currentPackage = packageMatch[1];
      if (currentPackage === MUSIC_PACKAGE) sessionCount += 1;
      continue;
    }

    const stateMatch = /^\s*state=PlaybackState\s*\{\s*state=([0-9]+),\s*position=(-?[0-9]+)/.exec(
      line,
    ) ?? /^\s*state=([0-9]+),\s*position=(-?[0-9]+)/.exec(line);
    if (stateMatch !== null) {
      if (currentPackage === MUSIC_PACKAGE) {
        const speedMatch = /,\s*speed=(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))/.exec(line);
        states.push({
          state: Number(stateMatch[1]),
          position: Number(stateMatch[2]),
          speed: speedMatch === null ? null : Number(speedMatch[1]),
        });
      }
      currentPackage = null;
      continue;
    }

    if (/^\s*state=null\s*$/.test(line)) {
      currentPackage = null;
    }
  }
  const playingStates = states.filter((state) => state.state === 3);
  return {
    sessionCount,
    playing: playingStates.length > 0,
    playbackClockRunning: playingStates.some(
      (state) => Number.isFinite(state.speed) && state.speed > 0,
    ),
    maximumPlayingPosition:
      playingStates.length === 0
        ? null
        : Math.max(...playingStates.map((state) => state.position)),
  };
}

export function tickleActivityIsForeground(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text) > MAX_CHILD_STDOUT_BYTES) {
    throw new SafePhysicalError("the activity observation was too large");
  }
  return text.split(/\r?\n/).some(
    (line) =>
      /(?:mResumedActivity:|topResumedActivity=|ResumedActivity:)/.test(line) &&
      line.includes(TICKLE_ACTIVITY),
  );
}

export function mediaPositionAdvanced(first, second, elapsedMs = 0) {
  const stablePlaybackClock =
    Number.isFinite(elapsedMs) &&
    elapsedMs >= MUSIC_STABILITY_WINDOW_MS &&
    first?.playbackClockRunning === true &&
    second?.playbackClockRunning === true;
  return (
    first?.playing === true &&
    second?.playing === true &&
    Number.isSafeInteger(first.maximumPlayingPosition) &&
    Number.isSafeInteger(second.maximumPlayingPosition) &&
    (second.maximumPlayingPosition > first.maximumPlayingPosition || stablePlaybackClock)
  );
}

function parseEpochLogcatLine(line) {
  const match = /^\s*[0-9]{9,12}\.[0-9]+\s+[0-9]+\s+[0-9]+\s+[VDIWEF]\s+([A-Za-z0-9_.-]+)\s*:\s?(.*)$/.exec(
    line,
  );
  return match === null ? null : { tag: match[1], message: match[2] };
}

/**
 * Reduces the two-tag logcat window to a closed set of privacy-safe evidence
 * markers after a harness-owned boundary. No raw hook message survives this
 * function.
 */
export function parsePenumbraHookEvidence(value, boundaryMarker) {
  if (!HOOK_BOUNDARY_PATTERN.test(boundaryMarker)) {
    throw new SafePhysicalError("the hook evidence boundary was malformed");
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text) > MAX_CHILD_STDOUT_BYTES) {
    throw new SafePhysicalError("the hook evidence observation was too large");
  }
  let boundaryObserved = false;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEpochLogcatLine(line);
    if (parsed === null) continue;
    if (
      parsed.tag === HOOK_BOUNDARY_TAG &&
      parsed.message === boundaryMarker
    ) {
      boundaryObserved = true;
      events.length = 0;
      continue;
    }
    if (!boundaryObserved || parsed.tag !== HOOK_LOG_TAG) continue;
    const actionName = parsed.message.startsWith(PHYSICAL_NATIVE_ACTION_MARKER)
      ? parsed.message.slice(PHYSICAL_NATIVE_ACTION_MARKER.length)
      : parsed.message ===
          `${OPERATIONAL_MARKERS.music_intent_compatibility_emitted.value} ${NATIVE_ACTIONS.PAUSE_MUSIC}`
        ? NATIVE_ACTIONS.PAUSE_MUSIC
        : null;
    if (
      actionName !== null &&
      PHYSICAL_NATIVE_ACTIONS.has(actionName) &&
      (
        parsed.message === `${PHYSICAL_NATIVE_ACTION_MARKER}${actionName}` ||
        (
          actionName === NATIVE_ACTIONS.PAUSE_MUSIC &&
          parsed.message ===
            `${OPERATIONAL_MARKERS.music_intent_compatibility_emitted.value} ${NATIVE_ACTIONS.PAUSE_MUSIC}`
        )
      )
    ) {
      events.push(`action:${actionName}`);
    } else if (
      parsed.message.startsWith(
        `${OPERATIONAL_MARKERS.hand_tracking_held_for_narration.value} |`,
      ) ||
      parsed.message.startsWith(
        `${OPERATIONAL_MARKERS.narration_start_without_hand_tracking.value} |`,
      ) ||
      parsed.message ===
        "  Hand tracking feature disabled; delegating update(NARRATION_START) to stock"
    ) {
      events.push("narration_start");
    } else if (
      parsed.message.startsWith(
        OPERATIONAL_MARKERS.narration_end_released_hold.value,
      ) ||
      parsed.message.startsWith(
        `${OPERATIONAL_MARKERS.narration_end_without_hand_tracking.value} |`,
      ) ||
      parsed.message ===
        "  Hand tracking feature disabled; delegating update(NARRATION_END) to stock"
    ) {
      events.push("narration_end");
    }
  }
  if (!boundaryObserved) {
    throw new SafePhysicalError("the hook evidence boundary was unavailable");
  }
  return events;
}

function progressDecisionField(message, field) {
  const match = new RegExp(
    `(?:^|\\s)${field}=\"?([a-z_]+)\"?(?=\\s|$)`,
  ).exec(message);
  return match?.[1] ?? null;
}

function progressBooleanField(message, field) {
  const match = new RegExp(
    `(?:^|\\s)${field}="?(true|false)"?(?=\\s|$)`,
  ).exec(message);
  if (match?.[1] === "true") return true;
  if (match?.[1] === "false") return false;
  return null;
}

function progressCorrelationField(message) {
  const match = /(?:^|\s)correlation="?([a-z0-9-]+)"?(?=\s|$)/.exec(
    message,
  );
  return match?.[1] ?? null;
}

/**
 * Extracts only the closed progress decision fields emitted by the Rust
 * loading-message handler after a harness-owned log boundary. Raw log lines,
 * prompts, and model output never leave this function.
 */
export function evaluateProgressModelEvidence(caseId, value, boundaryMarker) {
  const item = caseForId(caseId);
  if (item.kind !== "loading_message") {
    throw new SafePhysicalError("the case is not a loading-message fixture");
  }
  if (!PROGRESS_BOUNDARY_PATTERN.test(boundaryMarker)) {
    throw new SafePhysicalError("the progress evidence boundary was malformed");
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text) > MAX_CHILD_STDOUT_BYTES) {
    throw new SafePhysicalError("the progress evidence observation was too large");
  }
  let boundaryObserved = false;
  let decision = null;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEpochLogcatLine(line);
    if (parsed === null) continue;
    if (
      parsed.tag === HOOK_BOUNDARY_TAG &&
      parsed.message === boundaryMarker
    ) {
      boundaryObserved = true;
      decision = null;
      continue;
    }
    if (
      !boundaryObserved ||
      parsed.tag !== SERVER_LOG_TAG ||
      !parsed.message.includes(
        OPERATIONAL_MARKERS.bounded_loading_message.value,
      )
    ) {
      continue;
    }
    const correlation = progressCorrelationField(parsed.message);
    if (correlation !== boundaryMarker) continue;
    const emitted = progressBooleanField(parsed.message, "emitted");
    const source = progressDecisionField(parsed.message, "source");
    const reason = progressDecisionField(parsed.message, "reason");
    if (
      emitted !== null &&
      PROGRESS_SOURCES.has(source) &&
      PROGRESS_REASONS.has(reason)
    ) {
      decision = { emitted, source, reason };
    }
  }
  if (!boundaryObserved) {
    throw new SafePhysicalError("the progress evidence boundary was unavailable");
  }
  const emissionMatched = decision?.emitted === item.expectedCueEmitted;
  const sparkObserved =
    item.isUnlocked &&
    emissionMatched &&
    decision?.source === "spark" &&
    decision?.reason === "spark";
  const lockedFallbackObserved =
    !item.isUnlocked &&
    emissionMatched &&
    decision?.source === "fallback" &&
    decision?.reason === "skipped";
  return {
    decisionObserved: decision !== null,
    correlationMatched: decision !== null,
    emissionMatched,
    sparkObserved: item.isUnlocked ? sparkObserved : null,
    lockedFallbackObserved: item.isUnlocked ? null : lockedFallbackObserved,
    pass: item.isUnlocked ? sparkObserved : lockedFallbackObserved,
  };
}

/**
 * Reduces the server's closed agentic trace schema to booleans and a count.
 * Raw log lines and the random runtime correlation never leave this function.
 * A second run in the same bounded window is deliberately an attribution
 * failure rather than something the harness tries to guess around.
 */
export function evaluateAgenticTraceEvidence(
  caseId,
  value,
  boundaryMarker,
  expectedCorrelation,
) {
  const item = caseForId(caseId);
  if (item.kind !== "agentic_remote_weather") {
    throw new SafePhysicalError("the case is not an agentic remote-weather fixture");
  }
  if (!AGENTIC_BOUNDARY_PATTERN.test(boundaryMarker)) {
    throw new SafePhysicalError("the agentic evidence boundary was malformed");
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text) > MAX_CHILD_STDOUT_BYTES) {
    throw new SafePhysicalError("the agentic evidence observation was too large");
  }
  let boundaryObserved = false;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEpochLogcatLine(line);
    if (parsed === null) continue;
    if (
      parsed.tag === HOOK_BOUNDARY_TAG &&
      parsed.message === boundaryMarker
    ) {
      boundaryObserved = true;
      events.length = 0;
      continue;
    }
    if (
      !boundaryObserved ||
      parsed.tag !== SERVER_LOG_TAG ||
      !parsed.message.includes(AGENTIC_TRACE_MESSAGE)
    ) {
      continue;
    }
    const match = AGENTIC_TRACE_PATTERN.exec(parsed.message);
    if (match === null) {
      throw new SafePhysicalError("the agentic trace event was malformed");
    }
    const ordinal = Number(match[2]);
    const terminal = match[3] === "terminal";
    const resultStatus = match[5] ?? null;
    if (
      !AGENTIC_CORRELATION_PATTERN.test(match[1]) ||
      !Number.isSafeInteger(ordinal) ||
      ordinal <= 0 ||
      ordinal > 128 ||
      !AGENTIC_TRACE_TOOLS.has(match[3]) ||
      match[4] !== "completed" ||
      (terminal
        ? resultStatus !== null
        : !AGENTIC_TRACE_RESULT_STATUSES.has(resultStatus))
    ) {
      throw new SafePhysicalError("the agentic trace event was malformed");
    }
    events.push({
      correlation: match[1],
      ordinal,
      tool: match[3],
      status: match[4],
      resultStatus,
    });
  }
  if (!boundaryObserved) {
    throw new SafePhysicalError("the agentic evidence boundary was unavailable");
  }
  const correlations = new Set(events.map((event) => event.correlation));
  const correlationMatched =
    AGENTIC_CORRELATION_PATTERN.test(expectedCorrelation ?? "") &&
    events.length > 0 &&
    correlations.size === 1 &&
    correlations.has(expectedCorrelation);
  const ordinalsContiguous = events.every(
    (event, index) => event.ordinal === index + 1,
  );
  const exactOrder =
    events.length === EXPECTED_REMOTE_WEATHER_TRACE.length &&
    events.every(
      (event, index) =>
        event.tool === EXPECTED_REMOTE_WEATHER_TRACE[index].tool &&
        event.status === EXPECTED_REMOTE_WEATHER_TRACE[index].status &&
        event.resultStatus === EXPECTED_REMOTE_WEATHER_TRACE[index].resultStatus,
    );
  const currentLocationObserved = events.some(
    (event) => event.tool === "current_location",
  );
  return {
    correlationMatched,
    ordinalsContiguous,
    exactOrder,
    currentLocationObserved,
    terminalObserved:
      events.at(-1)?.tool === "terminal" &&
      events.at(-1)?.status === "completed",
    eventCount: events.length,
    pass:
      correlationMatched &&
      ordinalsContiguous &&
      exactOrder &&
      !currentLocationObserved,
  };
}

/**
 * Reduces the deterministic location-weather proof to an exact content-free
 * chain. The activity correlation must match both stock activity rows, so a
 * plausible terminal string cannot substitute for provider execution.
 */
export function evaluateLocalWeatherTraceEvidence(
  caseId,
  value,
  boundaryMarker,
  expectedCorrelation,
) {
  const item = caseForId(caseId);
  if (item.kind !== "weather") {
    throw new SafePhysicalError("the case is not a local-weather fixture");
  }
  if (!AGENTIC_BOUNDARY_PATTERN.test(boundaryMarker)) {
    throw new SafePhysicalError("the local-weather evidence boundary was malformed");
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text) > MAX_CHILD_STDOUT_BYTES) {
    throw new SafePhysicalError("the local-weather evidence observation was too large");
  }
  let boundaryObserved = false;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEpochLogcatLine(line);
    if (parsed === null) continue;
    if (
      parsed.tag === HOOK_BOUNDARY_TAG &&
      parsed.message === boundaryMarker
    ) {
      boundaryObserved = true;
      events.length = 0;
      continue;
    }
    if (
      !boundaryObserved ||
      parsed.tag !== SERVER_LOG_TAG ||
      !parsed.message.includes(LOCAL_WEATHER_TRACE_MESSAGE)
    ) {
      continue;
    }
    const match = LOCAL_WEATHER_TRACE_PATTERN.exec(parsed.message);
    if (match === null) {
      throw new SafePhysicalError("the local-weather trace event was malformed");
    }
    const ordinal = Number(match[2]);
    if (
      !AGENTIC_CORRELATION_PATTERN.test(match[1]) ||
      !Number.isSafeInteger(ordinal) ||
      ordinal <= 0 ||
      ordinal > 128 ||
      !EXPECTED_LOCAL_WEATHER_TRACE.some((event) => event.tool === match[3]) ||
      match[4] !== "completed"
    ) {
      throw new SafePhysicalError("the local-weather trace event was malformed");
    }
    events.push({
      correlation: match[1],
      ordinal,
      tool: match[3],
      status: match[4],
    });
  }
  if (!boundaryObserved) {
    throw new SafePhysicalError("the local-weather evidence boundary was unavailable");
  }
  const correlations = new Set(events.map((event) => event.correlation));
  const correlationMatched =
    AGENTIC_CORRELATION_PATTERN.test(expectedCorrelation ?? "") &&
    events.length > 0 &&
    correlations.size === 1 &&
    correlations.has(expectedCorrelation);
  const ordinalsContiguous = events.every(
    (event, index) => event.ordinal === index + 1,
  );
  const exactOrder =
    events.length === EXPECTED_LOCAL_WEATHER_TRACE.length &&
    events.every(
      (event, index) =>
        event.tool === EXPECTED_LOCAL_WEATHER_TRACE[index].tool &&
        event.status === EXPECTED_LOCAL_WEATHER_TRACE[index].status,
    );
  return {
    correlationMatched,
    ordinalsContiguous,
    exactOrder,
    freshLocationObserved: events[0]?.tool === "current_location",
    reverseGeocodeObserved: events.some(
      (event) => event.tool === "reverse_geocode",
    ),
    weatherProviderObserved: events.some(
      (event) => event.tool === "current_weather",
    ),
    terminalObserved:
      events.at(-1)?.tool === "terminal" &&
      events.at(-1)?.status === "completed",
    eventCount: events.length,
    pass: correlationMatched && ordinalsContiguous && exactOrder,
  };
}

export function evaluateNativeActionHookEvidence(events, expectedAction) {
  if (!PHYSICAL_NATIVE_ACTIONS.has(expectedAction)) {
    throw new SafePhysicalError("the expected native action was malformed");
  }
  if (
    !Array.isArray(events) ||
    !events.every((event) =>
      ["narration_start", "narration_end"].includes(event) ||
      [...PHYSICAL_NATIVE_ACTIONS].some((action) => event === `action:${action}`),
    )
  ) {
    throw new SafePhysicalError("the hook evidence observation was malformed");
  }
  const actionEvents = events.filter((event) => event.startsWith("action:"));
  const expectedActionEvent = `action:${expectedAction}`;
  const expectedActionCount = actionEvents.filter(
    (event) => event === expectedActionEvent,
  ).length;
  const exactActionObserved =
    actionEvents.length === 1 && expectedActionCount === 1;
  return {
    exactActionObserved,
    expectedActionCount,
    actionEventCount: actionEvents.length,
    pass: exactActionObserved,
  };
}

export function evaluateSimpleHookEvidence(events, expectedAction) {
  const actionEvidence = evaluateNativeActionHookEvidence(events, expectedAction);
  const localActionIndex = actionEvidence.exactActionObserved
    ? events.indexOf(`action:${expectedAction}`)
    : -1;
  const narrationStartIndex = events.indexOf(
    "narration_start",
    localActionIndex + 1,
  );
  const narrationEndIndex = events.indexOf(
    "narration_end",
    narrationStartIndex + 1,
  );
  const localActionObserved = localActionIndex >= 0;
  const narrationStarted = localActionObserved && narrationStartIndex >= 0;
  const narrationEnded = narrationStarted && narrationEndIndex >= 0;
  return {
    localActionObserved,
    narrationStarted,
    narrationEnded,
    pass: localActionObserved && narrationStarted && narrationEnded,
  };
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function pollUntil(timeoutMs, observe, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    latest = await observe();
    if (latest.done) return latest;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return latest ?? { done: false, value: null };
}

function durationBucket(milliseconds) {
  if (milliseconds < 5_000) return "under_5s";
  if (milliseconds < 15_000) return "under_15s";
  if (milliseconds < 30_000) return "under_30s";
  return "30s_or_more";
}

export function loadingCueWithinDeadline(milliseconds) {
  return (
    Number.isFinite(milliseconds) &&
    milliseconds >= 0 &&
    milliseconds <= MAX_LOADING_CUE_LATENCY_MS
  );
}

class PhysicalDevice {
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

  async inject(caseId) {
    await runAdb(
      this.options,
      ["shell", buildTranscriptInjectionCommand(caseId)],
      { timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 },
      "the fixed transcript injection failed",
    );
  }

  async loadingCue(caseId, devicePort, correlationMarker) {
    return runLoadingMessageRpc(
      this.options,
      devicePort,
      caseId,
      correlationMarker,
    );
  }

  async promptRows() {
    return parsePromptActivityPage(
      await deviceActivityRequest(this.options, this.token, PROMPT_ACTIVITY_PATH),
    );
  }

  async musicRows() {
    return parseMusicActivityPage(
      await deviceActivityRequest(this.options, this.token, MUSIC_ACTIVITY_PATH),
    );
  }

  async deletePrompt(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new SafePhysicalError("invalid cleanup row");
    await deviceActivityRequest(
      this.options,
      this.token,
      `/api/activity/prompts/${id}`,
      "DELETE",
    );
  }

  async deleteMusic(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new SafePhysicalError("invalid cleanup row");
    await deviceActivityRequest(
      this.options,
      this.token,
      `/api/activity/music/${id}`,
      "DELETE",
    );
  }

  async pids(packageName) {
    if (packageName !== MUSIC_PACKAGE && packageName !== TICKLE_PACKAGE) {
      throw new SafePhysicalError("refusing an unapproved package observation");
    }
    const completed = await captureChild(
      this.options.adbPath,
      ["-s", this.options.serial, "shell", "pidof", packageName],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
    );
    if (completed.code === 1 && completed.stdout.length === 0) return [];
    if (completed.code !== 0) throw new SafePhysicalError("a package process observation failed");
    return parsePidSet(completed.stdout);
  }

  async forceStop(packageName) {
    if (packageName !== MUSIC_PACKAGE && packageName !== TICKLE_PACKAGE) {
      throw new SafePhysicalError("refusing an unapproved package cleanup");
    }
    await runAdb(
      this.options,
      ["shell", "am", "force-stop", packageName],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
      "a stock experience cleanup failed",
    );
  }

  async media() {
    return parseMediaSessionSummary(
      await runAdb(
        this.options,
        ["shell", "dumpsys", "media_session"],
        { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
        "the media-session observation failed",
      ),
    );
  }

  async tickleForeground() {
    return tickleActivityIsForeground(
      await runAdb(
        this.options,
        ["shell", "dumpsys", "activity", "activities", TICKLE_PACKAGE],
        { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
        "the stock activity observation failed",
      ),
    );
  }

  async beginHookEvidence() {
    const marker = `physical-simple-${randomUUID()}`;
    await runAdb(
      this.options,
      ["shell", "log", "-p", "i", "-t", HOOK_BOUNDARY_TAG, marker],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
      "the hook evidence boundary could not be created",
    );
    return marker;
  }

  async hookEvidenceSince(boundaryMarker) {
    if (!HOOK_BOUNDARY_PATTERN.test(boundaryMarker)) {
      throw new SafePhysicalError("the hook evidence boundary was malformed");
    }
    return parsePenumbraHookEvidence(
      await runAdb(
        this.options,
        [
          "shell",
          "logcat",
          "-b",
          "main",
          "-v",
          "epoch",
          "-d",
          `${HOOK_LOG_TAG}:V`,
          `${HOOK_BOUNDARY_TAG}:I`,
          "*:S",
        ],
        { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
        "the hook evidence observation failed",
      ),
      boundaryMarker,
    );
  }

  async beginProgressEvidence() {
    const marker = `physical-loading-${randomUUID()}`;
    await runAdb(
      this.options,
      ["shell", "log", "-p", "i", "-t", HOOK_BOUNDARY_TAG, marker],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
      "the progress evidence boundary could not be created",
    );
    return marker;
  }

  async progressEvidenceSince(caseId, boundaryMarker) {
    if (!PROGRESS_BOUNDARY_PATTERN.test(boundaryMarker)) {
      throw new SafePhysicalError("the progress evidence boundary was malformed");
    }
    return evaluateProgressModelEvidence(
      caseId,
      await runAdb(
        this.options,
        [
          "shell",
          "logcat",
          "-b",
          "main",
          "-v",
          "epoch",
          "-d",
          `${SERVER_LOG_TAG}:V`,
          `${HOOK_BOUNDARY_TAG}:I`,
          "*:S",
        ],
        { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
        "the progress evidence observation failed",
      ),
      boundaryMarker,
    );
  }

  async beginAgenticEvidence() {
    const marker = `physical-agentic-${randomUUID()}`;
    await runAdb(
      this.options,
      ["shell", "log", "-p", "i", "-t", HOOK_BOUNDARY_TAG, marker],
      { timeoutMs: 10_000, maxStdoutBytes: 1_024 },
      "the agentic evidence boundary could not be created",
    );
    return marker;
  }

  async agenticEvidenceSince(caseId, boundaryMarker, expectedCorrelation) {
    if (!AGENTIC_BOUNDARY_PATTERN.test(boundaryMarker)) {
      throw new SafePhysicalError("the agentic evidence boundary was malformed");
    }
    return evaluateAgenticTraceEvidence(
      caseId,
      await runAdb(
        this.options,
        [
          "shell",
          "logcat",
          "-b",
          "main",
          "-v",
          "epoch",
          "-d",
          `${SERVER_LOG_TAG}:V`,
          `${HOOK_BOUNDARY_TAG}:I`,
          "*:S",
        ],
        { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
        "the agentic evidence observation failed",
      ),
      boundaryMarker,
      expectedCorrelation,
    );
  }

  async localWeatherEvidenceSince(caseId, boundaryMarker, expectedCorrelation) {
    if (!AGENTIC_BOUNDARY_PATTERN.test(boundaryMarker)) {
      throw new SafePhysicalError("the local-weather evidence boundary was malformed");
    }
    return evaluateLocalWeatherTraceEvidence(
      caseId,
      await runAdb(
        this.options,
        [
          "shell",
          "logcat",
          "-b",
          "main",
          "-v",
          "epoch",
          "-d",
          `${SERVER_LOG_TAG}:V`,
          `${HOOK_BOUNDARY_TAG}:I`,
          "*:S",
        ],
        { timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
        "the local-weather evidence observation failed",
      ),
      boundaryMarker,
      expectedCorrelation,
    );
  }
}

function taggedBoolean(value, expected) {
  return (
    plainObject(value) &&
    Object.keys(value).length === 2 &&
    value.type === "bool" &&
    value.value === expected
  );
}

export function evaluatePhysicalReadiness(snapshot, identity, expected) {
  const tickle = Array.isArray(snapshot?.featureFlags?.flags)
    ? snapshot.featureFlags.flags.find(
        (flag) => flag?.key === FEATURE_FLAGS.cloud.tickle,
      )
    : undefined;
  const cosmosAuthority = [
    "llm",
    "weather",
    "google_maps",
    "brave_search",
    "azure_speech",
    "openstreetmap",
  ].every((key) => snapshot?.settings?.[key] === undefined);
  const checks = {
    exactServerIdentity:
      identity?.packageName === SERVER_PACKAGE &&
      identity?.versionName === expected.versionName &&
      identity?.versionCode === expected.versionCode &&
      identity?.apkSha256 === expected.apkSha256 &&
      snapshot?.health?.status === "ok" &&
      snapshot?.health?.version === expected.versionName,
    authenticatedCenter: snapshot?.settings?.server?.admin_token_auth === true,
    noRestartPending: snapshot?.settings?.restart_required === false,
    aibusLoopback:
      parseLoopbackGrpcPort(snapshot?.settings?.server?.grpc_bind_addr) !== null,
    cosmosAuthority,
    weatherReady: cosmosAuthority,
    weatherLocalityReady: cosmosAuthority,
    spotifyReady:
      snapshot?.spotify?.enabled === true &&
      snapshot?.spotify?.experimental_acknowledged === true &&
      snapshot?.spotify?.state === "ready" &&
      snapshot?.spotify?.engine_ready === true,
    tickleReady:
      taggedBoolean(tickle?.desired_value, true) &&
      taggedBoolean(tickle?.assignment_value, true) &&
      snapshot?.featureFlags?.delivery?.state === "stock_cache_applied" &&
      snapshot?.featureFlags?.delivery?.stock_cache_verified === true,
  };
  return {
    checks,
    globalPass:
      checks.exactServerIdentity &&
      checks.authenticatedCenter &&
      checks.noRestartPending &&
      checks.aibusLoopback,
    pass: Object.values(checks).every(Boolean),
  };
}

async function observeLoadingMessageCase(device, item, grpcPort) {
  const started = Date.now();
  const progressBoundary = await device.beginProgressEvidence();
  const cueStarted = Date.now();
  const loadingResponse = await device.loadingCue(
    item.id,
    grpcPort,
    progressBoundary,
  );
  const cueDeadlineObserved = loadingCueWithinDeadline(
    Date.now() - cueStarted,
  );
  const cueEvidence = evaluateLoadingCueEvidence(
    item.id,
    loadingResponse,
  );
  const progressObservation = await pollUntil(
    PHYSICAL_TIMEOUT_MS.loadingEvidence,
    async () => {
      const evidence = await device.progressEvidenceSince(
        item.id,
        progressBoundary,
      );
      return { done: evidence.pass, value: evidence };
    },
  );
  const progressEvidence = progressObservation.value ?? {
    pass: false,
    correlationMatched: false,
    emissionMatched: false,
    sparkObserved: item.isUnlocked ? false : null,
    lockedFallbackObserved: item.isUnlocked ? null : false,
  };
  const pass =
    cueEvidence.pass && cueDeadlineObserved && progressEvidence.pass;
  return {
    id: item.id,
    status: pass ? "pass" : "fail",
    route_observed:
      cueEvidence.categoryAppropriate && progressEvidence.emissionMatched,
    physical_effect_observed: null,
    allowlisted_cue_observed: cueEvidence.allowlisted,
    expected_cue_observed: cueEvidence.categoryAppropriate,
    cue_deadline_observed: cueDeadlineObserved,
    correlation_observed: progressEvidence.correlationMatched,
    model_provenance_observed: progressEvidence.sparkObserved,
    locked_fallback_provenance_observed:
      progressEvidence.lockedFallbackObserved,
    semantic_category_observed: item.isUnlocked
      ? cueEvidence.categoryAppropriate && progressEvidence.sparkObserved
      : null,
    locked_neutral_observed: item.isUnlocked
      ? null
      : cueEvidence.lockedNeutralObserved &&
        progressEvidence.lockedFallbackObserved,
    terminal_observed: null,
    locality_observed: null,
    duration_bucket: durationBucket(Date.now() - started),
  };
}

async function observeSimpleCase(device, item, baselinePromptId, ownedPromptIds) {
  const started = Date.now();
  const hookBoundary = await device.beginHookEvidence();
  await device.inject(item.id);
  const observation = await pollUntil(PHYSICAL_TIMEOUT_MS.simple, async () => {
    const [rows, hookEvents] = await Promise.all([
      device.promptRows(),
      device.hookEvidenceSince(hookBoundary),
    ]);
    const promptEvidence = evaluatePromptEvidence(item.id, rows, baselinePromptId);
    promptEvidence.ownedIds.forEach((id) => ownedPromptIds.add(id));
    const hookEvidence = evaluateSimpleHookEvidence(
      hookEvents,
      item.expectedAction,
    );
    const evidence = {
      pass: hookEvidence.pass,
      routeObserved: hookEvidence.localActionObserved,
      localActionObserved: hookEvidence.localActionObserved,
      narrationStarted: hookEvidence.narrationStarted,
      narrationEnded: hookEvidence.narrationEnded,
    };
    return { done: evidence.pass, value: evidence };
  });
  const evidence = observation.value ?? {
    pass: false,
    routeObserved: false,
    localActionObserved: false,
    narrationStarted: false,
    narrationEnded: false,
  };
  return {
    id: item.id,
    status: evidence.pass ? "pass" : "fail",
    route_observed: evidence.routeObserved,
    physical_effect_observed: null,
    terminal_observed: evidence.narrationStarted && evidence.narrationEnded,
    locality_observed: null,
    duration_bucket: durationBucket(Date.now() - started),
  };
}

async function observeWeatherCase(device, item, baselinePromptId, ownedPromptIds) {
  const started = Date.now();
  const traceBoundary = await device.beginAgenticEvidence();
  await device.inject(item.id);
  const collectEvidence = async () => {
    const rows = await device.promptRows();
    const expectedCorrelation = attributedLocalWeatherCorrelation(
      rows,
      baselinePromptId,
      item.id,
    );
    const [traceEvidence, promptEvidence] = await Promise.all([
      device.localWeatherEvidenceSince(
        item.id,
        traceBoundary,
        expectedCorrelation,
      ),
      Promise.resolve(evaluatePromptEvidence(item.id, rows, baselinePromptId)),
    ]);
    promptEvidence.ownedIds.forEach((id) => ownedPromptIds.add(id));
    return {
      pass: promptEvidence.pass && traceEvidence.pass,
      routeObserved: promptEvidence.routeObserved,
      exactTraceObserved: traceEvidence.exactOrder,
      correlationObserved: traceEvidence.correlationMatched,
      ordinalSequenceObserved: traceEvidence.ordinalsContiguous,
      freshLocationObserved: traceEvidence.freshLocationObserved,
      reverseGeocodeObserved: traceEvidence.reverseGeocodeObserved,
      weatherProviderObserved: traceEvidence.weatherProviderObserved,
      terminalObserved:
        promptEvidence.terminalObserved && traceEvidence.terminalObserved,
      localityObserved: promptEvidence.localityObserved,
      traceEventCount: traceEvidence.eventCount,
    };
  };
  const observation = await pollUntil(PHYSICAL_TIMEOUT_MS.weather, async () => {
    const evidence = await collectEvidence();
    return { done: evidence.pass, value: evidence };
  });
  let evidence = observation.value ?? {
    pass: false,
    routeObserved: false,
    exactTraceObserved: false,
    correlationObserved: false,
    ordinalSequenceObserved: false,
    freshLocationObserved: false,
    reverseGeocodeObserved: false,
    weatherProviderObserved: false,
    terminalObserved: false,
    localityObserved: false,
    traceEventCount: 0,
  };
  if (observation.done) {
    await sleep(500);
    evidence = await collectEvidence();
  }
  return {
    id: item.id,
    status: evidence.pass ? "pass" : "fail",
    route_observed:
      evidence.routeObserved &&
      evidence.exactTraceObserved &&
      evidence.correlationObserved &&
      evidence.ordinalSequenceObserved,
    // Prompt activity proves the terminal response, not audible speech or a
    // projector effect. Those remain explicitly unobserved below.
    physical_effect_observed: null,
    exact_tool_chain_observed: evidence.exactTraceObserved,
    correlation_observed: evidence.correlationObserved,
    fresh_location_observed: evidence.freshLocationObserved,
    reverse_geocode_observed: evidence.reverseGeocodeObserved,
    weather_provider_observed: evidence.weatherProviderObserved,
    trace_event_count: evidence.traceEventCount,
    terminal_observed: evidence.terminalObserved,
    locality_observed: evidence.localityObserved,
    duration_bucket: durationBucket(Date.now() - started),
  };
}

async function observeAgenticRemoteWeatherCase(
  device,
  item,
  baselinePromptId,
  ownedPromptIds,
) {
  const started = Date.now();
  const traceBoundary = await device.beginAgenticEvidence();
  await device.inject(item.id);
  const collectEvidence = async () => {
    const rows = await device.promptRows();
    const expectedCorrelation = attributedAgenticCorrelation(
      rows,
      baselinePromptId,
      item.id,
    );
    const traceEvidence = await device.agenticEvidenceSince(
      item.id,
      traceBoundary,
      expectedCorrelation,
    );
    const promptEvidence = evaluatePromptEvidence(
      item.id,
      rows,
      baselinePromptId,
    );
    promptEvidence.ownedIds.forEach((id) => ownedPromptIds.add(id));
    return {
      pass: promptEvidence.pass && traceEvidence.pass,
      exactTraceObserved: traceEvidence.exactOrder,
      correlationObserved: traceEvidence.correlationMatched,
      ordinalSequenceObserved: traceEvidence.ordinalsContiguous,
      currentLocationObserved:
        promptEvidence.currentLocationObserved ||
        traceEvidence.currentLocationObserved,
      terminalObserved:
        promptEvidence.terminalObserved && traceEvidence.terminalObserved,
      localityObserved: promptEvidence.localityObserved,
      franceGrounded: promptEvidence.franceGrounded,
      wrongCountryObserved: promptEvidence.wrongCountryObserved,
      traceEventCount: traceEvidence.eventCount,
    };
  };
  const observation = await pollUntil(
    PHYSICAL_TIMEOUT_MS.agenticRemoteWeather,
    async () => {
      const evidence = await collectEvidence();
      return { done: evidence.pass, value: evidence };
    },
  );
  let evidence = observation.value ?? {
    pass: false,
    exactTraceObserved: false,
    correlationObserved: false,
    ordinalSequenceObserved: false,
    currentLocationObserved: false,
    terminalObserved: false,
    localityObserved: false,
    franceGrounded: false,
    wrongCountryObserved: false,
    traceEventCount: 0,
  };
  if (observation.done) {
    await sleep(500);
    evidence = await collectEvidence();
  }
  return {
    id: item.id,
    status: evidence.pass ? "pass" : "fail",
    route_observed:
      evidence.exactTraceObserved &&
      evidence.correlationObserved &&
      evidence.ordinalSequenceObserved &&
      !evidence.currentLocationObserved,
    physical_effect_observed: null,
    exact_tool_chain_observed: evidence.exactTraceObserved,
    correlation_observed: evidence.correlationObserved,
    current_location_observed: evidence.currentLocationObserved,
    trace_event_count: evidence.traceEventCount,
    terminal_observed: evidence.terminalObserved,
    locality_observed: evidence.localityObserved,
    france_grounded: evidence.franceGrounded,
    wrong_country_observed: evidence.wrongCountryObserved,
    duration_bucket: durationBucket(Date.now() - started),
  };
}

async function stopAndConfirm(device, packageName) {
  await device.forceStop(packageName);
  const stopped = await pollUntil(PHYSICAL_TIMEOUT_MS.cleanup, async () => {
    const pids = await device.pids(packageName);
    return { done: pids.length === 0, value: pids.length === 0 };
  });
  return stopped.value === true;
}

async function observeTicklePositive(device, item, baselinePromptId, ownedPromptIds) {
  const started = Date.now();
  const observedPidSets = new Set();
  const hookBoundary = await device.beginHookEvidence();
  await device.inject(item.id);
  const observation = await pollUntil(PHYSICAL_TIMEOUT_MS.ticklePositive, async () => {
    const [rows, pids, foreground, hookEvents] = await Promise.all([
      device.promptRows(),
      device.pids(TICKLE_PACKAGE),
      device.tickleForeground(),
      device.hookEvidenceSince(hookBoundary),
    ]);
    if (pids.length > 0) observedPidSets.add(pids.join(","));
    const promptEvidence = evaluatePromptEvidence(item.id, rows, baselinePromptId);
    promptEvidence.ownedIds.forEach((id) => ownedPromptIds.add(id));
    const actionEvidence = evaluateNativeActionHookEvidence(
      hookEvents,
      item.expectedAction,
    );
    const pass =
      actionEvidence.pass &&
      pids.length > 0 &&
      foreground &&
      observedPidSets.size === 1;
    return {
      done: pass,
      value: {
        pass,
        routeObserved: actionEvidence.exactActionObserved,
        processObserved: pids.length > 0,
        foregroundObserved: foreground,
        oneProcessGeneration: observedPidSets.size <= 1,
      },
    };
  });
  if (observation.done) {
    await sleep(1_500);
    const [rows, pids, foreground, hookEvents] = await Promise.all([
      device.promptRows(),
      device.pids(TICKLE_PACKAGE),
      device.tickleForeground(),
      device.hookEvidenceSince(hookBoundary),
    ]);
    if (pids.length > 0) observedPidSets.add(pids.join(","));
    const promptEvidence = evaluatePromptEvidence(item.id, rows, baselinePromptId);
    promptEvidence.ownedIds.forEach((id) => ownedPromptIds.add(id));
    const stableEvidence = evaluateNativeActionHookEvidence(
      hookEvents,
      item.expectedAction,
    );
    const stable =
      stableEvidence.pass &&
      pids.length > 0 &&
      foreground &&
      observedPidSets.size === 1;
    observation.value.pass &&= stable;
    observation.value.routeObserved &&= stableEvidence.exactActionObserved;
    observation.value.processObserved &&= pids.length > 0;
    observation.value.foregroundObserved &&= foreground;
    observation.value.oneProcessGeneration &&= observedPidSets.size === 1;
  }
  const cleaned = await stopAndConfirm(device, TICKLE_PACKAGE);
  const evidence = observation.value ?? {
    pass: false,
    routeObserved: false,
    processObserved: false,
    foregroundObserved: false,
    oneProcessGeneration: false,
  };
  const pass = evidence.pass && cleaned;
  return {
    id: item.id,
    status: pass ? "pass" : "fail",
    route_observed: evidence.routeObserved,
    launcher_observed:
      evidence.processObserved && evidence.foregroundObserved && evidence.oneProcessGeneration,
    // A foreground stock activity proves launcher delivery only. Acoustic or
    // Haptic output from the stock tickle action still requires an external
    // human/sensor observer.
    physical_effect_observed: null,
    cleanup_restored_idle: cleaned,
    terminal_observed: null,
    locality_observed: null,
    duration_bucket: durationBucket(Date.now() - started),
  };
}

async function observeTickleNegative(device, item, baselinePromptId, ownedPromptIds) {
  const started = Date.now();
  let escapedProcess = false;
  let escapedForeground = false;
  let escapedRoute = false;
  let terminalObserved = false;
  const hookBoundary = await device.beginHookEvidence();
  await device.inject(item.id);
  const deadline = Date.now() + PHYSICAL_TIMEOUT_MS.tickleNegative;
  do {
    const [rows, pids, foreground, hookEvents] = await Promise.all([
      device.promptRows(),
      device.pids(TICKLE_PACKAGE),
      device.tickleForeground(),
      device.hookEvidenceSince(hookBoundary),
    ]);
    const evidence = evaluatePromptEvidence(item.id, rows, baselinePromptId);
    evidence.ownedIds.forEach((id) => ownedPromptIds.add(id));
    const actionEvidence = evaluateNativeActionHookEvidence(
      hookEvents,
      NATIVE_ACTIONS.TICKLE,
    );
    // No attributed response is pending evidence, not a launcher escape. Keep
    // observing the whole negative-control window after a harmless terminal so
    // a delayed tickle route/process cannot hide behind an early response.
    escapedRoute ||=
      evidence.actionEscaped === true || actionEvidence.expectedActionCount > 0;
    terminalObserved ||= evidence.terminalObserved;
    escapedProcess ||= pids.length > 0;
    escapedForeground ||= foreground;
    if (escapedRoute || escapedProcess || escapedForeground) break;
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  const cleaned = await stopAndConfirm(device, TICKLE_PACKAGE);
  const pass =
    terminalObserved && !escapedRoute && !escapedProcess && !escapedForeground && cleaned;
  return {
    id: item.id,
    status: pass ? "pass" : "fail",
    route_observed: terminalObserved && !escapedRoute,
    launcher_observed: escapedProcess || escapedForeground,
    physical_effect_observed: null,
    cleanup_restored_idle: cleaned,
    terminal_observed: terminalObserved,
    locality_observed: null,
    duration_bucket: durationBucket(Date.now() - started),
  };
}

function normalizedMusicText(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function normalizedArtistSet(artists) {
  return [...new Set(artists.map(normalizedMusicText).filter(Boolean))].sort();
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function findAttributedMusic(rows, baselineMusicId, rankOne) {
  const candidates = rows.filter((row) => row.id > baselineMusicId);
  const expectedTitle = normalizedMusicText(rankOne.title);
  const expectedArtists = normalizedArtistSet(rankOne.artists);
  const expectedAlbum = normalizedMusicText(rankOne.album ?? "");
  const matching = candidates.find(
    (row) =>
      normalizedMusicText(row.title) === expectedTitle &&
      sameStringArray(normalizedArtistSet(row.artists), expectedArtists) &&
      (expectedAlbum.length === 0 || normalizedMusicText(row.album) === expectedAlbum),
  );
  return { candidates, matching };
}

async function observeMusicCase(
  device,
  item,
  baselinePromptId,
  baselineMusicId,
  rankOne,
  ownedPromptIds,
  ownedMusicIds,
) {
  const started = Date.now();
  let injected = false;
  let firstMedia = null;
  let routeObserved = false;
  let providerMatch = false;
  let playingObserved = false;
  let processObserved = false;
  let advanced = false;
  let pauseRouteObserved = false;
  let cleanupIdle = false;
  try {
    await device.inject(item.id);
    injected = true;
    const observation = await pollUntil(PHYSICAL_TIMEOUT_MS.music, async () => {
      const [promptRows, musicRows, media, pids] = await Promise.all([
        device.promptRows(),
        device.musicRows(),
        device.media(),
        device.pids(MUSIC_PACKAGE),
      ]);
      const promptEvidence = evaluatePromptEvidence(item.id, promptRows, baselinePromptId);
      promptEvidence.ownedIds.forEach((id) => ownedPromptIds.add(id));
      const attributedMusic = findAttributedMusic(musicRows, baselineMusicId, rankOne);
      if (attributedMusic.matching !== undefined) {
        ownedMusicIds.add(attributedMusic.matching.id);
      }
      routeObserved ||= promptEvidence.routeObserved;
      providerMatch ||= attributedMusic.matching !== undefined;
      playingObserved ||=
        media.playing && attributedMusic.matching?.status === "playing";
      processObserved ||= pids.length > 0;
      if (playingObserved && firstMedia === null) firstMedia = media;
      return {
        done: routeObserved && providerMatch && playingObserved && processObserved,
        value: null,
      };
    });
    if (observation.done && firstMedia !== null) {
      const stabilityStarted = Date.now();
      await sleep(MUSIC_STABILITY_WINDOW_MS);
      advanced = mediaPositionAdvanced(
        firstMedia,
        await device.media(),
        Date.now() - stabilityStarted,
      );
    }
  } finally {
    if (injected) {
      try {
        const pauseHookBoundary = await device.beginHookEvidence();
        await device.inject(PAUSE_CLEANUP_CASE.id);
        const pauseObservation = await pollUntil(PHYSICAL_TIMEOUT_MS.cleanup, async () => {
          const [promptRows, media, hookEvents] = await Promise.all([
            device.promptRows(),
            device.media(),
            device.hookEvidenceSince(pauseHookBoundary),
          ]);
          const evidence = evaluatePromptEvidence(
            PAUSE_CLEANUP_CASE.id,
            promptRows,
            baselinePromptId,
          );
          evidence.ownedIds.forEach((id) => ownedPromptIds.add(id));
          const actionEvidence = evaluateNativeActionHookEvidence(
            hookEvents,
            NATIVE_ACTIONS.PAUSE_MUSIC,
          );
          pauseRouteObserved ||=
            evidence.routeObserved || actionEvidence.exactActionObserved;
          return {
            done: pauseRouteObserved && !media.playing,
            value: !media.playing,
          };
        });
        cleanupIdle = pauseObservation.value === true;
      } catch {
        cleanupIdle = false;
      }
      try {
        cleanupIdle = (await stopAndConfirm(device, MUSIC_PACKAGE)) && cleanupIdle;
      } catch {
        cleanupIdle = false;
      }
    }
  }
  const pass =
    routeObserved &&
    providerMatch &&
    playingObserved &&
    processObserved &&
    advanced &&
    pauseRouteObserved &&
    cleanupIdle;
  return {
    id: item.id,
    status: pass ? "pass" : "fail",
    route_observed: routeObserved,
    physical_effect_observed: playingObserved && processObserved && advanced,
    provider_rank_one_match: providerMatch,
    pause_route_observed: pauseRouteObserved,
    cleanup_restored_idle: cleanupIdle,
    terminal_observed: null,
    locality_observed: null,
    duration_bucket: durationBucket(Date.now() - started),
  };
}

async function removeOwnedRows(device, promptIds, musicIds) {
  let promptsRemoved = true;
  let musicRemoved = true;
  for (const id of [...promptIds].sort((a, b) => a - b)) {
    try {
      await device.deletePrompt(id);
    } catch {
      promptsRemoved = false;
    }
  }
  for (const id of [...musicIds].sort((a, b) => a - b)) {
    try {
      await device.deleteMusic(id);
    } catch {
      musicRemoved = false;
    }
  }
  return { promptsRemoved, musicRemoved };
}

function blockedCase(item, reason) {
  return {
    id: item.id,
    status: "blocked",
    reason,
    route_observed: false,
    physical_effect_observed: false,
    terminal_observed: null,
    locality_observed: null,
    duration_bucket: "not_run",
  };
}

export async function executePhysicalSuite(options, dependencies = {}) {
  try {
    validateSerial(options?.serial);
  } catch {
    throw new SafePhysicalError("a valid explicit ADB serial is required");
  }
  if (
    options?.expectedVersionName !== RELEASE_IDENTITY.versionName ||
    options?.expectedVersionCode !== RELEASE_IDENTITY.versionCode ||
    options?.expectedApkSha256 !== RELEASE_IDENTITY.apkSha256
  ) {
    throw new SafePhysicalError("refusing an unpinned candidate identity");
  }
  const selectedCaseId = options.caseId ?? null;
  if (selectedCaseId === null || !PUBLIC_CASE_IDS.has(selectedCaseId)) {
    throw new SafePhysicalError("unknown fixed physical case");
  }
  const selectedCases = [caseForId(selectedCaseId)];
  const needsPromptActivity = selectedCases.some(
    (item) => item.kind !== "loading_message",
  );
  const needsMusicState = selectedCases.some((item) => item.kind === "music");
  const needsTickleState = selectedCases.some(
    (item) =>
      item.kind === "tickle_positive" || item.kind === "tickle_negative",
  );
  const token = dependencies.token ?? (await readAdminToken());
  const device = dependencies.device ?? new PhysicalDevice(options, token);
  const identity =
    dependencies.identity ?? (await collectInstalledServerIdentity(options));
  const snapshot =
    dependencies.snapshot ?? (await collectReadiness(options, token));
  const readiness = evaluatePhysicalReadiness(snapshot, identity, {
    versionName: options.expectedVersionName,
    versionCode: options.expectedVersionCode,
    apkSha256: options.expectedApkSha256,
  });
  if (!readiness.globalPass) {
    return {
      schema_version: 1,
      mode: "physical_transcript_injection",
      selected_case: selectedCaseId,
      status: "blocked",
      prerequisites: readiness.checks,
      cases: [],
      cleanup: {
        prompt_activity_removed: null,
        music_activity_removed: null,
        music_not_playing: null,
        tickle_not_running: null,
        media_volume_snapshot_captured: null,
        media_volume_restored: null,
      },
      limitations: [
        "post_asr_injection_only",
        "audible_speech_not_observed",
        "projector_not_observed",
      ],
    };
  }
  const grpcPort = parseLoopbackGrpcPort(snapshot.settings.server.grpc_bind_addr);
  if (grpcPort === null) {
    throw new SafePhysicalError("the loopback AIBus listener was unavailable");
  }

  const [
    baselinePromptRows,
    baselineMusicRows,
    initialTicklePids,
    initialTickleForeground,
    initialMusicPids,
    initialMedia,
  ] = await Promise.all([
    needsPromptActivity ? device.promptRows() : Promise.resolve([]),
    needsMusicState ? device.musicRows() : Promise.resolve([]),
    needsTickleState ? device.pids(TICKLE_PACKAGE) : Promise.resolve([]),
    needsTickleState ? device.tickleForeground() : Promise.resolve(false),
    needsMusicState ? device.pids(MUSIC_PACKAGE) : Promise.resolve([]),
    needsMusicState
      ? device.media()
      : Promise.resolve({ sessionCount: 0, playing: false }),
  ]);
  const baselinePromptId = maximumId(baselinePromptRows);
  const baselineMusicId = maximumId(baselineMusicRows);
  const tickleWasIdle =
    needsTickleState &&
    initialTicklePids.length === 0 &&
    !initialTickleForeground;
  const musicWasIdle =
    needsMusicState &&
    initialMusicPids.length === 0 &&
    initialMedia.sessionCount === 0;
  const ownedPromptIds = new Set();
  const ownedMusicIds = new Set();
  const cases = [];
  let rankOne = null;

  let tickleTouched = false;
  let musicTouched = false;
  let pendingFailure = null;
  let cleanupRows = { promptsRemoved: true, musicRemoved: true };
  const mediaVolumeSnapshot = needsPromptActivity
    ? await captureStableMediaVolumeSnapshot(device)
    : null;
  let mediaVolumeRestored = needsPromptActivity ? false : null;
  try {
    for (const item of selectedCases) {
      if (item.kind === "loading_message") {
        if (item.isUnlocked && !readiness.checks.cosmosAuthority) {
          cases.push(blockedCase(item, "cosmos_provider_authority_unavailable"));
        } else {
          cases.push(await observeLoadingMessageCase(device, item, grpcPort));
        }
      } else if (item.kind === "simple_action") {
        cases.push(
          await observeSimpleCase(device, item, baselinePromptId, ownedPromptIds),
        );
      } else if (item.kind === "weather") {
        if (!readiness.checks.weatherReady) {
          cases.push(blockedCase(item, "weather_provider_unavailable"));
        } else if (!readiness.checks.weatherLocalityReady) {
          cases.push(blockedCase(item, "weather_locality_provider_unavailable"));
        } else {
          cases.push(
            await observeWeatherCase(device, item, baselinePromptId, ownedPromptIds),
          );
        }
      } else if (item.kind === "agentic_remote_weather") {
        if (!readiness.checks.cosmosAuthority) {
          cases.push(blockedCase(item, "cosmos_provider_authority_unavailable"));
        } else if (!readiness.checks.weatherReady) {
          cases.push(blockedCase(item, "weather_provider_unavailable"));
        } else if (!readiness.checks.weatherLocalityReady) {
          cases.push(blockedCase(item, "place_provider_unavailable"));
        } else {
          cases.push(
            await observeAgenticRemoteWeatherCase(
              device,
              item,
              baselinePromptId,
              ownedPromptIds,
            ),
          );
        }
      } else if (item.kind === "music") {
        if (!readiness.checks.spotifyReady) {
          cases.push(blockedCase(item, "spotify_provider_unavailable"));
        } else if (!musicWasIdle) {
          cases.push(blockedCase(item, "preexisting_music_state"));
        } else {
          rankOne = dependencies.rankOne ?? (await collectFixedMusicRankOne(options, token));
          if (rankOne === null) {
            cases.push(blockedCase(item, "provider_rank_one_unavailable"));
          } else {
            musicTouched = true;
            cases.push(
              await observeMusicCase(
                device,
                item,
                baselinePromptId,
                baselineMusicId,
                rankOne,
                ownedPromptIds,
                ownedMusicIds,
              ),
            );
          }
        }
      } else if (item.kind === "tickle_positive") {
        if (!readiness.checks.tickleReady) {
          cases.push(blockedCase(item, "tickle_gate_unavailable"));
        } else if (!tickleWasIdle) {
          cases.push(blockedCase(item, "preexisting_tickle_state"));
        } else {
          tickleTouched = true;
          cases.push(
            await observeTicklePositive(device, item, baselinePromptId, ownedPromptIds),
          );
        }
      } else if (item.kind === "tickle_negative") {
        if (!readiness.checks.tickleReady) {
          cases.push(blockedCase(item, "tickle_gate_unavailable"));
        } else if (!tickleWasIdle) {
          cases.push(blockedCase(item, "preexisting_tickle_state"));
        } else {
          tickleTouched = true;
          cases.push(
            await observeTickleNegative(device, item, baselinePromptId, ownedPromptIds),
          );
        }
      }
    }
  } catch (error) {
    pendingFailure = error;
  } finally {
    if (tickleWasIdle && tickleTouched) {
      try {
        await stopAndConfirm(device, TICKLE_PACKAGE);
      } catch {}
    }
    if (musicWasIdle && musicTouched) {
      try {
        await stopAndConfirm(device, MUSIC_PACKAGE);
      } catch {}
    }
    if (needsPromptActivity) {
      try {
        const rows = await device.promptRows();
        const cleanupCases = needsMusicState
          ? [...selectedCases, PAUSE_CLEANUP_CASE]
          : selectedCases;
        for (const item of cleanupCases) {
          for (const row of attributedPromptRows(rows, baselinePromptId, item.id)) {
            ownedPromptIds.add(row.id);
          }
        }
      } catch {}
    }
    if (needsMusicState && rankOne !== null) {
      try {
        const attributed = findAttributedMusic(
          await device.musicRows(),
          baselineMusicId,
          rankOne,
        );
        if (attributed.matching !== undefined) {
          ownedMusicIds.add(attributed.matching.id);
        }
      } catch {}
    }
    cleanupRows = await removeOwnedRows(device, ownedPromptIds, ownedMusicIds);
    if (mediaVolumeSnapshot !== null) {
      mediaVolumeRestored = await restoreMediaVolumeSnapshot(
        device,
        mediaVolumeSnapshot,
      );
    }
  }
  if (pendingFailure !== null) throw pendingFailure;
  const [finalTicklePids, finalTickleForeground, finalMusicPids, finalMedia] =
    await Promise.all([
      needsTickleState ? device.pids(TICKLE_PACKAGE) : Promise.resolve([]),
      needsTickleState ? device.tickleForeground() : Promise.resolve(false),
      needsMusicState ? device.pids(MUSIC_PACKAGE) : Promise.resolve([]),
      needsMusicState
        ? device.media()
        : Promise.resolve({ sessionCount: 0, playing: false }),
    ]);
  const cleanup = {
    prompt_activity_removed: needsPromptActivity
      ? cleanupRows.promptsRemoved
      : null,
    music_activity_removed: needsMusicState ? cleanupRows.musicRemoved : null,
    music_not_playing:
      needsMusicState && musicWasIdle
        ? finalMusicPids.length === 0 && !finalMedia.playing
        : null,
    tickle_not_running:
      needsTickleState && tickleWasIdle
        ? finalTicklePids.length === 0 && !finalTickleForeground
        : null,
    media_volume_snapshot_captured:
      needsPromptActivity ? mediaVolumeSnapshot !== null : null,
    media_volume_restored: mediaVolumeRestored,
  };
  const allCasesPassed = cases.every((item) => item.status === "pass");
  const cleanupPassed = Object.values(cleanup).every((value) => value !== false);
  return {
    schema_version: 1,
    mode: "physical_transcript_injection",
    selected_case: selectedCaseId,
    status: allCasesPassed && cleanupPassed ? "pass" : "incomplete",
    prerequisites: readiness.checks,
    cases,
    cleanup,
    limitations: [
      "post_asr_injection_only",
      "audible_speech_not_observed",
      "projector_not_observed",
    ],
  };
}

function selfCheckReport() {
  const privateFixture = "PRIVATE_RESPONSE_07cc";
  const promptEvidence = evaluatePromptEvidence(
    "current_weather",
    [
      {
        id: 8,
        run_id: "323e4567-e89b-42d3-a456-426614174000",
        prompt: caseForId("current_weather").prompt,
        response: `Action: ${NATIVE_ACTIONS.GET_CURRENT_LOCATION}`,
      },
      {
        id: 9,
        run_id: "323e4567-e89b-42d3-a456-426614174000",
        prompt: caseForId("current_weather").prompt,
        response: `Clear, 22 degrees Celsius in Hvidovre. ${privateFixture}`,
      },
    ],
    7,
  );
  const loadingEvidence = evaluateLoadingCueEvidence("loading_semantic_music", {
    loadingMessage: "Searching for songs...",
    verbalMessage: "Searching for songs.",
  });
  const agenticPromptEvidence = evaluatePromptEvidence(
    "capital_weather_remote",
    [{
      id: 12,
      run_id: "223e4567-e89b-42d3-a456-426614174000",
      prompt: caseForId("capital_weather_remote").prompt,
      response: `I found Paris. Current weather in Paris, France: Clear; 22 degrees Celsius. ${privateFixture}`,
    }],
    11,
  );
  const agenticBoundary =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const agenticCorrelation = "223e4567-e89b-42d3-a456-426614174000";
  const agenticTraceEvidence = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    [
      `1710000000.001  100  101 I ${HOOK_BOUNDARY_TAG}: ${agenticBoundary}`,
      ...EXPECTED_REMOTE_WEATHER_TRACE.map(
        (event, index) =>
          `1710000000.00${index + 2}  100  101 W ${SERVER_LOG_TAG}: ${AGENTIC_TRACE_MESSAGE} correlation=${agenticCorrelation} ordinal=${index + 1} tool=${event.tool} status=${event.status}${event.resultStatus === null ? "" : ` result_status=${event.resultStatus}`}`,
      ),
    ].join("\n"),
    agenticBoundary,
    agenticCorrelation,
  );
  const localWeatherCorrelation = "323e4567-e89b-42d3-a456-426614174000";
  const localWeatherTraceEvidence = evaluateLocalWeatherTraceEvidence(
    "current_weather",
    [
      `1710000000.001  100  101 I ${HOOK_BOUNDARY_TAG}: ${agenticBoundary}`,
      ...EXPECTED_LOCAL_WEATHER_TRACE.map(
        (event, index) =>
          `1710000000.00${index + 2}  100  101 W ${SERVER_LOG_TAG}: ${LOCAL_WEATHER_TRACE_MESSAGE} correlation=${localWeatherCorrelation} ordinal=${index + 1} tool=${event.tool} status=${event.status}`,
      ),
    ].join("\n"),
    agenticBoundary,
    localWeatherCorrelation,
  );
  const loadingRequest = encodeLoadingMessageCaseRequest("loading_locked_neutral");
  const command = buildTranscriptInjectionCommand("tickle_fancy");
  const pass =
    promptEvidence.pass &&
    loadingEvidence.pass &&
    agenticPromptEvidence.pass &&
    agenticTraceEvidence.pass &&
    localWeatherTraceEvidence.pass &&
    loadingRequest.length > 0 &&
    command.startsWith("am broadcast --user 0 ") &&
    command.includes(`-p ${PACKAGES.ironman}`) &&
    !command.includes("pm install") &&
    !JSON.stringify({
      promptEvidence,
      loadingEvidence,
      agenticPromptEvidence,
      agenticTraceEvidence,
      localWeatherTraceEvidence,
    }).includes(privateFixture);
  return {
    schema_version: 1,
    mode: "self_check",
    status: pass ? "pass" : "fail",
    fixed_case_count: PHYSICAL_PROMPT_CASES.length,
    safety: {
      explicit_serial_required_for_live_run: true,
      one_fixed_case_required_for_live_run: true,
      caller_supplied_prompts_rejected: true,
      output_redaction_checked: pass,
      fixed_cleanup_contract_checked: true,
    },
  };
}

function renderHumanReport(report) {
  if (report.mode === "self_check") {
    return `${PROGRAM}: ${report.status} (${report.fixed_case_count} fixed cases)`;
  }
  const lines = [
    `${PROGRAM}: ${report.status} (${report.selected_case})`,
  ];
  for (const item of report.cases) {
    lines.push(
      `- ${item.id}: ${item.status}; route=${String(item.route_observed)}; effect=${String(item.physical_effect_observed)}; latency=${item.duration_bucket}`,
    );
  }
  lines.push(
    `- cleanup: prompts=${String(report.cleanup.prompt_activity_removed)}; music_rows=${String(report.cleanup.music_activity_removed)}; music_idle=${String(report.cleanup.music_not_playing)}; tickle_idle=${String(report.cleanup.tickle_not_running)}`,
  );
  lines.push(
    "- limits: transcript injection bypasses ASR; audible speech and projector output were not observed",
  );
  return lines.join("\n");
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, dependencies = {} } = {},
) {
  let options;
  try {
    options = parsePhysicalCliArgs(argv);
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
      report = await executePhysicalSuite(options, dependencies);
    }
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderHumanReport(report)}\n`);
    if (report.status === "pass") return 0;
    return report.status === "blocked" || report.status === "incomplete" ? 3 : 1;
  } catch (error) {
    const message =
      error instanceof SafePhysicalError
        ? error.publicMessage
        : "physical prompt verification failed safely";
    stderr.write(`${PROGRAM}: ${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
