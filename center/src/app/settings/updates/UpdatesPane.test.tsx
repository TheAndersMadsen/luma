import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { UpdateOverview } from "@/lib/contracts/updates";
import { UpdatesPane } from "./UpdatesPane";

/*
 * Settings → Advanced → Software updates renders one server-resolved overview.
 * It must read plainly in every state, name the server commands instead of
 * changing anything itself, and work without JavaScript ("Check now" is a
 * form post).
 */

const LATEST = {
  version: "0.3.18",
  tag: "v0.3.18",
  pinVersion: "2026-10-02.1",
  notes: "Calmer banner.\nFaster weather.",
  publishedAt: "2026-10-02T18:00:00Z",
};

function overview(patch: Partial<UpdateOverview> = {}): UpdateOverview {
  return {
    current: {
      release: "0123456789abcdef",
      version: "0.3.16",
      tag: "v0.3.16",
      pinVersion: "2026-09-29.2",
      notes: "Software updates page.",
      publishedAt: "2026-09-29T18:00:00Z",
    },
    source: "https://updates.example.test",
    autoUpdates: "off",
    check: { outcome: "update-available", checkedAt: "2026-10-03T02:00:00Z", latest: LATEST },
    lastUpdate: null,
    ...patch,
  };
}

describe("Software updates", () => {
  it("shows what runs, what is new, and the one command when updates are manual", () => {
    render(<UpdatesPane overview={overview()} />);

    expect(screen.getByTestId("updates-current-version")).toHaveTextContent("Luma 0.3.16");
    expect(screen.getByText("v0.3.16 · Published Sep 29, 2026")).toBeInTheDocument();
    expect(screen.getByTestId("updates-check-sentence")).toHaveTextContent("Luma 0.3.18 is available.");
    expect(screen.getByTestId("updates-latest-version")).toHaveTextContent("Luma 0.3.18 · Pin apps 2026-10-02.1");
    const notes = screen.getByTestId("updates-latest-notes");
    expect(notes.tagName).toBe("DETAILS");
    expect(notes).not.toHaveAttribute("open");
    expect(within(notes).getByText("What’s new")).toBeInTheDocument();
    expect(screen.getAllByTestId("copy-command").map((node) => node.textContent)).toEqual(["./luma update production"]);
    expect(screen.getByTestId("updates-source")).toHaveTextContent("https://updates.example.test");
    expect(screen.getByText("./luma setup production --update-source https://…")).toBeInTheDocument();
    expect(screen.getByTestId("updates-auto")).toHaveTextContent("Off");
    expect(screen.getByText("./luma setup production --auto-updates on|off")).toBeInTheDocument();
    expect(screen.getByTestId("updates-last-sentence")).toHaveTextContent("No update has run on this server yet.");
  });

  it("offers Check now as a plain same-origin form post", () => {
    render(<UpdatesPane overview={overview()} />);
    const button = screen.getByRole("button", { name: "Check now" });
    const form = button.closest("form")!;
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/admin/updates/check");
    expect(button).toBeEnabled();
  });

  it("says the update installs itself when automatic updates are on", () => {
    render(<UpdatesPane overview={overview({ autoUpdates: "on" })} />);
    expect(screen.getByText(/It installs itself tonight; your Center may pause for a minute\./)).toBeInTheDocument();
    expect(screen.queryByTestId("copy-command")).not.toBeInTheDocument();
    expect(screen.getByTestId("updates-auto")).toHaveTextContent("On");
  });

  it("says a restored update lost nothing", () => {
    render(<UpdatesPane overview={overview({
      check: { outcome: "up-to-date", checkedAt: "2026-10-03T03:00:00Z", latest: { ...LATEST, version: "0.3.16" } },
      lastUpdate: {
        outcome: "rolled-back",
        from: "0.3.16",
        to: "0.3.18",
        startedAt: "2026-10-03T02:00:00Z",
        finishedAt: "2026-10-03T02:10:00Z",
        message: null,
      },
    })} />);
    expect(screen.getByTestId("updates-check-sentence")).toHaveTextContent("Your server runs the latest release, Luma 0.3.16.");
    expect(screen.getByTestId("updates-last-sentence")).toHaveTextContent(
      "The update to Luma 0.3.18 on Oct 3, 2026 at 2:10 AM UTC failed and your previous version, Luma 0.3.16, was restored. Nothing was lost.",
    );
    expect(screen.queryByTestId("copy-command")).not.toBeInTheDocument();
  });

  it("names a successful update and a failed one plainly", () => {
    const { unmount } = render(<UpdatesPane overview={overview({
      lastUpdate: { outcome: "updated", from: "0.3.15", to: "0.3.16", finishedAt: "2026-09-30T02:05:00Z" },
    })} />);
    expect(screen.getByTestId("updates-last-sentence")).toHaveTextContent("Updated from Luma 0.3.15 to 0.3.16 on Sep 30, 2026 at 2:05 AM UTC.");
    unmount();

    render(<UpdatesPane overview={overview({
      lastUpdate: { outcome: "failed", from: "0.3.16", to: "0.3.18", message: "The new release did not start." },
    })} />);
    expect(screen.getByTestId("updates-last-sentence")).toHaveTextContent("The update to Luma 0.3.18 failed. Your Center kept running Luma 0.3.16. Nothing was lost.");
    expect(screen.getByTestId("updates-last-message")).toHaveTextContent("The new release did not start.");
  });

  it("renders unknown values instead of failing when the server sets nothing", () => {
    render(<UpdatesPane overview={{
      current: { release: "development", version: null, tag: null, pinVersion: null, notes: null, publishedAt: null },
      source: null,
      autoUpdates: "unknown",
      check: { outcome: "source-unknown" },
      lastUpdate: null,
    }} />);
    expect(screen.getByTestId("updates-current-version")).toHaveTextContent("Unknown");
    expect(screen.getByTestId("updates-check-sentence")).toHaveTextContent("This server has no update source, so it never checks for updates.");
    expect(screen.getByTestId("updates-source")).toHaveTextContent("Not set");
    expect(screen.getByTestId("updates-auto")).toHaveTextContent("Unknown");
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    expect(screen.queryByTestId("updates-current-pin")).not.toBeInTheDocument();
  });

  it("says when the source could not answer", () => {
    render(<UpdatesPane overview={overview({ check: { outcome: "source-unreachable", checkedAt: "2026-10-03T02:00:00Z" } })} />);
    expect(screen.getByTestId("updates-check-sentence")).toHaveTextContent("Center couldn’t get a release from the update source just now.");
    expect(screen.getByText("Last checked Oct 3, 2026 at 2:00 AM UTC.")).toBeInTheDocument();
    expect(screen.queryByTestId("updates-latest-version")).not.toBeInTheDocument();
  });
});
