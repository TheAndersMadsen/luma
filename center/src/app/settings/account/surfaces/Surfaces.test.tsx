import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Surfaces } from "./Surfaces";
import { BROWSER_SURFACE_POSTURE, OUTPUT_ONLY_BROWSER_POSTURE } from "@/lib/contracts/surfaces";
afterEach(() => { vi.unstubAllGlobals(); });
it("requires explicit shared approval and keeps enrollment claims honest", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ surfaces: [] })));
  render(<Surfaces />);
  await screen.findByText("No approved displays.");
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Approve this tab" }));
  expect(screen.getByRole("button", { name: "Confirm shared display" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Approve this tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm shared display" }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
  expect(screen.getByText(/Private memories, speech and device actions are unavailable/)).toBeVisible();
});

it.each([
  { service: "web", name: "Web", review: "web", provider: "searxng", endpoint: "https://search.example.test/search" },
  { service: "places", name: "Place", review: "place", provider: "google_places", endpoint: "https://places.googleapis.com/v1/places:searchText" },
])("offers separate lookup controls and keeps output-only browser approval unable to grant $service lookup", async ({ service, name, review, provider, endpoint }) => {
  const surfaceId = "11111111-1111-4111-8111-111111111111";
  const row = { ...BROWSER_SURFACE_POSTURE, ...OUTPUT_ONLY_BROWSER_POSTURE, surfaceId, revision: 4,
    revoked: false, visible: false, connected: false, available: false, sequence: 0, connectionExpiresAt: 0, leaseExpiresAt: 0 };
  const mock = vi.fn(async (url: RequestInfo | URL) => String(url) === "/api/surfaces"
    ? Response.json({ surfaces: [row] }) : Response.json({ approval: null, binding: { approvalRevision: 4, incarnation: "22222222-2222-4222-8222-222222222222" }, providers: [
      { provider, endpoint, configurationDigest: "a".repeat(64) },
    ] }));
  vi.stubGlobal("fetch", mock); render(<Surfaces />);
  await screen.findByRole("group", { name: "Web lookup permission for Browser display 1" });
  expect(screen.getByRole("group", { name: "Place lookup permission for Browser display 1" })).toBeVisible();
  expect(mock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: `${name} lookup permission` }));
  await screen.findByText(`No active ${review} lookup permission.`);
  expect(screen.getByRole("button", { name: `Review ${review} lookup permission` })).toBeDisabled();
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.lastCall?.[0]).toBe(`/api/surfaces/${surfaceId}/${service}-lookup`);
});
