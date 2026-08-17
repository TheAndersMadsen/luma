/*
 * Behavioural guards for the eSIM pane's two pure modules: `_lib/esimSafety`
 * (which device actions may be offered at all) and `_lib/esimPresentation`
 * (what the pane concludes from a device response).
 *
 * esimSafety is the highest-consequence pure function in this pane. Deleting an
 * eSIM profile is irreversible and can leave a Pin with no cellular identity, so
 * the gate is three independent conditions — nothing in flight, not
 * carrier-protected, already disabled — and the ordering matters as much as the
 * conditions: a user has to take the reversible step (disable) before the
 * irreversible one is reachable. Each condition is asserted on its own below so
 * that dropping any one of them fails rather than being masked by the others.
 *
 * esimPresentation is where a device answer becomes a verdict, and two of its
 * properties are load-bearing:
 *
 *   - Every failure shape lands on a DISTINCT kind. "Timed out", "the Pin is not
 *     connected", "the Pin answered something unexpected" and "HTTP 500" lead to
 *     different actions, so collapsing any pair into one kind gives the wearer
 *     the wrong instruction. The distinctness case pins all eight.
 *   - An error message never carries the underlying error's own text. Errors
 *     here can contain a bearer token or a filesystem path, and this pane
 *     renders its message directly, so classifyApiError substitutes fixed copy
 *     for anything it did not construct itself.
 *
 * Ported from the `pin/setup` SPA's vitest suite (EsimSettingsPage.test.ts,
 * which reached these functions as page exports before they became a module).
 * One deliberate divergence from the SPA, found while porting: the generic
 * fallback message changed from "Could not load data from the server." to
 * "...from the Pin." Center IS the server, so the SPA's wording would name the
 * wrong machine. No ported case asserts that string — they assert what the
 * message must NOT contain — so Center's copy is correct and the cases stand
 * unmodified.
 *
 * The `canDisableEsimProfile` / `canEnableEsimProfile` / `isEsimProfileEnabled`
 * cases at the end are NOT ported: those functions are Center's own additions
 * (the SPA's pane never offered Disable) and had no coverage anywhere.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const QUERY = "?pin-esim-test";

const { canDeleteEsimProfile, canDisableEsimProfile, canEnableEsimProfile, isEsimProfileEnabled } =
  await import(`../src/app/settings/pin/_lib/esimSafety.ts${QUERY}`);
const {
  classifyApiError,
  classifyCellularResponse,
  classifyEidResult,
  classifyProfilesResult,
  formatStaleness,
  isTimeoutError,
} = await import(`../src/app/settings/pin/_lib/esimPresentation.ts${QUERY}`);
const { PinApiError } = await import(`../src/lib/pin-device/index.ts${QUERY}`);

/** A profile in the only state deletion is ever allowed from. */
function profile(overrides = {}) {
  return {
    iccid: "test-profile-id",
    state: "Disabled",
    protected: false,
    ...overrides,
  };
}

/* ── eSIM deletion safety ─────────────────────────────────────────────────── */

test("only enables deletion for a verified disabled non-protected profile", () => {
  assert.equal(canDeleteEsimProfile(profile(), false), true);
  assert.equal(canDeleteEsimProfile(profile({ state: "Enabled" }), false), false);
  assert.equal(canDeleteEsimProfile(profile({ state: undefined }), false), false);
  assert.equal(canDeleteEsimProfile(profile({ state: "Unknown" }), false), false);
  assert.equal(canDeleteEsimProfile(profile({ protected: true }), false), false);
  assert.equal(canDeleteEsimProfile(profile(), true), false);
});

/* ── isTimeoutError ───────────────────────────────────────────────────────── */

test("isTimeoutError detects DOMException AbortError", () => {
  assert.equal(isTimeoutError(new DOMException("aborted", "AbortError")), true);
});

test("isTimeoutError detects DOMException TimeoutError", () => {
  assert.equal(
    isTimeoutError(new DOMException("timed out", "TimeoutError")),
    true,
  );
});

test("isTimeoutError detects timeout message patterns", () => {
  assert.equal(isTimeoutError(new Error("Request timed out")), true);
  assert.equal(isTimeoutError(new Error("timeout exceeded")), true);
});

test("isTimeoutError rejects non-timeout errors", () => {
  assert.equal(isTimeoutError(new Error("Network error")), false);
  assert.equal(isTimeoutError(new TypeError("fetch failed")), false);
  assert.equal(isTimeoutError(null), false);
  assert.equal(isTimeoutError("string error"), false);
});

/* ── classifyApiError ─────────────────────────────────────────────────────── */

test("classifyApiError classifies timeout errors", () => {
  assert.equal(
    classifyApiError(new DOMException("aborted", "AbortError")).kind,
    "timeout",
  );
});

test("classifyApiError classifies PinApiError with HTTP status 0 as disconnected", () => {
  assert.equal(classifyApiError(new PinApiError(0, "")).kind, "disconnected");
});

test("classifyApiError turns a server failure into wearer-facing copy", () => {
  const state = classifyApiError(new PinApiError(500, "Internal Server Error"));

  assert.equal(state.kind, "error");
  assert.equal(
    state.message,
    "Your Pin is unavailable. Try again or connect it with a cable.",
  );
  assert.doesNotMatch(state.message, /500|HTTP|Internal Server Error/i);
});

test("classifyApiError keeps authorization failure distinct without exposing status", () => {
  const state = classifyApiError(new PinApiError(401, "Unauthorized"));

  assert.equal(state.kind, "error");
  assert.equal(
    state.message,
    "Your Pin didn’t accept that request. Reconnect it and try again.",
  );
  assert.doesNotMatch(state.message, /401|Unauthorized|HTTP/i);
});

test("classifyApiError classifies network TypeError as disconnected", () => {
  assert.equal(
    classifyApiError(new TypeError("Failed to fetch")).kind,
    "disconnected",
  );
});

test("classifyApiError classifies generic errors as error with safe message", () => {
  const state = classifyApiError(new Error("something broke"));

  assert.equal(state.kind, "error");
  assert.ok(!state.message.includes("something broke"));
});

test("classifyApiError does not expose internal error details in user-facing messages", () => {
  const state = classifyApiError(
    new Error("internal stack trace at /secret/path"),
  );

  assert.equal(state.kind, "error");
  assert.ok(!state.message.includes("/secret/path"));
  assert.ok(!state.message.includes("stack trace"));
});

/* ── classifyCellularResponse ─────────────────────────────────────────────── */

const VALID_CELLULAR_PAYLOAD = {
  status: "working",
  reason: "validated",
  message: "Connected",
  cellular_usable: true,
  details: {
    operator_name: "TestCarrier",
    network_type: "LTE",
    service_state: "in_service",
    signal_level: 3,
    signal_dbm: -75,
    mobile_data_enabled: true,
    data_connected: true,
    data_connection_state: "connected",
    internet_validated: true,
  },
};

test("classifies a valid status_result as loaded", () => {
  const state = classifyCellularResponse({
    type: "cellular.status_result",
    payload: VALID_CELLULAR_PAYLOAD,
  });

  assert.equal(state.kind, "loaded");
  assert.equal(state.value.details.operator_name, "TestCarrier");
});

test("classifies status_result with missing payload as malformed", () => {
  assert.equal(
    classifyCellularResponse({ type: "cellular.status_result" }).kind,
    "malformed",
  );
});

test("classifies status_result with non-details payload as malformed", () => {
  assert.equal(
    classifyCellularResponse({
      type: "cellular.status_result",
      payload: { message: "no details field" },
    }).kind,
    "malformed",
  );
});

test("classifies status_timeout as timeout", () => {
  assert.equal(
    classifyCellularResponse({ type: "cellular.status_timeout" }).kind,
    "timeout",
  );
});

test("classifies status_error with message", () => {
  const state = classifyCellularResponse({
    type: "cellular.status_error",
    payload: { message: "Radio off" },
  });

  assert.equal(state.kind, "error");
  assert.equal(state.message, "Radio off");
});

test("classifies status_error without message as generic error", () => {
  const state = classifyCellularResponse({ type: "cellular.status_error" });

  assert.equal(state.kind, "error");
  assert.ok(state.message.includes("could not be determined"));
});

test("classifies unknown response types as malformed", () => {
  assert.equal(
    classifyCellularResponse({ type: "cellular.something_unexpected" }).kind,
    "malformed",
  );
});

/* ── classifyProfilesResult ───────────────────────────────────────────────── */

test("classifies non-empty profiles array as loaded", () => {
  const state = classifyProfilesResult({
    profiles: [profile({ iccid: "1" }), profile({ iccid: "2" })],
  });

  assert.equal(state.kind, "loaded");
  assert.equal(state.value.length, 2);
});

test("classifies profiles in payload as loaded", () => {
  assert.equal(
    classifyProfilesResult({ payload: { profiles: [profile()] } }).kind,
    "loaded",
  );
});

test("classifies empty profiles array as empty", () => {
  const state = classifyProfilesResult({ profiles: [] });

  assert.equal(state.kind, "empty");
  assert.notEqual(state.hint, undefined);
});

test("classifies missing profiles as empty", () => {
  assert.equal(classifyProfilesResult({}).kind, "empty");
});

/* ── classifyEidResult ────────────────────────────────────────────────────── */

test("classifies result with eid as loaded", () => {
  const state = classifyEidResult({
    eid: "89049032000000000000000000000000",
  });

  assert.equal(state.kind, "loaded");
  assert.equal(state.value.eid, "89049032000000000000000000000000");
});

test("classifies result with eid in payload as loaded", () => {
  assert.equal(
    classifyEidResult({
      payload: { eid: "89049032000000000000000000000001" },
    }).kind,
    "loaded",
  );
});

test("classifies result with only imei as loaded", () => {
  const state = classifyEidResult({ imei: "123456789012345" });

  assert.equal(state.kind, "loaded");
  assert.equal(state.value.imei, "123456789012345");
  assert.equal(state.value.eid, null);
});

test("classifies result with neither eid nor imei as empty", () => {
  assert.equal(classifyEidResult({}).kind, "empty");
});

test("classifies result with null values as empty", () => {
  assert.equal(classifyEidResult({ eid: undefined, imei: null }).kind, "empty");
});

/* ── formatStaleness ──────────────────────────────────────────────────────── */

test("formatStaleness formats seconds for recent timestamps", () => {
  assert.match(formatStaleness(Date.now() - 30_000), /30s ago/);
});

test("formatStaleness formats minutes for older timestamps", () => {
  assert.match(formatStaleness(Date.now() - 3 * 60 * 1000), /3m ago/);
});

test("formatStaleness formats hours for very old timestamps", () => {
  assert.match(formatStaleness(Date.now() - 2 * 60 * 60 * 1000), /2h ago/);
});

/* ── state distinctness ───────────────────────────────────────────────────── */

test("produces a distinct kind for every classification path", () => {
  const kinds = new Set();

  // idle and loading are set by the pane itself, not by a classifier.
  kinds.add("idle");
  kinds.add("loading");

  // loaded — profiles with data
  kinds.add(classifyProfilesResult({ profiles: [profile()] }).kind);
  // empty — profiles with no data
  kinds.add(classifyProfilesResult({ profiles: [] }).kind);
  // error — PinApiError with status
  kinds.add(classifyApiError(new PinApiError(500, "err")).kind);
  // timeout — AbortError
  kinds.add(classifyApiError(new DOMException("aborted", "AbortError")).kind);
  // malformed — unexpected cellular type
  kinds.add(classifyCellularResponse({ type: "cellular.weird" }).kind);
  // disconnected — status 0
  kinds.add(classifyApiError(new PinApiError(0, "")).kind);

  assert.equal(kinds.size, 8);
  assert.deepEqual(
    kinds,
    new Set([
      "idle",
      "loading",
      "loaded",
      "empty",
      "error",
      "timeout",
      "malformed",
      "disconnected",
    ]),
  );
});

test("never leaks secret values into error messages", () => {
  const secretToken = "super-secret-admin-token-abc123";
  const state = classifyApiError(
    new Error(`Auth failed for token: ${secretToken}`),
  );

  assert.equal(state.kind, "error");
  assert.ok(!state.message.includes(secretToken));
});

/* ── Center's own disable/enable gates ────────────────────────────────────── */

test("isEsimProfileEnabled reads both spellings of the active state, whitespace and case aside", () => {
  assert.equal(isEsimProfileEnabled(profile({ state: "Enabled" })), true);
  assert.equal(isEsimProfileEnabled(profile({ state: "  active  " })), true);
  assert.equal(isEsimProfileEnabled(profile({ state: "Disabled" })), false);
  assert.equal(isEsimProfileEnabled(profile({ state: undefined })), false);
  assert.equal(isEsimProfileEnabled(profile({ state: "Unknown" })), false);
});

test("disabling is offered only for an unprotected profile that is currently active", () => {
  assert.equal(canDisableEsimProfile(profile({ state: "Enabled" }), false), true);
  // Reversible, but still never for the carrier profile a device can be
  // stranded without.
  assert.equal(
    canDisableEsimProfile(profile({ state: "Enabled", protected: true }), false),
    false,
  );
  assert.equal(canDisableEsimProfile(profile({ state: "Disabled" }), false), false);
  assert.equal(canDisableEsimProfile(profile({ state: "Enabled" }), true), false);
});

test("enabling is offered only for a profile that is not already the active one", () => {
  assert.equal(canEnableEsimProfile(profile({ state: "Disabled" }), false), true);
  assert.equal(canEnableEsimProfile(profile({ state: "Enabled" }), false), false);
  assert.equal(canEnableEsimProfile(profile({ state: "active" }), false), false);
  assert.equal(canEnableEsimProfile(profile({ state: "Disabled" }), true), false);
});

test("a protected profile is never offered the irreversible action, only the reversible one", () => {
  // The asymmetry is the point: enabling a carrier profile is allowed, and
  // disabling or deleting it is not.
  const protectedActive = profile({ state: "Enabled", protected: true });
  const protectedIdle = profile({ state: "Disabled", protected: true });

  assert.equal(canDeleteEsimProfile(protectedIdle, false), false);
  assert.equal(canDisableEsimProfile(protectedActive, false), false);
  assert.equal(canEnableEsimProfile(protectedIdle, false), true);
});
