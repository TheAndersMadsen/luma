"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PinSurface } from "@/lib/contracts/pinSurfaces";
import { exact } from "@/lib/contracts/surfaces";
import { LOCAL_VOICE_APPROVAL, parseLocalVoiceApproval, type LocalVoiceApproval, type LocalVoicePolicy } from "@/lib/contracts/localVoice";
import settings from "../../settings.module.css";
import styles from "./devices.module.css";

const FLOOR_NAMES: Record<LocalVoicePolicy["sourceFloor"], string> = {
  shared_room: "Shared room", near_user: "Near user", private: "Private", sensitive: "Sensitive",
};

export function LocalVoicePermission({ pin }: { pin: PinSurface }) {
  const [open, setOpen] = useState(false);
  const [approval, setApproval] = useState<LocalVoiceApproval | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const path = `/api/devices/runtime/${pin.surfaceId}/local-voice`;
  const reset = useCallback(() => {
    generation.current++; active.current?.abort(); active.current = null;
    setApproval(undefined); setMessage(""); setError(""); setBusy(false);
  }, []);
  useEffect(() => {
    reset(); setOpen(false);
    const suspend = () => { reset(); setOpen(false); };
    // Returning owner views require a new read; a late reply cannot restore
    // authority after session changes, hidden tabs, or Pin revision changes.
    window.addEventListener("focus", suspend);
    window.addEventListener("pagehide", suspend);
    document.addEventListener("visibilitychange", suspend);
    return () => {
      generation.current++; active.current?.abort(); active.current = null;
      window.removeEventListener("focus", suspend);
      window.removeEventListener("pagehide", suspend);
      document.removeEventListener("visibilitychange", suspend);
    };
  }, [pin.surfaceId, pin.revision, pin.currentPaired, reset]);

  async function load() {
    reset(); setBusy(true);
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    try {
      const response = await fetch(path, { cache: "no-store", signal });
      if (!response.ok) throw new Error("unavailable");
      const saved = parseLocalVoiceApproval(await response.json());
      signal.throwIfAborted();
      if (saved && saved.approvalRevision !== pin.revision) throw new Error("approval_changed");
      if (current !== generation.current) return;
      setApproval(saved);
    } catch {
      if (current === generation.current) setError("Local voice permission is unavailable. Refresh before making changes.");
    } finally { if (current === generation.current) { active.current = null; setBusy(false); } }
  }
  async function save(policy: LocalVoicePolicy | null) {
    if (active.current || approval === undefined || policy && pin.currentPaired !== true) return;
    const expectedRevision = approval?.revision ?? 0;
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal,
        body: JSON.stringify({ approval: LOCAL_VOICE_APPROVAL, approvalRevision: pin.revision, expectedRevision, policy }) });
      if (!response.ok) throw new Error("unconfirmed");
      const saved = parseLocalVoiceApproval(await response.json());
      signal.throwIfAborted();
      if (!saved || saved.approvalRevision !== pin.revision || saved.revision !== expectedRevision + 1 || !exact(saved.policy, policy)) throw new Error("approval_mismatch");
      if (current !== generation.current) return;
      setApproval(saved);
      setMessage(policy ? "Cosmos confirmed local voice permission for shared requests. Microphone integration remains in preview." : "Cosmos confirmed local voice permission revoked.");
    } catch {
      if (current !== generation.current) return;
      // The write may have committed. Only a fresh read can authorize retry.
      setApproval(undefined);
      setError("Cosmos did not confirm the change. Refresh local voice permission before retrying.");
    } finally { if (current === generation.current) { active.current = null; setBusy(false); } }
  }
  return <div className={settings.stateRow} aria-label={`Local voice permission for Pin ${pin.deviceId}`}>
    <button type="button" className={styles.pairCancel} aria-expanded={open} onClick={() => {
      if (open) reset(); else void load();
      setOpen(!open);
    }}>{open ? "Close local voice permission" : "Local voice permission"}</button>
    {open ? <div className={styles.speechPermission}>
      <p>Approve shared voice requests on this Pin. Audio processing stays on your Cosmos server. After runtime checks, recognized requests may be sent to your selected conversation provider.</p>
      <p>Native microphone integration is in preview and is not connected yet. Saving permission does not activate the microphone.</p>
      <p>This permission is separate from cloud speech provider permission.</p>
      {approval !== undefined ? <p>{approval?.policy
        ? `Current voice privacy: ${FLOOR_NAMES[approval.policy.sourceFloor]}.`
        : "No active local voice permission."}</p> : busy ? <p role="status">Checking local voice permission…</p> : null}
      <p>Allowing shared requests replaces any stricter local voice setting. Cosmos may apply more restrictive privacy to each request.</p>
      {pin.currentPaired !== true ? <p>Current pairing is unavailable. Existing local voice permission can still be revoked.</p> : null}
      <div className={styles.unpairActions}>
        <button type="button" className={styles.pairOpenButton} disabled={busy || approval === undefined || pin.currentPaired !== true}
          onClick={() => void save({ sourceFloor: "shared_room" })}>Allow shared local voice requests</button>
        <button type="button" className={styles.pairCancel} disabled={busy || !approval?.policy} onClick={() => void save(null)}>Revoke local voice permission</button>
      </div>
      <button type="button" className={styles.pairCancel} disabled={busy} onClick={() => void load()}>Refresh local voice permission</button>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
  </div>;
}
