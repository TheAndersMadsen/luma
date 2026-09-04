import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceTab } from "./surfaceTab";
import { BROWSER_SURFACE_POSTURE } from "@/lib/contracts/surfaces";
const incarnation = "22222222-2222-2222-2222-222222222222";
const token = "a".repeat(64);
let tabs: SurfaceTab[];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup() {
  const notify = vi.fn(); const changed = vi.fn();
  const tab = new SurfaceTab(notify, changed); tabs.push(tab);
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
