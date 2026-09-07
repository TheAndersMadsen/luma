import { screenContextRequest } from "@/server/screenContext";
type Context = { params: Promise<{ surfaceId: string }> };
export async function GET(request: Request, context: Context) {
  return screenContextRequest(request, "read", (await context.params).surfaceId);
}
export async function POST(request: Request, context: Context) {
  return screenContextRequest(request, "write", (await context.params).surfaceId);
}
