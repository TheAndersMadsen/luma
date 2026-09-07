"use client";

import { StatusChip } from "@/components/Status";
import { CommittedCard } from "@/components/BrowserDisplay";
import { statusText } from "@/lib/turnOutcome";
import settings from "../../settings.module.css";
import styles from "./surfaces.module.css";
import type { TabStatus } from "./surfaceTab";
import { TabSwitch, useSurfaceTab } from "./TabDisplay";

const status = (tab: TabStatus) => tab === "visible" ? "Connected" : tab === "hidden" ? "Connected · in the background" : "Offline";

/** This tab as a shared display: one memory-only, one-hour capability that ends when the tab goes away. */
export function BrowserCard() {
  const tab = useSurfaceTab();
  const line = statusText(tab.status);
  return <section className={`${settings.section} ${styles.card}`} aria-label="This browser">
    <div className={styles.cardHeader}>
      <h2 className={styles.cardTitle}>This browser</h2>
      <StatusChip tone={tab.tabStatus === "visible" || tab.tabStatus === "hidden" ? "live" : "off"} label={status(tab.tabStatus)} />
    </div>
    <p className={styles.line}>Shows shared replies while this tab is open.</p>
    <TabSwitch title="Use this browser as a display" tabStatus={tab.tabStatus} on={tab.on} onApprove={tab.approve} onLeave={tab.leave} />
    {(tab.tabStatus === "visible" || tab.tabStatus === "lost") && line ? <p className={styles.line} role="status">{line}</p> : null}
    <CommittedCard command={tab.tabStatus === "visible" ? tab.command : null} runtime={tab.runtime}
      onChoose={tab.tabStatus === "visible" ? text => void tab.input(text) : undefined} />
  </section>;
}
