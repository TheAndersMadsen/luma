// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(), origin: vi.fn(), authEnabled: true, cosmos: "http://cosmos.test" }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ get AUTH_ENABLED() { return mocks.authEnabled; }, isSameOriginRequest: mocks.origin }));
vi.mock("@/server/cosmos", () => ({ get COSMOS_WEBAPI() { return mocks.cosmos; }, surfaceOwnerHeaders: mocks.headers, SessionExpiredError: class extends Error {} }));

import { GET as READ_ACTIONS, POST as WRITE_ACTIONS } from "@/app/api/surfaces/[surfaceId]/device-actions/route";
import { GET as READ_COMMANDS, POST as WRITE_COMMANDS } from "@/app/api/surfaces/[surfaceId]/device-commands/route";

const surfaceId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ surfaceId }) };
const actionPolicy = { maximumClass: "shared_room", open: { hosts: ["github.com"], apps: [], roots: [] } };
const commandPolicy = { maximumClass: "shared_room", offerOutputToCognition: false, entries: [
  { id: "tests", label: "Project tests", argv: ["./revival", "check"], cwd: "/Users/owner/app", mutates: true, budgetMs: 60_000 }] };
const actionInput = { approval: "approve-device-actions-v1", approvalRevision: 7, expectedRevision: 3, policy: actionPolicy };
const commandInput = { approval: "approve-device-command-v1", approvalRevision: 7, expectedRevision: 3, policy: commandPolicy };
const url = `https://center.test/api/surfaces/${surfaceId}/device-actions`;
const write = (body: unknown, init: RequestInit = {}) =>
  new Request(url, { method: "POST", ...init, headers: { "content-type": "application/json", ...init.headers }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authEnabled = true; mocks.cosmos = "http://cosmos.test";
  mocks.session.mockResolvedValue({ sub: "owner" });
  mocks.origin.mockReturnValue(true);
  mocks.headers.mockResolvedValue({ authorization: "Bearer server-only" });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("forwards each read to its own Cosmos route with the owner bearer and never caches it", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ approval: { approvalRevision: 7, revision: 4, policy: actionPolicy } }));
  const read = await READ_ACTIONS(new Request(url), context);
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ approval: { approvalRevision: 7, revision: 4, policy: actionPolicy } });
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(vi.mocked(fetch).mock.lastCall?.[0]).toBe(`http://cosmos.test/surface-api/v1/surfaces/${surfaceId}/device-actions`);
  expect(vi.mocked(fetch).mock.lastCall?.[1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });

  vi.mocked(fetch).mockResolvedValue(Response.json({ approval: { approvalRevision: 7, revision: 4, policy: commandPolicy } }));
  await READ_COMMANDS(new Request(url), context);
  expect(vi.mocked(fetch).mock.lastCall?.[0]).toBe(`http://cosmos.test/surface-api/v1/surfaces/${surfaceId}/device-commands`);
});

it("writes only what Cosmos echoes back at the next revision, and never a policy it changed", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ approval: { approvalRevision: 7, revision: 4, policy: actionPolicy } }));
  const result = await WRITE_ACTIONS(write(actionInput), context);
  expect(result.status).toBe(200);
  expect(JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body))).toEqual(actionInput);
  // A reply that is not exactly the policy at exactly the next revision is not a confirmation.
  for (const changed of [
    { approvalRevision: 7, revision: 5, policy: actionPolicy },
    { approvalRevision: 8, revision: 4, policy: actionPolicy },
    { approvalRevision: 7, revision: 4, policy: { ...actionPolicy, maximumClass: "private" } },
    { approvalRevision: 7, revision: 4, policy: null },
  ]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ approval: changed }));
    expect((await WRITE_ACTIONS(write(actionInput), context)).status).toBe(503);
  }
});

it("passes a definite no through as a definite no, so the page can say which and change nothing", async () => {
  // 403 policy_blocked is Cosmos declining a well-formed policy: a class above
  // the ceiling, an undeclared operation, or a task label it calls sensitive.
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: "policy_blocked" }, { status: 403 }));
  const refused = await WRITE_COMMANDS(write(commandInput), context);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "forbidden" });
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 409 }));
  expect((await WRITE_COMMANDS(write(commandInput), context)).status).toBe(409);
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 418 }));
  expect((await WRITE_COMMANDS(write(commandInput), context)).status).toBe(503);
});

it("refuses a malformed body, a cross-origin write and an unauthenticated request before reaching Cosmos", async () => {
  for (const body of [
    { ...actionInput, approval: "approve-screen-context-v1" },
    { ...actionInput, policy: { maximumClass: "shared_room" } },
    { ...actionInput, policy: { ...actionPolicy, open: { hosts: ["https://github.com"], apps: [], roots: [] } } },
  ]) {
    expect((await WRITE_ACTIONS(write(body), context)).status).toBe(400);
  }
  // argv is an array or it is nothing: a string there would be a shell command.
  expect((await WRITE_COMMANDS(write({ ...commandInput, policy: { ...commandPolicy,
    entries: [{ ...commandPolicy.entries[0], argv: "./revival check" }] } }), context)).status).toBe(400);
  // A list over the route's own 4096-byte limit is refused here, not truncated there.
  const fat = { ...commandInput, policy: { ...commandPolicy, entries: Array.from({ length: 8 }, (_, index) => ({
    ...commandPolicy.entries[0], id: `task-${index}`, argv: Array.from({ length: 12 }, () => "a".repeat(256)) })) } };
  expect((await WRITE_COMMANDS(write(fat), context)).status).toBe(400);
  expect((await WRITE_ACTIONS(write(actionInput, { headers: { "content-type": "text/plain" } }), context)).status).toBe(400);
  mocks.origin.mockReturnValue(false);
  expect((await WRITE_ACTIONS(write(actionInput), context)).status).toBe(403);
  mocks.origin.mockReturnValue(true);
  mocks.session.mockResolvedValue(null);
  expect((await WRITE_ACTIONS(write(actionInput), context)).status).toBe(401);
  expect((await READ_ACTIONS(new Request(url), context)).status).toBe(401);
  mocks.session.mockResolvedValue({ sub: "owner" });
  mocks.authEnabled = false;
  expect((await READ_ACTIONS(new Request(url), context)).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses a surface id that is not one, before acquiring owner authority", async () => {
  for (const id of ["not-a-uuid", "00000000-0000-0000-0000-000000000000", `${surfaceId} `]) {
    const bad = { params: Promise.resolve({ surfaceId: id }) };
    expect((await READ_ACTIONS(new Request(url), bad)).status).toBe(400);
    expect((await READ_COMMANDS(new Request(url), bad)).status).toBe(400);
  }
  expect(fetch).not.toHaveBeenCalled();
});
