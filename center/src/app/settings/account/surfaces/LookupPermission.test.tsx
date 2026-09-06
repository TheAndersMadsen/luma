import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LookupPermission } from "./LookupPermission";
import { LOOKUP_SERVICES, type LookupBinding, type LookupPolicy, type LookupProvider } from "@/lib/contracts/lookupDisclosure";

const surfaceId = "11111111-1111-4111-8111-111111111111";
const searx: LookupProvider = { provider: "searxng", endpoint: "https://search.example.test/search", configurationDigest: "a".repeat(64) };
const serp: LookupProvider = { provider: "serp_api", endpoint: "https://serpapi.com/search.json", configurationDigest: "b".repeat(64) };
const google: LookupProvider = { provider: "google_places", endpoint: "https://places.googleapis.com/v1/places:searchText", configurationDigest: "c".repeat(64) };
const policy: LookupPolicy = { provider: searx, maximumClass: "shared_room" };
const approval = { approvalRevision: 3, revision: 5, policy };
const binding: LookupBinding = { approvalRevision: 3, incarnation: null };
const browserIncarnation = "22222222-2222-4222-8222-222222222222";
const props = { service: "web" as const, surfaceId, approvalRevision: 3, label: "test installation", canApprove: true, onRefreshApprovals: vi.fn(async () => {}) };
const success = "Cosmos confirmed web lookup permission for this device.";
const revoked = "Cosmos confirmed web lookup permission revoked.";
const state = (saved: unknown = null, providers: LookupProvider[] = [searx, serp], current: LookupBinding = binding) => ({ approval: saved, providers, binding: current });
const response = (saved: unknown = null, providers: LookupProvider[] = [searx, serp], current: LookupBinding = binding) => Response.json(state(saved, providers, current));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); props.onRefreshApprovals.mockClear(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Web lookup permission" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh web lookup permission" })).toBeEnabled());
}
function choose(provider = searx) {
  fireEvent.change(screen.getByLabelText("Web search provider"), { target: { value: `${provider.provider}:${provider.configurationDigest}` } });
  fireEvent.click(screen.getByRole("button", { name: "Review web lookup permission" }));
}
function allow() { fireEvent.click(screen.getByRole("button", { name: "Allow shared-room web lookup" })); }
function revoke() {
  fireEvent.click(screen.getByRole("button", { name: "Revoke web lookup permission" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke web lookup" }));
}
function posts(mock: ReturnType<typeof vi.fn>) { return mock.mock.calls.filter(([, options]) => options?.method === "POST"); }

it("requires owner selection and review of the exact provider and shared-room query class before saving", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => response());
  vi.stubGlobal("fetch", mock); render(<LookupPermission {...props} />);
  expect(mock).not.toHaveBeenCalled(); await open();
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
  expect(screen.getByText(/Private memories, messages, documents and precise device location/)).toBeVisible();
  choose(serp);
  const review = within(screen.getByRole("group", { name: "Review web lookup permission" }));
  expect(review.getByText(serp.endpoint)).toBeVisible();
  expect(review.getByText("Google web search through SerpApi.")).toBeVisible();
  expect(review.getByText("shared-room query text")).toBeVisible();
  expect(posts(mock)).toHaveLength(0);
  fireEvent.click(review.getByRole("button", { name: "Cancel web lookup review" }));
  expect(posts(mock)).toHaveLength(0); choose(serp);
  const pending = deferred<Response>(); mock.mockReturnValueOnce(pending.promise); allow(); allow();
  expect(posts(mock)).toHaveLength(1);
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  const selectedPolicy = { provider: serp, maximumClass: "shared_room" };
  const [url, options] = posts(mock)[0];
  expect(url).toBe(`/api/surfaces/${surfaceId}/web-lookup`);
  expect(options).toMatchObject({ method: "POST", headers: { "content-type": "application/json" }, cache: "no-store" });
  expect(JSON.parse(String(options.body))).toEqual({ approval: LOOKUP_SERVICES.web.approval, approvalRevision: 3, approvalIncarnation: null, expectedRevision: 0, policy: selectedPolicy });
  await act(async () => { pending.resolve(response({ approvalRevision: 3, revision: 1, policy: selectedPolicy })); });
  await screen.findByText(success);
});

it("changing a reviewed provider removes confirmation until the new provider is reviewed", async () => {
  const mock = vi.fn(async () => response()); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} />); await open(); choose();
  fireEvent.change(screen.getByLabelText("Web search provider"), { target: { value: `${serp.provider}:${serp.configurationDigest}` } });
  expect(screen.queryByRole("button", { name: "Allow shared-room web lookup" })).not.toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(1);
});

it("requires a fresh permission read after a lost write, then uses its actual policy revision", async () => {
  const mock = vi.fn(async () => response(approval)); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} />); await open(); choose();
  mock.mockRejectedValueOnce(new Error("response lost after commit")); allow();
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Revoke web lookup permission" })).toBeDisabled();
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  mock.mockResolvedValueOnce(response({ ...approval, revision: 6 }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh web lookup permission" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke web lookup permission" })).toBeEnabled());
  mock.mockResolvedValueOnce(response({ ...approval, revision: 7, policy: null })); revoke();
  await screen.findByText(revoked);
  expect(JSON.parse(String(posts(mock)[1][1].body))).toEqual({ approval: LOOKUP_SERVICES.web.approval, approvalRevision: 3, approvalIncarnation: null, expectedRevision: 6, policy: null });
});

it("allows explicit revocation after pairing and provider loss while disabling new grants", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => options?.method === "POST"
    ? response({ ...approval, revision: 6, policy: null }, []) : response(approval, []));
  vi.stubGlobal("fetch", mock); render(<LookupPermission {...props} canApprove={false} />); await open();
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
  expect(screen.getByLabelText("Web search provider")).toBeDisabled();
  expect(screen.getByRole("link", { name: "Services" })).toHaveAttribute("href", "/settings/account/services");
  fireEvent.click(screen.getByRole("button", { name: "Revoke web lookup permission" }));
  expect(posts(mock)).toHaveLength(0);
  expect(screen.getByText(/cannot recall queries already sent/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke web lookup" }));
  await screen.findByText(revoked);
  expect(JSON.parse(String(posts(mock)[0][1].body)).policy).toBeNull();
});

it("never treats an old provider digest as the current configuration and requires a new review", async () => {
  const changed = { ...searx, configurationDigest: "c".repeat(64) };
  const mock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => response(approval, [changed]));
  vi.stubGlobal("fetch", mock); render(<LookupPermission {...props} />); await open();
  expect(screen.getByText(/provider configuration changed or is unavailable/)).toBeVisible();
  expect(screen.getByLabelText("Web search provider")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
  choose(changed);
  expect(within(screen.getByRole("group", { name: "Review web lookup permission" })).getByText(/Bing engine requests/)).toBeVisible();
  mock.mockResolvedValueOnce(response({ ...approval, revision: 6, policy: { ...policy, provider: changed } }, [changed])); allow();
  await screen.findByText(success);
  expect(JSON.parse(String(posts(mock)[0][1].body)).policy.provider).toEqual(changed);
});

it("a conflict requires a new atomic binding read and review before another mutation", async () => {
  const original = { approvalRevision: 8, incarnation: browserIncarnation };
  const mock = vi.fn(async () => response(approval, [searx], original)); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} revisionMayAdvance />); await open(); choose();
  mock.mockResolvedValueOnce(new Response(null, { status: 409 })); allow();
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Allow shared-room web lookup" })).not.toBeInTheDocument();
  expect(posts(mock)).toHaveLength(1);
  const changed = { approvalRevision: 12, incarnation: "33333333-3333-4333-8333-333333333333" };
  mock.mockResolvedValueOnce(response(null, [searx], changed));
  fireEvent.click(screen.getByRole("button", { name: "Refresh web lookup permission" }));
  await waitFor(() => expect(screen.getByLabelText("Web search provider")).toBeEnabled());
  choose();
  mock.mockResolvedValueOnce(response({ approvalRevision: 12, revision: 1, policy }, [searx], changed)); allow();
  await screen.findByText(success);
  expect(JSON.parse(String(posts(mock)[1][1].body))).toMatchObject({ approvalRevision: 12, approvalIncarnation: changed.incarnation, expectedRevision: 0 });
});

it("preserves a browser review across heartbeat row updates and posts the fetched binding for grant and revoke", async () => {
  const original = { approvalRevision: 8, incarnation: browserIncarnation };
  const mock = vi.fn(async () => response(null, [searx], original));
  vi.stubGlobal("fetch", mock);
  const view = render(<LookupPermission {...props} revisionMayAdvance />); await open(); choose();
  view.rerender(<LookupPermission {...props} approvalRevision={10} revisionMayAdvance />);
  expect(screen.getByRole("button", { name: "Allow shared-room web lookup" })).toBeVisible();
  expect(mock).toHaveBeenCalledTimes(1);
  const advanced = { ...original, approvalRevision: 11 };
  mock.mockResolvedValueOnce(response({ approvalRevision: 8, revision: 1, policy }, [searx], advanced)); allow();
  await screen.findByText(success);
  expect(JSON.parse(String(posts(mock)[0][1].body))).toMatchObject({ approvalRevision: 8, approvalIncarnation: browserIncarnation, expectedRevision: 0 });
  mock.mockResolvedValueOnce(response({ approvalRevision: 11, revision: 2, policy: null }, [searx], { ...advanced, approvalRevision: 12 }));
  revoke(); await screen.findByText(revoked);
  expect(JSON.parse(String(posts(mock)[1][1].body))).toMatchObject({ approvalRevision: 11, approvalIncarnation: browserIncarnation, expectedRevision: 1 });
});

it.each([false, true])("rejects a saved policy revision ahead of the atomic binding (browser=%s)", async revisionMayAdvance => {
  const mock = vi.fn(async () => response({ ...approval, approvalRevision: 4 }, [searx],
    { ...binding, incarnation: revisionMayAdvance ? browserIncarnation : null })); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} revisionMayAdvance={revisionMayAdvance} />);
  fireEvent.click(screen.getByRole("button", { name: "Web lookup permission" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh web lookup permission" })).toBeEnabled();
  expect(posts(mock)).toHaveLength(0);
});

it("requires a current native or Pin parent approval when its atomic binding revision changed", async () => {
  const changed = { approvalRevision: 4, incarnation: null };
  const mock = vi.fn(async () => response(null, [searx], changed)); vi.stubGlobal("fetch", mock);
  const view = render(<LookupPermission {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Web lookup permission" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Refresh web lookup permission" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh device approvals" }));
  expect(props.onRefreshApprovals).toHaveBeenCalledTimes(1);
  view.rerender(<LookupPermission {...props} approvalRevision={4} />); await open();
  expect(screen.getByLabelText("Web search provider")).toBeEnabled();
});

it.each([
  { browser: true, savedBinding: { approvalRevision: 3, incarnation: "33333333-3333-4333-8333-333333333333" } },
  { browser: true, savedBinding: { approvalRevision: 2, incarnation: browserIncarnation } },
  { browser: false, savedBinding: { approvalRevision: 4, incarnation: null } },
])("rejects a successful response for a changed incarnation or invalid binding revision %#", async ({ browser, savedBinding }) => {
  const original = { ...binding, incarnation: browser ? browserIncarnation : null };
  const mock = vi.fn(async () => response(approval, [searx], original)); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} revisionMayAdvance={browser} />); await open(); choose();
  mock.mockResolvedValueOnce(response({ ...approval, revision: 6 }, [searx], savedBinding)); allow();
  await screen.findByRole("alert");
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
});

it.each([false, true])("rejects the other platform's nullable binding shape (browser=%s)", async browser => {
  const mock = vi.fn(async () => response(null, [searx], { ...binding, incarnation: browser ? null : browserIncarnation }));
  vi.stubGlobal("fetch", mock); render(<LookupPermission {...props} revisionMayAdvance={browser} />);
  fireEvent.click(screen.getByRole("button", { name: "Web lookup permission" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
  expect(posts(mock)).toHaveLength(0);
});

it.each([
  { ...approval, revision: 5 },
  { ...approval, revision: 6, approvalRevision: 2 },
  { ...approval, revision: 6, policy: { ...policy, provider: serp } },
  { ...approval, revision: 6, policy: { ...policy, maximumClass: "private" } },
])("does not accept a successful write with mismatched policy or revisions %#", async saved => {
  const mock = vi.fn(async () => response(approval)); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} />); await open(); choose();
  mock.mockResolvedValueOnce(response(saved)); allow(); await screen.findByRole("alert");
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Revoke web lookup permission" })).toBeDisabled();
});

it.each(["close", "unmount", "hidden", "focus", "pagehide"])("late mutation replies after %s cannot restore permission or success", async cause => {
  const mock = vi.fn(async () => response(approval)); vi.stubGlobal("fetch", mock);
  const view = render(<LookupPermission {...props} />); await open(); choose();
  const pending = deferred<Response>(); mock.mockReturnValueOnce(pending.promise); allow();
  const signal = posts(mock)[0][1].signal;
  if (cause === "close") fireEvent.click(screen.getByRole("button", { name: "Close web lookup permission" }));
  if (cause === "unmount") view.unmount();
  if (cause === "hidden") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
  }
  if (cause === "focus" || cause === "pagehide") fireEvent(window, new Event(cause));
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response({ ...approval, revision: 6 })); });
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Web search provider")).not.toBeInTheDocument();
});

it("an aborted late conflict cannot require a registry refresh in a new permission read", async () => {
  const mock = vi.fn(async () => response(approval)); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} />); await open(); choose();
  const pending = deferred<Response>(); mock.mockReturnValueOnce(pending.promise); allow();
  fireEvent.click(screen.getByRole("button", { name: "Close web lookup permission" }));
  await act(async () => { pending.resolve(new Response(null, { status: 409 })); });
  await open();
  expect(screen.queryByRole("button", { name: "Refresh device approvals" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeEnabled();
});

it("reviews named-place visual disclosure and grants and revokes it independently of existing web permission", async () => {
  let placesApproval: { approvalRevision: number; revision: number; policy: LookupPolicy | null } | null = null;
  const mock = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    if (String(url).endsWith("/web-lookup")) return response(approval);
    if (options?.method === "POST") {
      const input = JSON.parse(String(options.body));
      placesApproval = { approvalRevision: 3, revision: (placesApproval?.revision ?? 0) + 1, policy: input.policy };
    }
    return response(placesApproval, [google]);
  });
  vi.stubGlobal("fetch", mock);
  render(<><LookupPermission {...props} /><LookupPermission {...props} service="places" /></>);
  expect(mock).not.toHaveBeenCalled();
  await open();
  const web = within(screen.getByRole("group", { name: `Web lookup permission for ${props.label}` }));
  expect(web.getByText("Recorded web lookup permission:")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Place lookup permission" }));
  await waitFor(() => expect(screen.getByLabelText("Place lookup provider")).toBeEnabled());
  expect(screen.getByText(/Named-place results use an address list with Google Maps and provider credit/)).toHaveTextContent("does not grant wearer location, navigation or speech");
  expect(screen.getByRole("button", { name: "Review place lookup permission" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Place lookup provider"), { target: { value: `${google.provider}:${google.configurationDigest}` } });
  fireEvent.click(screen.getByRole("button", { name: "Review place lookup permission" }));
  const review = within(screen.getByRole("group", { name: "Review place lookup permission" }));
  expect(review.getByText("Google Maps")).toBeVisible();
  expect(review.getByText(google.endpoint)).toBeVisible();
  expect(review.getByText(/Only named-place query text and visual results are allowed/)).toHaveTextContent("does not allow speech, device location, location history, navigation or other device actions");
  expect(posts(mock)).toHaveLength(0);
  fireEvent.click(review.getByRole("button", { name: "Allow shared-room place lookup" }));
  await screen.findByText("Cosmos confirmed place lookup permission for this device.");
  expect(posts(mock)).toHaveLength(1);
  expect(posts(mock)[0][0]).toBe(`/api/surfaces/${surfaceId}/places-lookup`);
  expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({
    approval: LOOKUP_SERVICES.places.approval, approvalRevision: 3, approvalIncarnation: null,
    expectedRevision: 0, policy: { provider: google, maximumClass: "shared_room" },
  });
  expect(web.getByText("Recorded web lookup permission:")).toBeVisible();
  expect(web.getByRole("button", { name: "Revoke web lookup permission" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Revoke place lookup permission" }));
  expect(posts(mock)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke place lookup" }));
  await screen.findByText("Cosmos confirmed place lookup permission revoked.");
  expect(posts(mock)).toHaveLength(2);
  expect(posts(mock)[1][0]).toBe(`/api/surfaces/${surfaceId}/places-lookup`);
  expect(JSON.parse(String(posts(mock)[1][1]?.body))).toEqual({
    approval: LOOKUP_SERVICES.places.approval, approvalRevision: 3, approvalIncarnation: null,
    expectedRevision: 1, policy: null,
  });
  expect(web.getByText("Recorded web lookup permission:")).toBeVisible();
  expect(web.getByRole("button", { name: "Revoke web lookup permission" })).toBeEnabled();
  expect(mock.mock.calls.filter(([url]) => String(url).endsWith("/web-lookup"))).toHaveLength(1);
});

it.each([
  { service: "places" as const, title: "Place lookup", name: "place lookup", wrongProviders: [searx] },
  { service: "web" as const, title: "Web lookup", name: "web lookup", wrongProviders: [google] },
])("rejects another service's provider list for $service", async ({ service, title, name, wrongProviders }) => {
  const mock = vi.fn(async () => response(null, wrongProviders)); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} service={service} />);
  fireEvent.click(screen.getByRole("button", { name: `${title} permission` }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: `Review ${name} permission` })).toBeDisabled();
  expect(posts(mock)).toHaveLength(0);
});

it("does not confirm a Places write with a Web policy and requires a fresh read", async () => {
  const mock = vi.fn(async () => response(null, [google])); vi.stubGlobal("fetch", mock);
  render(<LookupPermission {...props} service="places" />);
  fireEvent.click(screen.getByRole("button", { name: "Place lookup permission" }));
  await waitFor(() => expect(screen.getByLabelText("Place lookup provider")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Place lookup provider"), { target: { value: `${google.provider}:${google.configurationDigest}` } });
  fireEvent.click(screen.getByRole("button", { name: "Review place lookup permission" }));
  mock.mockResolvedValueOnce(response({ approvalRevision: 3, revision: 1, policy }, [google]));
  fireEvent.click(screen.getByRole("button", { name: "Allow shared-room place lookup" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Cosmos confirmed place lookup permission for this device.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review place lookup permission" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Revoke place lookup permission" })).toBeDisabled();
});

it("switching services cancels a pending write and requires a fresh service-specific read", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => response(approval)); vi.stubGlobal("fetch", mock);
  const view = render(<LookupPermission {...props} />); await open(); choose();
  const pending = deferred<Response>(); mock.mockReturnValueOnce(pending.promise); allow();
  const signal = posts(mock)[0][1].signal;
  view.rerender(<LookupPermission {...props} service="places" />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response({ ...approval, revision: 6 })); });
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Place lookup provider")).not.toBeInTheDocument();
  mock.mockResolvedValueOnce(response(null, [google]));
  fireEvent.click(screen.getByRole("button", { name: "Place lookup permission" }));
  await screen.findByText("No active place lookup permission.");
  expect(mock.mock.calls.at(-1)?.[0]).toBe(`/api/surfaces/${surfaceId}/places-lookup`);
  expect(screen.getByLabelText("Place lookup provider")).toHaveValue("");
});
