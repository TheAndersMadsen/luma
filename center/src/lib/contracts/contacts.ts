import * as z from "zod/mini";
import { bodyProvenanceShape } from "./dataSource";

const contactValueSchema = z.object({ value: z.string(), type: z.string() });

/** One contact as Center shows it (server/domain/contacts.ts `toContactRecord`). */
export const contactRecordSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  nickname: z.string(),
  displayName: z.string(),
  label: z.string(),
  phoneNumbers: z.array(contactValueSchema),
  emails: z.array(contactValueSchema),
  organization: z.nullable(z.string()),
  trusted: z.boolean(),
  emergency: z.boolean(),
  favorite: z.boolean(),
});
export type ContactRecord = z.infer<typeof contactRecordSchema>;

/**
 * GET /api/contacts. On a live read `degraded` names contacts Cosmos keeps
 * sealed and cannot show.
 */
export const contactsResponseSchema = z.object({
  contacts: z.array(contactRecordSchema),
  ...bodyProvenanceShape,
});
export type ContactsResponse = z.infer<typeof contactsResponseSchema>;
