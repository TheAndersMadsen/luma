import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { logWarn } from "@/server/log";
import { deleteMemory, getCapture } from "@/server/domain/captures";
import { SIGN_IN_AGAIN, cosmosStatus, sessionExpiredResponse } from "@/server/routeErrors";

/**
 * The session-expired answer for DELETE, keeping this route's own contract intact:
 * **`degraded` present means nothing was deleted.** The capture detail reads
 * `degraded`/`note` to build its "Nothing was deleted, this capture is still
 * here" notice.
 */
function reauthenticateDelete(): NextResponse {
  return sessionExpiredResponse({ ok: false, degraded: SIGN_IN_AGAIN, note: SIGN_IN_AGAIN });
}

/**
 * Read one capture so a refreshed/deep-linked detail has real burst metadata,
 * favourite and tags, and the camera details Cosmos kept.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await context.params;
  try {
    const capture = await getCapture(uuid);
    if (!capture) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(capture, {
      headers: sourceHeaders({ state: "live" }),
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) return sessionExpiredResponse();
    logWarn(`capture ${uuid} could not be read`, error);
    // The internal `webapi <path> -> <status>` message stays in the log.
    return NextResponse.json(
      { error: "capture unavailable" },
      { status: cosmosStatus(error) === 404 ? 404 : 502 },
    );
  }
}

/**
 * DELETE /api/capture/memory/{uuid}
 *
 * The shape .Center itself called, `DELETE /capture/memory/{id}`, and the
 * delete Cosmos runs for it is the Pin's own `DeleteMemory`: frames first, then
 * the row. This is a destructive endpoint. The UI gates it behind an explicit
 * in-app confirm and never fires it on mount.
 *
 * The contract, in one line: **`degraded` present means nothing was deleted.**
 * That holds on the 200 as well as the 502, and both callers (the capture detail
 * and the grid's Forget) read it.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const { uuid } = await context.params;
  try {
    const result = await deleteMemory(uuid);
    if (result.reauthenticate) return reauthenticateDelete();
    if (result.state === "live") {
      return NextResponse.json({ ok: true }, { status: 200, headers: sourceHeaders(result) });
    }
    // Nothing is configured to delete from. Still a 200 so the page does not
    // surface a scary error, but `degraded` says plainly the capture is there.
    if (result.state === "absent") {
      return NextResponse.json(
        { ok: true, degraded: result.degraded ?? "nothing was deleted" },
        { status: 200, headers: sourceHeaders(result) },
      );
    }
    const note = result.degraded ?? "delete failed";
    return NextResponse.json(
      { ok: false, degraded: note, note },
      { status: 502, headers: sourceHeaders(result) },
    );
  } catch (error) {
    if (error instanceof SessionExpiredError) return reauthenticateDelete();
    // The internal `webapi <path> -> <status>` message stays in the log.
    logWarn(`capture ${uuid} could not be deleted`, error);
    const note = "delete failed";
    return NextResponse.json({ ok: false, degraded: note, note }, { status: 502 });
  }
}
