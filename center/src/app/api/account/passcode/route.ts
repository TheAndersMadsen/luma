import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { isSameOriginRequest } from "@/server/auth";
import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { boundedJsonBody } from "@/app/api/settings/services/spotify/routeSupport";
import { getPasscodeState, isPasscode, setPasscode } from "@/server/domain/account";
import type { PasscodeView } from "@/lib/contracts/account";
import { accountWriteResponse } from "../accountWriteResponse";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };

/**
 * GET /api/account/passcode, whether the wearer has set the passcode their
 * Pin asks for during setup: `{set, state}`. The passcode itself is never
 * stored anywhere, so it can never be read back.
 */
export async function GET() {
  const result = await getPasscodeState();
  if (result.reauthenticate) {
    return NextResponse.json(
      { set: null, state: result.state, degraded: result.degraded, reauthenticate: true } satisfies PasscodeView,
      { status: 401, headers: { ...sourceHeaders(result), ...NO_STORE } },
    );
  }
  return NextResponse.json(
    { set: result.data?.set ?? null, state: result.state, degraded: result.degraded } satisfies PasscodeView,
    { headers: { ...sourceHeaders(result), ...NO_STORE } },
  );
}

/**
 * PUT /api/account/passcode {passcode}, set or change it: exactly four
 * digits. Cosmos registers it for this account alone and keeps only an OPAQUE
 * password file. The old passcode stops working at once. Answers
 * `{ok, passcode: {set}}` (see `accountWriteResponse`). The passcode is never
 * echoed.
 */
export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Cross-site request refused." },
      { status: 403, headers: NO_STORE },
    );
  }
  // Bounded before parsed: the body is four digits, never anything more.
  let raw: unknown;
  try {
    raw = await boundedJsonBody(request, { tooLargeMessage: "That request is too large." });
  } catch (error) {
    if (error instanceof SpotifyBridgeError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status, headers: NO_STORE },
      );
    }
    throw error;
  }
  const body = raw as { passcode?: unknown } | null;
  const passcode = body?.passcode;
  if (!isPasscode(passcode)) {
    return NextResponse.json(
      { ok: false, error: "A passcode is exactly four digits." },
      { status: 400, headers: NO_STORE },
    );
  }
  return accountWriteResponse("passcode", await setPasscode(passcode));
}
