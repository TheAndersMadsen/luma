import { cookies } from "next/headers";
import { AUTH_ENABLED, SESSION_COOKIE, verifySession } from "@/server/auth";
import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";

type Pairing = {
  device_id?: string;
  account_sub?: string;
  paired_at_epoch?: number;
};

/** GET — the logged-in wearer's own durable Pin claims. */
export async function GET() {
  try {
    if (!AUTH_ENABLED) {
      return Response.json({ error: "Login is not configured on this deployment." }, { status: 503 });
    }
    const jar = await cookies();
    const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
    if (!session) return Response.json({ error: "Not authenticated." }, { status: 401 });
    if (!COSMOS_ADMIN_ENABLED) {
      return Response.json(
        { error: "Device pairing is not configured on this deployment." },
        { status: 503 },
      );
    }

    const res = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/devices`, {
      cache: "no-store",
      signal: cosmosDeadlineSignal(),
      headers: adminAuthHeaders(),
    }).catch(() => null);
    if (!res) return Response.json({ error: "Pin services are unavailable." }, { status: 503 });
    if (!res.ok) {
      return Response.json({ error: "Couldn’t load paired Pins." }, { status: res.status });
    }
    const body = (await res.json().catch(() => ({}))) as { pairings?: Pairing[] };
    const devices = (body.pairings ?? [])
      .filter((pairing) => pairing.account_sub === session.sub && pairing.device_id)
      .map((pairing) => ({
        deviceId: pairing.device_id as string,
        pairedAt: pairing.paired_at_epoch ?? null,
      }));
    return Response.json({ devices });
  } catch {
    return Response.json({ error: "The pairing roster could not be read." }, { status: 503 });
  }
}

/**
 * POST /api/devices/pair — claim a Pin for the LOGGED-IN wearer.
 *
 * The account the device is bound to is the caller's OWN session `sub`, read
 * server-side and never taken from the request body — so a user can only ever
 * pair a device to their own account. Body: `{ device_id }`.
 *
 * This forwards to the backend's admin-gated pair endpoint with a server-held
 * admin token the browser never sees. Pairing decides *whose* partition the Pin
 * enrols into; the on-device OPAQUE pincode ceremony still decides *whether* the
 * enrolment is legitimate.
 *
 * This endpoint was complete and had zero callers anywhere in the UI. It has one
 * now — Settings → My Ai Pin → "Pin setup" — so every branch below is a sentence
 * a wearer can actually read. They all say what happened and none of them 500s:
 * a thrown error here would surface as a crash in a settings pane.
 */
export async function POST(request: Request) {
  try {
    if (!AUTH_ENABLED) {
      return Response.json(
        { error: "Login is not configured on this deployment." },
        { status: 503 },
      );
    }

    // The account is the authenticated caller's own sub — read here, never trusted
    // from the request.
    const jar = await cookies();
    const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
    if (!session) {
      return Response.json({ error: "Not authenticated." }, { status: 401 });
    }

    if (!COSMOS_ADMIN_ENABLED) {
      return Response.json(
        { error: "Device pairing is not configured on this deployment." },
        { status: 503 },
      );
    }

    let body: { device_id?: string };
    try {
      body = (await request.json()) as { device_id?: string };
    } catch {
      return Response.json({ error: "Expected a JSON body." }, { status: 400 });
    }

    const deviceId = (body.device_id ?? "").trim();
    if (!deviceId) {
      return Response.json({ error: "A device_id is required." }, { status: 400 });
    }

    const res = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/pair`, {
      method: "POST",
      cache: "no-store",
      signal: cosmosDeadlineSignal(),
      headers: { "content-type": "application/json", ...adminAuthHeaders() },
      // account_sub is the caller's OWN sub, injected server-side — never the body.
      body: JSON.stringify({ device_id: deviceId, account_sub: session.sub }),
    }).catch(() => null);

    if (!res) {
      return Response.json({ error: "Pin services are unavailable." }, { status: 503 });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return Response.json(
        { error: "This Pin couldn’t be paired.", detail },
        { status: res.status },
      );
    }

    return Response.json({ ok: true, device_id: deviceId });
  } catch {
    // Session decryption, cookie access, anything else: report it, never crash
    // the pane that called us.
    return Response.json({ error: "The pairing could not be completed." }, { status: 503 });
  }
}

/** DELETE — release one of the logged-in wearer's own durable device claims. */
export async function DELETE(request: Request) {
  try {
    if (!AUTH_ENABLED || !COSMOS_ADMIN_ENABLED) {
      return Response.json({ error: "Device pairing is not configured." }, { status: 503 });
    }
    const jar = await cookies();
    const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
    if (!session) return Response.json({ error: "Not authenticated." }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { device_id?: string };
    const deviceId = (body.device_id ?? "").trim();
    if (!deviceId) {
      return Response.json({ error: "A device_id is required." }, { status: 400 });
    }
    const response = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/pair`, {
      method: "DELETE",
      cache: "no-store",
      signal: cosmosDeadlineSignal(),
      headers: { "content-type": "application/json", ...adminAuthHeaders() },
      // The expected owner is session-derived. The browser cannot release a
      // claim belonging to another account, even with a guessed device id.
      body: JSON.stringify({ device_id: deviceId, account_sub: session.sub }),
    }).catch(() => null);
    if (!response) return Response.json({ error: "Pin services are unavailable." }, { status: 503 });
    if (!response.ok) {
      return Response.json({ error: "The device claim could not be removed." }, { status: response.status });
    }
    const result = (await response.json()) as { removed?: boolean };
    return Response.json({ ok: result.removed === true, removed: result.removed === true });
  } catch {
    return Response.json({ error: "The device claim could not be removed." }, { status: 503 });
  }
}
