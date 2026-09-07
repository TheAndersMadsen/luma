"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { StatusChip, type StatusTone } from "@/components/Status";
import type { PinSurface } from "@/lib/contracts/pinSurfaces";
import type { LookupService } from "@/lib/contracts/lookupDisclosure";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import { PermissionSwitch } from "./PermissionSwitch";
import { LookupSwitch, SpeechSwitch, useSpeechRegion } from "./SurfaceSwitches";
import { activeLookupProvider, localVoicePermission, LOCAL_VOICE_POLICY, lookupPermission, speechPermission, usePermission } from "./permissions";

/** The owner's own word for the wearable, the same one the Pin's own screens use. */
const PIN_LABEL = "Ai Pin";
const VOICE = "Cosmos accepts spoken requests from this Pin and turns them into text on your own Cosmos server.";
const VOICE_PRIVACY = "The sound stays on your server, and what it hears counts as spoken in a shared room.";
const TRUST = "Approved for requests you start on the Pin and for replies spoken out loud in the room. It cannot show private replies or read private memories, and it acts on no other device. Approval is not proof of a connection or of delivery: a spoken reply counts only after the Pin acknowledges it, and Cosmos cannot tell who is in the room.";
/** Pairing is a certificate; approval is this owner gesture. Neither implies the other. */
const UNPAIRED = "This Pin is no longer paired with your account. Its permissions can only be turned off until you pair it again.";
const UNKNOWN_PAIRING = "Cosmos could not check this Pin’s pairing just now. Its permissions can only be turned off until it can.";

type Props = {
  /** The approved Pin, or null while a paired Pin is still waiting for approval. */
  pin: PinSurface | null;
  /** The Pin this card is about, from its approval or the pairing roster; null when no Pin is paired. */
  deviceId: string | null;
  /** True while Cosmos could not say what this account's Pins are. Never rendered as "not paired". */
  unreadable: boolean;
  /** The Azure Speech region from Services, when this session could read it. */
  servicesRegion: string | null;
  /** The region last used on this page, for the small field. */
  lastRegion: string;
  onRegionUsed(region: string): void;
  /** Open the permissions once, right after approval. */
  offerSetup: boolean;
  busy: boolean;
  onApprove(deviceId: string): void;
  onRemove(pin: PinSurface): void;
  onRefreshDevices(): void;
};

/** The wearer's Pin as one device card: paired, approved, and the permissions it holds. */
export function PinCard({ pin, deviceId, unreadable, servicesRegion, lastRegion, onRegionUsed, offerSetup, busy, onApprove, onRemove, onRefreshDevices }: Props) {
  // Permissions belong to an approval. Without one there is nothing to read,
  // so every read stays disabled rather than guessing a surface.
  const surfaceId = pin?.surfaceId ?? "";
  const revision = pin?.revision ?? 0;
  const approved = pin !== null;
  const speech = usePermission(useMemo(() => speechPermission(surfaceId, revision), [surfaceId, revision]), approved);
  const voice = usePermission(useMemo(() => localVoicePermission(surfaceId, revision), [surfaceId, revision]), approved);
  const web = usePermission(useMemo(() => lookupPermission("web", surfaceId, revision), [surfaceId, revision]), approved);
  const places = usePermission(useMemo(() => lookupPermission("places", surfaceId, revision), [surfaceId, revision]), approved);
  const [open, setOpen] = useState(offerSetup);
  const [details, setDetails] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [choice, setChoice] = useState<Record<LookupService, string>>({ web: "", places: "" });
  const region = useSpeechRegion(speech, servicesRegion, lastRegion, onRegionUsed);
  const { speaks } = region;

  const lookups = { web, places } as const;
  const providers = { web: activeLookupProvider(web.snapshot), places: activeLookupProvider(places.snapshot) } as const;
  const hears = voice.snapshot?.policy != null;
  const states = [speech, voice, web, places];
  const reading = approved && states.some(state => state.snapshot === undefined && state.failure === null);
  const unread = approved && states.some(state => state.failure !== null);
  const capabilities = [...(speaks ? ["Speaks replies"] : []), ...(hears ? ["Takes spoken requests"] : []),
    ...(providers.web ? ["Looks things up"] : []), ...(providers.places ? ["Finds places"] : [])];
  // Pairing carries the authority to add a permission; losing it leaves only removal.
  const paired = pin?.currentPaired === true;
  const status: { tone: StatusTone; label: string } = unreadable ? { tone: "degraded", label: "Status unread" }
    : !approved ? deviceId ? { tone: "off", label: "Waiting for approval" } : { tone: "off", label: "Not set up" }
      : pin.currentPaired === false ? { tone: "off", label: "Not paired" } : { tone: "live", label: "Approved" };

  async function toggleVoice(next: boolean) {
    await voice.commit(() => ({ policy: next ? LOCAL_VOICE_POLICY : null }),
      next ? "Cosmos confirmed this Pin may take spoken requests." : "Cosmos confirmed spoken requests off for this Pin.");
  }

  return <section className={`${settings.section} ${styles.card}`} aria-label={PIN_LABEL}>
    <div className={styles.cardHeader}>
      <h2 className={styles.cardTitle}>{PIN_LABEL}</h2>
      <StatusChip tone={status.tone} label={status.label} />
    </div>
    {unreadable ? <>
      <p className={styles.line} role="status">Cosmos could not say what your Pin is allowed to do just now. Your pairing is unchanged.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={onRefreshDevices}>Check again</button>
      </div>
    </> : !approved ? <>
      <p className={styles.line}>{deviceId ? "This Pin is paired and waiting for your approval." : "No Pin is paired with this account yet."}</p>
      <div className={styles.actions}>
        {deviceId ? <button type="button" className={styles.primary} disabled={busy} onClick={() => onApprove(deviceId)}>Approve this Pin</button>
          : <Link className={settings.additionLink} href="/settings/pin/setup">Set up your Pin</Link>}
      </div>
    </> : <>
      <p className={styles.capabilities}>
        <span>{capabilities.length ? capabilities.join(" · ") : "Nothing turned on yet"}</span>
        {reading ? <span className={styles.quietNote} role="status">Checking…</span>
          : unread ? <span className={styles.quietNote}>Some settings could not be read</span> : null}
      </p>
      {paired ? null : <p className={styles.line}>{pin.currentPaired === false ? UNPAIRED : UNKNOWN_PAIRING}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Manage"}</button>
      </div>
      {open ? <div className={styles.manage}>
        <SpeechSwitch state={speech} speech={region} servicesRegion={servicesRegion} allowed={paired}
          blocked={pin.currentPaired === false ? UNPAIRED : UNKNOWN_PAIRING}
          onRegionUsed={onRegionUsed} onRefreshDevices={onRefreshDevices} />
        <PermissionSwitch title="Take spoken requests" checked={hears} disabled={!paired} busy={voice.busy}
          reading={voice.snapshot === undefined && voice.failure === null} failure={voice.failure} message={voice.message}
          onChange={next => void toggleVoice(next)} onRetry={voice.failure === "changed" ? onRefreshDevices : () => void voice.load()}
          description={VOICE} privacy={VOICE_PRIVACY} />
        {(["web", "places"] as const).map(service => <LookupSwitch key={service} service={service} state={lookups[service]}
          choice={choice[service]} onChoice={value => setChoice({ ...choice, [service]: value })}
          allowed={paired} blocked={pin.currentPaired === false ? UNPAIRED : UNKNOWN_PAIRING} onRefreshDevices={onRefreshDevices} />)}
        <div className={styles.actions}>
          <button type="button" className={styles.linkButton} aria-expanded={details} onClick={() => setDetails(!details)}>Details</button>
        </div>
        {details ? <div className={styles.details}>
          <dl>
            <dt>Device ID</dt><dd><code>{deviceId}</code></dd>
            <dt>Approval revision</dt><dd>{pin.revision}</dd>
          </dl>
          <p className={styles.line}>{TRUST}</p>
          {removing ? <div className={styles.confirm} role="group" aria-label="Remove this approval?">
            <p className={styles.line}>Remove this approval? Your Pin stays paired, and Cosmos stops answering on it until you approve it again.</p>
            <div className={styles.actions}>
              <button type="button" className={styles.danger} disabled={busy} onClick={() => onRemove(pin)}>Remove</button>
              <button type="button" className={styles.quiet} disabled={busy} onClick={() => setRemoving(false)}>Keep</button>
            </div>
          </div> : <div className={styles.actions}>
            <button type="button" className={styles.danger} disabled={busy} onClick={() => setRemoving(true)}>Remove this approval</button>
          </div>}
        </div> : null}
      </div> : null}
    </>}
  </section>;
}
