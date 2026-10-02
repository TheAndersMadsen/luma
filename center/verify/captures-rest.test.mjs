import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

/*
 * Captures go over Cosmos's `capture` webapi and nothing else.
 *
 * A stand-in Cosmos answers the recovered humane.center routes, and every
 * capture action Center offers, the grid's pages and favourites filter, the
 * waiting list, favourites, tags, deletes, the share link and the food log,
 * is asserted to reach exactly the route humane.center called, with the
 * wearer's identity, and to come back in Center's own shape.
 */

const requests = [];
const routes = new Map();
const cosmos = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const entry = { method: request.method, url: request.url, headers: request.headers, body };
  requests.push(entry);
  const handler = routes.get(`${request.method} ${request.url.split("?")[0]}`);
  const { status = 200, json, headers = {} } = handler ? handler(entry) : { status: 404 };
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(json === undefined ? "" : JSON.stringify(json));
});
await new Promise((resolve) => cosmos.listen(0, "127.0.0.1", resolve));
test.after(() => cosmos.close());

process.env.COSMOS_WEBAPI_BASE_URL = `http://127.0.0.1:${cosmos.address().port}`;
process.env.COSMOS_PRINCIPAL = "U:captures-rest-test";
const captures = await import("../src/server/domain/captures.ts?captures-rest");

function memory(overrides = {}) {
  return {
    uuid: "11111111-2222-4333-8444-555555555555",
    id: 7,
    deviceLocalId: "pin-7",
    type: "PHOTO",
    userCreatedAt: 1_788_336_000,
    createdAt: 1_788_336_010,
    uploadComplete: true,
    uploadState: "complete",
    deleted: false,
    thumbnailCount: 3,
    hasLocation: false,
    burstCount: 1,
    frameCount: 3,
    favorite: false,
    tags: [],
    visualSearchReady: false,
    sealed: true,
    ...overrides,
  };
}

function page(content, extra = {}) {
  return {
    content,
    number: 0,
    size: 200,
    totalElements: content.length,
    totalPages: 1,
    last: true,
    first: true,
    numberOfElements: content.length,
    empty: content.length === 0,
    ...extra,
  };
}

test("the grid walks the library page by page and filters favourites in Cosmos", async () => {
  requests.length = 0;
  routes.set("GET /capture/captures", ({ url }) => ({
    json: page([memory({ favorite: url.includes("onlyContainingFavorited=true") })], {
      number: 1,
      totalElements: 401,
      last: false,
    }),
  }));
  const second = await captures.getCaptures(200, { page: 1, favorites: true });
  assert.equal(requests.at(-1).url, "/capture/captures?page=1&size=200&onlyContainingFavorited=true");
  assert.equal(second.state, "live");
  assert.equal(second.total, 401);
  assert.equal(second.page, 1);
  assert.equal(second.last, false);
  assert.equal(second.data[0].data.favorite, true);
  assert.equal(second.data[0].data.uploadState, "complete");

  await captures.getCaptures();
  assert.equal(requests.at(-1).url, "/capture/captures?page=0&size=200", "no filter unless asked");
  assert.equal(requests.at(-1).headers["x-forwarded-client-cert"], "U:captures-rest-test");
});

test("search asks Cosmos to narrow the matches, favourites included", async () => {
  requests.length = 0;
  routes.set("GET /capture/search", ({ url }) => ({
    json: page([memory({ favorite: url.includes("onlyContainingFavorited=true") })]),
  }));
  const result = await captures.searchCaptures("beach", 0, 200, { favorites: true });
  assert.equal(requests.at(-1).url, "/capture/search?query=beach&page=0&size=200&onlyContainingFavorited=true");
  assert.equal(result.state, "live");
  assert.equal(result.data[0].data.favorite, true);

  await captures.searchCaptures("beach");
  assert.equal(
    requests.at(-1).url,
    "/capture/search?query=beach&page=0&size=200",
    "no filter unless asked",
  );
});

test("deletes are Cosmos REST deletes, never the Pin's gRPC", async () => {
  requests.length = 0;
  const uuid = memory().uuid;
  routes.set(`DELETE /capture/memory/${uuid}`, () => ({ json: { deleted: true } }));
  assert.equal((await captures.deleteMemory(uuid)).state, "live");
  routes.set(`DELETE /capture/memory/${uuid}`, () => ({ json: { deleted: false } }));
  assert.equal((await captures.deleteMemory(uuid)).state, "live", "already gone is gone");
  routes.set(`DELETE /capture/memory/${uuid}`, () => ({ status: 500 }));
  const failed = await captures.deleteMemory(uuid);
  assert.equal(failed.state, "degraded", "a delete Cosmos could not do is never reported as done");

  routes.set("POST /capture/memory/bulk-delete", ({ body }) => {
    const { memoryUUIDs } = JSON.parse(body);
    return { json: { deleted: [memoryUUIDs[0]], notFound: [], failed: [memoryUUIDs[1]] } };
  });
  const bulk = await captures.deleteMemories(["a", "b"]);
  assert.deepEqual(bulk.data, { deleted: ["a"], notFound: [], failed: ["b"] });
  assert.deepEqual(JSON.parse(requests.at(-1).body), { memoryUUIDs: ["a", "b"] });

  const domain = await readFile(new URL("../src/server/domain/captures.ts", import.meta.url), "utf8");
  assert.doesNotMatch(domain, /Services\.capture|"DeleteMemory"|channelKey|openEnvelope/);
});

test("favourites and tags reach the recovered routes", async () => {
  const uuid = memory().uuid;
  routes.set(`POST /capture/memory/${uuid}/favorite`, () => ({
    json: { ...memory({ favorite: true }), gmtOffsetHours: 0, frames: [] },
  }));
  assert.equal((await captures.setCaptureFavorite(uuid, true)).data.favorite, true);
  routes.set(`POST /capture/memory/${uuid}/unfavorite`, () => ({
    json: { ...memory({ favorite: false }), gmtOffsetHours: 0, frames: [] },
  }));
  assert.equal((await captures.setCaptureFavorite(uuid, false)).data.favorite, false);

  routes.set("POST /capture/memory/bulk-favorite", ({ body }) => ({
    json: { updated: JSON.parse(body).memoryUUIDs.length },
  }));
  assert.equal(await captures.setCapturesFavorite(["a", "b", "c"], true), 3);

  routes.set(`POST /capture/memory/${uuid}/tag`, ({ body }) => ({
    json: { ...memory({ tags: [JSON.parse(body).text] }), gmtOffsetHours: 0, frames: [] },
  }));
  assert.deepEqual((await captures.addCaptureTag(uuid, "beach day")).data.tags, ["beach day"]);
  routes.set(`DELETE /capture/memory/${uuid}/tag/beach%20day`, () => ({ json: { deleted: true } }));
  assert.equal(await captures.removeCaptureTag(uuid, "beach day"), true);
});

test("the waiting list and the food log come back in Center's shape", async () => {
  routes.set("GET /capture/pending-memory-creates", () => ({
    json: [{ deviceLocalId: "pin-9", memoryType: "VIDEO", delayReason: "POOR_NETWORK", declaredAt: 1_788_336_000 }],
  }));
  const pending = await captures.getPendingCaptures();
  assert.deepEqual(pending.data, [
    { deviceLocalId: "pin-9", memoryType: "VIDEO", delayReason: "POOR_NETWORK", declaredAt: "2026-09-02T08:00:00.000Z" },
  ]);
  routes.set("DELETE /capture/pending-memory-creates", () => ({ json: { deleted: true } }));
  assert.equal((await captures.clearPendingCaptures()).data, true);

  requests.length = 0;
  routes.set("GET /capture/food-log", () => ({
    json: [{
      memoryUuid: "meal-2",
      loggedAt: 1_788_336_000,
      itemName: "Ramen",
      typicalServingSize: "1 bowl",
      servingsConsumed: 1.5,
      nutritionInfo: [{ nutrientType: "CALORIES", value: 350 }],
    }],
  }));
  const log = await captures.getFoodLog("2026-09-02T00:00:00.000Z", "2026-09-02T23:59:59.000Z");
  assert.equal(
    requests.at(-1).url,
    "/capture/food-log?startTime=2026-09-02T00%3A00%3A00.000Z&endTime=2026-09-02T23%3A59%3A59.000Z",
  );
  assert.deepEqual(log.data, [{
    loggedAt: "2026-09-02T08:00:00.000Z",
    itemName: "Ramen",
    brand: undefined,
    typicalServingSize: "1 bowl",
    servingsConsumed: 1.5,
    nutritionInfo: [{ nutrientType: "CALORIES", value: 350 }],
  }]);
  assert.equal(log.state, "live");
  assert.equal(log.degraded, undefined);

  // An entry sealed under a key Cosmos has not received does not blank the
  // day: the rest are listed and the count rides on the live read.
  routes.set("GET /capture/food-log", () => ({ json: [], headers: { "x-cosmos-sealed": "2" } }));
  const partial = await captures.getFoodLog("2026-09-02T00:00:00.000Z", "2026-09-02T23:59:59.000Z");
  assert.equal(partial.state, "live");
  assert.match(partial.degraded, /^2 entries are encrypted with a key this server doesn't have yet/);
});

test("the share button asks Cosmos for the stock-shaped link", async () => {
  const uuid = memory().uuid;
  const url = `https://luma.example.com/humane.center/share/capture/${uuid}?expiry=1790000000&signature=abc`;
  routes.set(`POST /capture/memory/${uuid}/share-link`, () => ({
    json: { url, memoryUuid: uuid, expiry: 1_790_000_000 },
  }));
  assert.deepEqual(await captures.createCaptureShareLink(uuid), { url, memoryUuid: uuid, expiry: 1_790_000_000 });

  const route = await readFile(
    new URL("../src/app/api/capture/memory/[uuid]/share/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /createCaptureShareLink\(uuid\)/);
  assert.doesNotMatch(route, /mintShareToken|getCaptureFrame/);
});
