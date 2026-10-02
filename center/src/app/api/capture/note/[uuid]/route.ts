import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { sourceHeaders } from "@/server/headers";
import { editNote, getNote, parseNoteWrite } from "@/server/domain/notes";
import { noteWriteResponse } from "../noteWriteResponse";

type Context = { params: Promise<{ uuid: string }> };

/**
 * GET /api/capture/note/{uuid}, one note (Cosmos `GET /capture/note/{uuid}`).
 *
 * Answers 200 whatever happened, like every read here, and puts the verdict in
 * the provenance headers: `null` with `x-data-state: live` is Cosmos saying
 * the wearer has no such note; `null` with any other state is a read that did
 * not happen, which says nothing about the note.
 */
export async function GET(_request: Request, context: Context) {
  const { uuid } = await context.params;
  const result = await getNote(uuid);
  return NextResponse.json(result.data, { headers: sourceHeaders(result) });
}

/** POST /api/capture/note/{uuid}, the recovered `editNote` {text, title}. */
export async function POST(request: Request, context: Context) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const { uuid } = await context.params;
  const input = parseNoteWrite(await request.json().catch(() => null));
  if (!input) {
    return NextResponse.json(
      { ok: false, error: "Expected a JSON {text, title} object of strings." },
      { status: 400 },
    );
  }
  const result = await editNote(uuid, input);
  return noteWriteResponse(result, sourceHeaders(result));
}
