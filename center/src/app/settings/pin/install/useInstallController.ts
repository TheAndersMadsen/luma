"use client";

/**
 * The install controller — ported from the retired Setup SPA's
 * `install/app/useInstallController.ts`.
 *
 * The controller connects, locks a release target, runs one mutation pipeline,
 * streams progress, then reconciles state once. It never starts an inspection
 * from a progress callback while package work is still running.
 *
 * ONE structural change, and it is the reason this file exists rather than a
 * verbatim copy: the ADB session is INJECTED. The SPA's controller built its own
 * `WebUsbAdbSessionTransport` via `createTransport()`, disposed it in an unmount
 * effect and again in `startOver()`. In Center the installer shares a device
 * with the configuration panes, and unmounting on navigation must not unplug the
 * Pin, so the session comes from `@/lib/pin-session` and this hook never owns
 * it. Releasing the device is an explicit user action routed through
 * `releaseDevice`, which is `startOver`'s only remaining side effect on the
 * connection.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  AdbDeviceStepTimeoutError,
  getBrowserSupport,
  type AdbSessionTransport,
} from "@/lib/pin-device/adb";
import {
  createInitialInstallControllerState,
  deriveInstallControllerCommands,
  getLockedTarget,
  inspectInstallState,
  installControllerReducer,
  lockResolvedInstallTarget,
  resolveInstallTarget,
  runInstallOperation,
  runRemoveConflictsOperation,
  runUninstallOperation,
  type ControllerOperationResult,
  type InstallControllerCommands,
  type InstallControllerState,
  type InstallInspectionResult,
  type OperationProgressEvent,
  type ResolvedInstallTarget,
  type TargetLock,
} from "@/lib/pin-install";
import { runInstallApkFileOperation } from "./runInstallApkFile";

export type {
  ControllerOperationResult,
  InstallControllerCommands,
  InstallControllerStage,
  InstallControllerState,
} from "@/lib/pin-install";

export interface InstallController {
  readonly state: InstallControllerState;
  readonly commands: InstallControllerCommands;
  connectAndInspect(): Promise<void>;
  recheck(): Promise<void>;
  runPrimaryAction(options?: {
    readonly bootstrapRecoveryConfirmed?: boolean;
  }): Promise<void>;
  runInstallApkFile(): Promise<void>;
  runUninstall(): Promise<void>;
  runRemoveConflicts(): Promise<void>;
  runFixConflictsThenPrimaryAction(options?: {
    readonly bootstrapRecoveryConfirmed?: boolean;
  }): Promise<void>;
  getLogcatContent(): Promise<string>;
  startOver(): Promise<void>;
}

export interface UseInstallControllerOptions {
  /**
   * The shared ADB session. Created but not connected by the caller; this hook
   * calls `connect()` from the user's click on "Connect Device".
   */
  readonly session: AdbSessionTransport;
  /**
   * Release the physical device. Called only by `startOver()`. Omit and the
   * installer resets its own state while leaving the device attached.
   */
  readonly releaseDevice?: () => Promise<void>;
}

/**
 * Warn before a tab close that would abandon a half-written device.
 *
 * Ported from the retired Setup SPA's `hooks/useBeforeUnload.ts`. Kept local
 * rather than promoted to a Center primitive so this pane owns its own
 * guarantee; the planned `UnsavedChangesPrompt` primitive can absorb it later
 * without changing behaviour here.
 */
function useBeforeUnload(when: boolean) {
  useEffect(() => {
    if (!when) {
      return undefined;
    }

    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [when]);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDeviceStepTimeoutError(
  error: unknown,
): error is AdbDeviceStepTimeoutError {
  return error instanceof AdbDeviceStepTimeoutError;
}

function getInspectionTargetResolutionError(
  inspection: InstallInspectionResult | null,
): Error | null {
  if (!inspection?.targetResolutionErrorMessage) {
    return null;
  }

  return new Error(inspection.targetResolutionErrorMessage);
}

function getActiveTarget(
  state: InstallControllerState,
): ResolvedInstallTarget | null {
  return getLockedTarget(state.targetLock) ?? state.target;
}

function isTimedOutOperationError(error: unknown) {
  return isDeviceStepTimeoutError(error);
}

function isPackageReadinessError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Android's package service")
  );
}

async function resolvePostOperationInspection<
  Result extends { readonly error: Error | null },
>(
  result: Result,
  loadInspection: () => Promise<InstallInspectionResult | null>,
) {
  if (
    isTimedOutOperationError(result.error) ||
    isPackageReadinessError(result.error)
  ) {
    return null;
  }

  return loadInspection();
}

function createProgressDispatcher(options: {
  onDispatch: (event: OperationProgressEvent) => void;
  mapEvent?: (event: OperationProgressEvent) => OperationProgressEvent;
}) {
  let timedOut = false;

  return {
    markTimedOut(error: unknown) {
      timedOut = timedOut || isTimedOutOperationError(error);
    },
    onProgress(event: OperationProgressEvent) {
      if (timedOut) {
        return;
      }

      options.onDispatch(options.mapEvent ? options.mapEvent(event) : event);
    },
  };
}

export function useInstallController(
  options: UseInstallControllerOptions,
): InstallController {
  const { session, releaseDevice } = options;
  const sessionRef = useRef(session);
  const releaseDeviceRef = useRef(releaseDevice);
  const browserSupport = useMemo(() => getBrowserSupport(), []);
  const [state, dispatch] = useReducer(
    installControllerReducer,
    browserSupport,
    createInitialInstallControllerState,
  );
  const stateRef = useRef(state);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    releaseDeviceRef.current = releaseDevice;
  }, [releaseDevice]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /**
   * Replaces the SPA's `ensureTransport()`. The session is never created here
   * and never disposed here — only borrowed.
   */
  const ensureTransport = useCallback(() => sessionRef.current, []);

  const refreshInspection = useCallback(
    async (
      transport: AdbSessionTransport,
      inspectionOptions: {
        target: ResolvedInstallTarget | null;
        targetResolutionError?: Error | null;
      },
    ) => {
      return inspectInstallState(transport, {
        target: inspectionOptions.target,
        targetResolutionError: inspectionOptions.targetResolutionError ?? null,
        readinessSettleDelayMs: 0,
      });
    },
    [],
  );

  const runInspection = useCallback(
    async (inspectionOptions?: {
      stage?: "connecting" | "inspecting";
      forceTargetRefresh?: boolean;
    }) => {
      const transport = ensureTransport();
      const currentState = stateRef.current;
      const stage = inspectionOptions?.stage ?? "inspecting";
      const forceTargetRefresh = inspectionOptions?.forceTargetRefresh ?? false;

      dispatch({
        type: "inspection-started",
        stage,
      });

      try {
        const connection = await transport.connect();
        dispatch({
          type: "connection-established",
          connection,
        });

        let target: ResolvedInstallTarget | null = forceTargetRefresh
          ? null
          : getActiveTarget(currentState);
        let targetLock: TargetLock | null = forceTargetRefresh
          ? null
          : currentState.targetLock;
        let targetResolutionError: Error | null = null;

        if (!target) {
          try {
            target = await resolveInstallTarget();
            targetLock = lockResolvedInstallTarget(target);
          } catch (error) {
            target = null;
            targetLock = null;
            targetResolutionError =
              error instanceof Error ? error : new Error(String(error));
          }
        }

        const inspection = await refreshInspection(transport, {
          target,
          targetResolutionError,
        });

        dispatch({
          type: "inspection-completed",
          connection,
          inspection,
          target,
          targetLock,
        });
      } catch (error) {
        dispatch({
          type: "inspection-failed",
          connection: transport.connectionInfo,
          error: toErrorMessage(error),
        });
      }
    },
    [ensureTransport, refreshInspection],
  );

  const connectAndInspect = useCallback(async () => {
    if (!browserSupport.supported) {
      return;
    }

    await runInspection({
      stage: "connecting",
      forceTargetRefresh: false,
    });
  }, [browserSupport.supported, runInspection]);

  const recheck = useCallback(async () => {
    await runInspection({
      stage: "inspecting",
      forceTargetRefresh: true,
    });
  }, [runInspection]);

  const runPrimaryAction = useCallback(
    async (operationOptions?: {
      readonly bootstrapRecoveryConfirmed?: boolean;
    }) => {
      const transport = ensureTransport();
      const currentState = stateRef.current;
      const activeTarget = getActiveTarget(currentState);

      if (!activeTarget) {
        dispatch({
          type: "operation-failed",
          error:
            "Install-type actions are blocked until the installer can resolve a release target.",
        });
        return;
      }

      dispatch({ type: "operation-started" });

      try {
        const progress = createProgressDispatcher({
          onDispatch: (event) => {
            dispatch({
              type: "operation-progress",
              event,
            });
          },
        });

        const result = await runInstallOperation({
          transport,
          target: activeTarget,
          inspection: currentState.inspection,
          bootstrapRecoveryConfirmed:
            operationOptions?.bootstrapRecoveryConfirmed,
          onProgress: progress.onProgress,
        });

        progress.markTimedOut(result.error);

        const nextInspection = await resolvePostOperationInspection(
          result,
          async () => {
            if (result.inspection) {
              return result.inspection;
            }

            return refreshInspection(transport, {
              target: activeTarget,
            });
          },
        );

        const operationResult: ControllerOperationResult = {
          kind: "install",
          result,
        };

        dispatch({
          type: "operation-completed",
          result: operationResult,
          inspection: nextInspection,
        });
      } catch (error) {
        dispatch({
          type: "operation-failed",
          error: toErrorMessage(error),
        });
      }
    },
    [ensureTransport, refreshInspection],
  );

  const runInstallApkFile = useCallback(async () => {
    await runInstallApkFileOperation({
      transport: ensureTransport(),
      currentState: stateRef.current,
      dispatch,
      refreshInspection,
      toErrorMessage,
      getActiveTarget,
      getInspectionTargetResolutionError,
    });
  }, [ensureTransport, refreshInspection]);

  const runUninstall = useCallback(async () => {
    const transport = ensureTransport();
    const currentState = stateRef.current;
    const progress = createProgressDispatcher({
      onDispatch: (event) => {
        dispatch({
          type: "operation-progress",
          event,
        });
      },
    });

    dispatch({ type: "operation-started" });

    try {
      const result = await runUninstallOperation({
        transport,
        onProgress: progress.onProgress,
      });

      progress.markTimedOut(result.error);
      const nextInspection = await resolvePostOperationInspection(result, () =>
        refreshInspection(transport, {
          target: getActiveTarget(currentState),
          targetResolutionError: getInspectionTargetResolutionError(
            currentState.inspection,
          ),
        }),
      );

      const operationResult: ControllerOperationResult = {
        kind: "uninstall",
        result,
      };

      dispatch({
        type: "operation-completed",
        result: operationResult,
        inspection: nextInspection,
      });
    } catch (error) {
      dispatch({
        type: "operation-failed",
        error: toErrorMessage(error),
      });
    }
  }, [ensureTransport, refreshInspection]);

  const runRemoveConflicts = useCallback(async () => {
    const transport = ensureTransport();
    const currentState = stateRef.current;
    const detectedConflicts = currentState.inspection?.detectedConflicts ?? [];
    const hasConflictCleanupWork = detectedConflicts.some(
      (conflict) =>
        conflict.installedPackageIds.length > 0 ||
        conflict.cleanupCommands.length > 0,
    );
    const progress = createProgressDispatcher({
      onDispatch: (event) => {
        dispatch({
          type: "operation-progress",
          event,
        });
      },
    });

    if (!hasConflictCleanupWork) {
      return;
    }

    dispatch({ type: "operation-started" });

    try {
      const result = await runRemoveConflictsOperation({
        transport,
        conflicts: detectedConflicts,
        onProgress: progress.onProgress,
      });

      progress.markTimedOut(result.error);
      const nextInspection = await resolvePostOperationInspection(result, () =>
        refreshInspection(transport, {
          target: getActiveTarget(currentState),
          targetResolutionError: getInspectionTargetResolutionError(
            currentState.inspection,
          ),
        }),
      );

      const operationResult: ControllerOperationResult = {
        kind: "remove-conflicts",
        result,
      };

      dispatch({
        type: "operation-completed",
        result: operationResult,
        inspection: nextInspection,
      });
    } catch (error) {
      dispatch({
        type: "operation-failed",
        error: toErrorMessage(error),
      });
    }
  }, [ensureTransport, refreshInspection]);

  const runFixConflictsThenPrimaryAction = useCallback(
    async (operationOptions?: {
      readonly bootstrapRecoveryConfirmed?: boolean;
    }) => {
      const transport = ensureTransport();
      const currentState = stateRef.current;
      const activeTarget = getActiveTarget(currentState);
      const detectedConflicts = currentState.inspection?.detectedConflicts ?? [];
      const hasConflictCleanupWork = detectedConflicts.some(
        (conflict) =>
          conflict.installedPackageIds.length > 0 ||
          conflict.cleanupCommands.length > 0,
      );

      if (!activeTarget) {
        dispatch({
          type: "operation-failed",
          error:
            "Install-type actions are blocked until the installer can resolve a release target.",
        });
        return;
      }

      if (!hasConflictCleanupWork) {
        await runPrimaryAction(operationOptions);
        return;
      }

      dispatch({ type: "operation-started" });

      try {
        const conflictProgress = createProgressDispatcher({
          onDispatch: (event) => {
            dispatch({
              type: "operation-progress",
              event: {
                ...event,
                overallPercent: Math.round(event.overallPercent * 0.15),
              },
            });
          },
        });
        const installProgress = createProgressDispatcher({
          onDispatch: (event) => {
            dispatch({
              type: "operation-progress",
              event: {
                ...event,
                overallPercent: Math.min(
                  100,
                  15 + Math.round((event.overallPercent / 100) * 85),
                ),
              },
            });
          },
        });

        dispatch({
          type: "operation-progress",
          event: {
            phase: "Cleanup",
            message: "Fixing known conflicts before install.",
            overallPercent: 0,
            phasePercent: 0,
            phaseCompleted: 0,
            phaseTotal: 1,
            phaseUnitLabel: "step",
            bytes: null,
            logEntry: true,
          },
        });

        const conflictResult = await runRemoveConflictsOperation({
          transport,
          conflicts: detectedConflicts,
          onProgress: conflictProgress.onProgress,
        });

        conflictProgress.markTimedOut(conflictResult.error);

        if (!conflictResult.success) {
          const inspectionAfterConflictCleanup =
            await resolvePostOperationInspection(conflictResult, () =>
              refreshInspection(transport, {
                target: activeTarget,
                targetResolutionError: getInspectionTargetResolutionError(
                  currentState.inspection,
                ),
              }),
            );
          dispatch({
            type: "operation-completed",
            result: {
              kind: "install",
              result: {
                success: false,
                warnings: conflictResult.warnings,
                inspection: null,
                error:
                  conflictResult.error ??
                  new Error("Failed to remove conflicts before install."),
                failedPhase: "Cleanup",
                deviceChangesStarted: !isPackageReadinessError(
                  conflictResult.error,
                ),
              },
            },
            inspection: inspectionAfterConflictCleanup,
          });
          return;
        }

        dispatch({
          type: "operation-progress",
          event: {
            phase: "Cleanup",
            message: "Conflict cleanup finished. Continuing with install.",
            overallPercent: 15,
            phasePercent: 100,
            phaseCompleted: 1,
            phaseTotal: 1,
            phaseUnitLabel: "step",
            bytes: null,
            logEntry: true,
          },
        });

        const installResult = await runInstallOperation({
          transport,
          target: activeTarget,
          inspection: currentState.inspection,
          bootstrapRecoveryConfirmed:
            operationOptions?.bootstrapRecoveryConfirmed,
          onProgress: installProgress.onProgress,
        });

        installProgress.markTimedOut(installResult.error);

        const nextInspection = await resolvePostOperationInspection(
          installResult,
          async () => {
            if (installResult.inspection) {
              return installResult.inspection;
            }

            return refreshInspection(transport, {
              target: activeTarget,
            });
          },
        );

        const operationResult: ControllerOperationResult = {
          kind: "install",
          result: {
            ...installResult,
            warnings: [...conflictResult.warnings, ...installResult.warnings],
          },
        };

        dispatch({
          type: "operation-completed",
          result: operationResult,
          inspection: nextInspection,
        });
      } catch (error) {
        dispatch({
          type: "operation-failed",
          error: toErrorMessage(error),
        });
      }
    },
    [ensureTransport, refreshInspection, runPrimaryAction],
  );

  const getLogcatContent = useCallback(async () => {
    const transport = ensureTransport();
    const result = await transport.shell(["logcat", "-d"]);
    return result.stdout;
  }, [ensureTransport]);

  /*
   * The SPA's `openTerminalSession()` is deliberately NOT ported. It opened a
   * root PTY on the device from inside the installer card; in Center the device
   * shell is a separate, operator-gated route (/admin/pin/terminal) that opens
   * its own PTY on the same shared session via `@/lib/pin-session`. Keeping an
   * unused root-shell opener in a wearer-reachable module would be a capability
   * nobody asked this pane to hold.
   */

  const startOver = useCallback(async () => {
    // The device is shared, so releasing it is delegated rather than done here.
    // Without a `releaseDevice` the installer resets its own state and keeps the
    // Pin attached, which is exactly what a shared session wants by default.
    await releaseDeviceRef.current?.().catch(() => undefined);
    dispatch({ type: "reset" });
  }, []);

  useBeforeUnload(state.stage === "operating");

  const commands = useMemo(
    () => deriveInstallControllerCommands(state),
    [state],
  );

  return {
    state,
    commands,
    connectAndInspect,
    recheck,
    runPrimaryAction,
    runInstallApkFile,
    runUninstall,
    runRemoveConflicts,
    runFixConflictsThenPrimaryAction,
    getLogcatContent,
    startOver,
  };
}
