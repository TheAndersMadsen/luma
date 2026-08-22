import { gatewaySave } from "@/server/musicGateway";
import { deviceMusicRequest, musicGatewayError, trackRequest } from "../routeSupport";

export async function POST(request: Request) {
  try {
    const { subject, body } = await deviceMusicRequest(request);
    const track = trackRequest(body);
    return Response.json(await gatewaySave(subject, track.provider, track.id), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return musicGatewayError(error);
  }
}
