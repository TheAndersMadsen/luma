export interface ImportedContact {
  displayName: string;
  phoneNumbers: string[];
  emails: string[];
  organization: string | null;
  trusted: boolean;
  emergency: boolean;
}

export function parseContactFile(text: string, filename: string): ImportedContact[] {
  const looksLikeVcard = /BEGIN:VCARD/i.test(text) || /\.vc(?:f|ard)$/i.test(filename);
  const contacts = looksLikeVcard ? parseVcards(text) : parseCsv(text);
  return contacts.filter((contact) => contact.displayName.trim()).slice(0, 500);
}

function parseCsv(text: string): ImportedContact[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].sort(
    (a, b) => firstLine.split(b).length - firstLine.split(a).length,
  )[0];
  const rows = csvRows(text, delimiter);
  const rawHeaders = rows.shift() ?? [];
  const headers = rawHeaders.map((header) => normalizeHeader(header));
  return rows.flatMap((row) => {
    const values = Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim() ?? ""]));
    const first = pick(values, "first_name", "firstname", "given_name");
    const last = pick(values, "last_name", "lastname", "family_name", "surname");
    const displayName = pick(values, "display_name", "full_name", "name") || [first, last].filter(Boolean).join(" ");
    if (!displayName) return [];
    return [{
      displayName,
      phoneNumbers: collect(values, ["phone", "telephone", "mobile", "cell"]),
      emails: collect(values, ["email", "e_mail"]),
      organization: pick(values, "organization", "organisation", "company") || null,
      trusted: truthy(pick(values, "trusted", "favorite", "favourite")),
      emergency: truthy(pick(values, "emergency", "ice")),
    }];
  });
}

function parseVcards(text: string): ImportedContact[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  return [...unfolded.matchAll(/BEGIN:VCARD([\s\S]*?)END:VCARD/gi)].flatMap((match) => {
    const fields = new Map<string, string[]>();
    for (const line of match[1].split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).split(";", 1)[0].toUpperCase();
      const value = unescapeVcard(line.slice(colon + 1).trim());
      if (value) fields.set(key, [...(fields.get(key) ?? []), value]);
    }
    const structuredName = (fields.get("N")?.[0] ?? "").split(";");
    const displayName = fields.get("FN")?.[0]
      || [structuredName[1], structuredName[0]].filter(Boolean).join(" ");
    if (!displayName) return [];
    const categories = (fields.get("CATEGORIES") ?? []).join(",").toLowerCase();
    return [{
      displayName,
      phoneNumbers: unique(fields.get("TEL") ?? []),
      emails: unique(fields.get("EMAIL") ?? []),
      organization: fields.get("ORG")?.[0]?.split(";", 1)[0] || null,
      trusted: categories.includes("trusted") || truthy(fields.get("X-HUMANE-TRUSTED")?.[0] ?? ""),
      emergency: categories.includes("emergency") || truthy(fields.get("X-HUMANE-EMERGENCY")?.[0] ?? ""),
    }];
  });
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
  return value.trim().toLowerCase().replace(/^\ufeff/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function pick(values: Record<string, string>, ...keys: string[]): string {
  return keys.map((key) => values[key]?.trim()).find(Boolean) ?? "";
}

function collect(values: Record<string, string>, prefixes: string[]): string[] {
  return unique(Object.entries(values)
    .filter(([key]) => prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}_`)))
    .flatMap(([, value]) => value.split(/\s*[|]\s*/))
    .map((value) => value.trim())
    .filter(Boolean));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truthy(value: string): boolean {
  return /^(1|true|yes|y|on)$/i.test(value.trim());
}

function unescapeVcard(value: string): string {
  return value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}
