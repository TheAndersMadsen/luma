"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ChevronLeft } from "@/icons";
import styles from "./settings.module.css";
import {
  routeIsActive,
  settingsGroupsFor,
  PIN_ADVANCED_GROUP,
  type SettingsRoute,
} from "./settingsRegistry";
import { useOperatorEntitlement } from "./useOperatorEntitlement";

function NavLink({ route }: { route: SettingsRoute }) {
  const pathname = usePathname();
  const selected = routeIsActive(pathname, route);

  return (
    <Link
      href={route.href}
      data-testid={route.testid}
      className={`${styles.navLink} ${selected ? styles.active : ""}`}
      aria-current={selected ? "page" : undefined}
    >
      <span className={styles.linkLabel}>{route.label}</span>
      <span className={styles.arrowIcon}>
        <ChevronLeft size={16} />
      </span>
    </Link>
  );
}

export function SettingsNav() {
  const pathname = usePathname();
  const operator = useOperatorEntitlement();
  const groups = settingsGroupsFor(operator);

  return (
    <nav className={styles.navContainer} aria-label="Settings">
      <Link href="/settings" className={styles.navHome}>All settings</Link>
      {groups.map((group) => group.header === PIN_ADVANCED_GROUP ? (
        <details className={styles.navAdvanced} key={group.header} open={group.routes.some((route) => routeIsActive(pathname, route)) || undefined}>
          <summary>Advanced</summary>
          <div className={styles.groupLinks}>
            {group.routes.map((route) => <NavLink key={route.href} route={route} />)}
          </div>
        </details>
      ) : (
        <div key={group.header} className={styles.group}>
          <span className={styles.categoryHeader}>{group.header}</span>
          <div className={styles.groupLinks}>
            {group.routes.map((route) => <NavLink key={route.href} route={route} />)}
          </div>
        </div>
      ))}
    </nav>
  );
}
