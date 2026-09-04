import { surfaceRequest } from "@/server/surfaces";
export async function DELETE(request: Request, context: { params: Promise<{ surfaceId: string }> }) {
  return surfaceRequest(request, "revoke", (await context.params).surfaceId);
}
