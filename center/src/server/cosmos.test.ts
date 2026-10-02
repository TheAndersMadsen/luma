// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// No wearer session unless a test puts one in the jar: the calls below go out
// under the static principal.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: () => undefined,
  }),
}));

async function cosmosWith(environment: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  return import("./cosmos");
}

afterEach(() => {
  vi.unstubAllEnvs();
  jar.clear();
});

describe("Cosmos webapi identity", () => {
  it("proves a static edge principal with the edge token, as the gRPC metadata does", async () => {
    const cosmos = await cosmosWith({
      COSMOS_PRINCIPAL: "U:wearer-1",
      COSMOS_PRINCIPAL_METADATA: "x-forwarded-client-cert",
      COSMOS_EDGE_TOKEN: "edge-proof-value",
      COSMOS_EDGE_TOKEN_HEADER: "",
    });

    expect(await cosmos.webapiHeaders()).toEqual({
      "x-forwarded-client-cert": "U:wearer-1",
      "x-cosmos-edge-token": "edge-proof-value",
    });
    const metadata = await cosmos.requestMetadata();
    expect(metadata.get("x-forwarded-client-cert")).toEqual(["U:wearer-1"]);
    expect(metadata.get("x-cosmos-edge-token")).toEqual(["edge-proof-value"]);
  });

  it("sends neither an identity nor a secret when none is configured", async () => {
    const cosmos = await cosmosWith({ COSMOS_PRINCIPAL: "", COSMOS_EDGE_TOKEN: "" });

    expect(await cosmos.webapiHeaders()).toEqual({});
  });
});

describe("Cosmos webapi identity for a browser session", () => {
  const SIGNED_IN = {
    KEYCLOAK_BASE_URL: "http://keycloak.test",
    AUTH_SESSION_SECRET: "test-only-session-secret",
    COSMOS_PRINCIPAL: "U:static",
    COSMOS_EDGE_TOKEN: "",
  };
  const WEARER = { sub: "wearer-1", email: "", name: "", operator: false };

  it("asks a verified session with no usable bearer to sign in again", async () => {
    const cosmos = await cosmosWith(SIGNED_IN);
    const auth = await import("./auth");
    jar.set(auth.SESSION_COOKIE, await auth.signSession(WEARER));

    await expect(cosmos.webapiHeaders()).rejects.toBeInstanceOf(cosmos.SessionExpiredError);
  });

  it("treats a session cookie that does not verify as nobody, not as an expiry", async () => {
    const cosmos = await cosmosWith(SIGNED_IN);
    const auth = await import("./auth");
    jar.set(auth.SESSION_COOKIE, "not-a-session");

    expect(await cosmos.webapiHeaders()).toEqual({ "x-forwarded-client-cert": "U:static" });
  });

  it("ignores a leftover session cookie when sign-in is off", async () => {
    const cosmos = await cosmosWith({ ...SIGNED_IN, KEYCLOAK_BASE_URL: "" });
    const auth = await import("./auth");
    // Signed with the development key, so it would verify: only sign-in being
    // off keeps it from turning every call into "sign in again".
    jar.set(auth.SESSION_COOKIE, await auth.signSession(WEARER));

    expect(await cosmos.webapiHeaders()).toEqual({ "x-forwarded-client-cert": "U:static" });
  });

  it("sends the static principal when nobody is signed in", async () => {
    const cosmos = await cosmosWith(SIGNED_IN);

    expect(await cosmos.webapiHeaders()).toEqual({ "x-forwarded-client-cert": "U:static" });
  });
});

describe("Cosmos webapi writes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each verb with the wearer identity and a JSON body, and reads a 204 as undefined", async () => {
    const cosmos = await cosmosWith({
      COSMOS_WEBAPI_BASE_URL: "http://cosmos.test",
      COSMOS_PRINCIPAL: "U:wearer-1",
      COSMOS_EDGE_TOKEN: "",
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({ ok: init.method });
      }),
    );

    expect(await cosmos.webapiPut("/account-service/profile", { preferredName: "Ada" })).toEqual({
      ok: "PUT",
    });
    expect(await cosmos.webapiPost("/capture/note/create", { text: "New note." })).toEqual({
      ok: "POST",
    });
    expect(await cosmos.webapiRequest("DELETE", "/capture/pending-memory-creates")).toBeUndefined();

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["PUT", "http://cosmos.test/account-service/profile"],
      ["POST", "http://cosmos.test/capture/note/create"],
      ["DELETE", "http://cosmos.test/capture/pending-memory-creates"],
    ]);
    expect(calls[0]!.init.headers).toEqual({
      "x-forwarded-client-cert": "U:wearer-1",
      "content-type": "application/json",
    });
    expect(calls[0]!.init.body).toBe(JSON.stringify({ preferredName: "Ada" }));
    expect(calls[2]!.init.body).toBeUndefined();
  });

  it("reports a refused write with the webapi status stem", async () => {
    const cosmos = await cosmosWith({ COSMOS_WEBAPI_BASE_URL: "http://cosmos.test" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(cosmos.webapiPut("/account-service/profile", {})).rejects.toThrow(
      "webapi /account-service/profile -> 403",
    );
  });
});

describe("Cosmos webapi byte-range streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function upstream(status: number, headers: Record<string, string>, body: string | null) {
    return vi.fn(
      async (_url: string, _init: RequestInit) => new Response(body, { status, headers }),
    );
  }

  it("forwards one bytes range and relays a 206 with only the media headers", async () => {
    const cosmos = await cosmosWith({ COSMOS_WEBAPI_BASE_URL: "http://cosmos.test" });
    const fetchMock = upstream(
      206,
      {
        "content-type": "video/mp4",
        "content-range": "bytes 0-3/10",
        "content-length": "4",
        "accept-ranges": "bytes",
        "x-cosmos-projection": "opened",
        "set-cookie": "leak=1",
      },
      "mp4!",
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await cosmos.webapiStream("/capture/memory/m/file/0", { range: "bytes=0-3" });

    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ range: "bytes=0-3" });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("mp4!");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-cosmos-projection")).toBeNull();
  });

  it("serves anything but a single bytes range whole, and never relays an error body", async () => {
    const cosmos = await cosmosWith({ COSMOS_WEBAPI_BASE_URL: "http://cosmos.test" });
    for (const range of ["bytes=0-1,4-5", "items=0-3", "bytes=-"]) {
      const fetchMock = upstream(200, { "content-type": "video/mp4" }, "whole");
      vi.stubGlobal("fetch", fetchMock);
      const response = await cosmos.webapiStream("/capture/memory/m/file/0", { range });
      expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty("range");
      expect(await response.text()).toBe("whole");
    }

    vi.stubGlobal(
      "fetch",
      upstream(503, { "content-type": "text/plain", "content-length": "24" }, "the store is unavailable"),
    );
    const failed = await cosmos.webapiStream("/capture/memory/m/file/0");
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("");
    // No length for bytes that are not sent, or the browser waits for them.
    expect(failed.headers.get("content-length")).toBeNull();
    expect(failed.headers.get("content-type")).toBeNull();
  });

  it("answers a HEAD with the media description and no body", async () => {
    const cosmos = await cosmosWith({ COSMOS_WEBAPI_BASE_URL: "http://cosmos.test" });
    const fetchMock = upstream(200, { "content-type": "video/mp4", "content-length": "10" }, null);
    vi.stubGlobal("fetch", fetchMock);
    const response = await cosmos.webapiStream("/capture/memory/m/file/0", { method: "HEAD" });
    expect(fetchMock.mock.calls[0]![1].method).toBe("HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.body).toBeNull();
  });

  it("bounds only the wait for headers, so a long download is not cut off", async () => {
    const cosmos = await cosmosWith({
      COSMOS_WEBAPI_BASE_URL: "http://cosmos.test",
      COSMOS_DEADLINE_MS: "5",
    });
    const fetchMock = upstream(200, { "content-type": "video/mp4" }, "slow body");
    vi.stubGlobal("fetch", fetchMock);
    const response = await cosmos.webapiStream("/capture/memory/m/file/0");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((fetchMock.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(false);
    expect(await response.text()).toBe("slow body");
  });
});
