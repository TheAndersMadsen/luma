"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEVICE_ID, PIN_APPROVAL, parsePinSurface, parsePinSurfaces, type PinSurface } from "@/lib/contracts/pinSurfaces";
import { record } from "@/lib/contracts/surfaces";
import settings from "../../settings.module.css";
import styles from "./devices.module.css";

type Selection = { deviceId: string; surfaceId?: string };

export function PinRuntimeApproval() {
  const [approvals, setApprovals] = useState<PinSurface[]>([]);
  const [devices, setDevices] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [revoked, setRevoked] = useState<string[]>([]);
  // Neither approvals nor device choices enter the shared account-unscoped query
  // cache. A returning tab must read both under its current cookie session.
  const invalidate = useCallback(() => {
    generation.current++;
    controller.current?.abort(); controller.current = null;
    inFlight.current = false;
    setApprovals([]); setDevices([]); setSelection(null); setRevoked([]);
    setMessage(""); setError(""); setBusy(false); setFailed(false); setUnavailable(false); setPending(true);
  }, []);
  const refresh = useCallback(async () => {
    invalidate();
    const current = generation.current;
    const active = new AbortController(); controller.current = active;
    const signal = AbortSignal.any([active.signal, AbortSignal.timeout(10000)]);
    const read = async (url: string) => {
      const response = await fetch(url, { cache: "no-store", signal });
      if (!response.ok) throw new Error("owner_list_unavailable");
      return response.json();
    };
    const [inventory, roster] = await Promise.allSettled([
      read("/api/devices/runtime").then(parsePinSurfaces),
      read("/api/devices/pair").then(value => {
        const { devices } = record(value);
        if (!Array.isArray(devices) || devices.length > 256) throw new Error("invalid_roster");
        return [...new Set(devices.map(value => {
          const { deviceId } = record(value);
          if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) throw new Error("invalid_device");
          return deviceId.toLowerCase();
        }))];
      }),
    ]);
    if (generation.current !== current || active.signal.aborted) return;
    if (inventory.status === "fulfilled") setApprovals(inventory.value); else setUnavailable(true);
    if (roster.status === "fulfilled") setDevices(roster.value); else setFailed(true);
    setPending(false);
  }, [invalidate]);
  useEffect(() => {
    const resume = () => { if (document.visibilityState === "hidden") invalidate(); else void refresh(); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      generation.current++; controller.current?.abort(); controller.current = null;
      window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume);
    };
  }, [invalidate, refresh]);
  const byDevice = new Map(approvals.map(pin => [pin.deviceId, pin]));
  const rows = [...new Set([
    ...(!failed ? devices : []), ...byDevice.keys(),
  ])];

  async function confirm() {
    if (!selection || inFlight.current || pending || unavailable) return;
    if (selection.surfaceId ? byDevice.get(selection.deviceId)?.surfaceId !== selection.surfaceId
      : failed || !devices.includes(selection.deviceId)) return;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    const chosen = selection;
    const current = generation.current;
    const active = new AbortController(); controller.current = active;
    try {
      const response = await fetch(`/api/devices/runtime${chosen.surfaceId ? `/${chosen.surfaceId}` : ""}`, {
        method: chosen.surfaceId ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: chosen.surfaceId ? undefined : JSON.stringify({ deviceId: chosen.deviceId, approval: PIN_APPROVAL }),
        cache: "no-store", signal: AbortSignal.any([active.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error("approval_not_confirmed");
      const pin = parsePinSurface(record(await response.json()).pin, Boolean(chosen.surfaceId));
      if (current !== generation.current || active.signal.aborted) return;
      if (pin.deviceId !== chosen.deviceId || pin.revoked !== Boolean(chosen.surfaceId) || !chosen.surfaceId && !pin.currentPaired
        || chosen.surfaceId && pin.surfaceId !== chosen.surfaceId) throw new Error("approval_mismatch");
      // Only the committed response changes UI state. Never optimistic authority.
      setApprovals(rows => [
        ...rows.filter(row => row.deviceId !== pin.deviceId), ...(pin.revoked ? [] : [pin]),
      ]);
      setRevoked(rows => pin.revoked ? [...rows, pin.deviceId] : rows.filter(id => id !== pin.deviceId));
      setSelection(null);
      setMessage(pin.revoked ? pin.currentPaired === null ? "Cosmos confirmed runtime approval revoked. Current pairing status is unavailable; revocation did not change pairing." : "Cosmos confirmed runtime approval revoked. Pairing is unchanged."
        : "Cosmos committed shared-speech approval. Device behavior and playback remain unverified.");
    } catch {
      if (current !== generation.current || active.signal.aborted) return;
      setError("Cosmos did not confirm the change. Refresh approval status before retrying; a timed-out request may have committed.");
    } finally { if (current === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  return <section className={settings.section} aria-label="Ambiance runtime approval">
    <div className={settings.sectionHeader}><span className={settings.sectionTitle}>Ambiance runtime approval</span></div>
    <div className={settings.stateRow}>
      <p>Pairing does not approve a Pin for the Ambiance runtime. Approve each paired Pin explicitly.</p>
      <p>Shared speech only: room occupancy and actor identity remain unknown. Trust level 0, no autonomy and no private-memory clearance. Rendering, playback and end-to-end Pin behavior are not verified.</p>
    </div>
    {failed ? <div className={settings.stateRow}>The pairing roster is unavailable. Existing runtime approvals can still be revoked; new approval is disabled.</div> : null}
    {pending ? <div className={settings.stateRow}>Checking runtime approvals…</div> : unavailable ? <div className={settings.stateRow} role="status">
      Runtime approval status is unavailable. No approval is inferred from pairing.
    </div> : rows.length === 0 ? !failed ? <div className={settings.stateRow}>Pair a Pin through guided setup before approving its runtime participation.</div> : null : rows.map(deviceId => {
      const pin = byDevice.get(deviceId);
      const selected = selection?.deviceId === deviceId;
      return <div className={styles.deviceClaimRow} key={deviceId} aria-label={`Runtime approval for Pin ${deviceId}`}>
        <span className={settings.additionRowText}>
          <span className={settings.additionRowTitle}>Pin {deviceId}</span>
          <span className={settings.additionRowDesc}>{pin ? pin.currentPaired === null ? "Approval remains; current pairing status is unknown. Runtime admission is unavailable, but this approval can be revoked." : pin.currentPaired ? "Shared-speech approval recorded; not proof of online status or runtime admission." : "Approval remains, but this Pin is no longer paired to this account. Not admitted; revoke this stale approval." : revoked.includes(deviceId) ? "Runtime approval revoked." : "No active runtime approval."}</span>
        </span>
        {selected ? <div className={styles.unpairConfirm}>
          <span>{selection?.surfaceId ? "Revoke runtime approval for this Pin? Pairing will remain unchanged." : "Approve this Pin with the shared-speech limits above?"}</span>
          <div className={styles.unpairActions}>
            <button type="button" className={styles.pairOpenButton} disabled={busy} onClick={() => void confirm()}>{busy ? "Waiting for Cosmos…" : selection?.surfaceId ? "Confirm revoke" : "Confirm shared speech"}</button>
            <button type="button" className={styles.pairCancel} disabled={busy} onClick={() => setSelection(null)}>Cancel</button>
          </div>
        </div> : <button type="button" className={styles.pairOpenButton} disabled={busy || !DEVICE_ID.test(deviceId)} onClick={() => { setError(""); setMessage(""); setSelection({ deviceId, surfaceId: pin?.surfaceId }); }}>
          {pin ? "Revoke runtime approval" : "Approve shared speech"}
        </button>}
      </div>;
    })}
    {message ? <div className={settings.stateRow} role="status">{message}</div> : null}
    {error ? <div className={settings.stateRow} role="alert">{error}</div> : null}
    <div className={settings.stateRow}><button type="button" className={styles.pairCancel} disabled={busy} onClick={() => { void refresh(); }}>Refresh runtime approvals</button></div>
  </section>;
}
