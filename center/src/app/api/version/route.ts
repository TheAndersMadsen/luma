import { NextResponse } from "next/server";

import { centerRuntimeIdentity } from "@/lib/runtimeIdentity";
import { upstreamLatest } from "@/server/upstream-releases";

export const dynamic = "force-dynamic";

/** Public deployment identity for canaries, plus the release it advertises as newest. */
export async function GET() {
  const latest = await upstreamLatest();
  return NextResponse.json(
    { ...centerRuntimeIdentity(), latest },
    { headers: { "cache-control": "no-store" } },
  );
}
