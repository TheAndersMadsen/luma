import type { AdbSessionTransport } from "./transport";
import { AdbDeviceStepTimeoutError, withDeviceStepTimeout } from "./transport";
import { getInstalledPackageMetadata } from "./packageManager";

export const BOOT_COMPLETED_TIMEOUT_MS = 240_000;
export const BOOT_COMPLETED_POLL_MS = 2_000;

export const DEFAULT_SOFT_REBOOT_SETTLE_MS = 10000;

export interface PackageReadinessResult {
  readonly packageName: string;
  readonly queryable: boolean;
  readonly versionName: string | null;
}

export type DeviceCredentialState = "locked" | "unlocked" | "unknown";

export interface DeviceCredentialAvailabilityResult {
  readonly state: DeviceCredentialState;
  readonly ceAvailableRaw: string | null;
}

export interface DeviceReadinessResult {
  readonly packageQueryabilityOk: boolean;
  readonly settleDelayMs: number;
  readonly packageResults: readonly PackageReadinessResult[];
  readonly credentialState: DeviceCredentialAvailabilityResult;
}

function sleep(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function inspectCredentialState(
  transport: AdbSessionTransport,
): Promise<DeviceCredentialAvailabilityResult> {
  try {
    const result = await transport.shell(["getprop", "sys.user.0.ce_available"]);
    const ceAvailableRaw = result.stdout.trim() || null;

    return {
      state:
        ceAvailableRaw === "1" || ceAvailableRaw === "true"
          ? "unlocked"
          : "locked",
      ceAvailableRaw,
    };
  } catch {
    return {
      state: "locked",
      ceAvailableRaw: null,
    };
  }
}

export async function waitForSoftRebootSettle(delayMs = DEFAULT_SOFT_REBOOT_SETTLE_MS) {
  if (delayMs <= 0) {
    return;
  }

  await sleep(delayMs);
}

function isDeviceStepTimeoutError(error: unknown): error is AdbDeviceStepTimeoutError {
  return error instanceof AdbDeviceStepTimeoutError;
}

/**
 * A full reboot (the conflict flows' `reboot` cleanup command) leaves the Pin
 * unavailable far longer than the package-manager probe alone tolerates, so the
 * removal flows gate on Android's own boot-completed property before probing
 * package services.
 */
export async function waitForBootCompleted(
  transport: AdbSessionTransport,
  timeoutMs = BOOT_COMPLETED_TIMEOUT_MS,
  pollMs = BOOT_COMPLETED_POLL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await withDeviceStepTimeout(
        "wait for the Pin to finish starting",
        () => transport.shell(["getprop", "sys.boot_completed"]),
        Math.max(1, deadline - Date.now()),
      );
      if (result.stdout.trim() === "1") {
        return;
      }
    } catch (error) {
      if (isDeviceStepTimeoutError(error)) {
        throw error;
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(pollMs, remainingMs));
    }
  }

  throw new Error(
    "The Pin did not finish starting within 4 minutes. Keep it on the cable and unlocked, then try again.",
  );
}

export async function inspectPackageQueryability(
  transport: AdbSessionTransport,
  packageNames: readonly string[],
  settleDelayMs = DEFAULT_SOFT_REBOOT_SETTLE_MS,
): Promise<DeviceReadinessResult> {
  await waitForSoftRebootSettle(settleDelayMs);

  const [credentialState, packageResults] = await Promise.all([
    inspectCredentialState(transport),
    Promise.all(
      packageNames.map(async (packageName) => {
        const metadata = await getInstalledPackageMetadata(transport, packageName);
        return {
          packageName,
          queryable: metadata?.querySucceeded ?? false,
          versionName: metadata?.versionName ?? null,
        };
      }),
    ),
  ]);

  return {
    packageQueryabilityOk: packageResults.every((result) => result.queryable),
    settleDelayMs,
    packageResults,
    credentialState,
  };
}
