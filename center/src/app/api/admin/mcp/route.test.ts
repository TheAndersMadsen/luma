// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The four routes behind the Tool servers card. They hold the admin token and
 * hand the owner's request to Cosmos, which keeps the servers and their
 * credentials. The ways they can fail, written before the tests:
 *
 * 1. Someone who is not the signed-in operator reaches Cosmos's operator API
 *    through Center's admin token: no session, or a wearer's session.
 * 2. Another site's page changes the owner's servers with the owner's cookie:
 *    adds a server, allows its actions, removes one, or makes Cosmos contact
 *    one.
 * 3. A server id from the URL goes into the Cosmos path unchecked, so
 *    `../integrations` reaches another operator route with the admin token.
 * 4. A huge body is read into memory, or a body that is not JSON is forwarded.
 * 5. The admin token is missing, the wrong Cosmos path or method is called, or
 *    the owner's document changes on the way (a header value dropped).
 * 6. Cosmos's own answer is replaced. The card shows Cosmos's sentence for a
 *    refused save, so status and body must arrive untouched.
 * 7. The answer, which names the owner's servers, is stored by a cache.
 * 8. Cosmos is down, or the deployment has no operator API, and the route
 *    throws instead of saying so.
 */

const seams = vi.hoisted(() => ({
  fetch: vi.fn(),
  operator: vi.fn(),
  adminEnabled: true,
}));

vi.mock("@/server/operator", () => ({ requireOperatorRequest: seams.operator }));
vi.mock("@/server/cosmos", () => ({
  get COSMOS_ADMIN_ENABLED() {
    return seams.adminEnabled;
  },
  COSMOS_WEBAPI: "https://cosmos.test",
  adminAuthHeaders: () => ({ authorization: "Bearer test-admin" }),
  cosmosDeadlineSignal: () => undefined,
}));

import { GET, POST as SAVE } from "./route";
import { DELETE } from "./[id]/route";
import { POST as TEST } from "./[id]/test/route";

const CENTER = "https://center.test";
const COSMOS = "https://cosmos.test/demo-api/admin/mcp";

type Options = { origin?: string | null; body?: string; contentType?: string };

function request(path: string, method: string, { origin = CENTER, body, contentType = "application/json" }: Options = {}) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = contentType;
  return new Request(`${CENTER}${path}`, { method, headers, body });
}

const DOCUMENT = {
  name: "Home",
  url: "https://home.example.test/mcp",
  headers: [{ name: "Authorization", value: "Bearer owner-secret" }],
};

function list() {
  return GET();
}

function save(options: Options = {}) {
  return SAVE(request("/api/admin/mcp", "POST", { body: JSON.stringify(DOCUMENT), ...options }));
}

function remove(id = "home", options: Options = {}) {
  return DELETE(request(`/api/admin/mcp/${encodeURIComponent(id)}`, "DELETE", options), {
    params: Promise.resolve({ id }),
  });
}

function test(id = "home", options: Options = {}) {
  return TEST(request(`/api/admin/mcp/${encodeURIComponent(id)}/test`, "POST", options), {
    params: Promise.resolve({ id }),
  });
}

/** What Cosmos answers a healthy call with: the owner's servers. */
const VIEW = {
  servers: [
    {
      id: "home",
      name: "Home",
      url: "https://home.example.test/mcp",
      headers: ["Authorization"],
      enabled: true,
      allow_actions: false,
      allow_when_locked: false,
      status: "connected",
      checked_at_ms: 1_790_000_000_000,
      disabled_tools: [],
      actions_without_asking: false,
      signed_in: false,
      tools: [{ name: "list_lights", description: "Lists the lights.", read_only: true, offered: true, enabled: true }],
    },
  ],
};

function cosmosAnswers(body: unknown, status = 200) {
  seams.fetch.mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

/** The one call Center made to Cosmos. */
function cosmosCall() {
  expect(seams.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = seams.fetch.mock.calls[0] as [string, RequestInit];
  return { url, method: init.method, headers: new Headers(init.headers), body: init.body };
}

const ROUTES = [
  { name: "GET /api/admin/mcp", call: () => list(), cosmos: { method: "GET", url: COSMOS } },
  { name: "POST /api/admin/mcp", call: () => save(), cosmos: { method: "POST", url: `${COSMOS}/servers` } },
  { name: "DELETE /api/admin/mcp/{id}", call: () => remove(), cosmos: { method: "DELETE", url: `${COSMOS}/servers/home` } },
  { name: "POST /api/admin/mcp/{id}/test", call: () => test(), cosmos: { method: "POST", url: `${COSMOS}/servers/home/test` } },
];

const WRITES = [
  { name: "POST /api/admin/mcp", call: (options: Options) => save(options) },
  { name: "DELETE /api/admin/mcp/{id}", call: (options: Options) => remove("home", options) },
  { name: "POST /api/admin/mcp/{id}/test", call: (options: Options) => test("home", options) },
];

beforeEach(() => {
  vi.stubGlobal("fetch", seams.fetch);
  seams.operator.mockResolvedValue({ sub: "owner", email: "", name: "", operator: true });
  seams.adminEnabled = true;
  cosmosAnswers(VIEW);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe.each(ROUTES)("$name", ({ call, cosmos }) => {
  it.each([
    ["a caller with no session", 401, "Not authenticated."],
    ["a wearer who is not the operator", 403, "Operator access required."],
  ])("refuses %s without calling Cosmos", async (_who, status, error) => {
    seams.operator.mockResolvedValue(Response.json({ error }, { status }));

    const response = await call();

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("calls Cosmos's operator API with the admin token and hands its answer back", async () => {
    const response = await call();

    const sent = cosmosCall();
    expect(sent.url).toBe(cosmos.url);
    expect(sent.method).toBe(cosmos.method);
    expect(sent.headers.get("authorization")).toBe("Bearer test-admin");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(VIEW);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("hands back Cosmos's own refusal, status and sentence", async () => {
    cosmosAnswers({ error: "That MCP server was not found." }, 404);

    const response = await call();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That MCP server was not found." });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("says Cosmos is unreachable when the call fails", async () => {
    seams.fetch.mockRejectedValue(new TypeError("fetch failed"));

    const response = await call();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Cosmos is unreachable." });
  });

  it("says tool servers are unavailable when the deployment has no operator API", async () => {
    seams.adminEnabled = false;

    const response = await call();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Tool servers are not available on this deployment." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });
});

describe.each(WRITES)("$name from another site", ({ call }) => {
  it.each([
    ["another site's page", "https://evil.test"],
    ["another hostname on the same site", "https://other.center.test"],
    ["a request with no Origin", null],
  ])("refuses %s without calling Cosmos", async (_what, origin) => {
    const response = await call({ origin });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "A same-origin request is required." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/mcp, the document", () => {
  it("forwards the owner's document to Cosmos unchanged", async () => {
    await save();

    const sent = cosmosCall();
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(sent.body))).toEqual(DOCUMENT);
  });

  it("refuses a document over 16 KiB before parsing it", async () => {
    const response = await save({
      body: JSON.stringify({ ...DOCUMENT, headers: [{ name: "Authorization", value: "x".repeat(17 * 1024) }] }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "That tool server document is too large." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a form post", "name=Home", "application/x-www-form-urlencoded", 415],
    ["text that is not JSON", "{name: Home", "application/json", 400],
  ])("refuses %s", async (_what, body, contentType, status) => {
    const response = await save({ body, contentType });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Expected a JSON body." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });
});

describe.each([
  { name: "DELETE /api/admin/mcp/{id}", call: (id: string) => remove(id) },
  { name: "POST /api/admin/mcp/{id}/test", call: (id: string) => test(id) },
])("$name, the server id", ({ call }) => {
  it.each([
    ["a path into another operator route", "../integrations"],
    ["an encoded path", "..%2Fintegrations"],
    ["a query", "home?confirm=true"],
    ["upper case", "Home"],
    ["a hyphen", "home-lab"],
    ["33 characters", "a".repeat(33)],
    ["nothing", ""],
  ])("answers 404 for %s without calling Cosmos", async (_what, id) => {
    const response = await call(id);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That tool server was not found." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("accepts the ids Cosmos mints, with its numbered suffix", async () => {
    const response = await call("home_assistant_2");

    expect(response.status).toBe(200);
    expect(cosmosCall().url).toContain("/servers/home_assistant_2");
  });
});
