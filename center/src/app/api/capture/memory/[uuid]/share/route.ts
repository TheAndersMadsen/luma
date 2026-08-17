import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { getCaptureFrame } from "@/server/source";
import { mintShareToken } from "@/server/shareToken";

/**
 * POST /api/capture/memory/{uuid}/share
 *
 * Mints the clone's signed seven-day capability after an authenticated frame
 * lookup proves that this wearer owns the memory. The public `/share/{token}`
 * page can then resolve that one frame without a Center login; guessed UUIDs,
 * modified tokens and expired links fail closed.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await context.params;

  try {
    const jar = await cookies();
    const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
    if (!session?.sub) {
      return NextResponse.json(
        { url: null, note: "Sign in again to share this capture." },
        { status: 401 },
      );
    }
    // Refuse to mint a capability for a guessed/non-owned UUID. This lookup is
    // authenticated through the same wearer session as the capture grid.
    const frame = await getCaptureFrame(uuid, 0);
    if (!frame) {
      return NextResponse.json(
        { url: null, note: "This capture isn't available to share." },
        { status: 200 },
      );
    }
    const token = await mintShareToken(uuid, session.sub);
    return NextResponse.json(
      { url: `/share/${encodeURIComponent(token)}`, token },
      { status: 200 },
    );
  } catch (error) {
    // The ownership lookup above forwards the wearer's bearer, so it can fail
    // for the one reason that is neither this capture's fault nor ours. It used
    // to be folded into the 200 "This capture isn't available to share." — a
    // verdict on the capture — while the same expiry produced 401 on the Wi-Fi
    // pane and "the backend is down" on Privacy.
    if (error instanceof SessionExpiredError) {
      return NextResponse.json(
        { url: null, note: "Sign in again to share this capture.", reauthenticate: true },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { url: null, note: "We couldn't create a share link right now." },
      { status: 200 },
    );
  }
}
