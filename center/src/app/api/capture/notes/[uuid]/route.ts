import { NextResponse } from "next/server";
import { SessionExpiredError } from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { deleteNote } from "@/server/source";

const SIGN_IN_AGAIN = "Your session expired — sign in again.";

/**
 * The wearer-fixable failure, answered the way api/settings/wifi answers it —
 * and containing this route's own contract while it does: **`degraded` present
 * means nothing was deleted**, which the UI reads before it removes anything
 * from the screen. A 401 with no `degraded` would have been rendered as "the
 * backend answered 401" instead of the one thing the wearer can act on.
 */
function reauthenticate(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: SIGN_IN_AGAIN,
      degraded: SIGN_IN_AGAIN,
      note: SIGN_IN_AGAIN,
      reauthenticate: true,
    },
    { status: 401 },
  );
}

/**
 * DELETE /api/capture/notes/{uuid} — delete ONE note.
 *
 * Its sibling `DELETE /api/capture/notes` is the all-or-nothing one this
 * backend used to be limited to (`DeleteAllNotes`); a wearer who wanted a single
 * note gone had to lose every note they had written. Underneath this is the
 * clone's `DELETE /notes/:uuid`, principal-scoped.
 *
 * Same one-line contract as the other two delete routes: **`degraded` present
 * means nothing was deleted**, on the 200 as well as the 502, and the UI reads
 * it before it removes anything from the screen. Never 500.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await context.params;
  try {
    const result = await deleteNote(uuid);

    // One expiry, one answer. `deleteNote` degrades rather than throws, so the
    // flag is how it reaches here; without it the note stayed put behind a 502
    // that blamed the REST plane for the wearer's dead Keycloak grant.
    if (result.reauthenticate) return reauthenticate();

    const headers = sourceHeaders(result);

    // `deleted: true` is the backend confirming a row went away. A 200 alone is
    // not that — the REST contract answers 200 for "nothing matched" as well.
    if (result.data.deleted) {
      return NextResponse.json({ ok: true }, { status: 200, headers });
    }

    const note = result.degraded ?? "nothing was deleted";

    // 502 only when cosmos is configured and did not answer, because that is the
    // only one of these a retry can fix. The rest are honest 200s that are
    // nonetheless not a success: the note is still there.
    return NextResponse.json(
      { ok: false, degraded: note, note },
      { status: result.state === "degraded" ? 502 : 200, headers },
    );
  } catch (error) {
    if (error instanceof SessionExpiredError) return reauthenticate();
    const note = error instanceof Error ? error.message : "delete failed";
    return NextResponse.json({ ok: false, degraded: note, note }, { status: 502 });
  }
}
