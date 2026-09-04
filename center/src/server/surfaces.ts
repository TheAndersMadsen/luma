import { currentSession } from "@/server/operator";
import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { COSMOS_WEBAPI, surfaceOwnerHeaders, SessionExpiredError } from "@/server/cosmos";
import { integer, parseConnection, parseSurface, record, SURFACE_APPROVAL, SURFACE_TOKEN, UUID } from "@/lib/contracts/surfaces";
import { boundedJson } from "@/server/boundedJson";

type Operation = "list" | "approve" | "revoke" | "state" | "leave";
const ERRORS: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "invalid_connection", 404: "not_found", 409: "sequence_conflict", 429: "surface_limit", 503: "unavailable" };
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
function fields(body: Record<string, unknown>, expected: string[]) {
  if (Object.keys(body).length !== expected.length || expected.some(key => !(key in body))) throw new Error("invalid_fields");
}

/** BFF uses the real cookie session and bearer; browser headers cannot select an owner. */
export async function surfaceRequest(request: Request, operation: Operation, surfaceId?: string): Promise<Response> {
  try {
    if (!AUTH_ENABLED) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    if (operation !== "list" && !isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
    if (surfaceId !== undefined && !UUID.test(surfaceId)) return json({ error: "invalid_request" }, 400);
    let body: Record<string, unknown> | undefined;
    const headers = await surfaceOwnerHeaders();
    if (operation === "approve" || operation === "state" || operation === "leave") {
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("content_type");
        body = record(await boundedJson(request.body, 1024, AbortSignal.timeout(5000)));
        if (operation === "approve") {
          fields(body, ["surfaceId", "approval"]);
          if (typeof body.surfaceId !== "string" || !UUID.test(body.surfaceId) || body.approval !== SURFACE_APPROVAL) throw new Error("approval");
        } else {
          fields(body, operation === "state" ? ["incarnation", "sequence", "visible"] : ["incarnation"]);
          if (typeof body.incarnation !== "string" || !UUID.test(body.incarnation)) throw new Error("incarnation");
          if (operation === "state" && (!integer(body.sequence, 1) || typeof body.visible !== "boolean")) throw new Error("state");
          const token = request.headers.get("x-cosmos-surface-token");
          if (!token || !SURFACE_TOKEN.test(token)) return json({ error: "invalid_connection" }, 403);
          headers["x-cosmos-surface-token"] = token;
        }
      } catch { return json({ error: "invalid_request" }, 400); }
    }
    if (!COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    const suffix = surfaceId ? `/${surfaceId}${operation === "state" || operation === "leave" ? `/${operation}` : ""}` : "";
    const signal = AbortSignal.timeout(8000);
    const response = await fetch(`${COSMOS_WEBAPI}/surface-api/v1/surfaces${suffix}`, {
      method: operation === "list" ? "GET" : operation === "revoke" ? "DELETE" : "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store", redirect: "error", signal: signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = ERRORS[response.status] ? response.status : 503;
      return json({ error: ERRORS[status] }, status);
    }
    const result = record(await boundedJson(response.body, 65536, signal));
    if (operation === "list") {
      if (!Array.isArray(result.surfaces) || result.surfaces.length > 16) throw new Error("invalid_list");
      return json({ surfaces: result.surfaces.map(parseSurface) });
    }
    const surface = parseSurface(result.surface);
    if (surface.surfaceId !== (surfaceId ?? body?.surfaceId)) throw new Error("surface_mismatch");
    return json(operation === "approve" ? { surface, connection: parseConnection(result.connection) } : { surface });
  } catch (error) {
    return json({ error: error instanceof SessionExpiredError ? "unauthorized" : "unavailable" }, error instanceof SessionExpiredError ? 401 : 503);
  }
}
