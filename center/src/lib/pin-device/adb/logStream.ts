export type DeviceLogLine = {
  readonly id: string;
  readonly timestamp: string;
  readonly text: string;
};

export function createDeviceLogLine(text: string): DeviceLogLine {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    text,
  };
}
