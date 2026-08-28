// Unit tests for the pinbox package. No device required.
// Covers: dispatcher flag translation (spawn-mocked), pure arg helpers,
// in-process readiness/probe arg parsing, the logcat + evidence parsers.
// Run: node --test platform/deploy/acceptance/pin/pinbox.test.mjs

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dispatch, resolveCommand, splitArgs, buildNativeArgs, COMMANDS } from "./pinbox/dispatch.mjs";
import { OPERATIONAL_MARKERS } from "./tier-a-symbols.mjs";
import {
  parseExecutedTools,
  parseChatTurnSignals,
  parseNlu,
  parseNativeActions,
  detectProviderDecline,
  parseMusicRankingDegraded,
  sliceLogcatSince,
  PARSED_LOG_MARKERS,
  PROBE_BOUNDARY_TAG,
} from "./pinbox/shared/logcat.mjs";
import {
  summarizeResponses,
  assessAgenticGate,
  diffActivity,
  normalizeActivityList,
  stockActionPayload,
  STOCK_ACTION_DISPATCHABLE,
  MAX_ANSWER_CHARS_STDOUT,
} from "./pinbox/shared/evidence.mjs";
import { assertAllowlistedPath, PROBE_API_PATHS } from "./pinbox/shared/admin-http.mjs";
import { extractAnswer } from "./prompt-suite.mjs";
import {
  buildProbeDeviceOptions,
  parseProbeArgs,
  renderHumanSummary,
  optionalEvidence,
  assessSilence,
} from "./pinbox/commands/probe.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../pin");

// ---- a fake spawn that records the translated argv and exits 0 ----
function makeFakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdin = { destroy() {}, end() {} };
    child.stdout = { destroy() {}, resume() {} };
    child.stderr = { destroy() {}, resume() {} };
    child.kill = () => {};
    setImmediate(() => child.emit("close", 0));
    return child;
  };
  return { spawn, calls };
}

function sinks() {
  let out = "";
  let err = "";
  return {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    getOut: () => out,
    getErr: () => err,
  };
}

function argv(...a) {
  return ["node", "pinbox.mjs", ...a];
}

// ─── dispatcher: flag translation (shell-out commands) ──────────────────────
// probe is in-process, so these translation tests use `eval` (shell-out,
// serial:--serial, adb:--adb-path, json:--json) to exercise the spawn path.
test("eval: --adb is translated to --adb-path; --prompt passes through", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  const code = await dispatch(argv("eval", "--serial", "S", "--adb", "A", "--prompt", "hi"), { ...s, spawn });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[0], /prompt-eval\.mjs$/);
  const a = calls[0].args.join(" ");
  assert.match(a, /--serial S /);
  assert.match(a, /--adb-path A /);
  assert.match(a, /--prompt hi/);
  assert.equal(a.includes("--adb A "), false);
});

test("physical: expected device, release metadata, provider, and network transport pass through unchanged", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv(
    "physical",
    "--serial", "S",
    "--adb", "A",
    "--expected-pin-serial", "S",
    "--release-manifest", "/tmp/release.json",
    "--release-receipts", "/tmp/receipts.json",
    "--case", "ranked_music",
    "--provider", "youtube_music",
    "--expected-transport", "wifi",
  ), { ...s, spawn });
  const a = calls[0].args.join(" ");
  assert.match(a, /--serial S /);
  assert.match(a, /--adb A /);
  assert.match(a, /--expected-pin-serial S /);
  assert.match(a, /--release-manifest \/tmp\/release\.json/);
  assert.match(a, /--release-receipts \/tmp\/receipts\.json/);
  assert.match(a, /--case ranked_music/);
  assert.match(a, /--provider youtube_music/);
  assert.match(a, /--expected-transport wifi/);
});

test("smoke: --json is forwarded", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("smoke", "--serial", "S", "--json", "--self-check"), { ...s, spawn });
  const a = calls[0].args.join(" ");
  assert.match(a, /--json/);
  assert.match(a, /--self-check/);
  assert.equal(s.getErr(), "");
});

test("bridge: --json is dropped with a warning (tool does not take it)", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("bridge", "--serial", "S", "--json", "--listen-port", "8080"), { ...s, spawn });
  const a = calls[0].args.join(" ");
  assert.equal(a.includes("--json"), false);
  assert.match(s.getErr(), /--json ignored/);
  assert.match(a, /--listen-port 8080/);
});

test("cmu: --serial dropped with warning; --pin-serial passes through", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("cmu", "--serial", "S", "--pin-serial", "P", "--pixel-serial", "X"), { ...s, spawn });
  const a = calls[0].args.join(" ");
  assert.equal(a.includes("--serial"), false);
  assert.match(s.getErr(), /--serial ignored/);
  assert.match(a, /--pin-serial P/);
  assert.match(a, /--pixel-serial X/);
});

test("-- forces passthrough (a colliding flag is preserved untouched)", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("eval", "--serial", "S", "--", "--json"), { ...s, spawn });
  const a = calls[0].args.join(" ");
  assert.match(a, /--serial S /);
  assert.match(a, /--json$/);
});

test("--token-file reaches shell-out tools through env and never argv", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("eval", "--serial", "S", "--token-file", "/tmp/t", "--prompt", "hi"), { ...s, spawn });
  assert.equal(calls[0].opts.env.PENUMBRA_PIN_ADMIN_TOKEN_FILE, "/tmp/t");
  assert.equal(calls[0].args.join(" ").includes("--token-file"), false);
});

test("--verbose echoes the spawn line to stderr", async () => {
  const { spawn } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("eval", "--serial", "S", "--verbose", "--prompt", "hi"), { ...s, spawn });
  assert.match(s.getErr(), /^\+ node .*prompt-eval\.mjs /);
});

test("unknown command → exit 2 + help hint", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  const code = await dispatch(argv("bogus"), { ...s, spawn });
  assert.equal(code, 2);
  assert.match(s.getErr(), /unknown command "bogus"/);
  assert.match(s.getErr(), /pinbox help/);
  assert.equal(calls.length, 0);
});

test("no args → help, exit 0", async () => {
  const s = sinks();
  const code = await dispatch(argv(), { ...s, spawn: makeFakeSpawn().spawn });
  assert.equal(code, 0);
  assert.match(s.getOut(), /unified Penumbra test CLI/);
  assert.match(s.getOut(), /probe/);
});

test("list --json → machine-readable registry", async () => {
  const s = sinks();
  const code = await dispatch(argv("list", "--json"), { ...s, spawn: makeFakeSpawn().spawn });
  assert.equal(code, 0);
  const rows = JSON.parse(s.getOut());
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, COMMANDS.length);
  assert.ok(rows.some((r) => r.name === "probe" && r.inProcess === true));
  assert.equal(rows.some((r) => r.category === "Deploy"), false);
});

test("version → exit 0", async () => {
  const s = sinks();
  const code = await dispatch(argv("version"), { ...s, spawn: makeFakeSpawn().spawn });
  assert.equal(code, 0);
  assert.match(s.getOut(), /pinbox v/);
});

// ─── pure arg helpers ───────────────────────────────────────────────────────
test("splitArgs: consumes common, passes the rest through", () => {
  const { common, passthrough } = splitArgs(["--serial", "S", "--adb", "A", "--json", "--case", "x", "--run"]);
  assert.equal(common.serial, "S");
  assert.equal(common.adb, "A");
  assert.equal(common.json, true);
  assert.deepEqual(passthrough, ["--case", "x", "--run"]);
});

test("splitArgs: --adb-path is an alias for --adb", () => {
  const { common } = splitArgs(["--adb-path", "/x/adb"]);
  assert.equal(common.adb, "/x/adb");
});

test("splitArgs: -- forces the rest to passthrough", () => {
  const { common, passthrough } = splitArgs(["--serial", "S", "--", "--json", "--adb", "A"]);
  assert.equal(common.serial, "S");
  assert.equal(common.json, false);
  assert.deepEqual(passthrough, ["--json", "--adb", "A"]);
});

test("buildNativeArgs: emits native serial/adb/json and drops unsupported with warning", () => {
  const spec = resolveCommand("bridge");
  const { args, warnings } = buildNativeArgs(spec, { serial: "S", adb: undefined, json: true }, ["--listen-port", "8080"]);
  assert.deepEqual(args, ["--serial", "S", "--listen-port", "8080"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /--json ignored/);
});

test("resolveCommand: unknown → null", () => {
  assert.equal(resolveCommand("nope"), null);
  assert.ok(resolveCommand("probe"));
});

test("COMMANDS: every shell-out command has a file; in-process has none", () => {
  for (const c of COMMANDS) {
    if (c.inProcess) assert.equal(c.file, null);
    else assert.equal(typeof c.file, "string");
  }
});

// ─── in-process readiness arg handling ─────────────────────────────────────
test("readiness: no --serial → exit 2", async () => {
  const s = sinks();
  const code = await dispatch(argv("readiness"), { ...s, spawn: makeFakeSpawn().spawn });
  assert.equal(code, 2);
  assert.match(s.getErr(), /--serial is required/);
});

test("readiness: --serial FOO (no device/token) → in-process path runs, exits 1", async () => {
  const s = sinks();
  const code = await dispatch(argv("readiness", "--serial", "FOO"), { ...s, spawn: makeFakeSpawn().spawn });
  // The in-process command runs readAdminToken + verifyExplicitDevice; with no
  // device (and possibly no readable token file) it must surface a readiness-
  // prefixed error and exit non-zero — proving the in-process path executed.
  assert.equal(code, 1);
  assert.match(s.getErr(), /^pinbox readiness:/);
});

// ─── in-process probe arg parsing ──────────────────────────────────────────
test("parseProbeArgs: --prompt + --serial-free (serial is pinbox-common)", () => {
  const { options, error } = parseProbeArgs(["--prompt", "hi", "--score"]);
  assert.equal(error, undefined);
  assert.deepEqual(options.prompts, ["hi"]);
  assert.equal(options.score, true);
  assert.equal(options.repl, false);
});

test("parseProbeArgs: --repl and --prompt are mutually exclusive", () => {
  const { error } = parseProbeArgs(["--repl", "--prompt", "hi"]);
  assert.match(error, /mutually exclusive/);
});

test("parseProbeArgs: needs --prompt or --repl", () => {
  const { error } = parseProbeArgs([]);
  assert.match(error, /either --prompt or --repl/);
});

test("parseProbeArgs: a trailing --prompt with no value is refused, not run as undefined", () => {
  // Otherwise `undefined` is pushed, passes the "--prompt or --repl" check, and
  // only fails later inside slugify() as an opaque FATAL.
  const { options, error } = parseProbeArgs(["--prompt"]);
  assert.equal(options, undefined);
  assert.match(error, /--prompt requires a value/);
  // A real value after other flags still parses.
  assert.deepEqual(parseProbeArgs(["--score", "--prompt", "hi"]).options.prompts, ["hi"]);
});

test("probe passes the operator-supplied expected serial to the device guard", () => {
  const probeOpts = parseProbeArgs([
    "--prompt", "What is 2 plus 2?",
    "--expected-pin-serial", "device-123",
  ]).options;
  assert.deepEqual(
    buildProbeDeviceOptions(
      { serial: "device-123", adb: "/opt/adb" },
      probeOpts,
      {},
    ),
    {
      serial: "device-123",
      expectedPinSerial: "device-123",
      adbPath: "/opt/adb",
    },
  );
});

test("renderHumanSummary: surfaces the core fields", () => {
  const text = renderHumanSummary({
    mode: "safe",
    utterance: "how tall is the Eiffel Tower",
    latencyMs: 4200,
    runDir: "/tmp/test-runs/x",
    probeError: null,
    responses: { plannedActions: ["knowledge_lookup"], answerPreview: "330 metres", answerChars: 10 },
    okTools: ["knowledge_lookup"],
    failedTools: [],
    nlu: { entryIntent: { intent: "knowledge" }, musicSlots: null, semanticHit: null },
    nativeActions: [],
    providerDeclined: false,
    silent: false,
    logcatMarkerFound: true,
    activityDiff: { newPromptCount: 1, newMusicCount: 0 },
    dispatch: null,
    mediaVolume: null,
    score: null,
    files: { logcat: "/tmp/x/logcat.log" },
  });
  assert.match(text, /how tall is the Eiffel Tower/);
  assert.match(text, /knowledge_lookup/);
  assert.match(text, /330 metres/);
});

// ─── shared logcat + evidence parsers ───────────────────────────────────────
// Fully synthetic log lines exercise the production formatter's public shape:
// compact message first, then fields. IDs and timestamps are deliberately
// artificial and do not come from a device capture.
function fixtureLogcat(marker) {
  return [
    `1700000000.100 I PenumbraServer: synthetic line before the boundary`,
    `1700000000.200 I ${PROBE_BOUNDARY_TAG}: ${marker}`,
    `1700000001.010 I PenumbraServer: <<< nlu entry intent intent=knowledge autocomplete=false`,
    `1700000001.020 I PenumbraServer: <<< nlu music slots has_track=false has_artist=false has_album=false`,
    `1700000002.100 I PenumbraServer: <<< hermes tool executed correlation=synthetic-read-1 tool=knowledge_lookup ok=true`,
    `1700000003.200 I PenumbraServer: <<< hermes tool executed correlation=synthetic-read-2 tool=web_search ok=false reason="backend_unavailable"`,
    // A synthetic CamelCase name pins the parser regression: `[a-z_]+` would
    // hide an unknown tool and make "called an unknown tool" look like no call.
    `1700000003.400 I PenumbraServer: <<< hermes tool executed correlation=synthetic-read-3 tool=AmIOnline ok=false reason="unknown_tool"`,
    // A mutation the model selected and the gates allowed. Must never be
    // counted as an executed tool.
    `1700000003.600 I PenumbraServer: <<< hermes mutation tool=decrement_volume action="DecrementVolume"`,
    // A mutation a grounding gate REFUSED. Formerly invisible silence.
    `1700000003.700 I PenumbraServer: <<< hermes mutation rejected: not grounded in this turn tool=send_message reason='send_message' argument 'To' must be what the user said, not a paraphrase`,
    // Proof a tool ran earlier in this turn — not proof it ran again now.
    `1700000003.800 I PenumbraServer: <<< hermes replaying identical observation from this turn correlation=synthetic-replay-1 tool=music_catalog_search ok=true`,
    `1700000004.100 I PenumbraHook: Observed native action for physical verification | action=PlayMusic`,
  ].join("\n");
}

test("sliceLogcatSince: keeps from boundary onward", () => {
  const marker = "probe-deadbeef-0000-4000-8000-000000000000";
  const { text, markerFound } = sliceLogcatSince(fixtureLogcat(marker), marker);
  assert.equal(markerFound, true);
  assert.ok(!text.includes("BEFORE the boundary"));
  assert.ok(text.includes("<<< hermes tool executed"));
});

test("parseExecutedTools: ok + failed-with-reason", () => {
  const marker = "probe-aaaaaaaa-0000-4000-8000-000000000000";
  const { text } = sliceLogcatSince(fixtureLogcat(marker), marker);
  const tools = parseExecutedTools(text);
  assert.equal(tools.length, 3);
  assert.equal(tools.find((t) => t.tool === "knowledge_lookup").ok, true);
  const fail = tools.find((t) => t.tool === "web_search");
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, "backend_unavailable");
});

test("a hallucinated CamelCase tool is a FAILED tool, not an absent one", () => {
  const marker = "probe-cccccccc-0000-4000-8000-000000000000";
  const { text } = sliceLogcatSince(fixtureLogcat(marker), marker);
  // What probe itself computes (commands/probe.mjs:255-258).
  const executed = parseExecutedTools(text);
  const failedTools = executed.filter((t) => !t.ok).map((t) => `${t.tool} (${t.reason})`);
  assert.ok(
    failedTools.includes("AmIOnline (unknown_tool)"),
    "an unknown_tool failure must name the tool the model invented",
  );
  // And a nonexistent tool is still not a success.
  assert.equal(executed.filter((t) => t.ok).map((t) => t.tool).includes("AmIOnline"), false);
});

test("mutations are reported SEPARATELY and never as executed tools", () => {
  const marker = "probe-dddddddd-0000-4000-8000-000000000000";
  const { text } = sliceLogcatSince(fixtureLogcat(marker), marker);
  const signals = parseChatTurnSignals(text);

  assert.deepEqual(signals.mutations, [{ tool: "decrement_volume", action: "DecrementVolume" }]);
  // THE load-bearing distinction: a mutation the planner performed and a
  // mutation a gate refused must not both score as "the tool ran".
  const okTools = signals.executed.filter((t) => t.ok).map((t) => t.tool);
  assert.equal(okTools.includes("decrement_volume"), false);
  assert.equal(okTools.includes("send_message"), false);
  assert.equal(signals.executed.some((t) => t.tool === "decrement_volume"), false);

  assert.equal(signals.mutationsRejected.length, 1);
  assert.equal(signals.mutationsRejected[0].tool, "send_message");
  assert.match(signals.mutationsRejected[0].reason, /must be what the user said/);
  // The rejection line begins with the same prefix as an allowed mutation; the
  // lookahead must keep it out of `mutations`.
  assert.equal(signals.mutations.some((m) => m.tool === "send_message"), false);

  assert.deepEqual(signals.replayed, [{ tool: "music_catalog_search", ok: true }]);
  assert.equal(okTools.includes("music_catalog_search"), false);
});

test("parseChatTurnSignals: null-safe and empty-safe", () => {
  for (const input of [null, undefined, "", 42]) {
    assert.deepEqual(parseChatTurnSignals(input), {
      executed: [], mutations: [], mutationsRejected: [], replayed: [],
    });
  }
});

// The played track is always rank one, so nothing downstream distinguishes
// "Spotify ranked this first" from "our relevance fallback ranked this first".
// This line is the whole difference — and it must contain a bounded shape only,
// never the artist the user asked for.
test("parseMusicRankingDegraded reads the degraded-ranking marker", () => {
  const marker = OPERATIONAL_MARKERS.music_ranking_degraded.value;
  const text = [
    "01-01 00:00:00.000  1  1 I server: unrelated line",
    `01-01 00:00:01.000  1  1 W server: ${marker} reason=backoff_window_open track_count=10 popularity_order=mixed`,
    `01-01 00:00:02.000  1  1 W server: ${marker} reason=top_tracks_unavailable track_count=3 popularity_order=unknown`,
  ].join("\n");

  assert.deepEqual(parseMusicRankingDegraded(text), [
    { reason: "backoff_window_open", track_count: "10", popularity_order: "mixed" },
    { reason: "top_tracks_unavailable", track_count: "3", popularity_order: "unknown" },
  ]);
  // A healthy turn must not manufacture a degraded finding.
  assert.deepEqual(parseMusicRankingDegraded("01-01 00:00:00.000 I server: nothing"), []);
  assert.deepEqual(parseMusicRankingDegraded(null), []);
});

test("parseNlu + parseNativeActions + detectProviderDecline", () => {
  const marker = "probe-bbbbbbbb-0000-4000-8000-000000000000";
  const { text } = sliceLogcatSince(fixtureLogcat(marker), marker);
  const nlu = parseNlu(text);
  assert.deepEqual(nlu.entryIntent, { intent: "knowledge", autocomplete: "false" });
  assert.deepEqual(parseNativeActions(text), ["PlayMusic"]);
  assert.equal(detectProviderDecline(text), true);
});

// ─── summarizeResponses against the implemented decoded frame shape ─────────
// These fixtures are synthetic. They preserve the field layout consumed by
// summarizeResponses without embedding an operator transcript or device ID.
function syntheticRespondFrame(text, sequence = 1) {
  return {
    kind: "action",
    isFinal: false,
    user: 2,
    hasIdentifier: true,
    hasParentIdentifier: true,
    identifier: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    parentIdentifier: "pinbox-probe-synthetic-parent",
    thought: "Return the synthetic test response",
    action: "Respond",
    input: JSON.stringify({ Response: text }),
    devicePayloadBytes: 0,
    source: 1,
  };
}

// An action-only turn deliberately carries no spoken response.
const SYNTHETIC_PLAY_MUSIC_FRAME = {
  kind: "action",
  isFinal: false,
  user: 2,
  hasIdentifier: true,
  hasParentIdentifier: true,
  identifier: "00000000-0000-4000-8000-000000000100",
  parentIdentifier: "pinbox-probe-synthetic-parent",
  thought: "Dispatch the synthetic media action",
  action: "PlayMusic",
  input: JSON.stringify({ Artist: "Example Artist" }),
  devicePayloadBytes: 0,
  source: 1,
};

test("summarizeResponses: dedupes actions and reads the response field", () => {
  const spoken = "The synthetic provider is unavailable. Please try again.";
  const s = summarizeResponses([SYNTHETIC_PLAY_MUSIC_FRAME, syntheticRespondFrame(spoken)]);
  assert.deepEqual(s.actions, ["PlayMusic", "Respond"]);
  assert.equal(s.frames, 2);
  // The old `answer ?? text ?? speech` read returned "" for this decoded shape,
  // so the probe could report `answerChars: 0` for a spoken response.
  assert.equal(s.answer, spoken);
  assert.equal(s.answerChars, spoken.length);
  assert.ok(s.answerChars > 0);
  assert.equal(s.answerStatus, "ok");
  // …and this particular sentence is a FAILURE, not an answer.
  assert.equal(s.unavailableAnswer, true);
});

test("summarizeResponses: LAST Respond wins, not the longest", () => {
  const interim = "Let me look that up for you — one moment while I check the details.";
  const terminal = "Done.";
  const s = summarizeResponses([syntheticRespondFrame(interim, 1), syntheticRespondFrame(terminal, 2)]);
  assert.equal(s.answer, terminal);
  assert.ok(terminal.length < interim.length, "the terminal answer is the shorter string");
  assert.equal(s.unavailableAnswer, false);
});

test("summarizeResponses: a device-action turn is 'no-respond-frame', not silence", () => {
  const s = summarizeResponses([SYNTHETIC_PLAY_MUSIC_FRAME]);
  assert.deepEqual(s.actions, ["PlayMusic"]);
  assert.equal(s.answer, "");
  assert.equal(s.answerStatus, "no-respond-frame");
  // The action's own prose must never be scored as the spoken answer.
  assert.equal(s.answer.includes("Example Artist"), false);
  // A probe that threw is a DIFFERENT state from a legitimately spoken nothing.
  assert.equal(summarizeResponses(null).answerStatus, "no-frames");
  assert.equal(summarizeResponses(null).frames, 0);
});

test("summarizeResponses: the shareable preview is bounded and carries no prose flags", () => {
  const long = "x".repeat(MAX_ANSWER_CHARS_STDOUT * 3);
  const s = summarizeResponses([syntheticRespondFrame(long)]);
  assert.equal(s.answerPreview.length, MAX_ANSWER_CHARS_STDOUT);
  assert.equal(s.answerChars, long.length, "the true length is still reported");
  assert.equal(typeof s.unavailableAnswer, "boolean");
  assert.equal(typeof s.answerStatus, "string");
});

test("summarizeResponses agrees with extractAnswer on synthetic decoded frames", () => {
  const frames = [
    SYNTHETIC_PLAY_MUSIC_FRAME,
    syntheticRespondFrame("Synthetic terminal answer.", 2),
  ];
  const summary = summarizeResponses(frames);
  const truth = extractAnswer(frames);
  assert.equal(summary.answer, truth.text);
  assert.equal(summary.answerStatus, truth.status);
  assert.ok(summary.answerChars > 0, "the fixture must keep this check non-vacuous");
  assert.equal(Object.hasOwn(frames[0], "answer"), false);
});

test("assessAgenticGate: warns when provider settings remain on the Pin", () => {
  const gate = assessAgenticGate({ settings: { llm: { tools: { enabled: false }, provider: "echo" } } });
  assert.equal(gate.known, true);
  assert.equal(gate.toolsEnabled, false);
  assert.match(gate.warn, /provider settings owned by Cosmos/);
  const ok = assessAgenticGate({ settings: {} });
  assert.equal(ok.toolsEnabled, true);
  assert.equal(ok.warn, null);
});

test("diffActivity: reports only new records; null-safe", () => {
  const before = { prompts: { records: [{ id: "p1" }] }, music: { records: [{ id: "m1" }] } };
  const after = { prompts: { records: [{ id: "p1" }, { id: "p2" }] }, music: { records: [{ id: "m1" }, { id: "m2" }] } };
  const diff = diffActivity(before, after);
  assert.equal(diff.newPromptCount, 1);
  assert.equal(diff.newMusicCount, 1);
  assert.equal(diffActivity(null, null), null);
});

// ─── the activity cross-check must never be able to fail a probe ────────────
//
// THE BUG THIS BLOCK PINS. `diffActivity` read
// `(before.prompts?.records ?? before.prompts ?? []).map(...)`, which handles
// `{records:[…]}` and a bare array. The device sends NEITHER: the handlers
// serialise `ActivityPage { items, next_before }` (runtime/core/src/api/activity.rs
// :69-73, :216-227, :244-254). So `?? before.prompts` yielded a plain object
// and `.map` threw
//   `((intermediate value) ?? before.prompts ?? []).map is not a function`
// out of `runPrompt` — from a SUPPORTING cross-check, after the model had
// already answered. Every probe returned `{fatal: …}` with no latency and no
// answer, and the run was read as a catastrophic 0/10 device regression.
//
// It was dormant until the allowlist repair: while `/api/…?limit=100` was being
// refused, the fetch threw, `activityBefore` stayed null, and `diffActivity`
// returned from its null guard before reaching the bad line.

// Payloads that must NOT produce a diff but must NOT throw either. These are
// synthetic representatives of error, renamed, and truncated envelopes.
const UNREADABLE_ACTIVITY_PAYLOADS = [
  ["error object", { error: "refusing a non-allowlisted endpoint: /api/activity/prompts" }],
  ["non-200 error body", { status: 502, message: "Bad Gateway" }],
  ["missing key", {}],
  ["renamed envelope", { entries: [{ id: 1 }] }],
  ["non-JSON string body", "<html>502 Bad Gateway</html>"],
  ["number", 42],
  ["boolean", true],
  ["nested non-array", { items: { id: 1 } }],
];

test("REGRESSION: the implemented {items:[…]} payload diffs instead of throwing", () => {
  // Synthetic records exercise the public ActivityPage envelope without
  // retaining prompts, titles, timestamps, or IDs from an operator's Pin.
  const before = {
    prompts: { items: [{ id: 1, run_id: "synthetic-run-1", prompt: "first synthetic prompt", is_vision: false, created_at: "2000-01-01T00:00:00Z" }] },
    music: { items: [{ id: 10, track_id: "synthetic-track-1", title: "Example Track", artists: ["Example Artist"], status: "played", started_at: "2000-01-01T00:00:00Z" }] },
  };
  const after = {
    prompts: {
      items: [
        { id: 1, run_id: "synthetic-run-1", prompt: "first synthetic prompt", is_vision: false, created_at: "2000-01-01T00:00:00Z" },
        { id: 2, run_id: "synthetic-run-2", prompt: "second synthetic prompt", is_vision: false, created_at: "2000-01-01T00:01:00Z" },
      ],
      next_before: "2",
    },
    music: { items: [{ id: 10, track_id: "synthetic-track-1", title: "Example Track", artists: ["Example Artist"], status: "played", started_at: "2000-01-01T00:00:00Z" }] },
  };

  // FALSIFIABILITY: prove this fixture really is the trap. The old expression
  // produced a non-array here, which is precisely why `.map` blew up. If a
  // future refactor reintroduces that read, this assertion documents why.
  assert.equal(Array.isArray(before.prompts?.records ?? before.prompts ?? []), false);

  const diff = diffActivity(before, after);
  assert.equal(diff.newPromptCount, 1, "the {items:[…]} payload must produce a diff, not an empty one");
  assert.equal(diff.newPrompts[0].id, 2);
  assert.equal(diff.newMusicCount, 0);
  assert.equal(diff.shapes.beforePrompts, "items");
  assert.equal(diff.shapes.afterPrompts, "items");
  assert.deepEqual(diff.unreadable, []);
  assert.equal(diff.note, null);
});

test("diffActivity tolerates every other list envelope the API might return", () => {
  // {prompts:[…]} — the shape the endpoint is named for.
  const named = diffActivity(
    { prompts: { prompts: [{ id: 1 }] }, music: { music: [] } },
    { prompts: { prompts: [{ id: 1 }, { id: 2 }] }, music: { music: [] } },
  );
  assert.equal(named.newPromptCount, 1);
  assert.equal(named.shapes.beforePrompts, "prompts");

  // A bare array with no envelope at all.
  const bare = diffActivity(
    { prompts: [{ id: 1 }], music: [] },
    { prompts: [{ id: 1 }, { id: 2 }], music: [{ id: 9 }] },
  );
  assert.equal(bare.newPromptCount, 1);
  assert.equal(bare.newMusicCount, 1);
  assert.equal(bare.shapes.beforePrompts, "array");
});

for (const [label, payload] of UNREADABLE_ACTIVITY_PAYLOADS) {
  test(`diffActivity: a ${label} payload yields an EMPTY diff and never throws`, () => {
    let diff;
    assert.doesNotThrow(() => {
      diff = diffActivity({ prompts: payload, music: payload }, { prompts: payload, music: payload });
    }, `a ${label} payload must not throw — it is supporting evidence`);
    assert.equal(diff.newPromptCount, 0);
    assert.equal(diff.newMusicCount, 0);
    assert.deepEqual(diff.newPrompts, []);
    assert.deepEqual(diff.newMusic, []);
  });
}

test("an unreadable payload is REPORTED, not silently counted as zero", () => {
  // A cross-check that returns 0 forever without saying why is the same class
  // of defect as the crash: it stops being evidence while still looking like it.
  const diff = diffActivity(
    { prompts: { error: "boom" }, music: { items: [] } },
    { prompts: { error: "boom" }, music: { items: [] } },
  );
  assert.equal(diff.newPromptCount, 0);
  assert.deepEqual(diff.unreadable, ["beforePrompts", "afterPrompts"]);
  assert.match(diff.note, /not evidence of absence/);
  // …and the readable half is still marked readable, so the report is specific.
  assert.equal(diff.shapes.beforeMusic, "items");
});

test("diffActivity survives a throwing getter and degrades that field only", () => {
  const hostile = {
    get prompts() { throw new Error("exploding getter"); },
    music: { items: [] },
  };
  let diff;
  assert.doesNotThrow(() => { diff = diffActivity(hostile, hostile); });
  assert.equal(diff.newPromptCount, 0);
  assert.match(diff.error, /exploding getter/);
  assert.match(diff.note, /not evidence of absence/);
});

test("diffActivity: id 0 is a real id, and an id-less record counts as new", () => {
  // `.filter(Boolean)` dropped id 0, so that record was absent from the before
  // set and would be re-reported as new on every diff, forever.
  const zero = diffActivity(
    { prompts: { items: [{ id: 0 }] }, music: { items: [] } },
    { prompts: { items: [{ id: 0 }] }, music: { items: [] } },
  );
  assert.equal(zero.newPromptCount, 0, "id 0 must not be dropped from the before set");

  // A record with no usable id cannot be proven old — over-report rather than
  // silently swallow a dispatch.
  const idless = diffActivity(
    { prompts: { items: [] }, music: { items: [] } },
    { prompts: { items: [{ prompt: "no id here" }] }, music: { items: [] } },
  );
  assert.equal(idless.newPromptCount, 1);

  // Identity is key-scoped, so a prompt id and a track id cannot collide.
  const scoped = diffActivity(
    { prompts: { items: [{ id: 1 }] }, music: { items: [{ track_id: 1 }] } },
    { prompts: { items: [{ id: 1 }] }, music: { items: [{ track_id: 1 }] } },
  );
  assert.equal(scoped.newMusicCount, 0);
});

test("normalizeActivityList is total: no input shape throws", () => {
  const cases = [
    [[1, 2], "array"],
    [{ items: [1] }, "items"],
    [{ records: [1] }, "records"],
    [{ prompts: [1] }, "prompts"],
    [{ music: [1] }, "music"],
    [null, "absent"],
    [undefined, "absent"],
    [{ nope: 1 }, "unrecognized"],
    ["text", "unrecognized"],
    [7, "unrecognized"],
    [true, "unrecognized"],
    [{ items: "not an array" }, "unrecognized"],
  ];
  for (const [input, expectedShape] of cases) {
    const result = normalizeActivityList(input);
    assert.ok(Array.isArray(result.list), `list must be an array for ${JSON.stringify(input)}`);
    assert.equal(result.shape, expectedShape, JSON.stringify(input));
  }
  // The shape label must actually discriminate, or reporting it proves nothing.
  assert.notEqual(normalizeActivityList({ items: [] }).shape, normalizeActivityList({}).shape);
});

// ─── optional evidence must degrade ONE field, never the run ────────────────
test("optionalEvidence: a throwing step cannot make the probe fatal", async () => {
  const bundle = {};
  const value = await optionalEvidence(bundle, "activityDiffError", () => {
    throw new TypeError("((intermediate value) ?? before.prompts ?? []).map is not a function");
  }, "FALLBACK");
  assert.equal(value, "FALLBACK", "the step degrades to its fallback");
  assert.match(bundle.activityDiffError, /is not a function/);
  assert.deepEqual(bundle.evidenceErrors.map((f) => f.step), ["activityDiffError"]);
  assert.match(bundle.evidenceErrors[0].error, /is not a function/);
});

test("optionalEvidence: catches async rejections as well as sync throws", async () => {
  const bundle = {};
  const rejected = await optionalEvidence(bundle, "serverLogError", async () => {
    throw new Error("adb: device offline");
  }, null);
  assert.equal(rejected, null);
  assert.match(bundle.serverLogError, /device offline/);

  const sync = await optionalEvidence(bundle, "logParseError", () => { throw new Error("bad regex"); }, []);
  assert.deepEqual(sync, []);
  assert.match(bundle.logParseError, /bad regex/);
  assert.equal(bundle.evidenceErrors.length, 2, "every degraded step is listed, not just the last");
});

test("optionalEvidence is not a blanket swallow: success passes through untouched", async () => {
  // Without this, the guard above would pass even if the helper always returned
  // the fallback and discarded every real result.
  const bundle = {};
  assert.equal(await optionalEvidence(bundle, "x", () => "real value", "FALLBACK"), "real value");
  assert.equal(await optionalEvidence(bundle, "y", async () => 7, 0), 7);
  assert.equal(bundle.x, undefined);
  assert.equal(bundle.evidenceErrors, undefined, "a clean run records no degradation");
});

test("a degraded bundle still renders — the reporter cannot re-fatalise it", () => {
  // Everything an optional step could have failed to produce is missing here.
  // The old renderer read `b.responses.plannedActions.length`, `b.okTools`,
  // `b.nlu.entryIntent` and `b.files` unguarded, so rendering a partial result
  // threw and turned degraded evidence back into a fatal.
  let text;
  assert.doesNotThrow(() => {
    text = renderHumanSummary({
      mode: "safe",
      utterance: "what is the capital of Belgium",
      latencyMs: 18_402,
      runDir: "/tmp/test-runs/x",
      probeError: null,
      responses: {},
      silentUnknown: true,
      evidenceErrors: [{ step: "activityDiffError", error: "map is not a function" }],
    });
  });
  assert.match(text, /18402ms/);
  assert.match(text, /planned   : \(none\)/);
  assert.match(text, /DEGRADED  : activityDiffError — map is not a function/);
  assert.match(text, /silence NOT assessed/);
  assert.match(text, /files     : \(none\)/);
  // An entirely empty bundle must not throw either.
  assert.doesNotThrow(() => renderHumanSummary({}));
  assert.doesNotThrow(() => renderHumanSummary(undefined));
});

test("renderHumanSummary surfaces the activity note so a dead cross-check is visible", () => {
  const text = renderHumanSummary({
    mode: "safe",
    utterance: "u",
    latencyMs: 1,
    responses: {},
    activityDiff: { newPromptCount: 0, newMusicCount: 0, note: "activity payload not recognised for: beforePrompts" },
  });
  assert.match(text, /activity  : \+0 prompts, \+0 music records/);
  assert.match(text, /payload not recognised/);
});

// ─── silence is a claim about the DEVICE, not about missing evidence ────────
test("assessSilence: an empty evidence window is 'unknown', never 'silent'", () => {
  const noEvidence = assessSilence({
    probeError: null, evidenceText: "", plannedActions: [], executedTools: [], degraded: false,
  });
  assert.equal(noEvidence.silent, false, "no evidence must not be reported as device silence");
  assert.equal(noEvidence.silentUnknown, true);

  const degraded = assessSilence({
    probeError: null, evidenceText: "some log text", plannedActions: [], executedTools: [], degraded: true,
  });
  assert.equal(degraded.silent, false);
  assert.equal(degraded.silentUnknown, true);
});

test("assessSilence: real silence is still reported (the guard is not vacuous)", () => {
  const real = assessSilence({
    probeError: null,
    evidenceText: "1718000000.1 I PenumbraServer: turn complete",
    plannedActions: [],
    executedTools: [],
    degraded: false,
  });
  assert.equal(real.silent, true, "a real turn with evidence and no actions IS silent");
  assert.equal(real.silentUnknown, false);

  // A turn that did something is not silent…
  assert.equal(assessSilence({
    probeError: null, evidenceText: "log", plannedActions: ["Respond"], executedTools: [], degraded: false,
  }).silent, false);
  assert.equal(assessSilence({
    probeError: null, evidenceText: "log", plannedActions: [], executedTools: [{ tool: "web_search", ok: true }], degraded: false,
  }).silent, false);
  // …and a turn that errored is an error, not silence.
  assert.equal(assessSilence({
    probeError: "AppServer(TimedOut)", evidenceText: "log", plannedActions: [], executedTools: [], degraded: false,
  }).silent, false);
});

test("stockActionPayload + STOCK_ACTION_DISPATCHABLE: volume is not dispatchable", () => {
  assert.deepEqual(stockActionPayload("PlayMusic"), { track: null, artist: null });
  assert.equal(STOCK_ACTION_DISPATCHABLE.has("PlayMusic"), true);
  assert.equal(STOCK_ACTION_DISPATCHABLE.has("IncrementVolume"), false);
});

// ─── admin HTTP allowlist ───────────────────────────────────────────────────
test("allowlist matches the PATH, not the query string", () => {
  // Every parameterised call probe makes used to be refused, which cost it the
  // independent activity cross-check AND the server-log fallback. Real evidence
  // from an on-disk run: `activityBeforeError: "refusing a non-allowlisted
  // endpoint: /api/activity/prompts?limit=100"`.
  assert.equal(assertAllowlistedPath("/api/activity/prompts?limit=100"), "/api/activity/prompts");
  assert.equal(assertAllowlistedPath("/api/activity/music?limit=100"), "/api/activity/music");
  assert.equal(assertAllowlistedPath("/api/logs/server?lines=4000"), "/api/logs/server");
  assert.equal(assertAllowlistedPath("/api/logs/server"), "/api/logs/server");
});

test("allowlist is NOT widened: a new endpoint is still refused, with or without a query", () => {
  for (const bad of [
    "/api/settings",
    "/api/settings?x=1",
    "/api/activity/promptsX?limit=1",
    "/api/logs/server/../../settings",
    "http://evil.example.com/api/logs/server",
    "",
  ]) {
    assert.throws(() => assertAllowlistedPath(bad), /refusing a non-allowlisted endpoint/, bad);
  }
  assert.throws(() => assertAllowlistedPath(null), /refusing a non-allowlisted endpoint/);
});

test("allowlist guards the query charset (the path is spliced into a curl config)", () => {
  // The query is no longer covered by the exact-match check, so it needs its
  // own guard: `url = "http://127.0.0.1:8080<path>"` is a quoted curl config
  // line, and a quote or a newline in the query would be config injection.
  for (const bad of [
    '/api/logs/server?lines=1"\nurl = "http://evil.example.com/',
    "/api/logs/server?lines=1 --output /tmp/x",
    "/api/logs/server?lines=1\\",
    "/api/logs/server?a=<b>",
  ]) {
    assert.throws(() => assertAllowlistedPath(bad), /unsafe query string/, JSON.stringify(bad));
  }
  // A fragment is not part of a request line at all.
  assert.throws(() => assertAllowlistedPath("/api/logs/server#frag"), /non-allowlisted endpoint/);
});

test("every allowlisted path is absolute and query-free", () => {
  for (const p of PROBE_API_PATHS) {
    assert.match(p, /^\/api\//, p);
    assert.equal(p.includes("?"), false, p);
    assert.equal(assertAllowlistedPath(p), p);
  }
});

// ─── marker liveness: a renamed marker must not be silent ───────────────────
// Generalises this project's hardest-won lesson to the log side. Every literal
// the parser greps for must still have an emitter in the sources it claims to
// read. A renamed marker is invisible in BOTH directions — the parser reports
// nothing, and nothing reports that the parser has gone blind — which is the
// same failure mode as a tool name that does not exist. That has bitten this
// project three times.
function collectSourceText(roots) {
  const chunks = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "target" || entry.name === "build" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(rs|kt|java)$/.test(entry.name)) {
        chunks.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  for (const root of roots) walk(path.join(REPO_ROOT, root));
  return chunks;
}

test("LOAD-BEARING: every parsed log marker still has an emitter in the sources", () => {
  const roots = ["runtime/core/src", "hook/payload/src"];
  const chunks = collectSourceText(roots);
  // Prove the scan itself can go red: an empty corpus would pass every marker
  // vacuously, which is exactly the "guard that cannot fail" trap.
  assert.ok(chunks.length > 100, `only ${chunks.length} source files scanned under ${roots.join(", ")}`);
  const haystack = chunks.join("\n");
  assert.ok(PARSED_LOG_MARKERS.length >= 9, "the marker list shrank unexpectedly");

  const orphans = [];
  for (const marker of PARSED_LOG_MARKERS) {
    // Match the COMPLETE quoted literal, so `<<< hermes mutation` is not
    // satisfied merely by the longer `<<< hermes mutation rejected: …` string.
    if (!haystack.includes(`"${marker}"`)) orphans.push(marker);
  }
  assert.deepEqual(
    orphans,
    [],
    `these markers have no emitter — the parser is silently blind to them: ${orphans.join(" | ")}`,
  );

  // The native-action line is assembled from the marker PLUS a separator the
  // parser also depends on (ContextHistorySafetyHooks.kt:266).
  assert.ok(haystack.includes("| action="), "the native-action separator ' | action=' is gone");

  // A marker that does NOT exist must be reported, or the check above proves
  // nothing about its ability to fail.
  assert.equal(haystack.includes('"<<< hermes marker that does not exist"'), false);
});
