import { createHash } from "node:crypto";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NATIVE_SURFACE_POSTURE, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import { SPEECH_DISCLOSURE_APPROVAL } from "@/lib/contracts/speechDisclosure";
import { LOOKUP_SERVICES, type LookupProvider } from "@/lib/contracts/lookupDisclosure";
import { PRIVATE_DISPLAY_APPROVAL } from "@/lib/contracts/privateDisplay";
import { DeviceCard } from "./DeviceCard";
import { fingerprintLines } from "./fingerprint";

const fingerprint = createHash("sha256").update("device").digest("hex");
const row: NativeSurface = { ...NATIVE_SURFACE_POSTURE, surfaceId: "11111111-1111-4111-8111-111111111111", enrollmentId: "22222222-2222-4222-8222-222222222222",
  platform: "android", revision: 3, publicKeyFingerprint: fingerprint, revoked: false, display: true, speech: true, connected: true, visible: true, privateDisplay: false };
const searx: LookupProvider = { provider: "searxng", endpoint: "https://search.example.test/search", configurationDigest: "a".repeat(64) };
const serp: LookupProvider = { provider: "serp_api", endpoint: "https://serpapi.com/search.json", configurationDigest: "b".repeat(64) };
const google: LookupProvider = { provider: "google_places", endpoint: "https://places.googleapis.com/v1/places:searchText", configurationDigest: "c".repeat(64) };
const speechPolicy = { provider: { provider: "azure_speech", region: "westeurope" }, maximumClass: "shared_room", transcription: false, synthesis: true };
const base = `/api/surfaces/${row.surfaceId}`;
type Kind = "speech-disclosure" | "private-display" | "web-lookup" | "places-lookup";
type Approval = { approvalRevision: number; revision: number; policy: unknown } | null;
type Providers = { web: LookupProvider[]; places: LookupProvider[] };

/** A small honest Cosmos: reads answer from state, writes apply compare-and-set and echo the exact policy at the next revision. */
function cosmos(initial: Partial<Record<Kind, Approval>> = {}, providers: Providers = { web: [searx], places: [google] }, rejects: Kind[] = []) {
  const state: Record<Kind, Approval> = { "speech-disclosure": null, "private-display": null, "web-lookup": null, "places-lookup": null, ...initial };
  const view = (kind: Kind) => kind.endsWith("lookup")
    ? { approval: state[kind], providers: providers[kind === "web-lookup" ? "web" : "places"], binding: { approvalRevision: row.revision, incarnation: null } }
    : { approval: state[kind] };
  const mock = vi.fn(async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const kind = String(url).slice(base.length + 1) as Kind;
    if (!String(url).startsWith(`${base}/`) || !(kind in state)) throw new Error(`Unexpected request: ${url}`);
    if (options?.method === "POST") {
      const input = JSON.parse(String(options.body));
      if (rejects.includes(kind) || input.expectedRevision !== (state[kind]?.revision ?? 0)) return new Response(null, { status: 409 });
      state[kind] = { approvalRevision: row.revision, revision: input.expectedRevision + 1, policy: input.policy };
    }
    return Response.json(view(kind));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
type Cosmos = ReturnType<typeof cosmos>;
const posts = (mock: Cosmos) => mock.mock.calls.filter(([, options]) => options?.method === "POST");
const reads = (mock: Cosmos, kind: Kind) => mock.mock.calls.filter(([url, options]) => String(url) === `${base}/${kind}` && !options?.method);
const props = { row, servicesRegion: null as string | null, lastRegion: "", onRegionUsed: vi.fn(), offerSetup: false, busy: false, onRemove: vi.fn(), onRefreshDevices: vi.fn() };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); props.onRegionUsed.mockClear(); props.onRemove.mockClear(); props.onRefreshDevices.mockClear(); });

async function settled() { await waitFor(() => expect(screen.queryByText(/Checking/u)).not.toBeInTheDocument()); }
function manage() { fireEvent.click(screen.getByRole("button", { name: "Manage" })); }
const toggle = (name: string) => screen.getByRole("switch", { name });
async function setupResults() {
  fireEvent.click(screen.getByRole("button", { name: "Set up the usual permissions" }));
  const results = await screen.findByRole("list", { name: "Set-up results" });
  await waitFor(() => expect(within(results).queryByText("Working…")).not.toBeInTheDocument());
  return within(results).getAllByRole("listitem").map(item => item.textContent);
}

it("reads every permission on mount, never writes, and says what the device may do in plain words", async () => {
  const mock = cosmos({
    "speech-disclosure": { approvalRevision: 3, revision: 2, policy: speechPolicy },
    "web-lookup": { approvalRevision: 3, revision: 1, policy: { provider: searx, maximumClass: "shared_room" } },
    "private-display": { approvalRevision: 3, revision: 1, policy: { maximumClass: "private" } },
  });
  render(<DeviceCard {...props} />);
  expect(screen.getByRole("heading", { name: "Android phone" })).toBeVisible();
  expect(screen.getByText("Connected")).toBeVisible();
  await screen.findByText("Shows shared replies · Speaks replies · Looks things up · Shows private replies");
  for (const kind of ["speech-disclosure", "web-lookup", "places-lookup", "private-display"] as const) expect(reads(mock, kind)).toHaveLength(1);
  expect(posts(mock)).toHaveLength(0);
  expect(props.onRegionUsed).toHaveBeenCalledWith("westeurope");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByText(row.enrollmentId)).not.toBeInTheDocument();
  manage();
  expect(toggle("Speak replies")).toBeChecked();
  expect(toggle("Look things up on the web")).toBeChecked();
  expect(toggle("Find places")).not.toBeChecked();
  expect(toggle("Show private replies here")).toBeChecked();
  expect(screen.getByText(/Region: westeurope/u)).toBeVisible();
  expect(screen.getByText(/Uses SearXNG at/u)).toHaveTextContent(searx.endpoint);
  expect(screen.getByText("After you unlock this device and choose Continue, private replies appear only here. Cosmos cannot tell who is looking at the screen.")).toBeVisible();
  expect(screen.queryByText(/Only you can see this/u)).not.toBeInTheDocument();
  expect(screen.queryByText(row.enrollmentId)).not.toBeInTheDocument();
  expect(reads(mock, "speech-disclosure")).toHaveLength(1);
});

it("Speak replies posts the exact shared-text policy with the region from Services and turns off with an explicit null", async () => {
  const mock = cosmos(); render(<DeviceCard {...props} servicesRegion="westeurope" />); await settled(); manage();
  expect(screen.queryByLabelText("Azure Speech region")).not.toBeInTheDocument();
  expect(screen.getByText(/Uses the westeurope region from Services/u)).toBeVisible();
  fireEvent.click(toggle("Speak replies"));
  await screen.findByText("Cosmos confirmed spoken replies on this device.");
  const [url, options] = posts(mock)[0];
  expect(url).toBe(`${base}/speech-disclosure`);
  expect(options).toMatchObject({ method: "POST", headers: { "content-type": "application/json" }, cache: "no-store" });
  expect(JSON.parse(String(options?.body))).toEqual({ approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: speechPolicy });
  expect(toggle("Speak replies")).toBeChecked();
  expect(screen.getByText("Shows shared replies · Speaks replies")).toBeVisible();
  expect(props.onRegionUsed).toHaveBeenCalledWith("westeurope");
  fireEvent.click(toggle("Speak replies"));
  await screen.findByText("Cosmos confirmed spoken replies off.");
  expect(JSON.parse(String(posts(mock)[1][1]?.body))).toEqual({ approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: 3, expectedRevision: 1, policy: null });
  expect(toggle("Speak replies")).not.toBeChecked();
  expect(screen.getByText("Shows shared replies")).toBeVisible();
});

it("asks for the Azure region only when none is recorded or readable, prefilled with the last used region", async () => {
  const mock = cosmos(); const view = render(<DeviceCard {...props} lastRegion="northeurope" />); await settled(); manage();
  const field = screen.getByLabelText("Azure Speech region");
  expect(field).toHaveValue("northeurope");
  fireEvent.change(field, { target: { value: "" } });
  expect(toggle("Speak replies")).toBeDisabled();
  fireEvent.change(field, { target: { value: " WestEurope " } });
  expect(field).toHaveValue("westeurope");
  fireEvent.click(toggle("Speak replies"));
  await screen.findByText("Cosmos confirmed spoken replies on this device.");
  expect(JSON.parse(String(posts(mock)[0][1]?.body)).policy.provider.region).toBe("westeurope");
  expect(props.onRegionUsed).toHaveBeenCalledWith("westeurope");
  expect(screen.queryByLabelText("Azure Speech region")).not.toBeInTheDocument();
  expect(screen.getByText(/Region: westeurope/u)).toBeVisible();
  view.unmount();
  // A display-only approval from before spoken replies existed cannot turn them on.
  cosmos(); render(<DeviceCard {...props} row={{ ...row, speech: false }} servicesRegion="westeurope" />); await settled(); manage();
  expect(toggle("Speak replies")).toBeDisabled();
  expect(screen.getByText(/Approve this device again to allow spoken replies/u)).toBeVisible();
});

it("web lookup uses the single configured provider directly, offers a choice between two, and points to Services with none", async () => {
  const single = cosmos(); const first = render(<DeviceCard {...props} />); await settled(); manage();
  expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
  fireEvent.click(toggle("Look things up on the web"));
  await screen.findByText("Cosmos confirmed web lookup for this device.");
  expect(posts(single)[0][0]).toBe(`${base}/web-lookup`);
  expect(JSON.parse(String(posts(single)[0][1]?.body))).toEqual({ approval: LOOKUP_SERVICES.web.approval, approvalRevision: 3, approvalIncarnation: null,
    expectedRevision: 0, policy: { provider: searx, maximumClass: "shared_room" } });
  expect(screen.getByText(/Uses SearXNG at/u)).toHaveTextContent(searx.endpoint);
  expect(screen.getByText("Shows shared replies · Looks things up")).toBeVisible();
  fireEvent.click(toggle("Look things up on the web"));
  await screen.findByText("Cosmos confirmed web lookup off.");
  expect(JSON.parse(String(posts(single)[1][1]?.body))).toMatchObject({ expectedRevision: 1, policy: null });
  first.unmount();
  const two = cosmos({}, { web: [searx, serp], places: [google] }); const second = render(<DeviceCard {...props} />); await settled(); manage();
  const web = toggle("Look things up on the web");
  expect(web).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: `${serp.provider}:${serp.configurationDigest}` } });
  expect(web).toBeEnabled();
  fireEvent.click(web);
  await screen.findByText("Cosmos confirmed web lookup for this device.");
  expect(JSON.parse(String(posts(two)[0][1]?.body)).policy.provider).toEqual(serp);
  expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
  second.unmount();
  const none = cosmos({}, { web: [], places: [google] }); render(<DeviceCard {...props} />); await settled(); manage();
  expect(toggle("Look things up on the web")).toBeDisabled();
  expect(screen.getByText(/No search provider is set up in Services/u)).toBeVisible();
  expect(screen.getByRole("link", { name: "Services" })).toHaveAttribute("href", "/settings/account/services");
  expect(posts(none)).toHaveLength(0);
});

it("Find places posts the Google Maps provider for named-place text only", async () => {
  const mock = cosmos(); render(<DeviceCard {...props} />); await settled(); manage();
  expect(screen.getByText(/never this device’s location/u)).toBeVisible();
  fireEvent.click(toggle("Find places"));
  await screen.findByText("Cosmos confirmed place lookup for this device.");
  expect(posts(mock)[0][0]).toBe(`${base}/places-lookup`);
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ approval: LOOKUP_SERVICES.places.approval, approvalRevision: 3, approvalIncarnation: null,
    expectedRevision: 0, policy: { provider: google, maximumClass: "shared_room" } });
  expect(screen.getByText("Shows shared replies · Finds places")).toBeVisible();
});

it("a recorded provider that is no longer configured authorizes nothing: the line omits lookup and the switch says so", async () => {
  const changed = { ...searx, configurationDigest: "d".repeat(64) };
  const mock = cosmos({ "web-lookup": { approvalRevision: 3, revision: 4, policy: { provider: searx, maximumClass: "shared_room" } } }, { web: [changed], places: [google] });
  render(<DeviceCard {...props} />); await settled();
  expect(screen.getByText("Shows shared replies")).toBeVisible();
  manage();
  expect(toggle("Look things up on the web")).not.toBeChecked();
  expect(screen.getByText(/The provider set-up changed/u)).toBeVisible();
  fireEvent.click(toggle("Look things up on the web"));
  await screen.findByText("Cosmos confirmed web lookup for this device.");
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toMatchObject({ expectedRevision: 4, policy: { provider: changed } });
  expect(screen.queryByText(/The provider set-up changed/u)).not.toBeInTheDocument();
});

it("private replies post the private ceiling and revoke with null, while a TV never reads or offers them", async () => {
  const mock = cosmos(); const phone = render(<DeviceCard {...props} />); await settled(); manage();
  fireEvent.click(toggle("Show private replies here"));
  await screen.findByText("Cosmos confirmed private replies may appear here after you continue on this device.");
  expect(posts(mock)[0][0]).toBe(`${base}/private-display`);
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ approval: PRIVATE_DISPLAY_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: { maximumClass: "private" } });
  expect(screen.getByText("Shows shared replies · Shows private replies")).toBeVisible();
  fireEvent.click(toggle("Show private replies here"));
  await screen.findByText("Cosmos confirmed private replies off for this device.");
  expect(JSON.parse(String(posts(mock)[1][1]?.body))).toEqual({ approval: PRIVATE_DISPLAY_APPROVAL, approvalRevision: 3, expectedRevision: 1, policy: null });
  phone.unmount();
  const tv = cosmos({ "private-display": { approvalRevision: 3, revision: 1, policy: { maximumClass: "private" } } });
  render(<DeviceCard {...props} row={{ ...row, platform: "android_tv", privateDisplay: true }} />); await settled(); manage();
  expect(screen.getByRole("heading", { name: "Android TV" })).toBeVisible();
  expect(screen.queryByRole("switch", { name: "Show private replies here" })).not.toBeInTheDocument();
  expect(reads(tv, "private-display")).toHaveLength(0);
  expect(screen.queryByText(/Shows private replies/u)).not.toBeInTheDocument();
});

it("a lost reply clears the switch until a fresh read and never claims success", async () => {
  const mock = cosmos({ "speech-disclosure": { approvalRevision: 3, revision: 2, policy: speechPolicy } });
  render(<DeviceCard {...props} />); await settled(); manage();
  mock.mockRejectedValueOnce(new Error("response lost after commit"));
  fireEvent.click(toggle("Speak replies"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cosmos did not confirm the change.");
  expect(toggle("Speak replies")).toBeDisabled();
  expect(screen.queryByText("Cosmos confirmed spoken replies off.")).not.toBeInTheDocument();
  expect(screen.getByText(/Some settings could not be read/u)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(toggle("Speak replies")).toBeEnabled());
  expect(toggle("Speak replies")).toBeChecked();
  expect(reads(mock, "speech-disclosure")).toHaveLength(2);
  expect(posts(mock)).toHaveLength(1);
});

it("a successful reply with a different policy cannot confer UI authority", async () => {
  const mock = cosmos(); render(<DeviceCard {...props} servicesRegion="westeurope" />); await settled(); manage();
  mock.mockResolvedValueOnce(Response.json({ approval: { approvalRevision: 3, revision: 1, policy: { ...speechPolicy, transcription: true } } }));
  fireEvent.click(toggle("Speak replies"));
  await screen.findByRole("alert");
  expect(screen.queryByText("Cosmos confirmed spoken replies on this device.")).not.toBeInTheDocument();
  expect(toggle("Speak replies")).toBeDisabled();
});

it("a changed approval revision asks for a device refresh instead of writing", async () => {
  const mock = cosmos({ "speech-disclosure": { approvalRevision: 2, revision: 1, policy: speechPolicy } });
  render(<DeviceCard {...props} />); await settled(); manage();
  expect(screen.getByRole("alert")).toHaveTextContent("This device’s approval changed.");
  expect(toggle("Speak replies")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  expect(props.onRefreshDevices).toHaveBeenCalledTimes(1);
  expect(posts(mock)).toHaveLength(0);
});

it("the usual set-up reads each permission fresh, writes in sequence and reports every outcome honestly", async () => {
  const mock = cosmos({}, { web: [searx], places: [] });
  render(<DeviceCard {...props} servicesRegion="westeurope" offerSetup />); await settled();
  expect(screen.getByRole("group", { name: "Set up the usual permissions" })).toBeVisible();
  const before = mock.mock.calls.length;
  expect(await setupResults()).toEqual(["Speak replies — On.", "Look things up on the web — On.", "Find places — No place provider is set up in Services."]);
  const sequence = mock.mock.calls.slice(before).map(([url, options]) => `${options?.method ?? "GET"} ${String(url).slice(base.length + 1)}`);
  expect(sequence).toEqual(["GET speech-disclosure", "POST speech-disclosure", "GET web-lookup", "POST web-lookup", "GET places-lookup"]);
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: speechPolicy });
  expect(JSON.parse(String(posts(mock)[1][1]?.body)).policy).toEqual({ provider: searx, maximumClass: "shared_room" });
  expect(toggle("Speak replies")).toBeChecked();
  expect(toggle("Look things up on the web")).toBeChecked();
  expect(toggle("Find places")).not.toBeChecked();
  expect(screen.getByText("Shows shared replies · Speaks replies · Looks things up")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Set up the usual permissions" })).not.toBeInTheDocument();
});

it("the usual set-up skips what is already on, reports a needed choice and never fakes a rejected step", async () => {
  const mock = cosmos({ "speech-disclosure": { approvalRevision: 3, revision: 2, policy: speechPolicy } }, { web: [searx, serp], places: [google] }, ["places-lookup"]);
  render(<DeviceCard {...props} offerSetup />); await settled();
  expect(await setupResults()).toEqual(["Speak replies — Already on.", "Look things up on the web — Choose a provider below, then turn it on.",
    "Find places — Not confirmed. Check its switch below."]);
  expect(posts(mock)).toHaveLength(1);
  expect(posts(mock)[0][0]).toBe(`${base}/places-lookup`);
  expect(toggle("Find places")).toBeDisabled();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByLabelText("Provider")).toBeEnabled();
  expect(screen.queryByText("Cosmos confirmed place lookup for this device.")).not.toBeInTheDocument();
});

it("Details shows identifiers on demand and Remove this device asks first, then hands the exact row to the page", async () => {
  cosmos(); render(<DeviceCard {...props} />); await settled(); manage();
  expect(screen.queryByText(row.enrollmentId)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(row.enrollmentId)).toBeVisible();
  for (const line of fingerprintLines(fingerprint)) expect(screen.getByText(line)).toBeVisible();
  expect(screen.getByText("Platform").nextElementSibling).toHaveTextContent("Android");
  expect(screen.getByText("Approval revision").nextElementSibling).toHaveTextContent("3");
  expect(screen.getByText(/Approval is not proof of a connection or of delivery/u)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Remove this device" }));
  expect(screen.getByText(/Remove this device\? It stops showing replies/u)).toBeVisible();
  expect(props.onRemove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove this device" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(props.onRemove).toHaveBeenCalledWith(row);
});
