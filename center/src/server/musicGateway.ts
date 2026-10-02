import type { MusicAccountSummary } from "@/lib/contracts/music";
import { appleConnectionStatus, AppleMusicError } from "./appleMusic";
import { SessionExpiredError } from "./cosmos";
import { MusicAccountError, musicAccountSummary } from "./musicAccounts";
import { MUSIC_PROVIDERS, type MusicProvider, type MusicProviderStatus } from "@/lib/contracts/music";
import { deviceMusicGatewayIdentity, SpotifyBridgeError } from "./spotifyBridge";
import {
  disconnectTidal,
  queryTidal,
  saveTidalTrack,
  startTidalConnection,
  tidalConnectionStatus,
  TidalMusicError,
  tidalStreamUrl,
} from "./tidalMusic";
import {
  disconnectYoutube,
  equalGatewayToken,
  likeYoutubeTrack,
  queryYoutubeMusic,
  startYoutubeConnection,
  youtubeConnectionStatus,
  YoutubeMusicError,
  youtubeMusicStreamUrl,
} from "./youtubeMusic";

export class MusicGatewayError extends Error {
  readonly status: number;

  constructor(message: string, status = 503) {
    super(message);
    this.name = "MusicGatewayError";
    this.status = status;
  }
}

export async function authenticateMusicGateway(
  request: Request,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const authorization = request.headers.get("authorization") ?? "";
  const presented = /^Bearer ([!-~]{32,512})$/u.exec(authorization)?.[1];
  // A caller with no device bearer learns nothing about this server's Pin.
  if (presented === undefined) throw new MusicGatewayError("Unauthorized.", 401);
  const identity = await deviceMusicGatewayIdentity(signal, fetchImpl);
  if (!equalGatewayToken(identity.token, presented)) throw new MusicGatewayError("Unauthorized.", 401);
  return identity.ownerSub;
}

/**
 * Each provider's connection state for the settings page: what Cosmos says
 * is linked (`summary`, null when Cosmos could not say), what this operator
 * configured, and a YouTube sign-in in progress.
 */
export function musicProviderStatus(
  subject: string,
  summary: MusicAccountSummary | null,
): MusicProviderStatus {
  return {
    youtube_music: {
      configured: true,
      ...youtubeConnectionStatus(
        subject,
        summary ? summary.youtube_music.linked : null,
      ),
      ad_filtering: "pear_newpipe" as const,
    },
    tidal: tidalConnectionStatus(summary?.tidal ?? null),
    apple_music: appleConnectionStatus(summary?.apple_music ?? null),
  };
}

/**
 * The signed-in wearer's music accounts: the provider their Pin plays from and
 * each provider's state. `active_provider` is null only when Cosmos could not
 * answer. Every provider then reads `error`. An expired sign-in is thrown, so
 * the route can ask the wearer to sign in again.
 */
export async function musicAccountStatus(subject: string): Promise<{
  active_provider: MusicProvider | null;
  providers: MusicProviderStatus;
}> {
  const summary = await musicAccountSummary().catch((error: unknown) => {
    if (error instanceof SessionExpiredError) throw error;
    return null;
  });
  return {
    active_provider: summary?.active_provider ?? null,
    providers: musicProviderStatus(subject, summary),
  };
}

export {
  disconnectTidal,
  disconnectYoutube,
  startTidalConnection,
  startYoutubeConnection,
};

type QueryRequest = { provider: MusicProvider; kind: string; primary?: string; secondary?: string; ids?: string[]; limit: number };

function supportedProvider(provider: MusicProvider): "youtube_music" | "tidal" {
  if (provider !== "youtube_music" && provider !== "tidal") {
    throw new MusicGatewayError("That provider is not ready for native playback.", 409);
  }
  return provider;
}

/** `signal` is the caller's budget: the lookup stops when it ends. */
export async function gatewayQuery(subject: string, request: QueryRequest, signal?: AbortSignal) {
  const provider = supportedProvider(request.provider);
  const items = provider === "youtube_music"
    ? await queryYoutubeMusic(subject, request, signal)
    : await queryTidal(subject, request, signal);
  return {
    items,
    collection_name: request.primary,
    is_user_playlist: request.kind === "favorites",
    ranking_provenance: "not_ranked",
  };
}

export async function gatewayPlayback(
  subject: string,
  providerValue: MusicProvider,
  id: string,
  signal?: AbortSignal,
) {
  const provider = supportedProvider(providerValue);
  const upstream = provider === "youtube_music"
    ? await youtubeMusicStreamUrl(subject, id, signal)
    : await tidalStreamUrl(subject, id, signal);
  return { url: upstream };
}

export async function gatewaySave(
  subject: string,
  providerValue: MusicProvider,
  id: string,
  signal?: AbortSignal,
) {
  const provider = supportedProvider(providerValue);
  if (provider === "youtube_music") await likeYoutubeTrack(subject, id, signal);
  else await saveTidalTrack(subject, id, signal);
  return { ok: true };
}

/** What a provider lookup that ran out of its caller's budget answers. */
export function musicProviderTimeout(provider: MusicProvider): MusicGatewayError {
  return new MusicGatewayError(`${MUSIC_PROVIDERS[provider].label} took too long.`, 504);
}

export function musicGatewayError(error: unknown): Response {
  const typed =
    error instanceof MusicGatewayError ||
    error instanceof YoutubeMusicError ||
    error instanceof TidalMusicError ||
    error instanceof AppleMusicError ||
    error instanceof MusicAccountError ||
    error instanceof SpotifyBridgeError;
  const status = typed ? error.status : 503;
  const message = typed ? error.message : "Music provider could not be reached.";
  return Response.json({ error: message }, { status, headers: { "cache-control": "private, no-store" } });
}
