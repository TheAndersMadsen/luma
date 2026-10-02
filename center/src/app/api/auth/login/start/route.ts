import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ENABLED,
  authorizeUrl,
  newCodeVerifier,
  newNonce,
  newState,
  originFromHeaders,
  pkceChallenge,
  safeInternalPath,
} from "@/server/auth";

export const runtime = "nodejs";

/**
 * GET /api/auth/login/start, begin the faithful Authorization Code + PKCE flow.
 *
 * Mints a PKCE verifier, state and nonce, stashes them in short-lived httpOnly
 * cookies, and 302s the browser to Keycloak's hosted login on this same origin
 * (nginx proxies /realms → Keycloak). Keycloak returns the user to
 * /api/auth/callback/humane with an authorization code.
 */
export async function GET(request: NextRequest) {
  if (!AUTH_ENABLED) {
    // No Keycloak configured (local dev): fall back to the password form.
    return NextResponse.redirect(new URL("/login?fallback=1", request.nextUrl.origin));
  }

  const origin = originFromHeaders(request.headers) ?? request.nextUrl.origin;
  const next = safeInternalPath(request.nextUrl.searchParams.get("next"));
  const redirectUri = `${origin}/api/auth/callback/humane`;

  const state = newState();
  const nonce = newNonce();
  const verifier = newCodeVerifier();
  const challenge = await pkceChallenge(verifier);

  const res = NextResponse.redirect(
    authorizeUrl(origin, { redirectUri, state, nonce, codeChallenge: challenge }),
  );

  // Transient, httpOnly, sameSite=lax so they survive Keycloak's top-level GET
  // redirect back to the callback. Short-lived, the ceremony is seconds long.
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("oidc_state", state, opts);
  res.cookies.set("oidc_nonce", nonce, opts);
  res.cookies.set("oidc_verifier", verifier, opts);
  res.cookies.set("oidc_next", next, opts);
  return res;
}
