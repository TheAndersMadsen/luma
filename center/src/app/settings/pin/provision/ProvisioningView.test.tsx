import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosmosIdentityRefusedError } from "@/lib/pin-device/cosmosIdentity";
import type { PinDeviceContextValue } from "../PinDeviceProvider";
import ProvisioningView from "./ProvisioningView";
import {
  ActiveIdentityMismatchError,
  EnrollmentIncompleteError,
  OnboardingLaunchError,
  RemoteAccessSetupError,
  type ActivationStatus,
} from "./browserActivation";

const state = vi.hoisted(() => ({
  pin: null as unknown as Partial<PinDeviceContextValue>,
  provision: vi.fn(),
  switchServer: vi.fn(),
  reenroll: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("../PinDeviceProvider", () => ({ usePinDevice: () => state.pin }));
vi.mock("./browserActivation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browserActivation")>()),
  provisionConnectedPin: state.provision,
  switchPinToThisServer: state.switchServer,
  reenrollConnectedPin: state.reenroll,
}));

const OVERVIEW = {
  enrollment: {
    open: true,
    provisioning_configured: true,
    duc_ca_configured: true,
    user_id: "u-1",
    display_name: "Owner",
  },
  onboarding: { endpoint: "https://onboarding.cosmos.humane.cloud", authority: "luma" },
  device_edge_ipv4: "203.0.113.9",
  device_status_endpoint: "https://center.example/device-status/v1/report",
};

function remotePin(): Partial<PinDeviceContextValue> {
  return {
    status: "connected",
    connectionMode: "remote",
    connectionInfo: { serial: "1H4MPA42230112", name: "Ai Pin" } as PinDeviceContextValue["connectionInfo"],
    identity: { recognizedAiPin: true } as PinDeviceContextValue["identity"],
    client: { mode: "remote", updateSettings: vi.fn(), getIrohTicket: vi.fn() } as unknown as PinDeviceContextValue["client"],
    borrowSession: () => ({}) as ReturnType<PinDeviceContextValue["borrowSession"]>,
    connect: vi.fn(async () => undefined),
    refreshService: vi.fn(async () => undefined),
  };
}

function usbPin(): PinDeviceContextValue {
  return {
    ...remotePin(),
    serviceStatus: "online",
    connectionMode: "usb",
    client: { mode: "usb" } as PinDeviceContextValue["client"],
  } as PinDeviceContextValue;
}

function mismatchStatus(): ActivationStatus {
  return {
    ok: true,
    state: "active",
    consistent: true,
    managed: true,
    remoteGateEnabled: true,
    targetMatches: true,
    identityPresent: true,
    identityUsable: true,
    edgeIpv4: "192.0.2.1",
    fingerprintSha256: "a".repeat(64),
    rootCertificateSha256: "b".repeat(64),
    apiEndpoint: "https://api.cosmos.humane.cloud",
    onboardingEndpoint: "https://onboarding.cosmos.humane.cloud",
    deviceStatusEndpoint: "https://other.example/device-status/v1/report",
  };
}

function renderView() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url === "/api/admin/overview" ? Response.json(OVERVIEW) : Response.json({ set: true }),
  ));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProvisioningView />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  state.provision.mockReset();
  state.switchServer.mockReset();
  state.reenroll.mockReset();
});

describe("ProvisioningView", () => {
  it("never drives the Pin through the remote client while USB is attached", async () => {
    const remote = { mode: "remote", updateSettings: vi.fn(), getIrohTicket: vi.fn() };
    state.pin = remotePin();
    renderView();

    const button = await screen.findByRole("button", { name: "Connect this Pin to Cosmos" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText("USB is connected, but Luma isn’t responding yet. Keep your Pin connected and unlocked, then check the connection."),
    ).toBeInTheDocument();
    await userEvent.click(button);
    expect(state.provision).not.toHaveBeenCalled();
    expect(remote.updateSettings).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(state.pin.refreshService).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Install or repair Luma" })).toHaveAttribute("href", "/settings/pin/install");
  });

  it("shows activation as complete after a remote failure and gives that step a named retry", async () => {
    state.pin = usbPin();
    state.provision.mockRejectedValueOnce(new RemoteAccessSetupError(new Error("Remote access did not start on the Pin. Try again.")));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Connect this Pin to Cosmos" }));
    expect(await screen.findByText("Connected to Cosmos")).toBeInTheDocument();
    expect(screen.getByText("USB connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect this Pin to Cosmos" })).not.toBeInTheDocument();
    state.provision.mockResolvedValueOnce({ state: "active" });
    await userEvent.click(screen.getByRole("button", { name: "Retry remote access" }));
    await screen.findByText("Remote access is ready");
    expect(state.provision).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry remote access" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /guided setup/i }).length).toBeGreaterThan(0);
  });

  it("prevents duplicate activation while working and replaces the action after success", async () => {
    state.pin = usbPin();
    let finish!: (value: unknown) => void;
    state.provision.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Connect this Pin to Cosmos" }));
    expect(screen.getByRole("button", { name: "Connecting to Cosmos…" })).toBeDisabled();
    finish({ state: "active" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Connecting to Cosmos|Connect this Pin to Cosmos/ })).not.toBeInTheDocument());
    expect(screen.getByText("Remote access is ready")).toBeInTheDocument();
  });

  it("offers to switch a Pin that is active with another server and completes the switch", async () => {
    state.pin = usbPin();
    state.provision.mockRejectedValueOnce(new ActiveIdentityMismatchError(mismatchStatus()));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Connect this Pin to Cosmos" }));
    expect(
      await screen.findByText(/This Pin is connected to another Luma server \(edge IPv4 192\.0\.2\.1\)/),
    ).toBeInTheDocument();
    let finishSwitch!: (value: unknown) => void;
    state.switchServer.mockImplementationOnce(() => new Promise((resolve) => { finishSwitch = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: "Switch this Pin to this server" }));
    expect(screen.getByRole("button", { name: "Switching this Pin…" })).toBeDisabled();
    finishSwitch({ state: "active" });
    await screen.findByText("Remote access is ready");
    expect(state.switchServer).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Switch this Pin to this server" })).not.toBeInTheDocument();
  });

  it("surfaces a refused switch without offering it again", async () => {
    state.pin = usbPin();
    state.provision.mockRejectedValueOnce(new ActiveIdentityMismatchError(mismatchStatus()));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Connect this Pin to Cosmos" }));
    await screen.findByRole("button", { name: "Switch this Pin to this server" });
    state.switchServer.mockRejectedValueOnce(new CosmosIdentityRefusedError("The Pin refused the Cosmos identity change."));
    await userEvent.click(screen.getByRole("button", { name: "Switch this Pin to this server" }));
    expect(await screen.findByText("The Pin refused the Cosmos identity change.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch this Pin to this server" })).not.toBeInTheDocument();
    expect(screen.queryByText(/This Pin is connected to another Luma server/)).not.toBeInTheDocument();
  });

  it("offers to re-run a Pin's original setup when this server never issued its credential, and completes it", async () => {
    state.pin = usbPin();
    state.provision.mockRejectedValueOnce(new EnrollmentIncompleteError(mismatchStatus()));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Connect this Pin to Cosmos" }));
    expect(
      await screen.findByText(
        "This Pin finished its original setup before this server could issue its credential. Run this Pin's original setup to connect it.",
      ),
    ).toBeInTheDocument();
    let finishReenroll!: (value: unknown) => void;
    state.reenroll.mockImplementationOnce(() => new Promise((resolve) => { finishReenroll = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: "Run its original setup" }));
    expect(screen.getByRole("button", { name: "Running its setup…" })).toBeDisabled();
    finishReenroll({ state: "active" });
    await screen.findByText("Remote access is ready");
    expect(state.reenroll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Run its original setup" })).not.toBeInTheDocument();
  });

  it("warns when the setup screen did not open after a completed re-enrollment", async () => {
    state.pin = usbPin();
    state.provision.mockRejectedValueOnce(new EnrollmentIncompleteError(mismatchStatus()));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Connect this Pin to Cosmos" }));
    await screen.findByRole("button", { name: "Run its original setup" });
    state.reenroll.mockRejectedValueOnce(new OnboardingLaunchError(mismatchStatus()));
    await userEvent.click(screen.getByRole("button", { name: "Run its original setup" }));
    expect(
      await screen.findByText(
        "This Pin is connected to your server, but its setup screen didn't open. Restart the Pin and finish setup in Guided setup.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Connected to Cosmos")).toBeInTheDocument();
    expect(screen.getByText("Remote access is ready")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run its original setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect this Pin to Cosmos" })).not.toBeInTheDocument();
  });
});
