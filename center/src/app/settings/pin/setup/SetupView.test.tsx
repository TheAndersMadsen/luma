import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SetupView from "./SetupView";

const refresh = vi.fn();
const confirmAcceptance = vi.fn();
const setupTestState = vi.hoisted(() => ({
  capabilityOverrides: {} as Partial<
    Record<
      | "assistant"
      | "speech"
      | "weather"
      | "nearbyNavigation"
      | "musicPlayback"
      | "foodLogging",
      boolean | null
    >
  >,
  cloudReady: false,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("../PinDeviceProvider", () => ({
  usePinDevice: () => ({
    connect: vi.fn(),
    clearError: vi.fn(),
    error: null,
    support: { supported: true, reasons: [] },
  }),
}));

vi.mock("./usePinSetupFacts", () => ({
  usePinSetupFacts: () => ({
    facts: {
      usb: {
        browserSupported: true,
        connected: true,
        connecting: false,
        recognizedAiPin: true,
        serial: "1H4MPA42230112",
        deviceId: "00aa11bb",
      },
      release: { availability: "published", version: "2026-08-27.1", detail: null },
      install: {
        state: "read",
        rolesTotal: 4,
        rolesInstalled: 4,
        rolesMatchingTarget: 4,
        installerState: "target",
        runtimeRolesNewerThanTarget: 0,
        unhealthyRoles: 0,
        conflicts: 0,
        deviceLocked: false,
        detail: null,
      },
      server: {
        answering: "online",
        assistantModel: "gpt-5",
        capabilities: {
          assistant: true,
          speech: true,
          weather: true,
          nearbyNavigation: true,
          musicPlayback: true,
          foodLogging: true,
          ...setupTestState.capabilityOverrides,
        },
      },
      activation: {
        state: "active",
        edgeIpv4: "203.0.113.9",
        expectedEdgeState: "available",
        expectedEdgeIpv4: "203.0.113.9",
        detail: null,
      },
      cloud: {
        state: "live",
        pairedCount: 1,
        reportingCount: setupTestState.cloudReady ? 1 : 0,
        lastReportAtEpoch: setupTestState.cloudReady ? 1_788_000_000 : null,
        connectedPinReporting: setupTestState.cloudReady,
        connectedPinLastReportAtEpoch: setupTestState.cloudReady ? 1_788_000_000 : null,
        connectedPinPaired: setupTestState.cloudReady,
      },
      physicalAcceptanceConfirmed: false,
      operator: true,
    },
    target: null,
    inspection: null,
    lastReportAtEpoch: null,
    refresh,
    confirmAcceptance,
    refreshing: false,
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockReset();
  confirmAcceptance.mockReset();
  setupTestState.capabilityOverrides = {};
  setupTestState.cloudReady = false;
});

describe("SetupView", () => {
  it("shows evidence-backed readiness for every required capability", () => {
    render(<SetupView operator provisioningHref="/settings/pin/provision" />);

    for (const label of [
      "Assistant",
      "Speech",
      "Weather",
      "Nearby & navigation",
      "Music playback",
      "Food logging",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Ready")).toHaveLength(6);
  });

  it("renders an unread capability as checking instead of ready", () => {
    setupTestState.capabilityOverrides = { musicPlayback: null };

    render(<SetupView operator provisioningHref="/settings/pin/provision" />);

    expect(
      within(screen.getByTestId("pin-setup-capability-musicPlayback")).getByText(
        "Checking",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Checking capability readiness: Music playback/i)).toBeInTheDocument();
  });

  it("takes an operator with a missing capability directly to Services", () => {
    setupTestState.capabilityOverrides = { weather: false };

    render(<SetupView operator provisioningHref="/settings/pin/provision" />);

    expect(screen.getByRole("link", { name: "Set up services" })).toHaveAttribute(
      "href",
      "/settings/account/services",
    );
  });

  it("pairs the exact connected Pin without asking the owner to retype its hardware ID", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    render(<SetupView operator provisioningHref="/settings/pin/provision" />);

    expect(screen.queryByRole("textbox", { name: /device id/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pair this Pin" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/api/devices/pair");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init.body))).toEqual({ device_id: "00aa11bb" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("persists physical acceptance through the exact connected Pin", async () => {
    setupTestState.cloudReady = true;
    confirmAcceptance.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<SetupView operator provisioningHref="/settings/pin/provision" />);
    await user.click(
      screen.getByRole("button", { name: "Confirm microphone, speaker & gesture" }),
    );

    await waitFor(() => expect(confirmAcceptance).toHaveBeenCalledOnce());
  });
});
