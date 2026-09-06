// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), authEnabled: true }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.authEnabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ COSMOS_WEBAPI: "http://cosmos.test", surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));
import { GET, POST } from "@/app/api/devices/runtime/route";
import { DELETE } from "@/app/api/devices/runtime/[surfaceId]/route";
import { GET as SPEECH_GET, POST as SPEECH_POST } from "@/app/api/surfaces/[surfaceId]/speech-disclosure/route";
import { GET as VOICE_GET, POST as VOICE_POST } from "@/app/api/devices/runtime/[surfaceId]/local-voice/route";
import { SPEECH_DISCLOSURE_APPROVAL } from "@/lib/contracts/speechDisclosure";
import { LOCAL_VOICE_APPROVAL } from "@/lib/contracts/localVoice";
import { SessionExpiredError } from "@/server/cosmos";
import { PIN_APPROVAL, PIN_SURFACE_POSTURE } from "@/lib/contracts/pinSurfaces";
const id = "11111111-1111-1111-1111-111111111111";
const pin = { ...PIN_SURFACE_POSTURE, surfaceId: id, deviceId: "aabb", revision: 1, revoked: false, currentPaired: true };
const approval = { deviceId: "AABB", approval: PIN_APPROVAL };
const context = { params: Promise.resolve({ surfaceId: id }) };
function request(body: unknown = approval, extra = {}) {
  return new Request("https://center.test/api/devices/runtime", { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
}
const list = () => GET(new Request("https://center.test/api/devices/runtime"));
const revoke = () => DELETE(new Request("https://center.test/api/devices/runtime", { method: "DELETE" }), context);
const speechRead = () => SPEECH_GET(new Request(`https://center.test/api/surfaces/${id}/speech-disclosure`), context);
const policy = { provider: { provider: "azure_speech", region: "westeurope" }, maximumClass: "shared_room", transcription: false, synthesis: true };
const speechInput = { approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: 1, expectedRevision: 0, policy };
const voiceInput = { approval: LOCAL_VOICE_APPROVAL, approvalRevision: 1, expectedRevision: 0, policy: { sourceFloor: "shared_room" } };
const voiceRead = () => VOICE_GET(new Request(`https://center.test/api/devices/runtime/${id}/local-voice`), context);
beforeEach(() => { mocks.authEnabled = true; mocks.session.mockResolvedValue({ sub: "owner" }); mocks.headers.mockResolvedValue({ authorization: "Bearer server-only" }); mocks.origin.mockReturnValue(true); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("all actual Pin runtime routes require configured login, owner session and real bearer", async () => {
  const handlers = [list, () => POST(request()), revoke, speechRead, () => SPEECH_POST(request(speechInput), context), voiceRead, () => VOICE_POST(request(voiceInput), context)];
  mocks.authEnabled = false;
  for (const handler of handlers) expect((await handler()).status).toBe(503);
  mocks.authEnabled = true; mocks.session.mockResolvedValue(null);
  for (const handler of handlers) expect((await handler()).status).toBe(401);
  mocks.session.mockResolvedValue({ sub: "owner" }); mocks.headers.mockRejectedValue(new SessionExpiredError());
  for (const handler of handlers) expect((await handler()).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
it("both mutations reject cross-origin before reading or forwarding authority", async () => {
  mocks.origin.mockReturnValue(false);
  expect((await POST(request())).status).toBe(403);
  expect((await revoke()).status).toBe(403);
  expect((await SPEECH_POST(request(speechInput), context)).status).toBe(403);
  expect((await VOICE_POST(request(voiceInput), context)).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects malformed, oversized, self-elevating and wrong-profile approval", async () => {
  for (const body of [null, [], {}, { ...approval, accountId: "other" }, { ...approval, approval: "private" },
    { ...approval, deviceId: "xyz" }, { ...approval, deviceId: "a".repeat(129) }, { ...approval, deviceId: "a".repeat(2048) }]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect((await POST(new Request("https://center.test/api/devices/runtime", { method: "POST", body: "{" , headers: { "content-type": "application/json" } }))).status).toBe(400);
  expect((await POST(request(approval, { "content-type": "text/plain" }))).status).toBe(400);
  expect((await DELETE(request(), { params: Promise.resolve({ surfaceId: "../other" }) })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it("uses exact canonical selection with server bearer only and strips upstream extras", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ pin: { ...pin, token: "secret", ownerId: "not-browser-data" } }));
  const result = await POST(request(approval, { authorization: "Bearer attacker", "x-forwarded-client-cert": "attacker", "x-cosmos-admin-token": "attacker" }));
  expect(result.status).toBe(200); expect(await result.json()).toEqual({ pin });
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  const [url, options] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe("http://cosmos.test/surface-api/v1/pins");
  expect(options?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json" });
  expect(options?.body).toBe(JSON.stringify({ deviceId: "aabb", approval: PIN_APPROVAL }));
  expect(options?.cache).toBe("no-store"); expect(options?.redirect).toBe("error"); expect(options?.signal).toBeInstanceOf(AbortSignal);
});
it("verifies mutation target and committed revoked state, not merely HTTP 200", async () => {
  for (const changed of [{ ...pin, deviceId: "ccdd" }, { ...pin, revoked: true }, { ...pin, currentPaired: false }, { ...pin, currentPaired: null }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ pin: changed }));
    expect((await POST(request())).status).toBe(503);
  }
  vi.mocked(fetch).mockResolvedValue(Response.json({ pin }));
  expect((await revoke()).status).toBe(503);
  for (const currentPaired of [true, false, null]) {
    const revoked = { ...pin, revoked: true, currentPaired };
    vi.mocked(fetch).mockResolvedValue(Response.json({ pin: revoked }));
    const result = await revoke();
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ pin: revoked });
  }
  expect(vi.mocked(fetch).mock.lastCall?.[0]).toBe(`http://cosmos.test/surface-api/v1/pins/${id}`);
});
it("owner list keeps multi-Pin association but rejects ambiguous or elevated projections", async () => {
  const second = { ...pin, deviceId: "ccdd", surfaceId: "22222222-2222-2222-2222-222222222222", currentPaired: false };
  vi.mocked(fetch).mockResolvedValue(Response.json({ pins: [pin, second] }));
  expect(await (await list()).json()).toEqual({ pins: [pin, second] });
  vi.mocked(fetch).mockResolvedValue(Response.json({ pins: [{ ...pin, currentPaired: null }] }));
  expect(await (await list()).json()).toEqual({ pins: [{ ...pin, currentPaired: null }] });
  for (const pins of [[pin, pin], Array(17).fill(pin), [{ ...pin, revoked: true }], [{ ...pin, trustLevel: 1 }],
    [{ ...pin, occupancy: "empty" }], [{ ...pin, actorIdentity: "owner" }], [{ ...pin, playbackVerified: true }],
    [{ ...pin, manifest: { ...pin.manifest, authority: { mayOriginate: ["action.execute"], reflexive: [] } } }]]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ pins }));
    expect((await list()).status).toBe(503);
  }
});
it("sanitizes backend failures and malformed responses without caching", async () => {
  for (const status of [401, 404, 429, 500, 503]) {
    vi.mocked(fetch).mockResolvedValue(new Response("secret diagnostic", { status }));
    const result = await POST(request());
    expect(result.status).toBe(status === 500 ? 503 : status);
    expect(await result.text()).not.toContain("secret"); expect(result.headers.get("cache-control")).toBe("no-store");
  }
  for (const response of [new Response("x".repeat(65537)), new Response("{"), Response.json({})]) {
    vi.mocked(fetch).mockResolvedValue(response);
    expect((await list()).status).toBe(503);
  }
  vi.mocked(fetch).mockRejectedValue(new Error("secret timeout"));
  expect(await (await list()).json()).toEqual({ error: "unavailable" });
});
it("bounds stalled upstream reads with the same signal as the fetch", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const cancel = vi.fn();
  vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ cancel })));
  const result = list();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  controller.abort();
  expect((await result).status).toBe(503); expect(cancel).toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.lastCall?.[1]?.signal).toBe(controller.signal);
});
it("bounds stalled incoming approval bodies and never reaches Cosmos", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const cancel = vi.fn();
  const incoming = new Request("https://center.test/api/devices/runtime", { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ cancel }), duplex: "half" } as RequestInit);
  const result = POST(incoming);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  controller.abort();
  expect((await result).status).toBe(400); expect(cancel).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("speech disclosure requires an explicit nullable policy and exact bounded authority fields", async () => {
  const { policy: _policy, ...missing } = speechInput;
  for (const body of [missing, { ...speechInput, principal: "other" }, { ...speechInput, expectedRevision: -1 },
    { ...speechInput, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...speechInput, approvalRevision: 0 },
    { ...speechInput, policy: { ...policy, provider: { ...policy.provider, endpoint: "https://invalid.test" } } },
    { ...speechInput, policy: { ...policy, provider: { ...policy.provider, region: "a".repeat(33) } } },
    { ...speechInput, policy: { ...policy, synthesis: false } }, { ...speechInput, policy: { ...policy, maximumClass: "secret" } }]) {
    expect((await SPEECH_POST(request(body), context)).status).toBe(400);
  }
  expect((await SPEECH_GET(request(), { params: Promise.resolve({ surfaceId: "../other" }) })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

it("speech grant and revoke forward only owner bearer and verify exact committed policy/revisions", async () => {
  for (const nextPolicy of [policy, null]) {
    const input = { ...speechInput, policy: nextPolicy };
    const saved = { approvalRevision: 1, revision: 1, policy: nextPolicy };
    vi.mocked(fetch).mockResolvedValue(Response.json({ approval: saved }));
    const response = await SPEECH_POST(request(input, { authorization: "Bearer attacker", "x-cosmos-admin-token": "attacker" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approval: saved });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, options] = vi.mocked(fetch).mock.lastCall!;
    expect(url).toBe(`http://cosmos.test/surface-api/v1/surfaces/${id}/speech-disclosure`);
    expect(options?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json" });
    expect(options?.redirect).toBe("error");
    expect(options?.body).toBe(JSON.stringify(input));
  }
  for (const approval of [null, { approvalRevision: 2, revision: 1, policy }, { approvalRevision: 1, revision: 2, policy },
    { approvalRevision: 1, revision: 1, policy: { ...policy, transcription: true } }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ approval }));
    expect((await SPEECH_POST(request(speechInput), context)).status).toBe(503);
  }
});

it("speech reads distinguish no policy from malformed state and sanitize conflicts", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ approval: null }));
  expect(await (await speechRead()).json()).toEqual({ approval: null });
  for (const response of [Response.json({}), Response.json({ approval: { approvalRevision: 1, revision: 1 } }),
    Response.json({ approval: { approvalRevision: 1, revision: 1, policy }, secret: "not-browser-data" }), new Response("x".repeat(2049))]) {
    vi.mocked(fetch).mockResolvedValue(response);
    expect((await speechRead()).status).toBe(503);
  }
  vi.mocked(fetch).mockResolvedValue(new Response("private diagnostic", { status: 409 }));
  const response = await SPEECH_POST(request(speechInput), context);
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "conflict" });
});

it("local voice routes reject malformed, oversized, public and cloud-disclosure grants", async () => {
  const { policy: _policy, ...missing } = voiceInput;
  for (const body of [missing, speechInput, { ...voiceInput, principal: "other" }, { ...voiceInput, expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...voiceInput, policy: { sourceFloor: "public" } }, { ...voiceInput, policy: { sourceFloor: "shared_room", provider: "azure_speech" } },
    { ...voiceInput, policy: { sourceFloor: "x".repeat(2048) } }]) {
    expect((await VOICE_POST(request(body), context)).status).toBe(400);
  }
  expect((await VOICE_POST(request(voiceInput, { "content-type": "text/plain" }), context)).status).toBe(400);
  expect((await VOICE_GET(request(), { params: Promise.resolve({ surfaceId: "../other" }) })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

it("local voice grants and revokes bind the owner route and exact committed revisions/policy", async () => {
  for (const nextPolicy of [voiceInput.policy, { sourceFloor: "sensitive" }, null]) {
    const input = { ...voiceInput, policy: nextPolicy };
    const saved = { approvalRevision: 1, revision: 1, policy: nextPolicy };
    vi.mocked(fetch).mockResolvedValue(Response.json({ approval: saved }));
    const result = await VOICE_POST(request(input, { authorization: "Bearer attacker", "x-forwarded-client-cert": "attacker" }), context);
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ approval: saved });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-type")).toContain("application/json");
    const [url, options] = vi.mocked(fetch).mock.lastCall!;
    expect(url).toBe(`http://cosmos.test/surface-api/v1/pins/${id}/local-voice`);
    expect(options?.method).toBe("POST");
    expect(options?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json" });
    expect(options?.body).toBe(JSON.stringify(input));
    expect(options?.redirect).toBe("error");
  }
  for (const approval of [null, { approvalRevision: 2, revision: 1, policy: voiceInput.policy },
    { approvalRevision: 1, revision: 2, policy: voiceInput.policy }, { approvalRevision: 1, revision: 1, policy: null },
    { approvalRevision: 1, revision: 1, policy: { sourceFloor: "private" } }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ approval }));
    expect((await VOICE_POST(request(voiceInput), context)).status).toBe(503);
  }
});

it("local voice reads are strict, bounded and distinct from unknown or absent policy", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ approval: null }));
  expect(await (await voiceRead()).json()).toEqual({ approval: null });
  expect(vi.mocked(fetch).mock.lastCall?.[1]?.method).toBe("GET");
  for (const result of [Response.json({}), Response.json({ approval: null, token: "secret" }),
    Response.json({ approval: { approvalRevision: 1, revision: 1 } }),
    new Response(JSON.stringify({ approval: null }), { headers: { "content-type": "text/plain" } }),
    new Response("x".repeat(2049), { headers: { "content-type": "application/json" } })]) {
    vi.mocked(fetch).mockResolvedValue(result);
    expect((await voiceRead()).status).toBe(503);
  }
  for (const status of [403, 409, 500]) {
    vi.mocked(fetch).mockResolvedValue(new Response("private reason", { status }));
    const response = await VOICE_POST(request(voiceInput), context);
    expect(response.status).toBe(status === 500 ? 503 : status);
    expect(await response.text()).not.toContain("private reason");
  }
});

it("local voice request cancellation interrupts stalled upstream parsing", async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }));
  const result = VOICE_GET(new Request(`https://center.test/api/devices/runtime/${id}/local-voice`, { signal: controller.signal }), context);
  for (let i = 0; i < 16; i++) await Promise.resolve();
  controller.abort();
  expect((await result).status).toBe(503);
  expect(cancel).toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.lastCall?.[1]?.signal?.aborted).toBe(true);
});
