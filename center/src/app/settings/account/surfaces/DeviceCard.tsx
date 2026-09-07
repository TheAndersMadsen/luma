"use client";

import { useMemo, useState } from "react";
import { StatusChip } from "@/components/Status";
import { NATIVE_PLATFORMS, type NativePlatform, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import type { LookupService } from "@/lib/contracts/lookupDisclosure";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import { fingerprintLines } from "./fingerprint";
import { PermissionSwitch } from "./PermissionSwitch";
import { LOOKUP, LookupSwitch, SpeechSwitch, useSpeechRegion } from "./SurfaceSwitches";
import { actionCeiling, BLAST_RADIUS, DeviceActsEditor, DeviceTasksEditor } from "./DeviceActionEditors";
import { activeLookupProvider, deviceActionsPermission, deviceCommandsPermission, lookupPermission, lookupPolicy, PRIVATE_POLICY, privatePermission, SCREEN_CONTEXT_POLICY, screenContextPermission, speechPermission, speechPolicy, usePermission, type Outcome } from "./permissions";

/** The owner's own words for a kind of device — the same names the Mac, Linux, phone and TV clients use. */
export const DEVICE_LABELS = { android: "Phone", android_tv: "TV", macos: "Mac", linux: "Linux PC" } as const satisfies Record<NativePlatform, string>;
/** A device is connected only while the runtime holds a signed connection for it; approval alone is not a connection. */
export const deviceStatus = (row: NativeSurface) => row.connected ? row.visible ? "Connected" : "Connected · in the background" : "Offline";
const SCREEN_CONTEXT = "When you ask about what is on this device’s screen, Cosmos reads the visible text once and sends it to the assistant model.";
const SCREEN_CONTEXT_PRIVACY = "The reply stays private to this device. It is never spoken and never shown on a shared screen.";
const TRUST = "Approved for shared text requests, one shared reply card and one spoken reply while its app is in front. It cannot use the microphone, read media context or private memories, or act on other devices. Approval is not proof of a connection or of delivery: a card or spoken reply counts only after the app acknowledges it, and Cosmos cannot tell who is in the room.";
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
  const phone = row.platform === "android";
  const speech = usePermission(useMemo(() => speechPermission(row.surfaceId, row.revision), [row.surfaceId, row.revision]));
  const web = usePermission(useMemo(() => lookupPermission("web", row.surfaceId, row.revision), [row.surfaceId, row.revision]));
  const places = usePermission(useMemo(() => lookupPermission("places", row.surfaceId, row.revision), [row.surfaceId, row.revision]));
  // A TV is a shared screen; it never holds the private permission, so its state is not even read.
  const priv = usePermission(useMemo(() => privatePermission(row.surfaceId, row.revision), [row.surfaceId, row.revision]), !tv);
  // Screen text stays on the personal device; a TV is a shared screen and never reads it.
  const screenContext = usePermission(useMemo(() => screenContextPermission(row.surfaceId, row.revision), [row.surfaceId, row.revision]), !tv);
  // An installation whose approved manifest declares no action channel cannot
  // hold either permission, so neither is read for it.
  const canAct = row.actions.length > 0;
  const runsTasks = row.actions.includes("action.run");
  const acts = usePermission(useMemo(() => deviceActionsPermission(row.surfaceId, row.revision), [row.surfaceId, row.revision]),
    canAct && row.actions.some(channel => channel !== "action.run"));
  const tasks = usePermission(useMemo(() => deviceCommandsPermission(row.surfaceId, row.revision), [row.surfaceId, row.revision]), runsTasks);
  const [open, setOpen] = useState(offerSetup);
  const [details, setDetails] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [choice, setChoice] = useState<Record<LookupService, string>>({ web: "", places: "" });
  const [setup, setSetup] = useState<{ running: boolean; steps: Step[] } | null>(null);
  const region = useSpeechRegion(speech, servicesRegion, lastRegion, onRegionUsed);
  const { speaks, speechRegion } = region;
  const lookups = { web, places } as const;
  const providers = { web: activeLookupProvider(web.snapshot), places: activeLookupProvider(places.snapshot) } as const;
  const privateOn = priv.snapshot !== undefined ? priv.snapshot?.policy != null : row.privateDisplay;
  const screenOn = screenContext.snapshot?.policy != null;
  // An action permission can never raise a posture, only spend one: its class
  // is capped by this installation's own private-display ceiling.
  const ceiling = actionCeiling(priv.snapshot?.policy?.maximumClass ?? null);
  const actsOn = acts.snapshot?.policy != null;
  const tasksOn = tasks.snapshot?.policy != null;
  const states = [speech, web, places, ...(tv ? [] : [priv, screenContext])];
  const reading = states.some(state => state.snapshot === undefined && state.failure === null);
  const unreadable = states.some(state => state.failure !== null);
  const capabilities = ["Shows shared replies", ...(speaks ? ["Speaks replies"] : []), ...(providers.web ? ["Looks things up"] : []),
    ...(providers.places ? ["Finds places"] : []), ...(privateOn && !tv ? ["Shows private replies"] : []), ...(screenOn && !tv ? ["Uses what's on the screen"] : []),
    ...(actsOn ? ["Acts on your behalf"] : []), ...(tasksOn ? ["Runs your tasks"] : [])];

  async function togglePrivate(next: boolean) {
    await priv.commit(() => ({ policy: next ? PRIVATE_POLICY : null }),
      next ? "Cosmos confirmed private replies may appear here after you continue on this device." : "Cosmos confirmed private replies off for this device.");
  }
  async function toggleScreenContext(next: boolean) {
    await screenContext.commit(() => ({ policy: next ? SCREEN_CONTEXT_POLICY : null }),
      next ? "Cosmos confirmed this device may use what's on its screen when you ask." : "Cosmos confirmed screen context off for this device.");
  }
  /** Spoken replies, web lookup, place lookup and, on a phone, screen context in sequence, each read fresh and confirmed by Cosmos on its own. */
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
    if (phone) {
      const outcome = await screenContext.commit(saved => saved?.policy ? { skip: "Already on." } : { policy: SCREEN_CONTEXT_POLICY },
        "Cosmos confirmed this device may use what's on its screen when you ask.", true);
      report("Use what's on the screen", describe(outcome));
    }
    setSetup({ running: false, steps });
  }

  return <section className={`${settings.section} ${styles.card}`} aria-label={DEVICE_LABELS[row.platform]}>
    <div className={styles.cardHeader}>
      <h2 className={styles.cardTitle}>{DEVICE_LABELS[row.platform]}</h2>
      <StatusChip tone={row.connected ? "live" : "off"} label={deviceStatus(row)} />
    </div>
    <p className={styles.capabilities}>
      <span>{capabilities.join(" · ")}</span>
      {reading ? <span className={styles.quietNote} role="status">Checking…</span>
        : unreadable ? <span className={styles.quietNote}>Some settings could not be read</span> : null}
    </p>
    <div className={styles.actions}>
      <button type="button" className={styles.quiet} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Manage"}</button>
    </div>
    {open ? <div className={styles.manage}>
      {offerSetup ? <div className={styles.setup} role="group" aria-label="Set up the usual permissions">
        {setup === null ? <>
          <p className={styles.line}>Turn on spoken replies, web lookup{phone ? ", place lookup and what's on the screen" : " and place lookup"} in one go. Cosmos confirms each one separately.</p>
          <button type="button" className={styles.secondary} disabled={states.some(state => state.busy)} onClick={() => void setupUsual()}>Set up the usual permissions</button>
        </> : <ul className={styles.steps} aria-label="Set-up results">
          {setup.steps.map(step => <li key={step.title}><strong>{step.title}</strong> — {step.outcome}</li>)}
          {setup.running ? <li role="status">Working…</li> : null}
        </ul>}
      </div> : null}
      <SpeechSwitch state={speech} speech={region} servicesRegion={servicesRegion} allowed={row.speech}
        blocked="Approve this device again to allow spoken replies; its approval predates them."
        onRegionUsed={onRegionUsed} onRefreshDevices={onRefreshDevices} />
      {(["web", "places"] as const).map(service => <LookupSwitch key={service} service={service} state={lookups[service]}
        choice={choice[service]} onChoice={value => setChoice({ ...choice, [service]: value })} onRefreshDevices={onRefreshDevices} />)}
      {!tv ? <PermissionSwitch title="Show private replies here" checked={priv.snapshot !== undefined && privateOn} busy={priv.busy}
        reading={priv.snapshot === undefined && priv.failure === null} failure={priv.failure} message={priv.message}
        onChange={next => void togglePrivate(next)} onRetry={priv.failure === "changed" ? onRefreshDevices : () => void priv.load()}
        description="After you unlock this device and choose Continue, private replies appear only here."
        privacy="Cosmos cannot tell who is looking at the screen." /> : null}
      {!tv ? <PermissionSwitch title="Use what's on the screen" checked={screenContext.snapshot !== undefined && screenOn} busy={screenContext.busy}
        reading={screenContext.snapshot === undefined && screenContext.failure === null} failure={screenContext.failure} message={screenContext.message}
        onChange={next => void toggleScreenContext(next)} onRetry={screenContext.failure === "changed" ? onRefreshDevices : () => void screenContext.load()}
        description={SCREEN_CONTEXT} privacy={SCREEN_CONTEXT_PRIVACY} /> : null}
      {/* Said once, above both, because an owner most easily assumes the opposite. */}
      {canAct ? <p className={styles.line}>{BLAST_RADIUS}</p> : null}
      {row.actions.some(channel => channel !== "action.run")
        ? <DeviceActsEditor row={row} state={acts} ceiling={ceiling} personal={!tv} onRefreshDevices={onRefreshDevices} /> : null}
      {runsTasks ? <DeviceTasksEditor row={row} state={tasks} ceiling={ceiling} personal={!tv} onRefreshDevices={onRefreshDevices} /> : null}
      {!canAct ? <p className={styles.line}>
        This device was approved before Cosmos could act on a device. Approve it again to choose what it may open, play or run.
      </p> : null}
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
