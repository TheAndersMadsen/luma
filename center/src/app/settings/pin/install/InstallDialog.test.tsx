import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InstallDialog } from "./InstallDialog";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div data-testid="page-content">
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      <InstallDialog
        open={open}
        labelledBy="dialog-title"
        initialFocusRef={closeRef}
        onDismiss={() => setOpen(false)}
      >
        <h2 id="dialog-title">Connection help</h2>
        <button ref={closeRef} type="button" onClick={() => setOpen(false)}>Close</button>
        <a href="/help">Help</a>
      </InstallDialog>
    </div>
  );
}

describe("InstallDialog", () => {
  it("moves focus into the dialog, inerts the page and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });

    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(screen.getByTestId("page-content").parentElement).toHaveProperty("inert", true);
    expect(screen.getByTestId("page-content").parentElement).toHaveAttribute("aria-hidden", "true");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByTestId("page-content").parentElement).not.toHaveAttribute("inert");
    expect(screen.getByTestId("page-content").parentElement).not.toHaveAttribute("aria-hidden");
  });
});
