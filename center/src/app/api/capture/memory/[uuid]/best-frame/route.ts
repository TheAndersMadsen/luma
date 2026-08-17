import { NextResponse } from "next/server";
import { SessionExpiredError } from "@/server/cosmos";
import { setCaptureBestFrame } from "@/server/source";

export async function POST(
  request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
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
    // because their session died must offer the sign-in, not a 502 about carry.
    if (error instanceof SessionExpiredError) {
      return NextResponse.json(
        { error: "Your session expired — sign in again.", reauthenticate: true },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "frame selection unavailable" },
      { status: 502 },
    );
  }
}
