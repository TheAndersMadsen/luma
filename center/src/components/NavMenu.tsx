"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import styles from "./shell.module.css";
import { AccountAvatar, ChevronLeft } from "@/icons";

/**
 * Is the operator console actually configured on this deployment?
 *
 * `/api/admin/overview` answers **503 and only 503** for "no CARRY_ADMIN_TOKEN on
 * this dashboard" — a build-time fact. A backend that is down comes back 502, a
 * shared secret that disagrees comes back as a proxied 401, and both of those
 * mean the token IS set and something downstream broke. `/admin` has always
 * branched on exactly that split (admin/page.tsx `explainUpstream`); this hook
 * used to collapse every non-ok answer into "not configured", so a momentary
 * outage deleted the Console entry from the nav and made /settings/about state
 * "No CARRY_ADMIN_TOKEN is set" — a false claim about the deployment's own
 * configuration, made at the exact moment an operator is diagnosing the outage.
 *
 * Three answers, because there are three things we can know:
 *
 *   false      503 — this deployment has no admin token. Hide the console.
 *   true       ok, or a failure the BFF itself produced. Advertise it: /admin is
 *              where the real diagnosis lives.
 *   undefined  we learned nothing (request never completed, or the 401 came from
 *              middleware because the session is gone). Callers render nothing.
 *
 * The discriminator for that last case is the provenance header the BFF stamps
 * on every response it produces (`x-data-state`, src/server/headers.ts).
 * Middleware's unauthenticated 401 carries none — and whether this deployment
 * holds an admin token is not that viewer's to be told either way.
 *
 * Lives here because the nav surfaces are what consume it: this menu, the
 * Settings sidebar, and the capability map.
 *
 * `enabled` lets the bottom-right menu — which is on every page — defer the
 * probe until someone actually opens it. The query key is shared, so the
 * Settings sidebar and /settings/about reuse whatever answer is already cached.
 */
export function useConsoleConfigured(enabled = true): boolean | undefined {
  const { data } = useQuery({
    queryKey: ["console-configured"],
    queryFn: async (): Promise<boolean | null> => {
      const res = await fetch("/api/admin/overview", { cache: "no-store" }).catch(() => null);
      // The request never completed — that says nothing about the deployment.
      if (!res) return null;
      // The one answer that means "no admin token here".
      if (res.status === 503) return false;
      if (res.ok) return true;
      // Some other failure. If the BFF route produced it, a token was configured
      // to try with; if it has no provenance header it came from the edge (an
      // expired session), and we do not answer that question for that viewer.
      return res.headers.get("x-data-state") ? true : null;
    },
    enabled,
    retry: false,
    staleTime: 60_000,
  });
  // `null` is "unknown" on the wire; the hook's contract to callers is undefined.
  return data ?? undefined;
}

/** The console link is useful only to a session the server will admit. */
export function useOperatorEntitlement(enabled = true): boolean | undefined {
  const { data } = useQuery({
    queryKey: ["session-entitlement"],
    queryFn: async (): Promise<boolean | null> => {
      const res = await fetch("/api/auth/session", { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return null;
      const body = (await res.json().catch(() => null)) as { operator?: unknown } | null;
      return body?.operator === true;
    },
    enabled,
    retry: false,
    staleTime: 60_000,
  });
  return data ?? undefined;
}

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
 * This stays an account menu, not a second application navigation. Operator
 * tools are separated into a single explicit Console destination.
 */
export function NavMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Only probe once the menu is open. A wearer never calls the operator API.
  const operatorEntitled = useOperatorEntitlement(open);
  const consoleConfigured = useConsoleConfigured(open && operatorEntitled === true);

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

          {/* Hidden only when this deployment has no CARRY_ADMIN_TOKEN (the link
              would land on a "not configured" card) or while the answer is
              unknown. A configured console whose backend is failing KEEPS its
              entry — that page is where the failure gets explained. */}
          {operatorEntitled === true && consoleConfigured === true ? (
            <div className={styles.navMenuGroup}>
              <span className={styles.navMenuGroupHeader} aria-hidden>
                Operator
              </span>
              <Link
                href="/admin"
                className={styles.navMenuItem}
                onClick={() => setOpen(false)}
              >
                Operator Console
              </Link>
            </div>
          ) : null}

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
