"use client";

import { useEffect, useState } from "react";
import { logWarn } from "@/lib/pin-device";
import {
  DEVICE_ASSET_CONCURRENCY,
  DeviceAssetLease,
  createRequestGate,
  type AssetRevision,
} from "./deviceAssets";
import { usePinPaneSession } from "./pinSession";

/*
 * One blob URL for one device asset, for as long as one component wants it.
 *
 * The effect cleanup is the entire lifetime contract, and it covers all three
 * ways a handle stops being wanted with the same three lines: a tile unmounts,
 * the route changes (which unmounts it), or the list re-fetches and hands the
 * tile a different path or revision (which changes a dependency, so React runs
 * the cleanup before the next acquire). Nothing else may call
 * `releaseAssetUrl` for a path this hook acquired.
 *
 * `clearAssetUrls()` is deliberately NOT called from here. It revokes every
 * outstanding handle on the client regardless of who is still displaying one,
 * so it belongs to teardown of the whole session — `PinClient.disconnect()`
 * already does it — and calling it from a component would blank the other
 * fifteen tiles on the page.
 */

/** Shared by every pane, because the limit protects the DEVICE, not a view. */
const DEVICE_MEDIA_GATE = createRequestGate(DEVICE_ASSET_CONCURRENCY);

export type DeviceAssetStatus = "idle" | "loading" | "ready" | "failed";

export interface DeviceAssetState {
  /** An object URL owned by this hook. Never outlives the component. */
  readonly url: string | null;
  readonly status: DeviceAssetStatus;
}

const IDLE: DeviceAssetState = { url: null, status: "idle" };
const LOADING: DeviceAssetState = { url: null, status: "loading" };
const FAILED: DeviceAssetState = { url: null, status: "failed" };

/**
 * Read one asset off the connected Pin.
 *
 * Pass `path: null` to hold off — that is how a surface that must not pull a
 * whole video over USB until the wearer asks for it stays declarative.
 */
export function useDeviceAssetUrl(
  path: string | null,
  revision: AssetRevision = null,
  scope = "pin-device-asset",
): DeviceAssetState {
  const { client } = usePinPaneSession();
  const [state, setState] = useState<DeviceAssetState>(IDLE);

  useEffect(() => {
    if (!client || !path) {
      setState(IDLE);
      return;
    }

    const lease = new DeviceAssetLease(client, path, revision);
    let current = true;
    setState(LOADING);

    void lease.open(DEVICE_MEDIA_GATE).then(
      (url) => {
        // A null resolution means this lease was already released, so there is
        // nothing to show and nothing left to clean up.
        if (current && url) setState({ url, status: "ready" });
      },
      (error: unknown) => {
        if (!current) return;
        setState(FAILED);
        // The path is a device route, not wearer content, so it is safe to log
        // and it is the only thing that makes a single broken frame findable.
        logWarn(scope, "Could not read an asset from the Pin", {
          path,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      },
    );

    return () => {
      current = false;
      lease.release();
    };
  }, [client, path, revision, scope]);

  return state;
}
