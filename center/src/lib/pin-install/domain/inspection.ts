import { deriveInstallActionState } from "./actionState";
import {
  classifyKeepDataUpdate,
  parseInstalledAppIdFromDumpsys,
  parseInstalledBaseApkPathFromDumpsys,
  type KeepDataUpdateVerdict,
} from "./keepDataEligibility";
import {
  classifyUnrecognizedPackages,
  getDetectedConflictPackageIds,
  matchKnownPackageConflicts,
} from "./knownPackageConflicts";
import { MANAGED_PACKAGES } from "./managedPackages";
import {
  createTimedAdbSessionTransport,
  getDeviceIdentity,
  getInstalledPackageMetadata,
  inspectPackageQueryability,
  listInstalledPackages,
  waitForPackageManagerReady,
  type AdbSessionTransport,
  type DeviceIdentity,
  type DeviceReadinessResult,
  type InstalledPackageMetadata,
} from "../device";
import { classifyInstalledVersion } from "./versions";
import type {
  DetectedPackageConflict,
  InstallActionState,
  KnownPackageConflictDefinition,
  ManagedPackageInspection,
  ManagedPackageRole,
} from "./types";
import type { ResolvedInstallTarget } from "../releases/assets";

export interface ManagedPackageVersionSnapshot {
  readonly role: ManagedPackageRole;
  readonly packageName: string;
  readonly installed: boolean;
  readonly healthy: boolean;
  readonly versionName: string | null;
  readonly signerIdentity: string | null;
  readonly versionReadable: boolean;
  readonly querySucceeded: boolean;
  readonly rawOutput: string | null;
  readonly targetVersion: string;
  readonly versionComparison: ManagedPackageInspection["versionComparison"];
  /**
   * Which app ID owns the package and which APK it is running, the two facts
   * the device's own installer uses to decide whether it may keep the package's
   * data across an update. Read out of the package dump because nothing on the
   * device layer captures them. See ./keepDataEligibility.
   */
  readonly appId: number | null;
  readonly baseApkPath: string | null;
  readonly keepDataUpdateVerdict: KeepDataUpdateVerdict;
}

export interface InstallInspectionResult {
  readonly device: DeviceIdentity;
  readonly target: ResolvedInstallTarget | null;
  readonly targetResolutionFailed: boolean;
  readonly targetResolutionErrorMessage: string | null;
  readonly helperPresentUnexpectedly: boolean;
  readonly readiness: DeviceReadinessResult;
  readonly packages: Record<ManagedPackageRole, ManagedPackageVersionSnapshot>;
  readonly detectedConflicts: readonly DetectedPackageConflict[];
  readonly hasDetectedConflicts: boolean;
  /** Advisory: installed apps that are neither Luma's, a conflict, nor stock. */
  readonly unrecognizedPackages: readonly string[];
  readonly actionState: InstallActionState;
  readonly installActionsBlocked: boolean;
  readonly installActionsBlockedReason: string | null;
}

function getTargetVersion(target: ResolvedInstallTarget | null): string | null {
  return target?.version ?? null;
}

function createPackageSnapshot(
  role: ManagedPackageRole,
  packageName: string,
  metadata: InstalledPackageMetadata | null,
  targetVersion: string | null,
  readiness: DeviceReadinessResult,
): ManagedPackageVersionSnapshot {
  const readinessEntry = readiness.packageResults.find((entry) => entry.packageName === packageName);
  const installed = metadata !== null;
  const versionReadable = metadata?.versionName != null;
  const versionComparison =
    installed && targetVersion
      ? classifyInstalledVersion(metadata?.versionName ?? null, targetVersion)
      : null;
  const appId = installed
    ? parseInstalledAppIdFromDumpsys(metadata?.rawOutput)
    : null;
  const baseApkPath = installed
    ? parseInstalledBaseApkPathFromDumpsys(metadata?.rawOutput)
    : null;

  return {
    role,
    packageName,
    installed,
    healthy: installed && (readinessEntry?.queryable ?? false),
    versionName: metadata?.versionName ?? null,
    signerIdentity: metadata?.signerIdentity ?? null,
    versionReadable,
    querySucceeded: metadata?.querySucceeded ?? false,
    rawOutput: metadata?.rawOutput ?? null,
    targetVersion: targetVersion ?? "unknown",
    versionComparison,
    appId,
    baseApkPath,
    // A package that is not installed is not something the installer will be
    // asked to update in place, so it is reported "eligible" rather than as a
    // problem. The decision skips absent packages for the same reason.
    keepDataUpdateVerdict: installed
      ? classifyKeepDataUpdate({
          packageName,
          appId,
          baseApkPath,
          versionName: metadata?.versionName ?? null,
          targetVersion,
        })
      : "eligible",
  };
}

export async function inspectInstallState(
  transport: AdbSessionTransport,
  options?: InspectInstallStateOptions,
): Promise<InstallInspectionResult> {
  const deviceTransport = createTimedAdbSessionTransport(transport);
  await waitForPackageManagerReady(deviceTransport);

  return inspectInstallStateAfterPackageManagerReady(deviceTransport, options);
}

export interface InspectInstallStateOptions {
  target?: ResolvedInstallTarget | null;
  targetResolutionError?: Error | null;
  readinessSettleDelayMs?: number;
  knownPackageConflicts?: readonly KnownPackageConflictDefinition[];
}

/**
 * Reads package state after the caller has completed the operation's one
 * bounded PackageManager readiness gate.
 */
export async function inspectInstallStateAfterPackageManagerReady(
  deviceTransport: AdbSessionTransport,
  options?: InspectInstallStateOptions,
): Promise<InstallInspectionResult> {
  const target = options?.target ?? null;
  const targetResolutionError = options?.targetResolutionError ?? null;
  const device = await getDeviceIdentity(deviceTransport);

  const [installerMetadata, hookMetadata, serverMetadata, loaderMetadata, helperMetadata, readiness, installedPackages] =
    await Promise.all([
      getInstalledPackageMetadata(deviceTransport, MANAGED_PACKAGES.installer),
      getInstalledPackageMetadata(deviceTransport, MANAGED_PACKAGES.hook),
      getInstalledPackageMetadata(deviceTransport, MANAGED_PACKAGES.server),
      getInstalledPackageMetadata(deviceTransport, MANAGED_PACKAGES.loader),
      getInstalledPackageMetadata(deviceTransport, MANAGED_PACKAGES.bootstrapHelper),
      inspectPackageQueryability(
        deviceTransport,
        [
          MANAGED_PACKAGES.installer,
          MANAGED_PACKAGES.hook,
          MANAGED_PACKAGES.server,
          MANAGED_PACKAGES.loader,
        ],
        options?.readinessSettleDelayMs,
      ),
      listInstalledPackages(deviceTransport),
    ]);

  const detectedConflicts = matchKnownPackageConflicts(
    installedPackages,
    options?.knownPackageConflicts,
  );
  const unrecognizedPackages = classifyUnrecognizedPackages(
    installedPackages,
    getDetectedConflictPackageIds(detectedConflicts),
  );

  const packages: Record<ManagedPackageRole, ManagedPackageVersionSnapshot> = {
    installer: createPackageSnapshot(
      "installer",
      MANAGED_PACKAGES.installer,
      installerMetadata,
      getTargetVersion(target),
      readiness,
    ),
    hook: createPackageSnapshot(
      "hook",
      MANAGED_PACKAGES.hook,
      hookMetadata,
      getTargetVersion(target),
      readiness,
    ),
    server: createPackageSnapshot(
      "server",
      MANAGED_PACKAGES.server,
      serverMetadata,
      getTargetVersion(target),
      readiness,
    ),
    loader: createPackageSnapshot(
      "loader",
      MANAGED_PACKAGES.loader,
      loaderMetadata,
      getTargetVersion(target),
      readiness,
    ),
  };

  const helperPresentUnexpectedly = helperMetadata !== null;
  const hasDetectedConflicts = detectedConflicts.length > 0;
  const actionState = deriveInstallActionState({
    packages,
    helperPresentUnexpectedly,
    readinessOk: readiness.packageQueryabilityOk,
  });

  const targetResolutionFailed = targetResolutionError !== null;
  const installActionsBlocked = targetResolutionFailed || target === null;
  const installActionsBlockedReason = installActionsBlocked
    ? targetResolutionError?.message ?? "Center couldn’t load a verified Pin release from your server."
    : null;

  return {
    device,
    target,
    targetResolutionFailed,
    targetResolutionErrorMessage: targetResolutionError?.message ?? null,
    helperPresentUnexpectedly,
    readiness,
    packages,
    detectedConflicts,
    hasDetectedConflicts,
    unrecognizedPackages,
    actionState,
    installActionsBlocked,
    installActionsBlockedReason,
  };
}
