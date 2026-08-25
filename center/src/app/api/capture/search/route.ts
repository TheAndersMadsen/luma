import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { searchCaptures } from "@/server/domain/captures";

/**
 * GET /api/capture/search?query=&page=&size=
 *
 * The .Center capture search — `GET /capture/search?page&size&sort=createdAt,DESC&query`,
 * a Spring Data page over the webapi. Returns matching captures in .Center's own
 * wire shape (same mapping as GET /capture/captures).
 *
 * On any failure (no webapi configured, endpoint errors, backend has no search)
 * this returns an empty list tagged `x-data-source: fixtures` so the client falls
 * back to its local client-side filter instead of showing an error. A successful
 * empty result is tagged `cosmos`, so "no matches" and "search unavailable" stay
 * distinguishable.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("query") ?? "").trim();
  const size = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get("size") ?? "200", 10) || 200));
  const page = Math.max(0, Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0);

  if (!query) {
    return NextResponse.json([], {
      headers: sourceHeaders({ source: "cosmos", state: "live" }),
    });
  }

  try {
    const result = await searchCaptures(query, page, size);
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
        source: "unreachable",
        state: "degraded",
        fallback: "empty",
        degraded: error instanceof Error ? error.message : "capture search unavailable",
      }),
    });
  }
}
