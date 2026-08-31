import { readFile } from "node:fs/promises";

import type { Session } from "./auth";

const MAX_CONTROL_RESPONSE_BYTES = 32 * 1024;
const MAX_ROSTER_RESPONSE_BYTES = 256 * 1024;
const MAX_TICKET_BYTES = 16 * 1024;
const BRIDGE_TIMEOUT_MS = 20_000;
const CONTROL_TOKEN_MIN_BYTES = 32;
const CONTROL_TOKEN_MAX_BYTES = 512;
const DEVICE_ID = /^[0-9a-f]{8,64}$/u;
const ENDPOINT_ID = /^[0-9a-f]{64}$/u;
const PROTOCOL = "penumbra-remote-center-v1";

export type PinBridgeErrorCode =
  | "bridge_not_configured"
  | "bridge_unavailable"
  | "invalid_response"
  | "pin_not_paired"
  | "pin_binding_invalid"
  | "wrong_owner";

export class PinBridgeError extends Error {
  readonly code: PinBridgeErrorCode;
  readonly status: number;

  constructor(code: PinBridgeErrorCode, status: number, message: string) {
    super(message);
    this.name = "PinBridgeError";
    this.code = code;
    this.status = status;
  }
}

export type PinBridgeStatus = {
  schemaVersion: 1;
  localEndpointId: string;
  configured: boolean;
  deviceId: string | null;
  remoteEndpointId: string | null;
  connected: boolean;
  generation: number;
  protocol: typeof PROTOCOL;
};

export type PinBridgeAssignment = PinBridgeStatus & {
  configured: true;
  deviceId: string;
  remoteEndpointId: string;
  ownerSub: string;
};

type Pairing = { deviceId: string; ownerSub: string };

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(BRIDGE_TIMEOUT_MS)])
    : AbortSignal.timeout(BRIDGE_TIMEOUT_MS);
}

function normalizedOrigin(value: string | undefined, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value?.trim() ?? "");
  } catch {
    throw new PinBridgeError("bridge_not_configured", 503, `${label} is not configured.`);
  }
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PinBridgeError("bridge_not_configured", 503, `${label} is not configured.`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function bridgeOrigin(): string {
  return normalizedOrigin(process.env.REVIVAL_PIN_BRIDGE_URL, "Remote Pin access");
}

async function readBoundedJson(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredHeader!) || !Number.isSafeInteger(declared) || declared > maximum)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new PinBridgeError("invalid_response", 502, "Remote Pin access returned an invalid response.");
  }

  if (!response.body) {
    throw new PinBridgeError("invalid_response", 502, "Remote Pin access returned an invalid response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let readError: unknown;
  const cancelForAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", cancelForAbort, { once: true });
  if (signal?.aborted) cancelForAbort();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new PinBridgeError("invalid_response", 502, "Remote Pin access returned an invalid response.");
      }
      chunks.push(value);
    }
  } catch (error) {
    readError = error;
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  if (readError) throw readError;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PinBridgeError("invalid_response", 502, "Remote Pin access returned an invalid response.");
  }
}

async function controlToken(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const file = process.env.REVIVAL_PIN_BRIDGE_TOKEN_FILE?.trim() ?? "";
  if (!file) {
    throw new PinBridgeError("bridge_not_configured", 503, "Remote Pin access is not configured.");
  }
  let token = "";
  try {
    token = await readFile(file, { encoding: "utf8", signal });
  } catch {
    if (signal?.aborted) throw signal.reason;
  }
  signal?.throwIfAborted();
  token = token.trim();
  if (
    token.length < CONTROL_TOKEN_MIN_BYTES ||
    token.length > CONTROL_TOKEN_MAX_BYTES ||
    !/^[!-~]+$/u.test(token)
  ) {
    throw new PinBridgeError("bridge_not_configured", 503, "Remote Pin access is not configured.");
  }
  return token;
}

function parseBridgeStatus(value: unknown): PinBridgeStatus {
  const body = objectRecord(value);
  if (!body) {
    throw new PinBridgeError("invalid_response", 502, "Remote Pin access returned an invalid response.");
  }
  const allowed = new Set([
    "schema_version",
    "local_endpoint_id",
    "configured",
    "device_id",
    "remote_endpoint_id",
    "connected",
    "generation",
    "protocol",
  ]);
  const configured = body.configured;
  const localEndpointId = typeof body.local_endpoint_id === "string" ? body.local_endpoint_id : "";
  const deviceId = typeof body.device_id === "string" ? body.device_id : null;
  const remoteEndpointId = typeof body.remote_endpoint_id === "string" ? body.remote_endpoint_id : null;
  if (
    Object.keys(body).some((key) => !allowed.has(key)) ||
    body.schema_version !== 1 ||
    !ENDPOINT_ID.test(localEndpointId) ||
    typeof configured !== "boolean" ||
    typeof body.connected !== "boolean" ||
    !Number.isSafeInteger(body.generation) ||
    (body.generation as number) < 0 ||
    body.protocol !== PROTOCOL ||
    (configured
      ? !deviceId || !DEVICE_ID.test(deviceId) || !remoteEndpointId || !ENDPOINT_ID.test(remoteEndpointId)
      : deviceId !== null || remoteEndpointId !== null || body.connected !== false)
  ) {
    throw new PinBridgeError("invalid_response", 502, "Remote Pin access returned an invalid response.");
  }
  return {
    schemaVersion: 1,
    localEndpointId,
    configured,
    deviceId,
    remoteEndpointId,
    connected: body.connected,
    generation: body.generation as number,
    protocol: PROTOCOL,
  };
}

async function controlStatus(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PinBridgeStatus> {
  const deadline = requestSignal(signal);
  let response: Response | null = null;
  try {
    response = await fetchImpl(`${bridgeOrigin()}/__control/status`, {
      headers: { authorization: `Bearer ${await controlToken(deadline)}` },
      cache: "no-store",
      redirect: "error",
      signal: deadline,
    });
  } catch {
    if (deadline.aborted) throw deadline.reason;
  }
  deadline.throwIfAborted();
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    throw new PinBridgeError("bridge_unavailable", 503, "Remote Pin access is unavailable.");
  }
  return parseBridgeStatus(await readBoundedJson(response, MAX_CONTROL_RESPONSE_BYTES, deadline));
}

async function pairings(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Pairing[]> {
  const rosterBase = normalizedOrigin(process.env.COSMOS_WEBAPI_BASE_URL, "The Pin roster");
  const rosterToken = process.env.COSMOS_ADMIN_TOKEN?.trim() ?? "";
  if (!rosterToken) {
    throw new PinBridgeError("bridge_not_configured", 503, "Remote Pin access is not configured.");
  }
  const deadline = requestSignal(signal);
  let response: Response | null = null;
  try {
    response = await fetchImpl(`${rosterBase}/demo-api/admin/devices`, {
      headers: { authorization: `Bearer ${rosterToken}` },
      cache: "no-store",
      redirect: "error",
      signal: deadline,
    });
  } catch {
    if (deadline.aborted) throw deadline.reason;
  }
  deadline.throwIfAborted();
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    throw new PinBridgeError("bridge_unavailable", 503, "The paired Pin could not be confirmed.");
  }
  const decoded = objectRecord(await readBoundedJson(response, MAX_ROSTER_RESPONSE_BYTES, deadline));
  const values = Array.isArray(decoded?.pairings) ? decoded.pairings : null;
  if (!values) {
    throw new PinBridgeError("invalid_response", 502, "The paired Pin could not be confirmed.");
  }
  return values.flatMap((value) => {
    const pairing = objectRecord(value);
    const deviceId = typeof pairing?.device_id === "string" ? pairing.device_id : "";
    const ownerSub = typeof pairing?.account_sub === "string" ? pairing.account_sub.trim() : "";
    return DEVICE_ID.test(deviceId) && ownerSub && ownerSub.length <= 512 && !/\p{Cc}/u.test(ownerSub)
      ? [{ deviceId, ownerSub }]
      : [];
  });
}

function assignmentFrom(
  status: PinBridgeStatus,
  roster: Pairing[],
): PinBridgeAssignment {
  if (!status.configured || !status.deviceId || !status.remoteEndpointId) {
    throw new PinBridgeError("pin_not_paired", 409, "Connect an Ai Pin to Cosmos first.");
  }
  const matches = roster.filter((pairing) => pairing.deviceId === status.deviceId);
  if (matches.length !== 1) {
    throw new PinBridgeError("pin_binding_invalid", 409, "The remote Pin assignment is no longer valid.");
  }
  return {
    ...status,
    configured: true,
    deviceId: status.deviceId,
    remoteEndpointId: status.remoteEndpointId,
    ownerSub: matches[0].ownerSub,
  };
}

export async function activePinBridgeAssignment(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PinBridgeAssignment> {
  const [status, roster] = await Promise.all([
    controlStatus(fetchImpl, signal),
    pairings(fetchImpl, signal),
  ]);
  return assignmentFrom(status, roster);
}

export async function pinBridgeStatusForSession(
  session: Session,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PinBridgeStatus> {
  const status = await controlStatus(fetchImpl, signal);
  if (!status.configured) return status;
  const assignment = assignmentFrom(status, await pairings(fetchImpl, signal));
  if (assignment.ownerSub !== session.sub) {
    throw new PinBridgeError("wrong_owner", 403, "This Pin bridge belongs to another wearer.");
  }
  return assignment;
}

export async function requireOwnedPairedPin(
  session: Session,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PinBridgeAssignment> {
  const assignment = await activePinBridgeAssignment(fetchImpl, signal);
  if (assignment.ownerSub !== session.sub) {
    throw new PinBridgeError("wrong_owner", 403, "This Pin bridge belongs to another wearer.");
  }
  return assignment;
}

export async function pairPinBridge(
  session: Session,
  input: { deviceId: string; ticket: string; nodeId: string },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PinBridgeAssignment> {
  const deviceId = input.deviceId.trim().toLowerCase();
  const nodeId = input.nodeId.trim().toLowerCase();
  if (
    input.deviceId !== deviceId ||
    !DEVICE_ID.test(deviceId) ||
    input.nodeId !== nodeId ||
    !ENDPOINT_ID.test(nodeId) ||
    !input.ticket ||
    input.ticket.length > MAX_TICKET_BYTES ||
    !/^[!-~]+$/u.test(input.ticket)
  ) {
    throw new PinBridgeError("invalid_response", 400, "The Pin returned an invalid remote-connection ticket.");
  }

  const [before, roster] = await Promise.all([
    controlStatus(fetchImpl, signal),
    pairings(fetchImpl, signal),
  ]);
  const target = roster.filter((pairing) => pairing.deviceId === deviceId);
  if (target.length !== 1 || target[0].ownerSub !== session.sub) {
    throw new PinBridgeError("wrong_owner", 403, "This Pin is not paired with your account.");
  }
  if (before.configured) {
    const current = assignmentFrom(before, roster);
    if (current.ownerSub !== session.sub) {
      throw new PinBridgeError("wrong_owner", 403, "This Pin bridge belongs to another wearer.");
    }
  }

  const deadline = requestSignal(signal);
  let paired = before;
  if (
    !before.configured ||
    before.deviceId !== deviceId ||
    before.remoteEndpointId !== nodeId ||
    !before.connected
  ) {
    let response: Response | null = null;
    try {
      response = await fetchImpl(`${bridgeOrigin()}/__control/pair`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${await controlToken(deadline)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ device_id: deviceId, ticket: input.ticket }),
        cache: "no-store",
        redirect: "error",
        signal: deadline,
      });
    } catch {
      if (deadline.aborted) throw deadline.reason;
    }
    deadline.throwIfAborted();
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => undefined);
      throw new PinBridgeError("bridge_unavailable", 503, "Remote Pin access could not be saved.");
    }
    paired = parseBridgeStatus(
      await readBoundedJson(response, MAX_CONTROL_RESPONSE_BYTES, deadline),
    );
  }
  if (!paired.configured || paired.deviceId !== deviceId || paired.remoteEndpointId !== nodeId) {
    throw new PinBridgeError("pin_binding_invalid", 502, "Remote Pin access did not retain the requested assignment.");
  }

  let health: Response | null = null;
  try {
    health = await fetchImpl(`${bridgeOrigin()}/api/health`, {
      cache: "no-store",
      redirect: "error",
      signal: deadline,
    });
  } catch {
    if (deadline.aborted) throw deadline.reason;
  }
  deadline.throwIfAborted();
  if (!health?.ok) {
    await health?.body?.cancel().catch(() => undefined);
    throw new PinBridgeError("bridge_unavailable", 503, "The saved Pin could not be reached remotely.");
  }
  await health.body?.cancel().catch(() => undefined);
  const verified = await controlStatus(fetchImpl, deadline);
  if (
    !verified.configured ||
    !verified.connected ||
    verified.deviceId !== deviceId ||
    verified.remoteEndpointId !== nodeId
  ) {
    throw new PinBridgeError("pin_binding_invalid", 502, "Remote Pin access could not be verified.");
  }
  return { ...verified, configured: true, deviceId, remoteEndpointId: nodeId, ownerSub: session.sub };
}

export function pinBridgeRequest(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!path.startsWith("/api/") || path.startsWith("/__control/")) {
    throw new PinBridgeError("invalid_response", 500, "Remote Pin path is invalid.");
  }
  return fetchImpl(`${bridgeOrigin()}${path}`, {
    ...init,
    cache: "no-store",
    redirect: "error",
  });
}
