import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../src/app/wifi/page.tsx", import.meta.url), "utf8");

test("Wi-Fi credentials remain browser-local and no dead support link is shown", () => {
  assert.match(page, /stay in this browser/);
  assert.doesNotMatch(page, /humane\.com\/support/);
  assert.doesNotMatch(page, /fetch\(/);
});
