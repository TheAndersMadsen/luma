// The operator releases a Pin's pairing whichever account holds it. A wearer
// cannot: the session is refused before the admin token is ever sent, and the
// page and its form action sit behind the operator gate twice. A Pin in
// lost-device block mode is released only with the operator's confirmation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test, { after } from "node:test";

const requests = [];
let answer = () => ({ status: 500, json: { error: "no answer configured" } });

const cosmos = createServer((req, res) => {
  requests.push({ method: req.method, url: req.url, headers: req.headers });
  const { status, json } = answer(req);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(json ?? null));
});
await new Promise((resolve) => cosmos.listen(0, "127.0.0.1", resolve));

process.env.COSMOS_WEBAPI_BASE_URL = `http://127.0.0.1:${cosmos.address().port}`;
process.env.COSMOS_ADMIN_TOKEN = "admin-secret";
process.env.COSMOS_DEADLINE_MS = "3000";

const { operatorPinPairings, releasePinPairing } = await import("../src/server/operator.ts");
const { isOperatorPath } = await import("../src/server/auth.ts");

after(() => cosmos.close());

const operator = { sub: "op-1", email: "op@example.com", name: "Operator", operator: true };
const wearer = { sub: "wearer-1", email: "w@example.com", name: "Wearer", operator: false };

test("a wearer or nobody cannot release a pairing or read the roster", async () => {
  answer = () => ({ status: 200, json: { released: true, pairings: [] } });
  const before = requests.length;
  for (const session of [wearer, null, { ...operator, operator: "true" }]) {
    assert.equal(await releasePinPairing(session, "a1b2c3"), "forbidden");
    assert.deepEqual(await operatorPinPairings(session), { state: "forbidden", pairings: [] });
  }
  assert.equal(requests.length, before, "Cosmos is never asked, so the admin token never leaves");
});

test("the operator releases a Pin whichever account holds it", async () => {
  answer = () => ({ status: 200, json: { device_id: "a1b2c3", released: true, account_sub: "claimer" } });
  assert.equal(await releasePinPairing(operator, " A1B2C3 "), "released");
  const sent = requests.at(-1);
  assert.equal(sent.method, "DELETE");
  assert.equal(sent.url, "/demo-api/admin/pairings/a1b2c3");
  assert.equal(sent.headers.authorization, "Bearer admin-secret");

  answer = () => ({ status: 200, json: { device_id: "a1b2c3", released: false, account_sub: null } });
  assert.equal(await releasePinPairing(operator, "a1b2c3"), "not-paired");
  answer = () => ({ status: 503, json: { error: "down" } });
  assert.equal(await releasePinPairing(operator, "a1b2c3"), "unavailable");
  assert.equal(requests.at(-1).url, "/demo-api/admin/pairings/a1b2c3", "no confirmation unless asked");

  const before = requests.length;
  for (const bad of ["", "../devices", "a1b2c3/block", "zz"]) {
    assert.equal(await releasePinPairing(operator, bad), "invalid", bad);
  }
  assert.equal(requests.length, before, "an id that is not a Pin's never reaches Cosmos");
});

test("a Pin in block mode is released only with the operator's confirmation", async () => {
  answer = () => ({ status: 409, json: { error: "This Pin is in lost-device block mode." } });
  assert.equal(await releasePinPairing(operator, "a1b2c3"), "blocked");
  assert.equal(requests.at(-1).url, "/demo-api/admin/pairings/a1b2c3");

  answer = () => ({ status: 200, json: { device_id: "a1b2c3", released: true, account_sub: "claimer" } });
  assert.equal(await releasePinPairing(operator, "a1b2c3", true), "released");
  const sent = requests.at(-1);
  assert.equal(sent.method, "DELETE");
  assert.equal(sent.url, "/demo-api/admin/pairings/a1b2c3?confirm_blocked=true");

  const before = requests.length;
  assert.equal(await releasePinPairing(wearer, "a1b2c3", true), "forbidden");
  assert.equal(requests.length, before, "a confirmation never opens the operator gate");
});

test("the operator reads the roster Cosmos keeps", async () => {
  answer = () => ({
    status: 200,
    json: {
      devices: [],
      pairings: [
        { device_id: "a1b2c3", account_sub: "claimer", paired_at_epoch: 1_758_000_000, blocked: false },
        {
          device_id: "0badcafe",
          account_sub: "owner",
          paired_at_epoch: 1_757_000_000,
          blocked: true,
          blocked_at_epoch: 1_758_500_000,
        },
        { device_id: "d00d", account_sub: "owner", paired_at_epoch: 1, blocked: "yes", blocked_at_epoch: 2 },
        { device_id: "feed", account_sub: "owner", paired_at_epoch: 3, blocked: null, blocked_at_epoch: null },
        { device_id: "not a pin", account_sub: "x", paired_at_epoch: 1 },
      ],
    },
  });
  assert.deepEqual(await operatorPinPairings(operator), {
    state: "live",
    pairings: [
      { deviceId: "a1b2c3", accountSub: "claimer", pairedAtEpoch: 1_758_000_000, blocked: false, blockedAtEpoch: null },
      { deviceId: "0badcafe", accountSub: "owner", pairedAtEpoch: 1_757_000_000, blocked: true, blockedAtEpoch: 1_758_500_000 },
      { deviceId: "d00d", accountSub: "owner", pairedAtEpoch: 1, blocked: null, blockedAtEpoch: null },
      { deviceId: "feed", accountSub: "owner", pairedAtEpoch: 3, blocked: null, blockedAtEpoch: null },
    ],
  });
  assert.equal(requests.at(-1).url, "/demo-api/admin/devices");
  answer = () => ({ status: 500, json: null });
  assert.equal((await operatorPinPairings(operator)).state, "unavailable");
});

test("the page and its release action are operator surfaces", async () => {
  assert.equal(isOperatorPath("/admin/pairings"), true, "middleware refuses everyone else first");
  const page = await readFile(new URL("../src/app/admin/pairings/page.tsx", import.meta.url), "utf8");
  const action = /async function releasePairing\(formData: FormData\) \{([\s\S]*?)\n\}/u.exec(page)?.[1] ?? "";
  assert.match(action, /"use server";/u);
  assert.ok(
    action.indexOf("requireOperatorSession(") >= 0 &&
      action.indexOf("requireOperatorSession(") < action.indexOf("releasePinPairing(session"),
    "the action decides the operator gate before it releases anything",
  );
  const render = /export default async function PinPairingsPage[\s\S]*$/u.exec(page)?.[0] ?? "";
  assert.ok(
    render.indexOf("requireOperatorSession(") < render.indexOf("operatorPinPairings(session)"),
    "the page decides the operator gate before it reads the roster",
  );
  assert.doesNotMatch(page, /adminAuthHeaders|process\.env/u, "the token stays in the server module");
});

test("the page shows block mode and asks for the confirmation unless a Pin is known unblocked", async () => {
  const page = await readFile(new URL("../src/app/admin/pairings/page.tsx", import.meta.url), "utf8");
  const action = /async function releasePairing\(formData: FormData\) \{([\s\S]*?)\n\}/u.exec(page)?.[1] ?? "";
  assert.match(action, /formData\.get\("confirmBlocked"\) === "yes"/u, "the action passes only an explicit confirmation");
  const row = /roster\.pairings\.map\(([\s\S]*?)\n {10}\}\)/u.exec(page)?.[1] ?? "";
  const confirmation = /\{pairing\.blocked !== false \? \(\s*<label[\s\S]*?<\/label>\s*\) : null\}/u.exec(row)?.[0] ?? "";
  assert.match(confirmation, /<input type="checkbox" name="confirmBlocked" value="yes" required \/>/u,
    "a blocked or unknown Pin's form needs the confirmation, even without JavaScript");
  assert.equal((row.match(/name="confirmBlocked"/gu) ?? []).length, 1, "a Pin known unblocked has no confirmation");
  assert.match(row, /pairing\.blocked === true\s*\? `Block mode is on/u);
  assert.match(row, /pairing\.blocked === null\s*\? "Cosmos could not read whether this Pin is in block mode\."/u);
});
