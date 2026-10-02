/*
 * The contact draft Center writes, and the CSV/vCard importer that produces it.
 *
 * The draft carries the stock `humane.contacts.Contact` fields the wearer
 * edits. Names matter most: the Pin finds a contact by voice only by its first,
 * last, full (first + last) or nick name (ironman `NameEntityCorrector`), never
 * by `display_name`, so an import that flattens a structured name into the
 * display name produces contacts the Pin cannot call. Phone and e-mail labels
 * are free strings the Pin shows as written (`ContactDetailsViewController`
 * shows "cell" for a blank phone label).
 */

export interface ContactValue {
  value: string;
  type: string;
}

/** Phone numbers, and separately e-mails, one contact may carry through `/api/contacts`. */
export const MAX_CONTACT_VALUES = 10;

/** Where an imported contact came from, stored as `contact_source.name`. */
export const CONTACT_SOURCES = ["import:vcard", "import:csv"] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export interface ContactDraft {
  firstName: string;
  lastName: string;
  nickname: string;
  /** Blank means "derive it from the name" (see `displayNameFor`). */
  displayName: string;
  phoneNumbers: ContactValue[];
  emails: ContactValue[];
  organization: string | null;
  trusted: boolean;
  emergency: boolean;
  /** `internal_favorite`: the Pin's last tiebreak when it ranks suggestions. */
  favorite: boolean;
  /** Set on import only. */
  source: ContactSource | null;
}

/** The name a blank display name stands for: first + last, else the nickname. */
export function derivedDisplayName(name: { firstName: string; lastName: string; nickname: string }): string {
  return [name.firstName, name.lastName].map((part) => part.trim()).filter(Boolean).join(" ")
    || name.nickname.trim();
}

/** The `display_name` Center writes: the wearer's, or derived when blank. */
export function displayNameFor(draft: Pick<ContactDraft, "firstName" | "lastName" | "nickname" | "displayName">): string {
  return draft.displayName.trim() || derivedDisplayName(draft);
}

/** Every named entry in the file. `importBatches` splits them for `/api/contacts`. */
export function parseContactFile(text: string, filename: string): ContactDraft[] {
  const looksLikeVcard = /BEGIN:VCARD/i.test(text) || /\.vc(?:f|ard)$/i.test(filename);
  const contacts = looksLikeVcard ? parseVcards(text) : parseCsv(text);
  return contacts.filter((contact) => displayNameFor(contact));
}

/** Contacts one `POST /api/contacts` accepts (the route's MAX_BATCH). */
export const IMPORT_BATCH_CONTACTS = 500;
/** JSON bytes per import request, under the route's 1 MB body limit. */
export const IMPORT_BATCH_BYTES = 900_000;

/**
 * Split an import into requests the contacts route accepts: at most
 * `IMPORT_BATCH_CONTACTS` contacts and about `IMPORT_BATCH_BYTES` of JSON each,
 * in file order.
 */
export function importBatches(
  contacts: ContactDraft[],
  maxContacts = IMPORT_BATCH_CONTACTS,
  maxBytes = IMPORT_BATCH_BYTES,
): ContactDraft[][] {
  const encoder = new TextEncoder();
  const batches: ContactDraft[][] = [];
  let batch: ContactDraft[] = [];
  let bytes = 0;
  for (const contact of contacts) {
    const size = encoder.encode(JSON.stringify(contact)).byteLength + 1;
    if (batch.length && (batch.length >= maxContacts || bytes + size > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(contact);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/* ------------------------------------------------------------------ CSV --- */

function parseCsv(text: string): ContactDraft[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const [delimiter = ","] = [",", ";", "\t"].sort(
    (a, b) => firstLine.split(b).length - firstLine.split(a).length,
  );
  const rows = csvRows(text, delimiter);
  const headers = (rows.shift() ?? []).map((header) => normalizeHeader(header));
  return rows.flatMap((row) => {
    const values = Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim() ?? ""]));
    const firstName = pick(values, "first_name", "firstname", "given_name");
    const lastName = pick(values, "last_name", "lastname", "family_name", "surname");
    const nickname = pick(values, "nickname", "nick_name");
    const displayName = pick(values, "display_name", "full_name", "name");
    if (!firstName && !lastName && !nickname && !displayName) return [];
    const labels = pick(values, "labels", "group_membership", "categories").toLowerCase();
    return [{
      firstName,
      lastName,
      nickname,
      displayName,
      phoneNumbers: csvValues(values, PHONE_HEADER),
      emails: csvValues(values, EMAIL_HEADER),
      organization: pick(values, "organization", "organisation", "company", "organization_name") || null,
      trusted: truthy(pick(values, "trusted")),
      emergency: truthy(pick(values, "emergency", "ice")),
      favorite: truthy(pick(values, "favorite", "favourite", "starred")) || /\bstarred\b/.test(labels),
      source: "import:csv",
    }];
  });
}

const PHONE_HEADER = /^(?:(\w+?)_)?(?:phone|telephone|mobile|cell)(?:_(\w+?))?$/;
const EMAIL_HEADER = /^(?:(\w+?)_)?e_?mail(?:_address)?(?:_(\w+?))?$/;
/** Google's "Phone 1 - Type" (or "- Label") / "Phone 1 - Value" pairs, normalized. */
const PAIRED_HEADER = /^(phone|e_?mail)_(\d+)_(type|label|value)$/;
/** Columns that describe a value rather than hold one, e.g. Outlook's "E-mail 2 Type" / "E-mail Display Name". */
const DESCRIBING_QUALIFIER = /(?:^|_)(?:type|label|display_name)$/;

/**
 * Collect one kind of value from a CSV row, keeping its label. Handles
 * Google's numbered `<kind> N - Type/Value` pairs and label-bearing column
 * names such as Outlook's "Mobile Phone" or "Business Phone".
 */
function csvValues(values: Record<string, string>, header: RegExp): ContactValue[] {
  const out: ContactValue[] = [];
  const pairs = new Map<string, { type: string; value: string }>();
  const email = header === EMAIL_HEADER;
  for (const [key, cell] of Object.entries(values)) {
    const paired = PAIRED_HEADER.exec(key);
    if (paired) {
      // Every PAIRED_HEADER group is required, so a match carries all three.
      const [, kind = "", slot = "", part = ""] = paired;
      if (kind.startsWith("e") !== email) continue;
      const entry = pairs.get(slot) ?? { type: "", value: "" };
      entry[part === "value" ? "value" : "type"] = cell;
      pairs.set(slot, entry);
      continue;
    }
    const match = header.exec(key);
    if (!match || DESCRIBING_QUALIFIER.test(match[2] ?? "")) continue;
    const words = [match[1], match[2], email ? null : key.includes("mobile") || key.includes("cell") ? "mobile" : null];
    const type = labelFrom(words.filter((word): word is string => Boolean(word)));
    for (const value of cell.split(/\s*[|]\s*/)) out.push({ value, type });
  }
  for (const { type, value } of pairs.values()) {
    for (const part of value.split(/\s*:::\s*/)) out.push({ value: part, type: labelFrom([type]) });
  }
  return uniqueValues(out);
}

/* ---------------------------------------------------------------- vCard --- */

/** One content line: its property, parameters, raw value, and 2.1 encoding. */
interface VcardField {
  key: string;
  params: string[];
  value: string;
  /** The value is `ENCODING=QUOTED-PRINTABLE` bytes in `charset`. */
  quotedPrintable: boolean;
  charset: string;
}

function vcardParam(param: string): { name: string; value: string } {
  const [name = "", value = ""] = param.includes("=") ? param.split("=", 2) : ["", param];
  return { name: name.trim().toUpperCase(), value: value.trim().replace(/"/g, "") };
}

/** 2.1 writes `ENCODING=QUOTED-PRINTABLE` or just `QUOTED-PRINTABLE`. */
function isQuotedPrintable(params: string[]): boolean {
  return params.some((param) => {
    const { name, value } = vcardParam(param);
    return (name === "" || name === "ENCODING") && value.toUpperCase() === "QUOTED-PRINTABLE";
  });
}

function lineParams(line: string): string[] {
  const colon = line.indexOf(":");
  return colon < 0 ? [] : line.slice(0, colon).split(";").slice(1);
}

/**
 * Logical content lines. A line starting with a space or tab continues the
 * previous one (RFC 6350 §3.2). A vCard 2.1 quoted-printable value, which
 * Android's contacts export writes for every non-ASCII name, also continues
 * after a line ending in `=` (a soft line break), with or without indent.
 * Parts are joined once per line, so a folded multi-megabyte PHOTO stays linear.
 */
function vcardLines(text: string): string[] {
  const lines: string[] = [];
  let parts: string[] | null = null;
  let quotedPrintable = false;
  for (const raw of text.split(/\r?\n/)) {
    const last = parts?.[parts.length - 1];
    if (parts && quotedPrintable && last?.endsWith("=")) {
      parts[parts.length - 1] = last.slice(0, -1);
      parts.push(raw.replace(/^[ \t]/, ""));
    } else if (parts && /^[ \t]/.test(raw)) {
      parts.push(raw.slice(1));
    } else {
      if (parts) lines.push(parts.join(""));
      parts = [raw];
      quotedPrintable = isQuotedPrintable(lineParams(raw));
    }
  }
  if (parts) lines.push(parts.join(""));
  return lines;
}

/** Quoted-printable `=XX` bytes (and literal ASCII) decoded as `charset`. */
function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < value.length; index += 1) {
    const hex = value[index] === "=" ? /^[0-9A-Fa-f]{2}$/.exec(value.slice(index + 1, index + 3)) : null;
    if (hex) {
      bytes.push(Number.parseInt(hex[0], 16));
      index += 2;
    } else {
      bytes.push(...encoder.encode(value[index]));
    }
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(new Uint8Array(bytes));
}

function parseVcards(text: string): ContactDraft[] {
  const cards: VcardField[][] = [];
  let card: VcardField[] | null = null;
  for (const line of vcardLines(text)) {
    if (/^\uFEFF?BEGIN:VCARD\s*$/i.test(line)) {
      card = [];
      continue;
    }
    if (/^END:VCARD\s*$/i.test(line)) {
      if (card) cards.push(card);
      card = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (!card || colon < 0) continue;
    const [rawKey = "", ...params] = line.slice(0, colon).split(";");
    const value = line.slice(colon + 1).trim();
    if (!value) continue;
    const charset = params.map(vcardParam).find(({ name }) => name === "CHARSET")?.value ?? "";
    // Apple groups related lines as `item1.TEL`.
    const key = rawKey.replace(/^[^.]*\./, "").toUpperCase();
    card.push({ key, params, value, quotedPrintable: isQuotedPrintable(params), charset });
  }
  return cards.flatMap((entries) => {
    const fields = new Map<string, VcardField[]>();
    for (const entry of entries) {
      fields.set(entry.key, [...(fields.get(entry.key) ?? []), entry]);
    }
    const first = (key: string) => fields.get(key)?.[0];
    const text = (field: VcardField | undefined) => (field ? unescapeVcard(decodedValue(field)) : "");
    // N:Family;Given;Additional;Prefix;Suffix
    const structured = splitField(first("N"), ";");
    // Given name only: the Pin matches a spoken first name against it whole.
    const firstName = structured[1] ?? "";
    const lastName = structured[0] ?? "";
    const nickname = splitField(first("NICKNAME"), ",")[0] ?? "";
    const displayName = text(first("FN"));
    if (!firstName && !lastName && !nickname && !displayName) return [];
    const categories = (fields.get("CATEGORIES") ?? [])
      .flatMap((field) => splitField(field, ","))
      .map((category) => category.toLowerCase());
    return [{
      firstName,
      lastName,
      nickname,
      displayName,
      phoneNumbers: uniqueValues((fields.get("TEL") ?? []).map((field) => ({
        value: text(field).replace(/^tel:/i, ""),
        type: labelFrom(vcardTypes(field.params)),
      }))),
      emails: uniqueValues((fields.get("EMAIL") ?? []).map((field) => ({
        value: text(field).replace(/^mailto:/i, ""),
        type: labelFrom(vcardTypes(field.params)),
      }))),
      organization: splitField(first("ORG"), ";")[0] || null,
      trusted: categories.includes("trusted") || truthy(text(first("X-HUMANE-TRUSTED"))),
      emergency: categories.includes("emergency") || truthy(text(first("X-HUMANE-EMERGENCY"))),
      favorite: ["favorite", "favourite", "starred"].some((category) => categories.includes(category)),
      source: "import:vcard",
    }];
  });
}

function decodedValue(field: VcardField): string {
  return field.quotedPrintable ? decodeQuotedPrintable(field.value, field.charset) : field.value;
}

/**
 * A compound value's components. Split on the literal separator before
 * decoding quoted-printable, so an encoded `=3B` stays inside its component.
 */
function splitField(field: VcardField | undefined, separator: ";" | ","): string[] {
  if (!field) return [];
  return splitVcard(
    field.value,
    separator,
    field.quotedPrintable ? (part) => decodeQuotedPrintable(part, field.charset) : undefined,
  );
}

/** The value encodings 2.1 may write as a bare parameter. They are not labels. */
const VCARD_ENCODINGS = new Set(["QUOTED-PRINTABLE", "BASE64", "B", "8BIT", "7BIT"]);

/** `TYPE=CELL,VOICE`, `TYPE=cell;TYPE=pref`, `type="work,voice"` and 2.1's bare `CELL`. */
function vcardTypes(params: string[]): string[] {
  return params.flatMap((param) => {
    const [name = "", value = ""] = param.includes("=") ? param.split("=", 2) : ["TYPE", param];
    if (!param.includes("=") && VCARD_ENCODINGS.has(param.trim().toUpperCase())) return [];
    return name.trim().toUpperCase() === "TYPE" ? value.replace(/"/g, "").split(",") : [];
  });
}

/** Split a vCard compound value on an unescaped separator, then decode and unescape. */
function splitVcard(
  value: string,
  separator: ";" | ",",
  decode?: (part: string) => string,
): string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      current += char + value[index + 1];
      index += 1;
    } else if (char === separator) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => unescapeVcard(decode ? decode(part) : part));
}

function unescapeVcard(value: string): string {
  return value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

/* -------------------------------------------------------------- shared --- */

/** Labels a Pin shows well. Anything else a file names is kept as written. */
const LABELS: Record<string, string> = {
  cell: "mobile",
  cellular: "mobile",
  mobile: "mobile",
  iphone: "iphone",
  home: "home",
  personal: "home",
  work: "work",
  business: "work",
  main: "main",
  other: "other",
  fax: "fax",
  pager: "pager",
};

/** Words that describe the medium or the column rather than the label. */
const IGNORED_LABELS = new Set([
  "voice", "pref", "internet", "x400", "text", "msg", "primary", "number", "address", "label", "value",
]);

function labelFrom(words: string[]): string {
  for (const word of words) {
    for (const token of word.replace(/^\*\s*/, "").toLowerCase().split(/[_\s]+/)) {
      if (!token || /^\d+$/.test(token) || IGNORED_LABELS.has(token)) continue;
      return LABELS[token] ?? token.slice(0, 40);
    }
  }
  return "";
}

/** Distinct, non-empty values, capped so one crowded entry cannot refuse a whole import. */
function uniqueValues(values: ContactValue[]): ContactValue[] {
  const seen = new Set<string>();
  return values
    .map(({ value, type }) => ({ value: value.trim(), type }))
    .filter(({ value }) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, MAX_CONTACT_VALUES);
}

function csvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/^﻿/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function pick(values: Record<string, string>, ...keys: string[]): string {
  return keys.map((key) => values[key]?.trim()).find(Boolean) ?? "";
}

function truthy(value: string): boolean {
  return /^(1|true|yes|y|on)$/i.test(value.trim());
}
