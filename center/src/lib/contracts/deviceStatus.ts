export interface ReportedWifiNetwork {
  readonly ssid: string;
  readonly authorization_type?: string;
  readonly connected?: boolean;
}

export interface DeviceStatus {
  readonly device_id: string;
  readonly serial_number: string;
  readonly firmware_version: string;
  readonly os_version: string;
  readonly battery_percent: number;
  readonly battery_charging: boolean;
  readonly reported_at_epoch: number;
  readonly wifi_networks: readonly ReportedWifiNetwork[];
}

export interface DeviceStatusResponse {
  readonly devices: readonly DeviceStatus[];
  readonly state: "live" | "absent" | "degraded";
  readonly unread?: number;
}

export interface DeviceOverviewItem {
  readonly key: "connection" | "power" | "network" | "software";
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly tone: "live" | "warning" | "neutral";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Device status response is not an object.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Device status ${field} is invalid.`);
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Device status ${field} is invalid.`);
  }
  return value;
}

function parseNetwork(value: unknown): ReportedWifiNetwork {
  const data = record(value);
  return {
    ssid: string(data.ssid, "wifi_networks.ssid"),
    authorization_type:
      typeof data.authorization_type === "string" ? data.authorization_type : undefined,
    connected: typeof data.connected === "boolean" ? data.connected : undefined,
  };
}

function parseDevice(value: unknown): DeviceStatus {
  const data = record(value);
  if (!Array.isArray(data.wifi_networks)) {
    throw new Error("Device status wifi_networks is invalid.");
  }
  return {
    device_id: string(data.device_id, "device_id"),
    serial_number: string(data.serial_number, "serial_number"),
    firmware_version: string(data.firmware_version, "firmware_version"),
    os_version: string(data.os_version, "os_version"),
    battery_percent: number(data.battery_percent, "battery_percent"),
    battery_charging: data.battery_charging === true,
    reported_at_epoch: number(data.reported_at_epoch, "reported_at_epoch"),
    wifi_networks: data.wifi_networks.map(parseNetwork),
  };
}

export function parseDeviceStatusResponse(value: unknown): DeviceStatusResponse {
  const data = record(value);
  if (!Array.isArray(data.devices)) throw new Error("Device status devices is invalid.");
  if (data.state !== "live" && data.state !== "absent" && data.state !== "degraded") {
    throw new Error("Device status state is invalid.");
  }
  return {
    devices: data.devices.map(parseDevice),
    state: data.state,
    unread:
      typeof data.unread === "number" && Number.isFinite(data.unread)
        ? Math.max(0, Math.floor(data.unread))
        : undefined,
  };
}

/** Build only the overview cards supported by fields this Pin reported. */
export function buildDeviceOverview(
  device: DeviceStatus,
  nowEpoch = Date.now() / 1000,
): readonly DeviceOverviewItem[] {
  const online = nowEpoch - device.reported_at_epoch < 10 * 60;
  const connectedNetwork = device.wifi_networks.find((network) => network.connected);
  const software = [device.os_version, device.firmware_version].filter(Boolean).join(" · ");

  return [
    {
      key: "connection",
      label: "Connection",
      value: online ? "Online" : "Not reporting",
      detail: `Updated ${new Date(device.reported_at_epoch * 1000).toLocaleString()}`,
      tone: online ? "live" : "warning",
    },
    {
      key: "power",
      label: "Battery",
      value: `${Math.round(device.battery_percent)}%`,
      detail: device.battery_charging ? "Charging" : undefined,
      tone: device.battery_percent <= 20 ? "warning" : "neutral",
    },
    ...(connectedNetwork
      ? [{
          key: "network" as const,
          label: "Wi-Fi",
          value: connectedNetwork.ssid,
          detail: "Connected",
          tone: "live" as const,
        }]
      : []),
    ...(software
      ? [{
          key: "software" as const,
          label: "Software",
          value: software,
          tone: "neutral" as const,
        }]
      : []),
  ];
}
