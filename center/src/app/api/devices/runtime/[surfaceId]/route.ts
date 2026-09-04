import { pinSurfaceRequest } from "@/server/pinSurfaces";
export async function DELETE(request: Request, context: { params: Promise<{ surfaceId: string }> }) {
  return pinSurfaceRequest(request, "revoke", (await context.params).surfaceId);
}
