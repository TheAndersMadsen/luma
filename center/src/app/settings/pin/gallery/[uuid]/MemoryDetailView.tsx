"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PinApiError, logError, logInfo } from "@/lib/pin-device";
import type { MemoryRecord } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import { EmptyState, SectionSkeleton } from "@/components/States";
import settings from "../../../settings.module.css";
import styles from "../../_lib/panes.module.css";
import gallery from "../gallery.module.css";
import { ArmedClearControl, DeviceRequired, PaneSection } from "../../_lib/PaneShell";
import { PIN_QUERY_KEY } from "../../PinDeviceProvider";
import { pinClientIdentity, usePinPaneSession } from "../../_lib/pinSession";
import { formatActivityTimestamp } from "../../_lib/activityTimestamp";
import { safeDownloadName, saveBlobAsFile } from "../../_lib/fileDownload";
import {
  classifyMemoryFile,
  describeMemoryLocation,
  isAddressableMemoryFilename,
  isCanonicalMemoryId,
  memoryAssetRevision,
  memoryDeleteQuestion,
  memoryHasThumbnail,
  memoryPrimaryFile,
  memoryStatusLabel,
  memoryTypeLabel,
} from "../../_lib/memoryPresentation";
import { MemoryStage } from "../DeviceMedia";

/*
 * The one place a capture on the Pin can be looked at properly, and the only
 * place it can be destroyed.
 *
 * Why delete is here and not on the grid: `DELETE /api/memories/<uuid>` removes
 * the memory's whole directory from the device. If the capture never uploaded,
 * that was the only copy of it anywhere. Putting that behind the frame it
 * destroys means the wearer has necessarily seen what they are about to lose,
 * and `ArmedClearControl` then makes the first press change the question rather
 * than do the thing — the same two-press gate the console uses before it wipes
 * a category, applied to a single record because a single record is all there
 * is here.
 *
 * Full-size media is a separate decision from the thumbnail. An image is
 * fetched on open; a video is not, because the whole file crosses one ADB
 * socket into memory before it can play. The wearer asks for that.
 */

const SCOPE = "pin-memory-detail";

/** "data" covers the IMU and timing sidecars a video capture writes. */
const FILE_KIND_LABEL: Record<ReturnType<typeof classifyMemoryFile>, string> = {
  image: "Image",
  video: "Video",
  data: "Sensor data",
};

function isMissing(error: unknown): boolean {
  return error instanceof PinApiError && error.status === 404;
}

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof PinApiError &&
    (error.status === 405 || error.status === 501)
  );
}

function BackToGallery() {
  return (
    <div className={styles.actionRow}>
      <Link className={styles.linkButton} href="/settings/pin/gallery">
        Back to the device gallery
      </Link>
    </div>
  );
}

export default function MemoryDetailView({ uuid }: { uuid: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { client, connectionError, attachedWithoutServer, serviceStatus } =
    usePinPaneSession();

  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  /** The video file the wearer has asked for, if any. Never pre-loaded. */
  const [requestedVideo, setRequestedVideo] = useState<string | null>(null);

  const addressable = isCanonicalMemoryId(uuid);

  const memoryQuery = useQuery<MemoryRecord>({
    queryKey: [PIN_QUERY_KEY, "memory", pinClientIdentity(client), uuid],
    enabled: client !== null && addressable,
    retry: false,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      if (!client) throw new Error("No Pin is connected.");
      return client.getMemory(uuid, signal);
    },
  });

  // A disarmed control is the safe resting state, so anything that changes what
  // the question refers to takes it back there rather than leaving a primed
  // Delete pointed at a different capture.
  useEffect(() => {
    setArmed(false);
    setActionError(null);
    setRequestedVideo(null);
  }, [client, uuid]);

  if (!addressable) {
    return (
      <PaneSection title="Capture on this Pin" testId="pin-memory-detail">
        <EmptyState
          inline
          title="That is not an identifier this Pin can address."
          detail="The device's media store only accepts canonical UUIDs, so there is nothing to read at this address. Open the capture from the gallery instead."
          action={{ label: "Back to the gallery", href: "/settings/pin/gallery" }}
        />
      </PaneSection>
    );
  }

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="this capture"
        connectionError={connectionError}
      />
    );
  }

  if (serviceStatus === "offline") {
    return (
      <PaneSection title="Capture on this Pin" testId="pin-memory-detail">
        <div className={settings.stateRow}>
          <StatusMessage tone="warning" onRetry={() => void memoryQuery.refetch()}>
            This capture is still on the Pin. It can&rsquo;t be read until its server answers
            again.
          </StatusMessage>
        </div>
        <BackToGallery />
      </PaneSection>
    );
  }

  if (memoryQuery.isError) {
    const missing = isMissing(memoryQuery.error);
    return (
      <PaneSection title="Capture on this Pin" testId="pin-memory-detail">
        {missing ? (
          <EmptyState
            inline
            title="This capture is no longer on the Pin."
            detail="The device has no memory with this identifier. It was deleted here, on the Pin itself, or by the device's own retention."
            action={{ label: "Back to the gallery", href: "/settings/pin/gallery" }}
          />
        ) : (
          <>
            <div className={settings.stateRow}>
              <StatusMessage
                tone="warning"
                onRetry={
                  isUnsupported(memoryQuery.error)
                    ? undefined
                    : () => void memoryQuery.refetch()
                }
              >
                {isUnsupported(memoryQuery.error)
                  ? "This Pin's software does not serve single captures yet."
                  : "Could not read this capture from the Pin."}
              </StatusMessage>
            </div>
            <BackToGallery />
          </>
        )}
      </PaneSection>
    );
  }

  const memory = memoryQuery.data;
  if (!memory) {
    return <SectionSkeleton rows={5} />;
  }

  const capturedAt = formatActivityTimestamp(memory.created_at);
  const revision = memoryAssetRevision(memory);
  const primaryFile = memoryPrimaryFile(memory);
  const primaryKind = primaryFile ? classifyMemoryFile(primaryFile) : null;
  const place = describeMemoryLocation(memory.location);
  const busy = deleting || downloading !== null;

  /*
   * What the stage shows, in the order the device can actually satisfy.
   *
   * A video's own frame comes last, and only once asked for: the whole file
   * crosses one ADB socket into memory before it can play, so until then the
   * stage shows the stored thumbnail instead of an apology. The thumbnail is
   * also the fallback for a capture whose full file never finished uploading —
   * for those it is the only frame that exists.
   *
   * Built from `uuid` — the route parameter this pane already refused to render
   * without — and not from `memory.uuid`. They are the same value on any device
   * that answers `getMemory` honestly, but only one of them has been checked,
   * and `filePath`/`thumbnailPath` interpolate without encoding into a line the
   * USB transport writes as `GET <path> HTTP/1.1`. `download()` below already
   * used the checked one; this is the same rule applied to the stage.
   */
  const stagePath = requestedVideo
    ? client.filePath(uuid, requestedVideo)
    : primaryKind === "image" && primaryFile
      ? client.filePath(uuid, primaryFile)
      : memoryHasThumbnail(memory)
        ? client.thumbnailPath(uuid, 0)
        : null;

  async function download(filename: string) {
    if (!client || busy || !isAddressableMemoryFilename(filename)) return;
    setDownloading(filename);
    setActionError(null);
    try {
      const blob = await client.fetchAsset(client.filePath(uuid, filename));
      saveBlobAsFile(blob, safeDownloadName(filename, `${uuid}.bin`));
      logInfo(SCOPE, "Capture file downloaded from the Pin", { filename });
    } catch (error) {
      setActionError(
        isMissing(error)
          ? "The Pin no longer has that file. Refresh this capture to see what is still stored."
          : "Could not read that file from the Pin.",
      );
      logError(SCOPE, "Capture file download failed", error, { filename });
    } finally {
      setDownloading(null);
    }
  }

  async function confirmDelete() {
    if (!client || deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      await client.deleteMemory(uuid);
      logInfo(SCOPE, "Capture deleted from the Pin");
      // Drop the record and the list that contained it before navigating, so
      // the gallery cannot paint a tile for something that is already gone.
      queryClient.removeQueries({
        queryKey: [PIN_QUERY_KEY, "memory", pinClientIdentity(client), uuid],
      });
      void queryClient.invalidateQueries({
        queryKey: [PIN_QUERY_KEY, "memories", pinClientIdentity(client)],
      });
      router.replace("/settings/pin/gallery");
    } catch (error) {
      setArmed(false);
      setActionError(
        isMissing(error)
          ? "That capture was already gone from the Pin."
          : "The Pin refused to delete this capture. Nothing was removed.",
      );
      logError(SCOPE, "Capture delete failed", error);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <PaneSection
        title={`${memoryTypeLabel(memory.memory_type)} on this Pin`}
        testId="pin-memory-detail"
        action={
          <span className={styles.chipRow}>
            <button
              type="button"
              className={styles.smallButton}
              onClick={() => void memoryQuery.refetch()}
              disabled={busy || memoryQuery.isFetching}
            >
              {memoryQuery.isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </span>
        }
      >
        <MemoryStage
          path={stagePath}
          revision={revision}
          kind={requestedVideo ? "video" : "image"}
          alt={`${memoryTypeLabel(memory.memory_type)} captured ${capturedAt}`}
          placeholder={
            memory.status === "pending" || memory.status === "uploading"
              ? "The Pin has not finished writing this capture, so there is no frame to show yet."
              : "This memory has no image, video or thumbnail stored on the device."
          }
        />

        {primaryKind === "video" && !requestedVideo && primaryFile ? (
          <div className={styles.formRow}>
            <div className={styles.actionRow}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setRequestedVideo(primaryFile)}
                disabled={busy}
                data-testid="pin-memory-load-video"
              >
                Play this video
              </button>
            </div>
            <p className={styles.formHelp}>
              Above is the stored thumbnail. Playing the video copies the whole
              file into this tab first — the device bridge buffers the transfer
              instead of streaming it — so it is not fetched until you ask.
            </p>
          </div>
        ) : null}

        {actionError ? (
          <div className={settings.stateRow}>
            <StatusMessage tone="danger">{actionError}</StatusMessage>
          </div>
        ) : null}

        <div className={styles.formRow}>
          <dl className={styles.factList}>
            <dt>Captured</dt>
            <dd>{capturedAt}</dd>
            <dt>Kind</dt>
            <dd>{memoryTypeLabel(memory.memory_type)}</dd>
            <dt>Upload</dt>
            <dd>{memoryStatusLabel(memory.status)}</dd>
            <dt>Thumbnails</dt>
            <dd>{memory.thumbnail_count}</dd>
            {place ? (
              <>
                <dt>Where</dt>
                <dd>{place}</dd>
              </>
            ) : null}
            <dt>On the device</dt>
            <dd>
              <code className={styles.mono}>{memory.device_local_id}</code>
            </dd>
            <dt>Identifier</dt>
            <dd>
              <code className={styles.mono}>{memory.uuid}</code>
            </dd>
          </dl>
        </div>
      </PaneSection>

      <PaneSection title="Files stored on the Pin" testId="pin-memory-files">
        <div className={styles.formRow}>
          {memory.files.length === 0 ? (
            <p className={styles.formHelp}>
              The device recorded this memory but has no files for it. That is
              what a capture looks like when the Pin was interrupted before it
              finished writing.
            </p>
          ) : (
            <>
              <p className={styles.formHelp}>
                Every file the device wrote for this capture, including the sensor
                sidecars a video carries. Downloading reads the bytes from the Pin.
              </p>
              <div>
                {memory.files.map((filename) => {
                  const addressableFile = isAddressableMemoryFilename(filename);
                  return (
                    <div className={gallery.fileRow} key={filename}>
                      <span className={gallery.fileName}>{filename}</span>
                      <span className={styles.chipRow}>
                        <span className={styles.chip}>
                          {FILE_KIND_LABEL[classifyMemoryFile(filename)]}
                        </span>
                        {addressableFile ? (
                          <button
                            type="button"
                            className={styles.smallButton}
                            onClick={() => void download(filename)}
                            disabled={busy}
                          >
                            {downloading === filename ? "Reading…" : "Download"}
                          </button>
                        ) : (
                          <span className={`${styles.chip} ${styles.chipWarning}`}>
                            Cannot be requested
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </PaneSection>

      <PaneSection title="Delete from this Pin" testId="pin-memory-delete">
        <div className={styles.formRow}>
          <p className={styles.formHelp}>
            This removes the capture and all of its files from the device. Center
            keeps no copy, and the Pin has no undo.
          </p>
          <ArmedClearControl
            armed={armed}
            question={memoryDeleteQuestion(memory, capturedAt)}
            armLabel="Delete this capture"
            confirmLabel="Delete from the Pin"
            busy={deleting}
            disabled={downloading !== null}
            onArm={() => setArmed(true)}
            onCancel={() => setArmed(false)}
            onConfirm={() => void confirmDelete()}
            testId="pin-memory-delete-control"
          />
        </div>
      </PaneSection>

      <BackToGallery />
    </>
  );
}
