import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { sourceHeaders } from "@/server/headers";
import {
  createContacts,
  deleteContact,
  getContacts,
  updateContact,
  type ContactDraft,
  type Sourced,
} from "@/server/source";

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
    },
    { headers: sourceHeaders(result) },
  );
}

export async function POST(request: Request) {
  const early = mutationPreflight(request);
  if (early) return early;
  const body = (await request.json().catch(() => null)) as { contacts?: unknown[] } | null;
  if (!Array.isArray(body?.contacts) || body.contacts.length < 1 || body.contacts.length > MAX_BATCH) {
    return NextResponse.json({ error: `Choose between 1 and ${MAX_BATCH} contacts.` }, { status: 400 });
  }
  const contacts = body.contacts.map(parseDraft);
  if (contacts.some((contact) => contact === null)) {
    return NextResponse.json({ error: "Every contact needs a name and valid contact fields." }, { status: 400 });
  }
  const result = await createContacts(contacts as ContactDraft[]);
  return mutationResult(result, { imported: result.data });
}

export async function PUT(request: Request) {
  const early = mutationPreflight(request);
  if (early) return early;
  const body = (await request.json().catch(() => null)) as { id?: unknown; contact?: unknown } | null;
  const id = cleanString(body?.id, 160);
  const contact = parseDraft(body?.contact);
  if (!id || !contact) {
    return NextResponse.json({ error: "A contact id and name are required." }, { status: 400 });
  }
  return mutationResult(await updateContact(id, contact), { updated: true });
}

export async function DELETE(request: Request) {
  const early = mutationPreflight(request);
  if (early) return early;
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = cleanString(body?.id, 160);
  if (!id) return NextResponse.json({ error: "A contact id is required." }, { status: 400 });
  return mutationResult(await deleteContact(id), { deleted: true });
}

function mutationPreflight(request: Request): Response | null {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "The contact import is too large." }, { status: 413 });
  }
  return null;
}

function mutationResult<T extends Record<string, unknown>>(
  result: Sourced<unknown>,
  body: T,
): NextResponse {
  // "Contacts couldn't be saved" is true but useless when the reason is the
  // wearer's own expired Keycloak grant: the import will fail identically on
  // every retry until they sign in again, which nothing here used to tell them.
  if (result.reauthenticate) {
    return NextResponse.json(
      { error: "Your session expired — sign in again.", reauthenticate: true },
      { status: 401 },
    );
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

function parseDraft(value: unknown): ContactDraft | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const displayName = cleanString(input.displayName, 160);
  if (!displayName) return null;
  const phoneNumbers = cleanList(input.phoneNumbers, 10, 80);
  const emails = cleanList(input.emails, 10, 254);
  if (!phoneNumbers || !emails) return null;
  return {
    displayName,
    phoneNumbers,
    emails,
    trusted: input.trusted === true,
    emergency: input.emergency === true,
    organization: cleanString(input.organization, 160) || null,
  };
}

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  return value.map((item) => cleanString(item, maxLength)).filter(Boolean);
}
