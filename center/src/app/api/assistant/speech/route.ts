import { isSameOriginRequest } from "@/server/auth";
import { COSMOS_WEBAPI, COSMOS_WEBAPI_ENABLED } from "@/server/cosmos";

/**
 * POST /api/assistant/speech, synthesize the spoken answer (Azure neural voice
 * when configured), proxied from `/demo-api/speech`. Returns audio bytes.
 *
 * The deadline bounds the wait for Cosmos's HEADERS only, the way the capture
 * download bounds its wait: `AbortSignal.timeout` on the fetch itself would also
 * abort the body mid-stream and cut a wearer off mid-sentence. The forwarded text is
 * bounded before it is sent, Cosmos bounds speech text to 6,004 UTF-8 bytes, and no legal body for one comes near this cap, so the proxy stops the
 * pathological bodies and leaves the verdict on the text to Cosmos.
 */
const MAX_SPEECH_BODY_BYTES = 32 * 1024;

export async function POST(request: Request) {
  // Synthesis spends the deployment's speech quota: Center's own chat only.
  if (!isSameOriginRequest(request)) {
    return new Response("A same-origin request is required.", { status: 403 });
  }
  if (!COSMOS_WEBAPI_ENABLED) return new Response("speech unavailable", { status: 503 });
  const body = await readBoundedBody(request, MAX_SPEECH_BODY_BYTES);
  if (body === null) return new Response("speech payload too large", { status: 413 });

  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("cosmos webapi timed out", "TimeoutError")),
    Number(process.env.COSMOS_DEADLINE_MS ?? 8000),
  );
  let upstream: Response | null;
  try {
    upstream = await fetch(`${COSMOS_WEBAPI}/demo-api/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
      // Header timeout ends once streaming starts. Wearer cancellation remains live.
      signal: AbortSignal.any([request.signal, deadline.signal]),
    }).catch(() => null);
  } finally {
    clearTimeout(timer);
  }
  if (!upstream || !upstream.ok || !upstream.body) {
    await upstream?.body?.cancel().catch(() => undefined);
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

/**
 * The request bytes, read binary-safely and refused the moment they pass the
 * cap, whatever `content-length` claims. `null` means the cap was passed.
 */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
