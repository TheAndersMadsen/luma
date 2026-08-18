import { cookies } from "next/headers";
import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { SESSION_COOKIE, verifySession } from "@/server/auth";

/**
 * GET /api/admin/devices — proxied from `/demo-api/admin/devices`.
 *
 * What this actually lists: attestation credentials MINTED from the operator
 * console since the backend process last started. It is not a roster of devices
 * that completed `CreateDeviceUserBinding`, whatever this comment used to say —
 * the clone holds the list in memory, so a Pin that finished its binding weeks
 * ago is absent, and a credential minted and never used is present. The console
 * says the same thing above the table, because an operator reading it as a
 * pairing roster would draw the wrong conclusion from an empty one.
 *
 * 503 = no admin token here (nothing to retry). 502 = the backend did not answer.
 */
export async function GET() {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (!session.operator) {
    return Response.json({ error: "Operator access required." }, { status: 403 });
  }
  if (!COSMOS_ADMIN_ENABLED) {
    return Response.json(
      { error: "The operator console is not configured (no COSMOS_ADMIN_TOKEN)." },
      {
        status: 503,
        headers: sourceHeaders({ source: "unconfigured", state: "absent", fallback: "empty" }),
      },
    );
  }
  try {
    const res = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/devices`, {
      cache: "no-store",
      signal: cosmosDeadlineSignal(),
      headers: adminAuthHeaders(),
    });
    return new Response(res.body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
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
        headers: sourceHeaders({
          source: "unreachable",
          state: "degraded",
          fallback: "empty",
          degraded: "The backend is unreachable.",
        }),
      },
    );
  }
}
