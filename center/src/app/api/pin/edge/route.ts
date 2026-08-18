import { requireWearerRequest } from "@/server/operator";
import { parseDeviceEdgeDeclaration } from "@/lib/pin-setup";

/**
 * GET /api/pin/edge — the address a Pin must be pointed at to reach THIS server.
 *
 * The setup flow reads `penumbra_carry_edge_ipv4` off the device, but the device
 * only says where it is pointed, not whether that is us. Without something to
 * compare against, the flow marked "Point the Pin at this server" as done for a
 * Pin pointed at somebody else's server entirely — a newcomer would be told the
 * step was finished while their captures went somewhere they do not control.
 *
 * Unset is a legitimate `absent` answer: a deployment that has not declared its
 * device edge simply cannot make the claim. Malformed is `invalid` and an error,
 * never collapsed into absence. Neither case falls back to the request host,
 * which is commonly a reverse proxy address rather than the device edge.
 */
export async function GET() {
  const gate = await requireWearerRequest();
  if (gate instanceof Response) return gate;

  const declaration = parseDeviceEdgeDeclaration(process.env.REVIVAL_DEVICE_EDGE_IPV4);

  return Response.json(
    declaration,
    {
      status: declaration.state === "invalid" ? 500 : 200,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
