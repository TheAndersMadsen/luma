import { nativeSurfaceRequest } from "@/server/nativeSurfaces";

export async function DELETE(request: Request, context: { params: Promise<{ surfaceId: string }> }) {
  return nativeSurfaceRequest(request, "revoke", (await context.params).surfaceId);
}
