import { pinSurfaceRequest } from "@/server/pinSurfaces";
type Context = { params: Promise<{ surfaceId: string }> };
export async function GET(request: Request, context: Context) {
  return pinSurfaceRequest(request, "speech-read", (await context.params).surfaceId);
}
export async function POST(request: Request, context: Context) {
  return pinSurfaceRequest(request, "speech-write", (await context.params).surfaceId);
}
