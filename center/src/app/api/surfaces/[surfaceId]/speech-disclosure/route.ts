import { speechDisclosureRequest } from "@/server/speechDisclosure";
type Context = { params: Promise<{ surfaceId: string }> };
export async function GET(request: Request, context: Context) {
  return speechDisclosureRequest(request, "read", (await context.params).surfaceId);
}
export async function POST(request: Request, context: Context) {
  return speechDisclosureRequest(request, "write", (await context.params).surfaceId);
}
