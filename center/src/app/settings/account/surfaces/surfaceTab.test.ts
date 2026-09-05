// @vitest-environment-options {"url":"https://center.test"}
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SurfaceTab } from "./surfaceTab";
import { BROWSER_SURFACE_POSTURE } from "@/lib/contracts/surfaces";
import { BrowserRuntime } from "@/lib/browserRuntime";
import { incarnation, roomConnection, TestRoom } from "@/lib/browserRoom.test-support";
let tab: SurfaceTab; let runtime: BrowserRuntime; let room: TestRoom; const notify = vi.fn();
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); notify.mockClear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  room = new TestRoom(); runtime = new BrowserRuntime(crypto.randomUUID(), vi.fn(), vi.fn(), () => room);
  tab = new SurfaceTab(notify, vi.fn(), runtime);
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (url === "/api/surfaces") return Response.json({ surface: { ...BROWSER_SURFACE_POSTURE, surfaceId: tab.surfaceId,
      revision: 1, sequence: 0, visible: false, revoked: false, connected: true, available: false,
      connectionExpiresAt: Date.now() + 3600000, leaseExpiresAt: Date.now() + 45000 },
    connection: { token: "a".repeat(64), incarnation, expiresAt: Date.now() + 3600000 } });
    if (url === "/api/runtime/room") return Response.json(roomConnection(JSON.parse(options.body).epoch));
    return Response.json({});
  }));
});
afterEach(() => { tab.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("waits for approval, bootstraps once and heartbeats through the room", async () => {
  await vi.advanceTimersByTimeAsync(15000); expect(fetch).not.toHaveBeenCalled();
  await tab.approve(); await tick(); expect(notify).toHaveBeenLastCalledWith("visible"); notify.mockClear();
  await vi.advanceTimersByTimeAsync(15000); expect(notify).not.toHaveBeenCalledWith("pending");
  expect(room.messages().map(m => m.control.visible)).toEqual([true, true]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("immediately hides, records state, and leaves without silent reconnection", async () => {
  await tab.approve(); await tick(); const hidden = vi.spyOn(runtime, "hide");
  tab.visibility(false); expect(hidden).toHaveBeenCalled(); await tick(); expect(notify).toHaveBeenLastCalledWith("hidden");
  expect(room.close).not.toHaveBeenCalled(); tab.leave(); expect(room.close).toHaveBeenCalled();
  expect(notify).toHaveBeenLastCalledWith("inactive"); const count = vi.mocked(fetch).mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000); expect(fetch).toHaveBeenCalledTimes(count);
});
it("room failure stops heartbeats and leaves despite an unavailable release endpoint", async () => {
  await tab.approve(); await tick(); vi.mocked(fetch).mockRejectedValue(new Error("offline")); room.lost();
  expect(notify).toHaveBeenLastCalledWith("lost"); await tick();
  const count = room.invoke.mock.calls.length; await vi.advanceTimersByTimeAsync(60000); tab.visibility(true); await tick();
  expect(room.invoke).toHaveBeenCalledTimes(count); expect(notify).toHaveBeenLastCalledWith("lost");
});
it("late state completion cannot revive a room after loss", async () => {
  await tab.approve(); await tick(); let release!: (value: string) => void;
  room.invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  tab.visibility(true); await tick(); room.lost();
  release(JSON.stringify({ version: 1, kind: "accepted", duplicate: false })); await tick();
  expect(notify).toHaveBeenLastCalledWith("lost");
});
it("coalesces visibility while a state admission is pending", async () => {
  await tab.approve(); await tick(); let release!: (value: string) => void;
  room.invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  tab.visibility(true); await tick(); tab.visibility(false); tab.visibility(true); tab.visibility(false);
  release(JSON.stringify({ version: 1, kind: "accepted", duplicate: false })); await tick();
  expect(room.messages().map(m => m.control.visible)).toEqual([true, true, false]);
  expect(notify).toHaveBeenLastCalledWith("hidden");
});
it("late room bootstrap after leaving is ignored", async () => {
  let release!: () => void; room.connect.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
  const approving = tab.approve(); await tick(); tab.leave(); release(); await approving;
  expect(notify).toHaveBeenLastCalledWith("inactive"); expect(room.invoke).not.toHaveBeenCalled();
});
