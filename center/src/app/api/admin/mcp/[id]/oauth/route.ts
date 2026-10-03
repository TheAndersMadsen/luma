import { originFromHeaders } from "@/server/auth";
import { MCP_OAUTH_CALLBACK_PATH, isMcpServerId, mcpGate, mcpProxy } from "../../proxy";

/**
 * POST /api/admin/mcp/{id}/oauth, begin an OAuth sign-in to one tool server.
 * Cosmos discovers where the server signs in and answers
 * `{ authorization_url }`, the provider's page for this browser to open. The
 * return address is computed here from this request's own origin: a value from
 * the browser's body is never used.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const refused = await mcpGate(request);
  if (refused) return refused;
  const { id } = await context.params;
  if (!isMcpServerId(id)) {
    return Response.json({ error: "That tool server was not found." }, { status: 404 });
  }
  const origin = originFromHeaders(request.headers) ?? new URL(request.url).origin;
  return mcpProxy("POST", `/servers/${id}/oauth`, {
    redirect_uri: `${origin}${MCP_OAUTH_CALLBACK_PATH}`,
  });
}

/** DELETE /api/admin/mcp/{id}/oauth, sign out of one tool server. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const refused = await mcpGate(request);
  if (refused) return refused;
  const { id } = await context.params;
  if (!isMcpServerId(id)) {
    return Response.json({ error: "That tool server was not found." }, { status: 404 });
  }
  return mcpProxy("DELETE", `/servers/${id}/oauth`);
}
