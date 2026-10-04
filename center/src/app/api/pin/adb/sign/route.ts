import {
  AdbSignerError,
  MAX_SIGNER_REQUEST_BYTES,
  createRateLimiter,
  readBoundedBytes,
  requestAdbSignature,
} from "@/server/adb-signer";
import { isSameOriginRequest } from "@/server/auth";
import { requireWearerRequest } from "@/server/operator";

/**
 * POST /api/pin/adb/sign, sign one ADB AUTH token for a Pin on this browser's USB bus.
 *
 * The Pin console runs entirely in the browser over WebUSB: one ADB session
 * carries the Device Installer AND every settings call. Exactly one step
 * of that needs the network, answering the device's ADB AUTH challenge, which
 * only the remote signer can do. The Setup SPA called that third-party
 * Cloudflare Worker straight from page JavaScript. Center will not: it would
 * mean widening `connect-src 'self'` on the origin that holds the `cosmos_tokens`
 * session cookie so that any script on it could reach a third party. The call
 * happens here instead, and the CSP in `next.config.mjs` stays as it is.
 *
 * Wire contract, identical to what `install/device/adbAuth.ts` already speaks so
 * the ported client changes only its URL:
 *
 *   request, the raw ADB token bytes as the body (exactly 20, no envelope)
 *   response, `{ token, public_key }`: base64 signature, ADB-format public key
 *
 * Gates, in order: a Center session (middleware refuses `/api/*` without one;
 * checked again here), same-origin (this is a POST that spends a third-party
 * call), a per-session budget, and an exact 20-byte body. It is a WEARER
 * surface, not an operator one, installing software on your own Pin is the
 * whole point, but it is never anonymous.
 *
 * Nothing in this path logs the token, the signature, or the signer's response
 * body. Errors contain a status and prose, never material.
 */

/** ~one connection attempt every two seconds, sustained. A real handshake needs one or two. */
const allowSignature = createRateLimiter({ windowMs: 60_000, max: 30, maxTracked: 512 });

/** The signer is a network call behind a session check. Never prerender or cache it. */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const gate = await requireWearerRequest();
  if (gate instanceof Response) return gate;

  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }

  // Keyed by the account when there is one. With Keycloak unconfigured (local
  // `next dev`) the whole deployment is open, so one shared bucket is honest.
  if (!allowSignature(gate?.sub ?? "local-development")) {
    return Response.json(
      { error: "Too many ADB signing requests. Wait a moment and reconnect the Pin." },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  try {
    const token = await readBoundedBytes(request.body, MAX_SIGNER_REQUEST_BYTES);
    const signature = await requestAdbSignature(token);
    // Only the two fields the authenticator consumes; `parseSignerResponse`
    // already dropped anything else the signer returned.
    return Response.json(
      { token: signature.token, public_key: signature.public_key },
      {
        status: 200,
        headers: {
          "cache-control": "no-store, max-age=0",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      },
    );
  } catch (error) {
    if (error instanceof AdbSignerError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    // Unnamed failures are reported as a failure, never as a stack or a cause:
    // the token is in scope on this path.
    return Response.json(
      { error: "The Pin could not be authorized over USB." },
      { status: 502 },
    );
  }
}
