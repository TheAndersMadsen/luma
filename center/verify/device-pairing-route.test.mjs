import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../src/app/api/devices/pair/route.ts", import.meta.url),
  "utf8",
);

test("device-pairing writes require the signed-in wearer's same-origin request", () => {
  assert.match(route, /import \{[\s\S]*isSameOriginRequest[\s\S]*\} from "@\/server\/auth";/u);
  const gate = /async function wearerRequest\(request: Request\) \{([\s\S]*?)\n\}/u.exec(route)?.[1];
  assert.ok(gate, "the shared write gate is missing");
  assert.ok(
    gate.indexOf("verifySession(") < gate.indexOf("isSameOriginRequest(request)"),
    "the gate reads the session, then refuses a cross-origin request",
  );

  for (const [method, call] of [
    ["POST", "pairDevice("],
    ["DELETE", "unpairDevice("],
  ]) {
    const body = new RegExp(
      `export async function ${method}\\(request: Request\\) \\{([\\s\\S]*?)(?=\\nexport async function|\\n/\\*\\*|$)`,
      "u",
    ).exec(route)?.[1];
    assert.ok(body, `${method} route is missing`);
    assert.ok(body.includes("wearerRequest(request)"), `${method} must pass the write gate`);
    assert.ok(
      body.indexOf("wearerRequest(request)") < body.indexOf(call),
      `${method} must pass the write gate before calling Cosmos`,
    );
  }
});

test("pairing uses the wearer's own Cosmos identity, never the operator token", () => {
  assert.doesNotMatch(route, /demo-api|adminAuthHeaders|COSMOS_ADMIN|account_sub/u);
  assert.match(route, /status: 409/u, "a Pin another account holds is a conflict");
});
