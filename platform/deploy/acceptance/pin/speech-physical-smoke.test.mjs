import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTALLED_SERVER_SIGNER_IDENTITY,
  SERVER_PACKAGE_NAME,
} from "./agentic-release-smoke-lib.mjs";
import { OPERATIONAL_MARKERS } from "./tier-a-symbols.mjs";

import {
  buildFixedTranscriptInjectionCommand,
  buildSpeechLogcatCommand,
  evaluateSpeechLogEvidence,
  evaluateSpeechPhysicalReadiness,
  evaluateTerminalSpeechActivity,
  executeSpeechPhysicalSmoke as executeSpeechPhysicalSmokeWithDependencies,
  main as speechMain,
  parseSpeechPhysicalCliArgs as parseSpeechPhysicalCliArgsWithEnvironment,
  parseSpeechPromptActivityPage,
} from "./speech-physical-smoke.mjs";

const SERIAL = "fixture-pin-serial";
const OTHER_SERIAL = "fixture-other-device";
const EXPECTED_IDENTITY = Object.freeze({
  releaseId: "fixture-release",
  packageName: SERVER_PACKAGE_NAME,
  versionName: "2026-08-27.1",
  versionCode: 202_608_271,
  signerIdentity: INSTALLED_SERVER_SIGNER_IDENTITY,
});
const VERSION_NAME = EXPECTED_IDENTITY.versionName;
const VERSION_CODE = EXPECTED_IDENTITY.versionCode;
const FIXED_PROMPT = "In one short sentence, explain why the sky looks blue.";
const BOUNDARY = "speech-smoke-123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "223e4567-e89b-42d3-a456-426614174000";
const STREAMING_UNDERSTAND_REQUEST_LOG =
  `INFO humane_server::services::aibus::understand: ${OPERATIONAL_MARKERS.streaming_understand_request.value}`;
const IRONMAN_PID = 3152;
const TIMEOUT_FLAG = "server_side_speech_synthesis_timeout_millis";
const STREAMING_FLAG = "server_side_speech_synthesis_streaming_enabled";
const GUARDED_MEDIA_VOLUME_STATE = Object.freeze({
  index: 7,
  minimum: 0,
  maximum: 15,
  muted: false,
});
const parseSpeechPhysicalCliArgs = (argv, environment = {}) =>
  parseSpeechPhysicalCliArgsWithEnvironment(argv, environment);
const executeSpeechPhysicalSmoke = (options, dependencies = {}) => {
  const withRelease = Object.create(
    Object.getPrototypeOf(dependencies),
    Object.getOwnPropertyDescriptors(dependencies),
  );
  Object.defineProperty(withRelease, "loadExpectedServerIdentity", {
    configurable: true,
    enumerable: true,
    value: async () => EXPECTED_IDENTITY,
  });
  return executeSpeechPhysicalSmokeWithDependencies(options, withRelease);
};
const main = (argv, dependencies = {}, stdout, stderr) =>
  speechMain(
    argv,
    {
      loadExpectedServerIdentity: async () => EXPECTED_IDENTITY,
      ...dependencies,
    },
    stdout,
    stderr,
  );
const GUARDED_MEDIA_VOLUME_DEVICE = Object.freeze({
  async readMediaVolumeState() {
    return { ...GUARDED_MEDIA_VOLUME_STATE };
  },
  async setMediaVolumeIndex(index) {
    assert.equal(index, GUARDED_MEDIA_VOLUME_STATE.index);
  },
});

function liveArgs(extra = []) {
  return [
    "--run",
    "--serial",
    SERIAL,
    "--expected-pin-serial",
    SERIAL,
    "--release-manifest",
    "/fixture/manifest.json",
    "--release-receipts",
    "/fixture/receipts.json",
    ...extra,
  ];
}

function identityFixture(overrides = {}) {
  return {
    packageName: SERVER_PACKAGE_NAME,
    versionName: VERSION_NAME,
    versionCode: VERSION_CODE,
    signerIdentity: EXPECTED_IDENTITY.signerIdentity,
    ...overrides,
  };
}

function boolFlag(key) {
  return {
    key,
    desired_value: { type: "bool", value: true },
    assignment_value: { type: "bool", value: true },
  };
}

function readinessFixture() {
  return {
    health: { status: "ok", version: VERSION_NAME },
    settings: {
      restart_required: false,
      server: { admin_token_auth: true },
      azure_speech: {
        enabled: true,
        cloud_consent_acknowledged: true,
        has_subscription_key: true,
        region: "fixture-region",
        voice_name: "fixture-voice",
      },
    },
    codex: { ready: true, state: "ready" },
    featureFlags: {
      flags: [
        {
          key: TIMEOUT_FLAG,
          desired_value: { type: "int", value: 10_000 },
          assignment_value: { type: "int", value: 10_000 },
        },
        boolFlag(STREAMING_FLAG),
        boolFlag("synapse_bidirectional_streaming"),
      ],
      delivery: {
        state: "stock_cache_applied",
        stock_cache_verified: true,
      },
    },
  };
}

function epoch(ordinal, pid, tag, message) {
  return `1710000000.${String(ordinal).padStart(3, "0")}  ${pid}  101 D ${tag}: ${message}`;
}

function remoteLines() {
  return [
    epoch(0, 100, "PenumbraSpeechSmoke", BOUNDARY),
    epoch(
      1,
      4000,
      "PenumbraServer",
      `${STREAMING_UNDERSTAND_REQUEST_LOG} run_id=${RUN_ID}`,
    ),
    epoch(
      2,
      IRONMAN_PID,
      "PenumbraHook",
      "NARRATION_START ignored because no active hand tracking session | sessionArmed=false",
    ),
    epoch(
      3,
      IRONMAN_PID,
      "AudioFocusManager",
      "CentralActionHandler audio focus granted",
    ),
    epoch(
      4,
      1619,
      "FeatureFlagServiceImpl",
      `getFlagForKey: ${TIMEOUT_FLAG}`,
    ),
    epoch(
      5,
      1619,
      "FeatureFlagServiceImpl",
      `getFlagForKey: ${STREAMING_FLAG}`,
    ),
    epoch(
      6,
      IRONMAN_PID,
      "AudioTrack",
      "stop(53): called with 51264 frames delivered",
    ),
    epoch(
      7,
      IRONMAN_PID,
      "PenumbraHook",
      "NARRATION_END ignored because no active hand tracking session | sessionArmed=false",
    ),
    epoch(
      8,
      IRONMAN_PID,
      "AudioFocusManager",
      "CentralActionHandler audio focus abandoned",
    ),
    epoch(
      9,
      4000,
      "PenumbraServer",
      "INFO humane_server::services::aibus::turn::streaming: <<< BidirectionalStreamingUnderstand completed after final observation",
    ),
  ];
}

function terminalRow(id = 2) {
  return {
    id,
    run_id: RUN_ID,
    prompt: FIXED_PROMPT,
    response: "PRIVATE_RESPONSE_MUST_NOT_ESCAPE",
    is_vision: false,
    created_at: "1710000000",
  };
}

function writer() {
  let output = "";
  return {
    stream: { write(value) { output += String(value); } },
    text() { return output; },
  };
}

test("live arguments require an operator-confirmed Pin and exact candidate identity", () => {
  assert.deepEqual(parseSpeechPhysicalCliArgs([...liveArgs(), "--json"]), {
    mode: "run",
    serial: SERIAL,
    expectedPinSerial: SERIAL,
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
    parseSpeechPhysicalCliArgs(environmentArgs, {
      PENUMBRA_EXPECTED_PIN_SERIAL: SERIAL,
    }).expectedPinSerial,
    SERIAL,
  );
  assert.throws(
    () => parseSpeechPhysicalCliArgs(liveArgs().filter((_, index) => index < 1 || index > 2)),
    /operator-confirmed Pin serial/,
  );
  const wrongSerial = liveArgs();
  wrongSerial[2] = OTHER_SERIAL;
  assert.throws(
    () => parseSpeechPhysicalCliArgs(wrongSerial),
    /operator-confirmed Pin serial/,
  );
  assert.throws(
    () => parseSpeechPhysicalCliArgs([...liveArgs(), "--prompt", "anything"]),
    /unknown command option/,
  );
  for (const removed of ["--release-manifest", "--release-receipts"]) {
    const args = liveArgs();
    const index = args.indexOf(removed);
    args.splice(index, 2);
    assert.throws(() => parseSpeechPhysicalCliArgs(args), new RegExp(removed));
  }
  for (const obsolete of [
    ["--expect-version-name", VERSION_NAME],
    ["--expect-version-code", String(VERSION_CODE)],
    ["--expect-apk-sha256", "a".repeat(64)],
  ]) {
    assert.throws(
      () => parseSpeechPhysicalCliArgs([...liveArgs(), ...obsolete]),
      /unknown command option/,
    );
  }
});

test("duplicate identity-bearing options are rejected instead of using the last value", () => {
  for (const duplicate of [
    ["--serial", SERIAL],
    ["-s", SERIAL],
    ["--expected-pin-serial", SERIAL],
    ["--release-manifest", "/fixture/manifest.json"],
    ["--release-receipts", "/fixture/receipts.json"],
  ]) {
    assert.throws(
      () => parseSpeechPhysicalCliArgs([...liveArgs(), ...duplicate]),
      /specified only once/,
      duplicate[0],
    );
  }
  assert.throws(
    () =>
      parseSpeechPhysicalCliArgs([
        ...liveArgs(),
        "--adb",
        "adb",
        "--adb",
        "adb",
      ]),
    /specified only once/,
  );
  assert.throws(
    () => parseSpeechPhysicalCliArgs(["--run", "--run", ...liveArgs().slice(1)]),
    /choose exactly one mode/,
  );
});

test("transcript injection is package-bound and contains only the fixed harmless prompt", () => {
  assert.equal(
    buildFixedTranscriptInjectionCommand(),
    `am broadcast --user 0 -a hu.ma.ne.INJECT_TRANSCRIPTION -p hu.ma.ne.ironman --es transcription ${JSON.stringify(FIXED_PROMPT)} --ez vision false`,
  );
  assert.doesNotMatch(buildFixedTranscriptInjectionCommand(), /pm install|PackageInstaller|--user-supplied/);
});

test("speech evidence reads only bounded allowlisted tags from main and system", () => {
  assert.deepEqual(buildSpeechLogcatCommand(BOUNDARY), [
    "shell",
    "logcat",
    "-b",
    "main",
    "-b",
    "system",
    "-v",
    "epoch",
    "-d",
    "PenumbraSpeechSmoke:I",
    "PenumbraHook:V",
    "PenumbraServer:V",
    "AudioFocusManager:V",
    "AudioTrack:V",
    "PenumbraTTS:V",
    "FeatureFlagServiceImpl:V",
    "*:S",
  ]);
  assert.throws(
    () => buildSpeechLogcatCommand("speech-smoke-user-controlled"),
    /speech evidence boundary was malformed/,
  );
  assert.doesNotMatch(
    JSON.stringify(buildSpeechLogcatCommand(BOUNDARY)),
    /private|transcription|response|\*:V|\ball\b/i,
  );
});

test("remote readiness requires Azure consent, complete config, exact live assignments, and identity", () => {
  const expected = EXPECTED_IDENTITY;
  const ready = evaluateSpeechPhysicalReadiness(
    readinessFixture(),
    identityFixture(),
    expected,
  );
  assert.equal(ready.pass, true);
  assert.equal(ready.azure_remote_capability_ready, true);

  const noConsent = structuredClone(readinessFixture());
  noConsent.settings.azure_speech.cloud_consent_acknowledged = false;
  assert.equal(
    evaluateSpeechPhysicalReadiness(noConsent, identityFixture(), expected).pass,
    false,
  );
  const unapplied = structuredClone(readinessFixture());
  unapplied.featureFlags.flags[1].assignment_value.value = false;
  assert.equal(
    evaluateSpeechPhysicalReadiness(unapplied, identityFixture(), expected)
      .checks.remote_speech_flags_applied,
    false,
  );
  assert.equal(
    evaluateSpeechPhysicalReadiness(
      readinessFixture(),
      identityFixture({ signerIdentity: "deadbeef" }),
      expected,
    ).checks.exact_server_identity,
    false,
  );
});

test("terminal activity accepts exactly one fresh non-action response and returns booleans only", () => {
  const page = parseSpeechPromptActivityPage({
    items: [
      terminalRow(),
      {
        id: 1,
        run_id: "older",
        prompt: "older",
        response: null,
        is_vision: false,
        created_at: "1709999999",
      },
    ],
  });
  const evidence = evaluateTerminalSpeechActivity(page, 1, RUN_ID);
  assert.deepEqual(evidence, {
    fresh_activity_observed: true,
    unique_activity_observed: true,
    request_activity_correlated: true,
    terminal_activity_observed: true,
    substantive_terminal_observed: true,
    pass: true,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_RESPONSE|223e4567/);

  assert.equal(
    evaluateTerminalSpeechActivity([terminalRow(1)], 1, RUN_ID).pass,
    false,
  );
  assert.equal(
    evaluateTerminalSpeechActivity(
      [terminalRow(2), terminalRow(3)],
      1,
      RUN_ID,
    ).pass,
    false,
  );
  assert.equal(
    evaluateTerminalSpeechActivity(
      [{ ...terminalRow(), response: "Action: Respond" }],
      1,
      RUN_ID,
    ).pass,
    false,
  );
  assert.throws(
    () => parseSpeechPromptActivityPage({ items: [{ id: -1 }] }),
    /malformed/,
  );
  assert.throws(
    () =>
      parseSpeechPromptActivityPage({
        items: [{ ...terminalRow(), is_vision: undefined }],
      }),
    /malformed/,
  );
});

test("terminal activity requires the post-boundary request run ID", () => {
  const otherRunId = "323e4567-e89b-42d3-a456-426614174000";
  const wrongOwner = evaluateTerminalSpeechActivity(
    [{ ...terminalRow(), run_id: otherRunId }],
    1,
    RUN_ID,
  );
  assert.equal(wrongOwner.fresh_activity_observed, false);
  assert.equal(wrongOwner.request_activity_correlated, false);
  assert.equal(wrongOwner.pass, false);

  assert.equal(
    evaluateTerminalSpeechActivity([terminalRow()], 1, "unknown").pass,
    false,
  );
  assert.equal(
    evaluateTerminalSpeechActivity([terminalRow()], 1, otherRunId).pass,
    false,
  );
  assert.equal(
    evaluateTerminalSpeechActivity(
      [{ ...terminalRow(), is_vision: true }],
      1,
      RUN_ID,
    ).pass,
    false,
  );
});

test("stock safe failures and generic blanket failures are not substantive speech", () => {
  const failures = [
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
    "I couldn't complete that request.",
    "I couldn't get the weather right now.",
    "I could not process your request right now.",
    "I couldn’t safely make that request.",
    "We couldn't complete your request.",
    "I was unable to complete your request.",
    "Something went wrong while handling the request.",
  ];
  for (const response of failures) {
    const evidence = evaluateTerminalSpeechActivity(
      [{ ...terminalRow(), response }],
      1,
      RUN_ID,
    );
    assert.equal(evidence.terminal_activity_observed, true, response);
    assert.equal(evidence.substantive_terminal_observed, false, response);
    assert.equal(evidence.pass, false, response);
  }
});

test("remote evidence proves ordered stock narration, Ironman frames, focus release, and final observation", () => {
  const stale = remoteLines().slice(1).map((line) => line.replace("1710000000", "1709999999"));
  const evidence = evaluateSpeechLogEvidence(
    [...stale, ...remoteLines(), epoch(9, 999, "PrivateTag", "PRIVATE_RAW_LOG")].join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  assert.deepEqual(evidence, {
    fresh_boundary_observed: true,
    assistant_request_observed: true,
    server_request_final_correlated: true,
    narration_start_observed: true,
    narration_end_observed: true,
    audio_focus_granted: true,
    audio_track_frames_observed: true,
    audio_focus_released: true,
    final_observation_observed: true,
    remote_branch_observed: true,
    local_fallback_observed: false,
    branch_ambiguous: false,
    playback_failure_observed: false,
    transcript_injection_path: true,
    microphone_asr_bypassed: true,
    tts_frames_delivered: true,
    human_audibility_confirmed: false,
    narration_lifecycle_observed: true,
    projector_not_in_path: true,
    focus_cancellation_bounded: true,
    cue_cancellation_bounded: true,
    pass: true,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_RAW_LOG|51264|3152/);
});

test("real Rust logcat indentation does not hide the correlated Server lifecycle", () => {
  const liveSpacing = remoteLines().map((line) =>
    line.includes(" PenumbraServer: INFO ")
      ? line.replace(" PenumbraServer: INFO ", " PenumbraServer:  INFO ")
      : line,
  );
  const evidence = evaluateSpeechLogEvidence(
    liveSpacing.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  assert.equal(evidence.assistant_request_observed, true);
  assert.equal(evidence.server_request_final_correlated, true);
  assert.equal(evidence.pass, true);
});

test("request and final observation must share one UUID-bearing Server lifecycle", () => {
  const unknownRequest = remoteLines();
  unknownRequest[1] = unknownRequest[1].replace(RUN_ID, "unknown");
  assert.equal(
    evaluateSpeechLogEvidence(
      unknownRequest.join("\n"),
      BOUNDARY,
      IRONMAN_PID,
    ).pass,
    false,
  );

  const otherServerFinal = remoteLines();
  otherServerFinal[9] = otherServerFinal[9].replace("  4000  ", "  4001  ");
  const wrongProcess = evaluateSpeechLogEvidence(
    otherServerFinal.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  assert.equal(wrongProcess.server_request_final_correlated, false);
  assert.equal(wrongProcess.final_observation_observed, false);
  assert.equal(wrongProcess.pass, false);

  const competingRequest = remoteLines();
  competingRequest.splice(
    2,
    0,
    epoch(
      2,
      4000,
      "PenumbraServer",
      `${STREAMING_UNDERSTAND_REQUEST_LOG} run_id=323e4567-e89b-42d3-a456-426614174000`,
    ),
  );
  assert.equal(
    evaluateSpeechLogEvidence(
      competingRequest.join("\n"),
      BOUNDARY,
      IRONMAN_PID,
    ).pass,
    false,
  );
});

test("both stock narration focus owners require an ordered same-context Ironman pair", () => {
  const narratorFocus = remoteLines().map((line) =>
    line.replace("CentralActionHandler", "NarratorAccess.REQUEST_NARRATION"),
  );
  assert.equal(
    evaluateSpeechLogEvidence(
      narratorFocus.join("\n"),
      BOUNDARY,
      IRONMAN_PID,
    ).pass,
    true,
  );

  const mixedContext = [...narratorFocus];
  mixedContext[8] = mixedContext[8].replace(
    "NarratorAccess.REQUEST_NARRATION",
    "CentralActionHandler",
  );
  const mixedEvidence = evaluateSpeechLogEvidence(
    mixedContext.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  assert.equal(mixedEvidence.audio_focus_granted, true);
  assert.equal(mixedEvidence.audio_focus_released, false);
  assert.equal(mixedEvidence.pass, false);

  const wrongPid = [...narratorFocus];
  wrongPid[3] = wrongPid[3].replace(`  ${IRONMAN_PID}  `, "  9999  ");
  wrongPid[8] = wrongPid[8].replace(`  ${IRONMAN_PID}  `, "  9999  ");
  assert.equal(
    evaluateSpeechLogEvidence(
      wrongPid.join("\n"),
      BOUNDARY,
      IRONMAN_PID,
    ).pass,
    false,
  );

  const prematureRelease = [...narratorFocus];
  prematureRelease.splice(
    4,
    0,
    epoch(
      4,
      IRONMAN_PID,
      "AudioFocusManager",
      "NarratorAccess.REQUEST_NARRATION audio focus abandoned",
    ),
  );
  assert.equal(
    evaluateSpeechLogEvidence(
      prematureRelease.join("\n"),
      BOUNDARY,
      IRONMAN_PID,
    ).pass,
    false,
  );

  const unallowlisted = narratorFocus.map((line) =>
    line.replace("NarratorAccess.REQUEST_NARRATION", "UnrelatedFocusOwner"),
  );
  assert.equal(
    evaluateSpeechLogEvidence(
      unallowlisted.join("\n"),
      BOUNDARY,
      IRONMAN_PID,
    ).pass,
    false,
  );
});

test("missing evidence fails closed", () => {
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const lines = remoteLines();
    lines.splice(index, 1);
    assert.equal(
      evaluateSpeechLogEvidence(lines.join("\n"), BOUNDARY, IRONMAN_PID).pass,
      false,
      `missing event at index ${index} must fail`,
    );
  }
});

test("reordered or stale lifecycle evidence fails closed", () => {
  const reorderPairs = [
    [1, 2],
    [3, 6],
    [6, 7],
    [7, 8],
    [8, 9],
    [5, 6],
  ];
  for (const [left, right] of reorderPairs) {
    const lines = remoteLines();
    [lines[left], lines[right]] = [lines[right], lines[left]];
    assert.equal(
      evaluateSpeechLogEvidence(lines.join("\n"), BOUNDARY, IRONMAN_PID).pass,
      false,
      `reordered events ${left}/${right} must fail`,
    );
  }

  const staleOnly = [
    ...remoteLines().slice(1),
    epoch(20, 100, "PenumbraSpeechSmoke", BOUNDARY),
  ];
  assert.equal(
    evaluateSpeechLogEvidence(staleOnly.join("\n"), BOUNDARY, IRONMAN_PID).pass,
    false,
  );
  assert.throws(
    () => evaluateSpeechLogEvidence(remoteLines().slice(1).join("\n"), BOUNDARY, IRONMAN_PID),
    /fresh speech evidence boundary/,
  );

  const progressStartLaundering = [
    ...remoteLines().slice(0, 8),
    // A second terminal-looking end cannot borrow the prior completed cue's
    // start/focus/frames.
    epoch(
      20,
      IRONMAN_PID,
      "PenumbraHook",
      "NARRATION_END ignored because no active hand tracking session | sessionArmed=false",
    ),
    epoch(
      21,
      IRONMAN_PID,
      "AudioFocusManager",
      "CentralActionHandler audio focus abandoned",
    ),
    remoteLines()[9],
  ];
  assert.equal(
    evaluateSpeechLogEvidence(
      progressStartLaundering.join("\n"),
      BOUNDARY,
      IRONMAN_PID,
    ).pass,
    false,
  );
});

test("local TTS frames are reported as fallback rather than Azure remote playback", () => {
  const lines = remoteLines();
  lines.splice(
    6,
    1,
    epoch(5, 3758, "PenumbraTTS", "id=2 tts playbackStart firstAudioMs=711"),
    epoch(6, 3758, "PenumbraTTS", "id=2 tts done totalMs=2268 backend=offline"),
    epoch(7, 3758, "AudioTrack", "stop(66): called with 53997 frames delivered"),
  );
  const evidence = evaluateSpeechLogEvidence(
    lines.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  assert.equal(evidence.remote_branch_observed, false);
  assert.equal(evidence.local_fallback_observed, true);
  assert.equal(evidence.audio_track_frames_observed, true);
  assert.equal(evidence.pass, false);

  const ambiguous = remoteLines();
  ambiguous.splice(
    7,
    0,
    epoch(51, 3758, "PenumbraTTS", "id=2 tts playbackStart firstAudioMs=711"),
    epoch(52, 3758, "PenumbraTTS", "id=2 tts done totalMs=2268 backend=offline"),
    epoch(53, 3758, "AudioTrack", "stop(66): called with 53997 frames delivered"),
  );
  const ambiguousEvidence = evaluateSpeechLogEvidence(
    ambiguous.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  assert.equal(ambiguousEvidence.branch_ambiguous, true);
  assert.equal(ambiguousEvidence.pass, false);

  const partialFallback = remoteLines();
  partialFallback.splice(
    7,
    0,
    epoch(54, 3758, "PenumbraTTS", "id=2 tts playbackStart firstAudioMs=711"),
  );
  const partialEvidence = evaluateSpeechLogEvidence(
    partialFallback.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  assert.equal(partialEvidence.branch_ambiguous, true);
  assert.equal(partialEvidence.remote_branch_observed, false);
  assert.equal(partialEvidence.pass, false);
});

test("identity mismatch blocks before readiness, logs, injection, or cleanup", async () => {
  let touched = false;
  const device = new Proxy({}, {
    get() {
      touched = true;
      throw new Error("device must not be touched");
    },
  });
  const report = await executeSpeechPhysicalSmoke(
    parseSpeechPhysicalCliArgs(liveArgs()),
    {
      identity: identityFixture({ versionCode: VERSION_CODE + 1 }),
      device,
      get snapshot() {
        touched = true;
        throw new Error("readiness must not be read");
      },
    },
  );
  assert.equal(report.status, "blocked");
  assert.equal(report.prerequisites.exact_server_identity, false);
  assert.equal(touched, false);
});

test("imported execution independently refuses another device or unverified release", async () => {
  let touched = false;
  const dependencies = {
    get identity() {
      touched = true;
      throw new Error("identity collection must not start");
    },
  };
  const valid = parseSpeechPhysicalCliArgs(liveArgs());
  await assert.rejects(
    executeSpeechPhysicalSmoke(
      { ...valid, serial: OTHER_SERIAL },
      dependencies,
    ),
    /runtime identity was incomplete/,
  );
  await assert.rejects(
    executeSpeechPhysicalSmokeWithDependencies(
      valid,
      Object.create(Object.getPrototypeOf(dependencies), {
        ...Object.getOwnPropertyDescriptors(dependencies),
        loadExpectedServerIdentity: {
          configurable: true,
          enumerable: true,
          value: async () => {
            throw new Error("unverified release");
          },
        },
      }),
    ),
    /verified release metadata/,
  );
  assert.equal(touched, false);
});

test("synthetic live execution emits only safe booleans and removes its one owned row", async () => {
  let injected = 0;
  let deleted = 0;
  let deletionObserved = false;
  let promptReads = 0;
  const cleanupOrder = [];
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async setMediaVolumeIndex(index) {
      assert.equal(index, GUARDED_MEDIA_VOLUME_STATE.index);
      cleanupOrder.push("volume_restore");
    },
    async ironmanPids() { return [IRONMAN_PID]; },
    async promptRows() {
      promptReads += 1;
      return promptReads === 1 || deletionObserved
        ? [{ id: 1, prompt: "older", response: null }]
        : [terminalRow()];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() { injected += 1; },
    async speechLog() { return remoteLines().join("\n"); },
    async deletePrompt(id) {
      assert.equal(id, 2);
      cleanupOrder.push("activity_cleanup");
      deleted += 1;
      deletionObserved = true;
    },
  };
  const report = await executeSpeechPhysicalSmoke(
    parseSpeechPhysicalCliArgs(liveArgs()),
    {
      identity: identityFixture(),
      snapshot: readinessFixture(),
      token: "fixture-token-not-printed",
      device,
      async pollUntil(_timeoutMs, observe) { return observe(); },
    },
  );
  assert.equal(report.status, "pass");
  assert.equal(injected, 1);
  assert.equal(deleted, 1);
  assert.deepEqual(cleanupOrder, ["activity_cleanup", "volume_restore"]);
  assert.equal(report.cleanup.media_volume_snapshot_captured, true);
  assert.equal(report.cleanup.media_volume_restored, true);
  assert.equal(report.evidence.remote_branch_observed, true);
  assert.equal(report.evidence.local_fallback_observed, false);
  assert.equal(report.evidence.server_request_final_correlated, true);
  assert.equal(report.evidence.request_activity_correlated, true);
  assert.equal(report.evidence.substantive_terminal_observed, true);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(
    serialized,
    /PRIVATE_RESPONSE|fixture-token|223e4567|speech-smoke-123e|51264|3152/,
  );
});

test("live cleanup deletes only the activity row correlated to the logged request", async () => {
  const unrelatedRunId = "323e4567-e89b-42d3-a456-426614174000";
  const unrelated = {
    ...terminalRow(3),
    run_id: unrelatedRunId,
    response: "UNRELATED_PRIVATE_RESPONSE",
  };
  let deletedId = null;
  let promptReads = 0;
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async ironmanPids() { return [IRONMAN_PID]; },
    async promptRows() {
      promptReads += 1;
      if (promptReads === 1) return [{ id: 1, prompt: "older", response: null }];
      return deletedId === null ? [unrelated, terminalRow()] : [unrelated];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() {},
    async speechLog() { return remoteLines().join("\n"); },
    async deletePrompt(id) { deletedId = id; },
  };
  const report = await executeSpeechPhysicalSmoke(
    parseSpeechPhysicalCliArgs(liveArgs()),
    {
      identity: identityFixture(),
      snapshot: readinessFixture(),
      token: "fixture-token-not-printed",
      device,
    },
  );
  assert.equal(report.status, "pass");
  assert.equal(deletedId, 2);
  assert.equal(report.cleanup.fixed_prompt_activity_removed, true);
  assert.doesNotMatch(JSON.stringify(report), /UNRELATED_PRIVATE_RESPONSE|323e4567/);
});

test("an uncorrelated same-prompt row is never deleted", async () => {
  const unrelatedRunId = "323e4567-e89b-42d3-a456-426614174000";
  let deleted = 0;
  let promptReads = 0;
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async ironmanPids() { return [IRONMAN_PID]; },
    async promptRows() {
      promptReads += 1;
      return promptReads === 1
        ? [{ id: 1, prompt: "older", response: null }]
        : [{ ...terminalRow(), run_id: unrelatedRunId }];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() {},
    async speechLog() { return remoteLines().join("\n"); },
    async deletePrompt() { deleted += 1; },
  };
  const report = await executeSpeechPhysicalSmoke(
    parseSpeechPhysicalCliArgs(liveArgs()),
    {
      identity: identityFixture(),
      snapshot: readinessFixture(),
      token: "fixture-token-not-printed",
      device,
      async pollUntil(_timeoutMs, observe) { return observe(); },
    },
  );
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.request_activity_correlated, false);
  assert.equal(deleted, 0);
  assert.equal(report.cleanup.fixed_prompt_activity_removed, false);
});

test("post-injection observation exceptions still run correlated cleanup", async () => {
  let deleted = 0;
  let deletionObserved = false;
  let promptReads = 0;
  let pidReads = 0;
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async ironmanPids() {
      pidReads += 1;
      if (pidReads === 1) return [IRONMAN_PID];
      throw new Error("PRIVATE_OBSERVATION_FAILURE");
    },
    async promptRows() {
      promptReads += 1;
      return promptReads === 1 || deletionObserved
        ? [{ id: 1, prompt: "older", response: null }]
        : [terminalRow()];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() {},
    async speechLog() { return remoteLines().join("\n"); },
    async deletePrompt(id) {
      assert.equal(id, 2);
      deleted += 1;
      deletionObserved = true;
    },
  };
  await assert.rejects(
    executeSpeechPhysicalSmoke(
      parseSpeechPhysicalCliArgs(liveArgs()),
      {
        identity: identityFixture(),
        snapshot: readinessFixture(),
        token: "fixture-token-not-printed",
        device,
      },
    ),
    /PRIVATE_OBSERVATION_FAILURE/,
  );
  assert.equal(deleted, 1);
});

test("CLI sanitizes a post-injection exception after correlated cleanup", async () => {
  let deleted = 0;
  let deletionObserved = false;
  let promptReads = 0;
  let pidReads = 0;
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async ironmanPids() {
      pidReads += 1;
      if (pidReads === 1) return [IRONMAN_PID];
      throw new Error(`PRIVATE_DEVICE_FAILURE ${SERIAL} ${RUN_ID}`);
    },
    async promptRows() {
      promptReads += 1;
      return promptReads === 1 || deletionObserved
        ? [{ id: 1, prompt: "older", response: null }]
        : [terminalRow()];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() {},
    async speechLog() { return remoteLines().join("\n"); },
    async deletePrompt() {
      deleted += 1;
      deletionObserved = true;
    },
  };
  const stdout = writer();
  const stderr = writer();
  const exitCode = await main(
    [...liveArgs(), "--json"],
    {
      async verifyDevice() {},
      identity: identityFixture(),
      snapshot: readinessFixture(),
      token: "fixture-token-not-printed",
      device,
    },
    stdout.stream,
    stderr.stream,
  );
  assert.equal(exitCode, 1);
  assert.equal(deleted, 1);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "speech-physical-smoke: speech physical smoke failed safely\n");
  assert.doesNotMatch(
    stderr.text(),
    /PRIVATE_DEVICE_FAILURE|fixture-token|fixture-pin-serial|223e4567/,
  );
});

test("a stabilizing observation exception cannot bypass remembered cleanup", async () => {
  let deleted = 0;
  let deletionObserved = false;
  let speechReads = 0;
  let promptReads = 0;
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async ironmanPids() { return [IRONMAN_PID]; },
    async promptRows() {
      promptReads += 1;
      return promptReads === 1 || deletionObserved
        ? [{ id: 1, prompt: "older", response: null }]
        : [terminalRow()];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() {},
    async speechLog() {
      speechReads += 1;
      if (speechReads === 1) return remoteLines().join("\n");
      throw new Error("PRIVATE_STABILIZATION_FAILURE");
    },
    async deletePrompt(id) {
      assert.equal(id, 2);
      deleted += 1;
      deletionObserved = true;
    },
  };
  await assert.rejects(
    executeSpeechPhysicalSmoke(
      parseSpeechPhysicalCliArgs(liveArgs()),
      {
        identity: identityFixture(),
        snapshot: readinessFixture(),
        token: "fixture-token-not-printed",
        device,
      },
    ),
    /PRIVATE_STABILIZATION_FAILURE/,
  );
  assert.equal(deleted, 1);
});

test("CLI failures never print the operator-confirmed serial", async () => {
  const stdout = writer();
  const stderr = writer();
  assert.equal(
    await main(["--run"], {}, stdout.stream, stderr.stream),
    2,
  );
  assert.equal(stdout.text(), "");
  assert.doesNotMatch(stderr.text(), new RegExp(SERIAL));
  assert.match(stderr.text(), /PIN_SERIAL/);
});

test("self-check output contains no fixture response, raw logs, or identifiers", async () => {
  const stdout = writer();
  const stderr = writer();
  assert.equal(
    await main(["--self-check", "--json"], {}, stdout.stream, stderr.stream),
    0,
  );
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(
    stdout.text(),
    /PRIVATE_RESPONSE|223e4567|speech-smoke-123e|51264|3152/,
  );
  assert.equal(JSON.parse(stdout.text()).status, "pass");
});

test("evidence distinguishes TTS frames from human audibility", () => {
  const evidence = evaluateSpeechLogEvidence(
    remoteLines().join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  // TTS frames delivered via AudioTrack proves audio pipeline produced output
  assert.equal(evidence.tts_frames_delivered, true);
  // Human audibility is NEVER confirmed by automation - requires physical observation
  assert.equal(evidence.human_audibility_confirmed, false);
  // audio_track_frames_observed remains for backward compatibility
  assert.equal(evidence.audio_track_frames_observed, true);
});

test("evidence distinguishes transcript injection from microphone ASR", () => {
  const evidence = evaluateSpeechLogEvidence(
    remoteLines().join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  // Prompt entered via broadcast injection (post-ASR path)
  assert.equal(evidence.transcript_injection_path, true);
  // Microphone ASR bypassed - structural to harness, not inferred
  assert.equal(evidence.microphone_asr_bypassed, true);
});

test("evidence distinguishes narration from projector presentation", () => {
  const evidence = evaluateSpeechLogEvidence(
    remoteLines().join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  // Stock narration lifecycle observed (start/end holds)
  assert.equal(evidence.narration_lifecycle_observed, true);
  assert.equal(evidence.narration_start_observed, true);
  assert.equal(evidence.narration_end_observed, true);
  // Projector not in path - structural to harness
  assert.equal(evidence.projector_not_in_path, true);
});

test("focus cancellation is bounded within narration window", () => {
  const evidence = evaluateSpeechLogEvidence(
    remoteLines().join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  // Focus granted then abandoned within expected window
  assert.equal(evidence.focus_cancellation_bounded, true);
  // Cue cancellation: narration lifecycle + bounded focus + no premature abandon
  assert.equal(evidence.cue_cancellation_bounded, true);
  // Underlying focus fields remain
  assert.equal(evidence.audio_focus_granted, true);
  assert.equal(evidence.audio_focus_released, true);
});

test("premature focus abandonment fails bounded cancellation", () => {
  const lines = remoteLines();
  // Insert a premature focus abandon between narration start and end
  lines.splice(
    4,
    0,
    epoch(40, IRONMAN_PID, "AudioFocusManager", "CentralActionHandler audio focus abandoned"),
  );
  const evidence = evaluateSpeechLogEvidence(
    lines.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  // Premature abandon means cancellation is NOT bounded
  assert.equal(evidence.focus_cancellation_bounded, false);
  assert.equal(evidence.cue_cancellation_bounded, false);
  // But pass still requires focus released, so this should fail
  assert.equal(evidence.pass, false);
});

test("missing narration lifecycle fails distinction checks", () => {
  const lines = remoteLines();
  // Remove narration end
  const filtered = lines.filter((line) => !line.includes("NARRATION_END"));
  const evidence = evaluateSpeechLogEvidence(
    filtered.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  // Narration lifecycle incomplete
  assert.equal(evidence.narration_lifecycle_observed, false);
  assert.equal(evidence.narration_end_observed, false);
  // Cancellation cannot be bounded without complete lifecycle
  assert.equal(evidence.cue_cancellation_bounded, false);
  assert.equal(evidence.pass, false);
});

test("missing assistant request fails transcript injection path", () => {
  const lines = remoteLines();
  // Remove the assistant request line
  const filtered = lines.filter((line) => !line.includes("BidirectionalStreamingUnderstand (content redacted)"));
  const evidence = evaluateSpeechLogEvidence(
    filtered.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  // No request observed means injection path not confirmed
  assert.equal(evidence.transcript_injection_path, false);
  // ASR bypass still structural
  assert.equal(evidence.microphone_asr_bypassed, true);
  // Pass requires request observed
  assert.equal(evidence.pass, false);
});

test("no audio frames means TTS delivery not confirmed", () => {
  const lines = remoteLines();
  // Remove AudioTrack frames line
  const filtered = lines.filter((line) => !line.includes("AudioTrack"));
  const evidence = evaluateSpeechLogEvidence(
    filtered.join("\n"),
    BOUNDARY,
    IRONMAN_PID,
  );
  // No frames means TTS delivery not confirmed
  assert.equal(evidence.tts_frames_delivered, false);
  assert.equal(evidence.audio_track_frames_observed, false);
  // Human audibility still false (never confirmed by automation)
  assert.equal(evidence.human_audibility_confirmed, false);
  // Pass requires remote branch which requires frames
  assert.equal(evidence.pass, false);
});

test("session continuity requires process stability and correlation", async () => {
  let deleted = 0;
  let deletionObserved = false;
  let promptReads = 0;
  let pidReads = 0;
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async ironmanPids() {
      pidReads += 1;
      // First read returns stable, second read returns different PID (restart)
      if (pidReads === 1) return [IRONMAN_PID];
      return [IRONMAN_PID + 1000]; // Process restarted
    },
    async promptRows() {
      promptReads += 1;
      return promptReads === 1 || deletionObserved
        ? [{ id: 1, prompt: "older", response: null }]
        : [terminalRow()];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() {},
    async speechLog() { return remoteLines().join("\n"); },
    async deletePrompt(id) {
      assert.equal(id, 2);
      deleted += 1;
      deletionObserved = true;
    },
  };
  const report = await executeSpeechPhysicalSmoke(
    parseSpeechPhysicalCliArgs(liveArgs()),
    {
      identity: identityFixture(),
      snapshot: readinessFixture(),
      token: "fixture-token-not-printed",
      device,
      // This case deliberately never reaches a passing observation because
      // Ironman changes PID. A unit test needs one observation, not the live
      // harness's 75-second production polling window.
      async pollUntil(_timeoutMs, observe) { return observe(); },
    },
  );
  // Process restarted, so session continuity not maintained
  assert.equal(report.evidence.session_continuity_maintained, false);
  assert.equal(report.evidence.ironman_process_stable, false);
  // Cleanup still runs
  assert.equal(deleted, 1);
});

test("session continuity maintained on stable execution", async () => {
  let deleted = 0;
  let deletionObserved = false;
  let promptReads = 0;
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async ironmanPids() { return [IRONMAN_PID]; },
    async promptRows() {
      promptReads += 1;
      return promptReads === 1 || deletionObserved
        ? [{ id: 1, prompt: "older", response: null }]
        : [terminalRow()];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() {},
    async speechLog() { return remoteLines().join("\n"); },
    async deletePrompt(id) {
      assert.equal(id, 2);
      deleted += 1;
      deletionObserved = true;
    },
  };
  const report = await executeSpeechPhysicalSmoke(
    parseSpeechPhysicalCliArgs(liveArgs()),
    {
      identity: identityFixture(),
      snapshot: readinessFixture(),
      token: "fixture-token-not-printed",
      device,
    },
  );
  // Stable process + correlated request/final + correlated activity
  assert.equal(report.evidence.session_continuity_maintained, true);
  assert.equal(report.evidence.ironman_process_stable, true);
  assert.equal(report.evidence.server_request_final_correlated, true);
  assert.equal(report.evidence.request_activity_correlated, true);
  // Cleanup runs
  assert.equal(deleted, 1);
});

test("self-check includes all distinction evidence fields", async () => {
  const stdout = writer();
  const stderr = writer();
  const exitCode = await main(
    ["--self-check", "--json"],
    {},
    stdout.stream,
    stderr.stream,
  );
  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  // All distinction fields present in self-check
  assert.equal(report.checks.transcript_injection_path, true);
  assert.equal(report.checks.microphone_asr_bypassed, true);
  assert.equal(report.checks.tts_frames_delivered, true);
  assert.equal(report.checks.human_audibility_confirmed, false);
  assert.equal(report.checks.narration_lifecycle_observed, true);
  assert.equal(report.checks.projector_not_in_path, true);
  assert.equal(report.checks.focus_cancellation_bounded, true);
  assert.equal(report.checks.cue_cancellation_bounded, true);
});

test("final report includes all distinction evidence fields", async () => {
  let deleted = 0;
  let deletionObserved = false;
  let promptReads = 0;
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async ironmanPids() { return [IRONMAN_PID]; },
    async promptRows() {
      promptReads += 1;
      return promptReads === 1 || deletionObserved
        ? [{ id: 1, prompt: "older", response: null }]
        : [terminalRow()];
    },
    async beginBoundary() { return BOUNDARY; },
    async inject() {},
    async speechLog() { return remoteLines().join("\n"); },
    async deletePrompt(id) {
      assert.equal(id, 2);
      deleted += 1;
      deletionObserved = true;
    },
  };
  const report = await executeSpeechPhysicalSmoke(
    parseSpeechPhysicalCliArgs(liveArgs()),
    {
      identity: identityFixture(),
      snapshot: readinessFixture(),
      token: "fixture-token-not-printed",
      device,
    },
  );
  // All distinction fields present in final report
  assert.equal(report.evidence.transcript_injection_path, true);
  assert.equal(report.evidence.microphone_asr_bypassed, true);
  assert.equal(report.evidence.tts_frames_delivered, true);
  assert.equal(report.evidence.human_audibility_confirmed, false);
  assert.equal(report.evidence.narration_lifecycle_observed, true);
  assert.equal(report.evidence.projector_not_in_path, true);
  assert.equal(report.evidence.focus_cancellation_bounded, true);
  assert.equal(report.evidence.cue_cancellation_bounded, true);
  assert.equal(report.evidence.session_continuity_maintained, true);
  // Limitations include explicit distinction notes
  assert.ok(report.limitations.includes("tts_frames_delivered_is_not_human_audibility"));
  assert.ok(report.limitations.includes("microphone_asr_bypass_is_structural_not_inferred"));
});
