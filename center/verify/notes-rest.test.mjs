// Notes over Cosmos's web plane, end to end through the BFF domain module,
// against a fake Cosmos webapi. The domain module imports extensionless
// TypeScript siblings.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import test, { after } from "node:test";

/*
 * Center holds no note key and seals nothing: every note read and write is one
 * REST call on Cosmos's `capture` surface, carrying the wearer's identity. The
 * gRPC endpoint below counts every connection, and it must stay at zero.
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

const notes = await import("../src/server/domain/notes.ts");
const { setLogSinkForTests } = await import("../src/server/log.ts");

setLogSinkForTests(() => {});

after(() => {
  setLogSinkForTests(null);
  webapi.close();
  grpc.close();
});

const UUID = "0f5c8a3e-6a8b-4f55-9b1d-2c4e5a6b7c8d";
const DTO = {
  uuid: UUID,
  createdAt: 1_725_000_000,
  modifiedAt: 1_725_000_100,
  hasLocation: false,
  sealed: false,
  title: "Weekend",
  text: "Buy Oat Milk",
};

function page(content, totalElements = content.length) {
  return {
    content,
    number: 0,
    size: 60,
    totalElements,
    totalPages: Math.ceil(totalElements / 60),
    last: true,
    first: true,
    numberOfElements: content.length,
    empty: content.length === 0,
  };
}

function lastRequest() {
  return requests.at(-1);
}

test("a page is asked of Cosmos with the wearer's search, and read back verbatim", async () => {
  answer = () => ({ status: 200, json: page([DTO], 340) });
  const result = await notes.getNotesPage({ page: 2, size: 60, query: "  Milk " });

  const request = lastRequest();
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/capture/notes?page=2&size=60&query=Milk");
  assert.equal(request.headers["x-forwarded-client-cert"], "U:wearer-1");
  assert.equal(request.headers["x-cosmos-edge-token"], "edge-proof");
  assert.equal(result.state, "live");
  assert.equal(result.data.totalElements, 340);
  assert.deepEqual(result.data.content, [DTO]);

  await notes.getNotesPage();
  assert.equal(lastRequest().url, "/capture/notes?page=0&size=200", "the stock page by default");
});

test("create posts the recovered {text, title} body and returns what Cosmos kept", async () => {
  answer = ({ body }) => ({ status: 200, json: { ...DTO, title: body.title, text: body.text } });
  const created = await notes.createNote({ text: "Buy Oat Milk", title: "Weekend" });
  assert.equal(lastRequest().method, "POST");
  assert.equal(lastRequest().url, "/capture/note/create");
  assert.deepEqual(lastRequest().body, { text: "Buy Oat Milk", title: "Weekend" });
  assert.equal(created.state, "live");
  assert.equal(created.data.text, "Buy Oat Milk", "the wearer's casing");

  // No text is the stock "New note.", which Cosmos applies.
  await notes.createNote({ title: null });
  assert.deepEqual(lastRequest().body, { title: null });

  answer = () => ({ status: 413, json: undefined });
  const tooLong = await notes.createNote({ text: "x" });
  assert.equal(tooLong.state, "degraded");
  assert.equal(tooLong.degraded, notes.NOTE_TOO_LONG);
  assert.equal(tooLong.data, null);
});

test("no gRPC connection was used for any of it", () => {
  assert.ok(requests.length >= 5, "the calls above reached the fake webapi");
  assert.equal(grpcConnections, 0, "a note operation dialled the gRPC plane");
});

test("the notes seam and routes carry no sealing and refuse cross-site writes", async () => {
  const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
  const [domain, create, edit, all, one] = await Promise.all([
    read("server/domain/notes.ts"),
    read("app/api/capture/note/create/route.ts"),
    read("app/api/capture/note/[uuid]/route.ts"),
    read("app/api/capture/notes/route.ts"),
    read("app/api/capture/notes/[uuid]/route.ts"),
  ]);
  assert.doesNotMatch(domain, /from "\.\.\/(?:channel|envelope)"/);
  assert.doesNotMatch(domain, /\bchannelKey\b|\bseal\(|\bServices\.|\bcall\(/);
  assert.match(edit, /export async function GET/);
  assert.match(edit, /export async function POST/);
  for (const route of [create, edit, all, one]) assert.match(route, /isSameOriginRequest\(request\)/);
});
