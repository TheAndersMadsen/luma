/*
 * Ported from the retired Setup SPA's `featureFlagsState.ts` — only the type
 * import moved (`../api` -> `@/lib/pin-device`).
 *
 * This is the DEVICE feature-flag authority, and it is a different thing from
 * Center's /settings/account/features (a 13-name wearer allowlist read from the
 * cloud). The concepts that only exist here: a SHA-256 assignment-set hash, a
 * bounded poll that refuses to accept any acknowledgement whose hash is not the
 * exact set it is waiting for, and on-device Android Settings.Global gates.
 */

import type {
  FeatureFlagDefinition,
  FeatureFlagDelivery,
  FeatureFlagValue,
  SettingsGlobalFeatureGate,
  UpdateFeatureFlagsRequest,
} from "@/lib/pin-device";

/** null means "inherit the Penumbra/firmware default". */
export type FeatureFlagDraftValue = boolean | string | null;
export type FeatureFlagDrafts = Record<string, FeatureFlagDraftValue>;
export type SettingsGlobalDrafts = Record<string, boolean | null>;

export interface FeatureFlagUpdateResult {
  update: UpdateFeatureFlagsRequest | null;
  errors: Record<string, string>;
}

/**
 * Stock-cache delivery is complete only when the server reports the strongest
 * milestone for the exact assignment set this page is waiting for. Checking
 * the hash prevents a later, unrelated save from satisfying an older poll.
 */
export function featureFlagDeliveryAcknowledgesHash(
  delivery: FeatureFlagDelivery,
  expectedHash: string,
): boolean {
  return (
    delivery.desired_assignment_hash === expectedHash &&
    delivery.state === "stock_cache_applied" &&
    delivery.stock_cache_verified
  );
}

export const FEATURE_FLAG_DELIVERY_POLL_INTERVAL_MS = 1_500;
export const FEATURE_FLAG_DELIVERY_POLL_MAX_ATTEMPTS = 20;

export type FeatureFlagDeliveryPollStatus =
  | { state: "idle" }
  | {
      state: "polling";
      attempt: number;
      maxAttempts: number;
    }
  | { state: "verified"; attempts: number }
  | { state: "timed_out"; attempts: number }
  | { state: "superseded"; attempts: number }
  | { state: "error"; attempts: number };

export interface FeatureFlagDeliveryPollResult {
  outcome: "verified" | "timed_out" | "superseded" | "aborted";
  attempts: number;
  delivery?: FeatureFlagDelivery;
}

interface PollFeatureFlagDeliveryOptions {
  expectedHash: string;
  fetchDelivery: (signal: AbortSignal) => Promise<FeatureFlagDelivery>;
  signal: AbortSignal;
  onObservation?: (
    delivery: FeatureFlagDelivery,
    attempt: number,
  ) => void;
  intervalMs?: number;
  maxAttempts?: number;
}

function waitForDeliveryPollInterval(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, Math.max(0, delayMs));
    const abort = () => {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Poll the read-only status endpoint for one exact assignment-set identity. */
export async function pollFeatureFlagDelivery({
  expectedHash,
  fetchDelivery,
  signal,
  onObservation,
  intervalMs = FEATURE_FLAG_DELIVERY_POLL_INTERVAL_MS,
  maxAttempts = FEATURE_FLAG_DELIVERY_POLL_MAX_ATTEMPTS,
}: PollFeatureFlagDeliveryOptions): Promise<FeatureFlagDeliveryPollResult> {
  const attemptLimit = Math.max(1, Math.floor(maxAttempts));

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    if (!(await waitForDeliveryPollInterval(intervalMs, signal))) {
      return { outcome: "aborted", attempts: attempt - 1 };
    }

    let delivery: FeatureFlagDelivery;
    try {
      delivery = await fetchDelivery(signal);
    } catch (error) {
      if (signal.aborted) {
        return { outcome: "aborted", attempts: attempt - 1 };
      }
      throw error;
    }
    if (signal.aborted) {
      return { outcome: "aborted", attempts: attempt - 1 };
    }

    onObservation?.(delivery, attempt);
    if (delivery.desired_assignment_hash !== expectedHash) {
      return { outcome: "superseded", attempts: attempt, delivery };
    }
    if (featureFlagDeliveryAcknowledgesHash(delivery, expectedHash)) {
      return { outcome: "verified", attempts: attempt, delivery };
    }
  }

  return { outcome: "timed_out", attempts: attemptLimit };
}

export function featureFlagDeliveryLabel(
  state: FeatureFlagDelivery["state"],
): string {
  switch (state) {
    case "persisted":
      return "Assignment set persisted";
    case "sync_dispatched":
      return "Sync dispatched";
    case "grpc_fetched":
      return "Matching set fetched";
    case "stock_cache_applied":
      return "Stock cache applied";
  }
}

export function featureFlagDeliveryDescription(
  delivery: FeatureFlagDelivery,
): string {
  const milestone = (() => {
    switch (delivery.state) {
      case "persisted":
        return "The server has persisted this cloud assignment set.";
      case "sync_dispatched":
        return "The Android sync broadcast command was accepted for this cloud assignment set.";
      case "grpc_fetched":
        return "The matching assignment set was fetched through FeatureFlags.GetFlags.";
      case "stock_cache_applied":
        return "The matching assignment set was fetched and applied to the stock feature-flag cache.";
    }
  })();

  if (delivery.state === "stock_cache_applied") {
    return delivery.stock_cache_verified
      ? `${milestone} Its exact assignment hash and count were verified after stock applied it.`
      : `${milestone} The response did not include exact stock-cache verification.`;
  }

  return delivery.stock_cache_verified
    ? `${milestone} Exact stock-cache application is verified.`
    : `${milestone} Stock-cache application remains unverified.`;
}

export function featureFlagSaveMessage(
  delivery: FeatureFlagDelivery,
  cloudCount: number,
  settingsGlobalCount: number,
): string {
  const saved =
    cloudCount > 0 && settingsGlobalCount > 0
      ? "Saved the cloud assignment changes and Settings.Global values."
      : cloudCount > 0
        ? "Saved the cloud assignment changes."
        : "Saved the Settings.Global values.";

  if (cloudCount === 0) {
    return saved;
  }

  return `${saved} ${featureFlagDeliveryDescription(delivery)}`;
}

/**
 * True when any flag or gate in the registry carries the restart_recommended
 * marker. A cache-verified assignment still leaves these consumers on their
 * prior value until the owning process restarts or reconstructs.
 */
export function hasRestartRecommendedConsumers(
  flags: FeatureFlagDefinition[],
  gates: SettingsGlobalFeatureGate[],
): boolean {
  return (
    flags.some((flag) => flag.restart_recommended) ||
    gates.some((gate) => gate.restart_recommended)
  );
}

export function createFeatureFlagDrafts(
  flags: FeatureFlagDefinition[],
): FeatureFlagDrafts {
  return Object.fromEntries(
    flags
      .filter((flag) => flag.writable)
      .map((flag) => [
        flag.key,
        flag.override_value
          ? editableValue(flag.override_value)
          : null,
      ]),
  );
}

export function displayDraftValue(
  flag: FeatureFlagDefinition,
  draft: FeatureFlagDraftValue,
): boolean | string {
  if (draft !== null) return draft;
  return editableValue(flag.penumbra_default ?? flag.firmware_default);
}

export function featureFlagAssignmentDescription(
  flag: FeatureFlagDefinition,
): string {
  if (flag.assignment_value == null) {
    return `Current saved gRPC set omits this key; stock resolves the firmware default (${displayValue(flag.firmware_default)}).`;
  }

  return `Current saved gRPC assignment: ${displayValue(flag.assignment_value)}.`;
}

export function buildFeatureFlagUpdate(
  flags: FeatureFlagDefinition[],
  drafts: FeatureFlagDrafts,
): FeatureFlagUpdateResult {
  const overrides: NonNullable<UpdateFeatureFlagsRequest["overrides"]> = {};
  const errors: Record<string, string> = {};

  for (const flag of flags) {
    if (!flag.writable) continue;

    const draft = drafts[flag.key] ?? null;
    if (draft === null) {
      if (flag.override_value != null) overrides[flag.key] = null;
      continue;
    }

    const parsed = parseDraft(flag, draft);
    if (typeof parsed === "string") {
      errors[flag.key] = parsed;
      continue;
    }
    if (!valuesEqual(parsed, flag.override_value)) {
      overrides[flag.key] = parsed;
    }
  }

  return {
    update:
      Object.keys(errors).length === 0 && Object.keys(overrides).length > 0
        ? { overrides }
        : null,
    errors,
  };
}

export function createSettingsGlobalDrafts(
  gates: SettingsGlobalFeatureGate[],
): SettingsGlobalDrafts {
  return Object.fromEntries(
    gates
      .filter((gate) => gate.writable)
      .map((gate) => [gate.key, gate.stored_value ?? null]),
  );
}

export function displaySettingsGlobalDraft(
  gate: SettingsGlobalFeatureGate,
  draft: boolean | null | undefined,
): boolean {
  if (draft === null) return gate.default;
  return draft ?? gate.current_value ?? gate.default;
}

export function settingsGlobalRecoveryRequired(
  gate: SettingsGlobalFeatureGate,
): boolean {
  return (
    gate.available &&
    !gate.writable &&
    !gate.default &&
    (gate.stored_value === true || gate.current_value === true)
  );
}

/**
 * Pick a safe representation that differs from the currently stored value so
 * the backend receives an explicit recovery mutation.
 */
export function settingsGlobalRecoveryDraft(
  gate: SettingsGlobalFeatureGate,
): false | null {
  return gate.stored_value == null ? false : null;
}

export function buildSettingsGlobalUpdate(
  gates: SettingsGlobalFeatureGate[],
  drafts: SettingsGlobalDrafts,
): NonNullable<UpdateFeatureFlagsRequest["settings_global"]> | null {
  const settingsGlobal: NonNullable<
    UpdateFeatureFlagsRequest["settings_global"]
  > = {};

  for (const gate of gates) {
    if (!gate.available) continue;
    const hasDraft = Object.prototype.hasOwnProperty.call(drafts, gate.key);
    if (!gate.writable) {
      if (!settingsGlobalRecoveryRequired(gate) || !hasDraft) continue;
      const recoveryDraft = drafts[gate.key];
      if (recoveryDraft === true || recoveryDraft === undefined) continue;
      const stored = gate.stored_value ?? null;
      if (recoveryDraft !== stored) settingsGlobal[gate.key] = recoveryDraft;
      continue;
    }

    const draft = drafts[gate.key] ?? null;
    const stored = gate.stored_value ?? null;
    if (draft !== stored) settingsGlobal[gate.key] = draft;
  }

  return Object.keys(settingsGlobal).length > 0 ? settingsGlobal : null;
}

function editableValue(value: FeatureFlagValue): boolean | string {
  return value.type === "bool" ? value.value : String(value.value);
}

function displayValue(value: FeatureFlagValue): string {
  if (value.type === "bool") return value.value ? "enabled" : "disabled";
  if (value.type === "string") return JSON.stringify(value.value);
  return String(value.value);
}

function parseDraft(
  flag: FeatureFlagDefinition,
  draft: boolean | string,
): FeatureFlagValue | string {
  switch (flag.value_type) {
    case "bool":
      return typeof draft === "boolean"
        ? { type: "bool", value: draft }
        : "Expected an on/off value.";
    case "int": {
      if (typeof draft !== "string" || !/^-?\d+$/.test(draft.trim())) {
        return "Enter a whole number.";
      }
      const value = Number(draft);
      if (!Number.isSafeInteger(value)) return "Enter a whole number.";
      if (value < -2_147_483_648 || value > 2_147_483_647) {
        return "Value must fit the Android integer range.";
      }
      if (flag.key.endsWith("_timeout_millis") && value < 0) {
        return "Timeout cannot be negative.";
      }
      return { type: "int", value };
    }
    case "float": {
      if (typeof draft !== "string" || draft.trim() === "") {
        return "Enter a number.";
      }
      const value = Number(draft);
      if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) {
        return "Value must be a finite 32-bit number.";
      }
      return { type: "float", value };
    }
    case "string": {
      if (typeof draft !== "string") return "Enter text.";
      if (new TextEncoder().encode(draft).length > 256) {
        return "Text must be 256 bytes or fewer.";
      }
      return { type: "string", value: draft };
    }
  }
}

function valuesEqual(
  left: FeatureFlagValue,
  right: FeatureFlagValue | null | undefined,
): boolean {
  return (
    right != null &&
    left.type === right.type &&
    left.value === right.value
  );
}
