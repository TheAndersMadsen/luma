import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { sourceHeaders } from "@/server/headers";
import {
  cleanContactString,
  createContacts,
  deleteContact,
  getContacts,
  parseContactDraft,
  updateContact,
  type ContactDraft,
} from "@/server/domain/contacts";
import type { ContactsResponse } from "@/lib/contracts/contacts";
import type { Sourced } from "@/server/domain/provenance";
import { sessionExpiredResponse } from "@/server/routeErrors";

const MAX_BATCH = 500;
const MAX_BODY_BYTES = 1_000_000;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const result = await getContacts(q.slice(0, 160));
  return NextResponse.json(
    {
      contacts: result.data,
      state: result.state,
      degraded: result.degraded,
      // Carried on the read too: an empty contacts list because the session
      // expired is not the same thing as an empty address book, and the pane
      // cannot tell them apart from `state` alone.
      reauthenticate: result.reauthenticate,
    } satisfies ContactsResponse,
    { headers: sourceHeaders(result) },
  );
}

export async function POST(request: Request) {
  const early = mutationPreflight(request);
  if (early) return early;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { contacts?: unknown[] } | null;
  if (!Array.isArray(body?.contacts) || body.contacts.length < 1 || body.contacts.length > MAX_BATCH) {
    return NextResponse.json({ error: `Choose between 1 and ${MAX_BATCH} contacts.` }, { status: 400 });
  }
  const contacts = body.contacts.map(parseContactDraft);
  if (contacts.some((contact) => contact === null)) {
    return NextResponse.json({ error: "Every contact needs a name and valid contact fields." }, { status: 400 });
  }
  const result = await createContacts(contacts as ContactDraft[]);
  return mutationResult(result, { imported: result.data });
}

export async function PUT(request: Request) {
  const early = mutationPreflight(request);
  if (early) return early;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { id?: unknown; contact?: unknown } | null;
  const id = cleanContactString(body?.id, 160);
  const contact = parseContactDraft(body?.contact);
  if (!id || !contact) {
    return NextResponse.json({ error: "A contact id and name are required." }, { status: 400 });
  }
  const result = await updateContact(id, contact);
  if (result.state === "live" && !result.data) {
    return NextResponse.json({ error: "This contact no longer exists." }, { status: 404 });
  }
  return mutationResult(result, { updated: true });
}

export async function DELETE(request: Request) {
  const early = mutationPreflight(request);
  if (early) return early;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { id?: unknown } | null;
  const id = cleanContactString(body?.id, 160);
  if (!id) return NextResponse.json({ error: "A contact id is required." }, { status: 400 });
  return mutationResult(await deleteContact(id), { deleted: true });
}

function mutationPreflight(request: Request): Response | null {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  return null;
}

type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * One bounded JSON read for every mutation. The 1 MB limit used to be checked
 * only against a declared content-length, so a chunked body of any size was
 * buffered in full before it was refused. The stream itself is the bound now,
 * exactly as the import's own batches expect (≤ 900 000 bytes each).
 */
async function readJsonBody(request: Request): Promise<JsonBody> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Expected a JSON body." }, { status: 415 }),
    };
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: NextResponse.json({ error: "The contact import is too large." }, { status: 413 }),
    };
  }
  if (!request.body) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Expected a JSON body." }, { status: 400 }),
    };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          response: NextResponse.json({ error: "The contact import is too large." }, { status: 413 }),
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Expected a JSON body." }, { status: 400 }),
    };
  }
}

function mutationResult<T extends Record<string, unknown>>(
  result: Sourced<unknown>,
  body: T,
): NextResponse {
  // "Contacts couldn't be saved" is true but useless when the reason is the
  // wearer's own expired Keycloak grant: the import will fail identically on
  // every retry until they sign in again, which nothing here used to tell them.
  if (result.reauthenticate) {
    return sessionExpiredResponse();
  }
  if (result.state === "live") {
    return NextResponse.json(body, {
      headers: { ...sourceHeaders(result), "cache-control": "private, no-store" },
    });
  }
  return NextResponse.json(
    { error: result.state === "absent" ? "Connect a Pin before managing contacts." : "Contacts couldn’t be saved." },
    { status: result.state === "absent" ? 503 : 502, headers: sourceHeaders(result) },
  );
}
