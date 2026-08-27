#!/usr/bin/env node

import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { connect as connectHttp2, constants as http2Constants } from "node:http2";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Duplex, Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CHECK_STATUS,
  GrpcFrameDecoder,
  PROMPTS,
  SERVER_PACKAGE_NAME,
  WEB_SEARCH_CHECK_ID,
  WEB_SEARCH_CHECK_TITLE,
  buildActionResponseFixture,
  buildPublicReport,
  decodeProtoFields,
  decodeUnderstandingRequest,
  decodeUnderstandingResponses,
  deriveServerIdentityFromReleaseManifest,
  encodeUnderstandingRequest,
  evaluateCompoundNearbyRouteInitialProbe,
  evaluateDisabledSpotifyFailClosed,
  evaluateMusicChain,
  evaluateReadiness,
  evaluateTickleRouting,
  evaluateWeatherInitialProbe,
  evaluateWebSearch,
  manualVerificationChecks,
  parseCliArgs,
  parseInstalledServerPackageMetadata,
  pendingAutomatedChecks,
  redactSensitive,
  renderHumanReport,
  reportExitCode,
  validateSerial,
  validateReleaseMetadataPath,
  wrapGrpcFrame,
} from "./agentic-release-smoke-lib.mjs";
import { exactDeviceTargetMatches } from "./device-target-guard.mjs";
import { NATIVE_ACTIONS, RPC_PATHS } from "./tier-a-symbols.mjs";

const PROGRAM = "agentic-release-smoke";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FORK_ROOT = resolve(SCRIPT_DIR, "../../../../pin");
const DEFAULT_TOKEN_FILE = join(FORK_ROOT, ".secrets", "pin-admin-token");
export const PIN_ADMIN_TOKEN_FILE_ENV = "PENUMBRA_PIN_ADMIN_TOKEN_FILE";
export const RUNTIME_SECRETS_DIR_ENV = "PENUMBRA_RUNTIME_SECRETS_DIR";
const TOKEN_FILE_NAME = "pin-admin-token";
const MAX_TOKEN_PATH_BYTES = 4_096;
const MAX_TOKEN_FILE_BYTES = 1_026;
const HTTP_STATUS_MARKER = "\n__PENUMBRA_AGENTIC_HTTP_STATUS__:";
const MAX_CHILD_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const MUSIC_SEARCH_PATH =
  "/api/spotify/search?kind=artist&q=Michael%20Jackson";
const FIXED_API_PATHS = new Set([
  "/api/health",
  "/api/settings",
  "/api/spotify/status",
  "/api/feature-flags",
  MUSIC_SEARCH_PATH,
]);

class SafeSmokeError extends Error {
  constructor(publicMessage) {
    super(publicMessage);
    this.name = "SafeSmokeError";
    this.publicMessage = publicMessage;
  }
}

function usage() {
  return [
    "Usage:",
    "  node platform/deploy/acceptance/pin/agentic-release-smoke.mjs --self-check [--json]",
    "  node platform/deploy/acceptance/pin/agentic-release-smoke.mjs --serial SERIAL --expected-pin-serial SERIAL --release-manifest PATH --release-receipts PATH --inspect [--json]",
    "  node platform/deploy/acceptance/pin/agentic-release-smoke.mjs --serial SERIAL --expected-pin-serial SERIAL --release-manifest PATH --release-receipts PATH --run-safe-aibus [--json]",
    "  node platform/deploy/acceptance/pin/agentic-release-smoke.mjs --serial SERIAL --expected-pin-serial SERIAL --release-manifest PATH --release-receipts PATH --run-safe-aibus --expect-spotify-disabled [--json]",
    "",
    "Modes:",
    "  --self-check              Local parser/redaction self-check; no ADB request.",
    "  --inspect                 Read installed candidate identity and sanitized Center readiness only.",
    "  --run-safe-aibus          Also issue fixed raw Understand probes. Returned stock actions are inspected, never dispatched.",
    "  --expect-spotify-disabled Require exact disabled state and verify the fixed music prompt fails closed.",
    "",
    "Safety contract:",
    "  - A non-self-check run requires matching explicit and operator-confirmed AI Pin serials.",
    `  - The admin-token file defaults to .secrets/${TOKEN_FILE_NAME}; use one absolute ${PIN_ADMIN_TOKEN_FILE_ENV} or ${RUNTIME_SECRETS_DIR_ENV} override for external storage.`,
    "  - AIBus is blocked unless the canonical manifest, approved signer receipts, runtime health, installed package version, and Android signer identity all match.",
    "  - The admin token travels only through device-curl stdin config and is never printed or placed in argv.",
    "  - Understand probes contain only fixed public fixtures, no coordinates, history, images, contacts, or messages.",
    "  - The safe AIBus mode may call configured models/read-only providers and may create ordinary server activity metadata.",
    "  - No call, message, emergency, playback, launcher, camera, settings update, install, or reboot action is dispatched.",
    "  - Exit 3 means verification is incomplete because one or more automated or physical evidence gates remain pending.",
  ].join("\n");
}

function result(id, title, status, evidence) {
  return { id, title, status, evidence };
}

function failedProbe(id, title) {
  return result(id, title, CHECK_STATUS.FAIL, [
    "the fixed raw AIBus probe did not complete successfully",
  ]);
}

function pendingCheck(id, title, evidence) {
  return result(id, title, CHECK_STATUS.PENDING, [evidence]);
}

function captureChild(
  command,
  args,
  {
    input = null,
    timeoutMs = 20_000,
    maxStdoutBytes = MAX_CHILD_STDOUT_BYTES,
    deadline = null,
    now = () => Date.now(),
  } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let effectiveTimeoutMs = timeoutMs;
    if (deadline !== null) {
      const remaining = Math.max(0, deadline - now());
      if (remaining <= 0) {
        rejectPromise(new SafeSmokeError("a bounded operation was invoked with no remaining time budget"));
        return;
      }
      effectiveTimeoutMs = Math.min(timeoutMs, remaining);
    }
    let child;
    try {
      child = spawnProcess(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      rejectPromise(new SafeSmokeError("could not start a required local process"));
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
      finish(() => rejectPromise(new SafeSmokeError(message)));
    };

    const timer = setTimeout(
      () => fail("a bounded local transport operation timed out"),
      effectiveTimeoutMs,
    );
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail("a bounded transport response was too large");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    // Stderr is deliberately discarded: curl/ADB diagnostics can contain
    // implementation or endpoint data and are not needed for public evidence.
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
    if (inputBuffer === null) {
      child.stdin.end();
    } else {
      child.stdin.end(inputBuffer);
    }
  });
}

async function runAdb(adbPath, args, options, publicFailure) {
  const completed = await captureChild(adbPath, args, options);
  if (completed.code !== 0) throw new SafeSmokeError(publicFailure);
  return completed.stdout;
}

function requireExplicitAdbSerial(options) {
  try {
    return validateSerial(options?.serial);
  } catch {
    throw new SafeSmokeError("a valid explicit ADB serial is required");
  }
}

export async function verifyExplicitDevice(options) {
  const serial = requireExplicitAdbSerial(options);
  if (!exactDeviceTargetMatches(serial, options?.expectedPinSerial)) {
    throw new SafeSmokeError(
      "the explicit ADB serial does not match the expected AI Pin serial",
    );
  }
  const state = await runAdb(
    options.adbPath,
    ["-s", serial, "get-state"],
    { timeoutMs: 10_000, maxStdoutBytes: 128 },
    "the explicitly selected ADB device is not ready",
  );
  if (state.toString("utf8").trim() !== "device") {
    throw new SafeSmokeError("the explicitly selected ADB device is not ready");
  }
  await runAdb(
    options.adbPath,
    ["-s", serial, "shell", "command -v curl >/dev/null 2>&1"],
    { timeoutMs: 10_000, maxStdoutBytes: 128 },
    "device-side curl is unavailable",
  );
}

export async function collectInstalledServerIdentity(options) {
  const serial = requireExplicitAdbSerial(options);
  try {
    const packageMetadataOutput = await runAdb(
      options.adbPath,
      [
        "-s",
        serial,
        "shell",
        `exec /system/bin/dumpsys package ${SERVER_PACKAGE_NAME}`,
      ],
      { timeoutMs: 20_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES },
      "the installed server package metadata could not be verified",
    );
    return {
      packageName: SERVER_PACKAGE_NAME,
      ...parseInstalledServerPackageMetadata(packageMetadataOutput),
    };
  } catch {
    throw new SafeSmokeError(
      "the installed server identity could not be verified safely",
    );
  }
}

export async function loadExpectedServerIdentity(options) {
  try {
    const manifestPath = validateReleaseMetadataPath(
      options?.releaseManifestPath,
      "--release-manifest",
    );
    const receiptsPath = validateReleaseMetadataPath(
      options?.releaseReceiptsPath,
      "--release-receipts",
    );
    const [manifestSource, receiptsSource] = await Promise.all([
      readFile(manifestPath, "utf8"),
      readFile(receiptsPath, "utf8"),
    ]);
    return deriveServerIdentityFromReleaseManifest(manifestSource, receiptsSource);
  } catch {
    throw new SafeSmokeError(
      "expected Server identity requires canonical verified five-APK release metadata",
    );
  }
}

function validateTokenPathOverride(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_PATH_BYTES ||
    /[\0-\x1f\x7f]/.test(value) ||
    !isAbsolute(value)
  ) {
    throw new SafeSmokeError("the admin-token path override is invalid");
  }
  return resolve(value);
}

export function resolveAdminTokenFile(environment = process.env) {
  const fileOverride = environment?.[PIN_ADMIN_TOKEN_FILE_ENV];
  const directoryOverride = environment?.[RUNTIME_SECRETS_DIR_ENV];
  if (fileOverride !== undefined && directoryOverride !== undefined) {
    throw new SafeSmokeError("choose only one admin-token path override");
  }
  if (fileOverride !== undefined) {
    return validateTokenPathOverride(fileOverride);
  }
  if (directoryOverride !== undefined) {
    return join(validateTokenPathOverride(directoryOverride), TOKEN_FILE_NAME);
  }
  return DEFAULT_TOKEN_FILE;
}

export async function readAdminToken(environment = process.env) {
  const tokenFile = resolveAdminTokenFile(environment);
  let handle = null;
  let bytes = null;
  try {
    handle = await open(
      tokenFile,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 16 ||
      metadata.size > MAX_TOKEN_FILE_BYTES
    ) {
      throw new SafeSmokeError("the fixed admin-token file is invalid");
    }
    bytes = await handle.readFile();
    if (bytes.length !== metadata.size) {
      throw new SafeSmokeError("the fixed admin-token file is invalid");
    }
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof SafeSmokeError) throw error;
    throw new SafeSmokeError("the fixed admin-token file is missing or unreadable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  try {
    const text = bytes.toString("utf8");
    const token = text.endsWith("\r\n")
      ? text.slice(0, -2)
      : text.endsWith("\n")
        ? text.slice(0, -1)
        : text;
    if (
      token.length < 16 ||
      token.length > 1_024 ||
      /[\r\n]/.test(token) ||
      !/^[A-Za-z0-9._~+/=:-]+$/.test(token)
    ) {
      throw new SafeSmokeError("the fixed admin-token file is invalid");
    }
    return token;
  } finally {
    bytes.fill(0);
  }
}

function curlConfig(path, token, maxCurlSeconds = 30) {
  if (!FIXED_API_PATHS.has(path)) {
    throw new SafeSmokeError("refusing a non-allowlisted Center endpoint");
  }
  const clampedSeconds = Math.max(1, Math.min(30, Math.floor(maxCurlSeconds)));
  return Buffer.from(
    [
      `url = "http://127.0.0.1:8080${path}"`,
      'request = "GET"',
      `header = "Authorization: Bearer ${token}"`,
      'header = "Accept: application/json"',
      'header = "User-Agent: penumbra-agentic-release-smoke/1"',
      "silent",
      "show-error",
      "connect-timeout = 5",
      `max-time = ${clampedSeconds}`,
      'noproxy = "*"',
      'proto = "=http"',
      `write-out = "${HTTP_STATUS_MARKER.replace("\n", "\\n")}%{http_code}\\n"`,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function deviceJsonGet(options, token, path, deadline = null, now = () => Date.now()) {
  const serial = requireExplicitAdbSerial(options);
  let childTimeoutMs = 40_000;
  let curlMaxTime = 30;
  if (deadline !== null) {
    const remaining = Math.max(0, deadline - now());
    if (remaining <= 0) {
      throw new SafeSmokeError("a bounded operation was invoked with no remaining time budget");
    }
    childTimeoutMs = Math.min(40_000, remaining);
    curlMaxTime = Math.min(30, Math.floor(remaining / 1000));
  }
  const output = await runAdb(
    options.adbPath,
    ["-s", serial, "shell", "exec curl -q -K -"],
    {
      input: curlConfig(path, token, curlMaxTime),
      timeoutMs: childTimeoutMs,
      maxStdoutBytes: MAX_CHILD_STDOUT_BYTES,
      deadline,
      now,
    },
    "the fixed Center request failed",
  );
  const marker = Buffer.from(HTTP_STATUS_MARKER, "utf8");
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new SafeSmokeError("the fixed Center response had no HTTP status");
  }
  const statusText = output
    .subarray(markerIndex + marker.length)
    .toString("ascii")
    .trim();
  if (!/^[0-9]{3}$/.test(statusText)) {
    throw new SafeSmokeError("the fixed Center response had an invalid HTTP status");
  }
  if (statusText !== "200") {
    throw new SafeSmokeError("a required fixed Center endpoint was unavailable");
  }
  const body = output.subarray(0, markerIndex);
  if (body.length === 0 || body.length > MAX_HTTP_BODY_BYTES) {
    throw new SafeSmokeError("a required fixed Center response had invalid size");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new SafeSmokeError("a required fixed Center response was not valid JSON");
  }
}

export async function collectReadiness(options, token, deadline = null, now = () => Date.now()) {
  const health = await deviceJsonGet(options, token, "/api/health", deadline, now);
  if (deadline !== null && now() >= deadline) {
    throw new SafeSmokeError("readiness collection exceeded the deadline");
  }
  const [settings, spotify, featureFlags] = await Promise.all([
    deviceJsonGet(options, token, "/api/settings", deadline, now),
    deviceJsonGet(options, token, "/api/spotify/status", deadline, now),
    deviceJsonGet(options, token, "/api/feature-flags", deadline, now),
  ]);
  if (deadline !== null && now() >= deadline) {
    throw new SafeSmokeError("readiness collection exceeded the deadline");
  }
  return { health, settings, spotify, featureFlags };
}

export function openAdbShellAibusTunnel(
  options,
  devicePort,
  {
    spawn = spawnProcess,
    maxResponseBytes = MAX_CHILD_STDOUT_BYTES,
  } = {},
) {
  const serial = requireExplicitAdbSerial(options);
  if (!Number.isInteger(devicePort) || devicePort < 1 || devicePort > 65_535) {
    throw new SafeSmokeError("the configured AIBus port is invalid");
  }
  if (
    typeof options?.adbPath !== "string" ||
    options.adbPath.length === 0 ||
    options.adbPath.includes("\0")
  ) {
    throw new SafeSmokeError("ADB executable path is required");
  }
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_CHILD_STDOUT_BYTES
  ) {
    throw new SafeSmokeError("the AIBus transport response bound is invalid");
  }

  let child;
  try {
    child = spawn(
      options.adbPath,
      [
        "-s",
        serial,
        "shell",
        "-T",
        "nc",
        "127.0.0.1",
        String(devicePort),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    throw new SafeSmokeError("the bounded AIBus tunnel could not be started");
  }
  if (
    child === null ||
    typeof child !== "object" ||
    typeof child.kill !== "function" ||
    child.stdin?.writable !== true ||
    child.stdout?.readable !== true ||
    child.stderr?.readable !== true
  ) {
    try {
      child?.kill?.();
    } catch {}
    throw new SafeSmokeError("the bounded AIBus tunnel could not be started");
  }

  let responseBytes = 0;
  let closed = false;
  let stream;
  const boundedOutput = new Transform({
    transform(chunk, _encoding, callback) {
      responseBytes += chunk.length;
      if (responseBytes > maxResponseBytes) {
        callback(new SafeSmokeError("the bounded AIBus response was too large"));
        return;
      }
      callback(null, chunk);
    },
  });
  child.stdout.pipe(boundedOutput);
  stream = Duplex.from({ readable: boundedOutput, writable: child.stdin });

  const close = () => {
    if (closed) return;
    closed = true;
    child.stdout.unpipe(boundedOutput);
    stream.destroy();
    boundedOutput.destroy();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {}
    }
  };
  const failTransport = () => {
    if (!closed) {
      stream.destroy(new SafeSmokeError("the bounded AIBus tunnel failed"));
    }
  };

  // ADB diagnostics are deliberately discarded. They can contain endpoint or
  // implementation details and cannot strengthen public release evidence.
  child.stderr.on("error", () => {});
  child.stderr.resume();
  child.stdin.on("error", failTransport);
  child.stdout.on("error", failTransport);
  child.on("error", failTransport);
  child.on("close", (code, signal) => {
    if (!closed && (code !== 0 || signal !== null)) failTransport();
  });
  boundedOutput.on("error", close);
  stream.on("error", close);
  stream.on("close", close);

  return { stream, close };
}

function grpcHeaderValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.at(-1)?.toString();
  return value?.toString();
}

export function buildAibusRequestHeaders(timeoutMs, micRunId, authToken) {
  if (authToken !== undefined) {
    if (
      typeof authToken !== "string" ||
      authToken.length < 16 ||
      authToken.length > 1_024 ||
      /[\r\n]/.test(authToken) ||
      !/^[A-Za-z0-9._~+/=:-]+$/.test(authToken)
    ) {
      throw new SafeSmokeError("the AIBus authentication token is invalid");
    }
  }
  return {
    ":method": "POST",
    ":path": RPC_PATHS.aibus_understand,
    "content-type": "application/grpc+proto",
    te: "trailers",
    "grpc-timeout": `${Math.max(1, Math.ceil(timeoutMs / 1_000))}S`,
    "x-ai-mic-run-id": micRunId,
    ...(authToken === undefined
      ? {}
      : { authorization: `Bearer ${authToken}` }),
  };
}

export function runUnderstand(
  options,
  devicePort,
  utterance,
  {
    timeoutMs,
    userTurnId,
    excludedTools = [],
    authToken,
  },
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let tunnel;
    let session;
    try {
      tunnel = openAdbShellAibusTunnel(options, devicePort);
      session = connectHttp2(`http://127.0.0.1:${devicePort}`, {
        createConnection: () => tunnel.stream,
      });
    } catch {
      tunnel?.close();
      rejectPromise(new SafeSmokeError("the fixed raw AIBus probe failed"));
      return;
    }
    const decoder = new GrpcFrameDecoder();
    const frames = [];
    let responseHeaders;
    let responseTrailers;
    let settled = false;
    let stream;

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
        rejectPromise(new SafeSmokeError("the fixed raw AIBus probe failed")),
      );
    };

    const timer = setTimeout(fail, timeoutMs);
    timer.unref?.();
    session.on("error", fail);

    try {
      stream = session.request(
        buildAibusRequestHeaders(
          timeoutMs,
          `release-smoke-${randomUUID()}`,
          authToken,
        ),
      );
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
        if (httpStatus !== 200 || grpcStatus !== "0") {
          fail();
          return;
        }
        const decoded = decodeUnderstandingResponses(frames);
        settle(() => resolvePromise(decoded));
      } catch {
        fail();
      }
    });

    try {
      const request = encodeUnderstandingRequest({
        utterance,
        excludedTools,
        ...(userTurnId === undefined ? {} : { userTurnId }),
      });
      stream.end(wrapGrpcFrame(request));
    } catch {
      fail();
    }
  });
}

async function safeProbe(options, devicePort, prompt, timeoutMs, authToken) {
  try {
    return await runUnderstand(options, devicePort, prompt, {
      timeoutMs,
      excludedTools: [
        NATIVE_ACTIONS.SET_VOLUME,
        NATIVE_ACTIONS.INCREMENT_VOLUME,
        NATIVE_ACTIONS.DECREMENT_VOLUME,
      ],
      authToken,
    });
  } catch {
    return null;
  }
}

function extractRankOne(searchResponse) {
  const item = Array.isArray(searchResponse?.items)
    ? searchResponse.items[0]
    : undefined;
  if (
    item === undefined ||
    typeof item.title !== "string" ||
    item.title.length === 0 ||
    !Array.isArray(item.artists) ||
    item.artists.length === 0 ||
    !item.artists.every((artist) => typeof artist === "string")
  ) {
    return null;
  }
  return {
    title: item.title,
    artists: [...item.artists],
    ...(typeof item.album === "string" ? { album: item.album } : {}),
  };
}

export async function collectFixedMusicRankOne(options, token) {
  return extractRankOne(await deviceJsonGet(options, token, MUSIC_SEARCH_PATH));
}

async function runAibusChecks(options, token, context) {
  const checks = [];
  if (context.grpcPort === null) {
    return [
      failedProbe(
        "compound_nearby_route_location_preflight",
        "Compound nearby-route location preflight",
      ),
      failedProbe(
        "weather_missing_location_first_action",
        "Weather missing-location first action",
      ),
      failedProbe(WEB_SEARCH_CHECK_ID, WEB_SEARCH_CHECK_TITLE),
      failedProbe(
        "tickle_exact_phrase_routing",
        `${NATIVE_ACTIONS.TICKLE} exact-phrase AIBus routing`,
      ),
      options.expectSpotifyDisabled
        ? failedProbe(
            "disabled_spotify_fail_closed",
            "Disabled Spotify fail-closed behavior",
          )
        : failedProbe(
            "music_rank_one_match_playmusic",
            `${NATIVE_ACTIONS.PLAY_MUSIC} matches observed provider rank one`,
          ),
    ];
  }

  const compoundNearbyRoute = await safeProbe(
    options,
    context.grpcPort,
    PROMPTS.compoundNearbyRoute,
    30_000,
    token,
  );
  checks.push(
    compoundNearbyRoute === null
      ? failedProbe(
          "compound_nearby_route_location_preflight",
          "Compound nearby-route location preflight",
        )
      : evaluateCompoundNearbyRouteInitialProbe(compoundNearbyRoute, context),
  );

  const weather = await safeProbe(
    options,
    context.grpcPort,
    PROMPTS.weather,
    30_000,
    token,
  );
  checks.push(
    weather === null
      ? failedProbe(
          "weather_missing_location_first_action",
          "Weather missing-location first action",
        )
      : evaluateWeatherInitialProbe(weather),
  );

  // Fixed public web-search fixture. Skipped unless the tool is advertised (a
  // configured Brave subscription) and the interim progress-turn stream that
  // reveals tool selection is enabled; without both, a non-selection would
  // prove nothing and the evaluator reports PENDING instead of failing. The
  // read-only search may take a full agentic loop, so it gets the same budget
  // as the music chain.
  const webSearchObservable =
    context.braveSearchReady === true && context.progressTurnsEnabled === true;
  const webSearch = webSearchObservable
    ? await safeProbe(options, context.grpcPort, PROMPTS.webSearch, 120_000, token)
    : null;
  checks.push(
    webSearchObservable && webSearch === null
      ? failedProbe(WEB_SEARCH_CHECK_ID, WEB_SEARCH_CHECK_TITLE)
      : evaluateWebSearch(webSearch, context),
  );

  if (options.expectSpotifyDisabled) {
      checks.push(
        pendingCheck(
          "music_rank_one_match_playmusic",
          `${NATIVE_ACTIONS.PLAY_MUSIC} matches observed provider rank one`,
          "intentionally deferred during the explicit disabled-provider run",
        ),
      );
      if (context.spotifyDisabled) {
        const music = await safeProbe(
          options,
          context.grpcPort,
          PROMPTS.music,
          120_000,
          token,
        );
        checks.push(
          music === null
            ? failedProbe(
                "disabled_spotify_fail_closed",
                "Disabled Spotify fail-closed behavior",
              )
            : evaluateDisabledSpotifyFailClosed(music, { disabled: true }),
        );
      } else {
        checks.push(
          evaluateDisabledSpotifyFailClosed([], { disabled: false }),
        );
      }
  } else {
      if (context.spotifyReady) {
        let rankOne = null;
        try {
          rankOne = extractRankOne(
            await deviceJsonGet(options, token, MUSIC_SEARCH_PATH),
          );
        } catch {}
        const music = await safeProbe(
          options,
          context.grpcPort,
          PROMPTS.music,
          120_000,
          token,
        );
        checks.push(
          music === null || rankOne === null
            ? failedProbe(
                "music_rank_one_match_playmusic",
                `${NATIVE_ACTIONS.PLAY_MUSIC} matches observed provider rank one`,
              )
            : evaluateMusicChain(music, rankOne),
        );
      } else {
        checks.push(
          failedProbe(
            "music_rank_one_match_playmusic",
            `${NATIVE_ACTIONS.PLAY_MUSIC} matches observed provider rank one`,
          ),
        );
      }
      checks.push(
        evaluateDisabledSpotifyFailClosed([], { disabled: false }),
      );
  }

  if (context.tickleEnabled && context.stockCacheVerified) {
    const tickleEvidence = new Map();
    for (const phrase of PROMPTS.tickle) {
      const response = await safeProbe(
        options,
        context.grpcPort,
        phrase,
        30_000,
        token,
      );
      if (response !== null) tickleEvidence.set(phrase, response);
    }
    const negativeResponse = await safeProbe(
      options,
      context.grpcPort,
      PROMPTS.tickleNegative,
      30_000,
      token,
    );
    if (negativeResponse !== null) {
      tickleEvidence.set(PROMPTS.tickleNegative, negativeResponse);
    }
    checks.push(evaluateTickleRouting(tickleEvidence, context));
  } else {
    checks.push(evaluateTickleRouting(new Map(), context));
  }
  return checks;
}

function selfCheckReport() {
  const request = encodeUnderstandingRequest({
    utterance: PROMPTS.weather,
    excludedTools: [NATIVE_ACTIONS.PLAY_MUSIC],
  });
  const requestFields = decodeProtoFields(request);
  if (!requestFields.has(1) || !requestFields.has(3) || !requestFields.has(8)) {
    throw new SafeSmokeError("local protobuf self-check failed");
  }
  const decodedRequest = decodeUnderstandingRequest(request);
  if (
    decodedRequest.utterance !== PROMPTS.weather ||
    decodedRequest.deviceContext.isLocked ||
    decodedRequest.hasLocation
  ) {
    throw new SafeSmokeError("local request-context self-check failed");
  }
  const fixture = buildActionResponseFixture({
    action: NATIVE_ACTIONS.GET_CURRENT_LOCATION,
    input: "{}",
    thought: "self-check",
  });
  const framed = wrapGrpcFrame(fixture);
  const decoder = new GrpcFrameDecoder();
  const frames = [
    ...decoder.push(framed.subarray(0, 3)),
    ...decoder.push(framed.subarray(3)),
  ];
  decoder.finish();
  const decoded = decodeUnderstandingResponses(frames);
  if (decoded[0]?.action !== NATIVE_ACTIONS.GET_CURRENT_LOCATION) {
    throw new SafeSmokeError("local gRPC parser self-check failed");
  }
  const canary = "self-check-secret-canary";
  const redacted = redactSensitive(`Authorization: Bearer ${canary}`, {
    knownSecrets: [canary],
  });
  if (redacted.includes(canary)) {
    throw new SafeSmokeError("local redaction self-check failed");
  }
  return buildPublicReport({
    mode: "self-check",
    expectedIdentity: null,
    checks: [
      result(
        "local_protocol_and_redaction",
        "Local protocol and redaction self-check",
        CHECK_STATUS.PASS,
        ["protobuf, gRPC framing, and secret redaction fixtures passed"],
      ),
    ],
    manualChecks: [],
  });
}

function printReport(report, { json, knownSecrets = [] }) {
  const safe = redactSensitive(report, { knownSecrets });
  const output = json
    ? `${JSON.stringify(safe, null, 2)}\n`
    : `${renderHumanReport(safe)}\n`;
  process.stdout.write(output);
}

const DEFAULT_RUNTIME = Object.freeze({
  loadExpectedServerIdentity,
  verifyExplicitDevice,
  collectInstalledServerIdentity,
  readAdminToken,
  collectReadiness,
  runAibusChecks,
  printReport,
});

export async function main(
  argv = process.argv.slice(2),
  dependencyOverrides = {},
) {
  const runtime = { ...DEFAULT_RUNTIME, ...dependencyOverrides };
  let options;
  let adminToken = null;
  try {
    try {
      options = parseCliArgs(argv);
    } catch (error) {
      throw new SafeSmokeError(
        error instanceof Error ? error.message : "invalid command line",
      );
    }
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.mode === "self-check") {
      const report = selfCheckReport();
      runtime.printReport(report, options);
      return reportExitCode(report);
    }

    const expectedIdentity = await runtime.loadExpectedServerIdentity(options);
    await runtime.verifyExplicitDevice(options);
    const packageIdentity =
      await runtime.collectInstalledServerIdentity(options);
    adminToken = await runtime.readAdminToken();
    const snapshot = await runtime.collectReadiness(options, adminToken);
    const readiness = evaluateReadiness(
      { ...snapshot, packageIdentity },
      {
        expectSpotifyDisabled: options.expectSpotifyDisabled,
        expectedIdentity,
      },
    );
    const checks = [...readiness.checks];
    const prerequisitesPassed = readiness.checks.every(
      (item) => item.status === CHECK_STATUS.PASS,
    );
    if (options.mode === "inspect") {
      checks.push(
        ...pendingAutomatedChecks({
          expectSpotifyDisabled: options.expectSpotifyDisabled,
        }),
      );
    } else if (!prerequisitesPassed) {
      checks.push(
        ...pendingAutomatedChecks({
          expectSpotifyDisabled: options.expectSpotifyDisabled,
        }).map((item) => ({
          ...item,
          evidence: [
            "not executed because a required identity or readiness gate failed",
          ],
        })),
      );
    } else {
      checks.push(
        ...(await runtime.runAibusChecks(
          options,
          adminToken,
          readiness.context,
        )),
      );
    }
    const report = buildPublicReport({
      mode: options.expectSpotifyDisabled
        ? "run-safe-aibus/expect-spotify-disabled"
        : options.mode,
      checks,
      expectedIdentity,
      manualChecks: manualVerificationChecks(),
    });
    runtime.printReport(report, {
      json: options.json,
      knownSecrets: [adminToken],
    });
    adminToken = null;
    return reportExitCode(report);
  } catch (error) {
    const publicMessage =
      error instanceof SafeSmokeError
        ? error.publicMessage
        : "local release verification failed safely";
    const safeMessage = redactSensitive(publicMessage, {
      knownSecrets: adminToken === null ? [] : [adminToken],
    });
    adminToken = null;
    process.stderr.write(`${PROGRAM}: ${safeMessage}\n`);
    process.stderr.write(`Run with --help for the safety contract.\n`);
    return 2;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await main();
