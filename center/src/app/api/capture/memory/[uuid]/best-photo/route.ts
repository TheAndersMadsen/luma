import { NextResponse } from "next/server";
import { SessionExpiredError } from "@/server/cosmos";
import { rankCapture } from "@/server/source";

/**
 * Observed Center compatibility route backed by the clone-owned selector.
 * Humane's private model is unknown; Carry records which replacement selected
 * the frame and never deletes the two alternatives.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
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
    // failure — the wearer's own fix, filed under someone else's fault.
    if (error instanceof SessionExpiredError) {
      return NextResponse.json(
        { error: "Your session expired — sign in again.", reauthenticate: true },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "best-frame selection unavailable" },
      { status: 502 },
    );
  }
}
