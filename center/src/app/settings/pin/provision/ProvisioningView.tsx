"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ErrorState, SectionSkeleton } from "@/components/States";
import { GuidedSetupReturn } from "@/components/GuidedSetupReturn";
import { StatusChip, StatusMessage } from "@/components/Status";
import { usePinDevice } from "../PinDeviceProvider";
import { deviceErrorMessage } from "../_lib/deviceErrorPresentation";
import settings from "../../settings.module.css";
import { createActivationBundleJson } from "./activationBundle";
import { PasscodeFact } from "./PasscodeFact";
import {
  centerRemoteAccess,
  provisionConnectedPin,
  RemoteAccessSetupError,
} from "./browserActivation";
import styles from "./provision.module.css";
import type { ActivationBundle, ProvisioningOverview } from "./types";

type LoadState = "loading" | "ready" | "unconfigured" | "error";

function responseMessage(status: number): string {
  if (status === 401 || status === 403) return "Operator access was rejected.";
  if (status === 404) return "This Cosmos release does not support provisioning.";
  if (status === 502) return "Cosmos could not be reached.";
  if (status === 503) return "Provisioning is not configured.";
  return `Provisioning failed (HTTP ${status}).`;
}

function isActivationBundle(value: unknown): value is ActivationBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Record<string, unknown>;
  return [
    "device_id",
    "subject",
    "certificate_pem",
    "private_key_pem",
    "ca_certificate_pem",
    "root_certificate_pem",
  ].every((key) => typeof bundle[key] === "string");
}

/**
 * A failed step in wearer copy. Our own errors already are. A Pin API error's
 * body never is (`Pin API 403: …` is protocol text), so it goes through the
 * console's presenter.
 */
function activationFailureMessage(error: unknown): string {
  const plain = (cause: unknown, fallback: string) =>
    deviceErrorMessage(cause, cause instanceof Error && cause.message ? cause.message : fallback);
  if (error instanceof RemoteAccessSetupError) {
    return `${error.message} ${plain(error.reason, "Try again.")}`;
  }
  return plain(error, "Center could not finish setting up this Pin.");
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function ProvisioningView() {
  const pin = usePinDevice();
  // A result belongs to this USB connection, never the next Pin attached.
  return <ProvisioningContent key={`${pin.connectionInfo?.serial ?? "none"}:${pin.status}`} />;
}

function ProvisioningContent() {
  const queryClient = useQueryClient();
  const pin = usePinDevice();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [overview, setOverview] = useState<ProvisioningOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationMessage, setActivationMessage] = useState<{ tone: "info" | "warning" | "danger"; text: string } | null>(null);
  const [activationState, setActivationState] = useState<"ready" | "remote-pending" | "complete">("ready");
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [bundle, setBundle] = useState<ActivationBundle | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    const response = await fetch("/api/admin/overview", { cache: "no-store" }).catch(() => null);
    if (!response) {
      setLoadError("Cosmos could not be reached.");
      setLoadState("error");
      return;
    }
    if (response.status === 503) {
      setLoadState("unconfigured");
      return;
    }
    if (!response.ok) {
      setLoadError(responseMessage(response.status));
      setLoadState("error");
      return;
    }
    const body = (await response.json().catch(() => null)) as ProvisioningOverview | null;
    if (!body?.enrollment) {
      setLoadError("Cosmos returned an invalid provisioning response.");
      setLoadState("error");
      return;
    }
    setOverview(body);
    setLoadState("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function issueBundle(id: string): Promise<ActivationBundle> {
    const response = await fetch("/api/admin/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: id, product: "00000001" }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body
        ? (body as { error?: unknown }).error
        : undefined;
      throw new Error(typeof error === "string" ? error : responseMessage(response.status));
    }
    if (!isActivationBundle(body)) throw new Error("Cosmos returned an invalid activation file.");
    return body;
  }

  async function provision() {
    const id = deviceId.trim().toLowerCase();
    if (busy || !/^[0-9a-f]+$/u.test(id)) return;
    setBusy(true);
    setBundle(null);
    setProvisionError(null);
    try {
      setBundle(await issueBundle(id));
    } catch (error) {
      setProvisionError(error instanceof Error ? error.message : "Cosmos could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  async function connectPin() {
    setActivationMessage(null);
    try {
      await pin.connect();
    } catch (error) {
      setActivationMessage({ tone: "danger", text: error instanceof Error ? error.message : "Center could not connect to the Pin." });
    }
  }

  // Every step runs on the Pin over USB. Just after the chooser, or when
  // Luma on the Pin is not answering, the client may still be the remote
  // one, which the bridge and the Pin refuse for these settings.
  const usbClient = pin.connectionMode === "usb" && pin.client?.mode === "usb" ? pin.client : null;

  async function checkConnection() {
    if (checkingConnection) return;
    setCheckingConnection(true);
    try {
      await pin.refreshService();
    } finally {
      setCheckingConnection(false);
    }
  }

  async function activatePin() {
    if (activationBusy || pin.status !== "connected" || !usbClient) return;
    setActivationBusy(true);
    setActivationMessage(null);
    setProvisionError(null);
    try {
      const session = pin.borrowSession();
      await provisionConnectedPin(
        session,
        usbClient,
        {
          ...centerRemoteAccess,
          async pairDevice(id) {
            const response = await fetch("/api/devices/pair", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ device_id: id }),
            });
            const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
            if (!response.ok) {
              throw new Error(
                typeof body?.error === "string"
                  ? body.error
                  : "Center could not pair this Pin with your account.",
              );
            }
          },
          async issueBundle(id) {
            setDeviceId(id);
            return issueBundle(id);
          },
        },
        overview?.device_edge_ipv4 ?? null,
        overview?.device_status_endpoint ?? null,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pin-setup"] }),
        queryClient.invalidateQueries({ queryKey: ["paired-pins"] }),
        queryClient.invalidateQueries({ queryKey: ["device-status"] }),
      ]);
      setBundle(null);
      setActivationState("complete");
      setActivationMessage({
        tone: "info",
        text: "This Pin is connected to Cosmos and paired with your account. Return to Guided setup to finish setup on this Pin.",
      });
    } catch (error) {
      if (error instanceof RemoteAccessSetupError) {
        setBundle(null);
        setActivationState("remote-pending");
        // Paired and activated: Guided setup and Settings may say so now.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["pin-setup"] }),
          queryClient.invalidateQueries({ queryKey: ["paired-pins"] }),
        ]);
      }
      setActivationMessage({ tone: error instanceof RemoteAccessSetupError ? "warning" : "danger", text: activationFailureMessage(error) });
    } finally {
      setActivationBusy(false);
    }
  }

  if (loadState === "loading") {
    return (
      <section className={settings.section}>
        <SectionSkeleton rows={5} />
      </section>
    );
  }

  if (loadState === "unconfigured") {
    return (
      <section className={settings.section}>
        <ErrorState
          title="Provisioning is not configured"
          detail="Set the same COSMOS_ADMIN_TOKEN in Center and Cosmos, then configure the attestation CA."
          onRetry={() => void load()}
          inline
        />
      </section>
    );
  }

  if (loadState === "error" || !overview) {
    return (
      <section className={settings.section}>
        <ErrorState
          title="Couldn’t load provisioning"
          detail={loadError ?? undefined}
          onRetry={() => void load()}
          inline
        />
      </section>
    );
  }

  const enrollment = overview.enrollment;
  return (
    <>


      <section className={settings.section} data-testid="provisioning-issue">
        <div className={settings.sectionHeader}>
          <h2 className={settings.sectionTitle}>Connect your Pin</h2>
        </div>
        <div className={styles.content}>
          <div className={styles.directSetup}>
            <div className={styles.directHeader}>
              <span>
                <strong>{pin.status === "connected" ? pin.connectionInfo?.name || "Ai Pin" : "Connect your Ai Pin"}</strong>
                <small>This server supports one Pin. Link it to your account so your conversations, music and settings work together.</small>
              </span>
              <StatusChip
                tone={pin.status === "connected" ? "live" : "off"}
                label={pin.status === "connected" ? "USB connected" : "Not connected"}
              />
            </div>

            <div className={styles.passcodeNote}>Pin passcode: <PasscodeFact /></div>
            {enrollment.provisioned_device_id ? (
              <StatusMessage tone="info">This server’s Pin is {enrollment.provisioned_device_id}. You can repair or reactivate this same Pin; removing its pairing does not allow a different Pin.</StatusMessage>
            ) : null}

            {activationState !== "ready" ? (
              <div className={styles.activationStatus} aria-label="Setup progress">
                <StatusChip tone="live" label="Connected to Cosmos" />
                <StatusChip
                  tone={activationState === "complete" ? "live" : "degraded"}
                  label={activationState === "complete" ? "Remote access is ready" : "Remote access pending"}
                />
              </div>
            ) : null}

            {activationState === "complete" ? null : pin.status === "connected" ? (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={
                  activationBusy ||
                  !usbClient ||
                  pin.serviceStatus !== "online" ||
                  pin.identity?.recognizedAiPin === false ||
                  !enrollment.provisioning_configured ||
                  !overview.device_edge_ipv4 ||
                  !overview.device_status_endpoint
                }
                onClick={() => void activatePin()}
              >
                {activationState === "remote-pending"
                  ? activationBusy ? "Setting up remote access…" : "Retry remote access"
                  : activationBusy ? "Connecting to Cosmos…" : "Connect this Pin to Cosmos"}
              </button>
            ) : (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={pin.status === "connecting"}
                onClick={() => void connectPin()}
              >
                {pin.status === "connecting" ? "Connecting…" : "Connect over USB"}
              </button>
            )}

            {pin.identity?.recognizedAiPin === false ? (
              <StatusMessage tone="danger">The connected device is not an Ai Pin.</StatusMessage>
            ) : null}
            {pin.status === "connected" && (!usbClient || pin.serviceStatus !== "online") ? (
              <>
                <StatusMessage tone="warning">
                  USB is connected, but Luma isn’t responding yet. Keep your Pin connected and unlocked, then check the connection.
                </StatusMessage>
                <div className={styles.connectionActions}>
                  <button type="button" className={styles.secondaryButton} disabled={checkingConnection || activationBusy} onClick={() => void checkConnection()}>
                    {checkingConnection ? "Checking connection…" : "Check connection"}
                  </button>
                  <Link className={settings.additionLink} href="/settings/pin/install">Install or repair Luma</Link>
                </div>
              </>
            ) : null}
            {!enrollment.provisioning_configured ? (
              <StatusMessage tone="warning">Cosmos provisioning is not ready.</StatusMessage>
            ) : null}
            {!overview.device_edge_ipv4 || !overview.device_status_endpoint ? (
              <StatusMessage tone="warning">Finish the Cosmos device connection settings before activating a Pin.</StatusMessage>
            ) : null}
            {activationMessage ? (
              <StatusMessage tone={activationMessage.tone}>{activationMessage.text}</StatusMessage>
            ) : null}
          </div>

          <details className={styles.fallback}>
            <summary>Create an activation file instead</summary>
            <div className={styles.fallbackBody}>
              <label className={styles.field}>
                <span>Device ID</span>
                <input
                  className={styles.input}
                  value={deviceId}
                  onChange={(event) => setDeviceId(event.target.value.toLowerCase())}
                  placeholder="0011223344556677"
                  inputMode="text"
                  pattern="[0-9a-fA-F]+"
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={busy || !/^[0-9a-f]+$/iu.test(deviceId.trim()) || !enrollment.provisioning_configured}
                onClick={() => void provision()}
              >
                {busy ? "Creating…" : "Create activation file"}
              </button>
              {provisionError ? <StatusMessage tone="danger">{provisionError}</StatusMessage> : null}
              {bundle ? (
                <div className={styles.bundle}>
                  <div className={styles.bundleHeader}>
                    <StatusChip tone="live" label="Ready" />
                    <code className={styles.subject}>{bundle.subject}</code>
                    <button type="button" className={styles.quietButton} onClick={() => setBundle(null)}>Clear</button>
                  </div>
                  <p className={styles.intro}>Cosmos issues each private key once.</p>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={!overview.device_status_endpoint}
                    onClick={() => download(
                      `cosmos-activation-${bundle.device_id}.json`,
                      createActivationBundleJson(bundle, overview.device_status_endpoint!),
                    )}
                  >
                    Download activation file
                  </button>
                </div>
              ) : null}
            </div>
          </details>
        </div>
      </section>
      <details className={`${settings.section} ${styles.connectionDetails}`} data-testid="provisioning-enrollment">
        <summary className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Server connection details</span>
          <StatusChip
            tone={enrollment.open ? "live" : "off"}
            label={enrollment.open ? "Open" : "Closed"}
          />
        </summary>
        <dl className={styles.facts}>
          <div>
            <dt>Account</dt>
            <dd>{enrollment.display_name} <code className={styles.mono}>{enrollment.user_id}</code></dd>
          </div>
          <div>
            <dt>Onboarding</dt>
            <dd className={styles.mono}>{overview.onboarding.endpoint || "Not configured"}</dd>
          </div>
          <div>
            <dt>Pin pairings</dt>
            <dd>
              <Link className={settings.additionLink} href="/admin/pairings">
                Review or release a Pin&rsquo;s pairing
              </Link>
            </dd>
          </div>
        </dl>
        <div className={styles.statusRow}>
          <StatusChip
            tone={enrollment.provisioning_configured ? "live" : "degraded"}
            label={enrollment.provisioning_configured ? "Attestation ready" : "Attestation CA missing"}
          />
          <StatusChip
            tone={enrollment.duc_ca_configured ? "live" : "degraded"}
            label={enrollment.duc_ca_configured ? "DeviceUser ready" : "DeviceUser CA missing"}
          />
        </div>
      </details>
      <GuidedSetupReturn />
    </>
  );
}
