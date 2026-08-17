import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import * as adb from "./adb.js";
import { requireApkApplicationId } from "./apk.js";
import {
  extractProviderMessage,
  installWithSafeUpdates,
  parseProviderInstallResponse,
} from "./install-protocol.js";
import {
  appDirToCodePath,
  buildBootstrapTransactionExtras,
  buildRecoveryRollbackExtras,
  buildRecoveryStage2Extras,
  parseBootstrapStatusMessage,
  parseOrphanBootstrapSessionPair,
  requireInjectorCodePath,
  runVerifiedBootstrapStage,
  waitForExpectedBootstrapStatus,
  type BootstrapPhase,
  type BootstrapStatus,
  type BootstrapTransactionSpec,
  type RecoveryStage2Spec,
  type RecoveryRollbackSpec,
} from "./bootstrap-protocol.js";
import {
  INSTALLER_PACKAGE,
  EXPLOIT_PACKAGE,
  EXPLOIT_STAGE1_ACTION,
  EXPLOIT_STAGE2_ACTION,
  EXPLOIT_RECOVER_STAGE2_ACTION,
  EXPLOIT_RECOVER_ROLLBACK_ACTION,
  EXPLOIT_RECEIVER,
  EXPLOIT_STATUS_URI,
  DEVICE_TMP_DIR,
  STAGING_URI,
  SYSTEM_READY_TIMEOUT_MS,
  SYSTEM_READY_POLL_MS,
  SYSTEM_RESTART_TIMEOUT_MS,
  BOOTSTRAP_STATUS_TIMEOUT_MS,
  SYSTEM_READY_SETTLE_MS,
  INSTALLER_APK,
  EXPLOIT_APK,
} from "./constants.js";

const USER_SYSTEM = 0;
const FRESH_INSTALLER_APP_DIR = "com.penumbraos.systeminjector-injected";
const MAX_BOOTSTRAP_APK_BYTES = 512 * 1024 * 1024;

function newTransactionId(): string {
  return randomBytes(16).toString("hex");
}

async function sha256LocalFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => digest.update(chunk));
    input.on("end", resolve);
    input.on("error", reject);
  });
  return digest.digest("hex");
}

function resolveBootstrapApks(
  installerApk?: string,
  exploitApk?: string
): { installerApk: string; exploitApk: string } {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const resolvedInstallerApk = installerApk || path.resolve(cliDir, "..", INSTALLER_APK);
  const resolvedExploitApk = exploitApk || path.resolve(cliDir, "..", EXPLOIT_APK);
  if (!fs.existsSync(resolvedInstallerApk)) {
    throw new Error(
      `Installer APK not found: ${resolvedInstallerApk}\n` +
        `Run 'cd .. && ./gradlew :installer:assembleRelease' first.`
    );
  }
  if (!fs.existsSync(resolvedExploitApk)) {
    throw new Error(
      `Exploit APK not found: ${resolvedExploitApk}\n` +
        `Run 'cd .. && ./gradlew :exploit:assembleRelease' first.`
    );
  }
  for (const [label, apkPath] of [
    ["Installer", resolvedInstallerApk],
    ["Exploit", resolvedExploitApk],
  ] as const) {
    const stat = fs.statSync(apkPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BOOTSTRAP_APK_BYTES) {
      throw new Error(`${label} APK has an invalid size: ${apkPath}`);
    }
  }
  return { installerApk: resolvedInstallerApk, exploitApk: resolvedExploitApk };
}

async function readBootstrapStatus(transactionId: string): Promise<BootstrapStatus | null> {
  const output = await adb.contentCall(EXPLOIT_STATUS_URI, "status", transactionId);
  const message = extractProviderMessage(output);
  if (message === null) throw new Error(`Invalid exploit status response: ${output}`);
  const status = parseBootstrapStatusMessage(message);
  if (status !== null && status.transactionId !== transactionId) {
    throw new Error(`Exploit status belongs to a different transaction: ${status.transactionId}`);
  }
  return status;
}

async function waitForBootstrapStatus(
  transactionId: string,
  expectedPhase: BootstrapPhase,
  timeoutMs: number
): Promise<void> {
  return waitForExpectedBootstrapStatus(
    {
      readStatus: readBootstrapStatus,
      delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: Date.now,
    },
    transactionId,
    expectedPhase,
    timeoutMs
  );
}

async function runExploitStage(
  action: string,
  transactionId: string,
  expectedPhase: BootstrapPhase,
  extras: Record<string, string>
): Promise<void> {
  await runVerifiedBootstrapStage(
    {
      getSystemServerPid: adb.getSystemServerPid,
      sendStageBroadcast: async (stageExtras) => {
        await adb.broadcast(action, stageExtras, EXPLOIT_RECEIVER);
      },
      waitForStatus: waitForBootstrapStatus,
      waitForSystemServerRestart: (previousPid) =>
        adb.waitForSystemServerRestart(
          previousPid,
          SYSTEM_RESTART_TIMEOUT_MS,
          SYSTEM_READY_POLL_MS
        ),
      waitForSystemReady: () =>
        adb.waitForSystemReady(
          SYSTEM_READY_TIMEOUT_MS,
          SYSTEM_READY_POLL_MS,
          SYSTEM_READY_SETTLE_MS
        ),
    },
    transactionId,
    expectedPhase,
    extras,
    BOOTSTRAP_STATUS_TIMEOUT_MS
  );
}

async function runExploitTransaction(
  transaction: BootstrapTransactionSpec,
  onBeforeStage2?: () => void
): Promise<void> {
  const commonExtras = buildBootstrapTransactionExtras(transaction);

  await runExploitStage(
    EXPLOIT_STAGE1_ACTION,
    transaction.transactionId,
    "stage1_ready",
    commonExtras
  );

  onBeforeStage2?.();
  await runExploitStage(
    EXPLOIT_STAGE2_ACTION,
    transaction.transactionId,
    transaction.mode === "rollback" ? "rollback_committed" : "stage2_committed",
    commonExtras
  );
}

async function prepareExploit(exploitApk: string): Promise<void> {
  if (await adb.isInstalled(EXPLOIT_PACKAGE)) {
    await adb.uninstall(EXPLOIT_PACKAGE);
    if (await adb.isInstalled(EXPLOIT_PACKAGE)) {
      throw new Error(`Unable to remove stale exploit package ${EXPLOIT_PACKAGE}`);
    }
  }
  await adb.installReplacing(exploitApk);
  if (!(await adb.isInstalled(EXPLOIT_PACKAGE))) {
    throw new Error(`Exploit package ${EXPLOIT_PACKAGE} did not install`);
  }
}

/** Reinstall the helper without discarding the orphan pair's UID ownership. */
async function prepareRecoveryExploit(
  exploitApk: string,
  expectedInstallerUid: number,
  expectedDigest: string
): Promise<void> {
  if (await adb.isInstalled(EXPLOIT_PACKAGE)) {
    const installedUid = await adb.getPackageUidForUser(EXPLOIT_PACKAGE, USER_SYSTEM);
    if (installedUid !== expectedInstallerUid) {
      throw new Error(
        `Installed recovery helper UID ${installedUid} does not own orphan sessions ` +
          `(expected ${expectedInstallerUid})`
      );
    }
  }
  await adb.installReplacing(exploitApk);
  if (!(await adb.isInstalled(EXPLOIT_PACKAGE))) {
    throw new Error(`Recovery helper ${EXPLOIT_PACKAGE} did not install`);
  }
  const installedUid = await adb.getPackageUidForUser(EXPLOIT_PACKAGE, USER_SYSTEM);
  if (installedUid !== expectedInstallerUid) {
    try { await adb.uninstall(EXPLOIT_PACKAGE); } catch { /* preserve the primary error */ }
    throw new Error(
      `Recovery helper was assigned UID ${installedUid}, but orphan sessions belong to ` +
      `${expectedInstallerUid}. No orphan session was opened.`
    );
  }
  const installedPath = await adb.getRegularPackageBaseApkPath(
    EXPLOIT_PACKAGE,
    USER_SYSTEM
  );
  const installedDigest = await adb.sha256RemoteRegularBaseApk(installedPath);
  if (installedDigest !== expectedDigest) {
    throw new Error(
      `Installed recovery helper digest ${installedDigest} does not match local artifact ` +
        expectedDigest
    );
  }
}

async function cleanupExploit(): Promise<void> {
  if (await adb.isInstalled(EXPLOIT_PACKAGE)) {
    await adb.uninstall(EXPLOIT_PACKAGE);
  }
  if (await adb.isInstalled(EXPLOIT_PACKAGE)) {
    throw new Error(
      `Security cleanup failed: exploit package ${EXPLOIT_PACKAGE} remains installed`
    );
  }
}

async function verifyInstalledArtifact(
  expectedBaseApkPath: string,
  expectedDigest: string
): Promise<void> {
  const installedUid = await adb.getPackageUidForUser(INSTALLER_PACKAGE, USER_SYSTEM);
  if (installedUid !== 1000) {
    throw new Error(`Injector has unexpected UID ${installedUid}; expected system UID 1000`);
  }
  const installedPath = await adb.getPackageBaseApkPath(INSTALLER_PACKAGE, USER_SYSTEM);
  if (installedPath !== expectedBaseApkPath) {
    throw new Error(
      `Injector activated from unexpected code path: ${installedPath}; ` +
        `expected ${expectedBaseApkPath}`
    );
  }
  const installedDigest = await adb.sha256RemoteBaseApk(installedPath);
  if (installedDigest !== expectedDigest) {
    throw new Error(
      `Injector APK digest mismatch after restart: got ${installedDigest}, ` +
        `expected ${expectedDigest}`
    );
  }
}

/**
 * Check if the installer is already bootstrapped on the device.
 */
export async function isBootstrapped(): Promise<boolean> {
  return adb.isInstalled(INSTALLER_PACKAGE);
}

/** Fresh-only bootstrap. Existing injectors require the explicit replacement command below. */
export async function bootstrap(
  installerApk?: string,
  exploitApk?: string
): Promise<void> {
  const resolved = resolveBootstrapApks(installerApk, exploitApk);
  await adb.requirePhysicalUsbTransport();
  if (await isBootstrapped()) {
    throw new Error(
      `${INSTALLER_PACKAGE} is already installed. Fresh bootstrap will not overwrite it. ` +
        `Use 'system-injector replace-installer <installer.apk>' explicitly.`
    );
  }

  const transactionId = newTransactionId();
  const deviceApkPath = `${DEVICE_TMP_DIR}/installer-${transactionId}.apk`;
  const targetCodePath = appDirToCodePath(FRESH_INSTALLER_APP_DIR);
  const expectedDigest = await sha256LocalFile(resolved.installerApk);

  try {
    console.log("[1/5] Installing the temporary bootstrap helper...");
    await prepareExploit(resolved.exploitApk);
    console.log("[2/5] Staging the injector artifact...");
    await adb.push(resolved.installerApk, deviceApkPath);
    console.log("[3/5] Committing fresh package settings (two verified restarts)...");
    await runExploitTransaction({
      mode: "fresh",
      transactionId,
      targetAppDir: FRESH_INSTALLER_APP_DIR,
      apkPath: deviceApkPath,
    });
    console.log("[4/5] Verifying the active code path and APK digest...");
    await verifyInstalledArtifact(`${targetCodePath}/base.apk`, expectedDigest);
    console.log("[5/5] Removing bootstrap helper and temporary artifact...");
    await adb.removeRemoteFile(deviceApkPath);
    await cleanupExploit();
  } catch (error) {
    const cleanupFailures: string[] = [];
    try { await adb.removeRemoteFile(deviceApkPath); } catch (cleanupError) {
      cleanupFailures.push(`remote artifact: ${String(cleanupError)}`);
    }
    try { await cleanupExploit(); } catch (cleanupError) {
      cleanupFailures.push(`exploit package: ${String(cleanupError)}`);
    }
    if (cleanupFailures.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Cleanup also failed: ` +
          cleanupFailures.join("; "),
        { cause: error }
      );
    }
    throw error;
  }

  console.log("Bootstrap complete! Installer is running as UID 1000.");
}

/**
 * Explicitly replace a live injector using a new code directory and one package-settings
 * transaction. The old directory and a host backup remain untouched until verification.
 */
export async function replaceInstaller(
  installerApk: string,
  exploitApk?: string
): Promise<void> {
  const resolved = resolveBootstrapApks(installerApk, exploitApk);
  await adb.requirePhysicalUsbTransport();
  if (!(await isBootstrapped())) {
    throw new Error(
      `${INSTALLER_PACKAGE} is not installed. Use 'system-injector bootstrap' for a fresh device.`
    );
  }

  const oldBaseApkPath = await adb.getPackageBaseApkPath(INSTALLER_PACKAGE, USER_SYSTEM);
  const oldCodePath = requireInjectorCodePath(path.posix.dirname(oldBaseApkPath));
  const oldDigest = await adb.sha256RemoteBaseApk(oldBaseApkPath);
  const expectedDigest = await sha256LocalFile(resolved.installerApk);
  if (oldDigest === expectedDigest) {
    throw new Error("Requested injector artifact is already active; refusing a no-op replacement");
  }

  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "system-injector-backup-"));
  const backupApk = path.join(backupDir, "previous-base.apk");
  await adb.pull(oldBaseApkPath, backupApk);
  if ((await sha256LocalFile(backupApk)) !== oldDigest) {
    throw new Error(`Host rollback backup digest mismatch; backup retained at ${backupApk}`);
  }

  const transactionId = newTransactionId();
  const targetAppDir = `com.penumbraos.systeminjector-replacement-${transactionId.slice(0, 12)}`;
  const targetCodePath = appDirToCodePath(targetAppDir);
  const deviceApkPath = `${DEVICE_TMP_DIR}/installer-${transactionId}.apk`;
  let replacementSettingsMayBeDirty = false;
  let rollbackDeviceApkPath: string | null = null;

  try {
    console.log("[1/4] Backed up the active injector and installing the bootstrap helper...");
    await prepareExploit(resolved.exploitApk);
    console.log("[2/4] Staging the replacement in a new, non-live code directory...");
    await adb.push(resolved.installerApk, deviceApkPath);
    console.log("[3/4] Committing replacement package settings (two verified restarts)...");
    await runExploitTransaction({
      mode: "replace",
      transactionId,
      targetAppDir,
      apkPath: deviceApkPath,
      expectedCurrentCodePath: oldCodePath,
      replacementCodePath: targetCodePath,
    }, () => {
      // From this point, a delivered stage-2 broadcast may have written packages-backup.xml
      // even when ADB loses the response. Any failure must restore the verified backup into a
      // fresh rollback directory and point package settings at that restored copy.
      replacementSettingsMayBeDirty = true;
    });
    console.log("[4/4] Verifying active replacement code path and APK digest...");
    await verifyInstalledArtifact(`${targetCodePath}/base.apk`, expectedDigest);
  } catch (replacementError) {
    const rollbackFailures: string[] = [];
    let previousVerified = false;
    if (replacementSettingsMayBeDirty) {
      try {
        const rollbackTransactionId = newTransactionId();
        const rollbackTargetAppDir =
          `com.penumbraos.systeminjector-rollback-${rollbackTransactionId.slice(0, 12)}`;
        const rollbackCodePath = appDirToCodePath(rollbackTargetAppDir);
        rollbackDeviceApkPath = `${DEVICE_TMP_DIR}/installer-${rollbackTransactionId}.apk`;
        console.error(
          "Replacement failed; restoring the verified backup into a fresh rollback path..."
        );
        await adb.push(backupApk, rollbackDeviceApkPath);
        await runExploitTransaction({
          mode: "rollback",
          transactionId: rollbackTransactionId,
          targetAppDir: rollbackTargetAppDir,
          apkPath: rollbackDeviceApkPath,
          expectedCurrentCodePath: targetCodePath,
          replacementCodePath: oldCodePath,
        });
        await verifyInstalledArtifact(`${rollbackCodePath}/base.apk`, oldDigest);
        previousVerified = true;
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        );
      }
    } else {
      try {
        await verifyInstalledArtifact(oldBaseApkPath, oldDigest);
        previousVerified = true;
      } catch (verificationError) {
        rollbackFailures.push(
          `previous injector verification: ${
            verificationError instanceof Error ? verificationError.message : String(verificationError)
          }`
        );
      }
    }

    try { await adb.removeRemoteFile(deviceApkPath); } catch (cleanupError) {
      rollbackFailures.push(`remote cleanup: ${String(cleanupError)}`);
    }
    if (rollbackDeviceApkPath !== null) {
      try { await adb.removeRemoteFile(rollbackDeviceApkPath); } catch (cleanupError) {
        rollbackFailures.push(`rollback artifact cleanup: ${String(cleanupError)}`);
      }
    }
    try { await cleanupExploit(); } catch (cleanupError) {
      rollbackFailures.push(`exploit cleanup: ${String(cleanupError)}`);
    }
    if (previousVerified && rollbackFailures.length === 0) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }

    const originalMessage =
      replacementError instanceof Error ? replacementError.message : String(replacementError);
    if (rollbackFailures.length > 0) {
      throw new Error(
        `${originalMessage} Automatic rollback/cleanup failed: ${rollbackFailures.join("; ")}. ` +
          `Emergency APK backup retained at ${backupApk}`,
        { cause: replacementError }
      );
    }
    throw new Error(`${originalMessage} The previous injector was restored and verified.`, {
      cause: replacementError,
    });
  }

  // The replacement is now active and digest-verified. Finalization is deliberately separate:
  // a lost provider response could mean the old directory was already deleted, so it is unsafe
  // to attempt an automatic rollback after this point.
  const finalizationFailures: string[] = [];
  try {
    console.log("Finalizing the verified replacement and removing its inactive old code directory...");
    const finalizeOutput = await adb.contentCall(
      STAGING_URI,
      "finalize_bootstrap_replacement",
      `${oldCodePath},${oldDigest}`
    );
    if (parseProviderInstallResponse(finalizeOutput).kind !== "ok") {
      throw new Error(`Injector refused replacement finalization: ${finalizeOutput}`);
    }
  } catch (finalizationError) {
    finalizationFailures.push(
      finalizationError instanceof Error ? finalizationError.message : String(finalizationError)
    );
  }
  try { await adb.removeRemoteFile(deviceApkPath); } catch (cleanupError) {
    finalizationFailures.push(`remote cleanup: ${String(cleanupError)}`);
  }
  try { await cleanupExploit(); } catch (cleanupError) {
    finalizationFailures.push(`exploit cleanup: ${String(cleanupError)}`);
  }

  if (finalizationFailures.length > 0) {
    throw new Error(
      `The replacement is active and digest-verified, but physical-maintenance finalization ` +
        `failed: ${finalizationFailures.join("; ")}. Emergency APK backup retained at ${backupApk}`
    );
  }

  fs.rmSync(backupDir, { recursive: true, force: true });
  console.log("Injector replacement complete and verified.");
}

/**
 * Resume only the second stage of one strictly verified orphan bootstrap pair.
 * This path never calls STAGE1, so it cannot create another /data/system session.
 */
export async function recoverReplacementStage2(
  installerApk: string,
  exploitApk?: string
): Promise<void> {
  const resolved = resolveBootstrapApks(installerApk, exploitApk);
  await requireApkApplicationId(resolved.installerApk, INSTALLER_PACKAGE);
  await requireApkApplicationId(resolved.exploitApk, EXPLOIT_PACKAGE);
  await adb.requirePhysicalUsbTransport();
  if (!(await isBootstrapped())) {
    throw new Error(
      `${INSTALLER_PACKAGE} is not installed; orphan replacement recovery is inapplicable`
    );
  }

  const orphan = parseOrphanBootstrapSessionPair(
    await adb.dumpPackageInstallerSessions()
  );
  const oldBaseApkPath = await adb.getPackageBaseApkPath(INSTALLER_PACKAGE, USER_SYSTEM);
  const oldCodePath = requireInjectorCodePath(path.posix.dirname(oldBaseApkPath));
  if (oldCodePath === orphan.targetCodePath) {
    throw new Error("Orphan target is already the active injector code path");
  }
  const activeUid = await adb.getPackageUidForUser(INSTALLER_PACKAGE, USER_SYSTEM);
  if (activeUid !== 1000) {
    throw new Error(`Active injector has UID ${activeUid}; expected system UID 1000`);
  }
  const oldDigest = await adb.sha256RemoteBaseApk(oldBaseApkPath);
  const expectedDigest = await sha256LocalFile(resolved.installerApk);
  const expectedExploitDigest = await sha256LocalFile(resolved.exploitApk);
  if (oldDigest === expectedDigest) {
    throw new Error("Recovery candidate is already the active injector artifact");
  }
  if (await adb.injectorCodePathExists(orphan.targetCodePath)) {
    throw new Error(
      `Orphan target ${orphan.targetCodePath} already exists. ` +
        "Refusing to guess whether Stage 2 partially ran."
    );
  }

  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "system-injector-recovery-"));
  const backupApk = path.join(backupDir, "previous-base.apk");
  await adb.pull(oldBaseApkPath, backupApk);
  if ((await sha256LocalFile(backupApk)) !== oldDigest) {
    throw new Error(`Host recovery backup digest mismatch; backup retained at ${backupApk}`);
  }
  await requireApkApplicationId(backupApk, INSTALLER_PACKAGE);

  const transactionId = newTransactionId();
  const deviceApkPath = `${DEVICE_TMP_DIR}/installer-${transactionId}.apk`;
  const recovery: RecoveryStage2Spec = {
    mode: "replace",
    transactionId,
    targetAppDir: orphan.targetAppDir,
    apkPath: deviceApkPath,
    expectedCurrentCodePath: oldCodePath,
    replacementCodePath: orphan.targetCodePath,
    systemSessionId: orphan.systemSessionId,
    targetSessionId: orphan.targetSessionId,
    orphanInstallerUid: orphan.installerUid,
    orphanCreatedMillis: orphan.createdMillis,
    expectedCurrentSha256: oldDigest,
    replacementSha256: expectedDigest,
  };
  const recoveryExtras = buildRecoveryStage2Extras(recovery);
  let helperMayBeInstalled = false;
  let remoteMayExist = false;
  let replacementSettingsMayBeDirty = false;

  try {
    console.log(
      `[1/4] Reusing orphan sessions ${orphan.systemSessionId}/${orphan.targetSessionId} ` +
        `(owner UID ${orphan.installerUid})...`
    );
    helperMayBeInstalled = true;
    await prepareRecoveryExploit(
      resolved.exploitApk,
      orphan.installerUid,
      expectedExploitDigest
    );

    // Installing the helper can cause PackageInstaller to serialize its session table.
    // Re-read and require the exact same pair before staging or opening either capability.
    const afterInstall = parseOrphanBootstrapSessionPair(
      await adb.dumpPackageInstallerSessions()
    );
    if (
      afterInstall.systemSessionId !== orphan.systemSessionId ||
      afterInstall.targetSessionId !== orphan.targetSessionId ||
      afterInstall.installerUid !== orphan.installerUid ||
      afterInstall.createdMillis !== orphan.createdMillis ||
      afterInstall.targetCodePath !== orphan.targetCodePath
    ) {
      throw new Error("Orphan PackageInstaller pair changed while preparing recovery");
    }
    if (await adb.injectorCodePathExists(orphan.targetCodePath)) {
      throw new Error("Orphan target appeared while installing the recovery helper");
    }

    console.log("[2/4] Staging the verified candidate for the fresh recovery transaction...");
    remoteMayExist = true;
    await adb.push(resolved.installerApk, deviceApkPath);
    const stagedDigest = await adb.sha256RemoteStagedApk(deviceApkPath);
    if (stagedDigest !== expectedDigest) {
      throw new Error(
        `Remote staged candidate digest ${stagedDigest} does not match local artifact ` +
          expectedDigest
      );
    }

    console.log("[3/4] Running recovery-only Stage 2 (one verified restart)...");
    replacementSettingsMayBeDirty = true;
    await runExploitStage(
      EXPLOIT_RECOVER_STAGE2_ACTION,
      transactionId,
      "stage2_committed",
      recoveryExtras
    );

    console.log("[4/4] Verifying the active recovery path, system UID, and APK digest...");
    await verifyInstalledArtifact(`${orphan.targetCodePath}/base.apk`, expectedDigest);
  } catch (recoveryError) {
    const restorationFailures: string[] = [];
    let previousVerified = false;
    if (replacementSettingsMayBeDirty) {
      try {
        const rollbackTransactionId = newTransactionId();
        const rollback: RecoveryRollbackSpec = {
          transactionId: rollbackTransactionId,
          systemSessionId: orphan.systemSessionId,
          orphanInstallerUid: orphan.installerUid,
          orphanCreatedMillis: orphan.createdMillis,
          priorCodePath: oldCodePath,
          possibleReplacementCodePath: orphan.targetCodePath,
          expectedPriorSha256: oldDigest,
        };
        console.error(
          "Recovery Stage 2 failed or became ambiguous; switching package settings back " +
            "to the still-intact verified injector path with the same system session..."
        );
        await runExploitStage(
          EXPLOIT_RECOVER_ROLLBACK_ACTION,
          rollbackTransactionId,
          "rollback_committed",
          buildRecoveryRollbackExtras(rollback)
        );
        await verifyInstalledArtifact(oldBaseApkPath, oldDigest);
        previousVerified = true;
      } catch (rollbackError) {
        restorationFailures.push(
          `recovery rollback: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`
        );
      }
    } else {
      try {
        await verifyInstalledArtifact(oldBaseApkPath, oldDigest);
        previousVerified = true;
      } catch (verificationError) {
        restorationFailures.push(
          `previous injector verification: ${
            verificationError instanceof Error
              ? verificationError.message
              : String(verificationError)
          }`
        );
      }
    }

    // Preserve every recovery capability when restoration is unproven. Uninstalling the
    // helper would release the exact UID that owns the only safe rollback session.
    if (previousVerified && restorationFailures.length === 0) {
      if (remoteMayExist) {
        try { await adb.removeRemoteFile(deviceApkPath); } catch (cleanupError) {
          restorationFailures.push(`remote cleanup: ${String(cleanupError)}`);
        }
      }
      if (helperMayBeInstalled) {
        try { await cleanupExploit(); } catch (cleanupError) {
          restorationFailures.push(`helper cleanup: ${String(cleanupError)}`);
        }
      }
    }
    if (previousVerified && restorationFailures.length === 0) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }

    const originalMessage =
      recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
    if (restorationFailures.length > 0) {
      const restorationStatus = previousVerified
        ? "The previous injector is active and verified, but recovery cleanup did not complete"
        : "Safe recovery rollback is not proven";
      throw new Error(
        `${originalMessage} ${restorationStatus}: ` +
          `${restorationFailures.join("; ")}. Helper/staged artifact were retained when ` +
          `possible; host backup retained at ${backupApk}`,
        { cause: recoveryError }
      );
    }
    throw new Error(`${originalMessage} The previous injector remains active and verified.`, {
      cause: recoveryError,
    });
  }

  const finalizationFailures: string[] = [];
  try {
    const finalizeOutput = await adb.contentCall(
      STAGING_URI,
      "finalize_bootstrap_replacement",
      `${oldCodePath},${oldDigest}`
    );
    if (parseProviderInstallResponse(finalizeOutput).kind !== "ok") {
      throw new Error(`Injector refused recovery finalization: ${finalizeOutput}`);
    }
  } catch (finalizationError) {
    finalizationFailures.push(
      finalizationError instanceof Error ? finalizationError.message : String(finalizationError)
    );
  }
  try { await adb.removeRemoteFile(deviceApkPath); } catch (cleanupError) {
    finalizationFailures.push(`remote cleanup: ${String(cleanupError)}`);
  }
  try { await cleanupExploit(); } catch (cleanupError) {
    finalizationFailures.push(`helper cleanup: ${String(cleanupError)}`);
  }
  if (finalizationFailures.length > 0) {
    throw new Error(
      `The recovered replacement is active, UID- and digest-verified, but finalization failed: ` +
        `${finalizationFailures.join("; ")}. Host backup retained at ${backupApk}`
    );
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
  console.log("Recovery-only Stage 2 completed and verified without creating another session pair.");
}

/**
 * Install an APK as a system UID app.
 *
 * Requires the installer to be bootstrapped first (via `bootstrap`).
 * Stages the APK into system_server's cache via a ContentProvider
 * and triggers the install.
 */
function uniqueStagingName(index: number, apkPath: string): string {
  const parsed = path.parse(path.basename(apkPath));
  const safeBase = parsed.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeExt = (parsed.ext || ".apk").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 16);
  const prefix = `${Date.now()}-${index}-`;
  const maxBaseLength = 128 - prefix.length - safeExt.length;
  return `${prefix}${safeBase.slice(0, maxBaseLength)}${safeExt}`;
}

async function ensureBootstrapped(): Promise<void> {
  if (!(await isBootstrapped())) {
    throw new Error(
      `Installer not bootstrapped. Run 'system-injector bootstrap' first.\n` +
      `Auto-bootstrap from 'install' is disabled for safety — the exploit ` +
      `chain should only be triggered intentionally.`
    );
  }
}

export async function installApks(apkPaths: string[]): Promise<void> {
  if (apkPaths.length === 0) {
    throw new Error("No APK paths provided");
  }

  const resolvedApks = apkPaths.map((apkPath) => path.resolve(apkPath));
  for (const resolvedApk of resolvedApks) {
    if (!fs.existsSync(resolvedApk)) {
      throw new Error(`APK not found: ${resolvedApk}`);
    }
  }

  await ensureBootstrapped();

  const stagedNames = resolvedApks.map((resolvedApk, index) => uniqueStagingName(index, resolvedApk));

  console.log(`[1/3] Staging ${resolvedApks.length} APK(s) into system_server cache...`);
  for (let i = 0; i < resolvedApks.length; i++) {
    console.log(`       ${path.basename(resolvedApks[i]!)} -> ${stagedNames[i]}`);
    await adb.contentWrite(resolvedApks[i]!, `${STAGING_URI}/${stagedNames[i]}`);
  }

  const batchArg = stagedNames.join(",");
  let installAttemptSystemServerPid: string | null = null;

  console.log("[2/3] Triggering system install...");
  console.log("       (device will crash once — this is expected)");
  const installResult = await installWithSafeUpdates(
    {
      callProvider: async (transactionToken) => {
        installAttemptSystemServerPid = await adb.getSystemServerPid();
        return transactionToken === undefined
          ? adb.contentCall(STAGING_URI, "install", batchArg)
          : adb.contentCall(STAGING_URI, "retry_install", transactionToken);
      },
      cancelProviderTransaction: async (transactionToken) => {
        const cancellationOutput = await adb.contentCall(
          STAGING_URI,
          "cancel_install",
          transactionToken
        );
        if (parseProviderInstallResponse(cancellationOutput).kind !== "ok") {
          throw new Error(`Injector refused transaction cancellation: ${cancellationOutput}`);
        }
      },
      uninstallKeepData: (packageName) => adb.uninstallKeepDataForUser(packageName, 0),
      restoreAfterFailedUpdate: (packageName) => adb.ensureInstalledForUser(packageName, 0),
      validateBeforeUninstalls: (packageNames) =>
        adb.validateExclusiveUserInstall(packageNames, 0),
      onDuplicatesDetected: (packageNames) => {
        console.log(
          `       ${packageNames.length} package(s) already installed; ` +
          `updating while retaining user 0 app data...`
        );
      },
      onBeforeUninstall: (packageName) => {
        console.log(`       Keep-data uninstalling ${packageName} for user 0...`);
      },
      onBeforeRetry: () => {
        console.log("       Retrying system install...");
      },
    },
    INSTALLER_PACKAGE
  );

  if (installAttemptSystemServerPid === null) {
    throw new Error("System install completed without recording the system_server PID");
  }

  try {
    console.log("[3/3] Waiting for system_server to restart...");
    await adb.waitForSystemServerRestart(
      installAttemptSystemServerPid,
      SYSTEM_RESTART_TIMEOUT_MS,
      SYSTEM_READY_POLL_MS
    );
    await adb.waitForSystemReady(
      SYSTEM_READY_TIMEOUT_MS,
      SYSTEM_READY_POLL_MS,
      SYSTEM_READY_SETTLE_MS
    );

    for (const packageName of installResult.installedPackages) {
      console.log(`       Verifying ${packageName} is installed for user 0...`);
      await adb.ensureInstalledForUser(packageName, 0);
    }
    if (installResult.installedPackages.length > 0) {
      const activationOutput = await adb.contentCall(
        STAGING_URI,
        "activate_updates",
        installResult.installedPackages.join(",")
      );
      if (parseProviderInstallResponse(activationOutput).kind !== "ok") {
        throw new Error(`Failed to activate updated package runtime policy: ${activationOutput}`);
      }
    }
  } catch (error) {
    const restorationFailures: string[] = [];
    for (const packageName of [...installResult.updatedPackages].reverse()) {
      try {
        await adb.ensureInstalledForUser(packageName, 0);
      } catch (restoreError) {
        restorationFailures.push(
          `${packageName}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if (restorationFailures.length > 0) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${originalMessage} User-0 restoration also failed: ${restorationFailures.join("; ")}`,
        { cause: error }
      );
    }
    throw error;
  }

  console.log("Install complete! Apps are now running as system UID (1000).");
}

/**
 * Print status of the system injector.
 */
export async function status(): Promise<void> {
  const installerPresent = await adb.isInstalled(INSTALLER_PACKAGE);
  const exploitPresent = await adb.isInstalled(EXPLOIT_PACKAGE);

  console.log(`Installer (${INSTALLER_PACKAGE}): ${installerPresent ? "INSTALLED" : "not installed"}`);
  console.log(`Exploit   (${EXPLOIT_PACKAGE}): ${exploitPresent ? "INSTALLED (should be cleaned up)" : "not installed"}`);

  if (installerPresent) {
    console.log("\nReady to install APKs as system UID.");
    console.log("Usage: system-injector install <apk-path> [apk-path ...]");
  } else {
    console.log("\nInstaller not bootstrapped.");
    console.log("Usage: system-injector bootstrap");
  }
}
