import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTALLED_SERVER_SIGNER_IDENTITY,
  SERVER_PACKAGE_NAME,
} from "./agentic-release-smoke-lib.mjs";
import { OPERATIONAL_MARKERS } from "./tier-a-symbols.mjs";

import {
  CONTINUITY_PHASES,
  FIXED_CONTINUITY_PHRASE,
  SESSION_CONTINUITY_TURNS,
  buildContinuityActivityCurlConfig,
  buildContinuityTranscriptInjectionCommand,
  evaluateCandidateIdentity,
  evaluateContinuityLifecycleLog,
  evaluateDispatchQuiescenceLog,
  executeSessionContinuitySuite,
  main,
  parseContinuityPromptActivityPage,
  parseSessionContinuityCliArgs as parseSessionContinuityCliArgsWithEnvironment,
  reduceContinuityTurnActivity,
  renderSessionContinuityReport,
} from "./session-continuity-physical-smoke.mjs";

const PIN_SERIAL = "fixture-pin-serial";
const OTHER_SERIAL = "fixture-other-device";
const EXPECTED = Object.freeze({
  releaseId: "fixture-release",
  packageName: SERVER_PACKAGE_NAME,
  versionName: "2026-08-27.1",
  versionCode: 202_608_271,
  signerIdentity: INSTALLED_SERVER_SIGNER_IDENTITY,
});
const STOCK_FINAL_OBSERVATION =
  OPERATIONAL_MARKERS.stock_run_final_observation.value;
const STREAMING_UNDERSTAND_REQUEST_LOG =
  `INFO humane_server::services::aibus::understand: ${OPERATIONAL_MARKERS.streaming_understand_request.value}`;
const parseSessionContinuityCliArgs = (argv, environment = {}) =>
  parseSessionContinuityCliArgsWithEnvironment(argv, environment);

function liveArgs(extra = []) {
  return [
    "--run",
    "--serial",
    PIN_SERIAL,
    "--expected-pin-serial",
    PIN_SERIAL,
    "--release-manifest",
    "/fixture/manifest.json",
    "--release-receipts",
    "/fixture/receipts.json",
    ...extra,
  ];
}

function options() {
  return parseSessionContinuityCliArgs(liveArgs());
}

function identity(overrides = {}) {
  return {
    packageName: SERVER_PACKAGE_NAME,
    versionName: EXPECTED.versionName,
    versionCode: EXPECTED.versionCode,
    signerIdentity: EXPECTED.signerIdentity,
    ...overrides,
  };
}

function memoryWriter() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
      },
    },
    text() {
      return value;
    },
  };
}

const TURN_BY_ID = new Map(SESSION_CONTINUITY_TURNS.map((turn) => [turn.id, turn]));

function row(id, turnId, response, runId = `public-run-${id}`) {
  return {
    id,
    runId,
    prompt: TURN_BY_ID.get(turnId).prompt,
    response,
  };
}

class FakeDevice {
  constructor({
    responses = {},
    initialRows = [],
    failDeleteId = null,
    extraRows = {},
    omitActivityTurns = ["exact_reset"],
    lifecyclePollsBeforeFinal = {},
    missingFinalTurns = [],
    missingExactResetMarker = false,
    unexpectedExactResetMarkerTurns = [],
    agenticToolCounts = {},
    missingAgenticTerminalTurns = [],
    mutateVolumeOnTurn = null,
    failVolumeRestore = false,
    volumeRestoreMismatch = false,
    quiescenceBusyPollsBeforeRelease = {},
    quiescenceNeverReadyAfterTurns = [],
  } = {}) {
    this.rows = initialRows.map((item) => ({ ...item }));
    this.responses = {
      seed: "remembered",
      ordinary_interstitial: "continuing",
      ordinary_follow_up: FIXED_CONTINUITY_PHRASE,
      contextual_artist_query: "Solara",
      contextual_album_query: "Moonrise",
      near_miss_reset: "I can reset one session when explicitly requested.",
      near_miss_polite_reset:
        "I can reset the session only with the exact standalone command.",
      near_miss_punctuated_reset:
        "I can reset the session only with the exact standalone command.",
      near_miss_quoted_reset:
        "I can say reset session, but I won't actually reset without the exact command.",
      near_miss_compound_reset:
        "I can reset the session only with the exact standalone command.",
      near_miss_negated_reset:
        "I can reset the session only with the exact standalone command.",
      near_miss_follow_up: FIXED_CONTINUITY_PHRASE,
      exact_reset: "Action: ClearUnderstandingContext",
      post_reset_follow_up: "unknown",
      ...responses,
    };
    this.failDeleteId = failDeleteId;
    this.extraRows = extraRows;
    this.omitActivityTurns = new Set(omitActivityTurns);
    this.lifecyclePollsBeforeFinal = lifecyclePollsBeforeFinal;
    this.missingFinalTurns = new Set(missingFinalTurns);
    this.missingExactResetMarker = missingExactResetMarker;
    this.unexpectedExactResetMarkerTurns = new Set(
      unexpectedExactResetMarkerTurns,
    );
    this.agenticToolCounts = agenticToolCounts;
    this.missingAgenticTerminalTurns = new Set(missingAgenticTerminalTurns);
    this.mutateVolumeOnTurn = mutateVolumeOnTurn;
    this.failVolumeRestore = failVolumeRestore;
    this.volumeRestoreMismatch = volumeRestoreMismatch;
    this.quiescenceBusyPollsBeforeRelease =
      quiescenceBusyPollsBeforeRelease;
    this.quiescenceNeverReadyAfterTurns = new Set(
      quiescenceNeverReadyAfterTurns,
    );
    this.mediaVolumeState = {
      index: 7,
      minimum: 0,
      maximum: 15,
      muted: false,
    };
    this.cleanupOrder = [];
    this.injected = [];
    this.deleted = [];
    this.boundaryCount = 0;
    this.runCount = 0;
    this.pendingBoundary = null;
    this.lifecycleByBoundary = new Map();
    this.completedLifecycleTurns = new Set();
    this.lifecyclePolls = new Map();
    this.quiescenceBoundaryCount = 0;
    this.quiescenceByBoundary = new Map();
    this.quiescencePolls = new Map();
    this.nextId = this.rows.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1;
  }

  async promptRows() {
    return this.rows.map((item) => ({ ...item }));
  }

  async readMediaVolumeState() {
    return { ...this.mediaVolumeState };
  }

  async setMediaVolumeIndex(index) {
    this.cleanupOrder.push("volume_restore");
    if (this.failVolumeRestore) throw new Error("PRIVATE_VOLUME_RESTORE_FAILURE");
    this.mediaVolumeState = {
      ...this.mediaVolumeState,
      index: this.volumeRestoreMismatch ? index - 1 : index,
      muted: false,
    };
  }

  async beginTurnBoundary() {
    const previousTurn = this.injected.at(-1);
    if (
      previousTurn !== undefined &&
      !this.completedLifecycleTurns.has(previousTurn)
    ) {
      throw new Error("PRIVATE_NEXT_TURN_BEFORE_STOCK_FINAL");
    }
    this.boundaryCount += 1;
    this.pendingBoundary =
      `continuity-smoke-123e4567-e89b-42d3-a456-${String(this.boundaryCount).padStart(12, "0")}`;
    return this.pendingBoundary;
  }

  async beginDispatchQuiescenceBoundary() {
    const previousTurn = this.injected.at(-1);
    if (
      previousTurn === undefined ||
      !this.completedLifecycleTurns.has(previousTurn)
    ) {
      throw new Error("PRIVATE_QUIESCENCE_BEFORE_STOCK_FINAL");
    }
    this.quiescenceBoundaryCount += 1;
    const marker =
      `continuity-quiet-123e4567-e89b-42d3-a456-${String(this.quiescenceBoundaryCount).padStart(12, "0")}`;
    this.quiescenceByBoundary.set(marker, previousTurn);
    return marker;
  }

  async dispatchQuiescenceLog(boundaryMarker) {
    const previousTurn = this.quiescenceByBoundary.get(boundaryMarker);
    if (previousTurn === undefined) {
      throw new Error("PRIVATE_UNKNOWN_QUIESCENCE_BOUNDARY");
    }
    const polls = (this.quiescencePolls.get(previousTurn) ?? 0) + 1;
    this.quiescencePolls.set(previousTurn, polls);
    const lines = [
      `1710000000.001  100  101 I PenumbraContinuityQuiet: ${boundaryMarker}`,
    ];
    const busyPolls =
      this.quiescenceBusyPollsBeforeRelease[previousTurn] ?? 0;
    if (
      this.quiescenceNeverReadyAfterTurns.has(previousTurn) ||
      polls <= busyPolls
    ) {
      lines.push(
        "1710000000.002  200  201 D RunManager: Started new Run: 123e4567-e89b-42d3-a456-426614174099",
      );
    } else if (busyPolls > 0) {
      lines.push(
        "1710000000.002  200  201 D RunManager: Started new Run: 123e4567-e89b-42d3-a456-426614174099",
        `1710000000.003  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
      );
    }
    return lines.join("\n");
  }

  async inject(turnId) {
    if (this.pendingBoundary === null) {
      throw new Error("PRIVATE_MISSING_BOUNDARY");
    }
    this.injected.push(turnId);
    if (turnId === this.mutateVolumeOnTurn) {
      this.mediaVolumeState = { ...this.mediaVolumeState, index: 0, muted: true };
    }
    this.runCount += 1;
    const runId =
      `123e4567-e89b-42d3-a456-${String(100_000 + this.runCount).padStart(12, "0")}`;
    this.lifecycleByBoundary.set(this.pendingBoundary, { turnId, runId });
    if (!this.omitActivityTurns.has(turnId)) {
      const id = this.nextId++;
      this.rows.push(row(id, turnId, this.responses[turnId], runId));
    }
    for (const extra of this.extraRows[turnId] ?? []) {
      this.rows.push({ ...extra, id: this.nextId++ });
    }
    this.pendingBoundary = null;
  }

  async continuityLog(boundaryMarker) {
    const lifecycle = this.lifecycleByBoundary.get(boundaryMarker);
    if (lifecycle === undefined) throw new Error("PRIVATE_UNKNOWN_BOUNDARY");
    const polls = (this.lifecyclePolls.get(lifecycle.turnId) ?? 0) + 1;
    this.lifecyclePolls.set(lifecycle.turnId, polls);
    const lines = [
      `1710000000.000  99  100 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundaryMarker}`,
      `1710000000.002  200  201 D RunManager: Started new Run: ${lifecycle.runId}`,
      "1710000000.003  200  201 W PenumbraHook: PRIVATE_HOOK_DETAIL",
    ];
    if (lifecycle.turnId !== "exact_reset") {
      lines.push(
        `1710000000.004  200  201 W PenumbraServer: ${STREAMING_UNDERSTAND_REQUEST_LOG} run_id=${lifecycle.runId}`,
      );
      let ordinal = 1;
      for (
        let index = 0;
        index < (this.agenticToolCounts[lifecycle.turnId] ?? 0);
        index += 1
      ) {
        lines.push(
          `1710000000.005  200  201 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${lifecycle.runId} ordinal=${ordinal} tool=knowledge_lookup status=completed result_status=ok`,
        );
        ordinal += 1;
      }
      if (!this.missingAgenticTerminalTurns.has(lifecycle.turnId)) {
        lines.push(
          `1710000000.006  200  201 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${lifecycle.runId} ordinal=${ordinal} tool=terminal status=completed`,
        );
      }
    }
    if (
      (lifecycle.turnId === "exact_reset" &&
        !this.missingExactResetMarker) ||
      this.unexpectedExactResetMarkerTurns.has(lifecycle.turnId)
    ) {
      lines.push(
        "1710000000.007  200  201 W PenumbraHook: Authorized exact context-reset action",
      );
    }
    if (
      !this.missingFinalTurns.has(lifecycle.turnId) &&
      polls > (this.lifecyclePollsBeforeFinal[lifecycle.turnId] ?? 0)
    ) {
      lines.push(
        lifecycle.turnId === "exact_reset"
          ? `1710000000.008  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`
          : "1710000000.008  200  201 W PenumbraServer: INFO humane_server::services::aibus::turn::streaming: <<< BidirectionalStreamingUnderstand completed after final observation",
      );
      this.completedLifecycleTurns.add(lifecycle.turnId);
    }
    return lines.join("\n");
  }

  async deletePrompt(id) {
    this.cleanupOrder.push(`activity_cleanup:${id}`);
    this.deleted.push(id);
    if (id === this.failDeleteId) throw new Error("PRIVATE_DELETE_FAILURE");
    this.rows = this.rows.filter((item) => item.id !== id);
  }
}

function liveDependencies(device, overrides = {}) {
  let now = 0;
  return {
    loadExpectedServerIdentity: async () => EXPECTED,
    identity: identity(),
    token: "public-fixture-token",
    device,
    now: () => now,
    delay: async (milliseconds) => {
      now += milliseconds;
    },
    ...overrides,
  };
}

test("live CLI requires an operator-confirmed Pin and complete runtime identity", () => {
  assert.deepEqual(parseSessionContinuityCliArgs([...liveArgs(), "--json"]), {
    mode: "run",
    phase: "full",
    serial: PIN_SERIAL,
    expectedPinSerial: PIN_SERIAL,
    adbPath: "adb",
    releaseManifestPath: "/fixture/manifest.json",
    releaseReceiptsPath: "/fixture/receipts.json",
    json: true,
    help: false,
  });
  const environmentArgs = liveArgs().filter(
    (value, index, values) =>
      value !== "--expected-pin-serial" &&
      values[index - 1] !== "--expected-pin-serial",
  );
  assert.equal(
    parseSessionContinuityCliArgs(environmentArgs, {
      PENUMBRA_EXPECTED_PIN_SERIAL: PIN_SERIAL,
    }).expectedPinSerial,
    PIN_SERIAL,
  );

  assert.throws(
    () =>
      parseSessionContinuityCliArgs(
        liveArgs().filter((_, index, values) => {
          const serialFlag = values.indexOf("--serial");
          return index !== serialFlag && index !== serialFlag + 1;
        }),
      ),
    /operator-confirmed AI Pin serial/,
  );
  const wrongTarget = liveArgs();
  wrongTarget[wrongTarget.indexOf("--serial") + 1] = OTHER_SERIAL;
  assert.throws(
    () => parseSessionContinuityCliArgs(wrongTarget),
    /operator-confirmed AI Pin serial/,
  );
  assert.throws(
    () =>
      parseSessionContinuityCliArgs([
        "--run",
        "--serial",
        PIN_SERIAL,
        "--expected-pin-serial",
        PIN_SERIAL,
      ]),
    /release-manifest/,
  );
  for (const removed of ["--release-manifest", "--release-receipts"]) {
    const args = liveArgs();
    const index = args.indexOf(removed);
    args.splice(index, 2);
    assert.throws(() => parseSessionContinuityCliArgs(args), new RegExp(removed));
  }
  for (const obsolete of [
    ["--expect-version-name", EXPECTED.versionName],
    ["--expect-version-code", String(EXPECTED.versionCode)],
    ["--expect-apk-sha256", "a".repeat(64)],
  ]) {
    assert.throws(
      () => parseSessionContinuityCliArgs([...liveArgs(), ...obsolete]),
      /unknown command option/,
    );
  }
  assert.throws(
    () => parseSessionContinuityCliArgs([...liveArgs(), "--prompt", "PRIVATE_PROMPT"]),
    /unknown command option/,
  );
  assert.throws(
    () => parseSessionContinuityCliArgs([...liveArgs(), "--case", "seed"]),
    /unknown command option/,
  );
  assert.throws(
    () => parseSessionContinuityCliArgs(["--self-check", "--serial", PIN_SERIAL]),
    /does not accept live-device options/,
  );
  assert.throws(
    () => parseSessionContinuityCliArgs([...liveArgs(), "--self-check"]),
    /exactly one mode/,
  );
  assert.throws(
    () => parseSessionContinuityCliArgs([...liveArgs(), "--adb", "adb\nother"]),
    /ADB executable path/,
  );
  for (const duplicate of [
    ["--serial", PIN_SERIAL],
    ["--expected-pin-serial", PIN_SERIAL],
    ["--release-manifest", "/fixture/manifest.json"],
    ["--release-receipts", "/fixture/receipts.json"],
  ]) {
    assert.throws(
      () => parseSessionContinuityCliArgs([...liveArgs(), ...duplicate]),
      /provided once/,
    );
  }
  assert.throws(
    () => parseSessionContinuityCliArgs(["--run", "--run", ...liveArgs().slice(1)]),
    /exactly one mode/,
  );
});

test("fixed continuity matrix is immutable, public, bounded, and complete", () => {
  assert.equal(Object.isFrozen(SESSION_CONTINUITY_TURNS), true);
  assert.ok(SESSION_CONTINUITY_TURNS.every(Object.isFrozen));
  assert.deepEqual(
    SESSION_CONTINUITY_TURNS.map((turn) => turn.id),
    [
      "seed",
      "ordinary_interstitial",
      "ordinary_follow_up",
      "contextual_artist_query",
      "contextual_album_query",
      "near_miss_reset",
      "near_miss_polite_reset",
      "near_miss_punctuated_reset",
      "near_miss_quoted_reset",
      "near_miss_compound_reset",
      "near_miss_negated_reset",
      "near_miss_follow_up",
      "exact_reset",
      "post_reset_follow_up",
    ],
  );
  assert.ok(
    SESSION_CONTINUITY_TURNS.every(
      (turn) => Buffer.byteLength(turn.prompt, "utf8") <= 512,
    ),
  );
  assert.match(TURN_BY_ID.get("seed").prompt, new RegExp(FIXED_CONTINUITY_PHRASE));
  assert.doesNotMatch(
    [
      TURN_BY_ID.get("ordinary_follow_up").prompt,
      TURN_BY_ID.get("near_miss_follow_up").prompt,
      TURN_BY_ID.get("post_reset_follow_up").prompt,
    ].join(" "),
    new RegExp(FIXED_CONTINUITY_PHRASE),
  );
  assert.equal(TURN_BY_ID.get("near_miss_reset").prompt, "reset sessions");
  assert.equal(
    TURN_BY_ID.get("near_miss_polite_reset").prompt,
    "please reset session",
  );
  assert.equal(
    TURN_BY_ID.get("near_miss_punctuated_reset").prompt,
    "reset session.",
  );
  assert.equal(
    TURN_BY_ID.get("near_miss_quoted_reset").prompt,
    'say "reset session"',
  );
  assert.equal(
    TURN_BY_ID.get("near_miss_compound_reset").prompt,
    "reset session and play music",
  );
  assert.equal(TURN_BY_ID.get("exact_reset").prompt, "reset session");
  assert.doesNotMatch(
    SESSION_CONTINUITY_TURNS.map((turn) => turn.prompt).join(" "),
    /\b(?:call|message|camera|photo|install|reboot|factory reset)\b/i,
  );
});

test("post-ASR injection is package-bound and built only from fixed turn ids", () => {
  assert.equal(
    buildContinuityTranscriptInjectionCommand("exact_reset"),
    'am broadcast --user 0 -a hu.ma.ne.INJECT_TRANSCRIPTION -p hu.ma.ne.ironman --es transcription "reset session" --ez vision false',
  );
  assert.match(
    buildContinuityTranscriptInjectionCommand("seed"),
    /^am broadcast --user 0 -a hu\.ma\.ne\.INJECT_TRANSCRIPTION -p hu\.ma\.ne\.ironman --es transcription ".+" --ez vision false$/,
  );
  assert.throws(
    () => buildContinuityTranscriptInjectionCommand("seed; reboot"),
    /unknown fixed continuity turn/,
  );
  for (const turn of SESSION_CONTINUITY_TURNS) {
    const command = buildContinuityTranscriptInjectionCommand(turn.id);
    assert.doesNotMatch(command, /\b(?:pm|cmd)\s+install|install-create|install-commit|\blogcat\b/);
  }
});

test("Center transport admits only bounded prompt reads and single-row deletes", () => {
  const token = "public-fixture-token";
  const get = buildContinuityActivityCurlConfig(
    "/api/activity/prompts?limit=100",
    "GET",
    token,
  );
  const remove = buildContinuityActivityCurlConfig(
    "/api/activity/prompts/42",
    "DELETE",
    token,
  );
  try {
    assert.match(get.toString("utf8"), /\/api\/activity\/prompts\?limit=100/);
    assert.match(remove.toString("utf8"), /\/api\/activity\/prompts\/42/);
    assert.throws(
      () => buildContinuityActivityCurlConfig("/api/activity/prompts", "DELETE", token),
      /non-allowlisted/,
    );
    assert.throws(
      () => buildContinuityActivityCurlConfig("/api/activity/prompts/0", "DELETE", token),
      /non-allowlisted/,
    );
    assert.throws(
      () => buildContinuityActivityCurlConfig("/api/settings", "GET", token),
      /non-allowlisted/,
    );
    assert.throws(
      () => buildContinuityActivityCurlConfig("/api/activity/prompts/1", "DELETE", "short"),
      /admin token/,
    );
  } finally {
    get.fill(0);
    remove.fill(0);
  }
});

test("prompt activity parser accepts only bounded typed rows", () => {
  assert.deepEqual(
    parseContinuityPromptActivityPage({
      items: [
        {
          id: 7,
          run_id: "opaque-public-run",
          prompt: "public prompt",
          response: "public response",
        },
      ],
    }),
    [
      {
        id: 7,
        runId: "opaque-public-run",
        prompt: "public prompt",
        response: "public response",
      },
    ],
  );
  assert.throws(() => parseContinuityPromptActivityPage(null), /malformed/);
  assert.throws(() => parseContinuityPromptActivityPage({ items: "no" }), /malformed/);
  assert.throws(
    () => parseContinuityPromptActivityPage({ items: Array.from({ length: 101 }, () => ({})) }),
    /malformed/,
  );
  for (const invalid of [
    { id: 0, run_id: "run", prompt: "p", response: "r" },
    { id: 1, run_id: "", prompt: "p", response: "r" },
    { id: 1, run_id: "run", prompt: 3, response: "r" },
    { id: 1, run_id: "run", prompt: "p", response: {} },
  ]) {
    assert.throws(
      () => parseContinuityPromptActivityPage({ items: [invalid] }),
      /malformed/,
    );
  }
  assert.throws(
    () =>
      parseContinuityPromptActivityPage({
        items: [{ id: 1, run_id: "r".repeat(257), prompt: "p", response: "r" }],
      }),
    /malformed/,
  );
});

test("continuity lifecycle requires one fresh stock request followed by its final", () => {
  const boundary =
    "continuity-smoke-123e4567-e89b-42d3-a456-426614174000";
  const runId = "123e4567-e89b-42d3-a456-426614174001";
  const evidence = evaluateContinuityLifecycleLog(
    [
      `1710000000.000  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      `1710000000.002  200  201 D RunManager:  Started new Run: ${runId}`,
      "1710000000.003  200  201 W PenumbraHook: PRIVATE_HOOK_DETAIL",
      `1710000000.004  200  201 D RunManager:  ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.deepEqual(evidence, {
    freshBoundaryObserved: true,
    requestObserved: true,
    agenticStartObserved: false,
    agenticNoToolTerminalCorrelated: false,
    agenticToolTerminalCorrelated: false,
    stockFinalObserved: true,
    requestFinalCorrelated: true,
    processStable: true,
    correlatedResetAuthorization: false,
    correlatedResetAuthorizationCount: 0,
    exactResetMarkerObserved: false,
    exactResetMarkerCount: 0,
    wrongPidResetMarkerCount: 0,
    beforeRequestResetMarkerCount: 0,
    afterFinalResetMarkerCount: 0,
    agenticCompletedToolCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_|123e4567/);

  const reordered = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      `1710000000.002  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
      `1710000000.003  200  201 D RunManager: Started new Run: ${runId}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(reordered.requestFinalCorrelated, false);
});

test("continuity lifecycle accepts the correlated Server markers emitted by stock bidi", () => {
  const boundary =
    "continuity-smoke-123e4567-e89b-42d3-a456-426614174005";
  const runId = "123e4567-e89b-42d3-a456-426614174006";
  const evidence = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke:  ${boundary}`,
      `1710000000.002  4000  101 W PenumbraServer:  ${STREAMING_UNDERSTAND_REQUEST_LOG} run_id=${runId}`,
      `1710000000.003  4000  101 W PenumbraServer:  INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${runId} ordinal=1 tool=terminal status=completed`,
      "1710000000.004  4000  101 W PenumbraServer:  INFO humane_server::services::aibus::turn::streaming: <<< BidirectionalStreamingUnderstand completed after final observation",
    ].join("\n"),
    boundary,
  );
  assert.deepEqual(evidence, {
    freshBoundaryObserved: true,
    requestObserved: true,
    agenticStartObserved: true,
    agenticNoToolTerminalCorrelated: true,
    agenticToolTerminalCorrelated: false,
    stockFinalObserved: true,
    requestFinalCorrelated: true,
    processStable: true,
    correlatedResetAuthorization: false,
    correlatedResetAuthorizationCount: 0,
    exactResetMarkerObserved: false,
    exactResetMarkerCount: 0,
    wrongPidResetMarkerCount: 0,
    beforeRequestResetMarkerCount: 0,
    afterFinalResetMarkerCount: 0,
    agenticCompletedToolCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /123e4567/);
});

test("dispatch quiescence reduction tracks only content-free stock busy state", () => {
  const boundary =
    "continuity-quiet-123e4567-e89b-42d3-a456-426614174020";
  const quiet = evaluateDispatchQuiescenceLog(
    [
      "1710000000.000  200  201 D RunManager: Started new Run: 123e4567-e89b-42d3-a456-426614174019",
      `1710000000.001  100  101 I PenumbraContinuityQuiet: ${boundary}`,
      "1710000000.002  200  201 W PenumbraHook: PRIVATE_IGNORED_DETAIL",
    ].join("\n"),
    boundary,
  );
  assert.deepEqual(quiet, {
    freshBoundaryObserved: true,
    stockLifecycleActive: false,
    narrationActive: false,
    audioFocusActive: false,
    transitionCount: 0,
    ready: true,
  });

  const busy = evaluateDispatchQuiescenceLog(
    [
      `1710000000.001  100  101 I PenumbraContinuityQuiet: ${boundary}`,
      "1710000000.002  200  201 D RunManager: Started new Run: 123e4567-e89b-42d3-a456-426614174021",
      "1710000000.003  3152  101 W PenumbraHook: Hand tracking timeout held for narration | sessionArmed=true",
      "1710000000.004  3152  101 D AudioFocusManager: CentralActionHandler audio focus granted",
    ].join("\n"),
    boundary,
  );
  assert.equal(busy.ready, false);
  assert.equal(busy.stockLifecycleActive, true);
  assert.equal(busy.narrationActive, true);
  assert.equal(busy.audioFocusActive, true);
  assert.equal(busy.transitionCount, 3);

  const released = evaluateDispatchQuiescenceLog(
    [
      `1710000000.001  100  101 I PenumbraContinuityQuiet: ${boundary}`,
      "1710000000.002  200  201 D RunManager: Started new Run: 123e4567-e89b-42d3-a456-426614174021",
      "1710000000.003  3152  101 W PenumbraHook: Hand tracking timeout held for narration | sessionArmed=true",
      "1710000000.004  3152  101 D AudioFocusManager: CentralActionHandler audio focus granted",
      "1710000000.005  3152  101 W PenumbraHook: NARRATION_END released narration hold | sessionArmed=true",
      "1710000000.006  3152  101 D AudioFocusManager: CentralActionHandler audio focus abandoned",
      `1710000000.007  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(released.ready, true);
  assert.equal(released.transitionCount, 6);
  assert.doesNotMatch(JSON.stringify(released), /PRIVATE_|123e4567/);

  assert.throws(
    () => evaluateDispatchQuiescenceLog("", boundary),
    /fresh dispatch quiescence boundary/,
  );
});

test("no-tool recall proof rejects completed tools and uncorrelated terminal traces", () => {
  const boundary =
    "continuity-smoke-123e4567-e89b-42d3-a456-426614174007";
  const runId = "123e4567-e89b-42d3-a456-426614174008";
  const otherRunId = "123e4567-e89b-42d3-a456-426614174009";
  const lifecycle = (traceLines) =>
    evaluateContinuityLifecycleLog(
      [
        `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
        `1710000000.002  4000  101 W PenumbraServer: ${STREAMING_UNDERSTAND_REQUEST_LOG} run_id=${runId}`,
        ...traceLines,
        "1710000000.006  4000  101 W PenumbraServer: INFO humane_server::services::aibus::turn::streaming: <<< BidirectionalStreamingUnderstand completed after final observation",
      ].join("\n"),
      boundary,
    );

  const withTool = lifecycle([
    `1710000000.003  4000  101 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${runId} ordinal=1 tool=knowledge_lookup status=completed result_status=ok`,
    `1710000000.004  4000  101 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${runId} ordinal=2 tool=terminal status=completed`,
  ]);
  assert.equal(withTool.agenticToolTerminalCorrelated, true);
  assert.equal(withTool.agenticCompletedToolCount, 1);
  assert.equal(withTool.agenticNoToolTerminalCorrelated, false);

  const unavailableTool = lifecycle([
    `1710000000.003  4000  101 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${runId} ordinal=1 tool=knowledge_lookup status=completed result_status=unavailable`,
    `1710000000.004  4000  101 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${runId} ordinal=2 tool=terminal status=completed`,
  ]);
  assert.equal(unavailableTool.agenticToolTerminalCorrelated, true);
  assert.equal(unavailableTool.agenticCompletedToolCount, 1);
  assert.equal(unavailableTool.agenticNoToolTerminalCorrelated, false);

  const uncorrelated = lifecycle([
    `1710000000.003  4000  101 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${otherRunId} ordinal=1 tool=terminal status=completed`,
  ]);
  assert.equal(uncorrelated.agenticNoToolTerminalCorrelated, false);
  assert.equal(uncorrelated.agenticCompletedToolCount, 0);
  assert.equal(uncorrelated.agenticNoToolTerminalCorrelated, false);
  assert.doesNotMatch(JSON.stringify(uncorrelated), /123e4567/);

  for (const malformedTrace of [
    `1710000000.003  4000  101 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${runId} ordinal=1 tool=knowledge_lookup status=completed`,
    `1710000000.003  4000  101 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${runId} ordinal=1 tool=terminal status=completed result_status=ok`,
    `1710000000.003  4000  101 W PenumbraServer: INFO humane_server::synapse::authority::runtime: <<< Agentic physical proof trace correlation=${runId} ordinal=1 tool=knowledge_lookup status=completed result_status=private_detail`,
  ]) {
    assert.throws(
      () => lifecycle([malformedTrace]),
      /continuity trace event was malformed/,
    );
  }
});

test("only the exact content-free hook marker is accepted as reset evidence", () => {
  const boundary =
    "continuity-smoke-123e4567-e89b-42d3-a456-426614174010";
  const runId = "123e4567-e89b-42d3-a456-426614174011";
  const base = [
    `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
    `1710000000.002  200  201 D RunManager: Started new Run: ${runId}`,
  ];
  const exact = evaluateContinuityLifecycleLog(
    [
      ...base,
      "1710000000.003  200  201 W PenumbraHook: Authorized exact context-reset action",
      `1710000000.004  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(exact.exactResetMarkerObserved, true);
  assert.equal(exact.exactResetMarkerCount, 1);

  const malformed = evaluateContinuityLifecycleLog(
    [
      ...base,
      "1710000000.003  200  201 W PenumbraHook: Authorized exact context-reset action private",
      `1710000000.004  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(malformed.exactResetMarkerObserved, false);
});

test("turn reduction ignores all pre-boundary and unrelated activity", () => {
  const rows = [
    row(1, "ordinary_follow_up", FIXED_CONTINUITY_PHRASE, "old-run"),
    {
      id: 3,
      runId: "unrelated-run",
      prompt: "PRIVATE_UNRELATED_PROMPT",
      response: `PRIVATE_UNRELATED_RESPONSE ${FIXED_CONTINUITY_PHRASE}`,
    },
    row(4, "ordinary_follow_up", "unknown", "owned-run"),
  ];
  const reduced = reduceContinuityTurnActivity("ordinary_follow_up", rows, 2);
  assert.deepEqual(reduced, {
    complete: true,
    unambiguous: true,
    terminalObserved: true,
    phraseObserved: false,
    artistObserved: false,
    albumObserved: false,
    rememberedAcknowledgementObserved: false,
    continuingAcknowledgementObserved: false,
    unknownObserved: true,
    clearContextActionObserved: false,
    correlationRunId: "owned-run",
    ownedIds: [4],
    nextCursor: 4,
  });
});

test("phrase evidence tolerates punctuation and case but not separated guesses", () => {
  const present = reduceContinuityTurnActivity(
    "ordinary_follow_up",
    [row(2, "ordinary_follow_up", "VIOLET, cedar—seven.", "owned-run")],
    1,
  );
  assert.equal(present.phraseObserved, true);
  assert.equal(present.terminalObserved, true);

  const absent = reduceContinuityTurnActivity(
    "post_reset_follow_up",
    [row(2, "post_reset_follow_up", "I remember violet and seven, but not the phrase.", "owned-run")],
    1,
  );
  assert.equal(absent.phraseObserved, false);
  assert.equal(absent.terminalObserved, true);
  assert.equal(absent.unknownObserved, false);

  const embedded = reduceContinuityTurnActivity(
    "post_reset_follow_up",
    [
      row(
        2,
        "post_reset_follow_up",
        "ultraviolet cedar sevenfold",
        "owned-run",
      ),
    ],
    1,
  );
  assert.equal(embedded.phraseObserved, false);
});

test("only the exact stock clear action counts as reset evidence", () => {
  const exact = reduceContinuityTurnActivity(
    "exact_reset",
    [row(2, "exact_reset", "Action: ClearUnderstandingContext", "owned-run")],
    1,
  );
  assert.equal(exact.clearContextActionObserved, true);
  assert.equal(exact.complete, true);
  assert.equal(exact.terminalObserved, false);

  for (const response of [
    "ClearUnderstandingContext",
    "Action: clearunderstandingcontext",
    "Action: ClearUnderstandingContext {}",
    "I cleared the context.",
  ]) {
    const reduced = reduceContinuityTurnActivity(
      "exact_reset",
      [row(2, "exact_reset", response, "owned-run")],
      1,
    );
    assert.equal(reduced.clearContextActionObserved, false, response);
  }
});

test("multiple post-boundary run keys fail attribution without claiming row ownership", () => {
  const reduced = reduceContinuityTurnActivity(
    "ordinary_follow_up",
    [
      row(2, "ordinary_follow_up", FIXED_CONTINUITY_PHRASE, "run-a"),
      row(3, "ordinary_follow_up", FIXED_CONTINUITY_PHRASE, "run-b"),
    ],
    1,
  );
  assert.equal(reduced.complete, true);
  assert.equal(reduced.unambiguous, false);
  assert.deepEqual(reduced.ownedIds, []);
  assert.equal(reduced.phraseObserved, false);
});

test("candidate identity requires package, version name, code, and Android signer", () => {
  assert.deepEqual(evaluateCandidateIdentity(identity(), EXPECTED), {
    package_exact: true,
    version_name_exact: true,
    version_code_exact: true,
    signer_identity_exact: true,
    pass: true,
  });
  for (const actual of [
    identity({ packageName: "other.package" }),
    identity({ versionName: "2026-07-17.98-local" }),
    identity({ versionCode: EXPECTED.versionCode + 1 }),
    identity({ signerIdentity: "deadbeef" }),
  ]) {
    assert.equal(evaluateCandidateIdentity(actual, EXPECTED).pass, false);
  }
});

test("complete stock sequence passes and deletes only attributed harness rows", async () => {
  const unrelated = {
    id: 10,
    runId: "PRIVATE_SESSION_IDENTIFIER",
    prompt: "PRIVATE_UNRELATED_PROMPT",
    response: "PRIVATE_UNRELATED_RESPONSE",
  };
  const device = new FakeDevice({
    initialRows: [unrelated],
    lifecyclePollsBeforeFinal: { ordinary_follow_up: 2 },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );

  assert.equal(report.status, "pass");
  assert.ok(Object.values(report.evidence).every((value) => value === true));
  assert.equal(report.cleanup.owned_activity_removed, true);
  assert.equal(report.cleanup.non_owned_delete_attempted, false);
  assert.equal(report.cleanup.media_volume_snapshot_captured, true);
  assert.equal(report.cleanup.media_volume_restored, true);
  assert.deepEqual(device.injected, SESSION_CONTINUITY_TURNS.map((turn) => turn.id));
  assert.deepEqual(device.deleted, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  assert.deepEqual(device.rows, [unrelated]);
  assert.equal(device.lifecyclePolls.get("ordinary_follow_up"), 3);
  assert.equal(device.quiescenceBoundaryCount, SESSION_CONTINUITY_TURNS.length - 1);
  assert.ok(
    SESSION_CONTINUITY_TURNS.slice(0, -1).every(
      (turn) => (device.quiescencePolls.get(turn.id) ?? 0) >= 3,
    ),
  );
  assert.ok(
    SESSION_CONTINUITY_TURNS.every((turn) =>
      device.completedLifecycleTurns.has(turn.id),
    ),
  );

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /violet|cedar|seven/i);
  assert.doesNotMatch(serialized, /PRIVATE_/);
  assert.doesNotMatch(serialized, /public-run-/);
  assert.doesNotMatch(serialized, /reset session/i);
  assert.doesNotMatch(serialized, /ClearUnderstandingContext/);
});

test("a new stock transition resets the bounded pre-dispatch quiet interval", async () => {
  const device = new FakeDevice({
    quiescenceBusyPollsBeforeRelease: { seed: 2 },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  assert.ok((device.quiescencePolls.get("seed") ?? 0) >= 5);
  assert.equal(
    report.evidence.all_pre_dispatch_quiescence_gates_completed,
    true,
  );
  assert.deepEqual(report.timeouts, {
    pre_dispatch_quiescence: false,
    turn_completion: false,
    cleanup: false,
  });
});

test("sanitized timeout evidence distinguishes pre-dispatch quiescence from turn completion", async () => {
  const quiescenceDevice = new FakeDevice({
    quiescenceNeverReadyAfterTurns: ["seed"],
  });
  const quiescenceReport = await executeSessionContinuitySuite(
    options(),
    liveDependencies(quiescenceDevice),
  );
  assert.equal(quiescenceReport.status, "incomplete");
  assert.deepEqual(quiescenceReport.timeouts, {
    pre_dispatch_quiescence: true,
    turn_completion: false,
    cleanup: false,
  });
  assert.deepEqual(quiescenceDevice.injected, ["seed"]);
  const quiescenceHuman = renderSessionContinuityReport(quiescenceReport);
  assert.match(quiescenceHuman, /pre-dispatch quiescence timeout: yes/);
  assert.match(
    quiescenceHuman,
    /post-dispatch Server\/model completion timeout: no/,
  );

  const turnDevice = new FakeDevice({ missingFinalTurns: ["seed"] });
  const turnReport = await executeSessionContinuitySuite(
    options(),
    liveDependencies(turnDevice),
  );
  assert.equal(turnReport.status, "incomplete");
  assert.deepEqual(turnReport.timeouts, {
    pre_dispatch_quiescence: false,
    turn_completion: true,
    cleanup: false,
  });
  assert.deepEqual(turnDevice.injected, ["seed"]);
  const turnHuman = renderSessionContinuityReport(turnReport);
  assert.match(turnHuman, /pre-dispatch quiescence timeout: no/);
  assert.match(
    turnHuman,
    /post-dispatch Server\/model completion timeout: yes/,
  );

  for (const report of [quiescenceReport, turnReport]) {
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /PRIVATE_|violet|cedar|seven|123e4567/i);
  }
});

test("volume mutation is restored only after every owned activity cleanup", async () => {
  const device = new FakeDevice({
    mutateVolumeOnTurn: "ordinary_follow_up",
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  assert.deepEqual(device.mediaVolumeState, {
    index: 7,
    minimum: 0,
    maximum: 15,
    muted: false,
  });
  assert.equal(device.cleanupOrder.at(-1), "volume_restore");
  assert.ok(
    device.cleanupOrder
      .slice(0, -1)
      .every((event) => event.startsWith("activity_cleanup:")),
  );
});

test("a failed volume restore fails the suite without leaking diagnostics", async () => {
  const device = new FakeDevice({
    mutateVolumeOnTurn: "ordinary_follow_up",
    volumeRestoreMismatch: true,
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.cleanup.owned_activity_removed, true);
  assert.equal(report.cleanup.media_volume_restored, false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|volume.*(?:6|7)/i);
});

test("every reset near-miss fails closed if it produces a clear action", async () => {
  for (const turnId of [
    "near_miss_reset",
    "near_miss_polite_reset",
    "near_miss_punctuated_reset",
  ]) {
    const device = new FakeDevice({
      responses: { [turnId]: "Action: ClearUnderstandingContext" },
    });
    const report = await executeSessionContinuitySuite(
      options(),
      liveDependencies(device),
    );
    assert.equal(report.status, "incomplete", turnId);
    assert.equal(report.evidence.near_miss_completed, false, turnId);
    assert.equal(report.evidence.near_miss_clear_action_absent, false, turnId);
    assert.equal(report.evidence.phrase_survived_near_miss, false, turnId);
  }
});

test("every reset near-miss fails closed if it produces the exact-reset hook marker", async () => {
  for (const turnId of [
    "near_miss_reset",
    "near_miss_polite_reset",
    "near_miss_punctuated_reset",
  ]) {
    const device = new FakeDevice({
      unexpectedExactResetMarkerTurns: [turnId],
    });
    const report = await executeSessionContinuitySuite(
      options(),
      liveDependencies(device),
    );
    assert.equal(report.status, "incomplete", turnId);
    assert.equal(report.evidence.near_miss_completed, false, turnId);
    assert.equal(report.evidence.near_miss_clear_action_absent, false, turnId);
    assert.equal(device.completedLifecycleTurns.has(turnId), true, turnId);
  }
});

test("a recalled phrase is not accepted as a no-tool recall if a tool completed", async () => {
  const device = new FakeDevice({
    agenticToolCounts: { ordinary_follow_up: 1 },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.phrase_survived_ordinary_follow_up, true);
  assert.equal(report.evidence.bounded_prior_fact_recalled_without_tool, false);
});

test("a recalled phrase requires its correlated agentic terminal trace", async () => {
  const device = new FakeDevice({
    missingAgenticTerminalTurns: ["ordinary_follow_up"],
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.phrase_survived_ordinary_follow_up, true);
  assert.equal(report.evidence.bounded_prior_fact_recalled_without_tool, false);
});

test("ordinary context preservation requires the fixed interstitial acknowledgement", async () => {
  const device = new FakeDevice({
    responses: { ordinary_interstitial: "okay" },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.ordinary_interstitial_completed, true);
  assert.equal(report.evidence.ordinary_interstitial_acknowledged, false);
  assert.equal(report.evidence.phrase_survived_ordinary_follow_up, true);
  assert.equal(report.evidence.ordinary_follow_up_preserved_context, false);
});

test("lost ordinary context and surviving post-reset context each fail independently", async () => {
  const device = new FakeDevice({
    responses: {
      ordinary_follow_up: "unknown",
      post_reset_follow_up: FIXED_CONTINUITY_PHRASE,
    },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.phrase_survived_ordinary_follow_up, false);
  assert.equal(report.evidence.phrase_absent_after_exact_reset, false);
  assert.equal(report.evidence.exact_reset_action_observed, true);
});

test("exact reset requires its hook marker rather than a Center action row", async () => {
  const device = new FakeDevice({ missingExactResetMarker: true });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.sequence_completed, false);
  assert.equal(report.evidence.exact_reset_turn_completed, false);
  assert.equal(report.evidence.exact_reset_action_observed, false);
  assert.deepEqual(
    device.injected,
    SESSION_CONTINUITY_TURNS.slice(0, 13).map((turn) => turn.id),
  );
});

test("an optional exact-reset Center row is correlated and cleaned but not required", async () => {
  const device = new FakeDevice({ omitActivityTurns: [] });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  assert.equal(report.evidence.exact_reset_action_observed, true);
  assert.deepEqual(device.deleted, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
});

test("seed acknowledgement and post-reset unknown response are required", async () => {
  const device = new FakeDevice({
    responses: {
      seed: "I could not do that.",
      post_reset_follow_up: "I could not complete that request.",
    },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.seed_completed, true);
  assert.equal(report.evidence.seed_acknowledged, false);
  assert.equal(report.evidence.post_reset_follow_up_completed, true);
  assert.equal(report.evidence.post_reset_unknown_observed, false);
  assert.equal(report.evidence.phrase_absent_after_exact_reset, false);
});

test("cleanup failure is incomplete and never leaks the failure text", async () => {
  const device = new FakeDevice({ failDeleteId: 3 });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.cleanup.owned_activity_removed, false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_DELETE_FAILURE/);
});

test("ambiguous fixture activity is not deleted or reported as evidence", async () => {
  const duplicate = row(
    0,
    "ordinary_follow_up",
    FIXED_CONTINUITY_PHRASE,
    "concurrent-run",
  );
  const device = new FakeDevice({
    extraRows: { ordinary_follow_up: [duplicate] },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.activity_attribution_unambiguous, false);
  assert.deepEqual(device.deleted, [1, 2]);
  assert.ok(device.rows.some((item) => item.runId === "concurrent-run"));
  assert.doesNotMatch(JSON.stringify(report), /concurrent-run/);
});

test("identity mismatch blocks before token or activity access", async () => {
  let tokenRead = false;
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(options(), {
    loadExpectedServerIdentity: async () => EXPECTED,
    identity: identity({ signerIdentity: "deadbeef" }),
    readToken: async () => {
      tokenRead = true;
      return "should-not-run";
    },
    device,
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.prerequisites.candidate_identity_exact, false);
  assert.equal(tokenRead, false);
  assert.deepEqual(device.injected, []);
  assert.deepEqual(device.deleted, []);
  assert.equal(report.cleanup.cleanup_attempted, false);
});

test("suite execution independently refuses a non-Pin serial or unverified release", async () => {
  const device = new FakeDevice();
  await assert.rejects(
    executeSessionContinuitySuite(
      { ...options(), serial: OTHER_SERIAL },
      liveDependencies(device),
    ),
    /non-confirmed physical device/,
  );
  await assert.rejects(
    executeSessionContinuitySuite(
      options(),
      liveDependencies(device, {
        loadExpectedServerIdentity: async () => {
          throw new Error("unverified release metadata");
        },
      }),
    ),
    /verified release metadata/,
  );
  assert.deepEqual(device.injected, []);
});

test("JSON and human reports contain reduced evidence only", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const device = new FakeDevice({
    initialRows: [
      {
        id: 50,
        runId: "PRIVATE_SESSION_IDENTIFIER",
        prompt: "PRIVATE_PROMPT",
        response: "PRIVATE_RESPONSE",
      },
    ],
  });
  const exitCode = await main([...liveArgs(), "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      verifyDevice: async () => {},
      ...liveDependencies(device),
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  const parsed = JSON.parse(stdout.text());
  assert.equal(parsed.status, "pass");
  assert.doesNotMatch(stdout.text(), /PRIVATE_|violet|cedar|seven|public-run-/i);
  assert.doesNotMatch(stdout.text(), /ClearUnderstandingContext|reset session/i);

  const human = renderSessionContinuityReport(parsed);
  assert.match(human, /physical acceptance \(full\): PASS/);
  assert.doesNotMatch(human, /PRIVATE_|violet|cedar|seven|ClearUnderstandingContext/i);
});

test("self-check is host-only and emits no fixture content", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  let deviceTouched = false;
  const exitCode = await main(["--self-check", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      verifyDevice: async () => {
        deviceTouched = true;
      },
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(deviceTouched, false);
  assert.equal(stderr.text(), "");
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.doesNotMatch(stdout.text(), /violet|cedar|seven|reset session/i);
  const human = renderSessionContinuityReport(report);
  assert.match(human, /host self-check: PASS/);
  assert.match(human, /physical device contacted: no/);
  assert.doesNotMatch(human, /candidate identity exact|owned activity removed/);
});

test("parse and device failures are sanitized before output", async () => {
  const parseStdout = memoryWriter();
  const parseStderr = memoryWriter();
  let dependencyTouched = false;
  const parseExit = await main([...liveArgs(), "--prompt", "PRIVATE_CALLER_PROMPT"], {
    stdout: parseStdout.stream,
    stderr: parseStderr.stream,
    dependencies: {
      verifyDevice: async () => {
        dependencyTouched = true;
      },
    },
  });
  assert.equal(parseExit, 2);
  assert.equal(dependencyTouched, false);
  assert.doesNotMatch(parseStderr.text(), /PRIVATE_CALLER_PROMPT/);

  const runStdout = memoryWriter();
  const runStderr = memoryWriter();
  const runExit = await main(liveArgs(), {
    stdout: runStdout.stream,
    stderr: runStderr.stream,
    dependencies: {
      loadExpectedServerIdentity: async () => EXPECTED,
      verifyDevice: async () => {
        throw new Error("PRIVATE_ADB_DIAGNOSTIC");
      },
    },
  });
  assert.equal(runExit, 1);
  assert.equal(runStdout.text(), "");
  assert.doesNotMatch(runStderr.text(), /PRIVATE_ADB_DIAGNOSTIC/);
  assert.match(runStderr.text(), /failed safely/);
});

test("contextual artist query preserves music context from seed", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  assert.equal(report.evidence.contextual_artist_query_completed, true);
  assert.equal(report.evidence.contextual_artist_recalled, true);
  assert.equal(report.evidence.contextual_album_query_completed, true);
  assert.equal(report.evidence.contextual_album_recalled, true);
  assert.equal(report.evidence.contextual_music_preserved_context, true);
});

test("contextual artist recall fails when artist is not observed", async () => {
  const device = new FakeDevice({
    responses: { contextual_artist_query: "I don't remember any artist." },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.contextual_artist_query_completed, true);
  assert.equal(report.evidence.contextual_artist_recalled, false);
});

test("contextual album recall fails when album is not observed", async () => {
  const device = new FakeDevice({
    responses: { contextual_album_query: "I don't remember any album." },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.contextual_album_query_completed, true);
  assert.equal(report.evidence.contextual_album_recalled, false);
});

test("quoted reset is rejected as a near-miss and preserves context", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  const quotedReduce = reduceContinuityTurnActivity(
    "near_miss_quoted_reset",
    [row(10, "near_miss_quoted_reset", device.responses.near_miss_quoted_reset, "run-10")],
    9,
  );
  assert.equal(quotedReduce.clearContextActionObserved, false);
  assert.equal(quotedReduce.terminalObserved, true);
  assert.equal(report.evidence.reset_near_misses_preserved_context, true);
});

test("compound reset is rejected as a near-miss and preserves context", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  const compoundReduce = reduceContinuityTurnActivity(
    "near_miss_compound_reset",
    [row(11, "near_miss_compound_reset", device.responses.near_miss_compound_reset, "run-11")],
    10,
  );
  assert.equal(compoundReduce.clearContextActionObserved, false);
  assert.equal(compoundReduce.terminalObserved, true);
  assert.equal(report.evidence.reset_near_misses_preserved_context, true);
});

test("every near-miss variant fails closed if it produces a clear action", async () => {
  for (const nearMissTurnId of [
    "near_miss_reset",
    "near_miss_polite_reset",
    "near_miss_punctuated_reset",
    "near_miss_quoted_reset",
    "near_miss_compound_reset",
  ]) {
    const device = new FakeDevice({
      responses: { [nearMissTurnId]: "Action: ClearUnderstandingContext" },
    });
    const report = await executeSessionContinuitySuite(
      options(),
      liveDependencies(device),
    );
    assert.equal(
      report.status,
      "incomplete",
      `${nearMissTurnId} producing clear action should fail`,
    );
    assert.equal(report.evidence.near_miss_clear_action_absent, false);
  }
});

test("every near-miss variant fails closed if it produces the exact-reset hook marker", async () => {
  for (const nearMissTurnId of [
    "near_miss_reset",
    "near_miss_polite_reset",
    "near_miss_punctuated_reset",
    "near_miss_quoted_reset",
    "near_miss_compound_reset",
  ]) {
    const device = new FakeDevice({
      unexpectedExactResetMarkerTurns: [nearMissTurnId],
    });
    const report = await executeSessionContinuitySuite(
      options(),
      liveDependencies(device),
    );
    assert.equal(
      report.status,
      "incomplete",
      `${nearMissTurnId} producing exact-reset hook marker should fail`,
    );
  }
});

test("privacy boundary: lock screen state does not leak session identifiers", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const device = new FakeDevice({
    initialRows: [
      {
        id: 99,
        runId: "LOCKED_SESSION_IDENTIFIER",
        prompt: "LOCKED_PROMPT",
        response: "LOCKED_RESPONSE",
      },
    ],
  });
  const exitCode = await main([...liveArgs(), "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      verifyDevice: async () => {},
      ...liveDependencies(device),
    },
  });
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout.text());
  assert.equal(parsed.status, "pass");
  assert.doesNotMatch(stdout.text(), /LOCKED_SESSION_IDENTIFIER|LOCKED_PROMPT|LOCKED_RESPONSE/i);
  assert.equal(parsed.privacy.session_identifiers_emitted, false);
  assert.equal(parsed.privacy.raw_activity_emitted, false);
  assert.equal(parsed.privacy.raw_logcat_emitted, false);
});

test("privacy boundary: admin token is never emitted in reports", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const device = new FakeDevice();
  const exitCode = await main([...liveArgs(), "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      verifyDevice: async () => {},
      ...liveDependencies(device),
      token: async () => "SUPER_SECRET_ADMIN_TOKEN_12345",
    },
  });
  assert.equal(exitCode, 0);
  assert.doesNotMatch(stdout.text(), /SUPER_SECRET_ADMIN_TOKEN/);
  assert.doesNotMatch(stderr.text(), /SUPER_SECRET_ADMIN_TOKEN/);
});

test("bounded cleanup: only owned harness rows are deleted", async () => {
  const preExistingRow = {
    id: 5,
    runId: "pre-existing-run",
    prompt: "user prompt before test",
    response: "user response before test",
  };
  const device = new FakeDevice({ initialRows: [preExistingRow] });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  assert.equal(report.cleanup.owned_activity_removed, true);
  assert.equal(report.cleanup.non_owned_delete_attempted, false);
  assert.ok(device.rows.some((row) => row.id === 5));
  assert.ok(!device.deleted.includes(5));
});

test("bounded cleanup: delete attempts are bounded to positive integer IDs", async () => {
  const device = new FakeDevice();
  await executeSessionContinuitySuite(options(), liveDependencies(device));
  for (const id of device.deleted) {
    assert.ok(Number.isSafeInteger(id));
    assert.ok(id > 0);
  }
});

test("bounded cleanup: non-owned fixture prompts are not deleted even when present", async () => {
  const concurrentRow = {
    id: 999,
    runId: "concurrent-run",
    prompt: TURN_BY_ID.get("ordinary_follow_up").prompt,
    response: "concurrent response",
  };
  const device = new FakeDevice({
    extraRows: { ordinary_follow_up: [concurrentRow] },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.activity_attribution_unambiguous, false);
  assert.ok(device.rows.some((row) => row.runId === "concurrent-run"));
  assert.ok(!device.deleted.includes(999));
});

test("privacy-safe evidence: all evidence fields are booleans or counts", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  for (const [key, value] of Object.entries(report.evidence)) {
    assert.ok(
      typeof value === "boolean",
      `evidence field ${key} should be boolean, got ${typeof value}`,
    );
  }
  for (const [key, value] of Object.entries(report.cleanup)) {
    assert.ok(
      typeof value === "boolean" || value === null || typeof value === "number",
      `cleanup field ${key} should be boolean, null, or number`,
    );
  }
  for (const [key, value] of Object.entries(report.privacy)) {
    assert.ok(
      typeof value === "boolean",
      `privacy field ${key} should be boolean`,
    );
  }
});

test("privacy-safe evidence: run IDs are never included in final report", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  const reportString = JSON.stringify(report);
  assert.doesNotMatch(reportString, /123e4567-e89b-42d3-a456-[0-9a-f]{12}/);
  assert.doesNotMatch(reportString, /public-run-[0-9]+/);
});

test("exact standalone reset: only the exact phrase triggers context clear", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  assert.equal(report.evidence.exact_reset_action_observed, true);
  assert.equal(report.evidence.exact_reset_cleared_context, true);
  assert.equal(report.evidence.post_reset_unknown_observed, true);
  assert.equal(report.evidence.phrase_absent_after_exact_reset, true);
});

test("post-reset non-recall: phrase is not accessible after exact reset", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  assert.equal(report.evidence.fresh_query_could_not_recall_prior_fact, true);
  const postResetReduce = reduceContinuityTurnActivity(
    "post_reset_follow_up",
    [row(13, "post_reset_follow_up", "unknown", "run-13")],
    12,
  );
  assert.equal(postResetReduce.unknownObserved, true);
  assert.equal(postResetReduce.phraseObserved, false);
});

test("artist and album detection tolerates case and punctuation", () => {
  const artistCase = reduceContinuityTurnActivity(
    "contextual_artist_query",
    [row(1, "contextual_artist_query", "SOLARA!", "run-1")],
    0,
  );
  assert.equal(artistCase.artistObserved, true);

  const albumPunct = reduceContinuityTurnActivity(
    "contextual_album_query",
    [row(2, "contextual_album_query", "Moonrise.", "run-2")],
    1,
  );
  assert.equal(albumPunct.albumObserved, true);
});

test("artist detection rejects partial matches", () => {
  const partial = reduceContinuityTurnActivity(
    "contextual_artist_query",
    [row(1, "contextual_artist_query", "solar", "run-1")],
    0,
  );
  assert.equal(partial.artistObserved, false);

  const embedded = reduceContinuityTurnActivity(
    "contextual_artist_query",
    [row(1, "contextual_artist_query", "solarium", "run-1")],
    0,
  );
  assert.equal(embedded.artistObserved, false);
});

test("album detection rejects partial matches", () => {
  const partial = reduceContinuityTurnActivity(
    "contextual_album_query",
    [row(1, "contextual_album_query", "moon", "run-1")],
    0,
  );
  assert.equal(partial.albumObserved, false);

  const different = reduceContinuityTurnActivity(
    "contextual_album_query",
    [row(1, "contextual_album_query", "sunset", "run-1")],
    0,
  );
  assert.equal(different.albumObserved, false);
});

// --- Adversarial tests for Q2-02 ---

test("phase selector: --phase accepts only fixed allowlisted phases", () => {
  for (const phase of ["seed", "ordinary", "contextual", "near_miss", "exact_reset", "full"]) {
    const parsed = parseSessionContinuityCliArgs([...liveArgs(), "--phase", phase]);
    assert.equal(parsed.phase, phase);
  }
  assert.throws(
    () => parseSessionContinuityCliArgs([...liveArgs(), "--phase", "unknown"]),
    /unknown fixed continuity phase/,
  );
  assert.throws(
    () => parseSessionContinuityCliArgs([...liveArgs(), "--phase", "reset session"]),
    /unknown fixed continuity phase/,
  );
  assert.throws(
    () => parseSessionContinuityCliArgs(["--self-check", "--phase", "seed"]),
    /does not accept live-device options/,
  );
});

test("phase selector: --phase cannot be provided twice", () => {
  assert.throws(
    () => parseSessionContinuityCliArgs([...liveArgs(), "--phase", "seed", "--phase", "full"]),
    /provided once/,
  );
});

test("phase selector: negated reset is included in the near_miss phase and full phase", () => {
  const nearMissPhase = CONTINUITY_PHASES.get("near_miss");
  assert.ok(nearMissPhase.includes("near_miss_negated_reset"));
  const fullPhase = CONTINUITY_PHASES.get("full");
  assert.ok(fullPhase.includes("near_miss_negated_reset"));
});

test("wrong-PID reset markers cannot prove clearing", () => {
  const boundary = "continuity-smoke-123e4567-e89b-42d3-a456-426614174030";
  const runId = "123e4567-e89b-42d3-a456-426614174031";
  const evidence = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      `1710000000.002  200  201 D RunManager: Started new Run: ${runId}`,
      "1710000000.003  999  999 W PenumbraHook: Authorized exact context-reset action",
      `1710000000.004  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(evidence.correlatedResetAuthorization, false);
  assert.equal(evidence.correlatedResetAuthorizationCount, 0);
  assert.equal(evidence.wrongPidResetMarkerCount, 1);
  assert.equal(evidence.exactResetMarkerObserved, false);
});

test("before-request reset markers cannot prove clearing", () => {
  const boundary = "continuity-smoke-123e4567-e89b-42d3-a456-426614174040";
  const runId = "123e4567-e89b-42d3-a456-426614174041";
  const evidence = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      "1710000000.002  200  201 W PenumbraHook: Authorized exact context-reset action",
      `1710000000.003  200  201 D RunManager: Started new Run: ${runId}`,
      `1710000000.004  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(evidence.correlatedResetAuthorization, false);
  assert.equal(evidence.beforeRequestResetMarkerCount, 1);
  assert.equal(evidence.exactResetMarkerObserved, false);
});

test("after-final reset markers cannot prove clearing", () => {
  const boundary = "continuity-smoke-123e4567-e89b-42d3-a456-426614174050";
  const runId = "123e4567-e89b-42d3-a456-426614174051";
  const evidence = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      `1710000000.002  200  201 D RunManager: Started new Run: ${runId}`,
      `1710000000.003  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
      "1710000000.004  200  201 W PenumbraHook: Authorized exact context-reset action",
    ].join("\n"),
    boundary,
  );
  assert.equal(evidence.correlatedResetAuthorization, false);
  assert.equal(evidence.afterFinalResetMarkerCount, 1);
  assert.equal(evidence.exactResetMarkerObserved, false);
});

test("duplicate correlated reset markers cannot prove clearing", () => {
  const boundary = "continuity-smoke-123e4567-e89b-42d3-a456-426614174060";
  const runId = "123e4567-e89b-42d3-a456-426614174061";
  const evidence = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      `1710000000.002  200  201 D RunManager: Started new Run: ${runId}`,
      "1710000000.003  200  201 W PenumbraHook: Authorized exact context-reset action",
      "1710000000.004  200  201 W PenumbraHook: Authorized exact context-reset action",
      `1710000000.005  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(evidence.correlatedResetAuthorization, false);
  assert.equal(evidence.correlatedResetAuthorizationCount, 2);
  assert.equal(evidence.exactResetMarkerObserved, false);
});

test("authorization-only marker without request or final cannot prove clearing", () => {
  const boundary = "continuity-smoke-123e4567-e89b-42d3-a456-426614174070";
  const evidence = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      "1710000000.002  200  201 W PenumbraHook: Authorized exact context-reset action",
    ].join("\n"),
    boundary,
  );
  assert.equal(evidence.requestObserved, false);
  assert.equal(evidence.stockFinalObserved, false);
  assert.equal(evidence.requestFinalCorrelated, false);
  assert.equal(evidence.correlatedResetAuthorization, false);
});

test("pre-boundary focus held seeds quiescence as busy", () => {
  const boundary = "continuity-quiet-123e4567-e89b-42d3-a456-426614174080";
  const held = evaluateDispatchQuiescenceLog(
    [
      "1710000000.000  300  301 D AudioFocusManager: CentralActionHandler audio focus granted",
      `1710000000.001  100  101 I PenumbraContinuityQuiet: ${boundary}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(held.audioFocusActive, true);
  assert.equal(held.ready, false);

  const released = evaluateDispatchQuiescenceLog(
    [
      "1710000000.000  300  301 D AudioFocusManager: CentralActionHandler audio focus granted",
      `1710000000.001  100  101 I PenumbraContinuityQuiet: ${boundary}`,
      "1710000000.002  300  301 D AudioFocusManager: CentralActionHandler audio focus abandoned",
    ].join("\n"),
    boundary,
  );
  assert.equal(released.audioFocusActive, false);
  assert.equal(released.ready, true);
});

test("pre-boundary narration held seeds quiescence as busy", () => {
  const boundary = "continuity-quiet-123e4567-e89b-42d3-a456-426614174081";
  const held = evaluateDispatchQuiescenceLog(
    [
      "1710000000.000  300  301 W PenumbraHook: NARRATION_START ignored because no active hand tracking session | tag=test",
      `1710000000.001  100  101 I PenumbraContinuityQuiet: ${boundary}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(held.narrationActive, true);
  assert.equal(held.ready, false);
});

test("cleanup timeout reports incomplete rather than falsely claiming success", async () => {
  let now = 0;
  const device = new FakeDevice();
  const deps = {
    loadExpectedServerIdentity: async () => EXPECTED,
    identity: identity(),
    token: "public-fixture-token",
    device,
    now: () => now,
    delay: async (ms) => { now += ms; },
  };
  const report = await executeSessionContinuitySuite(options(), deps);
  assert.equal(report.status, "pass");
  assert.equal(report.cleanup.cleanup_timed_out, false);
  assert.equal(report.cleanup.owned_activity_removed, true);
});

test("negated near-miss never clears context", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "pass");
  const negatedReduce = reduceContinuityTurnActivity(
    "near_miss_negated_reset",
    [row(10, "near_miss_negated_reset", device.responses.near_miss_negated_reset, "run-10")],
    9,
  );
  assert.equal(negatedReduce.clearContextActionObserved, false);
  assert.equal(negatedReduce.terminalObserved, true);
  assert.equal(report.evidence.reset_near_misses_preserved_context, true);
});

test("negated near-miss fails closed if it produces a clear action", async () => {
  const device = new FakeDevice({
    responses: { near_miss_negated_reset: "Action: ClearUnderstandingContext" },
  });
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.near_miss_clear_action_absent, false);
});

test("phase seed: only seed turn is injected and reported", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    parseSessionContinuityCliArgs([...liveArgs(), "--phase", "seed"]),
    liveDependencies(device),
  );
  assert.equal(report.phase, "seed");
  assert.deepEqual(device.injected, ["seed"]);
  assert.equal(report.evidence.seed_completed, true);
  assert.equal(report.evidence.seed_acknowledged, true);
});

test("phase exact_reset: only seed, interstitial, exact_reset, and post_reset are injected", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    parseSessionContinuityCliArgs([...liveArgs(), "--phase", "exact_reset"]),
    liveDependencies(device),
  );
  assert.equal(report.phase, "exact_reset");
  assert.deepEqual(device.injected, ["seed", "ordinary_interstitial", "exact_reset", "post_reset_follow_up"]);
  assert.equal(report.evidence.exact_reset_authorization_observed, true);
  assert.equal(report.evidence.exact_reset_completion_observed, true);
});

test("process stability is reported per lifecycle", () => {
  const boundary = "continuity-smoke-123e4567-e89b-42d3-a456-426614174090";
  const runId = "123e4567-e89b-42d3-a456-426614174091";
  const stable = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      `1710000000.002  200  201 D RunManager: Started new Run: ${runId}`,
      `1710000000.003  200  201 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(stable.processStable, true);

  const unstable = evaluateContinuityLifecycleLog(
    [
      `1710000000.001  100  101 I PenumbraContinuitySmoke: ${boundary}`,
      `1710000000.002  200  201 D RunManager: Started new Run: ${runId}`,
      `1710000000.003  999  999 D RunManager: ${STOCK_FINAL_OBSERVATION}`,
    ].join("\n"),
    boundary,
  );
  assert.equal(unstable.processStable, false);
});

test("instrumentation vs human acceptance labels are present in report", async () => {
  const device = new FakeDevice();
  const report = await executeSessionContinuitySuite(
    options(),
    liveDependencies(device),
  );
  assert.equal(report.evidence.acceptance_scope_instrumentation_only, true);
  assert.equal(report.evidence.acceptance_scope_human_microphone_required, true);
  assert.equal(report.evidence.acceptance_scope_human_projector_required, true);
  assert.equal(report.evidence.acceptance_scope_human_audibility_required, true);
});
