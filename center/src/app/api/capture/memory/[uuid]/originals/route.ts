import { NextResponse } from "next/server";
import { SessionExpiredError } from "@/server/cosmos";
import { logWarn } from "@/server/log";
import { getCaptureOriginals } from "@/server/domain/captures";
import { cosmosStatus, sessionExpiredResponse } from "@/server/routeErrors";

/**
 * GET /api/capture/memory/{uuid}/originals, the full-resolution files Cosmos
 * holds for one capture (recovered `getWebapiMemoryIdOriginals`): each one's
 * index, kind and type, for the detail's Info panel and downloads.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await context.params;
  try {
    return NextResponse.json(await getCaptureOriginals(uuid), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) return sessionExpiredResponse();
    // The internal `webapi <path> -> <status>` message stays in the log.
    logWarn(`capture ${uuid} originals could not be listed`, error);
    return NextResponse.json(
      { error: "originals unavailable" },
      { status: cosmosStatus(error) === 404 ? 404 : 502 },
    );
  }
}
