"use client";

/**
 * The "more tools" menu on the primary card, ported from the retired Setup
 * SPA's `install/components/OverflowMenu.tsx`.
 *
 * One addition: an action containing an `href` renders as a link rather than a
 * button, so the operator-only device shell at /admin/pin/terminal can live in
 * this menu without the menu having to know what a route is.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PrimaryCardActionViewModel } from "@/lib/pin-install";
import styles from "./install.module.css";

export function OverflowMenu({
  actions,
  onAction,
}: {
  actions: readonly PrimaryCardActionViewModel[];
  onAction: (action: PrimaryCardActionViewModel) => void;
}) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerDisabled = actions.every((action) => action.disabled);
  const triggerReason =
    actions.find((action) => action.reason)?.reason ?? undefined;

  const visibleOverflowOpen = overflowOpen && !triggerDisabled;

  useEffect(() => {
    if (!visibleOverflowOpen) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!overflowRef.current?.contains(event.target as Node)) {
        setOverflowOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOverflowOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [visibleOverflowOpen]);

  useEffect(() => {
    if (!visibleOverflowOpen) return undefined;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visibleOverflowOpen]);

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? [],
    );
    if (items.length === 0) return;
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (event.key === "Tab") setOverflowOpen(false);
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  }

  return (
    <div className={styles.overflow} ref={overflowRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.overflowTrigger}
        onClick={() => setOverflowOpen((open) => !open)}
        aria-label="More tools"
        aria-haspopup="menu"
        aria-expanded={visibleOverflowOpen}
        disabled={triggerDisabled}
        title={triggerReason}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm5 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm5 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
            fill="currentColor"
          />
        </svg>
      </button>
      {visibleOverflowOpen ? (
        <div
          ref={menuRef}
          className={styles.overflowMenu}
          role="menu"
          aria-label="More tools"
          onKeyDown={handleMenuKeyDown}
        >
          {actions.map((action) =>
            action.href ? (
              <Link
                key={action.key}
                href={action.href}
                className={styles.overflowItem}
                role="menuitem"
                title={action.reason ?? undefined}
                onClick={() => setOverflowOpen(false)}
              >
                {action.label}
              </Link>
            ) : (
              <button
                key={action.key}
                type="button"
                className={styles.overflowItem}
                onClick={() => {
                  setOverflowOpen(false);
                  onAction(action);
                }}
                disabled={action.disabled}
                title={action.reason ?? undefined}
                role="menuitem"
              >
                {action.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
