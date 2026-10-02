import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getDashboardContent } from "@/server/domain/dashboard";

/**
 * GET /api/capture/memories, mirrors Cosmos `GET /capture/memories`, the
 * aggregate that fed the Memories dashboard: { photos, aiSessions,
 * playTrackEvents, notes, phoneCalls, health }. Cosmos decides how many
 * records each slot carries. The body adds each part's provenance.
 */
export async function GET() {
  const result = await getDashboardContent();
  return NextResponse.json(result.data, { headers: sourceHeaders(result) });
}
