import { currentSession } from "@/server/operator";
import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { COSMOS_WEBAPI, surfaceOwnerHeaders, SessionExpiredError } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { record, UUID } from "@/lib/contracts/surfaces";
import {
  type NativeApprovalInput,
  nativePublicKeyFingerprint,
  parseNativeApprovalInput,
  parseNativeRevokeInput,
  parseNativeSurface,
  parseNativeSurfaces,
} from "@/lib/contracts/nativeSurfaces";

type Operation = "list" | "lookup" | "approve" | "revoke";
const ERRORS: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "surface_limit", 503: "unavailable" };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** Owner enrollment grants the fixed native posture, never a connection or actor identity. */
export async function nativeSurfaceRequest(request: Request, operation: Operation, targetId?: string): Promise<Response> {
  try {
    if (!AUTH_ENABLED) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    const read = operation === "list" || operation === "lookup";
    if (!read && !isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
    if ((operation === "lookup" || operation === "revoke") && (!targetId || !UUID.test(targetId)
      || targetId === "00000000-0000-0000-0000-000000000000")) return json({ error: "invalid_request" }, 400);
    targetId = targetId?.toLowerCase();

    let body: NativeApprovalInput | ReturnType<typeof parseNativeRevokeInput> | undefined;
    let approval: NativeApprovalInput | undefined;
    let fingerprint: string | undefined;
    if (!read) {
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("content_type");
        const input = await boundedJson(request.body, 1024, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]));
        if (operation === "approve") {
          approval = parseNativeApprovalInput(input);
          fingerprint = await nativePublicKeyFingerprint(approval.publicKey);
          body = approval;
        } else {
          body = parseNativeRevokeInput(input);
        }
      } catch { return json({ error: "invalid_request" }, 400); }
    }

    // Validate the whole request before acquiring or forwarding owner authority.
    if (!COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    const headers = await surfaceOwnerHeaders();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
    signal.throwIfAborted();
    const suffix = operation === "lookup" ? `/enrollments/${targetId}` : operation === "revoke" ? `/${targetId}` : "";
    const response = await fetch(`${COSMOS_WEBAPI}/surface-api/v1/native${suffix}`, {
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
    if (response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
      void response.body?.cancel().catch(() => {});
      throw new Error("invalid_content_type");
    }
    const result = await boundedJson(response.body, operation === "list" ? 65536 : 4096, signal);
    if (operation === "list") return json({ native: parseNativeSurfaces(result) });
    const native = parseNativeSurface(record(result).native);
    if (operation === "lookup" && native.enrollmentId !== targetId
      || operation === "approve" && (!approval || native.enrollmentId !== approval.enrollmentId
        || native.platform !== approval.platform || native.publicKeyFingerprint !== fingerprint || native.revoked
        || native.revision !== approval.expectedRevision + 1 && !(approval.expectedRevision >= 1 && native.revision === approval.expectedRevision))
      || operation === "revoke" && (native.surfaceId !== targetId || !native.revoked || native.revision !== Number(body?.expectedRevision) + 1)) {
      throw new Error("native_mismatch");
    }
    return json({ native });
  } catch (error) {
    const expired = error instanceof SessionExpiredError;
    return json({ error: expired ? "unauthorized" : "unavailable" }, expired ? 401 : 503);
  }
}
