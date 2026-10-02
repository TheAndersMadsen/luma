import { NextResponse } from "next/server";
import { getPrivacyDetails } from "@/server/domain/settings";
import { sourceHeaders } from "@/server/headers";
import { sessionExpiredResponse } from "@/server/routeErrors";

/** INFERRED, wearer-authenticated projection. Center stores no privacy data. */
export async function GET() {
  const read = await getPrivacyDetails();
  if (read.kind === "expired") return sessionExpiredResponse();
  if (read.kind !== "live") {
    return NextResponse.json(
      { details: null, state: read.kind },
      { headers: sourceHeaders({ state: read.kind, fallback: "empty" }) },
    );
  }
  return NextResponse.json(
    { details: read.value, state: "live" },
    { headers: sourceHeaders({ state: "live" }) },
  );
}
