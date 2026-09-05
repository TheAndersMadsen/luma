import { pinSurfaceRequest } from "@/server/pinSurfaces";
type Context = { params: Promise<{ surfaceId: string }> };
export async function GET(request: Request, context: Context) {
  return pinSurfaceRequest(request, "voice-read", (await context.params).surfaceId);
}
export async function POST(request: Request, context: Context) {
  return pinSurfaceRequest(request, "voice-write", (await context.params).surfaceId);
}
