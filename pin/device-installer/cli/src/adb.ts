import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parsePackageBaseApkPath,
  parseSha256Output,
  requireDeviceInstallerCodePath,
} from "./bootstrap-protocol.js";
import { STAGING_URI } from "./constants.js";

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || "adb";

interface AdbResult {
  stdout: string;
  stderr: string;
}

export interface PackagePathCommandResult extends AdbResult {
  exitCode: number;
}

async function adb(...args: string[]): Promise<AdbResult> {
  const { stdout, stderr } = await execFileAsync(ADB, args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

async function adbWithTimeout(timeoutMs: number, ...args: string[]): Promise<AdbResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid ADB timeout: ${timeoutMs}`);
  }
  const { stdout, stderr } = await execFileAsync(ADB, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return { stdout, stderr };
}

async function adbResultWithTimeout(
  timeoutMs: number,
  ...args: string[]
): Promise<PackagePathCommandResult> {
  try {
    const result = await adbWithTimeout(timeoutMs, ...args);
    return { ...result, exitCode: 0 };
  } catch (error) {
    const commandError = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (typeof commandError.code !== "number") throw error;
    return {
      stdout: typeof commandError.stdout === "string" ? commandError.stdout : "",
      stderr: typeof commandError.stderr === "string" ? commandError.stderr : "",
      exitCode: commandError.code,
    };
  }
}

interface AdbDeviceRecord {
  serial: string;
  state: string;
  details: string[];
}

export function parseAdbDeviceRecords(output: string): AdbDeviceRecord[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("List of devices attached"))
    .map((line) => {
      const fields = line.split(/\s+/);
      return {
        serial: fields[0] ?? "",
        state: fields[1] ?? "",
        details: fields.slice(2),
      };
    })
    .filter((record) => record.serial.length > 0);
}

export function parsePackageUidOutput(output: string, packageName: string): number {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const matches = lines
    .map((line) => line.match(new RegExp(`^package:${escapedPackageName}\\s+uid:(\\d+)$`)))
    .filter((match): match is RegExpMatchArray => match !== null);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one UID record for ${packageName}, got: ${output.trim() || "no response"}`
    );
  }
  const uid = Number(matches[0]![1]);
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error(`Invalid UID for ${packageName}: ${matches[0]![1]}`);
  }
  return uid;
}

export function parseRegularPackageBaseApkPath(output: string): string {
  const values = output
    .split("\n")
    .map((line) => line.trim().match(/^package:(\/data\/app\/\S+\/base\.apk)$/)?.[1])
    .filter((value): value is string => value !== undefined);
  if (values.length !== 1) {
    throw new Error(`Expected one regular package base.apk path, got: ${output.trim() || "no response"}`);
  }
  const normalized = path.posix.normalize(values[0]!);
  if (normalized !== values[0] || normalized.includes("/../")) {
    throw new Error(`Unsafe regular package base.apk path: ${values[0]}`);
  }
  return normalized;
}

export function parsePackagePathCommandResult(
  result: PackagePathCommandResult,
  packageName: string
): boolean {
  if (
    result.exitCode === 1 &&
    result.stdout.trim().length === 0 &&
    result.stderr.trim().length === 0
  ) {
    return false;
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Unable to inspect ${packageName} APK path`);
  }
  if (result.stderr.trim().length > 0) {
    throw new Error(`Unexpected package path error for ${packageName}: ${result.stderr.trim()}`);
  }
  if (result.stdout.trim().length === 0) return false;
  const baseApkPath = parseRegularPackageBaseApkPath(result.stdout);
  requirePackageCodePath(path.posix.dirname(baseApkPath), packageName, true);
  return true;
}

async function hasLoadedPackagePathForUser(
  packageName: string,
  userId: number,
  timeoutMs: number
): Promise<boolean> {
  requirePackageName(packageName);
  requireUserId(userId);
  const result = await adbResultWithTimeout(
    timeoutMs,
    "shell",
    "pm",
    "path",
    "--user",
    String(userId),
    packageName
  );
  return parsePackagePathCommandResult(result, packageName);
}

/** Trust-anchor bootstrap/replacement requires a locally attached physical USB transport. */
export async function requirePhysicalUsbTransport(): Promise<void> {
  const { stdout } = await adb("devices", "-l");
  const connected = parseAdbDeviceRecords(stdout).filter((record) => record.state === "device");
  const selectedSerial = process.env.ANDROID_SERIAL;
  const selected = selectedSerial
    ? connected.filter((record) => record.serial === selectedSerial)
    : connected;
  if (selected.length !== 1) {
    throw new Error(
      selectedSerial
        ? `ANDROID_SERIAL=${selectedSerial} does not select one connected ADB device`
        : `Physical maintenance requires exactly one connected ADB device; found ${selected.length}`
    );
  }
  if (!selected[0]!.details.some((field) => field.startsWith("usb:"))) {
    throw new Error(
      "Trust-anchor bootstrap/replacement is restricted to a physical USB ADB connection. " +
        "It is intentionally unavailable over Wi-Fi or the LAN dashboard."
    );
  }
}

/** Run a shell command on the device */
export async function shell(cmd: string): Promise<string> {
  const { stdout } = await adb("shell", cmd);
  return stdout.trim();
}

/** Push a file to the device */
export async function push(localPath: string, remotePath: string): Promise<void> {
  await adb("push", localPath, remotePath);
}

/** Pull a device file to a local backup path. */
export async function pull(remotePath: string, localPath: string): Promise<void> {
  await adb("pull", remotePath, localPath);
}

/** Install an APK via adb install */
export async function install(apkPath: string): Promise<void> {
  await adb("install", apkPath);
}

/** Install or replace a normal APK, used only for the short-lived setup helper. */
export async function installReplacing(apkPath: string): Promise<void> {
  await adb("install", "-r", apkPath);
}

/** Uninstall a package */
export async function uninstall(packageName: string): Promise<void> {
  await adb("uninstall", packageName);
}

/** Remove a generated shell-owned temporary file. */
export async function removeRemoteFile(remotePath: string): Promise<void> {
  if (!/^\/data\/local\/tmp\/[A-Za-z0-9._-]+$/.test(remotePath)) {
    throw new Error(`Refusing to remove unexpected remote path: ${remotePath}`);
  }
  await adb("shell", "rm", "-f", remotePath);
}

function requireUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 0) {
    throw new Error(`Invalid Android user ID: ${userId}`);
  }
}

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

function requirePackageName(packageName: string): void {
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`Invalid Android package name: ${packageName}`);
  }
}

export interface DumpsysPackageUserState {
  installed: boolean;
  loaded: boolean;
  appId: number;
  codePath: string;
}

function requirePackageCodePath(
  codePath: string,
  packageName: string,
  loaded: boolean
): string {
  if (path.posix.normalize(codePath) !== codePath) {
    throw new Error(
      `Unsafe ${loaded ? "loaded" : "retained"} codePath for ${packageName}: ${codePath}`
    );
  }

  const legacyInjectedPath = `/data/app/${packageName}-injected`;
  if (codePath === legacyInjectedPath) return codePath;

  // A pkg=null record is retained metadata, not an authoritative loaded APK.
  // Only the exact legacy Device Installer path is valid for that recovery state.
  if (!loaded) {
    throw new Error(
      `Unexpected retained codePath for ${packageName}: ${codePath}; expected ${legacyInjectedPath}`
    );
  }

  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const packageDirectory = new RegExp(
    `^${escapedPackageName}-[A-Za-z0-9_-]+={0,2}$`
  );
  const volumeDirectory = /^~~[A-Za-z0-9_-]+={0,2}$/;
  const segments = codePath.split("/");
  const directInstall =
    segments.length === 4 &&
    segments[0] === "" &&
    segments[1] === "data" &&
    segments[2] === "app" &&
    packageDirectory.test(segments[3]!);
  const volumeScopedInstall =
    segments.length === 5 &&
    segments[0] === "" &&
    segments[1] === "data" &&
    segments[2] === "app" &&
    volumeDirectory.test(segments[3]!) &&
    packageDirectory.test(segments[4]!);
  if (!directInstall && !volumeScopedInstall) {
    throw new Error(`Unexpected loaded codePath for ${packageName}: ${codePath}`);
  }
  return codePath;
}

/**
 * Parse PackageManager's authoritative per-user setting for one exact package.
 *
 * `pm list packages --user` can omit a retained UID-1000 package immediately after
 * `install-existing` even though PackageManager's PackageSetting already says
 * `installed=true`. The exact `dumpsys package <name>` record exposes that source of
 * truth. Reject malformed or ambiguous output rather than guessing from a substring.
 */
export function parseDumpsysPackageUserState(
  output: string,
  packageName: string,
  userId: number
): DumpsysPackageUserState | null {
  requirePackageName(packageName);
  requireUserId(userId);

  const trimmed = output.trim();
  if (trimmed === `Unable to find package: ${packageName}`) return null;

  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const header = new RegExp(`^(\\s*)Package \\[${escapedPackageName}\\] \\([^\\r\\n()]+\\):\\s*$`);
  const headerMatches = lines
    .map((line, index) => ({ match: line.match(header), index }))
    .filter(
      (entry): entry is { match: RegExpMatchArray; index: number } => entry.match !== null
    );
  if (headerMatches.length !== 1) {
    throw new Error(
      `Expected one exact Package record for ${packageName}, found ${headerMatches.length}`
    );
  }

  const start = headerMatches[0]!.index;
  const headerIndent = headerMatches[0]!.match[1]!.length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= headerIndent) {
      end = index;
      break;
    }
  }
  const record = lines.slice(start + 1, end);

  const appIdMatches = record
    .map((line) => line.match(/^\s+userId=(\d+)\s*$/)?.[1])
    .filter((value): value is string => value !== undefined);
  if (appIdMatches.length !== 1) {
    throw new Error(
      `Expected one PackageManager app ID for ${packageName}, found ${appIdMatches.length}`
    );
  }
  const appId = Number(appIdMatches[0]);
  if (!Number.isSafeInteger(appId) || appId !== 1000) {
    throw new Error(`Expected ${packageName} to use system app ID 1000, got ${appIdMatches[0]}`);
  }

  const pkgValues = record
    .map((line) => line.match(/^\s+pkg=(\S.*)\s*$/)?.[1])
    .filter((value): value is string => value !== undefined);
  if (pkgValues.length !== 1) {
    throw new Error(`Expected one pkg state for ${packageName}, found ${pkgValues.length}`);
  }
  const loadedPkg = new RegExp(
    `^Package\\{[^{}\\s]+\\s+${escapedPackageName}\\}$`
  );
  const loaded = loadedPkg.test(pkgValues[0]!);
  if (!loaded && pkgValues[0] !== "null") {
    throw new Error(`Unexpected pkg state for ${packageName}: ${pkgValues[0]}`);
  }

  const codePathMatches = record
    .map((line) => line.match(/^\s+codePath=(\S+)\s*$/)?.[1])
    .filter((value): value is string => value !== undefined);
  if (codePathMatches.length !== 1) {
    throw new Error(
      `Expected one codePath for ${packageName}, found ${codePathMatches.length}`
    );
  }
  const codePath = requirePackageCodePath(codePathMatches[0]!, packageName, loaded);

  const userLine = new RegExp(`^\\s+User ${userId}:\\s+(.+)$`);
  const userMatches = record
    .map((line) => line.match(userLine)?.[1])
    .filter((value): value is string => value !== undefined);
  if (userMatches.length !== 1) {
    throw new Error(
      `Expected one User ${userId} state for ${packageName}, found ${userMatches.length}`
    );
  }
  const installedMatches = [...userMatches[0]!.matchAll(/(?:^|\s)installed=(true|false)(?=\s|$)/g)];
  if (installedMatches.length !== 1) {
    throw new Error(
      `Expected one installed state for ${packageName} user ${userId}, found ${installedMatches.length}`
    );
  }
  return {
    // A retained setting can say installed=true while pkg=null after a reboot.
    // That record has no loaded APK and cannot satisfy restoration verification.
    installed: loaded && installedMatches[0]![1] === "true",
    loaded,
    appId,
    codePath,
  };
}

async function getPackageUserState(
  packageName: string,
  userId: number,
  timeoutMs?: number
): Promise<DumpsysPackageUserState | null> {
  requirePackageName(packageName);
  requireUserId(userId);
  const result = timeoutMs === undefined
    ? await adb("shell", "dumpsys", "package", packageName)
    : await adbWithTimeout(timeoutMs, "shell", "dumpsys", "package", packageName);
  return parseDumpsysPackageUserState(result.stdout, packageName, userId);
}

/** Check whether a package is installed for one Android user. */
export async function isInstalledForUser(packageName: string, userId: number): Promise<boolean> {
  return (await getPackageUserState(packageName, userId))?.installed ?? false;
}

/** Return the exact Package Manager UID for one installed package/user. */
export async function getPackageUidForUser(packageName: string, userId: number): Promise<number> {
  requireUserId(userId);
  const { stdout } = await adb(
    "shell",
    "pm",
    "list",
    "packages",
    "-U",
    "--user",
    String(userId),
    packageName
  );
  return parsePackageUidOutput(stdout, packageName);
}

export function parseAndroidUserIds(output: string): number[] {
  const userIds = [...output.matchAll(/UserInfo\{(\d+):/g)].map((match) => Number(match[1]));
  if (userIds.length === 0 || userIds.some((id) => !Number.isSafeInteger(id))) {
    throw new Error(`Unable to parse Android users: ${output || "no response"}`);
  }
  return [...new Set(userIds)];
}

export async function listAndroidUserIds(): Promise<number[]> {
  const { stdout } = await adb("shell", "pm", "list", "users");
  return parseAndroidUserIds(stdout);
}

/** Fail before mutation unless every update target is installed only for the selected user. */
export async function validateExclusiveUserInstall(
  packageNames: readonly string[],
  userId: number
): Promise<void> {
  requireUserId(userId);
  const userIds = await listAndroidUserIds();
  if (!userIds.includes(userId)) {
    throw new Error(`Android user ${userId} does not exist`);
  }

  for (const packageName of packageNames) {
    if (!(await isInstalledForUser(packageName, userId))) {
      throw new Error(
        `Refusing keep-data update: ${packageName} is not installed for target user ${userId}`
      );
    }
    for (const otherUserId of userIds) {
      if (otherUserId !== userId && (await isInstalledForUser(packageName, otherUserId))) {
        throw new Error(
          `Refusing keep-data update: ${packageName} is also installed for Android user ` +
          `${otherUserId}. No installed package was changed.`
        );
      }
    }
  }
}

/**
 * Uninstall a package for one user while retaining its app data, then verify
 * Package Manager no longer reports it installed for that user.
 */
export async function uninstallKeepDataForUser(
  packageName: string,
  userId: number
): Promise<void> {
  requireUserId(userId);
  const { stdout, stderr } = await adb(
    "shell",
    "pm",
    "uninstall",
    "-k",
    "--user",
    String(userId),
    packageName
  );
  const resultLines = `${stdout}\n${stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!resultLines.includes("Success") || resultLines.some((line) => line.startsWith("Failure"))) {
    throw new Error(
      `Keep-data uninstall failed for ${packageName} (user ${userId}): ` +
      (resultLines.join(" | ") || "no Package Manager response")
    );
  }
  await waitForPackageUnloadedWithOperations(packageName, userId, {
    isLoaded: async (timeoutMs) =>
      hasLoadedPackagePathForUser(packageName, userId, timeoutMs),
    delay: async (milliseconds) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
  });
}

export interface WaitForPackageUnloadedOperations {
  isLoaded(timeoutMs: number): Promise<boolean>;
  delay(milliseconds: number): Promise<void>;
}

export interface WaitForPackageUnloadedPolicy {
  checkTimeoutMs: number;
  verificationAttempts: number;
  verificationIntervalMs: number;
}

const DEFAULT_WAIT_FOR_PACKAGE_UNLOADED_POLICY: WaitForPackageUnloadedPolicy = {
  checkTimeoutMs: 2_000,
  verificationAttempts: 12,
  verificationIntervalMs: 250,
};

export async function waitForPackageUnloadedWithOperations(
  packageName: string,
  userId: number,
  operations: WaitForPackageUnloadedOperations,
  policy: WaitForPackageUnloadedPolicy = DEFAULT_WAIT_FOR_PACKAGE_UNLOADED_POLICY
): Promise<void> {
  requirePackageName(packageName);
  requireUserId(userId);
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid uninstall-verification ${name}: ${value}`);
    }
  }

  let lastCheckError: unknown = null;
  for (let attempt = 0; attempt < policy.verificationAttempts; attempt += 1) {
    try {
      const loaded = await withTimeout(
        operations.isLoaded(policy.checkTimeoutMs),
        policy.checkTimeoutMs,
        `PackageManager unload verification for ${packageName}`
      );
      if (!loaded) return;
      lastCheckError = null;
    } catch (error) {
      lastCheckError = error;
    }
    if (attempt + 1 < policy.verificationAttempts) {
      await operations.delay(policy.verificationIntervalMs);
    }
  }

  const detail = lastCheckError === null
    ? "the APK remained loaded"
    : `the last state check failed: ${
      lastCheckError instanceof Error ? lastCheckError.message : String(lastCheckError)
    }`;
  throw new Error(
    `Keep-data uninstall reported success, but ${packageName} still had a loaded APK for user ` +
    `${userId} after ${policy.verificationAttempts} bounded checks (${detail})`
  );
}

export interface EnsureInstalledForUserOperations {
  isInstalled(timeoutMs: number): Promise<boolean>;
  installExisting(timeoutMs: number): Promise<void>;
}

export interface EnsureInstalledForUserPolicy {
  initialCheckTimeoutMs: number;
  commandTimeoutMs: number;
  verificationCheckTimeoutMs: number;
  verificationAttempts: number;
  verificationIntervalMs: number;
}

const DEFAULT_ENSURE_INSTALLED_POLICY: EnsureInstalledForUserPolicy = {
  initialCheckTimeoutMs: 2_000,
  commandTimeoutMs: 10_000,
  verificationCheckTimeoutMs: 2_000,
  verificationAttempts: 12,
  verificationIntervalMs: 250,
};

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireEnsureInstalledPolicy(policy: EnsureInstalledForUserPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid ensure-installed ${name}: ${value}`);
    }
  }
}

/**
 * Re-enable a retained package setting with a bounded command and bounded,
 * authoritative PackageSetting verification. A missing callback or wedged ADB
 * subprocess can no longer hold the whole keep-data rollback open forever.
 */
export async function ensureInstalledForUserWithOperations(
  packageName: string,
  userId: number,
  operations: EnsureInstalledForUserOperations,
  policy: EnsureInstalledForUserPolicy = DEFAULT_ENSURE_INSTALLED_POLICY
): Promise<void> {
  requirePackageName(packageName);
  requireUserId(userId);
  requireEnsureInstalledPolicy(policy);

  let initiallyInstalled: boolean;
  try {
    initiallyInstalled = await withTimeout(
      operations.isInstalled(policy.initialCheckTimeoutMs),
      policy.initialCheckTimeoutMs,
      `Initial PackageManager state check for ${packageName}`
    );
  } catch (error) {
    throw new Error(
      `Unable to verify ${packageName} before user-${userId} restoration; ` +
      `no restoration command was issued: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (initiallyInstalled) return;

  let commandError: unknown = null;
  try {
    await withTimeout(
      operations.installExisting(policy.commandTimeoutMs),
      policy.commandTimeoutMs,
      `install-existing for ${packageName}`
    );
  } catch (error) {
    // The PackageManager mutation may have succeeded even if its response or
    // callback was lost. Only the authoritative post-state decides success.
    commandError = error;
  }

  let lastVerificationError: unknown = null;
  for (let attempt = 0; attempt < policy.verificationAttempts; attempt += 1) {
    try {
      const installed = await withTimeout(
        operations.isInstalled(policy.verificationCheckTimeoutMs),
        policy.verificationCheckTimeoutMs,
        `PackageManager verification for ${packageName}`
      );
      if (installed) return;
      lastVerificationError = null;
    } catch (error) {
      lastVerificationError = error;
    }
    if (attempt + 1 < policy.verificationAttempts) {
      await new Promise((resolve) => setTimeout(resolve, policy.verificationIntervalMs));
    }
  }

  const details = [
    commandError === null
      ? "install-existing returned without a verified installed state"
      : `install-existing failed or timed out: ${commandError instanceof Error ? commandError.message : String(commandError)}`,
    lastVerificationError === null
      ? null
      : `last state check failed: ${lastVerificationError instanceof Error ? lastVerificationError.message : String(lastVerificationError)}`,
  ].filter((value): value is string => value !== null);
  throw new Error(
    `Updated package ${packageName} is not installed for user ${userId} after ` +
    `${policy.verificationAttempts} bounded checks (${details.join("; ")})`
  );
}

export function buildInstallExistingArguments(packageName: string, userId: number): string[] {
  requirePackageName(packageName);
  requireUserId(userId);
  return [
    "shell",
    "cmd",
    "package",
    "install-existing",
    "--user",
    String(userId),
    packageName,
  ];
}

/** Re-enable a retained package setting for one user after an update. */
export async function ensureInstalledForUser(packageName: string, userId: number): Promise<void> {
  return ensureInstalledForUserWithOperations(packageName, userId, {
    isInstalled: async (timeoutMs) =>
      hasLoadedPackagePathForUser(packageName, userId, timeoutMs),
    installExisting: async (timeoutMs) => {
      await adbWithTimeout(timeoutMs, ...buildInstallExistingArguments(packageName, userId));
    },
  });
}

/** Return the exact active base.apk path for a package and Android user. */
export async function getPackageBaseApkPath(
  packageName: string,
  userId: number
): Promise<string> {
  requireUserId(userId);
  const { stdout } = await adb(
    "shell",
    "pm",
    "path",
    "--user",
    String(userId),
    packageName
  );
  return parsePackageBaseApkPath(stdout);
}

/** Return a normal /data/app base.apk path without applying Device Installer directory rules. */
export async function getRegularPackageBaseApkPath(
  packageName: string,
  userId: number
): Promise<string> {
  requireUserId(userId);
  const { stdout } = await adb(
    "shell",
    "pm",
    "path",
    "--user",
    String(userId),
    packageName
  );
  return parseRegularPackageBaseApkPath(stdout);
}

/** Hash one controlled Device Installer APK directly on the device. */
export async function sha256RemoteBaseApk(baseApkPath: string): Promise<string> {
  requireDeviceInstallerCodePath(baseApkPath.replace(/\/base\.apk$/, ""));
  const { stdout } = await adb("shell", "sha256sum", baseApkPath);
  return parseSha256Output(stdout);
}

/** Hash the transaction-bound shell-owned staged candidate. */
export async function sha256RemoteStagedApk(apkPath: string): Promise<string> {
  if (!/^\/data\/local\/tmp\/installer-[a-f0-9]{32}\.apk$/.test(apkPath)) {
    throw new Error(`Refusing to hash unexpected staged APK path: ${apkPath}`);
  }
  const { stdout } = await adb("shell", "sha256sum", apkPath);
  return parseSha256Output(stdout);
}

/** Hash an installed regular helper APK at its exact Package Manager path. */
export async function sha256RemoteRegularBaseApk(baseApkPath: string): Promise<string> {
  if (parseRegularPackageBaseApkPath(`package:${baseApkPath}`) !== baseApkPath) {
    throw new Error(`Invalid regular base.apk path: ${baseApkPath}`);
  }
  const { stdout } = await adb("shell", "sha256sum", baseApkPath);
  return parseSha256Output(stdout);
}

/** Read PackageInstaller's active-session dump for strict recovery preflight parsing. */
export async function dumpPackageInstallerSessions(): Promise<string> {
  const { stdout } = await adb("shell", "dumpsys", "package", "installs");
  return stdout;
}

/** Test one already-validated Device Installer code path without using a shell expression. */
export async function deviceInstallerCodePathExists(codePath: string): Promise<boolean> {
  requireDeviceInstallerCodePath(codePath);
  try {
    await adb("shell", "test", "-e", codePath);
    return true;
  } catch (error) {
    if ((error as { code?: number | string }).code === 1) return false;
    throw error;
  }
}

/** Wait for the device to be available */
export async function waitForDevice(): Promise<void> {
  await adb("wait-for-device");
}

/** Read the single system_server PID, rejecting an ambiguous response. */
export async function getSystemServerPid(): Promise<string> {
  const output = await shell("pidof system_server");
  if (!/^\d+$/.test(output)) {
    throw new Error(`Unable to determine system_server PID: ${output || "no response"}`);
  }
  return output;
}

/**
 * Wait until the asynchronous Device Installer has actually restarted system_server.
 * A readiness check alone is insufficient because PMS is still healthy while
 * the provider's background patch/sign work is running.
 */
export async function waitForSystemServerRestart(
  previousPid: string,
  timeoutMs: number,
  pollMs: number
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const currentPid = await getSystemServerPid();
      if (currentPid !== previousPid) return;
    } catch {
      // system_server (or the adb shell transport) may be briefly unavailable.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for system_server PID ${previousPid} to restart. ` +
    `The background install may have failed; check: adb logcat -s LumaInstaller ApkPatcher`
  );
}

/** List installed packages */
export async function listPackages(): Promise<string[]> {
  const output = await shell("pm list packages");
  return output
    .split("\n")
    .map((line) => line.replace("package:", "").trim())
    .filter((pkg) => pkg.length > 0);
}

/** Check if a specific package is installed */
export async function isInstalled(packageName: string): Promise<boolean> {
  const packages = await listPackages();
  return packages.includes(packageName);
}

/** Send a broadcast with string extras.
 *  When `component` is provided (e.g. "com.example/.MyReceiver") the broadcast
 *  is sent as an explicit intent via `-n`, which lets Android deliver it to a
 *  freshly installed app before that app has been launched.
 */
export async function broadcast(
  action: string,
  extras?: Record<string, string>,
  component?: string
): Promise<string> {
  const args = ["shell", "am", "broadcast", "-a", action];
  if (component) {
    args.push("-n", component);
  }
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      args.push("--es", key, value);
    }
  }
  const { stdout } = await adb(...args);
  return stdout.trim();
}

/**
 * Wait for the system to be fully ready (PackageManagerService available).
 *
 * `adb wait-for-device` only confirms adbd is up, which happens well before
 * system_server finishes initializing. This polls `service check package` to
 * confirm PMS is available, then waits an extra settle period to let PMS
 * finish restoring sessions from install_sessions.xml.
 */
export async function waitForSystemReady(
  timeoutMs: number,
  pollMs: number,
  settleMs: number
): Promise<void> {
  await waitForDevice();

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const output = await shell("service check package");
      if (output.includes("found")) {
        // PMS is registered, wait a bit longer for it to finish restoring
        // installer sessions from install_sessions.xml
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        return;
      }
    } catch {
      // Shell call may fail while system_server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for PackageManagerService. ` +
    `The device may be stuck. Check: adb shell service check package`
  );
}

function hasProviderAccessError(output: string): boolean {
  return (
    output.includes("Error while accessing provider:") ||
    output.includes("Could not find provider:")
  );
}

export async function waitForStagingProviderReady(
  timeoutMs: number,
  pollMs: number,
  probeTimeoutMs = 2_000
): Promise<void> {
  for (const [name, value] of Object.entries({ timeoutMs, pollMs, probeTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid provider-readiness ${name}: ${value}`);
    }
  }

  const start = Date.now();
  let lastResponse = "provider not ready";
  while (Date.now() - start < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - start);
    try {
      const result = await adbWithTimeout(
        Math.max(1, Math.min(probeTimeoutMs, remainingMs)),
        "shell",
        "content",
        "query",
        "--uri",
        `${STAGING_URI}/provider-ready-probe.apk`
      );
      const output = `${result.stdout}\n${result.stderr}`;
      if (!hasProviderAccessError(output)) return;
      lastResponse = output.trim() || "provider access failed";
    } catch (error) {
      lastResponse = error instanceof Error ? error.message : String(error);
    }
    const delayMs = Math.min(pollMs, timeoutMs - (Date.now() - start));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the staging provider. ` +
    `Last response: ${lastResponse.slice(0, 240)}`
  );
}

/**
 * Poll until a package appears in the package list.
 * @returns true if found, false if timed out
 */
export async function pollForPackage(
  packageName: string,
  intervalMs: number,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await waitForDevice();
      if (await isInstalled(packageName)) {
        return true;
      }
    } catch {
      // Device may be rebooting, keep trying
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Write a local file to a content provider URI via `adb shell content write`.
 *
 * This pipes the file's bytes through Binder into the provider's `openFile()`
 * method, so the provider owns the destination-file access check.
 */
export async function contentWrite(localPath: string, uri: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ADB, ["shell", "content", "write", "--uri", uri], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const fileStream = fs.createReadStream(localPath);

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      fileStream.destroy();
      if (code !== 0) {
        reject(new Error(`content write failed (exit ${code}): ${stderr.trim()}`));
      } else {
        resolve();
      }
    });

    child.on("error", reject);
    child.stdin.on("error", reject);

    fileStream.pipe(child.stdin);
    fileStream.on("error", reject);
  });
}

/**
 * Call a content provider method via `adb shell content call`.
 */
export async function contentCall(uri: string, method: string, arg?: string): Promise<string> {
  const args = ["shell", "content", "call", "--uri", uri, "--method", method];
  if (arg) {
    args.push("--arg", arg);
  }
  const { stdout } = await adb(...args);
  return stdout.trim();
}
