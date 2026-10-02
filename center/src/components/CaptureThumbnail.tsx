"use client";

import type { CaptureData } from "@/lib/contracts/captures";
import { useEffect, useRef, useState } from "react";

/**
 * A capture frame that degrades gracefully.
 *
 * The frame is fetched from `/api/capture/memory/{uuid}/file/{index}`, which the
 * BFF relays from Cosmos once Cosmos has opened the SEALED frame. That can fail
 * for honest reasons, Cosmos holds no key for this capture, the bytes were
 * never uploaded, or the seal was written under a key Cosmos cannot open. When
 * it does, a bare `<img>` renders an empty box. This swaps in
 * the same "missing" placeholder the metadata-negative path already uses, so the
 * grid never shows a broken tile.
 *
 * A dark tile ALWAYS says why. `fallbackLabel` used to be optional with no
 * default, and the captures grid passed none, so a frame that 404'd rendered a
 * completely blank dark div, indistinguishable from a styling bug. The label now
 * defaults from `frameState()` below, which is the single shared answer to "why
 * is this frame not here".
 */

/** The honest answer when the metadata gives no more specific reason. */
export const FRAME_UNAVAILABLE = "Media unavailable.";

/**
 * Why a tile has no picture. Each reason is a real state, not a placeholder: a
 * capture whose upload never finished has no frames on the server at all, and
 * one that finished can still be sealed under a key Cosmos does not hold.
 *
 * One helper, one spelling, the captures grid, the Memories dashboard and the
 * capture detail all read from here. The sealed sentence is the app-wide one:
 * "Sealed, opens only on the Pin."
 */
export function frameState(frame?: Partial<CaptureData>): string {
  if (!frame) return FRAME_UNAVAILABLE;
  if (frame.uploadComplete === false) return "Upload pending on the Pin.";
  if (frame.sealed) return "Sealed — opens only on the Pin.";
  if (frame.thumbnailCount === 0) return "No frames stored.";
  return FRAME_UNAVAILABLE;
}

export function CaptureThumbnail({
  uuid,
  index = 0,
  imgClassName,
  fallbackClassName,
  fallbackLabel,
  frame,
}: {
  uuid: string;
  index?: number;
  imgClassName?: string;
  fallbackClassName?: string;
  /** Override the shared sentence. Omit it and `frameState(frame)` answers. */
  fallbackLabel?: string;
  /** The capture's own metadata, so the fallback can say which reason applies. */
  frame?: Partial<CaptureData>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // React keeps the same tile instance when refreshed capture metadata changes.
  // A failure for an older URL must not poison the newly available frame.
  useEffect(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    setAttempt(0);
    setFailed(false);
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [uuid, index]);

  if (failed) {
    return (
      <div className={fallbackClassName} data-testid="capture-thumbnail-fallback">
        <span>{fallbackLabel ?? frameState(frame)}</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={imgClassName}
      src={`/api/capture/memory/${uuid}/file/${index}?attempt=${attempt}`}
      alt=""
      loading="lazy"
      onLoad={() => {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = null;
        setFailed(false);
      }}
      onError={() => {
        // A token refresh can complete on a sibling request just after this one
        // failed. Retry twice with a cache-busting URL before calling a durable
        // server-side state "sealed".
        if (attempt < 2) {
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            setAttempt((value) => value + 1);
          }, 400 * (attempt + 1));
          return;
        }
        setFailed(true);
      }}
    />
  );
}
