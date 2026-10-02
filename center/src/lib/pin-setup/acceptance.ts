import type {
  ConfirmSetupAcceptanceRequest,
} from "@/lib/pin-device";

const RELEASE_ID = /^[0-9a-f]{64}$/u;

function canonicalIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255 ||
        String(octet) !== parts[index],
    )
  ) {
    return null;
  }
  return octets.join(".");
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

export interface SetupAcceptanceTarget {
  readonly deviceSerial: string;
  readonly releaseId: string;
  readonly releaseVersion: string;
  readonly edgeIpv4: string;
}

export function setupAcceptanceTarget(
  serial: string | null,
  releaseId: string | null,
  releaseVersion: string | null,
  edgeIpv4: string | null,
): SetupAcceptanceTarget | null {
  const deviceSerial = serial?.trim().toUpperCase() ?? "";
  const version = releaseVersion?.trim() ?? "";
  const edge = edgeIpv4?.trim() ?? "";
  if (
    !deviceSerial ||
    deviceSerial.length > 128 ||
    !/^[A-Z0-9_-]+$/u.test(deviceSerial) ||
    !releaseId ||
    !RELEASE_ID.test(releaseId) ||
    !version ||
    version.length > 64 ||
    canonicalIpv4(edge) !== edge
  ) {
    return null;
  }
  return {
    deviceSerial,
    releaseId,
    releaseVersion: version,
    edgeIpv4: edge,
  };
}

export function setupAcceptanceRequest(
  target: SetupAcceptanceTarget,
): ConfirmSetupAcceptanceRequest {
  return {
    schema_version: 1,
    device_serial: target.deviceSerial,
    release_id: target.releaseId,
    release_version: target.releaseVersion,
    edge_ipv4: target.edgeIpv4,
    checks: {
      microphone: true,
      speaker: true,
      gesture: true,
    },
  };
}

export function setupAcceptanceConfirmed(
  response: unknown,
  target: SetupAcceptanceTarget | null,
): boolean {
  if (!target) return false;
  const body = object(response);
  const current = object(body?.current);
  const confirmation = object(body?.confirmation);
  return body?.schema_version === 1 &&
    current?.device_serial === target.deviceSerial &&
    current.release_version === target.releaseVersion &&
    current.edge_ipv4 === target.edgeIpv4 &&
    confirmation?.schema_version === 1 &&
    confirmation.device_serial === target.deviceSerial &&
    confirmation.release_id === target.releaseId &&
    confirmation.release_version === target.releaseVersion &&
    confirmation.edge_ipv4 === target.edgeIpv4 &&
    Number.isSafeInteger(confirmation.confirmed_at_epoch_ms) &&
    Number(confirmation.confirmed_at_epoch_ms) > 0;
}
