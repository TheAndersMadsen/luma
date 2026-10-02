import { gatewayQuery, MusicGatewayError } from "@/server/musicGateway";
import { deviceMusicRequest, musicGatewayError, queryRequest } from "../routeSupport";

/** The Pin's own music lookups get a budget, like playback's 40 s. */
const MUSIC_QUERY_TIMEOUT_MS = 15_000;

export async function POST(request: Request) {
  const querySignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(MUSIC_QUERY_TIMEOUT_MS),
  ]);
  try {
    const { subject, body } = await deviceMusicRequest(request, querySignal);
    return Response.json(await gatewayQuery(subject, queryRequest(body), querySignal), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return musicGatewayError(querySignal.aborted
      ? new MusicGatewayError("Music request timed out.", 408)
      : error);
  }
}
