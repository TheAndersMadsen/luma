import { NextResponse } from "next/server";
import { SessionExpiredError } from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";
import { deleteMemory, getCapture } from "@/server/source";

const SIGN_IN_AGAIN = "Your session expired — sign in again.";

/**
 * An expired Keycloak grant is the wearer's to fix, and only if they are told.
 *
 * Same status, same body and same words as api/settings/wifi and the capture
 * file/download routes. `getCapture` reaches `webapiHeaders()`, so this route
 * really can receive it: it used to arrive here as a 502 carrying
 * "The Keycloak grant behind this session expired…", i.e. Center telling the
 * wearer that the BACKEND had failed while quoting a sentence about their own
 * session.
 */
function reauthenticate(): NextResponse {
  return NextResponse.json({ error: SIGN_IN_AGAIN, reauthenticate: true }, { status: 401 });
}

/**
 * The same answer for DELETE, keeping this route's own contract intact:
 * **`degraded` present means nothing was deleted.** The capture detail reads
 * `degraded`/`note` to build its "Nothing was deleted — this capture is still
 * here" notice, so leaving them out would have made it say "the backend
 * answered 401" instead of the one thing the wearer can act on.
 */
function reauthenticateDelete(): NextResponse {
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

/** Read one capture so a refreshed/deep-linked detail has real burst metadata. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await context.params;
  try {
    const capture = await getCapture(uuid);
    if (!capture) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(capture, {
      headers: sourceHeaders({ source: "carry", state: "live" }),
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) return reauthenticate();
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "capture unavailable" },
      { status: 502 },
    );
  }
}

/**
 * DELETE /api/capture/memory/{uuid}
 *
 * The shape .Center itself called — `DELETE /capture/memory/{id}`. Underneath it
 * runs the real `CaptureService.DeleteMemory` gRPC via the read-only helper in
 * source.ts. This is a destructive endpoint; the UI gates it behind an explicit
 * in-app confirm and never fires it on mount.
 *
 * The contract, in one line: **`degraded` present means nothing was deleted.**
 * That holds on the 200 as well as the 502, and both callers (the capture detail
 * and the grid's bulk Forget) read it — they used to throw it away and close the
 * tile, so a capture that was never touched silently came back on the next
 * refetch. Same field name and same meaning as /api/capture/note/create.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await context.params;
  try {
    const result = await deleteMemory(uuid);

    // `deleteMemory` degrades internally, so the expiry arrives as a flag rather
    // than a throw. Without this arm it became a 502 "delete failed" and the
    // wearer was told a healthy backend had refused them — while the same
    // expiry on the Wi-Fi pane offered them the sign-in they actually needed.
    if (result.reauthenticate) return reauthenticateDelete();

    // A real delete happened only when the gRPC backend answered.
    if (result.state === "live") {
      return NextResponse.json({ ok: true }, { status: 200, headers: sourceHeaders(result) });
    }

    // No backend configured — the fixtures demo has nothing to delete server-side.
    // Still a 200 so the demo doesn't surface a scary error, but `degraded` says
    // plainly that the capture is still there.
    if (result.state === "absent") {
      return NextResponse.json(
        { ok: true, degraded: result.degraded ?? "carry not configured; nothing was deleted" },
        { status: 200, headers: sourceHeaders(result) },
      );
    }

    // Backend configured but the delete failed — tell the client nothing changed.
    const note = result.degraded ?? "delete failed";
    return NextResponse.json(
      { ok: false, degraded: note, note },
      { status: 502, headers: sourceHeaders(result) },
    );
  } catch (error) {
    if (error instanceof SessionExpiredError) return reauthenticateDelete();
    const note = error instanceof Error ? error.message : "delete failed";
    return NextResponse.json({ ok: false, degraded: note, note }, { status: 502 });
  }
}
