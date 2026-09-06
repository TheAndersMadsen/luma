"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { exact } from "@/lib/contracts/surfaces";
import { WEB_LOOKUP_APPROVAL, parseWebLookupState, type WebLookupPolicy, type WebLookupProvider, type WebLookupState } from "@/lib/contracts/webLookup";
import styles from "./webLookupPermission.module.css";

type Props = {
  surfaceId: string;
  approvalRevision: number;
  label: string;
  canApprove: boolean;
  revisionMayAdvance?: boolean;
  onRefreshApprovals: () => Promise<void>;
};
type Review = { policy: WebLookupPolicy | null };
const providerName = (provider: WebLookupProvider) => provider.provider === "searxng" ? "SearXNG" : "SerpApi";
const providerKey = (provider: WebLookupProvider) => `${provider.provider}:${provider.configurationDigest}`;

function ProviderDetails({ provider }: { provider: WebLookupProvider }) {
  return <>
    <p><strong>{providerName(provider)}</strong><br /><span className={styles.endpoint}>{provider.endpoint}</span></p>
    <p>{provider.provider === "searxng"
      ? "Bing engine requests through your SearXNG service. That service controls its downstream queries."
      : "Google web search through SerpApi."}</p>
  </>;
}

/** A separate owner gesture binds one provider to one existing surface approval. */
export function WebLookupPermission({ surfaceId, approvalRevision, label, canApprove, revisionMayAdvance = false, onRefreshApprovals }: Props) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<WebLookupState>();
  const [selected, setSelected] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [needsApprovalRefresh, setNeedsApprovalRefresh] = useState(false);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const path = `/api/surfaces/${surfaceId}/web-lookup`;
  // Browser row revisions include heartbeats. The reviewed binding comes from
  // the atomic permission GET and remains valid for that same incarnation.
  const parentRevision = revisionMayAdvance ? null : approvalRevision;

  const invalidate = useCallback(() => {
    generation.current++;
    active.current?.abort(); active.current = null;
    setSnapshot(undefined); setSelected(""); setReview(null);
    setBusy(false); setMessage(""); setError("");
  }, []);
  useEffect(() => {
    // Returning to the page requires a fresh owner read, including when a
    // parent keeps its surface inventory mounted across session changes.
    const close = () => { invalidate(); setOpen(false); };
    setNeedsApprovalRefresh(false);
    close();
    window.addEventListener("focus", close);
    window.addEventListener("pagehide", close);
    document.addEventListener("visibilitychange", close);
    return () => {
      generation.current++; active.current?.abort(); active.current = null;
      window.removeEventListener("focus", close);
      window.removeEventListener("pagehide", close);
      document.removeEventListener("visibilitychange", close);
    };
  }, [invalidate, surfaceId, parentRevision, canApprove, revisionMayAdvance]);

  async function load() {
    if (needsApprovalRefresh) return;
    invalidate(); setBusy(true);
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    try {
      const response = await fetch(path, { cache: "no-store", signal });
      signal.throwIfAborted();
      if (!response.ok) throw new Error("unavailable");
      const saved = parseWebLookupState(await response.json());
      signal.throwIfAborted();
      if (!revisionMayAdvance && saved.binding.approvalRevision !== approvalRevision) {
        setNeedsApprovalRefresh(true);
        throw new Error("approval_changed");
      }
      if (revisionMayAdvance ? saved.binding.incarnation === null : saved.binding.incarnation !== null) throw new Error("invalid_binding");
      if (current !== generation.current) return;
      setSnapshot(saved);
      const previous = saved.approval?.policy?.provider;
      if (previous && saved.providers.some(provider => exact(provider, previous))) setSelected(providerKey(previous));
    } catch {
      if (current === generation.current) setError("Web lookup permission is unavailable. Refresh device approvals and permission status before making changes.");
    } finally { if (current === generation.current) { active.current = null; setBusy(false); } }
  }

  async function save() {
    if (active.current || !snapshot || !review || needsApprovalRefresh || review.policy && !canApprove) return;
    const policy = review.policy;
    if (policy && !snapshot.providers.some(provider => exact(provider, policy.provider))) return;
    if (!policy && !snapshot.approval?.policy) return;
    const expectedRevision = snapshot.approval?.revision ?? 0;
    const reviewedBinding = snapshot.binding;
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal,
        body: JSON.stringify({ approval: WEB_LOOKUP_APPROVAL, approvalRevision: reviewedBinding.approvalRevision,
          approvalIncarnation: reviewedBinding.incarnation, expectedRevision, policy }) });
      signal.throwIfAborted();
      if (!response.ok) throw new Error("unconfirmed");
      const saved = parseWebLookupState(await response.json());
      signal.throwIfAborted();
      if (!saved.approval || saved.approval.approvalRevision !== reviewedBinding.approvalRevision
        || saved.binding.incarnation !== reviewedBinding.incarnation
        || (revisionMayAdvance ? saved.binding.approvalRevision < reviewedBinding.approvalRevision
          : saved.binding.approvalRevision !== reviewedBinding.approvalRevision)
        || saved.approval.revision !== expectedRevision + 1 || !exact(saved.approval.policy, policy)) throw new Error("approval_mismatch");
      if (current !== generation.current) return;
      setSnapshot(saved); setReview(null);
      setSelected(policy && saved.providers.some(provider => exact(provider, policy.provider)) ? providerKey(policy.provider) : "");
      setMessage(policy ? "Cosmos confirmed web lookup permission for this device." : "Cosmos confirmed web lookup permission revoked.");
    } catch {
      if (current !== generation.current) return;
      // A lost response can follow a committed write. Only a fresh read can
      // supply the next CAS revision; never retry with an inferred outcome.
      setSnapshot(undefined); setSelected(""); setReview(null);
      setError("Cosmos did not confirm the change. Refresh permission status before retrying; the request may have committed.");
    } finally { if (current === generation.current) { active.current = null; setBusy(false); } }
  }

  const provider = snapshot?.providers.find(candidate => providerKey(candidate) === selected);
  const recorded = snapshot?.approval?.policy;
  const currentProvider = recorded && snapshot?.providers.some(candidate => exact(candidate, recorded.provider));
  return <div className={styles.permission} role="group" aria-label={`Web lookup permission for ${label}`}>
    <button type="button" aria-expanded={open} onClick={() => {
      if (open) invalidate(); else void load();
      setOpen(!open);
    }}>{open ? "Close web lookup permission" : "Web lookup permission"}</button>
    {open ? <>
      <p>Allow Cosmos to send query text from {label} to one selected web search provider. Device approval and saved provider credentials do not grant this permission.</p>
      <p>Maximum approved content: <strong>shared-room query text</strong>. Cosmos keeps the request’s privacy classification. Private memories, messages, documents and precise device location are outside this permission.</p>
      {snapshot ? recorded ? <div>
        <p>Recorded web lookup permission:</p>
        <ProviderDetails provider={recorded.provider} />
        {!currentProvider ? <p role="status">The provider configuration changed or is unavailable. This permission cannot authorize a lookup. Review a current provider to approve it again.</p> : null}
      </div> : <p>No active web lookup permission.</p> : busy ? <p role="status">Checking web lookup permission…</p> : null}
      {!canApprove ? <p>This device’s current request approval is unavailable. Existing web lookup permission can still be revoked.</p> : null}
      {snapshot?.providers.length === 0 ? <p>No configured web lookup provider is available. Open <Link href="/settings/account/services">Services</Link>, then refresh permission status.</p> : null}
      <label className={styles.field}>Web search provider
        <select value={selected} disabled={busy || !snapshot || !canApprove || !snapshot.providers.length} onChange={event => {
          setSelected(event.target.value); setReview(null); setMessage(""); setError("");
        }}>
          <option value="">Choose a provider</option>
          {snapshot?.providers.map(candidate => <option key={providerKey(candidate)} value={providerKey(candidate)}>{providerName(candidate)} · {candidate.endpoint}</option>)}
        </select>
      </label>
      <div className={styles.actions}>
        <button type="button" disabled={busy || needsApprovalRefresh || !snapshot || !canApprove || !provider}
          onClick={() => { if (provider) { setReview({ policy: { provider, maximumClass: "shared_room" } }); setMessage(""); setError(""); } }}>Review web lookup permission</button>
        <button type="button" disabled={busy || needsApprovalRefresh || !recorded} onClick={() => { setReview({ policy: null }); setMessage(""); setError(""); }}>Revoke web lookup permission</button>
      </div>
      {review ? <div className={styles.review} role="group" aria-label={review.policy ? "Review web lookup permission" : "Review web lookup revocation"}>
        {review.policy ? <>
          <p>Allow web lookup from <strong>{label}</strong> using this exact provider configuration?</p>
          <ProviderDetails provider={review.policy.provider} />
          <p>Maximum approved content: <strong>shared-room query text</strong>. Changing providers requires a separate approval. A lookup will not switch providers if this one fails.</p>
          <button type="button" disabled={busy || !canApprove} onClick={() => void save()}>Allow shared-room web lookup</button>
        </> : <>
          <p>Revoke web lookup permission for <strong>{label}</strong>? This stops permission for future queries; it cannot recall queries already sent.</p>
          <button type="button" disabled={busy} onClick={() => void save()}>Confirm revoke web lookup</button>
        </>}
        <button type="button" disabled={busy} onClick={() => setReview(null)}>Cancel web lookup review</button>
      </div> : null}
      {needsApprovalRefresh ? <>
        <p>The device or permission revision changed. Refresh device approvals, then reopen this permission and review it again.</p>
        <button type="button" disabled={busy} onClick={() => { invalidate(); setOpen(false); void onRefreshApprovals(); }}>Refresh device approvals</button>
      </> : null}
      <button type="button" disabled={busy || needsApprovalRefresh} onClick={() => void load()}>Refresh web lookup permission</button>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </> : null}
  </div>;
}
