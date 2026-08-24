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
    desc: "Display name, local access, and assistant instructions.",
  },
  {
    href: "/settings/pin/llm",
    label: "Assistant",
    desc: "Choose the service that answers on this Pin.",
  },
  {
    href: "/settings/pin/services",
    label: "Service keys",
    desc: "Maps, places, speech and units — the third-party keys the Pin uses directly.",
  },
  {
    href: "/settings/pin/esim",
    label: "eSIM & cellular",
    desc: "Carrier status and the Pin's eSIM profiles: activate, enable, rename, delete.",
  },
  {
    href: "/settings/pin/flags",
    label: "Device flags",
    desc: "The device's own feature flags and Settings.Global gates, with delivery confirmation.",
  },
  {
    href: "/settings/pin/diagnostics",
    label: "Diagnostics & logs",
    desc: "Remote APK install, plus server logs and logcat downloaded straight off the device.",
  },
  {
    href: "/settings/pin/fitness",
    label: "Fitness",
    desc: "Sessions the Pin recorded, their summaries, and their files.",
  },
  {
    href: "/settings/pin/contacts",
    label: "Contacts on the Pin",
    desc: "The address book used for calls and messages on this Pin.",
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
                ? "This browser holds an authorized ADB session to the Pin."
                : remotelyConnected
                  ? "Center reaches your paired Pin through its encrypted Iroh connection."
                  : "Center is looking for your paired Pin over Iroh. USB is available for maintenance."
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
                ? "USB takes priority while attached, so installs, eSIM, Wi-Fi radio changes and logs stay local."
                : remotelyConnected
                  ? "Settings, providers, flags, activity, captures, fitness, contacts, Spotify and Codex work here without a cable."
                  : "Center reconnects to your paired Pin automatically. Connect USB only for installation, recovery, eSIM, Wi-Fi radio changes or logs."}
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
                connectionMode === "remote"
                  ? "Whether the Revival server answers through the encrypted Iroh bridge."
                  : "Whether the Revival server answers over this USB session."
              }
            />
          </div>

          {serviceStatus === "online" ? (
            <>
              <DeviceRow label="Pin name" value={device?.display_name ?? "—"} />
              <DeviceRow
                label="Assistant"
                value={
                  device?.llm_provider
                    ? `${device.llm_provider}${device.llm_model ? ` · ${device.llm_model}` : ""}`
                    : "—"
                }
              />
            </>
          ) : serviceStatus === "offline" ? (
            <div className={styles.stateRow}>
              <StatusMessage tone="warning" onRetry={() => void refreshService()}>
                {connectionMode === "remote"
                  ? "The paired Pin is not answering over Iroh yet. Center will keep retrying; use USB below only if it needs repair."
                  : "The Pin is attached, but its Revival server is not answering. That is expected before setup — install the software below."}
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
          <span className={settings.sectionTitle}>What you can do here</span>
        </div>

        {!connected ? (
          <div className={styles.noteRow}>
            <p className={styles.note}>
              Center will load normal Pin settings over Iroh as soon as the paired device is online.
              Maintenance panes will clearly ask for USB when a physical connection is required.
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

        <div className={styles.noteRow}>
          <p className={styles.note}>
            Ai Pin Revival is an independent project built with PenumbraOS compatibility technology.
            It is not affiliated with Humane Inc. or HP Inc. The Ai Pin trademark and archived
            content remain property of HP.
          </p>
        </div>
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
