"use client";

/**
 * The client boundary for the installer.
 *
 * `next/dynamic(..., { ssr: false })` cannot be called from a Server Component
 * in Next 15, so this thin `"use client"` wrapper owns the dynamic import and
 * the page above it stays a server component (which is what lets it read the
 * session cookie to decide whether an operator device-shell link is offered).
 *
 * `ssr: false` is not a performance flourish, it is correctness: the installer
 * reads `globalThis.isSecureContext` and `navigator.usb` while deriving its
 * initial state, and both are absent on the server. Pre-rendering it would
 * commit the markup to "Unsupported Browser" and then hydrate into the opposite
 * answer. Keeping @yume-chan's WebUSB stack out of the server bundle is the
 * secondary benefit.
 */

import dynamic from "next/dynamic";
import styles from "./install.module.css";

const InstallView = dynamic(() => import("./InstallView"), {
  ssr: false,
  loading: () => (
    <div className={styles.card}>
      <p className={styles.loading} role="status">
        Preparing the installer…
      </p>
    </div>
  ),
});

export function InstallPane({ terminalHref }: { terminalHref: string | null }) {
  return <InstallView terminalHref={terminalHref} />;
}
