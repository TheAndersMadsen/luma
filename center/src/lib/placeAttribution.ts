export type PlaceAttributionPart =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

// Matches the provider evidence bound; parsing never truncates required credit.
const MAX_ATTRIBUTION_BYTES = 2048;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "©", reg: "®", trade: "™", ndash: "–", mdash: "—",
  hellip: "…", middot: "·", bull: "•", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
};
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function invalid(): never { throw new Error("invalid_place_attribution"); }

function checkedText(text: string): string {
  if (FORBIDDEN_TEXT.test(text)) invalid();
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) invalid();
  }
  return text;
}

function visible(text: string): boolean {
  return /[^\s\p{Cf}]/u.test(text);
}

function decodeEntities(source: string): string {
  let text = "";
  for (let index = 0; index < source.length;) {
    if (source[index] !== "&" || !/[#A-Za-z0-9]/.test(source[index + 1] ?? "")) {
      text += source[index++];
      continue;
    }
    const entity = /^&(#(?:[xX][0-9A-Fa-f]+|[0-9]+)|[A-Za-z][A-Za-z0-9]*);/.exec(source.slice(index));
    if (!entity) invalid();
    const name = entity[1];
    if (name.startsWith("#")) {
      const hex = name[1] === "x" || name[1] === "X";
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid();
      text += String.fromCodePoint(code);
    } else {
      if (!Object.hasOwn(ENTITIES, name)) invalid();
      text += ENTITIES[name];
    }
    index += entity[0].length;
  }
  return checkedText(text);
}

function checkedHref(source: string): string {
  const href = decodeEntities(source);
  if (!/^https:\/\/[^/?#]+(?:[/?#]|$)/.test(href) || /[\s\p{Cc}\p{Cf}\\<>"'`]/u.test(href)
    || /%(?![0-9a-f]{2})/i.test(href)) invalid();
  let decoded: string;
  let url: URL;
  try {
    decoded = decodeURIComponent(href);
    url = new URL(href);
  } catch { return invalid(); }
  if (/[\s\p{Cc}\p{Cf}\\]/u.test(decoded) || url.protocol !== "https:" || !url.hostname
    || url.username || url.password || href.slice(8).split(/[/?#]/, 1)[0].includes("@")) invalid();
  return href;
}

/**
 * Inert credit tokens for React text and anchors. The supported HTML language is
 * plain text plus lowercase <a href="HTTPS URL">text</a> (either quote style).
 * No DOM parser, network resource, markup insertion, or partial credit recovery.
 */
export function parsePlaceAttribution(source: string): PlaceAttributionPart[] {
  if (typeof source !== "string" || source.length > MAX_ATTRIBUTION_BYTES
    || new TextEncoder().encode(source).length > MAX_ATTRIBUTION_BYTES) invalid();
  checkedText(source);
  const parts: PlaceAttributionPart[] = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "<") {
      const next = source.indexOf("<", index);
      const end = next === -1 ? source.length : next;
      const text = source.slice(index, end);
      if (text.includes(">")) invalid();
      parts.push({ kind: "text", text: decodeEntities(text) });
      index = end;
      continue;
    }
    const opening = "<a href=";
    if (!source.startsWith(opening, index)) invalid();
    const quoteIndex = index + opening.length;
    const quote = source[quoteIndex];
    if (quote !== '"' && quote !== "'") invalid();
    const hrefStart = quoteIndex + 1;
    const hrefEnd = source.indexOf(quote, hrefStart);
    if (hrefEnd === -1 || source[hrefEnd + 1] !== ">") invalid();
    const href = source.slice(hrefStart, hrefEnd);
    if (href.includes("<") || href.includes(">")) invalid();
    const bodyStart = hrefEnd + 2;
    const closing = "</a>";
    const bodyEnd = source.indexOf(closing, bodyStart);
    if (bodyEnd === -1) invalid();
    const body = source.slice(bodyStart, bodyEnd);
    if (body.includes("<") || body.includes(">")) invalid();
    const text = decodeEntities(body);
    if (!visible(text)) invalid();
    parts.push({ kind: "link", text, href: checkedHref(href) });
    index = bodyEnd + closing.length;
  }
  if (!parts.some(part => visible(part.text))) invalid();
  return parts;
}
