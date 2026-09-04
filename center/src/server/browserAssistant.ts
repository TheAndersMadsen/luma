import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import { currentSession } from "@/server/operator";
import { COSMOS_WEBAPI, COSMOS_WEBAPI_ENABLED, SessionExpiredError, surfaceOwnerHeaders } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { record } from "@/lib/contracts/surfaces";

function json(error: string, status: number) {
  return Response.json({ error, ...(status === 401 ? { reauthenticate: true } : {}) }, {
    status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
const unavailable = () => json("Browser assistant runtime is unavailable.", 503);

/** Temporary boundary while the real browser Ambiance runtime replaces the
 * retired fake-Pin HTTP path. It accepts no legacy SSE/audio success, runs no
 * inference, and never persists an unavailable response as an assistant answer. */
export async function browserAssistantRequest(request: Request, operation: "stream" | "speech"): Promise<Response> {
  try {
    if (!AUTH_ENABLED) return unavailable();
    if (!await currentSession()) return json("Sign in to use the assistant.", 401);
    if (!isSameOriginRequest(request)) return json("A same-origin request is required.", 403);
    const headers = await surfaceOwnerHeaders();
    if (!COSMOS_WEBAPI_ENABLED || !COSMOS_WEBAPI) return unavailable();
    let input: Record<string, unknown>;
    try {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new Error("invalid_content_type");
      input = record(await boundedJson(request.body, 4096, AbortSignal.any([request.signal, AbortSignal.timeout(5000)])));
      if (Object.keys(input).length !== 1 || typeof input.text !== "string" || !input.text.trim()) throw new Error("invalid_text");
    } catch (error) {
      return error instanceof Error && error.message === "body_too_large"
        ? json("Assistant request is too large.", 413) : json("A nonempty text request is required.", 400);
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
    const response = await fetch(`${COSMOS_WEBAPI}/demo-api/${operation === "stream" ? "trace/stream" : "speech"}`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text: input.text }), cache: "no-store", redirect: "error", signal: signal,
    });
    // Error bodies may contain provider details. Never forward or ingest them.
    void response.body?.cancel().catch(() => {});
    if (response.status === 401) return json("Your session expired — sign in again.", 401);
    if (response.status === 400) return json("Assistant request could not be read.", 400);
    if (response.status === 408) return json("Assistant request timed out.", 408);
    if (response.status === 413) return json("Assistant request is too large.", 413);
    if (response.status === 503) return unavailable();
    return json("The browser assistant returned an unsupported response.", 502);
  } catch (error) {
    if (error instanceof SessionExpiredError) return json("Your session expired — sign in again.", 401);
    return unavailable();
  }
}
