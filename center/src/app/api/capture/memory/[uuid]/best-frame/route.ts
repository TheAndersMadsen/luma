import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { sessionExpiredResponse } from "@/server/routeErrors";
import { logWarn } from "@/server/log";
import { setCaptureBestFrame } from "@/server/domain/captures";

export async function POST(
  request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  const { uuid } = await context.params;
  const body = (await request.json().catch(() => null)) as { frame?: unknown } | null;
  if (!body || !Number.isInteger(body.frame) || Number(body.frame) < 0) {
    return NextResponse.json({ error: "frame must be a non-negative integer" }, { status: 400 });
  }
  try {
    return NextResponse.json(await setCaptureBestFrame(uuid, Number(body.frame)), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    // Same seam, same answer as best-photo: a wearer's override that failed
    // because their session died must offer the sign-in, not a 502 about cosmos.
    if (error instanceof SessionExpiredError) return sessionExpiredResponse();
    // The internal `webapi <path> -> <status>` message stays in the log.
    logWarn(`capture ${uuid} best frame could not be set`, error);
    return NextResponse.json(
      { error: "frame selection unavailable" },
      { status: 502 },
    );
  }
}
