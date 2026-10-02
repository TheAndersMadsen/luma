import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { logWarn } from "@/server/log";
import { addCaptureTag } from "@/server/domain/captures";
import { cosmosStatus, sessionExpiredResponse } from "@/server/routeErrors";

/**
 * POST /api/capture/memory/{uuid}/tag {text}, add the wearer's tag (recovered
 * `tagMemory`, body `humane.capture.Tag`). Cosmos bounds a tag to 64 printable
 * characters and a capture to 32 tags. Answers the capture as it now reads.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  const { uuid } = await context.params;
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  // Characters, as Cosmos counts them, not UTF-16 units, which would refuse a
  // tag of emoji that Cosmos accepts.
  if (!text || [...text].length > 64) {
    return NextResponse.json({ error: "A tag is 1 to 64 characters." }, { status: 400 });
  }
  try {
    return NextResponse.json(await addCaptureTag(uuid, text), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) return sessionExpiredResponse();
    // Cosmos refused the tag itself (too many, or not printable): say so
    // rather than blaming the connection.
    if (cosmosStatus(error) === 400) {
      return NextResponse.json(
        { error: "That tag can't be added. A capture holds up to 32 tags." },
        { status: 400 },
      );
    }
    // The internal `webapi <path> -> <status>` message stays in the log.
    logWarn(`capture ${uuid} tag could not be added`, error);
    return NextResponse.json({ error: "tags unavailable" }, { status: 502 });
  }
}
