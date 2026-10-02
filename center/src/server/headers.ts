/*
 * The provenance wire vocabulary: one enum, three states, plus what is on
 * screen instead. `fixtures` names recovered sample data only, never "the call
 * failed", so an empty error result and someone else's data stay apart.
 *
 *
 *   x-data-state:    live | absent | degraded
 *   x-data-fallback: fixtures | empty     (only when the state is not live)
 *   x-data-degraded: <prose>              (unchanged)
 */

import type { DataFallback, DataState } from "@/lib/contracts/dataSource";

export interface SourceResult {
  state: DataState;
  fallback?: DataFallback;
  degraded?: string;
  /**
   * The degraded cause the wearer can fix: their Keycloak grant expired behind a
   * still-valid Center cookie.
   *
   * A machine-readable header because several of these routes answer with a bare
   * JSON ARRAY, /api/capture/search, /api/capture/captures, and have nowhere in
   * the body to put it. Without it those panes render an empty list with an
   * `x-data-degraded` sentence nobody reads, which is exactly how an expiry came
   * to look like "you have no captures".
   */
  reauthenticate?: boolean;
}

export function sourceHeaders(result: SourceResult): Record<string, string> {
  const { state } = result;
  const headers: Record<string, string> = { "x-data-state": state };
  // Only claimed when the producer actually knows, guessing here is how
  // "fixtures" came to mean both sample data and nothing in the first place.
  if (state !== "live" && result.fallback) headers["x-data-fallback"] = result.fallback;
  if (result.degraded) headers["x-data-degraded"] = toHeaderSafe(result.degraded);
  if (result.reauthenticate) headers["x-data-reauthenticate"] = "1";
  return headers;
}

/**
 * HTTP header values are ByteStrings, latin1 only. Our degraded messages are
 * prose and contain em dashes and typographic quotes, which throw on the way
 * out. Downgrade to ASCII rather than losing the message.
 */
export function toHeaderSafe(value: string): string {
  return value
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[…]/g, "...")
    // anything still outside latin1 becomes a space rather than a 500
    .replace(/[^\x20-\xFF]/g, " ")
    .trim();
}
