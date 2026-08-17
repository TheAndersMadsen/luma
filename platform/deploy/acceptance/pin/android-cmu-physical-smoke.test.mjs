import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  ASSOCIATION_TRUST_CONTRACT,
  CMU_PHYSICAL_CONTRACT,
  COMPANION_IDENTITY_CONTRACT,
  DEDUP_SETTLE_CONTRACT,
  INCOMPLETE_STATES,
  IOS_NON_REGRESSION_GATE,
  ROLE_PREFLIGHT,
  RUN_CORRELATION_CONTRACT,
  TRANSPORT_RESET_CONTRACT,
  assertAssociationTrust,
  assertCompanionIdentityMatch,
  assertDistinctDeviceRoles,
  assertListenerGrantExact,
  assertLiveGattReady,
  assertPhysicalAcceptanceContractsAvailable,
  assertPhysicalSmokeComplete,
  assertRolePreflight,
  assertRunCorrelationAvailable,
  assertHarnessAdbCommand,
  assertTransportReset,
  buildAssociationTrustProbeScript,
  buildBoundaryArgs,
  buildBoundedAdbSpawnOptions,
  buildCancelArgs,
  buildLiveGattProbeScript,
  buildSentinelAbsenceProbeScript,
  buildVisiblePolicyProbeScript,
  executeSentinelCleanup,
  orderedEventsObserved,
  parseAssociationStatusOutput,
  parseAuditEvents,
  parseCmuPhysicalArgs as parseCmuPhysicalArgsWithEnvironment,
  parseCompanionIdentityOutput,
  parseListenerGrantOutput,
  parsePinCompositionTokens,
  parseRolePreflightOutput,
  parseTransportResetOutput,
  main,
  normalizeBoundedAdbResult,
  parseLiveGattProbeOutput,
  runPhysicalSmoke,
  selfCheck,
  verifySentinelDeduplication,
  verifySentinelLifecycleOrdering,
  verifySentinelRemovalSequence,
  verifySentinelUpdateSequence,
  waitForStableEventSnapshot,
} from "./android-cmu-physical-smoke.mjs";

const PIXEL_SERIAL = "fixture-pixel-serial";
const PIN_SERIAL = "fixture-pin-serial";
const OTHER_SERIAL = "fixture-other-device";
const parseCmuPhysicalArgs = (argv, environment = {}) =>
  parseCmuPhysicalArgsWithEnvironment(argv, environment);

function liveArgs() {
  return [
    "--run",
    "--pixel-serial", PIXEL_SERIAL,
    "--expected-pixel-serial", PIXEL_SERIAL,
    "--pin-serial", PIN_SERIAL,
    "--expected-pin-serial", PIN_SERIAL,
    "--expect-apk-sha256", CMU_PHYSICAL_CONTRACT.apkSha256,
  ];
}

function associationEvidence(overrides = {}) {
  const values = {
    association_store_readable: true,
    association_package_exact: true,
    association_unique: true,
    association_peer_present: true,
    bond_store_readable: true,
    association_bond_peer_match: true,
    ...overrides,
  };
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
}

function completePhysicalResult(overrides = {}) {
  return {
    transportFreshResetVerified: true,
    preStateAbsent: true,
    ancsAddSequenceVerified: true,
    ancsUpdateSequenceVerified: true,
    sentinelDeduplicationVerified: true,
    pinCategorizationVerified: true,
    pinSummarizationObserved: true,
    ancsRemovalObserved: true,
    sentinelLifecycleOrdered: true,
    broadUnlistedSourceVerified: true,
    postStateRestored: true,
    incompleteReasons: [],
    complete: true,
    ...overrides,
  };
}

function executeSyntheticAssociationProbe({ associationRows, bondRows }) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const associationPrint = associationRows.map(quote).join(" ");
  const bondPrint = bondRows.map(quote).join(" ");
  const script = [
    `am(){ printf '%s\\n' '0'; }; `,
    `cmd(){ printf '%s\\n' ${associationPrint}; }; `,
    `dumpsys(){ printf '%s\\n' ${bondPrint}; }; `,
    buildAssociationTrustProbeScript(),
  ].join("");
  const result = spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  return parseAssociationStatusOutput(result.stdout);
}

function executeContentFreeProbe(script, input) {
  return spawnSync("/bin/sh", ["-c", script], {
    input,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  });
}

test("live CLI locks both operator-confirmed serials and the reviewed APK hash", () => {
  assert.deepEqual(parseCmuPhysicalArgs(liveArgs()), {
    mode: "run",
    pixelSerial: PIXEL_SERIAL,
    expectedPixelSerial: PIXEL_SERIAL,
    pinSerial: PIN_SERIAL,
    expectedPinSerial: PIN_SERIAL,
    expectedApkSha256: CMU_PHYSICAL_CONTRACT.apkSha256,
    help: false,
  });
  const wrongPixel = liveArgs();
  wrongPixel[wrongPixel.indexOf("--pixel-serial") + 1] = OTHER_SERIAL;
  assert.throws(() => parseCmuPhysicalArgs(wrongPixel), /operator-confirmed Pixel/);
  const wrongPin = liveArgs();
  wrongPin[wrongPin.indexOf("--pin-serial") + 1] = OTHER_SERIAL;
  assert.throws(() => parseCmuPhysicalArgs(wrongPin), /operator-confirmed AI Pin/);
  const wrongHash = liveArgs();
  wrongHash[wrongHash.indexOf("--expect-apk-sha256") + 1] = "0".repeat(64);
  assert.throws(() => parseCmuPhysicalArgs(wrongHash), /exact reviewed companion/);
  const environmentArgs = liveArgs().filter(
    (value, index, values) =>
      !["--expected-pixel-serial", "--expected-pin-serial"].includes(value) &&
      !["--expected-pixel-serial", "--expected-pin-serial"].includes(values[index - 1]),
  );
  assert.doesNotThrow(() =>
    parseCmuPhysicalArgs(environmentArgs, {
      PENUMBRA_EXPECTED_PIXEL_SERIAL: PIXEL_SERIAL,
      PENUMBRA_EXPECTED_PIN_SERIAL: PIN_SERIAL,
    }),
  );
});

test("imported physical runner enforces exact serial and APK identity before adb", () => {
  assert.throws(
    () => runPhysicalSmoke({
      pixelSerial: OTHER_SERIAL,
      expectedPixelSerial: PIXEL_SERIAL,
      pinSerial: PIN_SERIAL,
      expectedPinSerial: PIN_SERIAL,
      expectedApkSha256: CMU_PHYSICAL_CONTRACT.apkSha256,
    }),
    /operator-confirmed Pixel/,
  );
  assert.throws(
    () => runPhysicalSmoke({
      pixelSerial: PIXEL_SERIAL,
      expectedPixelSerial: PIXEL_SERIAL,
      pinSerial: OTHER_SERIAL,
      expectedPinSerial: PIN_SERIAL,
      expectedApkSha256: CMU_PHYSICAL_CONTRACT.apkSha256,
    }),
    /operator-confirmed AI Pin/,
  );
  assert.throws(
    () => runPhysicalSmoke({
      pixelSerial: PIXEL_SERIAL,
      expectedPixelSerial: PIXEL_SERIAL,
      pinSerial: PIN_SERIAL,
      expectedPinSerial: PIN_SERIAL,
      expectedApkSha256: "0".repeat(64),
    }),
    /exact reviewed companion/,
  );
});

test("distinct roles rejects identical serials for Pixel and AI Pin", () => {
  assert.throws(
    () => assertDistinctDeviceRoles(PIXEL_SERIAL, PIXEL_SERIAL),
    /distinct verified physical devices/,
  );
  assert.throws(
    () => assertDistinctDeviceRoles(null, PIN_SERIAL),
    /both.*required/,
  );
  assert.throws(
    () => assertDistinctDeviceRoles(PIXEL_SERIAL, null),
    /both.*required/,
  );
  assert.doesNotThrow(() => assertDistinctDeviceRoles(PIXEL_SERIAL, PIN_SERIAL));
});

test("physical runner rejects identical serials for both roles", () => {
  assert.throws(
    () => runPhysicalSmoke({
      pixelSerial: PIXEL_SERIAL,
      expectedPixelSerial: PIXEL_SERIAL,
      pinSerial: PIXEL_SERIAL,
      expectedPinSerial: PIXEL_SERIAL,
      expectedApkSha256: CMU_PHYSICAL_CONTRACT.apkSha256,
    }),
    /distinct verified physical devices/,
  );
});

test("cleanup cancellation still runs when removal boundary logging fails", () => {
  let cancellations = 0;
  assert.throws(
    () => executeSentinelCleanup({
      preStateAbsent: true,
      posted: false,
      writeRemovalBoundary: () => { throw new Error("boundary unavailable"); },
      cancel: () => { cancellations += 1; },
      waitForRemoval: () => false,
      sentinelAbsent: () => true,
    }),
    /boundary unavailable/,
  );
  assert.equal(cancellations, 1);
});

test("posted sentinel requires removal transport evidence", () => {
  assert.throws(
    () => executeSentinelCleanup({
      preStateAbsent: true,
      posted: true,
      writeRemovalBoundary: () => {},
      cancel: () => {},
      waitForRemoval: () => false,
      sentinelAbsent: () => true,
    }),
    /removal transport evidence/,
  );
});

test("bounded cleanup timeout prevents indefinite hangs", () => {
  const start = Date.now();
  assert.throws(
    () => executeSentinelCleanup({
      preStateAbsent: true,
      posted: true,
      writeRemovalBoundary: () => {},
      cancel: () => {},
      waitForRemoval: () => {
        const shared = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(shared, 0, 0, 200);
        return false;
      },
      sentinelAbsent: () => {
        const shared = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(shared, 0, 0, 200);
        return false;
      },
      timeoutMs: 100,
    }),
    /bounded timeout/,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, "cleanup should be bounded well under 5 seconds");
});

test("cleanup never cancels notification state that predates the run", () => {
  let boundaries = 0;
  let cancellations = 0;
  assert.throws(
    () => executeSentinelCleanup({
      preStateAbsent: false,
      posted: false,
      writeRemovalBoundary: () => { boundaries += 1; },
      cancel: () => { cancellations += 1; },
      waitForRemoval: () => false,
      sentinelAbsent: () => false,
    }),
    /present before the run/,
  );
  assert.equal(boundaries, 0);
  assert.equal(cancellations, 0);
});

test("cleanup is the Pixel-framework-proven shell notification transaction", () => {
  assert.deepEqual(buildCancelArgs(), [
    "shell", "service", "call", "notification", "8",
    "s16", "com.android.shell",
    "s16", "com.android.shell",
    "s16", "penumbra_cmu_sentinel_v1",
    "i32", "2020",
    "i32", "0",
  ]);
});

test("sentinel absence probe distinguishes command failure, presence, and absence", () => {
  const probe = buildSentinelAbsenceProbeScript();
  const runProbe = (cmdBody) => spawnSync(
    "/bin/sh",
    ["-c", `cmd(){ ${cmdBody}; }; ${probe}`],
    { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 },
  );
  const failed = runProbe("return 1");
  assert.equal(failed.status, 2);
  assert.equal(failed.stdout, "");

  const present = runProbe("printf '%s\\n' 'synthetic:penumbra_cmu_sentinel_v1'");
  assert.equal(present.status, 1);
  assert.equal(present.stdout, "");

  const absent = runProbe("printf '%s\\n' 'synthetic:unrelated'");
  assert.equal(absent.status, 0);
  assert.equal(absent.stdout, "");
});

test("content-free boundaries are emitted at the info priority consumed by the parser", () => {
  assert.deepEqual(buildBoundaryArgs("cmu-add-safe"), [
    "shell", "log", "-p", "i", "-t", "PenumbraCmuSmoke", "boundary=cmu-add-safe",
  ]);
  assert.throws(() => buildBoundaryArgs("unsafe/value"), /invalid content-free boundary/);
});

test("content-free audit parser starts at the latest exact boundary", () => {
  const output = [
    "I/PenumbraCmu( 10): event=eligible_notification_queued",
    "I/PenumbraCmuSmoke( 11): boundary=cmu-add-old",
    "I/PenumbraCmu( 10): event=notification_source_dispatched",
    "I/PenumbraCmuSmoke( 11): boundary=cmu-add-current",
    "I/PenumbraCmu( 10): event=eligible_notification_queued",
    "I/PenumbraCmu( 10): event=notification_source_dispatched",
    "untrusted text=must-not-parse",
  ].join("\n");
  assert.deepEqual(parseAuditEvents(output, "cmu-add-current"), [
    "eligible_notification_queued",
    "notification_source_dispatched",
  ]);
});

test("content-free audit parser rejects substring and wrong-tag boundary spoofing", () => {
  const output = [
    "I/OtherTag( 11): boundary=cmu-add-current",
    "I/PenumbraCmu( 10): event=eligible_notification_queued",
    "I/PenumbraCmuSmoke( 11): prefix-boundary=cmu-add-current-suffix",
    "I/PenumbraCmu( 10): event=notification_source_dispatched",
  ].join("\n");
  assert.deepEqual(parseAuditEvents(output, "cmu-add-current"), []);
});

test("ordered evidence rejects missing and reordered milestones", () => {
  const required = ["queued", "source", "control", "data"];
  assert.equal(orderedEventsObserved(["queued", "noise", "source", "control", "data"], required), true);
  assert.equal(orderedEventsObserved(["queued", "control", "source", "data"], required), false);
  assert.equal(orderedEventsObserved(["queued", "source", "data"], required), false);
});

test("Pin parser accepts only content-free composition tokens after boundary", () => {
  const output = [
    "categorize_notifications",
    "boundary=cmu-add-current",
    "categorize_notifications",
    "private notification body",
    "encrypted_summarize_messages",
  ].join("\n");
  assert.deepEqual(parsePinCompositionTokens(output, "cmu-add-current"), [
    "categorize_notifications",
    "encrypted_summarize_messages",
  ]);
});

test("typed ADB allowlist requires an exact target and exact operation shape", () => {
  assert.doesNotThrow(() => assertHarnessAdbCommand(
    "device_state",
    ["adb", "-s", PIXEL_SERIAL, "get-state"],
  ));
  assert.doesNotThrow(() => assertHarnessAdbCommand(
    "sentinel_absence",
    ["adb", "-s", PIXEL_SERIAL, "shell", buildSentinelAbsenceProbeScript()],
  ));
  assert.throws(
    () => assertHarnessAdbCommand("device_state", ["adb", "shell", "get-state"]),
    /explicit ADB serial/,
  );
  assert.throws(
    () => assertHarnessAdbCommand(
      "device_state",
      ["adb", "-s", PIXEL_SERIAL, "reboot"],
    ),
    /outside the CMU harness allowlist/,
  );
  assert.throws(
    () => assertHarnessAdbCommand(
      "listener_grant",
      ["adb", "-s", PIXEL_SERIAL, "shell", "settings", "put", "secure", "unsafe", "1"],
    ),
    /outside the CMU harness allowlist/,
  );
  assert.throws(
    () => assertHarnessAdbCommand(
      "role_preflight",
      ["adb", "-s", PIXEL_SERIAL, "shell", "pm", "install-create"],
    ),
    /outside the CMU harness allowlist/,
  );
  assert.throws(
    () => assertHarnessAdbCommand(
      "sentinel_absence",
      ["adb", "-s", PIXEL_SERIAL, "shell", "cmd", "notification", "list"],
    ),
    /outside the CMU harness allowlist/,
  );
});

test("typed ADB allowlist rejects pass-through dumps, filters, and raw logcat", () => {
  assert.throws(
    () => assertHarnessAdbCommand(
      "live_gatt",
      ["adb", "-s", PIXEL_SERIAL, "shell", "dumpsys bluetooth_manager | awk '{print}'"],
    ),
    /outside the CMU harness allowlist/,
  );
  assert.throws(
    () => assertHarnessAdbCommand(
      "sentinel_absence",
      ["adb", "-s", PIXEL_SERIAL, "shell", "cmd notification list | grep -F ''"],
    ),
    /outside the CMU harness allowlist/,
  );
  assert.throws(
    () => assertHarnessAdbCommand(
      "pixel_audit",
      ["adb", "-s", PIXEL_SERIAL, "shell", "logcat", "-b", "all", "-d"],
    ),
    /outside the CMU harness allowlist/,
  );
});

test("bounded ADB spawn options enforce fixed resource bounds", () => {
  const options = buildBoundedAdbSpawnOptions();
  assert.equal(options.timeout, CMU_PHYSICAL_CONTRACT.adbCommandTimeoutMs);
  assert.equal(options.maxBuffer, 2 * 1024 * 1024);
  assert.equal(options.killSignal, "SIGKILL");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.throws(() => buildBoundedAdbSpawnOptions({ timeoutMs: 0 }), /timeout is outside/);
  assert.throws(() => buildBoundedAdbSpawnOptions({ timeoutMs: 60_001 }), /timeout is outside/);
});

test("bounded ADB result normalization suppresses private diagnostics", () => {
  const privateMarker = "private-device-marker";
  assert.throws(
    () => normalizeBoundedAdbResult({
      status: null,
      signal: null,
      error: Object.assign(new Error(privateMarker), { code: "ETIMEDOUT" }),
      stdout: privateMarker,
      stderr: privateMarker,
    }),
    (error) => {
      assert.match(error.message, /bounded timeout/);
      assert.equal(error.message.includes(privateMarker), false);
      assert.equal(error.message.includes(PIXEL_SERIAL), false);
      return true;
    },
  );
  const result = normalizeBoundedAdbResult({
    status: 0,
    signal: null,
    stdout: "device\n",
    stderr: privateMarker,
  });
  assert.deepEqual(result, { status: 0, stdout: "device\n" });
  assert.equal("stderr" in result, false);
  assert.throws(
    () => normalizeBoundedAdbResult({
      status: 1,
      signal: null,
      stdout: privateMarker,
      stderr: privateMarker,
    }),
    /^PrivacySafeCmuError: ADB command failed$/,
  );
  assert.deepEqual(
    normalizeBoundedAdbResult({ status: 2, signal: null, stdout: "" }, { allowFailure: true }),
    { status: 2, stdout: "" },
  );
});

test("visible policy probe accepts only the exact privacy-preserving broad policy", () => {
  const validPolicy = [
    "<map>",
    '  <boolean name="relay_enabled" value="true" />',
    '  <boolean name="relay_all_eligible" value="true" />',
    '  <boolean name="relay_bodies" value="false" />',
    '  <set name="relay_packages"></set>',
    "</map>",
  ].join("\n");
  const script = buildVisiblePolicyProbeScript("/dev/stdin");
  assert.equal(executeContentFreeProbe(script, validPolicy).status, 0);

  const rejectedPolicies = [
    validPolicy.replace('  <boolean name="relay_all_eligible" value="true" />\n', ""),
    validPolicy.replace('name="relay_all_eligible" value="true"', 'name="relay_all_eligible" value="false"'),
    validPolicy.replace('name="relay_bodies" value="false"', 'name="relay_bodies" value="true"'),
    validPolicy.replace(
      '  <boolean name="relay_enabled" value="true" />',
      '  <boolean name="relay_enabled" value="true" />\n  <boolean name="relay_enabled" value="true" />',
    ),
    validPolicy.replace(
      '  <set name="relay_packages"></set>',
      `  <set name="relay_packages"><string>${CMU_PHYSICAL_CONTRACT.sentinelPackage}</string></set>`,
    ),
  ];
  for (const policy of rejectedPolicies) {
    assert.notEqual(executeContentFreeProbe(script, policy).status, 0);
  }
  assert.throws(
    () => buildVisiblePolicyProbeScript("/data/local/tmp/private.xml"),
    /invalid visible-policy settings source/,
  );
});

test("live GATT probe requires exact advertising plus service and connection in one app block", () => {
  const validDump = [
    "Ongoing advertising:",
    `  ${CMU_PHYSICAL_CONTRACT.packageName}`,
    "GATT clients:",
    `  appName: ${CMU_PHYSICAL_CONTRACT.packageName}`,
    "    Connection(connected)",
    `    Service ${TRANSPORT_RESET_CONTRACT.gattServiceUuid}`,
  ].join("\n");
  const validResult = executeContentFreeProbe(buildLiveGattProbeScript("cat /dev/stdin"), validDump);
  assert.equal(validResult.status, 0);
  const parsed = parseLiveGattProbeOutput(validResult.stdout);
  assert.deepEqual(parsed, {
    evidenceComplete: true,
    appExact: true,
    connectionCorrelated: true,
    serviceCorrelated: true,
    sameBlockCorrelated: true,
    advertisingSectionExact: true,
  });
  assert.doesNotThrow(() => assertLiveGattReady(parsed));
});

test("live GATT probe rejects misleading sections, similar package names, and split app blocks", () => {
  const service = TRANSPORT_RESET_CONTRACT.gattServiceUuid;
  const exactPackage = CMU_PHYSICAL_CONTRACT.packageName;
  const misleadingDumps = [
    [
      "Ongoing advertising:",
      "  com.example.other",
      "GATT clients:",
      `  appName: ${exactPackage}`,
      "    Connection(connected)",
      `    Service ${service}`,
    ].join("\n"),
    [
      "Ongoing advertising:",
      `  ${exactPackage}`,
      "GATT clients:",
      "  appName: comXpenumbraosXcmucompanion",
      "    Connection(connected)",
      `    Service ${service}`,
    ].join("\n"),
    [
      "Ongoing advertising:",
      `  ${exactPackage}`,
      "GATT clients:",
      `  appName: ${exactPackage}`,
      "    Connection(connected)",
      "  appName: com.example.other",
      `    Service ${service}`,
    ].join("\n"),
    [
      "Ongoing advertising:",
      `  ${exactPackage}`,
      "GATT clients:",
      `  appName: ${exactPackage}`,
      "    Connection(connected)",
      "  appName: com.example.other",
      `  appName: ${exactPackage}`,
      `    Service ${service}`,
    ].join("\n"),
    [
      "Ongoing advertising:",
      `  ${exactPackage}`,
      "GATT clients:",
      `  appName: ${exactPackage}`,
      "    Connection(disconnected)",
      `    Service ${service}`,
    ].join("\n"),
    [
      "Ongoing advertising:",
      `  ${exactPackage}`,
      "GATT clients:",
      `  appName: ${exactPackage}`,
      "    Connection(connected)",
      "    stale=true",
      `    Service ${service}`,
    ].join("\n"),
    [
      "Ongoing advertising:",
      `  ${exactPackage}`,
      "GATT clients:",
      `  appName: ${exactPackage}`,
      "    Connection(connected-but-not-exact)",
      `    Service ${service}`,
    ].join("\n"),
  ];

  for (const dump of misleadingDumps) {
    const result = executeContentFreeProbe(buildLiveGattProbeScript("cat /dev/stdin"), dump);
    assert.equal(result.status, 0);
    assert.throws(
      () => assertLiveGattReady(parseLiveGattProbeOutput(result.stdout)),
      /not exactly correlated/,
    );
  }
  assert.throws(
    () => buildLiveGattProbeScript("cat /private/device-dump"),
    /invalid live-GATT probe source/,
  );
});

test("production lifecycle acceptance fails closed without run correlation", () => {
  assert.equal(RUN_CORRELATION_CONTRACT.required, true);
  assert.equal(RUN_CORRELATION_CONTRACT.available, false);
  assert.throws(
    () => assertRunCorrelationAvailable(),
    /run-scoped sentinel correlation is unavailable/,
  );
  assert.doesNotThrow(() => assertRunCorrelationAvailable({ required: true, available: true }));
  assert.throws(
    () => assertPhysicalAcceptanceContractsAvailable({
      runCorrelation: { required: true, available: true },
      transport: { freshResetProofAvailable: false },
    }),
    /transport reset was not verified/,
  );
});

test("physical runner rejects unavailable evidence contracts before any ADB call", () => {
  assert.throws(
    () => runPhysicalSmoke({
      pixelSerial: PIXEL_SERIAL,
      expectedPixelSerial: PIXEL_SERIAL,
      pinSerial: PIN_SERIAL,
      expectedPinSerial: PIN_SERIAL,
      expectedApkSha256: CMU_PHYSICAL_CONTRACT.apkSha256,
    }),
    /run-scoped sentinel correlation is unavailable/,
  );
});

test("required lifecycle and restoration gates cannot produce a successful CLI exit", () => {
  const requiredGateProperties = [
    "transportFreshResetVerified",
    "preStateAbsent",
    "ancsAddSequenceVerified",
    "ancsUpdateSequenceVerified",
    "sentinelDeduplicationVerified",
    "pinCategorizationVerified",
    "pinSummarizationObserved",
    "ancsRemovalObserved",
    "sentinelLifecycleOrdered",
    "broadUnlistedSourceVerified",
    "postStateRestored",
  ];
  assert.doesNotThrow(() => assertPhysicalSmokeComplete(completePhysicalResult()));

  for (const property of requiredGateProperties) {
    const stdout = [];
    const stderr = [];
    const status = main(["--run"], {
      parseArgs: () => ({ mode: "run", help: false }),
      runPhysical: () => completePhysicalResult({ [property]: false }),
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    });
    assert.equal(status, 1, `${property} must force a nonzero CLI status`);
    assert.deepEqual(stdout, []);
    assert.match(stderr.join(""), /physical smoke incomplete/);
  }
});

test("incomplete reasons force nonzero and unexpected errors suppress private detail", () => {
  const stdout = [];
  const stderr = [];
  const incompleteStatus = main(["--run"], {
    parseArgs: () => ({ mode: "run", help: false }),
    runPhysical: () => completePhysicalResult({
      incompleteReasons: [INCOMPLETE_STATES.updateNotObserved],
      complete: false,
    }),
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });
  assert.equal(incompleteStatus, 1);
  assert.deepEqual(stdout, []);

  const privateMarker = "private-device-marker";
  const unexpectedStderr = [];
  const unexpectedStatus = main(["--run"], {
    parseArgs: () => ({ mode: "run", help: false }),
    runPhysical: () => { throw new Error(privateMarker); },
    stdout: { write: () => {} },
    stderr: { write: (value) => unexpectedStderr.push(value) },
  });
  assert.equal(unexpectedStatus, 1);
  assert.equal(unexpectedStderr.join("").includes(privateMarker), false);
  assert.match(unexpectedStderr.join(""), /private diagnostic suppressed/);
});

test("self-check promises no body reads and no protected-session reference", () => {
  const result = selfCheck();
  assert.deepEqual(result, {
    protectedSessionsReferenced: false,
    notificationBodiesRead: false,
    sentinelPackage: "com.android.shell",
    broadUnlistedSourceRequired: true,
    cleanupTransaction: 8,
    rolePreflightVerified: true,
    distinctRolesRequired: true,
    companionIdentityVerified: true,
    listenerGrantVerified: true,
    associationTrustVerified: true,
    transportCurrentStackContractVerified: true,
    transportFreshResetAutomated: false,
    sentinelLifecycleVerified: true,
    missingDedupEvidenceRejected: true,
    negationRejected: true,
    subpackageListenerRejected: true,
    runCorrelationAvailable: false,
    physicalAcceptancePossible: false,
    iosNonRegressionAutomated: false,
  });
});

test("role preflight contract defines exact Pin and Pixel expectations", () => {
  assert.equal(ROLE_PREFLIGHT.pixel.role, "phone");
  assert.equal(ROLE_PREFLIGHT.pixel.companionRequired, true);
  assert.equal(ROLE_PREFLIGHT.pixel.companionPackage, CMU_PHYSICAL_CONTRACT.packageName);
  assert.equal(ROLE_PREFLIGHT.pin.role, "pin");
  assert.equal(ROLE_PREFLIGHT.pin.companionRequired, false);
  assert.equal(ROLE_PREFLIGHT.pin.companionPackage, CMU_PHYSICAL_CONTRACT.packageName);
});

test("role preflight parser detects companion package presence", () => {
  const packageName = CMU_PHYSICAL_CONTRACT.packageName;
  const presentOutput = `package:/data/app/example/base.apk=${packageName}`;
  assert.deepEqual(parseRolePreflightOutput(presentOutput, packageName), { packagePresent: true });
});

test("role preflight parser detects companion package absence", () => {
  const packageName = CMU_PHYSICAL_CONTRACT.packageName;
  assert.deepEqual(parseRolePreflightOutput("", packageName), { packagePresent: false });
  assert.deepEqual(parseRolePreflightOutput("package:/data/app/other/base.apk=other.package", packageName), { packagePresent: false });
  assert.deepEqual(
    parseRolePreflightOutput(`package:${packageName}=/data/app/example/base.apk`, packageName),
    { packagePresent: false },
  );
  assert.deepEqual(
    parseRolePreflightOutput(`package:/data/app/${packageName}/base.apk=other.package`, packageName),
    { packagePresent: false },
  );
});

test("role preflight assertion enforces exact role expectations", () => {
  assert.doesNotThrow(() => assertRolePreflight(ROLE_PREFLIGHT.pixel, true));
  assert.doesNotThrow(() => assertRolePreflight(ROLE_PREFLIGHT.pin, false));
  assert.throws(
    () => assertRolePreflight(ROLE_PREFLIGHT.pixel, false),
    /phone role requires companion/,
  );
  assert.throws(
    () => assertRolePreflight(ROLE_PREFLIGHT.pin, true),
    /pin role must not carry/,
  );
});

test("companion identity contract locks exact version name and code", () => {
  assert.equal(COMPANION_IDENTITY_CONTRACT.packageName, CMU_PHYSICAL_CONTRACT.packageName);
  assert.equal(COMPANION_IDENTITY_CONTRACT.versionName, CMU_PHYSICAL_CONTRACT.versionName);
  assert.equal(COMPANION_IDENTITY_CONTRACT.versionCode, CMU_PHYSICAL_CONTRACT.versionCode);
  assert.equal(COMPANION_IDENTITY_CONTRACT.listenerClassName, "NotificationRelayListener");
});

test("companion identity parser extracts version name and code", () => {
  const output = [
    "Package [com.penumbraos.cmucompanion]",
    "    versionName=1.0",
    "    versionCode=1",
    "    signatures=[...]",
  ].join("\n");
  assert.deepEqual(parseCompanionIdentityOutput(output), { versionName: "1.0", versionCode: 1 });
});

test("companion identity parser handles missing fields", () => {
  assert.deepEqual(parseCompanionIdentityOutput("no version info"), { versionName: null, versionCode: null });
  assert.deepEqual(parseCompanionIdentityOutput("    versionName=2.5"), { versionName: "2.5", versionCode: null });
});

test("companion identity assertion rejects version mismatches", () => {
  assert.doesNotThrow(() =>
    assertCompanionIdentityMatch({ versionName: "1.0", versionCode: 1 }),
  );
  assert.throws(
    () => assertCompanionIdentityMatch({ versionName: "2.0", versionCode: 1 }),
    /version name does not match/,
  );
  assert.throws(
    () => assertCompanionIdentityMatch({ versionName: "1.0", versionCode: 2 }),
    /version code does not match/,
  );
});

test("listener grant parser accepts exact component name", () => {
  const exactComponent = `${COMPANION_IDENTITY_CONTRACT.packageName}/${COMPANION_IDENTITY_CONTRACT.packageName}.${COMPANION_IDENTITY_CONTRACT.listenerClassName}`;
  const output = `other.package/other.Listener:${exactComponent}:another.package/Another`;
  const parsed = parseListenerGrantOutput(output);
  assert.equal(parsed.granted, true);
  assert.equal(parsed.component, exactComponent);
});

test("listener grant parser accepts short component form", () => {
  const shortComponent = `${COMPANION_IDENTITY_CONTRACT.packageName}/.${COMPANION_IDENTITY_CONTRACT.listenerClassName}`;
  const output = `other.package/other.Listener:${shortComponent}`;
  const parsed = parseListenerGrantOutput(output);
  assert.equal(parsed.granted, true);
  assert.equal(parsed.component, shortComponent);
});

test("listener grant parser rejects missing or wrong component", () => {
  const absent = { granted: false, component: null, ambiguous: false };
  assert.deepEqual(parseListenerGrantOutput(""), absent);
  assert.deepEqual(parseListenerGrantOutput("null"), absent);
  assert.deepEqual(
    parseListenerGrantOutput("other.package/other.Listener"),
    absent,
  );
  assert.deepEqual(
    parseListenerGrantOutput(
      `${COMPANION_IDENTITY_CONTRACT.packageName}/${COMPANION_IDENTITY_CONTRACT.listenerClassName}`,
    ),
    absent,
  );
});

test("listener grant parser rejects subpackage listeners", () => {
  const subpackageComponent = `${COMPANION_IDENTITY_CONTRACT.packageName}/${COMPANION_IDENTITY_CONTRACT.packageName}.subpackage.${COMPANION_IDENTITY_CONTRACT.listenerClassName}`;
  assert.deepEqual(
    parseListenerGrantOutput(subpackageComponent),
    { granted: false, component: null, ambiguous: false },
  );
  const unrelatedSubpackage = `${COMPANION_IDENTITY_CONTRACT.packageName}/com.other.app.${COMPANION_IDENTITY_CONTRACT.listenerClassName}`;
  assert.deepEqual(
    parseListenerGrantOutput(unrelatedSubpackage),
    { granted: false, component: null, ambiguous: false },
  );
});

test("listener grant assertion requires exact grant", () => {
  assert.doesNotThrow(() =>
    assertListenerGrantExact({
      granted: true,
      component: `${COMPANION_IDENTITY_CONTRACT.packageName}/${COMPANION_IDENTITY_CONTRACT.packageName}.${COMPANION_IDENTITY_CONTRACT.listenerClassName}`,
      ambiguous: false,
    }),
  );
  assert.throws(
    () => assertListenerGrantExact({ granted: false, component: null }),
    /not visibly enabled/,
  );
  assert.throws(
    () => assertListenerGrantExact({ granted: true, component: null }),
    /exactly one relay component/,
  );
  const exactComponent = `${COMPANION_IDENTITY_CONTRACT.packageName}/${COMPANION_IDENTITY_CONTRACT.packageName}.${COMPANION_IDENTITY_CONTRACT.listenerClassName}`;
  const duplicate = parseListenerGrantOutput(`${exactComponent}:${exactComponent}`);
  assert.equal(duplicate.ambiguous, true);
  assert.throws(
    () => assertListenerGrantExact(duplicate),
    /exactly one relay component/,
  );
});

test("association trust contract locks exact companion and trust requirements", () => {
  assert.equal(ASSOCIATION_TRUST_CONTRACT.companionPackageName, CMU_PHYSICAL_CONTRACT.packageName);
  assert.equal(ASSOCIATION_TRUST_CONTRACT.evidenceVersion, "cmu-association-trust-v1");
  assert.equal(ASSOCIATION_TRUST_CONTRACT.systemAssociationRequired, true);
  assert.equal(ASSOCIATION_TRUST_CONTRACT.uniqueAssociationRequired, true);
  assert.equal(ASSOCIATION_TRUST_CONTRACT.bondStoreRequired, true);
  assert.equal(ASSOCIATION_TRUST_CONTRACT.associationBondPeerMatchRequired, true);
  assert.equal(ASSOCIATION_TRUST_CONTRACT.ambiguousRejected, true);
  assert.equal(ASSOCIATION_TRUST_CONTRACT.idMismatchRejected, true);
  assert.equal(ASSOCIATION_TRUST_CONTRACT.storeUnavailableRejected, true);
  assert.equal(ASSOCIATION_TRUST_CONTRACT.negationRejected, true);
});

test("association parser detects association and bond presence", () => {
  const parsed = parseAssociationStatusOutput(associationEvidence());
  assert.equal(parsed.evidenceComplete, true);
  assert.equal(parsed.associationPresent, true);
  assert.equal(parsed.bondPresent, true);
  assert.equal(parsed.readable, true);
  assert.equal(parsed.uniqueAssociation, true);
  assert.equal(parsed.associationBondPeerMatch, true);
});

test("association parser rejects prose, missing fields, and duplicate fields", () => {
  const parsed = parseAssociationStatusOutput(
    "association present for com.penumbraos.cmucompanion\nbond present for unrelated peer",
  );
  assert.equal(parsed.evidenceComplete, false);
  assert.equal(parsed.associationPresent, false);
  assert.equal(parsed.bondPresent, false);
  assert.equal(parsed.readable, false);

  const missing = parseAssociationStatusOutput(
    associationEvidence().split("\n").slice(0, -1).join("\n"),
  );
  assert.equal(missing.evidenceComplete, false);

  const duplicate = parseAssociationStatusOutput(
    `${associationEvidence()}\nassociation_unique=true`,
  );
  assert.equal(duplicate.evidenceComplete, false);
});

test("association parser detects store unavailable", () => {
  const parsed = parseAssociationStatusOutput(
    associationEvidence({ association_store_readable: false }),
  );
  assert.equal(parsed.readable, false);
});

test("association parser rejects negated association and bond forms", () => {
  const negatedAssociation = parseAssociationStatusOutput(
    associationEvidence({ association_package_exact: false }),
  );
  assert.equal(negatedAssociation.associationPresent, false);
  const negatedBond = parseAssociationStatusOutput(
    associationEvidence({ association_bond_peer_match: false }),
  );
  assert.equal(negatedBond.bondPresent, false);
});

test("association trust assertion requires both association and bond", () => {
  assert.doesNotThrow(() => assertAssociationTrust(parseAssociationStatusOutput(associationEvidence())));
  assert.throws(
    () => assertAssociationTrust(parseAssociationStatusOutput(
      associationEvidence({ association_package_exact: false }),
    )),
    /exact companion system association/,
  );
  assert.throws(
    () => assertAssociationTrust(parseAssociationStatusOutput(
      associationEvidence({ association_bond_peer_match: false }),
    )),
    /exactly one bonded peer/,
  );
  assert.throws(
    () => assertAssociationTrust(parseAssociationStatusOutput(
      associationEvidence({ bond_store_readable: false }),
    )),
    /not readable/,
  );
  assert.throws(
    () => assertAssociationTrust(parseAssociationStatusOutput(
      associationEvidence({ association_unique: false }),
    )),
    /system association is not present|ambiguous/,
  );
});

test("association probe emits only fixed content-free evidence keys", () => {
  const script = buildAssociationTrustProbeScript();
  assert.ok(script.includes("cmd companiondevice list"));
  assert.ok(script.includes("/^Bonded devices:/"));
  assert.ok(script.includes("association_bond_peer_match="));
  assert.equal(script.includes("echo $peer"), false);
});

test("association probe correlates one exact package association to one exact bond", () => {
  const placeholderPeer = "02:00:00:00:00:01";
  const parsed = executeSyntheticAssociationProbe({
    associationRows: [
      "Max ID: 1",
      "Association ID | Package Name | Mac Address",
      `1 | ${CMU_PHYSICAL_CONTRACT.packageName} | ${placeholderPeer}`,
    ],
    bondRows: [
      "Bluetooth Status",
      "Bonded devices:",
      ` ${placeholderPeer} [LE] Synthetic Fixture`,
      "Adapter state:",
    ],
  });
  assert.doesNotThrow(() => assertAssociationTrust(parsed));
});

test("association probe rejects ambiguous and mismatched synthetic peers", () => {
  const firstPeer = "02:00:00:00:00:01";
  const secondPeer = "02:00:00:00:00:02";
  const ambiguous = executeSyntheticAssociationProbe({
    associationRows: [
      "Max ID: 2",
      "Association ID | Package Name | Mac Address",
      `1 | ${CMU_PHYSICAL_CONTRACT.packageName} | ${firstPeer}`,
      `2 | ${CMU_PHYSICAL_CONTRACT.packageName} | ${secondPeer}`,
    ],
    bondRows: ["Bonded devices:", ` ${firstPeer} [LE] Synthetic Fixture`, "Adapter state:"],
  });
  assert.equal(ambiguous.uniqueAssociation, false);
  assert.throws(() => assertAssociationTrust(ambiguous), /ambiguous/);

  const malformedExtraRow = executeSyntheticAssociationProbe({
    associationRows: [
      "Max ID: 2",
      "Association ID | Package Name | Mac Address",
      `1 | ${CMU_PHYSICAL_CONTRACT.packageName} | ${firstPeer}`,
      `2 | ${CMU_PHYSICAL_CONTRACT.packageName} | null`,
    ],
    bondRows: ["Bonded devices:", ` ${firstPeer} [LE] Synthetic Fixture`, "Adapter state:"],
  });
  assert.equal(malformedExtraRow.associationPackageExact, true);
  assert.equal(malformedExtraRow.uniqueAssociation, false);
  assert.equal(malformedExtraRow.associationPeerPresent, false);
  assert.throws(() => assertAssociationTrust(malformedExtraRow), /ambiguous/);

  const mismatch = executeSyntheticAssociationProbe({
    associationRows: [
      "Max ID: 1",
      "Association ID | Package Name | Mac Address",
      `1 | ${CMU_PHYSICAL_CONTRACT.packageName} | ${firstPeer}`,
    ],
    bondRows: ["Bonded devices:", ` ${secondPeer} [LE] Synthetic Fixture`, "Adapter state:"],
  });
  assert.equal(mismatch.associationBondPeerMatch, false);
  assert.throws(() => assertAssociationTrust(mismatch), /bonded peer/);
});

test("transport reset contract defines GATT service and connection requirements", () => {
  assert.equal(TRANSPORT_RESET_CONTRACT.companionPackageName, CMU_PHYSICAL_CONTRACT.packageName);
  assert.equal(TRANSPORT_RESET_CONTRACT.currentStackRequired, true);
  assert.equal(TRANSPORT_RESET_CONTRACT.connectionEventRequired, true);
  assert.equal(TRANSPORT_RESET_CONTRACT.staleConnectionRejected, true);
  assert.equal(TRANSPORT_RESET_CONTRACT.freshResetProofAvailable, false);
  assert.ok(TRANSPORT_RESET_CONTRACT.gattServiceUuid.includes("7905f431"));
});

test("transport reset parser detects connection and service", () => {
  const output = [
    "transport_app_exact=true",
    "transport_service_exact=true",
    "transport_connection_current=true",
    "transport_stale=false",
  ].join("\n");
  const parsed = parseTransportResetOutput(output);
  assert.equal(parsed.evidenceComplete, true);
  assert.equal(parsed.connectionEvent, true);
  assert.equal(parsed.staleConnection, false);
});

test("transport reset parser detects stale connection", () => {
  const output = [
    "transport_app_exact=true",
    "transport_service_exact=true",
    "transport_connection_current=true",
    "transport_stale=true",
  ].join("\n");
  const parsed = parseTransportResetOutput(output);
  assert.equal(parsed.connectionEvent, true);
  assert.equal(parsed.staleConnection, true);
});

test("transport reset parser handles missing connection", () => {
  const parsed = parseTransportResetOutput("no bluetooth data");
  assert.equal(parsed.evidenceComplete, false);
  assert.equal(parsed.connectionEvent, false);
  assert.equal(parsed.staleConnection, true);
});

test("transport reset assertion requires connection event and rejects stale", () => {
  const good = parseTransportResetOutput([
    "transport_app_exact=true",
    "transport_service_exact=true",
    "transport_connection_current=true",
    "transport_stale=false",
  ].join("\n"));
  assert.doesNotThrow(() => assertTransportReset(good));
  assert.throws(
    () => assertTransportReset(parseTransportResetOutput("")),
    /evidence is incomplete/,
  );
  const stale = parseTransportResetOutput([
    "transport_app_exact=true",
    "transport_service_exact=true",
    "transport_connection_current=true",
    "transport_stale=true",
  ].join("\n"));
  assert.throws(
    () => assertTransportReset(stale),
    /connection appears stale/,
  );
});

test("sentinel update sequence requires correct event ordering", () => {
  const goodUpdate = [
    "eligible_notification_queued",
    "notification_source_dispatched",
    "notification_source_transmission_completed",
  ];
  assert.equal(verifySentinelUpdateSequence(goodUpdate), true);
  const badUpdate = ["notification_source_dispatched", "eligible_notification_queued"];
  assert.equal(verifySentinelUpdateSequence(badUpdate), false);
});

test("sentinel removal sequence requires correct event ordering", () => {
  const goodRemoval = [
    "notification_source_dispatched",
    "notification_source_transmission_completed",
  ];
  assert.equal(verifySentinelRemovalSequence(goodRemoval), true);
  const badRemoval = ["notification_source_transmission_completed", "notification_source_dispatched"];
  assert.equal(verifySentinelRemovalSequence(badRemoval), false);
});

test("sentinel deduplication rejects duplicate eligible_notification_queued", () => {
  const singleQueue = ["eligible_notification_queued", "notification_source_dispatched"];
  assert.equal(verifySentinelDeduplication(singleQueue), true);
  assert.equal(verifySentinelDeduplication([]), false);
  assert.equal(verifySentinelDeduplication(["notification_source_dispatched"]), false);
  const duplicateQueue = [
    "eligible_notification_queued",
    "eligible_notification_queued",
    "notification_source_dispatched",
  ];
  assert.equal(verifySentinelDeduplication(duplicateQueue), false);
});

test("dedup settle window captures a duplicate that arrives after initial delivery", () => {
  let clock = 0;
  const required = ["eligible_notification_queued", "notification_source_dispatched"];
  const settled = waitForStableEventSnapshot({
    timeoutMs: 1_600,
    quietMs: 600,
    pollMs: 100,
    readEvents: () => clock < 400
      ? required
      : ["eligible_notification_queued", "eligible_notification_queued", "notification_source_dispatched"],
    isReady: (events) => events.includes("notification_source_dispatched"),
    now: () => clock,
    pause: (milliseconds) => { clock += milliseconds; },
  });
  assert.deepEqual(settled, [
    "eligible_notification_queued",
    "eligible_notification_queued",
    "notification_source_dispatched",
  ]);
  assert.equal(verifySentinelDeduplication(settled), false);
});

test("dedup settle window returns a stable ready snapshot and otherwise times out", () => {
  let stableClock = 0;
  const single = ["eligible_notification_queued", "notification_source_dispatched"];
  assert.deepEqual(waitForStableEventSnapshot({
    timeoutMs: 1_000,
    quietMs: 300,
    pollMs: 100,
    readEvents: () => single,
    isReady: () => true,
    now: () => stableClock,
    pause: (milliseconds) => { stableClock += milliseconds; },
  }), single);

  let changingClock = 0;
  assert.equal(waitForStableEventSnapshot({
    timeoutMs: 500,
    quietMs: 200,
    pollMs: 100,
    readEvents: () => [`event-${changingClock}`],
    isReady: () => true,
    now: () => changingClock,
    pause: (milliseconds) => { changingClock += milliseconds; },
  }), null);
  assert.throws(
    () => waitForStableEventSnapshot({
      timeoutMs: 100,
      quietMs: 100,
      pollMs: 10,
      readEvents: () => [],
      isReady: () => true,
    }),
    /invalid bounded event-settle contract/,
  );
  assert.equal(DEDUP_SETTLE_CONTRACT.quietWindowMs > 0, true);
  assert.equal(DEDUP_SETTLE_CONTRACT.timeoutMs > DEDUP_SETTLE_CONTRACT.quietWindowMs, true);
});

test("sentinel lifecycle ordering requires add, update, and remove sequences", () => {
  const addEvents = [
    "eligible_notification_queued",
    "notification_source_dispatched",
    "notification_source_transmission_completed",
    "notification_attributes_requested",
    "data_source_dispatched",
    "data_source_transmission_completed",
  ];
  const updateEvents = [
    "eligible_notification_queued",
    "notification_source_dispatched",
    "notification_source_transmission_completed",
  ];
  const removeEvents = ["notification_source_dispatched", "notification_source_transmission_completed"];
  assert.equal(verifySentinelLifecycleOrdering(addEvents, updateEvents, removeEvents), true);
  const badAdd = ["notification_source_dispatched"];
  assert.equal(verifySentinelLifecycleOrdering(badAdd, updateEvents, removeEvents), false);
});

test("sentinel lifecycle ordering requires actual remove events not placeholder", () => {
  const addEvents = [
    "eligible_notification_queued",
    "notification_source_dispatched",
    "notification_source_transmission_completed",
    "notification_attributes_requested",
    "data_source_dispatched",
    "data_source_transmission_completed",
  ];
  const updateEvents = [
    "eligible_notification_queued",
    "notification_source_dispatched",
    "notification_source_transmission_completed",
  ];
  assert.equal(verifySentinelLifecycleOrdering(addEvents, updateEvents, []), false);
});

test("incomplete states document explicit failure reasons", () => {
  assert.ok(INCOMPLETE_STATES.updateNotObserved.includes("update"));
  assert.ok(INCOMPLETE_STATES.dedupNotVerified.includes("dedup"));
  assert.ok(INCOMPLETE_STATES.summarizationNotObserved.includes("summarization"));
  assert.ok(INCOMPLETE_STATES.lifecycleNotOrdered.includes("lifecycle"));
  assert.ok(INCOMPLETE_STATES.transportResetNotVerified.includes("transport"));
  assert.ok(INCOMPLETE_STATES.cleanupIncomplete.includes("cleanup"));
});

test("iOS non-regression gate explicitly repeats the full stock baseline after Android", () => {
  assert.equal(IOS_NON_REGRESSION_GATE.scope, "human-only");
  assert.equal(IOS_NON_REGRESSION_GATE.automated, false);
  assert.deepEqual(
    IOS_NON_REGRESSION_GATE.phases.map((phase) => phase.id),
    ["before_android_baseline", "after_android_revalidation"],
  );
  assert.deepEqual(
    IOS_NON_REGRESSION_GATE.phases[1].requiredObservations,
    IOS_NON_REGRESSION_GATE.phases[0].requiredObservations,
  );
  assert.equal(IOS_NON_REGRESSION_GATE.phases[0].requiredObservations.length >= 8, true);
  assert.equal(IOS_NON_REGRESSION_GATE.checklist.filter((item) => item.startsWith("Before Android:")).length, 4);
  assert.equal(IOS_NON_REGRESSION_GATE.checklist.filter((item) => item.startsWith("After Android:")).length, 4);
  assert.equal(
    IOS_NON_REGRESSION_GATE.checklist.some((item) => item.includes("no ANCS relay")),
    false,
  );
});

test("self-check validates role preflight contract", () => {
  const result = selfCheck();
  assert.equal(result.rolePreflightVerified, true);
  assert.equal(result.distinctRolesRequired, true);
  assert.equal(result.companionIdentityVerified, true);
  assert.equal(result.listenerGrantVerified, true);
  assert.equal(result.associationTrustVerified, true);
  assert.equal(result.transportCurrentStackContractVerified, true);
  assert.equal(result.transportFreshResetAutomated, false);
  assert.equal(result.sentinelLifecycleVerified, true);
  assert.equal(result.missingDedupEvidenceRejected, true);
  assert.equal(result.negationRejected, true);
  assert.equal(result.subpackageListenerRejected, true);
  assert.equal(result.runCorrelationAvailable, false);
  assert.equal(result.physicalAcceptancePossible, false);
  assert.equal(result.iosNonRegressionAutomated, false);
});
