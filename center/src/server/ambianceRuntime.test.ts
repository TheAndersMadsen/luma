// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), enabled: true }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", async importOriginal => ({ ...await importOriginal<typeof import("@/server/auth")>(), get AUTH_ENABLED() { return mocks.enabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ COSMOS_WEBAPI: "http://cosmos.test", surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));
import { POST, GET } from "@/app/api/runtime/[operation]/route";
import { incarnation, roomConnection, runtimeEpoch } from "@/lib/browserRoom.test-support";
const surfaceId = "11111111-1111-1111-1111-111111111111";
const proof = { surfaceId, incarnation, epoch: runtimeEpoch }; const token = "a".repeat(64);
function request(body: unknown = proof, headers: Record<string, string> = {}) { return new Request("https://center.test/api/runtime/room", {
  method: "POST", headers: { "content-type": "application/json", "x-cosmos-surface-token": token, ...headers }, body: JSON.stringify(body) }); }
const call = (operation = "room", body: unknown = proof, headers?: Record<string, string>) => POST(request(body, headers), { params: Promise.resolve({ operation }) });
beforeEach(() => { mocks.enabled = true; mocks.session.mockResolvedValue({ sub: "owner" }); mocks.headers.mockResolvedValue({ authorization: "Bearer actual-owner" }); mocks.origin.mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(roomConnection(runtimeEpoch)))); });
afterEach(() => { vi.unstubAllGlobals(); });
it("requires login, same origin and current surface capability before bootstrap", async () => {
  mocks.enabled = false; expect((await call()).status).toBe(503);
  mocks.enabled = true; mocks.session.mockResolvedValue(null); expect((await call()).status).toBe(401);
  mocks.session.mockResolvedValue({}); mocks.origin.mockReturnValue(false); expect((await call()).status).toBe(403);
  mocks.origin.mockReturnValue(true); expect((await call("room", proof, { "x-cosmos-surface-token": "" })).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it("forwards only the verified owner bearer and exact memory capability", async () => {
  const response = await call("room", proof, { authorization: "Bearer attacker", "x-forwarded-client-cert": "attacker", "x-owner-id": "other" });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://cosmos.test/runtime-api/v1/browser/room");
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer actual-owner", "x-cosmos-surface-token": token, "content-type": "application/json" });
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual(proof);
});
it("validates signaling against the public proxy origin when Next sees an internal URL", async () => {
  const auth = await vi.importActual<typeof import("@/server/auth")>("@/server/auth");
  mocks.origin.mockImplementation(auth.isSameOriginRequest);
  const request = new Request("http://localhost:4000/api/runtime/room", {
    method: "POST", headers: { "content-type": "application/json", "x-cosmos-surface-token": token,
      origin: "https://center.test", host: "localhost:4000", "x-forwarded-host": "center.test", "x-forwarded-proto": "https" },
    body: JSON.stringify(proof),
  });
  const result = await POST(request, { params: Promise.resolve({ operation: "room" }) });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(roomConnection(runtimeEpoch));
});
it("rejects self-elevation, missing epochs and oversized requests", async () => {
  for (const body of [{ ...proof, owner: "other" }, { ...proof, trust: 9 }, { surfaceId, incarnation },
    { ...proof, epoch: "0".repeat(2048) }]) expect((await call("room", body)).status).toBe("epoch" in body && body.epoch.length === 2048 ? 413 : 400);
  expect(fetch).not.toHaveBeenCalled();
});
it("removes the old polling, input and acknowledgment routes", async () => {
  for (const operation of ["poll", "ack", "input"]) expect((await call(operation)).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
it("sanitizes upstream failures and denies a substituted epoch or signaling origin", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response("provider secret", { status: 500 }));
  expect(await (await call()).json()).toEqual({ error: "unavailable" });
  for (const response of [{ ...roomConnection(runtimeEpoch), epoch: surfaceId }, { ...roomConnection(runtimeEpoch), url: "wss://other.test/livekit" },
    { ...roomConnection(runtimeEpoch), ownerHistory: "secret" }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json(response)); expect((await call()).status).toBe(503);
  }
});
it("runtime readiness is authenticated configuration, never a surface claim", async () => {
  const context = { params: Promise.resolve({ operation: "status" }) };
  mocks.session.mockResolvedValue(null); expect((await GET(request(), context)).status).toBe(401);
  mocks.session.mockResolvedValue({}); vi.mocked(fetch).mockResolvedValue(Response.json({ version: 1, textInputConfigured: false, approvedSurfaceRequired: true }));
  expect(await (await GET(request(), context)).json()).toEqual({ version: 1, textInputConfigured: false, approvedSurfaceRequired: true });
});
