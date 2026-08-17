import {
  createTimedAdbSessionTransport,
  type AdbSessionTransport,
} from "../device";
import {
  ROLLBACK_OPERATION_PHASES,
  createOperationProgressEvent,
  type OperationProgressEvent,
  type OperationWarning,
} from "./phases";
import {
  cleanupManagedPackages,
  restoreConfiguredPackages,
  verifyUninstalledManagedState,
} from "./shared";

export interface RollbackOperationResult {
  readonly success: boolean;
  readonly warnings: readonly OperationWarning[];
  readonly error: Error | null;
}

export interface RollbackOperationOptions {
  readonly transport: AdbSessionTransport;
  readonly onProgress?: (event: OperationProgressEvent) => void;
}

export interface RollbackOperationInternals {
  cleanupManagedPackages(transport: AdbSessionTransport): Promise<void>;
  restoreConfiguredPackages(transport: AdbSessionTransport): Promise<OperationWarning[]>;
  verifyUninstalledManagedState(transport: AdbSessionTransport): Promise<void>;
}

const defaultRollbackInternals: RollbackOperationInternals = {
  cleanupManagedPackages,
  restoreConfiguredPackages,
  verifyUninstalledManagedState,
};

function emitPhaseProgress(
  onProgress: RollbackOperationOptions["onProgress"],
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
      phaseCount: ROLLBACK_OPERATION_PHASES.length,
      phaseCompleted: options.phaseCompleted,
      phaseTotal: options.phaseTotal,
      phaseUnitLabel: options.phaseUnitLabel,
      logEntry: options.logEntry,
      overallOverridePercent: options.overallOverridePercent,
    }),
  );
}

export async function runRollbackOperation(
  options: RollbackOperationOptions,
  internals: RollbackOperationInternals = defaultRollbackInternals,
): Promise<RollbackOperationResult> {
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
      phase: "Cleanup",
      message: "Rollback cleanup started.",
      phaseIndex: 0,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });
    await internals.cleanupManagedPackages(deviceTransport);
    emitProgress({
      phase: "Cleanup",
      message: "Rollback cleanup finished.",
      phaseIndex: 0,
      phaseCompleted: 1,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });

    emitProgress({
      phase: "Restore",
      message: "Rollback restore started.",
      phaseIndex: 1,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });
    warnings.push(...(await internals.restoreConfiguredPackages(deviceTransport)));
    emitProgress({
      phase: "Restore",
      message: "Rollback restore finished.",
      phaseIndex: 1,
      phaseCompleted: 1,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });

    emitProgress({
      phase: "Verify",
      message: "Rollback verify started.",
      phaseIndex: 2,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      logEntry: true,
    });
    await internals.verifyUninstalledManagedState(deviceTransport);
    emitProgress({
      phase: "Verify",
      message: "Rollback verification complete.",
      phaseIndex: 2,
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
