import Link from "next/link";
import { CaptureThumbnail, frameState } from "@/components/CaptureThumbnail";
import { ForgetData, LowResBadge, PlayBadge, SearchIcon } from "@/icons";
import type { CaptureRecord } from "@/lib/types";
import styles from "./captures.module.css";

function hasFrame(capture: CaptureRecord) {
  return capture.data.uploadComplete === true && (capture.data.thumbnailCount ?? 0) > 0;
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
  selected,
  total,
  onSelectAll,
  onClear,
  onForget,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  selected: number;
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
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
          <button type="button" className={styles.toolbarDanger} onClick={onForget}>
            <ForgetData size={15} /> Forget
          </button>
          <button type="button" className={styles.toolbarQuiet} onClick={onClear}>Cancel</button>
        </div>
      ) : (
        <label className={styles.searchField}>
          <SearchIcon size={18} />
          <span className={styles.srOnly}>Search captures</span>
          <input
            data-testid="search-contacts-field"
            placeholder="Search captures"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
      )}
    </div>
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
          const pending = capture.data.uploadComplete === false;
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
                  frame={capture.data}
                />
              ) : <div className={styles.missing}>{frameState(capture.data)}</div>}
              {isVideo ? <span className={`${styles.badge} ${styles.topBadge}`}><PlayBadge size={20} /></span> : null}
              {pending ? <span className={`${styles.badge} ${styles.pendingBadge}`}><LowResBadge size={18} /></span> : null}
              {!isVideo && (capture.data.frameCount ?? 0) > 1 ? (
                <StackMarker count={capture.data.frameCount ?? 0} />
              ) : null}
            </div>
          );
          return (
            <article className={`${styles.tileShell} ${styles[footprint]}`} key={capture.uuid}>
              {selectionMode ? (
                <button className={styles.tileLink} type="button" onClick={() => onToggle(capture.uuid)}>{tile}</button>
              ) : (
                <Link className={styles.tileLink} href={`/captures/${capture.uuid}`} data-testid="capture-image-link">{tile}</Link>
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
