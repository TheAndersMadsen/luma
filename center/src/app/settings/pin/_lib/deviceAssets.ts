/*
 * Blob-URL lifetime for media read off the Pin, and the limit on how much of it
 * is in flight at once.
 *
 * Over USB `transport.assetUrl()` returns null, so `PinClient.acquireAssetUrl`
 * has no choice but to fetch the bytes and hand back a `URL.createObjectURL`
 * handle. Nothing revokes an object URL on its own — it lives as long as the
 * document — so a gallery that acquires one per thumbnail and never releases
 * leaks the whole decoded image for the rest of the session. The client already
 * refcounts and revokes correctly; what it cannot do is know when a React tree
 * is finished with a handle. That is what this module is for.
 *
 * `DeviceAssetLease` is the whole contract in one object: at most one acquire,
 * at most one matching release, in any order the component lifecycle produces
 * them. The three orders that actually happen are unmount mid-fetch, unmount
 * after the URL is showing, and a list re-fetch that changes the path a mounted
 * tile is pointed at — and the first of those is the one that leaks if the
 * release is written as "release whatever we last resolved".
 *
 * Two rules below are not obvious from `client.ts` and are load-bearing:
 *
 *  - The lease never passes an AbortSignal to `acquireAssetUrl`. The signal
 *    rejects the CALLER's promise (`waitWithSignal`) without touching the
 *    entry's reference count, so an aborted acquire that is never released is
 *    exactly the leak this file exists to prevent. Cancellation is `release()`,
 *    which is the path that decrements, aborts the fetch and revokes.
 *
 *  - A FAILED acquire is not released. The client deletes its own map entry
 *    when the fetch rejects, so a later acquire of the same path creates a
 *    fresh entry — and a late release from the failed lease would decrement
 *    that new entry to zero and revoke a URL another tile is still displaying.
 */

/** The `PinClient` surface a lease drives. Narrowed so a test can stand in. */
export interface DeviceAssetSource {
  acquireAssetUrl(
    path: string,
    revision?: string | number | null,
    signal?: AbortSignal,
  ): Promise<string>;
  releaseAssetUrl(path: string, revision?: string | number | null): void;
}

/**
 * The cache-busting half of an asset key.
 *
 * A memory's bytes are not immutable while it is still uploading: the same
 * `/api/memories/<uuid>/thumbnail/0` answers with nothing, then with a frame.
 * Passing the record's status and thumbnail count as the revision makes a
 * re-fetch that observed the change acquire a NEW entry instead of re-serving
 * the blob captured while the memory was still empty.
 */
export type AssetRevision = string | number | null;

/**
 * How many device asset fetches may be open at once.
 *
 * Every `PinClient.request` over USB opens its own `localabstract:penumbra_http`
 * socket and a matching relay thread on the Pin, so a 200-tile gallery that
 * acquires on mount would ask the device for 200 at the same instant. Four is
 * chosen to keep the pipe busy while leaving the settings reads, the health
 * probe and the event stream — which share the same ADB session — able to get a
 * socket promptly. It is a device-protection limit, not a rendering budget.
 */
export const DEVICE_ASSET_CONCURRENCY = 4;

/** Returns a slot when one is free. Every admit resolves exactly one release. */
export interface RequestGate {
  admit(): Promise<() => void>;
}

function once(action: () => void): () => void {
  let spent = false;
  return () => {
    if (spent) return;
    spent = true;
    action();
  };
}

export function createRequestGate(limit: number): RequestGate {
  const capacity = Math.max(1, Math.floor(limit));
  const waiting: Array<(slot: () => void) => void> = [];
  let active = 0;

  function release() {
    const next = waiting.shift();
    if (next) {
      // Hand the slot straight on rather than dropping `active` and raising it
      // again: a decrement visible between the two would let a caller that
      // admits synchronously jump the queue.
      next(once(release));
      return;
    }
    active -= 1;
  }

  return {
    admit() {
      if (active < capacity) {
        active += 1;
        return Promise.resolve(once(release));
      }
      return new Promise<() => void>((resolve) => waiting.push(resolve));
    },
  };
}

/**
 * One acquire/release pair for one device asset.
 *
 * Construct it, `open()` it once, and call `release()` from the effect cleanup
 * that owns it. `release()` before, during or after `open()` all balance.
 */
export class DeviceAssetLease {
  readonly path: string;
  readonly revision: AssetRevision;
  private readonly source: DeviceAssetSource;
  /** The source is holding a reference on our behalf right now. */
  private held = false;
  private opened = false;
  private released = false;

  constructor(
    source: DeviceAssetSource,
    path: string,
    revision: AssetRevision = null,
  ) {
    this.source = source;
    this.path = path;
    this.revision = revision;
  }

  /**
   * Take the lease and resolve its object URL.
   *
   * Resolves null — rather than a URL the caller must not use — when the lease
   * was released before the device answered. Rejects only when the device
   * itself failed, which is the case a caller renders as "this frame could not
   * be read", distinct from an empty gallery.
   */
  async open(gate?: RequestGate): Promise<string | null> {
    if (this.opened) {
      throw new Error("DeviceAssetLease.open() may only be called once.");
    }
    this.opened = true;
    if (this.released) return null;

    const slot = gate ? await gate.admit() : null;
    try {
      // Re-checked after the wait: a tile can scroll out of a re-rendered list
      // while its request is still queued behind three others, and asking the
      // device for bytes nobody will look at is the cost the gate exists to
      // avoid in the first place.
      if (this.released) return null;

      const url = await this.source.acquireAssetUrl(this.path, this.revision);
      if (this.released) {
        // Released while the fetch was in flight. The reference is ours and
        // still counted, so it is ours to give back — right now, not later.
        this.source.releaseAssetUrl(this.path, this.revision);
        return null;
      }
      this.held = true;
      return url;
    } finally {
      slot?.();
    }
  }

  /** Give the reference back. Safe to call any number of times, at any point. */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (!this.held) return;
    this.held = false;
    this.source.releaseAssetUrl(this.path, this.revision);
  }

  /** True once `release()` has run, whether or not a URL was ever produced. */
  get isReleased(): boolean {
    return this.released;
  }
}
