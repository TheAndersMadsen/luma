"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { StatusChip } from "@/components/Status";
import { NATIVE_PLATFORMS, type NativePlatform, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import { SPEECH_REGION } from "@/lib/contracts/speechDisclosure";
import type { LookupProvider, LookupService, LookupState } from "@/lib/contracts/lookupDisclosure";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import { fingerprintLines } from "./fingerprint";
import { PermissionSwitch } from "./PermissionSwitch";
import { activeLookupProvider, lookupPermission, lookupPolicy, PRIVATE_POLICY, privatePermission, speechPermission, speechPolicy, usePermission, type Outcome } from "./permissions";

export const DEVICE_LABELS = { android: "Android phone", android_tv: "Android TV", macos: "Mac", linux: "Linux PC" } as const satisfies Record<NativePlatform, string>;
/** A device is connected only while the runtime holds a signed connection for it; approval alone is not a connection. */
export const deviceStatus = (row: NativeSurface) => row.connected ? row.visible ? "Connected" : "Connected · app in background" : "Not connected";
const PROVIDERS = { searxng: "SearXNG", serp_api: "SerpApi", google_places: "Google Maps" } as const satisfies Record<LookupProvider["provider"], string>;
const LOOKUP = {
  web: { title: "Look things up on the web", name: "web lookup", description: "Sends the words of a request to your search provider and shows the results here.", missing: "No search provider is set up in Services." },
  places: { title: "Find places", name: "place lookup", description: "Sends a named place to Google Maps and shows an address list here, never this device’s location.", missing: "No place provider is set up in Services." },
} as const satisfies Record<LookupService, { title: string; name: string; description: string; missing: string }>;
const TRUST = "Approved for shared text requests, one shared reply card and one spoken reply while its app is in front. It cannot use the microphone, read media context or private memories, or act on other devices. Approval is not proof of a connection or of delivery: a card or spoken reply counts only after the app acknowledges it, and Cosmos cannot tell who is in the room.";
const providerKey = (provider: LookupProvider) => `${provider.provider}:${provider.configurationDigest}`;
const describe = (outcome: Outcome) => outcome.result === "confirmed" ? "On." : outcome.result === "skipped" ? outcome.reason
  : outcome.failure === "unconfirmed" ? "Not confirmed. Check its switch below." : outcome.failure === "changed" ? "This device’s approval changed. Refresh devices." : "Could not be read. Check its switch below.";

type Step = { title: string; outcome: string };
type Props = {
  row: NativeSurface;
  /** The Azure Speech region from Services, when this session could read it. */
  servicesRegion: string | null;
  /** The region last used on this page, for the small field. */
  lastRegion: string;
  onRegionUsed(region: string): void;
  /** Offer the usual permissions once, right after approval. */
  offerSetup: boolean;
  busy: boolean;
  onRemove(row: NativeSurface): void;
  onRefreshDevices(): void;
};

/** One approved device: a plain status, what it may do, and switches on demand. */
export function DeviceCard({ row, servicesRegion, lastRegion, onRegionUsed, offerSetup, busy: parentBusy, onRemove, onRefreshDevices }: Props) {
  const tv = row.platform === "android_tv";
  const speech = usePermission(useMemo(() => speechPermission(row.surfaceId, row.revision), [row.surfaceId, row.revision]));
  const web = usePermission(useMemo(() => lookupPermission("web", row.surfaceId, row.revision), [row.surfaceId, row.revision]));
  const places = usePermission(useMemo(() => lookupPermission("places", row.surfaceId, row.revision), [row.surfaceId, row.revision]));
  // A TV is a shared screen; it never holds the private permission, so its state is not even read.
  const priv = usePermission(useMemo(() => privatePermission(row.surfaceId, row.revision), [row.surfaceId, row.revision]), !tv);
  const [open, setOpen] = useState(offerSetup);
  const [details, setDetails] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [region, setRegion] = useState(lastRegion);
  const [choice, setChoice] = useState<Record<LookupService, string>>({ web: "", places: "" });
  const [setup, setSetup] = useState<{ running: boolean; steps: Step[] } | null>(null);
  useEffect(() => { setRegion(current => current || lastRegion); }, [lastRegion]);
  const recordedRegion = speech.snapshot?.policy?.provider.region ?? null;
  useEffect(() => { if (recordedRegion) onRegionUsed(recordedRegion); }, [recordedRegion, onRegionUsed]);

  const speaks = speech.snapshot?.policy?.synthesis === true;
  const lookups = { web, places } as const;
  const providers = { web: activeLookupProvider(web.snapshot), places: activeLookupProvider(places.snapshot) } as const;
  const privateOn = priv.snapshot !== undefined ? priv.snapshot?.policy != null : row.privateDisplay;
  const states = [speech, web, places, ...(tv ? [] : [priv])];
  const reading = states.some(state => state.snapshot === undefined && state.failure === null);
  const unreadable = states.some(state => state.failure !== null);
  const capabilities = ["Shows shared replies", ...(speaks ? ["Speaks replies"] : []), ...(providers.web ? ["Looks things up"] : []),
    ...(providers.places ? ["Finds places"] : []), ...(privateOn && !tv ? ["Shows private replies"] : [])];
  const speechRegion = recordedRegion ?? servicesRegion ?? (SPEECH_REGION.test(region) ? region : null);

  async function toggleSpeech(next: boolean) {
    if (!next) { await speech.commit(() => ({ policy: null }), "Cosmos confirmed spoken replies off."); return; }
    if (!speechRegion) return;
    const outcome = await speech.commit(() => ({ policy: speechPolicy(speechRegion) }), "Cosmos confirmed spoken replies on this device.");
    if (outcome.result === "confirmed") onRegionUsed(speechRegion);
  }
  function chosenProvider(state: LookupState | undefined, service: LookupService): LookupProvider | null {
    if (!state) return null;
    return state.providers.length === 1 ? state.providers[0] : state.providers.find(provider => providerKey(provider) === choice[service]) ?? null;
  }
  async function toggleLookup(service: LookupService, next: boolean) {
    const state = lookups[service];
    if (!next) { await state.commit(() => ({ policy: null }), `Cosmos confirmed ${LOOKUP[service].name} off.`); return; }
    const provider = chosenProvider(state.snapshot, service);
    if (!provider) return;
    await state.commit(() => ({ policy: lookupPolicy(provider) }), `Cosmos confirmed ${LOOKUP[service].name} for this device.`);
  }
  async function togglePrivate(next: boolean) {
    await priv.commit(() => ({ policy: next ? PRIVATE_POLICY : null }),
      next ? "Cosmos confirmed private replies may appear here after you continue on this device." : "Cosmos confirmed private replies off for this device.");
  }
  /** Spoken replies, web lookup and place lookup in sequence, each read fresh and confirmed by Cosmos on its own. */
  async function setupUsual() {
    const steps: Step[] = [];
    const report = (title: string, outcome: string) => { steps.push({ title, outcome }); setSetup({ running: true, steps: [...steps] }); };
    setSetup({ running: true, steps: [] });
    if (!row.speech) report("Speak replies", "Approve this device again first; its approval predates spoken replies.");
    else if (!speechRegion) report("Speak replies", "Needs the Azure Speech region. Enter it below, then turn it on.");
    else {
      const outcome = await speech.commit(saved => saved?.policy?.synthesis ? { skip: "Already on." } : { policy: speechPolicy(speechRegion) },
        "Cosmos confirmed spoken replies on this device.", true);
      if (outcome.result === "confirmed") onRegionUsed(speechRegion);
      report("Speak replies", describe(outcome));
    }
    for (const service of ["web", "places"] as const) {
      const outcome = await lookups[service].commit(saved => {
        if (activeLookupProvider(saved)) return { skip: "Already on." };
        if (saved.providers.length === 1) return { policy: lookupPolicy(saved.providers[0]) };
        return { skip: saved.providers.length ? "Choose a provider below, then turn it on." : LOOKUP[service].missing };
      }, `Cosmos confirmed ${LOOKUP[service].name} for this device.`, true);
      report(LOOKUP[service].title, describe(outcome));
    }
    setSetup({ running: false, steps });
  }

  return <section className={`${settings.section} ${styles.card}`} aria-label={`${DEVICE_LABELS[row.platform]} ${row.enrollmentId.slice(0, 8)}`}>
    <div className={styles.cardHeader}>
      <h2 className={styles.cardTitle}>{DEVICE_LABELS[row.platform]}</h2>
      <StatusChip tone={row.connected ? "live" : "off"} label={deviceStatus(row)} />
    </div>
    <p className={styles.line}>{capabilities.join(" · ")}{reading ? " · Checking…" : unreadable ? " · Some settings could not be read" : ""}</p>
    <div className={styles.actions}>
      <button type="button" className={styles.quiet} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Manage"}</button>
    </div>
    {open ? <div className={styles.manage}>
      {offerSetup ? <div className={styles.setup} role="group" aria-label="Set up the usual permissions">
        {setup === null ? <>
          <p className={styles.line}>Turn on spoken replies, web lookup and place lookup in one go. Cosmos confirms each one separately.</p>
          <button type="button" className={styles.secondary} disabled={states.some(state => state.busy)} onClick={() => void setupUsual()}>Set up the usual permissions</button>
        </> : <ul className={styles.steps} aria-label="Set-up results">
          {setup.steps.map(step => <li key={step.title}><strong>{step.title}</strong> — {step.outcome}</li>)}
          {setup.running ? <li role="status">Working…</li> : null}
        </ul>}
      </div> : null}
      <PermissionSwitch title="Speak replies" checked={speaks} disabled={!row.speech || !speechRegion} busy={speech.busy}
        reading={speech.snapshot === undefined && speech.failure === null} failure={speech.failure} message={speech.message}
        onChange={next => void toggleSpeech(next)} onRetry={speech.failure === "changed" ? onRefreshDevices : () => void speech.load()}
        description={<>Cosmos reads shared replies aloud on this device with Azure Speech.
          {recordedRegion ? ` Region: ${recordedRegion}.` : servicesRegion ? ` Uses the ${servicesRegion} region from Services.` : ""}</>}>
        {!row.speech ? <span className={styles.switchState}>Approve this device again to allow spoken replies; its approval predates them.</span>
          : !recordedRegion && !servicesRegion ? <label className={styles.field}>Azure Speech region
            <input value={region} maxLength={32} autoComplete="off" spellCheck={false} placeholder="westeurope" disabled={speech.busy}
              onChange={event => setRegion(event.target.value.trim().toLowerCase())} />
          </label> : null}
      </PermissionSwitch>
      {(["web", "places"] as const).map(service => {
        const state = lookups[service];
        const active = providers[service];
        const recorded = state.snapshot?.approval?.policy?.provider;
        const configured = state.snapshot?.providers ?? [];
        const checked = active !== null;
        return <PermissionSwitch key={service} title={LOOKUP[service].title} checked={checked} busy={state.busy}
          disabled={!state.snapshot || !chosenProvider(state.snapshot, service)}
          reading={state.snapshot === undefined && state.failure === null} failure={state.failure} message={state.message}
          onChange={next => void toggleLookup(service, next)} onRetry={state.failure === "changed" ? onRefreshDevices : () => void state.load()}
          description={<>{LOOKUP[service].description}
            {active ? <> Uses {PROVIDERS[active.provider]} at <span className={styles.endpoint}>{active.endpoint}</span>.</> : null}</>}>
          {state.snapshot && recorded && !active ? <span className={styles.switchState} role="status">The provider set-up changed, so this permission currently authorizes nothing. Turn it on again to use the current provider.</span> : null}
          {state.snapshot && configured.length === 0 ? <span className={styles.switchState}>{LOOKUP[service].missing} Open <Link href="/settings/account/services">Services</Link>, then check again.</span> : null}
          {!checked && configured.length > 1 ? <label className={styles.field}>Provider
            <select value={choice[service]} disabled={state.busy} onChange={event => setChoice({ ...choice, [service]: event.target.value })}>
              <option value="">Choose a provider</option>
              {configured.map(provider => <option key={providerKey(provider)} value={providerKey(provider)}>{PROVIDERS[provider.provider]} · {provider.endpoint}</option>)}
            </select>
          </label> : null}
        </PermissionSwitch>;
      })}
      {!tv ? <PermissionSwitch title="Show private replies here" checked={priv.snapshot !== undefined && privateOn} busy={priv.busy}
        reading={priv.snapshot === undefined && priv.failure === null} failure={priv.failure} message={priv.message}
        onChange={next => void togglePrivate(next)} onRetry={priv.failure === "changed" ? onRefreshDevices : () => void priv.load()}
        description="After you unlock this device and choose Continue, private replies appear only here. Cosmos cannot tell who is looking at the screen." /> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.linkButton} aria-expanded={details} onClick={() => setDetails(!details)}>Details</button>
      </div>
      {details ? <div className={styles.details}>
        <dl>
          <dt>Platform</dt><dd>{NATIVE_PLATFORMS[row.platform]}</dd>
          <dt>Enrollment ID</dt><dd><code>{row.enrollmentId}</code></dd>
          <dt>Fingerprint</dt><dd><code className={styles.fingerprint}>{fingerprintLines(row.publicKeyFingerprint).map((line, index) => <span key={index}>{line}</span>)}</code></dd>
          <dt>Approval revision</dt><dd>{row.revision}</dd>
        </dl>
        <p className={styles.line}>{TRUST}</p>
        {removing ? <div className={styles.confirm} role="group" aria-label="Remove this device?">
          <p className={styles.line}>Remove this device? It stops showing replies until you approve it again.</p>
          <div className={styles.actions}>
            <button type="button" className={styles.danger} disabled={parentBusy} onClick={() => onRemove(row)}>Remove</button>
            <button type="button" className={styles.quiet} disabled={parentBusy} onClick={() => setRemoving(false)}>Keep</button>
          </div>
        </div> : <div className={styles.actions}>
          <button type="button" className={styles.danger} disabled={parentBusy} onClick={() => setRemoving(true)}>Remove this device</button>
        </div>}
      </div> : null}
    </div> : null}
  </section>;
}
