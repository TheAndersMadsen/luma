"use client";

import Link from "next/link";
import { useState } from "react";
import settings from "../settings.module.css";
import styles from "./pin.module.css";
import { StatusChip, StatusMessage } from "@/components/Status";
import { usePinDevice } from "./PinDeviceProvider";

/**
 * Connect a Pin — the entry pane of the device console.
 *
 * This is the USB half of the SPA's ConnectPage. The LAN half is gone with it:
 * mDNS discovery and a manual `http://penumbra.local` address are blocked from
 * an HTTPS origin by both `connect-src 'self'` and mixed-content rules, so that
 * path has never worked from Center. With it goes the Pin admin token that the
 * SPA kept in localStorage — the ADB socket is the authorization boundary and
 * carries no token.
 */

/** What the rest of the console offers once a Pin is attached. */
const CONSOLE_PANES: ReadonlyArray<{ href: string; label: string; desc: string }> = [
  {
    // First on purpose. The panes below are capabilities; this one is the
    // order they go in, which is the part a newcomer cannot infer from a list.
    href: "/settings/pin/setup",
    label: "Guided setup",
    desc: "Follow each step to connect, install, and finish setting up your Pin.",
  },
  {
    href: "/settings/pin/install",
    label: "Install software",
    desc: "Install or remove a verified Revival release.",
  },
  {
    href: "/settings/pin/server",
    label: "Pin server",
    desc: "Display name and local network access.",
  },
  {
    href: "/settings/pin/services",
    label: "Calls & messages",
    desc: "Choose who may call or message this Pin.",
  },
  {
    href: "/settings/pin/esim",
    label: "eSIM & cellular",
    desc: "Manage cellular service and eSIM profiles.",
  },
  {
    href: "/settings/pin/flags",
    label: "Device flags",
    desc: "Advanced behavior for this Pin.",
  },
  {
    href: "/settings/pin/diagnostics",
    label: "Diagnostics & logs",
    desc: "Logs and software diagnostics.",
  },
  {
    href: "/settings/pin/fitness",
    label: "Fitness",
    desc: "Workouts stored on this Pin.",
  },
  {
    href: "/settings/pin/contacts",
    label: "Contacts on the Pin",
    desc: "Contacts stored on this Pin.",
  },
];

export default function ConnectPinPage() {
  const {
    status,
    connectionMode,
    serviceStatus,
    connectionInfo,
    identity,
    device,
    error,
    support,
    connect,
    disconnect,
    clearError,
    refreshService,
  } = usePinDevice();
  const [busy, setBusy] = useState(false);

  const usbConnected = status === "connected";
  const remotelyConnected = connectionMode === "remote" && serviceStatus === "online";
  const connected = usbConnected || remotelyConnected;
  const connecting = status === "connecting";

  async function onConnect() {
    setBusy(true);
    try {
      await connect();
    } catch {
      // The provider has already put the failure in `error`; this catch only
      // stops it becoming an unhandled rejection.
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      await disconnect();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className={settings.section} data-testid="pin-connect">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Your Ai Pin</span>
          <StatusChip
            tone={connected ? "live" : "off"}
            variant="tag"
            label={
              usbConnected
                ? "Connected over USB"
                : remotelyConnected
                  ? "Connected remotely"
                  : connecting
                    ? "Connecting over USB"
                    : connectionMode === "remote"
                      ? "Reconnecting remotely"
                      : "Not connected"
            }
            detail={
              usbConnected
                ? "Connected to this Pin over USB."
                : remotelyConnected
                  ? "Connected securely to your paired Pin."
                  : "Waiting for your paired Pin. Use USB for setup or repair."
            }
          />
        </div>

        {support === null ? (
          <div className={styles.stateRow}>
            <span className={styles.busy}>Checking this browser…</span>
          </div>
        ) : !support.supported && !remotelyConnected ? (
          <div className={styles.stateRow}>
            <StatusMessage tone="warning">
              This browser cannot reach a Pin over USB.
              <ul className={styles.reasons}>
                {support.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </StatusMessage>
          </div>
        ) : null}

        {error ? (
          <div className={styles.stateRow}>
            <StatusMessage
              tone="warning"
              onRetry={
                connectionMode === "remote"
                  ? () => void refreshService()
                  : usbConnected
                    ? undefined
                    : () => void onConnect()
              }
            >
              {error}
            </StatusMessage>
          </div>
        ) : null}

        <div className={styles.row}>
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>
              {usbConnected
                ? "USB maintenance connection"
                : remotelyConnected
                  ? device?.display_name ?? "Paired Pin"
                  : "Remote connection"}
            </span>
            <span className={styles.rowDesc}>
              {usbConnected
                ? "Maintenance actions use this USB connection."
                : remotelyConnected
                  ? "Pin settings are available without a cable."
                  : "Center reconnects automatically. Use USB for setup or repair."}
            </span>
          </span>
          {usbConnected ? (
            <span className={styles.actions}>
              <button
                type="button"
                className={styles.buttonDanger}
                disabled={busy}
                onClick={() => void onDisconnect()}
                data-testid="pin-disconnect"
              >
                Disconnect USB
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={styles.button}
              disabled={busy || connecting || support?.supported === false}
              onClick={() => {
                clearError();
                void onConnect();
              }}
              data-testid="pin-connect-usb"
            >
              {connecting ? "Connecting…" : remotelyConnected ? "USB for maintenance" : "Connect over USB"}
            </button>
          )}
        </div>

        {usbConnected ? (
          <>
            <DeviceRow label="Serial" value={connectionInfo?.serial ?? "—"} mono />
            <DeviceRow label="Device" value={connectionInfo?.name ?? "—"} />
            {identity ? (
              <>
                <DeviceRow
                  label="Model"
                  value={[identity.manufacturer, identity.model].filter(Boolean).join(" ") || "—"}
                />
                {identity.buildFingerprint ? (
                  <DeviceRow label="Build" value={identity.buildFingerprint} mono />
                ) : null}
                {!identity.recognizedAiPin ? (
                  <div className={styles.stateRow}>
                    <StatusMessage tone="warning">
                      This does not look like an Ai Pin. Installing Revival software on another
                      device is not supported and can leave it unusable.
                    </StatusMessage>
                  </div>
                ) : null}
              </>
            ) : (
              <div className={styles.stateRow}>
                <span className={styles.busy}>Reading device identity…</span>
              </div>
            )}
          </>
        ) : null}
      </section>

      {connectionMode !== null ? (
        <section className={settings.section} data-testid="pin-server-state">
          <div className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>Pin software</span>
            <StatusChip
              tone={
                serviceStatus === "online"
                  ? "live"
                  : serviceStatus === "offline"
                    ? "degraded"
                    : "off"
              }
              variant="tag"
              label={
                serviceStatus === "online"
                  ? "Answering"
                  : serviceStatus === "offline"
                    ? "Not answering"
                    : "Checking"
              }
              detail={
                "Whether the Revival service on this Pin is responding."
              }
            />
          </div>

          {serviceStatus === "online" ? (
            <DeviceRow label="Pin name" value={device?.display_name ?? "—"} />
          ) : serviceStatus === "offline" ? (
            <div className={styles.stateRow}>
              <StatusMessage tone="warning" onRetry={() => void refreshService()}>
                {connectionMode === "remote"
                  ? "Your paired Pin is not responding. Center will keep trying."
                  : "The Pin is attached, but Revival is not running. Install or repair it below."}
              </StatusMessage>
            </div>
          ) : (
            <div className={styles.stateRow}>
              <span className={styles.busy}>Checking the Pin&rsquo;s software…</span>
            </div>
          )}

          <div className={styles.row}>
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>Install or repair the software</span>
              <span className={styles.rowDesc}>
                Inspect what is installed and put a verified Revival release on the device.
              </span>
            </span>
            <Link className={settings.additionLink} href="/settings/pin/install">
              Open
            </Link>
          </div>
        </section>
      ) : null}

      <section className={settings.section} data-testid="pin-console-index">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Pin settings</span>
        </div>

        {!connected ? (
          <div className={styles.noteRow}>
            <p className={styles.note}>
              Center loads these settings when your paired Pin is online. Maintenance actions
              will ask for USB when needed.
            </p>
          </div>
        ) : null}

        {CONSOLE_PANES.map((pane) => (
          <div className={styles.row} key={pane.href}>
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{pane.label}</span>
              <span className={styles.rowDesc}>{pane.desc}</span>
            </span>
            <Link className={settings.additionLink} href={pane.href}>
              Open
            </Link>
          </div>
        ))}

      </section>
    </>
  );
}

function DeviceRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{label}</span>
      </span>
      <span className={mono ? `${styles.value} ${styles.mono}` : styles.value}>{value}</span>
    </div>
  );
}
