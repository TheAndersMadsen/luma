import {
  authenticateMusicGateway,
  MusicGatewayError,
  musicGatewayError,
} from "@/server/musicGateway";
import type { MusicProvider } from "@/server/spotifyBridge";

const MAX_DEVICE_BODY_BYTES = 64 * 1024;
const DEVICE_BODY_TIMEOUT_MS = 5_000;
const MAX_QUERY_BYTES = 256;
const MAX_QUERY_ITEMS = 100;
const QUERY_KINDS = new Set([
  "track",
  "top_hits",
  "artist",
  "album",
  "album_artist",
  "album_id",
  "genre",
  "playlist",
  "featured",
  "favorites",
  "radio",
  "recommendations",
  "generated",
  "ids",
]);

function fail(message: string, status = 400): never {
  throw new MusicGatewayError(message, status);
}

function exactKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(body).some((key) => !allowed.has(key))) fail("Music request contains an unknown field.");
}

function boundedText(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || Buffer.byteLength(text, "utf8") > MAX_QUERY_BYTES || /\p{Cc}/u.test(text)) {
    fail(`Invalid ${name}.`);
  }
  return text;
}

async function boundedDeviceJson(
  request: Request,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) fail("Expected a JSON body.", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_DEVICE_BODY_BYTES) fail("Request is too large.", 413);
  if (!request.body) fail("Expected a JSON body.");

  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  let aborted = false;
  const cancelForAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelForAbort, { once: true });
  if (signal.aborted) cancelForAbort();
  const deadline = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, DEVICE_BODY_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DEVICE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail("Request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }
  if (timedOut || aborted) fail("Music request timed out.", 408);

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail("Expected a JSON body.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected a JSON body.");
  return value as Record<string, unknown>;
}

export async function deviceMusicRequest(
  request: Request,
  signal: AbortSignal = request.signal,
): Promise<{
  subject: string;
  body: Record<string, unknown>;
}> {
  const subject = await authenticateMusicGateway(request, signal);
  return { subject, body: await boundedDeviceJson(request, signal) };
}

export function provider(value: unknown): MusicProvider {
  if (!new Set(["youtube_music", "tidal", "apple_music", "spotify"]).has(String(value))) {
    fail("Invalid music provider.");
  }
  return value as MusicProvider;
}

export function queryRequest(body: Record<string, unknown>): {
  provider: MusicProvider;
  kind: string;
  primary?: string;
  secondary?: string;
  ids?: string[];
  limit: number;
} {
  exactKeys(body, new Set(["provider", "kind", "primary", "secondary", "ids", "limit"]));
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!QUERY_KINDS.has(kind)) fail("Unsupported music query.");
  const limit = body.limit === undefined ? 10 : body.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_ITEMS) {
    fail("Invalid music result limit.");
  }
  let ids: string[] | undefined;
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || body.ids.length > MAX_QUERY_ITEMS) fail("Invalid track identifiers.");
    ids = body.ids.map((id) => boundedText(id, "track identifier"));
  }
  return {
    provider: provider(body.provider),
    kind,
    ...(body.primary === undefined ? {} : { primary: boundedText(body.primary, "primary query") }),
    ...(body.secondary === undefined ? {} : { secondary: boundedText(body.secondary, "secondary query") }),
    ...(ids === undefined ? {} : { ids }),
    limit,
  };
}

export function trackRequest(body: Record<string, unknown>): {
  provider: MusicProvider;
  id: string;
} {
  exactKeys(body, new Set(["provider", "id"]));
  return { provider: provider(body.provider), id: boundedText(body.id, "track identifier") };
}

export { musicGatewayError };
