import { afterEach, expect, it, vi } from "vitest";
import { BrowserRuntime } from "./browserRuntime";
afterEach(() => { vi.unstubAllGlobals(); });
it("does not silently reconnect a failed incarnation on a later heartbeat", async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
  const runtime = new BrowserRuntime("11111111-1111-1111-1111-111111111111", vi.fn(), vi.fn());
  const connection = { token: "a".repeat(64), incarnation: "22222222-2222-2222-2222-222222222222", expiresAt: Date.now() + 3600000 };
  runtime.start(connection); for (let i = 0; i < 20; i++) await Promise.resolve();
  runtime.start(connection); expect(fetch).toHaveBeenCalledTimes(1);
  runtime.start({ ...connection, incarnation: "33333333-3333-3333-3333-333333333333" });
  expect(fetch).toHaveBeenCalledTimes(2); runtime.stop();
});
it("checks UTF8 input bounds before sending", async () => {
  vi.stubGlobal("fetch", vi.fn()); const status = vi.fn();
  const runtime = new BrowserRuntime("11111111-1111-1111-1111-111111111111", vi.fn(), status);
  await runtime.input("é".repeat(2001)); expect(fetch).not.toHaveBeenCalled(); expect(status).toHaveBeenCalledWith("Use a shorter public text request (up to 4000 UTF-8 bytes).");
});
