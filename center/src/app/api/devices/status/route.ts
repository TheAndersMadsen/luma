import { cookies } from "next/headers";
import { AUTH_ENABLED, SESSION_COOKIE, verifySession } from "@/server/auth";
import {
  CARRY_ADMIN_ENABLED,
  CARRY_WEBAPI,
  adminAuthHeaders,
  carryDeadlineSignal,
} from "@/server/cosmos";
import { logWarn } from "@/server/log";

type Pairing = {
  device_id?: string;
  account_sub?: string;
};

/**
 * Restored Center addition: read certificate-signed status for the logged-in
 * wearer's paired Pins. The backend admin token remains server-side and the
 * account partition is always derived from the signed session.
 *
 * `state` is the whole contract with the page, so it has to be earned. This used
 * to answer `state: "live"` unconditionally while dropping every device it could
 * not read, which produced a page that contradicted itself: the status section
 * said "Pair a Pin below to see its status here" — because the device was
 * missing — beside a pairing section from a different route saying "1 Pin
 * paired". Four distinct upstream conditions collapsed into that one silent
 * drop (Cosmos answers 404 "Device is not paired.", 404 "No status has been
 * reported yet.", 503 "Status storage is unavailable." and rejects a wrong admin
 * token), and none of them left a line in any log on either side.
 *
 * So: a device we could not read is reported as `degraded` with a count, never
 * as an absence, and every drop names the device and what the backend actually
 * said.
 */
export async function GET() {
  try {
    if (!AUTH_ENABLED || !CARRY_ADMIN_ENABLED) {
      return Response.json({ devices: [], state: "absent" }, { status: 200 });
    }
    const jar = await cookies();
    const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
    if (!session) return Response.json({ error: "Not authenticated." }, { status: 401 });

    const rosterResponse = await fetch(`${CARRY_WEBAPI}/demo-api/admin/devices`, {
      cache: "no-store",
      signal: carryDeadlineSignal(),
      headers: adminAuthHeaders(),
    }).catch((error: unknown) => {
      logWarn("devices/status: the paired-device roster could not be requested", error);
      return null;
    });
    if (!rosterResponse?.ok) {
      // A roster we could not read is not an empty roster. Say which it was —
      // an admin-token rejection (403) and a backend outage (503) need
      // different people, and both used to arrive as the same blank list.
      if (rosterResponse) {
        logWarn(
          `devices/status: the paired-device roster answered ${rosterResponse.status}, so no Pin status could be read`,
        );
      }
      return Response.json({ devices: [], state: "degraded" }, { status: 200 });
    }
    const roster = (await rosterResponse.json()) as { pairings?: Pairing[] };
    const deviceIds = (roster.pairings ?? [])
      .filter((pairing) => pairing.account_sub === session.sub && pairing.device_id)
      .map((pairing) => pairing.device_id as string);

    const devices = (
      await Promise.all(
        deviceIds.map(async (deviceId) => {
          // The device id is already in this URL and in the pairing pane; it is
          // an identifier, not a secret, and without it a log line cannot say
          // WHICH Pin went quiet on a wearer who has two.
          const response = await fetch(
            `${CARRY_WEBAPI}/demo-api/admin/device-status/${encodeURIComponent(deviceId)}`,
            // Per DEVICE, so one Pin that never answers cannot hold the whole
            // roster past the deadline and turn "1 of your 2 Pins could not be
            // read" into a page that simply never loads.
            { cache: "no-store", headers: adminAuthHeaders(), signal: carryDeadlineSignal() },
          ).catch((error: unknown) => {
            logWarn(`devices/status: ${deviceId} status request failed`, error);
            return null;
          });
          if (!response) return null;
          if (!response.ok) {
            logWarn(`devices/status: ${deviceId} status answered ${response.status}`);
            return null;
          }
          return response.json().catch((error: unknown) => {
            logWarn(`devices/status: ${deviceId} status was not readable JSON`, error);
            return null;
          });
        }),
      )
    ).filter((status) => status !== null);

    // Every paired Pin we were asked about and could not answer for. Zero of
    // these is the only thing that makes this response "live".
    const unread = deviceIds.length - devices.length;
    return Response.json({
      devices,
      state: unread > 0 ? "degraded" : "live",
      // Named rather than implied, so the page can eventually say "1 of your 2
      // Pins could not be read" instead of quietly showing one.
      ...(unread > 0 ? { unread } : {}),
    });
  } catch (error) {
    logWarn("devices/status: no Pin status could be read", error);
    return Response.json({ devices: [], state: "degraded" }, { status: 200 });
  }
}
