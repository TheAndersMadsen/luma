import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { sessionExpiredResponse, cosmosStatus } from "@/server/routeErrors";
import { logWarn } from "@/server/log";
import { setCaptureFavorite } from "@/server/domain/captures";

/**
 * POST /api/capture/memory/{uuid}/unfavorite, recovered `unFavoriteMemory`. Answers the
 * capture as Cosmos now holds it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  const { uuid } = await context.params;
  try {
    return NextResponse.json(await setCaptureFavorite(uuid, false), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) return sessionExpiredResponse();
    // The internal `webapi <path> -> <status>` message stays in the log.
    logWarn(`capture ${uuid} could not be unfavourited`, error);
    return NextResponse.json(
      { error: "favourites unavailable" },
      { status: cosmosStatus(error) === 404 ? 404 : 502 },
    );
  }
}
