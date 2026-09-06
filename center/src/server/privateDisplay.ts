import { currentSession } from "@/server/operator";
import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { COSMOS_WEBAPI, surfaceOwnerHeaders, SessionExpiredError } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { exact, record, UUID } from "@/lib/contracts/surfaces";
import { parsePrivateDisplayApproval, parsePrivateDisplayInput, type PrivateDisplayInput } from "@/lib/contracts/privateDisplay";

const ERRORS: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "surface_limit", 503: "unavailable" };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/**
 * One owner gesture states that a native installation may show private replies
 * while the owner is present and it is unlocked. Cosmos binds it to the
 * installation's current approval revision and refuses it for TVs.
 */
export async function privateDisplayRequest(request: Request, operation: "read" | "write", surfaceId: string): Promise<Response> {
  try {
    if (!AUTH_ENABLED) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    const read = operation === "read";
    if (!read && !isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
    if (surfaceId.length !== 36 || !UUID.test(surfaceId) || surfaceId === "00000000-0000-0000-0000-000000000000") return json({ error: "invalid_request" }, 400);
    surfaceId = surfaceId.toLowerCase();

    let input: PrivateDisplayInput | undefined;
    if (!read) {
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("content_type");
        input = parsePrivateDisplayInput(record(await boundedJson(request.body, 1024, AbortSignal.timeout(5000))));
      } catch { return json({ error: "invalid_request" }, 400); }
    }

    if (!COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    const headers = await surfaceOwnerHeaders();
    const signal = AbortSignal.timeout(8000);
    const response = await fetch(`${COSMOS_WEBAPI}/surface-api/v1/surfaces/${surfaceId}/private-display`, {
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
    const approval = parsePrivateDisplayApproval(await boundedJson(response.body, 2048, signal));
    if (!read && (!input || !approval || approval.approvalRevision !== input.approvalRevision
      || approval.revision !== input.expectedRevision + 1 || !exact(approval.policy, input.policy))) throw new Error("approval_mismatch");
    return json({ approval });
  } catch (error) {
    const expired = error instanceof SessionExpiredError;
    return json({ error: expired ? "unauthorized" : "unavailable" }, expired ? 401 : 503);
  }
}
