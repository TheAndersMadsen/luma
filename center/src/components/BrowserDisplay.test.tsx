import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserDisplay, CommittedCard } from "./BrowserDisplay";
import { BrowserRuntime } from "@/lib/browserRuntime";
import { BROWSER_SURFACE_POSTURE } from "@/lib/contracts/surfaces";
import type { RenderCommand } from "@/lib/contracts/ambianceRuntime";
import { Component, type ReactNode } from "react";
const incarnation = "22222222-2222-2222-2222-222222222222";
const actionId = "33333333-3333-3333-3333-333333333333";
const turnId = "44444444-4444-4444-4444-444444444444";
const text = "Public informational text <script>not executable</script>";
const digest = createHash("sha256").update(text).digest("hex");
let command: RenderCommand;
let polls: RenderCommand[];
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  polls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body as string) : {};
    if (url === "/api/surfaces") {
      command = { version: 1, actionId, turnId, generation: 1, surfaceId: body.surfaceId, incarnation, channel: "visual.card", contentDigest: digest, content: { kind: "text", text }, expiresAt: Date.now() + 60000 };
      const surface = { ...BROWSER_SURFACE_POSTURE, surfaceId: body.surfaceId, revision: 1, sequence: 0, revoked: false, visible: false, connected: true, available: false, connectionExpiresAt: Date.now() + 3600000, leaseExpiresAt: Date.now() + 45000 };
      return Response.json({ surface, connection: { token: "a".repeat(64), incarnation, expiresAt: Date.now() + 3600000 } });
    }
    if (String(url).endsWith("/state")) return Response.json({ surface: { ...BROWSER_SURFACE_POSTURE, surfaceId: command.surfaceId, revision: 2, sequence: body.sequence, revoked: false, visible: body.visible, connected: true, available: body.visible, connectionExpiresAt: Date.now() + 3600000, leaseExpiresAt: Date.now() + 45000 } });
    if (url === "/api/runtime/poll") return Response.json({ commands: polls, clear: [] });
    if (url === "/api/runtime/ack") {
      // This assertion executes at the transport boundary, not after waitFor.
      expect(screen.getByLabelText("Cosmos display").textContent).toBe(text);
      expect(body).toEqual({ surfaceId: command.surfaceId, incarnation, actionId, turnId, generation: 1, channel: "visual.card", contentDigest: digest });
      return Response.json({ acknowledged: true });
    }
    return Response.json({ accepted: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function approve() {
  fireEvent.click(screen.getByRole("button", { name: "Approve this tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm shared display" }));
  await flush(); polls = [command]; await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); }); await flush();
}
it("requires explicit approval, escapes text, and acknowledges only the committed exact DOM", async () => {
  render(<BrowserDisplay />);
  expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole("textbox")).toBeDisabled();
  await approve();
  expect(screen.getByText(text)).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/runtime/ack")).toHaveLength(1);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/runtime/ack")).toHaveLength(1);
});
it("hide immediately clears and fences a late acknowledgment", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation((url, options) => url === "/api/runtime/ack" ? new Promise<Response>(done => { resolve = done; }) : original(url, options));
  render(<BrowserDisplay />); await approve(); expect(screen.getByText(text)).toBeVisible();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.queryByText(text)).toBeNull();
  resolve(Response.json({ acknowledged: true })); await flush();
  expect(screen.queryByText("Display acknowledgment recorded by Cosmos.")).toBeNull();
});
it("closing and unmounting abort delivery and remove the current frame", async () => {
  const view = render(<BrowserDisplay />); await approve();
  view.rerender(<BrowserDisplay active={false} />); expect(screen.queryByText(text)).toBeNull();
  view.unmount();
  const ack = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/runtime/ack");
  expect(ack?.[1]?.signal?.aborted).toBe(true);
});
it("authoritative empty snapshot dismisses an acknowledged previous turn", async () => {
  render(<BrowserDisplay />); await approve(); polls = [];
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  expect(screen.queryByText(text)).toBeNull();
});
it.each(["digest", "incarnation"])("rejects a wrong %s before rendering or acknowledging", async mismatch => {
  render(<BrowserDisplay />);
  fireEvent.click(screen.getByRole("button", { name: "Approve this tab" })); fireEvent.click(screen.getByRole("button", { name: "Confirm shared display" })); await flush();
  polls = [{ ...command, ...(mismatch === "digest" ? { contentDigest: "b".repeat(64) } : { incarnation: turnId }) }];
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); }); await flush();
  expect(screen.queryByText(text)).toBeNull(); expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/runtime/ack")).toBe(false);
});
it("a React render that fails before commit sends no acknowledgment", () => {
  const runtime = new BrowserRuntime(turnId, vi.fn(), vi.fn()); const committed = vi.spyOn(runtime, "committed");
  class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? null : this.props.children; }
  }
  function Failure(): ReactNode { throw new Error("render failed"); }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const frame: RenderCommand = { version: 1, actionId, turnId, generation: 1, surfaceId: turnId, incarnation, channel: "visual.card", contentDigest: digest, content: { kind: "text", text }, expiresAt: Date.now() + 60000 };
  render(<Boundary><CommittedCard command={frame} runtime={runtime} /><Failure /></Boundary>);
  expect(committed).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); log.mockRestore();
});
it("retries the same DOM acknowledgment after an ambiguous lost response", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!; let lost = false;
  vi.mocked(fetch).mockImplementation((url, options) => {
    if (url === "/api/runtime/ack" && !lost) { lost = true; return Promise.reject(new TypeError("connection lost after server committed")); }
    return original(url, options);
  });
  render(<BrowserDisplay />); await approve();
  const acknowledgments = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/runtime/ack");
  expect(acknowledgments).toHaveLength(2); expect(acknowledgments[0][1]?.body).toBe(acknowledgments[1][1]?.body);
  expect(screen.getByText(text)).toBeVisible(); expect(screen.getByText("Display acknowledgment recorded by Cosmos.")).toBeVisible();
});
it("failed acknowledgment never reports completion and clears the frame", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((url, options) => url === "/api/runtime/ack" ? Promise.resolve(Response.json({ acknowledged: false })) : original(url, options));
  render(<BrowserDisplay />); await approve();
  expect(screen.queryByText(text)).toBeNull();
  expect(screen.getByText("Display acknowledgment could not be confirmed.")).toBeVisible();
});
