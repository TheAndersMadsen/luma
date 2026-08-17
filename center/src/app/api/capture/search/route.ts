import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getCaptures } from "@/server/source";
import type { CaptureRecord } from "@/lib/types";

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
 * empty result is tagged `carry`, so "no matches" and "search unavailable" stay
 * distinguishable.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("query") ?? "").trim();
  const size = url.searchParams.get("size") ?? "200";
  const page = url.searchParams.get("page") ?? "0";

  if (!query) {
    return NextResponse.json([], {
      headers: sourceHeaders({ source: "carry", state: "live" }),
    });
  }

  try {
    // The clone's authenticated capture index is the source of truth. Humane's
    // web search endpoint is observed, but its private ranking/index internals
    // are unknown; this independently implemented compatibility projection
    // searches only fields Center actually receives and never fabricates tags.
    const result = await getCaptures();
    if (result.state !== "live") {
      return NextResponse.json([], { headers: sourceHeaders(result) });
    }

    const needle = query.toLowerCase();
    const matches = result.data.filter((record: CaptureRecord) =>
      record.uuid.toLowerCase().includes(needle) ||
      record.userCreatedAt.toLowerCase().includes(needle) ||
      (record.data.memoryType ?? "").toLowerCase().includes(needle),
    );
    const pageNumber = Math.max(0, Number.parseInt(page, 10) || 0);
    const pageSize = Math.max(1, Math.min(500, Number.parseInt(size, 10) || 200));
    const data = matches.slice(pageNumber * pageSize, (pageNumber + 1) * pageSize);
    return NextResponse.json(data, { headers: sourceHeaders(result) });
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
