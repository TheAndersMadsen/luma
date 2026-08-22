import { gatewayQuery } from "@/server/musicGateway";
import { deviceMusicRequest, musicGatewayError, queryRequest } from "../routeSupport";

export async function POST(request: Request) {
  try {
    const { subject, body } = await deviceMusicRequest(request);
    return Response.json(await gatewayQuery(subject, queryRequest(body)), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return musicGatewayError(error);
  }
}
