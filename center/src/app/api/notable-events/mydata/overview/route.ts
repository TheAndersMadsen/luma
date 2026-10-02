import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getMyDataOverview } from "@/server/domain/events";

/**
 * GET /api/notable-events/mydata/overview?todayStart, powers the My Data stat
 * cards. `todayStart` is the wearer's last local midnight, which only their
 * browser knows. Cosmos counts Today from it and Total over everything.
 */
export async function GET(request: Request) {
  const result = await getMyDataOverview(new URL(request.url).searchParams.get("todayStart"));
  return NextResponse.json(result.data, { headers: sourceHeaders(result) });
}
