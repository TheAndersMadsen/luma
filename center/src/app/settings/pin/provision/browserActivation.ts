import type { AdbSessionTransport } from "@/lib/pin-device/adb/transport";
import { PinApiError, type PinClient } from "@/lib/pin-device/client";
import {
  clearCosmosIdentity,
  CosmosIdentityRefusedError,
  CosmosIdentityUnavailableError,
  deactivateCosmosIdentity,
} from "@/lib/pin-device/cosmosIdentity";
import { UsbBridgeUnavailableError } from "@/lib/pin-device/usbTransport";
import type { ActivationBundle } from "./types";

const PROVIDER_URI = "content://com.penumbraos.server.cosmosidentity";
const STAGING_URI = "content://com.penumbraos.server.cosmosidentity/attestation.json";
const API_ENDPOINT = "https://api.cosmos.humane.cloud";
const ONBOARDING_ENDPOINT = "https://onboarding.cosmos.humane.cloud";
const DEVICE_ID = /^[0-9a-f]+$/u;
const ENDPOINT_ID = /^[0-9a-f]{64}$/u;
const MAINTENANCE_URI = "content://com.penumbraos.server.maintenance";

/**
 * Stock's completed-original-setup flag, written by
 * `humane.experience.onboarding.node.WelcomeNode.launchHome` after a finished
 * onboarding. Nothing stock ever writes it back to "0", and stock
 * `OnboardingCoordinator.disableOnboarding` component-disables
 * `OnboardingHome` after any completed onboarding, so "1" means the stock
 * ceremony ran against some other credential issuer.
 */
const DUC_PROVISIONED_SETTING = "humane.settings.global.DUC_PROVISIONED";
/** Manifest activities of package `humane.experience.onboarding`, verified
 * against the decompiled stock manifest (`humane_onboarding/resources/
 * AndroidManifest.xml` in the stock reference). Only `OnboardingHome` is
 * component-disabled by stock `disableOnboarding`; `OnboardingExperience`
 * stays enabled and exported, so it starts directly. */
const ONBOARDING_EXPERIENCE_COMPONENT =
  "humane.experience.onboarding/humane.experience.onboarding.OnboardingExperience";

type BrowserBridgeStatus = {
  configured: boolean;
  connected: boolean;
  local_endpoint_id: string;
  device_id: string | null;
  remote_endpoint_id: string | null;
};

function bridgeStatus(value: unknown): BrowserBridgeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Center returned an invalid remote Pin status.");
  }
  const status = value as Record<string, unknown>;
  const localEndpointId = typeof status.local_endpoint_id === "string" ? status.local_endpoint_id : "";
  const deviceId = typeof status.device_id === "string" ? status.device_id : null;
  const remoteEndpointId = typeof status.remote_endpoint_id === "string" ? status.remote_endpoint_id : null;
  if (
    Object.keys(status).some((key) => !new Set([
      "configured",
      "connected",
      "local_endpoint_id",
      "device_id",
      "remote_endpoint_id",
    ]).has(key)) ||
    typeof status.configured !== "boolean" ||
    typeof status.connected !== "boolean" ||
    !ENDPOINT_ID.test(localEndpointId) ||
    (status.configured
      ? !deviceId || !DEVICE_ID.test(deviceId) || !remoteEndpointId || !ENDPOINT_ID.test(remoteEndpointId)
      : deviceId !== null || remoteEndpointId !== null || status.connected !== false)
  ) {
    throw new Error("Center returned an invalid remote Pin status.");
  }
  return {
    configured: status.configured,
    connected: status.connected,
    local_endpoint_id: localEndpointId,
    device_id: deviceId,
    remote_endpoint_id: remoteEndpointId,
  };
}

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
  const body = /^-----BEGIN CERTIFICATE-----\r?\n([0-9A-Za-z+/=\r\n]+)-----END CERTIFICATE-----\r?\n?$/u.exec(pem)?.[1];
  if (body === undefined) throw new Error("Cosmos returned an invalid activation certificate.");
  const binary = atob(body.replace(/[\r\n]/gu, ""));
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
  const body = /^Result: Bundle\[\{([\s\S]*)\}\]$/u.exec(output.trim())?.[1];
  if (body === undefined) throw new Error("The Pin returned an unreadable activation status.");
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

/**
 * Fail-safe false by design: this read only arms the enrollment guard, so an
 * unreadable answer must never break a working Pin's silent fast path.
 */
async function readDucProvisionedFlag(session: AdbSessionTransport): Promise<boolean> {
  try {
    const result = await session.shell(["settings", "get", "global", DUC_PROVISIONED_SETTING]);
    return result.exitCode === 0 && result.stdout.trim() === "1";
  } catch {
    return false;
  }
}

async function preflightConnectedPinActivation(
  session: AdbSessionTransport,
): Promise<{ deviceId: string; status: ActivationStatus; ducProvisioned: boolean }> {
  const deviceId = await connectedDeviceId(session);
  const unlocked = (await shell(
    session,
    ["getprop", "sys.user.0.ce_available"],
    "Center could not check whether the Pin is unlocked.",
  )).trim().toLowerCase();
  if (unlocked !== "1" && unlocked !== "true") {
    throw new Error("Unlock the Pin, then try again.");
  }

  const status = parseActivationStatus(await shell(
    session,
    ["content", "call", "--uri", PROVIDER_URI, "--method", "ACTIVATION_STATUS"],
    "Install the current Luma release on this Pin, then try again.",
  ));
  if (!status.ok) {
    throw new Error("Install the current Luma release on this Pin, then try again.");
  }
  return { deviceId, status, ducProvisioned: await readDucProvisionedFlag(session) };
}

/** What `verifyExistingActivation` rejected, in its own check order. */
function activationMismatchDetail(status: ActivationStatus): string {
  if (status.state !== "active") return `activation state ${status.state ?? "unknown"}`;
  if (!status.consistent || !status.managed) return "an incomplete activation record";
  if (!status.remoteGateEnabled) return "its remote access gate is disabled";
  if (!status.targetMatches) return "an activation record that does not match this Pin";
  if (!status.identityPresent || !status.identityUsable) return "an unusable Cosmos identity";
  if (status.edgeIpv4) return `edge IPv4 ${status.edgeIpv4}`;
  if (!status.fingerprintSha256 || !status.rootCertificateSha256) return "missing identity fingerprints";
  if (!status.apiEndpoint) return "a different Cosmos API endpoint";
  if (!status.onboardingEndpoint) return "a different onboarding endpoint";
  return `device status endpoint ${status.deviceStatusEndpoint ?? "unknown"}`;
}

/** The Pin is active, but not with this server's Cosmos identity. */
export class ActiveIdentityMismatchError extends Error {
  readonly status: ActivationStatus;

  constructor(status: ActivationStatus) {
    super(`This Pin is active with a different or incomplete Cosmos identity (${activationMismatchDetail(status)}).`);
    this.name = "ActiveIdentityMismatchError";
    this.status = status;
  }
}

/**
 * The Pin finished Humane's original setup (`DUC_PROVISIONED=1`) but has never
 * reported device-status to this server, so this server never issued its
 * DeviceUser credential: that credential is issued only by the stock ceremony,
 * and `OnboardingCoordinator.disableOnboarding` plus the flag itself mean the
 * ceremony cannot run again on its own. A normal activation would publish the
 * attestation handoff unconsumed and leave the Pin failing at every call.
 */
export class EnrollmentIncompleteError extends Error {
  readonly status: ActivationStatus;

  constructor(status: ActivationStatus) {
    super(
      "This Pin finished its original setup before this server could issue its credential. Run this Pin's original setup to connect it.",
    );
    this.name = "EnrollmentIncompleteError";
    this.status = status;
  }
}

function verifyExistingActivation(
  status: ActivationStatus,
  edgeIpv4: string | null,
  deviceStatusEndpoint: string | null,
): ActivationStatus {
  if (
    status.state !== "active" ||
    !status.consistent ||
    !status.managed ||
    !status.remoteGateEnabled ||
    !status.targetMatches ||
    !status.identityPresent ||
    !status.identityUsable ||
    status.edgeIpv4 !== canonicalIpv4(edgeIpv4) ||
    !status.fingerprintSha256 ||
    !status.rootCertificateSha256 ||
    status.apiEndpoint !== API_ENDPOINT ||
    status.onboardingEndpoint !== ONBOARDING_ENDPOINT ||
    status.deviceStatusEndpoint !== canonicalStatusEndpoint(deviceStatusEndpoint)
  ) {
    throw new ActiveIdentityMismatchError(status);
  }
  return status;
}

async function activatePreflightedPin(
  session: AdbSessionTransport,
  bundle: ActivationBundle,
  deviceId: string,
  edgeIpv4: string | null,
  deviceStatusEndpoint: string | null,
): Promise<ActivationStatus> {
  if (deviceId !== bundle.device_id.trim().toLowerCase()) {
    throw new Error("The activation identity does not match the connected Pin.");
  }

  const prepared = await buildActivationEnvelope(bundle, edgeIpv4, deviceStatusEndpoint);
  const staged = await session.shellWithInput(
    ["content", "write", "--uri", STAGING_URI],
    new Blob([JSON.stringify(prepared.envelope) + "\n"], { type: "application/json" }),
  );
  if (staged.exitCode !== 0) throw new Error("Install the current Luma release on this Pin, then try again.");

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

/** Center's remote link, as the browser reaches it (`/api/pin/bridge`). */
export type RemoteAccessOperations = {
  getBridgeStatus: () => Promise<unknown>;
  pairBridge: (input: { device_id: string; ticket: string; node_id: string }) => Promise<unknown>;
};

async function bridgeRequest(init: RequestInit | undefined, fallback: string): Promise<unknown> {
  const response = await fetch("/api/pin/bridge", { cache: "no-store", signal: AbortSignal.timeout(15_000), ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
    throw new Error(typeof error === "string" ? error : fallback);
  }
  return body;
}

/** `RemoteAccessOperations` over Center's own route, for the Pin console. */
export const centerRemoteAccess: RemoteAccessOperations = {
  getBridgeStatus: () => bridgeRequest(undefined, "Center could not prepare remote Pin access."),
  pairBridge: (input) => bridgeRequest(
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    "Center could not finish remote Pin access.",
  ),
};

/**
 * The Pin is paired with Cosmos and activated. Only remote access failed. A
 * retry verifies the activation it already has and repeats only this part.
 */
export class RemoteAccessSetupError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("This Pin is connected to Cosmos, but remote access could not be set up.");
    this.name = "RemoteAccessSetupError";
    this.reason = reason;
  }
}

/** INFERRED: HTTP readiness can precede the new Iroh endpoint after restart. */
async function waitForRemoteTicket(client: Pick<PinClient, "getIrohTicket">) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await client.getIrohTicket(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
    } catch (error) {
      const starting = error instanceof UsbBridgeUnavailableError ||
        (error instanceof PinApiError && error.status === 503);
      if (!starting) throw error;
      if (Date.now() >= deadline) {
        throw new Error("Remote access is still starting on the Pin. Keep it connected and try again shortly.");
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
  }
}

/**
 * Point Center's remote link at the Pin attached over USB: let the bridge's
 * endpoint in, restart the Pin's runtime so it listens, read its connection
 * ticket, and have Center pair and verify the link. Every step runs on the Pin
 * over USB (`client` must be the USB client), so it also repairs a link that
 * names a released or replaced Pin.
 */
export async function enableRemoteAccess(
  session: AdbSessionTransport,
  client: Pick<PinClient, "updateSettings" | "getIrohTicket">,
  operations: RemoteAccessOperations,
  deviceId: string,
): Promise<void> {
  const bridge = bridgeStatus(await operations.getBridgeStatus());
  await client.updateSettings({
    server: {
      iroh_remote_center_enabled: true,
      iroh_remote_center_allowed_peers: [bridge.local_endpoint_id],
    },
  });
  const restart = await session.shell([
    "content",
    "call",
    "--uri",
    MAINTENANCE_URI,
    "--method",
    "RESTART_RUNTIME",
  ]);
  const restartStatus = /(?:\{|,\s*)status=([0-9]{3})(?=,\s*|\}\])/u
    .exec(restart.stdout)?.[1];
  const restartOk = /(?:\{|,\s*)ok=true(?=,\s*|\}\])/u.test(restart.stdout);
  if (
    restart.exitCode !== 0 ||
    !restartOk ||
    !restartStatus ||
    Number(restartStatus) < 200 ||
    Number(restartStatus) > 299
  ) {
    throw new Error("The Pin saved its remote connection but could not restart it safely.");
  }
  const ticket = await waitForRemoteTicket(client);
  const paired = bridgeStatus(await operations.pairBridge({
    device_id: deviceId,
    ticket: ticket.ticket,
    node_id: ticket.node_id,
  }));
  if (
    !paired.configured ||
    !paired.connected ||
    paired.device_id !== deviceId ||
    paired.remote_endpoint_id !== ticket.node_id
  ) {
    throw new Error("Center saved this Pin but could not verify its remote connection.");
  }
}

/**
 * Readiness is proven before Cosmos mints the private key it never stores.
 * Pairing and activation come first and do not depend on remote access: a
 * server whose remote link is down, unset, or still names a replaced Pin can
 * still connect a Pin to Cosmos. Remote access follows as its own step.
 */
export async function provisionConnectedPin(
  session: AdbSessionTransport,
  client: Pick<PinClient, "updateSettings" | "getIrohTicket">,
  operations: RemoteAccessOperations & {
    /** True once this Pin has reported device-status to THIS server. */
    hasDeviceReported: () => Promise<boolean>;
    pairDevice: (deviceId: string) => Promise<void>;
    issueBundle: (deviceId: string) => Promise<ActivationBundle>;
  },
  edgeIpv4: string | null,
  deviceStatusEndpoint: string | null,
): Promise<ActivationStatus> {
  const preflight = await preflightConnectedPinActivation(session);
  const { deviceId } = preflight;
  // flag=1 + never-reported ⇒ this server never issued the credential and the
  // stock ceremony cannot run unaided. A thrown or unreadable answer is
  // fail-safe true: a working Pin keeps its silent fast path.
  if (preflight.ducProvisioned) {
    let reported: boolean;
    try {
      reported = await operations.hasDeviceReported();
    } catch {
      reported = true;
    }
    if (reported === false) throw new EnrollmentIncompleteError(preflight.status);
  }
  await operations.pairDevice(deviceId);
  const status = preflight.status.state === "active"
    ? verifyExistingActivation(preflight.status, edgeIpv4, deviceStatusEndpoint)
    : await activatePreflightedPin(
        session,
        await operations.issueBundle(deviceId),
        deviceId,
        edgeIpv4,
        deviceStatusEndpoint,
      );
  try {
    await enableRemoteAccess(session, client, operations, deviceId);
  } catch (error) {
    throw new RemoteAccessSetupError(error);
  }
  return status;
}

/**
 * Move a Pin that is active with a different Luma server to this one. The
 * deactivation is the device's journaled rollback
 * (`CosmosIdentityProvider.METHOD_DEACTIVATE` →
 * `CosmosActivationTransaction.deactivate`; wire codes `deactivated` and
 * `already_inactive`), and an incomplete rollback leaves the Pin exactly as it
 * was, so no new activation is written after one. Otherwise the leftover
 * identity material is cleared best-effort — the provider refuses CLEAR while
 * an activation record or the remote gate remains, and reactivation overwrites
 * it — and the normal provisioning path runs against the now-inactive Pin.
 */
export async function switchPinToThisServer(
  session: AdbSessionTransport,
  client: Pick<PinClient, "updateSettings" | "getIrohTicket">,
  operations: RemoteAccessOperations & {
    hasDeviceReported: () => Promise<boolean>;
    pairDevice: (deviceId: string) => Promise<void>;
    issueBundle: (deviceId: string) => Promise<ActivationBundle>;
  },
  edgeIpv4: string | null,
  deviceStatusEndpoint: string | null,
): Promise<ActivationStatus> {
  const preflight = await preflightConnectedPinActivation(session);
  if (preflight.status.state !== "active") {
    return provisionConnectedPin(session, client, operations, edgeIpv4, deviceStatusEndpoint);
  }
  const deactivated = await deactivateCosmosIdentity(session);
  if (!deactivated.rollbackComplete) {
    throw new Error(
      "This Pin could not restore its previous settings while disconnecting from its current server. Nothing was changed; try again or repair the Pin first.",
    );
  }
  try {
    await clearCosmosIdentity(session);
  } catch (error) {
    if (!(error instanceof CosmosIdentityRefusedError || error instanceof CosmosIdentityUnavailableError)) throw error;
  }
  return provisionConnectedPin(session, client, operations, edgeIpv4, deviceStatusEndpoint);
}

/** Activation succeeded, but the stock setup screen did not open for the ceremony. */
export class OnboardingLaunchError extends Error {
  readonly status: ActivationStatus;

  constructor(status: ActivationStatus) {
    super(
      "This Pin is connected to your server, but its setup screen didn't open. Restart the Pin and finish setup in Guided setup.",
    );
    this.name = "OnboardingLaunchError";
    this.status = status;
  }
}

/**
 * Replay the stock onboarding ceremony against this server for a Pin whose
 * `DUC_PROVISIONED` flag predates it. Stock wrote that flag when its original
 * setup completed and component-disabled `OnboardingHome`
 * (`OnboardingCoordinator.disableOnboarding`), and Ironman's provisioning
 * never references the flag, so a plain activation would publish the
 * attestation handoff to an app that cannot run. The replay: deactivate (the
 * handoff is republished only by a fresh activation, never by the
 * already-active verify path), set the flag to a readable "0" (the activation
 * transaction reads it and fails closed on null), run the normal activation,
 * then start the still-enabled, exported `OnboardingExperience` directly —
 * shell cannot re-enable a component (`pm enable` answers SecurityException:
 * Shell cannot change component state), and the experience does not need its
 * disabled HOME redirect. Luma's on-device automation
 * (`CosmosOnboardingAutomation`) then drives the stock OPAQUE login with the
 * passcode the wearer re-enters in Guided setup stage 6. Stock
 * `WelcomeNode.launchHome` writes the flag back to "1" and re-disables
 * `OnboardingHome` when the ceremony completes.
 */
export async function reenrollConnectedPin(
  session: AdbSessionTransport,
  client: Pick<PinClient, "updateSettings" | "getIrohTicket">,
  operations: RemoteAccessOperations & {
    hasDeviceReported: () => Promise<boolean>;
    pairDevice: (deviceId: string) => Promise<void>;
    issueBundle: (deviceId: string) => Promise<ActivationBundle>;
  },
  edgeIpv4: string | null,
  deviceStatusEndpoint: string | null,
): Promise<ActivationStatus> {
  const preflight = await preflightConnectedPinActivation(session);
  if (preflight.status.state === "active") {
    const deactivated = await deactivateCosmosIdentity(session);
    if (!deactivated.rollbackComplete) {
      throw new Error(
        "This Pin could not restore its previous settings. Nothing was changed; try again.",
      );
    }
    try {
      await clearCosmosIdentity(session);
    } catch (error) {
      if (!(error instanceof CosmosIdentityRefusedError || error instanceof CosmosIdentityUnavailableError)) throw error;
    }
  }
  const rearmFailure = "Center couldn't re-arm this Pin's original setup. Nothing was changed; try again.";
  await shell(session, ["settings", "put", "global", DUC_PROVISIONED_SETTING, "0"], rearmFailure);
  // The activation transaction reads this value; it must be a readable "0",
  // not an unset key.
  if ((await shell(session, ["settings", "get", "global", DUC_PROVISIONED_SETTING], rearmFailure)).trim() !== "0") {
    throw new Error(rearmFailure);
  }
  const status = await provisionConnectedPin(session, client, operations, edgeIpv4, deviceStatusEndpoint);
  try {
    await shell(session, ["am", "start", "-n", ONBOARDING_EXPERIENCE_COMPONENT], "Center could not open this Pin's setup screen.");
  } catch {
    throw new OnboardingLaunchError(status);
  }
  return status;
}
