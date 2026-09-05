import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SpeechDisclosure } from "./SpeechDisclosure";
import { PIN_SURFACE_POSTURE, type PinSurface } from "@/lib/contracts/pinSurfaces";
import { SPEECH_DISCLOSURE_APPROVAL } from "@/lib/contracts/speechDisclosure";

const pin: PinSurface = { ...PIN_SURFACE_POSTURE, surfaceId: "11111111-1111-1111-1111-111111111111", deviceId: "aabb", revision: 2, currentPaired: true, revoked: false };
const policy = { provider: { provider: "azure_speech", region: "westeurope" }, maximumClass: "shared_room", transcription: false, synthesis: true };
const saved = { approvalRevision: 2, revision: 1, policy };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Speech provider permission" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh speech permission" })).toBeEnabled());
}
it("loads only on owner request and confirms the exact committed shared-text policy", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => Response.json({ approval: options?.method === "POST" ? saved : null }));
  vi.stubGlobal("fetch", mock); render(<SpeechDisclosure pin={pin} />);
  expect(mock).not.toHaveBeenCalled();
  await open();
  expect(screen.getByText("No active speech provider permission.")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Azure Speech region"), { target: { value: "westeurope" } });
  fireEvent.click(screen.getByRole("button", { name: "Allow shared reply text" }));
  await screen.findByText("Cosmos confirmed permission to send shared reply text to Azure Speech.");
  const [url, options] = mock.mock.calls.find(([, options]) => options?.method === "POST")!;
  expect(url).toBe(`/api/devices/runtime/${pin.surfaceId}/speech-disclosure`);
  expect(JSON.parse(String(options?.body))).toEqual({ approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: 2, expectedRevision: 0, policy });
});

it("lost replies block another write until a fresh read and never claim success", async () => {
  const mock = vi.fn(async () => Response.json({ approval: saved }));
  vi.stubGlobal("fetch", mock); render(<SpeechDisclosure pin={pin} />); await open();
  mock.mockResolvedValueOnce(new Response("conflict", { status: 409 }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke speech permission" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Allow shared reply text" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Revoke speech permission" })).toBeDisabled();
  expect(screen.queryByText("Cosmos confirmed speech provider permission revoked.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh speech permission" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke speech permission" })).toBeEnabled());
});

it("allows revocation after pairing loss and submits explicit null", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => Response.json({ approval: options?.method === "POST" ? { ...saved, revision: 2, policy: null } : saved }));
  vi.stubGlobal("fetch", mock); render(<SpeechDisclosure pin={{ ...pin, currentPaired: false }} />); await open();
  expect(screen.getByRole("button", { name: "Allow shared reply text" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Revoke speech permission" }));
  await screen.findByText("Cosmos confirmed speech provider permission revoked.");
  expect(JSON.parse(String(mock.mock.lastCall?.[1]?.body))).toEqual({ approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: 2, expectedRevision: 1, policy: null });
});

it("wrong approval revisions and mismatched successful writes cannot confer UI authority", async () => {
  const mock = vi.fn(async () => Response.json({ approval: { ...saved, approvalRevision: 1 } }));
  vi.stubGlobal("fetch", mock); render(<SpeechDisclosure pin={pin} />); await open();
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Allow shared reply text" })).toBeDisabled();
  mock.mockResolvedValueOnce(Response.json({ approval: saved }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh speech permission" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke speech permission" })).toBeEnabled());
  mock.mockResolvedValueOnce(Response.json({ approval: { ...saved, revision: 2, policy: { ...policy, transcription: true } } }));
  fireEvent.click(screen.getByRole("button", { name: "Allow shared reply text" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Cosmos confirmed permission to send shared reply text to Azure Speech.")).not.toBeInTheDocument();
});

it("closing or unmounting aborts work and late replies cannot restore the prior owner state", async () => {
  let finish!: (response: Response) => void;
  const mock = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", mock); const view = render(<SpeechDisclosure pin={pin} />);
  fireEvent.click(screen.getByRole("button", { name: "Speech provider permission" }));
  const signal = mock.mock.calls[0][1]?.signal;
  fireEvent.click(screen.getByRole("button", { name: "Close speech permission" }));
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish(Response.json({ approval: saved })); });
  expect(screen.queryByLabelText("Azure Speech region")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Speech provider permission" }));
  const nextSignal = mock.mock.lastCall?.[1]?.signal;
  view.unmount(); expect(nextSignal?.aborted).toBe(true);
});
