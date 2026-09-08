import { createHash } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { legacySpeechPosture, legacyVoicePosture, nativePosture, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import { SPEECH_DISCLOSURE_APPROVAL } from "@/lib/contracts/speechDisclosure";
import { LOOKUP_SERVICES, type LookupProvider } from "@/lib/contracts/lookupDisclosure";
import { PRIVATE_DISPLAY_APPROVAL } from "@/lib/contracts/privateDisplay";
import { SCREEN_CONTEXT_APPROVAL } from "@/lib/contracts/screenContext";
import { DeviceCard } from "./DeviceCard";
import { fingerprintLines } from "./fingerprint";

const fingerprint = createHash("sha256").update("device").digest("hex");
const row: NativeSurface = { ...nativePosture("android"), surfaceId: "11111111-1111-4111-8111-111111111111", enrollmentId: "22222222-2222-4222-8222-222222222222",
  platform: "android", revision: 3, publicKeyFingerprint: fingerprint, revoked: false, display: true, speech: true,
  actions: ["action.open", "action.route"], confirms: true, audience: "handheld", connected: true, visible: true, privateDisplay: false };
const searx: LookupProvider = { provider: "searxng", endpoint: "https://search.example.test/search", configurationDigest: "a".repeat(64) };
const serp: LookupProvider = { provider: "serp_api", endpoint: "https://serpapi.com/search.json", configurationDigest: "b".repeat(64) };
const google: LookupProvider = { provider: "google_places", endpoint: "https://places.googleapis.com/v1/places:searchText", configurationDigest: "c".repeat(64) };
const speechPolicy = { provider: { provider: "azure_speech", region: "westeurope" }, maximumClass: "shared_room", transcription: false, synthesis: true };
const base = `/api/surfaces/${row.surfaceId}`;
type Kind = "speech-disclosure" | "private-display" | "screen-context" | "web-lookup" | "places-lookup" | "device-actions" | "device-commands";
type Approval = { approvalRevision: number; revision: number; policy: unknown } | null;
type Providers = { web: LookupProvider[]; places: LookupProvider[] };

/** A small honest Cosmos: reads answer from state, writes apply compare-and-set and echo the exact policy at the next revision. */
function cosmos(initial: Partial<Record<Kind, Approval>> = {}, providers: Providers = { web: [searx], places: [google] }, rejects: Kind[] = [], forbids: Kind[] = []) {
  const state: Record<Kind, Approval> = { "speech-disclosure": null, "private-display": null, "screen-context": null, "web-lookup": null, "places-lookup": null,
    "device-actions": null, "device-commands": null, ...initial };
  const view = (kind: Kind) => kind.endsWith("lookup")
    ? { approval: state[kind], providers: providers[kind === "web-lookup" ? "web" : "places"], binding: { approvalRevision: row.revision, incarnation: null } }
    : { approval: state[kind] };
  const mock = vi.fn(async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const kind = String(url).slice(base.length + 1) as Kind;
    if (!String(url).startsWith(`${base}/`) || !(kind in state)) throw new Error(`Unexpected request: ${url}`);
    if (options?.method === "POST") {
      const input = JSON.parse(String(options.body));
      // A definite no from Cosmos: the policy is well formed and it declined it.
      if (forbids.includes(kind)) return Response.json({ error: "forbidden" }, { status: 403 });
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
  expect(screen.getByRole("heading", { name: "Phone" })).toBeVisible();
  expect(screen.getByText("Connected")).toBeVisible();
  await screen.findByText("Shows shared replies · Speaks replies · Looks things up · Private features unavailable");
  for (const kind of ["speech-disclosure", "web-lookup", "places-lookup", "private-display", "screen-context"] as const) expect(reads(mock, kind)).toHaveLength(1);
  expect(posts(mock)).toHaveLength(0);
  // The summary renders before useSpeechRegion's passive effect reports the
  // saved region to the page. Wait for that separate observable effect.
  await waitFor(() => expect(props.onRegionUsed).toHaveBeenCalledWith("westeurope"));
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByText(row.enrollmentId)).not.toBeInTheDocument();
  manage();
  expect(toggle("Speak replies")).toBeChecked();
  expect(toggle("Look things up on the web")).toBeChecked();
  expect(toggle("Find places")).not.toBeChecked();
  expect(toggle("Show private replies here")).toBeChecked();
  expect(toggle("Use what's on the screen")).not.toBeChecked();
  expect(screen.getByText(/Region: westeurope/u)).toBeVisible();
  expect(screen.getByText(/Uses SearXNG at/u)).toHaveTextContent(searx.endpoint);
  expect(screen.getByText("Private replies are unavailable until room privacy can be verified. This saves your preference.")).toBeVisible();
  expect(screen.getByText("Cosmos cannot tell who is looking at the screen.")).toBeVisible();
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
  await screen.findByText("Preference saved. Private replies still need verified room privacy.");
  expect(posts(mock)[0][0]).toBe(`${base}/private-display`);
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ approval: PRIVATE_DISPLAY_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: { maximumClass: "private" } });
  expect(screen.getByText("Shows shared replies · Private features unavailable")).toBeVisible();
  fireEvent.click(toggle("Show private replies here"));
  await screen.findByText("Cosmos confirmed private replies off for this device.");
  expect(JSON.parse(String(posts(mock)[1][1]?.body))).toEqual({ approval: PRIVATE_DISPLAY_APPROVAL, approvalRevision: 3, expectedRevision: 1, policy: null });
  phone.unmount();
  const tv = cosmos({ "private-display": { approvalRevision: 3, revision: 1, policy: { maximumClass: "private" } } });
  render(<DeviceCard {...props} row={{ ...row, platform: "android_tv", privateDisplay: true }} />); await settled(); manage();
  expect(screen.getByRole("heading", { name: "TV" })).toBeVisible();
  expect(screen.queryByRole("switch", { name: "Show private replies here" })).not.toBeInTheDocument();
  expect(reads(tv, "private-display")).toHaveLength(0);
  expect(screen.queryByText(/Private features unavailable/u)).not.toBeInTheDocument();
});

it("screen context posts the private policy on a phone, revokes with null, is hidden on a TV, and is a switch but not a set-up step on a Mac", async () => {
  const mock = cosmos(); const phone = render(<DeviceCard {...props} />); await settled(); manage();
  expect(screen.getByText("This saves permission to use selected screen text when private requests become available.")).toBeVisible();
  expect(screen.getByText("Screen requests are currently unavailable because room privacy cannot be verified.")).toBeVisible();
  fireEvent.click(toggle("Use what's on the screen"));
  await screen.findByText("Permission saved. Screen requests still need verified room privacy.");
  expect(posts(mock)[0][0]).toBe(`${base}/screen-context`);
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ approval: SCREEN_CONTEXT_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: { maximumClass: "private" } });
  expect(screen.getByText("Shows shared replies · Private features unavailable")).toBeVisible();
  fireEvent.click(toggle("Use what's on the screen"));
  await screen.findByText("Cosmos confirmed screen context off for this device.");
  expect(JSON.parse(String(posts(mock)[1][1]?.body))).toEqual({ approval: SCREEN_CONTEXT_APPROVAL, approvalRevision: 3, expectedRevision: 1, policy: null });
  expect(screen.getByText("Shows shared replies")).toBeVisible();
  phone.unmount();
  const tv = cosmos({ "screen-context": { approvalRevision: 3, revision: 1, policy: { maximumClass: "private" } } });
  const television = render(<DeviceCard {...props} row={{ ...row, platform: "android_tv" }} offerSetup />); await settled();
  // Offering set-up opens Manage, so the TV's switches are already on view.
  expect(screen.getByText("Turn on spoken replies, web lookup and place lookup in one go. Cosmos confirms each one separately.")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Speak replies" })).toBeVisible();
  expect(screen.queryByRole("switch", { name: "Use what's on the screen" })).not.toBeInTheDocument();
  expect(reads(tv, "screen-context")).toHaveLength(0);
  expect(screen.queryByText(/Private features unavailable/u)).not.toBeInTheDocument();
  television.unmount();
  const mac = cosmos({ "screen-context": { approvalRevision: 3, revision: 1, policy: { maximumClass: "private" } } }, { web: [searx], places: [] });
  render(<DeviceCard {...props} row={{ ...row, platform: "macos" }} servicesRegion="westeurope" offerSetup />); await settled();
  expect(screen.getByText("Shows shared replies · Private features unavailable")).toBeVisible();
  expect(await setupResults()).toEqual(["Speak replies — On.", "Look things up on the web — On.", "Find places — No place provider is set up in Services."]);
  expect(posts(mac).map(([url]) => String(url).slice(base.length + 1))).toEqual(["speech-disclosure", "web-lookup"]);
  expect(toggle("Use what's on the screen")).toBeChecked();
  expect(reads(mac, "screen-context")).toHaveLength(1);
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
  expect(screen.getByText("Turn on spoken replies, web lookup and place lookup in one go. Cosmos confirms each one separately.")).toBeVisible();
  expect(await setupResults()).toEqual(["Speak replies — On.", "Look things up on the web — On.", "Find places — No place provider is set up in Services.",
    "Use what's on the screen — Unavailable until room privacy can be verified."]);
  const sequence = mock.mock.calls.slice(before).map(([url, options]) => `${options?.method ?? "GET"} ${String(url).slice(base.length + 1)}`);
  expect(sequence).toEqual(["GET speech-disclosure", "POST speech-disclosure", "GET web-lookup", "POST web-lookup", "GET places-lookup"]);
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: 3, expectedRevision: 0, policy: speechPolicy });
  expect(JSON.parse(String(posts(mock)[1][1]?.body)).policy).toEqual({ provider: searx, maximumClass: "shared_room" });
  expect(posts(mock)).toHaveLength(2);
  expect(toggle("Speak replies")).toBeChecked();
  expect(toggle("Look things up on the web")).toBeChecked();
  expect(toggle("Find places")).not.toBeChecked();
  expect(toggle("Use what's on the screen")).not.toBeChecked();
  expect(screen.getByText("Shows shared replies · Speaks replies · Looks things up")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Set up the usual permissions" })).not.toBeInTheDocument();
});

it("the usual set-up skips what is already on, reports a needed choice and never fakes a rejected step", async () => {
  const mock = cosmos({ "speech-disclosure": { approvalRevision: 3, revision: 2, policy: speechPolicy } }, { web: [searx, serp], places: [google] }, ["places-lookup"]);
  render(<DeviceCard {...props} offerSetup />); await settled();
  expect(await setupResults()).toEqual(["Speak replies — Already on.", "Look things up on the web — Choose a provider below, then turn it on.",
    "Find places — Not confirmed. Check its switch below.", "Use what's on the screen — Unavailable until room privacy can be verified."]);
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

/*
 * The two permissions that let a device do something rather than show or say
 * something. Both write one whole policy document, so a half-written list is
 * never sent and the switch alone never grants anything.
 */
const mac: NativeSurface = { ...nativePosture("macos"), ...row, platform: "macos", manifest: nativePosture("macos").manifest,
  actions: ["action.open", "action.run"], confirms: true, audience: "desk" };
const tv: NativeSurface = { ...nativePosture("android_tv"), ...row, platform: "android_tv", manifest: nativePosture("android_tv").manifest,
  actions: ["action.play"], confirms: false, audience: "room" };
const add = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

it("says once that these apply to this device only, and offers only the operations this device's manifest declares", async () => {
  cosmos(); render(<DeviceCard {...props} />); await settled(); manage();
  expect(screen.getAllByText("These two permissions apply to this device only. Nothing here changes what any other device may do.")).toHaveLength(1);
  // A phone declares open and route, and never a task.
  expect(toggle("Let this device act")).toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: "Tasks on this device" })).not.toBeInTheDocument();
  cleanup();
  cosmos(); render(<DeviceCard {...props} row={tv} />); await settled(); manage();
  expect(toggle("Let this device act")).toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: "Tasks on this device" })).not.toBeInTheDocument();
  // A permission grant cannot supply the missing media identity.
  fireEvent.click(toggle("Let this device act"));
  expect(screen.getByText(/This build cannot verify the exact film or trailer/u)).toBeVisible();
  expect(screen.getByText(/the result remains “Cannot confirm” even when the player starts/u)).toBeVisible();
  expect(screen.queryByLabelText("Website")).not.toBeInTheDocument();
  cleanup();
  // An approval from before device actions existed can hold neither.
  cosmos(); render(<DeviceCard {...props} row={{ ...row, actions: [], confirms: false }} />); await settled(); manage();
  expect(screen.queryByRole("switch", { name: "Let this device act" })).not.toBeInTheDocument();
  expect(screen.getByText(/Approve it again to choose what it may open, play or run/u)).toBeVisible();
});

it("Let this device act writes the whole list once, sorted, and never a permission that names nothing", async () => {
  const mock = cosmos(); render(<DeviceCard {...props} />); await settled(); manage();
  fireEvent.click(toggle("Let this device act"));
  expect(posts(mock)).toHaveLength(0);
  expect(screen.getByText("Add at least one thing this device may act on, then choose Save.")).toBeVisible();
  const save = screen.getByRole("button", { name: "Save what it may do" });
  expect(save).toBeDisabled();
  add("Website", " ZED.dev ");
  fireEvent.click(screen.getByRole("button", { name: "Add website" }));
  add("Website", "github.com");
  fireEvent.click(screen.getByRole("button", { name: "Add website" }));
  fireEvent.click(screen.getByLabelText("Let it show the way to a place in Google Maps"));
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await screen.findByText("Cosmos confirmed what this device may do.");
  expect(posts(mock)).toHaveLength(1);
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({
    approval: "approve-device-actions-v1", approvalRevision: 3, expectedRevision: 0,
    // Sorted, because that is the list Cosmos stores and echoes back.
    policy: { maximumClass: "shared_room", open: { hosts: ["github.com", "zed.dev"], apps: [], roots: [] }, route: { app: "google_maps" } },
  });
  expect(screen.getByText("Shows shared replies · Acts on your behalf")).toBeVisible();
  fireEvent.click(toggle("Let this device act"));
  await screen.findByText("Cosmos confirmed this device may no longer act.");
  expect(JSON.parse(String(posts(mock)[1][1]?.body))).toMatchObject({ expectedRevision: 1, policy: null });
});

it("caps action content at the shared-room ceiling even with a private-display preference", async () => {
  cosmos(); render(<DeviceCard {...props} />); await settled(); manage();
  fireEvent.click(toggle("Let this device act"));
  const field = screen.getByLabelText("The most private thing this may carry") as HTMLSelectElement;
  expect(Array.from(field.options).map(option => option.value)).toEqual(["public", "shared_room"]);
  expect(screen.getByText(/A private-display preference cannot verify room privacy/u)).toBeVisible();
  cleanup();
  // A saved preference never raises the physical output ceiling.
  cosmos({ "private-display": { approvalRevision: 3, revision: 1, policy: { maximumClass: "private" } } });
  render(<DeviceCard {...props} />); await settled(); manage();
  fireEvent.click(toggle("Let this device act"));
  const raised = screen.getByLabelText("The most private thing this may carry") as HTMLSelectElement;
  expect(Array.from(raised.options).map(option => option.value)).toEqual(["public", "shared_room"]);
  expect(screen.getByText(/A private-display preference cannot verify room privacy/u)).toBeVisible();
});

it("Tasks on this device is macOS only, fixes argv one part per line, and stops at eight", async () => {
  const mock = cosmos(); render(<DeviceCard {...props} row={mac} />); await settled(); manage();
  fireEvent.click(toggle("Tasks on this device"));
  expect(screen.getByText(/Cosmos can ask this Mac to run one of them; it can never write a command/u)).toBeVisible();
  const addTask = () => fireEvent.click(screen.getByRole("button", { name: "Add task" }));
  expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
  add("What you call it", "Project tests");
  add("Short name", "project-tests");
  add("The command, one part per line", "./revival\ncheck cosmos\n\n");
  add("Folder it runs in", "/Users/owner/Projects/app");
  fireEvent.click(screen.getByLabelText("This task changes files"));
  add("Give up after", "120");
  addTask();
  fireEvent.click(screen.getByRole("button", { name: "Save these tasks" }));
  await screen.findByText("Cosmos confirmed the tasks this device may run.");
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({
    approval: "approve-device-command-v1", approvalRevision: 3, expectedRevision: 0,
    policy: { maximumClass: "shared_room", offerOutputToCognition: false, entries: [{
      // "check cosmos" is ONE argument: there is no shell here to split it.
      id: "project-tests", label: "Project tests", argv: ["./revival", "check cosmos"],
      cwd: "/Users/owner/Projects/app", mutates: true, budgetMs: 120_000,
    }] },
  });
  expect(screen.getByText("Shows shared replies · Runs your tasks")).toBeVisible();
  // Eight is the most this device can hold, and the editor says so rather than failing at the route.
  for (let index = 1; index < 8; index++) {
    add("What you call it", `Task ${index}`);
    add("Short name", `task-${index}`);
    add("The command, one part per line", "./revival");
    add("Folder it runs in", "/Users/owner");
    addTask();
  }
  expect(screen.getByText("Eight tasks is the most this device can hold. Remove one to add another.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
  expect(screen.getByText(/of 4096 bytes used/u)).toBeVisible();
});

it("says what to do about a task label Cosmos calls too sensitive, and changes nothing", async () => {
  const mock = cosmos({}, { web: [searx], places: [google] }, [], ["device-commands"]);
  render(<DeviceCard {...props} row={mac} />); await settled(); manage();
  fireEvent.click(toggle("Tasks on this device"));
  add("What you call it", "Export my medical records");
  add("Short name", "export-records");
  add("The command, one part per line", "./export");
  add("Folder it runs in", "/Users/owner");
  fireEvent.click(screen.getByRole("button", { name: "Add task" }));
  fireEvent.click(screen.getByRole("button", { name: "Save these tasks" }));
  await screen.findByText("Rename this task: Cosmos treats that wording as too sensitive to route anywhere.");
  expect(posts(mock)).toHaveLength(1);
  // A definite no changed nothing, so the entry the owner wrote is still there to rename.
  expect(screen.getByText("Export my medical records")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Tasks on this device" })).toBeChecked();
  // Nothing needs re-reading and nothing needs to be turned back on: the switch
  // still works, and the "it may still have been saved" sentence would be a lie.
  expect(screen.getByRole("switch", { name: "Tasks on this device" })).toBeEnabled();
  expect(screen.getByText("Cosmos would not accept this. Nothing changed.")).toBeVisible();
  expect(screen.queryByText(/may still have been saved/u)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
});

it("lets a phone be allowed only to show the way somewhere, without a list it never wanted", async () => {
  const mock = cosmos(); render(<DeviceCard {...props} />); await settled(); manage();
  fireEvent.click(toggle("Let this device act"));
  // An open block that names nothing is not a permission, so it is dropped
  // rather than making a route-only phone unsavable.
  fireEvent.click(screen.getByLabelText("Let it show the way to a place in Google Maps"));
  fireEvent.click(screen.getByRole("button", { name: "Save what it may do" }));
  await screen.findByText("Cosmos confirmed what this device may do.");
  expect(JSON.parse(String(posts(mock)[0][1]?.body)).policy).toEqual({ maximumClass: "shared_room", route: { app: "google_maps" } });
});

/*
 * Cosmos sends a reply to the screen that suits it, so the owner should be
 * able to read which kind of screen each device is. It is what the device
 * declared when it was approved, not what operating system it runs — and a
 * device that has never declared one says exactly that.
 */
it("says in plain words what kind of screen the device is, from what it declared and not from its platform", async () => {
  const cases: [NativeSurface, string][] = [
    [row, "This one travels with you."],
    [mac, "This is a screen you sit at."],
    [tv, "Everyone in the room can see this one."],
    [{ ...row, ...legacySpeechPosture(), audience: null, actions: [], confirms: false },
      "This device has not said what kind of screen it is. Approve it again and Cosmos can send each reply to the screen that suits it."],
  ];
  for (const [device, expected] of cases) {
    cosmos(); render(<DeviceCard {...props} row={device} />); await settled(); manage();
    expect(screen.getByText(expected)).toBeVisible();
    // It is a statement, never a control: nothing here changes it.
    expect(screen.queryByRole("switch", { name: expected })).toBeNull();
    // And it never names the operating system where the owner reads it.
    for (const jargon of [/audience/iu, /handheld/iu, /manifest/iu, /profile/iu]) expect(screen.queryByText(jargon)).toBeNull();
    cleanup(); vi.unstubAllGlobals();
  }
});

/** A device still on an older profile is the reason the line exists; reapproving is the one thing to do. */
it("tells a device that has not declared a screen apart from one that has", async () => {
  const older: NativeSurface = { ...mac, ...legacyVoicePosture("macos"), audience: null };
  cosmos(); render(<DeviceCard {...props} row={older} />); await settled(); manage();
  expect(screen.getByText(/has not said what kind of screen it is/u)).toBeVisible();
  expect(screen.queryByText("This is a screen you sit at.")).toBeNull();
  cleanup(); vi.unstubAllGlobals();
  cosmos(); render(<DeviceCard {...props} row={mac} />); await settled(); manage();
  expect(screen.getByText("This is a screen you sit at.")).toBeVisible();
  expect(screen.queryByText(/has not said what kind of screen it is/u)).toBeNull();
});
