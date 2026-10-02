import { cookies } from "next/headers";
import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  sessionCookieOptions,
  keycloakLogin,
  loginRefusalResponse,
  originFromHeaders,
  sealTokens,
  setTokenCookies,
  signSession,
} from "@/server/auth";
import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import {
  beginLoginAttempt,
  loginThrottle,
  loginThrottleResponse,
  settleLoginAttempt,
} from "@/server/loginThrottle";
import { requestClientAddress } from "@/lib/public-rate-limit";

/**
 * POST /api/auth/login, verify email/password against Keycloak and set the
 * session cookie. Body: `{ username, password }`.
 *
 * The Keycloak tokens stay on the server. Only our own httpOnly session cookie
 * reaches the browser.
 */
export async function POST(request: Request) {
  if (!AUTH_ENABLED) {
    return Response.json(
      { error: "Login is not configured on this deployment." },
      { status: 503 },
    );
  }

  // Bounded before parsed, this is the one write an anonymous caller can
  // reach, so a huge body must be refused, not buffered, and must not count as
  // a login attempt either.
  let body: { username?: string; password?: string };
  try {
    body = (await boundedJsonBody(request, {
      tooLargeMessage: "That sign-in attempt is too large.",
    })) as { username?: string; password?: string };
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!username || !password) {
    return Response.json({ error: "Enter your email and password." }, { status: 400 });
  }

  // Refused before Keycloak is asked, with the honest wait: Keycloak's own
  // lockout answers exactly like a wrong password.
  const address = requestClientAddress(request.headers);
  const throttle = loginThrottle(address, username);
  if (!throttle.allowed) {
    const { status, error, retryAfterSeconds } = loginThrottleResponse(throttle);
    return Response.json({ error }, { status, headers: { "retry-after": String(retryAfterSeconds) } });
  }

  const attempt = beginLoginAttempt(address, username);
  const result = await keycloakLogin({ username, password });
  if ("refused" in result) {
    settleLoginAttempt(attempt, result.refused === "credentials" ? "wrong-password" : "not-counted");
    const origin = originFromHeaders(request.headers) ?? new URL(request.url).origin;
    const { status, error } = loginRefusalResponse(result.refused, origin);
    return Response.json({ error }, { status });
  }
  settleLoginAttempt(attempt, "signed-in");
  const { session, tokens } = result;

  const token = await signSession(session, tokens.expiresAt);
  const jar = await cookies();
  const cookieOptions = sessionCookieOptions;
  // The browser gate…
  jar.set(SESSION_COOKIE, token, cookieOptions);
  // …and the Keycloak tokens the BFF forwards as a Bearer, encrypted so the
  // access token is never readable from the cookie itself.
  setTokenCookies(jar, await sealTokens(tokens), cookieOptions);

  return Response.json({ ok: true, sub: session.sub, email: session.email, name: session.name });
}
