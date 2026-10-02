/*
 * Notes, read and written on Cosmos's web plane: the `capture` routes the
 * recovered .Center called (`getNotes`, `createNote`, `editNote`,
 * `deleteAllNotes`), plus Luma's single-note read and Forget.
 *
 *   GET    /capture/notes?page&size&query    one page, newest first; `query`
 *                                           searches the whole account
 *   GET    /capture/note/{uuid}              one note
 *   POST   /capture/note/create {text,title}
 *   POST   /capture/note/{uuid} {text,title} the edit
 *   DELETE /capture/notes                    every note and its createNote events
 *   DELETE /capture/notes/{uuid}             one note
 *
 * Cosmos keeps the wearer's words. Center holds no note key and seals nothing.
 */

import type { CosmosNoteDto, NoteRecord } from "@/lib/contracts/notes";
import { cosmosNoteSchema } from "@/lib/contracts/notes";
import type { SpringPage } from "@/lib/contracts/pagination";
import { springPageSchema } from "@/lib/contracts/pagination";
import { parseResponse } from "@/lib/contracts/parse";
import { mapCosmosNote } from "@/lib/noteMapping";
import { COSMOS_WEBAPI_ENABLED, CosmosHttpError, webapiGet, webapiPost } from "../cosmos";
import {
  NOTHING_MATCHED,
  STOCK_PAGE_SIZE,
  WEBAPI_UNSET_FOR_DELETE,
  boundedPageSize,
  failed,
  failedWebapi,
  live,
  unconfigured,
  webapiDelete,
  type Deleted,
  type Sourced,
} from "./provenance";

const WEBAPI_UNSET =
  "COSMOS_WEBAPI_BASE_URL is unset - this Center cannot reach the wearer's notes";

/** Cosmos refused a write as longer than it keeps (413). */
export const NOTE_TOO_LONG = "This note is too long to save.";

/** Cosmos has no such note for this wearer (404). */
export const NOTE_GONE = "This note no longer exists.";

/** What a wearer may write: the recovered `{text, title}` body. */
export interface NoteWrite {
  /** Absent means Cosmos's stock default, "New note.". */
  text?: string;
  title?: string | null;
}

/** The body of a note write, or `null` when it is not a `{text?, title?}` of strings. */
export function parseNoteWrite(body: unknown): NoteWrite | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { text, title } = body as Record<string, unknown>;
  if (text !== undefined && typeof text !== "string") return null;
  if (title !== undefined && title !== null && typeof title !== "string") return null;
  return { text, title: title ?? null };
}

export interface NotesPageRequest {
  /** Zero-based. */
  page?: number;
  size?: number;
  /** Searched by Cosmos over every note the wearer has. */
  query?: string;
}

const EMPTY_PAGE: SpringPage<CosmosNoteDto> = {
  content: [],
  number: 0,
  size: 0,
  totalElements: 0,
  totalPages: 0,
  last: true,
  first: true,
  numberOfElements: 0,
  empty: true,
};

/** One page of the wearer's notes, or of those matching `query`. */
export async function getNotesPage({
  page = 0,
  size = STOCK_PAGE_SIZE,
  query,
}: NotesPageRequest = {}): Promise<Sourced<SpringPage<CosmosNoteDto>>> {
  // Authenticated wearer data is never replaced by sample notes.
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(EMPTY_PAGE, "empty", WEBAPI_UNSET);
  const params = new URLSearchParams({
    page: String(Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0),
    size: String(boundedPageSize(size)),
  });
  const needle = query?.trim();
  if (needle) params.set("query", needle);
  try {
    const result = parseResponse(
      springPageSchema(cosmosNoteSchema),
      await webapiGet(`/capture/notes?${params}`),
    );
    const sealedCount = result.content.filter(
      (note) => note.sealed !== false,
    ).length;
    // Sealed is its own idea: the note exists and Cosmos cannot read it. The
    // read succeeded, so the state is live.
    return live(
      result,
      sealedCount
        ? `${sealedCount} note(s) sealed under a key Cosmos does not hold`
        : undefined,
    );
  } catch (error) {
    return failedWebapi(EMPTY_PAGE, error);
  }
}

/** The newest `size` notes as dashboard records. */
export async function getNotes(size: number = STOCK_PAGE_SIZE): Promise<Sourced<NoteRecord[]>> {
  const page = await getNotesPage({ size });
  return { ...page, data: page.data.content.map(mapCosmosNote), total: page.data.totalElements };
}

/** One note; `live(null)` when Cosmos says this wearer has no such note. */
export async function getNote(
  uuid: string,
): Promise<Sourced<CosmosNoteDto | null>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
  try {
    return live(
      parseResponse(
        cosmosNoteSchema,
        await webapiGet(`/capture/note/${encodeURIComponent(uuid)}`),
      ),
    );
  } catch (error) {
    if (error instanceof CosmosHttpError && error.status === 404)
      return live(null, NOTE_GONE);
    return failedWebapi(null, error);
  }
}

/**
 * A write Cosmos answered with a refusal the wearer can act on, or `null`.
 * Every other failure is degraded through `failedWebapi`, never absent: Cosmos
 * is configured, and a wearer whose note did not save must be told so.
 */
function refusedWrite(error: unknown): Sourced<null> | null {
  if (!(error instanceof CosmosHttpError)) return null;
  switch (error.status) {
    case 404:
      return { ...live(null, NOTE_GONE), refusal: "not_found" };
    case 413:
      return { ...failed(null, NOTE_TOO_LONG, "empty"), refusal: "too_large" };
    default:
      return null;
  }
}

/** `POST /capture/note/create`: the note Cosmos stored, in the wearer's words. */
export async function createNote(
  input: NoteWrite,
): Promise<Sourced<CosmosNoteDto | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; note not saved`);
  try {
    return live(
      parseResponse(
        cosmosNoteSchema,
        await webapiPost("/capture/note/create", input),
      ),
    );
  } catch (error) {
    return refusedWrite(error) ?? failedWebapi(null, error);
  }
}

/** `POST /capture/note/{uuid}`: the recovered `editNote`. */
export async function editNote(
  uuid: string,
  input: NoteWrite,
): Promise<Sourced<CosmosNoteDto | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; note not saved`);
  try {
    return live(
      parseResponse(
        cosmosNoteSchema,
        await webapiPost(`/capture/note/${encodeURIComponent(uuid)}`, input),
      ),
    );
  } catch (error) {
    return refusedWrite(error) ?? failedWebapi(null, error);
  }
}

/**
 * Every note, and the `createNote` events the recovered client erased beside
 * them, in one Cosmos call. `deleted: false` means there was nothing to erase,
 * which is a finished erasure, not a failure.
 */
export async function deleteAllNotes(): Promise<Sourced<Deleted>> {
  if (!COSMOS_WEBAPI_ENABLED) {
    return unconfigured({ deleted: false }, "empty", WEBAPI_UNSET_FOR_DELETE);
  }
  try {
    return live({ deleted: await webapiDelete("/capture/notes") });
  } catch (error) {
    return failedWebapi({ deleted: false }, error);
  }
}

/**
 * One note, deleted: the per-note Forget.
 *
 * Reads and deletes use the same authenticated web plane, so both resolve the
 * same Bearer to the same wearer partition.
 */
export async function deleteNote(uuid: string): Promise<Sourced<Deleted>> {
  if (!COSMOS_WEBAPI_ENABLED) {
    return unconfigured({ deleted: false }, "empty", WEBAPI_UNSET_FOR_DELETE);
  }
  try {
    const deleted = await webapiDelete(`/capture/notes/${encodeURIComponent(uuid)}`);
    // `live` either way: the backend answered. The degraded clause on the false
    // arm is what stops the caller reading a truthful "nothing matched" as done.
    return deleted ? live({ deleted: true }) : live({ deleted: false }, NOTHING_MATCHED);
  } catch (error) {
    return failedWebapi({ deleted: false }, error);
  }
}
