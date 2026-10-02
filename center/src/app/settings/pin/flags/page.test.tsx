import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { FeatureFlagsResponse } from "@/lib/pin-device";
import PinFlagsPane from "./page";

const pane = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/settings/pin/flags",
}));

vi.mock("../_lib/pinSession", () => ({
  usePinPaneSession: () => ({
    client: pane.client,
    status: pane.client ? "connected" : "disconnected",
    serviceStatus: "online",
    ready: true,
    attachedWithoutServer: false,
    device: null,
    connectionError: null,
  }),
}));

function gates(
  label: string,
  stored: boolean,
  options: { key?: string; warning?: string; restartRecommended?: boolean; writable?: boolean } = {},
): FeatureFlagsResponse {
  return {
    settings_global_note: "Stored on this Pin.",
    settings_global_gates: [
      {
        key: options.key ?? `humane.${label.toLowerCase()}.enabled`,
        label,
        default: false,
        restart_recommended: options.restartRecommended ?? false,
        writable: options.writable ?? true,
        warning: options.warning,
        stored_value: stored,
        current_value: stored,
        source: "stored",
        available: true,
        error: null,
      },
    ],
  };
}

function usbFlagsClient(response: unknown) {
  return {
    mode: "usb",
    getFeatureFlags: vi.fn(async () => response),
    updateFeatureFlags: vi.fn(async (request: unknown) => request),
  };
}

afterEach(() => {
  pane.client = null;
});

describe("Device flags pane", () => {
  it("keeps root risks visible while technical device details stay collapsed", async () => {
    const user = userEvent.setup();
    pane.client = usbFlagsClient(
      gates("Root access", false, {
        key: "luma_root_access_enabled",
        restartRecommended: true,
        warning:
          "The signed Luma Pin release installs root support on this Pin. When enabled, Luma re-roots the Pin after every reboot without a computer. It waits about two minutes after boot before starting, and rooting can take a while to finish. If an attempt restarts the Pin, Luma turns this flag off on the recovered boot to prevent a restart loop.",
      }),
    );
    render(<PinFlagsPane />);

    expect(await screen.findByText("Root access")).toBeInTheDocument();
    expect(screen.getByText("Restart recommended")).toBeInTheDocument();
    expect(screen.getByText(/may restart or freeze/u)).toBeVisible();
    expect(screen.getByText(/at least 20% battery/u)).toBeVisible();
    expect(screen.getByText("luma_root_access_enabled")).not.toBeVisible();
    expect(screen.getByText(/re-roots the Pin after every reboot/u)).not.toBeVisible();
    await user.click(screen.getByText("More details"));
    expect(
      screen.getByText(/re-roots the Pin after every reboot.*two minutes.*take a while/u),
    ).toBeVisible();
    expect(screen.getByText(/turns this flag off.*prevent a restart loop/u)).toBeInTheDocument();
  });

  it("keeps unused clock settings in technical details without an inactive main control", async () => {
    pane.client = usbFlagsClient(gates("Legacy clock gate", false, {
      key: "humane_clock_enabled",
      writable: false,
    }));
    render(<PinFlagsPane />);

    await screen.findByTestId("pin-flags-settings-global");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText("Clock setting")).not.toBeVisible();
    await userEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Clock setting")).toBeVisible();
  });

  it("keeps recovery visible when an unused locked setting has an unsafe stored value", async () => {
    const response = gates("Legacy clock gate", true, {
      key: "humane_clock_enabled",
      writable: false,
    });
    const client = usbFlagsClient(response);
    client.updateFeatureFlags.mockImplementation(async () => gates("Legacy clock gate", false, {
      key: "humane_clock_enabled",
      writable: false,
    }));
    pane.client = client;
    render(<PinFlagsPane />);

    expect(await screen.findByRole("button", { name: "Restore safe default" })).toBeVisible();
    expect(screen.getByText("Clock setting")).toBeVisible();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore safe default" }));
    await userEvent.click(screen.getByTestId("pin-save-button"));
    expect(client.updateFeatureFlags).toHaveBeenCalledWith({ settings_global: { humane_clock_enabled: null } });
    expect(await screen.findByText("Changes saved.")).toBeVisible();
  });

  it("never shows — or lets anyone save — the previous Pin's gates while the newly connected one is read", async () => {
    pane.client = usbFlagsClient(gates("Vision", true));
    const view = render(<PinFlagsPane />);
    expect(await screen.findByText("Vision")).toBeInTheDocument();

    let releaseB!: (response: unknown) => void;
    pane.client = usbFlagsClient(
      new Promise((resolve) => {
        releaseB = resolve;
      }),
    );
    view.rerender(<PinFlagsPane />);

    expect(screen.queryByText("Vision")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pin-save-button")).not.toBeInTheDocument();

    releaseB(gates("Fitness", false));
    expect(await screen.findByText("Fitness")).toBeInTheDocument();
    expect(screen.queryByText("Vision")).not.toBeInTheDocument();
    expect(screen.getByTestId("pin-save-button")).toBeInTheDocument();
  });
});
