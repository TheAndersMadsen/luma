import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENTIC_LOCATION_PREFLIGHT_THOUGHT,
  CHECK_STATUS,
  GrpcFrameDecoder,
  INCOMPLETE_EXIT_CODE,
  PROMPTS,
  RELEASE_IDENTITY,
  SERVER_SOURCE,
  SMOKE_USER_TURN_ID,
  TOOL_FAILURE_REASONS,
  WEATHER_LOCATION_PREFLIGHT_THOUGHT,
  WEB_SEARCH_CHECK_ID,
  buildActionResponseFixture,
  buildObservationResponseFixture,
  buildPublicReport,
  containsForbiddenSecretKey,
  decodeProtoFields,
  decodeUnderstandingRequest,
  decodeUnderstandingResponses,
  encodeUnderstandingRequest,
  evaluateCompoundNearbyRouteInitialProbe,
  evaluateDisabledSpotifyFailClosed,
  evaluateMusicChain,
  evaluateReadiness,
  evaluateTickleRouting,
  evaluateWeatherInitialProbe,
  evaluateWebSearch,
  isRequiredReleaseVersion,
  manualVerificationChecks,
  parseActiveServerApkPath,
  parseActiveServerApkSha256,
  parseCliArgs,
  parseGrpcFrames,
  parseLoopbackGrpcPort,
  parseInstalledServerPackageMetadata,
  redactSensitive,
  renderHumanReport,
  reportExitCode,
  wrapGrpcFrame,
} from "./agentic-release-smoke-lib.mjs";
import {
  PIN_ADMIN_TOKEN_FILE_ENV,
  RUNTIME_SECRETS_DIR_ENV,
  collectFixedMusicRankOne,
  collectInstalledServerIdentity,
  collectReadiness,
  buildAibusRequestHeaders,
  main,
  openAdbShellAibusTunnel,
  readAdminToken,
  resolveAdminTokenFile,
  verifyExplicitDevice,
} from "./agentic-release-smoke.mjs";

test("AIBus request headers carry the validated bearer token only when supplied", () => {
  const token = "a".repeat(32);
  const anonymous = buildAibusRequestHeaders(30_000, "test-run", undefined);
  const authenticated = buildAibusRequestHeaders(30_000, "test-run", token);

  assert.equal(anonymous.authorization, undefined);
  assert.equal(authenticated.authorization, `Bearer ${token}`);
  assert.equal(authenticated["grpc-timeout"], "30S");
  assert.throws(
    () => buildAibusRequestHeaders(30_000, "test-run", `${token}\nunsafe`),
    /authentication token is invalid/,
  );
});

function actionResponses({
  action,
  input = "{}",
  thought = "fixture thought",
  source = SERVER_SOURCE,
  devicePayload = Buffer.alloc(0),
  identifier = "fixture-action",
  parentIdentifier = SMOKE_USER_TURN_ID,
}) {
  const frame = wrapGrpcFrame(
    buildActionResponseFixture({
      action,
      input,
      thought,
      source,
      devicePayload,
      identifier,
      parentIdentifier,
    }),
  );
  return decodeUnderstandingResponses(parseGrpcFrames(frame));
}

function fakeAdbChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.signalCode = "SIGTERM";
    return true;
  };
  return child;
}

function liveFeatureFlagsResponseFixture() {
  return {
    flags: [
      {
        key: "tickle",
        label: "The Tickle",
        description: "Enables the hidden stock Tickle voice intent.",
        value_type: "bool",
        firmware_default: { type: "bool", value: false },
        penumbra_default: null,
        override_value: { type: "bool", value: true },
        desired_value: { type: "bool", value: true },
        assignment_value: { type: "bool", value: true },
        source: "override",
        writable: true,
        warning: null,
        restart_recommended: false,
      },
      {
        key: "touchcode_timeout_millis",
        label: "Touchcode timeout",
        description: "Representative non-boolean flag.",
        value_type: "int",
        firmware_default: { type: "int", value: 5_000 },
        penumbra_default: null,
        override_value: null,
        desired_value: { type: "int", value: 5_000 },
        assignment_value: null,
        source: "firmware_default",
        writable: true,
        warning: null,
        restart_recommended: false,
      },
    ],
    settings_global_gates: [],
    settings_global_note:
      "These stock gates are maintained outside cloud assignments.",
    delivery: {
      state: "stock_cache_applied",
      desired_assignment_hash: "public-regression-fixture-hash",
      grpc_fetch_observed: true,
      last_grpc_fetch_unix_ms: 1_721_081_600_000,
      stock_cache_verified: true,
      last_stock_cache_apply_unix_ms: 1_721_081_600_100,
      immediate_sync_supported: true,
      automatic_triggers: ["save broadcast", "Penumbra server startup"],
      note: "Exact assignment identity was applied and read back.",
    },
  };
}

function readinessFixture(overrides = {}) {
  const fixture = {
    health: {
      status: "ok",
      name: "Penumbra",
      version: RELEASE_IDENTITY.versionName,
    },
    packageIdentity: { ...RELEASE_IDENTITY },
    settings: {
      restart_required: false,
      llm: {
        provider: "codex",
        has_api_key: false,
        hermes_progress_turns: true,
        tools: { enabled: true, max_tool_turns: 12 },
      },
      server: {
        admin_token_auth: true,
        grpc_bind_addr: "127.0.0.1:9090",
      },
      weather: { has_api_key: true },
      brave_search: { has_api_key: true },
      openstreetmap: { enabled: true, location_consent_acknowledged: false },
    },
    codex: { state: "ready", ready: true },
    spotify: {
      enabled: true,
      experimental_acknowledged: true,
      state: "ready",
      engine_ready: true,
    },
    featureFlags: liveFeatureFlagsResponseFixture(),
  };
  return { ...fixture, ...overrides };
}

test("CLI requires an explicit serial and an explicit execution mode", () => {
  assert.deepEqual(
    parseCliArgs([
      "--serial",
      "device-123._:usb",
      "--run-safe-aibus",
      "--expect-spotify-disabled",
      "--json",
    ]),
    {
      mode: "run-safe-aibus",
      serial: "device-123._:usb",
      adbPath: "adb",
      json: true,
      expectSpotifyDisabled: true,
      help: false,
    },
  );
  assert.throws(() => parseCliArgs([]), /choose --self-check/);
  assert.throws(
    () => parseCliArgs(["--inspect"]),
    /explicit ADB serial/,
  );
  assert.throws(
    () => parseCliArgs(["--serial", "device;reboot", "--inspect"]),
    /explicit ADB serial/,
  );
  assert.throws(
    () => parseCliArgs(["--self-check", "--inspect"]),
    /exactly one mode/,
  );
  assert.throws(
    () => parseCliArgs(["--serial", "device", "--inspect", "--expect-spotify-disabled"]),
    /requires --run-safe-aibus/,
  );
  assert.equal(parseCliArgs(["--self-check"]).serial, null);
});

test("admin-token path selection is explicit, absolute, and fork-local by default", () => {
  const defaultPath = fileURLToPath(
    new URL("../../../../pin/.secrets/pin-admin-token", import.meta.url),
  );
  const externalDirectory = "/fixture/external-runtime-secrets";
  const externalFile = "/fixture/external-admin-token";

  assert.equal(resolveAdminTokenFile({}), defaultPath);
  assert.equal(
    resolveAdminTokenFile({
      [RUNTIME_SECRETS_DIR_ENV]: externalDirectory,
    }),
    join(externalDirectory, "pin-admin-token"),
  );
  assert.equal(
    resolveAdminTokenFile({ [PIN_ADMIN_TOKEN_FILE_ENV]: externalFile }),
    externalFile,
  );

  for (const value of ["relative/secrets", "", "line\nbreak", "bad\0path"]) {
    assert.throws(
      () =>
        resolveAdminTokenFile({
          [PIN_ADMIN_TOKEN_FILE_ENV]: value,
        }),
      /path override is invalid/,
    );
  }
  assert.throws(
    () =>
      resolveAdminTokenFile({
        [PIN_ADMIN_TOKEN_FILE_ENV]: externalFile,
        [RUNTIME_SECRETS_DIR_ENV]: externalDirectory,
      }),
    (error) => {
      assert.equal(error.message, "choose only one admin-token path override");
      assert.equal(error.message.includes(externalFile), false);
      assert.equal(error.message.includes(externalDirectory), false);
      return true;
    },
  );
});

test("admin-token reads require one private regular file and never expose its path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "penumbra-token-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = "fixture-admin-token-0123456789";
  const tokenFile = join(directory, "explicit-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  assert.equal(
    await readAdminToken({ [PIN_ADMIN_TOKEN_FILE_ENV]: tokenFile }),
    token,
  );

  const externalDirectory = join(directory, "external-secrets");
  await mkdir(externalDirectory, { mode: 0o700 });
  await writeFile(join(externalDirectory, "pin-admin-token"), token, {
    mode: 0o600,
  });
  assert.equal(
    await readAdminToken({
      [RUNTIME_SECRETS_DIR_ENV]: externalDirectory,
    }),
    token,
  );

  const symlinkPath = join(directory, "token-link");
  await symlink(tokenFile, symlinkPath);
  await assert.rejects(
    readAdminToken({ [PIN_ADMIN_TOKEN_FILE_ENV]: symlinkPath }),
    /missing or unreadable/,
  );

  await chmod(tokenFile, 0o644);
  await assert.rejects(
    readAdminToken({ [PIN_ADMIN_TOKEN_FILE_ENV]: tokenFile }),
    /admin-token file is invalid/,
  );
  await chmod(tokenFile, 0o600);

  const invalidFile = join(directory, "invalid-token");
  const invalidToken = "private-token\nwith-internal-newline";
  await writeFile(invalidFile, invalidToken, { mode: 0o600 });
  await assert.rejects(
    readAdminToken({ [PIN_ADMIN_TOKEN_FILE_ENV]: invalidFile }),
    (error) => {
      assert.equal(error.message, "the fixed admin-token file is invalid");
      assert.equal(error.message.includes(invalidFile), false);
      assert.equal(error.message.includes(invalidToken), false);
      return true;
    },
  );

  const oversizedFile = join(directory, "oversized-token");
  await writeFile(oversizedFile, "a".repeat(1_027), { mode: 0o600 });
  await assert.rejects(
    readAdminToken({ [PIN_ADMIN_TOKEN_FILE_ENV]: oversizedFile }),
    /admin-token file is invalid/,
  );

  const missingFile = join(directory, "missing-token-path-canary");
  await assert.rejects(
    readAdminToken({ [PIN_ADMIN_TOKEN_FILE_ENV]: missingFile }),
    (error) => {
      assert.equal(
        error.message,
        "the fixed admin-token file is missing or unreadable",
      );
      assert.equal(error.message.includes(missingFile), false);
      return true;
    },
  );
});

test("imported device readers reject a missing serial before ADB selection", async () => {
  const originalAndroidSerial = process.env.ANDROID_SERIAL;
  process.env.ANDROID_SERIAL = "fixture-ambient-adb-target";
  try {
    for (const serial of [null, undefined, ""]) {
      const options = { adbPath: "/fixture/adb-must-not-run", serial };
      await assert.rejects(
        verifyExplicitDevice(options),
        /valid explicit ADB serial/,
      );
      await assert.rejects(
        collectInstalledServerIdentity(options),
        /valid explicit ADB serial/,
      );
      await assert.rejects(
        collectReadiness(options, "fixture-admin-token"),
        /valid explicit ADB serial/,
      );
      await assert.rejects(
        collectFixedMusicRankOne(options, "fixture-admin-token"),
        /valid explicit ADB serial/,
      );
    }
  } finally {
    if (originalAndroidSerial === undefined) delete process.env.ANDROID_SERIAL;
    else process.env.ANDROID_SERIAL = originalAndroidSerial;
  }
});

test("AIBus transport is one exact serial-bound non-PTY shell nc duplex", async (t) => {
  const child = fakeAdbChild();
  let invocation;
  const tunnel = openAdbShellAibusTunnel(
    { adbPath: "/fixture/adb", serial: "device-123._:usb" },
    9_090,
    {
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return child;
      },
      maxResponseBytes: 64,
    },
  );
  t.after(() => tunnel.close());

  assert.deepEqual(invocation, {
    command: "/fixture/adb",
    args: [
      "-s",
      "device-123._:usb",
      "shell",
      "-T",
      "nc",
      "127.0.0.1",
      "9090",
    ],
    options: { stdio: ["pipe", "pipe", "pipe"] },
  });
  assert.equal(invocation.args.includes("forward"), false);
  assert.equal(invocation.args.includes("exec-out"), false);

  const requestFixture = Buffer.from([
    0x50, 0x52, 0x49, 0x20, 0x2a, 0x20, 0x48, 0x54, 0x54, 0x50, 0x2f,
    0x32, 0x2e, 0x30, 0x0d, 0x0a, 0x00, 0x80, 0xff,
  ]);
  const outbound = once(child.stdin, "data");
  tunnel.stream.write(requestFixture);
  assert.deepEqual((await outbound)[0], requestFixture);

  const responseFixture = Buffer.from([
    0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x0d,
    0x80, 0xff,
  ]);
  const inbound = once(tunnel.stream, "data");
  child.stdout.write(responseFixture);
  assert.deepEqual((await inbound)[0], responseFixture);

  tunnel.close();
  assert.equal(child.killCalls, 1);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("AIBus shell tunnel fails closed on invalid routing or excess bytes", async () => {
  let spawnCalls = 0;
  const spawn = () => {
    spawnCalls += 1;
    return fakeAdbChild();
  };
  assert.throws(
    () =>
      openAdbShellAibusTunnel(
        { adbPath: "adb", serial: "device;reboot" },
        9_090,
        { spawn },
      ),
    /explicit ADB serial/,
  );
  assert.throws(
    () =>
      openAdbShellAibusTunnel(
        { adbPath: "adb", serial: "device-123" },
        "9090",
        { spawn },
      ),
    /AIBus port/,
  );
  assert.equal(spawnCalls, 0, "invalid routing must fail before spawning ADB");

  const child = fakeAdbChild();
  const tunnel = openAdbShellAibusTunnel(
    { adbPath: "adb", serial: "device-123" },
    9_090,
    { spawn: () => child, maxResponseBytes: 8 },
  );
  tunnel.stream.on("error", () => {});
  const closed = new Promise((resolvePromise) => {
    tunnel.stream.once("close", resolvePromise);
  });
  child.stdout.write(Buffer.alloc(9));
  await closed;
  assert.equal(child.killCalls, 1);
  assert.equal(child.stdout.destroyed, true);
});

test("installed release identity parsers require exact, shell-safe package evidence", () => {
  const apkPath =
    "/data/app/~~AbCdEf==/com.penumbraos.server-XyZ123==/base.apk";
  assert.deepEqual(
    parseInstalledServerPackageMetadata(
      `Package [${RELEASE_IDENTITY.packageName}]\n  versionCode=${RELEASE_IDENTITY.versionCode} minSdk=31\n  versionName=${RELEASE_IDENTITY.versionName}\n`,
    ),
    {
      versionName: RELEASE_IDENTITY.versionName,
      versionCode: RELEASE_IDENTITY.versionCode,
    },
  );
  assert.equal(
    parseActiveServerApkPath(
      `package:${apkPath}\npackage:${apkPath.replace("base.apk", "split_config.arm64_v8a.apk")}\n`,
    ),
    apkPath,
  );
  assert.equal(
    parseActiveServerApkSha256(
      `${RELEASE_IDENTITY.apkSha256}  ${apkPath}\n`,
      apkPath,
    ),
    RELEASE_IDENTITY.apkSha256,
  );

  assert.throws(
    () =>
      parseActiveServerApkPath(
        "package:/data/app/../data/local/tmp/evil/base.apk\n",
      ),
    /unsafe/,
  );
  assert.throws(
    () =>
      parseActiveServerApkPath(
        "package:/data/app/~~AbCdEf==/com.example.other-XyZ123==/base.apk\n",
      ),
    /unsafe/,
  );
  assert.throws(
    () =>
      parseActiveServerApkSha256(
        `${RELEASE_IDENTITY.apkSha256}  /data/app/other/base.apk\n`,
        apkPath,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      parseInstalledServerPackageMetadata(
        `versionCode=${RELEASE_IDENTITY.versionCode}\nversionCode=${RELEASE_IDENTITY.versionCode + 1}\nversionName=${RELEASE_IDENTITY.versionName}\n`,
      ),
    /ambiguous/,
  );
});

test("redaction removes credentials, coordinates, and private keyed content", () => {
  const secret = "unit-secret-token-0123456789";
  const value = {
    authorization: `Bearer ${secret}`,
    has_api_key: true,
    nested: {
      api_key: secret,
      latitude: 55.6761,
      longitude: 12.5683,
      response: "private assistant answer",
      transcript: "private user words",
    },
    diagnostic: `Authorization: Bearer ${secret}; latitude=55.6761 longitude=12.5683 pair 55.6761,12.5683`,
  };
  const redacted = redactSensitive(value, { knownSecrets: [secret] });
  const serialized = JSON.stringify(redacted);

  assert.equal(redacted.has_api_key, true, "capability booleans remain useful");
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.nested.api_key, "[REDACTED]");
  assert.equal(redacted.nested.latitude, "[REDACTED]");
  assert.equal(redacted.nested.response, "[REDACTED]");
  assert.doesNotMatch(serialized, /unit-secret|55\.6761|12\.5683|private/);
  assert.match(serialized, /REDACTED_COORDINATES|REDACTED/);
});

test("secret-key inspection is recursive but accepts capability booleans", () => {
  assert.equal(
    containsForbiddenSecretKey({ llm: { has_api_key: true } }),
    false,
  );
  assert.equal(
    containsForbiddenSecretKey({ llm: [{ nested: { access_token: "x" } }] }),
    true,
  );
});

test("protobuf request uses the real Understand field numbers", () => {
  const encoded = encodeUnderstandingRequest({
    utterance: PROMPTS.music,
    excludedTools: ["CallPerson", "ComposeMessage"],
    singleShot: true,
    sendActionsAndObservationsSeparately: true,
  });
  const fields = decodeProtoFields(encoded);

  assert.equal(fields.get(1).length, 1, "utterance is field 1");
  assert.equal(fields.get(3).length, 1, "device_context is field 3");
  assert.equal(fields.get(6)[0].value, 1n, "single_shot is field 6");
  assert.equal(fields.get(7)[0].value, 1n, "separate mode is field 7");
  assert.equal(fields.get(8).length, 2, "excluded_tools is repeated field 8");
  assert.equal(fields.has(10), false, "no location is ever encoded");
  assert.deepEqual(decodeUnderstandingRequest(encoded), {
    utterance: PROMPTS.music,
    hasLocation: false,
    deviceContext: {
      isLocked: false,
      turns: [
        {
          user: 1,
          request: PROMPTS.music,
          identifier: SMOKE_USER_TURN_ID,
          parentIdentifier: "",
        },
      ],
    },
  });
  assert.throws(
    () => encodeUnderstandingRequest({ utterance: "x", excludedTools: ["Call-Person"] }),
    /invalid excluded tool/,
  );
});

test("gRPC decoder handles fragmented frames and rejects unsafe framing", () => {
  const framed = wrapGrpcFrame(
    buildActionResponseFixture({ action: "Tickle", input: "{}" }),
  );
  const decoder = new GrpcFrameDecoder();
  const frames = [
    ...decoder.push(framed.subarray(0, 2)),
    ...decoder.push(framed.subarray(2, 5)),
    ...decoder.push(framed.subarray(5, 11)),
    ...decoder.push(framed.subarray(11)),
  ];
  decoder.finish();

  const response = decodeUnderstandingResponses(frames)[0];
  assert.equal(response.kind, "action");
  assert.equal(response.action, "Tickle");
  assert.equal(response.source, SERVER_SOURCE);
  assert.equal(response.devicePayloadBytes, 0);
  assert.equal(response.hasIdentifier, true);
  assert.equal(response.hasParentIdentifier, true);
  assert.equal(response.parentIdentifier, SMOKE_USER_TURN_ID);

  const multi = new GrpcFrameDecoder({
    maxFrameBytes: framed.length - 5,
    maxFrames: 2,
  });
  assert.equal(multi.push(Buffer.concat([framed, framed])).length, 2);
  multi.finish();

  assert.throws(() => parseGrpcFrames(framed.subarray(0, -1)), /truncated/);
  const compressed = Buffer.from(framed);
  compressed[0] = 1;
  assert.throws(() => parseGrpcFrames(compressed), /compressed/);
  const oversized = Buffer.alloc(5);
  oversized.writeUInt32BE(512 * 1024 + 1, 1);
  assert.throws(() => parseGrpcFrames(oversized), /too large/);
});

test("exact weather evidence requires the deterministic missing-location marker", () => {
  const valid = actionResponses({
    action: "GetCurrentLocation",
    thought: WEATHER_LOCATION_PREFLIGHT_THOUGHT,
    input: "{}",
  });
  const passed = evaluateWeatherInitialProbe(valid);
  assert.equal(passed.status, CHECK_STATUS.PASS);
  assert.deepEqual(passed.evidence, [
    "real AIBus Understand returned one parent-linked server GetCurrentLocation action",
    "no coordinates or fabricated location were supplied",
  ]);

  assert.equal(
    evaluateWeatherInitialProbe(
      actionResponses({
        action: "GetCurrentLocation",
        thought: "not the weather preflight thought",
      }),
    ).status,
    CHECK_STATUS.FAIL,
    "an agentic location action cannot impersonate the exact weather path",
  );
  assert.match(
    evaluateWeatherInitialProbe(
      actionResponses({
        action: "GetCurrentLocation",
        thought: "not the weather preflight thought",
      }),
    ).evidence.join(" "),
    /location_action_observed,stock_envelope_match,preflight_thought_mismatch,empty_input_match/,
  );
  assert.equal(
    evaluateWeatherInitialProbe(
      actionResponses({
        action: "GetCurrentLocation",
        thought: WEATHER_LOCATION_PREFLIGHT_THOUGHT,
        source: 0,
      }),
    ).status,
    CHECK_STATUS.FAIL,
  );
  assert.equal(
    evaluateWeatherInitialProbe(
      actionResponses({
        action: "GetCurrentLocation",
        thought: WEATHER_LOCATION_PREFLIGHT_THOUGHT,
        parentIdentifier: "some-other-user-turn",
      }),
    ).status,
    CHECK_STATUS.FAIL,
    "weather evidence must be parent-bound to the fixed matching USER turn",
  );
  assert.equal(
    evaluateWeatherInitialProbe([...valid, { kind: "legacy" }]).status,
    CHECK_STATUS.FAIL,
    "weather evidence must reject an action accompanied by any extra frame",
  );
});

test("compound nearby-route request requires one canonical location preflight", () => {
  const responses = actionResponses({
    action: "GetCurrentLocation",
    input: "{}",
    thought: AGENTIC_LOCATION_PREFLIGHT_THOUGHT,
  });
  const readiness = {
    provider: "codex",
    toolsEnabled: true,
    codexReady: true,
    maxToolTurns: 4,
  };
  const passed = evaluateCompoundNearbyRouteInitialProbe(responses, readiness);
  assert.equal(passed.status, CHECK_STATUS.PASS);
  assert.equal(passed.id, "compound_nearby_route_location_preflight");
  assert.equal(passed.title, "Compound nearby-route location preflight");
  assert.match(
    passed.evidence.join(" "),
    /exactly one parent-linked server GetCurrentLocation preflight with empty input/,
  );
  assert.match(passed.evidence.join(" "), /no final response or navigation mutation/);
  assert.doesNotMatch(JSON.stringify(passed), /agentic_json/);

  assert.equal(
    evaluateCompoundNearbyRouteInitialProbe(responses, {
      ...readiness,
      codexReady: false,
    }).status,
    CHECK_STATUS.FAIL,
  );
  const wrongThought = evaluateCompoundNearbyRouteInitialProbe(
    actionResponses({
      action: "GetCurrentLocation",
      thought: WEATHER_LOCATION_PREFLIGHT_THOUGHT,
    }),
    readiness,
  );
  assert.equal(wrongThought.status, CHECK_STATUS.FAIL);
  assert.match(
    wrongThought.evidence.join(" "),
    /readiness_match,location_action_observed,stock_envelope_match,preflight_thought_mismatch,empty_input_match/,
  );

  for (const invalidInput of [
    JSON.stringify({ Response: "not empty" }),
    JSON.stringify({ latitude: 1 }),
    "[]",
    "not-json",
  ]) {
    assert.equal(
      evaluateCompoundNearbyRouteInitialProbe(
        actionResponses({
          action: "GetCurrentLocation",
          input: invalidInput,
          thought: AGENTIC_LOCATION_PREFLIGHT_THOUGHT,
        }),
        readiness,
      ).status,
      CHECK_STATUS.FAIL,
      "the preflight must reject every non-empty or non-object input",
    );
  }

  for (const rejectedAction of [
    actionResponses({
      action: "Respond",
      input: JSON.stringify({ Response: "I need more information." }),
      thought: "I should safely decline the request",
    }),
    actionResponses({
      action: "Respond",
      input: JSON.stringify({ Response: "Starting navigation now." }),
      thought: "I should return the final answer from bounded read-only planning",
    }),
    actionResponses({
      action: "Navigate",
      thought:
        "I should execute the one validated stock action selected after bounded read-only planning",
    }),
    actionResponses({
      action: "PlayMusic",
      thought:
        "I should execute the one validated stock action selected after bounded read-only planning",
    }),
  ]) {
    assert.equal(
      evaluateCompoundNearbyRouteInitialProbe(rejectedAction, readiness).status,
      CHECK_STATUS.FAIL,
      "a response, final answer, or native mutation must not satisfy the first-step contract",
    );
  }

  const wrongEnvelope = evaluateCompoundNearbyRouteInitialProbe(
    actionResponses({
      action: "GetCurrentLocation",
      thought: AGENTIC_LOCATION_PREFLIGHT_THOUGHT,
      source: 0,
    }),
    readiness,
  );
  assert.equal(wrongEnvelope.status, CHECK_STATUS.FAIL);
  assert.match(
    wrongEnvelope.evidence.join(" "),
    /readiness_match,location_action_observed,stock_envelope_mismatch,preflight_thought_match,empty_input_match/,
  );
  assert.equal(
    evaluateCompoundNearbyRouteInitialProbe(
      actionResponses({
        action: "GetCurrentLocation",
        thought: AGENTIC_LOCATION_PREFLIGHT_THOUGHT,
        parentIdentifier: "some-other-user-turn",
      }),
      readiness,
    ).status,
    CHECK_STATUS.FAIL,
    "the preflight must remain parent-bound to the fixed USER turn",
  );
  assert.equal(
    evaluateCompoundNearbyRouteInitialProbe(
      [...responses, { kind: "legacy" }],
      readiness,
    ).status,
    CHECK_STATUS.FAIL,
    "the first-step probe must reject an otherwise valid action plus any extra frame",
  );
});

test("music evidence must match the independently observed provider rank one", () => {
  const rankOne = {
    title: "Billie Jean",
    artists: ["Michael Jackson"],
    album: "Thriller",
  };
  const passed = evaluateMusicChain(
    actionResponses({
      action: "PlayMusic",
      input: JSON.stringify({
        Track: "Billie Jean",
        Artist: "Michael Jackson",
      }),
    }),
    rankOne,
  );
  assert.equal(passed.status, CHECK_STATUS.PASS);
  assert.equal(passed.id, "music_rank_one_match_playmusic");
  assert.equal(passed.title, "PlayMusic matches observed provider rank one");
  assert.match(passed.evidence.join(" "), /rank-one result/);
  assert.match(passed.evidence.join(" "), /did not dispatch playback/);
  assert.doesNotMatch(JSON.stringify(passed), /Lookup ->|provider-grounded/);

  const wrongTitle = evaluateMusicChain(
      actionResponses({
        action: "PlayMusic",
        input: JSON.stringify({
          Track: "Thriller",
          Artist: "Michael Jackson",
        }),
      }),
      rankOne,
  );
  assert.equal(
    wrongTitle.status,
    CHECK_STATUS.FAIL,
    "a plausible but non-rank-one title must fail",
  );
  assert.match(wrongTitle.evidence.join(" "), /title_mismatch/);
  assert.match(wrongTitle.evidence.join(" "), /artist_match/);
  assert.match(wrongTitle.evidence.join(" "), /play_music_observed/);
  assert.doesNotMatch(JSON.stringify(wrongTitle), /Billie Jean|Thriller|Michael Jackson/);

  const refusal = evaluateMusicChain(
    actionResponses({
      action: "Respond",
      input: JSON.stringify({ Response: "Please try again." }),
    }),
    rankOne,
  );
  assert.equal(refusal.status, CHECK_STATUS.FAIL);
  assert.match(refusal.evidence.join(" "), /respond_observed/);
  assert.doesNotMatch(JSON.stringify(refusal), /Please try again/);
  assert.equal(
    evaluateMusicChain(
      actionResponses({
        action: "PlayMusic",
        input: JSON.stringify({
          Track: "Billie Jean",
          Artist: "Michael Jackson",
          Album: "Thriller",
        }),
      }),
      rankOne,
    ).status,
    CHECK_STATUS.PASS,
    "the optional album is allowed only when it matches the same rank-one row",
  );
  assert.equal(
    evaluateMusicChain(
      actionResponses({
        action: "PlayMusic",
        input: JSON.stringify({
          Track: "Billie Jean",
          Artist: "Michael Jackson",
          Album: "Bad",
        }),
      }),
      rankOne,
    ).status,
    CHECK_STATUS.FAIL,
    "an album from another row must fail",
  );
  assert.equal(
    evaluateMusicChain(
      actionResponses({
        action: "PlayMusic",
        input: JSON.stringify({
          Track: "Billie Jean",
          Artist: "Michael Jackson",
          Query: PROMPTS.music,
        }),
      }),
      rankOne,
    ).status,
    CHECK_STATUS.FAIL,
    "other selectors must fail the rank-one contract",
  );
  assert.equal(
    evaluateMusicChain(
      [
        ...actionResponses({
          action: "PlayMusic",
          input: JSON.stringify({
            Track: "Billie Jean",
            Artist: "Michael Jackson",
          }),
        }),
        { kind: "legacy" },
      ],
      rankOne,
    ).status,
    CHECK_STATUS.FAIL,
    "rank-one evidence must reject a valid action accompanied by any extra frame",
  );
});

test("disabled Spotify rejects native actions and false playback claims", () => {
  const safeResponse = actionResponses({
    action: "Respond",
    input: JSON.stringify({ Response: "Spotify is disabled right now." }),
  });
  const passed = evaluateDisabledSpotifyFailClosed(safeResponse, {
    disabled: true,
  });
  assert.equal(passed.status, CHECK_STATUS.PASS);
  assert.deepEqual(passed.evidence, [
    "no PlayMusic or other native action escaped while Spotify was disabled",
    "no playback-success claim was emitted",
  ]);

  assert.equal(
    evaluateDisabledSpotifyFailClosed(
      actionResponses({
        action: "PlayMusic",
        input: JSON.stringify({
          Track: "Billie Jean",
          Artist: "Michael Jackson",
        }),
      }),
      { disabled: true },
    ).status,
    CHECK_STATUS.FAIL,
  );
  assert.equal(
    evaluateDisabledSpotifyFailClosed(
      actionResponses({
        action: "Respond",
        input: JSON.stringify({ Response: "Enjoy the song." }),
      }),
      { disabled: true },
    ).status,
    CHECK_STATUS.FAIL,
    "a vague response cannot stand in for explicit unavailable evidence",
  );
  assert.equal(
    evaluateDisabledSpotifyFailClosed(
      actionResponses({
        action: "Respond",
        input: JSON.stringify({ Response: "Now playing the top song." }),
      }),
      { disabled: true },
    ).status,
    CHECK_STATUS.FAIL,
  );
  assert.equal(
    evaluateDisabledSpotifyFailClosed([], { disabled: false }).status,
    CHECK_STATUS.PENDING,
  );
});

test("Tickle requires stock-cache evidence, exact phrases, and a negative control", () => {
  const responses = new Map(
    PROMPTS.tickle.map((phrase) => [
      phrase,
      actionResponses({ action: "Tickle", input: "{}" }),
    ]),
  );
  responses.set(PROMPTS.tickleNegative, []);
  const passed = evaluateTickleRouting(responses, {
    tickleEnabled: true,
    stockCacheVerified: true,
  });
  assert.equal(passed.status, CHECK_STATUS.PASS);
  assert.match(passed.evidence.join(" "), /all three exact stock phrases/);
  assert.match(passed.evidence.join(" "), /non-exact control/);
  assert.match(passed.evidence.join(" "), /did not dispatch or launch/);
  assert.equal(
    evaluateTickleRouting(responses, {
      tickleEnabled: false,
      stockCacheVerified: true,
    }).status,
    CHECK_STATUS.FAIL,
    "the evaluator must consume the live readiness context key",
  );

  responses.delete("tickle my fancy");
  assert.equal(
    evaluateTickleRouting(responses, {
      tickleEnabled: true,
      stockCacheVerified: true,
    }).status,
    CHECK_STATUS.FAIL,
  );
  responses.set(
    "tickle my fancy",
    actionResponses({ action: "Tickle", input: "{}" }),
  );
  responses.set(
    PROMPTS.tickleNegative,
    actionResponses({ action: "Tickle", input: "{}" }),
  );
  assert.equal(
    evaluateTickleRouting(responses, {
      tickleEnabled: true,
      stockCacheVerified: true,
    }).status,
    CHECK_STATUS.FAIL,
    "the non-exact control must never authorize Tickle",
  );
  assert.equal(
    evaluateTickleRouting(new Map(), {
      tickleEnabled: true,
      stockCacheVerified: false,
    }).status,
    CHECK_STATUS.FAIL,
  );

  const responsesWithExtraFrame = new Map(
    PROMPTS.tickle.map((phrase) => [
      phrase,
      actionResponses({ action: "Tickle", input: "{}" }),
    ]),
  );
  responsesWithExtraFrame.set(PROMPTS.tickleNegative, []);
  responsesWithExtraFrame.set("tickle tickle tickle", [
    ...actionResponses({ action: "Tickle", input: "{}" }),
    { kind: "legacy" },
  ]);
  assert.equal(
    evaluateTickleRouting(responsesWithExtraFrame, {
      tickleEnabled: true,
      stockCacheVerified: true,
    }).status,
    CHECK_STATUS.FAIL,
    "Tickle evidence must reject a valid action accompanied by any extra frame",
  );
});

/// Builds the streamed interim shape the server emits for a tool batch: one
/// parent-linked ACTION turn named after the batch's first tool, one paired
/// OBSERVATION turn carrying that registered name and a closed status JSON,
/// and a terminal action. Parent linkage matches the live chain contract.
function toolCueResponses(batches, { terminal = "Respond" } = {}) {
  const messages = [];
  let parentIdentifier = SMOKE_USER_TURN_ID;
  batches.forEach((batch, index) => {
    const actionIdentifier = `cue-${index}`;
    messages.push(
      buildActionResponseFixture({
        action: batch.tool,
        input: "{}",
        thought: "",
        identifier: actionIdentifier,
        parentIdentifier,
      }),
    );
    parentIdentifier = actionIdentifier;
    if (batch.observation !== undefined && batch.observation !== null) {
      const observationIdentifier = `observation-${index}`;
      messages.push(
        buildObservationResponseFixture({
          actionName: batch.observationName ?? batch.tool,
          observation: JSON.stringify(batch.observation),
          identifier: observationIdentifier,
          parentIdentifier,
        }),
      );
      parentIdentifier = observationIdentifier;
    }
  });
  if (terminal !== null) {
    messages.push(
      buildActionResponseFixture({
        action: terminal,
        input: JSON.stringify({ Response: "fixture answer" }),
        identifier: "terminal-action",
        parentIdentifier,
      }),
    );
  }
  return decodeUnderstandingResponses(
    parseGrpcFrames(Buffer.concat(messages.map(wrapGrpcFrame))),
  );
}

const BRAVE_READY = { braveSearchReady: true, progressTurnsEnabled: true };

test("web-search evidence separates planner selection from provider success", () => {
  const selected = evaluateWebSearch(
    toolCueResponses([{ tool: "web_search", observation: { status: "ok" } }]),
    BRAVE_READY,
  );
  assert.equal(selected.status, CHECK_STATUS.PASS);
  assert.equal(selected.id, WEB_SEARCH_CHECK_ID);
  assert.deepEqual(selected.observed, {
    webSearchSelected: true,
    webSearchOkCount: 1,
    reason: null,
    finalRespondEmitted: true,
    nativeMutationEmitted: false,
  });
  assert.match(selected.evidence.join(" "), /planner selected the web_search tool/);
  assert.match(selected.evidence.join(" "), /web_search_selected/);

  // The entire point of the fixture: a selected tool whose query the grounding
  // gate refuses is NOT the same result as a tool that was never selected.
  const refused = evaluateWebSearch(
    toolCueResponses([
      {
        tool: "web_search",
        observation: { status: "unavailable", reason: "not_grounded" },
      },
    ]),
    BRAVE_READY,
  );
  assert.equal(refused.status, CHECK_STATUS.PASS);
  assert.equal(refused.observed.webSearchSelected, true);
  assert.equal(refused.observed.webSearchOkCount, 0);
  assert.equal(refused.observed.reason, "not_grounded");
  assert.match(refused.evidence.join(" "), /planner selected the web_search tool/);
  assert.match(
    refused.evidence.join(" "),
    /no web_search execution succeeded; bucketed failure reason: not_grounded/,
  );

  const neverSelected = evaluateWebSearch(
    toolCueResponses([
      { tool: "knowledge_lookup", observation: { status: "ok" } },
    ]),
    BRAVE_READY,
  );
  assert.equal(neverSelected.status, CHECK_STATUS.FAIL);
  assert.equal(neverSelected.observed.webSearchSelected, false);
  assert.equal(neverSelected.observed.webSearchOkCount, 0);
  assert.equal(neverSelected.observed.reason, null);
  assert.match(
    neverSelected.evidence.join(" "),
    /never selected the web_search tool/,
  );
  assert.match(neverSelected.evidence.join(" "), /web_search_not_selected/);
});

test("web-search failure reasons stay inside the closed vocabulary", () => {
  const rawReason = "brave rejected this query outright";
  const unknown = evaluateWebSearch(
    toolCueResponses([
      {
        tool: "web_search",
        observation: { status: "unavailable", reason: rawReason },
      },
    ]),
    BRAVE_READY,
  );
  assert.equal(unknown.observed.webSearchSelected, true);
  assert.equal(unknown.observed.reason, "unspecified");
  assert.ok(
    TOOL_FAILURE_REASONS.includes(unknown.observed.reason),
    "an unrecognized reason must map into the closed set",
  );
  assert.doesNotMatch(JSON.stringify(unknown), /brave rejected/);

  // No reason field at all, and a batch that never reported an end, still
  // report the selection with a bucketed placeholder rather than raw text.
  const noReason = evaluateWebSearch(
    toolCueResponses([
      { tool: "web_search", observation: { status: "unavailable" } },
    ]),
    BRAVE_READY,
  );
  assert.equal(noReason.observed.reason, "unspecified");
  const unfinished = evaluateWebSearch(
    toolCueResponses([{ tool: "web_search" }]),
    BRAVE_READY,
  );
  assert.equal(unfinished.observed.webSearchSelected, true);
  assert.equal(unfinished.observed.reason, "unspecified");
});

test("web-search selection rejects predicted cues and native escapes", () => {
  // A predicted/parity cue streams the tool name with a truthful `pending`
  // observation before anything ran; it must never count as a selection.
  const predictedOnly = evaluateWebSearch(
    toolCueResponses([
      { tool: "web_search", observation: { status: "pending" } },
      { tool: "knowledge_lookup", observation: { status: "ok" } },
    ]),
    BRAVE_READY,
  );
  assert.equal(predictedOnly.status, CHECK_STATUS.FAIL);
  assert.equal(predictedOnly.observed.webSearchSelected, false);

  const predictedThenReal = evaluateWebSearch(
    toolCueResponses([
      { tool: "web_search", observation: { status: "pending" } },
      { tool: "web_search", observation: { status: "ok" } },
    ]),
    BRAVE_READY,
  );
  assert.equal(predictedThenReal.status, CHECK_STATUS.PASS);
  assert.equal(predictedThenReal.observed.webSearchSelected, true);
  assert.equal(predictedThenReal.observed.webSearchOkCount, 1);

  const nativeEscape = evaluateWebSearch(
    toolCueResponses([{ tool: "web_search", observation: { status: "ok" } }], {
      terminal: "PlayMusic",
    }),
    BRAVE_READY,
  );
  assert.equal(nativeEscape.status, CHECK_STATUS.FAIL);
  assert.equal(nativeEscape.observed.webSearchSelected, true);
  assert.equal(nativeEscape.observed.nativeMutationEmitted, true);
  assert.equal(nativeEscape.observed.finalRespondEmitted, false);

  const mutationCue = evaluateWebSearch(
    toolCueResponses([
      { tool: "web_search", observation: { status: "ok" } },
      { tool: "send_message", observation: { status: "ok" } },
    ]),
    BRAVE_READY,
  );
  assert.equal(mutationCue.status, CHECK_STATUS.FAIL);
  assert.equal(mutationCue.observed.nativeMutationEmitted, true);
});

test("an unconfigured search provider is pending evidence, not a failure", () => {
  for (const readiness of [
    { braveSearchReady: false, progressTurnsEnabled: true },
    {},
    undefined,
  ]) {
    const pending = evaluateWebSearch(
      toolCueResponses([{ tool: "web_search", observation: { status: "ok" } }]),
      readiness,
    );
    assert.equal(pending.status, CHECK_STATUS.PENDING);
    assert.equal(pending.id, WEB_SEARCH_CHECK_ID);
    assert.match(pending.evidence.join(" "), /brave_search\.has_api_key/);
    assert.equal(pending.observed, undefined);
  }

  // The in-band signal itself can be switched off, and an unobservable
  // selection must never be reported as a planner failure.
  const noSignal = evaluateWebSearch(
    toolCueResponses([{ tool: "knowledge_lookup", observation: { status: "ok" } }]),
    { braveSearchReady: true, progressTurnsEnabled: false },
  );
  assert.equal(noSignal.status, CHECK_STATUS.PENDING);
  assert.match(noSignal.evidence.join(" "), /hermes_progress_turns/);

  // The precondition must not become a blocking readiness gate: an
  // unconfigured optional provider cannot fail-skip every other AIBus probe.
  const fixture = structuredClone(readinessFixture());
  fixture.settings.brave_search.has_api_key = false;
  fixture.settings.llm.hermes_progress_turns = false;
  const readiness = evaluateReadiness(fixture);
  assert.equal(readiness.context.braveSearchReady, false);
  assert.equal(readiness.context.progressTurnsEnabled, false);
  assert.equal(readiness.checks.length, 9);
  assert.ok(readiness.checks.every((check) => check.status === CHECK_STATUS.PASS));
  assert.equal(
    evaluateWebSearch([], readiness.context).status,
    CHECK_STATUS.PENDING,
  );
});

test("readiness validates release identity, loopback, providers, Codex, and Tickle delivery", () => {
  assert.equal(isRequiredReleaseVersion(RELEASE_IDENTITY.versionName), true);
  assert.equal(isRequiredReleaseVersion("2026-07-16.29-local"), false);
  assert.equal(isRequiredReleaseVersion("2026-07-31.1-local"), false);
  assert.equal(isRequiredReleaseVersion("1.35"), false);
  assert.equal(isRequiredReleaseVersion("999.35-local"), false);
  assert.equal(isRequiredReleaseVersion("2025-01-01.35-local"), false);
  assert.equal(parseLoopbackGrpcPort("127.0.0.1:9090"), 9090);
  assert.equal(parseLoopbackGrpcPort("[::1]:9090"), 9090);
  assert.equal(parseLoopbackGrpcPort("0.0.0.0:9090"), null);

  const readiness = evaluateReadiness(readinessFixture());
  assert.equal(readiness.checks.length, 9);
  assert.ok(readiness.checks.every((check) => check.status === CHECK_STATUS.PASS));
  assert.deepEqual(readiness.context, {
    grpcPort: 9090,
    provider: "codex",
    toolsEnabled: true,
    maxToolTurns: 12,
    codexReady: true,
    braveSearchReady: true,
    progressTurnsEnabled: true,
    publicPlaceResolverReady: true,
    spotifyReady: true,
    spotifyDisabled: false,
    tickleEnabled: true,
    stockCacheVerified: true,
  });

  const disabledFixture = readinessFixture({
    spotify: {
      enabled: false,
      experimental_acknowledged: true,
      state: "disabled",
      engine_ready: false,
    },
  });
  const negative = evaluateReadiness(disabledFixture, {
    expectSpotifyDisabled: true,
  });
  assert.equal(
    negative.checks.find((check) => check.id === "spotify_provider_precondition")
      .status,
    CHECK_STATUS.PASS,
  );
  assert.equal(negative.context.spotifyDisabled, true);

  const unsafeSettings = structuredClone(readinessFixture());
  unsafeSettings.settings.llm.api_key = "must-not-be-exposed";
  assert.equal(
    evaluateReadiness(unsafeSettings).checks.find(
      (check) => check.id === "settings_secret_safety",
    ).status,
    CHECK_STATUS.FAIL,
  );

  for (const [field, wrongValue] of [
    ["packageName", "com.example.not-penumbra"],
    ["versionName", "2026-07-16.35-rebuilt"],
    ["versionCode", RELEASE_IDENTITY.versionCode + 1],
    ["apkSha256", "0".repeat(64)],
  ]) {
    const wrongIdentity = structuredClone(readinessFixture());
    wrongIdentity.packageIdentity[field] = wrongValue;
    assert.equal(
      evaluateReadiness(wrongIdentity).checks.find(
      (check) => check.id === "server_release_identity",
      ).status,
      CHECK_STATUS.FAIL,
      `${field} must be exact`,
    );
  }
});

test("live feature-flag tagged values recognize applied Tickle assignment", () => {
  const liveSchema = readinessFixture({
    featureFlags: liveFeatureFlagsResponseFixture(),
  });
  const readiness = evaluateReadiness(liveSchema);
  assert.equal(
    readiness.checks.find((check) => check.id === "tickle_feature_delivery")
      .status,
    CHECK_STATUS.PASS,
  );
  assert.equal(readiness.context.tickleEnabled, true);
  assert.equal(readiness.context.stockCacheVerified, true);

  for (const mutate of [
    (response) => {
      response.flags[0].desired_value = true;
    },
    (response) => {
      response.flags[0].assignment_value = null;
    },
    (response) => {
      response.delivery.state = "grpc_fetched";
    },
    (response) => {
      response.delivery.stock_cache_verified = false;
    },
  ]) {
    const featureFlags = liveFeatureFlagsResponseFixture();
    mutate(featureFlags);
    const rejected = evaluateReadiness(readinessFixture({ featureFlags }));
    assert.equal(
      rejected.checks.find((check) => check.id === "tickle_feature_delivery")
        .status,
      CHECK_STATUS.FAIL,
    );
  }
});

test("Spotify readiness remains fail-closed without explicit engine readiness", () => {
  const fixture = readinessFixture();
  delete fixture.spotify.engine_ready;
  const readiness = evaluateReadiness(fixture);
  assert.equal(
    readiness.checks.find(
      (check) => check.id === "spotify_provider_precondition",
    ).status,
    CHECK_STATUS.FAIL,
  );
  assert.equal(readiness.context.spotifyReady, false);

  const disabledFixture = readinessFixture({
    spotify: {
      enabled: false,
      experimental_acknowledged: true,
      state: "disabled",
    },
  });
  const disabled = evaluateReadiness(disabledFixture, {
    expectSpotifyDisabled: true,
  });
  assert.equal(
    disabled.checks.find(
      (check) => check.id === "spotify_provider_precondition",
    ).status,
    CHECK_STATUS.FAIL,
  );
  assert.equal(disabled.context.spotifyDisabled, false);
});

test("every failed prerequisite blocks tunnel creation and all raw AIBus probes", async () => {
  const failureCases = [
    ["runtime health version", ({ snapshot }) => {
      snapshot.health.version = "2026-07-16.29-local";
    }],
    ["installed package name", ({ identity }) => {
      identity.packageName = "com.example.not-penumbra";
    }],
    ["installed versionName", ({ identity }) => {
      identity.versionName = "2026-07-16.35-rebuilt";
    }],
    ["installed versionCode", ({ identity }) => {
      identity.versionCode += 1;
    }],
    ["active APK digest", ({ identity }) => {
      identity.apkSha256 = "0".repeat(64);
    }],
    ["admin-token authentication", ({ snapshot }) => {
      snapshot.settings.server.admin_token_auth = false;
    }],
    ["sanitized settings", ({ snapshot }) => {
      snapshot.settings.llm.api_key = "must-never-be-reported";
    }],
    ["loopback AIBus listener", ({ snapshot }) => {
      snapshot.settings.server.grpc_bind_addr = "0.0.0.0:9090";
    }],
    ["Codex provider", ({ snapshot }) => {
      snapshot.settings.llm.provider = "openai";
    }],
    ["bounded tools enabled", ({ snapshot }) => {
      snapshot.settings.llm.tools.enabled = false;
    }],
    ["bounded tool turns", ({ snapshot }) => {
      snapshot.settings.llm.tools.max_tool_turns = 1;
    }],
    ["Codex bridge readiness", ({ snapshot }) => {
      snapshot.codex.ready = false;
      snapshot.codex.state = "unavailable";
    }],
    ["weather provider readiness", ({ snapshot }) => {
      snapshot.settings.weather.has_api_key = false;
    }],
    ["public place resolver readiness", ({ snapshot }) => {
      snapshot.settings.openstreetmap.enabled = false;
    }],
    ["Spotify provider readiness", ({ snapshot }) => {
      snapshot.spotify.engine_ready = false;
    }],
    ["Tickle desired assignment", ({ snapshot }) => {
      snapshot.featureFlags.flags[0].desired_value.value = false;
    }],
    ["Tickle emitted assignment", ({ snapshot }) => {
      snapshot.featureFlags.flags[0].assignment_value.value = false;
    }],
    ["stock-cache delivery state", ({ snapshot }) => {
      snapshot.featureFlags.delivery.state = "grpc_fetched";
    }],
    ["stock-cache acknowledgement", ({ snapshot }) => {
      snapshot.featureFlags.delivery.stock_cache_verified = false;
    }],
  ];

  for (const [label, mutate] of failureCases) {
    const fixture = structuredClone(readinessFixture());
    const identity = fixture.packageIdentity;
    delete fixture.packageIdentity;
    const state = { aibusCalls: 0, report: null, order: [] };
    mutate({ snapshot: fixture, identity });

    const exitCode = await main(
      ["--serial", "fixture-device", "--run-safe-aibus", "--json"],
      {
        verifyExplicitDevice: async () => state.order.push("serial"),
        collectInstalledServerIdentity: async () => {
          state.order.push("identity");
          return identity;
        },
        readAdminToken: async () => {
          state.order.push("token");
          return "fixture-admin-token-0123456789";
        },
        collectReadiness: async () => {
          state.order.push("readiness");
          return fixture;
        },
        runAibusChecks: async () => {
          state.aibusCalls += 1;
          return [];
        },
        printReport: (report) => {
          state.report = report;
        },
      },
    );

    assert.deepEqual(
      state.order,
      ["serial", "identity", "token", "readiness"],
      `${label}: serial and identity must precede readiness`,
    );
    assert.equal(
      state.aibusCalls,
      0,
      `${label}: tunnel/AIBus runner must not be entered`,
    );
    assert.equal(exitCode, 1, `${label}: failed gate must fail the run`);
    assert.equal(state.report.status, "failed", label);
    assert.ok(
      state.report.checks
        .filter((check) => check.status === CHECK_STATUS.PENDING)
        .every((check) =>
          check.evidence.includes(
            "not executed because a required identity or readiness gate failed",
          ),
        ),
      `${label}: skipped probes must be explicit`,
    );
  }
});

test("all exact prerequisites permit safe AIBus inspection but physical gates remain incomplete", async () => {
  const fixture = readinessFixture();
  const identity = fixture.packageIdentity;
  delete fixture.packageIdentity;
  let aibusCalls = 0;
  let report;
  const exitCode = await main(
    ["--serial", "fixture-device", "--run-safe-aibus", "--json"],
    {
      verifyExplicitDevice: async () => {},
      collectInstalledServerIdentity: async () => identity,
      readAdminToken: async () => "fixture-admin-token-0123456789",
      collectReadiness: async () => fixture,
      runAibusChecks: async () => {
        aibusCalls += 1;
        return [];
      },
      printReport: (value) => {
        report = value;
      },
    },
  );

  assert.equal(aibusCalls, 1);
  assert.equal(report.status, "incomplete");
  assert.equal(report.complete, false);
  assert.equal(exitCode, INCOMPLETE_EXIT_CODE);
  assert.ok(report.manualChecks.every((check) => check.status === CHECK_STATUS.PENDING));
});

test("inspect mode reports pending AIBus evidence as machine-incomplete", async () => {
  const fixture = readinessFixture();
  const identity = fixture.packageIdentity;
  delete fixture.packageIdentity;
  let aibusCalls = 0;
  let report;
  const exitCode = await main(
    ["--serial", "fixture-device", "--inspect", "--json"],
    {
      verifyExplicitDevice: async () => {},
      collectInstalledServerIdentity: async () => identity,
      readAdminToken: async () => "fixture-admin-token-0123456789",
      collectReadiness: async () => fixture,
      runAibusChecks: async () => {
        aibusCalls += 1;
        return [];
      },
      printReport: (value) => {
        report = value;
      },
    },
  );

  assert.equal(aibusCalls, 0);
  assert.equal(report.status, "incomplete");
  assert.equal(report.complete, false);
  assert.ok(
    report.checks.some(
      (check) =>
        check.id === "compound_nearby_route_location_preflight" &&
        check.status === CHECK_STATUS.PENDING,
    ),
  );
  assert.equal(exitCode, INCOMPLETE_EXIT_CODE);
});

test("manual evidence is exact about non-automatable physical effects", () => {
  const manual = manualVerificationChecks();
  const text = JSON.stringify(manual);
  assert.equal(manual.length, 4);
  assert.ok(manual.every((check) => check.status === CHECK_STATUS.PENDING));
  assert.match(text, /USER -> server GetCurrentLocation -> DEVICE observation -> server Respond/);
  assert.match(text, /exactly one location action/);
  assert.match(text, /media session that enters PLAYING with advancing position/);
  assert.match(text, /launch exactly once per phrase/);
  assert.match(text, /--expect-spotify-disabled/);
  assert.doesNotMatch(text, /55\.6761|12\.5683|unit-secret/);
});

test("public reports contain only bounded evidence and failures control exit", () => {
  const secret = "report-secret-canary";
  const report = buildPublicReport({
    mode: "inspect",
    checks: [
      {
        id: "one",
        title: "One",
        status: CHECK_STATUS.PASS,
        evidence: [`Bearer ${secret}`],
      },
      {
        id: "two",
        title: "Two",
        status: CHECK_STATUS.FAIL,
        evidence: ["bounded failure"],
      },
    ],
    manualChecks: manualVerificationChecks(),
  });
  const safe = redactSensitive(report, { knownSecrets: [secret] });
  const human = renderHumanReport(safe);
  assert.doesNotMatch(human, /report-secret-canary/);
  assert.match(human, /Bearer \[REDACTED\]/);
  assert.match(human, /1 passed, 1 failed, 4 pending/);
  assert.equal(report.status, "failed");
  assert.equal(report.complete, false);
  assert.deepEqual(report.requiredServerIdentity, RELEASE_IDENTITY);
  assert.equal(report.safety.nativeActionsDispatched, false);
  assert.equal(report.safety.coordinatesCollected, false);
  assert.equal(reportExitCode(report), 1);

  const incomplete = buildPublicReport({
    mode: "inspect",
    checks: [
      {
        id: "pending",
        title: "Pending",
        status: CHECK_STATUS.PENDING,
        evidence: ["not run"],
      },
    ],
    manualChecks: [],
  });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.complete, false);
  assert.equal(reportExitCode(incomplete), INCOMPLETE_EXIT_CODE);
  assert.match(renderHumanReport(incomplete), /Status: INCOMPLETE/);

  const complete = buildPublicReport({
    mode: "self-check",
    checks: [
      {
        id: "pass",
        title: "Pass",
        status: CHECK_STATUS.PASS,
        evidence: ["bounded"],
      },
    ],
    manualChecks: [],
  });
  assert.equal(complete.status, "passed");
  assert.equal(complete.complete, true);
  assert.equal(reportExitCode(complete), 0);
});





test("collectReadiness accepts optional deadline and now parameters", async () => {
  // Named property: deadline and now are OPTIONAL. `Function.length` counts
  // params before the first defaulted one, so it is 2 (options, token) only
  // while deadline and now keep their defaults; making either required flips it
  // to 3. The old test grepped the stringified body for the substrings
  // "deadline"/"now", which stay present even if the parameters are deleted —
  // it could not fail for the property it named.
  assert.equal(
    collectReadiness.length,
    2,
    "deadline and now must remain optional (defaulted) parameters",
  );

  // And the deadline must be ENFORCED, not merely accepted: an already-elapsed
  // deadline aborts before any ADB call (deviceJsonGet throws on no remaining
  // budget). `now` is injected, so this needs no real clock and no device.
  const options = {
    adbPath: "/fixture/adb-must-not-run",
    serial: "device-123._:usb",
  };
  await assert.rejects(
    collectReadiness(options, "fixture-admin-token", 1_000, () => 5_000),
    /remaining time budget|deadline/,
    "an already-elapsed deadline must abort readiness collection before ADB",
  );
});
