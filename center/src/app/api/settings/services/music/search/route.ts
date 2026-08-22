import { gatewayQuery, musicGatewayError } from "@/server/musicGateway";
import type { MusicProvider } from "@/server/spotifyBridge";
import { requireSpotifySession, spotifyJson } from "../../spotify/routeSupport";

export async function GET(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
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
    }));
  } catch (error) {
    return musicGatewayError(error);
  }
}
