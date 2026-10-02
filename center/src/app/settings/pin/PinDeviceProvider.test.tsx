import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PinDeviceProvider, usePinDevice } from "./PinDeviceProvider";

const fixture = vi.hoisted(() => ({
  health: vi.fn(),
  device: vi.fn(),
  connection: { serial: "test-pin", name: "Ai Pin" },
  status: "connected",
}));
vi.mock("@/lib/pin-session", () => ({
  usePinAdbSession: () => ({ status: fixture.status, connection: fixture.connection }),
  getTimedWearerPinAdbSession: () => ({ shell: vi.fn(), connectionInfo: fixture.connection }),
  getPinClient: async () => ({
    mode: "usb", health: fixture.health, getDevice: fixture.device,
    openStream: async () => new ReadableStream(),
  }),
  connectPinAdbSession: vi.fn(),
  disconnectPinAdbSession: vi.fn(),
}));
vi.mock("@/lib/pin-device/adb", () => ({
  getBrowserSupport: () => ({ supported: true, reasons: [] }),
  getDeviceIdentity: async () => ({ recognizedAiPin: true }),
}));

function Reading() {
  const pin = usePinDevice();
  return <output>{pin.serviceStatus} {pin.device?.display_name} {pin.error}</output>;
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("recovers a USB service that was offline at connection time without reopening USB", async () => {
  vi.useFakeTimers();
  fixture.health.mockRejectedValueOnce(new Error("Socket open failed")).mockResolvedValue({ ok: true });
  fixture.device.mockResolvedValue({ display_name: "fixture-version" });
  render(<QueryClientProvider client={new QueryClient()}><PinDeviceProvider><Reading /></PinDeviceProvider></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("status")).toHaveTextContent("offline");
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByRole("status")).toHaveTextContent("online fixture-version");
  expect(fixture.health).toHaveBeenCalledTimes(2);
});

it("a late health probe from the previous Pin cannot mark its replacement offline", async () => {
  vi.useFakeTimers();
  fixture.connection = { serial: "pin-a", name: "Ai Pin" };
  const oldProbe = Promise.withResolvers<{ ok: boolean }>();
  fixture.health.mockReset().mockResolvedValue({ ok: true });
  fixture.health.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true }).mockReturnValueOnce(oldProbe.promise);
  fixture.device.mockResolvedValue({ display_name: "old-pin" });
  const queryClient = new QueryClient();
  const view = () => <QueryClientProvider client={queryClient}><PinDeviceProvider><Reading /></PinDeviceProvider></QueryClientProvider>;
  const mounted = render(view());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(75_000); });
  expect(fixture.health).toHaveBeenCalledTimes(4);
  fixture.connection = { serial: "pin-b", name: "Ai Pin" };
  fixture.device.mockResolvedValue({ display_name: "new-pin" });
  mounted.rerender(view());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("status")).toHaveTextContent("online new-pin");
  await act(async () => { oldProbe.resolve({ ok: true }); });
  expect(screen.getByRole("status")).toHaveTextContent("online new-pin");
});
