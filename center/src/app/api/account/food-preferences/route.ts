import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import { isSameOriginRequest } from "@/server/auth";
import { getFoodPreferences, parseFoodPreferencesWrite, saveFoodPreferences } from "@/server/domain/account";
import { sourceHeaders } from "@/server/headers";
import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { NextResponse } from "next/server";
import { accountWriteResponse } from "../accountWriteResponse";

/**
 * GET /api/account/food-preferences, the wearer's food restrictions and daily
 * intake goals, as Cosmos's `/account-service/food-preferences` serves them
 * (the same rows `FoodPreferencesService` answers the Pin with).
 *
 * `state` rides in the body because the pane reads the body: an unreadable
 * account must never render as "no goals set".
 */
export async function GET() {
  const result = await getFoodPreferences();
  return NextResponse.json(
    {
      preferences: result.data,
      state: result.state,
      degraded: result.degraded,
      reauthenticate: result.reauthenticate,
    },
    { headers: sourceHeaders(result) },
  );
}

/**
 * POST /api/account/food-preferences {restrictions?, dailyIntakeGoals?}, each
 * list present replaces that half. A half left out is kept. Answers
 * `{ok, preferences}` with what Cosmos stored.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  // Room for a real restrictions and goals list. Refused before parsed.
  let raw: unknown;
  try {
    raw = await boundedJsonBody(request, {
      maxBytes: 16 * 1024,
      tooLargeMessage: "That food preferences update is too large.",
    });
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    throw error;
  }
  const input = parseFoodPreferencesWrite(raw);
  if (!input) {
    return NextResponse.json(
      { ok: false, error: "Expected a JSON {restrictions, dailyIntakeGoals} object of lists." },
      { status: 400 },
    );
  }
  return accountWriteResponse("preferences", await saveFoodPreferences(input));
}
