import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { createNote } from "@/server/source";

/** POST /api/capture/note/create — mirrors POST /capture/note/create { text, title } */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { text?: string; title?: string };
  const result = await createNote({ text: body.text ?? "New note.", title: body.title });

  // The wearer just typed a note that was not saved. When the cause is their own
  // expired grant this is the one failure here they can act on, and a 200 with
  // `ok:false` gave them no way to tell it from a backend that is down.
  if (result.reauthenticate) {
    return NextResponse.json(
      { ok: false, degraded: result.degraded, reauthenticate: true },
      { status: 401 },
    );
  }

  const headers = sourceHeaders(result);

  return NextResponse.json({ ok: !result.degraded, degraded: result.degraded }, { headers });
}
