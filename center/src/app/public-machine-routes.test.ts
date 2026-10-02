import { describe, expect, it, vi } from "vitest";

import { GET as cloudInit } from "./cloud-init.yaml/route";
import { LUMA_CLOUD_INIT } from "@/lib/pin-setup/generated/cloud-init";
import { GET as llms } from "./llms.txt/route";
import { GET as installer } from "./install.sh/route";
import { GET as openApi } from "./openapi.json/route";
import robots from "./robots";
import sitemap from "./sitemap";
import { PUBLIC_CONTENT_UPDATED } from "@/lib/public-site";

describe("public machine routes", () => {
  it("serves the canonical interactive bootstrap with an explicit shell content type", async () => {
    vi.stubEnv("LUMA_PUBLIC_ORIGIN", "https://center.example.test");
    const response = installer();
    const body = await response.text();
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toMatch(/^#!\/usr\/bin\/env bash\n/u);
    expect(body).toContain("./luma onboard production");
    // The serving Center becomes the update source the new server checks.
    expect(body).toContain('LUMA_UPDATE_SOURCE_DEFAULT="https://center.example.test"');
    expect(body).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/u);
  });

  it("serves the unattended cloud-init template pointing at this Center's own installer", async () => {
    vi.stubEnv("LUMA_PUBLIC_ORIGIN", "https://center.example.test");
    const response = cloudInit();
    const body = await response.text();
    expect(response.headers.get("content-type")).toBe("text/cloud-config; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toMatch(/^#cloud-config\n/u);
    expect(body).toContain("https://center.example.test/install.sh");
    expect(body).not.toContain("REPLACE_ME_CENTER_HOST");
    // The operator's own values stay placeholders. The DuckDNS token never has a value here.
    for (const placeholder of ["REPLACE_ME_DOMAIN", "REPLACE_ME_ACME_EMAIL", "REPLACE_ME_OPERATOR_EMAIL", "REPLACE_ME_DUCKDNS_TOKEN"]) {
      expect(body).toContain(placeholder);
    }
    // The release and its images are public, so the template asks for no GitHub token.
    expect(body).not.toMatch(/github-token|GITHUB_TOKEN/u);
    expect(body).toContain("LUMA_UNATTENDED=1");
    expect(body).toContain("/var/log/luma-install.log");
    expect(body).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/u);
    // Serving the template does not change the canonical generated input.
    expect(LUMA_CLOUD_INIT).toContain("https://REPLACE_ME_CENTER_HOST/install.sh");
  });

  it("publishes the agent index as Markdown with specific when-to-use guidance", async () => {
    vi.stubEnv("LUMA_PUBLIC_ORIGIN", "https://center.example.test");
    const response = llms();
    const body = await response.text();
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(body).toMatch(/^# Luma Center\n/);
    expect(body).toContain("Use this site when");
    expect(body).toContain("https://center.example.test/openapi.json");
    // No public content pages remain: every link the index makes is a machine route.
    expect(body).not.toMatch(/\]\(https:\/\/center\.example\.test\/(?!openapi\.json|sitemap\.xml|api\/|install\.sh|cloud-init\.yaml)/u);
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
    vi.stubEnv("LUMA_PUBLIC_ORIGIN", "https://center.example.test");
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
    ]);
  });

  it("dates the sitemap by the content, not by the request", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const first = sitemap().map((entry) => entry.lastModified);
      vi.setSystemTime(new Date("2031-06-01T12:34:56Z"));
      const second = sitemap().map((entry) => entry.lastModified);
      expect(second).toEqual(first);
      expect(new Set(first)).toEqual(new Set([PUBLIC_CONTENT_UPDATED]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("points machine readers only at this deployment, never the private repository", async () => {
    vi.stubEnv("LUMA_PUBLIC_ORIGIN", "https://center.example.test");
    const machine = [
      await llms().text(),
      JSON.stringify(await openApi().json()),
      await cloudInit().text(),
    ];
    for (const text of machine) expect(text).not.toMatch(/github\.com\/TheAndersMadsen/u);
  });
});
