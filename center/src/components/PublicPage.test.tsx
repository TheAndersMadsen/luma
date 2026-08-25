import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PublicPage } from "./PublicPage";
import NotFound from "@/app/not-found";

describe("public pages", () => {
  it.each([
    ["/", "Your Ai Pin. Yours again."],
    ["/about", "A second life for Ai Pin."],
    ["/contact", "Help starts here."],
    ["/privacy", "Your Pin. Your data."],
    ["/developers", "Make the next chapter."],
  ] as const)(
    "renders one meaningful H1 and discoverable machine links for %s",
    (path, headline) => {
      const { container } = render(<PublicPage path={path} />);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getByRole("heading", { level: 1, name: headline })).toBeInTheDocument();
      expect(container.textContent?.length).toBeGreaterThan(500);
      expect(screen.getByRole("link", { name: "llms.txt" })).toHaveAttribute("href", "/llms.txt");
      expect(screen.getByRole("link", { name: "OpenAPI" })).toHaveAttribute("href", "/openapi.json");
    },
  );

  it("gives the homepage an original visual and direct primary actions", () => {
    render(<PublicPage path="/" />);
    expect(screen.getByRole("img", {
      name: "A Pin connected by a cyan beam to a private Cosmos server",
    }).getAttribute("src")).toContain("revival-hero.webp");
    expect(screen.getAllByRole("link", { name: "Open Center" })[0]).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Set up Cosmos" })).toHaveAttribute("href", "/developers");
  });

  it("marks the current public section in navigation", () => {
    render(<PublicPage path="/privacy" />);
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
  });

  it("gives the HTML 404 useful agent recovery links", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sitemap" })).toHaveAttribute("href", "/sitemap.xml");
    expect(screen.getByRole("link", { name: "llms.txt" })).toHaveAttribute("href", "/llms.txt");
    expect(screen.getByRole("link", { name: "Developer index" })).toHaveAttribute("href", "/developers");
  });
});
