import { CaptureThumbnail } from "@/components/CaptureThumbnail";
import { StatusMessage } from "@/components/Status";
import buttons from "@/components/buttons.module.css";
import styles from "@/components/captureDetail.module.css";
import { BackIcon, ForgetData } from "@/icons";
import type { CaptureCameraFrame, CaptureDetails, CaptureRecord } from "@/lib/contracts/captures";
import { formatTimestamp } from "@/lib/format";
import { useState } from "react";
import { StarIcon, formatDuration } from "./CaptureGallery";
import local from "./captures.module.css";

type ShareResult = {
  url: string | null;
  note: string | null;
  tone: "warning" | "info";
  expiry?: number;
};

export function CaptureToolbar({
  mode,
  busy,
  infoOpen,
  sharePending,
  favorite,
  favoritePending,
  onClose,
  onDownload,
  onInfo,
  onFavorite,
  onShare,
  onForget,
}: {
  mode: "modal" | "page";
  busy: boolean;
  infoOpen: boolean;
  sharePending: boolean;
  favorite: boolean;
  favoritePending: boolean;
  onClose: () => void;
  onDownload: () => void;
  onInfo: () => void;
  onFavorite: () => void;
  onShare: () => void;
  onForget: () => void;
}) {
  return (
    <div className={styles.header}>
      <div data-testid="top-toolbar-left">
        <button data-testid="top-back-button" className={buttons.circularButton} type="button" aria-label={mode === "modal" ? "Close" : "Back to Captures"} onClick={onClose}>
          {mode === "modal" ? <CloseIcon /> : <BackIcon size={20} />}
        </button>
      </div>
      <div className={styles.actions} data-testid="top-toolbar-right">
        <button className={buttons.circularButton} type="button" aria-label="Download" title="Download" onClick={onDownload}><DownloadIcon /></button>
        <button className={buttons.circularButton} type="button" aria-label="Info" title="Info" aria-expanded={infoOpen} onClick={onInfo}><InfoIcon /></button>
        <button
          className={`${buttons.circularButton} ${favorite ? local.favoriteOn : ""}`}
          type="button"
          aria-label={favorite ? "Unfavorite" : "Favorite"}
          title={favorite ? "Unfavorite" : "Favorite"}
          aria-pressed={favorite}
          onClick={onFavorite}
          disabled={favoritePending}
        >
          <StarIcon size={20} filled={favorite} />
        </button>
        <button className={buttons.circularButton} type="button" aria-label="Share" title="Share" onClick={onShare} disabled={sharePending}><ShareIcon /></button>
        <button className={buttons.circularButton} type="button" aria-label="Forget this capture" title="Forget this capture" onClick={onForget} disabled={busy}><ForgetData size={17} /></button>
      </div>
    </div>
  );
}

export function BurstSelector({
  uuid,
  record,
  frameCount,
  selectedFrame,
  pending,
  onChoose,
  onRecheck,
}: {
  uuid: string;
  record?: CaptureRecord;
  frameCount: number;
  selectedFrame: number;
  pending: boolean;
  onChoose: (frame: number) => void;
  onRecheck: () => void;
}) {
  if (frameCount <= 1) return null;
  const method = record?.data.bestFrameMethod;
  const label = pending
    ? "Comparing frames…"
    : method === "manual"
      ? "Selected by you"
      : method === "vision_v1"
        ? "Selected from visual comparison"
        : method === "quality_v1"
          ? "Selected from image quality"
          : "All originals are preserved";

  return (
    <div className={styles.burstPanel} aria-label={`${frameCount} photo burst`}>
      <div className={styles.burstHeader}>
        <div><strong>Best of {frameCount}</strong><span>{label}</span></div>
        {method ? <span className={styles.burstReason} data-testid="selection-source">Selection source: {label}</span> : null}
      </div>
      <div className={styles.filmstrip}>
        {Array.from({ length: frameCount }, (_, frame) => (
          <button
            className={styles.filmstripButton}
            data-selected={frame === selectedFrame}
            type="button"
            key={frame}
            aria-label={`Use frame ${frame + 1}`}
            aria-pressed={frame === selectedFrame}
            disabled={pending}
            onClick={() => onChoose(frame)}
          >
            <CaptureThumbnail uuid={uuid} index={frame} imgClassName={styles.filmstripImage} fallbackClassName={styles.filmstripMissing} frame={record?.data} />
            <span>{frame === selectedFrame ? "Best" : frame + 1}</span>
          </button>
        ))}
      </div>
      <button className={styles.recheckButton} type="button" disabled={pending} onClick={onRecheck}>
        {pending ? "Comparing frames…" : "Compare frames again"}
      </button>
    </div>
  );
}

/** `UTC+2`, from the Pin's whole-hour `gmt_offset`. */
function utcOffset(hours: number): string {
  if (hours === 0) return "UTC";
  return `UTC${hours > 0 ? "+" : "−"}${Math.abs(hours)}`;
}

/** `1/125 s` for exposures under a second, `2 s` above. */
function exposure(ns: number): string {
  const seconds = ns / 1e9;
  return seconds >= 1 ? `${seconds.toFixed(1)} s` : `1/${Math.round(1 / seconds)} s`;
}

function cameraSummary(frame: CaptureCameraFrame): string {
  const parts = [`${frame.width} × ${frame.height}`];
  if (frame.exposureTimeNs && frame.exposureTimeNs > 0) parts.push(exposure(frame.exposureTimeNs));
  if (frame.iso && frame.iso > 0) parts.push(`ISO ${frame.iso}`);
  if (typeof frame.horizonAngle === "number" && frame.horizonAngle !== 0) {
    parts.push(`tilted ${frame.horizonAngle}°`);
  }
  return parts.join(" · ");
}

export function CaptureInfo({
  uuid,
  record,
  details,
  created,
  frameCount,
  selectedFrame,
  tagPending,
  onAddTag,
  onRemoveTag,
}: {
  uuid: string;
  record?: CaptureRecord;
  details?: CaptureDetails;
  created?: string;
  frameCount: number;
  selectedFrame: number;
  tagPending: boolean;
  onAddTag: (text: string) => void;
  onRemoveTag: (tag: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const isVideo = record?.data.memoryType === "VIDEO";
  const camera = details?.frames[selectedFrame] ?? details?.frames[0];
  const tags = record?.data.tags ?? [];
  return (
    <div className={styles.infoPanel} data-testid="capture-info">
      <div className={styles.infoRow}><span className={styles.infoLabel}>Captured</span><span className={styles.infoValue}>{created ? formatTimestamp(created) : "Unknown"}{details ? ` (${utcOffset(details.gmtOffsetHours)} where taken)` : ""}</span></div>
      {isVideo ? (
        <div className={styles.infoRow}><span className={styles.infoLabel}>Video</span><span className={styles.infoValue}>{typeof record?.data.durationSec === "number" && record.data.durationSec > 0 ? formatDuration(record.data.durationSec) : "Length unknown"}</span></div>
      ) : (
        <div className={styles.infoRow}><span className={styles.infoLabel}>Photo burst</span><span className={styles.infoValue}>{frameCount > 0 ? `${frameCount} frame${frameCount === 1 ? "" : "s"}; frame ${selectedFrame + 1} shown` : "No frame metadata"}</span></div>
      )}
      {camera ? (
        <div className={styles.infoRow} data-testid="capture-camera"><span className={styles.infoLabel}>Camera</span><span className={styles.infoValue}>{cameraSummary(camera)}</span></div>
      ) : null}
      {record?.data.uploadState === "failed_final" ? (
        <div className={styles.infoRow}><span className={styles.infoLabel}>Upload</span><span className={styles.infoValue}>The Pin stopped trying to upload the full-resolution capture.</span></div>
      ) : null}
      <div className={styles.infoRow}>
        <span className={styles.infoLabel}>Tags</span>
        <div className={local.tags} data-testid="capture-tags">
          {tags.map((tag) => (
            <span className={local.tag} key={tag}>
              {tag}
              <button type="button" className={local.tagRemove} aria-label={`Remove tag ${tag}`} disabled={tagPending} onClick={() => onRemoveTag(tag)}>×</button>
            </span>
          ))}
          <form
            className={local.tagForm}
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              onAddTag(text);
              setDraft("");
            }}
          >
            <input aria-label="Add a tag" placeholder="Add a tag" maxLength={64} value={draft} onChange={(event) => setDraft(event.target.value)} />
            <button type="submit" className={styles.shareCopy} disabled={tagPending || !draft.trim()}>Add</button>
          </form>
        </div>
      </div>
      <details className={styles.technicalDetails}>
        <summary>Technical details</summary>
        <div className={styles.infoRow}><span className={styles.infoLabel}>Memory UUID</span><span className={styles.infoValue}>{uuid}</span></div>
        {details?.format ? <div className={styles.infoRow}><span className={styles.infoLabel}>Format</span><span className={styles.infoValue}>{details.format}</span></div> : null}
        <p className={styles.infoNote}>
          {details?.hasLocation
            ? "Your Pin recorded where this was taken. The location stays sealed and isn’t shown here."
            : "No location was recorded with this capture."}
        </p>
      </details>
    </div>
  );
}

export function CaptureShare({ share, copied, onCopy }: { share: ShareResult; copied: boolean; onCopy: (path: string) => void }) {
  return (
    <div className={styles.shareResult} data-testid="capture-share">
      {share.url ? (
        <>
          <div className={styles.shareRow}><span className={styles.shareLink}>{share.url}</span><button className={styles.shareCopy} type="button" onClick={() => share.url && onCopy(share.url)}>{copied ? "Copied" : "Copy"}</button></div>
          <span className={styles.shareNote}>
            Anyone with this link can view this capture
            {share.expiry ? ` until ${formatTimestamp(new Date(share.expiry * 1000).toISOString())}` : " until it expires"}.
          </span>
        </>
      ) : <StatusMessage tone={share.tone} inline>{share.note}</StatusMessage>}
    </div>
  );
}

function CloseIcon() { return <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>; }
function DownloadIcon() { return <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden><path d="M12 4V15M12 15L7.5 10.5M12 15L16.5 10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 19H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>; }
function InfoIcon() { return <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" /><path d="M12 11V16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="7.75" r="1.15" fill="currentColor" /></svg>; }
function ShareIcon() { return <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden><circle cx="6" cy="12" r="2.4" stroke="currentColor" strokeWidth="2" /><circle cx="17.5" cy="6" r="2.4" stroke="currentColor" strokeWidth="2" /><circle cx="17.5" cy="18" r="2.4" stroke="currentColor" strokeWidth="2" /><path d="M8.2 10.9L15.3 7.1M8.2 13.1L15.3 16.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>; }
