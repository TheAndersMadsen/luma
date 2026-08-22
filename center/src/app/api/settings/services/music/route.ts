import { musicProviderStatus, musicGatewayError } from "@/server/musicGateway";
import { requireSpotifySession, spotifyJson } from "../spotify/routeSupport";

export async function GET() {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  try {
    return spotifyJson(await musicProviderStatus(session.sub));
  } catch (error) {
    return musicGatewayError(error);
  }
}
