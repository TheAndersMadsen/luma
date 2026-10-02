import type { MusicTrack } from "@/lib/contracts/music";
import { timingSafeEqual } from "node:crypto";
import * as z from "zod/mini";
import { youtubeCredentialsSchema } from "./musicCredentials";
import { FormatUtils, Innertube, YTNodes } from "youtubei.js";
import { MusicAccountError, readMusicAccountRecord, updateMusicAccountRecord } from "./musicAccounts";
import type { YoutubeOAuthCredentials } from "./musicCredentials";
import { deviceMusicProviderFetch } from "./spotifyBridge";
import { configureYoutubePlayerEvaluator } from "./youtubePlayerEvaluator";
import { youtubeContentProofToken } from "./youtubePoToken";

export type YoutubeDeviceCode = {
  user_code: string;
  verification_url: string;
  expires_at: number;
};

type YoutubeClient = Awaited<ReturnType<typeof Innertube.create>>;
type PendingYoutubeLogin = {
  client: YoutubeClient;
  epoch: number;
  code?: YoutubeDeviceCode;
  failed?: boolean;
  controller: AbortController;
};

const pendingLogins = new Map<string, PendingYoutubeLogin>();
const startingLogins = new Map<string, Promise<YoutubeDeviceCode>>();
const authenticatedClients = new Map<string, Promise<YoutubeClient>>();
const catalogClients = new Map<string, Promise<YoutubeClient>>();
const sessionEpochs = new Map<string, number>();
const STOCK_MIN_TRACK_DURATION_MS = 1_000;
const STOCK_MAX_TRACK_DURATION_MS = 30 * 60 * 1_000;
const STOCK_MAX_ARTISTS_PER_TRACK = 16;
const AD_RESPONSE_FIELDS = new Set([
  "playerAds", "adPlacements", "adSlots", "adBreakHeartbeatParams",
]);
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

/**
 * Luma-owned filtering (INFERRED), not a recovered stock behavior. Apply Pear
 * Desktop's player-field removal recursively, including the newer heartbeat
 * scheduling field described in https://github.com/pear-devs/pear-desktop/pull/4690.
 * That proposal is upstream evidence of the field, not live Luma playback proof.
 */
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

function waitForSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function composedFetchSignal(
  input: string | URL | Request,
  init: RequestInit | undefined,
  operationSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals = [operationSignal, init?.signal, input instanceof Request ? input.signal : undefined]
    .filter((signal): signal is AbortSignal => signal !== undefined && signal !== null)
    .filter((signal, index, all) => all.indexOf(signal) === index);
  if (!signals.length) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

async function readYoutubeResponseBytes(
  response: Response,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  signal?.throwIfAborted();
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PRUNABLE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new YoutubeMusicError("YouTube Music returned an oversized response.", 502);
      }
      chunks.push(value);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function adBlockingYoutubeFetchUsing(
  fetchImpl: typeof fetch,
  operationSignal?: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    if (!isAllowedYoutubeRequestUrl(url)) {
      throw new YoutubeMusicError("YouTube Music blocked an advertising or unexpected request.", 502);
    }
    const signal = composedFetchSignal(input, init, operationSignal);
    signal?.throwIfAborted();
    const response = await fetchImpl(input, { ...init, redirect: "error", signal });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (!contentType.includes("json")) {
      // InnerTube endpoints carry JSON, including the player response. Do not
      // let an incorrect media type pass scheduling fields straight to the SDK.
      if (url.pathname.startsWith("/youtubei/")) {
        await response.body?.cancel().catch(() => undefined);
        throw new YoutubeMusicError("YouTube Music returned an invalid response.", 502);
      }
      return response;
    }
    if (Number.isFinite(declared) && declared > MAX_PRUNABLE_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new YoutubeMusicError("YouTube Music returned an oversized response.", 502);
    }

    const bytes = await readYoutubeResponseBytes(response, signal);
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

/**
 * The shared anonymous catalog client outlives any one lookup, so it cannot
 * carry a lookup's signal. Each of its requests gets its own bound instead of
 * the HTTP client's five-minute default.
 */
const YOUTUBE_CATALOG_REQUEST_TIMEOUT_MS = 15_000;
const catalogYoutubeFetch: typeof fetch = (input, init) => {
  const bound = AbortSignal.timeout(YOUTUBE_CATALOG_REQUEST_TIMEOUT_MS);
  return adBlockingYoutubeFetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, bound]) : bound,
  });
};
const deviceAdBlockingYoutubeFetch = adBlockingYoutubeFetchUsing(deviceMusicProviderFetch);

/**
 * The grant youtubei.js signs in with, and nothing else Google's token response
 * carried: Cosmos keeps exactly these fields.
 */
function normalizeCredentials(value: unknown): YoutubeOAuthCredentials {
  const parsed = youtubeCredentialsSchema.safeParse(value);
  if (!parsed.success)
    throw new YoutubeMusicError("YouTube Music returned invalid credentials.");
  return parsed.data;
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
        const pending = pendingLogins.get(subject);
        if (pending?.client === client && pending.epoch === epoch) pendingLogins.delete(subject);
        authenticatedClients.set(subject, Promise.resolve(client));
      },
      () => {
        const pending = pendingLogins.get(subject);
        if (pending?.client === client && pending.epoch === epoch) pending.failed = true;
      },
    );
  });
  client.session.on("update-credentials", ({ credentials }) => {
    void saveCredentials(subject, epoch, credentials).catch(() => undefined);
  });
  client.session.on("auth-error", () => {
    const pending = pendingLogins.get(subject);
    if (pending?.client === client && pending.epoch === epoch) pending.failed = true;
  });
}

/**
 * INFERRED: the SDK's device-code poller uses an uncaught async interval and
 * cannot cancel pending authorization. Own that poll with one cancellable loop;
 * keep the SDK's public device-code request and session authentication events.
 */
function configureYoutubeAuthorizationPolling(client: YoutubeClient, signal: AbortSignal): void {
  client.session.oauth.pollForAccessToken = (details) => {
    const poll = async () => {
      const oauth = client.session.oauth;
      const identity = oauth.client_id;
      if (!identity || !Number.isFinite(details.expires_in) || details.expires_in <= 0 ||
          details.expires_in > 3_600 || !Number.isFinite(details.interval) || details.interval < 1 ||
          details.interval > 60 || typeof details.device_code !== "string" || !details.device_code ||
          details.device_code.length > 4_096) {
        throw new YoutubeMusicError("YouTube Music returned an invalid sign-in code.");
      }
      const budget = AbortSignal.any([signal, AbortSignal.timeout(details.expires_in * 1_000)]);
      let interval = details.interval * 1_000;
      for (;;) {
        budget.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(budget.reason); };
          const timer = setTimeout(() => {
            budget.removeEventListener("abort", onAbort);
            resolve();
          }, interval);
          budget.addEventListener("abort", onAbort, { once: true });
        });
        const response = await client.session.http.fetch_function(oauth.AUTH_SERVER_TOKEN_URL, {
          method: "POST", headers: { "content-type": "application/json" }, signal: budget,
          body: JSON.stringify({ ...identity, code: details.device_code,
            grant_type: "http://oauth.net/grant_type/device/1.0" }),
        });
        const raw: unknown = await response.json();
        budget.throwIfAborted();
        if (raw && typeof raw === "object" && "error" in raw) {
          if (raw.error === "authorization_pending") continue;
          if (raw.error === "slow_down") { interval += 5_000; continue; }
          throw new YoutubeMusicError("YouTube Music rejected sign-in.");
        }
        if (!response.ok) throw new YoutubeMusicError("YouTube Music rejected sign-in.");
        const grant = z.looseObject({
          expires_in: z.int().check(z.positive(), z.maximum(86_400)),
        }).safeParse(raw);
        if (!grant.success) throw new YoutubeMusicError("YouTube Music returned invalid credentials.");
        const credentials = normalizeCredentials({ ...grant.data,
          expiry_date: new Date(Date.now() + grant.data.expires_in * 1_000).toISOString(),
        });
        oauth.setTokens(credentials);
        client.session.emit("auth", { credentials });
        return;
      }
    };
    void poll().catch(() => client.session.emit("auth-error", new YoutubeMusicError(
      "YouTube Music sign-in ended. Try connecting again.",
    )));
  };
}

async function createClient(subject: string, epoch: number, signal?: AbortSignal): Promise<YoutubeClient> {
  // Device-code bootstrap belongs to this cancellable login, unlike the
  // shared public catalog. Retain any SDK request signal as well as its bound.
  const loginFetch: typeof fetch = signal
    ? (input, init) => catalogYoutubeFetch(input, {
        ...init, signal: composedFetchSignal(input, init, signal),
      })
    : catalogYoutubeFetch;
  const client = await Innertube.create({
    fetch: loginFetch,
    retrieve_player: false,
    generate_session_locally: true,
    enable_session_cache: false,
  });
  attachCredentialPersistence(subject, epoch, client);
  if (signal) configureYoutubeAuthorizationPolling(client, signal);
  return client;
}

/**
 * `linked` is whether Cosmos holds the wearer's YouTube Music account, or null
 * when Cosmos could not say. A sign-in in progress lives only here.
 */
export function youtubeConnectionStatus(subject: string, linked: boolean | null): {
  state: "not_connected" | "pairing" | "connected" | "error";
  device_code?: YoutubeDeviceCode;
} {
  if (linked) {
    // A completed account connection is authoritative. A later failed or
    // abandoned retry must never make that account look signed out.
    pendingLogins.delete(subject);
    return { state: "connected" };
  }

  const pending = pendingLogins.get(subject);
  if (pending?.failed) return { state: "error" };
  if (pending?.code && pending.code.expires_at > Date.now()) {
    return { state: "pairing", device_code: pending.code };
  }
  if (pending?.code) pendingLogins.delete(subject);
  return { state: linked === null ? "error" : "not_connected" };
}

// INFERRED: repeated clicks share the same provider flow until its code arrives.
export async function startYoutubeConnection(subject: string): Promise<YoutubeDeviceCode> {
  const existing = startingLogins.get(subject);
  if (existing) return existing;
  const starting = beginYoutubeConnection(subject);
  startingLogins.set(subject, starting);
  try {
    return await starting;
  } finally {
    if (startingLogins.get(subject) === starting) startingLogins.delete(subject);
  }
}

async function beginYoutubeConnection(subject: string): Promise<YoutubeDeviceCode> {
  const pairing = pendingLogins.get(subject);
  if (pairing?.code && !pairing.failed && pairing.code.expires_at > Date.now()) return pairing.code;

  pendingLogins.get(subject)?.controller.abort();
  const controller = new AbortController();
  const epoch = sessionEpoch(subject);
  const client = await createClient(subject, epoch, controller.signal).catch(() => {
    throw new YoutubeMusicError("YouTube Music could not start sign-in.");
  });
  if (sessionEpoch(subject) !== epoch) {
    void client.session.signOut().catch(() => undefined);
    throw new YoutubeMusicError("YouTube Music was disconnected.", 401);
  }
  const pending: PendingYoutubeLogin = { client, epoch, controller };
  pendingLogins.set(subject, pending);

  const code = new Promise<YoutubeDeviceCode>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new YoutubeMusicError("YouTube Music was disconnected.", 401));
    };
    const timeout = setTimeout(() => {
      controller.signal.removeEventListener("abort", onAbort);
      pending.failed = true;
      controller.abort();
      reject(new YoutubeMusicError("YouTube Music did not return a sign-in code."));
    }, 15_000);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    client.session.once("auth-pending", (details) => {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (controller.signal.aborted || sessionEpoch(subject) !== epoch) {
        reject(new YoutubeMusicError("YouTube Music was disconnected.", 401));
        return;
      }
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
      controller.signal.removeEventListener("abort", onAbort);
      pending.failed = true;
      reject(new YoutubeMusicError("YouTube Music rejected sign-in."));
    });
    // youtubei.js rejects bootstrap/device-code errors without auth-error.
    void client.session.signIn().catch(() => {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      pending.failed = true;
      reject(new YoutubeMusicError("YouTube Music could not start sign-in."));
    });
  });
  return code;
}

export async function disconnectYoutube(subject: string): Promise<void> {
  const active = authenticatedClients.get(subject);
  const pending = pendingLogins.get(subject);
  invalidateSession(subject);
  startingLogins.delete(subject);
  pendingLogins.delete(subject);
  authenticatedClients.delete(subject);
  catalogClients.delete(subject);
  if (active) {
    void active.then((client) => client.session.signOut()).catch(() => undefined);
  }
  if (pending) {
    pending.controller.abort();
    void pending.client.session.signOut().catch(() => undefined);
  }
  await updateMusicAccountRecord(subject, (record) => {
    const { youtube_music: _youtube, ...rest } = record;
    return rest;
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
    if (error instanceof YoutubeMusicError || error instanceof MusicAccountError) throw error;
    throw new YoutubeMusicError("YouTube Music could not be reached.");
  }
}

async function connectedYoutubeCatalogClient(subject: string, signal?: AbortSignal): Promise<YoutubeClient> {
  try {
    const record = await readMusicAccountRecord(subject, signal);
    signal?.throwIfAborted();
    if (!record.youtube_music?.credentials) {
      throw new YoutubeMusicError("Connect YouTube Music in Center.", 401);
    }
    const existing = catalogClients.get(subject);
    if (existing) return await existing;
    // Google currently rejects OAuth bearer tokens on the WEB_REMIX catalog
    // endpoints used by youtubei.js. The catalog itself is public, so keep the
    // saved connection as the account authority without attaching its token to
    // search and browse requests. Reuse this anonymous catalog session: creating
    // a fresh Innertube client performs its own bootstrap request, which was the
    // 4.5-second transient deadline seen between completed research and provider
    // verification. Account-only actions still use the signed-in client above.
    const loading = Innertube.create({
      fetch: catalogYoutubeFetch,
      retrieve_player: false,
      generate_session_locally: true,
      enable_session_cache: false,
    });
    catalogClients.set(subject, loading);
    try {
      return await loading;
    } catch (error) {
      if (catalogClients.get(subject) === loading) catalogClients.delete(subject);
      throw error;
    }
  } catch (error) {
    if (error instanceof YoutubeMusicError || error instanceof MusicAccountError) throw error;
    throw new YoutubeMusicError("YouTube Music catalog could not be reached.");
  }
}

async function requireYoutubeConnection(
  subject: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const record = await waitForSignal(readMusicAccountRecord(subject, signal), signal);
  if (!record.youtube_music?.credentials) {
    throw new YoutubeMusicError("Connect YouTube Music in Center.", 401);
  }
}

function prefixedId(videoId: string): string {
  return `youtube_music:${videoId}`;
}

export function isStockCompatibleYoutubeTrack(track: MusicTrack): boolean {
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

const youtubeTrackSchema = z.object({
  id: z.string().check(z.regex(/^[A-Za-z0-9_-]{11}$/u)),
  title: z.string(),
  artists: z.optional(z.array(z.object({ name: z.string() }))),
  album: z.nullish(z.object({ name: z.string() })),
  duration: z.optional(z.object({ seconds: z.number() })),
  badges: z.optional(z.array(z.unknown())),
});
const playlistRowSchema = z.looseObject({
  video_id: z.string(),
  title: z.object({ text: z.string() }),
});
const playlistItemSchema = z.object({ primary: playlistRowSchema });

function responsiveTrack(value: unknown): MusicTrack | null {
  const parsed = youtubeTrackSchema.safeParse(value);
  if (!parsed.success) return null;
  const item = parsed.data;
  const track = {
    id: prefixedId(item.id),
    title: item.title.trim(),
    artists: (item.artists ?? [])
      .map((artist) => artist.name.trim())
      .filter(Boolean),
    album: item.album?.name.trim() ?? "",
    duration_ms: Math.round(item.duration?.seconds ?? 0) * 1_000,
    track_number: 0,
    disc_number: 0,
    explicit: item.badges?.some((badge) =>
      badge instanceof YTNodes.MusicInlineBadge &&
      (badge.icon_type === "MUSIC_EXPLICIT_BADGE" || badge.label === "Explicit"),
    ) ?? false,
  };
  return isStockCompatibleYoutubeTrack(track) ? track : null;
}

function playlistTrack(value: unknown): MusicTrack | null {
  const wrapped = playlistItemSchema.safeParse(value);
  const parsed = wrapped.success
    ? { success: true as const, data: wrapped.data.primary }
    : playlistRowSchema.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data;
  return responsiveTrack({ ...row, id: row.video_id, title: row.title.text });
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

function collectionTracks(
  items: Iterable<unknown> | undefined,
  limit: number,
): MusicTrack[] {
  return Array.from(items ?? [])
    .flatMap((item) => {
      return responsiveTrack(item) ?? playlistTrack(item) ?? [];
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
  // Stock TidalProvider.queryWithGenreName and queryFeaturedPlaylist return
  // collections (TidalGenreNameCollectionQuery.collection and
  // TidalFeaturedPlaylistCollectionQuery.collection), not literal title hits.
  // INFERRED YouTube mapping: browse a public relevance-selected playlist;
  // this makes no YouTube editorial selection or ranking claim.
  if (kind === "playlist" || kind === "genre" || kind === "featured") {
    return { searchType: "playlist", loader: "playlist" };
  }
  if (kind === "artist") return { searchType: "artist", loader: "artist_songs" };
  return null;
}

type YoutubeQuery = {
  kind: string;
  primary?: string;
  secondary?: string;
  ids?: string[];
  limit: number;
};

/**
 * One catalog lookup. youtubei.js takes no per-call signal and its clients are
 * shared across lookups, so `signal` ends the caller's wait. Each of the
 * lookup's own requests is bounded by the catalog client's request timeout.
 * Once a request completes, an aborted lookup never starts its next request.
 */
export async function queryYoutubeMusic(
  subject: string,
  request: YoutubeQuery,
  signal?: AbortSignal,
): Promise<MusicTrack[]> {
  signal?.throwIfAborted();
  return waitForSignal(runYoutubeQuery(subject, request, signal), signal);
}

async function runYoutubeQuery(
  subject: string,
  request: YoutubeQuery,
  signal?: AbortSignal,
): Promise<MusicTrack[]> {
  if (request.kind === "favorites") {
    await requireYoutubeConnection(subject, signal);
    // OAuth works only with TV, while music.getLibrary() sends WEB_REMIX.
    // Upstream: https://ytjs.dev/guide/authentication. No proven TV library
    // parser is available here. An empty list would falsely claim no favorites.
    throw new YoutubeMusicError(
      "YouTube Music favorites are unavailable with this sign-in. Search for a track, album, artist, or playlist instead.",
      501,
    );
  }
  const client = await connectedYoutubeCatalogClient(subject, signal);
  signal?.throwIfAborted();
  const limit = Math.max(1, Math.min(100, request.limit));

  if (
    (request.kind === "radio" || request.kind === "recommendations") &&
    request.primary
  ) {
    const upNext = await client.music.getUpNext(
      youtubeVideoId(request.primary),
    );
    return collectionTracks(upNext.contents, limit);
  }

  if (request.kind === "ids" && request.ids?.length) {
    const resolved: MusicTrack[] = [];
    for (const id of request.ids.slice(0, limit)) {
      signal?.throwIfAborted();
      const videoId = youtubeVideoId(id);
      const info = await client.music.getInfo(videoId);
      signal?.throwIfAborted();
      const basic = info.basic_info;
      const track = basic?.id === videoId
        ? responsiveTrack({
            id: basic.id,
            title: basic.title,
            artists: basic.author ? [{ name: basic.author }] : [],
            duration: { seconds: Number(basic.duration) },
          })
        : null;
      if (track) resolved.push(track);
    }
    return resolved;
  }

  if (request.kind === "album_id" && request.primary) {
    const albumId = request.primary.startsWith("youtube_music:")
      ? request.primary.slice("youtube_music:".length)
      : request.primary;
    if (
      !/^(?:MPR|FEmusic_library_privately_owned_release)[A-Za-z0-9_-]+$/u.test(
        albumId,
      )
    ) {
      throw new YoutubeMusicError("YouTube Music album id is invalid.", 400);
    }
    return collectionTracks(
      (await client.music.getAlbum(albumId)).contents,
      limit,
    );
  }

  const query =
    queryText(request) || (request.kind === "featured" ? "top hits" : "");
  if (!query) return [];

  const collection = youtubeCollectionPlan(request.kind);
  if (collection) {
    const result = await client.music.search(query, {
      type: collection.searchType,
    });
    signal?.throwIfAborted();
    const id = firstBrowseId(result[`${collection.searchType}s`]?.contents);
    if (!id) return [];
    if (collection.loader === "album") {
      return collectionTracks(
        (await client.music.getAlbum(id)).contents,
        limit,
      );
    }
    if (collection.loader === "playlist") {
      return collectionTracks(
        (await client.music.getPlaylist(id)).contents,
        limit,
      );
    }
    const artist = await client.music.getArtist(id);
    signal?.throwIfAborted();
    const songs = await artist.getAllSongs();
    return collectionTracks(songs?.contents, limit);
  }
  const result = await client.music.search(query, { type: "song" });
  return collectionTracks(result.songs?.contents, limit);
}

export async function youtubeMusicStreamUrl(
  subject: string,
  trackId: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    // Playback uses only public player requests through the Pin. The durable
    // encrypted connection is the account authority here. Starting the cached
    // OAuth client would introduce unrelated fetches that cannot safely retain
    // a request-scoped signal after this playback request completes.
    await requireYoutubeConnection(subject, signal);
    signal?.throwIfAborted();
    const videoId = youtubeVideoId(trackId);
    const siblingController = new AbortController();
    const playbackSignal = signal
      ? AbortSignal.any([signal, siblingController.signal])
      : siblingController.signal;
    try {
      const playbackFetch = adBlockingYoutubeFetchUsing(deviceMusicProviderFetch, playbackSignal);
      const [client, proofToken] = await Promise.all([
        waitForSignal(Innertube.create({
          fetch: playbackFetch,
          retrieve_player: true,
          generate_session_locally: true,
          enable_session_cache: false,
        }), playbackSignal),
        youtubeContentProofToken(videoId, deviceAdBlockingYoutubeFetch, playbackSignal),
      ]);
      return await resolveYoutubeAudioStream(client, videoId, proofToken, playbackSignal);
    } finally {
      siblingController.abort();
    }
  } catch (error) {
    if (error instanceof YoutubeMusicError || error instanceof MusicAccountError) throw error;
    throw new YoutubeMusicError("YouTube Music audio could not be resolved.");
  }
}

export async function resolveYoutubeAudioStream(
  client: YoutubeClient,
  videoId: string,
  proofToken: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  configureYoutubePlayerEvaluator();
  const info = await waitForSignal(client.getBasicInfo(videoId, {
    client: "YTMUSIC",
    po_token: proofToken,
  }), signal);
  // The player response is authoritative about identity and availability. A
  // response for another video or a provider refusal must never become audio.
  if (info.basic_info.id !== videoId || info.playability_status?.status !== "OK") {
    throw new YoutubeMusicError("YouTube Music did not return the requested playable track.");
  }
  if (!info.streaming_data) {
    throw new YoutubeMusicError("YouTube Music did not return a playable audio stream.");
  }
  // The SDK ranks bitrate before checking DRM. Filter first so an unusable
  // high-bitrate format cannot hide a playable audio-only representation.
  const formats = [
    ...(info.streaming_data.formats ?? []),
    ...(info.streaming_data.adaptive_formats ?? []),
  ].filter((format) => format.has_audio && !format.has_video && !format.has_text &&
    !(format.drm_families?.length) && !format.fair_play_key_uri && !format.drm_track_type);
  if (!formats.length) {
    throw new YoutubeMusicError("YouTube Music did not return a playable audio stream.");
  }
  const format = FormatUtils.chooseFormat({
    type: "audio",
    quality: "best",
    format: "any",
  }, { ...info.streaming_data, formats, adaptive_formats: [] });
  const url = await waitForSignal(format.decipher(client.session.player), signal);
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

export async function likeYoutubeTrack(
  subject: string,
  trackId: string,
  signal?: AbortSignal,
): Promise<void> {
  const videoId = youtubeVideoId(trackId);
  signal?.throwIfAborted();
  await waitForSignal(
    authenticatedYoutubeClient(subject).then((client) => client.interact.like(videoId)),
    signal,
  );
}

/** Constant-time helper shared by the gateway's fixed derived bearer. */
export function equalGatewayToken(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(presented, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
