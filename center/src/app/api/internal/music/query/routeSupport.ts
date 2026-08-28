import { timingSafeEqual } from "node:crypto";

import type { Session } from "@/server/auth";
import {
  gatewayQuery,
  MusicGatewayError,
  musicGatewayError,
} from "@/server/musicGateway";
import {
  runSpotifyBridgeAction,
  runSpotifySearch,
  type MusicProvider,
  type SpotifySearchResult,
  type SpotifyStatus,
} from "@/server/spotifyBridge";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_QUERY_CHARACTERS = 80;
const MAX_ITEMS = 10;

type CatalogResult = {
  items: unknown[];
  ranking_provenance?: unknown;
};

export type InternalMusicDependencies = {
  status(session: Session): Promise<Pick<SpotifyStatus, "active_provider">>;
  spotifySearch(session: Session, query: string): Promise<SpotifySearchResult>;
  gatewayQuery(
    subject: string,
    request: {
      provider: MusicProvider;
      kind: string;
      primary: string;
      limit: number;
    },
  ): Promise<CatalogResult>;
};

const productionDependencies: InternalMusicDependencies = {
  status: (session) => runSpotifyBridgeAction(session, "status"),
  spotifySearch: (session, query) => runSpotifySearch(session, query),
  gatewayQuery,
};

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
  const match = /^Bearer ([!-~]{16,512})$/u.exec(authorization);
  if (!expected || !match || !constantTimeEqual(expected, match[1])) {
    fail("Unauthorized.", 401);
  }
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) fail("Expected a JSON body.", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) fail("Request is too large.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) fail("Request is too large.", 413);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
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
): Promise<Response> {
  try {
    authenticate(request);
    const body = await boundedJson(request);
    if (Object.keys(body).some((key) => !new Set(["principal", "query"]).has(key))) {
      fail("Music request contains an unknown field.", 400);
    }
    const subject = wearerSubject(body.principal);
    const owner = process.env.REVIVAL_PIN_BRIDGE_OWNER_SUB?.trim() ?? "";
    if (!owner || !constantTimeEqual(owner, subject)) {
      fail("This music bridge is not assigned to that wearer.", 403);
    }
    const query = boundedText(body.query, "query", MAX_QUERY_CHARACTERS);
    const session = sessionFor(subject);
    const { active_provider: provider } = await dependencies.status(session);

    if (provider === "apple_music") {
      fail("Apple Music playback is not available on this Pin.", 409);
    }
    const result = provider === "spotify"
      ? await dependencies.spotifySearch(session, query)
      : await dependencies.gatewayQuery(subject, {
          provider,
          kind: "track",
          primary: query,
          limit: MAX_ITEMS,
        });
    return Response.json({
      provider,
      ranking_provenance: "not_ranked",
      items: projectItems(result.items),
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return musicGatewayError(error);
  }
}
