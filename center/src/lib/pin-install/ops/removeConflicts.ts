import {
  AdbDeviceStepTimeoutError,
  createTimedAdbSessionTransport,
  packageExists,
  setHomeActivity,
  shellCommand,
  uninstallPackage,
  waitForBootCompleted,
  waitForPackageManagerReady,
  type AdbSessionTransport,
} from "../device";
import type { DetectedPackageConflict, KnownPackageConflictCleanupCommand } from "../domain/types";
import { PREINSTALL_CLEANUP_COMMANDS } from "../domain/knownPackageConflicts";
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

export interface RemovePackagesOperationResult {
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

export interface RemovePackagesOperationOptions {
  readonly transport: AdbSessionTransport;
  readonly packageIds: readonly string[];
  readonly onProgress?: (event: OperationProgressEvent) => void;
}

interface PackageRemovalInternals {
  waitForPackageManagerReady(transport: AdbSessionTransport): Promise<void>;
  uninstallPackage(transport: AdbSessionTransport, packageId: string): Promise<void>;
  packageExists(transport: AdbSessionTransport, packageId: string): Promise<boolean>;
}

export interface RemoveConflictsOperationInternals extends PackageRemovalInternals {
  runCleanupCommand(
    transport: AdbSessionTransport,
    command: KnownPackageConflictCleanupCommand,
  ): Promise<{ success: boolean; message: string }>;
  runPreinstallCleanupCommand(
    transport: AdbSessionTransport,
    command: KnownPackageConflictCleanupCommand,
  ): Promise<{ success: boolean; message: string }>;
  setHomeActivity(transport: AdbSessionTransport): Promise<void>;
  removeConflictFilePaths(
    transport: AdbSessionTransport,
    paths: readonly string[],
  ): Promise<void>;
  waitForBootCompleted(transport: AdbSessionTransport): Promise<void>;
}

export type RemovePackagesOperationInternals = PackageRemovalInternals;

async function runCleanupShellCommand(
  transport: AdbSessionTransport,
  command: KnownPackageConflictCleanupCommand,
): Promise<{ success: boolean; message: string }> {
  const result = await transport.shell(command.argv);
  return {
    success: result.exitCode === 0,
    message:
      result.stderr.trim() ||
      result.stdout.trim() ||
      command.description ||
      command.argv.join(" "),
  };
}

const defaultRemoveConflictsInternals: RemoveConflictsOperationInternals = {
  waitForPackageManagerReady,
  uninstallPackage,
  packageExists,
  runCleanupCommand: runCleanupShellCommand,
  runPreinstallCleanupCommand: runCleanupShellCommand,
  setHomeActivity,
  async removeConflictFilePaths(transport, paths) {
    await transport.shell(shellCommand(["rm", "-rf", ...paths]));
  },
  waitForBootCompleted,
};

function emitProgress(
  onProgress:
    | RemoveConflictsOperationOptions["onProgress"]
    | RemovePackagesOperationOptions["onProgress"],
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
  return (
    conflict.installedPackageIds.length +
    (conflict.cleanupFilePaths?.length ? 1 : 0) +
    conflict.cleanupCommands.length
  );
}

function getTotalCleanupStepCount(conflicts: readonly DetectedPackageConflict[]) {
  return conflicts.reduce((total, conflict) => total + getConflictCleanupStepCount(conflict), 0);
}

/**
 * The conflict flow reboots the Pin, so after the last cleanup command the
 * operation waits out the boot and the package manager itself. The follow-on
 * install only gets one bounded readiness gate of its own; handing it a Pin
 * that is still starting was the failure class BATCH_INSTALL_TIMEOUT_MS
 * documents (see systemInstaller.ts).
 */
const POST_CONFLICT_STEP_COUNT = PREINSTALL_CLEANUP_COMMANDS.length + 3;

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
      conflict.installedPackageIds.length > 0 ||
      (conflict.cleanupFilePaths?.length ?? 0) > 0 ||
      conflict.cleanupCommands.length > 0,
  );
  const removedPackageIds: string[] = [];
  const warnings: OperationWarning[] = [];
  const totalSteps = getTotalCleanupStepCount(conflicts) + POST_CONFLICT_STEP_COUNT;
  let completedSteps = 0;

  if (getTotalCleanupStepCount(conflicts) === 0) {
    return {
      success: true,
      warnings,
      error: null,
      removedPackageIds,
    };
  }

  try {
    emitConflictProgress({
      message: "Waiting for Android package services before conflict cleanup.",
      completed: 0,
      total: totalSteps,
      logEntry: true,
    });
    await internals.waitForPackageManagerReady(deviceTransport);

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

      if (conflict.cleanupFilePaths?.length) {
        emitConflictProgress({
          message: `Removing ${conflict.label}'s leftover files.`,
          completed: completedSteps,
          total: totalSteps,
          logEntry: true,
        });
        let filesRemoved = true;
        try {
          await internals.removeConflictFilePaths(
            deviceTransport,
            conflict.cleanupFilePaths,
          );
        } catch (error) {
          // A wedged device is not a warning; stop the operation.
          if (error instanceof AdbDeviceStepTimeoutError) throw error;
          filesRemoved = false;
          warnings.push({
            code: "conflict-file-cleanup-failed",
            message:
              error instanceof Error ? error.message : String(error),
          });
        }
        completedSteps += 1;
        emitConflictProgress({
          message: filesRemoved
            ? `Removed ${conflict.label}'s leftover files.`
            : `${conflict.label}'s leftover files could not be removed.`,
          completed: completedSteps,
          total: totalSteps,
          logEntry: true,
        });
      }
    }

    // Before the reboot commands: an interrupted run must never leave the Pin
    // without its launcher (PenumbraOS v0's MABL was the launcher and is now
    // uninstalled), so the stock launcher and system apps go back on first.
    for (const command of PREINSTALL_CLEANUP_COMMANDS) {
      emitConflictProgress({
        message: `Restoring the stock launcher and system apps: ${command.description ?? command.argv.join(" ")}.`,
        completed: completedSteps,
        total: totalSteps,
        logEntry: true,
      });

      const result = await internals.runPreinstallCleanupCommand(
        deviceTransport,
        command,
      );
      completedSteps += 1;

      if (!result.success) {
        warnings.push({
          code: "conflict-cleanup-command-failed",
          message: result.message,
        });
      }

      emitConflictProgress({
        message: result.success
          ? `Restored ${command.description ?? command.argv.join(" ")}.`
          : `Restore warning: ${result.message}`,
        completed: completedSteps,
        total: totalSteps,
        logEntry: true,
      });
    }

    emitConflictProgress({
      message: "Setting the stock launcher.",
      completed: completedSteps,
      total: totalSteps,
      logEntry: true,
    });
    try {
      await internals.setHomeActivity(deviceTransport);
    } catch (error) {
      if (error instanceof AdbDeviceStepTimeoutError) throw error;
      warnings.push({
        code: "conflict-cleanup-command-failed",
        message: `Could not set the stock launcher. ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    completedSteps += 1;

    for (const conflict of conflicts) {
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
      message: "Waiting for the Pin to finish starting.",
      completed: completedSteps,
      total: totalSteps,
      logEntry: true,
    });
    await internals.waitForBootCompleted(deviceTransport);
    completedSteps += 1;
    await internals.waitForPackageManagerReady(deviceTransport);
    completedSteps += 1;
    emitConflictProgress({
      message: "The Pin is ready.",
      completed: completedSteps,
      total: totalSteps,
      logEntry: true,
    });

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

/**
 * Removes the exact packages the wearer confirmed, one confirmed list, no
 * pattern matching of its own. The survive-own-uninstall rule is the conflict
 * flow's: an uninstall the device does not confirm fails the operation.
 */
export async function runRemovePackagesOperation(
  options: RemovePackagesOperationOptions,
  internals: RemovePackagesOperationInternals = defaultRemoveConflictsInternals,
): Promise<RemovePackagesOperationResult> {
  const deviceTransport = createTimedAdbSessionTransport(options.transport);
  let timedOut = false;

  const emitRemovalProgress = (progressOptions: Parameters<typeof emitProgress>[1]) => {
    if (timedOut) {
      return;
    }
    emitProgress(options.onProgress, progressOptions);
  };

  const removedPackageIds: string[] = [];
  const totalSteps = options.packageIds.length;
  let completedSteps = 0;

  if (totalSteps === 0) {
    return {
      success: true,
      warnings: [],
      error: null,
      removedPackageIds,
    };
  }

  try {
    emitRemovalProgress({
      message: "Waiting for Android package services before app removal.",
      completed: 0,
      total: totalSteps,
      logEntry: true,
    });
    await internals.waitForPackageManagerReady(deviceTransport);

    for (const packageId of options.packageIds) {
      emitRemovalProgress({
        message: `Removing ${packageId}.`,
        completed: completedSteps,
        total: totalSteps,
        logEntry: true,
      });

      await internals.uninstallPackage(deviceTransport, packageId);

      if (await internals.packageExists(deviceTransport, packageId)) {
        throw new Error(`Package ${packageId} is still present.`);
      }

      removedPackageIds.push(packageId);
      completedSteps += 1;
      emitRemovalProgress({
        message: `Removed ${packageId}.`,
        completed: completedSteps,
        total: totalSteps,
        logEntry: true,
      });
    }

    emitRemovalProgress({
      message: "Unrecognized app removal complete.",
      completed: totalSteps,
      total: totalSteps,
      logEntry: true,
      overallOverridePercent: 100,
    });

    return {
      success: true,
      warnings: [],
      error: null,
      removedPackageIds,
    };
  } catch (error) {
    timedOut = true;
    return {
      success: false,
      warnings: [],
      error: error instanceof Error ? error : new Error(String(error)),
      removedPackageIds,
    };
  }
}
