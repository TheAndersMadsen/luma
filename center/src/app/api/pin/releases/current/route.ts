import {
  serveCurrentPinRelease,
  servePinReleaseOptions,
} from "@/server/pin-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return serveCurrentPinRelease(request);
}

export async function HEAD(request: Request): Promise<Response> {
  return serveCurrentPinRelease(request, { head: true });
}

export function OPTIONS(request: Request): Response {
  return servePinReleaseOptions(request);
}
