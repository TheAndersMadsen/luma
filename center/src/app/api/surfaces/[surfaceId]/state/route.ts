import { surfaceRequest } from "@/server/surfaces";
export async function POST(request: Request, context: { params: Promise<{ surfaceId: string }> }) {
  return surfaceRequest(request, "state", (await context.params).surfaceId);
}
