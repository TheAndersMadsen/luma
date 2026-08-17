/*
 * Behavioural guards for `_lib/featureFlagsState`, the DEVICE feature-flag
 * editor's state model.
 *
 * This is not Center's /settings/account/features pane (a wearer allowlist read
 * from the cloud). This module drives the pane that writes the Pin's own cloud
 * assignment set and its on-device Settings.Global gates, and three of its
 * properties are the reason it can be trusted to do that:
 *
 *   - A draft of `null` means "inherit", and is a different instruction from a
 *     draft that happens to equal the default. Collapsing the two would turn
 *     "reset this override" into "send nothing" and leave the override in place.
 *   - A Settings.Global gate the Pin reports as non-writable may still be
 *     mutated, but only downwards: a legacy gate stored as `true` can be cleared
 *     or set false as a recovery, and can never be set back to true. That is the
 *     one write path in this module that exists to undo an unsafe device state,
 *     so the "cannot re-enable" half matters as much as the "can disable" half.
 *   - `pollFeatureFlagDelivery` accepts an acknowledgement only for the exact
 *     assignment-set hash it is waiting on. Without the hash check a later,
 *     unrelated save would satisfy an older poll and the pane would report a
 *     set as delivered that the device never received.
 *
 * The cases below are the `pin/setup` SPA's vitest suite, ported when that app
 * was deleted. Center's copy of the module differs from the SPA's only by a
 * header comment and the `../api` -> `@/lib/pin-device` type import, so these
 * assertions are unchanged from the ones that were passing against the SPA.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const QUERY = "?pin-feature-flags-state-test";

const {
  buildFeatureFlagUpdate,
  buildSettingsGlobalUpdate,
  createFeatureFlagDrafts,
  createSettingsGlobalDrafts,
  displayDraftValue,
  displaySettingsGlobalDraft,
  featureFlagAssignmentDescription,
  featureFlagDeliveryAcknowledgesHash,
  featureFlagDeliveryDescription,
  featureFlagDeliveryLabel,
  featureFlagSaveMessage,
  hasRestartRecommendedConsumers,
  pollFeatureFlagDelivery,
  settingsGlobalRecoveryDraft,
  settingsGlobalRecoveryRequired,
} = await import(`../src/app/settings/pin/_lib/featureFlagsState.ts${QUERY}`);

/** One cloud flag as the registry serves it: writable, no restart marker. */
function flag(key, valueType, effective, override) {
  return {
    key,
    label: key,
    description: "test",
    value_type: valueType,
    firmware_default: effective,
    override_value: override,
    desired_value: override ?? effective,
    assignment_value: override ?? null,
    source: override ? "override" : "firmware_default",
    writable: true,
    restart_recommended: false,
  };
}

/* ── feature flag editor state ────────────────────────────────────────────── */

test("distinguishes inherited effective values from explicit overrides", () => {
  const inherited = flag("vision_actions_enabled", "bool", {
    type: "bool",
    value: false,
  });
  const overridden = flag(
    "touchcode_timeout_millis",
    "int",
    { type: "int", value: 5000 },
    { type: "int", value: 7500 },
  );
  const drafts = createFeatureFlagDrafts([inherited, overridden]);

  assert.deepEqual(drafts, {
    vision_actions_enabled: null,
    touchcode_timeout_millis: "7500",
  });
  assert.equal(displayDraftValue(inherited, null), false);
  assert.equal(
    displayDraftValue(overridden, drafts.touchcode_timeout_millis),
    "7500",
  );
});

test("shows the inherited value immediately when an override is reset", () => {
  const overridden = {
    ...flag(
      "vision_actions_enabled",
      "bool",
      { type: "bool", value: false },
      { type: "bool", value: true },
    ),
    desired_value: { type: "bool", value: true },
  };

  assert.equal(displayDraftValue(overridden, null), false);
});

test("distinguishes sent assignments from stock-resolved firmware defaults", () => {
  const firmwareResolved = flag("touchcode_timeout_millis", "int", {
    type: "int",
    value: 5000,
  });
  const assigned = {
    ...flag(
      "vision_actions_enabled",
      "bool",
      { type: "bool", value: false },
      { type: "bool", value: true },
    ),
    assignment_value: { type: "bool", value: true },
  };

  assert.equal(
    featureFlagAssignmentDescription(firmwareResolved),
    "Current saved gRPC set omits this key; stock resolves the firmware default (5000).",
  );
  assert.equal(
    featureFlagAssignmentDescription(assigned),
    "Current saved gRPC assignment: enabled.",
  );
});

test("builds bool, int, float, string, and reset patches", () => {
  const flags = [
    flag("bool_flag", "bool", { type: "bool", value: false }),
    flag("int_flag", "int", { type: "int", value: 1 }),
    flag("float_flag", "float", { type: "float", value: 1.5 }),
    flag("string_flag", "string", { type: "string", value: "stock" }),
    flag(
      "reset_flag",
      "bool",
      { type: "bool", value: false },
      { type: "bool", value: true },
    ),
  ];

  assert.deepEqual(
    buildFeatureFlagUpdate(flags, {
      bool_flag: true,
      int_flag: "42",
      float_flag: "2.5",
      string_flag: "custom",
      reset_flag: null,
    }),
    {
      errors: {},
      update: {
        overrides: {
          bool_flag: { type: "bool", value: true },
          int_flag: { type: "int", value: 42 },
          float_flag: { type: "float", value: 2.5 },
          string_flag: { type: "string", value: "custom" },
          reset_flag: null,
        },
      },
    },
  );
});

test("rejects Java integer overflow and makes the whole patch invalid", () => {
  const result = buildFeatureFlagUpdate(
    [
      flag("touchcode_timeout_millis", "int", { type: "int", value: 5000 }),
      flag("vision_actions_enabled", "bool", { type: "bool", value: false }),
    ],
    {
      touchcode_timeout_millis: "2147483648",
      vision_actions_enabled: true,
    },
  );

  assert.equal(result.update, null);
  assert.ok(
    result.errors.touchcode_timeout_millis.includes("Android integer"),
    "the overflow error must name the Android integer range",
  );
});

test("returns no patch when typed values match the current overrides", () => {
  const current = flag(
    "touchcode_timeout_millis",
    "int",
    { type: "int", value: 5000 },
    { type: "int", value: 7500 },
  );

  assert.deepEqual(
    buildFeatureFlagUpdate([current], { touchcode_timeout_millis: "7500" }),
    { update: null, errors: {} },
  );
});

test("keeps Settings.Global stored values separate from effective defaults", () => {
  const gates = [
    {
      key: "humane_food_enabled",
      label: "Food",
      default: false,
      restart_recommended: false,
      writable: true,
      stored_value: null,
      current_value: false,
      source: "default",
      available: true,
    },
    {
      key: "humane_photography_jpg_enabled",
      label: "JPG",
      default: true,
      restart_recommended: true,
      writable: true,
      stored_value: false,
      current_value: false,
      source: "stored",
      available: true,
    },
  ];
  const drafts = createSettingsGlobalDrafts(gates);

  assert.deepEqual(drafts, {
    humane_food_enabled: null,
    humane_photography_jpg_enabled: false,
  });
  assert.equal(displaySettingsGlobalDraft(gates[0], null), false);
  assert.equal(buildSettingsGlobalUpdate(gates, drafts), null);
  assert.deepEqual(
    buildSettingsGlobalUpdate(gates, {
      ...drafts,
      humane_food_enabled: true,
      humane_photography_jpg_enabled: null,
    }),
    {
      humane_food_enabled: true,
      humane_photography_jpg_enabled: null,
    },
  );
});

test("never writes an unavailable Settings.Global gate", () => {
  const gate = {
    key: "humane_clock_enabled",
    label: "Clock",
    default: false,
    restart_recommended: true,
    writable: true,
    stored_value: null,
    current_value: null,
    source: "unavailable",
    available: false,
    error: "Permission denied",
  };

  assert.equal(
    buildSettingsGlobalUpdate([gate], { humane_clock_enabled: true }),
    null,
  );
});

test("keeps read-only Settings.Global gates out of drafts and updates", () => {
  const writable = {
    key: "humane_food_enabled",
    label: "Food",
    default: false,
    restart_recommended: false,
    writable: true,
    stored_value: null,
    current_value: false,
    source: "default",
    available: true,
  };
  const locked = {
    key: "humane_photo_sharing_enabled",
    label: "Photo sharing",
    default: false,
    restart_recommended: true,
    writable: false,
    warning: "Sharing stays locked until its backend is restored.",
    stored_value: null,
    current_value: false,
    source: "default",
    available: true,
  };

  assert.deepEqual(createSettingsGlobalDrafts([writable, locked]), {
    humane_food_enabled: null,
  });
  assert.deepEqual(
    buildSettingsGlobalUpdate([writable, locked], {
      humane_food_enabled: true,
      humane_photo_sharing_enabled: true,
    }),
    { humane_food_enabled: true },
  );
});

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

test("does not expose recovery or accept true for a safely disabled locked gate", () => {
  const locked = {
    key: "humane_photo_sharing_enabled",
    label: "Photo sharing",
    default: false,
    restart_recommended: true,
    writable: false,
    stored_value: null,
    current_value: false,
    source: "default",
    available: true,
  };

  assert.equal(settingsGlobalRecoveryRequired(locked), false);
  assert.deepEqual(createSettingsGlobalDrafts([locked]), {});
  assert.equal(
    buildSettingsGlobalUpdate([locked], { humane_photo_sharing_enabled: true }),
    null,
  );
});

test("describes delivery milestones without claiming stock application", () => {
  const delivery = {
    state: "grpc_fetched",
    desired_assignment_hash: "abc123",
    grpc_fetch_observed: true,
    last_grpc_fetch_unix_ms: 1_752_592_400_000,
    last_stock_cache_apply_unix_ms: null,
    stock_cache_verified: false,
    immediate_sync_supported: true,
    automatic_triggers: ["save broadcast", "daily"],
    note: "Fetch observation is not cache verification.",
  };

  assert.equal(featureFlagDeliveryLabel(delivery.state), "Matching set fetched");
  assert.equal(
    featureFlagDeliveryDescription(delivery),
    "The matching assignment set was fetched through FeatureFlags.GetFlags. Stock-cache application remains unverified.",
  );
  assert.equal(
    featureFlagSaveMessage(delivery, 2, 1),
    "Saved the cloud assignment changes and Settings.Global values. The matching assignment set was fetched through FeatureFlags.GetFlags. Stock-cache application remains unverified.",
  );
});

test("treats exact stock-cache application as stronger evidence than a gRPC fetch", () => {
  const delivery = {
    state: "stock_cache_applied",
    desired_assignment_hash: "abc123",
    grpc_fetch_observed: true,
    last_grpc_fetch_unix_ms: 1_752_592_400_000,
    last_stock_cache_apply_unix_ms: 1_752_592_401_000,
    stock_cache_verified: true,
    immediate_sync_supported: true,
    automatic_triggers: ["save broadcast", "daily"],
    note: "Exact stock-cache application was acknowledged.",
  };

  assert.equal(featureFlagDeliveryLabel(delivery.state), "Stock cache applied");
  assert.equal(
    featureFlagDeliveryDescription(delivery),
    "The matching assignment set was fetched and applied to the stock feature-flag cache. Its exact assignment hash and count were verified after stock applied it.",
  );
  assert.ok(
    featureFlagSaveMessage(delivery, 1, 0).includes(
      "Saved the cloud assignment changes. The matching assignment set was fetched and applied to the stock feature-flag cache.",
    ),
    "a cloud-only save must lead with the saved sentence and then the delivery milestone",
  );
  assert.equal(featureFlagDeliveryAcknowledgesHash(delivery, "abc123"), true);
  assert.equal(
    featureFlagDeliveryAcknowledgesHash(delivery, "other-hash"),
    false,
  );
});

test("requires verified stock application, not only an applied state label", () => {
  const delivery = {
    state: "stock_cache_applied",
    desired_assignment_hash: "abc123",
    grpc_fetch_observed: true,
    last_grpc_fetch_unix_ms: null,
    last_stock_cache_apply_unix_ms: null,
    stock_cache_verified: false,
    immediate_sync_supported: true,
    automatic_triggers: ["save broadcast"],
    note: "No exact acknowledgement.",
  };

  assert.equal(featureFlagDeliveryAcknowledgesHash(delivery, "abc123"), false);
});

test("distinguishes persistence from dispatch acceptance", () => {
  const base = {
    desired_assignment_hash: "abc123",
    grpc_fetch_observed: false,
    last_grpc_fetch_unix_ms: null,
    last_stock_cache_apply_unix_ms: null,
    stock_cache_verified: false,
    immediate_sync_supported: true,
    automatic_triggers: ["daily"],
    note: "Delivery is observed separately.",
  };

  assert.ok(
    featureFlagDeliveryDescription({ ...base, state: "persisted" }).includes(
      "persisted this cloud assignment set",
    ),
  );
  assert.ok(
    featureFlagDeliveryDescription({
      ...base,
      state: "sync_dispatched",
    }).includes("sync broadcast command was accepted"),
  );
  assert.ok(
    featureFlagSaveMessage({ ...base, state: "persisted" }, 0, 1).includes(
      "Saved the Settings.Global values.",
    ),
  );
});

/* ── feature flag typed override and reset ────────────────────────────────── */

test("rejects negative timeout values", () => {
  const result = buildFeatureFlagUpdate(
    [flag("touchcode_timeout_millis", "int", { type: "int", value: 5000 })],
    { touchcode_timeout_millis: "-1" },
  );

  assert.equal(result.update, null);
  assert.ok(result.errors.touchcode_timeout_millis.includes("negative"));
});

test("rejects float values beyond 32-bit range", () => {
  const result = buildFeatureFlagUpdate(
    [flag("score_multiplier", "float", { type: "float", value: 1.0 })],
    { score_multiplier: "3.5e38" },
  );

  assert.equal(result.update, null);
  assert.ok(result.errors.score_multiplier.includes("32-bit"));
});

test("rejects strings exceeding 256 bytes", () => {
  const longString = "a".repeat(257);
  const result = buildFeatureFlagUpdate(
    [flag("label_text", "string", { type: "string", value: "short" })],
    { label_text: longString },
  );

  assert.equal(result.update, null);
  assert.ok(result.errors.label_text.includes("256 bytes"));
});

test("rejects non-boolean draft for a bool flag", () => {
  const result = buildFeatureFlagUpdate(
    [flag("vision_actions_enabled", "bool", { type: "bool", value: false })],
    { vision_actions_enabled: "true" },
  );

  assert.equal(result.update, null);
  assert.ok(result.errors.vision_actions_enabled.includes("on/off"));
});

test("excludes non-writable flags from updates even when drafts are provided", () => {
  const locked = {
    ...flag("locked_flag", "bool", { type: "bool", value: false }),
    writable: false,
  };
  const result = buildFeatureFlagUpdate([locked], { locked_flag: true });

  assert.equal(result.update, null);
  assert.deepEqual(result.errors, {});
});

test("keeps valid fields but rejects the whole patch when one field errors", () => {
  const result = buildFeatureFlagUpdate(
    [
      flag("int_flag", "int", { type: "int", value: 1 }),
      flag("bool_flag", "bool", { type: "bool", value: false }),
    ],
    { int_flag: "99999999999999", bool_flag: true },
  );

  assert.equal(result.update, null);
  assert.notEqual(result.errors.int_flag, undefined);
});

test("resets an override back to null when draft is null and override exists", () => {
  const overridden = flag(
    "test_flag",
    "bool",
    { type: "bool", value: false },
    { type: "bool", value: true },
  );
  const result = buildFeatureFlagUpdate([overridden], { test_flag: null });

  assert.deepEqual(result.update, { overrides: { test_flag: null } });
  assert.deepEqual(result.errors, {});
});

test("does not emit a reset when draft is null and no override exists", () => {
  const inherited = flag("test_flag", "bool", { type: "bool", value: false });
  const result = buildFeatureFlagUpdate([inherited], { test_flag: null });

  assert.equal(result.update, null);
  assert.deepEqual(result.errors, {});
});

/* ── desired versus assignment versus stock-cache truth ───────────────────── */

test("acknowledges hash only when state is stock_cache_applied AND verified is true", () => {
  const base = {
    desired_assignment_hash: "hash-abc",
    grpc_fetch_observed: true,
    last_grpc_fetch_unix_ms: null,
    last_stock_cache_apply_unix_ms: null,
    stock_cache_verified: false,
    immediate_sync_supported: true,
    automatic_triggers: [],
    note: "test",
  };

  assert.equal(
    featureFlagDeliveryAcknowledgesHash(
      { ...base, state: "stock_cache_applied", stock_cache_verified: true },
      "hash-abc",
    ),
    true,
  );
  assert.equal(
    featureFlagDeliveryAcknowledgesHash(
      { ...base, state: "stock_cache_applied", stock_cache_verified: false },
      "hash-abc",
    ),
    false,
  );
  assert.equal(
    featureFlagDeliveryAcknowledgesHash(
      { ...base, state: "grpc_fetched", stock_cache_verified: true },
      "hash-abc",
    ),
    false,
  );
  assert.equal(
    featureFlagDeliveryAcknowledgesHash(
      { ...base, state: "persisted", stock_cache_verified: true },
      "hash-abc",
    ),
    false,
  );
});

test("does not claim verification when stock_cache_applied but verification is false", () => {
  const delivery = {
    state: "stock_cache_applied",
    desired_assignment_hash: "hash-abc",
    grpc_fetch_observed: true,
    last_grpc_fetch_unix_ms: null,
    last_stock_cache_apply_unix_ms: null,
    stock_cache_verified: false,
    immediate_sync_supported: true,
    automatic_triggers: [],
    note: "Awaiting exact acknowledgement.",
  };

  const description = featureFlagDeliveryDescription(delivery);
  assert.ok(
    description.includes("did not include exact stock-cache verification"),
  );
  assert.ok(!description.includes("verified after stock applied it"));
});

test("reports exact stock-cache verification for non-stock_cache_applied states", () => {
  const delivery = {
    state: "grpc_fetched",
    desired_assignment_hash: "hash-abc",
    grpc_fetch_observed: true,
    last_grpc_fetch_unix_ms: null,
    last_stock_cache_apply_unix_ms: null,
    stock_cache_verified: true,
    immediate_sync_supported: true,
    automatic_triggers: [],
    note: "Exact verification before state promotion.",
  };

  assert.ok(
    featureFlagDeliveryDescription(delivery).includes(
      "Exact stock-cache application is verified",
    ),
  );
});

test("builds distinct save messages for cloud-only, settings-only, and combined saves", () => {
  const delivery = {
    state: "persisted",
    desired_assignment_hash: "hash-abc",
    grpc_fetch_observed: false,
    last_grpc_fetch_unix_ms: null,
    last_stock_cache_apply_unix_ms: null,
    stock_cache_verified: false,
    immediate_sync_supported: true,
    automatic_triggers: [],
    note: "Saved separately.",
  };

  assert.match(
    featureFlagSaveMessage(delivery, 3, 0),
    /^Saved the cloud assignment changes\./,
  );
  assert.match(
    featureFlagSaveMessage(delivery, 0, 2),
    /^Saved the Settings\.Global values\./,
  );
  assert.match(
    featureFlagSaveMessage(delivery, 1, 1),
    /^Saved the cloud assignment changes and Settings\.Global values\./,
  );
});

test("never claims stock application when only gRPC fetch is observed", () => {
  const delivery = {
    state: "grpc_fetched",
    desired_assignment_hash: "hash-abc",
    grpc_fetch_observed: true,
    last_grpc_fetch_unix_ms: 1_752_592_400_000,
    last_stock_cache_apply_unix_ms: null,
    stock_cache_verified: false,
    immediate_sync_supported: true,
    automatic_triggers: ["daily"],
    note: "Fetch is not application.",
  };

  const description = featureFlagDeliveryDescription(delivery);
  assert.ok(description.includes("Stock-cache application remains unverified"));
  assert.ok(!description.includes("applied to the stock feature-flag cache"));
});

/* ── restart guidance ─────────────────────────────────────────────────────── */

test("preserves restart_recommended metadata without altering update logic", () => {
  const restartFlag = {
    ...flag("cmu_ultra_enabled", "bool", { type: "bool", value: false }),
    restart_recommended: true,
  };
  const noRestartFlag = {
    ...flag("quiet_flag", "bool", { type: "bool", value: false }),
    restart_recommended: false,
  };

  const result = buildFeatureFlagUpdate([restartFlag, noRestartFlag], {
    cmu_ultra_enabled: true,
    quiet_flag: true,
  });

  assert.deepEqual(result.update, {
    overrides: {
      cmu_ultra_enabled: { type: "bool", value: true },
      quiet_flag: { type: "bool", value: true },
    },
  });
  assert.equal(restartFlag.restart_recommended, true);
  assert.equal(noRestartFlag.restart_recommended, false);
});

test("marks restart_recommended on settings-global gates independently of writability", () => {
  const restartGate = {
    key: "humane_restart_gate",
    label: "Restart gate",
    default: false,
    restart_recommended: true,
    writable: true,
    stored_value: null,
    current_value: false,
    source: "default",
    available: true,
  };
  const noRestartGate = {
    key: "humane_no_restart_gate",
    label: "No restart gate",
    default: false,
    restart_recommended: false,
    writable: true,
    stored_value: null,
    current_value: false,
    source: "default",
    available: true,
  };

  assert.equal(restartGate.restart_recommended, true);
  assert.equal(noRestartGate.restart_recommended, false);
  assert.deepEqual(
    buildSettingsGlobalUpdate([restartGate, noRestartGate], {
      humane_restart_gate: true,
      humane_no_restart_gate: true,
    }),
    {
      humane_restart_gate: true,
      humane_no_restart_gate: true,
    },
  );
});

/* ── poll: superseded hashes and timeout/retry ────────────────────────────── */

/** A delivery that is real but has not yet reached stock-cache verification. */
const PENDING_FETCHED_DELIVERY = {
  state: "grpc_fetched",
  desired_assignment_hash: "saved-hash",
  grpc_fetch_observed: true,
  last_grpc_fetch_unix_ms: null,
  last_stock_cache_apply_unix_ms: null,
  stock_cache_verified: false,
  immediate_sync_supported: true,
  automatic_triggers: ["save broadcast"],
  note: "Waiting for stock cache acknowledgement.",
};

test("returns superseded immediately when the server desires a different hash", async () => {
  const controller = new AbortController();
  const result = await pollFeatureFlagDelivery({
    expectedHash: "saved-hash",
    signal: controller.signal,
    intervalMs: 0,
    maxAttempts: 10,
    fetchDelivery: async () => ({
      ...PENDING_FETCHED_DELIVERY,
      desired_assignment_hash: "different-hash",
    }),
  });

  assert.equal(result.outcome, "superseded");
  assert.equal(result.attempts, 1);
  assert.equal(result.delivery?.desired_assignment_hash, "different-hash");
});

test("times out after exhausting the attempt limit without verification", async () => {
  const controller = new AbortController();
  const result = await pollFeatureFlagDelivery({
    expectedHash: "saved-hash",
    signal: controller.signal,
    intervalMs: 0,
    maxAttempts: 3,
    fetchDelivery: async () => PENDING_FETCHED_DELIVERY,
  });

  assert.equal(result.outcome, "timed_out");
  assert.equal(result.attempts, 3);
});

test("aborts mid-poll when the signal is cancelled after the first attempt", async () => {
  let calls = 0;
  const controller = new AbortController();
  const result = await pollFeatureFlagDelivery({
    expectedHash: "saved-hash",
    signal: controller.signal,
    intervalMs: 50,
    maxAttempts: 10,
    fetchDelivery: async () => {
      calls += 1;
      if (calls === 1) controller.abort();
      return PENDING_FETCHED_DELIVERY;
    },
  });

  assert.equal(result.outcome, "aborted");
  assert.ok(result.attempts <= 1, `attempts was ${result.attempts}`);
});

test("propagates fetch errors when the signal is not aborted", async () => {
  const controller = new AbortController();
  await assert.rejects(
    pollFeatureFlagDelivery({
      expectedHash: "saved-hash",
      signal: controller.signal,
      intervalMs: 0,
      maxAttempts: 5,
      fetchDelivery: async () => {
        throw new Error("network down");
      },
    }),
    /network down/,
  );
});

test("returns aborted when fetch throws after signal is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await pollFeatureFlagDelivery({
    expectedHash: "saved-hash",
    signal: controller.signal,
    intervalMs: 0,
    maxAttempts: 5,
    fetchDelivery: async () => {
      throw new Error("should not matter");
    },
  });

  assert.equal(result.outcome, "aborted");
  assert.equal(result.attempts, 0);
});

test("fires onObservation for each attempt until superseded", async () => {
  const observations = [];
  const controller = new AbortController();
  let calls = 0;
  await pollFeatureFlagDelivery({
    expectedHash: "saved-hash",
    signal: controller.signal,
    intervalMs: 0,
    maxAttempts: 5,
    fetchDelivery: async () => {
      calls += 1;
      return calls === 2
        ? {
            ...PENDING_FETCHED_DELIVERY,
            desired_assignment_hash: "newer-hash",
          }
        : PENDING_FETCHED_DELIVERY;
    },
    onObservation: (_delivery, attempt) => observations.push(attempt),
  });

  assert.deepEqual(observations, [1, 2]);
});

/* ── display and precedence ───────────────────────────────────────────────── */

test("prefers penumbra_default over firmware_default when draft is null", () => {
  const penumbraFlag = {
    ...flag("cmu_ultra_enabled", "bool", { type: "bool", value: false }),
    penumbra_default: { type: "bool", value: true },
  };

  assert.equal(displayDraftValue(penumbraFlag, null), true);
});

test("falls back to firmware_default when penumbra_default is absent", () => {
  const firmwareOnly = flag("basic_flag", "int", { type: "int", value: 42 });

  assert.equal(displayDraftValue(firmwareOnly, null), "42");
});

test("returns the draft value when explicitly set, ignoring defaults", () => {
  const penumbraFlag = {
    ...flag("test_flag", "bool", { type: "bool", value: false }),
    penumbra_default: { type: "bool", value: true },
  };

  assert.equal(displayDraftValue(penumbraFlag, false), false);
  assert.equal(displayDraftValue(penumbraFlag, "custom"), "custom");
});

test("shows assignment description for non-bool types", () => {
  const intAssigned = {
    ...flag("timeout_flag", "int", { type: "int", value: 5000 }),
    assignment_value: { type: "int", value: 9999 },
  };
  const stringAssigned = {
    ...flag("label_flag", "string", { type: "string", value: "stock" }),
    assignment_value: { type: "string", value: "custom" },
  };

  assert.equal(
    featureFlagAssignmentDescription(intAssigned),
    "Current saved gRPC assignment: 9999.",
  );
  assert.equal(
    featureFlagAssignmentDescription(stringAssigned),
    'Current saved gRPC assignment: "custom".',
  );
});

test("shows disabled/enabled labels for bool assignments", () => {
  const disabledAssigned = {
    ...flag("bool_flag", "bool", { type: "bool", value: true }),
    assignment_value: { type: "bool", value: false },
  };
  const enabledAssigned = {
    ...flag("bool_flag2", "bool", { type: "bool", value: false }),
    assignment_value: { type: "bool", value: true },
  };

  assert.ok(
    featureFlagAssignmentDescription(disabledAssigned).includes("disabled"),
  );
  assert.ok(
    featureFlagAssignmentDescription(enabledAssigned).includes("enabled"),
  );
});

/* ── delivery labels ──────────────────────────────────────────────────────── */

test("labels all four delivery states distinctly", () => {
  assert.equal(
    featureFlagDeliveryLabel("persisted"),
    "Assignment set persisted",
  );
  assert.equal(featureFlagDeliveryLabel("sync_dispatched"), "Sync dispatched");
  assert.equal(featureFlagDeliveryLabel("grpc_fetched"), "Matching set fetched");
  assert.equal(
    featureFlagDeliveryLabel("stock_cache_applied"),
    "Stock cache applied",
  );
});

/* ── featureFlagSaveMessage: settings-only omits delivery ─────────────────── */

/** Persisted, but nothing beyond persistence has been observed. */
const PERSISTED_ONLY_DELIVERY = {
  state: "persisted",
  desired_assignment_hash: "hash-msg",
  grpc_fetch_observed: false,
  last_grpc_fetch_unix_ms: null,
  last_stock_cache_apply_unix_ms: null,
  stock_cache_verified: false,
  immediate_sync_supported: true,
  automatic_triggers: ["daily"],
  note: "Settings.Global saves are local.",
};

test("Settings.Global-only save message is exactly the saved sentence with no delivery description", () => {
  assert.equal(
    featureFlagSaveMessage(PERSISTED_ONLY_DELIVERY, 0, 2),
    "Saved the Settings.Global values.",
  );
  assert.ok(
    !featureFlagSaveMessage(PERSISTED_ONLY_DELIVERY, 0, 1).includes(
      "Assignment set persisted",
    ),
  );
});

test("combined save still appends delivery description", () => {
  const message = featureFlagSaveMessage(PERSISTED_ONLY_DELIVERY, 1, 1);

  assert.ok(
    message.includes(
      "Saved the cloud assignment changes and Settings.Global values.",
    ),
  );
  assert.ok(
    message.includes("The server has persisted this cloud assignment set."),
  );
});

/* ── hasRestartRecommendedConsumers ───────────────────────────────────────── */

const RESTART_FLAG = {
  key: "cmu_ultra_enabled",
  label: "Catch Me Up Ultra",
  description: "Accessory path.",
  value_type: "bool",
  firmware_default: { type: "bool", value: true },
  desired_value: { type: "bool", value: true },
  assignment_value: { type: "bool", value: true },
  source: "firmware_default",
  writable: true,
  restart_recommended: true,
};
const QUIET_FLAG = {
  key: "touchcode_timeout_millis",
  label: "Touchcode timeout",
  description: "Timeout.",
  value_type: "int",
  firmware_default: { type: "int", value: 5000 },
  desired_value: { type: "int", value: 5000 },
  assignment_value: null,
  source: "firmware_default",
  writable: true,
  restart_recommended: false,
};
const RESTART_GATE = {
  key: "humane_food_enabled",
  label: "Food and nutrition",
  default: false,
  restart_recommended: true,
  writable: true,
  stored_value: null,
  current_value: false,
  source: "default",
  available: true,
};
const QUIET_GATE = {
  key: "humane_photo_sharing_enabled",
  label: "Photo sharing",
  default: false,
  restart_recommended: false,
  writable: false,
  stored_value: null,
  current_value: false,
  source: "default",
  available: true,
};

test("hasRestartRecommendedConsumers returns false when neither flags nor gates require restart", () => {
  assert.equal(hasRestartRecommendedConsumers([QUIET_FLAG], [QUIET_GATE]), false);
});

test("hasRestartRecommendedConsumers returns true when any cloud flag requires restart", () => {
  assert.equal(
    hasRestartRecommendedConsumers([QUIET_FLAG, RESTART_FLAG], [QUIET_GATE]),
    true,
  );
});

test("hasRestartRecommendedConsumers returns true when any Settings.Global gate requires restart", () => {
  assert.equal(
    hasRestartRecommendedConsumers([QUIET_FLAG], [QUIET_GATE, RESTART_GATE]),
    true,
  );
});

test("hasRestartRecommendedConsumers returns false for empty registries", () => {
  assert.equal(hasRestartRecommendedConsumers([], []), false);
});

/* ── false-to-true-to-false lifecycle with actual registry keys ───────────── */

test("cmu_ultra_enabled (restart-required cloud flag) survives enable then disable", () => {
  const base = {
    key: "cmu_ultra_enabled",
    label: "Catch Me Up Ultra accessory path",
    description: "Controls the stock iPhone ANCS notification parser.",
    value_type: "bool",
    firmware_default: { type: "bool", value: true },
    desired_value: { type: "bool", value: true },
    assignment_value: null,
    source: "firmware_default",
    writable: true,
    restart_recommended: true,
  };

  // Phase 1: user disables (true-to-false)
  const disableResult = buildFeatureFlagUpdate([base], {
    cmu_ultra_enabled: false,
  });
  assert.deepEqual(disableResult.errors, {});
  assert.deepEqual(disableResult.update, {
    overrides: { cmu_ultra_enabled: { type: "bool", value: false } },
  });

  // Phase 2: user re-enables (false-to-true)
  const enableResult = buildFeatureFlagUpdate([base], {
    cmu_ultra_enabled: true,
  });
  assert.deepEqual(enableResult.errors, {});
  assert.deepEqual(enableResult.update, {
    overrides: { cmu_ultra_enabled: { type: "bool", value: true } },
  });

  // Phase 3: user resets to default (null)
  const overridden = {
    ...base,
    override_value: { type: "bool", value: false },
    assignment_value: { type: "bool", value: false },
    desired_value: { type: "bool", value: false },
    source: "override",
  };
  const resetResult = buildFeatureFlagUpdate([overridden], {
    cmu_ultra_enabled: null,
  });
  assert.deepEqual(resetResult.errors, {});
  assert.deepEqual(resetResult.update, {
    overrides: { cmu_ultra_enabled: null },
  });
});

test("humane_food_enabled (restart-required Settings.Global gate) survives full enable-disable cycle", () => {
  const gate = {
    key: "humane_food_enabled",
    label: "Food and nutrition",
    default: false,
    restart_recommended: true,
    writable: true,
    stored_value: null,
    current_value: false,
    source: "default",
    available: true,
  };

  // Phase 1: enable (false to true)
  assert.deepEqual(
    buildSettingsGlobalUpdate([gate], { humane_food_enabled: true }),
    { humane_food_enabled: true },
  );

  // Phase 2: disable back to default (true to null)
  const storedGate = {
    ...gate,
    stored_value: true,
    current_value: true,
    source: "stored",
  };
  assert.deepEqual(
    buildSettingsGlobalUpdate([storedGate], { humane_food_enabled: null }),
    { humane_food_enabled: null },
  );

  // Phase 3: explicitly set false (different from null)
  assert.deepEqual(
    buildSettingsGlobalUpdate([storedGate], { humane_food_enabled: false }),
    { humane_food_enabled: false },
  );

  // Phase 4: no change from stored value produces no patch
  assert.equal(
    buildSettingsGlobalUpdate([storedGate], { humane_food_enabled: true }),
    null,
  );
});

test("vision_actions_enabled (restart-required cloud flag) survives true-to-false-to-null", () => {
  const base = {
    key: "vision_actions_enabled",
    label: "Vision actions",
    description: "Vision assistant.",
    value_type: "bool",
    firmware_default: { type: "bool", value: false },
    desired_value: { type: "bool", value: false },
    assignment_value: null,
    source: "firmware_default",
    writable: true,
    restart_recommended: true,
  };

  assert.deepEqual(
    buildFeatureFlagUpdate([base], { vision_actions_enabled: true }).update,
    { overrides: { vision_actions_enabled: { type: "bool", value: true } } },
  );

  assert.deepEqual(
    buildFeatureFlagUpdate([base], { vision_actions_enabled: false }).update,
    { overrides: { vision_actions_enabled: { type: "bool", value: false } } },
  );

  // Reset (null) after having an override
  const overridden = {
    ...base,
    override_value: { type: "bool", value: true },
    assignment_value: { type: "bool", value: true },
    desired_value: { type: "bool", value: true },
    source: "override",
  };
  assert.deepEqual(
    buildFeatureFlagUpdate([overridden], { vision_actions_enabled: null })
      .update,
    { overrides: { vision_actions_enabled: null } },
  );
});

/* ── pollFeatureFlagDelivery: superseded and retry lifecycle ──────────────── */

/** Persisted only: the poll has something to read but nothing to accept yet. */
const PENDING_PERSISTED_DELIVERY = {
  state: "persisted",
  desired_assignment_hash: "saved-hash",
  grpc_fetch_observed: false,
  last_grpc_fetch_unix_ms: null,
  last_stock_cache_apply_unix_ms: null,
  stock_cache_verified: false,
  immediate_sync_supported: true,
  automatic_triggers: ["save broadcast", "daily"],
  note: "Awaiting stock acknowledgement.",
};

test("returns superseded when the server desires a different hash mid-poll", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await pollFeatureFlagDelivery({
    expectedHash: "saved-hash",
    signal: controller.signal,
    intervalMs: 0,
    maxAttempts: 5,
    fetchDelivery: async () => {
      calls += 1;
      return calls === 1
        ? PENDING_PERSISTED_DELIVERY
        : {
            ...PENDING_PERSISTED_DELIVERY,
            desired_assignment_hash: "newer-hash",
          };
    },
  });

  assert.equal(result.outcome, "superseded");
  assert.equal(result.attempts, 2);
  assert.equal(result.delivery?.desired_assignment_hash, "newer-hash");
});

test("distinguishes superseded from timed_out when hash changes on the final attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await pollFeatureFlagDelivery({
    expectedHash: "saved-hash",
    signal: controller.signal,
    intervalMs: 0,
    maxAttempts: 3,
    fetchDelivery: async () => {
      calls += 1;
      return calls === 3
        ? {
            ...PENDING_PERSISTED_DELIVERY,
            desired_assignment_hash: "other-hash",
          }
        : PENDING_PERSISTED_DELIVERY;
    },
  });

  assert.equal(result.outcome, "superseded");
  assert.equal(result.attempts, 3);
});

test("returns verified after retry following a transient failure", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await pollFeatureFlagDelivery({
    expectedHash: "saved-hash",
    signal: controller.signal,
    intervalMs: 0,
    maxAttempts: 5,
    fetchDelivery: async () => {
      calls += 1;
      if (calls < 3) return PENDING_PERSISTED_DELIVERY;
      return {
        ...PENDING_PERSISTED_DELIVERY,
        state: "stock_cache_applied",
        stock_cache_verified: true,
      };
    },
  });

  assert.equal(result.outcome, "verified");
  assert.equal(result.attempts, 3);
});

/* ── disabled controls for non-writable flags and gates ───────────────────── */

test("non-writable cloud flag produces no update even when a draft is provided", () => {
  const locked = {
    key: "laser_finding_guide",
    label: "Laser finding guide",
    description: "No runtime consumer.",
    value_type: "bool",
    firmware_default: { type: "bool", value: false },
    desired_value: { type: "bool", value: false },
    assignment_value: null,
    source: "firmware_default",
    writable: false,
    restart_recommended: false,
  };

  const result = buildFeatureFlagUpdate([locked], { laser_finding_guide: true });
  assert.equal(result.update, null);
  assert.deepEqual(result.errors, {});
});

test("non-writable Settings.Global gate with stored true requires recovery, not arbitrary mutation", () => {
  const locked = {
    key: "humane_cmu_ultra_enabled",
    label: "Unverified legacy CMU setting",
    default: false,
    restart_recommended: false,
    writable: false,
    stored_value: true,
    current_value: true,
    source: "stored",
    available: true,
  };

  assert.equal(settingsGlobalRecoveryRequired(locked), true);

  // Cannot re-enable (true) — only a safe disabled value is accepted.
  assert.equal(
    buildSettingsGlobalUpdate([locked], { humane_cmu_ultra_enabled: true }),
    null,
  );

  // Safe recovery: null (delete) or false.
  assert.deepEqual(
    buildSettingsGlobalUpdate([locked], { humane_cmu_ultra_enabled: null }),
    { humane_cmu_ultra_enabled: null },
  );
  assert.deepEqual(
    buildSettingsGlobalUpdate([locked], { humane_cmu_ultra_enabled: false }),
    { humane_cmu_ultra_enabled: false },
  );
});

/*
 * NOT ported — this shape was missing from the SPA's suite, and the gap was
 * found by mutating the guard and watching every ported case still pass.
 *
 * `settingsGlobalRecoveryRequired` is satisfied by `current_value: true` alone,
 * so a locked unsafe gate can be enabled ON THE DEVICE with no stored override
 * behind it. Every SPA fixture used `stored_value: true`, where a draft of
 * `true` is refused twice over: by the explicit `recoveryDraft === true` guard,
 * and again by the `draft !== stored` equality check that follows it. With
 * `stored_value: null` the equality check no longer helps — `true !== null` — so
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

test("unavailable Settings.Global gate never produces a mutation", () => {
  const unavailable = {
    key: "humane_clock_enabled",
    label: "Legacy clock gate",
    default: false,
    restart_recommended: false,
    writable: true,
    stored_value: null,
    current_value: null,
    source: "unavailable",
    available: false,
    error: "Permission denied",
  };

  assert.equal(
    buildSettingsGlobalUpdate([unavailable], { humane_clock_enabled: true }),
    null,
  );
  assert.equal(
    buildSettingsGlobalUpdate([unavailable], { humane_clock_enabled: false }),
    null,
  );
  assert.equal(
    buildSettingsGlobalUpdate([unavailable], { humane_clock_enabled: null }),
    null,
  );
});

test("safely disabled locked gate does not expose recovery or accept true", () => {
  const safeDisabled = {
    key: "humane_photo_sharing_enabled",
    label: "Photo sharing",
    default: false,
    restart_recommended: false,
    writable: false,
    stored_value: null,
    current_value: false,
    source: "default",
    available: true,
  };

  assert.equal(settingsGlobalRecoveryRequired(safeDisabled), false);
  assert.deepEqual(createSettingsGlobalDrafts([safeDisabled]), {});
  assert.equal(
    buildSettingsGlobalUpdate([safeDisabled], {
      humane_photo_sharing_enabled: true,
    }),
    null,
  );
  assert.equal(
    buildSettingsGlobalUpdate([safeDisabled], {
      humane_photo_sharing_enabled: false,
    }),
    null,
  );
});
