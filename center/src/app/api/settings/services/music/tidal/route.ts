import {
  disconnectTidal,
  musicGatewayError,
  startTidalConnection,
} from "@/server/musicGateway";
import { abandonTidalConnection } from "@/server/tidalMusic";
import {
  requireSameOrigin,
  requireSpotifySession,
  spotifyJson,
} from "../../spotify/routeSupport";

export async function POST(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    return spotifyJson({ authorization_url: await startTidalConnection(session.sub) });
  } catch (error) {
    return musicGatewayError(error);
  }
}

/*
 * DELETE disconnects TIDAL. With `?pending=STATE` it only drops that
 * unfinished sign-in: the one the callback could not end itself because
 * Center's own sign-in had lapsed. A linked account and a newer sign-in stay.
 */
export async function DELETE(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const pending = new URL(request.url).searchParams.get("pending");
  try {
    if (pending !== null) {
      await abandonTidalConnection(session.sub, pending.slice(0, 128));
      return spotifyJson({ ok: true });
    }
    await disconnectTidal(session.sub);
    return spotifyJson({ ok: true });
  } catch (error) {
    return musicGatewayError(error);
  }
}
