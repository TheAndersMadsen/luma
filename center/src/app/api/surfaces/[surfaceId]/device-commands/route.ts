import { devicePermissionRequest } from "@/server/deviceActions";
type Context = { params: Promise<{ surfaceId: string }> };
export async function GET(request: Request, context: Context) {
  return devicePermissionRequest(request, "commands", "read", (await context.params).surfaceId);
}
export async function POST(request: Request, context: Context) {
  return devicePermissionRequest(request, "commands", "write", (await context.params).surfaceId);
}
