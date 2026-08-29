// commands/probe.mjs — the per-prompt agentic evidence engine.
//
// Sends one utterance through the real Understand gRPC RPC (the path that
// replaces stock NLU) and bundles everything that explains the run into one
// timestamped dir: planned actions, executed tools (ok/failed), the spoken
// answer, the server's structured hermes trace, the logcat window, and an
// independent activity-API before/after diff.
//
// Default is SAFE: the probe returns planned actions as data and they are
// never dispatched. `--dispatch` opts into real dispatch for the subset of
// planned actions that map to the stock-action-test enum (PlayMusic / message
// / call / photo), guarded by a media-volume snapshot+restore. Volume-control
// actions are not in that enum and are reported as undpatchable, not skipped.
//
// Heavy lifting lives in shared/*; this module owns only the pipeline order
// and its own arg parsing + presentation.

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";

import { runUnderstand, readAdminToken, verifyExplicitDevice, collectReadiness } from "../../agentic-release-smoke.mjs";
import { SUITE, evaluateCase } from "../../prompt-suite.mjs";
import { captureStableMediaVolumeSnapshot, restoreMediaVolumeSnapshot } from "../../media-volume-state-guard.mjs";
import { OPERATIONAL_MARKERS } from "../../tier-a-symbols.mjs";
import {
  EXPECTED_PIN_SERIAL_ENV,
  resolveExpectedDeviceSerial,
} from "../../../pin/device-target-guard.mjs";
import { ProbeError, makeMediaVolumeDevice, runAdb } from "../shared/adb.mjs";
import { deviceJsonGet, deviceTextGet, deviceJsonPost } from "../shared/admin-http.mjs";
import {
  newBoundaryMarker,
  dropBoundary,
  sliceLogcatSince,
  pullLogcatWindow,
  parseExecutedTools,
  parseNlu,
  parseNativeActions,
  detectProviderDecline,
  parseMusicRankingDegraded,
} from "../shared/logcat.mjs";
import {
  summarizeResponses,
  assessAgenticGate,
  diffActivity,
  stockActionPayload,
  STOCK_ACTION_DISPATCHABLE,
  MAX_ANSWER_CHARS_STDOUT,
} from "../shared/evidence.mjs";

const PROGRAM = "probe";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FORK_ROOT = resolve(SCRIPT_DIR, "../../../../../../pin");
const TEST_RUNS_DIR = join(FORK_ROOT, "test-runs");

// This is the Pin-local server. Stock apps do not use this address for remote
// Cosmos in an activated release: ChannelFactoryBypass routes them to the
// operator-owned mTLS edge. The local server deliberately retains an echo LLM,
// so a probe that receives its exact echo response has measured the wrong
// planning plane and must fail rather than report plausible-looking evidence.
const DEVICE_PORT = 9_090;
const DEFAULT_TIMEOUT_MS = 90_000;
const SETTLE_MS = 1_500;

// Re-export the shared parsers so probe's own test can import them from one
// place (and so the dispatcher can surface them if needed).
export {
  parseExecutedTools,
  parseNlu,
  parseNativeActions,
  detectProviderDecline,
  parseMusicRankingDegraded,
  sliceLogcatSince,
};

// ---- probe-specific arg parsing (flags pinbox does not consume) ----
export function parseProbeArgs(passthrough) {
  const opts = {
    prompts: [],
    repl: false,
    dispatch: false,
    score: false,
    screencap: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    expectedPinSerial: null,
  };
  for (let i = 0; i < passthrough.length; i += 1) {
    const arg = passthrough[i];
    if (arg === "--prompt") {
      // Without this guard a trailing `--prompt` pushes `undefined`, which
      // survives the length check below and only fails much later inside
      // slugify(utterance) as an opaque per-prompt FATAL.
      const value = passthrough[++i];
      if (value === undefined) return { error: "--prompt requires a value" };
      opts.prompts.push(value);
    }
    else if (arg === "--repl") opts.repl = true;
    else if (arg === "--dispatch") opts.dispatch = true;
    else if (arg === "--score") opts.score = true;
    else if (arg === "--screencap") opts.screencap = true;
    else if (arg === "--expected-pin-serial") {
      if (opts.expectedPinSerial !== null) {
        return { error: "--expected-pin-serial may be provided once" };
      }
      const value = passthrough[++i];
      if (value === undefined) return { error: "--expected-pin-serial requires a value" };
      opts.expectedPinSerial = value;
    }
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(passthrough[++i]);
    else return { error: `unknown argument: ${arg}` };
  }
  if (!opts.repl && opts.prompts.length === 0) {
    return { error: "either --prompt or --repl is required" };
  }
  if (opts.repl && opts.prompts.length > 0) {
    return { error: "--repl and --prompt are mutually exclusive" };
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 5_000 || opts.timeoutMs > 300_000) {
    return { error: "--timeout-ms must be an integer between 5000 and 300000" };
  }
  return { options: opts };
}

export function buildProbeDeviceOptions(common, probeOpts, environment = process.env) {
  return {
    serial: common.serial,
    expectedPinSerial: resolveExpectedDeviceSerial({
      cliValue: probeOpts.expectedPinSerial,
      environment,
      environmentName: EXPECTED_PIN_SERIAL_ENV,
      label: "AI Pin serial",
    }),
    adbPath: common.adb ?? "adb",
  };
}

// ---- run-directory helpers ----
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "prompt";
}

function stampNow(now) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(now.getFullYear())}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2), "utf8");
const writeText = (path, text) => writeFile(path, text, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- optional-evidence guard ----
//
// THE RULE: an evidence-gathering step that can throw will report a device
// failure that did not happen. That is not hypothetical here — the activity
// cross-check (SUPPORTING evidence, computed AFTER the model had already
// answered) threw on the real `{items:[…]}` payload, escaped `runPrompt`, and
// every probe came back `{fatal: …}` with no latency and no answer. The bogus
// result read as a total collapse of the agentic path.
//
// So every step that is not the measurement itself runs through this: it
// catches synchronous throws and rejections alike, degrades that ONE field to a
// declared fallback, and records WHY on the bundle — under the step's own
// `*Error` key (the names already present in the on-disk artifacts) and in a
// single `evidenceErrors` list so a degraded run is visible at a glance.
//
// Exactly one thing may still fail the run: `runUnderstand`, the actual device
// call. Its failure is recorded as `probeError` and is a real finding.
export async function optionalEvidence(bundle, errorField, step, fallback = null) {
  try {
    return await step();
  } catch (e) {
    const message = String(e?.message ?? e);
    bundle[errorField] = message;
    if (!Array.isArray(bundle.evidenceErrors)) bundle.evidenceErrors = [];
    bundle.evidenceErrors.push({ step: errorField, error: message });
    return fallback;
  }
}

// Shapes the presentation layer can render when a step degraded. They must
// match the real return shapes (shared/evidence.mjs summarizeResponses,
// shared/logcat.mjs parseNlu) or a degraded render would throw in turn.
const UNAVAILABLE_SUMMARY = Object.freeze({
  frames: 0,
  actions: [],
  answer: "",
  answerChars: 0,
  answerPreview: "",
  answerStatus: "summary-unavailable",
  unavailableAnswer: false,
});

const UNAVAILABLE_SIGNALS = Object.freeze({
  executedTools: [],
  nlu: { entryIntent: null, musicSlots: null, semanticHit: null },
  nativeActions: [],
  providerDeclined: false,
  musicRankingDegraded: [],
});

/**
 * "SILENT" is a claim ABOUT THE DEVICE — that it planned nothing and called
 * nothing. It may only be made when the evidence needed to make it was actually
 * collected. An empty logcat window, a failed parse, or an unreadable response
 * set produces the SAME empty arrays as a genuinely silent turn, so asserting
 * silence from them manufactures a finding out of a measurement failure. That
 * is the identical mistake that turned a broken activity cross-check into a
 * reported "0/10 regression".
 */
export function assessSilence({ probeError, evidenceText, plannedActions, executedTools, degraded }) {
  const silentUnknown = !evidenceText || String(evidenceText).length === 0 || Boolean(degraded);
  return {
    silent:
      (probeError === null || probeError === undefined) &&
      !silentUnknown &&
      (plannedActions?.length ?? 0) === 0 &&
      (executedTools?.length ?? 0) === 0,
    silentUnknown,
  };
}

/** Exact response emitted by the Pin-local credential-free EchoProvider. */
export function isLocalEchoAnswer(answer, utterance) {
  return typeof answer === "string" &&
    typeof utterance === "string" &&
    answer === `Echo: ${utterance}`;
}

// ---- optional screencap (adb pull; NOT exec-out, which drops stdin on Pin) ----
async function captureScreencap(options, destPath, spawn) {
  const devicePath = `/sdcard/PenumbraOS/${PROGRAM}-${randomUUID()}.png`;
  await runAdb(options, ["shell", "mkdir", "-p", "/sdcard/PenumbraOS"], {
    timeoutMs: 5_000, maxStdoutBytes: 256,
  }, "the screencap directory could not be created", spawn).catch(() => {});
  await runAdb(options, ["shell", "screencap", "-p", devicePath], {
    timeoutMs: 10_000, maxStdoutBytes: 256,
  }, "the display frame could not be captured", spawn);
  await runAdb(options, ["pull", devicePath, destPath], {
    timeoutMs: 15_000, maxStdoutBytes: 256,
  }, "the display frame could not be pulled", spawn);
  await runAdb(options, ["shell", "rm", "-f", devicePath], {
    timeoutMs: 5_000, maxStdoutBytes: 256,
  }, "the display frame could not be removed", spawn).catch(() => {});
}

// ---- session bootstrap (shared across all prompts in a run/REPL) ----
async function bootstrapSession(options, token, common, ctx) {
  const { out, err, spawn } = ctx;
  await verifyExplicitDevice(options);
  const sessionStamp = stampNow(new Date());
  const sessionDir = join(TEST_RUNS_DIR, `session-${sessionStamp}-${randomUUID().slice(0, 8)}`);
  await mkdir(sessionDir, { recursive: true });

  // Readiness and the agentic gate are context, not the measurement: neither
  // may abort a session. `verifyExplicitDevice` above stays fatal on purpose —
  // probing the wrong device is worse than not probing at all.
  const session = {};
  const readiness = await optionalEvidence(session, "readinessError", () =>
    collectReadiness(options, token), null);
  const gate = await optionalEvidence(
    session,
    "agenticGateError",
    () => assessAgenticGate(readiness ?? { error: session.readinessError ?? "readiness unavailable" }),
    { known: false, warn: "the agentic gate could not be assessed" },
  );
  await optionalEvidence(session, "sessionWriteError", () =>
    writeJson(join(sessionDir, "session.json"), {
      harness: PROGRAM,
      startedAt: new Date().toISOString(),
      mode: common.dispatch ? "dispatch" : "safe",
      readiness,
      agenticGate: gate,
      evidenceErrors: session.evidenceErrors ?? [],
    }));
  if (!common.json && gate.warn) err(`  WARN: ${gate.warn}\n\n`);
  return { sessionDir, readiness, gate, evidenceErrors: session.evidenceErrors ?? [] };
}

// ---- the per-prompt pipeline ----
async function runPrompt(options, token, utterance, { common, probeOpts, sessionDir, runIndex, ctx }) {
  const { out, spawn } = ctx;
  const marker = newBoundaryMarker();
  const userTurnId = `pinbox-${PROGRAM}-${marker}`;
  const startedAt = Date.now();
  const startStamp = stampNow(new Date(startedAt));
  const runDir = join(sessionDir, `${String(runIndex).padStart(3, "0")}-${startStamp}-${slugify(utterance)}`);
  await mkdir(runDir, { recursive: true });

  const files = {};
  const bundle = {
    harness: `pinbox-${PROGRAM}`,
    utterance,
    userTurnId,
    mode: probeOpts.dispatch ? "dispatch" : "safe",
    startedAt: new Date(startedAt).toISOString(),
    runDir,
  };

  // The boundary marker fences the logcat window. It is optional evidence too:
  // without it the window is merely wider, which `logcatMarkerFound` reports.
  await optionalEvidence(bundle, "boundaryError", () => dropBoundary(options, marker, spawn));

  if (probeOpts.screencap) {
    await optionalEvidence(bundle, "screencapErrorBefore", async () => {
      const dest = join(runDir, "screencap-before.png");
      await captureScreencap(options, dest, spawn);
      files.screencapBefore = dest;
    });
  }

  const activityBefore = await optionalEvidence(bundle, "activityBeforeError", async () => {
    const [prompts, music] = await Promise.all([
      deviceJsonGet(options, token, "/api/activity/prompts?limit=100", { spawn }),
      deviceJsonGet(options, token, "/api/activity/music?limit=100", { spawn }),
    ]);
    const snapshot = { prompts, music };
    await writeJson(join(runDir, "activity.before.json"), snapshot);
    files.activityBefore = join(runDir, "activity.before.json");
    return snapshot;
  });

  const mediaDevice = probeOpts.dispatch ? makeMediaVolumeDevice(options, spawn) : null;
  const mediaSnapshot = probeOpts.dispatch
    ? await optionalEvidence(bundle, "mediaVolumeGuardError", () =>
        captureStableMediaVolumeSnapshot(mediaDevice))
    : null;

  // ---- THE MEASUREMENT. The only step whose failure is a real finding. ----
  let responses = null;
  let probeError = null;
  try {
    responses = await runUnderstand(options, DEVICE_PORT, utterance, {
      timeoutMs: probeOpts.timeoutMs,
      userTurnId,
      excludedTools: [],
      authToken: token,
    });
  } catch (e) {
    probeError = String(e?.message ?? e);
  }

  await optionalEvidence(bundle, "responsesWriteError", async () => {
    await writeJson(join(runDir, "responses.json"), responses);
    files.responses = join(runDir, "responses.json");
  });

  const summary = await optionalEvidence(
    bundle,
    "summarizeError",
    () => summarizeResponses(responses),
    UNAVAILABLE_SUMMARY,
  );
  const measurementError = isLocalEchoAnswer(summary.answer, utterance)
    ? "the Pin-local echo backend answered; remote Cosmos planning was not exercised"
    : null;

  await sleep(SETTLE_MS);

  let dispatchResult = null;
  if (probeOpts.dispatch && summary.actions.length > 0) {
    dispatchResult = await optionalEvidence(bundle, "dispatchError", async () => {
      const result = await dispatchPlannedActions(options, token, summary.actions, mediaDevice, mediaSnapshot, spawn);
      await writeJson(join(runDir, "dispatch.json"), result);
      files.dispatch = join(runDir, "dispatch.json");
      return result;
    });
  }

  const logcat = await optionalEvidence(
    bundle,
    "logcatError",
    async () => {
      const raw = await pullLogcatWindow(options, spawn);
      const sliced = sliceLogcatSince(raw, marker);
      await writeText(join(runDir, "logcat.log"), sliced.text);
      files.logcat = join(runDir, "logcat.log");
      return { text: sliced.text, markerFound: sliced.markerFound };
    },
    { text: "", markerFound: false },
  );

  const serverLog = await optionalEvidence(bundle, "serverLogError", async () => {
    const body = await deviceTextGet(options, token, "/api/logs/server?lines=4000", { spawn });
    const text = body.toString("utf8");
    await writeText(join(runDir, "server.log"), text);
    files.serverLog = join(runDir, "server.log");
    return text;
  });

  const evidenceText = logcat.text || serverLog || "";
  const signals = await optionalEvidence(
    bundle,
    "logParseError",
    () => ({
      executedTools: parseExecutedTools(evidenceText),
      nlu: parseNlu(evidenceText),
      nativeActions: parseNativeActions(evidenceText),
      providerDeclined: detectProviderDecline(evidenceText),
      musicRankingDegraded: parseMusicRankingDegraded(evidenceText),
    }),
    UNAVAILABLE_SIGNALS,
  );
  const { executedTools, nlu, nativeActions, providerDeclined, musicRankingDegraded } = signals;
  const okTools = executedTools.filter((t) => t.ok).map((t) => t.tool);
  const failedTools = executedTools
    .filter((t) => !t.ok)
    .map((t) => (t.reason ? `${t.tool} (${t.reason})` : t.tool));

  const { silent, silentUnknown } = assessSilence({
    probeError,
    evidenceText,
    plannedActions: summary.actions,
    executedTools,
    degraded: Boolean(bundle.summarizeError) || Boolean(bundle.logParseError),
  });

  const activityAfter = await optionalEvidence(bundle, "activityAfterError", async () => {
    const [prompts, music] = await Promise.all([
      deviceJsonGet(options, token, "/api/activity/prompts?limit=100", { spawn }),
      deviceJsonGet(options, token, "/api/activity/music?limit=100", { spawn }),
    ]);
    const snapshot = { prompts, music };
    await writeJson(join(runDir, "activity.after.json"), snapshot);
    files.activityAfter = join(runDir, "activity.after.json");
    return snapshot;
  });

  // The line that used to kill the run. `diffActivity` is total now, and the
  // call is guarded anyway: two independent reasons this cannot be fatal.
  const diff = await optionalEvidence(bundle, "activityDiffError", async () => {
    const computed = diffActivity(activityBefore, activityAfter);
    await writeJson(join(runDir, "diff.json"), computed);
    files.diff = join(runDir, "diff.json");
    return computed;
  });

  if (probeOpts.screencap) {
    await optionalEvidence(bundle, "screencapErrorAfter", async () => {
      const dest = join(runDir, "screencap-after.png");
      await captureScreencap(options, dest, spawn);
      files.screencapAfter = dest;
    });
  }

  const score = probeOpts.score
    ? await optionalEvidence(bundle, "scoreError", () => {
        const testCase = SUITE.find((c) => c.prompt === utterance);
        if (!testCase) return { matched: false, note: "no prompt-suite case matches this utterance" };
        const seen = new Set([...summary.actions, ...okTools]);
        const { missing, forbidden, pass } = evaluateCase(testCase, [...seen]);
        return { id: testCase.id, expect: testCase.expect ?? [], forbid: testCase.forbid ?? [], missing, forbidden, pass };
      })
    : null;

  const endedAt = Date.now();
  Object.assign(bundle, {
    endedAt: new Date(endedAt).toISOString(),
    latencyMs: endedAt - startedAt,
    probeError,
    measurementError,
    responses: {
      frames: summary.frames,
      plannedActions: summary.actions,
      answerChars: summary.answerChars,
      answerPreview: summary.answer.slice(0, MAX_ANSWER_CHARS_STDOUT),
      answerStatus: summary.answerStatus ?? null,
    },
    executedTools,
    okTools,
    failedTools,
    nlu,
    nativeActions,
    providerDeclined,
    musicRankingDegraded,
    silent,
    silentUnknown,
    logcatMarkerFound: logcat.markerFound,
    activityDiff: diff,
    dispatch: dispatchResult,
    mediaVolume: mediaSnapshot
      ? { before: mediaSnapshot, restored: dispatchResult?.mediaVolumeRestored ?? null }
      : null,
    score,
    files,
  });
  if (!Array.isArray(bundle.evidenceErrors)) bundle.evidenceErrors = [];

  // Persisting and rendering are themselves optional: the measurement is
  // already in hand, and a disk error must not discard it.
  await optionalEvidence(bundle, "summaryWriteError", () =>
    writeJson(join(runDir, "summary.json"), bundle));
  await optionalEvidence(bundle, "summaryRenderError", () =>
    writeText(join(runDir, "summary.txt"), renderHumanSummary(bundle)));
  return bundle;
}

async function dispatchPlannedActions(options, token, plannedActions, mediaDevice, mediaSnapshot, spawn) {
  const dispatchable = plannedActions.filter((a) => STOCK_ACTION_DISPATCHABLE.has(a));
  const skipped = plannedActions.filter((a) => !STOCK_ACTION_DISPATCHABLE.has(a));
  const results = [];
  for (const action of dispatchable) {
    try {
      const payload = stockActionPayload(action);
      const resp = await deviceJsonPost(options, token, "/api/dev/stock-action-test", { action, ...payload }, { maxSeconds: 15, spawn });
      results.push({ action, dispatched: true, response: resp });
    } catch (e) {
      results.push({ action, dispatched: false, error: String(e?.message ?? e) });
    }
  }
  let restored = null;
  if (mediaDevice && mediaSnapshot) {
    try {
      restored = await restoreMediaVolumeSnapshot(mediaDevice, mediaSnapshot);
    } catch (e) {
      restored = { error: String(e?.message ?? e) };
    }
  }
  return { dispatched: results, skippedNotEnumMappable: skipped, mediaVolumeRestored: restored };
}

// ---- presentation ----
// Renders a DEGRADED bundle as readily as a complete one. Any field an optional
// step failed to produce is absent, and a renderer that assumed it was present
// would throw — turning a partial result back into a fatal one, which is the
// exact failure this file was repaired to prevent.
const list = (value) => (Array.isArray(value) ? value : []);

export function renderHumanSummary(b) {
  const bundle = b ?? {};
  const responses = bundle.responses ?? {};
  const nlu = bundle.nlu ?? {};
  const lines = [];
  lines.push(`pinbox probe — ${bundle.mode ?? "?"} mode`);
  lines.push(`  utterance : ${bundle.utterance ?? "(unknown)"}`);
  lines.push(`  latency   : ${Number.isFinite(bundle.latencyMs) ? bundle.latencyMs : "unknown"}ms`);
  lines.push(`  run dir   : ${bundle.runDir ?? "(none)"}`);
  if (bundle.probeError) lines.push(`  PROBE ERR : ${bundle.probeError}`);
  if (bundle.measurementError) lines.push(`  WRONG PLANE: ${bundle.measurementError}`);
  lines.push(`  planned   : ${list(responses.plannedActions).join(", ") || "(none)"}`);
  lines.push(`  tools ok  : ${list(bundle.okTools).join(", ") || "(none)"}`);
  if (list(bundle.failedTools).length) lines.push(`  tools fail: ${list(bundle.failedTools).join(", ")}`);
  if (bundle.providerDeclined) {
    lines.push(
      `  provider  : DECLINED (${OPERATIONAL_MARKERS.backend_unavailable.value})`,
    );
  }
  if (bundle.silent) lines.push(`  SILENT    : no actions and no tool calls — model may be unreachable`);
  if (bundle.silentUnknown) {
    lines.push(`  NOTE      : silence NOT assessed — the evidence window was unavailable`);
  }
  if (nlu.entryIntent || nlu.musicSlots || nlu.semanticHit) {
    lines.push(`  nlu       : ${JSON.stringify(nlu)}`);
  }
  if (list(bundle.nativeActions).length) lines.push(`  native    : ${list(bundle.nativeActions).join(", ")}`);
  // The played track is rank one either way; this is the only line that says
  // whether rank one meant "Spotify's ranking" or "our relevance fallback".
  for (const degraded of list(bundle.musicRankingDegraded)) {
    lines.push(`  RANKING   : DEGRADED to relevance search — ${JSON.stringify(degraded)}`);
  }
  if (bundle.logcatMarkerFound === false) lines.push(`  NOTE      : logcat boundary marker not found — window may be incomplete (buffer rotated?)`);
  if (bundle.activityDiff) {
    lines.push(`  activity  : +${bundle.activityDiff.newPromptCount} prompts, +${bundle.activityDiff.newMusicCount} music records`);
    if (bundle.activityDiff.note) lines.push(`  activity  : ${bundle.activityDiff.note}`);
  }
  if (bundle.dispatch) {
    const d = bundle.dispatch;
    lines.push(`  dispatch  : ${list(d.dispatched).filter((r) => r?.dispatched).map((r) => r.action).join(", ") || "(none dispatched)"}`);
    if (list(d.skippedNotEnumMappable).length) lines.push(`  dispatch  : skipped (not enum-mappable): ${list(d.skippedNotEnumMappable).join(", ")}`);
    if (bundle.mediaVolume) lines.push(`  media vol : restored=${bundle.mediaVolume.restored}`);
  }
  if (bundle.score) {
    if (bundle.score.matched === false) lines.push(`  score     : (no matching suite case)`);
    else lines.push(`  score     : ${bundle.score.pass ? "PASS" : "FAIL"} ${bundle.score.id} missing=[${list(bundle.score.missing).join(", ")}] forbidden=[${list(bundle.score.forbidden).join(", ")}]`);
  }
  if (responses.answerPreview) {
    lines.push(`  answer    : ${String(responses.answerPreview).replace(/\s+/g, " ").slice(0, MAX_ANSWER_CHARS_STDOUT)}`);
  }
  // Degraded evidence is stated, never hidden: an empty field with no reason is
  // indistinguishable from a device that produced nothing.
  for (const failure of list(bundle.evidenceErrors)) {
    lines.push(`  DEGRADED  : ${failure?.step} — ${failure?.error}`);
  }
  lines.push(`  files     : ${Object.keys(bundle.files ?? {}).join(", ") || "(none)"}`);
  return lines.join("\n") + "\n";
}

// ---- entry called by the dispatcher ----
export async function run({ common, passthrough, ctx }) {
  const { out, err, spawn } = ctx;
  const { options: probeOpts, error } = parseProbeArgs(passthrough);
  if (error) {
    err(`pinbox probe: ${error}\n`);
    err("usage: pinbox probe --serial SERIAL --expected-pin-serial SERIAL (--prompt TEXT | --repl) [--dispatch] [--score] [--screencap] [--timeout-ms N] [--json]\n");
    return 2;
  }
  if (!common.serial) {
    err("pinbox probe: --serial is required\n");
    return 2;
  }
  if (common.tokenFile !== undefined) {
    process.env.PENUMBRA_PIN_ADMIN_TOKEN_FILE = common.tokenFile;
  }
  let options;
  try {
    options = buildProbeDeviceOptions(common, probeOpts);
  } catch (e) {
    err(`pinbox probe: ${String(e?.message ?? e)}\n`);
    return 2;
  }

  let token;
  try {
    token = await readAdminToken();
  } catch (e) {
    err(`pinbox probe: ${String(e?.message ?? e)}\n`);
    return 1;
  }

  let session;
  try {
    session = await bootstrapSession(options, token, { ...common, dispatch: probeOpts.dispatch }, ctx);
  } catch (e) {
    err(`pinbox probe: ${String(e?.message ?? e)}\n`);
    return 1;
  }

  const runOne = async (utterance, runIndex) => {
    const startedAt = Date.now();
    try {
      const bundle = await runPrompt(options, token, utterance, { common, probeOpts, sessionDir: session.sessionDir, runIndex, ctx });
      if (common.json) out(`${JSON.stringify(bundle)}\n`);
      else out(renderHumanSummary(bundle));
      return bundle.probeError || bundle.measurementError ? 1 : 0;
    } catch (e) {
      // A fatal is now genuinely exceptional — every optional evidence step is
      // guarded, so reaching here means the run could not be set up at all.
      // It still carries `latencyMs`: the reader that reported `undefinedms`
      // did so because this record silently lacked the field it prints.
      const message = String(e instanceof ProbeError || e?.name === "ProbeError" ? e.message : e?.message ?? e);
      if (common.json) {
        out(`${JSON.stringify({
          harness: `pinbox-${PROGRAM}`,
          utterance,
          fatal: message,
          latencyMs: Date.now() - startedAt,
          runDir: session.sessionDir,
        })}\n`);
      } else {
        err(`pinbox probe — FATAL on "${utterance}": ${message}\n`);
      }
      return 1;
    }
  };

  if (probeOpts.repl) {
    const rl = createInterface({ input: process.stdin, output: common.json ? undefined : process.stderr });
    if (!common.json) out("type an utterance and press enter (empty line or Ctrl-D to quit):\n");
    let runIndex = 0;
    while (true) {
      let line;
      try {
        line = await rl.question(common.json ? "" : "> ");
      } catch {
        break;
      }
      if (line === null) break;
      line = line.trim();
      if (line === "") {
        if (!common.json) out("(empty line — quitting)\n");
        break;
      }
      runIndex += 1;
      await runOne(line, runIndex);
    }
    await rl.close();
    return 0;
  }

  let code = 0;
  for (let i = 0; i < probeOpts.prompts.length; i += 1) {
    const c = await runOne(probeOpts.prompts[i], i + 1);
    if (c !== 0) code = c;
  }
  return code;
}
