import { cookies } from "next/headers";
import {
  CARRY_ADMIN_ENABLED,
  CARRY_WEBAPI,
  adminAuthHeaders,
  carryDeadlineSignal,
} from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { getCaptures, getContacts, getNotes } from "@/server/source";
import { SESSION_COOKIE, verifySession } from "@/server/auth";

/**
 * GET /api/admin/overview — the operator console's headline state, proxied from
 * the clone's admin surface (`/demo-api/admin/overview`): enrollment status, the
 * enrollment pincode, persistence counts, and the provisioned-credential tally.
 *
 * The admin token is injected here and never leaves the server. When no token is
 * configured the console is simply unavailable — the clone would refuse the call
 * anyway (it fails admin endpoints closed).
 *
 * Two failures, two status codes, because the console has to tell them apart:
 *
 *   503  no admin token on this dashboard — a build-time fact, nothing to retry
 *   502  the backend did not answer — a runtime fact, worth retrying
 *
 * They both used to be 503, so "you never configured this" and "your backend is
 * down" rendered as the same card.
 */
export async function GET() {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (!session.operator) {
    return Response.json({ error: "Operator access required." }, { status: 403 });
  }
  if (!CARRY_ADMIN_ENABLED) {
    return Response.json(
      { error: "The operator console is not configured (no CARRY_ADMIN_TOKEN)." },
      {
        status: 503,
        headers: sourceHeaders({ source: "unconfigured", state: "absent", fallback: "empty" }),
      },
    );
  }
  try {
    const res = await fetch(`${CARRY_WEBAPI}/demo-api/admin/overview`, {
      cache: "no-store",
      signal: carryDeadlineSignal(),
      headers: adminAuthHeaders(),
    });
    if (!res.ok) {
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": "application/json",
          ...sourceHeaders({
            source: "carry",
            state: "degraded",
            fallback: "empty",
            degraded: `The backend answered ${res.status}.`,
          }),
        },
      });
    }

    const overview = (await res.json()) as Record<string, unknown>;
    const [notes, captures, contacts] = await Promise.all([
      getNotes(),
      getCaptures(),
      getContacts(),
    ]);
    overview.persistence = {
      notes: notes.state === "live" ? notes.data.length : null,
      memories: captures.state === "live" ? captures.data.length : null,
      contacts: contacts.state === "live" ? contacts.data.length : null,
    };
    overview.persistenceScope = "authenticated-wearer";
    overview.persistenceProvenance = {
      notes: { state: notes.state, degraded: notes.degraded ?? null },
      memories: { state: captures.state, degraded: captures.degraded ?? null },
      contacts: { state: contacts.state, degraded: contacts.degraded ?? null },
    };

    const degradedDomains = [
      { domain: "notes", state: notes.state },
      { domain: "memories", state: captures.state },
      { domain: "contacts", state: contacts.state },
    ].filter(({ state }) => state !== "live");
    const degraded = degradedDomains.length > 0
      ? `Authenticated wearer projection unavailable for ${degradedDomains
          .map(({ domain }) => domain)
          .join(", ")}.`
      : undefined;

    return Response.json(overview, {
      status: res.status,
      headers: {
        ...sourceHeaders({
          source: "carry",
          state: degraded ? "degraded" : "live",
          fallback: degraded ? "empty" : undefined,
          degraded,
        }),
      },
    });
  } catch {
    return Response.json(
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
  }
}
