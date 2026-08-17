import type { AdbSessionTransport } from "./transport";
import { getInstalledPackageMetadata } from "./packageManager";

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
