// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), authEnabled: true }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.authEnabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ COSMOS_WEBAPI: "http://cosmos.test", surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));
import { GET, POST } from "@/app/api/surfaces/route";
import { POST as STATE } from "@/app/api/surfaces/[surfaceId]/state/route";
import { POST as LEAVE } from "@/app/api/surfaces/[surfaceId]/leave/route";
import { DELETE } from "@/app/api/surfaces/[surfaceId]/route";
import { SessionExpiredError } from "@/server/cosmos";
import { BROWSER_SURFACE_POSTURE } from "@/lib/contracts/surfaces";
const id = "11111111-1111-1111-1111-111111111111";
const incarnation = "22222222-2222-2222-2222-222222222222";
const token = "a".repeat(64);
const surface = { ...BROWSER_SURFACE_POSTURE, surfaceId: id, revision: 1, sequence: 0, revoked: false, visible: false, connected: true, available: false, connectionExpiresAt: 100000, leaseExpiresAt: 1000 };
function request(body: unknown, extra = {}) {
  return new Request("https://center.test/api/surfaces", { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
}
const approval = { surfaceId: id, approval: "browser-shared-display-v1" };
beforeEach(() => { mocks.authEnabled = true; mocks.session.mockResolvedValue({ sub: "owner" }); mocks.headers.mockResolvedValue({ authorization: "Bearer server-only" }); mocks.origin.mockReturnValue(true); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("surface BFF real route handlers", () => {
  it("denies every handler when login is disabled or the session lacks a bearer", async () => {
    const handlers = [() => GET(new Request("https://center.test/api/surfaces")), () => POST(request(approval)),
      () => STATE(request({ incarnation, sequence: 1, visible: true }), { params: Promise.resolve({ surfaceId: id }) }),
      () => LEAVE(request({ incarnation }), { params: Promise.resolve({ surfaceId: id }) }),
      () => DELETE(new Request("https://center.test/api/surfaces", { method: "DELETE" }), { params: Promise.resolve({ surfaceId: id }) })];
    mocks.authEnabled = false;
    for (const handler of handlers) expect((await handler()).status).toBe(503);
    mocks.authEnabled = true; mocks.headers.mockRejectedValue(new SessionExpiredError());
    for (const handler of handlers) expect((await handler()).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("leave requires exact connection proof and does not forward extra authority", async () => {
    const context = { params: Promise.resolve({ surfaceId: id }) };
    expect((await LEAVE(request({ incarnation }), context)).status).toBe(403);
    expect((await LEAVE(request({ incarnation, trust: 1 }, { "x-cosmos-surface-token": token }), context)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(Response.json({ surface }));
    expect((await LEAVE(request({ incarnation }, { "x-cosmos-surface-token": token }), context)).status).toBe(200);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`http://cosmos.test/surface-api/v1/surfaces/${id}/leave`);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json", "x-cosmos-surface-token": token });
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(JSON.stringify({ incarnation }));
  });
  it("rejects upstream posture that contradicts the shared-display UI claims", async () => {
    for (const changes of [{ trustLevel: 1 }, { occupancy: "empty" }, { renderVerified: true }, { manifest: {} },
      { manifest: { ...BROWSER_SURFACE_POSTURE.manifest, authority: { mayOriginate: ["action.execute"], reflexive: [] } } },
      { manifest: { ...BROWSER_SURFACE_POSTURE.manifest, capabilities: { input: [], output: { "visual.card": { maxClass: "private", shared: false } } } } }]) {
      vi.mocked(fetch).mockResolvedValue(Response.json({ surfaces: [{ ...surface, ...changes }] }));
      const result = await GET(new Request("https://center.test/api/surfaces"));
      expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: "unavailable" });
    }
  });
  it("rejects missing session and cross-origin before upstream", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await POST(request(approval))).status).toBe(401);
    mocks.session.mockResolvedValue({ sub: "owner" }); mocks.origin.mockReturnValue(false);
    expect((await POST(request(approval))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects unbounded or self-elevating bodies and absent connection proof", async () => {
    for (const body of [{ ...approval, trust: 9 }, { ...approval, surfaceId: "a".repeat(2000) }, { ...approval, approval: "private" }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect((await STATE(request({ incarnation, sequence: 1, visible: true }), { params: Promise.resolve({ surfaceId: id }) })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("forwards only server bearer and returns only bounded approval projection", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ surface: { ...surface, ownerId: "must-not-leak" }, connection: { token, incarnation, expiresAt: 100000 }, ignored: "must-not-leak" }));
    const result = await POST(request(approval, { authorization: "Bearer attacker", "x-forwarded-client-cert": "attacker" }));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ surface, connection: { token, incarnation, expiresAt: 100000 } });
    const options = vi.mocked(fetch).mock.calls[0][1]!;
    expect(options.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json" });
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("list and revoke cannot leak connection tokens from upstream", async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ surfaces: [{ ...surface, token }], surface, connection: { token, incarnation } }));
    expect(JSON.stringify(await (await GET(new Request("https://center.test/api/surfaces"))).json())).not.toContain(token);
    expect(JSON.stringify(await (await DELETE(new Request("https://center.test/api/surfaces", { method: "DELETE" }), { params: Promise.resolve({ surfaceId: id }) })).json())).not.toContain(token);
  });
  it("forwards state token without allowing browser owner selection", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ surface }));
    await STATE(request({ incarnation, sequence: 1, visible: true }, { "x-cosmos-surface-token": token }), { params: Promise.resolve({ surfaceId: id }) });
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json", "x-cosmos-surface-token": token });
  });
  it("sanitizes upstream failures and malformed or oversized success", async () => {
    for (const response of [new Response("secret upstream detail", { status: 500 }), Response.json({ surfaces: Array(17).fill(surface) }), new Response("x".repeat(65537))]) {
      vi.mocked(fetch).mockResolvedValue(response);
      const result = await GET(new Request("https://center.test/api/surfaces"));
      expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: "unavailable" });
    }
    vi.mocked(fetch).mockRejectedValue(new Error("timeout contains secret"));
    expect((await GET(new Request("https://center.test/api/surfaces"))).status).toBe(503);
  });
  it("aborts a stalled upstream body at its deadline", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancelled = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled })));
    const result = GET(new Request("https://center.test/api/surfaces"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    controller.abort();
    expect((await result).status).toBe(503);
    expect(cancelled).toHaveBeenCalled();
  });
});
