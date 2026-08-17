import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isSameOriginRequest, SESSION_COOKIE, verifySession, type Session } from "@/server/auth";
import {
  queueFeatureSync,
  readWearerFeatures,
  WEARER_FEATURES,
  writeWearerFeature,
} from "@/server/domain/settings";

/**
 * Wearer-visible feature flags. The allowlist, the flag-store access, and the
 * sync nudge live in `@/server/domain/settings`; this route owns the wearer
 * session gate, same-origin enforcement, and the stable HTTP bodies.
 */

async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

function unavailable() {
  return NextResponse.json({ error: "Features are unavailable right now." }, { status: 503 });
}

async function requireWearer(): Promise<Session | Response> {
  const session = await currentSession();
  return session ?? NextResponse.json({ error: "Not authenticated." }, { status: 401 });
}

export async function GET() {
  const session = await requireWearer();
  if (session instanceof Response) return session;
  const flags = await readWearerFeatures();
  if (flags === null) return unavailable();
  return NextResponse.json(flags, {
    headers: { "cache-control": "private, no-store" },
  });
}

export async function PUT(request: Request) {
  return writeFeature(request, "PUT");
}

export async function DELETE(request: Request) {
  return writeFeature(request, "DELETE");
}

async function writeFeature(request: Request, method: "PUT" | "DELETE") {
  const session = await requireWearer();
  if (session instanceof Response) return session;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { name?: string; value?: unknown } | null;
  const name = body?.name?.trim() ?? "";
  if (!WEARER_FEATURES.has(name)) {
    return NextResponse.json({ error: "That feature is not available here." }, { status: 400 });
  }

  const write = await writeWearerFeature(name, body?.value, method);
  if (!write.ok) {
    if (write.unconfigured) return unavailable();
    return NextResponse.json(
      { error: "This feature couldn’t be saved." },
      { status: write.status ?? 502 },
    );
  }
  return NextResponse.json({ ...write.result, delivery: await queueFeatureSync(session.sub) }, {
    headers: { "cache-control": "private, no-store" },
  });
}
