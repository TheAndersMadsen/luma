import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../src/app/settings/account/features/page.tsx", import.meta.url), "utf8");
const route = await readFile(new URL("../src/app/api/settings/features/route.ts", import.meta.url), "utf8");
const domain = await readFile(new URL("../src/server/domain/features.ts", import.meta.url), "utf8");

test("wearer features use a separate authenticated endpoint", () => {
  assert.match(page, /\/api\/settings\/features/);
  assert.doesNotMatch(page, /\/api\/admin\/flags/);
  assert.match(route, /verifySession/);
  assert.match(route, /isSameOriginRequest/);
});

test("each wearer's features are their own account's, read and written on the web plane", () => {
  // Cosmos keeps the choices per account and resolves the caller from the
  // wearer's own Bearer. Nothing here reaches the operator's admin surface.
  assert.match(domain, /\/feature-flags\/features/);
  assert.match(domain, /webapiHeaders|webapiGet/);
  assert.doesNotMatch(domain, /adminAuthHeaders|\/demo-api\/flags/);
  assert.doesNotMatch(route, /operatorGateOutcome/);
});

test("which features a wearer may change is Cosmos's decision", () => {
  // The allowlist lives in Cosmos (`flag_overrides::FEATURES`). Center must not
  // keep a second copy that could drift from it.
  assert.doesNotMatch(domain, /WEARER_FEATURES/);
  assert.doesNotMatch(route, /WEARER_FEATURES/);
  for (const name of ["synapse_prod_logging_enabled", "server_side_speech_synthesis_streaming_enabled", "demo_v2_enabled"]) {
    assert.doesNotMatch(route, new RegExp(`"${name}"`));
    assert.doesNotMatch(page, new RegExp(`"${name}"`));
  }
});
