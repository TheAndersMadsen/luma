// @vitest-environment-options {"url":"https://center.test"}
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/browserRoom", () => ({ createBrowserRoom: mocks.create }));
import { BrowserDisplay, CommittedCard } from "./BrowserDisplay";
import { BrowserRuntime } from "@/lib/browserRuntime";
import { BROWSER_SURFACE_POSTURE } from "@/lib/contracts/surfaces";
import type { RenderCommand } from "@/lib/contracts/ambianceRuntime";
import { incarnation, roomConnection, TestRoom } from "@/lib/browserRoom.test-support";
import { Component, type ReactNode } from "react";
const actionId = "33333333-3333-3333-3333-333333333333";
const turnId = "44444444-4444-4444-4444-444444444444";
const text = "Public informational text <script>not executable</script>";
const digest = createHash("sha256").update(text).digest("hex");
let command: RenderCommand; let room: TestRoom;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
const acknowledgments = () => room.messages().filter(m => m.control?.kind === "acknowledge");
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  room = new TestRoom(); mocks.create.mockReturnValue(room);
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body as string) : {};
    if (url === "/api/surfaces") {
      command = { version: 1, actionId, turnId, generation: 1, surfaceId: body.surfaceId, incarnation,
        channel: "visual.card", contentDigest: digest, content: { kind: "text", text }, expiresAt: Date.now() + 60000 };
      return Response.json({ surface: { ...BROWSER_SURFACE_POSTURE, surfaceId: body.surfaceId, revision: 1, sequence: 0,
        revoked: false, visible: false, connected: true, available: false, connectionExpiresAt: Date.now() + 3600000, leaseExpiresAt: Date.now() + 45000 },
      connection: { token: "a".repeat(64), incarnation, expiresAt: Date.now() + 3600000 } });
    }
    if (url === "/api/runtime/room") return Response.json(roomConnection(body.epoch));
    if (String(url).endsWith("/leave")) return Response.json({});
    throw new Error("unexpected HTTP coordination");
  }));
  const original = room.invoke.getMockImplementation()!;
  room.invoke.mockImplementation(async payload => {
    const body = JSON.parse(payload);
    if (body.control?.kind === "acknowledge") {
      // Evidence at dispatch time: the actual escaped DOM must already exist.
      expect(screen.getByLabelText("Cosmos display").textContent).toBe(text);
      expect(body.control).toEqual({ kind: "acknowledge", actionId, turnId, generation: 1, channel: "visual.card", contentDigest: digest });
      expect(body.stamp.instanceId).toBe(actionId);
    }
    return original(payload);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function approve(deliver = true) {
  fireEvent.click(screen.getByRole("button", { name: "Approve this tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm shared display" }));
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  if (deliver) { await act(async () => { await room.receive(room.frame(command)); }); await flush(); }
}
it("requires approval, escapes text and acknowledges only the committed exact DOM", async () => {
  render(<BrowserDisplay />); expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole("textbox")).toBeDisabled();
  await approve(); expect(screen.getByText(text)).toBeVisible(); expect(document.querySelector("script")).toBeNull();
  expect(acknowledgments()).toHaveLength(1);
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  expect(acknowledgments()).toHaveLength(1);
});
it("hide clears immediately and fences a late acknowledgment", async () => {
  const original = room.invoke.getMockImplementation()!; let release!: (value: string) => void;
  room.invoke.mockImplementation(payload => JSON.parse(payload).control?.kind === "acknowledge"
    ? new Promise(resolve => { release = resolve; }) : original(payload));
  render(<BrowserDisplay />); await approve(); expect(screen.getByText(text)).toBeVisible();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange")); expect(screen.queryByText(text)).toBeNull();
  release(JSON.stringify({ version: 1, kind: "accepted", duplicate: false })); await flush();
  expect(screen.queryByText("Display acknowledgment recorded by Cosmos.")).toBeNull();
});
it("closing or unmounting clears output and fences later frames", async () => {
  const view = render(<BrowserDisplay />); await approve();
  view.rerender(<BrowserDisplay active={false} />); expect(screen.queryByText(text)).toBeNull();
  expect(room.close).toHaveBeenCalled(); view.unmount();
  await expect(room.receive(room.frame(command, 2))).rejects.toThrow();
});
it("an authoritative clear dismisses an acknowledged card and a retry cannot revive it", async () => {
  render(<BrowserDisplay />); await approve();
  await act(async () => { await room.clear(actionId); }); expect(screen.queryByText(text)).toBeNull();
  await act(async () => { await room.receive(room.frame(command)); }); expect(screen.queryByText(text)).toBeNull();
});
it.each(["digest", "incarnation"])("rejects wrong %s before display or acknowledgment", async mismatch => {
  render(<BrowserDisplay />); await approve(false);
  const bad = { ...command, ...(mismatch === "digest" ? { contentDigest: "b".repeat(64) } : { incarnation: turnId }) };
  await expect(room.receive(room.frame(bad))).rejects.toThrow();
  expect(screen.queryByText(text)).toBeNull(); expect(acknowledgments()).toHaveLength(0);
});
it("a React render that fails before commit sends no acknowledgment", () => {
  const runtime = new BrowserRuntime(turnId, vi.fn(), vi.fn()); const committed = vi.spyOn(runtime, "committed");
  class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? null : this.props.children; }
  }
  function Failure(): ReactNode { throw new Error("render failed"); }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const frame: RenderCommand = { version: 1, actionId, turnId, generation: 1, surfaceId: turnId, incarnation,
    channel: "visual.card", contentDigest: digest, content: { kind: "text", text }, expiresAt: Date.now() + 60000 };
  render(<Boundary><CommittedCard command={frame} runtime={runtime} /><Failure /></Boundary>);
  expect(committed).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); log.mockRestore();
});
it("retries an ambiguous acknowledgment using the identical stamp and proof", async () => {
  const original = room.invoke.getMockImplementation()!; let lost = false;
  room.invoke.mockImplementation(payload => {
    if (JSON.parse(payload).control?.kind === "acknowledge" && !lost) { lost = true; return Promise.reject({ code: 1502 }); }
    return original(payload);
  });
  render(<BrowserDisplay />); await approve();
  await waitFor(() => expect(acknowledgments()).toHaveLength(2));
  expect(acknowledgments()[0]).toEqual(acknowledgments()[1]);
  expect(screen.getByText("Display acknowledgment recorded by Cosmos.")).toBeVisible();
});
it("failed acknowledgment clears output and claims no completion", async () => {
  const original = room.invoke.getMockImplementation()!;
  room.invoke.mockImplementation(payload => JSON.parse(payload).control?.kind === "acknowledge"
    ? Promise.resolve(JSON.stringify({ version: 1, kind: "accepted", duplicate: false, guessed: true })) : original(payload));
  render(<BrowserDisplay />); await approve(); expect(screen.queryByText(text)).toBeNull();
  expect(screen.getByText("Display acknowledgment could not be confirmed.")).toBeVisible();
});
