import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserCard } from "./BrowserCard";
import { SURFACE_APPROVAL } from "@/lib/contracts/surfaces";

afterEach(() => { vi.unstubAllGlobals(); });

it("is one plain card whose switch needs explicit confirmation before any request, and reports a lost connection honestly", async () => {
  const mock = vi.fn(async () => Response.json({ surfaces: [] })); vi.stubGlobal("fetch", mock);
  render(<BrowserCard />);
  expect(screen.getByRole("heading", { name: "This browser" })).toBeVisible();
  expect(screen.getByText("Offline")).toBeVisible();
  expect(screen.getByText("Shows shared replies while this tab is open.")).toBeVisible();
  expect(mock).not.toHaveBeenCalled();
  const toggle = screen.getByRole("switch", { name: "Use this browser as a display" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(screen.getByRole("group", { name: "Confirm shared display" })).toBeVisible();
  expect(screen.getByText(/may be seen by other people/u)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Confirm shared display" })).not.toBeInTheDocument();
  expect(mock).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(mock).toHaveBeenCalled());
  const [url, options] = mock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/surfaces"); expect(options.method).toBe("POST");
  expect(JSON.parse(String(options.body))).toMatchObject({ approval: SURFACE_APPROVAL });
  // The reply carried no connection, so the tab reports the loss instead of pretending.
  await screen.findByText("The connection was lost. Turn it on again to reconnect.");
  expect(screen.getByRole("switch", { name: "Use this browser as a display" })).not.toBeChecked();
  expect(screen.getByText("Offline")).toBeVisible();
  expect(mock).toHaveBeenCalledTimes(1);
});
