"use client";

/**
 * The readings behind the guided flow.
 *
 * Every fact the plan is derived from is READ here, from the thing that is
 * actually authoritative for it:
 *
 *   is a Pin connected     the shared WebUSB/ADB session, via PinDeviceProvider
 *   is it online, and is   `cmd wifi status`, Android's validated networks, and
 *   its clock right        `date` over that session, against Center's own clock
 *   is a release published `/api/pin/releases/current`, through the same
 *                          manifest verifier the installer uses, so "published"
 *                          here means the same thing it means there
 *   what is installed      `inspectInstallState()` over the borrowed session
 *   is the server up       the provider's own health probe over that session
 *   are services ready     `/api/assistant/status`, the Pin's own playback
 *                          status, and authenticated music-provider status
 *   is it pointed at us    `Settings.Global penumbra_cosmos_remote_mode`, read
 *                          over ADB and never written from here
 *   did its own setup run  `Settings.Global humane.settings.global.DUC_PROVISIONED`
 *   is a passcode set      `/api/account/passcode`, the same read Settings uses
 *   is it reporting        `/api/devices/pair` + `/api/devices/status`, the same
 *                          two endpoints /settings/account/devices reads
 *   is remote access on    `/api/pin/bridge`: whether Center's remote link
 *                          points at the Pin attached over USB
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
import { useAssistantStatus } from "@/components/AiMicChat";
import {
  musicPlaybackReadiness,
  readCenterClock,
  readPinClock,
  readPinNetwork,
} from "@/lib/pin-setup";
import {
  setupAcceptanceConfirmed,
  setupAcceptanceRequest,
  setupAcceptanceTarget,
} from "@/lib/pin-setup/acceptance";
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
  PinSetupNetworkFacts,
  PinSetupPasscodeFacts,
  PinSetupReleaseFacts,
  PinSetupRemoteFacts,
  PinSetupServerFacts,
} from "@/lib/pin-setup";
import { connectedPinReport } from "@/lib/pin-setup/reporting";
import { useDeviceStatus, usePairedPins, usePasscodeState } from "@/lib/queries";
import { connectedDeviceId } from "../provision/browserActivation";
import { usePinDevice } from "../PinDeviceProvider";
import { pinClientIdentity } from "../_lib/pinSession";

/**
 * The installer brain is loaded ON DEMAND, not with the page.
 *
 * `resolveInstallTarget` and `inspectInstallState` reach the whole installer
 * pipeline: the release manifest verifier, the Tier-A symbol table, the package
 * inspector, the conflict rules. Statically imported, all of it sat in this
 * route's FIRST LOAD, /settings/pin/setup measured 181 kB against a 156 kB
 * console baseline, for code that cannot run until a query does. Both call
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
 * in this file. It costs 4 kB of the 171, measured by deleting it, which is
 * not worth a duplicated contract.
 */
const installerBrain = () => import("@/lib/pin-install");

/** How recently a Pin must have reported to count as online. Matches /settings/account/devices. */
export const PIN_REPORT_FRESHNESS_MS = 10 * 60 * 1000;

const SETUP_QUERY_KEY = "pin-setup";

/** `Settings.Global` keys written by the on-device activation transaction. */
const REMOTE_MODE_SETTING = "penumbra_cosmos_remote_mode";
const EDGE_IPV4_SETTING = "penumbra_cosmos_edge_ipv4";
/** Written by stock onboarding as its last act. See `PinSetupOnboardingFacts`. */
const STOCK_SETUP_COMPLETE_SETTING = "humane.settings.global.DUC_PROVISIONED";

type ExpectedEdgeRead =
  | { readonly state: "available"; readonly edgeIpv4: string }
  | { readonly state: "absent" | "invalid" | "unreadable"; readonly edgeIpv4: null };

function parseExpectedEdgeResponse(payload: unknown, responseOk: boolean): ExpectedEdgeRead {
  if (!payload || typeof payload !== "object") {
    return { state: "unreadable", edgeIpv4: null };
  }
  const value = payload as { state?: unknown; edgeIpv4?: unknown };
  if (responseOk && value.state === "absent" && value.edgeIpv4 === null) {
    return { state: "absent", edgeIpv4: null };
  }
  if (
    responseOk &&
    value.state === "available" &&
    typeof value.edgeIpv4 === "string"
  ) {
    return { state: "available", edgeIpv4: value.edgeIpv4 };
  }
  if (!responseOk && value.state === "invalid" && value.edgeIpv4 === null) {
    return { state: "invalid", edgeIpv4: null };
  }
  return { state: "unreadable", edgeIpv4: null };
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
  /** The resolved release, when there is one, the installer's own target. */
  readonly target: ResolvedInstallTarget | null;
  /** The raw inspection, for the package table. */
  readonly inspection: InstallInspectionResult | null;
  /** Epoch ms of the most recent report from the attached Pin. */
  readonly lastReportAtEpoch: number | null;
  /** Re-read everything this page shows. */
  readonly refresh: () => void;
  /** Persist and read back this wearer's observation on the exact USB-attached Pin. */
  readonly confirmAcceptance: () => Promise<void>;
  readonly refreshing: boolean;
}

export function usePinSetupFacts(options: { operator: boolean }): PinSetupReadings {
  const queryClient = useQueryClient();
  const {
    status,
    connectionMode,
    serviceStatus,
    connectionInfo,
    identity,
    support,
    client,
    borrowSession,
    refreshService,
  } = usePinDevice();
  const assistantStatus = useAssistantStatus();

  const connected = status === "connected";
  const serial = connectionInfo?.serial ?? null;

  /*
   * Network and clock, read over the same USB session and compared with
   * Center's own clock. Plain ADB shell, so it works on a stock Pin before
   * anything is installed, which is exactly when it matters.
   */
  const networkQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "network", serial],
    enabled: connected,
    staleTime: 15_000,
    retry: 1,
    retryDelay: 400,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const session = borrowSession();
      const [reading, center] = await Promise.all([
        readPinNetwork(session),
        readCenterClock(),
      ]);
      return { ...reading, ...(await readPinClock(session, center)) };
    },
  });

  // Release availability is independent of the attached device.
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
   * above this page, so on the very render where the session becomes
   * "connected", a query started from here can reach `borrowSession()` a beat
   * before the provider has one to hand out. One retry lands after that effect
   * and the fetch succeeds. A device that is genuinely unreadable still fails,
   * one attempt later.
   */
  const inspectionQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "inspection", serial, releaseQuery.data?.releaseId ?? null],
    enabled: connected && !releaseQuery.isLoading,
    staleTime: 30_000,
    retry: 1,
    retryDelay: 400,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const brain = await installerBrain();
      const inspection = await brain.inspectInstallState(borrowSession(), {
        target: releaseQuery.data ?? null,
        readinessSettleDelayMs: 0,
      });
      return {
        inspection,
        expectedSignerIdentity: brain.PIN_RELEASE_SIGNER_IDENTITY,
      };
    },
  });

  /*
   * Clone mode, read straight off the device.
   *
   * `penumbra_cosmos_remote_mode` is written LAST by the on-device activation
   * transaction, as its commit gate, so reading it is the honest answer to
   * "is this Pin talking to our stack", and a read is all this page ever does.
   * Writing these keys by hand is exactly what the runtime's journalled
   * transaction exists to prevent.
   */
  /**
   * Where a Pin must point to reach THIS deployment. Server-declared, because
   * the device can only tell us where it IS pointed, and a step that reports
   * "done" for a Pin aimed at somebody else's server is worse than no step.
   */
  const expectedEdgeQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "expected-edge"],
    staleTime: 300_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ExpectedEdgeRead> => {
      const response = await fetch("/api/pin/edge", { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      return parseExpectedEdgeResponse(payload, response.ok);
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
      const [mode, edge, stockSetup, deviceId] = await Promise.all([
        session.shell(["settings", "get", "global", REMOTE_MODE_SETTING]),
        session.shell(["settings", "get", "global", EDGE_IPV4_SETTING]),
        session.shell(["settings", "get", "global", STOCK_SETUP_COMPLETE_SETTING]),
        connectedDeviceId(session),
      ]);
      return {
        remoteMode: readSettingsValue(mode.stdout),
        edgeIpv4: readSettingsValue(edge.stdout),
        stockSetupComplete: readSettingsValue(stockSetup.stdout) === "1",
        deviceId,
      };
    },
  });

  const acceptanceTarget = useMemo(
    () => setupAcceptanceTarget(
      serial,
      releaseQuery.data?.releaseId ?? null,
      releaseQuery.data?.version ?? null,
      activationQuery.data?.edgeIpv4 ?? null,
    ),
    [
      activationQuery.data?.edgeIpv4,
      releaseQuery.data?.releaseId,
      releaseQuery.data?.version,
      serial,
    ],
  );
  const acceptanceQueryKey = useMemo(
    () => [
      SETUP_QUERY_KEY,
      "acceptance",
      acceptanceTarget?.deviceSerial ?? null,
      acceptanceTarget?.releaseId ?? null,
      acceptanceTarget?.releaseVersion ?? null,
      acceptanceTarget?.edgeIpv4 ?? null,
    ] as const,
    [acceptanceTarget],
  );
  const acceptanceQuery = useQuery({
    queryKey: acceptanceQueryKey,
    enabled:
      connected &&
      connectionMode === "usb" &&
      serviceStatus === "online" &&
      client !== null &&
      activationQuery.data?.remoteMode === "1" &&
      acceptanceTarget !== null,
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!client) throw new Error("The Pin acceptance service is unavailable.");
      return client.getSetupAcceptance();
    },
  });

  // The same two cache entries /settings/account/devices uses, so opening both
  // surfaces does not double the backend traffic and they can never disagree.
  const pairingsQuery = usePairedPins();

  // The same cache entry Settings → Passcode uses, so the two never disagree.
  const passcodeQuery = usePasscodeState();

  const statusQuery = useDeviceStatus();

  /*
   * Music is the one capability whose authority is split by design. The Pin
   * reports its selected playback runtime over the same USB tunnel as every
   * other local setting. Center separately reports the signed-in wearer's
   * provider connection. Requiring both prevents a working catalog account
   * from being presented as working playback on this Pin.
   */
  // Only this Pin's own USB client answers for it: just after USB connects,
  // the previous remote client may still be another Pin.
  const pinMusicQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "pin-music", serial, pinClientIdentity(client)],
    enabled: connected && connectionMode === "usb" && serviceStatus === "online" && client !== null,
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!client) throw new Error("The Pin music service is unavailable.");
      return client.getSpotifyStatus();
    },
  });

  const musicProvidersQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "music-providers"],
    enabled: connected && serviceStatus === "online",
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<unknown> => {
      const response = await fetch("/api/settings/services/music", {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`/api/settings/services/music → ${response.status}`);
      }
      return response.json();
    },
  });

  /*
   * Center's remote link. A non-OK answer (no link on this server, or one
   * that is not this wearer's) is "unavailable": Guided setup cannot change
   * it, so it does not hold setup back.
   */
  const remoteQuery = useQuery({
    queryKey: [SETUP_QUERY_KEY, "remote-access"],
    enabled: connected,
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<{ assignedDeviceId: string | null } | null> => {
      const response = await fetch("/api/pin/bridge", { cache: "no-store" });
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as
        | { configured?: unknown; device_id?: unknown }
        | null;
      if (!body || typeof body.configured !== "boolean") return null;
      return {
        assignedDeviceId:
          body.configured && typeof body.device_id === "string" ? body.device_id : null,
      };
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

  const network = useMemo<PinSetupNetworkFacts>(() => {
    const empty = {
      wifiEnabled: null,
      wifiNetwork: null,
      online: null,
      transport: null,
      pinTimeEpochMs: null,
      clockSkewMs: null,
      detail: null,
    } as const;
    if (!connected) return { state: "unknown", ...empty };
    const data = networkQuery.data;
    if (data) {
      return {
        state: "read",
        wifiEnabled: data.wifiEnabled,
        wifiNetwork: data.wifiNetwork,
        online: data.online,
        transport: data.transport,
        pinTimeEpochMs: data.pinTimeEpochMs,
        clockSkewMs: data.skewMs,
        detail: null,
      };
    }
    if (networkQuery.isFetching) return { state: "checking", ...empty };
    if (networkQuery.isError) {
      return { state: "unreadable", ...empty, detail: toMessage(networkQuery.error) };
    }
    return { state: "unknown", ...empty };
  }, [connected, networkQuery.data, networkQuery.error, networkQuery.isError, networkQuery.isFetching]);

  const passcode = useMemo<PinSetupPasscodeFacts>(() => {
    const set = passcodeQuery.data?.set;
    if (set === true) return { state: "set" };
    if (set === false) return { state: "not-set" };
    if (passcodeQuery.data || passcodeQuery.isError) return { state: "unreadable" };
    return { state: "unknown" };
  }, [passcodeQuery.data, passcodeQuery.isError]);

  const install = useMemo<PinSetupInstallFacts>(() => {
    const empty = {
      rolesTotal: 5,
      rolesInstalled: 0,
      rolesMatchingTarget: 0,
      installerState: "unknown",
      runtimeRolesNewerThanTarget: 0,
      unhealthyRoles: 0,
      conflicts: 0,
      deviceLocked: null,
      detail: null,
    } as const;

    if (!connected) return { state: "unknown", ...empty };

    const inspection = inspectionQuery.data?.inspection;
    if (!inspection) {
      if (inspectionQuery.isFetching) return { state: "checking", ...empty };
      if (inspectionQuery.isError) {
        return { state: "failed", ...empty, detail: toMessage(inspectionQuery.error) };
      }
      return { state: "unknown", ...empty };
    }

    const packages = Object.values(inspection.packages);
    const runtimePackages = packages.filter((entry) => entry.role !== "installer");
    const installer = inspection.packages.installer;
    const installerTrusted =
      installer.installed &&
      installer.healthy &&
      installer.signerIdentity === inspectionQuery.data?.expectedSignerIdentity;
    const installerState: PinSetupInstallFacts["installerState"] = installerTrusted
      ? installer.versionComparison === "equal"
        ? "target"
        : installer.versionComparison === "older"
          ? "retained"
          : "unsupported"
      : "unsupported";
    const credential = inspection.readiness.credentialState.state;
    return {
      state: "read",
      rolesTotal: packages.length,
      rolesInstalled: packages.filter((entry) => entry.installed).length,
      rolesMatchingTarget: packages.filter(
        (entry) => entry.installed && entry.healthy && entry.versionComparison === "equal",
      ).length,
      installerState,
      runtimeRolesNewerThanTarget: runtimePackages.filter(
        (entry) => entry.installed && entry.versionComparison === "newer",
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
    const assistant = assistantStatus.data;
    const cosmos = assistant?.provider_authority === "cosmos";
    const toolReady = (name: string): boolean | null => {
      if (!cosmos || !assistant) return null;
      const [match, ...others] = assistant.tools.filter((tool) => tool.name === name);
      return match && others.length === 0 ? match.live : null;
    };
    const foodLookup = toolReady("food_lookup");
    const foodMemory = toolReady("remember");
    return {
      // With USB attached, only the USB client speaks for this Pin. A remote
      // client in its place is another path, possibly to another Pin.
      answering: connected && connectionMode !== "usb" ? "unknown" : serviceStatus,
      assistantModel: cosmos ? assistant.model : null,
      capabilities: {
        assistant: cosmos ? assistant.assistant : null,
        speech: cosmos ? assistant.speech : null,
        weather: toolReady("weather"),
        nearbyNavigation: toolReady("nearby"),
        musicPlayback: musicPlaybackReadiness(
          pinMusicQuery.data,
          musicProvidersQuery.data,
        ),
        foodLogging:
          foodLookup === null || foodMemory === null
            ? null
            : foodLookup && foodMemory,
      },
    };
  }, [
    assistantStatus.data,
    connected,
    connectionMode,
    musicProvidersQuery.data,
    pinMusicQuery.data,
    serviceStatus,
  ]);

  const remote = useMemo<PinSetupRemoteFacts>(() => {
    if (remoteQuery.data === null || remoteQuery.isError) return { state: "unavailable" };
    const deviceId = activationQuery.data?.deviceId ?? null;
    if (!remoteQuery.data || deviceId === null) return { state: "unknown" };
    // The route answers `configured` only for a Pin paired with this account,
    // so a different device here is the wearer's other Pin.
    const assigned = remoteQuery.data.assignedDeviceId;
    return {
      state: assigned === deviceId ? "assigned" : assigned === null ? "unassigned" : "elsewhere",
    };
  }, [activationQuery.data?.deviceId, remoteQuery.data, remoteQuery.isError]);

  const activation = useMemo<PinSetupActivationFacts>(() => {
    const expected = expectedEdgeQuery.data;
    const expectedEdgeState: PinSetupActivationFacts["expectedEdgeState"] = expected
      ? expected.state
      : expectedEdgeQuery.isFetching
        ? "checking"
        : expectedEdgeQuery.isError
          ? "unreadable"
          : "unknown";
    if (!connected) {
      return {
        state: "unknown",
        edgeIpv4: null,
        expectedEdgeState,
        expectedEdgeIpv4: expected?.edgeIpv4 ?? null,
        detail: null,
      };
    }
    const data = activationQuery.data;
    if (!data) {
      if (activationQuery.isFetching) {
        return {
          state: "checking",
          edgeIpv4: null,
          expectedEdgeState,
          expectedEdgeIpv4: expected?.edgeIpv4 ?? null,
          detail: null,
        };
      }
      if (activationQuery.isError) {
        return {
          state: "unreadable",
          edgeIpv4: null,
          expectedEdgeState,
          expectedEdgeIpv4: expected?.edgeIpv4 ?? null,
          detail: toMessage(activationQuery.error),
        };
      }
      return {
        state: "unknown",
        edgeIpv4: null,
        expectedEdgeState,
        expectedEdgeIpv4: expected?.edgeIpv4 ?? null,
        detail: null,
      };
    }
    return {
      state: data.remoteMode === "1" ? "active" : "inactive",
      edgeIpv4: data.edgeIpv4,
      expectedEdgeState,
      expectedEdgeIpv4: expected?.edgeIpv4 ?? null,
      detail: null,
    };
  }, [
    activationQuery.data,
    activationQuery.error,
    activationQuery.isError,
    activationQuery.isFetching,
    connected,
    expectedEdgeQuery.data,
    expectedEdgeQuery.isError,
    expectedEdgeQuery.isFetching,
  ]);

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
    const connectedReport = connectedPinReport(
      statuses,
      serial,
      now,
      PIN_REPORT_FRESHNESS_MS,
    );
    const connectedDeviceId = activationQuery.data?.deviceId?.trim().toLowerCase() ?? null;
    const connectedPinPaired =
      connectedDeviceId === null || !pairingsQuery.data
        ? null
        : pairingsQuery.data.devices.some(
            (device) => device.deviceId.trim().toLowerCase() === connectedDeviceId,
          );

    /*
     * ABSENCE IS CHECKED FIRST, and it has to be. On a deployment with no
     * backend configured, /api/devices/status answers 200 with `absent` while
     * /api/devices/pair answers 503, so an error-first branch would report a
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
        connectedPinReporting: connectedReport.reporting,
        connectedPinLastReportAtEpoch: connectedReport.lastReportAtEpoch,
        connectedPinPaired,
      } satisfies PinSetupCloudFacts,
      lastReportAtEpoch: connectedReport.lastReportAtEpoch,
    };
  }, [
    activationQuery.data?.deviceId,
    pairingsQuery.data,
    pairingsQuery.isError,
    serial,
    statusQuery.data,
    statusQuery.isError,
  ]);

  const facts = useMemo<PinSetupFacts>(
    () => ({
      usb: {
        browserSupported: support === null ? null : support.supported,
        connected,
        connecting: status === "connecting",
        recognizedAiPin: identity === null ? null : identity.recognizedAiPin,
        serial,
        deviceId: activationQuery.data?.deviceId ?? null,
      },
      network,
      release,
      install,
      server,
      activation,
      cloud,
      remote,
      onboarding: {
        setupComplete:
          connected && activationQuery.data ? activationQuery.data.stockSetupComplete : null,
      },
      passcode,
      physicalAcceptanceConfirmed: setupAcceptanceConfirmed(
        acceptanceQuery.data,
        acceptanceTarget,
      ),
      operator: options.operator,
    }),
    [
      activation,
      activationQuery.data,
      acceptanceQuery.data,
      acceptanceTarget,
      cloud,
      connected,
      identity,
      install,
      network,
      options.operator,
      passcode,
      release,
      remote,
      serial,
      server,
      status,
      support,
    ],
  );

  const confirmAcceptance = useCallback(async () => {
    if (!client || connectionMode !== "usb" || !acceptanceTarget) {
      throw new Error(
        "Connect this exact Pin over USB and finish installation and activation first.",
      );
    }
    const response = await client.confirmSetupAcceptance(
      setupAcceptanceRequest(acceptanceTarget),
    );
    if (!setupAcceptanceConfirmed(response, acceptanceTarget)) {
      throw new Error("The Pin did not retain the physical acceptance confirmation.");
    }
    queryClient.setQueryData(acceptanceQueryKey, response);
  }, [acceptanceQueryKey, acceptanceTarget, client, connectionMode, queryClient]);

  const refresh = useCallback(() => {
    // Without USB, "Check again" is also the explicit retry of Center's remote
    // link, which is otherwise not asked again while it has no paired Pin. Not
    // while a USB session is opening: that session owns the page.
    if (status === "disconnected") void refreshService();
    void queryClient.invalidateQueries({ queryKey: [SETUP_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: ["paired-pins"] });
    void queryClient.invalidateQueries({ queryKey: ["device-status"] });
    void queryClient.invalidateQueries({ queryKey: ["account-passcode"] });
    void assistantStatus.refetch();
    logInfo("pin-setup", "Re-reading Pin setup state on request");
  }, [assistantStatus, queryClient, refreshService, status]);

  return {
    facts,
    target: releaseQuery.data ?? null,
    inspection: inspectionQuery.data?.inspection ?? null,
    lastReportAtEpoch,
    refresh,
    confirmAcceptance,
    refreshing:
      networkQuery.isFetching ||
      passcodeQuery.isFetching ||
      releaseQuery.isFetching ||
      inspectionQuery.isFetching ||
      activationQuery.isFetching ||
      pairingsQuery.isFetching ||
      statusQuery.isFetching ||
      assistantStatus.isFetching ||
      pinMusicQuery.isFetching ||
      musicProvidersQuery.isFetching ||
      remoteQuery.isFetching ||
      acceptanceQuery.isFetching,
  };
}
