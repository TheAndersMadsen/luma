import { cookies } from "next/headers";
import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import { isSameOriginRequest, SESSION_COOKIE, verifySession } from "@/server/auth";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };
const STOCK_PRODUCT = "00000001";

/**
 * POST /api/admin/provision, mint a device-attestation credential for a new Pin,
 * proxied to `/demo-api/admin/provision`. Body: `{ device_id, product? }`.
 *
 * The response carries the device certificate, its private key (issued once,
 * never stored), the signing intermediate and operator root, everything the
 * operator hands a device so it can run the OPAQUE ceremony with the passcode
 * its owner set. That key is
 * sensitive, so this is POST-only and admin-gated. The token is injected here,
 * and the console marks the response as shown-once with a control to clear it
 * from the screen.
 *
 * 503 = no admin token here (nothing to retry). 502 = the backend did not answer.
 */
export async function POST(request: Request) {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) {
    return Response.json({ error: "Not authenticated." }, { status: 401, headers: NO_STORE });
  }
  if (!session.operator) {
    return Response.json(
      { error: "Operator access required." },
      { status: 403, headers: NO_STORE },
    );
  }
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { error: "A same-origin request is required." },
      { status: 403, headers: NO_STORE },
    );
  }
  if (!COSMOS_ADMIN_ENABLED) {
    return Response.json(
      { error: "Operator provisioning is not configured (no COSMOS_ADMIN_TOKEN)." },
      {
        status: 503,
        headers: {
          ...NO_STORE,
          ...sourceHeaders({ state: "absent", fallback: "empty" }),
        },
      },
    );
  }

  // A device id and a fixed product: nothing that needs an unbounded read.
  let body: { device_id?: unknown; product?: unknown };
  try {
    body = (await boundedJsonBody(request, {
      tooLargeMessage: "That request is too large.",
    })) as { device_id?: unknown; product?: unknown };
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    throw error;
  }

  const deviceId = typeof body.device_id === "string" ? body.device_id.trim().toLowerCase() : "";
  if (!deviceId || !/^[0-9a-f]+$/.test(deviceId)) {
    return Response.json(
      { error: "Enter the detected device id as hexadecimal (0-9a-f)." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (body.product !== undefined && body.product !== STOCK_PRODUCT) {
    return Response.json(
      { error: `The stock Ai Pin product identity is fixed to ${STOCK_PRODUCT}.` },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const res = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/provision`, {
      method: "POST",
      cache: "no-store",
      signal: cosmosDeadlineSignal(),
      headers: { "content-type": "application/json", ...adminAuthHeaders() },
      body: JSON.stringify({ device_id: deviceId, product: STOCK_PRODUCT }),
    });
    return new Response(res.body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        ...NO_STORE,
        ...sourceHeaders(
          res.ok
            ? { state: "live" }
            : {
                state: "degraded",
                fallback: "empty",
                degraded: `The backend answered ${res.status}.`,
              },
        ),
      },
    });
  } catch {
    return Response.json(
      { error: "The backend is unreachable." },
      {
        status: 502,
        headers: {
          ...NO_STORE,
          ...sourceHeaders({
            state: "degraded",
            fallback: "empty",
            degraded: "The backend is unreachable.",
          }),
        },
      },
    );
  }
}
