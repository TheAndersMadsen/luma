import { describe, expect, it } from "vitest";

import {
  PUBLIC_PAGES,
  preferredPublicRepresentation,
  publicPageFromMarkdownPath,
  publicPageMarkdown,
  publicOrigin,
} from "./public-site";

describe("public agent content", () => {
  it("gives every public page substantial server-renderable text", () => {
    for (const page of Object.values(PUBLIC_PAGES)) {
      const text = [page.title, page.description, ...page.sections.flatMap((section) => [
        section.heading,
        ...section.paragraphs,
        ...(section.links ?? []).flatMap((link) => [link.label, link.description]),
      ])].join(" ");
      expect(text.length, page.path).toBeGreaterThan(500);
      expect(page.sections.length, page.path).toBeGreaterThan(0);
    }
  });

  it("renders canonical CommonMark with absolute resource links", () => {
    const markdown = publicPageMarkdown("/developers", "https://center.example.test");
    expect(markdown).toMatch(/^# Ai Pin Revival developers\n\n> /);
    expect(markdown).toContain("## Public HTTP API");
    expect(markdown).toContain("https://center.example.test/openapi.json");
    expect(markdown).toContain("## When an agent should use this project");
  });

  it("maps every advertised explicit Markdown twin", () => {
    expect(publicPageFromMarkdownPath("/index.md")?.path).toBe("/");
    for (const path of ["/about", "/contact", "/privacy", "/developers"] as const) {
      expect(publicPageFromMarkdownPath(`${path}.md`)?.path).toBe(path);
    }
    expect(publicPageFromMarkdownPath("/unknown.md")).toBeNull();
  });

  it("negotiates q-values, specificity, defaults, and rejection", () => {
    expect(preferredPublicRepresentation(null)).toBe("html");
    expect(preferredPublicRepresentation("text/markdown")).toBe("markdown");
    expect(preferredPublicRepresentation("text/html, text/markdown;q=0.8")).toBe("html");
    expect(preferredPublicRepresentation("text/html;q=0.4, text/markdown;q=0.9")).toBe("markdown");
    expect(preferredPublicRepresentation("text/*;q=0.8, text/markdown;q=0.8")).toBe("markdown");
    expect(preferredPublicRepresentation("*/*")).toBe("html");
    expect(preferredPublicRepresentation("application/json")).toBeNull();
    expect(preferredPublicRepresentation("text/markdown;q=0, text/html;q=1")).toBe("html");
    expect(preferredPublicRepresentation("text/*;q=0.8, text/markdown;q=0")).toBe("html");
    expect(preferredPublicRepresentation("text/markdown;q=0.8, text/html;q=0.8")).toBe("markdown");
    expect(preferredPublicRepresentation("text/html;q=0.8, text/markdown;q=0.8")).toBe("html");
    expect(preferredPublicRepresentation("application/xhtml+xml")).toBeNull();
    expect(preferredPublicRepresentation("text/markdown;q=invalid, text/html;q=0.5")).toBe("html");
  });

  it("accepts only a configured HTTP origin", () => {
    expect(publicOrigin({ REVIVAL_PUBLIC_ORIGIN: "https://center.example.test/" })).toBe("https://center.example.test");
    expect(publicOrigin({ REVIVAL_PUBLIC_ORIGIN: "javascript:alert(1)" })).toBe("http://localhost:4000");
  });
});
