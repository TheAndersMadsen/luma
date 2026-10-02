import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { sourceHeaders } from "@/server/headers";
import { deleteAllNotes, getNotesPage } from "@/server/domain/notes";
import { sessionExpiredResponse } from "@/server/routeErrors";

/** A whole-number query parameter, or `undefined` for Cosmos's default. */
function wholeNumber(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}

/**
 * GET /api/capture/notes?page&size&query, mirrors Cosmos `GET /capture/notes`
 * verbatim (the stock page envelope). `query` is searched by Cosmos over every
 * note the wearer has, not over the page on screen.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const result = await getNotesPage({
    page: wholeNumber(params.get("page")),
    size: wholeNumber(params.get("size")),
    query: params.get("query") ?? undefined,
  });
  return NextResponse.json(result.data, { headers: sourceHeaders(result) });
}

/**
 * DELETE /api/capture/notes, every note, and the createNote events the
 * recovered client erased with them (Cosmos `DELETE /capture/notes`).
 *
 * `ok: true` is Cosmos confirming the erasure finished; `deleted` says whether
 * there was anything to erase.
 */
export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const result = await deleteAllNotes();
  // "Delete every note I have written" answering `ok:false` with a 200 and no
  // reason is the worst version of this failure: the wearer cannot tell whether
  // their notes are gone. When the cause is their own expired grant, say so.
  if (result.reauthenticate) {
    return sessionExpiredResponse({ ok: false });
  }
  const ok = result.state === "live";
  return NextResponse.json(
    { ok, deleted: result.data.deleted, ...(ok ? {} : { degraded: result.degraded }) },
    { status: result.state === "degraded" ? 502 : 200, headers: sourceHeaders(result) },
  );
}
