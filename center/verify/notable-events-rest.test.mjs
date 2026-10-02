// My Data, its overview, search, votes and the Memories dashboard over
// Cosmos's web plane, end to end through the BFF domain modules, against a
// fake Cosmos webapi. The domain modules import extensionless TypeScript
// siblings.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import test, { after } from "node:test";

/*
 * Cosmos owns every domain filter, count and grouping. Center makes one REST
 * call per read, carrying the wearer's identity, and never opens a gRPC
 * connection to count or filter events itself: the gRPC endpoint below counts
 * every connection and must stay at zero.
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
process.env.COSMOS_DEADLINE_MS = "3000";

const events = await import("../src/server/domain/events.ts");
const { setLogSinkForTests } = await import("../src/server/log.ts");
setLogSinkForTests(() => {});

after(() => {
  setLogSinkForTests(null);
  webapi.close();
  grpc.close();
});

function page(content, totalElements = content.length) {
  return {
    content,
    number: 0,
    size: 50,
    totalElements,
    totalPages: Math.ceil(totalElements / 50),
    last: totalElements <= 50,
    first: true,
    numberOfElements: content.length,
    empty: content.length === 0,
  };
}

const TRANSLATION = {
  uuid: "tr-1",
  userCreatedAt: "2024-10-13T15:52:00.000Z",
  data: {
    eventType: "humane.translation",
    eventData: { sourceLanguage: "English", targetLanguage: "Spanish" },
  },
};

const lastRequest = () => requests.at(-1);

test("a My Data page is asked of Cosmos by domain and read back verbatim", async () => {
  const sealed = { uuid: "s", userCreatedAt: "", data: { eventType: "humane.translation", eventData: {}, sealed: true } };
  answer = () => ({ status: 200, json: page([TRANSLATION, sealed], 120) });
  const result = await events.getMyData("TRANSLATION", { page: 1, size: 50 });

  const request = lastRequest();
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/notable-events/mydata?page=1&size=50&domain=TRANSLATION");
  assert.equal(request.headers["x-forwarded-client-cert"], "U:wearer-1");
  assert.equal(request.headers["x-cosmos-edge-token"], "edge-proof");
  assert.equal(result.state, "live");
  assert.equal(result.data.totalElements, 120);
  assert.deepEqual(result.data.content[0], TRANSLATION);
  assert.match(result.degraded ?? "", /1 entry sealed/);
});

test("Ai Mic and Music are searched by Cosmos's recovered search, in the My Data row shape", async () => {
  const hit = {
    uuid: "q-1",
    userCreatedAt: "2025-02-11T22:57:00.000Z",
    data: { eventType: "humane.respond", eventData: { request: "How tall is the Eiffel Tower", response: "330 m." } },
  };
  answer = () => ({ status: 200, json: page([hit], 1) });
  const result = await events.searchMyData("AI_MIC", "eiffel & tower", { page: 0, size: 50 });

  const request = lastRequest();
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/ai-bus/search?page=0&size=50&domain=AI_MIC&query=eiffel+%26+tower");
  assert.equal(request.headers["x-forwarded-client-cert"], "U:wearer-1");
  assert.equal(result.state, "live");
  assert.deepEqual(result.data.content, [hit]);
  assert.deepEqual([...events.MY_DATA_SEARCH_DOMAINS], ["AI_MIC", "MUSIC"]);

  answer = () => ({ status: 503, json: undefined });
  const outage = await events.searchMyData("MUSIC", "abba");
  assert.equal(outage.state, "degraded", "a search that did not run is not an empty result");
  assert.deepEqual(outage.data.content, []);
});

test("the overview is Cosmos's count from the wearer's own midnight", async () => {
  answer = () => ({
    status: 200,
    json: {
      todayStart: "2026-09-22T22:00:00.000Z",
      domains: [
        { domain: "AI_MIC", today: 2, total: 3000 },
        { domain: "CALL", today: 0, total: 4 },
        { domain: "MUSIC", today: 1, total: 12 },
        { domain: "TRANSLATION", today: 0, total: 2 },
        { domain: "SOMETHING_NEW", today: 9, total: 9 },
      ],
    },
  });
  const result = await events.getMyDataOverview("2026-09-23T00:00:00+02:00");
  assert.equal(
    lastRequest().url,
    "/notable-events/mydata/overview?todayStart=2026-09-22T22%3A00%3A00.000Z",
  );
  assert.equal(result.state, "live");
  assert.equal(result.degraded, undefined, "a total past a thousand is a count, not a floor");
  assert.deepEqual(result.data, [
    { key: "AI_MIC", label: "Ai Mic", href: "/my-data/ai-mic", today: 2, total: 3000 },
    { key: "CALL", label: "Calls", href: "/my-data/calls", today: 0, total: 4 },
    { key: "MUSIC", label: "Music", href: "/my-data/music", today: 1, total: 12 },
    { key: "TRANSLATION", label: "Translation", href: "/my-data/translation", today: 0, total: 2 },
  ]);

  await events.getMyDataOverview("not a date");
  assert.equal(lastRequest().url, "/notable-events/mydata/overview", "an unreadable midnight is not forwarded");
});

test("no My Data read opens a gRPC connection", () => {
  assert.equal(grpcConnections, 0);
});
