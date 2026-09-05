import { nativeSurfaceRequest } from "@/server/nativeSurfaces";

export const GET = (request: Request) => nativeSurfaceRequest(request, "list");
export const POST = (request: Request) => nativeSurfaceRequest(request, "approve");
