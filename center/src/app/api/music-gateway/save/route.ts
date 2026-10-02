import { gatewaySave, MusicGatewayError } from "@/server/musicGateway";
import { deviceMusicRequest, musicGatewayError, trackRequest } from "../routeSupport";

/** Saving a track to the wearer's library gets the same budget as a lookup. */
const MUSIC_SAVE_TIMEOUT_MS = 15_000;

export async function POST(request: Request) {
  const saveSignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(MUSIC_SAVE_TIMEOUT_MS),
  ]);
  try {
    const { subject, body } = await deviceMusicRequest(request, saveSignal);
    const track = trackRequest(body);
    return Response.json(await gatewaySave(subject, track.provider, track.id, saveSignal), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return musicGatewayError(saveSignal.aborted
      ? new MusicGatewayError("Music request timed out.", 408)
      : error);
  }
}
