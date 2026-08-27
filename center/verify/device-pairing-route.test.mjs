import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../src/app/api/devices/pair/route.ts", import.meta.url),
  "utf8",
);
const devicesPage = await readFile(
  new URL("../src/app/settings/account/devices/page.tsx", import.meta.url),
  "utf8",
);

test("device-pairing writes require the authenticated browser's public origin", () => {
  assert.match(route, /import \{[\s\S]*isSameOriginRequest[\s\S]*\} from "@\/server\/auth";/u);
  assert.equal(
    route.match(/if \(!isSameOriginRequest\(request\)\)/gu)?.length,
    2,
    "POST and DELETE must each reject cross-origin requests",
  );

  for (const method of ["POST", "DELETE"]) {
    const body = new RegExp(
      `export async function ${method}\\(request: Request\\) \\{([\\s\\S]*?)(?=\\nexport async function|$)`,
      "u",
    ).exec(route)?.[1];
    assert.ok(body, `${method} route is missing`);
    assert.ok(
      body.indexOf("isSameOriginRequest(request)") < body.indexOf("/demo-api/admin/pair"),
      `${method} must enforce same-origin before calling Cosmos`,
    );
  }
});

test("the wearer UI pairs only the exact connected Pin instead of asking for a hardware ID", () => {
  assert.doesNotMatch(devicesPage, /PairPinRow/u);
  assert.doesNotMatch(devicesPage, /pair-device-id-field/u);
  assert.doesNotMatch(devicesPage, /placeholder="hardware ID/u);
  assert.doesNotMatch(devicesPage, />Pair a Pin below/u);
  assert.match(devicesPage, />\s*Open guided setup below/u);
  assert.match(devicesPage, /Open guided setup/u);
});
