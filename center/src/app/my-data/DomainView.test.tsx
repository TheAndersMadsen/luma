import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { DomainView } from "./DomainView";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/my-data/translation" }));
afterEach(() => vi.unstubAllGlobals());

it("lists a synced translation language pair and Forget refreshes its list and overview", async () => {
  let deleted = false;
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/api/notable-events/mydata/translation-fixture" && init?.method === "DELETE") {
      deleted = true;
      return Response.json({ ok: true });
    }
    const url = new URL(input, "https://center.test");
    expect(url.pathname).toBe("/api/notable-events/mydata");
    expect(url.searchParams.get("domain")).toBe("TRANSLATION");
    const content = deleted ? [] : [{ uuid: "translation-fixture", userCreatedAt: "2026-09-30T10:00:00Z",
      data: { eventType: "humane.translation", eventData: { sourceLanguage: "English", targetLanguage: "Danish" } } }];
    return Response.json({ content, number: 0, size: 50, totalElements: content.length,
      totalPages: content.length, last: true, first: true, numberOfElements: content.length, empty: deleted },
      { headers: { "x-data-state": "live" } });
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["mydata-overview"], { data: [{ key: "TRANSLATION", total: 1 }] });
  client.setQueryData(["memories-dashboard"], { data: [] });
  render(<QueryClientProvider client={client}><DomainView domain="TRANSLATION" /></QueryClientProvider>);
  expect(await screen.findByText("English → Danish")).toBeVisible();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Forget this entry" }));
  expect(await screen.findByText("Nothing here yet")).toBeVisible();
  await waitFor(() => expect(client.getQueryState(["mydata-overview"])?.isInvalidated).toBe(true));
  expect(client.getQueryState(["memories-dashboard"])?.isInvalidated).toBe(true);
  client.clear();
  vi.restoreAllMocks();
});
