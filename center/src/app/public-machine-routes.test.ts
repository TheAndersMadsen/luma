import { describe, expect, it, vi } from "vitest";

import { GET as llms } from "./llms.txt/route";
import { GET as openApi } from "./openapi.json/route";
import robots from "./robots";
import sitemap from "./sitemap";

describe("public machine routes", () => {
  it("publishes the agent index as Markdown with specific when-to-use guidance", async () => {
    vi.stubEnv("REVIVAL_PUBLIC_ORIGIN", "https://center.example.test");
    const response = llms();
    const body = await response.text();
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(body).toMatch(/^# Ai Pin Revival Center\n/);
    expect(body).toContain("Use this site when");
    expect(body).toContain("https://center.example.test/developers.md");
    expect(body).toContain("https://center.example.test/openapi.json");
  });

  it("serves valid JSON for the public OpenAPI contract", async () => {
    const response = openApi();
    const specification = await response.json();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(specification).toMatchObject({
      openapi: "3.1.2",
      paths: {
        "/api/version": { get: { operationId: "getDeploymentVersion" } },
        "/api/pin/releases/current": { get: { operationId: "getCurrentPinRelease" } },
      },
    });
  });

  it("advertises every public page and allows the named agent crawlers", () => {
    vi.stubEnv("REVIVAL_PUBLIC_ORIGIN", "https://center.example.test");
    const rules = robots();
    expect(rules.sitemap).toBe("https://center.example.test/sitemap.xml");
    expect(rules.rules).toEqual(expect.arrayContaining([
      { userAgent: "ChatGPT-User", allow: "/" },
      { userAgent: "ClaudeBot", allow: "/" },
      { userAgent: "PerplexityBot", allow: "/" },
    ]));

    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual([
      "https://center.example.test/",
      "https://center.example.test/about",
      "https://center.example.test/contact",
      "https://center.example.test/privacy",
      "https://center.example.test/developers",
    ]);
  });
});
