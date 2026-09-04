// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), ingest: vi.fn(), metadata: vi.fn(), authEnabled: true, configured: true }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.authEnabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ COSMOS_WEBAPI: "http://cosmos.test", get COSMOS_WEBAPI_ENABLED() { return mocks.configured; }, surfaceOwnerHeaders: mocks.headers,
  ingestAnswerEvent: mocks.ingest, requestMetadata: mocks.metadata, SessionExpiredError: class extends Error {} }));
import { POST as stream } from "@/app/api/assistant/stream/route";
import { POST as speech } from "@/app/api/assistant/speech/route";
import { SessionExpiredError } from "@/server/cosmos";
const handlers = [stream, speech];
function request(body: unknown = { text: "hello" }, headers = {}) {
  return new Request("https://center.test/api/assistant/stream", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => { mocks.authEnabled = true; mocks.configured = true; mocks.session.mockResolvedValue({ sub: "owner" }); mocks.headers.mockResolvedValue({ authorization: "Bearer owner-only" }); mocks.origin.mockReturnValue(true); mocks.ingest.mockClear(); mocks.metadata.mockClear(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("both assistant routes require configured login, real session, same origin and bearer", async () => {
  mocks.authEnabled = false;
  for (const handler of handlers) expect((await handler(request())).status).toBe(503);
  mocks.authEnabled = true; mocks.session.mockResolvedValue(null);
  for (const handler of handlers) expect((await handler(request())).status).toBe(401);
  mocks.session.mockResolvedValue({ sub: "owner" }); mocks.origin.mockReturnValue(false);
  for (const handler of handlers) expect((await handler(request())).status).toBe(403);
  mocks.origin.mockReturnValue(true); mocks.headers.mockRejectedValue(new SessionExpiredError());
  for (const handler of handlers) {
    const result = await handler(request()); expect(result.status).toBe(401); expect(await result.json()).toMatchObject({ reauthenticate: true });
  }
  expect(fetch).not.toHaveBeenCalled(); expect(mocks.metadata).not.toHaveBeenCalled();
});
it("forwards only fresh owner bearer and returns meaningful sanitized503 without writes or retry", async () => {
  for (const [index, handler] of handlers.entries()) {
    vi.mocked(fetch).mockResolvedValue(new Response("secret upstream diagnostics", { status: 503 }));
    const result = await handler(request({ text: "hello" }, { authorization: "Bearer attacker", "x-forwarded-client-cert": "attacker", "x-cosmos-admin-token": "attacker" }));
    expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: "Browser assistant runtime is unavailable." });
    expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(result.headers.get("content-type")).toContain("application/json");
    const [url, options] = vi.mocked(fetch).mock.calls[index];
    expect(url).toBe(`http://cosmos.test/demo-api/${index === 0 ? "trace/stream" : "speech"}`);
    expect(options?.headers).toEqual({ authorization: "Bearer owner-only", "content-type": "application/json" });
    expect(options?.cache).toBe("no-store"); expect(options?.redirect).toBe("error"); expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
  expect(fetch).toHaveBeenCalledTimes(2); expect(mocks.ingest).not.toHaveBeenCalled();
});
it("rejects malformed, oversized and simulated-Pin bodies before upstream", async () => {
  for (const handler of handlers) {
    for (const body of [{}, [], { text: " " }, { text: "hi", simulate_unlocked_pin: true }, { text: 12 }]) expect((await handler(request(body))).status).toBe(400);
    expect((await handler(request({ text: "a".repeat(4096) }))).status).toBe(413);
    expect((await handler(request({ text: "hello" }, { "content-type": "text/plain" }))).status).toBe(400);
  }
  expect(fetch).not.toHaveBeenCalled(); expect(mocks.ingest).not.toHaveBeenCalled();
});
it("preserves session and size failure statuses but never accepts legacy SSE/audio success", async () => {
  for (const handler of handlers) {
    for (const status of [400, 401, 408, 413, 200, 500]) {
      vi.mocked(fetch).mockResolvedValue(new Response('event: step\ndata: {"kind":"answer","text":"fake saved"}\n\n', { status }));
      const result = await handler(request());
      expect(result.status).toBe([400, 401, 408, 413].includes(status) ? status : 502);
      expect(await result.text()).not.toContain("fake saved");
    }
  }
  expect(mocks.ingest).not.toHaveBeenCalled();
});
it("missing configuration and failed upstream never trigger provider/persistence fallbacks", async () => {
  mocks.configured = false;
  expect((await stream(request())).status).toBe(503); expect(fetch).not.toHaveBeenCalled();
  mocks.configured = true; vi.mocked(fetch).mockRejectedValue(new Error("secret connection failure"));
  const result = await speech(request());
  expect(result.status).toBe(503); expect(await result.text()).not.toContain("secret");
  expect(fetch).toHaveBeenCalledTimes(1); expect(mocks.ingest).not.toHaveBeenCalled();
});
