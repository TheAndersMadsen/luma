import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { sourceHeaders } from "@/server/headers";
import { createNote, parseNoteWrite } from "@/server/domain/notes";
import { noteWriteResponse } from "../noteWriteResponse";

/**
 * POST /api/capture/note/create, mirrors Cosmos `POST /capture/note/create
 * {text, title}`. An absent `text` is Cosmos's stock "New note.".
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const input = parseNoteWrite(await request.json().catch(() => null));
  if (!input) {
    return NextResponse.json(
      { ok: false, error: "Expected a JSON {text, title} object of strings." },
      { status: 400 },
    );
  }
  const result = await createNote(input);
  return noteWriteResponse(result, sourceHeaders(result));
}
