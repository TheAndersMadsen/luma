/*
 * Ported verbatim from the retired Setup SPA (`src/pages/activityTimestamp.ts`).
 *
 * The Pin serves two timestamp contracts — canonical Unix seconds and ISO-8601
 * — and an unparseable value is echoed rather than rendered as "Invalid Date".
 */

const CANONICAL_UNIX_SECONDS = /^(?:0|-?[1-9]\d*)$/;
const MIN_UNIX_SECONDS = -62_167_219_200;
const MAX_UNIX_SECONDS = 253_402_300_799;

function dateFromUnixSeconds(value: number): Date | null {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_UNIX_SECONDS ||
    value > MAX_UNIX_SECONDS
  ) {
    return null;
  }
  const parsed = new Date(value * 1000);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Format the server's canonical Unix-second or ISO timestamp contracts. */
export function formatActivityTimestamp(value: string | number): string {
  let parsed: Date | null;
  if (typeof value === "number") {
    parsed = dateFromUnixSeconds(value);
  } else if (CANONICAL_UNIX_SECONDS.test(value)) {
    parsed = dateFromUnixSeconds(Number(value));
  } else {
    const iso = new Date(value);
    parsed = Number.isNaN(iso.getTime()) ? null : iso;
  }
  return parsed ? parsed.toLocaleString() : String(value);
}
