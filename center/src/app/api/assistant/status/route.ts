import { COSMOS_WEBAPI, COSMOS_WEBAPI_ENABLED, cosmosDeadlineSignal } from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";

/**
 * GET /api/assistant/status — the assistant's readiness, proxied from the ai-bus
 * demo surface (`/demo-api/status`). Reports whether a language model and speech
 * are configured for this deployment, plus the live gRPC mesh behind it.
 *
 * Three different situations, three different states on the wire, so the Ai Mic
 * surfaces can tell them apart: no assistant is configured here (absent — a
 * retry cannot help), the backend did not answer (degraded — a retry might), and
 * it answered (live). This route used to emit `x-data-source` with values from a
 * vocabulary the client did not share.
 */
export async function GET() {
  if (!COSMOS_WEBAPI_ENABLED) {
    return Response.json(
      { assistant: false, speech: false, model: "not configured" },
      {
        headers: sourceHeaders({
          source: "unconfigured",
          state: "absent",
          fallback: "empty",
          degraded: "Assistant is not configured.",
        }),
      },
    );
  }
  try {
    const res = await fetch(`${COSMOS_WEBAPI}/demo-api/status`, {
      cache: "no-store",
      signal: cosmosDeadlineSignal(),
    });
    // An upstream error is "it isn't answering", not "there is no assistant" —
    // passing the error body straight through made a 500 look like a
    // deployment that simply has no model configured.
    if (!res.ok) {
      return Response.json(
        { assistant: false, speech: false, model: "unreachable" },
        {
          status: 503,
          headers: sourceHeaders({
            source: "unreachable",
            state: "degraded",
            fallback: "empty",
            degraded: "Assistant is unavailable.",
          }),
        },
      );
    }
    return new Response(res.body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        ...sourceHeaders({ source: "cosmos", state: "live" }),
      },
    });
  } catch {
    return Response.json(
      { assistant: false, speech: false, model: "unreachable" },
      {
        status: 503,
        headers: sourceHeaders({
          source: "unreachable",
          state: "degraded",
          fallback: "empty",
          degraded: "Assistant is unavailable.",
        }),
      },
    );
  }
}
