// @vitest-environment node
import { expect, it } from "vitest";
import { WEB_LOOKUP_APPROVAL, parseWebLookupInput, parseWebLookupPolicy, parseWebLookupProvider, parseWebLookupState } from "./webLookup";

const searxng = { provider: "searxng", endpoint: "http://searxng:8080/search", configurationDigest: "a".repeat(64) };
const serpApi = { provider: "serp_api", endpoint: "https://serpapi.com/search.json", configurationDigest: "b".repeat(64) };
const policy = { provider: searxng, maximumClass: "shared_room" };
const input = { approval: WEB_LOOKUP_APPROVAL, approvalRevision: 2, approvalIncarnation: null, expectedRevision: 3, policy };
const approval = { approvalRevision: 2, revision: 4, policy };
const binding = { approvalRevision: 2, incarnation: null };
const state = { approval, providers: [searxng, serpApi], binding };

it("accepts explicit provider-bound grants, required null revocation, and absent approvals", () => {
  for (const provider of [searxng, serpApi]) {
    const selected = { provider, maximumClass: "shared_room" };
    expect(parseWebLookupProvider(provider)).toEqual(provider);
    expect(parseWebLookupPolicy(selected)).toEqual(selected);
    expect(parseWebLookupInput({ ...input, policy: selected })).toEqual({ ...input, policy: selected });
    expect(parseWebLookupState({ ...state, approval: { ...approval, policy: selected } }))
      .toEqual({ ...state, approval: { ...approval, policy: selected } });
  }
  expect(parseWebLookupPolicy(null)).toBeNull();
  expect(parseWebLookupInput({ ...input, policy: null })).toEqual({ ...input, policy: null });
  expect(parseWebLookupState({ ...state, approval: { ...approval, policy: null } }))
    .toEqual({ ...state, approval: { ...approval, policy: null } });
  expect(parseWebLookupState({ approval: null, providers: [], binding })).toEqual({ approval: null, providers: [], binding });
});

it("preserves exact canonical endpoint identities and their length boundary", () => {
  const prefix = "https://search.example/";
  for (const endpoint of [searxng.endpoint, serpApi.endpoint, "https://search.example/", "https://search.example/custom/search",
    "http://127.0.0.1:8080/search", "http://[::1]:8080/search", "https://xn--bcher-kva.example/search",
    "https://search.example/a%20b", "https://search.example/path%3Fvalue", prefix + "a".repeat(1024 - prefix.length)]) {
    expect(parseWebLookupProvider({ ...searxng, endpoint }).endpoint).toBe(endpoint);
  }
  expect(() => parseWebLookupProvider({ ...searxng, endpoint: prefix + "a".repeat(1025 - prefix.length) })).toThrow();
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
    expect(() => parseWebLookupProvider({ ...searxng, endpoint })).toThrow();
  }
});

it("requires exact nonsecret provider fields and lowercase SHA-256 identities", () => {
  for (const value of [undefined, null, [], {}, { ...searxng, provider: "serpapi" }, { ...searxng, provider: "other" },
    { ...searxng, apiKey: "must-not-pass-through" }, { endpoint: searxng.endpoint, configurationDigest: searxng.configurationDigest },
    { provider: searxng.provider, endpoint: searxng.endpoint }, { ...searxng, configurationDigest: undefined },
    ...["A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), "a".repeat(64) + "\n", 123].map(configurationDigest => ({ ...searxng, configurationDigest }))]) {
    expect(() => parseWebLookupProvider(value)).toThrow();
  }
  const inherited = Object.assign(Object.create({ provider: "searxng" }), {
    endpoint: searxng.endpoint, configurationDigest: searxng.configurationDigest, extra: true,
  });
  expect(() => parseWebLookupProvider(inherited)).toThrow();
});

it("admits only shared-room policies and rejects missing, unknown, or nested authority", () => {
  const { policy: _policy, ...missingPolicy } = input;
  for (const invalid of [undefined, [], {}, { provider: searxng }, { maximumClass: "shared_room" },
    { ...policy, provider: null }, { ...policy, provider: { ...searxng, token: "hidden" } }, { ...policy, fallback: serpApi },
    ...["public", "near_user", "private", "sensitive", 0].map(maximumClass => ({ ...policy, maximumClass }))]) {
    expect(() => parseWebLookupPolicy(invalid)).toThrow();
    expect(() => parseWebLookupInput({ ...input, policy: invalid })).toThrow();
    expect(() => parseWebLookupState({ ...state, approval: { ...approval, policy: invalid } })).toThrow();
  }
  for (const invalid of [undefined, null, [], missingPolicy, { ...input, approval: "approve-speech-provider-disclosure-v1" },
    { ...input, accountId: "other" }, { ...input, provider: searxng }, { ...input, providers: [searxng] }]) {
    expect(() => parseWebLookupInput(invalid)).toThrow();
  }
});

it("requires safe revisions and reserves the next mutation revision", () => {
  expect(parseWebLookupInput({ ...input, expectedRevision: 0 }).expectedRevision).toBe(0);
  expect(parseWebLookupInput({ ...input, expectedRevision: Number.MAX_SAFE_INTEGER - 1 }).expectedRevision).toBe(Number.MAX_SAFE_INTEGER - 1);
  expect(parseWebLookupInput({ ...input, approvalRevision: Number.MAX_SAFE_INTEGER }).approvalRevision).toBe(Number.MAX_SAFE_INTEGER);
  expect(parseWebLookupState({ ...state, approval: { ...approval, revision: Number.MAX_SAFE_INTEGER } }).approval?.revision).toBe(Number.MAX_SAFE_INTEGER);
  for (const invalid of [-1, 1.5, "1", null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseWebLookupInput({ ...input, approvalRevision: invalid })).toThrow();
    expect(() => parseWebLookupInput({ ...input, expectedRevision: invalid })).toThrow();
    expect(() => parseWebLookupState({ ...state, approval: { ...approval, approvalRevision: invalid } })).toThrow();
    expect(() => parseWebLookupState({ ...state, approval: { ...approval, revision: invalid } })).toThrow();
  }
  expect(() => parseWebLookupInput({ ...input, expectedRevision: Number.MAX_SAFE_INTEGER })).toThrow();
  expect(() => parseWebLookupInput({ ...input, approvalRevision: 0 })).toThrow();
  expect(() => parseWebLookupState({ ...state, approval: { ...approval, approvalRevision: 0 } })).toThrow();
  expect(() => parseWebLookupState({ ...state, approval: { ...approval, revision: 0 } })).toThrow();
});

it("rejects unknown or incomplete state envelopes, approvals, and candidate identities", () => {
  const { policy: _policy, ...missingPolicy } = approval;
  for (const invalid of [undefined, null, [], {}, { approval: null }, { providers: [] }, { ...state, approval: undefined },
    { ...state, secret: "hidden" }, { ...state, providers: null }, { ...state, providers: {} }, { ...state, providers: Array(1) },
    { ...state, providers: [{ ...searxng, secret: "hidden" }] }]) {
    expect(() => parseWebLookupState(invalid)).toThrow();
  }
  for (const invalid of [[], {}, missingPolicy, { ...approval, token: "hidden" }, { ...approval, expectedRevision: 3 }]) {
    expect(() => parseWebLookupState({ ...state, approval: invalid })).toThrow();
  }
});

it("bounds candidates to one per provider while retaining stale approvals for review and revocation", () => {
  for (const providers of [[], [searxng], [serpApi], [searxng, serpApi]]) {
    expect(parseWebLookupState({ approval: null, providers, binding }).providers).toEqual(providers);
  }
  for (const providers of [[searxng, serpApi, searxng], [searxng, searxng],
    [searxng, { ...searxng, endpoint: "https://other.example/search", configurationDigest: "c".repeat(64) }]]) {
    expect(() => parseWebLookupState({ approval: null, providers, binding })).toThrow();
  }
  expect(parseWebLookupState({ approval, providers: [], binding })).toEqual({ approval, providers: [], binding });
  const changed = { ...searxng, configurationDigest: "c".repeat(64) };
  expect(parseWebLookupState({ approval, providers: [changed], binding })).toEqual({ approval, providers: [changed], binding });
});

it("requires explicit nullable incarnations and canonicalizes browser UUIDs without inferring a profile", () => {
  const browser = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  for (const incarnation of [browser, browser.toUpperCase()]) {
    expect(parseWebLookupInput({ ...input, approvalIncarnation: incarnation }))
      .toEqual({ ...input, approvalIncarnation: browser });
    expect(parseWebLookupState({ ...state, binding: { ...binding, incarnation } }))
      .toEqual({ ...state, binding: { ...binding, incarnation: browser } });
  }
  expect(parseWebLookupInput(input).approvalIncarnation).toBeNull();
  expect(parseWebLookupState(state).binding.incarnation).toBeNull();
  const { approvalIncarnation: _approvalIncarnation, ...missingIncarnation } = input;
  expect(() => parseWebLookupInput(missingIncarnation)).toThrow();
  for (const incarnation of [undefined, "", [], {}, 0, "00000000-0000-0000-0000-000000000000", "not-a-uuid",
    browser + "\n", " " + browser, browser.replaceAll("-", ""), browser.replace("a", "g")]) {
    expect(() => parseWebLookupInput({ ...input, approvalIncarnation: incarnation })).toThrow();
    expect(() => parseWebLookupState({ ...state, binding: { ...binding, incarnation } })).toThrow();
  }
  expect(() => parseWebLookupInput({ ...input, incarnation: browser })).toThrow();
});

it("requires exact current bindings while preserving older browser approvals", () => {
  const currentBinding = { incarnation: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", approvalRevision: approval.approvalRevision + 1 };
  expect(parseWebLookupState({ ...state, binding: currentBinding })).toEqual({ ...state, binding: currentBinding });
  expect(parseWebLookupState({ ...state, approval: null, binding: { ...binding, approvalRevision: Number.MAX_SAFE_INTEGER } }).binding.approvalRevision)
    .toBe(Number.MAX_SAFE_INTEGER);
  expect(() => parseWebLookupState({ approval, providers: state.providers })).toThrow();
  for (const invalid of [undefined, null, [], {}, { incarnation: null }, { approvalRevision: 2 },
    { ...binding, token: "hidden" }, { ...binding, approvalIncarnation: null },
    ...[0, -1, 1.5, "1", null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(approvalRevision => ({ ...binding, approvalRevision }))]) {
    expect(() => parseWebLookupState({ ...state, binding: invalid })).toThrow();
    expect(() => parseWebLookupState({ ...state, approval: null, binding: invalid })).toThrow();
  }
});

it("rejects saved approvals ahead of the binding and requires matching revisions for null incarnations", () => {
  for (const policy of [approval.policy, null]) {
    const saved = { ...approval, policy };
    const olderBinding = { ...binding, approvalRevision: approval.approvalRevision - 1 };
    for (const incarnation of [null, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]) {
      expect(() => parseWebLookupState({ ...state, approval: saved, binding: { ...olderBinding, incarnation } })).toThrow();
      expect(parseWebLookupState({ ...state, approval: saved, binding: { ...binding, incarnation } }).approval).toEqual(saved);
    }
    const newerBinding = { ...binding, approvalRevision: approval.approvalRevision + 1 };
    expect(() => parseWebLookupState({ ...state, approval: saved, binding: newerBinding })).toThrow();
    expect(parseWebLookupState({ ...state, approval: saved,
      binding: { ...newerBinding, incarnation: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } }).approval).toEqual(saved);
  }
});
