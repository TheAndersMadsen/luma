import { currentSession } from "@/server/operator";
import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { COSMOS_WEBAPI, surfaceOwnerHeaders, SessionExpiredError } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { exact, UUID } from "@/lib/contracts/surfaces";
import {
  type WebLookupInput,
  WEB_LOOKUP_INPUT_BYTES,
  WEB_LOOKUP_RESPONSE_BYTES,
  parseWebLookupInput,
  parseWebLookupState,
} from "@/lib/contracts/webLookup";

const ERRORS: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "surface_limit", 503: "unavailable" };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** Owner policy names the exact provider; saving provider settings grants no disclosure. */
export async function webLookupRequest(request: Request, operation: "read" | "write", surfaceId: string): Promise<Response> {
  try {
    if (!AUTH_ENABLED) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    const read = operation === "read";
    if (!read && !isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
    if (surfaceId.length !== 36 || !UUID.test(surfaceId) || surfaceId === "00000000-0000-0000-0000-000000000000") return json({ error: "invalid_request" }, 400);
    surfaceId = surfaceId.toLowerCase();

    let input: WebLookupInput | undefined;
    if (!read) {
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("content_type");
        input = parseWebLookupInput(await boundedJson(request.body, WEB_LOOKUP_INPUT_BYTES,
          AbortSignal.any([request.signal, AbortSignal.timeout(5000)])));
      } catch { return json({ error: "invalid_request" }, 400); }
    }

    // Validate the complete request before acquiring or forwarding owner authority.
    if (!COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    request.signal.throwIfAborted();
    const headers = await surfaceOwnerHeaders();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
    signal.throwIfAborted();
    const response = await fetch(`${COSMOS_WEBAPI}/surface-api/v1/surfaces/${surfaceId}/web-lookup`, {
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
    if (response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
      void response.body?.cancel().catch(() => {});
      throw new Error("invalid_content_type");
    }
    const state = parseWebLookupState(await boundedJson(response.body, WEB_LOOKUP_RESPONSE_BYTES, signal));
    if (!read && (!input || !state.approval || state.approval.approvalRevision !== input.approvalRevision
      || state.approval.revision !== input.expectedRevision + 1 || !exact(state.approval.policy, input.policy)
      || state.binding.incarnation !== input.approvalIncarnation
      || (input.approvalIncarnation === null
        ? state.binding.approvalRevision !== input.approvalRevision
        : state.binding.approvalRevision < input.approvalRevision))) {
      throw new Error("approval_mismatch");
    }
    return json(state);
  } catch (error) {
    const expired = error instanceof SessionExpiredError;
    return json({ error: expired ? "unauthorized" : "unavailable" }, expired ? 401 : 503);
  }
}
