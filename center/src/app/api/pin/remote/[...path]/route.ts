import { isSameOriginRequest } from "@/server/auth";
import { requireWearerRequest } from "@/server/operator";
import {
  isRemotePinRequest,
  isUsbOnlyPinPath,
  PinBridgeError,
  pinBridgeRequest,
  requireOwnedPairedPin,
  type PinBridgeErrorCode,
} from "@/server/pinBridge";

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

/** pin/bridge `main.rs`: the body of its 403 for a route outside its allowlist. */
const BRIDGE_POLICY_REFUSAL = "request denied by bridge policy";

function jsonError(status: number, error: string, reason?: string) {
  return Response.json(reason ? { error, reason } : { error }, {
    status,
    headers: PRIVATE_HEADERS,
  });
}

/*
 * Each state of Center's remote link keeps its own status, sentence and
 * machine-readable `reason`, so the Pin console never parses prose.
 * `pin_not_paired` (the link has no Pin assigned) and `pin_binding_invalid`
 * (its Pin is no longer paired with this account) both mean Center has no Pin
 * it may reach. Guided setup's "Turn on remote access" over USB changes that.
 * `wrong_owner`, `bridge_not_configured` and `bridge_misconfigured` are this
 * server's setup, which waiting cannot change either. The console stops asking
 * for all five. A paired Pin that is asleep or offline is none of these.
 */
const LINK_FAILURES: Record<PinBridgeErrorCode, readonly [status: number, error: string]> = {
  pin_not_paired: [
    409,
    "Remote access isn’t on for your Pin yet. Connect it over USB and choose Turn on remote access in Guided setup.",
  ],
  pin_binding_invalid: [
    409,
    "Remote access still points at a Pin that is no longer paired. Connect your Pin over USB and choose Turn on remote access in Guided setup.",
  ],
  wrong_owner: [403, "Center’s remote link belongs to a Pin on another account."],
  bridge_not_configured: [503, "Remote Pin access is not set up on this server."],
  bridge_misconfigured: [503, "Remote Pin access is misconfigured on this server."],
  bridge_unavailable: [503, "Remote Pin access is unavailable right now."],
  invalid_response: [502, "Remote Pin access returned an invalid response."],
};

function linkFailure(error: unknown): Response {
  const code = error instanceof PinBridgeError ? error.code : "bridge_unavailable";
  const [status, message] = LINK_FAILURES[code];
  return jsonError(status, message, code);
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
      throw new PinBridgeError("invalid_response", 413, "That Pin setting is too large.");
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
        throw new PinBridgeError("invalid_response", 413, "That Pin setting is too large.");
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
  if (!session) return jsonError(503, "Sign-in is required for remote Pin access.", "sign_in_required");

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
      "usb_only",
    );
  }
  // Only the reviewed status and music routes cross the bridge (pin/bridge
  // `reviewed_route_allowed`). The bridge refuses the rest of the Pin's
  // device-local API, so it is answered here without asking.
  if (!isRemotePinRequest(request.method, pathname)) {
    return isUsbOnlyPinPath(pathname)
      ? jsonError(
          409,
          "Connect this Pin over USB for this. Remote access carries status and music controls only.",
          "usb_only",
        )
      : // Captures, contacts and history are read from Cosmos, never from the
        // Pin's own copies.
        jsonError(404, "That Pin function is not available remotely.");
  }

  const incomingUrl = new URL(request.url);
  if (Buffer.byteLength(incomingUrl.search, "utf8") > MAX_QUERY_BYTES) {
    return jsonError(414, "That Pin request is too long.");
  }

  try {
    await requireOwnedPairedPin(session, fetch, request.signal);
  } catch (error) {
    return linkFailure(error);
  }

  try {
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
        // The browser's own give-up ends this too, not only the 20 s bound.
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
      },
    );
    if (upstream.status >= 500) {
      // pin/bridge answers a failed Iroh round trip with its own 502 and a
      // diagnostic sentence. Like the Spotify adapter, keep that text off the
      // page: the link and its Pin were confirmed, so the Pin did not answer.
      await upstream.body?.cancel().catch(() => undefined);
      return jsonError(503, "Your paired Pin is not answering right now.", "pin_unreachable");
    }
    if (upstream.status === 403 && (await upstream.clone().text()).startsWith(BRIDGE_POLICY_REFUSAL)) {
      // The bridge's allowlist refused a route Center's own list let through.
      // Its answer is a bare sentence. Name it once here as the `usb_only`
      // reason the console already offers a cable for.
      await upstream.body?.cancel().catch(() => undefined);
      return jsonError(
        409,
        "Connect this Pin over USB for this. Remote access carries status and music controls only.",
        "usb_only",
      );
    }
    const responseHeaders = new Headers(PRIVATE_HEADERS);
    const upstreamType = upstream.headers.get("content-type");
    if (upstreamType) responseHeaders.set("content-type", upstreamType);
    return new Response(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof PinBridgeError && error.status === 413) {
      return jsonError(413, error.message);
    }
    // The link and its Pin were confirmed a moment ago, so what failed here is
    // the Pin answering through it: asleep, offline, or out of range.
    return jsonError(503, "Your paired Pin is not answering right now.", "pin_unreachable");
  }
}

export const dynamic = "force-dynamic";
export { handle as GET, handle as PUT, handle as POST, handle as DELETE };
