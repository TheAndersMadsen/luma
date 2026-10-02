import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";
import { isSameOriginRequest } from "@/server/auth";
import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import { requireOperatorRequest } from "@/server/operator";

const path = "/demo-api/admin/integrations/test";

export async function POST(request: Request) {
  const session = await requireOperatorRequest();
  if (session instanceof Response) return session;
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  if (!COSMOS_ADMIN_ENABLED || !COSMOS_WEBAPI) {
    return Response.json({ error: "Cosmos integration tests are unavailable." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await boundedJsonBody(request, {
      maxBytes: 64 * 1024,
      tooLargeMessage: "That test request is too large.",
    });
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  try {
    const response = await fetch(`${COSMOS_WEBAPI}${path}`, {
      method: "POST",
      cache: "no-store",
      signal: cosmosDeadlineSignal(25_000),
      headers: {
        ...adminAuthHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
