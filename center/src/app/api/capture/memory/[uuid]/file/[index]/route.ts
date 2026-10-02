import { SessionExpiredError } from "@/server/cosmos";
import { requireWearerRequest } from "@/server/operator";
import { getCaptureFrame, responseBytes } from "@/server/domain/captures";
import { sessionExpiredResponse } from "@/server/routeErrors";

/**
 * GET /api/capture/memory/{uuid}/file/{index}
 *
 * The shape .Center itself fetched, `/capture/memory/{memoryId}/file/{fileId}`.
 * Cosmos opens the frame for the verified wearer (`getCaptureFrame`) and this
 * route hands back the picture. Center holds no key.
 *
 * A dead Keycloak grant behind a still-valid Center cookie is answered 401 +
 * `reauthenticate`, exactly as api/settings/wifi answers it. It used to be
 * swallowed into a 404 "frame unavailable", a statement about the capture, for
 * a condition that had nothing to do with the capture and that only the wearer
 * could fix.
 *
 * THE GATE IS IN THE ROUTE, not only in the matcher. This handler coerces its
 * last path segment with `Number(index) || 0`, so `…/file/0.png` is the same
 * request as `…/file/0` as far as it is concerned, and the middleware matcher
 * used to skip any pathname ending in an image extension, which meant that one
 * appended suffix ran this handler with no session at all. The matcher is fixed
 * too, but a guard that lives in the route cannot be bypassed by a matcher edit,
 * a rewrite, or a route reached some other way. That argument is already written
 * down in src/server/operator.ts and this route was the one that ignored it.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ uuid: string; index: string }> },
) {
  const gate = await requireWearerRequest();
  if (gate instanceof Response) return gate;

  const { uuid, index } = (await context.params) as { uuid: string; index: string };

  let frame: Awaited<ReturnType<typeof getCaptureFrame>>;
  try {
    frame = await getCaptureFrame(uuid, Number(index) || 0);
  } catch (error) {
    if (error instanceof SessionExpiredError) return reauthenticate();
    throw error;
  }

  if (!frame) {
    return new Response("frame unavailable", {
      status: 404,
      headers: {
        // A transient auth/key refresh miss must never become a cached broken
        // image after the same frame is immediately readable.
        "cache-control": "private, no-store",
      },
    });
  }

  // A view, not a copy: the `new Uint8Array(frame.bytes)` this replaces
  // duplicated the whole picture on every request purely to satisfy `BodyInit`.
  return new Response(responseBytes(frame.bytes), {
    headers: {
      "content-type": frame.contentType,
      // The wearer's picture: never a shared cache, never revalidated elsewhere.
      "cache-control": "private, no-store",
      /*
       * These bytes are sniffed, and `sniff()` can return image/svg+xml, which
       * is a DOCUMENT, not a picture. Served under the app's own global CSP
       * (`script-src 'self' 'unsafe-inline'`, from next.config.mjs) a wearer who
       * navigated straight to this URL would render attacker-authored markup as
       * a same-origin document on Center, with inline script allowed. The public
       * share route treats byte-for-byte identical output as untrusted and
       * sandboxes it. The wearer's own route was the one getting the weaker
       * treatment. Same header, same reason, and it costs a real photo nothing.
       */
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

function reauthenticate(): Response {
  return sessionExpiredResponse({}, { "cache-control": "private, no-store" });
}
