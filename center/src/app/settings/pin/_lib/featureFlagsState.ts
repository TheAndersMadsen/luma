/*
 * Draft state for the Pin's on-device Android Settings.Global gates
 * (stock `humane_*_enabled` selectors plus Luma-owned device features), the
 * one feature-flag plane that lives on the Pin. No cloud flag can reach it;
 * cloud feature flags come from Cosmos `FeatureFlagsService.GetFlags` and are
 * edited on /settings/account/features.
 */

import type {
  SettingsGlobalFeatureGate,
  UpdateFeatureFlagsRequest,
} from "@/lib/pin-device";

export type SettingsGlobalDrafts = Record<string, boolean | null>;

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
