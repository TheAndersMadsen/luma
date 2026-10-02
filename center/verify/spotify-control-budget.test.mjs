import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSpotifyBridgeAction } from "../src/server/spotifyBridge.ts";

// Failure modes: an ownership read consumes a separate deadline. A status
// body stalls after headers. A 204 follow-up resets the control deadline.
// Exercise the real HTTP control, roster and adapter boundaries together.
const deviceId = "a".repeat(32);
const session = { sub: "budget-wearer", email: "", name: "", operator: false };
const status = {
  active_provider: "spotify", enabled: true, experimental_acknowledged: true,
  state: "ready", device_name: "Ai Pin", engine_ready: true,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, adapter, ownershipDelay = 0) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luma-control-budget-"));
  const tokenFile = path.join(directory, "bridge-token");
  await writeFile(tokenFile, "b".repeat(40), { mode: 0o600 });
  const server = createServer(async (request, response) => {
    const json = (body) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    if (request.url === "/__control/status") {
      await delay(ownershipDelay);
      json({ schema_version: 1, local_endpoint_id: "b".repeat(64), configured: true,
        device_id: deviceId, remote_endpoint_id: "c".repeat(64), connected: true,
        generation: 1, protocol: "penumbra-remote-center-v1" });
    } else if (request.url === "/demo-api/admin/devices") {
      json({ pairings: [{ account_sub: session.sub, device_id: deviceId }] });
    } else {
      await adapter(request, response, json);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const environment = {
    LUMA_PIN_BRIDGE_URL: origin, LUMA_PIN_BRIDGE_TOKEN_FILE: tokenFile,
    COSMOS_WEBAPI_BASE_URL: origin, COSMOS_ADMIN_TOKEN: "c".repeat(40),
    LUMA_SPOTIFY_ADAPTER_URL: origin, LUMA_SPOTIFY_ADAPTER_TOKEN: "s".repeat(40),
    LUMA_SPOTIFY_ADAPTER_TOKEN_FILE: undefined, LUMA_SPOTIFY_ADAPTER_TIMEOUT_MS: "500",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
}

async function outcomeBefore(operation, ms = 850) {
  return Promise.race([
    operation.then(() => "success", () => "rejected"),
    delay(ms).then(() => "still running"),
  ]);
}

test("control timeout cancels a real status body stalled after HTTP headers", async (t) => {
  let closed = false;
  await fixture(t, async (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.write('{"active_provider":');
    response.on("close", () => { closed = true; });
  });
  assert.equal(await outcomeBefore(runSpotifyBridgeAction(session, "status")), "rejected");
  await delay(30);
  assert.equal(closed, true);
});

test("ownership confirmation shares the Spotify control deadline", async (t) => {
  await fixture(t, async (_request, _response, json) => {
    await delay(300);
    json(status);
  }, 300);
  assert.equal(await outcomeBefore(runSpotifyBridgeAction(session, "status")), "rejected");
});

test("204 control follow-up does not restart the Spotify deadline", async (t) => {
  await fixture(t, async (request, response, json) => {
    await delay(300);
    if (request.url === "/api/spotify/pairing/start") {
      response.writeHead(204).end();
    } else json(status);
  });
  assert.equal(await outcomeBefore(runSpotifyBridgeAction(session, "pair")), "rejected");
});

test("caller cancellation stops a control request before it reaches the Pin", async (t) => {
  let adapterCalls = 0;
  await fixture(t, async (_request, _response, json) => {
    adapterCalls++;
    json(status);
  }, 300);
  const controller = new AbortController();
  const pending = runSpotifyBridgeAction(session, "pair", undefined, fetch, controller.signal);
  controller.abort();
  assert.equal(await outcomeBefore(pending), "rejected");
  assert.equal(adapterCalls, 0);
});
