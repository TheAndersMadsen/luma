import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import type { Sourced } from "@/server/domain/provenance";

/**
 * One answer for every account write (Details, food preferences, block mode):
 *
 *   200 {ok: true, <key>: stored}           Cosmos stored it. This is what it kept
 *   400 {ok: false, degraded}               Cosmos refused it as invalid
 *   401 {ok: false, reauthenticate: true}   the wearer's session expired
 *   413 {ok: false, degraded, tooLong}      longer than the account keeps
 *   502 {ok: false, degraded}               Cosmos did not answer
 *   503 {ok: false, degraded}               no Cosmos is configured here
 *
 * Anything but a 200 means nothing was saved.
 */
export function accountWriteResponse<T>(key: string, result: Sourced<T | null>): NextResponse {
  const headers = sourceHeaders(result);
  if (result.reauthenticate) {
    return NextResponse.json(
      { ok: false, degraded: result.degraded, reauthenticate: true },
      { status: 401, headers },
    );
  }
  if (result.state === "live" && result.data !== null) {
    return NextResponse.json({ ok: true, [key]: result.data }, { headers });
  }
  const status =
    result.refusal === "invalid"
      ? 400
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
