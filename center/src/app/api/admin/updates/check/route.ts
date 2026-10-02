import { OPERATOR_UPDATES_PATH, isSameOriginRequest } from "@/server/auth";
import { requireOperatorRequest } from "@/server/operator";
import { updateOverview } from "@/server/domain/updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/updates/check, ask the update source again now, ignoring
 * the hourly cache. Operator only and same-origin. A plain form post (the
 * page works without JavaScript) is sent back to the Software updates page
 * with a 303. A fetch gets the refreshed overview as JSON.
 */
export async function POST(request: Request) {
  const gate = await requireOperatorRequest();
  if (gate instanceof Response) return gate;
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  const overview = await updateOverview({ force: true });
  if (request.headers.get("accept")?.includes("text/html")) {
    return new Response(null, {
      status: 303,
      headers: { location: OPERATOR_UPDATES_PATH, "cache-control": "private, no-store" },
    });
  }
  return Response.json(overview, { headers: { "cache-control": "private, no-store" } });
}
