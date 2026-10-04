"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, SearchIcon } from "@/icons";
import styles from "./settings.module.css";
import { PIN_ADVANCED_GROUP, routeMatchesSearch, settingsGroupsFor, type SettingsGroup } from "./settingsRegistry";
import { useOperatorEntitlement } from "./useOperatorEntitlement";
import { COMMUNITY_DISCORD_URL } from "@/lib/community";
import { useDeviceStatus, usePairedPins } from "@/lib/queries";

function SettingLinks({ group }: { group: SettingsGroup }) {
  return <div>{group.routes.map((route) => (
    <Link className={styles.settingsIndexRow} href={route.href} key={route.href}>
      <span className={styles.additionRowText}>
        <span className={styles.additionRowTitle}>{route.label}</span>
        <span className={styles.additionRowDesc}>{route.description}</span>
      </span>
      <span className={styles.settingsIndexAction} aria-hidden><ChevronLeft size={18} /></span>
    </Link>
  ))}</div>;
}

function PinOverview() {
  const status = useDeviceStatus({ retry: false });
  const pairing = usePairedPins();
  const device = status.data?.devices[0];
  // INFERRED Luma navigation: a saved account pairing or a status report is
  // evidence of an existing Pin, even when it is asleep or temporarily offline.
  // Neither USB attachment nor this card asserts which APKs are installed;
  // the existing software page checks that on the device itself.
  const existingPin = Boolean(device || pairing.data?.devices.length);
  const needsSetup = !existingPin && !status.isError && status.data?.state === "live"
    && !pairing.isError && pairing.data?.devices.length === 0;
  const unreadable = status.isError || status.data?.state === "degraded";
  const online = !unreadable && device && Date.now() / 1000 - device.reported_at_epoch < 600;
  const detail = status.isPending ? "Checking your Pin…" : unreadable ? "Status unavailable. Your pairing is unchanged."
    : device ? `${online ? "Online" : "Last reported"} · ${Math.round(device.battery_percent)}% battery${device.battery_charging ? " · Charging" : ""}`
      : "Battery, connection and your paired Pins.";
  return (
    <div className={styles.pinOverview}>
      <Link href="/settings/account/devices" className={styles.pinOverviewLink}>
        <span className={styles.pinArtwork} aria-hidden><span /></span>
        <span className={styles.pinOverviewText}>
          <strong>My Ai Pin</strong>
          <span><i className={online ? styles.onlineDot : styles.neutralDot} aria-hidden />{detail}</span>
          <small>Manage your Pin <span aria-hidden>→</span></small>
        </span>
      </Link>
      <div className={styles.setupShortcut}>
        {needsSetup ? <>
          <strong>A little help getting started?</strong>
          <span>Connect your Pin. We’ll guide you through the rest.</span>
          <Link href="/settings/pin/setup">Set up a Pin <span aria-hidden>→</span></Link>
        </> : <>
          <strong>{existingPin ? "Keep your Pin running smoothly" : "Need a hand with your Pin?"}</strong>
          <span>Check your software or get help with a connection or playback issue.</span>
          <Link href="/settings/pin/install">Software & updates <span aria-hidden>→</span></Link>
          <Link href="/settings/pin/diagnostics">Help & diagnostics <span aria-hidden>→</span></Link>
          <a href={COMMUNITY_DISCORD_URL} target="_blank" rel="noopener noreferrer">Ask the community on Discord <span aria-hidden>→</span></a>
        </>}
      </div>
    </div>
  );
}

export function SettingsIndex() {
  const searchId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const operator = useOperatorEntitlement();
  const searching = query.trim().length > 0;
  const visibleGroups = useMemo(() => settingsGroupsFor(operator).map((group) => ({
    ...group,
    routes: group.routes.filter((route) => routeMatchesSearch(route, query) &&
      (searching || !["/settings/account/devices", "/settings/pin/setup"].includes(route.href))),
  })).filter((group) => group.routes.length > 0), [operator, query, searching]);

  function clearSearch() { setQuery(""); input.current?.focus(); }

  return (
    <>
      <div className={styles.settingsWelcome}>
        <p>Make your Pin feel like yours.</p>
        <div className={styles.settingsSearch} role="search">
          <label className={styles.srOnly} htmlFor={searchId}>Search settings</label>
          <SearchIcon size={18} />
          <input ref={input} id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a setting" autoComplete="off" />
          {query ? <button type="button" onClick={clearSearch} aria-label="Clear search">×</button> : null}
        </div>
      </div>
      {!searching ? <PinOverview /> : <p className={styles.searchCaption}>Results for “{query.trim()}”</p>}
      {visibleGroups.length === 0 ? (
        <div className={styles.settingsNoResults}>
          <p role="status">No settings match “{query.trim()}”. Try a different word, like music, Wi-Fi or passcode.</p>
        </div>
      ) : (
        <div className={styles.settingsGrid}>
          {visibleGroups.map((group) => group.header === PIN_ADVANCED_GROUP && !searching ? (
            <details className={styles.advancedSettings} key={group.header}>
              <summary><span><strong>Advanced</strong><small>{group.description}</small></span><span className={styles.disclosureMark} aria-hidden>+</span></summary>
              <SettingLinks group={group} />
            </details>
          ) : (
            <section className={styles.settingsCategory} key={group.header} aria-label={group.header}>
              <div className={styles.categoryIntro}><h2>{group.header}</h2><p>{group.description}</p></div>
              <SettingLinks group={group} />
            </section>
          ))}
        </div>
      )}
    </>
  );
}
