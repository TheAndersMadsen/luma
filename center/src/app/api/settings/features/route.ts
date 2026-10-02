import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isSameOriginRequest, SESSION_COOKIE, verifySession, type Session } from "@/server/auth";
import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { boundedJsonBody } from "../services/spotify/routeSupport";
import { readFeatures, writeFeature, type FeatureWrite } from "@/server/domain/features";
import { queueFeatureSync } from "@/server/domain/settings";
import { sessionExpiredResponse } from "@/server/routeErrors";

/**
 * Settings → Features: the signed-in wearer's own choices, which Cosmos keeps
 * per account and serves to that account's Pins (`@/server/domain/features`).
 * humane.center had this page in each account's Settings → Ai Pin group, so
 * every wearer changes their own Pins and nobody else's.
 *
 *   GET                       200 Feature[]
 *   PUT {name, value}         200 {...feature, delivery}
 *   DELETE {name}             200 {name, deleted, delivery}
 *
 * A value Cosmos refuses is a 400 with its reason. An expired sign-in is a 401
 * with `reauthenticate`. A Cosmos that did not answer is a 502, and one that is
 * not configured a 503. After a change the account's Pins get a
 * `humane.feature-flags` push, so they fetch it now rather than at their next
 * daily sync; `delivery` says whether that push was queued.
 */

const PRIVATE = { "cache-control": "private, no-store" };

async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

async function requireWearer(): Promise<Session | Response> {
  const session = await currentSession();
  return session ?? NextResponse.json({ error: "Not authenticated." }, { status: 401 });
}

export async function GET() {
  const session = await requireWearer();
  if (session instanceof Response) return session;
  const read = await readFeatures();
  switch (read.kind) {
    case "live":
      return NextResponse.json(read.features, { headers: PRIVATE });
    case "expired":
      return sessionExpiredResponse();
    case "absent":
      return NextResponse.json({ error: "This Center is not connected to Pin services." }, { status: 503 });
    case "degraded":
      return NextResponse.json({ error: "Features couldn’t be loaded right now." }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  return change(request, "PUT");
}

export async function DELETE(request: Request) {
  return change(request, "DELETE");
}

type ChangeBody = { name?: unknown; value?: unknown };

function isFeatureValue(value: unknown): value is boolean | number | string {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

async function change(request: Request, method: "PUT" | "DELETE") {
  const session = await requireWearer();
  if (session instanceof Response) return session;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
  }

  let body: ChangeBody | null;
  try {
    body = (await boundedJsonBody(request, {
      tooLargeMessage: "That feature update is too large.",
    })) as ChangeBody | null;
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (method === "PUT" && !isFeatureValue(body?.value)) {
    return NextResponse.json({ error: "Choose on, off, or a value for this feature." }, { status: 400 });
  }

  const value = method === "PUT" ? (body?.value as boolean | number | string) : undefined;
  return answer(await writeFeature(name, method, value), name, session);
}

async function answer(write: FeatureWrite, name: string, session: Session) {
  switch (write.kind) {
    case "saved":
      return NextResponse.json(
        { ...write.feature, delivery: await queueFeatureSync(session.sub) },
        { headers: PRIVATE },
      );
    case "restored":
      // Nothing to deliver when there was no choice to forget.
      return NextResponse.json(
        {
          name,
          deleted: write.deleted,
          delivery: write.deleted ? await queueFeatureSync(session.sub) : "next_sync",
        },
        { headers: PRIVATE },
      );
    case "refused":
      return NextResponse.json({ error: write.reason }, { status: 400 });
    case "unknown":
      return NextResponse.json({ error: "That feature is not available here." }, { status: 400 });
    case "expired":
      return sessionExpiredResponse();
    case "absent":
      return NextResponse.json({ error: "This Center is not connected to Pin services." }, { status: 503 });
    case "degraded":
      return NextResponse.json({ error: "This feature couldn’t be saved. Try again." }, { status: 502 });
  }
}
