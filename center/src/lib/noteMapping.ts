import type { NoteRecord } from "@/lib/types";

/**
 * One raw note row from Carry's authenticated web projection
 * (`GET /capture/notes`), exactly as the stock page envelope carries it.
 * `/api/capture/notes` mirrors this shape verbatim; the dashboard maps it to
 * its own `NoteRecord` view with `mapCarryNote`.
 */
export interface CarryNoteDto {
  uuid: string;
  /** Epoch seconds from the durable note row. */
  createdAt: number;
  /** Decrypted humane.capture.Note.modified_at, when the device supplied it. */
  modifiedAt?: number;
  hasLocation: boolean;
  /**
   * `false` only after Carry authenticated the wearer and cryptographically
   * opened the device envelope. Sealed rows deliberately omit title and text.
   */
  sealed: boolean;
  title?: string | null;
  text?: string;
}

export function epochSecondsToIso(seconds: number): string {
  const milliseconds = Number(seconds) * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(milliseconds) && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : new Date(0).toISOString();
}

/** Map one raw Carry note row to the dashboard's `NoteRecord` view. */
export function mapCarryNote(note: CarryNoteDto): NoteRecord {
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
      },
    },
  };
}
