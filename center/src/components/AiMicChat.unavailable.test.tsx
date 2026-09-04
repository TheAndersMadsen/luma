import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { AiMicChat, AssistantStatusChip } from "./AiMicChat";
const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(Element.prototype, "scrollTo");
});
it("shows runtime unavailability without a spoken answer or automatic retry", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  const fetch = vi.fn(async (url: RequestInfo | URL) => String(url) === "/api/assistant/status"
    ? Response.json({ assistant: true, speech: true, browser_runtime: "unavailable", model: "configured-model", provider_authority: "cosmos", tools: [] })
    : Response.json({ error: "Browser assistant runtime is unavailable." }, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AiMicChat /></QueryClientProvider>);
  fireEvent.change(screen.getByRole("textbox", { name: "Ask Cosmos" }), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Browser assistant runtime is unavailable.");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Ask Cosmos" })).not.toBeDisabled());
  expect(fetch.mock.calls.filter(([url]) => url === "/api/assistant/stream")).toHaveLength(1);
  expect(fetch.mock.calls.some(([url]) => url === "/api/assistant/speech")).toBe(false);
  client.clear();
});
it("does not mistake configured providers for an available browser runtime", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ assistant: true, speech: true, browser_runtime: "unavailable", model: "configured-model", provider_authority: "cosmos", tools: [] })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AssistantStatusChip /></QueryClientProvider>);
  await screen.findByText("Browser runtime unavailable");
  expect(screen.queryByText("Assistant ready")).not.toBeInTheDocument();
  expect(screen.queryByText("Set up Assistant")).not.toBeInTheDocument();
  client.clear();
});
