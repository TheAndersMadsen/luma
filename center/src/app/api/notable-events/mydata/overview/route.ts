import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getMyDataOverview } from "@/server/source";

/** GET /api/notable-events/mydata/overview — powers the My Data stat cards. */
export async function GET() {
  const result = await getMyDataOverview();
  const headers = sourceHeaders(result);
  return NextResponse.json(result.data, { headers });
}
