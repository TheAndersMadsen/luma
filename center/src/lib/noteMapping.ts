import type { NoteRecord } from "@/lib/contracts/notes";
import type { CosmosNoteDto } from "./contracts/notes";

function epochSecondsToIso(seconds: number): string {
  const milliseconds = Number(seconds) * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(milliseconds) && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : new Date(0).toISOString();
}

/**
 * Map one raw Cosmos note row to the stock `NoteRecord` view
 * (`{uuid, userLastModified, data: {note: {title, text}}}`). A blank title is
 * `null` and a missing text is `""`, as the recovered client normalised them.
 */
export function mapCosmosNote(note: CosmosNoteDto): NoteRecord {
  const sealed = note.sealed !== false;
  const createdAt = epochSecondsToIso(note.createdAt);
  const modifiedAt = epochSecondsToIso(note.modifiedAt ?? note.createdAt);
  return {
    uuid: note.uuid,
    userCreatedAt: createdAt,
    userLastModified: modifiedAt,
    data: {
      note: {
        // Ignore content on a sealed row even if a broken backend sends it.
        title: sealed || !note.title?.trim() ? null : note.title,
        text: sealed ? "" : (note.text ?? ""),
        sealed,
        hasLocation: note.hasLocation === true,
      },
    },
  };
}
