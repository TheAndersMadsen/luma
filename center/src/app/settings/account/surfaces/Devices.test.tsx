import { createHash, webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { legacySpeechPosture, NATIVE_APPROVAL, nativePosture, type NativeDescriptor, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import { Devices } from "./Devices";
import { fingerprintLines } from "./fingerprint";

// The SEC1 encoding of the P-256 generator is a real curve point. Key import
// and the displayed digest exercise WebCrypto rather than a permissive mock.
const publicKeyBytes = Buffer.from("046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", "hex");
const fingerprint = createHash("sha256").update(publicKeyBytes).digest("hex");
const descriptor: NativeDescriptor = {
  enrollmentId: "11111111-1111-1111-1111-111111111111", publicKey: publicKeyBytes.toString("base64url"),
  platform: "android_tv", approval: NATIVE_APPROVAL,
};
const serialized = JSON.stringify(descriptor);
const first: NativeSurface = { ...nativePosture("android_tv"), surfaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  enrollmentId: descriptor.enrollmentId, platform: descriptor.platform, revision: 1, publicKeyFingerprint: fingerprint, revoked: false,
  display: true, speech: true, actions: ["action.play"], confirms: false, connected: false, visible: false, privateDisplay: false };
const second: NativeSurface = { ...first, ...nativePosture("linux"), surfaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  enrollmentId: "22222222-2222-2222-2222-222222222222", platform: "linux", revision: 7, actions: ["action.open"], confirms: true };
const path = "/api/surfaces/native";
const approved = "Approved. Cosmos shows replies on this device while its app is in front.";
const removed = "Removed. This device no longer shows replies.";
const empty = "No phones, TVs or computers yet";
const firstCard = "TV";
const secondCard = "Linux PC";
const PERMISSION = /^\/api\/surfaces\/([0-9a-f-]{36})\/(speech-disclosure|private-display|screen-context|web-lookup|places-lookup|device-actions|device-commands)$/u;

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Answer = (surfaceId: string, kind: string) => unknown;
/** Cosmos as the page sees it: the device list, one enrollment lookup, the Services gate and each device's permissions. */
function upstream(rows: NativeSurface[] = [], existing: NativeSurface | null = null, answer: Answer = () => undefined) {
  const revisions = new Map(rows.map(row => [row.surfaceId, row.revision]));
  const mock = Object.assign(vi.fn(async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const target = String(url);
    if (options?.method) throw new Error("Unexpected mutation");
    if (target === path) return Response.json({ native: rows });
    if (target === `${path}/enrollments/${descriptor.enrollmentId}`) return existing ? Response.json({ native: existing }) : new Response(null, { status: 404 });
    if (target === "/api/admin/integrations") return Response.json({ error: "Operator access required." }, { status: 403 });
    // This account has no Pin; PinCard.test.tsx owns the Pin's own states.
    if (target === "/api/devices/runtime") return Response.json({ pins: [] });
    if (target === "/api/devices/pair") return Response.json({ devices: [] });
    const permission = PERMISSION.exec(target);
    if (!permission) throw new Error(`Unexpected request: ${url}`);
    const custom = answer(permission[1], permission[2]);
    if (custom !== undefined) return Response.json(custom);
    return Response.json(permission[2].endsWith("lookup")
      ? { approval: null, providers: [], binding: { approvalRevision: revisions.get(permission[1]) ?? 1, incarnation: null } }
      : { approval: null });
  }), { revisions });
  vi.stubGlobal("fetch", mock);
  return mock;
}
type Upstream = ReturnType<typeof upstream>;
const calls = (mock: Upstream, target: string | RegExp) => mock.mock.calls.filter(([url]) => typeof target === "string" ? String(url) === target : target.test(String(url)));
const mutations = (mock: Upstream) => mock.mock.calls.filter(([, options]) => options?.method);
async function ready() {
  await waitFor(() => {
    expect(screen.queryByText("Checking devices…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh devices" })).toBeEnabled();
  });
}
function openAdd() {
  fireEvent.click(screen.getByRole("button", { name: "Add a device" }));
  fireEvent.click(screen.getByRole("button", { name: "Enter the device details by hand" }));
}
function paste(text = serialized) {
  fireEvent.change(screen.getByLabelText("Public installation descriptor"), { target: { value: text } });
}
async function review(text = serialized) {
  paste(text);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  return screen.findByRole("group", { name: "Review device" });
}
function approve() { fireEvent.click(screen.getByRole("button", { name: "Approve this device" })); }
const card = (name: string) => within(screen.getByRole("region", { name }));
async function openRemove(name: string) {
  const view = card(name);
  fireEvent.click(view.getByRole("button", { name: "Manage" }));
  fireEvent.click(view.getByRole("button", { name: "Details" }));
  fireEvent.click(view.getByRole("button", { name: "Remove this device" }));
  return view;
}
function expectLocked() {
  const field = screen.queryByLabelText("Public installation descriptor");
  if (field) {
    expect(field).toBeDisabled();
    expect(screen.getByLabelText("Import installation descriptor")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
  }
  expect(screen.queryByRole("button", { name: "Approve this device" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: firstCard })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: secondCard })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove this device" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  expect(screen.queryByText(approved)).not.toBeInTheDocument();
  expect(screen.queryByText(removed)).not.toBeInTheDocument();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
function descriptorFile(text: string, read = vi.fn(async () => text)) {
  const file = new File([text], "installation.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: read });
  return { file, read };
}
function importFile(file: File) {
  fireEvent.change(screen.getByLabelText("Import installation descriptor"), { target: { files: [file] } });
}

it("shows this browser and a calm empty state, then requires review and a separate owner confirmation of the key", async () => {
  const mock = upstream(); render(<Devices />); await ready();
  expect(calls(mock, path)[0][1]?.cache).toBe("no-store");
  expect(screen.getByText("Cosmos answers on the devices you approve here.")).toBeVisible();
  expect(screen.getByRole("region", { name: "This browser" })).toBeVisible();
  expect(within(screen.getByRole("region", { name: "Ai Pin" })).getByText("No Pin is paired with this account yet.")).toBeVisible();
  expect(screen.getByText(empty)).toBeVisible();
  expect(screen.queryByLabelText("Public installation descriptor")).not.toBeInTheDocument();
  openAdd();
  expect(screen.getByText(/open Cosmos and choose/u)).toBeVisible();
  expect(screen.getByText(/scan its QR code with your phone/u)).toBeVisible();
  paste();
  expect(calls(mock, /\/enrollments\//)).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Approve this device" })).not.toBeInTheDocument();
  const inspected = within(await review());
  expect(inspected.getByRole("heading", { name: "TV" })).toBeVisible();
  for (const line of fingerprintLines(fingerprint)) expect(inspected.getByText(line)).toBeVisible();
  expect(inspected.getByText("Compare with the fingerprint shown on the device.")).toBeVisible();
  expect(inspected.getByText("This device is waiting for your approval.")).toBeVisible();
  expect(inspected.queryByText(descriptor.enrollmentId)).not.toBeInTheDocument();
  expect(calls(mock, `${path}/enrollments/${descriptor.enrollmentId}`)).toHaveLength(1);
  expect(mutations(mock)).toHaveLength(0);
  fireEvent.click(inspected.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Review device" })).not.toBeInTheDocument();
  expect(mutations(mock)).toHaveLength(0);
  await review();
  mock.mockResolvedValueOnce(Response.json({ native: first })); approve();
  await screen.findByText(approved);
  const [url, options] = mutations(mock)[0];
  expect(url).toBe(path); expect(options?.method).toBe("POST");
  expect(options?.cache).toBe("no-store");
  expect(options?.headers).toEqual({ "content-type": "application/json" });
  expect(JSON.parse(String(options?.body))).toEqual({ ...descriptor, expectedRevision: 0 });
  expect(screen.queryByLabelText("Public installation descriptor")).not.toBeInTheDocument();
  expect(screen.queryByText(empty)).not.toBeInTheDocument();
  const tv = card(firstCard);
  expect(tv.getByRole("heading", { name: "TV" })).toBeVisible();
  expect(tv.getByText("Offline")).toBeVisible();
  expect(tv.getByRole("group", { name: "Set up the usual permissions" })).toBeVisible();
  expect(tv.getByRole("switch", { name: "Speak replies" })).toBeInTheDocument();
  expect(tv.getByRole("switch", { name: "Look things up on the web" })).toBeInTheDocument();
  expect(tv.getByRole("switch", { name: "Find places" })).toBeInTheDocument();
  expect(tv.queryByRole("switch", { name: "Show private replies here" })).not.toBeInTheDocument();
  expect(tv.queryByRole("switch", { name: "Use what's on the screen" })).not.toBeInTheDocument();
  expect(tv.queryByText(descriptor.enrollmentId)).not.toBeInTheDocument();
  expect(tv.queryByText(fingerprint)).not.toBeInTheDocument();
  await waitFor(() => expect(calls(mock, /\/(?:web|places)-lookup$/)).toHaveLength(2));
  expect(calls(mock, /\/private-display$/)).toHaveLength(0);
  expect(calls(mock, /\/screen-context$/)).toHaveLength(0);
  expect(mutations(mock)).toHaveLength(1);
});

it("shows each device as a plain card: status words from the runtime, capabilities from recorded permissions, no identifiers", async () => {
  const phone: NativeSurface = { ...first, ...nativePosture("android"), surfaceId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    enrollmentId: "33333333-3333-3333-3333-333333333333", platform: "android", actions: ["action.open", "action.route"], confirms: true,
    connected: true, visible: true, privateDisplay: true };
  const rows = [phone, { ...second, connected: true, visible: false }, first];
  const searx = { provider: "searxng", endpoint: "https://search.example.test/search", configurationDigest: "a".repeat(64) };
  const mock = upstream(rows, null, (surfaceId, kind) => {
    if (surfaceId !== phone.surfaceId) return undefined;
    if (kind === "speech-disclosure") return { approval: { approvalRevision: 1, revision: 2, policy: { provider: { provider: "azure_speech", region: "westeurope" }, maximumClass: "shared_room", transcription: false, synthesis: true } } };
    if (kind === "web-lookup") return { approval: { approvalRevision: 1, revision: 1, policy: { provider: searx, maximumClass: "shared_room" } }, providers: [searx], binding: { approvalRevision: 1, incarnation: null } };
    if (kind === "private-display") return { approval: { approvalRevision: 1, revision: 1, policy: { maximumClass: "private" } } };
    return undefined;
  });
  render(<Devices />); await ready();
  const phoneCard = card("Phone");
  expect(phoneCard.getByText("Connected")).toBeVisible();
  await phoneCard.findByText("Shows shared replies · Speaks replies · Looks things up · Shows private replies");
  expect(card(secondCard).getByText("Connected · in the background")).toBeVisible();
  expect(card(firstCard).getByText("Offline")).toBeVisible();
  await card(firstCard).findByText("Shows shared replies");
  for (const row of rows) {
    expect(screen.queryByText(row.enrollmentId)).not.toBeInTheDocument();
    expect(screen.queryByText(row.publicKeyFingerprint)).not.toBeInTheDocument();
    expect(screen.queryByText(row.surfaceId)).not.toBeInTheDocument();
  }
  expect(screen.queryByText(/revision/iu)).not.toBeInTheDocument();
  expect(screen.queryByText(/trust/iu)).not.toBeInTheDocument();
  expect(screen.queryByText(/Only you can see this/u)).not.toBeInTheDocument();
  expect(mutations(mock)).toHaveLength(0);
});

it("editing a reviewed descriptor removes its approval gesture until the new descriptor is reviewed", async () => {
  const mock = upstream(); render(<Devices />); await ready(); openAdd(); await review();
  paste(JSON.stringify({ ...descriptor, platform: "macos" }));
  expect(screen.queryByRole("group", { name: "Review device" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approve this device" })).not.toBeInTheDocument();
  expect(mutations(mock)).toHaveLength(0);
});

it.each([
  ["unknown fields", JSON.stringify({ ...descriptor, privateKey: "must-never-be-sent" })],
  ["missing fields", JSON.stringify({ enrollmentId: descriptor.enrollmentId, publicKey: descriptor.publicKey, platform: descriptor.platform })],
  ["different permission", JSON.stringify({ ...descriptor, approval: "native-private-voice" })],
  ["unsupported platform", JSON.stringify({ ...descriptor, platform: "shield" })],
  ["nil enrollment", JSON.stringify({ ...descriptor, enrollmentId: "00000000-0000-0000-0000-000000000000" })],
  ["point off the curve", JSON.stringify({ ...descriptor, publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url") })],
  ["over 1 KB", serialized.padEnd(1025, " ")],
])("rejects pasted descriptors with %s before any lookup or approval", async (_name, text) => {
  const mock = upstream(); render(<Devices />); await ready(); openAdd(); paste(text);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByRole("alert");
  expect(calls(mock, /\/enrollments\//)).toHaveLength(0);
  expect(mutations(mock)).toHaveLength(0);
  expect(screen.queryByRole("group", { name: "Review device" })).not.toBeInTheDocument();
});

it("imports a descriptor of exactly 1 KB locally, then requires lookup and explicit approval", async () => {
  const mock = upstream(); render(<Devices />); await ready(); openAdd();
  const text = serialized.padEnd(1024, " ");
  const { file, read } = descriptorFile(text); importFile(file);
  await waitFor(() => expect(screen.getByLabelText("Public installation descriptor")).toHaveValue(text));
  expect(read).toHaveBeenCalledTimes(1);
  expect(calls(mock, /\/enrollments\//)).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Approve this device" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByRole("button", { name: "Approve this device" });
  expect(mutations(mock)).toHaveLength(0);
});

it("rejects oversized files without reading them and rejects extra fields in imported JSON", async () => {
  const mock = upstream(); render(<Devices />); await ready(); openAdd();
  const oversized = descriptorFile(serialized.padEnd(1025, " ")); importFile(oversized.file);
  await screen.findByText("The public installation descriptor must be at most 1 KB.");
  expect(oversized.read).not.toHaveBeenCalled();
  const invalid = descriptorFile(JSON.stringify({ ...descriptor, authority: "private" })); importFile(invalid.file);
  await screen.findByText(/Use a valid public installation descriptor containing only/);
  expect(screen.getByLabelText("Public installation descriptor")).toHaveValue("");
  expect(calls(mock, /\/enrollments\//)).toHaveLength(0);
});

it("reapproval uses the fresh revoked lookup revision, while an active matching device cannot be approved again", async () => {
  const existing = { ...first, revision: 8, revoked: true };
  const mock = upstream([], existing); render(<Devices />); await ready(); openAdd(); await review();
  expect(screen.getByText(/You removed this device earlier/u)).toBeVisible();
  mock.revisions.set(first.surfaceId, 9);
  mock.mockResolvedValueOnce(Response.json({ native: { ...first, revision: 9 } })); approve();
  await screen.findByText(approved);
  expect(JSON.parse(String(mutations(mock)[0][1]?.body)).expectedRevision).toBe(8);
  openAdd();
  mock.mockResolvedValueOnce(Response.json({ native: { ...first, revision: 9 } })); await review();
  expect(screen.getByText("This device is already approved.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Approve this device" })).not.toBeInTheDocument();
  expect(mutations(mock)).toHaveLength(1);
});

it.each(["conflict", "lost response"])("a %s locks every mutation until a fresh read and lookup supply current revisions", async cause => {
  const mock = upstream([second]); render(<Devices />); await ready(); openAdd(); await review();
  if (cause === "conflict") mock.mockResolvedValueOnce(new Response(null, { status: 409 }));
  else mock.mockRejectedValueOnce(new Error("response lost after commit"));
  approve(); await screen.findByRole("alert"); expectLocked();
  const pendingRead = deferred<Response>(); mock.mockReturnValueOnce(pendingRead.promise);
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" })); expectLocked();
  await act(async () => { pendingRead.resolve(Response.json({ native: [second] })); }); await ready();
  mock.mockResolvedValueOnce(Response.json({ native: { ...first, revision: 6, revoked: true } })); await review();
  mock.mockResolvedValueOnce(Response.json({ native: { ...first, revision: 7 } })); approve();
  await screen.findByText(approved);
  expect(JSON.parse(String(mutations(mock).at(-1)?.[1]?.body)).expectedRevision).toBe(6);
});

it("removes a device only after confirmation and sends its exact row revision", async () => {
  const mock = upstream([first, second]); render(<Devices />); await ready();
  const view = await openRemove(secondCard);
  expect(view.getByRole("group", { name: "Remove this device?" })).toBeVisible();
  expect(mutations(mock)).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Keep" }));
  expect(view.queryByRole("group", { name: "Remove this device?" })).not.toBeInTheDocument();
  expect(mutations(mock)).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Remove this device" }));
  mock.mockResolvedValueOnce(Response.json({ native: { ...second, revision: 8, revoked: true } }));
  fireEvent.click(view.getByRole("button", { name: "Remove" }));
  await screen.findByText(removed);
  const [url, options] = mutations(mock)[0];
  expect(url).toBe(`${path}/${second.surfaceId}`); expect(options?.method).toBe("DELETE");
  expect(JSON.parse(String(options?.body))).toEqual({ expectedRevision: 7 });
  expect(screen.getByRole("region", { name: firstCard })).toBeVisible();
  expect(screen.queryByRole("region", { name: secondCard })).not.toBeInTheDocument();
});

it.each([
  ["enrollment", { ...first, enrollmentId: second.enrollmentId }],
  ["platform", { ...first, platform: "macos" }],
  ["fingerprint", { ...first, publicKeyFingerprint: "0".repeat(64) }],
  ["revision", { ...first, revision: 2 }],
  ["revocation", { ...first, revoked: true }],
  ["permission posture", { ...first, trustLevel: 1 }],
  ["duplicate surface identity", { ...first, surfaceId: second.surfaceId }],
])("does not accept a successful approval response with mismatched %s", async (_field, native) => {
  const mock = upstream([second]); render(<Devices />); await ready(); openAdd(); await review();
  mock.mockResolvedValueOnce(Response.json({ native })); approve();
  await screen.findByRole("alert"); expectLocked();
});

it("does not accept a removal committed for another device or at a stale revision", async () => {
  for (const native of [{ ...first, surfaceId: second.surfaceId, revision: 2, revoked: true }, { ...first, revoked: true }]) {
    const mock = upstream([first]); const view = render(<Devices />); await ready();
    const tv = await openRemove(firstCard);
    mock.mockResolvedValueOnce(Response.json({ native }));
    fireEvent.click(tv.getByRole("button", { name: "Remove" }));
    await screen.findByRole("alert"); expectLocked(); view.unmount();
  }
});

it("fences double confirmation while the mutation is pending without claiming optimistic approval", async () => {
  const mock = upstream(); render(<Devices />); await ready(); openAdd(); await review();
  const pending = deferred<Response>(); mock.mockReturnValueOnce(pending.promise);
  const button = screen.getByRole("button", { name: "Approve this device" });
  fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(mutations(mock)).toHaveLength(1);
  expect(screen.getByText(empty)).toBeVisible();
  expect(screen.queryByText(approved)).not.toBeInTheDocument();
  await act(async () => { pending.resolve(Response.json({ native: first })); });
  await screen.findByText(approved);
});

const lifecycleCases = (["list", "lookup", "approval", "revoke"] as const).flatMap(phase =>
  (["unmount", "pagehide", "hidden", "focus"] as const).map(cause => ({ phase, cause })));
it.each(lifecycleCases)("a late $phase reply after $cause cannot restore owner inventory or approval", async ({ phase, cause }) => {
  const mock = upstream([first]);
  const pending = deferred<Response>();
  if (phase === "list") mock.mockReturnValueOnce(pending.promise);
  const view = render(<Devices />);
  let signal: AbortSignal | null | undefined;
  if (phase === "list") signal = calls(mock, path)[0][1]?.signal;
  else {
    await ready();
    if (phase === "lookup") {
      openAdd(); mock.mockReturnValueOnce(pending.promise); paste();
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      await waitFor(() => expect(calls(mock, /\/enrollments\//)).toHaveLength(1));
      signal = calls(mock, /\/enrollments\//)[0][1]?.signal;
    } else if (phase === "approval") {
      openAdd(); await review(); mock.mockReturnValueOnce(pending.promise); approve();
      signal = mutations(mock)[0][1]?.signal;
    } else {
      const tv = await openRemove(firstCard);
      mock.mockReturnValueOnce(pending.promise);
      fireEvent.click(tv.getByRole("button", { name: "Remove" }));
      signal = mutations(mock)[0][1]?.signal;
    }
  }
  const fresh = deferred<Response>(); mock.mockReturnValueOnce(fresh.promise);
  if (cause === "unmount") { view.unmount(); render(<Devices />); }
  if (cause === "pagehide") fireEvent(window, new Event("pagehide"));
  if (cause === "hidden") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
  }
  if (cause === "focus") fireEvent(window, new Event("focus"));
  expect(signal?.aborted).toBe(true);
  expectLocked();
  const native = phase === "list" ? [first] : phase === "revoke" ? { ...first, revision: 2, revoked: true } : first;
  await act(async () => { pending.resolve(Response.json({ native })); });
  expectLocked();
  if (cause === "hidden") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
  }
  if (cause === "pagehide") fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  await act(async () => { fresh.resolve(Response.json({ native: [] })); });
  await ready();
  expect(screen.getByText(empty)).toBeVisible();
  expect(screen.queryByRole("group", { name: "Review device" })).not.toBeInTheDocument();
});

it("retains a file chosen after picker focus while fresh owner status is still loading", async () => {
  const mock = upstream(); render(<Devices />); await ready(); openAdd();
  const fresh = deferred<Response>(); mock.mockReturnValueOnce(fresh.promise);
  fireEvent(window, new Event("focus"));
  const pendingFile = deferred<string>();
  const { file } = descriptorFile(serialized, vi.fn(() => pendingFile.promise)); importFile(file);
  await act(async () => { pendingFile.resolve(serialized); });
  expect(screen.getByLabelText("Public installation descriptor")).toHaveValue(serialized);
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
  expect(calls(mock, path)).toHaveLength(2);
  await act(async () => { fresh.resolve(Response.json({ native: [] })); }); await ready();
  expect(screen.getByLabelText("Public installation descriptor")).toHaveValue(serialized);
  expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
  expect(mutations(mock)).toHaveLength(0);
});

it.each(["pagehide", "edit"])("discards late imported content after %s", async cause => {
  const mock = upstream(); render(<Devices />); await ready(); openAdd();
  const pendingFile = deferred<string>();
  const { file } = descriptorFile(serialized, vi.fn(() => pendingFile.promise)); importFile(file);
  if (cause === "pagehide") fireEvent(window, new Event("pagehide"));
  else paste("new descriptor being entered");
  await act(async () => { pendingFile.resolve(serialized); });
  expect(screen.getByLabelText("Public installation descriptor")).toHaveValue(cause === "pagehide" ? "" : "new descriptor being entered");
  expect(screen.queryByRole("group", { name: "Review device" })).not.toBeInTheDocument();
  expect(calls(mock, /\/enrollments\//)).toHaveLength(0);
});

it("a linked descriptor opens the review at once, is consumed once and never reaches the address bar again", async () => {
  const mock = upstream();
  const encoded = btoa(serialized).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  window.history.replaceState(null, "", `/settings/account/surfaces#descriptor=${encoded}`);
  render(<Devices />);
  const inspected = within(await screen.findByRole("group", { name: "Review device" }));
  expect(window.location.hash).toBe("");
  expect(inspected.getByRole("heading", { name: "TV" })).toBeVisible();
  for (const line of fingerprintLines(fingerprint)) expect(inspected.getByText(line)).toBeVisible();
  expect(inspected.getByText("Compare with the fingerprint shown on the device.")).toBeVisible();
  expect(inspected.getByRole("button", { name: "Approve this device" })).toBeEnabled();
  expect(screen.queryByLabelText("Public installation descriptor")).not.toBeInTheDocument();
  expect(calls(mock, `${path}/enrollments/${descriptor.enrollmentId}`)).toHaveLength(1);
  expect(mutations(mock)).toHaveLength(0);
  window.history.replaceState(null, "", "/settings/account/surfaces#descriptor=not-a-descriptor");
  render(<Devices />);
  await screen.findByText("That link does not carry valid device details. Enter the device’s code by hand instead.");
  expect(window.location.hash).toBe("");
  expect(screen.getAllByRole("button", { name: "Enter the device details by hand" })).toHaveLength(2);
  window.history.replaceState(null, "", "/settings/account/surfaces");
});

it("walks the owner through adding a device in three steps and says what it is doing while it checks", async () => {
  const mock = upstream(); render(<Devices />); await ready();
  fireEvent.click(screen.getByRole("button", { name: "Add a device" }));
  const panel = within(screen.getByRole("region", { name: "Add a device" }));
  expect(panel.getAllByRole("listitem").map(item => item.textContent)).toEqual([
    "On the new device, open Cosmos and choose Approve in Center.",
    "Open the link it shows — scan its QR code with your phone, or type the link here.",
    "Check that the code it shows matches the one below, then approve.",
  ]);
  expect(screen.queryByText("Checking this device…")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Enter the device details by hand" }));
  const pending = deferred<Response>(); mock.mockReturnValueOnce(pending.promise);
  paste();
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText("Checking this device…");
  await act(async () => { pending.resolve(new Response(null, { status: 404 })); });
  await screen.findByRole("group", { name: "Review device" });
  expect(screen.queryByText("Checking this device…")).not.toBeInTheDocument();
  expect(mutations(mock)).toHaveLength(0);
});

it("says calmly that the list is out of date after the tab was hidden, and keeps failure language for an actual failure", async () => {
  const mock = upstream([first]); render(<Devices />); await ready();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.getByText("This list is out of date. Choose Refresh devices to read it again.")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await ready();
  expect(screen.queryByText(/out of date/u)).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: firstCard })).toBeVisible();
  mock.mockRejectedValue(new Error("cosmos unreachable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cosmos could not be reached just now. Choose Refresh devices to try again.");
  expect(screen.queryByText(/out of date/u)).not.toBeInTheDocument();
});

/*
 * Approving a device again bumps its revision, and every permission Cosmos
 * holds for it is bound to the old one. The page has to say that before the
 * click, and be able to grant each one again after it.
 */
it("says what reapproving drops before the click, then grants each one again at the value it had", async () => {
  // A Linux installation still on the profile from before device actions.
  const stale = { ...second, ...legacySpeechPosture(), surfaceId: first.surfaceId, enrollmentId: descriptor.enrollmentId,
    platform: descriptor.platform, revision: 8, speech: true, actions: [], confirms: false };
  const reapproved = { ...stale, ...nativePosture(descriptor.platform), revision: 9, actions: ["action.play"], confirms: false };
  const speechPolicy = { provider: { provider: "azure_speech", region: "westeurope" }, maximumClass: "shared_room", transcription: false, synthesis: true };
  const searx = { provider: "searxng", endpoint: "https://search.example.test/search", configurationDigest: "a".repeat(64) };
  const held: Record<string, unknown> = {
    "private-display": { approval: { approvalRevision: 8, revision: 2, policy: { maximumClass: "private" } } },
    "screen-context": { approval: { approvalRevision: 8, revision: 1, policy: { maximumClass: "private" } } },
    "speech-disclosure": { approval: { approvalRevision: 8, revision: 3, policy: speechPolicy } },
    "web-lookup": { approval: { approvalRevision: 8, revision: 1, policy: { provider: searx, maximumClass: "shared_room" } },
      providers: [searx], binding: { approvalRevision: 8, incarnation: null } },
  };
  const writes: [string, unknown][] = [];
  const revision = { current: 8 };
  const mock = Object.assign(vi.fn(async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const target = String(url);
    if (target === path && !options?.method) return Response.json({ native: [] });
    if (target === `${path}/enrollments/${descriptor.enrollmentId}`) return Response.json({ native: stale });
    if (target === "/api/admin/integrations") return Response.json({ error: "no" }, { status: 403 });
    if (target === "/api/devices/runtime") return Response.json({ pins: [] });
    if (target === "/api/devices/pair") return Response.json({ devices: [] });
    if (target === path && options?.method === "POST") {
      revision.current = 9;
      return Response.json({ native: reapproved });
    }
    const permission = PERMISSION.exec(target);
    if (!permission) throw new Error(`Unexpected request: ${target}`);
    const kind = permission[2];
    if (options?.method === "POST") {
      const input = JSON.parse(String(options.body));
      writes.push([kind, input]);
      const approval = { approvalRevision: input.approvalRevision, revision: input.expectedRevision + 1, policy: input.policy };
      return Response.json(kind.endsWith("lookup")
        ? { approval, providers: [searx], binding: { approvalRevision: input.approvalRevision, incarnation: null } }
        : { approval });
    }
    // Before the reapproval this device holds four permissions; after it, none.
    const answer = revision.current === 8 ? held[kind] : undefined;
    if (answer) return Response.json(answer);
    return Response.json(kind.endsWith("lookup")
      ? { approval: null, providers: kind === "web-lookup" ? [searx] : [], binding: { approvalRevision: revision.current, incarnation: null } }
      : { approval: null });
  }), { revisions: new Map<string, number>() });
  vi.stubGlobal("fetch", mock);

  render(<Devices />); await ready(); openAdd();
  const inspected = within(await review());
  expect(inspected.getByText(/Approving again drops what you have already allowed this device/u)).toBeVisible();
  const dropping = within(inspected.getByRole("group", { name: "Permissions this drops" }));
  expect(dropping.getAllByRole("listitem").map(item => item.textContent))
    .toEqual(["Show private replies here", "Use what’s on the screen", "Speak replies", "Look things up on the web"]);
  // Nothing has been written yet: reading what it holds is not changing it.
  expect(writes).toHaveLength(0);

  approve();
  await screen.findByText(approved);
  const panel = within(await screen.findByRole("region", { name: "Restore permissions" }));
  expect(panel.getByText(/dropped 4 permissions/u)).toBeVisible();
  expect(writes).toHaveLength(0);
  fireEvent.click(panel.getByRole("button", { name: "Grant these again" }));
  const results = await screen.findByRole("list", { name: "Restored permissions" });
  await waitFor(() => expect(within(results).queryByText("Working…")).not.toBeInTheDocument());
  expect(within(results).getAllByRole("listitem").map(item => item.textContent)).toEqual([
    "Show private replies here — Granted again.",
    "Use what’s on the screen — Granted again.",
    "Speak replies — Granted again.",
    "Look things up on the web — Granted again.",
  ]);
  // A class ceiling is restored before anything capped by it, and each write is
  // made against the NEW revision from a fresh read: nothing is carried over.
  expect(writes.map(([kind]) => kind)).toEqual(["private-display", "screen-context", "speech-disclosure", "web-lookup"]);
  for (const [, input] of writes) expect(input).toMatchObject({ approvalRevision: 9, expectedRevision: 0 });
  expect(writes.map(([, input]) => (input as { policy: unknown }).policy)).toEqual([
    { maximumClass: "private" }, { maximumClass: "private" }, speechPolicy, { provider: searx, maximumClass: "shared_room" },
  ]);
});

it("offers nothing to restore when the device held nothing, and never claims a permission it could not read", async () => {
  const stale = { ...second, ...legacySpeechPosture(), surfaceId: first.surfaceId, enrollmentId: descriptor.enrollmentId,
    platform: descriptor.platform, revision: 8, speech: true, actions: [], confirms: false };
  const mock = upstream([], stale, (_surfaceId, kind) => kind === "speech-disclosure" ? { error: "unavailable" } : undefined);
  render(<Devices />); await ready(); openAdd();
  const inspected = within(await review());
  // A permission that could not be read is never restored from a guess, and an
  // unread permission is not announced as one this drops.
  expect(inspected.queryByRole("group", { name: "Permissions this drops" })).not.toBeInTheDocument();
  mock.mockResolvedValueOnce(Response.json({ native: { ...stale, ...nativePosture(descriptor.platform), revision: 9,
    actions: ["action.play"], confirms: false } }));
  approve();
  await screen.findByText(approved);
  expect(screen.queryByRole("region", { name: "Restore permissions" })).not.toBeInTheDocument();
});
