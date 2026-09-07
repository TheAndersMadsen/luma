// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), authEnabled: true, cosmos: "http://cosmos.test" }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.authEnabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ get COSMOS_WEBAPI() { return mocks.cosmos; }, surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));

import { GET, POST } from "@/app/api/surfaces/native/route";
import { DELETE } from "@/app/api/surfaces/native/[surfaceId]/route";
import { GET as LOOKUP } from "@/app/api/surfaces/native/enrollments/[enrollmentId]/route";
import { NATIVE_APPROVAL, nativePosture } from "@/lib/contracts/nativeSurfaces";
import { SessionExpiredError } from "@/server/cosmos";

const url = "https://center.test/api/surfaces/native";
const surfaceId = "11111111-1111-1111-1111-111111111111";
const enrollmentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const otherId = "22222222-2222-2222-2222-222222222222";
const keyBytes = Buffer.from("046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", "hex");
const publicKey = keyBytes.toString("base64url");
const publicKeyFingerprint = createHash("sha256").update(keyBytes).digest("hex");
const approval = { enrollmentId, publicKey, platform: "macos", approval: NATIVE_APPROVAL, expectedRevision: 0 };
const native = { ...nativePosture("macos"), surfaceId, enrollmentId, platform: "macos", revision: 1, publicKeyFingerprint, revoked: false, display: true, speech: true,
  actions: ["action.open", "action.run"], confirms: true, connected: false, visible: false, privateDisplay: false };
const surfaceContext = { params: Promise.resolve({ surfaceId }) };
const enrollmentContext = { params: Promise.resolve({ enrollmentId }) };

function request(body: unknown = approval, options: RequestInit = {}): Request {
  return new Request(url, { method: "POST", ...options, headers: { "content-type": "application/json", ...options.headers }, body: JSON.stringify(body) });
}
const list = (options: RequestInit = {}) => GET(new Request(url, options));
const lookup = (options: RequestInit = {}) => LOOKUP(new Request(`${url}/enrollments/${enrollmentId}`, options), enrollmentContext);
const revoke = (body: unknown = { expectedRevision: 1 }, options: RequestInit = {}) => DELETE(request(body, { method: "DELETE", ...options }), surfaceContext);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authEnabled = true;
  mocks.cosmos = "http://cosmos.test";
  mocks.session.mockResolvedValue({ sub: "owner" });
  mocks.headers.mockResolvedValue({ authorization: "Bearer server-only" });
  mocks.origin.mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("every native owner route requires configured login, a session and the owner's bearer", async () => {
  const handlers = [list, lookup, () => POST(request()), revoke];
  mocks.authEnabled = false;
  for (const handler of handlers) expect((await handler()).status).toBe(503);
  expect(mocks.session).not.toHaveBeenCalled();
  mocks.authEnabled = true;
  mocks.session.mockResolvedValue(null);
  for (const handler of handlers) expect((await handler()).status).toBe(401);
  expect(mocks.headers).not.toHaveBeenCalled();
  mocks.session.mockResolvedValue({ sub: "owner" });
  mocks.headers.mockRejectedValue(new SessionExpiredError());
  for (const handler of handlers) expect((await handler()).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});

it("mutations reject other origins before reading bodies or acquiring owner authority", async () => {
  mocks.origin.mockReturnValue(false);
  expect((await POST(request())).status).toBe(403);
  expect((await revoke()).status).toBe(403);
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects malformed approval descriptors and revisions before acquiring owner authority", async () => {
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url");
  for (const body of [null, [], {}, { ...approval, ownerId: "other" }, { ...approval, enrollmentId: "../other" },
    { ...approval, enrollmentId: "00000000-0000-0000-0000-000000000000" }, { ...approval, platform: "ios" },
    { ...approval, approval: "private" }, { ...approval, publicKey: publicKey + "=" }, { ...approval, publicKey: offCurve },
    { ...approval, expectedRevision: -1 }, { ...approval, expectedRevision: 0.5 }, { ...approval, expectedRevision: "0" },
    { ...approval, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...approval, publicKey: "a".repeat(2048) }]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect((await POST(request(approval, { headers: { "content-type": "text/plain" } }))).status).toBe(400);
  expect((await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).status).toBe(400);
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("requires an exact bounded revoke revision and a valid target on both parameterized routes", async () => {
  for (const body of [null, [], {}, { expectedRevision: 0 }, { expectedRevision: -1 }, { expectedRevision: 1.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER }, { expectedRevision: 1, revoked: true }, { expectedRevision: "1" }]) {
    expect((await revoke(body)).status).toBe(400);
  }
  expect((await revoke({ expectedRevision: 1 }, { headers: { "content-type": "text/plain" } })).status).toBe(400);
  for (const id of ["../other", "", "00000000-0000-0000-0000-000000000000"]) {
    expect((await DELETE(request({ expectedRevision: 1 }), { params: Promise.resolve({ surfaceId: id }) })).status).toBe(400);
    expect((await LOOKUP(new Request(url), { params: Promise.resolve({ enrollmentId: id }) })).status).toBe(400);
  }
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("forwards only the canonical descriptor and server bearer and strips upstream credentials", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ native: { ...native, privateKey: "secret", token: "secret", ownerId: "other" }, connection: "secret" }));
  const result = await POST(request({ ...approval, enrollmentId: enrollmentId.toUpperCase() }, {
    headers: { authorization: "Bearer attacker", "x-forwarded-client-cert": "attacker", "x-cosmos-admin-token": "attacker", "x-cosmos-surface-token": "attacker" },
  }));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ native });
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(result.headers.get("content-type")).toContain("application/json");
  const [target, options] = vi.mocked(fetch).mock.calls[0];
  expect(target).toBe("http://cosmos.test/surface-api/v1/native");
  expect(options?.method).toBe("POST");
  expect(options?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json" });
  expect(options?.body).toBe(JSON.stringify(approval));
  expect(options?.cache).toBe("no-store");
  expect(options?.redirect).toBe("error");
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});

it("binds successful approvals to the enrollment, platform, key fingerprint and committed posture", async () => {
  for (const changed of [{ ...native, enrollmentId: otherId }, { ...native, platform: "linux" },
    { ...native, publicKeyFingerprint: "a".repeat(64) }, { ...native, revoked: true }, { ...native, revision: 2 },
    { ...native, trustLevel: 1 }, { ...native, occupancy: "private" }, { ...native, actorIdentity: "owner" },
    { ...native, renderVerified: true }, { ...native, playbackVerified: true },
    { ...native, manifest: { ...native.manifest, capabilities: { input: ["text.public"], output: { "audio.tts": {} } } } }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ native: changed }));
    const result = await POST(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
  }
});

it("accepts only the backend's current-or-next approval revision for exact idempotent retries", async () => {
  for (const revision of [4, 5]) {
    const saved = { ...native, revision };
    vi.mocked(fetch).mockResolvedValue(Response.json({ native: saved }));
    const result = await POST(request({ ...approval, expectedRevision: 4 }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ native: saved });
  }
  for (const revision of [1, 3, 6]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ native: { ...native, revision } }));
    expect((await POST(request({ ...approval, expectedRevision: 4 }))).status).toBe(503);
  }
});

it("revocation sends the exact observed revision and requires the same surface at the next revoked revision", async () => {
  const saved = { ...native, revoked: true, revision: 2 };
  vi.mocked(fetch).mockResolvedValue(Response.json({ native: saved }));
  const result = await revoke();
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ native: saved });
  const [target, options] = vi.mocked(fetch).mock.lastCall!;
  expect(target).toBe(`http://cosmos.test/surface-api/v1/native/${surfaceId}`);
  expect(options?.method).toBe("DELETE");
  expect(options?.body).toBe(JSON.stringify({ expectedRevision: 1 }));
  expect(options?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json" });
  for (const changed of [native, { ...saved, surfaceId: otherId }, { ...saved, revoked: false }, { ...saved, revision: 1 }, { ...saved, revision: 3 }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ native: changed }));
    expect((await revoke()).status).toBe(503);
  }
});

it("owner lookup includes revoked metadata, canonicalizes the enrollment route and binds its result", async () => {
  mocks.origin.mockReturnValue(false);
  for (const revoked of [false, true]) {
    const saved = { ...native, revoked };
    vi.mocked(fetch).mockResolvedValue(Response.json({ native: { ...saved, secret: "not-owner-metadata" } }));
    const result = await LOOKUP(new Request(url), { params: Promise.resolve({ enrollmentId: enrollmentId.toUpperCase() }) });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ native: saved });
  }
  const [target, options] = vi.mocked(fetch).mock.lastCall!;
  expect(target).toBe(`http://cosmos.test/surface-api/v1/native/enrollments/${enrollmentId}`);
  expect(options?.method).toBe("GET");
  expect(options?.body).toBeUndefined();
  vi.mocked(fetch).mockResolvedValue(Response.json({ native: { ...native, enrollmentId: otherId } }));
  expect((await lookup()).status).toBe(503);
});

it("lists active native metadata only and rejects duplicate, oversized and elevated projections", async () => {
  const second = { ...native, ...nativePosture("android_tv"), surfaceId: otherId, enrollmentId: otherId, platform: "android_tv",
    actions: ["action.play"], confirms: false };
  vi.mocked(fetch).mockResolvedValue(Response.json({ native: [{ ...native, token: "secret" }, second], secret: "not-owner-metadata" }));
  const result = await list();
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ native: [native, second] });
  expect(vi.mocked(fetch).mock.lastCall?.[1]?.method).toBe("GET");
  // Presence comes from the runtime's list only; a row without it is simply not connected.
  const { connected: _connected, visible: _visible, privateDisplay: _privateDisplay, ...bare } = native;
  vi.mocked(fetch).mockResolvedValue(Response.json({ native: [{ ...bare, connected: true, visible: true, privateDisplay: true }, second] }));
  expect(await (await list()).json()).toEqual({ native: [{ ...native, connected: true, visible: true, privateDisplay: true }, second] });
  vi.mocked(fetch).mockResolvedValue(Response.json({ native: [] }));
  expect(await (await list()).json()).toEqual({ native: [] });
  for (const rows of [null, [native, native], [native, { ...second, enrollmentId }], [native, { ...second, surfaceId }],
    Array(17).fill(native), [{ ...native, revoked: true }], [{ ...native, revision: 0 }], [{ ...native, platform: "ios" }],
    [{ ...native, publicKeyFingerprint: publicKeyFingerprint.toUpperCase() }], [{ ...native, actorIdentity: "owner" }]]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ native: rows }));
    expect((await list()).status).toBe(503);
  }
});

it("checks upstream JSON content type, response byte limits, encoding and required envelopes", async () => {
  for (const response of [new Response(JSON.stringify({ native }), { headers: { "content-type": "text/plain" } }),
    new Response(JSON.stringify({ native })), new Response("{" , { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    Response.json({}), Response.json({ native: null }),
    new Response(" ".repeat(4097), { headers: { "content-type": "application/json" } })]) {
    vi.mocked(fetch).mockResolvedValue(response);
    expect((await lookup()).status).toBe(503);
  }
  vi.mocked(fetch).mockResolvedValue(new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } }));
  expect((await list()).status).toBe(503);
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ native }), { headers: { "content-type": "application/json; charset=utf-8" } }));
  expect((await lookup()).status).toBe(200);
});

it("sanitizes upstream failures and transport exceptions without caching or reading error bodies", async () => {
  for (const [status, error] of [[400, "invalid_request"], [401, "unauthorized"], [403, "forbidden"], [404, "not_found"],
    [409, "conflict"], [429, "surface_limit"], [500, "unavailable"], [503, "unavailable"], [302, "unavailable"]] as const) {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ cancel }), { status }));
    const result = await lookup();
    expect(result.status).toBe(status === 500 || status === 302 ? 503 : status);
    expect(await result.json()).toEqual({ error });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(cancel).toHaveBeenCalled();
  }
  vi.mocked(fetch).mockRejectedValue(new Error("private upstream diagnostic"));
  expect(await (await list()).json()).toEqual({ error: "unavailable" });
  mocks.cosmos = "";
  vi.mocked(fetch).mockClear();
  expect((await list()).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});

it("cancels oversized and invalid UTF-8 incoming bodies before owner authority or Cosmos", async () => {
  for (const bytes of [new Uint8Array(1025).fill(32), new Uint8Array([0xff])]) {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel });
    const incoming = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    // Invalid UTF-8 needs an ended stream so decoding is reached without a timeout.
    if (bytes.length === 1) {
      const ended = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: bytes });
      expect((await POST(ended)).status).toBe(400);
      await incoming.body?.cancel();
    } else {
      expect((await POST(incoming)).status).toBe(400);
    }
    expect(cancel).toHaveBeenCalled();
  }
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds stalled incoming approval and revoke streams by timeout and caller cancellation", async () => {
  for (const operation of ["approve", "revoke"]) {
    for (const timeout of [false, true]) {
      const controller = new AbortController();
      if (timeout) vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      const cancel = vi.fn();
      const incoming = new Request(url, { method: operation === "approve" ? "POST" : "DELETE",
        headers: { "content-type": "application/json" }, body: new ReadableStream({ cancel }),
        ...(timeout ? {} : { signal: controller.signal }), duplex: "half" } as RequestInit);
      const result = operation === "approve" ? POST(incoming) : DELETE(incoming, surfaceContext);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      controller.abort();
      expect((await result).status).toBe(400);
      expect(cancel).toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  }
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("caller cancellation interrupts every route's upstream stream using the fetch signal", async () => {
  for (const operation of ["list", "lookup", "approve", "revoke"]) {
    const controller = new AbortController();
    const cancel = vi.fn();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    vi.mocked(fetch).mockResolvedValue(new Response(
      new ReadableStream({ pull() { reading(); }, cancel }, { highWaterMark: 0 }),
      { headers: { "content-type": "application/json" } },
    ));
    const options = { signal: controller.signal };
    const result = operation === "list" ? list(options) : operation === "lookup" ? lookup(options)
      : operation === "approve" ? POST(request(approval, options)) : revoke({ expectedRevision: 1 }, options);
    await started;
    controller.abort();
    expect((await result).status).toBe(503);
    expect(cancel).toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.lastCall?.[1]?.signal?.aborted).toBe(true);
  }
});

it("uses the fetch deadline to cancel a stalled upstream body and rejects already-cancelled requests", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const cancel = vi.fn();
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  vi.mocked(fetch).mockResolvedValue(new Response(
    new ReadableStream({ pull() { reading(); }, cancel }, { highWaterMark: 0 }),
    { headers: { "content-type": "application/json" } },
  ));
  const result = list();
  await started;
  controller.abort();
  expect((await result).status).toBe(503);
  expect(cancel).toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.lastCall?.[1]?.signal?.aborted).toBe(true);
  vi.mocked(fetch).mockClear();
  expect((await lookup({ signal: controller.signal })).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});
