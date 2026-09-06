import { lookupRequest } from "@/server/lookupDisclosure";

type Context = { params: Promise<{ surfaceId: string }> };

export async function GET(request: Request, context: Context) {
  return lookupRequest(request, "read", "places", (await context.params).surfaceId);
}

export async function POST(request: Request, context: Context) {
  return lookupRequest(request, "write", "places", (await context.params).surfaceId);
}
