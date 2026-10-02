/*
 * Security and destructive-action guards for the eSIM pane's pure modules:
 * `_lib/esimSafety` (which device actions may be offered at all) and the part
 * of `_lib/esimPresentation` that keeps error detail out of wearer-facing
 * messages.
 *
 * esimSafety is the highest-consequence pure function in this pane. Deleting an
 * eSIM profile is irreversible and can leave a Pin with no cellular identity, so
 * the gate is three independent conditions, nothing in flight, not
 * carrier-protected, already disabled, and the ordering matters as much as the
 * conditions: a user has to take the reversible step (disable) before the
 * irreversible one is reachable. The asymmetry case pins the whole table:
 * a protected profile is never offered the irreversible action, only the
 * reversible one.
 *
 * classifyApiError substitutes fixed copy for anything it did not construct
 * itself: errors here can contain a bearer token or a filesystem path, and the
 * pane renders its message directly.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import assert from "node:assert/strict";
import test from "node:test";

const QUERY = "?pin-esim-test";

const { canDeleteEsimProfile, canDisableEsimProfile, canEnableEsimProfile } =
  await import(`../src/app/settings/pin/_lib/esimSafety.ts${QUERY}`);
const { classifyApiError } = await import(`../src/app/settings/pin/_lib/esimPresentation.ts${QUERY}`);
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

/* ── classifyApiError ─────────────────────────────────────────────────────── */

test("classifyApiError does not expose internal error details in user-facing messages", () => {
  const state = classifyApiError(
    new Error("internal stack trace at /secret/path"),
  );

  assert.equal(state.kind, "error");
  assert.ok(!state.message.includes("/secret/path"));
  assert.ok(!state.message.includes("stack trace"));
});

/* ── Center's own disable/enable gates ────────────────────────────────────── */

test("a protected profile is never offered the irreversible action, only the reversible one", () => {
  // The asymmetry is the point: enabling a carrier profile is allowed, and
  // disabling or deleting it is not.
  const protectedActive = profile({ state: "Enabled", protected: true });
  const protectedIdle = profile({ state: "Disabled", protected: true });

  assert.equal(canDeleteEsimProfile(protectedIdle, false), false);
  assert.equal(canDisableEsimProfile(protectedActive, false), false);
  assert.equal(canEnableEsimProfile(protectedIdle, false), true);
});
