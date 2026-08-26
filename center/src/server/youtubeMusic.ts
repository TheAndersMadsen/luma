import { timingSafeEqual } from "node:crypto";

import { Innertube } from "youtubei.js";

import {
  MusicSessionStoreError,
  readMusicAccountRecord,
  updateMusicAccountRecord,
  type YoutubeOAuthCredentials,
} from "./musicProviderStore";
import { deviceMusicProviderFetch } from "./spotifyBridge";
import { youtubeContentProofToken } from "./youtubePoToken";
import { configureYoutubePlayerEvaluator } from "./youtubePlayerEvaluator";

export type YoutubeDeviceCode = {
  user_code: string;
  verification_url: string;
  expires_at: number;
};

export type YoutubeTrack = {
  id: string;
  title: string;
  artists: string[];
  album: string;
  duration_ms: number;
  track_number: number;
  disc_number: number;
  explicit: boolean;
};

type YoutubeClient = Awaited<ReturnType<typeof Innertube.create>>;
type PendingYoutubeLogin = {
  client: YoutubeClient;
  epoch: number;
  code?: YoutubeDeviceCode;
  failed?: boolean;
};

const pendingLogins = new Map<string, PendingYoutubeLogin>();
const authenticatedClients = new Map<string, Promise<YoutubeClient>>();
const sessionEpochs = new Map<string, number>();
const STOCK_MIN_TRACK_DURATION_MS = 1_000;
const STOCK_MAX_TRACK_DURATION_MS = 30 * 60 * 1_000;
const STOCK_MAX_ARTISTS_PER_TRACK = 16;
const AD_RESPONSE_FIELDS = new Set(["playerAds", "adPlacements", "adSlots"]);
const MAX_PRUNABLE_RESPONSE_BYTES = 16 * 1024 * 1024;
const YOUTUBE_REQUEST_HOSTS = new Set([
  "www.youtube.com",
  "music.youtube.com",
  "youtube.com",
  "youtubei.googleapis.com",
  "jnn-pa.googleapis.com",
]);
const BLOCKED_AD_HOSTS = new Set([
  "ad.doubleclick.net",
  "googleads.g.doubleclick.net",
  "pagead2.googlesyndication.com",
  "tpc.googlesyndication.com",
  "adservice.google.com",
  "adservice.google.dk",
]);

export class YoutubeMusicError extends Error {
  readonly status: number;

  constructor(message: string, status = 503) {
    super(message);
    this.name = "YoutubeMusicError";
    this.status = status;
  }
}

function isSubdomain(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function isBlockedYoutubeAdHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    BLOCKED_AD_HOSTS.has(host) ||
    isSubdomain(host, "doubleclick.net") ||
    isSubdomain(host, "googlesyndication.com") ||
    isSubdomain(host, "googleadservices.com")
  );
}

export function isAllowedYoutubeRequestUrl(value: string | URL): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !isBlockedYoutubeAdHost(host) &&
    (YOUTUBE_REQUEST_HOSTS.has(host) || isSubdomain(host, "googlevideo.com"))
  );
}

/** Pear Desktop's player-field removal, applied recursively to InnerTube JSON. */
export function pruneYoutubeAdFields(value: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => pruneYoutubeAdFields(entry, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (AD_RESPONSE_FIELDS.has(key)) continue;
    output[key] = pruneYoutubeAdFields(entry, depth + 1);
  }
  return output;
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

export function adBlockingYoutubeFetchUsing(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    if (!isAllowedYoutubeRequestUrl(url)) {
      throw new YoutubeMusicError("YouTube Music blocked an advertising or unexpected request.", 502);
    }
    const response = await fetchImpl(input, { ...init, redirect: "error" });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (
      !contentType.includes("json") ||
      (Number.isFinite(declared) && declared > MAX_PRUNABLE_RESPONSE_BYTES)
    ) {
      return response;
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_PRUNABLE_RESPONSE_BYTES) {
      throw new YoutubeMusicError("YouTube Music returned an oversized response.", 502);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new YoutubeMusicError("YouTube Music returned an invalid response.", 502);
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(pruneYoutubeAdFields(decoded)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

export const adBlockingYoutubeFetch = adBlockingYoutubeFetchUsing(fetch);
const deviceAdBlockingYoutubeFetch = adBlockingYoutubeFetchUsing(deviceMusicProviderFetch);

function normalizeCredentials(value: unknown): YoutubeOAuthCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new YoutubeMusicError("YouTube Music returned invalid credentials.");
  }
  const raw = value as Record<string, unknown>;
  const required = ["access_token", "expiry_date", "refresh_token"] as const;
  for (const field of required) {
    if (typeof raw[field] !== "string" || !raw[field]) {
      throw new YoutubeMusicError("YouTube Music returned invalid credentials.");
    }
  }
  return value as YoutubeOAuthCredentials;
}

function sessionEpoch(subject: string): number {
  return sessionEpochs.get(subject) ?? 0;
}

function invalidateSession(subject: string): void {
  sessionEpochs.set(subject, sessionEpoch(subject) + 1);
}

async function saveCredentials(subject: string, epoch: number, value: unknown): Promise<void> {
  const credentials = normalizeCredentials(value);
  await updateMusicAccountRecord(subject, (record) => {
    if (sessionEpoch(subject) !== epoch) {
      throw new YoutubeMusicError("YouTube Music was disconnected.", 401);
    }
    return {
      ...record,
      youtube_music: {
        credentials,
        connected_at: new Date().toISOString(),
      },
    };
  });
}

function attachCredentialPersistence(subject: string, epoch: number, client: YoutubeClient): void {
  client.session.on("auth", ({ credentials }) => {
    void saveCredentials(subject, epoch, credentials).then(
      () => {
        if (sessionEpoch(subject) !== epoch) {
          void client.session.signOut().catch(() => undefined);
          return;
        }
        pendingLogins.delete(subject);
        authenticatedClients.set(subject, Promise.resolve(client));
      },
      () => {
        const pending = pendingLogins.get(subject);
        if (pending) pending.failed = true;
      },
    );
  });
  client.session.on("update-credentials", ({ credentials }) => {
    void saveCredentials(subject, epoch, credentials).catch(() => undefined);
  });
  client.session.on("auth-error", () => {
    const pending = pendingLogins.get(subject);
    if (pending) pending.failed = true;
  });
}

async function createClient(subject: string, epoch: number): Promise<YoutubeClient> {
  const client = await Innertube.create({
    fetch: adBlockingYoutubeFetch,
    retrieve_player: true,
    generate_session_locally: true,
    enable_session_cache: false,
  });
  attachCredentialPersistence(subject, epoch, client);
  return client;
}

export async function youtubeConnectionStatus(subject: string): Promise<{
  state: "not_connected" | "pairing" | "connected" | "error";
  device_code?: YoutubeDeviceCode;
}> {
  let storeFailed = false;
  try {
    const record = await readMusicAccountRecord(subject);
    if (record.youtube_music?.credentials) {
      // A completed, encrypted account connection is authoritative. A later
      // failed or abandoned retry must never make that account look signed out.
      pendingLogins.delete(subject);
      return { state: "connected" };
    }
  } catch (error) {
    if (error instanceof MusicSessionStoreError) storeFailed = true;
    else throw error;
  }

  const pending = pendingLogins.get(subject);
  if (pending?.failed) return { state: "error" };
  if (pending?.code && pending.code.expires_at > Date.now()) {
    return { state: "pairing", device_code: pending.code };
  }
  if (pending?.code) pendingLogins.delete(subject);
  return { state: storeFailed ? "error" : "not_connected" };
}

export async function startYoutubeConnection(subject: string): Promise<YoutubeDeviceCode> {
  const current = await youtubeConnectionStatus(subject);
  if (current.state === "pairing" && current.device_code) return current.device_code;

  const epoch = sessionEpoch(subject);
  const client = await createClient(subject, epoch).catch(() => {
    throw new YoutubeMusicError("YouTube Music could not start sign-in.");
  });
  if (sessionEpoch(subject) !== epoch) {
    void client.session.signOut().catch(() => undefined);
    throw new YoutubeMusicError("YouTube Music was disconnected.", 401);
  }
  const pending: PendingYoutubeLogin = { client, epoch };
  pendingLogins.set(subject, pending);

  const code = new Promise<YoutubeDeviceCode>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new YoutubeMusicError("YouTube Music did not return a sign-in code.")),
      15_000,
    );
    client.session.once("auth-pending", (details) => {
      clearTimeout(timeout);
      const next: YoutubeDeviceCode = {
        user_code: details.user_code,
        verification_url: details.verification_url,
        expires_at: Date.now() + details.expires_in * 1_000,
      };
      pending.code = next;
      resolve(next);
    });
    client.session.once("auth-error", () => {
      clearTimeout(timeout);
      pending.failed = true;
      reject(new YoutubeMusicError("YouTube Music rejected sign-in."));
    });
  });
  void client.session.signIn().catch(() => {
    pending.failed = true;
  });
  return code;
}

export async function disconnectYoutube(subject: string): Promise<void> {
  const active = authenticatedClients.get(subject);
  const pending = pendingLogins.get(subject);
  invalidateSession(subject);
  pendingLogins.delete(subject);
  authenticatedClients.delete(subject);
  if (active) {
    void active.then((client) => client.session.signOut()).catch(() => undefined);
  }
  if (pending) void pending.client.session.signOut().catch(() => undefined);
  await updateMusicAccountRecord(subject, (record) => {
    const { youtube_music: _youtube, ...rest } = record;
    return { ...rest, version: 1 };
  });
}

async function authenticatedYoutubeClient(subject: string): Promise<YoutubeClient> {
  const existing = authenticatedClients.get(subject);
  if (existing) {
    const epoch = sessionEpoch(subject);
    const client = await existing;
    if (sessionEpoch(subject) !== epoch) {
      void client.session.signOut().catch(() => undefined);
      throw new YoutubeMusicError("YouTube Music was disconnected.", 401);
    }
    return client;
  }
  const epoch = sessionEpoch(subject);
  const loading = (async () => {
    const record = await readMusicAccountRecord(subject);
    const credentials = record.youtube_music?.credentials;
    if (!credentials) throw new YoutubeMusicError("Connect YouTube Music in Center.", 401);
    const client = await createClient(subject, epoch);
    await client.session.signIn(credentials);
    if (sessionEpoch(subject) !== epoch) {
      void client.session.signOut().catch(() => undefined);
      throw new YoutubeMusicError("YouTube Music was disconnected.", 401);
    }
    if (!client.session.logged_in) {
      throw new YoutubeMusicError("Reconnect YouTube Music in Center.", 401);
    }
    return client;
  })();
  authenticatedClients.set(subject, loading);
  try {
    return await loading;
  } catch (error) {
    if (authenticatedClients.get(subject) === loading) authenticatedClients.delete(subject);
    if (error instanceof YoutubeMusicError || error instanceof MusicSessionStoreError) throw error;
    throw new YoutubeMusicError("YouTube Music could not be reached.");
  }
}

async function connectedYoutubeCatalogClient(subject: string): Promise<YoutubeClient> {
  try {
    const record = await readMusicAccountRecord(subject);
    if (!record.youtube_music?.credentials) {
      throw new YoutubeMusicError("Connect YouTube Music in Center.", 401);
    }
    // Google currently rejects OAuth bearer tokens on the WEB_REMIX catalog
    // endpoints used by youtubei.js. The catalog itself is public, so keep the
    // saved connection as the account authority without attaching its token to
    // search and browse requests. Account-only actions still use the signed-in
    // client above.
    return await Innertube.create({
      fetch: adBlockingYoutubeFetch,
      retrieve_player: false,
      generate_session_locally: true,
      enable_session_cache: false,
    });
  } catch (error) {
    if (error instanceof YoutubeMusicError || error instanceof MusicSessionStoreError) throw error;
    throw new YoutubeMusicError("YouTube Music catalog could not be reached.");
  }
}

function prefixedId(videoId: string): string {
  return `youtube_music:${videoId}`;
}

export function isStockCompatibleYoutubeTrack(track: YoutubeTrack): boolean {
  return (
    track.title.trim().length > 0 &&
    track.artists.length >= 1 &&
    track.artists.length <= STOCK_MAX_ARTISTS_PER_TRACK &&
    track.artists.every((artist) => artist.trim().length > 0) &&
    Number.isSafeInteger(track.duration_ms) &&
    track.duration_ms >= STOCK_MIN_TRACK_DURATION_MS &&
    track.duration_ms <= STOCK_MAX_TRACK_DURATION_MS
  );
}

export function youtubeVideoId(value: string): string {
  const id = value.startsWith("youtube_music:") ? value.slice("youtube_music:".length) : value;
  if (!/^[A-Za-z0-9_-]{11}$/u.test(id)) {
    throw new YoutubeMusicError("YouTube Music track id is invalid.", 400);
  }
  return id;
}

function responsiveTrack(item: Record<string, unknown>): YoutubeTrack | null {
  const id = typeof item.id === "string" ? item.id : "";
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (!/^[A-Za-z0-9_-]{11}$/u.test(id) || !title) return null;
  const artists = Array.isArray(item.artists)
    ? item.artists.flatMap((artist) => {
        const name =
          artist && typeof artist === "object" && typeof (artist as { name?: unknown }).name === "string"
            ? (artist as { name: string }).name.trim()
            : "";
        return name ? [name] : [];
      })
    : [];
  const albumValue = item.album;
  const album =
    albumValue && typeof albumValue === "object" && typeof (albumValue as { name?: unknown }).name === "string"
      ? (albumValue as { name: string }).name.trim()
      : "";
  const duration = item.duration;
  const seconds =
    duration && typeof duration === "object" && typeof (duration as { seconds?: unknown }).seconds === "number"
      ? Math.round((duration as { seconds: number }).seconds)
      : 0;
  const track = {
    id: prefixedId(id),
    title,
    artists,
    album,
    duration_ms: seconds * 1_000,
    track_number: 0,
    disc_number: 0,
    explicit: Array.isArray(item.badges) && item.badges.some((badge) => String(badge).includes("Explicit")),
  };
  return isStockCompatibleYoutubeTrack(track) ? track : null;
}

function playlistTrack(item: Record<string, unknown>): YoutubeTrack | null {
  const primary = item.primary && typeof item.primary === "object" ? item.primary : item;
  const row = primary as Record<string, unknown>;
  const id = typeof row.video_id === "string" ? row.video_id : "";
  const titleValue = row.title;
  const title =
    titleValue && typeof titleValue === "object" && typeof (titleValue as { text?: unknown }).text === "string"
      ? (titleValue as { text: string }).text.trim()
      : "";
  if (!/^[A-Za-z0-9_-]{11}$/u.test(id) || !title) return null;
  return responsiveTrack({ ...row, id, title });
}

function queryText(request: {
  kind: string;
  primary?: string;
  secondary?: string;
}): string {
  return [request.primary, request.secondary]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim();
}

function collectionTracks(items: Iterable<unknown> | undefined, limit: number): YoutubeTrack[] {
  return Array.from(items ?? [])
    .flatMap((item) => {
      const record = item as Record<string, unknown>;
      return responsiveTrack(record) ?? playlistTrack(record) ?? [];
    })
    .slice(0, limit);
}

function firstBrowseId(items: Iterable<unknown> | undefined): string | null {
  for (const item of items ?? []) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(id)) return id;
  }
  return null;
}

export function youtubeCollectionPlan(kind: string): {
  searchType: "album" | "playlist" | "artist";
  loader: "album" | "playlist" | "artist_songs";
} | null {
  if (kind === "album" || kind === "album_artist") {
    return { searchType: "album", loader: "album" };
  }
  if (kind === "playlist") return { searchType: "playlist", loader: "playlist" };
  if (kind === "artist") return { searchType: "artist", loader: "artist_songs" };
  return null;
}

export async function queryYoutubeMusic(
  subject: string,
  request: {
    kind: string;
    primary?: string;
    secondary?: string;
    ids?: string[];
    limit: number;
  },
): Promise<YoutubeTrack[]> {
  const client = request.kind === "favorites"
    ? await authenticatedYoutubeClient(subject)
    : await connectedYoutubeCatalogClient(subject);
  const limit = Math.max(1, Math.min(100, request.limit));

  if ((request.kind === "radio" || request.kind === "recommendations") && request.primary) {
    const upNext = await client.music.getUpNext(youtubeVideoId(request.primary));
    return collectionTracks(upNext.contents, limit);
  }

  if (request.kind === "ids" && request.ids?.length) {
    const resolved: YoutubeTrack[] = [];
    for (const id of request.ids.slice(0, limit)) {
      const info = await client.music.getInfo(youtubeVideoId(id));
      const basic = (info as unknown as { basic_info?: Record<string, unknown> }).basic_info;
      const track = basic
        ? responsiveTrack({
            id: basic.id,
            title: basic.title,
            artists: basic.author ? [{ name: basic.author }] : [],
            duration: { seconds: Number(basic.duration ?? 1) },
          })
        : null;
      if (track) resolved.push(track);
    }
    return resolved;
  }

  if (request.kind === "favorites") {
    const library = await client.music.getLibrary();
    const songs = library.filters.includes("Songs") ? await library.applyFilter("Songs") : library;
    return Array.from(songs.contents ?? [])
      .flatMap((section) => {
        const contents = (section as unknown as { contents?: unknown[] }).contents;
        return Array.isArray(contents)
          ? contents.flatMap((item) => responsiveTrack(item as Record<string, unknown>) ?? [])
          : [];
      })
      .slice(0, limit);
  }

  if (request.kind === "album_id" && request.primary) {
    const albumId = request.primary.startsWith("youtube_music:")
      ? request.primary.slice("youtube_music:".length)
      : request.primary;
    if (!/^(?:MPR|FEmusic_library_privately_owned_release)[A-Za-z0-9_-]+$/u.test(albumId)) {
      throw new YoutubeMusicError("YouTube Music album id is invalid.", 400);
    }
    return collectionTracks((await client.music.getAlbum(albumId)).contents, limit);
  }

  const query = queryText(request) || (request.kind === "featured" ? "top hits" : "");
  if (!query) return [];

  const collection = youtubeCollectionPlan(request.kind);
  if (collection) {
    const result = await client.music.search(query, { type: collection.searchType });
    const id = firstBrowseId(result[`${collection.searchType}s`]?.contents);
    if (!id) return [];
    if (collection.loader === "album") {
      return collectionTracks((await client.music.getAlbum(id)).contents, limit);
    }
    if (collection.loader === "playlist") {
      return collectionTracks((await client.music.getPlaylist(id)).contents, limit);
    }
    const songs = await (await client.music.getArtist(id)).getAllSongs();
    return collectionTracks(songs?.contents, limit);
  }
  const result = await client.music.search(query, { type: "song" });
  return collectionTracks(result.songs?.contents, limit);
}

export async function youtubeMusicStreamUrl(subject: string, trackId: string): Promise<string> {
  try {
    await authenticatedYoutubeClient(subject);
    const videoId = youtubeVideoId(trackId);
    const [client, proofToken] = await Promise.all([
      Innertube.create({
        fetch: deviceAdBlockingYoutubeFetch,
        retrieve_player: true,
        generate_session_locally: true,
        enable_session_cache: false,
      }),
      youtubeContentProofToken(videoId, deviceAdBlockingYoutubeFetch),
    ]);
    return await resolveYoutubeAudioStream(client, videoId, proofToken);
  } catch (error) {
    if (error instanceof YoutubeMusicError || error instanceof MusicSessionStoreError) throw error;
    throw new YoutubeMusicError("YouTube Music audio could not be resolved.");
  }
}

export async function resolveYoutubeAudioStream(
  client: YoutubeClient,
  videoId: string,
  proofToken: string,
): Promise<string> {
  configureYoutubePlayerEvaluator();
  const info = await client.getBasicInfo(videoId, {
    client: "YTMUSIC",
    po_token: proofToken,
  });
  const format = info.chooseFormat({
    type: "audio",
    quality: "best",
    format: "any",
  });
  if (
    !format.has_audio ||
    format.has_video ||
    format.has_text ||
    (format.drm_families?.length ?? 0) > 0 ||
    format.fair_play_key_uri ||
    format.drm_track_type
  ) {
    throw new YoutubeMusicError("YouTube Music did not return an ad-free audio stream.");
  }
  const url = await format.decipher(client.session.player);
  if (!isAllowedGoogleVideoStream(url)) {
    throw new YoutubeMusicError("YouTube Music returned an unexpected stream origin.");
  }
  const stream = new URL(url);
  stream.searchParams.set("pot", proofToken);
  return stream.toString();
}

export function isAllowedGoogleVideoStream(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      isSubdomain(host, "googlevideo.com")
    );
  } catch {
    return false;
  }
}

export async function likeYoutubeTrack(subject: string, trackId: string): Promise<void> {
  const client = await authenticatedYoutubeClient(subject);
  await client.interact.like(youtubeVideoId(trackId));
}

/** Constant-time helper shared by the gateway's fixed derived bearer. */
export function equalGatewayToken(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(presented, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
