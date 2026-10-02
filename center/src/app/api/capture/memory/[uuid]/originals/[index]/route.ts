import { SessionExpiredError, webapiStream } from "@/server/cosmos";
import { requireWearerRequest } from "@/server/operator";
import { sessionExpiredResponse } from "@/server/routeErrors";

/**
 * GET|HEAD /api/capture/memory/{uuid}/originals/{index}
 *
 * One full-resolution file, streamed from Cosmos's
 * `/capture/memory/{uuid}/file/{fileId}`: a photo as JPEG, a video as MP4. The
 * browser's `Range` is forwarded so a `<video>` can seek, and `HEAD` answers the
 * size (recovered `getEncryptedMediaSize`). Nothing is buffered here.
 *
 * The gate is in the route as well as the middleware, for the reason the frame
 * route next door gives: a guard in the handler cannot be bypassed by a
 * matcher edit or a rewrite.
 */
async function stream(
  request: Request,
  context: { params: Promise<{ uuid: string; index: string }> },
  method: "GET" | "HEAD",
): Promise<Response> {
  const gate = await requireWearerRequest();
  if (gate instanceof Response) return gate;
  const { uuid, index } = await context.params;
  if (!/^\d{1,4}$/.test(index)) return new Response("no such file", { status: 404 });
  try {
    const response = await webapiStream(
      `/capture/memory/${encodeURIComponent(uuid)}/file/${index}`,
      { range: request.headers.get("range"), method },
    );
    // A photo is a picture and a video is a video. Neither is a document, so
    // it never renders as one on Center's origin.
    response.headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
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

export function GET(
  request: Request,
  context: { params: Promise<{ uuid: string; index: string }> },
) {
  return stream(request, context, "GET");
}

export function HEAD(
  request: Request,
  context: { params: Promise<{ uuid: string; index: string }> },
) {
  return stream(request, context, "HEAD");
}
