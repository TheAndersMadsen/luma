import {
  AdbDeviceStepTimeoutError,
  type AdbSessionTransport,
  type ShellResult,
} from "./transport";
import { PACKAGES } from "@/lib/pin-install/generated/tier-a-symbols";
// Every command below interpolates a package or component name, and ADB hands
// the joined string to the device's shell — so the same quoting the installer
// uses is required here too. The names are currently drawn from a fixed table,
// which is why this was not the hole that was exploitable; relying on that
// staying true is exactly how the installer's hole was introduced.
import { shellCommand } from "./shellQuote";

export { MANAGED_PACKAGES } from "@/lib/pin-install/domain/managedPackages";

export const PACKAGE_METADATA_POLL_INTERVAL_MS = 3000;
export const PACKAGE_METADATA_POLL_TIMEOUT_MS = 120000;
export const SET_HOME_ACTIVITY_RETRY_DELAY_MS = 200;
export const SET_HOME_ACTIVITY_MAX_ATTEMPTS = 3;
export const DEFAULT_HOME_ACTIVITY =
  `${PACKAGES.system_navigation}/humaneinternal.system.ipc.HumaneExperienceActivity`;

export interface InstalledPackageMetadata {
  readonly packageName: string;
  readonly versionName: string | null;
  readonly signerIdentity: string | null;
  readonly querySucceeded: boolean;
  readonly rawOutput: string;
}

export interface PackageEnableDisableResult {
  readonly packageName: string;
  readonly success: boolean;
  readonly message: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export function hasExactPackageLine(output: string, packageName: string): boolean {
  const exactLine = `package:${packageName}`;
  return output
    .split(/\r?\n/)
    .some((line) => line.trim() === exactLine);
}

export function parseVersionNameFromDumpsys(output: string): string | null {
  const match = output.match(/(?:^|\s)versionName=([^\s]+)/m);
  return match?.[1] ?? null;
}

/**
 * observed: Android's package dump identifies the current signer inside a
 * PackageSignatures record (for example, signatures:[dd07f452]).  This is an
 * identity token, not a certificate export.  Ambiguous or multi-signer output
 * is deliberately treated as unreadable.
 */
export function parseSignerIdentityFromDumpsys(output: string): string | null {
  const identities: string[] = [];
  const recordPattern =
    /PackageSignatures\{[^}]*?\bsignatures:\s*\[([^\]]*)\]/g;

  for (const match of output.matchAll(recordPattern)) {
    const tokens = (match[1] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (
      tokens.length !== 1 ||
      !/^(?:[0-9a-f]{8}|[0-9a-f]{64})$/.test(tokens[0] ?? "")
    ) {
      return null;
    }
    identities.push(tokens[0]!);
  }

  return identities.length === 1 ? identities[0]! : null;
}

export function parseInstalledPackageNames(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^package:(.+)$/)?.[1] ?? null)
    .filter((packageName): packageName is string => packageName !== null);
}

export function matchesPackagePattern(packageName: string, pattern: string): boolean {
  const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexPattern = `^${escapedPattern.replace(/\*/g, ".*")}$`;
  return new RegExp(regexPattern).test(packageName);
}

function ensureShellSuccess(result: ShellResult, fallbackMessage: string) {
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || fallbackMessage);
  }
}

function isDeviceStepTimeoutError(error: unknown): error is AdbDeviceStepTimeoutError {
  return error instanceof AdbDeviceStepTimeoutError;
}

export async function listInstalledPackages(
  transport: AdbSessionTransport,
): Promise<string[]> {
  const result = await transport.shell(["pm", "list", "packages"]);
  return parseInstalledPackageNames(result.stdout);
}

export async function packageExists(
  transport: AdbSessionTransport,
  packageName: string,
): Promise<boolean> {
  const result = await transport.shell(shellCommand(["pm", "list", "packages", packageName]));
  return hasExactPackageLine(result.stdout, packageName);
}

export async function getInstalledPackageMetadata(
  transport: AdbSessionTransport,
  packageName: string,
): Promise<InstalledPackageMetadata | null> {
  const installed = await packageExists(transport, packageName);
  if (!installed) {
    return null;
  }

  const result = await transport.shell(shellCommand(["dumpsys", "package", packageName]));
  const rawOutput = `${result.stdout}\n${result.stderr}`.trim();

  return {
    packageName,
    versionName: parseVersionNameFromDumpsys(rawOutput),
    signerIdentity: parseSignerIdentityFromDumpsys(rawOutput),
    querySucceeded: result.exitCode === 0,
    rawOutput,
  };
}

export async function waitForReadablePackageMetadata(
  transport: AdbSessionTransport,
  packageName: string,
  intervalMs = PACKAGE_METADATA_POLL_INTERVAL_MS,
  timeoutMs = PACKAGE_METADATA_POLL_TIMEOUT_MS,
): Promise<InstalledPackageMetadata> {
  const start = Date.now();
  let lastMetadata: InstalledPackageMetadata | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const metadata = await getInstalledPackageMetadata(transport, packageName);
      if (metadata) {
        lastMetadata = metadata;
        if (metadata.querySucceeded && metadata.versionName) {
          return metadata;
        }
      }
    } catch (error) {
      if (isDeviceStepTimeoutError(error)) {
        throw error;
      }
      // Retry until timeout.
    }

    await sleep(intervalMs);
  }

  if (lastMetadata) {
    throw new Error(
      `Timed out waiting for readable package metadata for ${packageName}. Last observed versionName=${lastMetadata.versionName ?? "<missing>"}.`,
    );
  }

  throw new Error(`Timed out waiting for package metadata for ${packageName}.`);
}

export async function uninstallPackage(
  transport: AdbSessionTransport,
  packageName: string,
): Promise<void> {
  const result = await transport.shell(shellCommand(["pm", "uninstall", packageName]));
  ensureShellSuccess(result, `pm uninstall failed for ${packageName}`);
}

export async function disablePackageForUser(
  transport: AdbSessionTransport,
  packageName: string,
): Promise<PackageEnableDisableResult> {
  const result = await transport.shell(shellCommand(["pm", "disable-user", "--user", "0", packageName]));

  return {
    packageName,
    success: result.exitCode === 0,
    message:
      result.stderr.trim() || result.stdout.trim() || `disable-user completed for ${packageName}`,
  };
}

export async function enablePackageForUser(
  transport: AdbSessionTransport,
  packageName: string,
): Promise<PackageEnableDisableResult> {
  const result = await transport.shell(shellCommand(["pm", "enable", "--user", "0", packageName]));

  return {
    packageName,
    success: result.exitCode === 0,
    message: result.stderr.trim() || result.stdout.trim() || `enable completed for ${packageName}`,
  };
}

export async function setHomeActivity(
  transport: AdbSessionTransport,
  componentName = DEFAULT_HOME_ACTIVITY,
): Promise<void> {
  let lastResult: ShellResult | null = null;

  for (let attempt = 1; attempt <= SET_HOME_ACTIVITY_MAX_ATTEMPTS; attempt += 1) {
    lastResult = await transport.shell(shellCommand(["cmd", "package", "set-home-activity", componentName]));
    if (lastResult.exitCode === 0) {
      return;
    }

    if (attempt < SET_HOME_ACTIVITY_MAX_ATTEMPTS) {
      await sleep(SET_HOME_ACTIVITY_RETRY_DELAY_MS);
    }
  }

  ensureShellSuccess(
    lastResult ?? { exitCode: 1, stdout: "", stderr: "" },
    `cmd package set-home-activity failed for ${componentName}`,
  );
}
