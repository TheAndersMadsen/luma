import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  CARRY_ADMIN_ENABLED,
  CARRY_WEBAPI,
  adminAuthHeaders,
  carryDeadlineSignal,
} from "@/server/cosmos";
import { isSameOriginRequest, SESSION_COOKIE, verifySession, type Session } from "@/server/auth";

const WEARER_FEATURES = new Set([
  "touchcode_enabled",
  "touchcode_timeout_millis",
  "vision_custom_gesture_enabled",
  "quick_actions_remapping_enabled",
  "music_interstitials_enabled",
  "tickle",
  "cmu_ultra_enabled",
  "cmu_ultra_chime_enabled",
  "vision_actions_enabled",
  "fitness_tracker_enabled",
  "fitness_tracker_extra_data_enabled",
  "esim_qr_scanner_enabled",
  "network_reset_enabled",
]);

async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

function unavailable() {
  return NextResponse.json({ error: "Features are unavailable right now." }, { status: 503 });
}

async function queueSync(accountSub: string): Promise<"push_queued" | "next_sync"> {
  if (!CARRY_WEBAPI) return "next_sync";
  const response = await fetch(`${CARRY_WEBAPI}/demo-api/admin/push`, {
    method: "POST",
    headers: { ...adminAuthHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      account_sub: accountSub,
      app_name: "humane.feature-flags",
      data_payload: [],
      expiration_seconds: 86_400,
    }),
    cache: "no-store",
    signal: carryDeadlineSignal(),
  }).catch(() => null);
  return response?.ok ? "push_queued" : "next_sync";
}

async function requireWearer(): Promise<Session | Response> {
  const session = await currentSession();
  return session ?? NextResponse.json({ error: "Not authenticated." }, { status: 401 });
}

export async function GET() {
  const session = await requireWearer();
  if (session instanceof Response) return session;
  if (!CARRY_ADMIN_ENABLED || !CARRY_WEBAPI) return unavailable();
  const response = await fetch(`${CARRY_WEBAPI}/demo-api/flags`, {
    headers: adminAuthHeaders(),
    cache: "no-store",
    signal: carryDeadlineSignal(),
  }).catch(() => null);
  if (!response?.ok) return unavailable();
  const body = (await response.json().catch(() => [])) as Array<{ name?: string }>;
  return NextResponse.json(body.filter((flag) => flag.name && WEARER_FEATURES.has(flag.name)), {
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
  if (!CARRY_ADMIN_ENABLED || !CARRY_WEBAPI) return unavailable();

  const body = (await request.json().catch(() => null)) as { name?: string; value?: unknown } | null;
  const name = body?.name?.trim() ?? "";
  if (!WEARER_FEATURES.has(name)) {
    return NextResponse.json({ error: "That feature is not available here." }, { status: 400 });
  }

  const response = await fetch(`${CARRY_WEBAPI}/demo-api/flags/${encodeURIComponent(name)}`, {
    method,
    headers: { ...adminAuthHeaders(), "content-type": "application/json" },
    body: method === "PUT" ? JSON.stringify({ value: body?.value }) : undefined,
    cache: "no-store",
    signal: carryDeadlineSignal(),
  }).catch(() => null);
  if (!response?.ok) {
    return NextResponse.json({ error: "This feature couldn’t be saved." }, { status: response?.status ?? 502 });
  }
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json({ ...result, delivery: await queueSync(session.sub) }, {
    headers: { "cache-control": "private, no-store" },
  });
}
