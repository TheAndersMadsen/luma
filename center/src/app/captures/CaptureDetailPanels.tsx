import { CaptureThumbnail } from "@/components/CaptureThumbnail";
import { StatusMessage } from "@/components/Status";
import buttons from "@/components/buttons.module.css";
import styles from "@/components/captureDetail.module.css";
import { BackIcon, ForgetData } from "@/icons";
import { formatTimestamp } from "@/lib/format";
import type { CaptureRecord } from "@/lib/types";

type ShareResult = { url: string | null; note: string | null; tone: "warning" | "info" };

export function CaptureToolbar({
  mode,
  busy,
  infoOpen,
  sharePending,
  onClose,
  onDownload,
  onInfo,
  onShare,
  onForget,
}: {
  mode: "modal" | "page";
  busy: boolean;
  infoOpen: boolean;
  sharePending: boolean;
  onClose: () => void;
  onDownload: () => void;
  onInfo: () => void;
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
        <button className={buttons.circularButton} type="button" aria-label="Share" title="Share" onClick={onShare} disabled={sharePending}><ShareIcon /></button>
        <button className={buttons.circularButton} type="button" aria-label="Forget" title="Forget data" onClick={onForget} disabled={busy}><ForgetData size={17} /></button>
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

export function CaptureInfo({ uuid, created, frameCount, selectedFrame }: { uuid: string; created?: string; frameCount: number; selectedFrame: number }) {
  return (
    <div className={styles.infoPanel} data-testid="capture-info">
      <div className={styles.infoRow}><span className={styles.infoLabel}>Captured</span><span className={styles.infoValue}>{created ? formatTimestamp(created) : "Unknown"}</span></div>
      <div className={styles.infoRow}><span className={styles.infoLabel}>Photo burst</span><span className={styles.infoValue}>{frameCount > 0 ? `${frameCount} frame${frameCount === 1 ? "" : "s"}; frame ${selectedFrame + 1} shown` : "No frame metadata"}</span></div>
      <details className={styles.technicalDetails}>
        <summary>Technical details</summary>
        <div className={styles.infoRow}><span className={styles.infoLabel}>Memory UUID</span><span className={styles.infoValue}>{uuid}</span></div>
        <p className={styles.infoNote}>Capture bodies stay sealed under the wearer&rsquo;s channel key. Location, dimensions, and EXIF are not available from the current capture index.</p>
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
          <span className={styles.shareNote}>Anyone with this link can view this capture until it expires.</span>
        </>
      ) : <StatusMessage tone={share.tone} inline>{share.note}</StatusMessage>}
    </div>
  );
}

function CloseIcon() { return <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>; }
function DownloadIcon() { return <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden><path d="M12 4V15M12 15L7.5 10.5M12 15L16.5 10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 19H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>; }
function InfoIcon() { return <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" /><path d="M12 11V16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="7.75" r="1.15" fill="currentColor" /></svg>; }
function ShareIcon() { return <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden><circle cx="6" cy="12" r="2.4" stroke="currentColor" strokeWidth="2" /><circle cx="17.5" cy="6" r="2.4" stroke="currentColor" strokeWidth="2" /><circle cx="17.5" cy="18" r="2.4" stroke="currentColor" strokeWidth="2" /><path d="M8.2 10.9L15.3 7.1M8.2 13.1L15.3 16.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>; }
