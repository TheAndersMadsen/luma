"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import styles from "./shell.module.css";
import { HumaneLogo, ChevronLeft, AiMicIcon } from "@/icons";
import { NavMenu } from "./NavMenu";
import { SourceBadge } from "./Status";
import { useFloatingAssistant } from "./FloatingAssistant";
import { UpdateBanner } from "./UpdateBanner";

/** The four tabs. Memories is the root route, not /memories. */
export const EXPERIENCE_TABS = [
  { label: "Memories", href: "/" },
  { label: "Captures", href: "/captures" },
  { label: "Notes", href: "/notes" },
  { label: "My Data", href: "/my-data" },
] as const;

function ExperienceNav() {
  const pathname = usePathname();
  /**
   * Which tab the current route belongs to, or NONE.
   *
   * There is deliberately no fallback. A route that is not one of the four tabs
   * is not "Memories": /talk used to paint the Memories tab `aria-selected`, tell
   * a screen-reader user they were on Memories, and label the mobile activator
   * "Memories" while the page heading said "Ai Mic", on a phone that activator
   * is the ONLY location indicator on screen. Memories IS the root route, so it
   * matches "/" exactly and nothing else. The other three match their own segment
   * (`/notes`, `/notes/…`) rather than any path merely starting with the string.
   */
  const active =
    pathname === "/"
      ? EXPERIENCE_TABS[0]
      : EXPERIENCE_TABS.filter(
          (t) => t.href !== "/" && (pathname === t.href || pathname.startsWith(`${t.href}/`)),
        ).at(0);

  // Below 1071px the desktop pill row is hidden and only the activator shows, so
  // it MUST reveal the tabs, otherwise the four sections are unreachable on
  // phones/tablets. Opens a dropdown of the tabs plus the recovered "Menu" entry.
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Close on navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className={styles.experienceNavContainer} data-testid="toolbar-nav" ref={rootRef}>
      <div className={styles.desktopExperienceNavContainer}>
        <div className={styles.surface}>
          <nav className={styles.tabList} aria-label="Center">
            {EXPERIENCE_TABS.map((tab) => {
              const selected = tab.label === active?.label;
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={selected ? "page" : undefined}
                  className={`${styles.tabLink} ${selected ? styles.tabLinkSelected : ""}`}
                >
                  <span>
                    <span>{tab.label}</span>
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      <button
        ref={triggerRef}
        className={styles.menuActivator}
        data-testid="mobile-experience-nav-activator"
        aria-label={`${active?.label ?? "Menu"}, open navigation`}
        aria-controls="mobile-center-navigation"
        aria-expanded={open}
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        {/* On a route that is not one of the four tabs there is no section to
            name, so the activator says what it opens instead of claiming a
            location the user is not at. */}
        {active?.label ?? "Menu"}
        <span className={`${styles.caretContainer} ${open ? styles.caretContainerOpen : ""}`}>
          <ChevronLeft size={16} />
        </span>
      </button>

      {open ? (
        <nav id="mobile-center-navigation" className={styles.mobileNav} aria-label="Center">
          {EXPERIENCE_TABS.map((tab) => {
            const selected = tab.label === active?.label;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={selected ? "page" : undefined}
                className={`${styles.mobileNavItem} ${selected ? styles.mobileNavItemActive : ""}`}
                onClick={() => setOpen(false)}
              >
                {tab.label}
              </Link>
            );
          })}
          {/* Recovered 5th entry: "Menu" → the account / settings section. */}
          <Link
            href="/settings"
            className={styles.mobileNavItem}
            onClick={() => setOpen(false)}
          >
            Menu
          </Link>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * The app chrome.
 *
 * The original rendered TWO headers: the "system" one pinned to the BOTTOM of the
 * viewport (Humane logo bottom-left, account menu bottom-right, Humane's own docs
 * say "select your profile in the bottom right"), and the "top nav" one containing the
 * pill navigation and any page action.
 */
export function Shell({
  children,
  toolbarLeft,
  toolbarRight,
  showNav = true,
  showAiMic = true,
  showTopBar = true,
  showAccountMenu = true,
}: {
  children: React.ReactNode;
  toolbarLeft?: React.ReactNode;
  toolbarRight?: React.ReactNode;
  showNav?: boolean;
  /** Settings and operator workspaces provide their own header. */
  showTopBar?: boolean;
  /** Public utilities do not expose signed-in account actions. */
  showAccountMenu?: boolean;
  /**
   * Set false on a page that IS the Ai Mic so the system row does not link back
   * to the page the wearer is already using.
   */
  showAiMic?: boolean;
}) {
  const { open: assistantOpen, openAssistant } = useFloatingAssistant();

  return (
    <>
      {/* top nav row */}
      {showTopBar ? (
        <div className={styles.toolbarAndSpacerContainer}>
          <header className={styles.toolbarContainerTopNav}>
            <div className={styles.left} data-testid="top-toolbar-left">{toolbarLeft}</div>
            <div className={styles.center} data-testid="top-toolbar-middle">
              {showNav ? <ExperienceNav /> : null}
            </div>
            <div className={styles.right} data-testid="top-toolbar-right">
              {showNav ? <span className={styles.sourceStatus}><SourceBadge /></span> : null}
              {toolbarRight}
            </div>
          </header>
          <div className={styles.toolBarContainerTopNavSpacer} />
        </div>
      ) : null}

      <main className={styles.main}>
        {/* Signed-in chrome only. The banner itself shows for the operator alone. */}
        {showAccountMenu ? <UpdateBanner /> : null}
        {children}
      </main>

      {/* system row, pinned bottom. Canonical testid is `footer-nav`. The
          bottom bar no longer borrows the top-toolbar-* testids (those belong to
          the top nav only). */}
      <footer className={styles.systemToolbar} id="footer-nav" data-testid="footer-nav">
        <div className={styles.left}>
          <Link href="/" className={styles.homeLink} id="humane-logo" data-testid="humane-logo" aria-label="Humane Center home">
            <HumaneLogo size={24} />
          </Link>
        </div>
        {/* One launcher for the route-persistent assistant mounted by Providers. */}
        <div className={styles.center}>
          {showAiMic ? (
            <button
              type="button"
              className={`${styles.aiMicButton} ${assistantOpen ? styles.aiMicButtonActive : ""}`}
              aria-controls="ai-pin-assistant"
              aria-expanded={assistantOpen}
              onClick={(event) => openAssistant(event.currentTarget)}
            >
              <AiMicIcon size={15} />
              Ai Mic
            </button>
          ) : null}
        </div>
        <div className={styles.right}>
          {/* NavMenu, Humane's own docs: "select your profile in the bottom
              right". The recovered component is a dropdown (Account settings /
              Sign out), not a bare link. */}
          {showAccountMenu ? <NavMenu /> : null}
        </div>
      </footer>

      <div role="region" aria-label="Notifications (F8)">
        <ol style={{ listStyle: "none", margin: 0, padding: 0, position: "fixed" }} />
      </div>
    </>
  );
}
