import { currentSession } from "@/server/operator";
import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { COSMOS_WEBAPI, surfaceOwnerHeaders, SessionExpiredError } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { exact, record, UUID } from "@/lib/contracts/surfaces";
import { parseSpeechApproval, parseSpeechDisclosureInput, type SpeechDisclosureInput } from "@/lib/contracts/speechDisclosure";

const ERRORS: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "surface_limit", 503: "unavailable" };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/**
 * One owner gesture permits Cosmos to send a surface's shared reply text to the
 * speech provider. Pin pairing, native approval and saved provider credentials
 * grant nothing here; Cosmos enforces the binding under its own lock.
 */
export async function speechDisclosureRequest(request: Request, operation: "read" | "write", surfaceId: string): Promise<Response> {
  try {
    if (!AUTH_ENABLED) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    const read = operation === "read";
    if (!read && !isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
    if (surfaceId.length !== 36 || !UUID.test(surfaceId) || surfaceId === "00000000-0000-0000-0000-000000000000") return json({ error: "invalid_request" }, 400);
    surfaceId = surfaceId.toLowerCase();

    let input: SpeechDisclosureInput | undefined;
    if (!read) {
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("content_type");
        input = parseSpeechDisclosureInput(record(await boundedJson(request.body, 1024, AbortSignal.timeout(5000))));
      } catch { return json({ error: "invalid_request" }, 400); }
    }

    // Validate the complete request before acquiring or forwarding owner authority.
    if (!COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    const headers = await surfaceOwnerHeaders();
    const signal = AbortSignal.timeout(8000);
    const response = await fetch(`${COSMOS_WEBAPI}/surface-api/v1/surfaces/${surfaceId}/speech-disclosure`, {
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
    const approval = parseSpeechApproval(await boundedJson(response.body, 2048, signal));
    if (!read && (!input || !approval || approval.approvalRevision !== input.approvalRevision
      || approval.revision !== input.expectedRevision + 1 || !exact(approval.policy, input.policy))) throw new Error("approval_mismatch");
    return json({ approval });
  } catch (error) {
    const expired = error instanceof SessionExpiredError;
    return json({ error: expired ? "unauthorized" : "unavailable" }, expired ? 401 : 503);
  }
}
