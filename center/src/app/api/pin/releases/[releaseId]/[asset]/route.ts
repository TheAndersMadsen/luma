import {
  servePinReleaseArtifact,
  servePinReleaseOptions,
} from "@/server/pin-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{
    readonly releaseId: string;
    readonly asset: string;
  }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { releaseId, asset } = await context.params;
  return servePinReleaseArtifact(request, releaseId, asset);
}

export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  const { releaseId, asset } = await context.params;
  return servePinReleaseArtifact(request, releaseId, asset, { head: true });
}

export function OPTIONS(request: Request): Response {
  return servePinReleaseOptions(request);
}
