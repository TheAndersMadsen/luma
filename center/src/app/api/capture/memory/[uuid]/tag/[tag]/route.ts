import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { SessionExpiredError } from "@/server/cosmos";
import { sessionExpiredResponse } from "@/server/routeErrors";
import { logWarn } from "@/server/log";
import { removeCaptureTag } from "@/server/domain/captures";

/**
 * DELETE /api/capture/memory/{uuid}/tag/{tag}, recovered `removeTagMemory`,
 * under the delete contract: `deleted` is Cosmos's own answer, `false` when the
 * capture did not carry that tag.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ uuid: string; tag: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const { uuid, tag } = await context.params;
  try {
    const deleted = await removeCaptureTag(uuid, tag);
    return NextResponse.json({ ok: true, deleted }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SessionExpiredError) return sessionExpiredResponse({ ok: false });
    // The internal `webapi <path> -> <status>` message stays in the log.
    logWarn(`capture ${uuid} tag ${tag} could not be removed`, error);
    return NextResponse.json(
      { ok: false, error: "tags unavailable" },
      { status: 502 },
    );
  }
}
