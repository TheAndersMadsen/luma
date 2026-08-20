import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  isSameOriginRequest,
  verifySession,
  type Session,
} from "@/server/auth";
import {
  SpotifyBridgeError,
  isSpotifyUnavailableError,
  unavailableSpotifyStatus,
} from "@/server/spotifyBridge";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" } as const;
const MAX_SETTINGS_BODY_BYTES = 2 * 1024;
const SETTINGS_BODY_TIMEOUT_MS = 3_000;

type BoundedJsonBodyOptions = {
  maxBytes?: number;
  tooLargeMessage?: string;
};

export async function requireSpotifySession(): Promise<Session | NextResponse> {
  if (!AUTH_ENABLED) {
    return NextResponse.json(
      { error: "Login is not configured on this deployment." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  return (
    session ??
    NextResponse.json(
      { error: "Not authenticated." },
      { status: 401, headers: PRIVATE_HEADERS },
    )
  );
}

export function requireSameOrigin(request: Request): NextResponse | null {
  return isSameOriginRequest(request)
    ? null
    : NextResponse.json(
        { error: "A same-origin request is required." },
        { status: 403, headers: PRIVATE_HEADERS },
      );
}

export async function boundedJsonBody(
  request: Request,
  options: BoundedJsonBodyOptions = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? MAX_SETTINGS_BODY_BYTES;
  const tooLargeMessage = options.tooLargeMessage ?? "Spotify settings are too large.";
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) {
    throw new SpotifyBridgeError("invalid_response", 500, "The request limit is invalid.");
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    throw new SpotifyBridgeError("invalid_response", 415, "Expected a JSON body.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SpotifyBridgeError("invalid_response", 413, tooLargeMessage);
  }
  if (!request.body) {
    throw new SpotifyBridgeError("invalid_response", 400, "Expected a JSON body.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  let requestAborted = request.signal.aborted;
  const cancelForAbort = () => {
    requestAborted = true;
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener("abort", cancelForAbort, { once: true });
  if (requestAborted) void reader.cancel().catch(() => undefined);
  const deadline = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, SETTINGS_BODY_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SpotifyBridgeError("invalid_response", 413, tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }
  if (timedOut || requestAborted) {
    throw new SpotifyBridgeError("invalid_response", 408, "Spotify settings took too long to send.");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new SpotifyBridgeError("invalid_response", 400, "Expected a JSON body.");
  }
}

export function spotifyJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

export function spotifyError(error: unknown, statusRead = false): NextResponse {
  if (statusRead && isSpotifyUnavailableError(error)) {
    const code = error instanceof SpotifyBridgeError ? error.code : "adapter_unavailable";
    const reason =
      code === "bridge_not_configured"
        ? "not_configured"
        : code === "roster_unavailable"
          ? "pairing_unconfirmed"
          : code === "invalid_response"
            ? "pin_update_required"
            : "pin_unavailable";
    const fallbackSetup = code === "adapter_unavailable" || code === "bridge_not_configured";
    return spotifyJson({ ...unavailableSpotifyStatus(reason), fallback_setup: fallbackSetup });
  }
  if (error instanceof SpotifyBridgeError) {
    return spotifyJson({ error: error.message }, error.status);
  }
  return spotifyJson({ error: "Spotify could not be reached." }, 503);
}
