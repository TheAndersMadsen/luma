import { isMcpServerId, mcpGate, mcpProxy } from "../proxy";

/** DELETE /api/admin/mcp/{id}, remove one tool server. */
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
  return mcpProxy("DELETE", `/servers/${id}`);
}
