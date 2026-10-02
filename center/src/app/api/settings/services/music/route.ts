import { musicAccountStatus } from "@/server/musicGateway";
import { requireSpotifySession, spotifyError, spotifyJson } from "../spotify/routeSupport";

export async function GET() {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  try {
    return spotifyJson((await musicAccountStatus(session.sub)).providers);
  } catch (error) {
    return spotifyError(error);
  }
}
