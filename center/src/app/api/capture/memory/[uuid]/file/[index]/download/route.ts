import { SessionExpiredError, webapiStream } from "@/server/cosmos";
import { requireWearerRequest } from "@/server/operator";
import { sessionExpiredResponse } from "@/server/routeErrors";

/**
 * GET /api/capture/memory/{uuid}/file/{index}/download
 *
 * The .Center download shape, `/capture/memory/{id}/file/{fileId}/download`.
 * Streams the full-resolution upload after Cosmos authenticates and opens its
 * stock capture binding: a photo as JPEG, a video as MP4. Nothing is buffered
 * in the BFF.
 *
 * The gate is in the route as well as the middleware, for the reason the frame
 * route next door gives: a guard in the handler cannot be bypassed by a matcher
 * edit or a rewrite. And the download's filename is built from a URL segment,
 * so the segment is stripped to the characters a filename may carry before it
 * reaches the `Content-Disposition` header.
 *
 * A dead Keycloak grant arrives here as a typed error and is answered 401 +
 * `reauthenticate`, the same as api/settings/wifi, never as a retryable outage.
 */
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "video/mp4": "mp4",
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ uuid: string; index: string }> },
) {
  const gate = await requireWearerRequest();
  if (gate instanceof Response) return gate;

  const { uuid, index } = await context.params;
  if (!/^\d{1,4}$/.test(index)) return new Response("file unavailable", { status: 404 });
  try {
    const file = await webapiStream(
      `/capture/memory/${encodeURIComponent(uuid)}/file/${index}/download`,
    );
    if (file.status === 404) return new Response("file unavailable", { status: 404 });
    if (file.status !== 200) {
      await file.body?.cancel().catch(() => undefined);
      return new Response("file temporarily unavailable", {
        status: 503,
        headers: { "retry-after": "5", "cache-control": "private, no-store" },
      });
    }
    const contentType = file.headers.get("content-type") ?? "application/octet-stream";
    const ext = EXT[contentType] ?? "bin";
    const stem = uuid.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
    const headers = new Headers(file.headers);
    headers.set("content-disposition", `attachment; filename="capture${stem ? `-${stem}` : ""}.${ext}"`);
    // The wearer's picture: never a shared cache.
    headers.set("cache-control", "private, no-store, max-age=0");
    headers.set("x-content-type-options", "nosniff");
    return new Response(file.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return sessionExpiredResponse({}, { "cache-control": "private, no-store" });
    }
    return new Response("file temporarily unavailable", {
      status: 503,
      headers: { "retry-after": "5", "cache-control": "private, no-store" },
    });
  }
}
