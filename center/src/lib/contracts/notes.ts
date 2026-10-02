import * as z from "zod/mini";
import { eventEnvelopeSchema } from "./events";
import { epochSecondsSchema } from "./pagination";

/** notes_api::NoteDto: sealed rows have no content. Open rows carry the wearer's text. */
export const cosmosNoteSchema = z
  .object({
    uuid: z.string(),
    createdAt: epochSecondsSchema,
    modifiedAt: z.optional(epochSecondsSchema),
    hasLocation: z.boolean(),
    sealed: z.boolean(),
    title: z.optional(z.nullable(z.string())),
    titleGenerated: z.optional(z.boolean()),
    text: z.optional(z.string()),
  })
  .check(z.refine((note) => note.sealed || typeof note.text === "string"));
export type CosmosNoteDto = z.infer<typeof cosmosNoteSchema>;
export const noteDataSchema = z.object({
  note: z.object({
    title: z.nullable(z.string()),
    text: z.string(),
    sealed: z.optional(z.boolean()),
    hasLocation: z.optional(z.boolean()),
    titleGenerated: z.optional(z.boolean()),
  }),
});
export type NoteData = z.infer<typeof noteDataSchema>;
export const noteRecordSchema = eventEnvelopeSchema(noteDataSchema);
export type NoteRecord = z.infer<typeof noteRecordSchema>;
