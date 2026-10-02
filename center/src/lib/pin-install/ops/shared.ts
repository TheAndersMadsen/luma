import {
  inspectInstallStateAfterPackageManagerReady,
  type InstallInspectionResult,
} from "../domain/inspection";
import {
  BATCH_INSTALL_TIMEOUT_MS,
  bootstrapInstaller,
  disablePackageForUser,
  enablePackageForUser,
  packageExists,
  stageSystemApkBatchInstall,
  uninstallPackage,
  waitForReadablePackageMetadata,
  withDeviceStepTimeout,
  type AdbSessionTransport,
  type BootstrapInstallerAssets,
  type SystemInstallerProgressEvent,
} from "../device";
import { MANAGED_PACKAGES } from "../domain/managedPackages";
import type { ManagedPackageRole } from "../domain/types";
import type {
  DownloadedInstallAssetRole,
  DownloadedInstallTargetAssets,
  ResolvedInstallTarget,
} from "../releases/assets";
import {
  DEFAULT_DISABLE_PACKAGES,
  INSTALL_PACKAGE_ORDER,
  MANAGED_CLEANUP_ORDER,
  type OperationWarning,
} from "./phases";

async function cleanupPackages(
  transport: AdbSessionTransport,
  packageNames: ReadonlySet<string>,
): Promise<void> {
  for (const packageName of MANAGED_CLEANUP_ORDER) {
    if (packageNames.has(packageName) && await packageExists(transport, packageName)) {
      await uninstallPackage(transport, packageName);
    }
  }
}

export async function cleanupManagedPackages(
  transport: AdbSessionTransport,
): Promise<void> {
  await cleanupPackages(transport, new Set(MANAGED_CLEANUP_ORDER));
}

export async function disableConfiguredPackages(
  transport: AdbSessionTransport,
  packageNames: readonly string[] = DEFAULT_DISABLE_PACKAGES,
): Promise<OperationWarning[]> {
  const warnings: OperationWarning[] = [];

  for (const packageName of packageNames) {
    const result = await disablePackageForUser(transport, packageName);
    if (!result.success) {
      warnings.push({
        code: "disable-failed",
        packageName,
        message: result.message,
      });
    }
  }

  return warnings;
}

export async function restoreConfiguredPackages(
  transport: AdbSessionTransport,
  packageNames: readonly string[] = DEFAULT_DISABLE_PACKAGES,
): Promise<OperationWarning[]> {
  const warnings: OperationWarning[] = [];

  for (const packageName of packageNames) {
    const result = await enablePackageForUser(transport, packageName);
    if (!result.success) {
      warnings.push({
        code: "restore-failed",
        packageName,
        message: result.message,
      });
    }
  }

  return warnings;
}

export async function bootstrapFinalInstaller(
  transport: AdbSessionTransport,
  assets: BootstrapInstallerAssets,
  options?: {
    readonly onProgress?: (event: SystemInstallerProgressEvent) => void;
  },
): Promise<void> {
  await bootstrapInstaller(transport, assets, {
    onProgress: options?.onProgress,
  });
}

function requireDownloadedAsset(
  downloadedAssets: DownloadedInstallTargetAssets,
  assetKey: DownloadedInstallAssetRole,
): Blob {
  const asset = downloadedAssets[assetKey];
  if (!asset) {
    throw new Error(`Missing downloaded asset ${assetKey}.`);
  }
  return asset;
}

export async function installManagedPackages(
  transport: AdbSessionTransport,
  downloadedAssets: DownloadedInstallTargetAssets,
  options?: {
    readonly roles?: readonly ManagedPackageRole[];
    readonly expectedExistingPackageNames?: readonly string[];
    readonly onMutationStart?: () => void;
    readonly onProgress?: (event: SystemInstallerProgressEvent) => void;
    readonly onPackageStart?: (info: {
      readonly packageName: string;
      readonly index: number;
      readonly total: number;
    }) => void;
    readonly onPackageCompleted?: (info: {
      readonly packageName: string;
      readonly index: number;
      readonly total: number;
    }) => void;
  },
): Promise<void> {
  const selectedRoles = options?.roles ? new Set(options.roles) : null;
  const entries = selectedRoles
    ? INSTALL_PACKAGE_ORDER.filter((entry) => selectedRoles.has(entry.role))
    : INSTALL_PACKAGE_ORDER;
  const total = entries.length;
  if (total === 0) {
    return;
  }

  entries.forEach((entry, index) => {
    options?.onPackageStart?.({ packageName: entry.packageName, index, total });
  });

  await withDeviceStepTimeout(
    `install ${total} managed package${total === 1 ? "" : "s"}`,
    () =>
      stageSystemApkBatchInstall(
        transport,
        entries.map((entry) => ({
          apk: requireDownloadedAsset(downloadedAssets, entry.assetKey),
          name: entry.fileName,
          packageName: entry.packageName,
        })),
        {
          expectedExistingPackageNames:
            options?.expectedExistingPackageNames,
          onMutationStart: options?.onMutationStart,
          onProgress: options?.onProgress,
        },
      ),
    BATCH_INSTALL_TIMEOUT_MS,
  );

  entries.forEach((entry, index) => {
    options?.onPackageCompleted?.({
      packageName: entry.packageName,
      index,
      total,
    });
  });
}

async function waitForManagedPackageVersions(transport: AdbSessionTransport) {
  await waitForReadablePackageMetadata(transport, MANAGED_PACKAGES.installer);
  await waitForReadablePackageMetadata(transport, MANAGED_PACKAGES.hook);
  await waitForReadablePackageMetadata(transport, MANAGED_PACKAGES.server);
  await waitForReadablePackageMetadata(transport, MANAGED_PACKAGES.loader);
}

export interface InstallVerificationPolicy {
  readonly mode: "in-place" | "bootstrap-recovery";
  readonly expectedSignerIdentity: string;
  readonly retainedInstaller: Readonly<{
    versionName: string;
    signerIdentity: string;
  }> | null;
}

export async function verifyInstalledManagedState(
  transport: AdbSessionTransport,
  target: ResolvedInstallTarget,
  policy: InstallVerificationPolicy,
): Promise<InstallInspectionResult> {
  const inspection = await withDeviceStepTimeout(
    "verify install phase",
    async () => {
      // These bounded metadata polls already fail closed until package queries
      // work, so verification does not need a second generic readiness loop.
      await waitForManagedPackageVersions(transport);
      return inspectInstallStateAfterPackageManagerReady(transport, {
        target,
        readinessSettleDelayMs: 0,
      });
    },
  );

  const packages = Object.values(inspection.packages);
  if (inspection.helperPresentUnexpectedly) {
    throw new Error("The Setup Helper is still present after installation.");
  }

  if (!inspection.readiness.packageQueryabilityOk) {
    throw new Error("Managed package readiness verification failed.");
  }

  if (inspection.readiness.credentialState.state !== "unlocked") {
    throw new Error("The Ai Pin became locked before install verification.");
  }

  if (packages.some((pkg) => !pkg.installed)) {
    throw new Error("One or more managed packages are missing after install.");
  }

  if (
    packages.some(
      (pkg) => pkg.signerIdentity !== policy.expectedSignerIdentity,
    )
  ) {
    throw new Error("One or more managed package signer identities changed.");
  }

  const installer = inspection.packages.installer;
  if (
    policy.mode === "in-place" &&
    (!policy.retainedInstaller ||
      installer.versionName !== policy.retainedInstaller.versionName ||
      installer.signerIdentity !== policy.retainedInstaller.signerIdentity)
  ) {
    throw new Error("The retained installer identity changed during migration.");
  }

  if (
    policy.mode === "bootstrap-recovery" &&
    installer.versionName !== target.version
  ) {
    throw new Error("Recovered installer does not match the selected target.");
  }

  if (
    [
      inspection.packages.hook,
      inspection.packages.server,
      inspection.packages.loader,
    ].some((pkg) => pkg.versionName !== target.version)
  ) {
    throw new Error(
      "One or more runtime packages do not match the selected target version.",
    );
  }

  return inspection;
}

export async function verifyUninstalledManagedState(
  transport: AdbSessionTransport,
): Promise<void> {
  await withDeviceStepTimeout("verify uninstall phase", async () => {
    for (const packageName of MANAGED_CLEANUP_ORDER) {
      if (await packageExists(transport, packageName)) {
        throw new Error(`Managed package ${packageName} is still present.`);
      }
    }
  });
}
