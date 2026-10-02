import { runSpotifySearch } from "@/server/spotifyBridge";
import {
  requireSameOrigin,
  requireSpotifySession,
  spotifyError,
  spotifyJson,
} from "../routeSupport";

/*
 * "Does Spotify actually work on my Pin?", answered without playing anything.
 *
 * A paired status only says the Pin holds a session. This runs a real query
 * through that session, so a Premium account that lapsed, a token the engine
 * never refreshed, or a Pin that is paired but not reachable all show up as a
 * failed search instead of as silence the next time the wearer asks for a song.
 *
 * Same-origin is required even though this is a GET. The status GET beside it
 * is a read of state Center already holds. This one makes the Pin call
 * Spotify's API on the wearer's account, so it is not something another site
 * gets to trigger by embedding a URL.
 */
export async function GET(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    const query = new URL(request.url).searchParams.get("q");
    return spotifyJson(await runSpotifySearch(session, query, request.signal));
  } catch (error) {
    return spotifyError(error);
  }
}
