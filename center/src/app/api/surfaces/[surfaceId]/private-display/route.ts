import { privateDisplayRequest } from "@/server/privateDisplay";
type Context = { params: Promise<{ surfaceId: string }> };
export async function GET(request: Request, context: Context) {
  return privateDisplayRequest(request, "read", (await context.params).surfaceId);
}
export async function POST(request: Request, context: Context) {
  return privateDisplayRequest(request, "write", (await context.params).surfaceId);
}
