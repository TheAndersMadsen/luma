"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import settings from "../../settings.module.css";
import styles from "./devices.module.css";
import { EmptyState, SectionSkeleton } from "@/components/States";
import { StatusChip, StatusMessage } from "@/components/Status";
import { ListRow } from "@/components/Page";
import { PinRuntimeApproval } from "./PinRuntimeApproval";
import {
  buildDeviceOverview,
  parseDeviceStatusResponse,
  type DeviceStatus,
} from "@/lib/contracts/deviceStatus";

// Mirrors the shape returned by /api/settings/wifi. Declared locally so this
// client component never pulls the server-only route module into its bundle.
interface WifiNetwork {
  ssid: string;
  authorizationType?: string;
  hidden?: boolean;
  connected?: boolean;
}

/** Account-scoped status, saved Wi-Fi, pairing, and setup for the wearer's Pin. */

interface WifiResponse {
  networks: WifiNetwork[];
  /**
   * How many saved-network envelopes the backend actually holds.
   *
   * `ListSecureWifiConfigs` answers with `repeated EncryptedData`, sealed under
   * the DEVICE's key — never with legible `WifiConfig` rows. So `networks` is
   * structurally empty on this path and a count is the whole truth the route
   * can tell. Rendering `networks.length === 0` as "you have none" is the exact
   * lie this field exists to stop.
   */
  sealedCount?: number;
  /** live: your list, possibly empty. absent: nothing is configured to answer.
   *  degraded: something is configured and it did not answer. */
  state?: "live" | "absent" | "degraded";
  unavailable?: boolean;
  degraded?: string;
}

interface PairedPin {
  deviceId: string;
  pairedAt: number | null;
}

interface PairedPinsResponse {
  devices: PairedPin[];
}

/** "AUTHORIZATION_TYPE_WPA3_PERSONAL" → "WPA3 Personal"; unspecified → null. */
function prettyAuth(type: string | undefined): string | null {
  if (!type) return null;
  if (!type.startsWith("AUTHORIZATION_TYPE_")) return type;
  const stripped = type.replace(/^AUTHORIZATION_TYPE_/, "");
  if (!stripped || stripped === "UNSPECIFIED") return null;
  if (stripped === "OPEN") return "Open";
  return stripped
    .split("_")
    .map((w) => (/^WPA\d?$|^WEP$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(" ");
}

function WifiIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 15.5a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5zM5.4 10.4a6.5 6.5 0 019.2 0M2.6 7.6a10.5 10.5 0 0114.8 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function Page() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["settings-wifi"],
    queryFn: async () => {
      const res = await fetch("/api/settings/wifi");
      // Throw on a transport-level failure so `isError` is a real signal; the
      // route itself degrades to 200 + `unavailable` and never 500s.
      if (!res.ok) throw new Error(`/api/settings/wifi → ${res.status}`);
      return (await res.json()) as WifiResponse;
    },
    staleTime: 10_000,
  });

  const networks = data?.networks ?? [];
  // Envelopes the backend confirmed it holds and this dashboard cannot open.
  // Never inferred: it is only ever the number the route counted.
  const sealedCount = data?.sealedCount ?? 0;
  const statusQuery = useQuery({
    queryKey: ["device-status"],
    queryFn: async () => {
      const res = await fetch("/api/devices/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`/api/devices/status → ${res.status}`);
      return parseDeviceStatusResponse(await res.json());
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const device = statusQuery.data?.devices[0];
  const deviceIsLive = device ? Date.now() / 1000 - device.reported_at_epoch < 10 * 60 : false;
  /*
   * A Pin whose status we could not READ is not a Pin that is not PAIRED.
   *
   * /api/devices/status answers 200 on every failure — a rejected admin token, a
   * 503 from the status store, a per-device fetch that did not come back — and
   * puts the verdict in `state`. This section branched on the presence of a
   * device object instead, so an unreadable status rendered "Pair a Pin below to
   * see its status here." directly above a pairing section, fed by a DIFFERENT
   * route, saying "1 Pin paired". That is the exact self-contradiction the
   * status route was rewritten to prevent, and its own header comment names it.
   * The line underneath then added "The Pin has not reported its status yet." —
   * a claim about the wearer's hardware for a condition that is entirely
   * Center-side, and one a wearer hits routinely: it is what they see in the
   * seconds after using the Pair a Pin form on this very page.
   *
   * `unread` is the route's own count of Pins it was asked about and could not
   * answer for, so the wearer with two Pins is told one is missing rather than
   * being shown one and left to notice.
   */
  const statusUnread = statusQuery.data?.unread ?? 0;
  const statusAsked = (statusQuery.data?.devices.length ?? 0) + statusUnread;
  const statusUnreadable = statusQuery.isError || statusQuery.data?.state === "degraded";
  const statusUnreadableRow = statusUnreadable ? (
    <div className={settings.stateRow}>
      <StatusMessage tone="warning" onRetry={() => void statusQuery.refetch()}>
        {statusUnread > 0 && statusAsked > 1
          ? `${statusUnread} of your ${statusAsked} Pins are unavailable. Pairing is unchanged.`
          : "Your Pin’s status is unavailable. Pairing is unchanged."}
      </StatusMessage>
    </div>
  ) : null;
  const statusByDevice = new Map(
    (statusQuery.data?.devices ?? []).map((status) => [status.device_id.toLowerCase(), status]),
  );
  const reportedNetworks = device?.wifi_networks ?? [];
  const visibleNetworks = networks.length > 0
    ? networks
    : reportedNetworks.map((network) => ({
        ssid: network.ssid,
        authorizationType: network.authorization_type,
        hidden: false,
        connected: network.connected,
      }));
  const pairings = useQuery({
    queryKey: ["paired-pins"],
    queryFn: async () => {
      const res = await fetch("/api/devices/pair", { cache: "no-store" });
      if (!res.ok) throw new Error(`/api/devices/pair → ${res.status}`);
      return (await res.json()) as PairedPinsResponse;
    },
    staleTime: 10_000,
  });
  // Branch on the FAILURE FLAG, never on length. An empty list from a healthy
  // backend means the wearer has saved no networks; it does not mean the backend
  // cannot answer. And a backend nothing is configured to reach is an absence,
  // which is not retryable — so it does not get a "Try again" that cannot work.
  const state = data?.state ?? (data?.unavailable ? "degraded" : "live");
  const failed = isError || state === "degraded";
  const absent = !isError && state === "absent";
  // "You have none" is a THIRD claim, and it needs both halves to be true: the
  // backend holds no sealed envelope AND the Pin is not reporting a network of
  // its own. A live read that returned N envelopes is evidence of N saved
  // networks, so it must never reach the empty state.
  const nothingSaved = sealedCount === 0 && visibleNetworks.length === 0;

  return (
    <>
      <section className={settings.section} data-testid="deviceIdentity">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>My Ai Pin</span>
        </div>
        {statusQuery.isLoading ? (
          <div className={settings.stateRow}>
            <span className={settings.muted}>Checking your Pin…</span>
          </div>
        ) : device ? (
          <>
            <div className={styles.overviewGrid}>
              {buildDeviceOverview(device).map((item) => (
                <div className={styles.overviewCard} data-tone={item.tone} key={item.key}>
                  <span className={styles.overviewLabel}>{item.label}</span>
                  <strong className={styles.overviewValue}>{item.value}</strong>
                  {item.detail ? <span className={styles.overviewDetail}>{item.detail}</span> : null}
                </div>
              ))}
            </div>
            <details className={styles.deviceDetails}>
              <summary>Device details</summary>
              {device.serial_number ? <DeviceValueRow label="Serial number" value={device.serial_number} /> : null}
              {device.firmware_version ? <DeviceValueRow label="Firmware version" value={device.firmware_version} /> : null}
              {device.os_version ? <DeviceValueRow label="OS version" value={device.os_version} /> : null}
            </details>
          </>
        ) : statusUnreadable ? (
          // The read failed, so this section knows nothing about pairing and says
          // nothing about it. `statusUnreadableRow` below carries the sentence.
          null
        ) : (
          <div className={settings.stateRow}>
            <span className={settings.muted}>
              Open guided setup below to connect and pair your Pin.
            </span>
          </div>
        )}
        {device && deviceIsLive ? (
          <div className={settings.stateRow}>
            <StatusMessage tone="info">
              Live Pin status · updated {new Date(device.reported_at_epoch * 1000).toLocaleTimeString()}
            </StatusMessage>
          </div>
        ) : device ? (
          <div className={settings.stateRow}>
            <StatusMessage tone="warning" onRetry={() => void statusQuery.refetch()}>
              Pin offline · last report {new Date(device.reported_at_epoch * 1000).toLocaleString()}
            </StatusMessage>
          </div>
        ) : null}
        {statusUnreadableRow}
      </section>

      {isLoading ? (
        <SectionSkeleton rows={3} />
      ) : (
        <section className={settings.section} data-testid="wifiNetworks">
          <div className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>Wi-Fi Networks</span>
          </div>

          {failed ? (
            <div className={settings.stateRow}>
              <StatusMessage tone="warning" onRetry={() => void refetch()}>
                Wi-Fi networks couldn&rsquo;t be loaded.
              </StatusMessage>
            </div>
          ) : absent ? (
            <div className={settings.stateRow}>
              <StatusMessage tone="warning">Wi-Fi networks aren&rsquo;t available right now.</StatusMessage>
            </div>
          ) : nothingSaved ? (
            <EmptyState
              inline
              icon={<WifiIcon />}
              title="No saved networks yet"
              action={{ label: "Add one with a Wi-Fi QR code", href: "/wifi" }}
            />
          ) : (
            <>
              {/* The read SUCCEEDED and returned sealed envelopes. Say how many
                  and say why their names are missing — this is where the pane
                  used to render "No saved networks yet" over the wearer's real
                  saved networks. */}
              {sealedCount > 0 ? (
                <SealedNetworksRow
                  count={sealedCount}
                  pinIsReporting={visibleNetworks.length > 0}
                />
              ) : null}
              {visibleNetworks.map((n, i) => {
                const auth = prettyAuth(n.authorizationType);
                return (
                  <div
                    className={styles.wifiRow}
                    key={`${n.ssid}-${i}`}
                    data-testid="wifi-network-row"
                  >
                    <div className={styles.wifiMain}>
                      <WifiIcon className={styles.wifiIcon} />
                      <span className={styles.wifiText}>
                        <span className={styles.wifiSsid}>{n.ssid}</span>
                        {auth ? <span className={styles.wifiMeta}>{auth}</span> : null}
                      </span>
                    </div>
                    {n.connected ? (
                      <StatusChip
                        tone="live"
                        variant="tag"
                        label="Connected"
                        detail="This is the Wi-Fi network the Pin is using now."
                      />
                    ) : n.hidden ? (
                      <StatusChip
                        tone="off"
                        variant="tag"
                        label="Hidden"
                        detail="This network does not broadcast its SSID."
                      />
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
        </section>
      )}

      <PinSetupSection
        devices={pairings.data?.devices ?? []}
        statuses={statusByDevice}
        statusUnreadable={statusUnreadable}
        loading={pairings.isLoading}
        failed={pairings.isError}
        onRetry={() => {
          void pairings.refetch();
          void statusQuery.refetch();
        }}
      />
      <PinRuntimeApproval />
    </>
  );
}

/**
 * "You have N, and this dashboard cannot read them."
 *
 * `WifiConfigService.ListSecureWifiConfigs` returns
 * `repeated humane.common.encryption.EncryptedData` — envelopes sealed under the
 * DEVICE's key. Center holds no key material for them and must not try: the one
 * key it does have is unrelated, and reaching for it is what once made every
 * device-created note look permanently encrypted. So the count is the whole
 * truth available here, and it is worth saying out loud, because the alternative
 * this replaces was an empty state that told a wearer with saved networks they
 * had none — a false claim made with the full authority of a live read.
 *
 * Same shape and wording as the sealed-note surface, so a wearer who meets both
 * learns the idiom once.
 */
function SealedNetworksRow({
  count,
  pinIsReporting,
}: {
  count: number;
  /** Whether the rows below come from the Pin's own live status report. */
  pinIsReporting: boolean;
}) {
  const plural = count === 1 ? "network" : "networks";
  return (
    <div className={styles.wifiRow} data-testid="wifi-sealed-row">
      <div className={styles.wifiMain}>
        <WifiIcon className={styles.wifiIcon} />
        <span className={styles.wifiText}>
          <span className={styles.wifiSsid}>
            {count} saved {plural}
          </span>
          <span className={styles.wifiSealedMeta}>
            Saved on your Pin. Network details stay encrypted.
            {pinIsReporting ? " The Pin reported the network shown below." : ""}
          </span>
        </span>
      </div>
      <StatusChip
        tone="absent"
        variant="tag"
        label="Sealed"
        detail="Protected by your Pin."
      />
    </div>
  );
}

function DeviceValueRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <ListRow
      title={label}
      value={value}
    />
  );
}

function PinSetupSection({
  devices,
  statuses,
  statusUnreadable,
  loading,
  failed,
  onRetry,
}: {
  devices: PairedPin[];
  statuses: Map<string, DeviceStatus>;
  /**
   * Whether the status READ failed, as opposed to the Pin having stayed quiet.
   * Without this the row chipped every unreadable Pin "Not reporting" with the
   * tooltip "This Pin has not reported its status yet" — blaming the wearer's
   * hardware for an admin call Center could not make.
   */
  statusUnreadable: boolean;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <section className={settings.section} data-testid="pinSetup">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Pin setup</span>
      </div>

      <div className={settings.additionRow} data-testid="paired-pins-row">
        <span className={settings.additionRowText}>
          <span className={settings.additionRowTitle}>Your Pins</span>
          <span className={settings.additionRowDesc}>
            {loading
              ? "Checking your Pins…"
              : failed
                ? "Couldn’t load your Pins."
                : devices.length === 0
                  ? "No Pin is paired with this account yet."
                  : `${devices.length} ${devices.length === 1 ? "Pin" : "Pins"} paired`}
          </span>
        </span>
        {failed ? (
          <button type="button" className={styles.pairOpenButton} onClick={onRetry}>
            Try again
          </button>
        ) : devices.length > 0 ? (
          <StatusChip
            tone="live"
            variant="tag"
            label={devices.length === 1 ? "Paired" : `${devices.length} paired`}
            detail="Connected to your account."
          />
        ) : null}
      </div>

      {!loading && !failed
        ? devices.map((paired) => {
            const status = statuses.get(paired.deviceId.toLowerCase());
            const live = status ? Date.now() / 1000 - status.reported_at_epoch < 10 * 60 : false;
            return (
              <div className={styles.deviceClaimRow} key={paired.deviceId}>
                <span className={settings.additionRowText}>
                  <span className={styles.deviceClaimHeading}>
                    <span className={settings.additionRowTitle}>
                      {status?.serial_number || paired.deviceId}
                    </span>
                    <StatusChip
                      tone={live ? "live" : !status && statusUnreadable ? "degraded" : "off"}
                      variant="tag"
                      label={
                        live ? "Online" : !status && statusUnreadable ? "Status unread" : "Not reporting"
                      }
                      detail={
                        status
                          ? `Last report ${new Date(status.reported_at_epoch * 1000).toLocaleString()}`
                          : statusUnreadable
                            ? "Center couldn’t read this Pin’s status just now. The Pin itself may be fine."
                            : "This Pin has not reported its status yet."
                      }
                    />
                  </span>
                  <span className={settings.additionRowDesc}>Device ID {paired.deviceId}</span>
                </span>
                <UnpairDeviceButton deviceId={paired.deviceId} live={live} onRemoved={onRetry} />
              </div>
            );
          })
        : null}

      {/*
        The first row of this section, because it is the first thing to do.
        "Install or recover" below is one step of the ceremony; this is the
        whole ceremony, in order, with each step read rather than remembered.
      */}
      <div className={settings.additionRow}>
        <span className={settings.additionRowText}>
          <span className={settings.additionRowTitle}>Set up a Pin, step by step</span>
          <span className={settings.additionRowDesc}>
            Follow connection, software and configuration checks in order.
          </span>
        </span>
        <Link className={settings.additionLink} href="/settings/pin/setup">
          Open guided setup
        </Link>
      </div>

      <div className={settings.additionRow}>
        <span className={settings.additionRowText}>
          <span className={settings.additionRowTitle}>Install or recover</span>
          <span className={settings.additionRowDesc}>
            Connect by USB to install or recover the current release.
          </span>
        </span>
        <Link className={settings.additionLink} href="/settings/pin/install">
          Open installer
        </Link>
      </div>

      <div className={settings.additionRow}>
        <span className={settings.additionRowText}>
          <span className={settings.additionRowTitle}>Wi-Fi QR code</span>
          <span className={settings.additionRowDesc}>
            Create a network code your Pin can scan. The password stays in this browser.
          </span>
        </span>
        <Link className={settings.additionLink} href="/wifi">
          Open
        </Link>
      </div>

    </section>
  );
}

function UnpairDeviceButton({
  deviceId,
  live,
  onRemoved,
}: {
  deviceId: string;
  live: boolean;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/devices/pair", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId }),
      });
      const body = (await response.json().catch(() => ({}))) as { removed?: boolean; error?: string };
      if (!response.ok || !body.removed) {
        setError("This Pin couldn’t be removed. Try again.");
        return;
      }
      onRemoved();
    } catch {
      setError("This Pin couldn’t be removed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" className={styles.unpairButton} onClick={() => setConfirming(true)}>
        Remove
      </button>
    );
  }

  return (
    <span className={styles.unpairConfirm}>
      <span className={styles.unpairWarning}>
        {live ? "Unpair this online Pin?" : "Remove this Pin from your account?"}
      </span>
      {error ? <span className={styles.unpairError}>{error}</span> : null}
      <span className={styles.unpairActions}>
        <button type="button" className={styles.unpairConfirmButton} disabled={busy} onClick={() => void remove()}>
          {busy ? "Removing…" : "Confirm"}
        </button>
        <button type="button" className={styles.pairCancel} disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    </span>
  );
}
