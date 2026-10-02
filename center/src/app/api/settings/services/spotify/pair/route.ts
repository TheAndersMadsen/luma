import { runSpotifyBridgeAction } from "@/server/spotifyBridge";
import {
  requireSameOrigin,
  requireSpotifySession,
  spotifyError,
  spotifyJson,
} from "../routeSupport";

export async function POST(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    return spotifyJson(await runSpotifyBridgeAction(session, "pair", undefined, undefined, request.signal));
  } catch (error) {
    return spotifyError(error);
  }
}
