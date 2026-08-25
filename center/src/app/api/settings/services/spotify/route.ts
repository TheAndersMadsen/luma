import {
  parseSpotifySettingsDto,
  runSpotifyBridgeAction,
  SpotifyBridgeError,
} from "@/server/spotifyBridge";
import { musicProviderStatus } from "@/server/musicGateway";
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
  const providers = await musicProviderStatus(session.sub).catch(() => undefined);
  try {
    return spotifyJson({
      ...(await runSpotifyBridgeAction(session, "status")),
      ...(providers ? { providers } : {}),
    });
  } catch (error) {
    return spotifyError(error, true, providers);
  }
}

export async function PATCH(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    const settings = parseSpotifySettingsDto(await boundedJsonBody(request));
    if (settings.active_provider !== "spotify") {
      const providers = await musicProviderStatus(session.sub);
      const selected = providers[settings.active_provider];
      if (settings.active_provider === "apple_music") {
        throw new SpotifyBridgeError(
          "invalid_response",
          409,
          "Apple Music can be connected in Center, but native Pin playback is not available yet.",
        );
      }
      if (selected.state !== "connected") {
        throw new SpotifyBridgeError(
          "invalid_response",
          409,
          "Connect that music provider in Center before selecting it.",
        );
      }
    }
    return spotifyJson({
      ...(await runSpotifyBridgeAction(session, "settings", settings)),
      providers: await musicProviderStatus(session.sub),
    });
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
    return spotifyJson({
      ...(await runSpotifyBridgeAction(session, "disconnect")),
      providers: await musicProviderStatus(session.sub),
    });
  } catch (error) {
    return spotifyError(error);
  }
}
