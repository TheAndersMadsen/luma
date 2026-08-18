import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RELEASE_ID =
  process.env.REVIVAL_RELEASE_ID?.trim() ||
  process.env.COSMOS_REVISION?.trim() ||
  "development";

/** Public deployment identity for canaries; deliberately excludes infrastructure details. */
export async function GET() {
  return NextResponse.json(
    { product: "Ai Pin Revival Center", release: RELEASE_ID },
    { headers: { "cache-control": "no-store" } },
  );
}
