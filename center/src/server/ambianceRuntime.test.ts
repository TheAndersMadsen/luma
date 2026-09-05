// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), enabled: true }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.enabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ COSMOS_WEBAPI: "http://cosmos.test", surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));
import { POST, GET } from "@/app/api/runtime/[operation]/route";
const surfaceId = "11111111-1111-1111-1111-111111111111"; const incarnation = "22222222-2222-2222-2222-222222222222";
const proof = { surfaceId, incarnation }; const token = "a".repeat(64);
function request(body: unknown = proof, headers: Record<string, string> = {}) { return new Request("https://center.test/api/runtime/poll", { method: "POST", headers: { "content-type": "application/json", "x-cosmos-surface-token": token, ...headers }, body: JSON.stringify(body) }); }
const call = (operation: string, body: unknown = proof, headers?: Record<string, string>) => POST(request(body, headers), { params: Promise.resolve({ operation }) });
beforeEach(() => { mocks.enabled = true; mocks.session.mockResolvedValue({ sub: "owner" }); mocks.headers.mockResolvedValue({ authorization: "Bearer actual-owner" }); mocks.origin.mockReturnValue(true); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ commands: [], clear: [] }))); });
afterEach(() => { vi.unstubAllGlobals(); });
it("requires login, same origin and current surface capability before transport", async () => {
  mocks.enabled = false; expect((await call("poll")).status).toBe(503);
  mocks.enabled = true; mocks.session.mockResolvedValue(null); expect((await call("poll")).status).toBe(401);
  mocks.session.mockResolvedValue({}); mocks.origin.mockReturnValue(false); expect((await call("poll")).status).toBe(403);
  mocks.origin.mockReturnValue(true); expect((await call("poll", proof, { "x-cosmos-surface-token": "" })).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it("forwards only server owner bearer and exact memory capability, never injected authority", async () => {
  const response = await call("poll", proof, { authorization: "Bearer attacker", "x-forwarded-client-cert": "attacker", "x-owner-id": "other" });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://cosmos.test/runtime-api/v1/browser/poll");
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer actual-owner", "x-cosmos-surface-token": token, "content-type": "application/json" });
});
it("rejects self-elevation, missing exact ack proof, unsupported channels and oversized input", async () => {
  for (const body of [{ ...proof, owner: "other" }, { ...proof, trust: 9 }]) expect((await call("poll", body)).status).toBe(400);
  for (const body of [{ ...proof, text: "é".repeat(2001) }, { ...proof, text: "hello", privacy: "public" }]) expect((await call("input", body)).status).toBe(400);
  expect((await call("ack", { ...proof, actionId: surfaceId, contentDigest: token })).status).toBe(400);
  expect((await call("ack", { ...proof, actionId: surfaceId, turnId: incarnation, generation: 1, channel: "audio.tts", contentDigest: token })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it("sanitizes errors and rejects upstream content from a different incarnation", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response("provider secret", { status: 500 }));
  expect(await (await call("poll")).json()).toEqual({ error: "unavailable" });
  vi.mocked(fetch).mockResolvedValue(Response.json({ commands: [{ version: 1, actionId: surfaceId, turnId: surfaceId, generation: 1, surfaceId, incarnation: surfaceId, channel: "visual.card", contentDigest: token, content: { kind: "text", text: "hidden" }, expiresAt: Date.now() + 5000 }], clear: [] }));
  expect((await call("poll")).status).toBe(503);
  vi.mocked(fetch).mockResolvedValue(Response.json({ commands: [], clear: [], ownerHistory: "secret" }));
  expect((await call("poll")).status).toBe(503);
});
it("does not accept optimistic upstream action success or raw model traces", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ accepted: true, trace: "private" })); expect((await call("input", { ...proof, text: "hello" })).status).toBe(503);
  vi.mocked(fetch).mockResolvedValue(Response.json({ acknowledged: false })); expect((await call("ack", { ...proof, actionId: surfaceId, turnId: incarnation, generation: 1, channel: "visual.card", contentDigest: token })).status).toBe(503);
});
it("runtime readiness is bounded authenticated configuration, never a surface claim", async () => {
  const context = { params: Promise.resolve({ operation: "status" }) };
  mocks.session.mockResolvedValue(null); expect((await GET(request(), context)).status).toBe(401);
  mocks.session.mockResolvedValue({}); vi.mocked(fetch).mockResolvedValue(Response.json({ version: 1, textInputConfigured: false, approvedSurfaceRequired: true }));
  expect(await (await GET(request(), context)).json()).toEqual({ version: 1, textInputConfigured: false, approvedSurfaceRequired: true });
});
