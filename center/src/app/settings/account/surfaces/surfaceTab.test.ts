import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceTab } from "./surfaceTab";
import { BROWSER_SURFACE_POSTURE } from "@/lib/contracts/surfaces";
import { BrowserRuntime } from "@/lib/browserRuntime";
const incarnation = "22222222-2222-2222-2222-222222222222";
const token = "a".repeat(64);
let tabs: SurfaceTab[];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(runtime?: BrowserRuntime) {
  const notify = vi.fn(); const changed = vi.fn();
  const tab = new SurfaceTab(notify, changed, runtime); tabs.push(tab);
  const surface = (sequence = 0, visible = false) => ({ ...BROWSER_SURFACE_POSTURE, surfaceId: tab.surfaceId, revision: 1, sequence, visible, revoked: false, connected: true, available: visible, connectionExpiresAt: Date.now() + 3600000, leaseExpiresAt: Date.now() + 45000 });
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (url === "/api/surfaces") return Response.json({ surface: surface(), connection: { token, incarnation, expiresAt: Date.now() + 3600000 } });
    const body = JSON.parse(options?.body as string);
    return Response.json({ surface: surface(body.sequence ?? 0, body.visible ?? false) });
  });
  return { tab, notify, surface };
}
beforeEach(() => { tabs = []; vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn()); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => { tabs.forEach(tab => tab.dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("tab connection lifecycle", () => {
  it("renderer failure stops heartbeat and leaves even if the leave cannot reach Cosmos", async () => {
    const runtime = new BrowserRuntime(crypto.randomUUID(), vi.fn(), vi.fn());
    const { tab, notify } = setup(runtime);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => url === "/api/runtime/poll" ? Promise.resolve(new Response(null, { status: 503 }))
      : String(url).endsWith("/leave") ? Promise.reject(new Error("offline")) : original(url, options));
    await tab.approve(); await tick(); expect(notify).toHaveBeenLastCalledWith("lost");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/leave"))).toHaveLength(1);
    const count = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000); tab.visibility(true); await tick();
    expect(fetch).toHaveBeenCalledTimes(count); expect(notify).toHaveBeenLastCalledWith("lost");
  });
  it("late state completion after renderer failure cannot revive eligibility", async () => {
    const runtime = new BrowserRuntime(crypto.randomUUID(), vi.fn(), vi.fn());
    const { tab, notify, surface } = setup(runtime);
    let rejectPoll!: (error: Error) => void; let resolveState!: (response: Response) => void;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => url === "/api/runtime/poll" ? new Promise<Response>((_, reject) => { rejectPoll = reject; })
      : String(url).endsWith("/state") && JSON.parse(options?.body as string).sequence === 2 ? new Promise<Response>(resolve => { resolveState = resolve; }) : original(url, options));
    await tab.approve(); await tick(); tab.visibility(true); await tick();
    rejectPoll(new Error("renderer offline")); await tick(); expect(notify).toHaveBeenLastCalledWith("lost");
    resolveState(Response.json({ surface: surface(2, true) })); await tick();
    expect(notify).toHaveBeenLastCalledWith("lost");
  });
  it("a stale renderer failure callback cannot clear a replacement incarnation", async () => {
    const runtime = new BrowserRuntime(crypto.randomUUID(), vi.fn(), vi.fn());
    const register = vi.spyOn(runtime, "onFailure"); const { tab, notify } = setup(runtime);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => url === "/api/runtime/poll" ? Promise.resolve(Response.json({ commands: [], clear: [] })) : original(url, options));
    await tab.approve(); await tick();
    const newIncarnation = "33333333-3333-3333-3333-333333333333";
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      if (url === "/api/runtime/poll") return Response.json({ commands: [], clear: [] });
      const response = await original(url, options);
      if (url === "/api/surfaces") { const body = await response.json(); body.connection.incarnation = newIncarnation; return Response.json(body); }
      return response;
    });
    await tab.approve(); await tick(); expect(notify).toHaveBeenLastCalledWith("visible");
    const count = vi.mocked(fetch).mock.calls.length; register.mock.calls[0][0](incarnation); await tick();
    expect(notify).toHaveBeenLastCalledWith("visible"); expect(fetch).toHaveBeenCalledTimes(count);
  });
  it("a healthy visible heartbeat preserves availability instead of dismissing a frame", async () => {
    const { tab, notify } = setup(); await tab.approve(); await tick(); notify.mockClear();
    await vi.advanceTimersByTimeAsync(15000); await tick();
    expect(notify).not.toHaveBeenCalledWith("pending"); expect(notify).toHaveBeenLastCalledWith("visible");
  });
  it("does not enroll or heartbeat until explicit approval; hides and leaves", async () => {
    const { tab, notify } = setup();
    await vi.advanceTimersByTimeAsync(15000); expect(fetch).not.toHaveBeenCalled();
    await tab.approve(); await tick(); expect(notify).toHaveBeenLastCalledWith("visible");
    tab.visibility(false); await tick(); expect(notify).toHaveBeenLastCalledWith("hidden");
    tab.leave(); expect(notify).toHaveBeenLastCalledWith("inactive");
    const count = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000); expect(fetch).toHaveBeenCalledTimes(count);
  });
  it("serializes state and coalesces visibility while one request is pending", async () => {
    const { tab, notify, surface } = setup();
    let resolve!: (response: Response) => void;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => String(url).endsWith("/state") && JSON.parse(options?.body as string).sequence === 1
      ? new Promise<Response>(done => { resolve = done; }) : original(url, options));
    await tab.approve(); tab.visibility(false); tab.visibility(true); tab.visibility(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve(Response.json({ surface: surface(1, true) })); await tick();
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/state"));
    expect(calls.map(([, options]) => JSON.parse(options!.body as string))).toEqual([{ incarnation, sequence: 1, visible: true }, { incarnation, sequence: 2, visible: false }]);
    expect(notify).toHaveBeenLastCalledWith("hidden");
  });
  it("late state after leave cannot resurrect the connection", async () => {
    const { tab, notify, surface } = setup();
    let resolve!: (response: Response) => void;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => String(url).endsWith("/state") ? new Promise<Response>(done => { resolve = done; }) : original(url, options));
    await tab.approve(); tab.leave();
    resolve(Response.json({ surface: surface(1, true) })); await tick();
    expect(notify).toHaveBeenLastCalledWith("inactive");
  });
  it("late approval after leave is released without a state report", async () => {
    const { tab, notify, surface } = setup();
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const approval = tab.approve(); tab.leave();
    resolve(Response.json({ surface: surface(), connection: { token, incarnation, expiresAt: Date.now() + 3600000 } }));
    await approval; await tick();
    expect(notify).toHaveBeenLastCalledWith("inactive");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/state"))).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/leave"))).toBe(true);
  });
  it("reapproval replaces generation and ignores old state completion", async () => {
    const { tab, notify, surface } = setup();
    let resolve!: (response: Response) => void;
    const original = vi.mocked(fetch).getMockImplementation()!;
    let delayed = false;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (String(url).endsWith("/state") && !delayed) { delayed = true; return new Promise<Response>(done => { resolve = done; }); }
      return original(url, options);
    });
    await tab.approve(); await tab.approve(); await tick();
    expect(notify).toHaveBeenLastCalledWith("visible");
    const calls = notify.mock.calls.length;
    resolve(Response.json({ surface: surface(1, false) })); await tick();
    expect(notify).toHaveBeenCalledTimes(calls);
  });
  it("failed state stops heartbeat and never claims active", async () => {
    const { tab, notify } = setup();
    await tab.approve(); await tick();
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));
    tab.visibility(false); await tick(); expect(notify).toHaveBeenLastCalledWith("lost");
    const count = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000); expect(fetch).toHaveBeenCalledTimes(count);
  });
  it("expires without implicit reapproval", async () => {
    const { tab, notify } = setup();
    await tab.approve(); await tick();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(notify).toHaveBeenLastCalledWith("expired");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/surfaces")).toHaveLength(1);
  });
});
