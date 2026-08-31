import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";

import type { Session } from "./auth";
import {
  activePinBridgeAssignment,
  PinBridgeError,
  requireOwnedPairedPin as requirePinBridgeAssignment,
  type PinBridgeAssignment,
} from "./pinBridge";

/*
 * Every request Center will make of the Pin's Spotify service.
 *
 * This is a security boundary, not a convenience table: the adapter behind it
 * forwards to the device, and anything absent here is something Center cannot
 * ask the Pin to do. `search` is the only entry that carries wearer input, and
 * it is safe to add for reasons that are specific rather than general:
 *
 *   - It is a GET against `/api/spotify/search`, whose device handler
 *     (pin/runtime/core/src/api/spotify.rs) reads `q` and `kind` and does
 *     nothing else — no playback, no settings write, no session change. The
 *     Pin's own name for it is `diagnostic_search`.
 *   - The two parameters are validated here AND rebuilt from validated values
 *     by the adapter, so no caller-controlled string reaches the device path.
 *   - `kind` is pinned to the one value the device implements. Widening it is
 *     an edit in two files, which is the point.
 *
 * What it is NOT is a passthrough. There is no generic "call this Spotify path"
 * action, the search result is projected field by field, and `/api/spotify/…`
 * routes the device offers but this map omits — the per-track audio
 * diagnostics, for one — stay unreachable from Center.
 */
const PIN_SPOTIFY_PATHS = {
  status: { method: "GET", path: "/api/spotify/status" },
  settings: { method: "PUT", path: "/api/spotify/settings" },
  pair: { method: "POST", path: "/api/spotify/pairing/start" },
  cancel: { method: "POST", path: "/api/spotify/pairing/cancel" },
  disconnect: { method: "DELETE", path: "/api/spotify/session" },
  search: { method: "GET", path: "/api/spotify/search" },
} as const;

/** The one `kind` the device's search implements. */
const SPOTIFY_SEARCH_KIND = "track";
const MAX_SPOTIFY_SEARCH_QUERY_CHARACTERS = 80;
const MAX_SPOTIFY_SEARCH_ITEMS = 10;
const MAX_SEARCH_RESPONSE_BYTES = 32 * 1024;

const STATUS_STATES = new Set(["disabled", "not_configured", "pairing", "ready", "error"]);
const MAX_ADAPTER_RESPONSE_BYTES = 64 * 1024;
const MAX_DEVICE_FETCH_REQUEST_BYTES = 512 * 1024;
const MAX_DEVICE_FETCH_BODY_BYTES = 5 * 1024 * 1024;
const MAX_DEVICE_FETCH_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_DEVICE_NAME = "Ai Pin";
const MUSIC_PROVIDERS = new Set(["spotify", "youtube_music", "apple_music", "tidal"]);
const MUSIC_GATEWAY_TOKEN_CONTEXT = "ai-pin-revival/music-gateway/v1";
const DEVICE_MUSIC_EGRESS_PATH = "/api/pin-remote/api/music/egress";
const DEVICE_MUSIC_EGRESS_METHODS = new Set(["GET", "HEAD", "POST"]);
const DEVICE_MUSIC_EGRESS_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "origin",
  "referer",
  "user-agent",
  "x-goog-api-format-version",
  "x-goog-api-key",
  "x-goog-authuser",
  "x-goog-visitor-id",
  "x-origin",
  "x-user-agent",
  "x-youtube-bootstrap-logged-in",
  "x-youtube-client-name",
  "x-youtube-client-version",
]);
const DEVICE_MUSIC_EGRESS_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "etag",
  "last-modified",
]);
const DEVICE_YOUTUBE_REQUEST_HOSTS = new Set([
  "www.youtube.com",
  "music.youtube.com",
  "youtube.com",
  "youtubei.googleapis.com",
  "jnn-pa.googleapis.com",
]);

export type MusicProvider = "spotify" | "youtube_music" | "apple_music" | "tidal";

export type SpotifyPinState = "disabled" | "not_configured" | "pairing" | "ready" | "error";
export type SpotifyCenterState = SpotifyPinState | "unavailable";
export type SpotifyUnavailableReason =
  | "not_configured"
  | "pin_not_paired"
  | "pairing_unconfirmed"
  | "pin_unavailable"
  | "pin_update_required";

export type SpotifyStatus = {
  active_provider: MusicProvider;
  providers?: Awaited<ReturnType<typeof import("./musicGateway").musicProviderStatus>>;
  enabled: boolean;
  experimental_acknowledged: boolean;
  state: SpotifyCenterState;
  device_name: string;
  engine_ready: boolean;
  username?: string;
  pairing_expires_at?: number;
  last_error?: string;
  unavailable_reason?: SpotifyUnavailableReason;
};

export type SpotifySettingsDto = {
  active_provider: MusicProvider;
  enabled: boolean;
  experimental_acknowledged: boolean;
  device_name: string;
};

/*
 * The status-shaped actions only. `search` answers a track list rather than a
 * status, so leaving it in this union would let `runSpotifyBridgeAction` route
 * a search through `callAdapter` and hand a projected search body to
 * `normalizeSpotifyStatus` — a 502 at best. Excluding it makes that a type
 * error instead, and gives search its own function with its own projector.
 */
export type SpotifyBridgeAction = Exclude<keyof typeof PIN_SPOTIFY_PATHS, "search">;

export type SpotifySearchTrack = {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  duration_ms?: number;
  explicit?: boolean;
};

export type SpotifySearchResult = {
  items: SpotifySearchTrack[];
};

export type SpotifyBridgeErrorCode =
  | "bridge_not_configured"
  | "wrong_owner"
  | "roster_unavailable"
  | "pin_not_paired"
  | "pin_binding_invalid"
  | "adapter_unavailable"
  | "pin_rejected"
  | "invalid_response";

export class SpotifyBridgeError extends Error {
  readonly code: SpotifyBridgeErrorCode;
  readonly status: number;

  constructor(
    code: SpotifyBridgeErrorCode,
    status: number,
    message: string,
  ) {
    super(message);
    this.name = "SpotifyBridgeError";
    this.code = code;
    this.status = status;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanBoundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > maximum || /\p{Cc}/u.test(trimmed)) return undefined;
  return trimmed;
}

function timeoutMs(): number {
  const configured = Number(process.env.REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(configured)));
}

function deviceRequestSignal(
  input: string | URL | Request,
  init: RequestInit | undefined,
): AbortSignal {
  const signals = [init?.signal ?? AbortSignal.timeout(timeoutMs())];
  if (input instanceof Request && !signals.includes(input.signal)) signals.push(input.signal);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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

async function readDeviceRequestBody(
  request: Request,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) {
    await request.body?.cancel().catch(() => undefined);
    throw new SpotifyBridgeError("invalid_response", 413, "Music provider request was too large.");
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const cancelForAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelForAbort, { once: true });
  if (signal.aborted) cancelForAbort();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new SpotifyBridgeError("invalid_response", 413, "Music provider request was too large.");
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }

  const body = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function normalizedBaseUrl(value: string | undefined, label: string): string {
  const raw = value?.trim() ?? "";
  if (!raw) {
    throw new SpotifyBridgeError("bridge_not_configured", 503, "Spotify setup is unavailable.");
  }
  try {
    const url = new URL(raw);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
      throw new Error("unsupported URL");
    }
    if (url.pathname !== "/" || url.search || url.hash) throw new Error("URL must be an origin");
    return url.origin;
  } catch {
    throw new SpotifyBridgeError(
      "bridge_not_configured",
      503,
      `${label} is not configured correctly.`,
    );
  }
}

async function readBoundedText(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }

  if (!response.body) return "";
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
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
      }
      chunks.push(value);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function readJsonBounded(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }
  const text = await readBoundedText(response, maximum, signal);
  try {
    return JSON.parse(text);
  } catch {
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }
}

/** Strict settings boundary. No account, device, token, or arbitrary fields are accepted. */
export function parseSpotifySettingsDto(input: unknown): SpotifySettingsDto {
  const body = objectRecord(input);
  if (!body) {
    throw new SpotifyBridgeError("invalid_response", 400, "Expected Spotify settings.");
  }
  const allowed = new Set([
    "active_provider",
    "enabled",
    "experimental_acknowledged",
    "device_name",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new SpotifyBridgeError("invalid_response", 400, "Spotify settings contain an unknown field.");
  }
  if (typeof body.enabled !== "boolean" || typeof body.experimental_acknowledged !== "boolean") {
    throw new SpotifyBridgeError("invalid_response", 400, "Spotify settings are invalid.");
  }
  const deviceName = cleanBoundedString(body.device_name, 48);
  if (!deviceName) {
    throw new SpotifyBridgeError(
      "invalid_response",
      400,
      "The Spotify device name must be 1 to 48 characters.",
    );
  }
  const providerValue = body.active_provider;
  if (typeof providerValue !== "string" || !MUSIC_PROVIDERS.has(providerValue)) {
    throw new SpotifyBridgeError("invalid_response", 400, "Choose a supported music provider.");
  }
  if (body.enabled && !body.experimental_acknowledged) {
    throw new SpotifyBridgeError(
      "invalid_response",
      400,
      "Confirm personal testing and Spotify Premium before enabling Spotify.",
    );
  }
  return {
    active_provider: providerValue as MusicProvider,
    enabled: body.enabled,
    experimental_acknowledged: body.experimental_acknowledged,
    device_name: deviceName,
  };
}

/** Allowlist the safe status fields; credentials and unexpected Pin fields are dropped. */
export function normalizeSpotifyStatus(input: unknown): SpotifyStatus {
  const body = objectRecord(input);
  if (
    !body ||
    typeof body.enabled !== "boolean" ||
    typeof body.experimental_acknowledged !== "boolean" ||
    typeof body.state !== "string" ||
    !STATUS_STATES.has(body.state) ||
    typeof body.engine_ready !== "boolean"
  ) {
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }
  const deviceName = cleanBoundedString(body.device_name, 48);
  if (!deviceName) {
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }
  const username = cleanBoundedString(body.username, 256);
  const lastError = cleanBoundedString(body.last_error, 256);
  const expires = body.pairing_expires_at;
  const pairingExpiresAt =
    typeof expires === "number" && Number.isSafeInteger(expires) && expires > 0 ? expires : undefined;

  const providerValue = body.active_provider;
  if (typeof providerValue !== "string" || !MUSIC_PROVIDERS.has(providerValue)) {
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }
  return {
    active_provider: providerValue as MusicProvider,
    enabled: body.enabled,
    experimental_acknowledged: body.experimental_acknowledged,
    state: body.state as SpotifyPinState,
    device_name: deviceName,
    engine_ready: body.engine_ready,
    ...(username ? { username } : {}),
    ...(pairingExpiresAt ? { pairing_expires_at: pairingExpiresAt } : {}),
    ...(lastError ? { last_error: lastError } : {}),
  };
}

/**
 * The search term, or a refusal. Nothing else from the browser is used.
 *
 * The bound is the same 80 characters the adapter enforces. Stating it on both
 * sides is deliberate — this one exists so the wearer gets a sentence instead
 * of a generic rejection, and the adapter's exists because it is the boundary
 * that actually protects the device.
 */
export function parseSpotifySearchQuery(input: unknown): string {
  const query = typeof input === "string" ? input.trim() : "";
  if (!query) {
    throw new SpotifyBridgeError("invalid_response", 400, "Enter a song to search for.");
  }
  if ([...query].length > MAX_SPOTIFY_SEARCH_QUERY_CHARACTERS || /\p{Cc}/u.test(query)) {
    throw new SpotifyBridgeError(
      "invalid_response",
      400,
      `Keep the search under ${MAX_SPOTIFY_SEARCH_QUERY_CHARACTERS} characters.`,
    );
  }
  return query;
}

/** Allowlist the track fields Center renders; drop anything else. */
export function normalizeSpotifySearchResult(input: unknown): SpotifySearchResult {
  const body = objectRecord(input);
  if (!body || !Array.isArray(body.items)) {
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }

  const items = body.items.slice(0, MAX_SPOTIFY_SEARCH_ITEMS).flatMap((value) => {
    const item = objectRecord(value);
    if (!item) return [];
    const id = cleanBoundedString(item.id, 128);
    const title = cleanBoundedString(item.title, 200);
    if (!id || !title) return [];

    const album = cleanBoundedString(item.album, 200);
    const duration = item.duration_ms;
    return [
      {
        id,
        title,
        artists: (Array.isArray(item.artists) ? item.artists : [])
          .slice(0, 8)
          .flatMap((artist) => {
            const name = cleanBoundedString(artist, 200);
            return name ? [name] : [];
          }),
        ...(album ? { album } : {}),
        ...(typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0
          ? { duration_ms: duration }
          : {}),
        ...(typeof item.explicit === "boolean" ? { explicit: item.explicit } : {}),
      },
    ];
  });

  return { items };
}

/**
 * Ask the Pin for tracks matching one search term.
 *
 * Same ownership gate as every other bridge action — the wearer must be the
 * deployment's Pin owner and the roster must confirm the pairing — because a
 * search is still the device's Spotify session doing work on someone's account.
 * It does not share `callAdapter`: that function's whole contract is "returns a
 * SpotifyStatus", including its 204 fallback that re-reads status, and none of
 * that is true here.
 */
export async function runSpotifySearch(
  session: Session,
  query: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifySearchResult> {
  const term = parseSpotifySearchQuery(query);
  await requireOwnedPairedPin(session, fetchImpl);

  const baseUrl = normalizedBaseUrl(process.env.REVIVAL_SPOTIFY_ADAPTER_URL, "The Spotify adapter");
  const token = await adapterToken();
  const params = new URLSearchParams({ q: term, kind: SPOTIFY_SEARCH_KIND });
  const response = await fetchImpl(
    `${baseUrl}${PIN_SPOTIFY_PATHS.search.path}?${params.toString()}`,
    {
      method: PIN_SPOTIFY_PATHS.search.method,
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs()),
    },
  ).catch(() => null);

  if (!response) {
    throw new SpotifyBridgeError("adapter_unavailable", 503, "Your Pin could not be reached.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if ([400, 404, 409, 414, 422].includes(response.status)) {
      throw new SpotifyBridgeError("pin_rejected", 400, "Spotify could not run that search.");
    }
    if (response.status === 429) {
      throw new SpotifyBridgeError("pin_rejected", 429, "Spotify is busy. Try again shortly.");
    }
    throw new SpotifyBridgeError("adapter_unavailable", 503, "Your Pin could not be reached.");
  }

  try {
    return normalizeSpotifySearchResult(
      await readJsonBounded(response, MAX_SEARCH_RESPONSE_BYTES),
    );
  } catch (error) {
    if (error instanceof SpotifyBridgeError) throw error;
    throw new SpotifyBridgeError("adapter_unavailable", 503, "Your Pin could not be reached.");
  }
}

export function unavailableSpotifyStatus(reason: SpotifyUnavailableReason): SpotifyStatus {
  return {
    active_provider: "spotify",
    enabled: false,
    experimental_acknowledged: false,
    state: "unavailable",
    device_name: DEFAULT_DEVICE_NAME,
    engine_ready: false,
    unavailable_reason: reason,
  };
}

/** Shared private token for Center's purpose-scoped host adapter. */
export async function adapterToken(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const tokenFile = process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE?.trim();
  let token = "";
  if (tokenFile) {
    const tokenRead = readFile(tokenFile, { encoding: "utf8", signal });
    try {
      token = signal ? await waitForSignal(tokenRead, signal) : await tokenRead;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      token = "";
    }
  } else {
    // Useful only for local development. Production mounts the shared secret file.
    token = process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN ?? "";
  }
  signal?.throwIfAborted();
  token = token.trim();
  if (token.length < 32 || token.length > 512 || /\s/u.test(token)) {
    throw new SpotifyBridgeError("bridge_not_configured", 503, "Spotify setup is unavailable.");
  }
  return token;
}

export function musicGatewayOrigin(): string {
  const raw = process.env.REVIVAL_MUSIC_GATEWAY_ORIGIN?.trim() ?? "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new SpotifyBridgeError("bridge_not_configured", 503, "Music gateway is unavailable.");
  }
}

async function musicGatewayTokenForDevice(deviceId: string, signal?: AbortSignal): Promise<string> {
  return createHmac("sha256", await adapterToken(signal))
    .update(`${MUSIC_GATEWAY_TOKEN_CONTEXT}\0${deviceId}`, "utf8")
    .digest("base64url");
}

export async function deviceMusicGatewayToken(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return (await deviceMusicGatewayIdentity(signal, fetchImpl)).token;
}

export async function deviceMusicGatewayIdentity(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; ownerSub: string; deviceId: string }> {
  try {
    const assignment = await activePinBridgeAssignment(fetchImpl, signal);
    return {
      token: await musicGatewayTokenForDevice(assignment.deviceId, signal),
      ownerSub: assignment.ownerSub,
      deviceId: assignment.deviceId,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw spotifyBridgeError(error, "Music gateway is unavailable.");
  }
}

function deviceYoutubeRequestUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      DEVICE_YOUTUBE_REQUEST_HOSTS.has(host)
    );
  } catch {
    return false;
  }
}

function canonicalBase64(value: unknown, maximumBytes: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximumBytes / 3) * 4 + 4) {
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== value) {
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }
  return bytes;
}

/**
 * Execute one allowlisted YouTube player request through the paired Pin.
 *
 * The interface deliberately mirrors `fetch`, so youtubei.js and BotGuard do
 * not learn about Iroh, the adapter bearer, or the Pin's bounded wire shape.
 * Provider credentials never enter the request: this route is only for the
 * public player/integrity traffic whose VPS source address YouTube rejects.
 */
export async function deviceMusicProviderFetch(
  input: string | URL | Request,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const signal = deviceRequestSignal(input, init);
  const request = new Request(input, { ...init, signal });
  signal.throwIfAborted();
  if (!DEVICE_MUSIC_EGRESS_METHODS.has(request.method) || !deviceYoutubeRequestUrl(request.url)) {
    throw new SpotifyBridgeError("invalid_response", 502, "Music provider request was rejected.");
  }
  const headers: Record<string, string> = {};
  let headerBytes = 0;
  for (const [name, value] of request.headers) {
    if (!DEVICE_MUSIC_EGRESS_REQUEST_HEADERS.has(name)) {
      throw new SpotifyBridgeError("invalid_response", 502, "Music provider request was rejected.");
    }
    headerBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (headerBytes > 16 * 1024 || /[\r\n]/u.test(value)) {
      throw new SpotifyBridgeError("invalid_response", 502, "Music provider request was rejected.");
    }
    headers[name] = value;
  }
  const requestBytes = await readDeviceRequestBody(
    request,
    MAX_DEVICE_FETCH_REQUEST_BYTES,
    signal,
  );

  const baseUrl = normalizedBaseUrl(process.env.REVIVAL_SPOTIFY_ADAPTER_URL, "The Spotify adapter");
  const response = await fetchImpl(`${baseUrl}${DEVICE_MUSIC_EGRESS_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await adapterToken(signal)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "youtube_music",
      method: request.method,
      url: request.url,
      headers,
      ...(requestBytes.length ? { body_base64: requestBytes.toString("base64") } : {}),
    }),
    cache: "no-store",
    redirect: "error",
    signal,
  }).catch(() => null);
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    throw new SpotifyBridgeError("adapter_unavailable", 503, "Your Pin could not be reached.");
  }
  let decodedValue: unknown;
  try {
    decodedValue = await readJsonBounded(response, MAX_DEVICE_FETCH_RESPONSE_BYTES, signal);
  } catch (error) {
    if (signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw new SpotifyBridgeError("adapter_unavailable", 503, "Your Pin could not be reached.");
    }
    throw error;
  }
  const decoded = objectRecord(decodedValue);
  const status = decoded?.status;
  const rawHeaders = objectRecord(decoded?.headers);
  if (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599 || !rawHeaders) {
    throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
  }
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (!DEVICE_MUSIC_EGRESS_RESPONSE_HEADERS.has(name) || typeof value !== "string" || /[\r\n]/u.test(value)) {
      throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
    }
    responseHeaders.set(name, value);
  }
  const body = canonicalBase64(decoded?.body_base64, MAX_DEVICE_FETCH_BODY_BYTES);
  if (responseHeaders.has("content-length")) {
    responseHeaders.set("content-length", String(body.length));
  }
  return new Response(
    new Set([204, 205, 304]).has(status as number) ? null : Uint8Array.from(body),
    {
      status: status as number,
      headers: responseHeaders,
    },
  );
}

/**
 * Authorize the one fixed Pin bridge for this wearer.
 *
 * The browser never supplies an account or device id: the owner is a deployment
 * invariant and the durable Cosmos pairing roster must independently confirm a
 * Pin claim for the signed session subject.
 */
function spotifyBridgeError(error: unknown, fallback: string): SpotifyBridgeError {
  if (error instanceof SpotifyBridgeError) return error;
  if (error instanceof PinBridgeError) {
    const code: SpotifyBridgeErrorCode = error.code === "bridge_unavailable"
      ? "adapter_unavailable"
      : error.code;
    return new SpotifyBridgeError(code, error.status, error.message);
  }
  return new SpotifyBridgeError("adapter_unavailable", 503, fallback);
}

export async function requireOwnedPairedPin(
  session: Session,
  fetchImpl: typeof fetch = fetch,
): Promise<PinBridgeAssignment> {
  try {
    return await requirePinBridgeAssignment(session, fetchImpl);
  } catch (error) {
    throw spotifyBridgeError(error, "Your paired Pin could not be confirmed.");
  }
}

async function callAdapter(
  action: SpotifyBridgeAction,
  settings: SpotifySettingsDto | undefined,
  deviceId: string,
  fetchImpl: typeof fetch,
): Promise<SpotifyStatus> {
  const target = PIN_SPOTIFY_PATHS[action];
  const baseUrl = normalizedBaseUrl(process.env.REVIVAL_SPOTIFY_ADAPTER_URL, "The Spotify adapter");
  const token = await adapterToken();
  let adapterSettings: Record<string, unknown> | undefined = settings;
  if (settings && settings.active_provider !== "spotify") {
    adapterSettings = {
      ...settings,
      music_gateway_url: musicGatewayOrigin(),
      music_gateway_token: await musicGatewayTokenForDevice(deviceId),
    };
  }
  const response = await fetchImpl(`${baseUrl}${target.path}`, {
    method: target.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(settings ? { "content-type": "application/json" } : {}),
    },
    body: adapterSettings ? JSON.stringify(adapterSettings) : undefined,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs()),
  }).catch(() => null);

  if (!response) {
    throw new SpotifyBridgeError("adapter_unavailable", 503, "Your Pin could not be reached.");
  }
  if (!response.ok) {
    // Do not forward the adapter's body: it may contain implementation detail.
    await response.body?.cancel().catch(() => undefined);
    if ([400, 409, 422].includes(response.status)) {
      throw new SpotifyBridgeError("pin_rejected", response.status, "Spotify rejected that change.");
    }
    if (response.status === 429) {
      throw new SpotifyBridgeError("pin_rejected", 429, "Spotify is busy. Try again shortly.");
    }
    throw new SpotifyBridgeError("adapter_unavailable", 503, "Your Pin could not be reached.");
  }
  if (response.status === 204) {
    if (action === "status") {
      throw new SpotifyBridgeError("invalid_response", 502, "The Pin returned an invalid response.");
    }
    return callAdapter("status", undefined, deviceId, fetchImpl);
  }
  try {
    return normalizeSpotifyStatus(await readJsonBounded(response, MAX_ADAPTER_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof SpotifyBridgeError) throw error;
    throw new SpotifyBridgeError("adapter_unavailable", 503, "Your Pin could not be reached.");
  }
}

export async function runSpotifyBridgeAction(
  session: Session,
  action: SpotifyBridgeAction,
  settings?: SpotifySettingsDto,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyStatus> {
  const assignment = await requireOwnedPairedPin(session, fetchImpl);
  if (action === "settings" && !settings) {
    throw new SpotifyBridgeError("invalid_response", 400, "Expected Spotify settings.");
  }
  if (action !== "settings" && settings) {
    throw new SpotifyBridgeError("invalid_response", 400, "This Spotify action does not accept settings.");
  }
  return callAdapter(action, settings, assignment.deviceId, fetchImpl);
}

export function isSpotifyUnavailableError(error: unknown): boolean {
  return (
    error instanceof SpotifyBridgeError &&
    new Set<SpotifyBridgeErrorCode>([
      "bridge_not_configured",
      "pin_not_paired",
      "roster_unavailable",
      "adapter_unavailable",
      "invalid_response",
    ]).has(error.code)
  );
}
