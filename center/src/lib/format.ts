/*
 * Formatting helpers ported from the shipped bundle so output matches the original.
 */

/**
 * "10:57 PM • Feb 11, 2025" — the timestamp format used across My Data.
 *
 * An event whose `creation_time` the backend never set arrives here as "", and
 * saying so is the point: the server used to substitute the current time for a
 * missing timestamp, so a record of unknown age was dated today on the wearer's
 * own privacy surface. "Invalid Date • Invalid Date" is not an improvement, so
 * the absent case gets a sentence of its own.
 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "Time unknown";
  const time = d
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/ /g, " ");
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${time} • ${date}`;
}

/**
 * The original only reformatted the number when displayName === phoneNumber,
 * i.e. when there was no contact name to show.
 */
export function formatPhoneNumber(value: string): string {
  const m = value.replace(/\D/g, "").match(/^(1|)?(\d{3})(\d{3})(\d{4})$/);
  return m ? [m[1] ? "+1 " : "", "(", m[2], ") ", m[3], "-", m[4]].join("") : value;
}

export function callDisplayName(peer?: { displayName: string; phoneNumber: string }): string {
  if (!peer) return "Unknown";
  const { displayName, phoneNumber } = peer;
  if (displayName === phoneNumber && displayName?.trim()?.length > 0) {
    return formatPhoneNumber(displayName);
  }
  return displayName;
}

/** Tidal artwork: the uuid's dashes become path separators. */
export function tidalArtworkUrl(albumArtUuid: string, size = 160): string | null {
  try {
    return `https://resources.tidal.com/images/${albumArtUuid.replaceAll("-", "/")}/${size}x${size}.jpg`;
  } catch {
    return null;
  }
}

/**
 * Album-art tint. The original checked contrast against white and darkened the
 * colour when it fell below 4.5, else fell back to transparent.
 */
export function albumTint(hex: string | undefined): string {
  if (!hex || hex.trim() === "") return "transparent";
  const normalized = hex.startsWith("#") ? hex : `#${hex}`;
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) return "transparent";
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contrast = 1.05 / (L + 0.05);
  if (contrast >= 4.5) return normalized;
  const factor = Math.max(0.25, contrast / 4.5);
  const darken = (c: number) => Math.round(c * 255 * factor).toString(16).padStart(2, "0");
  return `#${darken(r)}${darken(g)}${darken(b)}`;
}

/** Media URL exactly as the original composed it. */
export function captureMediaUrl(
  memoryUuid: string,
  fileUUID: string,
  accessToken: string,
  baseURL = "https://webapi.prod.humane.cloud",
): string {
  return `${baseURL}/capture/memory/${encodeURIComponent(memoryUuid)}/file/${encodeURIComponent(
    fileUUID,
  )}?token=${accessToken}`;
}

export function daysAgo(iso: string): number {
  const then = new Date(iso).getTime();
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}
