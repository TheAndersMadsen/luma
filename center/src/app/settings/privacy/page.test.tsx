import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import Page from "./page";

const settings = ["last_location", "location", "save_event_location", "share_capture_location", "traces", "v1p0_defaults"].map((name) => ({ name, value: "off" }));
afterEach(() => vi.unstubAllGlobals());

// Whole privacy-page workflow across its real HTTP boundary: explain every
// switch, preserve stock wire keys, and revert a rejected preference write.
it("explains Pin privacy choices without promising unsupported protection and keeps rejected changes unchanged", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ ok: false }, { status: 503 });
    }
    return Response.json({ settings, state: "live" });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Page /></QueryClientProvider>);
  const activity = await screen.findByRole("switch", { name: "Save activity location" });
  expect(screen.getAllByTestId("privacy-setting-row")).toHaveLength(6);
  for (const row of screen.getAllByTestId("privacy-setting-row")) {
    expect(within(row).getByTestId("privacy-setting-description").textContent?.trim()).toBeTruthy();
  }
  expect(screen.getByText("Include your location with new activity recorded on your Pin.")).toBeInTheDocument();
  expect(screen.queryByText("Not available yet", { selector: "summary" })).not.toBeInTheDocument();
  for (const name of ["Save last location", "Location access", "Location in shared photos", "Save diagnostics", "Standard data sync"]) {
    expect(screen.getByRole("switch", { name })).toBeEnabled();
  }
  expect(screen.getByText(/Previously synced data may become unreadable/u)).toBeInTheDocument();
  expect(activity).toHaveAttribute("aria-checked", "false");
  await userEvent.click(activity);
  expect(writes).toEqual([{ name: "save_event_location", value: true }]);
  expect(await screen.findByText("Couldn’t save that setting. Try again.")).toBeInTheDocument();
  expect(activity).toHaveAttribute("aria-checked", "false");
});

it("shows the saved location freshness and latest content-free diagnostics from Cosmos", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/details") ? Response.json({
    state: "live", details: {
      lastLocationEnabled: true, diagnosticsEnabled: true,
      lastLocation: { latitude: 52.1, longitude: 21.2, humanReadable: "Fixture location", fullAddress: "", staleStatus: "stale", timestamp: 1_790_000_000_000 },
      diagnostics: { route: "d1", transport: "legacy", outcome: "device_action", elapsedMs: 123, recordedAt: 1_790_000_000_000 },
    },
  }) : Response.json({ settings: settings.map((setting) => ({ ...setting,
    value: ["last_location", "traces"].includes(setting.name) ? "on" : setting.value,
  })), state: "live" })));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Page /></QueryClientProvider>);
  expect(await screen.findByText("Fixture location")).toBeInTheDocument();
  expect(screen.getByText(/Stale location/u)).toBeInTheDocument();
  expect(screen.getByText(/123 ms/u)).toBeInTheDocument();
  expect(screen.getByText("Sent to your Pin · 123 ms")).toBeInTheDocument();
  expect(screen.queryByText("d1 · device_action · 123 ms")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("More details", { selector: "summary" }));
  expect(screen.getByText("d1 · legacy · device_action")).toBeInTheDocument();
});

it("shows an unfamiliar saved preference read-only without inventing its purpose", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ settings: [{ name: "new_preference", value: "on" }], state: "live" })));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Page /></QueryClientProvider>);
  await userEvent.click(await screen.findByText("Not available yet", { selector: "summary" }));
  const unknown = screen.getByRole("switch", { name: "New Preference" });
  expect(unknown).toBeDisabled();
  expect(unknown).toHaveAttribute("aria-checked", "true");
  expect(screen.getByText("This preference isn’t supported by this Center yet.")).toBeInTheDocument();
});
