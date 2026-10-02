// The wearer's account over Cosmos's web plane, end to end through the BFF
// domain module, against a fake Cosmos webapi.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import test, { after } from "node:test";

/*
 * Profile, food preferences and devices are each one REST call on Cosmos's
 * `account-service` / `device-assignments` surface, carrying the wearer's
 * identity. Nothing goes to the gRPC plane and nothing uses the admin token.
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

let grpcConnections = 0;
const grpc = net.createServer((socket) => {
  grpcConnections += 1;
  socket.destroy();
});
await new Promise((resolve) => grpc.listen(0, "127.0.0.1", resolve));

process.env.COSMOS_WEBAPI_BASE_URL = `http://127.0.0.1:${webapi.address().port}`;
process.env.COSMOS_GRPC_ENDPOINT = `127.0.0.1:${grpc.address().port}`;
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
  grpc.close();
});

function lastRequest() {
  return requests.at(-1);
}

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the profile is read from Cosmos as the wearer, and unset fields are null", async () => {
  answer = () => ({
    status: 200,
    json: { preferredName: "", pronunciation: "ˈeɪdə", hasSecureBioData: true },
  });
  const result = await account.getAccountDetails();
  const request = lastRequest();
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/account-service/profile");
  assert.equal(request.headers["x-forwarded-client-cert"], "U:wearer-1");
  assert.equal(request.headers["x-cosmos-edge-token"], "edge-proof");
  assert.equal(request.headers.authorization, undefined, "never the admin token");
  assert.equal(result.state, "live");
  assert.deepEqual(result.data, {
    preferredName: null,
    pronunciation: "ˈeɪdə",
    hasSecureBioData: true,
  });

  answer = () => ({ status: 503, json: undefined });
  const down = await account.getAccountDetails();
  assert.equal(down.state, "degraded", "an outage is never 'nothing set'");
  assert.equal(down.data, null);
});

test("food preferences are read and written whole-list, one half at a time", async () => {
  const stored = {
    restrictions: [{ uuid: "r1", name: "Peanuts", restrictionType: "ALLERGY", severity: "SEVERE" }],
    dailyIntakeGoals: [{ uuid: "g1", type: "PROTEIN", unit: "GRAMS", min: 120 }],
    sealedRestrictions: 0,
  };
  answer = () => ({ status: 200, json: stored });
  const fetched = await account.getFoodPreferences();
  assert.equal(lastRequest().url, "/account-service/food-preferences");
  assert.deepEqual(fetched.data, stored);

  const goals = [{ uuid: "", type: "CALORIES", unit: "KCAL", max: 2200 }];
  await account.saveFoodPreferences({ dailyIntakeGoals: goals });
  assert.equal(lastRequest().method, "POST");
  assert.deepEqual(lastRequest().body, { dailyIntakeGoals: goals }, "the restrictions are left out, so kept");

  assert.deepEqual(account.parseFoodPreferencesWrite({ restrictions: [] }), { restrictions: [] });
  for (const bad of [null, {}, { restrictions: "x" }, { dailyIntakeGoals: {} }, { goals: [] }]) {
    assert.equal(account.parseFoodPreferencesWrite(bad), null, JSON.stringify(bad));
  }
});

test("today's food totals are Cosmos's arithmetic over one window", async () => {
  const totals = {
    logged: 2,
    nutrients: [
      { type: "CALORIES", unit: "KCAL", consumed: 650, min: 1800, status: "under", unreported: 0 },
    ],
  };
  answer = () => ({ status: 200, json: totals });
  const read = await account.getFoodIntake("2026-09-22T22:00:00.000Z", "2026-09-23T10:00:00.000Z");
  const request = lastRequest();
  assert.equal(request.method, "GET");
  const url = new URL(request.url, "http://cosmos");
  assert.equal(url.pathname, "/account-service/food-intake");
  assert.equal(url.searchParams.get("startTime"), "2026-09-22T22:00:00.000Z");
  assert.equal(url.searchParams.get("endTime"), "2026-09-23T10:00:00.000Z");
  assert.equal(request.headers["x-forwarded-client-cert"], "U:wearer-1");
  assert.equal(read.state, "live");
  assert.deepEqual(read.data, totals, "Center adds nothing up itself");

  answer = () => ({ status: 503, json: undefined });
  const down = await account.getFoodIntake("2026-09-22T22:00:00.000Z", "2026-09-23T10:00:00.000Z");
  assert.equal(down.state, "degraded", "an unreadable log is never an empty day");
  assert.equal(down.data, null);
});

test("devices and block mode are the wearer's own Cosmos calls", async () => {
  const devices = [
    { deviceId: "a1b2c3", pairedAt: "2026-09-01T10:00:00Z", blocked: false },
    { deviceId: "beef", blocked: true, blockedAt: "2026-09-20T08:00:00Z" },
  ];
  answer = () => ({ status: 200, json: { devices } });
  const listed = await account.getDevices();
  assert.equal(lastRequest().url, "/device-assignments/devices");
  assert.equal(lastRequest().headers.authorization, undefined, "never the admin token");
  assert.deepEqual(listed.data, devices);

  answer = ({ method }) => ({
    status: 200,
    json: { deviceId: "a1b2c3", blocked: method === "POST" },
  });
  const blocked = await account.setDeviceBlocked("a1b2c3", true);
  assert.equal(lastRequest().method, "POST");
  assert.equal(lastRequest().url, "/device-assignments/devices/a1b2c3/block");
  assert.equal(blocked.data.blocked, true);
  const unblocked = await account.setDeviceBlocked("a1b2c3", false);
  assert.equal(lastRequest().method, "DELETE");
  assert.equal(unblocked.data.blocked, false);

  answer = () => ({ status: 503, json: undefined });
  const down = await account.getDevices();
  assert.equal(down.state, "degraded");
  assert.deepEqual(down.data, [], "an unreadable roster is degraded, never 'no Pins'");
});

test("nothing reached the gRPC plane", () => {
  assert.ok(requests.length >= 8, "the calls above reached the fake webapi");
  assert.equal(grpcConnections, 0, "an account operation dialled the gRPC plane");
});

test("the device reads use Cosmos, not the operator's admin roster", async () => {
  const [status, pair, block, domain] = await Promise.all([
    read("app/api/devices/status/route.ts"),
    read("app/api/devices/pair/route.ts"),
    read("app/api/devices/[deviceId]/block/route.ts"),
    read("server/domain/account.ts"),
  ]);
  assert.doesNotMatch(status, /demo-api|adminAuthHeaders|COSMOS_ADMIN/u);
  const pairGet = /export async function GET\(\) \{([\s\S]*?)\n\}/u.exec(pair)?.[1] ?? "";
  assert.ok(pairGet.length > 0);
  assert.doesNotMatch(pairGet, /demo-api|adminAuthHeaders/u);
  assert.match(pairGet, /getDevices\(\)/u);
  assert.match(block, /isSameOriginRequest\(request\)/u);
  assert.doesNotMatch(domain, /\bServices\.|\bcall\(|adminAuthHeaders/u);
});

test("every account write refuses cross-site requests", async () => {
  const [details, food, devicesPage] = await Promise.all([
    read("app/api/account/details/route.ts"),
    read("app/api/account/food-preferences/route.ts"),
    read("app/devices/page.tsx"),
  ]);
  for (const route of [details, food]) {
    assert.match(route, /export async function POST\(request: Request\) \{\s*if \(!isSameOriginRequest\(request\)\)/u);
  }
  // The stock Pin sends a blocked wearer to humane.center/devices.
  assert.match(devicesPage, /redirect\("\/settings\/account\/devices"\)/u);
});
