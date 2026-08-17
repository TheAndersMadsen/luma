/*
 * The provenance wire vocabulary.
 *
 * `x-data-source` used to carry FIVE values from two incompatible families —
 * `carry|fixtures` from the list routes and `unconfigured|carry|unreachable`
 * from the admin/assistant routes — while the client knew only two of them and
 * blind-cast the rest. Worse, `fixtures` meant both "recovered demo data" and
 * "nothing at all, the call failed", so a route serving an EMPTY error result
 * and a route serving someone else's recovered memories looked identical.
 *
 * One enum, three states, plus what is on screen instead:
 *
 *   x-data-state:    live | absent | degraded
 *   x-data-fallback: fixtures | empty     (only when the state is not live)
 *   x-data-degraded: <prose>              (unchanged)
 *
 * `x-data-source` is still emitted as a compatibility alias so nothing that
 * reads it breaks mid-migration. `x-data-state` is the one to branch on.
 */

/** live: from carry, current. absent: no counterpart here. degraded: it didn't answer. */
export type DataState = "live" | "absent" | "degraded";

/** What the wearer is looking at instead — recovered sample data, or nothing. */
export type DataFallback = "fixtures" | "empty";

export interface SourceResult {
  source: string;
  state?: DataState;
  fallback?: DataFallback;
  degraded?: string;
  /**
   * The degraded cause the wearer can fix: their Keycloak grant expired behind a
   * still-valid Center cookie.
   *
   * A machine-readable header because several of these routes answer with a bare
   * JSON ARRAY — /api/capture/search, /api/capture/captures — and have nowhere in
   * the body to put it. Without it those panes render an empty list with an
   * `x-data-degraded` sentence nobody reads, which is exactly how an expiry came
   * to look like "you have no captures".
   */
  reauthenticate?: boolean;
}

/**
 * Reads the legacy `source` value for callers that have not moved over yet, so
 * no route ever emits a state it did not mean.
 */
function stateOf(result: SourceResult): DataState {
  if (result.state) return result.state;
  if (result.source === "carry") return "live";
  if (result.source === "unreachable") return "degraded";
  // Everything else is "fixtures"/"unconfigured": a failure only if it says so.
  return result.degraded ? "degraded" : "absent";
}

export function sourceHeaders(result: SourceResult): Record<string, string> {
  const state = stateOf(result);
  const headers: Record<string, string> = {
    "x-data-source": result.source,
    "x-data-state": state,
  };
  // Only claimed when the producer actually knows — guessing here is how
  // "fixtures" came to mean both sample data and nothing in the first place.
  if (state !== "live" && result.fallback) headers["x-data-fallback"] = result.fallback;
  if (result.degraded) headers["x-data-degraded"] = toHeaderSafe(result.degraded);
  if (result.reauthenticate) headers["x-data-reauthenticate"] = "1";
  return headers;
}

/**
 * HTTP header values are ByteStrings — latin1 only. Our degraded messages are
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
