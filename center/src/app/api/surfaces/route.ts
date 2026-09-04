import { surfaceRequest } from "@/server/surfaces";
export const GET = (request: Request) => surfaceRequest(request, "list");
export const POST = (request: Request) => surfaceRequest(request, "approve");
