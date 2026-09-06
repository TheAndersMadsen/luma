"use client";

import { useEffect, useRef, useState } from "react";
import { StatusChip, Switch } from "@/components/Status";
import { SurfaceTab, type TabStatus } from "./surfaceTab";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import { BrowserRuntime } from "@/lib/browserRuntime";
import { CommittedCard } from "@/components/BrowserDisplay";
import type { RenderCommand } from "@/lib/contracts/ambianceRuntime";

const DETAIL: Record<TabStatus, string> = {
  inactive: "Off. Turn it on to show shared replies in this tab for one hour.",
  approving: "Waiting for Cosmos…",
  pending: "Waiting for Cosmos to confirm this tab…",
  visible: "On. Cosmos can show shared reply cards here. It cannot tell who is looking at this screen.",
  hidden: "On, but this tab is in the background. Bring it to the front to show replies.",
  lost: "The connection was lost. Turn it on again to reconnect.",
  expired: "The one-hour connection expired. Turn it on again to reconnect.",
};
const ON: readonly TabStatus[] = ["approving", "pending", "visible", "hidden"];
const status = (tab: TabStatus) => tab === "visible" ? "Connected" : tab === "hidden" ? "Connected · app in background" : "Not connected";

/** This tab as a shared display: one memory-only, one-hour capability that ends when the tab goes away. */
export function BrowserCard() {
  const [tabStatus, setTabStatus] = useState<TabStatus>("inactive");
  const [confirming, setConfirming] = useState(false);
  const [command, setCommand] = useState<RenderCommand | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState("");
  const tab = useRef<SurfaceTab | null>(null);
  useEffect(() => {
    const runtime = new BrowserRuntime(crypto.randomUUID(), setCommand, setRuntimeStatus);
    const current = new SurfaceTab(setTabStatus, () => {}, runtime);
    tab.current = current;
    const visibility = () => current.visibility(document.visibilityState === "visible");
    const pagehide = () => current.leave();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      current.dispose(); tab.current = null;
    };
  }, []);
  const on = ON.includes(tabStatus);
  return <section className={`${settings.section} ${styles.card}`} aria-label="This browser">
    <div className={styles.cardHeader}>
      <h2 className={styles.cardTitle}>This browser</h2>
      <StatusChip tone={tabStatus === "visible" || tabStatus === "hidden" ? "live" : "off"} label={status(tabStatus)} />
    </div>
    <p className={styles.line}>Shows shared replies while this tab is open.</p>
    <div className={styles.switchRow} role="group" aria-label="Use this browser as a display">
      <div className={styles.switchText}>
        <span className={styles.switchTitle}>Use this browser as a display</span>
        <span className={styles.switchDescription} role="status">{DETAIL[tabStatus]}</span>
      </div>
      <Switch checked={on} disabled={tabStatus === "approving"} ariaLabel="Use this browser as a display"
        onChange={next => { if (next) setConfirming(true); else { setConfirming(false); tab.current?.leave(); } }} />
    </div>
    {confirming ? <div className={styles.confirm} role="group" aria-label="Confirm shared display">
      <p className={styles.line}>This tab may be seen by other people. Show shared replies here for one hour? Leaving this page ends it.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => { setConfirming(false); void tab.current?.approve(); }}>Turn on</button>
        <button type="button" className={styles.quiet} onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </div> : null}
    {(tabStatus === "visible" || tabStatus === "lost") && runtimeStatus ? <p className={styles.line} role="status">{runtimeStatus}</p> : null}
    <CommittedCard command={tabStatus === "visible" ? command : null} runtime={tab.current?.runtime} />
  </section>;
}
