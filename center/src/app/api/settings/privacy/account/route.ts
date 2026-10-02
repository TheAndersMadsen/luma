import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ENABLED,
  SESSION_COOKIE,
  clearTokenCookies,
  endSessionUrl,
  isSameOriginRequest,
  openTokens,
  originFromHeaders,
  readTokenCookie,
  verifySession,
} from "@/server/auth";
import { LOST_PIN_BLOCKS_DELETION, deleteAccount } from "@/server/domain/account";
import { sessionExpiredResponse } from "@/server/routeErrors";

export const runtime = "nodejs";

const CONFIRM_PHRASE = "DELETE";
const NO_STORE = { "cache-control": "private, no-store, max-age=0" };

/**
 * DELETE /api/settings/privacy/account {confirm: "DELETE"}, Settings → Privacy
 * → Delete account.
 *
 * .Center's Privacy page carried this control behind the `accountDeletion`
 * flag (off in the recovered snapshot). No path survived, so Cosmos's
 * `DELETE /account-service/account` is INFERRED. Cosmos removes everything it
 * holds for the signed-in wearer, notes, captures and their files, events,
 * contacts, account settings, escrowed keys, Pin pairings and the passcode,
 * and answers `deleted: true` only when all of it went. While one of the
 * account's Pins is in block mode Cosmos refuses (409), because deleting the
 * account would unlock that Pin. The wearer is told to unmark it first.
 *
 * Then the wearer is signed out the way `/api/auth/logout` does it: the local
 * cookies are cleared and the answer carries Keycloak's end-session URL for the
 * browser to follow. The sign-in itself is Keycloak's and stays.
 *
 * The typed phrase is required, so the control can never fire on mount or on a
 * stray click. A cross-site request is refused.
 */
export async function DELETE(request: NextRequest) {
  if (!AUTH_ENABLED) {
    return NextResponse.json(
      { ok: false, error: "Login is not configured on this deployment." },
      { status: 503, headers: NO_STORE },
    );
  }
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401, headers: NO_STORE });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Cross-site request refused." },
      { status: 403, headers: NO_STORE },
    );
  }
  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  if (typeof body?.confirm !== "string" || body.confirm.trim() !== CONFIRM_PHRASE) {
    return NextResponse.json(
      { ok: false, error: `Type "${CONFIRM_PHRASE}" to confirm.` },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await deleteAccount();
  if (result.reauthenticate) {
    return sessionExpiredResponse({ ok: false, deleted: false }, NO_STORE);
  }
  if (result.refusal === "conflict") {
    return NextResponse.json(
      { ok: false, deleted: false, error: LOST_PIN_BLOCKS_DELETION },
      { status: 409, headers: NO_STORE },
    );
  }
  if (result.state !== "live" || result.data?.deleted !== true) {
    return NextResponse.json(
      {
        ok: false,
        deleted: false,
        error:
          result.state === "absent"
            ? "This Center is not connected to Pin services."
            : "Your account couldn’t be fully deleted. Try again to finish.",
      },
      { status: result.state === "absent" ? 503 : 502, headers: NO_STORE },
    );
  }

  const origin = originFromHeaders(request.headers) ?? request.nextUrl.origin;
  const tokens = await openTokens(readTokenCookie(request.cookies));
  const endSession = endSessionUrl(origin, {
    idTokenHint: tokens?.idToken,
    postLogoutRedirectUri: `${origin}/login`,
  });
  jar.delete(SESSION_COOKIE);
  clearTokenCookies(jar, { path: "/" });
  return NextResponse.json(
    { ok: true, deleted: true, endSessionUrl: endSession },
    { headers: NO_STORE },
  );
}
