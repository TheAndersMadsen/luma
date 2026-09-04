import { pinSurfaceRequest } from "@/server/pinSurfaces";
export const GET = (request: Request) => pinSurfaceRequest(request, "list");
export const POST = (request: Request) => pinSurfaceRequest(request, "approve");
