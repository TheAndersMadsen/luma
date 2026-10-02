/*
 * Formatting helpers ported from the shipped bundle so output matches the original.
 */

/**
 * "10:57 PM • Feb 11, 2025", the timestamp format used across My Data.
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
function formatPhoneNumber(value: string): string {
  const m = value.replace(/\D/g, "").match(/^(1|)?(\d{3})(\d{3})(\d{4})$/);
  return m ? [m[1] ? "+1 " : "", "(", m[2], ") ", m[3], "-", m[4]].join("") : value;
}

/**
 * A blank `displayName` is a real stock value: humane_dialer
 * TelephonyNotableEvent.peerInfoToStruct stores "" for a null display name.
 * The number then names the call; "Unknown" is left for a call with neither.
 */
export function callDisplayName(peer?: { displayName: string; phoneNumber: string }): string {
  if (!peer) return "Unknown";
  const { displayName, phoneNumber } = peer;
  if (!displayName?.trim()) {
    return phoneNumber?.trim() ? formatPhoneNumber(phoneNumber.trim()) : "Unknown";
  }
  if (displayName === phoneNumber) return formatPhoneNumber(displayName);
  return displayName;
}

/**
 * A My Data record Cosmos could not open for this reader: the entry exists,
 * and its content is sealed under a key Cosmos does not hold. Its fields are
 * empty, which must never read as an empty request, track or call.
 */
export function isSealedEvent(record: { data: unknown }): boolean {
  return (record.data as { sealed?: unknown } | null)?.sealed === true;
}

/** "45 s", "3 min 5 s", "1 h 2 min". */
function formatCallDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? `${minutes} min ${total % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

/**
 * One call's direction, outcome and length, in the order a wearer reads them:
 * "Outgoing · 3 min 5 s", "Missed", "Incoming · Not answered". Cosmos derives
 * each part from the stock dialer events. A part it could not derive is left
 * out rather than guessed.
 */
export function callSummary(call: {
  direction?: "incoming" | "outgoing";
  outcome?: "answered" | "missed" | "unanswered" | "filtered";
  durationSeconds?: number;
}): string {
  const parts: string[] = [];
  if (call.outcome === "missed") return "Missed";
  if (call.direction === "outgoing") parts.push("Outgoing");
  if (call.direction === "incoming") parts.push("Incoming");
  if (typeof call.durationSeconds === "number") parts.push(formatCallDuration(call.durationSeconds));
  else if (call.outcome === "unanswered") parts.push("Not answered");
  return parts.join(" · ");
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