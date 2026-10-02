import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { createCaptureShareLink } from "@/server/domain/captures";
import { cosmosStatus, sessionExpiredResponse } from "@/server/routeErrors";

/**
 * POST /api/capture/memory/{uuid}/share
 *
 * Asks Cosmos, the one share authority, for this capture's share link. It is
 * the same link the Pin's `GetMemoryShareLink` makes, in the shape stock
 * Messages recognises: `…/humane.center/share/capture/<uuid>?expiry=…&signature=…`.
 * Cosmos checks the capture is this wearer's before it mints anything, and the
 * public page resolves the link through Cosmos too. Center holds no key.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  // Minting a public link is a write: only Center's own pages may ask for one.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ url: null, note: "Cross-site request refused." }, { status: 403 });
  }
  const { uuid } = await context.params;
  try {
    const link = await createCaptureShareLink(uuid);
    return NextResponse.json(
      { url: link.url, expiry: link.expiry },
      { status: 200, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return sessionExpiredResponse({ url: null, note: "Sign in again to share this capture." });
    }
    const status = cosmosStatus(error);
    // Three different failures, three different sentences: a capture Cosmos
    // does not hold for this wearer (404), a deployment that cannot mint
    // links (501), and anything else, a 503 store outage included, which a
    // retry may cure.
    if (status === 404) {
      return NextResponse.json(
        { url: null, note: "This capture isn't available to share." },
        { status: 200 },
      );
    }
    if (status === 501) {
      return NextResponse.json(
        { url: null, note: "Sharing isn't set up on this server." },
        { status: 200 },
      );
    }
    return NextResponse.json(
      { url: null, note: "We couldn't create a share link right now." },
      { status: 502 },
    );
  }
}
