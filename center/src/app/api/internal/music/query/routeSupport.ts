import { timingSafeEqual } from "node:crypto";
import { MUSIC_PROVIDERS, musicProviderSchema, type MusicProvider, type SpotifySearchResult } from "@/lib/contracts/music";
import type { Session } from "@/server/auth";
import {
  gatewayQuery,
  MusicGatewayError,
  musicGatewayError,
  musicProviderTimeout,
} from "@/server/musicGateway";
import { runSpotifySearch } from "@/server/spotifyBridge";

/*
 * Cosmos's music grounding asks here for one provider's catalog: the provider
 * the wearer's account plays from, which Cosmos reads from its own store and
 * names in the request. Nothing here asks the Pin which provider is active.
 * Spotify's catalog is the Pin's own Spotify session, so a Spotify lookup
 * still runs on the Pin. YouTube Music and TIDAL run in the provider gateway
 * with the account Cosmos keeps.
 */

const MAX_BODY_BYTES = 4 * 1024;
const MAX_QUERY_CHARACTERS = 80;
const MAX_ITEMS = 10;
/**
 * Cosmos stops waiting for one provider attempt after 4.5 s
 * (PROVIDER_ATTEMPT_MAX in music_discovery.rs) and retries. A lookup must not
 * outlive that by much, or every retry leaves one running here.
 */
export const INTERNAL_MUSIC_QUERY_TIMEOUT_MS = 5_000;

type CatalogResult = {
  items: unknown[];
  ranking_provenance?: unknown;
};

export type InternalMusicDependencies = {
  spotifySearch(session: Session, query: string, signal?: AbortSignal): Promise<SpotifySearchResult>;
  gatewayQuery(
    subject: string,
    request: {
      provider: MusicProvider;
      kind: string;
      primary: string;
      limit: number;
    },
    signal?: AbortSignal,
  ): Promise<CatalogResult>;
};

const productionDependencies: InternalMusicDependencies = {
  spotifySearch: (session, query, signal) => runSpotifySearch(session, query, signal),
  gatewayQuery,
};

/** Settle when `operation` does or when `signal` ends, whichever is first. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      // Nobody waits for it any more. Its failure must not go unhandled.
      operation.catch(() => undefined);
      reject(signal.reason);
      return;
    }
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

function fail(message: string, status: number): never {
  throw new MusicGatewayError(message, status);
}

function constantTimeEqual(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticate(request: Request): void {
  const expected = process.env.COSMOS_ADMIN_TOKEN?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const presented = /^Bearer ([!-~]{16,512})$/u.exec(authorization)?.[1];
  if (!expected || presented === undefined || !constantTimeEqual(expected, presented)) {
    fail("Unauthorized.", 401);
  }
}

async function boundedJson(request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) fail("Expected a JSON body.", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    void request.body?.cancel().catch(() => undefined);
    fail("Request is too large.", 413);
  }
  if (!request.body) fail("Expected a JSON body.", 400);
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let length = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      if (value.byteLength > MAX_BODY_BYTES - length) {
        void reader.cancel().catch(() => undefined);
        fail("Request is too large.", 413);
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } catch {
    fail("Expected a JSON body.", 400);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    fail("Expected a JSON body.", 400);
  }
  return decoded as Record<string, unknown>;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || [...text].length > maximum || /\p{Cc}/u.test(text)) {
    fail(`Invalid ${name}.`, 400);
  }
  return text;
}

function wearerSubject(principal: unknown): string {
  const value = boundedText(principal, "principal", 512);
  const marker = value.lastIndexOf(":U:");
  const subject = marker >= 0
    ? value.slice(marker + 3)
    : value.startsWith("U:")
      ? value.slice(2)
      : value;
  return boundedText(subject, "principal", 512);
}

function sessionFor(subject: string): Session {
  return { sub: subject, email: "", name: "", operator: false };
}

function cleanText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && [...text].length <= maximum && !/\p{Cc}/u.test(text) ? text : undefined;
}

function projectItems(items: unknown[]): Record<string, unknown>[] {
  return items.slice(0, MAX_ITEMS).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const id = cleanText(item.id, 256);
    const title = cleanText(item.title, 200);
    if (!id || !title) return [];
    const artists = Array.isArray(item.artists)
      ? item.artists.slice(0, 8).flatMap((artist) => cleanText(artist, 200) ?? [])
      : [];
    if (artists.length === 0) return [];
    const album = cleanText(item.album, 200);
    const duration = item.duration_ms;
    return [{
      id,
      title,
      artists,
      ...(album ? { album } : {}),
      ...(typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0
        ? { duration_ms: duration }
        : {}),
      ...(typeof item.explicit === "boolean" ? { explicit: item.explicit } : {}),
    }];
  });
}

export async function internalMusicQuery(
  request: Request,
  dependencies: InternalMusicDependencies = productionDependencies,
  timeoutMs = INTERNAL_MUSIC_QUERY_TIMEOUT_MS,
): Promise<Response> {
  const budget = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
  let lookupProvider: MusicProvider | null = null;
  try {
    authenticate(request);
    const body = await boundedJson(request, budget);
    if (Object.keys(body).some((key) => !new Set(["principal", "provider", "query"]).has(key))) {
      fail("Music request contains an unknown field.", 400);
    }
    const subject = wearerSubject(body.principal);
    const query = boundedText(body.query, "query", MAX_QUERY_CHARACTERS);
    const parsedProvider = musicProviderSchema.safeParse(body.provider);
    if (!parsedProvider.success) fail("Unsupported music provider.", 400);
    const provider = parsedProvider.data;
    if (!MUSIC_PROVIDERS[provider].pinPlayback) {
      fail(`${MUSIC_PROVIDERS[provider].label} playback is not available on this Pin.`, 409);
    }
    const session = sessionFor(subject);
    lookupProvider = provider;
    const result = provider === "spotify"
      ? await untilAborted(dependencies.spotifySearch(session, query, budget), budget)
      : await untilAborted(dependencies.gatewayQuery(subject, {
          provider,
          kind: "track",
          primary: query,
          limit: MAX_ITEMS,
        }, budget), budget);
    return Response.json({
      provider,
      ranking_provenance: "not_ranked",
      items: projectItems(result.items),
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return musicGatewayError(
      budget.aborted
        ? lookupProvider ? musicProviderTimeout(lookupProvider) : new MusicGatewayError("Music request timed out.", 408)
        : error,
    );
  }
}
