import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  clearTokenCookies,
  endSessionUrl,
  originFromHeaders,
  openTokens,
  readTokenCookie,
} from "@/server/auth";

export const runtime = "nodejs";

/**
 * Logout — faithful RP-initiated end-session.
 *
 * GET  navigates the browser through Keycloak's end-session endpoint (so the SSO
 *      session AND the refresh grant are actually terminated, not just the local
 *      cookie), then back to /login.
 * POST clears the local cookies and returns the end-session URL, for the account
 *      menu's fetch-then-navigate sign-out.
 */
async function endSessionFor(request: NextRequest): Promise<string> {
  const origin = originFromHeaders(request.headers) ?? request.nextUrl.origin;
  const post = `${origin}/login`;
  if (!AUTH_ENABLED) return post;
  const tokens = await openTokens(readTokenCookie(request.cookies));
  return endSessionUrl(origin, { idTokenHint: tokens?.idToken, postLogoutRedirectUri: post });
}

export async function GET(request: NextRequest) {
  const target = await endSessionFor(request);
  const res = NextResponse.redirect(target);
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  clearTokenCookies(res.cookies, { path: "/" });
  return res;
}

export async function POST(request: NextRequest) {
  const endSession = await endSessionFor(request);
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  clearTokenCookies(jar, { path: "/" });
  return NextResponse.json({ ok: true, endSessionUrl: endSession });
}
