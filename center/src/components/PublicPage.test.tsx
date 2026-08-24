import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PublicPage } from "./PublicPage";
import NotFound from "@/app/not-found";

describe("public pages", () => {
  it.each(["/", "/about", "/contact", "/privacy", "/developers"] as const)(
    "renders one meaningful H1 and discoverable machine links for %s",
    (path) => {
      const { container } = render(<PublicPage path={path} />);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(container.textContent?.length).toBeGreaterThan(500);
      expect(screen.getByRole("link", { name: "llms.txt" })).toHaveAttribute("href", "/llms.txt");
      expect(screen.getByRole("link", { name: "OpenAPI" })).toHaveAttribute("href", "/openapi.json");
    },
  );

  it("gives the HTML 404 useful agent recovery links", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sitemap" })).toHaveAttribute("href", "/sitemap.xml");
    expect(screen.getByRole("link", { name: "llms.txt" })).toHaveAttribute("href", "/llms.txt");
    expect(screen.getByRole("link", { name: "Developer index" })).toHaveAttribute("href", "/developers");
  });
});
