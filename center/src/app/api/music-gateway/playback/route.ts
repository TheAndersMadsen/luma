import { gatewayPlayback } from "@/server/musicGateway";
import { deviceMusicRequest, musicGatewayError, trackRequest } from "../routeSupport";

const MUSIC_PLAYBACK_RESOLUTION_TIMEOUT_MS = 40_000;

export async function POST(request: Request) {
  try {
    const playbackSignal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(MUSIC_PLAYBACK_RESOLUTION_TIMEOUT_MS),
    ]);
    const { subject, body } = await deviceMusicRequest(request, playbackSignal);
    const track = trackRequest(body);
    return Response.json(await gatewayPlayback(subject, track.provider, track.id, playbackSignal), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return musicGatewayError(error);
  }
}
