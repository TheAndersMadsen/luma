import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getCaptures } from "@/server/source";

/**
 * GET /api/capture/captures — the capture list on its own.
 *
 * The Captures grid used to read the whole Memories aggregate and throw four of
 * its five collections away: notes, Ai Mic, music and calls were fetched,
 * decrypted server side, serialised and discarded on every mount, and a failure
 * in any of them dragged the response-level provenance down with it — which is
 * why the client had to narrow the aggregate's state back to the captures leg by
 * hand.
 *
 * One leg, one route: the `x-data-*` headers here describe the capture backend
 * and nothing else, so `state === "live"` with an empty list means exactly what
 * it says — the wearer has no captures.
 *
 * The body keeps the aggregate's `photos` key so the two routes stay readable as
 * the same projection at different widths.
 */
export async function GET(request: Request) {
  const size = Number(new URL(request.url).searchParams.get("size"));
  const result = await getCaptures(Number.isFinite(size) && size >= 1 ? size : undefined);
  // `total` is what the backend says the wearer HAS, beside the page we are
  // returning. Without it the grid could only count its own tiles, so a wearer
  // with more captures than one capped page was shown a number that was really
  // the page size and a search that had silently only looked at the newest 200.
  return NextResponse.json(
    { photos: result.data, total: result.total },
    { headers: sourceHeaders(result) },
  );
}
