/*
 * Server-side enforcement of the operator boundary.
 *
 * `middleware.ts` is the first gate and refuses operator paths before a route
 * ever runs. This module is the SECOND gate, for surfaces where being wrong
 * once is unacceptable — the Pin device shell is a root shell on the wearer's
 * device — so the decision is made again inside the render, from the session
 * cookie, on the server. Middleware's matcher is a regex that has to keep
 * excluding static assets; a guard that lives in the route itself cannot be
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

/** The caller's verified session, or null. Reading cookies also opts the route out of static rendering. */
export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

/**
 * For SERVER COMPONENTS (pages and layouts). Returns the operator's session, or
 * never returns: a caller without a session is sent to sign in, and a signed-in
 * caller without the operator claim is moved off the route entirely — the same
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
  // No Keycloak (local `next dev`) means no session can ever carry the operator
  // claim — `verifySession` pins it to `AUTH_ENABLED && payload.operator` — so
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
 * working without a fake login; production always sets `KEYCLOAK_BASE_URL`.
 */
export async function requireWearerRequest(): Promise<Session | Response | null> {
  if (!AUTH_ENABLED) return null;
  const session = await currentSession();
  if (!session) return Response.json({ error: "Not authenticated." }, { status: 401 });
  return session;
}
