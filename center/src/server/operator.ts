/*
 * Server-side enforcement of the operator boundary.
 *
 * `middleware.ts` is the first gate and refuses operator paths before a route
 * ever runs. This module is the SECOND gate, for surfaces where being wrong
 * once is unacceptable, the Pin console has full control of the wearer's
 * device, so the decision is made again inside the render, from the session
 * cookie, on the server. Middleware's matcher is a regex that has to keep
 * excluding static assets. A guard that lives in the route itself cannot be
 * bypassed by a matcher edit, a rewrite, or a route reached some other way.
 *
 * Both gates evaluate `operatorGateOutcome` from `@/server/auth`, so there is
 * one rule and two enforcement points, never two rules.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  operatorGateOutcome,
  verifySession,
  type Session,
} from "@/server/auth";
import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_WEBAPI,
  adminAuthHeaders,
  cosmosDeadlineSignal,
} from "@/server/cosmos";

/** The caller's verified session, or null. Reading cookies also opts the route out of static rendering. */
export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

/**
 * For SERVER COMPONENTS (pages and layouts). Returns the operator's session, or
 * never returns: a caller without a session is sent to sign in, and a signed-in
 * caller without the operator claim is moved off the route entirely, the same
 * two answers middleware gives, so the two gates cannot disagree about what a
 * denial looks like.
 */
export async function requireOperatorSession(returnTo?: string): Promise<Session> {
  const session = await currentSession();
  const outcome = operatorGateOutcome(session);
  if (outcome === "allow" && session) return session;

  if (outcome === "unauthenticated" && AUTH_ENABLED) {
    redirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login");
  }
  // No Keycloak (local `next dev`) means no session can ever contain the operator
  // claim, `verifySession` pins it to `AUTH_ENABLED && payload.operator`, so
  // this path is also how a local deployment refuses the operator plane.
  redirect("/");
}

/**
 * For ROUTE HANDLERS. Returns the operator's session, or the `Response` to send
 * back. Statuses match middleware's: 401 when there is no session, 403 when the
 * session is real but not an operator's.
 */
export async function requireOperatorRequest(): Promise<Session | Response> {
  const session = await currentSession();
  const outcome = operatorGateOutcome(session);
  if (outcome === "allow" && session) return session;
  if (outcome === "unauthenticated") {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }
  return Response.json({ error: "Operator access required." }, { status: 403 });
}

/**
 * For ROUTE HANDLERS that any signed-in wearer may call. Returns the session or
 * a 401. When no Keycloak is configured the whole deployment is open by design
 * (`middleware.ts` returns early on `!AUTH_ENABLED`), so local `next dev` keeps
 * working without a fake login. Production always sets `KEYCLOAK_BASE_URL`.
 */
export async function requireWearerRequest(): Promise<Session | Response | null> {
  if (!AUTH_ENABLED) return null;
  const session = await currentSession();
  if (!session) return Response.json({ error: "Not authenticated." }, { status: 401 });
  return session;
}

/*
 * The operator's Pin pairing actions on Cosmos's admin surface.
 *
 * A wearer pairs and releases only their own Pins, and Cosmos refuses to pair
 * a Pin another account holds. A Pin id claimed by the wrong account would stay
 * stuck, so the operator releases it here, stock sent that case to support
 * "to unlink it from your account". Each call takes the caller's session and
 * decides the operator gate again before the admin token is ever sent.
 *
 * A Pin its account has in lost-device block mode, or whose block state Cosmos
 * cannot read, is released only when the operator confirms it: released,
 * another account could pair it and set it up without block mode. Cosmos
 * refuses an unconfirmed release of one.
 */

/** One Pin on the durable Pin-to-account roster. */
export interface PinPairing {
  deviceId: string;
  /** The Keycloak `sub` of the account the Pin enrolls into. */
  accountSub: string;
  /** Seconds since the epoch; `null` when Cosmos did not say. */
  pairedAtEpoch: number | null;
  /**
   * The account it is paired to has it in lost-device block mode; `null` when
   * Cosmos could not read that account's block list.
   */
  blocked: boolean | null;
  /** When block mode was turned on, in seconds since the epoch. */
  blockedAtEpoch: number | null;
}

/** The roster, or why it could not be read. */
export type PinPairingRoster =
  | { state: "live"; pairings: PinPairing[] }
  | { state: "forbidden" | "unconfigured" | "unavailable"; pairings: [] };

/** What releasing a Pin's pairing did, or why nothing was done. */
export type PinPairingRelease =
  | "released"
  | "not-paired"
  | "blocked"
  | "invalid"
  | "forbidden"
  | "unconfigured"
  | "unavailable";

const PIN_DEVICE_ID = /^[0-9a-f]{1,64}$/u;

/** Every Pin pairing Cosmos holds (`GET /demo-api/admin/devices`). Operator only. */
export async function operatorPinPairings(session: Session | null): Promise<PinPairingRoster> {
  if (operatorGateOutcome(session) !== "allow") return { state: "forbidden", pairings: [] };
  if (!COSMOS_ADMIN_ENABLED) return { state: "unconfigured", pairings: [] };
  try {
    const response = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/devices`, {
      cache: "no-store",
      redirect: "error",
      signal: cosmosDeadlineSignal(),
      headers: adminAuthHeaders(),
    });
    if (!response.ok) return { state: "unavailable", pairings: [] };
    const body = (await response.json()) as { pairings?: unknown };
    if (!Array.isArray(body.pairings)) return { state: "unavailable", pairings: [] };
    return {
      state: "live",
      pairings: body.pairings.flatMap((value: unknown) => {
        const row = (value ?? {}) as Record<string, unknown>;
        const deviceId = typeof row.device_id === "string" ? row.device_id : "";
        const accountSub = typeof row.account_sub === "string" ? row.account_sub : "";
        const epoch = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
        return PIN_DEVICE_ID.test(deviceId) && accountSub
          ? [{
              deviceId,
              accountSub,
              pairedAtEpoch: epoch(row.paired_at_epoch),
              blocked: typeof row.blocked === "boolean" ? row.blocked : null,
              blockedAtEpoch: row.blocked === true ? epoch(row.blocked_at_epoch) : null,
            }]
          : [];
      }),
    };
  } catch {
    return { state: "unavailable", pairings: [] };
  }
}

/**
 * Release a Pin's pairing, whichever account holds it
 * (`DELETE /demo-api/admin/pairings/{deviceId}`). Operator only: a wearer's
 * session is refused here before Cosmos is asked, and Cosmos refuses anything
 * but the operator token. A Pin in block mode, or of unknown block state,
 * answers `blocked` unless `confirmBlocked` carries the operator's explicit
 * confirmation.
 */
export async function releasePinPairing(
  session: Session | null,
  deviceId: string,
  confirmBlocked = false,
): Promise<PinPairingRelease> {
  if (operatorGateOutcome(session) !== "allow") return "forbidden";
  const id = deviceId.trim().toLowerCase();
  if (!PIN_DEVICE_ID.test(id)) return "invalid";
  if (!COSMOS_ADMIN_ENABLED) return "unconfigured";
  try {
    const confirmation = confirmBlocked ? "?confirm_blocked=true" : "";
    const response = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/pairings/${id}${confirmation}`, {
      method: "DELETE",
      cache: "no-store",
      redirect: "error",
      signal: cosmosDeadlineSignal(),
      headers: adminAuthHeaders(),
    });
    if (response.status === 409) return "blocked";
    if (!response.ok) return "unavailable";
    const body = (await response.json()) as { released?: unknown };
    return body.released === true ? "released" : "not-paired";
  } catch {
    return "unavailable";
  }
}
