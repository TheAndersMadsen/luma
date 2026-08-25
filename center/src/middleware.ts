import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  isOperatorPath,
  operatorGateOutcome,
  verifySession,
} from "@/server/auth";
import {
  PUBLIC_CONTENT_PATHS,
  preferredPublicRepresentation,
  publicPageFromMarkdownPath,
  publicPageMarkdown,
} from "@/lib/public-site";
import {
  consumePublicApiQuota,
  publicRateLimitHeaders,
} from "@/lib/public-rate-limit";

const PUBLIC_MACHINE_PATHS = new Set([
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
  /^\/settings\/(?:about|contacts|privacy)$/u,
  /^\/settings\/account(?:\/(?:details|devices|features|orders|services))?$/u,
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

function publicApiClient(request: NextRequest): string {
  return request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    "unidentified";
}

function rateLimitedPublicApi(request: NextRequest): NextResponse {
  const quota = consumePublicApiQuota(publicApiClient(request));
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
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/** Dynamic Center responses contain wearer or deployment state and are never shared-cacheable. */
function privateResponse(response: NextResponse): NextResponse {
  // `no-transform` keeps intermediaries from buffering or re-encoding a
  // response; without it the assistant's streamed turn can be held back until
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

/** Opaque, expiring stream tickets are the only public gateway surface. */
export function isPublicMusicStreamRequest(pathname: string, method: string): boolean {
  return (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") &&
    /^\/api\/music-gateway\/stream\/[A-Za-z0-9_-]{43}$/u.test(pathname);
}

/**
 * Gate every route behind the session cookie when auth is configured.
 *
 * Open when no Keycloak is configured (local dev). Otherwise: the login page and
 * its auth API are always reachable; everything else needs a valid session.
 * Unauthenticated API calls get a 401 (so the client can react) while page loads
 * redirect to /login with a `next` hint.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;

  const explicitMarkdown = publicPageFromMarkdownPath(pathname);
  if (explicitMarkdown) {
    return markdownResponse(publicPageMarkdown(explicitMarkdown.path) ?? "");
  }

  if (PUBLIC_CONTENT_PATHS.has(pathname)) {
    const representation = preferredPublicRepresentation(request.headers.get("accept"));
    if (representation === null) {
      return new NextResponse("Available representations: text/html, text/markdown\n", {
        status: 406,
        headers: { "content-type": "text/plain; charset=utf-8", vary: "Accept" },
      });
    }
    if (representation === "markdown") {
      return markdownResponse(publicPageMarkdown(pathname) ?? "");
    }
    if (pathname === "/") {
      const session = AUTH_ENABLED ? await verifySession(sessionToken) : null;
      if (!AUTH_ENABLED || session) return privateResponse(NextResponse.next());
      const url = request.nextUrl.clone();
      url.pathname = "/welcome";
      return publicResponse(NextResponse.rewrite(url));
    }
    return publicResponse(NextResponse.next());
  }

  if (PUBLIC_MACHINE_PATHS.has(pathname)) {
    return publicResponse(NextResponse.next());
  }

  if (
    RATE_LIMITED_PUBLIC_API_PATHS.has(pathname) &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return rateLimitedPublicApi(request);
  }

  // Operator routes always fail closed, including local deployments where the
  // wearer surface is intentionally open — which is why this branch sits ABOVE
  // the `!AUTH_ENABLED` open door below. The internal admin token is not an
  // authorization boundary for the browser; only an operator session may make
  // the BFF inject it.
  //
  // Both denials apply to PAGE paths as well as API paths: an API caller gets a
  // status it can branch on (401/403) and a browser gets moved off the route
  // (307), so `/admin/pin/terminal` — a root shell on the wearer's Pin — never
  // renders for a session that is merely signed in.
  if (isOperatorPath(pathname)) {
    const outcome = operatorGateOutcome(await verifySession(sessionToken));
    if (outcome === "unauthenticated") {
      if (pathname.startsWith("/api/")) {
        return privateResponse(NextResponse.json({ error: "Not authenticated." }, { status: 401 }));
      }
      const url = request.nextUrl.clone();
      url.pathname = AUTH_ENABLED ? "/login" : "/";
      url.search = "";
      if (AUTH_ENABLED) url.searchParams.set("next", pathname);
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
    return privateResponse(NextResponse.next());
  }

  // Immutable, read-only Pin release download surface. The installer needs it
  // before a Center session exists — a wearer recovering a bricked Pin may have
  // no working sign-in. The route handler owns its exact cache and hardening
  // headers — the release contract requires `cache-control: no-store, max-age=0`
  // and `x-content-type-options: nosniff` verbatim — so middleware passes it
  // through untouched rather than applying the private-response rewrite, which
  // would clobber those headers into `private, …, must-revalidate`.
  if (isPublicPinReleaseRequest(pathname, request.method)) {
    return NextResponse.next();
  }

  if (
    isDeviceMusicGatewayRequest(pathname, request.method) ||
    isPublicMusicStreamRequest(pathname, request.method)
  ) {
    return NextResponse.next();
  }

  // Public utilities and share links still carry private/no-store semantics:
  // query parameters can describe login state, and a share response must never
  // be reused for another recipient. Keep this ahead of unknown-path handling.
  if (
    pathname === "/login" ||
    pathname === "/wifi" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/share/") ||
    pathname.startsWith("/api/share/")
  ) {
    const response = NextResponse.next();
    if (pathname.startsWith("/share/") || pathname.startsWith("/api/share/")) {
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set("x-content-type-options", "nosniff");
    }
    return privateResponse(response);
  }

  // Let Next answer unknown public paths with its real 404. Authentication
  // applies only to routes that actually exist; otherwise every probe becomes
  // a login-page soft 404 and agents cannot discover the site's boundaries.
  if (!pathname.startsWith("/api/") && !isProtectedPageRequest(pathname)) {
    if (preferredPublicRepresentation(request.headers.get("accept")) === "markdown") {
      return markdownResponse(
        "# Page not found\n\nThis path does not exist. See [/sitemap.xml](/sitemap.xml), [/llms.txt](/llms.txt), or [/developers](/developers).\n",
        404,
      );
    }
    return publicResponse(NextResponse.next());
  }

  if (!AUTH_ENABLED) return privateResponse(NextResponse.next());
  const session = await verifySession(sessionToken);
  if (session) return privateResponse(NextResponse.next());

  if (pathname.startsWith("/api/")) {
    return privateResponse(NextResponse.json({ error: "Not authenticated." }, { status: 401 }));
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname);
  return privateResponse(NextResponse.redirect(url));
}

export const config = {
  /*
   * Everything except Next internals and the six named files in `public/`.
   *
   * NAMED, NOT SNIFFED. This used to end in `|.*\.(?:png|jpg|…|woff2?)$`, a
   * suffix test against the WHOLE pathname rather than against a static-asset
   * prefix — so any path at all skipped the gate below by ending in one of those
   * extensions. `/api/capture/memory/{uuid}/file/0` answered 401; the same URL
   * with `.png` glued on reached the route handler with no session, because that
   * handler coerces its last segment with `Number(index) || 0` and silently
   * swallowed the extension. Wearer PAGE paths went the same way: `/captures/x.png`
   * rendered the signed-in app shell to an anonymous caller. Nothing was
   * disclosed — Cosmos returns the sealed envelope to a non-Web caller and the
   * channel key refuses to resolve without a wearer identity, so the bytes were
   * never producible — but the authentication gate genuinely did not run, and
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
