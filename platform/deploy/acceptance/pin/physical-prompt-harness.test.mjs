import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  INSTALLED_SERVER_SIGNER_IDENTITY,
  deriveServerIdentityFromReleaseManifest,
  encodeProtoBytes,
  encodeProtoString,
  encodeProtoVarint,
} from "./agentic-release-smoke-lib.mjs";
import {
  PIN_COMPATIBILITY_CERT_SHA256,
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
} from "../../pin/release.mjs";

import {
  MUSIC_PAUSE_SAMPLE_OFFSETS_MS,
  MUSIC_PLAYBACK_SAMPLE_OFFSETS_MS,
  PHYSICAL_TIMEOUT_MS,
  PHYSICAL_PROMPT_CASES,
  buildLoadingMessageRequestHeaders,
  buildTranscriptInjectionCommand,
  decodeLoadingMessageRpcResponse,
  encodeLoadingMessageCaseRequest,
  evaluateAgenticTraceEvidence,
  evaluateFoodLogEvidence,
  evaluateLoadingCueEvidence,
  evaluateLocalWeatherTraceEvidence,
  evaluateNativeActionHookEvidence,
  evaluateContinuousMusicPlayback,
  evaluatePhysicalReadiness,
  evaluateProgressModelEvidence,
  evaluatePromptEvidence,
  evaluateSimpleHookEvidence,
  evaluateStableMusicPause,
  executePhysicalSuite,
  findAttributedMusic,
  foodMemoryToken,
  refreshedFoodEvidenceArm,
  loadingCueWithinDeadline,
  main,
  mediaPositionAdvanced,
  parseActiveMusicProviderStatus,
  parseMediaSessionSummary,
  parseMemoryRecords,
  parseActiveNetworkTransport,
  parsePenumbraHookEvidence,
  parsePhysicalCliArgs,
  parsePidSet,
  parsePromptActivityPage,
  tickleActivityIsForeground,
} from "./physical-prompt-harness.mjs";

test("physical observer outlives every in-device agentic deadline", () => {
  const hookedClientDeadlineMs = 90_000;
  assert.ok(PHYSICAL_TIMEOUT_MS.agenticRemoteWeather > hookedClientDeadlineMs);
  assert.ok(PHYSICAL_TIMEOUT_MS.music > hookedClientDeadlineMs);
  assert.ok(PHYSICAL_TIMEOUT_MS.foodAggregate > 60_000);
  assert.ok(PHYSICAL_TIMEOUT_MS.foodFollowUp > 60_000);
});

function verifiedManifestFixture({
  version = "2026-08-27.1",
  versionCode = 202_608_271,
} = {}) {
  const signerSha256 = PIN_COMPATIBILITY_CERT_SHA256;
  const receipts = {
    schemaVersion: 1,
    artifacts: PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
      const bytes = Buffer.from(`verified-${role}-${version}-${versionCode}`);
      return {
        role,
        path: `${role}.apk`,
        name: `${role}.apk`,
        package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
        versionName: version,
        versionCode,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        signerSha256,
      };
    }),
  };
  const manifest = createPinReleaseManifest({ version, receipts });
  return {
    manifest,
    manifestSource: canonicalPinReleaseManifestJson(manifest),
    receipts,
    receiptsSource: `${JSON.stringify(receipts)}\n`,
  };
}

const VERIFIED_RELEASE = verifiedManifestFixture();
const RELEASE_MANIFEST_PATH = "/private/tmp/verified-pin-release.json";
const RELEASE_RECEIPTS_PATH = "/private/tmp/verified-pin-receipts.json";
const RELEASE_MANIFEST_SOURCE = VERIFIED_RELEASE.manifestSource;
const RELEASE_RECEIPTS_SOURCE = VERIFIED_RELEASE.receiptsSource;
const EXPECTED = deriveServerIdentityFromReleaseManifest(
  RELEASE_MANIFEST_SOURCE,
  RELEASE_RECEIPTS_SOURCE,
);
function stockSessionIdentity(id = "opaque-stock-id", suffix = "androidx.media3.session.id.") {
  return createHash("sha256")
    .update(`${id} humane.experience.music/${suffix}`, "utf8")
    .digest("hex");
}
const GUARDED_MEDIA_VOLUME_STATE = Object.freeze({
  index: 7,
  minimum: 0,
  maximum: 15,
  muted: false,
});
const GUARDED_MEDIA_VOLUME_DEVICE = Object.freeze({
  async readMediaVolumeState() {
    return { ...GUARDED_MEDIA_VOLUME_STATE };
  },
  async setMediaVolumeIndex(index) {
    assert.equal(index, GUARDED_MEDIA_VOLUME_STATE.index);
  },
});

test("Food log evidence requires one successful lookup, one write, terminal completion, and no Tao timeout", () => {
  const boundary = "physical-food-123e4567-e89b-42d3-a456-426614174000";
  const itemToken = "a".repeat(64);
  const memoryToken = "b".repeat(64);
  const line = (tag, message, index) =>
    `1710000000.00${index}  100  101 W ${tag}: ${message}`;
  const writeLog = [
    line("PenumbraPhysicalHarness", boundary, 1),
    line("PenumbraServer", ">>> EncryptedChatCompletion stock tool call tool=RetrieveFoodInfo", 2),
    line("TaoAgent", "Received response: <redacted>", 3),
    line("PenumbraServer", ">>> EncryptedGetFoodItem", 4),
    line("PenumbraServer", "<<< EncryptedGetFoodItem matched=true", 5),
    line("PenumbraHook", `FoodRoundTrip lookup item_token=${itemToken}`, 6),
    line("PenumbraServer", ">>> Capture.CreateMemory", 6),
    line("PenumbraServer", "<<< Capture.CreateMemory memory_type=food_log status=success", 7),
    line("PenumbraHook", `FoodRoundTrip create status=success item_token=${itemToken} memory_token=${memoryToken}`, 8),
    line("PenumbraHook", "FoodTao deadline_rewrite=10_to_60", 9),
    line("PenumbraServer", ">>> EncryptedChatCompletion messages=4", 10),
    line("TaoAgent", "Received response: <redacted>", 11),
  ].join("\n");
  const evidence = evaluateFoodLogEvidence(writeLog, boundary, "write");

  assert.equal(evidence.pass, true);
  assert.equal(evidence.timeoutObserved, false);
  assert.equal(evidence.successfulFoodLookupCount, 1);
  assert.equal(evidence.createMemoryCount, 1);
  assert.equal(evidence.successfulCreateMemoryCount, 1);
  assert.equal(evidence.deadlineRewriteCount, 1);
  assert.deepEqual(evidence.lookupMarkers, [{ itemToken }]);
  assert.equal(evidence.createMarkers.length, 1);
  assert.equal(evidence.terminalObserved, true);

  const timedOut = `${writeLog}\n${line("TaoAgent", "java.util.concurrent.TimeoutException", 9)}`;
  assert.equal(evaluateFoodLogEvidence(timedOut, boundary, "write").pass, false);
  const duplicateWrite = `${writeLog}\n${line("PenumbraServer", ">>> Capture.CreateMemory", 12)}`;
  assert.equal(evaluateFoodLogEvidence(duplicateWrite, boundary, "write").pass, false);
  const noRewrite = writeLog
    .split("\n")
    .filter((entry) => !entry.includes("deadline_rewrite"))
    .join("\n");
  assert.equal(evaluateFoodLogEvidence(noRewrite, boundary, "write").pass, false);

  const nextBoundary = "physical-food-423e4567-e89b-42d3-a456-426614174000";
  const laterReadCannotContaminate = [
    writeLog,
    line("PenumbraPhysicalHarness", nextBoundary, 12),
    line("TaoAgent", "java.util.concurrent.TimeoutException", 13),
    line("PenumbraServer", ">>> Capture.GetFoodLogSummary", 14),
  ].join("\n");
  assert.equal(
    evaluateFoodLogEvidence(laterReadCannotContaminate, boundary, "write").pass,
    true,
  );

  const markerOnlyAfterNextBoundary = [
    writeLog.split("\n").filter((entry) => !entry.includes("FoodRoundTrip create")).join("\n"),
    line("PenumbraPhysicalHarness", nextBoundary, 12),
    line("PenumbraHook", `FoodRoundTrip create status=success item_token=${itemToken} memory_token=${memoryToken}`, 13),
  ].join("\n");
  assert.equal(
    evaluateFoodLogEvidence(markerOnlyAfterNextBoundary, boundary, "write").pass,
    false,
  );

  const splicedCreate = writeLog.replace(
    `FoodRoundTrip create status=success item_token=${itemToken}`,
    `FoodRoundTrip create status=success item_token=${"c".repeat(64)}`,
  );
  assert.equal(evaluateFoodLogEvidence(splicedCreate, boundary, "write").pass, false);
});

test("Food follow-up evidence requires the stock diary read and its terminal response", () => {
  const boundary = "physical-food-223e4567-e89b-42d3-a456-426614174000";
  const itemToken = "a".repeat(64);
  const memoryToken = "b".repeat(64);
  const log = [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    "1710000000.002  100  101 W PenumbraServer: >>> EncryptedChatCompletion stock tool call tool=GetFoodLog",
    "1710000000.003  100  101 W TaoAgent: Received response: <redacted>",
    "1710000000.004  100  101 W PenumbraServer: >>> Capture.GetFoodLogSummary",
    "1710000000.005  100  101 W PenumbraServer: included_count=1 <<< Capture.GetFoodLogSummary",
    `1710000000.006  100  101 I PenumbraHook: FoodRoundTrip read item_token=${itemToken} memory_token=${memoryToken} readback_match=true`,
    "1710000000.007  100  101 I PenumbraHook: FoodTao deadline_rewrite=10_to_60",
    "1710000000.008  100  101 W PenumbraServer: >>> EncryptedChatCompletion messages=4",
    "1710000000.009  100  101 W TaoAgent: Received response: <redacted>",
  ].join("\n");

  const evidence = evaluateFoodLogEvidence(log, boundary, "read");
  assert.equal(evidence.pass, true);
  assert.equal(evidence.foodLogReadCount, 1);
  assert.equal(evidence.successfulFoodLogReadCount, 1);
  assert.equal(evidence.terminalObserved, true);
  assert.equal(evidence.timeoutObserved, false);
});

test("Food baseline evidence requires one completed stock diary snapshot", () => {
  const boundary = "physical-food-323e4567-e89b-42d3-a456-426614174000";
  const log = [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    "1710000000.002  100  101 W PenumbraServer: >>> EncryptedChatCompletion stock tool call tool=GetFoodLog",
    "1710000000.003  100  101 W TaoAgent: Received response: <redacted>",
    "1710000000.004  100  101 W PenumbraServer: >>> Capture.GetFoodLogSummary",
    "1710000000.005  100  101 W PenumbraServer: included_count=1 <<< Capture.GetFoodLogSummary",
    "1710000000.006  100  101 I PenumbraHook: FoodRoundTrip baseline status=success",
    "1710000000.007  100  101 I PenumbraHook: FoodTao deadline_rewrite=10_to_60",
    "1710000000.008  100  101 W PenumbraServer: >>> EncryptedChatCompletion messages=4",
    "1710000000.009  100  101 W TaoAgent: Received response: <redacted>",
  ].join("\n");

  const evidence = evaluateFoodLogEvidence(log, boundary, "baseline");
  assert.equal(evidence.pass, true);
  assert.equal(evidence.baselineMarkerCount, 1);
  assert.equal(evidence.successfulFoodLogReadCount, 1);
});

test("Food evidence accepts correlated Hook proof when child process traces are unavailable", () => {
  const boundary = "physical-food-523e4567-e89b-42d3-a456-426614174000";
  const itemToken = "a".repeat(64);
  const memoryToken = "b".repeat(64);
  const line = (message, index) =>
    `1710000000.00${index}  100  101 I PenumbraHook: ${message}`;

  const baseline = [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    line("FoodTao deadline_rewrite=10_to_60", 2),
    line("FoodRoundTrip baseline status=success", 3),
  ].join("\n");
  const baselineEvidence = evaluateFoodLogEvidence(baseline, boundary, "baseline");
  assert.equal(baselineEvidence.pass, true);
  assert.equal(baselineEvidence.terminalObserved, true);
  assert.equal(baselineEvidence.successfulFoodLogReadCount, 1);

  const write = [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    line("FoodTao deadline_rewrite=10_to_60", 2),
    line(`FoodRoundTrip lookup item_token=${itemToken}`, 3),
    line(`FoodRoundTrip create status=success item_token=${itemToken} memory_token=${memoryToken}`, 4),
  ].join("\n");
  const writeEvidence = evaluateFoodLogEvidence(write, boundary, "write");
  assert.equal(writeEvidence.pass, true);
  assert.equal(writeEvidence.terminalObserved, true);
  assert.equal(writeEvidence.successfulFoodLookupCount, 1);
  assert.equal(writeEvidence.successfulCreateMemoryCount, 1);

  const read = [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    line("FoodTao deadline_rewrite=10_to_60", 2),
    line(`FoodRoundTrip read item_token=${itemToken} memory_token=${memoryToken} readback_match=true`, 3),
  ].join("\n");
  const readEvidence = evaluateFoodLogEvidence(read, boundary, "read");
  assert.equal(readEvidence.pass, true);
  assert.equal(readEvidence.terminalObserved, true);
  assert.equal(readEvidence.successfulFoodLogReadCount, 1);
});

test("Food memory observations accept only bounded stock memory records", () => {
  const record = {
    uuid: "123e4567-e89b-42d3-a456-426614174000",
    memory_type: "food_log",
    device_local_id: "opaque-device-local-id",
    created_at: "2026-08-31T10:00:00Z",
    status: "pending",
    files: [],
    thumbnail_count: 0,
  };
  assert.deepEqual(parseMemoryRecords([record]), [record]);
  assert.throws(
    () => parseMemoryRecords([{ ...record, memory_type: "secret" }]),
    /memory list was malformed/,
  );
  assert.throws(
    () => parseMemoryRecords([{ ...record, uuid: "../escape" }]),
    /memory list was malformed/,
  );
});

test("Food memory correlation uses a nonce-keyed token", () => {
  const arm = "0123456789abcdef0123456789abcdef:1710000180";
  assert.equal(
    foodMemoryToken(arm, "323e4567-e89b-42d3-a456-426614174000"),
    "83fc340cbf22ea819c545838c81d20c2eaea20d4ad56bb2f89ea2ef6e72704f7",
  );
  assert.throws(() => foodMemoryToken("bad", "not-a-uuid"), /token input was malformed/);
});

test("each Food phase refreshes one nonce to a fresh 180 second arm", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const initial = refreshedFoodEvidenceArm(null, "1710000000", uuid);
  assert.equal(
    initial,
    "123e4567e89b42d3a456426614174000:1710000180",
  );
  assert.equal(
    refreshedFoodEvidenceArm(initial, "1710000120"),
    "123e4567e89b42d3a456426614174000:1710000300",
  );
  assert.throws(
    () => refreshedFoodEvidenceArm("bad", "1710000120"),
    /arm input was malformed/,
  );
});

test("the physical Food case waits through terminal-before-markers log skew, proves the diary read, and retains the bounded fixture safely", async () => {
  const memory = {
    uuid: "323e4567-e89b-42d3-a456-426614174000",
    memory_type: "food_log",
    device_local_id: "opaque-device-local-id",
    created_at: "2026-08-31T10:00:00Z",
    status: "pending",
    files: [],
    thumbnail_count: 0,
  };
  const unrelatedMemory = {
    ...memory,
    uuid: "423e4567-e89b-42d3-a456-426614174000",
  };
  const arm = "0123456789abcdef0123456789abcdef:1710000180";
  const memoryToken = foodMemoryToken(arm, memory.uuid);
  const itemToken = "a".repeat(64);
  let phase = "baseline";
  let boundaryCount = 0;
  let now = 1_000;
  let deleted = false;
  let disarmed = false;
  let writeEvidenceCalls = 0;
  const injected = [];
  const deletedIds = [];
  const deletedPromptIds = new Set();
  const snapshot = readinessFixture();
  snapshot.settings.open_food_facts = {
    enabled: true,
    attribution_acknowledged: true,
  };
  const device = {
    ...GUARDED_MEDIA_VOLUME_DEVICE,
    async promptRows() {
      return injected.map((caseId, index) => ({
        id: index + 1,
        prompt: caseId === "food_log_roundtrip"
          ? "Add one apple to my food log."
          : "What have I eaten today?",
        response: "fixture response",
        run_id: null,
      })).filter((row) => !deletedPromptIds.has(row.id));
    },
    async memories() {
      if (phase === "baseline") return [unrelatedMemory];
      return deleted ? [unrelatedMemory] : [unrelatedMemory, memory];
    },
    async beginFoodEvidence(existingArm = null) {
      boundaryCount += 1;
      return {
        marker: boundaryCount === 1
          ? "physical-food-423e4567-e89b-42d3-a456-426614174000"
          : "physical-food-523e4567-e89b-42d3-a456-426614174000",
        arm: existingArm ?? arm,
      };
    },
    async endFoodEvidence() {
      disarmed = true;
    },
    async inject(caseId) {
      injected.push(caseId);
      phase = caseId === "food_log_roundtrip" ? "write" : "read";
    },
    async foodEvidenceSince(_boundary, evidencePhase) {
      if (evidencePhase === "baseline") {
        return {
          pass: true,
          timeoutObserved: false,
          terminalObserved: true,
          successfulFoodLookupCount: 0,
          createMemoryCount: 0,
          successfulCreateMemoryCount: 0,
          foodLogReadCount: 1,
          successfulFoodLogReadCount: 1,
          deadlineRewriteCount: 1,
          baselineMarkerCount: 1,
          createMarkers: [],
          readbackMarkers: [],
        };
      }
      if (evidencePhase === "write") {
        writeEvidenceCalls += 1;
        if (writeEvidenceCalls === 1) {
          return {
            pass: false,
            timeoutObserved: false,
            terminalObserved: true,
            successfulFoodLookupCount: 1,
            createMemoryCount: 0,
            successfulCreateMemoryCount: 0,
            foodLogReadCount: 0,
            successfulFoodLogReadCount: 0,
            deadlineRewriteCount: 1,
            createMarkers: [],
            readbackMarkers: [],
          };
        }
        return {
          pass: true,
          timeoutObserved: false,
          terminalObserved: true,
          successfulFoodLookupCount: 1,
          createMemoryCount: 1,
          successfulCreateMemoryCount: 1,
          foodLogReadCount: 0,
          successfulFoodLogReadCount: 0,
          deadlineRewriteCount: 1,
          createMarkers: [{ itemToken, memoryToken }],
          readbackMarkers: [],
        };
      }
      return {
        pass: true,
        timeoutObserved: false,
        terminalObserved: true,
        successfulFoodLookupCount: 0,
        createMemoryCount: 0,
        foodLogReadCount: 1,
        successfulFoodLogReadCount: 1,
        deadlineRewriteCount: 1,
        createMarkers: [],
        readbackMarkers: [{ itemToken, memoryToken, matched: true }],
      };
    },
    async deleteMemory(uuid) {
      deletedIds.push(uuid);
      deleted = true;
    },
    async deletePrompt(id) {
      deletedPromptIds.add(id);
    },
  };

  const report = await executePhysicalSuite(
    {
      serial: "device-123._:usb",
      expectedPinSerial: "device-123._:usb",
      releaseManifestPath: RELEASE_MANIFEST_PATH,
      releaseReceiptsPath: RELEASE_RECEIPTS_PATH,
      caseId: "food_log_roundtrip",
      provider: null,
      expectedTransport: null,
    },
    {
      device,
      token: "fixture-token",
      identity: identityFixture(),
      snapshot,
      releaseManifestSource: RELEASE_MANIFEST_SOURCE,
      releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
      timing: {
        now: () => now,
        async sleep(ms) { now += ms; },
      },
    },
  );

  assert.equal(report.status, "pass", JSON.stringify(report));
  assert.equal(writeEvidenceCalls, 3);
  assert.deepEqual(injected, [
    "food_log_roundtrip_read",
    "food_log_roundtrip",
    "food_log_roundtrip_read",
  ]);
  assert.deepEqual(deletedIds, []);
  assert.equal(disarmed, true);
  assert.equal(report.cases[0].food_lookup_observed, true);
  assert.equal(report.cases[0].create_memory_observed, true);
  assert.equal(report.cases[0].tao_timeout_observed, false);
  assert.equal(report.cases[0].write_within_extended_bound, true);
  assert.equal(report.cases[0].follow_up_read_observed, true);
  assert.equal(report.cleanup.food_memory_removed, null);
  assert.equal(report.cleanup.food_evidence_disarmed, true);
});

test("marked duplicates and unmarked new Food memories delete nothing after the full window", async () => {
  const memories = [
    "623e4567-e89b-42d3-a456-426614174000",
    "723e4567-e89b-42d3-a456-426614174000",
  ].map((uuid) => ({
    uuid,
    memory_type: "food_log",
    device_local_id: "",
    created_at: "2026-08-31T10:00:00Z",
    status: "pending",
    files: [],
    thumbnail_count: 0,
  }));
  const arm = "fedcba9876543210fedcba9876543210:1710000180";
  const itemToken = "a".repeat(64);
  const markers = memories.map((memory) => ({
    itemToken,
    memoryToken: foodMemoryToken(arm, memory.uuid),
  }));
  for (const scenario of [
    { markers, createCount: 2 },
    { markers: markers.slice(0, 1), createCount: 1 },
  ]) {
    let phase = "baseline";
    let now = 5_000;
    const deleted = [];
    const snapshot = readinessFixture();
    snapshot.settings.open_food_facts = {
      enabled: true,
      attribution_acknowledged: true,
    };
    const device = {
      ...GUARDED_MEDIA_VOLUME_DEVICE,
      async promptRows() {
        if (phase === "baseline") return [];
        return [
          { id: 1, prompt: "What have I eaten today?", response: "fixture", run_id: null },
          { id: 2, prompt: "Add one apple to my food log.", response: "fixture", run_id: null },
        ];
      },
      async memories() { return phase === "baseline" ? [] : memories; },
      async beginFoodEvidence() {
        now += 1_000;
        return {
          marker: "physical-food-823e4567-e89b-42d3-a456-426614174000",
          arm,
        };
      },
      async endFoodEvidence() {},
      async inject() {
        now += 2_000;
        phase = "write";
      },
      async foodEvidenceSince(_boundary, evidencePhase) {
        if (evidencePhase === "baseline") {
          return {
            pass: true,
            timeoutObserved: false,
            terminalObserved: true,
            successfulFoodLookupCount: 0,
            createMemoryCount: 0,
            successfulCreateMemoryCount: 0,
            foodLogReadCount: 1,
            successfulFoodLogReadCount: 1,
            deadlineRewriteCount: 1,
            baselineMarkerCount: 1,
            createMarkers: [],
            readbackMarkers: [],
          };
        }
        return {
          pass: false,
          timeoutObserved: false,
          terminalObserved: true,
          successfulFoodLookupCount: 1,
          createMemoryCount: scenario.createCount,
          successfulCreateMemoryCount: scenario.createCount,
          foodLogReadCount: 0,
          successfulFoodLogReadCount: 0,
          deadlineRewriteCount: 1,
          createMarkers: scenario.markers,
          readbackMarkers: [],
        };
      },
      async deleteMemory(uuid) { deleted.push(uuid); },
    };

    const report = await executePhysicalSuite(
      {
        serial: "device-123._:usb",
        expectedPinSerial: "device-123._:usb",
        releaseManifestPath: RELEASE_MANIFEST_PATH,
        releaseReceiptsPath: RELEASE_RECEIPTS_PATH,
        caseId: "food_log_roundtrip",
        provider: null,
        expectedTransport: null,
      },
      {
        device,
        token: "fixture-token",
        identity: identityFixture(),
        snapshot,
        releaseManifestSource: RELEASE_MANIFEST_SOURCE,
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        timing: {
          now: () => now,
          async sleep(ms) { now += ms; },
        },
      },
    );

    assert.equal(now, 11_000 + PHYSICAL_TIMEOUT_MS.foodAggregate);
    assert.deepEqual(deleted, []);
    assert.equal(report.cases[0].status, "fail");
    assert.equal(report.cleanup.food_memory_removed, false);
    assert.equal(report.status, "incomplete");
  }
});

test("the Food observer rejects an invalid injected clock before arming evidence", async () => {
  const snapshot = readinessFixture();
  snapshot.settings.open_food_facts = {
    enabled: true,
    attribution_acknowledged: true,
  };
  await assert.rejects(
    executePhysicalSuite(
      {
        serial: "device-123._:usb",
        expectedPinSerial: "device-123._:usb",
        releaseManifestPath: RELEASE_MANIFEST_PATH,
        releaseReceiptsPath: RELEASE_RECEIPTS_PATH,
        caseId: "food_log_roundtrip",
        provider: null,
        expectedTransport: null,
      },
      {
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async promptRows() { return []; },
          async memories() { return []; },
          async beginFoodEvidence() {
            assert.fail("invalid timing must fail before Food evidence is armed");
          },
        },
        token: "fixture-token",
        identity: identityFixture(),
        snapshot,
        releaseManifestSource: RELEASE_MANIFEST_SOURCE,
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        timing: { now: null, sleep: async () => {} },
      },
    ),
    /physical observation clock was invalid/,
  );
});

function liveArgs(
  extra = [],
  caseId = "current_time",
  { provider = "youtube_music", expectedTransport = "wifi" } = {},
) {
  const args = [
    "--run",
    "--serial",
    "device-123._:usb",
    "--expected-pin-serial",
    "device-123._:usb",
    "--release-manifest",
    RELEASE_MANIFEST_PATH,
    "--release-receipts",
    RELEASE_RECEIPTS_PATH,
    "--case",
    caseId,
  ];
  if (caseId === "ranked_music") {
    args.push(
      "--provider",
      provider,
      "--expected-transport",
      expectedTransport,
    );
  }
  return [...args, ...extra];
}

function readinessFixture(provider = "spotify") {
  return {
    health: { status: "ok", version: EXPECTED.versionName },
    settings: {
      restart_required: false,
      server: {
        admin_token_auth: true,
        grpc_bind_addr: "127.0.0.1:9090",
      },
    },
    spotify: {
      active_provider: provider,
      enabled: true,
      experimental_acknowledged: true,
      state: "ready",
      engine_ready: true,
    },
    featureFlags: {
      flags: [
        {
          key: "tickle",
          desired_value: { type: "bool", value: true },
          assignment_value: { type: "bool", value: true },
        },
      ],
      delivery: {
        state: "stock_cache_applied",
        stock_cache_verified: true,
      },
    },
  };
}

function identityFixture() {
  return {
    packageName: "com.penumbraos.server",
    versionName: EXPECTED.versionName,
    versionCode: EXPECTED.versionCode,
    signerIdentity: INSTALLED_SERVER_SIGNER_IDENTITY,
  };
}

function memoryWriter() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    text() { return value; },
  };
}

test("the live CLI requires a verified manifest and closed music provider/transport", () => {
  assert.deepEqual(parsePhysicalCliArgs([...liveArgs(), "--json"]), {
    mode: "run",
    serial: "device-123._:usb",
    expectedPinSerial: "device-123._:usb",
    adbPath: "adb",
    releaseManifestPath: RELEASE_MANIFEST_PATH,
    releaseReceiptsPath: RELEASE_RECEIPTS_PATH,
    caseId: "current_time",
    provider: null,
    expectedTransport: null,
    json: true,
    help: false,
  });
  assert.deepEqual(parsePhysicalCliArgs(liveArgs([], "ranked_music")), {
    mode: "run",
    serial: "device-123._:usb",
    expectedPinSerial: "device-123._:usb",
    adbPath: "adb",
    releaseManifestPath: RELEASE_MANIFEST_PATH,
    releaseReceiptsPath: RELEASE_RECEIPTS_PATH,
    caseId: "ranked_music",
    provider: "youtube_music",
    expectedTransport: "wifi",
    json: false,
    help: false,
  });
  assert.throws(() => parsePhysicalCliArgs(["--run"]), /explicit ADB serial/);
  assert.throws(
    () =>
      parsePhysicalCliArgs([
        "--run",
        "--serial",
        "device-123._:usb",
      ]),
    /expected AI Pin serial/,
  );
  const mismatchedSerial = liveArgs();
  mismatchedSerial[mismatchedSerial.indexOf("--expected-pin-serial") + 1] =
    "other-device";
  assert.throws(
    () => parsePhysicalCliArgs(mismatchedSerial),
    /operator-confirmed AI Pin serial/,
  );
  const missingCase = liveArgs();
  missingCase.splice(missingCase.indexOf("--case"), 2);
  assert.throws(
    () => parsePhysicalCliArgs(missingCase),
    /requires exactly one --case/,
  );
  assert.throws(
    () => parsePhysicalCliArgs(liveArgs(["--case", "ranked_music"])),
    /provided once/,
  );
  assert.throws(
    () => parsePhysicalCliArgs([...liveArgs(), "--serial", "other-device"]),
    /--serial may be provided once/,
  );
  assert.throws(
    () => parsePhysicalCliArgs([...liveArgs(), "--prompt", "call someone"]),
    /unknown command option/,
  );
  assert.throws(
    () => parsePhysicalCliArgs([...liveArgs(), "--expect-version-name", EXPECTED.versionName]),
    /unknown command option/,
  );
  assert.throws(
    () => parsePhysicalCliArgs(["--self-check", "--serial", "device"]),
    /does not accept live-device options/,
  );
  assert.throws(
    () => parsePhysicalCliArgs([...liveArgs(), "--self-check"]),
    /exactly one mode/,
  );
  assert.throws(
    () =>
      parsePhysicalCliArgs(
        liveArgs().map((value) =>
          value === "current_time" ? "music_pause_cleanup" : value,
        ),
      ),
    /fixed public physical case/,
  );

  const withoutPair = (args, flag) => {
    const copy = [...args];
    const index = copy.indexOf(flag);
    copy.splice(index, 2);
    return copy;
  };
  for (const missing of ["--release-manifest", "--release-receipts"]) {
    assert.throws(
      () => parsePhysicalCliArgs(withoutPair(liveArgs(), missing)),
      new RegExp(missing),
    );
  }
  assert.throws(
    () => parsePhysicalCliArgs(withoutPair(liveArgs([], "ranked_music"), "--provider")),
    /ranked_music requires --provider/,
  );
  assert.throws(
    () => parsePhysicalCliArgs(withoutPair(liveArgs([], "ranked_music"), "--expected-transport")),
    /ranked_music requires --expected-transport/,
  );
  assert.throws(
    () => parsePhysicalCliArgs(liveArgs([], "ranked_music", { provider: "apple_music" })),
    /provider must be spotify, youtube_music, or tidal/,
  );
  assert.throws(
    () => parsePhysicalCliArgs(liveArgs([], "ranked_music", { expectedTransport: "vps" })),
    /expected transport must be wifi or cellular/,
  );
  assert.throws(
    () => parsePhysicalCliArgs([...liveArgs(), "--provider", "spotify"]),
    /music options require --case ranked_music/,
  );
});

test("the physical matrix is fixed, bounded, immutable, and side-effect scoped", () => {
  assert.deepEqual(
    PHYSICAL_PROMPT_CASES.map((item) => item.id),
    [
      "loading_semantic_music",
      "loading_semantic_playback",
      "loading_semantic_weather",
      "loading_locked_neutral",
      "current_time",
      "world_clock_tokyo",
      "battery_level",
      "current_weather",
      "current_weather_today",
      "capital_weather_remote",
      "ranked_music",
      "food_log_roundtrip",
      "tickle_single",
      "tickle_fancy",
      "tickle_triple",
      "tickle_negative",
    ],
  );
  assert.equal(Object.isFrozen(PHYSICAL_PROMPT_CASES), true);
  assert.ok(PHYSICAL_PROMPT_CASES.every(Object.isFrozen));
  assert.ok(PHYSICAL_PROMPT_CASES.every((item) => Buffer.byteLength(item.prompt) <= 256));
  assert.doesNotMatch(
    PHYSICAL_PROMPT_CASES.map((item) => item.prompt).join(" "),
    /\b(?:call|message|camera|photo|privacy mode|settings|install|reboot)\b/i,
  );
});

test("transcript injection is one package-bound command built only from a case id", () => {
  assert.equal(
    buildTranscriptInjectionCommand("tickle_fancy"),
    'am broadcast --user 0 -a hu.ma.ne.INJECT_TRANSCRIPTION -p hu.ma.ne.ironman --es transcription "tickle my fancy" --ez vision false',
  );
  assert.throws(
    () => buildTranscriptInjectionCommand("tickle_fancy;reboot"),
    /unknown fixed physical case/,
  );
  assert.throws(
    () => buildTranscriptInjectionCommand("loading_semantic_music"),
    /cannot be transcript injected/,
  );
});

test("loading-message fixtures use the stock plaintext envelope and report only cue booleans", () => {
  const request = encodeLoadingMessageCaseRequest("loading_semantic_weather");
  assert.ok(Buffer.isBuffer(request));
  assert.ok(request.length > 32);

  const inner = Buffer.concat([
    encodeProtoString(1, "Checking the weather..."),
    encodeProtoString(2, "Checking the weather."),
  ]);
  const info = encodeProtoString(1, "humane.aibus.LoadingMessageResponse");
  const envelope = Buffer.concat([
    encodeProtoBytes(1, info),
    encodeProtoBytes(2, inner),
  ]);
  const decoded = decodeLoadingMessageRpcResponse(encodeProtoBytes(1, envelope));
  const evidence = evaluateLoadingCueEvidence("loading_semantic_weather", decoded);
  assert.deepEqual(evidence, {
    allowlisted: true,
    categoryAppropriate: true,
    semanticCategoryObserved: true,
    lockedNeutralObserved: null,
    pass: true,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /weather|Checking/);

  const emptyInner = Buffer.alloc(0);
  const emptyEnvelope = Buffer.concat([
    encodeProtoBytes(1, info),
    encodeProtoBytes(2, emptyInner),
  ]);
  const emptyDecoded = decodeLoadingMessageRpcResponse(
    encodeProtoBytes(1, emptyEnvelope),
  );
  assert.deepEqual(emptyDecoded, { loadingMessage: "", verbalMessage: "" });

  const canonicallyElidedEmptyEnvelope = encodeProtoBytes(1, info);
  assert.deepEqual(
    decodeLoadingMessageRpcResponse(
      encodeProtoBytes(1, canonicallyElidedEmptyEnvelope),
    ),
    { loadingMessage: "", verbalMessage: "" },
  );

  for (const malformedEnvelope of [
    Buffer.concat([
      encodeProtoBytes(1, info),
      encodeProtoBytes(2, emptyInner),
      encodeProtoBytes(2, emptyInner),
    ]),
    Buffer.concat([encodeProtoBytes(1, info), encodeProtoVarint(2, 0)]),
    Buffer.concat([encodeProtoBytes(1, info), encodeProtoVarint(3, 0)]),
  ]) {
    assert.throws(
      () =>
        decodeLoadingMessageRpcResponse(
          encodeProtoBytes(1, malformedEnvelope),
        ),
      /malformed/,
    );
  }

  const neutral = evaluateLoadingCueEvidence("loading_locked_neutral", emptyDecoded);
  assert.equal(neutral.pass, true);
  assert.equal(neutral.lockedNeutralObserved, true);
  assert.equal(neutral.semanticCategoryObserved, null);

  const playback = evaluateLoadingCueEvidence("loading_semantic_playback", {
    loadingMessage: "",
    verbalMessage: "",
  });
  assert.equal(playback.pass, true);
  assert.equal(playback.semanticCategoryObserved, true);
  assert.doesNotMatch(JSON.stringify(playback), /playback|Checking/);
});

test("loading-message RPC authenticates to the protected Pin-local AIBus listener", () => {
  const headers = buildLoadingMessageRequestHeaders(
    "physical-loading-123e4567-e89b-42d3-a456-426614174000",
    "fixture-token-value-that-is-private",
  );
  assert.equal(
    headers[":path"],
    "/humane.aibus.AIBusService/EncryptedLoadingMessage",
  );
  assert.equal(
    headers.authorization,
    "Bearer fixture-token-value-that-is-private",
  );
});

test("local weather activity requires exactly one preflight and one grounded terminal", () => {
  const privateLocality = "PRIVATE_LOCALITY_71ff";
  const privateTail = "PRIVATE_RESPONSE_TAIL_71ff";
  const prompt = "What's the weather like where I am right now?";
  const evidence = evaluatePromptEvidence(
    "current_weather",
    [
      { id: 10, prompt, response: "Action: GetCurrentLocation" },
      {
        id: 11,
        prompt,
        response: `Clear, 22 degrees Celsius in ${privateLocality}. ${privateTail}`,
      },
    ],
    9,
  );
  assert.deepEqual(evidence, {
    routeObserved: true,
    terminalObserved: true,
    localityObserved: true,
    pass: true,
    ownedIds: [10, 11],
  });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_|Clear|degrees/);

  const terminal = {
    id: 11,
    prompt,
    response: `Clear, 22 degrees Celsius in ${privateLocality}. ${privateTail}`,
  };
  assert.equal(
    evaluatePromptEvidence("current_weather", [terminal], 9).pass,
    false,
    "a forged terminal-only activity row must fail",
  );
  assert.equal(
    evaluatePromptEvidence(
      "current_weather",
      [{ id: 10, prompt, response: "Action: GetCurrentLocation" }],
      9,
    ).pass,
    false,
    "a preflight-only activity row must fail",
  );
  assert.equal(
    evaluatePromptEvidence(
      "current_weather",
      [
        { id: 10, prompt, response: "Action: GetCurrentLocation" },
        terminal,
        { ...terminal, id: 12 },
      ],
      9,
    ).pass,
    false,
    "duplicate plausible terminals must fail exact attribution",
  );

  const todayPrompt = "What's the weather like today?";
  assert.equal(
    evaluatePromptEvidence(
      "current_weather_today",
      [
        { id: 20, prompt: todayPrompt, response: "Action: GetCurrentLocation" },
        {
          id: 21,
          prompt: todayPrompt,
          response: "Clear, 22 degrees Celsius in Hvidovre.",
        },
      ],
      19,
    ).pass,
    true,
  );
});

test("remote capital weather requires one Paris temperature terminal and no location preflight", () => {
  const prompt = "Lookup the capitol of France and check the weather there";
  const terminal =
    "I found Paris. Current weather in Paris, France: Clear; 22 degrees Celsius. PRIVATE_REMOTE_TAIL";
  const evidence = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: terminal }],
    19,
  );
  assert.deepEqual(evidence, {
    currentLocationObserved: false,
    terminalObserved: true,
    localityObserved: true,
    franceGrounded: true,
    wrongCountryObserved: false,
    pass: true,
    ownedIds: [20],
  });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_|Paris|degrees|Clear/);

  assert.equal(
    evaluatePromptEvidence(
      "capital_weather_remote",
      [
        { id: 20, prompt, response: "Action: GetCurrentLocation" },
        { id: 21, prompt, response: terminal },
      ],
      19,
    ).pass,
    false,
  );
  assert.equal(
    evaluatePromptEvidence(
      "capital_weather_remote",
      [
        { id: 20, prompt, response: terminal },
        { id: 21, prompt, response: terminal },
      ],
      19,
    ).pass,
    false,
  );
  assert.equal(
    evaluatePromptEvidence(
      "capital_weather_remote",
      [{ id: 20, prompt, response: "Clear; 22 degrees Celsius in Lyon." }],
      19,
    ).pass,
    false,
  );

  // France grounding is required: bare "Paris" without country fails.
  const noFrance = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: "Paris is clear, 22 degrees Celsius." }],
    19,
  );
  assert.equal(noFrance.pass, false);
  assert.equal(noFrance.franceGrounded, false);
  assert.equal(noFrance.wrongCountryObserved, false);

  // Same-name wrong-country output is explicitly rejected.
  const parisTexas = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: "Weather in Paris, Texas: Clear; 22 degrees Celsius." }],
    19,
  );
  assert.equal(parisTexas.pass, false);
  assert.equal(parisTexas.franceGrounded, false);
  assert.equal(parisTexas.wrongCountryObserved, true);

  const parisUsa = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: "Paris, USA is clear, 22 degrees Celsius." }],
    19,
  );
  assert.equal(parisUsa.pass, false);
  assert.equal(parisUsa.wrongCountryObserved, true);

  // Wrong-country takes precedence even when France is also mentioned.
  const mixedCountry = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: "Paris, Texas and also France: 22 degrees Celsius." }],
    19,
  );
  assert.equal(mixedCountry.pass, false);
  assert.equal(mixedCountry.franceGrounded, true);
  assert.equal(mixedCountry.wrongCountryObserved, true);
});

test("agentic trace proof is exact, correlated, ordered, and fails closed", () => {
  const boundary =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const correlation = "223e4567-e89b-42d3-a456-426614174000";
  const otherCorrelation = "323e4567-e89b-42d3-a456-426614174000";
  const line = (
    ordinal,
    tool,
    eventCorrelation = correlation,
    tail = "",
    resultStatus = tool === "terminal" ? null : "ok",
  ) => {
    const result = resultStatus === null ? "" : ` result_status=${resultStatus}`;
    return `1710000000.${String(ordinal + 1).padStart(3, "0")}  100  101 W PenumbraServer: INFO humane_server: <<< Agentic physical proof trace correlation=${eventCorrelation} ordinal=${ordinal} tool=${tool} status=completed${result}${tail}`;
  };
  const log = (events) => [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    ...events,
  ].join("\n");

  const valid = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(3, "weather_at_place"),
      line(4, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.deepEqual(valid, {
    correlationMatched: true,
    ordinalsContiguous: true,
    exactOrder: true,
    currentLocationObserved: false,
    terminalObserved: true,
    eventCount: 4,
    pass: true,
  });
  assert.doesNotMatch(JSON.stringify(valid), /223e|knowledge|place_search|weather_at_place/);

  const missing = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "weather_at_place"),
      line(3, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(missing.pass, false);
  assert.equal(missing.exactOrder, false);

  const misordered = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "place_search"),
      line(2, "knowledge_lookup"),
      line(3, "weather_at_place"),
      line(4, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(misordered.pass, false);
  assert.equal(misordered.ordinalsContiguous, true);

  const extraLocation = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(3, "current_location"),
      line(4, "weather_at_place"),
      line(5, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(extraLocation.pass, false);
  assert.equal(extraLocation.currentLocationObserved, true);

  const uncorrelated = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search", otherCorrelation),
      line(3, "weather_at_place"),
      line(4, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(uncorrelated.pass, false);
  assert.equal(uncorrelated.correlationMatched, false);

  const wrongTerminalCorrelation = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(3, "weather_at_place"),
      line(4, "terminal"),
    ]),
    boundary,
    otherCorrelation,
  );
  assert.equal(wrongTerminalCorrelation.pass, false);
  assert.equal(wrongTerminalCorrelation.correlationMatched, false);

  const ordinalGap = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(4, "weather_at_place"),
      line(5, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(ordinalGap.pass, false);
  assert.equal(ordinalGap.ordinalsContiguous, false);

  const unavailable = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search", correlation, "", "unavailable"),
      line(3, "place_search"),
      line(4, "weather_at_place"),
      line(5, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(unavailable.pass, false);
  assert.equal(unavailable.eventCount, 5);

  const otherRegistered = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(3, "weather_at_place"),
      line(4, "other_registered_tool"),
      line(5, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(otherRegistered.pass, false);
  assert.equal(otherRegistered.exactOrder, false);
  assert.equal(otherRegistered.terminalObserved, true);
  assert.equal(otherRegistered.eventCount, 5);

  const invalidTool = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "invalid_tool", correlation, "", "invalid"),
      line(2, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(invalidTool.pass, false);
  assert.equal(invalidTool.exactOrder, false);
  assert.equal(invalidTool.terminalObserved, true);
  assert.equal(invalidTool.eventCount, 2);

  for (const malformed of [
    line(1, "knowledge_lookup", correlation, "", null),
    line(1, "terminal", correlation, "", "ok"),
    line(1, "knowledge_lookup", correlation, "", "provider_secret"),
    line(1, "model_supplied_secret_tool"),
  ]) {
    assert.throws(
      () =>
        evaluateAgenticTraceEvidence(
          "capital_weather_remote",
          log([malformed]),
          boundary,
          correlation,
        ),
      /trace event was malformed/,
    );
  }

  assert.throws(
    () =>
      evaluateAgenticTraceEvidence(
        "capital_weather_remote",
        log([line(1, "knowledge_lookup", correlation, " latitude=48.8")]),
        boundary,
        correlation,
      ),
    /trace event was malformed/,
  );
  assert.throws(
    () =>
      evaluateAgenticTraceEvidence(
        "capital_weather_remote",
        "",
        boundary,
        correlation,
      ),
    /boundary was unavailable/,
  );
});

test("local weather trace requires fresh location, reverse geocode, provider, and terminal", () => {
  const boundary =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const correlation = "223e4567-e89b-42d3-a456-426614174000";
  const otherCorrelation = "323e4567-e89b-42d3-a456-426614174000";
  const line = (
    ordinal,
    tool,
    eventCorrelation = correlation,
    tail = "",
  ) =>
    `1710000000.${String(ordinal + 1).padStart(3, "0")}  100  101 W PenumbraServer: INFO humane_server: <<< Deterministic local weather physical proof trace correlation=${eventCorrelation} ordinal=${ordinal} tool=${tool} status=completed${tail}`;
  const log = (events) => [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    ...events,
  ].join("\n");
  const exact = [
    line(1, "current_location"),
    line(2, "reverse_geocode"),
    line(3, "current_weather"),
    line(4, "terminal"),
  ];

  const valid = evaluateLocalWeatherTraceEvidence(
    "current_weather",
    log(exact),
    boundary,
    correlation,
  );
  assert.deepEqual(valid, {
    correlationMatched: true,
    ordinalsContiguous: true,
    exactOrder: true,
    freshLocationObserved: true,
    reverseGeocodeObserved: true,
    weatherProviderObserved: true,
    terminalObserved: true,
    eventCount: 4,
    pass: true,
  });
  assert.doesNotMatch(
    JSON.stringify(valid),
    /223e|current_location|reverse_geocode|current_weather/,
  );
  assert.equal(
    evaluateLocalWeatherTraceEvidence(
      "current_weather_today",
      log(exact),
      boundary,
      correlation,
    ).pass,
    true,
  );

  for (const incomplete of [
    [line(1, "terminal")],
    [line(1, "current_location")],
    [line(1, "current_location"), line(2, "current_weather"), line(3, "terminal")],
  ]) {
    assert.equal(
      evaluateLocalWeatherTraceEvidence(
        "current_weather",
        log(incomplete),
        boundary,
        correlation,
      ).pass,
      false,
    );
  }
  assert.equal(
    evaluateLocalWeatherTraceEvidence(
      "current_weather",
      log([
        line(1, "current_location"),
        line(2, "current_weather"),
        line(3, "reverse_geocode"),
        line(4, "terminal"),
      ]),
      boundary,
      correlation,
    ).pass,
    false,
  );
  assert.equal(
    evaluateLocalWeatherTraceEvidence(
      "current_weather",
      log([
        line(1, "current_location"),
        line(2, "reverse_geocode"),
        line(4, "current_weather"),
        line(5, "terminal"),
      ]),
      boundary,
      correlation,
    ).ordinalsContiguous,
    false,
  );
  assert.equal(
    evaluateLocalWeatherTraceEvidence(
      "current_weather",
      log([
        line(1, "current_location"),
        line(2, "reverse_geocode", otherCorrelation),
        line(3, "current_weather"),
        line(4, "terminal"),
      ]),
      boundary,
      correlation,
    ).correlationMatched,
    false,
  );
  assert.throws(
    () =>
      evaluateLocalWeatherTraceEvidence(
        "current_weather",
        log([line(1, "current_location", correlation, " latitude=55.6")]),
        boundary,
        correlation,
      ),
    /trace event was malformed/,
  );
});

test("prompt attribution ignores old and unrelated rows and the Tickle control rejects escape", () => {
  const rows = parsePromptActivityPage({
    items: [
      { id: 1, prompt: "tickle", response: "Action: Tickle" },
      { id: 2, prompt: "another fixed public fixture", response: "Action: Tickle" },
      { id: 3, prompt: "please tickle", response: "ordinary answer" },
    ],
  });
  assert.equal(evaluatePromptEvidence("tickle_single", rows, 1).pass, false);
  const rejected = evaluatePromptEvidence("tickle_negative", rows, 1);
  assert.equal(rejected.pass, true);
  assert.equal(rejected.terminalObserved, true);
  const pending = evaluatePromptEvidence("tickle_negative", [], 1);
  assert.equal(pending.pass, false, "an absent response must not pass");
  assert.equal(pending.actionEscaped, false, "an absent response remains pending, not escaped");
  const escaped = [...rows, { id: 4, prompt: "please tickle", response: "Action: Tickle" }];
  const escapedEvidence = evaluatePromptEvidence("tickle_negative", escaped, 1);
  assert.equal(escapedEvidence.pass, false);
  assert.equal(escapedEvidence.actionEscaped, true);

  const duplicatedPositive = [
    { id: 5, prompt: "tickle", response: "Action: Tickle" },
    { id: 6, prompt: "tickle", response: "Action: Tickle" },
  ];
  assert.equal(
    evaluatePromptEvidence("tickle_single", duplicatedPositive, 1).pass,
    false,
  );
});

test("active-network parsing returns only the validated default Wi-Fi/cellular token", () => {
  const privateSsid = "PRIVATE_HOME_NETWORK_52aa";
  const wifi = parseActiveNetworkTransport(`
    Active default network: 101
    NetworkAgentInfo{network{100} ni{MOBILE CONNECTED} nc{[ Transports: CELLULAR Capabilities: INTERNET&VALIDATED ]}}
    NetworkAgentInfo{network{101} ni{WIFI CONNECTED extra: ${privateSsid}} nc{[ Transports: WIFI Capabilities: INTERNET&VALIDATED ]}}
  `);
  assert.equal(wifi, "wifi");
  assert.equal(parseActiveNetworkTransport(`
    Active default network: 100
    NetworkAgentInfo{network{100} ni{MOBILE CONNECTED} nc{[ Transports: CELLULAR Capabilities: INTERNET&VALIDATED ]}}
    NetworkAgentInfo{network{101} ni{WIFI CONNECTED} nc{[ Transports: WIFI Capabilities: INTERNET&VALIDATED ]}}
  `), "cellular");
  assert.equal(parseActiveNetworkTransport(`
    Active default network: 101
    NetworkAgentInfo{network{101} ni{WIFI CONNECTED} nc{[ Transports: WIFI Capabilities: INTERNET ]}}
  `), null);
  assert.equal(parseActiveNetworkTransport("Active default network: null"), null);
  assert.doesNotMatch(JSON.stringify({ wifi }), /PRIVATE_HOME_NETWORK/);
});

test("active music provider parsing returns only the closed provider token", () => {
  assert.equal(
    parseActiveMusicProviderStatus({
      active_provider: "youtube_music",
      account_name: "PRIVATE_ACCOUNT_52aa",
    }),
    "youtube_music",
  );
  assert.equal(
    parseActiveMusicProviderStatus({ active_provider: "spotify" }),
    "spotify",
  );
  assert.equal(
    parseActiveMusicProviderStatus({ active_provider: "tidal" }),
    "tidal",
  );
  for (const malformed of [
    null,
    [],
    {},
    { active_provider: "apple_music" },
    { active_provider: "youtube_music\nPRIVATE" },
    { active_provider: 1 },
  ]) {
    assert.throws(
      () => parseActiveMusicProviderStatus(malformed),
      /music-provider status response was malformed/,
    );
  }
});

test("media-session evidence scopes exact stock PLAYING/PAUSED state without metadata", () => {
  const privateTitle = "PRIVATE_TRACK_TITLE_52aa";
  const first = parseMediaSessionSummary(`
    Global priority session is com.android.server.telecom/HeadsetMediaButton (userId=0)
      HeadsetMediaButton com.android.server.telecom/HeadsetMediaButton (userId=0)
        package=com.android.server.telecom
        state=PlaybackState {state=7, position=-1, buffered position=0}
    User Records:
    Record for full_user=0
      Sessions Stack - have 2 sessions:
        unrelated-id unrelated.player/session (userId=0)
          package=unrelated.player
          state=PlaybackState {state=3, position=900, buffered position=1200, speed=1.0, updated=21894, actions=0, custom actions=[], active item id=-1, error=null}
        opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
          package=humane.experience.music
          metadata=${privateTitle}
          state=PlaybackState {state=3, position=100, buffered position=600, speed=1.0, updated=22001, actions=3670015, custom actions=[], active item id=0, error=null}
  `);
  const second = parseMediaSessionSummary(`
    User Records:
    Record for full_user=0
      Sessions Stack - have 1 sessions:
        opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
          package=humane.experience.music
          metadata=${privateTitle}
          state=PlaybackState {state=3, position=100, buffered position=600, speed=1.0, updated=22001, actions=3670015, custom actions=[], active item id=0, error=null}
  `);
  assert.deepEqual(first, {
    sessionCount: 1,
    playingSessionCount: 1,
    pausedSessionCount: 0,
    playing: true,
    paused: false,
    playbackClockRunning: true,
    playingSessionIdentity: stockSessionIdentity(),
    pausedSessionIdentity: null,
    maximumPlayingPosition: 100,
    maximumPausedPosition: null,
  });
  assert.equal(mediaPositionAdvanced(first, second), false);
  assert.equal(mediaPositionAdvanced(first, second, 1_499), false);
  assert.equal(mediaPositionAdvanced(first, second, 1_500), false);
  assert.equal(mediaPositionAdvanced(first, second, 16_000), false);
  assert.doesNotMatch(JSON.stringify({ first, second }), /PRIVATE_TRACK/);
});

test("media-session evidence ignores unrelated playback and historical stock mentions", () => {
  const paused = parseMediaSessionSummary(`
    User Records:
    Record for full_user=0
      Sessions Stack - have 2 sessions:
        unrelated-id unrelated.player/session (userId=0)
          package=unrelated.player
          state=PlaybackState {state=3, position=900, buffered position=1200, speed=1.0, updated=21894}
        opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
          package=humane.experience.music
          state=PlaybackState {state=2, position=400, buffered position=600, speed=1.0, updated=22001}
  `);
  assert.deepEqual(paused, {
    sessionCount: 1,
    playingSessionCount: 0,
    pausedSessionCount: 1,
    playing: false,
    paused: true,
    playbackClockRunning: false,
    playingSessionIdentity: null,
    pausedSessionIdentity: stockSessionIdentity(),
    maximumPlayingPosition: null,
    maximumPausedPosition: 400,
  });

  const historicalOnly = parseMediaSessionSummary(`
    Last MediaButtonReceiver: MBR {pi=PendingIntent{opaque humane.experience.music}}
    Media button session is null
    Audio playback (lastly played comes first)
      uid=10061 packages=humane.experience.music
  `);
  assert.deepEqual(historicalOnly, {
    sessionCount: 0,
    playingSessionCount: 0,
    pausedSessionCount: 0,
    playing: false,
    paused: false,
    playbackClockRunning: false,
    playingSessionIdentity: null,
    pausedSessionIdentity: null,
    maximumPlayingPosition: null,
    maximumPausedPosition: null,
  });
});

test("media-session evidence selects the greatest position across stock playing records", () => {
  const summary = parseMediaSessionSummary(`
    Sessions Stack - have 3 sessions:
      first-stock-id humane.experience.music/first (userId=0)
        package=humane.experience.music
        state=PlaybackState {state=3, position=1200, buffered position=1600, speed=1.0, updated=22001}
      paused-stock-id humane.experience.music/paused (userId=0)
        package=humane.experience.music
        state=PlaybackState {state=2, position=2400, buffered position=2600, speed=1.0, updated=22001}
      second-stock-id humane.experience.music/second (userId=0)
        package=humane.experience.music
        state=PlaybackState {state=3, position=1700, buffered position=2100, speed=1.0, updated=22001}
  `);
  assert.deepEqual(summary, {
    sessionCount: 3,
    playingSessionCount: 2,
    pausedSessionCount: 1,
    playing: true,
    paused: false,
    playbackClockRunning: true,
    playingSessionIdentity: null,
    pausedSessionIdentity: stockSessionIdentity("paused-stock-id", "paused"),
    maximumPlayingPosition: 1700,
    maximumPausedPosition: 2400,
  });
});

test("a stopped playback clock cannot substitute for advancing stock position", () => {
  const first = parseMediaSessionSummary(`
    opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
      package=humane.experience.music
      state=PlaybackState {state=3, position=100, buffered position=600, speed=0.0, updated=22001}
  `);
  const second = parseMediaSessionSummary(`
    opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
      package=humane.experience.music
      state=PlaybackState {state=3, position=100, buffered position=600, speed=0.0, updated=22001}
  `);
  assert.equal(first.playing, true);
  assert.equal(first.playbackClockRunning, false);
  assert.equal(mediaPositionAdvanced(first, second, 1_500), false);
});

function playingMedia(
  position = 100,
  { speed = 1, count = 1, sessionIdentity = stockSessionIdentity() } = {},
) {
  return {
    sessionCount: count,
    playingSessionCount: count,
    pausedSessionCount: 0,
    playing: count > 0,
    paused: false,
    playbackClockRunning: count > 0 && speed > 0,
    playingSessionIdentity: count === 1 ? sessionIdentity : null,
    pausedSessionIdentity: null,
    maximumPlayingPosition: count > 0 ? position : null,
    maximumPausedPosition: null,
  };
}

function pausedMedia(
  position = 64_100,
  { count = 1, sessionIdentity = stockSessionIdentity() } = {},
) {
  return {
    sessionCount: count,
    playingSessionCount: 0,
    pausedSessionCount: count,
    playing: false,
    paused: count > 0,
    playbackClockRunning: false,
    playingSessionIdentity: null,
    pausedSessionIdentity: count === 1 ? sessionIdentity : null,
    maximumPlayingPosition: null,
    maximumPausedPosition: count > 0 ? position : null,
  };
}

test("continuous stock playback requires repeated advancement over more than sixty seconds", () => {
  assert.deepEqual(MUSIC_PLAYBACK_SAMPLE_OFFSETS_MS, [0, 16_000, 32_000, 48_000, 64_000]);
  const advancing = MUSIC_PLAYBACK_SAMPLE_OFFSETS_MS.map((elapsedMs) => ({
    elapsedMs,
    transport: "wifi",
    provider: "youtube_music",
    media: playingMedia(100 + elapsedMs),
  }));
  assert.deepEqual(
    evaluateContinuousMusicPlayback(advancing, "wifi", "youtube_music"),
    {
    pass: true,
    sampleCount: 5,
    durationOverSixtySeconds: true,
    continuouslyPlaying: true,
    repeatedlyAdvanced: true,
    transportStable: true,
      sessionStable: true,
      providerStable: true,
    },
  );

  const staticAndroidClock = advancing.map((sample) => ({
    ...sample,
    media: playingMedia(100),
  }));
  assert.equal(
    evaluateContinuousMusicPlayback(
      staticAndroidClock,
      "wifi",
      "youtube_music",
    ).pass,
    false,
  );

  const replacedSession = structuredClone(advancing);
  replacedSession[3].media.playingSessionIdentity = stockSessionIdentity("replacement");
  assert.equal(
    evaluateContinuousMusicPlayback(replacedSession, "wifi", "youtube_music").pass,
    false,
  );

  const wrongProvider = structuredClone(advancing);
  wrongProvider[2].provider = "tidal";
  assert.equal(
    evaluateContinuousMusicPlayback(wrongProvider, "wifi", "youtube_music").pass,
    false,
  );

  const onlySixtySeconds = advancing.map((sample, index) => ({
    ...sample,
    elapsedMs: [0, 15_000, 30_000, 45_000, 60_000][index],
  }));
  assert.equal(
    evaluateContinuousMusicPlayback(onlySixtySeconds, "wifi", "youtube_music").pass,
    false,
  );

  const interrupted = structuredClone(advancing);
  interrupted[2].media = playingMedia(0, { speed: 0 });
  assert.equal(
    evaluateContinuousMusicPlayback(interrupted, "wifi", "youtube_music").pass,
    false,
  );

  const duplicatePlaying = structuredClone(advancing);
  duplicatePlaying[3].media = playingMedia(48_100, { count: 2 });
  assert.equal(
    evaluateContinuousMusicPlayback(duplicatePlaying, "wifi", "youtube_music").pass,
    false,
  );

  const transportChanged = structuredClone(advancing);
  transportChanged[4].transport = "cellular";
  assert.equal(
    evaluateContinuousMusicPlayback(transportChanged, "wifi", "youtube_music").pass,
    false,
  );
});

test("PauseMusic acceptance requires one stable PAUSED stock session", () => {
  assert.deepEqual(MUSIC_PAUSE_SAMPLE_OFFSETS_MS, [0, 2_500, 5_000]);
  const stable = MUSIC_PAUSE_SAMPLE_OFFSETS_MS.map((elapsedMs) => ({
    elapsedMs,
    transport: "cellular",
    provider: "tidal",
    media: pausedMedia(),
  }));
  assert.deepEqual(
    evaluateStableMusicPause(
      stable,
      "cellular",
      "tidal",
      stockSessionIdentity(),
    ),
    {
    pass: true,
    sampleCount: 3,
    stablePaused: true,
    positionStable: true,
    transportStable: true,
      sessionStable: true,
      providerStable: true,
    },
  );

  const vanished = structuredClone(stable);
  vanished[1].media = pausedMedia(0, { count: 0 });
  assert.equal(
    evaluateStableMusicPause(vanished, "cellular", "tidal", stockSessionIdentity()).pass,
    false,
  );

  const resumed = structuredClone(stable);
  resumed[2].media = playingMedia(69_100);
  assert.equal(
    evaluateStableMusicPause(resumed, "cellular", "tidal", stockSessionIdentity()).pass,
    false,
  );

  const drifting = structuredClone(stable);
  drifting[2].media = pausedMedia(64_101);
  assert.equal(
    evaluateStableMusicPause(drifting, "cellular", "tidal", stockSessionIdentity()).pass,
    false,
  );

  const replacementSession = stable.map((sample) => ({
    ...sample,
    media: pausedMedia(64_100, {
      sessionIdentity: stockSessionIdentity("replacement"),
    }),
  }));
  assert.equal(
    evaluateStableMusicPause(
      replacementSession,
      "cellular",
      "tidal",
      stockSessionIdentity(),
    ).pass,
    false,
  );

  const providerChanged = structuredClone(stable);
  providerChanged[1].provider = "youtube_music";
  assert.equal(
    evaluateStableMusicPause(
      providerChanged,
      "cellular",
      "tidal",
      stockSessionIdentity(),
    ).pass,
    false,
  );
});

test("music attribution requires the exact normalized provider title, artist set, and album", () => {
  const rankOne = {
    title: "  Beat It ",
    artists: ["Michael Jackson", "Guest Artist"],
    album: "Thriller",
  };
  const rows = [
    {
      id: 10,
      title: "Beat It",
      artists: ["Michael Jackson"],
      album: "Thriller",
    },
    {
      id: 11,
      title: "BEAT   IT",
      artists: ["Guest Artist", "Michael Jackson"],
      album: "Wrong Album",
    },
    {
      id: 12,
      title: "BEAT   IT",
      artists: ["Guest Artist", "Michael Jackson"],
      album: " thriller ",
    },
  ];
  const attributed = findAttributedMusic(rows, 9, rankOne);
  assert.equal(attributed.matching?.id, 12);
  assert.equal(findAttributedMusic(rows, 12, rankOne).matching, undefined);
});

test("process and foreground parsers are strict and privacy-minimal", () => {
  assert.deepEqual(parsePidSet("321 123\n"), [123, 321]);
  assert.deepEqual(parsePidSet("\n"), []);
  assert.throws(() => parsePidSet("123; reboot"), /malformed/);
  assert.equal(
    tickleActivityIsForeground(
      "mResumedActivity: ActivityRecord{x u0 humane.experience.tickle/humaneinternal.system.ipc.HumaneExperienceActivity t7}",
    ),
    true,
  );
  assert.equal(
    tickleActivityIsForeground(
      "mResumedActivity: ActivityRecord{x u0 unrelated.package/.Main t7}",
    ),
    false,
  );
});

test("simple-action hook evidence is bounded by the harness marker and ordered", () => {
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const privateHookText = "PRIVATE_HOOK_DETAIL_4b27";
  const events = parsePenumbraHookEvidence(`
1710000000.001  100  101 W PenumbraHook: Repaired identifier-less local action for streaming dispatch
1710000000.002  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.003  100  101 W PenumbraHook: ${privateHookText}
1710000000.004  100  101 W PenumbraHook: Repaired identifier-less local action for streaming dispatch
1710000000.005  100  101 W PenumbraHook: Observed native action for physical verification | action=GetCurrentTime
1710000000.006  100  101 W PenumbraHook: Hand tracking timeout held for narration | sessionArmed=true
1710000000.007  100  101 W PenumbraHook: NARRATION_END released narration hold | sessionArmed=true
`, marker);
  assert.deepEqual(events, [
    "action:GetCurrentTime",
    "narration_start",
    "narration_end",
  ]);
  assert.deepEqual(evaluateSimpleHookEvidence(events, "GetCurrentTime"), {
    localActionObserved: true,
    narrationStarted: true,
    narrationEnded: true,
    pass: true,
  });
  assert.equal(
    evaluateSimpleHookEvidence([
      "narration_start",
      "action:GetCurrentTime",
      "narration_end",
    ], "GetCurrentTime").pass,
    false,
  );
  assert.equal(
    evaluateSimpleHookEvidence(
      ["action:GetBatteryLevel", "narration_start", "narration_end"],
      "GetCurrentTime",
    ).pass,
    false,
  );
  assert.equal(
    evaluateNativeActionHookEvidence(
      ["action:Tickle", "action:Tickle"],
      "Tickle",
    ).pass,
    false,
  );
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_HOOK/);
  assert.throws(
    () => parsePenumbraHookEvidence("", marker),
    /boundary was unavailable/,
  );
});

test("WorldClock is accepted as the exact native action for its fixed physical case", () => {
  assert.deepEqual(
    evaluateSimpleHookEvidence(
      ["action:WorldClock", "narration_start", "narration_end"],
      "WorldClock",
    ),
    {
      localActionObserved: true,
      narrationStarted: true,
      narrationEnded: true,
      pass: true,
    },
  );
});

test("PlayMusic is accepted as a content-free remote-route marker", () => {
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const events = parsePenumbraHookEvidence(`
1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.002  100  101 W PenumbraHook: Observed native action for physical verification | action=PlayMusic
  `, marker);
  assert.deepEqual(events, ["action:PlayMusic"]);
  assert.equal(evaluateNativeActionHookEvidence(events, "PlayMusic").pass, true);
});

test("simple-action evidence accepts stock narration when hand tracking is disabled", () => {
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const events = parsePenumbraHookEvidence(`
1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.002  100  101 W PenumbraHook: Observed native action for physical verification | action=GetCurrentTime
1710000000.003  100  101 W PenumbraHook:   Hand tracking feature disabled; delegating update(NARRATION_START) to stock
1710000000.004  100  101 W PenumbraHook:   Hand tracking feature disabled; delegating update(NARRATION_END) to stock
`, marker);

  assert.deepEqual(events, [
    "action:GetCurrentTime",
    "narration_start",
    "narration_end",
  ]);
  assert.equal(evaluateSimpleHookEvidence(events, "GetCurrentTime").pass, true);
});

test("pause cleanup accepts only the exact boundary-scoped compatibility dispatch", () => {
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const events = parsePenumbraHookEvidence(`
1710000000.001  100  101 W PenumbraHook: Music intent compatibility emitted PauseMusic
1710000000.002  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.003  100  101 W PenumbraHook: Music intent compatibility emitted PauseMusic extra
1710000000.004  100  101 W PenumbraHook: Music intent compatibility emitted PauseMusic
  `, marker);
  assert.deepEqual(events, ["action:PauseMusic"]);
  assert.deepEqual(evaluateNativeActionHookEvidence(events, "PauseMusic"), {
    exactActionObserved: true,
    expectedActionCount: 1,
    actionEventCount: 1,
    pass: true,
  });

  const nearMiss = parsePenumbraHookEvidence(`
1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.002  100  101 W PenumbraHook: Music intent compatibility emitted PauseMusic extra
1710000000.003  100  101 W PenumbraHook: music intent compatibility emitted PauseMusic
  `, marker);
  assert.deepEqual(nearMiss, []);
});

test("progress evidence requires truthful deterministic or policy provenance", () => {
  const marker = "physical-loading-123e4567-e89b-42d3-a456-426614174000";
  const privateLogText = "PRIVATE_PROGRESS_DETAIL_5c19";
  const observed = evaluateProgressModelEvidence(
    "loading_semantic_weather",
    `
1710000000.001  100  101 W PenumbraServer: emitted=true source=deterministic reason=weather <<< Returning bounded stock loading message
1710000000.002  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.003  100  101 W PenumbraServer: ${privateLogText}
1710000000.004  100  101 W PenumbraServer: INFO humane_server: <<< Returning bounded stock loading message emitted=true source=deterministic reason=weather correlation=${marker}
`,
    marker,
  );
  assert.deepEqual(observed, {
    decisionObserved: true,
    correlationMatched: true,
    emissionMatched: true,
    deterministicProvenanceObserved: true,
    policyProvenanceObserved: null,
    pass: true,
  });
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_PROGRESS/);

  const fallback = evaluateProgressModelEvidence(
    "loading_semantic_weather",
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}\n` +
      `1710000000.002  100  101 W PenumbraServer: <<< Returning bounded stock loading message emitted=true source=deterministic reason=music correlation=${marker}\n`,
    marker,
  );
  assert.equal(fallback.pass, false);
  assert.equal(fallback.deterministicProvenanceObserved, false);

  const locked = evaluateProgressModelEvidence(
    "loading_locked_neutral",
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}\n` +
      `1710000000.002  100  101 W PenumbraServer: <<< Returning bounded stock loading message emitted=false source=policy reason=locked correlation=${marker}\n`,
    marker,
  );
  assert.equal(locked.pass, true);
  assert.equal(locked.policyProvenanceObserved, true);

  const unrelated = evaluateProgressModelEvidence(
    "loading_semantic_weather",
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}\n` +
    "1710000000.002  100  101 W PenumbraServer: <<< Returning bounded stock loading message emitted=true source=deterministic reason=music correlation=physical-loading-223e4567-e89b-42d3-a456-426614174000\n",
    marker,
  );
  assert.equal(unrelated.pass, false);
  assert.equal(unrelated.correlationMatched, false);
});

test("loading cue latency is gated at the five-second end-to-end boundary", () => {
  assert.equal(loadingCueWithinDeadline(0), true);
  assert.equal(loadingCueWithinDeadline(4_999), true);
  assert.equal(loadingCueWithinDeadline(5_000), true);
  assert.equal(loadingCueWithinDeadline(5_001), false);
  assert.equal(loadingCueWithinDeadline(Number.NaN), false);
  assert.equal(loadingCueWithinDeadline(-1), false);
});

test("readiness requires exact manifest identity and provider-aware music gates", () => {
  const ready = evaluatePhysicalReadiness(readinessFixture(), identityFixture(), EXPECTED);
  assert.equal(ready.pass, true);
  assert.ok(Object.values(ready.checks).every(Boolean));

  const consentOnly = readinessFixture();
  consentOnly.settings.llm = { vision_consent_acknowledged: true };
  const consentReady = evaluatePhysicalReadiness(
    consentOnly,
    identityFixture(),
    EXPECTED,
  );
  assert.equal(consentReady.checks.cosmosAuthority, true);
  assert.equal(consentReady.checks.weatherReady, true);

  const localModel = readinessFixture();
  localModel.settings.llm = {
    provider: "echo",
    vision_consent_acknowledged: true,
  };
  assert.equal(
    evaluatePhysicalReadiness(localModel, identityFixture(), EXPECTED).checks
      .cosmosAuthority,
    false,
  );

  const stale = readinessFixture();
  stale.spotify.engine_ready = false;
  stale.featureFlags.delivery.stock_cache_verified = false;
  stale.settings.openstreetmap = {};
  const notReady = evaluatePhysicalReadiness(stale, identityFixture(), EXPECTED);
  assert.equal(notReady.pass, false);
  assert.equal(notReady.checks.tickleReady, false);
  assert.equal(notReady.checks.weatherLocalityReady, false);

  const youtube = readinessFixture("youtube_music");
  youtube.spotify.enabled = false;
  youtube.spotify.experimental_acknowledged = false;
  youtube.spotify.state = "not_configured";
  youtube.spotify.engine_ready = false;
  const youtubeReady = evaluatePhysicalReadiness(
    youtube,
    identityFixture(),
    EXPECTED,
    {
      provider: "youtube_music",
      expectedTransport: "wifi",
      observedTransport: "wifi",
    },
  );
  assert.equal(youtubeReady.checks.musicProviderReady, true);
  assert.equal(youtubeReady.checks.networkTransportReady, true);

  const tidalReady = evaluatePhysicalReadiness(
    readinessFixture("tidal"),
    identityFixture(),
    EXPECTED,
    {
      provider: "tidal",
      expectedTransport: "cellular",
      observedTransport: "cellular",
    },
  );
  assert.equal(tidalReady.checks.musicProviderReady, true);
  assert.equal(tidalReady.checks.networkTransportReady, true);

  const wrongProvider = evaluatePhysicalReadiness(
    youtube,
    identityFixture(),
    EXPECTED,
    {
      provider: "tidal",
      expectedTransport: "wifi",
      observedTransport: "wifi",
    },
  );
  assert.equal(wrongProvider.checks.musicProviderReady, false);

  const wrongTransport = evaluatePhysicalReadiness(
    youtube,
    identityFixture(),
    EXPECTED,
    {
      provider: "youtube_music",
      expectedTransport: "cellular",
      observedTransport: "wifi",
    },
  );
  assert.equal(wrongTransport.checks.networkTransportReady, false);

  const spotifyNotReady = readinessFixture("spotify");
  spotifyNotReady.spotify.engine_ready = false;
  assert.equal(
    evaluatePhysicalReadiness(
      spotifyNotReady,
      identityFixture(),
      EXPECTED,
      {
        provider: "spotify",
        expectedTransport: "wifi",
        observedTransport: "wifi",
      },
    ).checks.musicProviderReady,
    false,
  );
});

test("self-check emits a bounded report without fixture response content", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = await main(["--self-check", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.equal(report.fixed_case_count, PHYSICAL_PROMPT_CASES.length);
  assert.equal(report.safety.one_fixed_case_required_for_live_run, true);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /PRIVATE_|Hvidovre|degrees|transcription/);
});

test("a selected loading case touches no unrelated activity or package surface", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const calls = [];
  const marker = "physical-loading-123e4567-e89b-42d3-a456-426614174000";
  const exitCode = await main(
    liveArgs(["--json"], "loading_semantic_weather"),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        releaseManifestSource: RELEASE_MANIFEST_SOURCE,
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(),
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async beginProgressEvidence() {
            return marker;
          },
          async loadingCue(caseId, _grpcPort, correlationMarker) {
            assert.equal(correlationMarker, marker);
            calls.push(caseId);
            return {
              loadingMessage: "Checking the weather...",
              verbalMessage: "Checking the weather.",
            };
          },
          async progressEvidenceSince(caseId, boundaryMarker) {
            assert.equal(caseId, "loading_semantic_weather");
            assert.equal(boundaryMarker, marker);
            return {
              decisionObserved: true,
              correlationMatched: true,
              emissionMatched: true,
              deterministicProvenanceObserved: true,
              policyProvenanceObserved: null,
              pass: true,
            };
          },
        },
      },
    },
  );
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.equal(report.selected_case, "loading_semantic_weather");
  assert.deepEqual(report.cases.map((item) => item.id), [
    "loading_semantic_weather",
  ]);
  assert.deepEqual(calls, ["loading_semantic_weather"]);
  assert.deepEqual(report.cleanup, {
    prompt_activity_removed: null,
    music_activity_removed: null,
      food_memory_removed: null,
      food_evidence_disarmed: null,
      music_not_playing: null,
    tickle_not_running: null,
    media_volume_snapshot_captured: null,
    media_volume_restored: null,
  });
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /fixture-token|device-123/);
});

test("each local-weather prompt requires its correlated four-milestone proof", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const correlation = "223e4567-e89b-42d3-a456-426614174000";
  const prompt = "What's the weather like today?";
  const rows = [
    {
      id: 72,
      run_id: correlation,
      prompt,
      response: "Clear, 22 degrees Celsius in PRIVATE_LOCALITY_91af.",
    },
    {
      id: 71,
      run_id: correlation,
      prompt,
      response: "Action: GetCurrentLocation",
    },
  ];
  const injected = [];
  const deleted = [];
  let promptReads = 0;
  const exitCode = await main(
    liveArgs(["--json"], "current_weather_today"),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        releaseManifestSource: RELEASE_MANIFEST_SOURCE,
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(),
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async promptRows() {
            promptReads += 1;
            return promptReads === 1 ? [] : rows;
          },
          async beginAgenticEvidence() {
            return marker;
          },
          async beginHookEvidence() {
            return "physical-simple-323e4567-e89b-42d3-a456-426614174000";
          },
          async inject(caseId) {
            injected.push(caseId);
          },
          async localWeatherEvidenceSince(
            caseId,
            boundaryMarker,
            expectedCorrelation,
          ) {
            assert.equal(caseId, "current_weather_today");
            assert.equal(boundaryMarker, marker);
            assert.equal(expectedCorrelation, correlation);
            return {
              correlationMatched: true,
              ordinalsContiguous: true,
              exactOrder: true,
              freshLocationObserved: true,
              reverseGeocodeObserved: true,
              weatherProviderObserved: true,
              terminalObserved: true,
              eventCount: 4,
              pass: true,
            };
          },
          async hookEvidenceSince() {
            return [];
          },
          async deletePrompt(id) {
            deleted.push(id);
          },
        },
      },
    },
  );
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["current_weather_today"]);
  assert.deepEqual(deleted.sort((a, b) => a - b), [71, 72]);
  assert.deepEqual(report.cases[0], {
    id: "current_weather_today",
    status: "pass",
    route_observed: true,
    physical_effect_observed: null,
    exact_tool_chain_observed: true,
    correlation_observed: true,
    fresh_location_observed: true,
    reverse_geocode_observed: true,
    weather_provider_observed: true,
    trace_event_count: 4,
    terminal_observed: true,
    locality_observed: true,
    duration_bucket: report.cases[0].duration_bucket,
  });
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(
    stdout.text(),
    /fixture-token|device-123|PRIVATE_|weather like today|223e|degrees/,
  );
});

test("the remote capital-weather case requires exact trace and sanitized terminal proof", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const prompt = "Lookup the capitol of France and check the weather there";
  const row = {
    id: 71,
    run_id: "223e4567-e89b-42d3-a456-426614174000",
    prompt,
    response:
      "I found Paris. Current weather in Paris, France: Clear; 22 degrees Celsius. PRIVATE_AGENTIC_RESPONSE",
  };
  const injected = [];
  const deleted = [];
  let promptReads = 0;
  const exitCode = await main(
    liveArgs(["--json"], "capital_weather_remote"),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        releaseManifestSource: RELEASE_MANIFEST_SOURCE,
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(),
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async promptRows() {
            promptReads += 1;
            return promptReads === 1 ? [] : [row];
          },
          async beginAgenticEvidence() {
            return marker;
          },
          async beginHookEvidence() {
            return "physical-simple-323e4567-e89b-42d3-a456-426614174000";
          },
          async inject(caseId) {
            injected.push(caseId);
          },
          async agenticEvidenceSince(
            caseId,
            boundaryMarker,
            expectedCorrelation,
          ) {
            assert.equal(caseId, "capital_weather_remote");
            assert.equal(boundaryMarker, marker);
            assert.equal(
              expectedCorrelation,
              "223e4567-e89b-42d3-a456-426614174000",
            );
            return {
              correlationMatched: true,
              ordinalsContiguous: true,
              exactOrder: true,
              currentLocationObserved: false,
              terminalObserved: true,
              eventCount: 4,
              pass: true,
            };
          },
          async hookEvidenceSince() {
            return [];
          },
          async deletePrompt(id) {
            deleted.push(id);
          },
        },
      },
    },
  );
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["capital_weather_remote"]);
  assert.deepEqual(deleted, [71]);
  assert.equal(report.cases[0].route_observed, true);
  assert.equal(report.cases[0].exact_tool_chain_observed, true);
  assert.equal(report.cases[0].correlation_observed, true);
  assert.equal(report.cases[0].current_location_observed, false);
  assert.equal(report.cases[0].trace_event_count, 4);
  assert.equal(report.cases[0].terminal_observed, true);
  assert.equal(report.cases[0].locality_observed, true);
  assert.equal(report.cases[0].france_grounded, true);
  assert.equal(report.cases[0].wrong_country_observed, false);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(
    stdout.text(),
    /fixture-token|device-123|PRIVATE_|France|Paris|degrees|48\.8/,
  );
});

test("remote Cosmos weather accepts only boundary-scoped Pin action and narration evidence", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const traceMarker =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const hookMarker =
    "physical-simple-223e4567-e89b-42d3-a456-426614174000";
  const injected = [];
  const exitCode = await main(
    liveArgs(["--json"], "current_weather_today"),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        releaseManifestSource: RELEASE_MANIFEST_SOURCE,
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(),
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async promptRows() {
            return [];
          },
          async beginAgenticEvidence() {
            return traceMarker;
          },
          async beginHookEvidence() {
            return hookMarker;
          },
          async inject(caseId) {
            injected.push(caseId);
          },
          async localWeatherEvidenceSince() {
            return {
              correlationMatched: false,
              ordinalsContiguous: true,
              exactOrder: false,
              freshLocationObserved: false,
              reverseGeocodeObserved: false,
              weatherProviderObserved: false,
              terminalObserved: false,
              eventCount: 0,
              pass: false,
            };
          },
          async hookEvidenceSince(boundaryMarker) {
            assert.equal(boundaryMarker, hookMarker);
            return [
              "action:GetCurrentLocation",
              "narration_start",
              "narration_end",
            ];
          },
          async deletePrompt() {
            assert.fail("remote Cosmos creates no Pin-local prompt row");
          },
        },
      },
    },
  );
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["current_weather_today"]);
  assert.deepEqual(report.cases[0], {
    id: "current_weather_today",
    status: "pass",
    route_observed: true,
    physical_effect_observed: null,
    exact_tool_chain_observed: false,
    correlation_observed: false,
    fresh_location_observed: true,
    reverse_geocode_observed: false,
    weather_provider_observed: false,
    trace_event_count: 0,
    terminal_observed: true,
    locality_observed: null,
    duration_bucket: report.cases[0].duration_bucket,
  });
  assert.equal(stderr.text(), "");
});

test("remote Cosmos agentic answer accepts narration without inventing tool-chain proof", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const traceMarker =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const hookMarker =
    "physical-simple-223e4567-e89b-42d3-a456-426614174000";
  const injected = [];
  const exitCode = await main(
    liveArgs(["--json"], "capital_weather_remote"),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        releaseManifestSource: RELEASE_MANIFEST_SOURCE,
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(),
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async promptRows() {
            return [];
          },
          async beginAgenticEvidence() {
            return traceMarker;
          },
          async beginHookEvidence() {
            return hookMarker;
          },
          async inject(caseId) {
            injected.push(caseId);
          },
          async agenticEvidenceSince() {
            return {
              correlationMatched: false,
              ordinalsContiguous: true,
              exactOrder: false,
              currentLocationObserved: false,
              terminalObserved: false,
              eventCount: 0,
              pass: false,
            };
          },
          async hookEvidenceSince(boundaryMarker) {
            assert.equal(boundaryMarker, hookMarker);
            return [
              "narration_start",
              "narration_end",
              "narration_start",
              "narration_end",
            ];
          },
          async deletePrompt() {
            assert.fail("remote Cosmos creates no Pin-local prompt row");
          },
        },
      },
    },
  );
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["capital_weather_remote"]);
  assert.deepEqual(report.cases[0], {
    id: "capital_weather_remote",
    status: "pass",
    route_observed: true,
    physical_effect_observed: null,
    exact_tool_chain_observed: false,
    correlation_observed: false,
    current_location_observed: false,
    trace_event_count: 0,
    terminal_observed: true,
    locality_observed: null,
    france_grounded: null,
    wrong_country_observed: null,
    duration_bucket: report.cases[0].duration_bucket,
  });
  assert.equal(stderr.text(), "");
});

test("a selected simple case uses exact hook evidence without requiring a Center row", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const injected = [];
  const deleted = [];
  const exitCode = await main(liveArgs(["--json"]), {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      releaseManifestSource: RELEASE_MANIFEST_SOURCE,
      releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => {},
      identity: identityFixture(),
      snapshot: readinessFixture(),
      device: {
        ...GUARDED_MEDIA_VOLUME_DEVICE,
        async promptRows() {
          return [];
        },
        async beginHookEvidence() {
          return marker;
        },
        async inject(caseId) {
          injected.push(caseId);
        },
        async hookEvidenceSince(boundaryMarker) {
          assert.equal(boundaryMarker, marker);
          return [
            "action:GetCurrentTime",
            "narration_start",
            "narration_end",
          ];
        },
        async deletePrompt(id) {
          deleted.push(id);
        },
      },
    },
  });
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.equal(report.selected_case, "current_time");
  assert.deepEqual(injected, ["current_time"]);
  assert.deepEqual(deleted, []);
  assert.equal(report.cases[0].route_observed, true);
  assert.equal(report.cases[0].terminal_observed, true);
  assert.equal(report.cases[0].physical_effect_observed, null);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /fixture-token|what time|transcription/);
});

test("a Tickle positive requires its exact hook action and stable stock launcher without a Center row", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  let launched = false;
  let stopped = false;
  const injected = [];
  const exitCode = await main(liveArgs(["--json"], "tickle_single"), {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      releaseManifestSource: RELEASE_MANIFEST_SOURCE,
      releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => {},
      identity: identityFixture(),
      snapshot: readinessFixture(),
      device: {
        ...GUARDED_MEDIA_VOLUME_DEVICE,
        async promptRows() {
          return [];
        },
        async pids() {
          return launched && !stopped ? [321] : [];
        },
        async tickleForeground() {
          return launched && !stopped;
        },
        async beginHookEvidence() {
          return marker;
        },
        async inject(caseId) {
          injected.push(caseId);
          launched = true;
        },
        async hookEvidenceSince(boundaryMarker) {
          assert.equal(boundaryMarker, marker);
          return ["action:Tickle"];
        },
        async forceStop() {
          stopped = true;
        },
        async deletePrompt() {
          assert.fail("no Center row should be owned");
        },
      },
    },
  });
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["tickle_single"]);
  assert.equal(report.cases[0].route_observed, true);
  assert.equal(report.cases[0].launcher_observed, true);
  assert.equal(report.cases[0].physical_effect_observed, null);
  assert.equal(report.cases[0].terminal_observed, null);
  assert.equal(report.cleanup.tickle_not_running, true);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /fixture-token|device-123|PRIVATE_/);
});

test("the Tickle negative fails on an exact hook escape even without launcher state", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const terminalRow = {
    id: 51,
    prompt: "please tickle",
    response: "ordinary answer",
  };
  let injected = false;
  const exitCode = await main(liveArgs(["--json"], "tickle_negative"), {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      releaseManifestSource: RELEASE_MANIFEST_SOURCE,
      releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => {},
      identity: identityFixture(),
      snapshot: readinessFixture(),
      device: {
        ...GUARDED_MEDIA_VOLUME_DEVICE,
        async promptRows() {
          return injected ? [terminalRow] : [];
        },
        async pids() {
          return [];
        },
        async tickleForeground() {
          return false;
        },
        async beginHookEvidence() {
          return marker;
        },
        async inject() {
          injected = true;
        },
        async hookEvidenceSince(boundaryMarker) {
          assert.equal(boundaryMarker, marker);
          return ["action:Tickle"];
        },
        async forceStop() {},
        async deletePrompt() {},
      },
    },
  });
  assert.equal(exitCode, 3);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "incomplete");
  assert.equal(report.cases[0].status, "fail");
  assert.equal(report.cases[0].route_observed, false);
  assert.equal(report.cases[0].launcher_observed, false);
  assert.equal(report.cases[0].terminal_observed, true);
  assert.equal(stderr.text(), "");
});

test("ranked YouTube Music proves long stock playback and stable PauseMusic without a Spotify row", async () => {
  const result = await runRankedProviderMainFixture({
    provider: "youtube_music",
    expectedTransport: "wifi",
    expectsSpotifyActivity: false,
  });

  const { report } = result;
  assert.equal(result.exitCode, 0);
  assert.equal(report.status, "pass");
  assert.deepEqual(result.injected, ["ranked_music", "music_pause_cleanup"]);
  assert.deepEqual(result.deletedPrompts, [81]);
  assert.equal(result.cleanupOrder.at(-1), "volume_restore");
  assert.equal(report.cleanup.media_volume_snapshot_captured, true);
  assert.equal(report.cleanup.media_volume_restored, true);
  assert.equal(report.cleanup.music_activity_removed, null);
  assert.equal(report.cases[0].route_observed, true);
  assert.equal(report.cases[0].physical_effect_observed, true);
  assert.equal(report.cases[0].provider_catalog_observed, true);
  assert.equal(report.cases[0].provider_rank_one_match, null);
  assert.equal(report.cases[0].provider, "youtube_music");
  assert.equal(report.cases[0].expected_transport, "wifi");
  assert.equal(report.cases[0].playback_path, "pin_loopback");
  assert.equal(report.cases[0].playback_sample_count, 5);
  assert.equal(report.cases[0].pause_route_observed, true);
  assert.equal(report.cases[0].pause_stable_observed, true);
  assert.equal(report.cases[0].cleanup_restored_idle, true);
  assert.equal(result.musicRowsObserved, 0);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(
    result.stdout,
    /fixture-token|PRIVATE_|device-123|verified-pin-release|https?:\/\//,
  );
});

async function runRankedProviderMainFixture({
  provider,
  expectedTransport,
  expectsSpotifyActivity,
  remoteRouteViaHook = false,
  observedProviderForCall = () => provider,
}) {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const rankedCase = PHYSICAL_PROMPT_CASES.find((item) => item.id === "ranked_music");
  const rankOne = {
    title: "PRIVATE_PROVIDER_TRACK",
    artists: ["PRIVATE_PROVIDER_ARTIST"],
    album: "PRIVATE_PROVIDER_ALBUM",
  };
  const routeRow = {
    id: 81,
    prompt: rankedCase.prompt,
    response: "Action: PlayMusic",
  };
  const musicRow = {
    id: 91,
    track_id: "private-provider-track-id",
    ...rankOne,
    status: "playing",
  };
  const baselineMusicRow = {
    id: 80,
    track_id: "older-unrelated-track-id",
    title: "OLDER_UNRELATED_TRACK",
    artists: ["OLDER_UNRELATED_ARTIST"],
    album: "OLDER_UNRELATED_ALBUM",
    status: "completed",
  };
  const deletedPrompts = [];
  const deletedMusic = [];
  const injected = [];
  const cleanupOrder = [];
  let phase = "idle";
  let fakeNow = 0;
  let musicRowsObserved = 0;
  let musicProviderCalls = 0;

  const exitCode = await main(
    liveArgs(["--json"], "ranked_music", { provider, expectedTransport }),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        releaseManifestSource: RELEASE_MANIFEST_SOURCE,
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(provider),
        rankOne,
        timing: {
          now: () => fakeNow,
          sleep: async (durationMs) => { fakeNow += durationMs; },
        },
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async setMediaVolumeIndex(index) {
            assert.equal(index, GUARDED_MEDIA_VOLUME_STATE.index);
            cleanupOrder.push("volume_restore");
          },
          async promptRows() {
            return phase === "idle" || remoteRouteViaHook ? [] : [routeRow];
          },
          async musicRows() {
            musicRowsObserved += 1;
            if (!expectsSpotifyActivity) {
              throw new Error("non-Spotify playback must not read Spotify activity");
            }
            return phase === "idle"
              ? [baselineMusicRow]
              : [baselineMusicRow, musicRow];
          },
          async pids() {
            return phase === "idle" || phase === "stopped" ? [] : [321];
          },
          async media() {
            if (phase === "playing") return playingMedia(100 + fakeNow);
            if (phase === "paused") return pausedMedia(64_100);
            return {
              sessionCount: 0,
              playingSessionCount: 0,
              pausedSessionCount: 0,
              playing: false,
              paused: false,
              playbackClockRunning: false,
              playingSessionIdentity: null,
              pausedSessionIdentity: null,
              maximumPlayingPosition: null,
              maximumPausedPosition: null,
            };
          },
          async networkTransport() {
            return expectedTransport;
          },
          async musicProvider() {
            musicProviderCalls += 1;
            return observedProviderForCall(musicProviderCalls);
          },
          async inject(caseId) {
            injected.push(caseId);
            phase = caseId === "ranked_music" ? "playing" : "paused";
          },
          async beginHookEvidence() {
            return marker;
          },
          async hookEvidenceSince(boundaryMarker) {
            assert.equal(boundaryMarker, marker);
            if (phase === "paused") return ["action:PauseMusic"];
            return phase === "playing" && remoteRouteViaHook
              ? ["action:PlayMusic"]
              : [];
          },
          async forceStop() {
            cleanupOrder.push("music_stop");
            phase = "stopped";
          },
          async deletePrompt(id) {
            cleanupOrder.push("prompt_cleanup");
            deletedPrompts.push(id);
          },
          async deleteMusic(id) {
            cleanupOrder.push("music_row_cleanup");
            deletedMusic.push(id);
          },
        },
      },
    },
  );

  return {
    exitCode,
    report: JSON.parse(stdout.text()),
    stdout: stdout.text(),
    stderr: stderr.text(),
    deletedPrompts,
    deletedMusic,
    injected,
    cleanupOrder,
    musicRowsObserved,
    musicProviderCalls,
  };
}

test("remote ranked playback attributes its route from the PlayMusic Hook marker", async () => {
  const result = await runRankedProviderMainFixture({
    provider: "youtube_music",
    expectedTransport: "wifi",
    expectsSpotifyActivity: false,
    remoteRouteViaHook: true,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.cases[0].route_observed, true);
  assert.deepEqual(result.deletedPrompts, []);
});

test("ranked Spotify requires its activity row and removes only the attributed row", async () => {
  const result = await runRankedProviderMainFixture({
    provider: "spotify",
    expectedTransport: "wifi",
    expectsSpotifyActivity: true,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "pass");
  assert.equal(result.report.cases[0].provider, "spotify");
  assert.equal(result.report.cases[0].playback_path, "native");
  assert.equal(result.report.cases[0].provider_rank_one_match, true);
  assert.equal(result.report.cleanup.music_activity_removed, true);
  assert.deepEqual(result.deletedPrompts, [81]);
  assert.deepEqual(result.deletedMusic, [91]);
  assert.ok(result.musicRowsObserved >= 2);
  assert.equal(result.stderr, "");
});

test("ranked TIDAL proves cellular Pin-loopback playback without Spotify activity", async () => {
  const result = await runRankedProviderMainFixture({
    provider: "tidal",
    expectedTransport: "cellular",
    expectsSpotifyActivity: false,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "pass");
  assert.equal(result.report.cases[0].provider, "tidal");
  assert.equal(result.report.cases[0].expected_transport, "cellular");
  assert.equal(result.report.cases[0].playback_path, "pin_loopback");
  assert.equal(result.report.cases[0].provider_rank_one_match, null);
  assert.equal(result.report.cases[0].network_transport_observed, true);
  assert.equal(result.report.cleanup.music_activity_removed, null);
  assert.deepEqual(result.deletedPrompts, [81]);
  assert.deepEqual(result.deletedMusic, []);
  assert.equal(result.musicRowsObserved, 0);
  assert.equal(result.stderr, "");
});

test("the CLI provider cannot manufacture attribution after a Pin-observed mismatch", async () => {
  const result = await runRankedProviderMainFixture({
    provider: "youtube_music",
    expectedTransport: "wifi",
    expectsSpotifyActivity: false,
    observedProviderForCall(call) {
      return call === 2 ? "spotify" : "youtube_music";
    },
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.report.status, "incomplete");
  assert.equal(result.report.cases[0].status, "fail");
  assert.equal(result.report.cases[0].provider, null);
  assert.equal(result.report.cases[0].playback_path, null);
  assert.equal(result.report.cases[0].physical_effect_observed, false);
  assert.ok(result.musicProviderCalls >= 10);
  assert.equal(result.stderr, "");
});

test("a pre-existing paused stock session blocks music without injection or force-stop", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  let injected = 0;
  let forceStopped = 0;
  let volumeRestored = 0;

  const exitCode = await main(liveArgs(["--json"], "ranked_music"), {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      releaseManifestSource: RELEASE_MANIFEST_SOURCE,
      releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => {},
      identity: identityFixture(),
      snapshot: readinessFixture("youtube_music"),
      device: {
        ...GUARDED_MEDIA_VOLUME_DEVICE,
        async setMediaVolumeIndex(index) {
          assert.equal(index, GUARDED_MEDIA_VOLUME_STATE.index);
          volumeRestored += 1;
        },
        async promptRows() {
          return [];
        },
        async pids() {
          return [321];
        },
        async media() {
          return pausedMedia(2_400);
        },
        async networkTransport() {
          return "wifi";
        },
        async inject() {
          injected += 1;
        },
        async forceStop() {
          forceStopped += 1;
        },
        async deletePrompt() {
          assert.fail("no prompt row should be owned");
        },
        async deleteMusic() {
          assert.fail("no music row should be owned");
        },
      },
    },
  });

  assert.equal(exitCode, 3);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "incomplete");
  assert.equal(report.cases[0].status, "blocked");
  assert.equal(report.cases[0].reason, "preexisting_music_state");
  assert.equal(report.cleanup.music_not_playing, null);
  assert.equal(injected, 0);
  assert.equal(forceStopped, 0);
  assert.equal(volumeRestored, 1);
  assert.equal(stderr.text(), "");
});

test("an identity mismatch blocks before any physical device method is invoked", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  let verified = 0;
  const exitCode = await main([...liveArgs(), "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      releaseManifestSource: RELEASE_MANIFEST_SOURCE,
      releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => { verified += 1; },
      identity: { ...identityFixture(), signerIdentity: "b".repeat(8) },
      snapshot: readinessFixture(),
      device: new Proxy({}, {
        get() { throw new Error("physical device method must not be used"); },
      }),
    },
  });
  assert.equal(verified, 1);
  assert.equal(exitCode, 3);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.cases, []);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /fixture-token|device-123|bbbbbbbb/);
});

test("invalid release receipts stop before the selected device is accessed", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  let verified = 0;
  const exitCode = await main([...liveArgs(), "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      releaseManifestSource: RELEASE_MANIFEST_SOURCE,
      releaseReceiptsSource: '{"schemaVersion":1,"artifacts":[]}',
      verifyDevice: async () => { verified += 1; },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(verified, 0);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /canonical verified five-APK release metadata/);
});

test("suite execution independently rejects a mismatched confirmed serial", async () => {
  let dependencyRead = false;
  await assert.rejects(
    executePhysicalSuite(
      {
        ...parsePhysicalCliArgs(liveArgs()),
        expectedPinSerial: "other-device",
      },
      {
        get releaseManifestSource() {
          dependencyRead = true;
          throw new Error("dependency must not be read");
        },
      },
    ),
    /non-confirmed physical device/,
  );
  assert.equal(dependencyRead, false);
});

test("suite execution rejects noncanonical release metadata before reading device dependencies", async () => {
  let dependencyRead = false;
  await assert.rejects(
    executePhysicalSuite(
      parsePhysicalCliArgs(liveArgs()),
      {
        releaseManifestSource: JSON.stringify(VERIFIED_RELEASE.manifest, null, 2),
        releaseReceiptsSource: RELEASE_RECEIPTS_SOURCE,
        get token() {
          dependencyRead = true;
          throw new Error("dependency must not be read");
        },
      },
    ),
    /canonical verified five-APK release metadata/,
  );
  assert.equal(dependencyRead, false);
});

test("suite execution rejects a missing serial before reading dependencies", async () => {
  let dependencyRead = false;
  await assert.rejects(
    executePhysicalSuite(
      {
        ...parsePhysicalCliArgs(liveArgs()),
        serial: null,
      },
      {
        get token() {
          dependencyRead = true;
          throw new Error("dependency must not be read");
        },
      },
    ),
    /valid explicit ADB serial/,
  );
  assert.equal(dependencyRead, false);
});
