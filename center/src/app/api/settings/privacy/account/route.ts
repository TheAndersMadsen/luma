import { NextResponse } from "next/server";

/**
 * DELETE /api/settings/privacy/account — the account-deletion control on
 * Settings → Privacy.
 *
 * .Center's Privacy page carried a "Delete your account" action (it sat behind
 * the `accountDeletion` feature flag, which was OFF in the recovered snapshot).
 * We restore the *control* and its confirmation gate faithfully, but there is no
 * account-deletion RPC anywhere in the vendored protos — `account.proto` exposes
 * only UserInformation / FoodPreferences / WifiConfig, none of which delete an
 * account. So this endpoint is honest rather than destructive: it validates the
 * typed confirmation, then reports that deletion is not exposed by this backend.
 * It removes nothing — a made-up "account deleted" would be worse than the truth.
 *
 * The confirmation phrase must be sent explicitly; without it the request is
 * rejected, so the control can never fire on mount or on a stray click.
 */

const CONFIRM_PHRASE = "DELETE";

export async function DELETE(req: Request) {
  let body: { confirm?: unknown };
  try {
    body = (await req.json()) as { confirm?: unknown };
  } catch {
    body = {};
  }

  if (typeof body.confirm !== "string" || body.confirm.trim() !== CONFIRM_PHRASE) {
    return NextResponse.json(
      { ok: false, error: `type "${CONFIRM_PHRASE}" to confirm` },
      { status: 400 },
    );
  }

  // Confirmation is valid, but no backend endpoint performs the deletion — report
  // it honestly instead of pretending. 501 Not Implemented is the accurate status.
  return NextResponse.json(
    {
      ok: false,
      deleted: false,
      reason:
        "Account deletion is not available in Center.",
    },
    { status: 501 },
  );
}
