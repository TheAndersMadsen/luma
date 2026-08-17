import { cookies } from "next/headers";
import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  keycloakLogin,
  sealTokens,
  setTokenCookies,
  signSession,
} from "@/server/auth";

/**
 * POST /api/auth/login — verify email/password against Keycloak and set the
 * session cookie. Body: `{ username, password }`.
 *
 * The Keycloak tokens stay on the server; only our own httpOnly session cookie
 * reaches the browser.
 */
export async function POST(request: Request) {
  if (!AUTH_ENABLED) {
    return Response.json(
      { error: "Login is not configured on this deployment." },
      { status: 503 },
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!username || !password) {
    return Response.json({ error: "Enter your email and password." }, { status: 400 });
  }

  const result = await keycloakLogin({ username, password });
  if (!result) {
    return Response.json({ error: "Those credentials were not accepted." }, { status: 401 });
  }
  const { session, tokens } = result;

  const token = await signSession(session);
  const jar = await cookies();
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
  // The browser gate…
  jar.set(SESSION_COOKIE, token, cookieOptions);
  // …and the Keycloak tokens the BFF forwards as a Bearer, encrypted so the
  // access token is never readable from the cookie itself.
  setTokenCookies(jar, await sealTokens(tokens), cookieOptions);

  return Response.json({ ok: true, email: session.email, name: session.name });
}
