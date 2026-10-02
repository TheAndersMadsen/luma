import type { DeviceAssignment, PairedPin, PairedPins } from "@/lib/contracts/account";
import { AUTH_ENABLED, isSameOriginRequest, SESSION_COOKIE, verifySession } from "@/server/auth";
import {
  defaultPreferredName,
  getDevices,
  pairDevice,
  PIN_PAIRED_ELSEWHERE,
  unpairDevice,
} from "@/server/domain/account";
import type { Sourced } from "@/server/domain/provenance";
import { logWarn } from "@/server/log";
import { cookies } from "next/headers";
import { sessionExpiredResponse } from "@/server/routeErrors";

/**
 * GET, the signed-in wearer's own paired Pins, read from Cosmos's
 * `GET /device-assignments/devices` on the wearer's own web identity (Cosmos
 * scopes the list. No admin token, no filtering here). Each carries whether it
 * is in block mode. `unpairedBlocked` lists Pins still in block mode after
 * their pairing was removed, so block mode can always be turned off.
 */
export async function GET() {
  if (!AUTH_ENABLED) {
    return Response.json({ error: "Login is not configured on this deployment." }, { status: 503 });
  }
  const result = await getDevices();
  if (result.reauthenticate) {
    return sessionExpiredResponse();
  }
  if (result.state === "absent") {
    return Response.json(
      { error: "Device pairing is not configured on this deployment." },
      { status: 503 },
    );
  }
  if (result.state !== "live") {
    return Response.json({ error: "Couldn’t load paired Pins." }, { status: 503 });
  }
  const pin = (device: DeviceAssignment): PairedPin => ({
    deviceId: device.deviceId,
    pairedAt: device.pairedAt ? Date.parse(device.pairedAt) / 1000 : null,
    blocked: device.blocked,
    blockedAt: device.blockedAt ?? null,
  });
  return Response.json({
    devices: result.data.filter((device) => device.pairedAt).map(pin),
    unpairedBlocked: result.data.filter((device) => !device.pairedAt && device.blocked).map(pin),
  } satisfies PairedPins);
}

/** The status and sentence for a pairing write Cosmos did not complete. */
function refused(result: Sourced<unknown>, fallback: string): Response {
  if (result.reauthenticate) {
    return sessionExpiredResponse();
  }
  if (result.refusal === "conflict") {
    return Response.json({ error: PIN_PAIRED_ELSEWHERE }, { status: 409 });
  }
  if (result.refusal === "invalid") {
    return Response.json({ error: "That is not a Pin's device ID." }, { status: 400 });
  }
  if (result.state === "absent") {
    return Response.json(
      { error: "Device pairing is not configured on this deployment." },
      { status: 503 },
    );
  }
  return Response.json({ error: fallback }, { status: 502 });
}

/** The signed-in session and a same-origin request, or the refusal to send. */
async function wearerRequest(request: Request) {
  if (!AUTH_ENABLED) {
    return {
      refusal: Response.json({ error: "Login is not configured on this deployment." }, { status: 503 }),
    };
  }
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return { refusal: Response.json({ error: "Not authenticated." }, { status: 401 }) };
  if (!isSameOriginRequest(request)) {
    return {
      refusal: Response.json({ error: "A same-origin request is required." }, { status: 403 }),
    };
  }
  return { session };
}

/** A Pin's device ID, as DELETE has always required and Cosmos's roster holds. */
const PIN_DEVICE_ID = /^[0-9a-fA-F]{1,64}$/u;

/** The `device_id` a pairing write names, or `null`. */
async function requestedDeviceId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as { device_id?: unknown } | null;
  const deviceId = typeof body?.device_id === "string" ? body.device_id.trim() : "";
  return deviceId || null;
}

/**
 * POST /api/devices/pair, claim a Pin for the signed-in wearer. Body:
 * `{ device_id }`.
 *
 * Cosmos's `POST /device-assignments/devices` is called with the wearer's own
 * identity, so the account the Pin joins is the caller's and never a request
 * field, and Center holds no operator token for it. A Pin another account holds
 * answers 409. Pairing decides *whose* account a Pin enrolls into. The passcode
 * the owner set decides *whether* it may.
 *
 * Every branch is a sentence a wearer can read and none of them 500s: a thrown
 * error here would surface as a crash in a settings pane.
 */
export async function POST(request: Request) {
  try {
    const gate = await wearerRequest(request);
    if (!gate.session) return gate.refusal;
    const deviceId = await requestedDeviceId(request);
    if (!deviceId) {
      return Response.json({ error: "A device_id is required." }, { status: 400 });
    }
    if (!PIN_DEVICE_ID.test(deviceId)) {
      return Response.json({ error: "That is not a Pin's device ID." }, { status: 400 });
    }
    const paired = await pairDevice(deviceId);
    if (paired.state !== "live" || !paired.data?.paired) {
      return refused(paired, "This Pin couldn’t be paired.");
    }

    // Best-effort: the pairing already succeeded and is never undone for this.
    const named = await defaultPreferredName(gate.session.name, gate.session.email);
    if (named.state !== "live") {
      logWarn(`devices/pair: the preferred name could not be set: ${named.degraded ?? "no answer"}`);
    }
    return Response.json({ ok: true, device_id: paired.data.deviceId });
  } catch {
    // Session decryption, cookie access, anything else: report it, never crash
    // the pane that called us.
    return Response.json({ error: "The pairing could not be completed." }, { status: 503 });
  }
}

/**
 * DELETE /api/devices/pair, release one of the signed-in wearer's own Pins.
 * Cosmos compares the holder against the wearer's own identity, so a guessed
 * device id can never release another account's Pin.
 */
export async function DELETE(request: Request) {
  try {
    const gate = await wearerRequest(request);
    if (!gate.session) return gate.refusal;
    const deviceId = await requestedDeviceId(request);
    if (!deviceId) {
      return Response.json({ error: "A device_id is required." }, { status: 400 });
    }
    if (!PIN_DEVICE_ID.test(deviceId)) {
      return Response.json({ error: "That is not a Pin's device ID." }, { status: 400 });
    }
    const released = await unpairDevice(deviceId);
    if (released.state !== "live" || !released.data) {
      return refused(released, "The device claim could not be removed.");
    }
    return Response.json({ ok: released.data.removed, removed: released.data.removed });
  } catch {
    return Response.json({ error: "The device claim could not be removed." }, { status: 503 });
  }
}
