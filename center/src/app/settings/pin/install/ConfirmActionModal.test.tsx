import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  createInitialInstallControllerState,
  type InstallControllerState,
  type InstallInspectionResult,
  type ManagedPackageRole,
  type ManagedPackageVersionSnapshot,
  type ResolvedInstallTarget,
} from "@/lib/pin-install";
import { ConfirmActionModal } from "./ConfirmActionModal";
import { createDialogForAction } from "./useInstallActionConfirmation";

/*
 * The dialog in front of Install on a Pin without a working Device Installer.
 * The operation is the same bootstrap either way. A stock Pin with nothing of
 * Luma's on it reads as a first install. A Pin with Luma partly present or
 * broken reads as a recovery, because recovery erases Luma's app data.
 */

const TARGET = "2026-09-29.2";
const SUPPORTED = { supported: true, reasons: [], details: { secureContext: true, webUsb: true } } as const;

function pkg(role: ManagedPackageRole, installed: boolean): ManagedPackageVersionSnapshot {
  return {
    role,
    packageName: `com.example.${role}`,
    installed,
    healthy: installed,
    versionName: installed ? TARGET : null,
    signerIdentity: installed ? "dd07f452" : null,
    versionReadable: installed,
    querySucceeded: true,
    rawOutput: "",
    targetVersion: TARGET,
    versionComparison: installed ? "equal" : "missing",
    appId: installed ? 10_100 : null,
    baseApkPath: installed ? `/data/app/${role}/base.apk` : null,
    keepDataUpdateVerdict: installed ? "eligible" : null,
  } as unknown as ManagedPackageVersionSnapshot;
}

function inspection(options: {
  installedRoles: readonly ManagedPackageRole[];
  conflicts?: boolean;
}): InstallInspectionResult {
  const has = (role: ManagedPackageRole) => options.installedRoles.includes(role);
  const detectedConflicts = options.conflicts
    ? [{ id: "penumbra", label: "PenumbraOS", installedPackageIds: ["com.penumbraos.example"] }]
    : [];
  return {
    device: { manufacturer: "Humane", model: "Ai Pin", product: "mako", buildFingerprint: "humane/test", recognizedAiPin: true },
    target: null,
    targetResolutionFailed: false,
    targetResolutionErrorMessage: null,
    helperPresentUnexpectedly: false,
    readiness: {
      packageQueryabilityOk: true,
      settleDelayMs: 0,
      packageResults: [],
      credentialState: { state: "unlocked", ceAvailableRaw: "1" },
    },
    packages: {
      installer: pkg("installer", has("installer")),
      hook: pkg("hook", has("hook")),
      server: pkg("server", has("server")),
      loader: pkg("loader", has("loader")),
    },
    detectedConflicts,
    hasDetectedConflicts: detectedConflicts.length > 0,
    actionState: {
      action: options.installedRoles.length === 0 ? "Install" : "Repair",
      warnings: { newerThanTarget: false, unreadableVersion: false },
      reasons: [],
    },
    installActionsBlocked: false,
    installActionsBlockedReason: null,
  } as unknown as InstallInspectionResult;
}

function state(inspected: InstallInspectionResult): InstallControllerState {
  return {
    ...createInitialInstallControllerState(SUPPORTED),
    stage: "connected-idle",
    connection: { serial: "SERIAL-1", name: "Ai Pin" },
    target: { version: TARGET } as ResolvedInstallTarget,
    inspection: inspected,
  } as InstallControllerState;
}

function showPrimaryDialog(inspected: InstallInspectionResult) {
  const dialog = createDialogForAction({
    action: "primary",
    state: state(inspected),
    riskAcknowledged: true,
    unsupportedDeviceConfirmedForSession: false,
  });
  const onConfirm = vi.fn();
  render(<ConfirmActionModal dialog={dialog} onCancel={vi.fn()} onConfirm={onConfirm} />);
  return { onConfirm, dialog: screen.getByRole("alertdialog") };
}

describe("Install confirmation on a Pin without a working Device Installer", () => {
  it("presents a stock Pin as a first install, with the same bootstrap operation", async () => {
    const { onConfirm, dialog } = showPrimaryDialog(inspection({ installedRoles: [] }));

    expect(within(dialog).getByRole("heading", { name: "Install Luma on this Pin?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Center installs Luma’s five apps and changes the Pin’s system software.");
    expect(dialog).not.toHaveTextContent(/recover/i);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Install Luma" }));
    expect(onConfirm).toHaveBeenCalledWith("bootstrap-recovery");
  });

  it("offers Remove and install when a stock Pin has conflicting apps", async () => {
    const { onConfirm, dialog } = showPrimaryDialog(inspection({ installedRoles: [], conflicts: true }));

    expect(within(dialog).getByRole("heading", { name: "Remove conflicting apps first?" })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/recover/i);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove and install" }));
    expect(onConfirm).toHaveBeenCalledWith("fix-conflicts-and-bootstrap-recovery");
  });

  it("keeps the recovery warning when Luma is partly present", async () => {
    const { onConfirm, dialog } = showPrimaryDialog(inspection({ installedRoles: ["hook", "server", "loader"] }));

    expect(within(dialog).getByRole("heading", { name: "Recover this Pin?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Recovery erases Luma’s app data");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start recovery" }));
    expect(onConfirm).toHaveBeenCalledWith("bootstrap-recovery");
  });

  it("keeps Remove and recover when Luma is partly present and conflicting apps are too", () => {
    const { dialog } = showPrimaryDialog(inspection({ installedRoles: ["hook"], conflicts: true }));

    expect(dialog).toHaveTextContent("Recovery erases Luma’s app data");
    expect(within(dialog).getByRole("button", { name: "Remove and recover" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove and install" })).not.toBeInTheDocument();
  });

  it("keeps the recovery warning when the Device Installer is present but broken", () => {
    const broken = inspection({ installedRoles: ["installer", "hook", "server", "loader"] });
    const installer = { ...broken.packages.installer, healthy: false };
    const { dialog } = showPrimaryDialog({ ...broken, packages: { ...broken.packages, installer } });

    expect(within(dialog).getByRole("heading", { name: "Recover this Pin?" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Start recovery" })).toBeInTheDocument();
  });
});
