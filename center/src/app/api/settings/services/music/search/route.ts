import type { MusicProvider } from "@/lib/contracts/music";
import { gatewayQuery, musicGatewayError } from "@/server/musicGateway";
import { requireSameOrigin, requireSpotifySession, spotifyJson } from "../../spotify/routeSupport";

/*
 * Same-origin is required even though this is a GET, for the same reason
 * spotify/search beside it requires it: this queries the wearer's linked
 * provider account, so it is not something another site gets to trigger by
 * embedding a URL.
 */
export async function GET(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const provider = url.searchParams.get("provider") as MusicProvider | null;
  if (!query || [...query].length > 80 || !new Set(["youtube_music", "tidal"]).has(provider ?? "")) {
    return spotifyJson({ error: "Choose a connected provider and enter a short search." }, 400);
  }
  try {
    return spotifyJson(await gatewayQuery(session.sub, {
      provider: provider!,
      kind: "track",
      primary: query,
      limit: 10,
    }, request.signal));
  } catch (error) {
    return musicGatewayError(error);
  }
}
