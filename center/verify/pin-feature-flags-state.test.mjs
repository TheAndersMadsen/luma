/*
 * The one write path in `_lib/featureFlagsState` that can change an unsafe
 * device state: the recovery patch for a locked `humane_*_enabled` gate that
 * the Pin reports as non-writable but currently `true`. It may only go
 * downwards, a legacy gate stored as `true` can be cleared or set false as a
 * recovery, and can never be set back to true.
 *
 * Cloud feature flags are not edited on the Pin (stock fetches them from Cosmos
 * with `FeatureFlagsService.GetFlags`), so this model has no cloud half.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import assert from "node:assert/strict";
import test from "node:test";

const QUERY = "?pin-feature-flags-state-test";

const {
  buildSettingsGlobalUpdate,
  createSettingsGlobalDrafts,
  settingsGlobalRecoveryDraft,
  settingsGlobalRecoveryRequired,
} = await import(`../src/app/settings/pin/_lib/featureFlagsState.ts${QUERY}`);

test("allows only a safe recovery patch for an unsafe legacy locked gate", () => {
  const locked = {
    key: "humane_photo_sharing_enabled",
    label: "Photo sharing",
    default: false,
    restart_recommended: true,
    writable: false,
    warning: "Sharing stays locked until its backend is restored.",
    stored_value: true,
    current_value: true,
    source: "stored",
    available: true,
  };

  assert.equal(settingsGlobalRecoveryRequired(locked), true);
  assert.equal(settingsGlobalRecoveryDraft(locked), null);
  assert.deepEqual(createSettingsGlobalDrafts([locked]), {});
  assert.deepEqual(
    buildSettingsGlobalUpdate([locked], { humane_photo_sharing_enabled: null }),
    { humane_photo_sharing_enabled: null },
  );
  assert.deepEqual(
    buildSettingsGlobalUpdate([locked], { humane_photo_sharing_enabled: false }),
    { humane_photo_sharing_enabled: false },
  );
  assert.equal(
    buildSettingsGlobalUpdate([locked], { humane_photo_sharing_enabled: true }),
    null,
  );
});

/*
 * NOT ported, this shape was missing from the SPA's suite, and the gap was
 * found by mutating the guard and watching every ported case still pass.
 *
 * `settingsGlobalRecoveryRequired` is satisfied by `current_value: true` alone,
 * so a locked unsafe gate can be enabled ON THE DEVICE with no stored override
 * behind it. Every SPA fixture used `stored_value: true`, where a draft of
 * `true` is refused twice over: by the explicit `recoveryDraft === true` guard,
 * and again by the `draft !== stored` equality check that follows it. With
 * `stored_value: null` the equality check no longer helps, `true !== null`, so
 * the explicit guard is the only thing left standing between a recovery control
 * and a write that re-enables the gate it exists to switch off.
 */
test("a locked gate enabled only on the device still refuses to be re-enabled", () => {
  const locked = {
    key: "humane_photo_sharing_enabled",
    label: "Photo sharing",
    default: false,
    restart_recommended: true,
    writable: false,
    stored_value: null,
    current_value: true,
    source: "default",
    available: true,
  };

  assert.equal(settingsGlobalRecoveryRequired(locked), true);
  assert.equal(settingsGlobalRecoveryDraft(locked), false);
  assert.equal(
    buildSettingsGlobalUpdate([locked], { humane_photo_sharing_enabled: true }),
    null,
  );
  // The recovery direction still works.
  assert.deepEqual(
    buildSettingsGlobalUpdate([locked], { humane_photo_sharing_enabled: false }),
    { humane_photo_sharing_enabled: false },
  );
});
