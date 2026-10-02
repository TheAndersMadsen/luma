/*
 * Contacts, Settings -> Contacts, over the stock gRPC Contacts service.
 *
 * This is the address book the Pin uses: ironman's `ContactsManager` delta-syncs
 * `humane.contacts.ContactsRPCService` from Cosmos, and Cosmos nudges it with the
 * stock `humane.contacts` push whenever this pane changes something. The
 * original had All and Trusted tabs, which `Contact.trusted` supports directly.
 *
 * `UpdateContacts` replaces the whole stored `Contact`, so an edit is a
 * read-modify-write: the stored record goes back with only the fields this pane
 * edits replaced. Everything else, `temporary`, `contact_source`, social
 * handles, contact actions, `last_used_at`, the legacy `telephone_numbers`,
 * survives the edit untouched.
 *
 * Temporary contacts are the leases a Pin makes for unknown numbers it calls or
 * texts. The Pin keeps them out of its own lists, and so does this pane.
 */

import {
  CONTACT_SOURCES,
  MAX_CONTACT_VALUES,
  derivedDisplayName,
  displayNameFor,
  type ContactDraft,
  type ContactSource,
  type ContactValue,
} from "@/lib/contactImport";
import type { ContactRecord } from "@/lib/contracts/contacts";
import { parseResponse } from "@/lib/contracts/parse";
import * as z from "zod/mini";
import { COSMOS_ENABLED, Services, call } from "../cosmos";
import { failedGrpc, live, unconfigured, type Sourced } from "./provenance";

export type { ContactDraft, ContactValue } from "@/lib/contactImport";

export type { ContactRecord } from "@/lib/contracts/contacts";

/** Validate the fields Center reads. Preserve the other protobuf fields across whole-contact updates. */
const contactValueSchema = z.object({
  value: z.optional(z.string()),
  type: z.optional(z.string()),
});
const cosmosContactSchema = z.looseObject({
  id: z.optional(z.string()),
  name: z.nullish(
    z.looseObject({
      firstName: z.optional(z.string()),
      lastName: z.optional(z.string()),
      nickname: z.optional(z.string()),
      displayName: z.optional(z.string()),
    }),
  ),
  phoneNumbers: z.optional(z.array(contactValueSchema)),
  emails: z.optional(z.array(contactValueSchema)),
  trusted: z.optional(z.boolean()),
  emergency: z.optional(z.boolean()),
  temporary: z.optional(z.boolean()),
  internalFavorite: z.optional(z.boolean()),
  organization: z.nullish(z.looseObject({ name: z.optional(z.string()) })),
  contactSource: z.nullish(z.looseObject({ name: z.optional(z.string()) })),
});
export type CosmosContact = z.infer<typeof cosmosContactSchema>;
const contactListSchema = z.object({
  contacts: z.array(cosmosContactSchema),
  encryptedContacts: z.optional(z.array(z.unknown())),
});

/**
 * What the pane says about contacts Cosmos keeps sealed: the Pin synced them
 * under a key this deployment has not received (a Pin that synced before its
 * key arrived, or after a key rotation). They are stored, not lost, and Cosmos
 * opens them once the key arrives. Until then the list is short, not empty.
 */
export function sealedContactsNote(sealed: number): string {
  return sealed === 1
    ? "1 contact is encrypted with a key this server doesn't have yet, so it can't be shown here. It is kept, and appears once your Pin's key arrives."
    : `${sealed} contacts are encrypted with a key this server doesn't have yet, so they can't be shown here. They are kept, and appear once your Pin's key arrives.`;
}

export async function getContacts(search = ""): Promise<Sourced<ContactRecord[]>> {
  // No contact fixtures exist, so this is an empty list, not sample data.
  // Tagging it "fixtures" was exactly the overloading that made a failed call
  // and a genuinely empty backend indistinguishable.
  if (!COSMOS_ENABLED) return unconfigured([], "empty");
  try {
    const { contacts, sealed } = await readContacts(search);
    // Sealed is its own idea, as for notes and My Data: the contacts exist and
    // Cosmos cannot open them. The read succeeded, so the state is live.
    return live(
      contacts.filter((contact) => !contact.temporary).map(toContactRecord),
      sealed ? sealedContactsNote(sealed) : undefined,
    );
  } catch (error) {
    return failedGrpc([], error);
  }
}

/** Create one or more wearer-owned contacts and let Cosmos assign stable ids. */
export async function createContacts(
  inputs: ContactDraft[],
): Promise<Sourced<number>> {
  if (!COSMOS_ENABLED) return unconfigured(0, "empty");
  try {
    const response = parseResponse(
      contactListSchema,
      await call(Services.contacts, "CreateContacts", {
        contacts: inputs.map((input) => ({
          ...applyDraft({}, input),
          ...(input.source ? { contactSource: { name: input.source } } : {}),
        })),
      }),
    );
    return live(response.contacts.length);
  } catch (error) {
    return failedGrpc(0, error);
  }
}

/**
 * Update exactly one contact, keeping every field the draft does not carry.
 * `data` is false when the contact no longer exists.
 */
export async function updateContact(id: string, input: ContactDraft): Promise<Sourced<boolean>> {
  if (!COSMOS_ENABLED) return unconfigured(false, "empty");
  try {
    const stored = (await readContacts("")).contacts.find((contact) => contact.id === id);
    if (!stored) return live(false);
    await call(Services.contacts, "UpdateContacts", { contacts: [applyDraft(stored, input)] });
    return live(true);
  } catch (error) {
    return failedGrpc(false, error);
  }
}

/** Delete a wearer-owned contact and emit the tombstone the Pin sync consumes. */
export async function deleteContact(id: string): Promise<Sourced<null>> {
  if (!COSMOS_ENABLED) return unconfigured(null, "empty");
  try {
    await call(Services.contacts, "DeleteContacts", { ids: [id] });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}

/**
 * One `GetContacts`: the contacts Cosmos could open, and how many it relays in
 * `encrypted_contacts` because it could not (only on an unfiltered read, a
 * sealed contact cannot match a search term).
 */
async function readContacts(
  search: string,
): Promise<{ contacts: CosmosContact[]; sealed: number }> {
  const res = parseResponse(
    contactListSchema,
    await call(Services.contacts, "GetContacts", { searchTerm: search }),
  );
  return { contacts: res.contacts, sealed: res.encryptedContacts?.length ?? 0 };
}

/**
 * `stored` with the fields a draft carries replaced. `display_name` is
 * derived from the name when the draft leaves it blank, because the Pin's
 * dialer shows it before anything else.
 */
export function applyDraft(stored: CosmosContact, draft: ContactDraft): CosmosContact {
  const organization = draft.organization?.trim();
  return {
    ...stored,
    name: {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      nickname: draft.nickname.trim(),
      displayName: displayNameFor(draft),
    },
    phoneNumbers: draft.phoneNumbers.map(({ value, type }) => ({ value: value.trim(), type: type.trim() })),
    emails: draft.emails.map(({ value, type }) => ({ value: value.trim(), type: type.trim() })),
    organization: organization ? { name: organization } : null,
    trusted: draft.trusted,
    emergency: draft.emergency,
    internalFavorite: draft.favorite,
  };
}

export function toContactRecord(contact: CosmosContact): ContactRecord {
  const name = {
    firstName: contact.name?.firstName?.trim() ?? "",
    lastName: contact.name?.lastName?.trim() ?? "",
    nickname: contact.name?.nickname?.trim() ?? "",
  };
  const stored = contact.name?.displayName?.trim() ?? "";
  const derived = derivedDisplayName(name);
  const phoneNumbers = values(contact.phoneNumbers);
  const emails = values(contact.emails);
  return {
    id: contact.id ?? "",
    ...name,
    displayName: stored === derived ? "" : stored,
    label:
      stored ||
      derived ||
      phoneNumbers[0]?.value ||
      emails[0]?.value ||
      "Unnamed",
    phoneNumbers,
    emails,
    organization: contact.organization?.name?.trim() || null,
    trusted: Boolean(contact.trusted),
    emergency: Boolean(contact.emergency),
    favorite: Boolean(contact.internalFavorite),
  };
}

function values(list: Array<{ value?: string; type?: string }> | undefined): ContactValue[] {
  return (list ?? [])
    .map((item) => ({ value: item.value?.trim() ?? "", type: item.type?.trim() ?? "" }))
    .filter((item) => item.value);
}

/* ------------------------------------------------ request-body parsing ---- */

/**
 * Parse one contact draft from an untrusted request body.
 *
 * Owned here rather than in the route so every surface that accepts a contact
 * enforces one grammar: at least one name, bounded list sizes, bounded string
 * lengths, and boolean flags read strictly.
 */
export function parseContactDraft(value: unknown): ContactDraft | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const firstName = cleanContactString(input.firstName, 120);
  const lastName = cleanContactString(input.lastName, 120);
  const nickname = cleanContactString(input.nickname, 120);
  const displayName = cleanContactString(input.displayName, 160);
  if (!firstName && !lastName && !nickname && !displayName) return null;
  const phoneNumbers = cleanContactValues(input.phoneNumbers, MAX_CONTACT_VALUES, 80);
  const emails = cleanContactValues(input.emails, MAX_CONTACT_VALUES, 254);
  if (!phoneNumbers || !emails) return null;
  return {
    firstName,
    lastName,
    nickname,
    displayName,
    phoneNumbers,
    emails,
    organization: cleanContactString(input.organization, 160) || null,
    trusted: input.trusted === true,
    emergency: input.emergency === true,
    favorite: input.favorite === true,
    source: CONTACT_SOURCES.find((source): source is ContactSource => source === input.source) ?? null,
  };
}

export function cleanContactString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanContactValues(value: unknown, maxItems: number, maxLength: number): ContactValue[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: ContactValue[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const entry = item as Record<string, unknown>;
    const clean = cleanContactString(entry.value, maxLength);
    if (clean) out.push({ value: clean, type: cleanContactString(entry.type, 40) });
  }
  return out;
}
