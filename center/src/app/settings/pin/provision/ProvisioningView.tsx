"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { ErrorState, SectionSkeleton } from "@/components/States";
import { StatusChip, StatusMessage } from "@/components/Status";
import { usePinDevice } from "../PinDeviceProvider";
import settings from "../../settings.module.css";
import { createActivationBundleJson } from "./activationBundle";
import { connectedDeviceId, provisionConnectedPin } from "./browserActivation";
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
    "pincode",
  ].every((key) => typeof bundle[key] === "string");
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
  const queryClient = useQueryClient();
  const pin = usePinDevice();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [overview, setOverview] = useState<ProvisioningOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationMessage, setActivationMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [bundle, setBundle] = useState<ActivationBundle | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [revealPin, setRevealPin] = useState(false);

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

  async function activatePin() {
    if (activationBusy || pin.status !== "connected" || !pin.client) return;
    setActivationBusy(true);
    setActivationMessage(null);
    setProvisionError(null);
    try {
      const session = pin.borrowSession();
      await provisionConnectedPin(
        session,
        pin.client,
        {
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
          async getBridgeStatus() {
            const response = await fetch("/api/pin/bridge", { cache: "no-store" });
            const body: unknown = await response.json().catch(() => null);
            if (!response.ok) {
              const error = body && typeof body === "object" && "error" in body
                ? (body as { error?: unknown }).error
                : undefined;
              throw new Error(typeof error === "string" ? error : "Center could not prepare remote Pin access.");
            }
            return body;
          },
          async pairBridge(input) {
            const response = await fetch("/api/pin/bridge", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            });
            const body: unknown = await response.json().catch(() => null);
            if (!response.ok) {
              const error = body && typeof body === "object" && "error" in body
                ? (body as { error?: unknown }).error
                : undefined;
              throw new Error(typeof error === "string" ? error : "Center could not finish remote Pin access.");
            }
            return body;
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
      setActivationMessage({
        tone: "info",
        text: "This Pin is connected to Cosmos and paired with your account.",
      });
    } catch (error) {
      setActivationMessage({ tone: "danger", text: error instanceof Error ? error.message : "Center could not activate this Pin." });
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
      <section className={settings.section} data-testid="provisioning-enrollment">
        <div className={settings.sectionHeader}>
          <h2 className={settings.sectionTitle}>Cosmos enrollment</h2>
          <StatusChip
            tone={enrollment.open ? "live" : "off"}
            label={enrollment.open ? "Open" : "Closed"}
          />
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Enrollment PIN</dt>
            <dd className={styles.pinValue}>
              {enrollment.keyless ? (
                <span>Not required</span>
              ) : (
                <>
                  <code>{revealPin ? enrollment.pincode : "••••••"}</code>
                  <button type="button" className={styles.quietButton} onClick={() => setRevealPin((value) => !value)}>
                    {revealPin ? "Hide" : "Reveal"}
                  </button>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{enrollment.display_name} <code className={styles.mono}>{enrollment.user_id}</code></dd>
          </div>
          <div>
            <dt>Onboarding</dt>
            <dd className={styles.mono}>{overview.onboarding.endpoint || "Not configured"}</dd>
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
      </section>

      <section className={settings.section} data-testid="provisioning-issue">
        <div className={settings.sectionHeader}>
          <h2 className={settings.sectionTitle}>Provision a Pin</h2>
        </div>
        <div className={styles.content}>
          <div className={styles.directSetup}>
            <div className={styles.directHeader}>
              <span>
                <strong>{pin.status === "connected" ? pin.connectionInfo?.name || "Ai Pin" : "Connect your Ai Pin"}</strong>
                <small>Center pairs this Pin to your account and installs its Cosmos identity over USB.</small>
              </span>
              <StatusChip
                tone={pin.status === "connected" ? "live" : "off"}
                label={pin.status === "connected" ? "Connected" : "Not connected"}
              />
            </div>

            {pin.status === "connected" ? (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={
                  activationBusy ||
                  pin.identity?.recognizedAiPin === false ||
                  !enrollment.provisioning_configured ||
                  !overview.device_edge_ipv4 ||
                  !overview.device_status_endpoint
                }
                onClick={() => void activatePin()}
              >
                {activationBusy ? "Connecting to Cosmos…" : "Connect this Pin to Cosmos"}
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
    </>
  );
}
