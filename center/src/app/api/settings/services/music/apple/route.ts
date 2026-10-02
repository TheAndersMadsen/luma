import {
  AppleMusicError,
  appleDeveloperToken,
  connectAppleMusic,
  disconnectAppleMusic,
} from "@/server/appleMusic";
import { musicGatewayError } from "@/server/musicGateway";
import {
  boundedJsonBody,
  requireSameOrigin,
  requireSpotifySession,
  spotifyJson,
} from "../../spotify/routeSupport";

export async function GET() {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  try {
    return spotifyJson({ developer_token: appleDeveloperToken() });
  } catch (error) {
    return musicGatewayError(error);
  }
}

export async function POST(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    const body = await boundedJsonBody(request, {
      maxBytes: 24 * 1024,
      tooLargeMessage: "Apple Music sign-in is too large.",
    });
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppleMusicError("Expected an Apple Music account handoff object.", 400);
    }
    const handoff = body as { music_user_token?: unknown; storefront?: unknown };
    await connectAppleMusic(session.sub, handoff.music_user_token, handoff.storefront);
    return spotifyJson({ ok: true });
  } catch (error) {
    return musicGatewayError(error);
  }
}

export async function DELETE(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    await disconnectAppleMusic(session.sub);
    return spotifyJson({ ok: true });
  } catch (error) {
    return musicGatewayError(error);
  }
}
