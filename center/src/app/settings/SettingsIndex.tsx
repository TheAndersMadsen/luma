"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { SearchIcon } from "@/icons";
import styles from "./settings.module.css";
import { SETTINGS_GROUPS, routeMatchesSearch } from "./settingsRegistry";

export function SettingsIndex() {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const visibleGroups = useMemo(
    () =>
      SETTINGS_GROUPS.map((group) => ({
        ...group,
        routes: group.routes.filter((route) => routeMatchesSearch(route, query)),
      })).filter((group) => group.routes.length > 0),
    [query],
  );

  return (
    <>
      <div className={styles.settingsSearch} role="search">
        <label className={styles.srOnly} htmlFor={searchId}>Search settings</label>
        <SearchIcon size={18} />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search settings"
          autoComplete="off"
        />
      </div>

      {visibleGroups.length === 0 ? (
        <p className={styles.settingsNoResults} role="status">
          No settings match “{query.trim()}”.
        </p>
      ) : (
        visibleGroups.map((group) => (
          <section className={styles.section} key={group.header}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>{group.header}</h2>
            </div>
            <div>
              {group.routes.map((route) => (
                <Link className={styles.settingsIndexRow} href={route.href} key={route.href}>
                  <span className={styles.additionRowText}>
                    <span className={styles.additionRowTitle}>{route.label}</span>
                    <span className={styles.additionRowDesc}>{route.description}</span>
                  </span>
                  <span className={styles.settingsIndexAction} aria-hidden>Open</span>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}
