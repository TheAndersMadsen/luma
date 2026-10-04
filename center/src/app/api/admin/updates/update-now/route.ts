import { OPERATOR_UPDATES_PATH, isSameOriginRequest } from "@/server/auth";
import { requireOperatorRequest } from "@/server/operator";
import { requestUpdateNow, updateOverview } from "@/server/domain/updates";
import type { UpdateRequestOutcome } from "@/server/domain/updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<UpdateRequestOutcome, number> = {
  requested: 200,
  "already-requested": 409,
  unsupported: 503,
  failed: 500,
};

/**
 * POST /api/admin/updates/update-now, ask the server's update service to
 * install the offered release: the same verified `./luma update production`
 * the command runs, backup first. Operator only and same-origin. A plain
 * form post (the page works without JavaScript) is sent back to the Software
 * updates page, whose request state shows what happened; a fetch gets the
 * outcome and the refreshed overview as JSON.
 */
export async function POST(request: Request) {
  const gate = await requireOperatorRequest();
  if (gate instanceof Response) return gate;
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  const outcome = await requestUpdateNow();
  if (request.headers.get("accept")?.includes("text/html")) {
    return new Response(null, {
      status: 303,
      headers: { location: OPERATOR_UPDATES_PATH, "cache-control": "private, no-store" },
    });
  }
  return Response.json(
    { outcome, overview: await updateOverview() },
    { status: STATUS[outcome], headers: { "cache-control": "private, no-store" } },
  );
}
