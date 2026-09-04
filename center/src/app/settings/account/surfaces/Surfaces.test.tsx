import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Surfaces } from "./Surfaces";
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
  expect(screen.getByText(/Rendering and Pin-to-display delivery are not yet verified/)).toBeVisible();
});
