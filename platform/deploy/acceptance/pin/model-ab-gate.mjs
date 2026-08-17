#!/usr/bin/env node

/// Host-side model A/B over the fixed zero-repair prompt gate.
///
/// Runs the exact `FIXED_PROMPT_MATRIX` gate cases (imported from
/// `platform/deploy/acceptance/pin/agentic-prompt-matrix.mjs`, the same suite the release matrix uses)
/// against a HOST-RUN runtime/core instance, once per candidate model, and
/// reports per-model {zero-repair pass rate, latency, wrong-action and
/// false-fire counts, best-effort repair markers}. The model is switched
/// through the authenticated admin settings API between passes and restored
/// afterwards.
///
/// Safety properties, by construction:
/// - Loopback only: both the admin URL and the gRPC URL must be plain-HTTP
///   loopback origins. This tool never touches adb, a device serial, or a
///   remote host. Device gate runs remain `platform/deploy/acceptance/pin/agentic-prompt-matrix.mjs`.
/// - Returned native actions are classified and never dispatched; volume
///   mutations stay excluded (`GLOBAL_EXCLUDED_TOOLS`); concurrency is 1.
/// - No prompt, response, or token text is printed. Reports carry case ids,
///   route classes, counts, and latencies only, passed through
///   `redactSensitive` with the admin token as a known secret.
/// - The run temporarily rewrites `llm.model` (or `llm.codex_model`) through
///   the settings API — which persists durably — and restores the original
///   value at the end unless `--keep-model` is passed.
///
/// The pass itself calls the live configured provider through the server, so
/// a real run needs the server's provider credential (for DashScope: the
/// vault/env `DASHSCOPE_API_KEY` on the server side) and provider access.
/// This tool holds no provider credential of its own.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect as connectHttp2, constants as http2Constants } from "node:http2";
import { pathToFileURL } from "node:url";

import {
  GrpcFrameDecoder,
  decodeUnderstandingResponses,
  encodeUnderstandingRequest,
  redactSensitive,
  validateUserTurnId,
  wrapGrpcFrame,
} from "./agentic-release-smoke-lib.mjs";
import {
  FIXED_PROMPT_MATRIX,
  GLOBAL_EXCLUDED_TOOLS,
  MATRIX_TIMEOUT_MS,
  ROUTE_CLASS,
  classifyMatrixResponse,
} from "./agentic-prompt-matrix.mjs";
import {
  NATIVE_ACTIONS,
  OPERATIONAL_MARKERS,
  RPC_PATHS,
} from "./tier-a-symbols.mjs";

const PROGRAM = "model-ab-gate";

export const DEFAULT_ADMIN_URL = "http://127.0.0.1:8080";
export const DEFAULT_GRPC_URL = "http://127.0.0.1:9090";
/// The DashScope candidates wired for the Pin. Purely a default; pass
/// `--models` to compare any configured set.
export const DEFAULT_MODELS = Object.freeze([
  "qwen3.7-max",
  "qwen-plus",
  "glm-5.2",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]);
export const MAX_MODELS = 8;
export const MAX_REPEATS = 5;
export const MAX_CASE_TIMEOUT_MS = 180_000;
export const MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES = 2;
export const ADMIN_TOKEN_ENVIRONMENT_VARIABLE = "PENUMBRA_ADMIN_TOKEN";
/// Warmup prompt: the matrix's own first agentic case. One warmup turn per
/// model (excluded from every statistic) so the comparison measures warm
/// provider-connection behavior for every candidate equally.
export const WARMUP_PROMPT =
  "In one short sentence, explain why ice floats on water.";
/// Content-free repair markers emitted by the hermes loop
/// (`runtime/core/src/synapse/chat_turn_loop.rs`). Counted best-effort from the
/// server log tail; a pass that stays clean of these markers is a
/// zero-repair pass at the runtime level, not just at the envelope level.
export const REPAIR_MARKERS = Object.freeze({
  verification_gate_nudges:
    OPERATIONAL_MARKERS.verification_gate_rejected.value,
  backend_errors: OPERATIONAL_MARKERS.step_backend_error.value,
  declines: OPERATIONAL_MARKERS.decline.value,
});
const LOG_TAIL_LINES = 20_000;
const ADMIN_REQUEST_TIMEOUT_MS = 10_000;
const MODEL_SETTLE_MS = 250;
const MODEL_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const SKIPPED_PROVIDER_STATUS = "skipped_provider_fixture_unavailable";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function usage() {
  return [
    "Usage:",
    `  node platform/deploy/acceptance/pin/${PROGRAM}.mjs --models qwen3.7-max,qwen-plus [options]`,
    "",
    "Compares candidate models on the fixed zero-repair prompt gate against a",
    "HOST-RUN runtime/core (loopback only; never a device). Requires the admin",
    `token in ${ADMIN_TOKEN_ENVIRONMENT_VARIABLE} or --token-file, and the`,
    "server itself must hold the provider credential.",
    "",
    "Options:",
    `  --models a,b,c       candidate models (default: ${DEFAULT_MODELS.join(",")})`,
    "  --cases id1,id2      subset of gate case ids (default: all)",
    "  --agentic-only       only cases that exercise the model",
    `  --repeats N          passes per model, 1..${MAX_REPEATS} (default: 1)`,
    `  --timeout-ms N       per-case deadline (default: ${MATRIX_TIMEOUT_MS}, max: ${MAX_CASE_TIMEOUT_MS})`,
    `  --admin-url URL      admin API origin (default: ${DEFAULT_ADMIN_URL})`,
    `  --grpc-url URL       AIBus gRPC origin (default: ${DEFAULT_GRPC_URL})`,
    "  --model-field FIELD  auto | model | codex_model (default: auto)",
    "  --token-file PATH    read the admin token from a file",
    "  --rank-one-file PATH JSON {title, artists[], album?} provider fixture",
    "  --no-warmup          skip the per-model warmup turn",
    "  --keep-model         do not restore the original model afterwards",
    "  --json               machine-readable report",
  ].join("\n");
}

/// Both targets must be bare plain-HTTP loopback origins. Rejecting anything
/// else keeps this tool structurally incapable of contacting a device,
/// provider, or LAN host directly.
export function assertLoopbackHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`${label} must use plain http on loopback`);
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error(`${label} must target loopback`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label} must be a bare origin`);
  }
  return `http://${url.host}`;
}

function parseList(value, label) {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) throw new Error(`${label} must not be empty`);
  return items;
}

export function validateModels(models) {
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) {
    throw new Error(`between 1 and ${MAX_MODELS} candidate models are required`);
  }
  const seen = new Set();
  for (const model of models) {
    if (typeof model !== "string" || !MODEL_NAME_PATTERN.test(model)) {
      throw new Error("invalid candidate model name");
    }
    if (seen.has(model)) throw new Error("duplicate candidate model name");
    seen.add(model);
  }
  return models;
}

export function modelTouchingCase(item) {
  return item.allowedRoutes.some((route) => String(route).startsWith("agentic"));
}

export function selectCases({ caseIds = null, agenticOnly = false } = {}) {
  const byId = new Map(FIXED_PROMPT_MATRIX.map((item) => [item.id, item]));
  let selected;
  if (caseIds === null) {
    selected = [...FIXED_PROMPT_MATRIX];
  } else {
    selected = caseIds.map((id) => {
      const item = byId.get(id);
      if (item === undefined) throw new Error("unknown gate case id");
      return item;
    });
    if (new Set(caseIds).size !== caseIds.length) {
      throw new Error("duplicate gate case id");
    }
  }
  if (agenticOnly) selected = selected.filter(modelTouchingCase);
  if (selected.length === 0) throw new Error("no gate cases selected");
  return selected;
}

export function parseAbCliArgs(argv) {
  const options = {
    models: [...DEFAULT_MODELS],
    caseIds: null,
    agenticOnly: false,
    repeats: 1,
    timeoutMs: MATRIX_TIMEOUT_MS,
    adminUrl: DEFAULT_ADMIN_URL,
    grpcUrl: DEFAULT_GRPC_URL,
    modelField: "auto",
    tokenFile: null,
    rankOneFile: null,
    warmup: true,
    keepModel: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error("missing command value");
      return value;
    };
    switch (argument) {
      case "--models":
        options.models = parseList(next(), "--models");
        break;
      case "--cases":
        options.caseIds = parseList(next(), "--cases");
        break;
      case "--agentic-only":
        options.agenticOnly = true;
        break;
      case "--repeats":
        options.repeats = Number(next());
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next());
        break;
      case "--admin-url":
        options.adminUrl = next();
        break;
      case "--grpc-url":
        options.grpcUrl = next();
        break;
      case "--model-field":
        options.modelField = next();
        break;
      case "--token-file":
        options.tokenFile = next();
        break;
      case "--rank-one-file":
        options.rankOneFile = next();
        break;
      case "--no-warmup":
        options.warmup = false;
        break;
      case "--keep-model":
        options.keepModel = true;
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

  validateModels(options.models);
  // Validates ids and the agentic-only interaction now, so a typo fails
  // before anything is contacted.
  selectCases({ caseIds: options.caseIds, agenticOnly: options.agenticOnly });
  if (
    !Number.isInteger(options.repeats) ||
    options.repeats < 1 ||
    options.repeats > MAX_REPEATS
  ) {
    throw new Error(`--repeats must be an integer between 1 and ${MAX_REPEATS}`);
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > MAX_CASE_TIMEOUT_MS
  ) {
    throw new Error(
      `--timeout-ms must be between 1000 and ${MAX_CASE_TIMEOUT_MS}`,
    );
  }
  if (!["auto", "model", "codex_model"].includes(options.modelField)) {
    throw new Error("--model-field must be auto, model, or codex_model");
  }
  options.adminUrl = assertLoopbackHttpUrl(options.adminUrl, "--admin-url");
  options.grpcUrl = assertLoopbackHttpUrl(options.grpcUrl, "--grpc-url");
  return options;
}

function validAdminToken(token) {
  return (
    typeof token === "string" &&
    token.length > 0 &&
    Buffer.byteLength(token) <= 512 &&
    !token.includes("\0") &&
    !token.includes("\n") &&
    !token.includes("\r")
  );
}

export async function resolveAdminToken(
  { tokenFile = null } = {},
  environment = process.env,
  readFileImpl = readFile,
) {
  const fromEnvironment = environment[ADMIN_TOKEN_ENVIRONMENT_VARIABLE];
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    if (!validAdminToken(fromEnvironment)) {
      throw new Error("environment admin token is malformed");
    }
    return fromEnvironment;
  }
  if (tokenFile === null) {
    throw new Error(
      `admin token unavailable; set ${ADMIN_TOKEN_ENVIRONMENT_VARIABLE} or pass --token-file`,
    );
  }
  const token = (await readFileImpl(tokenFile, "utf8")).trim();
  if (!validAdminToken(token)) throw new Error("token file content is malformed");
  return token;
}

class AdminApiError extends Error {
  constructor(status) {
    // Status-only by design: response bodies never enter error text.
    super(`admin API request failed (status ${status})`);
    this.status = status;
  }
}

async function adminRequest(
  fetchImpl,
  origin,
  path,
  token,
  { method = "GET", body = undefined } = {},
) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchImpl(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ADMIN_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new AdminApiError(response.status);
  return response;
}

async function adminJson(fetchImpl, origin, path, token, init) {
  return (await adminRequest(fetchImpl, origin, path, token, init)).json();
}

/// Chooses which settings field the A/B rewrites. With `provider = "codex"`
/// the model rides `llm.codex_model` (the custom OpenAI-compatible provider,
/// e.g. DashScope) — but only when that provider is actually active;
/// otherwise switching it would measure nothing.
export function selectModelField(settings, override = "auto") {
  if (override !== "auto") return override;
  const llm = settings?.llm;
  if (llm === undefined || llm === null) {
    throw new Error("settings response is missing the llm section");
  }
  if (llm.provider === "codex") {
    if (llm.codex_custom_active !== true) {
      throw new Error(
        "provider is codex without an active custom model provider; " +
          "pass --model-field explicitly if this is intended",
      );
    }
    return "codex_model";
  }
  return "model";
}

export function baselineModelValue(settings, field) {
  const value = field === "codex_model" ? settings?.llm?.codex_model : settings?.llm?.model;
  if (value === undefined) {
    throw new Error("settings response is missing the model baseline");
  }
  return value; // may be null for codex_model
}

/// The settings API clears optional codex_model with an empty string.
export function restoreRequestBody(field, originalValue) {
  const value = originalValue === null ? "" : originalValue;
  return { llm: { [field]: value } };
}

async function applyModel(runtime, context, field, model) {
  await adminJson(
    runtime.fetchImpl,
    context.adminUrl,
    "/api/settings",
    context.token,
    { method: "PUT", body: { llm: { [field]: model } } },
  );
  await runtime.sleep(MODEL_SETTLE_MS);
  const settings = await adminJson(
    runtime.fetchImpl,
    context.adminUrl,
    "/api/settings",
    context.token,
  );
  const active = baselineModelValue(settings, field);
  if (active !== model) {
    throw new Error("model switch could not be confirmed");
  }
}

export function validateRankOneFixture(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    !Array.isArray(value.artists) ||
    value.artists.length === 0 ||
    !value.artists.every(
      (artist) => typeof artist === "string" && artist.length > 0,
    ) ||
    (value.album !== undefined && typeof value.album !== "string")
  ) {
    throw new Error("invalid rank-one fixture shape");
  }
  return {
    title: value.title,
    artists: [...value.artists],
    ...(value.album === undefined ? {} : { album: value.album }),
  };
}

async function collectRankOne(runtime, context, options) {
  if (options.rankOneFile !== null) {
    const raw = await runtime.readFileImpl(options.rankOneFile, "utf8");
    return validateRankOneFixture(JSON.parse(raw));
  }
  try {
    const search = await adminJson(
      runtime.fetchImpl,
      context.adminUrl,
      "/api/spotify/search?kind=artist&q=Michael%20Jackson",
      context.token,
    );
    return validateRankOneFixture(
      Array.isArray(search?.items) ? search.items[0] : null,
    );
  } catch {
    return null; // provider-check cases will be skipped, and reported as such
  }
}

export function countMarkers(text) {
  const counts = {};
  for (const [key, marker] of Object.entries(REPAIR_MARKERS)) {
    counts[key] = typeof text === "string" ? text.split(marker).length - 1 : 0;
  }
  return counts;
}

async function markerSnapshot(runtime, context) {
  try {
    const response = await adminRequest(
      runtime.fetchImpl,
      context.adminUrl,
      `/api/logs/server?lines=${LOG_TAIL_LINES}`,
      context.token,
    );
    return countMarkers(await response.text());
  } catch {
    return null; // file logging not configured; markers become unavailable
  }
}

export function markerDelta(before, after) {
  if (before === null || after === null) return null;
  const delta = {};
  for (const key of Object.keys(REPAIR_MARKERS)) {
    const value = (after[key] ?? 0) - (before[key] ?? 0);
    if (value < 0) return null; // log rotation mid-pass; report unavailable
    delta[key] = value;
  }
  return delta;
}

/// Direct h2c Understand call against the host server; the loopback analogue
/// of `runUnderstand` in `platform/deploy/acceptance/pin/agentic-release-smoke.mjs` without the adb
/// tunnel. Failures never echo payloads.
export function runUnderstandDirect(
  grpcOrigin,
  utterance,
  { timeoutMs, userTurnId, excludedTools = [] },
  connectImpl = connectHttp2,
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let session;
    try {
      session = connectImpl(grpcOrigin);
    } catch {
      rejectPromise(new Error("the host AIBus probe failed"));
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
      callback();
    };
    const fail = () => {
      if (settled) return;
      try {
        stream?.close(http2Constants.NGHTTP2_CANCEL);
      } catch {}
      settle(() => rejectPromise(new Error("the host AIBus probe failed")));
    };

    const timer = setTimeout(fail, timeoutMs);
    timer.unref?.();
    session.on("error", fail);

    try {
      stream = session.request({
        ":method": "POST",
        ":path": RPC_PATHS.aibus_understand,
        "content-type": "application/grpc+proto",
        te: "trailers",
        "grpc-timeout": `${Math.max(1, Math.ceil(timeoutMs / 1_000))}S`,
        "x-ai-mic-run-id": `${PROGRAM}-${randomUUID()}`,
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
        const headerValue = (headers, name) => {
          const value = headers?.[name];
          if (Array.isArray(value)) return value.at(-1)?.toString();
          return value?.toString();
        };
        const httpStatus = Number(responseHeaders?.[":status"] ?? 0);
        const grpcStatus =
          headerValue(responseTrailers, "grpc-status") ??
          headerValue(responseHeaders, "grpc-status");
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
        userTurnId,
      });
      stream.end(wrapGrpcFrame(request));
    } catch {
      fail();
    }
  });
}

function caseRecord(item, repeat, classification, elapsedMs) {
  const wrongAction =
    classification.status === "fail" &&
    classification.actionName !== null &&
    !item.expectedActions.includes(classification.actionName);
  return {
    id: item.id,
    repeat,
    status: classification.status,
    routeClass: classification.routeClass,
    actionName: classification.actionName,
    ...(classification.providerMatch === undefined
      ? {}
      : { providerMatch: classification.providerMatch }),
    elapsedMs: Math.round(elapsedMs),
    modelTouching: modelTouchingCase(item),
    wrongAction,
    falseFire:
      wrongAction && classification.actionName !== NATIVE_ACTIONS.RESPOND,
  };
}

function skippedRecord(item, repeat) {
  return {
    id: item.id,
    repeat,
    status: SKIPPED_PROVIDER_STATUS,
    routeClass: null,
    actionName: null,
    elapsedMs: null,
    modelTouching: modelTouchingCase(item),
    wrongAction: false,
    falseFire: false,
  };
}

function notRunRecord(item, repeat) {
  return {
    id: item.id,
    repeat,
    status: "fail",
    routeClass: ROUTE_CLASS.NOT_RUN,
    actionName: null,
    elapsedMs: null,
    modelTouching: modelTouchingCase(item),
    wrongAction: false,
    falseFire: false,
  };
}

/// One full pass of the selected gate cases for the model that is currently
/// active on the server. Sequential by design; two consecutive transport
/// failures abort the pass (the remaining cases are recorded as not run).
export async function runModelPass({ cases, repeats, rankOne, runtime, context }) {
  const records = [];
  let consecutiveInfrastructureFailures = 0;
  let aborted = false;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const item of cases) {
      if (aborted) {
        records.push(notRunRecord(item, repeat));
        continue;
      }
      if (item.providerCheck !== undefined && rankOne === null) {
        records.push(skippedRecord(item, repeat));
        continue;
      }
      const userTurnId = validateUserTurnId(`ab-${randomUUID()}`);
      const startedAt = runtime.now();
      try {
        const responses = await runtime.runUnderstand(
          context.grpcUrl,
          item.prompt,
          {
            timeoutMs: context.timeoutMs,
            userTurnId,
            excludedTools: [...GLOBAL_EXCLUDED_TOOLS],
          },
        );
        consecutiveInfrastructureFailures = 0;
        const elapsedMs = Math.max(0, runtime.now() - startedAt);
        records.push(
          caseRecord(
            item,
            repeat,
            classifyMatrixResponse(item, responses, {
              userTurnId,
              elapsedMs,
              rankOne,
            }),
            elapsedMs,
          ),
        );
      } catch {
        consecutiveInfrastructureFailures += 1;
        records.push(
          caseRecord(
            item,
            repeat,
            {
              status: "fail",
              routeClass: ROUTE_CLASS.INFRASTRUCTURE_FAILURE,
              actionName: null,
              providerMatch: item.providerCheck === undefined ? undefined : false,
            },
            Math.max(0, runtime.now() - startedAt),
          ),
        );
        if (
          consecutiveInfrastructureFailures >=
          MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES
        ) {
          aborted = true;
        }
      }
    }
  }
  return { records, aborted };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(fraction * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

function mean(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function aggregateModelReport(model, records, markers) {
  const skipped = records.filter((r) => r.status === SKIPPED_PROVIDER_STATUS);
  const evaluated = records.filter((r) => r.status !== SKIPPED_PROVIDER_STATUS);
  const pass = evaluated.filter((r) => r.status === "pass").length;
  const infrastructure = evaluated.filter(
    (r) => r.routeClass === ROUTE_CLASS.INFRASTRUCTURE_FAILURE,
  ).length;
  const notRun = evaluated.filter(
    (r) => r.routeClass === ROUTE_CLASS.NOT_RUN,
  ).length;
  const completed = evaluated.filter(
    (r) =>
      r.routeClass !== ROUTE_CLASS.INFRASTRUCTURE_FAILURE &&
      r.routeClass !== ROUTE_CLASS.NOT_RUN &&
      r.elapsedMs !== null,
  );
  const latencies = completed.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const modelLatencies = completed
    .filter((r) => r.modelTouching)
    .map((r) => r.elapsedMs)
    .sort((a, b) => a - b);
  return {
    model,
    cases: {
      evaluated: evaluated.length,
      pass,
      fail: evaluated.length - pass,
      skippedProviderCases: skipped.length,
      infrastructureFailures: infrastructure,
      notRun,
    },
    zeroRepairRate:
      evaluated.length === 0
        ? null
        : Number((pass / evaluated.length).toFixed(4)),
    wrongActions: evaluated.filter((r) => r.wrongAction).length,
    falseFires: evaluated.filter((r) => r.falseFire).length,
    safeFailures: evaluated.filter(
      (r) => r.routeClass === ROUTE_CLASS.AGENTIC_SAFE_FAILURE,
    ).length,
    stockTimeouts: evaluated.filter(
      (r) => r.routeClass === ROUTE_CLASS.STOCK_TIMEOUT,
    ).length,
    latencyMs: {
      mean: mean(latencies),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.at(-1) ?? null,
      modelCaseMean: mean(modelLatencies),
    },
    repairMarkers: markers,
    records,
  };
}

function renderHumanReport(report) {
  const lines = [
    "Model A/B over the fixed zero-repair prompt gate",
    "Safety: loopback host server only; returned actions were classified and never dispatched",
    `Cases: ${report.caseIds.length} x ${report.repeats} repeat(s), model field: ${report.modelField}`,
    "",
  ];
  for (const entry of report.models) {
    const markers =
      entry.repairMarkers === null
        ? "markers=unavailable"
        : `nudges=${entry.repairMarkers.verification_gate_nudges} backend_errors=${entry.repairMarkers.backend_errors} declines=${entry.repairMarkers.declines}`;
    lines.push(
      `${entry.model}: zero_repair=${entry.zeroRepairRate ?? "n/a"} ` +
        `pass=${entry.cases.pass}/${entry.cases.evaluated} ` +
        `wrong=${entry.wrongActions} false_fire=${entry.falseFires} ` +
        `safe_fail=${entry.safeFailures} infra=${entry.cases.infrastructureFailures} ` +
        `mean_ms=${entry.latencyMs.mean ?? "n/a"} p95_ms=${entry.latencyMs.p95 ?? "n/a"} ` +
        `model_case_mean_ms=${entry.latencyMs.modelCaseMean ?? "n/a"} ${markers}`,
    );
  }
  lines.push(
    "",
    `Model restored: ${report.modelRestored === null ? "kept as last candidate (--keep-model)" : report.modelRestored ? "yes" : "RESTORE FAILED — restore llm settings manually"}`,
  );
  return lines.join("\n");
}

const DEFAULT_RUNTIME = Object.freeze({
  fetchImpl: (...args) => fetch(...args),
  runUnderstand: runUnderstandDirect,
  readFileImpl: readFile,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  environment: process.env,
});

export async function main(argv = process.argv.slice(2), dependencyOverrides = {}) {
  const runtime = { ...DEFAULT_RUNTIME, ...dependencyOverrides };
  let token = null;
  try {
    const options = parseAbCliArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const cases = selectCases({
      caseIds: options.caseIds,
      agenticOnly: options.agenticOnly,
    });
    token = await resolveAdminToken(
      { tokenFile: options.tokenFile },
      runtime.environment,
      runtime.readFileImpl,
    );
    const context = {
      adminUrl: options.adminUrl,
      grpcUrl: options.grpcUrl,
      timeoutMs: options.timeoutMs,
      token,
    };

    await adminRequest(runtime.fetchImpl, context.adminUrl, "/api/health", token);
    const settings = await adminJson(
      runtime.fetchImpl,
      context.adminUrl,
      "/api/settings",
      token,
    );
    const field = selectModelField(settings, options.modelField);
    const originalModel = baselineModelValue(settings, field);
    const rankOne = await collectRankOne(runtime, context, options);

    const modelReports = [];
    let anyAborted = false;
    let modelRestored = options.keepModel ? null : false;
    try {
      for (const model of options.models) {
        await applyModel(runtime, context, field, model);
        if (options.warmup) {
          try {
            await runtime.runUnderstand(context.grpcUrl, WARMUP_PROMPT, {
              timeoutMs: context.timeoutMs,
              userTurnId: validateUserTurnId(`ab-warmup-${randomUUID()}`),
              excludedTools: [...GLOBAL_EXCLUDED_TOOLS],
            });
          } catch {} // warmup is best-effort and excluded from statistics
        }
        const before = await markerSnapshot(runtime, context);
        const { records, aborted } = await runModelPass({
          cases,
          repeats: options.repeats,
          rankOne,
          runtime,
          context,
        });
        anyAborted = anyAborted || aborted;
        const after = await markerSnapshot(runtime, context);
        modelReports.push(
          aggregateModelReport(model, records, markerDelta(before, after)),
        );
      }
    } finally {
      if (!options.keepModel) {
        try {
          await adminJson(runtime.fetchImpl, context.adminUrl, "/api/settings", token, {
            method: "PUT",
            body: restoreRequestBody(field, originalModel),
          });
          const restored = await adminJson(
            runtime.fetchImpl,
            context.adminUrl,
            "/api/settings",
            token,
          );
          modelRestored = baselineModelValue(restored, field) === originalModel;
        } catch {
          modelRestored = false;
        }
      }
    }

    const report = {
      mode: "host_model_ab_prompt_gate",
      modelField: field,
      caseIds: cases.map((item) => item.id),
      repeats: options.repeats,
      providerFixtureAvailable: rankOne !== null,
      safety: {
        loopbackOnly: true,
        nativeActionsDispatched: false,
        volumeMutationsExcluded: true,
        promptsPrinted: false,
        rawResponsesPrinted: false,
        concurrency: 1,
      },
      models: modelReports,
      modelRestored,
    };
    const safe = redactSensitive(report, { knownSecrets: [token] });
    token = null;
    process.stdout.write(
      options.json
        ? `${JSON.stringify(safe, null, 2)}\n`
        : `${renderHumanReport(safe)}\n`,
    );
    if (modelRestored === false) return 1;
    return anyAborted ? 1 : 0;
  } catch {
    token = null;
    process.stderr.write(`${PROGRAM}: verification failed safely\n`);
    return 2;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = await main();
}
