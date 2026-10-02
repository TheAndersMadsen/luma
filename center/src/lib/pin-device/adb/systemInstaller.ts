import {
  AdbDeviceStepTimeoutError,
  DEVICE_STEP_TIMEOUT_MS,
  withDeviceStepTimeout,
  type AdbSessionTransport,
  type ShellResult,
} from "./transport";
import {
  MANAGED_PACKAGES,
  hasExactPackageLine,
  packageExists,
} from "./packageManager";
import {
  extractExactProviderMessage,
  installWithSafeProviderUpdates,
  parseProviderInstallResponse,
} from "./installProtocol";
import { shellCommand, shellSingleQuote } from "./shellQuote";

export const DEVICE_TMP_DIR = "/data/local/tmp";
export const STAGING_AUTHORITY = "com.penumbraos.systeminjector.staging";
export const STAGING_URI = `content://${STAGING_AUTHORITY}`;
export const SERVER_MAINTENANCE_URI =
  "content://com.penumbraos.server.maintenance";
export const BOOTSTRAP_STAGE1_ACTION =
  "com.penumbraos.systeminjector.exploit.STAGE1";
export const BOOTSTRAP_STAGE2_ACTION =
  "com.penumbraos.systeminjector.exploit.STAGE2";
export const BOOTSTRAP_RECEIVER =
  "com.penumbraos.systeminjector.exploit/.InstallReceiver";
export const HOOK_RUNTIME_POLICY_REPAIR_ACTION =
  "com.penumbraos.hook.REPAIR_SERVER_RUNTIME_POLICY";
export const HOOK_RUNTIME_POLICY_REPAIR_RECEIVER =
  "com.penumbraos.hook.injector/.ServerRuntimePolicyRepairReceiver";
export const HOOK_COMPATIBILITY_REFRESH_ACTION =
  "com.penumbraos.hook.INJECT_CONFIGURED_TARGETS";
export const HOOK_COMPATIBILITY_REFRESH_RECEIVER =
  "com.penumbraos.hook.injector/.CompatibilityRefreshReceiver";
export const BOOTSTRAP_STATUS_URI =
  "content://com.penumbraos.systeminjector.exploit.status";
export const POLL_INTERVAL_MS = 3_000;
export const POLL_TIMEOUT_MS = DEVICE_STEP_TIMEOUT_MS;
export const SYSTEM_READY_TIMEOUT_MS = DEVICE_STEP_TIMEOUT_MS;
export const SYSTEM_READY_POLL_MS = 2_000;
export const SYSTEM_READY_SETTLE_MS = 3_000;
export const SOFT_REBOOT_STABILIZATION_MS = 20_000;
export const AFTER_INSTALL_TIMEOUT_MS = 180_000;
export const UNINSTALL_VERIFICATION_TIMEOUT_MS = 10_000;
export const UNINSTALL_VERIFICATION_INTERVAL_MS = 250;
export const BOOTSTRAP_STATUS_TIMEOUT_MS = 30_000;
export const BOOTSTRAP_STATUS_POLL_MS = 500;
export const SYSTEM_RESTART_TIMEOUT_MS = 120_000;

const FRESH_INSTALLER_APP_DIR = "com.penumbraos.systeminjector-injected";
const BOOTSTRAP_TRANSACTION_ID_RE = /^[a-f0-9]{32}$/;

type BootstrapPhase =
  | "stage1_started"
  | "stage1_ready"
  | "stage2_started"
  | "stage2_committed"
  | "rollback_committed"
  | "failed";

interface BootstrapStatus {
  readonly transactionId: string;
  readonly phase: BootstrapPhase;
  readonly detail: string;
}

export interface FreshBootstrapTransaction {
  readonly transactionId: string;
  readonly deviceApkPath: string;
  readonly extras: Readonly<Record<string, string>>;
}

export interface BootstrapStatusPollOperations {
  readStatus(transactionId: string): Promise<BootstrapStatus | null>;
  delay(milliseconds: number): Promise<void>;
  now(): number;
}

export interface BootstrapStageOperations {
  getSystemServerPid(): Promise<string>;
  sendStageBroadcast(extras: Readonly<Record<string, string>>): Promise<void>;
  waitForStatus(
    transactionId: string,
    expectedPhase: BootstrapPhase,
    timeoutMs: number,
  ): Promise<void>;
  waitForSystemServerRestart(previousPid: string): Promise<void>;
  waitForSystemReady(): Promise<void>;
}

export interface UpdatedPackageActivationOperations {
  activateUpdates(): Promise<void>;
  repairHookRuntimePolicy(): Promise<void>;
  refreshConfiguredTargets(): Promise<void>;
  startServerService(): Promise<void>;
}

export async function runUpdatedPackageActivation(
  operations: UpdatedPackageActivationOperations,
): Promise<void> {
  await operations.activateUpdates();
  await operations.repairHookRuntimePolicy();
  await operations.refreshConfiguredTargets();
  await operations.startServerService();
}

function newBootstrapTransactionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Build the complete, transaction-bound payload shared by both fresh bootstrap stages. */
export function buildFreshBootstrapTransaction(
  transactionId = newBootstrapTransactionId(),
): FreshBootstrapTransaction {
  if (!BOOTSTRAP_TRANSACTION_ID_RE.test(transactionId)) {
    throw new Error(`Invalid bootstrap transaction ID: ${transactionId}`);
  }
  const deviceApkPath = `${DEVICE_TMP_DIR}/installer-${transactionId}.apk`;
  return Object.freeze({
    transactionId,
    deviceApkPath,
    extras: Object.freeze({
      transaction_id: transactionId,
      mode: "fresh",
      target_app_dir: FRESH_INSTALLER_APP_DIR,
      apk_path: deviceApkPath,
    }),
  });
}

/** Build the explicit receiver command from the complete fresh-bootstrap contract. */
export function buildFreshBootstrapBroadcastCommand(
  action: typeof BOOTSTRAP_STAGE1_ACTION | typeof BOOTSTRAP_STAGE2_ACTION,
  extras: Readonly<Record<string, string>>,
): readonly string[] {
  const transactionId = extras.transaction_id;
  const expectedKeys = [
    "transaction_id",
    "mode",
    "target_app_dir",
    "apk_path",
  ] as const;
  if (
    (action !== BOOTSTRAP_STAGE1_ACTION && action !== BOOTSTRAP_STAGE2_ACTION) ||
    !transactionId ||
    !BOOTSTRAP_TRANSACTION_ID_RE.test(transactionId) ||
    Object.keys(extras).length !== expectedKeys.length ||
    expectedKeys.some((key) => typeof extras[key] !== "string") ||
    extras.mode !== "fresh" ||
    extras.target_app_dir !== FRESH_INSTALLER_APP_DIR ||
    extras.apk_path !== `${DEVICE_TMP_DIR}/installer-${transactionId}.apk`
  ) {
    throw new Error("Invalid fresh bootstrap broadcast extras");
  }
  return shellCommand([
    "am",
    "broadcast",
    "-a",
    action,
    "-n",
    BOOTSTRAP_RECEIVER,
    ...expectedKeys.flatMap((key) => ["--es", key, extras[key]!]),
  ]);
}

export function buildHookRuntimePolicyRepairBroadcastCommand(): readonly string[] {
  return shellCommand([
    "am",
    "broadcast",
    "-a",
    HOOK_RUNTIME_POLICY_REPAIR_ACTION,
    "-n",
    HOOK_RUNTIME_POLICY_REPAIR_RECEIVER,
  ]);
}

export function buildHookCompatibilityRefreshBroadcastCommand(): readonly string[] {
  return shellCommand([
    "am",
    "broadcast",
    "-a",
    HOOK_COMPATIBILITY_REFRESH_ACTION,
    "-n",
    HOOK_COMPATIBILITY_REFRESH_RECEIVER,
  ]);
}

function decodeBootstrapStatusDetail(encoded: string): string {
  if (!encoded) return "";
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("Invalid bootstrap status detail encoding");
  }
  const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const bytes = Uint8Array.from(globalThis.atob(padded), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Parse only the durable status format emitted by BootstrapStatusProvider. */
export function parseBootstrapStatusMessage(
  message: string,
): BootstrapStatus | null {
  if (message === "NO_STATUS") return null;
  const match = message.match(
    /^BOOTSTRAP_STATUS:([a-f0-9]{32}):(stage1_started|stage1_ready|stage2_started|stage2_committed|rollback_committed|failed):([A-Za-z0-9_-]*)$/u,
  );
  if (!match) {
    throw new Error(`Invalid bootstrap status message: ${message}`);
  }
  return {
    transactionId: match[1]!,
    phase: match[2]! as BootstrapPhase,
    detail: decodeBootstrapStatusDetail(match[3] ?? ""),
  };
}

/** Poll provider startup failures, but fail immediately on a durable setup error. */
export async function waitForExpectedBootstrapStatus(
  operations: BootstrapStatusPollOperations,
  transactionId: string,
  expectedPhase: BootstrapPhase,
  timeoutMs: number,
  pollMs = BOOTSTRAP_STATUS_POLL_MS,
): Promise<void> {
  if (!BOOTSTRAP_TRANSACTION_ID_RE.test(transactionId)) {
    throw new Error(`Invalid bootstrap transaction ID: ${transactionId}`);
  }
  const start = operations.now();
  let lastError: unknown;
  while (operations.now() - start < timeoutMs) {
    try {
      const status = await operations.readStatus(transactionId);
      if (status?.phase === "failed") {
        throw new Error(
          `Bootstrap transaction failed: ${status.detail || "unknown failure"}`,
        );
      }
      if (status?.phase === expectedPhase) return;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Bootstrap transaction failed:")
      ) {
        throw error;
      }
      lastError = error;
    }
    await operations.delay(pollMs);
  }
  throw new Error(
    `Timed out waiting for bootstrap status ${expectedPhase}: ${
      lastError instanceof Error ? lastError.message : "no durable status"
    }`,
  );
}

/** Require durable completion and a real system_server PID transition for one stage. */
export async function runVerifiedBootstrapStage(
  operations: BootstrapStageOperations,
  transactionId: string,
  expectedPhase: BootstrapPhase,
  extras: Readonly<Record<string, string>>,
  statusTimeoutMs = BOOTSTRAP_STATUS_TIMEOUT_MS,
): Promise<void> {
  if (!BOOTSTRAP_TRANSACTION_ID_RE.test(transactionId)) {
    throw new Error(`Invalid bootstrap transaction ID: ${transactionId}`);
  }
  const previousPid = await operations.getSystemServerPid();
  await operations.sendStageBroadcast(extras);
  await operations.waitForStatus(
    transactionId,
    expectedPhase,
    statusTimeoutMs,
  );
  await operations.waitForSystemServerRestart(previousPid);
  await operations.waitForSystemReady();
  await operations.waitForStatus(
    transactionId,
    expectedPhase,
    statusTimeoutMs,
  );
}

/**
 * The bound for the whole batch-install step, DERIVED from the waits it contains
 * rather than picked.
 *
 * Installing the hook restarts system_server, so the batch legitimately waits for
 * a soft reboot: stabilization, then the device, then the package manager, then
 * each package to reappear for user 0. Wrapping all of that in the plain
 * DEVICE_STEP_TIMEOUT_MS made the outer bound smaller than the inner ones, 60s
 * around a soft-reboot recovery that can take 140s on its own, so the step could
 * not complete even when everything was working.
 *
 * The consequence was worse than a slow install. The Pin finished the install
 * correctly and the command printed `Failed`, telling the operator "the device was
 * already being modified when this failed. Re-run the install", advice to re-run
 * a destructive operation against a device that was already exactly right.
 *
 * Kept as a sum so that raising any inner bound raises this one automatically.
 */
export const BATCH_INSTALL_TIMEOUT_MS =
  SOFT_REBOOT_STABILIZATION_MS + 2 * DEVICE_STEP_TIMEOUT_MS + AFTER_INSTALL_TIMEOUT_MS;

export interface BootstrapInstallerAssets {
  readonly installerApk: Blob;
  readonly bootstrapApk: Blob;
}

export interface SystemInstallerProgressEvent {
  readonly step:
    | "bootstrap-push-helper"
    | "bootstrap-wait-helper"
    | "bootstrap-push-installer"
    | "bootstrap-stage1"
    | "bootstrap-wait-stage1-reboot"
    | "bootstrap-stage2"
    | "bootstrap-wait-stage2-reboot"
    | "bootstrap-wait-installer-package"
    | "bootstrap-wait-provider"
    | "install-wait-installer"
    | "install-wait-provider"
    | "install-push-apk"
    | "install-stage-apk"
    | "install-trigger"
    | "install-wait-package-manager"
    | "install-wait-target-package"
    | "install-wait-next-provider";
  readonly message: string;
}

export interface StageSystemApkInstallOptions {
  readonly packageName?: string;
  readonly waitForNextInstallProviderReady?: boolean;
  readonly softRebootStabilizationDelayMs?: number;
  readonly onProgress?: (event: SystemInstallerProgressEvent) => void;
}

export interface StageSystemApkBatchInstallItem {
  readonly apk: Blob;
  readonly name: string;
  readonly packageName?: string;
}

export interface StageSystemApkBatchInstallOptions {
  /** implemented: exact packages that inspection proved installed for user 0. */
  readonly expectedExistingPackageNames?: readonly string[];
  /** Called immediately before the provider install transaction may mutate state. */
  readonly onMutationStart?: () => void;
  readonly softRebootStabilizationDelayMs?: number;
  readonly onProgress?: (event: SystemInstallerProgressEvent) => void;
}

export interface StageSystemApkInstallResult {
  readonly message: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function hasProviderAccessError(output: string): boolean {
  return (
    output.includes("Error while accessing provider:") ||
    output.includes("Could not find provider:")
  );
}

function ensureShellSuccess(result: ShellResult, fallback: string) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 || hasProviderAccessError(output)) {
    throw new Error(result.stderr || result.stdout || fallback);
  }
}


/**
 * The name an APK must have before it may touch the device.
 *
 * Published release manifests are stricter and bind each role to `role.apk`.
 * This broader rule is only for locally picked files. Quoting at the sinks above
 * makes an exotic name harmless. This rejects it anyway, BEFORE any device I/O,
 * because a name that needs quoting to be safe has no business on a device in
 * the first place, and because `install`'s wire format joins names with commas.
 */
export const APK_STAGING_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.apk$/;

export function isValidApkStagingName(name: string): boolean {
  return APK_STAGING_NAME_RE.test(name);
}

/** Thrown before anything is pushed, so a bad name costs the device nothing. */
export class InvalidApkStagingNameError extends Error {
  readonly fileName: string;

  constructor(fileName: string) {
    super(
      `“${fileName}” is not a usable APK file name. Rename it using letters, numbers, dots, dashes or underscores, ending in .apk, then try again.`,
    );
    this.name = "InvalidApkStagingNameError";
    this.fileName = fileName;
  }
}

function isDeviceStepTimeoutError(
  error: unknown,
): error is AdbDeviceStepTimeoutError {
  return error instanceof AdbDeviceStepTimeoutError;
}

export async function waitForDeviceReady(
  transport: AdbSessionTransport,
  timeoutMs = 30000,
  pollMs = 1000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await transport.shell(["echo", "ready"]);
      if (result.exitCode === 0) {
        return;
      }
    } catch (error) {
      if (isDeviceStepTimeoutError(error)) {
        throw error;
      }
    }
    await sleep(pollMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for device.`);
}

export async function waitForPackageManagerReady(
  transport: AdbSessionTransport,
  timeoutMs = SYSTEM_READY_TIMEOUT_MS,
  pollMs = SYSTEM_READY_POLL_MS,
  settleMs = 0,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = "no response";

  while (Date.now() < deadline) {
    try {
      // Probe the same `cmd package` Binder path used by the mutations below.
      // `service check package` is weaker and its `not found` response used to
      // pass an `includes("found")` check, allowing install to start too early.
      const result = await withDeviceStepTimeout(
        "wait for Android package service",
        () =>
          transport.shell([
            "cmd",
            "package",
            "path",
            "android",
          ]),
        Math.max(1, deadline - Date.now()),
      );
      const output = `${result.stdout}\n${result.stderr}`.trim();
      lastResponse = output || `exit code ${result.exitCode}`;
      if (isPackageManagerProbeReady(result)) {
        if (settleMs > 0) {
          await sleep(settleMs);
        }
        return;
      }
    } catch (error) {
      lastResponse = error instanceof Error ? error.message : String(error);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(pollMs, remainingMs));
    }
  }

  throw new PackageServiceNotReadyError(
    `Timed out after ${timeoutMs}ms waiting for Android's package service. ` +
      `Keep the Pin powered on and unlocked, wait for startup to finish, then retry. ` +
      `Last response: ${lastResponse.slice(0, 240)}`,
  );
}

/** Android's package service was not ready, so no package change was started. */
export class PackageServiceNotReadyError extends Error {
  override name = "PackageServiceNotReadyError";
}

function isPackageManagerProbeReady(result: ShellResult): boolean {
  return (
    result.exitCode === 0 &&
    result.stdout
      .split(/\r?\n/u)
      .some((line) => /^package:\/\S+$/u.test(line.trim()))
  );
}

/**
 * One fail-closed probe used after a potentially long asset download. This is
 * deliberately not a retry loop: the operation already performed its bounded
 * readiness wait before inspecting and planning from fresh state.
 */
export async function assertPackageManagerReady(
  transport: AdbSessionTransport,
  timeoutMs = DEVICE_STEP_TIMEOUT_MS,
): Promise<void> {
  const result = await withDeviceStepTimeout(
    "confirm Android package service",
    () => transport.shell(["cmd", "package", "path", "android"]),
    timeoutMs,
  );
  if (isPackageManagerProbeReady(result)) {
    return;
  }

  const response =
    `${result.stdout}\n${result.stderr}`.trim() || `exit code ${result.exitCode}`;
  throw new PackageServiceNotReadyError(
    `Android's package service became unavailable before install. ` +
      `No package changes were started. Wait for Android to finish starting, then retry. ` +
      `Last response: ${response.slice(0, 240)}`,
  );
}

export async function waitForSoftRebootStabilization(
  delayMs = SOFT_REBOOT_STABILIZATION_MS,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await sleep(delayMs);
}

async function waitForSoftRebootRecovery(
  transport: AdbSessionTransport,
  delayMs = SOFT_REBOOT_STABILIZATION_MS,
): Promise<void> {
  await waitForSoftRebootStabilization(delayMs);
  await waitForDeviceReady(
    transport,
    DEVICE_STEP_TIMEOUT_MS,
    SYSTEM_READY_POLL_MS,
  );
  await waitForPackageManagerReady(
    transport,
    DEVICE_STEP_TIMEOUT_MS,
    SYSTEM_READY_POLL_MS,
    SYSTEM_READY_SETTLE_MS,
  );
}

async function getSystemServerPid(
  transport: AdbSessionTransport,
): Promise<string> {
  const result = await transport.shell(shellCommand(["pidof", "system_server"]));
  ensureShellSuccess(result, "Unable to determine system_server PID.");
  const pid = result.stdout.trim();
  if (!/^\d+$/u.test(pid)) {
    throw new Error(
      `Unable to determine system_server PID: ${pid || "no response"}`,
    );
  }
  return pid;
}

async function waitForSystemServerRestart(
  transport: AdbSessionTransport,
  previousPid: string,
  timeoutMs = SYSTEM_RESTART_TIMEOUT_MS,
  pollMs = SYSTEM_READY_POLL_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const currentPid = await getSystemServerPid(transport);
      if (currentPid !== previousPid) return;
    } catch (error) {
      if (isDeviceStepTimeoutError(error)) throw error;
      // system_server and its shell transport can both disappear briefly.
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for system_server PID ${previousPid} to restart.`,
  );
}

async function readBootstrapStatus(
  transport: AdbSessionTransport,
  transactionId: string,
): Promise<BootstrapStatus | null> {
  const result = await transport.shell(
    shellCommand([
      "content",
      "call",
      "--uri",
      BOOTSTRAP_STATUS_URI,
      "--method",
      "status",
      "--arg",
      transactionId,
    ]),
  );
  ensureShellSuccess(result, "Failed to read bootstrap transaction status.");
  const message = extractExactProviderMessage(result.stdout);
  if (message === null) {
    throw new Error(`Invalid bootstrap status response: ${result.stdout.trim()}`);
  }
  const status = parseBootstrapStatusMessage(message);
  if (status !== null && status.transactionId !== transactionId) {
    throw new Error(
      `Bootstrap status belongs to a different transaction: ${status.transactionId}`,
    );
  }
  return status;
}

async function waitForBootstrapStatus(
  transport: AdbSessionTransport,
  transactionId: string,
  expectedPhase: BootstrapPhase,
  timeoutMs: number,
): Promise<void> {
  await waitForExpectedBootstrapStatus(
    {
      readStatus: (id) => readBootstrapStatus(transport, id),
      delay: sleep,
      now: Date.now,
    },
    transactionId,
    expectedPhase,
    timeoutMs,
  );
}

async function runFreshBootstrapStage(
  transport: AdbSessionTransport,
  action: typeof BOOTSTRAP_STAGE1_ACTION | typeof BOOTSTRAP_STAGE2_ACTION,
  transaction: FreshBootstrapTransaction,
  expectedPhase: BootstrapPhase,
  softRebootStabilizationDelayMs?: number,
): Promise<void> {
  await runVerifiedBootstrapStage(
    {
      getSystemServerPid: () => getSystemServerPid(transport),
      sendStageBroadcast: async (extras) => {
        const result = await transport.shell(
          buildFreshBootstrapBroadcastCommand(action, extras),
        );
        ensureShellSuccess(result, `${expectedPhase} broadcast failed`);
      },
      waitForStatus: (id, phase, timeoutMs) =>
        waitForBootstrapStatus(transport, id, phase, timeoutMs),
      waitForSystemServerRestart: (previousPid) =>
        waitForSystemServerRestart(transport, previousPid),
      waitForSystemReady: () =>
        waitForSoftRebootRecovery(
          transport,
          softRebootStabilizationDelayMs,
        ),
    },
    transaction.transactionId,
    expectedPhase,
    transaction.extras,
  );
}

export async function pollForPackage(
  transport: AdbSessionTransport,
  packageName: string,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      if (await packageExists(transport, packageName)) {
        return true;
      }
    } catch (error) {
      if (isDeviceStepTimeoutError(error)) {
        throw error;
      }
      // Retry until timeout.
    }

    await sleep(intervalMs);
  }

  return false;
}

export async function waitForStagingProviderReady(
  transport: AdbSessionTransport,
  authority = STAGING_AUTHORITY,
  timeoutMs = POLL_TIMEOUT_MS,
  intervalMs = POLL_INTERVAL_MS,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const probeUri = `content://${authority}/provider-ready-probe.apk`;
      const result = await transport.shell(
        shellCommand(["content", "query", "--uri", probeUri]),
      );
      const output = `${result.stdout}\n${result.stderr}`;
      if (!hasProviderAccessError(output)) {
        return;
      }
    } catch (error) {
      if (isDeviceStepTimeoutError(error)) {
        throw error;
      }
      // Retry until timeout.
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${authority} to become ready.`);
}

async function waitForPackagePresence(
  transport: AdbSessionTransport,
  packageName: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<void> {
  const found = await pollForPackage(
    transport,
    packageName,
    POLL_INTERVAL_MS,
    timeoutMs,
  );
  if (!found) {
    throw new Error(`Timed out waiting for ${packageName} to appear.`);
  }
}

async function cleanupDeviceTmpApk(
  transport: AdbSessionTransport,
  deviceTmpPath: string,
): Promise<void> {
  await transport
    .shell(shellCommand(["rm", "-f", deviceTmpPath]))
    .catch(() => undefined);
}

async function runStageDeviceCopy(
  transport: AdbSessionTransport,
  deviceTmpPath: string,
  stagingFileUri: string,
): Promise<ShellResult> {
  // Not `shellCommand`: this one needs a real shell REDIRECTION, so the `<`
  // must stay unquoted while both operands are quoted.
  return transport.shell([
    "sh",
    "-c",
    shellSingleQuote(
      `content write --uri ${shellSingleQuote(stagingFileUri)} < ${shellSingleQuote(deviceTmpPath)}`,
    ),
  ]);
}

export async function isInstallerBootstrapped(
  transport: AdbSessionTransport,
): Promise<boolean> {
  return packageExists(transport, MANAGED_PACKAGES.installer);
}

export async function bootstrapInstaller(
  transport: AdbSessionTransport,
  assets: BootstrapInstallerAssets,
  options?: {
    readonly softRebootStabilizationDelayMs?: number;
    readonly onProgress?: (event: SystemInstallerProgressEvent) => void;
  },
): Promise<void> {
  if (await isInstallerBootstrapped(transport)) {
    options?.onProgress?.({
      step: "bootstrap-wait-provider",
      message: "Waiting for the Device Installer to be ready.",
    });
    await waitForStagingProviderReady(transport);
    return;
  }

  const transaction = buildFreshBootstrapTransaction();
  const deviceApkPath = transaction.deviceApkPath;

  options?.onProgress?.({
    step: "bootstrap-push-helper",
    message: "Preparing the Setup Helper.",
  });
  await transport.pushFile(`${DEVICE_TMP_DIR}/bootstrap-helper.apk`, assets.bootstrapApk);
  const installBootstrapHelperResult = await transport.shell(
    shellCommand(["pm", "install", "-r", `${DEVICE_TMP_DIR}/bootstrap-helper.apk`]),
  );
  ensureShellSuccess(
    installBootstrapHelperResult,
    "Failed to install the Setup Helper.",
  );

  options?.onProgress?.({
    step: "bootstrap-wait-helper",
    message: "Waiting for the Setup Helper to be ready.",
  });
  await waitForPackagePresence(transport, MANAGED_PACKAGES.bootstrapHelper);

  options?.onProgress?.({
    step: "bootstrap-push-installer",
    message: "Preparing the Device Installer.",
  });
  await transport.pushFile(deviceApkPath, assets.installerApk);

  options?.onProgress?.({
    step: "bootstrap-stage1",
    message: "Preparing the Device Installer (step 1 of 2).",
  });
  await runFreshBootstrapStage(
    transport,
    BOOTSTRAP_STAGE1_ACTION,
    transaction,
    "stage1_ready",
    options?.softRebootStabilizationDelayMs,
  );

  options?.onProgress?.({
    step: "bootstrap-wait-stage1-reboot",
    message: "Device Installer step 1 completed; the Pin restarted successfully.",
  });

  options?.onProgress?.({
    step: "bootstrap-stage2",
    message: "Preparing the Device Installer (step 2 of 2).",
  });
  await runFreshBootstrapStage(
    transport,
    BOOTSTRAP_STAGE2_ACTION,
    transaction,
    "stage2_committed",
    options?.softRebootStabilizationDelayMs,
  );

  options?.onProgress?.({
    step: "bootstrap-wait-stage2-reboot",
    message: "Device Installer step 2 completed; the Pin restarted successfully.",
  });

  options?.onProgress?.({
    step: "bootstrap-wait-installer-package",
    message: "Waiting for the Device Installer to be ready.",
  });
  await waitForPackagePresence(transport, MANAGED_PACKAGES.installer);

  options?.onProgress?.({
    step: "bootstrap-wait-provider",
    message: "Confirming that the Device Installer is ready.",
  });
  await waitForStagingProviderReady(transport);

  await transport
    .shell(shellCommand(["pm", "uninstall", MANAGED_PACKAGES.bootstrapHelper]))
    .catch(() => undefined);
  await cleanupDeviceTmpApk(transport, deviceApkPath);
  await cleanupDeviceTmpApk(transport, `${DEVICE_TMP_DIR}/bootstrap-helper.apk`);
}

async function stageApkThroughProvider(
  transport: AdbSessionTransport,
  apk: Blob,
  name: string,
  onProgress?: (event: SystemInstallerProgressEvent) => void,
): Promise<void> {
  const stagingFileUri = `${STAGING_URI}/${name}`;
  const deviceTmpPath = `${DEVICE_TMP_DIR}/${name}`;

  onProgress?.({
    step: "install-push-apk",
    message: `Pushing ${name} to the device.`,
  });
  await transport.pushFile(deviceTmpPath, apk);

  try {
    onProgress?.({
      step: "install-stage-apk",
      message: `Preparing ${name} with the Device Installer.`,
    });
    const stageResult = await runStageDeviceCopy(
      transport,
      deviceTmpPath,
      stagingFileUri,
    );
    ensureShellSuccess(stageResult, `Failed to stage ${name}`);
  } finally {
    await cleanupDeviceTmpApk(transport, deviceTmpPath);
  }
}

async function callStagingProvider(
  transport: AdbSessionTransport,
  method: "install" | "retry_install" | "cancel_install" | "activate_updates",
  arg: string,
  fallback: string,
  onProgress?: (event: SystemInstallerProgressEvent) => void,
): Promise<string> {
  const result = await transport.shell(
    shellCommand([
      "content",
      "call",
      "--uri",
      STAGING_URI,
      "--method",
      method,
      "--arg",
      arg,
    ]),
  );
  ensureShellSuccess(result, fallback);
  onProgress?.({
    step: "install-trigger",
    message: `Device Installer ${method} response received.`,
  });
  return result.stdout.trim();
}

export function parseAndroidUserIds(output: string): number[] {
  const ids = [...output.matchAll(/UserInfo\{(\d+):/g)].map((match) =>
    Number(match[1]),
  );
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id))) {
    throw new Error("Could not parse Android users for safe package update.");
  }
  return [...new Set(ids)];
}

async function listAndroidUserIds(
  transport: AdbSessionTransport,
): Promise<readonly number[]> {
  const result = await transport.shell(["pm", "list", "users"]);
  ensureShellSuccess(result, "Could not list Android users.");
  return parseAndroidUserIds(result.stdout);
}

async function packageExistsForUser(
  transport: AdbSessionTransport,
  packageName: string,
  userId: number,
): Promise<boolean> {
  const result = await transport.shell(
    shellCommand(["pm", "list", "packages", "--user", String(userId), packageName]),
  );
  ensureShellSuccess(result, `Could not inspect ${packageName} for user ${userId}.`);
  return hasExactPackageLine(result.stdout, packageName);
}

async function validateExclusiveUserZeroInstall(
  transport: AdbSessionTransport,
  packageNames: readonly string[],
): Promise<void> {
  const userIds = await listAndroidUserIds(transport);
  if (!userIds.includes(0)) {
    throw new Error("Android user 0 is unavailable.");
  }
  for (const packageName of packageNames) {
    for (const userId of userIds) {
      const installed = await packageExistsForUser(
        transport,
        packageName,
        userId,
      );
      if ((userId === 0 && !installed) || (userId !== 0 && installed)) {
        throw new Error(
          `Refusing keep-data update: ${packageName} is not installed exclusively for user 0.`,
        );
      }
    }
  }
}

async function validateExpectedPackageState(
  transport: AdbSessionTransport,
  packageNames: readonly string[],
  expectedExistingPackageNames: readonly string[],
): Promise<void> {
  const expected = new Set(expectedExistingPackageNames);
  if (
    expected.size !== expectedExistingPackageNames.length ||
    expectedExistingPackageNames.some((name) => !packageNames.includes(name))
  ) {
    throw new Error("Inspected package preflight contains an unexpected package.");
  }
  const userIds = await listAndroidUserIds(transport);
  if (!userIds.includes(0)) {
    throw new Error("Android user 0 is unavailable.");
  }
  for (const packageName of packageNames) {
    for (const userId of userIds) {
      const installed = await packageExistsForUser(
        transport,
        packageName,
        userId,
      );
      const shouldBeInstalled = expected.has(packageName) && userId === 0;
      if (installed !== shouldBeInstalled) {
        throw new Error(
          `Package state changed after inspection for ${packageName}; no install was triggered.`,
        );
      }
    }
  }
}

async function uninstallKeepDataForUserZero(
  transport: AdbSessionTransport,
  packageName: string,
): Promise<void> {
  const result = await transport.shell(
    shellCommand(["pm", "uninstall", "-k", "--user", "0", packageName]),
  );
  ensureShellSuccess(result, `Keep-data uninstall failed for ${packageName}.`);
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    !lines.includes("Success") ||
    lines.some((line) => line.startsWith("Failure"))
  ) {
    throw new Error(`Keep-data uninstall was not verified for ${packageName}.`);
  }
  await waitForPackageUnloadedForUserZero(transport, packageName);
}

export async function packageHasLoadedPathForUser(
  transport: AdbSessionTransport,
  packageName: string,
  userId: number,
): Promise<boolean> {
  const result = await transport.shell(
    shellCommand(["pm", "path", "--user", String(userId), packageName]),
  );
  if (
    result.exitCode === 1 &&
    result.stdout.trim().length === 0 &&
    result.stderr.trim().length === 0
  ) {
    return false;
  }
  ensureShellSuccess(result, `Could not inspect the loaded APK for ${packageName}.`);
  if (result.stderr.trim().length > 0) {
    throw new Error(`Unexpected package path error for ${packageName}.`);
  }
  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const controlledBaseApk = new RegExp(
    `^package:/data/app/(?:~~[A-Za-z0-9_-]+=*/)?${escapedPackageName}-(?:injected|[A-Za-z0-9_-]+=*)/base\\.apk$`,
    "u",
  );
  if (lines.length === 1 && controlledBaseApk.test(lines[0]!)) return true;
  throw new Error(`Unexpected package path response for ${packageName}.`);
}

export async function waitForPackageUnloadedForUserZero(
  transport: AdbSessionTransport,
  packageName: string,
  timeoutMs = UNINSTALL_VERIFICATION_TIMEOUT_MS,
  intervalMs = UNINSTALL_VERIFICATION_INTERVAL_MS,
): Promise<void> {
  const start = Date.now();
  let lastResponse = "the APK remained loaded";
  while (Date.now() - start < timeoutMs) {
    try {
      if (!(await packageHasLoadedPathForUser(transport, packageName, 0))) {
        return;
      }
      lastResponse = "the APK remained loaded";
    } catch (error) {
      if (isDeviceStepTimeoutError(error)) throw error;
      lastResponse = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms verifying keep-data uninstall for ${packageName}. ` +
      `Last response: ${lastResponse.slice(0, 240)}`,
  );
}

export async function waitForPackageForUserZero(
  transport: AdbSessionTransport,
  packageName: string,
  timeoutMs = AFTER_INSTALL_TIMEOUT_MS,
  intervalMs = POLL_INTERVAL_MS,
): Promise<void> {
  const start = Date.now();
  let lastResponse = "package not present";
  while (Date.now() - start < timeoutMs) {
    try {
      if (await packageExistsForUser(transport, packageName, 0)) {
        return;
      }
      lastResponse = "package not present for user 0";
    } catch (error) {
      if (isDeviceStepTimeoutError(error)) throw error;
      lastResponse = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${packageName} for user 0. ` +
      `Last response: ${lastResponse.slice(0, 240)}`,
  );
}

async function restorePackageForUserZero(
  transport: AdbSessionTransport,
  packageName: string,
): Promise<void> {
  if (await packageExistsForUser(transport, packageName, 0)) {
    return;
  }
  const result = await transport.shell(
    shellCommand(["cmd", "package", "install-existing", "--user", "0", packageName]),
  );
  ensureShellSuccess(result, `Could not restore ${packageName} for user 0.`);
  await waitForPackageForUserZero(transport, packageName);
}

async function requireProviderOk(
  output: string,
  operation: string,
): Promise<void> {
  if (parseProviderInstallResponse(output).kind !== "ok") {
    throw new Error(`Device Installer refused ${operation}.`);
  }
}

async function requireSafeProviderCapabilities(
  transport: AdbSessionTransport,
  onProgress?: (event: SystemInstallerProgressEvent) => void,
): Promise<void> {
  // observed: cancellation is idempotent, and an invalid activation package is
  // rejected before policy state is touched. Together these are a no-op probe.
  const probeToken = "0".repeat(32);
  await requireProviderOk(
    await callStagingProvider(
      transport,
      "cancel_install",
      probeToken,
      "Could not probe safe installer transaction support.",
      onProgress,
    ),
    "safe transaction capability probe",
  );

  const activationProbe = await callStagingProvider(
    transport,
    "activate_updates",
    "invalid",
    "Could not probe update activation support.",
    onProgress,
  );
  if (
    extractExactProviderMessage(activationProbe) !==
    "Invalid activation package: invalid"
  ) {
    throw new Error(
      "Installed Device Installer does not prove safe update activation support.",
    );
  }
}

async function repairHookRuntimePolicy(
  transport: AdbSessionTransport,
): Promise<void> {
  const result = await transport.shell(
    buildHookRuntimePolicyRepairBroadcastCommand(),
  );
  ensureShellSuccess(result, "Failed to wake the Compatibility Loader after update.");
}

async function refreshConfiguredTargets(
  transport: AdbSessionTransport,
): Promise<void> {
  const result = await transport.shell(
    buildHookCompatibilityRefreshBroadcastCommand(),
  );
  ensureShellSuccess(result, "Failed to refresh configured compatibility targets after update.");
}

async function startServerService(
  transport: AdbSessionTransport,
): Promise<void> {
  const result = await transport.shell(
    shellCommand([
      "content",
      "call",
      "--uri",
      SERVER_MAINTENANCE_URI,
      "--method",
      "START",
    ]),
  );
  ensureShellSuccess(result, "Failed to start the Pin server after update.");
}

export async function stageSystemApkBatchInstall(
  transport: AdbSessionTransport,
  apks: readonly StageSystemApkBatchInstallItem[],
  options: StageSystemApkBatchInstallOptions = {},
): Promise<StageSystemApkInstallResult> {
  if (apks.length === 0) {
    throw new Error("No APKs supplied for system install.");
  }

  // Before ANY device I/O. The name reaches a device path, a content:// URI and
  // the provider's comma-separated `install` argument, so a rejected name must
  // cost the Pin nothing, and rejecting beats silently rewriting, because the
  // wearer has to be told which file to rename.
  for (const item of apks) {
    if (!isValidApkStagingName(item.name)) {
      throw new InvalidApkStagingNameError(item.name);
    }
  }

  options.onProgress?.({
    step: "install-wait-installer",
    message: `Waiting for the Device Installer before preparing ${apks.length} app${apks.length === 1 ? "" : "s"}.`,
  });
  await waitForPackagePresence(transport, MANAGED_PACKAGES.installer);

  options.onProgress?.({
    step: "install-wait-provider",
    message: `Confirming the Device Installer is ready for ${apks.length} app${apks.length === 1 ? "" : "s"}.`,
  });
  await waitForStagingProviderReady(transport);
  await requireSafeProviderCapabilities(transport, options.onProgress);

  const packageNames = apks.every((item) => item.packageName)
    ? apks.map((item) => item.packageName!)
    : undefined;
  if (packageNames?.includes(MANAGED_PACKAGES.installer)) {
    throw new Error(
      "Installer self-update requires the explicit bootstrap recovery path.",
    );
  }

  for (const item of apks) {
    await stageApkThroughProvider(
      transport,
      item.apk,
      item.name,
      options.onProgress,
    );
  }

  const installArg = apks.map((item) => item.name).join(",");
  if (packageNames && options.expectedExistingPackageNames) {
    await validateExpectedPackageState(
      transport,
      packageNames,
      options.expectedExistingPackageNames,
    );
  }
  options.onProgress?.({
    step: "install-trigger",
    message: `Installing ${apks.length} Luma app${apks.length === 1 ? "" : "s"}.`,
  });
  options.onMutationStart?.();
  const installResult = await installWithSafeProviderUpdates(
    {
      callInstall: () =>
        callStagingProvider(
          transport,
          "install",
          installArg,
          "Failed to trigger staged install.",
          options.onProgress,
        ),
      retryInstall: (transactionToken) =>
        callStagingProvider(
          transport,
          "retry_install",
          transactionToken,
          "Failed to retry staged install.",
          options.onProgress,
        ),
      async cancelInstall(transactionToken) {
        await requireProviderOk(
          await callStagingProvider(
            transport,
            "cancel_install",
            transactionToken,
            "Failed to cancel staged install transaction.",
            options.onProgress,
          ),
          "transaction cancellation",
        );
      },
      validateBeforeUninstall: (duplicates) =>
        validateExclusiveUserZeroInstall(transport, duplicates),
      uninstallKeepData: (packageName) =>
        uninstallKeepDataForUserZero(transport, packageName),
      restoreForUser: (packageName) =>
        restorePackageForUserZero(transport, packageName),
    },
    {
      protectedPackageName: MANAGED_PACKAGES.installer,
      expectedPackageNames: packageNames,
      expectedInstalledPackageNames: options.expectedExistingPackageNames,
      expectedPackageCount: apks.length,
    },
  );

  try {
    options.onProgress?.({
      step: "install-wait-package-manager",
      message: "Waiting for Android to finish restarting after app installation.",
    });
    await waitForSoftRebootRecovery(
      transport,
      options.softRebootStabilizationDelayMs,
    );

    for (const packageName of installResult.installedPackages) {
      options.onProgress?.({
        step: "install-wait-target-package",
        message: `Confirming ${packageName} after installation.`,
      });
      await waitForPackageForUserZero(transport, packageName);
    }

    await waitForStagingProviderReady(transport);
    await runUpdatedPackageActivation({
      activateUpdates: async () => {
        await requireProviderOk(
          await callStagingProvider(
            transport,
            "activate_updates",
            installResult.installedPackages.join(","),
            "Failed to activate updated package policy.",
            options.onProgress,
          ),
          "updated package activation",
        );
      },
      repairHookRuntimePolicy: () => repairHookRuntimePolicy(transport),
      refreshConfiguredTargets: () => refreshConfiguredTargets(transport),
      startServerService: () => startServerService(transport),
    });
  } catch (error) {
    const restorationFailures: string[] = [];
    for (const packageName of [...installResult.updatedPackages].reverse()) {
      try {
        await restorePackageForUserZero(transport, packageName);
      } catch (restoreError) {
        restorationFailures.push(
          `${packageName}: ${
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError)
          }`,
        );
      }
    }
    if (restorationFailures.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} User-0 restoration also failed: ${restorationFailures.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }

  return {
    message: `ACCEPTED_PACKAGES:${installResult.installedPackages.join(",")}`,
  };
}

export async function stageSystemApkInstall(
  transport: AdbSessionTransport,
  apk: Blob,
  name: string,
  options: StageSystemApkInstallOptions = {},
): Promise<StageSystemApkInstallResult> {
  const result = await stageSystemApkBatchInstall(
    transport,
    [
      {
        apk,
        name,
        packageName: options.packageName,
      },
    ],
    {
      softRebootStabilizationDelayMs: options.softRebootStabilizationDelayMs,
      onProgress: options.onProgress,
    },
  );

  if (options.waitForNextInstallProviderReady ?? false) {
    options.onProgress?.({
      step: "install-wait-next-provider",
      message: `Waiting for the Device Installer before preparing the next app after ${name}.`,
    });
    await waitForStagingProviderReady(transport);
  }

  return result;
}
