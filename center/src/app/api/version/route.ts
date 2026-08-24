import { NextResponse } from "next/server";

import { centerRuntimeIdentity } from "@/lib/runtimeIdentity";

export const dynamic = "force-dynamic";

/** Public deployment identity for canaries; deliberately excludes infrastructure details. */
export async function GET() {
  return NextResponse.json(
    centerRuntimeIdentity(),
    { headers: { "cache-control": "no-store" } },
  );
}
