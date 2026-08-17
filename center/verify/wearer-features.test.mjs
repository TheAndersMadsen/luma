import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../src/app/settings/account/features/page.tsx", import.meta.url), "utf8");
const route = await readFile(new URL("../src/app/api/settings/features/route.ts", import.meta.url), "utf8");

test("wearer features use a separate authenticated endpoint", () => {
  assert.match(page, /\/api\/settings\/features/);
  assert.doesNotMatch(page, /\/api\/admin\/flags/);
  assert.match(route, /verifySession/);
  assert.match(route, /isSameOriginRequest/);
});

test("wearer endpoint allowlists device-delivered controls", () => {
  for (const name of ["touchcode_enabled", "vision_actions_enabled", "network_reset_enabled"]) {
    assert.match(route, new RegExp(`"${name}"`));
  }
  for (const name of ["synapse_prod_logging_enabled", "server_side_speech_synthesis_streaming_enabled", "demo_v2_enabled"]) {
    assert.doesNotMatch(route, new RegExp(`"${name}"`));
  }
  assert.match(route, /WEARER_FEATURES\.has\(name\)/);
});
