import { internalMusicQuery } from "./routeSupport";

export async function POST(request: Request): Promise<Response> {
  return internalMusicQuery(request);
}
