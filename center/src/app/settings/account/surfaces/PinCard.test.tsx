import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PIN_APPROVAL, PIN_SURFACE_POSTURE, type PinSurface } from "@/lib/contracts/pinSurfaces";
import { LOCAL_VOICE_APPROVAL } from "@/lib/contracts/localVoice";
import { SPEECH_DISCLOSURE_APPROVAL } from "@/lib/contracts/speechDisclosure";
import { Devices, pinCards } from "./Devices";

/*
 * The Ai Pin as the owner meets it on Devices: paired, waiting, approved, its
 * two permissions on and off, and a list Cosmos could not read.
 */

const deviceId = "2c2a0001104000ff";
const pin: PinSurface = { ...PIN_SURFACE_POSTURE, surfaceId: "11111111-1111-4111-8111-111111111111",
  deviceId, revision: 3, revoked: false, currentPaired: true };
const RUNTIME = "/api/devices/runtime";
const voicePath = `${RUNTIME}/${pin.surfaceId}/local-voice`;
const speechPath = `/api/surfaces/${pin.surfaceId}/speech-disclosure`;
const speechPolicy = { provider: { provider: "azure_speech", region: "westeurope" }, maximumClass: "shared_room", transcription: false, synthesis: true };
const voicePolicy = { sourceFloor: "shared_room" };

type Approval = { approvalRevision: number; revision: number; policy: unknown } | null;
type World = { pins?: PinSurface[]; devices?: string[]; voice?: Approval; speech?: Approval; roster?: boolean; runtime?: boolean };

/** A small honest Cosmos: the roster, the owner's approvals and each Pin permission, with compare-and-set writes. */
function cosmos({ pins = [], devices = [deviceId], voice = null, speech = null, roster = true, runtime = true }: World = {}) {
  const state = { pins: [...pins], voice, speech };
  const mock = vi.fn(async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const target = String(url);
    const method = options?.method ?? "GET";
    if (target === "/api/surfaces/native") return Response.json({ native: [] });
    if (target === "/api/admin/integrations") return Response.json({ speech: { azure_region: "westeurope" } });
    if (target === "/api/devices/pair") return roster ? Response.json({ devices: devices.map(id => ({ deviceId: id })) }) : new Response(null, { status: 503 });
    for (const [path, key] of [[voicePath, "voice"], [speechPath, "speech"]] as const) {
      if (target !== path) continue;
      if (method === "POST") {
        const input = JSON.parse(String(options?.body));
        if (input.expectedRevision !== (state[key]?.revision ?? 0)) return new Response(null, { status: 409 });
        state[key] = { approvalRevision: pin.revision, revision: input.expectedRevision + 1, policy: input.policy };
      }
      return Response.json({ approval: state[key] });
    }
    if (/^\/api\/surfaces\/[0-9a-f-]{36}\/(?:web|places)-lookup$/u.test(target)) {
      return Response.json({ approval: null, providers: [], binding: { approvalRevision: pin.revision, incarnation: null } });
    }
    if (target === RUNTIME) {
      if (method === "GET") return runtime ? Response.json({ pins: state.pins }) : new Response(null, { status: 503 });
      const body = JSON.parse(String(options?.body));
      const approved = { ...pin, deviceId: body.deviceId };
      state.pins = [...state.pins.filter(row => row.deviceId !== approved.deviceId), approved];
      return Response.json({ pin: approved });
    }
    if (target.startsWith(`${RUNTIME}/`) && method === "DELETE") {
      const removed = state.pins.find(row => target.endsWith(row.surfaceId))!;
      state.pins = state.pins.filter(row => row.surfaceId !== removed.surfaceId);
      return Response.json({ pin: { ...removed, revision: removed.revision + 1, revoked: true } });
    }
    throw new Error(`Unexpected request: ${target}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
type Cosmos = ReturnType<typeof cosmos>;
const writes = (mock: Cosmos) => mock.mock.calls.filter(([, options]) => options?.method);
const body = (mock: Cosmos, index: number) => JSON.parse(String(writes(mock)[index][1]?.body));
const card = () => within(screen.getByRole("region", { name: "Ai Pin" }));
async function ready() {
  await waitFor(() => {
    expect(screen.queryByText("Checking devices…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh devices" })).toBeEnabled();
  });
  await waitFor(() => expect(screen.getByRole("region", { name: "Ai Pin" })).toBeVisible());
}
async function settled() { await waitFor(() => expect(card().queryByText("Checking…")).not.toBeInTheDocument()); }
function manage() { fireEvent.click(card().getByRole("button", { name: "Manage" })); }
const toggle = (name: string) => card().getByRole("switch", { name });

beforeEach(() => { vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("every Pin gets one card: each approval, then each paired Pin still waiting, and one card for none", () => {
  const second: PinSurface = { ...pin, surfaceId: "22222222-2222-4222-8222-222222222222", deviceId: "aabb" };
  expect(pinCards([pin, second], [deviceId, "aabb", "ccdd"])).toEqual([
    { deviceId, pin }, { deviceId: "aabb", pin: second }, { deviceId: "ccdd", pin: null },
  ]);
  // Without a roster only the approvals are known; none of them is invented.
  expect(pinCards([pin], undefined)).toEqual([{ deviceId, pin }]);
  expect(pinCards([], [])).toEqual([{ deviceId: null, pin: null }]);
});

it("an account with no Pin says so in one sentence and offers the one step that helps", async () => {
  const mock = cosmos({ devices: [] }); render(<Devices />); await ready();
  expect(card().getByRole("heading", { name: "Ai Pin" })).toBeVisible();
  expect(card().getByText("Not set up")).toBeVisible();
  expect(card().getByText("No Pin is paired with this account yet.")).toBeVisible();
  expect(card().getByRole("link", { name: "Set up your Pin" })).toHaveAttribute("href", "/settings/pin/setup");
  expect(card().queryByRole("button", { name: "Approve this Pin" })).not.toBeInTheDocument();
  expect(card().queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(writes(mock)).toHaveLength(0);
});

it("a paired Pin that is not approved reads as one calm sentence with one action, then approves with the exact gesture", async () => {
  const mock = cosmos(); render(<Devices />); await ready();
  expect(card().getByText("Waiting for approval")).toBeVisible();
  expect(card().getByText("This Pin is paired and waiting for your approval.")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(card().queryByText(deviceId)).not.toBeInTheDocument();
  expect(card().queryByRole("switch")).not.toBeInTheDocument();
  fireEvent.click(card().getByRole("button", { name: "Approve this Pin" }));
  await screen.findByText("Approved. Cosmos answers on this Pin.");
  const [url, options] = writes(mock)[0];
  expect(url).toBe(RUNTIME);
  expect(options).toMatchObject({ method: "POST", headers: { "content-type": "application/json" }, cache: "no-store" });
  expect(body(mock, 0)).toEqual({ deviceId, approval: PIN_APPROVAL });
  expect(card().getByText("Approved")).toBeVisible();
  // Approval opens what it just made possible, without turning anything on.
  await settled();
  expect(card().getByText("Nothing turned on yet")).toBeVisible();
  expect(toggle("Speak replies")).not.toBeChecked();
  expect(toggle("Take spoken requests")).not.toBeChecked();
  expect(writes(mock)).toHaveLength(1);
});

it("an approved Pin offers the permissions it actually has, in the same words as every other device", async () => {
  cosmos({ pins: [pin], speech: { approvalRevision: 3, revision: 2, policy: speechPolicy } });
  render(<Devices />); await ready(); await settled();
  expect(card().getByText("Approved")).toBeVisible();
  expect(card().getByText("Speaks replies")).toBeVisible();
  expect(card().queryByRole("switch")).not.toBeInTheDocument();
  manage();
  expect(toggle("Speak replies")).toBeChecked();
  expect(toggle("Take spoken requests")).not.toBeChecked();
  expect(toggle("Look things up on the web")).toBeInTheDocument();
  expect(toggle("Find places")).toBeInTheDocument();
  expect(card().queryByRole("switch", { name: "Show private replies here" })).not.toBeInTheDocument();
  expect(card().queryByRole("switch", { name: "Use what's on the screen" })).not.toBeInTheDocument();
  expect(card().getByText("Cosmos accepts spoken requests from this Pin and turns them into text on your own Cosmos server.")).toBeVisible();
  expect(card().getByText("The sound stays on your server, and what it hears counts as spoken in a shared room.")).toBeVisible();
  expect(card().getByText(/Cosmos reads shared replies aloud on this device/u)).toBeVisible();
  // No identifier, revision or serial before the owner asks for one.
  expect(card().queryByText(deviceId)).not.toBeInTheDocument();
  expect(card().queryByText(pin.surfaceId)).not.toBeInTheDocument();
  expect(card().queryByText(/revision/iu)).not.toBeInTheDocument();
  fireEvent.click(card().getByRole("button", { name: "Details" }));
  expect(card().getByText(deviceId)).toBeVisible();
  expect(card().getByText("Approval revision").nextElementSibling).toHaveTextContent("3");
  expect(card().getByText(/a spoken reply counts only after the Pin acknowledges it/u)).toBeVisible();
});

it("each Pin permission turns on and off with the approval Cosmos records for it", async () => {
  const mock = cosmos({ pins: [pin] }); render(<Devices />); await ready(); await settled(); manage();
  fireEvent.click(toggle("Take spoken requests"));
  await card().findByText("Cosmos confirmed this Pin may take spoken requests.");
  expect(writes(mock)[0][0]).toBe(voicePath);
  expect(body(mock, 0)).toEqual({ approval: LOCAL_VOICE_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: voicePolicy });
  expect(toggle("Take spoken requests")).toBeChecked();
  expect(card().getByText("Takes spoken requests")).toBeVisible();
  fireEvent.click(toggle("Speak replies"));
  await card().findByText("Cosmos confirmed spoken replies on this device.");
  expect(writes(mock)[1][0]).toBe(speechPath);
  expect(body(mock, 1)).toEqual({ approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: speechPolicy });
  expect(card().getByText("Speaks replies · Takes spoken requests")).toBeVisible();
  fireEvent.click(toggle("Take spoken requests"));
  await card().findByText("Cosmos confirmed spoken requests off for this Pin.");
  expect(body(mock, 2)).toEqual({ approval: LOCAL_VOICE_APPROVAL, approvalRevision: 3, expectedRevision: 1, policy: null });
  expect(toggle("Take spoken requests")).not.toBeChecked();
  expect(card().getByText("Speaks replies")).toBeVisible();
});

it("a Pin whose approval could not be read says so instead of reading as no Pin", async () => {
  const mock = cosmos({ runtime: false }); render(<Devices />); await ready();
  expect(card().getByText("Status unread")).toBeVisible();
  expect(card().getByText("Cosmos could not say what your Pin is allowed to do just now. Your pairing is unchanged.")).toBeVisible();
  expect(card().queryByText("No Pin is paired with this account yet.")).not.toBeInTheDocument();
  expect(card().queryByRole("button", { name: "Approve this Pin" })).not.toBeInTheDocument();
  expect(writes(mock)).toHaveLength(0);
  const pins = [pin];
  mock.mockImplementationOnce(async () => Response.json({ native: [] }));
  mock.mockImplementationOnce(async () => Response.json({ pins }));
  fireEvent.click(card().getByRole("button", { name: "Check again" }));
  await ready();
  expect(card().getByText("Approved")).toBeVisible();
});

it("an unreadable pairing roster hides only the Pins that have no approval yet", async () => {
  cosmos({ pins: [pin], roster: false }); render(<Devices />); await ready(); await settled();
  expect(card().getByText("Approved")).toBeVisible();
  expect(screen.getAllByRole("region", { name: "Ai Pin" })).toHaveLength(1);
});

it("removing the approval asks first, leaves pairing alone and lets the owner approve again", async () => {
  const mock = cosmos({ pins: [pin] }); render(<Devices />); await ready(); await settled();
  manage();
  fireEvent.click(card().getByRole("button", { name: "Details" }));
  fireEvent.click(card().getByRole("button", { name: "Remove this approval" }));
  expect(card().getByRole("group", { name: "Remove this approval?" })).toBeVisible();
  expect(writes(mock)).toHaveLength(0);
  fireEvent.click(card().getByRole("button", { name: "Keep" }));
  expect(card().queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  fireEvent.click(card().getByRole("button", { name: "Remove this approval" }));
  fireEvent.click(card().getByRole("button", { name: "Remove" }));
  await screen.findByText("Removed. Cosmos no longer answers on this Pin, and it stays paired with your account.");
  expect(writes(mock)[0][0]).toBe(`${RUNTIME}/${pin.surfaceId}`);
  expect(writes(mock)[0][1]?.method).toBe("DELETE");
  expect(card().getByText("Waiting for approval")).toBeVisible();
  expect(card().getByRole("button", { name: "Approve this Pin" })).toBeEnabled();
});

it("a Pin that lost its pairing can only have permissions taken away", async () => {
  cosmos({ pins: [{ ...pin, currentPaired: false }], devices: [],
    voice: { approvalRevision: 3, revision: 1, policy: voicePolicy } });
  render(<Devices />); await ready(); await settled();
  expect(card().getByText("Not paired")).toBeVisible();
  expect(card().getAllByText("This Pin is no longer paired with your account. Its permissions can only be turned off until you pair it again.")[0]).toBeVisible();
  manage();
  expect(toggle("Speak replies")).toBeDisabled();
  expect(toggle("Look things up on the web")).toBeDisabled();
  expect(toggle("Find places")).toBeDisabled();
  expect(toggle("Take spoken requests")).toBeEnabled();
  expect(toggle("Take spoken requests")).toBeChecked();
});

it("a lost reply never claims a change and keeps the card in place until a fresh read", async () => {
  const mock = cosmos(); render(<Devices />); await ready();
  mock.mockRejectedValueOnce(new Error("response lost after commit"));
  fireEvent.click(card().getByRole("button", { name: "Approve this Pin" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cosmos did not confirm the change. Refresh devices before retrying; the request may have committed.");
  expect(card().getByText("Status unread")).toBeVisible();
  expect(screen.queryByText("Approved. Cosmos answers on this Pin.")).not.toBeInTheDocument();
  await act(async () => { fireEvent.click(card().getByRole("button", { name: "Check again" })); });
  await ready();
  // Cosmos never received that write, and the card says only what Cosmos says.
  expect(card().getByText("Waiting for approval")).toBeVisible();
  expect(card().getByRole("button", { name: "Approve this Pin" })).toBeEnabled();
  expect(writes(mock)).toHaveLength(1);
});
