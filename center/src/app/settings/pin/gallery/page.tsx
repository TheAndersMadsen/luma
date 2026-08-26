"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PinApiError } from "@/lib/pin-device";
import type { MemoryRecord } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import { EmptyState, SectionSkeleton } from "@/components/States";
import settings from "../../settings.module.css";
import styles from "../_lib/panes.module.css";
import gallery from "./gallery.module.css";
import { CrossAuthorityNote, DeviceRequired, PaneSection } from "../_lib/PaneShell";
import { PIN_QUERY_KEY } from "../PinDeviceProvider";
import { pinClientIdentity, usePinPaneSession } from "../_lib/pinSession";
import { formatActivityTimestamp } from "../_lib/activityTimestamp";
import {
  isCanonicalMemoryId,
  memoryAssetRevision,
  memoryHasThumbnail,
  memoryStatusLabel,
  memoryTypeLabel,
} from "../_lib/memoryPresentation";
import { GalleryFrame } from "./DeviceMedia";

/*
 * Everything the Pin has captured and is still holding on its own disk.
 *
 * This is NOT /captures. That page reads the wearer's account through the Cosmos
 * cloud and shows what was successfully uploaded; this one reads
 * `GET /api/memories` over the USB session and shows what is on the device
 * right now — including the captures that never made it up, which is exactly
 * the set /captures cannot show. The two stores overlap and disagree, and the
 * only way a wearer can act on that is if the page says which one they are
 * looking at. Hence the cross-link at the bottom rather than a silent grid.
 *
 * The list is on `PIN_QUERY_KEY`, so the Pin's own `memory_created` /
 * `memory_completed` / `memory_deleted` events refresh it without polling. That
 * is affordable here because it is one HTTP call; the thumbnails behind it are
 * NOT re-fetched by a refresh, because each frame's blob is keyed on the
 * record's status and file counts and a re-listed record that did not change
 * resolves to the handle its tile is already holding.
 *
 * There is no delete control on this page, deliberately. Deleting a memory
 * removes the Pin's only copy, and a grid of near-identical squares is the
 * worst possible place to put an irreversible action — a mis-aimed click there
 * destroys something the wearer never even looked at. Delete lives on the
 * detail pane, behind the frame it destroys.
 */

/**
 * How many tiles are rendered before "Show older".
 *
 * `GET /api/memories` has no paging: the device returns every row it has, and a
 * Pin that has been worn for months returns thousands. Rendering all of them
 * would mount thousands of tiles, each of which would try to lease a blob. The
 * page therefore bounds itself, which bounds the leases as a consequence.
 */
const GALLERY_PAGE_SIZE = 24;

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof PinApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

function GalleryTile({ memory }: { memory: MemoryRecord }) {
  const { client } = usePinPaneSession();
  const addressable = isCanonicalMemoryId(memory.uuid);
  const capturedAt = formatActivityTimestamp(memory.created_at);
  const isVideo = memory.memory_type === "video";

  const frame = (
    <GalleryFrame
      path={
        client && memoryHasThumbnail(memory)
          ? client.thumbnailPath(memory.uuid, 0)
          : null
      }
      revision={memoryAssetRevision(memory)}
      absentLabel={
        !addressable
          ? "This Pin reported an identifier Center cannot address."
          : memory.status === "pending" || memory.status === "uploading"
            ? "The Pin has not written a frame for this capture yet."
            : "No frame stored for this capture."
      }
      badge={isVideo ? "Video" : memory.status === "failed" ? "Sync failed" : undefined}
      badgeWarning={!isVideo && memory.status === "failed"}
    />
  );

  /*
   * The upload state is on the caption rather than only on the frame, because a
   * capture that DOES have a thumbnail and has not synced looks exactly like one
   * that has. Finding those is most of the reason to open this pane at all, so
   * "Synced" is left off — it is the ordinary case and repeating it on every
   * tile would bury the two that are not.
   */
  const caption = (
    <span className={gallery.tileCaption}>
      <span className={gallery.tileKind}>{memoryTypeLabel(memory.memory_type)}</span>
      <span className={gallery.tileTime}>
        {memory.status === "complete"
          ? capturedAt
          : `${capturedAt} · ${memoryStatusLabel(memory.status)}`}
      </span>
    </span>
  );

  return (
    <article className={gallery.tile} data-testid="pin-gallery-tile">
      {addressable ? (
        <Link
          className={gallery.tileLink}
          href={`/settings/pin/gallery/${memory.uuid}`}
          aria-label={`${memoryTypeLabel(memory.memory_type)} captured ${capturedAt}`}
        >
          {frame}
        </Link>
      ) : (
        frame
      )}
      {caption}
    </article>
  );
}

export default function PinGalleryPane() {
  const { client, connectionError, attachedWithoutServer, serviceStatus } =
    usePinPaneSession();
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE);

  const memoriesQuery = useQuery<MemoryRecord[]>({
    queryKey: [PIN_QUERY_KEY, "memories", pinClientIdentity(client)],
    enabled: client !== null,
    retry: false,
    // The device is the authority and its events invalidate this key, so a
    // short window only suppresses the duplicate read a pane switch would cost.
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      if (!client) throw new Error("No Pin is connected.");
      return client.listMemories(signal);
    },
  });

  // A different Pin is a different gallery. Collapsing back to the first page
  // also drops every tile beyond it, which releases their blob handles.
  useEffect(() => {
    setVisibleCount(GALLERY_PAGE_SIZE);
  }, [client]);

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="the photos and videos stored on this Pin"
        connectionError={connectionError}
      />
    );
  }

  /*
   * The device answered once and then stopped. This is not an empty gallery and
   * must not look like one. It is not evidence that captures exist either: this
   * pane cannot tell, so it must not claim they are waiting on the Pin.
   */
  if (serviceStatus === "offline") {
    return (
      <PaneSection title="Captures on this Pin" testId="pin-gallery">
        <div className={settings.stateRow}>
          <StatusMessage tone="warning" onRetry={() => void memoriesQuery.refetch()}>
            {/* The banner in the console layout already names the condition
                once, for whichever pane is mounted. This says what it means
                HERE — an unreadable gallery must never read as an empty one. */}
            Center can&rsquo;t read this Pin&rsquo;s captures right now, so this is not an
            empty gallery. Whatever the Pin holds stays on it; connect a cable to browse.
          </StatusMessage>
        </div>
      </PaneSection>
    );
  }

  if (memoriesQuery.isError) {
    const unsupported = isUnsupported(memoriesQuery.error);
    return (
      <PaneSection title="Captures on this Pin" testId="pin-gallery">
        <div className={settings.stateRow}>
          <StatusMessage
            tone="warning"
            onRetry={unsupported ? undefined : () => void memoriesQuery.refetch()}
          >
            {unsupported
              ? "This Pin's software does not serve a device gallery yet. Install a newer release over the same USB session."
              : "Could not read the capture list from the Pin."}
          </StatusMessage>
        </div>
      </PaneSection>
    );
  }

  const memories = memoriesQuery.data;
  if (!memories) {
    return <SectionSkeleton rows={5} />;
  }

  const visible = memories.slice(0, visibleCount);
  const remaining = memories.length - visible.length;

  return (
    <>
      <PaneSection
        title="Captures on this Pin"
        testId="pin-gallery"
        action={
          <span className={styles.chipRow}>
            <button
              type="button"
              className={styles.smallButton}
              onClick={() => void memoriesQuery.refetch()}
              disabled={memoriesQuery.isFetching}
            >
              {memoriesQuery.isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </span>
        }
      >
        <div className={styles.formRow}>
          <p className={styles.formHelp}>
            Read directly off the device through Center&rsquo;s active Pin connection.
            A capture stays here until it is deleted on the Pin — whether or not it
            ever reached your account — so this list is the one place a capture that
            failed to upload is visible.
          </p>
        </div>

        {memories.length === 0 ? (
          <EmptyState
            inline
            title="No captures stored on this Pin"
            detail="The device's media store is empty. Take a photo or a video on the Pin and it will appear here."
          />
        ) : (
          <>
            <div className={gallery.grid} data-testid="pin-gallery-grid">
              {visible.map((memory) => (
                <GalleryTile key={memory.uuid} memory={memory} />
              ))}
            </div>
            <div className={gallery.pager}>
              <span className={gallery.pagerCount}>
                {remaining > 0
                  ? `Showing ${visible.length} of ${memories.length} captures`
                  : `${memories.length} ${memories.length === 1 ? "capture" : "captures"} on this Pin`}
              </span>
              {remaining > 0 ? (
                <button
                  type="button"
                  className={styles.smallButton}
                  onClick={() =>
                    setVisibleCount((current) => current + GALLERY_PAGE_SIZE)
                  }
                  data-testid="pin-gallery-show-more"
                >
                  Show {Math.min(remaining, GALLERY_PAGE_SIZE)} older
                </button>
              ) : null}
            </div>
          </>
        )}
      </PaneSection>

      <CrossAuthorityNote href="/captures" linkLabel="Open Captures">
        These captures are stored on the Pin. Uploaded copies appear in Captures.
      </CrossAuthorityNote>
    </>
  );
}
