"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ChevronLeft } from "@/icons";
import styles from "./settings.module.css";
import {
  routeIsActive,
  settingsGroupsFor,
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
  const operator = useOperatorEntitlement();
  const groups = settingsGroupsFor(operator);

  return (
    <nav className={styles.navContainer} aria-label="Settings">
      {groups.map((group) => (
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
