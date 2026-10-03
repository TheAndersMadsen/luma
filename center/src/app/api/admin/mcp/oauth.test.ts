// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The routes behind a tool server's Sign in. Cosmos runs the OAuth exchange
 * and keeps its secrets; these routes start it, end it, and carry the
 * provider's answer from the browser's address to Cosmos. The ways they can
 * fail, written before the tests:
 *
 * 1. Someone who is not the signed-in operator starts or ends a sign-in, or
 *    signs the owner out.
 * 2. Another site's page starts a sign-in or signs the owner out with the
 *    owner's cookie.
 * 3. The return address comes from the browser, so a sign-in's code is sent
 *    to an address the caller chose.
 * 4. A server id from the URL goes into the Cosmos path unchecked.
 * 5. The callback hands Cosmos a `state` of another shape, or an oversized
 *    code, or does not tell Cosmos that the provider refused.
 * 6. The callback answers the browser with JSON, or with Cosmos's own words,
 *    instead of sending it back to the Services page.
 * 7. Center's session lapsed while the owner was at the provider, and the
 *    owner is left on an error.
 */

const seams = vi.hoisted(() => ({
  fetch: vi.fn(),
  operator: vi.fn(),
}));

vi.mock("@/server/operator", () => ({ requireOperatorRequest: seams.operator }));
vi.mock("@/server/cosmos", () => ({
  COSMOS_ADMIN_ENABLED: true,
  COSMOS_WEBAPI: "https://cosmos.test",
  adminAuthHeaders: () => ({ authorization: "Bearer test-admin" }),
  cosmosDeadlineSignal: () => undefined,
}));

import { DELETE as SIGN_OUT, POST as SIGN_IN } from "./[id]/oauth/route";
import { GET as CALLBACK } from "./oauth/callback/route";

const CENTER = "https://center.test";
const COSMOS = "https://cosmos.test/demo-api/admin/mcp";

type Options = { origin?: string | null; body?: string };

function request(path: string, method: string, { origin = CENTER, body }: Options = {}) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${CENTER}${path}`, { method, headers, body });
}

function signIn(id = "hosted", options: Options = {}) {
  return SIGN_IN(request(`/api/admin/mcp/${encodeURIComponent(id)}/oauth`, "POST", options), {
    params: Promise.resolve({ id }),
  });
}

function signOut(id = "hosted", options: Options = {}) {
  return SIGN_OUT(request(`/api/admin/mcp/${encodeURIComponent(id)}/oauth`, "DELETE", options), {
    params: Promise.resolve({ id }),
  });
}

/** The provider's redirect: a top-level navigation, so it carries no Origin. */
function callback(query: string) {
  return CALLBACK(request(`/api/admin/mcp/oauth/callback${query}`, "GET", { origin: null }));
}

function cosmosAnswers(body: unknown, status = 200) {
  seams.fetch.mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function cosmosCall() {
  expect(seams.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = seams.fetch.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: new Headers(init.headers),
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", seams.fetch);
  seams.operator.mockResolvedValue({ sub: "owner", email: "", name: "", operator: true });
  cosmosAnswers({ authorization_url: "https://provider.test/authorize?state=abc" });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { name: "POST /api/admin/mcp/{id}/oauth", call: signIn },
  { name: "DELETE /api/admin/mcp/{id}/oauth", call: signOut },
])("$name", ({ call }) => {
  it.each([
    ["a caller with no session", 401, "Not authenticated."],
    ["a wearer who is not the operator", 403, "Operator access required."],
  ])("refuses %s without calling Cosmos", async (_who, status, error) => {
    seams.operator.mockResolvedValue(Response.json({ error }, { status }));

    const response = await call();

    expect(response.status).toBe(status);
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["another site's page", "https://evil.test"],
    ["a request with no Origin", null],
  ])("refuses %s without calling Cosmos", async (_what, origin) => {
    const response = await call("hosted", { origin });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "A same-origin request is required." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it.each(["../integrations", "Hosted", "a b", ""])("answers 404 for the id %j without calling Cosmos", async (id) => {
    const response = await call(id);

    expect(response.status).toBe(404);
    expect(seams.fetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/mcp/{id}/oauth", () => {
  it("starts the sign-in with Center's own callback address, whatever the browser sent", async () => {
    const response = await signIn("hosted", {
      body: JSON.stringify({ redirect_uri: "https://evil.test/take-the-code" }),
    });

    const sent = cosmosCall();
    expect(sent.url).toBe(`${COSMOS}/servers/hosted/oauth`);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe("Bearer test-admin");
    expect(sent.body).toEqual({ redirect_uri: `${CENTER}/api/admin/mcp/oauth/callback` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorization_url: "https://provider.test/authorize?state=abc" });
  });

  it("hands back Cosmos's own refusal", async () => {
    cosmosAnswers({ error: "That server does not offer a sign-in." }, 400);

    const response = await signIn();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That server does not offer a sign-in." });
  });
});

describe("DELETE /api/admin/mcp/{id}/oauth", () => {
  it("signs out of that server through Cosmos", async () => {
    cosmosAnswers({ servers: [] });

    const response = await signOut();

    const sent = cosmosCall();
    expect(sent.url).toBe(`${COSMOS}/servers/hosted/oauth`);
    expect(sent.method).toBe("DELETE");
    expect(sent.headers.get("authorization")).toBe("Bearer test-admin");
    expect(await response.json()).toEqual({ servers: [] });
  });
});

describe("GET /api/admin/mcp/oauth/callback", () => {
  const SERVICES = `${CENTER}/settings/account/services`;

  it("hands Cosmos the state and code and sends the browser back signed in", async () => {
    cosmosAnswers({ servers: [] });

    const response = await callback("?state=abc_DEF-123&code=the-code");

    const sent = cosmosCall();
    expect(sent.url).toBe(`${COSMOS}/oauth/finish`);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe("Bearer test-admin");
    expect(sent.body).toEqual({ state: "abc_DEF-123", code: "the-code" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${SERVICES}?mcp=signed-in`);
    expect(await response.text()).toBe("");
  });

  it("sends the browser back with a failure, and none of Cosmos's words, when Cosmos refuses", async () => {
    cosmosAnswers({ error: "That sign-in has expired." }, 400);

    const response = await callback("?state=abc&code=the-code");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${SERVICES}?mcp=sign-in-failed`);
    expect(await response.text()).toBe("");
  });

  it("tells Cosmos at once when the provider refused, so the pending sign-in is dropped", async () => {
    cosmosAnswers({ error: "The sign-in was declined." }, 400);

    const response = await callback("?state=abc&error=access_denied");

    expect(cosmosCall().body).toEqual({ state: "abc", code: "" });
    expect(response.headers.get("location")).toBe(`${SERVICES}?mcp=sign-in-failed`);
  });

  it.each([
    ["no state", "?code=the-code"],
    ["a state of another shape", "?state=a%20b%2F..&code=the-code"],
    ["an overlong state", `?state=${"a".repeat(129)}&code=the-code`],
  ])("does not call Cosmos for %s", async (_what, query) => {
    const response = await callback(query);

    expect(seams.fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${SERVICES}?mcp=sign-in-failed`);
  });

  it("does not forward an oversized code", async () => {
    cosmosAnswers({ error: "The sign-in was declined." }, 400);

    await callback(`?state=abc&code=${"c".repeat(4097)}`);

    expect(cosmosCall().body).toEqual({ state: "abc", code: "" });
  });

  it("sends an owner whose Center session lapsed to sign in, then back to the Services page", async () => {
    seams.operator.mockResolvedValue(Response.json({ error: "Not authenticated." }, { status: 401 }));

    const response = await callback("?state=abc&code=the-code");

    expect(seams.fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${CENTER}/login`);
    expect(location.searchParams.get("next")).toBe("/settings/account/services?mcp=sign-in-failed");
  });

  it("refuses a wearer who is not the operator", async () => {
    seams.operator.mockResolvedValue(Response.json({ error: "Operator access required." }, { status: 403 }));

    const response = await callback("?state=abc&code=the-code");

    expect(response.status).toBe(403);
    expect(seams.fetch).not.toHaveBeenCalled();
  });
});
