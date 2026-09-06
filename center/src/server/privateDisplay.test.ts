// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), authEnabled: true, cosmos: "http://cosmos.test" }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.authEnabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ get COSMOS_WEBAPI() { return mocks.cosmos; }, surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));

import { GET, POST } from "@/app/api/surfaces/[surfaceId]/private-display/route";
import { PRIVATE_DISPLAY_APPROVAL } from "@/lib/contracts/privateDisplay";

const surfaceId = "11111111-1111-1111-1111-111111111111";
const url = `https://center.test/api/surfaces/${surfaceId}/private-display`;
const context = { params: Promise.resolve({ surfaceId }) };
const input = { approval: PRIVATE_DISPLAY_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: { maximumClass: "private" } };
const approval = { approvalRevision: 3, revision: 1, policy: { maximumClass: "private" } };
const post = (body: unknown = input, headers: Record<string, string> = { "content-type": "application/json" }) =>
  POST(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }), context);
const get = () => GET(new Request(url), context);

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

it("requires login, a session, same origin for writes and a bounded valid body", async () => {
  mocks.authEnabled = false;
  expect((await get()).status).toBe(503);
  mocks.authEnabled = true;
  mocks.session.mockResolvedValue(null);
  expect((await post()).status).toBe(401);
  mocks.session.mockResolvedValue({ sub: "owner" });
  mocks.origin.mockReturnValue(false);
  expect((await post()).status).toBe(403);
  mocks.origin.mockReturnValue(true);
  expect((await post({ ...input, policy: { maximumClass: "sensitive" } })).status).toBe(400);
  expect((await post({ ...input, approval: "approve-speech-provider-disclosure-v1" })).status).toBe(400);
  expect((await post(input, { "content-type": "text/plain" })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

it("forwards the exact owner request and confirms only the matching committed approval", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ approval }));
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ approval });
  const [target, options] = vi.mocked(fetch).mock.calls[0];
  expect(target).toBe(`http://cosmos.test/surface-api/v1/surfaces/${surfaceId}/private-display`);
  expect(options?.method).toBe("POST");
  expect(JSON.parse(String(options?.body))).toEqual(input);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ approval: { ...approval, revision: 2 } }));
  expect((await post()).status).toBe(503);
  vi.mocked(fetch).mockResolvedValueOnce(new Response("blocked", { status: 409 }));
  expect((await post()).status).toBe(409);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ approval: null }));
  const read = await get();
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ approval: null });
});
