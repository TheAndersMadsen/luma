import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LocalVoicePermission } from "./LocalVoicePermission";
import { PIN_SURFACE_POSTURE, type PinSurface } from "@/lib/contracts/pinSurfaces";
import { LOCAL_VOICE_APPROVAL } from "@/lib/contracts/localVoice";

const pin: PinSurface = { ...PIN_SURFACE_POSTURE, surfaceId: "11111111-1111-1111-1111-111111111111", deviceId: "aabb", revision: 2, currentPaired: true, revoked: false };
const policy = { sourceFloor: "shared_room" };
const saved = { approvalRevision: 2, revision: 1, policy };
const success = "Cosmos confirmed local voice permission for shared requests. Microphone integration remains in preview.";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Local voice permission" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh local voice permission" })).toBeEnabled());
}

it("requires an owner gesture, explains local processing and confirms only the committed shared policy", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => Response.json({ approval: options?.method === "POST" ? saved : null }));
  vi.stubGlobal("fetch", mock); render(<LocalVoicePermission pin={pin} />);
  expect(mock).not.toHaveBeenCalled();
  await open();
  expect(screen.getByText("No active local voice permission.")).toBeVisible();
  expect(screen.getByText(/Audio processing stays on your Cosmos server/)).toBeVisible();
  expect(screen.getByText(/recognized requests may be sent to your selected conversation provider/)).toBeVisible();
  expect(screen.getByText(/Saving permission does not activate the microphone/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Allow shared local voice requests" }));
  await screen.findByText(success);
  const [url, options] = mock.mock.calls.find(([, options]) => options?.method === "POST")!;
  expect(url).toBe(`/api/devices/runtime/${pin.surfaceId}/local-voice`);
  expect(options?.cache).toBe("no-store");
  expect(JSON.parse(String(options?.body))).toEqual({ approval: LOCAL_VOICE_APPROVAL, approvalRevision: 2, expectedRevision: 0, policy });
  expect(screen.getByText("Current voice privacy: Shared room.")).toBeVisible();
});

it("revokes after lost or unknown pairing and submits explicit null while grants stay disabled", async () => {
  for (const currentPaired of [false, null]) {
    const mock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => Response.json({ approval: options?.method === "POST" ? { ...saved, revision: 2, policy: null } : saved }));
    vi.stubGlobal("fetch", mock); const view = render(<LocalVoicePermission pin={{ ...pin, currentPaired }} />);
    await open();
    expect(screen.getByRole("button", { name: "Allow shared local voice requests" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke local voice permission" }));
    await screen.findByText("Cosmos confirmed local voice permission revoked.");
    expect(JSON.parse(String(mock.mock.lastCall?.[1]?.body))).toEqual({ approval: LOCAL_VOICE_APPROVAL, approvalRevision: 2, expectedRevision: 1, policy: null });
    view.unmount();
  }
});

it("an uncertain write disables all writes until a fresh read supplies the committed revision", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => Response.json({ approval: saved }));
  vi.stubGlobal("fetch", mock); render(<LocalVoicePermission pin={pin} />); await open();
  mock.mockRejectedValueOnce(new Error("response lost after commit"));
  fireEvent.click(screen.getByRole("button", { name: "Revoke local voice permission" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Allow shared local voice requests" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Revoke local voice permission" })).toBeDisabled();
  expect(screen.queryByText("Cosmos confirmed local voice permission revoked.")).not.toBeInTheDocument();
  const revoked = { ...saved, revision: 2, policy: null };
  mock.mockResolvedValueOnce(Response.json({ approval: revoked }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh local voice permission" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Allow shared local voice requests" })).toBeEnabled());
  mock.mockResolvedValueOnce(Response.json({ approval: { ...saved, revision: 3 } }));
  fireEvent.click(screen.getByRole("button", { name: "Allow shared local voice requests" }));
  await screen.findByText(success);
  expect(JSON.parse(String(mock.mock.lastCall?.[1]?.body)).expectedRevision).toBe(2);
});

it("reads and successful writes reject wrong enrollment, policy, or commit revision", async () => {
  const mock = vi.fn(async () => Response.json({ approval: { ...saved, approvalRevision: 1 } }));
  vi.stubGlobal("fetch", mock); render(<LocalVoicePermission pin={pin} />); await open();
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Allow shared local voice requests" })).toBeDisabled();
  for (const wrong of [{ ...saved, revision: 3 }, { ...saved, revision: 2, approvalRevision: 1 },
    { ...saved, revision: 2, policy: { sourceFloor: "private" } }, null]) {
    mock.mockResolvedValueOnce(Response.json({ approval: saved }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh local voice permission" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow shared local voice requests" })).toBeEnabled());
    mock.mockResolvedValueOnce(Response.json({ approval: wrong }));
    fireEvent.click(screen.getByRole("button", { name: "Allow shared local voice requests" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(success)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow shared local voice requests" })).toBeDisabled();
  }
});

it("pending mutations cannot be duplicated or optimistically treated as permission", async () => {
  let finish!: (response: Response) => void;
  const mock = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => options?.method === "POST"
    ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json({ approval: null })));
  vi.stubGlobal("fetch", mock); render(<LocalVoicePermission pin={pin} />); await open();
  const allow = screen.getByRole("button", { name: "Allow shared local voice requests" });
  fireEvent.click(allow); fireEvent.click(allow);
  expect(allow).toBeDisabled();
  expect(mock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  expect(screen.getByText("No active local voice permission.")).toBeVisible();
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  await act(async () => { finish(Response.json({ approval: saved })); });
  await screen.findByText(success);
});

it("close, unmount, hidden state and changed Pin revision abort work and discard late replies", async () => {
  for (const cause of ["close", "unmount", "hidden", "revision"]) {
    let finish!: (response: Response) => void;
    const mock = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", mock); const view = render(<LocalVoicePermission pin={pin} />);
    fireEvent.click(screen.getByRole("button", { name: "Local voice permission" }));
    const signal = mock.mock.calls[0][1]?.signal;
    if (cause === "close") fireEvent.click(screen.getByRole("button", { name: "Close local voice permission" }));
    if (cause === "unmount") view.unmount();
    if (cause === "hidden") fireEvent(document, new Event("visibilitychange"));
    if (cause === "revision") view.rerender(<LocalVoicePermission pin={{ ...pin, revision: 3 }} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish(Response.json({ approval: saved })); });
    expect(screen.queryByText("Current voice privacy: Shared room.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow shared local voice requests" })).not.toBeInTheDocument();
    view.unmount();
  }
});

it("closing an in-flight write requires a new read even if the late reply reports success", async () => {
  let finish!: (response: Response) => void;
  const mock = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => options?.method === "POST"
    ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json({ approval: null })));
  vi.stubGlobal("fetch", mock); render(<LocalVoicePermission pin={pin} />); await open();
  fireEvent.click(screen.getByRole("button", { name: "Allow shared local voice requests" }));
  const signal = mock.mock.lastCall?.[1]?.signal;
  fireEvent.click(screen.getByRole("button", { name: "Close local voice permission" }));
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish(Response.json({ approval: saved })); });
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  await open();
  expect(mock.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(2);
  expect(screen.getByText("No active local voice permission.")).toBeVisible();
});
