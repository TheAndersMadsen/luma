// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativePosture, type NativePlatform } from "@/lib/contracts/nativeSurfaces";
import { BROWSER_SURFACE_POSTURE } from "@/lib/contracts/surfaces";
import { PIN_SURFACE_POSTURE } from "@/lib/contracts/pinSurfaces";

const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), authEnabled: true, cosmos: "http://cosmos.test" }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.authEnabled; } }));
vi.mock("@/server/cosmos", () => ({ get COSMOS_WEBAPI() { return mocks.cosmos; }, surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));

import { readActivity } from "@/server/activity";

const phone = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mac = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const browser = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const pin = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const turn = "10000000-0000-4000-8000-000000000001";
const actionId = "20000000-0000-4000-8000-000000000001";
const native = (surfaceId: string, platform: NativePlatform) => ({ ...nativePosture(platform), surfaceId, enrollmentId: surfaceId, platform, revision: 1,
  publicKeyFingerprint: "f".repeat(64), revoked: false });
const lists: Record<string, unknown> = {
  "/surface-api/v1/native": { native: [native(phone, "android"), native(mac, "macos")] },
  "/surface-api/v1/surfaces": { surfaces: [{ ...BROWSER_SURFACE_POSTURE, surfaceId: browser, revision: 1, sequence: 0, revoked: false, visible: true, connected: true, available: true, connectionExpiresAt: 1, leaseExpiresAt: 1 }] },
  "/surface-api/v1/pins": { pins: [{ ...PIN_SURFACE_POSTURE, surfaceId: pin, deviceId: "2c2a0001104000ff", revision: 1, revoked: false, currentPaired: true }] },
};
const ledger = { events: [
  { version: 3, principal: "U:owner", sequence: 1, previous_hash: "", receipt_ms: 1_757_000_000_000, data: { kind: "turn_began", turn_id: turn, generation: 1, origin: pin, request_digest: "c".repeat(64), privacy: "shared_room" } },
  { version: 3, principal: "U:owner", sequence: 2, previous_hash: "", receipt_ms: 1_757_000_001_000, data: { kind: "decision", turn_id: turn, generation: 1, action_id: actionId, privacy: "shared_room", hint: "browser", shape: "note", candidates: [
    { surface_id: browser, channel: "visual.card", blocker: null, score_version: 3, shape_fit: 1200, origin_affinity: 0, hint: 400, attention: 0, preference: 0 },
    { surface_id: phone, channel: "visual.card", blocker: "unavailable", score_version: 3, shape_fit: 0, origin_affinity: 0, hint: 0, attention: 0, preference: 0 }] } },
  { version: 3, principal: "U:owner", sequence: 3, previous_hash: "", receipt_ms: 1_757_000_002_000, data: { kind: "action_changed", action_id: actionId, turn_id: turn, generation: 1, status: "acknowledged", channel: "visual.card", surface_id: browser, incarnation: mac, content_digest: "d".repeat(64), deadline_ms: 1, attempt: 1 } },
  { version: 3, principal: "U:owner", sequence: 4, previous_hash: "", receipt_ms: 1_757_000_003_000, data: { kind: "turn_finished", turn_id: turn, generation: 1 } },
] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authEnabled = true; mocks.cosmos = "http://cosmos.test";
  mocks.session.mockResolvedValue({ sub: "owner" });
  mocks.headers.mockResolvedValue({ authorization: "Bearer server-only" });
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url).slice("http://cosmos.test".length);
    if (path === "/surface-api/v1/ledger?limit=300") return Response.json(ledger);
    if (path in lists) return Response.json(lists[path]);
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reads the owner's ledger and device lists with the owner bearer and names devices by kind only", async () => {
  const activity = await readActivity();
  expect(activity).toEqual({ state: "ready", unnamed: false, rows: [{ turnId: turn, startedAt: 1_757_000_000_000, asked: "Asked from your Ai Pin", outcome: "Shown in a browser",
    why: { events: [], candidates: ["A browser could show a card.", "Your phone could not show a card — it was not connected."],
      choice: ["This was a short card to take in at a glance, and that belongs in a browser."],
      hint: "You asked for the browser", privacy: "This reply was safe to show on a screen other people can see.", expression: false } }] });
  const calls = vi.mocked(fetch).mock.calls.map(([url, options]) => [String(url), (options?.headers as Record<string, string>).authorization]);
  expect(calls).toEqual(expect.arrayContaining([
    ["http://cosmos.test/surface-api/v1/ledger?limit=300", "Bearer server-only"], ["http://cosmos.test/surface-api/v1/native", "Bearer server-only"],
    ["http://cosmos.test/surface-api/v1/surfaces", "Bearer server-only"], ["http://cosmos.test/surface-api/v1/pins", "Bearer server-only"]]));
  expect(calls).toHaveLength(4);
  for (const [, options] of vi.mocked(fetch).mock.calls) expect(options).toMatchObject({ cache: "no-store", redirect: "error" });
});

it("is honestly unavailable without login, a session, Cosmos, a readable ledger or a well-formed one", async () => {
  mocks.authEnabled = false; expect(await readActivity()).toEqual({ state: "unavailable" });
  mocks.authEnabled = true; mocks.session.mockResolvedValue(null); expect(await readActivity()).toEqual({ state: "unavailable" });
  mocks.session.mockResolvedValue({ sub: "owner" }); mocks.cosmos = ""; expect(await readActivity()).toEqual({ state: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
  mocks.cosmos = "http://cosmos.test";
  vi.mocked(fetch).mockImplementationOnce(async () => new Response("down", { status: 503 }));
  expect(await readActivity()).toEqual({ state: "unavailable" });
  vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ events: [{ version: 3, principal: "U:owner", sequence: 1, previous_hash: "", receipt_ms: 1,
    data: { kind: "turn_began", turn_id: turn, generation: 1, origin: "phone", request_digest: "", privacy: "shared_room" } }] }));
  expect(await readActivity()).toEqual({ state: "unavailable" });
  mocks.headers.mockRejectedValueOnce(new Error("expired"));
  expect(await readActivity()).toEqual({ state: "unavailable" });
  const { SessionExpiredError } = await import("@/server/cosmos");
  mocks.headers.mockRejectedValueOnce(new SessionExpiredError());
  expect(await readActivity()).toEqual({ state: "expired" });
});

it("keeps the list when a device list cannot be read, says so, and shows those devices as removed", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, options) => String(url).endsWith("/pins") ? new Response(null, { status: 503 }) : original(url, options));
  const activity = await readActivity();
  expect(activity.state).toBe("ready");
  if (activity.state !== "ready") return;
  expect(activity.unnamed).toBe(true);
  expect(activity.rows[0].asked).toBe("Asked from a removed device");
  expect(activity.rows[0].outcome).toBe("Shown in a browser");
});

it("accepts only a bounded runtime account after the owner session check", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let account: unknown = "Cosmos selected your phone.\n\nYour phone showed it.";
  vi.mocked(fetch).mockImplementation(async (url, options) => String(url).includes("/ledger?")
    ? Response.json({ events: [], account }) : original(url, options));
  expect(await readActivity()).toMatchObject({ state: "ready", account });
  for (const invalid of [null, 42, {}, "", " ", "ø".repeat(1901)]) {
    account = invalid;
    expect(await readActivity()).toEqual({ state: "unavailable" });
  }
  vi.mocked(fetch).mockClear();
  mocks.session.mockResolvedValue(null);
  expect(await readActivity()).toEqual({ state: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});
