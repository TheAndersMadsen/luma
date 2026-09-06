// @vitest-environment node
import { expect, it } from "vitest";
import { LOOKUP_SERVICES, parseLookupInput, parseLookupPolicy, parseLookupProvider, parseLookupState } from "./lookupDisclosure";

const searxng = { provider: "searxng", endpoint: "http://searxng:8080/search", configurationDigest: "a".repeat(64) };
const serpApi = { provider: "serp_api", endpoint: "https://serpapi.com/search.json", configurationDigest: "b".repeat(64) };
const policy = { provider: searxng, maximumClass: "shared_room" };
const input = { approval: LOOKUP_SERVICES.web.approval, approvalRevision: 2, approvalIncarnation: null, expectedRevision: 3, policy };
const approval = { approvalRevision: 2, revision: 4, policy };
const binding = { approvalRevision: 2, incarnation: null };
const state = { approval, providers: [searxng, serpApi], binding };

it("accepts explicit provider-bound grants, required null revocation, and absent approvals", () => {
  for (const provider of [searxng, serpApi]) {
    const selected = { provider, maximumClass: "shared_room" };
    expect(parseLookupProvider("web", provider)).toEqual(provider);
    expect(parseLookupPolicy("web", selected)).toEqual(selected);
    expect(parseLookupInput("web", { ...input, policy: selected })).toEqual({ ...input, policy: selected });
    expect(parseLookupState("web", { ...state, approval: { ...approval, policy: selected } }))
      .toEqual({ ...state, approval: { ...approval, policy: selected } });
  }
  expect(parseLookupPolicy("web", null)).toBeNull();
  expect(parseLookupInput("web", { ...input, policy: null })).toEqual({ ...input, policy: null });
  expect(parseLookupState("web", { ...state, approval: { ...approval, policy: null } }))
    .toEqual({ ...state, approval: { ...approval, policy: null } });
  expect(parseLookupState("web", { approval: null, providers: [], binding })).toEqual({ approval: null, providers: [], binding });
});

it("preserves exact canonical endpoint identities and their length boundary", () => {
  const prefix = "https://search.example/";
  for (const endpoint of [searxng.endpoint, serpApi.endpoint, "https://search.example/", "https://search.example/custom/search",
    "http://127.0.0.1:8080/search", "http://[::1]:8080/search", "https://xn--bcher-kva.example/search",
    "https://search.example/a%20b", "https://search.example/path%3Fvalue", prefix + "a".repeat(1024 - prefix.length)]) {
    expect(parseLookupProvider("web", { ...searxng, endpoint }).endpoint).toBe(endpoint);
  }
  expect(() => parseLookupProvider("web", { ...searxng, endpoint: prefix + "a".repeat(1025 - prefix.length) })).toThrow();
});

it("rejects endpoints needing repair or carrying credentials, queries, fragments, controls, or ambiguous separators", () => {
  for (const endpoint of [undefined, null, 123, "", "not-a-url", "/search", "//search.example/search", "file:///search", "ftp://search.example/",
    "https://search.example", "HTTPS://search.example/search", "https://SEARCH.example/search", "https://search.example:443/search",
    "https://search.example/a/../search", "https://bücher.example/search", "https://127.1/search", "https://search.example/a b",
    "https://user@search.example/search", "https://user:password@search.example/search", "https://search.example/search?q=private",
    "https://search.example/search?", "https://search.example/search#fragment", "https://search.example/search#",
    " https://search.example/search", "https://search.example/search\n", "https://search.example/\tsearch",
    "https://search.example/\0search", "https://search.example/\x1fsearch", "https://search.example/\x7fsearch",
    "https://search.example/\u00a0search", "https://search.example\\search"]) {
    expect(() => parseLookupProvider("web", { ...searxng, endpoint })).toThrow();
  }
});

it("requires exact nonsecret provider fields and lowercase SHA-256 identities", () => {
  for (const value of [undefined, null, [], {}, { ...searxng, provider: "serpapi" }, { ...searxng, provider: "other" },
    { ...searxng, apiKey: "must-not-pass-through" }, { endpoint: searxng.endpoint, configurationDigest: searxng.configurationDigest },
    { provider: searxng.provider, endpoint: searxng.endpoint }, { ...searxng, configurationDigest: undefined },
    ...["A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), "a".repeat(64) + "\n", 123].map(configurationDigest => ({ ...searxng, configurationDigest }))]) {
    expect(() => parseLookupProvider("web", value)).toThrow();
  }
  const inherited = Object.assign(Object.create({ provider: "searxng" }), {
    endpoint: searxng.endpoint, configurationDigest: searxng.configurationDigest, extra: true,
  });
  expect(() => parseLookupProvider("web", inherited)).toThrow();
});

it("admits only shared-room policies and rejects missing, unknown, or nested authority", () => {
  const { policy: _policy, ...missingPolicy } = input;
  for (const invalid of [undefined, [], {}, { provider: searxng }, { maximumClass: "shared_room" },
    { ...policy, provider: null }, { ...policy, provider: { ...searxng, token: "hidden" } }, { ...policy, fallback: serpApi },
    ...["public", "near_user", "private", "sensitive", 0].map(maximumClass => ({ ...policy, maximumClass }))]) {
    expect(() => parseLookupPolicy("web", invalid)).toThrow();
    expect(() => parseLookupInput("web", { ...input, policy: invalid })).toThrow();
    expect(() => parseLookupState("web", { ...state, approval: { ...approval, policy: invalid } })).toThrow();
  }
  for (const invalid of [undefined, null, [], missingPolicy, { ...input, approval: "approve-speech-provider-disclosure-v1" },
    { ...input, accountId: "other" }, { ...input, provider: searxng }, { ...input, providers: [searxng] }]) {
    expect(() => parseLookupInput("web", invalid)).toThrow();
  }
});

it("requires safe revisions and reserves the next mutation revision", () => {
  expect(parseLookupInput("web", { ...input, expectedRevision: 0 }).expectedRevision).toBe(0);
  expect(parseLookupInput("web", { ...input, expectedRevision: Number.MAX_SAFE_INTEGER - 1 }).expectedRevision).toBe(Number.MAX_SAFE_INTEGER - 1);
  expect(parseLookupInput("web", { ...input, approvalRevision: Number.MAX_SAFE_INTEGER }).approvalRevision).toBe(Number.MAX_SAFE_INTEGER);
  expect(parseLookupState("web", { ...state, approval: { ...approval, revision: Number.MAX_SAFE_INTEGER } }).approval?.revision).toBe(Number.MAX_SAFE_INTEGER);
  for (const invalid of [-1, 1.5, "1", null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseLookupInput("web", { ...input, approvalRevision: invalid })).toThrow();
    expect(() => parseLookupInput("web", { ...input, expectedRevision: invalid })).toThrow();
    expect(() => parseLookupState("web", { ...state, approval: { ...approval, approvalRevision: invalid } })).toThrow();
    expect(() => parseLookupState("web", { ...state, approval: { ...approval, revision: invalid } })).toThrow();
  }
  expect(() => parseLookupInput("web", { ...input, expectedRevision: Number.MAX_SAFE_INTEGER })).toThrow();
  expect(() => parseLookupInput("web", { ...input, approvalRevision: 0 })).toThrow();
  expect(() => parseLookupState("web", { ...state, approval: { ...approval, approvalRevision: 0 } })).toThrow();
  expect(() => parseLookupState("web", { ...state, approval: { ...approval, revision: 0 } })).toThrow();
});

it("rejects unknown or incomplete state envelopes, approvals, and candidate identities", () => {
  const { policy: _policy, ...missingPolicy } = approval;
  for (const invalid of [undefined, null, [], {}, { approval: null }, { providers: [] }, { ...state, approval: undefined },
    { ...state, secret: "hidden" }, { ...state, providers: null }, { ...state, providers: {} }, { ...state, providers: Array(1) },
    { ...state, providers: [{ ...searxng, secret: "hidden" }] }]) {
    expect(() => parseLookupState("web", invalid)).toThrow();
  }
  for (const invalid of [[], {}, missingPolicy, { ...approval, token: "hidden" }, { ...approval, expectedRevision: 3 }]) {
    expect(() => parseLookupState("web", { ...state, approval: invalid })).toThrow();
  }
});

it("bounds candidates to one per provider while retaining stale approvals for review and revocation", () => {
  for (const providers of [[], [searxng], [serpApi], [searxng, serpApi]]) {
    expect(parseLookupState("web", { approval: null, providers, binding }).providers).toEqual(providers);
  }
  for (const providers of [[searxng, serpApi, searxng], [searxng, searxng],
    [searxng, { ...searxng, endpoint: "https://other.example/search", configurationDigest: "c".repeat(64) }]]) {
    expect(() => parseLookupState("web", { approval: null, providers, binding })).toThrow();
  }
  expect(parseLookupState("web", { approval, providers: [], binding })).toEqual({ approval, providers: [], binding });
  const changed = { ...searxng, configurationDigest: "c".repeat(64) };
  expect(parseLookupState("web", { approval, providers: [changed], binding })).toEqual({ approval, providers: [changed], binding });
});

it("requires explicit nullable incarnations and canonicalizes browser UUIDs without inferring a profile", () => {
  const browser = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  for (const incarnation of [browser, browser.toUpperCase()]) {
    expect(parseLookupInput("web", { ...input, approvalIncarnation: incarnation }))
      .toEqual({ ...input, approvalIncarnation: browser });
    expect(parseLookupState("web", { ...state, binding: { ...binding, incarnation } }))
      .toEqual({ ...state, binding: { ...binding, incarnation: browser } });
  }
  expect(parseLookupInput("web", input).approvalIncarnation).toBeNull();
  expect(parseLookupState("web", state).binding.incarnation).toBeNull();
  const { approvalIncarnation: _approvalIncarnation, ...missingIncarnation } = input;
  expect(() => parseLookupInput("web", missingIncarnation)).toThrow();
  for (const incarnation of [undefined, "", [], {}, 0, "00000000-0000-0000-0000-000000000000", "not-a-uuid",
    browser + "\n", " " + browser, browser.replaceAll("-", ""), browser.replace("a", "g")]) {
    expect(() => parseLookupInput("web", { ...input, approvalIncarnation: incarnation })).toThrow();
    expect(() => parseLookupState("web", { ...state, binding: { ...binding, incarnation } })).toThrow();
  }
  expect(() => parseLookupInput("web", { ...input, incarnation: browser })).toThrow();
});

it("requires exact current bindings while preserving older browser approvals", () => {
  const currentBinding = { incarnation: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", approvalRevision: approval.approvalRevision + 1 };
  expect(parseLookupState("web", { ...state, binding: currentBinding })).toEqual({ ...state, binding: currentBinding });
  expect(parseLookupState("web", { ...state, approval: null, binding: { ...binding, approvalRevision: Number.MAX_SAFE_INTEGER } }).binding.approvalRevision)
    .toBe(Number.MAX_SAFE_INTEGER);
  expect(() => parseLookupState("web", { approval, providers: state.providers })).toThrow();
  for (const invalid of [undefined, null, [], {}, { incarnation: null }, { approvalRevision: 2 },
    { ...binding, token: "hidden" }, { ...binding, approvalIncarnation: null },
    ...[0, -1, 1.5, "1", null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(approvalRevision => ({ ...binding, approvalRevision }))]) {
    expect(() => parseLookupState("web", { ...state, binding: invalid })).toThrow();
    expect(() => parseLookupState("web", { ...state, approval: null, binding: invalid })).toThrow();
  }
});

it("rejects saved approvals ahead of the binding and requires matching revisions for null incarnations", () => {
  for (const policy of [approval.policy, null]) {
    const saved = { ...approval, policy };
    const olderBinding = { ...binding, approvalRevision: approval.approvalRevision - 1 };
    for (const incarnation of [null, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]) {
      expect(() => parseLookupState("web", { ...state, approval: saved, binding: { ...olderBinding, incarnation } })).toThrow();
      expect(parseLookupState("web", { ...state, approval: saved, binding: { ...binding, incarnation } }).approval).toEqual(saved);
    }
    const newerBinding = { ...binding, approvalRevision: approval.approvalRevision + 1 };
    expect(() => parseLookupState("web", { ...state, approval: saved, binding: newerBinding })).toThrow();
    expect(parseLookupState("web", { ...state, approval: saved,
      binding: { ...newerBinding, incarnation: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } }).approval).toEqual(saved);
  }
});

const googlePlaces = {
  provider: "google_places", endpoint: "https://places.googleapis.com/v1/places:searchText", configurationDigest: "c".repeat(64),
};
const placesPolicy = { provider: googlePlaces, maximumClass: "shared_room" };
const placesInput = { ...input, approval: LOOKUP_SERVICES.places.approval, policy: placesPolicy };
const placesApproval = { ...approval, policy: placesPolicy };
const placesState = { approval: placesApproval, providers: [googlePlaces], binding };

it("accepts Google Places grants and explicit revocation under the separate Places approval token", () => {
  expect(parseLookupProvider("places", googlePlaces)).toEqual(googlePlaces);
  expect(parseLookupPolicy("places", placesPolicy)).toEqual(placesPolicy);
  expect(parseLookupInput("places", placesInput)).toEqual(placesInput);
  expect(parseLookupState("places", placesState)).toEqual(placesState);
  expect(parseLookupPolicy("places", null)).toBeNull();
  expect(parseLookupInput("places", { ...placesInput, policy: null })).toEqual({ ...placesInput, policy: null });
  expect(parseLookupState("places", { ...placesState, approval: { ...placesApproval, policy: null } }))
    .toEqual({ ...placesState, approval: { ...placesApproval, policy: null } });
  expect(parseLookupState("places", { approval: null, providers: [], binding })).toEqual({ approval: null, providers: [], binding });
  const browserBinding = { incarnation: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", approvalRevision: binding.approvalRevision + 1 };
  expect(parseLookupState("places", { ...placesState, binding: browserBinding })).toEqual({ ...placesState, binding: browserBinding });
});

it("rejects providers and saved policies belonging to the other lookup service", () => {
  for (const [service, validInput, validState, rejectedProviders] of [
    ["web", input, state, [googlePlaces]],
    ["places", placesInput, placesState, [searxng, serpApi]],
  ] as const) {
    for (const provider of rejectedProviders) {
      const policy = { provider, maximumClass: "shared_room" };
      expect(() => parseLookupProvider(service, provider)).toThrow();
      expect(() => parseLookupPolicy(service, policy)).toThrow();
      expect(() => parseLookupInput(service, { ...validInput, policy })).toThrow();
      expect(() => parseLookupState(service, { ...validState, approval: { ...validState.approval, policy } })).toThrow();
      expect(() => parseLookupState(service, { ...validState, approval: null, providers: [provider] })).toThrow();
    }
  }
});

it("requires the route's own approval token for both grants and null revocations", () => {
  for (const [service, validInput, wrongToken] of [
    ["web", input, LOOKUP_SERVICES.places.approval],
    ["places", placesInput, LOOKUP_SERVICES.web.approval],
  ] as const) {
    for (const policy of [validInput.policy, null]) {
      const request = { ...validInput, policy };
      expect(parseLookupInput(service, request)).toEqual(request);
      expect(() => parseLookupInput(service, { ...request, approval: wrongToken })).toThrow();
      expect(() => parseLookupInput(service, { ...request, service })).toThrow();
    }
  }
});

it("bounds Places to one candidate and retains its outdated configuration for explicit review or revocation", () => {
  const changed = { ...googlePlaces, configurationDigest: "d".repeat(64) };
  for (const providers of [[], [googlePlaces], [changed]]) {
    expect(parseLookupState("places", { ...placesState, providers })).toEqual({ ...placesState, providers });
  }
  for (const providers of [[googlePlaces, googlePlaces], [googlePlaces, changed], [googlePlaces, searxng]]) {
    expect(() => parseLookupState("places", { approval: null, providers, binding })).toThrow();
  }
  for (const extra of [{ deviceLocation: true }, { locationHistory: true }, { speech: true }, { navigation: true }]) {
    expect(() => parseLookupPolicy("places", { ...placesPolicy, ...extra })).toThrow();
    expect(() => parseLookupInput("places", { ...placesInput, ...extra })).toThrow();
  }
});
