import { finishTidalConnection, TidalMusicError } from "@/server/tidalMusic";
import { requireSpotifySession } from "../../../spotify/routeSupport";

export async function GET(request: Request) {
  const session = await requireSpotifySession();
  if (session instanceof Response) return session;
  const incoming = new URL(request.url);
  const destination = new URL("/settings/account/services", incoming.origin);
  const providerError = incoming.searchParams.get("error");
  try {
    if (providerError) throw new TidalMusicError("TIDAL sign-in was cancelled.", 400);
    await finishTidalConnection(
      session.sub,
      incoming.searchParams.get("code") ?? "",
      incoming.searchParams.get("state") ?? "",
    );
    destination.searchParams.set("music", "tidal-connected");
  } catch {
    destination.searchParams.set("music", "tidal-error");
  }
  return Response.redirect(destination, 303);
}
