import { isSameOriginRequest } from "@/server/auth";
import { requireWearerRequest } from "@/server/operator";
import {
  pairPinBridge,
  PinBridgeError,
  pinBridgeStatusForSession,
  type PinBridgeStatus,
} from "@/server/pinBridge";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
} as const;
const MAX_BODY_BYTES = 20 * 1024;

function response(status: PinBridgeStatus) {
  return Response.json({
    configured: status.configured,
    connected: status.connected,
    local_endpoint_id: status.localEndpointId,
    device_id: status.deviceId,
    remote_endpoint_id: status.remoteEndpointId,
  }, { headers: PRIVATE_HEADERS });
}

function errorResponse(error: unknown) {
  if (error instanceof PinBridgeError) {
    const status = [400, 403, 409].includes(error.status) ? error.status : 503;
    return Response.json({ error: error.message }, { status, headers: PRIVATE_HEADERS });
  }
  return Response.json(
    { error: "Remote Pin access is unavailable." },
    { status: 503, headers: PRIVATE_HEADERS },
  );
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/u.test(request.headers.get("content-type")?.toLowerCase() ?? "")) {
    throw new PinBridgeError("invalid_response", 400, "Expected a JSON request.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new PinBridgeError("invalid_response", 400, "The remote Pin request is too large.");
  }
  if (!request.body) throw new PinBridgeError("invalid_response", 400, "Expected a JSON request.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PinBridgeError("invalid_response", 400, "The remote Pin request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PinBridgeError("invalid_response", 400, "Expected a JSON request.");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new PinBridgeError("invalid_response", 400, "Expected a JSON request.");
  }
  return decoded as Record<string, unknown>;
}

export async function GET() {
  const session = await requireWearerRequest();
  if (session instanceof Response) return session;
  if (!session) return Response.json({ error: "Sign-in is required.", reason: "sign_in_required" }, { status: 503, headers: PRIVATE_HEADERS });
  try {
    return response(await pinBridgeStatusForSession(session));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  const session = await requireWearerRequest();
  if (session instanceof Response) return session;
  if (!session) return Response.json({ error: "Sign-in is required.", reason: "sign_in_required" }, { status: 503, headers: PRIVATE_HEADERS });
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403, headers: PRIVATE_HEADERS });
  }
  try {
    const body = await boundedJson(request);
    if (Object.keys(body).some((key) => !new Set(["device_id", "ticket", "node_id"]).has(key))) {
      throw new PinBridgeError("invalid_response", 400, "The remote Pin request contains an unknown field.");
    }
    return response(await pairPinBridge(session, {
      deviceId: typeof body.device_id === "string" ? body.device_id : "",
      ticket: typeof body.ticket === "string" ? body.ticket : "",
      nodeId: typeof body.node_id === "string" ? body.node_id : "",
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export const dynamic = "force-dynamic";
