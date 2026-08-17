"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import styles from "./terminal.module.css";
import { StatusChip, StatusMessage } from "@/components/Status";
import { getBrowserSupport, type BrowserSupportResult } from "@/lib/pin-device/adb";
import { connectPinAdbSession, disconnectPinAdbSession, usePinAdbSession } from "@/lib/pin-session";

/*
 * The client half of /admin/pin/terminal.
 *
 * `next/dynamic(..., { ssr: false })` cannot be called from a Server Component
 * in Next 15, which is why this file exists between page.tsx and the xterm
 * surface. It also keeps xterm out of the payload until a Pin is actually
 * attached: the shell cannot exist without a device session, so there is
 * nothing to download before one.
 *
 * There is no PinDeviceProvider out here — that provider lives in the
 * /settings/pin layout, and this route deliberately sits outside it. The shared
 * WebUSB handle is module-scoped in @/lib/pin-session, so a device connected on
 * the install pane is the same device here, and connecting here shows up there.
 */

const DeviceTerminal = dynamic(() => import("./DeviceTerminal"), {
  ssr: false,
  loading: () => (
    <div className={styles.body}>
      <p className={styles.note}>Loading the terminal…</p>
    </div>
  ),
});

export function TerminalPane() {
  const session = usePinAdbSession();
  const [busy, setBusy] = useState(false);
  /*
   * WebUSB support reads `isSecureContext` and `navigator`, neither of which
   * exists during SSR. Resolve it after mount so the server and first client
   * render agree instead of hydrating a "not supported" panel away.
   */
  const [support, setSupport] = useState<BrowserSupportResult | null>(null);

  useEffect(() => {
    setSupport(getBrowserSupport());
  }, []);

  const connected = session.status === "connected";
  const connecting = session.status === "connecting";

  async function onConnect() {
    setBusy(true);
    try {
      await connectPinAdbSession();
    } catch {
      // The shared session store already carries the failure in `session.error`.
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      await disconnectPinAdbSession();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.title}>Device shell</span>
          <span className={styles.subtitle}>
            An interactive root shell on the attached Ai Pin, over the same USB session the
            installer uses. Operators only.
          </span>
        </div>
        <Link className={styles.link} href="/settings/pin/install">
          Back to Install software
        </Link>
      </header>

      <p className={styles.warning}>
        Everything typed here runs as root on the wearer&rsquo;s device, immediately and with no
        confirmation. It is here for an install that failed mid-bootstrap — every routine
        operation has a pane of its own under Pin console.
      </p>

      <section className={styles.panel} data-testid="pin-terminal">
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>USB session</span>
          <StatusChip
            tone={connected ? "live" : "off"}
            variant="tag"
            label={connected ? "Connected" : connecting ? "Connecting" : "Not connected"}
            detail={
              connected
                ? "This browser holds an authorized ADB session to the Pin."
                : "Plug the Pin in and choose it in the browser's device picker."
            }
          />
        </div>

        <div className={styles.body}>
          {support && !support.supported ? (
            <>
              <p className={styles.note}>
                This browser cannot open a device session, so the shell is unavailable here.
              </p>
              <ul className={styles.reasons}>
                {support.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className={styles.note}>
                {connected
                  ? "The shell below is attached to this session. Disconnecting ends it."
                  : "Connect a Pin over USB to open a shell on it."}
              </p>
              <div className={styles.actions}>
                {connected ? (
                  <button
                    type="button"
                    className={styles.buttonDanger}
                    disabled={busy}
                    onClick={() => {
                      void onDisconnect();
                    }}
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={busy || connecting || support === null}
                    onClick={() => {
                      void onConnect();
                    }}
                  >
                    {connecting ? "Connecting…" : "Connect over USB"}
                  </button>
                )}
              </div>
            </>
          )}

          {session.error ? (
            <StatusMessage tone="warning">{session.error}</StatusMessage>
          ) : null}
        </div>
      </section>

      {connected ? (
        <section className={styles.panel}>
          <DeviceTerminal />
        </section>
      ) : null}
    </div>
  );
}
