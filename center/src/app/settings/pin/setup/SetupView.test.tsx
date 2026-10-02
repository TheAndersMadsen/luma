import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinSetupFacts } from "@/lib/pin-setup";
import SetupView from "./SetupView";

const refresh = vi.fn();
const NOW = Date.UTC(2026, 8, 23, 12, 0);

/** A Pin that is fully set up except for the owner's physical confirmation. */
function readyFacts(): PinSetupFacts {
  return {
    usb: {
      browserSupported: true,
      connected: true,
      connecting: false,
      recognizedAiPin: true,
      serial: "1H4MPA42230112",
      deviceId: "00aa11bb",
    },
    network: {
      state: "read",
      wifiEnabled: true,
      wifiNetwork: "Home",
      online: true,
      transport: "wifi",
      pinTimeEpochMs: NOW,
      clockSkewMs: 0,
      detail: null,
    },
    release: { availability: "published", version: "2026-08-27.1", detail: null },
    install: {
      state: "read",
      rolesTotal: 5,
      rolesInstalled: 5,
      rolesMatchingTarget: 5,
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
      reportingCount: 1,
      lastReportAtEpoch: 1_788_000_000,
      connectedPinReporting: true,
      connectedPinLastReportAtEpoch: 1_788_000_000,
      connectedPinPaired: true,
    },
    remote: { state: "assigned" },
    onboarding: { setupComplete: true },
    passcode: { state: "set" },
    physicalAcceptanceConfirmed: false,
    operator: true,
  };
}

const setupTestState = vi.hoisted(() => ({
  facts: null as unknown as PinSetupFacts,
  remoteUnpaired: null as "pin_not_paired" | "pin_binding_invalid" | null,
  client: null as unknown,
  connectionMode: "usb" as "usb" | "remote" | null,
  session: null as unknown,
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
    remoteUnpaired: setupTestState.remoteUnpaired,
    support: { supported: true, reasons: [] },
    client: setupTestState.client,
    connectionMode: setupTestState.connectionMode,
    borrowSession: () => {
      if (!setupTestState.session) throw new Error("No Pin is connected over USB.");
      return setupTestState.session;
    },
  }),
}));

vi.mock("./usePinSetupFacts", () => ({
  usePinSetupFacts: () => ({
    facts: setupTestState.facts,
    target: null,
    inspection: null,
    lastReportAtEpoch: null,
    refresh,
    confirmAcceptance: vi.fn(),
    refreshing: false,
  }),
}));

function withFacts(change: (facts: PinSetupFacts) => Partial<PinSetupFacts>) {
  const base = readyFacts();
  setupTestState.facts = { ...base, ...change(base) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockReset();
  setupTestState.facts = readyFacts();
  setupTestState.remoteUnpaired = null;
  setupTestState.client = null;
  setupTestState.connectionMode = "usb";
  setupTestState.session = null;
});

setupTestState.facts = readyFacts();

function stage(id: string) {
  return screen.getByTestId(`pin-setup-stage-${id}`);
}

describe("SetupView", () => {
  it("lets the owner configure services before connecting a physical Pin", () => {
    withFacts((facts) => ({ usb: { ...facts.usb, connected: false, connecting: false } }));
    render(<SetupView operator provisioningHref="/settings/pin/provision" />);
    expect(screen.getByText(/You can set up Center and your services now/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up Assistant & voice" })).toHaveAttribute(
      "href", "/settings/account/services",
    );
  });

  it("turns on remote access for a paired Pin over USB, with the ticket the Pin gives", async () => {
    const bridgeEndpoint = "a".repeat(64);
    const pinEndpoint = "b".repeat(64);
    const shell = vi.fn(async () => ({
      stdout: "Result: Bundle[{status=200, ok=true}]\n",
      stderr: "",
      exitCode: 0,
    }));
    setupTestState.session = { shell };
    const updateSettings = vi.fn(async () => ({ server: {} }));
    setupTestState.client = {
      mode: "usb",
      updateSettings,
      getIrohTicket: vi.fn(async () => ({ ticket: "endpoint-ticket", node_id: pinEndpoint })),
    };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/pin/bridge");
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({
          configured: true,
          connected: true,
          local_endpoint_id: bridgeEndpoint,
          device_id: "00aa11bb",
          remote_endpoint_id: pinEndpoint,
        });
      }
      return Response.json({
        configured: false,
        connected: false,
        local_endpoint_id: bridgeEndpoint,
        device_id: null,
        remote_endpoint_id: null,
      });
    }));
    withFacts(() => ({ remote: { state: "unassigned" } }));
    const user = userEvent.setup();
    render(<SetupView operator={false} provisioningHref={null} />);

    expect(stage("activate")).toHaveAttribute("data-state", "focus");
    await user.click(screen.getByRole("button", { name: "Turn on remote access" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(updateSettings).toHaveBeenCalledWith({
      server: { iroh_remote_center_enabled: true, iroh_remote_center_allowed_peers: [bridgeEndpoint] },
    });
    expect(shell).toHaveBeenCalledWith(expect.arrayContaining(["RESTART_RUNTIME"]));
    expect(writes).toEqual([{ device_id: "00aa11bb", ticket: "endpoint-ticket", node_id: pinEndpoint }]);
  });

  it("never turns on remote access through a remote client", async () => {
    const updateSettings = vi.fn();
    setupTestState.client = { mode: "remote", updateSettings, getIrohTicket: vi.fn() };
    setupTestState.connectionMode = "remote";
    setupTestState.session = { shell: vi.fn() };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    withFacts(() => ({ remote: { state: "unassigned" } }));
    const user = userEvent.setup();
    render(<SetupView operator provisioningHref="/settings/pin/provision" />);

    await user.click(screen.getByRole("button", { name: "Turn on remote access" }));

    expect(
      await screen.findByText("Luma on this Pin isn’t answering over USB yet. Choose Check again in a moment."),
    ).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pairs the exact connected Pin without asking the owner to retype its hardware ID", async () => {
    withFacts((facts) => ({ cloud: { ...facts.cloud, connectedPinPaired: false } }));
    const request = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    render(<SetupView operator provisioningHref="/settings/pin/provision" />);

    expect(screen.queryByRole("textbox", { name: /device id/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pair this Pin" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("/api/devices/pair");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init.body))).toEqual({ device_id: "00aa11bb" });
    expect(refresh).toHaveBeenCalledOnce();
  });
});
