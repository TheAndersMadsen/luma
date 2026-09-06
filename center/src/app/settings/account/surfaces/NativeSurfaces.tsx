"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { record } from "@/lib/contracts/surfaces";
import { NATIVE_DESCRIPTOR_BYTES, NATIVE_PLATFORMS, nativePublicKeyFingerprint, parseNativeDescriptorText,
  parseNativeSurface, parseNativeSurfaces, type NativeDescriptor, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import { WebLookupPermission } from "./WebLookupPermission";

type Review = { descriptor: NativeDescriptor; fingerprint: string; existing: NativeSurface | null };
const PATH = "/api/surfaces/native";

export function NativeSurfaces() {
  const [rows, setRows] = useState<NativeSurface[] | undefined>();
  const [source, setSource] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [revoking, setRevoking] = useState<NativeSurface | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const descriptorRead = useRef(0);
  const active = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    generation.current++; active.current?.abort(); active.current = null;
    descriptorRead.current++;
    setRows(undefined); setSource(""); setReview(null); setRevoking(null);
    setBusy(false); setMessage(""); setError("");
  }, []);
  const refresh = useCallback(async () => {
    invalidate(); setBusy(true);
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    try {
      const response = await fetch(PATH, { cache: "no-store", signal });
      if (!response.ok) throw new Error("native_list_unavailable");
      const saved = parseNativeSurfaces(await response.json());
      signal.throwIfAborted();
      if (generation.current === current) setRows(saved);
    } catch {
      if (generation.current === current) setError("Native approval status is unavailable. Refresh before making changes.");
    } finally { if (generation.current === current) { active.current = null; setBusy(false); } }
  }, [invalidate]);
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
  async function inspectDescriptor() {
    if (active.current || rows === undefined) return;
    descriptorRead.current++;
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    setBusy(true); setReview(null); setRevoking(null); setError(""); setMessage("");
    try {
      const descriptor = parseNativeDescriptorText(source);
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
      if (generation.current === current) setError("The installation could not be verified. Check its public descriptor and read its approval status again.");
    } finally { if (generation.current === current) { active.current = null; setBusy(false); } }
  }
  async function change(chosen: Review | NativeSurface) {
    if (active.current || rows === undefined) return;
    const approving = "descriptor" in chosen;
    if (approving ? chosen !== review || chosen.existing && !chosen.existing.revoked
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
      const nextRows = parseNativeSurfaces({ native: [...rows.filter(row => row.enrollmentId !== saved.enrollmentId), ...(saved.revoked ? [] : [saved])] });
      setRows(nextRows);
      setReview(null); setRevoking(null); setSource("");
      setMessage(saved.revoked ? "Cosmos confirmed this installation’s approval revoked."
        : "Cosmos recorded this installation’s public-text approval. Native text connections are still in development.");
    } catch {
      if (generation.current !== current) return;
      // A lost response may follow a committed write. A fresh owner read is
      // required before any further mutation, including a different installation.
      setRows(undefined); setReview(null); setRevoking(null);
      setError("Cosmos did not confirm the change. Refresh native approvals before retrying; the request may have committed.");
    } finally { if (generation.current === current) { active.current = null; setBusy(false); } }
  }
  return <section className={`${settings.section} ${styles.card}`} aria-label="Native installations">
    <h2>Native installations</h2>
    <p>Approve the public key for a native installation on macOS, Linux, Android or Android TV.</p>
    <p>Approvals are limited to public text. They do not allow voice, media context, private memories, device actions or output on the device.</p>
    <p>Native clients and their text connections are still being built. Approval alone does not install or connect a client.</p>
    <label className={styles.descriptorLabel} htmlFor="native-descriptor">Public installation descriptor</label>
    <textarea id="native-descriptor" className={styles.descriptor} value={source} maxLength={NATIVE_DESCRIPTOR_BYTES} rows={5}
      disabled={busy || rows === undefined} spellCheck={false} autoComplete="off" onChange={event => { descriptorRead.current++; setSource(event.target.value); setReview(null); setError(""); setMessage(""); }} />
    <label className={styles.descriptorLabel}>Import installation descriptor
      <input type="file" accept="application/json,.json" disabled={busy || rows === undefined} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (file) void importDescriptor(file);
      }} />
    </label>
    <p>Paste or import the public descriptor generated by the installation, up to 1 KB. The installation keeps its private key.</p>
    <button type="button" disabled={busy || rows === undefined || !source.trim()} onClick={() => void inspectDescriptor()}>Review installation</button>
    {review ? <div role="group" aria-label="Review native installation">
      <p><strong>{NATIVE_PLATFORMS[review.descriptor.platform]}</strong> · Installation <code>{review.descriptor.enrollmentId}</code></p>
      <p>Public-key fingerprint (SHA-256): <code className={styles.fingerprint}>{review.fingerprint}</code></p>
      <p>Compare this fingerprint with the installation before approving public text requests.</p>
      {review.existing && !review.existing.revoked ? <p>This installation already has public-text approval.</p> : <>
        {review.existing ? <p>Its earlier approval was revoked. Approving again restores only the public-text permission described above.</p> : null}
        <button type="button" disabled={busy || rows === undefined} onClick={() => void change(review)}>Confirm public-text approval</button>
      </>}
      <button type="button" disabled={busy} onClick={() => setReview(null)}>Cancel review</button>
    </div> : null}
    <h3>Approved native installations</h3>
    {rows === undefined ? <p role="status">{busy ? "Checking native approvals…" : "Read native approval status before making changes."}</p>
      : rows.length === 0 ? <p>No approved native installations.</p> : <ul>{rows.map(row => <li key={row.surfaceId}>
        <strong>{NATIVE_PLATFORMS[row.platform]}</strong> · Installation <code>{row.enrollmentId}</code>
        <p>Public-key fingerprint (SHA-256): <code className={styles.fingerprint}>{row.publicKeyFingerprint}</code></p>
        <p>Public-text approval recorded · connection unverified · room and actor unknown.</p>
        {revoking?.surfaceId === row.surfaceId ? <div role="group" aria-label={`Revoke installation ${row.enrollmentId}`}>
          <p>Revoke this installation’s approval and current connection?</p>
          <button type="button" disabled={busy} onClick={() => void change(row)}>Confirm revoke installation</button>
          <button type="button" disabled={busy} onClick={() => setRevoking(null)}>Cancel revocation</button>
        </div> : <button type="button" disabled={busy} onClick={() => { setReview(null); setRevoking(row); setError(""); setMessage(""); }}>Revoke installation {row.enrollmentId}</button>}
        <WebLookupPermission key={`lookup:${row.surfaceId}:${row.revision}`} surfaceId={row.surfaceId}
          approvalRevision={row.revision} label={`${NATIVE_PLATFORMS[row.platform]} installation ${row.enrollmentId}`} canApprove={!row.revoked}
          onRefreshApprovals={refresh} />
      </li>)}</ul>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh native approvals</button>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
