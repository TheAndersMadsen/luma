import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { isSameOriginRequest, SESSION_COOKIE, verifySession, type Session } from "@/server/auth";

/**
 * Feature-flag administration, proxied to the clone's operator API
 * (`/demo-api/flags`). The device pulls these at startup and after a privacy
 * sync, so a change here reaches the Pin on its next flag sync — no restart.
 *
 * GET    — list every flag (operator-only; defaults are operational state too).
 * PUT    — `{ name, value }` set a runtime override (admin-token gated).
 * DELETE — `{ name }` clear one override, or no body to reset them all.
 *
 * On the wire the backend calls the fields `observed` and `effective`. `observed`
 * is NOT a capture of what live cosmos served: it is this deployment's own coded
 * default with runtime overrides suppressed, which is why the console renders it
 * as "Default here" rather than repeating a claim the data cannot support.
 *
 * Status codes are distinguishable on purpose: 503 means this deployment is not
 * configured for the call (a build-time fact — nothing to retry), 502 means the
 * backend did not answer (a runtime fact — worth retrying).
 */
const noBackend = () =>
  NextResponse.json(
    { error: "No data service is configured (no COSMOS_WEBAPI_BASE_URL)." },
    { status: 503, headers: sourceHeaders({ source: "unconfigured", state: "absent", fallback: "empty" }) },
  );

const noAdminToken = () =>
  NextResponse.json(
    { error: "The operator console is not configured (no COSMOS_ADMIN_TOKEN)." },
    { status: 503, headers: sourceHeaders({ source: "unconfigured", state: "absent", fallback: "empty" }) },
  );

const unreachable = () =>
  NextResponse.json(
    { error: "The backend is unreachable." },
    {
      status: 502,
      headers: sourceHeaders({
        source: "unreachable",
        state: "degraded",
        fallback: "empty",
        degraded: "The backend is unreachable.",
      }),
    },
  );

const FEATURE_FLAG_METRICS = (process.env.COSMOS_FEATURE_FLAGS_METRICS_URL ?? "").replace(/\/$/, "");

type FlagDelivery = "device_fetched" | "push_queued" | "next_sync";

async function successfulGetFlagsCount(): Promise<number | null> {
  if (!FEATURE_FLAG_METRICS) return null;
  const response = await fetch(
    `${FEATURE_FLAG_METRICS}/manage/metrics/carry_rpc_requests_total`,
    { cache: "no-store" },
  ).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    measurements?: Array<{ statistic?: string; value?: number }>;
  } | null;
  const count = body?.measurements?.find((measurement) => measurement.statistic === "COUNT")?.value;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

async function waitForFreshGetFlags(previous: number): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const current = await successfulGetFlagsCount();
    if (current !== null && current > previous) return true;
  }
  return false;
}

async function deliverFlagChange(accountSub: string): Promise<FlagDelivery> {
  // Sample after the write and immediately before the push. A later increment
  // proves that Cosmos served a successful GetFlags call after this save; it
  // does not overclaim that every long-lived stock consumer rebuilt its map.
  const before = await successfulGetFlagsCount();
  const pushed = await queueFlagSync(accountSub);
  if (!pushed) return "next_sync";
  if (before !== null && (await waitForFreshGetFlags(before))) return "device_fetched";
  return "push_queued";
}

async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

async function currentOperator(): Promise<Session | Response> {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (!session.operator) {
    return NextResponse.json({ error: "Operator access required." }, { status: 403 });
  }
  return session;
}

async function queueFlagSync(accountSub: string): Promise<boolean> {
  if (!COSMOS_WEBAPI) return false;
  const response = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/push`, {
    method: "POST",
    headers: { ...adminAuthHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      account_sub: accountSub,
      app_name: "humane.feature-flags",
      data_payload: [],
      expiration_seconds: 86_400,
    }),
    cache: "no-store",
    signal: cosmosDeadlineSignal(),
  }).catch(() => null);
  return response?.ok === true;
}

export async function GET() {
  const operator = await currentOperator();
  if (operator instanceof Response) return operator;
  if (!COSMOS_ADMIN_ENABLED) return noAdminToken();
  if (!COSMOS_WEBAPI) return noBackend();
  try {
    const res = await fetch(`${COSMOS_WEBAPI}/demo-api/flags`, {
      headers: adminAuthHeaders(),
      cache: "no-store",
      signal: cosmosDeadlineSignal(),
    });
    return NextResponse.json(await res.json().catch(() => []), {
      status: res.status,
      headers: sourceHeaders(
        res.ok
          ? { source: "cosmos", state: "live" }
          : {
              source: "cosmos",
              state: "degraded",
              fallback: "empty",
              degraded: `The backend answered ${res.status}.`,
            },
      ),
    });
  } catch {
    return unreachable();
  }
}

export async function PUT(request: Request) {
  const session = await currentOperator();
  if (session instanceof Response) return session;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  if (!COSMOS_ADMIN_ENABLED) return noAdminToken();
  let body: { name?: string; value?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "A flag name is required." }, { status: 400 });
  try {
    const res = await fetch(`${COSMOS_WEBAPI}/demo-api/flags/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { ...adminAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ value: body.value }),
      signal: cosmosDeadlineSignal(),
    });
    const responseBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return NextResponse.json(responseBody, { status: res.status });
    const delivery = await deliverFlagChange(session.sub);
    return NextResponse.json({ ...responseBody, delivery });
  } catch {
    return unreachable();
  }
}

export async function DELETE(request: Request) {
  const session = await currentOperator();
  if (session instanceof Response) return session;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  if (!COSMOS_ADMIN_ENABLED) return noAdminToken();
  let name = "";
  try {
    const body = await request.json();
    name = (body?.name ?? "").trim();
  } catch {
    // No body → reset every override. The console gates that on a typed
    // confirmation, because it rewrites device-visible behaviour on a live Pin.
  }
  const path = name ? `/demo-api/flags/${encodeURIComponent(name)}` : "/demo-api/flags";
  try {
    const res = await fetch(`${COSMOS_WEBAPI}${path}`, {
      method: "DELETE",
      headers: adminAuthHeaders(),
      signal: cosmosDeadlineSignal(),
    });
    const responseBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return NextResponse.json(responseBody, { status: res.status });
    const delivery = await deliverFlagChange(session.sub);
    return NextResponse.json({ ...responseBody, delivery });
  } catch {
    return unreachable();
  }
}
