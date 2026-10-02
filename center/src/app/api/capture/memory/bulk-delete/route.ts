import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { sourceHeaders } from "@/server/headers";
import { deleteMemories } from "@/server/domain/captures";
import { memoryUuidsFrom } from "../memoryUuids";
import { SIGN_IN_AGAIN, sessionExpiredResponse } from "@/server/routeErrors";

/**
 * POST /api/capture/memory/bulk-delete {memoryUUIDs}, the grid's Forget
 * (recovered `bulkDeleteMemories`). Cosmos deletes each capture exactly as a
 * single delete does and says what happened to each: `deleted`, `notFound`
 * (already gone), and `failed` (still stored). When the request itself did not
 * go through, `degraded` says so and nothing may be shown as gone.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const uuids = await memoryUuidsFrom(request);
  if (uuids instanceof Response) return uuids;
  const result = await deleteMemories(uuids);
  if (result.reauthenticate) {
    return sessionExpiredResponse({ ok: false, degraded: SIGN_IN_AGAIN }, sourceHeaders(result));
  }
  if (result.state !== "live" || !result.data) {
    const degraded = result.degraded ?? "nothing was deleted";
    return NextResponse.json(
      { ok: false, degraded },
      { status: result.state === "absent" ? 200 : 502, headers: sourceHeaders(result) },
    );
  }
  return NextResponse.json({ ok: true, ...result.data }, { headers: sourceHeaders(result) });
}
