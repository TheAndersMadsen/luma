import { nativeSurfaceRequest } from "@/server/nativeSurfaces";

export async function GET(request: Request, context: { params: Promise<{ enrollmentId: string }> }) {
  return nativeSurfaceRequest(request, "lookup", (await context.params).enrollmentId);
}
