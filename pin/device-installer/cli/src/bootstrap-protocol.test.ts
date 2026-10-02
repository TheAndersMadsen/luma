import assert from "node:assert/strict";
import test from "node:test";
import {
  appDirToCodePath,
  buildBootstrapTransactionExtras,
  buildRecoveryRollbackExtras,
  buildRecoveryStage2Extras,
  parseBootstrapStatusMessage,
  parseOrphanBootstrapSessionPair,
  parsePackageBaseApkPath,
  parseSha256Output,
  runVerifiedBootstrapStage,
  waitForExpectedBootstrapStatus,
  type BootstrapPhase,
} from "./bootstrap-protocol.js";

function recoverySessionBlock(
  id: number,
  stageDir: string,
  overrides = ""
): string {
  return `  Session ${id}:
    userId=0 mOriginalInstallerUid=10123 mOriginalInstallerPackageName=com.penumbraos.systeminjector.exploit
    installerPackageName=com.penumbraos.systeminjector.exploit installInitiatingPackageName=null
    installOriginatingPackageName=null mInstallerUid=10123 createdMillis=1784134603330 updatedMillis=1784134603330
    committedMillis=0 stageDir=${stageDir} stageCid=null
    mode=1 installFlags=0x0 installLocation=0 installReason=0 installScenario=0 sizeBytes=0 appPackageName=null
    mCommitted=false mSealed=false mPermissionsManuallyAccepted=false
    mRelinquished=false mDestroyed=false mFds=0 mBridges=0 mFinalStatus=0 mFinalMessage=null
    params.isMultiPackage=false params.isStaged=false mParentSessionId=-1 mChildSessionIds=[]
${overrides}`;
}

function recoveryDump(
  systemId = 519605356,
  targetId = 519605357,
  systemOverrides = "",
  targetOverrides = ""
): string {
  return `Active install sessions:
${recoverySessionBlock(systemId, "/data/system", systemOverrides)}
${recoverySessionBlock(
    targetId,
    "/data/app/com.penumbraos.systeminjector-replacement-0dcf137c7c2b",
    targetOverrides
  )}
Finalized install sessions:

Historical install sessions:
`;
}

test("parses exact durable bootstrap status messages", () => {
  const transactionId = "a".repeat(32);
  const detail = Buffer.from("packages.xml rejected", "utf8").toString("base64url");
  assert.deepEqual(
    parseBootstrapStatusMessage(
      `BOOTSTRAP_STATUS:${transactionId}:failed:${detail}`
    ),
    { transactionId, phase: "failed", detail: "packages.xml rejected" }
  );
  assert.equal(parseBootstrapStatusMessage("NO_STATUS"), null);
  assert.throws(
    () => parseBootstrapStatusMessage(`BOOTSTRAP_STATUS:${transactionId}:success:`),
    /Invalid bootstrap status/
  );
});

test("accepts only controlled Device Installer code paths and exact remote digests", () => {
  const codePath = appDirToCodePath(
    `com.penumbraos.systeminjector-replacement-${"b".repeat(12)}`
  );
  assert.equal(codePath, `/data/app/com.penumbraos.systeminjector-replacement-${"b".repeat(12)}`);
  assert.equal(
    parsePackageBaseApkPath(`package:${codePath}/base.apk\n`),
    `${codePath}/base.apk`
  );
  assert.equal(
    parseSha256Output(`${"C".repeat(64)}  ${codePath}/base.apk`),
    "c".repeat(64)
  );
  assert.throws(
    () => parsePackageBaseApkPath("package:/data/app/other/base.apk"),
    /Invalid active Device Installer app directory/
  );
});

test("uses one complete transaction payload for both bootstrap stages", () => {
  const transactionId = "e".repeat(32);
  assert.deepEqual(
    buildBootstrapTransactionExtras({
      mode: "replace",
      transactionId,
      targetAppDir: `com.penumbraos.systeminjector-replacement-${"f".repeat(12)}`,
      apkPath: `/data/local/tmp/installer-${transactionId}.apk`,
      expectedCurrentCodePath: "/data/app/com.penumbraos.systeminjector-injected",
      replacementCodePath:
        `/data/app/com.penumbraos.systeminjector-replacement-${"f".repeat(12)}`,
    }),
    {
      transaction_id: transactionId,
      mode: "replace",
      target_app_dir: `com.penumbraos.systeminjector-replacement-${"f".repeat(12)}`,
      apk_path: `/data/local/tmp/installer-${transactionId}.apk`,
      expected_current_code_path: "/data/app/com.penumbraos.systeminjector-injected",
      replacement_code_path:
        `/data/app/com.penumbraos.systeminjector-replacement-${"f".repeat(12)}`,
    }
  );
  assert.throws(
    () => buildBootstrapTransactionExtras({
      mode: "replace",
      transactionId,
      targetAppDir: `com.penumbraos.systeminjector-replacement-${"f".repeat(12)}`,
      expectedCurrentCodePath: "/data/app/com.penumbraos.systeminjector-injected",
      replacementCodePath:
        `/data/app/com.penumbraos.systeminjector-replacement-${"f".repeat(12)}`,
    }),
    /staged APK path/
  );
});

test("rollback restores a transaction-bound backup only into a fresh controlled path", () => {
  const transactionId = "1".repeat(32);
  const targetAppDir = `com.penumbraos.systeminjector-rollback-${"2".repeat(12)}`;
  assert.deepEqual(
    buildBootstrapTransactionExtras({
      mode: "rollback",
      transactionId,
      targetAppDir,
      apkPath: `/data/local/tmp/installer-${transactionId}.apk`,
      expectedCurrentCodePath:
        `/data/app/com.penumbraos.systeminjector-replacement-${"3".repeat(12)}`,
      replacementCodePath: "/data/app/com.penumbraos.systeminjector-injected",
    }),
    {
      transaction_id: transactionId,
      mode: "rollback",
      target_app_dir: targetAppDir,
      apk_path: `/data/local/tmp/installer-${transactionId}.apk`,
      expected_current_code_path:
        `/data/app/com.penumbraos.systeminjector-replacement-${"3".repeat(12)}`,
      replacement_code_path: "/data/app/com.penumbraos.systeminjector-injected",
    }
  );
  assert.throws(
    () => buildBootstrapTransactionExtras({
      mode: "rollback",
      transactionId,
      targetAppDir: `com.penumbraos.systeminjector-rollback-${"3".repeat(12)}`,
      apkPath: `/data/local/tmp/installer-${transactionId}.apk`,
      expectedCurrentCodePath:
        `/data/app/com.penumbraos.systeminjector-rollback-${"3".repeat(12)}`,
      replacementCodePath: "/data/app/com.penumbraos.systeminjector-injected",
    }),
    /fresh restore directory/
  );
});

test("verified bootstrap step requires status, PID transition, readiness, and final status", async () => {
  const events: string[] = [];
  const transactionId = "c".repeat(32);
  const expectedPhase: BootstrapPhase = "stage2_committed";

  await runVerifiedBootstrapStage(
    {
      async getSystemServerPid() {
        events.push("pid");
        return "100";
      },
      async sendStageBroadcast() {
        events.push("broadcast");
      },
      async waitForStatus() {
        events.push(events.includes("ready") ? "status-after" : "status-before");
      },
      async waitForSystemServerRestart(previousPid) {
        events.push(`restart:${previousPid}`);
      },
      async waitForSystemReady() {
        events.push("ready");
      },
    },
    transactionId,
    expectedPhase,
    { transaction_id: transactionId },
    1000
  );

  assert.deepEqual(events, [
    "pid",
    "broadcast",
    "status-before",
    "restart:100",
    "ready",
    "status-after",
  ]);
});

test("verified bootstrap step propagates a durable failure after restart", async () => {
  const transactionId = "d".repeat(32);
  let statusChecks = 0;
  await assert.rejects(
    runVerifiedBootstrapStage(
      {
        async getSystemServerPid() { return "100"; },
        async sendStageBroadcast() {},
        async waitForStatus() {
          statusChecks += 1;
          if (statusChecks === 2) {
            throw new Error("Bootstrap transaction failed: write failed");
          }
        },
        async waitForSystemServerRestart() {},
        async waitForSystemReady() {},
      },
      transactionId,
      "stage1_ready",
      { transaction_id: transactionId },
      1000
    ),
    /write failed/
  );
});

test("parses exactly one untouched orphan bootstrap pair from dumpsys", () => {
  assert.deepEqual(parseOrphanBootstrapSessionPair(recoveryDump()), {
    systemSessionId: 519605356,
    targetSessionId: 519605357,
    installerUid: 10123,
    createdMillis: 1784134603330,
    targetAppDir: "com.penumbraos.systeminjector-replacement-0dcf137c7c2b",
    targetCodePath:
      "/data/app/com.penumbraos.systeminjector-replacement-0dcf137c7c2b",
  });
});

test("orphan parser rejects missing delimiters, duplicate fields, unsafe numbers, and dirty state", () => {
  assert.throws(
    () => parseOrphanBootstrapSessionPair(recoveryDump().replace("Finalized install sessions:", "")),
    /delimit/
  );
  assert.throws(
    () => parseOrphanBootstrapSessionPair(recoveryDump(519605356, 519605357, "    mFds=0\n")),
    /exactly one mFds/
  );
  assert.throws(
    () => parseOrphanBootstrapSessionPair(
      recoveryDump().replaceAll("createdMillis=1784134603330", "createdMillis=999999999999999999")
    ),
    /invalid createdMillis/
  );
  assert.throws(
    () => parseOrphanBootstrapSessionPair(
      recoveryDump().replace("mRelinquished=false", "mRelinquished=true")
    ),
    /not an untouched bootstrap session/
  );
  assert.throws(
    () => parseOrphanBootstrapSessionPair(recoveryDump(519605356, 519605358)),
    /missing or not consecutive/
  );
});

test("orphan parser rejects every mutable or finalized session state", () => {
  const mutations: Array<[string, string]> = [
    ["userId=0", "userId=10"],
    ["mOriginalInstallerUid=10123", "mOriginalInstallerUid=10124"],
    ["mInstallerUid=10123", "mInstallerUid=10124"],
    ["committedMillis=0", "committedMillis=1"],
    ["mode=1", "mode=2"],
    ["installFlags=0x0", "installFlags=0x1"],
    ["mCommitted=false", "mCommitted=true"],
    ["mSealed=false", "mSealed=true"],
    ["mRelinquished=false", "mRelinquished=true"],
    ["mDestroyed=false", "mDestroyed=true"],
    ["mFds=0", "mFds=1"],
    ["mBridges=0", "mBridges=1"],
    ["mFinalStatus=0", "mFinalStatus=1"],
    ["mFinalMessage=null", "mFinalMessage=finished"],
    ["params.isMultiPackage=false", "params.isMultiPackage=true"],
    ["params.isStaged=false", "params.isStaged=true"],
    ["mParentSessionId=-1", "mParentSessionId=9"],
    ["mChildSessionIds=[]", "mChildSessionIds=[9]"],
  ];
  for (const [before, after] of mutations) {
    assert.throws(
      () => parseOrphanBootstrapSessionPair(recoveryDump().replace(before, after)),
      /./,
      `${before} -> ${after} must fail closed`
    );
  }
});

test("orphan parser rejects any extra helper-owned or data-system session", () => {
  const extra = recoverySessionBlock(700, "/data/app/vmdl700.tmp");
  assert.throws(
    () => parseOrphanBootstrapSessionPair(
      recoveryDump().replace("Finalized install sessions:", `${extra}\nFinalized install sessions:`)
    ),
    /exactly two active helper-owned sessions/
  );
  assert.throws(
    () => parseOrphanBootstrapSessionPair(
      recoveryDump().replace(
        "Finalized install sessions:",
        `${recoverySessionBlock(701, "/data/system").replaceAll(
          "com.penumbraos.systeminjector.exploit",
          "other.installer"
        )}\nFinalized install sessions:`
      )
    ),
    /exactly one active \/data\/system session/
  );
});

test("builds separately gated recovery Stage 2 and fresh rollback payloads", () => {
  const transactionId = "8".repeat(32);
  const targetAppDir = "com.penumbraos.systeminjector-replacement-0dcf137c7c2b";
  const stage2 = buildRecoveryStage2Extras({
    mode: "replace",
    transactionId,
    targetAppDir,
    apkPath: `/data/local/tmp/installer-${transactionId}.apk`,
    expectedCurrentCodePath: "/data/app/com.penumbraos.systeminjector-injected",
    replacementCodePath: `/data/app/${targetAppDir}`,
    systemSessionId: 519605356,
    targetSessionId: 519605357,
    orphanInstallerUid: 10123,
    orphanCreatedMillis: 1784134603330,
    expectedCurrentSha256: "a".repeat(64),
    replacementSha256: "b".repeat(64),
  });
  assert.equal(stage2.recovery_system_session_id, "519605356");
  assert.equal(stage2.recovery_target_session_id, "519605357");
  assert.equal(stage2.recovery_created_millis, "1784134603330");

  const rollbackTransactionId = "9".repeat(32);
  const rollback = buildRecoveryRollbackExtras({
    transactionId: rollbackTransactionId,
    systemSessionId: 519605356,
    orphanInstallerUid: 10123,
    orphanCreatedMillis: 1784134603330,
    priorCodePath: "/data/app/com.penumbraos.systeminjector-injected",
    possibleReplacementCodePath: `/data/app/${targetAppDir}`,
    expectedPriorSha256: "a".repeat(64),
  });
  assert.equal(rollback.transaction_id, rollbackTransactionId);
  assert.equal(rollback.recovery_system_session_id, "519605356");
  assert.equal(rollback.recovery_target_session_id, undefined);
  assert.equal(rollback.apk_path, undefined);
  assert.notEqual(rollback.transaction_id, stage2.transaction_id);
});

test("status polling retries transient provider blanks and uses a fresh rollback namespace", async () => {
  const failedStage2Transaction = "a".repeat(32);
  const rollbackTransaction = "b".repeat(32);
  let now = 0;
  let rollbackReads = 0;
  await waitForExpectedBootstrapStatus(
    {
      async readStatus(transactionId) {
        assert.equal(transactionId, rollbackTransaction);
        assert.notEqual(transactionId, failedStage2Transaction);
        rollbackReads += 1;
        if (rollbackReads < 3) throw new Error("Invalid bootstrap status response: ");
        return { transactionId, phase: "rollback_committed", detail: "" };
      },
      async delay(milliseconds) { now += milliseconds; },
      now: () => now,
    },
    rollbackTransaction,
    "rollback_committed",
    5_000,
    500
  );
  assert.equal(rollbackReads, 3);
});
