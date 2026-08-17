"use client";

import { useDeviceAssetUrl } from "../_lib/useDeviceAsset";
import type { AssetRevision } from "../_lib/deviceAssets";
import styles from "./gallery.module.css";

/*
 * Pictures that came off the Pin over USB.
 *
 * The bytes are not addressable by URL — `UsbAdbHttpTransport.assetUrl()`
 * returns null — so every frame here is a blob handle that `useDeviceAssetUrl`
 * owns for exactly as long as the element is mounted. Nothing in this file
 * stores a URL anywhere the hook cannot revoke it: no module cache, no ref
 * that survives the effect, no `src` copied into state.
 *
 * The other job of this file is refusing to render one grey square for four
 * different situations. "Still arriving", "the Pin says there is no frame",
 * "the Pin refused this frame" and "no Pin is connected" have different
 * remedies, so each gets its own sentence — the same rule `frameState()` keeps
 * for the cloud grid.
 */

const SCOPE = "pin-gallery";

/** No frame exists to ask for, so nothing is fetched and the reason is stated. */
function FrameNotice({ children, failed = false }: { children: React.ReactNode; failed?: boolean }) {
  return (
    <span
      className={`${styles.frameNotice} ${failed ? styles.frameNoticeFailed : ""}`}
      data-testid="pin-gallery-frame-notice"
    >
      {children}
    </span>
  );
}

/**
 * One square in the grid.
 *
 * `path` is null when the record itself says there is no thumbnail — that is a
 * fact from the list response, not a failed read, so it must not spend an ADB
 * socket finding out.
 */
export function GalleryFrame({
  path,
  revision,
  absentLabel,
  badge,
  badgeWarning = false,
}: {
  path: string | null;
  revision: AssetRevision;
  /** Why there is no frame, when `path` is null. */
  absentLabel: string;
  badge?: string;
  badgeWarning?: boolean;
}) {
  const asset = useDeviceAssetUrl(path, revision, SCOPE);

  return (
    <div className={styles.frame}>
      {path === null ? (
        <FrameNotice>{absentLabel}</FrameNotice>
      ) : asset.status === "failed" ? (
        <FrameNotice failed>The Pin could not read this frame.</FrameNotice>
      ) : asset.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.frameImage} src={asset.url} alt="" />
      ) : (
        <span className={styles.framePulse} aria-hidden="true" />
      )}
      {badge ? (
        <span
          className={`${styles.frameBadge} ${badgeWarning ? styles.frameBadgeWarning : ""}`}
        >
          {badge}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The full-size media on the detail pane.
 *
 * A video is NOT loaded until the wearer asks. The whole file crosses one ADB
 * socket into memory before a single frame plays — there is no range-request
 * streaming through this transport — so a minute of Pin video is tens of
 * megabytes pulled over USB the instant the page opens. The caller decides when
 * by passing a path; until then this shows what it would cost.
 */
export function MemoryStage({
  path,
  revision,
  kind,
  alt,
  placeholder,
}: {
  path: string | null;
  revision: AssetRevision;
  kind: "image" | "video";
  alt: string;
  /** Shown while `path` is null — either "not requested yet" or "nothing here". */
  placeholder: React.ReactNode;
}) {
  const asset = useDeviceAssetUrl(path, revision, SCOPE);

  return (
    <div className={styles.stage} data-testid="pin-memory-stage">
      {path === null ? (
        <p className={styles.stageNotice}>{placeholder}</p>
      ) : asset.status === "failed" ? (
        <p className={`${styles.stageNotice} ${styles.frameNoticeFailed}`}>
          The Pin could not read this file. It is listed in the memory but the
          device refused to open it, so the bytes may no longer be on disk.
        </p>
      ) : !asset.url ? (
        <p className={styles.stageNotice} role="status">
          Reading from the Pin…
        </p>
      ) : kind === "video" ? (
        <video className={styles.stageMedia} src={asset.url} controls playsInline />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.stageMedia} src={asset.url} alt={alt} />
      )}
    </div>
  );
}
