import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getEvents } from "@/server/source";
import type { DomainKey } from "@/server/cosmos";

const DOMAINS: DomainKey[] = ["AI_MIC", "CALL", "MUSIC", "TRANSLATION"];

/**
 * GET /api/notable-events/mydata?domain=AI_MIC — mirrors GET /notable-events/mydata.
 * The original also took page/size/sort; the clone's QueryEvents has no paging,
 * so we slice here and reproduce the envelope the page came in.
 *
 * That envelope is Spring Data's `Page<T>`, field for field. This route used to
 * emit six of its twelve fields — no `pageable`, `sort`, `first`,
 * `numberOfElements` or `empty` — while claiming in this very comment to mirror
 * the original, and its `Math.max(1, …)` reported one page for an empty result
 * where Spring (and Cosmos's own `paginate`, capture_api.rs) report zero. The
 * one consumer reads `content`, so nothing broke; but the layer below reproduces
 * the recovered contract exactly, and two layers disagreeing about the same
 * contract is how the next client written against it gets a surprise.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const domain = (url.searchParams.get("domain") ?? "AI_MIC").toUpperCase() as DomainKey;
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
  // Center's own default is the full page it fetches, not Spring's 20: this
  // route's only consumer is the My Data list, which asks for all of it.
  const size = clampSize(url.searchParams.get("size"));

  if (!DOMAINS.includes(domain)) {
    return NextResponse.json({ error: `unknown domain ${domain}` }, { status: 400 });
  }

  const result = await getEvents(domain);
  const total = result.data.length;
  const offset = page * size;
  const content = result.data.slice(offset, offset + size);
  const numberOfElements = content.length;

  const headers = sourceHeaders(result);

  // Every list here is server-sorted newest-first (see compareEventsNewestFirst),
  // which is the `userCreatedAt,DESC` the `.Center` client asked for — so `sort`
  // is always the sorted form, exactly as Cosmos reports it.
  const sort = { empty: false, sorted: true, unsorted: false };

  return NextResponse.json(
    {
      content,
      pageable: {
        pageNumber: page,
        pageSize: size,
        sort,
        offset,
        paged: true,
        unpaged: false,
      },
      // `last` is a property of the page position: true when this page reaches
      // or passes the final element, including the empty page past the end.
      last: offset + numberOfElements >= total,
      totalElements: total,
      // No floor. An empty domain has zero pages, not one.
      totalPages: Math.ceil(total / size),
      size,
      number: page,
      sort,
      first: page === 0,
      numberOfElements,
      empty: numberOfElements === 0,
    },
    { headers },
  );
}

/** Cosmos clamps to `MAX_PAGE_SIZE`; mirror the bound so both agree. */
function clampSize(value: string | null): number {
  const parsed = Number(value ?? 200);
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}
