import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getMyData, isMyDataDomain } from "@/server/domain/events";

/** A whole-number query parameter, or `undefined` for Cosmos's default. */
function wholeNumber(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}

/**
 * GET /api/notable-events/mydata?domain&page&size, mirrors Cosmos
 * `GET /notable-events/mydata` verbatim: one Spring page of the domain,
 * newest first, each row in the recovered `{uuid, userCreatedAt, data}`
 * envelope. Cosmos filters, opens, renames and groups the rows.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const domain = (params.get("domain") ?? "").toUpperCase();
  if (!isMyDataDomain(domain)) {
    return NextResponse.json({ error: "Unknown My Data domain." }, { status: 400 });
  }
  const result = await getMyData(domain, {
    page: wholeNumber(params.get("page")),
    size: wholeNumber(params.get("size")),
  });
  return NextResponse.json(result.data, { headers: sourceHeaders(result) });
}
