import { proxyMusicStream } from "@/server/musicGateway";

type RouteContext = { params: Promise<{ ticket: string }> };

export async function GET(request: Request, context: RouteContext) {
  return proxyMusicStream((await context.params).ticket, request);
}

export async function HEAD(request: Request, context: RouteContext) {
  return proxyMusicStream((await context.params).ticket, request);
}
