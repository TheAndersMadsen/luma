import { MANAGED_PACKAGES } from "../domain/managedPackages";
import type { ManagedPackageRole } from "../domain/types";
import type { DownloadedInstallAssetRole } from "../releases/assets";
import { PACKAGE_SETS } from "../generated/tier-a-symbols";

export const INSTALL_OPERATION_PHASES = [
  "Assets",
  "Cleanup",
  "Installer",
  "Install",
  "Disable",
  "Configure",
  "Verify",
] as const;

export const UNINSTALL_OPERATION_PHASES = [
  "Cleanup",
  "Restore",
  "Verify",
] as const;

export type InstallOperationPhase = (typeof INSTALL_OPERATION_PHASES)[number];
export type UninstallOperationPhase =
  (typeof UNINSTALL_OPERATION_PHASES)[number];

export type OperationWarningCode =
  | "disable-failed"
  | "restore-failed"
  | "conflict-cleanup-command-failed"
  | "preinstall-cleanup-command-failed";

export interface OperationWarning {
  readonly code: OperationWarningCode;
  readonly message: string;
  readonly packageName?: string;
}

export interface OperationProgressBytes {
  readonly loaded: number;
  readonly total: number | null;
}

export interface OperationProgressEvent {
  readonly phase: InstallOperationPhase | UninstallOperationPhase;
  readonly message: string;
  readonly overallPercent: number;
  readonly phasePercent: number;
  readonly phaseCompleted: number;
  readonly phaseTotal: number;
  readonly phaseUnitLabel: string;
  readonly bytes?: OperationProgressBytes | null;
  readonly logEntry?: boolean;
}

export interface CreateOperationProgressEventOptions {
  readonly phase: OperationProgressEvent["phase"];
  readonly message: string;
  readonly phaseIndex: number;
  readonly phaseCount: number;
  readonly phaseCompleted: number;
  readonly phaseTotal: number;
  readonly phaseUnitLabel: string;
  readonly bytes?: OperationProgressBytes | null;
  readonly logEntry?: boolean;
  readonly overallOverridePercent?: number;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function createOperationProgressEvent(
  options: CreateOperationProgressEventOptions,
): OperationProgressEvent {
  const safePhaseTotal = options.phaseTotal > 0 ? options.phaseTotal : 1;
  const phaseFraction = Math.max(
    0,
    Math.min(1, options.phaseCompleted / safePhaseTotal),
  );
  const computedOverall =
    ((options.phaseIndex + phaseFraction) / Math.max(options.phaseCount, 1)) *
    100;

  return {
    phase: options.phase,
    message: options.message,
    overallPercent: clampPercent(
      options.overallOverridePercent ?? computedOverall,
    ),
    phasePercent: clampPercent(phaseFraction * 100),
    phaseCompleted: options.phaseCompleted,
    phaseTotal: safePhaseTotal,
    phaseUnitLabel: options.phaseUnitLabel,
    bytes: options.bytes ?? null,
    logEntry: options.logEntry,
  };
}

export const MANAGED_CLEANUP_ORDER = [
  MANAGED_PACKAGES.loader,
  MANAGED_PACKAGES.server,
  MANAGED_PACKAGES.hook,
  MANAGED_PACKAGES.installer,
  MANAGED_PACKAGES.bootstrapHelper,
] as const;

export const INSTALL_PACKAGE_ORDER = [
  {
    role: "hook",
    packageName: MANAGED_PACKAGES.hook,
    fileName: "hook.apk",
    assetKey: "hookApk",
    waitForNextInstallProviderReady: true,
  },
  {
    role: "server",
    packageName: MANAGED_PACKAGES.server,
    fileName: "server.apk",
    assetKey: "serverApk",
    waitForNextInstallProviderReady: true,
  },
  {
    role: "loader",
    packageName: MANAGED_PACKAGES.loader,
    fileName: "injector.apk",
    assetKey: "loaderApk",
    waitForNextInstallProviderReady: false,
  },
] as const satisfies readonly {
  readonly role: ManagedPackageRole;
  readonly packageName: string;
  readonly fileName: string;
  readonly assetKey: DownloadedInstallAssetRole;
  readonly waitForNextInstallProviderReady: boolean;
}[];

export const DEFAULT_DISABLE_PACKAGES = PACKAGE_SETS.center_vendor_packages;
