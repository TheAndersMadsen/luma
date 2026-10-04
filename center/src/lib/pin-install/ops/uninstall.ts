import {
  clearCosmosIdentity,
  CosmosIdentityRefusedError,
  CosmosIdentityUnavailableError,
  createTimedAdbSessionTransport,
  deactivateCosmosIdentity,
  waitForPackageManagerReady,
  type AdbSessionTransport,
  type CosmosIdentityCallResult,
} from "../device";
import {
  UNINSTALL_OPERATION_PHASES,
  createOperationProgressEvent,
  type OperationProgressEvent,
  type OperationWarning,
} from "./phases";
import {
  cleanupManagedPackages,
  restoreConfiguredPackages,
  verifyUninstalledManagedState,
} from "./shared";

export interface UninstallOperationResult {
  readonly success: boolean;
  readonly warnings: readonly OperationWarning[];
  readonly error: Error | null;
}

export interface UninstallOperationOptions {
  readonly transport: AdbSessionTransport;
  readonly onProgress?: (event: OperationProgressEvent) => void;
}

export interface UninstallOperationInternals {
  waitForPackageManagerReady(transport: AdbSessionTransport): Promise<void>;
  deactivateCosmosIdentity(
    transport: AdbSessionTransport,
  ): Promise<CosmosIdentityCallResult>;
  clearCosmosIdentity(
    transport: AdbSessionTransport,
  ): Promise<CosmosIdentityCallResult>;
  cleanupManagedPackages(transport: AdbSessionTransport): Promise<void>;
  restoreConfiguredPackages(transport: AdbSessionTransport): Promise<OperationWarning[]>;
  verifyUninstalledManagedState(transport: AdbSessionTransport): Promise<void>;
}

const defaultUninstallInternals: UninstallOperationInternals = {
  waitForPackageManagerReady,
  deactivateCosmosIdentity,
  clearCosmosIdentity,
  cleanupManagedPackages,
  restoreConfiguredPackages,
  verifyUninstalledManagedState,
};

function isCosmosIdentityError(
  error: unknown,
): error is CosmosIdentityUnavailableError | CosmosIdentityRefusedError {
  return (
    error instanceof CosmosIdentityUnavailableError ||
    error instanceof CosmosIdentityRefusedError
  );
}

function emitPhaseProgress(
  onProgress: UninstallOperationOptions["onProgress"],
  options: {
    phase: OperationProgressEvent["phase"];
    message: string;
    phaseIndex: number;
    phaseCompleted: number;
    phaseTotal: number;
    phaseUnitLabel: string;
    logEntry?: boolean;
    overallOverridePercent?: number;
  },
) {
  onProgress?.(
    createOperationProgressEvent({
      phase: options.phase,
      message: options.message,
      phaseIndex: options.phaseIndex,
      phaseCount: UNINSTALL_OPERATION_PHASES.length,
      phaseCompleted: options.phaseCompleted,
      phaseTotal: options.phaseTotal,
      phaseUnitLabel: options.phaseUnitLabel,
      logEntry: options.logEntry,
      overallOverridePercent: options.overallOverridePercent,
    }),
  );
}

export async function runUninstallOperation(
  options: UninstallOperationOptions,
  internals: UninstallOperationInternals = defaultUninstallInternals,
): Promise<UninstallOperationResult> {
  const warnings: OperationWarning[] = [];
  const deviceTransport = createTimedAdbSessionTransport(options.transport);
  let timedOut = false;

  const emitProgress = (progressOptions: Parameters<typeof emitPhaseProgress>[1]) => {
    if (timedOut) {
      return;
    }
    emitPhaseProgress(options.onProgress, progressOptions);
  };

  try {
    emitProgress({
      phase: "Deactivate",
      message: "Waiting for Android package services before uninstall.",
      phaseIndex: 0,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });
    await internals.waitForPackageManagerReady(deviceTransport);

    // The identity provider lives in the server APK, so the Cosmos identity is
    // deactivated before cleanupManagedPackages uninstalls the package that
    // answers these calls.
    try {
      const deactivation = await internals.deactivateCosmosIdentity(deviceTransport);
      emitProgress({
        phase: "Deactivate",
        message: "Removed this Pin's connection to your server.",
        phaseIndex: 0,
        phaseCompleted: 1,
        phaseTotal: 2,
        phaseUnitLabel: "step",
        logEntry: true,
      });
      if (!deactivation.rollbackComplete) {
        warnings.push({
          code: "identity-deactivate-failed",
          message:
            "The Pin could not restore its previous settings while deactivating; its assistant may need a repair.",
        });
      }
      try {
        await internals.clearCosmosIdentity(deviceTransport);
        emitProgress({
          phase: "Deactivate",
          message:
            "Removed this Pin's connection to your server and its leftover identity.",
          phaseIndex: 0,
          phaseCompleted: 2,
          phaseTotal: 2,
          phaseUnitLabel: "step",
          logEntry: true,
        });
      } catch (error) {
        if (!isCosmosIdentityError(error)) {
          throw error;
        }
        warnings.push({
          code: "identity-clear-failed",
          message: error.message,
        });
      }
    } catch (error) {
      if (!isCosmosIdentityError(error)) {
        throw error;
      }
      warnings.push({
        code: "identity-deactivate-failed",
        message: error.message,
      });
    }

    emitProgress({
      phase: "Cleanup",
      message: "Uninstall cleanup started.",
      phaseIndex: 1,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });
    await internals.cleanupManagedPackages(deviceTransport);
    emitProgress({
      phase: "Cleanup",
      message: "Managed package cleanup finished.",
      phaseIndex: 1,
      phaseCompleted: 1,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });

    emitProgress({
      phase: "Restore",
      message: "Restore of stock/system packages started.",
      phaseIndex: 2,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });
    warnings.push(...(await internals.restoreConfiguredPackages(deviceTransport)));
    emitProgress({
      phase: "Restore",
      message: "Configured stock/system package restore finished.",
      phaseIndex: 2,
      phaseCompleted: 1,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });

    emitProgress({
      phase: "Verify",
      message: "Uninstall verification started.",
      phaseIndex: 3,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });
    await internals.verifyUninstalledManagedState(deviceTransport);
    emitProgress({
      phase: "Verify",
      message: "Uninstall verification complete.",
      phaseIndex: 3,
      phaseCompleted: 1,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
      overallOverridePercent: 100,
    });

    return {
      success: true,
      warnings,
      error: null,
    };
  } catch (error) {
    timedOut = true;
    return {
      success: false,
      warnings,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
