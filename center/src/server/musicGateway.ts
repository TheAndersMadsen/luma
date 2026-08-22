import { randomBytes } from "node:crypto";

import { AppleMusicError, appleConnectionStatus } from "./appleMusic";
import { MusicSessionStoreError } from "./musicProviderStore";

import {
  deviceMusicGatewayToken,
  musicGatewayOrigin,
  SpotifyBridgeError,
  type MusicProvider,
} from "./spotifyBridge";
import {
  disconnectTidal,
  isAllowedTidalStream,
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
  isAllowedGoogleVideoStream,
  likeYoutubeTrack,
  queryYoutubeMusic,
  startYoutubeConnection,
  youtubeConnectionStatus,
  youtubeMusicStreamUrl,
  YoutubeMusicError,
} from "./youtubeMusic";

const STREAM_TTL_MS = 5 * 60_000;
const MAX_STREAM_TICKETS = 256;
const tickets = new Map<string, { url: string; provider: MusicProvider; expiresAt: number }>();

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

function pruneTickets(now = Date.now()): void {
  for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
  while (tickets.size >= MAX_STREAM_TICKETS) tickets.delete(tickets.keys().next().value!);
}

export async function gatewayPlayback(subject: string, providerValue: MusicProvider, id: string) {
  const provider = supportedProvider(providerValue);
  const upstream = provider === "youtube_music"
    ? await youtubeMusicStreamUrl(subject, id)
    : await tidalStreamUrl(subject, id);
  pruneTickets();
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { url: upstream, provider, expiresAt: Date.now() + STREAM_TTL_MS });
  return { url: `${musicGatewayOrigin()}/api/music-gateway/stream/${ticket}` };
}

export async function gatewaySave(subject: string, providerValue: MusicProvider, id: string) {
  const provider = supportedProvider(providerValue);
  if (provider === "youtube_music") await likeYoutubeTrack(subject, id);
  else await saveTidalTrack(subject, id);
  return { ok: true };
}

export function isAllowedMusicRange(value: string | null): boolean {
  return value === null || /^bytes=(?:\d+-\d*|-\d+)$/u.test(value);
}

export function isAllowedMusicStreamContentType(value: string | null): boolean {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    contentType.startsWith("audio/") ||
    contentType === "video/mp4" ||
    contentType === "application/octet-stream"
  );
}

export async function proxyMusicStream(ticket: string, request: Request): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return new Response(null, { status: 404 });
  pruneTickets();
  const entry = tickets.get(ticket);
  if (!entry) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const valid = entry.provider === "youtube_music" ? isAllowedGoogleVideoStream(entry.url) : isAllowedTidalStream(entry.url);
  if (!valid) {
    tickets.delete(ticket);
    return new Response(null, { status: 404 });
  }
  const range = request.headers.get("range");
  if (!isAllowedMusicRange(range)) {
    return new Response(null, { status: 416 });
  }
  const upstream = await fetch(entry.url, {
    method: request.method,
    headers: range ? { range } : undefined,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!upstream || !new Set([200, 206]).has(upstream.status)) {
    await upstream?.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 502 });
  }
  if (!isAllowedMusicStreamContentType(upstream.headers.get("content-type"))) {
    await upstream.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 502 });
  }
  const headers = new Headers({
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
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
