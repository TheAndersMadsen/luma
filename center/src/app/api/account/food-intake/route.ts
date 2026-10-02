import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getFoodIntake } from "@/server/domain/account";

/** An ISO instant, or `null` when it is missing or not one. */
function instant(value: string | null): string | null {
  if (value === null || value.trim() === "" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/**
 * GET /api/account/food-intake?startTime=&endTime=, what the wearer's food log
 * adds up to over a window (the Food page asks for local midnight until now),
 * against their daily intake goals. Cosmos's `/account-service/food-intake`
 * does the arithmetic. Center only renders it.
 *
 * `state` rides in the body, as on food-preferences: an unreadable log must
 * never render as "nothing eaten".
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const startTime = instant(params.get("startTime"));
  const endTime = instant(params.get("endTime"));
  if (!startTime || !endTime) {
    return NextResponse.json(
      { error: "startTime and endTime must be ISO dates" },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const result = await getFoodIntake(startTime, endTime);
  return NextResponse.json(
    {
      intake: result.data,
      state: result.state,
      degraded: result.degraded,
      reauthenticate: result.reauthenticate,
    },
    { headers: sourceHeaders(result) },
  );
}
