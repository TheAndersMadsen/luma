import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("./fixtures/source-resolve.mjs", import.meta.url);

const {
  EXPLOIT_STAGE1_ACTION,
  EXPLOIT_STAGE2_ACTION,
  buildFreshBootstrapBroadcastCommand,
  buildFreshBootstrapTransaction,
  runVerifiedBootstrapStage,
  waitForExpectedBootstrapStatus,
} = await import(
  "../src/lib/pin-device/adb/systemInstaller.ts?pin-bootstrap-protocol-test"
);

const TRANSACTION_ID = "0123456789abcdef0123456789abcdef";

test("fresh bootstrap binds both stage commands to the same complete transaction", () => {
  const transaction = buildFreshBootstrapTransaction(TRANSACTION_ID);
  assert.deepEqual(transaction, {
    transactionId: TRANSACTION_ID,
    deviceApkPath: `/data/local/tmp/installer-${TRANSACTION_ID}.apk`,
    extras: {
      transaction_id: TRANSACTION_ID,
      mode: "fresh",
      target_app_dir: "com.penumbraos.systeminjector-injected",
      apk_path: `/data/local/tmp/installer-${TRANSACTION_ID}.apk`,
    },
  });

  const commands = [EXPLOIT_STAGE1_ACTION, EXPLOIT_STAGE2_ACTION].map((action) =>
    buildFreshBootstrapBroadcastCommand(action, transaction.extras),
  );
  for (const [index, command] of commands.entries()) {
    assert.deepEqual(command.slice(0, 2), ["sh", "-c"]);
    const line = command[2];
    assert.equal(line.match(/--es/gu)?.length, 4);
    for (const [key, value] of Object.entries(transaction.extras)) {
      assert.ok(line.includes(key), `stage ${index + 1} omitted ${key}`);
      assert.ok(line.includes(value), `stage ${index + 1} omitted ${value}`);
    }
    assert.ok(line.includes(index === 0 ? EXPLOIT_STAGE1_ACTION : EXPLOIT_STAGE2_ACTION));
    assert.equal(line.includes("/data/local/tmp/installer.apk"), false);
  }
});

test("durable exploit failure stops status polling immediately", async () => {
  let now = 0;
  let delays = 0;
  await assert.rejects(
    () =>
      waitForExpectedBootstrapStatus(
        {
          readStatus: async () => ({
            transactionId: TRANSACTION_ID,
            phase: "failed",
            detail: "certificate reference rejected",
          }),
          delay: async (milliseconds) => {
            delays += 1;
            now += milliseconds;
          },
          now: () => now,
        },
        TRANSACTION_ID,
        "stage1_ready",
        10_000,
      ),
    /Exploit transaction failed: certificate reference rejected/,
  );
  assert.equal(delays, 0);
});

test("a stage cannot continue to restart or readiness checks without durable completion", async () => {
  const calls = [];
  const transaction = buildFreshBootstrapTransaction(TRANSACTION_ID);

  await assert.rejects(
    () =>
      runVerifiedBootstrapStage(
        {
          getSystemServerPid: async () => {
            calls.push("pid");
            return "1511";
          },
          sendStageBroadcast: async (extras) => {
            calls.push("broadcast");
            assert.deepEqual(extras, transaction.extras);
          },
          waitForStatus: async (_id, phase) => {
            calls.push(`status:${phase}`);
            throw new Error("no durable status");
          },
          waitForSystemServerRestart: async () => calls.push("restart"),
          waitForSystemReady: async () => calls.push("ready"),
        },
        TRANSACTION_ID,
        "stage1_ready",
        transaction.extras,
      ),
    /no durable status/,
  );

  assert.deepEqual(calls, ["pid", "broadcast", "status:stage1_ready"]);
});

test("a verified stage requires the old PID transition and rechecks status after boot", async () => {
  const calls = [];
  const transaction = buildFreshBootstrapTransaction(TRANSACTION_ID);
  await runVerifiedBootstrapStage(
    {
      getSystemServerPid: async () => {
        calls.push("pid");
        return "1511";
      },
      sendStageBroadcast: async () => calls.push("broadcast"),
      waitForStatus: async (_id, phase) => calls.push(`status:${phase}`),
      waitForSystemServerRestart: async (previousPid) =>
        calls.push(`restart:${previousPid}`),
      waitForSystemReady: async () => calls.push("ready"),
    },
    TRANSACTION_ID,
    "stage2_committed",
    transaction.extras,
  );

  assert.deepEqual(calls, [
    "pid",
    "broadcast",
    "status:stage2_committed",
    "restart:1511",
    "ready",
    "status:stage2_committed",
  ]);
});

test("the bootstrapped installer never asks Android to parse the host PKCS12 store", async () => {
  const [patcher, build, releaseGate] = await Promise.all([
    readFile(
      new URL(
        "../../pin/injector/installer/src/main/kotlin/com/penumbraos/systeminjector/ApkPatcher.kt",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../../pin/injector/installer/build.gradle.kts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../platform/containers/pin-builder/entrypoint.sh", import.meta.url),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(patcher, /KeyStore\.getInstance\("PKCS12"\)/u);
  assert.match(patcher, /PKCS8EncodedKeySpec/u);
  assert.match(patcher, /CertificateFactory\.getInstance\("X\.509"\)/u);
  assert.match(build, /abxdroppedapk-private-key\.pk8/u);
  assert.match(build, /abxdroppedapk-certificate\.der/u);
  assert.match(releaseGate, /patch-signing key\/certificate mismatch/u);
  assert.match(releaseGate, /Android-incompatible PKCS#12 store/u);
});
