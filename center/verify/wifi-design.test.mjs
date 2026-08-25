import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../src/app/wifi/page.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/app/wifi/wifi.module.css", import.meta.url), "utf8");
const frame = await readFile(new URL("../src/components/PublicUtilityFrame.tsx", import.meta.url), "utf8");

test("public Wi-Fi setup uses public chrome without private navigation", () => {
  assert.match(page, /PublicUtilityFrame/);
  assert.match(frame, /showAccountMenu=\{false\}/);
  assert.match(frame, /showNav=\{false\}/);
  assert.doesNotMatch(frame, /SettingsNav/);
  assert.match(frame, /<Shell/);
});

test("the Wi-Fi back button returns to the previous page with a direct-load fallback", () => {
  assert.match(frame, /useRouter\(\)/);
  assert.match(frame, /window\.history\.length > 1/);
  assert.match(frame, /router\.back\(\)/);
  assert.match(frame, /router\.replace\("\/"\)/);
  assert.doesNotMatch(frame, /<Link href="\/"/);
});

test("Wi-Fi credentials remain browser-local and no dead support link is shown", () => {
  assert.match(page, /stay in this browser/);
  assert.doesNotMatch(page, /humane\.com\/support/);
  assert.doesNotMatch(page, /fetch\(/);
});

test("Wi-Fi fields cannot be mistaken for the Center sign-in form", () => {
  assert.match(page, /<form[\s\S]*autoComplete="off"/);
  assert.match(page, /name="wifi-ssid"[\s\S]*autoComplete="off"/);
  assert.match(page, /name="wifi-network-key"[\s\S]*autoComplete="new-password"/);
  assert.match(page, /data-1p-ignore="true"/);
  assert.match(page, /data-lpignore="true"/);
  assert.match(page, /data-form-type="other"/);
});

test("Wi-Fi setup uses settings rows while keeping the QR scan surface white", () => {
  assert.match(page, /settings\.section/);
  assert.match(styles, /var\(--hu-divider\)/);
  assert.match(styles, /\.qrWrap[\s\S]*var\(--hu-colors-white\)/);
});
