import { currentSession } from "@/server/operator";
import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { COSMOS_WEBAPI, surfaceOwnerHeaders, SessionExpiredError } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { exact, record, UUID } from "@/lib/contracts/surfaces";
import { DEVICE_ID, PIN_APPROVAL, parsePinSurface, parsePinSurfaces } from "@/lib/contracts/pinSurfaces";
import { parseLocalVoiceApproval, parseLocalVoiceInput } from "@/lib/contracts/localVoice";

type Operation = "list" | "approve" | "revoke" | "voice-read" | "voice-write";
const ERRORS: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "surface_limit", 503: "unavailable" };
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** Approval is a separate owner gesture, never a side effect of certificate pairing. */
export async function pinSurfaceRequest(request: Request, operation: Operation, surfaceId?: string): Promise<Response> {
  try {
    if (!AUTH_ENABLED) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    const read = operation === "list" || operation === "voice-read";
    const voice = operation === "voice-read" || operation === "voice-write";
    if (!read && !isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
    if ((operation === "revoke" || voice) && (!surfaceId || !UUID.test(surfaceId))) return json({ error: "invalid_request" }, 400);
    // No admin-pairing token, XFCC, share token or development principal fallback.
    const headers = await surfaceOwnerHeaders();
    let body: Record<string, unknown> | undefined;
    if (operation === "approve" || operation === "voice-write") {
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("content_type");
        const input = record(await boundedJson(request.body, 1024, voice
          ? AbortSignal.any([request.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)));
        if (operation === "voice-write") body = { ...parseLocalVoiceInput(input) };
        else {
          if (Object.keys(input).length !== 2 || typeof input.deviceId !== "string" || !DEVICE_ID.test(input.deviceId)
            || input.approval !== PIN_APPROVAL) throw new Error("invalid_approval");
          body = { deviceId: input.deviceId.toLowerCase(), approval: PIN_APPROVAL };
        }
      } catch { return json({ error: "invalid_request" }, 400); }
    }
    if (!COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    const signal = voice ? AbortSignal.any([request.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    const response = await fetch(`${COSMOS_WEBAPI}/surface-api/v1/pins${surfaceId ? `/${surfaceId}` : ""}${voice ? "/local-voice" : ""}`, {
      method: read ? "GET" : operation === "revoke" ? "DELETE" : "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store", redirect: "error", signal: signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = ERRORS[response.status] ? response.status : 503;
      return json({ error: ERRORS[status] }, status);
    }
    if (voice && response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
      void response.body?.cancel().catch(() => {});
      throw new Error("invalid_content_type");
    }
    const result = await boundedJson(response.body, voice ? 2048 : 65536, signal);
    if (voice) {
      const approval = parseLocalVoiceApproval(result);
      if (operation === "voice-write" && (!approval || approval.approvalRevision !== body?.approvalRevision
        || approval.revision !== Number(body?.expectedRevision) + 1 || !exact(approval.policy, body?.policy))) throw new Error("approval_mismatch");
      return json({ approval });
    }
    if (operation === "list") return json({ pins: parsePinSurfaces(result) });
    const pin = parsePinSurface(record(result).pin, operation === "revoke");
    if (operation === "approve" && (pin.deviceId !== body?.deviceId || pin.revoked || !pin.currentPaired)
      || operation === "revoke" && (pin.surfaceId !== surfaceId || !pin.revoked)) throw new Error("approval_mismatch");
    return json({ pin });
  } catch (error) {
    const expired = error instanceof SessionExpiredError;
    return json({ error: expired ? "unauthorized" : "unavailable" }, expired ? 401 : 503);
  }
}
