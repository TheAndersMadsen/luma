import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getFoodLog } from "@/server/domain/captures";
import { sessionExpiredResponse } from "@/server/routeErrors";

/** An ISO instant, or nothing. Anything else is refused before Cosmos is asked. */
function instant(value: string | null): string | undefined | null {
  if (value === null || value.trim() === "") return undefined;
  return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
}

/**
 * GET /api/capture/food-log?startTime=&endTime=, what the wearer logged with
 * the Pin's food experience, opened by Cosmos (recovered `getFoodLog`). Both
 * bounds are ISO instants and inclusive. A bare array with provenance headers.
 * Entries Cosmos keeps sealed are counted in `x-data-degraded` on a live read.
 * An expired session answers 401 + `reauthenticate`, never an empty day.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const startTime = instant(params.get("startTime"));
  const endTime = instant(params.get("endTime"));
  if (startTime === null || endTime === null) {
    return NextResponse.json(
      { error: "startTime and endTime must be ISO dates" },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const result = await getFoodLog(startTime, endTime);
  if (result.reauthenticate) {
    return sessionExpiredResponse({}, sourceHeaders(result));
  }
  return NextResponse.json(result.data, { headers: sourceHeaders(result) });
}
