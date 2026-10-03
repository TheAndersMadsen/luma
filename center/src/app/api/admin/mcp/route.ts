import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import { mcpGate, mcpProxy } from "./proxy";

/** GET /api/admin/mcp, the owner's tool servers and what each last listed. */
export async function GET() {
  const refused = await mcpGate(null);
  if (refused) return refused;
  return mcpProxy("GET", "");
}

/**
 * POST /api/admin/mcp, add a tool server or change the one the body names.
 * Cosmos validates the document and contacts an enabled server before it
 * answers, so the response already says what the server offers.
 */
export async function POST(request: Request) {
  const refused = await mcpGate(request);
  if (refused) return refused;
  let body: unknown;
  try {
    body = await boundedJsonBody(request, {
      maxBytes: 16 * 1024,
      tooLargeMessage: "That tool server document is too large.",
    });
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  return mcpProxy("POST", "/servers", body);
}
