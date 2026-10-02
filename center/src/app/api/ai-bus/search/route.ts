import { MY_DATA_SEARCH_MAX_CHARS, isMyDataSearchDomain, searchMyData } from "@/server/domain/events";
import { sourceHeaders } from "@/server/headers";
import { NextResponse } from "next/server";

/** A whole-number query parameter, or `undefined` for Cosmos's default. */
function wholeNumber(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}

/**
 * GET /api/ai-bus/search?domain=AI_MIC|MUSIC&query&page&size, mirrors Cosmos
 * `GET /ai-bus/search` (recovered `search({query, domain})`) for the two My
 * Data domains Humane made searchable: one Spring page of matching events,
 * newest first, in the `/notable-events/mydata` row shape. Captures and notes
 * are searched through `/api/capture/search` and `/api/capture/notes`.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const domain = (params.get("domain") ?? "").toUpperCase();
  if (!isMyDataSearchDomain(domain)) {
    return NextResponse.json(
      { error: "Only Ai Mic and Music can be searched here." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const query = (params.get("query") ?? "").trim();
  // Characters, as Cosmos counts them, not UTF-16 units.
  if ([...query].length > MY_DATA_SEARCH_MAX_CHARS) {
    return NextResponse.json(
      { error: `A search is at most ${MY_DATA_SEARCH_MAX_CHARS} characters.` },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const result = await searchMyData(domain, query, {
    page: wholeNumber(params.get("page")),
    size: wholeNumber(params.get("size")),
  });
  return NextResponse.json(result.data, {
    headers: { ...sourceHeaders(result), "cache-control": "private, no-store" },
  });
}
