/*
 * Authentication seam — Keycloak as the identity store, a signed session cookie
 * as the credential the browser carries.
 *
 * Humane fronted .Center with Keycloak (`auth.humane.center/realms/humane`,
 * client `center`). This mirrors that: a simple email/password page posts to the
 * BFF, the BFF verifies the credentials against Keycloak with the OAuth2 Resource
 * Owner Password grant, and on success mints a short-lived session JWT signed with
 * a server secret. The Keycloak tokens never reach the browser; only our own
 * session cookie does, which `middleware.ts` verifies on every request.
 *
 * Auth is enabled exactly when a Keycloak base URL is configured. Local `next dev`
 * with no Keycloak stays open, the same convention the carry BFF uses for its own
 * backend — production always sets KEYCLOAK_BASE_URL, so production is always
 * gated.
 */

import { SignJWT, jwtVerify, EncryptJWT, jwtDecrypt, createRemoteJWKSet } from "jose";

const REALM = process.env.KEYCLOAK_REALM ?? "humane";
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? "center";
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET ?? "";
const KEYCLOAK_BASE_URL = (process.env.KEYCLOAK_BASE_URL ?? "").replace(/\/$/, "");
const SESSION_SECRET = process.env.AUTH_SESSION_SECRET ?? "";
const OPERATOR_ROLE = "carry-operator";
const OPERATOR_EMAILS = new Set(
  (process.env.CARRY_OPERATOR_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

export const SESSION_COOKIE = "carry_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;
export const AUTH_ENABLED = KEYCLOAK_BASE_URL.length > 0;

const DEV_FALLBACK_SECRET = "carry-center-dev-session-secret-change-me";

function secretKey(): Uint8Array {
  if (SESSION_SECRET) return new TextEncoder().encode(SESSION_SECRET);
  // Fail CLOSED: never guard a Keycloak-configured deployment with the
  // source-visible dev fallback. Without the secret an attacker could forge a
  // session JWT signed by the known key; throwing here makes signing AND
  // verification fail (deny) instead of silently accepting forgeries. The
  // fallback stays only for local `next dev`, where auth is disabled entirely.
  if (AUTH_ENABLED) {
    throw new Error("AUTH_SESSION_SECRET is required when KEYCLOAK_BASE_URL is set.");
  }
  return new TextEncoder().encode(DEV_FALLBACK_SECRET);
}

/**
 * The browser session deliberately retains only the authorization decision.
 * Raw Keycloak roles remain in Keycloak's encrypted token cookie and are never
 * copied into the signed browser-gate JWT.
 */
export type Session = { sub: string; email: string; name: string; operator: boolean };

export async function signSession(session: Session): Promise<string> {
  return await new SignJWT({
    email: session.email,
    name: session.name,
    operator: session.operator === true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

/** Verify a session cookie. Runs in the edge middleware, so jose only — no Node APIs. */
export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return {
      sub: String(payload.sub ?? ""),
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      // Old sessions did not contain the claim and therefore fail closed.
      // The source-visible development signing key may never unlock the
      // operator plane. Without Keycloak, operator access stays denied even if
      // a caller fabricates a syntactically valid local session.
      operator: AUTH_ENABLED && payload.operator === true,
    };
  } catch {
    return null;
  }
}

export type Credentials = { username: string; password: string };

function roleList(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const roles = (value as { roles?: unknown }).roles;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
}

/**
 * Resolve the one operator bit from Keycloak claims. Both supported Keycloak
 * placements are accepted: a realm role and a role on this Center client.
 * The exact-email allowlist is an optional self-hosted bootstrap seam; an empty
 * allowlist grants nobody.
 */
export function operatorClaimFromKeycloakClaims(
  claims: Record<string, unknown>,
  email: string,
): boolean {
  const realmRoles = roleList(claims.realm_access);
  const resourceAccess = claims.resource_access;
  const clientRoles = resourceAccess && typeof resourceAccess === "object"
    ? roleList((resourceAccess as Record<string, unknown>)[CLIENT_ID])
    : [];
  return (
    realmRoles.includes(OPERATOR_ROLE) ||
    clientRoles.includes(OPERATOR_ROLE) ||
    OPERATOR_EMAILS.has(email.trim().toLowerCase())
  );
}

/*
 * ── The operator boundary ───────────────────────────────────────────────────
 *
 * Two functions, deliberately adjacent: which paths are operator-only, and what
 * a given session is entitled to on one. `middleware.ts` (edge runtime) and the
 * server-side page guard in `operator.ts` (Node runtime) both call these — the
 * rule is never restated, so it cannot drift between the two enforcement points.
 */

/**
 * The Pin device shell over WebUSB is a ROOT shell on the wearer's device: it
 * opens `shell.pty` on the Pin with no further authorization, so whoever can
 * load that page can run anything on the Pin as root. It is therefore an
 * OPERATOR surface, and it lives under `/admin/` for exactly one reason — that
 * prefix is what `isOperatorPath` gates. Moving it out from under `/admin/`
 * removes the only thing standing between a signed-in wearer and that shell.
 */
export const OPERATOR_PIN_SHELL_PATH = "/admin/pin/terminal";

/** Every route beneath this prefix is operator-only, and additionally server-guarded by `app/admin/pin/layout.tsx`. */
export const OPERATOR_PIN_PATH_PREFIX = "/admin/pin";

/**
 * Where the device shell sat while the Pin console was a standalone SPA.
 * Nothing serves this path, and nothing should: it is named here so that
 * re-creating the shell at the "obvious" settings location fails CLOSED rather
 * than becoming reachable by every signed-in wearer. Exact match only — the
 * rest of `/settings/pin/*` is a wearer surface and stays ungated.
 */
export const RETIRED_WEARER_SHELL_PATH = "/settings/pin/terminal";

/** A path-level decision shared by middleware, the page guard, and narrow routing tests. */
export function isOperatorPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/api/admin" ||
    pathname.startsWith("/api/admin/") ||
    pathname === "/settings/pin/terminal"
  );
}

/**
 * What a session is entitled to on an operator path.
 *
 * `unauthenticated` and `forbidden` are distinguished because they are answered
 * differently (sign in, versus you are signed in and still may not), never
 * because one of them is softer: both deny. Fails closed on every shape that is
 * not an explicitly-`true` operator claim — no session, an expired one, a
 * session minted before the claim existed, and any truthy-but-not-`true` value.
 */
export type OperatorGateOutcome = "allow" | "unauthenticated" | "forbidden";

export function operatorGateOutcome(
  session: { operator?: unknown } | null | undefined,
): OperatorGateOutcome {
  if (!session) return "unauthenticated";
  return session.operator === true ? "allow" : "forbidden";
}

/** Browser mutation requests must come from the same public origin. */
export function isSameOriginRequest(request: Request): boolean {
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) return false;
  const expectedOrigin = originFromHeaders(request.headers) ?? new URL(request.url).origin;
  try {
    return new URL(suppliedOrigin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

/**
 * Verify credentials against Keycloak via the Resource Owner Password grant and
 * return the resolved identity, or `null` when Keycloak rejects them.
 *
 * Node-runtime only (the login route): it decodes the returned id_token with
 * `Buffer`, which the edge runtime does not provide.
 */
export async function keycloakPasswordLogin({ username, password }: Credentials): Promise<Session | null> {
  if (!AUTH_ENABLED) return null;
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: CLIENT_ID,
    username,
    password,
    scope: "openid email profile",
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);

  const res = await fetch(`${KEYCLOAK_BASE_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    // Same bound as the refresh below: a sign-in that hangs is a sign-in that
    // failed, and a wearer staring at a spinner learns less than one told so.
    signal: AbortSignal.timeout(KEYCLOAK_DEADLINE_MS),
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const token = (await res.json()) as { id_token?: string; access_token?: string };
  const identityClaims = decodeJwtClaims(token.id_token ?? token.access_token);
  const accessClaims = decodeJwtClaims(token.access_token);
  const email = String(identityClaims.email ?? username);
  return {
    sub: String(identityClaims.sub ?? username),
    email,
    name: String(identityClaims.name ?? identityClaims.preferred_username ?? username),
    operator:
      operatorClaimFromKeycloakClaims(identityClaims, email) ||
      operatorClaimFromKeycloakClaims(accessClaims, email),
  };
}

function decodeJwtClaims(jwt: string | undefined): Record<string, unknown> {
  if (!jwt) return {};
  try {
    const payload = jwt.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

// ── Keycloak token retention (the Bearer plane) ──────────────────────────────
//
// The session cookie above gates the browser; these carry the actual Keycloak
// tokens the BFF forwards to carry as `Authorization: Bearer`, so the backend
// verifies the wearer's identity by Keycloak's OWN signature
// (carry-server/src/web_auth.rs) rather than trusting a principal header we
// chose. Kept in a SEPARATE, ENCRYPTED cookie the edge middleware never opens —
// only the Node BFF does — so a live access token never rides in a
// merely-signed payload.

export const TOKENS_COOKIE = "carry_tokens";

// Chromium rejects a Set-Cookie header once the name, encrypted value, and
// attributes cross the per-cookie limit (roughly 4 KiB).  A Keycloak
// access+refresh+id token set can exceed that even after it is wrapped in one
// compact JWE.  Keep the JWE stateless and encrypted, but split it into bounded
// chunks with a tiny manifest in the base cookie.
const TOKEN_COOKIE_FORMAT = "v1";
const TOKEN_COOKIE_CHUNK_BYTES = 3000;
const TOKEN_COOKIE_MAX_CHUNKS = 4;

type CookieReader = {
  get(name: string): { value: string } | undefined;
};

type CookieWriter = {
  set(
    name: string,
    value: string,
    options?: {
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "lax" | "strict" | "none";
      path?: string;
      maxAge?: number;
    },
  ): unknown;
};

type TokenCookieOptions = Parameters<CookieWriter["set"]>[2];

function tokenChunkName(index: number): string {
  return `${TOKENS_COOKIE}.${index}`;
}

/** Reassemble the encrypted token JWE without exposing it to browser JS. */
export function readTokenCookie(jar: CookieReader): string | undefined {
  const base = jar.get(TOKENS_COOKIE)?.value;
  if (!base) return undefined;

  const match = /^v1:(\d+)$/.exec(base);
  if (!match) return base; // Backward-compatible with the old single cookie.

  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1 || count > TOKEN_COOKIE_MAX_CHUNKS) {
    return undefined;
  }
  const chunks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = jar.get(tokenChunkName(index))?.value;
    if (!value) return undefined;
    chunks.push(value);
  }
  return chunks.join("");
}

/** Write one encrypted JWE as browser-safe cookie chunks. */
export function setTokenCookies(
  jar: CookieWriter,
  sealed: string,
  options: TokenCookieOptions,
): void {
  const chunks = sealed.match(new RegExp(`.{1,${TOKEN_COOKIE_CHUNK_BYTES}}`, "g")) ?? [];
  if (chunks.length < 1 || chunks.length > TOKEN_COOKIE_MAX_CHUNKS) {
    throw new Error("Encrypted token set exceeds the supported cookie budget.");
  }

  jar.set(TOKENS_COOKIE, `${TOKEN_COOKIE_FORMAT}:${chunks.length}`, options);
  chunks.forEach((value, index) => jar.set(tokenChunkName(index), value, options));
  for (let index = chunks.length; index < TOKEN_COOKIE_MAX_CHUNKS; index += 1) {
    jar.set(tokenChunkName(index), "", { ...options, maxAge: 0 });
  }
}

/** Clear the manifest, every possible chunk, and a legacy single-cookie value. */
export function clearTokenCookies(jar: CookieWriter, options: TokenCookieOptions = {}): void {
  jar.set(TOKENS_COOKIE, "", { ...options, maxAge: 0 });
  for (let index = 0; index < TOKEN_COOKIE_MAX_CHUNKS; index += 1) {
    jar.set(tokenChunkName(index), "", { ...options, maxAge: 0 });
  }
}

export type CarryTokens = {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds at which the access token expires. */
  expiresAt: number;
  /** The OIDC id_token, retained so logout can drive an RP-initiated end-session. */
  idToken?: string;
};

/**
 * A256GCM needs a 32-byte key; derive one from the session secret. Web Crypto
 * only, so this stays usable in both the Node and edge runtimes.
 */
async function tokenKey(): Promise<Uint8Array> {
  if (!SESSION_SECRET && AUTH_ENABLED) {
    throw new Error("AUTH_SESSION_SECRET is required when KEYCLOAK_BASE_URL is set.");
  }
  const raw = new TextEncoder().encode(SESSION_SECRET || DEV_FALLBACK_SECRET);
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return new Uint8Array(digest);
}

export async function sealTokens(tokens: CarryTokens): Promise<string> {
  return await new EncryptJWT({
    at: tokens.accessToken,
    rt: tokens.refreshToken,
    ea: tokens.expiresAt,
    it: tokens.idToken ?? "",
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .encrypt(await tokenKey());
}

export async function openTokens(
  cookieValue: string | undefined,
): Promise<CarryTokens | null> {
  if (!cookieValue) return null;
  try {
    const { payload } = await jwtDecrypt(cookieValue, await tokenKey());
    const accessToken = String(payload.at ?? "");
    const refreshToken = String(payload.rt ?? "");
    const expiresAt = Number(payload.ea ?? 0);
    const idToken = String(payload.it ?? "");
    if (!accessToken) return null;
    return { accessToken, refreshToken, expiresAt, idToken: idToken || undefined };
  } catch {
    return null;
  }
}

function tokensFromResponse(
  tok: { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string },
  fallbackRefresh?: string,
): CarryTokens | null {
  if (!tok.access_token) return null;
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? fallbackRefresh ?? "",
    // A 60s floor mirrors the BFF's own refresh threshold: never hand back a
    // token that is already inside the window we would immediately refresh.
    expiresAt: Math.floor(Date.now() / 1000) + (tok.expires_in ?? 300),
    idToken: tok.id_token,
  };
}

/**
 * Exchange a refresh token for a fresh access token, or null if Keycloak
 * declines (expired SSO session, revoked grant, IdP down).
 */
/*
 * A page fans out into the list request plus several image requests. When the
 * access token enters its refresh window, all of those requests see the same
 * encrypted cookie and can arrive here together. Keycloak rotates refresh
 * tokens, so only the first exchange is guaranteed to succeed; the rest used
 * to fall back to the static/device identity and the image route rendered a
 * permanent "sealed" tile.
 *
 * Share one exchange for the same refresh token, and retain its result briefly
 * so a request that started a few milliseconds later still reuses the rotated
 * credentials. The token remains process-local and is never logged.
 */
const REFRESH_REUSE_WINDOW_MS = 5_000;
const refreshFlights = new Map<
  string,
  { promise: Promise<CarryTokens | null>; expiresAt: number }
>();

export async function refreshTokens(
  refreshToken: string,
): Promise<CarryTokens | null> {
  if (!AUTH_ENABLED || !refreshToken) return null;

  const now = Date.now();
  const existing = refreshFlights.get(refreshToken);
  if (existing && existing.expiresAt > now) return existing.promise;

  const promise = exchangeRefreshToken(refreshToken);
  const entry = { promise, expiresAt: now + REFRESH_REUSE_WINDOW_MS };
  refreshFlights.set(refreshToken, entry);
  setTimeout(() => {
    if (refreshFlights.get(refreshToken) === entry) {
      refreshFlights.delete(refreshToken);
    }
  }, REFRESH_REUSE_WINDOW_MS).unref?.();
  return promise;
}

/**
 * How long the token exchange may take before Center gives up on it.
 *
 * WHY THIS EXISTS AT ALL. This one call sits on the critical path of every
 * authenticated request — `requestBearer` awaits it inside the pre-expiry
 * window, under both `requestMetadata()` and `webapiHeaders()` — and it had no
 * signal, so undici's 300s default was its only bound. It is also UPSTREAM of
 * every deadline Center owns: `call()` awaits `requestMetadata()` before it
 * computes `Date.now() + DEADLINE_MS`, so the gRPC deadline is rebased after the
 * hang and CARRY_DEADLINE_MS bounds nothing across it.
 *
 * The wearer-visible half of that is a Memories page that skeletons for two
 * minutes and then says "Couldn't load your memories" — an outage sentence for a
 * condition whose real name is "sign in again". The sharper half needs no hang
 * at all: `webapiGet` used to construct its 8s AbortSignal BEFORE awaiting the
 * headers, so a merely SLOW Keycloak spent the whole capture deadline on the
 * auth hop and the request arrived already aborted, at which point
 * `describeWebapi` reported "carry webapi timed out" — Center blaming a
 * perfectly healthy Cosmos for an IdP stall, and sending whoever is on call to
 * the wrong service. (That ordering is fixed too, in cosmos.ts and in
 * webapiDelete.)
 *
 * Well under CARRY_DEADLINE_MS, because everything downstream of it still needs
 * time to answer inside the same request.
 */
const KEYCLOAK_DEADLINE_MS = Number(process.env.KEYCLOAK_DEADLINE_MS ?? 5000);

async function exchangeRefreshToken(refreshToken: string): Promise<CarryTokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);

  const res = await fetch(
    `${KEYCLOAK_BASE_URL}/realms/${REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      // A refresh that times out is treated exactly like a refresh Keycloak
      // declined: null here makes `requestBearer` raise SessionExpiredError, the
      // route answers 401 + `reauthenticate`, and the wearer is told the one
      // thing they can act on.
      signal: AbortSignal.timeout(KEYCLOAK_DEADLINE_MS),
    },
  ).catch(() => null);
  if (!res || !res.ok) return null;
  return tokensFromResponse(await res.json(), refreshToken);
}

/**
 * Password login that ALSO returns the raw Keycloak tokens, for the BFF to
 * forward as a Bearer. `keycloakPasswordLogin` above stays the session-only
 * door for any caller that does not need the tokens.
 */
export async function keycloakLogin(
  credentials: Credentials,
): Promise<{ session: Session; tokens: CarryTokens } | null> {
  if (!AUTH_ENABLED) return null;
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: CLIENT_ID,
    username: credentials.username,
    password: credentials.password,
    scope: "openid email profile",
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);

  const res = await fetch(
    `${KEYCLOAK_BASE_URL}/realms/${REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(KEYCLOAK_DEADLINE_MS),
    },
  ).catch(() => null);
  if (!res || !res.ok) return null;

  const tok = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const tokens = tokensFromResponse(tok);
  if (!tokens) return null;
  const identityClaims = decodeJwtClaims(tok.id_token ?? tok.access_token);
  const accessClaims = decodeJwtClaims(tok.access_token);
  const email = String(identityClaims.email ?? credentials.username);
  const session: Session = {
    sub: String(identityClaims.sub ?? credentials.username),
    email,
    name: String(identityClaims.name ?? identityClaims.preferred_username ?? credentials.username),
    operator:
      operatorClaimFromKeycloakClaims(identityClaims, email) ||
      operatorClaimFromKeycloakClaims(accessClaims, email),
  };
  return { session, tokens };
}

// ── OIDC Authorization Code + PKCE (the faithful front door) ─────────────────
//
// The real .Center had NO first-party login form: `/auth/signin` bounced the
// browser to Keycloak's hosted login (Authorization Code + PKCE) and received
// the user back at /api/auth/callback/humane. This restores that flow.
//
// To keep the backend Bearer plane working unchanged (carry-server trusts
// Keycloak's INTERNAL issuer), the flow is SPLIT: the BROWSER visits Keycloak at
// the app's own public origin — nginx proxies /realms and /resources to Keycloak
// on the same host — while the BFF exchanges the code and verifies the id_token
// against the INTERNAL issuer (KEYCLOAK_BASE_URL). So the id_token/access_token
// we retain still carry the internal `iss` the backend already accepts: no
// backend change, no Keycloak hostname change, fully reversible.

const OIDC_PATH = `/realms/${REALM}/protocol/openid-connect`;
const ISSUER = `${KEYCLOAK_BASE_URL}/realms/${REALM}`;

/**
 * The browser-facing origin, derived from the proxy's forwarded headers.
 *
 * `request.nextUrl.origin` reports the server's own bind address (localhost:4000)
 * behind `next start` + a reverse proxy, so it can't be used to build redirect
 * URIs. Cloudflare/nginx forward the real host and scheme, so read those.
 */
export function originFromHeaders(h: Headers): string | null {
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

/**
 * Sanitise a post-login `next` target to a same-origin path, defeating open
 * redirects. `startsWith('/')` alone is not enough — a protocol-relative
 * `//evil.com` (or the backslash variant `/\evil.com`) also starts with '/' and
 * the WHATWG URL parser resolves it to an external origin. Anything that is not
 * a plain internal path collapses to "/".
 */
export function safeInternalPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

/**
 * Faithful scope set from the recovered authorization request was:
 *   openid email profile partner-services contacts dispatcher settings
 *   account-service capture ai-bus feedback feature-flags privacy
 * Requesting a scope the realm has NOT defined makes Keycloak reject the whole
 * request (invalid_scope) — which would lock login out — so we default to the
 * always-present core and let the deploy widen it via KEYCLOAK_SCOPES once the
 * realm defines the service scopes.
 */
export const OIDC_SCOPES = process.env.KEYCLOAK_SCOPES ?? "openid email profile";

/** URL-safe base64 with no padding, for PKCE / state / nonce. */
function base64UrlNoPad(buf: Uint8Array): string {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafe(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlNoPad(buf);
}

export function newState(): string {
  return randomUrlSafe(16);
}
export function newNonce(): string {
  return randomUrlSafe(16);
}
export function newCodeVerifier(): string {
  return randomUrlSafe(32);
}

/** S256 PKCE challenge for a verifier. Web Crypto, so edge- and node-safe. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlNoPad(new Uint8Array(digest));
}

/**
 * Browser-facing authorize URL. `publicBase` is the app's own origin (where
 * nginx proxies Keycloak's /realms), so the hosted login renders on the same
 * domain the user is already on.
 */
export function authorizeUrl(
  publicBase: string,
  params: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
): string {
  const u = new URL(`${publicBase}${OIDC_PATH}/auth`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("scope", OIDC_SCOPES);
  u.searchParams.set("state", params.state);
  u.searchParams.set("nonce", params.nonce);
  u.searchParams.set("code_challenge", params.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** RP-initiated logout endpoint, so the Keycloak SSO session is actually killed. */
export function endSessionUrl(
  publicBase: string,
  args: { idTokenHint?: string; postLogoutRedirectUri: string },
): string {
  const u = new URL(`${publicBase}${OIDC_PATH}/logout`);
  if (args.idTokenHint) u.searchParams.set("id_token_hint", args.idTokenHint);
  u.searchParams.set("post_logout_redirect_uri", args.postLogoutRedirectUri);
  u.searchParams.set("client_id", CLIENT_ID);
  return u.toString();
}

// The id_token signature is verified against Keycloak's JWKS at the INTERNAL
// issuer. Cached across calls (createRemoteJWKSet memoises the key fetch).
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
function realmJwks() {
  if (!jwksCache) jwksCache = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`));
  return jwksCache;
}

/**
 * Verify a Keycloak id_token: signature (JWKS), issuer, audience, expiry, and
 * the nonce echoed from our authorize request. Returns the identity or null.
 *
 * `acceptIssuerOrigin` widens the accepted issuer to that public origin too:
 * Keycloak resolves the token's `iss` from the request's frontend URL, so a code
 * minted at the browser's public origin but exchanged at the internal one can
 * legitimately carry either issuer. The JWKS (realm keys) verifies the signature
 * regardless, so accepting both is safe.
 */
export async function verifyIdToken(
  idToken: string | undefined,
  expectedNonce: string,
  acceptIssuerOrigin?: string,
): Promise<Session | null> {
  if (!idToken) return null;
  const issuers = acceptIssuerOrigin
    ? [ISSUER, `${acceptIssuerOrigin}/realms/${REALM}`]
    : ISSUER;
  try {
    const { payload } = await jwtVerify(idToken, realmJwks(), {
      issuer: issuers,
      audience: CLIENT_ID,
    });
    if (expectedNonce && payload.nonce !== expectedNonce) return null;
    return {
      sub: String(payload.sub ?? ""),
      email: String(payload.email ?? ""),
      name: String(payload.name ?? payload.preferred_username ?? payload.email ?? ""),
      operator: operatorClaimFromKeycloakClaims(
        payload as Record<string, unknown>,
        String(payload.email ?? ""),
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Exchange the authorization code for tokens at the INTERNAL Keycloak token
 * endpoint (so the tokens carry the internal `iss`), then verify the id_token
 * and its nonce. Returns the verified session plus the retained tokens, or null.
 */
export async function exchangeCode(args: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  expectedNonce: string;
  /** Public origin the browser used, whose issuer is also accepted (see verifyIdToken). */
  acceptIssuerOrigin?: string;
}): Promise<{ session: Session; tokens: CarryTokens } | null> {
  if (!AUTH_ENABLED) return null;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);

  const res = await fetch(`${KEYCLOAK_BASE_URL}${OIDC_PATH}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(KEYCLOAK_DEADLINE_MS),
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const tok = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const tokens = tokensFromResponse(tok);
  if (!tokens) return null;
  const session = await verifyIdToken(tok.id_token, args.expectedNonce, args.acceptIssuerOrigin);
  if (!session) return null;
  // Keycloak commonly maps client roles only into the access token. The token
  // came directly from the authenticated token exchange above; collapse that
  // role information immediately into the one signed-session boolean.
  session.operator =
    session.operator ||
    operatorClaimFromKeycloakClaims(decodeJwtClaims(tok.access_token), session.email);
  return { session, tokens };
}
