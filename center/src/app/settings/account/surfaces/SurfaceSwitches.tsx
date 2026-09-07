"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SPEECH_REGION, type SpeechApproval, type SpeechPolicy } from "@/lib/contracts/speechDisclosure";
import type { LookupPolicy, LookupProvider, LookupService, LookupState } from "@/lib/contracts/lookupDisclosure";
import styles from "./surfaces.module.css";
import { PermissionSwitch } from "./PermissionSwitch";
import { activeLookupProvider, lookupPolicy, speechPolicy, type PermissionState } from "./permissions";

/*
 * The switches every approved device shares — spoken replies and the two
 * lookups — in one place, so the Ai Pin, a phone, a Mac, a Linux PC and a TV
 * say the same sentences about the same permission.
 */

export const PROVIDERS = { searxng: "SearXNG", serp_api: "SerpApi", google_places: "Google Maps" } as const satisfies Record<LookupProvider["provider"], string>;
export const LOOKUP = {
  web: {
    title: "Look things up on the web", name: "web lookup",
    description: "Sends the words of your request to your search provider and shows what comes back.",
    privacy: "Your search provider sees the request text. Nothing else about you is sent.",
    missing: "No search provider is set up in Services.",
  },
  places: {
    title: "Find places", name: "place lookup",
    description: "Sends a named place to Google Maps and shows an address list.",
    privacy: "Google Maps sees the place name, never this device’s location.",
    missing: "No place provider is set up in Services.",
  },
} as const satisfies Record<LookupService, { title: string; name: string; description: string; privacy: string; missing: string }>;

export const providerKey = (provider: LookupProvider) => `${provider.provider}:${provider.configurationDigest}`;
/** The provider a write would use: the only configured one, or the one the owner picked. */
export function chosenProvider(state: LookupState | undefined, choice: string): LookupProvider | null {
  if (!state) return null;
  return state.providers.length === 1 ? state.providers[0] : state.providers.find(provider => providerKey(provider) === choice) ?? null;
}

type SpeechState = PermissionState<SpeechApproval | null, SpeechPolicy>;

/**
 * Which Azure region a spoken reply would use: the one Cosmos recorded, the one
 * Services holds, or the one the owner typed here. The card needs it for the
 * switch and for its set-up sequence, so it lives beside both.
 */
export function useSpeechRegion(state: SpeechState, servicesRegion: string | null, lastRegion: string, onRegionUsed: (region: string) => void) {
  const [region, setRegion] = useState(lastRegion);
  useEffect(() => { setRegion(current => current || lastRegion); }, [lastRegion]);
  const recordedRegion = state.snapshot?.policy?.provider.region ?? null;
  useEffect(() => { if (recordedRegion) onRegionUsed(recordedRegion); }, [recordedRegion, onRegionUsed]);
  return {
    region, setRegion, recordedRegion,
    speechRegion: recordedRegion ?? servicesRegion ?? (SPEECH_REGION.test(region) ? region : null),
    speaks: state.snapshot?.policy?.synthesis === true,
  };
}
export type SpeechRegion = ReturnType<typeof useSpeechRegion>;

/** Spoken shared replies on one device, with the region field only when nothing else supplies one. */
export function SpeechSwitch({ state, speech, servicesRegion, allowed = true, blocked, onRegionUsed, onRefreshDevices }: {
  state: SpeechState;
  speech: SpeechRegion;
  servicesRegion: string | null;
  /** False while this device's approval cannot carry spoken replies; turning it off stays possible. */
  allowed?: boolean;
  /** What to do about that, in one sentence. */
  blocked?: string;
  onRegionUsed(region: string): void;
  onRefreshDevices(): void;
}) {
  const { region, setRegion, recordedRegion, speechRegion, speaks } = speech;
  async function toggle(next: boolean) {
    if (!next) { await state.commit(() => ({ policy: null }), "Cosmos confirmed spoken replies off."); return; }
    if (!speechRegion) return;
    const outcome = await state.commit(() => ({ policy: speechPolicy(speechRegion) }), "Cosmos confirmed spoken replies on this device.");
    if (outcome.result === "confirmed") onRegionUsed(speechRegion);
  }
  return <PermissionSwitch title="Speak replies" checked={speaks} disabled={!allowed || !speechRegion} busy={state.busy}
    reading={state.snapshot === undefined && state.failure === null} failure={state.failure} message={state.message}
    onChange={next => void toggle(next)} onRetry={state.failure === "changed" ? onRefreshDevices : () => void state.load()}
    description={<>Cosmos reads shared replies aloud on this device with Azure Speech.
      {recordedRegion ? ` Region: ${recordedRegion}.` : servicesRegion ? ` Uses the ${servicesRegion} region from Services.` : ""}</>}
    privacy="Only replies that are safe to say out loud in a room are ever spoken.">
    {!allowed ? <span className={styles.switchState}>{blocked}</span>
      : !recordedRegion && !servicesRegion ? <label className={styles.field}>Azure Speech region
        <input value={region} maxLength={32} autoComplete="off" spellCheck={false} placeholder="westeurope" disabled={state.busy}
          onChange={event => setRegion(event.target.value.trim().toLowerCase())} />
      </label> : null}
  </PermissionSwitch>;
}

/** One lookup on one device: what it sends, to whom, and which provider it would use. */
export function LookupSwitch({ service, state, choice, onChoice, allowed = true, blocked, onRefreshDevices }: {
  service: LookupService;
  state: PermissionState<LookupState, LookupPolicy>;
  choice: string;
  onChoice(value: string): void;
  /** False while this device may not be granted anything more; turning it off stays possible. */
  allowed?: boolean;
  /** What to do about that, in one sentence. */
  blocked?: string;
  onRefreshDevices(): void;
}) {
  const active = activeLookupProvider(state.snapshot);
  const recorded = state.snapshot?.approval?.policy?.provider;
  const configured = state.snapshot?.providers ?? [];
  const checked = active !== null;
  async function toggle(next: boolean) {
    if (!next) { await state.commit(() => ({ policy: null }), `Cosmos confirmed ${LOOKUP[service].name} off.`); return; }
    const provider = chosenProvider(state.snapshot, choice);
    if (!provider) return;
    await state.commit(() => ({ policy: lookupPolicy(provider) }), `Cosmos confirmed ${LOOKUP[service].name} for this device.`);
  }
  return <PermissionSwitch title={LOOKUP[service].title} checked={checked} busy={state.busy}
    disabled={!allowed || !state.snapshot || !chosenProvider(state.snapshot, choice)}
    reading={state.snapshot === undefined && state.failure === null} failure={state.failure} message={state.message}
    onChange={next => void toggle(next)} onRetry={state.failure === "changed" ? onRefreshDevices : () => void state.load()}
    description={<>{LOOKUP[service].description}
      {active ? <> Uses {PROVIDERS[active.provider]} at <span className={styles.endpoint}>{active.endpoint}</span>.</> : null}</>}
    privacy={LOOKUP[service].privacy}>
    {allowed ? null : <span className={styles.switchState}>{blocked}</span>}
    {state.snapshot && recorded && !active ? <span className={styles.switchState} role="status">The provider set-up changed, so this permission currently authorizes nothing. Turn it on again to use the current provider.</span> : null}
    {state.snapshot && configured.length === 0 ? <span className={styles.switchState}>{LOOKUP[service].missing} Open <Link href="/settings/account/services">Services</Link>, then check again.</span> : null}
    {!checked && configured.length > 1 ? <label className={styles.field}>Provider
      <select value={choice} disabled={state.busy} onChange={event => onChoice(event.target.value)}>
        <option value="">Choose a provider</option>
        {configured.map(provider => <option key={providerKey(provider)} value={providerKey(provider)}>{PROVIDERS[provider.provider]} · {provider.endpoint}</option>)}
      </select>
    </label> : null}
  </PermissionSwitch>;
}
