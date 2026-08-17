"use client";

/**
 * "Connection Help" — ported from the retired Setup SPA's
 * `install/components/ConnectionHelpModal.tsx`.
 *
 * The SPA's two links pointed at `/getting-started/*`, which are PenumbraOS
 * documentation paths that resolve to nothing on Center's origin. They are kept
 * as absolute PenumbraOS documentation URLs so the copy is not a dead end; the
 * SPA's own `TODO: replace placeholder hrefs with real documentation URLs`
 * therefore survives as a follow-up rather than as a broken same-origin link.
 */

import { useRef } from "react";
import styles from "./install.module.css";
import { InstallDialog } from "./InstallDialog";

type HelpLink = {
  label: string;
  href: string;
  description?: string;
};

// TODO: replace with the project's own documentation URLs once they exist.
const HELP_LINKS: readonly HelpLink[] = [
  {
    label: "Setting up the interposer",
    href: "https://penumbraos.github.io/getting-started/interposer/",
    description: "Interposer setup and connection.",
  },
  {
    label: "Sticker removal",
    href: "https://penumbraos.github.io/getting-started/sticker-removal/",
    description: "Remove the bottom sticker safely.",
  },
];

export function ConnectionHelpModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <InstallDialog
      open={open}
      labelledBy="install-help-title"
      describedBy="install-help-copy"
      initialFocusRef={closeButtonRef}
      onDismiss={onClose}
      closeOnBackdrop
      closeOnEscape
      lockBodyScroll
    >
      <div className={styles.dialogHeader}>
        <h2 id="install-help-title" className={styles.dialogTitle}>
          Connecting to Ai Pin
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          className={styles.dialogClose}
          onClick={onClose}
          aria-label="Close"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div className={styles.orientationGuide} role="img" aria-label="Ai Pin aligned over a USB interposer">
        <div className={styles.orientationPin}>
          <span className={styles.orientationMark} aria-hidden />
          <span>Ai Pin</span>
        </div>
        <div className={styles.orientationConnector} aria-hidden />
        <div className={styles.orientationCable} aria-hidden />
        <span className={styles.orientationLabel}>Align with the interposer outline</span>
      </div>

      <div id="install-help-copy" className={styles.helpBody}>
        <p className={styles.dialogCopy}>
          Remove the bottom sticker, align the Pin with the interposer, and connect USB.
        </p>
        <p className={styles.dialogCopy}>
          Use desktop Chrome or Edge. If the Pin is not detected, check the guides below.
        </p>
        <p className={styles.dialogCopy}>
          Close other tools that may be using the Pin.
        </p>
      </div>

      <ul className={styles.helpLinks}>
        {HELP_LINKS.map((link) => (
          <li key={link.label} className={styles.helpLinkItem}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.helpLink}
            >
              {link.label}
            </a>
            {link.description ? (
              <span className={styles.helpLinkDescription}>{link.description}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </InstallDialog>
  );
}
