import { isSameOriginRequest } from "@/server/auth";
import { copyClip } from "@/server/domain/clips";
import { clipIdSchema, clipWriteSchema } from "@/lib/contracts/clips";
import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import { SpotifyBridgeError } from "@/server/spotifyBridge";

const headers = { "cache-control": "private, no-store" };
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) return Response.json({ error: "cross_site" }, { status: 403, headers });
  const id = clipIdSchema.safeParse((await context.params).id);
  if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400, headers });
  let raw: unknown;
  try { raw = await boundedJsonBody(request, { maxBytes: 64 * 1024, tooLargeMessage: "The article is too large." }); }
  catch (error) {
    if (error instanceof SpotifyBridgeError) return Response.json({ error: "invalid_request" }, { status: error.status, headers });
    throw error;
  }
  const article = clipWriteSchema.safeParse(raw);
  if (!article.success) return Response.json({ error: "invalid_article" }, { status: 400, headers });
  const result = await copyClip(id.data, article.data);
  if (result.reauthenticate) return Response.json({ error: "sign_in_required", reauthenticate: true }, { status: 401, headers });
  if (result.state === "live" && result.data) return Response.json(result.data, { headers });
  const status = result.refusal === "conflict" ? 409 : result.refusal === "invalid" ? 400 : result.refusal === "too_large" ? 413 : 503;
  return Response.json({ error: result.refusal ?? "copy_unconfirmed" }, { status, headers });
}
