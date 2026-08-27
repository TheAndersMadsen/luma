import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SetupView from "./SetupView";

const refresh = vi.fn();

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
      server: { answering: "online", assistantModel: "gpt-5", assistantReady: true },
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
        reportingCount: 0,
        lastReportAtEpoch: null,
        connectedPinReporting: false,
        connectedPinLastReportAtEpoch: null,
        connectedPinPaired: false,
      },
      physicalAcceptanceConfirmed: false,
      operator: true,
    },
    target: null,
    inspection: null,
    lastReportAtEpoch: null,
    refresh,
    refreshing: false,
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockReset();
  window.localStorage.clear();
});

describe("SetupView", () => {
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
});
