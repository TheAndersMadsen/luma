import { MUSIC_PROVIDERS, type MusicProviderStatus, type SpotifyStatus } from "@/lib/contracts/music";
import { MusicAccountError, saveActiveMusicProvider } from "@/server/musicAccounts";
import { musicAccountStatus, musicProviderStatus } from "@/server/musicGateway";
import { parseSpotifySettingsDto, runSpotifyBridgeAction, SpotifyBridgeError } from "@/server/spotifyBridge";
import {
  boundedJsonBody,
  requireSameOrigin,
  requireSpotifySession,
  spotifyError,
  spotifyJson,
} from "./routeSupport";

/*
 * The provider the Pin plays from is the account's choice, kept in Cosmos. The
 * Pin's music bridge holds the copy that drives playback, so a change goes to
 * the Pin first and is recorded in Cosmos once the Pin has taken it. The Pin's
 * copy is answered as `pin_active_provider` beside the account's choice: after
 * a reinstall, a reset or a new Pin the two differ, and the card offers Save to
 * send the choice again. A read never writes to the Pin.
 */

function withAccountProvider(
  pin: SpotifyStatus,
  activeProvider: SpotifyStatus["active_provider"],
  providers: MusicProviderStatus,
) {
  return {
    ...pin,
    pin_active_provider: pin.active_provider,
    active_provider: activeProvider,
    providers,
  };
}

export async function GET(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  let accounts: Awaited<ReturnType<typeof musicAccountStatus>>;
  try {
    accounts = await musicAccountStatus(session.sub);
  } catch (error) {
    return spotifyError(error);
  }
  if (!accounts.active_provider) return spotifyError(new MusicAccountError());
  try {
    return spotifyJson(
      withAccountProvider(
        await runSpotifyBridgeAction(session, "status", undefined, undefined, request.signal),
        accounts.active_provider,
        accounts.providers,
      ),
    );
  } catch (error) {
    return spotifyError(error, true, accounts.providers, accounts.active_provider);
  }
}

export async function PATCH(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  try {
    const settings = parseSpotifySettingsDto(await boundedJsonBody(request));
    const accounts = await musicAccountStatus(session.sub);
    if (!accounts.active_provider) throw new MusicAccountError();
    if (settings.active_provider !== "spotify") {
      const selected = accounts.providers[settings.active_provider];
      if (!MUSIC_PROVIDERS[settings.active_provider].pinPlayback) {
        throw new SpotifyBridgeError(
          "invalid_response",
          409,
          `${MUSIC_PROVIDERS[settings.active_provider].label} can be connected in Center, but native Pin playback is not available yet.`,
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
    const status = await runSpotifyBridgeAction(session, "settings", settings, undefined, request.signal);
    const summary = await saveActiveMusicProvider(settings.active_provider);
    return spotifyJson(
      withAccountProvider(
        status,
        summary.active_provider,
        musicProviderStatus(session.sub, summary),
      ),
    );
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
    const status = await runSpotifyBridgeAction(session, "disconnect", undefined, undefined, request.signal);
    const accounts = await musicAccountStatus(session.sub);
    if (!accounts.active_provider) throw new MusicAccountError();
    return spotifyJson(
      withAccountProvider(status, accounts.active_provider, accounts.providers),
    );
  } catch (error) {
    return spotifyError(error);
  }
}
