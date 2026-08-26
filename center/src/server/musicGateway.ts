import { AppleMusicError, appleConnectionStatus } from "./appleMusic";
import { MusicSessionStoreError } from "./musicProviderStore";

import {
  deviceMusicGatewayToken,
  SpotifyBridgeError,
  type MusicProvider,
} from "./spotifyBridge";
import {
  disconnectTidal,
  queryTidal,
  saveTidalTrack,
  startTidalConnection,
  TidalMusicError,
  tidalConnectionStatus,
  tidalStreamUrl,
} from "./tidalMusic";
import {
  disconnectYoutube,
  equalGatewayToken,
  likeYoutubeTrack,
  queryYoutubeMusic,
  startYoutubeConnection,
  youtubeConnectionStatus,
  youtubeMusicStreamUrl,
  YoutubeMusicError,
} from "./youtubeMusic";

export class MusicGatewayError extends Error {
  readonly status: number;

  constructor(message: string, status = 503) {
    super(message);
    this.name = "MusicGatewayError";
    this.status = status;
  }
}

function ownerSubject(): string {
  const owner = process.env.REVIVAL_PIN_BRIDGE_OWNER_SUB?.trim() ?? "";
  if (!owner || owner.length > 512 || /\p{Cc}/u.test(owner)) throw new MusicGatewayError("Music gateway is not configured.");
  return owner;
}

export async function authenticateMusicGateway(request: Request): Promise<string> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([!-~]{32,512})$/u.exec(authorization);
  const expected = await deviceMusicGatewayToken();
  if (!match || !equalGatewayToken(expected, match[1])) throw new MusicGatewayError("Unauthorized.", 401);
  return ownerSubject();
}

export async function musicProviderStatus(subject: string) {
  const [youtube, tidal] = await Promise.all([
    youtubeConnectionStatus(subject),
    tidalConnectionStatus(subject),
  ]);
  const apple = await appleConnectionStatus(subject);
  return {
    youtube_music: { configured: true, ...youtube, ad_filtering: "pear_newpipe" as const },
    tidal,
    apple_music: apple,
  };
}

export { disconnectTidal, disconnectYoutube, startTidalConnection, startYoutubeConnection };

type QueryRequest = { provider: MusicProvider; kind: string; primary?: string; secondary?: string; ids?: string[]; limit: number };

function supportedProvider(provider: unknown): MusicProvider {
  if (!new Set(["youtube_music", "tidal"]).has(String(provider))) {
    throw new MusicGatewayError("That provider is not ready for native playback.", 409);
  }
  return provider as MusicProvider;
}

export async function gatewayQuery(subject: string, request: QueryRequest) {
  const provider = supportedProvider(request.provider);
  const items = provider === "youtube_music"
    ? await queryYoutubeMusic(subject, request)
    : await queryTidal(subject, request);
  return {
    items,
    collection_name: request.primary,
    is_user_playlist: request.kind === "favorites",
    ranking_provenance: "not_ranked",
  };
}

export async function gatewayPlayback(subject: string, providerValue: MusicProvider, id: string) {
  const provider = supportedProvider(providerValue);
  const upstream = provider === "youtube_music"
    ? await youtubeMusicStreamUrl(subject, id)
    : await tidalStreamUrl(subject, id);
  return { url: upstream };
}

export async function gatewaySave(subject: string, providerValue: MusicProvider, id: string) {
  const provider = supportedProvider(providerValue);
  if (provider === "youtube_music") await likeYoutubeTrack(subject, id);
  else await saveTidalTrack(subject, id);
  return { ok: true };
}

export function musicGatewayError(error: unknown): Response {
  const typed =
    error instanceof MusicGatewayError ||
    error instanceof YoutubeMusicError ||
    error instanceof TidalMusicError ||
    error instanceof AppleMusicError ||
    error instanceof SpotifyBridgeError;
  const status = typed ? error.status : 503;
  const message = typed || error instanceof MusicSessionStoreError
    ? error.message
    : "Music provider could not be reached.";
  return Response.json({ error: message }, { status, headers: { "cache-control": "private, no-store" } });
}
