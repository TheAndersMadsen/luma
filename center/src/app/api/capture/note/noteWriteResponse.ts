import type { CosmosNoteDto } from "@/lib/contracts/notes";
import type { Sourced } from "@/server/domain/provenance";
import { NextResponse } from "next/server";

/**
 * One answer for both note writes (create and edit), so the new-note and
 * edit screens read one contract:
 *
 *   200 {ok: true, note}                    Cosmos stored it; `note` is what it kept
 *   401 {ok: false, reauthenticate: true}   the wearer's session expired
 *   404 {ok: false, degraded}               the edited note no longer exists
 *   413 {ok: false, degraded, tooLong}      longer than Cosmos keeps
 *   502 {ok: false, degraded}               Cosmos did not answer
 *   503 {ok: false, degraded}               no Cosmos is configured here
 *
 * Anything but a 200 means nothing was saved.
 */
export function noteWriteResponse(
  result: Sourced<CosmosNoteDto | null>,
  headers: Record<string, string>,
): NextResponse {
  if (result.reauthenticate) {
    return NextResponse.json(
      { ok: false, degraded: result.degraded, reauthenticate: true },
      { status: 401 },
    );
  }
  if (result.state === "live" && result.data) {
    return NextResponse.json({ ok: true, note: result.data }, { headers });
  }
  const status =
    result.refusal === "not_found"
      ? 404
      : result.refusal === "too_large"
        ? 413
        : result.state === "degraded"
          ? 502
          : 503;
  return NextResponse.json(
    { ok: false, degraded: result.degraded, ...(status === 413 ? { tooLong: true } : {}) },
    { status, headers },
  );
}
