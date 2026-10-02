import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { sessionExpiredResponse } from "@/server/routeErrors";
import { logWarn } from "@/server/log";
import { setCapturesFavorite } from "@/server/domain/captures";
import { memoryUuidsFrom } from "../memoryUuids";

/**
 * POST /api/capture/memory/bulk-unfavorite {memoryUUIDs}, Unstar every selected
 * capture (recovered `bulkUnFavoriteMemories`). Answers how many of the wearer's captures
 * changed.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const uuids = await memoryUuidsFrom(request);
  if (uuids instanceof Response) return uuids;
  try {
    const updated = await setCapturesFavorite(uuids, false);
    return NextResponse.json(
      { ok: true, updated },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof SessionExpiredError) return sessionExpiredResponse({ ok: false });
    // The internal `webapi <path> -> <status>` message stays in the log.
    logWarn(`${uuids.length} captures could not be unfavourited`, error);
    return NextResponse.json(
      { ok: false, error: "favourites unavailable" },
      { status: 502 },
    );
  }
}
