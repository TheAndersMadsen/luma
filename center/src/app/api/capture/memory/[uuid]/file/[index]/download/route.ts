import { SessionExpiredError } from "@/server/cosmos";
import { getCaptureOriginal } from "@/server/source";

/**
 * GET /api/capture/memory/{uuid}/file/{index}/download
 *
 * The .Center download shape — `/capture/memory/{id}/file/{fileId}/download`.
 * Downloads the full-resolution encrypted upload after Carry authenticates and
 * opens its stock capture binding. The detail page continues to use the smaller
 * thumbnail for display.
 *
 * Its sibling `../route.ts` forwards the wearer's bearer and so does this, which
 * means a dead Keycloak grant arrives here as a typed error. Answered 401 +
 * `reauthenticate`, the same as api/settings/wifi: the bare catch below used to
 * turn it into "frame temporarily unavailable" with a `retry-after`, promising a
 * retry that could never succeed.
 */
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ uuid: string; index: string }> },
) {
  const { uuid, index } = await context.params;
  try {
    const frame = await getCaptureOriginal(uuid, Number(index) || 0);
    if (!frame) {
      return new Response("frame unavailable", { status: 404 });
    }

    const ext = EXT[frame.contentType] ?? "bin";
    // Streamed straight through. `getCaptureOriginal` decides everything it
    // needs to from the projection's response headers and never reads the body,
    // so a full-resolution original has no reason to be buffered in the BFF —
    // let alone buffered and then copied a second time, which is what the
    // `new Uint8Array(...)` wrapper here used to do to an already-Uint8Array.
    return new Response(frame.body, {
      headers: {
        "content-type": frame.contentType,
        "content-disposition": `attachment; filename="capture-${uuid}.${ext}"`,
        // The wearer's picture: never a shared cache.
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return Response.json(
        { error: "Your session expired — sign in again.", reauthenticate: true },
        { status: 401, headers: { "cache-control": "private, no-store" } },
      );
    }
    return new Response("frame temporarily unavailable", {
      status: 503,
      headers: { "retry-after": "5", "cache-control": "private, no-store" },
    });
  }
}
