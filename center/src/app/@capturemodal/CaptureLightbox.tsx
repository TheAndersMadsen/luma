"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { CaptureDetailBody } from "@/app/captures/CaptureDetail";
import { useDialogFocus } from "@/components/useDialogFocus";
import styles from "@/components/captureDetail.module.css";

/**
 * The lightbox shell for the @capturemodal intercepting route.
 *
 * A dialog OVER the grid. Escape, a backdrop click, or the close ✕ inside the
 * body all dismiss via router.back(), which unwinds the interception and returns
 * to the grid underneath. The detail itself is the shared <CaptureDetailBody>, so
 * the modal and the /captures/[id] full page render an identical capture.
 */
export function CaptureLightbox({ uuid }: { uuid: string }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);

  const dismiss = useCallback(() => {
    if (closingRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      router.back();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(() => router.back(), 200);
  }, [router]);

  useDialogFocus({ open: true, dialogRef, onDismiss: dismiss });

  useEffect(() => {
    document.body.dataset.captureOpen = "true";
    return () => {
      delete document.body.dataset.captureOpen;
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`${styles.backdrop} ${closing ? styles.backdropClosing : ""}`}
      data-dialog-overlay
      role="dialog"
      aria-modal="true"
      aria-label="Capture"
      onMouseDown={(e) => {
        // Only a click on the backdrop itself dismisses, not a drag that starts
        // inside the dialog and releases on the backdrop.
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div ref={dialogRef} className={styles.dialog} tabIndex={-1}>
        <CaptureDetailBody uuid={uuid} mode="modal" />
      </div>
    </div>,
    document.body,
  );
}
