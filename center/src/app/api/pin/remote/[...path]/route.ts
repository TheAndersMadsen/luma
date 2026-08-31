import { isSameOriginRequest } from "@/server/auth";
import { requireWearerRequest } from "@/server/operator";
import {
  SpotifyBridgeError,
  requireOwnedPairedPin,
} from "@/server/spotifyBridge";
import { pinBridgeRequest } from "@/server/pinBridge";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
} as const;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_QUERY_BYTES = 2 * 1024;
const USB_ONLY_NAMESPACES = [
  "/api/esim",
  "/api/cellular",
  "/api/wifi",
  "/api/logs",
  "/api/dev",
] as const;

type RouteContext = { params: Promise<{ path: string[] }> };

function jsonError(status: number, error: string) {
  return Response.json({ error }, { status, headers: PRIVATE_HEADERS });
}

function inNamespace(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function targetPath(segments: string[]): string | null {
  if (
    segments.length < 2 ||
    segments.length > 12 ||
    segments[0] !== "api" ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        /[\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    return null;
  }
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  const declaredText = request.headers.get("content-length");
  if (declaredText !== null) {
    if (!/^\d+$/u.test(declaredText) || Number(declaredText) > MAX_REQUEST_BODY_BYTES) {
      throw new SpotifyBridgeError("invalid_response", 413, "That Pin setting is too large.");
    }
  }
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SpotifyBridgeError("invalid_response", 413, "That Pin setting is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return undefined;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const session = await requireWearerRequest();
  if (session instanceof Response) return session;
  if (!session) return jsonError(503, "Sign-in is required for remote Pin access.");

  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return jsonError(403, "A same-origin request is required.");
  }

  const { path } = await context.params;
  const pathname = targetPath(path);
  if (!pathname) return jsonError(404, "That Pin function is not available remotely.");
  if (USB_ONLY_NAMESPACES.some((prefix) => inNamespace(pathname, prefix))) {
    return jsonError(
      409,
      "Connect this Pin over USB for eSIM, cellular, Wi-Fi radio, and device-log maintenance.",
    );
  }

  const incomingUrl = new URL(request.url);
  if (Buffer.byteLength(incomingUrl.search, "utf8") > MAX_QUERY_BYTES) {
    return jsonError(414, "That Pin request is too long.");
  }

  try {
    await requireOwnedPairedPin(session);
    const body = await boundedBody(request);
    const upstreamBody = body
      ? (body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer)
      : undefined;
    const headers = new Headers({
      accept: request.headers.get("accept") ?? "*/*",
    });
    const contentType = request.headers.get("content-type");
    if (contentType && body) headers.set("content-type", contentType);

    const upstream = await pinBridgeRequest(
      `${pathname}${incomingUrl.search}`,
      {
        method: request.method,
        headers,
        body: upstreamBody,
        signal: AbortSignal.timeout(20_000),
      },
    );
    const responseHeaders = new Headers(PRIVATE_HEADERS);
    const upstreamType = upstream.headers.get("content-type");
    if (upstreamType) responseHeaders.set("content-type", upstreamType);
    return new Response(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      const status = [403, 409, 413].includes(error.status) ? error.status : 503;
      return jsonError(status, "Your paired Pin could not be reached securely.");
    }
    return jsonError(503, "Your paired Pin could not be reached securely.");
  }
}

export const dynamic = "force-dynamic";
export { handle as GET, handle as PUT, handle as POST, handle as DELETE };
