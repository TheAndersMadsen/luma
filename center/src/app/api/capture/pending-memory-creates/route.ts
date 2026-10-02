import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { sourceHeaders } from "@/server/headers";
import { clearPendingCaptures, getPendingCaptures } from "@/server/domain/captures";
import { SIGN_IN_AGAIN, sessionExpiredResponse } from "@/server/routeErrors";


/**
 * GET /api/capture/pending-memory-creates, captures the Pin has taken and not
 * uploaded yet (recovered `getPendingMemoryCreates`, fed by the Pin's
 * `DeclareMemoryCreateIntent`). A bare array. Provenance travels in headers.
 */
export async function GET() {
  const result = await getPendingCaptures();
  return NextResponse.json(result.data, { headers: sourceHeaders(result) });
}

/**
 * DELETE /api/capture/pending-memory-creates, clear the waiting list
 * (recovered `deletePendingMemoryCreate`). The captures stay on the Pin.
 *
 * `degraded` present means nothing was cleared, the same contract the capture
 * deletes keep.
 */
export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const result = await clearPendingCaptures();
  if (result.reauthenticate) {
    return sessionExpiredResponse({ ok: false, degraded: SIGN_IN_AGAIN }, sourceHeaders(result));
  }
  if (result.state !== "live") {
    const degraded = result.degraded ?? "the waiting list could not be cleared";
    return NextResponse.json(
      { ok: false, degraded },
      { status: result.state === "absent" ? 200 : 502, headers: sourceHeaders(result) },
    );
  }
  return NextResponse.json(
    { ok: true, cleared: result.data },
    { headers: sourceHeaders(result) },
  );
}
