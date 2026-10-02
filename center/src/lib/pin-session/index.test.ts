import type { AdbSessionStateChange } from "@/lib/pin-device/adb";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  changed: (_state: AdbSessionStateChange) => {},
  fromSession: vi.fn(),
  info: null as { serial: string; name: string } | null,
}));
vi.mock("@/lib/pin-device", () => ({
  UsbAdbHttpTransport: { fromSession: fixture.fromSession },
  PinClient: class {
    constructor(readonly transport: unknown) {}
  },
}));
vi.mock("@/lib/pin-device/adb", () => ({
  RemoteSignerAdbAuthStrategy: class {},
  createTimedAdbSessionTransport: (session: unknown) => session,
  WebUsbAdbSessionTransport: class {
    constructor(options: { onStateChange: typeof fixture.changed }) {
      fixture.changed = options.onStateChange;
    }
    get connectionInfo() {
      return fixture.info;
    }
    async disconnect() {
      fixture.info = null;
      fixture.changed({ phase: "idle", info: null });
    }
  },
}));

function connected(serial: string) {
  fixture.info = { serial, name: "Fixture Pin" };
  fixture.changed({ phase: "connected", info: fixture.info });
}

beforeEach(() => {
  vi.resetModules();
  fixture.fromSession.mockReset();
  fixture.info = null;
});

it("rejects a late tunnel from the previous Pin without replacing the current client", async () => {
  const session = await import("./index");
  session.getWearerPinAdbSession().connectionInfo;
  connected("pin-a");
  const old = Promise.withResolvers<unknown>();
  fixture.fromSession.mockReturnValueOnce(old.promise);
  const stale = session.getPinClient();
  const rejected = expect(stale).rejects.toThrow(/connection changed/i);
  fixture.changed({ phase: "connecting", info: null });
  connected("pin-b");
  const currentTransport = { device: "pin-b" };
  fixture.fromSession.mockResolvedValueOnce(currentTransport);
  const current = await session.getPinClient();
  old.resolve({ device: "pin-a" });
  await rejected;
  expect(await session.getPinClient()).toBe(current);
  expect(current.transport).toBe(currentTransport);
  expect(fixture.fromSession).toHaveBeenCalledTimes(2);
});

it("invalidates a pending tunnel even when the same serial reconnects", async () => {
  const session = await import("./index");
  session.getWearerPinAdbSession().connectionInfo;
  connected("pin-a");
  const old = Promise.withResolvers<unknown>();
  fixture.fromSession.mockReturnValueOnce(old.promise);
  const rejected = expect(session.getPinHttpTransport()).rejects.toThrow(
    /connection changed/i,
  );
  fixture.changed({ phase: "connecting", info: null });
  connected("pin-a");
  old.resolve({ device: "old-socket" });
  await rejected;
});

it("cannot return a cached client when disconnect occurs between the transport and client awaits", async () => {
  const session = await import("./index");
  session.getWearerPinAdbSession().connectionInfo;
  connected("pin-a");
  fixture.fromSession.mockResolvedValueOnce({ device: "pin-a" });
  await session.getPinClient();
  const pending = session.getPinClient();
  const rejected = expect(pending).rejects.toThrow(/connection changed/i);
  await session.disconnectPinAdbSession();
  await rejected;
});

it("shares one tunnel and client for concurrent requests on the current connection", async () => {
  const session = await import("./index");
  session.getWearerPinAdbSession().connectionInfo;
  connected("pin-a");
  fixture.fromSession.mockResolvedValueOnce({ device: "pin-a" });
  const clients = await Promise.all([
    session.getPinClient(),
    session.getPinClient(),
  ]);
  expect(clients[0]).toBe(clients[1]);
  expect(fixture.fromSession).toHaveBeenCalledTimes(1);
});
