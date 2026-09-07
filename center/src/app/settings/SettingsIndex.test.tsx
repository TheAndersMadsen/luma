import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsIndex } from "./SettingsIndex";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("./useOperatorEntitlement", () => ({
  useOperatorEntitlement: () => false,
}));

describe("SettingsIndex", () => {
  it("searches every settings destination without hiding routes on mobile", async () => {
    const user = userEvent.setup();
    render(<SettingsIndex />);

    expect(screen.getAllByText("Open")).toHaveLength(18);
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "battery");

    expect(screen.getByRole("link", { name: /My Ai Pin/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Assistant/ })).not.toBeInTheDocument();
  });

  it("reports an empty search result", async () => {
    const user = userEvent.setup();
    render(<SettingsIndex />);
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "not-a-setting");
    expect(screen.getByRole("status")).toHaveTextContent("No settings match");
  });
});
