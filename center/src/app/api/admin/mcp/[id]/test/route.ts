import { isSameOriginRequest } from "@/server/auth";
import { isMcpServerId, mcpGate, mcpProxy } from "../../proxy";

/** POST /api/admin/mcp/{id}/test, contact one tool server and list its tools. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const refused = await mcpGate({ sameOrigin: isSameOriginRequest(request) });
  if (refused) return refused;
  const { id } = await context.params;
  if (!isMcpServerId(id)) {
    return Response.json({ error: "That tool server was not found." }, { status: 404 });
  }
  return mcpProxy("POST", `/servers/${id}/test`);
}
