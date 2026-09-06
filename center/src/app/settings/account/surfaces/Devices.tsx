"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { record } from "@/lib/contracts/surfaces";
import { NATIVE_DESCRIPTOR_BYTES, nativePublicKeyFingerprint, parseNativeDescriptorText, parseNativeSurface, parseNativeSurfaces,
  type NativeDescriptor, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import { SPEECH_REGION } from "@/lib/contracts/speechDisclosure";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import { BrowserCard } from "./BrowserCard";
import { DeviceCard, DEVICE_LABELS } from "./DeviceCard";
import { fingerprintLines } from "./fingerprint";

type Review = { descriptor: NativeDescriptor; fingerprint: string; existing: NativeSurface | null };
const PATH = "/api/surfaces/native";

/** The Azure Speech region from Services, when this session may read it. Otherwise the owner types it once. */
async function readServicesRegion(signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch("/api/admin/integrations", { cache: "no-store", signal });
    if (!response.ok) return null;
    const region = record(record(await response.json()).speech).azure_region;
    return typeof region === "string" && SPEECH_REGION.test(region) ? region : null;
  } catch { return null; }
}

/** Devices that show Cosmos replies: this browser plus every approved native installation. */
export function Devices() {
  const [rows, setRows] = useState<NativeSurface[] | undefined>();
  const [adding, setAdding] = useState(false);
  const [manual, setManual] = useState(false);
  const [source, setSource] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [servicesRegion, setServicesRegion] = useState<string | null>(null);
  const [lastRegion, setLastRegion] = useState("");
  const onRegionUsed = useCallback((region: string) => setLastRegion(region), []);
  const generation = useRef(0);
  const descriptorRead = useRef(0);
  const active = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    generation.current++; active.current?.abort(); active.current = null;
    descriptorRead.current++;
    setRows(undefined); setSource(""); setReview(null); setApproved(null);
    setBusy(false); setMessage(""); setError("");
  }, []);
  const refresh = useCallback(async () => {
    invalidate(); setBusy(true);
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    try {
      // One transient failure (a busy runtime, a dropped connection) gets a
      // single retry before the page asks the owner to refresh by hand.
      let saved: NativeSurface[] | undefined;
      for (let attempt = 0; attempt < 2 && saved === undefined; attempt++) {
        try {
          const response = await fetch(PATH, { cache: "no-store", signal });
          if (!response.ok) throw new Error("native_list_unavailable");
          saved = parseNativeSurfaces(await response.json());
        } catch (failure) {
          signal.throwIfAborted();
          if (attempt === 1) throw failure;
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      }
      signal.throwIfAborted();
      if (generation.current === current && saved) setRows(saved);
    } catch {
      if (generation.current === current) setError("Device status is unavailable. Refresh before making changes.");
    } finally { if (generation.current === current) { active.current = null; setBusy(false); } }
  }, [invalidate]);
  // A device may hand its public descriptor over as a link fragment (for
  // example from a QR code). The fragment never reaches the server; it is
  // consumed once, validated like pasted text and cleared from the address.
  const linked = useRef<string | null>(null);
  if (linked.current === null && typeof window !== "undefined") {
    const match = /(?:^#|&)descriptor=([A-Za-z0-9_-]{1,1400})(?:&|$)/u.exec(window.location.hash);
    linked.current = match ? match[1] : "";
    if (match) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  useEffect(() => {
    const encoded = linked.current;
    if (!encoded || rows === undefined) return;
    linked.current = "";
    setAdding(true);
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)));
      parseNativeDescriptorText(text);
      descriptorRead.current++;
      setSource(text); setReview(null); setError(""); setMessage("");
      void inspect(text);
    } catch { setError("The link’s device details are not valid. Enter the descriptor manually instead."); }
    // Runs once per fresh owner read; the review it opens belongs to that read.
  }, [rows]);
  useEffect(() => {
    const resume = () => { if (document.visibilityState === "hidden") invalidate(); else void refresh(); };
    window.addEventListener("focus", resume);
    window.addEventListener("pagehide", invalidate);
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      generation.current++; active.current?.abort(); active.current = null;
      window.removeEventListener("focus", resume); window.removeEventListener("pagehide", invalidate);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [invalidate, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    void readServicesRegion(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])).then(region => {
      if (controller.signal.aborted || !region) return;
      setServicesRegion(region); setLastRegion(current => current || region);
    });
    return () => controller.abort();
  }, []);

  async function importDescriptor(file: File) {
    // A file picker can return window focus before its change event. The fresh
    // owner read may still be pending; it must not silently discard this file.
    const read = ++descriptorRead.current;
    setReview(null); setSource(""); setError(""); setMessage("");
    if (file.size > NATIVE_DESCRIPTOR_BYTES) { setError("The public installation descriptor must be at most 1 KB."); return; }
    const current = generation.current;
    try {
      const text = await file.text();
      parseNativeDescriptorText(text);
      if (generation.current === current && descriptorRead.current === read) setSource(text);
    } catch { if (generation.current === current && descriptorRead.current === read) setError("Use a valid public installation descriptor containing only the enrollment ID, public key, platform and approval profile."); }
  }
  async function inspect(text: string) {
    if (active.current || rows === undefined) return;
    descriptorRead.current++;
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    setBusy(true); setReview(null); setError(""); setMessage("");
    try {
      const descriptor = parseNativeDescriptorText(text);
      const fingerprint = await nativePublicKeyFingerprint(descriptor.publicKey);
      signal.throwIfAborted();
      const response = await fetch(`${PATH}/enrollments/${descriptor.enrollmentId}`, { cache: "no-store", signal });
      if (!response.ok && response.status !== 404) throw new Error("native_lookup_unavailable");
      const existing = response.status === 404 ? null : parseNativeSurface(record(await response.json()).native);
      signal.throwIfAborted();
      if (existing && (existing.enrollmentId !== descriptor.enrollmentId || existing.platform !== descriptor.platform
        || existing.publicKeyFingerprint !== fingerprint)) throw new Error("native_descriptor_changed");
      if (generation.current === current) setReview({ descriptor, fingerprint, existing });
    } catch {
      if (generation.current === current) setError("This device could not be verified. Check its descriptor and read the device list again.");
    } finally { if (generation.current === current) { active.current = null; setBusy(false); } }
  }
  async function change(chosen: Review | NativeSurface) {
    if (active.current || rows === undefined) return;
    const approving = "descriptor" in chosen;
    if (approving ? chosen !== review || chosen.existing && !chosen.existing.revoked && chosen.existing.speech
      : !rows.some(row => row.surfaceId === chosen.surfaceId && row.revision === chosen.revision)) return;
    descriptorRead.current++;
    const expectedRevision = approving ? chosen.existing?.revision ?? 0 : chosen.revision;
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(approving ? PATH : `${PATH}/${chosen.surfaceId}`, {
        method: approving ? "POST" : "DELETE", headers: { "content-type": "application/json" }, cache: "no-store", signal,
        body: JSON.stringify(approving ? { ...chosen.descriptor, expectedRevision } : { expectedRevision }),
      });
      if (!response.ok) throw new Error("native_change_unconfirmed");
      const saved = parseNativeSurface(record(await response.json()).native);
      signal.throwIfAborted();
      const identity = approving ? chosen.descriptor : chosen;
      const fingerprint = approving ? chosen.fingerprint : chosen.publicKeyFingerprint;
      const surfaceId = approving ? chosen.existing?.surfaceId : chosen.surfaceId;
      if (saved.enrollmentId !== identity.enrollmentId || saved.platform !== identity.platform || saved.publicKeyFingerprint !== fingerprint
        || saved.revision !== expectedRevision + 1 || saved.revoked === approving || surfaceId && saved.surfaceId !== surfaceId) throw new Error("native_change_mismatch");
      if (generation.current !== current) return;
      setRows(parseNativeSurfaces({ native: [...rows.filter(row => row.enrollmentId !== saved.enrollmentId), ...(saved.revoked ? [] : [saved])] }));
      setReview(null); setSource("");
      if (saved.revoked) { setApproved(null); setMessage("Removed. This device no longer shows replies."); }
      else { setAdding(false); setManual(false); setApproved(saved.surfaceId); setMessage("Approved. Cosmos shows replies on this device while its app is in front."); }
    } catch {
      if (generation.current !== current) return;
      // A lost response may follow a committed write. A fresh owner read is
      // required before any further mutation, including on another device.
      setRows(undefined); setReview(null); setApproved(null);
      setError("Cosmos did not confirm the change. Refresh devices before retrying; the request may have committed.");
    } finally { if (generation.current === current) { active.current = null; setBusy(false); } }
  }
  const alreadyApproved = review?.existing !== null && review?.existing !== undefined && !review.existing.revoked && review.existing.speech;
  return <section className={styles.page} aria-label="Devices">
    <div className={styles.lead}>
      <p className={styles.leadText}>Cosmos shows replies on the devices you approve here.</p>
      <button type="button" className={styles.primary} aria-expanded={adding} onClick={() => {
        if (adding) { descriptorRead.current++; setAdding(false); setManual(false); setSource(""); setReview(null); }
        else setAdding(true);
        setMessage(""); setError("");
      }}>Add a device</button>
    </div>
    {adding ? <section className={`${settings.section} ${styles.card}`} aria-label="Add a device">
      <p className={styles.line}>During its own set-up, the device shows a QR code or an “Approve in Center” link. Open that link on this page and the device appears here for approval.</p>
      {review ? <div className={styles.review} role="group" aria-label="Review device">
        <h3 className={styles.reviewTitle}>{DEVICE_LABELS[review.descriptor.platform]}</h3>
        <p className={styles.line}>Compare with the fingerprint shown on the device.</p>
        <code className={styles.fingerprint}>{fingerprintLines(review.fingerprint).map((line, index) => <span key={index}>{line}</span>)}</code>
        {alreadyApproved ? <p className={styles.line}>This device is already approved.</p> : <>
          {review.existing?.revoked ? <p className={styles.line}>This device was removed earlier. Approving it again restores shared replies; its other permissions stay off until you turn them on.</p> : null}
          {review.existing && !review.existing.revoked ? <p className={styles.line}>This device was approved before spoken replies existed. Approving it again adds them, and its app reconnects.</p> : null}
        </>}
        <div className={styles.actions}>
          {alreadyApproved ? null : <button type="button" className={styles.primary} disabled={busy || rows === undefined} onClick={() => void change(review)}>Approve this device</button>}
          <button type="button" className={styles.quiet} disabled={busy} onClick={() => setReview(null)}>{alreadyApproved ? "Close" : "Cancel"}</button>
        </div>
      </div> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.linkButton} aria-expanded={manual} onClick={() => setManual(!manual)}>Enter a descriptor manually</button>
      </div>
      {manual ? <div className={styles.manual}>
        <label className={styles.field} htmlFor="native-descriptor">Public installation descriptor</label>
        <textarea id="native-descriptor" className={styles.descriptor} value={source} maxLength={NATIVE_DESCRIPTOR_BYTES} rows={5}
          disabled={busy || rows === undefined} spellCheck={false} autoComplete="off"
          onChange={event => { descriptorRead.current++; setSource(event.target.value); setReview(null); setError(""); setMessage(""); }} />
        <label className={styles.field}>Import installation descriptor
          <input type="file" accept="application/json,.json" disabled={busy || rows === undefined} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ""; if (file) void importDescriptor(file);
          }} />
        </label>
        <p className={styles.line}>Paste or import the public descriptor the device generated, up to 1 KB. The device keeps its private key.</p>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={busy || rows === undefined || !source.trim()} onClick={() => void inspect(source)}>Review</button>
        </div>
      </div> : null}
    </section> : null}
    {message ? <p className={styles.status} role="status">{message}</p> : null}
    {error ? <p className={styles.alert} role="alert">{error}</p> : null}
    <ul className={styles.cards}>
      <li><BrowserCard /></li>
      {rows?.map(row => <li key={`${row.surfaceId}:${row.revision}`}>
        <DeviceCard row={row} servicesRegion={servicesRegion} lastRegion={lastRegion} onRegionUsed={onRegionUsed} offerSetup={approved === row.surfaceId}
          busy={busy} onRemove={chosen => void change(chosen)} onRefreshDevices={() => void refresh()} />
      </li>)}
    </ul>
    {rows === undefined ? <p className={styles.status} role="status">{busy ? "Checking devices…" : "Device status is unavailable. Refresh before making changes."}</p>
      : rows.length === 0 ? <p className={styles.status}>No phones, TVs or computers yet. Choose Add a device to show Cosmos replies on one.</p> : null}
    <div className={styles.actions}>
      <button type="button" className={styles.quiet} disabled={busy} onClick={() => void refresh()}>Refresh devices</button>
    </div>
  </section>;
}
