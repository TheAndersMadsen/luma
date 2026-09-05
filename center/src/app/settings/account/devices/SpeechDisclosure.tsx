"use client";

import { useEffect, useRef, useState } from "react";
import type { PinSurface } from "@/lib/contracts/pinSurfaces";
import { exact } from "@/lib/contracts/surfaces";
import { SPEECH_DISCLOSURE_APPROVAL, SPEECH_REGION, parseSpeechApproval, type SpeechApproval, type SpeechPolicy } from "@/lib/contracts/speechDisclosure";
import settings from "../../settings.module.css";
import styles from "./devices.module.css";

export function SpeechDisclosure({ pin }: { pin: PinSurface }) {
  const [open, setOpen] = useState(false);
  const [approval, setApproval] = useState<SpeechApproval | null | undefined>();
  const [region, setRegion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const path = `/api/devices/runtime/${pin.surfaceId}/speech-disclosure`;
  useEffect(() => () => { generation.current++; active.current?.abort(); }, []);

  function reset() {
    generation.current++; active.current?.abort(); active.current = null;
    setApproval(undefined); setRegion(""); setMessage(""); setError(""); setBusy(false);
  }
  async function load() {
    reset(); setBusy(true);
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    try {
      const response = await fetch(path, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error("unavailable");
      const saved = parseSpeechApproval(await response.json());
      if (saved && saved.approvalRevision !== pin.revision) throw new Error("approval_changed");
      if (current !== generation.current) return;
      setApproval(saved); setRegion(saved?.policy?.provider.region ?? "");
    } catch {
      if (current === generation.current) setError("Speech permission is unavailable. Refresh before making changes.");
    } finally { if (current === generation.current) { active.current = null; setBusy(false); } }
  }
  async function save(policy: SpeechPolicy | null) {
    if (active.current || approval === undefined || policy && pin.currentPaired !== true) return;
    const expectedRevision = approval?.revision ?? 0;
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        body: JSON.stringify({ approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: pin.revision, expectedRevision, policy }) });
      if (!response.ok) throw new Error("unconfirmed");
      const saved = parseSpeechApproval(await response.json());
      if (!saved || saved.approvalRevision !== pin.revision || saved.revision !== expectedRevision + 1 || !exact(saved.policy, policy)) throw new Error("approval_mismatch");
      if (current !== generation.current) return;
      setApproval(saved);
      setMessage(policy ? "Cosmos confirmed permission to send shared reply text to Azure Speech." : "Cosmos confirmed speech provider permission revoked.");
    } catch {
      if (current !== generation.current) return;
      // A timed-out write may have committed. A fresh read is required to retry.
      setApproval(undefined);
      setError("Cosmos did not confirm the change. Refresh permission status before retrying.");
    } finally { if (current === generation.current) { active.current = null; setBusy(false); } }
  }
  return <div className={settings.stateRow} aria-label={`Speech provider permission for Pin ${pin.deviceId}`}>
    <button type="button" className={styles.pairCancel} aria-expanded={open} onClick={() => {
      if (open) reset(); else void load();
      setOpen(!open);
    }}>{open ? "Close speech permission" : "Speech provider permission"}</button>
    {open ? <div className={styles.speechPermission}>
      <p>Allow Cosmos to send this Pin’s shared reply text to Azure Speech for spoken audio. Pairing and saved provider credentials do not grant this permission.</p>
      <p>Native microphone capture is not connected yet. This control approves reply text only; it does not enable voice capture or confirm playback.</p>
      {approval !== undefined ? <p>{approval?.policy
        ? `Recorded permission: Azure Speech, ${approval.policy.provider.region}. Reply text: ${approval.policy.synthesis ? "allowed" : "off"}. Microphone transcription: ${approval.policy.transcription ? "allowed" : "off"}.`
        : "No active speech provider permission."}</p> : busy ? <p role="status">Checking speech permission…</p> : null}
      <label>Azure Speech region
        <input value={region} maxLength={32} autoComplete="off" spellCheck={false} disabled={busy || approval === undefined || pin.currentPaired !== true}
          onChange={event => setRegion(event.target.value.trim().toLowerCase())} placeholder="Region from Services" />
      </label>
      <p>The region must match your Speech service in Center. Allowing reply text replaces the current speech permission and leaves microphone transcription off.</p>
      {pin.currentPaired !== true ? <p>Current pairing is unavailable. Existing speech permission can still be revoked.</p> : null}
      <div className={styles.unpairActions}>
        <button type="button" className={styles.pairOpenButton} disabled={busy || approval === undefined || pin.currentPaired !== true || !SPEECH_REGION.test(region)}
          onClick={() => void save({ provider: { provider: "azure_speech", region }, maximumClass: "shared_room", transcription: false, synthesis: true })}>Allow shared reply text</button>
        <button type="button" className={styles.pairCancel} disabled={busy || !approval?.policy} onClick={() => void save(null)}>Revoke speech permission</button>
      </div>
      <button type="button" className={styles.pairCancel} disabled={busy} onClick={() => void load()}>Refresh speech permission</button>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
  </div>;
}
