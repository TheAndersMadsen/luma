import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { PinRuntimeApproval } from "./PinRuntimeApproval";
import Page from "./page";
import { PIN_APPROVAL, PIN_SURFACE_POSTURE, type PinSurface } from "@/lib/contracts/pinSurfaces";

const first: PinSurface = { ...PIN_SURFACE_POSTURE, surfaceId: "11111111-1111-1111-1111-111111111111", deviceId: "aabb", revision: 1, revoked: false, currentPaired: true };
const second: PinSurface = { ...first, surfaceId: "22222222-2222-2222-2222-222222222222", deviceId: "ccdd" };
const clients: QueryClient[] = [];
let roster: { deviceId: string }[] = [first, second];
let rosterFailed = false;
function show(props: { devices?: { deviceId: string }[]; failed?: boolean } = {}, page = false) {
  roster = props.devices ?? [first, second]; rosterFailed = props.failed ?? false;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}>{page ? <Page /> : <PinRuntimeApproval />}</QueryClientProvider>);
}
function upstream(initial: PinSurface[] = []) {
  let pins = [...initial];
  const mock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    if (String(_url) === "/api/devices/pair") return rosterFailed ? new Response("unavailable", { status: 503 }) : Response.json({ devices: roster });
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      const pin = body.deviceId === first.deviceId ? first : second;
      pins = [...pins.filter(item => item.deviceId !== pin.deviceId), pin];
      return Response.json({ pin });
    }
    if (options?.method === "DELETE") {
      const pin = pins.find(item => String(_url).endsWith(item.surfaceId))!;
      pins = pins.filter(item => item.surfaceId !== pin.surfaceId);
      return Response.json({ pin: { ...pin, revoked: true } });
    }
    return Response.json({ pins });
  });
  vi.stubGlobal("fetch", mock); return mock;
}
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("pairing alone never approves; selection and separate confirmation bind the exact Pin", async () => {
  const mock = upstream(); show();
  await screen.findAllByText("No active runtime approval.");
  expect(mock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  const row = within(screen.getByLabelText("Runtime approval for Pin ccdd"));
  fireEvent.click(row.getByRole("button", { name: "Approve shared speech" }));
  fireEvent.click(row.getByRole("button", { name: "Cancel" }));
  expect(mock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.click(row.getByRole("button", { name: "Approve shared speech" }));
  fireEvent.click(row.getByRole("button", { name: "Confirm shared speech" }));
  await screen.findByText("Cosmos committed shared-speech approval. Device behavior and playback remain unverified.");
  expect(mock.mock.calls.find(([, options]) => options?.method === "POST")?.[1]?.body).toBe(JSON.stringify({ deviceId: "ccdd", approval: PIN_APPROVAL }));
  expect(row.getByRole("button", { name: "Revoke runtime approval" })).toBeVisible();
  expect(within(screen.getByLabelText("Runtime approval for Pin aabb")).getByText("No active runtime approval.")).toBeVisible();
  expect(screen.getByText(/Trust level 0, no autonomy and no private-memory clearance/)).toBeVisible();
});
it("fresh multi-Pin approval list maps revoke to the correct Pin and exact surface", async () => {
  const mock = upstream([first, second]); show();
  await screen.findAllByRole("button", { name: "Revoke runtime approval" });
  expect(screen.getAllByRole("button", { name: "Local voice permission" })).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Speech provider permission" })).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Web lookup permission" })).toHaveLength(2);
  expect(screen.getByRole("group", { name: "Web lookup permission for Pin ccdd" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Place lookup permission" })).toHaveLength(2);
  expect(screen.getByRole("group", { name: "Place lookup permission for Pin ccdd" })).toBeVisible();
  expect(mock.mock.calls.every(([url]) => url === "/api/devices/runtime" || url === "/api/devices/pair")).toBe(true);
  const row = within(screen.getByLabelText("Runtime approval for Pin ccdd"));
  fireEvent.click(row.getByRole("button", { name: "Revoke runtime approval" }));
  fireEvent.click(row.getByRole("button", { name: "Confirm revoke" }));
  await screen.findByText("Cosmos confirmed runtime approval revoked. Pairing is unchanged.");
  expect(mock.mock.calls.find(([, options]) => options?.method === "DELETE")?.[0]).toBe(`/api/devices/runtime/${second.surfaceId}`);
  expect(row.getByText("Runtime approval revoked.")).toBeVisible();
  expect(within(screen.getByLabelText("Runtime approval for Pin aabb")).getByRole("button", { name: "Revoke runtime approval" })).toBeVisible();
});
it("stale transferred/unpaired approvals remain explicitly revocable without a roster row", async () => {
  const mock = upstream([{ ...second, currentPaired: false }]); show({ devices: [], failed: true });
  await screen.findByText(/this Pin is no longer paired to this account/);
  expect(screen.queryByRole("button", { name: "Approve shared speech" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Revoke runtime approval" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
  await screen.findByText("Cosmos confirmed runtime approval revoked. Pairing is unchanged.");
  expect(mock.mock.calls.find(([, options]) => options?.method === "DELETE")?.[0]).toBe(`/api/devices/runtime/${second.surfaceId}`);
});
it("pending and failed mutations never optimistically claim approval", async () => {
  const mock = upstream(); show({ devices: [first] });
  await screen.findByText("No active runtime approval.");
  let finish!: (response: Response) => void;
  mock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Approve shared speech" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm shared speech" }));
  await screen.findByRole("button", { name: "Waiting for Cosmos…" });
  expect(screen.getByText("No active runtime approval.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Waiting for Cosmos…" })).toBeDisabled();
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  finish(new Response("unavailable", { status: 503 }));
  await screen.findByRole("alert");
  expect(screen.queryByText(/Cosmos committed shared-speech approval/)).not.toBeInTheDocument();
  expect(screen.getByText("No active runtime approval.")).toBeVisible();
});
it("failed revoke keeps recorded approval and reports uncertainty, not success", async () => {
  const mock = upstream([first]); show({ devices: [first] });
  await screen.findByRole("button", { name: "Revoke runtime approval" });
  mock.mockImplementationOnce(async () => { throw new Error("connection lost"); });
  fireEvent.click(screen.getByRole("button", { name: "Revoke runtime approval" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
  await screen.findByRole("alert");
  expect(screen.getByText(/Shared-speech approval recorded/)).toBeVisible();
  expect(screen.queryByText("Runtime approval revoked.")).not.toBeInTheDocument();
});
it("distinguishes unpaired from unavailable and offers a read-only retry", async () => {
  const mock = upstream(); show({ devices: [] });
  await screen.findByText(/Pair a Pin through guided setup before approving/);
  mock.mockImplementationOnce(async () => new Response("unavailable", { status: 503 }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh runtime approvals" }));
  await screen.findByText(/Runtime approval status is unavailable/);
  expect(screen.queryByText(/Pair a Pin through guided setup before approving/)).not.toBeInTheDocument();
  expect(mock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it("actual My Ai Pin page consumes paired roster but performs no implicit runtime mutation", async () => {
  const mock = vi.fn(async (url: RequestInfo | URL) => Response.json(String(url) === "/api/devices/pair" ? { devices: [{ deviceId: first.deviceId, pairedAt: null }] }
    : String(url) === "/api/devices/runtime" ? { pins: [] }
    : String(url) === "/api/settings/wifi" ? { networks: [], state: "absent" }
    : { devices: [], state: "live", unread: 0 }));
  vi.stubGlobal("fetch", mock); show({}, true);
  await screen.findByLabelText(`Runtime approval for Pin ${first.deviceId}`);
  expect(screen.getByRole("button", { name: "Approve shared speech" })).toBeVisible();
  expect(mock.mock.calls.some(([url]) => url === "/api/devices/pair")).toBe(true);
  expect(mock.mock.calls.some(([url]) => url === "/api/devices/runtime")).toBe(true);
});

it("never reads an old owner's shared query cache on remount, pending or failed fresh reads", async () => {
  const client = new QueryClient(); clients.push(client);
  client.setQueryData(["pin-runtime-approvals"], [first]);
  client.setQueryData(["paired-pins"], { devices: [first] });
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url) === "/api/devices/runtime"
    ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json({ devices: [] }))));
  render(<QueryClientProvider client={client}><PinRuntimeApproval /></QueryClientProvider>);
  expect(screen.getByText("Checking runtime approvals…")).toBeVisible();
  expect(screen.queryByText(`Pin ${first.deviceId}`)).not.toBeInTheDocument();
  finish(new Response("unavailable", { status: 503 }));
  await screen.findByText(/Runtime approval status is unavailable/);
  expect(screen.queryByText(`Pin ${first.deviceId}`)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Revoke runtime approval" })).not.toBeInTheDocument();
});

it("focus return clears old rows and choices before the new session read resolves", async () => {
  const mock = upstream([first]); show({ devices: [first] });
  await screen.findByText(`Pin ${first.deviceId}`);
  let finish!: (response: Response) => void;
  mock.mockImplementation((url: RequestInfo | URL) => String(url) === "/api/devices/runtime"
    ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json({ devices: [] })));
  fireEvent(window, new Event("focus"));
  expect(screen.queryByText(`Pin ${first.deviceId}`)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Revoke runtime approval" })).not.toBeInTheDocument();
  finish(Response.json({ pins: [] }));
  await screen.findByText(/Pair a Pin through guided setup before approving/);
});

it("hidden tabs clear private inventory; returning visibility requires fresh reads", async () => {
  const mock = upstream([first]); show({ devices: [first] });
  await screen.findByText(`Pin ${first.deviceId}`);
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
  expect(screen.queryByText(`Pin ${first.deviceId}`)).not.toBeInTheDocument();
  roster = [];
  mock.mockImplementation(async url => Response.json(String(url) === "/api/devices/runtime" ? { pins: [] } : { devices: [] }));
  visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
  await screen.findByText(/Pair a Pin through guided setup before approving/);
});

it("late mutation from an unmounted owner cannot restore inventory in the next owner view", async () => {
  const mock = upstream(); const view = show({ devices: [first] });
  await screen.findByRole("button", { name: "Approve shared speech" });
  let finish!: (response: Response) => void;
  mock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Approve shared speech" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm shared speech" }));
  await screen.findByRole("button", { name: "Waiting for Cosmos…" });
  const mutationSignal = mock.mock.calls.find(([, options]) => options?.method === "POST")?.[1]?.signal;
  view.unmount(); expect(mutationSignal?.aborted).toBe(true);
  mock.mockImplementation(async url => Response.json(String(url) === "/api/devices/runtime" ? { pins: [] } : { devices: [] }));
  show({ devices: [] });
  await screen.findByText(/Pair a Pin through guided setup before approving/);
  finish(Response.json({ pin: first }));
  await Promise.resolve(); await Promise.resolve();
  expect(screen.queryByText(`Pin ${first.deviceId}`)).not.toBeInTheDocument();
  expect(screen.queryByText(/Cosmos committed/)).not.toBeInTheDocument();
});

it("revocation succeeds with explicitly unknown current pairing without inventing a status", async () => {
  const mock = upstream([{ ...first, currentPaired: null }]); show({ devices: [], failed: true });
  await screen.findByRole("button", { name: "Revoke runtime approval" });
  expect(screen.getByText(/current pairing status is unknown/)).toBeVisible();
  expect(screen.queryByText(/this Pin is no longer paired/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approve shared speech" })).not.toBeInTheDocument();
  mock.mockImplementationOnce(async () => Response.json({ pin: { ...first, revoked: true, currentPaired: null } }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke runtime approval" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
  await screen.findByText(/Current pairing status is unavailable; revocation did not change pairing/);
  expect(screen.queryByRole("button", { name: "Approve shared speech" })).not.toBeInTheDocument();
});
