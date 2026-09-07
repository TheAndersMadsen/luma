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

  it("rewrites an anonymous HTML homepage to the server-rendered public page", async () => {
    const response = await middleware(new NextRequest("https://center.example.test/", {
      headers: { accept: "text/html" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://center.example.test/welcome");
    expect(response.headers.get("vary")).toContain("Accept");
  });

  it("serves negotiated and explicit Markdown with cache-safe Vary headers", async () => {
    for (const request of [
      new NextRequest("https://center.example.test/about", { headers: { accept: "text/markdown" } }),
      new NextRequest("https://center.example.test/about.md"),
    ]) {
      const response = await middleware(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
      expect(await response.text()).toContain("# About Ai Pin Revival");
    }
  });

  it("keeps the newcomer bootstrap public when deployment authentication is enabled", async () => {
    const response = await middleware(new NextRequest("https://center.example.test/install.sh"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toContain("public");
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
      "/settings", "/settings/account/services", "/settings/account/activity", "/settings/pin/activity",
      "/settings/pin/conversations/id", "/settings/pin/gallery/id", "/talk",
    ];
    for (const path of privatePaths) expect(isProtectedPageRequest(path), path).toBe(true);
    for (const path of ["/not-a-route", "/about/missing", "/settings/missing"]) {
      expect(isProtectedPageRequest(path), path).toBe(false);
    }

    const response = await middleware(new NextRequest("https://center.example.test/settings/pin/activity"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://center.example.test/login?next=%2Fsettings%2Fpin%2Factivity");
  });

  it("adds current RateLimit fields to public API requests", async () => {
    const response = await middleware(new NextRequest("https://center.example.test/api/version", {
      headers: { "cf-connecting-ip": crypto.randomUUID() },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("ratelimit-policy")).toBe('"public-read";q=120;w=60');
    expect(response.headers.get("ratelimit")).toMatch(/^"public-read";r=119;t=60$/);
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
