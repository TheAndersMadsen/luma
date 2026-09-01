"use client";

/**
 * "Connection Help" — ported from the retired Setup SPA's
 * `install/components/ConnectionHelpModal.tsx`.
 *
 * The retired SPA linked to two removed documentation pages. These links point
 * at the maintained upstream interposer repository instead, while the modal
 * carries the minimum stock-Pin instructions itself.
 */

import { useRef } from "react";
import styles from "./install.module.css";
import { InstallDialog } from "./InstallDialog";

type HelpLink = {
  label: string;
  href: string;
  description?: string;
};

const HELP_LINKS: readonly HelpLink[] = [
  {
    label: "Get or build an interposer",
    href: "https://github.com/PenumbraOS/interposer",
    description: "Maintained hardware options and assembly references.",
  },
  {
    label: "Prepare a stock Pin",
    href: "https://github.com/PenumbraOS/interposer/blob/main/preparation.md",
    description: "Illustrated instructions for exposing the service contacts safely.",
  },
  {
    label: "Computer and browser setup",
    href: "https://github.com/TheAndersMadsen/ai-pin-revival#connect-a-pin",
    description: "USB permissions, supported browsers, installation, and troubleshooting.",
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
          A stock Ai Pin has no exposed USB-C socket. It needs a compatible USB
          interposer connected to the service contacts beneath the small moon sticker.
        </p>
        <p className={styles.dialogCopy}>
          Prepare the contacts with the illustrated guide, align the Pin with the
          interposer outline, and use a known-good USB data cable.
        </p>
        <p className={styles.dialogCopy}>
          Power on and unlock the Pin, then use desktop Chrome or Edge. Close ADB,
          Android Studio, scrcpy, and other tools that may already own the USB interface.
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
