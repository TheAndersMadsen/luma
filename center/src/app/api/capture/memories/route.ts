import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getDashboardContent, type DashboardLimits } from "@/server/source";

/**
 * GET /api/capture/memories — mirrors GET /capture/memories, the aggregate that
 * fed the Memories dashboard: { photos, aiSessions, playTrackEvents, notes,
 * phoneCalls, health }.
 *
 * The five optional counts are Center's own addition and every one of them
 * defaults to the stock page size, so a caller that passes nothing gets exactly
 * what this route has always returned. They exist because the dashboard renders
 * eight fixed slots and this route was shipping ~500 records into them every
 * five seconds — each note and each event decrypted server side on the way out.
 * The response SHAPE is untouched; only the volume follows the consumer.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limits: DashboardLimits = {
    captures: countParam(params.get("captures")),
    notes: countParam(params.get("notes")),
    aiMic: countParam(params.get("aiMic")),
    music: countParam(params.get("music")),
    calls: countParam(params.get("calls")),
  };

  const result = await getDashboardContent(limits);
  const headers = sourceHeaders(result);
  return NextResponse.json(result.data, { headers });
}

/**
 * A count, or nothing at all.
 *
 * Undefined — not zero and not a clamp to one — is what makes an absent or
 * unparseable parameter fall through to the stock page size rather than
 * silently emptying a part of the aggregate.
 */
function countParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.trunc(parsed);
}
