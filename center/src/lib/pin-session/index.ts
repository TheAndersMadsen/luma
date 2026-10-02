"use client";

/**
 * THE Pin ADB session for this browser tab.
 *
 * Two `Adb` handles cannot claim the same USB interface, so a Pin console that
 * opened one session for the installer and another for the settings panes would
 * simply fail on the second `requestDevice()`. The retired Setup SPA never hit
 * that because the installer was a separate page from the console. Center puts
 * them side by side under `/settings/pin/*`, so ONE session has to contain both.
 *
 * This module is that one session, held at module scope rather than in React
 * state. Module scope is what makes it survive App Router navigations between
 * panes even if no provider stays mounted, and it means the install pane, the
 * configuration panes and any future `PinDeviceProvider` all get the *same*
 * device no matter which one asks first.
 *
 * Four deliberate properties:
 *
 *  - The accessors CREATE the transport but never connect it.
 *    `WebUsbAdbSessionTransport.connect()` calls `navigator.usb.requestDevice()`,
 *    which requires a user gesture, so connecting stays the caller's decision.
 *    Calling `connect()` on an already-connected session is a no-op that returns
 *    the existing `AdbConnectionInfo` without re-prompting, so every consumer can
 *    call it freely.
 *
 *  - TWO accessors, not one. `getWearerPinAdbSession()` hands out a session
 *    with no `openPty` and no free-form ADB service, the only thing anything
 *    under the ungated `/settings/pin` tree may obtain. `getPinAdbSession()`
 *    hands out the full session including the device shell, and its single
 *    consumer is `app/admin/pin/terminal/DeviceTerminal.tsx`, behind the
 *    operator gate. Both delegate to the same underlying transport and the same
 *    device. They differ only in what they let you do to it.
 *
 *  - The shared snapshot is published by the TRANSPORT, through
 *    `onStateChange`, not by a wrapper around it. The transport reconnects
 *    itself on a retryable socket close, so a wrapper's `reconnect()` is never
 *    called on that path and an observer bolted to one would keep reporting a
 *    device that had already been torn down and re-bound.
 *
 *  - Nothing here disconnects on unmount. Unplugging the device is a user
 *    action (`disconnectPinAdbSession()`), never a side effect of navigating
 *    away from a pane mid-install.
 *
 * SSR: the module is `"use client"` and touches no browser global at import
 * time, so importing it from a client component that the server pre-renders is
 * safe. Only `connect()` needs a real browser.
 */

import { PinClient, UsbAdbHttpTransport } from "@/lib/pin-device";
import {
  RemoteSignerAdbAuthStrategy,
  WebUsbAdbSessionTransport,
  createTimedAdbSessionTransport,
  type AdbConnectionInfo,
  type AdbOperatorSessionTransport,
  type AdbSessionStateChange,
  type AdbSessionTransport,
} from "@/lib/pin-device/adb";
import { useSyncExternalStore } from "react";

export type PinAdbSessionStatus = "idle" | "connecting" | "connected" | "error";

export interface PinAdbSessionSnapshot {
  readonly status: PinAdbSessionStatus;
  readonly connection: AdbConnectionInfo | null;
  readonly error: string | null;
}

const IDLE_SNAPSHOT: PinAdbSessionSnapshot = Object.freeze({
  status: "idle",
  connection: null,
  error: null,
});

const listeners = new Set<() => void>();

let snapshot: PinAdbSessionSnapshot = IDLE_SNAPSHOT;
let rawSession: WebUsbAdbSessionTransport | null = null;
let wearerSession: AdbSessionTransport | null = null;
let httpTransport: UsbAdbHttpTransport | null = null;
let httpTransportInFlight: Promise<UsbAdbHttpTransport> | null = null;
let pinClient: PinClient | null = null;
let connectionGeneration = 0;

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publish(next: PinAdbSessionSnapshot) {
  snapshot = Object.freeze(next);
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Anything that invalidates the HTTP-over-ADB tunnel: the socket service probe
 * and the maintenance-service nudge both have to run again against the new
 * connection, and a `PinClient` bound to a dead transport would keep failing.
 *
 * `PinClient` identity is also the per-device cache boundary in
 * `settings/pin/_lib/useDeviceSettings.ts`, so dropping it here is what stops a
 * reconnect from showing (or writing) one Pin's configuration against another.
 */
function dropDerivedTransports() {
  connectionGeneration += 1;
  httpTransport = null;
  httpTransportInFlight = null;
  pinClient = null;
}

/**
 * The transport's own report of what happened to `adb`/`info`.
 *
 * Every phase drops the derived transports first: `connecting` because the
 * socket underneath is already gone, `connected` because the tunnel and the
 * client must be rebuilt against whatever is there now, `idle`/`error` because
 * there is nothing to talk to. Dropping happens synchronously BEFORE `publish`,
 * so a subscriber that reacts to the new snapshot never sees a stale client.
 */
function onSessionStateChange(change: AdbSessionStateChange) {
  dropDerivedTransports();

  switch (change.phase) {
    case "connecting":
      publish({ status: "connecting", connection: change.info, error: null });
      return;
    case "connected":
      publish({ status: "connected", connection: change.info, error: null });
      return;
    case "idle":
      publish(IDLE_SNAPSHOT);
      return;
    case "error":
      publish({
        status: "error",
        connection: change.info,
        error: toMessage(change.error),
      });
      return;
  }
}

/**
 * Typed as the concrete transport, not as an interface: `openBridgeSocket` is
 * optional on `AdbSessionTransport` (so `UsbAdbHttpTransport` can keep failing
 * closed on a transport that cannot tunnel), and the class is where it is
 * unconditionally present.
 */
function requireRawSession(): WebUsbAdbSessionTransport {
  if (!rawSession) {
    rawSession = new WebUsbAdbSessionTransport({
      authStrategy: new RemoteSignerAdbAuthStrategy(),
      onStateChange: onSessionStateChange,
    });
  }

  return rawSession;
}

/**
 * A capability-reduced view of whatever transport is current.
 *
 * It resolves the underlying session on EVERY call rather than closing over one
 * instance, because `disconnectPinAdbSession()` throws the transport away: a
 * façade that had captured the old one would keep driving a dead handle, which
 * is precisely the "reports Connected without touching the device" failure that
 * made a failed disconnect poison the tab.
 *
 * `openPty` is absent, not refused, `AdbSessionTransport` declares it optional
 * so that a wearer pane calling it does not compile. `openBridgeSocket` is
 * forwarded because the HTTP-over-ADB tunnel is how every settings/eSIM/flags
 * call reaches the device, and it can only name the Pin's own two bridges.
 */
function createWearerSession(): AdbSessionTransport {
  const wearer: AdbSessionTransport = {
    get connectionInfo() {
      return requireRawSession().connectionInfo;
    },
    connect() {
      return requireRawSession().connect();
    },
    reconnect() {
      return requireRawSession().reconnect();
    },
    disconnect() {
      return requireRawSession().disconnect();
    },
    shell(command) {
      return requireRawSession().shell(command);
    },
    shellWithInput(command, input, options) {
      return requireRawSession().shellWithInput(command, input, options);
    },
    pushFile(remotePath, file) {
      return requireRawSession().pushFile(remotePath, file);
    },
    reboot() {
      return requireRawSession().reboot();
    },
    startCommandStream(command, onLine) {
      return requireRawSession().startCommandStream(command, onLine);
    },
    openBridgeSocket(target) {
      return requireRawSession().openBridgeSocket(target);
    },
  };

  return wearer;
}

/**
 * The FULL session, device shell included.
 *
 * Operator surfaces only. The one consumer outside this module is
 * `app/admin/pin/terminal/DeviceTerminal.tsx`, which sits under the
 * operator-gated `/admin/pin` subtree that middleware, the layout guard and
 * `verify/pin-terminal-gate.test.mjs` all enforce. Every wearer pane takes
 * `getWearerPinAdbSession()` instead.
 *
 * Call `connect()` on the result from inside a user gesture (a click), that is
 * what `navigator.usb.requestDevice()` requires.
 */
export function getPinAdbSession(): AdbOperatorSessionTransport {
  return requireRawSession();
}

/**
 * The same device, minus the capabilities that turn a session into a root
 * shell. This is what the ungated `/settings/pin` tree gets.
 */
export function getWearerPinAdbSession(): AdbSessionTransport {
  if (!wearerSession) {
    wearerSession = createWearerSession();
  }

  return wearerSession;
}

/**
 * The wearer session with per-step timeouts applied. Stable identity, because
 * `createTimedAdbSessionTransport` memoises on the session it wraps and the
 * wearer façade is a singleton.
 */
export function getTimedWearerPinAdbSession(): AdbSessionTransport {
  return createTimedAdbSessionTransport(getWearerPinAdbSession());
}

/** Current connection, or null when nothing is attached. */
export function getPinAdbConnection(): AdbConnectionInfo | null {
  return rawSession?.connectionInfo ?? null;
}

export function getPinAdbSessionSnapshot(): PinAdbSessionSnapshot {
  return snapshot;
}

export function subscribeToPinAdbSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Claim a Pin over WebUSB. Must be called from a user gesture. */
export async function connectPinAdbSession(): Promise<AdbConnectionInfo> {
  return requireRawSession().connect();
}

/** Release the device. The only thing that ever tears the session down. */
export async function disconnectPinAdbSession(): Promise<void> {
  const session = rawSession;
  if (!session) {
    return;
  }

  try {
    await session.disconnect();
  } finally {
    /*
     * Drop the instance whether or not the teardown succeeded. `disconnect()`
     * already clears its own `adb`/`info` in a `finally`, so this is belt and
     * braces, but it also restores the SPA's per-connect transport lifetime,
     * so nothing about a half-closed handle can survive into the next Connect
     * click. The wearer façade re-resolves on every call, so it picks up the
     * replacement without anyone re-fetching it.
     */
    rawSession = null;
    dropDerivedTransports();
  }
}

/**
 * The Pin's REST API, tunnelled over the SAME ADB session the installer uses.
 *
 * Borrowed, never owned: `UsbAdbHttpTransport.fromSession` is explicit that
 * `disconnect()` on the returned transport will not close the ADB session, so a
 * pane can be unmounted without unplugging the device.
 */
export async function getPinHttpTransport(): Promise<UsbAdbHttpTransport> {
  const session = getWearerPinAdbSession();
  const connectionInfo = session.connectionInfo;
  if (!connectionInfo) {
    throw new Error("Connect a Pin over USB first.");
  }

  if (httpTransport) {
    return httpTransport;
  }

  if (!httpTransportInFlight) {
    const generation = connectionGeneration;
    const pending: Promise<UsbAdbHttpTransport> = UsbAdbHttpTransport.fromSession(
      getTimedWearerPinAdbSession(),
      connectionInfo,
    )
      .then((transport) => {
        if (generation !== connectionGeneration) {
          throw new Error("The Pin connection changed. Try again on the connected Pin.");
        }
        httpTransport = transport;
        return transport;
      })
      .finally(() => {
        // Only clear the latch if it is still OURS: a reconnect during the
        // maintenance nudge calls `dropDerivedTransports()` and a later caller
        // may already have started a fresh attempt.
        if (httpTransportInFlight === pending) {
          httpTransportInFlight = null;
        }
      });
    httpTransportInFlight = pending;
  }

  return httpTransportInFlight;
}

/**
 * A `PinClient` bound to the shared USB transport.
 *
 * No admin token: a USB session is authorized by the ADB socket itself, and
 * `UsbAdbHttpTransport` never sets an `Authorization` header. This is what
 * removes the long-lived `pin-admin-token` the SPA kept in `localStorage`.
 */
export async function getPinClient(): Promise<PinClient> {
  const generation = connectionGeneration;
  const transport = await getPinHttpTransport();
  if (generation !== connectionGeneration) {
    throw new Error("The Pin connection changed. Try again on the connected Pin.");
  }
  if (!pinClient || pinClient.transport !== transport) {
    pinClient = new PinClient(transport);
  }

  return pinClient;
}

/** Subscribe a component to the shared session's connection state. */
export function usePinAdbSession(): PinAdbSessionSnapshot {
  return useSyncExternalStore(
    subscribeToPinAdbSession,
    getPinAdbSessionSnapshot,
    () => IDLE_SNAPSHOT,
  );
}
