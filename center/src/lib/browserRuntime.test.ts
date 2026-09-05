// @vitest-environment-options {"url":"https://center.test"}
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserRuntime } from "./browserRuntime";
import { incarnation, roomConnection, TestRoom } from "./browserRoom.test-support";
import type { RenderCommand } from "./contracts/ambianceRuntime";
let runtime: BrowserRuntime; let room: TestRoom;
const surfaceId = "11111111-1111-1111-1111-111111111111";
const connection = () => ({ token: "a".repeat(64), incarnation, expiresAt: Date.now() + 3600000 });
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  room = new TestRoom(); runtime = new BrowserRuntime(surfaceId, vi.fn(), vi.fn(), () => room);
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => Response.json(roomConnection(JSON.parse(options.body).epoch))));
});
afterEach(() => { runtime.stop(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const command = (): RenderCommand => ({ version: 1, surfaceId, incarnation, actionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(), generation: 1, channel: "visual.card", expiresAt: Date.now() + 60000,
  content: { kind: "text", text: "Synthetic public text" }, contentDigest: createHash("sha256").update("Synthetic public text").digest("hex") });
it("fences a failed incarnation and cannot reconnect on a heartbeat", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));
  await expect(runtime.start(connection())).rejects.toThrow();
  await expect(runtime.start(connection())).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  await expect(runtime.start({ ...connection(), incarnation: crypto.randomUUID() })).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(2);
});
it("uses one increasing stream for visibility, input, acknowledgment and cancellation", async () => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); await runtime.input("public request");
  const c = command(); await room.receive(room.frame(c)); await runtime.committed(render.mock.calls.at(-1)![0]); await runtime.cancel();
  const messages = room.messages();
  expect(messages.map(m => m.stamp.sequence)).toEqual([1, 2, 3, 4]);
  expect(new Set(messages.map(m => m.stamp.epoch)).size).toBe(1);
  expect(messages[2].control.actionId).toBe(c.actionId);
  expect(messages[3].control.turnId).toBe(messages[1].stamp.instanceId);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("retries initial busy presence with the same stamp and serialized later input", async () => {
  await runtime.start(connection());
  room.invoke.mockRejectedValueOnce({ code: 1429 });
  const visible = runtime.visibility(true); await vi.advanceTimersByTimeAsync(250); await visible;
  await runtime.input("hello");
  expect(room.invoke.mock.calls[0][0]).toBe(room.invoke.mock.calls[1][0]);
  expect(room.messages().map(m => m.stamp.sequence)).toEqual([1, 1, 2]);
});
it("a receipt is not a DOM acknowledgment and exact retries cannot rerender", async () => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); const c = command();
  const frame = room.frame(c); const receipt = JSON.parse(await room.receive(frame));
  expect(receipt.kind).toBe("received"); expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(0);
  await room.receive(frame); expect(render.mock.calls.filter(([value]) => value)).toHaveLength(1);
  await room.clear(c.actionId); await room.receive(frame);
  expect(render).toHaveBeenLastCalledWith(null);
});
it.each(["digest", "incarnation", "epoch", "sequence"])("rejects wrong %s evidence before rendering", async mismatch => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); const c = command();
  if (mismatch === "digest") c.contentDigest = "b".repeat(64);
  if (mismatch === "incarnation") c.incarnation = crypto.randomUUID();
  const frame = room.frame(c, mismatch === "sequence" ? 0 : 1, mismatch === "epoch" ? crypto.randomUUID() : undefined);
  await expect(room.receive(frame)).rejects.toThrow(); expect(render.mock.calls.filter(([value]) => value)).toHaveLength(0);
});
it("a visibility change during a content digest fences the pending render", async () => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true);
  const real = crypto.subtle.digest.bind(crypto.subtle);
  let release!: (value: ArrayBuffer) => void;
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(real).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const c = command(); const receiving = room.receive(room.frame(c)); const rejected = expect(receiving).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeDefined()); runtime.hide();
  release(await real("SHA-256", new TextEncoder().encode(c.content.text))); await rejected;
  expect(render).toHaveBeenLastCalledWith(null); spy.mockRestore();
});
it("retirement and sequence fences reject late frames after clear and disconnect", async () => {
  await runtime.start(connection()); await runtime.visibility(true); const c = command();
  await room.clear(c.actionId, 2);
  await expect(room.receive(room.frame(c, 1))).rejects.toThrow();
  await expect(room.receive(room.frame(c, 3))).rejects.toThrow();
  room.lost(); await expect(room.receive(room.frame(command(), 4))).rejects.toThrow();
  expect(room.close).toHaveBeenCalled(); await expect(runtime.start(connection())).rejects.toThrow();
});
it("bounds UTF-8 input without contacting transport", async () => {
  await runtime.input("é".repeat(2001)); expect(fetch).not.toHaveBeenCalled(); expect(room.invoke).not.toHaveBeenCalled();
});
