import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinDeviceContextValue } from "../PinDeviceProvider";
import ProvisioningView from "./ProvisioningView";
import { RemoteAccessSetupError } from "./browserActivation";

const state = vi.hoisted(() => ({
  pin: null as unknown as Partial<PinDeviceContextValue>,
  provision: vi.fn(),
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
    state.pin = { ...remotePin(), serviceStatus: "online", connectionMode: "usb", client: { mode: "usb" } as PinDeviceContextValue["client"] };
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
    state.pin = { ...remotePin(), serviceStatus: "online", connectionMode: "usb", client: { mode: "usb" } as PinDeviceContextValue["client"] };
    let finish!: (value: unknown) => void;
    state.provision.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Connect this Pin to Cosmos" }));
    expect(screen.getByRole("button", { name: "Connecting to Cosmos…" })).toBeDisabled();
    finish({ state: "active" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Connecting to Cosmos|Connect this Pin to Cosmos/ })).not.toBeInTheDocument());
    expect(screen.getByText("Remote access is ready")).toBeInTheDocument();
  });
});
