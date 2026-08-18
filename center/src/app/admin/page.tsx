"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { CardsSkeleton, ErrorState } from "@/components/States";
import { StatusChip } from "@/components/Status";
import styles from "./admin.module.css";
import { AdminFeatureFlags, type FlagRowError, type FlagView, type PanelStatus } from "./AdminFeatureFlags";
import { AdminProvisioning } from "./AdminProvisioning";
import { AdminConfiguration } from "./AdminConfiguration";
import { AdminDataPanels } from "./AdminDataPanels";
import type { Bundle, Overview, ProvisionedDevice } from "./AdminTypes";

/**
 * Operator console — an OPERATOR surface, not a faithful .Center view.
 *
 * The real .Center never provisioned devices: onboarding lived in the mobile app
 * and the factory attestation identity. The clone has neither, so the operator
 * issues a device its attestation credential here, then the Pin runs the same
 * OPAQUE ceremony a stock device would. Everything on this page is admin-gated;
 * the enrollment pincode and a minted device key pass through it.
 *
 * The console's whole job is telling an operator what is TRUE, so the states it
 * can be in are named rather than inferred:
 *
 *   loading       we have not heard back yet
 *   unconfigured  no admin token on this dashboard, so it fails closed by design
 *   error         the backend answered, and not with an overview — the status is
 *                 echoed, because 401 (the two halves of the shared secret
 *                 disagree) is the most common way this page breaks
 *   ready         we have the overview
 *
 * Those four used to be two booleans, and `loadOverview` returned bare on any
 * non-ok response — so a wrong token, a 500 and a slow network all rendered as
 * the same empty header, indistinguishable from a page still loading.
 */

type ConsoleStatus = "loading" | "unconfigured" | "error" | "ready";

/**
 * One feature flag as the backend reports it.
 *
 * `observed` is NOT "what live cosmos was captured serving", whatever this page
 * used to claim in the copy right above the table. The backend returns this
 * deployment's own coded default with runtime overrides suppressed — so for
 * every flag nobody has overridden, `observed === effective`, and the deviations
 * the column existed to expose are exactly the ones it hid. We render it as what
 * it is: **Default here**. (A genuinely captured value would need a new
 * `captured` field on the backend; that is a separate change in another repo.)
 */
/**
 * Echo the upstream status in the operator's terms. Swallowing it is why a
 * mismatched admin token used to look exactly like a page that had not finished
 * loading — the single most expensive silence on this surface.
 */
function explainUpstream(status: number): string {
  if (status === 401 || status === 403) {
    return `The backend answered ${status} — the admin token on the dashboard and the ai-bus workload do not match.`;
  }
  if (status === 404) {
    return "The backend answered 404 — this deployment does not serve the operator API.";
  }
  if (status === 503) {
    return "This dashboard has no admin token configured, so it cannot write. Set COSMOS_ADMIN_TOKEN on both ends.";
  }
  if (status === 502) {
    return "The backend did not answer — it is down, or unreachable from this dashboard.";
  }
  if (status >= 500) {
    return `The backend answered ${status} — it is up, but could not serve this.`;
  }
  return `The backend answered ${status}.`;
}

export default function AdminPage() {
  const [status, setStatus] = useState<ConsoleStatus>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [devices, setDevices] = useState<ProvisionedDevice[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const [deviceId, setDeviceId] = useState("");
  const product = "00000001";
  const [busy, setBusy] = useState(false);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [revealPin, setRevealPin] = useState(false);

  const [flags, setFlags] = useState<FlagView[]>([]);
  const [flagsStatus, setFlagsStatus] = useState<PanelStatus>("loading");
  const [flagsError, setFlagsError] = useState<string | null>(null);
  /** Bumped on every successful reload so the uncontrolled value inputs remount. */
  const [flagsRevision, setFlagsRevision] = useState(0);
  const [flagBusy, setFlagBusy] = useState<string | null>(null);
  /**
   * What one row has to say for itself. `tone` because not every one of these is
   * a failure: "you emptied the field, so nothing was written" is a notice, and
   * shouting it in red at an operator who did nothing wrong trains them to stop
   * reading the red.
   */
  const [flagRowError, setFlagRowError] = useState<FlagRowError | null>(null);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setStatus("loading");
    setOverviewError(null);
    const res = await fetch("/api/admin/overview", { cache: "no-store" }).catch(() => null);
    if (!res) {
      setOverviewError("The request did not complete — this browser could not reach the dashboard.");
      setStatus("error");
      return;
    }
    // 503 is reserved for "no admin token configured here"; a backend that is
    // simply not answering comes back 502, so the two stop looking alike.
    if (res.status === 503) {
      setStatus("unconfigured");
      return;
    }
    if (!res.ok) {
      setOverviewError(explainUpstream(res.status));
      setStatus("error");
      return;
    }
    const body = (await res.json().catch(() => null)) as Overview | null;
    if (!body?.enrollment) {
      setOverviewError("The backend answered, but not with the overview this console expects.");
      setStatus("error");
      return;
    }
    setOverview(body);
    setStatus("ready");
  }, []);

  const loadDevices = useCallback(async () => {
    setDevicesError(null);
    const res = await fetch("/api/admin/devices", { cache: "no-store" }).catch(() => null);
    if (!res) {
      setDevicesError("The roster request did not complete.");
      return;
    }
    // Unconfigured is already stated once, at console level — do not say it twice.
    if (res.status === 503) {
      setDevices([]);
      return;
    }
    if (!res.ok) {
      setDevicesError(explainUpstream(res.status));
      return;
    }
    const body = (await res.json().catch(() => null)) as { devices?: unknown } | null;
    setDevices(Array.isArray(body?.devices) ? (body.devices as ProvisionedDevice[]) : []);
  }, []);

  const loadFlags = useCallback(async () => {
    setFlagsStatus((s) => (s === "ready" ? s : "loading"));
    const res = await fetch("/api/admin/flags", { cache: "no-store" }).catch(() => null);
    if (!res) {
      setFlagsError("The flag list request did not complete.");
      setFlagsStatus("error");
      return;
    }
    if (res.status === 503) {
      setFlags([]);
      setFlagsError(null);
      setFlagsStatus("unconfigured");
      return;
    }
    if (!res.ok) {
      setFlagsError(explainUpstream(res.status));
      setFlagsStatus("error");
      return;
    }
    const body = (await res.json().catch(() => null)) as unknown;
    setFlags(Array.isArray(body) ? (body as FlagView[]) : []);
    setFlagsError(null);
    setFlagsStatus("ready");
    setFlagsRevision((n) => n + 1);
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadDevices();
    void loadFlags();
  }, [loadOverview, loadDevices, loadFlags]);

  /** Write an override; the device picks it up on its next flag sync. */
  async function setFlag(name: string, value: unknown) {
    setFlagBusy(name);
    setFlagRowError(null);
    try {
      const res = await fetch("/api/admin/flags", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setFlagRowError({ name, message: body.error ?? explainUpstream(res.status) });
      }
      // Always re-read: this is what re-syncs the row (and remounts the input) so
      // a rejected value cannot sit on screen looking applied.
      await loadFlags();
    } catch {
      setFlagRowError({ name, message: "The backend did not answer, so nothing was written." });
    } finally {
      setFlagBusy(null);
    }
  }

  /** Clear one override. */
  async function clearFlag(name: string) {
    setFlagBusy(name);
    setFlagRowError(null);
    try {
      const res = await fetch("/api/admin/flags", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setFlagRowError({ name, message: body.error ?? explainUpstream(res.status) });
      }
      await loadFlags();
    } catch {
      setFlagRowError({ name, message: "The backend did not answer, so nothing was cleared." });
    } finally {
      setFlagBusy(null);
    }
  }

  /**
   * Reset EVERY override at once. This writes device-visible behaviour on a live
   * Pin, so it is typed-confirmation gated exactly like the privacy pane's
   * account deletion — the app's reference pattern for "this cannot be undone".
   */
  async function resetAllOverrides() {
    setFlagBusy("*");
    setResetError(null);
    try {
      const res = await fetch("/api/admin/flags", { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResetError(body.error ?? explainUpstream(res.status));
      } else {
        setResetOpen(false);
        setResetText("");
      }
      await loadFlags();
    } catch {
      setResetError("The backend did not answer, so no override was cleared.");
    } finally {
      setFlagBusy(null);
    }
  }

  async function provision() {
    if (busy) return;
    setBusy(true);
    setProvisionError(null);
    setBundle(null);
    try {
      const res = await fetch("/api/admin/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId.trim(), product }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Bundle> & { error?: string };
      if (!res.ok) {
        setProvisionError(body.error ?? explainUpstream(res.status));
        return;
      }
      setBundle(body as Bundle);
      void loadDevices();
      void loadOverview();
    } catch {
      setProvisionError("The backend did not answer, so no credential was minted.");
    } finally {
      setBusy(false);
    }
  }

  const enr = overview?.enrollment;
  /** Writes need the admin token; the listing does not. */
  const flagWritesEnabled = status !== "unconfigured";

  return (
    <Shell showNav={false} showTopBar={false}>
      <div className={styles.admin}>
        <header className={styles.head}>
          <div className={styles.headTop}>
            <span className={styles.kicker}>Operator console</span>
            <Link className={styles.backLink} href="/">
              Back to Center
            </Link>
          </div>
          <h1>Operator Console</h1>
          <p>
            Provision authorized Pins, control device-visible flags, and inspect this deployment.
            Wearer settings stay in Center; operational controls live here.
          </p>
        </header>

        <nav className={styles.consoleNav} aria-label="Operator Console sections">
          <a href="#enrollment">Enrollment</a>
          <a href="#provision">Provisioning</a>
          <a href="#feature-flags">Feature flags</a>
          <a href="#configuration">Configuration</a>
          <a href="#devices">Devices</a>
          <a href="#persistence">Data</a>
        </nav>

        {status === "ready" && overview && enr && (
          <div className={styles.statusStrip}>
            <StatusChip
              tone={enr.open ? "live" : "off"}
              label={enr.open ? "Enrollment open" : "Closed to new devices"}
              detail={
                enr.open
                  ? "The backend is admitting new devices."
                  : "The backend will refuse a new enrollment."
              }
            />
            <StatusChip
              tone={enr.provisioning_configured ? "live" : "degraded"}
              label={enr.provisioning_configured ? "Provisioning ready" : "No attestation CA"}
              detail="The CA the edge trusts, used to mint device credentials."
            />
            <StatusChip
              tone={enr.duc_ca_configured ? "live" : "degraded"}
              label={enr.duc_ca_configured ? "DeviceUser CA loaded" : "No DeviceUser CA"}
              detail="The CA that issues a DeviceUser certificate once OPAQUE completes."
            />
            <StatusChip
              tone={overview.provisioned_devices > 0 ? "live" : "off"}
              label={`${overview.provisioned_devices} ${
                overview.provisioned_devices === 1 ? "device" : "devices"
              } provisioned`}
              detail="Credentials minted since the backend last started — this deployment keeps no durable roster."
            />
          </div>
        )}

        {status === "loading" && <CardsSkeleton count={3} />}

        {status === "unconfigured" && (
          <section className={styles.card}>
            <h2>Console not configured</h2>
            <p className={styles.muted}>
              The operator console is locked until an admin token is set on both the dashboard and
              the backend. It fails closed by design.
            </p>
            <ul className={styles.envList}>
              <li><code>COSMOS_ADMIN_TOKEN</code> — the same secret on the dashboard and the ai-bus workload</li>
              <li><code>COSMOS_ATTEST_CA_CERT</code> / <code>COSMOS_ATTEST_CA_KEY</code> — the CA the edge trusts, to mint device credentials</li>
              <li><code>COSMOS_DUC_CA_CERT</code> / <code>COSMOS_DUC_CA_KEY</code> — the DeviceUser-issuing CA</li>
            </ul>
          </section>
        )}

        {status === "error" && (
          <section className={styles.card}>
            <ErrorState
              title="The console could not read its backend"
              detail={overviewError ?? undefined}
              onRetry={() => void loadOverview()}
              inline
            />
          </section>
        )}

        {status === "ready" && overview && enr ? (
          <AdminProvisioning
            overview={overview}
            revealPin={revealPin}
            deviceId={deviceId}
            product={product}
            busy={busy}
            provisionError={provisionError}
            bundle={bundle}
            onRevealPin={() => setRevealPin((value) => !value)}
            onDeviceId={setDeviceId}
            onProvision={() => void provision()}
            onClearBundle={() => setBundle(null)}
          />
        ) : null}

        <AdminFeatureFlags
          flags={flags}
          status={flagsStatus}
          error={flagsError}
          revision={flagsRevision}
          busy={flagBusy}
          writesEnabled={flagWritesEnabled}
          rowError={flagRowError}
          resetOpen={resetOpen}
          resetText={resetText}
          resetError={resetError}
          onReload={() => void loadFlags()}
          onSet={(name, value) => void setFlag(name, value)}
          onClear={(name) => void clearFlag(name)}
          onRowError={setFlagRowError}
          onResetOpen={(open) => {
            setResetOpen(open);
            if (open) setResetError(null);
          }}
          onResetText={setResetText}
          onReset={() => void resetAllOverrides()}
        />

        {/* Not gated on `status`. This panel reads Center's own environment and
            its own data volume, so it answers when the backend does not — which
            is exactly when an operator is looking for a missing setting. */}
        <AdminConfiguration />

        {status === "ready" && overview ? (
          <AdminDataPanels
            overview={overview}
            devices={devices}
            devicesError={devicesError}
            onRetryDevices={() => void loadDevices()}
            onRetryOverview={() => void loadOverview()}
          />
        ) : null}
      </div>
    </Shell>
  );
}
