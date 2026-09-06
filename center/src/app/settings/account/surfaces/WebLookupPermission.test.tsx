import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebLookupPermission } from "./WebLookupPermission";
import { WEB_LOOKUP_APPROVAL, type WebLookupBinding, type WebLookupPolicy, type WebLookupProvider } from "@/lib/contracts/webLookup";

const surfaceId = "11111111-1111-4111-8111-111111111111";
const searx: WebLookupProvider = { provider: "searxng", endpoint: "https://search.example.test/search", configurationDigest: "a".repeat(64) };
const serp: WebLookupProvider = { provider: "serp_api", endpoint: "https://serpapi.com/search.json", configurationDigest: "b".repeat(64) };
const policy: WebLookupPolicy = { provider: searx, maximumClass: "shared_room" };
const approval = { approvalRevision: 3, revision: 5, policy };
const binding: WebLookupBinding = { approvalRevision: 3, incarnation: null };
const browserIncarnation = "22222222-2222-4222-8222-222222222222";
const props = { surfaceId, approvalRevision: 3, label: "test installation", canApprove: true, onRefreshApprovals: vi.fn(async () => {}) };
const success = "Cosmos confirmed web lookup permission for this device.";
const revoked = "Cosmos confirmed web lookup permission revoked.";
const state = (saved: unknown = null, providers: WebLookupProvider[] = [searx, serp], current: WebLookupBinding = binding) => ({ approval: saved, providers, binding: current });
const response = (saved: unknown = null, providers: WebLookupProvider[] = [searx, serp], current: WebLookupBinding = binding) => Response.json(state(saved, providers, current));
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
  vi.stubGlobal("fetch", mock); render(<WebLookupPermission {...props} />);
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
  expect(JSON.parse(String(options.body))).toEqual({ approval: WEB_LOOKUP_APPROVAL, approvalRevision: 3, approvalIncarnation: null, expectedRevision: 0, policy: selectedPolicy });
  await act(async () => { pending.resolve(response({ approvalRevision: 3, revision: 1, policy: selectedPolicy })); });
  await screen.findByText(success);
});

it("changing a reviewed provider removes confirmation until the new provider is reviewed", async () => {
  const mock = vi.fn(async () => response()); vi.stubGlobal("fetch", mock);
  render(<WebLookupPermission {...props} />); await open(); choose();
  fireEvent.change(screen.getByLabelText("Web search provider"), { target: { value: `${serp.provider}:${serp.configurationDigest}` } });
  expect(screen.queryByRole("button", { name: "Allow shared-room web lookup" })).not.toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(1);
});

it("requires a fresh permission read after a lost write, then uses its actual policy revision", async () => {
  const mock = vi.fn(async () => response(approval)); vi.stubGlobal("fetch", mock);
  render(<WebLookupPermission {...props} />); await open(); choose();
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
  expect(JSON.parse(String(posts(mock)[1][1].body))).toEqual({ approval: WEB_LOOKUP_APPROVAL, approvalRevision: 3, approvalIncarnation: null, expectedRevision: 6, policy: null });
});

it("allows explicit revocation after pairing and provider loss while disabling new grants", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => options?.method === "POST"
    ? response({ ...approval, revision: 6, policy: null }, []) : response(approval, []));
  vi.stubGlobal("fetch", mock); render(<WebLookupPermission {...props} canApprove={false} />); await open();
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
  vi.stubGlobal("fetch", mock); render(<WebLookupPermission {...props} />); await open();
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
  render(<WebLookupPermission {...props} revisionMayAdvance />); await open(); choose();
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
  const view = render(<WebLookupPermission {...props} revisionMayAdvance />); await open(); choose();
  view.rerender(<WebLookupPermission {...props} approvalRevision={10} revisionMayAdvance />);
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
  render(<WebLookupPermission {...props} revisionMayAdvance={revisionMayAdvance} />);
  fireEvent.click(screen.getByRole("button", { name: "Web lookup permission" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh web lookup permission" })).toBeEnabled();
  expect(posts(mock)).toHaveLength(0);
});

it("requires a current native or Pin parent approval when its atomic binding revision changed", async () => {
  const changed = { approvalRevision: 4, incarnation: null };
  const mock = vi.fn(async () => response(null, [searx], changed)); vi.stubGlobal("fetch", mock);
  const view = render(<WebLookupPermission {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Web lookup permission" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Refresh web lookup permission" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh device approvals" }));
  expect(props.onRefreshApprovals).toHaveBeenCalledTimes(1);
  view.rerender(<WebLookupPermission {...props} approvalRevision={4} />); await open();
  expect(screen.getByLabelText("Web search provider")).toBeEnabled();
});

it.each([
  { browser: true, savedBinding: { approvalRevision: 3, incarnation: "33333333-3333-4333-8333-333333333333" } },
  { browser: true, savedBinding: { approvalRevision: 2, incarnation: browserIncarnation } },
  { browser: false, savedBinding: { approvalRevision: 4, incarnation: null } },
])("rejects a successful response for a changed incarnation or invalid binding revision %#", async ({ browser, savedBinding }) => {
  const original = { ...binding, incarnation: browser ? browserIncarnation : null };
  const mock = vi.fn(async () => response(approval, [searx], original)); vi.stubGlobal("fetch", mock);
  render(<WebLookupPermission {...props} revisionMayAdvance={browser} />); await open(); choose();
  mock.mockResolvedValueOnce(response({ ...approval, revision: 6 }, [searx], savedBinding)); allow();
  await screen.findByRole("alert");
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeDisabled();
});

it.each([false, true])("rejects the other platform's nullable binding shape (browser=%s)", async browser => {
  const mock = vi.fn(async () => response(null, [searx], { ...binding, incarnation: browser ? null : browserIncarnation }));
  vi.stubGlobal("fetch", mock); render(<WebLookupPermission {...props} revisionMayAdvance={browser} />);
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
  render(<WebLookupPermission {...props} />); await open(); choose();
  mock.mockResolvedValueOnce(response(saved)); allow(); await screen.findByRole("alert");
  expect(screen.queryByText(success)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Revoke web lookup permission" })).toBeDisabled();
});

it.each(["close", "unmount", "hidden", "focus", "pagehide"])("late mutation replies after %s cannot restore permission or success", async cause => {
  const mock = vi.fn(async () => response(approval)); vi.stubGlobal("fetch", mock);
  const view = render(<WebLookupPermission {...props} />); await open(); choose();
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
  render(<WebLookupPermission {...props} />); await open(); choose();
  const pending = deferred<Response>(); mock.mockReturnValueOnce(pending.promise); allow();
  fireEvent.click(screen.getByRole("button", { name: "Close web lookup permission" }));
  await act(async () => { pending.resolve(new Response(null, { status: 409 })); });
  await open();
  expect(screen.queryByRole("button", { name: "Refresh device approvals" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review web lookup permission" })).toBeEnabled();
});
