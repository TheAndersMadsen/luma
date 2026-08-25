import type { AdbSessionTransport } from "@/lib/pin-device/adb/transport";
import type { ActivationBundle } from "./types";

const PROVIDER_URI = "content://com.penumbraos.server.cosmosidentity";
const STAGING_URI = "content://com.penumbraos.server.cosmosidentity/attestation.json";
const API_ENDPOINT = "https://api.cosmos.humane.cloud";
const ONBOARDING_ENDPOINT = "https://onboarding.cosmos.humane.cloud";
const DEVICE_ID = /^[0-9a-f]+$/u;

type ActivationEnvelope = {
  api_endpoint: typeof API_ENDPOINT;
  onboarding_endpoint: typeof ONBOARDING_ENDPOINT;
  device_status_endpoint: string;
  edge_ipv4: string;
  device_id: string;
  certificate_pem: string;
  private_key_pem: string;
  ca_certificate_pem: string;
  root_certificate_der_b64: string;
};

export type ActivationStatus = {
  ok: boolean;
  state: string | null;
  consistent: boolean;
  managed: boolean;
  remoteGateEnabled: boolean;
  targetMatches: boolean;
  identityPresent: boolean;
  identityUsable: boolean;
  edgeIpv4: string | null;
  fingerprintSha256: string | null;
  rootCertificateSha256: string | null;
  apiEndpoint: string | null;
  onboardingEndpoint: string | null;
  deviceStatusEndpoint: string | null;
};

function canonicalIpv4(value: string | null): string {
  const parts = value?.split(".") ?? [];
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255)
  ) throw new Error("Cosmos needs a public device edge IPv4 address before activation.");
  return parts.join(".");
}

function canonicalStatusEndpoint(value: string | null): string {
  let parsed: URL;
  try {
    parsed = new URL(value ?? "");
  } catch {
    throw new Error("Cosmos needs a valid device status endpoint before activation.");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.pathname !== "/device-status/v1/report" ||
    parsed.search ||
    parsed.hash
  ) throw new Error("Cosmos needs a valid device status endpoint before activation.");
  return `https://${parsed.hostname.toLowerCase()}/device-status/v1/report`;
}

function certificateDer(pem: string): Uint8Array {
  const match = /^-----BEGIN CERTIFICATE-----\r?\n([0-9A-Za-z+/=\r\n]+)-----END CERTIFICATE-----\r?\n?$/u.exec(pem);
  if (!match) throw new Error("Cosmos returned an invalid activation certificate.");
  const binary = atob(match[1].replace(/[\r\n]/gu, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function derBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function buildActivationEnvelope(
  bundle: ActivationBundle,
  edgeIpv4: string | null,
  deviceStatusEndpoint: string | null,
): Promise<{
  envelope: ActivationEnvelope;
  fingerprintSha256: string;
  rootFingerprintSha256: string;
}> {
  const deviceId = bundle.device_id.trim().toLowerCase();
  if (!DEVICE_ID.test(deviceId)) throw new Error("Cosmos returned an invalid device ID.");
  const leaf = certificateDer(bundle.certificate_pem);
  const root = certificateDer(bundle.root_certificate_pem);
  return {
    envelope: {
      api_endpoint: API_ENDPOINT,
      onboarding_endpoint: ONBOARDING_ENDPOINT,
      device_status_endpoint: canonicalStatusEndpoint(deviceStatusEndpoint),
      edge_ipv4: canonicalIpv4(edgeIpv4),
      device_id: deviceId,
      certificate_pem: bundle.certificate_pem,
      private_key_pem: bundle.private_key_pem,
      ca_certificate_pem: bundle.ca_certificate_pem,
      root_certificate_der_b64: derBase64(root),
    },
    fingerprintSha256: await sha256(leaf),
    rootFingerprintSha256: await sha256(root),
  };
}

export function parseActivationStatus(output: string): ActivationStatus {
  const match = /^Result: Bundle\[\{([\s\S]*)\}\]$/u.exec(output.trim());
  if (!match) throw new Error("The Pin returned an unreadable activation status.");
  const body = match[1];
  const read = (name: string, pattern: string) =>
    new RegExp(`(?:^|,\\s*)${name}=(${pattern})(?=,\\s*|$)`, "u").exec(body)?.[1] ?? null;
  return {
    ok: read("ok", "true|false") === "true",
    state: read("state", "[a-z_]+"),
    consistent: read("consistent", "true|false") === "true",
    managed: read("managed", "true|false") === "true",
    remoteGateEnabled: read("remote_gate_enabled", "true|false") === "true",
    targetMatches: read("target_matches", "true|false") === "true",
    identityPresent: read("present", "true|false") === "true",
    identityUsable: read("identity_usable", "true|false") === "true",
    edgeIpv4: read("edge_ipv4", "[0-9.]+"),
    fingerprintSha256: read("fingerprint_sha256", "[0-9a-fA-F]{64}")?.toLowerCase() ?? null,
    rootCertificateSha256: read("root_certificate_sha256", "[0-9a-fA-F]{64}")?.toLowerCase() ?? null,
    apiEndpoint: read("api_endpoint", "https://api\\.cosmos\\.humane\\.cloud"),
    onboardingEndpoint: read("onboarding_endpoint", "https://onboarding\\.cosmos\\.humane\\.cloud"),
    deviceStatusEndpoint: read("device_status_endpoint", "https://[A-Za-z0-9.-]+/device-status/v1/report"),
  };
}

async function shell(session: AdbSessionTransport, command: readonly string[], message: string) {
  const result = await session.shell(command);
  if (result.exitCode !== 0) throw new Error(message);
  return result.stdout;
}

export async function connectedDeviceId(session: AdbSessionTransport): Promise<string> {
  const deviceId = (await shell(
    session,
    ["getprop", "ro.boot.deviceid"],
    "Center could not read this Pin's device ID.",
  )).trim().toLowerCase();
  if (!DEVICE_ID.test(deviceId)) throw new Error("This Pin did not report a valid device ID.");
  return deviceId;
}

export async function activateConnectedPin(
  session: AdbSessionTransport,
  bundle: ActivationBundle,
  edgeIpv4: string | null,
  deviceStatusEndpoint: string | null,
): Promise<ActivationStatus> {
  const deviceId = await connectedDeviceId(session);
  if (deviceId !== bundle.device_id.trim().toLowerCase()) {
    throw new Error("The activation identity does not match the connected Pin.");
  }
  const unlocked = (await shell(
    session,
    ["getprop", "sys.user.0.ce_available"],
    "Center could not check whether the Pin is unlocked.",
  )).trim().toLowerCase();
  if (unlocked !== "1" && unlocked !== "true") {
    throw new Error("Unlock the Pin, then try again.");
  }

  const prepared = await buildActivationEnvelope(bundle, edgeIpv4, deviceStatusEndpoint);
  const staged = await session.shellWithInput(
    ["content", "write", "--uri", STAGING_URI],
    new Blob([JSON.stringify(prepared.envelope) + "\n"], { type: "application/json" }),
  );
  if (staged.exitCode !== 0) throw new Error("Install the current Revival release on this Pin, then try again.");

  const activation = parseActivationStatus(await shell(
    session,
    ["content", "call", "--uri", PROVIDER_URI, "--method", "ACTIVATE"],
    "The Pin did not accept its Cosmos identity.",
  ));
  if (!activation.ok || !["activated", "already_active"].includes(activation.state ?? "")) {
    throw new Error("The Pin did not accept its Cosmos identity.");
  }

  const status = parseActivationStatus(await shell(
    session,
    ["content", "call", "--uri", PROVIDER_URI, "--method", "ACTIVATION_STATUS"],
    "Center could not verify activation on the Pin.",
  ));
  const expectedStatusEndpoint = canonicalStatusEndpoint(deviceStatusEndpoint);
  if (
    !status.ok ||
    status.state !== "active" ||
    !status.consistent ||
    !status.managed ||
    !status.remoteGateEnabled ||
    !status.targetMatches ||
    !status.identityPresent ||
    !status.identityUsable ||
    status.edgeIpv4 !== prepared.envelope.edge_ipv4 ||
    status.fingerprintSha256 !== prepared.fingerprintSha256 ||
    status.rootCertificateSha256 !== prepared.rootFingerprintSha256 ||
    status.apiEndpoint !== API_ENDPOINT ||
    status.onboardingEndpoint !== ONBOARDING_ENDPOINT ||
    status.deviceStatusEndpoint !== expectedStatusEndpoint
  ) throw new Error("Activation finished, but the Pin did not verify the requested Cosmos identity.");
  return status;
}
