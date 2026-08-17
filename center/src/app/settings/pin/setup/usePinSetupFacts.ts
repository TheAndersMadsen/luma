"use client";

/**
 * The readings behind the guided flow.
 *
 * Every fact the plan is derived from is READ here, from the thing that is
 * actually authoritative for it:
 *
 *   is a Pin connected     the shared WebUSB/ADB session, via PinDeviceProvider
 *   is a release published `/api/pin/releases/current`, through the same
 *                          manifest verifier the installer uses — so "published"
 *                          here means the same thing it means there
 *   what is installed      `inspectInstallState()` over the borrowed session
 *   is the server up       the provider's own health probe over that session
 *   is it configured       `GET /api/settings` on the device, through the
 *                          SHARED `useDeviceSettings` cache the panes use
 *   is it pointed at us    `Settings.Global penumbra_carry_remote_mode`, read
 *                          over ADB and never written from here
 *   is it reporting        `/api/devices/pair` + `/api/devices/status`, the same
 *                          two endpoints /settings/account/devices reads
 *
 * Nothing is inferred from the step before it. A step whose reading has not
 * happened stays "unknown" and the UI says so, which is the entire difference
 * between this and a static checklist.
 *
 * The device-side queries deliberately sit OUTSIDE the `PIN_QUERY_KEY` prefix
 * that the provider invalidates on every device event: an inspection is roughly
 * a dozen ADB round trips, and refiring it on each event would turn a chatty
 * Pin into a self-inflicted denial of service. `useDeviceSettings` stays on the
 * shared key, because that one is a single HTTP call and its freshness is the
 * point.
 */

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { logInfo } from "@/lib/pin-device";
import {
  isPinReleaseError,
  type InstallInspectionResult,
  type ResolvedInstallTarget,
} from "@/lib/pin-install";
import type {
  PinSetupActivationFacts,
  PinSetupCloudFacts,
  PinSetupFacts,
  PinSetupInstallFacts,
  PinSetupReleaseFacts,
  PinSetupServerFacts,
} from "@/lib/pin-setup";
import { usePinDevice } from "../PinDeviceProvider";
import { useDeviceSettings } from "../_lib/useDeviceSettings";

/**
 * The installer brain is loaded ON DEMAND, not with the page.
 *
 * `resolveInstallTarget` and `inspectInstallState` reach the whole installer
 * pipeline: the release manifest verifier, the Tier-A symbol table, the package
 * inspector, the conflict rules. Statically imported, all of it sat in this
 * route's FIRST LOAD — /settings/pin/setup measured 181 kB against a 156 kB
 * console baseline — for code that cannot run until a query does. Both call
 * sites are already inside an async `queryFn`, so awaiting the module there
 * overlaps a chunk fetch with work the query was going to do anyway, and the
 * route measures 171 kB. It is the same module the install pane loads, so a
 * wearer who walks the guided flow into the installer pays for it once.
 *
 * `isPinReleaseError` stays static, deliberately. `release` is a `useMemo`,
 * not a query: it has to tell "no release was ever published" from "we could
 * not ask", and that verdict is an `instanceof` against `PinReleaseError`,
 * read synchronously off a value the query already produced. Narrowing it
 * structurally instead would put a second, drifting copy of the error contract
 * in this file. It costs 4 kB of the 171 — measured by deleting it — which is
 * not worth a duplicated contract.
 */
const installerBrain = () => import("@/lib/pin-install");

/** How recently a Pin must have reported to count as online. Matches /settings/account/devices. */
export const PIN_REPORT_FRESHNESS_MS = 10 * 60 * 1000;

const SETUP_QUERY_KEY = "pin-setup";

/** `Settings.Global` keys written by the on-device activation transaction. */
const REMOTE_MODE_SETTING = "penumbra_carry_remote_mode";
const EDGE_IPV4_SETTING = "penumbra_carry_edge_ipv4";

interface PairedPinsResponse {
  devices: Array<{ deviceId: string; pairedAt: number | null }>;
}

interface DeviceStatusResponse {
  devices: Array<{ device_id: string; reported_at_epoch: number }>;
  state: "live" | "absent" | "degraded";
}

/** `settings get` prints the literal string "null" for an unset key. */
function readSettingsValue(stdout: string): string | null {
  const value = stdout.trim();
  if (!value || value === "null") return null;
  return value;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PinSetupReadings {
  readonly facts: PinSetupFacts;
  /** The resolved release, when there is one — the installer's own target. */
  readonly target: ResolvedInstallTarget | null;
  /** The raw inspection, for the package table. */
  readonly inspection: InstallInspectionResult | null;
  /** Epoch ms of the most recent report from a paired Pin. */
  readonly lastReportAtEpoch: number | null;
  /** Re-read everything this page shows. */
  readonly refresh: () => void;
  readonly refreshing: boolean;
}

export function usePinSetupFacts(options: { operator: boolean }): PinSetupReadings {
  const queryClient = useQueryClient();
  const { status, serviceStatus, connectionInfo, identity, support, borrowSession } =
    usePinDevice();
  const deviceSettings = useDeviceSettings("pin-setup");

  const connected = status === "connected";
  const serial = connectionInfo?.serial ?? null;

  /*
   * The published release. Independent of any device: a newcomer with no Pin in
   * hand can still find out that this Center has nothing to install, which is
   * the failure `docs/operations.md` records as the one that "fails quietly and
   * blames the wrong layer".
   */
  const releaseQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "release"],
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => (await installerBrain()).resolveInstallTarget(),
  });

  /*
   * `retry: 1` here and on the activation read is not flakiness tolerance, it
   * is an ordering fix. React runs a child's effects BEFORE its parent's, and
   * the provider that publishes the borrowable session lives in the layout
   * above this page — so on the very render where the session becomes
   * "connected", a query started from here can reach `borrowSession()` a beat
   * before the provider has one to hand out. One retry lands after that effect
   * and the fetch succeeds; a device that is genuinely unreadable still fails,
   * one attempt later.
   */
  const inspectionQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "inspection", serial, releaseQuery.data?.releaseId ?? null],
    enabled: connected && !releaseQuery.isLoading,
    staleTime: 30_000,
    retry: 1,
    retryDelay: 400,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      (await installerBrain()).inspectInstallState(borrowSession(), {
        target: releaseQuery.data ?? null,
        readinessSettleDelayMs: 0,
      }),
  });

  /*
   * Clone mode, read straight off the device.
   *
   * `penumbra_carry_remote_mode` is written LAST by the on-device activation
   * transaction, as its commit gate, so reading it is the honest answer to
   * "is this Pin talking to our stack" — and a read is all this page ever does.
   * Writing these keys by hand is exactly what the runtime's journalled
   * transaction exists to prevent.
   */
  /**
   * Where a Pin must point to reach THIS deployment. Server-declared, because
   * the device can only tell us where it IS pointed — and a step that reports
   * "done" for a Pin aimed at somebody else's server is worse than no step.
   */
  const expectedEdgeQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "expected-edge"],
    staleTime: 300_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<{ edgeIpv4: string | null }> => {
      const response = await fetch("/api/pin/edge", { cache: "no-store" });
      if (!response.ok) return { edgeIpv4: null };
      return (await response.json()) as { edgeIpv4: string | null };
    },
  });

  const activationQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "activation", serial],
    enabled: connected,
    staleTime: 30_000,
    retry: 1,
    retryDelay: 400,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const session = borrowSession();
      const [mode, edge] = await Promise.all([
        session.shell(["settings", "get", "global", REMOTE_MODE_SETTING]),
        session.shell(["settings", "get", "global", EDGE_IPV4_SETTING]),
      ]);
      return {
        remoteMode: readSettingsValue(mode.stdout),
        edgeIpv4: readSettingsValue(edge.stdout),
      };
    },
  });

  // The same two cache entries /settings/account/devices uses, so opening both
  // surfaces does not double the backend traffic and they can never disagree.
  const pairingsQuery = useQuery({
    queryKey: ["paired-pins"],
    staleTime: 10_000,
    queryFn: async () => {
      const response = await fetch("/api/devices/pair", { cache: "no-store" });
      if (!response.ok) throw new Error(`/api/devices/pair → ${response.status}`);
      return (await response.json()) as PairedPinsResponse;
    },
  });

  const statusQuery = useQuery({
    queryKey: ["device-status"],
    staleTime: 10_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const response = await fetch("/api/devices/status", { cache: "no-store" });
      if (!response.ok) throw new Error(`/api/devices/status → ${response.status}`);
      return (await response.json()) as DeviceStatusResponse;
    },
  });

  const release = useMemo<PinSetupReleaseFacts>(() => {
    // Data first, deliberately: a background refetch must not flip a published
    // release back to "checking…" and make the page look like it forgot.
    if (releaseQuery.data) {
      return { availability: "published", version: releaseQuery.data.version, detail: null };
    }
    if (releaseQuery.isFetching) {
      return { availability: "checking", version: null, detail: null };
    }
    if (releaseQuery.isError) {
      const error = releaseQuery.error;
      /*
       * A 404 is not a failure of this page: it is "no release was ever
       * published to this server", and it is the single most common reason the
       * install pane offers nothing. It gets its own status so the UI can name
       * the commands instead of showing a retry that cannot help.
       */
      if (isPinReleaseError(error) && error.code === "release-manifest-fetch-failed") {
        if (error.status === 404) {
          return { availability: "not-published", version: null, detail: null };
        }
        return {
          availability: "unreadable",
          version: null,
          detail: error.message,
        };
      }
      return { availability: "unreadable", version: null, detail: toMessage(error) };
    }
    return { availability: "unknown", version: null, detail: null };
  }, [releaseQuery.data, releaseQuery.error, releaseQuery.isError, releaseQuery.isFetching]);

  const install = useMemo<PinSetupInstallFacts>(() => {
    const empty = {
      rolesTotal: 4,
      rolesInstalled: 0,
      rolesMatchingTarget: 0,
      unhealthyRoles: 0,
      conflicts: 0,
      deviceLocked: null,
      detail: null,
    } as const;

    if (!connected) return { state: "unknown", ...empty };

    const inspection = inspectionQuery.data;
    if (!inspection) {
      if (inspectionQuery.isFetching) return { state: "checking", ...empty };
      if (inspectionQuery.isError) {
        return { state: "failed", ...empty, detail: toMessage(inspectionQuery.error) };
      }
      return { state: "unknown", ...empty };
    }

    const packages = Object.values(inspection.packages);
    const credential = inspection.readiness.credentialState.state;
    return {
      state: "read",
      rolesTotal: packages.length,
      rolesInstalled: packages.filter((entry) => entry.installed).length,
      rolesMatchingTarget: packages.filter(
        (entry) => entry.installed && entry.healthy && entry.versionComparison === "equal",
      ).length,
      unhealthyRoles: packages.filter((entry) => entry.installed && !entry.healthy).length,
      conflicts: inspection.detectedConflicts.filter(
        (conflict) => conflict.installedPackageIds.length > 0,
      ).length,
      deviceLocked: credential === "unknown" ? null : credential === "locked",
      detail: null,
    };
  }, [connected, inspectionQuery.data, inspectionQuery.error, inspectionQuery.isError, inspectionQuery.isFetching]);

  const server = useMemo<PinSetupServerFacts>(() => {
    const llm = deviceSettings.settings?.llm;
    const keyPresent =
      llm === undefined
        ? null
        : llm.has_api_key === true ||
          (llm.codex_custom_active === true && llm.has_codex_api_key === true);
    return {
      answering: serviceStatus,
      assistantProvider: llm?.provider ?? null,
      assistantModel: llm?.model ?? null,
      assistantKeyPresent: keyPresent,
    };
  }, [deviceSettings.settings, serviceStatus]);

  const activation = useMemo<PinSetupActivationFacts>(() => {
    if (!connected) return { state: "unknown", edgeIpv4: null, expectedEdgeIpv4: null, detail: null };
    const data = activationQuery.data;
    if (!data) {
      if (activationQuery.isFetching) return { state: "checking", edgeIpv4: null, expectedEdgeIpv4: null, detail: null };
      if (activationQuery.isError) {
        return { state: "unreadable", edgeIpv4: null, expectedEdgeIpv4: null, detail: toMessage(activationQuery.error) };
      }
      return { state: "unknown", edgeIpv4: null, expectedEdgeIpv4: null, detail: null };
    }
    return {
      state: data.remoteMode === "1" ? "active" : "inactive",
      edgeIpv4: data.edgeIpv4,
      expectedEdgeIpv4: expectedEdgeQuery.data?.edgeIpv4 ?? null,
      detail: null,
    };
  }, [activationQuery.data, activationQuery.error, activationQuery.isError, activationQuery.isFetching, connected, expectedEdgeQuery.data]);

  const { cloud, lastReportAtEpoch } = useMemo(() => {
    const now = Date.now();
    const statuses = statusQuery.data?.devices ?? [];
    const reporting = statuses.filter(
      (entry) => now - entry.reported_at_epoch * 1000 < PIN_REPORT_FRESHNESS_MS,
    );
    const latest = statuses.reduce<number | null>(
      (newest, entry) =>
        newest === null || entry.reported_at_epoch > newest ? entry.reported_at_epoch : newest,
      null,
    );

    /*
     * ABSENCE IS CHECKED FIRST, and it has to be. On a deployment with no
     * backend configured, /api/devices/status answers 200 with `absent` while
     * /api/devices/pair answers 503 — so an error-first branch would report a
     * DEGRADED backend, sending a newcomer to debug an outage in a deployment
     * that was never wired to one. `absent` is a fact about the deployment;
     * `degraded` is a fact about a runtime call. They are different sentences.
     */
    let state: PinSetupCloudFacts["state"] = "unknown";
    if (statusQuery.data?.state === "absent") {
      state = "absent";
    } else if (pairingsQuery.isError || statusQuery.isError || statusQuery.data?.state === "degraded") {
      state = "degraded";
    } else if (pairingsQuery.data && statusQuery.data) {
      state = "live";
    }

    return {
      cloud: {
        state,
        pairedCount: pairingsQuery.data?.devices.length ?? null,
        reportingCount: reporting.length,
        lastReportAtEpoch: latest,
      } satisfies PinSetupCloudFacts,
      lastReportAtEpoch: latest === null ? null : latest * 1000,
    };
  }, [pairingsQuery.data, pairingsQuery.isError, statusQuery.data, statusQuery.isError]);

  const facts = useMemo<PinSetupFacts>(
    () => ({
      usb: {
        browserSupported: support === null ? null : support.supported,
        connected,
        connecting: status === "connecting",
        recognizedAiPin: identity === null ? null : identity.recognizedAiPin,
        serial,
      },
      release,
      install,
      server,
      activation,
      cloud,
      operator: options.operator,
    }),
    [activation, cloud, connected, identity, install, options.operator, release, serial, server, status, support],
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [SETUP_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: ["paired-pins"] });
    void queryClient.invalidateQueries({ queryKey: ["device-status"] });
    deviceSettings.reload();
    logInfo("pin-setup", "Re-reading Pin setup state on request");
  }, [deviceSettings, queryClient]);

  return {
    facts,
    target: releaseQuery.data ?? null,
    inspection: inspectionQuery.data ?? null,
    lastReportAtEpoch,
    refresh,
    refreshing:
      releaseQuery.isFetching ||
      inspectionQuery.isFetching ||
      activationQuery.isFetching ||
      pairingsQuery.isFetching ||
      statusQuery.isFetching,
  };
}
