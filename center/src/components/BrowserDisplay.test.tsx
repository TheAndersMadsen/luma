// @vitest-environment-options {"url":"https://center.test"}
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/browserRoom", () => ({ createBrowserRoom: mocks.create }));
import { BrowserDisplay, CommittedCard } from "./BrowserDisplay";
import { BrowserRuntime } from "@/lib/browserRuntime";
import { BROWSER_SURFACE_POSTURE } from "@/lib/contracts/surfaces";
import type { ChoicesContent, PlacesContent, RenderCommand } from "@/lib/contracts/ambianceRuntime";
import { incarnation, roomConnection, TestRoom } from "@/lib/browserRoom.test-support";
import { Component, type ReactNode } from "react";
const actionId = "33333333-3333-3333-3333-333333333333";
const turnId = "44444444-4444-4444-4444-444444444444";
const text = "Public informational text <script>not executable</script>";
const digest = createHash("sha256").update(text).digest("hex");
const rawAttributions = [
  "Data &copy; contributors &lt;script&gt;placeExecuted()&lt;/script&gt;",
  'Credit: <a href="https://credits.example/source?one=1&amp;two=2">Map &amp; Data</a> &mdash; all contributors',
];
const places: PlacesContent = {
  kind: "places", query: "Café & Bakery",
  items: [
    { placeId: "place-one", name: 'Café <img src="https://assets.example/track" onerror="placeExecuted()">',
      address: "1 Main Street", sourceUrl: "https://www.google.com/maps/place/?q=cafe" },
    { placeId: "place-two", name: "Second café", address: "2 Other Street", sourceUrl: null },
  ],
  attributions: rawAttributions,
};
// The expected wire tuples are a fixture independent of the production serializer.
const canonicalPlaceItems = [
  ["place-one", 'Café <img src="https://assets.example/track" onerror="placeExecuted()">', "1 Main Street", "https://www.google.com/maps/place/?q=cafe"],
  ["place-two", "Second café", "2 Other Street", null],
];
function placeCommand({ empty = false, attributions = rawAttributions }: { empty?: boolean; attributions?: string[] } = {}): RenderCommand {
  return { ...command, content: { ...places, items: empty ? [] : places.items, attributions },
    contentDigest: createHash("sha256").update(JSON.stringify([
      "cosmos.place-address-card", 1, "Café & Bakery", empty ? [] : canonicalPlaceItems, attributions,
    ])).digest("hex") };
}
function expectPlacesCommitted(card: HTMLElement, empty: boolean) {
  const display = within(card);
  expect(display.getByRole("heading", { name: "Café & Bakery" })).toBeVisible();
  expect(card.textContent).toBe("Café & Bakery" + (empty ? "No matching places found."
    : 'Café <img src="https://assets.example/track" onerror="placeExecuted()">1 Main StreetView on Google MapsSecond café2 Other Street')
    + "Google MapsData © contributors <script>placeExecuted()</script>Credit: Map & Data — all contributors");
  expect(card.querySelector("footer")?.textContent).toBe(
    "Google MapsData © contributors <script>placeExecuted()</script>Credit: Map & Data — all contributors");
  expect(display.getByText("Google Maps", { exact: true })).toBeVisible();
  expect(display.getByText("Data © contributors <script>placeExecuted()</script>", { exact: true })).toBeVisible();
  const credit = display.getByRole("link", { name: "Map & Data" });
  expect(credit).toHaveAttribute("href", "https://credits.example/source?one=1&two=2");
  const source = display.queryByRole("link", { name: "View on Google Maps" });
  if (empty) {
    expect(display.getByText("No matching places found.")).toBeVisible();
    expect(display.queryByRole("list")).toBeNull(); expect(source).toBeNull();
  } else {
    expect(display.getAllByRole("listitem").map(item => item.dataset.placeId)).toEqual(["place-one", "place-two"]);
    expect(source).toHaveAttribute("href", "https://www.google.com/maps/place/?q=cafe");
  }
  expect(display.getAllByRole("link")).toHaveLength(empty ? 1 : 2);
  for (const link of display.getAllByRole("link")) {
    expect(link).toBeVisible(); expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener"); expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  }
}
let command: RenderCommand; let room: TestRoom;
let creditLayout: "fits" | "overflow" | "clipped";
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
const acknowledgments = () => room.messages().filter(m => m.control?.kind === "acknowledge");
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("innerWidth", 360); vi.stubGlobal("innerHeight", 640); creditLayout = "fits";
  // jsdom has no layout engine; model a small viewport with a separate credit footer.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "ARTICLE") return new DOMRect(16, 200, 328, 300);
    if (this.tagName === "FOOTER") return new DOMRect(32, 420, 296, 70);
    if (this.parentElement?.tagName === "FOOTER") {
      const index = Array.from(this.parentElement.children).indexOf(this);
      const top = creditLayout === "clipped" && index === 2 ? 485 : 424 + index * 22;
      return new DOMRect(32, top, 296, 20);
    }
    return new DOMRect(0, 0, 360, 640);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "FOOTER" ? 70 : this.tagName === "ARTICLE" ? 300 : 640;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "FOOTER" && creditLayout === "overflow" ? 4000 : this.clientHeight;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "FOOTER" ? 296 : this.tagName === "ARTICLE" ? 328 : 360;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return this.clientWidth; });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  room = new TestRoom(); mocks.create.mockReturnValue(room);
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body as string) : {};
    if (url === "/api/surfaces") {
      command = { version: 1, actionId, turnId, generation: 1, surfaceId: body.surfaceId, incarnation,
        channel: "visual.card", contentDigest: digest, content: { kind: "text", text }, privacy: "shared_room", expiresAt: Date.now() + 60000 };
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
      const card = screen.getByLabelText("Cosmos display");
      if (command.content.kind === "text") expect(card.textContent).toBe(text);
      else if (command.content.kind === "choices") expect(card.textContent).toBe("Which one?Café <b>One</b>Open until 22:00Second caféThirdClosed");
      else expectPlacesCommitted(card, command.content.items.length === 0);
      expect(body.control).toEqual({ kind: "acknowledge", actionId, turnId, generation: 1, channel: "visual.card", contentDigest: command.contentDigest });
      expect(body.stamp.instanceId).toBe(actionId);
    }
    return original(payload);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const choices: ChoicesContent = { kind: "choices", title: "Which one?", items: [
  { id: "1", title: "Café <b>One</b>", detail: "Open until 22:00" }, { id: "2", title: "Second café", detail: "" }, { id: "3", title: "Third", detail: "Closed" } ] };
function choiceCommand(): RenderCommand {
  return { ...command, content: choices, contentDigest: createHash("sha256").update(JSON.stringify([
    "cosmos.choice-list", 1, "Which one?", [["1", "Café <b>One</b>", "Open until 22:00"], ["2", "Second café", ""], ["3", "Third", "Closed"]],
  ])).digest("hex") };
}
async function approve(deliver = true) {
  expect(screen.queryByText(/public text/iu)).toBeNull();
  expect(screen.queryByText(/trust level/iu)).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "Show replies in this browser" }));
  expect(screen.getByText(/may be seen by other people/u)).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Turn on" })); });
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  if (deliver) { await act(async () => { await room.receive(room.frame(command)); }); await flush(); }
}
it("requires approval, escapes text and acknowledges only the committed exact DOM", async () => {
  render(<BrowserDisplay />); expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole("textbox")).toBeDisabled();
  await approve(); expect(screen.getByText(text)).toBeVisible(); expect(document.querySelector("script")).toBeNull();
  expect(acknowledgments()).toHaveLength(1);
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  expect(acknowledgments()).toHaveLength(1);
  expect(screen.getByRole("switch", { name: "Show replies in this browser" })).toBeChecked();
  fireEvent.click(screen.getByRole("switch", { name: "Show replies in this browser" }));
  expect(screen.queryByText(text)).toBeNull(); expect(screen.getByRole("textbox")).toBeDisabled();
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/leave"))).toBe(true));
});
it("shows a choice list as a numbered list whose numbers are the exact ids, and acknowledges only that DOM", async () => {
  render(<BrowserDisplay />); await approve(false); command = choiceCommand();
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  const card = screen.getByLabelText("Cosmos display");
  expect(within(card).getByRole("heading", { name: "Which one?" })).toBeVisible();
  expect(within(card).getAllByRole("listitem").map(item => item.getAttribute("value"))).toEqual(["1", "2", "3"]);
  expect(within(card).getByText("Café <b>One</b>")).toBeVisible(); expect(card.querySelector("b")).toBeNull();
  expect(acknowledgments()).toHaveLength(1);
  expect(screen.getByText("Shown in this browser")).toBeVisible();
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  expect(acknowledgments()).toHaveLength(1);
});
it("says where a turn went from status frames and answers each with a receipt", async () => {
  render(<BrowserDisplay />); await approve(false);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Shared question" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); }); await flush();
  expect(screen.getByText("Waiting for a device")).toBeVisible();
  expect(screen.getByText("Shared question")).toBeVisible();
  const cases: [Parameters<TestRoom["status"]>[0], string][] = [
    [{ turnId, state: "working" }, "Working"],
    [{ turnId, state: "shown", surface: { platform: "macos" } }, "Shown on your Mac"],
    [{ turnId, state: "spoken", surface: { platform: "android" } }, "Spoken on your phone"],
    [{ turnId, state: "shown", surface: { platform: "android" }, privacy: "private" }, "Private reply on your phone"],
    [{ turnId, state: "nowhere" }, "Nothing could show or say the reply. It was not sent again."],
    [{ turnId, state: "unknown" }, "Cannot confirm"],
  ];
  for (const [index, [status, expected]] of cases.entries()) {
    const receipt = JSON.parse(await act(() => room.status(status, index + 1)));
    expect(receipt.kind).toBe("received");
    expect(screen.getByText(expected)).toBeVisible();
  }
  await expect(room.status({ turnId, state: "shown", surface: { platform: "Mac OS" } }, 9)).rejects.toThrow("invalid_status");
  expect(screen.getByText("Cannot confirm")).toBeVisible();
  expect(acknowledgments()).toHaveLength(0);
});
it("commits all place results and decoded credit before acknowledging the independent Places proof", async () => {
  const executed = vi.fn(); const opened = vi.fn();
  vi.stubGlobal("placeExecuted", executed); vi.stubGlobal("open", opened);
  render(<BrowserDisplay />); expect(fetch).not.toHaveBeenCalled();
  await approve(false); command = placeCommand();
  const requests = vi.mocked(fetch).mock.calls.length;
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  const card = screen.getByLabelText("Cosmos display");
  expectPlacesCommitted(card, false); expect(acknowledgments()).toHaveLength(1);
  expect(card.querySelector("script, img, iframe, object, embed, video, audio, link, style")).toBeNull();
  expect(card.querySelector("[src], [srcset], [onerror], [onclick]")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(requests); expect(opened).not.toHaveBeenCalled(); expect(executed).not.toHaveBeenCalled();
  expect(screen.getByText("Shown in this browser")).toBeVisible();
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  expect(acknowledgments()).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(requests);
});
it("keeps Google Maps and provider credit on an acknowledged zero-result place card", async () => {
  render(<BrowserDisplay />); await approve(false); command = placeCommand({ empty: true });
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  expectPlacesCommitted(screen.getByLabelText("Cosmos display"), true);
  expect(acknowledgments()).toHaveLength(1);
});
it.each(["overflow", "clipped", "viewport"] as const)("removes a place card and withholds acknowledgment when required credit cannot fit: %s", async layout => {
  if (layout === "viewport") vi.stubGlobal("innerHeight", 450);
  else creditLayout = layout;
  render(<BrowserDisplay />); await approve(false);
  command = placeCommand(layout === "overflow" ? {
    attributions: Array.from({ length: 4 }, (_, index) => `Contributor ${index}: ${"required credit ".repeat(110)}`),
  } : {});
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  expect(screen.queryByLabelText("Cosmos display")).toBeNull();
  expect(acknowledgments()).toHaveLength(0);
  expect(screen.getByText("The place card could not fit its required attribution on this display.")).toBeVisible();
  expect(screen.queryByText("Shown in this browser")).toBeNull();
  await act(async () => { await room.receive(room.frame(command)); });
  expect(screen.queryByLabelText("Cosmos display")).toBeNull(); expect(acknowledgments()).toHaveLength(0);
  await expect(room.receive(room.frame(command, 2))).rejects.toThrow("ineligible_render");
});
it.each(["resize", "scroll"] as const)("%s rechecks required credit and fences an acknowledgment still in flight", async event => {
  const original = room.invoke.getMockImplementation()!; let release!: (value: string) => void;
  room.invoke.mockImplementation(payload => {
    if (JSON.parse(payload).control?.kind !== "acknowledge") return original(payload);
    expectPlacesCommitted(screen.getByLabelText("Cosmos display"), false);
    return new Promise(resolve => { release = resolve; });
  });
  render(<BrowserDisplay />); await approve(false); command = placeCommand();
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  expectPlacesCommitted(screen.getByLabelText("Cosmos display"), false);
  if (event === "resize") vi.stubGlobal("innerHeight", 450);
  else creditLayout = "clipped";
  fireEvent(window, new Event(event));
  expect(screen.queryByLabelText("Cosmos display")).toBeNull();
  expect(screen.getByText("The place card could not fit its required attribution on this display.")).toBeVisible();
  release(JSON.stringify({ version: 1, kind: "accepted", duplicate: false })); await flush();
  expect(screen.queryByText("Shown in this browser")).toBeNull();
  expect(screen.queryByLabelText("Cosmos display")).toBeNull();
});
it.each([
  '<img src="https://assets.example/track" onerror="placeExecuted()">',
  "<script>placeExecuted()</script>",
  "<b>Required contributor</b>",
  '<a href="https://credits.example" onclick="placeExecuted()">Contributor</a>',
  '<a href="javascript:placeExecuted()">Contributor</a>',
  '<a href="https://credits.example">Unclosed contributor',
  "Contributor &unsupported;",
])("rejects unsupported or malformed place attribution before display or acknowledgment: %s", async attribution => {
  render(<BrowserDisplay />); await approve(false);
  command = placeCommand({ attributions: [attribution] });
  const requests = vi.mocked(fetch).mock.calls.length;
  await expect(room.receive(room.frame(command))).rejects.toThrow("invalid_place_attribution");
  expect(screen.queryByLabelText("Cosmos display")).toBeNull();
  expect(acknowledgments()).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(requests);
});
it("binds raw attribution bytes even when a changed entity would display the same credit", async () => {
  render(<BrowserDisplay />); await approve(false); command = placeCommand();
  const changed = { ...command, content: { ...places, attributions: [rawAttributions[0].replace("&copy;", "&#169;"), rawAttributions[1]] } };
  await expect(room.receive(room.frame(changed))).rejects.toThrow("digest_mismatch");
  expect(screen.queryByLabelText("Cosmos display")).toBeNull(); expect(acknowledgments()).toHaveLength(0);
});
it.each(["hide", "expiry", "clear"] as const)("%s removes place results and all credit without allowing a retry to revive them", async transition => {
  render(<BrowserDisplay />); await approve(false); command = placeCommand();
  // Approval polls with real timers; fake them only once the expiring frame is about to arrive.
  vi.useFakeTimers();
  await act(async () => { await room.receive(room.frame(command)); await vi.advanceTimersByTimeAsync(20); });
  expectPlacesCommitted(screen.getByLabelText("Cosmos display"), false); expect(acknowledgments()).toHaveLength(1);
  if (transition === "hide") {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
  } else if (transition === "expiry") {
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  } else {
    await act(async () => { await room.clear(actionId); });
  }
  expect(screen.queryByLabelText("Cosmos display")).toBeNull();
  expect(screen.queryByText("Google Maps", { exact: true })).toBeNull();
  expect(screen.queryByRole("link", { name: "Map & Data" })).toBeNull();
  await act(async () => { await room.receive(room.frame(command)); });
  expect(screen.queryByLabelText("Cosmos display")).toBeNull(); expect(acknowledgments()).toHaveLength(1);
  await expect(room.receive(room.frame(command, 3))).rejects.toThrow("ineligible_render");
});
it("hiding a place card fences a pending acknowledgment and removes every credit immediately", async () => {
  const original = room.invoke.getMockImplementation()!; let release!: (value: string) => void;
  room.invoke.mockImplementation(payload => JSON.parse(payload).control?.kind === "acknowledge"
    ? new Promise(resolve => { release = resolve; }) : original(payload));
  render(<BrowserDisplay />); await approve(false); command = placeCommand();
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  expectPlacesCommitted(screen.getByLabelText("Cosmos display"), false);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.queryByLabelText("Cosmos display")).toBeNull();
  release(JSON.stringify({ version: 1, kind: "accepted", duplicate: false })); await flush();
  expect(screen.queryByText("Shown in this browser")).toBeNull();
  expect(screen.queryByRole("link", { name: "Map & Data" })).toBeNull();
});
it("hide clears immediately and fences a late acknowledgment", async () => {
  const original = room.invoke.getMockImplementation()!; let release!: (value: string) => void;
  room.invoke.mockImplementation(payload => JSON.parse(payload).control?.kind === "acknowledge"
    ? new Promise(resolve => { release = resolve; }) : original(payload));
  render(<BrowserDisplay />); await approve(); expect(screen.getByText(text)).toBeVisible();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange")); expect(screen.queryByText(text)).toBeNull();
  release(JSON.stringify({ version: 1, kind: "accepted", duplicate: false })); await flush();
  expect(screen.queryByText("Shown in this browser")).toBeNull();
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
    channel: "visual.card", contentDigest: digest, content: { kind: "text", text }, privacy: "shared_room", expiresAt: Date.now() + 60000 };
  render(<Boundary><CommittedCard command={frame} runtime={runtime} /><Failure /></Boundary>);
  expect(committed).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); log.mockRestore();
});
it.each([
  { label: "unchanged list", mutate: (_card: HTMLElement) => {}, acknowledged: true },
  { label: "renumbered choice", mutate: (card: HTMLElement) => { card.querySelector("li")!.setAttribute("value", "3"); }, acknowledged: false },
  { label: "altered choice title", mutate: (card: HTMLElement) => { card.querySelector("li strong")!.textContent = "Other"; }, acknowledged: false },
  { label: "dropped choice detail", mutate: (card: HTMLElement) => { card.querySelector("li p")!.remove(); }, acknowledged: false },
])("checks the actual committed choice DOM: $label", ({ mutate, acknowledged }) => {
  const runtime = new BrowserRuntime(turnId, vi.fn(), vi.fn());
  const committed = vi.spyOn(runtime, "committed").mockResolvedValue(undefined);
  const frame: RenderCommand = { ...choiceCommand(), version: 1, actionId, turnId, generation: 1, surfaceId: turnId,
    incarnation, channel: "visual.card", privacy: "shared_room", expiresAt: Date.now() + 60000 };
  render(<div><span aria-hidden="true" ref={node => { if (node) mutate(node.parentElement!.querySelector<HTMLElement>("article")!); }} />
    <CommittedCard command={frame} runtime={runtime} /></div>);
  if (acknowledged) expect(committed).toHaveBeenCalledExactlyOnceWith(frame);
  else { expect(committed).not.toHaveBeenCalled(); expect(screen.queryByLabelText("Cosmos display")).toBeNull(); }
});
it.each([
  { label: "unchanged card", mutate: (_card: HTMLElement) => {}, acknowledged: true },
  { label: "missing Google Maps credit", mutate: (card: HTMLElement) => { card.querySelector("footer p")!.remove(); }, acknowledged: false },
  { label: "altered contributor text", mutate: (card: HTMLElement) => { card.querySelectorAll("footer p")[1].textContent = "Partial credit"; }, acknowledged: false },
  { label: "altered attribution destination", mutate: (card: HTMLElement) => { card.querySelector("footer a")!.setAttribute("href", "https://other.example/"); }, acknowledged: false },
  { label: "altered source destination", mutate: (card: HTMLElement) => { card.querySelector("li a")!.setAttribute("href", "https://www.google.com/maps/place/?q=other"); }, acknowledged: false },
])("checks the actual committed Places DOM: $label", ({ mutate, acknowledged }) => {
  const runtime = new BrowserRuntime(turnId, vi.fn(), vi.fn());
  const committed = vi.spyOn(runtime, "committed").mockResolvedValue(undefined);
  const frame: RenderCommand = { ...placeCommand(), version: 1, actionId, turnId, generation: 1, surfaceId: turnId,
    incarnation, channel: "visual.card", privacy: "shared_room", expiresAt: Date.now() + 60000 };
  let visited = false;
  render(<div><span aria-hidden="true" ref={node => {
    if (!node) return;
    // Earlier sibling refs run after DOM insertion and before the card's layout effect.
    const card = node.parentElement!.querySelector<HTMLElement>("article");
    expect(card).not.toBeNull(); visited = true; mutate(card!);
  }} /><CommittedCard command={frame} runtime={runtime} /></div>);
  expect(visited).toBe(true);
  if (acknowledged) expect(committed).toHaveBeenCalledExactlyOnceWith(frame);
  else {
    expect(committed).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Cosmos display")).toBeNull();
  }
  expect(fetch).not.toHaveBeenCalled();
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
  expect(screen.getByText("Shown in this browser")).toBeVisible();
});
it("failed acknowledgment clears output and claims no completion", async () => {
  const original = room.invoke.getMockImplementation()!;
  room.invoke.mockImplementation(payload => JSON.parse(payload).control?.kind === "acknowledge"
    ? Promise.resolve(JSON.stringify({ version: 1, kind: "accepted", duplicate: false, guessed: true })) : original(payload));
  render(<BrowserDisplay />); await approve(); expect(screen.queryByText(text)).toBeNull();
  expect(screen.getByText("This browser could not confirm it showed the reply.")).toBeVisible();
});

const requests = () => room.messages().filter(message => message.kind === "input").map(message => message.text as string);

it("acknowledges a sent line at once, blocks a second send until Cosmos answers, and offers Cancel task only while the turn is open", async () => {
  render(<BrowserDisplay />); await approve(false);
  expect(screen.getByRole("heading", { name: "Ask anything" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull();
  const original = room.invoke.getMockImplementation()!;
  let release!: (value: string) => void;
  room.invoke.mockImplementation(payload => JSON.parse(payload).kind === "input"
    ? new Promise<string>(resolve => { release = value => resolve(value); }) : original(payload));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: " Shared question " } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
  // The line is on screen before Cosmos has said anything about it.
  expect(screen.getByText("Now")).toBeVisible();
  expect(screen.getByText("Shared question")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Ask anything" })).toBeNull();
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(screen.getByRole("textbox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByText("Working")).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel task" })).toBeVisible();
  expect(requests()).toEqual(["Shared question"]);
  const stamp = room.messages().find(message => message.kind === "input")!.stamp;
  release(JSON.stringify({ version: 1, kind: "admitted", duplicate: false, turnId: stamp.instanceId, generation: 1 }));
  await flush();
  room.invoke.mockImplementation(original);
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  expect(screen.getByText("Waiting for a device")).toBeVisible();
  await act(() => room.status({ turnId: stamp.instanceId, state: "shown", surface: { platform: "macos" } }, 1));
  expect(screen.getByText("Completed")).toBeVisible();
  expect(screen.getByText("Shown on your Mac")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull();
});

it("offers prompts that work today and sends one with a single click", async () => {
  render(<BrowserDisplay />); await approve(false);
  expect(screen.getByRole("button", { name: "Find cafés near me" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Show my notes about the kitchen" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "What is the weather today?" })).toBeEnabled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Find cafés near me" })); }); await flush();
  expect(requests()).toEqual(["Find cafés near me"]);
  expect(screen.getByText("Find cafés near me")).toBeVisible();
});

it("answers a choice list by click, by digit and with the arrow keys, sending the item's exact title", async () => {
  render(<BrowserDisplay />); await approve(false); command = choiceCommand();
  await act(async () => { await room.receive(room.frame(command)); }); await flush();
  const card = screen.getByLabelText("Cosmos display");
  const options = within(card).getAllByRole("button");
  expect(options.map(option => option.textContent)).toEqual(["Café <b>One</b>Open until 22:00", "Second café", "ThirdClosed"]);
  await act(async () => { fireEvent.click(options[1]); }); await flush();
  expect(requests()).toEqual(["Second café"]);
  // Arrow keys walk the list without picking anything.
  options[0].focus();
  fireEvent.keyDown(within(card).getByRole("list"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(options[1]);
  expect(requests()).toEqual(["Second café"]);
  // A digit typed into an empty prompt picks the item with that number.
  await act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "3" }); }); await flush();
  expect(requests()).toEqual(["Second café", "Third"]);
  // A digit typed while writing is just a digit.
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "2" } });
  await act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "1" }); }); await flush();
  expect(requests()).toEqual(["Second café", "Third"]);
});

it("says the tab must be in front while replies are on but this tab is behind another", async () => {
  render(<BrowserDisplay />); await approve(false);
  expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Ask Cosmos…");
  expect(screen.getByText("Replies appear here or on the device that suits them best.")).toBeVisible();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { fireEvent(document, new Event("visibilitychange")); }); await flush();
  await waitFor(() => expect(screen.getByText("On, but this tab is in the background. Bring it to the front to show replies.")).toBeVisible());
  // The display is on. Saying "turn it on" or "waiting for the connection"
  // sends the owner looking for a switch that is already on.
  expect(screen.getByRole("switch", { name: "Show replies in this browser" })).toBeChecked();
  expect(screen.getByText("Replies are on in this browser. Bring this tab to the front to ask from it.")).toBeVisible();
  expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Bring this tab to the front to ask…");
  expect(screen.queryByText("Turn on replies in this browser to ask Cosmos from this tab.")).toBeNull();
  expect(screen.queryByPlaceholderText("Waiting for the connection…")).toBeNull();
  // Bringing it back is the one thing to do, and it is enough.
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { fireEvent(document, new Event("visibilitychange")); }); await flush();
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Ask Cosmos…");
});
