import { currentSession } from "@/server/operator";
import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { COSMOS_WEBAPI, surfaceOwnerHeaders, SessionExpiredError } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { exact, record, UUID } from "@/lib/contracts/surfaces";
import { DEVICE_ACTIONS_BYTES, parseDeviceActionApproval, parseDeviceActionInput, type DeviceActionInput } from "@/lib/contracts/deviceActions";
import { DEVICE_COMMANDS_BYTES, parseDeviceCommandApproval, parseDeviceCommandInput, type DeviceCommandInput } from "@/lib/contracts/deviceCommands";

const ERRORS: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "surface_limit", 503: "unavailable" };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** The two owner permissions differ only in their route, their body limit and their parser. */
const KIND = {
  actions: {
    path: "device-actions", bytes: DEVICE_ACTIONS_BYTES,
    parseInput: parseDeviceActionInput as (value: unknown) => DeviceActionInput | DeviceCommandInput,
    parseApproval: parseDeviceActionApproval as (value: unknown) => { approvalRevision: number; revision: number; policy: unknown } | null,
  },
  commands: {
    path: "device-commands", bytes: DEVICE_COMMANDS_BYTES,
    parseInput: parseDeviceCommandInput as (value: unknown) => DeviceActionInput | DeviceCommandInput,
    parseApproval: parseDeviceCommandApproval as (value: unknown) => { approvalRevision: number; revision: number; policy: unknown } | null,
  },
} as const;
export type DevicePermissionKind = keyof typeof KIND;

/**
 * One owner gesture states what a native installation may be asked to do, or
 * which commands it may be asked to run. Cosmos binds each to the
 * installation's current approval revision, caps its class by that
 * installation's own private-display ceiling, and refuses an operation the
 * installation's approved manifest does not declare.
 *
 * A `403 policy_blocked` is Cosmos declining a policy that is well formed:
 * a class above the ceiling, an operation the manifest never declared, or a
 * task label the runtime reads as too sensitive to route anywhere. It is
 * passed through as `forbidden` so the page can say which, from what it knows.
 */
export async function devicePermissionRequest(request: Request, kind: DevicePermissionKind, operation: "read" | "write", surfaceId: string): Promise<Response> {
  const { path, bytes, parseInput, parseApproval } = KIND[kind];
  try {
    if (!AUTH_ENABLED) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    const read = operation === "read";
    if (!read && !isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
    if (surfaceId.length !== 36 || !UUID.test(surfaceId) || surfaceId === "00000000-0000-0000-0000-000000000000") return json({ error: "invalid_request" }, 400);
    surfaceId = surfaceId.toLowerCase();

    let input: DeviceActionInput | DeviceCommandInput | undefined;
    if (!read) {
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("content_type");
        input = parseInput(record(await boundedJson(request.body, bytes, AbortSignal.timeout(5000))));
      } catch { return json({ error: "invalid_request" }, 400); }
    }

    if (!COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    const headers = await surfaceOwnerHeaders();
    const signal = AbortSignal.timeout(8000);
    const response = await fetch(`${COSMOS_WEBAPI}/surface-api/v1/surfaces/${surfaceId}/${path}`, {
      method: read ? "GET" : "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: input ? JSON.stringify(input) : undefined,
      cache: "no-store", redirect: "error", signal: signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = ERRORS[response.status] ? response.status : 503;
      return json({ error: ERRORS[status] }, status);
    }
    const approval = parseApproval(await boundedJson(response.body, bytes * 2, signal));
    if (!read && (!input || !approval || approval.approvalRevision !== input.approvalRevision
      || approval.revision !== input.expectedRevision + 1 || !exact(approval.policy, input.policy))) throw new Error("approval_mismatch");
    return json({ approval });
  } catch (error) {
    const expired = error instanceof SessionExpiredError;
    return json({ error: expired ? "unauthorized" : "unavailable" }, expired ? 401 : 503);
  }
}
