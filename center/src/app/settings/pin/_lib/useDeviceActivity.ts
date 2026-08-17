"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActivityItemByKind, ActivityKind } from "@/lib/pin-device";
import { PinApiError, logError, logInfo } from "@/lib/pin-device";
import { usePinPaneSession } from "./pinSession";
import {
  ACTIVITY_PAGE_SIZE,
  activityTab,
  withActivityItemRestored,
  withoutActivityItemAt,
} from "./activityPresentation";

/*
 * One activity table on the device, read and mutated over the USB session.
 *
 * The three tabs of the Activity pane are the same six operations against three
 * endpoints that differ only by a path segment, so they share this rather than
 * being written three times and drifting three ways. It is generic over the
 * kind on purpose: `client.listActivity(kind)` is already generic, so a caller
 * that passes the literal "notes" gets ActivityNote[] back with no cast
 * anywhere in the pane.
 *
 * Kept on plain useState, like the fitness pane and unlike `useDeviceSettings`.
 * /api/settings is one document four panes share, which is what React Query is
 * there for; an activity table is read by exactly one mounted tab, and the
 * optimistic delete below is far easier to reason about against a single array
 * than against a cache other components can also write.
 */

export type ActivityLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

/** An older Pin that has no activity routes at all, versus one that failed. */
function isUnsupported(error: unknown): boolean {
  return (
    error instanceof PinApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

export interface DeviceActivityController<K extends ActivityKind> {
  items: ActivityItemByKind[K][];
  state: ActivityLoadState;
  /** The one failure line the tab renders; null when nothing has failed. */
  message: string | null;
  /** A delete or a clear is in flight. Blocks every other mutation. */
  mutating: boolean;
  loadingMore: boolean;
  /** The device's cursor says there are older rows this pane has not read. */
  hasMore: boolean;
  reload: () => void;
  loadMore: () => void;
  /** Optimistic. Restores the row and states the failure if the Pin refuses. */
  remove: (item: ActivityItemByKind[K]) => Promise<void>;
  clear: () => Promise<void>;
}

export function useDeviceActivity<K extends ActivityKind>(
  kind: K,
  scope: string,
): DeviceActivityController<K> {
  const { client } = usePinPaneSession();
  const tab = activityTab(kind);

  const [items, setItems] = useState<ActivityItemByKind[K][]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [state, setState] = useState<ActivityLoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setState("loading");
    setMessage(null);
    try {
      const page = await client.listActivity(kind, { limit: ACTIVITY_PAGE_SIZE });
      setItems(page.items);
      setNextBefore(page.next_before ?? null);
      setState("ready");
      logInfo(scope, "Activity loaded", { kind, count: page.items.length });
    } catch (error) {
      const unsupported = isUnsupported(error);
      setState(unsupported ? "unavailable" : "error");
      setMessage(
        unsupported
          ? `This Pin's software does not keep ${tab.many} yet.`
          : `Could not load ${tab.many} from the Pin.`,
      );
      logError(scope, "Activity load failed", error, { kind });
    }
  }, [client, kind, scope, tab.many]);

  /*
   * A connected client is a privacy boundary. These tables are the wearer's own
   * speech, so a second Pin attached in the same browser tab must never inherit
   * the first one's rows for even one frame — the reset runs before the load,
   * in the same effect, rather than being left to the next successful read.
   */
  useEffect(() => {
    setItems([]);
    setNextBefore(null);
    setState("idle");
    setMessage(null);
    if (client) void load();
  }, [client, load]);

  const loadMore = useCallback(() => {
    if (!client || !nextBefore || loadingMore || mutating) return;
    const before = nextBefore;
    setLoadingMore(true);
    setMessage(null);
    void client
      .listActivity(kind, { limit: ACTIVITY_PAGE_SIZE, before })
      .then((page) => {
        // Append rather than replace, and drop anything already on screen: the
        // device writes new rows while this pane is open, so a cursor taken a
        // minute ago can hand back a row the first page already had.
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setNextBefore(page.next_before ?? null);
      })
      .catch((error: unknown) => {
        setMessage(`Could not load older ${tab.many} from the Pin.`);
        logError(scope, "Activity page load failed", error, { kind });
      })
      .finally(() => setLoadingMore(false));
  }, [client, kind, loadingMore, mutating, nextBefore, scope, tab.many]);

  const remove = useCallback(
    async (item: ActivityItemByKind[K]) => {
      if (!client || mutating) return;
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) return;

      setMutating(true);
      setMessage(null);
      // The row leaves now, before the Pin has answered. A delete over ADB is
      // slow enough that a list which does not visibly change reads as a dead
      // button, and the wearer presses it again.
      setItems((current) => withoutActivityItemAt(current, index));

      try {
        await client.deleteActivityItem(kind, item.id);
        logInfo(scope, "Activity item deleted", { kind });
      } catch (error) {
        // The device kept it. Put it back where it was and say so — a list that
        // shows the row as gone while it is still on the Pin is the one outcome
        // that leaves the wearer with a wrong idea of what the device holds.
        setItems((current) => withActivityItemRestored(current, index, item));
        setMessage(
          isUnsupported(error)
            ? `This Pin's software cannot delete a single ${tab.one}. It is still on the device.`
            : `Could not delete that ${tab.one}. It is still on the Pin.`,
        );
        logError(scope, "Activity delete failed", error, { kind });
      } finally {
        setMutating(false);
      }
    },
    [client, items, kind, mutating, scope, tab.one],
  );

  const clear = useCallback(async () => {
    if (!client || mutating) return;
    setMutating(true);
    setMessage(null);
    try {
      await client.clearActivity(kind);
      // Not optimistic, unlike the single delete: this one is unbounded — it
      // wipes rows this pane never read — so nothing leaves the screen until
      // the device has confirmed it is gone.
      setItems([]);
      setNextBefore(null);
      setState("ready");
      logInfo(scope, "Activity cleared", { kind });
    } catch (error) {
      setMessage(
        isUnsupported(error)
          ? `This Pin's software cannot clear ${tab.many}. Nothing was deleted.`
          : `Could not clear ${tab.many}. Nothing was deleted.`,
      );
      logError(scope, "Activity clear failed", error, { kind });
    } finally {
      setMutating(false);
    }
  }, [client, kind, mutating, scope, tab.many]);

  return {
    items,
    state,
    message,
    mutating,
    loadingMore,
    hasMore: nextBefore !== null,
    reload: () => void load(),
    loadMore,
    remove,
    clear,
  };
}
