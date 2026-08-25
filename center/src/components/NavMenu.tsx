"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styles from "./shell.module.css";
import { AccountAvatar, ChevronLeft } from "@/icons";

/**
 * NavMenu — the account menu, bottom-right of every page.
 *
 * Recovered component (COMPONENTS.md): original classes were
 * `NavMenu_triggerButton` / `NavMenu_iconWrapper`. It is a <button> (not a bare
 * link) that opens a small dropdown showing the avatar + caret, with account
 * actions. Humane's own docs describe it as "select your profile in the bottom
 * right". The trigger keeps the recovered `account-menu-button` testid + avatar.
 *
 * The exact dropdown item copy ("Account settings") was not preserved in the
 * snapshot, so it is a best-effort label mapped to the recovered "Account" nav
 * group; only the structure (a menu with an account link + sign out) is recovered.
 *
 * This stays an account menu, not a second application navigation.
 */
export function NavMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-away + Escape close. Only listen while open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function signOut() {
    setOpen(false);
    // Full navigation to the RP-initiated logout: the GET handler clears the
    // local session AND redirects through Keycloak's end-session endpoint,
    // terminating the SSO session + refresh grant, then back to /login. A
    // fetch(POST) would only clear local cookies, leaving Keycloak's SSO alive —
    // so a re-login would silently SSO straight back in.
    window.location.href = "/api/auth/logout";
  }

  return (
    <div className={styles.navMenu} ref={rootRef}>
      <button
        type="button"
        className={styles.navMenuTrigger}
        data-testid="account-menu-button"
        aria-label="Account menu"
        aria-controls="account-navigation"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.navMenuIcon}>
          <AccountAvatar size={25} />
        </span>
        <span
          className={`${styles.navMenuCaret} ${open ? styles.navMenuCaretOpen : ""}`}
          aria-hidden
        >
          <ChevronLeft size={14} />
        </span>
      </button>

      {open ? (
        <nav id="account-navigation" className={styles.navMenuDropdown} aria-label="Account">
          <Link
            href="/settings"
            className={styles.navMenuItem}
            onClick={() => setOpen(false)}
          >
            Account settings
          </Link>

          <div className={styles.navMenuGroup}>
            <span className={styles.navMenuGroupHeader} aria-hidden>
              Ai Pin
            </span>
            <Link
              href="/wifi"
              className={styles.navMenuItem}
              onClick={() => setOpen(false)}
            >
              Wi-Fi QR code
            </Link>
          </div>

          <div className={styles.navMenuGroup}>
            <span className={styles.navMenuGroupHeader} aria-hidden>Center</span>
            <Link
              href="/settings/about"
              className={styles.navMenuItem}
              onClick={() => setOpen(false)}
            >
              About this Center
            </Link>
          </div>

          <button
            type="button"
            className={styles.navMenuItem}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </nav>
      ) : null}
    </div>
  );
}
