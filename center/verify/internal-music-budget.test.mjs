import assert from "node:assert/strict";
import test from "node:test";
import { internalMusicQuery } from "../src/app/api/internal/music/query/routeSupport.ts";

// Failure modes at the HTTP/provider boundary: Spotify ignores Cosmos's budget;
// a slow request body outlives that budget. An undeclared oversized stream is
// buffered completely. Cancellation never reaches the adapter. Unrecorded data.
const token = "synthetic-internal-music-token-000000000";
function setup(t) {
  const previous = process.env.COSMOS_ADMIN_TOKEN;
  process.env.COSMOS_ADMIN_TOKEN = token;
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => {
    clearTimeout(keepAlive);
    if (previous === undefined) delete process.env.COSMOS_ADMIN_TOKEN;
    else process.env.COSMOS_ADMIN_TOKEN = previous;
  });
}
function request(body, signal) {
  return new Request("http://center.test/api/internal/music/query", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body, signal, duplex: "half",
  });
}
const query = JSON.stringify({ principal: "U:wearer", provider: "spotify", query: "Fixture artist song" });
const forbiddenGateway = async () => { throw new Error("wrong provider lane"); };
function promptResult(operation) {
  return Promise.race([operation, new Promise((resolve) => setTimeout(() => resolve(null), 300))]);
}

test("internal Spotify lookup returns 504 and aborts its adapter at the Cosmos budget", async (t) => {
  setup(t);
  let observedSignal;
  const response = await promptResult(internalMusicQuery(request(query), {
    spotifySearch: async (_session, _query, signal) => {
      observedSignal = signal;
      return new Promise(() => {});
    }, gatewayQuery: forbiddenGateway,
  }, 40));
  assert.ok(response, "Spotify lookup outlived the route budget");
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "Spotify took too long." });
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
});

test("internal music cancels a request body that stalls before provider lookup", async (t) => {
  setup(t);
  let cancelled = false;
  let controller;
  t.after(() => { try { controller.close(); } catch {} });
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  });
  const response = await promptResult(internalMusicQuery(request(body), {
    spotifySearch: async () => { throw new Error("provider must not be called"); }, gatewayQuery: forbiddenGateway,
  }, 40));
  assert.ok(response, "request body outlived the route budget");
  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
});

test("internal music stops undeclared oversized request streams at 4 KiB", async (t) => {
  setup(t);
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      if (pulls <= 2) controller.enqueue(new Uint8Array(pulls === 1 ? 4096 : 1));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await internalMusicQuery(request(body), {
    spotifySearch: async () => { throw new Error("provider must not be called"); }, gatewayQuery: forbiddenGateway,
  }, 500);
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
});

test("internal Spotify success retains projection and passes one shared budget", async (t) => {
  setup(t);
  const response = await internalMusicQuery(request(query), {
    spotifySearch: async (session, value, signal) => {
      assert.equal(session.sub, "wearer");
      assert.equal(value, "Fixture artist song");
      assert.ok(signal instanceof AbortSignal);
      return { items: [{ id: "spotify:track:fixture", title: "Fixture song", artists: ["Fixture artist"], private: "omit" }] };
    }, gatewayQuery: forbiddenGateway,
  }, 500);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { provider: "spotify", ranking_provenance: "not_ranked",
    items: [{ id: "spotify:track:fixture", title: "Fixture song", artists: ["Fixture artist"] }] });
});
