import {
  COSMOS_WEBAPI,
  COSMOS_WEBAPI_ENABLED,
  SessionExpiredError,
  ingestAnswerEvent,
  requestMetadata,
} from "@/server/cosmos";
import { logError, logWarn } from "@/server/log";

/**
 * POST /api/assistant/stream — drive one assistant turn and stream every step as
 * it happens. A passthrough to the ai-bus `Understand` loop
 * (`/demo-api/trace/stream`): the interstitial cue, each tool call and its
 * observation, then the spoken answer — the same loop a Pin runs, in the Center.
 *
 * The turn is also PERSISTED: once the answer arrives we ingest a NotableEvent
 * (`humane.experience.answers`, `{request, response}`) the same way a Pin does,
 * so the ask shows up in `/my-data/ai-mic` and survives a reload rather than
 * living only in the chat's React state. Persistence is best-effort and never
 * blocks or fails the streamed turn the wearer is already hearing.
 */
export async function POST(request: Request) {
  if (!COSMOS_WEBAPI_ENABLED) {
    return Response.json({ error: "The assistant is not configured." }, { status: 503 });
  }
  const body = await request.text();

  // The question we will persist alongside the answer.
  let question = "";
  try {
    question = String((JSON.parse(body) as { text?: unknown })?.text ?? "");
  } catch {
    // Non-JSON body — nothing to persist a request for.
  }

  // Capture the caller's identity WHILE in request scope. The tee's `flush` runs
  // as the response drains, which can be outside the cookie async-context, so we
  // must resolve the Keycloak-bearer/principal metadata now and hand it down.
  //
  // `.catch(() => undefined)` used to swallow SessionExpiredError here, and that
  // is the most expensive swallow in this file: with no metadata the turn goes
  // upstream ANONYMOUS, the backend resolves its demo principal, and a wearer
  // saying "remember this" gets "Saved:" spoken back while the event lands in a
  // partition their own /my-data can never read. `requestMetadata()` already
  // handles a merely-absent identity itself (it logs and returns anonymous
  // metadata for the device-only demo), so the ONLY thing it throws is the
  // expiry — which means refusing the turn here refuses exactly the case where a
  // wearer's own words would be written under someone else's name.
  let md: Awaited<ReturnType<typeof requestMetadata>> | undefined;
  try {
    md = await requestMetadata();
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return Response.json(
        { error: "Your session expired — sign in again.", reauthenticate: true },
        { status: 401 },
      );
    }
    logWarn("assistant: could not resolve the caller's identity", error);
    md = undefined;
  }

  // Forward that identity upstream as well. Without it the backend has nobody to
  // resolve and falls back to its demo principal, so every wearer's turn ran —
  // and "remember this" WROTE — into a partition their own /notes could never
  // read, while the assistant still answered "Saved:". The turn we persist below
  // already uses the real wearer, so omitting it here also split one turn across
  // two identities.
  const authorization = md?.get("authorization")?.[0];
  const upstream = await fetch(`${COSMOS_WEBAPI}/demo-api/trace/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(typeof authorization === "string" ? { authorization } : {}),
    },
    body,
    // Long turns stream for many seconds; do not buffer or time out early.
    // @ts-expect-error - Node fetch duplex for streaming request bodies
    duplex: "half",
  }).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    return Response.json({ error: "The assistant could not answer." }, { status: 502 });
  }

  // Tee the SSE: forward every frame unchanged to the client, capture the final
  // answer step, and — once the turn ends — persist it. Forwarding is byte-for-
  // byte (the client sees the exact same stream); parsing is a side-read.
  const decoder = new TextDecoder();
  let buffered = "";
  let answer = "";
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffered += decoder.decode(chunk, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        let name = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (name === "step" && data.length) {
          try {
            const parsed = JSON.parse(data.join("\n")) as { kind?: string; text?: unknown };
            if (parsed.kind === "answer" && typeof parsed.text === "string") {
              answer = parsed.text;
            }
          } catch {
            // Ignore frames that are not JSON.
          }
        }
      }
    },
    async flush() {
      if (question.trim() && answer.trim()) {
        try {
          await ingestAnswerEvent({ request: question, response: answer }, md);
        } catch (error) {
          // Best-effort: the wearer already heard the answer.
          logError("ai-mic persist failed", error);
        }
      }
    },
  });

  return new Response(upstream.body.pipeThrough(tee), {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Reverse proxies buffer a proxied response by default, which holds the
      // whole turn back until it ends. nginx and its derivatives honour this
      // header to disable that per response.
      "x-accel-buffering": "no",
      "x-data-source": "cosmos",
    },
  });
}
