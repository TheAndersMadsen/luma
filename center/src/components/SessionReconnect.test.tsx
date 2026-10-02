import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionIdentityContext, SessionReconnect } from "./SessionReconnect";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/settings" }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => vi.unstubAllGlobals());

describe("reconnect without losing an edit", () => {
  it("keeps the draft and route mounted while signing back into the same account", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const fetch = vi.fn(async () => Response.json({ ok: true, sub: "wearer" }));
    vi.stubGlobal("fetch", fetch);
    render(<QueryClientProvider client={client}><SessionIdentityContext.Provider value={{ sub: "wearer", email: "wearer@example.test" }}>
      <input aria-label="Unsaved note" defaultValue="Keep this draft" /><SessionReconnect />
    </SessionIdentityContext.Provider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(screen.getByLabelText("Email")).toHaveValue("wearer@example.test");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(screen.getByLabelText("Unsaved note")).toHaveValue("Keep this draft");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the dialog open and explains rejected credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Those credentials were not accepted." }, { status: 401 })));
    render(<QueryClientProvider client={new QueryClient()}><SessionIdentityContext.Provider value={{ sub: "wearer", email: "wearer@example.test" }}><SessionReconnect /></SessionIdentityContext.Provider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Those credentials were not accepted.");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
});
