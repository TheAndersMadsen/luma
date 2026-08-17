import { NextResponse } from "next/server";
import { SessionExpiredError } from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { deleteEvent } from "@/server/source";

const SIGN_IN_AGAIN = "Your session expired — sign in again.";

/**
 * The wearer-fixable failure, answered the way api/settings/wifi answers it —
 * and carrying this route's own contract while it does: **`degraded` present
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
 * DELETE /api/notable-events/mydata/{id} — Forget one notable event.
 *
 * The row-level trash control on Ai Mic / Music / Calls / Translation. It has
 * been on screen since the recovered original and until now had nothing behind
 * it: there is no delete RPC in `events.proto`, so the button was rendered
 * disabled. Underneath this is the clone's `DELETE /event/:id`, principal-scoped
 * exactly like the reads beside it.
 *
 * The contract, in one line, is the one /api/capture/memory/{uuid} already
 * states: **`degraded` present means nothing was deleted.** It holds on the 200
 * as well as the 502, and the UI reads it — a delete that did not delete must
 * never come back looking like one.
 *
 * The one deliberate difference from that route: `ok` is the same claim as
 * `!degraded` here, never `true` alongside an explanation. Both are checked
 * client-side, so nothing depends on which; this is simply the honest pair.
 *
 * Never 500. The three outcomes are a real delete, a truthful "there was
 * nothing of yours to delete", and a backend that did not answer.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const result = await deleteEvent(id);

    // The fourth outcome, and the only one the wearer can act on: their Keycloak
    // grant died behind a still-valid Center cookie. It used to arrive as the
    // third one — "carry did not answer" — with a Forget button that would never
    // work no matter how often it was pressed.
    if (result.reauthenticate) return reauthenticate();

    const headers = sourceHeaders(result);

    // The backend's own word, not the status code: `deleted: true` and nothing
    // else is a delete.
    if (result.data.deleted) {
      return NextResponse.json({ ok: true }, { status: 200, headers });
    }

    const note = result.degraded ?? "nothing was deleted";

    // `degraded` state means carry is configured and did not answer — a
    // transport failure, and pressing Forget again may well work. Everything
    // else here (absent, or a live "nothing matched") is a true 200 that is
    // nonetheless NOT a success: the event is still where it was.
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
