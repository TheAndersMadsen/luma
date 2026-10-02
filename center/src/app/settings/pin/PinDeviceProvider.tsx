"use client";

import type { DeviceInfo } from "@/lib/pin-device";
import {
  PinApiError,
  PinClient,
  RemoteFetchPinTransport,
  logError,
  logInfo,
  logWarn,
} from "@/lib/pin-device";
import type {
  AdbConnectionInfo,
  AdbSessionTransport,
  BrowserSupportResult,
  DeviceIdentity,
} from "@/lib/pin-device/adb";
import { getBrowserSupport, getDeviceIdentity } from "@/lib/pin-device/adb";
import { watchPinEvents } from "@/lib/pin-device/events";
import {
  connectPinAdbSession,
  disconnectPinAdbSession,
  getPinClient,
  getTimedWearerPinAdbSession,
  usePinAdbSession,
} from "@/lib/pin-session";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * The React face of the one live device session, for the whole Pin console.
 *
 * Why a provider in a LAYOUT: App Router keeps a layout mounted while the user
 * moves between its child routes, so state hung here, the health monitor, the
 * event-stream subscription, the last-read device info, survives moving from
 * Connect to Install to eSIM to Diagnostics without re-probing the device on
 * every navigation.
 *
 * Why it does NOT own the WebUSB handle: `@/lib/pin-session` does, at module
 * scope. Two `Adb` handles cannot claim the same USB interface, so the installer
 * and the configuration panes have to share one, and the operator shell lives
 * OUTSIDE this layout at /admin/pin/terminal, where a provider-owned session
 * would already be gone. This component therefore reads and drives the shared
 * session. It never creates one and never disconnects one behind the user's
 * back. Because both sides read the same store, connecting on the install pane
 * shows up on the Connect pane and vice versa.
 *
 * Nothing is persisted. The SPA kept a Pin admin token in `localStorage`. The
 * USB transport is authorized by the ADB socket itself and carries no token, so
 * there is no credential to store and none is stored.
 */

/** The ADB session itself, is a device attached and authorized? */
export type PinDeviceStatus = "disconnected" | "connecting" | "connected";

/** The path currently containing ordinary Pin API requests. */
export type PinConnectionMode = "usb" | "remote" | null;

/**
 * The Pin's HTTP server, which is a SEPARATE question from the ADB session.
 *
 * A stock Pin without Luma answers ADB perfectly and has no Device Services
 * app, that is exactly the device the installer exists to prepare. So a failed
 * health probe must never fail the connection. It marks the service offline and
 * leaves the session up.
 */
export type PinServiceStatus = "unknown" | "checking" | "online" | "offline";

/**
 * Center's own answer that its remote link has no Pin this wearer may reach,
 * and that waiting will not change: none was ever paired with it
 * (`pin_not_paired`), the one it points at is no longer paired
 * (`pin_binding_invalid`), it belongs to another account (`wrong_owner`), or
 * this server has no working link at all (`bridge_not_configured`,
 * `bridge_misconfigured`). Only USB setup or the server's operator changes
 * these, so nothing polls while one holds.
 */
export type PinRemoteUnpaired =
  | "pin_not_paired"
  | "pin_binding_invalid"
  | "wrong_owner"
  | "bridge_not_configured"
  | "bridge_misconfigured";

/** Each terminal `reason`, with the status the remote route answers it with. */
const TERMINAL_REMOTE_REASONS: Readonly<Record<PinRemoteUnpaired, number>> = {
  pin_not_paired: 409,
  pin_binding_invalid: 409,
  wrong_owner: 403,
  bridge_not_configured: 503,
  bridge_misconfigured: 503,
};

export interface PinDeviceContextValue {
  /** ADB/WebUSB session state. */
  status: PinDeviceStatus;
  /** USB wins when attached. Otherwise Center uses the paired Iroh route. */
  connectionMode: PinConnectionMode;
  /** Whether the Pin's REST API is answering over that session. */
  serviceStatus: PinServiceStatus;
  /** Serial and product name reported by the ADB handshake. */
  connectionInfo: AdbConnectionInfo | null;
  /** `getprop` identity, including whether this really is an Ai Pin. */
  identity: DeviceIdentity | null;
  /** `GET /api/device`, once the server answers. */
  device: DeviceInfo | null;
  /** The Pin REST client, available once the tunnel is open. */
  client: PinClient | null;
  /** Last connection or liveness failure, in wearer-facing prose. */
  error: string | null;
  /** Set when Center reports no Pin paired with its remote link. Null otherwise. */
  remoteUnpaired: PinRemoteUnpaired | null;
  /** WebUSB availability. `null` until the browser check runs after mount. */
  support: BrowserSupportResult | null;
  /** Epoch ms of the last event-stream message, or null. */
  lastEventAt: number | null;
  /** Claim a device. MUST be called from a user gesture (`requestDevice`). */
  connect: () => Promise<void>;
  /** Release the device. The only thing that ever tears the session down. */
  disconnect: () => Promise<void>;
  clearError: () => void;
  /** Re-probe the Pin's HTTP server and refresh `device`. */
  refreshService: () => Promise<void>;
  /**
   * A non-owning view of the shared session for a pane that drives the device
   * directly. `connect()` is idempotent and `disconnect()` is a no-op, so a
   * pane that disposes its own transport on unmount cannot unplug the console.
   * Throws when nothing is connected.
   */
  borrowSession: () => AdbSessionTransport;
}

const PinDeviceContext = createContext<PinDeviceContextValue | null>(null);

export function usePinDevice(): PinDeviceContextValue {
  const value = useContext(PinDeviceContext);
  if (!value) {
    throw new Error("usePinDevice() must be used inside PinDeviceProvider.");
  }
  return value;
}

/**
 * Query keys under this prefix are invalidated whenever the Pin pushes an
 * event. Panes that read device state through React Query should key on
 * `[PIN_QUERY_KEY, "<pane>", …]` to get live refresh for free.
 */
export const PIN_QUERY_KEY = "pin-device";

const HEALTH_CHECK_INTERVAL_MS = 15_000;
const STREAM_STALE_MS = 45_000;
const HEALTH_PROBE_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_HEALTH_FAILURES = 3;

export const PIN_SERVICE_LOST_MESSAGE =
  "Your Pin is unavailable. We’ll reconnect when it’s available.";

function createRemotePinClient() {
  return new PinClient(new RemoteFetchPinTransport("/api/pin/remote"));
}

/**
 * The remote polling decision. A failed remote probe is usually worth asking
 * again: a sleeping or out-of-range Pin comes back by itself. Center saying its
 * link has no Pin to reach, or is not set up, is not, until USB setup or an
 * explicit retry. Read from the route's machine-readable `reason` together with
 * its status, never the status alone: a USB-only namespace answers 409 too, and
 * a bridge that is merely down answers 503.
 */
function remoteUnpairedReason(error: unknown): PinRemoteUnpaired | null {
  if (!(error instanceof PinApiError)) return null;
  try {
    const { reason } = JSON.parse(error.body) as { reason?: unknown };
    return typeof reason === "string" &&
      Object.hasOwn(TERMINAL_REMOTE_REASONS, reason) &&
      TERMINAL_REMOTE_REASONS[reason as PinRemoteUnpaired] === error.status
      ? (reason as PinRemoteUnpaired)
      : null;
  } catch {
    return null;
  }
}

/**
 * Ported verbatim from the SPA's health monitor so the policy stays reviewable:
 * a stream quiet for 45s is stale, and a stale stream plus three consecutive
 * failed health probes is a dead service.
 */
export function healthMonitorDecision(
  elapsedSinceActivityMs: number,
  consecutiveFailures: number,
): { isStale: boolean; shouldDrop: boolean } {
  const isStale = elapsedSinceActivityMs >= STREAM_STALE_MS;
  const shouldDrop = isStale && consecutiveFailures >= MAX_CONSECUTIVE_HEALTH_FAILURES;
  return { isStale, shouldDrop };
}

/**
 * Wrap the shared wearer session so a borrower cannot close it.
 *
 * A ported controller that owns its transport calls `connect()` on mount and
 * `disconnect()` in a cleanup effect. Against the shared session that cleanup
 * would release the USB device on every navigation. `connect()` is already
 * idempotent on a live session, so only `disconnect()` needs neutralising.
 *
 * What it does NOT do any more is contain the device-shell decision. `session` is
 * the wearer session from `@/lib/pin-session`, which has no `openPty` and no
 * free-form ADB service on it at all, so the refusal below is a tripwire rather
 * than the boundary: anything that casts its way past the type still gets an
 * error instead of full device control, and `verify/pin-terminal-gate.test.mjs` still
 * has a literal to pin. The boundary itself is the object the wearer tree can
 * obtain, which is the only thing a second pane reaching for the session, as
 * `InstallView` used to, can get hold of.
 */
function createBorrowedSession(session: AdbSessionTransport): AdbSessionTransport {
  const borrowed: AdbSessionTransport = {
    get connectionInfo() {
      return session.connectionInfo;
    },
    connect: () => session.connect(),
    reconnect: () => session.reconnect(),
    disconnect: async () => {
      // Deliberately nothing: releasing the device is an explicit user action.
    },
    shell: (command) => session.shell(command),
    shellWithInput: (command, input, options) =>
      session.shellWithInput(command, input, options),
    pushFile: (remotePath, file) => session.pushFile(remotePath, file),
    reboot: () => session.reboot(),
    openPty: () => {
      throw new Error(
        "The Pin device shell is an operator surface; open it at /admin/pin/terminal.",
      );
    },
    startCommandStream: (command, onLine) => session.startCommandStream(command, onLine),
  };

  // Only expose bridge tunnelling when the underlying session really has it,
  // `UsbAdbHttpTransport` fails closed on its absence, and that check has to
  // keep meaning what it says through the wrapper. `openBridgeSocket` takes one
  // of the Pin's two HTTP bridges, never an ADB service string, so forwarding
  // it cannot reach `shell:` the way the old `createSocket` passthrough did.
  if (session.openBridgeSocket) {
    borrowed.openBridgeSocket = (target) => session.openBridgeSocket!(target);
  }

  return borrowed;
}

export function PinDeviceProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  // The shared store, so a connection made anywhere (the install pane, a future
  // operator surface) is the same connection this console reports.
  const shared = usePinAdbSession();

  const [serviceStatus, setServiceStatus] = useState<PinServiceStatus>("unknown");
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [client, setClient] = useState<PinClient | null>(null);
  const [connectionMode, setConnectionMode] = useState<PinConnectionMode>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [remoteUnpaired, setRemoteUnpaired] = useState<PinRemoteUnpaired | null>(null);
  const [support, setSupport] = useState<BrowserSupportResult | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const borrowedSessionRef = useRef<AdbSessionTransport | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  // The client Pin requests currently take. A probe answers only for the client
  // it went through, so a result for any other one is stale and is dropped.
  const clientRef = useRef<PinClient | null>(null);

  const status: PinDeviceStatus =
    shared.status === "connected"
      ? "connected"
      : shared.status === "connecting"
        ? "connecting"
        : "disconnected";
  const connectionInfo = shared.connection;
  const serial = connectionInfo?.serial ?? null;
  const error = localError ?? shared.error;

  // WebUSB support reads `isSecureContext` and `navigator`, neither of which
  // exists during SSR. Deciding after mount keeps the server and client markup
  // identical instead of server-rendering a "not supported" panel.
  useEffect(() => {
    setSupport(getBrowserSupport());
  }, []);

  const adoptClient = useCallback((pinClient: PinClient | null) => {
    clientRef.current = pinClient;
    setClient(pinClient);
    setConnectionMode(pinClient ? (pinClient.mode === "usb" ? "usb" : "remote") : null);
  }, []);

  /*
   * With no paired Pin there is no remote client at all: nothing polls it, and
   * no pane mistakes "never paired" for "a Pin that went quiet".
   */
  const settleUnpaired = useCallback((reason: PinRemoteUnpaired) => {
    adoptClient(null);
    setRemoteUnpaired(reason);
    setServiceStatus("unknown");
    setDevice(null);
    setLocalError((current) => (current === PIN_SERVICE_LOST_MESSAGE ? null : current));
  }, [adoptClient]);

  const probeService = useCallback(async (pinClient: PinClient) => {
    const current = () => clientRef.current === pinClient;
    setServiceStatus("checking");
    try {
      await pinClient.health(AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS));
    } catch (probeError) {
      // A USB session that took over while this probe was in flight owns the
      // state now. A late remote failure must not overwrite it.
      if (!current()) return;
      logInfo("pin-device", "Pin HTTP server did not answer", {
        mode: pinClient.mode,
        errorName: probeError instanceof Error ? probeError.name : "UnknownError",
      });
      const unpaired = pinClient.mode === "remote" ? remoteUnpairedReason(probeError) : null;
      if (unpaired) {
        settleUnpaired(unpaired);
        return;
      }
      if (pinClient.mode === "remote") setRemoteUnpaired(null);
      setServiceStatus("offline");
      setDevice(null);
      return;
    }

    if (!current()) return;
    if (pinClient.mode === "remote") setRemoteUnpaired(null);
    lastActivityRef.current = Date.now();
    setServiceStatus("online");

    try {
      const deviceInfo = await pinClient.getDevice(AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS));
      if (current()) setDevice(deviceInfo);
    } catch (deviceError) {
      // Health answered, so the service is up. A failed /api/device read is a
      // missing detail, not a lost connection.
      logWarn("pin-device", "Could not read device info", {
        errorName: deviceError instanceof Error ? deviceError.name : "UnknownError",
      });
    }
  }, [settleUnpaired]);

  /*
   * Pick the best path without making the wearer pick a transport. A live USB
   * session wins because maintenance panes need it. With no USB session, the
   * signed Center route carries the same PinClient over the paired Iroh bridge.
   * That route is asked once each time USB goes away. With no paired Pin it is
   * not asked again until the next USB session ends or an explicit retry.
   */
  useEffect(() => {
    let cancelled = false;

    async function activateRemote(preserveUsbSession = false) {
      const pinClient = createRemotePinClient();
      if (cancelled) return;
      if (!preserveUsbSession) borrowedSessionRef.current = null;
      if (!preserveUsbSession) setIdentity(null);
      setLastEventAt(null);
      adoptClient(pinClient);
      await probeService(pinClient);
    }

    if (shared.status !== "connected" || !serial) {
      // A transient "connecting", the transport's own disconnect recovery,
      // must not tear down a working remote client while the chooser is open.
      if (shared.status !== "connecting") void activateRemote();
      return () => {
        cancelled = true;
      };
    }

    const timed = getTimedWearerPinAdbSession();
    borrowedSessionRef.current = createBorrowedSession(timed);
    lastActivityRef.current = Date.now();
    // Until this Pin's own client answers, nothing on screen may describe it
    // with the remote Pin's answers: that may be a different Pin entirely.
    adoptClient(null);
    setServiceStatus("unknown");
    setDevice(null);

    // Identity is a diagnosis, not a gate: an unrecognised device still gets a
    // session so the pane can say what it actually saw.
    void getDeviceIdentity(timed)
      .then((deviceIdentity) => {
        if (!cancelled) setIdentity(deviceIdentity);
      })
      .catch((identityError) => {
        logWarn("pin-device", "Could not read device identity", {
          errorName: identityError instanceof Error ? identityError.name : "UnknownError",
        });
      });

    void (async () => {
      try {
        const pinClient = await getPinClient();
        if (cancelled) return;
        adoptClient(pinClient);
        // A remote-link failure from before this session says nothing about it.
        setLocalError((current) => (current === PIN_SERVICE_LOST_MESSAGE ? null : current));
        // Nor does "no Pin paired": this session may be the one that pairs it.
        // The remote check after it ends decides again, instead of the old
        // answer claiming "not paired" for a Pin that just was.
        setRemoteUnpaired(null);
        await probeService(pinClient);
      } catch (tunnelError) {
        if (cancelled) return;
        logWarn("pin-device", "Could not open the HTTP-over-ADB tunnel", {
          errorName: tunnelError instanceof Error ? tunnelError.name : "UnknownError",
        });
        // A bad USB bridge must not take ordinary settings down when Iroh is
        // healthy. The physical session stays borrowed for recovery actions.
        await activateRemote(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-running on every transition INTO "connected" is deliberate: a
    // reconnect keeps the same serial, and the tunnel's maintenance nudge and
    // the identity read both have to happen again against the new connection.
    // `shared.status` is what makes that possible, the transport publishes
    // "connecting" then "connected" from inside its OWN reconnect, so a
    // same-serial recovery still moves a dependency. It did not, while the only
    // observer sat on a wrapper method the recovery path never called.
  }, [serial, shared.status, probeService, adoptClient]);

  const connect = useCallback(async () => {
    setLocalError(null);

    // No `await` before the picker is raised: the user gesture that invoked this
    // callback must still be active when the browser prompts.
    const browserSupport = getBrowserSupport();
    setSupport(browserSupport);
    if (!browserSupport.supported) {
      const message = browserSupport.reasons.join(" ");
      setLocalError(message);
      throw new Error(message);
    }

    try {
      await connectPinAdbSession();
      logInfo("pin-device", "USB session established");
    } catch (connectError) {
      logError("pin-device", "USB connect failed", {
        errorName: connectError instanceof Error ? connectError.name : "UnknownError",
      });
      // The shared store already carries the message. Rethrow so a caller can
      // stop its own spinner.
      throw connectError;
    }
  }, []);

  const disconnect = useCallback(async () => {
    setLocalError(null);
    logInfo("pin-device", "Releasing USB session");
    try {
      await disconnectPinAdbSession();
    } catch (disconnectError) {
      logWarn("pin-device", "Failed to close the USB session cleanly", {
        errorName: disconnectError instanceof Error ? disconnectError.name : "UnknownError",
      });
    }
  }, []);

  const refreshService = useCallback(async () => {
    setLocalError(null);
    const previousClient = clientRef.current;
    try {
      const pinClient =
        shared.status === "connected" && serial
          ? client?.mode === "usb"
            ? client
            : await getPinClient()
          : client ?? createRemotePinClient();
      if (clientRef.current !== previousClient) return;
      adoptClient(pinClient);
      await probeService(pinClient);
    } catch (tunnelError) {
      if (clientRef.current !== previousClient) return;
      setServiceStatus("offline");
      logWarn("pin-device", "Could not refresh the Pin connection", {
        errorName: tunnelError instanceof Error ? tunnelError.name : "UnknownError",
      });
    }
  }, [serial, shared.status, client, probeService, adoptClient]);

  const clearError = useCallback(() => setLocalError(null), []);

  const borrowSession = useCallback(() => {
    const borrowed = borrowedSessionRef.current;
    if (!borrowed) {
      throw new Error("No Pin is connected over USB.");
    }
    return borrowed;
  }, []);

  /*
   * The Pin's NDJSON event stream, turned into React Query invalidation.
   *
   * Each USB request opens its own ADB socket, so holding this one open does not
   * block anything else on the session.
   */
  useEffect(() => {
    if (!client || serviceStatus !== "online") return;

    if (client.mode !== "usb") return;
    return watchPinEvents(client, (changed) => {
      lastActivityRef.current = Date.now();
      setLastEventAt(Date.now());
      // Heartbeats prove liveness without changing any cached device data.
      if (changed) void queryClient.invalidateQueries({ queryKey: [PIN_QUERY_KEY] });
    });
  }, [client, serviceStatus, queryClient]);

  /*
   * Iroh's compatibility bridge buffers responses, so it cannot contain the
   * never-ending /api/events stream. Poll health instead and periodically
   * invalidate Pin queries. That also lets a sleeping Pin recover by itself.
   *
   * Only for a remote client, which exists only while Center has a paired Pin,
   * and never while a USB session is being opened: that session owns the
   * page, and a remote failure landing mid-connect would speak over it.
   */
  const usbConnecting = shared.status === "connecting";
  useEffect(() => {
    if (!client || client.mode !== "remote" || usbConnecting) return;

    const activeClient = client;
    let disposed = false;
    let probing = false;
    let consecutiveFailures = 0;

    // `clientRef` moves the moment a probe settles "unpaired" or USB takes
    // over. The re-render that tears this interval down comes later.
    const stale = () => disposed || clientRef.current !== activeClient;

    async function pollRemote() {
      if (probing || stale()) return;
      probing = true;
      try {
        await activeClient.health(AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS));
        if (stale()) return;
        consecutiveFailures = 0;
        lastActivityRef.current = Date.now();
        setServiceStatus("online");
        setLocalError((current) =>
          current === PIN_SERVICE_LOST_MESSAGE ? null : current,
        );
        try {
          const deviceInfo = await activeClient.getDevice(
            AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
          );
          if (!stale()) setDevice(deviceInfo);
        } catch (deviceError) {
          logWarn("pin-device", "Could not refresh remote device info", {
            errorName: deviceError instanceof Error ? deviceError.name : "UnknownError",
          });
        }
        void queryClient.invalidateQueries({ queryKey: [PIN_QUERY_KEY] });
      } catch (probeError) {
        if (stale()) return;
        const unpaired = remoteUnpairedReason(probeError);
        if (unpaired) {
          settleUnpaired(unpaired);
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_HEALTH_FAILURES) {
          setServiceStatus("offline");
          setDevice(null);
          setLocalError(PIN_SERVICE_LOST_MESSAGE);
        }
        logInfo("pin-device", "Remote Pin health probe failed", {
          failures: consecutiveFailures,
          errorName: probeError instanceof Error ? probeError.name : "UnknownError",
        });
      } finally {
        probing = false;
      }
    }

    const intervalId = setInterval(() => void pollRemote(), HEALTH_CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(intervalId);
    };
  }, [client, usbConnecting, queryClient, settleUnpaired]);

  // INFERRED Luma recovery: losing Device Services does not lose ADB. Keep
  // probing the attached Pin so the offline message's promise to reconnect is
  // real. No USB chooser, runtime restart, or account change is involved.
  useEffect(() => {
    if (!client || client.mode !== "usb" || serviceStatus !== "offline" || status !== "connected") return;
    const activeClient = client;
    let disposed = false;
    let probing = false;
    const controller = new AbortController();
    const intervalId = setInterval(async () => {
      if (disposed || probing || clientRef.current !== activeClient) return;
      probing = true;
      try {
        await activeClient.health(AbortSignal.any([controller.signal, AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)]));
        if (disposed || clientRef.current !== activeClient) return;
        const info = await activeClient.getDevice(AbortSignal.any([controller.signal, AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)])).catch(() => null);
        if (disposed || clientRef.current !== activeClient) return;
        lastActivityRef.current = Date.now();
        setLocalError((current) => current === PIN_SERVICE_LOST_MESSAGE ? null : current);
        setDevice(info);
        setServiceStatus("online");
        void queryClient.invalidateQueries({ queryKey: [PIN_QUERY_KEY] });
      } catch {
        // Still offline. The next bounded probe retries while USB is attached.
      } finally {
        probing = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    return () => { disposed = true; clearInterval(intervalId); controller.abort(); };
  }, [client, serviceStatus, status, queryClient]);

  /*
   * Liveness. Unlike the SPA this never drops the USB session, the device is
   * physically attached and the installer may be mid-reboot. It downgrades the
   * SERVICE, which is the thing that actually stopped answering.
   */
  useEffect(() => {
    if (!client || serviceStatus !== "online") return;

    const activeClient = client;
    if (activeClient.mode !== "usb") return;
    let consecutiveFailures = 0;
    let staleIntervals = 0;
    let probing = false;
    let probeStartedAt = 0;
    let probeGeneration = 0;
    let disposed = false;
    let probeController: AbortController | null = null;

    const intervalId = setInterval(async () => {
      if (disposed) return;

      /*
       * Defence in depth for the `probing` latch. `HEALTH_PROBE_TIMEOUT_MS`
       * now reaches the USB transport, so a probe should always settle, but
       * if one ever wedges anyway, the latch used to have no escape: every
       * later tick returned here, `staleIntervals` stopped incrementing, the
       * `streamHung` branch below could never fire, and the monitor was
       * retired for good while `serviceStatus` stayed "online" for a Pin that
       * answered nothing. A probe still outstanding a whole interval later is
       * a failure. Abandon it and continue.
       */
      if (probing) {
        if (Date.now() - probeStartedAt <= HEALTH_CHECK_INTERVAL_MS) return;
        logWarn("pin-device", "Health probe did not settle; abandoning it", {
          elapsedMs: Date.now() - probeStartedAt,
        });
        probeController?.abort();
        probeController = null;
        probing = false;
        consecutiveFailures += 1;
      }

      const { isStale } = healthMonitorDecision(
        Date.now() - lastActivityRef.current,
        consecutiveFailures,
      );
      if (!isStale) {
        consecutiveFailures = 0;
        staleIntervals = 0;
        return;
      }

      staleIntervals += 1;
      probing = true;
      probeStartedAt = Date.now();
      // An abandoned probe can still settle later. Its result must not clear a
      // latch or a controller that by then belongs to its successor.
      const generation = ++probeGeneration;
      probeController = new AbortController();
      try {
        await activeClient.health(
          AbortSignal.any([
            probeController.signal,
            AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
          ]),
        );
        if (generation === probeGeneration) consecutiveFailures = 0;
      } catch {
        if (generation === probeGeneration) consecutiveFailures += 1;
      } finally {
        if (generation === probeGeneration) {
          probing = false;
          probeController = null;
        }
      }

      if (disposed || clientRef.current !== activeClient || generation !== probeGeneration) return;

      const { shouldDrop } = healthMonitorDecision(
        Date.now() - lastActivityRef.current,
        consecutiveFailures,
      );
      // A live health probe with a dead event stream is still a dead stream, so
      // sustained staleness alone is enough.
      const streamHung = staleIntervals >= MAX_CONSECUTIVE_HEALTH_FAILURES;

      if (shouldDrop || streamHung) {
        disposed = true;
        clearInterval(intervalId);
        setServiceStatus("offline");
        setDevice(null);
        setLocalError(PIN_SERVICE_LOST_MESSAGE);
        logError("pin-device", "Pin service went unresponsive", {
          healthFailures: consecutiveFailures,
          staleIntervals,
        });
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(intervalId);
      probeController?.abort();
    };
  }, [client, serviceStatus]);

  const value = useMemo<PinDeviceContextValue>(
    () => ({
      status,
      connectionMode,
      serviceStatus,
      connectionInfo,
      identity,
      device,
      client,
      error,
      remoteUnpaired,
      support,
      lastEventAt,
      connect,
      disconnect,
      clearError,
      refreshService,
      borrowSession,
    }),
    [
      status,
      connectionMode,
      serviceStatus,
      connectionInfo,
      identity,
      device,
      client,
      error,
      remoteUnpaired,
      support,
      lastEventAt,
      connect,
      disconnect,
      clearError,
      refreshService,
      borrowSession,
    ],
  );

  return <PinDeviceContext.Provider value={value}>{children}</PinDeviceContext.Provider>;
}
