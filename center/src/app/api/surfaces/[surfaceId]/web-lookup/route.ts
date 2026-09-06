import { webLookupRequest } from "@/server/webLookup";

type Context = { params: Promise<{ surfaceId: string }> };

export async function GET(request: Request, context: Context) {
  return webLookupRequest(request, "read", (await context.params).surfaceId);
}

export async function POST(request: Request, context: Context) {
  return webLookupRequest(request, "write", (await context.params).surfaceId);
}
