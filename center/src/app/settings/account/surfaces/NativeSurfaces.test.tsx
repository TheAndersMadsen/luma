import { createHash, webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NATIVE_APPROVAL, NATIVE_SURFACE_POSTURE, type NativeDescriptor, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import { NativeSurfaces } from "./NativeSurfaces";

// The SEC1 encoding of the P-256 generator is a real curve point. Key import
// and the displayed digest exercise WebCrypto rather than a permissive mock.
const publicKeyBytes = Buffer.from("046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", "hex");
const fingerprint = createHash("sha256").update(publicKeyBytes).digest("hex");
const descriptor: NativeDescriptor = {
  enrollmentId: "11111111-1111-1111-1111-111111111111", publicKey: publicKeyBytes.toString("base64url"),
  platform: "android_tv", approval: NATIVE_APPROVAL,
};
const serialized = JSON.stringify(descriptor);
const first: NativeSurface = { ...NATIVE_SURFACE_POSTURE, surfaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  enrollmentId: descriptor.enrollmentId, platform: descriptor.platform, revision: 1, publicKeyFingerprint: fingerprint, revoked: false };
const second: NativeSurface = { ...first, surfaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  enrollmentId: "22222222-2222-2222-2222-222222222222", platform: "linux", revision: 7 };
const path = "/api/surfaces/native";
const success = "Cosmos recorded this installation’s public-text approval. Native text connections are still in development.";
const revoked = "Cosmos confirmed this installation’s approval revoked.";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function upstream(rows: NativeSurface[] = [], existing: NativeSurface | null = null) {
  const mock = vi.fn(async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    if (options?.method) throw new Error("Unexpected mutation");
    if (String(url) === path) return Response.json({ native: rows });
    if (String(url) === `${path}/enrollments/${descriptor.enrollmentId}`) {
      return existing ? Response.json({ native: existing }) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
async function ready() {
  await waitFor(() => expect(screen.getByLabelText("Public installation descriptor")).toBeEnabled());
}
function paste(text = serialized) {
  fireEvent.change(screen.getByLabelText("Public installation descriptor"), { target: { value: text } });
}
async function review(text = serialized) {
  paste(text);
  fireEvent.click(screen.getByRole("button", { name: "Review installation" }));
  return screen.findByRole("group", { name: "Review native installation" });
}
function confirm() { fireEvent.click(screen.getByRole("button", { name: "Confirm public-text approval" })); }
function expectLocked() {
  expect(screen.getByLabelText("Public installation descriptor")).toBeDisabled();
  expect(screen.getByLabelText("Import installation descriptor")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Review installation" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Confirm public-text approval" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Revoke installation / })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Confirm revoke installation" })).not.toBeInTheDocument();
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  expect(screen.queryByText(revoked)).not.toBeInTheDocument();
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

it("requires review and a separate owner confirmation of the key and limited public-text permission", async () => {
  const mock = upstream(); render(<NativeSurfaces />); await ready();
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0][0]).toBe(path);
  expect(mock.mock.calls[0][1]?.cache).toBe("no-store");
  expect(screen.getByText(/Approvals are limited to public text/)).toBeVisible();
  expect(screen.getByText(/They do not allow voice, media context, private memories, device actions or output on the device/)).toBeVisible();
  expect(screen.getByText(/Native clients and their text connections are still being built/)).toBeVisible();
  paste();
  expect(mock).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Confirm public-text approval" })).not.toBeInTheDocument();
  const inspected = within(await review());
  expect(inspected.getByText("Android TV")).toBeVisible();
  expect(inspected.getByText(descriptor.enrollmentId)).toBeVisible();
  expect(inspected.getByText(fingerprint)).toBeVisible();
  expect(inspected.getByText(/Compare this fingerprint with the installation/)).toBeVisible();
  expect(mock.mock.calls[1][0]).toBe(`${path}/enrollments/${descriptor.enrollmentId}`);
  expect(mock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.click(inspected.getByRole("button", { name: "Cancel review" }));
  expect(mock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  await review();
  mock.mockResolvedValueOnce(Response.json({ native: first })); confirm();
  await screen.findByText(success);
  const [url, options] = mock.mock.lastCall!;
  expect(url).toBe(path); expect(options?.method).toBe("POST");
  expect(options?.cache).toBe("no-store");
  expect(options?.headers).toEqual({ "content-type": "application/json" });
  expect(JSON.parse(String(options?.body))).toEqual({ ...descriptor, expectedRevision: 0 });
  expect(screen.getByText("Public-text approval recorded · connection unverified · room and actor unknown.")).toBeVisible();
  expect(screen.getByRole("group", { name: `Web lookup permission for Android TV installation ${descriptor.enrollmentId}` })).toBeVisible();
  expect(screen.getByRole("button", { name: "Web lookup permission" })).toBeVisible();
  expect(screen.getByRole("group", { name: `Place lookup permission for Android TV installation ${descriptor.enrollmentId}` })).toBeVisible();
  expect(screen.getByRole("button", { name: "Place lookup permission" })).toBeVisible();
  expect(mock.mock.calls.some(([url]) => /\/(?:web|places)-lookup$/.test(String(url)))).toBe(false);
});

it("editing a reviewed descriptor removes its approval gesture until the new descriptor is reviewed", async () => {
  const mock = upstream(); render(<NativeSurfaces />); await ready(); await review();
  paste(JSON.stringify({ ...descriptor, platform: "macos" }));
  expect(screen.queryByRole("group", { name: "Review native installation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Confirm public-text approval" })).not.toBeInTheDocument();
  expect(mock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
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
  const mock = upstream(); render(<NativeSurfaces />); await ready(); paste(text);
  fireEvent.click(screen.getByRole("button", { name: "Review installation" }));
  await screen.findByRole("alert");
  expect(mock).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("group", { name: "Review native installation" })).not.toBeInTheDocument();
});

it("imports a descriptor of exactly 1 KB locally, then requires lookup and explicit approval", async () => {
  const mock = upstream(); render(<NativeSurfaces />); await ready();
  const text = serialized.padEnd(1024, " ");
  const { file, read } = descriptorFile(text); importFile(file);
  await waitFor(() => expect(screen.getByLabelText("Public installation descriptor")).toHaveValue(text));
  expect(read).toHaveBeenCalledTimes(1);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Confirm public-text approval" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review installation" }));
  await screen.findByRole("button", { name: "Confirm public-text approval" });
  expect(mock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("rejects oversized files without reading them and rejects extra fields in imported JSON", async () => {
  const mock = upstream(); render(<NativeSurfaces />); await ready();
  const oversized = descriptorFile(serialized.padEnd(1025, " ")); importFile(oversized.file);
  await screen.findByText("The public installation descriptor must be at most 1 KB.");
  expect(oversized.read).not.toHaveBeenCalled();
  const invalid = descriptorFile(JSON.stringify({ ...descriptor, authority: "private" })); importFile(invalid.file);
  await screen.findByText(/Use a valid public installation descriptor containing only/);
  expect(screen.getByLabelText("Public installation descriptor")).toHaveValue("");
  expect(mock).toHaveBeenCalledTimes(1);
});

it("reapproval uses the fresh revoked lookup revision, while an active matching installation cannot be approved again", async () => {
  const existing = { ...first, revision: 8, revoked: true };
  const mock = upstream([], existing); render(<NativeSurfaces />); await ready(); await review();
  expect(screen.getByText(/Its earlier approval was revoked/)).toBeVisible();
  mock.mockResolvedValueOnce(Response.json({ native: { ...first, revision: 9 } })); confirm();
  await screen.findByText(success);
  expect(JSON.parse(String(mock.mock.lastCall?.[1]?.body)).expectedRevision).toBe(8);
  mock.mockResolvedValueOnce(Response.json({ native: { ...first, revision: 9 } })); await review();
  expect(screen.getByText("This installation already has public-text approval.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Confirm public-text approval" })).not.toBeInTheDocument();
  expect(mock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
});

it.each(["conflict", "lost response"])("a %s locks every mutation until a fresh read and lookup supply current revisions", async cause => {
  const mock = upstream([second]); render(<NativeSurfaces />); await ready(); await review();
  if (cause === "conflict") mock.mockResolvedValueOnce(new Response(null, { status: 409 }));
  else mock.mockRejectedValueOnce(new Error("response lost after commit"));
  confirm(); await screen.findByRole("alert"); expectLocked();
  const pendingRead = deferred<Response>(); mock.mockReturnValueOnce(pendingRead.promise);
  fireEvent.click(screen.getByRole("button", { name: "Refresh native approvals" })); expectLocked();
  await act(async () => { pendingRead.resolve(Response.json({ native: [second] })); }); await ready();
  mock.mockResolvedValueOnce(Response.json({ native: { ...first, revision: 6, revoked: true } })); await review();
  mock.mockResolvedValueOnce(Response.json({ native: { ...first, revision: 7 } })); confirm();
  await screen.findByText(success);
  expect(JSON.parse(String(mock.mock.lastCall?.[1]?.body)).expectedRevision).toBe(6);
});

it("revokes only after confirmation and sends the selected installation's exact row revision", async () => {
  const mock = upstream([first, second]); render(<NativeSurfaces />); await ready();
  fireEvent.click(screen.getByRole("button", { name: `Revoke installation ${second.enrollmentId}` }));
  expect(mock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel revocation" }));
  expect(mock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: `Revoke installation ${second.enrollmentId}` }));
  mock.mockResolvedValueOnce(Response.json({ native: { ...second, revision: 8, revoked: true } }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke installation" }));
  await screen.findByText(revoked);
  expect(mock.mock.lastCall?.[0]).toBe(`${path}/${second.surfaceId}`);
  expect(mock.mock.lastCall?.[1]?.method).toBe("DELETE");
  expect(JSON.parse(String(mock.mock.lastCall?.[1]?.body))).toEqual({ expectedRevision: 7 });
  expect(screen.getByRole("button", { name: `Revoke installation ${first.enrollmentId}` })).toBeVisible();
  expect(screen.queryByText(second.enrollmentId)).not.toBeInTheDocument();
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
  const mock = upstream([second]); render(<NativeSurfaces />); await ready(); await review();
  mock.mockResolvedValueOnce(Response.json({ native })); confirm();
  await screen.findByRole("alert"); expectLocked();
});

it("does not accept revocation committed for another surface or at a stale revision", async () => {
  for (const native of [{ ...first, surfaceId: second.surfaceId, revision: 2, revoked: true }, { ...first, revoked: true }]) {
    const mock = upstream([first]); const view = render(<NativeSurfaces />); await ready();
    fireEvent.click(screen.getByRole("button", { name: `Revoke installation ${first.enrollmentId}` }));
    mock.mockResolvedValueOnce(Response.json({ native }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke installation" }));
    await screen.findByRole("alert"); expectLocked(); view.unmount();
  }
});

it("fences double confirmation while the mutation is pending without claiming optimistic approval", async () => {
  const mock = upstream(); render(<NativeSurfaces />); await ready(); await review();
  const pending = deferred<Response>(); mock.mockReturnValueOnce(pending.promise);
  const approve = screen.getByRole("button", { name: "Confirm public-text approval" });
  fireEvent.click(approve); fireEvent.click(approve);
  expect(approve).toBeDisabled();
  expect(mock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  expect(screen.getByText("No approved native installations.")).toBeVisible();
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  await act(async () => { pending.resolve(Response.json({ native: first })); });
  await screen.findByText(success);
});

const lifecycleCases = (["list", "lookup", "approval", "revoke"] as const).flatMap(phase =>
  (["unmount", "pagehide", "hidden", "focus"] as const).map(cause => ({ phase, cause })));
it.each(lifecycleCases)("a late $phase reply after $cause cannot restore owner inventory or approval", async ({ phase, cause }) => {
  const mock = upstream([first]);
  const pending = deferred<Response>();
  if (phase === "list") mock.mockReturnValueOnce(pending.promise);
  const view = render(<NativeSurfaces />);
  if (phase !== "list") {
    await ready();
    if (phase === "lookup") {
      mock.mockReturnValueOnce(pending.promise); paste();
      fireEvent.click(screen.getByRole("button", { name: "Review installation" }));
      await waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    } else if (phase === "approval") {
      await review(); mock.mockReturnValueOnce(pending.promise); confirm();
    } else {
      fireEvent.click(screen.getByRole("button", { name: `Revoke installation ${first.enrollmentId}` }));
      mock.mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole("button", { name: "Confirm revoke installation" }));
    }
  }
  const signal = mock.mock.lastCall?.[1]?.signal;
  const fresh = deferred<Response>(); mock.mockReturnValueOnce(fresh.promise);
  if (cause === "unmount") { view.unmount(); render(<NativeSurfaces />); }
  if (cause === "pagehide") fireEvent(window, new Event("pagehide"));
  if (cause === "hidden") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
  }
  if (cause === "focus") fireEvent(window, new Event("focus"));
  expect(signal?.aborted).toBe(true);
  expectLocked();
  expect(screen.queryByText(first.enrollmentId)).not.toBeInTheDocument();
  const native = phase === "list" ? [first] : phase === "revoke" ? { ...first, revision: 2, revoked: true } : first;
  await act(async () => { pending.resolve(Response.json({ native })); });
  expectLocked();
  expect(screen.queryByText(first.enrollmentId)).not.toBeInTheDocument();
  if (cause === "hidden") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
  }
  if (cause === "pagehide") fireEvent.click(screen.getByRole("button", { name: "Refresh native approvals" }));
  await act(async () => { fresh.resolve(Response.json({ native: [] })); });
  await ready();
  expect(screen.getByText("No approved native installations.")).toBeVisible();
  expect(screen.queryByRole("group", { name: "Review native installation" })).not.toBeInTheDocument();
});

it("retains a file chosen after picker focus while fresh owner status is still loading", async () => {
  const mock = upstream(); render(<NativeSurfaces />); await ready();
  const fresh = deferred<Response>(); mock.mockReturnValueOnce(fresh.promise);
  fireEvent(window, new Event("focus"));
  const pendingFile = deferred<string>();
  const { file } = descriptorFile(serialized, vi.fn(() => pendingFile.promise)); importFile(file);
  await act(async () => { pendingFile.resolve(serialized); });
  expect(screen.getByLabelText("Public installation descriptor")).toHaveValue(serialized);
  expect(screen.getByRole("button", { name: "Review installation" })).toBeDisabled();
  expect(mock).toHaveBeenCalledTimes(2);
  await act(async () => { fresh.resolve(Response.json({ native: [] })); }); await ready();
  expect(screen.getByLabelText("Public installation descriptor")).toHaveValue(serialized);
  expect(screen.getByRole("button", { name: "Review installation" })).toBeEnabled();
  expect(mock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it.each(["pagehide", "edit"])("discards late imported content after %s", async cause => {
  const mock = upstream(); render(<NativeSurfaces />); await ready();
  const pendingFile = deferred<string>();
  const { file } = descriptorFile(serialized, vi.fn(() => pendingFile.promise)); importFile(file);
  if (cause === "pagehide") fireEvent(window, new Event("pagehide"));
  else paste("new descriptor being entered");
  await act(async () => { pendingFile.resolve(serialized); });
  expect(screen.getByLabelText("Public installation descriptor")).toHaveValue(cause === "pagehide" ? "" : "new descriptor being entered");
  expect(screen.queryByRole("group", { name: "Review native installation" })).not.toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(1);
});
