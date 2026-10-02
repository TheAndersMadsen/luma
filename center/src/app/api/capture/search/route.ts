import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { searchCaptures } from "@/server/domain/captures";

/**
 * GET /api/capture/search?query=&page=&size=&favorites=1
 *
 * The .Center capture search, `GET /capture/search?page&size&sort=createdAt,DESC&query`,
 * a Spring Data page over the webapi. Returns matching captures in .Center's own
 * wire shape (same mapping as GET /capture/captures).
 *
 * `favorites=1` is the recovered `onlyContainingFavorited` filter, applied by
 * Cosmos with the search, so the grid never filters a search result itself.
 *
 * On any failure (no webapi configured, endpoint errors, backend has no search)
 * this returns an empty list whose `x-data-state` is not `live`, so the client
 * falls back to its local client-side filter instead of showing an error. A
 * successful empty result is `live`, so "no matches" and "search unavailable"
 * stay distinguishable.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("query") ?? "").trim();
  const size = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get("size") ?? "200", 10) || 200));
  const page = Math.max(0, Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0);
  const favorites = url.searchParams.get("favorites") === "1";

  if (!query) {
    return NextResponse.json([], {
      headers: sourceHeaders({ state: "live" }),
    });
  }

  try {
    const result = await searchCaptures(query, page, size, { favorites });
    if (result.state !== "live") {
      return NextResponse.json([], { headers: sourceHeaders(result) });
    }
    return NextResponse.json(result.data, {
      headers: {
        ...sourceHeaders(result),
        "x-total-count": String(result.total ?? result.data.length),
        ...(result.visualIndex ? { "x-visual-index": result.visualIndex } : {}),
        ...(result.visualPending ? { "x-visual-pending": String(result.visualPending) } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json([], {
      headers: sourceHeaders({
        state: "degraded",
        fallback: "empty",
        degraded: error instanceof Error ? error.message : "capture search unavailable",
      }),
    });
  }
}
