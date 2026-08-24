"use client";

/**
 * "Install APK File" — ported from the retired Setup SPA's
 * `install/app/runInstallApkFile.ts`.
 *
 * Unchanged in behaviour, including the precondition that refuses the whole
 * operation unless the system injector is already installed: this path stages an
 * arbitrary APK through the on-device installer's provider, so without a healthy
 * installer there is nothing to stage through.
 *
 * Lives in the route layer rather than in `@/lib/pin-install` because it opens a
 * file picker: `document.createElement("input")` is a browser-only call and the
 * installer library is deliberately SSR-import-safe.
 */

import {
  InvalidApkStagingNameError,
  isValidApkStagingName,
  stageSystemApkInstall,
  type AdbSessionTransport,
} from "@/lib/pin-device/adb";
import type {
  InstallControllerAction,
  InstallControllerState,
  InstallInspectionResult,
  OperationProgressEvent,
  ResolvedInstallTarget,
} from "@/lib/pin-install";

function pickApkFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".apk,application/vnd.android.package-archive";
    input.style.display = "none";
    input.addEventListener(
      "change",
      () => {
        resolve(input.files?.[0] ?? null);
        input.remove();
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

export async function runInstallApkFileOperation(options: {
  transport: AdbSessionTransport;
  currentState: InstallControllerState;
  dispatch: (action: InstallControllerAction) => void;
  refreshInspection: (
    transport: AdbSessionTransport,
    options: {
      target: ResolvedInstallTarget | null;
      targetResolutionError?: Error | null;
    },
  ) => Promise<InstallInspectionResult>;
  toErrorMessage: (error: unknown) => string;
  getActiveTarget: (
    state: InstallControllerState,
  ) => ResolvedInstallTarget | null;
  getInspectionTargetResolutionError: (
    inspection: InstallInspectionResult | null,
  ) => Error | null;
}): Promise<void> {
  const {
    transport,
    currentState,
    dispatch,
    refreshInspection,
    toErrorMessage,
    getActiveTarget,
    getInspectionTargetResolutionError,
  } = options;

  const emitProgress = (event: OperationProgressEvent) => {
    dispatch({
      type: "operation-progress",
      event,
    });
  };

  const emitInstallLog = (message: string, overallPercent: number) => {
    emitProgress({
      phase: "Install",
      message,
      overallPercent,
      phasePercent: overallPercent,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "package",
      bytes: null,
      logEntry: true,
    });
  };

  const emitSystemInstallerProgress = (
    message: string,
    overallPercent: number,
  ) => {
    emitProgress({
      phase: "Install",
      message,
      overallPercent,
      phasePercent: overallPercent,
      phaseCompleted: 0,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      bytes: null,
      logEntry: true,
    });
  };

  if (!currentState.inspection?.packages.installer.installed) {
    dispatch({
      type: "operation-failed",
      error:
        "APK file install requires system injector to already be installed.",
    });
    return;
  }

  const file = await pickApkFile();
  if (!file) {
    return;
  }

  /*
   * The picked name reaches a device path, a content:// URI and the staging
   * provider's comma-separated `install` argument. `stageSystemApkInstall`
   * refuses a name that is not plainly safe, before touching the device;
   * checking here too is what turns that refusal into a sentence the wearer can
   * act on, instead of a failed operation in the install log.
   */
  if (!isValidApkStagingName(file.name)) {
    dispatch({
      type: "operation-failed",
      error: new InvalidApkStagingNameError(file.name).message,
    });
    return;
  }

  dispatch({ type: "operation-started" });
  emitInstallLog(`Installing ${file.name}.`, 0);

  try {
    await stageSystemApkInstall(transport, file, file.name, {
      onProgress: (event) => {
        const progressByStep: Record<string, number> = {
          "install-wait-installer": 5,
          "install-wait-provider": 10,
          "install-push-apk": 20,
          "install-stage-apk": 30,
          "install-trigger": 45,
          "install-wait-package-manager": 70,
          "install-wait-target-package": 85,
          "install-wait-next-provider": 95,
        };
        emitSystemInstallerProgress(
          event.message,
          progressByStep[event.step] ?? 45,
        );
      },
    });

    emitProgress({
      phase: "Verify",
      message: `APK file install finished for ${file.name}.`,
      overallPercent: 100,
      phasePercent: 100,
      phaseCompleted: 1,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      bytes: null,
      logEntry: true,
    });

    const nextInspection = await refreshInspection(transport, {
      target: getActiveTarget(currentState),
      targetResolutionError: getInspectionTargetResolutionError(
        currentState.inspection,
      ),
    });

    emitProgress({
      phase: "Verify",
      message: `Post-install inspection: installer=${nextInspection.packages.installer.installed ? "installed" : "missing"}, hook=${nextInspection.packages.hook.installed ? "installed" : "missing"}, server=${nextInspection.packages.server.installed ? "installed" : "missing"}, injector=${nextInspection.packages.injector.installed ? "installed" : "missing"}.`,
      overallPercent: 100,
      phasePercent: 100,
      phaseCompleted: 1,
      phaseTotal: 1,
      phaseUnitLabel: "step",
      bytes: null,
      logEntry: true,
    });

    dispatch({
      type: "operation-completed",
      result: {
        kind: "install",
        result: {
          success: true,
          warnings: [],
          inspection: nextInspection,
          error: null,
          failedPhase: null,
          deviceChangesStarted: true,
        },
      },
      inspection: nextInspection,
    });
  } catch (error) {
    dispatch({
      type: "operation-failed",
      error: toErrorMessage(error),
    });
  }
}
