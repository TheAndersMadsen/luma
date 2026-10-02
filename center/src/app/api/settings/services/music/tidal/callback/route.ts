import {
  abandonTidalConnection,
  finishTidalConnection,
  TidalMusicError,
} from "@/server/tidalMusic";
import { requireSpotifySession } from "../../../spotify/routeSupport";

const MUSIC_PATH = "/settings/account/music";
/** The shape `startTidalConnection` gives a sign-in's `state` (base64url). */
const PENDING_STATE = /^[A-Za-z0-9_-]{1,128}$/u;

/*
 * TIDAL sends the owner's browser here at the end of its sign-in. This is a
 * top-level navigation, so every outcome is a redirect to a page, never JSON:
 * the Services card reads `?music=` and says how the sign-in ended.
 */
export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const destination = new URL(MUSIC_PATH, incoming.origin);
  const state = incoming.searchParams.get("state") ?? "";
  const session = await requireSpotifySession();
  if (session instanceof Response) {
    if (session.status !== 401) return session;
    // Center's sign-in lapsed while the owner was at TIDAL. Without it this
    // sign-in cannot be finished, so ask for Center's and then say so. The
    // sign-in's `state` rides along, so the Services card can drop it once the
    // owner is back and it stops reading as connecting.
    const next = new URLSearchParams({ music: "tidal-error" });
    if (PENDING_STATE.test(state)) next.set("tidal_state", state);
    const login = new URL("/login", incoming.origin);
    login.searchParams.set("next", `${MUSIC_PATH}?${next}`);
    return Response.redirect(login, 303);
  }
  const providerError = incoming.searchParams.get("error");
  try {
    if (providerError) throw new TidalMusicError("TIDAL sign-in was cancelled.", 400);
    await finishTidalConnection(session.sub, incoming.searchParams.get("code") ?? "", state);
    destination.searchParams.set("music", "tidal-connected");
  } catch {
    // A failed or cancelled sign-in must not keep reading as "connecting".
    await abandonTidalConnection(session.sub, state).catch(() => undefined);
    destination.searchParams.set("music", "tidal-error");
  }
  return Response.redirect(destination, 303);
}
