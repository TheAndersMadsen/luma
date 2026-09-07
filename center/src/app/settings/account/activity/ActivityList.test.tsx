import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityList } from "./ActivityList";

const NOW = Date.UTC(2026, 8, 7, 14, 30);
const rows = [
  { turnId: "10000000-0000-4000-8000-000000000002", startedAt: Date.UTC(2026, 8, 7, 14, 5), asked: "Asked from your phone", outcome: "Shown on your Mac",
    why: { candidates: ["Your Mac could show a card.", "Your TV could not show a card — its app was not in front."], hint: "You asked for the Mac", privacy: "This reply was safe to show on a screen other people can see.", expression: false } },
  { turnId: "10000000-0000-4000-8000-000000000001", startedAt: Date.UTC(2026, 8, 6, 22, 41), asked: "Asked from your Mac", outcome: "Nowhere to show it",
    why: { candidates: [], hint: null, privacy: "This reply was private to you.", expression: true } },
];

afterEach(() => { vi.useRealTimers(); });

it("lists turns newest first with time, where it was asked, what happened and a Why disclosure, without JavaScript", () => {
  const { container } = render(<ActivityList activity={{ state: "ready", rows, unnamed: false }} />);
  const items = Array.from(screen.getByRole("list", { name: "Recent turns" }).children) as HTMLElement[];
  expect(items).toHaveLength(2);
  // Server markup carries UTC so the page reads without JavaScript; hydration swaps in the viewer's zone.
  const markup = renderToStaticMarkup(<ActivityList activity={{ state: "ready", rows, unnamed: false }} />);
  expect(markup).toContain("7 Sept 2026, 14:05 UTC");
  expect(markup).toContain("7 September 2026");
  expect(markup).toContain("6 September 2026");
  expect(items[0].querySelector("time")).toHaveAttribute("datetime", "2026-09-07T14:05:00.000Z");
  expect(items[0]).toHaveTextContent("Asked from your phone");
  expect(items[0]).toHaveTextContent("Shown on your Mac");
  const why = items[0].querySelector("details")!;
  expect(why.querySelector("summary")).toHaveTextContent("Why");
  expect(why).toHaveTextContent("Your Mac could show a card.");
  expect(why).toHaveTextContent("Your TV could not show a card — its app was not in front.");
  expect(why).toHaveTextContent("You asked for the Mac");
  expect(why).toHaveTextContent("This reply was safe to show on a screen other people can see.");
  expect(why).not.toHaveTextContent(/class/iu);
  expect(items[1]).toHaveTextContent("Nowhere to show it");
  expect(items[1].querySelector("details")).toHaveTextContent("Cosmos recorded no device choice for this turn.");
  expect(items[1].querySelector("details")).toHaveTextContent("Cosmos also said something shared-safe in its own words.");
  expect(container.querySelector("button, input, select")).toBeNull();
  expect(container.textContent).not.toContain("10000000-0000-4000-8000");
  expect(screen.getByText(/Cosmos keeps no record of what you asked or what it answered/u)).toBeVisible();
});

it("groups turns by the viewer's own day and gives each one a relative time once the page has a clock", () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  const recent = [{ ...rows[0], startedAt: NOW - 30000 }, { ...rows[0], turnId: "10000000-0000-4000-8000-000000000003", startedAt: NOW - 12 * 60000 }, rows[1]];
  render(<ActivityList activity={{ state: "ready", rows: recent, unnamed: false }} />);
  const items = Array.from(screen.getByRole("list", { name: "Recent turns" }).children) as HTMLElement[];
  expect(within(items[0]).getByRole("heading", { name: "Today" })).toBeVisible();
  expect(items[0].querySelector("time")).toHaveTextContent("Just now");
  expect(items[1].querySelector("heading")).toBeNull();
  expect(items[1].querySelector("time")).toHaveTextContent("12 minutes ago");
  expect(within(items[2]).getByRole("heading", { name: "Yesterday" })).toBeVisible();
  expect(items[2].querySelector("time")).toHaveTextContent(/^Yesterday \d{2}:\d{2}$/u);
});

it("says plainly when there is nothing yet, when Cosmos could not be read, and when device lists were missing", () => {
  const empty = render(<ActivityList activity={{ state: "ready", rows: [], unnamed: false }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Nothing here yet");
  expect(screen.getByRole("status")).toHaveTextContent("Ask Cosmos from one of your devices and the turn appears here within seconds.");
  expect(screen.getByRole("link", { name: "Go to Devices" })).toHaveAttribute("href", "/settings/account/surfaces");
  expect(screen.queryByRole("list")).toBeNull();
  empty.unmount();
  const down = render(<ActivityList activity={{ state: "unavailable" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Recent activity could not be read");
  expect(screen.getByRole("status")).toHaveTextContent("Cosmos did not answer just now. Nothing has been lost.");
  expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/settings/account/activity");
  expect(screen.queryByRole("list")).toBeNull();
  down.unmount();
  render(<ActivityList activity={{ state: "ready", rows, unnamed: true }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Some device lists could not be read, so some devices may show as removed.");
  expect(screen.getByRole("list", { name: "Recent turns" })).toBeVisible();
});
