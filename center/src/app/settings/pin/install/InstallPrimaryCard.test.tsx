import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  createInitialInstallControllerState,
  deriveInstallControllerCommands,
  type InstallControllerState,
  type InstallInspectionResult,
  type ManagedPackageRole,
  type ManagedPackageVersionSnapshot,
  type ResolvedInstallTarget,
} from "@/lib/pin-install";
import { InstallPrimaryCard } from "./InstallPrimaryCard";
import type { InstallController } from "./useInstallController";

/*
 * Settings → Advanced → Software & updates reads as three steps: plug the Pin
 * in, connect over USB, update. The controller's commands and guards are
 * unchanged. These states check the wording and where the one button sits.
 */

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const TARGET = "2026-09-29.2";
const OLD = "2026-08-01.1";
const SUPPORTED = { supported: true, reasons: [], details: { secureContext: true, webUsb: true } } as const;

function pkg(role: ManagedPackageRole, versionName: string): ManagedPackageVersionSnapshot {
  const comparison = versionName === TARGET ? "equal" : "older";
  return {
    role,
    packageName: `com.example.${role}`,
    installed: true,
    healthy: true,
    versionName,
    signerIdentity: "dd07f452",
    versionReadable: true,
    querySucceeded: true,
    rawOutput: `versionName=${versionName}`,
    targetVersion: TARGET,
    versionComparison: role === "installer" ? "equal" : comparison,
    appId: 10_100,
    baseApkPath: `/data/app/${role}/base.apk`,
    keepDataUpdateVerdict: "eligible",
  };
}

function inspection(options: { version: string; locked?: boolean }): InstallInspectionResult {
  const upToDate = options.version === TARGET;
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
      credentialState: options.locked
        ? { state: "locked", ceAvailableRaw: "0" }
        : { state: "unlocked", ceAvailableRaw: "1" },
    },
    packages: {
      installer: pkg("installer", TARGET),
      hook: pkg("hook", options.version),
      server: pkg("server", options.version),
      loader: pkg("loader", options.version),
    },
    detectedConflicts: [],
    hasDetectedConflicts: false,
    actionState: {
      action: upToDate ? "Reinstall" : "Update",
      warnings: { newerThanTarget: false, unreadableVersion: false },
      reasons: [],
    },
    installActionsBlocked: false,
    installActionsBlockedReason: null,
  } as InstallInspectionResult;
}

function connected(patch: Partial<InstallControllerState>): InstallControllerState {
  return {
    ...createInitialInstallControllerState(SUPPORTED),
    stage: "connected-idle",
    connection: { serial: "SERIAL-1", name: "Ai Pin" },
    target: { version: TARGET } as ResolvedInstallTarget,
    ...patch,
  } as InstallControllerState;
}

function show(state: InstallControllerState) {
  const controller = {
    state,
    commands: deriveInstallControllerCommands(state),
    connectAndInspect: vi.fn(async () => undefined),
    recheck: vi.fn(async () => undefined),
    runInstallApkFile: vi.fn(async () => undefined),
    startOver: vi.fn(async () => undefined),
  } as unknown as InstallController;
  const handlers = { onPrimaryAction: vi.fn(), onUninstall: vi.fn(), onRemoveConflicts: vi.fn() };
  render(<InstallPrimaryCard controller={controller} handlers={handlers} terminalHref={null} />);
  return { controller, handlers };
}

function step(number: 1 | 2 | 3) {
  return screen.getByTestId(`install-step-${number}`);
}

describe("Software & updates as three steps", () => {
  it("starts with plug in, then one Connect over USB button, with the browser note", async () => {
    const { controller } = show(createInitialInstallControllerState(SUPPORTED));

    expect(screen.getByRole("heading", { name: "Connect your Pin" })).toBeInTheDocument();
    expect(step(1)).toHaveTextContent("Place your Pin on the interposer and plug it into this computer");
    expect(step(1)).toHaveTextContent("This works in desktop Chrome or Edge.");
    expect(step(1)).toHaveAttribute("data-state", "active");
    const connect = within(step(2)).getByRole("button", { name: "Connect over USB" });
    expect(step(3)).toHaveAttribute("data-state", "waiting");
    expect(within(step(3)).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect over USB" })).toHaveLength(1);

    await userEvent.click(connect);
    expect(controller.connectAndInspect).toHaveBeenCalledTimes(1);
  });

  it("offers one Update to <version> button showing from and to", async () => {
    const { handlers } = show(connected({ inspection: inspection({ version: OLD }) }));

    expect(screen.getByRole("heading", { name: "An update is available" })).toBeInTheDocument();
    expect(step(1)).toHaveAttribute("data-state", "done");
    expect(step(2)).toHaveAttribute("data-state", "done");
    expect(step(3)).toHaveAttribute("data-state", "active");
    expect(step(3)).toHaveTextContent(`Update to ${TARGET}`);
    expect(step(3)).toHaveTextContent(`From ${OLD} to ${TARGET}.`);
    const update = within(step(3)).getByRole("button", { name: `Update to ${TARGET}` });
    expect(screen.getAllByRole("button", { name: `Update to ${TARGET}` })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Connect over USB" })).not.toBeInTheDocument();

    // The click goes to the controller's confirmation, never straight to an install.
    await userEvent.click(update);
    expect(handlers.onPrimaryAction).toHaveBeenCalledTimes(1);
  });

  it("says plainly when the Pin is up to date", () => {
    show(connected({ inspection: inspection({ version: TARGET }) }));

    expect(screen.getByRole("heading", { name: "Your Pin is up to date" })).toBeInTheDocument();
    expect(step(3)).toHaveAttribute("data-state", "done");
    expect(step(3)).toHaveTextContent("Your Pin is up to date");
    expect(step(3)).toHaveTextContent(`Luma ${TARGET} is installed.`);
    expect(screen.getByRole("link", { name: "Open Pin settings" })).toHaveAttribute("href", "/settings/pin");
    expect(screen.queryByRole("button", { name: /^Update to/ })).not.toBeInTheDocument();
  });

  it("asks for the passcode when the updated Pin is locked, with Check again as the next action", async () => {
    const { controller } = show(connected({ inspection: inspection({ version: TARGET, locked: true }) }));

    expect(screen.getByRole("heading", { name: "Unlock your Pin" })).toBeInTheDocument();
    expect(screen.getByText(`Luma ${TARGET} is installed. Enter your passcode on your Pin to start using it.`)).toBeInTheDocument();
    expect(step(3)).toHaveTextContent("Enter your passcode on your Pin, then choose Check again.");
    const again = within(step(3)).getByRole("button", { name: "Check again" });
    await userEvent.click(again);
    expect(controller.recheck).toHaveBeenCalledTimes(1);
  });

  it("keeps an update locked behind the passcode without weakening the guard", () => {
    show(connected({ inspection: inspection({ version: OLD, locked: true }) }));

    expect(screen.getByRole("heading", { name: "Unlock your Pin" })).toBeInTheDocument();
    expect(screen.getByText("Enter your passcode on your Pin. Center can update it once it’s unlocked.")).toBeInTheDocument();
    expect(within(step(3)).getByRole("button", { name: "Check again" })).toBeEnabled();
    const update = screen.queryByRole("button", { name: /^Update to/ });
    if (update) expect(update).toBeDisabled();
  });

  it("finishes on Your Pin is up to date after the install", () => {
    const installed = inspection({ version: TARGET });
    show(connected({
      stage: "result",
      inspection: installed,
      lastOperationResult: {
        kind: "install",
        result: { success: true, warnings: [], inspection: installed, error: null, failedPhase: null, deviceChangesStarted: true },
      } as InstallControllerState["lastOperationResult"],
    }));

    expect(screen.getByRole("heading", { name: "Your Pin is up to date" })).toBeInTheDocument();
    expect(step(3)).toHaveAttribute("data-state", "done");
    expect(screen.getByRole("link", { name: "Open Pin settings" })).toBeInTheDocument();
  });
});
