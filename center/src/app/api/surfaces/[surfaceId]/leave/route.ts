import { surfaceRequest } from "@/server/surfaces";
export async function POST(request: Request, context: { params: Promise<{ surfaceId: string }> }) {
  return surfaceRequest(request, "leave", (await context.params).surfaceId);
}
