import type {
  InstallActionCommand,
  InstallControllerCommands,
  InstallControllerState,
  InstallLinkCommand,
} from "../app/state";
import type { ManagedPackageVersionSnapshot } from "../domain/inspection";
import type { ManagedPackageRole } from "../domain/types";
import {
  MANAGED_PACKAGE_ROLE_ORDER,
  formatManagedPackageRole,
  getDisplayedPackageVersion,
  getManagedPackageSnapshots,
  getManagedPackageStatusText,
  getManagedPackageStatusTone,
} from "./managedPackages";

export interface PrimaryCardActionViewModel {
  readonly key:
    | "connect"
    | "primaryAction"
    | "installApkFile"
    | "openTerminal"
    | "recheck"
    | "goToCenter"
    | "uninstall"
    | "removeConflicts"
    | "startOver";
  readonly label: string;
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly href: string | null;
}

export interface PrimaryCardPackageRowViewModel {
  readonly role: string;
  readonly value: string;
  readonly tone: "default" | "success" | "warning";
  readonly category?: "managed" | "conflict";
  readonly badge?: string | null;
}

export interface PrimaryCardDeviceViewModel {
  readonly name: string;
  readonly serial: string;
  readonly badge: string | null;
}

export interface PrimaryCardViewModel {
  readonly title: string;
  readonly copy: string;
  readonly notice: {
    readonly tone: "danger" | "warning";
    readonly text: string;
  } | null;
  readonly progressPercent: number;
  readonly showProgress: boolean;
  readonly showHero: boolean;
  readonly device: PrimaryCardDeviceViewModel | null;
  readonly packageRows: readonly PrimaryCardPackageRowViewModel[];
  readonly conflictRows: readonly PrimaryCardPackageRowViewModel[];
  readonly overflowActions: readonly PrimaryCardActionViewModel[];
  readonly primaryAction: PrimaryCardActionViewModel | null;
  readonly secondaryActions: readonly PrimaryCardActionViewModel[];
}

function clampText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getBaseSummary(state: InstallControllerState) {
  const latestProgress =
    state.currentProgress ??
    (state.progressEntries.length > 0
      ? state.progressEntries[state.progressEntries.length - 1]
      : null);

  if (state.stage === "operating") {
    return {
      title: latestProgress?.phase ?? "Working",
      copy: latestProgress?.message ?? "Preparing the requested action.",
      progressPercent: latestProgress?.overallPercent ?? 0,
      showProgress: true,
    };
  }

  if (
    state.stage === "result" &&
    state.lastOperationResult?.kind === "install" &&
    state.lastOperationResult.result.success
  ) {
    return {
      title: "Install Complete",
      copy:
        state.lastOperationResult.result.warnings.length > 0
          ? "Install finished with warnings. Review diagnostics or continue to Setup."
          : "Install finished.",
      progressPercent: 100,
      showProgress: false,
    };
  }

  if (
    state.stage === "result" &&
    state.lastOperationResult?.kind === "install" &&
    !state.lastOperationResult.result.success
  ) {
    return {
      title: "Install Failed",
      copy:
        state.lastOperationResult.result.error?.message ??
        "The install did not complete. Review diagnostics, then recheck the device.",
      progressPercent: 100,
      showProgress: false,
    };
  }

  if (
    state.stage === "result" &&
    state.lastOperationResult?.kind === "uninstall"
  ) {
    return {
      title: state.lastOperationResult.result.success
        ? "Uninstall Complete"
        : "Uninstall Failed",
      copy:
        state.lastOperationResult.result.error?.message ??
        (state.lastOperationResult.result.success
          ? "Managed packages were removed successfully."
          : "The uninstall did not complete."),
      progressPercent: 100,
      showProgress: false,
    };
  }

  if (
    state.stage === "result" &&
    state.lastOperationResult?.kind === "remove-conflicts"
  ) {
    return {
      title: state.lastOperationResult.result.success
        ? "Conflicts Removed"
        : "Conflict Removal Failed",
      copy:
        state.lastOperationResult.result.error?.message ??
        (state.lastOperationResult.result.success
          ? "Known conflicting packages were removed successfully."
          : "The conflict removal did not complete."),
      progressPercent: 100,
      showProgress: false,
    };
  }

  if (state.stage === "blocked") {
    return {
      title: "Install Blocked",
      copy: "Resolve the release target before continuing.",
      progressPercent: 0,
      showProgress: false,
    };
  }

  if (state.stage === "connecting") {
    return {
      title: "Connecting...",
      copy: "Choose Ai Pin in the browser prompt.",
      progressPercent: 10,
      showProgress: false,
    };
  }

  if (state.stage === "inspecting") {
    return {
      title: "Inspecting",
      copy: "You may have to approve the prompt on the device using the Laser Ink display.",
      progressPercent: 20,
      showProgress: false,
    };
  }

  if (state.stage === "unsupported-browser") {
    return {
      title: "Unsupported Browser",
      copy: "Use a secure desktop Chromium browser with WebUSB support.",
      progressPercent: 0,
      showProgress: false,
    };
  }

  if (state.stage === "error") {
    return {
      title: state.connection ? "Action Failed" : "Connection Failed",
      copy: state.connection
        ? "Review diagnostics, then recheck the device."
        : "Unable to connect to Ai Pin. Review diagnostics and reconnect.",
      progressPercent: 0,
      showProgress: false,
    };
  }

  if (state.connection === null) {
    return {
      title: "Connect Ai Pin",
      copy: "Place Ai Pin on the interposer and connect it to your computer.",
      progressPercent: 0,
      showProgress: false,
    };
  }

  return {
    title: state.inspection?.actionState.action ?? "Ready",
    copy: "Review the device state below, then choose the next action.",
    progressPercent: 0,
    showProgress: false,
  };
}

function getNotice(state: InstallControllerState) {
  if (state.browserSupport.reasons.length > 0 && state.connection === null) {
    return {
      tone: "danger" as const,
      text: state.browserSupport.reasons.join(" "),
    };
  }

  if (state.stage === "blocked") {
    return {
      tone: "warning" as const,
      text:
        state.inspection?.installActionsBlockedReason ??
        "Install-type actions are blocked until the installer can resolve a release target.",
    };
  }

  if (state.stage === "error" && state.error) {
    return {
      tone: "danger" as const,
      text: state.error,
    };
  }

  if (state.inspection?.readiness.credentialState.state === "locked") {
    return {
      tone: "warning" as const,
      text: `Device is locked. Unlock the device, then press "Start Over".`,
    };
  }

  if (
    state.stage === "result" &&
    state.lastOperationResult?.kind === "install" &&
    !state.lastOperationResult.result.success
  ) {
    const result = state.lastOperationResult.result;
    const packageReadinessFailure =
      !result.deviceChangesStarted &&
      (result.error?.message.includes("Android's package service") ?? false);
    return {
      tone: "warning" as const,
      text: packageReadinessFailure
        ? "No changes were made. Wait for Android to finish starting, then retry."
        : result.deviceChangesStarted
          ? "Install changes were preserved. Recheck the device or use Uninstall to remove the managed runtime."
          : "Install stopped before making changes. Recheck the device, then retry.",
    };
  }

  if (
    state.stage === "result" &&
    state.lastOperationResult?.kind === "install" &&
    state.lastOperationResult.result.success &&
    state.lastOperationResult.result.warnings.length > 0
  ) {
    return {
      tone: "warning" as const,
      text: `Install completed with ${state.lastOperationResult.result.warnings.length} warning${state.lastOperationResult.result.warnings.length === 1 ? "" : "s"}. Review diagnostics if needed.`,
    };
  }

  if (
    state.stage === "result" &&
    state.lastOperationResult?.kind === "remove-conflicts" &&
    state.lastOperationResult.result.success
  ) {
    return {
      tone: "warning" as const,
      text: "Known conflicting packages were removed. Review the refreshed device state before continuing.",
    };
  }

  return null;
}

function createPlaceholderPackageRow(
  role: ManagedPackageRole,
): PrimaryCardPackageRowViewModel {
  return {
    role: formatManagedPackageRole(role),
    value: "Inspecting",
    tone: "default",
    category: "managed",
    badge: null,
  };
}

function getCompactPackageValue(pkg: ManagedPackageVersionSnapshot) {
  const displayedVersion = getDisplayedPackageVersion(
    pkg.versionName,
    pkg.installed,
  );
  const status = getManagedPackageStatusText(pkg);
  const showTargetSuffix =
    status && status !== "Up to Date" && pkg.targetVersion !== "unknown";
  const targetSuffix = showTargetSuffix ? ` -> ${pkg.targetVersion}` : "";

  if (!pkg.installed) {
    return clampText(`Not installed${targetSuffix}`, 52);
  }

  if (!status) {
    return clampText(displayedVersion, 40);
  }

  if (status === "Unreadable" && displayedVersion === "Unreadable") {
    return clampText(`Unreadable${targetSuffix}`, 52);
  }

  return clampText(`${displayedVersion} · ${status}${targetSuffix}`, 52);
}

function getPackageRows(
  state: InstallControllerState,
): PrimaryCardPackageRowViewModel[] {
  if (!state.inspection) {
    return MANAGED_PACKAGE_ROLE_ORDER.map((role) =>
      createPlaceholderPackageRow(role),
    );
  }

  const snapshotsByRole = new Map(
    getManagedPackageSnapshots(state.inspection).map(
      (pkg) => [pkg.role, pkg] as const,
    ),
  );

  return MANAGED_PACKAGE_ROLE_ORDER.map((role) => {
    const pkg = snapshotsByRole.get(role);

    if (!pkg) {
      return createPlaceholderPackageRow(role);
    }

    return {
      role: formatManagedPackageRole(pkg.role),
      value: getCompactPackageValue(pkg),
      tone: getManagedPackageStatusTone(pkg),
      category: "managed",
      badge: null,
    };
  });
}

function getConflictRows(
  state: InstallControllerState,
): PrimaryCardPackageRowViewModel[] {
  if (!state.inspection?.hasDetectedConflicts) {
    return [];
  }

  return state.inspection.detectedConflicts.map((conflict) => ({
    role: conflict.label,
    value: `${conflict.installedPackageIds.length} package${conflict.installedPackageIds.length === 1 ? "" : "s"}`,
    tone: "warning",
    category: "conflict",
    badge: "Warning",
  }));
}

function createActionFromCommand(
  key: Exclude<PrimaryCardActionViewModel["key"], "goToCenter">,
  command: InstallActionCommand,
): PrimaryCardActionViewModel | null {
  if (!command.visible) {
    return null;
  }

  return {
    key,
    label: command.label,
    disabled: command.disabled,
    reason: command.reason,
    href: null,
  };
}

function createActionFromLink(
  key: Extract<PrimaryCardActionViewModel["key"], "goToCenter">,
  command: InstallLinkCommand,
): PrimaryCardActionViewModel | null {
  if (!command.visible) {
    return null;
  }

  return {
    key,
    label: command.label,
    disabled: false,
    reason: null,
    href: command.href,
  };
}

function getOverflowActions(
  state: InstallControllerState,
  commands: InstallControllerCommands,
) {
  return [
    createActionFromCommand("installApkFile", commands.installApkFile),
    state.connection
      ? {
          key: "openTerminal" as const,
          label: "Terminal",
          disabled: state.isBusy,
          reason: state.isBusy ? "Wait for the current task to finish." : null,
          href: null,
        }
      : null,
  ].filter((action): action is PrimaryCardActionViewModel => action !== null);
}

function getPrimaryAction(commands: InstallControllerCommands) {
  return (
    createActionFromCommand("recheck", commands.recheck) ??
    createActionFromCommand("primaryAction", commands.primaryAction) ??
    createActionFromCommand("connect", commands.connect) ??
    createActionFromLink("goToCenter", commands.goToCenter)
  );
}

function getSecondaryActions(
  commands: InstallControllerCommands,
): PrimaryCardActionViewModel[] {
  return [
    createActionFromCommand("removeConflicts", commands.removeConflicts),
    createActionFromCommand("uninstall", commands.uninstall),
    commands.recheck.prominent
      ? null
      : createActionFromCommand("recheck", commands.recheck),
    createActionFromCommand("startOver", commands.startOver),
  ].filter((action): action is PrimaryCardActionViewModel => action !== null);
}

export function derivePrimaryCardViewModel(
  state: InstallControllerState,
  commands: InstallControllerCommands,
): PrimaryCardViewModel {
  const summary = getBaseSummary(state);
  const notice = getNotice(state);

  return {
    title: clampText(summary.title, 30),
    copy: clampText(summary.copy, 92),
    notice: notice
      ? {
          tone: notice.tone,
          text: clampText(notice.text, 116),
        }
      : null,
    progressPercent: clampPercent(summary.progressPercent),
    showProgress: summary.showProgress,
    showHero:
      state.connection === null &&
      (state.stage === "intro" ||
        state.stage === "connecting" ||
        state.stage === "unsupported-browser" ||
        (state.stage === "error" && state.connection === null)),
    device:
      state.connection === null
        ? null
        : {
            name: state.connection.name,
            serial: state.connection.serial,
            badge: state.inspection
              ? state.inspection.device.recognizedAiPin
                ? "Ai Pin"
                : "Unrecognized"
              : null,
          },
    packageRows: state.connection === null ? [] : getPackageRows(state),
    conflictRows: state.connection === null ? [] : getConflictRows(state),
    overflowActions: getOverflowActions(state, commands),
    primaryAction: getPrimaryAction(commands),
    secondaryActions: getSecondaryActions(commands),
  };
}
