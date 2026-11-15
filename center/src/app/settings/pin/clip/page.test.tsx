import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PinClient } from "@/lib/pin-device/client";
import type { PinTransport } from "@/lib/pin-device/transport";
import type { ClipArticle, ClipSnapshot } from "@/lib/contracts/clips";
import PinClipPane from "./page";

// Boundary acceptance written before the pane: explicit handoff, no save before
// native press, idempotent recovery, no false acknowledgement, no cross-Pin work.
const pane = vi.hoisted(() => ({ client: null as PinClient | null }));
vi.mock("../_lib/pinSession", () => {
  const ids = new WeakMap<PinClient, number>(); let next = 0;
  return ({
  usePinPaneSession: () => ({ client: pane.client, ready: !!pane.client, connectionError: null, attachedWithoutServer: false }),
  pinClientIdentity: (client: PinClient) => { if (!ids.has(client)) ids.set(client, ++next); return String(ids.get(client)); },
}); });
const article: ClipArticle = { id: "883f16e9-c100-4283-b3c5-68eab9681dd5", title: "An article", publisher: "Example", url: "https://example.org/article", selection: "Selected text" };

function device(expireAfterResult = false) {
  let clip: ClipSnapshot | null = null;
  let offline = false;
  const calls: { path: string; method: string; body: unknown }[] = [];
  const request = async (path: string, options?: RequestInit, signal?: AbortSignal) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ path, method, body });
    if (offline) return Response.json({ error: "unavailable" }, { status: 503 });
    if (method === "GET") await new Promise((resolve) => setTimeout(resolve, 20));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (method === "PUT" && path.endsWith("/result")) {
      if (clip && clip.article.id === body.id) clip = { ...clip, phase: body.outcome };
    } else if (method === "PUT") clip = { article: body, phase: "ready", expires_at_ms: 60000, requested_at_ms: null };
    if (method === "DELETE") clip = null;
    const response = Response.json({ clip });
    if (expireAfterResult && path.endsWith("/result")) clip = null;
    return response;
  };
  return {
    client: new PinClient({ mode: "usb", request } as unknown as PinTransport), calls,
    pinch: () => { if (clip) clip = { ...clip, phase: "requested", requested_at_ms: 1000 }; },
    offline: (value: boolean) => { offline = value; },
    expire: () => { clip = null; },
  };
}
function handoff(value = article, origin = window.location.origin) {
  fireEvent(window, new MessageEvent("message", { source: window, origin, data: { type: "luma.clip.article", request_id: value.id, article: value } }));
}
afterEach(() => { pane.client = null; vi.unstubAllGlobals(); });

it("stages only an enabled, same-window handoff and saves only after the Pin requests it", async () => {
  const pin = device(); pane.client = pin.client;
  const cloud = vi.fn(async () => Response.json({ uuid: article.id, createdAt: 1000, hasLocation: false, sealed: false, title: article.title, text: article.selection }));
  vi.stubGlobal("fetch", cloud);
  const user = userEvent.setup(); render(<PinClipPane />);
  handoff(); expect(pin.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Enable browser handoff" }));
  handoff(article, "https://another.example");
  expect(pin.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  handoff();
  await screen.findByText("An article");
  expect(cloud).not.toHaveBeenCalled();
  pin.pinch();
  expect(await screen.findByText("Saved to Notes.")).toBeVisible();
  expect(cloud).toHaveBeenCalledTimes(1);
  const [path, init] = cloud.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/capture/clips/${article.id}`);
  expect(JSON.parse(String(init.body))).toEqual({ title: article.title, publisher: article.publisher, url: article.url, selection: article.selection });
  expect(pin.calls.find((call) => call.path.endsWith("/result"))?.body).toEqual({ id: article.id, outcome: "saved" });
});

it("keeps an uncertain save pending and retries the same immutable copy ID", async () => {
  const pin = device(); pane.client = pin.client;
  const cloud = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(Response.json({ uuid: article.id, createdAt: 1000, hasLocation: false, sealed: false, text: article.selection }));
  vi.stubGlobal("fetch", cloud);
  const user = userEvent.setup(); render(<PinClipPane />);
  await user.click(screen.getByRole("button", { name: "Enable browser handoff" })); handoff();
  await screen.findByText("An article"); pin.pinch();
  await screen.findByText(/Save not yet confirmed/);
  expect(pin.calls.filter((call) => call.path.endsWith("/result"))).toHaveLength(0);
  await screen.findByText("Saved to Notes.", {}, { timeout: 4000 });
  expect(cloud.mock.calls.map(([path]) => path)).toEqual([`/api/capture/clips/${article.id}`, `/api/capture/clips/${article.id}`]);
});

it("never acknowledges a malformed cloud response and stops old work on a Pin change", async () => {
  const first = device(); pane.client = first.client;
  const cloud = vi.fn(async () => Response.json({ uuid: "wrong", createdAt: 1000, hasLocation: false, sealed: false, text: "wrong" }));
  vi.stubGlobal("fetch", cloud);
  const user = userEvent.setup(); const view = render(<PinClipPane />);
  await user.click(screen.getByRole("button", { name: "Enable browser handoff" })); handoff();
  await screen.findByText("An article"); first.pinch();
  await screen.findByText(/Save not yet confirmed/);
  expect(first.calls.filter((call) => call.path.endsWith("/result"))).toHaveLength(0);
  const second = device(); pane.client = second.client; view.rerender(<PinClipPane />);
  await waitFor(() => expect(screen.queryByText("An article")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Enable browser handoff" })).toBeVisible();
  expect(second.calls.every((call) => call.method === "GET")).toBe(true);
});

it("clears a recovered connection error and stops promising retries after the lease expires", async () => {
  const pin = device(); pane.client = pin.client; pin.offline(true);
  const cloud = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", cloud);
  const user = userEvent.setup(); render(<PinClipPane />);
  await screen.findByText(/Your Pin is not answering/);
  pin.offline(false);
  await waitFor(() => expect(screen.queryByText(/Your Pin is not answering/)).not.toBeInTheDocument(), { timeout: 2500 });
  await user.click(screen.getByRole("button", { name: "Enable browser handoff" })); handoff();
  await screen.findByText("An article"); pin.pinch();
  await screen.findByText(/Save not yet confirmed/);
  pin.expire();
  expect(await screen.findByText(/copy session expired/)).toBeVisible();
  expect(screen.queryByText(/Clip is checking again/)).not.toBeInTheDocument();
  expect(pin.calls.filter((call) => call.path.endsWith("/result"))).toHaveLength(0);
});

it("does not report an uncertain expiry after the Pin has acknowledged the saved note", async () => {
  const pin = device(true); pane.client = pin.client;
  const cloud = vi.fn(async () => Response.json({ uuid: article.id, createdAt: 1000, hasLocation: false, sealed: false, text: article.selection }));
  vi.stubGlobal("fetch", cloud);
  const user = userEvent.setup(); render(<PinClipPane />);
  await user.click(screen.getByRole("button", { name: "Enable browser handoff" })); handoff();
  await screen.findByText("An article"); pin.pinch();
  await waitFor(() => expect(pin.calls.some((call) => call.path.endsWith("/result"))).toBe(true));
  await screen.findByText(/No article is waiting/);
  expect(screen.queryByText(/copy session expired/)).not.toBeInTheDocument();
  expect(cloud).toHaveBeenCalledTimes(1);
});
