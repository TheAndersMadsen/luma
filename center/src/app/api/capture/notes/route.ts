import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { deleteAllNotes, getNotesPage } from "@/server/source";

/** GET /api/capture/notes — mirrors GET /capture/notes verbatim (stock page envelope). */
export async function GET() {
  const result = await getNotesPage();
  return NextResponse.json(result.data, { headers: sourceHeaders(result) });
}

/** DELETE /api/capture/notes — mirrors DELETE /capture/notes */
export async function DELETE() {
  const result = await deleteAllNotes();
  // "Delete every note I have written" answering `ok:false` with a 200 and no
  // reason is the worst version of this failure: the wearer cannot tell whether
  // their notes are gone. When the cause is their own expired grant, say so.
  if (result.reauthenticate) {
    return NextResponse.json(
      { ok: false, error: "Your session expired — sign in again.", reauthenticate: true },
      { status: 401 },
    );
  }
  return NextResponse.json({ ok: !result.degraded }, { headers: sourceHeaders(result) });
}
