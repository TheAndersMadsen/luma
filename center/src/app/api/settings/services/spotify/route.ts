import {
  parseSpotifySettingsDto,
  runSpotifyBridgeAction,
} from "@/server/spotifyBridge";
import {
  boundedJsonBody,
  requireSameOrigin,
  requireSpotifySession,
  spotifyError,
  spotifyJson,
} from "./routeSupport";

export async function GET() {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  try {
    return spotifyJson(await runSpotifyBridgeAction(session, "status"));
  } catch (error) {
    return spotifyError(error, true);
  }
}

export async function PATCH(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    const settings = parseSpotifySettingsDto(await boundedJsonBody(request));
    return spotifyJson(await runSpotifyBridgeAction(session, "settings", settings));
  } catch (error) {
    return spotifyError(error);
  }
}

export async function DELETE(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    return spotifyJson(await runSpotifyBridgeAction(session, "disconnect"));
  } catch (error) {
    return spotifyError(error);
  }
}
