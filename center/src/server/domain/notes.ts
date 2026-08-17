/*
 * Notes, read and written through the planes the recovered .Center used.
 *
 * Reads go through Carry's authenticated web projection; the single-note delete
 * is REST for the same reason. The one write the gRPC plane owns — CreateNote —
 * seals the note under the wearer's channel key first.
 */

import { channelKey } from "../channel";
import { seal } from "../envelope";
import {
  CARRY_ENABLED,
  CARRY_WEBAPI_ENABLED,
  Services,
  call,
  webapiGet,
  type SpringPage,
} from "../cosmos";
import { mapCarryNote, type CarryNoteDto } from "@/lib/noteMapping";
import type { NoteRecord } from "@/lib/types";
import {
  NOTHING_MATCHED,
  STOCK_PAGE_SIZE,
  WEBAPI_UNSET_FOR_DELETE,
  boundedPageSize,
  failedGrpc,
  failedWebapi,
  live,
  unconfigured,
  webapiDelete,
  type Deleted,
  type Sourced,
} from "./provenance";

/**
 * Read notes through Carry's authenticated web projection.
 *
 * The device-facing gRPC response must remain ciphertext, and Center's local
 * channel key is unrelated to a physical Pin's key. Trying that local key made
 * every device-created note look permanently encrypted. The web endpoint keeps
 * ciphertext at rest and returns title/text only after Carry verifies the web
 * bearer and opens the envelope with the owning device key.
 */
export async function getNotesPage(
  size: number = STOCK_PAGE_SIZE,
): Promise<Sourced<SpringPage<CarryNoteDto>>> {
  const emptyPage: SpringPage<CarryNoteDto> = {
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
  // Authenticated wearer data must never be replaced by recovered sample notes.
  if (!CARRY_WEBAPI_ENABLED) {
    return unconfigured(
      emptyPage,
      "empty",
      "CARRY_WEBAPI_BASE_URL is unset - this Center cannot read the wearer's notes",
    );
  }
  try {
    const page = await webapiGet<SpringPage<CarryNoteDto>>(
      `/notes?size=${boundedPageSize(size)}&sort=createdAt,DESC`,
    );
    const sealedCount = page.content.filter((note) => note.sealed !== false).length;
    // Sealed is a fourth, separate idea: the content exists and is end-to-end
    // encrypted. The read succeeded, so the state is live.
    return live(
      page,
      sealedCount
        ? `${sealedCount} note(s) sealed under a key this dashboard does not hold`
        : undefined,
    );
  } catch (error) {
    return failedWebapi(emptyPage, error);
  }
}

export async function getNotes(size: number = STOCK_PAGE_SIZE): Promise<Sourced<NoteRecord[]>> {
  const page = await getNotesPage(size);
  return { ...page, data: page.data.content.map(mapCarryNote) };
}

/**
 * Seals the note under the wearer's channel key, which is the only way to write
 * one.
 *
 * Every failure here is `degraded`, never `unconfigured`. Carry IS configured —
 * the `CARRY_ENABLED` guard above already answered that question — so `absent`
 * would be a false claim about the deployment, and it is the one state
 * /api/health and SourceBadge read as healthy. A wearer whose note did not save
 * must see a surface that says something went wrong.
 */
export async function createNote(input: { title?: string; text: string }): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) {
    return unconfigured(null, "empty", "carry not configured; note not persisted");
  }
  try {
    const channel = await channelKey();
    const body = Buffer.from(JSON.stringify({ title: input.title, text: input.text }), "utf8");
    await call(Services.notes, "CreateNote", {
      encryptedNote: {
        data: seal(channel.kid, channel.key, body),
        encryptionInformation: { kid: channel.kid },
      },
    });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}

export async function deleteAllNotes(): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) {
    return unconfigured(null, "empty", "carry not configured; nothing deleted");
  }
  try {
    await call(Services.notes, "DeleteAllNotes", {});
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}

/**
 * One note, deleted — the thing the notes surface could not do.
 *
 * Until now the only delete this backend held was `DeleteAllNotes`: a wearer who
 * wanted one note gone had to drop every note they had ever written. The single
 * delete is REST, not gRPC, and deliberately so — `.Center` was a web app and
 * called the webapi; inventing an RPC in the recovered protos would be inventing
 * history (see the frozen delete contract).
 *
 * Reads and single-row deletes use the same authenticated REST plane, so both
 * resolve the same bearer to the same wearer partition.
 */
export async function deleteNote(uuid: string): Promise<Sourced<Deleted>> {
  if (!CARRY_WEBAPI_ENABLED) {
    return unconfigured({ deleted: false }, "empty", WEBAPI_UNSET_FOR_DELETE);
  }
  try {
    const deleted = await webapiDelete(`/notes/${encodeURIComponent(uuid)}`);
    // `live` either way: the backend answered. The DEGRADED clause on the false
    // arm is what stops the caller reading a truthful "nothing matched" as done.
    return deleted ? live({ deleted: true }) : live({ deleted: false }, NOTHING_MATCHED);
  } catch (error) {
    return failedWebapi({ deleted: false }, error);
  }
}
