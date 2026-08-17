import {
  createTimedAdbSessionTransport,
  packageExists,
  uninstallPackage,
  type AdbSessionTransport,
} from "../device";
import type { DetectedPackageConflict, KnownPackageConflictCleanupCommand } from "../domain/types";
import {
  createOperationProgressEvent,
  type OperationProgressEvent,
  type OperationWarning,
} from "./phases";

export interface RemoveConflictsOperationResult {
  readonly success: boolean;
  readonly warnings: readonly OperationWarning[];
  readonly error: Error | null;
  readonly removedPackageIds: readonly string[];
}

export interface RemoveConflictsOperationOptions {
  readonly transport: AdbSessionTransport;
  readonly conflicts: readonly DetectedPackageConflict[];
  readonly onProgress?: (event: OperationProgressEvent) => void;
}

export interface RemoveConflictsOperationInternals {
  uninstallPackage(transport: AdbSessionTransport, packageId: string): Promise<void>;
  packageExists(transport: AdbSessionTransport, packageId: string): Promise<boolean>;
  runCleanupCommand(
    transport: AdbSessionTransport,
    command: KnownPackageConflictCleanupCommand,
  ): Promise<{ success: boolean; message: string }>;
}

const defaultRemoveConflictsInternals: RemoveConflictsOperationInternals = {
  uninstallPackage,
  packageExists,
  async runCleanupCommand(transport, command) {
    const result = await transport.shell(command.argv);
    return {
      success: result.exitCode === 0,
      message:
        result.stderr.trim() ||
        result.stdout.trim() ||
        command.description ||
        command.argv.join(" "),
    };
  },
};

function emitProgress(
  onProgress: RemoveConflictsOperationOptions["onProgress"],
  options: {
    message: string;
    completed: number;
    total: number;
    logEntry?: boolean;
    overallOverridePercent?: number;
  },
) {
  onProgress?.(
    createOperationProgressEvent({
      phase: "Cleanup",
      message: options.message,
      phaseIndex: 0,
      phaseCount: 1,
      phaseCompleted: options.completed,
      phaseTotal: options.total,
      phaseUnitLabel: "step",
      logEntry: options.logEntry,
      overallOverridePercent: options.overallOverridePercent,
    }),
  );
}

function getConflictCleanupStepCount(conflict: DetectedPackageConflict) {
  return conflict.installedPackageIds.length + conflict.cleanupCommands.length;
}

function getTotalCleanupStepCount(conflicts: readonly DetectedPackageConflict[]) {
  return conflicts.reduce((total, conflict) => total + getConflictCleanupStepCount(conflict), 0);
}

export async function runRemoveConflictsOperation(
  options: RemoveConflictsOperationOptions,
  internals: RemoveConflictsOperationInternals = defaultRemoveConflictsInternals,
): Promise<RemoveConflictsOperationResult> {
  const deviceTransport = createTimedAdbSessionTransport(options.transport);
  let timedOut = false;

  const emitConflictProgress = (progressOptions: Parameters<typeof emitProgress>[1]) => {
    if (timedOut) {
      return;
    }
    emitProgress(options.onProgress, progressOptions);
  };

  const conflicts = options.conflicts.filter(
    (conflict) =>
      conflict.installedPackageIds.length > 0 || conflict.cleanupCommands.length > 0,
  );
  const removedPackageIds: string[] = [];
  const warnings: OperationWarning[] = [];
  const totalSteps = getTotalCleanupStepCount(conflicts);
  let completedSteps = 0;

  if (totalSteps === 0) {
    return {
      success: true,
      warnings,
      error: null,
      removedPackageIds,
    };
  }

  try {
    emitConflictProgress({
      message: "Conflict cleanup started.",
      completed: 0,
      total: totalSteps,
      logEntry: true,
    });

    for (const conflict of conflicts) {
      for (const packageId of conflict.installedPackageIds) {
        emitConflictProgress({
          message: `Removing ${packageId} from ${conflict.label}.`,
          completed: completedSteps,
          total: totalSteps,
          logEntry: true,
        });

        await internals.uninstallPackage(deviceTransport, packageId);

        if (await internals.packageExists(deviceTransport, packageId)) {
          throw new Error(`Known conflicting package ${packageId} is still present.`);
        }

        removedPackageIds.push(packageId);
        completedSteps += 1;
        emitConflictProgress({
          message: `Removed ${packageId}.`,
          completed: completedSteps,
          total: totalSteps,
          logEntry: true,
        });
      }

      for (const command of conflict.cleanupCommands) {
        emitConflictProgress({
          message: `Running cleanup for ${conflict.label}: ${command.description ?? command.argv.join(" ")}.`,
          completed: completedSteps,
          total: totalSteps,
          logEntry: true,
        });

        const result = await internals.runCleanupCommand(deviceTransport, command);
        completedSteps += 1;

        if (!result.success) {
          warnings.push({
            code: "conflict-cleanup-command-failed",
            message: `${conflict.label}: ${result.message}`,
          });
        }

        emitConflictProgress({
          message: result.success
            ? `Cleanup finished for ${conflict.label}.`
            : `Cleanup warning for ${conflict.label}: ${result.message}`,
          completed: completedSteps,
          total: totalSteps,
          logEntry: true,
        });
      }
    }

    emitConflictProgress({
      message: "Conflict cleanup complete.",
      completed: totalSteps,
      total: totalSteps,
      logEntry: true,
      overallOverridePercent: 100,
    });

    return {
      success: true,
      warnings,
      error: null,
      removedPackageIds,
    };
  } catch (error) {
    timedOut = true;
    return {
      success: false,
      warnings,
      error: error instanceof Error ? error : new Error(String(error)),
      removedPackageIds,
    };
  }
}
