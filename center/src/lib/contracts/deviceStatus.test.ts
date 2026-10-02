import { describe, expect, it } from "vitest";
import { buildDeviceOverview, parseDeviceStatusResponse } from "./deviceStatus";

const status = {
  devices: [{
    device_id: "pin-1",
    serial_number: "SERIAL",
    firmware_version: "2.1",
    os_version: "1.4",
    battery_percent: 72,
    battery_charging: true,
    reported_at_epoch: 1_000,
    wifi_networks: [{ ssid: "Home", connected: true }],
  }],
  state: "live",
};

describe("device status contract", () => {
  it("validates the wire response and builds only reported capabilities", () => {
    const parsed = parseDeviceStatusResponse(status);
    expect(buildDeviceOverview(parsed.devices[0]!, 1_100).map((item) => item.key)).toEqual([
      "connection",
      "power",
      "network",
      "software",
    ]);
  });

  it("rejects malformed status instead of rendering guessed values", () => {
    expect(() => parseDeviceStatusResponse({ devices: [{}], state: "live" })).toThrow();
  });
});
