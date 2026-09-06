// @vitest-environment-options {"url":"https://center.test"}
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserRuntime } from "./browserRuntime";
import { incarnation, roomConnection, TestRoom } from "./browserRoom.test-support";
import { renderContentPayload, type PlacesContent, type RenderCommand } from "./contracts/ambianceRuntime";
let runtime: BrowserRuntime; let room: TestRoom;
const surfaceId = "11111111-1111-1111-1111-111111111111";
const connection = () => ({ token: "a".repeat(64), incarnation, expiresAt: Date.now() + 3600000 });
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  room = new TestRoom(); runtime = new BrowserRuntime(surfaceId, vi.fn(), vi.fn(), () => room);
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => Response.json(roomConnection(JSON.parse(options.body).epoch))));
});
afterEach(() => { runtime.stop(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const command = (): RenderCommand => ({ version: 1, surfaceId, incarnation, actionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(), generation: 1, channel: "visual.card", expiresAt: Date.now() + 60000,
  content: { kind: "text", text: "Synthetic public text" }, contentDigest: createHash("sha256").update("Synthetic public text").digest("hex") });
const placesCommand = (): RenderCommand & { content: PlacesContent } => ({ ...command(),
  content: { kind: "places", query: "Central Library", items: [{ placeId: "place-library", name: "Central Library",
    address: "1 Library Road", sourceUrl: "https://www.google.com/maps/place/Central-Library" }], attributions: ["Library information provider"] },
  contentDigest: createHash("sha256").update(JSON.stringify(["cosmos.place-address-card", 1, "Central Library",
    [["place-library", "Central Library", "1 Library Road", "https://www.google.com/maps/place/Central-Library"]],
    ["Library information provider"]])).digest("hex") });
const renderCases = [{ kind: "text", makeCommand: command }, { kind: "places", makeCommand: placesCommand }];
it("fences a failed incarnation and cannot reconnect on a heartbeat", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));
  await expect(runtime.start(connection())).rejects.toThrow();
  await expect(runtime.start(connection())).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  await expect(runtime.start({ ...connection(), incarnation: crypto.randomUUID() })).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(2);
});
it("uses one increasing stream for visibility, input, acknowledgment and cancellation", async () => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); await runtime.input("public request");
  const c = command(); await room.receive(room.frame(c)); await runtime.committed(render.mock.calls.at(-1)![0]); await runtime.cancel();
  const messages = room.messages();
  expect(messages.map(m => m.stamp.sequence)).toEqual([1, 2, 3, 4]);
  expect(new Set(messages.map(m => m.stamp.epoch)).size).toBe(1);
  expect(messages[2].control.actionId).toBe(c.actionId);
  expect(messages[3].control.turnId).toBe(messages[1].stamp.instanceId);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("retries initial busy presence with the same stamp and serialized later input", async () => {
  await runtime.start(connection());
  room.invoke.mockRejectedValueOnce({ code: 1429 });
  const visible = runtime.visibility(true); await vi.advanceTimersByTimeAsync(250); await visible;
  await runtime.input("hello");
  expect(room.invoke.mock.calls[0][0]).toBe(room.invoke.mock.calls[1][0]);
  expect(room.messages().map(m => m.stamp.sequence)).toEqual([1, 1, 2]);
});
it.each(renderCases)("a $kind receipt is not a DOM acknowledgment and exact retries cannot rerender", async ({ makeCommand }) => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); const c = makeCommand();
  const frame = room.frame(c); const receipt = JSON.parse(await room.receive(frame));
  expect(receipt.kind).toBe("received"); expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(0);
  await room.receive(frame); expect(render.mock.calls.filter(([value]) => value)).toHaveLength(1);
  await room.clear(c.actionId); await room.receive(frame);
  expect(render).toHaveBeenLastCalledWith(null);
});
it.each(["digest", "incarnation", "epoch", "sequence"])("rejects wrong %s evidence before rendering", async mismatch => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); const c = command();
  if (mismatch === "digest") c.contentDigest = "b".repeat(64);
  if (mismatch === "incarnation") c.incarnation = crypto.randomUUID();
  const frame = room.frame(c, mismatch === "sequence" ? 0 : 1, mismatch === "epoch" ? crypto.randomUUID() : undefined);
  await expect(room.receive(frame)).rejects.toThrow(); expect(render.mock.calls.filter(([value]) => value)).toHaveLength(0);
});
it.each(renderCases)("a visibility change during a $kind content digest fences the pending render", async ({ makeCommand }) => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true);
  const real = crypto.subtle.digest.bind(crypto.subtle);
  let release!: (value: ArrayBuffer) => void;
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(real).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const c = makeCommand(); const receiving = room.receive(room.frame(c)); const rejected = expect(receiving).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeDefined()); runtime.hide();
  release(await real("SHA-256", new TextEncoder().encode(renderContentPayload(c.content)))); await rejected;
  expect(render).toHaveBeenLastCalledWith(null); spy.mockRestore();
});
it.each(renderCases)("expiry during a $kind content digest prevents rendering and acknowledgment", async ({ makeCommand }) => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true);
  const real = crypto.subtle.digest.bind(crypto.subtle);
  let release!: (value: ArrayBuffer) => void;
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(real).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  try {
    const c = makeCommand(); const receiving = room.receive(room.frame(c)); const rejected = expect(receiving).rejects.toThrow("expired_render");
    await vi.waitFor(() => expect(release).toBeDefined());
    await vi.advanceTimersByTimeAsync(c.expiresAt - Date.now());
    release(await real("SHA-256", new TextEncoder().encode(renderContentPayload(c.content)))); await rejected;
    await runtime.committed(c);
    expect(render.mock.calls.filter(([value]) => value)).toHaveLength(0);
    expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(0);
  } finally { spy.mockRestore(); }
});
it.each(renderCases)("retirement and sequence fences reject late $kind frames after clear and disconnect", async ({ makeCommand }) => {
  await runtime.start(connection()); await runtime.visibility(true); const c = makeCommand();
  await room.clear(c.actionId, 2);
  await expect(room.receive(room.frame(c, 1))).rejects.toThrow();
  await expect(room.receive(room.frame(c, 3))).rejects.toThrow();
  room.lost(); await expect(room.receive(room.frame(makeCommand(), 4))).rejects.toThrow();
  expect(room.close).toHaveBeenCalled(); await expect(runtime.start(connection())).rejects.toThrow();
});
it.each(["query", "placeId", "name", "address", "sourceUrl", "attributions"] as const)(
  "rejects changed place %s before rendering or acknowledging", async field => {
    const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
    await runtime.start(connection()); await runtime.visibility(true); const c = placesCommand();
    if (field === "query") c.content.query = "Another Library";
    else if (field === "attributions") c.content.attributions = ["Another information provider"];
    else c.content.items[0][field] = field === "sourceUrl" ? "https://maps.google.com/another-library"
      : field === "placeId" ? "changed-place-id" : "Changed value";
    await expect(room.receive(room.frame(c))).rejects.toThrow("digest_mismatch");
    expect(render.mock.calls.filter(([value]) => value)).toHaveLength(0);
    expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(0);
  });
it("acknowledges only the exact current place-card object once", async () => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); const c = placesCommand();
  await room.receive(room.frame(c)); const displayed: RenderCommand = render.mock.calls.at(-1)![0];
  expect(displayed).toEqual(c); expect(displayed).not.toBe(c);
  await runtime.committed(c); await runtime.committed({ ...displayed });
  expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(0);
  await runtime.committed(displayed); await runtime.committed(displayed);
  expect(room.messages().filter(m => m.control?.kind === "acknowledge").map(m => m.control)).toEqual([
    { kind: "acknowledge", actionId: c.actionId, turnId: c.turnId, generation: c.generation,
      channel: "visual.card", contentDigest: c.contentDigest },
  ]);
  const replacement = placesCommand(); await room.receive(room.frame(replacement, 2));
  await runtime.committed(displayed);
  expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(1);
  await runtime.committed(render.mock.calls.at(-1)![0]);
  expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(2);
});
it("display failure retires only the exact current place-card object without acknowledging it", async () => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); const c = placesCommand();
  await room.receive(room.frame(c)); const displayed: RenderCommand = render.mock.calls.at(-1)![0];
  const initialRenders = render.mock.calls.length;
  runtime.displayFailed(c); runtime.displayFailed({ ...displayed });
  expect(render).toHaveBeenCalledTimes(initialRenders); expect(render).toHaveBeenLastCalledWith(displayed);
  const replacement = placesCommand(); const frame = room.frame(replacement, 2); await room.receive(frame);
  const current: RenderCommand = render.mock.calls.at(-1)![0]; const replacementRenders = render.mock.calls.length;
  runtime.displayFailed(displayed); runtime.displayFailed({ ...current });
  expect(render).toHaveBeenCalledTimes(replacementRenders); expect(render).toHaveBeenLastCalledWith(current);
  runtime.displayFailed(current); expect(render).toHaveBeenLastCalledWith(null);
  await runtime.committed(current); await runtime.committed(displayed); await room.receive(frame);
  expect(render.mock.calls.filter(([value]) => value)).toHaveLength(2);
  expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(0);
  await expect(room.receive(room.frame(replacement, 3))).rejects.toThrow("ineligible_render");
  const next = placesCommand(); await room.receive(room.frame(next, 4));
  await runtime.committed(render.mock.calls.at(-1)![0]);
  expect(room.messages().filter(m => m.control?.kind === "acknowledge").map(m => m.control.actionId)).toEqual([next.actionId]);
});
it.each(["hide", "expiry", "clear"] as const)("%s removes a place card and fences its acknowledgment and retries", async transition => {
  const render = vi.fn(); runtime = new BrowserRuntime(surfaceId, render, vi.fn(), () => room);
  await runtime.start(connection()); await runtime.visibility(true); const c = placesCommand();
  const frame = room.frame(c); await room.receive(frame); const displayed: RenderCommand = render.mock.calls.at(-1)![0];
  if (transition === "hide") runtime.hide();
  else if (transition === "expiry") await vi.advanceTimersByTimeAsync(60000);
  else await room.clear(c.actionId, 2);
  expect(render).toHaveBeenLastCalledWith(null);
  await runtime.committed(displayed); await room.receive(frame);
  expect(render.mock.calls.filter(([value]) => value)).toHaveLength(1);
  expect(room.messages().filter(m => m.control?.kind === "acknowledge")).toHaveLength(0);
  if (transition === "hide") await runtime.visibility(true);
  await expect(room.receive(room.frame(c, 3))).rejects.toThrow();
  expect(render).toHaveBeenLastCalledWith(null);
});
it("bounds UTF-8 input without contacting transport", async () => {
  await runtime.input("é".repeat(2001)); expect(fetch).not.toHaveBeenCalled(); expect(room.invoke).not.toHaveBeenCalled();
});
