"use client";

import { usePinDevice } from "../PinDeviceProvider";
import type {
  PinDeviceStatus,
  PinServiceStatus,
} from "../PinDeviceProvider";
import type { DeviceInfo, PinClient } from "@/lib/pin-device";

/*
 * THE ONE SEAM between the device-settings panes and the shared WebUSB session.
 *
 * Every pane under /settings/pin reads the device through this module and
 * nothing else, so if `PinDeviceProvider`'s public shape moves, exactly one
 * file changes rather than seven.
 *
 * It also narrows the provider's value to what a *settings* pane may touch.
 * Deliberately not re-exported here: `session` / `borrowSession()` (the raw ADB
 * handle — that belongs to the installer and the operator shell, not to a
 * settings form) and `connect()` / `disconnect()` (device lifecycle belongs to
 * the Connect pane; a settings pane must never be able to unplug the console
 * out from under the installer).
 *
 * The distinction these panes must render correctly is that the ADB session and
 * the Pin's HTTP server are two different questions. A stock, un-injected Pin
 * answers ADB perfectly and has no Revival server at all — so "no device
 * attached" and "device attached, server not answering" are different sentences
 * with different remedies, and only the second one points at the installer.
 */

export interface PinPaneSession {
  /** Present only once the HTTP-over-ADB tunnel is open. Null means no reads. */
  client: PinClient | null;
  /** The ADB/WebUSB session state. */
  status: PinDeviceStatus;
  /** Whether the Pin's REST API is answering over that session. */
  serviceStatus: PinServiceStatus;
  /** A device is attached AND its server is answering. */
  ready: boolean;
  /**
   * A device is attached but its Revival server is not answering — the stock,
   * un-injected Pin the installer exists to fix.
   */
  attachedWithoutServer: boolean;
  /** `GET /api/device`, once the server answers. */
  device: DeviceInfo | null;
  /** The provider's last connection or liveness failure, in wearer prose. */
  connectionError: string | null;
}

const clientIds = new WeakMap<PinClient, number>();
let nextClientId = 1;

/**
 * A stable per-client string for cache keys.
 *
 * Two Pins connected one after the other in the same browser tab produce two
 * `PinClient` instances, and a cache key that did not tell them apart would
 * serve the first Pin's memories, settings or conversations to the second. That
 * is a privacy boundary rather than a freshness optimisation, which is why the
 * identity lives here — at the seam every pane already reads the device
 * through — instead of once per pane. The WeakMap must stay a single instance:
 * two of them would hand the same client two different ids and the keys would
 * silently stop agreeing.
 */
export function pinClientIdentity(client: PinClient | null): string {
  if (!client) return "none";
  let id = clientIds.get(client);
  if (id === undefined) {
    id = nextClientId++;
    clientIds.set(client, id);
  }
  return `${id}`;
}

export function usePinPaneSession(): PinPaneSession {
  // The provider owns the session; a settings pane only reads it.
  const { client, status, serviceStatus, device, error } = usePinDevice();

  return {
    client,
    status,
    serviceStatus,
    ready: client !== null && serviceStatus !== "offline",
    attachedWithoutServer: status === "connected" && client === null,
    device,
    connectionError: error,
  };
}
