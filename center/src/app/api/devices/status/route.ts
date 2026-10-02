import type { DeviceAssignment } from "@/lib/contracts/account";
import type { DeviceStatus } from "@/lib/contracts/deviceStatus";
import { AUTH_ENABLED } from "@/server/auth";
import { getDevices } from "@/server/domain/account";
import { logWarn } from "@/server/log";

/**
 * The status each of the signed-in wearer's Pins last reported, read from
 * Cosmos's `GET /device-assignments/devices` on the wearer's own web identity.
 * Cosmos scopes the list to that wearer. Center holds no admin token for it and
 * filters nothing.
 *
 * `state` is the whole contract with the page, so it has to be earned:
 *
 * - `absent`: no signed-in wearer can exist here (login is off), so there is
 *   no account to list Pins for.
 * - `degraded`: Cosmos did not answer, or answered for a Pin whose stored
 *   status it could not read. The latter is counted in `unread`, so a wearer
 *   with two Pins is told one is missing rather than shown one.
 * - `live`: every paired Pin that has reported is here.
 */
export async function GET() {
  if (!AUTH_ENABLED) return Response.json({ devices: [], state: "absent" });
  const result = await getDevices();
  if (result.state === "absent") return Response.json({ devices: [], state: "absent" });
  if (result.state !== "live") {
    logWarn(`devices/status: the wearer's Pins could not be read: ${result.degraded ?? "no answer"}`);
    return Response.json({
      devices: [],
      state: "degraded",
      ...(result.reauthenticate ? { reauthenticate: true } : {}),
    });
  }
  const devices = result.data.flatMap((device) => {
    const status = reportedStatus(device);
    return status ? [status] : [];
  });
  // A Pin whose stored status Cosmos could not read is not a Pin that never
  // reported. Zero of these is the only thing that makes this response "live".
  const unread = result.data.filter((device) => device.statusUnreadable).length;
  if (unread > 0) logWarn(`devices/status: ${unread} Pin status report(s) could not be read`);
  return Response.json({
    devices,
    state: unread > 0 ? "degraded" : "live",
    ...(unread > 0 ? { unread } : {}),
  });
}

/** One reported status in the page's `DeviceStatus` contract. */
function reportedStatus(device: DeviceAssignment): DeviceStatus | null {
  const status = device.status;
  if (!status) return null;
  const reportedAt = Date.parse(status.reportedAt);
  if (Number.isNaN(reportedAt)) return null;
  return {
    device_id: device.deviceId,
    serial_number: device.serialNumber ?? "",
    firmware_version: status.firmwareVersion,
    os_version: status.osVersion,
    battery_percent: status.batteryPercent,
    battery_charging: status.batteryCharging,
    reported_at_epoch: reportedAt / 1000,
    wifi_networks: status.wifiNetworks.map((network) => ({
      ssid: network.ssid,
      authorization_type: network.authorizationType,
      connected: network.connected,
    })),
  };
}
