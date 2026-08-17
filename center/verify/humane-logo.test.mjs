import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stockPath =
  "m25.12,47.71c12.09,-0.55 22.04,-10.5 22.59,-22.59c0.62,-13.62 -10.23,-24.85 -23.72,-24.85c-0.86,12.67 -11.05,22.86 -23.72,23.72l0,0c0,13.49 11.23,24.34 24.85,23.72";

test("HumaneLogo preserves the archived Center partial-eclipse geometry", async () => {
  const source = await readFile(new URL("../src/icons/index.tsx", import.meta.url), "utf8");

  assert.match(source, /viewBox="0 0 48 48"/);
  assert.ok(source.includes(`d="${stockPath}"`));
  assert.match(source, /<desc>a graphic of a partial eclipse<\/desc>/);
  assert.doesNotMatch(source, /fillRule="evenodd"/);
});

test("the system footer renders the stock mark at its original 24px size", async () => {
  const source = await readFile(new URL("../src/components/Shell.tsx", import.meta.url), "utf8");
  const footerLogo = source.match(
    /data-testid="humane-logo"[\s\S]*?<HumaneLogo size=\{(\d+)\} \/>/,
  );

  assert.ok(footerLogo, "footer Humane logo is present");
  assert.equal(footerLogo[1], "24");
});
