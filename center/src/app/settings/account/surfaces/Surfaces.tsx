"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseSurface, record, type Surface } from "@/lib/contracts/surfaces";
import { SurfaceTab, type TabStatus } from "./surfaceTab";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import { BrowserRuntime } from "@/lib/browserRuntime";
import { CommittedCard } from "@/components/BrowserDisplay";
import type { RenderCommand } from "@/lib/contracts/ambianceRuntime";

const STATUS: Record<TabStatus, string> = {
  inactive: "This tab is not connected. If a leave request cannot reach Cosmos, availability expires 45 seconds after the last state update Cosmos accepts.",
  approving: "Waiting for Cosmos to commit approval…",
  pending: "Waiting for Cosmos to confirm this tab’s availability…",
  visible: "Cosmos confirmed this shared tab visible. It can receive public text cards.",
  hidden: "Cosmos confirmed this tab hidden and unavailable.",
  lost: "Connection could not be confirmed. This tab stopped reporting; availability expires 45 seconds after the last state update Cosmos accepts. Approve again to reconnect.",
  expired: "The one-hour connection expired. Approve again to reconnect.",
};

export function Surfaces() {
  const [status, setStatus] = useState<TabStatus>("inactive");
  const [rows, setRows] = useState<Surface[] | null>(null);
  const [listError, setListError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<RenderCommand | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState("");
  const tab = useRef<SurfaceTab | null>(null);
  const listGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++listGeneration.current;
    try {
      const response = await fetch("/api/surfaces", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("list_failed");
      const body = record(await response.json());
      if (!Array.isArray(body.surfaces) || body.surfaces.length > 16) throw new Error("invalid_list");
      const surfaces = body.surfaces.map(parseSurface);
      if (generation === listGeneration.current) { setRows(surfaces); setListError(false); }
    } catch { if (generation === listGeneration.current) setListError(true); }
  }, []);
  useEffect(() => {
    const runtime = new BrowserRuntime(crypto.randomUUID(), setCommand, setRuntimeStatus);
    const current = new SurfaceTab(setStatus, () => { void refresh(); }, runtime);
    tab.current = current;
    const visibility = () => current.visibility(document.visibilityState === "visible");
    const pagehide = () => current.leave();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    void refresh();
    return () => {
      listGeneration.current++;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      current.dispose(); tab.current = null;
    };
  }, [refresh]);
  async function revoke(surfaceId: string) {
    setBusy(true); setMutationError(false);
    if (surfaceId === tab.current?.surfaceId) tab.current.leave();
    try {
      const response = await fetch(`/api/surfaces/${surfaceId}`, { method: "DELETE", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("revoke_failed");
      setRevoking(null); await refresh();
    } catch { setMutationError(true); }
    finally { setBusy(false); }
  }
  return <>
    <section className={`${settings.section} ${styles.card}`}>
      <h2>Use this tab as a shared display</h2>
      <p>Approve a visible browser page, not a private screen. Cosmos cannot tell who is in the room. Trust stays at level 0; this approval grants no autonomous actions.</p>
      <p>Approval enables public text requests and public text cards. Private memories, speech and device actions are unavailable in this tab.</p>
      <p role="status">{STATUS[status]}</p>
      {confirming ? <div role="group" aria-label="Approve shared display">
        <p>This display may be seen by other people. Approve public text input and public replies for one hour? Leaving this page clears the display.</p>
        <button onClick={() => { setConfirming(false); void tab.current?.approve(); }}>Confirm shared display</button>
        <button onClick={() => setConfirming(false)}>Cancel</button>
      </div> : <button disabled={status === "approving"} onClick={() => setConfirming(true)}>Approve this tab</button>}
      <button onClick={() => { setConfirming(false); tab.current?.leave(); }}>Leave this tab</button>
      {(status === "visible" || status === "lost") && <p role="status">{runtimeStatus}</p>}
      <CommittedCard command={status === "visible" ? command : null} runtime={tab.current?.runtime} />
    </section>
    <section className={`${settings.section} ${styles.card}`}>
      <h2>Approved browser displays</h2>
      <p>This is an approval list, not proof of current delivery or privacy. Refresh to read the latest connection state.</p>
      <button onClick={() => void refresh()}>Refresh list</button>
      {listError ? <p role="alert">The list could not be read. Existing approvals are unchanged.</p> : rows === null ? <p>Loading approvals…</p> : rows.length === 0 ? <p>No approved displays.</p> : <ul>
        {rows.map((surface, index) => <li key={surface.surfaceId}>
          <strong>{surface.surfaceId === tab.current?.surfaceId ? "This tab" : `Browser display ${index + 1}`}</strong>
          <p>Shared display · room unknown · rendering not verified</p>
          {!surface.manifest.authority.mayOriginate.some(value => value === "user.request") && <p>Output-only approval. Explicit reapproval is required for public text input.</p>}
          <p>{surface.connected && surface.leaseExpiresAt > Date.now() && surface.connectionExpiresAt > Date.now() ? "Connection reported at last refresh" : "Disconnected at last refresh"}</p>
          {revoking === surface.surfaceId ? <div>
            <p>Revoke this display’s approval and connection?</p>
            <button disabled={busy} onClick={() => void revoke(surface.surfaceId)}>Confirm revoke</button>
            <button disabled={busy} onClick={() => setRevoking(null)}>Cancel revoke</button>
          </div> : <button onClick={() => { setMutationError(false); setRevoking(surface.surfaceId); }}>Revoke {surface.surfaceId === tab.current?.surfaceId ? "this tab" : `display ${index + 1}`}</button>}
        </li>)}
      </ul>}
      {mutationError && <p role="alert">Revocation could not be confirmed. Refresh and retry.</p>}
    </section>
  </>;
}
