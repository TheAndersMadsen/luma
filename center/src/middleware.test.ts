import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

describe("public discovery middleware", () => {
  let middleware: typeof import("./middleware").middleware;
  let isProtectedPageRequest: typeof import("./middleware").isProtectedPageRequest;
  let isInternalMusicQueryRequest: typeof import("./middleware").isInternalMusicQueryRequest;

  beforeAll(async () => {
    vi.stubEnv("KEYCLOAK_BASE_URL", "http://keycloak:8080");
    vi.stubEnv("AUTH_SESSION_SECRET", "test-session-secret-long-enough-for-tests");
    vi.resetModules();
    ({ middleware, isProtectedPageRequest, isInternalMusicQueryRequest } = await import("./middleware"));
  });

  it("sends an anonymous homepage to sign-in, signed-in sessions through", async () => {
    const response = await middleware(new NextRequest("https://center.example.test/", {
      headers: { accept: "text/html" },
    }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://center.example.test/login");
    // `/` is also the signed-in dashboard, so the redirect is never cacheable.
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0, must-revalidate, no-transform");
  });

  it("keeps the newcomer bootstrap and its cloud-init template public when deployment authentication is enabled", async () => {
    for (const machinePath of ["/install.sh", "/cloud-init.yaml"]) {
      const response = await middleware(new NextRequest(`https://center.example.test${machinePath}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("cache-control")).toContain("public");
    }
  });

  it("returns a real Markdown 404 and lets Next render an HTML 404", async () => {
    const markdown = await middleware(new NextRequest("https://center.example.test/not-a-route", {
      headers: { accept: "text/markdown" },
    }));
    expect(markdown.status).toBe(404);
    expect(await markdown.text()).toContain("/sitemap.xml");

    const html = await middleware(new NextRequest("https://center.example.test/not-a-route", {
      headers: { accept: "text/html" },
    }));
    expect(html.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps every real private page behind authentication", async () => {
    const privatePaths = [
      "/captures", "/captures/id", "/notes", "/notes/id", "/my-data/music",
      "/settings", "/settings/account/music", "/settings/account/services", "/settings/account/security", "/settings/pin/activity",
      "/settings/pin/conversations/id", "/settings/pin/gallery/id", "/talk",
      // The stock /devices link and the food page, like every other settings page.
      "/devices", "/settings/food",
    ];
    for (const path of privatePaths) expect(isProtectedPageRequest(path), path).toBe(true);
    for (const path of ["/not-a-route", "/about/missing", "/settings/missing", "/devices/extra"]) {
      expect(isProtectedPageRequest(path), path).toBe(false);
    }

    const response = await middleware(new NextRequest("https://center.example.test/settings/pin/activity"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://center.example.test/login?next=%2Fsettings%2Fpin%2Factivity");
  });

  it("adds current RateLimit fields to public API requests", async () => {
    const response = await middleware(new NextRequest("https://center.example.test/api/version", {
      headers: { "cf-connecting-ip": crypto.randomUUID(), "x-real-ip": "127.0.0.1" },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("ratelimit-policy")).toBe('"public-read";q=120;w=60');
    expect(response.headers.get("ratelimit")).toMatch(/^"public-read";r=119;t=60$/);
  });

  it("serves the stock share-link path without a session, privately and rate-limited", async () => {
    const response = await middleware(new NextRequest(
      "https://center.example.test/humane.center/share/capture/0f1e2d3c-4b5a-4968-8776-655443322110?expiry=1790000000&signature=abc",
      { headers: { "cf-connecting-ip": crypto.randomUUID(), "x-real-ip": "127.0.0.1" } },
    ));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("ratelimit-policy")).toBe('"public-read";q=120;w=60');

    // The retired JWE share path is simply not a route any more.
    expect(isProtectedPageRequest("/share/token")).toBe(false);
    const retired = await middleware(new NextRequest("https://center.example.test/api/share/token"));
    expect(retired.status).toBe(401);
  });

  it("lets only the exact Cosmos music POST reach its route-owned bearer check", async () => {
    expect(isInternalMusicQueryRequest("/api/internal/music/query", "POST")).toBe(true);
    expect(isInternalMusicQueryRequest("/api/internal/music/query", "GET")).toBe(false);
    expect(isInternalMusicQueryRequest("/api/internal/music/query/extra", "POST")).toBe(false);

    const allowed = await middleware(new NextRequest("https://center.example.test/api/internal/music/query", {
      method: "POST",
    }));
    expect(allowed.headers.get("x-middleware-next")).toBe("1");

    const denied = await middleware(new NextRequest("https://center.example.test/api/internal/music/query"));
    expect(denied.status).toBe(401);
  });
});
