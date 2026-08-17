import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVER_SOURCE,
  buildActionResponseFixture,
  decodeUnderstandingResponses,
  parseGrpcFrames,
  wrapGrpcFrame,
} from "./agentic-release-smoke-lib.mjs";
import {
  FIXED_PROMPT_MATRIX,
  ROUTE_CLASS,
} from "./agentic-prompt-matrix.mjs";
import {
  ADMIN_TOKEN_ENVIRONMENT_VARIABLE,
  DEFAULT_ADMIN_URL,
  DEFAULT_GRPC_URL,
  DEFAULT_MODELS,
  MAX_MODELS,
  MAX_REPEATS,
  REPAIR_MARKERS,
  aggregateModelReport,
  assertLoopbackHttpUrl,
  baselineModelValue,
  countMarkers,
  main,
  markerDelta,
  modelTouchingCase,
  parseAbCliArgs,
  resolveAdminToken,
  restoreRequestBody,
  runModelPass,
  selectCases,
  selectModelField,
  validateModels,
  validateRankOneFixture,
} from "./model-ab-gate.mjs";

const ACTION_IDENTIFIER = "00000000-0000-4000-8000-000000000001";
const GENERIC_FINAL_ANSWER_THOUGHT =
  "I should return the final answer from bounded read-only planning";
const TEST_TOKEN = "unit-test-admin-token-0000000000000000";

function matrixCase(id) {
  const item = FIXED_PROMPT_MATRIX.find((candidate) => candidate.id === id);
  assert.ok(item, `missing matrix case ${id}`);
  return item;
}

function decodedActionResponses({
  action,
  thought,
  input = "{}",
  parentIdentifier,
  identifier = ACTION_IDENTIFIER,
}) {
  return decodeUnderstandingResponses(
    parseGrpcFrames(
      wrapGrpcFrame(
        buildActionResponseFixture({
          action,
          thought,
          input,
          parentIdentifier,
          identifier,
          source: SERVER_SOURCE,
          devicePayload: Buffer.alloc(0),
        }),
      ),
    ),
  );
}

function passingResponsesFor(caseId, userTurnId) {
  if (caseId === "deterministic_current_time") {
    return decodedActionResponses({
      action: "GetCurrentTime",
      thought: matrixCase(caseId).expectedThought,
      parentIdentifier: userTurnId,
    });
  }
  if (caseId === "agentic_ice_explanation") {
    return decodedActionResponses({
      action: "Respond",
      thought: GENERIC_FINAL_ANSWER_THOUGHT,
      input: JSON.stringify({
        Response:
          "Ice floats because its crystal structure makes it less dense than liquid water.",
      }),
      parentIdentifier: userTurnId,
    });
  }
  throw new Error(`no passing fixture for ${caseId}`);
}

test("loopback URL guard accepts loopback and rejects everything else", () => {
  assert.equal(
    assertLoopbackHttpUrl("http://127.0.0.1:8080", "x"),
    "http://127.0.0.1:8080",
  );
  assert.equal(
    assertLoopbackHttpUrl("http://localhost:9090/", "x"),
    "http://localhost:9090",
  );
  assert.throws(() => assertLoopbackHttpUrl("https://127.0.0.1:8080", "x"));
  assert.throws(() => assertLoopbackHttpUrl("http://192.168.1.20:8080", "x"));
  assert.throws(() => assertLoopbackHttpUrl("http://example.com", "x"));
  assert.throws(() => assertLoopbackHttpUrl("http://127.0.0.1:8080/api", "x"));
  assert.throws(() => assertLoopbackHttpUrl("http://u:p@127.0.0.1:8080", "x"));
  assert.throws(() => assertLoopbackHttpUrl("http://127.0.0.1:8080?x=1", "x"));
  assert.throws(() => assertLoopbackHttpUrl("not a url", "x"));
});

test("CLI defaults are loopback with the wired DashScope candidates", () => {
  const options = parseAbCliArgs([]);
  assert.deepEqual(options.models, [...DEFAULT_MODELS]);
  assert.equal(options.adminUrl, DEFAULT_ADMIN_URL);
  assert.equal(options.grpcUrl, DEFAULT_GRPC_URL);
  assert.equal(options.repeats, 1);
  assert.equal(options.modelField, "auto");
  assert.equal(options.warmup, true);
  assert.equal(options.keepModel, false);
});

test("CLI rejects invalid input before any network use", () => {
  assert.throws(() => parseAbCliArgs(["--models", "bad model name"]));
  assert.throws(() => parseAbCliArgs(["--models", "a,a"]));
  assert.throws(() =>
    parseAbCliArgs(["--models", Array.from({ length: MAX_MODELS + 1 }, (_, i) => `m${i}`).join(",")]),
  );
  assert.throws(() => parseAbCliArgs(["--repeats", "0"]));
  assert.throws(() => parseAbCliArgs(["--repeats", String(MAX_REPEATS + 1)]));
  assert.throws(() => parseAbCliArgs(["--repeats", "1.5"]));
  assert.throws(() => parseAbCliArgs(["--timeout-ms", "500"]));
  assert.throws(() => parseAbCliArgs(["--timeout-ms", "999999"]));
  assert.throws(() => parseAbCliArgs(["--model-field", "other"]));
  assert.throws(() => parseAbCliArgs(["--cases", "no_such_case"]));
  assert.throws(() => parseAbCliArgs(["--cases", "tickle,tickle"]));
  assert.throws(() => parseAbCliArgs(["--admin-url", "http://10.0.0.2:8080"]));
  assert.throws(() => parseAbCliArgs(["--grpc-url", "https://127.0.0.1:9090"]));
  assert.throws(() => parseAbCliArgs(["--unknown"]));
});

test("model list validation bounds names and cardinality", () => {
  assert.deepEqual(validateModels(["qwen3.7-max"]), ["qwen3.7-max"]);
  assert.throws(() => validateModels([]));
  assert.throws(() => validateModels(["-leading-dash"]));
  assert.throws(() => validateModels(["has space"]));
  assert.throws(() => validateModels(["a".repeat(65)]));
});

test("case selection preserves gate order, filters, and validates ids", () => {
  assert.equal(selectCases().length, FIXED_PROMPT_MATRIX.length);
  const subset = selectCases({
    caseIds: ["deterministic_current_time", "agentic_ice_explanation"],
  });
  assert.deepEqual(
    subset.map((item) => item.id),
    ["deterministic_current_time", "agentic_ice_explanation"],
  );
  const agentic = selectCases({ agenticOnly: true });
  assert.ok(agentic.length > 0);
  assert.ok(agentic.every(modelTouchingCase));
  assert.ok(!agentic.some((item) => item.id === "deterministic_current_time"));
  assert.throws(() => selectCases({ caseIds: ["missing"] }));
  assert.throws(() =>
    selectCases({ caseIds: ["deterministic_current_time"], agenticOnly: true }),
  );
});

test("model field selection follows the active provider", () => {
  assert.equal(
    selectModelField({ llm: { provider: "openai_compatible" } }),
    "model",
  );
  assert.equal(
    selectModelField({ llm: { provider: "codex", codex_custom_active: true } }),
    "codex_model",
  );
  assert.throws(() =>
    selectModelField({ llm: { provider: "codex", codex_custom_active: false } }),
  );
  assert.equal(selectModelField({}, "codex_model"), "codex_model");
  assert.throws(() => selectModelField({}));
});

test("baseline and restore round-trip includes the null codex_model shape", () => {
  const settings = { llm: { model: "qwen-plus", codex_model: null } };
  assert.equal(baselineModelValue(settings, "model"), "qwen-plus");
  assert.equal(baselineModelValue(settings, "codex_model"), null);
  assert.throws(() => baselineModelValue({}, "model"));
  assert.deepEqual(restoreRequestBody("model", "qwen-plus"), {
    llm: { model: "qwen-plus" },
  });
  assert.deepEqual(restoreRequestBody("codex_model", null), {
    llm: { codex_model: "" },
  });
});

test("repair marker counting and deltas stay content-free and fail closed", () => {
  const text = [
    `x ${REPAIR_MARKERS.verification_gate_nudges} y`,
    `x ${REPAIR_MARKERS.backend_errors} y`,
    `x ${REPAIR_MARKERS.verification_gate_nudges} y`,
  ].join("\n");
  assert.deepEqual(countMarkers(text), {
    verification_gate_nudges: 2,
    backend_errors: 1,
    declines: 0,
  });
  assert.deepEqual(countMarkers(undefined), {
    verification_gate_nudges: 0,
    backend_errors: 0,
    declines: 0,
  });
  const before = { verification_gate_nudges: 1, backend_errors: 0, declines: 0 };
  const after = { verification_gate_nudges: 3, backend_errors: 1, declines: 0 };
  assert.deepEqual(markerDelta(before, after), {
    verification_gate_nudges: 2,
    backend_errors: 1,
    declines: 0,
  });
  assert.equal(markerDelta(after, before), null); // rotation
  assert.equal(markerDelta(null, after), null);
  assert.equal(markerDelta(before, null), null);
});

test("admin token resolution prefers the environment and validates shape", async () => {
  const environment = { [ADMIN_TOKEN_ENVIRONMENT_VARIABLE]: TEST_TOKEN };
  assert.equal(await resolveAdminToken({}, environment), TEST_TOKEN);
  assert.equal(
    await resolveAdminToken(
      { tokenFile: "/fixture/token" },
      {},
      async () => `  ${TEST_TOKEN}\n`,
    ),
    TEST_TOKEN,
  );
  await assert.rejects(resolveAdminToken({}, {}));
  await assert.rejects(
    resolveAdminToken({}, { [ADMIN_TOKEN_ENVIRONMENT_VARIABLE]: "with\nnewline" }),
  );
  await assert.rejects(
    resolveAdminToken({ tokenFile: "/fixture/token" }, {}, async () => "\n"),
  );
});

test("rank-one fixture validation accepts the provider shape only", () => {
  const fixture = validateRankOneFixture({
    title: "PRIVATE_TITLE",
    artists: ["Michael Jackson"],
    album: "PRIVATE_ALBUM",
  });
  assert.equal(fixture.title, "PRIVATE_TITLE");
  assert.throws(() => validateRankOneFixture(null));
  assert.throws(() => validateRankOneFixture({ title: "", artists: ["a"] }));
  assert.throws(() => validateRankOneFixture({ title: "t", artists: [] }));
  assert.throws(() => validateRankOneFixture({ title: "t", artists: [1] }));
  assert.throws(() =>
    validateRankOneFixture({ title: "t", artists: ["a"], album: 4 }),
  );
});

test("aggregation reports zero-repair rate, misfires, and latency", () => {
  const records = [
    // clean agentic pass
    { id: "a", repeat: 1, status: "pass", routeClass: ROUTE_CLASS.AGENTIC_FINAL_ANSWER, actionName: "Respond", elapsedMs: 2_000, modelTouching: true, wrongAction: false, falseFire: false },
    // wrong native action where Respond was expected: wrong + false-fire
    { id: "b", repeat: 1, status: "fail", routeClass: ROUTE_CLASS.AGENTIC_NATIVE_ACTION, actionName: "PauseMusic", elapsedMs: 4_000, modelTouching: true, wrongAction: true, falseFire: true },
    // model answered instead of acting: wrong action, not a false fire
    { id: "c", repeat: 1, status: "fail", routeClass: ROUTE_CLASS.AGENTIC_FINAL_ANSWER, actionName: "Respond", elapsedMs: 6_000, modelTouching: true, wrongAction: true, falseFire: false },
    // deterministic pass, excluded from model-case latency
    { id: "d", repeat: 1, status: "pass", routeClass: ROUTE_CLASS.DETERMINISTIC_NATIVE_ACTION, actionName: "GetCurrentTime", elapsedMs: 100, modelTouching: false, wrongAction: false, falseFire: false },
    { id: "e", repeat: 1, status: "fail", routeClass: ROUTE_CLASS.AGENTIC_SAFE_FAILURE, actionName: "Respond", elapsedMs: 8_000, modelTouching: true, wrongAction: false, falseFire: false },
    { id: "f", repeat: 1, status: "fail", routeClass: ROUTE_CLASS.INFRASTRUCTURE_FAILURE, actionName: null, elapsedMs: 30_000, modelTouching: true, wrongAction: false, falseFire: false },
    { id: "g", repeat: 1, status: "skipped_provider_fixture_unavailable", routeClass: null, actionName: null, elapsedMs: null, modelTouching: true, wrongAction: false, falseFire: false },
  ];
  const markers = { verification_gate_nudges: 1, backend_errors: 0, declines: 0 };
  const report = aggregateModelReport("qwen-plus", records, markers);
  assert.equal(report.model, "qwen-plus");
  assert.equal(report.cases.evaluated, 6);
  assert.equal(report.cases.pass, 2);
  assert.equal(report.cases.fail, 4);
  assert.equal(report.cases.skippedProviderCases, 1);
  assert.equal(report.cases.infrastructureFailures, 1);
  assert.equal(report.zeroRepairRate, Number((2 / 6).toFixed(4)));
  assert.equal(report.wrongActions, 2);
  assert.equal(report.falseFires, 1);
  assert.equal(report.safeFailures, 1);
  // latency over completed (non-infrastructure) records only
  assert.equal(report.latencyMs.mean, Math.round((2000 + 4000 + 6000 + 100 + 8000) / 5));
  assert.equal(report.latencyMs.max, 8_000);
  assert.equal(report.latencyMs.p50, 4_000);
  assert.equal(report.latencyMs.modelCaseMean, Math.round((2000 + 4000 + 6000 + 8000) / 4));
  assert.deepEqual(report.repairMarkers, markers);
});

test("a model pass aborts after consecutive transport failures", async () => {
  const cases = [
    matrixCase("deterministic_current_time"),
    matrixCase("agentic_ice_explanation"),
    matrixCase("agentic_music_top_read"),
  ];
  const runtime = {
    now: Date.now,
    runUnderstand: async () => {
      throw new Error("down");
    },
  };
  const { records, aborted } = await runModelPass({
    cases,
    repeats: 1,
    rankOne: { title: "t", artists: ["a"] },
    runtime,
    context: { grpcUrl: DEFAULT_GRPC_URL, timeoutMs: 5_000 },
  });
  assert.equal(aborted, true);
  assert.deepEqual(
    records.map((record) => record.routeClass),
    [
      ROUTE_CLASS.INFRASTRUCTURE_FAILURE,
      ROUTE_CLASS.INFRASTRUCTURE_FAILURE,
      ROUTE_CLASS.NOT_RUN,
    ],
  );
});

function makeResponse(status, body, isText = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (isText ? body : JSON.stringify(body)),
  };
}

function makeFakeAdmin({ initialModel = "qwen-plus" } = {}) {
  const state = {
    model: initialModel,
    putBodies: [],
    paths: [],
  };
  const fetchImpl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    state.paths.push(`${init.method ?? "GET"} ${pathname}${search}`);
    const authorized =
      init.headers?.authorization === `Bearer ${TEST_TOKEN}`;
    if (!authorized) return makeResponse(401, "unauthorized", true);
    if (pathname === "/api/health") return makeResponse(200, { status: "ok" });
    if (pathname === "/api/settings" && (init.method ?? "GET") === "GET") {
      return makeResponse(200, {
        llm: {
          provider: "openai_compatible",
          model: state.model,
          codex_model: null,
          codex_custom_active: false,
        },
      });
    }
    if (pathname === "/api/settings" && init.method === "PUT") {
      const body = JSON.parse(init.body);
      state.putBodies.push(body);
      if (typeof body?.llm?.model === "string") state.model = body.llm.model;
      return makeResponse(200, { restart_required: false });
    }
    if (pathname === "/api/logs/server") {
      return makeResponse(200, "no markers here\n", true);
    }
    if (pathname === "/api/spotify/search") {
      return makeResponse(503, "unavailable", true);
    }
    return makeResponse(404, "not found", true);
  };
  return { state, fetchImpl };
}

async function captureMain(argv, overrides) {
  const written = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const code = await main(argv, overrides);
    return { code, stdout: written.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("main runs an offline A/B, switches models, restores, and redacts", async () => {
  const { state, fetchImpl } = makeFakeAdmin({ initialModel: "qwen-plus" });
  const runUnderstand = async (grpcOrigin, utterance, { userTurnId }) => {
    assert.equal(grpcOrigin, DEFAULT_GRPC_URL);
    const item = FIXED_PROMPT_MATRIX.find((candidate) => candidate.prompt === utterance);
    assert.ok(item, "prompt must come from the fixed gate");
    return passingResponsesFor(item.id, userTurnId);
  };
  const { code, stdout } = await captureMain(
    [
      "--models",
      "candidate-a,candidate-b",
      "--cases",
      "deterministic_current_time,agentic_ice_explanation,agentic_music_top_read",
      "--no-warmup",
      "--json",
    ],
    {
      fetchImpl,
      runUnderstand,
      environment: { [ADMIN_TOKEN_ENVIRONMENT_VARIABLE]: TEST_TOKEN },
      sleep: async () => {},
      now: Date.now,
    },
  );
  assert.equal(code, 0);
  assert.ok(!stdout.includes(TEST_TOKEN));
  const report = JSON.parse(stdout);
  assert.equal(report.mode, "host_model_ab_prompt_gate");
  assert.equal(report.modelField, "model");
  assert.equal(report.providerFixtureAvailable, false);
  assert.equal(report.models.length, 2);
  for (const entry of report.models) {
    assert.equal(entry.cases.evaluated, 2);
    assert.equal(entry.cases.pass, 2);
    assert.equal(entry.cases.skippedProviderCases, 1);
    assert.equal(entry.zeroRepairRate, 1);
    assert.equal(entry.falseFires, 0);
    assert.deepEqual(entry.repairMarkers, {
      verification_gate_nudges: 0,
      backend_errors: 0,
      declines: 0,
    });
  }
  assert.equal(report.modelRestored, true);
  // model switches: candidate-a, candidate-b, then restore to qwen-plus
  assert.deepEqual(
    state.putBodies.map((body) => body.llm.model),
    ["candidate-a", "candidate-b", "qwen-plus"],
  );
  assert.equal(state.model, "qwen-plus");
  assert.ok(report.safety.nativeActionsDispatched === false);
  assert.ok(report.safety.loopbackOnly === true);
});

test("main restores the model and signals failure when a pass aborts", async () => {
  const { state, fetchImpl } = makeFakeAdmin({ initialModel: "qwen-plus" });
  const runUnderstand = async () => {
    throw new Error("provider down");
  };
  const { code, stdout } = await captureMain(
    [
      "--models",
      "candidate-a",
      "--cases",
      "deterministic_current_time,agentic_ice_explanation",
      "--no-warmup",
      "--json",
    ],
    {
      fetchImpl,
      runUnderstand,
      environment: { [ADMIN_TOKEN_ENVIRONMENT_VARIABLE]: TEST_TOKEN },
      sleep: async () => {},
      now: Date.now,
    },
  );
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.models[0].cases.infrastructureFailures, 2);
  assert.equal(report.modelRestored, true);
  assert.equal(state.model, "qwen-plus");
});

test("main fails safely without a token and never reaches the network", async () => {
  let fetched = 0;
  const { code } = await captureMain(["--models", "candidate-a"], {
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("must not be called");
    },
    environment: {},
  });
  assert.equal(code, 2);
  assert.equal(fetched, 0);
});
