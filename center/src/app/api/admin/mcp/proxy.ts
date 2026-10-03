import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";
import { requireOperatorRequest } from "@/server/operator";

/** A server id as Cosmos mints it: a lowercase slug of the server's name. */
const SERVER_ID = /^[a-z0-9_]{1,32}$/u;

export function isMcpServerId(value: string): boolean {
  return SERVER_ID.test(value);
}

/**
 * The gate every MCP route shares: an operator session, a same-origin request
 * for anything that changes state, and a Cosmos operator API to call.
 *
 * A write passes `isSameOriginRequest(request)` from its own handler, because
 * `verify/same-origin-writes.test.mjs` looks for the Origin check in each
 * route file. A read passes nothing.
 */
export async function mcpGate(write?: { sameOrigin: boolean }): Promise<Response | null> {
  const session = await requireOperatorRequest();
  if (session instanceof Response) return session;
  if (write && !write.sameOrigin) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  if (!COSMOS_ADMIN_ENABLED || !COSMOS_WEBAPI) {
    return Response.json(
      { error: "Tool servers are not available on this deployment." },
      { status: 503 },
    );
  }
  return null;
}

/**
 * Forward one call to Cosmos's operator API. A save or a test waits while
 * Cosmos contacts the tool server, so the deadline is longer than a read's.
 */
export async function mcpProxy(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  try {
    const response = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/mcp${path}`, {
      method,
      cache: "no-store",
      signal: cosmosDeadlineSignal(20_000),
      headers: {
        ...adminAuthHeaders(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return Response.json({ error: "Cosmos is unreachable." }, { status: 502 });
  }
}
