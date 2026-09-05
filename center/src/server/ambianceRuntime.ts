import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { currentSession } from "@/server/operator";
import { COSMOS_WEBAPI, SessionExpiredError, surfaceOwnerHeaders } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { record, SURFACE_TOKEN } from "@/lib/contracts/surfaces";
import { fields, parseRoomConnection, parseRoomRequest } from "@/lib/contracts/ambianceRuntime";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const errors: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "invalid_connection", 408: "request_timeout", 409: "stale_action", 413: "request_too_large", 429: "busy", 503: "unavailable" };
export async function runtimeStatus(): Promise<Response> {
  try {
    if (!AUTH_ENABLED || !COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    const headers = await surfaceOwnerHeaders();
    const signal = AbortSignal.timeout(5000);
    const response = await fetch(`${COSMOS_WEBAPI}/runtime-api/v1/browser/status`, { headers, signal: signal, cache: "no-store", redirect: "error" });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return json({ error: response.status === 401 ? "unauthorized" : "unavailable" }, response.status === 401 ? 401 : 503); }
    const value = record(await boundedJson(response.body, 1024, signal));
    fields(value, ["version", "textInputConfigured", "approvedSurfaceRequired"]);
    if (value.version !== 1 || typeof value.textInputConfigured !== "boolean" || value.approvedSurfaceRequired !== true) throw new Error("invalid_status");
    return json(value);
  } catch (error) { return json({ error: error instanceof SessionExpiredError ? "unauthorized" : "unavailable" }, error instanceof SessionExpiredError ? 401 : 503); }
}
export async function runtimeRequest(request: Request): Promise<Response> {
  try {
    if (!AUTH_ENABLED) return json({ error: "unavailable" }, 503);
    if (!await currentSession()) return json({ error: "unauthorized" }, 401);
    if (!isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
    const headers = await surfaceOwnerHeaders();
    const token = request.headers.get("x-cosmos-surface-token");
    if (!token || !SURFACE_TOKEN.test(token)) return json({ error: "invalid_connection" }, 403);
    let body: Record<string, unknown>;
    try {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("content_type");
      body = parseRoomRequest(await boundedJson(request.body, 1024, AbortSignal.any([request.signal, AbortSignal.timeout(5000)])));
    } catch (error) { return error instanceof Error && error.message === "body_too_large" ? json({ error: "request_too_large" }, 413) : json({ error: "invalid_request" }, 400); }
    if (!COSMOS_WEBAPI) return json({ error: "unavailable" }, 503);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    const response = await fetch(`${COSMOS_WEBAPI}/runtime-api/v1/browser/room`, {
      method: "POST", headers: { ...headers, "x-cosmos-surface-token": token, "content-type": "application/json" },
      body: JSON.stringify(body), signal: signal, cache: "no-store", redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = errors[response.status] ? response.status : 503;
      return json({ error: errors[status] }, status);
    }
    const connection = parseRoomConnection(await boundedJson(response.body, 8192, signal), new URL(request.url).origin);
    if (connection.epoch !== body.epoch) throw new Error("wrong_epoch");
    return json(connection);
  } catch (error) {
    return json({ error: error instanceof SessionExpiredError ? "unauthorized" : "unavailable" }, error instanceof SessionExpiredError ? 401 : 503);
  }
}
