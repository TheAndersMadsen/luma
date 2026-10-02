// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";

// Failure plan: session-evidence/failure-plan.md. These exercise the actual
// cookie crypto and middleware boundary. Only the identity provider is a seam.
let auth: typeof import("./server/auth");
let middleware: typeof import("./middleware").middleware;
const secret = "session-lifecycle-test-secret-at-least-32";
const now = () => Math.floor(Date.now() / 1000);
const access = (operator = false) => new SignJWT({ email: "wearer@example.test", name: "Wearer", realm_access: { roles: operator ? ["cosmos-operator"] : [] } })
  .setSubject("wearer").setIssuedAt().setExpirationTime("15m").setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));

beforeAll(async () => {
  vi.stubEnv("KEYCLOAK_BASE_URL", "http://keycloak.test");
  vi.stubEnv("AUTH_SESSION_SECRET", secret);
  vi.resetModules();
  auth = await import("./server/auth");
  ({ middleware } = await import("./middleware"));
});
afterEach(() => vi.unstubAllGlobals());

async function request(path: string, refreshToken = crypto.randomUUID()) {
  const values = new Map<string, string>();
  // An old signed gate must never keep its previous operator privilege.
  values.set(auth.SESSION_COOKIE, await new SignJWT({ email: "wearer@example.test", operator: true }).setSubject("wearer")
    .setExpirationTime(now() - 1).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret)));
  auth.setTokenCookies({ set: (name, value) => { if (value) values.set(name, value); } }, await auth.sealTokens({
    accessToken: await access(true), refreshToken, expiresAt: now() - 1,
  }), {});
  return new NextRequest(`https://center.test${path}`, { headers: { cookie: [...values].map(([name, value]) => `${name}=${value}`).join("; ") } });
}

function refreshResponse(operator = false) {
  return vi.fn(async () => Response.json({ access_token: await access(operator), refresh_token: crypto.randomUUID(), expires_in: 900 }));
}

describe("persistent browser session", () => {
  it("renews the expired browser gate, cookies, and same-request identity", async () => {
    vi.stubGlobal("fetch", refreshResponse());
    const response = await middleware(await request("/settings/account/details?tab=name"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-cookie")).toContain("cosmos_session=");
    const renewed = response.cookies.get(auth.SESSION_COOKIE);
    expect(renewed?.httpOnly).toBe(true);
    expect(renewed?.maxAge).toBe(400 * 86400);
    expect(await auth.verifySession(renewed?.value)).toMatchObject({ sub: "wearer", operator: false });
    const { payload } = await import("jose").then(j => j.jwtVerify(renewed!.value, new TextEncoder().encode(secret)));
    expect(payload.exp! - payload.iat!).toBe(900);
    const tokens = await auth.openTokens(auth.readTokenCookie(response.cookies));
    expect(tokens?.expiresAt).toBeGreaterThan(now() + 800);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("uses current roles after renewal, and refuses a revoked grant without clearing credentials on outages", async () => {
    vi.stubGlobal("fetch", refreshResponse(false));
    expect((await middleware(await request("/api/admin/devices"))).status).toBe(403);
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect((await middleware(await request("/api/health"))).status).toBe(401);
    const page = await middleware(await request("/notes/search?q=remember"));
    expect(page.headers.get("location")).toBe("https://center.test/login?next=%2Fnotes%2Fsearch%3Fq%3Dremember");
    for (const providerResponse of [() => new Response(null, { status: 503 }), () => new Response("bad-json"), () => { throw new Error("network down"); }]) {
      vi.stubGlobal("fetch", async () => providerResponse());
      const response = await middleware(await request("/api/health"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ authUnavailable: true });
      expect(response.cookies.getAll()).toHaveLength(0);
    }
  });

  it("does not renew on public pages, sign-out, or sign-in and rejects tampering", async () => {
    const provider = refreshResponse();
    vi.stubGlobal("fetch", provider);
    for (const path of ["/wifi", "/api/version", "/api/auth/logout", "/login"]) {
      await middleware(await request(path));
    }
    expect(provider).not.toHaveBeenCalled();
    const response = await middleware(new NextRequest("https://center.test/api/health", { headers: { cookie: "cosmos_session=forged; cosmos_tokens=forged" } }));
    expect(response.status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
  });
});
