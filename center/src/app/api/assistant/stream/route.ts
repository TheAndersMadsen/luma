import { AUTH_ENABLED, isSameOriginRequest } from "@/server/auth";
import {
  COSMOS_WEBAPI,
  COSMOS_WEBAPI_ENABLED,
  SessionExpiredError,
  webapiHeaders,
} from "@/server/cosmos";
import { logWarn } from "@/server/log";
import { sessionExpiredResponse } from "@/server/routeErrors";

/**
 * POST /api/assistant/stream, drive one assistant turn and stream every step as
 * it happens. A passthrough to the ai-bus `Understand` loop
 * (`/demo-api/trace/stream`): the interstitial cue, each tool call and its
 * observation, then the spoken answer, the same loop a Pin runs, in the Center.
 *
 * Cosmos records the answered turn in the wearer's history itself, under the
 * Center chat originator: My Data › Ai Mic lists it marked "Typed in Center",
 * where search and Forget reach it, and a Pin's history restore leaves it out.
 * This route only relays the stream. It writes nothing.
 */
export async function POST(request: Request) {
  // A turn runs, and is recorded, as the wearer: only Center's own chat may
  // start one.
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  if (!COSMOS_WEBAPI_ENABLED) {
    return Response.json({ error: "The assistant is not configured." }, { status: 503 });
  }
  const body = await request.text();

  // The turn runs, and is recorded, as whoever the other web reads run as: the
  // wearer's Bearer, or the configured principal with its edge proof. Without it
  // the backend has nobody to resolve and falls back to its demo principal, so
  // a wearer saying "remember this" would be answered "Saved:" while the note
  // landed in a partition their own /notes can never read.
  //
  // `webapiHeaders()` throws only the expiry. An identity that is merely ABSENT
  // comes back empty, and is refused HERE when auth is on, the same 401 +
  // `reauthenticate` an expiry gets, because forwarding it would run, and
  // record, the turn under the backend's demo principal. Only a deployment with
  // no Keycloak at all (local dev) has a genuinely anonymous caller, and it
  // falls through.
  let identity: Record<string, string>;
  try {
    identity = await webapiHeaders();
  } catch (error) {
    if (error instanceof SessionExpiredError) return sessionExpiredResponse();
    logWarn("assistant: could not resolve the caller's identity", error);
    identity = {};
  }
  if (AUTH_ENABLED && Object.keys(identity).length === 0) {
    return Response.json({ error: "Not authenticated.", reauthenticate: true }, { status: 401 });
  }

  const upstream = await fetch(`${COSMOS_WEBAPI}/demo-api/trace/stream`, {
    method: "POST",
    headers: { ...identity, "content-type": "application/json" },
    body,
    // Long turns stream for many seconds. Do not buffer or time out early.
    // @ts-expect-error - Node fetch duplex for streaming request bodies
    duplex: "half",
  }).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    await upstream?.body?.cancel().catch(() => undefined);
    return Response.json({ error: "The assistant could not answer." }, { status: 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Reverse proxies buffer a proxied response by default, which holds the
      // whole turn back until it ends. nginx and its derivatives honour this
      // header to disable that per response.
      "x-accel-buffering": "no",
      "x-data-state": "live",
    },
  });
}
