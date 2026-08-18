import { COSMOS_WEBAPI, COSMOS_WEBAPI_ENABLED } from "@/server/cosmos";

/** POST /api/assistant/speech — synthesize the spoken answer (Azure neural voice
 *  when configured), proxied from `/demo-api/speech`. Returns audio bytes. */
export async function POST(request: Request) {
  if (!COSMOS_WEBAPI_ENABLED) return new Response("speech unavailable", { status: 503 });
  const body = await request.text();
  const upstream = await fetch(`${COSMOS_WEBAPI}/demo-api/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) {
    return new Response("speech unavailable", { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
      "cache-control": "private, no-store",
    },
  });
}
