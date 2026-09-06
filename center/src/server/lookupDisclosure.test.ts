// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), authEnabled: true, cosmos: "http://cosmos.test" }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.authEnabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ get COSMOS_WEBAPI() { return mocks.cosmos; }, surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));

import { GET, POST } from "@/app/api/surfaces/[surfaceId]/web-lookup/route";
import { GET as PLACES_GET, POST as PLACES_POST } from "@/app/api/surfaces/[surfaceId]/places-lookup/route";
import { LOOKUP_SERVICES, LOOKUP_INPUT_BYTES, LOOKUP_RESPONSE_BYTES } from "@/lib/contracts/lookupDisclosure";
import { SessionExpiredError } from "@/server/cosmos";

const surfaceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const url = `https://center.test/api/surfaces/${surfaceId}/web-lookup`;
const placesUrl = `https://center.test/api/surfaces/${surfaceId}/places-lookup`;
const context = { params: Promise.resolve({ surfaceId }) };
const provider = { provider: "searxng", endpoint: "https://search.example/search", configurationDigest: "a".repeat(64) };
const policy = { provider, maximumClass: "shared_room" };
const binding = { approvalRevision: 7, incarnation: null };
const browserIncarnation = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const input = { approval: LOOKUP_SERVICES.web.approval, approvalRevision: 7, approvalIncarnation: null, expectedRevision: 2, policy };
const saved = { approval: { approvalRevision: 7, revision: 3, policy }, providers: [provider], binding };
const placesProvider = { provider: "google_places", endpoint: "https://places.googleapis.com/", configurationDigest: "b".repeat(64) };
const placesPolicy = { provider: placesProvider, maximumClass: "shared_room" };
const placesInput = { ...input, approval: LOOKUP_SERVICES.places.approval, expectedRevision: 0, policy: placesPolicy };
const placesSaved = { approval: { approvalRevision: 7, revision: 1, policy: placesPolicy }, providers: [placesProvider], binding };

function request(body: unknown = input, options: RequestInit = {}, target = url): Request {
  return new Request(target, { method: "POST", ...options, headers: { "content-type": "application/json", ...options.headers }, body: JSON.stringify(body) });
}
const read = (options: RequestInit = {}) => GET(new Request(url, options), context);
const write = (body: unknown = input, options: RequestInit = {}) => POST(request(body, options), context);
const readPlaces = (options: RequestInit = {}) => PLACES_GET(new Request(placesUrl, options), context);
const writePlaces = (body: unknown = placesInput, options: RequestInit = {}) => PLACES_POST(request(body, options, placesUrl), context);

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

it("requires configured owner login and a current session on reads and writes", async () => {
  const handlers = [read, write, readPlaces, writePlaces];
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

it("rejects cross-origin mutations before body reading or owner authority", async () => {
  mocks.origin.mockReturnValue(false);
  for (const [handler, target] of [[POST, url], [PLACES_POST, placesUrl]] as const) {
    const pull = vi.fn();
    const incoming = new Request(target, { method: "POST", headers: { "content-type": "application/json" },
      body: new ReadableStream({ pull }, { highWaterMark: 0 }), duplex: "half" } as RequestInit);
    const result = await handler(incoming, context);
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "same_origin_required" });
    expect(pull).not.toHaveBeenCalled();
    await incoming.body?.cancel();
  }
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects invalid surface IDs and complete malformed policies before acquiring authority", async () => {
  for (const id of ["", "../native", "00000000-0000-0000-0000-000000000000", surfaceId + "\n"]) {
    const invalidContext = { params: Promise.resolve({ surfaceId: id }) };
    expect((await GET(new Request(url), invalidContext)).status).toBe(400);
    expect((await POST(request(), invalidContext)).status).toBe(400);
  }
  const { policy: omitted, ...missingPolicy } = input;
  void omitted;
  for (const body of [null, [], {}, missingPolicy, { ...input, principal: "other" }, { ...input, approval: "approve" },
    { ...input, approvalRevision: 0 }, { ...input, expectedRevision: -1 }, { ...input, expectedRevision: Number.MAX_SAFE_INTEGER },
    ...[undefined, "", "not-a-uuid", "00000000-0000-0000-0000-000000000000", browserIncarnation + "\n", false]
      .map(approvalIncarnation => ({ ...input, approvalIncarnation })),
    { ...input, policy: { ...policy, maximumClass: "private" } },
    { ...input, policy: { ...policy, provider: { ...provider, endpoint: "https://other.example/search?query=secret" } } },
    { ...input, policy: { ...policy, provider: { ...provider, configurationDigest: "A".repeat(64) } } }]) {
    expect((await write(body)).status).toBe(400);
  }
  for (const contentType of ["text/plain", "application/json-patch+json", ""]) {
    expect((await write(input, { headers: { "content-type": contentType } })).status).toBe(400);
  }
  for (const body of ["{", new Uint8Array([0xff])]) {
    expect((await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body }), context)).status).toBe(400);
  }
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("forwards canonical IDs and exact policy with only server owner headers", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(saved));
  const result = await POST(request(input, { headers: {
    authorization: "Bearer caller", "x-forwarded-client-cert": "caller", "x-cosmos-admin-token": "caller", "x-cosmos-surface-token": "caller",
  } }), { params: Promise.resolve({ surfaceId: surfaceId.toUpperCase() }) });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(saved);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(result.headers.get("content-type")).toContain("application/json");
  const [target, options] = vi.mocked(fetch).mock.lastCall!;
  expect(target).toBe(`http://cosmos.test/surface-api/v1/surfaces/${surfaceId}/web-lookup`);
  expect(options?.method).toBe("POST");
  expect(options?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json" });
  expect(JSON.parse(String(options?.body))).toEqual(input);
  expect(options?.cache).toBe("no-store");
  expect(options?.redirect).toBe("error");
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});

it("reads bounded owner policy and current candidates without implying stale policy is current", async () => {
  mocks.origin.mockReturnValue(false);
  for (const state of [{ approval: null, providers: [], binding }, saved, { ...saved, providers: [] },
    { approval: { ...saved.approval, policy: null }, providers: [], binding },
    { ...saved, binding: { approvalRevision: 10, incarnation: browserIncarnation } }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json(state));
    const result = await read();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(state);
  }
  const [target, options] = vi.mocked(fetch).mock.lastCall!;
  expect(target).toBe(`http://cosmos.test/surface-api/v1/surfaces/${surfaceId}/web-lookup`);
  expect(options?.method).toBe("GET");
  expect(options?.body).toBeUndefined();
  expect(mocks.origin).not.toHaveBeenCalled();
});

it("reads, grants and revokes Places permission only through its own route and policy revision", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ approval: null, providers: [placesProvider], binding }));
  const current = await readPlaces();
  expect(current.status).toBe(200);
  expect(await current.json()).toEqual({ approval: null, providers: [placesProvider], binding });
  expect(vi.mocked(fetch).mock.lastCall?.[0]).toBe(`http://cosmos.test/surface-api/v1/surfaces/${surfaceId}/places-lookup`);
  expect(vi.mocked(fetch).mock.lastCall?.[1]?.method).toBe("GET");

  vi.mocked(fetch).mockResolvedValue(Response.json(placesSaved));
  const granted = await writePlaces(placesInput, { headers: { authorization: "Bearer caller", "x-cosmos-admin-token": "caller" } });
  expect(granted.status).toBe(200);
  expect(await granted.json()).toEqual(placesSaved);
  const [target, options] = vi.mocked(fetch).mock.lastCall!;
  expect(target).toBe(`http://cosmos.test/surface-api/v1/surfaces/${surfaceId}/places-lookup`);
  expect(options?.method).toBe("POST");
  expect(options?.headers).toEqual({ authorization: "Bearer server-only", "content-type": "application/json" });
  expect(JSON.parse(String(options?.body))).toEqual(placesInput);
  expect(options?.redirect).toBe("error");
  expect(options?.signal).toBeInstanceOf(AbortSignal);

  const revoke = { ...placesInput, expectedRevision: 1, policy: null };
  const revoked = { approval: { ...placesSaved.approval, revision: 2, policy: null }, providers: [], binding };
  vi.mocked(fetch).mockResolvedValue(Response.json(revoked));
  const result = await writePlaces(revoke);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(revoked);
  expect(JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body))).toEqual(revoke);
  expect(vi.mocked(fetch).mock.calls.every(([target]) => target === `http://cosmos.test/surface-api/v1/surfaces/${surfaceId}/places-lookup`)).toBe(true);
});

it("rejects cross-service providers and approval tokens even for null revocations before owner authority", async () => {
  for (const body of [{ ...input, policy: placesPolicy }, { ...input, approval: LOOKUP_SERVICES.places.approval },
    { ...input, approval: LOOKUP_SERVICES.places.approval, policy: null }, { ...input, service: "places" }]) {
    expect((await write(body)).status).toBe(400);
  }
  for (const body of [{ ...placesInput, policy }, { ...placesInput, approval: LOOKUP_SERVICES.web.approval },
    { ...placesInput, approval: LOOKUP_SERVICES.web.approval, policy: null }, { ...placesInput, service: "web" },
    { ...placesInput, policy: { ...placesPolicy, provider: { ...provider, provider: "serp_api" } } }]) {
    expect((await writePlaces(body)).status).toBe(400);
  }
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not admit query content, location, speech or device actions into Places disclosure permissions", async () => {
  for (const body of [
    ...["query", "deviceLocation", "locationHistory", "speech", "navigation", "deviceAction"]
      .map(field => ({ ...placesInput, [field]: true })),
    ...["deviceLocation", "locationHistory", "speech", "navigation", "deviceAction"]
      .map(field => ({ ...placesInput, policy: { ...placesPolicy, [field]: true } })),
    { ...placesInput, policy: { ...placesPolicy, maximumClass: "private" } },
  ]) {
    expect((await writePlaces(body)).status).toBe(400);
  }
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects upstream cross-service candidates and policies without disclosing them", async () => {
  for (const state of [{ ...saved, providers: [placesProvider] }, { ...saved, approval: { ...saved.approval, policy: placesPolicy } }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json(state));
    expect((await read()).status).toBe(503);
  }
  for (const state of [{ ...placesSaved, providers: [provider] }, { ...placesSaved, providers: [placesProvider, placesProvider] },
    { ...placesSaved, approval: { ...placesSaved.approval, policy } },
    { ...placesSaved, deviceLocation: { latitude: 1, longitude: 1 } }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json(state));
    const result = await readPlaces();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
  }
});

it("confirms Places commits against the reviewed policy, revision and current incarnation", async () => {
  for (const state of [
    { ...placesSaved, approval: null },
    { ...placesSaved, approval: { ...placesSaved.approval, revision: 2 } },
    { ...placesSaved, approval: { ...placesSaved.approval, policy: null } },
    { ...placesSaved, approval: { ...placesSaved.approval, policy: { ...placesPolicy, provider: { ...placesProvider, configurationDigest: "c".repeat(64) } } } },
    { ...placesSaved, binding: { ...binding, approvalRevision: 8 } },
    { ...placesSaved, binding: { ...binding, incarnation: browserIncarnation } },
  ]) {
    vi.mocked(fetch).mockResolvedValue(Response.json(state));
    const result = await writePlaces();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
  }
  const browserInput = { ...placesInput, approvalIncarnation: browserIncarnation };
  const advanced = { ...placesSaved, binding: { approvalRevision: 8, incarnation: browserIncarnation } };
  vi.mocked(fetch).mockResolvedValue(Response.json(advanced));
  expect((await writePlaces(browserInput)).status).toBe(200);
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...advanced,
    binding: { ...advanced.binding, incarnation: "cccccccc-cccc-cccc-cccc-cccccccccccc" } }));
  expect((await writePlaces(browserInput)).status).toBe(503);
});

it("requires exact approval, policy and next policy revision after a successful POST", async () => {
  const changedProvider = { ...provider, configurationDigest: "b".repeat(64) };
  for (const approval of [null, { ...saved.approval, approvalRevision: 8 }, { ...saved.approval, revision: 2 },
    { ...saved.approval, revision: 4 }, { ...saved.approval, policy: null },
    { ...saved.approval, policy: { ...policy, provider: changedProvider } },
    { ...saved.approval, policy: { ...policy, provider: { ...provider, endpoint: "https://other.example/search" } } }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...saved, approval }));
    const result = await write();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
  }
  expect(fetch).toHaveBeenCalledTimes(7);
});

it("binds committed writes to the reviewed incarnation and requires exact Native and Pin revisions", async () => {
  for (const observed of [{ ...binding, approvalRevision: 6 }, { ...binding, approvalRevision: 8 },
    { ...binding, incarnation: browserIncarnation }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...saved, binding: observed }));
    const result = await write();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
  }
  const browserInput = { ...input, approvalIncarnation: browserIncarnation };
  for (const observed of [{ ...binding }, { approvalRevision: 6, incarnation: browserIncarnation },
    { approvalRevision: 8, incarnation: "cccccccc-cccc-cccc-cccc-cccccccccccc" }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...saved, binding: observed }));
    expect((await write(browserInput)).status).toBe(503);
  }
  expect(fetch).toHaveBeenCalledTimes(6);
});

it("rejects advanced Native and Pin bindings for revocations and impossible saved revisions on reads", async () => {
  for (const policy of [input.policy, null]) {
    for (const revision of [6, 8]) {
      const state = { ...saved, approval: { ...saved.approval, policy }, binding: { ...binding, approvalRevision: revision } };
      vi.mocked(fetch).mockResolvedValue(Response.json(state));
      expect((await write({ ...input, policy })).status).toBe(503);
      vi.mocked(fetch).mockResolvedValue(Response.json(state));
      expect((await read()).status).toBe(503);
    }
    const impossibleBrowser = { ...saved, approval: { ...saved.approval, policy },
      binding: { approvalRevision: 6, incarnation: browserIncarnation } };
    vi.mocked(fetch).mockResolvedValue(Response.json(impossibleBrowser));
    expect((await read()).status).toBe(503);
  }
});

it("accepts a same-incarnation Browser binding advanced by a heartbeat for grants and revocations", async () => {
  for (const revision of [7, 8]) {
    for (const selectedPolicy of [policy, null]) {
      const state = { ...saved, approval: { ...saved.approval, policy: selectedPolicy },
        binding: { approvalRevision: revision, incarnation: browserIncarnation } };
      const browserInput = { ...input, approvalIncarnation: browserIncarnation, policy: selectedPolicy };
      vi.mocked(fetch).mockResolvedValue(Response.json(state));
      const result = await write(browserInput);
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual(state);
      expect(JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body))).toEqual(browserInput);
    }
  }
});

it("revokes with explicit null even with no available provider and verifies the committed revocation", async () => {
  const revoked = { approval: { ...saved.approval, policy: null }, providers: [], binding };
  vi.mocked(fetch).mockResolvedValue(Response.json(revoked));
  const result = await write({ ...input, policy: null });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(revoked);
  expect(JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body))).toEqual({ ...input, policy: null });
  for (const state of [saved, { ...revoked, approval: null }, { ...revoked, approval: { ...revoked.approval, revision: 2 } }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json(state));
    expect((await write({ ...input, policy: null })).status).toBe(503);
  }
});

it("rejects nonexact upstream envelopes and provider candidates instead of passing unknown fields", async () => {
  for (const state of [{}, { approval: null }, { providers: [] }, { ...saved, ownerToken: "secret" },
    { ...saved, binding: undefined }, { ...saved, binding: null }, { ...saved, binding: {} },
    { ...saved, binding: { approvalRevision: 7 } }, { ...saved, binding: { ...binding, approvalRevision: 0 } },
    { ...saved, binding: { ...binding, incarnation: "00000000-0000-0000-0000-000000000000" } },
    { ...saved, binding: { ...binding, incarnation: browserIncarnation + "\n" } },
    { ...saved, binding: { ...binding, token: "secret" } },
    { ...saved, approval: { ...saved.approval, secret: "secret" } },
    { ...saved, providers: [{ ...provider, apiKey: "secret" }] }, { ...saved, providers: [provider, provider] },
    { ...saved, providers: [provider, provider, provider] }]) {
    vi.mocked(fetch).mockResolvedValue(Response.json(state));
    const result = await read();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
  }
});

it("enforces incoming byte bounds at 4096 and cancels oversized streamed bodies before authority", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(saved));
  const padded = JSON.stringify(input).padEnd(LOOKUP_INPUT_BYTES, " ");
  const incoming = new Request(url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: padded });
  expect((await POST(incoming, context)).status).toBe(200);
  mocks.headers.mockClear();
  vi.mocked(fetch).mockClear();
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode(padded + " ");
  const oversized = new Request(url, { method: "POST", headers: { "content-type": "application/json" },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel }), duplex: "half" } as RequestInit);
  expect((await POST(oversized, context)).status).toBe(400);
  expect(cancel).toHaveBeenCalled();
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("requires JSON UTF-8 and bounds successful upstream bodies at 8192 bytes", async () => {
  for (const response of [new Response(JSON.stringify(saved)),
    new Response(JSON.stringify(saved), { headers: { "content-type": "text/plain" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    new Response(" ".repeat(LOOKUP_RESPONSE_BYTES + 1), { headers: { "content-type": "application/json" } })]) {
    vi.mocked(fetch).mockResolvedValue(response);
    expect((await read()).status).toBe(503);
  }
  const padded = JSON.stringify(saved).padEnd(LOOKUP_RESPONSE_BYTES, " ");
  vi.mocked(fetch).mockResolvedValue(new Response(padded, { headers: { "content-type": "application/json; charset=utf-8" } }));
  expect((await read()).status).toBe(200);
});

it("preserves revision conflicts and sanitizes upstream errors without reading error bodies", async () => {
  for (const [status, error] of [[400, "invalid_request"], [401, "unauthorized"], [403, "forbidden"], [404, "not_found"],
    [409, "conflict"], [429, "surface_limit"], [503, "unavailable"], [500, "unavailable"], [302, "unavailable"]] as const) {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ cancel }), { status }));
    const result = await write();
    expect(result.status).toBe(status === 500 || status === 302 ? 503 : status);
    expect(await result.json()).toEqual({ error });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(cancel).toHaveBeenCalled();
  }
});

it("does not retry a mutation when its successful upstream response is lost or malformed", async () => {
  for (const response of [new Response(null, { status: 204 }),
    new Response(new ReadableStream({ pull(controller) { controller.error(new Error("private transport details")); } }),
      { headers: { "content-type": "application/json" } })]) {
    vi.mocked(fetch).mockClear().mockResolvedValue(response);
    const result = await write();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  vi.mocked(fetch).mockClear().mockRejectedValue(new Error("private upstream details"));
  expect(await (await write()).json()).toEqual({ error: "unavailable" });
  expect(fetch).toHaveBeenCalledTimes(1);
  mocks.cosmos = "";
  vi.mocked(fetch).mockClear();
  expect((await read()).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds stalled incoming bodies by caller cancellation and deadline without owner authority", async () => {
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    if (timeout) vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const incoming = new Request(url, { method: "POST", headers: { "content-type": "application/json" },
      body: new ReadableStream({ pull() { reading(); }, cancel }, { highWaterMark: 0 }),
      ...(timeout ? {} : { signal: controller.signal }), duplex: "half" } as RequestInit);
    const result = POST(incoming, context);
    await started;
    controller.abort();
    expect((await result).status).toBe(400);
    expect(cancel).toHaveBeenCalled();
    vi.restoreAllMocks();
  }
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("cancels upstream streams on caller abort and never retries interrupted policy writes", async () => {
  for (const mutation of [false, true]) {
    const controller = new AbortController();
    const cancel = vi.fn();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    vi.mocked(fetch).mockClear().mockResolvedValue(new Response(
      new ReadableStream({ pull() { reading(); }, cancel }, { highWaterMark: 0 }),
      { headers: { "content-type": "application/json" } }));
    const result = mutation ? write(input, { signal: controller.signal }) : read({ signal: controller.signal });
    await started;
    controller.abort();
    expect((await result).status).toBe(503);
    expect(cancel).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.lastCall?.[1]?.signal?.aborted).toBe(true);
  }
});

it("applies the upstream deadline to body reads and stops already-cancelled reads before authority", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const cancel = vi.fn();
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  vi.mocked(fetch).mockResolvedValue(new Response(
    new ReadableStream({ pull() { reading(); }, cancel }, { highWaterMark: 0 }),
    { headers: { "content-type": "application/json" } }));
  const result = read();
  await started;
  controller.abort();
  expect((await result).status).toBe(503);
  expect(cancel).toHaveBeenCalled();
  mocks.headers.mockClear();
  vi.mocked(fetch).mockClear();
  expect((await read({ signal: controller.signal })).status).toBe(503);
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
