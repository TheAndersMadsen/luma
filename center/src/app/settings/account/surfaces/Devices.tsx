"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { record } from "@/lib/contracts/surfaces";
import { NATIVE_DESCRIPTOR_BYTES, nativePublicKeyFingerprint, parseNativeDescriptorText, parseNativeSurface, parseNativeSurfaces,
  type NativeDescriptor, type NativeSurface } from "@/lib/contracts/nativeSurfaces";
import { PIN_APPROVAL, parsePairedPinDevices, parsePinSurface, parsePinSurfaces, type PinSurface } from "@/lib/contracts/pinSurfaces";
import { SPEECH_REGION } from "@/lib/contracts/speechDisclosure";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import { BrowserCard } from "./BrowserCard";
import { DeviceCard, DEVICE_LABELS } from "./DeviceCard";
import { PinCard } from "./PinCard";
import { fingerprintLines } from "./fingerprint";

type Review = { descriptor: NativeDescriptor; fingerprint: string; existing: NativeSurface | null };
const PATH = "/api/surfaces/native";
const PIN_PATH = "/api/devices/runtime";
const PAIR_PATH = "/api/devices/pair";

/**
 * One card per Pin this account has: every approval, and every paired Pin still
 * waiting for one. A Pin that is paired and unapproved is a normal state, not a
 * failure, and an account with no Pin still gets the card that says so.
 */
export function pinCards(pins: PinSurface[], paired: string[] | undefined): { deviceId: string | null; pin: PinSurface | null }[] {
  const rows = [
    ...pins.map(pin => ({ deviceId: pin.deviceId, pin })),
    ...(paired ?? []).filter(deviceId => !pins.some(pin => pin.deviceId === deviceId)).map(deviceId => ({ deviceId, pin: null })),
  ];
  return rows.length ? rows : [{ deviceId: null, pin: null }];
}

/** The Azure Speech region from Services, when this session may read it. Otherwise the owner types it once. */
async function readServicesRegion(signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch("/api/admin/integrations", { cache: "no-store", signal });
    if (!response.ok) return null;
    const region = record(record(await response.json()).speech).azure_region;
    return typeof region === "string" && SPEECH_REGION.test(region) ? region : null;
  } catch { return null; }
}

/** Every device Cosmos can answer on: the Ai Pin, this browser and every approved installation. */
export function Devices() {
  const [rows, setRows] = useState<NativeSurface[] | undefined>();
  const [pins, setPins] = useState<PinSurface[] | undefined>();
  const [paired, setPaired] = useState<string[] | undefined>();
  const [pinBusy, setPinBusy] = useState(false);
  const [pinFailed, setPinFailed] = useState(false);
  const [pairFailed, setPairFailed] = useState(false);
  const [approvedPin, setApprovedPin] = useState<string | null>(null);
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
  const pinActive = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    generation.current++; active.current?.abort(); active.current = null;
    pinActive.current?.abort(); pinActive.current = null;
    descriptorRead.current++;
    setRows(undefined); setSource(""); setReview(null); setApproved(null);
    setPins(undefined); setPaired(undefined); setApprovedPin(null); setPinBusy(false);
    setPinFailed(false); setPairFailed(false);
    setBusy(false); setMessage(""); setError("");
  }, []);
  /**
   * The owner's Pins and the pairing roster, read together and fenced by the
   * same generation. Either half may fail on its own: a missing roster hides
   * only the Pins that are waiting for approval, and a missing approval list
   * is said out loud rather than shown as "no Pin".
   */
  const refreshPins = useCallback(async (current: number) => {
    const controller = new AbortController(); pinActive.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    setPinBusy(true);
    const read = async (path: string) => {
      const response = await fetch(path, { cache: "no-store", signal });
      if (!response.ok) throw new Error("pin_read_unavailable");
      return response.json();
    };
    const [approvals, roster] = await Promise.allSettled([
      read(PIN_PATH).then(parsePinSurfaces),
      read(PAIR_PATH).then(parsePairedPinDevices),
    ]);
    if (generation.current !== current) return;
    if (approvals.status === "fulfilled") setPins(approvals.value); else setPinFailed(true);
    if (roster.status === "fulfilled") setPaired(roster.value); else setPairFailed(true);
    pinActive.current = null; setPinBusy(false);
  }, []);
  const refresh = useCallback(async () => {
    invalidate(); setBusy(true);
    const current = generation.current;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    // Installations and Pins are independent reads; neither waits for the other.
    let request = fetch(PATH, { cache: "no-store", signal });
    void refreshPins(current);
    try {
      // One transient failure (a busy runtime, a dropped connection) gets a
      // single retry before the page asks the owner to refresh by hand.
      let saved: NativeSurface[] | undefined;
      for (let attempt = 0; attempt < 2 && saved === undefined; attempt++) {
        try {
          const response = await request;
          if (!response.ok) throw new Error("native_list_unavailable");
          saved = parseNativeSurfaces(await response.json());
        } catch (failure) {
          signal.throwIfAborted();
          if (attempt === 1) throw failure;
          await new Promise(resolve => setTimeout(resolve, 400));
          request = fetch(PATH, { cache: "no-store", signal });
        }
      }
      signal.throwIfAborted();
      if (generation.current === current && saved) setRows(saved);
    } catch {
      if (generation.current === current) setError("Cosmos could not be reached just now. Choose Refresh devices to try again.");
    } finally { if (generation.current === current) { active.current = null; setBusy(false); } }
  }, [invalidate, refreshPins]);
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
    } catch { setError("That link does not carry valid device details. Enter the device’s code by hand instead."); }
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
      pinActive.current?.abort(); pinActive.current = null;
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
      if (generation.current === current) setError("This device could not be verified. Check its details and read the device list again.");
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
  /**
   * Approving or removing one Pin. Approval names a device the roster just
   * showed as paired; removal names an approval this page has read. A lost
   * reply may still have committed, so it clears the list instead of guessing.
   */
  async function changePin(chosen: { approve: string } | { remove: PinSurface }) {
    if (pinActive.current || pins === undefined) return;
    const approving = "approve" in chosen;
    if (approving ? paired === undefined || !paired.includes(chosen.approve) || pins.some(pin => pin.deviceId === chosen.approve)
      : !pins.some(pin => pin.surfaceId === chosen.remove.surfaceId && pin.revision === chosen.remove.revision)) return;
    const current = generation.current;
    const controller = new AbortController(); pinActive.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    setPinBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(approving ? PIN_PATH : `${PIN_PATH}/${chosen.remove.surfaceId}`, {
        method: approving ? "POST" : "DELETE", headers: { "content-type": "application/json" }, cache: "no-store", signal,
        body: approving ? JSON.stringify({ deviceId: chosen.approve, approval: PIN_APPROVAL }) : undefined,
      });
      if (!response.ok) throw new Error("pin_change_unconfirmed");
      const saved = parsePinSurface(record(await response.json()).pin, !approving);
      signal.throwIfAborted();
      if (approving ? saved.deviceId !== chosen.approve || saved.revoked || !saved.currentPaired
        : saved.surfaceId !== chosen.remove.surfaceId || !saved.revoked) throw new Error("pin_change_mismatch");
      if (generation.current !== current) return;
      setPins([...pins.filter(pin => pin.deviceId !== saved.deviceId), ...(saved.revoked ? [] : [saved])]);
      if (saved.revoked) { setApprovedPin(null); setMessage("Removed. Cosmos no longer answers on this Pin, and it stays paired with your account."); }
      else { setApprovedPin(saved.surfaceId); setMessage("Approved. Cosmos answers on this Pin."); }
    } catch {
      if (generation.current !== current) return;
      // The write may have committed. Only a fresh read can say, so the card
      // keeps its place and says it cannot speak for the Pin until then.
      setPins(undefined); setApprovedPin(null); setPinFailed(true);
      setError("Cosmos did not confirm the change. Refresh devices before retrying; the request may have committed.");
    } finally { if (generation.current === current) { pinActive.current = null; setPinBusy(false); } }
  }
  const alreadyApproved = review?.existing !== null && review?.existing !== undefined && !review.existing.revoked && review.existing.speech;
  const waiting = adding && busy && review === null && rows !== undefined;
  // An unreadable approval list is never rendered as "no Pin". A roster this
  // page could not read hides only the Pins that have no approval yet.
  const pinsUnreadable = pinFailed || (pairFailed && pins?.length === 0);
  const pinRows = pinsUnreadable ? [{ deviceId: null, pin: null }] : pins ? pinCards(pins, paired) : [];
  return <section className={styles.page} aria-label="Devices">
    <div className={styles.lead}>
      <p className={styles.leadText}>Cosmos answers on the devices you approve here.</p>
      <button type="button" className={styles.primary} aria-expanded={adding} onClick={() => {
        if (adding) { descriptorRead.current++; setAdding(false); setManual(false); setSource(""); setReview(null); }
        else setAdding(true);
        setMessage(""); setError("");
      }}>Add a device</button>
    </div>
    {adding ? <section className={`${settings.section} ${styles.card}`} aria-label="Add a device">
      <ol className={styles.howto}>
        <li>On the new device, open Cosmos and choose <strong>Approve in Center</strong>.</li>
        <li>Open the link it shows — scan its QR code with your phone, or type the link here.</li>
        <li>Check that the code it shows matches the one below, then approve.</li>
      </ol>
      {waiting ? <p className={styles.status} role="status">Checking this device…</p> : null}
      {review ? <div className={styles.review} role="group" aria-label="Review device">
        <h3 className={styles.reviewTitle}>{DEVICE_LABELS[review.descriptor.platform]}</h3>
        <p className={styles.line}>Compare with the fingerprint shown on the device.</p>
        <code className={styles.fingerprint}>{fingerprintLines(review.fingerprint).map((line, index) => <span key={index}>{line}</span>)}</code>
        {alreadyApproved ? <p className={styles.line}>This device is already approved.</p> : <>
          {review.existing?.revoked ? <p className={styles.line}>You removed this device earlier. Approving it again lets it show replies; its other permissions stay off until you turn them on.</p>
            : review.existing ? <p className={styles.line}>This device was approved before spoken replies existed. Approving it again adds them, and its app reconnects.</p>
              : <p className={styles.line}>This device is waiting for your approval.</p>}
        </>}
        <div className={styles.actions}>
          {alreadyApproved ? null : <button type="button" className={styles.primary} disabled={busy || rows === undefined} onClick={() => void change(review)}>Approve this device</button>}
          <button type="button" className={styles.quiet} disabled={busy} onClick={() => setReview(null)}>{alreadyApproved ? "Close" : "Cancel"}</button>
        </div>
      </div> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.linkButton} aria-expanded={manual} onClick={() => setManual(!manual)}>Enter the device details by hand</button>
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
    {message ? <p className={styles.confirmation} role="status">{message}</p> : null}
    {error ? <p className={styles.alert} role="alert">{error}</p> : null}
    <ul className={styles.cards}>
      {/* A fresh approval is a fresh card: its permissions belong to that exact revision. */}
      {pinRows.map(row => <li key={`${row.deviceId ?? "pin"}:${row.pin?.revision ?? 0}`}>
        <PinCard pin={row.pin} deviceId={row.deviceId} unreadable={pinsUnreadable} servicesRegion={servicesRegion} lastRegion={lastRegion}
          onRegionUsed={onRegionUsed} offerSetup={approvedPin !== null && approvedPin === row.pin?.surfaceId} busy={pinBusy}
          onApprove={deviceId => void changePin({ approve: deviceId })} onRemove={pin => void changePin({ remove: pin })}
          onRefreshDevices={() => void refresh()} />
      </li>)}
      {pins === undefined && !pinsUnreadable && pinBusy ? <li aria-hidden="true">
        <div className={`${settings.section} ${styles.card} ${styles.skeleton}`}><span /><span /></div>
      </li> : null}
      <li><BrowserCard /></li>
      {rows?.map(row => <li key={`${row.surfaceId}:${row.revision}`}>
        <DeviceCard row={row} servicesRegion={servicesRegion} lastRegion={lastRegion} onRegionUsed={onRegionUsed} offerSetup={approved === row.surfaceId}
          busy={busy} onRemove={chosen => void change(chosen)} onRefreshDevices={() => void refresh()} />
      </li>)}
      {rows === undefined && busy ? [0, 1].map(index => <li key={`skeleton-${index}`} aria-hidden="true">
        <div className={`${settings.section} ${styles.card} ${styles.skeleton}`}><span /><span /></div>
      </li>) : null}
    </ul>
    {rows === undefined ? <p className={styles.status} role="status">{busy ? "Checking devices…"
      : error ? "" : "This list is out of date. Choose Refresh devices to read it again."}</p>
      : rows.length === 0 ? <div className={styles.emptyList}>
        <p className={styles.emptyTitle}>No phones, TVs or computers yet</p>
        <p className={styles.status}>Choose Add a device to show Cosmos replies on one.</p>
      </div> : null}
    <div className={styles.actions}>
      <button type="button" className={styles.quiet} disabled={busy} onClick={() => void refresh()}>Refresh devices</button>
    </div>
  </section>;
}
