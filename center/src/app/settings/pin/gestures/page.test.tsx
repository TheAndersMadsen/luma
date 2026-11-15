import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PinClient } from "@/lib/pin-device/client";
import type { PinTransport } from "@/lib/pin-device/transport";
import PinGesturesPane from "./page";

// Failures specified before implementation in docs/gestures.md. This exercises
// the actual pane, contract parser and PinClient through the HTTP boundary.
const pane = vi.hoisted(() => ({ client: null as PinClient | null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/settings/pin/gestures" }));
vi.mock("../_lib/pinSession", () => ({ usePinPaneSession: () => ({
  client: pane.client, ready: !!pane.client, serviceStatus: "online", device: null,
  connectionError: null, attachedWithoutServer: false,
}) }));

function pin(title = "Open Music") {
  let revision = "a".repeat(64);
  let config = { schema_version: 1, mode: "off", bindings: [] as unknown[] };
  let refuse = false;
  const calls: { path: string; method: string; body: unknown }[] = [];
  const response = () => ({ schema_version: 1, revision, valid: true, config,
    catalog: [
      { id: "open_music", title, available: true, trigger: "fingers", note: "Opens Music." },
      { id: "pinch_to_copy", title: "Pinch to copy", available: true, trigger: "pinch_session", note: "Requires projection validation." },
    ],
  });
  const request = vi.fn(async (path: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    const method = options?.method ?? "GET";
    calls.push({ path, method, body });
    if (path === "/api/gestures/observation") return Response.json({ observation: null });
    if (path !== "/api/gestures") return new Response(null, { status: 404 });
    if (method === "PUT") {
      if (refuse || body.revision !== revision) return Response.json({ error: "conflict" }, { status: 409 });
      config = body.config;
      revision = "b".repeat(64);
    }
    return Response.json(response());
  });
  const client = new PinClient({ mode: "usb", request } as unknown as PinTransport);
  return { client, calls, request, reject: () => { refuse = true; } };
}

afterEach(() => { pane.client = null; });

it("configures a device-advertised feature with the current revision and reads the saved result", async () => {
  const device = pin(); pane.client = device.client;
  const user = userEvent.setup();
  render(<PinGesturesPane />);
  await user.click(await screen.findByRole("button", { name: "Add shortcut" }));
  await user.selectOptions(screen.getByLabelText("Mode"), "observe");
  await user.selectOptions(screen.getByLabelText("Fingers 1"), "pinky");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Changes saved on your Pin.")).toBeVisible();
  expect(device.calls.find((call) => call.method === "PUT")?.body).toEqual({
    revision: "a".repeat(64), config: { schema_version: 1, mode: "observe", bindings: [
      { fingers: ["pinky"], hold_ms: 400, feature: "open_music" },
    ] },
  });
  expect(screen.queryByRole("option", { name: "Pinch to copy" })).not.toBeInTheDocument();
  expect(screen.getByText("Requires projection validation.")).toBeVisible();
});

it("retains a rejected draft, reports the conflict, and never claims it was saved", async () => {
  const device = pin(); pane.client = device.client;
  const user = userEvent.setup(); render(<PinGesturesPane />);
  await user.click(await screen.findByRole("button", { name: "Add shortcut" }));
  device.reject();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText(/changed elsewhere/)).toBeVisible();
  expect(screen.getByLabelText("Fingers 1")).toBeInTheDocument();
  expect(screen.queryByText("Changes saved on your Pin.")).not.toBeInTheDocument();
});

it("discards one Pin's draft and stops inspection when the connected Pin changes", async () => {
  const first = pin("First Pin Music"); pane.client = first.client;
  const user = userEvent.setup(); const view = render(<PinGesturesPane />);
  await user.click(await screen.findByRole("button", { name: "Add shortcut" }));
  await user.click(screen.getByRole("button", { name: "Start inspector" }));
  await waitFor(() => expect(first.calls.some((call) => call.path.endsWith("/observation"))).toBe(true));
  expect(await screen.findByText("No fresh launcher observation.")).toBeVisible();
  const second = pin("Second Pin Music"); pane.client = second.client; view.rerender(<PinGesturesPane />);
  await screen.findByText("Second Pin Music");
  expect(screen.queryByText("First Pin Music")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Fingers 1")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start inspector" })).toBeVisible();
  expect(second.calls.some((call) => call.path.endsWith("/observation"))).toBe(false);
});

it("does not accept a malformed response as an editable configuration", async () => {
  const device = pin(); pane.client = device.client;
  device.request.mockImplementation(async () => Response.json({ schema_version: 999 }));
  render(<PinGesturesPane />);
  expect(await screen.findByText(/Couldn’t load gestures/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
});
