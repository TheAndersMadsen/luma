import { cookies } from "next/headers";
import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { isSameOriginRequest, SESSION_COOKIE, verifySession } from "@/server/auth";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };
const STOCK_PRODUCT = "00000001";

/**
 * POST /api/admin/provision — mint a device-attestation credential for a new Pin,
 * proxied to `/demo-api/admin/provision`. Body: `{ device_id, product? }`.
 *
 * The response carries the device certificate, its private key (issued once,
 * never stored), the signing CA, and the enrollment pincode — everything the
 * operator hands a device so it can run the OPAQUE ceremony. That key is
 * sensitive, so this is POST-only and admin-gated; the token is injected here,
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
      { error: "The operator console is not configured (no COSMOS_ADMIN_TOKEN)." },
      {
        status: 503,
        headers: {
          ...NO_STORE,
          ...sourceHeaders({ source: "unconfigured", state: "absent", fallback: "empty" }),
        },
      },
    );
  }

  let body: { device_id?: unknown; product?: unknown };
  try {
    body = (await request.json()) as { device_id?: unknown; product?: unknown };
  } catch {
    return Response.json(
      { error: "Expected a JSON body." },
      { status: 400, headers: NO_STORE },
    );
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
            ? { source: "cosmos", state: "live" }
            : {
                source: "cosmos",
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
            source: "unreachable",
            state: "degraded",
            fallback: "empty",
            degraded: "The backend is unreachable.",
          }),
        },
      },
    );
  }
}
