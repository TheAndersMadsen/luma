import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  isOperatorPath,
  operatorGateOutcome,
  verifySession,
} from "@/server/auth";

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

  if (!AUTH_ENABLED) return privateResponse(NextResponse.next());
  // Always-open: the sign-in page + its auth API, the PUBLIC share view (a shared
  // memory must be viewable by a recipient who has no .Center account), the
  // Wi-Fi QR generator, and immutable read-only Pin release downloads needed by
  // Setup before a Center session exists.
  //
  // /wifi is public on purpose. Its own stylesheet calls it "the one public page";
  // it reads NO account data and never calls the BFF — the QR payload is built
  // entirely in the browser from what you type — so nothing can leak through it.
  // And its whole reason to exist is the moment a Pin is off the network, which
  // is exactly the moment its owner may not be able to sign in.
  if (
    pathname === "/login" ||
    pathname === "/wifi" ||
    pathname === "/api/version" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/share/") ||
    pathname.startsWith("/api/share/")
  ) {
    const response = NextResponse.next();
    if (pathname.startsWith("/share/") || pathname.startsWith("/api/share/")) {
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set("x-content-type-options", "nosniff");
      response.headers.set("cache-control", "private, no-store, max-age=0");
    }
    return privateResponse(response);
  }

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
