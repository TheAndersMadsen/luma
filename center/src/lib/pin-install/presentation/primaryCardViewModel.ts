import type {
  InstallActionCommand,
  InstallControllerCommands,
  InstallControllerState,
  InstallLinkCommand,
} from "../app/state";
import type { InstallInspectionResult, ManagedPackageVersionSnapshot } from "../domain/inspection";
import { compareInstallVersions, parseInstallVersion } from "../domain/versions";
import type { ManagedPackageRole } from "../domain/types";
import {
  MANAGED_PACKAGE_ROLE_ORDER,
  formatManagedPackageRole,
  getDisplayedPackageVersion,
  getManagedPackageSnapshots,
  getManagedPackageStatusText,
  getManagedPackageStatusTone,
  hasProblematicManagedPackageState,
} from "./managedPackages";
import { PackageServiceNotReadyError } from "@/lib/pin-device/adb/systemInstaller";
import { AdbDeviceStepTimeoutError } from "@/lib/pin-device/adb";
import type { OperationProgressEvent } from "../ops/phases";
import { PIN_LOCKED_COPY, PIN_UNLOCK_UNCONFIRMED_COPY } from "../app/state";

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

/**
 * One of the three steps the pane reads as (INFERRED: Luma's own install
 * flow): plug the Pin in, connect over USB, update. `holdsPrimaryAction`
 * says the card's one primary action belongs under this step.
 */
export interface PrimaryCardStepViewModel {
  readonly number: 1 | 2 | 3;
  readonly title: string;
  readonly detail: string | null;
  readonly state: "done" | "active" | "waiting";
  readonly holdsPrimaryAction: boolean;
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
  readonly steps: readonly PrimaryCardStepViewModel[];
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

/**
 * The operation phases, in words a wearer recognises. The raw step message
 * (package names, shell commands) stays in the Debugging activity log.
 */
const PHASE_TITLES: Record<OperationProgressEvent["phase"], string> = {
  Assets: "Downloading Luma",
  Cleanup: "Preparing your Pin",
  Installer: "Preparing your Pin",
  Install: "Installing Luma",
  Disable: "Finishing up",
  Configure: "Finishing up",
  Verify: "Checking your Pin",
  Restore: "Restoring the original apps",
};

const KEEP_CONNECTED_COPY =
  "Keep this tab open and your Pin unlocked on the cable. If it restarts, Center reconnects.";

function lumaRelease(state: InstallControllerState): string {
  const version = state.target?.version ?? null;
  return version ? `Luma ${version}` : "the Luma release on your server";
}

/**
 * The Luma release on this Pin: the oldest readable version among its
 * runtime apps (the Device Installer is retained separately and does not
 * count), or `null` when none is installed or readable. The same packages
 * `deriveInstallActionState` compares against the target.
 */
export function installedLumaRelease(inspection: InstallInspectionResult | null): string | null {
  if (!inspection) return null;
  let oldest: string | null = null;
  for (const pkg of Object.values(inspection.packages)) {
    if (pkg.role === "installer" || !pkg.installed || !parseInstallVersion(pkg.versionName)) continue;
    if (oldest === null || compareInstallVersions(pkg.versionName, oldest) === -1) oldest = pkg.versionName;
  }
  return oldest;
}

/** The Pin was read and its storage is locked (or not confirmed unlocked): it needs its passcode. */
function isLocked(state: InstallControllerState): boolean {
  return (
    state.stage === "connected-idle" &&
    state.inspection !== null &&
    state.inspection.readiness.credentialState.state !== "unlocked"
  );
}

/** Everything the server publishes is already on this Pin, at the same version. */
function isUpToDate(state: InstallControllerState): boolean {
  const actionState = state.inspection?.actionState;
  return (
    state.stage === "connected-idle" &&
    actionState?.action === "Reinstall" &&
    !actionState.warnings.newerThanTarget
  );
}

/** This Pin runs newer Luma software than the server publishes. */
function isAheadOfServer(state: InstallControllerState): boolean {
  const actionState = state.inspection?.actionState;
  return (
    state.stage === "connected-idle" &&
    actionState?.action === "Reinstall" &&
    actionState.warnings.newerThanTarget
  );
}

/** What went wrong, from the typed error. The raw message is for Debugging. */
function describeInstallFailure(error: Error | null): string | null {
  if (error instanceof PackageServiceNotReadyError) {
    return "Android on your Pin hadn’t finished starting.";
  }
  if (error instanceof AdbDeviceStepTimeoutError) {
    return "Your Pin stopped answering partway through.";
  }
  return error?.message ?? null;
}

function getIdleSummary(state: InstallControllerState) {
  if (isLocked(state)) {
    return {
      title: "Unlock your Pin",
      copy: isUpToDate(state)
        ? `${lumaRelease(state)} is installed. Enter your passcode on your Pin to start using it.`
        : "Enter your passcode on your Pin. Center can update it once it’s unlocked.",
    };
  }

  if (isUpToDate(state)) {
    return {
      title: "Your Pin is up to date",
      copy: `${lumaRelease(state)} is installed.`,
    };
  }

  if (isAheadOfServer(state)) {
    return {
      title: "Your Pin is newer than your server",
      copy: "Update your server to the matching Luma release. Reinstalling here would downgrade the Pin.",
    };
  }

  switch (state.inspection?.actionState.action) {
    case "Install":
      return {
        title: "Luma isn’t installed yet",
        copy: `Install ${lumaRelease(state)}. It takes a few minutes, and your Pin restarts.`,
      };
    case "Update":
      return {
        title: "An update is available",
        copy: `Update to ${lumaRelease(state)}. It takes a few minutes, and your Pin restarts.`,
      };
    case "Repair":
      return {
        title: "Your Pin needs a repair",
        copy: `Some Luma software is missing or not working. Repair installs ${lumaRelease(state)} again.`,
      };
    default:
      return {
        title: "Checking your Pin…",
        copy: "Center is reading what is installed.",
      };
  }
}

function getBaseSummary(state: InstallControllerState) {
  const latestProgress =
    state.currentProgress ??
    (state.progressEntries.length > 0
      ? state.progressEntries[state.progressEntries.length - 1]
      : null);

  if (state.stage === "operating") {
    return {
      title:
        latestProgress && latestProgress.phase !== "Inspect"
          ? PHASE_TITLES[latestProgress.phase]
          : "Starting…",
      copy: KEEP_CONNECTED_COPY,
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
      title: "Your Pin is up to date",
      copy: `${lumaRelease(state)} is installed.`,
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
      title: "The install didn’t finish",
      copy:
        describeInstallFailure(state.lastOperationResult.result.error) ??
        "The install stopped before it finished.",
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
        ? "Luma is uninstalled"
        : "The uninstall didn’t finish",
      copy:
        state.lastOperationResult.result.error?.message ??
        (state.lastOperationResult.result.success
          ? "Luma was removed from this Pin."
          : "Some Luma software may still be on this Pin."),
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
        ? "Conflicting apps removed"
        : "Couldn’t remove the conflicting apps",
      copy:
        state.lastOperationResult.result.error?.message ??
        (state.lastOperationResult.result.success
          ? "Choose Check again to see what to do next."
          : "Some conflicting apps are still on this Pin."),
      progressPercent: 100,
      showProgress: false,
    };
  }

  if (state.stage === "blocked") {
    return {
      title: "No Pin release to install",
      copy: "On your server, run ./luma pin release acquire --check, then choose Check again.",
      progressPercent: 0,
      showProgress: false,
    };
  }

  if (state.stage === "connecting") {
    return {
      title: "Choose your Pin",
      copy: "Your browser lists USB devices. Select your Pin, then choose Connect.",
      progressPercent: 10,
      showProgress: false,
    };
  }

  if (state.stage === "inspecting") {
    return {
      title: "Checking your Pin…",
      copy: "If your Pin asks to allow this computer, accept on its Laser Ink display.",
      progressPercent: 20,
      showProgress: false,
    };
  }

  if (state.stage === "unsupported-browser") {
    return {
      title: "This browser can’t reach your Pin",
      copy: "Open this page in desktop Chrome or Edge.",
      progressPercent: 0,
      showProgress: false,
    };
  }

  if (state.stage === "error") {
    return {
      title: state.connection ? "Something went wrong" : "Couldn’t connect to your Pin",
      copy: state.connection
        ? "Keep your Pin unlocked on the cable, then choose Check again."
        : "Check that your Pin is unlocked and on the cable, then connect again.",
      progressPercent: 0,
      showProgress: false,
    };
  }

  if (state.connection === null) {
    return {
      title: "Connect your Pin",
      copy: "Three steps: plug your Pin in, connect over USB, then update. It takes a few minutes.",
      progressPercent: 0,
      showProgress: false,
    };
  }

  return { ...getIdleSummary(state), progressPercent: 0, showProgress: false };
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
        "Center couldn’t load a verified Pin release from your server.",
    };
  }

  if (state.stage === "error" && state.error) {
    return {
      tone: "danger" as const,
      text: state.error,
    };
  }

  if (
    state.stage === "connected-idle" &&
    state.inspection &&
    state.inspection.readiness.credentialState.state !== "unlocked"
  ) {
    return {
      tone: "warning" as const,
      text:
        state.inspection.readiness.credentialState.state === "locked"
          ? PIN_LOCKED_COPY
          : PIN_UNLOCK_UNCONFIRMED_COPY,
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
      result.error instanceof PackageServiceNotReadyError;
    return {
      tone: "warning" as const,
      text: packageReadinessFailure
        ? "No changes were made. Wait for Android to finish starting, then retry."
        : result.deviceChangesStarted
          ? "Your Pin kept the changes made so far. Choose Check again to finish or repair it."
          : "No changes were made. Choose Check again, then try again.",
    };
  }

  if (
    state.stage === "result" &&
    state.lastOperationResult?.kind === "install" &&
    state.lastOperationResult.result.success &&
    state.lastOperationResult.result.warnings.length > 0
  ) {
    const count = state.lastOperationResult.result.warnings.length;
    return {
      tone: "warning" as const,
      text: `Finished with ${count} warning${count === 1 ? "" : "s"}. Details are under Debugging.`,
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
  const upToDate = !hasProblematicManagedPackageState(pkg) && pkg.versionComparison === "equal";
  const showTargetSuffix =
    status !== "" && !upToDate && pkg.targetVersion !== "unknown";
  const targetSuffix = showTargetSuffix ? ` → ${pkg.targetVersion}` : "";

  if (!pkg.installed) {
    return clampText(`Not installed${targetSuffix}`, 52);
  }

  if (!status) {
    return clampText(displayedVersion, 40);
  }

  // No version to show, so the status alone says it.
  if (pkg.versionName === null) {
    return clampText(`${status}${targetSuffix}`, 52);
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

/**
 * "Update to 2026-09-29.2" rather than "Update": the button names the release
 * it installs. Only the label changes. The command, its guards and its
 * confirmation are the controller's.
 */
function primaryActionCommand(
  state: InstallControllerState,
  command: InstallActionCommand,
): InstallActionCommand {
  const version = state.target?.version ?? null;
  const action = state.inspection?.actionState.action;
  if (!version || state.stage !== "connected-idle") return command;
  if (action === "Update") return { ...command, label: `Update to ${version}` };
  if (action === "Install") return { ...command, label: `Install Luma ${version}` };
  return command;
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
  // Uninstall is destructive and rare, so it lives here rather than beside
  // the one action the wearer came for.
  return [
    createActionFromCommand("installApkFile", commands.installApkFile),
    createActionFromCommand("uninstall", commands.uninstall),
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

/**
 * When the Pin already has everything the server publishes, or more,
 * reinstalling is not the next step. It stays one click away as a link.
 */
function demotesReinstall(state: InstallControllerState) {
  return isUpToDate(state) || isAheadOfServer(state);
}

function getPrimaryAction(
  state: InstallControllerState,
  commands: InstallControllerCommands,
): PrimaryCardActionViewModel | null {
  if (isUpToDate(state) && !isLocked(state)) {
    return {
      key: "goToCenter",
      label: commands.goToCenter.label,
      disabled: false,
      reason: null,
      href: commands.goToCenter.href,
    };
  }

  return (
    createActionFromCommand("recheck", commands.recheck) ??
    (demotesReinstall(state)
      ? null
      : createActionFromCommand("primaryAction", primaryActionCommand(state, commands.primaryAction))) ??
    createActionFromCommand("connect", commands.connect) ??
    createActionFromLink("goToCenter", commands.goToCenter)
  );
}

function getSecondaryActions(
  state: InstallControllerState,
  commands: InstallControllerCommands,
  primary: PrimaryCardActionViewModel | null,
): PrimaryCardActionViewModel[] {
  return [
    demotesReinstall(state)
      ? createActionFromCommand("primaryAction", commands.primaryAction)
      : null,
    createActionFromCommand("removeConflicts", commands.removeConflicts),
    createActionFromCommand("recheck", commands.recheck),
    createActionFromCommand("startOver", commands.startOver),
  ].filter(
    (action): action is PrimaryCardActionViewModel =>
      // Never offer the primary action a second time.
      action !== null && action.key !== primary?.key,
  );
}

/** The card's three steps, from the same state the summary reads. */
function getSteps(
  state: InstallControllerState,
  primary: PrimaryCardActionViewModel | null,
): PrimaryCardStepViewModel[] {
  const connected = state.connection !== null;
  const target = state.target?.version ?? null;
  const installed = installedLumaRelease(state.inspection);
  const installSucceeded =
    state.stage === "result" &&
    state.lastOperationResult?.kind === "install" &&
    state.lastOperationResult.result.success;
  const finished = installSucceeded || (isUpToDate(state) && !isLocked(state));
  const action = state.inspection?.actionState.action;

  let title = "Update your Pin";
  let detail: string | null = "Center checks your Pin and offers the Luma release on your server.";
  if (finished) {
    title = "Your Pin is up to date";
    detail = target ? `Luma ${target} is installed.` : null;
  } else if (isLocked(state)) {
    title = "Unlock your Pin";
    detail = "Enter your passcode on your Pin, then choose Check again.";
  } else if (action === "Update" && target) {
    title = `Update to ${target}`;
    detail = installed && installed !== target ? `From ${installed} to ${target}.` : `Installs Luma ${target}.`;
  } else if (action === "Install" && target) {
    title = `Install Luma ${target}`;
    detail = "It takes a few minutes, and your Pin restarts.";
  } else if (action === "Repair" && target) {
    title = "Repair Luma";
    detail = `Installs Luma ${target} again.`;
  } else if (isAheadOfServer(state)) {
    title = "Your Pin is newer than your server";
    detail = null;
  }

  const primaryKey = primary?.key ?? null;
  return [
    {
      number: 1,
      title: "Place your Pin on the interposer and plug it into this computer",
      detail: "This works in desktop Chrome or Edge.",
      state: connected ? "done" : "active",
      holdsPrimaryAction: false,
    },
    {
      number: 2,
      title: "Connect over USB",
      detail: connected
        ? "Connected."
        : "Choose your Pin in the list your browser shows.",
      state: connected ? "done" : "active",
      holdsPrimaryAction: !connected && primaryKey === "connect",
    },
    {
      number: 3,
      title,
      detail,
      state: finished ? "done" : connected ? "active" : "waiting",
      holdsPrimaryAction:
        connected && (primaryKey === "primaryAction" || primaryKey === "recheck"),
    },
  ];
}

export function derivePrimaryCardViewModel(
  state: InstallControllerState,
  commands: InstallControllerCommands,
): PrimaryCardViewModel {
  const summary = getBaseSummary(state);
  const notice = getNotice(state);
  const primaryAction = getPrimaryAction(state, commands);

  return {
    title: clampText(summary.title, 30),
    copy: clampText(summary.copy, 140),
    notice: notice
      ? {
          tone: notice.tone,
          text: clampText(notice.text, 320),
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
    steps: getSteps(state, primaryAction),
    packageRows: state.connection === null ? [] : getPackageRows(state),
    conflictRows: state.connection === null ? [] : getConflictRows(state),
    overflowActions: getOverflowActions(state, commands),
    primaryAction,
    secondaryActions: getSecondaryActions(state, commands, primaryAction),
  };
}
