"use client";

/**
 * The modal shell for the install pane's two dialogs — ported from the retired
 * Setup SPA's `components/AppDialog.tsx`, restyled onto install.module.css.
 *
 * Kept local rather than promoted to `@/components`: Center has no dialog
 * primitive yet, and inventing a shared one from a single caller is how design
 * systems acquire APIs nobody wanted. The confirmation dialog in front of a
 * destructive device action is the reason this exists, so its guarantees are
 * spelled out: focus moves to the recommended choice on open, Escape dismisses,
 * body scroll is locked while open, and a click on the backdrop dismisses only
 * when the caller opts in (the confirm dialog does NOT — an accidental click
 * outside must not silently cancel a decision the wearer is in the middle of).
 */

import { useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "@/components/useDialogFocus";
import styles from "./install.module.css";

export function InstallDialog({
  open,
  children,
  role = "dialog",
  labelledBy,
  describedBy,
  initialFocusRef,
  onDismiss,
  closeOnBackdrop = false,
  closeOnEscape = true,
  lockBodyScroll = true,
}: {
  readonly open: boolean;
  readonly children: ReactNode;
  readonly role?: "dialog" | "alertdialog";
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly onDismiss?: () => void;
  readonly closeOnBackdrop?: boolean;
  readonly closeOnEscape?: boolean;
  readonly lockBodyScroll?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus({
    open,
    dialogRef,
    initialFocusRef,
    onDismiss,
    closeOnEscape,
    lockBodyScroll,
  });

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className={styles.overlay}
      data-dialog-overlay
      onClick={(event) => {
        if (
          event.target === event.currentTarget &&
          closeOnBackdrop &&
          onDismiss
        ) {
          onDismiss();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        tabIndex={-1}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
