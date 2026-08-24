import {
  createDeviceLogLine,
  type AdbConnectionInfo,
  type BrowserSupportResult,
} from "../device";
import type { InstallInspectionResult } from "../domain/inspection";
import type { InstallOperationResult } from "../ops/install";
import type { OperationProgressEvent } from "../ops/phases";
import type { RemoveConflictsOperationResult } from "../ops/removeConflicts";
import type { UninstallOperationResult } from "../ops/uninstall";
import type { ResolvedInstallTarget } from "../releases/assets";
import type { TargetLock } from "../releases/targetLock";

export type InstallControllerStage =
  | "intro"
  | "unsupported-browser"
  | "connecting"
  | "inspecting"
  | "connected-idle"
  | "blocked"
  | "operating"
  | "result"
  | "error";

export const STAGE_LABELS: Record<InstallControllerStage, string> = {
  intro: "Disconnected",
  "unsupported-browser": "Unsupported Browser",
  connecting: "Connecting",
  inspecting: "Inspecting",
  "connected-idle": "Connected",
  blocked: "Blocked",
  operating: "Action In Progress",
  result: "Result",
  error: "Error",
};

export type ControllerTone = "default" | "info" | "success" | "warning" | "danger";

export type ControllerOperationResult =
  | {
      readonly kind: "install";
      readonly result: InstallOperationResult;
    }
  | {
      readonly kind: "uninstall";
      readonly result: UninstallOperationResult;
    }
  | {
      readonly kind: "remove-conflicts";
      readonly result: RemoveConflictsOperationResult;
    };

export interface InstallProgressEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly phase: OperationProgressEvent["phase"] | "Inspect";
  readonly message: string;
  readonly overallPercent: number | null;
  readonly phasePercent: number | null;
  readonly phaseCompleted: number | null;
  readonly phaseTotal: number | null;
  readonly phaseUnitLabel: string | null;
  readonly bytesLoaded: number | null;
  readonly bytesTotal: number | null;
}

export interface InstallControllerState {
  readonly browserSupport: BrowserSupportResult;
  readonly stage: InstallControllerStage;
  readonly inspection: InstallInspectionResult | null;
  readonly target: ResolvedInstallTarget | null;
  readonly targetLock: TargetLock | null;
  readonly connection: AdbConnectionInfo | null;
  readonly isBusy: boolean;
  readonly error: string | null;
  readonly lastOperationResult: ControllerOperationResult | null;
  readonly progressEntries: readonly InstallProgressEntry[];
  readonly currentProgress: InstallProgressEntry | null;
}

export interface InstallActionCommand {
  readonly visible: boolean;
  readonly label: string;
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly prominent?: boolean;
}

export interface InstallLinkCommand {
  readonly visible: boolean;
  readonly label: string;
  readonly href: string;
}

export interface InstallControllerCommands {
  readonly connect: InstallActionCommand;
  readonly primaryAction: InstallActionCommand;
  readonly installApkFile: InstallActionCommand;
  readonly uninstall: InstallActionCommand;
  readonly removeConflicts: InstallActionCommand;
  readonly recheck: InstallActionCommand;
  readonly startOver: InstallActionCommand;
  readonly goToCenter: InstallLinkCommand;
}

interface InspectionStartedAction {
  readonly type: "inspection-started";
  readonly stage: "connecting" | "inspecting";
}

interface ConnectionEstablishedAction {
  readonly type: "connection-established";
  readonly connection: AdbConnectionInfo;
}

interface InspectionCompletedAction {
  readonly type: "inspection-completed";
  readonly connection: AdbConnectionInfo;
  readonly inspection: InstallInspectionResult;
  readonly target: ResolvedInstallTarget | null;
  readonly targetLock: TargetLock | null;
}

interface InspectionFailedAction {
  readonly type: "inspection-failed";
  readonly connection: AdbConnectionInfo | null;
  readonly error: string;
}

interface OperationStartedAction {
  readonly type: "operation-started";
}

interface OperationProgressAction {
  readonly type: "operation-progress";
  readonly event: OperationProgressEvent;
}

interface OperationCompletedAction {
  readonly type: "operation-completed";
  readonly result: ControllerOperationResult;
  readonly inspection: InstallInspectionResult | null;
}

interface OperationFailedAction {
  readonly type: "operation-failed";
  readonly error: string;
}

interface ResetAction {
  readonly type: "reset";
}

export type InstallControllerAction =
  | InspectionStartedAction
  | ConnectionEstablishedAction
  | InspectionCompletedAction
  | InspectionFailedAction
  | OperationStartedAction
  | OperationProgressAction
  | OperationCompletedAction
  | OperationFailedAction
  | ResetAction;

/**
 * Where a successful install hands the wearer off to.
 *
 * The SPA sent them to its own `/setup/` root; in Center the equivalent
 * destination is the Pin console, which is where every configuration pane
 * (server, LLM, services, eSIM, flags, diagnostics) now lives. Overridable so
 * the route layer can retarget it without editing this reducer.
 */
export const DEFAULT_POST_INSTALL_LINK = Object.freeze({
  label: "Open Pin settings",
  href: "/settings/pin",
});

function createProgressEntry(event: OperationProgressEvent): InstallProgressEntry {
  const line = createDeviceLogLine(event.message);
  return {
    ...line,
    phase: event.phase,
    message: event.message,
    overallPercent: event.overallPercent,
    phasePercent: event.phasePercent,
    phaseCompleted: event.phaseCompleted,
    phaseTotal: event.phaseTotal,
    phaseUnitLabel: event.phaseUnitLabel,
    bytesLoaded: event.bytes?.loaded ?? null,
    bytesTotal: event.bytes?.total ?? null,
  };
}

function hasInstalledManagedPackages(inspection: InstallInspectionResult): boolean {
  return Object.values(inspection.packages).some((pkg) => pkg.installed);
}

function hasRemovableManagedState(inspection: InstallInspectionResult): boolean {
  return inspection.helperPresentUnexpectedly || hasInstalledManagedPackages(inspection);
}

function hasDetectedRemovableConflicts(inspection: InstallInspectionResult): boolean {
  return inspection.detectedConflicts.some((conflict) => conflict.installedPackageIds.length > 0);
}

export function isControllerOperationSuccessful(
  result: ControllerOperationResult | null,
): boolean {
  return result?.result.success ?? false;
}

export function getStageFromInspection(
  inspection: InstallInspectionResult | null,
): InstallControllerStage {
  if (!inspection) {
    return "intro";
  }

  if (inspection.installActionsBlocked) {
    return "blocked";
  }

  return "connected-idle";
}

export function createInitialInstallControllerState(
  browserSupport: BrowserSupportResult,
): InstallControllerState {
  return {
    browserSupport,
    stage: browserSupport.supported ? "intro" : "unsupported-browser",
    inspection: null,
    target: null,
    targetLock: null,
    connection: null,
    isBusy: false,
    error: null,
    lastOperationResult: null,
    progressEntries: [],
    currentProgress: null,
  };
}

export function installControllerReducer(
  state: InstallControllerState,
  action: InstallControllerAction,
): InstallControllerState {
  switch (action.type) {
    case "inspection-started": {
      return {
        ...state,
        stage: action.stage,
        isBusy: true,
        error: null,
        lastOperationResult: null,
        currentProgress: null,
      };
    }

    case "connection-established": {
      return {
        ...state,
        connection: action.connection,
        stage: "inspecting",
      };
    }

    case "inspection-completed": {
      return {
        ...state,
        stage: getStageFromInspection(action.inspection),
        inspection: action.inspection,
        target: action.target,
        targetLock: action.targetLock,
        connection: action.connection,
        isBusy: false,
        error: null,
        lastOperationResult: null,
        currentProgress: null,
      };
    }

    case "inspection-failed": {
      return {
        ...state,
        stage: "error",
        inspection: null,
        target: null,
        targetLock: null,
        connection: action.connection,
        isBusy: false,
        error: action.error,
        lastOperationResult: null,
        currentProgress: null,
      };
    }

    case "operation-started": {
      return {
        ...state,
        stage: "operating",
        isBusy: true,
        error: null,
        lastOperationResult: null,
        progressEntries: [],
        currentProgress: null,
      };
    }

    case "operation-progress": {
      const nextEntry = createProgressEntry(action.event);
      const shouldLogEntry = action.event.logEntry ?? true;
      return {
        ...state,
        progressEntries: shouldLogEntry ? [...state.progressEntries, nextEntry] : state.progressEntries,
        currentProgress: nextEntry,
      };
    }

    case "operation-completed": {
      return {
        ...state,
        stage: "result",
        inspection: action.inspection ?? state.inspection,
        isBusy: false,
        error: null,
        lastOperationResult: action.result,
        currentProgress: null,
      };
    }

    case "operation-failed": {
      return {
        ...state,
        stage: "error",
        isBusy: false,
        error: action.error,
        currentProgress: null,
      };
    }

    case "reset": {
      return createInitialInstallControllerState(state.browserSupport);
    }

    default: {
      return state;
    }
  }
}

export interface DeriveInstallControllerCommandsOptions {
  readonly postInstallLink?: {
    readonly label: string;
    readonly href: string;
  };
}

export function deriveInstallControllerCommands(
  state: InstallControllerState,
  options: DeriveInstallControllerCommandsOptions = {},
): InstallControllerCommands {
  const postInstallLink = options.postInstallLink ?? DEFAULT_POST_INSTALL_LINK;
  const hasConnection = state.connection !== null;
  const hasInspection = state.inspection !== null;
  const resultSuccessful = isControllerOperationSuccessful(state.lastOperationResult);
  const hasRemovableState = state.inspection ? hasRemovableManagedState(state.inspection) : true;
  const hasDetectedConflicts = state.inspection ? hasDetectedRemovableConflicts(state.inspection) : false;
  const installActionsBlockedReason =
    state.inspection?.installActionsBlockedReason ??
    "Install-type actions are blocked until the installer can resolve a release target.";
  const credentialState = state.inspection?.readiness.credentialState.state;
  const deviceCredentialUnavailable =
    hasInspection && credentialState !== "unlocked";
  const credentialUnavailableReason =
    credentialState === "locked"
      ? `Device is locked. Unlock the device, then press "Start Over".`
      : `Setup could not confirm credential-encrypted storage. Unlock the device, then press "Start Over".`;
  const installerAvailable = state.inspection?.packages.installer.installed ?? false;

  return {
    connect: {
      visible: !hasConnection && state.stage !== "result",
      label: "Connect Device",
      disabled: state.isBusy || !state.browserSupport.supported,
      reason: !state.browserSupport.supported
        ? "Use a secure desktop Chromium browser with WebUSB support."
        : state.isBusy
          ? "Wait for the current task to finish."
          : null,
    },
    primaryAction: {
      visible:
        (hasInspection || state.stage === "inspecting" || state.stage === "connecting") &&
        state.stage !== "operating" &&
        !(state.stage === "result" && resultSuccessful),
      label:
        state.inspection?.actionState.action ??
        (state.stage === "connecting"
          ? "Connecting…"
          : state.stage === "inspecting"
            ? "Validating…"
            : "Install"),
      disabled:
        state.isBusy ||
        !hasInspection ||
        Boolean(state.inspection?.installActionsBlocked) ||
        deviceCredentialUnavailable,
      reason: state.isBusy
        ? "Wait for the current task to finish."
        : !hasInspection
          ? "Connect a device and inspect its state first."
          : state.inspection.installActionsBlocked
            ? installActionsBlockedReason
            : deviceCredentialUnavailable
              ? credentialUnavailableReason
              : null,
    },
    installApkFile: {
      visible: hasConnection || hasInspection,
      label: "Install APK File",
      disabled: state.isBusy || !hasConnection || !hasInspection || deviceCredentialUnavailable || !installerAvailable,
      reason: state.isBusy
        ? "Wait for the current task to finish."
        : !hasConnection
          ? "Connect a device before installing an APK file."
          : !hasInspection
            ? "Connect a device and inspect its state first."
            : deviceCredentialUnavailable
              ? credentialUnavailableReason
              : !installerAvailable
                ? "APK file install requires system injector to be installed."
                : null,
    },
    uninstall: {
      visible:
        (hasConnection || hasInspection) &&
        state.stage !== "operating" &&
        !(state.stage === "result" && state.lastOperationResult?.kind === "uninstall" && resultSuccessful),
      label: "Uninstall",
      disabled: state.isBusy || !hasConnection || !hasRemovableState,
      reason: state.isBusy
        ? "Wait for the current task to finish."
        : !hasConnection
          ? "Connect a device before uninstalling."
          : !hasRemovableState
            ? "Nothing to remove. This device does not currently have managed packages installed."
            : null,
    },
    removeConflicts: {
      visible:
        (hasConnection || hasInspection) &&
        state.stage !== "operating" &&
        !(state.stage === "result" && state.lastOperationResult?.kind === "remove-conflicts" && resultSuccessful) &&
        hasDetectedConflicts,
      label: "Review and Remove Conflicts",
      disabled: state.isBusy || !hasConnection || !hasDetectedConflicts,
      reason: state.isBusy
        ? "Wait for the current task to finish."
        : !hasConnection
          ? "Connect a device before removing conflicts."
          : !hasDetectedConflicts
            ? "No known conflicting packages were detected."
            : null,
    },
    recheck: {
      visible:
        state.stage === "blocked" ||
        (hasConnection &&
          (state.stage === "error" ||
            (state.stage === "result" &&
              ((state.lastOperationResult?.kind === "install" &&
                !state.lastOperationResult.result.success) ||
                state.lastOperationResult?.kind === "remove-conflicts")))),
      label: "Recheck",
      disabled: state.isBusy,
      reason: state.isBusy ? "Wait for the current task to finish." : null,
      prominent:
        hasConnection &&
        state.stage === "result" &&
        state.lastOperationResult?.kind === "install" &&
        !state.lastOperationResult.result.success,
    },
    startOver: {
      visible:
        state.stage !== "intro" ||
        hasConnection ||
        state.inspection !== null ||
        state.target !== null ||
        state.lastOperationResult !== null ||
        state.error !== null,
      label: "Start Over",
      disabled: state.isBusy,
      reason: state.isBusy ? "The current action cannot be cancelled." : null,
    },
    goToCenter: {
      visible:
        state.stage === "result" &&
        state.lastOperationResult?.kind === "install" &&
        resultSuccessful,
      label: postInstallLink.label,
      href: postInstallLink.href,
    },
  };
}
