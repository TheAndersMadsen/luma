import { requireWearerRequest } from "@/server/operator";

/**
 * GET /api/pin/edge — the address a Pin must be pointed at to reach THIS server.
 *
 * The setup flow reads `penumbra_carry_edge_ipv4` off the device, but the device
 * only says where it is pointed, not whether that is us. Without something to
 * compare against, the flow marked "Point the Pin at this server" as done for a
 * Pin pointed at somebody else's server entirely — a newcomer would be told the
 * step was finished while their captures went somewhere they do not control.
 *
 * Unset is a legitimate answer, not an error: a deployment that has not declared
 * its device edge simply cannot make the claim, and the flow says so rather than
 * guessing. That is the whole point of returning `null` here instead of falling
 * back to the request host, which is Cloudflare's address, not the edge's.
 */
export async function GET() {
  const gate = await requireWearerRequest();
  if (gate instanceof Response) return gate;

  const declared = process.env.REVIVAL_DEVICE_EDGE_IPV4?.trim() ?? "";
  // Shape-check only: this is an operator-declared value, and a malformed one
  // should read as "not declared" rather than as a mismatch the wearer cannot act on.
  const edgeIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(declared) ? declared : null;

  return Response.json(
    { edgeIpv4 },
    { headers: { "cache-control": "private, no-store" } },
  );
}
