import "./tsResolve.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { parseDeviceEdgeDeclaration } = await import("../src/lib/pin-setup/steps.ts");

test("device edge declarations distinguish absent, available, and invalid", () => {
  assert.deepEqual(parseDeviceEdgeDeclaration(undefined), {
    state: "absent",
    edgeIpv4: null,
  });
  assert.deepEqual(parseDeviceEdgeDeclaration("   "), {
    state: "absent",
    edgeIpv4: null,
  });
  assert.deepEqual(parseDeviceEdgeDeclaration(" 203.0.113.9 "), {
    state: "available",
    edgeIpv4: "203.0.113.9",
  });

  for (const invalid of [
    "203.0.113",
    "203.0.113.9.1",
    "203.0.113.256",
    "203.0.113.-1",
    "203.0.113.01",
    "example.com",
    "2001:db8::1",
  ]) {
    const parsed = parseDeviceEdgeDeclaration(invalid);
    assert.equal(parsed.state, "invalid", invalid);
    assert.equal(parsed.edgeIpv4, null, invalid);
  }
});

test("the endpoint and client preserve invalid as its own state", async () => {
  const [route, readings] = await Promise.all([
    readFile(new URL("../src/app/api/pin/edge/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/settings/pin/setup/usePinSetupFacts.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(route, /declaration\.state === "invalid" \? 500 : 200/);
  assert.match(route, /"cache-control": "private, no-store"/);
  assert.match(readings, /value\.state === "invalid"/);
  assert.match(readings, /expectedEdgeState/);
});
