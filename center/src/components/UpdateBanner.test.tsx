import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateOverview } from "@/lib/contracts/updates";
import { UpdateBanner } from "./UpdateBanner";

/*
 * The banner is for the operator only, says what is new in plain words, names
 * the one thing to do, and stays dismissed for the versions it named.
 */

const state = vi.hoisted(() => ({ operator: true }));
vi.mock("@/app/settings/useOperatorEntitlement", () => ({ useOperatorEntitlement: () => state.operator }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const LATEST = {
  version: "0.3.18",
  tag: "v0.3.18",
  pinVersion: "2026-10-02.1",
  notes: "Calmer banner.",
  publishedAt: "2026-10-02T18:00:00Z",
};

function overview(patch: Partial<UpdateOverview> = {}): UpdateOverview {
  return {
    current: { release: "abc", version: "0.3.16", tag: "v0.3.16", pinVersion: "2026-09-29.2", notes: null, publishedAt: null },
    source: "https://updates.example.test",
    autoUpdates: "off",
    check: { outcome: "update-available", checkedAt: "2026-10-03T02:00:00Z", latest: LATEST },
    lastUpdate: null,
    request: { supported: false, pending: false },
    ...patch,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function show(answer: UpdateOverview | Response) {
  fetchMock = vi.fn(async () => (answer instanceof Response ? answer : Response.json(answer)));
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <UpdateBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  state.operator = true;
  vi.unstubAllGlobals();
});

describe("UpdateBanner", () => {
  it("never asks for or shows updates to someone who is not the operator", async () => {
    state.operator = false;
    show(overview());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
  });

  it("names the release, keeps notes collapsed, and gives the one command when updates are manual", async () => {
    show(overview());
    const center = await screen.findByTestId("update-banner-center");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/updates", { cache: "no-store" });
    expect(within(center).getByText("Luma 0.3.18 is available")).toBeInTheDocument();
    expect(within(center).getByText("What’s new").closest("details")).not.toHaveAttribute("open");
    expect(within(center).getByText("To install it, run this on your server:")).toBeInTheDocument();
    expect(within(center).getByTestId("copy-command")).toHaveTextContent("./luma update production");
    expect(within(center).getByRole("link", { name: "Software updates" })).toHaveAttribute("href", "/settings/updates");
    expect(screen.queryByTestId("update-banner-pin")).not.toBeInTheDocument();
  });

  it("says the update installs itself when automatic updates are on", async () => {
    show(overview({ autoUpdates: "on" }));
    const center = await screen.findByTestId("update-banner-center");
    expect(within(center).getByText("It installs itself tonight; your Center may pause for a minute.")).toBeInTheDocument();
    expect(within(center).queryByTestId("copy-command")).not.toBeInTheDocument();
  });

  it("says new Pin apps are ready when the Pin last read older than the server offers", async () => {
    window.localStorage.setItem("luma.updates.pinRelease", "2026-08-01.1");
    show(overview({ check: { outcome: "up-to-date", checkedAt: "2026-10-03T02:00:00Z", latest: { ...LATEST, version: "0.3.16" } } }));
    const pin = await screen.findByTestId("update-banner-pin");
    expect(within(pin).getByText("New Pin apps are ready")).toBeInTheDocument();
    expect(within(pin).getByText("Your server offers 2026-09-29.2; your Pin has 2026-08-01.1.")).toBeInTheDocument();
    expect(within(pin).getByRole("link", { name: "Update your Pin" })).toHaveAttribute("href", "/settings/pin/install");
    expect(screen.queryByTestId("update-banner-center")).not.toBeInTheDocument();
  });

  it.each([
    ["the Pin already has the offered apps", "2026-09-29.2"],
    ["the Pin is newer", "2026-10-05.1"],
    ["the Pin was never read here", null],
  ])("shows nothing when the server is current and %s", async (_label, onPin) => {
    if (onPin) window.localStorage.setItem("luma.updates.pinRelease", onPin);
    show(overview({ check: { outcome: "up-to-date", checkedAt: "2026-10-03T02:00:00Z", latest: { ...LATEST, version: "0.3.16" } } }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
  });

  it("shows nothing when the overview is refused or malformed", async () => {
    show(Response.json({ error: "Operator access required." }, { status: 403 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
  });

  it("stays dismissed for the versions it named, and returns for a newer one", async () => {
    const first = show(overview());
    await screen.findByTestId("update-banner");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    first.unmount();

    const again = show(overview());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    again.unmount();

    show(overview({ check: { outcome: "update-available", checkedAt: "2026-10-04T02:00:00Z", latest: { ...LATEST, version: "0.3.19" } } }));
    expect(await screen.findByText("Luma 0.3.19 is available")).toBeInTheDocument();
  });
});
