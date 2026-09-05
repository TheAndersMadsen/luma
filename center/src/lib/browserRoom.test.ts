// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ events: new Map<string, (peer?: { identity: string }) => void>(),
  connect: vi.fn(), disconnect: vi.fn(), register: vi.fn(), invoke: vi.fn(), options: vi.fn() }));
vi.mock("livekit-client", () => ({
  RoomEvent: { Disconnected: "disconnected", Reconnecting: "reconnecting", SignalReconnecting: "signalReconnecting", ParticipantDisconnected: "participantDisconnected" },
  RpcError: class extends Error { constructor(readonly code: number, message: string) { super(message); } },
  Room: class {
    constructor(options: unknown) { mocks.options(options); }
    on(event: string, callback: () => void) { mocks.events.set(event, callback); }
    connect = mocks.connect; disconnect = mocks.disconnect; registerRpcMethod = mocks.register;
    localParticipant = { identity: "66666666-6666-6666-6666-666666666666", performRpc: mocks.invoke };
  },
}));
import { createBrowserRoom } from "./browserRoom";
import { roomConnection, runtimeEpoch } from "./browserRoom.test-support";
beforeEach(() => { vi.clearAllMocks(); mocks.events.clear(); mocks.connect.mockResolvedValue(undefined); mocks.disconnect.mockResolvedValue(undefined); mocks.invoke.mockResolvedValue("reply"); });
it("uses the bootstrap identity, ordinary data RPC and no automatic media subscription", async () => {
  const room = createBrowserRoom(); const receive = vi.fn(async () => "receipt"); const lost = vi.fn();
  const connection = roomConnection(runtimeEpoch); await room.connect(connection, receive, lost);
  expect(mocks.connect).toHaveBeenCalledWith(connection.url, connection.token, { autoSubscribe: false, websocketTimeout: 10000, peerConnectionTimeout: 10000 });
  const handler = mocks.register.mock.calls[0][1];
  await expect(handler({ callerIdentity: "other", payload: "forged" })).rejects.toMatchObject({ code: 1403 });
  expect(receive).not.toHaveBeenCalled();
  expect(await handler({ callerIdentity: "runtime", payload: "frame" })).toBe("receipt");
  await room.invoke("request"); expect(mocks.invoke).toHaveBeenCalledWith({ destinationIdentity: "runtime", method: "cosmos.coordinate.v1", payload: "request", responseTimeout: 3000 });
  room.close(); await expect(handler({ callerIdentity: "runtime", payload: "stale" })).rejects.toThrow();
});
it.each(["disconnected", "reconnecting", "signalReconnecting"])("permanently fences SDK %s", async event => {
  const room = createBrowserRoom(); const lost = vi.fn(); await room.connect(roomConnection(runtimeEpoch), vi.fn(), lost);
  expect(mocks.options.mock.calls[0][0].reconnectPolicy.nextRetryDelayInMs()).toBeNull();
  mocks.events.get(event)!(); mocks.events.get(event)!();
  expect(lost).toHaveBeenCalledTimes(1); expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  await expect(room.invoke("stale")).rejects.toThrow();
});
it("runtime replacement closes the room while unrelated peer departures do not", async () => {
  const room = createBrowserRoom(); const lost = vi.fn(); await room.connect(roomConnection(runtimeEpoch), vi.fn(), lost);
  mocks.events.get("participantDisconnected")!({ identity: "other" }); expect(lost).not.toHaveBeenCalled();
  mocks.events.get("participantDisconnected")!({ identity: "runtime" }); expect(lost).toHaveBeenCalledTimes(1);
});
