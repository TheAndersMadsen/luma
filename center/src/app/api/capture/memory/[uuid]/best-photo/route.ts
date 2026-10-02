import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { sessionExpiredResponse } from "@/server/routeErrors";
import { logWarn } from "@/server/log";
import { rankCapture } from "@/server/domain/captures";

/**
 * Observed Center compatibility route backed by the clone-owned selector.
 * Humane's private model is unknown. Cosmos records which replacement selected
 * the frame and never deletes the two alternatives.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  const { uuid } = await context.params;
  try {
    const force = new URL(request.url).searchParams.get("force") === "true";
    return NextResponse.json(await rankCapture(uuid, force), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    // `rankCapture` reaches `webapiPost` -> `webapiHeaders()`, so an expired
    // grant lands here. Echoing `error.message` behind a 502 published the
    // sentence "The Keycloak grant behind this session expired" as a BACKEND
    // failure, the wearer's own fix, filed under someone else's fault.
    if (error instanceof SessionExpiredError) return sessionExpiredResponse();
    // The internal `webapi <path> -> <status>` message stays in the log.
    logWarn(`capture ${uuid} best photo could not be selected`, error);
    return NextResponse.json(
      { error: "best-frame selection unavailable" },
      { status: 502 },
    );
  }
}
