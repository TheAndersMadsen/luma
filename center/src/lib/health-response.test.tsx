import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useBackendHealth } from "./queries";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const healthy = {
  cosmosConfigured: true,
  reachable: true,
  state: "live",
  detail: "Available",
};

it.each([
  { ...healthy, cosmosConfigured: "false" },
  { ...healthy, reachable: "false" },
  { ...healthy, state: "invented" },
  { ...healthy, detail: { private: "SYNTHETIC_PRIVATE_VALUE" } },
  [],
])(
  "unreadable health is an outage rather than an invented live state: %j",
  async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBackendHealth(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.state).toBe("degraded");
    expect(result.current.data?.reachable).toBe(false);
    expect(JSON.stringify(result.current.data)).not.toContain(
      "SYNTHETIC_PRIVATE_VALUE",
    );
    client.clear();
  },
);

it("keeps the expired-session signal from a valid health response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ...healthy,
        reachable: false,
        state: "degraded",
        reauthenticate: true,
      }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useBackendHealth(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.reauthenticate).toBe(true);
  client.clear();
});
