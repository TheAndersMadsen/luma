import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasscodeView } from "./PasscodeView";

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PasscodeView />
    </QueryClientProvider>,
  );
}

describe("PasscodeView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets a four-digit passcode, confirmed, and never shows it again", async () => {
    const writes: unknown[] = [];
    let current: Record<string, unknown> = { set: false, state: "live" };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        current = { ...current, set: true };
        return Response.json({ ok: true, passcode: { set: true } });
      }
      return Response.json(current);
    }));
    renderView();

    expect(await screen.findByTestId("passcode-state")).toHaveTextContent("Not set");
    await userEvent.click(screen.getByRole("button", { name: "Set passcode" }));
    await userEvent.type(screen.getByLabelText("New passcode"), "4821");
    await userEvent.type(screen.getByLabelText("Confirm passcode"), "4821");
    await userEvent.click(screen.getByRole("button", { name: "Save passcode" }));

    expect(writes).toEqual([{ passcode: "4821" }]);
    expect(await screen.findByText(/Passcode saved/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Guided setup" })).toHaveAttribute(
      "href",
      "/settings/pin/setup",
    );
    expect(screen.getByText(/re-enter it once.*directly to the Pin over USB/u)).toBeInTheDocument();
    expect(await screen.findByTestId("passcode-state")).toHaveTextContent("Set");
    expect(document.body).not.toHaveTextContent("4821");
  });
});
