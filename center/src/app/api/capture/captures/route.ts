import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getCaptures } from "@/server/domain/captures";

/**
 * GET /api/capture/captures?page=&size=&favorites=1, one page of the capture
 * grid on its own.
 *
 * One leg, one route: the `x-data-*` headers here describe the capture plane
 * and nothing else, so `state === "live"` with an empty list means exactly what
 * it says, the wearer has no captures (or, with `favorites=1`, no favourites).
 *
 * `page` walks the whole library, past Cosmos's 200-row page; `last` says when
 * there is nothing further. `favorites=1` is the recovered
 * `onlyContainingFavorited` filter, applied by Cosmos in the store.
 *
 * The body keeps the aggregate's `photos` key so the two routes stay readable as
 * the same projection at different widths.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const size = Number(params.get("size"));
  const page = Number.parseInt(params.get("page") ?? "0", 10);
  const result = await getCaptures(Number.isFinite(size) && size >= 1 ? size : undefined, {
    page: Number.isFinite(page) && page >= 0 ? page : 0,
    favorites: params.get("favorites") === "1",
  });
  // `total` is what Cosmos says the wearer HAS, beside the page we are
  // returning, so the grid can say how much of the library it is showing.
  return NextResponse.json(
    { photos: result.data, total: result.total, page: result.page, last: result.last },
    { headers: sourceHeaders(result) },
  );
}
