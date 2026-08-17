import type { EsimProfile } from "@/lib/pin-device";

/*
 * The eSIM safety rails.
 *
 * `canDeleteEsimProfile` is ported UNMODIFIED from the retired Setup SPA's
 * `esimSafety.ts`. Deleting an eSIM profile is irreversible and can strand a
 * Pin with no cellular identity, so the gate is three independent conditions:
 * no operation may be in flight, the profile must not be carrier-protected,
 * and it must already be disabled. A user therefore has to disable a profile
 * first, which is a reversible step, before the irreversible one becomes
 * available at all.
 */
export function canDeleteEsimProfile(
  profile: EsimProfile,
  operationPending: boolean,
): boolean {
  return (
    !operationPending &&
    profile.protected !== true &&
    profile.state?.trim().toLowerCase() === "disabled"
  );
}

/** True when the profile's own state reads as the active one. */
export function isEsimProfileEnabled(profile: EsimProfile): boolean {
  const state = profile.state?.trim().toLowerCase();
  return state === "enabled" || state === "active";
}

/**
 * OURS, not in the SPA — the SPA's page never called `disableEsimProfile`,
 * although the client has always exposed it.
 *
 * Disabling is reversible (Activate puts it back), so the gate is weaker than
 * the delete gate by exactly one condition: a carrier-protected profile is
 * still refused, because that is the profile a device can be bricked without.
 */
export function canDisableEsimProfile(
  profile: EsimProfile,
  operationPending: boolean,
): boolean {
  return (
    !operationPending &&
    profile.protected !== true &&
    isEsimProfileEnabled(profile)
  );
}

/** Enabling is only offered for a profile that is not already the active one. */
export function canEnableEsimProfile(
  profile: EsimProfile,
  operationPending: boolean,
): boolean {
  return !operationPending && !isEsimProfileEnabled(profile);
}
