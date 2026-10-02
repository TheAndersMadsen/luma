// The wearer's own identity writes, Pin pairing, the Pin passcode and account
// deletion, through the BFF domain module, against a fake Cosmos webapi.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test, { after } from "node:test";

/*
 * Each is one REST call on Cosmos's web plane carrying the wearer's own
 * identity. None uses the operator's admin token, and none names an account:
 * Cosmos takes the account from the caller.
 */

const requests = [];
let answer = () => ({ status: 500, json: { error: "no answer configured" } });

const webapi = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : undefined,
    };
    requests.push(request);
    const { status, json } = answer(request);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(json === undefined ? "" : JSON.stringify(json));
  });
});
await new Promise((resolve) => webapi.listen(0, "127.0.0.1", resolve));

process.env.COSMOS_WEBAPI_BASE_URL = `http://127.0.0.1:${webapi.address().port}`;
process.env.COSMOS_PRINCIPAL = "U:wearer-1";
process.env.COSMOS_EDGE_TOKEN = "edge-proof";
process.env.COSMOS_ADMIN_TOKEN = "admin-secret";
process.env.COSMOS_DEADLINE_MS = "3000";

const account = await import("../src/server/domain/account.ts");
const { setLogSinkForTests } = await import("../src/server/log.ts");
setLogSinkForTests(() => {});

after(() => {
  setLogSinkForTests(null);
  webapi.close();
});

const lastRequest = () => requests.at(-1);
const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("pairing posts only the device id, as the wearer, and names a Pin held elsewhere", async () => {
  answer = ({ body }) => ({ status: 200, json: { deviceId: body.deviceId, paired: true } });
  const paired = await account.pairDevice("a1b2c3");
  assert.equal(lastRequest().method, "POST");
  assert.equal(lastRequest().url, "/device-assignments/devices");
  assert.deepEqual(lastRequest().body, { deviceId: "a1b2c3" }, "no account is ever sent");
  assert.equal(lastRequest().headers.authorization, undefined, "never the admin token");
  assert.equal(lastRequest().headers["x-forwarded-client-cert"], "U:wearer-1");
  assert.deepEqual(paired.data, { deviceId: "a1b2c3", paired: true });

  answer = () => ({ status: 409, json: undefined });
  const taken = await account.pairDevice("a1b2c3");
  assert.equal(taken.state, "degraded");
  assert.equal(taken.degraded, account.PIN_PAIRED_ELSEWHERE);

  answer = () => ({ status: 400, json: undefined });
  assert.equal((await account.pairDevice("zz")).degraded, account.ACCOUNT_WRITE_REFUSED);

  answer = () => ({ status: 200, json: { deviceId: "a1b2c3", removed: true } });
  const released = await account.unpairDevice("a1b2c3");
  assert.equal(lastRequest().method, "DELETE");
  assert.equal(lastRequest().url, "/device-assignments/devices/a1b2c3");
  assert.equal(lastRequest().body, undefined);
  assert.deepEqual(released.data, { deviceId: "a1b2c3", removed: true });
});

test("the passcode is written to Cosmos and never read back", async () => {
  answer = () => ({ status: 200, json: { set: false } });
  const before = await account.getPasscodeState();
  assert.equal(lastRequest().url, "/account-service/passcode");
  assert.deepEqual(before.data, { set: false });

  answer = () => ({ status: 200, json: { set: true } });
  const saved = await account.setPasscode("4821");
  assert.equal(lastRequest().method, "PUT");
  assert.deepEqual(lastRequest().body, { passcode: "4821" });
  assert.deepEqual(saved.data, { set: true });

  answer = () => ({ status: 400, json: undefined });
  assert.equal((await account.setPasscode("4821")).degraded, account.ACCOUNT_WRITE_REFUSED);
  answer = () => ({ status: 503, json: undefined });
  assert.equal((await account.getPasscodeState()).state, "degraded", "an outage is never 'not set'");

  for (const good of ["0000", "4821"]) assert.equal(account.isPasscode(good), true, good);
  for (const bad of ["", "123", "12345", "12a4", " 1234", "１２３４", 1234, null]) {
    assert.equal(account.isPasscode(bad), false, JSON.stringify(bad));
  }
});

test("account deletion sends the confirmation and reports only Cosmos's own answer", async () => {
  answer = () => ({ status: 200, json: { deleted: true } });
  const deleted = await account.deleteAccount();
  assert.equal(lastRequest().method, "DELETE");
  assert.equal(lastRequest().url, "/account-service/account");
  assert.deepEqual(lastRequest().body, { confirm: "DELETE" });
  assert.equal(lastRequest().headers.authorization, undefined, "never the admin token");
  assert.deepEqual(deleted.data, { deleted: true });

  answer = () => ({ status: 500, json: undefined });
  const failed = await account.deleteAccount();
  assert.equal(failed.state, "degraded");
  assert.equal(failed.data, null);

  answer = () => ({ status: 409, json: undefined });
  const blocked = await account.deleteAccount();
  assert.equal(blocked.data, null, "a lost Pin keeps the account");
  assert.equal(blocked.degraded, account.LOST_PIN_BLOCKS_DELETION);
  assert.equal(blocked.refusal, "conflict");
  assert.match(account.LOST_PIN_BLOCKS_DELETION, /^Unmark your lost Pin first\./u);

  const route = await read("app/api/settings/privacy/account/route.ts");
  assert.match(
    route,
    /result\.refusal === "conflict"\) \{\s*return NextResponse\.json\(\s*\{ ok: false, deleted: false, error: LOST_PIN_BLOCKS_DELETION \},\s*\{ status: 409/u,
    "the wearer is told why, with a status the page can show",
  );
});

test("the routes gate every identity write on the signed-in wearer's same-origin request", async () => {
  const [passcode, deletion, pair] = await Promise.all([
    read("app/api/account/passcode/route.ts"),
    read("app/api/settings/privacy/account/route.ts"),
    read("app/api/devices/pair/route.ts"),
  ]);
  assert.match(
    passcode,
    /export async function PUT\(request: Request\) \{\s*if \(!isSameOriginRequest\(request\)\)/u,
  );
  assert.match(passcode, /isPasscode\(passcode\)/u, "Center refuses anything but four digits");
  assert.doesNotMatch(passcode, /passcode: body|\{ set: true, passcode/u, "the passcode is never echoed");

  const body = /export async function DELETE\(request: NextRequest\) \{([\s\S]*)\n\}/u.exec(deletion)?.[1] ?? "";
  const order = ["verifySession(", "isSameOriginRequest(request)", "CONFIRM_PHRASE", "deleteAccount()", "jar.delete(SESSION_COOKIE)"];
  let previous = -1;
  for (const step of order) {
    const at = body.indexOf(step);
    assert.ok(at > previous, `${step} must come after the steps before it`);
    previous = at;
  }
  assert.match(body, /clearTokenCookies\(jar/u, "the wearer is signed out");
  assert.match(body, /endSessionUrl\(/u, "including Keycloak's own session");
  assert.doesNotMatch(deletion, /status: 501/u);

  for (const route of [pair, passcode, deletion]) {
    assert.doesNotMatch(route, /demo-api|adminAuthHeaders/u);
  }
});
