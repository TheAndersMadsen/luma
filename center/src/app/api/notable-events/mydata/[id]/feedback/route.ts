import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import type { EventVote } from "@/lib/contracts/events";
import { isSameOriginRequest } from "@/server/auth";
import { EVENT_GONE, setEventVote } from "@/server/domain/events";
import { sourceHeaders } from "@/server/headers";
import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { NextResponse } from "next/server";
import { SIGN_IN_AGAIN, sessionExpiredResponse } from "@/server/routeErrors";

type Context = { params: Promise<{ id: string }> };


/** The vote in a `{vote: "up" | "down"}` body, or `undefined` when it is not one. */
function parseVote(body: unknown): EventVote | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { vote, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return undefined;
  return vote === "up" || vote === "down" ? vote : undefined;
}

/**
 * Record (`vote`) or withdraw (`null`) the wearer's rating of one Ai Mic
 * answer, through Cosmos `POST|DELETE /notable-events/event/{id}/feedback`.
 *
 * `{ok: true, vote}` is what Cosmos now holds. A vote that did not land says so
 * in `degraded`, and the row keeps showing what it showed before.
 */
async function answer(request: Request, context: Context, vote: EventVote | null) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const { id } = await context.params;
  const result = await setEventVote(id, vote);
  if (result.reauthenticate) {
    return sessionExpiredResponse({ ok: false, degraded: SIGN_IN_AGAIN });
  }
  const headers = sourceHeaders(result);
  if (result.state === "live" && result.data) {
    return NextResponse.json({ ok: true, vote: result.data.vote }, { headers });
  }
  if (result.state === "live") {
    return NextResponse.json({ ok: false, degraded: EVENT_GONE }, { status: 404, headers });
  }
  const degraded = result.degraded ?? "The vote was not saved.";
  return NextResponse.json(
    { ok: false, degraded },
    { status: result.state === "degraded" ? 502 : 503, headers },
  );
}

/** POST /api/notable-events/mydata/{id}/feedback `{vote: "up" | "down"}`. */
export async function POST(request: Request, context: Context) {
  // Refuse another site before reading anything it sent.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  let vote: EventVote | undefined;
  try {
    vote = parseVote(
      await boundedJsonBody(request, { tooLargeMessage: "That request is too large." }),
    );
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    throw error;
  }
  if (!vote) {
    return NextResponse.json({ ok: false, error: "Expected {\"vote\": \"up\" | \"down\"}." }, { status: 400 });
  }
  return answer(request, context, vote);
}

/** DELETE /api/notable-events/mydata/{id}/feedback, withdraw the vote. */
export async function DELETE(request: Request, context: Context) {
  return answer(request, context, null);
}
