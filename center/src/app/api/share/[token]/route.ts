import { responseBytes } from "@/server/source";
import { resolveSharedThumbnail } from "../content";

/**
 * GET /api/share/{token}
 *
 * The BFF surface behind the PUBLIC share view. Resolves a signed share link via
 * CaptureService.GetShareLinkContents and returns the decrypted thumbnail bytes
 * (binary, with the sniffed content-type + length as metadata headers). On any
 * Invalid capabilities return 404. A valid capability whose backend cannot be
 * reached returns retryable 503 instead of falsely saying the memory is gone.
 *
 * Orchestrator note: `/share/**` and `/api/share/**` must be allowlisted in
 * src/middleware.ts so this route is reachable without a session.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const shared = await resolveSharedThumbnail(token);

  if (shared.status === "invalid") {
    return Response.json(
      { error: "This shared memory is no longer available" },
      { status: 404, headers: privateShareHeaders() },
    );
  }
  if (shared.status === "degraded") {
    return Response.json(
      { error: "This shared memory could not be loaded right now" },
      { status: 503, headers: { ...privateShareHeaders(), "retry-after": "5" } },
    );
  }

  // A view, not a copy — see `responseBytes`. The wrapper this replaces
  // duplicated the whole frame a second time to satisfy `BodyInit`.
  return new Response(responseBytes(shared.content.bytes), {
    status: 200,
    headers: {
      ...privateShareHeaders(),
      "content-type": shared.content.contentType,
      "content-length": String(shared.content.bytes.length),
    },
  });
}

function privateShareHeaders(): Record<string, string> {
  return {
    // A shared photo must disappear from intermediaries when its capability
    // expires; public caching would outlive that promise.
    "cache-control": "private, no-store, max-age=0",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  };
}
