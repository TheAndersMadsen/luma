import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";
import { isSameOriginRequest } from "@/server/auth";
import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import { queueFeatureSync } from "@/server/domain/settings";
import { requireOperatorRequest } from "@/server/operator";

const path = "/demo-api/admin/integrations";

function unavailable() {
  return Response.json(
    { error: "Cosmos integration settings are not configured on this deployment." },
    { status: 503 },
  );
}

async function proxy(method: "GET" | "PUT", body?: unknown): Promise<Response> {
  const response = await fetch(`${COSMOS_WEBAPI}${path}`, {
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
}

export async function GET() {
  const session = await requireOperatorRequest();
  if (session instanceof Response) return session;
  if (!COSMOS_ADMIN_ENABLED || !COSMOS_WEBAPI) return unavailable();
  try {
    return await proxy("GET");
  } catch {
    return Response.json({ error: "Cosmos is unreachable." }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const session = await requireOperatorRequest();
  if (session instanceof Response) return session;
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  if (!COSMOS_ADMIN_ENABLED || !COSMOS_WEBAPI) return unavailable();
  // One settings document, bounded before parsed and before anything is
  // forwarded to Cosmos.
  let body: unknown;
  try {
    body = await boundedJsonBody(request, {
      maxBytes: 64 * 1024,
      tooLargeMessage: "That provider settings document is too large.",
    });
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  try {
    const response = await proxy("PUT", body);
    if (response.ok) {
      // Stock `CentralPushReceiver.handleMessage` schedules an immediate
      // `FeatureFlagSyncWorker` for the `humane.feature-flags` domain. Azure
      // readiness changes the server-speech flags, so do not leave the Pin on
      // its cached local-TTS values until stock's next daily sync.
      await queueFeatureSync(session.sub);
    }
    return response;
  } catch {
    return Response.json({ error: "Cosmos is unreachable." }, { status: 502 });
  }
}
