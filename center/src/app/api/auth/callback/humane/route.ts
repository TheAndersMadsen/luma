import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  sessionCookieOptions,
  exchangeCode,
  originFromHeaders,
  safeInternalPath,
  sealTokens,
  setTokenCookies,
  signSession,
} from "@/server/auth";

export const runtime = "nodejs";

/**
 * GET /api/auth/callback/humane, the OIDC redirect_uri.
 *
 * Keycloak sends the browser here with ?code&state. We validate state against
 * the cookie set at /login/start, exchange the code (with the PKCE verifier) for
 * tokens at the INTERNAL Keycloak, verify the id_token + nonce, then mint the
 * signed session cookie and land the user on their `next` page.
 *
 * The encrypted Keycloak token set is split across bounded httpOnly cookie
 * chunks.  This preserves the verified Bearer plane without crossing the
 * browser's per-cookie limit.
 */
function fail(origin: string, reason: string): NextResponse {
  // Never leak details into the URL. Just send the user back to the sign-in page.
  const url = new URL("/login", origin);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const origin = originFromHeaders(request.headers) ?? request.nextUrl.origin;
  if (!AUTH_ENABLED) return fail(origin, "unconfigured");

  const params = request.nextUrl.searchParams;
  const kcError = params.get("error");
  if (kcError) return fail(origin, kcError);

  const code = params.get("code");
  const state = params.get("state");
  const jar = request.cookies;
  const expectedState = jar.get("oidc_state")?.value;
  const nonce = jar.get("oidc_nonce")?.value ?? "";
  const verifier = jar.get("oidc_verifier")?.value ?? "";
  const next = safeInternalPath(jar.get("oidc_next")?.value);

  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return fail(origin, "state");
  }

  const result = await exchangeCode({
    code,
    redirectUri: `${origin}/api/auth/callback/humane`,
    codeVerifier: verifier,
    expectedNonce: nonce,
    acceptIssuerOrigin: origin,
  });
  if (!result) return fail(origin, "exchange");

  const token = await signSession(result.session, result.tokens.expiresAt);

  const res = NextResponse.redirect(new URL(next, origin));
  const opts = sessionCookieOptions;
  res.cookies.set(SESSION_COOKIE, token, opts);
  setTokenCookies(res.cookies, await sealTokens(result.tokens), opts);
  // Clear the transient ceremony cookies.
  for (const name of ["oidc_state", "oidc_nonce", "oidc_verifier", "oidc_next"]) {
    res.cookies.set(name, "", { ...opts, maxAge: 0 });
  }
  return res;
}
