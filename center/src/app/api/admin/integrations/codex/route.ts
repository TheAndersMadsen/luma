import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";
import { isSameOriginRequest } from "@/server/auth";
import { requireOperatorRequest } from "@/server/operator";

const path = "/demo-api/admin/integrations/codex";

async function mutate(request: Request, method: "POST" | "DELETE") {
  const session = await requireOperatorRequest();
  if (session instanceof Response) return session;
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  if (!COSMOS_ADMIN_ENABLED || !COSMOS_WEBAPI) {
    return Response.json({ error: "Cosmos integration settings are unavailable." }, { status: 503 });
  }
  try {
    const response = await fetch(`${COSMOS_WEBAPI}${path}`, {
      method,
      cache: "no-store",
      signal: cosmosDeadlineSignal(20_000),
      headers: adminAuthHeaders(),
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

export async function POST(request: Request) {
  return mutate(request, "POST");
}

export async function DELETE(request: Request) {
  return mutate(request, "DELETE");
}
