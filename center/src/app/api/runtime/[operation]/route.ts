import { runtimeRequest, runtimeStatus } from "@/server/ambianceRuntime";
export async function GET(_request: Request, context: { params: Promise<{ operation: string }> }) {
  if ((await context.params).operation !== "status") return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return runtimeStatus();
}
export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  if (operation !== "room") return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return runtimeRequest(request);
}
