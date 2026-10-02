import { CaptureThumbnail, frameState } from "@/components/CaptureThumbnail";
import { ForgetData, LowResBadge, PlayBadge, SearchIcon } from "@/icons";
import type { CaptureRecord, PendingCapture } from "@/lib/contracts/captures";
import { formatTimestamp } from "@/lib/format";
import Link from "next/link";
import styles from "./captures.module.css";

/**
 * A tile shows a picture whenever the Pin sent thumbnails. They arrive with
 * `CreateMemory`, before the full-resolution upload, which is exactly when the
 * low-res badge says what the wearer is looking at.
 */
function hasFrame(capture: CaptureRecord) {
  return (capture.data.thumbnailCount ?? 0) > 0;
}

/** Why a tile has no picture, including the Pin having given up on it. */
function tileState(capture: CaptureRecord): string {
  if (capture.data.uploadState === "failed_final") return "The Pin couldn’t upload this capture.";
  return frameState(capture.data);
}

/** `m:ss` for a video's length. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function StarIcon({ size = 18, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? "currentColor" : "none"} aria-hidden>
      <path
        d="M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.6l-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CapturesEmptyIcon({ size = 56 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <rect x="3" y="6.5" width="18" height="14" rx="3.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8.6 6.5L10 3.6h4l1.4 2.9" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="12" cy="13.5" r="3.7" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function footprintFor(capture: CaptureRecord) {
  // observed: the saved Center used one continuous feed with mixed-size media
  // cells. implemented: this clean-room clone assigns a stable footprint from
  // the capture UUID because the recovered API response does not expose source
  // pixel dimensions. New uploads therefore do not reshuffle existing tiles.
  let hash = 0;
  for (const character of capture.uuid) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const slot = hash % 12;
  if (slot === 0 || slot === 8) return "feature";
  if (slot === 2 || slot === 5 || slot === 10) return "portrait";
  return "landscape";
}

function StackMarker({ count }: { count: number }) {
  const label = `${count} frames; strongest frame shown`;
  return (
    <span className={styles.stackMarker} title={label} aria-label={label}>
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden>
        <rect x="3.25" y="5.75" width="11" height="9" rx="2" stroke="currentColor" strokeWidth="1.35" />
        <path d="M6 3.5h7.25A3.25 3.25 0 0 1 16.5 6.75V12" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
      <span>{count}</span>
    </span>
  );
}

export function CaptureGalleryToolbar({
  query,
  onQueryChange,
  favoritesOnly,
  onFavoritesOnlyChange,
  selected,
  total,
  onSelectAll,
  onClear,
  onFavorite,
  onUnfavorite,
  onForget,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  favoritesOnly: boolean;
  onFavoritesOnlyChange: (value: boolean) => void;
  selected: number;
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
  onFavorite: () => void;
  onUnfavorite: () => void;
  onForget: () => void;
}) {
  const selectionMode = selected > 0;
  return (
    <div
      className={`${styles.toolbarRail} ${selectionMode ? styles.toolbarRailSelection : ""}`}
      role="toolbar"
      aria-label={selectionMode ? "Capture selection" : "Capture search"}
    >
      {selectionMode ? (
        <div className={styles.selectionToolbar}>
          <strong className={styles.selectionCount}>{selected} selected</strong>
          <button type="button" className={styles.toolbarButton} onClick={onSelectAll}>
            {selected === total ? "Deselect all" : "Select all"}
          </button>
          <button type="button" className={styles.toolbarAction} onClick={onFavorite}>
            <StarIcon size={15} filled /> Favorite
          </button>
          <button type="button" className={styles.toolbarAction} onClick={onUnfavorite}>
            <StarIcon size={15} /> Unfavorite
          </button>
          <button type="button" className={styles.toolbarDanger} onClick={onForget}>
            <ForgetData size={15} /> Forget
          </button>
          <button type="button" className={styles.toolbarQuiet} onClick={onClear}>Cancel</button>
        </div>
      ) : (
        <div className={styles.searchRow}>
          <label className={styles.searchField}>
            <SearchIcon size={18} />
            <span className={styles.srOnly}>Search captures</span>
            <input
              data-testid="search-captures-field"
              placeholder="Search captures"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.filterToggle}
            aria-pressed={favoritesOnly}
            onClick={() => onFavoritesOnlyChange(!favoritesOnly)}
          >
            <StarIcon size={16} filled={favoritesOnly} /> Favorites
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Captures still on the Pin: declared with `DeclareMemoryCreateIntent` and not
 * created in the cloud yet. There is no picture to show until the Pin sends
 * one, so each tile says what it is and why it is waiting.
 */
export function PendingCaptures({
  pending,
  clearing,
  onClear,
}: {
  pending: PendingCapture[];
  clearing: boolean;
  onClear: () => void;
}) {
  if (pending.length === 0) return null;
  return (
    <section className={styles.pending} aria-label="Waiting on your Pin" data-testid="pending-captures">
      <div className={styles.pendingHeader}>
        <h2 className={styles.pendingTitle}>
          Waiting on your Pin <span className={styles.pendingCount}>{pending.length}</span>
        </h2>
        <button type="button" className={styles.toolbarQuiet} onClick={onClear} disabled={clearing}>
          {clearing ? "Clearing…" : "Clear list"}
        </button>
      </div>
      <ul className={styles.pendingList}>
        {pending.map((item) => (
          <li key={item.deviceLocalId} className={styles.pendingTile} data-testid="pending-capture">
            <span className={styles.pendingKind}>{item.memoryType === "VIDEO" ? "Video" : "Photo"}</span>
            <span className={styles.pendingReason}>
              {item.delayReason === "POOR_NETWORK"
                ? "Waiting for a better connection"
                : "Uploading from your Pin"}
            </span>
            <span className={styles.pendingTime}>Since {formatTimestamp(item.declaredAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CaptureGallery({
  captures,
  selected,
  onToggle,
}: {
  captures: CaptureRecord[];
  selected: Set<string>;
  onToggle: (uuid: string) => void;
}) {
  const selectionMode = selected.size > 0;

  return (
    <section className={styles.gallery} aria-label="Captures">
      <div className={styles.grid} data-selection-mode={selectionMode}>
        {captures.map((capture) => {
          const isVideo = capture.data.memoryType === "VIDEO";
          const failed = capture.data.uploadState === "failed_final";
          const pending = capture.data.uploadComplete === false && !failed;
          const isSelected = selected.has(capture.uuid);
          const footprint = footprintFor(capture);
          const tile = (
            <div className={`${styles.tile} ${isSelected ? styles.tileSelected : ""}`} data-testid="capture-image-tile">
              {hasFrame(capture) ? (
                <CaptureThumbnail
                  uuid={capture.uuid}
                  index={capture.data.bestFrameIndex ?? 0}
                  imgClassName={styles.image}
                  fallbackClassName={styles.missing}
                  fallbackLabel={failed ? tileState(capture) : undefined}
                  frame={capture.data}
                />
              ) : <div className={styles.missing}>{tileState(capture)}</div>}
              {isVideo ? (
                <span className={`${styles.badge} ${styles.topBadge} ${styles.videoBadge}`}>
                  <PlayBadge size={20} />
                  {typeof capture.data.durationSec === "number" && capture.data.durationSec > 0 ? (
                    <span data-testid="video-duration">{formatDuration(capture.data.durationSec)}</span>
                  ) : null}
                </span>
              ) : null}
              {pending ? <span className={`${styles.badge} ${styles.pendingBadge}`}><LowResBadge size={18} /></span> : null}
              {capture.data.favorite ? (
                <span className={`${styles.badge} ${styles.favoriteBadge}`} aria-label="Favorite" data-testid="favorite-badge">
                  <StarIcon size={18} filled />
                </span>
              ) : null}
              {!isVideo && (capture.data.frameCount ?? 0) > 1 ? (
                <StackMarker count={capture.data.frameCount ?? 0} />
              ) : null}
            </div>
          );
          return (
            <article className={`${styles.tileShell} ${styles[footprint]}`} key={capture.uuid}>
              {selectionMode ? (
                <button
                  className={styles.tileLink}
                  type="button"
                  aria-label={`${isSelected ? "Deselect" : "Select"} capture from ${formatTimestamp(capture.userCreatedAt)}`}
                  onClick={() => onToggle(capture.uuid)}
                >
                  {tile}
                </button>
              ) : (
                <Link
                  className={styles.tileLink}
                  href={`/captures/${capture.uuid}`}
                  aria-label={`Open capture from ${formatTimestamp(capture.userCreatedAt)}`}
                  data-testid="capture-image-link"
                >
                  {tile}
                </Link>
              )}
              <button
                className={styles.selector}
                data-selected={isSelected}
                type="button"
                aria-label={isSelected ? "Deselect capture" : "Select capture"}
                aria-pressed={isSelected}
                onClick={() => onToggle(capture.uuid)}
              >
                {isSelected ? "✓" : <span aria-hidden />}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
