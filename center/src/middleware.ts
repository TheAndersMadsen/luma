import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ENABLED,
  AuthUnavailableError,
  readTokenCookie,
  renewBrowserSession,
  sealTokens,
  sessionCookieOptions,
  setTokenCookies,
  signSession,
  SESSION_COOKIE,
  isOperatorPath,
  operatorGateOutcome,
  verifySession,
} from "@/server/auth";
import {
  preferredPublicRepresentation,
} from "@/lib/public-site";
import {
  consumePublicApiQuota,
  publicRateLimitHeaders,
  requestClientAddress,
} from "@/lib/public-rate-limit";

const PUBLIC_MACHINE_PATHS = new Set([
  "/cloud-init.yaml",
  "/install.sh",
  "/llms.txt",
  "/openapi.json",
  "/robots.txt",
  "/sitemap.xml",
]);

const RATE_LIMITED_PUBLIC_API_PATHS = new Set([
  "/api/version",
  "/api/pin/releases/current",
]);

const PROTECTED_PAGE_PATTERNS = [
  /^\/captures(?:\/[^/]+)?$/u,
  /^\/notes(?:\/(?:new|search|[^/]+))?$/u,
  /^\/my-data(?:\/(?:ai-mic|calls|music|translation))?$/u,
  /^\/settings$/u,
  /^\/settings\/(?:about|contacts|food|privacy)$/u,
  /^\/settings\/account(?:\/(?:details|devices|features|music|orders|security|services))?$/u,
  /^\/devices$/u,
  /^\/settings\/pin$/u,
  /^\/settings\/pin\/(?:activity|contacts|diagnostics|esim|fitness|flags|gallery|install|llm|provision|server|services|setup)$/u,
  /^\/settings\/pin\/conversations(?:\/[^/]+)?$/u,
  /^\/settings\/pin\/gallery\/[^/]+$/u,
  /^\/admin$/u,
  /^\/admin\/pin\/terminal$/u,
  /^\/talk$/u,
] as const;

export function isProtectedPageRequest(pathname: string): boolean {
  return PROTECTED_PAGE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function appendVary(response: NextResponse, ...names: string[]): NextResponse {
  const existing = (response.headers.get("vary") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const combined = [...new Set([...existing, ...names])];
  response.headers.set("vary", combined.join(", "));
  return response;
}

function publicResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "public, max-age=300, s-maxage=3600");
  response.headers.set("x-content-type-options", "nosniff");
  return appendVary(response, "Accept", "Accept-Encoding");
}

function markdownResponse(markdown: string, status = 200): NextResponse {
  return publicResponse(new NextResponse(markdown, {
    status,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  }));
}

function rateLimitedPublicApi(request: NextRequest): NextResponse {
  const quota = consumePublicApiQuota(requestClientAddress(request.headers));
  const headers = publicRateLimitHeaders(quota);
  if (!quota.allowed) {
    return new NextResponse(JSON.stringify({
      type: "https://iana.org/assignments/http-problem-types#quota-exceeded",
      title: "Public read quota exceeded",
      status: 429,
      detail: `Retry after ${quota.resetSeconds} seconds.`,
    }), {
      status: 429,
      headers: {
        ...headers,
        "content-type": "application/problem+json",
        "retry-after": String(quota.resetSeconds),
        "cache-control": "private, no-store",
      },
    });
  }
  const response = NextResponse.next({ request: { headers: request.headers } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/** Dynamic Center responses contain wearer or deployment state and are never shared-cacheable. */
function privateResponse(response: NextResponse): NextResponse {
  // `no-transform` keeps intermediaries from buffering or re-encoding a
  // response. Without it the assistant's streamed turn can be held back until
  // it completes.
  response.headers.set(
    "cache-control",
    "private, no-store, max-age=0, must-revalidate, no-transform",
  );
  response.headers.set("pragma", "no-cache");
  response.headers.set("expires", "0");
  return response;
}

/** Public only for the immutable, read-only Pin release download surface. */
export function isPublicPinReleaseRequest(pathname: string, method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return (
    pathname.startsWith("/api/pin/releases/") &&
    (normalizedMethod === "GET" ||
      normalizedMethod === "HEAD" ||
      normalizedMethod === "OPTIONS")
  );
}

/** The Pin authenticates these exact POSTs with a derived device bearer. */
export function isDeviceMusicGatewayRequest(pathname: string, method: string): boolean {
  return method.toUpperCase() === "POST" && new Set([
    "/api/music-gateway/query",
    "/api/music-gateway/playback",
    "/api/music-gateway/save",
  ]).has(pathname);
}

/** Cosmos authenticates this one exact internal lookup with its admin bearer. */
export function isInternalMusicQueryRequest(pathname: string, method: string): boolean {
  return method.toUpperCase() === "POST" && pathname === "/api/internal/music/query";
}

/**
 * Gate every route behind the session cookie when auth is configured.
 *
 * Open when no Keycloak is configured (local dev). Otherwise: the login page and
 * its auth API are always reachable. Everything else needs a valid session.
 * Unauthenticated API calls get a 401 (so the client can react) while page loads
 * redirect to /login with a `next` hint.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const privateApi = pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/auth/") && !RATE_LIMITED_PUBLIC_API_PATHS.has(pathname) &&
    !isPublicPinReleaseRequest(pathname, request.method) &&
    !isDeviceMusicGatewayRequest(pathname, request.method) &&
    !isInternalMusicQueryRequest(pathname, request.method);
  // INFERRED Luma UX: renew before route/SSR guards run, so a return visit
  // works in one request. Logout and public pages never depend on Keycloak.
  const renewalCookies = new NextResponse();
  if (AUTH_ENABLED && (pathname === "/" || isProtectedPageRequest(pathname) || isOperatorPath(pathname) || privateApi) &&
      !await verifySession(request.cookies.get(SESSION_COOKIE)?.value)) {
    try {
      const renewed = await renewBrowserSession(readTokenCookie(request.cookies));
      if (renewed) {
        renewalCookies.cookies.set(SESSION_COOKIE, await signSession(renewed.session, renewed.tokens.expiresAt), sessionCookieOptions);
        setTokenCookies(renewalCookies.cookies, await sealTokens(renewed.tokens), sessionCookieOptions);
        for (const cookie of renewalCookies.cookies.getAll()) {
          if (cookie.maxAge === 0) request.cookies.delete(cookie.name);
          else request.cookies.set(cookie.name, cookie.value);
        }
      }
    } catch (error) {
      if (!(error instanceof AuthUnavailableError)) throw error;
      if (pathname.startsWith("/api/")) {
        return privateResponse(NextResponse.json({ error: error.message, authUnavailable: true },
          { status: 503, headers: { "retry-after": "5" } }));
      }
      // Do not send a temporary outage to the password form or erase cookies.
      return privateResponse(new NextResponse(
        '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reconnecting · Center</title>' +
        '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:18px system-ui"><main style="max-width:30rem;padding:32px">' +
        '<h1>One moment.</h1><p>Center is reconnecting. Your sign-in is still saved.</p><p>Try again in a moment.</p><a style="color:#80ffe5" href="">Try again</a></main></body></html>',
        { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "5" } },
      ));
    }
  }
  const response = await routeRequest(request);
  for (const cookie of renewalCookies.cookies.getAll()) response.cookies.set(cookie);
  return response;
}

async function routeRequest(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;

  if (pathname === "/") {
    // The whole front door: anonymous people go to sign-in, the signed-in get
    // the dashboard. There is no public landing page.
    const session = AUTH_ENABLED ? await verifySession(sessionToken) : null;
    if (!AUTH_ENABLED || session) return privateResponse(NextResponse.next({ request: { headers: request.headers } }));
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return privateResponse(NextResponse.redirect(url));
  }

  if (PUBLIC_MACHINE_PATHS.has(pathname)) {
    return publicResponse(NextResponse.next({ request: { headers: request.headers } }));
  }

  if (
    RATE_LIMITED_PUBLIC_API_PATHS.has(pathname) &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return rateLimitedPublicApi(request);
  }

  // Operator routes always fail closed, including local deployments where the
  // wearer surface is intentionally open, which is why this branch sits ABOVE
  // the `!AUTH_ENABLED` open door below. The internal admin token is not an
  // authorization boundary for the browser. Only an operator session may make
  // the BFF inject it.
  //
  // Both denials apply to PAGE paths as well as API paths: an API caller gets a
  // status it can branch on (401/403) and a browser gets moved off the route
  // (307), so `/admin/pin/terminal`, full administrator control of the Pin,
  // never renders for a session that is merely signed in.
  if (isOperatorPath(pathname)) {
    const outcome = operatorGateOutcome(await verifySession(sessionToken));
    if (outcome === "unauthenticated") {
      if (pathname.startsWith("/api/")) {
        return privateResponse(NextResponse.json({ error: "Reconnect to Center to continue.", reauthenticate: true }, { status: 401 }));
      }
      const url = request.nextUrl.clone();
      url.pathname = AUTH_ENABLED ? "/login" : "/";
      url.search = "";
      if (AUTH_ENABLED) url.searchParams.set("next", pathname + request.nextUrl.search);
      return privateResponse(NextResponse.redirect(url));
    }
    if (outcome === "forbidden") {
      if (pathname.startsWith("/api/")) {
        return privateResponse(NextResponse.json({ error: "Operator access required." }, { status: 403 }));
      }
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return privateResponse(NextResponse.redirect(url));
    }
    return privateResponse(NextResponse.next({ request: { headers: request.headers } }));
  }

  // Immutable, read-only Pin release download surface. The installer needs it
  // before a Center session exists, a wearer recovering a bricked Pin may have
  // no working sign-in. The route handler owns its exact cache and hardening
  // headers, the release contract requires `cache-control: no-store, max-age=0`
  // and `x-content-type-options: nosniff` verbatim, so middleware passes it
  // through untouched rather than applying the private-response rewrite, which
  // would clobber those headers into `private, …, must-revalidate`.
  if (isPublicPinReleaseRequest(pathname, request.method)) {
    return NextResponse.next({ request: { headers: request.headers } });
  }

  if (isDeviceMusicGatewayRequest(pathname, request.method)) {
    return NextResponse.next({ request: { headers: request.headers } });
  }

  if (isInternalMusicQueryRequest(pathname, request.method)) {
    return NextResponse.next({ request: { headers: request.headers } });
  }

  // Public utilities and share links still carry private/no-store semantics:
  // query parameters can describe login state, and a share response must never
  // be reused for another recipient. Keep this ahead of unknown-path handling.
  if (
    pathname === "/login" ||
    pathname === "/wifi" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/humane.center/share/")
  ) {
    if (!pathname.startsWith("/humane.center/share/")) return privateResponse(NextResponse.next({ request: { headers: request.headers } }));
    // The stock share-link path. Every view asks Cosmos to open a frame, so an
    // anonymous caller gets the same bounded quota as the public read API.
    const response = rateLimitedPublicApi(request);
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-content-type-options", "nosniff");
    return privateResponse(response);
  }

  // Let Next answer unknown public paths with its real 404. Authentication
  // applies only to routes that actually exist. Otherwise every probe becomes
  // a login-page soft 404 and agents cannot discover the site's boundaries.
  if (!pathname.startsWith("/api/") && !isProtectedPageRequest(pathname)) {
    if (preferredPublicRepresentation(request.headers.get("accept")) === "markdown") {
      return markdownResponse(
        "# Page not found\n\nThis path does not exist. See [/sitemap.xml](/sitemap.xml), [/llms.txt](/llms.txt), or [/openapi.json](/openapi.json).\n",
        404,
      );
    }
    return publicResponse(NextResponse.next({ request: { headers: request.headers } }));
  }

  if (!AUTH_ENABLED) return privateResponse(NextResponse.next({ request: { headers: request.headers } }));
  const session = await verifySession(sessionToken);
  if (session) return privateResponse(NextResponse.next({ request: { headers: request.headers } }));

  if (pathname.startsWith("/api/")) {
    return privateResponse(NextResponse.json({ error: "Reconnect to Center to continue.", reauthenticate: true }, { status: 401 }));
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname + request.nextUrl.search);
  return privateResponse(NextResponse.redirect(url));
}

export const config = {
  /*
   * Everything except Next internals and the six named files in `public/`.
   *
   * NAMED, NOT SNIFFED. This used to end in `|.*\.(?:png|jpg|…|woff2?)$`, a
   * suffix test against the WHOLE pathname rather than against a static-asset
   * prefix, so any path at all skipped the gate below by ending in one of those
   * extensions. `/api/capture/memory/{uuid}/file/0` answered 401. The same URL
   * with `.png` glued on reached the route handler with no session, because that
   * handler coerces its last segment with `Number(index) || 0` and silently
   * swallowed the extension. Wearer PAGE paths went the same way: `/captures/x.png`
   * rendered the signed-in app shell to an anonymous caller. Nothing was
   * disclosed, Cosmos opens a frame only for a verified wearer, so the bytes
   * were never producible, but the authentication gate genuinely did not run, and
   * "safe because of what happens two layers down" is not a gate.
   *
   * `public/` holds exactly favicon.ico, apple-touch-icon.png, the two PWA icons,
   * manifest.json and fonts/. Listing them cannot grow to cover a route, which
   * is the property the extension test lacked. A new public asset must be added
   * here on purpose.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|apple-touch-icon\\.png|icon-192\\.png|icon-512\\.png|manifest\\.json|fonts/).*)",
  ],
};
