"use client";

import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/Status";
import { BrowserRuntime } from "@/lib/browserRuntime";
import { NO_STATUS, type StatusLine } from "@/lib/turnOutcome";
import type { RenderCommand, RoutingTarget } from "@/lib/contracts/ambianceRuntime";
import styles from "./surfaces.module.css";
import { SurfaceTab, type TabStatus } from "./surfaceTab";

export const TAB_DETAIL: Record<TabStatus, string> = {
  inactive: "Off. Turn it on to show shared replies in this tab for one hour.",
  approving: "Connecting…",
  pending: "Connecting…",
  visible: "On. Cosmos can show shared reply cards here. It cannot tell who is looking at this screen.",
  hidden: "On, but this tab is in the background. Bring it to the front to show replies.",
  lost: "The connection was lost. Turn it on again to reconnect.",
  expired: "The hour is up. Turn it on again to reconnect.",
};
const ON: readonly TabStatus[] = ["approving", "pending", "visible", "hidden"];

/** This tab as a shared display: one memory-only, one-hour capability that ends when the tab goes away or `active` turns false. */
export function useSurfaceTab(active = true) {
  const [tabStatus, setTabStatus] = useState<TabStatus>("inactive");
  const [command, setCommand] = useState<RenderCommand | null>(null);
  const [status, setStatus] = useState<StatusLine>(NO_STATUS);
  const tab = useRef<SurfaceTab | null>(null);
  const isActive = useRef(active); isActive.current = active;
  useEffect(() => {
    const runtime = new BrowserRuntime(crypto.randomUUID(), setCommand, setStatus);
    const current = new SurfaceTab(setTabStatus, () => {}, runtime); tab.current = current;
    const visibility = () => current.visibility(isActive.current && document.visibilityState === "visible");
    const pagehide = () => current.leave();
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", pagehide);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pagehide); current.dispose(); tab.current = null; };
  }, []);
  useEffect(() => { if (!active) tab.current?.leave(); }, [active]);
  return {
    tabStatus, command, status, on: ON.includes(tabStatus),
    runtime: tab.current?.runtime,
    approve() { void tab.current?.approve(); },
    leave() { tab.current?.leave(); },
    cancel() { void tab.current?.runtime.cancel(); },
    /** Resolves when Cosmos has admitted the request or refused it, so the composer can stay disabled until then. */
    input(text: string, target?: RoutingTarget) { return tab.current?.runtime.input(text, target) ?? Promise.resolve(); },
  };
}

type Props = {
  title: string;
  tabStatus: TabStatus;
  on: boolean;
  /** True while turning on is impossible; turning off stays possible. */
  disabled?: boolean;
  onApprove(): void;
  onLeave(): void;
};

/** One switch that asks first: this tab may be seen by other people, and Cosmos cannot tell who. */
export function TabSwitch({ title, tabStatus, on, disabled = false, onApprove, onLeave }: Props) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (on) setConfirming(false); }, [on]);
  return <>
    <div className={styles.switchRow} role="group" aria-label={title}>
      <div className={styles.switchText}>
        <span className={styles.switchTitle}>{title}</span>
        <span className={styles.switchDescription} role="status">{TAB_DETAIL[tabStatus]}</span>
      </div>
      <Switch checked={on} disabled={tabStatus === "approving" || (!on && disabled)} ariaLabel={title}
        onChange={next => { if (next) setConfirming(true); else { setConfirming(false); onLeave(); } }} />
    </div>
    {confirming ? <div className={styles.confirm} role="group" aria-label="Confirm shared display">
      <p className={styles.line}>This tab may be seen by other people. Show shared replies here for one hour? Leaving this page ends it.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => { setConfirming(false); onApprove(); }}>Turn on</button>
        <button type="button" className={styles.quiet} onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </div> : null}
  </>;
}
