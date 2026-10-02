import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import MyDataPage from "./page";

vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/SessionReconnect", () => ({ SessionReconnect: () => <a href="/login?next=/my-data">Sign in</a> }));
afterEach(() => vi.unstubAllGlobals());

it("offers sign-in when My Data overview reports an expired wearer session", async () => {
  const fetch = vi.fn(async () => new Response("[]", { headers: {
    "content-type": "application/json", "x-data-state": "degraded", "x-data-reauthenticate": "1",
  } }));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MyDataPage /></QueryClientProvider>);
  expect(await screen.findByRole("link", { name: "Sign in" })).toBeVisible();
  expect(screen.getByText(/Your session expired/)).toBeVisible();
  expect(screen.queryByText(/Connect your Pin/)).not.toBeInTheDocument();
  client.clear();
});
