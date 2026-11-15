"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { GestureConfig, GestureObservation, GestureSettings } from "@/lib/contracts/gestures";
import { PinApiError, type PinClient } from "@/lib/pin-device/client";
import { StatusMessage } from "@/components/Status";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { DeviceRequired, PaneSection } from "../_lib/PaneShell";
import { usePinPaneSession } from "../_lib/pinSession";
import styles from "../_lib/panes.module.css";
import local from "./gestures.module.css";

const CHORDS = ["middle", "ring", "pinky", "middle,ring", "middle,pinky", "ring,pinky", "middle,ring,pinky"] as const;
const title = (value: string) => value.split(",").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" + ");

export default function PinGesturesPane() {
  const session = usePinPaneSession();
  // A new client must unmount the whole draft/inspector immediately, including
  // during the render before effects run. No data can cross between two Pins.
  const identity = useRef({ client: session.client, id: 0 });
  if (identity.current.client !== session.client) identity.current = { client: session.client, id: identity.current.id + 1 };
  if (!session.client) return <DeviceRequired what="gestures" connectionError={session.connectionError} attachedWithoutServer={session.attachedWithoutServer} />;
  return <ConnectedGestures key={identity.current.id} client={session.client} ready={session.ready} />;
}

function ConnectedGestures({ client, ready }: { client: PinClient; ready: boolean }) {
  const [settings, setSettings] = useState<GestureSettings | null>(null);
  const [draft, setDraft] = useState<GestureConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [inspecting, setInspecting] = useState(false);
  const [observation, setObservation] = useState<GestureObservation | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const samples = useRef<GestureObservation[]>([]);
  const saveController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; saveController.current?.abort(); }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    client.getGestures(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setSettings(value); setDraft(value.config); }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof PinApiError && cause.status === 404
        ? "This Pin needs the Luma gesture update before it can show these controls."
        : "Couldn’t load gestures from your Pin.");
    });
    return () => controller.abort();
  }, [client, reload]);

  useEffect(() => {
    if (!inspecting || !ready) { setObservation(null); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let lastReceived = 0;
    const freshness = setInterval(() => { if (Date.now() - lastReceived > 1000) setObservation(null); }, 250);
    const poll = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          const result = await client.getGestureObservation(AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]));
          if (controller.signal.aborted) return;
          lastReceived = Date.now();
          setObservation(result.observation); setInspectionError(null);
          if (result.observation && samples.current.at(-1)?.elapsed_ms !== result.observation.elapsed_ms) {
            samples.current = [...samples.current.slice(-599), result.observation];
            setSampleCount(samples.current.length);
          }
        } catch {
          if (controller.signal.aborted) return;
          setObservation(null); setInspectionError("The live connection stopped. Waiting for your Pin.");
        }
      } else setObservation(null);
      if (!controller.signal.aborted) timer = setTimeout(poll, 500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); clearInterval(freshness); };
  }, [client, inspecting, ready]);

  const dirty = !!settings && !!draft && JSON.stringify(settings.config) !== JSON.stringify(draft);
  function edit(next: GestureConfig) { setDraft(next); setSaved(false); setError(null); }
  async function save() {
    if (!settings || !draft || !ready || busy) return;
    setBusy(true); setSaved(false); setError(null);
    const controller = new AbortController(); saveController.current = controller;
    try {
      const value = await client.updateGestures(settings.revision, draft, controller.signal);
      if (!alive.current) return;
      setSettings(value); setDraft(value.config); setSaved(true);
      samples.current = []; setSampleCount(0); setObservation(null);
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof PinApiError && cause.status === 409
        ? "These gestures changed elsewhere. Reload the Pin’s settings before saving again."
        : cause instanceof PinApiError && cause.status === 400
          ? "The Pin rejected these shortcuts. Choose distinct finger combinations and a hold between 250 and 1500 ms."
          : "Couldn’t save gestures. Your draft is still here.");
    } finally { if (alive.current) setBusy(false); }
  }
  function exportRecording() {
    const blob = new Blob([JSON.stringify({ schema_version: 1, kind: "luma_gesture_observations", exported_at: new Date().toISOString(),
      config: settings?.config, revision: settings?.revision, physical_acceptance: "not_recorded", observations: samples.current }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = "luma-gesture-observations.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!settings || !draft) return <PaneSection title="Gestures">
    <p className={styles.formHelp}>{error ?? "Reading gestures from your Pin…"}</p>
    {error && <button type="button" className={styles.linkButton} onClick={() => setReload((value) => value + 1)}>Try again</button>}
  </PaneSection>;
  const available = settings.catalog.filter((feature) => feature.available && feature.trigger === "fingers");
  const nextChord = CHORDS.find((chord) => {
    const fingers = chord.split(",");
    return draft.bindings.every((binding) => !binding.fingers.every((finger) => fingers.includes(finger)) && !fingers.every((finger) => binding.fingers.includes(finger as typeof binding.fingers[number])));
  });
  return <>
    <PaneSection title="Finger shortcuts">
      <p className={styles.formHelp}>Curl the chosen fingers, hold, then open your hand to confirm. Shortcuts work on the unlocked Home screen. Thumb and index keep their usual controls.</p>
      {!settings.valid && <StatusMessage tone="warning">The saved configuration is invalid. Save with gestures off to reset it.</StatusMessage>}
      <fieldset className={local.controls} disabled={!ready || busy}>
        <label>Mode<select aria-label="Mode" value={draft.mode} onChange={(event) => edit({ ...draft, mode: event.target.value as GestureConfig["mode"] })}>
          <option value="off">Off</option><option value="observe">Test without opening apps</option><option value="active">Use shortcuts</option>
        </select></label>
        {draft.bindings.map((binding, index) => <div className={local.binding} key={index}>
          <label>Fingers<select aria-label={`Fingers ${index + 1}`} value={binding.fingers.join(",")} onChange={(event) => edit({ ...draft, bindings: draft.bindings.map((old, i) => i === index ? { ...old, fingers: event.target.value.split(",") as typeof binding.fingers } : old) })}>
            {CHORDS.map((chord) => <option key={chord} value={chord}>{title(chord)}</option>)}
          </select></label>
          <label>Feature<select aria-label={`Feature ${index + 1}`} value={binding.feature} onChange={(event) => edit({ ...draft, bindings: draft.bindings.map((old, i) => i === index ? { ...old, feature: event.target.value } : old) })}>
            {available.map((feature) => <option key={feature.id} value={feature.id}>{feature.title}</option>)}
          </select></label>
          <label>Hold (ms)<input aria-label={`Hold ${index + 1}`} type="number" min={250} max={1500} step={50} value={binding.hold_ms} onChange={(event) => edit({ ...draft, bindings: draft.bindings.map((old, i) => i === index ? { ...old, hold_ms: Number(event.target.value) } : old) })} /></label>
          <button type="button" className={styles.linkButton} aria-label={`Remove shortcut ${index + 1}`} onClick={() => edit({ ...draft, bindings: draft.bindings.filter((_, i) => i !== index) })}>Remove</button>
        </div>)}
        <div className={local.actions}>
          <button type="button" className={styles.linkButton} disabled={!nextChord || !available.length} onClick={() => nextChord && edit({ ...draft, bindings: [...draft.bindings, { fingers: nextChord.split(",") as GestureConfig["bindings"][number]["fingers"], hold_ms: 400, feature: available[0]!.id }] })}>Add shortcut</button>
          <button type="button" className={styles.primaryButton} disabled={!dirty && settings.valid} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
          <button type="button" className={styles.linkButton} onClick={() => { setDraft(settings.config); setSaved(false); setReload((value) => value + 1); }}>Reload settings</button>
        </div>
      </fieldset>
      {saved && <StatusMessage tone="info">Changes saved on your Pin.</StatusMessage>}
      {error && <StatusMessage tone="danger">{error}</StatusMessage>}
    </PaneSection>
    <PaneSection title="Try your gestures" action={<button type="button" className={styles.linkButton} disabled={!ready} onClick={() => { setInspecting(!inspecting); setObservation(null); }}>{inspecting ? "Stop inspector" : "Start inspector"}</button>}>
      <p className={styles.formHelp}>Save “Test without opening apps,” unlock your Pin, then raise an open hand on Home. Hold still to calibrate. The inspector shows the saved settings, including any active actions.</p>
      {dirty && <StatusMessage tone="warning">Your changes haven’t been saved. The inspector uses the Pin’s current configuration.</StatusMessage>}
      {inspecting && <div className={local.inspector}>
        <HandSkeleton observation={observation} />
        <div aria-live="polite">
          <p className={local.state}>{observation ? title(observation.status) : "No fresh launcher observation."}</p>
          {observation && <>
            <p>{observation.projectable ? "Projection surface available" : "No usable projection surface"}</p>
            <p>{observation.fingers.length ? `${title(observation.fingers.join(","))} curled` : "No fingers curled"}</p>
            {observation.feature && <p>{settings.catalog.find((feature) => feature.id === observation.feature)?.title} · {Math.round(observation.hold_progress * 100)}%</p>}
            {observation.reason && <p>{reasonText(observation.reason)}</p>}
            {observation.match && <p>Last match: {settings.catalog.find((feature) => feature.id === observation.match?.feature)?.title} ({observation.match.outcome})</p>}
          </>}
          {inspectionError && <StatusMessage tone="warning">{inspectionError}</StatusMessage>}
        </div>
      </div>}
      <p className={styles.formHelp}>Recordings stay in this tab until you download them. They contain hand coordinates and recognition states, with no camera images or article text.</p>
      <button type="button" className={styles.linkButton} disabled={!sampleCount} onClick={exportRecording}>Download recording ({sampleCount} samples)</button>
    </PaneSection>
    <PaneSection title="Feature catalog">
      {settings.catalog.map((feature) => <article key={feature.id} className={styles.card}>
        <div className={styles.cardHeading}><h3 className={styles.cardTitle}>{feature.title}</h3><span className={styles.chip}>{feature.available ? "Available" : "Not available"}</span></div>
        <p className={styles.formHelp}>{feature.note}</p>
        {feature.available && feature.trigger === "pinch_session" && <Link className={styles.linkButton} href="/settings/pin/clip">Open Clip</Link>}
      </article>)}
    </PaneSection>
    <UnsavedChangesGuard when={dirty} />
  </>;
}

function reasonText(reason: NonNullable<GestureObservation["reason"]>): string {
  return ({ projection_unavailable: "Hand landmarks are available, but this pose has no usable projection surface.", home_required: "Return to the unlocked Home screen.", hand_lost: "Hand tracking stopped; the gesture was cancelled.", stale_frame: "Hand data stopped arriving; the gesture was cancelled.", queue_overflow: "Hand data arrived too quickly; start again.", service_lost: "Hand tracking is reconnecting.", callback_failed: "The launcher adapter could not read this frame.", subscription_failed: "Hand tracking could not be connected.", subscription_unavailable: "This launcher could not provide hand tracking.", invalid_config: "Save a valid configuration before testing." })[reason];
}

function HandSkeleton({ observation }: { observation: GestureObservation | null }) {
  const points = observation?.points ?? [];
  const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
  const minX = Math.min(...xs), maxY = Math.max(...ys);
  const scale = points.length ? 180 / Math.max(Math.max(...xs) - minX, maxY - Math.min(...ys), 1) : 1;
  const xy = (index: number) => `${30 + (points[index]![0] - minX) * scale},${30 + (maxY - points[index]![1]) * scale}`;
  return <svg className={local.hand} viewBox="0 0 240 240" role="img" aria-label={points.length ? "Live hand landmarks, viewed from the tracking sensor" : "Waiting for hand landmarks"}>
    {points.length === 25 ? ["thumb", "index", "middle", "ring", "pinky"].map((finger, index) => <g key={finger} className={observation?.fingers.includes(finger as GestureObservation["fingers"][number]) ? local.curled : undefined}>
      <polyline points={[0, ...Array.from({ length: 4 }, (_, i) => index * 4 + i + 1)].map(xy).join(" ")} fill="none" stroke="currentColor" strokeWidth="3" />
      {Array.from({ length: 4 }, (_, i) => index * 4 + i + 1).map((point) => { const [cx, cy] = xy(point).split(","); return <circle key={point} cx={cx} cy={cy} r="4" fill="currentColor" />; })}
    </g>) : <text x="120" y="125" textAnchor="middle" fill="currentColor" fontSize="14">Raise your hand</text>}
  </svg>;
}
