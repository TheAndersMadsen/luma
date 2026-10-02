import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteAccount } from "./DeleteAccount";

function stubDelete(status: number, body: Record<string, unknown>, requests: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json(body, { status });
  }));
}

describe("DeleteAccount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes only after the phrase is typed, then signs out", async () => {
    const requests: unknown[] = [];
    const navigate = vi.fn();
    stubDelete(200, { ok: true, deleted: true, endSessionUrl: "https://center.test/end" }, requests);
    render(<DeleteAccount navigate={navigate} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete account…" }));
    const submit = screen.getByRole("button", { name: "Delete my account" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "delete");
    expect(submit).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Type DELETE to confirm"));
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(submit);

    expect(requests).toEqual([
      { url: "/api/settings/privacy/account", method: "DELETE", body: { confirm: "DELETE" } },
    ]);
    expect(navigate).toHaveBeenCalledWith("https://center.test/end");
  });

  it("stays signed in and says so when the deletion did not finish", async () => {
    const navigate = vi.fn();
    stubDelete(502, { ok: false, deleted: false, error: "Your account couldn’t be fully deleted. Try again to finish." }, []);
    render(<DeleteAccount navigate={navigate} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete account…" }));
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));

    expect(await screen.findByText(/couldn’t be fully deleted/)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
