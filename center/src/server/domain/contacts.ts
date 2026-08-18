/*
 * Contacts — Settings -> Contacts, over the stock gRPC Contacts service.
 *
 * The original had All and Trusted tabs, which `Contact.trusted` supports
 * directly. Contacts arrive plaintext here; `ContactList.encrypted_contacts` is
 * the sealed variant and is left alone — nothing in the recovered .Center client
 * suggests the dashboard read that arm.
 */

import { COSMOS_ENABLED, Services, call } from "../cosmos";
import { failedGrpc, live, unconfigured, type Sourced } from "./provenance";

export interface ContactRecord {
  id: string;
  displayName: string;
  phoneNumbers: string[];
  emails: string[];
  trusted: boolean;
  emergency: boolean;
  organization: string | null;
}

export interface ContactDraft {
  displayName: string;
  phoneNumbers?: string[];
  emails?: string[];
  trusted?: boolean;
  emergency?: boolean;
  organization?: string | null;
}

interface CosmosContact {
  id?: string;
  name?: { firstName?: string; lastName?: string; nickname?: string; displayName?: string };
  phoneNumbers?: Array<{ value?: string; type?: string }>;
  telephoneNumbers?: string[];
  emails?: Array<{ value?: string; type?: string }>;
  trusted?: boolean;
  emergency?: boolean;
  organization?: { name?: string };
}

export async function getContacts(search = ""): Promise<Sourced<ContactRecord[]>> {
  // No contact fixtures exist, so this is an empty list — not sample data.
  // Tagging it "fixtures" was exactly the overloading that made a failed call
  // and a genuinely empty backend indistinguishable.
  if (!COSMOS_ENABLED) return unconfigured([], "empty");
  try {
    const res = await call<{ searchTerm: string }, { contacts?: CosmosContact[] }>(
      Services.contacts,
      "GetContacts",
      { searchTerm: search },
    );

    const data = (res.contacts ?? []).map<ContactRecord>((c) => {
      const name = c.name ?? {};
      const display =
        name.displayName?.trim() ||
        [name.firstName, name.lastName].filter(Boolean).join(" ").trim() ||
        name.nickname?.trim() ||
        "Unnamed";
      return {
        id: c.id ?? display,
        displayName: display,
        phoneNumbers: [
          ...(c.phoneNumbers ?? []).map((p) => p.value ?? "").filter(Boolean),
          ...(c.telephoneNumbers ?? []),
        ],
        emails: (c.emails ?? []).map((e) => e.value ?? "").filter(Boolean),
        trusted: Boolean(c.trusted),
        emergency: Boolean(c.emergency),
        organization: c.organization?.name?.trim() || null,
      };
    });
    return live(data);
  } catch (error) {
    return failedGrpc([], error);
  }
}

function cosmosContact(input: ContactDraft, id = ""): CosmosContact {
  const displayName = input.displayName.trim();
  return {
    id,
    name: { displayName },
    phoneNumbers: (input.phoneNumbers ?? []).map((value) => ({ value: value.trim(), type: "other" })),
    emails: (input.emails ?? []).map((value) => ({ value: value.trim(), type: "other" })),
    trusted: Boolean(input.trusted),
    emergency: Boolean(input.emergency),
    organization: input.organization?.trim() ? { name: input.organization.trim() } : undefined,
  };
}

/** Create one or more wearer-owned contacts and let Cosmos assign stable ids. */
export async function createContacts(inputs: ContactDraft[]): Promise<Sourced<number>> {
  if (!COSMOS_ENABLED) return unconfigured(0, "empty");
  try {
    const response = await call<{ contacts: CosmosContact[] }, { contacts?: CosmosContact[] }>(
      Services.contacts,
      "CreateContacts",
      { contacts: inputs.map((input) => cosmosContact(input)) },
    );
    return live(response.contacts?.length ?? inputs.length);
  } catch (error) {
    return failedGrpc(0, error);
  }
}

/** Update exactly one contact. The service upserts by its stable contact id. */
export async function updateContact(id: string, input: ContactDraft): Promise<Sourced<null>> {
  if (!COSMOS_ENABLED) return unconfigured(null, "empty");
  try {
    await call(Services.contacts, "UpdateContacts", { contacts: [cosmosContact(input, id)] });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
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

/* ------------------------------------------------ request-body parsing ---- */

/**
 * Parse one contact draft from an untrusted request body.
 *
 * Owned here rather than in the route so every surface that accepts a contact
 * enforces one grammar: a required display name, bounded list sizes, bounded
 * string lengths, and boolean flags read strictly.
 */
export function parseContactDraft(value: unknown): ContactDraft | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const displayName = cleanContactString(input.displayName, 160);
  if (!displayName) return null;
  const phoneNumbers = cleanContactList(input.phoneNumbers, 10, 80);
  const emails = cleanContactList(input.emails, 10, 254);
  if (!phoneNumbers || !emails) return null;
  return {
    displayName,
    phoneNumbers,
    emails,
    trusted: input.trusted === true,
    emergency: input.emergency === true,
    organization: cleanContactString(input.organization, 160) || null,
  };
}

export function cleanContactString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanContactList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  return value.map((item) => cleanContactString(item, maxLength)).filter(Boolean);
}
