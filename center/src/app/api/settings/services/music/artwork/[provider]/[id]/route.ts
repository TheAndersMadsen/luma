import { requireSpotifySession } from "@/app/api/settings/services/spotify/routeSupport";
import { resolveMusicArtwork } from "@/server/musicArtwork";

const PRIVATE_HEADERS = {
  "cache-control": "private, max-age=86400",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
} as const;

type RouteContext = { params: Promise<{ provider: string; id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  try {
    const { provider, id } = await context.params;
    const artwork = await resolveMusicArtwork(provider, id);
    return new Response(null, {
      status: 302,
      headers: { ...PRIVATE_HEADERS, location: artwork },
    });
  } catch {
    return Response.json(
      { error: "Album artwork is unavailable." },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }
}
