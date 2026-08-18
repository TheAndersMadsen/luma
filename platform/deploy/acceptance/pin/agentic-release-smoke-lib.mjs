import { TextDecoder } from "node:util";
import { FEATURE_FLAGS, NATIVE_ACTIONS } from "./tier-a-symbols.mjs";

export const RELEASE_SEQUENCE = 168;
export const RELEASE_IDENTITY = Object.freeze({
  packageName: "com.penumbraos.server",
  versionName: "2026-07-31.168-local",
  versionCode: 202_607_334,
  apkSha256:
    "59e41f26229be571ad31c94c55231fde426662db49c1f6c74b77a3c545a17f71",
});
export const SERVER_SOURCE = 1;
export const USER_USER = 1;
export const ASSISTANT_USER = 2;
export const SMOKE_USER_TURN_ID = "penumbra-release-smoke-user";
export const MAX_GRPC_FRAME_BYTES = 512 * 1024;
export const MAX_GRPC_FRAMES = 32;
export const INCOMPLETE_EXIT_CODE = 3;

const COMPOUND_NEARBY_ROUTE_PROMPT =
  "find the nearest coffee shop and navigate there";

export const PROMPTS = Object.freeze({
  compoundNearbyRoute: COMPOUND_NEARBY_ROUTE_PROMPT,
  // Backward-compatible key for the runner while reports use the truthful
  // nearby-plus-route preflight contract below.
  unsupportedAgenticCompound: COMPOUND_NEARBY_ROUTE_PROMPT,
  weather: "What's the weather like today?",
  // Fixed public web-search fixture. Chosen so that every plausible query the
  // planner composes is already a contiguous word span of the prompt itself
  // (the server refuses a query whose significant tokens are not grounded in
  // the user's own words), and so it avoids weather/place/playback/time
  // vocabulary that would route the turn down a different deterministic path.
  // It also matches none of the server's early-cue prediction terms, so any
  // observed web_search cue is a real planner selection rather than a
  // pre-model lexical guess.
  webSearch:
    "Search the web for the latest news about the James Webb Space Telescope",
  music:
    "look up the best songs by Michael Jackson and play the most popular",
  tickle: Object.freeze([
    "tickle",
    "tickle my fancy",
    "tickle tickle tickle",
  ]),
  tickleNegative: "please tickle",
});

export const WEATHER_LOCATION_PREFLIGHT_THOUGHT =
  "I should obtain one fresh device location before answering the location request";
export const AGENTIC_LOCATION_PREFLIGHT_THOUGHT =
  "I should obtain the one authenticated device observation required by the read-only plan";

export const CHECK_STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  PENDING: "pending",
});

/// Closed vocabulary for a read-tool failure bucket. Anything unrecognized is
/// reported as `unspecified` so raw provider or gate prose can never reach a
/// public report.
export const TOOL_FAILURE_REASONS = Object.freeze([
  "not_configured",
  "invalid_request",
  "timeout",
  "transport",
  "provider_rejected",
  "rate_limited",
  "provider_unavailable",
  "response_too_large",
  "not_found",
  "invalid_response",
  "not_grounded",
  "feature_gate",
  "invalid_arguments",
  "unknown_tool",
  "unspecified",
]);
const TOOL_FAILURE_REASON_SET = new Set(TOOL_FAILURE_REASONS);

/// `null` when no reason was supplied at all; otherwise a closed-set token.
export function bucketToolFailureReason(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && TOOL_FAILURE_REASON_SET.has(value)
    ? value
    : "unspecified";
}

/// Closed status vocabulary of an interim observation turn.
const OBSERVATION_STATUS_TOKENS = new Set([
  "ok",
  "unavailable",
  "pending",
  "not_found",
]);
const REGISTERED_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const SERIAL_PATTERN = /^[0-9A-Za-z._:-]+$/;
const MAX_SERIAL_BYTES = 128;
const USER_TURN_ID_PATTERN = /^[0-9A-Za-z._:-]+$/;
const MAX_USER_TURN_ID_BYTES = 128;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_SECRET_KEYS = /^(?:admin_token|api_key|codex_bridge_token|codex_bridge_ca_pem|subscription_key|client_secret|access_token|refresh_token|password|authorization)$/i;
const PRIVATE_VALUE_KEYS = /^(?:latitude|longitude|lat|lon|coordinates|location|location_string|reverse_geocoded_location|utterance|transcript|message|response|input|thought|system_prompt|status_prompt|username)$/i;
const SUCCESSFUL_PLAYBACK_CLAIM = /\b(?:now playing|started (?:the )?playback|starting (?:the )?playback|i(?:'m| am| will|'ll) (?:now )?play(?:ing)?|playing (?:the|your|it))\b/i;
const PROVIDER_UNAVAILABLE_CLAIM = /\b(?:disabled|unavailable|not configured|not available|not ready|can't|cannot|couldn't|unable|wasn't able|sign in|connect spotify)\b/i;

function requirePlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function validateSerial(serial) {
  if (
    typeof serial !== "string" ||
    serial.length === 0 ||
    Buffer.byteLength(serial) > MAX_SERIAL_BYTES ||
    !SERIAL_PATTERN.test(serial)
  ) {
    throw new Error("a valid explicit ADB serial is required");
  }
  return serial;
}

export function validateUserTurnId(userTurnId) {
  if (
    typeof userTurnId !== "string" ||
    userTurnId.length === 0 ||
    Buffer.byteLength(userTurnId) > MAX_USER_TURN_ID_BYTES ||
    !USER_TURN_ID_PATTERN.test(userTurnId)
  ) {
    throw new Error("a valid bounded user turn identifier is required");
  }
  return userTurnId;
}

function boundedCommandText(value, label) {
  const buffer = Buffer.from(value);
  if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) {
    throw new Error(`${label} has invalid size`);
  }
  try {
    return UTF8.decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function uniqueMatchValues(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

export function parseInstalledServerPackageMetadata(value) {
  const text = boundedCommandText(value, "server package metadata");
  const versionNames = [
    ...new Set(
      uniqueMatchValues(text, /^[\t ]*versionName=([^\s]+)(?:[\t ]|$)/gm),
    ),
  ];
  const versionCodes = [
    ...new Set(
      uniqueMatchValues(text, /^[\t ]*versionCode=([0-9]+)(?:[\t ]|$)/gm),
    ),
  ];
  if (versionNames.length !== 1 || versionCodes.length !== 1) {
    throw new Error("server package metadata is ambiguous or incomplete");
  }
  const versionCode = Number(versionCodes[0]);
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    throw new Error("server package versionCode is invalid");
  }
  return { versionName: versionNames[0], versionCode };
}

function safeActiveServerApkPath(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/data/app/") ||
    !path.endsWith("/base.apk") ||
    path.includes("//")
  ) {
    return false;
  }
  const components = path.split("/").slice(1);
  return (
    components.some(
      (component) =>
        component === RELEASE_IDENTITY.packageName ||
        component.startsWith(`${RELEASE_IDENTITY.packageName}-`),
    ) &&
    components.every(
      (component) =>
        component.length > 0 &&
        component !== "." &&
        component !== ".." &&
        /^[0-9A-Za-z._~+=-]+$/.test(component),
    )
  );
}

export function parseActiveServerApkPath(value) {
  const text = boundedCommandText(value, "server package path");
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length))
    .filter((path) => path.endsWith("/base.apk"));
  if (candidates.length !== 1 || !safeActiveServerApkPath(candidates[0])) {
    throw new Error("active server APK path is ambiguous or unsafe");
  }
  return candidates[0];
}

export function parseActiveServerApkSha256(value, expectedPath) {
  if (!safeActiveServerApkPath(expectedPath)) {
    throw new Error("active server APK path is unsafe");
  }
  const text = boundedCommandText(value, "server APK digest").trim();
  const match = /^([0-9A-Fa-f]{64})[\t ]+\*?(\S+)$/.exec(text);
  if (match === null || match[2] !== expectedPath) {
    throw new Error("server APK digest response is invalid");
  }
  return match[1].toLowerCase();
}

export function parseCliArgs(argv) {
  const options = {
    mode: null,
    serial: null,
    adbPath: "adb",
    json: false,
    expectSpotifyDisabled: false,
    help: false,
  };

  const chooseMode = (mode) => {
    if (options.mode !== null && options.mode !== mode) {
      throw new Error("choose exactly one mode");
    }
    options.mode = mode;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      return value;
    };

    switch (argument) {
      case "--self-check":
        chooseMode("self-check");
        break;
      case "--inspect":
        chooseMode("inspect");
        break;
      case "--run-safe-aibus":
        chooseMode("run-safe-aibus");
        break;
      case "--serial":
      case "-s":
        options.serial = next();
        break;
      case "--adb":
        options.adbPath = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--expect-spotify-disabled":
        options.expectSpotifyDisabled = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error("unknown option");
    }
  }

  if (options.help) return options;
  if (options.mode === null) {
    throw new Error("choose --self-check, --inspect, or --run-safe-aibus");
  }
  if (options.mode === "self-check") {
    if (options.serial !== null) {
      throw new Error("--self-check cannot be combined with --serial");
    }
    if (options.expectSpotifyDisabled) {
      throw new Error(
        "--expect-spotify-disabled requires --run-safe-aibus",
      );
    }
  } else {
    validateSerial(options.serial);
  }
  if (options.expectSpotifyDisabled && options.mode !== "run-safe-aibus") {
    throw new Error("--expect-spotify-disabled requires --run-safe-aibus");
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

export function containsForbiddenSecretKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenSecretKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      FORBIDDEN_SECRET_KEYS.test(key) || containsForbiddenSecretKey(child),
  );
}

function redactString(value, knownSecrets) {
  let redacted = value;
  for (const secret of knownSecrets) {
    if (typeof secret === "string" && secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=:-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:admin_token|api_key|client_secret|access_token|refresh_token|password|authorization)["']?\s*[:=]\s*)["']?[^\s,;}"']+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(latitude|longitude|lat|lon)\s*[:=]\s*[-+]?\d+(?:\.\d+)?/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /[-+]?\d{1,3}\.\d{3,}\s*[,/]\s*[-+]?\d{1,3}\.\d{3,}/g,
      "[REDACTED_COORDINATES]",
    );
  return redacted;
}

export function redactSensitive(value, { knownSecrets = [] } = {}) {
  if (typeof value === "string") return redactString(value, knownSecrets);
  if (Array.isArray(value)) {
    return value.map((child) => redactSensitive(child, { knownSecrets }));
  }
  if (value === null || typeof value !== "object") return value;

  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.test(key)) {
      redacted[key] = "[REDACTED]";
    } else if (PRIVATE_VALUE_KEYS.test(key) && typeof child !== "boolean") {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redactSensitive(child, { knownSecrets });
    }
  }
  return redacted;
}

function checkedFieldNumber(fieldNumber) {
  if (
    !Number.isInteger(fieldNumber) ||
    fieldNumber < 1 ||
    fieldNumber > 536_870_911
  ) {
    throw new Error("invalid protobuf field number");
  }
  return fieldNumber;
}

export function encodeVarint(value) {
  let remaining;
  try {
    remaining = BigInt(value);
  } catch {
    throw new Error("invalid protobuf varint");
  }
  if (remaining < 0n || remaining > 0xffff_ffff_ffff_ffffn) {
    throw new Error("invalid protobuf varint");
  }
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

function encodeKey(fieldNumber, wireType) {
  checkedFieldNumber(fieldNumber);
  if (![0, 1, 2, 5].includes(wireType)) {
    throw new Error("unsupported protobuf wire type");
  }
  return encodeVarint(BigInt(fieldNumber) * 8n + BigInt(wireType));
}

export function encodeProtoVarint(fieldNumber, value) {
  return Buffer.concat([encodeKey(fieldNumber, 0), encodeVarint(value)]);
}

export function encodeProtoBytes(fieldNumber, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([
    encodeKey(fieldNumber, 2),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

export function encodeProtoString(fieldNumber, value) {
  if (typeof value !== "string") throw new Error("protobuf string is required");
  return encodeProtoBytes(fieldNumber, Buffer.from(value, "utf8"));
}

function decodeVarintAt(buffer, start) {
  let value = 0n;
  let shift = 0n;
  for (let offset = start; offset < buffer.length && offset < start + 10; offset += 1) {
    const byte = buffer[offset];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset + 1 };
    shift += 7n;
  }
  throw new Error("truncated or oversized protobuf varint");
}

export function decodeProtoFields(value, { maxBytes = MAX_GRPC_FRAME_BYTES } = {}) {
  const buffer = Buffer.from(value);
  if (buffer.length > maxBytes) throw new Error("protobuf message is too large");
  const fields = new Map();
  let offset = 0;
  let count = 0;

  while (offset < buffer.length) {
    if (++count > 2_048) throw new Error("protobuf message has too many fields");
    const key = decodeVarintAt(buffer, offset);
    offset = key.next;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    checkedFieldNumber(fieldNumber);
    let fieldValue;

    switch (wireType) {
      case 0: {
        const decoded = decodeVarintAt(buffer, offset);
        fieldValue = decoded.value;
        offset = decoded.next;
        break;
      }
      case 1:
        if (offset + 8 > buffer.length) throw new Error("truncated protobuf fixed64");
        fieldValue = buffer.subarray(offset, offset + 8);
        offset += 8;
        break;
      case 2: {
        const decoded = decodeVarintAt(buffer, offset);
        offset = decoded.next;
        if (decoded.value > BigInt(maxBytes)) {
          throw new Error("protobuf field is too large");
        }
        const length = Number(decoded.value);
        if (offset + length > buffer.length) {
          throw new Error("truncated protobuf bytes field");
        }
        fieldValue = buffer.subarray(offset, offset + length);
        offset += length;
        break;
      }
      case 5:
        if (offset + 4 > buffer.length) throw new Error("truncated protobuf fixed32");
        fieldValue = buffer.subarray(offset, offset + 4);
        offset += 4;
        break;
      default:
        throw new Error("unsupported protobuf wire type");
    }

    const entries = fields.get(fieldNumber) ?? [];
    entries.push({ wireType, value: fieldValue });
    fields.set(fieldNumber, entries);
  }
  return fields;
}

function lastField(fields, fieldNumber, wireType) {
  const entries = fields.get(fieldNumber) ?? [];
  const entry = entries.at(-1);
  if (entry === undefined) return undefined;
  if (entry.wireType !== wireType) throw new Error("unexpected protobuf wire type");
  return entry.value;
}

function protoString(fields, fieldNumber, fallback = "") {
  const value = lastField(fields, fieldNumber, 2);
  if (value === undefined) return fallback;
  try {
    return UTF8.decode(value);
  } catch {
    throw new Error("invalid protobuf UTF-8 string");
  }
}

function protoNumber(fields, fieldNumber, fallback = 0) {
  const value = lastField(fields, fieldNumber, 0);
  if (value === undefined) return fallback;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("protobuf integer is too large");
  }
  return Number(value);
}

export function encodeUnderstandingRequest({
  utterance,
  excludedTools = [],
  singleShot = false,
  sendActionsAndObservationsSeparately = false,
  userTurnId = SMOKE_USER_TURN_ID,
}) {
  if (
    typeof utterance !== "string" ||
    utterance.length === 0 ||
    Buffer.byteLength(utterance) > 4_096 ||
    utterance.includes("\0")
  ) {
    throw new Error("a bounded utterance is required");
  }
  if (!Array.isArray(excludedTools) || excludedTools.length > 64) {
    throw new Error("invalid excluded tool list");
  }
  validateUserTurnId(userTurnId);

  const userRequest = encodeProtoString(1, utterance);
  const userTurn = Buffer.concat([
    encodeProtoVarint(1, USER_USER),
    encodeProtoBytes(2, userRequest),
    encodeProtoString(8, userTurnId),
  ]);
  const deviceContext = Buffer.concat([
    encodeProtoBytes(3, userTurn),
    // Encode the proto3 default explicitly so the fixture is unambiguously an
    // unlocked live request rather than a context-free/unknown-lock probe.
    encodeProtoVarint(5, 0),
  ]);
  const fields = [
    encodeProtoString(1, utterance),
    encodeProtoBytes(3, deviceContext),
  ];
  if (singleShot) fields.push(encodeProtoVarint(6, 1));
  if (sendActionsAndObservationsSeparately) {
    fields.push(encodeProtoVarint(7, 1));
  }
  for (const tool of excludedTools) {
    if (
      typeof tool !== "string" ||
      tool.length === 0 ||
      tool.length > 128 ||
      !/^[0-9A-Za-z_]+$/.test(tool)
    ) {
      throw new Error("invalid excluded tool name");
    }
    fields.push(encodeProtoString(8, tool));
  }
  return Buffer.concat(fields);
}

export function decodeUnderstandingRequest(
  value,
  { expectedUserTurnId = SMOKE_USER_TURN_ID } = {},
) {
  validateUserTurnId(expectedUserTurnId);
  const outer = decodeProtoFields(value);
  const contextEntries = outer.get(3) ?? [];
  if (contextEntries.length !== 1 || contextEntries[0].wireType !== 2) {
    throw new Error("understanding request must contain one device context");
  }
  if (outer.has(10)) {
    throw new Error("understanding request must not contain a location field");
  }
  const utterance = protoString(outer, 1);
  const context = decodeProtoFields(contextEntries[0].value);
  const lockEntries = context.get(5) ?? [];
  if (
    lockEntries.length !== 1 ||
    lockEntries[0].wireType !== 0 ||
    lockEntries[0].value !== 0n
  ) {
    throw new Error("device context must be explicitly unlocked");
  }
  const turnEntries = context.get(3) ?? [];
  if (turnEntries.length !== 1 || turnEntries[0].wireType !== 2) {
    throw new Error("device context must contain one user turn");
  }
  const turn = decodeProtoFields(turnEntries[0].value);
  const userRequestBytes = lastField(turn, 2, 2);
  if (userRequestBytes === undefined) {
    throw new Error("device context turn must contain one user request");
  }
  const userRequest = decodeProtoFields(userRequestBytes);
  const turnRequest = protoString(userRequest, 1);
  const identifier = protoString(turn, 8);
  const parentIdentifier = protoString(turn, 9);
  if (
    protoNumber(turn, 1) !== USER_USER ||
    turnRequest !== utterance ||
    identifier !== expectedUserTurnId ||
    parentIdentifier !== ""
  ) {
    throw new Error("device context user turn is not bound to the outer utterance");
  }
  return {
    utterance,
    hasLocation: false,
    deviceContext: {
      isLocked: false,
      turns: [
        {
          user: USER_USER,
          request: turnRequest,
          identifier,
          parentIdentifier,
        },
      ],
    },
  };
}

export function wrapGrpcFrame(message) {
  const body = Buffer.from(message);
  if (body.length > MAX_GRPC_FRAME_BYTES) throw new Error("gRPC frame is too large");
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export class GrpcFrameDecoder {
  constructor({
    maxFrameBytes = MAX_GRPC_FRAME_BYTES,
    maxFrames = MAX_GRPC_FRAMES,
  } = {}) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes <= 0 ||
      !Number.isSafeInteger(maxFrames) ||
      maxFrames <= 0
    ) {
      throw new Error("invalid gRPC decoder limits");
    }
    this.maxFrameBytes = maxFrameBytes;
    this.maxFrames = maxFrames;
    this.pending = Buffer.alloc(0);
    this.frameCount = 0;
  }

  push(chunk) {
    const incoming = Buffer.from(chunk);
    const maxBufferedBytes = (this.maxFrameBytes + 5) * this.maxFrames;
    if (this.pending.length + incoming.length > maxBufferedBytes) {
      throw new Error("buffered gRPC response is too large");
    }
    this.pending = Buffer.concat([this.pending, incoming]);
    const frames = [];
    while (this.pending.length >= 5) {
      const compressed = this.pending[0];
      const length = this.pending.readUInt32BE(1);
      if (compressed !== 0) throw new Error("compressed gRPC frames are unsupported");
      if (length > this.maxFrameBytes) throw new Error("gRPC frame is too large");
      if (this.pending.length < length + 5) break;
      if (++this.frameCount > this.maxFrames) {
        throw new Error("gRPC response has too many frames");
      }
      frames.push(this.pending.subarray(5, length + 5));
      this.pending = this.pending.subarray(length + 5);
    }
    return frames;
  }

  finish() {
    if (this.pending.length !== 0) throw new Error("truncated gRPC frame");
  }
}

export function parseGrpcFrames(value, options) {
  const decoder = new GrpcFrameDecoder(options);
  const frames = decoder.push(value);
  decoder.finish();
  return frames;
}

/// Interim observation turns contain the registered name of the tool batch plus
/// a closed status JSON by contract, so the tool the planner actually selected
/// is observable in-band without reading device logs. Only the registered name
/// and closed status/reason tokens are retained: the raw observation text is
/// never kept, so a non-conforming observation cannot leak content into a
/// report.
function decodeObservationContent(bytes) {
  const observation = decodeProtoFields(bytes);
  const registeredName = protoString(observation, 3);
  let payload = null;
  try {
    payload = JSON.parse(protoString(observation, 1));
  } catch {
    payload = null;
  }
  const structured =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : null;
  return {
    actionName: REGISTERED_NAME_PATTERN.test(registeredName)
      ? registeredName
      : "",
    observationStatus:
      typeof structured?.status === "string" &&
      OBSERVATION_STATUS_TOKENS.has(structured.status)
        ? structured.status
        : "unknown",
    observationReason: bucketToolFailureReason(structured?.reason),
    observationSource: protoNumber(observation, 4),
  };
}

export function decodeUnderstandingResponse(value) {
  const outer = decodeProtoFields(value);
  const turnBytes = lastField(outer, 8, 2);
  if (turnBytes === undefined) {
    return {
      kind: "other",
      isFinal: protoNumber(outer, 2) !== 0,
      hasLegacyResponse: protoString(outer, 1).length > 0,
    };
  }

  const turn = decodeProtoFields(turnBytes);
  const actionBytes = lastField(turn, 5, 2);
  if (actionBytes === undefined) {
    const observationBytes = lastField(turn, 6, 2);
    const identifier = protoString(turn, 8);
    const parentIdentifier = protoString(turn, 9);
    return {
      kind: observationBytes === undefined ? "turn" : "observation",
      isFinal: protoNumber(outer, 2) !== 0,
      user: protoNumber(turn, 1),
      hasIdentifier: identifier.length > 0,
      hasParentIdentifier: parentIdentifier.length > 0,
      identifier,
      parentIdentifier,
      ...(observationBytes === undefined
        ? {}
        : decodeObservationContent(observationBytes)),
    };
  }

  const action = decodeProtoFields(actionBytes);
  const devicePayload = lastField(action, 4, 2);
  const identifier = protoString(turn, 8);
  const parentIdentifier = protoString(turn, 9);
  return {
    kind: "action",
    isFinal: protoNumber(outer, 2) !== 0,
    user: protoNumber(turn, 1),
    hasIdentifier: identifier.length > 0,
    hasParentIdentifier: parentIdentifier.length > 0,
    identifier,
    parentIdentifier,
    thought: protoString(action, 1),
    action: protoString(action, 2),
    input: protoString(action, 3),
    devicePayloadBytes: devicePayload?.length ?? 0,
    source: protoNumber(action, 5),
  };
}

export function decodeUnderstandingResponses(frames) {
  if (!Array.isArray(frames) || frames.length > MAX_GRPC_FRAMES) {
    throw new Error("invalid gRPC response frame list");
  }
  return frames.map(decodeUnderstandingResponse);
}

/** Builds a descriptor-compatible response fixture for parser unit tests. */
export function buildActionResponseFixture({
  action,
  input = "{}",
  thought = "fixture thought",
  source = SERVER_SOURCE,
  devicePayload = Buffer.alloc(0),
  identifier = "fixture-action",
  parentIdentifier = SMOKE_USER_TURN_ID,
}) {
  const actionMessage = Buffer.concat([
    encodeProtoString(1, thought),
    encodeProtoString(2, action),
    encodeProtoString(3, input),
    encodeProtoBytes(4, devicePayload),
    encodeProtoVarint(5, source),
  ]);
  const turn = Buffer.concat([
    encodeProtoVarint(1, ASSISTANT_USER),
    encodeProtoBytes(5, actionMessage),
    encodeProtoString(8, identifier),
    encodeProtoString(9, parentIdentifier),
  ]);
  return encodeProtoBytes(8, turn);
}

/** Builds a descriptor-compatible interim observation fixture for unit tests. */
export function buildObservationResponseFixture({
  actionName,
  observation = '{"status":"ok"}',
  source = SERVER_SOURCE,
  identifier = "fixture-observation",
  parentIdentifier = SMOKE_USER_TURN_ID,
}) {
  const observationMessage = Buffer.concat([
    encodeProtoString(1, observation),
    encodeProtoString(3, actionName),
    encodeProtoVarint(4, source),
  ]);
  const turn = Buffer.concat([
    encodeProtoVarint(1, ASSISTANT_USER),
    encodeProtoBytes(6, observationMessage),
    encodeProtoString(8, identifier),
    encodeProtoString(9, parentIdentifier),
  ]);
  return encodeProtoBytes(8, turn);
}

function check(id, title, status, evidence) {
  if (!Object.values(CHECK_STATUS).includes(status)) {
    throw new Error("invalid check status");
  }
  return { id, title, status, evidence: [...evidence] };
}

function actionResponses(responses) {
  if (!Array.isArray(responses)) return [];
  return responses.filter((response) => response?.kind === "action");
}

function parseActionObject(action) {
  let value;
  try {
    value = JSON.parse(action.input);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function isServerStockAction(action, expectedName) {
  return (
    action?.kind === "action" &&
    action.action === expectedName &&
    action.source === SERVER_SOURCE &&
    action.user === ASSISTANT_USER &&
    action.devicePayloadBytes === 0 &&
    action.hasIdentifier === true &&
    action.hasParentIdentifier === true
    // Chain rooting at the smoke user turn is proven by exactSingleAction's
    // parent-walk; the terminal's direct parent is the last interim turn
    // whenever cue streaming emitted interim turns.
  );
}

/// The one action stock actually dispatches. Since cue streaming, a response
/// is a parent-chained sequence of interim action/observation turns ending in
/// exactly one terminal action (stock's legacy client records the interim
/// turns and dispatches only the last). The chain must be rooted at the smoke
/// user turn and each link's parent must be the previous frame — a stricter
/// contract than the old single-frame shape it replaces.
function exactSingleAction(responses) {
  if (!Array.isArray(responses) || responses.length === 0) {
    return null;
  }
  const terminal = responses[responses.length - 1];
  if (terminal?.kind !== "action") {
    return null;
  }
  let expectedParent = SMOKE_USER_TURN_ID;
  for (const frame of responses.slice(0, -1)) {
    if (frame?.kind !== "action" && frame?.kind !== "observation") {
      return null;
    }
    if (frame.parentIdentifier !== expectedParent || !frame.hasIdentifier) {
      return null;
    }
    expectedParent = frame.identifier;
  }
  if (terminal.parentIdentifier !== expectedParent) {
    return null;
  }
  return terminal;
}

export function evaluateWeatherInitialProbe(responses) {
  const action = exactSingleAction(responses);
  const input = action === null ? null : parseActionObject(action);
  const stockEnvelopeMatches = isServerStockAction(
    action,
    NATIVE_ACTIONS.GET_CURRENT_LOCATION,
  );
  const thoughtMatches = action?.thought === WEATHER_LOCATION_PREFLIGHT_THOUGHT;
  const inputShapeMatches = input !== null && Object.keys(input).length === 0;
  const valid =
    stockEnvelopeMatches && thoughtMatches && inputShapeMatches;
  const diagnosticTokens = [
    action === null
      ? "no_exact_single_action"
      : action.action === NATIVE_ACTIONS.GET_CURRENT_LOCATION
        ? "location_action_observed"
        : action.action === NATIVE_ACTIONS.RESPOND
          ? "respond_observed"
          : "other_action_observed",
    stockEnvelopeMatches ? "stock_envelope_match" : "stock_envelope_mismatch",
    thoughtMatches ? "preflight_thought_match" : "preflight_thought_mismatch",
    inputShapeMatches ? "empty_input_match" : "empty_input_mismatch",
  ];
  return check(
    "weather_missing_location_first_action",
    "Weather missing-location first action",
    valid ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    valid
      ? [
          `real AIBus Understand returned one parent-linked server ${NATIVE_ACTIONS.GET_CURRENT_LOCATION} action`,
          "no coordinates or fabricated location were supplied",
        ]
      : [
          "the exact stock weather preflight contract was not observed",
          `privacy-safe diagnostics: ${diagnosticTokens.join(",")}`,
        ],
  );
}

export function evaluateCompoundNearbyRouteInitialProbe(responses, readiness) {
  // The bounded agentic runtime is provider-agnostic: codex and
  // openai-compatible drive the same typed action/observation loop, matching
  // the agentic_configuration readiness contract. The Codex bridge readiness
  // requirement applies only when Codex is the selected provider.
  const configured =
    (readiness?.provider === "codex" ||
      readiness?.provider === "openai-compatible") &&
    readiness?.toolsEnabled === true &&
    (readiness?.provider !== "codex" || readiness?.codexReady === true) &&
    Number.isInteger(readiness?.maxToolTurns) &&
    readiness.maxToolTurns >= 2;
  const action = exactSingleAction(responses);
  const input = action === null ? null : parseActionObject(action);
  const stockEnvelopeMatches = isServerStockAction(
    action,
    NATIVE_ACTIONS.GET_CURRENT_LOCATION,
  );
  const thoughtMatches = action?.thought === AGENTIC_LOCATION_PREFLIGHT_THOUGHT;
  const inputShapeMatches = input !== null && Object.keys(input).length === 0;
  const validAction = stockEnvelopeMatches && thoughtMatches && inputShapeMatches;
  const valid = configured && validAction;
  const diagnosticTokens = [
    configured ? "readiness_match" : "readiness_mismatch",
    action === null
      ? "no_exact_single_action"
      : action.action === NATIVE_ACTIONS.GET_CURRENT_LOCATION
        ? "location_action_observed"
        : action.action === NATIVE_ACTIONS.RESPOND
          ? "respond_observed"
          : "other_action_observed",
    stockEnvelopeMatches ? "stock_envelope_match" : "stock_envelope_mismatch",
    thoughtMatches ? "preflight_thought_match" : "preflight_thought_mismatch",
    inputShapeMatches ? "empty_input_match" : "empty_input_mismatch",
  ];
  return check(
    "compound_nearby_route_location_preflight",
    "Compound nearby-route location preflight",
    valid ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    valid
      ? [
          "Codex and bounded tools report ready",
          `real AIBus Understand returned exactly one parent-linked server ${NATIVE_ACTIONS.GET_CURRENT_LOCATION} preflight with empty input`,
          "no final response or navigation mutation was emitted before an authenticated device observation",
        ]
      : [
          "the compound nearby-plus-route request did not begin with the exact authenticated-device location preflight",
          `privacy-safe diagnostics: ${diagnosticTokens.join(",")}`,
        ],
  );
}

// Keep the existing runner import working until it adopts the truthful name.
export const evaluateUnsupportedAgenticCompoundProbe =
  evaluateCompoundNearbyRouteInitialProbe;

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_SEARCH_CHECK_ID = "web_search_tool_selection";
export const WEB_SEARCH_CHECK_TITLE = "Fixed web-search planner selection";

/// Registered read/mutation tool names are snake_case; every one of the 138
/// stock native action names in `contracts/tier-a/native-actions.tsv` is PascalCase.
/// So an interim progress-cue turn is distinguishable from a dispatched native
/// action by name shape alone, without an allowlist that would drift.
function isRegisteredToolCueName(name) {
  return typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name);
}

/// Registered names of the bounded mutation tools. A cue naming one of these
/// means the planner reached for a mutation on a read-only search fixture,
/// which must fail the check exactly like an escaped native action.
const MUTATION_TOOL_CUE_NAMES = new Set([
  "set_timer",
  "set_alarm",
  "send_message",
  "call_person",
]);

/// Whether the fixed public web-search fixture caused the planner to SELECT
/// the `web_search` tool. Selection — not provider success — is the headline:
/// a planner that selects the tool and has its query refused downstream is a
/// materially different (and far better) outcome than one that never selects
/// it at all, so the two are reported distinctly.
///
/// Evidence source: the decoded Understand response stream only. The server
/// streams one interim ACTION turn named after the first tool of each batch
/// and one paired OBSERVATION turn containing that tool's registered name plus a
/// closed status JSON. A `pending` observation marks a PREDICTED or
/// parity cue (no tool ran yet); `ok`/`unavailable` marks a real execution.
export function evaluateWebSearch(responses, readiness) {
  // Provider precondition, in the style of the other provider-readiness gates.
  // Without a configured Brave subscription the server does not advertise
  // `web_search` at all, so a non-selection would prove nothing. This is
  // deliberately PENDING rather than FAIL: an unconfigured optional provider
  // is missing evidence, not a release defect.
  if (readiness?.braveSearchReady !== true) {
    return check(
      WEB_SEARCH_CHECK_ID,
      WEB_SEARCH_CHECK_TITLE,
      CHECK_STATUS.PENDING,
      [
        "the sanitized settings snapshot reports brave_search.has_api_key is not true",
        "the server withholds the web_search tool from the planner without a configured subscription, so selection cannot be observed",
      ],
    );
  }
  // Interim progress turns ARE the observation channel. With the kill switch
  // off the response carries only the terminal frame, so a missing web_search
  // cue would prove nothing — that is absent evidence, never a failure.
  if (readiness?.progressTurnsEnabled !== true) {
    return check(
      WEB_SEARCH_CHECK_ID,
      WEB_SEARCH_CHECK_TITLE,
      CHECK_STATUS.PENDING,
      [
        "the sanitized settings snapshot reports llm.hermes_progress_turns is not true",
        "interim tool turns are the only in-band selection signal, so tool selection is unobservable while they are disabled",
      ],
    );
  }

  const frames = Array.isArray(responses) ? responses : [];
  let cueCount = 0;
  let predictedCueCount = 0;
  let executedCount = 0;
  let webSearchOkCount = 0;
  let observedFailureReason = null;
  for (const frame of frames) {
    if (isServerStockAction(frame, WEB_SEARCH_TOOL)) {
      cueCount += 1;
      continue;
    }
    if (
      frame?.kind === "observation" &&
      frame.actionName === WEB_SEARCH_TOOL &&
      frame.observationSource === SERVER_SOURCE
    ) {
      if (frame.observationStatus === "pending") {
        predictedCueCount += 1;
        continue;
      }
      executedCount += 1;
      if (frame.observationStatus === "ok") {
        webSearchOkCount += 1;
      } else {
        observedFailureReason = frame.observationReason ?? "unspecified";
      }
    }
  }
  // A cue whose paired observation was `pending` is a prediction, not a
  // selection; the remainder are real batch starts.
  const startedCount = Math.max(0, cueCount - predictedCueCount);
  const webSearchSelected = executedCount > 0 || startedCount > 0;
  const reason = !webSearchSelected
    ? null
    : observedFailureReason !== null
      ? observedFailureReason
      : webSearchOkCount > 0
        ? null
        : "unspecified";

  const terminal = exactSingleAction(frames);
  const finalRespondEmitted = isServerStockAction(
    terminal,
    NATIVE_ACTIONS.RESPOND,
  );
  // Any action turn that is neither the final response nor a read-tool progress
  // cue is a native action escaping a read-only probe.
  const nativeMutationEmitted = frames.some(
    (frame) =>
      frame?.kind === "action" &&
      frame.action !== NATIVE_ACTIONS.RESPOND &&
      (!isRegisteredToolCueName(frame.action) ||
        MUTATION_TOOL_CUE_NAMES.has(frame.action)),
  );

  const diagnosticTokens = [
    webSearchSelected ? "web_search_selected" : "web_search_not_selected",
    `web_search_started=${startedCount}`,
    `web_search_executed=${executedCount}`,
    `web_search_ok=${webSearchOkCount}`,
    `reason=${reason ?? "none"}`,
    finalRespondEmitted ? "final_respond_observed" : "no_final_respond",
    nativeMutationEmitted ? "native_mutation_observed" : "no_native_mutation",
  ];
  const outcomeEvidence =
    webSearchOkCount > 0
      ? `${webSearchOkCount} web_search execution(s) returned a provider result`
      : webSearchSelected
        ? `no web_search execution succeeded; bucketed failure reason: ${reason}`
        : "no web_search execution was observed";
  const valid =
    webSearchSelected && finalRespondEmitted && !nativeMutationEmitted;

  return {
    ...check(
      WEB_SEARCH_CHECK_ID,
      WEB_SEARCH_CHECK_TITLE,
      valid ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      [
        webSearchSelected
          ? "the planner selected the web_search tool on the fixed public search fixture"
          : "the planner never selected the web_search tool on the fixed public search fixture",
        outcomeEvidence,
        valid
          ? `the run ended in one stock ${NATIVE_ACTIONS.RESPOND} and dispatched no native action`
          : nativeMutationEmitted
            ? "a native or mutation action escaped a read-only search probe"
            : finalRespondEmitted
              ? "the read-only turn shape was otherwise intact"
              : `the run did not end in one parent-linked stock ${NATIVE_ACTIONS.RESPOND}`,
        `privacy-safe diagnostics: ${diagnosticTokens.join(",")}`,
      ],
    ),
    // Content-free machine-readable facts for the JSON report. Selection and
    // provider success are separate fields on purpose.
    observed: Object.freeze({
      webSearchSelected,
      webSearchOkCount,
      reason,
      finalRespondEmitted,
      nativeMutationEmitted,
    }),
  };
}

function normalized(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
}

export function evaluateMusicChain(responses, rankOne) {
  const action = exactSingleAction(responses);
  const input = action === null ? null : parseActionObject(action);
  const rankOneValid =
    rankOne !== null &&
    typeof rankOne === "object" &&
    typeof rankOne.title === "string" &&
    rankOne.title.length > 0 &&
    Array.isArray(rankOne.artists) &&
    rankOne.artists.every((artist) => typeof artist === "string") &&
    (rankOne.album === undefined || typeof rankOne.album === "string");
  const keys = input === null ? [] : Object.keys(input).sort();
  const artistMatches =
    rankOneValid &&
    typeof input?.Artist === "string" &&
    rankOne.artists.some(
      (artist) => normalized(artist) === normalized(input.Artist),
    ) &&
    normalized(input.Artist) === "michael jackson";
  const actionEnvelopeMatches = isServerStockAction(
    action,
    NATIVE_ACTIONS.PLAY_MUSIC,
  );
  const keyShapeMatches =
    keys.join(",") === "Artist,Track" ||
    keys.join(",") === "Album,Artist,Track";
  const titleMatches =
    rankOneValid && typeof input?.Track === "string" && input.Track === rankOne.title;
  const albumMatches =
    rankOneValid &&
    (input?.Album === undefined || input.Album === rankOne.album);
  const valid =
    actionEnvelopeMatches &&
    rankOneValid &&
    keyShapeMatches &&
    titleMatches &&
    artistMatches &&
    albumMatches;

  // These closed diagnostic tokens distinguish route/provenance failures from
  // provider-selection drift without retaining or printing any catalog value.
  // They are deliberately useful in physical release reports while remaining
  // safe to share and stable enough for regression tests.
  const diagnosticTokens = [
    action === null
      ? "no_exact_single_action"
      : action.action === NATIVE_ACTIONS.PLAY_MUSIC
        ? "play_music_observed"
        : action.action === NATIVE_ACTIONS.RESPOND
          ? "respond_observed"
          : "other_action_observed",
    actionEnvelopeMatches ? "action_envelope_match" : "action_envelope_mismatch",
    rankOneValid ? "rank_one_shape_match" : "rank_one_shape_mismatch",
    keyShapeMatches ? "input_key_shape_match" : "input_key_shape_mismatch",
    titleMatches ? "title_match" : "title_mismatch",
    artistMatches ? "artist_match" : "artist_mismatch",
    albumMatches ? "album_match" : "album_mismatch",
  ];

  return check(
    "music_rank_one_match_playmusic",
    `${NATIVE_ACTIONS.PLAY_MUSIC} matches observed provider rank one`,
    valid ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    valid
      ? [
          `real AIBus Understand returned one server ${NATIVE_ACTIONS.PLAY_MUSIC} action`,
          "Track and Artist exactly match the independently observed provider rank-one result",
          "the harness did not dispatch playback",
        ]
      : [
          `the ${NATIVE_ACTIONS.PLAY_MUSIC} action did not exactly match the independently observed provider rank one`,
          `privacy-safe diagnostics: ${diagnosticTokens.join(",")}`,
        ],
  );
}

export function evaluateDisabledSpotifyFailClosed(responses, { disabled }) {
  if (!disabled) {
    return check(
      "disabled_spotify_fail_closed",
      "Disabled Spotify fail-closed behavior",
      CHECK_STATUS.PENDING,
      ["Spotify is not currently in the exact disabled precondition"],
    );
  }
  const actions = actionResponses(responses);
  const mutatingAction = actions.some(
    (action) =>
      action.action !== NATIVE_ACTIONS.RESPOND ||
      !isServerStockAction(action, NATIVE_ACTIONS.RESPOND),
  );
  const uninspectedLegacyOutput = responses.some(
    (response) => response?.kind === "other" && response.hasLegacyResponse,
  );
  let falseSuccess = false;
  for (const action of actions.filter(
    (candidate) => candidate.action === NATIVE_ACTIONS.RESPOND,
  )) {
    const input = parseActionObject(action);
    if (
      input === null ||
      Object.keys(input).length !== 1 ||
      typeof input.Response !== "string" ||
      SUCCESSFUL_PLAYBACK_CLAIM.test(input.Response) ||
      !PROVIDER_UNAVAILABLE_CLAIM.test(input.Response)
    ) {
      falseSuccess = true;
    }
  }
  const valid =
    !mutatingAction &&
    !uninspectedLegacyOutput &&
    !falseSuccess &&
    actions.length <= 1;
  return check(
    "disabled_spotify_fail_closed",
    "Disabled Spotify fail-closed behavior",
    valid ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    valid
      ? [
          `no ${NATIVE_ACTIONS.PLAY_MUSIC} or other native action escaped while Spotify was disabled`,
          "no playback-success claim was emitted",
        ]
      : ["a native action or playback-success claim escaped the disabled provider gate"],
  );
}

export function evaluateTickleRouting(
  responsesByPhrase,
  { tickleEnabled, stockCacheVerified },
) {
  if (!tickleEnabled) {
    return check(
      "tickle_exact_phrase_routing",
      `${NATIVE_ACTIONS.TICKLE} exact-phrase AIBus routing`,
      CHECK_STATUS.FAIL,
      [`the live ${NATIVE_ACTIONS.TICKLE} feature flag is disabled`],
    );
  }
  if (!stockCacheVerified) {
    return check(
      "tickle_exact_phrase_routing",
      `${NATIVE_ACTIONS.TICKLE} exact-phrase AIBus routing`,
      CHECK_STATUS.FAIL,
      ["the exact feature assignment has not been verified in the stock cache"],
    );
  }
  if (!(responsesByPhrase instanceof Map)) {
    return check(
      "tickle_exact_phrase_routing",
      `${NATIVE_ACTIONS.TICKLE} exact-phrase AIBus routing`,
      CHECK_STATUS.FAIL,
      ["no safe AIBus phrase evidence was captured"],
    );
  }

  const exactPhrasesValid = PROMPTS.tickle.every((phrase) => {
    const action = exactSingleAction(responsesByPhrase.get(phrase));
    const input = action === null ? null : parseActionObject(action);
    return (
      isServerStockAction(action, NATIVE_ACTIONS.TICKLE) &&
      input !== null &&
      Object.keys(input).length === 0
    );
  });
  const negativeResponses = responsesByPhrase.get(PROMPTS.tickleNegative);
  const negativeAction = exactSingleAction(negativeResponses);
  const negativeInput =
    negativeAction === null ? null : parseActionObject(negativeAction);
  const negativeValid =
    Array.isArray(negativeResponses) &&
    (negativeResponses.length === 0 ||
      (isServerStockAction(negativeAction, NATIVE_ACTIONS.RESPOND) &&
        negativeInput !== null &&
        Object.keys(negativeInput).length === 1 &&
        typeof negativeInput.Response === "string" &&
        negativeInput.Response.length > 0));
  const valid = exactPhrasesValid && negativeValid;
  return check(
    "tickle_exact_phrase_routing",
    `${NATIVE_ACTIONS.TICKLE} exact-phrase AIBus routing`,
    valid ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    valid
        ? [
          `all three exact stock phrases returned one server ${NATIVE_ACTIONS.TICKLE} action`,
          `the non-exact control returned no ${NATIVE_ACTIONS.TICKLE} or other native action`,
          "the harness did not dispatch or launch the action",
        ]
      : [
          exactPhrasesValid
            ? `the non-exact control returned a ${NATIVE_ACTIONS.TICKLE}, native, legacy, or malformed response`
            : `one or more exact phrases did not return the stock ${NATIVE_ACTIONS.TICKLE} action`,
        ],
  );
}

export function isRequiredReleaseVersion(value) {
  return value === RELEASE_IDENTITY.versionName;
}

export function parseLoopbackGrpcPort(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/.exec(value);
  if (match === null) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function isTaggedFeatureBoolean(value, expected) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === 2 &&
    keys[0] === "type" &&
    keys[1] === "value" &&
    value.type === "bool" &&
    value.value === expected
  );
}

export function evaluateReadiness(
  { health, packageIdentity, settings, codex, spotify, featureFlags },
  { expectSpotifyDisabled = false } = {},
) {
  requirePlainObject(health, "health response");
  requirePlainObject(packageIdentity, "installed package identity");
  requirePlainObject(settings, "settings response");
  requirePlainObject(codex, "Codex status response");
  requirePlainObject(spotify, "Spotify status response");
  requirePlainObject(featureFlags, "feature flag response");

  const checks = [];
  const healthValid =
    health.status === "ok" &&
    isRequiredReleaseVersion(health.version) &&
    packageIdentity.packageName === RELEASE_IDENTITY.packageName &&
    packageIdentity.versionName === RELEASE_IDENTITY.versionName &&
    packageIdentity.versionCode === RELEASE_IDENTITY.versionCode &&
    packageIdentity.apkSha256 === RELEASE_IDENTITY.apkSha256;
  checks.push(
    check(
      "server_release_identity",
      `Exact Server ${RELEASE_IDENTITY.versionName} release identity`,
      healthValid ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      healthValid
        ? [
            `health, installed package metadata, and active APK digest match the exact ${RELEASE_IDENTITY.versionName} candidate`,
          ]
        : [
            `the runtime or installed active APK does not match the exact ${RELEASE_IDENTITY.versionName} candidate`,
          ],
    ),
  );

  const settingsSafe =
    !containsForbiddenSecretKey(settings) &&
    settings.server?.admin_token_auth === true;
  checks.push(
    check(
      "settings_secret_safety",
      "Sanitized settings contract",
      settingsSafe ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      settingsSafe
        ? ["settings expose capability booleans but no secret-valued keys"]
        : ["settings schema is unsafe or incomplete"],
    ),
  );

  const grpcPort = parseLoopbackGrpcPort(settings.server?.grpc_bind_addr);
  checks.push(
    check(
      "aibus_loopback_listener",
      "AIBus loopback listener",
      grpcPort !== null ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      grpcPort !== null
        ? ["gRPC is configured on device loopback"]
        : ["gRPC listener is absent or not loopback-only"],
    ),
  );

  const provider = settings.llm?.provider;
  const toolsEnabled = settings.llm?.tools?.enabled;
  const maxToolTurns = settings.llm?.tools?.max_tool_turns;
  const agenticConfigured =
    (provider === "codex" || provider === "openai-compatible") &&
    toolsEnabled === true &&
    Number.isInteger(maxToolTurns) &&
    maxToolTurns === 12;
  checks.push(
    check(
      "agentic_configuration",
      "Agentic configuration",
      agenticConfigured ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      agenticConfigured
        ? [`${provider} is selected with the 12-step dynamic-loop safety budget`]
        : ["Agentic dynamic-loop configuration is not release-ready"],
    ),
  );

  const codexReady = codex.ready === true && codex.state === "ready";
  checks.push(
    check(
      "codex_bridge_ready",
      "Codex bridge readiness",
      codexReady ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      codexReady
        ? ["Center reports a verified ChatGPT-backed Codex bridge"]
        : ["Codex bridge is not ready"],
    ),
  );

  const weatherReady = settings.weather?.has_api_key === true;
  checks.push(
    check(
      "weather_provider_ready",
      "Weather provider readiness",
      weatherReady ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      weatherReady
        ? ["weather provider credential capability is configured"]
        : ["weather provider is not configured"],
    ),
  );

  // Optional provider precondition for the fixed web-search fixture. It is
  // deliberately NOT a blocking readiness check: an unconfigured optional
  // provider must leave the search check PENDING rather than fail-skip every
  // other AIBus probe.
  const braveSearchReady = settings.brave_search?.has_api_key === true;
  // The interim progress-turn stream is the harness's only in-band view of
  // which tool the planner selected.
  const progressTurnsEnabled = settings.llm?.hermes_progress_turns === true;

  const publicPlaceResolverReady = settings.openstreetmap?.enabled === true;
  checks.push(
    check(
      "public_place_resolver_ready",
      "Public place resolver readiness",
      publicPlaceResolverReady ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      publicPlaceResolverReady
        ? ["public place lookup is enabled for provider-grounded remote weather"]
        : ["public place lookup is disabled"],
    ),
  );

  const spotifyReady =
    spotify.enabled === true &&
    spotify.experimental_acknowledged === true &&
    spotify.state === "ready" &&
    spotify.engine_ready === true;
  const spotifyDisabled =
    spotify.enabled === false &&
    spotify.state === "disabled" &&
    spotify.engine_ready === false;
  const spotifyPrecondition = expectSpotifyDisabled ? spotifyDisabled : spotifyReady;
  checks.push(
    check(
      "spotify_provider_precondition",
      expectSpotifyDisabled
        ? "Spotify disabled-test precondition"
        : "Spotify provider readiness",
      spotifyPrecondition ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
      spotifyPrecondition
        ? [
            expectSpotifyDisabled
              ? "Spotify is explicitly disabled for the negative test"
              : "Spotify is enabled, paired, and engine-ready",
          ]
        : [
            expectSpotifyDisabled
              ? "Spotify is not in the exact disabled state"
              : "Spotify is not enabled, paired, and engine-ready",
          ],
    ),
  );

  const tickleDefinition = Array.isArray(featureFlags.flags)
    ? featureFlags.flags.find(
        (flag) => flag?.key === FEATURE_FLAGS.cloud.tickle,
      )
    : undefined;
  const tickleEnabled =
    isTaggedFeatureBoolean(tickleDefinition?.desired_value, true) &&
    isTaggedFeatureBoolean(tickleDefinition?.assignment_value, true);
  const stockCacheVerified =
    featureFlags.delivery?.state === "stock_cache_applied" &&
    featureFlags.delivery?.stock_cache_verified === true;
  checks.push(
    check(
      "tickle_feature_delivery",
      `${NATIVE_ACTIONS.TICKLE} feature delivery`,
      tickleEnabled && stockCacheVerified
        ? CHECK_STATUS.PASS
        : CHECK_STATUS.FAIL,
      tickleEnabled && stockCacheVerified
        ? [
            `${NATIVE_ACTIONS.TICKLE} is enabled and the exact assignment is verified in stock cache`,
          ]
        : [
            `${NATIVE_ACTIONS.TICKLE} is disabled or its stock-cache application is unverified`,
          ],
    ),
  );

  return {
    checks,
    context: {
      grpcPort,
      provider,
      toolsEnabled,
      maxToolTurns,
      codexReady,
      braveSearchReady,
      progressTurnsEnabled,
      publicPlaceResolverReady,
      spotifyReady,
      spotifyDisabled,
      tickleEnabled,
      stockCacheVerified,
    },
  };
}

export function pendingAutomatedChecks({ expectSpotifyDisabled = false } = {}) {
  const pending = [
    check(
      "compound_nearby_route_location_preflight",
      "Compound nearby-route location preflight",
      CHECK_STATUS.PENDING,
      [
        "rerun with --run-safe-aibus to verify the compound request begins with the authenticated-device location preflight",
      ],
    ),
    check(
      "weather_missing_location_first_action",
      "Weather missing-location first action",
      CHECK_STATUS.PENDING,
      ["rerun with --run-safe-aibus to exercise real Understand"],
    ),
    check(
      WEB_SEARCH_CHECK_ID,
      WEB_SEARCH_CHECK_TITLE,
      CHECK_STATUS.PENDING,
      [
        "rerun with --run-safe-aibus to observe whether the planner selects the web_search tool",
      ],
    ),
    check(
      "tickle_exact_phrase_routing",
      `${NATIVE_ACTIONS.TICKLE} exact-phrase AIBus routing`,
      CHECK_STATUS.PENDING,
      ["rerun with --run-safe-aibus to exercise real Understand without launch"],
    ),
  ];
  if (expectSpotifyDisabled) {
    pending.push(
      check(
        "disabled_spotify_fail_closed",
        "Disabled Spotify fail-closed behavior",
        CHECK_STATUS.PENDING,
        ["rerun with --run-safe-aibus under the explicit disabled precondition"],
      ),
    );
  } else {
    pending.push(
      check(
        "music_rank_one_match_playmusic",
        `${NATIVE_ACTIONS.PLAY_MUSIC} matches observed provider rank one`,
        CHECK_STATUS.PENDING,
        ["rerun with --run-safe-aibus to inspect the action without playback"],
      ),
      check(
        "disabled_spotify_fail_closed",
        "Disabled Spotify fail-closed behavior",
        CHECK_STATUS.PENDING,
        ["requires a separate explicitly disabled-provider run"],
      ),
    );
  }
  return pending;
}

export function manualVerificationChecks() {
  return [
    {
      id: "weather_physical_location_continuation",
      title: "Physical weather location continuation",
      status: CHECK_STATUS.PENDING,
      requirements: [
        `Ask the stock voice path exactly: ${PROMPTS.weather}`,
        `Capture one USER -> server ${NATIVE_ACTIONS.GET_CURRENT_LOCATION} -> DEVICE observation -> server ${NATIVE_ACTIONS.RESPOND} parent chain; redact the observation payload and all coordinates.`,
        "Require exactly one location action, one fresh device observation, no repeated location action, and a spoken current-weather answer.",
      ],
    },
    {
      id: "music_physical_announcement_and_playback",
      title: "Physical music announcement and playback",
      status: CHECK_STATUS.PENDING,
      requirements: [
        `Ask the stock voice path exactly: ${PROMPTS.music}`,
        "Require one spoken announcement before playback and a stock media session that enters PLAYING with advancing position.",
        "Privately compare the dispatched Track and Artist with provider rank one; record only pass/fail, never catalog or account content.",
      ],
    },
    {
      id: "tickle_physical_launcher",
      title: `Physical ${NATIVE_ACTIONS.TICKLE} launcher`,
      status: CHECK_STATUS.PENDING,
      requirements: [
        `Confirm ${NATIVE_ACTIONS.TICKLE} is enabled and stock-cache delivery is verified, then speak each of the three exact phrases separately.`,
        `Require the stock ${NATIVE_ACTIONS.TICKLE} foreground experience to launch exactly once per phrase; the non-exact phrase 'please tickle' must not launch it.`,
        "Capture only the foreground component/state and the PenumbraHook 3/3 gate-install result; do not capture surrounding transcripts.",
      ],
    },
    {
      id: "disabled_provider_maintenance_run",
      title: "Disabled-provider maintenance run",
      status: CHECK_STATUS.PENDING,
      requirements: [
        "In an approved maintenance window, disable Spotify in Center and confirm its status is exactly disabled.",
        `Run this harness with --run-safe-aibus --expect-spotify-disabled; require no ${NATIVE_ACTIONS.PLAY_MUSIC} action and no playback-success claim.`,
        "Re-enable Spotify afterward and rerun the normal enabled-provider chain; the harness never changes provider settings itself.",
      ],
    },
  ];
}

export function buildPublicReport({ mode, checks, manualChecks }) {
  const all = [...checks, ...manualChecks];
  const counts = Object.fromEntries(
    Object.values(CHECK_STATUS).map((status) => [
      status,
      all.filter((item) => item.status === status).length,
    ]),
  );
  const status =
    counts.fail > 0
      ? "failed"
      : counts.pending > 0
        ? "incomplete"
        : "passed";
  return {
    harness: "agentic-release-smoke",
    releaseSequence: RELEASE_SEQUENCE,
    requiredServerIdentity: { ...RELEASE_IDENTITY },
    mode,
    status,
    complete: status === "passed",
    safety: {
      explicitSerialRequired: mode !== "self-check",
      nativeActionsDispatched: false,
      coordinatesCollected: false,
      secretsPrinted: false,
    },
    checks,
    manualChecks,
    summary: counts,
  };
}

export function renderHumanReport(report) {
  const lines = [
    `Agentic release smoke (.${report.releaseSequence})`,
    `Mode: ${report.mode}`,
    `Status: ${report.status.toUpperCase()}`,
    "Safety: raw AIBus inspection only; no native action dispatch",
    "",
    "Automated checks:",
  ];
  for (const item of report.checks) {
    lines.push(`[${item.status.toUpperCase()}] ${item.title}`);
    for (const evidence of item.evidence) lines.push(`  - ${evidence}`);
  }
  lines.push("", "Manual evidence gates:");
  for (const item of report.manualChecks) {
    lines.push(`[${item.status.toUpperCase()}] ${item.title}`);
    for (const requirement of item.requirements) lines.push(`  - ${requirement}`);
  }
  lines.push(
    "",
    `Summary: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.pending} pending.`,
  );
  return lines.join("\n");
}

export function reportExitCode(report) {
  if (report.summary.fail > 0) return 1;
  if (report.summary.pending > 0) return INCOMPLETE_EXIT_CODE;
  return 0;
}
