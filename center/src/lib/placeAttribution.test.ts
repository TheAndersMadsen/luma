// @vitest-environment node
import { expect, it } from "vitest";
import { parsePlaceAttribution } from "./placeAttribution";

it("preserves every surrounding credit and multiple independently linked contributors", () => {
  expect(parsePlaceAttribution('© Maps by <a href="https://example.org/credit">A &amp; B</a>; photographs: <a href=\'https://other.example/\'>Café 📷</a>.'))
    .toEqual([
      { kind: "text", text: "© Maps by " },
      { kind: "link", text: "A & B", href: "https://example.org/credit" },
      { kind: "text", text: "; photographs: " },
      { kind: "link", text: "Café 📷", href: "https://other.example/" },
      { kind: "text", text: "." },
    ]);
  expect(parsePlaceAttribution("\tMap data & contributors\n")).toEqual([{ kind: "text", text: "\tMap data & contributors\n" }]);
});

it("decodes supported named and numeric entities exactly once into inert text", () => {
  expect(parsePlaceAttribution("&copy;&nbsp;&reg; &trade; &ndash; &mdash; &hellip; &middot; &bull; &quot;x&quot; &apos;y&apos; &#233; &#x1F4F7; &lt;script&gt; &amp;lt;"))
    .toEqual([{ kind: "text", text: "©\u00a0® ™ – — … · • \"x\" 'y' é 📷 <script> &lt;" }]);
  expect(parsePlaceAttribution('<a href="https://example.org/?a=1&amp;b=2#credit">&lt;b&gt;Credit&lt;/b&gt;</a>'))
    .toEqual([{ kind: "link", text: "<b>Credit</b>", href: "https://example.org/?a=1&b=2#credit" }]);
});

it("rejects an entire attribution if any markup or attribute is outside the supported language", () => {
  for (const source of [
    '<a href="https://example.org/">Credit</a><img src="https://tracking.example/">',
    'Credit <script>alert(1)</script>', 'Credit <!-- omitted -->', '<!DOCTYPE html>Credit',
    '<a href="https://example.org/" onclick="alert(1)">Credit</a>',
    '<a href="https://example.org/" target="_blank">Credit</a>',
    '<a href="https://example.org/" style="display:none">Credit</a>',
    '<a href="https://example.org/" href="https://other.example/">Credit</a>',
    '<a href="https://example.org/"><b>Credit</b></a>',
    '<a href="https://example.org/"><a href="https://other.example/">Credit</a></a>',
    '<A href="https://example.org/">Credit</A>', '<a HREF="https://example.org/">Credit</a>',
    '<a\nhref="https://example.org/">Credit</a>', '<a href=https://example.org/>Credit</a>',
    '<a href="https://example.org/">Credit', '<a href="https://example.org/">Credit</a >',
    '<a href="https://example.org/"/>Credit', 'Credit</a>', '<b>Credit</b>', 'Credit > source',
    '<a href="https://example.org/>Credit</a>', '<a href="https://example.org/\'>Credit</a>',
    '<a href="https://example.org/<credit">Credit</a>', '<a href="https://example.org/>credit">Credit</a>',
    '<a href="https://example.org/">Credit > source</a>', '<a href="https://example.org/">Credit</a></a>',
  ]) expect(() => parsePlaceAttribution(source)).toThrow("invalid_place_attribution");
});

it("allows only absolute HTTPS attribution links with no credentials or ambiguous controls", () => {
  for (const href of [
    "javascript:alert(1)", "data:text/html,credit", "http://example.org/", "file:///credit", "//example.org/", "/credit",
    "https:///example.org/", "https://", "https://user:password@example.org/", "https://user@example.org/", "https://@example.org/",
    "https://example.org/ credit", " https://example.org/", "https://example.org/\ncredit", "https://example.org/\tcredit",
    "https://example.org/\\credit", "https://example.org/&#92;credit", "https://example.org/&#9;credit",
    "https://example.org/%0acredit", "https://example.org/%5ccredit", "https://example.org/%20credit",
    "https://example.org/%C2%A0credit", "https://example.org/%E2%80%AEcredit", "https://example.org/%", "https://example.org/%ff",
    "https://example.org/\u202ecredit", "https://example.org/\0credit", "https://example.org/&quot;credit",
  ]) expect(() => parsePlaceAttribution(`<a href="${href}">Credit</a>`)).toThrow("invalid_place_attribution");
  for (const href of ["https://example.org", "https://example.org/credit?source=map#author", "https://example.org/caf%C3%A9"]) {
    expect(parsePlaceAttribution(`<a href="${href}">Credit</a>`)).toEqual([{ kind: "link", text: "Credit", href }]);
  }
});

it("rejects malformed, unsupported, and invalid Unicode entities without silently dropping credit", () => {
  for (const source of [
    "Credit &unknown;", "Credit &amp", "Credit &#;", "Credit &#x;", "Credit &#xZZ;", "Credit &#-1;",
    "Credit &#0;", "Credit &#xD800;", "Credit &#x110000;", "Credit &#999999999999999999999999;",
    "Credit &#10;unsafe\0", "Credit &#127;", "Credit &#x202E;", "Credit \ud800", "Credit \udfff",
    '<a href="https://example.org/">Credit</a> &unknown;',
  ]) expect(() => parsePlaceAttribution(source)).toThrow("invalid_place_attribution");
});

it("requires visible credit and a visible label for every link", () => {
  for (const source of ["", " \t\n", "&nbsp;", "\u200b", '<a href="https://example.org/"></a>',
    'Visible credit <a href="https://example.org/">&nbsp;</a>', 'Visible credit <a href="https://example.org/">\u200b</a>']) {
    expect(() => parsePlaceAttribution(source)).toThrow("invalid_place_attribution");
  }
});

it("enforces the provider's 2048 UTF-8 byte bound without truncation or replacement", () => {
  for (const text of ["a".repeat(2048), "é".repeat(1024), "📷".repeat(512)]) {
    expect(parsePlaceAttribution(text)).toEqual([{ kind: "text", text }]);
    expect(() => parsePlaceAttribution(text + "a")).toThrow("invalid_place_attribution");
  }
  const prefix = '<a href="https://example.org/">';
  const suffix = "</a>";
  const text = "a".repeat(2048 - prefix.length - suffix.length);
  expect(parsePlaceAttribution(prefix + text + suffix)).toEqual([{ kind: "link", text, href: "https://example.org/" }]);
  expect(() => parsePlaceAttribution(prefix + text + "a" + suffix)).toThrow("invalid_place_attribution");
});
