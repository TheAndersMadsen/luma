import { requireOperatorRequest } from "@/server/operator";
import { updateOverview } from "@/server/domain/updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/updates, what this Center runs, what the update source
 * offers, and what the last update did. Operator only, twice: middleware
 * gates `/api/admin/*`, and the route decides again from the session. The
 * check itself is cached for an hour; `POST /api/admin/updates/check` forces
 * one.
 */
export async function GET() {
  const gate = await requireOperatorRequest();
  if (gate instanceof Response) return gate;
  return Response.json(await updateOverview(), { headers: { "cache-control": "private, no-store" } });
}
