"use client";

/**
 * The confirmation gate in front of every destructive device action, ported
 * from the retired Setup SPA's `install/app/useInstallActionConfirmation.ts`
 * with no behavioural change.
 *
 * Nothing here is cosmetic. Each requirement guards a real hazard on somebody's
 * device, and the set is deliberately additive:
 *
 *  - `risk`, shown once per session before the first destructive action.
 *  - `unsupported-device`, shown once per CONNECTION (keyed on serial+name) when
 *    the device fails the Humane Ai Pin identity check, so acknowledging it for
 *    one Pin never carries over to the next one plugged in.
 *  - `uninstall` / `remove-conflicts` / `remove-unrecognized`, what the action
 *    removes.
 *  - `newer-than-target`, the installed packages are ahead of the resolved
 *    release. Continuing is a downgrade.
 *  - `known-conflicts`, another Ai Pin project's packages are present, which
 *    forces the "remove first" choice rather than a plain continue.
 *  - `foreign-apps`, another project's builds occupy Luma's exact package
 *    names, so the only path forward is the recovery wipe, routed through the
 *    same `bootstrap-recovery` choice as the entry below.
 *  - `bootstrap-recovery`, the setup-helper flow will be re-run and app data wiped.
 *  - `first-install`, the same setup-helper flow on a Pin with nothing of
 *    Luma's on it (`inspectionIsFirstInstall`). It is the same operation and
 *    the same `bootstrap-recovery` choice, worded as the install it is, since
 *    there is no Luma app data to erase.
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
  inspectionHasForeignSigners,
  inspectionIsFirstInstall,
  inspectionRequiresBootstrapRecovery,
  MANAGED_PACKAGE_ROLES,
  PIN_RELEASE_SIGNER_IDENTITY,
  type InstallControllerCommands,
  type InstallControllerState,
} from "@/lib/pin-install";

type PendingAction = "primary" | "uninstall" | "remove-conflicts" | "remove-unrecognized";

export type InstallConfirmationChoiceAction =
  | PendingAction
  | "fix-conflicts-and-install"
  | "bootstrap-recovery"
  | "fix-conflicts-and-bootstrap-recovery";

type ConfirmationRequirementKind =
  | "risk"
  | "unsupported-device"
  | "uninstall"
  | "newer-than-target"
  | "known-conflicts"
  | "foreign-apps"
  | "remove-conflicts"
  | "remove-unrecognized"
  | "bootstrap-recovery"
  | "first-install";

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
  requestUninstall(): Promise<void>;
  requestRemoveConflicts(): Promise<void>;
  requestRemoveUnrecognized(): Promise<void>;
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

/** "Update this Pin?", the question the confirm button answers. */
function getPrimaryActionQuestion(label: string): string {
  switch (label) {
    case "Update":
      return "Update this Pin?";
    case "Repair":
      return "Repair this Pin?";
    case "Reinstall":
      return "Reinstall Luma on this Pin?";
    default:
      return "Install Luma on this Pin?";
  }
}

/** Names the exact Pin and release, so the wearer confirms what will change. */
function getPrimaryActionBody(state: InstallControllerState): string {
  const release = state.target?.version
    ? `Luma ${state.target.version}`
    : "the Luma release on your server";
  const serial = state.connection?.serial;
  return `Center installs ${release} on ${serial ? `the Pin with serial ${serial}` : "this Pin"}. Keep it unlocked and on the cable until Center says it’s done.`;
}

function createRiskRequirement(): InstallConfirmationRequirement {
  return {
    kind: "risk",
    title: "This changes your Pin’s system software",
    description:
      "If the cable comes loose or the Pin locks partway through, it may need a repair from this page before it works again.",
  };
}

function createUnsupportedDeviceRequirement(): InstallConfirmationRequirement {
  return {
    kind: "unsupported-device",
    title: "This isn’t a recognized Ai Pin",
    description:
      "This device doesn’t identify as a Humane Ai Pin, so Center won’t move Luma onto it.",
  };
}

function createUninstallRequirement(): InstallConfirmationRequirement {
  return {
    kind: "uninstall",
    title: "What uninstalling does",
    description:
      "Center removes Luma from this Pin, removes its connection to your server, and turns the original Humane apps back on where it can.",
  };
}

function createNewerThanTargetRequirement(): InstallConfirmationRequirement {
  return {
    kind: "newer-than-target",
    title: "This downgrades your Pin",
    description:
      "Some Luma software on this Pin is newer than your server’s release. Continuing replaces it with the older release.",
  };
}

/**
 * PenumbraOS v0 leaves its own files on the device, and its removal flow takes
 * them with it (guides/connect-your-pin.md). Say so before the removal runs,
 * because the wearer may want to pull a backup first.
 */
const FILE_CLEANUP_NOTICE =
  "\n\nCenter also removes PenumbraOS's own files in /sdcard/penumbra and /data/local/tmp/bin. Back them up first if you want to keep them: adb pull /sdcard/penumbra penumbra-backup";

function detectedConflictsCleanupFiles(
  state: InstallControllerState,
): boolean {
  return (state.inspection?.detectedConflicts ?? []).some(
    (conflict) => (conflict.cleanupFilePaths?.length ?? 0) > 0,
  );
}

function createKnownConflictsRequirement(
  state: InstallControllerState,
): InstallConfirmationRequirement {
  const formattedConflicts = formatDetectedPackageConflicts(
    state.inspection?.detectedConflicts ?? [],
  );

  return {
    kind: "known-conflicts",
    title: "Apps from another Ai Pin project",
    description:
      "These apps conflict with Luma, so Center removes them first:\n\n" +
      formattedConflicts +
      (detectedConflictsCleanupFiles(state) ? FILE_CLEANUP_NOTICE : ""),
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
    title: "Apps that will be removed",
    description:
      `These apps conflict with Luma:\n\n${formattedConflicts}` +
      (detectedConflictsCleanupFiles(state) ? FILE_CLEANUP_NOTICE : ""),
  };
}

function createRemoveUnrecognizedRequirement(
  state: InstallControllerState,
): InstallConfirmationRequirement {
  const packageIds = state.inspection?.unrecognizedPackages ?? [];
  return {
    kind: "remove-unrecognized",
    title: "Apps that will be removed",
    description:
      "These apps are not part of Luma or this Pin's original software. Center removes the ones you confirmed.\n\n" +
      packageIds.join("\n"),
  };
}

function createBootstrapRecoveryRequirement(): InstallConfirmationRequirement {
  return {
    kind: "bootstrap-recovery",
    title: "Recovery erases Luma’s app data",
    description:
      "The part of Luma that installs updates is missing or not working. Recovery removes Luma and its app data from this Pin, sets that part up again, then installs the release from your server.",
  };
}

function foreignSignerPackageIds(state: InstallControllerState): string[] {
  const packages = state.inspection?.packages;
  if (!packages) {
    return [];
  }
  return MANAGED_PACKAGE_ROLES.flatMap((role) =>
    packages[role].installed &&
    packages[role].signerIdentity !== PIN_RELEASE_SIGNER_IDENTITY
      ? [packages[role].packageName]
      : [],
  );
}

function createForeignAppsRequirement(
  state: InstallControllerState,
): InstallConfirmationRequirement {
  return {
    kind: "foreign-apps",
    title: "Another project's apps are on this Pin",
    description:
      "These apps use Luma’s package names but are signed by a different key:\n\n" +
      foreignSignerPackageIds(state).join("\n") +
      "\n\nRecovery removes them with their data, then installs Luma’s signed apps.",
  };
}

function createFirstInstallRequirement(): InstallConfirmationRequirement {
  return {
    kind: "first-install",
    title: "What installing does",
    description:
      "Center installs Luma’s five apps and changes the Pin’s system software. It turns off Humane’s update and usage-reporting apps and makes Luma the home screen. Luma isn’t on this Pin yet, so there is no Luma data to erase.",
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
  // Same operation as a recovery; only the words differ.
  const firstInstall =
    bootstrapRecovery && inspectionIsFirstInstall(options.state.inspection);
  // Another project's builds under Luma's package names: nothing Luma-signed
  // is retained, so the confirm routes through the recovery choice.
  const foreignApps =
    options.action === "primary" &&
    inspectionHasForeignSigners(options.state.inspection);

  if (!options.riskAcknowledged) {
    requirements.push(createRiskRequirement());
  }

  if (unsupportedDevice && !options.unsupportedDeviceConfirmedForSession) {
    requirements.push(createUnsupportedDeviceRequirement());
  }

  if (options.action === "uninstall") {
    requirements.push(createUninstallRequirement());
  }

  if (options.action === "remove-conflicts") {
    requirements.push(createRemoveConflictsRequirement(options.state));
  }

  if (options.action === "remove-unrecognized") {
    requirements.push(createRemoveUnrecognizedRequirement(options.state));
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

  if (foreignApps) {
    requirements.push(createForeignAppsRequirement(options.state));
  }

  if (firstInstall) {
    requirements.push(createFirstInstallRequirement());
  } else if (bootstrapRecovery) {
    requirements.push(createBootstrapRecoveryRequirement());
  }

  if (requirements.length === 0) {
    return null;
  }

  if (hasKnownConflicts) {
    return {
      action: options.action,
      title: "Remove conflicting apps first?",
      body: "This Pin has apps from another Ai Pin project. Center removes them, then continues.",
      choices: bootstrapRecovery
        ? [
            {
              action: "fix-conflicts-and-bootstrap-recovery",
              label: firstInstall ? "Remove and install" : "Remove and recover",
              tone: "primary",
              recommended: true,
            },
          ]
        : [
            {
              action: "fix-conflicts-and-install",
              label: `Remove and ${primaryActionLabel.toLowerCase()}`,
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
      firstInstall
        ? "Install Luma on this Pin?"
        : bootstrapRecovery && options.action === "primary"
        ? "Recover this Pin?"
        : options.action === "uninstall"
          ? "Uninstall Luma?"
          : options.action === "remove-conflicts"
            ? "Remove conflicting apps?"
            : options.action === "remove-unrecognized"
              ? "Remove unrecognized apps?"
              : getPrimaryActionQuestion(primaryActionLabel),
    body:
      options.action === "primary"
        ? getPrimaryActionBody(options.state)
        : options.action === "remove-conflicts"
          ? "Center removes these apps from this Pin. Luma stays as it is."
          : options.action === "remove-unrecognized"
            ? "Center removes these apps from this Pin. Luma stays as it is."
            : "Your Pin stops using Luma until you install it again.",
    choices: [
      {
        action:
          (bootstrapRecovery || foreignApps) && options.action === "primary"
            ? "bootstrap-recovery"
            : options.action,
        label:
          firstInstall
            ? "Install Luma"
            : foreignApps
            ? "Replace and install"
            : bootstrapRecovery && options.action === "primary"
            ? "Start recovery"
            : options.action === "primary"
              ? primaryActionLabel
              : options.action === "remove-conflicts" || options.action === "remove-unrecognized"
                  ? "Remove apps"
                  : "Uninstall",
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
  runUninstall: () => Promise<void>;
  runRemoveConflicts: () => Promise<void>;
  runRemoveUnrecognized: () => Promise<void>;
  runFixConflictsThenPrimaryAction: (options?: {
    readonly bootstrapRecoveryConfirmed?: boolean;
  }) => Promise<void>;
}): InstallActionConfirmation {
  const {
    state,
    commands,
    runPrimaryAction,
    runUninstall,
    runRemoveConflicts,
    runRemoveUnrecognized,
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

    if (
      dialog.action === "remove-unrecognized" &&
      (!commands.removeUnrecognized.visible || commands.removeUnrecognized.disabled)
    ) {
      return null;
    }

    return dialog;
  }, [
    commands.primaryAction.disabled,
    commands.primaryAction.visible,
    commands.removeConflicts.disabled,
    commands.removeConflicts.visible,
    commands.removeUnrecognized.disabled,
    commands.removeUnrecognized.visible,
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

      if (action === "remove-unrecognized") {
        if (
          !commands.removeUnrecognized.visible ||
          commands.removeUnrecognized.disabled
        ) {
          return;
        }

        await runRemoveUnrecognized();
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
      commands.removeUnrecognized.disabled,
      commands.removeUnrecognized.visible,
      commands.uninstall.disabled,
      commands.uninstall.visible,
      runFixConflictsThenPrimaryAction,
      runPrimaryAction,
      runRemoveConflicts,
      runRemoveUnrecognized,
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

  const requestRemoveUnrecognized = useCallback(async () => {
    if (
      !commands.removeUnrecognized.visible ||
      commands.removeUnrecognized.disabled
    ) {
      return;
    }

    const nextDialog = createDialogForAction({
      action: "remove-unrecognized",
      state,
      riskAcknowledged,
      unsupportedDeviceConfirmedForSession,
    });

    if (nextDialog) {
      setDialog(nextDialog);
      return;
    }

    await executeAction("remove-unrecognized");
  }, [
    commands.removeUnrecognized.disabled,
    commands.removeUnrecognized.visible,
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
    requestUninstall,
    requestRemoveConflicts,
    requestRemoveUnrecognized,
    dismissDialog,
    confirmDialog,
  };
}
