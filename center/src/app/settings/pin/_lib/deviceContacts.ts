import type { ContactRecord } from "@/lib/pin-device";

/*
 * The device's own address book, turned into something a form can edit.
 *
 * This is NOT the same book as /settings/contacts. That pane reads
 * `humane.contacts.ContactsRPCService` at CARRY_ENDPOINT_CONTACTS, which
 * production points at the `contacts` container in the compose stack — Cosmos's
 * principal-keyed store on the server. The Pin runtime implements the *same*
 * gRPC service independently (pin/runtime/core/src/services/contacts.rs) over
 * its own SQLite `contacts` table, and that table is also what `/api/contacts`
 * on the device reads and writes. Two implementations of one protocol, two
 * unrelated databases.
 *
 * Which one the wearer's Pin actually reads matters and is settled: the Pin's
 * stock contacts client syncs against the Pin's local runtime, and Penumbra's
 * contact-reset hook claims its flag from `127.0.0.1:8080` — the device's own
 * server, not the deployment's. So the book edited through this module is the
 * one the Pin answers calls and messages from. Nothing propagates between the
 * two stores in either direction, which is exactly why the pane that uses this
 * module names its store in the heading instead of just saying "Contacts".
 *
 * Everything here is pure so verify/pin-contacts.test.mjs can pin the parts
 * that decide data loss — which record a save overwrites, and what a blank
 * field means — without a device.
 */

/** The editable projection of one contact. Multi-values are one `|` string. */
export interface DeviceContactDraft {
  /** Empty for a contact that does not exist on the device yet. */
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  nickname: string;
  organization: string;
  phoneNumbers: string;
  emails: string;
  trusted: boolean;
  emergency: boolean;
  favorite: boolean;
}

export const EMPTY_DEVICE_CONTACT_DRAFT: DeviceContactDraft = {
  id: "",
  displayName: "",
  firstName: "",
  lastName: "",
  nickname: "",
  organization: "",
  phoneNumbers: "",
  emails: "",
  trusted: false,
  emergency: false,
  favorite: false,
};

/**
 * The one label for a contact, in the order the device itself resolves it.
 *
 * `list_contacts` orders by `COALESCE(NULLIF(display_name, ''), first_name ||
 * ' ' || last_name, id)`, so a contact stored with only a first and last name
 * sorts under that pair. Falling back to the nickname before the id keeps a
 * nickname-only contact readable instead of showing a UUID, and the final
 * fallback is deliberately prose rather than the id: an id in a name column
 * reads like a bug to the wearer, and the id is shown separately anyway.
 */
export function deviceContactLabel(contact: ContactRecord): string {
  const name = contact.name ?? {};
  const display = name.display_name?.trim();
  if (display) return display;
  const full = [name.first_name, name.last_name]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  if (full) return full;
  const nickname = name.nickname?.trim();
  if (nickname) return nickname;
  return "Unnamed contact";
}

/** Split the `a | b` multi-value convention /settings/contacts already uses. */
export function splitDeviceContactValues(value: string): string[] {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function draftFromDeviceContact(contact: ContactRecord): DeviceContactDraft {
  const name = contact.name ?? {};
  return {
    id: contact.id ?? "",
    displayName: name.display_name ?? "",
    firstName: name.first_name ?? "",
    lastName: name.last_name ?? "",
    nickname: name.nickname ?? "",
    organization: contact.organization ?? "",
    phoneNumbers: (contact.phone_numbers ?? []).map((phone) => phone.value).join(" | "),
    emails: (contact.emails ?? []).map((email) => email.value).join(" | "),
    trusted: contact.trusted === true,
    emergency: contact.emergency === true,
    favorite: contact.internal_favorite === true,
  };
}

/**
 * What the pane is allowed to send, or the reason it may not.
 *
 * The device applies the same rule — `validate_contact` in
 * pin/runtime/core/src/db/contacts.rs requires a name, an email or a phone
 * number, and rejects an email with no `@` — but it answers with a 400 whose
 * body is a serialized Rust error. Checking here first means the wearer gets a
 * sentence instead, and the two rules are stated in the same order so a change
 * on one side is visible as a divergence rather than as a mystery rejection.
 */
export function deviceContactDraftError(draft: DeviceContactDraft): string | null {
  const phones = splitDeviceContactValues(draft.phoneNumbers);
  const emails = splitDeviceContactValues(draft.emails);
  const named = Boolean(
    draft.displayName.trim() || draft.firstName.trim() || draft.lastName.trim(),
  );
  if (!named && phones.length === 0 && emails.length === 0) {
    return "Give this contact a name, an email address, or a phone number.";
  }
  if (emails.some((email) => !email.includes("@"))) {
    return "Every email address needs an @.";
  }
  return null;
}

/**
 * The record a save actually PUTs, built to be a full replacement.
 *
 * `update_contact` on the device sets `contact.id = id` and calls
 * `upsert_contact`, which rewrites the row and both child tables from what it
 * was handed. There is no merge: a field omitted here is a field cleared on the
 * device. So every field the form owns is always sent, including the empty
 * ones, and `contact_source` and `modified_at` are carried through from the
 * record that was read rather than reconstructed — `contact_source` records
 * where a contact came from (a stock import, a hook) and inventing it here
 * would relabel someone else's data as ours.
 */
export function deviceContactFromDraft(
  draft: DeviceContactDraft,
  existing?: ContactRecord,
): ContactRecord {
  const organization = draft.organization.trim();
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: {
      first_name: draft.firstName.trim(),
      last_name: draft.lastName.trim(),
      nickname: draft.nickname.trim(),
      display_name: draft.displayName.trim(),
    },
    emails: splitDeviceContactValues(draft.emails).map((value) => ({ value, type: "" })),
    phone_numbers: splitDeviceContactValues(draft.phoneNumbers).map((value) => ({
      value,
      type: "",
    })),
    trusted: draft.trusted,
    emergency: draft.emergency,
    internal_favorite: draft.favorite,
    temporary: existing?.temporary === true,
    ...(organization ? { organization } : {}),
    ...(existing?.contact_source ? { contact_source: existing.contact_source } : {}),
  };
}

/**
 * A favourite toggle as a whole-record write.
 *
 * `internal_favorite` has no endpoint of its own, so flipping it is a PUT of
 * the entire contact. Deriving that PUT from the record the pane already holds
 * — rather than from the open editor draft — is what stops a star click from
 * silently committing half-typed edits sitting in the form next to it.
 */
export function deviceContactWithFavorite(
  contact: ContactRecord,
  favorite: boolean,
): ContactRecord {
  return { ...contact, internal_favorite: favorite };
}

/** Case-insensitive match over the fields the pane displays. */
export function deviceContactMatches(contact: ContactRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    deviceContactLabel(contact),
    contact.organization ?? "",
    ...(contact.emails ?? []).map((email) => email.value),
    ...(contact.phone_numbers ?? []).map((phone) => phone.value),
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}
