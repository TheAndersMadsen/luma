import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsIndex } from "./SettingsIndex";

const state = vi.hoisted(() => ({ operator: false }));
vi.mock("./useOperatorEntitlement", () => ({ useOperatorEntitlement: () => state.operator }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }));

function showSettings({ paired = false, report = false, stale = false, unavailable = false } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (unavailable) return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
    return Response.json(url === "/api/devices/pair"
      ? { devices: paired ? [{ deviceId: "abc", pairedAt: 1, blocked: false, blockedAt: null }] : [], unpairedBlocked: [] }
      : { devices: report ? [{ device_id: "abc", serial_number: "PIN", firmware_version: "1", os_version: "1", battery_percent: 62, battery_charging: false, reported_at_epoch: Date.now() / 1000 - (stale ? 3600 : 0), wifi_networks: [] }] : [], state: "live" });
  }));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SettingsIndex /></QueryClientProvider>);
}
afterEach(() => { state.operator = false; vi.unstubAllGlobals(); });

it("offers everyday settings and setup while keeping technical choices in Advanced", async () => {
  state.operator = true;
  showSettings();
  expect(await screen.findByRole("link", { name: /Set up a Pin/ })).toHaveAttribute("href", "/settings/pin/setup");
  expect(screen.getByRole("link", { name: /^Music/ })).toHaveAttribute("href", "/settings/account/music");
  expect(screen.getByRole("link", { name: /^Assistant & voice/ })).toHaveAttribute("href", "/settings/account/services");
  const advanced = screen.getByText("Advanced", { selector: "summary strong" }).closest("details")!;
  expect(advanced).not.toHaveAttribute("open");
  expect(within(advanced).getByText("Connect to your server")).toBeInTheDocument();
  await userEvent.click(within(advanced).getByText("Advanced"));
  expect(advanced).toHaveAttribute("open");
});

it("searches technical synonyms, reveals Advanced matches, and clears an empty result", async () => {
  state.operator = true;
  showSettings();
  const search = screen.getByRole("searchbox", { name: "Search settings" });
  await userEvent.type(search, "device flags");
  expect(screen.getByRole("link", { name: /^Experimental features/ })).toHaveAttribute("href", "/settings/pin/flags");
  await userEvent.clear(search);
  await userEvent.type(search, "never a setting");
  expect(screen.getByRole("status")).toHaveTextContent("No settings match");
  await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(search).toHaveValue("");
  expect(search).toHaveFocus();
  expect(screen.getByRole("link", { name: /^Wi-Fi/ })).toBeInTheDocument();
});

it("does not reveal operator actions through search", async () => {
  showSettings();
  await userEvent.type(screen.getByRole("searchbox"), "provisioning");
  expect(screen.queryByRole("link", { name: /Connect to your server/ })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("No settings match");
});

// Real settings workflow over the existing account-scoped HTTP query contracts:
// reported, paired-but-sleeping, never-reported and unavailable are distinct.
it.each([
  ["online Pin", { paired: true, report: true }],
  ["offline Pin with an old report", { paired: true, report: true, stale: true }],
  ["paired Pin that has not reported", { paired: true }],
  ["reported Pin while pairing has not loaded", { report: true }],
])("offers maintenance rather than onboarding for an %s", async (_name, facts) => {
  showSettings(facts);
  const card = (await screen.findByText("Keep your Pin running smoothly")).parentElement!;
  expect(within(card).getByRole("link", { name: /Software & updates/ })).toHaveAttribute("href", "/settings/pin/install");
  expect(within(card).getByRole("link", { name: /Help & diagnostics/ })).toHaveAttribute("href", "/settings/pin/diagnostics");
  expect(within(card).queryByRole("link", { name: /Set up a Pin/ })).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox"), "setup");
  expect(screen.getByRole("link", { name: /Set up a Pin/ })).toHaveAttribute("href", "/settings/pin/setup");
  await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByText("Keep your Pin running smoothly")).toBeInTheDocument();
});

it("does not claim setup is needed when pairing and status cannot be read", async () => {
  showSettings({ unavailable: true });
  await screen.findByText("Status unavailable. Your pairing is unchanged.");
  const card = screen.getByText("Need a hand with your Pin?").parentElement!;
  expect(within(card).getByRole("link", { name: /Help & diagnostics/ })).toHaveAttribute("href", "/settings/pin/diagnostics");
  expect(screen.queryByText("A little help getting started?")).not.toBeInTheDocument();
});
