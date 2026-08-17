"use client";

/**
 * The confirmation gate in front of every destructive device action — ported
 * from the retired Setup SPA's `install/app/useInstallActionConfirmation.ts`
 * with no behavioural change.
 *
 * Nothing here is cosmetic. Each requirement guards a real hazard on somebody's
 * device, and the set is deliberately additive:
 *
 *  - `risk` — shown once per session before the first destructive action.
 *  - `unsupported-device` — shown once per CONNECTION (keyed on serial+name) when
 *    the device fails the Humane Ai Pin identity check, so acknowledging it for
 *    one Pin never carries over to the next one plugged in.
 *  - `rollback` / `uninstall` / `remove-conflicts` — what the action removes.
 *  - `newer-than-target` — the installed packages are ahead of the resolved
 *    release; continuing is a downgrade.
 *  - `known-conflicts` — another Ai Pin project's packages are present, which
 *    forces the "remove first" choice rather than a plain continue.
 *  - `bootstrap-recovery` — the exploit chain will be re-run and app data wiped.
 *
 * The `effectiveDialog` memo is also load-bearing: a dialog whose action became
 * invisible or disabled while it was open (an inspection landed, the device
 * dropped) resolves to null instead of executing against stale state, and
 * `confirmDialog` refuses any action that is not one of the open dialog's own
 * choices.
 */

import { useCallback, useMemo, useState } from "react";
import type { AdbConnectionInfo } from "@/lib/pin-device/adb";
import {
  formatDetectedPackageConflicts,
  inspectionRequiresBootstrapRecovery,
  type InstallControllerCommands,
  type InstallControllerState,
} from "@/lib/pin-install";

type PendingAction = "primary" | "rollback" | "uninstall" | "remove-conflicts";

export type InstallConfirmationChoiceAction =
  | PendingAction
  | "fix-conflicts-and-install"
  | "bootstrap-recovery"
  | "fix-conflicts-and-bootstrap-recovery";

type ConfirmationRequirementKind =
  | "risk"
  | "unsupported-device"
  | "rollback"
  | "uninstall"
  | "newer-than-target"
  | "known-conflicts"
  | "remove-conflicts"
  | "bootstrap-recovery";

export interface InstallConfirmationRequirement {
  readonly kind: ConfirmationRequirementKind;
  readonly title: string;
  readonly description: string;
}

export interface InstallConfirmationChoice {
  readonly action: InstallConfirmationChoiceAction;
  readonly label: string;
  readonly tone: "primary" | "secondary";
  readonly recommended?: boolean;
}

export interface InstallConfirmationDialog {
  readonly action: PendingAction;
  readonly title: string;
  readonly body: string;
  readonly choices: readonly InstallConfirmationChoice[];
  readonly requirements: readonly InstallConfirmationRequirement[];
}

export interface InstallActionConfirmation {
  readonly dialog: InstallConfirmationDialog | null;
  requestPrimaryAction(): Promise<void>;
  requestRollback(): Promise<void>;
  requestUninstall(): Promise<void>;
  requestRemoveConflicts(): Promise<void>;
  dismissDialog(): void;
  confirmDialog(action: InstallConfirmationChoiceAction): Promise<void>;
}

function buildConnectionSessionKey(
  connection: AdbConnectionInfo | null,
): string | null {
  if (!connection) {
    return null;
  }

  return `${connection.serial}:${connection.name}`;
}

function getPrimaryActionLabel(state: InstallControllerState): string {
  return state.inspection?.actionState.action ?? "Install";
}

function createRiskRequirement(): InstallConfirmationRequirement {
  return {
    kind: "risk",
    title: "Danger",
    description:
      "This action will modify key system components on the connected device and may have unintended consequences.",
  };
}

function createUnsupportedDeviceRequirement(): InstallConfirmationRequirement {
  return {
    kind: "unsupported-device",
    title: "Unsupported Device",
    description:
      "This device does not match the recognized Humane Ai Pin identity check. Package migration is blocked for this connection.",
  };
}

function createRollbackRequirement(): InstallConfirmationRequirement {
  return {
    kind: "rollback",
    title: "Confirm Rollback",
    description:
      "Rollback removes the managed Revival runtime packages and re-enables the configured stock/system packages when possible.",
  };
}

function createUninstallRequirement(): InstallConfirmationRequirement {
  return {
    kind: "uninstall",
    title: "Confirm Uninstall",
    description:
      "Uninstall removes the managed Revival runtime packages and re-enables the configured stock/system packages when possible.",
  };
}

function createNewerThanTargetRequirement(): InstallConfirmationRequirement {
  return {
    kind: "newer-than-target",
    title: "Installed Packages Are Newer Than Target",
    description:
      "One or more managed packages are newer than the currently resolved release target. Continuing will reinstall the device to the selected target versions.",
  };
}

function createKnownConflictsRequirement(
  state: InstallControllerState,
): InstallConfirmationRequirement {
  const formattedConflicts = formatDetectedPackageConflicts(
    state.inspection?.detectedConflicts ?? [],
  );

  return {
    kind: "known-conflicts",
    title: "Installation Conflicts",
    description:
      "The device has conflicting packages left over from other Ai Pin projects. These may cause issues with the installed system. Removal is recommended, but you may continue without removing them.\n\n" +
      formattedConflicts,
  };
}

function createRemoveConflictsRequirement(
  state: InstallControllerState,
): InstallConfirmationRequirement {
  const formattedConflicts = formatDetectedPackageConflicts(
    state.inspection?.detectedConflicts ?? [],
  );

  return {
    kind: "remove-conflicts",
    title: "Conflict Cleanup",
    description: `Known conflicting packages will be removed from the device.\n\n${formattedConflicts}`,
  };
}

function createBootstrapRecoveryRequirement(): InstallConfirmationRequirement {
  return {
    kind: "bootstrap-recovery",
    title: "Installer Recovery Required",
    description:
      "The system injector is missing or unhealthy. Recovery removes the managed runtime and its local app data, runs the physical bootstrap chain, and installs the verified target. A healthy installer is never replaced by this path.",
  };
}

export function createDialogForAction(options: {
  action: PendingAction;
  state: InstallControllerState;
  riskAcknowledged: boolean;
  unsupportedDeviceConfirmedForSession: boolean;
}): InstallConfirmationDialog | null {
  const requirements: InstallConfirmationRequirement[] = [];
  const primaryActionLabel = getPrimaryActionLabel(options.state);
  const unsupportedDevice =
    options.state.inspection !== null &&
    !options.state.inspection.device.recognizedAiPin;
  const hasKnownConflicts =
    options.action === "primary" &&
    Boolean(options.state.inspection?.hasDetectedConflicts);
  const bootstrapRecovery =
    options.action === "primary" &&
    inspectionRequiresBootstrapRecovery(options.state.inspection);

  if (!options.riskAcknowledged) {
    requirements.push(createRiskRequirement());
  }

  if (unsupportedDevice && !options.unsupportedDeviceConfirmedForSession) {
    requirements.push(createUnsupportedDeviceRequirement());
  }

  if (options.action === "rollback") {
    requirements.push(createRollbackRequirement());
  }

  if (options.action === "uninstall") {
    requirements.push(createUninstallRequirement());
  }

  if (options.action === "remove-conflicts") {
    requirements.push(createRemoveConflictsRequirement(options.state));
  }

  if (
    options.action === "primary" &&
    options.state.inspection?.actionState.warnings.newerThanTarget
  ) {
    requirements.push(createNewerThanTargetRequirement());
  }

  if (hasKnownConflicts) {
    requirements.push(createKnownConflictsRequirement(options.state));
  }

  if (bootstrapRecovery) {
    requirements.push(createBootstrapRecoveryRequirement());
  }

  if (requirements.length === 0) {
    return null;
  }

  if (hasKnownConflicts) {
    return {
      action: options.action,
      title: "Conflicts Detected",
      body: "We found packages from another Ai Pin runtime. Remove the known conflicts before Setup can continue.",
      choices: bootstrapRecovery
        ? [
            {
              action: "fix-conflicts-and-bootstrap-recovery",
              label: "Remove Conflicts and Recover",
              tone: "primary",
              recommended: true,
            },
          ]
        : [
            {
              action: "fix-conflicts-and-install",
              label: `Remove and ${primaryActionLabel}`,
              tone: "primary",
              recommended: true,
            },
          ],
      requirements,
    };
  }

  return {
    action: options.action,
    title:
      bootstrapRecovery && options.action === "primary"
        ? "Confirm Installer Recovery"
        : options.action === "rollback" &&
            requirements.length === 1 &&
            requirements[0].kind === "rollback"
          ? "Confirm Rollback"
          : options.action === "uninstall" &&
              requirements.length === 1 &&
              requirements[0].kind === "uninstall"
            ? "Confirm Uninstall"
            : options.action === "remove-conflicts" &&
                requirements.length === 1 &&
                requirements[0].kind === "remove-conflicts"
              ? "Review Conflict Cleanup"
              : "Review",
    body:
      bootstrapRecovery && options.action === "primary"
        ? "Review the recovery boundary before replacing a missing or unhealthy system injector."
        : options.action === "primary"
          ? `Review the following before continuing with ${primaryActionLabel}.`
          : options.action === "rollback"
            ? "Review the following before continuing with rollback."
            : options.action === "remove-conflicts"
              ? "Review the following before removing detected conflicts."
              : "Review the following before continuing with uninstall.",
    choices: [
      {
        action:
          bootstrapRecovery && options.action === "primary"
            ? "bootstrap-recovery"
            : options.action,
        label:
          bootstrapRecovery && options.action === "primary"
            ? "Start Recovery Bootstrap"
            : options.action === "primary"
              ? `Continue with ${primaryActionLabel}`
              : options.action === "rollback"
                ? "Continue with Rollback"
                : options.action === "remove-conflicts"
                  ? "Remove Conflicts"
                  : "Continue with Uninstall",
        tone: "primary",
        recommended: true,
      },
    ],
    requirements,
  };
}

export function useInstallActionConfirmation(options: {
  state: InstallControllerState;
  commands: InstallControllerCommands;
  runPrimaryAction: (options?: {
    readonly bootstrapRecoveryConfirmed?: boolean;
  }) => Promise<void>;
  runRollback: () => Promise<void>;
  runUninstall: () => Promise<void>;
  runRemoveConflicts: () => Promise<void>;
  runFixConflictsThenPrimaryAction: (options?: {
    readonly bootstrapRecoveryConfirmed?: boolean;
  }) => Promise<void>;
}): InstallActionConfirmation {
  const {
    state,
    commands,
    runPrimaryAction,
    runRollback,
    runUninstall,
    runRemoveConflicts,
    runFixConflictsThenPrimaryAction,
  } = options;
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [confirmedUnsupportedSessionKey, setConfirmedUnsupportedSessionKey] =
    useState<string | null>(null);
  const [dialog, setDialog] = useState<InstallConfirmationDialog | null>(null);

  const currentSessionKey = useMemo(
    () => buildConnectionSessionKey(state.connection),
    [state.connection],
  );
  const unsupportedDeviceConfirmedForSession =
    currentSessionKey !== null &&
    confirmedUnsupportedSessionKey === currentSessionKey;

  const effectiveDialog = useMemo(() => {
    if (!dialog) {
      return null;
    }

    if (
      dialog.action === "primary" &&
      (!commands.primaryAction.visible || commands.primaryAction.disabled)
    ) {
      return null;
    }

    if (
      dialog.action === "rollback" &&
      (!commands.rollback.visible || commands.rollback.disabled)
    ) {
      return null;
    }

    if (
      dialog.action === "uninstall" &&
      (!commands.uninstall.visible || commands.uninstall.disabled)
    ) {
      return null;
    }

    if (
      dialog.action === "remove-conflicts" &&
      (!commands.removeConflicts.visible || commands.removeConflicts.disabled)
    ) {
      return null;
    }

    return dialog;
  }, [
    commands.primaryAction.disabled,
    commands.primaryAction.visible,
    commands.removeConflicts.disabled,
    commands.removeConflicts.visible,
    commands.rollback.disabled,
    commands.rollback.visible,
    commands.uninstall.disabled,
    commands.uninstall.visible,
    dialog,
  ]);

  const executeAction = useCallback(
    async (action: InstallConfirmationChoiceAction) => {
      if (action === "fix-conflicts-and-bootstrap-recovery") {
        if (
          !commands.primaryAction.visible ||
          commands.primaryAction.disabled
        ) {
          return;
        }

        await runFixConflictsThenPrimaryAction({
          bootstrapRecoveryConfirmed: true,
        });
        return;
      }

      if (action === "fix-conflicts-and-install") {
        if (
          !commands.primaryAction.visible ||
          commands.primaryAction.disabled
        ) {
          return;
        }

        await runFixConflictsThenPrimaryAction();
        return;
      }

      if (action === "primary") {
        if (
          !commands.primaryAction.visible ||
          commands.primaryAction.disabled
        ) {
          return;
        }

        await runPrimaryAction();
        return;
      }

      if (action === "bootstrap-recovery") {
        if (
          !commands.primaryAction.visible ||
          commands.primaryAction.disabled
        ) {
          return;
        }

        await runPrimaryAction({ bootstrapRecoveryConfirmed: true });
        return;
      }

      if (action === "rollback") {
        if (!commands.rollback.visible || commands.rollback.disabled) {
          return;
        }

        await runRollback();
        return;
      }

      if (action === "remove-conflicts") {
        if (
          !commands.removeConflicts.visible ||
          commands.removeConflicts.disabled
        ) {
          return;
        }

        await runRemoveConflicts();
        return;
      }

      if (!commands.uninstall.visible || commands.uninstall.disabled) {
        return;
      }

      await runUninstall();
    },
    [
      commands.primaryAction.disabled,
      commands.primaryAction.visible,
      commands.removeConflicts.disabled,
      commands.removeConflicts.visible,
      commands.rollback.disabled,
      commands.rollback.visible,
      commands.uninstall.disabled,
      commands.uninstall.visible,
      runFixConflictsThenPrimaryAction,
      runPrimaryAction,
      runRemoveConflicts,
      runRollback,
      runUninstall,
    ],
  );

  const requestPrimaryAction = useCallback(async () => {
    if (!commands.primaryAction.visible || commands.primaryAction.disabled) {
      return;
    }

    const nextDialog = createDialogForAction({
      action: "primary",
      state,
      riskAcknowledged,
      unsupportedDeviceConfirmedForSession,
    });

    if (nextDialog) {
      setDialog(nextDialog);
      return;
    }

    await executeAction("primary");
  }, [
    commands.primaryAction.disabled,
    commands.primaryAction.visible,
    executeAction,
    riskAcknowledged,
    state,
    unsupportedDeviceConfirmedForSession,
  ]);

  const requestRollback = useCallback(async () => {
    if (!commands.rollback.visible || commands.rollback.disabled) {
      return;
    }

    const nextDialog = createDialogForAction({
      action: "rollback",
      state,
      riskAcknowledged,
      unsupportedDeviceConfirmedForSession,
    });

    if (nextDialog) {
      setDialog(nextDialog);
      return;
    }

    await executeAction("rollback");
  }, [
    commands.rollback.disabled,
    commands.rollback.visible,
    executeAction,
    riskAcknowledged,
    state,
    unsupportedDeviceConfirmedForSession,
  ]);

  const requestUninstall = useCallback(async () => {
    if (!commands.uninstall.visible || commands.uninstall.disabled) {
      return;
    }

    const nextDialog = createDialogForAction({
      action: "uninstall",
      state,
      riskAcknowledged,
      unsupportedDeviceConfirmedForSession,
    });

    if (nextDialog) {
      setDialog(nextDialog);
      return;
    }

    await executeAction("uninstall");
  }, [
    commands.uninstall.disabled,
    commands.uninstall.visible,
    executeAction,
    riskAcknowledged,
    state,
    unsupportedDeviceConfirmedForSession,
  ]);

  const requestRemoveConflicts = useCallback(async () => {
    if (
      !commands.removeConflicts.visible ||
      commands.removeConflicts.disabled
    ) {
      return;
    }

    const nextDialog = createDialogForAction({
      action: "remove-conflicts",
      state,
      riskAcknowledged,
      unsupportedDeviceConfirmedForSession,
    });

    if (nextDialog) {
      setDialog(nextDialog);
      return;
    }

    await executeAction("remove-conflicts");
  }, [
    commands.removeConflicts.disabled,
    commands.removeConflicts.visible,
    executeAction,
    riskAcknowledged,
    state,
    unsupportedDeviceConfirmedForSession,
  ]);

  const dismissDialog = useCallback(() => {
    setDialog(null);
  }, []);

  const confirmDialog = useCallback(
    async (action: InstallConfirmationChoiceAction) => {
      if (!effectiveDialog) {
        return;
      }

      if (!effectiveDialog.choices.some((choice) => choice.action === action)) {
        return;
      }

      const activeDialog = effectiveDialog;
      setDialog(null);

      if (
        activeDialog.requirements.some(
          (requirement) => requirement.kind === "risk",
        )
      ) {
        setRiskAcknowledged(true);
      }

      if (
        activeDialog.requirements.some(
          (requirement) => requirement.kind === "unsupported-device",
        ) &&
        currentSessionKey
      ) {
        setConfirmedUnsupportedSessionKey(currentSessionKey);
      }

      await executeAction(action);
    },
    [currentSessionKey, effectiveDialog, executeAction],
  );

  return {
    dialog: effectiveDialog,
    requestPrimaryAction,
    requestRollback,
    requestUninstall,
    requestRemoveConflicts,
    dismissDialog,
    confirmDialog,
  };
}
